#!/bin/sh
# Installs and starts the local documentation site as a systemd user service.
#
# It serves the last build of this checkout's docs-site/build on http://127.0.0.1:<port>/ (3210 by
# default) and starts again at login. Build the site first: npm run docs:build. Re-run this script
# to move the service to another checkout or port; it replaces only its own unit file.
#
# Usage: sh scripts/install-service.sh [port]
set -eu

UNIT=near-ai-docs.service
PORT="${1:-${NEAR_AI_DOCS_PORT:-3210}}"
SITE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || true)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

case "$PORT" in
  ''|*[!0-9]*) echo "Not a port number: $PORT" >&2; exit 2 ;;
esac
if [ "$PORT" -lt 1024 ] || [ "$PORT" -gt 65535 ]; then
  echo "Pick a port from 1024 to 65535 (got $PORT)." >&2; exit 2
fi
if [ -z "$NODE" ]; then
  echo "Node.js was not found on PATH." >&2; exit 3
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl was not found: this script needs systemd. Run npm run docs:serve instead." >&2; exit 3
fi
if [ ! -f "$SITE_DIR/build/index.html" ]; then
  echo "No built site in $SITE_DIR/build. Run npm run docs:build from the repository root first." >&2; exit 3
fi
case "$SITE_DIR$NODE" in
  *@*|*'
'*) echo "The checkout path or the Node.js path contains a character the unit cannot hold." >&2; exit 3 ;;
esac

# Refuse a port something else holds; our own running service may hold it.
if command -v ss >/dev/null 2>&1 && ss -ltnH "sport = :$PORT" | grep -q .; then
  if ! systemctl --user is-active --quiet "$UNIT"; then
    echo "Port $PORT is already in use. Pick another: sh scripts/install-service.sh <port>" >&2; exit 4
  fi
fi

mkdir -p "$UNIT_DIR"
tmp="$(mktemp "$UNIT_DIR/.$UNIT.XXXXXX")"
sed -e "s|@SITE_DIR@|$SITE_DIR|g" -e "s|@NODE@|$NODE|g" -e "s|@PORT@|$PORT|g" \
  "$SITE_DIR/scripts/near-ai-docs.service.in" > "$tmp"
mv "$tmp" "$UNIT_DIR/$UNIT"

systemctl --user daemon-reload
systemctl --user enable "$UNIT" >/dev/null
systemctl --user restart "$UNIT"

i=0
while [ $i -lt 20 ]; do
  if systemctl --user is-active --quiet "$UNIT" && \
     node -e "require('http').get('http://127.0.0.1:$PORT/',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" 2>/dev/null; then
    echo "The documentation site is up at http://127.0.0.1:$PORT/ (service $UNIT, serving $SITE_DIR/build)."
    exit 0
  fi
  i=$((i + 1)); sleep 0.5
done
echo "The service did not answer on port $PORT. See: journalctl --user -u $UNIT -n 50" >&2
exit 5
