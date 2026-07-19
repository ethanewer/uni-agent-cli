#!/usr/bin/env bash
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
	echo "live dynamic workflow E2E requires macOS sandbox-exec" >&2
	exit 1
fi
for command_name in tmux git python3; do
	if ! command -v "$command_name" >/dev/null 2>&1; then
		echo "live dynamic workflow E2E requires $command_name" >&2
		exit 1
	fi
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d -t cc-workflow-live-e2e.XXXXXX)"
TMUX_SOCKET="cc-workflow-live-e2e-$PPID-$$"
SESSION="cc-workflow-live-e2e-$$"

tmux_live() { command tmux -L "$TMUX_SOCKET" "$@"; }
capture() { tmux_live capture-pane -pt "$SESSION"; }
cleanup() {
	tmux_live kill-session -t "$SESSION" >/dev/null 2>&1 || true
	tmux_live kill-server >/dev/null 2>&1 || true
	case "$SCRATCH" in
		/var/folders/*/cc-workflow-live-e2e.*|/tmp/cc-workflow-live-e2e.*) rm -rf -- "$SCRATCH" ;;
		*) echo "Refusing to clean unexpected live workflow E2E path: $SCRATCH" >&2 ;;
	esac
}
trap cleanup EXIT

tarball="${CC_WORKFLOW_E2E_TARBALL:-}"
if [ -z "$tarball" ]; then
	npm pack --ignore-scripts --pack-destination "$SCRATCH" "$ROOT" >/dev/null
	tarball="$(find "$SCRATCH" -maxdepth 1 -name '*.tgz' -type f -print -quit)"
fi
if [ -z "$tarball" ]; then
	echo "live E2E could not pack the cc artifact" >&2
	exit 1
fi
if [ ! -f "$tarball" ]; then
	echo "live E2E tarball does not exist: $tarball" >&2
	exit 1
fi
npm install --no-audit --no-fund --foreground-scripts --dangerously-allow-all-scripts --prefix "$SCRATCH/installed" "$tarball" >"$SCRATCH/install.log" 2>&1
CLI_BIN="$SCRATCH/installed/node_modules/.bin/cc"
if [ ! -x "$CLI_BIN" ]; then
	echo "live E2E installed cc bin shim is not executable" >&2
	exit 1
fi

wait_for_text() {
	local needle="$1"
	local iterations="${2:-9000}"
	for ((index=0; index<iterations; index+=1)); do
		if capture | grep -Fq "$needle"; then return 0; fi
		sleep 0.1
	done
	echo "Timed out waiting for live workflow TUI text: $needle" >&2
	capture >&2
	find "$SCRATCH/workflow-state/workflow-runs" -name events.jsonl -type f -maxdepth 2 -print -exec tail -80 {} \; >&2 2>/dev/null || true
	exit 1
}

send_text() {
	tmux_live send-keys -t "$SESSION" -l "$1"
	tmux_live send-keys -t "$SESSION" Enter
}

PROJECT="$SCRATCH/project"
mkdir -p "$PROJECT"
printf 'live workflow integration fixture\n' > "$PROJECT/README.md"
git -C "$PROJECT" init -q
git -C "$PROJECT" config user.email workflow-live@example.invalid
git -C "$PROJECT" config user.name "Workflow Live E2E"
git -C "$PROJECT" add README.md
git -C "$PROJECT" commit -qm "live workflow fixture"

CONFIG="$SCRATCH/config.json"
SETTINGS="$SCRATCH/settings.json"
printf '%s\n' '{"defaultAgent":"codex"}' > "$CONFIG"
printf '%s\n' '{"workflowMode":"clone-only","workflowGlobalConcurrency":2,"workflowRunConcurrency":2,"workflowHarnessConcurrency":2,"agents":{"codex":{"config":{"approval_policy":"never","sandbox_mode":"danger-full-access"},"sessionDefaults":{"model":"gpt-5.6","effort":"high"}}}}' > "$SETTINGS"

command_line=""
printf -v command_line 'cd %q && env CC_CONFIG=%q CC_SETTINGS=%q CC_PERMISSIONS=%q CC_COMMAND_CACHE=%q CC_BACKGROUND_CONNECT_DELAY_MS=0 %q codex' \
	"$PROJECT" "$CONFIG" "$SETTINGS" "$SCRATCH/permissions.json" "$SCRATCH/commands.json" "$CLI_BIN"
tmux_live new-session -d -s "$SESSION" -x 150 -y 48 "$command_line"
wait_for_text "Space to record" 1800
wait_for_text "workflows clone only" 1800

read -r -d '' LIVE_PROMPT <<'PROMPT' || true
Use the Workflow tool now to launch this exact JavaScript dynamic workflow. Do not answer the two tasks yourself and do not replace parallel with sequential calls.

export const meta = {
  name: "live-gpt56-smoke",
  description: "Authenticated GPT-5.6 dynamic workflow smoke",
  phases: ["Live"],
};

const results = await parallel([
  () => agent("Return exactly LIVE_WORKER_ONE_OK and nothing else.", { label: "live worker one", phase: "Live", isolation: "worktree" }),
  () => agent("Return exactly LIVE_WORKER_TWO_OK and nothing else.", { label: "live worker two", phase: "Live", isolation: "worktree" }),
]);
return results.join("\n");

Use a concurrency of 2. After the tool reports that it launched, briefly acknowledge the launch and wait for cc's completion delivery.
PROMPT
send_text "$LIVE_PROMPT"
wait_for_text "Run workflow" 9000
tmux_live send-keys -t "$SESSION" Enter
RUNS="$SCRATCH/workflow-state/workflow-runs"
events_file=""
for ((index=0; index<9000; index+=1)); do
	events_file="$(find "$RUNS" -mindepth 2 -maxdepth 2 -name events.jsonl -type f -print -quit 2>/dev/null || true)"
	if [ -n "$events_file" ] && grep -Fq '"type":"run_started"' "$events_file"; then break; fi
	sleep 0.1
done
if [ -z "$events_file" ] || ! grep -Fq '"type":"run_started"' "$events_file"; then
	echo "Authenticated model did not launch the workflow" >&2
	capture >&2
	exit 1
fi
send_text "/workflows"
wait_for_text "live-gpt56-smoke" 1800
wait_for_text "live worker one" 9000
wait_for_text "live worker two" 9000

for ((index=0; index<9000; index+=1)); do
	if grep -Fq '"type":"run_completed"' "$events_file"; then break; fi
	sleep 0.1
done
if [ -z "$events_file" ] || ! grep -Fq '"type":"run_completed"' "$events_file"; then
	echo "Authenticated workflow did not reach run_completed" >&2
	capture >&2
	exit 1
fi

python3 - "$events_file" <<'PY'
import json, sys
records = [json.loads(line)["event"] for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
ready = [entry for entry in records if entry.get("type") == "agent_agent_ready"]
completed = [entry for entry in records if entry.get("type") == "agent_completed"]
assert len(ready) == 2, ready
assert len(completed) == 2, completed
ready_positions = [index for index, entry in enumerate(records) if entry.get("type") == "agent_agent_ready"]
completed_positions = [index for index, entry in enumerate(records) if entry.get("type") == "agent_completed"]
assert max(ready_positions) < min(completed_positions), (ready_positions, completed_positions)
assert all(entry.get("model") == "gpt-5.6" and entry.get("effort") == "high" for entry in ready), ready
output = "\n".join(str(entry.get("output", "")) for entry in completed)
assert "LIVE_WORKER_ONE_OK" in output and "LIVE_WORKER_TWO_OK" in output, output
PY

wait_for_text "completed" 1800
meta_file="$(dirname "$events_file")/meta.json"
for ((index=0; index<9000; index+=1)); do
	if grep -Eq '"state"[[:space:]]*:[[:space:]]*"delivered"' "$meta_file" 2>/dev/null; then break; fi
	sleep 0.1
done
if ! grep -Eq '"state"[[:space:]]*:[[:space:]]*"delivered"' "$meta_file" 2>/dev/null; then
	echo "Authenticated workflow completion was not delivered to the originating orchestrator session" >&2
	capture >&2
	exit 1
fi
if [ -n "${CC_WORKFLOW_E2E_RESULT_PATH:-}" ]; then
	if [ "${CC_WORKFLOW_E2E_RESULT_PATH#/}" = "$CC_WORKFLOW_E2E_RESULT_PATH" ]; then
		echo "CC_WORKFLOW_E2E_RESULT_PATH must be absolute" >&2
		exit 1
	fi
	python3 - "$events_file" "$meta_file" "$CC_WORKFLOW_E2E_RESULT_PATH" <<'PY'
import json, pathlib, sys
events_path, meta_path, result_path = map(pathlib.Path, sys.argv[1:])
records = [json.loads(line)["event"] for line in events_path.read_text(encoding="utf-8").splitlines() if line.strip()]
meta = json.loads(meta_path.read_text(encoding="utf-8"))
evidence = {
    "version": 1,
    "taskId": meta.get("id"),
    "status": meta.get("status"),
    "delivery": meta.get("delivery"),
    "agentReady": [event for event in records if event.get("type") == "agent_agent_ready"],
    "agentCompleted": [event for event in records if event.get("type") == "agent_completed"],
    "runCompleted": [event for event in records if event.get("type") == "run_completed"],
}
result_path.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
fi
tmux_live send-keys -t "$SESSION" Escape
tmux_live send-keys -t "$SESSION" C-d
echo "live dynamic workflow E2E: model-authored launch, GPT-5.6 High clone routing, parallel workers, completion delivery, and TUI passed"
