import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	BackendCommandCatalog,
	backendCommandCachePath,
	normalizeBackendCommands,
	startupCommandHints,
} from "../src/harness/command-catalog.mjs";
import { HarnessApp, localSlashCommands } from "../src/pi-harness.mjs";

const codexAgent = {
	label: "Codex",
	transport: "acp",
	_requiredAgentName: "@agentclientprotocol/codex-acp",
	_minimumAgentVersion: "1.1.2",
	acp: { command: "codex-acp", args: [] },
};

const claudeAgent = {
	label: "Claude",
	transport: "acp",
	_requiredAgentName: "@agentclientprotocol/claude-agent-acp",
	_minimumAgentVersion: "0.58.1",
	_packageLocalAcpCommand: "claude-agent-acp",
	_packageLocalAcpVersion: "0.58.1",
	acp: { command: "claude-agent-acp", args: [] },
};
const uncataloguedClaudeAgent = {
	label: "Claude",
	transport: "acp",
	acp: { command: "claude-agent-acp", args: [] },
};
const claudeBuiltinHintNames = [
	"deep-research", "design-sync", "dataviz", "update-config", "verify", "debug", "code-review", "simplify", "batch",
	"fewer-permission-prompts", "doctor", "loop", "claude-api", "run", "run-skill-generator", "agents", "color", "compact",
	"config", "context", "effort", "fast", "heapdump", "init", "mcp", "model", "reload-skills", "rename", "review",
	"security-review", "status", "usage", "insights", "recap", "goal", "design", "design-consent", "design-revoke",
	"team-onboarding",
];

assert.deepEqual(
	startupCommandHints("codex", codexAgent).map((command) => command.name),
	["skills", "review", "review-branch", "review-commit", "compact", "goal"],
	"only identity-gated Codex built-ins are safe first-run hints",
);
assert.deepEqual(
	startupCommandHints("claude", claudeAgent).map((command) => command.name),
	claudeBuiltinHintNames,
	"the pinned adapter's first-party commands are available on the first autocomplete pass",
);
assert.deepEqual(
	startupCommandHints("claude", { ...claudeAgent, _minimumAgentVersion: "0.58.0" }),
	[],
	"Claude hints are gated by the adapter version whose command contract they describe",
);
assert.deepEqual(
	startupCommandHints("codex", { ...codexAgent, _minimumAgentVersion: "1.1.1" }),
	[],
	"Codex hints are gated by the adapter version whose command contract they describe",
);
assert.deepEqual(
	startupCommandHints("custom", { commandHints: ["deploy", { name: "/inspect", input: { hint: "<path>" } }] }),
	[{ name: "deploy" }, { name: "inspect", argumentHint: "<path>" }],
	"custom harnesses can declare non-authoritative startup hints in config",
);

assert.deepEqual(
	normalizeBackendCommands([
		{ name: "/review", description: " Review\nchanges\u001b[2J ", input: { hint: " <target>\n" } },
		{ name: "review", description: "duplicate" },
		{ name: "$skill", description: "Skill" },
		{ name: "mcp:server", description: "MCP" },
		{ name: "two words" },
		{ name: "bad\u0000name" },
		{ name: "spoof\u202ename" },
		{ name: "nested/name" },
	]),
	[
		{ name: "review", description: "Review changes", argumentHint: "<target>" },
		{ name: "$skill", description: "Skill" },
		{ name: "mcp:server", description: "MCP" },
	],
	"cached command metadata is bounded, single-line, and deduplicated",
);
assert.equal(
	normalizeBackendCommands(Array.from({ length: 300 }, (_, index) => ({ name: `command-${index}` }))).length,
	300,
	"large plugin/skill catalogs are not truncated at the old 256-command boundary",
);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-command-catalog-"));
try {
	const cacheFile = path.join(root, "commands.json");
	const cwdA = path.join(root, "workspace-a");
	const cwdB = path.join(root, "workspace-b");
	fs.mkdirSync(cwdA);
	fs.mkdirSync(cwdB);
	const agents = {
		codex: codexAgent,
		claude: { ...uncataloguedClaudeAgent, env: { PRIVATE_DISCOVERY_PROFILE: "profile-secret" } },
	};
	const localAdapterCache = path.join(root, "package-local.json");
	new BackendCommandCatalog({ claude: claudeAgent }, {
		cwd: cwdA,
		cachePath: localAdapterCache,
		environment: { ...process.env, PATH: path.join(root, "old-global-prefix") },
	}).remember("claude", ["project-command"]);
	assert.deepEqual(
		new BackendCommandCatalog({ claude: claudeAgent }, {
			cwd: cwdA,
			cachePath: localAdapterCache,
			environment: { ...process.env, PATH: path.join(root, "new-global-prefix") },
		}).commandsFor("claude").map((command) => command.name),
		["project-command", ...claudeBuiltinHintNames],
		"package-local adapter caches are keyed by the bundled package, not an unrelated global PATH",
	);

	const first = new BackendCommandCatalog(agents, { cwd: cwdA, cachePath: cacheFile });
	assert.deepEqual(first.commandsFor("claude"), []);
	assert.equal(first.remember("claude", [
		{ name: "project-review", description: "Review this project" },
		{ name: "$private-skill", description: "Workspace skill" },
	], { agentInfo: { name: "claude-agent-acp", version: "1.0.0" } }), true);

	const persisted = fs.readFileSync(cacheFile, "utf8");
	assert.doesNotMatch(persisted, /workspace-a|profile-secret|API_KEY/u, "scope inputs are hashed, not stored verbatim");
	if (process.platform !== "win32") assert.equal(fs.statSync(cacheFile).mode & 0o777, 0o600);

	const second = new BackendCommandCatalog(agents, { cwd: cwdA, cachePath: cacheFile });
	assert.deepEqual(second.commandsFor("claude").map((command) => command.name), ["project-review", "$private-skill"]);
	assert.deepEqual(
		new BackendCommandCatalog(agents, { cwd: cwdB, cachePath: cacheFile }).commandsFor("claude"),
		[],
		"workspace command hints never leak into another cwd",
	);
	assert.deepEqual(
		new BackendCommandCatalog(agents, {
			cwd: cwdA,
			cachePath: cacheFile,
			environment: { ...process.env, CLAUDE_CONFIG_DIR: path.join(root, "other-profile") },
		}).commandsFor("claude"),
		[],
		"discovery-profile changes do not reuse another profile's command hints",
	);

	assert.equal(second.validateIdentity("claude", { name: "claude-agent-acp", version: "2.0.0" }), false);
	assert.deepEqual(second.commandsFor("claude"), [], "an adapter identity change invalidates stale cached hints");

	second.remember("codex", [{ name: "$dynamic-skill", description: "Dynamic" }], {
		agentInfo: { name: "@agentclientprotocol/codex-acp", version: "1.1.2" },
	});
	assert.deepEqual(
		second.commandsFor("codex").map((command) => command.name),
		["$dynamic-skill", "skills", "review", "review-branch", "review-commit", "compact", "goal"],
		"cached dynamic commands precede and augment safe static hints",
	);

	// Two stale, long-lived catalogs updating different scopes must not roll an
	// unrelated scope back to their older snapshot.
	const concurrentFile = path.join(root, "concurrent.json");
	new BackendCommandCatalog(agents, { cwd: cwdA, cachePath: concurrentFile }).remember("claude", ["a-old"]);
	new BackendCommandCatalog(agents, { cwd: cwdB, cachePath: concurrentFile }).remember("claude", ["b-old"]);
	const writerA = new BackendCommandCatalog(agents, { cwd: cwdA, cachePath: concurrentFile });
	const writerB = new BackendCommandCatalog(agents, { cwd: cwdB, cachePath: concurrentFile });
	writerA.remember("claude", ["a-new"]);
	writerB.remember("claude", ["b-new"]);
	assert.deepEqual(new BackendCommandCatalog(agents, { cwd: cwdA, cachePath: concurrentFile }).commandsFor("claude").map((entry) => entry.name), ["a-new"]);
	assert.deepEqual(new BackendCommandCatalog(agents, { cwd: cwdB, cachePath: concurrentFile }).commandsFor("claude").map((entry) => entry.name), ["b-new"]);
	const profileA = new BackendCommandCatalog(agents, {
		cwd: cwdA,
		cachePath: concurrentFile,
		environment: { ...process.env, CLAUDE_CONFIG_DIR: "profile-a" },
	});
	const profileB = new BackendCommandCatalog(agents, {
		cwd: cwdA,
		cachePath: concurrentFile,
		environment: { ...process.env, CLAUDE_CONFIG_DIR: "profile-b" },
	});
	profileA.remember("claude", ["profile-a-command"]);
	profileB.remember("claude", ["profile-b-command"]);
	profileA.invalidate("claude");
	assert.deepEqual(
		new BackendCommandCatalog(agents, {
			cwd: cwdA,
			cachePath: concurrentFile,
			environment: { ...process.env, CLAUDE_CONFIG_DIR: "profile-b" },
		}).commandsFor("claude"),
		[],
		"authentication invalidation removes every cached profile for the harness",
	);
	const executable = path.join(root, "custom-acp");
	fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n");
	fs.chmodSync(executable, 0o755);
	const executableAgents = { custom: { acp: { command: executable, args: [] } } };
	const executableCache = path.join(root, "executable.json");
	new BackendCommandCatalog(executableAgents, { cwd: cwdA, cachePath: executableCache }).remember("custom", ["before-upgrade"]);
	fs.appendFileSync(executable, "# upgraded\n");
	assert.deepEqual(
		new BackendCommandCatalog(executableAgents, { cwd: cwdA, cachePath: executableCache }).commandsFor("custom"),
		[],
		"an in-place adapter executable change invalidates its command scope",
	);

	const sensitiveCache = path.join(root, "sensitive.json");
	const sensitiveAgent = (password, sessionValue) => ({
		custom: {
			acp: { command: executable, args: [] },
			env: { PASSWORD: password, LOGIN_PIN: password },
			_sessionAuthEnv: { ACCOUNT_ALIAS: sessionValue },
		},
	});
	new BackendCommandCatalog(sensitiveAgent("first-password", "first-account"), {
		cwd: cwdA,
		cachePath: sensitiveCache,
	}).remember("custom", ["sensitive-command"]);
	assert.deepEqual(
		new BackendCommandCatalog(sensitiveAgent("second-password", "second-account"), {
			cwd: cwdA,
			cachePath: sensitiveCache,
		}).commandsFor("custom").map((entry) => entry.name),
		["sensitive-command"],
		"secret-like and session-auth values are presence-only cache inputs",
	);
	assert.deepEqual(
		new BackendCommandCatalog({ custom: { acp: { command: executable, args: [] } } }, {
			cwd: cwdA,
			cachePath: sensitiveCache,
		}).commandsFor("custom"),
		[],
		"credential presence remains part of the cache scope",
	);
	assert.doesNotMatch(fs.readFileSync(sensitiveCache, "utf8"), /first-password|first-account/u);

	const binDirectory = path.join(root, "bin");
	const extraPathA = path.join(root, "path-a");
	const extraPathB = path.join(root, "path-b");
	fs.mkdirSync(binDirectory);
	fs.mkdirSync(extraPathA);
	fs.mkdirSync(extraPathB);
	const bareCommand = "catalog-test-acp";
	const bareExecutable = path.join(binDirectory, `${bareCommand}${process.platform === "win32" ? ".EXE" : ""}`);
	fs.writeFileSync(bareExecutable, "test executable\n");
	fs.chmodSync(bareExecutable, 0o755);
	const pathAgents = { custom: { acp: { command: bareCommand, args: [] } } };
	const pathCache = path.join(root, "path.json");
	new BackendCommandCatalog(pathAgents, {
		cwd: cwdA,
		cachePath: pathCache,
		environment: { ...process.env, PATH: `${binDirectory}${path.delimiter}${extraPathA}` },
	}).remember("custom", ["path-stable"]);
	assert.deepEqual(
		new BackendCommandCatalog(pathAgents, {
			cwd: cwdA,
			cachePath: pathCache,
			environment: { ...process.env, PATH: `${binDirectory}${path.delimiter}${extraPathB}` },
		}).commandsFor("custom").map((entry) => entry.name),
		["path-stable"],
		"irrelevant PATH changes do not miss when the same executable resolves",
	);
	const missingAgents = { custom: { acp: { command: "missing-command-for-cache-test", args: [] } } };
	const missingCache = path.join(root, "missing-path.json");
	new BackendCommandCatalog(missingAgents, {
		cwd: cwdA,
		cachePath: missingCache,
		environment: { ...process.env, PATH: extraPathA },
	}).remember("custom", ["unresolved-path"]);
	assert.deepEqual(
		new BackendCommandCatalog(missingAgents, {
			cwd: cwdA,
			cachePath: missingCache,
			environment: { ...process.env, PATH: extraPathB },
		}).commandsFor("custom"),
		[],
		"PATH remains a fallback scope input when no executable can be resolved",
	);

	const adapterScript = path.join(cwdA, "adapter.mjs");
	fs.writeFileSync(adapterScript, "export const version = 1;\n");
	const scriptAgents = { custom: { acp: { command: process.execPath, args: [adapterScript] } } };
	const scriptCache = path.join(root, "script.json");
	new BackendCommandCatalog(scriptAgents, { cwd: cwdA, cachePath: scriptCache }).remember("custom", ["script-v1"]);
	fs.appendFileSync(adapterScript, "// version 2\n");
	assert.deepEqual(
		new BackendCommandCatalog(scriptAgents, { cwd: cwdA, cachePath: scriptCache }).commandsFor("custom"),
		[],
		"an in-place script behind a stable interpreter invalidates its command scope",
	);
	const fakeNpx = path.join(binDirectory, `npx${process.platform === "win32" ? ".EXE" : ""}`);
	fs.writeFileSync(fakeNpx, "test package launcher\n");
	fs.chmodSync(fakeNpx, 0o755);
	const packageRoot = path.join(cwdA, "node_modules", "catalog-test-package");
	fs.mkdirSync(packageRoot, { recursive: true });
	const packageJson = path.join(packageRoot, "package.json");
	fs.writeFileSync(packageJson, `${JSON.stringify({ name: "catalog-test-package", version: "1.0.0", main: "index.js" })}\n`);
	fs.writeFileSync(path.join(packageRoot, "index.js"), "export {};\n");
	const packageAgents = { custom: { acp: { command: "npx", args: ["--package", "catalog-test-package", "package-provided-command"] } } };
	const packageCache = path.join(root, "package.json.cache");
	const packageEnvironment = { ...process.env, PATH: binDirectory };
	new BackendCommandCatalog(packageAgents, {
		cwd: cwdA,
		cachePath: packageCache,
		environment: packageEnvironment,
	}).remember("custom", ["package-v1"]);
	fs.appendFileSync(path.join(packageRoot, "index.js"), "// in-place package update\n");
	assert.deepEqual(
		new BackendCommandCatalog(packageAgents, {
			cwd: cwdA,
			cachePath: packageCache,
			environment: packageEnvironment,
		}).commandsFor("custom"),
		[],
		"an in-place package behind a stable launcher invalidates its command scope",
	);

	if (process.platform !== "win32") {
		const shellScript = path.join(cwdA, "adapter.sh");
		fs.writeFileSync(shellScript, "#!/bin/sh\nexit 0\n");
		const shellAgents = { custom: { acp: { command: "/bin/sh", args: [shellScript] } } };
		const shellCache = path.join(root, "shell-script.json");
		new BackendCommandCatalog(shellAgents, { cwd: cwdA, cachePath: shellCache }).remember("custom", ["shell-v1"]);
		fs.appendFileSync(shellScript, "# shell update\n");
		assert.deepEqual(
			new BackendCommandCatalog(shellAgents, { cwd: cwdA, cachePath: shellCache }).commandsFor("custom"),
			[],
			"a shell script behind a stable shell executable invalidates its command scope",
		);

		const cwdAlias = path.join(root, "workspace-alias");
		const additionalDirectory = path.join(root, "additional");
		const additionalAlias = path.join(root, "additional-alias");
		fs.mkdirSync(additionalDirectory);
		fs.symlinkSync(cwdA, cwdAlias);
		fs.symlinkSync(additionalDirectory, additionalAlias);
		const canonicalCache = path.join(root, "canonical.json");
		new BackendCommandCatalog({ custom: { acp: { command: executable, args: [] }, additionalDirectories: [additionalDirectory] } }, {
			cwd: cwdA,
			cachePath: canonicalCache,
		}).remember("custom", ["canonical-command"]);
		assert.deepEqual(
			new BackendCommandCatalog({ custom: { acp: { command: executable, args: [] }, additionalDirectories: [additionalAlias] } }, {
				cwd: cwdAlias,
				cachePath: canonicalCache,
			}).commandsFor("custom").map((entry) => entry.name),
			["canonical-command"],
			"workspace and additional-directory symlink aliases share a canonical scope",
		);
	}

	const legacyCache = path.join(root, "legacy.json");
	fs.writeFileSync(legacyCache, `${JSON.stringify({
		version: 1,
		entries: {
			["0".repeat(64)]: {
				updatedAt: new Date().toISOString(),
				commands: [{ name: "legacy-private-command" }],
			},
		},
	})}\n`);
	new BackendCommandCatalog(agents, { cwd: cwdA, cachePath: legacyCache }).remember("claude", ["schema-v2"]);
	const migratedCache = fs.readFileSync(legacyCache, "utf8");
	assert.equal(JSON.parse(migratedCache).version, 2);
	assert.doesNotMatch(migratedCache, /legacy-private-command/u, "ownerless v1 metadata is dropped rather than retained");
	const ownerlessCache = path.join(root, "ownerless-v2.json");
	fs.writeFileSync(ownerlessCache, `${JSON.stringify({
		version: 2,
		entries: {
			["0".repeat(64)]: {
				updatedAt: new Date().toISOString(),
				commands: [{ name: "ownerless-private-command" }],
			},
		},
	})}\n`);
	new BackendCommandCatalog(agents, { cwd: cwdA, cachePath: ownerlessCache }).remember("claude", ["owned-v2"]);
	assert.doesNotMatch(
		fs.readFileSync(ownerlessCache, "utf8"),
		/ownerless-private-command/u,
		"v2 records without an owner are rejected so harness-wide invalidation stays complete",
	);

	const lockCache = path.join(root, "locked.json");
	new BackendCommandCatalog(agents, { cwd: cwdA, cachePath: lockCache }).remember("claude", ["before-lock"]);
	const lockDirectory = `${lockCache}.lock`;
	fs.mkdirSync(lockDirectory);
	fs.writeFileSync(path.join(lockDirectory, "owner"), "active-owner");
	let started = Date.now();
	assert.deepEqual(
		new BackendCommandCatalog(agents, { cwd: cwdA, cachePath: lockCache }).commandsFor("claude").map((entry) => entry.name),
		["before-lock"],
		"readers retain the last atomically published snapshot while a writer holds the lock",
	);
	assert.ok(Date.now() - started < 200, "cache reads remain nonblocking under lock contention");
	const lockedWriter = new BackendCommandCatalog(agents, { cwd: cwdA, cachePath: lockCache });
	started = Date.now();
	assert.equal(lockedWriter.remember("claude", ["while-locked"]), false);
	assert.ok(Date.now() - started < 200, "cache writes fail fast under lock contention");
	const staleTime = new Date(Date.now() - 20_000);
	fs.utimesSync(lockDirectory, staleTime, staleTime);
	assert.equal(lockedWriter.remember("claude", ["after-stale-lock"]), true, "a stale lock is reclaimed without polling");

	const invalidateCache = path.join(root, "invalidate-under-lock.json");
	const invalidator = new BackendCommandCatalog(agents, { cwd: cwdA, cachePath: invalidateCache });
	invalidator.remember("claude", ["old-account-command"]);
	const invalidateLock = `${invalidateCache}.lock`;
	fs.mkdirSync(invalidateLock);
	fs.writeFileSync(path.join(invalidateLock, "owner"), "active-owner");
	invalidator.invalidate("claude");
	fs.rmSync(invalidateLock, { recursive: true, force: true });
	invalidator.remember("codex", ["unrelated-command"]);
	assert.deepEqual(
		invalidator.commandsFor("claude"),
		[],
		"a later write cannot resurrect entries whose invalidation lost the lock race",
	);
	assert.doesNotMatch(
		fs.readFileSync(invalidateCache, "utf8"),
		/old-account-command/u,
		"the pending removal reaches disk with the next successful write",
	);

	const boundedFile = path.join(root, "bounded.json");
	new BackendCommandCatalog(agents, { cwd: cwdA, cachePath: boundedFile }).remember(
		"claude",
		Array.from({ length: 1_024 }, (_, index) => ({
			name: `large-${index}`,
			description: "😀".repeat(512),
			argumentHint: "😀".repeat(256),
		})),
	);
	const boundedCache = JSON.parse(fs.readFileSync(boundedFile, "utf8"));
	assert.ok(fs.statSync(boundedFile).size <= 1024 * 1024);
	assert.equal(Object.values(boundedCache.entries)[0].truncated, true, "a safety-budget truncation is explicit in cache metadata");

	const raw = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
	for (const entry of Object.values(raw.entries)) entry.updatedAt = "2000-01-01T00:00:00.000Z";
	fs.writeFileSync(cacheFile, `${JSON.stringify(raw)}\n`);
	assert.deepEqual(
		new BackendCommandCatalog(agents, { cwd: cwdA, cachePath: cacheFile }).commandsFor("claude"),
		[],
		"expired cache records are ignored",
	);

	fs.writeFileSync(cacheFile, "not json\n");
	assert.deepEqual(new BackendCommandCatalog(agents, { cwd: cwdA, cachePath: cacheFile }).commandsFor("claude"), []);

	const unwritableTarget = path.join(root, "cache-as-directory");
	fs.mkdirSync(unwritableTarget);
	assert.doesNotThrow(() => {
		const bestEffort = new BackendCommandCatalog(agents, { cwd: cwdA, cachePath: unwritableTarget });
		assert.equal(bestEffort.remember("claude", ["safe"]), false);
	});
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

assert.equal(backendCommandCachePath({ CC_DISABLE_COMMAND_CACHE: "1" }, "linux", "/home/example"), undefined);
assert.equal(
	backendCommandCachePath({ XDG_CACHE_HOME: "/cache" }, "linux", "/home/example"),
	path.join("/cache", "cc", "commands.json"),
);

// Integration: startup hints affect display only. They do not enter the live
// ACP stores or make a backend command local for dispatch.
{
	const config = { defaultAgent: "codex", agents: { codex: codexAgent }, theme: "system" };
	const catalog = new BackendCommandCatalog(config.agents, { cwd: process.cwd() });
	const app = new HarnessApp(config, "codex", "acp", { backendCommandCatalog: catalog });
	app.ui.requestRender = () => {};
	const names = app.displayCommandCatalog().map((command) => command.name);
	assert.ok(names.includes("goal"));
	assert.ok(!names.includes("logout"), "logout waits for the live capability so cc owns its full auth lifecycle");
	assert.equal(localSlashCommands(app).some((command) => command.name === "goal"), false);
	assert.equal(app.availableCommands.has("codex"), false);
	assert.equal(app.commandsLoaded.has("codex"), false);
	assert.equal(app.slashCommandRoute("goal", "finish the migration"), "backend");
	assert.equal(app.slashCommandRoute("goal", "view"), "local");

	const suggestions = await app.editor.autocompleteProvider.getSuggestions(
		["/g"],
		0,
		2,
		{ force: false, signal: new AbortController().signal },
	);
	assert.ok(suggestions.items.some((item) => item.value === "goal"), "Codex /goal is available on the first autocomplete pass");

	app.availableCommands.set("codex", [{
		name: "goal",
		description: "Live\u202espoof",
		input: { hint: "[<objective>|clear|pause|resume]" },
	}]);
	app.commandsLoaded.add("codex");
	assert.deepEqual(app.backendCommandsForDisplay(), [{
		name: "goal",
		description: "Live spoof",
		argumentHint: "[<objective>|clear|pause|resume]",
	}], "live ACP metadata uses the same safe display normalization as cached hints");

	app.availableCommands.set("codex", [{ name: "old-account-only" }]);
	app.commandsLoaded.add("codex");
	catalog.remember("codex", [{ name: "old-account-only" }], { persist: false });
	app.clearLiveBackendCommands("codex");
	assert.equal(app.commandsLoaded.has("codex"), false);
	assert.ok(app.backendCommandsForDisplay().some((command) => command.name === "old-account-only"));
	assert.equal(app.slashCommandRoute("old-account-only"), "backend", "replacement startup cold-forwards cached hints");
	catalog.invalidate("codex");
	assert.equal(
		app.backendCommandsForDisplay().some((command) => command.name === "old-account-only"),
		false,
		"auth invalidation removes account-scoped hints from display",
	);

	app.availableCommands.set("codex", []);
	app.commandsLoaded.add("codex");
	assert.equal(app.backendCommandsForDisplay().length, 0, "an authoritative empty live list replaces every hint");
	assert.equal(app.slashCommandRoute("goal", "finish the migration"), "unknown");
	assert.equal(app.slashCommandRoute("old-account-only"), "unknown");

	app.availableCommands.set("codex", [{ name: "main-live" }]);
	app.focusedThread = "btw";
	app.btwThread = { commandsLoaded: false, availableCommands: [] };
	assert.deepEqual(app.backendCommandsForDisplay(), [{ name: "main-live" }]);
	app.btwThread.commandsLoaded = true;
	assert.deepEqual(app.backendCommandsForDisplay(), [], "a side thread's empty live list is authoritative too");
	app.voiceController.dispose();
}

// When a live backend owns an overlapping command, autocomplete must describe
// the command that Enter will actually execute. Reserved local forms such as
// bare /config keep cc's unified description.
{
	const config = { defaultAgent: "claude", agents: { claude: claudeAgent }, theme: "system" };
	const app = new HarnessApp(config, "claude", "acp", {
		backendCommandCatalog: new BackendCommandCatalog(config.agents, { cwd: process.cwd() }),
	});
	app.ui.requestRender = () => {};
	const cold = new Map(app.displayCommandCatalog().map((command) => [command.name, command]));
	assert.equal(cold.get("status").description, "Show current session status");
	assert.equal(cold.get("init").description, "Generate repository guidance in AGENTS.md");
	assert.equal(app.slashCommandRoute("init"), "local", "startup hints never become routing authority");
	app.availableCommands.set("claude", [
		{ name: "init", description: "Initialize native Claude project memory" },
		{ name: "fast", description: "Toggle native Claude fast mode" },
		{ name: "status", description: "Show native Claude status" },
		{ name: "config", description: "Configure Claude with key=value" },
	]);
	app.commandsLoaded.add("claude");
	const displayed = new Map(app.displayCommandCatalog().map((command) => [command.name, command]));
	assert.equal(displayed.get("init").description, "Initialize native Claude project memory");
	assert.equal(displayed.get("fast").description, "Toggle native Claude fast mode");
	assert.equal(displayed.get("status").description, "Show native Claude status");
	assert.equal(displayed.get("config").description, "Change any configuration option advertised by the agent");
	app.voiceController.dispose();
}

console.log("backend command catalog: immediate hints, private cache, live authority, routing isolation");
