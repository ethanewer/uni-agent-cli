#!/usr/bin/env python3
import json
import sys
import time


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def prompt_text(parts):
    return "".join(part.get("text", "") for part in parts if part.get("type") == "text")


def send_text_update(session_update, text):
    send({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": "trace-e2e-session",
            "update": {
                "sessionUpdate": session_update,
                "content": {"type": "text", "text": text},
            },
        },
    })


def handle(message):
    method = message.get("method")
    request_id = message.get("id")
    if method == "initialize":
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": 1,
                "agentCapabilities": {},
                "agentInfo": {"name": "trace-e2e-acp", "title": "Trace E2E ACP"},
                "authMethods": [],
            },
        })
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": request_id, "result": {"sessionId": "trace-e2e-session"}})
    elif method == "session/prompt":
        prompt = prompt_text(message["params"]["prompt"])
        if prompt == "many tools":
            for index in range(1, 46):
                send({
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {
                        "sessionId": "trace-e2e-session",
                        "update": {
                            "sessionUpdate": "tool_call",
                            "toolCallId": f"tool-{index}",
                            "title": f"Trace Tool {index:02d}",
                        },
                    },
                })
                time.sleep(0.015)
            for index in range(1, 46):
                send({
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {
                        "sessionId": "trace-e2e-session",
                        "update": {
                            "sessionUpdate": "tool_call_update",
                            "toolCallId": f"tool-{index}",
                            "status": "completed",
                        },
                    },
                })
                time.sleep(0.015)
            send_text_update("agent_message_chunk", "trace done")
            send({"jsonrpc": "2.0", "id": request_id, "result": {"stopReason": "end_turn"}})
        elif prompt == "many user chunks":
            for index in range(1, 46):
                send_text_update("user_message_chunk", f"user trace line {index:02d}\n")
                time.sleep(0.015)
            send_text_update("agent_message_chunk", "user trace done")
            send({"jsonrpc": "2.0", "id": request_id, "result": {"stopReason": "end_turn"}})
        else:
            send({"jsonrpc": "2.0", "id": request_id, "result": {"stopReason": "end_turn"}})
    elif method == "session/cancel":
        return
    else:
        send({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "unsupported"}})


for raw in sys.stdin:
    handle(json.loads(raw))
