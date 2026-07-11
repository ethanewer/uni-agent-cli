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
	const results = inspectLocalAdapters(options.nodeModules, options.adapters);
	const failed = results.filter((result) => !result.ok);
	if (failed.length > 0 && options.report !== false) {
		const details = failed
			.map((result) => `  - ${result.packageName}@${result.version}: ${result.reason}`)
			.join("\n");
		console.warn(
			`cc: this installation is missing a pinned package-local ACP adapter:\n${details}\n` +
			"Reinstall cc with npm. No global packages were changed.",
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
