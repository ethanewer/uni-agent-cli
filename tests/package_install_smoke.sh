#!/usr/bin/env bash
set -euo pipefail

shopt -s nocasematch
while IFS= read -r environment_name; do
	environment_value="${!environment_name-}"
	case "$environment_name" in *KEY*|*TOKEN*|*SECRET*|*PASSWORD*|*CREDENTIAL*|*AUTH*|PAT|PAT_*|*_PAT|*_PAT_*) unset "$environment_name" ;; esac
	case "$environment_name" in [Nn][Pp][Mm]_[Cc][Oo][Nn][Ff][Ii][Gg]_[Uu][Ss][Ee][Rr][Cc][Oo][Nn][Ff][Ii][Gg]|[Nn][Pp][Mm]_[Cc][Oo][Nn][Ff][Ii][Gg]_[Gg][Ll][Oo][Bb][Aa][Ll][Cc][Oo][Nn][Ff][Ii][Gg]) unset "$environment_name" ;; esac
	case "$environment_value" in *://*@*|*://*[?#]*) unset "$environment_name" ;; esac
	case "$environment_value" in *$'\r'*|*$'\n'*) unset "$environment_name" ;; esac
done < <(compgen -e)
shopt -u nocasematch

release_npm() {
	if [ -n "${CC_RELEASE_NPM_CLI:-}" ] || [ -n "${CC_RELEASE_NODE:-}" ]; then
		if [ -z "${CC_RELEASE_NPM_CLI:-}" ] || [ -z "${CC_RELEASE_NODE:-}" ] ||
			[ "${CC_RELEASE_NPM_CLI#/}" = "$CC_RELEASE_NPM_CLI" ] || [ ! -f "$CC_RELEASE_NPM_CLI" ] ||
			[ "${CC_RELEASE_NODE#/}" = "$CC_RELEASE_NODE" ] || [ ! -x "$CC_RELEASE_NODE" ]; then
			echo "release npm requires absolute CC_RELEASE_NODE and CC_RELEASE_NPM_CLI files" >&2
			exit 1
		fi
		"$CC_RELEASE_NODE" "$CC_RELEASE_NPM_CLI" "$@"
	else
		command npm "$@"
	fi
}
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d -t cc-package-install.XXXXXX)"
(umask 077; : > "$SCRATCH/user.npmrc"; : > "$SCRATCH/global.npmrc")
export npm_config_userconfig="$SCRATCH/user.npmrc"
export npm_config_globalconfig="$SCRATCH/global.npmrc"
unset npm_config_omit NPM_CONFIG_OMIT
TMUX_SOCKET="cc-package-install-$PPID-$$"
TMUX_SESSION="cc-package-install-$PPID-$$"
cleanup() {
	if command -v tmux >/dev/null 2>&1; then tmux -L "$TMUX_SOCKET" kill-server >/dev/null 2>&1 || true; fi
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
	release_npm pack --ignore-scripts --pack-destination "$SCRATCH" "$ROOT" >/dev/null
	tarball="$(find "$SCRATCH" -maxdepth 1 -name '*.tgz' -type f -print -quit)"
	if [ -z "$tarball" ]; then
		echo "npm pack did not create a tarball" >&2
		exit 1
	fi
fi

archive_listing="$SCRATCH/archive-files.txt"
tar -tzf "$tarball" > "$archive_listing"
for required in LICENSE LICENSE-APACHE-2.0 NOTICE package.json npm-shrinkwrap.json; do
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
release_npm install --include=optional --no-audit --no-fund --foreground-scripts --dangerously-allow-all-scripts --prefix "$SCRATCH/prefix" "$tarball" >"$SCRATCH/install.log" 2>&1
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
if command -v tmux >/dev/null 2>&1 && [ "$(uname -s)" != "MINGW" ]; then
	before="$SCRATCH/installed-stty-before"
	after="$SCRATCH/installed-stty-after"
	settings="$SCRATCH/installed-settings.json"
	printf '{}\n' > "$settings"
	root_q="$(printf '%q' "$ROOT")"
	bin_q="$(printf '%q' "$SCRATCH/prefix/node_modules/.bin/cc")"
	before_q="$(printf '%q' "$before")"
	after_q="$(printf '%q' "$after")"
	settings_q="$(printf '%q' "$settings")"
	tmux -L "$TMUX_SOCKET" new-session -d -s "$TMUX_SESSION" -x 100 -y 30 "cd $root_q && exec sh"
	tmux -L "$TMUX_SOCKET" send-keys -l -t "$TMUX_SESSION" "stty -g > $before_q; env CC_CONFIG=tests/fake_config.json CC_SETTINGS=$settings_q CC_BACKGROUND_CONNECT_DELAY_MS=0 CC_TEST_STARTUP_IMPORT_DELAY_MS=5000 $bin_q fake; for attempt in \$(seq 1 50); do stty -g > $after_q; cmp -s $before_q $after_q && break; sleep 0.02; done"
	tmux -L "$TMUX_SOCKET" send-keys -t "$TMUX_SESSION" Enter
	manager_pid=""
	for _ in {1..100}; do
		pane_pid="$(tmux -L "$TMUX_SOCKET" display-message -pt "$TMUX_SESSION" '#{pane_pid}')"
		manager_pid="$(ps -axo ppid=,pid=,command= | awk -v parent="$pane_pid" '$1 == parent && /node .*node_modules\/\.bin\/cc/ { print $2; exit }')"
		if [ -n "$manager_pid" ]; then break; fi
		sleep 0.05
	done
	if [ -z "$manager_pid" ]; then
		echo "could not find installed npm-bin cc manager for SIGKILL restoration smoke" >&2
		exit 1
	fi
	pane_tty="$(tmux -L "$TMUX_SOCKET" display-message -pt "$TMUX_SESSION" '#{pane_tty}')"
	entered_raw=0
	for _ in {1..100}; do
		if tmux -L "$TMUX_SOCKET" capture-pane -pt "$TMUX_SESSION" | grep -Fq "Space to record"; then
			current_stty="$(stty -g < "$pane_tty" 2>/dev/null || true)"
			if [ -n "$current_stty" ] && [ "$current_stty" != "$(cat "$before")" ]; then
				entered_raw=1
				break
			fi
		fi
		sleep 0.05
	done
	if [ "$entered_raw" -ne 1 ]; then
		echo "installed npm-bin cc did not demonstrably enter raw mode before SIGKILL smoke" >&2
		exit 1
	fi
	kill -KILL "$manager_pid"
	for _ in {1..100}; do
		if [ -s "$after" ] && cmp -s "$before" "$after"; then break; fi
		sleep 0.05
	done
	cmp -s "$before" "$after" || {
		echo "installed npm-bin cc failed to restore exact terminal state after SIGKILL" >&2
		exit 1
	}
	tmux -L "$TMUX_SOCKET" kill-session -t "$TMUX_SESSION" >/dev/null 2>&1 || true
fi
while IFS= read -r module; do node --check "$module"; done < <(find "$installed/src" "$installed/scripts" -type f -name '*.mjs' -print | sort)
python3 - "$installed" <<'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
for source in sorted(root.joinpath("src").rglob("*.py")):
    compile(source.read_text(encoding="utf-8"), str(source), "exec")
PY

echo "package install smoke: packed tarball installs and verifies from an empty cwd"
