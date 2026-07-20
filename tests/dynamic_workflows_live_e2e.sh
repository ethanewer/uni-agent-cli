#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH=""
TMUX_SOCKET="cc-workflow-live-e2e-$PPID-$$"
SESSION="cc-workflow-live-e2e-$$"
EVIDENCE_STAGE="preflight"
events_file=""
meta_file=""
MODEL_API_KEY="${OPENAI_API_KEY:-}"
unset OPENAI_API_KEY
shopt -s nocasematch
while IFS= read -r environment_name; do
	environment_value="${!environment_name-}"
	case "$environment_name" in
		*KEY*|*TOKEN*|*SECRET*|*PASSWORD*|*CREDENTIAL*|*AUTH*|PAT|PAT_*|*_PAT|*_PAT_*)
			unset "$environment_name"
			;;
	esac
	case "$environment_name" in [Nn][Pp][Mm]_[Cc][Oo][Nn][Ff][Ii][Gg]_[Uu][Ss][Ee][Rr][Cc][Oo][Nn][Ff][Ii][Gg]|[Nn][Pp][Mm]_[Cc][Oo][Nn][Ff][Ii][Gg]_[Gg][Ll][Oo][Bb][Aa][Ll][Cc][Oo][Nn][Ff][Ii][Gg]) unset "$environment_name" ;; esac
	case "$environment_value" in *://*@*|*://*[?#]*) unset "$environment_name" ;; esac
	case "$environment_value" in *$'\r'*|*$'\n'*) unset "$environment_name" ;; esac
done < <(compgen -e)
shopt -u nocasematch

release_npm() {
	if [ -n "${CC_RELEASE_NPM_CLI:-}" ] || [ -n "${CC_RELEASE_NODE:-}" ]; then
		if [ -z "${CC_RELEASE_NPM_CLI:-}" ] || [ -z "${CC_RELEASE_NODE:-}" ] ||
			[ "${CC_RELEASE_NPM_CLI#/}" = "$CC_RELEASE_NPM_CLI" ] || [ ! -f "$CC_RELEASE_NPM_CLI" ] ||
			[ "${CC_RELEASE_NODE#/}" = "$CC_RELEASE_NODE" ] || [ ! -x "$CC_RELEASE_NODE" ]; then
			echo "release npm requires absolute CC_RELEASE_NODE and CC_RELEASE_NPM_CLI files" >&2
			exit 1
		fi
		"$CC_RELEASE_NODE" "$CC_RELEASE_NPM_CLI" "$@"
	else
		command npm "$@"
	fi
}
if [ -n "${CC_WORKFLOW_E2E_RESULT_PATH:-}" ] && [ "${CC_WORKFLOW_E2E_RESULT_PATH#/}" = "$CC_WORKFLOW_E2E_RESULT_PATH" ]; then
	echo "CC_WORKFLOW_E2E_RESULT_PATH must be absolute" >&2
	exit 1
fi

tmux_live() { command tmux -L "$TMUX_SOCKET" "$@"; }
capture() { tmux_live capture-pane -pt "$SESSION"; }
write_evidence() {
	local exit_status="$1"
	if [ -z "${CC_WORKFLOW_E2E_RESULT_PATH:-}" ]; then return; fi
	if ! command -v python3 >/dev/null 2>&1; then
		mkdir -p "$(dirname "$CC_WORKFLOW_E2E_RESULT_PATH")"
		printf '{"version":1,"exitStatus":%s,"stage":"%s","evidenceError":"python3 unavailable"}\n' "$exit_status" "$EVIDENCE_STAGE" > "$CC_WORKFLOW_E2E_RESULT_PATH"
		return
	fi
	python3 - "$events_file" "$meta_file" "$CC_WORKFLOW_E2E_RESULT_PATH" "$exit_status" "$EVIDENCE_STAGE" <<'PY'
import json, pathlib, sys
events_name, meta_name, result_name, exit_status, stage = sys.argv[1:]
records = []
parse_errors = 0
events_path = pathlib.Path(events_name) if events_name else None
if events_path and events_path.is_file():
    for line in events_path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line).get("event")
            if isinstance(event, dict):
                records.append(event)
        except Exception:
            parse_errors += 1
meta = {}
meta_path = pathlib.Path(meta_name) if meta_name else None
if meta_path and meta_path.is_file():
    try:
        parsed = json.loads(meta_path.read_text(encoding="utf-8"))
        if isinstance(parsed, dict):
            meta = parsed
    except Exception:
        parse_errors += 1
delivery_state = meta.get("delivery", {}).get("state") if isinstance(meta.get("delivery"), dict) else None
if delivery_state not in ("not-ready", "pending", "queued", "waiting-for-session", "sending", "delivered", "ambiguous", "failed-to-queue", "failed-to-persist", "origin-retired", "not-delivered-after-restart"):
    delivery_state = None
status = meta.get("status")
if status not in ("pending", "running", "paused", "completed", "failed", "cancelled", "interrupted"):
    status = None
queued = [event for event in records if event.get("type") == "agent_queued"]
queued_labels = {
    event.get("agentId"): event.get("options", {}).get("label")
    for event in records
    if event.get("type") == "agent_queued" and isinstance(event.get("options"), dict)
}
queued_prompts_by_label = {
    queued_labels.get(event.get("agentId")): event.get("prompt")
    for event in queued
}
ready = [event for event in records if event.get("type") == "agent_agent_ready"]
ready_agent_ids = [event.get("agentId") for event in ready]
completed_outputs_by_label = {
    queued_labels.get(event.get("agentId")): str(event.get("output", "")).strip()
    for event in records if event.get("type") == "agent_completed"
}
expected_outputs_by_label = {
    "live worker one": "LIVE_WORKER_ONE_OK",
    "live worker two": "LIVE_WORKER_TWO_OK",
}
expected_prompts_by_label = {
    "live worker one": "Return exactly LIVE_WORKER_ONE_OK and nothing else.",
    "live worker two": "Return exactly LIVE_WORKER_TWO_OK and nothing else.",
}
evidence = {
    "version": 1,
    "exitStatus": int(exit_status),
    "stage": stage,
    "status": status,
    "deliveryState": delivery_state,
    # Artifact evidence is strictly allowlisted. Model output, prompts, errors,
    # environment values, and arbitrary event fields must remain only in masked
    # Actions logs and can never be copied into a downloadable artifact.
    "agentReadyCount": len(ready),
    "agentCompletedCount": sum(event.get("type") == "agent_completed" for event in records),
    "runCompletedCount": sum(event.get("type") == "run_completed" for event in records),
    "modelRoutingValidated": len(ready) == 2
        and len(set(ready_agent_ids)) == 2
        and set(ready_agent_ids) == set(queued_labels)
        and all(
        event.get("model") == "gpt-5.6" and event.get("effort") == "high"
        for event in ready
    ),
    "parallelRoutingValidated": (
        len([event for event in records if event.get("type") == "agent_agent_ready"]) == 2
        and len([event for event in records if event.get("type") == "agent_completed"]) == 2
        and max(index for index, event in enumerate(records) if event.get("type") == "agent_agent_ready")
            < min(index for index, event in enumerate(records) if event.get("type") == "agent_completed")
    ),
    "expectedOutputsValidated": (
        len(queued) == 2
        and set(queued_labels.values()) == set(expected_outputs_by_label)
        and queued_prompts_by_label == expected_prompts_by_label
        and completed_outputs_by_label == expected_outputs_by_label
    ),
    "deliveryValidated": delivery_state == "delivered",
    "parseErrors": parse_errors,
}
result_path = pathlib.Path(result_name)
result_path.parent.mkdir(parents=True, exist_ok=True)
result_path.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
}
cleanup() {
	local exit_status="$?"
	local evidence_status=0
	write_evidence "$exit_status" || {
		evidence_status="$?"
		echo "Could not write live workflow evidence" >&2
	}
	if [ -n "$SCRATCH" ] && command -v tmux >/dev/null 2>&1; then
		tmux_live kill-session -t "$SESSION" >/dev/null 2>&1 || true
		tmux_live kill-server >/dev/null 2>&1 || true
	fi
	if [ -n "$SCRATCH" ]; then
		case "$SCRATCH" in
			/var/folders/*/cc-workflow-live-e2e.*|/tmp/cc-workflow-live-e2e.*) rm -rf -- "$SCRATCH" ;;
			*) echo "Refusing to clean unexpected live workflow E2E path: $SCRATCH" >&2 ;;
		esac
	fi
	if [ "$exit_status" -eq 0 ] && [ "$evidence_status" -ne 0 ]; then return "$evidence_status"; fi
	return "$exit_status"
}
trap cleanup EXIT

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
SCRATCH="$(mktemp -d -t cc-workflow-live-e2e.XXXXXX)"
(umask 077; : > "$SCRATCH/user.npmrc"; : > "$SCRATCH/global.npmrc")
export npm_config_userconfig="$SCRATCH/user.npmrc"
export npm_config_globalconfig="$SCRATCH/global.npmrc"
unset npm_config_omit NPM_CONFIG_OMIT

tarball="${CC_WORKFLOW_E2E_TARBALL:-}"
if [ -z "$tarball" ]; then
	release_npm pack --ignore-scripts --pack-destination "$SCRATCH" "$ROOT" >/dev/null
	for candidate in "$SCRATCH"/*.tgz; do
		if [ -f "$candidate" ]; then tarball="$candidate"; break; fi
	done
fi
if [ -z "$tarball" ]; then
	echo "live E2E could not pack the cc artifact" >&2
	exit 1
fi
if [ ! -f "$tarball" ]; then
	echo "live E2E tarball does not exist: $tarball" >&2
	exit 1
fi
install_environment=(
	"PATH=$PATH"
	"HOME=$HOME"
	"npm_config_userconfig=$npm_config_userconfig"
	"npm_config_globalconfig=$npm_config_globalconfig"
)
if [ -n "${TMPDIR:-}" ]; then install_environment+=("TMPDIR=$TMPDIR"); fi
install_command=(npm)
if [ -n "${CC_RELEASE_NPM_CLI:-}" ] || [ -n "${CC_RELEASE_NODE:-}" ]; then
	# Validate the pair with the same fail-closed helper before removing the
	# inherited environment, then execute those resolved absolute files.
	release_npm --version >/dev/null
	install_command=("$CC_RELEASE_NODE" "$CC_RELEASE_NPM_CLI")
fi
# Lifecycle scripts receive only this explicit environment. The protected model
# key is already held in a non-exported shell variable and cannot reach npm or
# any dependency postinstall before the one-use CLI launcher is constructed.
/usr/bin/env -i "${install_environment[@]}" "${install_command[@]}" install --include=optional --no-audit --no-fund --foreground-scripts --dangerously-allow-all-scripts --prefix "$SCRATCH/installed" "$tarball" >"$SCRATCH/install.log" 2>&1
EVIDENCE_STAGE="artifact-installed"
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
	for event_log in "$SCRATCH"/workflow-state/workflow-runs/*/events.jsonl; do
		if [ -f "$event_log" ]; then printf 'event log: %s\n' "$event_log" >&2; tail -80 "$event_log" >&2; fi
	done
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
MODEL_KEY_FILE="$SCRATCH/model-api-key"
(umask 077; printf '%s' "$MODEL_API_KEY" > "$MODEL_KEY_FILE")
MODEL_API_KEY=""
# The tmux server starts without the credential. Its one-use launcher reads a
# private file, deletes it, and immediately execs the installed CLI with the key
# in that process's environment only; neither tmux nor an intermediate shell
# retains the value.
printf -v command_line 'cd %q && model_api_key="$(cat %q)" && rm -f %q && export OPENAI_API_KEY="$model_api_key" && model_api_key= && export CC_CONFIG=%q CC_SETTINGS=%q CC_PERMISSIONS=%q CC_COMMAND_CACHE=%q CC_BACKGROUND_CONNECT_DELAY_MS=0 && exec %q codex' \
	"$PROJECT" "$MODEL_KEY_FILE" "$MODEL_KEY_FILE" "$CONFIG" "$SETTINGS" "$SCRATCH/permissions.json" "$SCRATCH/commands.json" "$CLI_BIN"
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
	events_file=""
	for candidate in "$RUNS"/*/events.jsonl; do
		if [ -f "$candidate" ]; then events_file="$candidate"; break; fi
	done
	if [ -n "$events_file" ] && grep -Fq '"type":"run_started"' "$events_file"; then break; fi
	sleep 0.1
done
if [ -z "$events_file" ] || ! grep -Fq '"type":"run_started"' "$events_file"; then
	echo "Authenticated model did not launch the workflow" >&2
	capture >&2
	exit 1
fi
EVIDENCE_STAGE="workflow-started"
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
EVIDENCE_STAGE="workflow-completed"

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
queued = [entry for entry in records if entry.get("type") == "agent_queued"]
queued_labels = {
    entry.get("agentId"): entry.get("options", {}).get("label")
    for entry in records
    if entry.get("type") == "agent_queued" and isinstance(entry.get("options"), dict)
}
queued_prompts_by_label = {
    queued_labels.get(entry.get("agentId")): entry.get("prompt")
    for entry in queued
}
outputs_by_label = {
    queued_labels.get(entry.get("agentId")): str(entry.get("output", "")).strip()
    for entry in completed
}
assert len(queued) == 2, queued
assert set(queued_labels.values()) == {"live worker one", "live worker two"}, queued_labels
assert {entry.get("agentId") for entry in ready} == set(queued_labels), ready
assert all(entry.get("model") == "gpt-5.6" and entry.get("effort") == "high" for entry in ready), ready
assert queued_prompts_by_label == {
    "live worker one": "Return exactly LIVE_WORKER_ONE_OK and nothing else.",
    "live worker two": "Return exactly LIVE_WORKER_TWO_OK and nothing else.",
}, queued_prompts_by_label
assert outputs_by_label == {
    "live worker one": "LIVE_WORKER_ONE_OK",
    "live worker two": "LIVE_WORKER_TWO_OK",
}, outputs_by_label
PY
EVIDENCE_STAGE="routing-validated"

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
EVIDENCE_STAGE="delivery-confirmed"
tmux_live send-keys -t "$SESSION" Escape
tmux_live send-keys -t "$SESSION" C-d
EVIDENCE_STAGE="passed"
echo "live dynamic workflow E2E: model-authored launch, GPT-5.6 High clone routing, parallel workers, completion delivery, and TUI passed"
