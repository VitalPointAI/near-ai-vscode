---
phase: 46-native-theia-foundation
plan: 01
subsystem: infra
tags: [theia, workbench, ubi9, node26, docker, playwright, rpc, native-addons, d-34]
status: complete

requires:
  - phase: "#162, #165, #166 (main)"
    provides: "the Sterling spike, the container-release Release workflow image job, the Get Started, Documentation and Compliance views"
provides:
  - "workbench/ package sterling-workbench (Theia 1.77.0 exactly, Node >=26.13.1 <27) with extension @near-ai/sterling-workbench-extension"
  - "workbench/Dockerfile: stages node, build (UBI), openbao-test, runtime (UBI), bundled-plugin, release, development (default, last)"
  - "D-34 evidence: Node 26.13.1 on ubi9/ubi-minimal loads drivelist and node-pty and serves Get Started to Chromium"
  - "bindBackendService / bindFrontendService and ServiceResult<T>; the Team preview on them at /services/sterling-team-preview"
  - "test/helpers/docker.ts (suffix, run, mustRun, freePort, testImage, runContainer, waitHealthy, runPlaywright, removeOwn)"
  - "a minimal workbench job in ci.yml (presence, install, lint, unit tests with report) for 46-06 to extend"
affects: [46-02, 46-03, 46-04, 46-05, 46-06, 46-07, 46-08, 47]

actuals:
  tokens: 40000       # chars/4 over the added lines of the rename-aware diff, lockfile and SUMMARY excluded
  tasks: 3
  commits: 5          # measured: git rev-list --count plan_head_before..HEAD at SUMMARY time; the SUMMARY commit follows
plan_head_before: 93c0872b157f0a011e6190dea9c54e16c21113e5
plan_head_after: e7c757dd95af54e6e4f212d524d50494cfb5fc90

tech-stack:
  added: ["@playwright/test 1.65.0 (with playwright and playwright-core 1.65.0)", "ubi9/ubi-minimal (index sha256:08d4c70f...)", "openbao/openbao 2.7.3 (test stage only)"]
  patterns:
    - "Literal digest-pinned FROM lines; COPY --from=<stage> only, never from an image or an ARG"
    - "Named native rebuilds on UBI; the UBI-built pty.node placed where Theia's bundler copies it"
    - "Backend code finds its files from import.meta.url (esbuild ESM bundle at lib/backend/main.js), never process.cwd()"
    - "One RPC helper pair (bindBackendService, bindFrontendService); refusals are returned plain data"

key-files:
  created:
    - workbench/package.json
    - workbench/package-lock.json
    - workbench/.npmrc
    - workbench/tsconfig.json
    - workbench/bin/start.mjs
    - workbench/bin/healthcheck.mjs
    - workbench/tools/build-engine.mjs
    - workbench/scripts/build.mjs
    - workbench/extension/src/node/sterling-backend-module.ts
    - workbench/extension/src/node/backend-service.ts
    - workbench/extension/src/browser/frontend-service.ts
    - workbench/extension/src/common/service-result.ts
    - workbench/test/helpers/docker.ts
    - workbench/test/container/smoke.test.ts
    - workbench/test/e2e/playwright.config.ts
    - workbench/test/e2e/smoke.spec.ts
    - workbench/test/team-preview.test.ts
  modified:
    - workbench/Dockerfile (moved, rewritten)
    - workbench/Dockerfile.dockerignore (moved)
    - workbench/README.md (moved)
    - workbench/extension/src/node/team-preview-reader.ts (moved, rewritten)
    - .github/workflows/release.yml
    - .github/workflows/ci.yml
    - scripts/resource-check.mjs
    - compliance/resources.json
    - .vscodeignore
    - .planning/spikes/theia-team-studio/README.md (pointer)

key-decisions:
  - "Task 1: @playwright/test 1.65.0 approved by the owner, 2026-11-24 (relayed by the coordinator); registry and provenance checks below support it"
  - "D-34 passed: upstream Node 26.13.1 on ubi9/ubi-minimal runs Theia 1.77, drivelist and node-pty; no Node major or base change"
  - "The app root is found from import.meta.url: Theia 1.77 bundles the backend with esbuild as ESM into lib/backend/main.js, so the URL is the bundle's own at run time"
  - "Names: app sterling-workbench, extension @near-ai/sterling-workbench-extension, RPC path /services/sterling-team-preview"
  - "The workbench pins the UBI minimal multi-arch index digest the plan names; its linux/amd64 manifest is the digest Phase 47's deploy images pin"
  - "A minimal workbench CI job lands here because the #172 reports test requires one as soon as workbench/package.json exists"

requirements-completed: [FND-T-01, FND-T-02, FND-T-07, FND-T-08, FND-T-10]

duration: about 3 h (including a session restart and waits on the shared heavy lock)
completed: 2026-11-24
---

# Phase 46 Plan 01: Native Theia foundation tracer Summary

**The Sterling spike is now the `workbench/` package; its image builds on digest-pinned UBI 9 minimal with the upstream Node 26.13.1 binary, loads drivelist and node-pty, and Chromium opens Get Started against it (D-34 passed); the Team preview runs on one shared RPC helper and the parser's own refusal reaches the browser unchanged.**

## Owner approval needed in the PR

Gate files this plan changes:
- `.github/workflows/release.yml`: the `image` job builds from `--file workbench/Dockerfile`; its smoke expects user `10001:0` and adds `-e STERLING_LISTEN_HOST=0.0.0.0`. Every other #165 step and its order are unchanged.
- `.github/workflows/ci.yml` (not in the plan's list; deviation 2): a minimal `workbench` job, not a required check.
- `scripts/resource-check.mjs`: `IMAGE_FILES` swaps the spike Dockerfile for `'workbench/Dockerfile'`. Nothing else changes.
- `compliance/resources.json`: the `image:docker.io/library/node` entry is rewritten; `image:registry.access.redhat.com/ubi9/ubi-minimal` gains `workbench/Dockerfile`; `image:docker.io/openbao/openbao` is added as test scope.
- New package `@playwright/test` 1.65.0, with `playwright` and `playwright-core` 1.65.0. See Task 1.

## Task 1: @playwright/test 1.65.0 package check

**Approved by the owner, 2026-11-24.** The coordinator relayed the approval during the run. The checks below were made before install and support it:
- `npm view @playwright/test@1.65.0`: the name and version match; licence Apache-2.0; repository `git+https://github.com/microsoft/playwright.git`; maintainers include `microsoft-oss-releases <microsoft-oss-publishing@microsoft.com>`, `microsoft1es <npmjs@microsoft.com>` and `dgozman-ms <dgozman@microsoft.com>`; published `2026-11-05T18:30:18Z`; `scripts: {}`; one dependency, `playwright` 1.65.0.
- SLSA v1 provenance attestation: subject `pkg:npm/%40playwright/test@1.65.0`, built by a GitHub-hosted runner from `https://github.com/microsoft/playwright` at `refs/tags/v1.65.0`, workflow `.github/workflows/publish_release.yml`. Published through npm OIDC (`_npmUser: GitHub Actions`).
- `playwright` and `playwright-core` 1.65.0 come from the same repository, have the same licence, and have no install scripts.
- After install, `npm audit signatures` in `workbench/` reports: 880 packages have verified registry signatures, and 139 have verified attestations.
- Its browsers come from Playwright's CDN at test time (`npx --prefix workbench playwright install chromium`: Chrome Headless Shell 158.0.8127.18), never from npm.

## D-34 evidence gate: PASSED

| Item | Result |
|------|--------|
| Base | `registry.access.redhat.com/ubi9/ubi-minimal@sha256:08d4c70f...` (multi-arch index; its linux/amd64 manifest is the `sha256:2cb89fea...` that Phase 47's deploy images pin) |
| Node | `v26.13.1`, OpenSSL `3.5.9`, binary from `node:26.13.1-slim@sha256:e6bedef2...` plus `libatomic` |
| Native addons | `drivelist` and `node-pty` rebuilt from source on UBI GCC 11 with Python 3.9. No `python3.12` fallback was needed. Inside the image, `require('drivelist')` loads, and a `node-pty` shell printed `STERLING-PTY-OK-42` |
| Backend | Starts on Node 26 in about 0.6 s, serves `/healthz` (`ok`), and stops on SIGTERM in 0.2 s (Theia exits with code 1 on SIGTERM) |
| Browser | Chromium shows the Get Started tab and the `Sterling Sovereign AI` heading. The Team preview shows `schedule-reviewer` from the Orchard sample and, for the invalid sample, the parser's exact message |
| Build time | 125 s for the first full build of the image. Base layers were already local, and npm packages were downloaded fresh. Later builds hit the layer cache. |
| Image size | 189,585,378 bytes (about 190 MB) |
| User and tree | `10001:0`, home `/home/sterling`. `/app` is owned by root and not writable. The image has no `@theia/cli`, esbuild, puppeteer or Playwright, and no npm or npx |

The Node major, the base image and the Theia version were not changed.

## Lockfile integrity

All 932 package entries of the spike lockfile that have a `resolved` field keep the same version, `resolved` and `integrity`. The only removed entry is the old `node_modules/@near-ai/theia-team-preview` link. Four entries were added: the renamed extension link, `@playwright/test`, `playwright` and `playwright-core`.

## App-root location expression

The reader uses `fileURLToPath(new URL('../..', import.meta.url))`. Theia 1.77 no longer uses webpack. It bundles the backend with esbuild as ES modules into `lib/backend/main.js` (`@theia/application-manager` `bundler-generator.js`: `format: 'esm'`, `outdir: 'lib/backend'`, no splitting), so `import.meta.url` is the bundle's own URL at run time and two folders up is the app root (`/app`). The browser spec confirms it on the image: the Orchard team loads, and the invalid sample shows the parser's message from `/app/engine/teams.cjs`. No source under `workbench/extension/src` reads `process.cwd()`.

## Files taken from docs/theia-container-release

Main lacked these files, so they were written from `git show docs/theia-container-release:<path>`: `extension/assets/sterling-area-{capability,operations,resources,training}.webp`, `sterling-hero-ca.webp`, `sterling-hero.webp`; `extension/src/browser/sterling-portfolio-module.ts` and `.css`, `sterling-resource-inventory-module.ts` and `.css`, `sterling-work-area-files.ts`, `sterling-work-area-resource-links.ts`, `sterling-work-areas-module.ts` and `.css`; `extension/src/common/sterling-portfolio.ts`, `sterling-resource-inventory.ts`, `sterling-work-areas.ts`; and the resource-links test, now `workbench/test/sterling-work-area-resource-links.test.mjs`. Their three frontend modules were added to `theiaExtensions`.

These files exist in both places, and main's version (#162, #165, #166) was kept. The counts are branch-only lines and main-only lines:
- `extension/src/browser/sterling-welcome-module.ts`: 223 and 40. The branch's Get Started has more content, probably the rail and work-area links. Not merged.
- `extension/src/browser/sterling-welcome.css`: 60 and 7.
- `extension/src/browser/sterling-compliance-module.ts`: 32 and 45.
- `extension/src/browser/sterling-documentation-module.ts`: 13 and 15.
- `extension/src/browser/team-preview-frontend-module.ts`: 5 and 5.
- `extension/src/node/team-preview-reader.ts`: 4 and 4. Superseded by Task 3 anyway.
- `tools/build-sterling-documentation.mjs`: 40 and 29.
- `extension/package.json`: 9 and 0. These are the three extra `theiaExtensions` entries, which were merged.
- `Dockerfile` (6, 33), `Dockerfile.dockerignore` (4, 19), `MIGRATION.md` (16, 4), `README.md` (104, 17).

`extension/test/sterling-evidence.test.ts`, which exists only on main, moved to `workbench/test/sterling-evidence.test.ts`.

## Step commits

| Step | Commit | Content |
|------|--------|---------|
| Task 2 step A, the move | `be904176` | `git mv` of every spike file, the branch-only files, the pointer README, and the release, fit-check and register paths |
| Task 2 step B, the package | `54b2118a` | package.json, .npmrc, lockfile, tsconfig, scripts/build.mjs, tools/build-engine.mjs, the minimal CI job |
| Task 2 step C, the image and natives | `4144f4db` | Dockerfile, bin/, /healthz, register entries, release smoke, container suite part 1 |
| Task 2 step D, the browser | `4365138a` | Playwright config and spec, suite part 2, README |
| Task 3, the RPC helper | `e7c757dd` | ServiceResult, bindBackendService, bindFrontendService, the reader rewrite, unit tests, the refusal end to end |

The branch was pushed after each commit (`origin/feat/phase-46-wave-1`).

## Verification (tests run, separate from tests added)

- `node scripts/resource-check.mjs`: passed, 124 resources.
- `node scripts/run-tests.mjs scripts/test/workflow-files.test.mjs scripts/test/resource-check.test.mjs`: 33 run, 33 passed.
- `npm --prefix workbench run lint`: clean.
- `npm --prefix workbench test`: 12 run, 12 passed. 7 tests moved from the spike and 5 were added in Task 3.
- `npm --prefix workbench run test:container`: 4 run, 4 passed, all new. In order: the natives on v26, user and runtime tree, the bind guard, and the browser test, which runs 2 Playwright tests that both pass.
- The release target was built by hand with a throwaway one-file VSIX and passed #165's smoke steps: user `10001:0`, `bundle.js` served, `/plugins/extension/package.json` present, and the CMD arguments reached the launcher. The throwaway file and image were removed.

TDD RED (Task 3): on the moved code, the test bundle failed to build. `Could not resolve "../extension/src/node/backend-service.ts"` and `"../extension/src/common/service-result.ts"`, and the moved reader exported only a fixed `teamPreviewReader` with no `createTeamPreviewReader`, so all 5 new tests failed before the implementation. The linked-parent case also fails on the spike's logic: it compared `realpath(file)` with the unresolved path.

## Planning choices (as reported)

1. Names: the app is `sterling-workbench`, the extension is `@near-ai/sterling-workbench-extension` 0.1.0, and the RPC path is `/services/sterling-team-preview`. Reversible.
2. Package legitimacy: the `@theia/*` tree comes from the owner-merged spike lockfile, unchanged. `@types/node` 26.6.6 was already in that tree and in the hub. `@playwright/test` was owner-approved (Task 1).
3. The no-sign-in guard from #162 applies only in local mode with a non-loopback bind. The default bind is `127.0.0.1`.
4. All package scripts and devDependencies are set here, including `theia.frontend.config.preferences` with `telemetry.telemetryLevel: "off"`.
5. The move also moved the release workflow's Dockerfile path, the fit check's `IMAGE_FILES` entry and the image register entries.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 3 - Blocking] node-pty prebuild path for Theia's bundler**
- **Found during:** Task 2 step C, the first image build.
- **Issue:** `npm_config_build_from_source=true` makes node-pty's install script delete its upstream `prebuilds/`, but Theia 1.77's esbuild plugin copies `pty.node` from `node-pty/prebuilds/<platform>-<arch>/`, so `theia build` failed with `Cannot find module 'node-pty/prebuilds/linux-x64/pty.node'`.
- **Fix:** After the named rebuild, the Dockerfile checks that both UBI-built binaries exist (`build/Release/drivelist.node` and `pty.node`), then copies the UBI-built `pty.node` to that prebuilds path. The upstream prebuild is never used.
- **Files:** `workbench/Dockerfile`. **Commit:** `4144f4db`.

**2. [Rule 3 - Blocking] Minimal `workbench` CI job**
- **Found during:** Task 2 step A.
- **Issue:** #172 merged a reports test into `scripts/test/workflow-files.test.mjs` after this plan was written. Once `workbench/package.json` exists, that test fails with "a workbench job exists for its report". The plan's verify requires that file to pass unchanged.
- **Fix:** I added a `workbench` job to `ci.yml` modelled on `hub`: the presence check with the hotfix rule, setup-node 26.13.1, `npm ci --ignore-scripts`, lint, and `npm test` with `NEAR_AI_TEST_REPORT` and the `test-report-workbench` upload. It is not in `CI_CHECKS`. 46-06 adds the audit, image build, container suite, SBOM, scan and digest, and its "HEAD=0" check for `^  workbench:$` now starts at 1.
- **Files:** `.github/workflows/ci.yml` (gate file). **Commit:** `54b2118a`.

**3. [Rule 1 - Bug] The prune left an empty `node_modules/@playwright` folder in the runtime**
- **Fix:** `rmdir --ignore-fail-on-non-empty node_modules/@*/` after `npm prune`. `typescript` stays in the runtime tree because it is a real production dependency (`@theia/filesystem` needs it through `opfs-worker`). The plan's list of excluded tools never named it.
- **Commit:** `4144f4db`.

**4. [Rule 1 - Test harness] The workspace-trust dialog makes the page inert**
- **Found during:** Task 3, the browser spec.
- **Issue:** Theia 1.77 opens "Do you trust the authors of the files in this folder?" on the new workspace. Until it is answered the page is inert, so neither F1 nor clicks reach the workbench.
- **Fix:** The spec declines once ("No, I don't trust the authors", which is restricted mode) and then runs the command from the palette as the plan says. The Get Started-only spec does not need this.
- **Note for 46-03 (egress and preferences):** decide whether the image sets a workspace-trust default. This plan did not change product behaviour.
- **Commit:** `e7c757dd`.

**5. Register entry for ubi9/ubi-minimal already existed**
- Phase 47 (#172) had already registered `image:registry.access.redhat.com/ubi9/ubi-minimal`, so the plan's "add" became an update: `workbench/Dockerfile` was added to `where`, the purpose was extended, and a workbench condition was added (mirror the digest, FIPS mode is a host property, swap to Red Hat's Node 26 minimal image when it is published). The acceptance grep still counts 1.

Other small choices:
- The root `package.json` of `workbench/` has no `"type"`, because Theia's generated build files are its own. `scripts/build.mjs` writes `dist/package.json` with `"type": "module"` for the bundled tests.
- The spike's `extension/test/sterling-evidence.test.ts` moved to `workbench/test/`.

## Known Stubs

None. The register's node-image condition "Pending 46-06: the workbench image is not yet signed or scanned in CI" is a tracked condition, not a stub.

## Threat Flags

None beyond the plan's threat model. `/healthz` is the only new HTTP route: it is unauthenticated, returns the fixed body `ok` and says nothing about the session (T-46-01's guard is unchanged).

## Next Phase Readiness

Wave 2 (46-02 to 46-06) can build on `workbench/`, the helper pair, `test/helpers/docker.ts`, and the `openbao-test` FROM line. 46-06 extends the `workbench` CI job that is already there.

## Self-Check: PASSED

All 17 created files listed under key-files exist; the five commits be904176, 54b2118a, 4144f4db, 4365138a and e7c757dd are on feat/phase-46-wave-1 and pushed.
