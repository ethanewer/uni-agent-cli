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
	const restored = spawnSync("stty", [state], { stdio: [3, "ignore", "ignore"], timeout: 1_000 });
	const localFlags = /^gfmt1:.*(?:^|:)lflag=([0-9a-f]+)(?::|$)/u.exec(state)?.[1];
	if (restored.status === 0 && process.platform === "darwin" && localFlags &&
		(BigInt(`0x${localFlags}`) & 0x20000000n) !== 0n) {
		spawnSync("stty", ["pendin"], { stdio: [3, "ignore", "ignore"], timeout: 1_000 });
	}
} catch {
	// The controlling terminal may already be gone.
}
