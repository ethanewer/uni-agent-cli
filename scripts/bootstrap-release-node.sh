#!/usr/bin/env bash
set -euo pipefail

VERSION="22.19.0"
OS_NAME="${RUNNER_OS:-}"
ARCH_NAME="${RUNNER_ARCH:-}"

case "$OS_NAME/$ARCH_NAME" in
	Linux/X64)
		ARCHIVE="node-v${VERSION}-linux-x64.tar.xz"
		ARCHIVE_SHA256="c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2"
		DIRECTORY="node-v${VERSION}-linux-x64"
		;;
	Linux/ARM64)
		ARCHIVE="node-v${VERSION}-linux-arm64.tar.xz"
		ARCHIVE_SHA256="0b2d9f564b6594222a62c82e1df2efe119dd4a4aff29644f4dd325bf360b6bcc"
		DIRECTORY="node-v${VERSION}-linux-arm64"
		;;
	macOS/X64)
		ARCHIVE="node-v${VERSION}-darwin-x64.tar.xz"
		ARCHIVE_SHA256="41796082f45db51738d1902cae84fa4f699ff6d2550321361424e8bfe6ea1939"
		DIRECTORY="node-v${VERSION}-darwin-x64"
		;;
	macOS/ARM64)
		ARCHIVE="node-v${VERSION}-darwin-arm64.tar.xz"
		ARCHIVE_SHA256="1c3a9e78da501bbc1f0c99fbbb69bb7c722bc7a9bf30128b21ea502f3905892a"
		DIRECTORY="node-v${VERSION}-darwin-arm64"
		;;
	Windows/X64)
		ARCHIVE="node-v${VERSION}-win-x64.zip"
		ARCHIVE_SHA256="ea3fad0e67a991d8477d8c01344b56e69c676ccb733f065b22436994b1253f86"
		DIRECTORY="node-v${VERSION}-win-x64"
		;;
	Windows/ARM64)
		ARCHIVE="node-v${VERSION}-win-arm64.zip"
		ARCHIVE_SHA256="e4a7336010d58ff35b53d9dd5869095c56089c70913cf22508cf8183593e56b2"
		DIRECTORY="node-v${VERSION}-win-arm64"
		;;
	*)
		echo "unsupported protected release runner: ${OS_NAME:-unknown}/${ARCH_NAME:-unknown}" >&2
		exit 1
		;;
esac

TASK_TEMP="${RUNNER_TEMP:-/tmp}"
if [ "$OS_NAME" = "Windows" ] && command -v cygpath >/dev/null 2>&1; then
	TASK_TEMP="$(cygpath -u "$TASK_TEMP")"
fi
BOOTSTRAP_ROOT="$(mktemp -d "$TASK_TEMP/cc-release-node.XXXXXX")"
ARCHIVE_PATH="$BOOTSTRAP_ROOT/$ARCHIVE"
curl --fail --silent --show-error --location --retry 3 \
	"https://nodejs.org/download/release/v${VERSION}/${ARCHIVE}" --output "$ARCHIVE_PATH"
if command -v sha256sum >/dev/null 2>&1; then
	ACTUAL_SHA256="$(sha256sum "$ARCHIVE_PATH" | awk '{print $1}')"
else
	ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE_PATH" | awk '{print $1}')"
fi
if [ "$ACTUAL_SHA256" != "$ARCHIVE_SHA256" ]; then
	echo "official Node archive digest mismatch for $ARCHIVE" >&2
	exit 1
fi
if [ "$OS_NAME" = "Windows" ]; then
	if command -v unzip >/dev/null 2>&1; then
		unzip -q "$ARCHIVE_PATH" -d "$BOOTSTRAP_ROOT"
	else
		ARCHIVE_WINDOWS="$(cygpath -w "$ARCHIVE_PATH")"
		DESTINATION_WINDOWS="$(cygpath -w "$BOOTSTRAP_ROOT")"
		CC_NODE_ARCHIVE="$ARCHIVE_WINDOWS" CC_NODE_DESTINATION="$DESTINATION_WINDOWS" \
			powershell.exe -NoProfile -NonInteractive -Command \
			'Expand-Archive -LiteralPath $env:CC_NODE_ARCHIVE -DestinationPath $env:CC_NODE_DESTINATION'
	fi
else
	tar -xf "$ARCHIVE_PATH" -C "$BOOTSTRAP_ROOT"
fi
NODE_ROOT="$BOOTSTRAP_ROOT/$DIRECTORY"
if [ "$OS_NAME" = "Windows" ]; then
	NODE_EXE="$NODE_ROOT/node.exe"
	NPM_CLI="$NODE_ROOT/node_modules/npm/bin/npm-cli.js"
else
	NODE_EXE="$NODE_ROOT/bin/node"
	NPM_CLI="$NODE_ROOT/lib/node_modules/npm/bin/npm-cli.js"
fi
if [ ! -x "$NODE_EXE" ] || [ ! -f "$NPM_CLI" ]; then
	echo "authenticated Node archive is missing its Node/npm runtime" >&2
	exit 1
fi

# The exact runtime authenticates its complete npm installation before the
# workflow permits any npm command, including `npm --version`.
"$NODE_EXE" scripts/release-workflows.mjs verify-toolchain
NODE_NATIVE="$("$NODE_EXE" -e 'const fs=require("fs");process.stdout.write(fs.realpathSync(process.execPath))')"
NPM_NATIVE="$("$NODE_EXE" -e 'const fs=require("fs");process.stdout.write(fs.realpathSync(process.argv[1]))' "$NPM_CLI")"
BIN_NATIVE="$("$NODE_EXE" -e 'const path=require("path");process.stdout.write(path.dirname(process.execPath))')"
{
	printf 'CC_RELEASE_NODE=%s\n' "$NODE_NATIVE"
	printf 'CC_RELEASE_NPM_CLI=%s\n' "$NPM_NATIVE"
} >> "$GITHUB_ENV"
printf '%s\n' "$BIN_NATIVE" >> "$GITHUB_PATH"
