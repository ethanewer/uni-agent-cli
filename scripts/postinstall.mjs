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

function onPath(bin) {
	const dirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
	const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
	for (const dir of dirs) {
		if (!dir) continue;
		for (const ext of exts) {
			try {
				if (fs.existsSync(path.join(dir, `${bin}${ext}`))) return true;
			} catch {}
		}
	}
	return false;
}

function installGlobally(pkg) {
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const result = spawnSync(npm, ["install", "-g", pkg], {
		stdio: "inherit",
		timeout: 5 * 60 * 1000,
	});
	return result.status === 0;
}

function uninstallGlobally(pkg) {
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const result = spawnSync(npm, ["uninstall", "-g", pkg], {
		stdio: "inherit",
		timeout: 5 * 60 * 1000,
	});
	return result.status === 0;
}

function isGlobalPackageInstalled(pkg) {
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const result = spawnSync(npm, ["list", "-g", "--depth=0", pkg, "--json"], {
		stdio: "ignore",
		timeout: 30_000,
	});
	return result.status === 0;
}

function npmGlobalPath(args) {
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const result = spawnSync(npm, args, { encoding: "utf8", timeout: 30_000 });
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
	const packageDir = path.join(root, ...pkg.split("/"));
	if (!fs.existsSync(packageDir)) return undefined;
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-adapter-backup-"));
	const packageBackup = path.join(tempDir, "package");
	try {
		fs.cpSync(packageDir, packageBackup, { recursive: true, dereference: false, preserveTimestamps: true });
		const shimPaths = process.platform === "win32"
			? [path.join(prefix, bin), path.join(prefix, `${bin}.cmd`), path.join(prefix, `${bin}.ps1`)]
			: [path.join(prefix, "bin", bin)];
		return {
			tempDir,
			packageDir,
			packageBackup,
			shims: shimPaths.map(capturePath).filter(Boolean),
		};
	} catch {
		fs.rmSync(tempDir, { recursive: true, force: true });
		return undefined;
	}
}

function restoreGlobalPackage(snapshot) {
	try {
		fs.rmSync(snapshot.packageDir, { recursive: true, force: true });
		fs.mkdirSync(path.dirname(snapshot.packageDir), { recursive: true });
		fs.cpSync(snapshot.packageBackup, snapshot.packageDir, { recursive: true, dereference: false, preserveTimestamps: true });
		for (const shim of snapshot.shims) {
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

export function installAdapter(adapter, operations = {}) {
	const packageInstalled = operations.isGlobalPackageInstalled ?? isGlobalPackageInstalled;
	const install = operations.installGlobally ?? installGlobally;
	const uninstall = operations.uninstallGlobally ?? uninstallGlobally;
	const backup = operations.backupGlobalPackage ?? backupGlobalPackage;
	const restore = operations.restoreGlobalPackage ?? restoreGlobalPackage;
	const discard = operations.discardGlobalPackageBackup ?? discardGlobalPackageBackup;
	const verify = operations.isCurrentAdapter ?? isCurrentAdapter;
	const replacingLegacy = Boolean(adapter.replaces && packageInstalled(adapter.replaces));
	if (!replacingLegacy) return install(adapter.pkg) && verify(adapter);

	// Both packages own the same bin, so a successful migration must uninstall the
	// old package. Snapshot it and its npm shims first; rollback is then local and
	// does not depend on the registry or npm cache.
	const snapshot = backup(adapter.replaces, adapter.bin);
	if (!snapshot) return false;
	try {
		if (!uninstall(adapter.replaces)) {
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

function isCurrentAdapter(adapter) {
	if (!onPath(adapter.bin)) return false;
	if (!adapter.versionMarker) return true;
	const result = spawnSync(adapter.bin, ["--version"], {
		encoding: "utf8",
		timeout: 5_000,
	});
	return result.status === 0 && `${result.stdout ?? ""}${result.stderr ?? ""}`.includes(adapter.versionMarker);
}

function main() {
	if (disabled()) return;
	if (!isGlobalInstall()) return;

	// A binary with the right name is not necessarily the right adapter. In
	// particular, migrate the deprecated @zed-industries/codex-acp package, which
	// embeds an old Codex core and cannot use newer models.
	const missing = ADAPTERS.filter((adapter) => !isCurrentAdapter(adapter));
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
		lines.push("Some ACP adapters could not be installed automatically. Install them with:");
		for (const adapter of failed) lines.push(`  npm install -g ${adapter.pkg}`);
		lines.push("");
	}
	lines.push("Optional backends: install `cursor-agent` for Cursor, and set OPENAI_API_KEY for voice input.");
	lines.push("Run `cc doctor` to check that everything is wired up.");
	lines.push("");
	console.log(lines.join("\n"));
}

try {
	main();
} catch (error) {
	// Never fail the install over a best-effort adapter bootstrap.
	console.log(`cc: skipped adapter bootstrap (${error?.message ?? error}). Run \`cc doctor\` later.`);
}
