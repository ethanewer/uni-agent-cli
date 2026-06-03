#!/usr/bin/env python3
import argparse
import asyncio
import contextlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent / "vendor"))

from acp_bridge import AcpBridge, require_python_version


class MiniSweAgentBridge(AcpBridge):
    def __init__(self, args):
        super().__init__("mini-swe-agent", "mini-swe-agent")
        self.args = args
        self.process = None
        self.local_environment = None

    def make_prompt_runner(self, params):
        cancelled = threading.Event()

        def cancel():
            cancelled.set()
            if self.process and self.process.poll() is None:
                self.process.terminate()
            if self.local_environment:
                self.local_environment.cancel()

        def run():
            prompt = self.prompt_text(params).strip()
            if not prompt:
                self.agent_text("No task instruction was provided.")
                return "end_turn"

            cwd = params.get("cwd") or os.getcwd()
            command = self.command_for_prompt(prompt)
            self.tool_call("mini-swe-agent", "mini-swe-agent")
            if command is None:
                self.agent_text("Running Pier MiniSweAgent locally\n")
                try:
                    self.run_pier_local_prompt(prompt, cwd, cancelled)
                except CancelledRun:
                    self.tool_update("mini-swe-agent", "cancelled")
                    return "cancelled"
                if cancelled.is_set():
                    self.tool_update("mini-swe-agent", "cancelled")
                    return "cancelled"
                self.tool_update("mini-swe-agent", "completed")
                return "end_turn"

            self.agent_text(f"Running: {' '.join(command)}\n")

            self.process = subprocess.Popen(
                command,
                cwd=cwd,
                env=self.command_env(),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            assert self.process.stdout is not None
            for line in self.process.stdout:
                self.agent_text(line)
            code = self.process.wait()
            self.process = None

            if cancelled.is_set():
                self.tool_update("mini-swe-agent", "cancelled")
                return "cancelled"
            if code == 0:
                self.tool_update("mini-swe-agent", "completed")
                return "end_turn"
            self.tool_update("mini-swe-agent", "failed")
            raise RuntimeError(f"mini-swe-agent exited with status {code}")

        return cancel, run

    def command_for_prompt(self, prompt):
        if self.args.task_path:
            command = [
                self.args.pier_command,
                "run",
                "-p",
                self.args.task_path,
                "--agent",
                "mini-swe-agent",
            ]
            if self.args.model:
                command.extend(["--model", self.args.model])
            command.extend(self.args.pier_args)
            return command

        return None

    def command_env(self):
        env = os.environ.copy()
        env.setdefault("MSWEA_CONFIGURED", "1")
        return env

    def run_pier_local_prompt(self, prompt, cwd, cancelled):
        require_python_version("mini-swe-agent free-form bridge")
        from pier.agents.installed.mini_swe_agent import MiniSweAgent
        from pier.models.agent.context import AgentContext

        with tempfile.TemporaryDirectory(prefix="cc-mini-swe-agent-") as tmp:
            logs_dir = Path(self.args.output).parent if self.args.output else Path(tmp) / "logs"
            logs_dir.mkdir(parents=True, exist_ok=True)
            environment = LocalPierEnvironment(
                cwd=cwd,
                logs_dir=logs_dir,
                mini_command=self.args.mini_command,
                yolo=self.args.yolo,
                exit_immediately=self.args.exit_immediately,
                mini_args=self.args.mini_args,
                cancel_event=cancelled,
            )
            self.local_environment = environment
            agent_kwargs = parse_agent_kwargs(self.args.agent_kwargs)
            agent = MiniSweAgent(
                logs_dir=logs_dir,
                model_name=self.args.model,
                config_file=self.args.config,
                extra_env=self.command_env(),
                **agent_kwargs,
            )
            try:
                context = AgentContext()
                asyncio.run(agent.run(prompt, environment, context))
                run_log = self.emit_run_log(logs_dir)
                agent.populate_context_post_run(context)
                if self.args.output:
                    trajectory = logs_dir / "mini-swe-agent.trajectory.json"
                    if trajectory.exists():
                        shutil.copyfile(trajectory, self.args.output)
                if not context.is_empty():
                    self.agent_text(f"mini-swe-agent metrics: {context.model_dump(exclude_none=True)}\n")
                recent_output = extract_recent_command_output(run_log)
                if recent_output:
                    self.agent_text(f"\nRecent command output:\n{recent_output}\n")
            finally:
                self.local_environment = None

    def emit_run_log(self, logs_dir):
        log_path = Path(logs_dir) / "mini-swe-agent.txt"
        if not log_path.exists():
            return ""
        text = log_path.read_text(errors="replace")
        emitted = text
        if len(emitted) > 20_000:
            emitted = emitted[:10_000] + "\n[... mini-swe-agent log truncated ...]\n" + emitted[-10_000:]
        self.agent_text(emitted)
        return text


class CancelledRun(RuntimeError):
    pass


class LocalPierEnvironment:
    def __init__(
        self,
        cwd,
        logs_dir,
        mini_command="mini-swe-agent",
        yolo=True,
        exit_immediately=True,
        mini_args=None,
        cancel_event=None,
    ):
        self.cwd = Path(cwd)
        self.logs_dir = Path(logs_dir)
        self.agent_dir = self.logs_dir
        self.default_user = None
        self.mini_command = mini_command
        self.yolo = yolo
        self.exit_immediately = exit_immediately
        self.mini_args = mini_args or []
        self.cancel_event = cancel_event or threading.Event()
        self.current_process = None

    def agent_process_env(self, env):
        return env

    def cancel(self):
        process = self.current_process
        if process and process.returncode is None:
            process.terminate()

    async def exec(self, command, cwd=None, env=None, timeout_sec=None, user=None):
        if self.cancel_event.is_set():
            raise CancelledRun("mini-swe-agent run cancelled")
        run_cwd = Path(cwd) if cwd else self.cwd
        effective_env = os.environ.copy()
        if env:
            effective_env.update({key: str(value) for key, value in env.items()})
        effective_env["PATH"] = f"{Path(sys.executable).parent}:{effective_env.get('PATH', '')}"
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        command = self.rewrite_environment_paths(command)
        process = await asyncio.create_subprocess_shell(
            command,
            cwd=str(run_cwd),
            env=effective_env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self.current_process = process
        try:
            stdout, stderr = await self.communicate_until_done(process, timeout_sec)
        finally:
            if self.current_process is process:
                self.current_process = None
        if self.cancel_event.is_set():
            raise CancelledRun("mini-swe-agent run cancelled")
        return ExecResult(stdout.decode(), stderr.decode(), process.returncode)

    async def communicate_until_done(self, process, timeout_sec):
        task = asyncio.create_task(process.communicate())
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_sec if timeout_sec else None
        try:
            while True:
                if self.cancel_event.is_set():
                    await self.terminate_process(process)
                    task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await task
                    raise CancelledRun("mini-swe-agent run cancelled")
                wait_time = 0.1
                if deadline is not None:
                    remaining = deadline - loop.time()
                    if remaining <= 0:
                        await self.terminate_process(process)
                        task.cancel()
                        with contextlib.suppress(asyncio.CancelledError):
                            await task
                        raise TimeoutError(f"command timed out after {timeout_sec}s")
                    wait_time = min(wait_time, remaining)
                done, _ = await asyncio.wait({task}, timeout=wait_time)
                if done:
                    result = task.result()
                    if self.cancel_event.is_set():
                        raise CancelledRun("mini-swe-agent run cancelled")
                    return result
        finally:
            if not task.done():
                task.cancel()

    async def terminate_process(self, process):
        if process.returncode is not None:
            return
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=2)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()

    def rewrite_environment_paths(self, command):
        command = command.replace("/logs/agent", sh_quote(str(self.agent_dir)))
        command = command.replace('. "$HOME/.local/bin/env"; ', "")
        command = command.replace("mini-swe-agent ", f"{sh_quote(self.mini_command)} ", 1)
        if not self.yolo:
            command = command.replace("--yolo ", "", 1)
        if not self.exit_immediately:
            command = command.replace("--exit-immediately ", "", 1)
        if self.mini_args:
            command = command.replace(
                " 2>&1 </dev/null | tee ",
                f" {format_cli_args(self.mini_args)} 2>&1 </dev/null | tee ",
                1,
            )
        return command


class ExecResult:
    def __init__(self, stdout, stderr, return_code):
        self.stdout = stdout
        self.stderr = stderr
        self.return_code = return_code


def parse_args():
    parser = argparse.ArgumentParser(description="ACP bridge for mini-swe-agent")
    parser.add_argument("--mini-command", default=os.environ.get("MINI_SWE_AGENT_COMMAND", sibling_command("mini-swe-agent")))
    parser.add_argument("--pier-command", default=os.environ.get("PIER_COMMAND", sibling_command("pier")))
    parser.add_argument("--task-path", default=os.environ.get("MINI_SWE_AGENT_TASK_PATH"))
    parser.add_argument(
        "--model",
        default=os.environ.get("MINI_SWE_AGENT_MODEL") or os.environ.get("MSWEA_MODEL_NAME") or "openai/gpt-5.4-mini",
    )
    parser.add_argument("--config", default=os.environ.get("MINI_SWE_AGENT_CONFIG"))
    parser.add_argument("--output", default=os.environ.get("MINI_SWE_AGENT_OUTPUT"))
    parser.add_argument("--no-yolo", dest="yolo", action="store_false")
    parser.set_defaults(yolo=os.environ.get("MINI_SWE_AGENT_YOLO", "1") != "0")
    parser.add_argument("--no-exit-immediately", dest="exit_immediately", action="store_false")
    parser.set_defaults(exit_immediately=os.environ.get("MINI_SWE_AGENT_EXIT_IMMEDIATELY", "1") != "0")
    parser.add_argument("--mini-arg", dest="mini_args", action="append", default=[])
    parser.add_argument("--pier-arg", dest="pier_args", action="append", default=[])
    parser.add_argument("--agent-kwarg", dest="agent_kwargs", action="append", default=[])
    return parser.parse_args()


def sibling_command(name):
    for parent in [Path(sys.executable).parent, Path(sys.executable).resolve().parent]:
        candidate = parent / name
        if candidate.exists():
            return str(candidate)
    return name


def parse_agent_kwargs(entries):
    kwargs = {}
    for entry in entries:
        if "=" not in entry:
            raise ValueError(f"agent kwarg must be key=value: {entry}")
        key, value = entry.split("=", 1)
        kwargs[key] = value
    return kwargs


def extract_recent_command_output(log_text):
    outputs = []
    for match in re.finditer(r"<output>\n(?P<output>.*?)(?=\n(?:Function_call_output:|────────────────|Unknown:|User:|Exit:|Saved trajectory|$))", log_text, re.DOTALL):
        output = match.group("output").strip()
        if output and "action was not executed" not in output and "<exception_info>" not in output:
            outputs.append(output)
    if not outputs:
        return ""
    output = outputs[-1]
    if len(output) > 4_000:
        output = output[:2_000] + "\n[... output truncated ...]\n" + output[-2_000:]
    return output


def sh_quote(value):
    import shlex

    return shlex.quote(value)


def format_cli_args(values):
    return " ".join(sh_quote(value) for value in values)


if __name__ == "__main__":
    MiniSweAgentBridge(parse_args()).run()
