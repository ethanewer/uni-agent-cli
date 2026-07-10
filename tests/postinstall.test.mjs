import assert from "node:assert/strict";

import { installAdapter } from "../scripts/postinstall.mjs";

const adapter = {
	bin: "codex-acp",
	pkg: "@agentclientprotocol/codex-acp",
	replaces: "@zed-industries/codex-acp",
};

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
		["backup", adapter.replaces, adapter.bin],
		["uninstall", adapter.replaces],
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
		backupGlobalPackage: () => snapshot,
		uninstallGlobally: (pkg) => {
			calls.push(["uninstall", pkg]);
			return true;
		},
		installGlobally: (pkg) => {
			calls.push(["install", pkg]);
			return true;
		},
		isCurrentAdapter: () => true,
		restoreGlobalPackage: () => {
			throw new Error("must not restore a successful migration");
		},
		discardGlobalPackageBackup: (value) => calls.push(["discard", value.id]),
	});
	assert.equal(ok, true);
	assert.deepEqual(calls, [
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
	const snapshot = { id: "legacy-backup" };
	const ok = installAdapter(adapter, {
		isGlobalPackageInstalled: () => true,
		backupGlobalPackage: () => snapshot,
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
		["uninstall", adapter.replaces],
		["install", adapter.pkg],
		["uninstall", adapter.pkg],
		["restore", snapshot.id],
		["discard", snapshot.id],
	]);
}

console.log("postinstall: migration is single-owner with local rollback");
