#!/usr/bin/env bash
set -euo pipefail

if ! command -v tmux >/dev/null 2>&1; then
	echo "tmux not found; skipping permission auto-approval smoke test"
	exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASELINE_SESSION="cc-permission-baseline-$$"
DANGER_SESSION="cc-permission-danger-$$"

cleanup() {
	tmux kill-session -t "$BASELINE_SESSION" >/dev/null 2>&1 || true
	tmux kill-session -t "$DANGER_SESSION" >/dev/null 2>&1 || true
}
trap cleanup EXIT

capture() {
	tmux capture-pane -pt "$1"
}

wait_for_text() {
	local session="$1"
	local needle="$2"
	for _ in {1..50}; do
		if capture "$session" | grep -Fq "$needle"; then
			return 0
		fi
		sleep 0.1
	done
	echo "Timed out waiting for: $needle" >&2
	capture "$session" >&2
	exit 1
}

assert_without_text() {
	local session="$1"
	local needle="$2"
	if capture "$session" | grep -Fq "$needle"; then
		echo "Unexpected text found: $needle" >&2
		capture "$session" >&2
		exit 1
	fi
}

tmux new-session -d -s "$BASELINE_SESSION" -c "$ROOT" -x 100 -y 30 \
	"env CC_CONFIG=tests/fake_config.json CC_BACKGROUND_CONNECT_DELAY_MS=0 ./src/cc fake"
wait_for_text "$BASELINE_SESSION" "Space to record"
sleep 0.5
tmux send-keys -t "$BASELINE_SESSION" / p e r m i s s i o n - t e s t Enter
wait_for_text "$BASELINE_SESSION" "Permission: Permission Test"

tmux new-session -d -s "$DANGER_SESSION" -c "$ROOT" -x 100 -y 30 \
	"env CC_CONFIG=tests/fake_config.json CC_SETTINGS=tests/fake_danger_settings.json CC_BACKGROUND_CONNECT_DELAY_MS=0 ./src/cc cursor"
wait_for_text "$DANGER_SESSION" "Space to record"
sleep 0.5
tmux send-keys -t "$DANGER_SESSION" / p e r m i s s i o n - t e s t Enter
wait_for_text "$DANGER_SESSION" '"optionId": "allow"'
assert_without_text "$DANGER_SESSION" "Permission: Permission Test"
