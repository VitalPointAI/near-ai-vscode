#!/bin/sh
# The node clock check (D-71; AU-8, AU-8(1), SC-45), run by install-node.sh after it installs the site's chrony.conf and before anything else on the
# node changes. Nodes have no Node.js, so this applies the same four rules as clockProblems in deploy/bundle/lib/clock.mjs with awk; the tests run
# both on the same chronyc output (deploy/test/time.test.mjs).
#
#   sh check-time.sh <bundle-node-folder>      reads <folder>/clock.env (MAX_CLOCK_ERROR_MS=<n>); exit 0 when the clock is good, 1 with the reason
#
# Refused: a clock that is not synchronised, follows chrony's own local clock (reference id 7F7F0101), has a stratum of 0 or 16 and above, or
# whose error bound (absolute system time offset plus root dispersion plus half the root delay, chrony's own bound) is above the limit.
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: check-time.sh <bundle-node-folder>" >&2
  exit 2
fi
DIR=$1
fail() { echo "check-time: $*" >&2; exit 1; }

[ -f "$DIR/clock.env" ] || fail "$DIR/clock.env is missing; write the node clock files with deploy/bundle/lib/clock.mjs on the admin host"
MAX=$(sed -n 's/^MAX_CLOCK_ERROR_MS=//p' "$DIR/clock.env" | head -n 1)
case "$MAX" in
  '' | *[!0-9]*) fail "MAX_CLOCK_ERROR_MS in clock.env is not a whole number of milliseconds" ;;
esac
[ "$MAX" -gt 0 ] || fail "MAX_CLOCK_ERROR_MS in clock.env must be above 0"
command -v chronyc >/dev/null 2>&1 || fail "chronyc is not installed; install chrony from the site's own OS repository"

# Up to about a minute for chronyd to select a source after a restart; the verdict below decides, whatever waitsync says.
chronyc waitsync 60 0 0 1 >/dev/null 2>&1 || true
LINE=$(chronyc -c tracking 2>&1) || fail "chronyc tracking failed: $LINE"

if VERDICT=$(printf '%s\n' "$LINE" | awk -F, -v max="$MAX" '
  NR == 1 {
    seen = 1
    if (NF < 14) { print "chronyc tracking printed an unexpected line: " $0; bad = 1; exit }
    offset = $5 + 0; if (offset < 0) offset = -offset
    bound = (offset + $12 + $11 / 2) * 1000
    measured = sprintf("reference %s, stratum %s, bound %.3f ms", $2, $3, bound)
    reason = ""
    if ($14 == "Not synchronised") reason = "the clock is not synchronised to any time source"
    else if (toupper($1) == "7F7F0101") reason = "the clock follows its own local clock, not a site time source"
    else if ($3 + 0 == 0 || $3 + 0 >= 16) reason = "the reference stratum " $3 " is not a usable time source"
    else if (bound > max + 0) reason = sprintf("the clock error bound is above the site limit of %s ms (time.maxClockErrorMs)", max)
    if (reason != "") { print "refusing: " reason " (" measured ")"; bad = 1; exit }
    print "clock synchronised: " measured " (limit " max " ms)"
    exit
  }
  END { if (!seen) { print "chronyc tracking printed nothing"; bad = 1 } if (bad) exit 1 }
'); then
  echo "check-time: $VERDICT" >&2
else
  fail "$VERDICT"
fi
