#!/bin/sh
set -eu
SITE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || true)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
[ -n "$NODE" ] || { echo 'Node.js was not found on PATH.' >&2; exit 3; }
command -v systemctl >/dev/null 2>&1 || { echo 'systemctl was not found; install the timer from a systemd user session.' >&2; exit 3; }
mkdir -p "$UNIT_DIR"
for unit in near-ai-docs-refresh.service near-ai-docs-refresh.timer; do
  template="$SITE_DIR/scripts/$unit.in"; temporary="$(mktemp "$UNIT_DIR/.$unit.XXXXXX")"
  sed -e "s|@SITE_DIR@|$SITE_DIR|g" -e "s|@NODE@|$NODE|g" "$template" > "$temporary"; mv "$temporary" "$UNIT_DIR/$unit"
  echo "Installed $UNIT_DIR/$unit"
done
systemctl --user daemon-reload
systemctl --user enable --now near-ai-docs-refresh.timer
echo 'Enabled near-ai-docs-refresh.timer (every 15 minutes).'
