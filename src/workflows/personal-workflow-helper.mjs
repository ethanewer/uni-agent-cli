#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const MAX_SOURCE_BYTES = 256 * 1024;
const [operation, requestedRoot, name, overwriteValue] = process.argv.slice(2);

function validName(value) {
	return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value);
}

function assertPrivateDirectory(stat, label) {
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} is not a regular directory`);
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`${label} is not owned by the current user`);
	if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) throw new Error(`${label} is writable by another user`);
}

async function enterStableDirectory(directory, label) {
	const requested = path.resolve(directory);
	const before = await fsp.lstat(requested);
	assertPrivateDirectory(before, label);
	const canonical = await fsp.realpath(requested);
	process.chdir(canonical);
	const after = await fsp.stat(".");
	if (before.dev !== after.dev || before.ino !== after.ino) throw new Error(`${label} changed while it was being opened`);
}

async function syncCurrentDirectory() {
	if (process.platform === "win32") return;
	const handle = await fsp.open(".", "r");
	try { await handle.sync(); } finally { await handle.close(); }
}

async function readStdinBounded() {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of process.stdin) {
		bytes += chunk.length;
		if (bytes > MAX_SOURCE_BYTES) throw new Error("workflow source exceeds the personal save bound");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

if (!["list", "read", "save"].includes(operation) || (["read", "save"].includes(operation) && !validName(name))) {
	throw new Error("invalid personal workflow helper invocation");
}
await enterStableDirectory(requestedRoot, "personal workflow root");
if (operation === "save") {
	try { await fsp.mkdir("workflows", { mode: 0o700 }); await syncCurrentDirectory(); }
	catch (error) { if (error?.code !== "EEXIST") throw error; }
}
await enterStableDirectory("workflows", "personal workflow directory");

if (operation === "list") {
	const names = (await fsp.readdir(".")).filter((entry) => entry.endsWith(".js") && validName(entry.slice(0, -3))).sort();
	const output = JSON.stringify(names);
	if (Buffer.byteLength(output) > MAX_SOURCE_BYTES) throw new Error("personal workflow discovery exceeds the output bound");
	process.stdout.write(output);
} else if (operation === "read") {
	if (!fs.constants.O_NOFOLLOW || !fs.constants.O_NONBLOCK) throw new Error("secure nonblocking no-follow workflow reads are unavailable on this platform");
	const handle = await fsp.open(`${name}.js`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) throw new Error("workflow must be a bounded regular file");
		const buffer = Buffer.allocUnsafe(MAX_SOURCE_BYTES + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		if (offset > MAX_SOURCE_BYTES) throw new Error("workflow source exceeds the personal read bound");
		process.stdout.write(buffer.subarray(0, offset));
	} finally { await handle.close(); }
} else {
	if (!fs.constants.O_NOFOLLOW) throw new Error("secure no-follow workflow writes are unavailable on this platform");
	const source = await readStdinBounded();
	const temporary = `.${name}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	const destination = `${name}.js`;
	let handle;
	try {
		handle = await fsp.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
		await handle.writeFile(source);
		await handle.sync();
		await handle.close();
		handle = undefined;
		if (overwriteValue === "1") await fsp.rename(temporary, destination);
		else { await fsp.link(temporary, destination); await fsp.unlink(temporary); }
		await syncCurrentDirectory();
		process.stdout.write('{"ok":true}');
	} finally {
		await handle?.close().catch(() => {});
		await fsp.unlink(temporary).catch(() => {});
	}
}
