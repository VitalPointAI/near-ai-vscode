#!/bin/sh
# Escrow of a server node's restore keys (D-73; CP-9, CP-10). Runs as root on an RKE2 server node, which has no Node.js.
#
#   sh escrow-node.sh save <out-dir>     copy the RKE2 server token and the secrets-encryption configuration to <out-dir> on the key custodians'
#                                        escrow media, with escrow-record.json beside them (digests only)
#   sh escrow-node.sh check <record>     exit 0 with "escrow current", or 1 naming every file that rotated since the escrow
#
# The server token is needed to restore any etcd snapshot (docs.rke2.io, backup and restore); with secrets encryption on (config.yaml), the
# encryption configuration is inside each snapshot, protected by the token, and is escrowed too so that a restore never depends on a surviving
# node and a key rotation (rke2 secrets-encrypt rotate-keys) shows up as a stale escrow. The out folder goes to custody media held by two key
# custodians, apart from the backups (deploy/runbooks/key-ceremony.md); the record holds digests only and goes with the runbook records.
# No value is ever printed. The data folder is ${RKE2_DATA_DIR:-/var/lib/rancher/rke2}.
set -eu

usage() {
  echo "usage: escrow-node.sh save <out-dir> | check <escrow-record.json>" >&2
  exit 2
}
fail() { echo "escrow-node: $*" >&2; exit 1; }
[ "$#" -eq 2 ] || usage
COMMAND=$1
TARGET=$2
[ -n "$TARGET" ] || usage

DATA=${RKE2_DATA_DIR:-/var/lib/rancher/rke2}
FILES="server/token server/cred/encryption-config.json"
FORMAT=sterling-escrow/1

case "$COMMAND" in
save)
  data_abs=$(realpath -m -- "$DATA")
  out_abs=$(realpath -m -- "$TARGET")
  case "$out_abs/" in
    "$data_abs"/*) fail "the out folder $out_abs is inside the RKE2 data folder $data_abs; choose a folder on the escrow media" ;;
  esac
  [ ! -e "$out_abs/escrow-record.json" ] || fail "$out_abs already holds an escrow record; use a new folder for each escrow"
  for name in $FILES; do
    [ -f "$data_abs/$name" ] || fail "$data_abs/$name is missing; is this an RKE2 server node with secrets encryption on?"
  done
  umask 077
  mkdir -p "$out_abs"
  chmod 0700 "$out_abs"
  host=$(uname -n)
  case "$host" in *[!A-Za-z0-9.-]*) host=unknown ;; esac
  created=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  entries=""
  for name in $FILES; do
    copy="$out_abs/$(basename "$name")"
    [ ! -e "$copy" ] || fail "$copy already exists; use a new folder for each escrow"
    install -m 0600 "$data_abs/$name" "$copy"
    digest=$(sha256sum "$copy" | cut -d' ' -f1)
    [ -z "$entries" ] || entries="$entries,
"
    entries="$entries    { \"name\": \"$name\", \"sha256\": \"$digest\" }"
  done
  record="$out_abs/escrow-record.json"
  printf '{\n  "format": "%s",\n  "kind": "rke2",\n  "host": "%s",\n  "createdAt": "%s",\n  "files": [\n%s\n  ]\n}\n' \
    "$FORMAT" "$host" "$created" "$entries" > "$record"
  chmod 0600 "$record"
  echo "escrow-node: saved token and encryption-config.json with escrow-record.json in $out_abs"
  echo "escrow-node: the folder goes to the key custodians' escrow media; a copy of escrow-record.json (digests only) goes with the runbook records."
  ;;
check)
  [ -f "$TARGET" ] || fail "$TARGET does not exist"
  grep -q "\"format\": \"$FORMAT\"" "$TARGET" && grep -q '"kind": "rke2"' "$TARGET" || fail "$TARGET is not an RKE2 escrow record ($FORMAT, kind rke2)"
  created=$(sed -n 's/^ *"createdAt": "\([^"]*\)".*/\1/p' "$TARGET" | head -n 1)
  data_abs=$(realpath -m -- "$DATA")
  stale=0
  seen=0
  # One { "name": ..., "sha256": ... } entry per line, as save writes them.
  while IFS= read -r line; do
    name=$(printf '%s\n' "$line" | sed -n 's/.*"name": "\([^"]*\)".*/\1/p')
    want=$(printf '%s\n' "$line" | sed -n 's/.*"sha256": "\([0-9a-f]\{64\}\)".*/\1/p')
    [ -n "$name" ] && [ -n "$want" ] || continue
    case "$name" in /* | *..*) fail "$TARGET names a file outside the RKE2 data folder" ;; esac
    seen=$((seen + 1))
    if [ ! -f "$data_abs/$name" ]; then
      echo "escrow-node: $name is missing on this node (escrow of $created)" >&2
      stale=1
      continue
    fi
    have=$(sha256sum "$data_abs/$name" | cut -d' ' -f1)
    if [ "$have" != "$want" ]; then
      echo "escrow-node: $name rotated since the escrow on $created; make a new escrow" >&2
      stale=1
    fi
  done < "$TARGET"
  [ "$seen" -gt 0 ] || fail "$TARGET lists no files"
  [ "$stale" -eq 0 ] || exit 1
  echo "escrow-node: escrow current ($seen files, escrow of $created)"
  ;;
*)
  usage
  ;;
esac
