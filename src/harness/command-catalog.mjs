import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_ACP_ADAPTERS } from "./bundled-adapters.mjs";

const CACHE_VERSION = 2;
const MAX_CACHE_BYTES = 1024 * 1024;
const MAX_CACHE_ENTRIES = 128;
const MAX_COMMANDS_PER_ENTRY = 1_024;
const MAX_COMMAND_NAME_BYTES = 256;
const MAX_DESCRIPTION_CHARS = 512;
const MAX_ARGUMENT_HINT_CHARS = 256;
const MAX_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const CACHE_LOCK_STALE_MS = 10_000;
const DISCOVERY_ENVIRONMENT_NAMES = [
	"HOME",
	"USERPROFILE",
	"XDG_CONFIG_HOME",
	"CODEX_HOME",
	"CLAUDE_CONFIG_DIR",
	"CURSOR_CONFIG_DIR",
	"PI_CODING_AGENT_DIR",
	"OPENAI_API_KEY",
	"CODEX_API_KEY",
	"ANTHROPIC_API_KEY",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CURSOR_API_KEY",
	"AWS_PROFILE",
	"AWS_ACCESS_KEY_ID",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"OPENAI_BASE_URL",
	"ANTHROPIC_BASE_URL",
];
const SECRET_ENVIRONMENT_NAME = /(?:^|_)(?:access_?key(?:_id)?|api_?key|auth|authorization|cookie|credential(?:s)?|key|oauth|passphrase|passwd|password|pin|secret|token)(?:$|_)/iu;
const SCRIPT_LAUNCHER_NAMES = new Set(["bash", "bun", "dash", "deno", "ksh", "node", "nodejs", "python", "python3", "ruby", "sh", "zsh"]);
const PACKAGE_LAUNCHER_NAMES = new Set(["bunx", "npx", "npm", "pnpm", "yarn"]);
const PACKAGE_ROOT = path.dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));

const hint = (name, description = undefined, argumentHint = undefined) => ({
	name,
	...(description ? { description } : {}),
	...(argumentHint ? { argumentHint } : {}),
});

// These are deliberately non-authoritative startup hints, gated to adapter
// identities/versions cc verifies before use. Claude's entries snapshot the
// pinned release's first-party commands and bundled skills so its large SDK
// scan cannot make autocomplete look empty on a first launch. User/project
// skills, plugins, MCP commands, and workspace commands remain last-seen cache
// entries. A live advertisement always replaces every hint, including with an
// empty or account-restricted list.
const BUILTIN_COMMAND_HINTS = {
	claude: [
		hint("deep-research", "Run cited multi-agent web research"),
		hint("design-sync", "Push a React design system to Claude Design", "[project]"),
		hint("dataviz", "Create accessible, consistent data visualizations"),
		hint("update-config", "Configure Claude Code settings, hooks, and permissions"),
		hint("verify", "Exercise a change end-to-end and observe its behavior"),
		hint("debug", "Enable debug logging and diagnose an issue", "[issue]"),
		hint("code-review", "Review changes for bugs and cleanups", "[effort] [--fix] [--comment] [target]"),
		hint("simplify", "Review and apply code-quality cleanups", "[target]"),
		hint("batch", "Plan and execute a large change across worktree agents", "<instruction>"),
		hint("fewer-permission-prompts", "Create a safe allowlist from common read-only calls"),
		hint("doctor", "Diagnose and repair the Claude Code setup"),
		hint("loop", "Run a prompt or command on a recurring interval", "[interval] [prompt]"),
		hint("claude-api", "Load current Claude API and Agent SDK guidance", "[migrate|managed-agents-onboard]"),
		hint("run", "Launch and drive the project to verify behavior"),
		hint("run-skill-generator", "Create or improve the project's run skill"),
		hint("agents", "Create or manage Claude subagents"),
		hint("color", "Set the prompt-bar color", "[color|default]"),
		hint("compact", "Compact the conversation context"),
		hint("config", "Set a Claude Code setting", "key=value"),
		hint("context", "Show current context usage"),
		hint("effort", "Set model effort", "<low|medium|high|xhigh|max|ultracode|auto>"),
		hint("fast", "Toggle Claude fast mode", "[on|off]"),
		hint("heapdump", "Write a JavaScript heap snapshot"),
		hint("init", "Initialize CLAUDE.md project guidance"),
		hint("mcp", "Inspect or manage MCP servers", "[reconnect|enable|disable [server|all]]"),
		hint("model", "Change the Claude model", "<model>"),
		hint("reload-skills", "Reload skills changed on disk"),
		hint("rename", "Rename the current conversation", "[name]"),
		hint("review", "Review a GitHub pull request", "[pr]"),
		hint("security-review", "Review pending changes for security issues"),
		hint("status", "Show Claude Code status"),
		hint("usage", "Show cost, plan usage, and attribution"),
		hint("insights", "Analyze Claude Code session history"),
		hint("recap", "Generate a one-line session recap"),
		hint("goal", "Keep working until a condition is met", "[condition|clear]"),
		hint("design", "Manage Claude Design access", "[consent|revoke]"),
		hint("design-consent", "Grant Claude Design access"),
		hint("design-revoke", "Revoke Claude Design access"),
		hint("team-onboarding", "Generate a team onboarding guide from usage"),
	],
	codex: [
		hint("skills", "List available skills"),
		hint("review", "Review uncommitted changes or follow custom instructions", "[instructions]"),
		hint("review-branch", "Review changes relative to a base branch", "<branch>"),
		hint("review-commit", "Review a specific commit", "<commit>"),
		hint("compact", "Summarize the conversation to free context"),
		hint("goal", "Set, pause, resume, clear, or inspect a task goal", "[<objective>|view|edit|clear|pause|resume]"),
	],
};

function declaredMinimumAtLeast(agent, expected) {
	const actual = String(agent._minimumAgentVersion ?? "").split(".").map((part) => Number.parseInt(part, 10));
	const minimum = String(expected).split(".").map((part) => Number.parseInt(part, 10));
	if (actual.length === 0 || actual.some((part) => !Number.isFinite(part))) return false;
	for (let index = 0; index < Math.max(actual.length, minimum.length); index += 1) {
		const left = actual[index] ?? 0;
		const right = minimum[index] ?? 0;
		if (left !== right) return left > right;
	}
	return true;
}

function boundedText(value, maxChars) {
	if (typeof value !== "string") return undefined;
	const withoutAnsi = value
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
	const singleLine = withoutAnsi.replace(/[\p{Cc}\p{Cf}\p{Cs}]+/gu, " ").replace(/\s+/gu, " ").trim();
	if (!singleLine) return undefined;
	return [...singleLine].slice(0, maxChars).join("");
}

export function normalizeBackendCommands(commands) {
	if (!Array.isArray(commands)) return [];
	const normalized = [];
	const seen = new Set();
	for (const entry of commands) {
		const rawName = typeof entry === "string" ? entry : entry?.name;
		if (typeof rawName !== "string") continue;
		const name = rawName.trim().replace(/^\/+/, "");
		if (
			!name ||
			Buffer.byteLength(name, "utf8") > MAX_COMMAND_NAME_BYTES ||
			/[\/\s\p{Cc}\p{Cf}\p{Cs}\p{Z}]/u.test(name) ||
			seen.has(name)
		) continue;
		seen.add(name);
		const description = boundedText(entry?.description, MAX_DESCRIPTION_CHARS);
		const argumentHint = boundedText(entry?.argumentHint ?? entry?.input?.hint, MAX_ARGUMENT_HINT_CHARS);
		normalized.push(hint(name, description, argumentHint));
		if (normalized.length >= MAX_COMMANDS_PER_ENTRY) break;
	}
	return normalized;
}

function commandKind(agent = {}) {
	if (agent._commandHintProfile === "claude") return "claude";
	if (agent._commandHintProfile === "codex") return "codex";
	if (
		agent._requiredAgentName === BUNDLED_ACP_ADAPTERS.claude.packageName &&
		declaredMinimumAtLeast(agent, BUNDLED_ACP_ADAPTERS.claude.minimumVersion)
	) return "claude";
	if (
		agent._requiredAgentName === BUNDLED_ACP_ADAPTERS.codex.packageName &&
		declaredMinimumAtLeast(agent, BUNDLED_ACP_ADAPTERS.codex.minimumVersion)
	) return "codex";
	return undefined;
}

export function startupCommandHints(key, agent = {}) {
	if (Object.prototype.hasOwnProperty.call(agent, "commandHints")) {
		return normalizeBackendCommands(agent.commandHints);
	}
	return normalizeBackendCommands(BUILTIN_COMMAND_HINTS[commandKind(agent)] ?? []);
}

export function backendCommandCachePath(env = process.env, platform = process.platform, home = os.homedir()) {
	if (env.CC_DISABLE_COMMAND_CACHE === "1") return undefined;
	if (env.CC_COMMAND_CACHE) return path.resolve(env.CC_COMMAND_CACHE);
	if (platform === "darwin") return path.join(home, "Library", "Caches", "cc", "commands.json");
	if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "cc", "Cache", "commands.json");
	return path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "cc", "commands.json");
}

function hashValue(value) {
	return createHash("sha256").update(String(value)).digest("hex");
}

function cacheOwner(key) {
	return hashValue(`harness\0${key}`);
}

function canonicalPath(value, cwd = process.cwd()) {
	const resolved = path.resolve(cwd, String(value));
	try {
		return fs.realpathSync.native?.(resolved) ?? fs.realpathSync(resolved);
	} catch {
		return resolved;
	}
}

function canonicalEnvironmentName(name) {
	return process.platform === "win32" ? String(name).toUpperCase() : String(name);
}

function environmentValue(environment, name) {
	if (!environment || typeof environment !== "object") return undefined;
	if (Object.prototype.hasOwnProperty.call(environment, name)) return environment[name];
	if (process.platform !== "win32") return undefined;
	const canonical = canonicalEnvironmentName(name);
	const match = Object.keys(environment).find((candidate) => canonicalEnvironmentName(candidate) === canonical);
	return match === undefined ? undefined : environment[match];
}

function configuredLaunchEnvironment(agent) {
	const launch = agent?.acp ?? agent ?? {};
	const configured = {};
	for (const source of [agent?.env, launch?.env, agent?._sessionAuthEnv]) {
		for (const [name, value] of Object.entries(source ?? {})) configured[canonicalEnvironmentName(name)] = value;
	}
	const sessionNames = new Set(Object.keys(agent?._sessionAuthEnv ?? {}).map(canonicalEnvironmentName));
	for (const name of agent?._signedOutAuthEnvNames ?? []) {
		const canonical = canonicalEnvironmentName(name);
		if (!sessionNames.has(canonical)) configured[canonical] = undefined;
	}
	return configured;
}

function effectiveDiscoveryEnvironment(agent, environment, configured = configuredLaunchEnvironment(agent)) {
	return Object.fromEntries(DISCOVERY_ENVIRONMENT_NAMES.map((name) => [
		name,
		Object.prototype.hasOwnProperty.call(configured, canonicalEnvironmentName(name))
			? configured[canonicalEnvironmentName(name)]
			: environmentValue(environment, name),
	]));
}

function environmentFingerprint(name, value, sessionNames = new Set()) {
	if (value === undefined) return { present: false };
	if (sessionNames.has(name) || SECRET_ENVIRONMENT_NAME.test(name)) return { present: true, sensitive: true };
	return { present: true, value: String(value) };
}

function executableFileIdentity(candidate) {
	try {
		fs.accessSync(candidate, fs.constants.X_OK);
		const realpath = fs.realpathSync.native?.(candidate) ?? fs.realpathSync(candidate);
		const stat = fs.statSync(realpath);
		if (!stat.isFile()) return undefined;
		return { realpath, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
	} catch {
		return undefined;
	}
}

function resolveExecutableIdentity(command, cwd, environment) {
	if (typeof command !== "string" || !command) return undefined;
	const hasSeparator = command.includes("/") || command.includes("\\");
	const candidates = [];
	if (path.isAbsolute(command)) candidates.push(command);
	else if (hasSeparator) candidates.push(path.resolve(cwd, command));
	else {
		const extensions = process.platform === "win32"
			? [...new Set([...String(environmentValue(environment, "PATHEXT") ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean), ""])]
			: [""];
		for (const directory of String(environmentValue(environment, "PATH") ?? "").split(path.delimiter).filter(Boolean)) {
			for (const extension of extensions) candidates.push(path.join(directory, `${command}${extension}`));
		}
	}
	for (const candidate of candidates) {
		const identity = executableFileIdentity(candidate);
		if (identity) return identity;
	}
	return undefined;
}

function dataFileIdentity(candidate) {
	try {
		const realpath = fs.realpathSync.native?.(candidate) ?? fs.realpathSync(candidate);
		const stat = fs.statSync(realpath);
		if (!stat.isFile()) return undefined;
		return { realpath, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
	} catch {
		return undefined;
	}
}

function launcherName(command) {
	return path.basename(String(command ?? "")).replace(/\.(?:cmd|exe)$/iu, "").toLowerCase();
}

function packageNameFromSpecifier(value) {
	if (typeof value !== "string" || !value || value.startsWith("-")) return undefined;
	if (value.startsWith("@")) return value.match(/^(@[^/]+\/[^@/]+)(?:@.+)?$/u)?.[1];
	return value.replace(/@[^@/]+$/u, "");
}

function resolveLocalPackageIdentities(specifier, cwd) {
	const packageName = packageNameFromSpecifier(specifier);
	if (!packageName) return [];
	try {
		const require = createRequire(path.join(cwd, "package.json"));
		let packageJson;
		let entrypoint;
		try {
			packageJson = require.resolve(`${packageName}/package.json`);
		} catch {
			entrypoint = require.resolve(packageName);
			let current = path.dirname(entrypoint);
			while (true) {
				const candidate = path.join(current, "package.json");
				try {
					if (JSON.parse(fs.readFileSync(candidate, "utf8"))?.name === packageName) {
						packageJson = candidate;
						break;
					}
				} catch {}
				const parent = path.dirname(current);
				if (parent === current) break;
				current = parent;
			}
		}
		entrypoint ??= require.resolve(packageName);
		return [dataFileIdentity(packageJson), dataFileIdentity(entrypoint)].filter(Boolean);
	} catch {
		return [];
	}
}

function resolveLaunchTargetIdentities(command, args, cwd) {
	const identities = [];
	const seen = new Set();
	const add = (identity) => {
		if (!identity || seen.has(identity.realpath)) return;
		seen.add(identity.realpath);
		identities.push(identity);
	};
	const name = launcherName(command);
	const values = Array.isArray(args) ? args.map(String) : [];
	for (const value of values) {
		const pathLike = path.isAbsolute(value) || value.includes("/") || value.includes("\\") || /\.(?:cjs|js|jsx|mjs|py|rb|sh|ts|tsx)$/iu.test(value);
		if (pathLike) add(dataFileIdentity(canonicalPath(value, cwd)));
	}
	if (SCRIPT_LAUNCHER_NAMES.has(name)) {
		for (const value of values) {
			if (value.startsWith("-")) continue;
			const identity = dataFileIdentity(canonicalPath(value, cwd));
			if (identity) {
				add(identity);
				break;
			}
		}
	}
	if (PACKAGE_LAUNCHER_NAMES.has(name)) {
		for (let index = 0; index < values.length; index += 1) {
			const value = values[index];
			if (["--package", "-p"].includes(value)) {
				for (const identity of resolveLocalPackageIdentities(values[index + 1], cwd)) add(identity);
				index += 1;
				continue;
			}
			if (value === "--" || value.startsWith("-") || ["exec", "dlx", "x"].includes(value)) continue;
			for (const identity of resolveLocalPackageIdentities(value, cwd)) add(identity);
			break;
		}
	}
	return identities;
}

function packageLocalLaunchIdentities(agent, launch) {
	const packageName = agent?._packageLocalAcpPackageName ?? agent?._requiredAgentName;
	const bin = agent?._packageLocalAcpCommand;
	const version = agent?._packageLocalAcpVersion;
	if (typeof packageName !== "string" || !packageName || typeof bin !== "string" || !bin || launch?.command !== bin) return [];
	const packageRoot = path.join(PACKAGE_ROOT, "node_modules", ...packageName.split("/"));
	const packageJson = path.join(packageRoot, "package.json");
	try {
		const metadata = JSON.parse(fs.readFileSync(packageJson, "utf8"));
		if (metadata?.name !== packageName || (version && metadata.version !== version)) {
			return [];
		}
		const relative = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.[bin];
		if (typeof relative !== "string" || !relative) return [];
		return [dataFileIdentity(packageJson), dataFileIdentity(path.resolve(packageRoot, relative))].filter(Boolean);
	} catch {
		return [];
	}
}

function cacheKey(key, agent, cwd, environment) {
	const launch = agent?.acp ?? agent ?? {};
	const configuredEnvironment = configuredLaunchEnvironment(agent);
	const discoveryEnvironment = effectiveDiscoveryEnvironment(agent, environment, configuredEnvironment);
	const sessionNames = new Set(Object.keys(agent?._sessionAuthEnv ?? {}).map(canonicalEnvironmentName));
	const executableEnvironment = { ...environment, ...configuredEnvironment };
	const packageLocalIdentities = packageLocalLaunchIdentities(agent, launch);
	const executable = packageLocalIdentities.at(-1) ?? resolveExecutableIdentity(launch.command, cwd, executableEnvironment);
	const canonicalCwd = canonicalPath(cwd);
	const identity = JSON.stringify({
		key,
		command: String(launch.command ?? ""),
		args: Array.isArray(launch.args) ? launch.args.map(String) : [],
		executable,
		launchTargets: [...packageLocalIdentities, ...resolveLaunchTargetIdentities(launch.command, launch.args, canonicalCwd)],
		...(!executable ? { pathFallback: environmentFingerprint("PATH", environmentValue(executableEnvironment, "PATH"), sessionNames) } : {}),
		discoveryEnvironment: Object.entries(discoveryEnvironment)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([name, value]) => [name, environmentFingerprint(name, value, sessionNames)]),
		configuredEnvironment: Object.entries(configuredEnvironment)
			.filter(([name]) => canonicalEnvironmentName(name) !== canonicalEnvironmentName("PATH") || !executable)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([name, value]) => [name, environmentFingerprint(name, value, sessionNames)]),
		signedOutEnvironmentNames: Array.isArray(agent?._signedOutAuthEnvNames)
			? [...agent._signedOutAuthEnvNames].map(String).sort()
			: [],
		additionalDirectories: Array.isArray(agent?.additionalDirectories)
			? agent.additionalDirectories.map((directory) => canonicalPath(directory, canonicalCwd)).sort()
			: [],
	});
	return createHash("sha256").update(identity).update("\0").update(canonicalCwd).digest("hex");
}

function emptyCache() {
	return { version: CACHE_VERSION, entries: {} };
}

function normalizeCache(data, now = Date.now()) {
	const normalized = emptyCache();
	if (data?.version !== CACHE_VERSION || !data.entries || typeof data.entries !== "object" || Array.isArray(data.entries)) {
		return normalized;
	}
	for (const [key, entry] of Object.entries(data.entries)) {
		if (!/^[a-f0-9]{64}$/u.test(key)) continue;
		if (typeof entry?.owner !== "string" || !/^[a-f0-9]{64}$/u.test(entry.owner)) continue;
		const updatedAt = Date.parse(entry?.updatedAt);
		if (!Number.isFinite(updatedAt) || updatedAt > now + 60_000 || now - updatedAt > MAX_CACHE_AGE_MS) continue;
		normalized.entries[key] = {
			updatedAt: new Date(updatedAt).toISOString(),
			commands: normalizeBackendCommands(entry?.commands),
			...(entry?.truncated === true ? { truncated: true } : {}),
			owner: entry.owner,
			...(entry?.agentInfo && typeof entry.agentInfo === "object"
				? {
					agentInfo: {
						name: boundedText(entry.agentInfo.name, 128),
						version: boundedText(entry.agentInfo.version, 128),
					},
				}
				: {}),
		};
	}
	return normalized;
}

function readCacheUnlocked(file) {
	if (!file) return emptyCache();
	try {
		if (fs.statSync(file).size > MAX_CACHE_BYTES) return emptyCache();
		return normalizeCache(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch {
		return emptyCache();
	}
}

function readCache(file) {
	if (!file) return emptyCache();
	// Writers publish with an atomic rename on the normal path, so the previous
	// complete snapshot remains safe to consume while another process holds the
	// lock. On Windows, the narrow remove+rename gap simply degrades to a cache miss.
	return readCacheUnlocked(file);
}

function pruneCache(cache) {
	let entries = Object.entries(cache.entries)
		.sort((left, right) => Date.parse(right[1].updatedAt) - Date.parse(left[1].updatedAt))
		.slice(0, MAX_CACHE_ENTRIES);
	const size = () => Buffer.byteLength(JSON.stringify({ version: CACHE_VERSION, entries: Object.fromEntries(entries) }));
	while (entries.length > 1 && size() > MAX_CACHE_BYTES) {
		entries.pop();
	}
	if (entries.length === 1) {
		const commands = entries[0][1].commands;
		while (commands.length > 0 && size() > MAX_CACHE_BYTES) {
			entries[0][1].truncated = true;
			commands.splice(-Math.max(1, Math.ceil(commands.length / 10)));
		}
	}
	cache.entries = Object.fromEntries(entries);
}

function acquireCacheLock(file) {
	const directory = path.dirname(file);
	const lock = `${file}.lock`;
	try {
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	} catch {
		return undefined;
	}
	const tryAcquire = () => {
		const token = randomUUID();
		let created = false;
		try {
			fs.mkdirSync(lock);
			created = true;
			fs.writeFileSync(path.join(lock, "owner"), token, { flag: "wx", mode: 0o600 });
			return () => {
				try {
					if (fs.readFileSync(path.join(lock, "owner"), "utf8") === token) {
						fs.rmSync(lock, { recursive: true, force: true });
					}
				} catch {}
			};
		} catch {
			if (created) {
				try { fs.rmSync(lock, { recursive: true, force: true }); } catch {}
			}
			return undefined;
		}
	};
	const acquired = tryAcquire();
	if (acquired) return acquired;
	try {
		if (Date.now() - fs.statSync(lock).mtimeMs <= CACHE_LOCK_STALE_MS) return undefined;
		fs.rmSync(lock, { recursive: true, force: true });
	} catch {
		return undefined;
	}
	return tryAcquire();
}

function writeCache(file, cache, changes = {}) {
	if (!file) return false;
	const directory = path.dirname(file);
	const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
	const release = acquireCacheLock(file);
	if (!release) return false;
	try {
		const current = readCacheUnlocked(file);
		const next = { version: CACHE_VERSION, entries: { ...current.entries } };
		// Removals may carry a cutoff ([scope|owner, invalidatedAt]): entries
		// written after the invalidation — by this or another process — are newer
		// authority and survive a stale (lock-deferred) ride-along removal.
		const newerThan = (entry, cutoff) =>
			cutoff !== undefined && typeof entry?.updatedAt === "string" && entry.updatedAt > cutoff;
		for (const removedEntry of changes.removed ?? []) {
			const [scope, cutoff] = Array.isArray(removedEntry) ? removedEntry : [removedEntry, undefined];
			if (!newerThan(next.entries[scope], cutoff)) delete next.entries[scope];
		}
		const removedOwners = new Map(
			(changes.removedOwners ?? []).map((entry) => (Array.isArray(entry) ? entry : [entry, undefined])),
		);
		if (removedOwners.size > 0) {
			for (const [scope, entry] of Object.entries(next.entries)) {
				if (!removedOwners.has(entry.owner)) continue;
				if (!newerThan(entry, removedOwners.get(entry.owner))) delete next.entries[scope];
			}
		}
		Object.assign(next.entries, changes.updates ?? {});
		pruneCache(next);
		cache.entries = next.entries;
		fs.writeFileSync(temporary, `${JSON.stringify(cache)}\n`, { flag: "wx", mode: 0o600 });
		try {
			fs.renameSync(temporary, file);
		} catch (error) {
			// Windows rename does not replace an existing file. Keep the normal path
			// atomic everywhere else, and use the narrow remove+rename fallback only
			// for a non-directory destination on Windows.
			if (process.platform !== "win32" || !["EEXIST", "EPERM"].includes(error?.code)) throw error;
			try {
				if (fs.lstatSync(file).isDirectory()) throw error;
			} catch (statError) {
				if (statError?.code !== "ENOENT") throw statError;
			}
			fs.rmSync(file, { force: true });
			fs.renameSync(temporary, file);
		}
		return true;
	} catch {
		return false;
	} finally {
		try {
			fs.rmSync(temporary, { force: true });
		} catch {}
		release();
	}
}

export class BackendCommandCatalog {
	#pendingRemovals = new Map(); // scope -> invalidatedAt ISO cutoff
	#pendingRemovedOwners = new Map(); // owner -> invalidatedAt ISO cutoff

	constructor(agents = {}, options = {}) {
		this.agents = agents;
		this.cwd = path.resolve(options.cwd ?? process.cwd());
		this.environment = options.environment ?? process.env;
		this.cachePath = options.cachePath;
		this.cache = readCache(this.cachePath);
	}

	// Failed removals stay pending and ride along on every later write, so a
	// contended lock during invalidation cannot let the next successful write
	// resurrect the removed entries from the stale disk snapshot. Updates are
	// applied after removals, so a scope re-remembered later still wins, and
	// owner removals carry their invalidation time so entries written after it
	// (by any process) are never deleted by a stale ride-along removal.
	#write(changes = {}) {
		const now = new Date().toISOString();
		const removed = new Map(this.#pendingRemovals);
		for (const scope of changes.removed ?? []) {
			if (!removed.has(scope)) removed.set(scope, now);
		}
		const removedOwners = new Map(this.#pendingRemovedOwners);
		for (const owner of changes.removedOwners ?? []) {
			if (!removedOwners.has(owner)) removedOwners.set(owner, now);
		}
		const persisted = writeCache(this.cachePath, this.cache, { ...changes, removed: [...removed], removedOwners: [...removedOwners] });
		if (persisted) {
			this.#pendingRemovals.clear();
			this.#pendingRemovedOwners.clear();
		} else {
			this.#pendingRemovals = removed;
			this.#pendingRemovedOwners = removedOwners;
		}
		return persisted;
	}

	setCwd(cwd) {
		const next = path.resolve(cwd);
		if (next === this.cwd) return false;
		this.cwd = next;
		return true;
	}

	scopeFor(key) {
		return cacheKey(key, this.agents[key] ?? {}, this.cwd, this.environment);
	}

	commandsFor(key) {
		const agent = this.agents[key] ?? {};
		const cached = this.cache.entries[this.scopeFor(key)];
		const commands = [
			...(cached?.commands ?? []),
			...startupCommandHints(key, agent),
		];
		return normalizeBackendCommands(commands);
	}

	remember(key, commands, options = {}) {
		const scope = this.scopeFor(key);
		const entry = {
			updatedAt: new Date().toISOString(),
			commands: normalizeBackendCommands(commands),
			owner: cacheOwner(key),
			...(options.agentInfo
				? {
					agentInfo: {
						name: boundedText(options.agentInfo.name, 128),
						version: boundedText(options.agentInfo.version, 128),
					},
				}
				: {}),
		};
		this.cache.entries[scope] = entry;
		// A scope that is legitimately re-remembered cancels any removal still
		// pending from a lock-contended invalidation: otherwise an unrelated
		// scope's write would carry that stale removal and delete this fresh
		// entry from memory and disk before its deferred persist runs.
		this.#pendingRemovals.delete(scope);
		if (options.persist === false) return true;
		return this.#write({ updates: { [scope]: entry } });
	}

	persist(key) {
		const scope = this.scopeFor(key);
		const entry = this.cache.entries[scope];
		if (!entry) return false;
		return this.#write({ updates: { [scope]: entry } });
	}

	validateIdentity(key, agentInfo) {
		const scope = this.scopeFor(key);
		const cached = this.cache.entries[scope];
		if (!cached?.agentInfo || !agentInfo) return true;
		const expectedName = cached.agentInfo.name;
		const expectedVersion = cached.agentInfo.version;
		const actualName = boundedText(agentInfo.name, 128);
		const actualVersion = boundedText(agentInfo.version, 128);
		if ((!expectedName || expectedName === actualName) && (!expectedVersion || expectedVersion === actualVersion)) return true;
		delete this.cache.entries[scope];
		this.#write({ removed: [scope] });
		return false;
	}

	invalidate(key) {
		const owner = cacheOwner(key);
		const currentScope = this.scopeFor(key);
		const removed = Object.entries(this.cache.entries)
			.filter(([scope, entry]) => scope === currentScope || entry.owner === owner)
			.map(([scope]) => scope);
		for (const scope of removed) delete this.cache.entries[scope];
		const persisted = this.#write({ removed, removedOwners: [owner] });
		return removed.length > 0 || persisted;
	}
}
