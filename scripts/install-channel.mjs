#!/usr/bin/env node
// Install cc from immutable validated candidates or development Git snapshots
// without touching npm's global prefix.
//
// Layout (overridable with --root / CC_INSTALL_ROOT):
//   ~/.local/share/cc/channels/{stable,beta}/releases/<commit>
//   ~/.local/share/cc/channels/{stable,beta}/current -> releases/<commit>
//   ~/.local/bin/{cc,cc2}
//
// Each release owns its node_modules and ACP adapters. A release is fully built
// and smoke-tested before the channel's `current` link is replaced atomically.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
	assertPinnedNpmInstallation,
	RELEASE_NODE_VERSION,
	RELEASE_NPM_INSTALLATION_SHA256,
	RELEASE_NPM_VERSION,
	releaseNpmInstallationSha256,
} from "./release-toolchain.mjs";
import { validateShrinkwrapProvenance } from "./shrinkwrap-policy.mjs";
import { verifyReleaseCandidate } from "./verify-release-candidate.mjs";
import { trustedExecutableOnPath, userControlledPathRoots, windowsTrustedExecutableRoots } from "../src/workflows/trusted-executable.mjs";

export const CHANNELS = Object.freeze({
	stable: Object.freeze({ command: "cc", defaultRef: "main", isolateState: false }),
	beta: Object.freeze({ command: "cc2", defaultRef: "origin/ux-0711", isolateState: true }),
});

export const CHANNEL_ADAPTERS = Object.freeze([
	Object.freeze({ package: "@agentclientprotocol/claude-agent-acp", bin: "claude-agent-acp" }),
	Object.freeze({ package: "@agentclientprotocol/codex-acp", bin: "codex-acp", minimumVersion: "1.1.4" }),
	Object.freeze({ package: "pi-acp", bin: "pi-acp", minimumVersion: "0.0.31" }),
]);

// Snapshots predating dynamic workflows shipped only these two adapters. Keep
// their historical floor so an already-installed immutable release remains a
// valid rollback target after the installer itself is upgraded.
const LEGACY_CHANNEL_ADAPTERS = Object.freeze([
	Object.freeze({ package: "@agentclientprotocol/claude-agent-acp", bin: "claude-agent-acp" }),
	Object.freeze({ package: "@agentclientprotocol/codex-acp", bin: "codex-acp", minimumVersion: "1.1.2" }),
]);

export const WORKFLOW_RELEASE_FILES = Object.freeze([
	"LICENSE", "LICENSE-APACHE-2.0", "NOTICE", "src/terminal-restore.mjs", "src/harness/terminal-safety.mjs",
	"src/harness/acp-base.mjs", "src/harness/interface.mjs", "src/harness/adapters/claude.mjs",
	"src/harness/adapters/codex.mjs", "src/harness/adapters/cursor.mjs", "src/harness/adapters/opencode.mjs",
	"src/harness/adapters/pi.mjs", "src/harnesses/acp_bridge.py", "src/harnesses/mini_swe_agent/bridge.py",
	"src/harnesses/terminus_2/bridge.py",
	"src/workflows/adapter-executor.mjs", "src/workflows/broker.mjs", "src/workflows/durability.mjs",
	"src/workflows/trusted-executable.mjs",
	"src/workflows/journal.mjs", "src/workflows/manager.mjs", "src/workflows/mcp-server.mjs",
	"src/workflows/meta.mjs", "src/workflows/ownership-lock.mjs", "src/workflows/personal-workflow-helper.mjs",
	"src/workflows/project-save-helper.py", "src/workflows/registry.mjs", "src/workflows/sandbox-child.mjs",
	"src/workflows/sandbox-parent.mjs", "src/workflows/scheduler.mjs", "src/workflows/schema-worker.mjs",
	"src/workflows/schema.mjs", "src/workflows/state-root.mjs", "src/workflows/tui.mjs",
	"src/workflows/types.mjs", "src/workflows/worker-supervisor.mjs", "src/workflows/worktrees.mjs",
]);

function runtimeSourceFiles(root) {
	const files = [];
	const visit = (directory) => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const file = path.join(directory, entry.name);
			if (entry.isSymbolicLink()) throw new Error(`release runtime source must not be a symlink: ${path.relative(root, file)}`);
			if (entry.isDirectory()) visit(file);
			else if (entry.isFile() && (entry.name.endsWith(".mjs") || entry.name.endsWith(".py"))) files.push(file);
		}
	};
	visit(path.join(root, "src"));
	return files.sort();
}

const MANAGED_RELEASE_NAME = /^[0-9a-f]{40,64}$/u;
const MANAGED_TOMBSTONE_NAME = /^\.([0-9a-f]{40,64})\.gc-[0-9]+-[0-9]+$/u;
const GUARDED_LAUNCHER_MARKER = "cc-channel-runner-protocol: 1";
const UNGUARDED_MIGRATION_MARKER = ".cc-unguarded-launch";
const ROLLBACK_TRANSACTION_FILE = ".rollback-transaction.json";
const LAUNCH_LEASE_GRACE_MS = 60_000;
const RUNTIME_LOCK_WAIT_MS = 30_000;

function usage() {
	return `Install stable and beta cc channels from immutable reviewed candidates.

Usage:
  node scripts/install-channel.mjs <stable|beta|all> [options]
  node scripts/install-channel.mjs <stable|beta> --rollback [options]

Options:
  --ref <git-ref>   Override main (stable) or origin/ux-0711 (beta)
  --candidate-dir <path>
                     Promote the protected validated candidate in this directory
  --expected-commit <sha>
                     Independently anchor --candidate-dir to this reviewed commit
  --repo <path>     Source git repository (default: repository containing this script)
  --root <path>     Install root (default: ~/.local/share/cc)
  --bin-dir <path>  Launcher directory (default: ~/.local/bin)
  --rollback        Atomically swap current and previous releases
  -h, --help        Show this help

Environment overrides: CC_INSTALL_ROOT and CC_BIN_DIR.`;
}

export function parseArgs(argv) {
	const options = { target: undefined, ref: undefined, candidateDir: undefined, expectedCommit: undefined, repo: undefined, root: undefined, binDir: undefined, rollback: false };
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (value === "-h" || value === "--help") return { ...options, help: true };
		if (value === "--rollback") {
			options.rollback = true;
			continue;
		}
		if (["--ref", "--candidate-dir", "--expected-commit", "--repo", "--root", "--bin-dir"].includes(value)) {
			const next = argv[index + 1];
			if (!next || next.startsWith("--")) throw new Error(`${value} requires a value`);
			index += 1;
			if (value === "--ref") options.ref = next;
			else if (value === "--candidate-dir") options.candidateDir = path.resolve(next);
			else if (value === "--expected-commit") options.expectedCommit = next.toLowerCase();
			else if (value === "--repo") options.repo = next;
			else if (value === "--root") options.root = next;
			else options.binDir = next;
			continue;
		}
		if (value.startsWith("-")) throw new Error(`unknown option: ${value}`);
		if (options.target) throw new Error(`unexpected argument: ${value}`);
		options.target = value;
	}
	if (!options.target) throw new Error("choose a channel: stable, beta, or all");
	if (![...Object.keys(CHANNELS), "all"].includes(options.target)) throw new Error(`unknown channel: ${options.target}`);
	if (options.target === "all" && options.ref) throw new Error("--ref cannot be used with all; install each channel separately");
	if (options.target === "all" && options.candidateDir) throw new Error("--candidate-dir requires one channel");
	if (options.target === "all" && options.expectedCommit) throw new Error("--expected-commit requires one channel");
	if (options.target === "all" && options.rollback) throw new Error("--rollback requires one channel");
	if (options.rollback && options.candidateDir) throw new Error("--candidate-dir cannot be combined with --rollback");
	if (options.ref && options.candidateDir) throw new Error("--candidate-dir cannot be combined with --ref");
	if (options.candidateDir && !/^[0-9a-f]{40}$/u.test(options.expectedCommit ?? "")) throw new Error("--candidate-dir requires --expected-commit with a full reviewed Git SHA");
	if (options.expectedCommit && !options.candidateDir) throw new Error("--expected-commit requires --candidate-dir");
	return options;
}

function defaultDataRoot(home = os.homedir(), env = process.env) {
	return path.resolve(env.CC_INSTALL_ROOT || path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "cc"));
}

function defaultBinDir(home = os.homedir(), env = process.env) {
	return path.resolve(env.CC_BIN_DIR || path.join(home, ".local", "bin"));
}

export function channelPaths(channel, options = {}) {
	if (!CHANNELS[channel]) throw new Error(`unknown channel: ${channel}`);
	const home = options.home ?? os.homedir();
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const root = path.resolve(options.root || defaultDataRoot(home, env));
	const binDir = path.resolve(options.binDir || defaultBinDir(home, env));
	const channelDir = path.join(root, "channels", channel);
	return {
		platform,
		home,
		root,
		binDir,
		channelDir,
		releasesDir: path.join(channelDir, "releases"),
		leasesDir: path.join(channelDir, "leases"),
		runtimeLockDir: path.join(channelDir, ".launch-gc-lock"),
		currentLink: path.join(channelDir, "current"),
		previousLink: path.join(channelDir, "previous"),
		lockDir: path.join(channelDir, ".install-lock"),
		stateDir: path.join(channelDir, "state"),
		runner: path.join(channelDir, "channel-runner.mjs"),
		// Fork lineage and its operation lock describe the shared backend session
		// store, not beta UI preferences. Beta falls back to stable's ordinary path;
		// renderLauncher still preserves an explicit user CC_FORKS override.
		sharedForksPath: path.join(home, ".config", "cc", "forks.json"),
		launcher: path.join(binDir, `${CHANNELS[channel].command}${platform === "win32" ? ".cmd" : ""}`),
	};
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		env: options.env ?? process.env,
		encoding: options.encoding,
		input: options.input,
		maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024,
		stdio: options.stdio ?? (options.encoding ? ["ignore", "pipe", "pipe"] : "inherit"),
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const detail = String(result.stderr ?? "").trim();
		throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ` (status ${result.status})`}`);
	}
	return result;
}

function credentialFreeEnvironment(environment = process.env, platform = process.platform) {
	const scrubbed = { ...environment };
	for (const [name, value] of Object.entries(scrubbed)) {
		if (/^GIT_/iu.test(name) || /(?:key|token|secret|password|credential|auth)/iu.test(name) || /(?:^|_)pat(?:_|$)/iu.test(name) ||
			/^npm_config_.*(?:auth|token|userconfig|globalconfig)/iu.test(name) || /[\r\n]/u.test(String(value ?? "")) || credentialBearingUrl(value)) delete scrubbed[name];
	}
	const configs = emptyNpmConfigFiles();
	scrubbed.npm_config_userconfig = configs.user;
	scrubbed.npm_config_globalconfig = configs.global;
	return scrubbed;
}

let emptyNpmConfigs;
function emptyNpmConfigFiles() {
	if (emptyNpmConfigs) return emptyNpmConfigs;
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cc-empty-npm-config-"));
	const user = path.join(directory, "user.npmrc");
	const global = path.join(directory, "global.npmrc");
	fs.writeFileSync(user, "", { mode: 0o600 });
	fs.writeFileSync(global, "", { mode: 0o600 });
	emptyNpmConfigs = { user, global };
	process.once("exit", () => { try { fs.rmSync(directory, { recursive: true, force: true }); } catch {} });
	return emptyNpmConfigs;
}

function credentialBearingUrl(value) {
	if (typeof value !== "string" || !value.includes("://")) return false;
	if (/[\r\n]/u.test(value) || /[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/iu.test(value) ||
		/[a-z][a-z0-9+.-]*:\/\/[^\s]*[?#]/iu.test(value)) return true;
	try {
		const parsed = new URL(value);
		// Query strings and fragments are opaque enough that a token cannot be
		// distinguished reliably from ordinary data. Child install/verification
		// processes do not need such URLs, so exclude them conservatively.
		return Boolean(parsed.username || parsed.password || parsed.search || parsed.hash);
	} catch { return false; }
}

export function resolveCommit(repo, ref, runCommand = run) {
	repo = path.resolve(repo);
	const environment = credentialFreeEnvironment();
	environment.GIT_NO_REPLACE_OBJECTS = "1";
	const windowsTrustedRoots = process.platform === "win32" ? windowsTrustedExecutableRoots() : [];
	const git = runCommand === run
		? trustedExecutableOnPath("git", environment, [repo, ...userControlledPathRoots(process.cwd())], {
			platform: process.platform, requireRootOwnership: process.platform !== "win32", allowedRoots: windowsTrustedRoots, windowsRoots: windowsTrustedRoots,
		})
		: "git";
	const result = runCommand(git, ["--no-replace-objects", "-C", repo, "rev-parse", "--verify", `${ref}^{commit}`], {
		cwd: repo,
		encoding: "utf8",
		env: environment,
	});
	const commit = String(result.stdout ?? "").trim().toLowerCase();
	if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error(`git returned an invalid commit for ${ref}`);
	return commit;
}

export function archiveRepository(repo, commit, destination, runCommand = run) {
	repo = path.resolve(repo);
	const env = credentialFreeEnvironment();
	env.GIT_NO_REPLACE_OBJECTS = "1";
	const excludedRoots = [repo, destination, ...userControlledPathRoots(process.cwd())];
	const trustOptions = {
		platform: process.platform,
		requireRootOwnership: process.platform !== "win32",
		allowedRoots: process.platform === "win32" ? windowsTrustedExecutableRoots() : [],
	};
	trustOptions.windowsRoots = trustOptions.allowedRoots;
	const git = runCommand === run ? trustedExecutableOnPath("git", env, excludedRoots, trustOptions) : "git";
	const tar = runCommand === run ? trustedExecutableOnPath("tar", env, excludedRoots, trustOptions) : "tar";
	const archive = runCommand(git, ["--no-replace-objects", "-C", repo, "archive", "--format=tar", commit], {
		cwd: repo,
		encoding: null,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	runCommand(tar, ["-x", "-f", "-", "-C", destination], {
		input: archive.stdout,
		env,
		stdio: ["pipe", "inherit", "inherit"],
	});
}

const MAX_CANDIDATE_BYTES = 64 * 1024 * 1024;
const MAX_CANDIDATE_UNPACKED_BYTES = 64 * 1024 * 1024;
const MAX_CANDIDATE_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_CANDIDATE_ENTRIES = 4096;
const MAX_CANDIDATE_PATH_BYTES = 512;

export function snapshotCandidateTarball(candidate, destination) {
	const snapshot = path.join(destination, `.candidate-${randomUUID()}.tgz`);
	const sourceFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
	let source;
	let target;
	try {
		source = fs.openSync(candidate.tarball, sourceFlags);
		const before = fs.fstatSync(source, { bigint: true });
		if (!before.isFile() || before.size > BigInt(MAX_CANDIDATE_BYTES)) {
			throw new Error("protected candidate tarball is not a bounded regular file");
		}
		target = fs.openSync(snapshot, "wx", 0o600);
		const digest = createHash("sha256");
		const buffer = Buffer.allocUnsafe(1024 * 1024);
		let total = 0;
		for (;;) {
			const count = fs.readSync(source, buffer, 0, buffer.length, null);
			if (count === 0) break;
			total += count;
			if (total > MAX_CANDIDATE_BYTES) throw new Error("protected candidate tarball exceeds the size limit");
			digest.update(buffer.subarray(0, count));
			let offset = 0;
			while (offset < count) offset += fs.writeSync(target, buffer, offset, count - offset);
		}
		fs.fsyncSync(target);
		const after = fs.fstatSync(source, { bigint: true });
		if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || BigInt(total) !== before.size ||
			digest.digest("hex") !== candidate.provenance.sha256) {
			throw new Error("protected candidate changed while it was being pinned for extraction");
		}
		return snapshot;
	} catch (error) {
		fs.rmSync(snapshot, { force: true });
		throw error;
	} finally {
		if (target !== undefined) fs.closeSync(target);
		if (source !== undefined) fs.closeSync(source);
	}
}

function tarString(field) {
	const end = field.indexOf(0);
	const value = field.subarray(0, end < 0 ? field.length : end).toString("utf8");
	if (value.includes("\ufffd")) throw new Error("validated candidate archive contains an invalid UTF-8 path");
	return value;
}

function tarOctal(field, label) {
	if ((field[0] & 0x80) !== 0) throw new Error(`validated candidate archive uses unsupported base-256 ${label}`);
	const value = tarString(field).trim();
	if (!/^[0-7]+$/u.test(value)) throw new Error(`validated candidate archive has invalid ${label}`);
	const number = Number.parseInt(value, 8);
	if (!Number.isSafeInteger(number) || number < 0) throw new Error(`validated candidate archive has unbounded ${label}`);
	return number;
}

function assertSafeCandidateArchive(tarball) {
	let archive;
	try {
		archive = gunzipSync(fs.readFileSync(tarball), { maxOutputLength: MAX_CANDIDATE_UNPACKED_BYTES });
	} catch (error) {
		throw new Error("validated candidate archive exceeds its expanded-size limit or is not valid gzip", { cause: error });
	}
	let offset = 0;
	let entries = 0;
	let totalBytes = 0;
	let ended = false;
	let deferredSpecialEntry = false;
	while (offset + 512 <= archive.length) {
		const header = archive.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) { ended = true; break; }
		entries += 1;
		if (entries > MAX_CANDIDATE_ENTRIES) throw new Error("validated candidate archive contains too many entries");
		const recordedChecksum = tarOctal(header.subarray(148, 156), "checksum");
		let checksum = 0;
		for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 0x20 : header[index];
		if (checksum !== recordedChecksum) throw new Error("validated candidate archive header checksum mismatch");
		const type = header[156];
		const name = tarString(header.subarray(0, 100));
		const prefix = tarString(header.subarray(345, 500));
		const entry = prefix ? `${prefix}/${name}` : name;
		const size = tarOctal(header.subarray(124, 136), "entry size");
		if (size > MAX_CANDIDATE_ENTRY_BYTES) throw new Error("validated candidate archive entry exceeds the size limit");
		totalBytes += size;
		if (totalBytes > MAX_CANDIDATE_UNPACKED_BYTES) throw new Error("validated candidate archive content exceeds the size limit");
		const nextOffset = offset + 512 + Math.ceil(size / 512) * 512;
		if (nextOffset > archive.length) throw new Error("validated candidate archive is truncated");
		if (type === 0x78) {
			// BSD tar represents sparse files through a PAX record whose stored body
			// can be tiny while extraction materializes the declared logical size.
			// Inspect that bound before rejecting the unsupported metadata entry.
			const pax = archive.subarray(offset + 512, offset + 512 + size).toString("utf8");
			const sparseSize = /(?:^|\n)\d+ GNU\.sparse\.(?:realsize|size)=(\d+)\n/u.exec(pax)?.[1];
			if (sparseSize) {
				try {
					if (BigInt(sparseSize) > BigInt(MAX_CANDIDATE_UNPACKED_BYTES)) {
						throw new Error("validated candidate archive exceeds its expanded-size limit");
					}
				} catch (error) {
					if (/expanded-size limit/u.test(error?.message ?? "")) throw error;
					throw new Error("validated candidate archive contains invalid sparse-file metadata", { cause: error });
				}
			}
			deferredSpecialEntry = true;
			offset = nextOffset;
			continue;
		}
		if (![0, 0x30, 0x35].includes(type)) throw new Error("validated candidate archive contains a link or special filesystem entry");
		if (entry.split("/").some((part) => part.startsWith("._"))) {
			deferredSpecialEntry = true;
			offset = nextOffset;
			continue;
		}
		const packageRootDirectory = entry === "package" && type === 0x35;
		if (Buffer.byteLength(entry, "utf8") > MAX_CANDIDATE_PATH_BYTES ||
			(!packageRootDirectory && !entry.startsWith("package/"))) {
			throw new Error("validated candidate contains an unsafe package archive path");
		}
		const relative = packageRootDirectory ? "" : entry.slice("package/".length).replace(/\/$/u, "");
		if ((!relative && type !== 0x35) || relative.includes("\\") || (relative && relative.split("/").some((part) => part === "." || part === ".." || !part))) {
			throw new Error("validated candidate contains an unsafe package archive path");
		}
		if (type === 0x35 && size !== 0) throw new Error("validated candidate archive directory contains data");
		offset = nextOffset;
	}
	if (!ended || entries === 0 || archive.subarray(offset).some((byte) => byte !== 0)) {
		throw new Error("validated candidate archive has invalid termination");
	}
	if (deferredSpecialEntry) throw new Error("validated candidate archive contains a link or special filesystem entry");
}

export function extractReleaseCandidate(candidate, destination, runCommand = run) {
	const environment = credentialFreeEnvironment();
	const excludedRoots = [candidate.root, destination, ...userControlledPathRoots(process.cwd())];
	const tar = runCommand === run
		? trustedExecutableOnPath("tar", environment, excludedRoots, { requireRootOwnership: process.platform !== "win32" })
		: "tar";
	assertSafeCandidateArchive(candidate.tarball);
	runCommand(tar, ["-xzf", candidate.tarball, "--strip-components", "1", "-C", destination], {
		env: environment, stdio: "inherit",
	});
}

export function verifyCandidateMatchesCommit(candidate, repo, commit, runCommand = run) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candidate-source-"));
	const source = path.join(root, "source");
	const packed = path.join(root, "packed");
	fs.mkdirSync(source, { mode: 0o700 });
	fs.mkdirSync(packed, { mode: 0o700 });
	try {
		const resolved = resolveCommit(repo, commit, runCommand);
		if (resolved !== commit) throw new Error("reviewed candidate commit does not resolve to the independently supplied SHA");
		archiveRepository(repo, commit, source, runCommand);
		const environment = credentialFreeEnvironment();
		const npm = npmInvocation({ env: environment });
		const npmInstallationSha256 = assertPinnedNpmInstallation(npm.prefixArgs[0]);
		const version = runCommand(npm.command, [...npm.prefixArgs, "--version"], {
			encoding: "utf8", env: environment, stdio: ["ignore", "pipe", "pipe"],
		});
		if (process.versions.node !== RELEASE_NODE_VERSION || String(version.stdout ?? "").trim() !== RELEASE_NPM_VERSION ||
			npmInstallationSha256 !== releaseNpmInstallationSha256() || JSON.stringify(candidate.provenance.toolchain) !== JSON.stringify({
				nodeVersion: RELEASE_NODE_VERSION, npmVersion: RELEASE_NPM_VERSION, npmInstallationSha256: RELEASE_NPM_INSTALLATION_SHA256,
			})) {
			throw new Error("candidate source verification requires the exact pinned Node/npm toolchain");
		}
		if (assertPinnedNpmInstallation(npm.prefixArgs[0]) !== npmInstallationSha256) {
			throw new Error("candidate source verification npm installation changed before packing");
		}
		const result = runCommand(npm.command, [...npm.prefixArgs, "pack", "--ignore-scripts", "--json", "--pack-destination", packed], {
			cwd: source, encoding: "utf8", env: environment, stdio: ["ignore", "pipe", "pipe"],
		});
		if (assertPinnedNpmInstallation(npm.prefixArgs[0]) !== npmInstallationSha256) {
			throw new Error("candidate source verification npm installation changed while packing");
		}
		const metadata = JSON.parse(String(result.stdout ?? ""));
		if (!Array.isArray(metadata) || metadata.length !== 1 || typeof metadata[0]?.filename !== "string") {
			throw new Error("trusted commit did not produce exactly one package candidate");
		}
		const trustedTarball = path.join(packed, metadata[0].filename);
		const digest = createHash("sha256").update(fs.readFileSync(trustedTarball)).digest("hex");
		if (digest !== candidate.provenance.sha256) {
			throw new Error("protected candidate does not exactly match the independently reviewed Git commit");
		}
		return true;
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

export function installDependencies(releaseDir, runCommand = run, context = {}) {
	const nodeVersion = context.nodeVersion ?? process.versions.node;
	if (!versionAtLeast(nodeVersion, "22.19.0")) throw new Error(`channel installation requires Node.js 22.19.0 or newer; found ${nodeVersion}`);
	const lockFile = fs.existsSync(path.join(releaseDir, "npm-shrinkwrap.json")) ? "npm-shrinkwrap.json" : "package-lock.json";
	let lock;
	try { lock = JSON.parse(fs.readFileSync(path.join(releaseDir, lockFile), "utf8")); }
	catch (error) { throw new Error(`release has no valid ${lockFile}`, { cause: error }); }
	validateShrinkwrapProvenance(lock);
	const environment = {
		...credentialFreeEnvironment(process.env, context.platform ?? process.platform),
		CC_SKIP_ADAPTER_INSTALL: "1",
		npm_config_global: "false",
	};
	// A user's npm omit/optional defaults must not produce a release whose JS
	// adapters exist but whose native Claude/Codex payloads are absent.
	for (const name of ["npm_config_optional", "NPM_CONFIG_OPTIONAL", "npm_config_omit", "NPM_CONFIG_OMIT"]) {
		delete environment[name];
	}
	const npm = npmInvocation({
		platform: context.platform,
		env: environment,
		execPath: context.execPath,
	});
	const authenticateNpm = context.assertPinnedNpmInstallation ?? assertPinnedNpmInstallation;
	const npmInstallationSha256 = authenticateNpm(npm.prefixArgs[0]);
	const versionResult = runCommand(npm.command, [...npm.prefixArgs, "--version"], {
		encoding: "utf8", env: environment, stdio: ["ignore", "pipe", "inherit"],
	});
	const npmVersion = versionResult.status === 0 ? String(versionResult.stdout ?? "").trim() : "";
	if (npmVersion !== "10.9.3") throw new Error(`channel installation requires exact npm 10.9.3; found ${npmVersion || "unavailable"}`);
	if (authenticateNpm(npm.prefixArgs[0]) !== npmInstallationSha256) throw new Error("channel npm installation changed before dependency installation");
	runCommand(npm.command, [...npm.prefixArgs, "ci", "--global=false", "--omit=dev", "--include=optional", "--no-audit", "--no-fund"], {
		cwd: releaseDir,
		env: environment,
	});
	if (authenticateNpm(npm.prefixArgs[0]) !== npmInstallationSha256) throw new Error("channel npm installation changed during dependency installation");
	return {
		nodeVersion,
		npmVersion,
		npmInstallationSha256,
	};
}

/** Locate npm beside the exact Node runtime already executing this installer. */
export function npmInvocation(options = {}) {
	const execPath = path.resolve(options.execPath ?? process.execPath);
	const candidates = [];
	const add = (candidate) => {
		if (typeof candidate !== "string" || !candidate.trim()) return;
		const resolved = path.resolve(candidate.trim());
		if (!candidates.includes(resolved)) candidates.push(resolved);
	};
	// Never resolve npm through PATH or npm_execpath: those values are inherited
	// attacker-controlled inputs. Standard Node distributions place npm in one
	// of these locations under the same installation prefix as process.execPath.
	add(path.join(path.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js"));
	add(path.join(path.dirname(execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
	const cli = candidates.find((candidate) => {
		try {
			return path.basename(candidate).toLowerCase() === "npm-cli.js" && fs.statSync(candidate).isFile();
		} catch {
			return false;
		}
	});
	if (!cli) {
		throw new Error("could not locate npm-cli.js beside the active Node installation");
	}
	return { command: execPath, prefixArgs: [cli] };
}

function parseVersion(value) {
	const match = String(value ?? "").match(/^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/);
	return match ? match.slice(1).map(Number) : undefined;
}

export function versionAtLeast(value, minimum) {
	const actual = parseVersion(value);
	const required = parseVersion(minimum);
	if (!actual || !required || /-/.test(String(value))) return false;
	for (let index = 0; index < 3; index += 1) {
		if (actual[index] !== required[index]) return actual[index] > required[index];
	}
	return true;
}

export function inspectAdapter(releaseDir, adapter) {
	const primaryModules = path.join(releaseDir, "node_modules");
	const fallbackModules = path.join(releaseDir, ".cc-adapters", "node_modules");
	const primaryPackage = path.join(primaryModules, ...adapter.package.split("/"));
	const fallbackPackage = path.join(fallbackModules, ...adapter.package.split("/"));
	const packageDir = [primaryPackage, fallbackPackage].find((candidate) => fs.existsSync(path.join(candidate, "package.json")));
	if (!packageDir) throw new Error(`${adapter.package} is not installed in this release`);
	const manifestPath = path.join(packageDir, "package.json");
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	if (manifest.name !== adapter.package) throw new Error(`unexpected package at ${manifestPath}`);
	if (adapter.minimumVersion && !versionAtLeast(manifest.version, adapter.minimumVersion)) {
		throw new Error(`${adapter.package} ${manifest.version} is older than ${adapter.minimumVersion}`);
	}
	const binEntry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[adapter.bin];
	if (!binEntry || !fs.statSync(path.resolve(packageDir, binEntry)).isFile()) {
		throw new Error(`${adapter.package} does not contain its ${adapter.bin} entrypoint`);
	}
	const modulesDir = packageDir === fallbackPackage ? fallbackModules : primaryModules;
	const shim = path.join(modulesDir, ".bin", process.platform === "win32" ? `${adapter.bin}.cmd` : adapter.bin);
	fs.accessSync(shim, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
	return { package: adapter.package, version: manifest.version, bin: adapter.bin };
}

function nativePlatformNames(platform = process.platform, arch = process.arch, libc = undefined) {
	if (!["x64", "arm64"].includes(arch) || !["darwin", "linux", "win32"].includes(platform)) {
		throw new Error(`unsupported native backend platform: ${platform}-${arch}`);
	}
	let resolvedLibc = libc;
	if (platform === "linux" && !resolvedLibc) {
		const report = process.report?.getReport?.();
		resolvedLibc = report?.header?.glibcVersionRuntime ? "glibc" : "musl";
	}
	const claudeSuffix = platform === "linux" && resolvedLibc === "musl"
		? `${platform}-${arch}-musl`
		: `${platform}-${arch}`;
	return {
		claude: `@anthropic-ai/claude-agent-sdk-${claudeSuffix}`,
		codex: `@openai/codex-${platform}-${arch}`,
	};
}

function packageDirectoryInRoots(roots, packageName) {
	for (const modulesDir of roots) {
		const candidate = path.join(modulesDir, ...packageName.split("/"));
		if (fs.existsSync(path.join(candidate, "package.json"))) return { packageDir: candidate, modulesDir };
	}
	return undefined;
}

function requireNativeFile(file, platform) {
	if (!fs.statSync(file).isFile()) throw new Error(`native backend payload is not a file: ${file}`);
	fs.accessSync(file, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
	return file;
}

function requireOptionalPackageIdentity(parentManifest, aliasName, packageDir) {
	const specification = parentManifest.optionalDependencies?.[aliasName];
	let expectedName = aliasName;
	let expectedVersion = specification;
	if (typeof specification === "string" && specification.startsWith("npm:")) {
		const target = specification.slice(4);
		const separator = target.lastIndexOf("@");
		if (separator <= 0 || separator === target.length - 1) {
			throw new Error(`${parentManifest.name} declares an unsupported native alias ${specification}`);
		}
		expectedName = target.slice(0, separator);
		expectedVersion = target.slice(separator + 1);
	}
	if (typeof expectedVersion !== "string" || !expectedVersion) {
		throw new Error(`${parentManifest.name} does not pin ${aliasName} to a native package version`);
	}
	const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
	if (manifest.name !== expectedName || manifest.version !== expectedVersion) {
		throw new Error(
			`${aliasName} native payload mismatch: expected ${expectedName}@${expectedVersion}, ` +
			`found ${manifest.name ?? "unknown"}@${manifest.version ?? "unknown"}`,
		);
	}
}

/** Verify the platform payloads that the adapter shims load at runtime. */
export function inspectNativePayloads(releaseDir, options = {}) {
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const strict = options.strict !== false;
	const names = nativePlatformNames(platform, arch, options.libc);
	const releaseManifest = JSON.parse(fs.readFileSync(path.join(releaseDir, "package.json"), "utf8"));
	const roots = [
		path.join(releaseDir, "node_modules"),
		path.join(releaseDir, ".cc-adapters", "node_modules"),
	];
	const claudeAdapter = packageDirectoryInRoots(roots, "@agentclientprotocol/claude-agent-acp");
	const claudeSdk = packageDirectoryInRoots(roots, "@anthropic-ai/claude-agent-sdk");
	const codexCli = packageDirectoryInRoots(roots, "@openai/codex");
	if (strict && !claudeAdapter) throw new Error("@agentclientprotocol/claude-agent-acp is not installed in this release");
	if (!claudeSdk) throw new Error("@anthropic-ai/claude-agent-sdk is not installed in this release");
	if (!codexCli) throw new Error("@openai/codex is not installed in this release");
	const claudeAdapterManifest = claudeAdapter
		? JSON.parse(fs.readFileSync(path.join(claudeAdapter.packageDir, "package.json"), "utf8"))
		: undefined;
	const claudeManifest = JSON.parse(fs.readFileSync(path.join(claudeSdk.packageDir, "package.json"), "utf8"));
	const codexManifest = JSON.parse(fs.readFileSync(path.join(codexCli.packageDir, "package.json"), "utf8"));
	const expectedClaudeVersion = releaseManifest.dependencies?.["@anthropic-ai/claude-agent-sdk"];
	const expectedCodexVersion = releaseManifest.dependencies?.["@openai/codex"];
	if (strict && (typeof expectedClaudeVersion !== "string" || claudeManifest.name !== "@anthropic-ai/claude-agent-sdk" || claudeManifest.version !== expectedClaudeVersion)) {
		throw new Error(
			`direct Claude Agent SDK mismatch: expected @anthropic-ai/claude-agent-sdk@${expectedClaudeVersion ?? "(missing pin)"}, ` +
			`found ${claudeManifest.name ?? "unknown"}@${claudeManifest.version ?? "unknown"}`,
		);
	}
	if (strict && (typeof expectedCodexVersion !== "string" || codexManifest.name !== "@openai/codex" || codexManifest.version !== expectedCodexVersion)) {
		throw new Error(
			`direct Codex CLI mismatch: expected @openai/codex@${expectedCodexVersion ?? "(missing pin)"}, ` +
			`found ${codexManifest.name ?? "unknown"}@${codexManifest.version ?? "unknown"}`,
		);
	}
	const adapterSdkVersion = claudeAdapterManifest?.dependencies?.["@anthropic-ai/claude-agent-sdk"];
	if (strict && (typeof adapterSdkVersion !== "string" || !adapterSdkVersion)) {
		throw new Error("@agentclientprotocol/claude-agent-acp does not pin @anthropic-ai/claude-agent-sdk");
	}
	const nestedAdapterSdk = strict ? packageDirectoryInRoots(
		[path.join(claudeAdapter.packageDir, "node_modules")],
		"@anthropic-ai/claude-agent-sdk",
	) : undefined;
	const adapterSdk = strict
		? nestedAdapterSdk ?? (claudeManifest.version === adapterSdkVersion ? claudeSdk : undefined)
		: claudeSdk;
	if (!adapterSdk) {
		throw new Error(`Claude ACP Agent SDK ${adapterSdkVersion} is not installed in the adapter resolution tree`);
	}
	const adapterSdkManifest = JSON.parse(fs.readFileSync(path.join(adapterSdk.packageDir, "package.json"), "utf8"));
	if (strict && (adapterSdkManifest.name !== "@anthropic-ai/claude-agent-sdk" || adapterSdkManifest.version !== adapterSdkVersion)) {
		throw new Error(
			`Claude ACP Agent SDK mismatch: expected @anthropic-ai/claude-agent-sdk@${adapterSdkVersion}, ` +
			`found ${adapterSdkManifest.name ?? "unknown"}@${adapterSdkManifest.version ?? "unknown"}`,
		);
	}
	if (!Object.hasOwn(claudeManifest.optionalDependencies ?? {}, names.claude)) {
		throw new Error(`${claudeManifest.name} does not declare ${names.claude}`);
	}
	if (strict && !Object.hasOwn(adapterSdkManifest.optionalDependencies ?? {}, names.claude)) {
		throw new Error(`the Claude ACP Agent SDK does not declare ${names.claude}`);
	}
	if (!Object.hasOwn(codexManifest.optionalDependencies ?? {}, names.codex)) {
		throw new Error(`${codexManifest.name} does not declare ${names.codex}`);
	}
	const claudeNative = packageDirectoryInRoots(roots, names.claude);
	const adapterClaudeNative = strict ? packageDirectoryInRoots(
		[path.join(adapterSdk.packageDir, "node_modules"), path.join(claudeAdapter.packageDir, "node_modules"), ...roots],
		names.claude,
	) : claudeNative;
	const codexNative = packageDirectoryInRoots(roots, names.codex);
	if (!claudeNative) throw new Error(`${names.claude} native payload is not installed`);
	if (!adapterClaudeNative) throw new Error(`${names.claude} native payload for Claude ACP is not installed`);
	if (!codexNative) throw new Error(`${names.codex} native payload is not installed`);
	requireOptionalPackageIdentity(claudeManifest, names.claude, claudeNative.packageDir);
	if (strict) requireOptionalPackageIdentity(adapterSdkManifest, names.claude, adapterClaudeNative.packageDir);
	requireOptionalPackageIdentity(codexManifest, names.codex, codexNative.packageDir);
	const claudeBinary = requireNativeFile(
		path.join(claudeNative.packageDir, platform === "win32" ? "claude.exe" : "claude"),
		platform,
	);
	const adapterClaudeBinary = requireNativeFile(
		path.join(adapterClaudeNative.packageDir, platform === "win32" ? "claude.exe" : "claude"),
		platform,
	);
	const vendorDir = path.join(codexNative.packageDir, "vendor");
	const codexBinaryName = platform === "win32" ? "codex.exe" : "codex";
	const codexBinary = fs.readdirSync(vendorDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => path.join(vendorDir, entry.name, "bin", codexBinaryName))
		.find((candidate) => {
			try {
				requireNativeFile(candidate, platform);
				return true;
			} catch {
				return false;
			}
		});
	if (!codexBinary) throw new Error(`${names.codex} does not contain an executable ${codexBinaryName}`);
	return {
		claude: { package: names.claude, binary: claudeBinary },
		claudeAcp: { package: names.claude, binary: adapterClaudeBinary },
		codex: { package: names.codex, binary: codexBinary },
	};
}

function releaseRequiresWorkflows(releaseDir, manifest) {
	const declaredFiles = Array.isArray(manifest?.files) ? manifest.files : [];
	return declaredFiles.some((entry) => String(entry).startsWith("src/workflows/")) ||
		["src/workflows", "LICENSE-APACHE-2.0", "src/harness/terminal-safety.mjs"]
			.some((relative) => fs.existsSync(path.join(releaseDir, relative)));
}

export function verifyRelease(releaseDir, runCommand = run) {
	let manifest;
	try { manifest = JSON.parse(fs.readFileSync(path.join(releaseDir, "package.json"), "utf8")); }
	catch (error) { throw new Error("release has an invalid package.json", { cause: error }); }
	const requiresWorkflows = releaseRequiresWorkflows(releaseDir, manifest);
	for (const relative of ["package.json", requiresWorkflows ? "npm-shrinkwrap.json" : "package-lock.json", ...(requiresWorkflows ? WORKFLOW_RELEASE_FILES : []), "src/cc.mjs", "src/pi-harness.mjs"]) {
		let stat;
		try { stat = fs.lstatSync(path.join(releaseDir, relative)); } catch (error) {
			if (error?.code === "ENOENT") throw new Error(`release is missing ${relative}`);
			throw error;
		}
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`release is missing ${relative}`);
	}
	const adapters = (requiresWorkflows ? CHANNEL_ADAPTERS : LEGACY_CHANNEL_ADAPTERS)
		.map((adapter) => inspectAdapter(releaseDir, adapter));
	inspectNativePayloads(releaseDir, { strict: requiresWorkflows });
	const credentialFreeEnv = credentialFreeEnvironment();
	const python = process.platform === "win32" ? undefined : trustedExecutableOnPath("python3", credentialFreeEnv, [releaseDir, ...userControlledPathRoots(process.cwd())]);
	const executablePathName = Object.keys(credentialFreeEnv).find((name) => name.toLowerCase() === "path") ?? "PATH";
	const env = {
		...credentialFreeEnv,
		[executablePathName]: [
			path.join(releaseDir, "node_modules", ".bin"),
			path.join(releaseDir, ".cc-adapters", "node_modules", ".bin"),
			credentialFreeEnv[executablePathName] ?? "",
		].join(path.delimiter),
		CC_SKIP_ADAPTER_INSTALL: "1",
	};
	if (process.platform !== "win32") {
		try {
			runCommand(python, ["-I", "-c", "import ast"], { env: credentialFreeEnv, stdio: ["ignore", "ignore", "pipe"] });
		} catch (error) {
			throw new Error("channel release verification requires python3 with the standard-library ast module", { cause: error });
		}
	}
	for (const file of runtimeSourceFiles(releaseDir)) {
		if (file.endsWith(".mjs")) runCommand(process.execPath, ["--check", file], { env });
		else if (process.platform !== "win32") runCommand(python, ["-I", "-c", "import ast,sys; ast.parse(open(sys.argv[1], encoding='utf-8').read(), filename=sys.argv[1])", file], { env: credentialFreeEnv });
	}
	runCommand(process.execPath, [path.join(releaseDir, "src", "cc.mjs"), "--help"], {
		env,
		stdio: ["ignore", "ignore", "pipe"],
	});
	return adapters;
}

function writeMetadata(releaseDir, metadata) {
	fs.writeFileSync(path.join(releaseDir, ".cc-channel.json"), `${JSON.stringify(metadata, null, 2)}\n`, {
		mode: 0o444,
	});
}

const RELEASE_RUNTIME_MARKERS = new Set([".cc-channel.json", ".cc-unguarded-launch"]);

function releaseContentDigest(releaseDir, options = {}) {
	const modeMask = options.modeMask ?? 0o777;
	const digest = createHash("sha256");
	digest.update(`d\0.\0${fs.lstatSync(releaseDir).mode & modeMask}\0`);
	const visit = (directory, prefix = "") => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (!prefix && RELEASE_RUNTIME_MARKERS.has(entry.name)) continue;
			const file = path.join(directory, entry.name);
			const stat = fs.lstatSync(file);
			if (stat.isDirectory()) {
				digest.update(`d\0${relative}\0${stat.mode & modeMask}\0`);
				visit(file, relative);
			} else if (stat.isFile()) {
				digest.update(`f\0${relative}\0${stat.mode & modeMask}\0${stat.size}\0`);
				digest.update(fs.readFileSync(file));
			} else if (stat.isSymbolicLink()) {
				digest.update(`l\0${relative}\0${fs.readlinkSync(file)}\0`);
			} else {
				throw new Error(`release contains an unsupported filesystem entry: ${relative}`);
			}
		}
	};
	visit(releaseDir);
	return digest.digest("hex");
}

function verifyInstalledReleaseContent(releaseDir, commit, context = {}, operations = {}) {
	let metadata;
	try { metadata = JSON.parse(fs.readFileSync(path.join(releaseDir, ".cc-channel.json"), "utf8")); }
	catch (error) { throw new Error(`release ${commit} has no valid channel metadata`, { cause: error }); }
	if (metadata?.commit !== commit) throw new Error(`release ${commit} metadata identifies a different commit`);
	if (metadata.contentManifestVersion === 1 && /^[0-9a-f]{64}$/u.test(metadata.contentSha256 ?? "")) {
		if (releaseContentDigest(releaseDir) !== metadata.contentSha256) throw new Error(`release ${commit} differs from its installed immutable content manifest`);
		return;
	}
	if (metadata.contentManifestVersion !== undefined || !context.repo) {
		throw new Error(`release ${commit} has no supported immutable content manifest and must be rematerialized from its immutable Git commit before reuse or rollback`);
	}
	// Releases installed before content manifests existed are upgraded only after
	// reproducing the exact Git snapshot and locked dependency closure. Comparing
	// the complete installed tree prevents a missing metadata field from becoming
	// a downgrade path for modified dependencies.
	const staging = fs.mkdtempSync(path.join(path.dirname(releaseDir), `.legacy-verify-${commit.slice(0, 12)}-`));
	try {
		if (process.platform !== "win32") {
			const releaseRootMode = fs.lstatSync(releaseDir).mode & 0o777;
			if ((releaseRootMode & 0o022) !== 0) throw new Error(`legacy release ${commit} has an unsafe writable root directory mode`);
			// The original installer requested 0755 but a restrictive caller umask may
			// legitimately have removed group/other read and execute bits throughout
			// npm's tree. Owner permissions and executable semantics must still match.
			fs.chmodSync(staging, releaseRootMode);
		}
		(operations.archiveRepository ?? archiveRepository)(context.repo, commit, staging, operations.runCommand ?? run);
		(operations.installDependencies ?? installDependencies)(staging, operations.runCommand ?? run, { channel: context.channel });
		const adapters = (operations.verifyRelease ?? verifyRelease)(staging, operations.runCommand ?? run);
		const legacyDigestOptions = process.platform === "win32" ? {} : { modeMask: 0o700 };
		const expectedDigest = releaseContentDigest(staging, legacyDigestOptions);
		if (releaseContentDigest(releaseDir, legacyDigestOptions) !== expectedDigest) {
			throw new Error(`legacy release ${commit} differs from its exact Git snapshot and locked dependency closure`);
		}
		const installedDigest = releaseContentDigest(releaseDir);
		atomicReplaceFile(path.join(releaseDir, ".cc-channel.json"), `${JSON.stringify({
			...metadata,
			contentManifestVersion: 1,
			contentSha256: installedDigest,
			manifestUpgradedAt: new Date().toISOString(),
			adapters,
		}, null, 2)}\n`, 0o444);
	} finally {
		fs.rmSync(staging, { recursive: true, force: true });
	}
}

export function materializeRelease(context, operations = {}) {
	const { repo, ref, commit, releaseDir, releasesDir, channel, candidate } = context;
	const existing = fs.existsSync(releaseDir);
	if (existing) {
		verifyInstalledReleaseContent(releaseDir, commit, { repo, channel }, operations);
		if (candidate) {
			const metadata = JSON.parse(fs.readFileSync(path.join(releaseDir, ".cc-channel.json"), "utf8"));
			if (metadata.candidateSha256 !== candidate.provenance.sha256 || metadata.packMetadataSha256 !== candidate.provenance.packMetadataSha256) {
				throw new Error(`release ${commit} was not materialized from the selected protected candidate`);
			}
		}
		const adapters = (operations.verifyRelease ?? verifyRelease)(releaseDir, operations.runCommand ?? run);
		return { releaseDir, adapters, reused: true };
	}
	fs.mkdirSync(releasesDir, { recursive: true, mode: 0o755 });
	const staging = path.join(releasesDir, `.${commit}.staging-${process.pid}-${Date.now()}`);
	fs.mkdirSync(staging, { mode: candidate ? 0o700 : 0o755 });
	try {
		if (candidate) {
			const snapshot = (operations.snapshotCandidateTarball ?? snapshotCandidateTarball)(candidate, staging);
			try {
				(operations.extractReleaseCandidate ?? extractReleaseCandidate)({ ...candidate, tarball: snapshot }, staging, operations.runCommand ?? run);
			} finally { fs.rmSync(snapshot, { force: true }); }
			if (process.platform !== "win32") fs.chmodSync(staging, 0o755);
		}
		else (operations.archiveRepository ?? archiveRepository)(repo, commit, staging, operations.runCommand ?? run);
		const toolchain = (operations.installDependencies ?? installDependencies)(staging, operations.runCommand ?? run, { channel });
		const adapters = (operations.verifyRelease ?? verifyRelease)(staging, operations.runCommand ?? run);
		const contentSha256 = releaseContentDigest(staging);
		writeMetadata(staging, {
			channel,
			commit,
			leaseProtocol: 1,
			contentManifestVersion: 1,
			ref,
			...(candidate ? {
				candidateSha256: candidate.provenance.sha256,
				packMetadataSha256: candidate.provenance.packMetadataSha256,
				validatedGates: candidate.validated.gates,
			} : {}),
			installedAt: new Date().toISOString(),
			node: process.version,
			toolchain,
			contentSha256,
			adapters,
		});
		syncTreeSync(staging);
		fs.renameSync(staging, releaseDir);
		syncDirectorySync(releasesDir);
		return { releaseDir, adapters, reused: false };
	} catch (error) {
		fs.rmSync(staging, { recursive: true, force: true });
		throw error;
	}
}

function shellQuote(value) {
	return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function batchValue(value) {
	const rendered = String(value);
	if (/[\r\n"]/.test(rendered)) throw new Error("Windows launcher paths cannot contain quotes or newlines");
	// Percent expansion still occurs inside SET's quoted assignment form. Doubling
	// it preserves literal percent characters in user-selected install paths.
	return rendered.replaceAll("%", "%%");
}

export function betaStateEnvironment(paths) {
	const configDir = path.join(paths.stateDir, "config");
	return {
		CC_CONFIG: path.join(configDir, "config.json"),
		CC_SETTINGS: path.join(configDir, "settings.json"),
		CC_PERMISSIONS: path.join(configDir, "permissions.json"),
		CC_COMMAND_CACHE: path.join(paths.stateDir, "cache", "commands.json"),
	};
}

const CHANNEL_STATE_ENVIRONMENT_KEYS = Object.freeze([
	"CC_CONFIG",
	"CC_SETTINGS",
	"CC_PERMISSIONS",
	"CC_COMMAND_CACHE",
]);

function legacyBetaForksPath(paths) {
	return path.join(paths.root, "channels", "beta", "state", "config", "forks.json");
}

/**
 * Keep beta credentials and history below owner-only directories. Existing
 * regular state files are tightened as well; symlinks are rejected so the
 * installer never chmods a target outside the channel state tree.
 */
export function prepareChannelState(channel, paths) {
	if (!CHANNELS[channel]?.isolateState) return;
	const directories = [
		paths.stateDir,
		path.join(paths.stateDir, "config"),
		path.join(paths.stateDir, "cache"),
	];
	for (const directory of directories) {
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		const stat = fs.lstatSync(directory);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new Error(`${directory} is not a private state directory`);
		}
		fs.chmodSync(directory, 0o700);
	}
	for (const file of Object.values(betaStateEnvironment(paths))) {
		let stat;
		try {
			stat = fs.lstatSync(file);
		} catch (error) {
			if (error?.code === "ENOENT") continue;
			throw error;
		}
		if (stat.isSymbolicLink() || !stat.isFile()) {
			throw new Error(`${file} is not a regular channel state file`);
		}
		fs.chmodSync(file, 0o600);
	}
}

function prepareChannelRuntime(paths) {
	fs.mkdirSync(paths.leasesDir, { recursive: true, mode: 0o700 });
	const stat = fs.lstatSync(paths.leasesDir);
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new Error(`${paths.leasesDir} is not a private channel lease directory`);
	}
	fs.chmodSync(paths.leasesDir, 0o700);
}

/**
 * Resolve `current` and publish the release lease under one channel-wide guard.
 * GC takes the same guard before it retires a canonical release name, so startup
 * cannot pause between resolution and leasing. Keeping this in a generated Node
 * runner gives POSIX and Windows identical coordination without leaving a shell
 * between the TUI and terminal signals.
 */
export function renderChannelRunner() {
	return `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const currentLink = process.argv[2];
const leasesDir = process.argv[3];
if (!currentLink || !leasesDir) {
	console.error("cc channel runner: missing channel runtime paths");
	process.exit(1);
}
let channelProcessToken = process.env.CC_CHANNEL_PROCESS_TOKEN;
let channelProcessPid = Number(process.env.CC_CHANNEL_PROCESS_PID);
if (process.platform === "darwin" && (!/^[0-9a-f]{32}$/u.test(channelProcessToken ?? "") || channelProcessPid !== process.pid)) {
	if (typeof process.execve !== "function") throw new Error("this Node runtime cannot establish a stable macOS channel process identity");
	channelProcessToken = randomUUID().replaceAll("-", "");
	channelProcessPid = process.pid;
	process.execve(process.execPath, process.argv, {
		...process.env, CC_CHANNEL_PROCESS_TOKEN: channelProcessToken, CC_CHANNEL_PROCESS_PID: String(channelProcessPid),
	});
	throw new Error("macOS channel runner re-exec unexpectedly returned");
}
if (!/^[0-9a-f]{32}$/u.test(channelProcessToken ?? "")) channelProcessToken = randomUUID().replaceAll("-", "");
channelProcessPid = process.pid;
process.env.CC_CHANNEL_PROCESS_TOKEN = channelProcessToken;
process.env.CC_CHANNEL_PROCESS_PID = String(channelProcessPid);

const guard = path.join(path.dirname(currentLink), ".launch-gc-lock");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const processIdentity = (pid) => {
	if (process.platform === "linux") {
		try {
			const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
			const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
			const close = stat.lastIndexOf(")");
			const fields = close >= 0 ? stat.slice(close + 2).trim().split(/\\s+/u) : [];
			if (fields[19] && bootId) return "linux:" + bootId + ":" + fields[19];
		} catch {}
	}
	if (process.platform === "win32") {
		// No portable Node API exposes a PID creation identity on Windows. Do not
		// trust module-autoloaded PowerShell/WMI output for a destructive lease.
		return undefined;
	}
	if (process.platform === "darwin") {
		if (pid === process.pid && channelProcessPid === pid && /^[0-9a-f]{32}$/u.test(channelProcessToken ?? "")) {
			return "darwin-token:" + pid + ":" + channelProcessToken;
		}
		const tokenResult = spawnSync("/bin/ps", ["eww", "-p", String(pid), "-o", "command="], {
			encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: false, timeout: 5000,
		});
		const fields = tokenResult.status === 0 ? tokenResult.stdout.split(/\\s+/u) : [];
		const token = fields.find((field) => /^CC_CHANNEL_PROCESS_TOKEN=[0-9a-f]{32}$/u.test(field))?.split("=")[1];
		const ownerPid = Number(fields.find((field) => /^CC_CHANNEL_PROCESS_PID=\\d+$/u.test(field))?.split("=")[1]);
		if (token && ownerPid === pid) return "darwin-token:" + pid + ":" + token;
		return undefined;
	}
	const ps = fs.existsSync("/bin/ps") ? "/bin/ps" : "/usr/bin/ps";
	const result = spawnSync(ps, ["-o", "lstart=", ...(process.platform === "darwin" ? ["-o", "command="] : []), "-p", String(pid)], {
		encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: false, timeout: 5000,
	});
	const started = result.status === 0 ? result.stdout.trim() : "";
	return started ? "ps:" + started : undefined;
};
const releaseOwnedGuard = (token) => {
	const owner = JSON.parse(fs.readFileSync(path.join(guard, "owner.json"), "utf8"));
	if (owner?.token !== token) throw new Error("channel maintenance guard ownership changed");
	fs.rmSync(guard, { recursive: true, force: true });
};
const acquireGuard = async () => {
	const deadline = Date.now() + ${RUNTIME_LOCK_WAIT_MS};
	const identity = processIdentity(process.pid);
	if (!identity) throw new Error("cannot establish a unique channel-runner process identity on this platform");
	for (;;) {
		const token = process.pid + "-" + Date.now() + "-" + Math.random().toString(16).slice(2);
		try {
			fs.mkdirSync(guard, { mode: 0o700 });
			try {
				fs.writeFileSync(
					path.join(guard, "owner.json"),
					JSON.stringify({ pid: process.pid, token, processIdentityVersion: 2, processIdentity: identity, startedAt: new Date().toISOString() }) + "\\n",
					{ flag: "wx", mode: 0o600 },
				);
			} catch (error) {
				fs.rmSync(guard, { recursive: true, force: true });
				throw error;
			}
			return () => releaseOwnedGuard(token);
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			// Launchers never reap a guard. An ownerless/corrupt claim may belong to a
			// process paused before owner publication; only a later installer can reap a
			// complete claim after proving that its recorded owner is dead.
			if (Date.now() >= deadline) {
				throw new Error("timed out waiting for channel maintenance; if no update is active, inspect " + guard + " before removing it, then rerun the channel installer");
			}
			await wait(25);
		}
	}
};

let entrypoint;
let lease;
let releaseGuard;
try {
	releaseGuard = await acquireGuard();
	process.once("exit", releaseGuard);
	const current = fs.realpathSync(currentLink);
	if (!fs.statSync(current).isDirectory()) throw new Error("current release is not a directory");
	const releaseId = path.basename(current);
	if (!/^[0-9a-f]{40,64}$/u.test(releaseId)) throw new Error("current release has an invalid identifier");
	entrypoint = fs.realpathSync(path.join(current, "src", "cc.mjs"));
	const leaseDir = path.join(leasesDir, releaseId);
	fs.mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
	const leaseIdentity = processIdentity(process.pid);
	if (!leaseIdentity) throw new Error("cannot establish a unique channel lease process identity on this platform");
	const leasePath = path.join(leaseDir, "run-" + process.pid + "-" + Math.random().toString(16).slice(2));
	fs.writeFileSync(leasePath, JSON.stringify({ pid: process.pid, processIdentityVersion: 2, processIdentity: leaseIdentity, startedAt: new Date().toISOString() }) + "\\n", { flag: "wx", mode: 0o600 });
	lease = leasePath;
	process.env.PATH = [
		path.join(current, "node_modules", ".bin"),
		path.join(current, ".cc-adapters", "node_modules", ".bin"),
		process.env.PATH || "",
	].filter(Boolean).join(path.delimiter);
} catch (error) {
	console.error("cc channel runner: release startup failed (" + (error?.message ?? error) + ")");
	process.exitCode = 1;
} finally {
	if (releaseGuard) process.removeListener("exit", releaseGuard);
	releaseGuard?.();
}
if (!entrypoint || !lease) process.exit(1);

let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  // Remove only this process's lease file. Removing the shared lease directory
  // here would race a starting runner between its guarded mkdir and lease
  // write; GC reaps empty lease directories while holding the launch/GC guard.
  try { fs.rmSync(lease, { force: true }); } catch {}
};

process.once("exit", cleanup);
process.argv.splice(1, 3, entrypoint);
try {
  await import(pathToFileURL(entrypoint).href);
} catch (error) {
  console.error("cc: " + (error?.stack ?? error?.message ?? error));
  process.exitCode = 1;
}
`;
}

export function renderLauncher(channel, paths, options = {}) {
	const state = CHANNELS[channel].isolateState ? betaStateEnvironment(paths) : {};
	const platform = options.platform ?? paths.platform ?? process.platform;
	if (platform === "win32") {
		const assignments = Object.entries(state)
			.map(([name, value]) => `set "${name}=${batchValue(value)}"`)
			.join("\r\n");
		const inheritedBetaReset = CHANNELS[channel].isolateState
			? ""
			: `if /I "%CC_CHANNEL%"=="beta" (\r
${CHANNEL_STATE_ENVIRONMENT_KEYS.map((name) => `  set "${name}="`).join("\r\n")}\r
  if /I "%CC_FORKS%"=="${batchValue(legacyBetaForksPath(paths))}" set "CC_FORKS="\r
)\r
`;
		const legacyBetaForkReset = CHANNELS[channel].isolateState
			? `if /I "%CC_FORKS%"=="${batchValue(legacyBetaForksPath(paths))}" set "CC_FORKS="\r
`
			: `set "CC_FORKS_MIGRATE_FROM="\r
`;
		const sharedForkAssignment = CHANNELS[channel].isolateState
			? `if not defined CC_FORKS (\r
  set "CC_FORKS=${batchValue(paths.sharedForksPath)}"\r
  set "CC_FORKS_MIGRATE_FROM=${batchValue(legacyBetaForksPath(paths))}"\r
) else (\r
  set "CC_FORKS_MIGRATE_FROM="\r
)\r
`
			: "";
		return `@echo off\r
rem ${GUARDED_LAUNCHER_MARKER}\r
setlocal DisableDelayedExpansion\r
${inheritedBetaReset}set "CURRENT_LINK=${batchValue(paths.currentLink)}"\r
set "CC_CHANNEL_NODE=node"\r
if defined CC_NODE_PATH set "CC_CHANNEL_NODE=%CC_NODE_PATH%"\r
set "CC_CHANNEL=${channel}"\r
${legacyBetaForkReset}${sharedForkAssignment}${assignments}${assignments ? "\r\n" : ""}"%CC_CHANNEL_NODE%" "${batchValue(paths.runner)}" "%CURRENT_LINK%" "${batchValue(paths.leasesDir)}" %*\r
exit /b %ERRORLEVEL%\r
`;
	}
	const exports = Object.entries(state).map(([name, value]) => `export ${name}=${shellQuote(value)}`);
	const inheritedBetaReset = CHANNELS[channel].isolateState
		? ""
		: `if [ "\${CC_CHANNEL:-}" = 'beta' ]; then
	unset ${CHANNEL_STATE_ENVIRONMENT_KEYS.join(" ")}
	if [ "\${CC_FORKS:-}" = ${shellQuote(legacyBetaForksPath(paths))} ]; then
		unset CC_FORKS
	fi
fi

`;
	const legacyBetaForkReset = CHANNELS[channel].isolateState
		? `if [ "\${CC_FORKS:-}" = ${shellQuote(legacyBetaForksPath(paths))} ]; then
	unset CC_FORKS
fi

`
		: `unset CC_FORKS_MIGRATE_FROM

`;
	const sharedForkAssignment = CHANNELS[channel].isolateState
		? `if [ -z "\${CC_FORKS:-}" ]; then
	export CC_FORKS=${shellQuote(paths.sharedForksPath)}
	export CC_FORKS_MIGRATE_FROM=${shellQuote(legacyBetaForksPath(paths))}
else
	unset CC_FORKS_MIGRATE_FROM
fi

`
		: "";
	return `#!/bin/sh
# ${GUARDED_LAUNCHER_MARKER}
set -eu

${inheritedBetaReset}CURRENT_LINK=${shellQuote(paths.currentLink)}
export CC_CHANNEL=${shellQuote(channel)}
${legacyBetaForkReset}${sharedForkAssignment}${exports.join("\n")}${exports.length ? "\n" : ""}exec "\${CC_NODE_PATH:-node}" ${shellQuote(paths.runner)} "$CURRENT_LINK" ${shellQuote(paths.leasesDir)} "$@"
`;
}

function capturePath(file) {
	try {
		const stat = fs.lstatSync(file);
		if (stat.isSymbolicLink()) return { kind: "symlink", target: fs.readlinkSync(file) };
		if (stat.isFile()) return { kind: "file", data: fs.readFileSync(file), mode: stat.mode };
		throw new Error(`${file} exists but is not a file or symlink`);
	} catch (error) {
		if (error?.code === "ENOENT") return { kind: "missing" };
		throw error;
	}
}

function launcherUsesGuardedRunner(snapshot) {
	return snapshot.kind === "file" && snapshot.data.includes(Buffer.from(GUARDED_LAUNCHER_MARKER));
}

function migrationMarkerPath(releaseDir) {
	return path.join(releaseDir, UNGUARDED_MIGRATION_MARKER);
}

function markUnguardedMigrationRelease(releaseDir) {
	const file = migrationMarkerPath(releaseDir);
	try {
		fs.writeFileSync(
			file,
			`${JSON.stringify({ protectedAt: new Date().toISOString(), reason: "pre-guard launcher could resolve this release" })}\n`,
			{ flag: "wx", mode: 0o444 },
		);
		return true;
	} catch (error) {
		if (error?.code === "EEXIST") return false;
		throw error;
	}
}

function releaseHasUnguardedMigrationMarker(releaseDir) {
	try {
		// Any state at the reserved marker path is a fail-safe preserve. A malformed
		// marker must never turn a possibly unleased migration process into GC input.
		fs.lstatSync(migrationMarkerPath(releaseDir));
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		return true;
	}
}

function atomicReplaceFile(file, data, mode = 0o755) {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
	try {
		const stat = fs.lstatSync(file);
		if (stat.isFile() && !stat.isSymbolicLink() && Buffer.compare(fs.readFileSync(file), Buffer.from(data)) === 0 &&
			(process.platform === "win32" || (stat.mode & 0o777) === mode)) return;
	} catch (error) { if (error?.code !== "ENOENT") throw error; }
	const temporary = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
	try {
		const descriptor = fs.openSync(temporary, "wx", mode);
		try { fs.writeFileSync(descriptor, data); fs.fchmodSync(descriptor, mode); fs.fsyncSync(descriptor); }
		finally { fs.closeSync(descriptor); }
		fs.renameSync(temporary, file);
		syncDirectorySync(path.dirname(file));
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

function syncDirectorySync(directory) {
	if (process.platform === "win32") return;
	const descriptor = fs.openSync(directory, "r");
	try { fs.fsyncSync(descriptor); }
	finally { fs.closeSync(descriptor); }
}

function syncTreeSync(root) {
	if (process.platform === "win32") return;
	const visit = (directory) => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const file = path.join(directory, entry.name);
			if (entry.isDirectory()) visit(file);
			else if (entry.isFile()) {
				const descriptor = fs.openSync(file, "r");
				try { fs.fsyncSync(descriptor); }
				finally { fs.closeSync(descriptor); }
			}
		}
		syncDirectorySync(directory);
	};
	visit(root);
}

function restorePath(file, snapshot, platform = process.platform) {
	fs.rmSync(file, { force: true });
	if (snapshot.kind === "missing") return;
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
	if (snapshot.kind === "symlink") {
		const target = platform === "win32"
			? path.resolve(path.dirname(file), snapshot.target)
			: snapshot.target;
		fs.symlinkSync(target, file, platform === "win32" ? "junction" : undefined);
	}
	else fs.writeFileSync(file, snapshot.data, { mode: snapshot.mode });
}

function readReleaseLink(file, releasesDir, options = {}) {
	let target;
	try {
		target = fs.readlinkSync(file);
	} catch (error) {
		if (error?.code === "ENOENT" && options.optional) return undefined;
		throw new Error(`${file} is not a valid channel link`);
	}
	const logicalReleasesDir = path.resolve(releasesDir);
	const resolved = path.resolve(path.dirname(file), target);
	const relative = path.relative(logicalReleasesDir, resolved);
	if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
		throw new Error(`${file} points outside the channel's releases directory`);
	}
	const releaseName = path.basename(resolved);
	if (!fs.statSync(resolved).isDirectory()) throw new Error(`${file} does not point to a release directory`);
	const physicalReleasesDir = fs.realpathSync(releasesDir);
	const physicalResolved = fs.realpathSync(resolved);
	const physicalRelative = path.relative(physicalReleasesDir, physicalResolved);
	if (!physicalRelative || physicalRelative.startsWith(`..${path.sep}`) || physicalRelative === ".." || path.isAbsolute(physicalRelative)) {
		throw new Error(`${file} resolves outside the channel's releases directory`);
	}
	if (path.dirname(resolved) !== logicalReleasesDir || !MANAGED_RELEASE_NAME.test(releaseName)) {
		throw new Error(`${file} does not point to a canonical channel release`);
	}
	if (path.dirname(physicalResolved) !== physicalReleasesDir || path.basename(physicalResolved) !== releaseName) {
		throw new Error(`${file} does not resolve to its canonical channel release`);
	}
	return { target, resolved: physicalResolved };
}

function managedReleaseMetadata(channel, releaseDir, releaseName) {
	try {
		const metadata = JSON.parse(fs.readFileSync(path.join(releaseDir, ".cc-channel.json"), "utf8"));
		return metadata?.channel === channel && metadata?.commit === releaseName ? metadata : undefined;
	} catch {
		return undefined;
	}
}

function sleepSync(milliseconds) {
	if (milliseconds <= 0) return;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function reapDeadChannelRuntimeLock(paths, options = {}) {
	// Production callers hold this channel's exclusive .install-lock. Launchers do
	// not call this function, so only serialized maintenance can reclaim a claim.
	let stat;
	try {
		stat = fs.lstatSync(paths.runtimeLockDir);
	} catch {
		return false;
	}
	if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
	let owner;
	try {
		owner = JSON.parse(fs.readFileSync(path.join(paths.runtimeLockDir, "owner.json"), "utf8"));
	} catch {
		// Never reap an ownerless or corrupt claim: its creator can be paused between
		// the atomic mkdir and owner publication, so absence is not proof of death.
		return false;
	}
	const pid = Number(owner?.pid);
	const token = owner?.token;
	const recordedIdentity = owner?.processIdentity;
	if (!Number.isInteger(pid) || pid <= 0 || typeof token !== "string" || !token ||
		owner?.processIdentityVersion !== 2 || typeof recordedIdentity !== "string" || !recordedIdentity) return false;
	if ((options.processIsAlive ?? localProcessIsAlive)(pid)) {
		const currentIdentity = (options.processIdentity ?? installerProcessIdentity)(pid);
		if (!currentIdentity || currentIdentity === recordedIdentity) return false;
	}
	const retired = `${paths.runtimeLockDir}.stale-${process.pid}-${Date.now()}`;
	try {
		fs.renameSync(paths.runtimeLockDir, retired);
		const retiredOwner = JSON.parse(fs.readFileSync(path.join(retired, "owner.json"), "utf8"));
		if (retiredOwner?.token !== token) {
			// This should be unreachable because no valid owner rewrites its claim. Keep
			// unexpected state rather than deleting a lock whose ownership changed.
			return false;
		}
		fs.rmSync(retired, { recursive: true, force: true });
		return true;
	} catch {
		return !fs.existsSync(paths.runtimeLockDir);
	}
}

function acquireChannelRuntimeLock(paths, options = {}) {
	fs.mkdirSync(paths.channelDir, { recursive: true, mode: 0o755 });
	const deadline = Date.now() + (options.waitMs ?? RUNTIME_LOCK_WAIT_MS);
	const processIdentity = (options.processIdentity ?? installerProcessIdentity)(process.pid);
	if (!processIdentity) throw new Error("cannot establish a unique channel-maintenance process identity on this platform");
	for (;;) {
		const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		try {
			fs.mkdirSync(paths.runtimeLockDir, { mode: 0o700 });
			try {
				fs.writeFileSync(
					path.join(paths.runtimeLockDir, "owner.json"),
					`${JSON.stringify({ pid: process.pid, token, processIdentityVersion: 2, processIdentity, startedAt: new Date().toISOString() })}\n`,
					{ flag: "wx", mode: 0o600 },
				);
			} catch (error) {
				fs.rmSync(paths.runtimeLockDir, { recursive: true, force: true });
				throw error;
			}
			let released = false;
			return () => {
				if (released) return;
				const owner = JSON.parse(fs.readFileSync(path.join(paths.runtimeLockDir, "owner.json"), "utf8"));
				if (owner?.token !== token) throw new Error("channel maintenance guard ownership changed");
				fs.rmSync(paths.runtimeLockDir, { recursive: true, force: true });
				released = true;
			};
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			if (reapDeadChannelRuntimeLock(paths, options)) continue;
			if (Date.now() >= deadline) {
				throw new Error(`timed out waiting for channel startup to finish; inspect ${paths.runtimeLockDir} if no cc process is starting`);
			}
			sleepSync(options.retryMs ?? 25);
		}
	}
}

function localProcessIsAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error?.code === "ESRCH") return false;
		// EPERM proves that a process owns the PID even when this user cannot signal
		// it. Unknown process-table failures are also fail-safe: preserve the release.
		return true;
	}
}

function releaseLeaseIsActive(file, options = {}) {
	let stat;
	try {
		stat = fs.lstatSync(file);
	} catch (error) {
		return error?.code !== "ENOENT";
	}
	if (stat.isSymbolicLink() || !stat.isFile()) return true;
	try {
		const lease = JSON.parse(fs.readFileSync(file, "utf8"));
		const pid = Number(lease?.pid);
		if ((options.processIsAlive ?? localProcessIsAlive)(pid)) {
			if (lease?.processIdentityVersion !== 2 || typeof lease?.processIdentity !== "string" || !lease.processIdentity) return true;
			const currentIdentity = (options.processIdentity ?? installerProcessIdentity)(pid);
			if (!currentIdentity || currentIdentity === lease.processIdentity) return true;
		}
	} catch {
		const age = (options.now ?? Date.now()) - stat.mtimeMs;
		if (age < (options.launchGraceMs ?? LAUNCH_LEASE_GRACE_MS)) return true;
	}
	try {
		fs.rmSync(file, { force: true });
		return false;
	} catch {
		return true;
	}
}

function releaseIsInUse(paths, releaseName, options = {}) {
	const directory = path.join(paths.leasesDir, releaseName);
	let stat;
	try {
		stat = fs.lstatSync(directory);
	} catch (error) {
		return error?.code !== "ENOENT";
	}
	if (stat.isSymbolicLink() || !stat.isDirectory()) return true;
	let entries;
	try {
		entries = fs.readdirSync(directory);
	} catch {
		return true;
	}
	let active = false;
	for (const entry of entries) {
		if (releaseLeaseIsActive(path.join(directory, entry), options)) active = true;
	}
	if (!active) {
		try { fs.rmdirSync(directory); } catch {}
	}
	return active;
}

/**
 * Delete only installer-owned, inactive releases outside the one-step rollback
 * set. Staging directories, symlinks, and directories without matching channel
 * metadata are unknown state and are never traversed or removed.
 */
export function pruneChannelReleases(channel, paths, options = {}) {
	const result = {
		removed: [],
		retried: [],
		inUse: [],
		legacy: [],
		unknown: [],
		errors: [],
		startupBlocked: false,
	};
	let releaseRuntimeLock;
	try {
		releaseRuntimeLock = acquireChannelRuntimeLock(paths, options.runtimeLockOptions);
	} catch (error) {
		result.errors.push(error);
		// Launchers acquire this same guard before resolving `current`. Failure to
		// acquire it is not merely an old-snapshot cleanup problem.
		result.startupBlocked = true;
		return result;
	}
	let runtimeLockReleased = false;
	const releaseLock = () => {
		if (runtimeLockReleased) return;
		try {
			releaseRuntimeLock();
		} catch (error) {
			result.errors.push(error);
			result.startupBlocked = true;
		}
		runtimeLockReleased = true;
	};
	const protectedReleases = new Set();
	try {
		const current = readReleaseLink(paths.currentLink, paths.releasesDir);
		protectedReleases.add(current.resolved);
		const previous = readReleaseLink(paths.previousLink, paths.releasesDir, { optional: true });
		if (previous) protectedReleases.add(previous.resolved);
	} catch (error) {
		// Cleanup must fail closed. Ignoring a transient pointer read would let the
		// collector mistake current/previous for inactive releases and delete them.
		result.errors.push(error);
		releaseLock();
		return result;
	}
	let entries;
	try {
		entries = fs.readdirSync(paths.releasesDir, { withFileTypes: true });
	} catch (error) {
		if (error?.code !== "ENOENT") result.errors.push(error);
		releaseLock();
		return result;
	}
	const tombstones = [];
	try {
		for (const entry of entries) {
			const tombstoneMatch = entry.name.match(MANAGED_TOMBSTONE_NAME);
			if (tombstoneMatch) {
				const retiredRelease = tombstoneMatch[1];
				const retiredPath = path.join(paths.releasesDir, entry.name);
				if (entry.isDirectory() && managedReleaseMetadata(channel, retiredPath, retiredRelease)) {
					tombstones.push({ name: retiredRelease, path: retiredPath });
					result.retried.push(retiredRelease);
				} else {
					result.unknown.push(entry.name);
				}
				continue;
			}
			if (!entry.isDirectory() || !MANAGED_RELEASE_NAME.test(entry.name)) continue;
			const releaseDir = path.join(paths.releasesDir, entry.name);
			let physical;
			try {
				physical = fs.realpathSync(releaseDir);
			} catch (error) {
				result.errors.push(error);
				continue;
			}
			if (protectedReleases.has(physical)) continue;
			const metadata = managedReleaseMetadata(channel, releaseDir, entry.name);
			if (!metadata) {
				result.unknown.push(entry.name);
				continue;
			}
			// Releases produced before the guarded runner, plus the first release exposed
			// while replacing an already-open direct launcher, cannot prove every process
			// holds a lease. Preserve that finite migration set forever.
			if (metadata.leaseProtocol !== 1 || releaseHasUnguardedMigrationMarker(releaseDir)) {
				result.legacy.push(entry.name);
				continue;
			}
			if (releaseIsInUse(paths, entry.name, options)) {
				result.inUse.push(entry.name);
				continue;
			}
			try {
				const tombstone = path.join(
					paths.releasesDir,
					`.${entry.name}.gc-${process.pid}-${Date.now()}`,
				);
				// Runner resolution and lease publication use this same guard. Renaming the
				// canonical path while it is held makes the launch-vs-GC decision atomic.
				fs.renameSync(releaseDir, tombstone);
				tombstones.push({ name: entry.name, path: tombstone });
				result.removed.push(entry.name);
			} catch (error) {
				result.errors.push(error);
			}
		}
	} finally {
		releaseLock();
	}
	// The canonical names are already retired. Slow recursive deletion no longer
	// blocks fresh channel launches, which only resolve current under the guard.
	for (const tombstone of tombstones) {
		try {
			fs.rmSync(tombstone.path, { recursive: true, force: true });
		} catch (error) {
			result.errors.push(error);
		}
	}
	return result;
}

export function atomicReplaceLink(file, target, options = {}) {
	const platform = options.platform ?? process.platform;
	const renameSync = options.renameSync ?? fs.renameSync.bind(fs);
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
	const temporary = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
	const displaced = path.join(path.dirname(file), `.${path.basename(file)}.old-${process.pid}-${Date.now()}`);
	let displacedExisting = false;
	try {
		const linkTarget = platform === "win32" ? path.resolve(path.dirname(file), target) : target;
		fs.symlinkSync(linkTarget, temporary, platform === "win32" ? "junction" : undefined);
		if (platform === "win32") {
			let existing = false;
			try { fs.lstatSync(file); existing = true; }
			catch (error) { if (error?.code !== "ENOENT") throw error; }
			if (existing) {
				renameSync(file, displaced);
				displacedExisting = true;
			}
		}
		renameSync(temporary, file);
		if (displacedExisting) fs.rmSync(displaced, { force: true, recursive: true });
		displacedExisting = false;
		syncDirectorySync(path.dirname(file));
	} catch (error) {
		if (displacedExisting) {
			try {
				fs.rmSync(file, { force: true, recursive: true });
				renameSync(displaced, file);
				displacedExisting = false;
			} catch (restoreError) {
				error.cause = restoreError;
			}
		}
		throw error;
	} finally {
		fs.rmSync(temporary, { force: true, recursive: true });
		if (!displacedExisting) fs.rmSync(displaced, { force: true, recursive: true });
	}
}

function releaseTarget(paths, releaseDir) {
	return path.relative(path.dirname(paths.currentLink), releaseDir);
}

export function promoteRelease(channel, paths, releaseDir, operations = {}, context = {}) {
	const verify = operations.verifyRelease ?? verifyRelease;
	verify(releaseDir, operations.runCommand ?? run);
	// Treat `current` as trusted input only after confirming that it resolves to
	// a real release below this channel. This check must precede state, link, or
	// launcher mutations. `previous` is optional recovery state, so a corrupt or
	// escaped value is safely treated as absent and replaced/discarded.
	const currentRelease = readReleaseLink(paths.currentLink, paths.releasesDir, { optional: true });
	const priorCurrent = capturePath(paths.currentLink);
	let priorPrevious;
	let discardPriorPrevious = false;
	try {
		readReleaseLink(paths.previousLink, paths.releasesDir, { optional: true });
		priorPrevious = capturePath(paths.previousLink);
	} catch {
		priorPrevious = { kind: "missing" };
		discardPriorPrevious = true;
	}
	const priorLauncher = capturePath(paths.launcher);
	const priorRunner = capturePath(paths.runner);
	if (!["missing", "symlink"].includes(priorCurrent.kind)) throw new Error(`${paths.currentLink} is not a symlink`);
	const alreadyCurrent =
		currentRelease && currentRelease.resolved === fs.realpathSync(releaseDir);
	prepareChannelRuntime(paths);
	prepareChannelState(channel, paths);
	if (discardPriorPrevious) fs.rmSync(paths.previousLink, { force: true, recursive: true });
	// A launcher that was already open before replacement can resolve `current`
	// after the new link is published. The guard cannot coordinate code that
	// predates its protocol, so permanently preserve the first release exposed
	// across that migration boundary. Subsequent guarded launchers all lease.
	const protectsUnguardedMigration = !launcherUsesGuardedRunner(priorLauncher) && (
		Boolean(currentRelease) || priorLauncher.kind !== "missing"
	);
	const migrationMarkerCreated = protectsUnguardedMigration
		? markUnguardedMigrationRelease(releaseDir)
		: false;
	if (alreadyCurrent) {
		try {
			atomicReplaceFile(paths.runner, renderChannelRunner());
			atomicReplaceFile(paths.launcher, renderLauncher(channel, paths));
			if (priorPrevious.kind === "missing") fs.rmSync(paths.previousLink, { force: true });
		} catch (error) {
			restorePath(paths.launcher, priorLauncher);
			restorePath(paths.runner, priorRunner);
			throw error;
		}
		return;
	}
	// Persist the complete desired pointer state before either link changes. The
	// same idempotent transaction is replayed after process death or power loss.
	// This record also precedes first launcher publication, so a crash can never
	// leave an unreclaimable installer lock beside a public command with no target.
	atomicReplaceFile(path.join(paths.channelDir, ROLLBACK_TRANSACTION_FILE), `${JSON.stringify({
		version: 1,
		desiredCurrent: releaseTarget(paths, releaseDir),
		desiredPrevious: priorCurrent.kind === "symlink" ? priorCurrent.target : null,
	}, null, 2)}\n`, 0o600);
	try {
		atomicReplaceFile(paths.runner, renderChannelRunner());
		atomicReplaceFile(paths.launcher, renderLauncher(channel, paths));
	} catch (error) {
		restorePath(paths.launcher, priorLauncher);
		restorePath(paths.runner, priorRunner);
		throw error;
	}
	completeRollbackTransaction(paths, { ...context, channel }, operations);
}

function validateRollbackTarget(paths, target, context = {}, operations = {}) {
	if (typeof target !== "string") throw new Error("rollback transaction contains an invalid release target");
	const resolved = path.resolve(path.dirname(paths.currentLink), target);
	if (path.dirname(resolved) !== path.resolve(paths.releasesDir) || !MANAGED_RELEASE_NAME.test(path.basename(resolved))) {
		throw new Error("rollback transaction target is outside the channel release directory");
	}
	let physical;
	try { physical = fs.realpathSync(resolved); }
	catch (error) { throw new Error(`rollback transaction release is unavailable: ${path.basename(resolved)}`, { cause: error }); }
	if (path.dirname(physical) !== fs.realpathSync(paths.releasesDir) || path.basename(physical) !== path.basename(resolved)) {
		throw new Error("rollback transaction release does not resolve to its canonical channel directory");
	}
	verifyInstalledReleaseContent(physical, path.basename(physical), context, operations);
	return { target, resolved: physical };
}

function completeRollbackTransaction(paths, context = {}, operations = {}) {
	const file = path.join(paths.channelDir, ROLLBACK_TRANSACTION_FILE);
	if (!fs.existsSync(file)) return false;
	let transaction;
	try { transaction = JSON.parse(fs.readFileSync(file, "utf8")); }
	catch (error) { throw new Error("channel rollback transaction is invalid and requires manual inspection", { cause: error }); }
	if (transaction?.version !== 1) throw new Error("channel rollback transaction has an unsupported version");
	const desiredCurrent = validateRollbackTarget(paths, transaction.desiredCurrent, context, operations);
	const desiredPrevious = transaction.desiredPrevious === null
		? undefined
		: validateRollbackTarget(paths, transaction.desiredPrevious, context, operations);
	const releaseRuntimeLock = acquireChannelRuntimeLock(paths);
	try {
		atomicReplaceLink(paths.currentLink, desiredCurrent.target);
		if (desiredPrevious) atomicReplaceLink(paths.previousLink, desiredPrevious.target);
		else { fs.rmSync(paths.previousLink, { force: true, recursive: true }); syncDirectorySync(path.dirname(paths.previousLink)); }
		readReleaseLink(paths.currentLink, paths.releasesDir);
		if (desiredPrevious) readReleaseLink(paths.previousLink, paths.releasesDir);
		fs.rmSync(file, { force: true });
		syncDirectorySync(paths.channelDir);
	} finally { releaseRuntimeLock(); }
	return true;
}

export function rollbackChannel(channel, paths, operations = {}, context = {}) {
	const current = readReleaseLink(paths.currentLink, paths.releasesDir);
	const previous = readReleaseLink(paths.previousLink, paths.releasesDir);
	verifyInstalledReleaseContent(previous.resolved, path.basename(previous.resolved), { ...context, channel }, operations);
	verifyInstalledReleaseContent(current.resolved, path.basename(current.resolved), { ...context, channel }, operations);
	(operations.verifyRelease ?? verifyRelease)(previous.resolved, operations.runCommand ?? run);
	atomicReplaceFile(path.join(paths.channelDir, ROLLBACK_TRANSACTION_FILE), `${JSON.stringify({
		version: 1,
		desiredCurrent: previous.target,
		desiredPrevious: current.target,
	}, null, 2)}\n`, 0o600);
	completeRollbackTransaction(paths, { ...context, channel }, operations);
	return { channel, current: path.basename(previous.resolved), previous: path.basename(current.resolved) };
}

function installerProcessIdentity(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	if (process.platform === "linux") {
		try {
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
			const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
			const close = stat.lastIndexOf(")");
			const fields = close >= 0 ? stat.slice(close + 2).trim().split(/\s+/u) : [];
			if (fields[19] && bootId) return `linux:${bootId}:${fields[19]}`;
		} catch {}
	}
	if (process.platform === "win32") {
		return undefined;
	}
	if (process.platform === "darwin") {
		const tokenResult = spawnSync("/bin/ps", ["eww", "-p", String(pid), "-o", "command="], {
			encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: false, timeout: 5000,
		});
		const fields = tokenResult.status === 0 ? tokenResult.stdout.split(/\s+/u) : [];
		const token = fields.find((field) => /^CC_CHANNEL_PROCESS_TOKEN=[0-9a-f]{32}$/u.test(field))?.split("=")[1];
		const ownerPid = Number(fields.find((field) => /^CC_CHANNEL_PROCESS_PID=\d+$/u.test(field))?.split("=")[1]);
		if (token && ownerPid === pid) return `darwin-token:${pid}:${token}`;
	}
	const ps = fs.existsSync("/bin/ps") ? "/bin/ps" : "/usr/bin/ps";
	const result = spawnSync(ps, ["-o", "lstart=", ...(process.platform === "darwin" ? ["-o", "command="] : []), "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	const started = result.status === 0 ? result.stdout.trim() : "";
	return started ? `ps:${started}` : undefined;
}

function publishInstallerLock(paths) {
	const processIdentity = installerProcessIdentity(process.pid);
	if (!processIdentity) throw new Error("channel installer cannot establish a unique process identity on this platform");
	const lockToken = randomUUID();
	const claim = path.join(paths.channelDir, `.install-lock.claim-${process.pid}-${randomUUID()}`);
	let published = false;
	try {
		fs.mkdirSync(claim, { mode: 0o700 });
		const lockStat = fs.statSync(claim, { bigint: true });
		const lockIdentity = { device: String(lockStat.dev), inode: String(lockStat.ino) };
		const ownerFile = path.join(claim, "owner.json");
		const descriptor = fs.openSync(ownerFile, "wx", 0o600);
		try {
			fs.writeFileSync(descriptor, `${JSON.stringify({
				pid: process.pid, processIdentityVersion: 2, processIdentity, lockToken, lockIdentity,
				startedAt: new Date().toISOString(),
			})}\n`);
			fs.fsyncSync(descriptor);
		} finally { fs.closeSync(descriptor); }
		syncDirectorySync(claim);
		fs.renameSync(claim, paths.lockDir);
		published = true;
		syncDirectorySync(paths.channelDir);
		return { lockToken, lockIdentity };
	} finally {
		if (!published) fs.rmSync(claim, { recursive: true, force: true });
	}
}

// macOS may hide same-user process environments from ps, leaving the process
// start instant plus command title as the portable cross-process identity. Keep
// one random title for this installer lifetime: nested acquisition attempts must
// observe the existing live owner, while another process gets a distinct token.
const INSTALLER_PROCESS_TITLE = `cc-install:${randomUUID().replaceAll("-", "").slice(0, 16)}`;

export function acquireLock(paths) {
	const priorProcessTitle = process.title;
	if (process.platform === "darwin") process.title = INSTALLER_PROCESS_TITLE;
	const restoreProcessTitle = () => { if (process.platform === "darwin") process.title = priorProcessTitle; };
	let ownership;
	let staleTombstone;
	try {
		fs.mkdirSync(paths.channelDir, { recursive: true, mode: 0o755 });
		try { ownership = publishInstallerLock(paths); }
		catch (error) {
			if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
			let owner;
			try { owner = JSON.parse(fs.readFileSync(path.join(paths.lockDir, "owner.json"), "utf8")); } catch {}
			let alive = true;
			if (Number.isInteger(owner?.pid) && owner.pid > 0) {
				try { process.kill(owner.pid, 0); }
				catch (probeError) { alive = probeError?.code !== "ESRCH"; }
			}
			if (alive && owner?.processIdentityVersion === 2 && owner?.processIdentity) {
				const currentIdentity = installerProcessIdentity(owner.pid);
				if (currentIdentity && owner.processIdentity !== currentIdentity) alive = false;
			}
			if (alive) throw new Error(`${paths.channelDir} is already being updated`);
			staleTombstone = path.join(paths.channelDir, `.install-lock.stale-${process.pid}-${randomUUID()}`);
			try { fs.renameSync(paths.lockDir, staleTombstone); }
			catch (renameError) {
				if (["ENOENT", "EEXIST"].includes(renameError?.code)) throw new Error(`${paths.channelDir} lock reclamation raced another installer; retry`);
				throw renameError;
			}
			syncDirectorySync(paths.channelDir);
			try { ownership = publishInstallerLock(paths); }
			catch (publishError) {
				if (!fs.existsSync(paths.lockDir)) {
					try { fs.renameSync(staleTombstone, paths.lockDir); syncDirectorySync(paths.channelDir); staleTombstone = undefined; } catch {}
				}
				throw new Error(`${paths.channelDir} is already being updated`, { cause: publishError });
			}
			fs.rmSync(staleTombstone, { recursive: true, force: true });
			staleTombstone = undefined;
		}
		const { lockToken, lockIdentity } = ownership;
		return () => {
			const releaseTombstone = path.join(paths.channelDir, `.install-lock.released-${process.pid}-${randomUUID()}`);
			try {
				const currentStat = fs.statSync(paths.lockDir, { bigint: true });
				const owner = JSON.parse(fs.readFileSync(path.join(paths.lockDir, "owner.json"), "utf8"));
				if (String(currentStat.dev) !== lockIdentity.device || String(currentStat.ino) !== lockIdentity.inode || owner?.lockToken !== lockToken) {
					throw new Error("channel installer lock ownership changed before release");
				}
				fs.renameSync(paths.lockDir, releaseTombstone);
				syncDirectorySync(paths.channelDir);
				fs.rmSync(releaseTombstone, { recursive: true, force: true });
				syncDirectorySync(paths.channelDir);
			} finally { restoreProcessTitle(); }
		};
	} catch (error) {
		if (staleTombstone) fs.rmSync(staleTombstone, { recursive: true, force: true });
		restoreProcessTitle();
		throw error;
	}
}

export function installChannel(channel, options = {}, operations = {}) {
	const definition = CHANNELS[channel];
	if (!definition) throw new Error(`unknown channel: ${channel}`);
	const paths = channelPaths(channel, options);
	const releaseLock = acquireLock(paths);
	try {
		const repo = path.resolve(options.repo || path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
		completeRollbackTransaction(paths, { repo, channel }, operations);
		if (options.rollback) return rollbackChannel(channel, paths, operations, { repo });
		let candidate;
		let commit;
		let ref;
		if (options.candidateDir) {
			commit = String(options.expectedCommit ?? "").toLowerCase();
			if (!/^[0-9a-f]{40}$/u.test(commit)) {
				throw new Error("protected candidate promotion requires --expected-commit with a full reviewed Git SHA");
			}
			candidate = verifyReleaseCandidate(options.candidateDir, commit, { requireValidated: true });
			(operations.verifyCandidateMatchesCommit ?? verifyCandidateMatchesCommit)(
				candidate, repo, commit, operations.runCommand ?? run,
			);
			if (process.env.CC_RELEASE_COMMIT && process.env.CC_RELEASE_COMMIT !== commit) {
				throw new Error("CC_RELEASE_COMMIT does not match --expected-commit");
			}
			ref = `protected-candidate:${candidate.provenance.sha256}`;
		} else {
			if (process.env.CC_RELEASE_COMMIT) {
				throw new Error("release promotion requires --candidate-dir with protected validation evidence");
			}
			ref = options.ref || definition.defaultRef;
			commit = (operations.resolveCommit ?? resolveCommit)(repo, ref, operations.runCommand ?? run);
		}
		const releaseDir = path.join(paths.releasesDir, commit);
		const materialized = materializeRelease(
			{ repo, ref, commit, releaseDir, releasesDir: paths.releasesDir, channel, candidate },
			operations,
		);
		promoteRelease(channel, paths, releaseDir, operations, { repo });
		const garbageCollection = (operations.pruneChannelReleases ?? pruneChannelReleases)(
			channel,
			paths,
			operations.garbageCollectionOptions,
		);
		return {
			channel,
			command: definition.command,
			ref,
			commit,
			releaseDir,
			launcher: paths.launcher,
			reused: materialized.reused,
			garbageCollection,
		};
	} finally {
		releaseLock();
	}
}

export function printResult(result) {
	if (result.previous) {
		console.log(`${result.channel}: rolled back to ${result.current}`);
		return;
	}
	console.log(`${result.command}: ${result.channel} now follows ${result.ref} at ${result.commit.slice(0, 12)}`);
	console.log(`  release: ${result.releaseDir}`);
	console.log(`  launcher: ${result.launcher}`);
	if (result.garbageCollection?.errors?.length > 0) {
		const details = result.garbageCollection.errors
			.map((error) => `    - ${error?.message ?? error}`)
			.join("\n");
		const issue = result.garbageCollection.startupBlocked
			? "channel maintenance"
			: "old release cleanup";
		console.warn(
			`  warning: ${result.garbageCollection.errors.length} ${issue} ` +
			`error${result.garbageCollection.errors.length === 1 ? "" : "s"}; active channel files were not changed\n${details}`,
		);
		if (result.garbageCollection.startupBlocked) {
			console.warn(
				"  warning: channel launches are blocked until the reported maintenance guard " +
				"is released or inspected and remediated; then rerun the channel installer",
			);
		}
	}
	const selected = executableOnPath(result.command);
	if (selected && path.resolve(selected) !== path.resolve(result.launcher)) {
		console.warn(`  warning: PATH currently selects ${selected}; move ${path.dirname(result.launcher)} before it to use this channel`);
	} else if (!selected) {
		console.warn(`  warning: ${path.dirname(result.launcher)} is not on PATH`);
	}
}

export function executableOnPath(command, env = process.env, platform = process.platform) {
	const directories = String(env.PATH ?? "").split(path.delimiter);
	const extensions = platform === "win32" ? String(env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
	for (const directory of directories) {
		if (!directory) continue;
		for (const extension of extensions) {
			const candidate = path.join(directory, `${command}${extension}`);
			try {
				fs.accessSync(candidate, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
				if (fs.statSync(candidate).isFile()) return candidate;
			} catch {}
		}
	}
	return undefined;
}

function main() {
	let options;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(`cc channel installer: ${error.message}\n\n${usage()}`);
		process.exitCode = 2;
		return;
	}
	if (options.help) {
		console.log(usage());
		return;
	}
	const targets = options.target === "all" ? ["stable", "beta"] : [options.target];
	for (const channel of targets) printResult(installChannel(channel, options));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
	try {
		main();
	} catch (error) {
		console.error(`cc channel installer: ${error?.message ?? error}`);
		process.exitCode = 1;
	}
}
