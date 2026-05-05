# cc

A fast `cc` CLI for switching between Claude Code, Codex, and Cursor Agent.

The default runtime is a shared TUI backed by ACP. The UI layer uses `@mariozechner/pi-tui` from Pi instead of a custom renderer, so the editor sits after the rendered conversation and moves naturally as messages stream in. The wrapper owns `/harness` switching while each agent runs as a backend process.

## Install

```sh
npm install
npm link
```

Then run:

```sh
cc
cc claude
cc cursor
```

## Switching

Inside a session:

```text
/harness
/harness codex
/harness claude
/harness cursor
```

`/harness` opens the minimal switcher. Direct commands switch immediately.

## Slash Commands

Agent-advertised ACP commands are shown in autocomplete and forwarded to that backend. Local commands are implemented in the shared UI when ACP exposes the needed capability:

- `/resume` opens the ACP session picker when `session/list` is supported.
- `/model`, `/mode`, and `/effort` open ACP config selectors when the backend advertises those config options.
- `/help`, `/status`, and `/clear` are handled locally.

## ACP

ACP is the default transport. The defaults are:

- Claude Code ACP: `claude-agent-acp`
- Codex ACP: `codex-acp`
- Cursor ACP: `cursor-agent acp`

Install the adapters once:

```sh
npm install -g @agentclientprotocol/claude-agent-acp @zed-industries/codex-acp
```

Then use:

```text
/harness codex
```

PTY fallback is not part of the Pi-TUI path; the shared UI talks to ACP backends.
The client advertises ACP terminal support and implements `terminal/*` requests so backend slash commands that need shell execution can run inside the shared UI.

## Development

```sh
npm test
```

## Configuration

Create `~/.config/cc/config.json` to override commands:

```json
{
  "defaultAgent": "codex",
  "agents": {
    "codex": {
      "command": "codex",
      "args": [],
      "acp": {
        "command": "codex-acp",
        "args": []
      }
    }
  }
}
```

You can also point `CC_CONFIG` at a different JSON file. `HARNESS_CONFIG` and `~/.config/uni-agent-cli/config.json` are still supported for existing installs.

## Notes

T3 Code takes a richer web-app approach around provider sessions and currently uses `codex app-server` for structured Codex integration. `cc` uses the same product model in a smaller terminal form: backend events are normalized into shared UI state, and `/harness` stays in the wrapper input layer instead of being forwarded to an agent.
The terminal UI itself is based on Pi's `@mariozechner/pi-tui` primitives: `TUI`, `ProcessTerminal`, `Editor`, `Markdown`, autocomplete, and differential rendering.
