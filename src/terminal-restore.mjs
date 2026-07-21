#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const state = process.argv[2];
if (!state || process.platform === "win32") process.exit(0);

// This detached monitor owns no application capability. Its only input is an
// owner-lifetime pipe; when the launcher exits for any reason (including
// SIGKILL), EOF authorizes one final restoration through the inherited tty fd.
for (const signal of ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"]) {
	process.on(signal, () => {});
}
await new Promise((resolve) => {
	process.stdin.once("end", resolve);
	process.stdin.once("close", resolve);
	process.stdin.once("error", resolve);
	process.stdin.resume();
});
try {
	// PENDIN is queued-input state, not terminal configuration. In particular,
	// do not reconstruct it with a second, delayed `stty pendin`: the owner may
	// have exited and its shell may already be reading the next command, which
	// would ask the line discipline to echo that command again.
	spawnSync("stty", [state], { stdio: [3, "ignore", "ignore"], timeout: 1_000 });
} catch {
	// The controlling terminal may already be gone.
}
