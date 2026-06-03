#!/usr/bin/env python3
import argparse
import concurrent.futures
import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent / "vendor"))

from acp_bridge import AcpBridge


class LocalTmuxSession:
    def __init__(self, cwd):
        if shutil.which("tmux") is None:
            raise RuntimeError("terminus-2 requires tmux on PATH")
        self.name = f"cc-terminus-2-{uuid.uuid4().hex}"
        self.cwd = cwd
        self.started_at = time.monotonic()
        self._last_output = ""
        subprocess.run(
            ["tmux", "new-session", "-d", "-s", self.name, "-c", cwd, "bash"],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        time.sleep(0.1)
        self._last_output = self.capture_pane(capture_entire=True)

    def capture_pane(self, capture_entire=False):
        command = ["tmux", "capture-pane", "-pt", self.name]
        if capture_entire:
            command.extend(["-S", "-"])
        result = subprocess.run(command, check=True, capture_output=True, text=True)
        return result.stdout

    def get_incremental_output(self):
        current = self.capture_pane(capture_entire=True)
        if current.startswith(self._last_output):
            output = current[len(self._last_output) :]
        else:
            output = current
        self._last_output = current
        return output

    def send_keys(self, keystrokes, block=False, min_timeout_sec=1.0):
        if keystrokes in {"C-c", "C-d"}:
            subprocess.run(["tmux", "send-keys", "-t", self.name, keystrokes], check=True)
        else:
            self._send_literal_keystrokes(keystrokes)
        time.sleep(max(0, min(float(min_timeout_sec), 60)))

    def _send_literal_keystrokes(self, keystrokes):
        parts = keystrokes.split("\n")
        for index, part in enumerate(parts):
            if part:
                subprocess.run(["tmux", "send-keys", "-t", self.name, "-l", part], check=True)
            if index < len(parts) - 1:
                subprocess.run(["tmux", "send-keys", "-t", self.name, "Enter"], check=True)

    def is_session_alive(self):
        result = subprocess.run(
            ["tmux", "has-session", "-t", self.name],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return result.returncode == 0

    def get_asciinema_timestamp(self):
        return time.monotonic() - self.started_at

    def stop(self):
        subprocess.run(
            ["tmux", "kill-session", "-t", self.name],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


class Terminus2Bridge(AcpBridge):
    def __init__(self, args):
        super().__init__("terminus-2", "Terminus-2")
        self.args = args

    def make_prompt_runner(self, params):
        cancelled = False
        session = None

        def cancel():
            nonlocal cancelled
            cancelled = True
            if session:
                session.stop()

        def run():
            nonlocal session
            instruction = self.prompt_text(params).strip()
            if not instruction:
                self.agent_text("No task instruction was provided.")
                return "end_turn"

            cwd = params.get("cwd") or os.getcwd()
            session = LocalTmuxSession(cwd)
            self.tool_call("terminus-2", f"Terminus-2: {self.args.model}")
            try:
                from terminal_bench.agents.terminus_2.terminus_2 import Terminus2

                agent = Terminus2(
                    model_name=self.args.model,
                    max_episodes=self.args.max_episodes,
                    parser_name=self.args.parser,
                    api_base=self.args.api_base,
                    temperature=self.args.temperature,
                )
                try:
                    result = self.perform_task_with_time_limit(
                        agent=agent,
                        instruction=instruction,
                        session=session,
                        logging_dir=Path(self.args.logging_dir) if self.args.logging_dir else None,
                    )
                except Exception:
                    if cancelled:
                        self.tool_update("terminus-2", "cancelled")
                        return "cancelled"
                    raise
                if cancelled:
                    self.tool_update("terminus-2", "cancelled")
                    return "cancelled"
                self.tool_update("terminus-2", "completed")
                terminal_output = session.capture_pane(capture_entire=True).strip()
                self.agent_text(
                    "Terminus-2 finished.\n"
                    f"Input tokens: {result.total_input_tokens}\n"
                    f"Output tokens: {result.total_output_tokens}\n"
                )
                if terminal_output:
                    self.agent_text(f"\nRecent terminal output:\n{limit_output(terminal_output)}\n")
                return "end_turn"
            finally:
                session.stop()

        return cancel, run

    def perform_task_with_time_limit(self, agent, instruction, session, logging_dir):
        def perform_task():
            return agent.perform_task(
                instruction=instruction,
                session=session,
                logging_dir=logging_dir,
                time_limit_seconds=self.args.time_limit_seconds,
            )

        if not self.args.time_limit_seconds:
            return perform_task()

        executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        future = executor.submit(perform_task)
        try:
            return future.result(timeout=self.args.time_limit_seconds)
        except concurrent.futures.TimeoutError as error:
            session.stop()
            self.tool_update("terminus-2", "failed")
            raise TimeoutError(f"terminus-2 timed out after {self.args.time_limit_seconds}s") from error
        finally:
            executor.shutdown(wait=False, cancel_futures=True)


def parse_args():
    parser = argparse.ArgumentParser(description="ACP bridge for Terminus-2")
    parser.add_argument("--model", default=os.environ.get("TERMINUS_2_MODEL", "openai/gpt-5.4-mini"))
    parser.add_argument("--parser", choices=["json", "xml"], default=os.environ.get("TERMINUS_2_PARSER", "json"))
    parser.add_argument("--api-base", default=os.environ.get("TERMINUS_2_API_BASE"))
    parser.add_argument("--temperature", type=float, default=float(os.environ.get("TERMINUS_2_TEMPERATURE", "0.7")))
    parser.add_argument("--max-episodes", type=int, default=env_int("TERMINUS_2_MAX_EPISODES"))
    parser.add_argument("--logging-dir", default=os.environ.get("TERMINUS_2_LOGGING_DIR"))
    parser.add_argument("--time-limit-seconds", type=float, default=None)
    return parser.parse_args()


def env_int(name):
    value = os.environ.get(name)
    return int(value) if value else None


def limit_output(value, max_chars=4_000):
    if len(value) <= max_chars:
        return value
    half = max_chars // 2
    return value[:half] + "\n[... output truncated ...]\n" + value[-half:]


if __name__ == "__main__":
    Terminus2Bridge(parse_args()).run()
