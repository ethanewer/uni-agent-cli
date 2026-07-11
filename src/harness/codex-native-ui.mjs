import path from "node:path";

const CODEX_THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CODEX_DESKTOP_LAUNCH_TIMEOUT_MS = 5_000;
export const CODEX_FEEDBACK_NOTE_MAX_LENGTH = 4_000;

export const CODEX_FEEDBACK_CATEGORIES = Object.freeze([
	Object.freeze({
		classification: "bug",
		commandValue: "bug",
		label: "bug",
		description: "Crash, error message, hang, or broken UI/behavior.",
	}),
	Object.freeze({
		classification: "bad_result",
		commandValue: "bad-result",
		label: "bad result",
		description: "Output was off-target, incorrect, incomplete, or unhelpful.",
	}),
	Object.freeze({
		classification: "good_result",
		commandValue: "good-result",
		label: "good result",
		description: "Helpful, correct, high-quality, or delightful result worth celebrating.",
	}),
	Object.freeze({
		classification: "safety_check",
		commandValue: "safety-check",
		label: "safety check",
		description: "Benign usage blocked due to safety checks or refusals.",
	}),
	Object.freeze({
		classification: "other",
		commandValue: "other",
		label: "other",
		description: "Slowness, feature suggestion, UX feedback, or anything else.",
	}),
]);

const CODEX_FEEDBACK_CLASSIFICATION_SET = new Set(
	CODEX_FEEDBACK_CATEGORIES.map((category) => category.classification),
);

// Keep this script static. The generated, UUID-only deep link is supplied as a
// separate argv entry, so PowerShell never evaluates session data as source.
export const CODEX_WINDOWS_DESKTOP_LAUNCH_SCRIPT = String.raw`& {
    param([Parameter(Mandatory = $true)][string]$url)
    $ErrorActionPreference = 'Stop'

    $package = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue | Select-Object -First 1
    $installLocation = $package.InstallLocation
    if ([string]::IsNullOrWhiteSpace($installLocation)) {
        Write-Error 'Codex Desktop package is not installed'
        exit 1
    }

    $appDir = Join-Path $installLocation 'app'
    $exe = Join-Path $appDir 'Codex.exe'
    $app = Join-Path $appDir 'resources\app.asar'
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
        Write-Error "Codex Desktop executable not found at $exe"
        exit 1
    }
    if (-not (Test-Path -LiteralPath $app -PathType Leaf)) {
        Write-Error "Codex Desktop app bundle not found at $app"
        exit 1
    }

    Start-Process -FilePath $exe -WorkingDirectory $appDir -ArgumentList @('resources\app.asar', $url)
}`;

function codexNativeUiError(message, code) {
	const error = new Error(message);
	error.code = code;
	return error;
}

function canonicalCodexThreadId(value) {
	if (typeof value !== "string" || !CODEX_THREAD_ID_PATTERN.test(value)) {
		throw codexNativeUiError("Codex thread ID must be a canonical UUID", "CODEX_INVALID_THREAD_ID");
	}
	return value.toLowerCase();
}

export function codexDesktopThreadUrl(threadId) {
	return `codex://threads/${canonicalCodexThreadId(threadId)}`;
}

function windowsPowerShellPath(environment = process.env) {
	const systemRootEntry = Object.entries(environment ?? {}).find(([name]) => name.toLowerCase() === "systemroot");
	const systemRoot = typeof systemRootEntry?.[1] === "string" && path.win32.isAbsolute(systemRootEntry[1])
		? path.win32.normalize(systemRootEntry[1])
		: "C:\\Windows";
	return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function codexDesktopLaunchSpec(threadId, platform = process.platform, environment = process.env) {
	const url = codexDesktopThreadUrl(threadId);
	if (platform === "darwin") {
		// Use the operating-system launcher by absolute path. A repository-local
		// executable named `open` must never be able to intercept a thread URL.
		return { platform, url, command: "/usr/bin/open", args: [url] };
	}
	if (platform === "win32") {
		return {
			platform,
			url,
			// Windows searches the current directory before PATH for bare executable
			// names. Resolve the inbox PowerShell directly so an untrusted checkout
			// cannot provide a shadow launcher.
			command: windowsPowerShellPath(environment),
			args: [
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				CODEX_WINDOWS_DESKTOP_LAUNCH_SCRIPT,
				url,
			],
		};
	}
	throw codexNativeUiError(
		"Codex Desktop handoff is supported only on macOS and Windows",
		"CODEX_DESKTOP_UNSUPPORTED_PLATFORM",
	);
}

export async function launchCodexDesktopThread(threadId, options = {}) {
	// Resolve the spec before checking the runner. Unsupported platforms and bad
	// IDs therefore fail without requiring or invoking any process primitive.
	const spec = codexDesktopLaunchSpec(
		threadId,
		options.platform ?? process.platform,
		options.environment ?? process.env,
	);
	const runCaptureImpl = options.runCaptureImpl;
	if (typeof runCaptureImpl !== "function") {
		throw codexNativeUiError(
			"A process runner is required to open Codex Desktop",
			"CODEX_DESKTOP_RUNNER_REQUIRED",
		);
	}
	const captureOptions = {
		timeoutMs: options.timeoutMs ?? CODEX_DESKTOP_LAUNCH_TIMEOUT_MS,
		maxStdoutBytes: options.maxStdoutBytes ?? 4 * 1024,
		maxStderrBytes: options.maxStderrBytes ?? 64 * 1024,
		rejectOnExit: true,
		...(options.processTracker ? { processTracker: options.processTracker } : {}),
	};
	const result = await runCaptureImpl(spec.command, spec.args, captureOptions);
	return { url: spec.url, result };
}

export function normalizeCodexFeedbackClassification(value) {
	if (typeof value !== "string") {
		throw codexNativeUiError(
			"Feedback classification must be one of bug, bad-result, good-result, safety-check, or other",
			"CODEX_INVALID_FEEDBACK_CLASSIFICATION",
		);
	}
	const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
	if (!CODEX_FEEDBACK_CLASSIFICATION_SET.has(normalized)) {
		throw codexNativeUiError(
			"Feedback classification must be one of bug, bad-result, good-result, safety-check, or other",
			"CODEX_INVALID_FEEDBACK_CLASSIFICATION",
		);
	}
	return normalized;
}

export function normalizeCodexFeedbackNote(value) {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || value.includes("\0")) {
		throw codexNativeUiError(
			"Feedback notes must be text without NUL bytes",
			"CODEX_INVALID_FEEDBACK_NOTE",
		);
	}
	const note = value.trim();
	if (!note) return null;
	if (note.length > CODEX_FEEDBACK_NOTE_MAX_LENGTH) {
		throw codexNativeUiError(
			`Feedback notes must be at most ${CODEX_FEEDBACK_NOTE_MAX_LENGTH} characters`,
			"CODEX_FEEDBACK_NOTE_TOO_LONG",
		);
	}
	return note;
}

export function parseCodexFeedbackArgument(argument = "") {
	if (typeof argument !== "string" || argument.includes("\0")) {
		throw codexNativeUiError("Feedback arguments must be text without NUL bytes", "CODEX_INVALID_FEEDBACK_ARGUMENT");
	}
	const trimmed = argument.trim();
	if (!trimmed) return undefined;
	const separator = trimmed.search(/\s/);
	const category = separator < 0 ? trimmed : trimmed.slice(0, separator);
	const note = separator < 0 ? null : trimmed.slice(separator + 1);
	return {
		classification: normalizeCodexFeedbackClassification(category),
		reason: normalizeCodexFeedbackNote(note),
	};
}

export function codexFeedbackUploadParams(options = {}) {
	if (typeof options.includeLogs !== "boolean") {
		throw codexNativeUiError("Feedback log consent must be a boolean", "CODEX_INVALID_FEEDBACK_LOG_CONSENT");
	}
	return {
		classification: normalizeCodexFeedbackClassification(options.classification),
		reason: normalizeCodexFeedbackNote(options.reason),
		threadId: canonicalCodexThreadId(options.threadId),
		includeLogs: options.includeLogs,
	};
}

export function sanitizeCodexFeedbackOperationError(error) {
	const safe = new Error("Codex feedback operation failed");
	if (error && Object.hasOwn(error, "code")) safe.code = error.code;
	// Preserve the original for programmatic diagnostics without ever promoting
	// its potentially reason-echoing message into the shared process-fence text.
	safe.cause = error;
	return safe;
}
