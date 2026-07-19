import fs from "node:fs/promises";
import path from "node:path";
import { syncDirectory } from "./durability.mjs";

async function assertTrustedDirectory(directory) {
	const stat = await fs.lstat(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error("workflow state ancestry must contain only real directories");
	}
	if (typeof process.getuid === "function") {
		const uid = process.getuid();
		if (stat.uid !== uid && stat.uid !== 0) {
			throw new Error("workflow state ancestry must be owned by the current user or root");
		}
		if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) {
			const trustedRootStickyDirectory = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
			if (!trustedRootStickyDirectory) {
				throw new Error("workflow state ancestry must not be writable by other users");
			}
		}
	}
}

async function assertTrustedAncestry(directory) {
	const chain = [];
	let cursor = path.resolve(directory);
	while (true) {
		chain.push(cursor);
		const parent = path.dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	for (const entry of chain.reverse()) await assertTrustedDirectory(entry);
}

async function ensureDirectoryTree(directory) {
	const resolved = path.resolve(directory);
	const missing = [];
	let cursor = resolved;
	while (true) {
		try { await fs.lstat(cursor); break; }
		catch (error) {
			if (error?.code !== "ENOENT") throw error;
			missing.push(cursor);
			const parent = path.dirname(cursor);
			if (parent === cursor) throw error;
			cursor = parent;
		}
	}
	// Resolve any pre-existing symlinks before using the path as a persistence
	// namespace. From here on every ancestor is a real, trusted directory; a
	// root-owned sticky directory such as /tmp is the only writable exception.
	let canonical = await fs.realpath(cursor);
	await assertTrustedAncestry(canonical);
	for (const requested of missing.reverse()) {
		const next = path.join(canonical, path.basename(requested));
		try { await fs.mkdir(next, { mode: 0o700 }); }
		catch (error) { if (error?.code !== "EEXIST") throw error; }
		await assertTrustedDirectory(next);
		await syncDirectory(canonical);
		canonical = next;
	}
	return canonical;
}

export async function ensureWorkflowPrivateDirectory(directory) {
	const resolved = path.resolve(directory);
	let created = false;
	try { await fs.mkdir(resolved, { mode: 0o700 }); created = true; }
	catch (error) { if (error?.code !== "EEXIST") throw error; }
	let stat = await fs.lstat(resolved);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error("workflow state directory must be a real directory");
	}
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("workflow state directory must be owned by the current user");
	if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
		await fs.chmod(resolved, 0o700);
		stat = await fs.lstat(resolved);
		if ((stat.mode & 0o077) !== 0) throw new Error("workflow state directory must be private");
	}
	if (created) await syncDirectory(path.dirname(resolved));
	return resolved;
}

export async function prepareWorkflowStateRoot(parentDirectory) {
	const parent = await ensureDirectoryTree(parentDirectory);
	const root = path.join(parent, "workflow-state");
	let rootCreated = false;
	try { await fs.mkdir(root, { mode: 0o700 }); rootCreated = true; }
	catch (error) { if (error?.code !== "EEXIST") throw error; }
	if (rootCreated) await syncDirectory(parent);
	let stat = await fs.lstat(root);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error("workflow state root must be a real directory");
	}
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
		throw new Error("workflow state root must be owned by the current user");
	}
	if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
		await fs.chmod(root, 0o700);
		stat = await fs.lstat(root);
		if ((stat.mode & 0o077) !== 0) throw new Error("workflow state root must be private");
	}
	const canonical = await fs.realpath(root);
	await assertTrustedAncestry(path.dirname(canonical));
	return canonical;
}
