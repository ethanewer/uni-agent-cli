import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RELEASE_NODE_VERSION = "22.19.0";
export const RELEASE_NPM_VERSION = "10.9.3";
export const RELEASE_NPM_INSTALLATION_SHA256 = "930c1fa35e5525e3b60c584fc3709c7cf71d62134d66fdc88a6e0fe8fc72dc6d";
export const RELEASE_NPM_WINDOWS_INSTALLATION_SHA256 = "96e24593e278dc6821e6f0323f6b7fce6de77e1c0812d096e2d2234cf81f72df";
const MAX_NPM_INSTALLATION_BYTES = 64 * 1024 * 1024;
const MAX_NPM_INSTALLATION_ENTRIES = 10_000;
const MAX_NPM_RELATIVE_PATH_BYTES = 1024;

function boundedFileBytes(file, limit, label) {
	const before = fs.lstatSync(file, { bigint: true });
	if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(limit)) throw new Error(`${label} is not a bounded regular file`);
	const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	try {
		const opened = fs.fstatSync(fd, { bigint: true });
		if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
			throw new Error(`${label} changed before it could be read`);
		}
		const bytes = Buffer.alloc(Number(before.size));
		let offset = 0;
		while (offset < bytes.length) {
			const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
			if (count === 0) break;
			offset += count;
		}
		const after = fs.fstatSync(fd, { bigint: true });
		if (offset !== bytes.length || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
			throw new Error(`${label} changed while it was being read`);
		}
		return bytes;
	} finally { fs.closeSync(fd); }
}

export function npmInstallationRoot(npmCli) {
	const root = path.dirname(path.dirname(fs.realpathSync(npmCli)));
	const manifest = JSON.parse(boundedFileBytes(path.join(root, "package.json"), 64 * 1024, "npm package manifest").toString("utf8"));
	if (manifest?.name !== "npm" || manifest?.version !== RELEASE_NPM_VERSION) {
		throw new Error(`release toolchain requires npm ${RELEASE_NPM_VERSION}`);
	}
	return root;
}

export function npmInstallationDigest(npmCli) {
	const root = npmInstallationRoot(npmCli);
	const digest = createHash("sha256");
	let entries = 0;
	let totalBytes = 0;
	const visit = (directory, prefix = "") => {
		for (const name of fs.readdirSync(directory).sort()) {
			const file = path.join(directory, name);
			const relative = prefix ? `${prefix}/${name}` : name;
			entries += 1;
			if (entries > MAX_NPM_INSTALLATION_ENTRIES || Buffer.byteLength(relative, "utf8") > MAX_NPM_RELATIVE_PATH_BYTES) {
				throw new Error("npm installation exceeds its bounded tree limits");
			}
			const stat = fs.lstatSync(file);
			if (stat.isDirectory()) {
				digest.update(`d\0${relative}\0`);
				visit(file, relative);
			} else if (stat.isFile()) {
				totalBytes += stat.size;
				if (totalBytes > MAX_NPM_INSTALLATION_BYTES) throw new Error("npm installation exceeds its bounded content limit");
				digest.update(`f\0${relative}\0${stat.size}\0`);
				digest.update(boundedFileBytes(file, stat.size, `npm installation entry ${relative}`));
			} else if (stat.isSymbolicLink()) {
				digest.update(`l\0${relative}\0${fs.readlinkSync(file)}\0`);
			} else throw new Error(`npm installation contains an unsupported entry: ${relative}`);
		}
	};
	visit(root);
	return digest.digest("hex");
}

export function releaseNpmInstallationSha256(platform = process.platform) {
	return platform === "win32" ? RELEASE_NPM_WINDOWS_INSTALLATION_SHA256 : RELEASE_NPM_INSTALLATION_SHA256;
}

export function assertPinnedNpmInstallation(npmCli, platform = process.platform) {
	const digest = npmInstallationDigest(npmCli);
	if (digest !== releaseNpmInstallationSha256(platform)) {
		throw new Error(`release toolchain npm installation differs from pinned npm ${RELEASE_NPM_VERSION}`);
	}
	return digest;
}
