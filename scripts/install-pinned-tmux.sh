#!/usr/bin/env bash
set -euo pipefail

TMUX_VERSION=3.5a
TMUX_SHA256=16216bd0877170dfcc64157085ba9013610b12b082548c7c9542cc0103198951
LIBEVENT_VERSION=2.1.12-stable
LIBEVENT_SHA256=92e6de1be9ec176428fd2367677e61ceffc2ee1cb119035037a27d346b0403bb
BUILD_ROOT="$(mktemp -d -t cc-pinned-tmux.XXXXXX)"
PREFIX="$BUILD_ROOT/prefix"
mkdir -p "$PREFIX"
if [ -x /usr/bin/clang ]; then
	BUILD_CC=/usr/bin/clang
elif [ -x /usr/bin/cc ]; then
	BUILD_CC=/usr/bin/cc
else
	BUILD_CC="$(command -v cc)"
fi
[ -n "$BUILD_CC" ] && [ -x "$BUILD_CC" ]

curl -fsSL "https://github.com/libevent/libevent/releases/download/release-${LIBEVENT_VERSION}/libevent-${LIBEVENT_VERSION}.tar.gz" -o "$BUILD_ROOT/libevent.tar.gz"
curl -fsSL "https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz" -o "$BUILD_ROOT/tmux.tar.gz"
printf '%s  %s\n' "$LIBEVENT_SHA256" "$BUILD_ROOT/libevent.tar.gz" | shasum -a 256 -c -
printf '%s  %s\n' "$TMUX_SHA256" "$BUILD_ROOT/tmux.tar.gz" | shasum -a 256 -c -

tar -xzf "$BUILD_ROOT/libevent.tar.gz" -C "$BUILD_ROOT"
(
	cd "$BUILD_ROOT/libevent-${LIBEVENT_VERSION}"
	CC="$BUILD_CC" CC_FOR_BUILD="$BUILD_CC" ./configure --prefix="$PREFIX" --disable-shared --enable-static --disable-openssl
	make -j2
	make install
)
tar -xzf "$BUILD_ROOT/tmux.tar.gz" -C "$BUILD_ROOT"
(
	cd "$BUILD_ROOT/tmux-${TMUX_VERSION}"
	CC="$BUILD_CC" CC_FOR_BUILD="$BUILD_CC" PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" CPPFLAGS="-I$PREFIX/include" LDFLAGS="-L$PREFIX/lib" \
		./configure --prefix="$PREFIX" --disable-utf8proc
	make -j2
	make install
)
test "$("$PREFIX/bin/tmux" -V)" = "tmux $TMUX_VERSION"

if [ -n "${GITHUB_PATH:-}" ]; then printf '%s\n' "$PREFIX/bin" >> "$GITHUB_PATH"; fi
if [ -n "${GITHUB_ENV:-}" ]; then
	{
		printf 'CC_RELEASE_TMUX_VERSION=%s\n' "$TMUX_VERSION"
		printf 'CC_RELEASE_TMUX_SHA256=%s\n' "$TMUX_SHA256"
		printf 'CC_RELEASE_LIBEVENT_VERSION=%s\n' "$LIBEVENT_VERSION"
		printf 'CC_RELEASE_LIBEVENT_SHA256=%s\n' "$LIBEVENT_SHA256"
		printf 'CC_RELEASE_RUNNER_IMAGE_VERSION=%s\n' "${ImageVersion:-unknown}"
		printf 'CC_RELEASE_RUNNER_OS_VERSION=%s\n' "$(sw_vers -productVersion 2>/dev/null || uname -r)"
	} >> "$GITHUB_ENV"
fi
