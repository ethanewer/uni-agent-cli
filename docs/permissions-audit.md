# Permissions Audit — cc / uni-agent-cli

Audit date: 2026-06-24. Branch audited: `harness-adapter-prototype` (pi-harness.mjs is
identical to `main`; the `src/harness/` adapter prototype is branch-only and not yet
wired into the live path).

This document is the "before" picture. The companion overhaul lands in
`src/harness/permissions.mjs` + integration; see the end for the redesign.

---

## 1. How permissions actually flow today

cc is a thin TUI (`cc.mjs` → `pi-harness.mjs::runCli`) that spawns each harness as an
ACP child process (`AcpClient`). Permission handling is entirely inside the
6566-line `pi-harness.mjs`.

### Standard ACP path (claude, codex, opencode, pi, terminus-2, mini-swe-agent)

1. Backend sends a JSON-RPC request `session/request_permission` with
   `params.options` (each `{ optionId, name/label, kind, description }`) and a
   `params.toolCall`.
   - `AcpClient.handleMessage` routes it (`pi-harness.mjs:1787`).
2. `handlePermissionRequest` → `onPermissionRequest(params)` callback
   (`:1806`).
3. The callback (wired at `:2442` for the main client and **duplicated** at
   `:4009` for the `/btw` side-thread client) is:
   ```js
   if (agent._autoPermissionRequests) return autoPermissionOutcome(params);
   return this.requestPermission(params);
   ```
4. `requestPermission` enqueues onto a single-flight `permissionQueue`
   (`:4222`); `drainPermissionQueue` (`:4236`) shows one prompt at a time via
   `openPermissionRequest` (`:4288`).
5. `openPermissionRequest` builds a generic filterable `SelectionPanel`
   (`openSelection`, `:4187`) titled `Permission: <tool>` and resolves with
   `{ outcome: "selected", optionId }` or `{ outcome: "cancelled" }`.
6. `replyPermissionRequest` (`:1817`) wraps it as `result: { outcome }` on the
   wire.

### Cursor path (a *parallel* permission system)

Cursor doesn't use `session/request_permission`. It sends `cursor/*` extension
requests (`cursor/ask_question`, `cursor/create_plan`, plus fire-and-forget
`cursor/update_todos`, `cursor/task`, `cursor/generate_image`). These are routed
separately (`:1792` → `handleCursorRequest` `:1831`), queued through the **same**
`permissionQueue` but rendered by a **different** method `openCursorInteraction`
(`:4245`) with **different** outcome shapes (`{ outcome: { outcome: "accepted" } }`,
`answered`, etc.).

### "Allow always" persistence

**cc persists nothing.** Whatever option the user picks (including an
`allow_always`/`bypassPermissions` option) is forwarded to the backend as an
`optionId`; cc keeps no record. Therefore:

- *Within a session:* persistence is whatever the backend remembers.
- *Across cc restarts:* whatever the backend persists on its own. cc has no
  allowlist, cannot show what was allowed, and cannot revoke.

### How default permission settings are configured

`applyNativePermissionSetting(key, agent, settings)` (`:6431`) is a hard-coded
per-name switch that *infers* an all-or-nothing auto-approve flag
(`agent._autoPermissionRequests`) and, for claude, a startup mode
(`agent._startupMode`):

| Harness | Trigger (native settings) | Effect |
|---|---|---|
| claude | `settings.settings.permissions.defaultMode == "bypassPermissions"` | `_startupMode="bypassPermissions"` + `_autoPermissionRequests=true` |
| codex | `config.approval_policy=="never"` **and** `config.sandbox_mode=="danger-full-access"` | `_autoPermissionRequests=true` |
| cursor | spawn args include `--force`/`-f`/`--yolo` | `_autoPermissionRequests=true` |
| opencode, pi, terminus-2, mini-swe-agent | *(none)* | no way to auto-approve |

`_autoPermissionRequests` is the only cc-side "policy", set once at startup and
never changed. `autoPermissionOutcome` (`:5008`) then picks the **most
permissive** allow option (`bypassPermissions` → `allow_always` → first allow).

---

## 2. Weaknesses

Numbered for reference; severity in brackets.

### Architecture / extensibility

1. **[high] Per-harness config-shape divergence.** Expressing the *same* intent —
   "auto-approve everything" — requires three unrelated settings shapes the user
   must memorize (claude `defaultMode`, codex two config keys, cursor CLI flags),
   and is simply **impossible** for opencode/pi/terminus-2/mini-swe-agent. Adding
   a harness that needs auto-approve means editing core `applyNativePermissionSetting`.

2. **[high] No harness-agnostic permission setting / mode.** cc's auto-accept
   machinery (`autoPermissionOutcome`) is *already generic*, but the **trigger**
   is harness-specific. The capability exists yet is locked behind per-name
   inference.

3. **[high] Inference is fragile and guesses backend behavior from spawn inputs.**
   - codex requires *both* keys; set one and cc's belief desyncs from the
     backend.
   - cursor matches exact `--yolo`/`--force` tokens — `--force=true`, a config-file
     equivalent, or `--no-yolo` are mishandled (`--no-yolo` does not disable; a
     stray `--force` still triggers).
   - This is heuristic reverse-engineering of each backend's policy, inherently
     drift-prone as harnesses change.

4. **[high] cc's belief can desync from backend reality.** `_autoPermissionRequests`
   means *cc* auto-accepts on the backend's behalf. If inference is wrong you get
   either silent over-approval (cc accepts things the backend would have prompted
   for) or redundant double prompting. cc guesses the policy instead of knowing it.

5. **[med] Two (soon three) duplicated wiring sites.** The
   `_autoPermissionRequests ? auto : ask` block is copy-pasted at `:2442` and
   `:4009`; the planned `/remote` feature adds a third. Drift-prone. (The
   `src/harness/` prototype centralizes this in `BaseAcpAdapter.#onPermission`,
   but the prototype is not wired into cc.)

6. **[med] Permission vs cursor-interaction result-shape inconsistency.** The
   `onPermissionRequest` callback returns the **inner** outcome and the wire wraps
   it once (`:1820`); the `onCursorRequest` callback returns the **full** wire
   result (`:1859`). Two contracts for two callbacks that both "ask the user
   something". Faithfully copied into the prototype — confusing for new harnesses.

7. **[med] Cursor's interactive prompts are a bespoke parallel system.**
   ask_question/create_plan are conceptually permission/decision prompts but have
   their own render path and outcome shapes, keyed off the literal `cursor/`
   method prefix. Any other harness with backend-initiated prompts needs new
   bespoke code.

8. **[low] Even the intended fix (the prototype) keeps per-harness permission
   inference.** `BaseAcpAdapter` derives `autoApprove` from per-subclass
   `inferNativePermission` overrides — the branches are relocated, not eliminated,
   and no agnostic model, persistence, granularity, or runtime toggle is added.

### Behavior / safety / UX

9. **[high] Auto-approve selects the *broadest* grant.** `autoPermissionOption`
   prefers `bypassPermissions` then `allow_always` then the first allow. So
   turning on auto silently escalates each decision to the most permissive option
   the backend offers (e.g. "always, for everything") rather than the narrowest
   ("allow once"). A safety footgun.

10. **[high] "Allow always" is opaque, non-persistent (cc-side), and
    inconsistent.** cc cannot show, audit, pre-seed, or revoke what has been
    allowed; semantics differ per backend. No `/permissions` view.

11. **[med] No granular rules.** Auto is all-or-nothing. No "always allow
    read-only tools", no "allow `git status`", no per-tool policy. Real backends
    (claude) support rich rule sets cc can neither express nor pre-seed generically.

12. **[med] No runtime toggle.** `_autoPermissionRequests` is frozen at startup;
    there is no harness-agnostic `/yolo`. The only runtime lever is `/mode`, which
    is backend-gated and unavailable on harnesses that don't advertise modes.

13. **[med] Interactive `/mode bypass` does not sync `_autoPermissionRequests`.**
    Settings-based bypass sets the cc flag; switching to a bypass mode via `/mode`
    at runtime does not. Works for claude only because claude then stops asking;
    a backend that still emits requests under a bypass mode would keep prompting.

14. **[med] Silent auto-decisions with no feedback.** An empty-options request is
    silently cancelled (`:4290`); in auto mode a reject-only request is silently
    cancelled (`autoPermissionOption` → undefined → cancelled). The user never
    learns a decision was made for them.

15. **[med] `isAllowPermissionOption` is a brittle English-keyword heuristic.**
    Allow/deny is guessed by substring matching (`allow|approve|yes|accept|bypass`
    vs `reject|deny|cancel|no`) across `kind`/`optionId`/`name`/`label`. Locale-
    fragile and ambiguous ("Allow once but never again").

16. **[low] Prompts give the user almost nothing to decide on.** `permissionTitle`
    shows only the tool title; the ACP request's content/locations (the *what*
    that will run) are not surfaced. Users approve blind.

### Maintainability

17. **[med] `pi-harness.mjs` contains a literal ` ` byte** (line 4456, a map-key
    separator `` `${this.activeKey} …` ``). It makes `grep`/`ripgrep` treat the
    file as binary and **silently skip it** — a real impediment to auditing the
    permission code (hit immediately during this audit; use `rg -a`).

18. **[low] Ad-hoc underscore-prefixed properties** (`_autoPermissionRequests`,
    `_startupMode`, `_sessionMeta`) are stuffed onto the agent-config object and
    read in disparate places with no typed/centralized surface.

---

## 3. Redesign (implemented in this branch)

Principle: **cc owns one harness-agnostic permission policy; harnesses only
translate it to their native dialect.** This inverts fragile *inference* (guess
policy from native settings) into authoritative *generation* (derive native
settings from the policy), and moves all decisioning into one tested module.

### New module: `src/harness/permissions.mjs` (pure, unit-tested)

- **Unified settings schema** (works for *every* harness):
  ```jsonc
  {
    "permissions": {
      "mode": "ask",        // "ask" | "auto" | "deny"  (global default)
      "remember": true,     // persist "always" decisions cc-side
      "rules": [            // explicit, harness-agnostic allow/deny rules
        { "tool": "read",  "action": "allow" },
        { "tool": "*",     "action": "allow", "agent": "codex" }
      ]
    },
    "agents": {
      "claude": { "permissions": { "mode": "auto" } }
      // native passthrough (settings/config/args) still supported for fidelity
    }
  }
  ```
- **`resolvePermissionPolicy(config, agentKey)`** → effective `{ mode, remember,
  rules }` (per-agent overrides global; explicit rules + persisted grants merged).
- **`decidePermission(policy, request, ctx)`** → `{ action: "allow"|"deny"|"ask",
  optionId? }`. Rule match first, then mode. Auto-allow picks the **narrowest**
  safe allow option, not the broadest.
- **`nativePermissionConfig(agentKey, mode)`** — a small declarative table that
  *generates* the native config (claude `defaultMode`, codex `approval_policy`+
  `sandbox_mode`, cursor `--force`) from the unified mode. Generic harnesses need
  nothing: cc auto-accepts/denies on their behalf, consistently.
- **`inferModeFromNative(agentKey, settings)`** — back-compat: existing native
  configs still map to a unified mode, so old `settings.json` files keep working
  and existing tests stay green.
- **Persistence store** (`~/.config/cc/permissions.json`, separate from
  user-authored settings): `loadGrants`, `recordGrant`, `forgetGrant`, used to
  remember "always" decisions across restarts, auditable and revocable.
- **Single outcome builder** so the inner/full wire-shape inconsistency is hidden
  behind one helper.

### Integration

- `pi-harness.mjs`: `applyNativePermissionSetting` delegates to the engine
  (generation + back-compat inference, identical outputs for existing cases); both
  wiring sites route through `decidePermission`; "always" picks persist a grant;
  new `/yolo` (alias `/auto`) runtime toggle and `/permissions` viewer.
- `src/harness/`: `BaseAcpAdapter` uses the engine for `autoApprove` and native
  config; per-harness `inferNativePermission` overrides are replaced by the
  declarative table.

See `tests/permissions.test.mjs` for the behavioral contract.
