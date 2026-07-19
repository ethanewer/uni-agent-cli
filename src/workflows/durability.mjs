import fs from "node:fs/promises";

// Windows does not permit opening a directory as a file handle. Atomic rename
// plus a synced file is the strongest portable primitive there; POSIX also
// syncs the containing directory so the rename survives a power loss.
export async function syncDirectory(directory) {
	if (process.platform === "win32") return;
	const handle = await fs.open(directory, "r");
	try { await handle.sync(); }
	finally { await handle.close(); }
}

export async function readBoundedHandle(handle, maximum, message = "state file exceeds its read bound") {
	if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error("invalid bounded read size");
	const buffer = Buffer.alloc(maximum + 1);
	let offset = 0;
	while (offset < buffer.length) {
		const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
		if (bytesRead === 0) break;
		offset += bytesRead;
	}
	if (offset > maximum) throw new Error(message);
	return buffer.subarray(0, offset);
}
