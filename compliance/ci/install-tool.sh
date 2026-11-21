#!/bin/sh
# Install one pinned CI tool into a folder (D-04, D-47).
#
#   sh compliance/ci/install-tool.sh <oscal-cli|syft|grype> <target-dir>
#
# The version, address and SHA-256 come from tool-pins.json beside this script, which is the only place a pin lives.
# The download goes into a private temporary folder over https only. The hash kept in the repository is checked
# before anything is extracted; on a mismatch the script exits non-zero and the target folder is left untouched.
# Nothing downloaded is ever run here and nothing is piped into a shell. Bumping a pin: see TOOLS.md.
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: install-tool.sh <oscal-cli|syft|grype> <target-dir>" >&2
  exit 2
fi
TOOL=$1
TARGET=$2
HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PINS="$HERE/tool-pins.json"

# Read and sanity-check the one entry; print version, address, hash, archive kind and binary path, one per line.
ENTRY=$(node -e '
const pins = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const name = process.argv[2];
const pin = Object.hasOwn(pins, name) ? pins[name] : undefined;
if (!pin) { console.error(`install-tool: no pin for "${name}" in tool-pins.json`); process.exit(2); }
const host = new URL(pin.url);
const ok = /^\d+\.\d+\.\d+$/.test(pin.version)
  && host.protocol === "https:" && ["repo1.maven.org", "github.com"].includes(host.hostname)
  && /^[0-9a-f]{64}$/.test(pin.sha256)
  && ["zip", "tar.gz"].includes(pin.archive)
  && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(pin.bin);
if (!ok) { console.error(`install-tool: malformed pin for "${name}" in tool-pins.json`); process.exit(2); }
process.stdout.write([pin.version, pin.url, pin.sha256, pin.archive, pin.bin].join("\n") + "\n");
' "$PINS" "$TOOL")

VERSION=$(printf '%s\n' "$ENTRY" | sed -n 1p)
URL=$(printf '%s\n' "$ENTRY" | sed -n 2p)
SHA256=$(printf '%s\n' "$ENTRY" | sed -n 3p)
ARCHIVE=$(printf '%s\n' "$ENTRY" | sed -n 4p)
BIN=$(printf '%s\n' "$ENTRY" | sed -n 5p)

WORK=$(mktemp -d)
trap 'rm -rf -- "$WORK"' EXIT HUP INT TERM
FILE="$WORK/download"

echo "install-tool: fetching $TOOL $VERSION" >&2
curl --fail --silent --show-error --location --proto =https --proto-redir =https \
  --retry 3 --retry-delay 5 --output "$FILE" "$URL"

# The hash check. With set -e a mismatch stops the script here, before the target folder is created.
printf '%s  %s\n' "$SHA256" "$FILE" > "$WORK/download.sha256"
if ! sha256sum --check --strict --quiet "$WORK/download.sha256"; then
  echo "install-tool: SHA-256 mismatch for $TOOL $VERSION; nothing was extracted" >&2
  exit 1
fi
echo "install-tool: $TOOL $VERSION sha256 $SHA256 OK" >&2

mkdir -p -- "$TARGET"
case "$ARCHIVE" in
  zip) unzip -q -o "$FILE" -d "$TARGET" ;;
  tar.gz) tar -xzf "$FILE" -C "$TARGET" ;;
esac

if [ ! -f "$TARGET/$BIN" ]; then
  echo "install-tool: $BIN not found after extracting $TOOL" >&2
  exit 1
fi
chmod +x -- "$TARGET/$BIN"
echo "install-tool: $TOOL $VERSION ready at $TARGET/$BIN" >&2
