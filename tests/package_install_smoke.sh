#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d -t cc-package-install.XXXXXX)"
cleanup() {
	case "$SCRATCH" in
		/var/folders/*/cc-package-install.*|/tmp/cc-package-install.*) rm -rf -- "$SCRATCH" ;;
		*) echo "Refusing to clean unexpected package smoke path: $SCRATCH" >&2 ;;
	esac
}
trap cleanup EXIT

if [ -n "${CC_WORKFLOW_E2E_TARBALL:-}" ]; then
	tarball="$CC_WORKFLOW_E2E_TARBALL"
	if [ "${tarball#/}" = "$tarball" ] || [ ! -f "$tarball" ]; then
		echo "CC_WORKFLOW_E2E_TARBALL must name an absolute regular tarball" >&2
		exit 1
	fi
else
	npm pack --ignore-scripts --pack-destination "$SCRATCH" "$ROOT" >/dev/null
	tarball="$(find "$SCRATCH" -maxdepth 1 -name '*.tgz' -type f -print -quit)"
	if [ -z "$tarball" ]; then
		echo "npm pack did not create a tarball" >&2
		exit 1
	fi
fi

archive_listing="$SCRATCH/archive-files.txt"
tar -tzf "$tarball" > "$archive_listing"
for required in LICENSE LICENSE-APACHE-2.0 NOTICE package.json; do
	grep -Fx "package/$required" "$archive_listing" >/dev/null || {
		echo "candidate tarball is missing package/$required" >&2
		exit 1
	}
done
while IFS= read -r workflow_file; do
	relative="${workflow_file#"$ROOT/"}"
	grep -Fx "package/$relative" "$archive_listing" >/dev/null || {
		echo "candidate tarball is missing package/$relative" >&2
		exit 1
	}
done < <(find "$ROOT/src/workflows" -type f \( -name '*.mjs' -o -name '*.py' \) -print | sort)

mkdir -p "$SCRATCH/prefix" "$SCRATCH/empty-cwd"
npm install --no-audit --no-fund --foreground-scripts --dangerously-allow-all-scripts --prefix "$SCRATCH/prefix" "$tarball" >"$SCRATCH/install.log" 2>&1
grep -F "node scripts/postinstall.mjs" "$SCRATCH/install.log" >/dev/null
installed="$SCRATCH/prefix/node_modules/cc"
test -f "$installed/src/workflows/manager.mjs"
test -f "$installed/NOTICE"
test -f "$installed/LICENSE"
test -f "$installed/LICENSE-APACHE-2.0"
node --input-type=module - "$installed/scripts/postinstall.mjs" <<'NODE'
import path from "node:path";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
const modulePath = process.argv[2];
const { verifyPostinstall } = await import(pathToFileURL(modulePath));
const results = verifyPostinstall({ report: false });
if (results.length === 0 || results.some((entry) => !entry.ok)) {
	throw new Error(`installed cc ACP components failed verification: ${JSON.stringify(results)}`);
}
const installedRoot = path.dirname(path.dirname(modulePath));
const installedModule = (relative) => import(pathToFileURL(path.join(installedRoot, relative)));
const [{ normalizeWorkflowLaunch }, { extractWorkflowMeta }, { validateWorkflowSchema }] = await Promise.all([
	installedModule("src/workflows/types.mjs"),
	installedModule("src/workflows/meta.mjs"),
	installedModule("src/workflows/schema.mjs"),
	installedModule("src/workflows/manager.mjs"),
	installedModule("src/workflows/broker.mjs"),
	installedModule("src/workflows/tui.mjs"),
]);
const requireFromArtifact = createRequire(path.join(installedRoot, "package.json"));
await import(pathToFileURL(requireFromArtifact.resolve("zod/v4")));
await import(pathToFileURL(requireFromArtifact.resolve("@modelcontextprotocol/sdk/server/mcp.js")));
normalizeWorkflowLaunch({ script: 'export const meta={name:"installed",description:"installed"}; return 1;' });
extractWorkflowMeta('export const meta={name:"installed",description:"installed"}; return 1;');
const validation = validateWorkflowSchema({ type: "string" }, "installed-runtime");
if (!validation.ok) throw new Error(`installed workflow schema runtime failed: ${JSON.stringify(validation.errors)}`);
if (process.platform !== "darwin") {
	const piPath = path.join(installedRoot, "src/pi-harness.mjs");
	const { resolveWorkflowMode } = await import(pathToFileURL(piPath));
	if (resolveWorkflowMode({ workflowMode: "flexible" }, {}, process.platform) !== "disabled") {
		throw new Error("installed non-macOS artifact did not force persisted workflow opt-in to Disabled");
	}
	const piSource = await fs.readFile(piPath, "utf8");
	if (/^import .*\.\/workflows\//mu.test(piSource)) throw new Error("installed Disabled startup statically imports workflow components");
}
NODE

cd "$SCRATCH/empty-cwd"
"$SCRATCH/prefix/node_modules/.bin/cc" --help >/dev/null
while IFS= read -r module; do node --check "$module"; done < <(find "$installed/src" "$installed/scripts" -type f -name '*.mjs' -print | sort)
python3 - "$installed" <<'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
for source in sorted(root.joinpath("src").rglob("*.py")):
    compile(source.read_text(encoding="utf-8"), str(source), "exec")
PY

echo "package install smoke: packed tarball installs and verifies from an empty cwd"
