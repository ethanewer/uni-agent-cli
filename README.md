# cc

A fast, low-latency `cc` CLI for driving **Claude Code**, **Codex**, and **Cursor Agent** (plus Terminus-2 and mini-swe-agent) from one shared terminal UI.

`cc` is a thin wrapper: each agent runs as a backend process and `cc` talks to it over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP). The UI layer is built on Pi's `@mariozechner/pi-tui`, so the editor sits after the rendered conversation and moves naturally as messages stream in. The wrapper owns `/harness` switching, the message queue, voice input, themes, and a set of local commands; everything an agent advertises over ACP is forwarded to that backend.

## Install

One command (requires Node 22+ and `git`):

```sh
npm install -g github:ethanewer/uni-agent-cli
```

`cc` carries its ACP adapters as exact runtime dependencies: `@agentclientprotocol/claude-agent-acp` 0.58.1 and `@agentclientprotocol/codex-acp` 1.1.2. The built-in Claude and Codex harnesses launch those package-local copies, so an unrelated global adapter on `PATH` cannot silently change the protocol. A custom `agents.<name>.acp.command` remains an explicit override and must identify itself as the expected adapter at startup. Post-install only verifies those local dependencies; it never installs, removes, or migrates global adapter packages.

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

### Stable `cc` and beta `cc2` channels

For side-by-side testing, install commit snapshots instead of using `npm link`:

```sh
npm run install:channels
```

This resolves `cc` from the local `main` ref and `cc2` from the local
`ux-0711` ref. Rerun the command after either local ref moves. (`git fetch`
alone updates `origin/main`, not the local `main` ref.) A specific commit,
remote-tracking ref, or branch can be selected for one channel with, for
example:

```sh
node scripts/install-channel.mjs beta --ref HEAD
node scripts/install-channel.mjs stable --ref origin/main
```

The installer archives the selected commit, so uncommitted working-tree changes
are never included. It builds and smoke-tests the complete release before an
atomic channel switch. Releases and their private `node_modules`/ACP adapters
live under `~/.local/share/cc/channels/<channel>/releases/<commit>`; the launchers
are `~/.local/bin/cc` and `~/.local/bin/cc2`. Add `~/.local/bin` to `PATH` if it
is not already there. On Windows the launchers use the corresponding `cc.cmd`
and `cc2.cmd` names. The installer never runs `npm link` or changes npm's
global prefix.

Stable `cc` continues to use the normal `~/.config/cc` state. Beta `cc2` keeps
its config, settings, permission grants, fork registry, and autocomplete cache
under `~/.local/share/cc/channels/beta/state`, so beta experiments cannot alter
stable wrapper state. Backend-owned Claude and Codex session stores remain
shared.

Each successful update records the old release as `previous`. Roll back without
reinstalling dependencies:

```sh
node scripts/install-channel.mjs beta --rollback
```

Use `--root` and `--bin-dir` (or `CC_INSTALL_ROOT` and `CC_BIN_DIR`) to override
the default locations.

## Sending messages while the agent is working

`cc` mirrors Codex's steering model so you never have to wait for a turn to finish:

While composing, **Return** submits and **Shift+Return** inserts a newline. On macOS,
**Option+Return** is also supported for newlines (**Alt+Enter** on other platforms),
including the CSI-u and modifyOtherKeys encodings used by modern terminals and tmux.

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

## Custom keybindings

Run `/keybindings` to create and open `~/.config/cc/keybindings.json`. The file
uses Claude Code's `bindings` array, context names, keystroke aliases, and
`key -> action` layout. cc watches the file and applies valid changes without a
restart; `/keybindings reload` reloads it explicitly and `/keybindings show`
lists the active custom bindings and validation warnings. Set `CC_KEYBINDINGS`
to move the file. When `CC_SETTINGS` points at an isolated settings directory
(as it does for `cc2`), keybindings live beside that settings file automatically.

```json
{
  "$schema": "https://www.schemastore.org/claude-code-keybindings.json",
  "$docs": "https://code.claude.com/docs/en/keybindings",
  "bindings": [
    {
      "context": "Chat",
      "bindings": {
        "enter": "chat:newline",
        "ctrl+enter": "chat:submit"
      }
    }
  ]
}
```

The harness-neutral input layer supports Claude-compatible `Global` actions for
interrupt, exit, redraw, and `app:toggleTodos`; `Chat` actions for cancel and input-preserving redraw,
stopping running agents, cycling advertised modes, opening the model picker,
submit, newline, undo, image paste, fast-mode toggle, and voice push-to-talk;
all `Autocomplete` and generic `Select` actions;
`Confirmation` yes/no/previous/next/toggle; and `Task` backgrounding. Two-key
chords such as `ctrl+x ctrl+k` are supported and keep their prefix reserved while
cc waits for the second key. A mismatched or timed-out chord never leaks its
prefix into the editor.

cc does not pretend to support a Claude action when the shared TUI has no
equivalent surface. For example, Claude's transcript toggles, external
editor and prompt stash, clear-screen/double-clear behavior, permission-explanation controls, and fullscreen-only
panels produce a clear validation warning. Ctrl+C, Ctrl+D, and Ctrl+M remain
reserved. Ctrl+B, Ctrl+A, and Ctrl+Z bindings report their tmux, GNU screen, or
terminal conflict without preventing startup. The built-in defaults include
Shift+Enter and Option/Alt+Enter for newlines, Claude's safe Ctrl+X task chords,
Ctrl+T checklist toggle, and Ctrl+B task backgrounding outside tmux. Default plain Space starts voice
only in cc's empty voice composer; it remains a normal space while typing.
Shift+Tab cycles advertised modes unless a `/btw` pane is open, where it keeps
cc's existing pane-focus behavior.

## Local shell mode

Start a composer entry with `!` to run it in your local shell, for example
`!git status`. cc captures bounded stdout/stderr, strips terminal-control
sequences, records the result in the transcript, and asks the active agent to
respond to it. File and directory arguments complete live while you type; when
there is no matching path, autocomplete offers recent prefix-matching commands
from a bounded, read-only view of your shell history and the current cc run.
cc never writes, persists, or forwards that command history to a harness. The
process runs in cc's current working directory and is stopped with the rest of
cc during shutdown.

Set `"respondToBashCommands": false` in cc's `settings.json` to retain the
command result as context without starting a model turn. Context-only insertion
is capability-gated; a harness that cannot append context reports that clearly
instead of silently dropping the result.

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

Agent-advertised ACP commands appear in autocomplete and are forwarded to that backend (a backend command always takes precedence over a same-named local command, except the reserved UI commands below). This keeps Codex commands such as `/review`, `/compact`, and `/skills` available without `cc` needing to duplicate them. Bare `/mcp` and `/mcp verbose` likewise stay on the live ACP session; only the explicit management subcommands documented below are handled locally. `cc` also provides these commands:

Autocomplete does not wait for the ACP process on every launch. `cc` seeds an identity-and-version-gated snapshot of first-party commands from its pinned Claude and Codex adapters, then privately caches each harness's last advertised command list for the current working directory. Cached entries are display hints only: live ACP advertisements replace them, including with an empty list, and command routing never treats a cached name as local or authoritative. Dynamic project, plugin, account, and skill commands become immediate after their first discovery in that directory. The bounded cache is stored in the platform cache directory (`~/Library/Caches/cc/commands.json` on macOS), expires after 30 days, and can be disabled with `CC_DISABLE_COMMAND_CACHE=1` or relocated with `CC_COMMAND_CACHE`.

The TUI and cached autocomplete remain usable while the ACP backend warms in the
background. The footer shows a live connection state instead of looking idle.
If a command such as `/resume` needs the still-starting backend, cc joins that
single startup and shows the command's progress continuously through its picker.
Typing remains responsive, but a second Enter preserves the draft in the
composer rather than starting a conflicting action. Press Ctrl+C to cancel the
pending UI action; already-started background work may safely finish without
reopening the interaction.

- `/new`, `/clear` — start a fresh ACP session and clear the visible thread.
- `/resume` — open the session picker (when the backend supports `session/list`).
- `/model`, `/mode`, `/effort` (aka `/reasoning`, `/thinking`) — open ACP config selectors when the backend advertises them.
- `/config [option [value]]` — inspect or change any session option advertised by the backend, including options that do not have a dedicated command.
- `/fast [on|off]` — toggle the advertised fast-mode option for the selected model. Bare `/fast` toggles immediately.
- `/plan [prompt]` — switch to an advertised Plan mode, then optionally submit the inline request. The current Codex ACP adapter does not expose native collaboration mode, so `cc` clearly labels and uses a read-only, prompt-based planning fallback instead.
- `/permissions [read-only|auto|full-access|show|clear]` — select Codex's advertised sandbox/approval preset while keeping `cc`'s host-side permission gate synchronized, or inspect/clear remembered grants.
- `/status` — use the backend's richer status command when it advertises one; otherwise show the local session summary.
- `/cc-status` — always show the `cc`/ACP summary (agent, model, backend mode, cc's resolved `ask`/`auto`/`deny` permission policy, reasoning, fast mode, Remote Control state, context usage, theme, and session id when available). The same resolved permission policy is always visible in the footer, with `⏸` marking manual `ask` mode; an active, disconnected, or failed Remote Control state is shown there without putting its URL in the persistent line.
- `/delete [session-id|name]` — permanently delete the current or supplied session after confirmation. Names are resolved for Codex and ACP backends that advertise `session/list`; other backends require a session id. Codex deletion also removes descendant sessions, and duplicate Codex names must be disambiguated with a UUID.
- `/login [method]`, `/logout` — run the active backend's advertised ACP authentication flow without leaving `cc`. Choosing Codex's ChatGPT method may let `codex-acp` open the sign-in page directly; URL confirmation prompts in `cc` are used for MCP authorization requests.
- `/btw <question>` (also `/side`) — ask an **ephemeral side question** in a transient overlay (see below).
- `/diff` — show tracked and untracked working-tree changes; pass explicit git arguments such as `/diff --staged` when needed.
- `/copy [N|picker]` — copy the focused thread's Nth-latest assistant response. Plain responses copy immediately; responses with fenced code open a picker with the full response first and each code block after it. Press **Enter** to copy, or **w** with an empty filter to choose a file; existing files are replaced only after confirmation. Choosing **Always copy full response** stores a cc-only preference and skips future pickers; `/copy picker` disables that preference.
- `/color [red|blue|green|yellow|purple|orange|pink|cyan|default]` — recolor the editor border for this `cc` session. With no argument, `/color` chooses a random palette color. This remains host-local: the pinned Claude Agent SDK 0.3.205 declares an internal `set_color` control message but exposes no supported `Query.setColor()` mutation, so cc does not call the SDK's private request API to imitate Remote Control accent synchronization.
- `/cd <path>` — move a capable live session and cc itself to another working directory without rebuilding context; trust and permission rules remain backend-enforced.
- `/branch [name]` — fork the active main conversation and continue on the new branch while leaving the source resumable. A name is applied only when the harness advertises named forks; close `/btw` first.
- `/tasks [stop <task-id>|background [tool-use-id]]` — list a capable harness's live foreground/background tasks, stop one by id, or move blocking work into the background. Claude task lifecycle events are normalized and bounded by its per-harness bridge; raw SDK frames never enter the shared TUI.
- `/todos` — open the focused main or `/btw` session's live checklist. Standard ACP plan updates, Claude TodoWrite/Task snapshots, and Cursor todo snapshots are normalized into the same bounded state. Press **Ctrl+T** to toggle this surface without adding a transcript message. This is separate from `/tasks`, which controls running background work.
- `/rewind` (also `/checkpoint` and `/undo`) — choose an earlier user message, then restore **code and conversation**, **conversation only**, or **code only** when the harness advertises checkpoints. Immediately after `/clear`, the picker also offers `/resume <id> (previous session)` until another resume commits or cc exits. All three names are reserved locally and report unsupported capability instead of being forwarded with backend-specific semantics. The built-in Claude bridge enables Agent SDK file checkpointing; conversation rewind creates and atomically loads a new branch, leaving the original session resumable. Claude Code's **Summarize from here** and **Summarize up to here** choices are not shown because the pinned public Agent SDK has no safe summarization-at-checkpoint control; `cc` does not imitate them with a prompt.
- `/remote-control [name|off]` (also `/rc`) — make the existing main session available at a validated `claude.ai/code` URL through the built-in Claude bridge, optionally give it a name, or disconnect it with `off`. This calls the pinned public Agent SDK's existing-session control; it does not start Claude's separate server mode and accepts no server flags. The normalized state belongs to the exact adapter connection and session: switching sessions updates the indicator, and switching harnesses cannot retain or expose the previous harness's URL. The local `cc` process must remain running. Availability still depends on Claude's account, organization, region, and authentication requirements; [Claude's Remote Control documentation](https://code.claude.com/docs/en/remote-control) says API-key authentication is unsupported.
- `/voice` — return the empty input box to voice mode.
- `/theme` — pick a color theme (persisted).
- `/init` — ask the agent to create or improve the repository's `AGENTS.md` guidance.
- `/help` — show every currently available local and backend command.
- `/exit`, `/quit` — close `cc`.

The following commands expose Codex CLI features that are not carried by ACP itself:

- `/fork [last-turn-id]` — create a durable native Codex fork of the active main session, optionally ending at the supplied turn UUID, then switch the main pane to it with full ACP history replay. The source remains unchanged. This command is intentionally unavailable inside `/btw`.
- `/archive [session-id|name]` and `/unarchive <session-id|name>` — archive or restore Codex sessions.
- `/plugins` — browse installed and discoverable plugins; `/plugins install <plugin[@marketplace]>` and `/plugins remove <plugin[@marketplace]>` are the direct forms. `/plugins refresh` upgrades configured Git marketplace snapshots before reopening the browser. Manage sources with `/plugins marketplace list`, `/plugins marketplace add <source> [--ref <ref>] [--sparse <path>]`, `/plugins marketplace upgrade [name]`, and `/plugins marketplace remove <name>`. Start a new session after changing plugins so their skills and tools refresh.
- `/hooks` — inspect the current working directory's lifecycle hooks, including event, handler type, source, enabled state, trust state, and configuration diagnostics. This view is read-only because the public app-server API has no hook mutation method; use the native Codex CLI to enable or trust hooks.
- `/app` — open the active main or `/btw` thread in Codex Desktop on macOS or Windows. The handoff uses a validated `codex://threads/<uuid>` deep link and is hidden on unsupported platforms.
- `/apps [refresh]` — browse account-available Codex apps (connectors) and insert a ready app's structured `[$app-slug](app://id)` mention into the main or `/btw` composer. Disabled and inaccessible apps remain visible with their status; `refresh` bypasses the app cache.
- `/feedback [bug|bad-result|good-result|safety-check|other] [note]` — send Codex product feedback. Before every upload, `cc` asks whether to attach logs; **Send without logs** is the first/default choice. Including logs is explicit per report and may attach Codex logs, transcripts, and diagnostics. Notes are never echoed into the conversation or error messages.
- `/import` — detect Claude Code configuration and artifacts in the home directory and current repository, then import either one detected group or everything after confirmation. `cc` keeps the app-server alive until Codex reports background import completion and summarizes per-item failures. Start a new session afterward to load imported skills, plugins, hooks, and MCP servers.
- `/memories [status|enable|on|off|use on|off|generate on|off|reset]` — inspect and control Codex memories, including the current task's generation mode. For a mutation, `cc` stops the live ACP owner, updates cold task metadata and global configuration, then resumes the same thread; close `/btw` first so no side process keeps stale memory state. Reset requires confirmation.
- `/debug-config` — show the Codex config-layer stack and managed requirements. Layer contents and effective values are deliberately omitted so API keys and MCP credentials cannot be printed.
- `/mcp list`, `/mcp get <name>`, `/mcp add <name> [--env KEY=VALUE] (--url <url> | -- <command>...)`, `/mcp remove <name>`, `/mcp login <name> [--scopes <scope,...>]`, and `/mcp logout <name>` — manage Codex's persisted MCP server configuration. URL servers also accept the native `--bearer-token-env-var`, `--oauth-client-id`, and `--oauth-resource` options. Removal and logout require confirmation, rendered configuration redacts environment/header/secret values, and changes take effect in `cc` after `/new`.
- `/doctor` — run Codex installation diagnostics and render the summary in the conversation.
- `/experimental` — browse Codex feature flags; `/experimental enable <feature>` and `/experimental disable <feature>` toggle them.
- `/rename <name>` — rename the active persisted Codex session.
- `/usage` — show historical daily/lifetime account tokens, all advertised rate-limit buckets, balances, and earned reset credits. `/usage reset` redeems a credit only after confirmation.
- `/goal` and `/goal edit` — view the active session's goal or put its objective back in the editor. Goal creation, pause, resume, and clear continue through the backend's advertised `/goal` command.
- `/cloud list|status|diff|apply|exec ...` — use Codex Cloud from `cc`; applying a task diff requires confirmation.

These integrations are exposed only while Codex is active. The Codex form of `/delete` and CLI/app-server operations above use `CODEX_PATH` when explicitly configured, then the compatible Codex bundled with `codex-acp`, then a `codex` executable on `PATH`. This keeps an older standalone CLI from breaking newer adapter-backed features. They report an error instead of changing state when no CLI can be found. Persistent forking, import, memory management, config diagnostics, app discovery, hook inspection, feedback, rename, usage, and goal inspection use initialized app-server connections; none runs a competing model turn. `/fork` waits for the native process tree to finish and then loads the confirmed child through ACP. `/memories` goes further for task metadata: it first proves the ACP owner has stopped, performs the cold mutation, and resumes the same thread. MCP management launches the compatible CLI directly with literal argument arrays and no shell. `/app` is the exception: it hands a validated thread deep link directly to the installed desktop application and does not launch the Codex CLI.

### Skills, files, and agent mentions

Backend-advertised skills autocomplete with their native `$skill-name` syntax anywhere in a prompt. File mentions autocomplete after `@`, including when `fd` is not installed. A harness that advertises an `agent` session config option also contributes its custom agents to the same `@` menu; Claude's custom-agent descriptions therefore appear without the TUI reading Claude files or SDK internals. If the backend advertises ACP embedded-context support, `@path` and `@"path with spaces"` are sent as structured file resources rather than plain text. Text files up to 512 KiB are embedded; larger or binary files are sent as resource links. Image and file parts keep their original prompt order.

### Claude Code parity and SDK boundaries

The built-in Claude adapter exposes the current maintained ACP surface for models, effort, fast mode, custom agents, skills, plugins, hooks, MCP, memory, subagents, and backend commands. Generic cc extensions cover recent interactive-CLI additions that need host UI: shell history and path completion, `/cd`, `/branch`, `/tasks`, `/todos`, `/rewind`, Remote Control, Claude-compatible keybindings, Option/Alt+Return newlines, persistent permission/Remote Control status, and merged `@agent`/`@file` completion.

The remaining Claude CLI features depend on its private fullscreen application loop or on SDK operations that are not public. cc therefore does not imitate whole-session background/daemon attach, `claude agents`, `/fork <directive>` background-subagent launch, the `/workflows` management dashboard, `/tui`/`/focus` and transcript/Vim visual modes, checkpoint summarization, native plugin/skill management panels, or Remote Control server-mode flags. Backend-executed workflows and subagents still run and render normally when the adapter advertises or invokes them.

### Codex parity and ACP boundaries

Most current Codex workflows are reachable through either an advertised backend command or the local integrations above. Remaining boundaries are features that need deeper live-thread adapter support:

- Codex ACP 1.1.x does not expose native Plan collaboration mode. `/plan` uses the documented read-only planning fallback; it does not claim to be the native live-thread mode.
- ACP does not expose native child-agent/thread navigation. `/fork [last-turn-id]` bridges durable main-session forks through the stable app-server storage API, while `/btw` remains the independent side-thread UI.
- `/approve`, background-terminal `/ps`/`/stop`, and per-session personality require live-thread app-server methods that the maintained adapter does not yet expose. Starting a competing app-server turn would bypass `cc`'s approvals and event stream, so `cc` does not do that.
- `cc` supports ACP URL and form elicitation. Form requests are bounded and validated before rendering, support text and constrained numeric/boolean/single- or multi-select fields, mask secret-like fields, and never print submitted values into the transcript.

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

Codex's main-pane `/fork` is separate from `/btw`: it uses native `thread/fork`, records a durable parent relationship, and makes the returned child the active main session. Use `/fork <last-turn-id>` to branch through a specific completed turn without copying later turns.

### Effort levels, ultracode, and workflows (Claude Code)

`cc` is a thin ACP client with no ultracode-specific handling. Claude's `ultracode` effort level is a feature of the interactive `claude` CLI's own main loop — keyword detection, the standing workflow opt-in, and the effort bump all run *above* the Agent SDK. The `claude-agent-acp` backend drives the SDK query loop directly and does not reproduce that layer, so:

- **Typing `ultracode` in a prompt has no special effect** through `cc`. The keyword is forwarded to the backend as plain text, but the app-layer machinery that would normally pick it up never runs over ACP.
- **`/effort` only offers a reasoning level when `claude-agent-acp` advertises one** as an ACP config option. If it doesn't, `cc` reports "Reasoning selection is not advertised by this agent" — and it currently does not advertise an `ultracode` tier.
- When a backend *does* run multi-agent **workflows** or sub-agent fan-out, `cc` renders the nested tool calls and plan updates live, and `Esc` cancels the turn. This is generic ACP rendering, not ultracode-specific.

### Cursor

`cc` natively handles Cursor's ACP extensions: `cursor/ask_question` and `cursor/create_plan` are surfaced as TUI prompts (accept/answer/reject), `update_todos` feeds the generic `/todos` checklist, and `task` / `generate_image` are rendered inline. Cursor's `agent` / `plan` / `ask` modes map onto `/mode`.

## Voice input

When the input box is empty, press `space` to start recording, then `space` or `enter` to transcribe and send. Press `tab` while recording to transcribe and queue the message after the current turn, or `ctrl+space` to transcribe into the input box for editing. Press `ctrl+space` before recording to switch from voice mode to normal text input. While recording, typing keeps the transcript in the box for editing; `Ctrl+C` or `Esc` cancels the recording without transcribing.

Recording uses `rec` from sox when available, otherwise `ffmpeg`. Transcription uses OpenAI's audio endpoint with `OPENAI_API_KEY`; set `OPENAI_BASE_URL` for a compatible proxy, `CC_TRANSCRIPTION_MODEL` to override the model, and `CC_AUDIO_DEVICE` to select a microphone.

## Permissions

ACP permission requests are shown as TUI selection prompts. `cc` owns one
harness-agnostic permission policy that applies to **every** backend, so you never
have to learn each agent's native dialect just to change how it asks.

- **Mode** — `ask` (default, prompt every time), `auto` (approve automatically),
  or `deny` (refuse automatically). Set it in `settings.json` (global or
  per-agent, below) or flip it at runtime with `/yolo` / `/auto`:
  - `/yolo` toggles the active harness between `ask` and `auto`.
  - `/yolo ask|auto|deny` sets the mode explicitly.
  - Tightening the mode at runtime (e.g. `auto` → `ask`) only gates *new* backend
    requests. A backend launched in `auto` was spawned with native bypass and emits
    none, and `/new` reuses that same process, so it can't be tightened mid-session:
    set `permissions` in `settings.json` and restart `cc` to fully enforce the
    stricter mode (`cc` says so when this applies).
- **"Allow always" persists.** When you pick an *allow always* (or *bypass*)
  option in a prompt, `cc` records a grant in `~/.config/cc/permissions.json`
  (next to `settings.json`; override with `CC_PERMISSIONS`) and replies to the
  backend with only a *one-time* option, so `cc` owns the persistence — matching
  requests are then approved automatically across restarts, and `/permissions
  clear` fully revokes them, regardless of what the backend remembers.
  - *Caveat:* if the backend offers **only** a persistent option in that direction
    (no allow-once / reject-once), `cc` can't own it — it forwards your persistent
    choice as-is and does **not** record a `cc` grant (so it won't appear in
    `/permissions` and `/permissions clear` can't revoke it). `cc` says so at the
    time; the backend's own settings then govern that grant.
- **`/permissions`** opens Codex's read-only/agent/full-access picker while Codex
  is active; `/permissions show` displays the effective host policy and grants,
  and `/permissions clear` forgets them. On other backends, bare `/permissions`
  keeps showing the host policy and grants.

When you set an explicit mode, `cc` also aligns the backend's own native dialect so
the two never disagree: `auto` enables it (claude `bypassPermissions`, codex
`agent-full-access`, cursor `--force`),
while `ask`/`deny` *neutralize* any conflicting native auto/bypass on that agent
(restoring claude `defaultMode=default`, codex `agent`, and
dropping cursor `--force`/`-f`/`--yolo`) so the backend prompts and `cc`'s decision
is honored. Orthogonal settings are left alone, and
harnesses with no such knob are decided entirely by `cc`. Existing native settings
(below) with no explicit mode are still honored and continue to imply `auto` for
back-compat.

`cc` advertises ACP terminal support and implements `terminal/*` so backend
commands that need shell execution run inside the shared UI.

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

For a custom ACP harness with stable commands, `commandHints` can make those names available before its first connection. Hints accept strings or `{ "name", "description", "argumentHint" }` objects. They affect autocomplete and `/help` only; the backend still owns execution and its live advertisement replaces them for the active session.

## Settings

Create `~/.config/cc/settings.json` (or point `CC_SETTINGS` at another file) to apply default native settings per harness and choose a theme:

```json
{
  "theme": "tokyonight",
  "copyAlwaysFullResponse": false,
  "agents": {
    "claude": { "settings": { "permissions": { "defaultMode": "bypassPermissions" }, "model": "sonnet" } },
    "codex": {
      "config": { "approval_policy": "never", "sandbox_mode": "danger-full-access", "model": "gpt-5" },
      "additionalDirectories": ["~/shared-repo"],
      "mcpServers": [
        { "name": "local-tools", "command": "npx", "args": ["-y", "@example/mcp-server"] },
        { "type": "http", "name": "docs", "url": "https://mcp.example.com" }
      ]
    },
    "cursor": { "args": ["--force", "--sandbox", "disabled", "--approve-mcps", "--model", "gpt-5"] }
  }
}
```

`copyAlwaysFullResponse` is host-only UI state: choosing **Always copy full response** in `/copy` sets it to `true`, and `/copy picker` resets it to `false`. It is never sent to a harness.

These mirror each backend as closely as the ACP wrapper allows: Claude uses its `settings.permissions.defaultMode`, Codex passes config through `CODEX_CONFIG` and selects the matching ACP mode, and Cursor uses command-line args before the `acp` subcommand. The Codex adapter uses its bundled compatible Codex by default, avoiding app-server protocol mismatches with an unrelated CLI on `PATH`. Set `env.CODEX_PATH` explicitly only when you want to supply a known-compatible Codex executable. When these imply bypass/force mode, `cc` also auto-accepts ACP permission requests the backend still emits. `args` are appended to the backend command (Cursor args are inserted before the `acp` subcommand).

`additionalDirectories` adds roots to the ACP session when the backend advertises that capability. Relative paths and `~` are resolved to absolute paths; duplicates and the current working directory are omitted. `mcpServers` accepts stdio servers (`name`, `command`, optional `args` and `env`) and HTTP servers (`type: "http"`, `name`, `url`, and optional `headers`). Commands must be executable by absolute path or available on `PATH`, and HTTP servers are sent only when the backend advertises HTTP MCP support. Both `env` and `headers` may be JSON objects or ACP-style arrays of `{ "name", "value" }` entries.

### Unified permissions

Instead of (or in addition to) the native dialects above, you can set one
harness-agnostic policy that works for every backend:

```json
{
  "permissions": {
    "mode": "ask",
    "remember": true,
    "rules": [
      { "tool": "read", "action": "allow" },
      { "tool": "*", "action": "allow", "agent": "codex" }
    ]
  },
  "agents": {
    "claude": { "permissions": { "mode": "auto" } }
  }
}
```

- `mode`: `ask` | `auto` | `deny`. A per-agent `permissions.mode` overrides the
  global one. Setting `auto` also generates the backend's native config so cc and
  the backend agree.
- `remember`: whether "allow always" choices are persisted (default `true`).
- `rules`: explicit allow/deny rules. `tool` matches a tool's title or kind (or
  `*` for all); `agent` (optional) scopes the rule to one harness. Remembered
  "always" grants are stored as rules in `~/.config/cc/permissions.json`.

## Development

```sh
npm test
```

This runs syntax/compile checks, settings/queue and Codex feature-parity tests, the permission-engine unit tests (`tests/permissions.test.mjs`), and the tmux-driven TUI smoke tests (resize, scroll-during-streaming, the message queue, slash commands, permission auto-accept, "allow always" persistence + `/yolo`, and the `/btw` / `/diff` / `/copy` commands).

## Notes

T3 Code takes a richer web-app approach around provider sessions and uses `codex app-server` for structured Codex integration. `cc` uses the same product model in a smaller terminal form: backend events are normalized into shared UI state, and `/harness` stays in the wrapper input layer instead of being forwarded to an agent. The terminal UI is based on Pi's `@mariozechner/pi-tui` primitives (`TUI`, `Editor`, `Markdown`, autocomplete, differential rendering).
