import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TUI_KEYBINDINGS } from "@mariozechner/pi-tui/dist/keybindings.js";
import { matchesKey, parseKey } from "@mariozechner/pi-tui/dist/keys.js";

export const CC_KEYBINDINGS_SCHEMA = "https://www.schemastore.org/claude-code-keybindings.json";
export const CC_KEYBINDINGS_DOCS = "https://code.claude.com/docs/en/keybindings";

// cc intentionally uses Claude Code's key -> action document shape. TUI targets
// are delegated to Pi's editor key manager. `cc.*` targets are host actions
// dispatched above every harness, so no Claude-specific adapter reaches into
// the shared TUI.
export const CC_KEYBINDING_ACTIONS = Object.freeze({
	Global: Object.freeze({
		"app:interrupt": "cc.app.interrupt",
		"app:exit": "cc.app.exit",
		"app:redraw": "cc.app.redraw",
		"app:toggleTodos": "cc.app.toggleTodos",
	}),
	Chat: Object.freeze({
		"chat:cancel": "cc.chat.cancel",
		"chat:clearInput": "cc.app.redraw",
		"chat:killAgents": "cc.chat.killAgents",
		"chat:cycleMode": "cc.chat.cycleMode",
		"chat:modelPicker": "cc.chat.modelPicker",
		"chat:fastMode": "cc.chat.fastMode",
		"chat:submit": "tui.input.submit",
		"chat:newline": "tui.input.newLine",
		"chat:undo": "tui.editor.undo",
		"chat:imagePaste": "cc.chat.imagePaste",
		"voice:pushToTalk": "cc.voice.pushToTalk",
	}),
	Autocomplete: Object.freeze({
		// select.confirm is only consulted while the menu is open; input.tab is
		// also the editor's command for opening autocomplete, so mapping custom
		// accept keys to it would leak an Autocomplete binding into Chat.
		"autocomplete:accept": "tui.select.confirm",
		"autocomplete:dismiss": "tui.select.cancel",
		"autocomplete:previous": "tui.select.up",
		"autocomplete:next": "tui.select.down",
	}),
	Confirmation: Object.freeze({
		"confirm:yes": "cc.confirm.yes",
		"confirm:no": "cc.confirm.no",
		"confirm:previous": "cc.confirm.previous",
		"confirm:next": "cc.confirm.next",
		"confirm:toggle": "cc.confirm.toggle",
	}),
	Task: Object.freeze({
		"task:background": "cc.task.background",
	}),
	Select: Object.freeze({
		// cc's menus and Pi's autocomplete share the same low-level select IDs.
		// Dispatch generic selections in their own context so a Select binding
		// such as `j` never leaks into the chat autocomplete menu.
		"select:accept": "cc.select.accept",
		"select:cancel": "cc.select.cancel",
		"select:previous": "cc.select.previous",
		"select:next": "cc.select.next",
	}),
});

export const DEFAULT_CC_KEYBINDINGS = Object.freeze({
	// Pi already supplies Shift+Enter. Add Option/Alt+Enter so multiline input
	// also works in tmux and terminals which encode macOS Option as Meta.
	"tui.input.newLine": Object.freeze(["shift+enter", "alt+enter"]),
});

// Only defaults which need host dispatch live here. Existing editor/menu
// defaults continue to be owned by the components themselves. Ctrl+X chords
// mirror Claude Code while avoiding tmux's Ctrl+B prefix; Ctrl+B remains
// available outside tmux for exact parity with Claude's Task context.
const DEFAULT_CC_ACTION_BINDINGS = Object.freeze([
	Object.freeze({ context: "Global", key: "ctrl+t", action: "cc.app.toggleTodos" }),
	Object.freeze({ context: "Chat", key: "ctrl+l", action: "cc.app.redraw" }),
	Object.freeze({ context: "Chat", key: "ctrl+x ctrl+k", action: "cc.chat.killAgents" }),
	Object.freeze({ context: "Chat", key: "shift+tab", action: "cc.chat.cycleMode" }),
	Object.freeze({ context: "Chat", key: "alt+p", action: "cc.chat.modelPicker" }),
	Object.freeze({ context: "Chat", key: "alt+o", action: "cc.chat.fastMode" }),
	Object.freeze({ context: "Chat", key: "ctrl+v", action: "cc.chat.imagePaste" }),
	Object.freeze({ context: "Chat", key: "space", action: "cc.voice.pushToTalk" }),
	Object.freeze({ context: "Confirmation", key: "y", action: "cc.confirm.yes" }),
	Object.freeze({ context: "Confirmation", key: "n", action: "cc.confirm.no" }),
	Object.freeze({ context: "Task", key: "ctrl+b", action: "cc.task.background" }),
	Object.freeze({ context: "Task", key: "ctrl+x ctrl+b", action: "cc.task.background" }),
]);

export const CC_UNBOUND_ACTION = "cc.unbound";
// Internal dispatcher context for components that deliberately do not expose a
// user-remappable Claude context (for example ThemePicker and a free-text
// elicitation field). It gives their native text/navigation handling priority
// over Global bindings without making unsupported component actions configurable.
export const CC_NATIVE_INPUT_CONTEXT = "cc.nativeInput";
export const CC_KEYBINDING_CHORD_TIMEOUT_MS = 1_000;

const MODIFIER_ALIASES = Object.freeze({
	ctrl: "ctrl",
	control: "ctrl",
	shift: "shift",
	alt: "alt",
	opt: "alt",
	option: "alt",
	meta: "alt",
	cmd: "super",
	command: "super",
	super: "super",
	win: "super",
});
const MODIFIER_ORDER = ["ctrl", "shift", "alt", "super"];
const SPECIAL_KEYS = new Map([
	["esc", "escape"],
	["escape", "escape"],
	["return", "enter"],
	["enter", "enter"],
	["tab", "tab"],
	["space", "space"],
	["backspace", "backspace"],
	["delete", "delete"],
	["insert", "insert"],
	["clear", "clear"],
	["home", "home"],
	["end", "end"],
	["pageup", "pageUp"],
	["pagedown", "pageDown"],
	["up", "up"],
	["down", "down"],
	["left", "left"],
	["right", "right"],
	...Array.from({ length: 12 }, (_, index) => [`f${index + 1}`, `f${index + 1}`]),
]);
const SYMBOL_KEYS = new Set(["`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "+", "|", "~", "{", "}", ":", "<", ">", "?"]);
const RESERVED_KEYS = new Set(["ctrl+c", "ctrl+d", "ctrl+m"]);
const TERMINAL_CONFLICTS = new Map([
	["ctrl+b", "tmux prefix"],
	["ctrl+a", "GNU screen prefix"],
	["ctrl+z", "terminal suspend"],
]);
const NATIVE_TUI_INPUT_KEYS = Object.freeze(
	Object.entries(TUI_KEYBINDINGS)
		.filter(([id]) => id.startsWith("tui.editor.") || id.startsWith("tui.input.") || id.startsWith("tui.select."))
		.flatMap(([id, definition]) => normalizedKeyList(DEFAULT_CC_KEYBINDINGS[id] ?? definition.defaultKeys)),
);
const NATIVE_PANEL_INPUT_KEYS = Object.freeze(["enter", "escape", "up", "down", "backspace", "ctrl+u"]);

export function ccKeybindingsPath(options = {}) {
	const environment = options.environment ?? process.env;
	if (environment.CC_KEYBINDINGS) return path.resolve(environment.CC_KEYBINDINGS);
	if (environment.CC_SETTINGS) return path.join(path.dirname(path.resolve(environment.CC_SETTINGS)), "keybindings.json");
	return path.join(options.homeDirectory ?? os.homedir(), ".config", "cc", "keybindings.json");
}

export function ccKeybindingsTemplate() {
	return {
		$schema: CC_KEYBINDINGS_SCHEMA,
		$docs: CC_KEYBINDINGS_DOCS,
		bindings: [],
	};
}

export function ensureCcKeybindingsFile(options = {}) {
	const file = options.file ?? ccKeybindingsPath(options);
	if (fs.existsSync(file)) return { file, created: false };
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	try {
		fs.writeFileSync(file, `${JSON.stringify(ccKeybindingsTemplate(), null, 2)}\n`, { flag: "wx", mode: 0o600 });
		return { file, created: true };
	} catch (error) {
		if (error?.code === "EEXIST") return { file, created: false };
		throw error;
	}
}

export function normalizeCcKeyStroke(value) {
	if (typeof value !== "string") return { error: "keystroke must be a string" };
	const source = value.trim();
	if (!source) return { error: "keystroke cannot be empty" };
	const strokes = source.split(/\s+/u);
	if (strokes.length > 2) return { error: "cc supports chord sequences of at most two keystrokes" };
	const normalized = [];
	for (const stroke of strokes) {
		const result = normalizeCcSingleKeyStroke(stroke);
		if (!result.key) return result;
		normalized.push(result.key);
	}
	return { key: normalized.join(" ") };
}

function normalizeCcSingleKeyStroke(source) {
	// "+" is both a bindable symbol and the modifier separator, so a spelling
	// ending in "+" ("+", "ctrl++") means the plus key itself.
	const parts = source.split("+");
	if (source === "+" || source.endsWith("++")) {
		parts.pop();
		parts[parts.length - 1] = "+";
	}
	if (parts.some((part) => !part)) return { error: "keystroke contains an empty key or modifier" };
	const rawBase = parts.pop();
	const modifiers = new Set();
	for (const rawModifier of parts) {
		const modifier = MODIFIER_ALIASES[rawModifier.toLowerCase()];
		if (!modifier) return { error: `unknown modifier: ${rawModifier}` };
		if (modifiers.has(modifier)) return { error: `duplicate modifier: ${rawModifier}` };
		modifiers.add(modifier);
	}

	let base;
	if (/^[A-Za-z]$/.test(rawBase)) {
		base = rawBase.toLowerCase();
		// Claude Code treats a standalone uppercase letter as Shift+letter. With
		// any explicit modifier, uppercase is stylistic and does not imply Shift.
		if (parts.length === 0 && rawBase === rawBase.toUpperCase()) modifiers.add("shift");
	} else if (/^[0-9]$/.test(rawBase) || SYMBOL_KEYS.has(rawBase)) {
		base = rawBase;
	} else {
		base = SPECIAL_KEYS.get(rawBase.toLowerCase());
	}
	if (!base) return { error: `unknown key: ${rawBase}` };
	return { key: [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), base].join("+") };
}

export function compileCcKeybindings(document) {
	const warnings = [];
	const resolved = new Map();
	for (const [id, definition] of Object.entries(TUI_KEYBINDINGS)) {
		resolved.set(id, normalizedKeyList(DEFAULT_CC_KEYBINDINGS[id] ?? definition.defaultKeys));
	}
	const touched = new Set(Object.keys(DEFAULT_CC_KEYBINDINGS));
	const custom = [];
	const seenClaims = new Map();
	const actionClaims = new Map(
		DEFAULT_CC_ACTION_BINDINGS.map((binding) => [bindingClaim(binding.context, binding.key), { ...binding, default: true }]),
	);

	if (document === undefined) return finishCompilation(resolved, touched, warnings, custom, actionClaims);
	if (!isPlainObject(document)) {
		warnings.push("Keybindings file must contain a JSON object; using cc defaults.");
		return finishCompilation(resolved, touched, warnings, custom, actionClaims);
	}
	if (!Array.isArray(document.bindings)) {
		warnings.push('Keybindings file must contain a "bindings" array; using cc defaults.');
		return finishCompilation(resolved, touched, warnings, custom, actionClaims);
	}

	for (let blockIndex = 0; blockIndex < document.bindings.length; blockIndex += 1) {
		const block = document.bindings[blockIndex];
		if (!isPlainObject(block)) {
			warnings.push(`bindings[${blockIndex}] must be an object.`);
			continue;
		}
		const context = block.context;
		const actions = CC_KEYBINDING_ACTIONS[context];
		if (!actions) {
			warnings.push(`bindings[${blockIndex}] uses unsupported context ${JSON.stringify(context)}.`);
			continue;
		}
		if (!isPlainObject(block.bindings)) {
			warnings.push(`bindings[${blockIndex}].bindings must be an object.`);
			continue;
		}
		for (const [sourceKey, action] of Object.entries(block.bindings)) {
			const normalized = normalizeCcKeyStroke(sourceKey);
			if (!normalized.key) {
				warnings.push(`${context} ${JSON.stringify(sourceKey)}: ${normalized.error}.`);
				continue;
			}
			const key = normalized.key;
			const strokes = key.split(" ");
			const reserved = strokes.find((stroke) => RESERVED_KEYS.has(stroke));
			if (reserved) {
				warnings.push(`${context} ${sourceKey}: ${reserved} is reserved and cannot be rebound.`);
				continue;
			}
			for (const stroke of strokes) {
				const terminalConflict = TERMINAL_CONFLICTS.get(stroke);
				if (terminalConflict) warnings.push(`${context} ${sourceKey}: ${stroke} may conflict with the ${terminalConflict}.`);
			}
			if (action !== null && typeof action !== "string") {
				warnings.push(`${context} ${sourceKey}: action must be a string or null.`);
				continue;
			}
			const targetId = action === null ? undefined : actions[action];
			if (action !== null && !targetId) {
				warnings.push(`${context} ${sourceKey}: action ${JSON.stringify(action)} is not supported by cc.`);
				continue;
			}

			const claim = bindingClaim(context, key);
			if (seenClaims.has(claim)) {
				warnings.push(`${context} ${sourceKey}: replaces an earlier binding for ${key}.`);
			}
			seenClaims.set(claim, action);
			// Contextual bindings must not be copied into Pi's process-global editor
			// manager. Doing so lets a Chat remap (for example Enter -> newline) alter
			// the same raw key after Autocomplete has accepted a slash command. The
			// dispatcher consumes Chat actions in Chat and leaves Pi's native component
			// defaults untouched in higher-priority contexts.
			if (action === null && strokes.length > 1) {
				// A chord has no lower-level component behavior to suppress. Removing
				// its claim really frees the prefix once no sibling chord remains.
				actionClaims.delete(claim);
			} else {
				actionClaims.set(claim, {
					context,
					key,
					action: action === null ? CC_UNBOUND_ACTION : targetId,
					default: false,
				});
			}
			custom.push({ context, key, action });
		}
	}

	warnChordPrefixConflicts(actionClaims, warnings);
	return finishCompilation(resolved, touched, warnings, custom, actionClaims);
}

export function loadCcKeybindings(options = {}) {
	const file = options.file ?? ccKeybindingsPath(options);
	if (!fs.existsSync(file)) return { file, exists: false, ...compileCcKeybindings(undefined) };
	try {
		const document = JSON.parse(fs.readFileSync(file, "utf8"));
		return { file, exists: true, document, ...compileCcKeybindings(document) };
	} catch (error) {
		const compiled = compileCcKeybindings(undefined);
		return {
			file,
			exists: true,
			...compiled,
			warnings: [`Could not parse keybindings file: ${oneLine(error?.message ?? error)}.`, ...compiled.warnings],
		};
	}
}

export function formatCcKeybindingsStatus(result) {
	const lines = [`Keybindings: ${result.file}`];
	if (!result.exists) lines.push("  File does not exist yet; run /keybindings edit to create it.");
	if ((result.custom?.length ?? 0) === 0) lines.push("  Custom bindings: none (cc defaults are active)");
	else {
		lines.push("  Custom bindings:");
		for (const entry of result.custom) {
			lines.push(`    ${entry.context} ${entry.key} -> ${entry.action ?? "unbound"}`);
		}
	}
	if ((result.warnings?.length ?? 0) > 0) {
		lines.push("  Warnings:");
		for (const warning of result.warnings) lines.push(`    - ${warning}`);
	}
	lines.push("  Supported contexts: Global, Chat, Autocomplete, Confirmation, Task, Select");
	return lines.join("\n");
}

// Stateful, harness-neutral two-stroke chord resolver. Contexts are supplied in
// priority order (for example Autocomplete, Chat, Global). A chord prefix is
// consumed while waiting, exactly like Claude Code; a mismatch starts a fresh
// lookup for the second key and never leaks the reserved prefix into the editor.
export class CcKeybindingDispatcher {
	constructor(compilation, options = {}) {
		this.setTimeout = options.setTimeout ?? globalThis.setTimeout;
		this.clearTimeout = options.clearTimeout ?? globalThis.clearTimeout;
		this.timeoutMs = options.timeoutMs ?? CC_KEYBINDING_CHORD_TIMEOUT_MS;
		this.update(compilation);
	}

	update(compilation) {
		this.reset();
		this.bindings = Array.isArray(compilation?.actionBindings)
			? compilation.actionBindings.map((binding) => ({ ...binding, strokes: [...binding.strokes] }))
			: [];
	}

	reset() {
		if (this.timer !== undefined) this.clearTimeout(this.timer);
		this.timer = undefined;
		this.pending = undefined;
	}

	dispose() {
		this.reset();
		this.bindings = [];
	}

	handle(data, contexts) {
		const orderedContexts = [...new Set((Array.isArray(contexts) ? contexts : [contexts]).filter(Boolean))];
		const contextSet = new Set(orderedContexts);
		if (this.pending) {
			const candidates = this.pending.candidates.filter((binding) => contextSet.has(binding.context));
			this.reset();
			const completed = firstMatchingBinding(candidates, data, 1, orderedContexts);
			if (completed) return { consume: true, action: completed.action, chord: completed.key, binding: completed };
		}

		// Resolve one context at a time. A custom binding in the active context may
		// replace that component's default, and a chord prefix still beats a single
		// binding in the same context. If neither exists, let the active component
		// consume its native key before considering a lower Chat/Global context.
		// This is especially important for autocomplete Enter: Pi accepts the slash
		// completion and submits it, behavior a host-dispatched select action cannot
		// reproduce without reaching into the editor.
		for (const context of orderedContexts) {
			const contextual = this.bindings.filter((binding) => binding.context === context);
			const prefixes = contextual.filter(
				(binding) => binding.strokes.length === 2 && matchesCcStroke(data, binding.strokes[0]),
			);
			if (prefixes.length > 0) {
				// Once this context claims the prefix, same-prefix chords in lower
				// contexts must stay completable: with the defaults, Task's
				// ctrl+x ctrl+b would otherwise deaden Chat's ctrl+x ctrl+k exactly
				// while agents are running.
				const lowerContexts = new Set(orderedContexts.slice(orderedContexts.indexOf(context) + 1));
				const pending = {
					candidates: [
						...prefixes,
						...this.bindings.filter(
							(binding) =>
								lowerContexts.has(binding.context) &&
								binding.strokes.length === 2 &&
								matchesCcStroke(data, binding.strokes[0]),
						),
					],
				};
				this.pending = pending;
				this.timer = this.setTimeout(() => {
					if (this.pending === pending) this.reset();
				}, this.timeoutMs);
				this.timer?.unref?.();
				return { consume: true, pending: true };
			}
			const single = contextual.find(
				(binding) => binding.strokes.length === 1 && matchesCcStroke(data, binding.strokes[0]),
			);
			if (single) return { consume: true, action: single.action, chord: single.key, binding: single };
			if (componentOwnsInput(context, data)) {
				// Return immediately instead of scanning lower contexts, but do not consume
				// the raw key: the component must retain its exact native behavior. In
				// particular, Pi's slash-autocomplete Enter accepts and submits in one turn,
				// while the host's semantic accept helper intentionally only completes.
				return { consume: false };
			}
		}
		return { consume: false };
	}
}

export function watchCcKeybindings(file, onChange, options = {}) {
	const interval = options.interval ?? 500;
	const watchFile = options.watchFile ?? fs.watchFile.bind(fs);
	const unwatchFile = options.unwatchFile ?? fs.unwatchFile.bind(fs);
	let stopped = false;
	const listener = (current, previous) => {
		if (stopped) return;
		if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
		onChange();
	};
	watchFile(file, { interval, persistent: false }, listener);
	return () => {
		if (stopped) return;
		stopped = true;
		unwatchFile(file, listener);
	};
}

function finishCompilation(resolved, touched, warnings, custom, actionClaims) {
	const userBindings = {};
	for (const id of touched) userBindings[id] = [...(resolved.get(id) ?? [])];
	const actionBindings = [...actionClaims.values()].map((binding) => ({
		...binding,
		strokes: binding.key.split(" "),
	}));
	return { userBindings, actionBindings, warnings, custom };
}

function normalizedKeyList(value) {
	const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
	return [...new Set(values.map((entry) => normalizeCcKeyStroke(entry).key).filter(Boolean))];
}

function isPlainObject(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function oneLine(value) {
	return String(value).replace(/\s+/g, " ").trim();
}

function bindingClaim(context, key) {
	return `${context}\0${key}`;
}

function warnChordPrefixConflicts(actionClaims, warnings) {
	const byContext = new Map();
	for (const binding of actionClaims.values()) {
		const entries = byContext.get(binding.context) ?? [];
		entries.push(binding);
		byContext.set(binding.context, entries);
	}
	for (const [context, bindings] of byContext) {
		const singles = new Set(bindings.filter((binding) => !binding.key.includes(" ")).map((binding) => binding.key));
		const warned = new Set();
		for (const binding of bindings.filter((entry) => entry.key.includes(" "))) {
			const prefix = binding.key.split(" ")[0];
			if (!singles.has(prefix) || warned.has(prefix)) continue;
			warned.add(prefix);
			warnings.push(`${context} ${prefix}: this key is also a chord prefix; the chord takes precedence.`);
		}
	}
}

function bindingsForContexts(bindings, contexts) {
	const rank = new Map(contexts.map((context, index) => [context, index]));
	return bindings
		.filter((binding) => rank.has(binding.context))
		.sort((left, right) => rank.get(left.context) - rank.get(right.context));
}

function firstMatchingBinding(bindings, data, strokeIndex, contexts) {
	const ordered = bindingsForContexts(bindings, contexts);
	return ordered.find((binding) => matchesCcStroke(data, binding.strokes[strokeIndex]));
}

function matchesCcStroke(data, stroke) {
	// pi-tui's matchesKey parses key ids by splitting on "+", so a plus-key
	// stroke ("+", "ctrl++") can never match through it. Compare against the
	// canonical id of the parsed input instead. Kitty-protocol terminals report
	// the physical press as its unshifted codepoint plus Shift ("shift+=", or
	// "shift++" where the shifted codepoint is primary), so those spellings of
	// the same logical plus key must match too.
	if (stroke === "+" || stroke.endsWith("++")) {
		const parsed = parseKey(data);
		if (typeof parsed !== "string" || !parsed) return false;
		const normalized = normalizeCcKeyStroke(parsed).key;
		if (!normalized) return false;
		if (normalized === stroke) return true;
		const modifiers = stroke === "+" ? [] : stroke.slice(0, -2).split("+");
		const withShift = [...new Set([...modifiers, "shift"])];
		return normalized === normalizeCcKeyStroke(`${withShift.join("+")}+=`).key ||
			normalized === normalizeCcKeyStroke(`${withShift.join("+")}++`).key;
	}
	return matchesKey(data, stroke);
}

function componentOwnsInput(context, data) {
	if (context === "Autocomplete") {
		// Autocomplete is still the editor: printable input extends the current
		// prefix, and every native edit/navigation key must reach Pi unchanged.
		// Only an explicit Autocomplete binding (checked above) may replace it;
		// lower Chat/Global shortcuts must not steal characters or Backspace.
		return isNativePrintableInput(data) || nativeTuiInputOwns(data);
	}
	if (context === CC_NATIVE_INPUT_CONTEXT) return nativePanelInputOwns(data);
	if (context !== "Select" && context !== "Confirmation") return false;
	const nativeKeys = context === "Select"
		? ["enter", "escape", "up", "down", "pageUp", "pageDown", "home", "end", "backspace", "ctrl+u"]
		: ["enter", "escape", "up", "down", "backspace", "ctrl+u"];
	if (nativeKeys.some((key) => matchesKey(data, key))) return true;
	// Selection menus own printable input for filtering. Explicit bindings in
	// Select/Confirmation were checked above and still override this native path;
	// only lower-priority Global bindings are prevented from stealing the text.
	return isNativePrintableInput(data);
}

function nativeTuiInputOwns(data) {
	return NATIVE_TUI_INPUT_KEYS.some((candidate) => matchesKey(data, candidate));
}

function nativePanelInputOwns(data) {
	if (isNativePrintableInput(data)) return true;
	return NATIVE_PANEL_INPUT_KEYS.some((key) => matchesKey(data, key));
}

function isNativePrintableInput(data) {
	return typeof data === "string" && [...data].length === 1 && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(data);
}
