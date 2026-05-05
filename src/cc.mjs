#!/usr/bin/env node

const args = process.argv.slice(2);
const shouldPrepaint =
	process.env.CC_PREPAINTED !== "1" && process.stdout.isTTY && !args.includes("--help") && !args.includes("-h") && !args.includes("--list");

if (shouldPrepaint) {
	process.env.CC_PREPAINTED = "1";
	prepaint(args);
}

try {
	const { runCli } = await import("./pi-harness.mjs");
	await runCli(args);
} catch (error) {
	if (shouldPrepaint) process.stdout.write("\x1b8\x1b[J\x1b[?25h");
	console.error(`cc: ${error?.message ?? error}`);
	process.exit(1);
}

function prepaint(args) {
	const width = process.stdout.columns || Number(process.env.COLUMNS) || 80;
	const agent = args.find((arg) => !arg.startsWith("-")) || "codex";
	process.env.CC_PREPAINT_AGENT = agent;
	const cwd = compactCwd(process.cwd());
	const rule = "─".repeat(Math.max(1, width));
	const voice = `\x1b[36m●\x1b[39m \x1b[2mvoice: space record · ctrl+space text input\x1b[22m`;
	const status = `\x1b[2m  ${agent} acp · ${cwd}\x1b[22m`;
	process.stdout.write(`\x1b7\x1b[?2026h\x1b[34m${rule}\x1b[39m\n${truncate(voice, width)}\n\x1b[34m${rule}\x1b[39m\n${truncate(status, width)}\x1b[?2026l\x1b[?25l`);
}

function compactCwd(cwd) {
	const home = process.env.HOME;
	return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

function truncate(value, width) {
	return stripAnsi(value).length <= width ? value : `${value.slice(0, Math.max(1, width - 1))}~`;
}

function stripAnsi(value) {
	return value.replace(/\x1b\[[\d;?]*[ -/]*[@-~]/g, "");
}
