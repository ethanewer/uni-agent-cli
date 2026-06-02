#!/usr/bin/env bash
set -euo pipefail

if ! command -v tmux >/dev/null 2>&1; then
	echo "tmux not found; skipping TUI smoke test"
	exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION="cc-tui-smoke-$$"
WRITE_LOG="$(mktemp -t cc-tui-write-log.XXXXXX)"
SETTINGS_FILE="$(mktemp -t cc-tui-settings.XXXXXX)"
CONFIG_SETTINGS_THEME_FILE="$(mktemp -t cc-tui-config-settings-theme.XXXXXX)"
CONFIG_TOP_THEME_FILE="$(mktemp -t cc-tui-config-top-theme.XXXXXX)"
printf '{}\n' > "$SETTINGS_FILE"
ROOT_Q="$(printf "%q" "$ROOT")"
WRITE_LOG_Q="$(printf "%q" "$WRITE_LOG")"
SETTINGS_FILE_Q="$(printf "%q" "$SETTINGS_FILE")"
CONFIG_SETTINGS_THEME_FILE_Q="$(printf "%q" "$CONFIG_SETTINGS_THEME_FILE")"
CONFIG_TOP_THEME_FILE_Q="$(printf "%q" "$CONFIG_TOP_THEME_FILE")"
TERM_PROGRAM_Q="$(printf "%q" "${TERM_PROGRAM:-}")"
VSCODE_PID_Q="$(printf "%q" "${VSCODE_PID:-}")"
VSCODE_INJECTION_Q="$(printf "%q" "${VSCODE_INJECTION:-}")"
PANE_ENV="env -u TERM_PROGRAM -u VSCODE_PID -u VSCODE_INJECTION"
VSCODE_TERMINAL=0
if [ "${TERM_PROGRAM:-}" = "vscode" ] || [ -n "${VSCODE_PID:-}" ] || [ -n "${VSCODE_INJECTION:-}" ]; then
	VSCODE_TERMINAL=1
fi
if [ -n "${TERM_PROGRAM:-}" ]; then
	PANE_ENV="$PANE_ENV TERM_PROGRAM=$TERM_PROGRAM_Q"
fi
if [ -n "${VSCODE_PID:-}" ]; then
	PANE_ENV="$PANE_ENV VSCODE_PID=$VSCODE_PID_Q"
fi
if [ -n "${VSCODE_INJECTION:-}" ]; then
	PANE_ENV="$PANE_ENV VSCODE_INJECTION=$VSCODE_INJECTION_Q"
fi

cleanup() {
	tmux kill-session -t "$SESSION" >/dev/null 2>&1 || true
	rm -f "$WRITE_LOG" "$SETTINGS_FILE" "$CONFIG_SETTINGS_THEME_FILE" "$CONFIG_TOP_THEME_FILE"
}
trap cleanup EXIT

capture() {
	tmux capture-pane -pt "$SESSION"
}

capture_ansi() {
	tmux capture-pane -ept "$SESSION"
}

capture_all() {
	tmux capture-pane -pt "$SESSION" -S -
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

wait_for_write_log_text() {
	local needle="$1"
	for _ in {1..50}; do
		if grep -Fq "$needle" "$WRITE_LOG"; then
			return 0
		fi
		sleep 0.1
	done
	echo "Timed out waiting for write log text: $needle" >&2
	capture >&2
	exit 1
}

wait_for_ansi_text() {
	local needle="$1"
	for _ in {1..50}; do
		if capture_ansi | grep -Fq "$needle"; then
			return 0
		fi
		sleep 0.1
	done
	echo "Timed out waiting for ANSI pane text: $needle" >&2
	capture_ansi >&2
	exit 1
}

assert_no_prepaint_clear() {
	if grep -Fq "$(printf '\0338\033[J\0337')" "$WRITE_LOG"; then
		echo "Expected prepainted frame to be adopted without clear/repaint" >&2
		cat "$WRITE_LOG" >&2
		exit 1
	fi
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

assert_exact_line_count() {
	local needle="$1"
	local expected="$2"
	local actual
	actual="$(capture | awk -v needle="$needle" '$0 == needle { count++ } END { print count + 0 }')"
	if [ "$actual" != "$expected" ]; then
		echo "Expected $expected visible line(s) matching: $needle; got $actual" >&2
		capture >&2
		exit 1
	fi
}

assert_exact_scrollback_count() {
	local needle="$1"
	local expected="$2"
	local actual
	actual="$(capture_all | awk -v needle="$needle" 'index($0, needle) { count++ } END { print count + 0 }')"
	if [ "$actual" != "$expected" ]; then
		echo "Expected $expected scrollback line(s) containing: $needle; got $actual" >&2
		capture_all >&2
		exit 1
	fi
}

assert_no_mouse_tracking_enabled() {
	if grep -Fq "$(printf '\033[?1000h')" "$WRITE_LOG" || grep -Fq "$(printf '\033[?1006h')" "$WRITE_LOG"; then
		echo "TUI enabled mouse tracking, which captures terminal scroll while the agent is running" >&2
		exit 1
	fi
}

tmux new-session -d -s "$SESSION" -x 100 -y 30 "cd $ROOT_Q && printf 'outside-before-cc\n' && $PANE_ENV PI_TUI_WRITE_LOG=$WRITE_LOG_Q CC_CONFIG=tests/fake_config.json CC_SETTINGS=$SETTINGS_FILE_Q CC_BACKGROUND_CONNECT_DELAY_MS=0 FAKE_ACP_NEW_DELAY=0.4 ./src/cc fake"

if [ "$VSCODE_TERMINAL" -eq 0 ]; then
	wait_for_text "outside-before-cc"
fi
wait_for_text "Space to record"

tmux resize-window -t "$SESSION" -x 100 -y 32
if [ "$VSCODE_TERMINAL" -eq 0 ]; then
	wait_for_text "outside-before-cc"
fi
wait_for_text "Space to record"

tmux resize-window -t "$SESSION" -x 74 -y 26
wait_for_text "Space to record"

tmux resize-window -t "$SESSION" -x 110 -y 32
wait_for_text "Space to record"
assert_exact_scrollback_count "Space to record" 1

tmux resize-window -t "$SESSION" -x 74 -y 12
wait_for_text "Space to record"
tmux resize-window -t "$SESSION" -x 110 -y 32
wait_for_text "Space to record"
tmux send-keys -t "$SESSION" / t h e m e Enter
wait_for_text "Palette:"
wait_for_text "Preview:"
wait_for_text "Tokyo Night"
tmux send-keys -t "$SESSION" Down
wait_for_write_log_text "$(printf '\033[38;2;148;163;184mfake acp')"
tmux send-keys -t "$SESSION" q
wait_without_text "Palette:"
tmux send-keys -t "$SESSION" / t h e m e Space m a t r i x Enter
wait_for_text "/theme matrix (Matrix)"
if ! grep -Fq '"theme": "matrix"' "$SETTINGS_FILE"; then
	echo "Expected /theme matrix to persist matrix theme" >&2
	cat "$SETTINGS_FILE" >&2
	exit 1
fi
tmux send-keys -t "$SESSION" / t h e m e Space m i s s i n g Enter
wait_for_text "Unknown theme: missing"
if ! grep -Fq '"theme": "matrix"' "$SETTINGS_FILE"; then
	echo "Unknown theme should not replace persisted matrix theme" >&2
	cat "$SETTINGS_FILE" >&2
	exit 1
fi
tmux send-keys -t "$SESSION" / c l e a r Enter
wait_without_text "Unknown theme: missing"

tmux kill-session -t "$SESSION"
: > "$WRITE_LOG"
tmux new-session -d -s "$SESSION" -x 110 -y 32 "cd $ROOT_Q && printf 'outside-before-cc\n' && $PANE_ENV PI_TUI_WRITE_LOG=$WRITE_LOG_Q CC_CONFIG=tests/fake_config.json CC_SETTINGS=$SETTINGS_FILE_Q CC_BACKGROUND_CONNECT_DELAY_MS=0 FAKE_ACP_NEW_DELAY=0.4 ./src/cc fake"
wait_for_text "fake acp"
wait_for_ansi_text "$(printf '\033[38;2;79;143;92mfake acp')"
assert_no_prepaint_clear
if capture_ansi | grep -Fq "$(printf '\033[2mfake acp')"; then
	echo "Persisted non-system theme should not start with a system-colored prepaint" >&2
	capture_ansi >&2
	exit 1
fi

cat > "$CONFIG_SETTINGS_THEME_FILE" <<'JSON'
{
  "defaultAgent": "fake",
  "agents": {
    "fake": {
      "label": "Fake",
      "transport": "acp",
      "command": "python3",
      "args": ["tests/fake_acp.py"],
      "acp": {
        "command": "python3",
        "args": ["tests/fake_acp.py"]
      }
    }
  },
  "settings": {
    "theme": "tokyonight",
    "agents": {
      "fake": {
        "config": {
          "theme": "matrix"
        }
      }
    }
  }
}
JSON
printf '{}\n' > "$SETTINGS_FILE"
tmux kill-session -t "$SESSION"
: > "$WRITE_LOG"
tmux new-session -d -s "$SESSION" -x 110 -y 32 "cd $ROOT_Q && printf 'outside-before-cc\n' && $PANE_ENV PI_TUI_WRITE_LOG=$WRITE_LOG_Q CC_CONFIG=$CONFIG_SETTINGS_THEME_FILE_Q CC_SETTINGS=$SETTINGS_FILE_Q CC_BACKGROUND_CONNECT_DELAY_MS=0 FAKE_ACP_NEW_DELAY=0.4 ./src/cc fake"
wait_for_text "fake acp"
wait_for_ansi_text "$(printf '\033[38;2;86;95;137mfake acp')"
assert_no_prepaint_clear
if capture_ansi | grep -Fq "$(printf '\033[38;2;79;143;92mfake acp')"; then
	echo "Nested backend theme should not drive shell prepaint" >&2
	capture_ansi >&2
	exit 1
fi

cat > "$CONFIG_TOP_THEME_FILE" <<'JSON'
{
  "defaultAgent": "fake",
  "theme": "matrix",
  "agents": {
    "fake": {
      "label": "Fake",
      "transport": "acp",
      "command": "python3",
      "args": ["tests/fake_acp.py"],
      "acp": {
        "command": "python3",
        "args": ["tests/fake_acp.py"]
      }
    }
  }
}
JSON
printf '{}\n' > "$SETTINGS_FILE"
tmux kill-session -t "$SESSION"
: > "$WRITE_LOG"
tmux new-session -d -s "$SESSION" -x 110 -y 32 "cd $ROOT_Q && printf 'outside-before-cc\n' && $PANE_ENV PI_TUI_WRITE_LOG=$WRITE_LOG_Q CC_CONFIG=$CONFIG_TOP_THEME_FILE_Q CC_SETTINGS=$SETTINGS_FILE_Q CC_BACKGROUND_CONNECT_DELAY_MS=0 FAKE_ACP_NEW_DELAY=0.4 node src/cc.mjs fake"
wait_for_text "fake acp"
wait_for_ansi_text "$(printf '\033[38;2;79;143;92mfake acp')"
assert_no_prepaint_clear

tmux resize-window -t "$SESSION" -x 74 -y 12
tmux send-keys -t "$SESSION" e c h o Enter
sleep 0.1
assert_no_mouse_tracking_enabled
wait_for_text "echo: echo"
tmux send-keys -t "$SESSION" c o n d a
sleep 0.05
tmux send-keys -t "$SESSION" Space a c t i v a t e
sleep 0.05
tmux send-keys -t "$SESSION" Space b a s e Enter
wait_for_text "echo: conda activate base"
tmux send-keys -t "$SESSION" c o n d a Space a c t i v a t e Space b a s e
sleep 0.2
tmux send-keys -t "$SESSION" Enter
wait_for_text "echo: conda activate base"
tmux send-keys -t "$SESSION" e c h o - u s e r - c h u n k Enter
wait_for_text "echo: echo-user-chunk"
tmux resize-window -t "$SESSION" -x 74 -y 28
sleep 0.2
assert_exact_line_count "echo-user-chunk" 1
assert_exact_line_count "-user-chunk" 0
assert_exact_line_count "echo: echo-user-chunk" 1

tmux send-keys -t "$SESSION" / c l e a r Enter
wait_without_text "echo-user-chunk"
wait_without_text "echo: echo"
tmux send-keys -t "$SESSION" / v o i c e Enter
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

tmux send-keys -t "$SESSION" n e w Space s e s s i o n Space p r o b e Enter
wait_for_text "echo: new session probe"
tmux send-keys -t "$SESSION" / n e w Enter
wait_for_text "/new (New session)"
wait_without_text "echo: new session probe"

tmux send-keys -t "$SESSION" / n e w Enter
tmux send-keys -t "$SESSION" q u e u e d Space a f t e r Space n e w Enter
wait_for_text "/new (New session)"
wait_for_text "echo: queued after new"
sleep 0.6
wait_for_text "echo: queued after new"

tmux send-keys -t "$SESSION" / n e w Enter
tmux send-keys -t "$SESSION" / m o d e Space a g e n t Enter
wait_for_text "/mode agent (Agent)"
sleep 0.6
wait_for_text "/mode agent (Agent)"

tmux send-keys -t "$SESSION" s l o w Space t o o l Enter
wait_for_text "Slow Tool"
tmux send-keys -t "$SESSION" / n e w Enter
wait_for_text "/new (New session)"
wait_without_text "Slow Tool"
wait_without_text "slow done"

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
