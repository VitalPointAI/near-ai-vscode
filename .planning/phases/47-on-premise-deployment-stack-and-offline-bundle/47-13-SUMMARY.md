---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 13
subsystem: deploy
status: complete
tags: [pki, cert-manager, openbao, vault-issuer, bootstrap-ca, haproxy, ingress, smart-cards, trust]
requires: [47-05, 47-07]
provides:
  - "deploy/charts/sterling-pki-bootstrap (order 32): ClusterIssuer site-bootstrap-ca (CA type on Secret site-bootstrap-ca) and OpenBao's first Certificate openbao-tls"
  - "deploy/charts/sterling-pki (order 46): ClusterIssuers site-pki (pki_int/sign/ingress) and site-pki-hub (pki_int/sign/hub), vault type with kubernetes auth through ServiceAccount openbao-issuer; ConfigMap sterling-site-ca (ca.crt, truststore.p12) in ten namespaces; Secret sterling-site-ca (tls.crt) for HAProxy backend checks; Certificates openbao-tls, zot-tls, keycloak-tls, opensearch-tls from site-pki"
  - "Per-site deploy/values/site.example/sterling-pki.yaml: siteCaChain, bootstrapCaCertificate, siteCaTruststore, certificates"
  - "deploy/openbao/policies/cert-manager.hcl; apply.mjs: auth/kubernetes, role cert-manager (CERT_MANAGER), SERVICE_DOMAINS on the ingress role, pki_int/config/crl expiry (site crlExpiry, default 720h)"
  - "HAProxy values: default ingress class haproxy, NodePort 30080/30443 per site, no QUIC/stat/admin, smartCards switch (client-ca + client-crt-optional)"
  - "Keycloak Ingress at keycloak.<domain> (keycloak-tls, re-encrypt verified with the site chain, Client-Cert headers always overwritten)"
  - "deploy/test/render-pki.test.mjs"
affects: [47-14, 47-15, 47-16, 47-17, 47-18]
tech-stack:
  added: []
  patterns:
    - "Vault-type ClusterIssuer with a dedicated token-request service account (serviceAccountRef + extra audience) instead of the controller's own token"
    - "One trust bundle (site chain plus the bootstrap CA only while in use) feeds the issuers' caBundle and every sterling-site-ca"
key-files:
  created:
    - deploy/charts/sterling-pki-bootstrap/Chart.yaml
    - deploy/charts/sterling-pki-bootstrap/values.yaml
    - deploy/charts/sterling-pki-bootstrap/templates/issuer.yaml
    - deploy/values/sterling-pki-bootstrap.release.json
    - deploy/charts/sterling-pki/Chart.yaml
    - deploy/charts/sterling-pki/values.yaml
    - deploy/charts/sterling-pki/templates/_helpers.tpl
    - deploy/charts/sterling-pki/templates/issuers.yaml
    - deploy/charts/sterling-pki/templates/trust.yaml
    - deploy/charts/sterling-pki/templates/certificates.yaml
    - deploy/values/sterling-pki.yaml
    - deploy/values/sterling-pki.release.json
    - deploy/values/site.example/sterling-pki.yaml
    - deploy/values/site.example/kubernetes-ingress.yaml
    - deploy/openbao/policies/cert-manager.hcl
    - deploy/test/render-pki.test.mjs
  modified:
    - deploy/openbao/apply.mjs
    - deploy/values/cert-manager.yaml
    - deploy/values/kubernetes-ingress.yaml
    - deploy/values/kubernetes-ingress.release.json
    - deploy/values/keycloakx.yaml
    - deploy/values/site.example.yaml
key-decisions:
  - "Spike S4 passed: cert-manager v1.21.3's vault issuer works against OpenBao 2.7.3 pki_int with kubernetes auth (ClusterIssuers Ready, reason VaultVerified); no fallback to an exported intermediate key was needed (research A8 confirmed, owner-confirm E2 model kept)"
  - "cert-manager logs in with a dedicated ServiceAccount openbao-issuer (only the controller may request its token, audience sterling-openbao-pki), not the controller's own token"
  - "The ingress role also allows the in-cluster names of the services that serve site TLS (SERVICE_DOMAINS: sterling-openbao, sterling-identity, sterling-logging, sterling-registry .svc and .svc.cluster.local, and openbao-internal for the Raft peers); without them Postgres's, OpenBao's and OpenSearch's certificates could not be issued"
  - "The ingress role has client_flag on, because OpenSearch's nodes present opensearch-tls to each other; OpenBao then puts clientAuth in every certificate of that role (seen in the lab)"
  - "Both PKI releases declare Certificate openbao-tls, so the install script removes sterling-pki-bootstrap just before installing sterling-pki; the Secret stays and is re-issued in place"
  - "harbor-tls comes from the Harbor Ingress annotation (cert-manager.io/cluster-issuer: site-pki, 47-10); the test asserts every such annotation names site-pki"
  - "HAProxy Kubernetes Ingress 3.4.1 sets client-certificate verification on the whole HTTPS frontend (client-ca is a ConfigMap setting), so with smart cards on every host asks for a certificate (optional); only the Keycloak Ingress forwards it"
  - "The pki_int revocation list lasts 720h (30 days) by default, site setting crlExpiry, at least a day (47-14's note: OpenBao's 72-hour default would expire before media reaches an edge site)"
requirements-completed: [DEP-03]
duration: ~4h
completed: 2026-11-24
estimate:
  tokens: 85000
  tasks: 3
actuals:
  tokens: 14400
  tasks: 3
  commits: 3
plan_head_before: 4ee42c0b9b68f47672f51c4fdaed223b79d707f2
plan_head_after: c7525964
---

# Phase 47 Plan 13: Ingress and certificates Summary

**In the air-gapped lab, cert-manager signed every site certificate through OpenBao's pki_int with a vault-type issuer (the intermediate's key never left OpenBao: none of the cluster's 29 Secrets holds it), HAProxy served a site-pki certificate that verified against the lab HQ root alone and refused TLS 1.1, and the bootstrap CA was retired after OpenBao and the registry were re-issued from the site PKI and kept working.**

## Tasks

| Task | Result | Commit |
|---|---|---|
| 1. Spike S4 end to end (tracer): bootstrap CA, pki_int, vault issuers, HAProxy | done; tracer gate re-ran the render check before expanding | `990c3319` |
| 2. Trust, re-issue after bootstrap, certificate invariants (TDD) | done | `c7525964` |
| 3. HAProxy values with the smart-card switch off | done | `9dccb420` |

## Spike S4

Lab VM by `deploy/lab/vm.sh` (Rocky 9.9 GenericCloud, FIPS on, `restrict=on`, the shared heavy-run lock), RKE2 1.37.2 installed with
`install-node.sh`, Zot from its preloaded archive with the registry's first certificate made with openssl from a 90-day bootstrap CA,
then a haul of the cert-manager, HAProxy, Kyverno and `sterling/openbao` images, each signed with the lab key, with Kyverno admission in
Deny. OpenBao: one node, Shamir seal (the seal was S5's subject), TLS from `openbao-tls`.

```
guest: curl https://registry.access.redhat.com/v2/ -> (6) Could not resolve host; curl http://1.1.1.1/ -> (7) Connection refused
sterling-pki-bootstrap: clusterissuer site-bootstrap-ca True "Signing CA verified"; certificate sterling-openbao/openbao-tls True
OpenBao: Initialized true, Sealed false, Version 2.7.3
apply.mjs run 1: 19 written (incl. auth kubernetes/, kubernetes config, kubernetes role cert-manager, policy cert-manager); run 2 and 3: all unchanged
pki_int/intermediate/generate/internal -> CSR "CN=Sterling lab site intermediate"
host: openssl x509 -req ... -CA hq-root.crt (lab HQ root, P-384, kept on the host: standing in for the offline root ceremony)
      basicConstraints critical CA:TRUE pathlen:0; openssl verify -CAfile hq-root.crt intermediate.crt -> OK
pki_int/intermediate/set-signed (intermediate + root) -> issuers: intermediate (with key, default) and root (no key)
sterling-pki issuers: site-pki True "Vault verified"; site-pki-hub True "Vault verified"
Certificate sterling-registry/test-tls (test.lab.internal) from site-pki -> Ready
  subject CN=test.lab.internal, issuer CN=Sterling lab site intermediate, 90 days
HAProxy (kubernetes-ingress, NodePort 30443), Ingress s4-test -> zot with server-ssl
host: curl --cacert hq-root.crt --resolve test.lab.internal:18443:127.0.0.1 https://test.lab.internal:18443/v2/   (SSH forward to 10.0.2.15:30443)
  -> HTTP/2 200, ssl_verify_result 0, TLSv1.3, subject CN=test.lab.internal, issuer CN=Sterling lab site intermediate
openssl s_client -tls1_1 -> alert protocol version (70); -tls1_2 -> ECDHE-ECDSA-AES128-GCM-SHA256, verify 0
Secrets (kubectl get secrets -A, every data value tried as a private key, compared with pki_int/ca/pem's public key):
  secrets 27, private keys 9 (cert-manager-webhook-ca, site-bootstrap-ca, kubernetes-ingress-default-cert, rke2-serving, two Kyverno,
  openbao-tls, test-tls, zot-tls), matching the intermediate: 0
```

### Handover and retirement (Task 2 in the same lab)

```
trust during handover: node registry CA and Kyverno's CA = site chain + bootstrap CA
kubectl delete -f sterling-pki-bootstrap.yaml (ClusterIssuer and Certificate; the Secrets stay); kubectl apply sterling-pki (full)
certificates Ready, all issuer site-pki: sterling-identity/keycloak-tls, sterling-logging/opensearch-tls, sterling-openbao/openbao-tls,
  sterling-registry/zot-tls (adopted the install script's Secret), sterling-registry/test-tls
ConfigMap sterling-site-ca in 10 namespaces (cert-manager, haproxy-controller, kyverno, sterling-hubs, sterling-identity,
  sterling-log-shipper, sterling-logging, sterling-openbao, sterling-registry, theia-cloud)
restart OpenBao (unseal) and Zot: OpenBao /v1/sys/health with the site chain only -> 200, served issuer CN=Sterling lab site intermediate;
  registry /v2/ with the site chain only -> 200, served issuer CN=Sterling lab site intermediate
retire: sterling-pki re-applied with bootstrapCaCertificate "", Secret site-bootstrap-ca deleted, node and Kyverno trust the site chain only
  ConfigMaps still holding the bootstrap CA: 0; site-pki caBundle: 2 certificates (root, intermediate)
  test-tls Secret deleted -> re-issued Ready from site-pki; site-pki and site-pki-hub VaultVerified
  a signed image removed from containerd, then a pod with it: Pulled from the registry and Started (Kyverno admitted it on the site chain)
  secrets 29, private keys 10, matching the intermediate: 0
```

## Verification

- `render-pki.test.mjs` with the pinned helm, under the memory cap: 6 cases, all added by this plan. Run together with render, rke2,
  openbao, render-site, render-stateful, render-sessions and realm tests: 56 run; the one failure was this test finding two real
  issuer problems (next deviation), fixed; final run of render-pki, render, render-sessions and openbao: 30 run, 30 pass. Tests added: 6
  (all in render-pki.test.mjs). The commits were made in the order Task 1, Task 3, Task 2, so each commit is green.
- `node --check deploy/openbao/apply.mjs`; the rendered sterling-pki contains `pki_int/sign/ingress`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The ingress role could not sign any in-cluster name**
- `allowed_domains` was only the site domain, so `sterling-postgres.sterling-identity.svc` (47-11), OpenBao's and OpenSearch's
  certificates would have been refused. Added SERVICE_DOMAINS (named namespaces only, not all of `svc`) and `openbao-internal` for the
  Raft peers' short names (`retry_join` uses `openbao-<n>.openbao-internal`). Proven in the lab.

**2. [Rule 2 - Missing critical] Keycloak had no Ingress and no certificate**
- `keycloakx.yaml` (47-08) serves `keycloak-tls` but nothing issued it and nothing published `keycloak.<domain>`. sterling-pki issues
  keycloak-tls; `keycloakx.yaml` gains the Ingress (outside this plan's file list; 47-14 does not touch it). HAProxy verifies Keycloak with
  the site chain through Secret sterling-site-ca (HAProxy reads backend CAs only from Secrets) and overwrites Client-Cert and
  Client-Cert-Chain from what it verified, so a header a browser sends never reaches Keycloak.

**3. [Rule 2] opensearch-tls and harbor-tls**
- The wave-4 note says 47-13 provides them: opensearch-tls is a Certificate here (client auth too, for nodes_dn); harbor-tls is issued by
  site-pki through the Harbor Ingress annotation.

**4. [Rule 3 - Blocking] Lab only**
- The IPv4 lab VM has no default route, and RKE2 refuses to start without one: a route via 10.0.2.2 was added (QEMU still refuses every
  outside connection). Node 26 needed libatomic, copied from the host. The first VM run (5G guest under the 6G cap) was killed by the
  cap's OOM killer after 26 minutes; the rerun used a 4608M guest on the same disk. Restarting vm.sh on an existing disk gives cloud-init a
  new instance id, which reboots the guest once more about three minutes later.
- HAProxy's chart default request (2Gi) did not fit the lab node; the per-site example sets 256Mi/1Gi.

**5. Per-site switch is a Secret, not a ConfigMap**
- HAProxy's `client-ca` reads a Secret (key tls.crt); the plan said a ConfigMap. Keycloak's side (the haproxy lookup provider, verified
  against the Keycloak 26.8.2 reverse proxy guide) is listed in the site example as steps for turning smart cards on, not set here.

**6. [Rule 1 - Bug] Two Theia Cloud certificates named issuers that never issue (found by the new test)**
- theia-cloud's Ingress asked cert-manager for `letsencrypt-prod` (an ACME issuer name) and theia-cloud-crds' conversion webhook
  certificate named `theia-cloud-selfsigned-issuer`, a CA issuer whose CA certificate nothing issues once the base chart's self-signing
  issuer is off: the CRD conversion webhook would never have had a certificate. Both now name `site-pki` (one line each in
  `deploy/values/theia-cloud.yaml` and `theia-cloud-crds.yaml`, 47-15's files, same executor). The ingress role allows the `theia-cloud`
  service names and `conversion.cert` (the chart's fixed common name `crd.conversion.cert`). The base chart's own CA issuer and its CA
  certificate stay rendered (unconditional upstream templates) and are asserted inert.

**7. From 47-14 (coordinator): the revocation list lifetime**
- apply.mjs writes `pki_int/config/crl` expiry from the optional site setting `crlExpiry` (default 720h, at least a day); added to
  `site.example.yaml` and tested. Not yet run against the lab OpenBao (47-15's lab session runs apply again).

## Findings for other plans

- **Blocker for 47-05/47-16: the registry cannot restart under Deny.** Deleting `zot-0` left it uncreatable: Kyverno's
  `site-images-signed` looks the signature up in the registry that is down ("failed to get imagedata: dial tcp 10.0.2.15:30500: connect:
  connection refused") and the registry image itself has no signature in the registry. Any node drain or pod loss stops the site's
  registry. The lab worked around it by setting the policy to Audit for the restart. Fix (outside this plan): exclude the registry's own
  namespace from the signature policy (its image is pinned by digest in pins.sha256) or otherwise break the loop.
  **Fixed in the wave 5 integration** (exact-digest admission of the Zot pod in sterling-registry only; lab check pending for 47-18, Harbor
  still open): see 47-15-SUMMARY.md, "Wave 5 integration".
- **47-16 install:** at handover the node's `/etc/rancher/rke2/site-ca.crt` and Kyverno's `admissionController.caCertificates` must hold
  the site chain plus the bootstrap CA; at retire-bootstrap only the site chain (containerd reads the file per pull; Kyverno needs a
  restart). Then: remove the sterling-pki-bootstrap release, install sterling-pki, restart OpenBao (unseal) and the registry, clear
  bootstrapCaCertificate, re-apply, delete Secret site-bootstrap-ca. `siteCaTruststore` (password-less PKCS12 of the chain) is made by the
  install script.
- **47-16:** the HAProxy Service changes when re-applied with kubectl (nodePort merge); the install uses helm, which does not hit it.
- The openbao-tls `ca.crt` from the vault issuer is the root (top of the chain); Raft `leader_ca_cert_file` reads it. Untested with 3 nodes.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: header-trust | deploy/values/keycloakx.yaml | With smart cards on, Keycloak reads the client certificate from a header; a pod that reaches Keycloak directly could send one. The site example requires a NetworkPolicy (Keycloak reachable only from HAProxy and its own namespace) before turning smart cards on. Off by default. |
| threat_flag: forwarded-headers (fixed after this plan, with 47-15) | deploy/values/kubernetes-ingress.yaml, deploy/values/keycloakx.yaml | Phase 46 finding: HAProxy passed a client's X-Forwarded-Uri on, and oauth2-proxy matched its sign-in exemptions against it. HAProxy now sets X-Forwarded-For, -Host, -Proto and -Uri itself on every request (forwarded-for off), and the Keycloak Ingress, whose own request-set-header replaces the controller's, repeats them. render-pki asserts both; the live check is in 47-15-SUMMARY.md. |
| threat_flag: eku | deploy/openbao/apply.mjs | client_flag on the ingress role puts clientAuth in every site-pki certificate; no service in the stack accepts site-PKI client certificates today. |

## Known Stubs

None. `siteCaChain`, `bootstrapCaCertificate` and `siteCaTruststore` are empty in the example on purpose (each site's own, written by
the install script and 47-14's import-intermediate); empty trusts nothing and fails closed.

## Self-Check: PASSED

PASSED: all 8 key created files exist; commits 990c3319, 9dccb420, c7525964 are on HEAD (3 commits since 4ee42c0b).
