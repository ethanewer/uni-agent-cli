// Harness-neutral prompt-bar colors. Claude Code's `/color` is a frontend
// command, so forwarding it through ACP cannot recolor cc's own composer.
// Keep parsing and palette data outside the TUI; the host applies the returned
// color to whichever editor implementation it owns.
//
// Claude Agent SDK 0.3.205 declares an internal `set_color` control-message
// shape, but its public Query interface/runtime exposes no `setColor()` method.
// Do not reach through the adapter with Query.request(): `/color` remains local
// until the pinned SDK provides a supported live-session color mutation.

export const PROMPT_COLOR_PALETTE = Object.freeze({
	red: "#ff6b6b",
	blue: "#61afef",
	green: "#50fa7b",
	yellow: "#f1fa8c",
	purple: "#bd93f9",
	orange: "#ff9f43",
	pink: "#ff79c6",
	cyan: "#8be9fd",
});

export const PROMPT_COLOR_NAMES = Object.freeze(Object.keys(PROMPT_COLOR_PALETTE));

/** Parse `/color [color|default]`; no argument chooses a random color. */
export function resolvePromptColor(argument = "", options = {}) {
	const requested = String(argument ?? "").trim().toLowerCase();
	if (requested === "default") return { name: "default" };
	if (requested) {
		const hex = PROMPT_COLOR_PALETTE[requested];
		if (!hex) {
			throw new Error(`usage: /color [${[...PROMPT_COLOR_NAMES, "default"].join("|")}]`);
		}
		return { name: requested, hex };
	}
	const random = typeof options.random === "function" ? options.random : Math.random;
	const sample = Number(random());
	const index = Number.isFinite(sample)
		? Math.min(PROMPT_COLOR_NAMES.length - 1, Math.max(0, Math.floor(sample * PROMPT_COLOR_NAMES.length)))
		: 0;
	const name = PROMPT_COLOR_NAMES[index];
	return { name, hex: PROMPT_COLOR_PALETTE[name] };
}
