import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	CHANNEL_ADAPTERS,
	atomicReplaceLink,
	betaStateEnvironment,
	channelPaths,
	installChannel,
	installDependencies,
	inspectAdapter,
	inspectNativePayloads,
	npmInvocation,
	parseArgs,
	printResult,
	pruneChannelReleases,
	renderChannelRunner,
	renderLauncher,
	verifyRelease,
	versionAtLeast,
} from "../scripts/install-channel.mjs";

async function waitForFile(file, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(file)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for test handshake ${file}`);
}

assert.deepEqual(parseArgs(["stable"]), {
	target: "stable",
	ref: undefined,
	repo: undefined,
	root: undefined,
	binDir: undefined,
	rollback: false,
});
assert.deepEqual(parseArgs(["beta", "--ref", "HEAD", "--rollback"]), {
	target: "beta",
	ref: "HEAD",
	repo: undefined,
	root: undefined,
	binDir: undefined,
	rollback: true,
});
assert.throws(() => parseArgs(["all", "--ref", "HEAD"]), /cannot be used with all/);
assert.throws(() => parseArgs(["unknown"]), /unknown channel/);

assert.equal(versionAtLeast("1.1.2", "1.1.2"), true);
assert.equal(versionAtLeast("1.2.0", "1.1.2"), true);
assert.equal(versionAtLeast("1.1.1", "1.1.2"), false);
assert.equal(versionAtLeast("1.1.2-beta.1", "1.1.2"), false);

{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-channel-windows-npm-"));
	try {
		const node = path.join(root, "node.exe");
		const npmCli = path.join(root, "node_modules", "npm", "bin", "npm-cli.js");
		fs.mkdirSync(path.dirname(npmCli), { recursive: true });
		fs.writeFileSync(npmCli, "// npm fixture\n");
		assert.deepEqual(npmInvocation({ platform: "win32", execPath: node, env: {} }), {
			command: path.resolve(node),
			prefixArgs: [path.resolve(npmCli)],
		});
		assert.deepEqual(npmInvocation({ platform: "linux", env: {} }), {
			command: "npm",
			prefixArgs: [],
		});

		const detachedNode = path.join(root, "runtime", "node.exe");
		const npmOnPath = path.join(root, "npm-bin");
		const npmOnPathCli = path.join(npmOnPath, "node_modules", "npm", "bin", "npm-cli.js");
		fs.mkdirSync(path.dirname(npmOnPathCli), { recursive: true });
		fs.writeFileSync(npmOnPathCli, "// npm PATH fixture\n");
		assert.deepEqual(npmInvocation({
			platform: "win32",
			execPath: detachedNode,
			env: { PATH: `${path.join(root, "missing")};${npmOnPath}` },
		}), {
			command: path.resolve(detachedNode),
			prefixArgs: [path.resolve(npmOnPathCli)],
		});

		const release = path.join(root, "release");
		fs.mkdirSync(release);
		fs.writeFileSync(path.join(release, "package.json"), JSON.stringify({
			dependencies: Object.fromEntries(CHANNEL_ADAPTERS.map((adapter) => [adapter.package, "1.0.0"])),
		}));
		const calls = [];
		installDependencies(release, (command, args, options) => {
			calls.push({ command, args, options });
			return { status: 0 };
		}, { channel: "beta", platform: "win32", execPath: node });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].command, path.resolve(node));
		assert.deepEqual(calls[0].args.slice(0, 2), [path.resolve(npmCli), "ci"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

{
	const paths = channelPaths("beta", { home: "/home/tester", env: {} });
	assert.equal(paths.root, path.resolve("/home/tester/.local/share/cc"));
	assert.equal(paths.launcher, path.resolve("/home/tester/.local/bin/cc2"));
	const state = betaStateEnvironment(paths);
	assert.equal(state.CC_CONFIG, path.join(paths.channelDir, "state", "config", "config.json"));
	assert.equal(state.CC_COMMAND_CACHE, path.join(paths.channelDir, "state", "cache", "commands.json"));
	assert.equal(state.CC_FORKS, undefined, "fork lineage is operational shared state, not beta wrapper state");
	const beta = renderLauncher("beta", paths);
	if (process.platform !== "win32") {
		const syntax = spawnSync("sh", ["-n"], { input: beta, encoding: "utf8" });
		assert.equal(syntax.status, 0, syntax.stderr);
	}
	assert.match(beta, /export CC_CHANNEL='beta'/);
	assert.match(beta, /cc-channel-runner-protocol: 1/u);
	for (const [name, value] of Object.entries(state)) assert.match(beta, new RegExp(`export ${name}='${value}'`));
	assert.match(beta, /if \[ -z "\$\{CC_FORKS:-\}" \]/);
	assert.match(beta, new RegExp(`export CC_FORKS='${paths.sharedForksPath}'`));
	assert.match(beta, new RegExp(`export CC_FORKS_MIGRATE_FROM='${path.join(paths.channelDir, "state", "config", "forks.json")}'`));
	assert.match(beta, /CURRENT_LINK=/);
	assert.match(beta, /channel-runner\.mjs' "\$CURRENT_LINK"/);
	assert.match(renderChannelRunner(), /node_modules.*\.bin/su);
	assert.match(beta, /CC_NODE_PATH:-node/);

	const stable = renderLauncher("stable", channelPaths("stable", { home: "/home/tester", env: {} }));
	assert.match(stable, /export CC_CHANNEL='stable'/);
	assert.doesNotMatch(stable, /CC_CONFIG=/);
	assert.match(stable, /if \[ "\$\{CC_CHANNEL:-\}" = 'beta' \]/);
	assert.match(stable, /unset CC_CONFIG CC_SETTINGS CC_PERMISSIONS CC_COMMAND_CACHE/);
	assert.match(stable, /unset CC_FORKS/);
	assert.match(stable, /unset CC_FORKS_MIGRATE_FROM/);

	const windowsPaths = channelPaths("beta", {
		home: "/home/tester",
		env: {},
		platform: "win32",
	});
	assert.equal(windowsPaths.launcher, path.resolve("/home/tester/.local/bin/cc2.cmd"));
	const windows = renderLauncher("beta", windowsPaths);
	assert.ok(windows.startsWith("@echo off\r\n"));
	assert.match(windows, /cc-channel-runner-protocol: 1/u);
	assert.match(windows, /setlocal DisableDelayedExpansion/);
	assert.match(windows, /set "CC_CHANNEL=beta"/);
	assert.match(windows, /if not defined CC_FORKS \(/);
	assert.match(windows, /set "CC_FORKS_MIGRATE_FROM=.*state[\\/]config[\\/]forks\.json"/);
	assert.match(windows, /set "CC_CONFIG=/);
	assert.match(windows, /set "CURRENT_LINK=/);
	assert.match(windows, /if defined CC_NODE_PATH/);
	assert.match(windows, /channel-runner\.mjs" "%CURRENT_LINK%" .*[\\/]leases" %\*/);
	assert.equal(windows.match(/%CURRENT_LINK%/g)?.length, 1);

	const stableWindows = renderLauncher("stable", channelPaths("stable", {
		home: "/home/tester",
		env: {},
		platform: "win32",
	}));
	assert.match(stableWindows, /if \/I "%CC_CHANNEL%"=="beta"/);
	for (const name of Object.keys(state)) assert.match(stableWindows, new RegExp(`set "${name}="`));
	assert.match(stableWindows, /set "CC_FORKS="/);
	assert.match(stableWindows, /set "CC_FORKS_MIGRATE_FROM="/);
}

// The thin launcher delegates atomic resolution/lease publication to the Node
// runner and preserves channel state semantics. Stable only clears isolated beta
// state when it actually inherited beta; standalone overrides remain intact.
if (process.platform !== "win32") {
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cc-channel-launcher-"));
	try {
		const paths = channelPaths("stable", {
			root: path.join(temporary, "share", "cc"),
			binDir: path.join(temporary, "bin"),
		});
		const releaseA = path.join(paths.releasesDir, "a".repeat(40));
		const releaseB = path.join(paths.releasesDir, "b".repeat(40));
		for (const release of [releaseA, releaseB]) fs.mkdirSync(path.join(release, "src"), { recursive: true });
		fs.mkdirSync(paths.binDir, { recursive: true });
		fs.symlinkSync(path.relative(path.dirname(paths.currentLink), releaseA), paths.currentLink);
		fs.writeFileSync(paths.launcher, renderLauncher("stable", paths), { mode: 0o755 });
		fs.chmodSync(paths.launcher, 0o755);
		const nodeFixture = path.join(temporary, "node-fixture");
		fs.writeFileSync(nodeFixture, [
			"#!/bin/sh",
			'printf \'%s\\n\' "$1" "$2" "$3" "$CC_CHANNEL" "${CC_CONFIG-<unset>}" "${CC_SETTINGS-<unset>}" "${CC_PERMISSIONS-<unset>}" "${CC_FORKS-<unset>}" "${CC_COMMAND_CACHE-<unset>}" "${CC_FORKS_MIGRATE_FROM-<unset>}"',
			"",
		].join("\n"), { mode: 0o755 });
		fs.chmodSync(nodeFixture, 0o755);
		const baseEnvironment = {
			...process.env,
			CC_NODE_PATH: nodeFixture,
		};
		const betaEnvironment = {
			...baseEnvironment,
			CC_CHANNEL: "beta",
			CC_CONFIG: "beta-config",
			CC_SETTINGS: "beta-settings",
			CC_PERMISSIONS: "beta-permissions",
			CC_FORKS: path.join(paths.root, "channels", "beta", "state", "config", "forks.json"),
			CC_COMMAND_CACHE: "beta-cache",
		};
		const inherited = spawnSync(paths.launcher, [], { env: betaEnvironment, encoding: "utf8" });
		assert.equal(inherited.status, 0, inherited.stderr);
		assert.deepEqual(inherited.stdout.trimEnd().split("\n"), [
			paths.runner,
			paths.currentLink,
			paths.leasesDir,
			"stable",
			"<unset>",
			"<unset>",
			"<unset>",
			"<unset>",
			"<unset>",
			"<unset>",
		]);
		const standaloneEnvironment = {
			...baseEnvironment,
			CC_CHANNEL: "standalone",
			CC_CONFIG: "custom-config",
			CC_SETTINGS: "custom-settings",
			CC_PERMISSIONS: "custom-permissions",
			CC_FORKS: "custom-forks",
			CC_COMMAND_CACHE: "custom-cache",
		};
		const standalone = spawnSync(paths.launcher, [], { env: standaloneEnvironment, encoding: "utf8" });
		assert.equal(standalone.status, 0, standalone.stderr);
		assert.deepEqual(standalone.stdout.trimEnd().split("\n").slice(3), [
			"stable",
			"custom-config",
			"custom-settings",
			"custom-permissions",
			"custom-forks",
			"custom-cache",
			"<unset>",
		]);
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
}

if (process.platform !== "win32") {
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cc-channel-shared-forks-"));
	try {
		const paths = channelPaths("beta", {
			home: temporary,
			root: path.join(temporary, "share", "cc"),
			binDir: path.join(temporary, "bin"),
		});
		const release = path.join(paths.releasesDir, "a".repeat(40));
		fs.mkdirSync(path.join(release, "src"), { recursive: true });
		fs.mkdirSync(paths.binDir, { recursive: true });
		fs.symlinkSync(path.relative(path.dirname(paths.currentLink), release), paths.currentLink);
		fs.writeFileSync(paths.launcher, renderLauncher("beta", paths), { mode: 0o755 });
		fs.chmodSync(paths.launcher, 0o755);
		const nodeFixture = path.join(temporary, "node-fixture");
		fs.writeFileSync(nodeFixture, "#!/bin/sh\nprintf '%s\\n' \"$CC_FORKS\" \"${CC_FORKS_MIGRATE_FROM-<unset>}\"\n", { mode: 0o755 });
		fs.chmodSync(nodeFixture, 0o755);
		const baseEnvironment = { ...process.env, CC_NODE_PATH: nodeFixture };
		delete baseEnvironment.CC_FORKS;
		const defaulted = spawnSync(paths.launcher, [], { env: baseEnvironment, encoding: "utf8" });
		assert.equal(defaulted.status, 0, defaulted.stderr);
		assert.deepEqual(defaulted.stdout.trim().split("\n"), [
			paths.sharedForksPath,
			path.join(paths.channelDir, "state", "config", "forks.json"),
		]);
		const overridden = spawnSync(paths.launcher, [], {
			env: {
				...baseEnvironment,
				CC_FORKS: path.join(temporary, "custom-forks.json"),
				CC_FORKS_MIGRATE_FROM: "stale-hint",
			},
			encoding: "utf8",
		});
		assert.equal(overridden.status, 0, overridden.stderr);
		assert.deepEqual(overridden.stdout.trim().split("\n"), [
			path.join(temporary, "custom-forks.json"),
			"<unset>",
		]);
		const inheritedLegacy = spawnSync(paths.launcher, [], {
			env: {
				...baseEnvironment,
				CC_FORKS: path.join(paths.channelDir, "state", "config", "forks.json"),
				CC_FORKS_MIGRATE_FROM: "stale-hint",
			},
			encoding: "utf8",
		});
		assert.equal(inheritedLegacy.status, 0, inheritedLegacy.stderr);
		assert.deepEqual(inheritedLegacy.stdout.trim().split("\n"), [
			paths.sharedForksPath,
			path.join(paths.channelDir, "state", "config", "forks.json"),
		]);
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
}

// The generated runner preserves src/cc.mjs's direct-entrypoint contract while
// holding and then cleaning the exact release lease used by GC.
{
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cc-channel-runner-"));
	try {
		const runner = path.join(temporary, "channel-runner.mjs");
		const releaseId = "a".repeat(40);
		const release = path.join(temporary, "releases", releaseId);
		const entrypoint = path.join(release, "src", "cc.mjs");
		const current = path.join(temporary, "current");
		const leases = path.join(temporary, "leases");
		const resultFile = path.join(temporary, "result.json");
		fs.writeFileSync(runner, renderChannelRunner(), { mode: 0o755 });
		fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
		fs.symlinkSync(path.relative(path.dirname(current), release), current);
		fs.writeFileSync(entrypoint, [
			'import fs from "node:fs";',
			'import { pathToFileURL } from "node:url";',
			'if (import.meta.url !== pathToFileURL(process.argv[1]).href) process.exit(9);',
			'const leaseFiles = fs.readdirSync(process.env.TEST_LEASE_DIR);',
			'fs.writeFileSync(process.env.TEST_RESULT, JSON.stringify({ argv: process.argv.slice(1), lease: leaseFiles.length === 1, path: process.env.PATH.split(process.platform === "win32" ? ";" : ":")[0] }));',
			"",
		].join("\n"));
		const result = spawnSync(process.execPath, [runner, current, leases, "alpha", "beta"], {
			env: { ...process.env, TEST_RESULT: resultFile, TEST_LEASE_DIR: path.join(leases, releaseId) },
			encoding: "utf8",
		});
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(fs.readFileSync(resultFile, "utf8")), {
			argv: [fs.realpathSync(entrypoint), "alpha", "beta"],
			lease: true,
			path: path.join(fs.realpathSync(release), "node_modules", ".bin"),
		});
		// Exit removes only the lease file; the lease directory is left for
		// guard-holding GC so an exiting runner can never rmdir between a starting
		// runner's mkdir and its lease write.
		assert.deepEqual(fs.readdirSync(path.join(leases, releaseId)), []);
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
}

// Lease publication is mandatory: an injected write failure must abort before
// the release entrypoint is imported, otherwise GC could retire an unleased TUI.
{
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cc-channel-runner-lease-failure-"));
	try {
		const runner = path.join(temporary, "channel-runner.mjs");
		const releaseId = "c".repeat(40);
		const release = path.join(temporary, "releases", releaseId);
		const entrypoint = path.join(release, "src", "cc.mjs");
		const current = path.join(temporary, "current");
		const leaseDir = path.join(temporary, "leases", releaseId);
		const imported = path.join(temporary, "imported");
		const ordinaryRunner = renderChannelRunner();
		const failingRunner = ordinaryRunner.replace(
			"fs.writeFileSync(leasePath,",
			'if (process.env.TEST_FAIL_LEASE === "1") throw new Error("injected lease publication failure");\n\tfs.writeFileSync(leasePath,',
		);
		assert.notEqual(failingRunner, ordinaryRunner, "lease failure hook was injected");
		fs.writeFileSync(runner, failingRunner, { mode: 0o755 });
		fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
		fs.writeFileSync(entrypoint, 'import fs from "node:fs"; fs.writeFileSync(process.env.TEST_IMPORTED, "yes");\n');
		fs.symlinkSync(release, current);
		fs.mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
		const result = spawnSync(process.execPath, [runner, current, path.dirname(leaseDir)], {
			env: { ...process.env, TEST_IMPORTED: imported, TEST_FAIL_LEASE: "1" },
			encoding: "utf8",
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /release startup failed/u);
		assert.equal(fs.existsSync(imported), false, "entrypoint is never imported without a durable lease");
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
}

// A runner blocked behind GC cannot resolve an about-to-be-retired release.
// Once the guard is released it resolves the new current and establishes that
// release's lease, closing the old resolve-then-placeholder TOCTOU window.
if (process.platform !== "win32") {
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cc-channel-runner-gc-race-"));
	try {
		const runner = path.join(temporary, "channel-runner.mjs");
		const releases = path.join(temporary, "releases");
		const current = path.join(temporary, "current");
		const leases = path.join(temporary, "leases");
		const resultFile = path.join(temporary, "selected.txt");
		const waitingFile = path.join(temporary, "waiting.txt");
		const ordinaryRunner = renderChannelRunner();
		const instrumentedRunner = ordinaryRunner.replace(
			"\t\t\tawait wait(25);",
			'\t\t\tif (process.env.TEST_GUARD_WAITING) fs.writeFileSync(process.env.TEST_GUARD_WAITING, "waiting");\n\t\t\tawait wait(25);',
		);
		assert.notEqual(instrumentedRunner, ordinaryRunner, "guard wait handshake was injected");
		fs.writeFileSync(runner, instrumentedRunner, { mode: 0o755 });
		const releaseIds = ["a".repeat(40), "b".repeat(40)];
		for (const releaseId of releaseIds) {
			const entrypoint = path.join(releases, releaseId, "src", "cc.mjs");
			fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
			fs.writeFileSync(entrypoint, `import fs from "node:fs"; fs.writeFileSync(process.env.TEST_RESULT, ${JSON.stringify(releaseId)});\n`);
		}
		fs.symlinkSync(path.join(releases, releaseIds[0]), current);
		const guard = path.join(temporary, ".launch-gc-lock");
		fs.mkdirSync(guard);
		const child = spawn(process.execPath, [runner, current, leases], {
			env: { ...process.env, TEST_RESULT: resultFile, TEST_GUARD_WAITING: waitingFile },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		await waitForFile(waitingFile);
		assert.equal(fs.existsSync(resultFile), false, "runner waits before resolving current while GC owns the guard");
		fs.rmSync(current);
		fs.symlinkSync(path.join(releases, releaseIds[1]), current);
		fs.renameSync(path.join(releases, releaseIds[0]), path.join(releases, `.retired-${releaseIds[0]}`));
		fs.rmSync(guard, { recursive: true });
		const exitCode = await new Promise((resolve) => child.once("close", resolve));
		assert.equal(exitCode, 0, stderr);
		assert.equal(fs.readFileSync(resultFile, "utf8"), releaseIds[1]);
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
}

// GC removes only inactive releases created by this installer. The current and
// previous snapshots, active/recent launch leases, staging directories, and
// unknown hash-named directories are all fail-safe preserves.
{
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cc-channel-gc-"));
	try {
		const paths = channelPaths("beta", {
			home: temporary,
			root: path.join(temporary, "share", "cc"),
			binDir: path.join(temporary, "bin"),
		});
		fs.mkdirSync(paths.releasesDir, { recursive: true });
		fs.mkdirSync(paths.leasesDir, { recursive: true });
		const ids = Object.fromEntries(
			["current", "previous", "old", "active", "launching", "legacy", "migration", "retry", "unknown"]
				.map((name, index) => [name, String(index + 1).repeat(40)]),
		);
		const makeManaged = (id, leaseProtocol = 1) => {
			const directory = path.join(paths.releasesDir, id);
			fs.mkdirSync(directory);
			fs.writeFileSync(path.join(directory, ".cc-channel.json"), JSON.stringify({ channel: "beta", commit: id, leaseProtocol }));
			return directory;
		};
		for (const name of ["current", "previous", "old", "active", "launching", "migration", "retry"]) makeManaged(ids[name]);
		makeManaged(ids.legacy, null);
		fs.writeFileSync(path.join(paths.releasesDir, ids.migration, ".cc-unguarded-launch"), "protected\n");
		const retryTombstone = path.join(paths.releasesDir, `.${ids.retry}.gc-123-456`);
		fs.renameSync(path.join(paths.releasesDir, ids.retry), retryTombstone);
		const unknown = path.join(paths.releasesDir, ids.unknown);
		fs.mkdirSync(unknown);
		fs.writeFileSync(path.join(unknown, ".cc-channel.json"), JSON.stringify({ channel: "other", commit: ids.unknown }));
		const staging = path.join(paths.releasesDir, `.${ids.old}.staging-test`);
		fs.mkdirSync(staging);
		fs.symlinkSync(path.relative(path.dirname(paths.currentLink), path.join(paths.releasesDir, ids.current)), paths.currentLink);
		fs.symlinkSync(path.relative(path.dirname(paths.previousLink), path.join(paths.releasesDir, ids.previous)), paths.previousLink);

		const activeLeaseDir = path.join(paths.leasesDir, ids.active);
		fs.mkdirSync(activeLeaseDir);
		fs.writeFileSync(path.join(activeLeaseDir, "active"), JSON.stringify({ pid: 4242 }));
		const launchingLeaseDir = path.join(paths.leasesDir, ids.launching);
		fs.mkdirSync(launchingLeaseDir);
		fs.writeFileSync(path.join(launchingLeaseDir, "launching"), "launching\n");

		const now = Date.now();
		const first = pruneChannelReleases("beta", paths, {
			now,
			processIsAlive: (pid) => pid === 4242,
		});
		assert.deepEqual(first.removed, [ids.old]);
		assert.deepEqual(first.retried, [ids.retry]);
		assert.deepEqual(new Set(first.inUse), new Set([ids.active, ids.launching]));
		assert.deepEqual(new Set(first.legacy), new Set([ids.legacy, ids.migration]));
		assert.deepEqual(first.unknown, [ids.unknown]);
		for (const name of ["current", "previous", "active", "launching", "legacy", "migration", "unknown"]) {
			assert.equal(fs.existsSync(path.join(paths.releasesDir, ids[name])), true, name);
		}
		assert.equal(fs.existsSync(retryTombstone), false, "recognized interrupted cleanup is retried");
		assert.equal(fs.existsSync(staging), true);

		const second = pruneChannelReleases("beta", paths, {
			now: now + 2 * 60_000,
			processIsAlive: () => false,
		});
		assert.deepEqual(new Set(second.removed), new Set([ids.active, ids.launching]));
		assert.equal(fs.existsSync(path.join(paths.releasesDir, ids.current)), true);
		assert.equal(fs.existsSync(path.join(paths.releasesDir, ids.previous)), true);
		assert.equal(fs.existsSync(unknown), true);
		assert.equal(fs.existsSync(path.join(paths.releasesDir, ids.legacy)), true);
		assert.equal(fs.existsSync(path.join(paths.releasesDir, ids.migration)), true);
		assert.equal(fs.existsSync(staging), true);
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
}

// Runtime-lock recovery is ownership-safe: launch/GC never guesses about an
// ownerless claim, while the installer can reclaim a complete claim whose PID
// is conclusively dead. Pointer validation failures abort all deletion.
{
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cc-channel-gc-guard-safety-"));
	try {
		const paths = channelPaths("beta", {
			home: temporary,
			root: path.join(temporary, "share", "cc"),
			binDir: path.join(temporary, "bin"),
		});
		fs.mkdirSync(paths.releasesDir, { recursive: true });
		fs.mkdirSync(paths.leasesDir, { recursive: true });
		const currentId = "a".repeat(40);
		const oldId = "b".repeat(40);
		const makeManaged = (id) => {
			const directory = path.join(paths.releasesDir, id);
			fs.mkdirSync(directory);
			fs.writeFileSync(path.join(directory, ".cc-channel.json"), JSON.stringify({
				channel: "beta",
				commit: id,
				leaseProtocol: 1,
			}));
		};
		makeManaged(currentId);
		makeManaged(oldId);
		fs.symlinkSync(path.relative(path.dirname(paths.currentLink), path.join(paths.releasesDir, currentId)), paths.currentLink);

		fs.mkdirSync(paths.runtimeLockDir);
		const ownerless = pruneChannelReleases("beta", paths, {
			runtimeLockOptions: { waitMs: 0, retryMs: 0, processIsAlive: () => false },
		});
		assert.equal(ownerless.errors.length, 1);
		assert.equal(ownerless.startupBlocked, true);
		assert.equal(fs.existsSync(path.join(paths.releasesDir, oldId)), true, "ownerless guard is never guessed stale");
		assert.equal(fs.existsSync(paths.runtimeLockDir), true);

		fs.writeFileSync(path.join(paths.runtimeLockDir, "owner.json"), JSON.stringify({
			pid: 424242,
			token: "complete-dead-owner",
		}));
		const recovered = pruneChannelReleases("beta", paths, {
			runtimeLockOptions: { waitMs: 50, retryMs: 0, processIsAlive: () => false },
		});
		assert.equal(recovered.errors.length, 0, recovered.errors.map((error) => error.message).join("\n"));
		assert.equal(recovered.startupBlocked, false);
		assert.deepEqual(recovered.removed, [oldId]);
		assert.equal(fs.existsSync(paths.runtimeLockDir), false);

		makeManaged(oldId);
		fs.rmSync(paths.currentLink);
		fs.writeFileSync(paths.currentLink, "temporarily unreadable pointer fixture\n");
		const invalidPointer = pruneChannelReleases("beta", paths);
		assert.equal(invalidPointer.errors.length > 0, true);
		assert.deepEqual(invalidPointer.removed, []);
		assert.equal(fs.existsSync(path.join(paths.releasesDir, oldId)), true, "pointer errors fail closed");

		fs.rmSync(paths.currentLink);
		const retiredCurrent = path.join(paths.releasesDir, `.${currentId}.gc-123-456`);
		fs.renameSync(path.join(paths.releasesDir, currentId), retiredCurrent);
		fs.symlinkSync(path.relative(path.dirname(paths.currentLink), retiredCurrent), paths.currentLink);
		const tombstonePointer = pruneChannelReleases("beta", paths);
		assert.equal(tombstonePointer.errors.length > 0, true);
		assert.deepEqual(tombstonePointer.retried, []);
		assert.equal(fs.existsSync(retiredCurrent), true, "a pointer target is never retried as interrupted cleanup");
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
}

// A runtime-guard failure blocks the same startup path used by every launcher;
// do not mislabel it as harmless old-snapshot cleanup or hide its location.
{
	const warnings = [];
	const originalWarn = console.warn;
	const originalLog = console.log;
	console.warn = (message) => warnings.push(String(message));
	console.log = () => {};
	try {
		printResult({
			channel: "beta",
			command: "cc2",
			ref: "ux-0711",
			commit: "a".repeat(40),
			releaseDir: "/tmp/release",
			launcher: "/tmp/cc2",
			garbageCollection: {
				errors: [new Error("timed out waiting for channel startup; inspect /tmp/.launch-gc-lock")],
				startupBlocked: true,
			},
		});
	} finally {
		console.warn = originalWarn;
		console.log = originalLog;
	}
	const output = warnings.join("\n");
	assert.match(output, /inspect \/tmp\/\.launch-gc-lock/u);
	assert.match(output, /channel launches are blocked/u);
	assert.match(output, /rerun the channel installer/u);
}

// Windows junction replacement keeps the old pointer recoverable until the
// fully-created replacement has been published. Simulate a failure on that
// second rename even when this test runs on POSIX.
{
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cc-channel-junction-swap-"));
	try {
		const first = path.join(temporary, "release-a");
		const second = path.join(temporary, "release-b");
		const current = path.join(temporary, "current");
		fs.mkdirSync(first);
		fs.mkdirSync(second);
		fs.symlinkSync(first, current, process.platform === "win32" ? "junction" : undefined);
		let renames = 0;
		assert.throws(() => atomicReplaceLink(current, second, {
			platform: "win32",
			renameSync(source, destination) {
				renames += 1;
				if (renames === 2) {
					const error = new Error("injected replacement failure");
					error.code = "EIO";
					throw error;
				}
				fs.renameSync(source, destination);
			},
		}), /injected replacement failure/);
		assert.equal(fs.realpathSync(current), fs.realpathSync(first));
		assert.equal(
			fs.readdirSync(temporary).some((entry) => entry.startsWith(".current.old-") || entry.startsWith(".current.tmp-")),
			false,
		);
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
}

function makeAdapterFixture(releaseDir, adapter, version = "1.0.0") {
	const packageDir = path.join(releaseDir, "node_modules", ...adapter.package.split("/"));
	const entrypoint = path.join(packageDir, "dist", "index.js");
	const binDir = path.join(releaseDir, "node_modules", ".bin");
	fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
	fs.mkdirSync(binDir, { recursive: true });
	fs.writeFileSync(
		path.join(packageDir, "package.json"),
		JSON.stringify({ name: adapter.package, version, bin: { [adapter.bin]: "dist/index.js" } }),
	);
	fs.writeFileSync(entrypoint, "#!/usr/bin/env node\n");
	const shim = path.join(binDir, process.platform === "win32" ? `${adapter.bin}.cmd` : adapter.bin);
	fs.writeFileSync(shim, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
	if (process.platform !== "win32") fs.chmodSync(shim, 0o755);
}

function makeReleaseFixture(releaseDir) {
	fs.mkdirSync(path.join(releaseDir, "src"), { recursive: true });
	fs.writeFileSync(path.join(releaseDir, "package.json"), JSON.stringify({ name: "cc" }));
	fs.writeFileSync(path.join(releaseDir, "package-lock.json"), "{}\n");
	fs.writeFileSync(path.join(releaseDir, "src", "cc.mjs"), "#!/usr/bin/env node\n");
	fs.writeFileSync(path.join(releaseDir, "src", "pi-harness.mjs"), "// harness\n");
	for (const adapter of CHANNEL_ADAPTERS) {
		makeAdapterFixture(releaseDir, adapter, adapter.minimumVersion ?? "0.58.1");
	}
	const linuxMusl = process.platform === "linux" && !process.report?.getReport?.()?.header?.glibcVersionRuntime;
	const claudeSuffix = linuxMusl ? `linux-${process.arch}-musl` : `${process.platform}-${process.arch}`;
	const claudeNativeName = `@anthropic-ai/claude-agent-sdk-${claudeSuffix}`;
	const codexNativeName = `@openai/codex-${process.platform}-${process.arch}`;
	const claudeSdk = path.join(releaseDir, "node_modules", "@anthropic-ai", "claude-agent-sdk");
	const codexCli = path.join(releaseDir, "node_modules", "@openai", "codex");
	const claudeNative = path.join(releaseDir, "node_modules", ...claudeNativeName.split("/"));
	const codexNative = path.join(releaseDir, "node_modules", ...codexNativeName.split("/"));
	fs.mkdirSync(claudeSdk, { recursive: true });
	fs.mkdirSync(codexCli, { recursive: true });
	fs.mkdirSync(claudeNative, { recursive: true });
	fs.mkdirSync(path.join(codexNative, "vendor", "test-target", "bin"), { recursive: true });
	fs.writeFileSync(path.join(claudeSdk, "package.json"), JSON.stringify({
		name: "@anthropic-ai/claude-agent-sdk",
		optionalDependencies: { [claudeNativeName]: "1.0.0" },
	}));
	fs.writeFileSync(path.join(codexCli, "package.json"), JSON.stringify({
		name: "@openai/codex",
		optionalDependencies: { [codexNativeName]: "npm:@openai/codex@1.0.0-test" },
	}));
	fs.writeFileSync(path.join(claudeNative, "package.json"), JSON.stringify({ name: claudeNativeName, version: "1.0.0" }));
	fs.writeFileSync(path.join(codexNative, "package.json"), JSON.stringify({ name: "@openai/codex", version: "1.0.0-test" }));
	const claudeBinary = path.join(claudeNative, process.platform === "win32" ? "claude.exe" : "claude");
	const codexBinary = path.join(codexNative, "vendor", "test-target", "bin", process.platform === "win32" ? "codex.exe" : "codex");
	fs.writeFileSync(claudeBinary, "native\n");
	fs.writeFileSync(codexBinary, "native\n");
	if (process.platform !== "win32") {
		fs.chmodSync(claudeBinary, 0o755);
		fs.chmodSync(codexBinary, 0o755);
	}
}

function makeDirectoryLink(target, link) {
	const resolvedTarget = process.platform === "win32"
		? path.resolve(path.dirname(link), target)
		: target;
	fs.symlinkSync(resolvedTarget, link, process.platform === "win32" ? "junction" : undefined);
}

{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-channel-adapter-"));
	try {
		makeReleaseFixture(root);
		for (const adapter of CHANNEL_ADAPTERS) {
			const installed = inspectAdapter(root, adapter);
			assert.equal(installed.package, adapter.package);
		}
		const payloads = inspectNativePayloads(root);
		assert.ok(fs.existsSync(payloads.claude.binary));
		assert.ok(fs.existsSync(payloads.codex.binary));
		const codexNativeManifest = path.join(
			root,
			"node_modules",
			"@openai",
			`codex-${process.platform}-${process.arch}`,
			"package.json",
		);
		const expectedCodexNative = JSON.parse(fs.readFileSync(codexNativeManifest, "utf8"));
		fs.writeFileSync(codexNativeManifest, JSON.stringify({ ...expectedCodexNative, version: "0.0.0-stale" }));
		assert.throws(() => inspectNativePayloads(root), /native payload mismatch/u);
		fs.writeFileSync(codexNativeManifest, JSON.stringify(expectedCodexNative));
		const calls = [];
		const adapters = verifyRelease(root, (command, args) => {
			calls.push([command, args]);
			return { status: 0 };
		});
		assert.equal(adapters.length, 2);
		assert.deepEqual(calls.map((call) => call[1].at(-1)), [path.join(root, "src", "cc.mjs"), "--help"]);
		fs.rmSync(path.dirname(payloads.claude.binary), { recursive: true, force: true });
		assert.throws(() => verifyRelease(root, () => ({ status: 0 })), /native payload is not installed/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// New snapshots use their lockfile pins. Older main snapshots get exact,
// channel-specific local fallbacks, never a global npm install.
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-channel-deps-"));
	try {
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { "@mariozechner/pi-tui": "1.0.0" } }));
		const calls = [];
		installDependencies(root, (command, args, options) => {
			calls.push({ command, args, options });
			return { status: 0 };
		}, { channel: "stable" });
		assert.equal(calls.length, 2);
		assert.equal(calls[0].command, "npm");
		assert.equal(calls[0].args[0], "ci");
		assert.equal(calls[0].options.env.CC_SKIP_ADAPTER_INSTALL, "1");
		assert.equal(calls[0].options.env.npm_config_global, "false");
		assert.ok(calls[0].args.includes("--global=false"));
		assert.ok(calls[0].args.includes("--include=optional"));
		assert.equal(calls[1].options.cwd, path.join(root, ".cc-adapters"));
		assert.ok(!calls[1].args.includes("-g"));
		assert.ok(calls[1].args.includes("--global=false"));
		assert.ok(calls[1].args.includes("--include=optional"));
		assert.deepEqual(
			JSON.parse(fs.readFileSync(path.join(root, ".cc-adapters", "package.json"), "utf8")).dependencies,
			{
				"@agentclientprotocol/claude-agent-acp": "0.39.0",
				"@agentclientprotocol/codex-acp": "1.1.2",
			},
		);

		fs.writeFileSync(
			path.join(root, "package.json"),
			JSON.stringify({ dependencies: Object.fromEntries(CHANNEL_ADAPTERS.map((adapter) => [adapter.package, "1.0.0"])) }),
		);
		calls.length = 0;
		installDependencies(root, (command, args, options) => {
			calls.push({ command, args, options });
			return { status: 0 };
		}, { channel: "beta" });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].args[0], "ci");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// An already-open pre-guard launcher can resolve the newly published current
// after its on-disk script is replaced. Preserve that first migration release
// even after it falls out of the current/previous rollback pair.
{
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cc-channel-legacy-launcher-migration-"));
	const root = path.join(temporary, "share", "cc");
	const binDir = path.join(temporary, "bin");
	const repo = path.join(temporary, "repo");
	fs.mkdirSync(repo);
	const paths = channelPaths("beta", { root, binDir });
	const legacyCommit = "a".repeat(40);
	const commits = ["b".repeat(40), "c".repeat(40), "d".repeat(40)];
	let commit = commits[0];
	const operations = {
		resolveCommit: () => commit,
		archiveRepository: (_repo, _candidate, staging) => makeReleaseFixture(staging),
		installDependencies: () => {},
		verifyRelease: () => [{ package: "fake", version: "1.0.0" }],
	};
	try {
		const legacyRelease = path.join(paths.releasesDir, legacyCommit);
		makeReleaseFixture(legacyRelease);
		fs.writeFileSync(path.join(legacyRelease, ".cc-channel.json"), JSON.stringify({
			channel: "beta",
			commit: legacyCommit,
		}));
		fs.mkdirSync(paths.binDir, { recursive: true });
		makeDirectoryLink(path.relative(path.dirname(paths.currentLink), legacyRelease), paths.currentLink);
		fs.writeFileSync(paths.launcher, "#!/bin/sh\n# legacy direct launcher fixture\n", { mode: 0o755 });

		installChannel("beta", { root, binDir, repo }, operations);
		const migrationRelease = path.join(paths.releasesDir, commits[0]);
		assert.equal(fs.existsSync(path.join(migrationRelease, ".cc-unguarded-launch")), true);
		assert.match(fs.readFileSync(paths.launcher, "utf8"), /cc-channel-runner-protocol: 1/u);

		commit = commits[1];
		installChannel("beta", { root, binDir, repo }, operations);
		commit = commits[2];
		installChannel("beta", { root, binDir, repo }, operations);
		assert.equal(fs.existsSync(migrationRelease), true, "first guarded migration release is a finite permanent preserve");
		assert.equal(fs.existsSync(path.join(paths.releasesDir, commits[1])), true, "previous release remains available");
		assert.equal(fs.existsSync(path.join(paths.releasesDir, commits[2])), true, "current release remains available");
		assert.equal(fs.existsSync(path.join(paths.releasesDir, commits[1], ".cc-unguarded-launch")), false);
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
}

// Promotion and rollback only move channel-local links. A failed staged smoke
// test leaves the launcher and current release byte-for-byte unchanged.
{
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cc-channel-transaction-"));
	const root = path.join(temporary, "share", "cc");
	const binDir = path.join(temporary, "bin");
	const repo = path.join(temporary, "repo");
	fs.mkdirSync(repo);
	const commitA = "a".repeat(40);
	const commitB = "b".repeat(40);
	let commit = commitA;
	let failCommit;
	const operations = {
		resolveCommit: () => commit,
		archiveRepository: (_repo, candidate, staging) => {
			makeReleaseFixture(staging);
			fs.writeFileSync(path.join(staging, "commit"), `${candidate}\n`);
		},
		installDependencies: () => {},
		verifyRelease: (releaseDir) => {
			if (failCommit && fs.readFileSync(path.join(releaseDir, "commit"), "utf8").trim() === failCommit) {
				throw new Error("smoke failed");
			}
			return [{ package: "fake", version: "1.0.0" }];
		},
	};
	try {
		const paths = channelPaths("beta", { root, binDir });
		const stateFiles = Object.values(betaStateEnvironment(paths));
		for (const directory of [
			paths.stateDir,
			path.join(paths.stateDir, "config"),
			path.join(paths.stateDir, "cache"),
		]) {
			fs.mkdirSync(directory, { recursive: true });
			fs.chmodSync(directory, 0o777);
		}
		for (const file of stateFiles) {
			fs.writeFileSync(file, "private fixture\n");
			fs.chmodSync(file, 0o666);
		}
		const first = installChannel("beta", { root, binDir, repo }, operations);
		assert.equal(first.commit, commitA);
		assert.equal(fs.realpathSync(paths.currentLink), fs.realpathSync(path.join(paths.releasesDir, commitA)));
		assert.ok(fs.statSync(paths.launcher).mode & 0o100);
		assert.match(fs.readFileSync(paths.runner, "utf8"), /process\.argv\.splice\(1, 3, entrypoint\)/u);
		const privateDirectories = [
			paths.stateDir,
			path.join(paths.stateDir, "config"),
			path.join(paths.stateDir, "cache"),
		];
		for (const directory of privateDirectories) assert.equal(fs.statSync(directory).isDirectory(), true);
		for (const file of stateFiles) assert.equal(fs.statSync(file).isFile(), true);
		if (process.platform !== "win32") {
			for (const directory of privateDirectories) assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
			for (const file of stateFiles) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		}
		const launcherBeforeFailure = fs.readFileSync(paths.launcher);

		commit = commitB;
		failCommit = commitB;
		assert.throws(() => installChannel("beta", { root, binDir, repo }, operations), /smoke failed/);
		assert.equal(fs.realpathSync(paths.currentLink), fs.realpathSync(path.join(paths.releasesDir, commitA)));
		assert.deepEqual(fs.readFileSync(paths.launcher), launcherBeforeFailure);
		assert.equal(fs.existsSync(path.join(paths.releasesDir, commitB)), false);
		assert.equal(fs.existsSync(paths.lockDir), false);

		failCommit = undefined;
		installChannel("beta", { root, binDir, repo }, operations);
		assert.equal(fs.realpathSync(paths.currentLink), fs.realpathSync(path.join(paths.releasesDir, commitB)));
		assert.equal(fs.realpathSync(paths.previousLink), fs.realpathSync(path.join(paths.releasesDir, commitA)));
		installChannel("beta", { root, binDir, repo }, operations);
		assert.equal(fs.realpathSync(paths.currentLink), fs.realpathSync(path.join(paths.releasesDir, commitB)));
		assert.equal(fs.realpathSync(paths.previousLink), fs.realpathSync(path.join(paths.releasesDir, commitA)));

		const rolledBack = installChannel("beta", { root, binDir, repo, rollback: true }, operations);
		assert.equal(rolledBack.current, commitA);
		assert.equal(fs.realpathSync(paths.currentLink), fs.realpathSync(path.join(paths.releasesDir, commitA)));
		assert.equal(fs.realpathSync(paths.previousLink), fs.realpathSync(path.join(paths.releasesDir, commitB)));

		// A lexically channel-local target that physically escapes through a
		// nested symlink must abort before current or launcher publication.
		const outside = path.join(temporary, "outside-release");
		const escaped = path.join(paths.releasesDir, "escaped");
		fs.mkdirSync(outside);
		makeDirectoryLink(outside, escaped);
		fs.rmSync(paths.currentLink);
		makeDirectoryLink(path.relative(path.dirname(paths.currentLink), escaped), paths.currentLink);
		const launcherBeforeEscape = fs.readFileSync(paths.launcher);
		assert.throws(() => installChannel("beta", { root, binDir, repo }, operations), /resolves outside/);
		assert.equal(fs.realpathSync(paths.currentLink), fs.realpathSync(outside));
		assert.deepEqual(fs.readFileSync(paths.launcher), launcherBeforeEscape);

		// `previous` is recovery-only. An escaped value is discarded and the
		// valid old current becomes the new rollback pointer.
		fs.rmSync(paths.currentLink);
		fs.rmSync(escaped);
		makeDirectoryLink(path.relative(path.dirname(paths.currentLink), path.join(paths.releasesDir, commitA)), paths.currentLink);
		fs.rmSync(paths.previousLink);
		makeDirectoryLink(outside, paths.previousLink);
		commit = commitB;
		installChannel("beta", { root, binDir, repo }, operations);
		assert.equal(fs.realpathSync(paths.currentLink), fs.realpathSync(path.join(paths.releasesDir, commitB)));
		assert.equal(fs.realpathSync(paths.previousLink), fs.realpathSync(path.join(paths.releasesDir, commitA)));
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
}

console.log("channel installer tests passed");
