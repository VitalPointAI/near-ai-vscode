---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 02
subsystem: deploy
status: complete
tags: [helm, charts, offline-render, image-lock, invariants, cert-manager]
requires: []
provides:
  - deploy/charts/charts.lock.json (14 hash-locked charts; checker input for chart:<name>)
  - deploy/charts/vendor.mjs (fetch-and-verify; --check offline; checkVendored)
  - deploy/bundle/lib/locks.mjs (readChartsLock, readImagesLock, readToolPins, resolveImage, sitePath, UNPUBLISHED_DIGEST)
  - deploy/bundle/lib/render.mjs (listReleases, loadSite, renderRelease, renderSite, substituteSite, splitDocs; CLI --site --release --all --substitute)
  - release descriptor format deploy/values/<release>.release.json
  - image lock format deploy/bundle/images.lock.json
  - site globals deploy/values/site.example.yaml and CI fixture deploy/test/fixtures/site.ci.yaml
  - deploy/test/render.test.mjs (D-56 global invariants)
affects: [47-03, 47-04, 47-05, 47-07, 47-08, 47-10, 47-11, 47-12, 47-13, 47-15, 47-16]
tech-stack:
  added: [helm v4.3.2 (build tool, compliance/out/tools, git-ignored)]
  patterns: [vendored chart tarballs with SHA-256 lock, helm template with empty Helm folders, image injection by digest via --set-string, site-token substitution]
key-files:
  created:
    - deploy/charts/charts.lock.json
    - deploy/charts/vendor.mjs
    - deploy/charts/vendored/*.tgz (14)
    - deploy/bundle/lib/locks.mjs
    - deploy/bundle/lib/render.mjs
    - deploy/bundle/images.lock.json
    - deploy/values/site.example.yaml
    - deploy/values/cert-manager.yaml
    - deploy/values/cert-manager.release.json
    - deploy/test/fixtures/site.ci.yaml
    - deploy/test/render.test.mjs
  modified: []
decisions:
  - "Harbor and Fluent Bit have no published chart for the decided app versions (v2.15.5, v5.2.0); the newest charts (harbor 1.19.4 / app 2.15.4, fluent-bit 0.58.3 / app 5.1.3) are pinned and their images are to be set to the decided versions by digest when their values are written"
  - "Zot: six chart versions carry v2.1.23; the newest, 0.1.135, is pinned"
  - "The release name is the descriptor's file name, so duplicate names can only arise from instances; the refusal lives in expandInstances (duplicate item names) and renderSite (an instance colliding with another release)"
  - "listReleases refuses unknown descriptor fields, so a typo such as image for images cannot silently render a chart's upstream default image"
  - "Every render runs helm template with --kube-version 1.37.2 (RKE2 v1.37.2+rke2r1) and re-checks the vendored tarball's SHA-256 before helm runs"
  - "cert-manager images are mapped through the chart's per-component image.registry + image.repository + image.digest keys, and imageRegistry is the site registry so the unused ACME solver argument never names quay.io"
metrics:
  duration: ~45m
  completed: 2026-11-23
estimate:
  tokens: 70000
  tasks: 2
actuals:
  tokens: 12400
  tasks: 2
  commits: 2
plan_head_before: bbba3993
plan_head_after: dc1dd1be7be21047416db37404560730e3b28858
---

# Phase 47 Plan 02: Vendored chart lock and the offline render harness Summary

All 14 upstream charts are vendored as tarballs whose SHA-256 equals the repository index digest. There is now one offline render path (`deploy/bundle/lib/render.mjs`): helm runs with empty Helm folders, values get the site file substituted in, and every image is injected by digest from `images.lock.json`. cert-manager v1.21.3 runs end to end through it, and the D-56 global invariants are checked on everything it renders.

## What was built

- **Chart lock and vendoring.** `deploy/charts/charts.lock.json` lists 14 charts. Each entry has name, version, appVersion, repository, url, sha256, file, component and an optional note.
  - `vendor.mjs` downloads over https. If a download's SHA-256 differs from the lock, it refuses and writes nothing. It writes to a `.partial` file and renames it into place.
  - `vendor.mjs --check` works offline. It refuses a hash mismatch, a missing tarball, or an unlisted `.tgz`. A scratch-copy probe confirmed all three refusals.
  - Each tarball's `Chart.yaml` was read to confirm its name, version and appVersion. Each chart also renders offline with its defaults: kyverno and prometheus carry their subcharts inside the tarball.
- **Lock library (`locks.mjs`).**
  - `sitePath` removes the source registry host: `quay.io/jetstack/x` becomes `jetstack/x`, and `sterling/<name>` stays as it is.
  - `resolveImage` returns `{ ref, registry, repository, digest, tag, unpublished }`. For a `built` or `release` entry with a null digest, it uses `UNPUBLISHED_DIGEST`.
  - It also has `splitRef`, `allImages` and the lock readers.
- **Render harness (`render.mjs`).**
  - **Descriptors:** reads every descriptor, sorted by `order` then name.
  - **Site substitution:** replaces `${site.<dotted key>}` tokens. A whole quoted token is replaced, quotes included, by the JSON of the value, so JSON files stay valid. A key the site file lacks stops the render with `<file>: ${site.<key>} is not set in the site file`.
  - **Images:** each descriptor's image mappings become `--set-string` arguments, using the parts ref, registry, repository, digest and tagAtDigest.
  - **Conditions and instances:** `enabledWhen` controls whether a release renders, and a typo in one of its keys is refused. `instances` renders the release once per site-list item (`--set-json instance=...`).
  - **Before helm runs, it refuses:** an unknown chart, a missing local chart, an unknown image lock name, an unknown image part, a missing namespace, an unknown descriptor field, and duplicate release names.
- **Site globals.** `site.example.yaml` holds every key the plan names, plus a `note` object explaining each one:
  - `signInKeys` defaults to `passkeys`.
  - `rpId` is empty: it is your organization's one shared parent domain, the same at HQ and at every edge site.
  - `requestedStorage` is empty, so there is no silent default.

  The CI fixture fills every key with test values and a throwaway P-256 public key. No private key was kept.
- **cert-manager end to end.**
  - Descriptor: namespace cert-manager, order 30.
  - Values: the chart installs and keeps its CRDs, and every component uses `IfNotPresent`. No ACME issuer is created.
  - Four images are pinned by their multi-arch index digest. Each digest was computed from the manifest body and matched the registry's `Docker-Content-Digest`.
  - In the rendered output, all 4 `image:` lines are `registry.site.example/jetstack/...@sha256:...`.
- **`render.test.mjs`** has 5 tests:
  - helm is present: it fails with a plain message when helm is missing, never skips.
  - `checkVendored` reports no problems.
  - Global invariants on every rendered release:
    - every image is digest-pinned and matches an image-lock entry served from the site registry;
    - `UNPUBLISHED_DIGEST` is allowed only for unpublished entries, and each use is listed with `t.diagnostic`;
    - none of these appear: pull policy `Always`, an ACME Issuer or ClusterIssuer, ingress-nginx or the nginx class, k3s, `grafana/loki`;
    - at least one image line was checked.
  - The descriptor refusals listed above.
  - JSON-safe substitution, plus a local chart rendering once per instance with the image taken from the lock.

## Chart pins

| Chart | Version | appVersion | sha256 (short) | Note |
|---|---|---|---|---|
| cert-manager | v1.21.3 | v1.21.3 | 9ec67938b298 | |
| kubernetes-ingress | 1.57.1 | 3.4.1 | daedaa6bd3da | chart version differs from the controller version |
| kyverno | 3.10.0 | v1.20.0 | 55961392dc08 | chart version differs from the Kyverno version |
| zot | 0.1.135 | v2.1.23 | 75b20fa291d4 | newest of six charts carrying v2.1.23 |
| harbor | 1.19.4 | 2.15.4 | 759872bbabaf | **no chart for v2.15.5 exists**; images to be overridden to v2.15.5 |
| longhorn | 1.13.0 | v1.13.0 | e57f010d2a8b | |
| openbao | 0.30.8 | v2.7.3 | a1a202d6300d | |
| keycloakx | 7.4.0 | 26.8.1 | 9adcfc34dadc | image set to Keycloak 26.8.2 (Decision 10) |
| theia-cloud-base | 1.2.0 | 1.2.0 | 9c264e0bd2d3 | E1 |
| theia-cloud-crds | 1.2.0 | 1.2.0 | 45979ac926c2 | E1 |
| theia-cloud | 1.2.0 | 1.2.0 | e904574fbf22 | E1; upstream tarball (patch lands in 47-15) |
| opensearch | 3.10.0 | 3.10.0 | e42d5084e3e4 | |
| fluent-bit | 0.58.3 | 5.1.3 | 99e025e461fa | **no chart for v5.2.0 exists**; image to be overridden to v5.2.0 |
| prometheus | 30.0.0 | v3.16.0 | 2e76e9b3c3f7 | |

## Verification

- `node deploy/charts/vendor.mjs --check`: exit 0.
- `env HELM=compliance/out/tools/linux-amd64/helm node scripts/run-tests.mjs deploy/test/render.test.mjs` (under the memory cap): 5 tests run, 5 pass, 0 fail. These 5 are all new tests added by this plan.
- With `HELM=/nonexistent/helm`, the helm-dependent tests fail with the message "helm was not found (...)" instead of skipping.
- `node deploy/bundle/lib/render.mjs --site deploy/test/fixtures/site.ci.yaml --substitute <file naming ${site.missingKey}>`: exit 1 with the message "is not set in the site file".
- The import check finds nothing: no `.mjs` under `deploy/` imports anything outside `node:` built-ins.
- `node scripts/resource-check.mjs` passes (54 resources), as expected: the unextended checker ignores `deploy/`. The entries for `chart:` and the image lock arrive with 47-04.
- helm v4.3.2 came from get.helm.sh and passed `sha256sum --check` (d1c0278d...a53983). It is in `compliance/out/tools/linux-amd64/helm`, which git ignores.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] Unknown descriptor fields are refused.**
- **Found during:** Task 1
- **Issue:** a typo such as `image` for `images` would have silently rendered the chart's upstream default image.
- **Fix:** `listReleases` rejects any field outside the fixed descriptor format.
- **Commit:** b1104c70

**2. [Rule 1 - Bug] The duplicate-release refusal moved to where duplicates can actually happen.**
- **Found during:** Task 2
- **Issue:** the release name is the descriptor's file name, so two descriptors in one folder cannot share a name.
- **Fix:** `expandInstances` refuses duplicate instance item names, and `renderSite` refuses an instance that collides with another release (for example `hub` with item `a` next to `hub-a.release.json`). Both cases are tested.
- **Commit:** dc1dd1be

**3. [Rule 2 - Missing critical] Every render pins the Kubernetes version and re-checks the tarball.**
- **Found during:** Task 1
- **Fix:** each render passes `--kube-version 1.37.2` (RKE2 v1.37.2+rke2r1) instead of helm's default, and re-checks the vendored tarball's SHA-256 before helm runs. The check is cheap, and the install path uses this same function.
- **Commit:** b1104c70

**4. Sequencing: the harness refusals shipped in Task 1.**
- **Found during:** Task 1
- **What happened:** `render.mjs` was written once, so its refusals arrived in Task 1. Their test case arrived in Task 2, as the plan says.
- **Commit:** b1104c70 (refusals), dc1dd1be (test)

**5. Extra exports and a cert-manager mapping note.**
- **Found during:** Task 1
- **Exports:** besides the planned API, the modules export `renderSite`, `expandInstances`, `isEnabled`, `siteValue`, `splitRef` and `allImages`, because the test and the CLI use them.
- **cert-manager mapping:** it uses the chart's per-component `image.registry` key, which upstream marks as deprecated. The fixed part list has no `<registry>/<repository>` part, and this key works in the vendored v1.21.3.
- **Commit:** b1104c70

### Pin deviations (plan rule "pin the chart version that carries that app version")

- **Harbor** and **Fluent Bit** have no published chart for the decided app versions, v2.15.5 and v5.2.0. This was checked on 2026-11-23 in each repository index and in the GitHub releases.
- The newest charts are pinned instead (1.19.4 and 0.58.3), with a `note` in each lock entry.
- The plans that write their values must pin the images to the decided versions by digest, or record the older app version.

## Known Stubs

None that block the plan's goal. The site example leaves `siteName`, `domain`, `rpId`, `registry`, `clusterCidrs.nodes`, `requestedStorage` and `organizationPublicKey` empty on purpose: each site must supply them (D-08, D-11), and the CI fixture fills them.

## Owner items

- **Harbor v2.15.5 and Fluent Bit v5.2.0 have no upstream chart yet.** Should the newer image run on the older chart (the default here), or should the stack use the app versions those charts carry (Harbor 2.15.4, Fluent Bit 5.1.3)?
- E1 (Theia Cloud pinned to 1.2.0) and confirm item 10 (the shared `rpId` parent domain for your organization) are still open; both were recorded before this plan.

## Self-Check: PASSED

- All 11 planned files and 14 tarballs exist (`vendor.mjs --check` exit 0).
- Commits b1104c70 and dc1dd1be are ancestors of HEAD.
