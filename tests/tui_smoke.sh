#!/usr/bin/env bash
set -euo pipefail

if ! command -v tmux >/dev/null 2>&1; then
	echo "tmux not found; skipping TUI smoke test"
	exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION="cc-tui-smoke-$$"
ROOT_Q="$(printf "%q" "$ROOT")"

cleanup() {
	tmux kill-session -t "$SESSION" >/dev/null 2>&1 || true
}
trap cleanup EXIT

capture() {
	tmux capture-pane -pt "$SESSION"
}

wait_for_text() {
	local needle="$1"
	for _ in {1..50}; do
		if capture | grep -Fq "$needle"; then
			return 0
		fi
		sleep 0.1
	done
	echo "Timed out waiting for: $needle" >&2
	capture >&2
	exit 1
}

wait_without_text() {
	local needle="$1"
	for _ in {1..50}; do
		if ! capture | grep -Fq "$needle"; then
			return 0
		fi
		sleep 0.1
	done
	echo "Timed out waiting for text to disappear: $needle" >&2
	capture >&2
	exit 1
}

tmux new-session -d -s "$SESSION" -x 100 -y 30 "cd $ROOT_Q && HARNESS_CONFIG=tests/fake_config.json node src/pi-harness.mjs fake"

wait_for_text "voice: space record"

tmux send-keys -l -t "$SESSION" "$(printf '\033[6;18;9t')"
wait_for_text "voice: space record"

tmux send-keys -l -t "$SESSION" "$(printf '\033[13;1:3u')"
wait_for_text "voice: space record"

tmux send-keys -l -t "$SESSION" "$(printf '\033[32;2u')"
wait_for_text "voice: space record"

tmux send-keys -t "$SESSION" C-Space
wait_without_text "voice: space record"

tmux send-keys -t "$SESSION" / v o i c e Enter
wait_for_text "voice: space record"
