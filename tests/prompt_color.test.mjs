import assert from "node:assert/strict";

import {
	PROMPT_COLOR_NAMES,
	PROMPT_COLOR_PALETTE,
	resolvePromptColor,
} from "../src/harness/prompt-color.mjs";
import { HarnessApp, localSlashCommands } from "../src/pi-harness.mjs";

assert.deepEqual(resolvePromptColor(" BLUE "), { name: "blue", hex: PROMPT_COLOR_PALETTE.blue });
assert.deepEqual(resolvePromptColor("default"), { name: "default" });
assert.deepEqual(resolvePromptColor("", { random: () => 0 }), {
	name: PROMPT_COLOR_NAMES[0],
	hex: PROMPT_COLOR_PALETTE[PROMPT_COLOR_NAMES[0]],
});
assert.deepEqual(resolvePromptColor("", { random: () => 0.999999 }), {
	name: PROMPT_COLOR_NAMES.at(-1),
	hex: PROMPT_COLOR_PALETTE[PROMPT_COLOR_NAMES.at(-1)],
});
assert.throws(() => resolvePromptColor("chartreuse"), /usage: \/color/u);

const notices = [];
const commands = [];
let privateColorMutationCalled = false;
const app = Object.create(HarnessApp.prototype);
app.editor = { borderColor: (text) => text };
app.ui = { requestRender() {} };
app.client = { setColor() { privateColorMutationCalled = true; } };
app.addCommandMessage = (message) => commands.push(message);
app.addNotice = (notice) => notices.push(notice);
app.runPromptColor("blue");
assert.equal(app.promptColorName, "blue");
assert.match(app.editor.borderColor("border"), /38;2;97;175;239m/u);
assert.match(notices.at(-1), /blue/u);
app.runPromptColor("default");
assert.equal(app.promptColorName, "default");
assert.match(app.editor.borderColor("border"), /\x1b\[34m/u);
assert.deepEqual(commands, ["/color blue", "/color default"]);
assert.equal(privateColorMutationCalled, false, "local /color must not invent an adapter/SDK mutation");

const catalogApp = {
	activeKey: "claude",
	availableCommands: new Map([["claude", [{ name: "color" }]]]),
	btwThread: undefined,
	client: { capabilities: {} },
	commandsLoaded: new Set(["claude"]),
	config: { agents: { claude: { label: "Claude" } } },
	focusedThread: "main",
	isCodexBackendActive: () => false,
	sessionStates: new Map(),
	themeName: "system",
};
const colorCommand = localSlashCommands(catalogApp).find((command) => command.name === "color");
assert.equal(colorCommand.argumentHint, "[red|blue|green|yellow|purple|orange|pink|cyan|default]");
assert.deepEqual(colorCommand.getArgumentCompletions("p").map((entry) => entry.value), ["purple", "pink"]);
catalogApp.shouldOpenCodexReviewDialog = HarnessApp.prototype.shouldOpenCodexReviewDialog;
assert.equal(HarnessApp.prototype.slashCommandRoute.call(catalogApp, "color"), "local", "backend advertisements cannot shadow /color");

console.log("prompt color tests passed");
