# cc

A fast, low-latency `cc` CLI for driving **Claude Code**, **Codex**, and **Cursor Agent** (plus Terminus-2 and mini-swe-agent) from one shared terminal UI.

`cc` is a thin wrapper: each agent runs as a backend process and `cc` talks to it over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP). The UI layer is built on Pi's `@mariozechner/pi-tui`, so the editor sits after the rendered conversation and moves naturally as messages stream in. The wrapper owns `/harness` switching, the message queue, voice input, themes, and a set of local commands; everything an agent advertises over ACP is forwarded to that backend.

## Install

One command (requires Node 18+ and `git`):

```sh
npm install -g github:ethanewer/uni-agent-cli
```

The post-install step installs the ACP adapters for Claude and Codex (`@agentclientprotocol/claude-agent-acp` and `@zed-industries/codex-acp`) if they aren't already on your `PATH`. To skip that, set `CC_SKIP_ADAPTER_INSTALL=1`.

Then run:

```sh
cc            # default agent (codex)
cc claude     # Claude Code
cc cursor     # Cursor Agent
cc terminus-2
cc mini-swe-agent
```

Optional backends and integrations:

- **Cursor**: install `cursor-agent` from <https://cursor.com> (it is not an npm package).
- **Voice input**: set `OPENAI_API_KEY` and install `sox` (`rec`) or `ffmpeg`.
- **Image paste**: macOS works out of the box; Linux needs `wl-paste` (Wayland) or `xclip` (X11).
- **Terminus-2 / mini-swe-agent**: create a Python venv next to the CLI and install their deps; point `CC_HARNESS_PYTHON` at it if needed.

If you're developing on a clone instead:

```sh
npm install
npm link
```

## Sending messages while the agent is working

`cc` mirrors Codex's steering model so you never have to wait for a turn to finish:

| Key (while the agent is working) | What it does |
| --- | --- |
| **Enter** (with text) | Queue the message **after the next tool call** — `cc` interrupts at the next tool boundary and sends it. |
| **Tab** (with text) | Queue the message **for after the turn** finishes. |
| **Enter** (autocomplete open) | Accept the autocomplete suggestion (normal editor behavior). |
| **Esc** (an after-tool message is queued) | Stop the agent immediately and send that message now. |
| **Esc** (only after-turn messages queued) | Stop the agent **without sending**; the queued messages drop back into the input box (newline-separated) for editing. |
| **Esc** (nothing queued) | Interrupt the current turn. A second Esc force-settles a stuck cancel. |
| **↑** (empty input) | Pull the last queued message back into the editor. |

Queued messages are shown above the input box (`after tool: …` / `queued: …`). If the backend crashes while messages are queued, they are preserved and re-sent against a fresh connection on your next submit — never silently dropped.

## Switching agents

```text
/harness            # open the switcher
/harness codex      # switch immediately
/harness claude
/harness cursor
/harness exit       # quit
```

The harness you pick with `/harness` is remembered (written to `settings.json` as `defaultAgent`) and becomes the default the next time you launch `cc` with no agent argument. Naming an agent on the command line (`cc claude`) still overrides it for that session.

## Slash commands

Agent-advertised ACP commands appear in autocomplete and are forwarded to that backend (a backend command always takes precedence over a same-named local command, except the reserved UI commands below). `cc` implements these locally for every backend:

- `/new` — start a fresh ACP session and clear the visible thread.
- `/resume` — open the session picker (when the backend supports `session/list`).
- `/model`, `/mode`, `/effort` (aka `/reasoning`, `/thinking`) — open ACP config selectors when the backend advertises them.
- `/plan` — switch to a Plan mode when the backend advertises one.
- `/btw <question>` — ask an **ephemeral side question** in a transient overlay (see below).
- `/diff` — show the working-tree git diff (`git diff HEAD`; pass args like `/diff --staged`).
- `/copy` — copy the last response to the clipboard.
- `/voice` — return the empty input box to voice mode.
- `/theme` — pick a color theme (persisted).
- `/help`, `/status`, `/clear` — handled locally.

### `/btw` — forked side thread (page view)

`/btw` **forks the current conversation** into a side thread. The fork inherits the full prior context **and can use tools** — it's a real branch, not a read-only aside — and the original thread is untouched. `/btw` on its own opens the fork ready for input; `/btw <question>` opens it and asks immediately. Works even while the main agent is mid-turn.

While a fork is open, `cc` switches to a **page view** (Codex-style): one thread fills the screen with its own scroll position, so scrolling is clean and per-thread instead of mixed into the terminal scrollback.

- **Shift+Tab** switches which thread fills the page (a tab bar at the top shows `main` / `btw (fork)`, with the active one marked `›`).
- **PgUp/PgDn**, **Home/End**, and **Up/Down** (when the input is empty) scroll the page; **End** follows the live tail.
- **Esc** cancels the fork's turn, or closes the fork when idle (returning to the normal main view with full scrollback restored). **/copy** copies the focused thread's last answer.

Forking support is per-backend:

- **Claude** uses the native ACP `session/fork` (isolated branch, full context + tools).
- **Codex** has no ACP fork, so `cc` copies the session's rollout file to a new id and `session/load`s the copy — an isolated branch with full history + tools, original untouched (this reads/writes `~/.codex` session files and is sensitive to Codex's on-disk format; if it can't fork it reports why in the pane).
- **Cursor** does not support forking, so `/btw` reports that it's unavailable there.

### Effort levels, ultracode, and workflows (Claude Code)

`cc` is a thin ACP client with no ultracode-specific handling. Claude's `ultracode` effort level is a feature of the interactive `claude` CLI's own main loop — keyword detection, the standing workflow opt-in, and the effort bump all run *above* the Agent SDK. The `claude-agent-acp` backend drives the SDK query loop directly and does not reproduce that layer, so:

- **Typing `ultracode` in a prompt has no special effect** through `cc`. The keyword is forwarded to the backend as plain text, but the app-layer machinery that would normally pick it up never runs over ACP.
- **`/effort` only offers a reasoning level when `claude-agent-acp` advertises one** as an ACP config option. If it doesn't, `cc` reports "Reasoning selection is not advertised by this agent" — and it currently does not advertise an `ultracode` tier.
- When a backend *does* run multi-agent **workflows** or sub-agent fan-out, `cc` renders the nested tool calls and plan updates live, and `Esc` cancels the turn. This is generic ACP rendering, not ultracode-specific.

### Cursor

`cc` natively handles Cursor's ACP extensions: `cursor/ask_question` and `cursor/create_plan` are surfaced as TUI prompts (accept/answer/reject), and `update_todos` / `task` / `generate_image` are rendered inline. Cursor's `agent` / `plan` / `ask` modes map onto `/mode`.

## Voice input

When the input box is empty, press `space` to start recording, then `space` or `enter` to transcribe and send. Press `tab` while recording to transcribe and queue the message after the current turn, or `ctrl+space` to transcribe into the input box for editing. Press `ctrl+space` before recording to switch from voice mode to normal text input. While recording, typing keeps the transcript in the box for editing; `Ctrl+C` or `Esc` cancels the recording without transcribing.

Recording uses `rec` from sox when available, otherwise `ffmpeg`. Transcription uses OpenAI's audio endpoint with `OPENAI_API_KEY`; set `OPENAI_BASE_URL` for a compatible proxy, `CC_TRANSCRIPTION_MODEL` to override the model, and `CC_AUDIO_DEVICE` to select a microphone.

## Permissions

ACP permission requests are shown as TUI selection prompts. `cc` waits for you to approve or reject unless the active agent's native settings imply a bypass/force mode (see Settings), in which case it auto-accepts. `cc` advertises ACP terminal support and implements `terminal/*` so backend commands that need shell execution run inside the shared UI.

## Configuration

Create `~/.config/cc/config.json` to override commands (or point `CC_CONFIG` at another file):

```json
{
  "defaultAgent": "codex",
  "agents": {
    "codex": {
      "command": "codex",
      "args": [],
      "acp": { "command": "codex-acp", "args": [] }
    }
  }
}
```

## Settings

Create `~/.config/cc/settings.json` (or point `CC_SETTINGS` at another file) to apply default native settings per harness and choose a theme:

```json
{
  "theme": "tokyonight",
  "agents": {
    "claude": { "settings": { "permissions": { "defaultMode": "bypassPermissions" }, "model": "sonnet" } },
    "codex":  { "config": { "approval_policy": "never", "sandbox_mode": "danger-full-access", "model": "gpt-5" } },
    "cursor": { "args": ["--force", "--sandbox", "disabled", "--approve-mcps", "--model", "gpt-5"] }
  }
}
```

These mirror each backend as closely as the ACP wrapper allows: Claude uses its `settings.permissions.defaultMode`, Codex uses `-c key=value` config overrides, and Cursor uses command-line args before the `acp` subcommand. When these imply bypass/force mode, `cc` also auto-accepts ACP permission requests the backend still emits. `args` are appended to the backend command (Cursor args are inserted before the `acp` subcommand).

## Development

```sh
npm test
```

This runs syntax/compile checks, the settings/queue unit tests, and the tmux-driven TUI smoke test (resize, scroll-during-streaming, the message queue, slash commands, permissions, and the new `/btw` / `/diff` / `/copy` commands).

## Notes

T3 Code takes a richer web-app approach around provider sessions and uses `codex app-server` for structured Codex integration. `cc` uses the same product model in a smaller terminal form: backend events are normalized into shared UI state, and `/harness` stays in the wrapper input layer instead of being forwarded to an agent. The terminal UI is based on Pi's `@mariozechner/pi-tui` primitives (`TUI`, `Editor`, `Markdown`, autocomplete, differential rendering).
