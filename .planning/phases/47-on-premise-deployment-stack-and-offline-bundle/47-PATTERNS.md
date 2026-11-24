# Phase 47: On-premise deployment stack and offline bundle - Pattern Map

**Mapped:** 2026-11-23
**Files analyzed:** ~14 groups (most of deploy/ is new)
**Analogs found:** 9 / 14 groups

All analog paths are git-tracked (checked with git ls-files).

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match |
|---|---|---|---|---|
| `scripts/resource-check.mjs` (modify: add deploy inputs) | utility/checker | transform | itself (`IMAGE_FILES`, `parseImage`, `discover`, `check`) | exact |
| `scripts/test/resource-check.test.mjs` (modify) | test | fixture | itself (`fixture()`, `entry()`, `REPO`) | exact |
| `compliance/resources.json` (modify: all fit entries) | config/register | CRUD | existing entries (lines 5-26) | exact |
| `compliance/components/deployment.json` (new) | config (OSCAL) | static | `compliance/components/appliance.json` | exact |
| `compliance/test/components.test.ts` (modify: list) | test | file-check | itself | exact |
| `compliance/ci/tool-pins.json` + `install-tool.sh` (modify: hauler, cosign, helm, kyverno-cli...) | config/script | batch | itself | exact |
| `.github/workflows/ci.yml` (add `deploy`, rebuild-image jobs; add to `compliance` needs) | CI | batch | `relay-image-scan` job (ci.yml 359-420) | exact |
| `deploy/bundle/build.mjs sign.mjs import.mjs check.mjs install.mjs` | utility | file-I/O, transform | `scripts/org-issuer.mjs` (node:crypto sign/verify) | role-match |
| `deploy/bundle/images.lock.json`, `deploy/charts/charts.lock.json` | config | static | `compliance/ci/tool-pins.json` | role-match |
| `deploy/images/*/Containerfile` | config | build | `hub/Dockerfile` | exact |
| `deploy/charts/sterling-hub/` (hub pod hardening) | config | k8s | `relay/compose.yaml` hub service | role-match |
| `deploy/test/*.test.mjs` | test | invariants | `scripts/test/resource-check.test.mjs` | role-match |
| `deploy/keycloak|openbao/apply.mjs`, `rke2/*`, `runbooks/*`, `lab/run.sh` | script/config/docs | request-response | none | none |
| Release signing/SBOM/attestation for bundle | CI | batch | `release.yml` `attest` job (331-366) | exact |

## Pattern Assignments

### `scripts/resource-check.mjs` and test (checker extension)

**Header/imports** (lines 7-23): zero dependencies, files read as text, exported constants frozen.
```js
import { existsSync, readdirSync, readFileSync } from 'node:fs';
export const IMAGE_FILES = Object.freeze(['hub/Dockerfile', 'relay/Dockerfile', 'relay/compose.yaml']);
export const KINDS = Object.freeze(['npm', 'image', 'action', 'vendored']);
const ID_PREFIX = Object.freeze({ npm: 'npm:', image: 'image:', action: 'action:', vendored: 'vendor:' });
const add = (found, id, kind, where, extra = {}) => { /* merge into found Map by id, de-dup where[] */ };
export function parseImage(ref) { /* name without tag/digest + pinned = sha256:64hex */ }
```
Add `deploy/bundle/images.lock.json` and `deploy/charts/charts.lock.json` readers feeding `add(found, 'image:'+name, 'image', file)` and a pinned-by-digest check. Keep `check(register, discovered, known)` and `discover(root)` signatures (both exported, tested). The file is a gate path (`scripts/lib/workflow.mjs` GATE_PATHS 604-606): Plan 1 only.

**Test pattern** (`scripts/test/resource-check.test.mjs` 1-30): `fixture(files)` builds a tmp repo with `mkdtempSync`; `entry(id, kind, where, extra)` builds a full register entry (fields: id, kind, where, component, scope, purpose, licence, controls, evidence, crypto, cveResponse, airGap, fit, reviewer, reviewedAt); a `REPO` fixture object per kind. Add one fixture file per new input and assert on `check(...)` problems. This directory is a gate path, so new deploy tests go under `deploy/test/`, not here.

### `compliance/components/deployment.json`
**Analog:** `compliance/components/appliance.json` (single-line OSCAL component-definition). Copy structure: `component-definition.metadata`, one `components[]` with `props: [{name:'component-id', ns:'urn:near-ai-vscode:compliance', value:'deployment'}]`, `control-implementations[]` with `source: 'catalogs/itsp-10-033/catalog.json'`, `implemented-requirements[]` each with `control-id`, `props` responsibility, `statements[]` (`statement-id` form `ac-03_smt.<name>`). Use fresh UUIDs (appliance uses `...4001/4101/4201` pattern). Register the file in the list in `compliance/test/components.test.ts` (tests use `ROOT`, `COMPONENTS = compliance/components`, `loadComponents`, `existsSync` checks, lines 12-24).

### `compliance/ci/tool-pins.json` + `install-tool.sh`
Pin shape (per tool): `version` (x.y.z), `url`, `sha256`, `checksumUrl`, `archive` (`zip`|`tar.gz`), `bin`. `install-tool.sh` validates host against an allow-list (`["repo1.maven.org","github.com"]`, line 29), the semver, sha256, archive and bin path before download; checks hash before extract; never pipes into a shell. New tools: add a pin entry, extend the usage string and (if needed) the host allow-list; document bump in `TOOLS.md`. Gate path (`.github`-adjacent via compliance/ci: confirm in Plan 1).

### `.github/workflows/ci.yml` new `deploy` job
**Analog:** `relay-image-scan` (ci.yml 359-420): pinned `uses:` by 40-char SHA with `# vX` comment, `permissions: contents: read`, `persist-credentials: false`, `fetch-depth: 0`, the "has this commit the files" guard step writing `present=` to `$GITHUB_OUTPUT`, every later step `if: steps.has_*.outputs.present == 'true'`, tools via `sh compliance/ci/install-tool.sh <tool> compliance/out/tools` then `find ... >> "$GITHUB_PATH"`, SBOM `syft scan <img> --output cyclonedx-json=...`, `grype ... --only-fixed --fail-on high`, `actions/upload-artifact` with `if: always()`. Add the new job id to the `compliance` job `needs: [...]` (line ~417).

### Bundle signing/attestation
**Analog:** `release.yml` `attest` job (331-366): `permissions: contents: read, id-token: write, attestations: write`; `download-artifact` then `sha256sum --check --strict subjects.sha256` before `actions/attest@<sha> # v4.2.2` with `subject-checksums: release/subjects.sha256`. Reuse for the bundle tarball and its manifest.

### `deploy/bundle/sign.mjs`, `check.mjs`, `import.mjs` (signature verify in Node)
**Analog:** `scripts/org-issuer.mjs` line 29 imports `createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign` from `node:crypto`; `src/domain/gate/enrolment.ts` (`verifyOrganizationLayer(candidate, { issuerPublicKey, now })`) and `src/domain/team/signedPayload.ts` / `canonical.ts` hold canonical-JSON signed-payload verification. Copy: canonical serialization before sign, public key passed in (not read from the bundle), fixture key in tests. Zero npm dependencies in `deploy/bundle/*.mjs` to keep the air-gap fit trivial. Read these two files in full at plan time for exact signatures; not excerpted here.

### `deploy/images/<name>/Containerfile`
**Analog:** `hub/Dockerfile`: leading comment explaining pin/re-pin procedure; `FROM <ref>@sha256:<digest> AS build` then final stage pinned by digest; `npm ci --ignore-scripts`; copy artifacts into skeleton dirs with `chmod`, final stage `COPY --from=build --chown=0:0`; `USER 65532:65532`; `ENTRYPOINT`. For Theia Cloud rebuilds use UBI base per RESEARCH; keep digest-only FROM so `resource-check` parses them (extend `IMAGE_FILES` or glob `deploy/images/*/Containerfile`).

### `deploy/charts/sterling-hub` (hub pod securityContext)
**Analog:** `relay/compose.yaml` hub service (lines 93-124). Map to Kubernetes:
```yaml
user: "65532:65532"          -> runAsUser/runAsGroup 65532, runAsNonRoot: true
read_only: true              -> readOnlyRootFilesystem: true
cap_drop: [ALL]              -> capabilities.drop: [ALL]
no-new-privileges:true       -> allowPrivilegeEscalation: false
pids_limit 128 / mem_limit 512m -> resources.limits.memory 512Mi (+ pids via kubelet)
tmpfs /tmp 16m mode 0700     -> emptyDir medium Memory sizeLimit 16Mi
secrets hub_tls_cert, hub_tls_key, hub_signing_key, hub_encryption_key -> Secret volume files (0400) at /run/secrets/*
env HUB_HOST/HUB_PORT=8443/HUB_STATE_DIR=/var/lib/near-ai-hub/HUB_*_FILE
```
Hub ends TLS itself: ingress must be TCP/TLS passthrough (HAProxy), never terminate.

### `deploy/test/*.test.mjs`
Use `node:test` + `node:assert/strict` as in `scripts/test/resource-check.test.mjs`; assert invariants by reading files as text/JSON (digest-pinned images, no `latest`, no ACME, PSA labels). Not run by `npm test` glob (`scripts/test/*.test.mjs`); the new `deploy` CI job runs `node scripts/run-tests.mjs deploy/test/*.test.mjs` (runner sets per-run TMPDIR and cleans up; run-tests.mjs lines 1-25).

## Shared Patterns
- **Pin everything by digest/sha256**, with the pin in one lock file read by checker, build, and CI (tool-pins.json model).
- **Gate paths** (`scripts/lib/workflow.mjs` 595-607): `.github/`, `scripts/test/`, `scripts/resource-check.mjs`, `compliance/resources.json`. Touch these only in Plan 1 (matches RESEARCH decomposition).
- **Register entry fields** (resources.json 5-26): every new image, chart, action and tool needs a full entry with `controls`, `crypto`, `cveResponse`, `airGap` (`ok|no|needs-mirror:...`), `fit`, `reviewer`, `reviewedAt` 2026-11-23.
- **Guard-then-run CI** (`present` output) so a PR before the files exist does not fail.

## No Analog Found
| File | Role | Reason |
|---|---|---|
| `deploy/keycloak/apply.mjs`, `deploy/openbao/apply.mjs`, `enrol.mjs` | service client | no existing Node HTTP-admin scripts against Keycloak/OpenBao; use RESEARCH |
| `deploy/rke2/*`, `deploy/charts/*` Helm templates, Kyverno policies | k8s config | no Kubernetes manifests in repo (only compose) |
| `deploy/bundle/hauler-manifest.yaml`, `deploy/lab/run.sh` | config/script | no hauler/qemu precedent; shell style may follow `compliance/ci/install-tool.sh` (`set -eu`, usage check, exit 2 on bad args) |
| `deploy/runbooks/*.md` | docs | follow `compliance/README.md` / `relay` docs tone |

## Metadata
**Analog search scope:** scripts/, compliance/, .github/workflows/, relay/, hub/, src/domain/{gate,team}
**Pattern extraction date:** 2026-11-23

## PATTERN MAPPING COMPLETE
