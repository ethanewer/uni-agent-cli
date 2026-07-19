const TERMINAL_UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function visibleUnicodeEscape(character) {
	const codePoint = character.codePointAt(0);
	return codePoint <= 0xffff
		? `\\u${codePoint.toString(16).padStart(4, "0")}`
		: `\\u{${codePoint.toString(16)}}`;
}

// Workflow source, prompts, tool output, errors, Git refs, and paths can all be
// model- or repository-controlled. Never pass their control bytes to the
// terminal. Keeping unsafe code points as visible escapes makes approval and
// inspection useful without allowing ANSI/OSC, bidi, or line-separator tricks.
export function sanitizeUntrustedTerminalText(value) {
	let result = "";
	for (const character of String(value ?? "")) {
		if (character === "\n") result += character;
		else result += TERMINAL_UNSAFE.test(character) ? visibleUnicodeEscape(character) : character;
	}
	return result;
}

export function sanitizeUntrustedTerminalLine(value) {
	return sanitizeUntrustedTerminalText(value).replaceAll("\n", "\\n");
}
