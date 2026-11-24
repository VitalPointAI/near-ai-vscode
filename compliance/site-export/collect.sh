#!/bin/sh
# Read-only collection of deployment evidence on a site (48-02, D-16). An operator runs this on a host with access to the site, then turns the
# folder into a signed export with `node compliance/src/cli.ts site-export`. Every command here only reads: kubectl get and exec of a read
# command, kcadm.sh get, bao status and bao read, cosign verify and cosign verify-attestation, a GET count query to the log store, and a read
# of /proc/sys/crypto/fips_enabled on each node over the operator's SSH access. No pod or other object is started or changed on the site.
# Credentials come from the operator's environment (kubeconfig, an earlier `kcadm.sh config credentials`, BAO_ADDR and BAO_TOKEN, a curl
# config file for the log store, SSH keys), never from this repository. The collected folder holds raw site data: keep it on the site and
# remove it once the export is made; only the export leaves.
#
# Usage: collect.sh --out <empty folder>
#
# Settings (environment):
#   KEYCLOAK_REALM            the site realm
#   KCADM                     the Keycloak admin CLI to run (default kcadm.sh; for example "kubectl exec -n <ns> <pod> -- /opt/keycloak/bin/kcadm.sh")
#   KCADM_CONFIG              optional kcadm.sh config file from `kcadm.sh config credentials`
#   AUDIT_POLICY_HOST         an RKE2 server node reachable over SSH
#   AUDIT_POLICY_PATH         its audit policy file (default /etc/rancher/rke2/audit-policy.yaml)
#   SSH                       the SSH command (default "ssh -o BatchMode=yes"); NODE_SSH_USER optional user for node addresses
#   IMAGE_LOCK                the image lock list (default deploy/bundle/images.lock.json)
#   COSIGN_PUBLIC_KEY         your organization's cosign public key file
#   SBOM_TYPE                 cosign attestation type of the SBOM (default spdxjson)
#   PROVENANCE_TYPE           cosign attestation type of the provenance (default slsaprovenance1)
#   LOG_STORE_URL             the log store address (OpenSearch)
#   LOG_STORE_CURL_CONFIG     optional curl config file holding the log store credentials
#   LOG_TIME_FIELD            the time field of the log records (default @timestamp)
#   KEYCLOAK_EVENTS_INDEX, OPENBAO_AUDIT_INDEX, KUBERNETES_AUDIT_INDEX, REGISTRY_AUDIT_INDEX   the log store index of each stream
#   REGISTRY_KIND             zot or harbor
#   KYVERNO_POLICY_KINDS      default clusterpolicies.kyverno.io,imagevalidatingpolicies.policies.kyverno.io
#   POLICY_REPORT_KINDS       default policyreports.wgpolicyk8s.io,clusterpolicyreports.wgpolicyk8s.io
#   SESSION_NAMESPACE, SESSION_SELECTOR   where the running session pods are and their label selector
#   SESSION_CONTAINER         optional container name in a session pod; SESSION_SAMPLE how many pods to sample (default 5)
# Tools: kubectl, jq (1.6 or later), curl, cosign, bao, ssh, and the Keycloak admin CLI.
set -eu

fail() { printf 'collect.sh: %s\n' "$1" >&2; exit 1; }
usage() { printf 'usage: collect.sh --out <empty folder>\n' >&2; exit 2; }

OUT=''
while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || usage; OUT=$2; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$OUT" ] || usage

for name in KEYCLOAK_REALM AUDIT_POLICY_HOST COSIGN_PUBLIC_KEY LOG_STORE_URL KEYCLOAK_EVENTS_INDEX OPENBAO_AUDIT_INDEX KUBERNETES_AUDIT_INDEX \
  REGISTRY_AUDIT_INDEX REGISTRY_KIND SESSION_NAMESPACE SESSION_SELECTOR; do
  eval "value=\${$name:-}"
  [ -n "$value" ] || fail "set $name"
done
for tool in kubectl jq curl cosign bao; do command -v "$tool" >/dev/null 2>&1 || fail "$tool is not on PATH"; done

KCADM=${KCADM:-kcadm.sh}
AUDIT_POLICY_PATH=${AUDIT_POLICY_PATH:-/etc/rancher/rke2/audit-policy.yaml}
SSH=${SSH:-ssh -o BatchMode=yes}
IMAGE_LOCK=${IMAGE_LOCK:-deploy/bundle/images.lock.json}
SBOM_TYPE=${SBOM_TYPE:-spdxjson}
PROVENANCE_TYPE=${PROVENANCE_TYPE:-slsaprovenance1}
LOG_TIME_FIELD=${LOG_TIME_FIELD:-@timestamp}
KYVERNO_POLICY_KINDS=${KYVERNO_POLICY_KINDS:-clusterpolicies.kyverno.io,imagevalidatingpolicies.policies.kyverno.io}
POLICY_REPORT_KINDS=${POLICY_REPORT_KINDS:-policyreports.wgpolicyk8s.io,clusterpolicyreports.wgpolicyk8s.io}
SESSION_SAMPLE=${SESSION_SAMPLE:-5}

if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT")" ]; then fail "$OUT is not empty"; fi
umask 077
mkdir -p "$OUT"

# ---- Keycloak: the realm with the executions of every flow it binds, the server info, and the client ids only.
kc() { $KCADM get "$@" ${KCADM_CONFIG:+--config "$KCADM_CONFIG"}; }
realm=$(kc "realms/$KEYCLOAK_REALM")
flows='{}'
for field in browserFlow registrationFlow directGrantFlow resetCredentialsFlow clientAuthenticationFlow dockerAuthenticationFlow firstBrokerLoginFlow; do
  alias=$(printf '%s' "$realm" | jq -r --arg f "$field" '.[$f] // empty')
  [ -n "$alias" ] || continue
  encoded=$(jq -rn --arg a "$alias" '$a | @uri')
  executions=$(kc "authentication/flows/$encoded/executions" -r "$KEYCLOAK_REALM")
  flows=$(printf '%s' "$flows" | jq --arg a "$alias" --argjson e "$executions" '.[$a] = $e')
done
printf '%s' "$realm" | jq --argjson f "$flows" '{realm: ., flowExecutions: $f}' > "$OUT/keycloak-realm.json"
kc serverinfo -r "$KEYCLOAK_REALM" > "$OUT/keycloak-serverinfo.json"
kc clients -r "$KEYCLOAK_REALM" --fields clientId > "$OUT/keycloak-clients.json"

# ---- OpenBao: seal status (exit code 2 means sealed, still a valid status) and the enabled audit devices.
status_code=0
bao status -format=json > "$OUT/openbao-status.json" || status_code=$?
[ "$status_code" -eq 0 ] || [ "$status_code" -eq 2 ] || fail 'bao status failed'
bao read -format=json sys/audit > "$OUT/openbao-audit.json"

# ---- Kubernetes: the audit policy file on a server node, and fips_enabled on every node.
$SSH "$AUDIT_POLICY_HOST" cat "$AUDIT_POLICY_PATH" < /dev/null > "$OUT/kubernetes-audit-policy.yaml"
nodes='[]'
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.addresses[?(@.type=="InternalIP")].address}{"\n"}{end}' > "$OUT/.nodes"
while read -r node address; do
  [ -n "$node" ] || continue
  [ -n "$address" ] || fail "node $node has no internal address"
  fips=$($SSH "${NODE_SSH_USER:+$NODE_SSH_USER@}$address" cat /proc/sys/crypto/fips_enabled < /dev/null | tr -d '[:space:]')
  nodes=$(printf '%s' "$nodes" | jq --arg n "$node" --arg f "$fips" '. + [{node: $n, fipsEnabled: $f}]')
done < "$OUT/.nodes"
rm -f "$OUT/.nodes"
printf '%s' "$nodes" | jq '{nodes: .}' > "$OUT/nodes-fips.json"

# ---- Kyverno: admission policies and policy reports.
kubectl get "$KYVERNO_POLICY_KINDS" -o json > "$OUT/kyverno-clusterpolicies.json"
kubectl get "$POLICY_REPORT_KINDS" -A -o json > "$OUT/kyverno-policyreports.json"

# ---- Images: for each digest in the lock list, the cosign signature check and the verified attestation statements (subjects and type only).
statements() { jq -c -s 'map(.payload | @base64d | fromjson | {predicateType, subject})'; }
images='[]'
for ref in $(jq -r '[.. | objects | select(has("ref")) | .ref | strings | select(test("@sha256:[0-9a-f]{64}$"))] | unique | .[]' "$IMAGE_LOCK"); do
  signature=$(cosign verify --key "$COSIGN_PUBLIC_KEY" --insecure-ignore-tlog=true "$ref" 2>/dev/null) || signature=null
  printf '%s' "$signature" | jq -e . >/dev/null 2>&1 || signature=null
  sbom=$(cosign verify-attestation --key "$COSIGN_PUBLIC_KEY" --insecure-ignore-tlog=true --type "$SBOM_TYPE" "$ref" 2>/dev/null | statements) || sbom=null
  provenance=$(cosign verify-attestation --key "$COSIGN_PUBLIC_KEY" --insecure-ignore-tlog=true --type "$PROVENANCE_TYPE" "$ref" 2>/dev/null | statements) || provenance=null
  images=$(printf '%s' "$images" | jq --arg r "$ref" --argjson s "$signature" --argjson b "$sbom" --argjson p "$provenance" '. + [{ref: $r, signature: $s, sbom: $b, provenance: $p}]')
done
printf '%s' "$images" | jq '{images: .}' > "$OUT/images.json"

# ---- Session pods: crypto.getFips() in a sample of running sessions.
samples='[]'
kubectl get pods -n "$SESSION_NAMESPACE" -l "$SESSION_SELECTOR" --field-selector=status.phase=Running -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' | head -n "$SESSION_SAMPLE" > "$OUT/.pods"
while read -r pod; do
  [ -n "$pod" ] || continue
  fips=$(kubectl exec -n "$SESSION_NAMESPACE" "$pod" ${SESSION_CONTAINER:+-c "$SESSION_CONTAINER"} -- node -p 'crypto.getFips()' < /dev/null | tr -d '[:space:]')
  samples=$(printf '%s' "$samples" | jq --arg p "$pod" --arg f "$fips" '. + [{pod: $p, getFips: $f}]')
done < "$OUT/.pods"
rm -f "$OUT/.pods"
printf '%s' "$samples" | jq '{samples: .}' > "$OUT/workbench-fips.json"

# ---- Last-day counts from the log store: one GET _count per stream.
count_of() {
  curl -sS --fail -G ${LOG_STORE_CURL_CONFIG:+-K "$LOG_STORE_CURL_CONFIG"} --data-urlencode "q=$LOG_TIME_FIELD:[now-1d TO now]" "$LOG_STORE_URL/$1/_count"
}
jq -n --arg kind "$REGISTRY_KIND" \
  --argjson keycloak "$(count_of "$KEYCLOAK_EVENTS_INDEX")" --argjson openbao "$(count_of "$OPENBAO_AUDIT_INDEX")" \
  --argjson kubernetes "$(count_of "$KUBERNETES_AUDIT_INDEX")" --argjson registry "$(count_of "$REGISTRY_AUDIT_INDEX")" \
  '{windowHours: 24, registryKind: $kind, streams: {keycloak: $keycloak, openbao: $openbao, kubernetes: $kubernetes, registry: $registry}}' > "$OUT/counts.json"

printf 'collect.sh: collected into %s\n' "$OUT"
