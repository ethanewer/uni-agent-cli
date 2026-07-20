import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	REQUIRED_LOCAL_ADAPTERS,
	inspectLocalAdapter,
	inspectLocalAdapters,
	inspectLocalNativePayloads,
	verifyPostinstall,
} from "../scripts/postinstall.mjs";
import { verifyReleaseCandidate } from "../scripts/verify-release-candidate.mjs";
import { npmInstallationDigest } from "../scripts/release-toolchain.mjs";

const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const shrinkwrap = JSON.parse(fs.readFileSync(new URL("../npm-shrinkwrap.json", import.meta.url), "utf8"));
for (const [name, entry] of Object.entries(shrinkwrap.packages)) {
	if (typeof entry?.resolved === "string" && /^https:\/\/registry\.npmjs\.org\//u.test(entry.resolved)) {
		assert.match(entry.integrity ?? "", /^sha512-/u, `registry shrinkwrap entry ${name} must carry SHA-512 integrity`);
	}
}
const candidateVerifierFixture = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candidate-verifier-"));
try {
	const commit = "a".repeat(40);
	const tarballName = "cc-0.1.0.tgz";
	const tarball = Buffer.from("candidate fixture");
	const digest = createHash("sha256").update(tarball).digest("hex");
	const packBytes = Buffer.from(`${JSON.stringify([{ filename: tarballName, name: "cc", version: "0.1.0" }], null, 2)}\n`);
	const provenance = {
		version: 1, commit, tarball: tarballName, sha256: digest,
		name: "cc", packageVersion: "0.1.0",
		packMetadataSha256: createHash("sha256").update(packBytes).digest("hex"),
		toolchain: { nodeVersion: "22.19.0", npmVersion: "10.9.3", npmInstallationSha256: "930c1fa35e5525e3b60c584fc3709c7cf71d62134d66fdc88a6e0fe8fc72dc6d" },
	};
	fs.writeFileSync(path.join(candidateVerifierFixture, tarballName), tarball);
	fs.writeFileSync(path.join(candidateVerifierFixture, `${tarballName}.sha256`), `${digest}  ${tarballName}\n`);
	fs.writeFileSync(path.join(candidateVerifierFixture, "dynamic-workflows-pack.json"), packBytes);
	fs.writeFileSync(path.join(candidateVerifierFixture, "dynamic-workflows-candidate.json"), `${JSON.stringify(provenance)}\n`);
	const verifier = fileURLToPath(new URL("../scripts/verify-release-candidate.mjs", import.meta.url));
	const accepted = spawnSync(process.execPath, [verifier, candidateVerifierFixture, commit], { encoding: "utf8" });
	assert.equal(accepted.status, 0, accepted.stderr);
	const protectedValidation = {
		...provenance,
		validationToolchain: provenance.toolchain,
		validationTools: {
			tmuxVersion: "3.5a",
			tmuxSourceSha256: "16216bd0877170dfcc64157085ba9013610b12b082548c7c9542cc0103198951",
			libeventVersion: "2.1.12-stable",
			libeventSourceSha256: "92e6de1be9ec176428fd2367677e61ceffc2ee1cb119035037a27d346b0403bb",
			runnerImageVersion: "test-image",
			runnerOsVersion: "15.0",
		},
		validated: true,
		gates: ["disabled-package-smoke", "dynamic-workflows-release", "authenticated-live-release"],
	};
	fs.writeFileSync(path.join(candidateVerifierFixture, "dynamic-workflows-validated.json"), `${JSON.stringify(protectedValidation)}\n`);
	assert.doesNotThrow(() => verifyReleaseCandidate(candidateVerifierFixture, commit, { requireValidated: true }));
	const { validationToolchain: _missingValidationToolchain, ...missingValidationToolchain } = protectedValidation;
	fs.writeFileSync(path.join(candidateVerifierFixture, "dynamic-workflows-validated.json"), `${JSON.stringify(missingValidationToolchain)}\n`);
	assert.throws(() => verifyReleaseCandidate(candidateVerifierFixture, commit, { requireValidated: true }), /protected validation evidence/u, "protected evidence must name the toolchain that ran validation");
	fs.writeFileSync(path.join(candidateVerifierFixture, "dynamic-workflows-validated.json"), `${JSON.stringify({
		...protectedValidation,
		validationToolchain: { ...provenance.toolchain, npmVersion: "0.0.0" },
	})}\n`);
	assert.throws(() => verifyReleaseCandidate(candidateVerifierFixture, commit, { requireValidated: true }), /protected validation evidence/u, "protected evidence rejects a validation toolchain different from candidate provenance");
	fs.writeFileSync(path.join(candidateVerifierFixture, "dynamic-workflows-validated.json"), `${JSON.stringify(protectedValidation)}\n`);
	fs.writeFileSync(path.join(candidateVerifierFixture, "dynamic-workflows-candidate.json"), Buffer.alloc(64 * 1024 + 1, 0x20));
	assert.throws(
		() => verifyReleaseCandidate(candidateVerifierFixture, commit),
		/not a bounded regular file/u,
		"candidate verification rejects oversized provenance before reading or parsing it",
	);
	fs.writeFileSync(path.join(candidateVerifierFixture, "dynamic-workflows-candidate.json"), `${JSON.stringify(provenance)}\n`);
	provenance.name = "substituted-package";
	fs.writeFileSync(path.join(candidateVerifierFixture, "dynamic-workflows-candidate.json"), `${JSON.stringify(provenance)}\n`);
	const rejected = spawnSync(process.execPath, [verifier, candidateVerifierFixture, commit], { encoding: "utf8" });
	assert.notEqual(rejected.status, 0, "candidate verification rejects provenance whose package identity differs from pack metadata");
} finally {
	fs.rmSync(candidateVerifierFixture, { recursive: true, force: true });
}
const shrinkwrapFailureFixture = fs.mkdtempSync(path.join(os.tmpdir(), "cc-shrinkwrap-verify-"));
try {
	const brokenShrinkwrap = structuredClone(shrinkwrap);
	const brokenEntry = Object.entries(brokenShrinkwrap.packages).find(([name, entry]) => name && !entry.link && entry.resolved);
	delete brokenEntry[1].resolved;
	delete brokenEntry[1].integrity;
	fs.writeFileSync(path.join(shrinkwrapFailureFixture, "npm-shrinkwrap.json"), JSON.stringify(brokenShrinkwrap));
	fs.mkdirSync(path.join(shrinkwrapFailureFixture, "scripts"));
	fs.mkdirSync(path.join(shrinkwrapFailureFixture, "src", "workflows"), { recursive: true });
	fs.copyFileSync(new URL("../scripts/release-workflows.mjs", import.meta.url), path.join(shrinkwrapFailureFixture, "scripts", "release-workflows.mjs"));
	fs.copyFileSync(new URL("../scripts/release-toolchain.mjs", import.meta.url), path.join(shrinkwrapFailureFixture, "scripts", "release-toolchain.mjs"));
	fs.copyFileSync(new URL("../scripts/shrinkwrap-policy.mjs", import.meta.url), path.join(shrinkwrapFailureFixture, "scripts", "shrinkwrap-policy.mjs"));
	fs.copyFileSync(new URL("../src/workflows/trusted-executable.mjs", import.meta.url), path.join(shrinkwrapFailureFixture, "src", "workflows", "trusted-executable.mjs"));
	const rejectedShrinkwrap = spawnSync(process.execPath, [path.join(shrinkwrapFailureFixture, "scripts", "release-workflows.mjs"), "verify"], { encoding: "utf8" });
	assert.notEqual(rejectedShrinkwrap.status, 0, "release verification rejects an external package after both provenance fields are deleted");
	assert.match(rejectedShrinkwrap.stderr, /approved registry provenance and SHA-512 integrity/u);
} finally {
	fs.rmSync(shrinkwrapFailureFixture, { recursive: true, force: true });
}
assert.equal(packageJson.bin.cc, "src/cc.mjs");
assert.equal(packageJson.private, true, "the unscoped local-channel package must never target the unrelated public npm name");
assert.equal(packageJson.scripts.prepublishOnly, undefined);
assert.equal(packageJson.engines.node, ">=22.19.0", "the package must satisfy every bundled harness runtime floor");
assert.equal(packageJson.optionalDependencies["opencode-ai"], "1.18.3", "the platform-specific OpenCode CLI must remain optional");
assert.equal(packageJson.dependencies["opencode-ai"], undefined, "the platform-specific OpenCode CLI must not block other harnesses");
assert.equal(packageJson.dependencies["@agentclientprotocol/claude-agent-acp"], "0.59.0");
assert.equal(packageJson.dependencies["@agentclientprotocol/codex-acp"], "1.1.4");
assert.equal(packageJson.dependencies["@anthropic-ai/claude-agent-sdk"], "0.3.214");
assert.equal(packageJson.dependencies["@openai/codex"], "0.144.6");
assert.equal(packageJson.dependencies["@earendil-works/pi-coding-agent"], "0.80.10");
assert.equal(packageJson.dependencies["pi-acp"], "0.0.31");
assert.equal(packageJson.dependencies["@modelcontextprotocol/sdk"], "1.29.0");
assert.equal(packageJson.dependencies.acorn, "8.15.0");
assert.equal(packageJson.dependencies.ajv, "8.20.0");
assert.equal(packageJson.dependencies.zod, "4.4.3");
assert.deepEqual(
	REQUIRED_LOCAL_ADAPTERS.map(({ packageName, version }) => [packageName, version]),
	[
		["@agentclientprotocol/claude-agent-acp", "0.59.0"],
		["@agentclientprotocol/codex-acp", "1.1.4"],
		["pi-acp", "0.0.31"],
	],
);

const launcher = fs.readFileSync(new URL(`../${packageJson.bin.cc}`, import.meta.url), "utf8");
const workflowRelease = fs.readFileSync(new URL("../scripts/release-workflows.mjs", import.meta.url), "utf8");
const releaseToolchain = fs.readFileSync(new URL("../scripts/release-toolchain.mjs", import.meta.url), "utf8");
const releaseNodeBootstrap = fs.readFileSync(new URL("../scripts/bootstrap-release-node.sh", import.meta.url), "utf8");
const liveWorkflowGate = fs.readFileSync(new URL("./dynamic_workflows_live_e2e.sh", import.meta.url), "utf8");
const deterministicWorkflowGate = fs.readFileSync(new URL("./dynamic_workflows_e2e.sh", import.meta.url), "utf8");
const packageInstallGate = fs.readFileSync(new URL("./package_install_smoke.sh", import.meta.url), "utf8");
const releaseWorkflow = fs.readFileSync(new URL("../.github/workflows/dynamic-workflows-release.yml", import.meta.url), "utf8");
const liveReleaseWorkflow = fs.readFileSync(new URL("../.github/workflows/dynamic-workflows-live-release.yml", import.meta.url), "utf8");
assert.match(launcher.split(/\r?\n/, 1)[0], /^#!\/usr\/bin\/env node$/u);
assert.match(launcher, /Node\.js 22\.19\.0 or newer/u);
assert.match(launcher, /const startupTerminalMode = inheritedTerminalMode \?\? captureTerminalMode\(\)/u, "the direct npm bin captures a restoration snapshot without the source shell wrapper");
assert.match(workflowRelease, /const deterministicEnv = \{[\s\S]*\.\.\.credentialFreeEnv/u, "deterministic install gates use the credential-scrubbed environment");
assert.match(workflowRelease, /delete credentialFreeEnv\.CC_RELEASE_COMMIT/u, "the outer release commit assertion cannot leak into ordinary channel installer regression fixtures");
assert.match(workflowRelease, /key\|token\|secret\|password\|credential\|auth/u, "deterministic install gates scrub model, registry, and secret-shaped credentials");
assert.match(workflowRelease, /credentialBearingUrl/u, "deterministic install gates scrub credentials embedded in registry or proxy URLs");
assert.match(workflowRelease, /supplied workflow release candidate does not exactly match the reviewed checkout/u, "a supplied local candidate is content-bound to the reviewed checkout");
assert.match(workflowRelease, /tarball = checkoutTarball/u, "all release gates consume the private verified candidate snapshot");
assert.match(workflowRelease, /CC_WORKFLOW_RELEASE_DIR/u, "local release can retain its immutable candidate in a caller-selected evidence directory");
assert.match(workflowRelease, /CC_WORKFLOW_E2E_RESULT_PATH: liveResult/u, "local authenticated release always retains its result JSON beside the candidate");
assert.match(workflowRelease, /authenticated live evidence is incomplete or contradictory/u, "local authenticated release independently validates retained live evidence before publication");
assert.match(workflowRelease, /dynamic-workflows-candidate\.json/u, "local release retains commit, digest, and package provenance");
assert.match(releaseToolchain, /RELEASE_NODE_VERSION = "22\.19\.0"/u, "local workflow releases enforce the exact Node toolchain");
assert.match(releaseToolchain, /RELEASE_NPM_VERSION = "10\.9\.3"/u, "local workflow releases enforce the exact npm toolchain");
assert.match(releaseToolchain, /RELEASE_NPM_WINDOWS_INSTALLATION_SHA256/u, "the official Windows npm layout has its own reviewed complete-installation digest");
assert.match(workflowRelease, /assertPinnedNpmInstallation/u, "local workflow releases authenticate the complete npm installation");
assert.match(workflowRelease, /toolchain,/u, "local candidate provenance records the enforced Node/npm versions");
assert.match(workflowRelease, /packMetadataSha256/u, "local candidate provenance binds npm pack identity metadata");
assert.match(workflowRelease, /CC_RELEASE_NPM_CLI: npmInvocation\.prefixArgs\[0\]/u, "nested release gates inherit the selected absolute npm CLI");
assert.match(workflowRelease, /trustedExecutableOnPath\("git"/u, "local provenance uses an authenticated absolute Git executable");
assert.match(workflowRelease, /\["--no-replace-objects", "-C", repositoryRoot, \.\.\.args\]/u, "every local provenance Git operation disables replacement refs and binds the reviewed checkout");
assert.match(workflowRelease, /\^GIT_/u, "release provenance removes inherited Git worktree, index, config, and repository overrides");
assert.doesNotMatch(`${releaseWorkflow}\n${liveReleaseWorkflow}`, /actions\/setup-node/u, "protected release jobs do not execute npm through setup-node before authenticating it");
assert.match(releaseWorkflow, /bootstrap-release-node\.sh/u, "every deterministic protected job uses the digest-pinned Node bootstrap");
assert.match(liveReleaseWorkflow, /bootstrap-release-node\.sh/u, "the authenticated protected job uses the digest-pinned Node bootstrap");
assert.match(releaseNodeBootstrap, /c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2/u, "the Linux release archive is pinned to its official SHA-256");
assert.ok(
	releaseNodeBootstrap.indexOf("release-workflows.mjs verify-toolchain") < releaseNodeBootstrap.indexOf('>> "$GITHUB_PATH"'),
	"the complete npm installation is authenticated before the protected runtime enters PATH",
);
assert.match(workflowRelease, /dynamic-workflows-release-result\.json/u, "local release records deterministic and authenticated gate completion");
assert.match(workflowRelease, /writeJsonAtomic\(result/u, "failed local gates atomically retain their release result");
assert.match(workflowRelease, /if \(releaseDirectory\)/u, "candidate-preparation failures retain a result even before provenance is complete");
assert.doesNotMatch(workflowRelease, /rmSync\(candidateDirectory/u, "successful local release never deletes its reviewed candidate");
if (process.platform !== "win32") {
	const releaseFixture = fs.mkdtempSync(path.join(os.tmpdir(), "cc-local-release-fixture-"));
	const releaseEvidence = fs.mkdtempSync(path.join(os.tmpdir(), "cc-local-release-evidence-"));
	const invalidLiveEvidence = fs.mkdtempSync(path.join(os.tmpdir(), "cc-local-release-invalid-live-"));
	const failedDeterministicEvidence = fs.mkdtempSync(path.join(os.tmpdir(), "cc-local-release-failed-deterministic-"));
	const failedCandidateEvidence = fs.mkdtempSync(path.join(os.tmpdir(), "cc-local-release-failed-candidate-"));
	const dirtyCheckoutEvidence = fs.mkdtempSync(path.join(os.tmpdir(), "cc-local-release-dirty-checkout-"));
	const invalidShrinkwrapEvidence = fs.mkdtempSync(path.join(os.tmpdir(), "cc-local-release-invalid-shrinkwrap-"));
	const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "cc-local-release-bin-"));
	try {
		const fixtureRuntimeRoot = path.join(releaseFixture, "runtime");
		const fixtureNode = path.join(fixtureRuntimeRoot, "bin", "node");
		const fixtureNpmCli = path.join(fixtureRuntimeRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js");
		fs.mkdirSync(path.dirname(fixtureNode), { recursive: true });
		fs.mkdirSync(path.dirname(fixtureNpmCli), { recursive: true });
		fs.mkdirSync(path.join(releaseFixture, "src", "workflows"), { recursive: true });
		fs.copyFileSync(process.execPath, fixtureNode);
		fs.chmodSync(fixtureNode, 0o700);
		fs.mkdirSync(path.join(releaseFixture, "scripts"));
		const fixtureReleaseScript = path.join(releaseFixture, "scripts", "release-workflows.mjs");
		fs.copyFileSync(new URL("../scripts/release-workflows.mjs", import.meta.url), fixtureReleaseScript);
		fs.copyFileSync(new URL("../scripts/shrinkwrap-policy.mjs", import.meta.url), path.join(releaseFixture, "scripts", "shrinkwrap-policy.mjs"));
		const fixtureToolchainScript = path.join(releaseFixture, "scripts", "release-toolchain.mjs");
		fs.copyFileSync(new URL("../scripts/release-toolchain.mjs", import.meta.url), fixtureToolchainScript);
		// Exercise release orchestration with this test process while production
		// remains pinned to the reviewed Node 22.19.0 runtime.
		fs.writeFileSync(fixtureToolchainScript, fs.readFileSync(fixtureToolchainScript, "utf8")
			.replace('export const RELEASE_NODE_VERSION = "22.19.0";', `export const RELEASE_NODE_VERSION = "${process.versions.node}";`));
		fs.copyFileSync(new URL("../src/workflows/trusted-executable.mjs", import.meta.url), path.join(releaseFixture, "src", "workflows", "trusted-executable.mjs"));
		fs.copyFileSync(new URL("../npm-shrinkwrap.json", import.meta.url), path.join(releaseFixture, "npm-shrinkwrap.json"));
		fs.writeFileSync(fixtureNpmCli, [
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'if (process.argv[2] === "--version") {',
			'  process.stdout.write("10.9.3\\n");',
			'} else if (process.argv[2] === "pack") {',
			'  const destination = process.argv[process.argv.indexOf("--pack-destination") + 1];',
			'  fs.writeFileSync(path.join(destination, "cc-0.1.0.tgz"), "immutable candidate");',
			'  process.stdout.write(JSON.stringify([{ filename: "cc-0.1.0.tgz", name: "cc", version: "0.1.0" }]));',
			'} else if (process.env.CC_FAKE_DETERMINISTIC_FAIL === "1" && process.argv.includes("test:release:candidate")) {',
			'  process.exitCode = 7;',
			'} else if (process.env.CC_WORKFLOW_E2E_RESULT_PATH) {',
			'  const valid = { version: 1, exitStatus: 0, stage: "passed", status: "completed", deliveryState: "delivered", agentReadyCount: 2, agentCompletedCount: 2, runCompletedCount: 1, modelRoutingValidated: true, parallelRoutingValidated: true, expectedOutputsValidated: true, deliveryValidated: true, parseErrors: 0 };',
			'  fs.writeFileSync(process.env.CC_WORKFLOW_E2E_RESULT_PATH, JSON.stringify(process.env.CC_FAKE_LIVE_INVALID === "1" ? { version: 1, exitStatus: 0, stage: "passed" } : valid));',
			'}',
		].join("\n"), { mode: 0o700 });
		fs.writeFileSync(path.join(path.dirname(path.dirname(fixtureNpmCli)), "package.json"), JSON.stringify({ name: "npm", version: "10.9.3" }));
		const fixtureNpmDigest = npmInstallationDigest(fixtureNpmCli);
		fs.writeFileSync(fixtureToolchainScript, fs.readFileSync(fixtureToolchainScript, "utf8")
			.replace("930c1fa35e5525e3b60c584fc3709c7cf71d62134d66fdc88a6e0fe8fc72dc6d", fixtureNpmDigest));
		for (const args of [["init", "-q"], ["config", "user.email", "release@example.invalid"], ["config", "user.name", "Release Test"], ["add", "."], ["commit", "-qm", "fixture"]]) {
			const result = spawnSync("git", args, { cwd: releaseFixture, encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
		}
		const releaseFixtureEnvironment = {
			...process.env,
			PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
		};
		// This test itself runs inside the deterministic candidate gate. Do not let
		// the outer release's immutable candidate/evidence paths become inputs to
		// the nested, independently committed release fixture.
		for (const name of [
			"CC_RELEASE_COMMIT", "CC_RELEASE_NODE", "CC_RELEASE_NPM_CLI",
			"CC_WORKFLOW_E2E_RESULT_PATH", "CC_WORKFLOW_E2E_TARBALL", "CC_WORKFLOW_RELEASE_DIR",
		]) delete releaseFixtureEnvironment[name];
		const localRelease = spawnSync(fixtureNode, [path.join(releaseFixture, "scripts", "release-workflows.mjs"), "live"], {
			cwd: releaseFixture, encoding: "utf8",
			env: { ...releaseFixtureEnvironment, CC_WORKFLOW_RELEASE_DIR: releaseEvidence },
		});
		assert.equal(localRelease.status, 0, localRelease.stderr);
		for (const name of [
			"cc-0.1.0.tgz", "cc-0.1.0.tgz.sha256", "dynamic-workflows-pack.json",
			"dynamic-workflows-candidate.json", "dynamic-workflows-live-result.json",
			"dynamic-workflows-release-result.json", "dynamic-workflows-validated.json",
		]) assert.equal(fs.statSync(path.join(releaseEvidence, name)).isFile(), true, `local release retains ${name}`);
		const retainedProvenance = JSON.parse(fs.readFileSync(path.join(releaseEvidence, "dynamic-workflows-candidate.json"), "utf8"));
		assert.match(retainedProvenance.commit, /^[0-9a-f]{40}$/u);
		assert.equal(retainedProvenance.sha256, fs.readFileSync(path.join(releaseEvidence, "cc-0.1.0.tgz.sha256"), "utf8").split(/\s+/u)[0]);
		assert.deepEqual(retainedProvenance.toolchain, {
			nodeVersion: process.versions.node,
			npmVersion: "10.9.3",
			npmInstallationSha256: fixtureNpmDigest,
		});
		const retainedSuccess = JSON.parse(fs.readFileSync(path.join(releaseEvidence, "dynamic-workflows-release-result.json"), "utf8"));
		assert.deepEqual({ succeeded: retainedSuccess.succeeded, deterministicPassed: retainedSuccess.deterministicPassed, livePassed: retainedSuccess.livePassed }, { succeeded: true, deterministicPassed: true, livePassed: true });

		const invalidLive = spawnSync(fixtureNode, [path.join(releaseFixture, "scripts", "release-workflows.mjs"), "live"], {
			cwd: releaseFixture, encoding: "utf8",
			env: { ...releaseFixtureEnvironment, CC_WORKFLOW_RELEASE_DIR: invalidLiveEvidence, CC_FAKE_LIVE_INVALID: "1" },
		});
		assert.notEqual(invalidLive.status, 0);
		assert.match(invalidLive.stderr, /authenticated live evidence is incomplete or contradictory/u);
		assert.equal(fs.existsSync(path.join(invalidLiveEvidence, "dynamic-workflows-validated.json")), false);
		const invalidLiveResult = JSON.parse(fs.readFileSync(path.join(invalidLiveEvidence, "dynamic-workflows-release-result.json"), "utf8"));
		assert.deepEqual({ succeeded: invalidLiveResult.succeeded, deterministicPassed: invalidLiveResult.deterministicPassed, livePassed: invalidLiveResult.livePassed, failedGate: invalidLiveResult.failedGate }, { succeeded: false, deterministicPassed: true, livePassed: false, failedGate: "authenticated-live-release" });

		const failedDeterministic = spawnSync(fixtureNode, [path.join(releaseFixture, "scripts", "release-workflows.mjs"), "deterministic"], {
			cwd: releaseFixture, encoding: "utf8",
			env: { ...releaseFixtureEnvironment, CC_WORKFLOW_RELEASE_DIR: failedDeterministicEvidence, CC_FAKE_DETERMINISTIC_FAIL: "1" },
		});
		assert.notEqual(failedDeterministic.status, 0);
		const failedDeterministicResult = JSON.parse(fs.readFileSync(path.join(failedDeterministicEvidence, "dynamic-workflows-release-result.json"), "utf8"));
		assert.deepEqual({ succeeded: failedDeterministicResult.succeeded, deterministicPassed: failedDeterministicResult.deterministicPassed, livePassed: failedDeterministicResult.livePassed, failedGate: failedDeterministicResult.failedGate }, { succeeded: false, deterministicPassed: false, livePassed: false, failedGate: "local-deterministic-release" });

		const mismatchedCandidate = path.join(fakeBin, "mismatched-candidate.tgz");
		fs.writeFileSync(mismatchedCandidate, "not the reviewed checkout");
		const failedCandidate = spawnSync(fixtureNode, [path.join(releaseFixture, "scripts", "release-workflows.mjs"), "deterministic"], {
			cwd: releaseFixture, encoding: "utf8",
			env: { ...releaseFixtureEnvironment, CC_WORKFLOW_RELEASE_DIR: failedCandidateEvidence, CC_WORKFLOW_E2E_TARBALL: mismatchedCandidate },
		});
		assert.notEqual(failedCandidate.status, 0);
		assert.match(failedCandidate.stderr, /does not exactly match the reviewed checkout/u);
		const failedCandidateResult = JSON.parse(fs.readFileSync(path.join(failedCandidateEvidence, "dynamic-workflows-release-result.json"), "utf8"));
		assert.equal(failedCandidateResult.succeeded, false);
		assert.equal(failedCandidateResult.failedGate, "candidate-preparation");
		assert.match(failedCandidateResult.commit, /^[0-9a-f]{40}$/u);
		assert.equal(Object.hasOwn(failedCandidateResult, "sha256"), false, "failed candidate evidence does not claim unestablished provenance");

		const dirtyFile = path.join(releaseFixture, "dirty-release-input.txt");
		fs.writeFileSync(dirtyFile, "uncommitted release input");
		const dirtyCheckout = spawnSync(fixtureNode, [path.join(releaseFixture, "scripts", "release-workflows.mjs"), "deterministic"], {
			cwd: releaseFixture, encoding: "utf8",
			env: { ...releaseFixtureEnvironment, CC_WORKFLOW_RELEASE_DIR: dirtyCheckoutEvidence },
		});
		fs.rmSync(dirtyFile);
		assert.notEqual(dirtyCheckout.status, 0);
		assert.match(dirtyCheckout.stderr, /requires a clean checkout/u);
		const dirtyCheckoutResult = JSON.parse(fs.readFileSync(path.join(dirtyCheckoutEvidence, "dynamic-workflows-release-result.json"), "utf8"));
		assert.deepEqual({ succeeded: dirtyCheckoutResult.succeeded, failedGate: dirtyCheckoutResult.failedGate }, { succeeded: false, failedGate: "candidate-preparation" });
		assert.match(dirtyCheckoutResult.commit, /^[0-9a-f]{40}$/u, "dirty-checkout evidence still identifies the exact rejected HEAD");

		const invalidReleaseShrinkwrap = structuredClone(shrinkwrap);
		const invalidReleaseEntry = Object.entries(invalidReleaseShrinkwrap.packages).find(([name, entry]) => name && !entry.link && entry.resolved);
		delete invalidReleaseEntry[1].integrity;
		fs.writeFileSync(path.join(releaseFixture, "npm-shrinkwrap.json"), JSON.stringify(invalidReleaseShrinkwrap));
		const invalidShrinkwrapRelease = spawnSync(fixtureNode, [path.join(releaseFixture, "scripts", "release-workflows.mjs"), "deterministic"], {
			cwd: releaseFixture, encoding: "utf8",
			env: { ...releaseFixtureEnvironment, CC_WORKFLOW_RELEASE_DIR: invalidShrinkwrapEvidence },
		});
		assert.notEqual(invalidShrinkwrapRelease.status, 0);
		assert.match(invalidShrinkwrapRelease.stderr, /approved registry provenance and SHA-512 integrity/u);
		const invalidShrinkwrapResult = JSON.parse(fs.readFileSync(path.join(invalidShrinkwrapEvidence, "dynamic-workflows-release-result.json"), "utf8"));
		assert.deepEqual({ succeeded: invalidShrinkwrapResult.succeeded, failedGate: invalidShrinkwrapResult.failedGate }, { succeeded: false, failedGate: "candidate-preparation" });
		assert.equal(Object.hasOwn(invalidShrinkwrapResult, "commit"), false, "pre-provenance evidence does not claim a commit before checkout validation");
	} finally {
		fs.rmSync(releaseFixture, { recursive: true, force: true });
		fs.rmSync(releaseEvidence, { recursive: true, force: true });
		fs.rmSync(invalidLiveEvidence, { recursive: true, force: true });
		fs.rmSync(failedDeterministicEvidence, { recursive: true, force: true });
		fs.rmSync(failedCandidateEvidence, { recursive: true, force: true });
		fs.rmSync(dirtyCheckoutEvidence, { recursive: true, force: true });
		fs.rmSync(invalidShrinkwrapEvidence, { recursive: true, force: true });
		fs.rmSync(fakeBin, { recursive: true, force: true });
	}
}
for (const gate of [liveWorkflowGate, deterministicWorkflowGate, packageInstallGate, releaseWorkflow]) {
	assert.match(gate, /shopt -s nocasematch/u, "shell release gates scrub arbitrarily mixed-case credential variable names");
	assert.doesNotMatch(gate, /\*PAT\*/u, "PAT credential scrubbing does not accidentally erase PATH");
	assert.match(gate, /PAT_\*\|\*_PAT/u, "PAT credential scrubbing covers delimited PAT variable names");
}
for (const gate of [liveWorkflowGate, deterministicWorkflowGate, packageInstallGate]) {
	assert.match(gate, /unset npm_config_omit NPM_CONFIG_OMIT/u, "artifact gates clear ambient optional-dependency omission");
	assert.match(gate, /install --include=optional/u, "artifact gates explicitly install required optional native payloads");
}
assert.match(liveWorkflowGate, /MODEL_KEY_FILE/u, "the authenticated gate transfers its key through a one-use private file");
assert.match(liveWorkflowGate, /\/usr\/bin\/env -i "\$\{install_environment\[@\]\}" "\$\{install_command\[@\]\}" install/u, "authenticated dependency lifecycle scripts receive only an explicit credential-free environment");
assert.doesNotMatch(liveWorkflowGate, /exec env OPENAI_API_KEY/u, "the authenticated gate never places its key in a child argv vector");
assert.match(liveWorkflowGate, /export OPENAI_API_KEY="\$model_api_key".*model_api_key=.*exec %q codex/su, "the authenticated gate exports the key only in its private shell immediately before direct exec");
assert.match(liveWorkflowGate, /evidence_status/u, "a successful live test fails if its release evidence cannot be written");
assert.match(liveWorkflowGate, /completed_outputs_by_label == expected_outputs_by_label/u, "retained evidence binds each exact worker output to its queued identity");
assert.match(liveWorkflowGate, /set\(ready_agent_ids\) == set\(queued_labels\)/u, "retained evidence binds model and effort readiness to both queued worker identities");
assert.match(liveReleaseWorkflow, /authenticated live evidence is incomplete or contradictory/u, "protected validation independently checks the retained live evidence");
assert.match(liveReleaseWorkflow, /evidence\.exitStatus===0.*evidence\.stage==="passed".*evidence\.deliveryState==="delivered"/u, "protected validation requires successful terminal evidence and delivery");
assert.match(releaseWorkflow, /cd "\$\(dirname "\$TARBALL"\)" && sha256sum "\$\(basename "\$TARBALL"\)"/u, "protected checksum evidence records a portable tarball basename");
assert.match(releaseWorkflow, /CC_WORKFLOW_RELEASE_DIR: \$\{\{ runner\.temp \}\}\/cc-deterministic-release/u, "protected deterministic gates retain their structured release result in a known directory");
assert.match(releaseWorkflow, /dynamic-workflows-deterministic-release-\$\{\{ github\.sha \}\}/u, "protected deterministic evidence is uploaded independently of the authenticated gate");
assert.match(releaseWorkflow, /node "\$NPM_CLI" pack/u, "protected packaging uses npm beside the verified Node runtime");
assert.match(releaseWorkflow, /npmInstallationSha256/u, "protected candidate provenance binds the complete npm installation content");
assert.match(releaseWorkflow, /verify-release-candidate\.mjs/u, "every protected candidate consumer verifies package identity against bound pack metadata");
assert.match(releaseWorkflow, /dynamic-workflows-final-release:\s*\n\s+needs: \[package-candidate, disabled-package-smoke, dynamic-workflows-release, authenticated-live-release\]\s*\n\s+if: always\(\)/u, "the final required release check runs even when an upstream job fails or is skipped");
assert.match(releaseWorkflow, /release gates did not all succeed/u, "the final required release check explicitly rejects every failed applicable prerequisite");
assert.equal((releaseWorkflow.match(/node node_modules\/opencode-ai\/postinstall\.mjs/gu) ?? []).length, 2, "both protected jobs that run the ordinary suite materialize OpenCode after an ignore-scripts install");
assert.doesNotMatch(releaseWorkflow, /secrets:\s*\n\s+OPENAI_API_KEY:/u, "the reusable authenticated gate does not require a repository-scoped secret pass-through");
assert.match(liveReleaseWorkflow, /workflow_call: \{\}/u, "the reusable live gate receives its model key only from its protected environment");
assert.match(liveReleaseWorkflow, /environment: dynamic-workflows-release/u, "the called authenticated job owns the protected environment that supplies its key");
assert.match(liveReleaseWorkflow, /release-workflows\.mjs verify-toolchain/u, "authenticated validation independently verifies its exact release toolchain");
assert.match(liveReleaseWorkflow, /validationToolchain/u, "authenticated evidence records the toolchain that ran the live gate");
assert.doesNotMatch(`${releaseWorkflow}\n${liveReleaseWorkflow}`, /brew install tmux/u, "protected release gates never fetch a floating Homebrew tmux formula");
assert.match(liveReleaseWorkflow, /validationTools/u, "authenticated evidence records pinned tmux sources and runner image identity");
for (const workflow of [releaseWorkflow, liveReleaseWorkflow]) {
	assert.doesNotMatch(workflow, /node-version: 22\s*$/mu, "release jobs never float across Node 22 toolchains");
	assert.doesNotMatch(workflow, /node-version:/u, "release jobs never delegate pre-authentication runtime selection to setup-node");
	assert.match(workflow, /bootstrap-release-node\.sh/u, "release jobs bootstrap the exact digest-pinned Node/npm toolchain");
}
for (const trustedRef of ["refs/heads/main", "refs/heads/workflows", "refs/heads/workflows-wip-2026-07-19"]) {
	assert.match(releaseWorkflow, new RegExp(trustedRef, "u"), `the caller admits protected release secrets only for ${trustedRef}`);
	assert.match(liveReleaseWorkflow, new RegExp(trustedRef, "u"), `the called job independently admits protected release secrets only for ${trustedRef}`);
}
assert.match(deterministicWorkflowGate, /"cc-owner:" in commands\.get\(pid, ""\)/u, "the manager-only crash fixture recognizes the manager's validated ownership process marker");
assert.match(deterministicWorkflowGate, /pid=,ppid=,lstart=,command=/u, "the manager-only crash fixture binds every destructive signal to a process start identity");

// The checked-out installation itself has both exact, usable package-local
// adapters. PATH and globally installed package ownership are irrelevant.
const installed = inspectLocalAdapters();
assert.equal(installed.length, 3);
assert.ok(installed.every((result) => result.ok), JSON.stringify(installed));
const installedNative = inspectLocalNativePayloads();
assert.equal(installedNative.length, 3);
assert.ok(installedNative.every((result) => result.ok), JSON.stringify(installedNative));
assert.ok(verifyPostinstall({ report: false }).every((result) => result.ok));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-postinstall-local-"));
try {
	const adapter = REQUIRED_LOCAL_ADAPTERS[1];
	const packageRoot = path.join(root, ...adapter.packageName.split("/"));
	const entrypoint = path.join(packageRoot, "dist", "index.js");
	fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
	fs.writeFileSync(entrypoint, "#!/usr/bin/env node\n");
	fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
		name: adapter.packageName,
		version: adapter.version,
		bin: { [adapter.bin]: "dist/index.js" },
	}));
	assert.equal(inspectLocalAdapter(adapter, root).ok, true);

	fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
		name: adapter.packageName,
		version: "0.0.0",
		bin: { [adapter.bin]: "dist/index.js" },
	}));
	assert.match(inspectLocalAdapter(adapter, root).reason, /expected 1\.1\.4, found 0\.0\.0/u);

	fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
		name: "@zed-industries/codex-acp",
		version: adapter.version,
		bin: { [adapter.bin]: "dist/index.js" },
	}));
	assert.match(inspectLocalAdapter(adapter, root).reason, /unexpected package identity/u);

	fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
		name: adapter.packageName,
		version: adapter.version,
		bin: { [adapter.bin]: "../../outside.js" },
	}));
	assert.match(inspectLocalAdapter(adapter, root).reason, /escapes its package/u);

	fs.rmSync(packageRoot, { recursive: true, force: true });
	const missing = verifyPostinstall({ nodeModules: root, adapters: [adapter], report: false });
	assert.equal(missing[0].ok, false);
	assert.match(missing[0].reason, /missing/u);
	assert.deepEqual(
		verifyPostinstall({ nodeModules: root, adapters: [adapter], env: { CC_SKIP_ADAPTER_INSTALL: "1" }, report: false }),
		[],
	);
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

// Project-local and npx installs hoist cc's dependencies beside cc instead of
// nesting them under the package; verification must find the hoisted copy
// rather than warn that the installation is broken.
{
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "cc-postinstall-hoisted-"));
	try {
		const adapter = REQUIRED_LOCAL_ADAPTERS[1];
		const packageRoot = path.join(project, "node_modules", ...adapter.packageName.split("/"));
		const entrypoint = path.join(packageRoot, "dist", "index.js");
		fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
		fs.writeFileSync(entrypoint, "#!/usr/bin/env node\n");
		fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
			name: adapter.packageName,
			version: adapter.version,
			bin: { [adapter.bin]: "dist/index.js" },
		}));
		const nestedNodeModules = path.join(project, "node_modules", "cc", "node_modules");
		fs.mkdirSync(nestedNodeModules, { recursive: true });
		const hoisted = inspectLocalAdapter(adapter, nestedNodeModules);
		assert.equal(hoisted.ok, true, JSON.stringify(hoisted));
		assert.equal(hoisted.packageDir, packageRoot);
	} finally {
		fs.rmSync(project, { recursive: true, force: true });
	}
}

// cc and the Claude ACP adapter may pin different Agent SDK patch releases.
// Verification must keep the directly installed SDK paired with its own
// directly installed native payload instead of mixing the adapter's nested SDK
// with cc's hoisted payload.
{
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "cc-postinstall-sdk-pairs-"));
	const modules = path.join(project, "node_modules");
	const ccModules = path.join(modules, "cc", "node_modules");
	const adapterRoot = path.join(modules, "@agentclientprotocol", "claude-agent-acp");
	const nativeName = "@anthropic-ai/claude-agent-sdk-linux-x64";
	const writePackage = (root, name, metadata) => {
		const directory = path.join(root, ...name.split("/"));
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, ...metadata }));
		return directory;
	};
	try {
		writePackage(modules, "@agentclientprotocol/claude-agent-acp", {
			version: "0.59.0",
			dependencies: { "@anthropic-ai/claude-agent-sdk": "0.3.207" },
		});
		writePackage(path.join(adapterRoot, "node_modules"), "@anthropic-ai/claude-agent-sdk", {
			version: "0.3.207",
			optionalDependencies: { [nativeName]: "0.3.207" },
		});
		const nestedNative = writePackage(path.join(adapterRoot, "node_modules"), nativeName, { version: "0.3.207" });
		fs.writeFileSync(path.join(nestedNative, "claude"), "nested\n", { mode: 0o755 });

		writePackage(modules, "@anthropic-ai/claude-agent-sdk", {
			version: "0.3.214",
			optionalDependencies: { [nativeName]: "0.3.214" },
		});
		const directNative = writePackage(modules, nativeName, { version: "0.3.214" });
		fs.writeFileSync(path.join(directNative, "claude"), "direct\n", { mode: 0o755 });
		fs.mkdirSync(ccModules, { recursive: true });

		const result = inspectLocalNativePayloads(ccModules, {
			platform: "linux",
			arch: "x64",
			libc: "glibc",
		}).find((entry) => entry.key === "claude");
		assert.equal(result?.ok, true, JSON.stringify(result));
		assert.equal(result?.packageDir, directNative);
		const adapterResult = inspectLocalNativePayloads(ccModules, {
			platform: "linux",
			arch: "x64",
			libc: "glibc",
		}).find((entry) => entry.key === "claude-acp");
		assert.equal(adapterResult?.ok, true, JSON.stringify(adapterResult));
		assert.equal(adapterResult?.packageDir, nestedNative);

		fs.writeFileSync(path.join(directNative, "package.json"), JSON.stringify({
			name: nativeName,
			version: "0.3.207",
		}));
		const directSdk = path.join(modules, "@anthropic-ai", "claude-agent-sdk");
		const nestedDirectNative = writePackage(path.join(directSdk, "node_modules"), nativeName, { version: "0.3.214" });
		fs.writeFileSync(path.join(nestedDirectNative, "claude"), "nested direct\n", { mode: 0o755 });
		const nestedResult = inspectLocalNativePayloads(ccModules, {
			platform: "linux",
			arch: "x64",
			libc: "glibc",
		}).find((entry) => entry.key === "claude");
			assert.equal(nestedResult?.ok, true, JSON.stringify(nestedResult));
			assert.equal(nestedResult?.packageDir, nestedDirectNative, "native lookup follows the selected SDK's Node-resolution tree before ambient hoists");

			fs.rmSync(directSdk, { recursive: true, force: true });
			fs.rmSync(directNative, { recursive: true, force: true });
			const staleAncestorResult = inspectLocalNativePayloads(ccModules, {
				platform: "linux",
				arch: "x64",
				libc: "glibc",
			}).find((entry) => entry.key === "claude");
			assert.equal(staleAncestorResult?.ok, false, JSON.stringify(staleAncestorResult));
			assert.match(staleAncestorResult?.reason ?? "", /expected @anthropic-ai\/claude-agent-sdk@0\.3\.214, found @anthropic-ai\/claude-agent-sdk@0\.3\.207/u, "an ancestor adapter SDK cannot substitute for cc's missing pinned direct runtime dependency");
		} finally {
		fs.rmSync(project, { recursive: true, force: true });
	}
}

// Omitting npm optional dependencies leaves both JS adapters present but strips
// the native executables they need. Verify that postinstall detects that exact
// partial-install state and tells the user how to repair it.
{
	const nodeModules = fs.mkdtempSync(path.join(os.tmpdir(), "cc-postinstall-native-"));
	const nativeOptions = { platform: "linux", arch: "x64", libc: "glibc" };
	const claudeNativeName = "@anthropic-ai/claude-agent-sdk-linux-x64";
	const codexNativeName = "@openai/codex-linux-x64";
	const writePackage = (name, metadata) => {
		const directory = path.join(nodeModules, ...name.split("/"));
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, ...metadata }));
		return directory;
	};
	try {
		writePackage("@agentclientprotocol/claude-agent-acp", {
			version: "0.59.0",
			dependencies: { "@anthropic-ai/claude-agent-sdk": "0.3.214" },
		});
		writePackage("@anthropic-ai/claude-agent-sdk", {
			version: "0.3.214",
			optionalDependencies: { [claudeNativeName]: "1.0.0" },
		});
		const claudeNative = writePackage(claudeNativeName, { version: "1.0.0" });
		fs.writeFileSync(path.join(claudeNative, "claude"), "native\n", { mode: 0o755 });
		fs.chmodSync(path.join(claudeNative, "claude"), 0o755);

		writePackage("@openai/codex", {
			version: "0.144.6",
			optionalDependencies: { [codexNativeName]: "npm:@openai/codex@1.0.0-linux-x64" },
		});
		const codexNative = writePackage(codexNativeName, { name: "@openai/codex", version: "1.0.0-linux-x64" });
		const codexBinary = path.join(codexNative, "vendor", "test-target", "bin", "codex");
		fs.mkdirSync(path.dirname(codexBinary), { recursive: true });
		fs.writeFileSync(codexBinary, "native\n", { mode: 0o755 });
		fs.chmodSync(codexBinary, 0o755);

		const complete = inspectLocalNativePayloads(nodeModules, nativeOptions);
		assert.equal(complete.length, 3);
		assert.ok(complete.every((result) => result.ok), JSON.stringify(complete));

		fs.writeFileSync(path.join(claudeNative, "package.json"), JSON.stringify({
			name: claudeNativeName,
			version: "0.9.0",
		}));
		const staleClaude = inspectLocalNativePayloads(nodeModules, nativeOptions)
			.find((result) => result.key === "claude");
		assert.equal(staleClaude?.ok, false);
		assert.match(staleClaude?.reason, /expected .*@1\.0\.0, found .*@0\.9\.0/u);
		fs.writeFileSync(path.join(claudeNative, "package.json"), JSON.stringify({
			name: claudeNativeName,
			version: "1.0.0",
		}));

		fs.writeFileSync(path.join(codexNative, "package.json"), JSON.stringify({
			name: "@openai/codex",
			version: "1.0.0-linux-arm64",
		}));
		const staleCodex = inspectLocalNativePayloads(nodeModules, nativeOptions)
			.find((result) => result.key === "codex");
		assert.equal(staleCodex?.ok, false);
		assert.match(staleCodex?.reason, /expected @openai\/codex@1\.0\.0-linux-x64/u);
		fs.writeFileSync(path.join(codexNative, "package.json"), JSON.stringify({
			name: "@openai/codex",
			version: "1.0.0-linux-x64",
		}));

		fs.rmSync(claudeNative, { recursive: true, force: true });
		const omitted = inspectLocalNativePayloads(nodeModules, nativeOptions);
		assert.equal(omitted.find((result) => result.key === "claude")?.ok, false);
		assert.match(omitted.find((result) => result.key === "claude")?.reason, /optional native package/u);
		assert.equal(omitted.find((result) => result.key === "codex")?.ok, true);
		fs.rmSync(codexNative, { recursive: true, force: true });
		assert.ok(inspectLocalNativePayloads(nodeModules, nativeOptions).every((result) => !result.ok));

		let warning = "";
		const originalWarn = console.warn;
		console.warn = (message) => { warning += String(message); };
		try {
			const results = verifyPostinstall({
				nodeModules,
				adapters: [],
				nativeOptions,
			});
			assert.equal(results.some((result) => !result.ok), true);
		} finally {
			console.warn = originalWarn;
		}
		assert.match(warning, /npm install --include=optional/u);
		assert.match(warning, /omit config contains `optional`/u);
		assert.match(warning, /@anthropic-ai\/claude-agent-sdk-linux-x64/u);
		assert.match(warning, /@openai\/codex-linux-x64/u);

		let globalWarning = "";
		console.warn = (message) => { globalWarning += String(message); };
		try {
			verifyPostinstall({
				nodeModules,
				adapters: [],
				nativeOptions,
				env: { npm_config_global: "true" },
			});
		} finally {
			console.warn = originalWarn;
		}
		assert.match(globalWarning, /exact original tarball or local-channel install command/u);
		assert.doesNotMatch(globalWarning, /npm install -g cc/u);
		assert.doesNotMatch(globalWarning, /From the cc package\/project directory/u);
	} finally {
		fs.rmSync(nodeModules, { recursive: true, force: true });
	}
}

const source = fs.readFileSync(new URL("../scripts/postinstall.mjs", import.meta.url), "utf8");
assert.doesNotMatch(source, /spawnSync|execSync|@zed-industries/u);

console.log("postinstall: package-local verification only; no global migration");
