#!/bin/sh
# Stops the local documentation site service and removes the unit file that install-service.sh
# wrote. It does not touch the site, its build or anything else.
set -eu
UNIT=near-ai-docs.service
UNIT_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT"
systemctl --user disable --now "$UNIT" 2>/dev/null || true
if [ -f "$UNIT_FILE" ] && grep -q 'Sterling Sovereign AI documentation site' "$UNIT_FILE"; then
  rm -f "$UNIT_FILE"
  echo "Removed $UNIT_FILE."
fi
systemctl --user daemon-reload
echo "The documentation site service is stopped and uninstalled."
