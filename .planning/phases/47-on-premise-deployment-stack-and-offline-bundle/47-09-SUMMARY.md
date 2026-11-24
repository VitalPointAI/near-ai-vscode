---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 09
subsystem: deploy
status: complete
tags: [theia-cloud, oauth2-proxy, go-fips, ubi9, rebuilt-images, sbom, session-pod-template]
requires: [47-04]
provides:
  - "Build definitions (Containerfile and image.json) for oauth2-proxy, theia-cloud-operator, theia-cloud-service, theia-cloud-conversion-webhook, theia-cloud-landing-page"
  - "deploy/images/theia-cloud-operator/templates/templateDeployment.yaml (session pod template: ConfigMap sterling-site-env, ConfigMap sterling-site-ca, Secret oauth2-proxy-secrets, label sterling-session)"
  - "deploy/images/theia-cloud-service/entrypoint.sh (refuses an empty or sample client secret)"
affects: [47-12, 47-15, 47-16, 47-18]
tech-stack:
  added: []
  patterns:
    - "Upstream source as the named build context upstream, at a 40-character commit, fetched on the connected side"
key-files:
  created:
    - deploy/images/oauth2-proxy/image.json
    - deploy/images/theia-cloud-operator/image.json
    - deploy/images/theia-cloud-operator/templates/templateDeployment.yaml
    - deploy/images/theia-cloud-service/image.json
    - deploy/images/theia-cloud-service/entrypoint.sh
    - deploy/images/theia-cloud-conversion-webhook/image.json
    - deploy/images/theia-cloud-landing-page/image.json
  modified:
    - deploy/images/oauth2-proxy/Containerfile
    - deploy/images/theia-cloud-operator/Containerfile
    - deploy/images/theia-cloud-service/Containerfile
    - deploy/images/theia-cloud-conversion-webhook/Containerfile
    - deploy/images/theia-cloud-landing-page/Containerfile
    - deploy/images/README.md
key-decisions:
  - "Pins: Theia Cloud tag 1.2.0 = commit e2d201fd0a1ce3e9581174f42bfd23d855dfa1a3 (confirmed); oauth2-proxy tag v7.15.6 is an annotated tag object 18bba0ae whose commit is ea755ac07aa200acc22e02f95d25b91de6c9fe20"
  - "oauth2-proxy builds with GOFIPS140=v1.0.0 on Red Hat's go-toolset 1.27.3; go version -m reports GOFIPS140=v1.0.0-c2097c7c and DefaultGODEBUG fips140=auto; the build fails if GOFIPS140 is missing"
  - "The version build argument is OAUTH2_PROXY_VERSION, because the go-toolset image sets VERSION (its Go version) in its environment, which overrode an argument named VERSION (the first build printed 1.27.3)"
  - "The service passes the client secret to Quarkus as QUARKUS_OIDC_CREDENTIALS_SECRET, not as a -D argument, so it is not in the process list"
  - "The landing page's upstream index.html loads a font from fonts.googleapis.com; the build removes it and fails if any src or href in the built page names an outside address"
  - "The capacity refusal text cannot be set without a code change: the landing page shows the service's error reason, which RootResource.java writes as '... has max instances reached.' (owner-confirm item 9 stays a Phase 46 or upstream item)"
  - "oauth2-proxy-secrets is mounted 0440 (group = the pod's fsGroup) because the sidecar runs as 65532 and owner-only 0400 files belong to root"
requirements-completed: [DEP-07]
duration: ~1h10m
completed: 2026-11-24
estimate:
  tokens: 85000
  tasks: 3
actuals:
  tokens: 9000
  tasks: 3
  commits: 3
plan_head_before: 4b9d710b
plan_head_after: 92fbbd69
---

# Phase 47 Plan 09: Rebuilt Theia Cloud and oauth2-proxy images Summary

**All five images built locally from pinned commits on the pinned UBI 9 bases: oauth2-proxy v7.15.6 with the Go FIPS module (confirmed in its build settings) and a CycloneDX SBOM; the operator carrying our hardened session template (identical inside the image); a service that refuses an empty or sample secret; the conversion webhook; and a landing page that asks no outside address, served as a non-root user.**

## Tasks

| Task | Result | Commit |
|---|---|---|
| 1. oauth2-proxy (tracer): pinned source, Go FIPS build, UBI runtime, SBOM | done; tracer gate re-ran the build end to end before expanding | `c3cb716a` |
| 2. Operator with the session template; the service's secret check | done | `c1518cc8` |
| 3. Conversion webhook and landing page | done | `92fbbd69` |

## Builds (podman, one at a time, under the memory cap and the heavy-run lock)

Sources were the GitHub archives of the pinned commits, given as `--build-context upstream=<folder>`, as `deploy-images.yml` does.

### oauth2-proxy

```
go version -m (build stage):
  path   github.com/oauth2-proxy/oauth2-proxy/v7
  build  -trimpath=true
  build  DefaultGODEBUG=fips140=auto,tracebacklabels=0,x509sslcertoverrideplatform=0
  build  CGO_ENABLED=0
  build  GOFIPS140=v1.0.0-c2097c7c
  build  GOOS=linux  GOARCH=amd64  GOAMD64=v2
podman run localhost/sterling/oauth2-proxy:s9 --version -> oauth2-proxy v7.15.6 (built with go1.27.3 (Red Hat 1.27.3-1.el9_9))
image user: uid=65532 gid=65532; /bin/oauth2-proxy -r-xr-xr-x root root
syft 1.57.2 (pinned) -> CycloneDX 1.7, 1387 components: 61 Go modules, 109 RPMs (the rest are files)
```

The CMVP status of the Go Cryptographic Module stays unverified (a condition on the register entry; Phase 48).

### Operator

```
build exit 0; /operator/defaultoperator-1.2.0-jar-with-dependencies.jar root-owned 0444; runs as uid 185
/templates/templateDeployment.yaml extracted from the image vs the repository file -> identical
placeholder tokens (sorted) upstream vs ours -> the same 34 tokens; the oauth2-proxy line is now `image: placeholder-oauth2-proxy-version`
```

Changes to the upstream template: no `imagePullPolicy: Always`, and the oauth2-proxy image is a bare placeholder, so the operator's
`oAuth2ProxyVersion` argument supplies the whole `<site registry>/sterling/oauth2-proxy@sha256:...` (47-15). Both containers get
restricted security contexts; the sidecar's root filesystem is read-only. `--alpha-config` points at the per-session ConfigMap key
`oauth2-proxy-alpha.yaml`, which 47-15's chart patch must render. Secret `oauth2-proxy-secrets` is mounted only into the sidecar.
`sterling-site-ca` is mounted into both containers. The Theia container gets `envFrom: sterling-site-env`. The Deployment and its pods
carry the `sterling-session: "true"` label. `automountServiceAccountToken: false` and a pod seccomp profile are set. `STERLING_LISTEN_HOST`
and `THEIA_HOSTS` are not set: the sidecar reaches the workbench over loopback, and S7 (47-15) decides whether either is needed.

### Service

```
no secret:            theia-cloud-service: KEYCLOAK_CLIENTSECRET is not set; refusing to start ... exit 1
the sample secret:    theia-cloud-service: KEYCLOAK_CLIENTSECRET is the public sample value from the upstream image; refusing to start. exit 1
a real secret:        Quarkus starts (with --network none it then reports "OIDC server is not available", as expected); the secret
                      does not appear in /proc/1/cmdline (count 0)
```

### Conversion webhook

```
build exit 0; /conversion/conversion-webhook-1.2.0-runner.jar root-owned 0444; runs as uid 185
```

### Landing page

```
first build: the built files named https://fonts.googleapis.com (index.html: <link href="https://fonts.googleapis.com/css?family=Anonymous+Pro...">),
             plus github.com, reactjs.org, www.w3.org and example strings inside the JavaScript bundle (text, not requests)
rebuilt:     uid=1001(default); GET http://127.0.0.1:8080/ -> HTTP 200; outside font references: 0
             every src and href in index.html is local: ./favicon.ico, ./config.js, ./assets/index-CpUkxxal.js, ./assets/index-DPkYGSqa.css
```

**Refusal text (owner-confirm item 9):** the page shows the service's error reason. `RootResource.java` writes it as
`"... has max instances reached."`. The owner's wording ("All sessions are in use. Try again in a few minutes, or ask your administrator.")
needs a code change in the service or the page, so it stays a Phase 46 or upstream item.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The version build argument was shadowed**
- The go-toolset base sets `VERSION` in its environment, so the binary printed `1.27.3`. The argument is now `OAUTH2_PROXY_VERSION`, and the
  binary prints `v7.15.6`. Commit `c3cb716a`.

**2. [Rule 2 - Missing critical] The client secret was visible in the process list**
- Upstream passes it as `-Dquarkus.oidc.credentials.secret=...`. The entrypoint now passes it through the environment and unsets
  `KEYCLOAK_CLIENTSECRET`. Commit `c1518cc8`.

**3. [Rule 2 - Missing critical] The landing page loaded a font from the internet**
- An air-gapped page must ask for nothing outside the site. The font line is removed at build, and a guard stops the build if any outside
  address remains.

**4. Secret file mode 0440 instead of 0400** (see key-decisions).

## Known Stubs

None. The images are not published here: `deploy-images.yml` publishes them on a release tag, and the lock's `built` digests stay null
until then.

## Self-Check: PASSED

- All created files exist; the three commits are ancestors of HEAD.
