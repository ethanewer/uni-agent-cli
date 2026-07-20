import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { trustedExecutableOnPath, windowsTrustedExecutableRoots } from "../src/workflows/trusted-executable.mjs";

import {
	CHANNEL_ADAPTERS,
	WORKFLOW_RELEASE_FILES,
	acquireLock,
	atomicReplaceLink,
	archiveRepository,
	betaStateEnvironment,
	channelPaths,
	extractReleaseCandidate,
	installChannel,
	installDependencies,
	inspectAdapter,
	inspectNativePayloads,
	materializeRelease,
	npmInvocation,
	parseArgs,
	printResult,
	pruneChannelReleases,
	renderChannelRunner,
	renderLauncher,
	resolveCommit,
	snapshotCandidateTarball,
	verifyRelease,
	versionAtLeast,
} from "../scripts/install-channel.mjs";

const PINNED_NPM_INSTALLATION_SHA256 = "930c1fa35e5525e3b60c584fc3709c7cf71d62134d66fdc88a6e0fe8fc72dc6d";
const inheritedReleaseCommit = process.env.CC_RELEASE_COMMIT;
delete process.env.CC_RELEASE_COMMIT;

const installerSource = fs.readFileSync(new URL("../scripts/install-channel.mjs", import.meta.url), "utf8");
assert.doesNotMatch(installerSource, /Get-CimInstance Win32_Process/u, "Windows coordination never trusts module-autoloaded CIM output for process identity");
assert.match(installerSource, /channel installer cannot establish a unique process identity/u, "promotion refuses to proceed when PID-reuse-safe ownership cannot be established");
assert.match(installerSource, /trustedExecutableOnPath\("git"/u, "immutable snapshot resolution uses a trusted absolute Git executable");
assert.match(installerSource, /trustedExecutableOnPath\("tar"/u, "immutable snapshot extraction uses a trusted absolute tar executable");
assert.match(installerSource, /requireRootOwnership: process\.platform !== "win32"/u, "POSIX snapshot tools reject current-user-owned PATH shims");
assert.match(installerSource, /windowsTrustedExecutableRoots\(\)/u, "Windows tool roots are derived from loaded operating-system state rather than inherited environment");
assert.doesNotMatch(installerSource, /return \{ command: "npm", prefixArgs: \[\] \}/u, "dependency installation never resolves npm through inherited PATH");
assert.match(installerSource, /syncTreeSync\(staging\);[\s\S]*fs\.renameSync\(staging, releaseDir\);[\s\S]*syncDirectorySync\(releasesDir\)/u, "a completed release is crash-durable before channel promotion begins");
const promotionSource = installerSource.slice(installerSource.indexOf("export function promoteRelease"), installerSource.indexOf("function validateRollbackTarget"));
assert.ok(
	promotionSource.indexOf("ROLLBACK_TRANSACTION_FILE") < promotionSource.lastIndexOf("atomicReplaceFile(paths.runner"),
	"first launcher publication is preceded by durable replay state",
);

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
	candidateDir: undefined,
	expectedCommit: undefined,
	repo: undefined,
	root: undefined,
	binDir: undefined,
	rollback: false,
});
assert.deepEqual(parseArgs(["beta", "--ref", "HEAD", "--rollback"]), {
	target: "beta",
	ref: "HEAD",
	candidateDir: undefined,
	expectedCommit: undefined,
	repo: undefined,
	root: undefined,
	binDir: undefined,
	rollback: true,
});
assert.throws(() => parseArgs(["all", "--ref", "HEAD"]), /cannot be used with all/);
const parsedCandidate = parseArgs(["beta", "--candidate-dir", "/tmp/release", "--expected-commit", "a".repeat(40)]);
assert.equal(parsedCandidate.candidateDir, path.resolve("/tmp/release"));
assert.equal(parsedCandidate.expectedCommit, "a".repeat(40));
assert.throws(() => parseArgs(["beta", "--candidate-dir", "/tmp/release"]), /requires --expected-commit/u);
assert.throws(() => parseArgs(["beta", "--candidate-dir", "/tmp/release", "--ref", "HEAD"]), /cannot be combined/u);
assert.throws(() => parseArgs(["unknown"]), /unknown channel/);

{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-channel-protected-promotion-"));
	const repo = path.join(root, "repo");
	fs.mkdirSync(repo);
	try {
		process.env.CC_RELEASE_COMMIT = "a".repeat(40);
		assert.throws(
			() => installChannel("beta", { root: path.join(root, "state"), binDir: path.join(root, "bin"), repo }),
			/release promotion requires --candidate-dir with protected validation evidence/u,
			"a release-signoff process cannot promote an unprotected repository snapshot",
		);
	} finally {
		delete process.env.CC_RELEASE_COMMIT;
		fs.rmSync(root, { recursive: true, force: true });
	}
}

if (process.platform !== "win32") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-channel-stale-installer-lock-"));
	try {
		const paths = channelPaths("beta", { root, binDir: path.join(root, "bin") });
		fs.mkdirSync(path.join(paths.channelDir, `.install-lock.claim-interrupted`), { recursive: true });
		const firstPublicationRecovery = acquireLock(paths);
		firstPublicationRecovery();
		assert.equal(fs.existsSync(paths.lockDir), false, "an interrupted private claim never blocks canonical lock publication");
		fs.rmSync(path.join(paths.channelDir, `.install-lock.claim-interrupted`), { recursive: true });
		fs.mkdirSync(paths.lockDir, { recursive: true });
		fs.writeFileSync(path.join(paths.lockDir, "owner.json"), JSON.stringify({ pid: 2_147_483_647, processIdentityVersion: 2, processIdentity: "dead" }));
		const release = acquireLock(paths);
		assert.equal(fs.existsSync(path.join(paths.channelDir, ".rollback-transaction.json")), false, "a fully identified dead first-install owner is reclaimable before transaction publication");
		assert.throws(() => acquireLock(paths), /already being updated/u, "a successor installer cannot reclaim a live replacement lock");
		const owner = JSON.parse(fs.readFileSync(path.join(paths.lockDir, "owner.json"), "utf8"));
		assert.match(owner.lockToken, /^[0-9a-f-]{36}$/u);
		assert.equal(typeof owner.lockIdentity?.inode, "string");
		release();
		assert.equal(fs.existsSync(paths.lockDir), false);
		assert.equal(fs.readdirSync(paths.channelDir).some((name) => name.startsWith(".install-lock.")), false);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
}

{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-channel-validated-candidate-"));
	try {
		const commit = "e".repeat(40);
		const releasesDir = path.join(root, "releases");
		const releaseDir = path.join(releasesDir, commit);
		const candidate = {
			root: path.join(root, "candidate"), tarball: path.join(root, "candidate", "cc.tgz"),
			provenance: { sha256: "a".repeat(64), packMetadataSha256: "b".repeat(64) },
			validated: { gates: ["disabled-package-smoke", "dynamic-workflows-release", "authenticated-live-release"] },
		};
		const result = materializeRelease({
			repo: root, ref: `protected-candidate:${candidate.provenance.sha256}`, commit,
			releaseDir, releasesDir, channel: "beta", candidate,
		}, {
			snapshotCandidateTarball(_selected, staging) {
				const snapshot = path.join(staging, ".candidate.tgz");
				fs.writeFileSync(snapshot, "snapshot");
				return snapshot;
			},
			extractReleaseCandidate(selected, staging) {
				assert.deepEqual(selected.provenance, candidate.provenance);
				assert.match(selected.tarball, /\.candidate\.tgz$/u);
				fs.writeFileSync(path.join(staging, "candidate-runtime.mjs"), "export {};\n");
			},
			installDependencies: () => ({ nodeVersion: "22.19.0", npmVersion: "10.9.3", npmInstallationSha256: "c".repeat(64) }),
			verifyRelease: () => [],
		});
		assert.equal(result.reused, false);
		const metadata = JSON.parse(fs.readFileSync(path.join(releaseDir, ".cc-channel.json"), "utf8"));
		assert.equal(metadata.candidateSha256, candidate.provenance.sha256);
		assert.equal(metadata.packMetadataSha256, candidate.provenance.packMetadataSha256);
		assert.deepEqual(metadata.validatedGates, candidate.validated.gates);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
}

if (process.platform !== "win32") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-channel-candidate-pin-"));
	try {
		const source = path.join(root, "candidate.tgz");
		const bytes = Buffer.from("immutable candidate bytes");
		fs.writeFileSync(source, bytes);
		const candidate = {
			tarball: source,
			provenance: { sha256: createHash("sha256").update(bytes).digest("hex") },
		};
		const pinned = snapshotCandidateTarball(candidate, root);
		fs.writeFileSync(source, "replacement");
		assert.deepEqual(fs.readFileSync(pinned), bytes, "candidate extraction uses an independently pinned private snapshot");
		fs.rmSync(pinned);
		const linked = path.join(root, "linked.tgz");
		fs.symlinkSync(source, linked);
		assert.throws(
			() => snapshotCandidateTarball({ ...candidate, tarball: linked }, root),
			/(?:ELOOP|bounded regular file)/u,
			"candidate pinning never follows a caller-controlled tarball symlink",
		);

		const archiveRoot = path.join(root, "archive");
		const packageRoot = path.join(archiveRoot, "package");
		fs.mkdirSync(packageRoot, { recursive: true });
		fs.symlinkSync("/tmp/attacker-postinstall.mjs", path.join(packageRoot, "postinstall.mjs"));
		const unsafeTarball = path.join(root, "unsafe.tgz");
		const packed = spawnSync("tar", ["-czf", unsafeTarball, "-C", archiveRoot, "package"], { encoding: "utf8" });
		assert.equal(packed.status, 0, packed.stderr);
		assert.throws(
			() => extractReleaseCandidate({ root, tarball: unsafeTarball }, path.join(root, "destination")),
			/link or special filesystem entry/u,
			"candidate extraction rejects symlinks before materializing lifecycle code",
		);
		const expandedRoot = path.join(root, "expanded", "package");
		fs.mkdirSync(expandedRoot, { recursive: true });
		const oversized = path.join(expandedRoot, "oversized.bin");
		fs.writeFileSync(oversized, "");
		fs.truncateSync(oversized, 65 * 1024 * 1024);
		const expandedTarball = path.join(root, "expanded.tgz");
		const compressed = spawnSync("tar", ["-czf", expandedTarball, "-C", path.dirname(expandedRoot), "package"], { encoding: "utf8" });
		assert.equal(compressed.status, 0, compressed.stderr);
		assert.throws(
			() => extractReleaseCandidate({ root, tarball: expandedTarball }, path.join(root, "expanded-out")),
			/expanded-size limit/u,
			"a small compressed candidate cannot expand beyond the promotion quota",
		);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
}

assert.deepEqual(windowsTrustedExecutableRoots({
	sharedObjects: ["C:\\Windows\\System32\\kernel32.dll"],
}), ["C:\\Windows\\System32", "C:\\Program Files\\Git", "C:\\Program Files (x86)\\Git"], "Windows trusted roots derive exact system and Git tool directories from the loader-resolved KnownDLL drive");
assert.throws(
	() => windowsTrustedExecutableRoots({ sharedObjects: ["D:\\attacker\\System32\\kernel32.dll"] }),
	/loaded operating system/u,
	"an arbitrary DLL-shaped path cannot establish Windows executable trust",
);

if (process.platform !== "win32") {
	const replacementRepo = fs.mkdtempSync(path.join(os.tmpdir(), "cc-channel-replacement-ref-"));
	const extracted = fs.mkdtempSync(path.join(os.tmpdir(), "cc-channel-replacement-archive-"));
	try {
		for (const args of [["init", "-q"], ["config", "user.email", "release@example.invalid"], ["config", "user.name", "Release Test"]]) {
			const result = spawnSync("git", args, { cwd: replacementRepo, encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
		}
		fs.writeFileSync(path.join(replacementRepo, "payload.txt"), "reviewed\n");
		for (const args of [["add", "payload.txt"], ["commit", "-qm", "reviewed"]]) {
			const result = spawnSync("git", args, { cwd: replacementRepo, encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
		}
		const reviewed = spawnSync("git", ["rev-parse", "HEAD"], { cwd: replacementRepo, encoding: "utf8" }).stdout.trim();
		fs.writeFileSync(path.join(replacementRepo, "payload.txt"), "replacement\n");
		for (const args of [["add", "payload.txt"], ["commit", "-qm", "replacement"]]) {
			const result = spawnSync("git", args, { cwd: replacementRepo, encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
		}
		const replacement = spawnSync("git", ["rev-parse", "HEAD"], { cwd: replacementRepo, encoding: "utf8" }).stdout.trim();
		assert.equal(spawnSync("git", ["replace", reviewed, replacement], { cwd: replacementRepo }).status, 0);
		const inheritedGitDir = process.env.GIT_DIR;
		const inheritedGitConfig = process.env.GIT_CONFIG_GLOBAL;
		try {
			process.env.GIT_DIR = path.join(replacementRepo, "attacker-selected-git-dir");
			process.env.GIT_CONFIG_GLOBAL = path.join(replacementRepo, "attacker-selected-git-config");
			assert.equal(resolveCommit(replacementRepo, reviewed), reviewed, "immutable resolution ignores inherited Git overrides and preserves the requested object identity under replacement refs");
			archiveRepository(replacementRepo, reviewed, extracted);
		} finally {
			if (inheritedGitDir === undefined) delete process.env.GIT_DIR;
			else process.env.GIT_DIR = inheritedGitDir;
			if (inheritedGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
			else process.env.GIT_CONFIG_GLOBAL = inheritedGitConfig;
		}
		assert.equal(fs.readFileSync(path.join(extracted, "payload.txt"), "utf8"), "reviewed\n", "immutable archives ignore repository replacement refs");
	} finally {
		fs.rmSync(replacementRepo, { recursive: true, force: true });
		fs.rmSync(extracted, { recursive: true, force: true });
	}
}

assert.equal(versionAtLeast("1.1.2", "1.1.2"), true);
assert.equal(versionAtLeast("1.2.0", "1.1.2"), true);
assert.equal(versionAtLeast("1.1.1", "1.1.2"), false);
assert.equal(versionAtLeast("1.1.2-beta.1", "1.1.2"), false);

if (process.platform !== "win32") {
	const fakePath = fs.mkdtempSync(path.join(os.tmpdir(), "cc-channel-untrusted-git-"));
	const previousPath = process.env.PATH;
	try {
		fs.writeFileSync(path.join(fakePath, "git"), "#!/bin/sh\nprintf '%040d\\n' 0\n", { mode: 0o755 });
		process.env.PATH = `${fakePath}:/usr/bin:/bin`;
		assert.notEqual(resolveCommit(path.resolve("."), "HEAD"), "0".repeat(40), "a current-user-owned PATH-precedent Git shim cannot fabricate the installed commit");
	} finally {
		process.env.PATH = previousPath;
		fs.rmSync(fakePath, { recursive: true, force: true });
	}
}

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
		assert.deepEqual(npmInvocation({ platform: "linux", execPath: node, env: {} }), {
			command: path.resolve(node),
			prefixArgs: [path.resolve(npmCli)],
		});

		const detachedNode = path.join(root, "runtime", "node.exe");
		const npmOnPath = path.join(root, "npm-bin");
		const npmOnPathCli = path.join(npmOnPath, "node_modules", "npm", "bin", "npm-cli.js");
		fs.mkdirSync(path.dirname(npmOnPathCli), { recursive: true });
		fs.writeFileSync(npmOnPathCli, "// npm PATH fixture\n");
		assert.throws(() => npmInvocation({
			platform: "win32",
			execPath: detachedNode,
			env: { PATH: `${path.join(root, "missing")};${npmOnPath}` },
		}), /beside the active Node installation/u, "an inherited PATH cannot select npm outside the active Node installation");

		const release = path.join(root, "release");
		fs.mkdirSync(release);
		fs.writeFileSync(path.join(release, "package.json"), JSON.stringify({
			dependencies: Object.fromEntries(CHANNEL_ADAPTERS.map((adapter) => [adapter.package, "1.0.0"])),
		}));
		fs.copyFileSync(new URL("../npm-shrinkwrap.json", import.meta.url), path.join(release, "npm-shrinkwrap.json"));
		const calls = [];
		installDependencies(release, (command, args, options) => {
			calls.push({ command, args, options });
			return { status: 0, stdout: args.includes("--version") ? "10.9.3\n" : "" };
		}, {
			channel: "beta", platform: "win32", execPath: node,
			assertPinnedNpmInstallation: () => PINNED_NPM_INSTALLATION_SHA256,
		});
		assert.equal(calls.length, 2);
		const installCall = calls.find((call) => call.args.includes("ci"));
		assert.equal(installCall.command, path.resolve(node));
		assert.deepEqual(installCall.args.slice(0, 2), [path.resolve(npmCli), "ci"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-channel-windows-tools-"));
	try {
		const untrusted = path.join(root, "user-bin");
		const trusted = path.join(root, "Program Files", "Git", "cmd");
		fs.mkdirSync(untrusted, { recursive: true });
		fs.mkdirSync(trusted, { recursive: true });
		fs.writeFileSync(path.join(untrusted, "git.EXE"), "untrusted");
		fs.writeFileSync(path.join(trusted, "git.EXE"), "trusted");
		const environment = { PATH: `${untrusted};${trusted}`, PATHEXT: ".EXE;.CMD" };
		const trustOptions = {
			platform: "win32", allowedRoots: [path.join(root, "Program Files", "Git")],
			windowsRoots: [path.join(root, "Windows", "System32")], windowsAclCheck: () => true,
		};
		assert.equal(
			trustedExecutableOnPath("git", environment, undefined, trustOptions),
			fs.realpathSync(path.join(trusted, "git.EXE")),
			"Windows lookup applies PATHEXT while rejecting a PATH-precedent executable outside an exact protected tool root",
		);
		assert.throws(
			() => trustedExecutableOnPath("git", environment, undefined, { ...trustOptions, windowsAclCheck: () => false }),
			/trusted external git/u,
			"Windows tool lookup rejects a contained executable whose candidate or ancestor ACL grants unprivileged replacement",
		);
		assert.throws(
			() => trustedExecutableOnPath("git", environment, undefined, { ...trustOptions, allowedRoots: [] }),
			/trusted external git/u,
			"Windows tool lookup fails closed without a protected installation root",
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// A dangling Windows junction is still a directory entry and must be displaced
// before the replacement is renamed into place. POSIX symlinks model the same
// lstat-vs-exists behavior for this platform-independent regression.
{
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cc-channel-dangling-junction-"));
	try {
		const missing = path.join(temporary, "missing-release");
		const replacement = path.join(temporary, "replacement");
		const current = path.join(temporary, "current");
		fs.mkdirSync(replacement);
		fs.symlinkSync(missing, current, process.platform === "win32" ? "junction" : undefined);
		assert.equal(fs.existsSync(current), false);
		assert.doesNotThrow(() => atomicReplaceLink(current, replacement, { platform: "win32" }));
		assert.equal(fs.realpathSync(current), fs.realpathSync(replacement));
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
}

{
	const paths = channelPaths("beta", { home: "/home/tester", env: {}, platform: "linux" });
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
	for (const [name, value] of Object.entries(state)) assert.ok(beta.includes(`export ${name}='${value}'`));
	assert.match(beta, /if \[ -z "\$\{CC_FORKS:-\}" \]/);
	assert.ok(beta.includes(`export CC_FORKS='${paths.sharedForksPath}'`));
	assert.ok(beta.includes(`export CC_FORKS_MIGRATE_FROM='${path.join(paths.channelDir, "state", "config", "forks.json")}'`));
	assert.match(beta, /CURRENT_LINK=/);
	assert.match(beta, /channel-runner\.mjs' "\$CURRENT_LINK"/);
	const channelRunner = renderChannelRunner();
	assert.match(channelRunner, /node_modules.*\.bin/su);
	assert.match(channelRunner, /processIdentityVersion: 2, processIdentity: identity/u, "launch guards record a reuse-safe process identity");
	assert.match(channelRunner, /processIdentityVersion: 2, processIdentity: leaseIdentity/u, "release leases record a reuse-safe process identity");
	assert.match(channelRunner, /CC_CHANNEL_PROCESS_PID/u, "macOS channel tokens are bound to their creator PID");
	assert.match(channelRunner, /pid === process\.pid && channelProcessPid === pid/u, "the runner uses its already-established token without a fallible process-table round trip");
	assert.doesNotMatch(channelRunner, /cc-launch:/u, "runner identity never falls back to a temporary process title");
	assert.doesNotMatch(fs.readFileSync(new URL("../scripts/install-channel.mjs", import.meta.url), "utf8"), /localeCompare\(/u, "release manifest traversal is locale-independent");
	assert.match(beta, /CC_NODE_PATH:-node/);

	const stable = renderLauncher("stable", channelPaths("stable", { home: "/home/tester", env: {}, platform: "linux" }));
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
		ids.reused = "a".repeat(40);
		const makeManaged = (id, leaseProtocol = 1) => {
			const directory = path.join(paths.releasesDir, id);
			fs.mkdirSync(directory);
			fs.writeFileSync(path.join(directory, ".cc-channel.json"), JSON.stringify({ channel: "beta", commit: id, leaseProtocol }));
			return directory;
		};
		for (const name of ["current", "previous", "old", "active", "launching", "migration", "retry", "reused"]) makeManaged(ids[name]);
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
		const reusedLeaseDir = path.join(paths.leasesDir, ids.reused);
		fs.mkdirSync(reusedLeaseDir);
		fs.writeFileSync(path.join(reusedLeaseDir, "reused"), JSON.stringify({
			pid: 4243, processIdentityVersion: 2, processIdentity: "old-process-lifetime",
		}));

		const now = Date.now();
		const first = pruneChannelReleases("beta", paths, {
			now,
			processIsAlive: (pid) => pid === 4242 || pid === 4243,
			processIdentity: (pid) => pid === 4243 ? "new-process-lifetime" : "active-process-lifetime",
		});
		assert.deepEqual(new Set(first.removed), new Set([ids.old, ids.reused]), "a recycled PID does not pin another runner lifetime's release lease");
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
			processIdentityVersion: 2,
			processIdentity: "dead-owner-identity",
		}));
		const recovered = pruneChannelReleases("beta", paths, {
			runtimeLockOptions: { waitMs: 50, retryMs: 0, processIsAlive: () => false },
		});
		assert.equal(recovered.errors.length, 0, recovered.errors.map((error) => error.message).join("\n"));
		assert.equal(recovered.startupBlocked, false);
		assert.deepEqual(recovered.removed, [oldId]);
		assert.equal(fs.existsSync(paths.runtimeLockDir), false);

		makeManaged(oldId);
		fs.mkdirSync(paths.runtimeLockDir);
		fs.writeFileSync(path.join(paths.runtimeLockDir, "owner.json"), JSON.stringify({
			pid: 424242,
			token: "reused-pid-owner",
			processIdentityVersion: 2,
			processIdentity: "old-process-lifetime",
		}));
		const reusedPid = pruneChannelReleases("beta", paths, {
			runtimeLockOptions: {
				waitMs: 50,
				retryMs: 0,
				processIsAlive: () => true,
				processIdentity: (pid) => pid === 424242 ? "new-process-lifetime" : "maintenance-process-lifetime",
			},
		});
		assert.equal(reusedPid.errors.length, 0, reusedPid.errors.map((error) => error.message).join("\n"));
		assert.deepEqual(reusedPid.removed, [oldId], "a live recycled PID cannot preserve another process lifetime's runtime guard");
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
	fs.writeFileSync(path.join(releaseDir, "package.json"), JSON.stringify({
		name: "cc",
		dependencies: { "@anthropic-ai/claude-agent-sdk": "1.0.0", "@openai/codex": "1.0.0" },
	}));
	fs.writeFileSync(path.join(releaseDir, "package-lock.json"), "{}\n");
	fs.writeFileSync(path.join(releaseDir, "npm-shrinkwrap.json"), "{}\n");
	fs.writeFileSync(path.join(releaseDir, "src", "cc.mjs"), "#!/usr/bin/env node\n");
	fs.writeFileSync(path.join(releaseDir, "src", "pi-harness.mjs"), "// harness\n");
	for (const relative of WORKFLOW_RELEASE_FILES) {
		const file = path.join(releaseDir, relative);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, relative.endsWith(".py") ? "# workflow helper\n" : relative.endsWith(".mjs") ? "// workflow module\n" : `${relative}\n`);
	}
	for (const adapter of CHANNEL_ADAPTERS) {
		makeAdapterFixture(releaseDir, adapter, adapter.minimumVersion ?? "0.59.0");
	}
	const linuxMusl = process.platform === "linux" && !process.report?.getReport?.()?.header?.glibcVersionRuntime;
	const claudeSuffix = linuxMusl ? `linux-${process.arch}-musl` : `${process.platform}-${process.arch}`;
	const claudeNativeName = `@anthropic-ai/claude-agent-sdk-${claudeSuffix}`;
	const codexNativeName = `@openai/codex-${process.platform}-${process.arch}`;
	const claudeSdk = path.join(releaseDir, "node_modules", "@anthropic-ai", "claude-agent-sdk");
	const claudeAdapter = path.join(releaseDir, "node_modules", "@agentclientprotocol", "claude-agent-acp");
	const adapterClaudeSdk = path.join(claudeAdapter, "node_modules", "@anthropic-ai", "claude-agent-sdk");
	const codexCli = path.join(releaseDir, "node_modules", "@openai", "codex");
	const claudeNative = path.join(releaseDir, "node_modules", ...claudeNativeName.split("/"));
	const adapterClaudeNative = path.join(claudeAdapter, "node_modules", ...claudeNativeName.split("/"));
	const codexNative = path.join(releaseDir, "node_modules", ...codexNativeName.split("/"));
	fs.mkdirSync(claudeSdk, { recursive: true });
	fs.mkdirSync(adapterClaudeSdk, { recursive: true });
	fs.mkdirSync(adapterClaudeNative, { recursive: true });
	fs.mkdirSync(codexCli, { recursive: true });
	fs.mkdirSync(claudeNative, { recursive: true });
	fs.mkdirSync(path.join(codexNative, "vendor", "test-target", "bin"), { recursive: true });
	fs.writeFileSync(path.join(claudeSdk, "package.json"), JSON.stringify({
		name: "@anthropic-ai/claude-agent-sdk",
		version: "1.0.0",
		optionalDependencies: { [claudeNativeName]: "1.0.0" },
	}));
	const claudeAdapterManifest = JSON.parse(fs.readFileSync(path.join(claudeAdapter, "package.json"), "utf8"));
	fs.writeFileSync(path.join(claudeAdapter, "package.json"), JSON.stringify({
		...claudeAdapterManifest,
		dependencies: { "@anthropic-ai/claude-agent-sdk": "0.9.0" },
	}));
	fs.writeFileSync(path.join(adapterClaudeSdk, "package.json"), JSON.stringify({
		name: "@anthropic-ai/claude-agent-sdk",
		version: "0.9.0",
		optionalDependencies: { [claudeNativeName]: "0.9.0" },
	}));
	fs.writeFileSync(path.join(codexCli, "package.json"), JSON.stringify({
		name: "@openai/codex",
		version: "1.0.0",
		optionalDependencies: { [codexNativeName]: "npm:@openai/codex@1.0.0-test" },
	}));
	fs.writeFileSync(path.join(claudeNative, "package.json"), JSON.stringify({ name: claudeNativeName, version: "1.0.0" }));
	fs.writeFileSync(path.join(adapterClaudeNative, "package.json"), JSON.stringify({ name: claudeNativeName, version: "0.9.0" }));
	fs.writeFileSync(path.join(codexNative, "package.json"), JSON.stringify({ name: "@openai/codex", version: "1.0.0-test" }));
	const claudeBinary = path.join(claudeNative, process.platform === "win32" ? "claude.exe" : "claude");
	const adapterClaudeBinary = path.join(adapterClaudeNative, process.platform === "win32" ? "claude.exe" : "claude");
	const codexBinary = path.join(codexNative, "vendor", "test-target", "bin", process.platform === "win32" ? "codex.exe" : "codex");
	fs.writeFileSync(claudeBinary, "native\n");
	fs.writeFileSync(adapterClaudeBinary, "adapter native\n");
	fs.writeFileSync(codexBinary, "native\n");
	if (process.platform !== "win32") {
		fs.chmodSync(claudeBinary, 0o755);
		fs.chmodSync(adapterClaudeBinary, 0o755);
		fs.chmodSync(codexBinary, 0o755);
	}
}

function makeTreeOwnerOnly(entry) {
	const stat = fs.lstatSync(entry);
	if (stat.isSymbolicLink()) return;
	fs.chmodSync(entry, stat.mode & 0o700);
	if (stat.isDirectory()) for (const name of fs.readdirSync(entry)) makeTreeOwnerOnly(path.join(entry, name));
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
		fs.rmSync(path.join(root, "package-lock.json"));
		for (const adapter of CHANNEL_ADAPTERS) {
			const installed = inspectAdapter(root, adapter);
			assert.equal(installed.package, adapter.package);
		}
		const payloads = inspectNativePayloads(root);
		assert.ok(fs.existsSync(payloads.claude.binary));
		assert.ok(fs.existsSync(payloads.claudeAcp.binary));
		assert.ok(fs.existsSync(payloads.codex.binary));
		const directClaudeManifest = path.join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
		const expectedDirectClaude = JSON.parse(fs.readFileSync(directClaudeManifest, "utf8"));
		fs.writeFileSync(directClaudeManifest, JSON.stringify({ ...expectedDirectClaude, version: "0.0.0-stale" }));
		assert.throws(() => inspectNativePayloads(root), /direct Claude Agent SDK mismatch/u);
		fs.writeFileSync(directClaudeManifest, JSON.stringify(expectedDirectClaude));
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
		const adapterNativeManifest = path.join(
			root,
			"node_modules", "@agentclientprotocol", "claude-agent-acp", "node_modules",
			...payloads.claudeAcp.package.split("/"), "package.json",
		);
		const expectedAdapterNative = JSON.parse(fs.readFileSync(adapterNativeManifest, "utf8"));
		fs.writeFileSync(adapterNativeManifest, JSON.stringify({ ...expectedAdapterNative, version: "0.0.0-stale" }));
		assert.throws(() => inspectNativePayloads(root), /native payload mismatch/u);
		fs.writeFileSync(adapterNativeManifest, JSON.stringify(expectedAdapterNative));
		const calls = [];
		const previousVerificationSecret = process.env.ANTHROPIC_API_KEY;
		const previousVerificationPath = process.env.PATH;
		process.env.ANTHROPIC_API_KEY = "must-not-reach-verification";
		process.env.PATH = "https://path-user:path-password@invalid.example/bin\n/multiline-bin";
		let adapters;
		try {
			adapters = verifyRelease(root, (command, args, options) => {
				calls.push([command, args, options]);
				return { status: 0 };
			});
		} finally {
			if (previousVerificationSecret === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = previousVerificationSecret;
			if (previousVerificationPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousVerificationPath;
		}
		assert.equal(adapters.length, 3);
		assert.equal(fs.existsSync(path.join(root, "package-lock.json")), false, "workflow artifacts verify with their published npm shrinkwrap and do not require npm-excluded package-lock.json");
		assert.ok(calls.every((call) => call[2]?.env?.ANTHROPIC_API_KEY === undefined), "candidate syntax/help verification never inherits provider credentials");
		assert.ok(calls.every((call) => !call[2]?.env?.PATH?.includes("path-password") && !call[2]?.env?.PATH?.includes("multiline-bin")), "candidate verification augments only the scrubbed executable path");
		const syntaxChecked = new Set(calls.filter((call) => call[1][0] === "--check").map((call) => call[1].at(-1)));
		for (const relative of WORKFLOW_RELEASE_FILES.filter((file) => file.endsWith(".mjs"))) {
			assert.equal(syntaxChecked.has(path.join(root, relative)), true, `channel verification syntax-checks ${relative}`);
		}
		if (process.platform !== "win32") {
			const parsedPython = new Set(calls.filter((call) => path.basename(call[0]).startsWith("python3") && call[1].at(-1)?.endsWith(".py")).map((call) => call[1].at(-1)));
			for (const relative of WORKFLOW_RELEASE_FILES.filter((file) => file.endsWith(".py"))) {
				assert.equal(parsedPython.has(path.join(root, relative)), true, `channel verification parses ${relative}`);
			}
			assert.throws(
				() => verifyRelease(root, (command) => {
					if (path.basename(command).startsWith("python3")) throw new Error("ENOENT");
					return { status: 0 };
				}),
				/requires python3/u,
				"channel verification reports its Python prerequisite before bridge parsing",
			);
		}
		assert.equal(calls.at(-1)[1].at(-1), "--help");
		const missingWorkflowModule = path.join(root, "src", "workflows", "manager.mjs");
		fs.rmSync(missingWorkflowModule);
		assert.throws(() => verifyRelease(root, () => ({ status: 0 })), /release is missing src\/workflows\/manager\.mjs/u);
		fs.writeFileSync(missingWorkflowModule, "// restored workflow module\n");
		fs.writeFileSync(path.join(root, "src", "pi-harness.mjs"), "export const = broken;\n");
		assert.throws(() => verifyRelease(root), /failed/u, "channel verification parses the lazy-loaded host runtime rather than relying on --help");
		fs.writeFileSync(path.join(root, "src", "pi-harness.mjs"), "// restored harness\n");
		if (process.platform !== "win32") {
			const bridge = path.join(root, "src", "harnesses", "acp_bridge.py");
			fs.writeFileSync(bridge, "def broken(:\n");
			assert.throws(() => verifyRelease(root), /failed/u, "channel verification parses shipped Python bridges before promotion");
			fs.writeFileSync(bridge, "# restored bridge\n");
		}
		fs.rmSync(path.dirname(payloads.claude.binary), { recursive: true, force: true });
		assert.throws(() => verifyRelease(root, () => ({ status: 0 })), /native payload is not installed/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// The current installer must continue to verify and roll back to immutable
// pre-workflow snapshots. New snapshots advertise the feature by their package
// manifest or workflow-specific paths and are then held to the complete file
// manifest; legacy snapshots receive the original baseline verification.
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-channel-legacy-release-"));
	try {
		makeReleaseFixture(root);
		for (const relative of WORKFLOW_RELEASE_FILES) fs.rmSync(path.join(root, relative), { recursive: true, force: true });
		fs.rmSync(path.join(root, "src", "workflows"), { recursive: true, force: true });
		fs.rmSync(path.join(root, "npm-shrinkwrap.json"));
		const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
		manifest.dependencies = { "@anthropic-ai/claude-agent-sdk": "1.0.0" };
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
		const legacyCodexAdapter = path.join(root, "node_modules", "@agentclientprotocol", "codex-acp", "package.json");
		const legacyCodexManifest = JSON.parse(fs.readFileSync(legacyCodexAdapter, "utf8"));
		fs.writeFileSync(legacyCodexAdapter, JSON.stringify({ ...legacyCodexManifest, version: "1.1.2" }));
		fs.rmSync(path.join(root, "node_modules", "pi-acp"), { recursive: true, force: true });
		fs.rmSync(path.join(root, "node_modules", ".bin", process.platform === "win32" ? "pi-acp.cmd" : "pi-acp"), { force: true });
		const legacyAdapters = verifyRelease(root, () => ({ status: 0 }));
		assert.equal(legacyAdapters.length, 2, "pre-workflow snapshots use their historical adapter set");
		fs.writeFileSync(path.join(root, "npm-shrinkwrap.json"), "{}\n");
		fs.mkdirSync(path.join(root, "src", "workflows"), { recursive: true });
		assert.throws(() => verifyRelease(root, () => ({ status: 0 })), /release is missing LICENSE/u, "a snapshot that starts shipping workflow paths must include the complete release manifest");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// Every snapshot uses only its committed lockfile closure. Legacy snapshots
// retain their historical two-adapter set without resolving new fallbacks.
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-channel-deps-"));
	const priorSecrets = Object.fromEntries(["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "PRIVATE_SIGNING_KEY", "NODE_AUTH_TOKEN", "NPM_TOKEN", "GITHUB_PAT", "HTTPS_PROXY", "REGISTRY_ENDPOINT", "BROKEN_PROXY", "MULTILINE_PROXY", "GIT_DIR", "Git_Config_Global", "npm_config_userconfig", "npm_config_globalconfig", "NPM_CONFIG_GLOBALCONFIG", "NpM_CoNfIg_GlObAlCoNfIg"].map((name) => [name, process.env[name]]));
	try {
		fs.copyFileSync(new URL("../npm-shrinkwrap.json", import.meta.url), path.join(root, "npm-shrinkwrap.json"));
		process.env.OPENAI_API_KEY = "must-not-reach-install";
		process.env.ANTHROPIC_API_KEY = "must-not-reach-install";
		process.env.PRIVATE_SIGNING_KEY = "must-not-reach-install";
		process.env.NODE_AUTH_TOKEN = "must-not-reach-install";
		process.env.NPM_TOKEN = "must-not-reach-install";
		process.env.GITHUB_PAT = "must-not-reach-install";
		process.env.HTTPS_PROXY = "https://registry-token@proxy.invalid";
		process.env.REGISTRY_ENDPOINT = "https://registry.invalid/npm?access_token=must-not-reach-install";
		process.env.BROKEN_PROXY = "https://opaque-token@proxy.invalid:badport";
		process.env.MULTILINE_PROXY = "https://safe.invalid\nhttps://registry-user:registry-password@evil.invalid";
		process.env.GIT_DIR = "/tmp/must-not-reach-git";
		process.env.Git_Config_Global = "/tmp/must-not-reach-git-config";
		process.env.npm_config_userconfig = "/tmp/must-not-reach-install.npmrc";
		process.env.npm_config_globalconfig = "/tmp/must-not-reach-install-global.npmrc";
		process.env.NpM_CoNfIg_GlObAlCoNfIg = "/tmp/mixed-case-must-not-reach-install.npmrc";
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: {
			"@agentclientprotocol/claude-agent-acp": "0.58.1",
			"@agentclientprotocol/codex-acp": "1.1.2",
		} }));
		const calls = [];
		installDependencies(root, (command, args, options) => {
			calls.push({ command, args, options });
			return { status: 0, stdout: args.includes("--version") ? "10.9.3\n" : "" };
		}, { channel: "stable", assertPinnedNpmInstallation: () => PINNED_NPM_INSTALLATION_SHA256 });
		assert.equal(calls.length, 2);
		const stableInstallCall = calls.find((call) => call.args.includes("ci"));
		assert.equal(stableInstallCall.command, path.resolve(process.execPath));
		assert.ok(stableInstallCall.args.includes("ci"));
		assert.equal(stableInstallCall.options.env.CC_SKIP_ADAPTER_INSTALL, "1");
		assert.equal(stableInstallCall.options.env.npm_config_global, "false");
		assert.equal(stableInstallCall.options.env.OPENAI_API_KEY, undefined);
		assert.equal(stableInstallCall.options.env.ANTHROPIC_API_KEY, undefined);
		assert.equal(stableInstallCall.options.env.PRIVATE_SIGNING_KEY, undefined);
		assert.equal(stableInstallCall.options.env.NODE_AUTH_TOKEN, undefined);
		assert.equal(stableInstallCall.options.env.NPM_TOKEN, undefined);
		assert.equal(stableInstallCall.options.env.GITHUB_PAT, undefined);
		assert.equal(stableInstallCall.options.env.HTTPS_PROXY, undefined);
		assert.equal(stableInstallCall.options.env.REGISTRY_ENDPOINT, undefined);
		assert.equal(stableInstallCall.options.env.BROKEN_PROXY, undefined);
		assert.equal(stableInstallCall.options.env.MULTILINE_PROXY, undefined);
		assert.equal(stableInstallCall.options.env.GIT_DIR, undefined);
		assert.equal(stableInstallCall.options.env.Git_Config_Global, undefined);
		assert.match(stableInstallCall.options.env.npm_config_userconfig, /cc-empty-npm-config-.*user\.npmrc/u);
		assert.match(stableInstallCall.options.env.npm_config_globalconfig, /cc-empty-npm-config-.*global\.npmrc/u);
		assert.notEqual(stableInstallCall.options.env.npm_config_userconfig, stableInstallCall.options.env.npm_config_globalconfig);
		assert.equal(stableInstallCall.options.env.NPM_CONFIG_GLOBALCONFIG, undefined);
		assert.equal(stableInstallCall.options.env.NpM_CoNfIg_GlObAlCoNfIg, undefined);
		assert.ok(stableInstallCall.args.includes("--global=false"));
		assert.ok(stableInstallCall.args.includes("--include=optional"));
		assert.equal(fs.existsSync(path.join(root, ".cc-adapters")), false, "the installer never creates an unlocked fallback dependency tree");

		fs.writeFileSync(
			path.join(root, "package.json"),
			JSON.stringify({ dependencies: Object.fromEntries(CHANNEL_ADAPTERS.map((adapter) => [adapter.package, "1.0.0"])) }),
		);
		calls.length = 0;
		installDependencies(root, (command, args, options) => {
			calls.push({ command, args, options });
			return { status: 0, stdout: args.includes("--version") ? "10.9.3\n" : "" };
		}, { channel: "beta", assertPinnedNpmInstallation: () => PINNED_NPM_INSTALLATION_SHA256 });
		assert.equal(calls.length, 2);
		assert.ok(calls.some((call) => call.args.includes("ci")));
	} finally {
		for (const [name, value] of Object.entries(priorSecrets)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
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
		if (process.platform !== "win32") makeTreeOwnerOnly(legacyRelease);
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
		fs.writeFileSync(path.join(paths.releasesDir, commitB, "commit"), "tampered\n");
		assert.throws(
			() => installChannel("beta", { root, binDir, repo }, operations),
			/differs from its installed immutable content manifest/u,
			"a writable commit-named release is never trusted when its full installed content changes",
		);
		fs.writeFileSync(path.join(paths.releasesDir, commitB, "commit"), `${commitB}\n`);
		const commitBMode = fs.statSync(path.join(paths.releasesDir, commitB, "commit")).mode & 0o777;
		fs.chmodSync(path.join(paths.releasesDir, commitB, "commit"), 0o666);
		assert.throws(
			() => installChannel("beta", { root, binDir, repo }, operations),
			/differs from its installed immutable content manifest/u,
			"world-writable runtime mode drift is part of the installed content manifest",
		);
		fs.chmodSync(path.join(paths.releasesDir, commitB, "commit"), commitBMode);
		if (process.platform !== "win32") {
			fs.chmodSync(path.join(paths.releasesDir, commitB), 0o777);
			assert.throws(
				() => installChannel("beta", { root, binDir, repo }, operations),
				/differs from its installed immutable content manifest/u,
				"the release root directory mode is part of the installed content manifest",
			);
			fs.chmodSync(path.join(paths.releasesDir, commitB), 0o755);
		}
		fs.writeFileSync(path.join(paths.releasesDir, commitA, "commit"), "tampered previous\n");
		assert.throws(
			() => installChannel("beta", { root, binDir, repo, rollback: true }, operations),
			/differs from its installed immutable content manifest/u,
			"rollback cannot promote a structurally valid previous release whose installed content drifted",
		);
		fs.writeFileSync(path.join(paths.releasesDir, commitA, "commit"), `${commitA}\n`);
		const previousMetadataFile = path.join(paths.releasesDir, commitA, ".cc-channel.json");
		const previousMetadataRaw = fs.readFileSync(previousMetadataFile, "utf8");
		const previousMetadata = JSON.parse(previousMetadataRaw);
		delete previousMetadata.contentSha256;
		fs.chmodSync(previousMetadataFile, 0o644);
		fs.writeFileSync(previousMetadataFile, `${JSON.stringify(previousMetadata, null, 2)}\n`);
		assert.throws(
			() => installChannel("beta", { root, binDir, repo, rollback: true }, operations),
			/must be rematerialized from its immutable Git commit/u,
			"deleting a modern content digest cannot downgrade a previous release into legacy rollback verification",
		);
		previousMetadata.contentSha256 = JSON.parse(previousMetadataRaw).contentSha256;
		previousMetadata.contentManifestVersion = 2;
		fs.writeFileSync(previousMetadataFile, `${JSON.stringify(previousMetadata, null, 2)}\n`);
		assert.throws(
			() => installChannel("beta", { root, binDir, repo, rollback: true }, operations),
			/no supported immutable content manifest/u,
			"an unknown content-manifest schema cannot be interpreted with current traversal semantics",
		);
		fs.writeFileSync(previousMetadataFile, previousMetadataRaw);
		fs.chmodSync(previousMetadataFile, 0o444);
		const legacyMetadata = JSON.parse(previousMetadataRaw);
		delete legacyMetadata.contentManifestVersion;
		delete legacyMetadata.contentSha256;
		fs.chmodSync(previousMetadataFile, 0o644);
		fs.writeFileSync(previousMetadataFile, `${JSON.stringify(legacyMetadata, null, 2)}\n`);
		if (process.platform !== "win32") {
			makeTreeOwnerOnly(path.join(paths.releasesDir, commitA));
		}
		const currentMetadataFile = path.join(paths.releasesDir, commitB, ".cc-channel.json");
		const currentMetadata = JSON.parse(fs.readFileSync(currentMetadataFile, "utf8"));
		delete currentMetadata.contentManifestVersion;
		delete currentMetadata.contentSha256;
		fs.chmodSync(currentMetadataFile, 0o644);
		fs.writeFileSync(currentMetadataFile, `${JSON.stringify(currentMetadata, null, 2)}\n`);

		const rolledBack = installChannel("beta", { root, binDir, repo, rollback: true }, operations);
		assert.equal(rolledBack.current, commitA);
		assert.equal(fs.realpathSync(paths.currentLink), fs.realpathSync(path.join(paths.releasesDir, commitA)));
		assert.equal(fs.realpathSync(paths.previousLink), fs.realpathSync(path.join(paths.releasesDir, commitB)));
		const upgradedLegacyMetadata = JSON.parse(fs.readFileSync(previousMetadataFile, "utf8"));
		assert.equal(upgradedLegacyMetadata.contentManifestVersion, 1, "legacy rollback is upgraded only after exact source and installed dependency comparison");
		assert.match(upgradedLegacyMetadata.contentSha256, /^[0-9a-f]{64}$/u);
		if (process.platform !== "win32") {
			assert.equal(fs.statSync(path.join(paths.releasesDir, commitA)).mode & 0o777, 0o700, "legacy verification accepts and records a safe restrictive install root mode");
			assert.equal(fs.statSync(path.join(paths.releasesDir, commitA, "src", "pi-harness.mjs")).mode & 0o777, 0o600, "legacy verification accepts safe npm trees created under umask 077");
		}
		assert.equal(JSON.parse(fs.readFileSync(currentMetadataFile, "utf8")).contentManifestVersion, 1, "rollback prevalidates and upgrades the legacy current target before publishing a transaction");

		const interruptedRollbackFile = path.join(paths.channelDir, ".rollback-transaction.json");
		fs.writeFileSync(interruptedRollbackFile, `${JSON.stringify({
			version: 1,
			desiredCurrent: fs.readlinkSync(paths.previousLink),
			desiredPrevious: fs.readlinkSync(paths.currentLink),
		})}\n`);
		const interruptedDesiredCurrentMetadata = JSON.parse(fs.readFileSync(currentMetadataFile, "utf8"));
		delete interruptedDesiredCurrentMetadata.contentManifestVersion;
		delete interruptedDesiredCurrentMetadata.contentSha256;
		fs.chmodSync(currentMetadataFile, 0o644);
		fs.writeFileSync(currentMetadataFile, `${JSON.stringify(interruptedDesiredCurrentMetadata, null, 2)}\n`);
		fs.mkdirSync(paths.lockDir);
		fs.writeFileSync(path.join(paths.lockDir, "owner.json"), JSON.stringify({ pid: process.pid, processIdentityVersion: 2, processIdentity: "reused-process-identity" }));
		commit = commitB;
		installChannel("beta", { root, binDir, repo }, operations);
		assert.equal(fs.existsSync(interruptedRollbackFile), false, "the next locked channel operation completes and clears an interrupted rollback transaction");
		assert.equal(fs.realpathSync(paths.currentLink), fs.realpathSync(path.join(paths.releasesDir, commitB)));
		assert.equal(fs.realpathSync(paths.previousLink), fs.realpathSync(path.join(paths.releasesDir, commitA)));
		assert.equal(JSON.parse(fs.readFileSync(currentMetadataFile, "utf8")).contentManifestVersion, 1, "transaction recovery receives repository context for legacy target verification");

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

if (inheritedReleaseCommit !== undefined) process.env.CC_RELEASE_COMMIT = inheritedReleaseCommit;
console.log("channel installer tests passed");
