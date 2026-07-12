#!/usr/bin/env node
// Current cc releases carry their ACP adapters as exact, package-local runtime
// dependencies. Postinstall deliberately performs no global npm operations:
// global adapter migration created competing bin owners and made an unrelated
// package uninstall capable of breaking cc. This script only verifies that npm
// materialized the package-local dependencies declared by this release.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { BUNDLED_ACP_ADAPTERS } from "../src/harness/bundled-adapters.mjs";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_NODE_MODULES = path.join(PACKAGE_ROOT, "node_modules");

export const REQUIRED_LOCAL_ADAPTERS = Object.freeze(
	Object.entries(BUNDLED_ACP_ADAPTERS).map(([key, adapter]) => Object.freeze({
		key,
		packageName: adapter.packageName,
		version: adapter.version,
		bin: adapter.bin,
	})),
);

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

function packageDirectory(nodeModules, packageName) {
	return path.join(nodeModules, ...packageName.split("/"));
}

function installedDependencyDirectory(nodeModules, packageName, owners = []) {
	const candidates = [
		packageDirectory(nodeModules, packageName),
		...owners.filter(Boolean).map((owner) => packageDirectory(path.join(owner, "node_modules"), packageName)),
	];
	return candidates.find((candidate) => Boolean(readJson(path.join(candidate, "package.json"))));
}

function nativePlatformPackageNames(options = {}) {
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	if (!["x64", "arm64"].includes(arch) || !["darwin", "linux", "win32"].includes(platform)) {
		return { error: `unsupported native backend platform ${platform}-${arch}` };
	}
	let libc = options.libc;
	if (platform === "linux" && !libc) {
		libc = process.report?.getReport?.()?.header?.glibcVersionRuntime ? "glibc" : "musl";
	}
	const claudeSuffix = platform === "linux" && libc === "musl"
		? `${platform}-${arch}-musl`
		: `${platform}-${arch}`;
	return {
		platform,
		claude: `@anthropic-ai/claude-agent-sdk-${claudeSuffix}`,
		codex: `@openai/codex-${platform}-${arch}`,
	};
}

function nativeFailure(key, packageName, reason) {
	return { key, kind: "native-payload", packageName, ok: false, reason };
}

function executableFile(file, platform) {
	try {
		if (!fs.statSync(file).isFile()) return false;
		fs.accessSync(file, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function expectedOptionalPackage(aliasName, specification) {
	if (typeof specification !== "string" || !specification.trim()) return undefined;
	if (!specification.startsWith("npm:")) return { name: aliasName, version: specification };
	const target = specification.slice(4);
	const separator = target.lastIndexOf("@");
	if (separator <= 0 || separator === target.length - 1) return undefined;
	return { name: target.slice(0, separator), version: target.slice(separator + 1) };
}

function nativePackageMismatch(packageDir, aliasName, specification) {
	const expected = expectedOptionalPackage(aliasName, specification);
	const manifest = packageDir && readJson(path.join(packageDir, "package.json"));
	if (!expected) return `the parent package declares an unsupported optional dependency specifier: ${specification}`;
	if (!manifest) return "optional native package is missing or has no readable manifest";
	if (manifest.name !== expected.name || manifest.version !== expected.version) {
		return `optional native package identity/version mismatch (expected ${expected.name}@${expected.version}, found ${manifest.name ?? "unknown"}@${manifest.version ?? "unknown"})`;
	}
	return undefined;
}

/** Verify the optional platform packages required by the pinned JS adapters. */
export function inspectLocalNativePayloads(nodeModules = LOCAL_NODE_MODULES, options = {}) {
	const names = nativePlatformPackageNames(options);
	if (names.error) {
		return [
			nativeFailure("claude", "@anthropic-ai/claude-agent-sdk", names.error),
			nativeFailure("codex", "@openai/codex", names.error),
		];
	}
	const claudeAdapter = packageDirectory(nodeModules, BUNDLED_ACP_ADAPTERS.claude.packageName);
	const codexAdapter = packageDirectory(nodeModules, BUNDLED_ACP_ADAPTERS.codex.packageName);
	const claudeSdk = installedDependencyDirectory(
		nodeModules,
		"@anthropic-ai/claude-agent-sdk",
		[claudeAdapter],
	);
	const codexCli = installedDependencyDirectory(nodeModules, "@openai/codex", [codexAdapter]);
	const results = [];

	if (!claudeSdk) {
		results.push(nativeFailure("claude", names.claude, "@anthropic-ai/claude-agent-sdk is missing"));
	} else {
		const manifest = readJson(path.join(claudeSdk, "package.json"));
		if (!Object.hasOwn(manifest?.optionalDependencies ?? {}, names.claude)) {
			results.push(nativeFailure("claude", names.claude, "the Claude Agent SDK does not declare this platform payload"));
		} else {
			const packageDir = installedDependencyDirectory(nodeModules, names.claude, [claudeSdk]);
			const mismatch = nativePackageMismatch(
				packageDir,
				names.claude,
				manifest.optionalDependencies[names.claude],
			);
			const binary = packageDir && path.join(packageDir, names.platform === "win32" ? "claude.exe" : "claude");
			results.push(!mismatch && binary && executableFile(binary, names.platform)
				? { key: "claude", kind: "native-payload", packageName: names.claude, ok: true, packageDir, binary }
				: nativeFailure("claude", names.claude, mismatch ?? "optional native package or executable is missing"));
		}
	}

	if (!codexCli) {
		results.push(nativeFailure("codex", names.codex, "@openai/codex is missing"));
	} else {
		const manifest = readJson(path.join(codexCli, "package.json"));
		if (!Object.hasOwn(manifest?.optionalDependencies ?? {}, names.codex)) {
			results.push(nativeFailure("codex", names.codex, "the Codex CLI does not declare this platform payload"));
		} else {
			const packageDir = installedDependencyDirectory(nodeModules, names.codex, [codexCli]);
			const mismatch = nativePackageMismatch(
				packageDir,
				names.codex,
				manifest.optionalDependencies[names.codex],
			);
			let binary;
			try {
				if (mismatch) throw new Error(mismatch);
				const vendor = packageDir && path.join(packageDir, "vendor");
				const binaryName = names.platform === "win32" ? "codex.exe" : "codex";
				binary = fs.readdirSync(vendor, { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => path.join(vendor, entry.name, "bin", binaryName))
					.find((candidate) => executableFile(candidate, names.platform));
			} catch {}
			results.push(!mismatch && binary
				? { key: "codex", kind: "native-payload", packageName: names.codex, ok: true, packageDir, binary }
				: nativeFailure("codex", names.codex, mismatch ?? "optional native package or executable is missing"));
		}
	}
	return results;
}

/**
 * Verify package identity, exact version, and its declared binary entrypoint.
 * This function is read-only and accepts a node_modules root for tests and
 * channel-installer verification.
 */
export function inspectLocalAdapter(adapter, nodeModules = LOCAL_NODE_MODULES) {
	const packageDir = packageDirectory(nodeModules, adapter.packageName);
	const manifestPath = path.join(packageDir, "package.json");
	const manifest = readJson(manifestPath);
	if (!manifest) {
		return { ...adapter, ok: false, reason: "package is missing" };
	}
	if (manifest.name !== adapter.packageName) {
		return { ...adapter, ok: false, reason: `unexpected package identity ${String(manifest.name ?? "(missing)")}` };
	}
	if (manifest.version !== adapter.version) {
		return { ...adapter, ok: false, reason: `expected ${adapter.version}, found ${String(manifest.version ?? "(missing)")}` };
	}
	const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[adapter.bin];
	if (typeof entry !== "string" || !entry) {
		return { ...adapter, ok: false, reason: `package does not declare the ${adapter.bin} binary` };
	}
	const entrypoint = path.resolve(packageDir, entry);
	const relative = path.relative(packageDir, entrypoint);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		return { ...adapter, ok: false, reason: "binary entrypoint escapes its package" };
	}
	try {
		if (!fs.statSync(entrypoint).isFile()) throw new Error("not a file");
	} catch {
		return { ...adapter, ok: false, reason: `binary entrypoint is missing: ${entry}` };
	}
	return { ...adapter, ok: true, packageDir, entrypoint };
}

export function inspectLocalAdapters(
	nodeModules = LOCAL_NODE_MODULES,
	adapters = REQUIRED_LOCAL_ADAPTERS,
) {
	return adapters.map((adapter) => inspectLocalAdapter(adapter, nodeModules));
}

function disabled(env = process.env) {
	return env.CC_SKIP_ADAPTER_INSTALL === "1" || env.npm_config_ignore_scripts === "true";
}

export function verifyPostinstall(options = {}) {
	if (disabled(options.env)) return [];
	const environment = options.env ?? process.env;
	const nodeModules = options.nodeModules ?? LOCAL_NODE_MODULES;
	const results = [
		...inspectLocalAdapters(nodeModules, options.adapters),
		...(options.inspectNative === false ? [] : inspectLocalNativePayloads(nodeModules, options.nativeOptions)),
	];
	const failed = results.filter((result) => !result.ok);
	if (failed.length > 0 && options.report !== false) {
		const details = failed
			.map((result) => `  - ${result.packageName}${result.version ? `@${result.version}` : ""}: ${result.reason}`)
			.join("\n");
		const globalValue = String(environment.npm_config_global ?? environment.NPM_CONFIG_GLOBAL ?? "").toLowerCase();
		const globalInstall = globalValue === "true" || globalValue === "1";
		const reinstall = globalInstall
			? "Re-run the original global cc install command with `--include=optional` (for a registry install, `npm install -g cc --include=optional`). "
			: "From the cc package/project directory, run `npm install --include=optional`, or re-run the original install command with that flag. ";
		console.warn(
			`cc: this installation is missing a required package-local ACP component:\n${details}\n` +
			reinstall +
			"If npm's omit config contains `optional`, remove it first. No global packages were changed.",
		);
	}
	return results;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
	try {
		verifyPostinstall();
	} catch (error) {
		// Dependency verification should not convert an otherwise recoverable npm
		// installation into a half-installed global package.
		console.warn(`cc: could not verify package-local ACP adapters (${error?.message ?? error}). Reinstall cc if startup fails.`);
	}
}
