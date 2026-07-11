import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	adapterFailureInstructions,
	adapterNeedsInstall,
	compatibleAdapterOnPath,
	findAllOnPath,
	findOnPath,
	installAdapter,
	isCurrentAdapter,
	snapshotShimOwnedByPackage,
	versionAtLeast,
	windowsNodeShimEntrypoint,
} from "../scripts/postinstall.mjs";

const adapter = {
	bin: "codex-acp",
	pkg: "@agentclientprotocol/codex-acp",
	label: "Codex ACP",
	versionMarker: "@agentclientprotocol/codex-acp",
	minVersion: "1.1.2",
	replaces: "@zed-industries/codex-acp",
};

// npm must generate a Node launcher on Windows. Pointing the bin at the legacy
// #!/bin/sh prepaint wrapper makes the generated .cmd depend on /bin/sh, which
// is absent on a stock Windows installation.
{
	const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(packageJson.bin.cc, "src/cc.mjs");
	const launcher = fs.readFileSync(new URL(`../${packageJson.bin.cc}`, import.meta.url), "utf8");
	assert.match(launcher.split(/\r?\n/, 1)[0], /^#!\/usr\/bin\/env node$/);
}

assert.equal(versionAtLeast("1.1.2", "1.1.2"), true);
assert.equal(versionAtLeast("1.2.0", "1.1.2"), true);
assert.equal(versionAtLeast("1.1.1", "1.1.2"), false);
assert.equal(versionAtLeast("1.1.2-beta.1", "1.1.2"), false);
assert.equal(versionAtLeast("unknown", "1.1.2"), false);
assert.equal(
	adapterNeedsInstall(adapter, { isCurrentAdapter: () => true, isGlobalPackageInstalled: (pkg) => pkg === adapter.replaces }),
	true,
);
assert.equal(adapterNeedsInstall(adapter, { isCurrentAdapter: () => true, isGlobalPackageInstalled: () => false }), false);

// Installer lookup must match runtime Windows precedence: an .exe shadows a
// same-name npm .cmd shim.
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-postinstall-path-"));
	try {
		const executable = path.join(root, "codex-acp.exe");
		fs.writeFileSync(executable, "native");
		fs.writeFileSync(path.join(root, "codex-acp.cmd"), "@echo off\r\n");
		assert.equal(findOnPath("codex-acp", { Path: root }, "win32"), executable);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// Match the runtime resolver: stale or legacy same-name binaries earlier on
// PATH must not hide a later maintained adapter with a compatible package
// version. Verification is based on npm package ownership, not claimed output.
if (process.platform !== "win32") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-postinstall-compatible-"));
	const makePrefix = (name, packageName, version) => {
		const prefix = path.join(root, name);
		const packageRoot = path.join(prefix, "lib", "node_modules", ...packageName.split("/"));
		const entrypoint = path.join(packageRoot, "dist", "index.js");
		const binDir = path.join(prefix, "bin");
		const shim = path.join(binDir, adapter.bin);
		fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
		fs.mkdirSync(binDir, { recursive: true });
		fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: packageName, version }));
		fs.writeFileSync(entrypoint, "#!/usr/bin/env node\n");
		fs.chmodSync(entrypoint, 0o755);
		fs.symlinkSync(path.relative(binDir, entrypoint), shim);
		return { binDir, shim };
	};
	try {
		const legacy = makePrefix("legacy", adapter.replaces, "0.8.0");
		const outdated = makePrefix("outdated", adapter.pkg, "1.1.1");
		const current = makePrefix("current", adapter.pkg, adapter.minVersion);
		const env = { PATH: [legacy.binDir, outdated.binDir, current.binDir].join(path.delimiter) };
		assert.deepEqual(findAllOnPath(adapter.bin, env), [legacy.shim, outdated.shim, current.shim]);
		assert.equal(findOnPath(adapter.bin, env), legacy.shim);
		assert.equal(compatibleAdapterOnPath(adapter, env), current.shim);
		assert.equal(isCurrentAdapter(adapter, env), true);

		const incompatibleEnv = { PATH: [legacy.binDir, outdated.binDir].join(path.delimiter) };
		assert.equal(compatibleAdapterOnPath(adapter, incompatibleEnv), undefined);
		assert.equal(isCurrentAdapter(adapter, incompatibleEnv), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

assert.deepEqual(
	adapterFailureInstructions(adapter, {
		activePath: "/old-node/bin/codex-acp",
		activeCompatible: false,
		prefix: "/new-node",
		platform: "linux",
	}),
	[
		"  Codex ACP: PATH selects an incompatible adapter at /old-node/bin/codex-acp",
		"    npm installs global binaries into /new-node/bin.",
		"    Remove or update the package that owns the selected path, or move /new-node/bin before /old-node/bin in PATH, then run: npm install -g @agentclientprotocol/codex-acp",
	],
);

{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-postinstall-shim-"));
	try {
		const entrypoint = path.join(root, "node_modules", "adapter", "dist", "index.js");
		fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
		fs.writeFileSync(entrypoint, "// adapter\n");
		const shim = path.join(root, "codex-acp.cmd");
		fs.writeFileSync(shim, '@ECHO off\r\n"%dp0%\\node.exe" "%dp0%\\node_modules\\adapter\\dist\\index.js" %*\r\n');
		assert.equal(windowsNodeShimEntrypoint(shim), entrypoint);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

if (process.platform !== "win32") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-postinstall-owner-"));
	try {
		const successor = path.join(root, "lib", "node_modules", "@agentclientprotocol", "codex-acp");
		const legacy = path.join(root, "lib", "node_modules", "@zed-industries", "codex-acp");
		const shim = path.join(root, "bin", "codex-acp");
		fs.mkdirSync(path.join(successor, "dist"), { recursive: true });
		fs.mkdirSync(path.join(legacy, "dist"), { recursive: true });
		fs.mkdirSync(path.dirname(shim), { recursive: true });
		fs.writeFileSync(path.join(successor, "dist", "index.js"), "// successor\n");
		fs.writeFileSync(path.join(legacy, "dist", "index.js"), "// legacy\n");
		const snapshot = {
			packages: [{ name: adapter.pkg, packageDir: successor }],
			shims: [{ file: shim, kind: "symlink", target: path.relative(path.dirname(shim), path.join(successor, "dist", "index.js")) }],
		};
		assert.equal(snapshotShimOwnedByPackage(snapshot, adapter.pkg, adapter.bin), true);
		snapshot.shims[0].target = path.relative(path.dirname(shim), path.join(legacy, "dist", "index.js"));
		assert.equal(snapshotShimOwnedByPackage(snapshot, adapter.pkg, adapter.bin), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

{
	const calls = [];
	const snapshot = { id: "legacy-backup" };
	const ok = installAdapter(adapter, {
		isGlobalPackageInstalled: (pkg) => pkg === adapter.replaces,
		backupGlobalPackage: (pkg, bin) => {
			calls.push(["backup", pkg, bin]);
			return snapshot;
		},
		uninstallGlobally: (pkg) => {
			calls.push(["uninstall", pkg]);
			return true;
		},
		installGlobally: (pkg) => {
			calls.push(["install", pkg]);
			return false;
		},
		isCurrentAdapter: () => true,
		restoreGlobalPackage: (value) => {
			calls.push(["restore", value.id]);
			return true;
		},
		discardGlobalPackageBackup: (value) => calls.push(["discard", value.id]),
	});
	assert.equal(ok, false);
	assert.deepEqual(calls, [
		["backup", [adapter.replaces], adapter.bin],
		["uninstall", adapter.replaces],
		["install", adapter.pkg],
		["uninstall", adapter.pkg],
		["restore", snapshot.id],
		["discard", snapshot.id],
	]);
}

{
	const calls = [];
	const snapshot = { id: "combined-backup" };
	const ok = installAdapter(adapter, {
		isGlobalPackageInstalled: () => true,
		backupGlobalPackage: (packages, bin) => {
			calls.push(["backup", packages, bin]);
			return snapshot;
		},
		uninstallGlobally: (pkg) => {
			calls.push(["uninstall", pkg]);
			return true;
		},
		restoreGlobalPackageShims: (value) => {
			calls.push(["restore-shims", value.id]);
			return true;
		},
		snapshotShimOwnedByPackage: () => true,
		isCurrentAdapter: () => true,
		restoreGlobalPackage: () => {
			throw new Error("must not restore a successful migration");
		},
		discardGlobalPackageBackup: (value) => calls.push(["discard", value.id]),
	});
	assert.equal(ok, true);
	assert.deepEqual(calls, [
		["backup", [adapter.replaces, adapter.pkg], adapter.bin],
		["uninstall", adapter.replaces],
		["restore-shims", snapshot.id],
		["discard", snapshot.id],
	]);
}

{
	const calls = [];
	const snapshot = { id: "foreign-path-adapter" };
	const ok = installAdapter(adapter, {
		isGlobalPackageInstalled: () => true,
		backupGlobalPackage: (packages, bin) => {
			calls.push(["backup", packages, bin]);
			return snapshot;
		},
		uninstallGlobally: (pkg) => {
			calls.push(["uninstall", pkg]);
			return true;
		},
		installGlobally: (pkg) => {
			calls.push(["install", pkg]);
			return true;
		},
		snapshotShimOwnedByPackage: () => false,
		isCurrentAdapter: () => true,
		restoreGlobalPackage: () => assert.fail("a successful local relink must not roll back"),
		discardGlobalPackageBackup: (value) => calls.push(["discard", value.id]),
	});
	assert.equal(ok, true);
	assert.deepEqual(calls, [
		["backup", [adapter.replaces, adapter.pkg], adapter.bin],
		["uninstall", adapter.replaces],
		["install", adapter.pkg],
		["discard", snapshot.id],
	]);
}

{
	const calls = [];
	const ok = installAdapter(adapter, {
		isGlobalPackageInstalled: () => false,
		installGlobally: (pkg) => {
			calls.push(["install", pkg]);
			return true;
		},
		isCurrentAdapter: () => true,
	});
	assert.equal(ok, true);
	assert.deepEqual(calls, [["install", adapter.pkg]]);
}

{
	const calls = [];
	const snapshot = { id: "outdated-successor" };
	const ok = installAdapter(adapter, {
		isGlobalPackageInstalled: (pkg) => pkg === adapter.pkg,
		backupGlobalPackage: (pkg, bin) => {
			calls.push(["backup", pkg, bin]);
			return snapshot;
		},
		installGlobally: (pkg) => {
			calls.push(["install", pkg]);
			return true;
		},
		isCurrentAdapter: () => true,
		uninstallGlobally: (pkg) => calls.push(["unexpected-uninstall", pkg]),
		restoreGlobalPackage: () => assert.fail("a successful successor upgrade must not roll back"),
		discardGlobalPackageBackup: (value) => calls.push(["discard", value.id]),
	});
	assert.equal(ok, true);
	assert.deepEqual(calls, [
		["backup", adapter.pkg, adapter.bin],
		["install", adapter.pkg],
		["discard", snapshot.id],
	]);
}

{
	const calls = [];
	const snapshot = { id: "outdated-successor" };
	const ok = installAdapter(adapter, {
		isGlobalPackageInstalled: (pkg) => pkg === adapter.pkg,
		backupGlobalPackage: () => snapshot,
		installGlobally: (pkg) => {
			calls.push(["install", pkg]);
			return false;
		},
		isCurrentAdapter: () => false,
		uninstallGlobally: (pkg) => {
			calls.push(["uninstall", pkg]);
			return true;
		},
		restoreGlobalPackage: (value) => {
			calls.push(["restore", value.id]);
			return true;
		},
		discardGlobalPackageBackup: (value) => calls.push(["discard", value.id]),
	});
	assert.equal(ok, false);
	assert.deepEqual(calls, [
		["install", adapter.pkg],
		["uninstall", adapter.pkg],
		["restore", snapshot.id],
		["discard", snapshot.id],
	]);
}

{
	const calls = [];
	const snapshot = { id: "legacy-backup" };
	const ok = installAdapter(adapter, {
		isGlobalPackageInstalled: () => true,
		backupGlobalPackage: (packages, bin) => {
			calls.push(["backup", packages, bin]);
			return snapshot;
		},
		uninstallGlobally: (pkg) => {
			calls.push(["uninstall", pkg]);
			return true;
		},
		installGlobally: (pkg) => {
			calls.push(["install", pkg]);
			return true;
		},
		isCurrentAdapter: () => false,
		restoreGlobalPackage: (value) => {
			calls.push(["restore", value.id]);
			return true;
		},
		discardGlobalPackageBackup: (value) => calls.push(["discard", value.id]),
	});
	assert.equal(ok, false);
	assert.deepEqual(calls, [
		["backup", [adapter.replaces, adapter.pkg], adapter.bin],
		["uninstall", adapter.replaces],
		["install", adapter.pkg],
		["uninstall", adapter.pkg],
		["restore", snapshot.id],
		["discard", snapshot.id],
	]);
}

console.log("postinstall: migration is single-owner with local rollback");
