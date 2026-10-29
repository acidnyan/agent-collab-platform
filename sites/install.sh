#!/bin/sh
set -eu
# Dedicated user-local installation; never changes system Node or user keys.
ROOT="$HOME/.local/share/sealbridge"
NODE_VERSION=22.22.0
PACKAGE=sealbridge@0.1.0
fail() { printf 'Sealbridge: %s\n' "$*" >&2; exit 1; }
case "${1:-}" in
  --uninstall)
    if [ -f "$ROOT/.installer-owned" ]; then
      rm -rf "$ROOT"
      printf 'Removed Sealbridge. Keys are preserved. Remove the # sealbridge installer lines from your shell profiles.\n'
    else fail 'No installer-owned installation found; nothing removed.'; fi
    exit 0;;
  '') ;;
  *) fail 'Usage: sh install.sh [--uninstall]';;
esac
trap 'printf "Sealbridge installation failed. Check internet access and directory permissions, then rerun.\n" >&2' 0
[ ! -d "$ROOT" ] || [ -f "$ROOT/.installer-owned" ] || fail "Installation directory already exists without an ownership marker: $ROOT"
mkdir -p "$ROOT"
: > "$ROOT/.installer-owned"
PATH="$ROOT/node/bin:$ROOT/npm/bin:$PATH"
export PATH
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  case "$(uname -s)" in Linux) OS=linux;; Darwin) OS=darwin;; *) fail 'Supported systems: Linux and macOS.';; esac
  case "$(uname -m)" in x86_64) ARCH=x64;; arm64|aarch64) ARCH=arm64;; *) fail 'Supported architectures: x64 and arm64.';; esac
  command -v curl >/dev/null 2>&1 || fail 'Install curl first.'
  FILE="node-v$NODE_VERSION-$OS-$ARCH.tar.gz"
  TMP=$(mktemp -d "$ROOT/download.XXXXXX")
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$FILE" -o "$TMP/$FILE"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  EXPECTED=$(awk -v file="$FILE" '$2 == file {print $1}' "$TMP/SHASUMS256.txt")
  [ "${#EXPECTED}" -eq 64 ] || fail 'Official checksum is missing.'
  if command -v sha256sum >/dev/null 2>&1; then ACTUAL=$(sha256sum "$TMP/$FILE" | awk '{print $1}');
  else ACTUAL=$(shasum -a 256 "$TMP/$FILE" | awk '{print $1}'); fi
  [ "$EXPECTED" = "$ACTUAL" ] || fail 'Node checksum mismatch; installation stopped.'
  mkdir -p "$ROOT/node"
  tar -xzf "$TMP/$FILE" -C "$ROOT/node" --strip-components=1
  rm -rf "$TMP"
fi
command -v npm >/dev/null 2>&1 || fail 'Node is present but npm is missing. Install Node with npm and rerun.'
# Explicit local tarball override for release CI; never defaults to an unpublished package.
if [ -n "${SEALBRIDGE_INSTALL_TARBALL:-}" ]; then
  [ -f "$SEALBRIDGE_INSTALL_TARBALL" ] || fail 'Local test tarball does not exist.'
  PACKAGE=$SEALBRIDGE_INSTALL_TARBALL
fi
npm install --global --prefix "$ROOT/npm" --ignore-scripts --no-audit --no-fund "$PACKAGE"
LINE='export PATH="$HOME/.local/share/sealbridge/node/bin:$HOME/.local/share/sealbridge/npm/bin:$PATH" # sealbridge installer'
for PROFILE in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
  if ! grep -Fq '# sealbridge installer' "$PROFILE" 2>/dev/null; then printf '\n%s\n' "$LINE" >> "$PROFILE"; fi
done
sealbridge --version
if ! sealbridge doctor; then printf 'Installed, but doctor found an issue. Follow its fixes and rerun sealbridge doctor.\n'; fi
trap - 0
printf 'Installed. Open a new terminal, or run: . "$HOME/.profile"\nThen run: sealbridge demo\nUninstall: sh install.sh --uninstall\n'
