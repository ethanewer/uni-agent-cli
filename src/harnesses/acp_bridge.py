#!/usr/bin/env python3
import json
import sys
import threading
import traceback
import uuid


def require_python_version(name, minimum=(3, 10)):
    if sys.version_info >= minimum:
        return
    current = ".".join(str(part) for part in sys.version_info[:3])
    required = ".".join(str(part) for part in minimum)
    raise RuntimeError(
        f"{name} requires Python {required} or newer; current interpreter is Python {current}. "
        "Set CC_HARNESS_PYTHON to a newer Python executable."
    )


class AcpBridge:
    def __init__(self, name, title, version="0.1.0"):
        self.name = name
        self.title = title
        self.version = version
        self.session_id = f"{name}-{uuid.uuid4().hex}"
        self._send_lock = threading.Lock()
        self._cancel_current = None

    def run(self):
        for raw in sys.stdin:
            try:
                message = json.loads(raw)
                self.handle_message(message)
            except Exception as error:
                self.write_stderr(f"{type(error).__name__}: {error}")

    def handle_message(self, message):
        method = message.get("method")
        request_id = message.get("id")
        params = message.get("params") or {}

        if method == "initialize":
            self.reply(
                request_id,
                {
                    "protocolVersion": 1,
                    "agentCapabilities": {
                        "promptCapabilities": {"image": False},
                    },
                    "agentInfo": {
                        "name": self.name,
                        "title": self.title,
                        "version": self.version,
                    },
                    "authMethods": [],
                },
            )
            return

        if method == "session/new":
            self.session_id = params.get("sessionId") or f"{self.name}-{uuid.uuid4().hex}"
            self.reply(
                request_id,
                {
                    "sessionId": self.session_id,
                    "modes": {
                        "currentModeId": "agent",
                        "availableModes": [{"id": "agent", "name": "Agent"}],
                    },
                },
            )
            return

        if method == "session/prompt":
            self.start_prompt(request_id, params)
            return

        if method == "session/cancel":
            cancel = self._cancel_current
            if cancel:
                cancel()
            self.reply(request_id, {})
            return

        self.error(request_id, -32601, f"unsupported method: {method}")

    def start_prompt(self, request_id, params):
        if self._cancel_current:
            self.error(request_id, -32000, "a prompt is already running")
            return

        cancel, run = self.make_prompt_runner(params)
        self._cancel_current = cancel

        def worker():
            try:
                stop_reason = run()
                self.reply(request_id, {"stopReason": stop_reason or "end_turn"})
            except Exception as error:
                self.agent_text(traceback.format_exc())
                self.error(request_id, -32603, str(error))
            finally:
                self._cancel_current = None

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()

    def make_prompt_runner(self, params):
        raise NotImplementedError

    def prompt_text(self, params):
        chunks = []
        for part in params.get("prompt") or []:
            if part.get("type") == "text":
                chunks.append(part.get("text") or "")
            else:
                chunks.append(f"[{part.get('type') or 'part'}]")
        return "".join(chunks)

    def agent_text(self, text):
        if not text:
            return
        self.session_update(
            {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": text},
            }
        )

    def tool_call(self, tool_call_id, title, status="running"):
        self.session_update(
            {
                "sessionUpdate": "tool_call",
                "toolCallId": tool_call_id,
                "title": title,
                "status": status,
            }
        )

    def tool_update(self, tool_call_id, status, title=None):
        update = {
            "sessionUpdate": "tool_call_update",
            "toolCallId": tool_call_id,
            "status": status,
        }
        if title:
            update["title"] = title
        self.session_update(update)

    def session_update(self, update):
        self.send(
            {
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {"sessionId": self.session_id, "update": update},
            }
        )

    def reply(self, request_id, result):
        self.send({"jsonrpc": "2.0", "id": request_id, "result": result})

    def error(self, request_id, code, message):
        self.send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": code, "message": message},
            }
        )

    def send(self, message):
        with self._send_lock:
            sys.stdout.write(json.dumps(message) + "\n")
            sys.stdout.flush()

    def write_stderr(self, text):
        sys.stderr.write(text.rstrip() + "\n")
        sys.stderr.flush()
