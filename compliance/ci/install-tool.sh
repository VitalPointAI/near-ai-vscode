#!/bin/sh
# Install one pinned tool into a folder (D-04, D-47).
#
#   sh compliance/ci/install-tool.sh <tool in tool-pins.json> <target-dir>
#
# The version, addresses and SHA-256 values come from tool-pins.json beside this script, which is the only place a pin lives.
# Every download (the tool and each of its assets) goes into a private temporary folder over https only, from an allowed
# host. Every hash kept in the repository is checked before anything is extracted or placed; on a mismatch the script
# exits non-zero and the target folder is left untouched. Archive kinds: zip and tar.gz are extracted, binary is copied to
# <target>/<bin> and made executable, file is placed as-is under its address's file name. Assets are placed beside, under
# their file names. Nothing downloaded is ever run here and nothing is piped into a shell. Bumping a pin: see TOOLS.md.
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: install-tool.sh <tool in tool-pins.json> <target-dir>" >&2
  exit 2
fi
TOOL=$1
TARGET=$2
HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PINS="$HERE/tool-pins.json"

# Read and sanity-check the one entry. Prints version, address, hash, archive kind and the binary path (or, for a file,
# the name it is placed under), one per line, then one line "<address> <hash> <name>" per asset.
ENTRY=$(node -e '
const pins = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const name = process.argv[2];
const pin = Object.hasOwn(pins, name) ? pins[name] : undefined;
if (!pin) { console.error(`install-tool: no pin for "${name}" in tool-pins.json`); process.exit(2); }
const HOSTS = ["repo1.maven.org", "github.com", "get.helm.sh", "download.postgresql.org"];
const SHA256 = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const address = (value) => { try { const url = new URL(value); return url.protocol === "https:" && HOSTS.includes(url.hostname) ? url : null; } catch { return null; } };
const fileName = (url) => { const base = decodeURIComponent(url.pathname.split("/").pop() ?? ""); return NAME.test(base) ? base : null; };
const url = address(pin.url);
const assets = pin.assets === undefined ? [] : Array.isArray(pin.assets) ? pin.assets : null;
let place = null;
if (pin.archive === "zip" || pin.archive === "tar.gz") place = typeof pin.bin === "string" && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(pin.bin) ? pin.bin : null;
else if (pin.archive === "binary") place = typeof pin.bin === "string" && /^[A-Za-z0-9._-]+$/.test(pin.bin) ? pin.bin : null;
else if (pin.archive === "file") place = pin.bin === undefined && url ? fileName(url) : null;
const lines = [];
let ok = /^\d+\.\d+(\.\d+)?(\+[0-9A-Za-z.]+)?$/.test(pin.version) && url !== null && SHA256.test(pin.sha256) && place !== null && assets !== null;
const names = new Set([place]);
for (const asset of assets ?? []) {
  const at = address(asset?.url);
  const base = at ? fileName(at) : null;
  if (!at || !base || !SHA256.test(asset.sha256) || names.has(base)) { ok = false; break; }
  names.add(base);
  lines.push([at.href, asset.sha256, base].join(" "));
}
if (!ok) { console.error(`install-tool: malformed pin for "${name}" in tool-pins.json`); process.exit(2); }
process.stdout.write([pin.version, url.href, pin.sha256, pin.archive, place, ...lines].join("\n") + "\n");
' "$PINS" "$TOOL")

VERSION=$(printf '%s\n' "$ENTRY" | sed -n 1p)
URL=$(printf '%s\n' "$ENTRY" | sed -n 2p)
SHA256=$(printf '%s\n' "$ENTRY" | sed -n 3p)
ARCHIVE=$(printf '%s\n' "$ENTRY" | sed -n 4p)
BIN=$(printf '%s\n' "$ENTRY" | sed -n 5p)
ASSETS=$(printf '%s\n' "$ENTRY" | sed -n '6,$p')

WORK=$(mktemp -d)
trap 'rm -rf -- "$WORK"' EXIT HUP INT TERM
FILE="$WORK/download"
mkdir -- "$WORK/assets"

fetch() {
  curl --fail --silent --show-error --location --proto =https --proto-redir =https \
    --retry 3 --retry-delay 5 --output "$2" "$1"
}

echo "install-tool: fetching $TOOL $VERSION" >&2
fetch "$URL" "$FILE"
printf '%s  %s\n' "$SHA256" "$FILE" > "$WORK/download.sha256"
while read -r ASSET_URL ASSET_SHA256 ASSET_NAME; do
  [ -n "$ASSET_URL" ] || continue
  echo "install-tool: fetching $TOOL asset $ASSET_NAME" >&2
  fetch "$ASSET_URL" "$WORK/assets/$ASSET_NAME"
  printf '%s  %s\n' "$ASSET_SHA256" "$WORK/assets/$ASSET_NAME" >> "$WORK/download.sha256"
done <<EOF
$ASSETS
EOF

# The hash check of every download at once. With set -e a mismatch stops the script here, before the target folder is created.
if ! sha256sum --check --strict --quiet "$WORK/download.sha256"; then
  echo "install-tool: SHA-256 mismatch for $TOOL $VERSION; nothing was extracted" >&2
  exit 1
fi
echo "install-tool: $TOOL $VERSION sha256 $SHA256 OK" >&2

mkdir -p -- "$TARGET"
case "$ARCHIVE" in
  zip) unzip -q -o "$FILE" -d "$TARGET" ;;
  tar.gz) tar -xzf "$FILE" -C "$TARGET" ;;
  binary) cp -- "$FILE" "$TARGET/$BIN" ;;
  file) cp -- "$FILE" "$TARGET/$BIN" ;;
esac
for ASSET in "$WORK"/assets/*; do
  [ -f "$ASSET" ] || continue
  cp -- "$ASSET" "$TARGET/"
done

if [ ! -f "$TARGET/$BIN" ]; then
  echo "install-tool: $BIN not found after extracting $TOOL" >&2
  exit 1
fi
if [ "$ARCHIVE" != file ]; then
  chmod +x -- "$TARGET/$BIN"
fi
echo "install-tool: $TOOL $VERSION ready at $TARGET/$BIN" >&2
