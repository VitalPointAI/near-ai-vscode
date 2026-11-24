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
