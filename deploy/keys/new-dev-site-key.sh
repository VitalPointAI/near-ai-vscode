#!/bin/sh
# Make the development organization site key in a SoftHSM2 token on your own machine (owner decision a, 2026-11-24; plan 48.1-22).
#
#   sh deploy/keys/new-dev-site-key.sh            make the token and key once, or show them if they exist
#   sh deploy/keys/new-dev-site-key.sh --show     print the existing public key and PKCS#11 URI
#   sh deploy/keys/new-dev-site-key.sh --rotate   archive the current token and public key, then make a new key
#
# Run it yourself, in a terminal. It asks for the PINs in the token tools' own prompts and refuses to run without a terminal, so it is not
# meant for unattended runs. That refusal is not a security control: anything that gives it a terminal can run it.
#
# What it does:
#   1. Checks for softhsm2-util, pkcs11-tool, script and the SoftHSM2 module. If any is missing it shows the install command for the
#      packages listed for this script in deploy/host-packages.json (softhsm2, opensc and util-linux's script, from your OS vendor's
#      signed archive) and runs it only after you type yes.
#   2. Writes ~/.config/sterling-signing/softhsm/softhsm2.conf with the tokens folder beside it (both 0700).
#   3. Initialises the token sterling-site-dev. softhsm2-util asks for the security officer PIN and the token PIN itself.
#   4. Makes an EC P-256 key pair labelled sterling-site, id 01, inside the token with pkcs11-tool (which asks for the token PIN
#      itself), and stops unless the private key is sensitive and never extractable. pkcs11-tool runs under script(1), on a terminal
#      of its own: OpenSC's PIN prompt (util_getpass in src/tools/util.c) turns echo off on standard output's terminal and fails with
#      "util_getpass error" when standard output is not one, so its output cannot be read through a pipe. script keeps a copy of
#      what pkcs11-tool prints (the PIN is not echoed, so it is not in it) in a 0600 file in a 0700 temporary folder; the script reads
#      the private key's Access line from it and removes that file and folder when it exits.
#   5. Prints the public key (PEM) and the PKCS#11 URI, without any PIN, and saves the public key, and only it, to
#      ~/.config/sterling-signing/site-key.pub.pem. Put that public key in your site file as organizationPublicKey.
# A run where the key already exists makes nothing: it logs in the same way (pkcs11-tool asks for the token PIN) and runs the same
# check on the existing private key, because SoftHSM2 shows a private key only after a login. --show does not log in or check.
#
# PINs are only ever typed into the token tools' own prompts: never passed as arguments, written to a file, printed or logged.
# Nothing is ever deleted, apart from that temporary copy of pkcs11-tool's output: a second run refuses to make a key where one exists,
# and --rotate, or a private key that fails the check, moves the token folder, its configuration and the saved public key to
# ~/.config/sterling-signing/softhsm/.archive/<UTC time>/.
#
# --test (for deploy/test/dev-site-key.test.mjs only) runs without a terminal, and only when SOFTHSM2_CONF names a softhsm2.conf in a
# folder strictly inside a temporary folder ($TMPDIR or /tmp) that is not the home folder and holds neither the home folder nor
# ~/.config/sterling-signing, and nothing it would write resolves into ~/.config/sterling-signing (inside_temporary below).
# STERLING_PKCS11_MODULE names the SoftHSM2 module when it is not in one of the usual places.
set -eu
umask 077

TOKEN_LABEL=sterling-site-dev
KEY_LABEL=sterling-site
KEY_ID=01
SELF=deploy/keys/new-dev-site-key.sh
# The DER SubjectPublicKeyInfo header of an uncompressed EC P-256 key, in base64; the whole key is 91 bytes, 124 base64 characters.
P256_SPKI_PREFIX=MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE
HERE=$(cd -P "$(dirname "$0")" && pwd)
PACKAGES_FILE=$HERE/../host-packages.json

say() { printf '%s\n' "$*" >&2; }
fail() { say "new-dev-site-key: $*"; exit 1; }
usage() { say "usage: sh $SELF [--show | --rotate]"; }

TEST=no
MODE=create
for arg in "$@"; do
  case "$arg" in
    --test) TEST=yes ;;
    --show | --rotate)
      [ "$MODE" = create ] || { usage; exit 2; }
      MODE=${arg#--} ;;
    -h | --help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

# The absolute path $1 with its longest existing folder part resolved through symlinks (pwd -P) and the rest appended as written.
resolved() {
  rest=""
  dir=$1
  while [ ! -d "$dir" ]; do
    rest="/$(basename "$dir")$rest"
    dir=$(dirname "$dir")
  done
  top=$(cd -P "$dir" && pwd)
  [ "$top" = / ] && top=""
  printf '%s%s\n' "$top" "$rest"
}

# True when the path $1 is the folder $2 or lies under it.
within() {
  [ "$1" = "$2" ] && return 0
  case "$1/" in
    "$2"/*) return 0 ;;
  esac
  return 1
}

# True only when --test may use $1 as SOFTHSM2_CONF: an absolute softhsm2.conf path with no . or .. parts, where
#   - nothing the script writes (the configuration, the tokens folder beside it, site-key.pub.pem in the folder above) resolves into the
#     owner's ~/.config/sterling-signing, itself resolved through symlinks, and none of them is a symlink;
#   - the folder above the configuration exists, is not the owner folder or any folder above it, and lies strictly inside $TMPDIR or /tmp;
#   - that temporary folder is not the home folder and holds neither the home folder nor the owner folder.
inside_temporary() {
  case "$1" in
    /*) ;;
    *) return 1 ;;
  esac
  case "$1/" in
    */./* | */../* | *//*) return 1 ;;
  esac
  [ "$(basename "$1")" = softhsm2.conf ] || return 1
  home=$(resolved "${HOME:-/nonexistent}")
  owner=$(resolved "${HOME:-/nonexistent}/.config/sterling-signing")
  conf_dir=$(dirname "$1")
  base_given=$(dirname "$conf_dir")
  [ -d "$base_given" ] || return 1
  base=$(cd -P "$base_given" && pwd)
  for target in "$1" "$conf_dir/tokens" "$base_given/site-key.pub.pem"; do
    [ -L "$target" ] && return 1
    within "$(resolved "$target")" "$owner" && return 1
  done
  within "$owner" "$base" && return 1
  for tmp in "${TMPDIR:-/tmp}" /tmp; do
    [ -d "$tmp" ] || continue
    top=$(cd -P "$tmp" && pwd)
    [ "$top" = "$home" ] && continue
    within "$home" "$top" && continue
    within "$owner" "$top" && continue
    if [ "$base" != "$top" ] && within "$base" "$top"; then return 0; fi
  done
  return 1
}

if [ "$TEST" = yes ]; then
  inside_temporary "${SOFTHSM2_CONF:-}" \
    || fail "--test needs SOFTHSM2_CONF set to a softhsm2.conf in a folder strictly inside a temporary folder (\$TMPDIR or /tmp) that is not your home folder and does not hold it, and never in or above ~/.config/sterling-signing"
  CONF=$SOFTHSM2_CONF
  SOFTHSM_DIR=$(dirname "$CONF")
  BASE=$(dirname "$SOFTHSM_DIR")
else
  [ -t 0 ] || fail "run this yourself in a terminal: it asks for the token PINs in the token tools' own prompts, so it does not run unattended (this check is not a security control)"
  BASE=$HOME/.config/sterling-signing
  SOFTHSM_DIR=$BASE/softhsm
  CONF=$SOFTHSM_DIR/softhsm2.conf
fi
TOKENS=$SOFTHSM_DIR/tokens
PUB=$BASE/site-key.pub.pem
export SOFTHSM2_CONF="$CONF"

# The package names for one OS family (apt or dnf) of every package in deploy/host-packages.json used by this script.
package_names() {
  awk -v family="$1" -v self="$SELF" '
    function flush() { if (used && pkg != "") out = out (out == "" ? "" : " ") pkg; used = 0; pkg = "" }
    /"name":/ { flush() }
    /"packageNames":/ {
      if (match($0, "\"" family "\": *\"[^\"]*\"")) { v = substr($0, RSTART, RLENGTH); sub(/^"[^"]*": *"/, "", v); sub(/"$/, "", v); pkg = v }
    }
    /"usedBy":/ { if (index($0, "\"" self "\"")) used = 1 }
    END { flush(); print out }
  ' "$PACKAGES_FILE"
}

find_module() {
  if [ -n "${STERLING_PKCS11_MODULE:-}" ]; then
    [ -f "$STERLING_PKCS11_MODULE" ] || return 1
    printf '%s\n' "$STERLING_PKCS11_MODULE"
    return 0
  fi
  for candidate in /usr/lib/softhsm/libsofthsm2.so /usr/lib/x86_64-linux-gnu/softhsm/libsofthsm2.so /usr/lib/aarch64-linux-gnu/softhsm/libsofthsm2.so \
    /usr/lib64/pkcs11/libsofthsm2.so /usr/lib64/softhsm/libsofthsm.so /usr/lib/pkcs11/libsofthsm2.so; do
    if [ -f "$candidate" ]; then printf '%s\n' "$candidate"; return 0; fi
  done
  return 1
}

tools_ready() {
  command -v softhsm2-util >/dev/null 2>&1 && command -v pkcs11-tool >/dev/null 2>&1 && command -v script >/dev/null 2>&1 && MODULE=$(find_module) || return 1
  # The module path goes into the PKCS#11 URI and into the command line script runs, so it must need no quoting or escaping.
  case "$MODULE" in
    *[!A-Za-z0-9._/-]*) fail "the SoftHSM2 module path $MODULE has characters a PKCS#11 URI would need escaped; set STERLING_PKCS11_MODULE to a plain path" ;;
  esac
}

ensure_tools() {
  tools_ready && return 0
  if command -v apt-get >/dev/null 2>&1; then family=apt; manager=apt-get
  elif command -v dnf >/dev/null 2>&1; then family=dnf; manager=dnf
  else fail "softhsm2-util, pkcs11-tool, script or the SoftHSM2 module is missing and this machine has neither apt-get nor dnf; install SoftHSM2, OpenSC and util-linux from your OS packages, then run this again"
  fi
  names=$(package_names "$family")
  case "$names" in
    '' | *[!a-z0-9.+\ -]*) fail "no usable $family package names for $SELF in $PACKAGES_FILE" ;;
  esac
  if [ "$(id -u)" -eq 0 ]; then command="$manager install $names"; else command="sudo $manager install $names"; fi
  say "This needs SoftHSM2, OpenSC and util-linux's script from your OS vendor's signed packages ($names). The install command is:"
  say "  $command"
  printf 'Install them now? Type yes to continue: ' >&2
  read -r answer || answer=""
  [ "$answer" = yes ] || fail "nothing installed and nothing changed; install the packages yourself or run this again and type yes"
  # Word splitting is wanted here: the command and the checked package names.
  $command
  tools_ready || fail "the packages are installed but softhsm2-util, pkcs11-tool, script or the SoftHSM2 module is still missing; set STERLING_PKCS11_MODULE to the libsofthsm2.so path"
}

token_present() {
  slots=$(softhsm2-util --show-slots) || return 1
  printf '%s\n' "$slots" | grep -q "^ *Label: *$TOKEN_LABEL *\$"
}

key_present() {
  objects=$(pkcs11-tool --module "$MODULE" --token-label "$TOKEN_LABEL" --list-objects --type pubkey) || return 1
  printf '%s\n' "$objects" | grep -q "^ *label: *$KEY_LABEL\$"
}

# Reads the public key out of the token (no login: it is a public object) and sets PEM and URI.
read_public_key() {
  # There is no pipefail in POSIX sh, so the read is checked on its own first, then piped through base64.
  pkcs11-tool --module "$MODULE" --token-label "$TOKEN_LABEL" --read-object --type pubkey --label "$KEY_LABEL" --id "$KEY_ID" > /dev/null \
    || fail "pkcs11-tool could not read the public key $KEY_LABEL from token $TOKEN_LABEL"
  b64=$(pkcs11-tool --module "$MODULE" --token-label "$TOKEN_LABEL" --read-object --type pubkey --label "$KEY_LABEL" --id "$KEY_ID" | base64 | tr -d '\n') \
    || fail "could not encode the public key $KEY_LABEL read from token $TOKEN_LABEL"
  case "$b64" in
    "$P256_SPKI_PREFIX"*) ;;
    *) fail "the token did not return an EC P-256 public key for $KEY_LABEL" ;;
  esac
  [ "${#b64}" -eq 124 ] || fail "the token returned a public key of an unexpected length for $KEY_LABEL"
  PEM=$(printf '%s\n' '-----BEGIN PUBLIC KEY-----'; printf '%s' "$b64" | fold -w 64; printf '\n%s\n' '-----END PUBLIC KEY-----')
  URI="pkcs11:token=$TOKEN_LABEL;object=$KEY_LABEL;id=%01;type=private?module-path=$MODULE"
}

save_public_key() {
  if [ -f "$PUB" ]; then
    if [ "$(cat "$PUB")" != "$PEM" ]; then say "Note: $PUB holds a different public key; it was left as it is. Run with --rotate to archive it and start again."; fi
    return 0
  fi
  (set -C; printf '%s\n' "$PEM" > "$PUB")
}

print_key() {
  printf '%s\n' "$PEM" "$URI"
  say ""
  say "The public key is saved in $PUB. Put it in your site file as organizationPublicKey."
  say "The PKCS#11 URI above holds no PIN. To sign with this key, set:"
  say "  export SOFTHSM2_CONF=$CONF"
}

# Moves the configuration, the tokens folder and the saved public key into a new archive folder. Never deletes anything.
archive_existing() {
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  ARCHIVE=$SOFTHSM_DIR/.archive/$stamp
  n=1
  while [ -e "$ARCHIVE" ]; do ARCHIVE=$SOFTHSM_DIR/.archive/$stamp-$n; n=$((n + 1)); done
  mkdir -p "$SOFTHSM_DIR/.archive"
  mkdir "$ARCHIVE"
  for item in "$CONF" "$TOKENS" "$PUB"; do
    if [ -e "$item" ]; then mv "$item" "$ARCHIVE/"; fi
  done
  say "Archived the earlier token, its configuration and public key to $ARCHIVE (nothing was deleted)."
}

# Removes the temporary copy of pkcs11-tool's output, and only it, when the script exits.
SESSION_DIR=""
remove_session() {
  if [ -n "$SESSION_DIR" ]; then rm -f "$SESSION_DIR/session"; rmdir "$SESSION_DIR" 2>/dev/null || :; fi
}
trap remove_session EXIT
trap 'exit 1' HUP INT TERM

# Runs pkcs11-tool with the arguments given on a terminal of its own (script from util-linux), so that it can ask for the token PIN, and
# keeps a copy of what it prints in $SESSION_DIR/session. The terminal shows the prompt and the output as usual. Every argument is a fixed
# word or the checked module path; anything that would need quoting stops the script before anything runs.
pkcs11_on_terminal() {
  if [ -z "$SESSION_DIR" ]; then
    SESSION_DIR=$(mktemp -d "${TMPDIR:-/tmp}/new-dev-site-key.XXXXXX") || fail "could not make a temporary folder for pkcs11-tool's output"
  fi
  line=pkcs11-tool
  for word in "$@"; do
    case "$word" in
      '' | *[!A-Za-z0-9._/:-]*) fail "refusing to run pkcs11-tool with the argument $word" ;;
    esac
    line="$line $word"
  done
  SHELL=/bin/sh script -q -e -c "$line" "$SESSION_DIR/session" >&2
}

# Stops unless the private key $KEY_LABEL (id $KEY_ID) that pkcs11-tool printed in the session is sensitive and never extractable. OpenSC
# prints it with an Access line such as "sensitive, always sensitive, never extractable, local". A key that fails, or no such key, means
# the token is archived (moved, not deleted) so nothing uses it.
require_safe_private_key() {
  access=$(tr -d '\r' < "$SESSION_DIR/session" | awk -v want="$KEY_LABEL" -v wantid="$KEY_ID" '
    function close_object() { if (p && label == want && id == wantid && found == "") found = acc; p = 0 }
    /^[^ ]/ { close_object() }
    /^Private Key Object/ { p = 1; label = ""; id = ""; acc = ""; next }
    p && /^ *label:/ { sub(/^ *label: */, ""); label = $0 }
    p && /^ *ID:/ { sub(/^ *ID: */, ""); id = $0 }
    p && /^ *Access:/ { sub(/^ *Access: */, ""); acc = $0 }
    END { close_object(); print found }')
  list=", $access,"
  ok=yes
  case "$list" in *", sensitive,"*) ;; *) ok=no ;; esac
  case "$list" in *", never extractable,"*) ;; *) ok=no ;; esac
  case "$list" in *", extractable,"*) ok=no ;; esac
  if [ "$ok" = no ]; then
    archive_existing
    fail "the private key $KEY_LABEL in token $TOKEN_LABEL is extractable, not sensitive or not shown (Access: ${access:-not shown}), so it is not used; the token was archived. Check the SoftHSM2 and OpenSC versions and run this again"
  fi
}

create_key() {
  mkdir -p "$SOFTHSM_DIR"
  chmod 700 "$SOFTHSM_DIR"
  mkdir "$TOKENS"
  chmod 700 "$TOKENS"
  (set -C; printf '%s\n' "# SoftHSM2 configuration for the development organization site key, written by $SELF." \
    "directories.tokendir = $TOKENS" "objectstore.backend = file" "log.level = ERROR" "slots.removable = false" > "$CONF")

  say "Step 1 of 2: initialise the token $TOKEN_LABEL. softhsm2-util asks for a security officer (SO) PIN and then the token (user) PIN,"
  say "each twice. Use at least 4 characters and keep both in your password manager; this script never sees them."
  softhsm2-util --init-token --free --label "$TOKEN_LABEL" >&2 \
    || fail "softhsm2-util could not initialise the token. Left behind: the configuration file $CONF and the tokens folder $TOKENS; run sh $SELF --rotate to archive them and start again"

  say "Step 2 of 2: make the key inside the token. When pkcs11-tool asks, type the token (user) PIN and press Enter (it is not shown)."
  pkcs11_on_terminal --module "$MODULE" --token-label "$TOKEN_LABEL" --login --keypairgen --key-type EC:prime256v1 \
    --label "$KEY_LABEL" --id "$KEY_ID" --usage-sign --sensitive || fail "pkcs11-tool could not make the key; the token is in $TOKENS, and --rotate archives it"
  require_safe_private_key

  read_public_key
  save_public_key
  print_key
}

if [ "$MODE" = show ] && [ ! -e "$CONF" ]; then
  fail "no development site key yet in $BASE; run sh $SELF without --show to make one"
fi
if [ "$MODE" != rotate ] && [ ! -e "$CONF" ] && { [ -e "$TOKENS" ] || [ -e "$PUB" ]; }; then
  fail "an earlier, incomplete setup is in $BASE; run sh $SELF --rotate to archive it and make a new key"
fi

ensure_tools

if [ "$MODE" != rotate ] && [ -e "$CONF" ]; then
  if token_present && key_present; then
    if [ "$MODE" = show ]; then
      say "The development site key already exists in token $TOKEN_LABEL; nothing was changed. --show does not log in, so it did not check the private key; run sh $SELF without --show to check it."
    else
      say "The development site key already exists in token $TOKEN_LABEL. To check that its private key is sensitive and never extractable,"
      say "type the token (user) PIN when pkcs11-tool asks and press Enter (it is not shown)."
      pkcs11_on_terminal --module "$MODULE" --token-label "$TOKEN_LABEL" --login --list-objects --type privkey --label "$KEY_LABEL" --id "$KEY_ID" \
        || fail "pkcs11-tool could not log in to token $TOKEN_LABEL to check the private key; nothing was changed"
      require_safe_private_key
      say "The private key is sensitive and never extractable; nothing was changed."
    fi
    read_public_key
    save_public_key
    print_key
    exit 0
  fi
  fail "token $TOKEN_LABEL in $TOKENS has no key $KEY_LABEL (an earlier run stopped part way); run sh $SELF --rotate to archive it and make a new key"
fi

if [ "$MODE" = rotate ]; then
  if [ -e "$CONF" ] || [ -e "$TOKENS" ] || [ -e "$PUB" ]; then
    say "--rotate moves the current token, its configuration and $PUB to $SOFTHSM_DIR/.archive/ and makes a new key."
    say "Sites that trust the old public key must be given the new one."
    printf 'Archive the current key and make a new one? Type yes to continue: ' >&2
    read -r answer || answer=""
    [ "$answer" = yes ] || fail "nothing changed"
    archive_existing
  else
    say "There is no earlier token to archive; making the first key."
  fi
fi

create_key
