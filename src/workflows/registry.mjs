import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractWorkflowMeta } from "./meta.mjs";
import { acquireOwnershipLock } from "./ownership-lock.mjs";
import { readBoundedHandle, syncDirectory } from "./durability.mjs";
import { ensureWorkflowPrivateDirectory } from "./state-root.mjs";
import { WORKFLOW_LIMITS } from "./types.mjs";
import { trustedExecutableOnPath, userControlledPathRoots } from "./trusted-executable.mjs";

const PROJECT_SAVE_HELPER = fileURLToPath(new URL("./project-save-helper.py", import.meta.url));
const PERSONAL_WORKFLOW_HELPER = fileURLToPath(new URL("./personal-workflow-helper.mjs", import.meta.url));
const RELEASE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
let PROJECT_PYTHON;
if (process.platform !== "win32") {
	try {
		PROJECT_PYTHON = trustedExecutableOnPath("python3", process.env, [
			RELEASE_ROOT,
			...userControlledPathRoots(process.cwd()),
		]);
	} catch { /* Project workflow I/O reports unavailability; personal/inline workflows remain usable. */ }
}
const WORKFLOW_IMPORT_INDEX_BYTES = 4 * 1024 * 1024;

function workflowName(value) {
	const name = String(value ?? "").trim();
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(name)) throw new Error("workflow name may contain only letters, numbers, dot, underscore, and dash");
	if (name.endsWith(".") || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) {
		throw new Error("workflow name is reserved by a supported platform");
	}
	return name;
}

async function readRegularNoFollow(file) {
	const before = await fs.lstat(file);
	if (!before.isFile() || before.isSymbolicLink()) throw new Error("workflow must be a bounded regular file");
	const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > WORKFLOW_LIMITS.maxSourceBytes) throw new Error("workflow must be a bounded regular file");
		return (await readBoundedHandle(handle, WORKFLOW_LIMITS.maxSourceBytes, "workflow must be a bounded regular file")).toString("utf8");
	} finally { await handle.close(); }
}

async function personalWorkflowDirectory(stateRoot, options = {}) {
	const requestedRoot = path.resolve(stateRoot);
	let rootStat;
	try { rootStat = await fs.lstat(requestedRoot); } catch (error) {
		if (error?.code !== "ENOENT" || !options.create) throw error;
		await fs.mkdir(requestedRoot, { recursive: true, mode: 0o700 });
		rootStat = await fs.lstat(requestedRoot);
	}
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
		(typeof process.getuid === "function" && rootStat.uid !== process.getuid()) || (process.platform !== "win32" && (rootStat.mode & 0o022) !== 0)) {
		throw new Error("personal workflow state root must be an owned, non-writable regular directory");
	}
	const canonicalRoot = await fs.realpath(requestedRoot);
	const directory = path.join(canonicalRoot, "workflows");
	let directoryCreated = false;
	if (options.create) {
		try { await fs.mkdir(directory, { mode: 0o700 }); directoryCreated = true; } catch (error) { if (error?.code !== "EEXIST") throw error; }
	}
	const stat = await fs.lstat(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink() ||
		(typeof process.getuid === "function" && stat.uid !== process.getuid()) || (process.platform !== "win32" && (stat.mode & 0o022) !== 0) ||
		await fs.realpath(directory) !== directory) {
		throw new Error("personal workflow directory must be an owned private directory, not a symlink");
	}
	if (options.create && process.platform !== "win32" && (stat.mode & 0o077) !== 0) await fs.chmod(directory, 0o700);
	if (directoryCreated) await syncDirectory(canonicalRoot);
	return directory;
}

function abortError(reason = "Project workflow discovery cancelled") {
	if (reason instanceof Error) return reason;
	const error = new Error(String(reason));
	error.name = "AbortError";
	return error;
}

async function withIoDeadline(promise, options = {}) {
	const deadline = options.deadline ?? Date.now() + 10_000;
	if (Date.now() >= deadline) throw Object.assign(new Error("project workflow discovery timed out"), { code: "WORKFLOW_PROJECT_IO_TIMEOUT" });
	let onAbort;
	let timer;
	const stopped = new Promise((_, reject) => {
		onAbort = () => reject(abortError(options.signal?.reason));
		options.signal?.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(() => reject(Object.assign(new Error("project workflow discovery timed out"), { code: "WORKFLOW_PROJECT_IO_TIMEOUT" })), Math.max(1, deadline - Date.now()));
	});
	try { return await Promise.race([promise, stopped]); }
	finally { clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); }
}

function killProcessTree(child, signal = "SIGTERM") {
	if (!child?.pid) return;
	try {
		if (process.platform === "win32") child.kill(signal);
		else process.kill(-child.pid, signal);
	} catch (error) {
		if (error?.code !== "ESRCH") { try { child.kill(signal); } catch { /* already exited */ } }
	}
}

async function runProjectHelper(operation, projectRoot, name, options = {}) {
	if (options.signal?.aborted) throw abortError(options.signal.reason);
	const deadline = options.deadline ?? Date.now() + 10_000;
	if (Date.now() >= deadline) throw Object.assign(new Error("project workflow discovery timed out"), { code: "WORKFLOW_PROJECT_IO_TIMEOUT" });
	return await new Promise((resolve, reject) => {
		const baseOperation = operation.startsWith("personal-") ? operation.slice("personal-".length) : operation;
		const personal = operation.startsWith("personal-");
		if (!personal && !PROJECT_PYTHON) throw new Error("race-safe project workflow I/O is unavailable on this platform");
		const helperEnvironment = { PATH: PROJECT_PYTHON ? path.dirname(PROJECT_PYTHON) : "", LANG: "C", LC_ALL: "C" };
		const helperExecutable = personal ? process.execPath : PROJECT_PYTHON;
		const maximumOutput = WORKFLOW_LIMITS.maxSourceBytes + (baseOperation === "read-identity" ? 1024 : 0);
		const stdout = [];
		let stdoutBytes = 0;
		const child = spawn(helperExecutable, [
			...(personal ? [] : ["-I", "-S"]),
			personal ? PERSONAL_WORKFLOW_HELPER : PROJECT_SAVE_HELPER,
			baseOperation, path.resolve(projectRoot),
			...(["list", "identity"].includes(baseOperation) ? [] : [name]),
			...(baseOperation === "save" ? [options.overwrite ? "1" : "0"] : []),
		], {
			stdio: [baseOperation === "save" ? "pipe" : "ignore", ["read", "read-identity", "list", "identity"].includes(baseOperation) ? "pipe" : "ignore", "pipe"],
			shell: false, detached: process.platform !== "win32", windowsHide: true,
			...(personal ? {} : { env: helperEnvironment }),
		});
		let stderr = "";
		let terminationError;
		let killTimer;
		let terminationConfirmationTimer;
		let settled = false;
		const finish = (error, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			clearTimeout(killTimer);
			clearTimeout(terminationConfirmationTimer);
			options.signal?.removeEventListener("abort", onAbort);
			if (error) reject(error); else resolve(value);
		};
		const terminate = (error) => {
			if (terminationError || settled) return;
			terminationError = error;
			killProcessTree(child, "SIGTERM");
			killTimer = setTimeout(() => {
				killProcessTree(child, "SIGKILL");
				terminationConfirmationTimer = setTimeout(() => {
					const unconfirmed = Object.assign(new Error("project workflow helper termination could not be confirmed; restart cc", { cause: terminationError }), {
						code: "WORKFLOW_PROJECT_HELPER_TERMINATION_UNCONFIRMED",
					});
					try { options.onTerminationUnconfirmed?.(unconfirmed); } catch { /* the sticky registry fence remains authoritative */ }
					finish(unconfirmed);
				}, 1000);
			}, 1000);
		};
		const onAbort = () => terminate(abortError(options.signal.reason));
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const timeout = setTimeout(() => terminate(Object.assign(new Error("project workflow discovery timed out"), { code: "WORKFLOW_PROJECT_IO_TIMEOUT" })), Math.max(1, deadline - Date.now()));
		child.stdout?.on("data", (chunk) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes <= maximumOutput) stdout.push(chunk);
			else terminate(Object.assign(new Error("project workflow discovery output is too large"), { code: "WORKFLOW_PROJECT_IO_TOO_LARGE" }));
		});
		child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-16 * 1024); });
		child.once("error", (error) => {
			const wrapped = new Error(`race-safe project workflow I/O helper could not start: ${error.message ?? error}`);
			wrapped.code = "WORKFLOW_PROJECT_IO_UNAVAILABLE";
			if (child.pid) terminate(wrapped);
			else finish(wrapped);
		});
		// `close` fires only after the helper's stdout/stderr pipes have closed,
		// so a successful helper cannot return a truncated final chunk.
		child.once("close", (code, signal) => {
			if (terminationError) finish(terminationError);
			else if (code === 0 && stdoutBytes <= maximumOutput) finish(undefined, Buffer.concat(stdout));
			else {
				const detail = stderr.trim() || `exit ${code}`;
				const error = new Error(`race-safe project workflow I/O failed${signal ? ` (${signal})` : ""}: ${detail}`);
				if (/\[Errno 2\]|\bENOENT:/u.test(detail) || (["read", "read-identity", "list"].includes(baseOperation) && /\[Errno 20\]|\bENOTDIR:/u.test(detail))) error.code = "ENOENT";
				else if (/\[Errno 17\]|\bEEXIST:/u.test(detail)) error.code = "EEXIST";
				else if (/unavailable on this platform/u.test(detail)) error.code = "WORKFLOW_PROJECT_IO_UNAVAILABLE";
				finish(error);
			}
		});
		if (baseOperation === "save") {
			child.stdin.on("error", (error) => terminate(error));
			child.stdin.end(options.source);
		}
	});
}

function validateProjectIdentity(identity, label = "race-safe project identity helper") {
	if (!identity || typeof identity.canonicalRoot !== "string" ||
		!/^[0-9]+$/u.test(identity.device) || !/^[0-9]+$/u.test(identity.inode)) {
		throw new Error(`${label} returned an invalid result`);
	}
	return identity;
}

async function projectRootIdentity(projectRoot, options = {}) {
	const output = await runProjectHelper("identity", projectRoot, "", options);
	return validateProjectIdentity(JSON.parse(output.toString("utf8")));
}

async function portableProjectIdentity(projectRoot, options = {}) {
	if (options.signal?.aborted) throw abortError(options.signal.reason);
	const canonicalRoot = await withIoDeadline(fs.realpath(path.resolve(projectRoot)), options);
	if (options.signal?.aborted) throw abortError(options.signal.reason);
	if (process.platform === "win32") {
		const stat = await withIoDeadline(fs.stat(canonicalRoot, { bigint: true }), options);
		if (!stat.isDirectory()) throw new Error("workflow launch root is not a directory");
		return { canonicalRoot, device: String(stat.dev), inode: String(stat.ino) };
	}
	const flags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
	const opening = fs.open(canonicalRoot, flags);
	let handle;
	try { handle = await withIoDeadline(opening, options); }
	catch (error) {
		void opening.then((abandoned) => abandoned.close()).catch(() => {});
		throw error;
	}
	try {
		const stat = await withIoDeadline(handle.stat({ bigint: true }), options);
		if (!stat.isDirectory()) throw new Error("workflow launch root is not a directory");
		if (options.signal?.aborted) throw abortError(options.signal.reason);
		return {
			canonicalRoot,
			device: String(stat.dev),
			inode: String(stat.ino),
		};
	} finally { await handle.close(); }
}

async function saveProjectWorkflow(projectRoot, name, source, overwrite, options = {}) {
	await runProjectHelper("save", projectRoot, name, { ...options, source, overwrite });
}

async function readProjectWorkflow(projectRoot, name, options = {}) {
	const output = await runProjectHelper("read", projectRoot, name, options);
	return output.toString("utf8");
}

async function readProjectWorkflowWithIdentity(projectRoot, name, options = {}) {
	const output = await runProjectHelper("read-identity", projectRoot, name, options);
	const separator = output.indexOf(0x0a);
	if (separator < 1 || separator > 1023) throw new Error("race-safe project workflow read returned an invalid identity envelope");
	const identity = validateProjectIdentity(JSON.parse(output.subarray(0, separator).toString("utf8")), "race-safe project workflow read");
	const sourceBytes = output.subarray(separator + 1);
	if (sourceBytes.length > WORKFLOW_LIMITS.maxSourceBytes) throw new Error("workflow source exceeds the project read bound");
	return { source: sourceBytes.toString("utf8"), projectIdentity: identity };
}

async function listProjectWorkflows(projectRoot, options = {}) {
	const output = await runProjectHelper("list", projectRoot, "", options);
	const names = JSON.parse(output.toString("utf8"));
	if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || !name.endsWith(".js"))) {
		throw new Error("race-safe project workflow discovery returned an invalid result");
	}
	return names;
}

async function savePersonalWorkflow(personalRoot, name, source, overwrite, options = {}) {
	await runProjectHelper("personal-save", personalRoot, name, { ...options, source, overwrite });
}

async function readPersonalWorkflow(personalRoot, name, options = {}) {
	const output = await runProjectHelper("personal-read", personalRoot, name, options);
	return output.toString("utf8");
}

async function listPersonalWorkflows(personalRoot, options = {}) {
	const output = await runProjectHelper("personal-list", personalRoot, "", options);
	const names = JSON.parse(output.toString("utf8"));
	if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || !name.endsWith(".js"))) {
		throw new Error("race-safe personal workflow discovery returned an invalid result");
	}
	return names;
}

export class WorkflowRegistry {
	constructor({ projectRoot, stateRoot, personalRoot }) {
		this.projectRoot = path.resolve(projectRoot);
		this.stateRoot = path.resolve(stateRoot);
		this.personalRoot = path.resolve(personalRoot ?? stateRoot);
		this.projectDirectory = path.join(this.projectRoot, ".cc", "workflows");
		this.personalDirectory = path.join(this.personalRoot, "workflows");
		this.contentDirectory = path.join(this.stateRoot, "workflow-registry");
		this.indexFile = path.join(this.contentDirectory, "index.json");
		this.indexWriteTail = Promise.resolve();
		this.projectHelperTerminationFailure = undefined;
	}

	#fencedOptions(options = {}) {
		if (this.projectHelperTerminationFailure) {
			throw Object.assign(new Error("Workflow registry filesystem ownership is unresolved; restart cc before continuing", { cause: this.projectHelperTerminationFailure }), {
				code: "WORKFLOW_RESTART_REQUIRED",
			});
		}
		return {
			...options,
			onTerminationUnconfirmed: (error) => {
				this.projectHelperTerminationFailure ??= error;
				options.onTerminationUnconfirmed?.(error);
			},
		};
	}

	#project(options = {}) {
		const root = path.resolve(options.projectRoot ?? this.projectRoot);
		return { root, directory: path.join(root, ".cc", "workflows") };
	}

	async #ensureContentDirectory() {
		await ensureWorkflowPrivateDirectory(this.stateRoot);
		await ensureWorkflowPrivateDirectory(this.contentDirectory);
	}

	async #readIndex() {
		try {
			const before = await fs.lstat(this.indexFile);
			if (!before.isFile() || before.isSymbolicLink()) throw new Error("workflow import index is not a regular file");
			const handle = await fs.open(this.indexFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
			let text;
			try {
				const stat = await handle.stat();
				if (!stat.isFile() || stat.size > WORKFLOW_IMPORT_INDEX_BYTES) throw new Error("workflow import index exceeds its read bound");
				text = (await readBoundedHandle(handle, WORKFLOW_IMPORT_INDEX_BYTES, "workflow import index exceeds its read bound")).toString("utf8");
			} finally { await handle.close(); }
			const parsed = JSON.parse(text);
			return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
		} catch (error) {
			if (error?.code === "ENOENT") return {};
			throw error;
		}
	}

	async #writeIndex(value) {
		const operation = this.indexWriteTail.then(async () => {
			await this.#ensureContentDirectory();
			const release = await acquireOwnershipLock(path.join(this.contentDirectory, "index.lock"), { timeoutMs: 30_000 });
			const temporary = `${this.indexFile}.${process.pid}.${randomUUID()}.tmp`;
			try {
				const index = typeof value === "function" ? value(await this.#readIndex()) : value;
				const serialized = `${JSON.stringify(index, null, 2)}\n`;
				if (Buffer.byteLength(serialized, "utf8") > WORKFLOW_IMPORT_INDEX_BYTES) {
					throw Object.assign(new Error("workflow import index exceeds its write bound"), { code: "WORKFLOW_IMPORT_INDEX_LIMIT" });
				}
				const handle = await fs.open(temporary, "wx", 0o600);
				try { await handle.writeFile(serialized); await handle.sync(); }
				finally { await handle.close(); }
				await fs.rename(temporary, this.indexFile);
					await syncDirectory(this.contentDirectory);
			} finally {
				await fs.unlink(temporary).catch(() => {});
				await release();
			}
		});
		this.indexWriteTail = operation.catch(() => {});
		return operation;
	}

	async #importNamespace(projectRoot, options = {}) {
		const identity = await projectRootIdentity(path.resolve(projectRoot), this.#fencedOptions(options));
		const value = `${identity.canonicalRoot}\0${identity.device}\0${identity.inode}`;
		return {
			key: createHash("sha256").update(value).digest("hex"),
			identity,
		};
	}

	async projectIdentity(projectRoot, options = {}) {
		options = this.#fencedOptions(options);
		const identity = await projectRootIdentity(path.resolve(projectRoot), {
			...options,
			deadline: options.deadline ?? Date.now() + 10_000,
		});
		return Object.freeze(identity);
	}

	async approvalProjectIdentity(projectRoot, options = {}) {
		options = this.#fencedOptions(options);
		return Object.freeze(await portableProjectIdentity(path.resolve(projectRoot), options));
	}

	async list(options = {}) {
		options = this.#fencedOptions({ ...options, deadline: options.deadline ?? Date.now() + 10_000 });
		const entries = new Map();
		const comparisonKey = (name) => ["darwin", "win32"].includes(process.platform) ? name.toLocaleLowerCase("en-US") : name;
		const project = this.#project(options);
		for (const [scope, directory] of [["personal", this.personalDirectory], ["project", project.directory]]) {
			let names = [];
			try {
				names = scope === "project" ? await listProjectWorkflows(project.root, options) : await listPersonalWorkflows(this.personalRoot, options);
			} catch (error) {
				if (error?.code === "ENOENT" || (scope === "project" && error?.code === "WORKFLOW_PROJECT_IO_UNAVAILABLE")) continue;
				throw error;
			}
			for (const file of names.filter((item) => item.endsWith(".js")).sort()) {
				const name = file.slice(0, -3);
				try {
					const source = scope === "project"
						? await readProjectWorkflow(project.root, name, options)
						: await readPersonalWorkflow(this.personalRoot, name, options);
					entries.set(comparisonKey(name), { name, scope, meta: extractWorkflowMeta(source) });
				} catch (error) {
					entries.set(comparisonKey(name), { name, scope, error: error.message ?? String(error) });
				}
			}
		}
		return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	async resolve(nameValue, options = {}) {
		options = this.#fencedOptions({ ...options, deadline: options.deadline ?? Date.now() + 10_000 });
		const name = workflowName(nameValue);
		if (options.requireImported === true) {
			if (typeof options.projectRoot !== "string" || !options.projectRoot) {
				throw new Error("projectRoot is required when resolving an imported workflow");
			}
			const namespace = await this.#importNamespace(options.projectRoot, options);
			const index = await this.#readIndex();
			const importedWorkflows = index?.version === 2 ? index.projects?.[namespace.key]?.workflows : undefined;
			const imported = importedWorkflows?.[name] ?? (["darwin", "win32"].includes(process.platform) && importedWorkflows
				? Object.entries(importedWorkflows).find(([candidate]) => candidate.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US"))?.[1]
				: undefined);
			if (!imported?.hash || !/^[a-f0-9]{64}$/u.test(imported.hash)) {
				throw new Error(`workflow ${name} has not been explicitly imported by a user for this project`);
			}
			const source = await readRegularNoFollow(path.join(this.contentDirectory, `${imported.hash}.js`));
			const hash = createHash("sha256").update(source).digest("hex");
			if (hash !== imported.hash) throw new Error(`imported workflow ${name} failed its content hash check`);
			return Object.freeze({ name, scope: imported.scope, source, meta: extractWorkflowMeta(source), hash, contentFile: path.join(this.contentDirectory, `${hash}.js`), projectIdentity: Object.freeze(namespace.identity) });
		}
		let source;
		let scope;
		let projectIdentity;
		const project = this.#project(options);
		for (const [candidateScope, directory] of [["project", project.directory], ["personal", this.personalDirectory]]) {
			try {
				if (candidateScope === "project") {
					const projectRead = await readProjectWorkflowWithIdentity(project.root, name, options);
					source = projectRead.source;
					projectIdentity = Object.freeze(projectRead.projectIdentity);
				} else source = await readPersonalWorkflow(this.personalRoot, name, options);
				scope = candidateScope;
				break;
			} catch (error) {
				if (error?.code !== "ENOENT" && !(candidateScope === "project" && error?.code === "WORKFLOW_PROJECT_IO_UNAVAILABLE")) throw error;
			}
		}
		if (source === undefined) throw new Error(`unknown workflow: ${name}`);
		const meta = extractWorkflowMeta(source);
		const hash = createHash("sha256").update(source).digest("hex");
		const resolved = Object.freeze({ name, scope, source, meta, hash, ...(projectIdentity ? { projectIdentity } : {}) });
		if (options.import === true) await this.importResolved(resolved, project.root, options);
		return options.import === true
			? Object.freeze({ ...resolved, contentFile: path.join(this.contentDirectory, `${hash}.js`) })
			: resolved;
	}

	async importResolved(resolved, projectRoot, options = {}) {
		options = this.#fencedOptions(options);
		if (!resolved || typeof resolved.name !== "string" || typeof resolved.source !== "string" ||
			!["project", "personal"].includes(resolved.scope)) {
			throw new Error("invalid resolved workflow import");
		}
		workflowName(resolved.name);
		const hash = createHash("sha256").update(resolved.source).digest("hex");
		if (hash !== resolved.hash) throw new Error("resolved workflow changed before import");
		let namespace;
		try { namespace = await this.#importNamespace(projectRoot, options); }
		catch (error) {
			// A human may still launch a personal workflow when race-safe project
			// I/O is unavailable. It simply cannot be imported for later model or
			// nested name-based launch until those project primitives exist.
			if (resolved.scope !== "personal" || error?.code !== "WORKFLOW_PROJECT_IO_UNAVAILABLE") throw error;
			return false;
		}
		if (options.expectedProjectIdentity && ["canonicalRoot", "device", "inode"].some(
			(key) => namespace.identity[key] !== options.expectedProjectIdentity[key],
		)) throw new Error("workflow project identity changed before import");
		await this.#publishContent(hash, resolved.source);
		await this.#writeIndex((previous) => {
			const index = previous?.version === 2 && previous.projects && typeof previous.projects === "object"
				? structuredClone(previous)
				: { version: 2, projects: {} };
			index.projects[namespace.key] ??= { identity: namespace.identity, workflows: {} };
			if (["darwin", "win32"].includes(process.platform)) {
				for (const candidate of Object.keys(index.projects[namespace.key].workflows)) {
					if (candidate !== resolved.name && candidate.toLocaleLowerCase("en-US") === resolved.name.toLocaleLowerCase("en-US")) delete index.projects[namespace.key].workflows[candidate];
				}
			}
			index.projects[namespace.key].workflows[resolved.name] = { hash, scope: resolved.scope, importedAt: new Date().toISOString() };
			return index;
		});
		return true;
	}

	async #publishContent(hash, source) {
		await this.#ensureContentDirectory();
		const destination = path.join(this.contentDirectory, `${hash}.js`);
		const temporary = path.join(this.contentDirectory, `.${hash}.${process.pid}.${randomUUID()}.tmp`);
		const handle = await fs.open(temporary, "wx", 0o600);
		try { await handle.writeFile(source); await handle.sync(); }
		finally { await handle.close(); }
		try {
			try { await fs.link(temporary, destination); }
			catch (error) {
				if (error?.code !== "EEXIST") throw error;
				const existing = await readRegularNoFollow(destination);
				if (createHash("sha256").update(existing).digest("hex") !== hash) {
					throw new Error("existing content-addressed workflow file failed its complete hash check");
				}
			}
		} finally {
			await fs.unlink(temporary).catch(() => {});
			await syncDirectory(this.contentDirectory);
		}
		return destination;
	}

	async save(nameValue, source, options = {}) {
		options = this.#fencedOptions({ ...options, deadline: options.deadline ?? Date.now() + 10_000 });
		const name = workflowName(nameValue);
		if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > WORKFLOW_LIMITS.maxSourceBytes) {
			throw new Error("workflow source must be a bounded string");
		}
		const meta = extractWorkflowMeta(source);
		const project = this.#project(options);
		const directory = options.scope === "project" ? project.directory : await personalWorkflowDirectory(this.personalRoot, { create: true });
		const destination = path.join(directory, `${name}.js`);
		if (options.scope === "project") {
			await saveProjectWorkflow(project.root, name, source, options.overwrite === true, options);
			return { name, scope: "project", meta, destination };
		}
		await savePersonalWorkflow(this.personalRoot, name, source, options.overwrite === true, options);
		return { name, scope: options.scope === "project" ? "project" : "personal", meta, destination };
	}
}
