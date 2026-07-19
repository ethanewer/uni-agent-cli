#!/usr/bin/env python3
import argparse
import multiprocessing
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent / "vendor"))

from acp_bridge import AcpBridge, require_python_version


class LocalTmuxSession:
    def __init__(self, cwd, name=None, pinned_cwd=False):
        if shutil.which("tmux") is None:
            raise RuntimeError("terminus-2 requires tmux on PATH")
        self.name = name or f"cc-terminus-2-{uuid.uuid4().hex}"
        self.socket_name = self.name
        self.cwd = cwd
        self.started_at = time.monotonic()
        self._last_output = ""
        # Keep the private server as an owned foreground child. A normal detached
        # tmux server reparents immediately and can escape process-group teardown
        # between supervisor samples. `-D` keeps the empty server attached while
        # a normal client command creates the initial detached session.
        self.server = subprocess.Popen(
            ["tmux", "-D", "-L", self.socket_name, "-f", "/dev/null"],
            # For workflow children cwd is `.` relative to the OS-held directory
            # inherited through the supervisor. A private tmux server starts from
            # that same reference, so neither it nor its shell reopens the approved
            # absolute pathname after validation.
            cwd="." if pinned_cwd else None,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        time.sleep(0.1)
        if self.server.poll() is not None:
            detail = self.server.stderr.read().strip() if self.server.stderr else ""
            raise RuntimeError(f"terminus-2 tmux server failed to start: {detail}")
        try:
            subprocess.run(
                ["tmux", "-L", self.socket_name, "new-session", "-d", "-s", self.name, "-c", cwd, "bash"],
                check=True,
                cwd="." if pinned_cwd else None,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
            )
        except Exception:
            self.server.terminate()
            self.server.wait(timeout=2)
            raise
        self._last_output = self.capture_pane(capture_entire=True)

    def capture_pane(self, capture_entire=False):
        command = ["tmux", "-L", self.socket_name, "capture-pane", "-pt", self.name]
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
            subprocess.run(["tmux", "-L", self.socket_name, "send-keys", "-t", self.name, keystrokes], check=True)
        else:
            self._send_literal_keystrokes(keystrokes)
        time.sleep(max(0, min(float(min_timeout_sec), 60)))

    def _send_literal_keystrokes(self, keystrokes):
        parts = keystrokes.split("\n")
        for index, part in enumerate(parts):
            if part:
                subprocess.run(["tmux", "-L", self.socket_name, "send-keys", "-t", self.name, "-l", part], check=True)
            if index < len(parts) - 1:
                subprocess.run(["tmux", "-L", self.socket_name, "send-keys", "-t", self.name, "Enter"], check=True)

    def is_session_alive(self):
        result = subprocess.run(
            ["tmux", "-L", self.socket_name, "has-session", "-t", self.name],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return result.returncode == 0

    def get_asciinema_timestamp(self):
        return time.monotonic() - self.started_at

    def stop(self):
        try:
            kill_tmux_session(self.name, self.socket_name)
        finally:
            if self.server.poll() is None:
                self.server.terminate()
                try:
                    self.server.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.server.kill()
                    self.server.wait(timeout=2)


def kill_tmux_session(name, socket_name=None):
    subprocess.run(
        ["tmux", "-L", socket_name or name, "kill-server"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def run_terminus_worker(args, instruction, cwd, session_name, result_queue, pinned_cwd=False):
    session = None
    try:
        session = LocalTmuxSession(cwd, name=session_name, pinned_cwd=pinned_cwd)
        result_queue.put({"type": "session", "name": session.name})

        from terminal_bench.agents.terminus_2.terminus_2 import Terminus2

        agent = Terminus2(
            model_name=args["model"],
            max_episodes=args["max_episodes"],
            parser_name=args["parser"],
            api_base=args["api_base"],
            temperature=args["temperature"],
        )
        result = agent.perform_task(
            instruction=instruction,
            session=session,
            logging_dir=Path(args["logging_dir"]) if args["logging_dir"] else None,
            time_limit_seconds=args["time_limit_seconds"],
        )
        terminal_output = session.capture_pane(capture_entire=True).strip()
        result_queue.put(
            {
                "type": "result",
                "input_tokens": result.total_input_tokens,
                "output_tokens": result.total_output_tokens,
                "terminal_output": terminal_output,
            }
        )
    except Exception as error:
        result_queue.put(
            {
                "type": "error",
                "message": str(error),
                "traceback": traceback.format_exc(),
            }
        )
    finally:
        if session:
            session.stop()


class Terminus2Bridge(AcpBridge):
    def __init__(self, args):
        super().__init__("terminus-2", "Terminus-2")
        self.args = args

    def make_prompt_runner(self, params):
        cancelled = threading.Event()
        process = None
        tmux_session_name = None

        def cancel():
            cancelled.set()
            if process and process.is_alive():
                process.terminate()
            if tmux_session_name:
                kill_tmux_session(tmux_session_name)

        def run():
            nonlocal process, tmux_session_name
            instruction = self.prompt_text(params).strip()
            if not instruction:
                self.agent_text("No task instruction was provided.")
                return "end_turn"
            require_python_version("terminus-2 bridge")

            cwd = self.session_cwd if self.workflow_child else (params.get("cwd") or os.getcwd())
            self.tool_call("terminus-2", f"Terminus-2: {self.args.model}")

            result_queue = multiprocessing.Queue()
            tmux_session_name = f"cc-terminus-2-{uuid.uuid4().hex}"
            process = multiprocessing.Process(
                target=run_terminus_worker,
                args=(terminus_args_dict(self.args), instruction, cwd, tmux_session_name, result_queue, self.workflow_child),
                daemon=True,
            )
            process.start()
            deadline = time.monotonic() + self.args.time_limit_seconds if self.args.time_limit_seconds else None

            while True:
                if cancelled.is_set():
                    self.stop_worker(process, tmux_session_name)
                    self.tool_update("terminus-2", "cancelled")
                    return "cancelled"
                if deadline is not None and time.monotonic() >= deadline:
                    self.stop_worker(process, tmux_session_name)
                    self.tool_update("terminus-2", "failed")
                    raise TimeoutError(f"terminus-2 timed out after {self.args.time_limit_seconds}s")
                try:
                    message = result_queue.get(timeout=0.1)
                except queue.Empty:
                    if not process.is_alive():
                        code = process.exitcode
                        self.stop_worker(process, tmux_session_name)
                        self.tool_update("terminus-2", "failed")
                        raise RuntimeError(f"terminus-2 worker exited with status {code}")
                    continue

                message_type = message.get("type")
                if message_type == "session":
                    tmux_session_name = message.get("name")
                    continue
                if message_type == "result":
                    process.join(timeout=1)
                    if process.is_alive():
                        self.stop_worker(process, tmux_session_name)
                    if cancelled.is_set():
                        self.tool_update("terminus-2", "cancelled")
                        return "cancelled"
                    self.tool_update("terminus-2", "completed")
                    if self.workflow_child:
                        self.usage_update(message.get("input_tokens"), message.get("output_tokens"))
                    self.agent_text(
                        "Terminus-2 finished.\n"
                        f"Input tokens: {message.get('input_tokens')}\n"
                        f"Output tokens: {message.get('output_tokens')}\n"
                    )
                    terminal_output = message.get("terminal_output") or ""
                    if terminal_output:
                        self.agent_text(f"\nRecent terminal output:\n{limit_output(terminal_output)}\n")
                    return "end_turn"
                if message_type == "error":
                    self.stop_worker(process, tmux_session_name)
                    self.tool_update("terminus-2", "failed")
                    raise RuntimeError(message.get("message") or message.get("traceback") or "terminus-2 failed")

        return cancel, run

    def stop_worker(self, process, tmux_session_name):
        if process:
            if process.is_alive():
                process.terminate()
            process.join(timeout=2)
            if process.is_alive():
                process.kill()
                process.join(timeout=2)
        if tmux_session_name:
            kill_tmux_session(tmux_session_name)


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


def terminus_args_dict(args):
    return {
        "model": args.model,
        "parser": args.parser,
        "api_base": args.api_base,
        "temperature": args.temperature,
        "max_episodes": args.max_episodes,
        "logging_dir": args.logging_dir,
        "time_limit_seconds": args.time_limit_seconds,
    }


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
