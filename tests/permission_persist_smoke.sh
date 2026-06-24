#!/usr/bin/env bash
# Exercises the two new permission flows end-to-end through the real TUI:
#   1. "Allow always" persists a grant to the cc-side store (CC_PERMISSIONS).
#   2. The /yolo runtime toggle flips an ask-mode harness to auto-approve.
set -euo pipefail

if ! command -v tmux >/dev/null 2>&1; then
	echo "tmux not found; skipping permission persistence smoke test"
	exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PERSIST_SESSION="cc-permission-persist-$$"
YOLO_SESSION="cc-permission-yolo-$$"
PERMS_FILE="$(mktemp -t cc-perms-XXXXXX.json)"
rm -f "$PERMS_FILE"

cleanup() {
	tmux kill-session -t "$PERSIST_SESSION" >/dev/null 2>&1 || true
	tmux kill-session -t "$YOLO_SESSION" >/dev/null 2>&1 || true
	rm -f "$PERMS_FILE"
}
trap cleanup EXIT

capture() { tmux capture-pane -pt "$1"; }

wait_for_text() {
	local session="$1" needle="$2"
	for _ in {1..50}; do
		if capture "$session" | grep -Fq "$needle"; then return 0; fi
		sleep 0.1
	done
	echo "Timed out waiting for: $needle" >&2
	capture "$session" >&2
	exit 1
}

wait_for_file_text() {
	local needle="$1"
	for _ in {1..50}; do
		if [ -f "$PERMS_FILE" ] && grep -Fq "$needle" "$PERMS_FILE"; then return 0; fi
		sleep 0.1
	done
	echo "Timed out waiting for grant store to contain: $needle" >&2
	[ -f "$PERMS_FILE" ] && cat "$PERMS_FILE" >&2 || echo "(no store file written)" >&2
	exit 1
}

assert_without_text() {
	local session="$1" needle="$2"
	if capture "$session" | grep -Fq "$needle"; then
		echo "Unexpected text found: $needle" >&2
		capture "$session" >&2
		exit 1
	fi
}

# Give any pending best-effort store write a beat, then assert it never landed.
assert_without_file_text() {
	local needle="$1"
	sleep 0.5
	if [ -f "$PERMS_FILE" ] && grep -Fq "$needle" "$PERMS_FILE"; then
		echo "Unexpected grant recorded: $needle" >&2
		cat "$PERMS_FILE" >&2
		exit 1
	fi
}

# --- 1. "Allow always" persists a grant -----------------------------------
tmux new-session -d -s "$PERSIST_SESSION" -c "$ROOT" -x 100 -y 30 \
	"env CC_CONFIG=tests/fake_config.json CC_PERMISSIONS=$PERMS_FILE CC_BACKGROUND_CONNECT_DELAY_MS=0 ./src/cc fake"
wait_for_text "$PERSIST_SESSION" "Space to record"
sleep 0.5
tmux send-keys -t "$PERSIST_SESSION" / p e r m i s s i o n - a l w a y s Enter
wait_for_text "$PERSIST_SESSION" "Permission: Always Test"
# entries: Reject, Allow once, Allow always -> Down Down lands on "Allow always"
tmux send-keys -t "$PERSIST_SESSION" Down Down Enter
# cc OWNS the "always": it records its own grant but replies to the backend with the
# narrowest allow (allow-once), NOT allow-always — so the backend doesn't also
# persist it and /permissions clear can fully revoke.
wait_for_text "$PERSIST_SESSION" '"optionId": "allow-once"'
assert_without_text "$PERSIST_SESSION" '"optionId": "allow-always"'
# The cc-side store records the grant, keyed on the tool title.
wait_for_file_text "Always Test"

# When the backend offers ONLY a persistent allow (no allow-once), cc cannot own
# the "always": it forwards the persistent option (honoring the pick) but must NOT
# record a cc grant it couldn't revoke.
tmux send-keys -t "$PERSIST_SESSION" / p e r m i s s i o n - o n l y - a l w a y s Enter
wait_for_text "$PERSIST_SESSION" "Permission: Only Always Test"
# entries: Reject, Allow always -> Down lands on "Allow always"
tmux send-keys -t "$PERSIST_SESSION" Down Enter
# Forwarded as-is (no narrower option exists), and NOT recorded by cc.
wait_for_text "$PERSIST_SESSION" '"optionId": "allow-always"'
assert_without_file_text "Only Always Test"

# --- 2. /yolo flips ask-mode to auto-approve ------------------------------
tmux new-session -d -s "$YOLO_SESSION" -c "$ROOT" -x 100 -y 30 \
	"env CC_CONFIG=tests/fake_config.json CC_PERMISSIONS=$PERMS_FILE.unused CC_BACKGROUND_CONNECT_DELAY_MS=0 ./src/cc fake"
wait_for_text "$YOLO_SESSION" "Space to record"
sleep 0.5
tmux send-keys -t "$YOLO_SESSION" / y o l o Enter
wait_for_text "$YOLO_SESSION" "auto-approve ON"
tmux send-keys -t "$YOLO_SESSION" / p e r m i s s i o n - t e s t Enter
wait_for_text "$YOLO_SESSION" '"optionId": "allow"'
# No dialog should have been shown — /yolo auto-approved it.
assert_without_text "$YOLO_SESSION" "Permission: Permission Test"

echo "permission persistence + /yolo smoke test passed"
