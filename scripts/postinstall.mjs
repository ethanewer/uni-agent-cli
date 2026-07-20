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

function pinnedRuntimeDependency(packageName) {
	return readJson(path.join(PACKAGE_ROOT, "package.json"))?.dependencies?.[packageName];
}

function packageDirectory(nodeModules, packageName) {
	return path.join(nodeModules, ...packageName.split("/"));
}

// Project-local and npx installs hoist cc's dependencies into an ancestor
// node_modules instead of nesting them under the package, so verification must
// mirror Node's ancestor traversal before declaring a component missing.
function hoistedPackageDirectory(nodeModules, packageName) {
	let directory = path.dirname(nodeModules);
	for (;;) {
		const parent = path.dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
		if (path.basename(directory) === "node_modules") continue;
		const candidate = packageDirectory(path.join(directory, "node_modules"), packageName);
		if (readJson(path.join(candidate, "package.json"))) return candidate;
	}
}

function resolvePackageDirectory(nodeModules, packageName) {
	const local = packageDirectory(nodeModules, packageName);
	if (readJson(path.join(local, "package.json"))) return local;
	return hoistedPackageDirectory(nodeModules, packageName);
}

function installedDependencyDirectory(nodeModules, packageName, owners = []) {
	// Prefer the dependency resolved from cc itself. Some adapters pin an older
	// copy of a package that cc also uses directly; choosing the adapter's nested
	// SDK and cc's hoisted native payload can otherwise manufacture a version
	// mismatch even though npm installed both complete dependency trees.
	const direct = packageDirectory(nodeModules, packageName);
	if (readJson(path.join(direct, "package.json"))) return direct;
	const hoisted = hoistedPackageDirectory(nodeModules, packageName);
	if (hoisted) return hoisted;
	return owners
		.filter(Boolean)
		.map((owner) => dependencyDirectoryFromOwner(owner, packageName))
		.find((candidate) => candidate && Boolean(readJson(path.join(candidate, "package.json"))));
}

function dependencyDirectoryFromOwner(owner, packageName) {
	let cursor = path.resolve(owner);
	for (;;) {
		const candidate = packageDirectory(path.join(cursor, "node_modules"), packageName);
		if (readJson(path.join(candidate, "package.json"))) return candidate;
		const parent = path.dirname(cursor);
		if (parent === cursor) return undefined;
		cursor = parent;
	}
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
			nativeFailure("claude-acp", "@anthropic-ai/claude-agent-sdk", names.error),
			nativeFailure("codex", "@openai/codex", names.error),
		];
	}
	const claudeAdapter = resolvePackageDirectory(nodeModules, BUNDLED_ACP_ADAPTERS.claude.packageName);
	const codexAdapter = resolvePackageDirectory(nodeModules, BUNDLED_ACP_ADAPTERS.codex.packageName);
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
		const expectedVersion = pinnedRuntimeDependency("@anthropic-ai/claude-agent-sdk");
		if (manifest?.name !== "@anthropic-ai/claude-agent-sdk" || manifest?.version !== expectedVersion) {
			results.push(nativeFailure("claude", names.claude, `Claude Agent SDK identity/version mismatch (expected @anthropic-ai/claude-agent-sdk@${expectedVersion}, found ${manifest?.name ?? "unknown"}@${manifest?.version ?? "unknown"})`));
		} else if (!Object.hasOwn(manifest?.optionalDependencies ?? {}, names.claude)) {
			results.push(nativeFailure("claude", names.claude, "the Claude Agent SDK does not declare this platform payload"));
		} else {
			const packageDir = dependencyDirectoryFromOwner(claudeSdk, names.claude)
				?? installedDependencyDirectory(nodeModules, names.claude);
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

	// The bundled Claude ACP adapter pins its own Agent SDK patch release. npm
	// keeps that SDK/native pair nested when cc's direct bridge uses a newer SDK;
	// verify the exact tree the adapter will resolve, not only cc's direct tree.
	const claudeAdapterManifest = claudeAdapter && readJson(path.join(claudeAdapter, "package.json"));
	const adapterSdkVersion = claudeAdapterManifest?.dependencies?.["@anthropic-ai/claude-agent-sdk"];
	const nestedAdapterSdk = claudeAdapter && packageDirectory(path.join(claudeAdapter, "node_modules"), "@anthropic-ai/claude-agent-sdk");
	const nestedAdapterManifest = nestedAdapterSdk && readJson(path.join(nestedAdapterSdk, "package.json"));
	const adapterSdk = nestedAdapterManifest ? nestedAdapterSdk
		: claudeSdk && readJson(path.join(claudeSdk, "package.json"))?.version === adapterSdkVersion ? claudeSdk : undefined;
	if (!adapterSdk || typeof adapterSdkVersion !== "string") {
		results.push(nativeFailure("claude-acp", names.claude, "the Claude ACP adapter's pinned Agent SDK is missing"));
	} else {
		const manifest = readJson(path.join(adapterSdk, "package.json"));
		if (manifest?.name !== "@anthropic-ai/claude-agent-sdk" || manifest?.version !== adapterSdkVersion) {
			results.push(nativeFailure("claude-acp", names.claude, `Claude ACP Agent SDK identity/version mismatch (expected @anthropic-ai/claude-agent-sdk@${adapterSdkVersion}, found ${manifest?.name ?? "unknown"}@${manifest?.version ?? "unknown"})`));
		} else if (!Object.hasOwn(manifest?.optionalDependencies ?? {}, names.claude)) {
			results.push(nativeFailure("claude-acp", names.claude, "the Claude ACP Agent SDK does not declare this platform payload"));
		} else {
			const packageDir = dependencyDirectoryFromOwner(adapterSdk, names.claude)
				?? installedDependencyDirectory(nodeModules, names.claude);
			const mismatch = nativePackageMismatch(packageDir, names.claude, manifest.optionalDependencies[names.claude]);
			const binary = packageDir && path.join(packageDir, names.platform === "win32" ? "claude.exe" : "claude");
			results.push(!mismatch && binary && executableFile(binary, names.platform)
				? { key: "claude-acp", kind: "native-payload", packageName: names.claude, ok: true, packageDir, binary }
				: nativeFailure("claude-acp", names.claude, mismatch ?? "optional native package or executable is missing"));
		}
	}

	if (!codexCli) {
		results.push(nativeFailure("codex", names.codex, "@openai/codex is missing"));
	} else {
		const manifest = readJson(path.join(codexCli, "package.json"));
		const expectedVersion = pinnedRuntimeDependency("@openai/codex");
		if (manifest?.name !== "@openai/codex" || manifest?.version !== expectedVersion) {
			results.push(nativeFailure("codex", names.codex, `Codex CLI identity/version mismatch (expected @openai/codex@${expectedVersion}, found ${manifest?.name ?? "unknown"}@${manifest?.version ?? "unknown"})`));
		} else if (!Object.hasOwn(manifest?.optionalDependencies ?? {}, names.codex)) {
			results.push(nativeFailure("codex", names.codex, "the Codex CLI does not declare this platform payload"));
		} else {
			const packageDir = dependencyDirectoryFromOwner(codexCli, names.codex)
				?? installedDependencyDirectory(nodeModules, names.codex);
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
	const packageDir = resolvePackageDirectory(nodeModules, adapter.packageName)
		?? packageDirectory(nodeModules, adapter.packageName);
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
			? "Re-run the exact original tarball or local-channel install command with `--include=optional`; this private package is not installed from public npm. "
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
