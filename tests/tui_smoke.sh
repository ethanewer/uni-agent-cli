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

assert_next_line_blank() {
	local needle="$1"
	if ! capture | awk -v needle="$needle" '
		$0 == needle {
			found = 1
			if (getline next_line <= 0) exit 1
			gsub(/[[:space:]]/, "", next_line)
			exit next_line == "" ? 0 : 1
		}
		END { if (!found) exit 1 }
	'; then
		echo "Expected blank line after: $needle" >&2
		capture >&2
		exit 1
	fi
}

assert_next_line_rule() {
	local needle="$1"
	if ! capture | awk -v needle="$needle" '
		$0 == needle {
			found = 1
			if (getline next_line <= 0) exit 1
			gsub(/[[:space:]]/, "", next_line)
			exit next_line ~ /^─+$/ ? 0 : 1
		}
		END { if (!found) exit 1 }
	'; then
		echo "Expected horizontal rule after: $needle" >&2
		capture >&2
		exit 1
	fi
}

tmux new-session -d -s "$SESSION" -x 100 -y 30 "cd $ROOT_Q && CC_CONFIG=tests/fake_config.json CC_BACKGROUND_CONNECT_DELAY_MS=0 ./src/cc fake"

wait_for_text "Space to record"

tmux resize-window -t "$SESSION" -x 74 -y 26
wait_for_text "Space to record"

tmux resize-window -t "$SESSION" -x 110 -y 32
wait_for_text "Space to record"

tmux send-keys -l -t "$SESSION" "$(printf '\033[6;18;9t')"
wait_for_text "Space to record"

tmux send-keys -l -t "$SESSION" "$(printf '\033[13;1:3u')"
wait_for_text "Space to record"

tmux send-keys -l -t "$SESSION" "$(printf '\033[32;2u')"
wait_for_text "Space to record"

tmux send-keys -t "$SESSION" C-Space
wait_without_text "Space to record"

tmux send-keys -t "$SESSION" / t m p / f o o / b a r Enter
wait_for_text "echo: /tmp/foo/bar"
wait_without_text "Unknown command: /tmp"
assert_next_line_rule "/tmp/foo/bar"

tmux send-keys -t "$SESSION" / h a r n e s s x Enter
wait_for_text "Unknown command: /harnessx"

tmux send-keys -t "$SESSION" / c l e a r Enter
wait_without_text "echo: /tmp/foo/bar"
wait_without_text "Unknown command: /harnessx"

tmux send-keys -t "$SESSION" / m o d e l Enter
wait_for_text "Model"
tmux send-keys -t "$SESSION" Down Enter
wait_for_text "/model (Deep)"
wait_without_text "Model:"

tmux send-keys -t "$SESSION" / r e a s o n i n g Enter
wait_for_text "Reasoning"
tmux send-keys -t "$SESSION" Enter
wait_for_text "/reasoning (Low)"
wait_without_text "Reasoning Effort:"

tmux send-keys -t "$SESSION" / m o d e Enter
wait_for_text "Mode"
tmux send-keys -t "$SESSION" Down Enter
wait_for_text "/mode (Plan)"
wait_without_text "Mode:"

tmux send-keys -t "$SESSION" / c l e a r Enter
wait_without_text "/model (Deep)"

tmux send-keys -t "$SESSION" / r e v i e w Enter
wait_for_text "Select a review preset"
wait_for_text "Review against a base branch"
tmux send-keys -t "$SESSION" Down Enter
wait_for_text "/review (Review uncommitted changes)"
wait_for_text "review prompt: /review"

tmux send-keys -t "$SESSION" / c l e a r Enter
wait_without_text "review prompt: /review"

tmux send-keys -t "$SESSION" / r e v i e w Enter
wait_for_text "Select a review preset"
tmux send-keys -t "$SESSION" Enter
wait_for_text "/review-branch"
tmux send-keys -t "$SESSION" m a i n Enter
wait_for_text "/review-branch main (Review against a base branch)"
wait_for_text "review prompt: /review-branch main"

tmux send-keys -t "$SESSION" / c l e a r Enter
wait_without_text "review prompt: /review-branch main"

tmux send-keys -t "$SESSION" / p e r m i s s i o n - t e s t Enter
wait_for_text "Permission: Permission Test"
wait_for_text "Reject"
wait_for_text "Allow"
tmux send-keys -t "$SESSION" Down Enter
wait_for_text '"optionId": "allow"'

tmux send-keys -t "$SESSION" / c l e a r Enter
wait_without_text '"optionId": "allow"'

tmux send-keys -t "$SESSION" / p e r m i s s i o n - o v e r l a p Enter
wait_for_text "Permission: Permission One"
tmux send-keys -t "$SESSION" Down Enter
wait_for_text "Permission: Permission Two"
tmux send-keys -t "$SESSION" Down Enter
wait_for_text '"optionId": "allow-one"'
wait_for_text '"optionId": "allow-two"'

tmux send-keys -t "$SESSION" / c l e a r Enter
wait_without_text '"optionId": "allow-one"'

tmux send-keys -t "$SESSION" s l o w Space t o o l Enter
wait_for_text "Slow Tool"

tmux send-keys -t "$SESSION" q u e u e d - o n e Enter
wait_for_text "queued: queued-one"

tmux send-keys -t "$SESSION" Enter
wait_for_text "after tool: queued-one"
wait_for_text "echo: queued-one"

tmux send-keys -t "$SESSION" / c l e a r Enter
wait_without_text "queued-one"

tmux send-keys -t "$SESSION" s l o w Space t o o l Enter
wait_for_text "✓ Slow Tool"
tmux send-keys -t "$SESSION" l a t e - q u e u e Enter
wait_for_text "queued: late-queue"
wait_for_text "echo: late-queue"

tmux send-keys -t "$SESSION" / c l e a r Enter
wait_without_text "late-queue"

tmux send-keys -t "$SESSION" d e l a y e d Space t o o l Enter
tmux send-keys -t "$SESSION" p r e - t o o l - q u e u e Enter
tmux send-keys -t "$SESSION" Enter
wait_for_text "Slow Tool"
wait_for_text "after tool: pre-tool-queue"
wait_for_text "echo: pre-tool-queue"

tmux send-keys -t "$SESSION" / v o i c e Enter
wait_for_text "Space to record"

tmux send-keys -t "$SESSION" C-Space
tmux send-keys -t "$SESSION" / p e r m i s s i o n - e x i t Enter
wait_for_text "backend exited"
wait_without_text "Permission: Permission Exit"
