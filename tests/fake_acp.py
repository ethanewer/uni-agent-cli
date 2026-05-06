#!/usr/bin/env python3
import json
import os
import select
import sys
import time

next_client_request_id = 1000
SLOW_DELAY = float(os.environ.get("FAKE_ACP_SLOW_DELAY", "0.8"))

CONFIG_OPTIONS = [
    {
        "id": "model",
        "name": "Model",
        "category": "model",
        "type": "select",
        "currentValue": "fast",
        "options": [
            {"value": "fast", "name": "Fast", "description": "Low latency"},
            {"value": "deep", "name": "Deep", "description": "More reasoning"},
        ],
    },
    {
        "id": "mode",
        "name": "Mode",
        "category": "mode",
        "type": "select",
        "currentValue": "agent",
        "options": [
            {"value": "agent", "name": "Agent"},
            {"value": "plan", "name": "Plan"},
        ],
    },
]


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def request(method, params):
    global next_client_request_id
    request_id = next_client_request_id
    next_client_request_id += 1
    send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
    for raw in sys.stdin:
        message = json.loads(raw)
        if message.get("id") == request_id:
            if "error" in message:
                raise RuntimeError(message["error"].get("message", "client request failed"))
            return message.get("result", {})
        handle_message(message)
    raise RuntimeError("stdin closed")


def poll_cancel(duration):
    deadline = time.monotonic() + duration
    while time.monotonic() < deadline:
        timeout = min(0.05, max(0, deadline - time.monotonic()))
        readable, _, _ = select.select([sys.stdin], [], [], timeout)
        if not readable:
            continue
        raw = sys.stdin.readline()
        if not raw:
            return False
        message = json.loads(raw)
        if message.get("method") == "session/cancel":
            return True
        handle_message(message)
    return False


def handle_message(message):
    method = message.get("method")
    request_id = message.get("id")

    if method == "initialize":
        if os.environ.get("FAKE_ACP_EXIT_INIT") == "1":
            sys.stderr.write("fake backend crash\n")
            sys.stderr.flush()
            sys.exit(42)
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "protocolVersion": 1,
                    "agentCapabilities": {
                        "loadSession": True,
                        "sessionCapabilities": {"list": {}, "resume": {}},
                    },
                    "agentInfo": {
                        "name": "fake-acp",
                        "title": "Fake ACP",
                        "version": "0.0.0",
                    },
                    "authMethods": [],
                },
            }
        )
    elif method == "session/new":
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "sessionId": "fake-session",
                    "configOptions": CONFIG_OPTIONS,
                    "modes": {
                        "currentModeId": "agent",
                        "availableModes": [
                            {"id": "agent", "name": "Agent"},
                            {"id": "plan", "name": "Plan"},
                        ],
                    },
                },
            }
        )
        send(
            {
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "fake-session",
                    "update": {
                        "sessionUpdate": "available_commands_update",
                        "availableCommands": [
                            {"name": "fake", "description": "Fake backend command"},
                            {"name": "review", "description": "Review current changes"},
                            {"name": "permission-test", "description": "Exercise ACP permission requests"},
                            {"name": "rpc-parse-error", "description": "Return a structured JSON-RPC parse error"},
                            {"name": "terminal-test", "description": "Exercise ACP terminal requests"},
                        ],
                    },
                },
            }
        )
    elif method == "session/list":
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "sessions": [
                        {
                            "sessionId": "fake-session",
                            "cwd": "/tmp/fake",
                            "title": "Current fake session",
                            "updatedAt": "2026-05-05T12:00:00Z",
                        },
                        {
                            "sessionId": "older-session",
                            "cwd": "/tmp/fake",
                            "title": "Older fake session",
                            "updatedAt": "2026-05-04T12:00:00Z",
                        },
                    ]
                },
            }
        )
    elif method == "session/load":
        send(
            {
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": message["params"]["sessionId"],
                    "update": {
                        "sessionUpdate": "user_message_chunk",
                        "content": {"type": "text", "text": "previous question"},
                    },
                },
            }
        )
        send(
            {
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": message["params"]["sessionId"],
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": "previous answer"},
                    },
                },
            }
        )
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {"configOptions": CONFIG_OPTIONS},
            }
        )
    elif method == "session/resume":
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {"configOptions": CONFIG_OPTIONS},
            }
        )
    elif method == "session/set_config_option":
        config_id = message["params"]["configId"]
        value = message["params"].get("value")
        updated = []
        for option in CONFIG_OPTIONS:
            next_option = dict(option)
            if next_option["id"] == config_id:
                next_option["currentValue"] = value
            updated.append(next_option)
        send({"jsonrpc": "2.0", "id": request_id, "result": {"configOptions": updated}})
    elif method == "session/prompt":
        handle_prompt(message)
    elif method == "session/cancel":
        continue_message = True
        return continue_message
    else:
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32601, "message": "unsupported"},
            }
        )
    return True


def handle_prompt(message):
    request_id = message.get("id")
    prompt = message["params"]["prompt"][0]["text"]
    if prompt == "delayed tool":
        if poll_cancel(SLOW_DELAY):
            send({"jsonrpc": "2.0", "id": request_id, "result": {"stopReason": "cancelled"}})
            return
        send_slow_tool_turn(request_id)
        return

    if prompt == "slow tool":
        send_slow_tool_turn(request_id)
        return

    if prompt == "/rpc-parse-error":
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": -32700,
                    "message": "Parse error",
                    "data": {"detail": "fake malformed backend response"},
                },
            }
        )
        return

    if prompt == "/permission-test":
        permission = request(
            "session/request_permission",
            {
                "sessionId": "fake-session",
                "toolCall": {
                    "toolCallId": "permission-1",
                    "title": "Permission Test",
                    "status": "pending",
                },
                "options": [
                    {"kind": "reject_once", "name": "Reject", "optionId": "reject"},
                    {"kind": "allow_once", "name": "Allow", "optionId": "allow"},
                ],
            },
        )
        send(
            {
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "fake-session",
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": json.dumps(permission, sort_keys=True)},
                    },
                },
            }
        )
        send({"jsonrpc": "2.0", "id": request_id, "result": {"stopReason": "end_turn"}})
        return

    if prompt == "/terminal-test":
        terminal = request(
            "terminal/create",
            {
                "sessionId": "fake-session",
                "command": "python3",
                "args": ["-c", "print('terminal-ok')"],
                "cwd": None,
                "env": [],
                "outputByteLimit": 200,
            },
        )
        request("terminal/wait_for_exit", {"sessionId": "fake-session", "terminalId": terminal["terminalId"]})
        output = request("terminal/output", {"sessionId": "fake-session", "terminalId": terminal["terminalId"]})
        request("terminal/release", {"sessionId": "fake-session", "terminalId": terminal["terminalId"]})
        send(
            {
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "fake-session",
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": output.get("output", "").strip()},
                    },
                },
            }
        )
        send({"jsonrpc": "2.0", "id": request_id, "result": {"stopReason": "end_turn"}})
        return

    send_default_prompt_response(request_id, prompt)


def send_slow_tool_turn(request_id):
    send(
        {
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "fake-session",
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "slow-1",
                    "title": "Slow Tool",
                },
            },
        }
    )
    if poll_cancel(SLOW_DELAY):
        send({"jsonrpc": "2.0", "id": request_id, "result": {"stopReason": "cancelled"}})
        return
    send(
        {
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "fake-session",
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "slow-1",
                    "status": "completed",
                },
            },
        }
    )
    if poll_cancel(SLOW_DELAY):
        send({"jsonrpc": "2.0", "id": request_id, "result": {"stopReason": "cancelled"}})
        return
    send(
        {
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "fake-session",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": "slow done"},
                },
            },
        }
    )
    send({"jsonrpc": "2.0", "id": request_id, "result": {"stopReason": "end_turn"}})


def send_default_prompt_response(request_id, prompt):
    send(
        {
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "fake-session",
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "find-1",
                    "status": "completed",
                    "title": "Find",
                },
            },
        }
    )
    for index in range(5):
        send(
            {
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "fake-session",
                    "update": {
                        "sessionUpdate": "tool_call",
                        "toolCallId": f"read-{index}",
                        "title": "Read File",
                    },
                },
            }
        )
    send(
        {
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "fake-session",
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "read-0",
                    "status": "completed",
                },
            },
        }
    )
    send(
        {
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "fake-session",
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "readme-1",
                    "title": "Read README.md",
                },
            },
        }
    )
    send(
        {
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "fake-session",
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "readme-1",
                    "status": "completed",
                },
            },
        }
    )
    send(
        {
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "fake-session",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": "echo: " + prompt},
                },
            },
        }
    )
    send({"jsonrpc": "2.0", "id": request_id, "result": {"stopReason": "end_turn"}})


for raw in sys.stdin:
    message = json.loads(raw)
    if handle_message(message) is False:
        continue
