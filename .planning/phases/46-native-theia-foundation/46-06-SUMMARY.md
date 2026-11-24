---
phase: 46-native-theia-foundation
plan: 06
subsystem: ci
tags: [ci, release, cosign, sbom, syft, grype, playwright, supply-chain, d-28, d-31, d-40]
status: complete

requires:
  - phase: 46-01
    provides: "the minimal workbench CI job, release.yml building from workbench/Dockerfile"
  - phase: 47 (#172)
    provides: "the cosign 3.1.4 pin, the binary archive kind in install-tool.sh, tool:cosign/syft/grype register entries, the key-mode pattern in deploy-images.yml"
provides:
  - "ci.yml workbench job: audit (report-only), image build, Playwright container suite, SBOM, Grype scan and image digest artifacts"
  - "release.yml image job: release image CycloneDX SBOM (output sbom_sha256, artifact sterling-image-sbom), Grype report-only, hash-checked cosign handed to publish (output cosign_sha256, artifact release-cosign)"
  - "release.yml publish job: key-mode cosign sign and SBOM attestation of the pushed digest, both verified, in the container-release environment"
affects: [47, 32.1, 33]

actuals:
  tokens: 12500       # chars/4 over the added lines of the three code commits
  tasks: 3
  commits: 3          # measured: git rev-list --count fc8666e1..8b6f1730
plan_head_before: fc8666e1f02c97420b918b4b443d919224c8b4a1
plan_head_after: 8b6f1730

tech-stack:
  added: []
  patterns:
    - "A job holding a write token checks out no code: the read-only image job installs the pinned tool and hands publish the binary with its repository hash, checked again before use"
    - "cosign key mode with an empty signing config (no transparency log, no timestamp authority), verified with the public key derived from the same key in the same job"

key-files:
  created: []
  modified:
    - .github/workflows/ci.yml
    - .github/workflows/release.yml
    - scripts/test/workflow-files.test.mjs
    - docs/development-workflow.md
    - compliance/ci/TOOLS.md
    - compliance/resources.json

key-decisions:
  - "Signing lives in #165's Release workflow publish job (release tags only, container-release environment), not in a main-push job: the one published image is the one signed"
  - "cosign is installed in the read-only image job and handed to publish with the tool-pins.json hash, because the existing privilege test forbids checkout and npm in jobs that hold a write token"
  - "The workbench npm audit step is report-only: zod GHSA-mrhx-c7xc-m3w5 (high) through @theia/ai-mcp has no fix inside Theia 1.77.0"
  - "The cosign pin, the binary kind and the installer case were already on main from Phase 47 (#172) and were reused, not duplicated"

requirements-completed: [FND-T-09]

duration: about 1 h 30 min
completed: 2026-11-24
---

# Phase 46 Plan 06: Workbench CI and the image's supply chain Summary

**Every PR now builds and tests the workbench. The `workbench` job audits it, builds its image, drives that image in Chromium through the container suite, and records the image's CycloneDX SBOM, Grype scan and image ID. The Release workflow's `publish` job signs the one published GHCR digest and attests its SBOM with your organization's cosign key, in key mode with no transparency log. It verifies both in the same job and runs only on release tags in the protected `container-release` environment.**

## Owner approval needed in the PR

These are gate files:
- `.github/workflows/ci.yml`: the `workbench` job's new steps. It is not a required check, and `CI_CHECKS` is unchanged.
- `.github/workflows/release.yml`: the `image` job gains SBOM, scan and cosign hand-off steps after #165's archive upload, plus two outputs. The `publish` job gains four steps after #165's unchanged download and push steps. Its permissions stay exactly `packages: write`.
- `scripts/test/workflow-files.test.mjs`: four new tests at the end of the file. No existing test was changed.
- `compliance/resources.json` (outside this plan's list, see deviation 3): the cosign, Syft and Grype purposes and the node image entry are updated, and an audit condition is added to `@theia/plugin-ext-vscode`.
- The cosign tool use (`compliance/ci/TOOLS.md`, new section "cosign 3.1.4 for the Sterling workbench image"). The pin itself came from #172 and is unchanged.

## User setup (owner)

1. On your own machine, run `cosign generate-key-pair` and choose a password.
2. In GitHub, open Settings, then Environments, then `container-release`. Add two secrets: `COSIGN_PRIVATE_KEY` (the encrypted PEM) and `COSIGN_PASSWORD`. The environment keeps its existing settings: the owner as required reviewer, `v*.*.*` tags only, no admin bypass. `deploy-images.yml` (Phase 47) already expects the same two secrets there.

If the key is missing, the publish job stops after the push with one plain line naming the environment and the secret. A re-run reuses the pushed tag (#165's design).

## cosign flags, confirmed from 3.1.4's help and one offline run

The 3.1.4 binary was installed with `install-tool.sh cosign` (SHA-256 OK) and reports `GitVersion: v3.1.4`. Its `sign`, `attest`, `verify`, `verify-attestation` and `signing-config create` help was read. In 3.1.4, `--tlog-upload=false` appears only as a help example. The empty signing config is what keeps key mode away from every public service, as spike S1 (47-01) found.

The following commands were then run once against a throwaway local registry (zot, the digest Phase 47 registered), with `HTTPS_PROXY` set to a dead port so any public call would fail:

```sh
cosign signing-config create --out signing-config.json   # {"mediaType":"...signingconfig.v0.2+json","rekorTlogConfig":{},"tsaConfig":{}}
cosign sign --key env://COSIGN_PRIVATE_KEY --signing-config signing-config.json -y <image@digest>
cosign attest --key env://COSIGN_PRIVATE_KEY --signing-config signing-config.json --type cyclonedx --predicate <sbom> -y <image@digest>
cosign public-key --key env://COSIGN_PRIVATE_KEY > cosign.pub
cosign verify --key cosign.pub --insecure-ignore-tlog <image@digest>
cosign verify-attestation --key cosign.pub --insecure-ignore-tlog --type cyclonedx <image@digest>
```

All four passed. The proof run also needed `--allow-insecure-registry`, which is only for the local HTTP registry and is not used in the workflow. The throwaway key, registry container, proof image and zot image were all removed.

## Audit outcome

On 2026-11-24, `npm audit --omit=dev --audit-level=high` in `workbench/` fails. It reports 47 advisories: 3 low, 43 moderate and 1 high. The high one is zod 3.25.76, below 4.6.6 (GHSA-mrhx-c7xc-m3w5, memory exhaustion while validating oversized constrained collections). It comes in only through `@theia/plugin-ext-vscode` > `@theia/plugin-ext` > `@theia/ai-mcp` > `@modelcontextprotocol/sdk`, and no fix exists inside Theia 1.77.0 (D-14).

Following the plan, that one step is report-only (`continue-on-error: true`). Its JSON (`workbench-audit.json`) is uploaded with `test-report-workbench`, and the condition is recorded on the `npm:@theia/plugin-ext-vscode` register entry.

## Planning choices (as reported)

1. The job runs on every PR and every push to main (like `hub`), not on a path filter, because the engine bundle reads `src/`. Reversible.
2. Signing lives in #165's Release workflow and follows release tags, not main pushes. D-31 said "on pushes to `main` only". The owner's decision is "only in the `container-release` environment; sign only on main and release tags, never keyless". Release tags are made only from main commits, or the head of `hotfix/<version>`, which `release.yml`'s build job checks. #165 already publishes the one GHCR image from those tags after the owner's approval. So the image that is published is the image that is signed, and no second publishing path exists. The signing step also refuses any ref that is not `refs/tags/v<x.y.z>`. Reversible.
3. Verification uses the public key derived from the private key in the same job (`cosign public-key --key env://COSIGN_PRIVATE_KEY`). The key's SHA-256 fingerprint goes into the step summary. Publishing the public key for sites belongs to Phase 47's key ceremony. Reversible.

## Manual check: the first signing

This waits on the owner. After the integration PR merges and the owner adds the two secrets, the first release tag's `publish` job, once approved, should push, sign, attest and verify the digest that the release job records. The expected result is a green job, with `cosign verify` and `verify-attestation` passing on the published digest and no transparency-log entry created. GHCR's handling of cosign v3's referrer format is the same one `deploy-images.yml` relies on, but it has not been exercised in this repository yet.

## Verification (tests run, separate from tests added)

Tests added: 4, all in `scripts/test/workflow-files.test.mjs`:
- the workbench job's shape;
- the workbench SBOM, scan and digest, and that the job pushes and signs nothing;
- the release image job's SBOM and cosign hand-off;
- the publish job's key-mode signing.

**RED on the base:**
- Task 1's test failed at "npm audit ... comes after the step before it".
- The three Task 3 tests failed before the workflow changes.

**Mutation checks** (each applied to a copy, run, then restored):
- an `id-token: write` in publish: 2 tests fail;
- `secrets.COSIGN_PRIVATE_KEY` in the push step's env: 1 fails;
- a keyless `cosign sign -y "$IMAGE"`: 1 fails.

**Runs:**
- `node scripts/run-tests.mjs scripts/test/workflow-files.test.mjs scripts/test/workflow.test.mjs`: 72 run, 72 passed.
- One run across the gate-adjacent tests: `node scripts/resource-check.mjs` (136 resources, passed), plus `workflow-files`, `workflow`, `resource-check`, `compliance/test/toolPins.test.ts`, `compliance/test/levels.test.ts`, and `dist/test/{relayIsolation,docsSiteIsolation,saaReleaseEvidence,gateFloor,hubIsolation}.test.js`. 159 run, 159 passed.
- `dist/test/copyLint.test.js` (28 passed) and `dist/test/gateDocs.test.js` (55 passed), run after the docs and TOOLS.md changes.
- `bash -n` over every multi-line `run:` script in `ci.yml` (18) and `release.yml` (21): all parse.
- Trial merge with PR #174 (`git merge-tree --write-tree HEAD origin/fix/release-publish-digest`): clean. The merged tree's `workflow-files.test.mjs` gave 25 run, 25 passed.
- Not run locally: the CI `workbench` job itself. It runs on the integration PR.

**Acceptance greps:**
- `^  workbench:$`: 1. 46-01 already made it 1, as noted.
- `WORKBENCH_TEST_IMAGE`: 1.
- `test-report-workbench`: 3.
- `workbench` in `docs/development-workflow.md`: 1.
- `"cosign"` in `tool-pins.json`: 2 (the key and its `bin` value; the pin is from #172).
- `binary)` in `install-tool.sh`: 1 (from #172).
- `cosign` in TOOLS.md: 16.
- `COSIGN_PRIVATE_KEY` in `release.yml`: 5.
- `cosign verify-attestation`: 1.
- `install-tool.sh cosign` in `release.yml`: 1.
- `sterling-image-sbom` in `release.yml`: 8.
- `id-token` in the publish region: 0.
- `cyclonedx-json=compliance/out/workbench-image-sbom.json`: 1.
- `cosign` in `ci.yml`: 2, not the plan's 0. Both are in the `deploy` job, from #172 ("Install pinned helm and cosign"), so the count was already 2 at HEAD. The new test applies the guard's intent to the `workbench` job, which has no cosign.

## Deviations from Plan

**1. [Rule 3 - Blocking] cosign is installed in the image job, not the publish job**
- **Issue:** `install-tool.sh` needs the repository's files. The existing test "release jobs that hold a write token ... run no npm install scripts" forbids `actions/checkout` and npm in any job with a write token, and weakening it is not allowed.
- **Fix:** The read-only `image` job runs `install-tool.sh cosign`, which checks the binary against the pin. It then checks the binary against `tool-pins.json`'s `cosign.sha256` again and outputs that hash. `publish` downloads the `release-cosign` artifact (retained 1 day) and checks it with `sha256sum --check --strict` before running it. This is the same chain of trust #165 uses for the image archive. The new artifact `release-cosign` and the output `cosign_sha256` are not in the plan's artifact list.
- **Commit:** 8b6f1730.

**2. Task 2 was already done on main (Phase 47, #172)**
- `tool-pins.json` has had cosign 3.1.4 with `archive: binary` since #172, together with the `binary)` installer case, the TOOLS.md deployment-stack note and the `tool:cosign` register entry. The plan's behaviour "exactly four tools" is out of date: #172 pins ten tools, and its test asserts that list.
- What this plan added is the TOOLS.md section for the Release workflow use, with the flags confirmed from 3.1.4. I added no duplicate pin test, because #172's generic pin-shape test already covers the binary kind.
- **Commit:** 5d29823c.

**3. `compliance/resources.json` edited (it is in 46-04's `files_modified`, not 46-06's)**
- **Why:** the owner's decision requires every resource this plan uses to have a passing entry, and 46-04's plan asked for the node image's pending condition to be dropped once 46-06 landed. Both plans run on this branch.
- **Changes:**
  - `tool:cosign`, `tool:syft` and `tool:grype` name the new uses.
  - `image:docker.io/library/node` drops "Pending 46-06", and its evidence and CVE response now name the CI scan and the release signature.
  - `npm:@theia/plugin-ext-vscode` gains the audit advisory condition.
- **Commit:** 8b6f1730.

**4. The SBOM steps run before the container suite**
- In the `workbench` job, the SBOM, scan and digest come right after the image build and before the Playwright install. A failing test then still leaves the evidence, and the uploads use `always()`. They describe the same `sterling-workbench:ci` image the suite tests.

**5. The npm commands use the job's `working-directory: workbench`**
- 46-01's job has `working-directory: workbench`, so the commands are written as `npm ci --ignore-scripts` and `npm audit ...` rather than `npm --prefix workbench ...`. They do the same thing.
- Playwright installs with `npx --no-install playwright install --with-deps chromium`, so npx can never fetch a package by itself.

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat model (T-46-20 to T-46-24). The new `release-cosign` artifact is covered by T-46-22: it is hash-checked against the repository pin in both jobs.

## Self-Check: PASSED

The commits e95f6c84, 5d29823c and 8b6f1730 are on `feat/phase-46-04-06`, and all six modified files exist.
