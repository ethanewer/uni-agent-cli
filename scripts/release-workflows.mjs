#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	assertPinnedNpmInstallation,
	RELEASE_NODE_VERSION,
	RELEASE_NPM_VERSION,
} from "./release-toolchain.mjs";
import { validateShrinkwrapProvenance } from "./shrinkwrap-policy.mjs";
import { trustedExecutableOnPath, userControlledPathRoots } from "../src/workflows/trusted-executable.mjs";

const mode = process.argv[2] ?? "deterministic";
if (!new Set(["deterministic", "live", "candidate-gates", "verify", "verify-toolchain"]).has(mode)) {
	console.error("usage: node scripts/release-workflows.mjs [deterministic|live|candidate-gates|verify|verify-toolchain]");
	process.exit(2);
}

function validateCheckoutShrinkwrap() {
	const shrinkwrap = JSON.parse(fs.readFileSync(new URL("../npm-shrinkwrap.json", import.meta.url), "utf8"));
	validateShrinkwrapProvenance(shrinkwrap);
}
function releaseNpmInvocation(execPath = process.execPath, platform = process.platform) {
	const node = fs.realpathSync(execPath);
	const installationRoot = platform === "win32" ? path.dirname(node) : path.dirname(path.dirname(node));
	const cli = path.join(installationRoot, platform === "win32" ? "node_modules" : "lib/node_modules", "npm", "bin", "npm-cli.js");
	if (!fs.statSync(cli).isFile()) throw new Error("workflow releases require npm installed beside the active Node runtime");
	return { command: node, prefixArgs: [fs.realpathSync(cli)] };
}
const npmInvocation = releaseNpmInvocation();
function validateReleaseToolchain() {
	const nodeVersion = process.versions.node;
	if (nodeVersion !== RELEASE_NODE_VERSION) {
		throw new Error(`workflow releases require exact Node.js ${RELEASE_NODE_VERSION}; found ${nodeVersion}`);
	}
	const npmInstallationSha256 = assertPinnedNpmInstallation(npmInvocation.prefixArgs[0]);
	const result = spawnSync(npmInvocation.command, [...npmInvocation.prefixArgs, "--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
	if (result.error) throw result.error;
	const npmVersion = result.status === 0 ? result.stdout.trim() : "";
	if (npmVersion !== RELEASE_NPM_VERSION) {
		throw new Error(`workflow releases require exact npm ${RELEASE_NPM_VERSION}; found ${npmVersion || "unavailable"}`);
	}
	if (assertPinnedNpmInstallation(npmInvocation.prefixArgs[0]) !== npmInstallationSha256) {
		throw new Error("release toolchain npm installation changed during validation");
	}
	return { nodeVersion, npmVersion, npmInstallationSha256 };
}
if (mode === "verify" || mode === "verify-toolchain") {
	validateCheckoutShrinkwrap();
	if (mode === "verify-toolchain") validateReleaseToolchain();
	console.log(mode === "verify-toolchain" ? "release toolchain and npm shrinkwrap verified" : "npm shrinkwrap external integrity verified");
	process.exit(0);
}

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const credentialFreeEnv = { ...process.env };
for (const [name, value] of Object.entries(credentialFreeEnv)) {
	if (/^GIT_/iu.test(name) || /(?:key|token|secret|password|credential|auth)/iu.test(name) || /(?:^|_)pat(?:_|$)/iu.test(name) ||
		/^npm_config_.*(?:auth|token|userconfig|globalconfig)/iu.test(name) || /[\r\n]/u.test(String(value ?? "")) || credentialBearingUrl(value)) delete credentialFreeEnv[name];
}
// CC_RELEASE_COMMIT is an assertion consumed by this outer verifier. Passing it
// into ordinary regression fixtures would incorrectly turn every channel
// installation they exercise into a protected-candidate promotion request.
delete credentialFreeEnv.CC_RELEASE_COMMIT;
const emptyNpmConfigDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cc-release-npm-config-"));
credentialFreeEnv.npm_config_userconfig = path.join(emptyNpmConfigDirectory, "user.npmrc");
credentialFreeEnv.npm_config_globalconfig = path.join(emptyNpmConfigDirectory, "global.npmrc");
credentialFreeEnv.GIT_NO_REPLACE_OBJECTS = "1";
credentialFreeEnv.GIT_CONFIG_NOSYSTEM = "1";
credentialFreeEnv.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
fs.writeFileSync(credentialFreeEnv.npm_config_userconfig, "", { mode: 0o600 });
fs.writeFileSync(credentialFreeEnv.npm_config_globalconfig, "", { mode: 0o600 });

function credentialBearingUrl(value) {
	if (typeof value !== "string" || !value.includes("://")) return false;
	if (/[\r\n]/u.test(value) || /[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/iu.test(value) ||
		/[a-z][a-z0-9+.-]*:\/\/[^\s]*[?#]/iu.test(value)) return true;
	try {
		const parsed = new URL(value);
		return Boolean(parsed.username || parsed.password || parsed.search || parsed.hash);
	} catch { return false; }
}
const run = (args, options = {}) => {
	const result = spawnSync(npmInvocation.command, [...npmInvocation.prefixArgs, ...args], { cwd: repositoryRoot, stdio: "inherit", ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) throw Object.assign(new Error(`npm ${args.join(" ")} failed`), { exitCode: result.status ?? 1 });
};

if (mode === "candidate-gates") {
	validateReleaseToolchain();
	validateCheckoutShrinkwrap();
	const gateEnvironment = {
		...credentialFreeEnv,
		CC_RELEASE_NODE: npmInvocation.command,
		CC_RELEASE_NPM_CLI: npmInvocation.prefixArgs[0],
	};
	for (const args of [
		["test"],
		["run", "test:workflows:e2e:release"],
		["pack", "--dry-run", "--ignore-scripts"],
		["run", "test:package:install"],
	]) run(args, { env: gateEnvironment });
	process.exit(0);
}

function packCheckout(directory) {
	const packed = spawnSync(npmInvocation.command, [...npmInvocation.prefixArgs, "pack", "--ignore-scripts", "--json", "--pack-destination", directory], {
		cwd: repositoryRoot, encoding: "utf8", env: credentialFreeEnv, stdio: ["ignore", "pipe", "inherit"],
	});
	if (packed.error) throw packed.error;
	if (packed.status !== 0) throw Object.assign(new Error("npm pack failed"), { exitCode: packed.status ?? 1 });
	const metadata = JSON.parse(packed.stdout);
	if (!Array.isArray(metadata) || metadata.length !== 1 || typeof metadata[0]?.filename !== "string") {
		throw new Error("npm pack must produce exactly one workflow release candidate");
	}
	const tarball = path.resolve(directory, metadata[0].filename);
	if (!fs.statSync(tarball).isFile()) throw new Error("workflow release candidate is not a regular file");
	const packMetadata = `${JSON.stringify(metadata, null, 2)}\n`;
	fs.writeFileSync(path.join(directory, "dynamic-workflows-pack.json"), packMetadata, { flag: "wx", mode: 0o600 });
	return {
		tarball,
		metadata: metadata[0],
		packMetadataSha256: createHash("sha256").update(packMetadata).digest("hex"),
	};
}

function gitOutput(args) {
	const git = trustedExecutableOnPath("git", credentialFreeEnv, [repositoryRoot, ...userControlledPathRoots(repositoryRoot)], { requireRootOwnership: true });
	const result = spawnSync(git, ["--no-replace-objects", "-C", repositoryRoot, ...args], {
		cwd: repositoryRoot, encoding: "utf8", env: credentialFreeEnv, stdio: ["ignore", "pipe", "inherit"],
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
	return result.stdout.trim();
}

function prepareReleaseDirectory() {
	const requested = process.env.CC_WORKFLOW_RELEASE_DIR;
	let directory;
	if (requested) {
		if (!path.isAbsolute(requested)) throw new Error("CC_WORKFLOW_RELEASE_DIR must be absolute");
		directory = path.resolve(requested);
		const relative = path.relative(repositoryRoot, directory);
		if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
			throw new Error("CC_WORKFLOW_RELEASE_DIR must be outside the reviewed checkout");
		}
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	} else {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "cc-workflow-release-evidence-"));
	}
	if (!fs.statSync(directory).isDirectory() || fs.readdirSync(directory).length !== 0) {
		throw new Error("workflow release evidence directory must be an empty directory");
	}
	return directory;
}

function writeJson(file, value) {
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

function writeJsonAtomic(file, value) {
	const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
	try {
		fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		fs.linkSync(temporary, file);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

function validateLiveEvidence(file) {
	if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error("live workflow gate did not retain its result JSON");
	const stat = fs.statSync(file);
	if (stat.size > 64 * 1024) throw new Error("authenticated live evidence exceeds its bounded result size");
	let evidence;
	try { evidence = JSON.parse(fs.readFileSync(file, "utf8")); }
	catch (error) { throw new Error("authenticated live evidence is not valid JSON", { cause: error }); }
	const valid = evidence && !Array.isArray(evidence) &&
		evidence.version === 1 && evidence.exitStatus === 0 && evidence.stage === "passed" &&
		evidence.status === "completed" && evidence.deliveryState === "delivered" &&
		evidence.agentReadyCount === 2 && evidence.agentCompletedCount === 2 &&
		evidence.runCompletedCount === 1 && evidence.modelRoutingValidated === true &&
		evidence.parallelRoutingValidated === true && evidence.expectedOutputsValidated === true &&
		evidence.deliveryValidated === true && evidence.parseErrors === 0 && !evidence.evidenceError;
	if (!valid) throw new Error("authenticated live evidence is incomplete or contradictory");
	return evidence;
}

let releaseDirectory;
let provenance;
let commit;
let deterministicPassed = false;
let livePassed = false;
let failedGate = "candidate-preparation";
let toolchain;
try {
	releaseDirectory = prepareReleaseDirectory();
	toolchain = validateReleaseToolchain();
	validateCheckoutShrinkwrap();
	commit = gitOutput(["rev-parse", "HEAD"]);
	if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error("workflow release commit is not a full Git SHA");
	const dirty = gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]);
	if (dirty) throw new Error("workflow release requires a clean checkout so candidate provenance names exact committed content");
	if (process.env.CC_RELEASE_COMMIT && process.env.CC_RELEASE_COMMIT !== commit) {
		throw new Error("CC_RELEASE_COMMIT does not match the reviewed checkout HEAD");
	}
	let tarball = process.env.CC_WORKFLOW_E2E_TARBALL;
	let packed;
	if (tarball) {
		if (!path.isAbsolute(tarball) || !fs.existsSync(tarball) || !fs.statSync(tarball).isFile()) {
			throw new Error("CC_WORKFLOW_E2E_TARBALL must name an absolute regular tarball");
		}
		packed = packCheckout(releaseDirectory);
		const checkoutTarball = packed.tarball;
		const suppliedDigest = createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
		const checkoutDigest = createHash("sha256").update(fs.readFileSync(checkoutTarball)).digest("hex");
		if (suppliedDigest !== checkoutDigest) throw new Error("supplied workflow release candidate does not exactly match the reviewed checkout");
		// All consumers use this private checkout-produced snapshot, never the
		// caller-controlled path that was compared above.
		tarball = checkoutTarball;
	} else {
		packed = packCheckout(releaseDirectory);
		tarball = packed.tarball;
	}
	const digest = createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
	const tarballName = path.basename(tarball);
	fs.writeFileSync(path.join(releaseDirectory, `${tarballName}.sha256`), `${digest}  ${tarballName}\n`, { flag: "wx", mode: 0o600 });
	provenance = {
		version: 1, commit, tarball: tarballName, sha256: digest,
		name: packed.metadata.name, packageVersion: packed.metadata.version,
		packMetadataSha256: packed.packMetadataSha256,
		toolchain,
	};
	writeJson(path.join(releaseDirectory, "dynamic-workflows-candidate.json"), provenance);
	console.log(`workflow release candidate: ${tarball}`);
	console.log(`workflow release SHA-256: ${digest}`);
	console.log(`workflow release evidence: ${releaseDirectory}`);
	const deterministicEnv = {
		...credentialFreeEnv,
		CC_WORKFLOW_E2E_TARBALL: tarball,
		CC_RELEASE_NODE: npmInvocation.command,
		CC_RELEASE_NPM_CLI: npmInvocation.prefixArgs[0],
	};
	failedGate = "local-deterministic-release";
	run(["run", "test:release:candidate"], { env: deterministicEnv });
	deterministicPassed = true;
	if (mode === "live") {
		const liveResult = path.join(releaseDirectory, "dynamic-workflows-live-result.json");
		const liveEnv = {
			...credentialFreeEnv,
			CC_WORKFLOW_E2E_TARBALL: tarball,
			CC_WORKFLOW_E2E_RESULT_PATH: liveResult,
			CC_RELEASE_NODE: npmInvocation.command,
			CC_RELEASE_NPM_CLI: npmInvocation.prefixArgs[0],
		};
		if (process.env.OPENAI_API_KEY) liveEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
		failedGate = "authenticated-live-release";
		run(["run", "test:workflows:e2e:live"], { env: liveEnv });
		validateLiveEvidence(liveResult);
		livePassed = true;
		writeJson(path.join(releaseDirectory, "dynamic-workflows-validated.json"), {
			...provenance, validationToolchain: toolchain, validated: true,
			gates: ["local-deterministic-release", "authenticated-live-release"],
		});
	}
	failedGate = "release-evidence";
	writeJsonAtomic(path.join(releaseDirectory, "dynamic-workflows-release-result.json"), {
		version: 1, mode, commit, tarball: tarballName, sha256: digest,
		toolchain,
		succeeded: true, deterministicPassed, livePassed,
	});
} catch (error) {
	if (releaseDirectory) {
		const result = path.join(releaseDirectory, "dynamic-workflows-release-result.json");
		if (!fs.existsSync(result)) {
			writeJsonAtomic(result, {
				version: 1, mode,
				...(toolchain ? { toolchain } : {}),
				...(commit ? { commit } : {}),
				...(provenance ? { tarball: provenance.tarball, sha256: provenance.sha256 } : {}),
				succeeded: false, deterministicPassed, livePassed, failedGate,
			});
		}
	}
	throw error;
} finally {
	fs.rmSync(emptyNpmConfigDirectory, { recursive: true, force: true });
}
