#!/usr/bin/env python3
import json
import os
import select
import subprocess
import sys
import time
import uuid

next_client_request_id = 1000
SLOW_DELAY = float(os.environ.get("FAKE_ACP_SLOW_DELAY", "0.8"))
NEW_DELAY = float(os.environ.get("FAKE_ACP_NEW_DELAY", "0"))
COMMANDS_GATE = os.environ.get("FAKE_ACP_COMMANDS_GATE")
NEW_GATE = os.environ.get("FAKE_ACP_NEW_GATE")
SESSION_LIST_GATE = os.environ.get("FAKE_ACP_SESSION_LIST_GATE")
START_LOG = os.environ.get("FAKE_ACP_START_LOG")
WORKFLOW_E2E = os.environ.get("FAKE_WORKFLOW_E2E") == "1"
WORKFLOW_E2E_LOG = os.environ.get("FAKE_WORKFLOW_E2E_LOG")
WORKFLOW_E2E_DELAY = float(os.environ.get("FAKE_WORKFLOW_E2E_DELAY", "1.2"))
WORKFLOW_E2E_GATE = os.environ.get("FAKE_WORKFLOW_E2E_GATE")
_fake_session_id = os.environ.get("FAKE_ACP_SESSION_ID", "fake-session")
FAKE_SESSION_ID = str(uuid.uuid4()) if _fake_session_id == "random" else _fake_session_id
SESSION_CWD = os.getcwd()
SESSION_MCP_SERVERS = []


def record(event):
    if not START_LOG:
        return
    with open(START_LOG, "a", encoding="utf-8") as log:
        log.write(event + "\n")
        log.flush()


def wait_for_gate(gate):
    while gate and not os.path.exists(gate):
        time.sleep(0.01)

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
    {
        "id": "thought_level",
        "name": "Reasoning Effort",
        "category": "thought_level",
        "type": "select",
        "currentValue": "high",
        "options": [
            {"value": "low", "name": "Low"},
            {"value": "high", "name": "High"},
        ],
    },
    {
        "id": "fast-mode",
        "name": "Fast mode",
        "category": "model_config",
        "type": "boolean",
        "currentValue": False,
        "description": "1.5x speed, increased usage",
    },
    {
        "id": "verbosity",
        "name": "Verbosity",
        "category": "_fake_verbosity",
        "type": "select",
        "currentValue": "normal",
        "options": [
            {"value": "quiet", "name": "Quiet"},
            {"value": "normal", "name": "Normal"},
        ],
    },
]
CONFIG_VALUES = {option["id"]: option["currentValue"] for option in CONFIG_OPTIONS}


def config_snapshot():
    return [{**option, "currentValue": CONFIG_VALUES.get(option["id"], option["currentValue"])} for option in CONFIG_OPTIONS]


def workflow_e2e_record(event, **fields):
    if not WORKFLOW_E2E_LOG:
        return
    record_value = {
        "event": event,
        "pid": os.getpid(),
        "time": time.time(),
        "cwd": SESSION_CWD,
        "harness": os.environ.get("FAKE_WORKFLOW_E2E_HARNESS", "unknown"),
        "model": CONFIG_VALUES.get("model"),
        "effort": CONFIG_VALUES.get("thought_level"),
        **fields,
    }
    encoded = json.dumps(record_value, sort_keys=True) + "\n"
    descriptor = os.open(WORKFLOW_E2E_LOG, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.write(descriptor, encoded.encode("utf-8"))
    finally:
        os.close(descriptor)


def workflow_mcp_server():
    for server in SESSION_MCP_SERVERS:
        if server.get("name") == "cc-dynamic-workflows":
            return server
    raise RuntimeError("cc did not inject the dynamic workflow MCP server")


def mcp_write(process, message):
    process.stdin.write(json.dumps(message) + "\n")
    process.stdin.flush()


def mcp_response(process, request_id):
    while True:
        raw = process.stdout.readline()
        if not raw:
            detail = process.stderr.read().strip()
            raise RuntimeError(f"workflow MCP server exited before response {request_id}: {detail}")
        message = json.loads(raw)
        if message.get("id") != request_id:
            continue
        if "error" in message:
            raise RuntimeError(message["error"].get("message", "workflow MCP request failed"))
        return message.get("result", {})


def call_workflow_mcp(source, max_concurrency):
    server = workflow_mcp_server()
    child_env = os.environ.copy()
    raw_env = server.get("env") or []
    if isinstance(raw_env, dict):
        child_env.update({str(key): str(value) for key, value in raw_env.items()})
    else:
        child_env.update({str(entry["name"]): str(entry.get("value", "")) for entry in raw_env})
    process = subprocess.Popen(
        [server["command"], *(server.get("args") or [])],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        env=child_env,
    )
    try:
        mcp_write(process, {
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "cc-fake-workflow-e2e", "version": "1"},
            },
        })
        mcp_response(process, 1)
        mcp_write(process, {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
        mcp_write(process, {
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": {"name": "Workflow", "arguments": {"script": source, "maxConcurrency": max_concurrency}},
        })
        result = mcp_response(process, 2)
        if result.get("isError"):
            raise RuntimeError(json.dumps(result.get("content") or result))
        return result.get("structuredContent") or result
    finally:
        if process.stdin:
            process.stdin.close()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)


def workflow_source_from_prompt(prompt):
    # E2E_MODEL_WORKFLOW|name|relative/path,...|clone|concurrency
    parts = prompt.split("|", 4)
    if len(parts) != 5:
        raise ValueError("invalid E2E workflow prompt")
    kind, name, raw_files, routing, concurrency = parts
    worker_command = "E2E_EDIT|" if kind == "E2E_MODEL_WORKFLOW_EDIT" else "E2E_ANALYZE|"
    worker_label = "Edit" if kind == "E2E_MODEL_WORKFLOW_EDIT" else "Analyze"
    files = [entry for entry in raw_files.split(",") if entry]
    if len(files) not in (4, 6):
        raise ValueError("E2E workflow must contain four or six parallel tasks")
    calls = []
    for index, relative in enumerate(files):
        options = {"label": f"{worker_label} {relative}", "phase": "Analyze", "isolation": "worktree"}
        if routing == "flexible":
            if index % 2 == 0:
                options.update({"harness": "cursor", "model": "fast", "effort": "high"})
            else:
                options.update({"harness": "codex", "model": "deep", "effort": "low"})
        calls.append(f"() => agent({json.dumps(worker_command + relative)}, {json.dumps(options)})")
    source = "\n".join([
        f"export const meta = {{ name: {json.dumps(name)}, description: {json.dumps(f'Analyze {len(files)} independent project modules')}, phases: ['Analyze'] }};",
        "phase('Analyze');",
        "const results = await parallel([",
        "  " + ",\n  ".join(calls),
        "]);",
        f"return {{ count: {len(files)}, results }};",
    ])
    return source, int(concurrency)


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


def request_many(requests):
    global next_client_request_id
    pending = {}
    results = {}
    for method, params in requests:
        request_id = next_client_request_id
        next_client_request_id += 1
        pending[request_id] = method
        send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
    for raw in sys.stdin:
        message = json.loads(raw)
        request_id = message.get("id")
        if request_id in pending:
            if "error" in message:
                raise RuntimeError(message["error"].get("message", "client request failed"))
            results[request_id] = message.get("result", {})
            if len(results) == len(pending):
                return [results[request_id] for request_id in pending]
            continue
        handle_message(message)
    raise RuntimeError("stdin closed")


def poll_cancel(duration, gate=None):
    while gate and not os.path.exists(gate):
        readable, _, _ = select.select([sys.stdin], [], [], 0.05)
        if not readable:
            continue
        raw = sys.stdin.readline()
        if not raw:
            return False
        message = json.loads(raw)
        if message.get("method") == "session/cancel":
            return True
        handle_message(message)
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
    global SESSION_CWD, SESSION_MCP_SERVERS
    method = message.get("method")
    request_id = message.get("id")

    if method == "initialize":
        record("initialize")
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
                        "promptCapabilities": {"image": True, "embeddedContext": True},
                        "sessionCapabilities": {
                            "list": {},
                            "resume": {},
                            "fork": {},
                            "delete": {},
                            "additionalDirectories": {},
                        },
                        "mcpCapabilities": {"http": True, "sse": False, "acp": False},
                    },
                    "agentInfo": {
                        "name": os.environ.get("FAKE_ACP_AGENT_NAME", "fake-acp"),
                        "title": "Fake ACP",
                        "version": os.environ.get("FAKE_ACP_AGENT_VERSION", "0.0.0"),
                    },
                    "authMethods": [],
                },
            }
        )
    elif method == "session/new":
        record("session/new")
        requested_cwd = message.get("params", {}).get("cwd")
        SESSION_CWD = os.path.abspath(requested_cwd or os.getcwd())
        SESSION_MCP_SERVERS = list(message.get("params", {}).get("mcpServers") or [])
        if WORKFLOW_E2E:
            workflow_e2e_record(
                "session_new",
                mcp=[server.get("name") for server in SESSION_MCP_SERVERS],
                requestedCwd=requested_cwd,
                workflowChild=os.environ.get("CC_WORKFLOW_CHILD") == "1",
            )
        wait_for_gate(NEW_GATE)
        if NEW_DELAY > 0:
            poll_cancel(NEW_DELAY)
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "sessionId": FAKE_SESSION_ID,
                    "configOptions": config_snapshot(),
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
        while COMMANDS_GATE and not os.path.exists(COMMANDS_GATE):
            time.sleep(0.01)
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
                            {"name": "review-branch", "description": "Review against a branch"},
                            {"name": "review-commit", "description": "Review a commit"},
                            {"name": "permission-test", "description": "Exercise ACP permission requests"},
                            {"name": "permission-always", "description": "Exercise an allow_always permission option"},
                            {"name": "permission-only-always", "description": "Offer only reject_once + allow_always (no allow_once)"},
                            {"name": "permission-overlap", "description": "Exercise overlapping ACP permission requests"},
                            {"name": "permission-exit", "description": "Exit while a permission request is open"},
                            {"name": "rpc-parse-error", "description": "Return a structured JSON-RPC parse error"},
                            {"name": "terminal-test", "description": "Exercise ACP terminal requests"},
                            {"name": "status", "description": "Show backend status and usage"},
                            {"name": "$fake-skill", "description": "Use the fake skill"},
                        ],
                    },
                },
            }
        )
    elif method == "session/list":
        record("session/list")
        wait_for_gate(SESSION_LIST_GATE)
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
        SESSION_CWD = os.path.abspath(message.get("params", {}).get("cwd") or os.getcwd())
        SESSION_MCP_SERVERS = list(message.get("params", {}).get("mcpServers") or [])
        if WORKFLOW_E2E:
            modes = []
            for server in SESSION_MCP_SERVERS:
                env = {entry.get("name"): entry.get("value") for entry in (server.get("env") or [])}
                if env.get("CC_WORKFLOW_MODE"):
                    modes.append(env["CC_WORKFLOW_MODE"])
            workflow_e2e_record("session_load", mcp=[server.get("name") for server in SESSION_MCP_SERVERS], workflowModes=modes)
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
                "result": {"configOptions": config_snapshot()},
            }
        )
    elif method == "session/resume":
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {"configOptions": config_snapshot()},
            }
        )
    elif method == "session/fork":
        # A fork keeps the same fake session id for simplicity; in this process it
        # behaves like a fresh forked thread that can still prompt and use tools.
        send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {"sessionId": "fake-session", "configOptions": config_snapshot()},
            }
        )
    elif method == "session/delete":
        send({"jsonrpc": "2.0", "id": request_id, "result": {}})
    elif method == "session/set_config_option":
        config_id = message["params"]["configId"]
        value = message["params"].get("value")
        advertised = next((option for option in CONFIG_OPTIONS if option["id"] == config_id), None)
        allowed = [entry.get("value") for entry in (advertised or {}).get("options", [])]
        if not advertised or (allowed and value not in allowed):
            send({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32602, "message": "unsupported config value"}})
            return True
        CONFIG_VALUES[config_id] = value
        if WORKFLOW_E2E:
            workflow_e2e_record("config", configId=config_id, value=value)
        send({"jsonrpc": "2.0", "id": request_id, "result": {"configOptions": config_snapshot()}})
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
    prompt_parts = message["params"]["prompt"]
    prompt = prompt_text(prompt_parts)
    if WORKFLOW_E2E and prompt.startswith(("E2E_MODEL_WORKFLOW|", "E2E_MODEL_WORKFLOW_EDIT|")):
        source, concurrency = workflow_source_from_prompt(prompt)
        workflow_e2e_record("orchestrator_workflow_call", source=source, concurrency=concurrency)
        send({
            "jsonrpc": "2.0", "method": "session/update",
            "params": {"sessionId": FAKE_SESSION_ID, "update": {
                "sessionUpdate": "tool_call", "toolCallId": "workflow-e2e", "status": "pending",
                "title": "Create dynamic workflow",
            }},
        })
        result = call_workflow_mcp(source, concurrency)
        workflow_e2e_record("orchestrator_workflow_started", result=result)
        send({
            "jsonrpc": "2.0", "method": "session/update",
            "params": {"sessionId": FAKE_SESSION_ID, "update": {
                "sessionUpdate": "tool_call_update", "toolCallId": "workflow-e2e", "status": "completed",
            }},
        })
        send({
            "jsonrpc": "2.0", "method": "session/update",
            "params": {"sessionId": FAKE_SESSION_ID, "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": f"workflow launched: {result.get('taskId')}"},
            }},
        })
        send({"jsonrpc": "2.0", "id": request_id, "result": {"stopReason": "end_turn", "usage": {"inputTokens": 10, "outputTokens": 5}}})
        return

    if WORKFLOW_E2E and prompt.startswith(("E2E_ANALYZE|", "E2E_EDIT|")):
        editing = prompt.startswith("E2E_EDIT|")
        relative = prompt.split("|", 1)[1]
        root = os.path.realpath(SESSION_CWD)
        target = os.path.realpath(os.path.join(root, relative))
        if os.path.commonpath([root, target]) != root:
            raise RuntimeError("E2E analysis path escaped the project")
        workflow_e2e_record("worker_start", prompt=prompt, relative=relative)
        send({
            "jsonrpc": "2.0", "method": "session/update",
            "params": {"sessionId": FAKE_SESSION_ID, "update": {
                "sessionUpdate": "tool_call", "toolCallId": "analyze-e2e", "status": "pending",
                "title": f"{'Edit' if editing else 'Analyze'} {relative}",
            }},
        })
        if poll_cancel(WORKFLOW_E2E_DELAY, WORKFLOW_E2E_GATE):
            workflow_e2e_record("worker_cancelled", prompt=prompt, relative=relative)
            send({"jsonrpc": "2.0", "id": request_id, "result": {"stopReason": "cancelled"}})
            return
        try:
            with open(target, "r", encoding="utf-8") as source_file:
                content = source_file.read().strip()
        except FileNotFoundError:
            # A model turn can fail without the ACP server process crashing. Keep
            # the streaming backend alive so the workflow records an ordinary
            # failed agent attempt and the supervisor can attest owner-driven
            # shutdown instead of correctly fencing an unexplained backend exit.
            message_text = f"E2E analysis target does not exist: {relative}"
            workflow_e2e_record("worker_error", prompt=prompt, relative=relative, error=message_text)
            send({
                "jsonrpc": "2.0", "method": "session/update",
                "params": {"sessionId": FAKE_SESSION_ID, "update": {
                    "sessionUpdate": "tool_call_update", "toolCallId": "analyze-e2e", "status": "failed",
                }},
            })
            send({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32000, "message": message_text}})
            return
        if editing:
            with open(target, "a", encoding="utf-8") as target_file:
                target_file.write("workflow-applied-change\n")
            output = f"edited:{relative}"
        else:
            output = f"analysis:{relative}:{content}"
        send({
            "jsonrpc": "2.0", "method": "session/update",
            "params": {"sessionId": FAKE_SESSION_ID, "update": {
                "sessionUpdate": "tool_call_update", "toolCallId": "analyze-e2e", "status": "completed",
            }},
        })
        send({
            "jsonrpc": "2.0", "method": "session/update",
            "params": {"sessionId": FAKE_SESSION_ID, "update": {
                "sessionUpdate": "usage_update", "inputTokens": 12, "outputTokens": 7,
            }},
        })
        send({
            "jsonrpc": "2.0", "method": "session/update",
            "params": {"sessionId": FAKE_SESSION_ID, "update": {
                "sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": output},
            }},
        })
        workflow_e2e_record("worker_end", prompt=prompt, relative=relative, output=output)
        send({
            "jsonrpc": "2.0", "id": request_id,
            "result": {"stopReason": "end_turn", "usage": {"inputTokens": 12, "outputTokens": 7}},
        })
        return

    if WORKFLOW_E2E and prompt.startswith("<task-notification"):
        workflow_e2e_record("orchestrator_completion", prompt=prompt)
        send({
            "jsonrpc": "2.0", "method": "session/update",
            "params": {"sessionId": FAKE_SESSION_ID, "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": "orchestrator received workflow completion"},
            }},
        })
        send({"jsonrpc": "2.0", "id": request_id, "result": {"stopReason": "end_turn", "usage": {"inputTokens": 8, "outputTokens": 4}}})
        return

    if prompt == "crash turn":
        send(
            {
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "fake-session",
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": "crash turn started"},
                    },
                },
            }
        )
        time.sleep(0.6)
        os._exit(23)

    if prompt == "delayed tool":
        if poll_cancel(SLOW_DELAY):
            send({"jsonrpc": "2.0", "id": request_id, "result": {"stopReason": "cancelled"}})
            return
        send_slow_tool_turn(request_id)
        return

    if prompt == "slow tool":
        send_slow_tool_turn(request_id)
        return

    if prompt.startswith("/review"):
        send_review_response(request_id, prompt)
        return

    if prompt == "/status":
        send(
            {
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "fake-session",
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": "fake backend status: tokens 12"},
                    },
                },
            }
        )
        send({"jsonrpc": "2.0", "id": request_id, "result": {"stopReason": "end_turn"}})
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

    if prompt == "/permission-always":
        permission = request(
            "session/request_permission",
            {
                "sessionId": "fake-session",
                "toolCall": {
                    "toolCallId": "permission-always-1",
                    "title": "Always Test",
                    "status": "pending",
                },
                "options": [
                    {"kind": "reject_once", "name": "Reject", "optionId": "reject"},
                    {"kind": "allow_once", "name": "Allow once", "optionId": "allow-once"},
                    {"kind": "allow_always", "name": "Allow always", "optionId": "allow-always"},
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

    if prompt == "/permission-only-always":
        permission = request(
            "session/request_permission",
            {
                "sessionId": "fake-session",
                "toolCall": {
                    "toolCallId": "permission-only-always-1",
                    "title": "Only Always Test",
                    "status": "pending",
                },
                "options": [
                    {"kind": "reject_once", "name": "Reject", "optionId": "reject"},
                    {"kind": "allow_always", "name": "Allow always", "optionId": "allow-always"},
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

    if prompt == "/permission-overlap":
        permissions = request_many(
            [
                (
                    "session/request_permission",
                    {
                        "sessionId": "fake-session",
                        "toolCall": {
                            "toolCallId": "permission-1",
                            "title": "Permission One",
                            "status": "pending",
                        },
                        "options": [
                            {"kind": "reject_once", "name": "Reject", "optionId": "reject-one"},
                            {"kind": "allow_once", "name": "Allow", "optionId": "allow-one"},
                        ],
                    },
                ),
                (
                    "session/request_permission",
                    {
                        "sessionId": "fake-session",
                        "toolCall": {
                            "toolCallId": "permission-2",
                            "title": "Permission Two",
                            "status": "pending",
                        },
                        "options": [
                            {"kind": "reject_once", "name": "Reject", "optionId": "reject-two"},
                            {"kind": "allow_once", "name": "Allow", "optionId": "allow-two"},
                        ],
                    },
                ),
            ]
        )
        send(
            {
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "fake-session",
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "content": {"type": "text", "text": json.dumps(permissions, sort_keys=True)},
                    },
                },
            }
        )
        send({"jsonrpc": "2.0", "id": request_id, "result": {"stopReason": "end_turn"}})
        return

    if prompt == "/permission-exit":
        send(
            {
                "jsonrpc": "2.0",
                "id": next_client_request_id,
                "method": "session/request_permission",
                "params": {
                    "sessionId": "fake-session",
                    "toolCall": {
                        "toolCallId": "permission-exit",
                        "title": "Permission Exit",
                        "status": "pending",
                    },
                    "options": [
                        {"kind": "reject_once", "name": "Reject", "optionId": "reject-exit"},
                        {"kind": "allow_once", "name": "Allow", "optionId": "allow-exit"},
                    ],
                },
            }
        )
        sys.exit(7)

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

    if prompt == "echo-user-chunk":
        send(
            {
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {
                    "sessionId": "fake-session",
                    "update": {
                        "sessionUpdate": "user_message_chunk",
                        "content": {"type": "text", "text": prompt},
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
        return

    send_default_prompt_response(request_id, prompt)


def prompt_text(parts):
    chunks = []
    for part in parts:
        kind = part.get("type")
        if kind == "text":
            chunks.append(part.get("text", ""))
        elif kind == "image":
            mime = part.get("mimeType") or part.get("mime_type") or "image"
            chunks.append(f"[image:{mime}]")
        elif kind == "resource":
            resource = part.get("resource", {})
            chunks.append(f"[resource:{resource.get('uri', '')}:{resource.get('text', '')}]")
        elif kind == "resource_link":
            chunks.append(f"[resource-link:{part.get('uri', '')}]")
        else:
            chunks.append(f"[{kind or 'part'}]")
    return "".join(chunks)


def send_review_response(request_id, prompt):
    send(
        {
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "fake-session",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": "review prompt: " + prompt},
                },
            },
        }
    )
    send({"jsonrpc": "2.0", "id": request_id, "result": {"stopReason": "end_turn"}})


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
