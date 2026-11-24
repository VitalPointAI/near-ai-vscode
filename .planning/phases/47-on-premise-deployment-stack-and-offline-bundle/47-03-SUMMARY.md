---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 03
subsystem: deploy
status: complete
tags: [image-lock, digest-pinning, helm, release-descriptors, theia-cloud, kyverno, harbor, zot, openbao, keycloak, longhorn, opensearch, fluent-bit, prometheus]
requires: [47-01, 47-02]
provides:
  - "deploy/bundle/images.lock.json complete for the phase: 38 third-party images (linux/amd64 manifest digests), 9 built, 1 release"
  - "13 new release descriptors and values files; 14 descriptors in total, one per vendored chart"
  - "render image part name (<registry>/<repository>) for charts that join repository and tag"
  - "site global storageProvider"
affects: [47-04, 47-05, 47-07, 47-08, 47-09, 47-10, 47-11, 47-13, 47-15, 47-16]
tech-stack:
  added: []
  patterns:
    - "Each descriptor maps a lock name to the chart's own image keys; charts that build <repository>:<tag> get name + tagAtDigest, charts with a digest key get name + digest"
    - "Values files hold only image-determining and pull settings; later plans extend them"
key-files:
  created:
    - deploy/values/theia-cloud.release.json
    - deploy/values/theia-cloud.yaml
    - deploy/values/theia-cloud-base.release.json
    - deploy/values/theia-cloud-base.yaml
    - deploy/values/theia-cloud-crds.release.json
    - deploy/values/theia-cloud-crds.yaml
    - deploy/values/kubernetes-ingress.release.json
    - deploy/values/kubernetes-ingress.yaml
    - deploy/values/kyverno.release.json
    - deploy/values/kyverno.yaml
    - deploy/values/zot.release.json
    - deploy/values/zot.yaml
    - deploy/values/harbor.release.json
    - deploy/values/harbor.yaml
    - deploy/values/openbao.release.json
    - deploy/values/openbao.yaml
    - deploy/values/keycloakx.release.json
    - deploy/values/keycloakx.yaml
    - deploy/values/longhorn.release.json
    - deploy/values/longhorn.yaml
    - deploy/values/opensearch.release.json
    - deploy/values/opensearch.yaml
    - deploy/values/fluent-bit.release.json
    - deploy/values/fluent-bit.yaml
    - deploy/values/prometheus.release.json
    - deploy/values/prometheus.yaml
  modified:
    - deploy/bundle/images.lock.json
    - deploy/bundle/lib/locks.mjs
    - deploy/bundle/lib/render.mjs
    - deploy/values/site.example.yaml
    - deploy/test/fixtures/site.ci.yaml
key-decisions:
  - "Every third-party image is pinned by its linux/amd64 manifest digest (spike S1); the four cert-manager entries were re-pinned from their index digests"
  - "Keycloak 26.8.2: no 26.8.3 is published (quay.io tag list, 2026-11-23); 26.8.2 and its rebuild tag 26.8.2-3 share one digest"
  - "keycloak-config-cli 6.5.1-26.5.5: the newest 6.5.1 build for Keycloak 26 (the floating 6.5.1-26 tag has a different digest)"
  - "Harbor v2.15.5 and Fluent Bit v5.2.0 images run on the older charts (1.19.4, 0.58.3), the 47-02 default; owner item still open"
  - "Kyverno: admission controller only; legacy-policy-check and CRD-migration hooks off (kyverno-cli not bundled); the pre-delete webhook cleanup hook kept, it uses the same readiness-checker image the unavoidable chart test pods use"
  - "Render harness gains the image part name, so a chart that joins repository and tag still takes the repository path from the lock instead of a copy in a values file"
  - "Built sterling/openbao carries tag 2.7.3 because the OpenBao chart always joins repository and tag; the digest is what pins it"
requirements-completed: [DEP-07, DEP-10, DEP-12]
duration: ~50min
completed: 2026-11-24
estimate:
  tokens: 85000
  tasks: 3
actuals:
  tokens: 8150
  tasks: 3
  commits: 3
plan_head_before: c13ab1834c875b0f8af52dc38e2ef2e097083906
plan_head_after: 8e87462fcd87af8f53fb110c6aef8f49b713b958
---

# Phase 47 Plan 03: Image lock, release descriptors and values for every vendored chart Summary

Every image the 14 vendored charts render is now in `deploy/bundle/images.lock.json`, pinned by its linux/amd64 manifest digest, under its D-53 component. Our own nine rebuilt images and Phase 46's workbench are listed separately with null digests. Each chart has a release descriptor (namespace, install order, image mappings) and a values file that holds only the settings that decide which images render. The render test renders all 14 releases offline and passes.

## Tasks

| Task | Result | Commit |
|---|---|---|
| 1. Theia Cloud tracer: built and release sections, three Theia Cloud releases, cert-manager re-pin | done; tracer gate re-ran the render test end to end before expanding | c5a124a7 |
| 2. Ingress, Kyverno, Zot, Harbor, OpenBao, Keycloak | done | 572b666b |
| 3. Longhorn, OpenSearch, Fluent Bit, Prometheus, lab session image, `storageProvider` | done | 8e87462f |

## Releases

| Release | Namespace | Order | Condition | Images |
|---|---|---|---|---|
| zot | sterling-registry | 10 | registryKind zot | zot |
| harbor | sterling-registry | 10 | registryKind harbor | core, portal, jobservice, registry-photon, registryctl, harbor-db, valkey-photon (v2.15.5) |
| kyverno | kyverno | 20 | | kyverno, kyvernopre, readiness-checker |
| cert-manager | cert-manager | 30 | | (47-02) controller, webhook, cainjector, startupapicheck |
| kubernetes-ingress | haproxy-controller | 35 | | kubernetes-ingress 3.4.1 (also runs the CRD job hook) |
| longhorn | longhorn-system | 38 | storageProvider longhorn | manager, engine, instance-manager, share-manager, backing-image-manager, ui, support-bundle-kit, six CSI sidecars |
| openbao | sterling-openbao | 40 | | built sterling/openbao |
| keycloakx | sterling-identity | 55 | | quay.io/keycloak/keycloak 26.8.2 |
| theia-cloud-crds | theia-cloud | 60 | | built conversion webhook |
| theia-cloud-base | theia-cloud | 61 | | none |
| theia-cloud | theia-cloud | 62 | | built operator, service, landing page |
| opensearch | sterling-logging | 80 | | opensearch 3.10.0 |
| fluent-bit | sterling-logging | 82 | | fluent-bit 5.2.0 |
| prometheus | sterling-monitoring | 84 | | prometheus v3.16.0, config-reloader v0.95.2, kube-state-metrics v2.20.0, node-exporter v1.13.1 |

In the lock but not mapped by any release yet, by design: `docker.io/adorsys/keycloak-config-cli` (the realm release, 47-08) and `registry.access.redhat.com/ubi9/nginx-126` (the lab session image for the sterling-site AppDefinition, D-55; same digest as the landing page Containerfile's runtime stage).

## How the digests were read

A scratch script (not committed) made anonymous registry manifest requests: it read each tag's index, took the `linux/amd64` entry, fetched that manifest by digest and checked that its bytes hash to the digest; for the index it also checked the body hash against `Docker-Content-Digest`. No image was pulled. Every pinned digest is a linux/amd64 image manifest (OCI or Docker media type), never an index. The cert-manager index digests 47-02 recorded were reproduced as the parents, and `ubi9/nginx-126:9.9` resolved to the same digest 47-01 pinned in the landing page Containerfile.

## Base images, recorded honestly

This plan records no base-image or FIPS claim for any third-party image. Of what it pins, only `ubi9/nginx-126` is a UBI 9 image; the Harbor images are Photon OS based (their names say so); the others were not inspected for their base. None is a FIPS-validated build. The fit verdicts and conditions (Debian and Alpine bases fail SC-13 at Protected B, UBI 9 with FIPS is the direction) are written by 47-04, not here.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] New image part `name` in the render harness.**
- Found during: Task 2
- Issue: most charts build an image as `<repository>:<tag>` with no separate registry key (HAProxy, Zot, Harbor, OpenSearch, Keycloak, Prometheus server). The fixed part list (ref, registry, repository, digest, tagAtDigest) could only express them by writing the repository path a second time in a values file, which can drift from the lock.
- Fix: `IMAGE_PARTS` gains `name` = `<site registry>/<sitePath>`. The global invariant test exercises it through every release that uses it.
- Files: deploy/bundle/lib/render.mjs. Commit: 572b666b

**2. [Rule 3 - Blocking] Built `sterling/openbao` carries `tag: "2.7.3"`.**
- Found during: Task 2
- Issue: the OpenBao chart always renders `<registry>/<repository>:<tag>`; a tagless built image cannot be expressed. `resolveImage` already reads an optional `tag` on built entries.
- Fix: tag 2.7.3 (the OpenBao release the image is built from), with a note; the digest still pins it. locks.mjs header documents the optional field.
- Commit: 572b666b

**3. [Rule 1 - Bug] OpenSearch `majorVersion: "3"`.**
- Found during: Task 3
- Issue: the chart parses `image.tag` as a semantic version unless `majorVersion` is set; `<tag>@<digest>` is not one, so the render failed.
- Commit: 8e87462f

**4. [Rule 1 - Bug, D-07] Harbor's default ingress annotations removed.**
- Found during: Task 2
- Issue: the chart's default ingress carries `nginx.ingress.kubernetes.io/*` annotations, which the D-07 invariant forbids.
- Fix: those two annotations set to null and `className: haproxy`.
- Commit: 572b666b

### Plan items the charts cannot express (recorded, not worked around)

- **theia-cloud-crds pull policy:** the chart's conversion webhook template has no pull policy key. The image is referenced by digest (not `:latest`), so Kubernetes defaults it to `IfNotPresent`. The values file records this; 47-15's carried patch may make it explicit.
- **kubernetes-ingress default backend:** chart 1.57.1 has none; only the controller image renders (the CRD job hook uses it too).

## Findings for later plans

- **theia-cloud-base (47-13, 47-15):** `issuerca.enable: false` and `issuerprod.enable: false` remove the ACME issuer and the `selfSigned` issuer. The chart still renders, unconditionally, the CA-type ClusterIssuer `theia-cloud-selfsigned-issuer` and the Certificate `theia-cloud-ca-certificate` that feeds it. The crds chart's conversion webhook certificate uses that issuer. With `issuerca` off, nothing issues that Certificate. Research Decision 12 step 4 assumed both were removed. The Theia Cloud issuers must be pointed at the site PKI.
- **theia-cloud operator argument:** in annotation mode the chart still passes `--wondershaperImage theiacloud/theia-cloud-wondershaper:1.2.0`. That image is never pulled, so it is not bundled.
- **cert-manager:** the unused ACME solver argument is `registry.site.example/jetstack/cert-manager-acmesolver:v1.21.3`, with no digest. 47-02 recorded this on purpose: no ACME issuer exists.
- **The render invariant reads only `image:` lines.** Longhorn passes six images to the manager as arguments and the six CSI sidecars as environment values. A one-off grep of the full render confirmed that every site-registry reference there is digest-pinned and in the lock. The only unpinned site reference is the ACME solver argument above, and no public-registry host appears outside CRD descriptions. A future invariant could check every site-registry reference. Whether Longhorn's manager accepts `<tag>@<digest>` in those arguments is a lab check (47-16, Phase 48).
- **Zot (47-10):** the values must add `http.compat: ["docker2s2"]` (spike S1); noted in `zot.yaml`.
- **OpenSearch (47-16):** with the sysctl init container off, every node needs `vm.max_map_count >= 262144`, set on the host; the preflight should check it.
- **Kyverno:** turn the CRD migration hook back on, with kyverno-cli pinned, for the first Kyverno upgrade that needs a stored-version migration.
- **PGDG RPMs:** untouched. `compliance/ci/tool-pins.json` is not changed by this plan.

## Verification

- `flock ... systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 300 env HELM=compliance/out/tools/linux-amd64/helm node scripts/run-tests.mjs deploy/test/render.test.mjs`: 7 tests run, 7 pass, 0 fail, run after each task. No tests were added; the existing global invariant now covers 14 releases. Diagnostics list the six unpublished-digest uses (Theia Cloud four, OpenBao two).
- Acceptance checks (node one-liners): built 9 entries and release 1, every digest null; 14 descriptors for 14 charts; every `ref` ends in `@sha256:` plus 64 hex; every component in the D-53 list; Keycloak 26.8.x and keycloak-config-cli 6.5.1 present (2); `ubi9/nginx-126` pinned; no `loki` or `grafana/` reference; no two third-party images share a site path; `site.example.yaml` parses with `JSON.parse` and has `storageProvider`.
- `render.mjs --release theia-cloud` prints `registry.site.example/sterling/theia-cloud-operator@sha256:000...`; `theia-cloud-base` renders no ACME issuer.
- `node scripts/resource-check.mjs`: passed, 54 resources. This was expected: the unextended checker does not read the lock yet (47-04).

## Known Stubs

None. Null digests for our own images are the designed unpublished state: the render uses the reserved digest and the install refuses it.

## Self-Check: PASSED

- FOUND: every file in key-files (26 created, 5 modified).
- FOUND in history: c5a124a7, 572b666b, 8e87462f (ancestors of HEAD).
