#!/usr/bin/env python3
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODEL = os.environ.get("CC_E2E_MODEL", "openai/gpt-5.4-mini")
PYTHON = os.environ.get("CC_E2E_PYTHON", str(ROOT / ".venv" / "bin" / "python"))


def send(process, message):
    process.stdin.write(json.dumps(message) + "\n")
    process.stdin.flush()


class NonBlockingLineReader:
    def __init__(self, stream):
        self._lines = queue.Queue()
        self._thread = threading.Thread(target=self._read_lines, args=(stream,), daemon=True)
        self._thread.start()

    def _read_lines(self, stream):
        try:
            for line in iter(stream.readline, ""):
                self._lines.put(line)
        finally:
            self._lines.put(None)

    def readline(self, timeout):
        return self._lines.get(timeout=timeout)


def read_until(process, stdout, request_id, timeout_sec):
    deadline = time.monotonic() + timeout_sec
    messages = []
    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        try:
            line = stdout.readline(timeout=min(0.05, max(0, remaining)))
        except queue.Empty:
            if process.poll() is not None:
                raise RuntimeError(f"bridge exited early with {process.returncode}: {process.stderr.read()}")
            continue
        if line is None:
            if process.poll() is None:
                raise RuntimeError("bridge stdout closed before response")
            raise RuntimeError(f"bridge exited early with {process.returncode}: {process.stderr.read()}")
        message = json.loads(line)
        messages.append(message)
        if message.get("id") == request_id:
            return message, messages
    raise TimeoutError(f"timed out waiting for response id {request_id}")


def run_bridge(bridge, prompt, cwd, args=None, timeout_sec=180):
    args = args or []
    process = subprocess.Popen(
        [PYTHON, str(ROOT / bridge), *args],
        cwd=str(ROOT),
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    stdout = NonBlockingLineReader(process.stdout)
    try:
        send(process, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
        initialized, _ = read_until(process, stdout, 1, 30)
        assert "error" not in initialized, initialized

        send(process, {"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": {"cwd": str(cwd)}})
        created, _ = read_until(process, stdout, 2, 30)
        assert "error" not in created, created

        send(
            process,
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "session/prompt",
                "params": {
                    "sessionId": created["result"]["sessionId"],
                    "cwd": str(cwd),
                    "prompt": [{"type": "text", "text": prompt}],
                },
            },
        )
        prompted, messages = read_until(process, stdout, 3, timeout_sec)
        assert "error" not in prompted, prompted
        return messages
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()


def main():
    if "OPENAI_API_KEY" not in os.environ:
        raise RuntimeError("OPENAI_API_KEY must be set")
    if not Path(PYTHON).exists():
        raise RuntimeError(f"Python executable not found: {PYTHON}")
    if shutil.which("tmux") is None:
        raise RuntimeError("tmux is required for the Terminus-2 E2E test")

    with tempfile.TemporaryDirectory(prefix="cc-e2e-mini-") as tmp:
        cwd = Path(tmp)
        run_bridge(
            "src/harnesses/mini_swe_agent/bridge.py",
            "Create a file named result.txt in the current directory containing exactly PASS, then finish.",
            cwd,
            ["--model", MODEL, "--output", str(cwd / "trajectory.json")],
            timeout_sec=240,
        )
        assert (cwd / "result.txt").read_text().strip() == "PASS"
        print("mini-swe-agent e2e passed")

    with tempfile.TemporaryDirectory(prefix="cc-e2e-terminus-") as tmp:
        cwd = Path(tmp)
        run_bridge(
            "src/harnesses/terminus_2/bridge.py",
            "Create a file named result.txt in the current directory containing exactly PASS. Verify it, then mark the task complete.",
            cwd,
            ["--model", MODEL, "--max-episodes", "2", "--temperature", "0"],
            timeout_sec=240,
        )
        assert (cwd / "result.txt").read_text().strip() == "PASS"
        print("terminus-2 e2e passed")


if __name__ == "__main__":
    main()
