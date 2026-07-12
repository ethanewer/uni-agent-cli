#!/usr/bin/env node
// Install cc from immutable git snapshots without touching npm's global prefix.
//
// Layout (overridable with --root / CC_INSTALL_ROOT):
//   ~/.local/share/cc/channels/{stable,beta}/releases/<commit>
//   ~/.local/share/cc/channels/{stable,beta}/current -> releases/<commit>
//   ~/.local/bin/{cc,cc2}
//
// Each release owns its node_modules and ACP adapters. A release is fully built
// and smoke-tested before the channel's `current` link is replaced atomically.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const CHANNELS = Object.freeze({
	stable: Object.freeze({ command: "cc", defaultRef: "main", isolateState: false }),
	beta: Object.freeze({ command: "cc2", defaultRef: "ux-0711", isolateState: true }),
});

export const CHANNEL_ADAPTERS = Object.freeze([
	Object.freeze({ package: "@agentclientprotocol/claude-agent-acp", bin: "claude-agent-acp" }),
	Object.freeze({ package: "@agentclientprotocol/codex-acp", bin: "codex-acp", minimumVersion: "1.1.2" }),
]);

const ADAPTER_FALLBACK_VERSIONS = Object.freeze({
	stable: Object.freeze({
		"@agentclientprotocol/claude-agent-acp": "0.39.0",
		"@agentclientprotocol/codex-acp": "1.1.2",
	}),
	beta: Object.freeze({
		"@agentclientprotocol/claude-agent-acp": "0.58.1",
		"@agentclientprotocol/codex-acp": "1.1.2",
	}),
});

const MANAGED_RELEASE_NAME = /^[0-9a-f]{40,64}$/u;
const MANAGED_TOMBSTONE_NAME = /^\.([0-9a-f]{40,64})\.gc-[0-9]+-[0-9]+$/u;
const GUARDED_LAUNCHER_MARKER = "cc-channel-runner-protocol: 1";
const UNGUARDED_MIGRATION_MARKER = ".cc-unguarded-launch";
const LAUNCH_LEASE_GRACE_MS = 60_000;
const RUNTIME_LOCK_WAIT_MS = 30_000;

function usage() {
	return `Install stable and beta cc channels from immutable git snapshots.

Usage:
  node scripts/install-channel.mjs <stable|beta|all> [options]
  node scripts/install-channel.mjs <stable|beta> --rollback [options]

Options:
  --ref <git-ref>   Override main (stable) or ux-0711 (beta)
  --repo <path>     Source git repository (default: repository containing this script)
  --root <path>     Install root (default: ~/.local/share/cc)
  --bin-dir <path>  Launcher directory (default: ~/.local/bin)
  --rollback        Atomically swap current and previous releases
  -h, --help        Show this help

Environment overrides: CC_INSTALL_ROOT and CC_BIN_DIR.`;
}

export function parseArgs(argv) {
	const options = { target: undefined, ref: undefined, repo: undefined, root: undefined, binDir: undefined, rollback: false };
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (value === "-h" || value === "--help") return { ...options, help: true };
		if (value === "--rollback") {
			options.rollback = true;
			continue;
		}
		if (["--ref", "--repo", "--root", "--bin-dir"].includes(value)) {
			const next = argv[index + 1];
			if (!next || next.startsWith("--")) throw new Error(`${value} requires a value`);
			index += 1;
			if (value === "--ref") options.ref = next;
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
	if (options.target === "all" && options.rollback) throw new Error("--rollback requires one channel");
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

export function resolveCommit(repo, ref, runCommand = run) {
	const result = runCommand("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: repo, encoding: "utf8" });
	const commit = String(result.stdout ?? "").trim().toLowerCase();
	if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error(`git returned an invalid commit for ${ref}`);
	return commit;
}

function archiveRepository(repo, commit, destination, runCommand = run) {
	const archive = runCommand("git", ["archive", "--format=tar", commit], {
		cwd: repo,
		encoding: null,
		stdio: ["ignore", "pipe", "pipe"],
	});
	runCommand("tar", ["-x", "-f", "-", "-C", destination], {
		input: archive.stdout,
		stdio: ["pipe", "inherit", "inherit"],
	});
}

export function installDependencies(releaseDir, runCommand = run, context = {}) {
	const environment = { ...process.env, CC_SKIP_ADAPTER_INSTALL: "1", npm_config_global: "false" };
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
	runCommand(npm.command, [...npm.prefixArgs, "ci", "--global=false", "--omit=dev", "--include=optional", "--no-audit", "--no-fund"], {
		cwd: releaseDir,
		env: environment,
	});
	const manifest = JSON.parse(fs.readFileSync(path.join(releaseDir, "package.json"), "utf8"));
	const declared = { ...manifest.dependencies, ...manifest.optionalDependencies };
	const missing = CHANNEL_ADAPTERS.filter((adapter) => !Object.hasOwn(declared, adapter.package));
	if (missing.length === 0) return;
	const fallback = ADAPTER_FALLBACK_VERSIONS[context.channel];
	if (!fallback) throw new Error(`no adapter fallback versions are defined for ${context.channel}`);
	const dependencies = Object.fromEntries(missing.map((adapter) => [adapter.package, fallback[adapter.package]]));
	const adapterDir = path.join(releaseDir, ".cc-adapters");
	fs.mkdirSync(adapterDir, { mode: 0o755 });
	fs.writeFileSync(
		path.join(adapterDir, "package.json"),
		`${JSON.stringify({ private: true, dependencies }, null, 2)}\n`,
		{ mode: 0o644 },
	);
	runCommand(
		npm.command,
		[
			...npm.prefixArgs,
			"install",
			"--global=false",
			"--omit=dev",
			"--include=optional",
			"--no-audit",
			"--no-fund",
		],
		{ cwd: adapterDir, env: environment },
	);
}

/**
 * npm is a JavaScript entrypoint wrapped by `npm.cmd` on Windows. Node's
 * shell-free spawn cannot execute that wrapper directly, so locate npm-cli.js
 * and run it with the same trusted Node executable that is running cc's
 * installer. POSIX keeps the ordinary `npm` lookup for compatibility with
 * package managers that provide their own launcher.
 */
export function npmInvocation(options = {}) {
	const platform = options.platform ?? process.platform;
	if (platform !== "win32") return { command: "npm", prefixArgs: [] };
	const environment = options.env ?? process.env;
	const execPath = path.resolve(options.execPath ?? process.execPath);
	const pathDelimiter = platform === "win32" ? ";" : path.delimiter;
	const candidates = [];
	const add = (candidate) => {
		if (typeof candidate !== "string" || !candidate.trim()) return;
		const resolved = path.resolve(candidate.trim());
		if (!candidates.includes(resolved)) candidates.push(resolved);
	};
	// Prefer npm shipped beside the selected Node. An inherited npm_execpath can
	// point at the package manager that launched this script under a different
	// Node installation (or, in tests, a different simulated platform).
	add(path.join(path.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js"));
	add(environment.npm_execpath);
	add(environment.NPM_EXECPATH);
	for (const directory of String(environment.PATH ?? environment.Path ?? "").split(pathDelimiter)) {
		if (!directory) continue;
		add(path.join(directory, "node_modules", "npm", "bin", "npm-cli.js"));
	}
	const cli = candidates.find((candidate) => {
		try {
			return path.basename(candidate).toLowerCase() === "npm-cli.js" && fs.statSync(candidate).isFile();
		} catch {
			return false;
		}
	});
	if (!cli) {
		throw new Error("could not locate npm-cli.js; install npm alongside Node or set npm_execpath");
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
	const names = nativePlatformNames(platform, arch, options.libc);
	const roots = [
		path.join(releaseDir, "node_modules"),
		path.join(releaseDir, ".cc-adapters", "node_modules"),
	];
	const claudeSdk = packageDirectoryInRoots(roots, "@anthropic-ai/claude-agent-sdk");
	const codexCli = packageDirectoryInRoots(roots, "@openai/codex");
	if (!claudeSdk) throw new Error("@anthropic-ai/claude-agent-sdk is not installed in this release");
	if (!codexCli) throw new Error("@openai/codex is not installed in this release");
	const claudeManifest = JSON.parse(fs.readFileSync(path.join(claudeSdk.packageDir, "package.json"), "utf8"));
	const codexManifest = JSON.parse(fs.readFileSync(path.join(codexCli.packageDir, "package.json"), "utf8"));
	if (!Object.hasOwn(claudeManifest.optionalDependencies ?? {}, names.claude)) {
		throw new Error(`${claudeManifest.name} does not declare ${names.claude}`);
	}
	if (!Object.hasOwn(codexManifest.optionalDependencies ?? {}, names.codex)) {
		throw new Error(`${codexManifest.name} does not declare ${names.codex}`);
	}
	const claudeNative = packageDirectoryInRoots(roots, names.claude);
	const codexNative = packageDirectoryInRoots(roots, names.codex);
	if (!claudeNative) throw new Error(`${names.claude} native payload is not installed`);
	if (!codexNative) throw new Error(`${names.codex} native payload is not installed`);
	requireOptionalPackageIdentity(claudeManifest, names.claude, claudeNative.packageDir);
	requireOptionalPackageIdentity(codexManifest, names.codex, codexNative.packageDir);
	const claudeBinary = requireNativeFile(
		path.join(claudeNative.packageDir, platform === "win32" ? "claude.exe" : "claude"),
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
	return { claude: { package: names.claude, binary: claudeBinary }, codex: { package: names.codex, binary: codexBinary } };
}

export function verifyRelease(releaseDir, runCommand = run) {
	for (const relative of ["package.json", "package-lock.json", "src/cc.mjs", "src/pi-harness.mjs"]) {
		if (!fs.statSync(path.join(releaseDir, relative)).isFile()) throw new Error(`release is missing ${relative}`);
	}
	const adapters = CHANNEL_ADAPTERS.map((adapter) => inspectAdapter(releaseDir, adapter));
	inspectNativePayloads(releaseDir);
	const env = {
		...process.env,
		PATH: [
			path.join(releaseDir, "node_modules", ".bin"),
			path.join(releaseDir, ".cc-adapters", "node_modules", ".bin"),
			process.env.PATH ?? "",
		].join(path.delimiter),
		CC_SKIP_ADAPTER_INSTALL: "1",
	};
	runCommand(process.execPath, ["--check", path.join(releaseDir, "src", "cc.mjs")], { env });
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

export function materializeRelease(context, operations = {}) {
	const { repo, ref, commit, releaseDir, releasesDir, channel } = context;
	if (fs.existsSync(releaseDir)) {
		const adapters = (operations.verifyRelease ?? verifyRelease)(releaseDir, operations.runCommand ?? run);
		return { releaseDir, adapters, reused: true };
	}
	fs.mkdirSync(releasesDir, { recursive: true, mode: 0o755 });
	const staging = path.join(releasesDir, `.${commit}.staging-${process.pid}-${Date.now()}`);
	fs.mkdirSync(staging, { mode: 0o755 });
	try {
		(operations.archiveRepository ?? archiveRepository)(repo, commit, staging, operations.runCommand ?? run);
		(operations.installDependencies ?? installDependencies)(staging, operations.runCommand ?? run, { channel });
		const adapters = (operations.verifyRelease ?? verifyRelease)(staging, operations.runCommand ?? run);
		writeMetadata(staging, {
			channel,
			commit,
			leaseProtocol: 1,
			ref,
			installedAt: new Date().toISOString(),
			node: process.version,
			adapters,
		});
		fs.renameSync(staging, releaseDir);
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

const guard = path.join(path.dirname(currentLink), ".launch-gc-lock");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const releaseOwnedGuard = (token) => {
	const owner = JSON.parse(fs.readFileSync(path.join(guard, "owner.json"), "utf8"));
	if (owner?.token !== token) throw new Error("channel maintenance guard ownership changed");
	fs.rmSync(guard, { recursive: true, force: true });
};
const acquireGuard = async () => {
	const deadline = Date.now() + ${RUNTIME_LOCK_WAIT_MS};
	for (;;) {
		const token = process.pid + "-" + Date.now() + "-" + Math.random().toString(16).slice(2);
		try {
			fs.mkdirSync(guard, { mode: 0o700 });
			try {
				fs.writeFileSync(
					path.join(guard, "owner.json"),
					JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }) + "\\n",
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
	const leasePath = path.join(leaseDir, "run-" + process.pid + "-" + Math.random().toString(16).slice(2));
	fs.writeFileSync(leasePath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\\n", { flag: "wx", mode: 0o600 });
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
  try { fs.rmSync(lease, { force: true }); } catch {}
  try { fs.rmdirSync(path.dirname(lease)); } catch {}
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
	const temporary = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
	const displaced = path.join(path.dirname(file), `.${path.basename(file)}.old-${process.pid}-${Date.now()}`);
	let displacedExisting = false;
	try {
		fs.writeFileSync(temporary, data, { flag: "wx", mode });
		fs.chmodSync(temporary, mode);
		// POSIX rename replaces a file atomically. Windows rename does not replace an
		// existing destination, so first move the old launcher aside and restore it if
		// installing the fully-written replacement fails.
		if (process.platform === "win32" && fs.existsSync(file)) {
			fs.renameSync(file, displaced);
			displacedExisting = true;
		}
		fs.renameSync(temporary, file);
		if (displacedExisting) fs.rmSync(displaced, { force: true });
		displacedExisting = false;
	} catch (error) {
		if (displacedExisting) {
			try {
				fs.rmSync(file, { force: true });
				fs.renameSync(displaced, file);
				displacedExisting = false;
			} catch (restoreError) {
				error.cause = restoreError;
			}
		}
		throw error;
	} finally {
		fs.rmSync(temporary, { force: true });
		if (!displacedExisting) fs.rmSync(displaced, { force: true });
	}
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
	if (!Number.isInteger(pid) || pid <= 0 || typeof token !== "string" || !token) return false;
	if ((options.processIsAlive ?? localProcessIsAlive)(pid)) return false;
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
	for (;;) {
		const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		try {
			fs.mkdirSync(paths.runtimeLockDir, { mode: 0o700 });
			try {
				fs.writeFileSync(
					path.join(paths.runtimeLockDir, "owner.json"),
					`${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`,
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
		if ((options.processIsAlive ?? localProcessIsAlive)(Number(lease?.pid))) return true;
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
		if (platform === "win32" && fs.existsSync(file)) {
			renameSync(file, displaced);
			displacedExisting = true;
		}
		renameSync(temporary, file);
		if (displacedExisting) fs.rmSync(displaced, { force: true, recursive: true });
		displacedExisting = false;
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

export function promoteRelease(channel, paths, releaseDir, operations = {}) {
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
	let currentPublished = false;
	try {
		// Publish the runtime and marked migration boundary before exposing the new
		// current release. Every launcher created by this installer then resolves and
		// leases under the shared guard.
		atomicReplaceFile(paths.runner, renderChannelRunner());
		atomicReplaceFile(paths.launcher, renderLauncher(channel, paths));
		atomicReplaceLink(paths.currentLink, releaseTarget(paths, releaseDir));
		currentPublished = true;
		if (priorCurrent.kind === "symlink") atomicReplaceLink(paths.previousLink, priorCurrent.target);
		else fs.rmSync(paths.previousLink, { force: true });
	} catch (error) {
		restorePath(paths.currentLink, priorCurrent);
		restorePath(paths.previousLink, priorPrevious);
		restorePath(paths.launcher, priorLauncher);
		restorePath(paths.runner, priorRunner);
		if (migrationMarkerCreated && !currentPublished) {
			fs.rmSync(migrationMarkerPath(releaseDir), { force: true });
		}
		throw error;
	}
}

export function rollbackChannel(channel, paths, operations = {}) {
	const current = readReleaseLink(paths.currentLink, paths.releasesDir);
	const previous = readReleaseLink(paths.previousLink, paths.releasesDir);
	(operations.verifyRelease ?? verifyRelease)(previous.resolved, operations.runCommand ?? run);
	try {
		atomicReplaceLink(paths.currentLink, previous.target);
		atomicReplaceLink(paths.previousLink, current.target);
	} catch (error) {
		atomicReplaceLink(paths.currentLink, current.target);
		throw error;
	}
	return { channel, current: path.basename(previous.resolved), previous: path.basename(current.resolved) };
}

function acquireLock(paths) {
	fs.mkdirSync(paths.channelDir, { recursive: true, mode: 0o755 });
	try {
		fs.mkdirSync(paths.lockDir, { mode: 0o700 });
	} catch (error) {
		if (error?.code === "EEXIST") throw new Error(`${paths.channelDir} is already being updated (remove ${paths.lockDir} if no installer is running)`);
		throw error;
	}
	try {
		fs.writeFileSync(path.join(paths.lockDir, "owner.json"), `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, {
			mode: 0o600,
		});
	} catch (error) {
		fs.rmSync(paths.lockDir, { recursive: true, force: true });
		throw error;
	}
	return () => fs.rmSync(paths.lockDir, { recursive: true, force: true });
}

export function installChannel(channel, options = {}, operations = {}) {
	const definition = CHANNELS[channel];
	if (!definition) throw new Error(`unknown channel: ${channel}`);
	const paths = channelPaths(channel, options);
	const releaseLock = acquireLock(paths);
	try {
		if (options.rollback) return rollbackChannel(channel, paths, operations);
		const repo = path.resolve(options.repo || path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
		const ref = options.ref || definition.defaultRef;
		const commit = (operations.resolveCommit ?? resolveCommit)(repo, ref, operations.runCommand ?? run);
		const releaseDir = path.join(paths.releasesDir, commit);
		const materialized = materializeRelease(
			{ repo, ref, commit, releaseDir, releasesDir: paths.releasesDir, channel },
			operations,
		);
		promoteRelease(channel, paths, releaseDir, operations);
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
