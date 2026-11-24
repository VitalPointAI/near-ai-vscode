---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 15
subsystem: deploy
status: complete
tags: [theia-cloud, oauth2-proxy, chart-patch, pod-security, kyverno, trusted-proxy, spike-s7]
requires: [47-05, 47-06, 47-09, 47-12, 47-13]
provides:
  - "deploy/charts/patches/theia-cloud-oauth2.patch (oauth2-proxy ConfigMap with alpha config and trusted proxies; service client secret from Secret; restricted security contexts; landing page mount path) and theia-cloud-crds.patch (webhook security context and pull policy)"
  - "deploy/charts/vendored/theia-cloud-1.2.0-sterling.tgz and theia-cloud-crds-1.2.0-sterling.tgz, lock field patch { file, output, sha256 }"
  - "vendor.mjs patch step (exact-context apply, deterministic ustar + gzip, --check re-applies offline); render.mjs and build.mjs use patch.output"
  - "Theia Cloud values: Keycloak wiring, hosts, sessionsPerUser 1, eagerStart off, site class and size, persistence on, site-pki ingress certificates, operator.oAuth2ProxyVersion = the whole oauth2-proxy reference by digest"
  - "deploy/values/site.example/theia-cloud.yaml (host prefixes, start page texts, sterling.trustedProxyIps)"
  - "sterling-sessions NetworkPolicy sterling-session-ingress (sessions reachable only from HAProxy and the operator)"
  - "deploy/test/render-theia.test.mjs"
affects: [47-16, 47-17, 47-18]
tech-stack:
  added: []
  patterns:
    - "Carried chart patch: a unified diff applied by vendor.mjs to the hash-checked upstream tarball, repackaged deterministically, both hashes in the lock"
key-files:
  created:
    - deploy/charts/patches/theia-cloud-oauth2.patch
    - deploy/charts/patches/theia-cloud-crds.patch
    - deploy/charts/vendored/theia-cloud-1.2.0-sterling.tgz
    - deploy/charts/vendored/theia-cloud-crds-1.2.0-sterling.tgz
    - deploy/values/site.example/theia-cloud.yaml
    - deploy/charts/sterling-sessions/templates/session-network-policy.yaml
    - deploy/test/render-theia.test.mjs
  modified:
    - deploy/charts/vendor.mjs
    - deploy/charts/charts.lock.json
    - deploy/bundle/lib/render.mjs
    - deploy/bundle/build.mjs
    - deploy/values/theia-cloud.yaml
    - deploy/values/theia-cloud.release.json
    - deploy/values/theia-cloud-base.yaml
    - deploy/values/theia-cloud-crds.yaml
    - deploy/charts/sterling-sessions/values.yaml
    - deploy/openbao/apply.mjs
key-decisions:
  - "Spike S7 passed: under Pod Security restricted, our operator created a person's session pod from our template (sterling-session label, envFrom sterling-site-env, restricted contexts, no service account token), Kyverno admitted its signed images, the workspace PVC bound, oauth2-proxy ran by digest with IfNotPresent; a launch naming a Secret was refused by sterling-session-env and the session ended in ERROR"
  - "The operator accepts the whole reference in --oAuth2ProxyVersion (the template's image line is placeholder-oauth2-proxy-version): the pod ran registry/sterling/oauth2-proxy@sha256:..."
  - "With --alpha-config, oauth2-proxy v7.15.6 reads the legacy file with its core options only (UnmarshalExact) and refuses pass_access_token, set_xauthrequest, provider, client_*, upstreams, http_address; those settings are in the alpha part (injectRequestHeaders, providers, upstreamConfig, server)"
  - "Every Theia Cloud workload (operator, service, landing page, conversion webhook) had no security context and was refused by Pod Security restricted; the patch adds them (the plan's one-file patch became four files in theia-cloud and one in theia-cloud-crds)"
  - "The service read the OIDC client secret from ConfigMap service-config; it now comes from Secret oauth2-proxy-secrets (env beats envFrom), and the ConfigMap shows only a placeholder text"
  - "Trusted proxies (blocker from Phase 46): oauth2-proxy trusts X-Forwarded-* only from sterling.trustedProxyIps (per site, the pod network by default; render fails on none, 0.0.0.0/0 or ::/0); HAProxy overwrites X-Forwarded-For/-Host/-Proto/-Uri; a NetworkPolicy lets only HAProxy and the operator reach a session"
  - "The operator's activity monitor reaches the app container directly through the session's -int Service (port 3001 to the app port), so the workbench must listen on the pod IP (STERLING_LISTEN_HOST), not only loopback"
requirements-completed: [DEP-06]
duration: ~3h
completed: 2026-11-24
estimate:
  tokens: 90000
  tasks: 3
actuals:
  tokens: 16000
  tasks: 3
  commits: 4
plan_head_before: 35d8a5bab2a7c6b2b8e70c79b8475a44bae4fa33
plan_head_after: 3ef10383
---

# Phase 47 Plan 15: Theia Cloud deployment Summary

**In the air-gapped lab, Theia Cloud 1.2.0 from our patched charts and rebuilt images ran under Pod Security restricted: our operator created a person's hardened session pod with its workspace volume, oauth2-proxy started from our alpha configuration with the site CA, a launch naming a Secret was refused by policy, and a forged X-Forwarded-Uri no longer skips sign-in (it did before the fix, through HAProxy and from another pod).**

## Tasks

| Task | Result | Commit |
|---|---|---|
| 1. Spike S7 end to end (tracer): operator template, restricted admission, Secret-naming launch refused | done; tracer gate re-ran the render check before expanding | `b8005a17` |
| 2. The carried chart patches, applied and hashed by the vendor step | done | `f59e9bf9` |
| 3. The rest of the values, the RBAC review, the render invariants (TDD) | done | `3ef10383` |
| Security fix (coordinator, Phase 46 finding): forwarded headers | done, in 47-13's ingress files and this plan's patch | `3bf9782e` (ingress), `f59e9bf9` (patch, NetworkPolicy), `3ef10383` (tests) |

## Spike S7

Same lab VM and disk as S4 (4608M guest, site PKI already in place). Our images (oauth2-proxy, operator, service, conversion webhook,
landing page from 47-09's local builds; the operator's `/templates/templateDeployment.yaml` compared identical to the repository) were
pushed to a staging Zot, signed with the lab key and imported by haul; the releases were rendered with the repository's render path from a
lab copy of the image lock holding those digests. Kyverno `site-images-signed`, `site-registry-only` and `sterling-session-env` in Deny;
namespace theia-cloud `pod-security.kubernetes.io/enforce: restricted`.

```
first install (before the patch grew): operator, service, landing page, webhook all refused by Pod Security restricted (no securityContext)
after: conversion-webhook, landing-page-deployment, operator-deployment, service-deployment 1/1 Running
certificates from site-pki: conversion-webhook-certificate (CN crd.conversion.cert, SAN conversion-webhook-service.theia-cloud.svc,
  issuer CN=Sterling lab site intermediate), ws-cert-secret, service-cert-secret, landing-page-cert-secret: Ready
  (first refused by OpenBao: "role requires keys of type ec", then "the common_name field is required"; fixed in the ingress role)
Workspace ws-ana + Session s-ana (what the service writes for a launch; applied directly, no Keycloak in the lab):
  pvc ws-ana-sterling-workbenc-0c6c554b4b03 Bound lab-ws1 10Gi sterling-encrypted
  pod session-ana-...  2/2 Running, restarts 0
    oauth2-proxy  registry.lab.internal:30500/sterling/oauth2-proxy@sha256:30f7905c... IfNotPresent
                  {allowPrivilegeEscalation:false, capabilities.drop:[ALL], readOnlyRootFilesystem:true, runAsUser:65532, seccomp RuntimeDefault}
    workbench     (lab placeholder) IfNotPresent {allowPrivilegeEscalation:false, drop ALL, runAsUser 1001, seccomp RuntimeDefault}
    pod: fsGroup 1001, runAsNonRoot, seccomp RuntimeDefault, automountServiceAccountToken false
    labels: sterling-session "true", theia-cloud.io/user ana_at_lab_internal; envFrom [configMapRef sterling-site-env]
  oauth2-proxy log: OIDC discovery over the site CA, then "No valid authentication in request. Initiating login." -> 302
Workspace ws-eve + Session s-eve with envVarsFromSecrets [oauth2-proxy-secrets]:
  operator: POST .../namespaces/theia-cloud/deployments -> admission webhook "vpol.validate.kyverno.svc-fail-..." denied the request:
    Policy sterling-session-env failed: A session may take environment only from ConfigMap sterling-site-env.
  session s-eve status: operatorStatus ERROR, operatorMessage "Unexpected error. Please check the logs for correlationId: 3463bec2-..."
```

### Forged X-Forwarded-Uri (coordinator blocker), live

```
through HAProxy (curl from the host, lab root only), GET https://ws.lab.internal/<session>/ ...
  before the ingress fix: with X-Forwarded-Uri: /monitor/activity/lastActivity -> 404 from the app (sign-in skipped)
  after:  plain -> 302 to keycloak.lab.internal ...auth; forged X-Forwarded-Uri -> 302; forged Uri+Host+For -> 302
  HAProxy config: http-request set-header X-Forwarded-For/-Host/-Proto/-Uri on both frontends
from a pod, straight to the session pod's oauth2-proxy (10.42.0.82:5000) with the forged header:
  session NetworkPolicy removed: from another namespace -> 404 from the app (sign-in skipped: the pod network is trusted)
  NetworkPolicy in place: from another namespace -> timeout; from theia-cloud (labelled as a session) -> timeout
```

### Answers the plan asked for

- **oAuth2ProxyVersion with a full reference:** accepted; the template line stays `image: placeholder-oauth2-proxy-version`.
- **Who reaches port 3000 besides the sidecar:** the operator. It creates `session-...-int` (port 3001 to the app port) and its activity
  monitor posts to the session's cluster IP on the monitor port (MonitorMessagingServiceImpl). The Phase 46 workbench, which listens on
  127.0.0.1 unless STERLING_LISTEN_HOST is set, would not be reachable: the template must set STERLING_LISTEN_HOST to the pod IP (downward
  API status.podIP) and 47-12's session-env allow-list must allow that name, then the operator image is rebuilt. Not done here: the template
  is being changed on Phase 46's branch (anchored skip-auth route) and needs a rebuild; recorded for the merge.
- **Host header:** the alpha upstream has `passHostHeader: true`, so the browser's host (ws.<domain>) reaches the workbench; THEIA_HOSTS
  is not needed for that reason. Not observed end to end (no signed-in request in the lab).

## Verification

- `render-theia.test.mjs` (6 cases, all added), with render, render-pki, render-sessions and rke2: see the run below. Final full
  `deploy/test/*.test.mjs` with the pinned helm and cosign, under the memory cap: 70 run, 70 pass, 0 skipped (this plan added 6, all in
  render-theia.test.mjs; the security fix added assertions to render-pki). `node scripts/resource-check.mjs`: passed, 123 resources.
  Intermediate commits were not each re-tested; the final tree was.
- `node deploy/charts/vendor.mjs` twice: the same patched SHA-256 as the lock; `--check` re-applies both patches offline.
- oauth2-proxy v7.15.6 (our image, no network) with the rendered files: our configuration loads to OIDC discovery; the same file plus
  `pass_access_token=true`: "failed to load core options ... 'options.Options' has invalid keys: pass_access_token" (refused at start).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The patch is five template files, not one**
- Pod Security restricted refused the operator, service, landing page and webhook (no security context in the chart and no value for it),
  so they are patched too; the CRDs chart gets its own patch and lock entry. The acceptance line "exactly one +++" no longer holds; each
  patch file has a header saying why each file is changed.

**2. [Rule 2 - Missing critical] The service's client secret was in a ConfigMap**
- `service-config` carried `KEYCLOAK_CLIENTSECRET` (the same sterling-sessions secret). The service container now takes it from Secret
  `oauth2-proxy-secrets` (container env overrides envFrom); the values put only a placeholder text in the ConfigMap.

**3. [Rule 1 - Bug] pass_access_token and set_xauthrequest cannot be legacy options**
- With alpha config they make oauth2-proxy refuse to start (see Verification). The rendered file names them only in a comment that says
  where their headers are; the plan's acceptance line listing them as `= true` settings is met by the alpha headers instead.

**4. [Rule 1 - Bug] The start page never read its configuration**
- The chart mounts config.js under /usr/share/nginx/html; our UBI 9 nginx image serves /opt/app-root/src, so the page ran the demo
  settings (useKeycloak false, appDefinition theia-cloud-demo, seen in the lab). The patch moves both mounts.

**5. [Rule 1 - Bug] The ingress role refused the Ingress and webhook certificates**
- cert-manager's certificates from Ingress annotations and the webhook's use RSA keys and (Ingress) no common name: role `ingress` now has
  `key_type any` and `require_cn false` (deploy/openbao/apply.mjs; OpenBao still refuses RSA under 2048 bits, names are still checked).

**6. [Rule 2 - Security, coordinator] Forwarded headers and trusted proxies** (see the Threat Flags)
- oauth2-proxy `trusted_proxy_ips` from `sterling.trustedProxyIps` (fails closed), HAProxy overwrites the four headers (controller
  ConfigMap and the Keycloak Ingress, which replaces the list), NetworkPolicy `sterling-session-ingress` in the sterling-sessions chart
  (47-12's chart, a new template). Tests: render-theia (flag from site values, refusal, policy), render-pki (headers on the controller and
  every Ingress with its own list), and the live checks above.

**7. From 47-14 (coordinator): "Sign in through HQ"**
- The 1.2.0 start page shows text only, so it cannot carry a link. oauth2-proxy's alpha config allows `kc_idp_hint=hq` from /oauth2/start,
  so the link `https://<instance host>/oauth2/start?kc_idp_hint=hq` goes straight to the HQ broker; the site example says so.

**8. Lab only**
- The pinned placeholder `ubi9/nginx-126` exits at once (its default command prints the s2i usage), so a placeholder session never runs:
  the lab pointed the AppDefinition at our landing page image. 47-12/47-18 need a long-running placeholder.
- No Keycloak fits the 4.5 GiB guest: a static OIDC discovery document behind HAProxy at keycloak.lab.internal let oauth2-proxy start;
  CoreDNS got a hosts entry for keycloak.lab.internal and ws.lab.internal. Sessions were created as the service would (Workspace + Session).
- The import host had to trust the site chain once the registry was re-issued (47-13's handover).
- Creating two sessions at the same moment hit an upstream NullPointerException (`checkIfMaxInstancesReached` reads a session with no
  status yet); one at a time works. Recorded for upstream; launches from the start page are one per person.

## RBAC review (D-27)

Recorded in `deploy/values/theia-cloud-base.yaml`: the operator's ClusterRole (customresourcedefinitions, appdefinitions, workspaces,
sessions, ingresses, persistentvolumes, persistentvolumeclaims, services, configmaps, deployments, leases, pods; every verb) is bound
cluster-wide; the service's ClusterRole is bound by RoleBinding in its namespace. Values allow no narrowing (fixed role bodies, names only);
a namespace-scoped Role for the operator needs a chart change tested against the operator, recorded for Phase 48.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: auth-bypass (fixed) | deploy/charts/patches/theia-cloud-oauth2.patch, deploy/values/kubernetes-ingress.yaml, deploy/charts/sterling-sessions/templates/session-network-policy.yaml | oauth2-proxy with --reverse-proxy and no trusted proxies trusted X-Forwarded-Uri from anyone and matched --skip-auth-route against it: a forged header skipped sign-in to a person's Theia (terminal, files). Shown live before the fix; closed in three layers and re-tested. Residual: the pod network is trusted, so the NetworkPolicy is load-bearing (shown: without it a pod could bypass); the operator pod may reach sessions. |
| threat_flag: tls-verify | upstream operator (AddedHandlerUtil) | The operator's session URL probe installs a trust-all TLS socket factory as the JVM default (`HttpsURLConnection.setDefaultSSLSocketFactory`). Upstream item. |
| threat_flag: tls-verify | deploy/images/theia-cloud-service | The service's built-in `quarkus.oidc.tls.verification=none` (its application.properties): its OIDC calls to Keycloak are not verified. Needs QUARKUS_OIDC_TLS_* with the site truststore in 47-09's entrypoint; not done here. |
| threat_flag: skip-auth-route | deploy/images/theia-cloud-operator/templates/templateDeployment.yaml | `--skip-auth-route=/monitor/*` is unanchored; Phase 46's branch anchors it. The operator image must be rebuilt from that template. |

## Known Stubs

None in shipped files. `sterling.workbenchPort` is 3000 (Phase 46's port); the lab set 8080 for its placeholder.

## Self-Check: PASSED

PASSED: the created files exist; commits 3bf9782e, b8005a17, f59e9bf9, 3ef10383 are on HEAD (4 commits since 35d8a5ba).

## Wave 5 integration (merge of main, and the blockers this wave found)

Done on `feat/phase-47-wave-5` (47-13, 47-14 and 47-15 combined) on 2026-11-24, after merging `origin/main` (wave 4 #181, the
component catalogue #184, the guest plans 47-19 to 47-21 #182).

### Merge resolutions (`1c74e73d`)

- Why it conflicted: #181 squash-merged wave 4, and main's `deploy/` tree is byte-identical to the wave-4 tip this branch was built on
  (`git diff 4ee42c0b 849e2834` is empty); #182, #183 and #184 touch no `deploy/` file. The merge base is 0.4.38 (before wave 4), so git
  saw wave 4 added on both sides (add/add) next to this wave's edits. Every `deploy/` hunk therefore resolves to this branch's side, which is
  wave 4 plus 47-13/14/15: `deploy/bundle/build.mjs`, `deploy/charts/sterling-keycloak-realm/templates/job.yaml`,
  `deploy/charts/sterling-sessions/values.yaml`, `deploy/keycloak/apply.mjs`, `deploy/keycloak/realm.json`, `deploy/openbao/apply.mjs`,
  `deploy/values/keycloakx.yaml`, `deploy/values/site.example.yaml`, `deploy/values/site.example/sterling-keycloak-realm.yaml`. After the
  merge `git diff HEAD^1 HEAD -- deploy` is empty, so 47-14's HQ broker, CRL and user export, 47-13's PKI, HAProxy and Keycloak Ingress,
  47-15's trusted proxies and session NetworkPolicy and main's wave 4 are all present; no security setting was dropped.
- ROADMAP: main's success criterion 7 (guest accounts) and plans 47-19 to 47-21 kept, 47-13/14/15 checked, count 15/21 in both places.

### The registry restarts under Deny (47-13 blocker; 47-05's chart, `52bf1638`)

- Choice: the first option the coordinator offered. `site-images-signed` gets one match condition, rendered only on Zot sites: it skips a pod
  only when it is in `sterling-registry` and every container is exactly the Zot reference from the image lock
  (`<registry>/project-zot/zot:v2.1.23@sha256:b68f...`), with no init or ephemeral containers. The reference comes from the release
  descriptor's image mapping (the same digest the signed bundle's import verified, preloaded on each node by `install-node.sh`). The chart
  refuses a reference without a digest, outside the site registry, with a pattern, or an excluded namespace. `site-registry-only` still
  applies to the pod. Harbor sites get no exception.
- Not chosen: verifying the registry pod against a signature copy outside the registry. Kyverno 1.20 reads signatures from an OCI registry
  only, so it would need a second registry or a bundle-side store. The pinned digest gives the same assurance (the digest is in the signed
  bundle) with no new component.
- Test: `rke2.test.mjs` "admission exempts only the Zot pod...": one namespace, exactly the one image the zot release renders, equality only
  (two `||` total, both the empty-list checks), the signature validation and Deny unchanged, no exception in `site-registry-only`, none on a
  Harbor site, and four wider forms refused at render.
- Lab check: **pending for 47-18.** The lab VM was stopped and has no recorded disk to resume; 47-18 must delete `zot-0` under Deny and see
  it start again (and drain the node once), and confirm Kyverno evaluates `matchConditions` before it fetches image data.
- Open: **Harbor sites have the same loop** (Harbor's seven images are served by Harbor). Harbor is HQ's second wave; 47-16/47-18 must pick
  the same exact-digest form for Harbor's pods or preload and accept them, before a Harbor site runs in Deny.

### TLS verification (`3447dce8`)

- **Service** (47-09's entrypoint): refuses to start without `/etc/ssl/site-ca/ca.crt` holding a certificate (ConfigMap `sterling-site-ca`,
  now mounted by the chart patch) or with a non-https Keycloak URL; the OIDC client uses Quarkus TLS registry configuration `sterling-site`
  (PEM trust from that file, HTTPS host name check, trust-all off; Quarkus refuses to start if the named configuration is missing), and the
  deprecated `quarkus.oidc.tls.verification` is set back to `required`. Checked with the rebuilt service image and a stub OIDC server over TLS:
  with the site CA the service fetched discovery and the keys; with another CA it failed with `PKIX path building failed`; the old image
  fetched discovery from the same server with no CA at all.
- **Found in that check, fixed (Rule 2):** upstream's `ApplicationLifecycleListener` logs every configuration source at INFO at start, so
  the OIDC client secret (environment) and the service auth token (system property) went to the container log and the site log store. Its
  category is set to WARN in the entrypoint; the rerun's log has no secret. Upstream item.
- **Operator** (upstream `AddedHandlerUtil.updateSessionURLAsync`): a small, contained patch, so fixed in our image. `probe-tls.sh` runs in
  the build stage before Maven, deletes `HttpsURLConnection.setDefaultSSLSocketFactory(...)` and the accept-any host name verifier, and
  gives the probe's SSLContext the default trust managers; it refuses (changing nothing) unless each upstream line occurs exactly once. The
  image's JVM trusts only `/etc/ssl/site-ca/truststore.p12` (ENTRYPOINT), mounted by the chart patch. Built locally from the pinned source:
  BUILD SUCCESS, and the compiled `AddedHandlerUtil` no longer references `setDefaultSSLSocketFactory` or `setHostnameVerifier`. Not run
  against a cluster: 47-18 must see a session reach Running with its URL set (the probe now needs `truststore.p12` in `sterling-site-ca`,
  which 47-16's install script writes; an empty one fails closed, the session never gets a URL).
- Tests (`render-theia.test.mjs`, 3 added): both Deployments mount the site CA and the operator ENTRYPOINT sets the truststore; `probe-tls.sh`
  edits the upstream lines and refuses drift unchanged; the entrypoint passes the TLS settings and the log setting, and refuses a missing,
  empty or non-certificate CA file and an http Keycloak before java runs.
- Upstream issues to file with Eclipse Theia Cloud (not filed from here): (1) the operator's session probe installs a trust-all
  SSLSocketFactory as the JVM default; (2) the service ships `quarkus.oidc.tls.verification=none`; (3) the service logs its client secret
  and auth token at start.

### The workbench listen address (Phase 46 interface; deploy side here, `56a441f1`)

- The Phase 46 change itself is on Phase 46's branch, not this one. Its workbench binds one address (`STERLING_LISTEN_HOST`, default
  127.0.0.1), and the oauth2-proxy sidecar's upstream is `http://127.0.0.1:3000/`. The pod IP alone (`status.podIP`) would cut the sidecar
  off, so the operator template sets `STERLING_LISTEN_HOST=0.0.0.0`, which in a pod is exactly loopback plus the pod IP; 47-12's allow-list
  carries the name (14 names). **Deviation from the coordinator's `status.podIP`**, for that reason; if Phase 46 changes the workbench to
  bind loopback and a given address, the template can switch to `status.podIP` (the policy allows `fieldRef`).
- Because the workbench now answers on the pod IP, `sterling-session-ingress` is port-scoped: HAProxy's namespace reaches only the sidecar
  (5000), the operator only the workbench's port (3000, its activity monitor). Before, both could reach any port.
- Still needed at the Phase 46 merge: the operator image is rebuilt with Phase 46's anchored `--skip-auth-route` in the same template.
- Tests: `render-sessions` checks the allow-list is exactly the template's names and the bind value (replacing the count of 13);
  `render-theia` checks two rules, one port each.

### Register (`be25423a`)

No new `compliance/resources.json` entries (the wave added no component; `role` and `architectureArea` were already set). Conditions
updated on the three Kyverno entries, Zot and `chart:theia-cloud`; the component catalogue regenerated and `--check` passes.

### Threat register (wave 5 integration)

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-47-77 | Denial of service | site registry under Deny admission | high | mitigate | Exact-digest match condition for the Zot pod in sterling-registry only (render-tested scope); lab restart check in 47-18; Harbor open |
| T-47-78 | Tampering / elevation | the registry pod exception | medium | accept | Equality on one digest-pinned reference in one namespace, no init or ephemeral containers; someone able to create pods in sterling-registry could run that same verified image with other arguments, which a signature check would not stop either |
| T-47-79 | Spoofing | service OIDC calls to Keycloak | high | mitigate | TLS registry trust from the site CA only, host name checked, start refused without the CA; tested and checked against a stub server |
| T-47-80 | Spoofing | operator session URL probe and every later HTTPS call in its JVM | medium | mitigate | probe-tls.sh removes the trust-all JVM default and verifier; JVM trusts the site truststore only; build-checked, 47-18 runtime check |
| T-47-81 | Information disclosure | service start-up configuration dump | high | mitigate | Listener category at WARN; client secret and service token no longer logged (checked in the rerun) |
| T-47-82 | Elevation of privilege | workbench reachable on the pod IP | medium | mitigate | sterling-session-ingress port-scoped: HAProxy to the sidecar only, the operator to the workbench port only |

### Verification on the final tree

- `deploy/test/*.test.mjs` with the pinned helm 4.3.2 and cosign 3.1.4, under the memory cap: 92 run, 92 pass, 0 skipped. Added by this
  integration: 4 (1 in `rke2.test.mjs`, 3 in `render-theia.test.mjs`); 2 existing tests extended (`render-sessions` allow-list,
  `render-theia` NetworkPolicy rules).
- `node scripts/resource-check.mjs`: 122 resources pass. `node deploy/charts/vendor.mjs --check`: passes (the theia-cloud patch output
  re-hashed to `8248b2fb...`). `node scripts/build-component-catalogue.mjs --check`: matches. `scripts/test/component-catalogue` and
  `resource-check` tests: 18 pass.
