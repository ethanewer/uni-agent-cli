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
REMEMBER_OFF_SESSION="cc-permission-remember-off-$$"
SETTINGS_FILE="$(mktemp -t cc-perms-settings-XXXXXX.json)"
REMEMBER_OFF_SETTINGS="$(mktemp -t cc-perms-roff-settings-XXXXXX.json)"
printf '{}\n' > "$SETTINGS_FILE"
cp "$ROOT/tests/fake_remember_off_settings.json" "$REMEMBER_OFF_SETTINGS"
PERMS_FILE="$(mktemp -t cc-perms-XXXXXX.json)"
REMEMBER_OFF_PERMS="$(mktemp -t cc-perms-roff-XXXXXX.json)"
COMMAND_CACHE="$(mktemp -t cc-perms-commands-XXXXXX.json)"
rm -f "$PERMS_FILE" "$REMEMBER_OFF_PERMS" "$COMMAND_CACHE"

cleanup() {
	tmux kill-session -t "$PERSIST_SESSION" >/dev/null 2>&1 || true
	tmux kill-session -t "$YOLO_SESSION" >/dev/null 2>&1 || true
	tmux kill-session -t "$REMEMBER_OFF_SESSION" >/dev/null 2>&1 || true
	rm -f "$PERMS_FILE" "$REMEMBER_OFF_PERMS" "$SETTINGS_FILE" "$REMEMBER_OFF_SETTINGS" "$COMMAND_CACHE"
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
	local file="$1" needle="$2"
	sleep 0.5
	if [ -f "$file" ] && grep -Fq "$needle" "$file"; then
		echo "Unexpected grant recorded in $file: $needle" >&2
		cat "$file" >&2
		exit 1
	fi
}

# --- 1. "Allow always" persists a grant -----------------------------------
tmux new-session -d -s "$PERSIST_SESSION" -c "$ROOT" -x 100 -y 30 \
	"env CC_CONFIG=tests/fake_config.json CC_SETTINGS=$SETTINGS_FILE CC_PERMISSIONS=$PERMS_FILE CC_COMMAND_CACHE=$COMMAND_CACHE CC_BACKGROUND_CONNECT_DELAY_MS=0 ./src/cc fake"
wait_for_text "$PERSIST_SESSION" "Space to record"
sleep 0.5
tmux send-keys -t "$PERSIST_SESSION" / p e r m i s s i o n - a l w a y s Enter
wait_for_text "$PERSIST_SESSION" "Permission: Always Test"
# entries: Reject, Allow once, Allow always -> Down Down lands on "Allow always"
tmux send-keys -t "$PERSIST_SESSION" Down Down
wait_for_text "$PERSIST_SESSION" "›   Allow always"
tmux send-keys -t "$PERSIST_SESSION" Enter
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
tmux send-keys -t "$PERSIST_SESSION" Down
wait_for_text "$PERSIST_SESSION" "›   Allow always"
tmux send-keys -t "$PERSIST_SESSION" Enter
# Forwarded as-is (no narrower option exists), and NOT recorded by cc.
wait_for_text "$PERSIST_SESSION" '"optionId": "allow-always"'
assert_without_file_text "$PERMS_FILE" "Only Always Test"

# --- 2. /yolo flips ask-mode to auto-approve ------------------------------
tmux new-session -d -s "$YOLO_SESSION" -c "$ROOT" -x 100 -y 30 \
	"env CC_CONFIG=tests/fake_config.json CC_SETTINGS=$SETTINGS_FILE CC_PERMISSIONS=$PERMS_FILE.unused CC_COMMAND_CACHE=$COMMAND_CACHE CC_BACKGROUND_CONNECT_DELAY_MS=0 ./src/cc fake"
wait_for_text "$YOLO_SESSION" "Space to record"
sleep 0.5
tmux send-keys -t "$YOLO_SESSION" / y o l o Enter
wait_for_text "$YOLO_SESSION" "auto-approve ON"
tmux send-keys -t "$YOLO_SESSION" / p e r m i s s i o n - t e s t Enter
wait_for_text "$YOLO_SESSION" '"optionId": "allow"'
# No dialog should have been shown — /yolo auto-approved it.
assert_without_text "$YOLO_SESSION" "Permission: Permission Test"

# --- 3. remember:false downgrades an "always" pick and records nothing -----
tmux new-session -d -s "$REMEMBER_OFF_SESSION" -c "$ROOT" -x 100 -y 30 \
	"env CC_CONFIG=tests/fake_config.json CC_SETTINGS=$REMEMBER_OFF_SETTINGS CC_PERMISSIONS=$REMEMBER_OFF_PERMS CC_COMMAND_CACHE=$COMMAND_CACHE CC_BACKGROUND_CONNECT_DELAY_MS=0 ./src/cc fake"
wait_for_text "$REMEMBER_OFF_SESSION" "Space to record"
sleep 0.5
tmux send-keys -t "$REMEMBER_OFF_SESSION" / p e r m i s s i o n - a l w a y s Enter
wait_for_text "$REMEMBER_OFF_SESSION" "Permission: Always Test"
# Pick "Allow always" with remember:false -> backend gets the one-time option and
# cc records NOTHING (persistence disabled).
tmux send-keys -t "$REMEMBER_OFF_SESSION" Down Down
wait_for_text "$REMEMBER_OFF_SESSION" "›   Allow always"
tmux send-keys -t "$REMEMBER_OFF_SESSION" Enter
wait_for_text "$REMEMBER_OFF_SESSION" '"optionId": "allow-once"'
assert_without_text "$REMEMBER_OFF_SESSION" '"optionId": "allow-always"'
assert_without_file_text "$REMEMBER_OFF_PERMS" "Always Test"

echo "permission persistence + /yolo smoke test passed"
