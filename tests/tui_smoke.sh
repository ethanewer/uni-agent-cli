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

tmux new-session -d -s "$SESSION" -x 100 -y 30 "cd $ROOT_Q && HARNESS_CONFIG=tests/fake_config.json CC_BACKGROUND_CONNECT_DELAY_MS=0 ./src/cc fake"

wait_for_text "voice: space record"

tmux resize-window -t "$SESSION" -x 74 -y 26
wait_for_text "voice: space record"

tmux resize-window -t "$SESSION" -x 110 -y 32
wait_for_text "voice: space record"

tmux send-keys -l -t "$SESSION" "$(printf '\033[6;18;9t')"
wait_for_text "voice: space record"

tmux send-keys -l -t "$SESSION" "$(printf '\033[13;1:3u')"
wait_for_text "voice: space record"

tmux send-keys -l -t "$SESSION" "$(printf '\033[32;2u')"
wait_for_text "voice: space record"

tmux send-keys -t "$SESSION" C-Space
wait_without_text "voice: space record"

tmux send-keys -t "$SESSION" s l o w Space t o o l Enter
wait_for_text "Slow Tool"

tmux send-keys -t "$SESSION" q u e u e d - o n e Enter
wait_for_text "queued: queued-one"

tmux send-keys -t "$SESSION" Enter
wait_for_text "after tool: queued-one"
wait_for_text "echo: queued-one"

tmux send-keys -t "$SESSION" d e l a y e d Space t o o l Enter
tmux send-keys -t "$SESSION" p r e - t o o l - q u e u e Enter
tmux send-keys -t "$SESSION" Enter
wait_for_text "Slow Tool"
wait_for_text "after tool: pre-tool-queue"
wait_for_text "echo: pre-tool-queue"

tmux send-keys -t "$SESSION" / v o i c e Enter
wait_for_text "voice: space record"
