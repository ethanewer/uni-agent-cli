import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	REQUIRED_LOCAL_ADAPTERS,
	inspectLocalAdapter,
	inspectLocalAdapters,
	inspectLocalNativePayloads,
	verifyPostinstall,
} from "../scripts/postinstall.mjs";

const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(packageJson.bin.cc, "src/cc.mjs");
assert.equal(packageJson.engines.node, ">=22.19.0", "the package must satisfy every bundled harness runtime floor");
assert.equal(packageJson.optionalDependencies["opencode-ai"], "1.18.3", "the platform-specific OpenCode CLI must remain optional");
assert.equal(packageJson.dependencies["opencode-ai"], undefined, "the platform-specific OpenCode CLI must not block other harnesses");
assert.equal(packageJson.dependencies["@agentclientprotocol/claude-agent-acp"], "0.59.0");
assert.equal(packageJson.dependencies["@agentclientprotocol/codex-acp"], "1.1.4");
assert.equal(packageJson.dependencies["@anthropic-ai/claude-agent-sdk"], "0.3.214");
assert.equal(packageJson.dependencies["@openai/codex"], "0.144.6");
assert.equal(packageJson.dependencies["@earendil-works/pi-coding-agent"], "0.80.10");
assert.equal(packageJson.dependencies["pi-acp"], "0.0.31");
assert.deepEqual(
	REQUIRED_LOCAL_ADAPTERS.map(({ packageName, version }) => [packageName, version]),
	[
		["@agentclientprotocol/claude-agent-acp", "0.59.0"],
		["@agentclientprotocol/codex-acp", "1.1.4"],
		["pi-acp", "0.0.31"],
	],
);

const launcher = fs.readFileSync(new URL(`../${packageJson.bin.cc}`, import.meta.url), "utf8");
assert.match(launcher.split(/\r?\n/, 1)[0], /^#!\/usr\/bin\/env node$/u);
assert.match(launcher, /Node\.js 22\.19\.0 or newer/u);

// The checked-out installation itself has both exact, usable package-local
// adapters. PATH and globally installed package ownership are irrelevant.
const installed = inspectLocalAdapters();
assert.equal(installed.length, 3);
assert.ok(installed.every((result) => result.ok), JSON.stringify(installed));
const installedNative = inspectLocalNativePayloads();
assert.equal(installedNative.length, 2);
assert.ok(installedNative.every((result) => result.ok), JSON.stringify(installedNative));
assert.ok(verifyPostinstall({ report: false }).every((result) => result.ok));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-postinstall-local-"));
try {
	const adapter = REQUIRED_LOCAL_ADAPTERS[1];
	const packageRoot = path.join(root, ...adapter.packageName.split("/"));
	const entrypoint = path.join(packageRoot, "dist", "index.js");
	fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
	fs.writeFileSync(entrypoint, "#!/usr/bin/env node\n");
	fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
		name: adapter.packageName,
		version: adapter.version,
		bin: { [adapter.bin]: "dist/index.js" },
	}));
	assert.equal(inspectLocalAdapter(adapter, root).ok, true);

	fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
		name: adapter.packageName,
		version: "0.0.0",
		bin: { [adapter.bin]: "dist/index.js" },
	}));
	assert.match(inspectLocalAdapter(adapter, root).reason, /expected 1\.1\.4, found 0\.0\.0/u);

	fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
		name: "@zed-industries/codex-acp",
		version: adapter.version,
		bin: { [adapter.bin]: "dist/index.js" },
	}));
	assert.match(inspectLocalAdapter(adapter, root).reason, /unexpected package identity/u);

	fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
		name: adapter.packageName,
		version: adapter.version,
		bin: { [adapter.bin]: "../../outside.js" },
	}));
	assert.match(inspectLocalAdapter(adapter, root).reason, /escapes its package/u);

	fs.rmSync(packageRoot, { recursive: true, force: true });
	const missing = verifyPostinstall({ nodeModules: root, adapters: [adapter], report: false });
	assert.equal(missing[0].ok, false);
	assert.match(missing[0].reason, /missing/u);
	assert.deepEqual(
		verifyPostinstall({ nodeModules: root, adapters: [adapter], env: { CC_SKIP_ADAPTER_INSTALL: "1" }, report: false }),
		[],
	);
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

// Project-local and npx installs hoist cc's dependencies beside cc instead of
// nesting them under the package; verification must find the hoisted copy
// rather than warn that the installation is broken.
{
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "cc-postinstall-hoisted-"));
	try {
		const adapter = REQUIRED_LOCAL_ADAPTERS[1];
		const packageRoot = path.join(project, "node_modules", ...adapter.packageName.split("/"));
		const entrypoint = path.join(packageRoot, "dist", "index.js");
		fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
		fs.writeFileSync(entrypoint, "#!/usr/bin/env node\n");
		fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
			name: adapter.packageName,
			version: adapter.version,
			bin: { [adapter.bin]: "dist/index.js" },
		}));
		const nestedNodeModules = path.join(project, "node_modules", "cc", "node_modules");
		fs.mkdirSync(nestedNodeModules, { recursive: true });
		const hoisted = inspectLocalAdapter(adapter, nestedNodeModules);
		assert.equal(hoisted.ok, true, JSON.stringify(hoisted));
		assert.equal(hoisted.packageDir, packageRoot);
	} finally {
		fs.rmSync(project, { recursive: true, force: true });
	}
}

// Omitting npm optional dependencies leaves both JS adapters present but strips
// the native executables they need. Verify that postinstall detects that exact
// partial-install state and tells the user how to repair it.
{
	const nodeModules = fs.mkdtempSync(path.join(os.tmpdir(), "cc-postinstall-native-"));
	const nativeOptions = { platform: "linux", arch: "x64", libc: "glibc" };
	const claudeNativeName = "@anthropic-ai/claude-agent-sdk-linux-x64";
	const codexNativeName = "@openai/codex-linux-x64";
	const writePackage = (name, metadata) => {
		const directory = path.join(nodeModules, ...name.split("/"));
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, ...metadata }));
		return directory;
	};
	try {
		writePackage("@anthropic-ai/claude-agent-sdk", {
			optionalDependencies: { [claudeNativeName]: "1.0.0" },
		});
		const claudeNative = writePackage(claudeNativeName, { version: "1.0.0" });
		fs.writeFileSync(path.join(claudeNative, "claude"), "native\n", { mode: 0o755 });
		fs.chmodSync(path.join(claudeNative, "claude"), 0o755);

		writePackage("@openai/codex", {
			optionalDependencies: { [codexNativeName]: "npm:@openai/codex@1.0.0-linux-x64" },
		});
		const codexNative = writePackage(codexNativeName, { name: "@openai/codex", version: "1.0.0-linux-x64" });
		const codexBinary = path.join(codexNative, "vendor", "test-target", "bin", "codex");
		fs.mkdirSync(path.dirname(codexBinary), { recursive: true });
		fs.writeFileSync(codexBinary, "native\n", { mode: 0o755 });
		fs.chmodSync(codexBinary, 0o755);

		const complete = inspectLocalNativePayloads(nodeModules, nativeOptions);
		assert.equal(complete.length, 2);
		assert.ok(complete.every((result) => result.ok), JSON.stringify(complete));

		fs.writeFileSync(path.join(claudeNative, "package.json"), JSON.stringify({
			name: claudeNativeName,
			version: "0.9.0",
		}));
		const staleClaude = inspectLocalNativePayloads(nodeModules, nativeOptions)
			.find((result) => result.key === "claude");
		assert.equal(staleClaude?.ok, false);
		assert.match(staleClaude?.reason, /expected .*@1\.0\.0, found .*@0\.9\.0/u);
		fs.writeFileSync(path.join(claudeNative, "package.json"), JSON.stringify({
			name: claudeNativeName,
			version: "1.0.0",
		}));

		fs.writeFileSync(path.join(codexNative, "package.json"), JSON.stringify({
			name: "@openai/codex",
			version: "1.0.0-linux-arm64",
		}));
		const staleCodex = inspectLocalNativePayloads(nodeModules, nativeOptions)
			.find((result) => result.key === "codex");
		assert.equal(staleCodex?.ok, false);
		assert.match(staleCodex?.reason, /expected @openai\/codex@1\.0\.0-linux-x64/u);
		fs.writeFileSync(path.join(codexNative, "package.json"), JSON.stringify({
			name: "@openai/codex",
			version: "1.0.0-linux-x64",
		}));

		fs.rmSync(claudeNative, { recursive: true, force: true });
		const omitted = inspectLocalNativePayloads(nodeModules, nativeOptions);
		assert.equal(omitted.find((result) => result.key === "claude")?.ok, false);
		assert.match(omitted.find((result) => result.key === "claude")?.reason, /optional native package/u);
		assert.equal(omitted.find((result) => result.key === "codex")?.ok, true);
		fs.rmSync(codexNative, { recursive: true, force: true });
		assert.ok(inspectLocalNativePayloads(nodeModules, nativeOptions).every((result) => !result.ok));

		let warning = "";
		const originalWarn = console.warn;
		console.warn = (message) => { warning += String(message); };
		try {
			const results = verifyPostinstall({
				nodeModules,
				adapters: [],
				nativeOptions,
			});
			assert.equal(results.some((result) => !result.ok), true);
		} finally {
			console.warn = originalWarn;
		}
		assert.match(warning, /npm install --include=optional/u);
		assert.match(warning, /omit config contains `optional`/u);
		assert.match(warning, /@anthropic-ai\/claude-agent-sdk-linux-x64/u);
		assert.match(warning, /@openai\/codex-linux-x64/u);

		let globalWarning = "";
		console.warn = (message) => { globalWarning += String(message); };
		try {
			verifyPostinstall({
				nodeModules,
				adapters: [],
				nativeOptions,
				env: { npm_config_global: "true" },
			});
		} finally {
			console.warn = originalWarn;
		}
		assert.match(globalWarning, /original global cc install command/u);
		assert.match(globalWarning, /npm install -g cc --include=optional/u);
		assert.doesNotMatch(globalWarning, /From the cc package\/project directory/u);
	} finally {
		fs.rmSync(nodeModules, { recursive: true, force: true });
	}
}

const source = fs.readFileSync(new URL("../scripts/postinstall.mjs", import.meta.url), "utf8");
assert.doesNotMatch(source, /spawnSync|execSync|@zed-industries/u);

console.log("postinstall: package-local verification only; no global migration");
