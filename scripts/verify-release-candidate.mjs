#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_NPM_INSTALLATION_SHA256 } from "./release-toolchain.mjs";

const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 1024;
const MAX_PACK_METADATA_BYTES = 1024 * 1024;
const MAX_PROVENANCE_BYTES = 64 * 1024;
const MAX_VALIDATION_BYTES = 256 * 1024;

function fail(message) { throw new Error(message); }
function openBoundedRegularFile(file, label, limit) {
	const before = fs.lstatSync(file, { bigint: true });
	if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(limit)) fail(`${label} is not a bounded regular file`);
	const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	try {
		const opened = fs.fstatSync(fd, { bigint: true });
		if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
			fail(`${label} changed before it could be opened`);
		}
		return { fd, before };
	} catch (error) {
		fs.closeSync(fd);
		throw error;
	}
}
function finishBoundedRead(fd, before, total, label) {
	const after = fs.fstatSync(fd, { bigint: true });
	if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || BigInt(total) !== before.size) {
		fail(`${label} changed while it was being read`);
	}
}
function readBoundedFile(file, label, limit) {
	const { fd, before } = openBoundedRegularFile(file, label, limit);
	try {
		const bytes = Buffer.alloc(Number(before.size));
		let total = 0;
		while (total < bytes.length) {
			const count = fs.readSync(fd, bytes, total, bytes.length - total, null);
			if (count === 0) break;
			total += count;
		}
		finishBoundedRead(fd, before, total, label);
		return bytes;
	} finally { fs.closeSync(fd); }
}
function sha256File(file, label, limit) {
	const { fd, before } = openBoundedRegularFile(file, label, limit);
	try {
		const digest = createHash("sha256");
		const buffer = Buffer.allocUnsafe(1024 * 1024);
		let total = 0;
		for (;;) {
			const count = fs.readSync(fd, buffer, 0, buffer.length, null);
			if (count === 0) break;
			total += count;
			if (total > limit) fail(`${label} exceeds its size limit`);
			digest.update(buffer.subarray(0, count));
		}
		finishBoundedRead(fd, before, total, label);
		return digest.digest("hex");
	} finally { fs.closeSync(fd); }
}
function sha256(data) { return createHash("sha256").update(data).digest("hex"); }

export function verifyReleaseCandidate(directory, expectedCommit, options = {}) {
	const root = path.resolve(directory ?? "");
	if (!path.isAbsolute(directory ?? "") || !/^[0-9a-f]{40}$/u.test(expectedCommit ?? "")) {
		fail("candidate verification requires an absolute directory and full commit SHA");
	}
	const names = fs.readdirSync(root);
	const tarballs = names.filter((name) => name.endsWith(".tgz"));
	if (tarballs.length !== 1) fail("candidate artifact must contain exactly one tarball");
	const tarballName = tarballs[0];
	const tarball = path.join(root, tarballName);
	const checksumFile = `${tarball}.sha256`;
	const packFile = path.join(root, "dynamic-workflows-pack.json");
	const provenanceFile = path.join(root, "dynamic-workflows-candidate.json");
	const actualDigest = sha256File(tarball, "candidate tarball", MAX_TARBALL_BYTES);
	const checksum = readBoundedFile(checksumFile, "candidate checksum", MAX_CHECKSUM_BYTES).toString("utf8").trim().split(/\s+/u);
	if (checksum.length !== 2 || checksum[0] !== actualDigest || checksum[1] !== tarballName) fail("candidate checksum mismatch");
	const packBytes = readBoundedFile(packFile, "candidate pack metadata", MAX_PACK_METADATA_BYTES);
	const pack = JSON.parse(packBytes.toString("utf8"));
	if (!Array.isArray(pack) || pack.length !== 1) fail("pack metadata must describe exactly one candidate");
	const packed = pack[0];
	const provenance = JSON.parse(readBoundedFile(provenanceFile, "candidate provenance", MAX_PROVENANCE_BYTES).toString("utf8"));
	const valid = provenance?.version === 1 && provenance.commit === expectedCommit &&
		provenance.tarball === tarballName && provenance.sha256 === actualDigest &&
		packed?.filename === tarballName && typeof packed?.name === "string" && typeof packed?.version === "string" &&
		provenance.name === packed.name && provenance.packageVersion === packed.version &&
		provenance.packMetadataSha256 === sha256(packBytes) &&
		provenance.toolchain?.nodeVersion === "22.19.0" && provenance.toolchain?.npmVersion === "10.9.3" &&
		provenance.toolchain?.npmInstallationSha256 === RELEASE_NPM_INSTALLATION_SHA256;
	if (!valid) fail("candidate provenance mismatch");
	if (options.expectedToolchain && JSON.stringify(provenance.toolchain) !== JSON.stringify(options.expectedToolchain)) {
		fail("candidate provenance toolchain differs from the validation toolchain");
	}
	let validated;
	if (options.requireValidated === true) {
		const validatedFile = path.join(root, "dynamic-workflows-validated.json");
		validated = JSON.parse(readBoundedFile(validatedFile, "local validation evidence", MAX_VALIDATION_BYTES).toString("utf8"));
		const boundKeys = ["version", "commit", "tarball", "sha256", "name", "packageVersion", "packMetadataSha256", "toolchain"];
		if (validated?.validated !== true || !Array.isArray(validated.gates) ||
			!["local-deterministic-release", "authenticated-live-release"].every((gate) => validated.gates.includes(gate)) ||
			JSON.stringify(validated.validationToolchain) !== JSON.stringify(provenance.toolchain) ||
			boundKeys.some((key) => JSON.stringify(validated[key]) !== JSON.stringify(provenance[key]))) {
			fail("local validation evidence is incomplete or names a different candidate");
		}
	}
	return { root, tarball, tarballName, provenance, validated };
}

function main() {
	const expectedToolchain = process.env.CC_EXPECTED_RELEASE_TOOLCHAIN
		? JSON.parse(process.env.CC_EXPECTED_RELEASE_TOOLCHAIN)
		: undefined;
	const result = verifyReleaseCandidate(process.argv[2], process.argv[3], { expectedToolchain });
	process.stdout.write(result.tarball);
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url))) main();
