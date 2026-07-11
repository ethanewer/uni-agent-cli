#!/usr/bin/env node
// Best-effort installer for the ACP adapter binaries that `cc` talks to.
//
// Runs after `npm install -g github:ethanewer/uni-agent-cli`. It only acts on a
// GLOBAL install, never hard-fails the parent install, and skips anything that
// is already present. Set CC_SKIP_ADAPTER_INSTALL=1 (or CI=1) to disable.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ADAPTERS = [
	{ bin: "claude-agent-acp", pkg: "@agentclientprotocol/claude-agent-acp", label: "Claude Code ACP" },
	{
		bin: "codex-acp",
		pkg: "@agentclientprotocol/codex-acp",
		label: "Codex ACP",
		versionMarker: "@agentclientprotocol/codex-acp",
		minVersion: "1.1.2",
		replaces: "@zed-industries/codex-acp",
	},
];

function isGlobalInstall() {
	// npm sets npm_config_global=true for `npm i -g`. When run by hand we also
	// proceed so `npm run postinstall` works for manual setup.
	if (process.env.npm_config_global === "true") return true;
	if (process.env.npm_config_global === "false") return false;
	return process.env.CC_FORCE_ADAPTER_INSTALL === "1";
}

function disabled() {
	return (
		process.env.CC_SKIP_ADAPTER_INSTALL === "1" ||
		process.env.CI === "true" ||
		process.env.CI === "1" ||
		process.env.npm_config_ignore_scripts === "true"
	);
}

function environmentValue(env, name, platform = process.platform) {
	const direct = env?.[name];
	if (direct !== undefined || platform !== "win32") return direct;
	const key = Object.keys(env ?? {}).find((entry) => entry.toLowerCase() === name.toLowerCase());
	return key ? env[key] : undefined;
}

export function findOnPath(bin, env = process.env, platform = process.platform) {
	return findAllOnPath(bin, env, platform)[0];
}

export function findAllOnPath(bin, env = process.env, platform = process.platform) {
	const dirs = (environmentValue(env, "PATH", platform) ?? "").split(platform === "win32" ? ";" : ":");
	// Keep this in the same order as cc's runtime resolver. In particular, an
	// .exe shadows an npm .cmd shim on Windows, so validating the shim first could
	// bless a different adapter than the one cc will actually launch.
	const exts = platform === "win32" && !path.extname(bin) ? [".exe", ".cmd", ".bat", ""] : [""];
	const matches = [];
	for (const dir of dirs) {
		if (!dir) continue;
		for (const ext of exts) {
			try {
				const candidate = path.join(dir, `${bin}${ext}`);
				fs.accessSync(candidate, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
				if (fs.statSync(candidate).isFile() && !matches.includes(candidate)) matches.push(candidate);
			} catch {}
		}
	}
	return matches;
}

function npmInvocation() {
	const npmOnPath = findOnPath("npm");
	const candidates = [
		environmentValue(process.env, "npm_execpath"),
		path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
		path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
		npmOnPath && path.join(path.dirname(npmOnPath), "node_modules", "npm", "bin", "npm-cli.js"),
	];
	for (const candidate of candidates) {
		if (typeof candidate !== "string" || !/\.(?:c?js|mjs)$/i.test(candidate)) continue;
		try {
			if (fs.statSync(candidate).isFile()) return { command: process.execPath, args: [candidate] };
		} catch {}
	}
	if (!npmOnPath) return undefined;
	if (process.platform !== "win32") return { command: npmOnPath, args: [] };
	// This is a fixed, trusted npm shim and fixed argument set. Do not use
	// shell:true: invoke the Windows command processor explicitly so arbitrary
	// adapter-provided text can never become a command line.
	const comspec = environmentValue(process.env, "ComSpec") || "cmd.exe";
	return { command: comspec, args: ["/d", "/s", "/c", npmOnPath] };
}

function spawnNpm(args, options = {}) {
	const invocation = npmInvocation();
	if (!invocation) return { status: null, error: new Error("npm executable not found") };
	return spawnSync(invocation.command, [...invocation.args, ...args], options);
}

function installGlobally(pkg) {
	const result = spawnNpm(["install", "-g", pkg], {
		stdio: "inherit",
		timeout: 5 * 60 * 1000,
	});
	return result.status === 0;
}

function uninstallGlobally(pkg) {
	const result = spawnNpm(["uninstall", "-g", pkg], {
		stdio: "inherit",
		timeout: 5 * 60 * 1000,
	});
	return result.status === 0;
}

function isGlobalPackageInstalled(pkg) {
	const result = spawnNpm(["list", "-g", "--depth=0", pkg, "--json"], {
		stdio: "ignore",
		timeout: 30_000,
	});
	return result.status === 0;
}

function npmGlobalPath(args) {
	const result = spawnNpm(args, { encoding: "utf8", timeout: 30_000 });
	if (result.status !== 0) return undefined;
	return result.stdout?.trim() || undefined;
}

function capturePath(file) {
	try {
		const stat = fs.lstatSync(file);
		if (stat.isSymbolicLink()) return { file, kind: "symlink", target: fs.readlinkSync(file) };
		if (stat.isFile()) return { file, kind: "file", data: fs.readFileSync(file), mode: stat.mode };
	} catch {}
	return undefined;
}

function backupGlobalPackage(pkg, bin) {
	const root = npmGlobalPath(["root", "-g"]);
	const prefix = npmGlobalPath(["prefix", "-g"]);
	if (!root || !prefix) return undefined;
	const packageNames = Array.isArray(pkg) ? pkg : [pkg];
	const packageDirs = packageNames
		.map((name) => ({ name, packageDir: path.join(root, ...name.split("/")) }))
		.filter(({ packageDir }) => fs.existsSync(packageDir));
	if (packageDirs.length === 0) return undefined;
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-adapter-backup-"));
	try {
		const packages = packageDirs.map(({ name, packageDir }, index) => {
			const packageBackup = path.join(tempDir, `package-${index}`);
			fs.cpSync(packageDir, packageBackup, { recursive: true, dereference: false, preserveTimestamps: true });
			return { name, packageDir, packageBackup };
		});
		const shimPaths = process.platform === "win32"
			? [path.join(prefix, bin), path.join(prefix, `${bin}.cmd`), path.join(prefix, `${bin}.ps1`)]
			: [path.join(prefix, "bin", bin)];
		return {
			tempDir,
			packages,
			shims: shimPaths.map(capturePath).filter(Boolean),
		};
	} catch {
		fs.rmSync(tempDir, { recursive: true, force: true });
		return undefined;
	}
}

function restoreGlobalPackage(snapshot) {
	try {
		const packages = snapshot.packages ?? [{ packageDir: snapshot.packageDir, packageBackup: snapshot.packageBackup }];
		for (const entry of packages) {
			fs.rmSync(entry.packageDir, { recursive: true, force: true });
			fs.mkdirSync(path.dirname(entry.packageDir), { recursive: true });
			fs.cpSync(entry.packageBackup, entry.packageDir, { recursive: true, dereference: false, preserveTimestamps: true });
		}
		return restoreGlobalPackageShims(snapshot);
	} catch {
		return false;
	}
}

function restoreGlobalPackageShims(snapshot) {
	try {
		for (const shim of snapshot.shims ?? []) {
			fs.rmSync(shim.file, { force: true });
			fs.mkdirSync(path.dirname(shim.file), { recursive: true });
			if (shim.kind === "symlink") fs.symlinkSync(shim.target, shim.file);
			else {
				fs.writeFileSync(shim.file, shim.data, { mode: shim.mode });
				fs.chmodSync(shim.file, shim.mode);
			}
		}
		return true;
	} catch {
		return false;
	}
}

function discardGlobalPackageBackup(snapshot) {
	if (snapshot?.tempDir) fs.rmSync(snapshot.tempDir, { recursive: true, force: true });
}

function pathIsInside(child, parent) {
	if (!child || !parent) return false;
	const relative = path.relative(path.resolve(parent), path.resolve(child));
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

// `isCurrentAdapter()` intentionally applies cc's runtime PATH selection, which
// skips incompatible adapters. Migration also needs a narrower fact: did the
// shim captured from npm's *current* prefix belong to the maintained package in
// that same prefix? Otherwise a compatible entry elsewhere on PATH can make a
// legacy local shim look current and we would restore it after uninstalling its
// owner.
export function snapshotShimOwnedByPackage(snapshot, pkg, bin) {
	const packageEntry = snapshot?.packages?.find((entry) => entry?.name === pkg);
	if (!packageEntry?.packageDir) return false;
	const shims = snapshot?.shims ?? [];
	const shim = process.platform === "win32"
		? shims.find((entry) => entry.file.toLowerCase().endsWith(`${bin}.cmd`.toLowerCase())) ??
			shims.find((entry) => path.basename(entry.file).toLowerCase() === bin.toLowerCase())
		: shims.find((entry) => path.basename(entry.file) === bin);
	if (!shim) return false;
	let target;
	try {
		if (shim.kind === "symlink") target = path.resolve(path.dirname(shim.file), shim.target);
		else if (process.platform === "win32" && path.extname(shim.file).toLowerCase() === ".cmd") {
			target = windowsNodeShimEntrypoint(shim.file);
		} else {
			target = fs.realpathSync(shim.file);
		}
	} catch {
		return false;
	}
	return pathIsInside(target, packageEntry.packageDir);
}

export function installAdapter(adapter, operations = {}) {
	const packageInstalled = operations.isGlobalPackageInstalled ?? isGlobalPackageInstalled;
	const install = operations.installGlobally ?? installGlobally;
	const uninstall = operations.uninstallGlobally ?? uninstallGlobally;
	const backup = operations.backupGlobalPackage ?? backupGlobalPackage;
	const restore = operations.restoreGlobalPackage ?? restoreGlobalPackage;
	const restoreShims = operations.restoreGlobalPackageShims ?? restoreGlobalPackageShims;
	const discard = operations.discardGlobalPackageBackup ?? discardGlobalPackageBackup;
	const verify = operations.isCurrentAdapter ?? isCurrentAdapter;
	const ownsSnapshotShim = operations.snapshotShimOwnedByPackage ?? snapshotShimOwnedByPackage;
	const replacingLegacy = Boolean(adapter.replaces && packageInstalled(adapter.replaces));
	const successorInstalled = packageInstalled(adapter.pkg);
	if (!replacingLegacy) {
		if (!successorInstalled) return install(adapter.pkg) && verify(adapter);
		const snapshot = backup(adapter.pkg, adapter.bin);
		if (!snapshot) return false;
		try {
			if (install(adapter.pkg) && verify(adapter)) return true;
			uninstall(adapter.pkg);
			restore(snapshot);
			return false;
		} finally {
			discard(snapshot);
		}
	}

	// Both packages can own the same bin. Snapshot every installed owner together
	// with the currently active shim so rollback always restores a consistent
	// package/shim set, including installations left conflicted by older cc builds.
	const packagesToBackup = successorInstalled ? [adapter.replaces, adapter.pkg] : [adapter.replaces];
	const snapshot = backup(packagesToBackup, adapter.bin);
	if (!snapshot) return false;
	const successorCurrent = successorInstalled && ownsSnapshotShim(snapshot, adapter.pkg, adapter.bin) && verify(adapter);
	try {
		if (!uninstall(adapter.replaces)) {
			restore(snapshot);
			return false;
		}
		// If the maintained adapter already owns the live, compatible shim, removing
		// the legacy package may unlink that shared shim. Restore the captured shim
		// locally; no registry access is needed just to clean up the extra owner.
		if (successorCurrent) {
			if (restoreShims(snapshot) && verify(adapter)) return true;
			restore(snapshot);
			return false;
		}
		if (install(adapter.pkg) && verify(adapter)) return true;
		// Remove any partial successor state before restoring the sole legacy owner.
		uninstall(adapter.pkg);
		restore(snapshot);
		return false;
	} finally {
		discard(snapshot);
	}
}

export function versionAtLeast(actual, minimum) {
	const parse = (value) => {
		const match = String(value ?? "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
		return match ? { parts: match.slice(1, 4).map(Number), prerelease: match[4] } : undefined;
	};
	const current = parse(actual);
	const required = parse(minimum);
	if (!current || !required) return false;
	for (let index = 0; index < 3; index += 1) {
		if (current.parts[index] !== required.parts[index]) return current.parts[index] > required.parts[index];
	}
	if (required.prerelease) return true;
	return !current.prerelease;
}

export function windowsNodeShimEntrypoint(shimPath) {
	let content;
	try {
		content = fs.readFileSync(shimPath, "utf8");
	} catch {
		return undefined;
	}
	if (content.length > 64 * 1024 || content.includes("\0")) return undefined;
	const match = content.match(/(?:%~dp0|%dp0%)\\([^"\r\n]+?\.(?:cjs|mjs|js))(?=["\s])/i);
	const relative = match?.[1];
	if (!relative || relative.includes("%")) return undefined;
	const entrypoint = path.resolve(path.dirname(shimPath), relative.replaceAll("\\", path.sep));
	try {
		return fs.statSync(entrypoint).isFile() ? entrypoint : undefined;
	} catch {
		return undefined;
	}
}

function readNodePackage(packageRoot) {
	try {
		const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
		return metadata && typeof metadata === "object" ? metadata : undefined;
	} catch {
		return undefined;
	}
}

function executableBelongsToPackage(executable, packageRoot) {
	const isInside = (candidate) => pathIsInside(candidate, packageRoot);
	try {
		if (isInside(fs.realpathSync(executable))) return true;
	} catch {}
	if (path.extname(executable).toLowerCase() !== ".cmd") return false;
	return isInside(windowsNodeShimEntrypoint(executable));
}

function findNodePackageRootFromBin(executable, packageName) {
	if (!executable || !packageName) return undefined;
	const candidates = [];
	const addCandidate = (candidate) => {
		if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
	};
	try {
		let current = path.dirname(fs.realpathSync(executable));
		while (true) {
			addCandidate(current);
			const parent = path.dirname(current);
			if (parent === current) break;
			current = parent;
		}
	} catch {}
	const lexicalDir = path.dirname(path.resolve(executable));
	const packageSegments = packageName.split("/");
	if (path.basename(lexicalDir).toLowerCase() === ".bin") {
		addCandidate(path.join(path.dirname(lexicalDir), ...packageSegments));
	}
	addCandidate(path.join(lexicalDir, "node_modules", ...packageSegments));
	for (const candidate of candidates) {
		const metadata = readNodePackage(candidate);
		if (metadata?.name === packageName && executableBelongsToPackage(executable, candidate)) return candidate;
	}
	return undefined;
}

export function compatibleAdapterOnPath(adapter, env = process.env, platform = process.platform) {
	for (const executable of findAllOnPath(adapter.bin, env, platform)) {
		const packageRoot = findNodePackageRootFromBin(executable, adapter.pkg);
		const metadata = packageRoot && readNodePackage(packageRoot);
		if (!metadata || metadata.name !== adapter.pkg) continue;
		if (adapter.minVersion && !versionAtLeast(metadata.version, adapter.minVersion)) continue;
		return executable;
	}
	return undefined;
}

export function isCurrentAdapter(adapter, env = process.env, platform = process.platform) {
	// Codex runtime deliberately scans past stale/legacy same-name shims to find a
	// maintained, protocol-compatible package. Verify that exact package identity
	// and package version here instead of trusting a shadowing binary's output.
	if (adapter.versionMarker || adapter.minVersion) {
		return Boolean(compatibleAdapterOnPath(adapter, env, platform));
	}
	return Boolean(findOnPath(adapter.bin, env, platform));
}

export function adapterNeedsInstall(adapter, operations = {}) {
	const verify = operations.isCurrentAdapter ?? isCurrentAdapter;
	const packageInstalled = operations.isGlobalPackageInstalled ?? isGlobalPackageInstalled;
	return !verify(adapter) || Boolean(adapter.replaces && packageInstalled(adapter.replaces));
}

function main() {
	if (disabled()) return;
	if (!isGlobalInstall()) return;

	// A binary with the right name is not necessarily the right adapter. In
	// particular, migrate the deprecated @zed-industries/codex-acp package, which
	// embeds an old Codex core and cannot use newer models.
	const missing = ADAPTERS.filter((adapter) => adapterNeedsInstall(adapter));
	if (missing.length === 0) {
		report([]);
		return;
	}

	console.log("\ncc: installing ACP adapters so the agents work out of the box…");
	const failed = [];
	for (const adapter of missing) {
		console.log(`  • ${adapter.label} (${adapter.pkg})`);
		// npm can install into a different global prefix than the first matching
		// binary on PATH (for example after switching Node installations). Do not
		// report success unless the binary cc will actually spawn is the one we
		// just installed.
		const ok = installAdapter(adapter);
		if (!ok) failed.push(adapter);
	}
	report(failed);
}

function report(failed) {
	const lines = ["", "cc is installed. Quick start:", "  cc            # default agent (codex)", "  cc claude     # Claude Code", "  cc cursor     # Cursor Agent", ""];
	if (failed.length > 0) {
		lines.push("Some ACP adapters could not be installed or verified automatically:");
		for (const adapter of failed) lines.push(...adapterFailureInstructions(adapter));
		lines.push("");
	}
	lines.push("Optional backends: install `cursor-agent` for Cursor, and set OPENAI_API_KEY for voice input.");
	lines.push("Run `cc` to get started; use `/doctor` inside cc for Codex diagnostics.");
	lines.push("");
	console.log(lines.join("\n"));
}

export function adapterFailureInstructions(adapter, options = {}) {
	const activePath = Object.hasOwn(options, "activePath") ? options.activePath : findOnPath(adapter.bin);
	const prefix = Object.hasOwn(options, "prefix") ? options.prefix : npmGlobalPath(["prefix", "-g"]);
	const activeCompatible = Object.hasOwn(options, "activeCompatible")
		? options.activeCompatible
		: Boolean(activePath && isCurrentAdapter(adapter));
	const platform = options.platform ?? process.platform;
	const expectedBinDir = prefix
		? platform === "win32" ? prefix : path.join(prefix, "bin")
		: undefined;
	const activeDir = activePath && path.dirname(activePath);
	const normalizedPath = (value) => platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
	const shadowed = Boolean(activeDir && expectedBinDir && normalizedPath(activeDir) !== normalizedPath(expectedBinDir));
	if (activePath && !activeCompatible) {
		const locationAdvice = shadowed
			? `or move ${expectedBinDir} before ${activeDir} in PATH, then run: npm install -g ${adapter.pkg}`
			: `then run: npm install -g ${adapter.pkg}`;
		return [
			`  ${adapter.label}: PATH selects an incompatible adapter at ${activePath}`,
			...(shadowed ? [`    npm installs global binaries into ${expectedBinDir}.`] : []),
			`    Remove or update the package that owns the selected path, ${locationAdvice}`,
		];
	}
	return [`  npm install -g ${adapter.pkg}`];
}

try {
	main();
} catch (error) {
	// Never fail the install over a best-effort adapter bootstrap.
	console.log(`cc: skipped adapter bootstrap (${error?.message ?? error}). Run \`cc\`, then use \`/doctor\` later.`);
}
