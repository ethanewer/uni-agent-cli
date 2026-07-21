#!/usr/bin/env bash
set -euo pipefail

shopt -s nocasematch
while IFS= read -r environment_name; do
	environment_value="${!environment_name-}"
	case "$environment_name" in *KEY*|*TOKEN*|*SECRET*|*PASSWORD*|*CREDENTIAL*|*AUTH*|PAT|PAT_*|*_PAT|*_PAT_*) unset "$environment_name" ;; esac
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
if [ "$(uname -s)" != "Darwin" ]; then
	if [ "${CC_WORKFLOW_E2E_REQUIRED:-0}" = "1" ]; then
		echo "dynamic workflows E2E: macOS sandbox-exec is required for the release gate" >&2
		exit 1
	fi
	echo "dynamic workflows E2E: skipped (execution requires macOS sandbox-exec)"
	exit 0
fi

if ! command -v tmux >/dev/null 2>&1; then
	echo "tmux is required for the dynamic workflow TUI release gate" >&2
	exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d -t cc-workflow-e2e.XXXXXX)"
(umask 077; : > "$SCRATCH/user.npmrc"; : > "$SCRATCH/global.npmrc")
export npm_config_userconfig="$SCRATCH/user.npmrc"
export npm_config_globalconfig="$SCRATCH/global.npmrc"
unset npm_config_omit NPM_CONFIG_OMIT
TMUX_SOCKET="cc-workflow-e2e-$PPID-$$"
SESSION=""
CC_LAUNCH="$(printf '%q %q' node "$ROOT/src/cc.mjs")"

tmux_e2e() {
	command tmux -L "$TMUX_SOCKET" "$@"
}

cleanup() {
	if [ -n "$SESSION" ]; then tmux_e2e kill-session -t "$SESSION" >/dev/null 2>&1 || true; fi
	tmux_e2e kill-server >/dev/null 2>&1 || true
	case "$SCRATCH" in
		/var/folders/*/cc-workflow-e2e.*|/tmp/cc-workflow-e2e.*) rm -rf -- "$SCRATCH" ;;
		*) echo "Refusing to clean unexpected workflow E2E path: $SCRATCH" >&2 ;;
	esac
}
trap cleanup EXIT

if [ -n "${CC_WORKFLOW_E2E_TARBALL:-}" ]; then
	if [ "${CC_WORKFLOW_E2E_TARBALL#/}" = "$CC_WORKFLOW_E2E_TARBALL" ] || [ ! -f "$CC_WORKFLOW_E2E_TARBALL" ]; then
		echo "CC_WORKFLOW_E2E_TARBALL must name an absolute regular tarball" >&2
		exit 1
	fi
	mkdir -p "$SCRATCH/artifact-prefix"
	release_npm install --include=optional --ignore-scripts --no-audit --no-fund --prefix "$SCRATCH/artifact-prefix" "$CC_WORKFLOW_E2E_TARBALL" >/dev/null
	node "$SCRATCH/artifact-prefix/node_modules/cc/scripts/postinstall.mjs" >/dev/null
	CC_LAUNCH="$(printf '%q' "$SCRATCH/artifact-prefix/node_modules/.bin/cc")"
fi

capture() {
	tmux_e2e capture-pane -pt "$SESSION"
}

wait_for_text() {
	local needle="$1"
	local attempts="${2:-900}"
	local attempt
	for ((attempt = 0; attempt < attempts; attempt++)); do
		if capture | grep -Fq "$needle"; then return 0; fi
		sleep 0.1
	done
	echo "Timed out waiting for TUI text: $needle" >&2
	capture >&2
	for event_log in "$SCRATCH"/*-events.jsonl "$SCRATCH"/*/*-events.jsonl; do
		if [ -f "$event_log" ]; then printf 'event log: %s\n' "$event_log" >&2; cat "$event_log" >&2; fi
	done
	exit 1
}

wait_without_text() {
	local needle="$1"
	local stable=0
	for _ in {1..150}; do
		if ! capture | grep -Fq "$needle"; then
			stable=$((stable + 1))
			if [ "$stable" -ge 5 ]; then return 0; fi
		else
			stable=0
		fi
		sleep 0.1
	done
	echo "Timed out waiting for TUI text to disappear: $needle" >&2
	capture >&2
	exit 1
}

send_text() {
	tmux_e2e send-keys -t "$SESSION" -l "$1"
	tmux_e2e send-keys -t "$SESSION" Enter
}

# Live workflow updates redraw the dashboard while a run is still active. Retry
# a navigation key until the destination view is visible so the test exercises
# the resulting TUI state instead of depending on one keypress winning a redraw.
send_key_until_text() {
	local key="$1"
	local needle="$2"
	for _ in {1..90}; do
		if capture | grep -Fq "$needle"; then return 0; fi
		tmux_e2e send-keys -t "$SESSION" "$key"
		sleep 0.1
	done
	echo "Timed out sending $key while waiting for TUI text: $needle" >&2
	capture >&2
	exit 1
}

log_count() {
	local log_file="$1"
	local event="$2"
	if [ ! -f "$log_file" ]; then echo 0; return; fi
	grep -c "\"event\": \"$event\"" "$log_file" || true
}

wait_for_log_count() {
	local log_file="$1"
	local event="$2"
	local expected="$3"
	# The manager deliberately serializes repository mutations. Six worktree
	# setups can therefore span several bounded five-minute operations on a
	# loaded hosted Mac even though no individual Git child is hung.
	for _ in {1..6000}; do
		if [ "$(log_count "$log_file" "$event")" -ge "$expected" ]; then return 0; fi
		sleep 0.1
	done
	echo "Timed out waiting for $expected $event events" >&2
	cat "$log_file" >&2 2>/dev/null || true
	capture >&2
	exit 1
}

stop_session() {
	local prior="$SESSION"
	tmux_e2e send-keys -t "$prior" C-d >/dev/null 2>&1 || true
	for _ in {1..150}; do
		if ! tmux_e2e has-session -t "$prior" >/dev/null 2>&1; then SESSION=""; return 0; fi
		sleep 0.1
	done
	tmux_e2e kill-session -t "$prior" >/dev/null 2>&1 || true
	SESSION=""
	echo "cc workflow E2E session did not exit cleanly" >&2
	exit 1
}

crash_session() {
	local prior="$SESSION"
	local pane_pid
	pane_pid="$(tmux_e2e display-message -pt "$prior" '#{pane_pid}')"
	python3 - "$pane_pid" <<'PY'
import os, signal, subprocess, sys, time
root = int(sys.argv[1])
if root <= 1 or root == os.getpid():
    raise SystemExit(f"unsafe crash-test root pid: {root}")
def snapshot():
    rows = []
    for line in subprocess.check_output(["ps", "-axo", "pid=,ppid=,lstart=,command="], text=True).splitlines():
        fields = line.strip().split(None, 7)
        if len(fields) < 8:
            continue
        pid, ppid = map(int, fields[:2])
        started = " ".join(fields[2:7])
        rows.append((pid, ppid, started, fields[7] if len(fields) > 7 else ""))
    return rows
rows = snapshot()
descendants = []
parents = {root}
changed = True
while changed:
    changed = False
    for pid, ppid, _started, _command in rows:
        if pid not in parents and ppid in parents:
            parents.add(pid)
            descendants.append(pid)
            changed = True
commands = {pid: command for pid, _ppid, _started, command in rows}
identities = {pid: started for pid, _ppid, started, _command in rows}
managers = [pid for pid in [root, *descendants] if (
    "cc-owner:" in commands.get(pid, "") or
    ("node " in commands.get(pid, "") and (
        "src/cc.mjs" in commands.get(pid, "") or "/node_modules/.bin/cc" in commands.get(pid, "")
    ))
)]
if len(managers) != 1:
    raise SystemExit(f"expected one cc manager below tmux pane, found {[(pid, commands.get(pid)) for pid in managers]}")
manager = managers[0]
manager_identity = identities[manager]
def signal_if_same(pid, started, sig):
    current = {row[0]: row[2] for row in snapshot()}
    if current.get(pid) != started:
        return False
    try:
        os.kill(pid, sig)
        return True
    except ProcessLookupError:
        return False
# Freeze the manager first, then converge on and freeze its complete descendant
# tree. No process in that tree can create an unobserved child between the final
# snapshot and the manager-only crash.
if not signal_if_same(manager, manager_identity, signal.SIGSTOP):
    raise SystemExit("cc manager disappeared before the crash fixture could freeze it")
owned = {}
stable = 0
while stable < 3:
    current = snapshot()
    current_identities = {pid: started for pid, _ppid, started, _command in current}
    discovered = {pid: started for pid, started in owned.items() if current_identities.get(pid) == started}
    parents = {manager, *discovered}
    changed = True
    while changed:
        changed = False
        for pid, ppid, started, _command in current:
            if pid != manager and pid not in discovered and ppid in parents:
                discovered[pid] = started
                parents.add(pid)
                changed = True
    new = set(discovered) - set(owned)
    for pid in new:
        signal_if_same(pid, discovered[pid], signal.SIGSTOP)
    if new:
        owned = discovered
        stable = 0
    else:
        stable += 1
    time.sleep(0.05)
if not signal_if_same(manager, manager_identity, signal.SIGKILL):
    raise SystemExit("cc manager identity changed before the crash fixture could kill it")
for pid, started in owned.items():
    signal_if_same(pid, started, signal.SIGCONT)
deadline = time.time() + 10
manager_live = True
while (owned or manager_live) and time.time() < deadline:
    current = snapshot()
    current_identities = {pid: started for pid, _ppid, started, _command in current}
    manager_live = current_identities.get(manager) == manager_identity
    live = {pid: started for pid, started in owned.items() if current_identities.get(pid) == started}
    # Continue following the known ownership tree while supervisors process
    # owner-pipe EOF; this catches descendants created during teardown itself.
    changed = True
    while changed:
        changed = False
        for pid, ppid, started, _command in current:
            if pid not in live and ppid in live:
                live[pid] = started
                changed = True
    owned = live
    if owned or manager_live:
        time.sleep(0.05)
if owned or manager_live:
    latest = {pid: command for pid, _ppid, _started, command in snapshot()}
    details = [(pid, latest.get(pid, commands.get(pid, ""))) for pid in ([manager] if manager_live else []) + list(owned)]
    for pid, started in owned.items():
        signal_if_same(pid, started, signal.SIGKILL)
    raise SystemExit(f"workflow manager or descendants survived manager-only crash: {details}")
PY
	tmux_e2e kill-session -t "$prior" >/dev/null 2>&1 || true
	SESSION=""
}

make_project() {
	local project="$1"
	shift
	mkdir -p "$project/modules"
	local entry
	for entry in "$@"; do
		printf 'independent module %s\n' "$entry" > "$project/modules/$entry.txt"
	done
	git -C "$project" init -q
	git -C "$project" config user.email workflow-e2e@example.invalid
	git -C "$project" config user.name "Workflow E2E"
	git -C "$project" add modules
	git -C "$project" commit -qm "dummy parallel project"
}

write_config() {
	local destination="$1"
	local event_log="$2"
	local delay="$3"
	local gate="${4:-}"
	python3 - "$destination" "$ROOT/tests/fake_acp.py" "$event_log" "$delay" "$gate" <<'PY'
import json, sys
destination, fake, event_log, delay, gate = sys.argv[1:]
agent = {
    "transport": "acp",
    "acp": {"command": "python3", "args": [fake]},
    "env": {
        "FAKE_WORKFLOW_E2E": "1",
        "FAKE_WORKFLOW_E2E_LOG": event_log,
        "FAKE_WORKFLOW_E2E_DELAY": delay,
    },
}
if gate:
    agent["env"]["FAKE_WORKFLOW_E2E_GATE"] = gate
config = {
    "defaultAgent": "cursor",
    "agents": {
        "cursor": {**agent, "label": "Fake Cursor Workflow", "env": {**agent["env"], "FAKE_WORKFLOW_E2E_HARNESS": "cursor"}},
        "codex": {
            **agent,
            "label": "Fake Codex Workflow",
            "env": {
                **agent["env"],
                "FAKE_ACP_AGENT_NAME": "@agentclientprotocol/codex-acp",
                "FAKE_ACP_AGENT_VERSION": "1.1.4",
                "FAKE_ACP_SESSION_ID": "random",
                "FAKE_WORKFLOW_E2E_HARNESS": "codex",
            },
        },
    },
}
with open(destination, "w", encoding="utf-8") as target:
    json.dump(config, target)
PY
}

start_session() {
	local name="$1"
	local project="$2"
	local config="$3"
	local settings="$4"
	local state="$5"
	SESSION="cc-workflow-e2e-$name-$$"
	mkdir -p "$state"
	local command
	printf -v command 'cd %q && env CC_CONFIG=%q CC_SETTINGS=%q CC_PERMISSIONS=%q CC_COMMAND_CACHE=%q CC_BACKGROUND_CONNECT_DELAY_MS=0 %s cursor' \
		"$project" "$config" "$settings" "$state/permissions.json" "$state/commands.json" "$CC_LAUNCH"
	tmux_e2e new-session -d -s "$SESSION" -x 140 -y 45 "$command"
	wait_for_text "Space to record"
}

FOUR_PROJECT="$SCRATCH/four-project"
SIX_PROJECT="$SCRATCH/six-project"
make_project "$FOUR_PROJECT" auth billing catalog search
make_project "$SIX_PROJECT" api cache cli database queue web

if [ "${CC_WORKFLOW_E2E_RECOVERY_ONLY:-0}" != "1" ]; then

# Disabled is a true dormant baseline: no workflow footer and no workflow-owned
# status entry, even though the configured adapter is otherwise workflow-capable.
DISABLED_CONFIG="$SCRATCH/disabled-config.json"
DISABLED_SETTINGS="$SCRATCH/disabled-settings.json"
DISABLED_LOG="$SCRATCH/disabled-events.jsonl"
write_config "$DISABLED_CONFIG" "$DISABLED_LOG" "0.2"
printf '{}\n' > "$DISABLED_SETTINGS"
start_session disabled "$FOUR_PROJECT" "$DISABLED_CONFIG" "$DISABLED_SETTINGS" "$SCRATCH/disabled-state"
wait_for_log_count "$DISABLED_LOG" session_new 1
send_text "/cc-status"
wait_for_text "Fake Cursor Workflow"
if ! capture | grep -Eq "Fake Cursor Workflow .*permissions ask .*theme System"; then
	echo "Disabled status command did not render its expected baseline" >&2
	capture >&2
	exit 1
fi
if capture | grep -E "Fake Cursor Workflow.*workflows" >/dev/null; then
	echo "Disabled workflow policy changed the footer/status" >&2
	capture >&2
	exit 1
fi
stop_session

# Four independent module analyses: Clone Only, effective concurrency two,
# pause with two workers active, resume, completion delivery, and every TUI level.
FOUR_CONFIG="$SCRATCH/four-config.json"
FOUR_SETTINGS="$SCRATCH/four-settings.json"
FOUR_LOG="$SCRATCH/four-events.jsonl"
write_config "$FOUR_CONFIG" "$FOUR_LOG" "2.0"
printf '%s\n' '{"workflowMode":"clone-only","workflowGlobalConcurrency":4,"workflowRunConcurrency":4,"workflowHarnessConcurrency":4,"agents":{"cursor":{"sessionDefaults":{"model":"fast","effort":"high"}}}}' > "$FOUR_SETTINGS"
start_session four "$FOUR_PROJECT" "$FOUR_CONFIG" "$FOUR_SETTINGS" "$SCRATCH/four-state"
wait_for_text "workflows clone only"
send_text "E2E_MODEL_WORKFLOW|four-way-project|modules/auth.txt,modules/billing.txt,modules/catalog.txt,modules/search.txt|clone|2"
wait_for_text "Run workflow"
wait_for_text "four-way-project"
tmux_e2e send-keys -t "$SESSION" Down Down
wait_for_text "›   Review details and source"
tmux_e2e send-keys -t "$SESSION" Enter
wait_for_text "Exact approval identity"
wait_for_text "Source SHA-256"
tmux_e2e send-keys -t "$SESSION" PageDown PageDown
wait_for_text "Exact approved source"
wait_for_text '```js'
tmux_e2e send-keys -t "$SESSION" Escape
wait_for_text "Run workflow"
tmux_e2e send-keys -t "$SESSION" Enter
wait_for_text "workflow launched:"
wait_for_log_count "$FOUR_LOG" worker_start 2
send_text "/workflows"
wait_for_text "cc workflows"
wait_for_text "four-way-project"
wait_for_text "workflows clone only"
tmux_e2e send-keys -t "$SESSION" p
sleep 2.4
if [ "$(log_count "$FOUR_LOG" worker_start)" -ne 2 ]; then
	echo "Paused workflow launched queued workers" >&2
	cat "$FOUR_LOG" >&2
	exit 1
fi
tmux_e2e send-keys -t "$SESSION" Enter
wait_for_text "Analyze"
tmux_e2e send-keys -t "$SESSION" Enter
wait_for_text "Analyze modules/auth.txt"
wait_for_text "Analyze modules/search.txt"
tmux_e2e send-keys -t "$SESSION" Escape
wait_for_text "enter agents"
tmux_e2e send-keys -t "$SESSION" Escape
wait_for_text "enter phases"
tmux_e2e send-keys -t "$SESSION" p
sleep 0.2
tmux_e2e send-keys -t "$SESSION" Escape
wait_without_text "cc workflows"
wait_for_log_count "$FOUR_LOG" worker_end 4
wait_for_text "orchestrator received workflow completion" 6000
send_text "/workflows"
wait_for_text "four-way-project"
tmux_e2e send-keys -t "$SESSION" Enter
tmux_e2e send-keys -t "$SESSION" Enter
tmux_e2e send-keys -t "$SESSION" Enter
wait_for_text "Attempt 1"
tmux_e2e send-keys -t "$SESSION" Enter
wait_for_text "Tool activity"
wait_for_text "Output"
wait_for_text "analysis:modules/auth.txt"
tmux_e2e send-keys -t "$SESSION" v
wait_for_text "Approved source"
wait_for_text "parallel"
tmux_e2e resize-window -t "$SESSION" -x 58 -y 14
wait_for_text "cc workflows"
tmux_e2e resize-window -t "$SESSION" -x 140 -y 45
tmux_e2e send-keys -t "$SESSION" Escape
wait_for_text "Tool activity"
tmux_e2e send-keys -t "$SESSION" Escape
wait_for_text "enter detail"
tmux_e2e send-keys -t "$SESSION" Escape
wait_for_text "enter attempts"
tmux_e2e send-keys -t "$SESSION" Escape
wait_for_text "enter agents"
tmux_e2e send-keys -t "$SESSION" Escape
wait_for_text "enter phases"
tmux_e2e send-keys -t "$SESSION" s
wait_for_text "Save workflow"
tmux_e2e send-keys -t "$SESSION" Enter
for _ in {1..300}; do
	if [ -f "$SCRATCH/workflows/four-way-project.js" ]; then break; fi
	sleep 0.1
done
if [ ! -f "$SCRATCH/workflows/four-way-project.js" ]; then
	echo "Personal workflow save did not create the expected file" >&2
	exit 1
fi
printf '\n// stale overwrite fixture\n' >> "$SCRATCH/workflows/four-way-project.js"
tmux_e2e send-keys -t "$SESSION" s
wait_for_text "Save workflow"
tmux_e2e send-keys -t "$SESSION" Enter
wait_for_text "Overwrite existing personal workflow file four-way-project.js"
tmux_e2e send-keys -t "$SESSION" Enter
for _ in {1..300}; do
	if ! grep -Fq "stale overwrite fixture" "$SCRATCH/workflows/four-way-project.js"; then break; fi
	sleep 0.1
done
if grep -Fq "stale overwrite fixture" "$SCRATCH/workflows/four-way-project.js"; then
	echo "Personal workflow overwrite did not replace the existing file" >&2
	exit 1
fi
wait_for_text "esc close"
tmux_e2e send-keys -t "$SESSION" Escape
wait_without_text "cc workflows"
send_text "E2E_MODEL_WORKFLOW|failed-outcome-project|modules/auth.txt,modules/billing.txt,modules/catalog.txt,modules/missing.txt|clone|2"
wait_for_text "Run workflow"
tmux_e2e send-keys -t "$SESSION" Enter
wait_for_log_count "$FOUR_LOG" worker_start 5
wait_for_log_count "$FOUR_LOG" orchestrator_completion 2
send_text "/workflows"
wait_for_text "failed-outcome-project"
tmux_e2e send-keys -t "$SESSION" d
wait_for_text "Run outcome"
wait_for_text "Error"
tmux_e2e send-keys -t "$SESSION" Escape
wait_for_text "enter phases"
tmux_e2e send-keys -t "$SESSION" Escape
wait_without_text "cc workflows"

# A mutating four-way run retains isolated worktrees. Preview and explicitly
# apply the first agent's patch, then save the generated source at project scope.
edit_starts_before="$(log_count "$FOUR_LOG" worker_start)"
edit_ends_before="$(log_count "$FOUR_LOG" worker_end)"
edit_completions_before="$(log_count "$FOUR_LOG" orchestrator_completion)"
send_text "E2E_MODEL_WORKFLOW_EDIT|edit-way-project|modules/auth.txt,modules/billing.txt,modules/catalog.txt,modules/search.txt|clone|2"
wait_for_text "Run workflow"
tmux_e2e send-keys -t "$SESSION" Enter
wait_for_log_count "$FOUR_LOG" worker_start "$((edit_starts_before + 4))"
wait_for_log_count "$FOUR_LOG" worker_end "$((edit_ends_before + 4))"
wait_for_log_count "$FOUR_LOG" orchestrator_completion "$((edit_completions_before + 1))"
send_text "/workflows"
wait_for_text "edit-way-project"
tmux_e2e send-keys -t "$SESSION" Enter Enter
wait_for_text "Edit modules/auth.txt"
tmux_e2e send-keys -t "$SESSION" a
wait_for_text "Worktree apply preview"
wait_for_text "workflow-applied-change"
tmux_e2e send-keys -t "$SESSION" a
wait_for_text "Apply retained changes"
wait_for_text "modules/auth.txt"
tmux_e2e send-keys -t "$SESSION" Enter
# A confirmed apply is one bounded multi-command worktree operation. Hosted
# macOS can spend well beyond 30 seconds in its supervised Git/process probes.
for _ in {1..6000}; do
	if grep -Fq "workflow-applied-change" "$FOUR_PROJECT/modules/auth.txt"; then break; fi
	sleep 0.1
done
if ! grep -Fq "workflow-applied-change" "$FOUR_PROJECT/modules/auth.txt"; then
	echo "Explicit TUI worktree apply did not update the target project" >&2
	exit 1
fi
for _ in {1..6000}; do
	if grep -R -Fq '"appliedAt"' "$SCRATCH/workflow-state/workflow-runs" 2>/dev/null; then break; fi
	sleep 0.1
done
if ! grep -R -Fq '"appliedAt"' "$SCRATCH/workflow-state/workflow-runs" 2>/dev/null; then
	echo "Applied worktree state was not durably journaled" >&2
	exit 1
fi
tmux_e2e send-keys -t "$SESSION" Escape
wait_for_text "enter agents"
tmux_e2e send-keys -t "$SESSION" Escape
wait_for_text "enter phases"
tmux_e2e send-keys -t "$SESSION" s
wait_for_text "Save workflow"
tmux_e2e send-keys -t "$SESSION" Down
wait_for_text "›   Project"
tmux_e2e send-keys -t "$SESSION" Enter
for _ in {1..300}; do
	if [ -f "$FOUR_PROJECT/.cc/workflows/edit-way-project.js" ]; then break; fi
	sleep 0.1
done
if [ ! -f "$FOUR_PROJECT/.cc/workflows/edit-way-project.js" ]; then
	echo "Project workflow save did not create the expected file" >&2
	exit 1
fi
tmux_e2e send-keys -t "$SESSION" Escape
wait_without_text "cc workflows"

# Stop from the run list while workers are active and require an observable
# stopped outcome rather than merely killing the tmux session.
stop_starts_before="$(log_count "$FOUR_LOG" worker_start)"
stop_completions_before="$(log_count "$FOUR_LOG" orchestrator_completion)"
send_text "E2E_MODEL_WORKFLOW|stop-way-project|modules/auth.txt,modules/billing.txt,modules/catalog.txt,modules/search.txt|clone|2"
wait_for_text "Run workflow"
tmux_e2e send-keys -t "$SESSION" Enter
wait_for_log_count "$FOUR_LOG" worker_start "$((stop_starts_before + 2))"
send_text "/workflows"
wait_for_text "stop-way-project"
tmux_e2e send-keys -t "$SESSION" x
wait_for_log_count "$FOUR_LOG" orchestrator_completion "$((stop_completions_before + 1))"
tmux_e2e send-keys -t "$SESSION" d
wait_for_text "Run outcome"
wait_for_text "stopped"
tmux_e2e send-keys -t "$SESSION" Escape
wait_for_text "enter phases"
tmux_e2e send-keys -t "$SESSION" Escape
wait_without_text "cc workflows"

mode_loads_before="$(log_count "$FOUR_LOG" session_load)"
send_text "/workflow-mode flexible"
sleep 0.2
tmux_e2e send-keys -t "$SESSION" Enter
wait_for_text "workflows flexible"
wait_for_log_count "$FOUR_LOG" session_load "$((mode_loads_before + 1))"
send_text "/workflow-mode clone-only"
sleep 0.2
tmux_e2e send-keys -t "$SESSION" Enter
wait_for_text "workflows clone only"
wait_for_log_count "$FOUR_LOG" session_load "$((mode_loads_before + 2))"
send_text "/workflow-mode disabled"
# The first Enter accepts the slash-command completion; submit the exact
# argument, then confirm only after the destructive picker discloses its count.
sleep 0.2
tmux_e2e send-keys -t "$SESSION" Enter
wait_for_text "Stop 0 active workflows and disable workflows?"
wait_for_text "›   Stop and disable"
tmux_e2e send-keys -t "$SESSION" Enter
wait_for_text "Workflows are disabled"
wait_for_log_count "$FOUR_LOG" session_load "$((mode_loads_before + 3))"
wait_without_text "workflows clone only"
stop_session

# Six-way Flexible run: all six start concurrently, alternating configured
# harness/model/effort pairs, one live agent is restarted, and attempt history
# remains inspectable after exact-origin completion delivery.
SIX_CONFIG="$SCRATCH/six-config.json"
SIX_SETTINGS="$SCRATCH/six-settings.json"
SIX_LOG="$SCRATCH/six-events.jsonl"
SIX_GATE="$SCRATCH/six-workers.gate"
# Worktree setup is deliberately serialized before adapters run. Gate the fake
# turns after worker_start so the overlap assertion proves scheduler concurrency
# independently of subprocess and supervised Git startup speed.
write_config "$SIX_CONFIG" "$SIX_LOG" "1.2" "$SIX_GATE"
printf '%s\n' '{"workflowMode":"flexible","workflowGlobalConcurrency":6,"workflowRunConcurrency":6,"workflowHarnessConcurrency":6,"agents":{"cursor":{"sessionDefaults":{"model":"fast","effort":"high"}}}}' > "$SIX_SETTINGS"
start_session six "$SIX_PROJECT" "$SIX_CONFIG" "$SIX_SETTINGS" "$SCRATCH/six-state"
wait_for_text "workflows flexible"
send_text "E2E_MODEL_WORKFLOW|six-way-project|modules/api.txt,modules/cache.txt,modules/cli.txt,modules/database.txt,modules/queue.txt,modules/web.txt|flexible|6"
wait_for_text "Run workflow"
wait_for_text "six-way-project"
tmux_e2e send-keys -t "$SESSION" Enter
wait_for_text "workflow launched:"
wait_for_log_count "$SIX_LOG" worker_start 6
send_text "/workflows"
wait_for_text "six-way-project"
send_key_until_text Enter "enter agents"
tmux_e2e send-keys -t "$SESSION" Enter
wait_for_text "Analyze modules/api.txt"
wait_for_text "Analyze modules/web.txt"
# Adapter startup is intentionally serialized and can outlast the fake worker's
# delay on slower hosts. Select the last-started worker explicitly so the
# restart assertion never races the first worker completing.
tmux_e2e send-keys -t "$SESSION" Down Down Down Down Down
wait_for_text "› ● Analyze modules/web.txt"
tmux_e2e send-keys -t "$SESSION" r
wait_for_log_count "$SIX_LOG" worker_start 7
touch "$SIX_GATE"
wait_for_log_count "$SIX_LOG" worker_end 6
tmux_e2e send-keys -t "$SESSION" Enter
wait_for_text "Attempt 2"
tmux_e2e send-keys -t "$SESSION" Enter
wait_for_text "Tool activity"
wait_for_text "analysis:modules/web.txt"
tmux_e2e send-keys -t "$SESSION" Escape
wait_for_text "enter detail"
tmux_e2e send-keys -t "$SESSION" Escape
wait_for_text "enter attempts"
tmux_e2e send-keys -t "$SESSION" Escape
wait_for_text "enter agents"
tmux_e2e send-keys -t "$SESSION" Escape
wait_for_text "enter phases"
tmux_e2e send-keys -t "$SESSION" Escape
wait_without_text "cc workflows"
# Completion delivery follows serialized retained-worktree finalization. Keep
# its hosted observation window aligned with the bounded multi-worker setup.
wait_for_text "orchestrator received workflow completion" 6000

python3 - "$FOUR_LOG" "$SIX_LOG" "$DISABLED_LOG" <<'PY'
import json, sys

def records(path):
    with open(path, encoding="utf-8") as source:
        return [json.loads(line) for line in source if line.strip()]

four = records(sys.argv[1])
six = records(sys.argv[2])
disabled_log = records(sys.argv[3])
assert disabled_log and disabled_log[0]["event"] == "session_new"
assert disabled_log[0]["mcp"] == [], "disabled mode must not inject model-facing workflow MCP wiring"
four_task_id = next(entry["result"]["taskId"] for entry in four if entry["event"] == "orchestrator_workflow_started")
four_workers = [entry for entry in four if entry["event"] == "worker_end" and four_task_id in entry["cwd"]]
assert len(four_workers) == 4
assert all(entry["model"] == "fast" and entry["effort"] == "high" for entry in four_workers)
assert all("/workflow-state/workflow-worktrees/" in entry["cwd"] for entry in four_workers)
assert {entry["relative"] for entry in four_workers} == {
    "modules/auth.txt", "modules/billing.txt", "modules/catalog.txt", "modules/search.txt",
}

starts = sorted(entry["time"] for entry in six if entry["event"] == "worker_start")
ends = sorted(entry["time"] for entry in six if entry["event"] == "worker_end")
assert len(starts) >= 7 and len(ends) == 6
assert sum(start < ends[0] for start in starts) >= 6, "six workers did not overlap before the first completed"
six_workers = [entry for entry in six if entry["event"] == "worker_end"]
worker_sessions = [entry for entry in four + six if entry["event"] == "session_new" and entry.get("workflowChild")]
assert len(worker_sessions) >= 10
assert all(entry.get("requestedCwd") == "." for entry in worker_sessions), "workflow ACP sessions must inherit the supervisor-pinned cwd rather than reopen an absolute path"
assert all("/workflow-state/workflow-worktrees/" in entry["cwd"] for entry in six_workers)
expected_files = [
    "modules/api.txt", "modules/cache.txt", "modules/cli.txt",
    "modules/database.txt", "modules/queue.txt", "modules/web.txt",
]
assert {entry["relative"] for entry in six_workers} == set(expected_files)
expected_routes = {
    relative: (("cursor", "fast", "high") if index % 2 == 0 else ("codex", "deep", "low"))
    for index, relative in enumerate(expected_files)
}
actual_routes = {
    entry["relative"]: (entry["harness"], entry["model"], entry["effort"])
    for entry in six_workers
}
assert actual_routes == expected_routes, (actual_routes, expected_routes)
assert any(entry["event"] == "orchestrator_completion" for entry in four)
assert any(entry["event"] == "orchestrator_completion" for entry in six)
policy_loads = [entry for entry in four if entry["event"] == "session_load"]
assert len(policy_loads) >= 3
assert policy_loads[-3]["workflowModes"] == ["flexible"]
assert policy_loads[-2]["workflowModes"] == ["clone-only"]
assert policy_loads[-1]["mcp"] == [] and policy_loads[-1]["workflowModes"] == []
PY

stop_session

fi

# Abrupt process-tree loss leaves an inspectable interrupted journal. A new cc
# process recovers it only after the explicit recovery approval and reruns all
# four model calls; this is the release gate for crash/restart persistence.
RECOVERY_DIR="$SCRATCH/recovery"
mkdir -p "$RECOVERY_DIR"
RECOVERY_CONFIG="$RECOVERY_DIR/config.json"
RECOVERY_SETTINGS="$RECOVERY_DIR/settings.json"
RECOVERY_LOG="$RECOVERY_DIR/events.jsonl"
RECOVERY_GATE="$RECOVERY_DIR/workers.gate"
# Gate every adapter turn after worker_start. The intentional manager crash
# must exercise four live worker trees independently of serialized worktree
# startup speed, then release all four recovered attempts together.
write_config "$RECOVERY_CONFIG" "$RECOVERY_LOG" "1.2" "$RECOVERY_GATE"
printf '%s\n' '{"workflowMode":"clone-only","workflowGlobalConcurrency":4,"workflowRunConcurrency":4,"workflowHarnessConcurrency":4,"agents":{"cursor":{"sessionDefaults":{"model":"fast","effort":"high"}}}}' > "$RECOVERY_SETTINGS"
start_session recovery-crash "$FOUR_PROJECT" "$RECOVERY_CONFIG" "$RECOVERY_SETTINGS" "$RECOVERY_DIR/runtime"
wait_for_log_count "$RECOVERY_LOG" session_new 1
send_text "E2E_MODEL_WORKFLOW|crash-recovery-project|modules/auth.txt,modules/billing.txt,modules/catalog.txt,modules/search.txt|clone|4"
wait_for_text "Run workflow"
tmux_e2e send-keys -t "$SESSION" Enter
wait_for_log_count "$RECOVERY_LOG" worker_start 4
if [ "$(log_count "$RECOVERY_LOG" worker_end)" -ne 0 ]; then
	echo "Crash-recovery workers completed before the manager-only crash" >&2
	cat "$RECOVERY_LOG" >&2
	exit 1
fi
crash_session
start_session recovery-restart "$FOUR_PROJECT" "$RECOVERY_CONFIG" "$RECOVERY_SETTINGS" "$RECOVERY_DIR/runtime-restart"
wait_for_log_count "$RECOVERY_LOG" session_new 6
send_text "/workflows"
wait_for_text "crash-recovery-project"
tmux_e2e send-keys -t "$SESSION" d
wait_for_text "interrupted"
tmux_e2e send-keys -t "$SESSION" Escape
wait_for_text "enter phases"
tmux_e2e send-keys -t "$SESSION" c
wait_for_text "Recovery of"
tmux_e2e send-keys -t "$SESSION" Enter
wait_for_log_count "$RECOVERY_LOG" worker_start 8
touch "$RECOVERY_GATE"
wait_for_log_count "$RECOVERY_LOG" worker_end 4
tmux_e2e send-keys -t "$SESSION" Escape
wait_without_text "cc workflows"
wait_for_text "orchestrator received workflow completion" 6000
stop_session

echo "dynamic workflow E2E: disabled baseline, model-authored MCP launch, 4/6-way execution, routing, lifecycle, save/overwrite, crash/recovery, and TUI passed"
