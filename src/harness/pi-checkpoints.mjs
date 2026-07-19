import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	CHECKPOINT_LIMIT,
	checkpointSummary,
	normalizeCheckpointListResponse,
} from "./checkpoints.mjs";

export function piCheckpointsFromSessionManager(manager, options = {}) {
	const limit = Number.isInteger(options.limit)
		? Math.max(1, Math.min(CHECKPOINT_LIMIT, options.limit))
		: CHECKPOINT_LIMIT;
	const checkpoints = [];
	for (const entry of manager?.getBranch?.() ?? []) {
		if (entry?.type !== "message" || entry.message?.role !== "user") continue;
		const text = piMessageText(entry.message.content);
		checkpoints.push({ id: entry.id, summary: checkpointSummary(text) || "User message" });
	}
	return normalizeCheckpointListResponse({ checkpoints: checkpoints.slice(-limit) });
}

export async function openPiSession(sessionId, options = {}) {
	const Manager = options.SessionManager ?? SessionManager;
	const id = safeSessionId(sessionId);
	let info;
	for (const sessionDir of piSessionDirectories(options)) {
		const sessions = sessionDir === undefined ? await Manager.listAll() : await Manager.listAll(sessionDir);
		info = sessions.find((entry) => entry?.id === id);
		if (info) break;
	}
	if (!info || typeof info.path !== "string" || !info.path) {
		throw new Error("could not locate the active Pi session file");
	}
	const manager = Manager.open(info.path);
	if (manager.getSessionId() !== id) throw new Error("Pi session file identity changed while opening it");
	return { manager, path: info.path };
}

export function piSessionDirectories(options = {}) {
	const env = options.env ?? process.env;
	const cwd = options.cwd ?? process.cwd();
	const home = options.home ?? os.homedir();
	const directories = [];
	const add = (value, base = cwd) => {
		if (typeof value !== "string" || !value.trim()) return;
		const resolved = path.resolve(base, expandHome(value.trim(), home));
		if (!directories.includes(resolved)) directories.push(resolved);
	};
	add(env.PI_CODING_AGENT_SESSION_DIR);
	const agentDir = path.resolve(cwd, expandHome(env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent"), home));
	try {
		// Use Pi's resolver so project settings override global settings exactly as
		// they do for the CLI. Pi leaves a relative sessionDir relative to the
		// process/project cwd, so resolve it against the adapter's effective cwd.
		const Manager = options.SettingsManager ?? SettingsManager;
		add(Manager.create(cwd, agentDir, { projectTrusted: true }).getSessionDir(), cwd);
	} catch {}
	// Search Pi's ordinary store last when no explicit location contains the
	// active session. This also preserves compatibility with older sessions.
	directories.push(undefined);
	return directories;
}

export function createPiCheckpointBranch(manager, checkpointId, options = {}) {
	const io = options.fs ?? fs;
	const sourceSessionId = safeSessionId(manager?.getSessionId?.());
	const id = String(checkpointId ?? "").trim();
	const target = (manager?.getBranch?.() ?? []).find((entry) => entry?.id === id);
	if (!target || target.type !== "message" || target.message?.role !== "user") {
		throw new Error("checkpoint is not a user message on the active Pi branch");
	}
	const sessionFile = manager.createBranchedSession(id);
	const sessionId = safeSessionId(manager.getSessionId());
	if (!sessionFile || typeof sessionFile !== "string") throw new Error("Pi did not create a persistent checkpoint branch");
	if (sessionId === sourceSessionId) throw new Error("Pi reused the source session ID for a checkpoint branch");
	if (!io.existsSync(sessionFile)) persistDeferredPiBranch(manager, sessionFile, io);
	const cwd = manager.getHeader?.()?.cwd ?? manager.getCwd?.();
	if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error("Pi checkpoint branch has an invalid working directory");
	return { sessionId, sessionFile: path.resolve(sessionFile), sourceSessionId, cwd };
}

// pi-acp keeps an ID-to-file index outside Pi's session tree. Its session/load
// fallback only scans the global agent store, so a branch beside a source in a
// project-specific sessionDir must be registered before ACP can load it. Keep
// the branch in the user's configured store and publish the same index entry
// pi-acp would write after a successful load.
export function registerPiAcpSession(branch, options = {}) {
	const io = options.fs ?? fs;
	const sessionId = safeSessionId(branch?.sessionId);
	const sessionFile = path.resolve(String(branch?.sessionFile ?? ""));
	const cwd = path.resolve(String(branch?.cwd ?? ""));
	if (!branch?.sessionFile || !io.existsSync(sessionFile)) throw new Error("Pi checkpoint branch file is missing");
	if (!branch?.cwd || !path.isAbsolute(branch.cwd)) throw new Error("Pi checkpoint branch working directory is invalid");

	const mapPath = piAcpSessionMapPath(options);
	const published = {
		sessionId,
		cwd,
		sessionFile,
		updatedAt: new Date(options.now ?? Date.now()).toISOString(),
	};
	return mutatePiAcpSessionMap(mapPath, options, (database) => {
		const previous = database.sessions[sessionId];
		if (previous && path.resolve(String(previous.sessionFile ?? "")) !== sessionFile) {
			throw new Error("Pi ACP session ID is already registered to a different file");
		}
		database.sessions[sessionId] = published;
		return {
			value: { mapPath, sessionId, sessionFile, previous, published },
			verify: (written) => samePiAcpSessionEntry(written.sessions[sessionId], published),
		};
	});
}

export function unregisterPiAcpSession(registration, options = {}) {
	if (!registration) return false;
	return mutatePiAcpSessionMap(registration.mapPath, options, (database) => {
		const current = database.sessions[registration.sessionId];
		const owned = registration.published
			? samePiAcpSessionEntry(current, registration.published)
			: current && path.resolve(String(current.sessionFile ?? "")) === registration.sessionFile;
		if (!owned) return { changed: false, value: false };
		if (registration.previous) database.sessions[registration.sessionId] = registration.previous;
		else delete database.sessions[registration.sessionId];
		return {
			value: true,
			verify: (written) => registration.previous
				? samePiAcpSessionEntry(written.sessions[registration.sessionId], registration.previous)
				: !Object.hasOwn(written.sessions, registration.sessionId),
		};
	});
}

export function piAcpSessionMapPath(options = {}) {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const configuredHome = platform === "win32"
		? env.USERPROFILE || (env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : undefined)
		: env.HOME;
	const home = path.resolve(String(options.home ?? configuredHome ?? os.homedir()));
	return path.join(home, ".pi", "pi-acp", "session-map.json");
}

export function removeUnusedPiBranch(branch, options = {}) {
	const io = options.fs ?? fs;
	if (!branch || typeof branch.sessionFile !== "string" || !branch.sessionFile) return false;
	io.rmSync(branch.sessionFile, { force: true });
	return true;
}

export function piMessageText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function persistDeferredPiBranch(manager, sessionFile, io) {
	const header = manager.getHeader?.();
	const entries = manager.getEntries?.();
	if (!header || !Array.isArray(entries) || header.id !== manager.getSessionId()) {
		throw new Error("Pi produced an invalid deferred checkpoint branch");
	}
	let descriptor;
	try {
		descriptor = io.openSync(sessionFile, "wx", 0o600);
		for (const entry of [header, ...entries]) io.writeFileSync(descriptor, `${JSON.stringify(entry)}\n`, "utf8");
	} catch (error) {
		if (descriptor !== undefined) {
			try { io.closeSync(descriptor); } catch {}
			descriptor = undefined;
			try { io.rmSync(sessionFile, { force: true }); } catch {}
		}
		throw error;
	} finally {
		if (descriptor !== undefined) io.closeSync(descriptor);
	}
}

function readPiAcpSessionMap(mapPath, io) {
	if (!io.existsSync(mapPath)) return { version: 1, sessions: {} };
	let database;
	try {
		database = JSON.parse(io.readFileSync(mapPath, "utf8"));
	} catch (error) {
		throw new Error(`could not read Pi ACP session map: ${error.message}`, { cause: error });
	}
	if (database?.version !== 1 || !database.sessions || typeof database.sessions !== "object" || Array.isArray(database.sessions)) {
		throw new Error("Pi ACP session map has an unsupported format");
	}
	return database;
}

function mutatePiAcpSessionMap(mapPath, options, mutate) {
	const io = options.fs ?? fs;
	const attempts = Number.isInteger(options.mapMutationAttempts)
		? Math.max(1, Math.min(20, options.mapMutationAttempts))
		: 8;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const before = piAcpSessionMapRevision(mapPath, io);
		const database = readPiAcpSessionMap(mapPath, io);
		const after = piAcpSessionMapRevision(mapPath, io);
		if (before !== after) continue;
		const mutation = mutate(database);
		if (mutation?.changed === false) return mutation.value;
		try {
			writePiAcpSessionMap(mapPath, database, io, {
				expectedRevision: after,
				beforeCommit: () => options._testBeforeMapCommit?.({ attempt, mapPath }),
			});
		} catch (error) {
			if (error?.code === "PI_ACP_SESSION_MAP_CHANGED") continue;
			throw error;
		}
		const written = readPiAcpSessionMap(mapPath, io);
		if (typeof mutation?.verify !== "function" || mutation.verify(written)) return mutation?.value;
	}
	throw new Error("Pi ACP session map kept changing while publishing the checkpoint branch");
}

function writePiAcpSessionMap(mapPath, database, io, options = {}) {
	io.mkdirSync(path.dirname(mapPath), { recursive: true });
	const temporary = `${mapPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
	try {
		io.writeFileSync(temporary, `${JSON.stringify(database, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		options.beforeCommit?.();
		if (options.expectedRevision !== undefined && piAcpSessionMapRevision(mapPath, io) !== options.expectedRevision) {
			const error = new Error("Pi ACP session map changed during update");
			error.code = "PI_ACP_SESSION_MAP_CHANGED";
			throw error;
		}
		io.renameSync(temporary, mapPath);
	} catch (error) {
		try { io.rmSync(temporary, { force: true }); } catch {}
		throw error;
	}
}

function piAcpSessionMapRevision(mapPath, io) {
	try {
		const stat = io.statSync(mapPath);
		return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
	} catch (error) {
		if (error?.code === "ENOENT") return "missing";
		throw error;
	}
}

function samePiAcpSessionEntry(left, right) {
	return Boolean(
		left &&
		right &&
		left.sessionId === right.sessionId &&
		left.cwd === right.cwd &&
		left.sessionFile === right.sessionFile &&
		left.updatedAt === right.updatedAt
	);
}

function safeSessionId(value) {
	const id = String(value ?? "").trim();
	if (!id || id.length > 512 || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(id)) {
		throw new Error("Pi session ID is invalid");
	}
	return id;
}

function expandHome(value, home) {
	if (value === "~") return home;
	if (value.startsWith(`~${path.sep}`) || value.startsWith("~/")) return path.join(home, value.slice(2));
	return value;
}
