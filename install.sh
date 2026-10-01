#!/bin/sh
# Flint installer for macOS and Linux (M10.3).
#   curl -fsSL https://0funct0ry.github.io/flint/install.sh | sh
# Options: --dry-run  --version X.Y.Z  --prefix DIR   Env: FLINT_RELEASE_BASE (override download URL)
set -eu

REPO="0funct0ry/flint"
VERSION="latest"
DRY_RUN=0
PREFIX=""

die() { printf 'flint-install: %s\n' "$*" >&2; exit "${EXIT:-1}"; }
say() { printf 'flint-install: %s\n' "$*"; }
run() { if [ "$DRY_RUN" = 1 ]; then printf '[dry-run] %s\n' "$*"; else "$@"; fi; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --version) [ $# -ge 2 ] || EXIT=2 die "--version needs a value"; VERSION="${2#v}"; shift ;;
    --prefix) [ $# -ge 2 ] || EXIT=2 die "--prefix needs a value"; PREFIX="$2"; shift ;;
    -h|--help) sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) EXIT=2 die "unknown option: $1" ;;
  esac
  shift
done

OS="${FLINT_TEST_OS:-$(uname -s)}"
ARCH="${FLINT_TEST_ARCH:-$(uname -m)}"
case "$OS/$ARCH" in
  Darwin/*) KIND=dmg ;;
  Linux/x86_64|Linux/amd64)
    if command -v dpkg >/dev/null 2>&1 && [ -z "$PREFIX" ] && [ "$(id -u)" = 0 -o -n "${FLINT_USE_SUDO:-}" ]; then KIND=deb; else KIND=appimage; fi ;;
  *) EXIT=2 die "unsupported platform: $OS/$ARCH. Supported: macOS (any), Linux x86_64. On Windows use the .msi from https://github.com/$REPO/releases" ;;
esac

if [ "$VERSION" = latest ]; then
  BASE="${FLINT_RELEASE_BASE:-https://github.com/$REPO/releases/latest/download}"
  [ -n "${FLINT_RELEASE_BASE:-}" ] && VERSION="${FLINT_VERSION:-latest}"
else
  BASE="${FLINT_RELEASE_BASE:-https://github.com/$REPO/releases/download/v$VERSION}"
fi

# Asset names come from the release's SHA256SUMS so the version need not be known up front.
TMP="${TMPDIR:-/tmp}/flint-install.$$"
trap 'rm -rf "$TMP"' EXIT INT TERM
mkdir -p "$TMP"

fetch() { # url dest
  case "$1" in
    file://*) cp "${1#file://}" "$2" ;;
    *) if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
       elif command -v wget >/dev/null 2>&1; then wget -q "$1" -O "$2"
       else EXIT=1 die "need curl or wget"; fi ;;
  esac
}

say "platform: $OS/$ARCH, package: .$KIND"
[ "$DRY_RUN" = 1 ] && say "dry run: no files will be downloaded or changed"

if [ "$DRY_RUN" = 1 ]; then
  say "would download $BASE/SHA256SUMS and the matching .$KIND asset"
  say "would verify the SHA-256 checksum, then install it"
  exit 0
fi

fetch "$BASE/SHA256SUMS" "$TMP/SHA256SUMS" || die "could not download $BASE/SHA256SUMS"
case "$KIND" in
  dmg) PAT='\.dmg$' ;; deb) PAT='\.deb$' ;; appimage) PAT='\.AppImage$' ;;
esac
LINE=$(grep -E "$PAT" "$TMP/SHA256SUMS" | head -n 1) || true
[ -n "$LINE" ] || die "no .$KIND asset listed in SHA256SUMS"
WANT=${LINE%% *}
ASSET=${LINE##* }; ASSET=${ASSET#\*}
fetch "$BASE/$ASSET" "$TMP/$ASSET" || die "could not download $ASSET"

if command -v sha256sum >/dev/null 2>&1; then GOT=$(sha256sum "$TMP/$ASSET" | cut -d' ' -f1)
elif command -v shasum >/dev/null 2>&1; then GOT=$(shasum -a 256 "$TMP/$ASSET" | cut -d' ' -f1)
else die "need sha256sum or shasum to verify the download"; fi
[ "$GOT" = "$WANT" ] || die "checksum mismatch for $ASSET (expected $WANT, got $GOT); nothing was installed"
say "checksum OK: $ASSET"

SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo"
case "$KIND" in
  deb) $SUDO dpkg -i "$TMP/$ASSET" ;;
  appimage)
    DEST="${PREFIX:-$HOME/.local}/bin"
    mkdir -p "$DEST"; cp "$TMP/$ASSET" "$DEST/flint"; chmod 0755 "$DEST/flint"
    case ":$PATH:" in *":$DEST:"*) ;; *) say "add $DEST to your PATH to use \`flint\`" ;; esac ;;
  dmg)
    MNT="$TMP/mnt"; mkdir -p "$MNT"
    hdiutil attach -nobrowse -quiet -mountpoint "$MNT" "$TMP/$ASSET"
    APPS="${PREFIX:-/Applications}"
    $SUDO rm -rf "$APPS/Flint.app"; $SUDO cp -R "$MNT/Flint.app" "$APPS/"
    hdiutil detach -quiet "$MNT" || true
    say "installed $APPS/Flint.app. Open it once; it offers to add \`flint\` to /usr/local/bin."
    ;;
esac
say "done. Run: flint --version"
