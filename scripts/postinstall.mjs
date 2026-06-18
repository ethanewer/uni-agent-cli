#!/usr/bin/env node
// Best-effort installer for the ACP adapter binaries that `cc` talks to.
//
// Runs after `npm install -g github:ethanewer/uni-agent-cli`. It only acts on a
// GLOBAL install, never hard-fails the parent install, and skips anything that
// is already present. Set CC_SKIP_ADAPTER_INSTALL=1 (or CI=1) to disable.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ADAPTERS = [
	{ bin: "claude-agent-acp", pkg: "@agentclientprotocol/claude-agent-acp", label: "Claude Code ACP" },
	{ bin: "codex-acp", pkg: "@zed-industries/codex-acp", label: "Codex ACP" },
];

function isGlobalInstall() {
	// npm sets npm_config_global=true for `npm i -g`. When run by hand we also
	// proceed so `npm run postinstall` works for manual setup.
	if (process.env.npm_config_global === "true") return true;
	if (process.env.npm_config_global === "false") return false;
	return process.env.CC_FORCE_ADAPTER_INSTALL === "1";
}

function disabled() {
	return (
		process.env.CC_SKIP_ADAPTER_INSTALL === "1" ||
		process.env.CI === "true" ||
		process.env.CI === "1" ||
		process.env.npm_config_ignore_scripts === "true"
	);
}

function onPath(bin) {
	const dirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
	const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
	for (const dir of dirs) {
		if (!dir) continue;
		for (const ext of exts) {
			try {
				if (fs.existsSync(path.join(dir, `${bin}${ext}`))) return true;
			} catch {}
		}
	}
	return false;
}

function installGlobally(pkg) {
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const result = spawnSync(npm, ["install", "-g", pkg], {
		stdio: "inherit",
		timeout: 5 * 60 * 1000,
	});
	return result.status === 0;
}

function main() {
	if (disabled()) return;
	if (!isGlobalInstall()) return;

	const missing = ADAPTERS.filter((adapter) => !onPath(adapter.bin));
	if (missing.length === 0) {
		report([]);
		return;
	}

	console.log("\ncc: installing ACP adapters so the agents work out of the box…");
	const failed = [];
	for (const adapter of missing) {
		console.log(`  • ${adapter.label} (${adapter.pkg})`);
		const ok = installGlobally(adapter.pkg);
		if (!ok) failed.push(adapter);
	}
	report(failed);
}

function report(failed) {
	const lines = ["", "cc is installed. Quick start:", "  cc            # default agent (codex)", "  cc claude     # Claude Code", "  cc cursor     # Cursor Agent", ""];
	if (failed.length > 0) {
		lines.push("Some ACP adapters could not be installed automatically. Install them with:");
		for (const adapter of failed) lines.push(`  npm install -g ${adapter.pkg}`);
		lines.push("");
	}
	lines.push("Optional backends: install `cursor-agent` for Cursor, and set OPENAI_API_KEY for voice input.");
	lines.push("Run `cc doctor` to check that everything is wired up.");
	lines.push("");
	console.log(lines.join("\n"));
}

try {
	main();
} catch (error) {
	// Never fail the install over a best-effort adapter bootstrap.
	console.log(`cc: skipped adapter bootstrap (${error?.message ?? error}). Run \`cc doctor\` later.`);
}
