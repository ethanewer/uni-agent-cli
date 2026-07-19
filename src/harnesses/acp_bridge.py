#!/usr/bin/env python3
import json
import os
import stat
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
        self.workflow_child = os.environ.get("CC_WORKFLOW_CHILD") == "1"
        self.session_cwd = None
        self.session_mcp_servers = []

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
            if self.workflow_child:
                requested_cwd = os.path.abspath(params.get("cwd") or os.getcwd())
                requested = os.lstat(requested_cwd)
                inherited = os.stat(".")
                if (
                    not stat.S_ISDIR(requested.st_mode)
                    or requested.st_dev != inherited.st_dev
                    or requested.st_ino != inherited.st_ino
                ):
                    raise RuntimeError("workflow session cwd does not match the supervisor-pinned directory")
                # Never reopen the caller-controlled absolute pathname after this
                # identity check. Workflow descendants inherit the supervisor's
                # kernel-held cwd reference and resolve `.` from that reference.
                self.session_cwd = "."
                self.session_mcp_servers = list(params.get("mcpServers") or [])
            result = {
                "sessionId": self.session_id,
                "modes": {
                    "currentModeId": "agent",
                    "availableModes": [{"id": "agent", "name": "Agent"}],
                },
            }
            if self.workflow_child:
                result["configOptions"] = self.config_options()
            self.reply(
                request_id,
                result,
            )
            return

        if method == "session/set_config_option" and self.workflow_child:
            if params.get("sessionId") != self.session_id:
                self.error(request_id, -32602, "unknown session")
                return
            try:
                self.set_config_option(params.get("configId"), params.get("value"))
            except (TypeError, ValueError) as error:
                self.error(request_id, -32602, str(error))
                return
            self.reply(request_id, {"configOptions": self.config_options()})
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

    def config_options(self):
        model = self.current_model()
        if not model:
            return []
        return [
            {
                "id": "model",
                "category": "model",
                "name": "Model",
                "type": "select",
                "currentValue": model,
                "options": [{"value": model, "name": model}],
            }
        ]

    def current_model(self):
        args = getattr(self, "args", None)
        return getattr(args, "model", None)

    def set_config_option(self, config_id, value):
        if config_id != "model":
            raise ValueError(f"unsupported config option: {config_id}")
        if not isinstance(value, str) or not value.strip():
            raise ValueError("model must be a non-empty string")
        requested = value.strip()
        args = getattr(self, "args", None)
        if args is None or not hasattr(args, "model"):
            raise ValueError("this harness has no configurable model")
        # These bridges cannot enumerate provider-specific model catalogs. Keep
        # their configured model verifiable, but fail closed on arbitrary IDs
        # rather than claiming an unvalidated model was applied before prompting.
        if requested != self.current_model():
            raise ValueError(f"unsupported model: {requested}")

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

    def usage_update(self, input_tokens=None, output_tokens=None):
        update = {"sessionUpdate": "usage_update"}
        if isinstance(input_tokens, (int, float)):
            update["inputTokens"] = max(0, int(input_tokens))
        if isinstance(output_tokens, (int, float)):
            update["outputTokens"] = max(0, int(output_tokens))
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
