#!/bin/sh
# Turns certificate and host name checks back on in the operator's session URL probe (run by the Containerfile's build stage on the pinned
# upstream source, before Maven). Upstream Theia Cloud 1.2.0 (AddedHandlerUtil.updateSessionURLAsync) builds a trust-all SSLContext and an
# accept-any host name verifier for the probe, and installs that context as the JVM's default with
# HttpsURLConnection.setDefaultSSLSocketFactory, so every later HttpsURLConnection in the operator skipped certificate checks too.
# After this edit the probe uses an SSLContext with the JVM's default trust managers (the site truststore the image's ENTRYPOINT names) and
# the default host name check, and nothing changes the JVM default. Recorded as an upstream issue (47-15 summary, integration notes).
#
#   sh probe-tls.sh <AddedHandlerUtil.java>
#
# Refuses, changing nothing, unless each upstream line occurs exactly once (a different upstream version needs this script reviewed), and
# fails if any trust-all use survives the edit.
set -eu

FILE=${1:?usage: probe-tls.sh <AddedHandlerUtil.java>}
VERIFIER='connection.setHostnameVerifier(ALL_GOOD_HOSTNAME_VERIFIER);'
DEFAULT='HttpsURLConnection.setDefaultSSLSocketFactory(sc.getSocketFactory());'
TRUST_ALL='sc.init(null, new TrustManager[] { TRUST_ALL_MANAGER }, new java.security.SecureRandom());'
DEFAULT_TRUST='sc.init(null, null, new java.security.SecureRandom());'

for line in "$VERIFIER" "$DEFAULT" "$TRUST_ALL"; do
  count=$(grep -c -F -- "$line" "$FILE" || true)
  if [ "$count" != 1 ]; then
    echo "probe-tls: expected exactly one line '$line' in $FILE, found $count; the upstream source changed, review this script." >&2
    exit 1
  fi
done

TMP="$FILE.probe-tls"
sed -e '/^[[:space:]]*connection\.setHostnameVerifier(ALL_GOOD_HOSTNAME_VERIFIER);[[:space:]]*$/d' \
    -e '/^[[:space:]]*HttpsURLConnection\.setDefaultSSLSocketFactory(sc\.getSocketFactory());[[:space:]]*$/d' \
    -e 's/sc\.init(null, new TrustManager\[\] { TRUST_ALL_MANAGER }, new java\.security\.SecureRandom());/sc.init(null, null, new java.security.SecureRandom());/' \
    "$FILE" > "$TMP"

if grep -n -E 'setHostnameVerifier|setDefaultSSLSocketFactory|\{ TRUST_ALL_MANAGER \}' "$TMP" >&2; then
  rm -f "$TMP"
  echo "probe-tls: a trust-all use is still in $FILE after the edit." >&2
  exit 1
fi
if [ "$(grep -c -F -- "$DEFAULT_TRUST" "$TMP" || true)" != 1 ]; then
  rm -f "$TMP"
  echo "probe-tls: the probe's SSLContext does not use the default trust managers after the edit." >&2
  exit 1
fi
mv "$TMP" "$FILE"
echo "probe-tls: the session URL probe verifies certificates and host names with the JVM's default trust."
