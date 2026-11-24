#!/usr/bin/env bash
# Run a command (an image build) and run it again only when Red Hat's public registry refused a download.
#
#   bash .github/retry-registry-auth.sh docker build ...
#
# The UBI bases come from registry.access.redhat.com, which serves them without credentials. Some of its edges
# intermittently answer a layer request with a 401 whose token realm is the authenticated registry
# (registry.redhat.io or brew.registry.redhat.io); BuildKit's anonymous token request there is refused and the build
# stops. Running it again passes. Only that message is retried, at most three runs in all; any other failure ends
# here at once with the command's own exit status, and a command that never succeeds never reports success.
set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: retry-registry-auth.sh <command> [args...]" >&2
  exit 2
fi

REFUSED='failed to fetch anonymous token: unexpected status from GET request to https://([a-z0-9-]+\.)*registry\.redhat\.io/auth/realms/rhcc/[^ ]*: 401 Unauthorized'
log=$(mktemp)
trap 'rm -f "$log"' EXIT

attempt=1
while :; do
  "$@" 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  [ "$status" -eq 0 ] && exit 0
  if [ "$attempt" -ge 3 ] || ! grep -Eq "$REFUSED" "$log"; then
    exit "$status"
  fi
  echo "::warning::Red Hat's registry refused an anonymous layer download (run $attempt of 3); running the build again."
  sleep $((attempt * 20))
  attempt=$((attempt + 1))
done
