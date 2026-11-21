#!/bin/sh
# Run the pinned oscal-cli commands confirmed from the 3.2.0 built-in help.
#
#   oscal-validate.sh <oscal-file>
#   oscal-validate.sh resolve <profile> <resolved-output>
set -eu

if [ "$#" -eq 3 ] && [ "$1" = "resolve" ]; then
  oscal-cli profile resolve --to=json --overwrite -q "$2" "$3"
  exit 0
fi

if [ "$#" -eq 1 ]; then
  oscal-cli validate "$1"
  exit 0
fi

echo "usage: oscal-validate.sh <oscal-file> | resolve <profile> <resolved-output>" >&2
exit 2
