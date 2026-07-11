import assert from "node:assert/strict";

import {
	CODEX_DESKTOP_LAUNCH_TIMEOUT_MS,
	CODEX_FEEDBACK_CATEGORIES,
	CODEX_FEEDBACK_NOTE_MAX_LENGTH,
	CODEX_WINDOWS_DESKTOP_LAUNCH_SCRIPT,
	codexDesktopLaunchSpec,
	codexDesktopThreadUrl,
	codexFeedbackUploadParams,
	launchCodexDesktopThread,
	normalizeCodexFeedbackClassification,
	normalizeCodexFeedbackNote,
	parseCodexFeedbackArgument,
	sanitizeCodexFeedbackOperationError,
} from "../src/harness/codex-native-ui.mjs";

const threadId = "019abcde-1234-7abc-8def-0123456789ab";
const canonicalUrl = `codex://threads/${threadId}`;

assert.equal(codexDesktopThreadUrl(threadId.toUpperCase()), canonicalUrl);
assert.deepEqual(codexDesktopLaunchSpec(threadId, "darwin"), {
	platform: "darwin",
	url: canonicalUrl,
	command: "/usr/bin/open",
	args: [canonicalUrl],
});

const windowsSpec = codexDesktopLaunchSpec(threadId, "win32");
assert.deepEqual(windowsSpec, {
	platform: "win32",
	url: canonicalUrl,
	command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
	args: [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		CODEX_WINDOWS_DESKTOP_LAUNCH_SCRIPT,
		canonicalUrl,
	],
});
assert.match(CODEX_WINDOWS_DESKTOP_LAUNCH_SCRIPT, /Get-AppxPackage -Name OpenAI\.Codex/);
assert.match(CODEX_WINDOWS_DESKTOP_LAUNCH_SCRIPT, /Join-Path \$appDir 'Codex\.exe'/);
assert.match(CODEX_WINDOWS_DESKTOP_LAUNCH_SCRIPT, /resources\\app\.asar/);
assert.match(CODEX_WINDOWS_DESKTOP_LAUNCH_SCRIPT, /Start-Process/);
assert.equal(CODEX_WINDOWS_DESKTOP_LAUNCH_SCRIPT.includes(threadId), false, "the PowerShell source stays static");

for (const maliciousId of [
	"../new?path=/tmp",
	`${threadId}?path=/tmp`,
	`${threadId}\nStart-Process calc.exe`,
	`${threadId}' ; Start-Process calc.exe; #`,
	` ${threadId}`,
	`${threadId} `,
	"not-a-uuid",
	"",
	null,
]) {
	assert.throws(() => codexDesktopThreadUrl(maliciousId), (error) => {
		assert.equal(error.code, "CODEX_INVALID_THREAD_ID");
		return true;
	});
}

assert.throws(() => codexDesktopLaunchSpec(threadId, "linux"), (error) => {
	assert.equal(error.code, "CODEX_DESKTOP_UNSUPPORTED_PLATFORM");
	return true;
});

let unsupportedRunnerCalls = 0;
await assert.rejects(
	launchCodexDesktopThread(threadId, {
		platform: "linux",
		runCaptureImpl: async () => { unsupportedRunnerCalls += 1; },
	}),
	(error) => error.code === "CODEX_DESKTOP_UNSUPPORTED_PLATFORM",
);
assert.equal(unsupportedRunnerCalls, 0);

await assert.rejects(
	launchCodexDesktopThread(threadId, { platform: "darwin" }),
	(error) => error.code === "CODEX_DESKTOP_RUNNER_REQUIRED",
);

let capturedLaunch;
const launchResult = { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
const tracker = {};
assert.deepEqual(
	await launchCodexDesktopThread(threadId, {
		platform: "darwin",
		processTracker: tracker,
		runCaptureImpl: async (command, args, options) => {
			capturedLaunch = { command, args, options };
			return launchResult;
		},
	}),
	{ url: canonicalUrl, result: launchResult },
);
assert.deepEqual(capturedLaunch, {
	command: "/usr/bin/open",
	args: [canonicalUrl],
	options: {
		timeoutMs: CODEX_DESKTOP_LAUNCH_TIMEOUT_MS,
		maxStdoutBytes: 4 * 1024,
		maxStderrBytes: 64 * 1024,
		rejectOnExit: true,
		processTracker: tracker,
	},
});

let invalidRunnerCalls = 0;
await assert.rejects(
	launchCodexDesktopThread(`${threadId};calc.exe`, {
		platform: "win32",
		runCaptureImpl: async () => { invalidRunnerCalls += 1; },
	}),
	(error) => error.code === "CODEX_INVALID_THREAD_ID",
);
assert.equal(invalidRunnerCalls, 0);

const runnerError = new Error("launcher failed");
await assert.rejects(
	launchCodexDesktopThread(threadId, {
		platform: "darwin",
		runCaptureImpl: async () => { throw runnerError; },
	}),
	(error) => error === runnerError,
);

assert.deepEqual(
	CODEX_FEEDBACK_CATEGORIES.map((category) => category.classification),
	["bug", "bad_result", "good_result", "safety_check", "other"],
);
for (const category of CODEX_FEEDBACK_CATEGORIES) {
	assert.equal(normalizeCodexFeedbackClassification(category.classification), category.classification);
	assert.equal(normalizeCodexFeedbackClassification(category.commandValue), category.classification);
	assert.equal(normalizeCodexFeedbackClassification(category.label), category.classification);
}
assert.throws(
	() => normalizeCodexFeedbackClassification("security_issue"),
	(error) => error.code === "CODEX_INVALID_FEEDBACK_CLASSIFICATION",
);

assert.equal(normalizeCodexFeedbackNote(undefined), null);
assert.equal(normalizeCodexFeedbackNote("  useful context  "), "useful context");
assert.equal(normalizeCodexFeedbackNote("x".repeat(CODEX_FEEDBACK_NOTE_MAX_LENGTH)).length, CODEX_FEEDBACK_NOTE_MAX_LENGTH);
assert.throws(
	() => normalizeCodexFeedbackNote("x".repeat(CODEX_FEEDBACK_NOTE_MAX_LENGTH + 1)),
	(error) => error.code === "CODEX_FEEDBACK_NOTE_TOO_LONG",
);
assert.throws(
	() => normalizeCodexFeedbackNote("secret\0suffix"),
	(error) => error.code === "CODEX_INVALID_FEEDBACK_NOTE",
);

assert.equal(parseCodexFeedbackArgument("  "), undefined);
assert.deepEqual(parseCodexFeedbackArgument("bug"), { classification: "bug", reason: null });
assert.deepEqual(parseCodexFeedbackArgument("safety-check  benign request was blocked  "), {
	classification: "safety_check",
	reason: "benign request was blocked",
});
assert.deepEqual(parseCodexFeedbackArgument("bad_result first line\nsecond line"), {
	classification: "bad_result",
	reason: "first line\nsecond line",
});
assert.throws(
	() => parseCodexFeedbackArgument("unknown note"),
	(error) => error.code === "CODEX_INVALID_FEEDBACK_CLASSIFICATION",
);

for (const includeLogs of [false, true]) {
	const params = codexFeedbackUploadParams({
		classification: "good-result",
		reason: "  excellent result  ",
		threadId: threadId.toUpperCase(),
		includeLogs,
		tags: { should: "not escape" },
		extraLogFiles: ["/etc/passwd"],
	});
	assert.deepEqual(params, {
		classification: "good_result",
		reason: "excellent result",
		threadId,
		includeLogs,
	});
	assert.equal(Object.hasOwn(params, "tags"), false);
	assert.equal(Object.hasOwn(params, "extraLogFiles"), false);
}

assert.deepEqual(codexFeedbackUploadParams({
	classification: "other",
	threadId,
	includeLogs: false,
}), {
	classification: "other",
	reason: null,
	threadId,
	includeLogs: false,
});
assert.throws(
	() => codexFeedbackUploadParams({ classification: "bug", threadId, includeLogs: "yes" }),
	(error) => error.code === "CODEX_INVALID_FEEDBACK_LOG_CONSENT",
);
assert.throws(
	() => codexFeedbackUploadParams({ classification: "bug", threadId: "bad", includeLogs: false }),
	(error) => error.code === "CODEX_INVALID_THREAD_ID",
);

const privateUpstreamError = new Error("feedback failed: private note");
privateUpstreamError.code = "PROCESS_TREE_TERMINATION_FAILED";
const safeFeedbackError = sanitizeCodexFeedbackOperationError(privateUpstreamError);
assert.equal(safeFeedbackError.message, "Codex feedback operation failed");
assert.equal(safeFeedbackError.code, "PROCESS_TREE_TERMINATION_FAILED");
assert.equal(safeFeedbackError.cause, privateUpstreamError);
assert.doesNotMatch(safeFeedbackError.message, /private note/);

console.log("codex native UI helpers: desktop handoff and feedback safety");
