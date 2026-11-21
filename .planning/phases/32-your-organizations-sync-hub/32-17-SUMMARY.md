---
phase: 32-your-organizations-sync-hub
plan: 17
subsystem: hub
status: complete
tags: [hub, docker, compose, ci, release, vsix]
requires: [32-14, 32-15]
provides:
  - hub/Dockerfile (two digest-pinned stages, the relay's images; final image holds /app/bin.mjs and /app/app.mjs, uid 65532, no shell)
  - .dockerignore allow-list for both images (relay lines, hub lines, 41 hub-side closure files under src/)
  - hub service in relay/compose.yaml, profile hub, volume hub-state, four file secrets, publish address and port settings
  - CI job hub (eighth job) and CI_CHECKS entry 'hub'
  - .vscodeignore hub/** and the verify:release pattern /^extension\/hub(?:\/|$)/
affects: [32-20, 32-27, 32-28, integration PR (gate paths), owner branch protection]
tech-stack:
  added: []
  patterns: [build context allow-list generated from the hub-side closure and pinned by a test, Compose profile per optional service with its own secrets and volume]
key-files:
  created:
    - hub/Dockerfile
    - hub/test/dockerContext.test.ts
    - hub/test/container/container.test.ts
    - src/test/hubIsolation.test.ts
  modified:
    - .dockerignore
    - relay/compose.yaml
    - relay/test/container/container.test.ts
    - .github/workflows/ci.yml
    - scripts/lib/workflow.mjs
    - docs/development-workflow.md
    - .vscodeignore
    - scripts/verify-release-content.mjs
decisions:
  - "The hub Dockerfile uses exactly the relay's two FROM lines; the container suite compares them, so one re-pin (relay first, then copy) covers both images."
  - "The hub's .dockerignore src lines are the whole hub-side closure (41 files, value and type-only imports), not only the bundle's metafile inputs (19), because tsc in the build stage type-checks the full closure. The test checks both: the list equals the closure, and every metafile input is in it."
  - "Compose needed no special secret declaration: a service's missing file secrets do not stop another service. The hub starts with an empty relay secrets folder, and the relay suite now runs with NEAR_AI_HUB_SECRETS_DIR pointing at a folder that does not exist."
  - "Both container suites drop the operator's NEAR_AI_HUB_, HUB_, NEAR_AI_RELAY_, RELAY_ and COMPOSE_ settings before calling Compose."
  - "The planted secret is a fresh hub signing key line at relay/secrets/hub/hub_signing_key (the default NEAR_AI_HUB_SECRETS_DIR); the export scan looks for its seed."
  - "docs/development-workflow.md: the branch-protection command in section 8 now includes hub, with a note that the owner adds it after Phase 32 merges; the scripts already wait for it through CI_CHECKS."
metrics:
  duration: "about 55 min"
  completed: 2026-11-20
estimate:
  tokens: 75039
  tasks: 3
actuals:
  tokens: 21150
  tasks: 3
  commits: 3
plan_head_before: 31cfffc8d7b921fd480d282eb69de42d5143c0fc
plan_head_after: d558a1b5ab90abc720d37dbebecccbc2d09a2b4e
---

# Phase 32 Plan 17: Hub image, Compose service, CI job and release exclusions Summary

The hub now ships like the relay: a distroless image built from an exact allow-list (hub sources plus the 41-file hub-side closure), a hardened Compose service under its own `hub` profile that starts without the relay, an eighth CI job `hub` that the merge gates wait for, and release checks that keep `hub/` out of the VSIX.

## What was built

- **Image (D-26):** `hub/Dockerfile` copies the relay's structure: `node:26.13.1-slim` build stage (`npm ci --ignore-scripts` from the hub lockfile, `tsc`, `build.mjs --app-only`) and the distroless `nodejs26-debian13:nonroot` final stage with root-owned read-only `/app/bin.mjs` and `/app/app.mjs`, a 0700 `/var/lib/near-ai-hub` owned by 65532, `HUB_STATE_DIR`, `HUB_HOST=0.0.0.0`, `HUB_PORT=8443`, `EXPOSE 8443`, `USER 65532:65532`.
- **Build context (D-33):** `.dockerignore` is `*`, the relay's six lines unchanged, the hub's six lines, then 41 `!src/...` lines generated with `hubSideClosure` on the merged tree (redaction, 21 replica files with hubFile, 10 kindSchemas, staff/doctrine, state/keys, 7 team files). Nothing from `src/domain/gate`, `src/staff`, `src/services` or `src/agent`.
- **Compose (D-25, D-31):** `hub` service after the Signal sidecar, profile `hub`, read-only root, `cap_drop: [ALL]`, no-new-privileges, uid 65532, `pids_limit: 128`, `mem_limit: 512m`, `/tmp` tmpfs, volume `hub-state`, secrets `hub_tls_cert`, `hub_tls_key`, `hub_signing_key`, `hub_encryption_key` from `NEAR_AI_HUB_SECRETS_DIR` (default `./secrets/hub`) with the four `_FILE` settings, port `${NEAR_AI_HUB_PUBLISH_ADDRESS:-127.0.0.1}:${NEAR_AI_HUB_PUBLISH_PORT:-8443}:8443`, `HUB_PUBLIC_ADDRESS` from `NEAR_AI_HUB_PUBLIC_ADDRESS` (empty means not set), the relay's healthcheck form. The comment block covers the start command, the variables, chown/chmod of the secret files, `--generate-key`, and TCP passthrough for a reverse proxy.
- **CI (D-32, D-71):** job `hub` after `relay`, built the same way: full-history checkout without credentials, `has_hub` detection keyed on `hub/package.json` (hotfix skip notice "hub checks were skipped", error "::error title=hub missing::"), Node 24 kept as `NEAR_AI_HUB_OLD_NODE` before Node 26.13.1, then `npm ci --ignore-scripts`, `npm audit --omit=dev --audit-level=high`, lint, `npm test`, and `npm run test:container`. Every step after the detection is guarded. The ci.yml header lists hub. `CI_CHECKS` is `[..., 'secret-scan', 'relay', 'hub']`.
- **Workflow page:** hub row in the gates table, nine check names, eight jobs in parallel, a hub bullet in section 3, eight CI jobs in the merge and tag text, hub beside relay in the hotfix section, and hub in the section 8 protection list and command (the owner adds it after Phase 32 merges).
- **Release (D-33):** `.vscodeignore` has `hub/**` with a comment; `verify-release-content.mjs` forbids `/^extension\/hub(?:\/|$)/` next to the relay pattern. `vsce ls --no-dependencies` now lists 0 `hub/` files (with the previous `.vscodeignore` it listed hub/tsconfig.json, hub/package.json, hub/package-lock.json, hub/Dockerfile, hub/.nvmrc and more).

## Tests

| Suite | Result |
| --- | --- |
| hub unit suite (`npm test`, with `NEAR_AI_HUB_OLD_NODE` set) | 115 tests, 115 pass, 0 skipped (110 from 32-14 + 5 dockerContext) |
| hub `npm run lint` | clean |
| hub container suite | 11 tests, 11 pass (6 image, 5 Compose) |
| relay container suite | 10 tests, 10 pass |
| hubIsolation + relayIsolation + scripts workflow, merge and workflow-files suites, then `npm run lint` | 93 tests, 93 pass; lint exit 0 |
| cyberFixtures + layoutProbePackaging (read .vscodeignore / vsce listing) | 8 tests, 8 pass |

`hubIsolation.test.js` has 9 tests; `grep -c '^!src/' .dockerignore` is 41 (the closure the test reports); `grep -c 'profiles: \["hub"\]' relay/compose.yaml` is 1; `grep -c '^  hub:$' .github/workflows/ci.yml` is 1. `npm run verify:release` was not run: the `vsce ls` listing above and the pattern test cover the exclusion, and the orchestrator runs the full release check.

### Failing-first evidence

- **Task 1:** the hub unit suite with the new dockerContext test on the unchanged tree: 115 tests, 113 pass, **2 fail** (the exact list, and "bundle input ../src/domain/team/canonical.ts is not let in by .dockerignore"). The hub container suite before the Dockerfile: 6 cancelled, `before` failed with "hub/Dockerfile is missing". After the Dockerfile and `.dockerignore`: 115 of 115 and 6 of 6.
- **Task 1 teeth (stated mutation, restored):** appending `!relay/secrets` to `.dockerignore` fails 2 dockerContext tests (exact list, and no line lets in state or secrets). The dockerContext teeth test also feeds a planted list (`!relay`, `!hub`, `!relay/secrets/hub`, `!hub/test/helpers`, `!src/**`, `!.planning`, `!hub/../relay/state`, `!.git/config`) and sees every line reported.
- **Task 2:** the hub container suite with the Compose tests on the Task 1 tree: 11 tests, 6 pass, **5 fail** (every Compose test: no hub service). After the Compose service: 11 of 11.
- **Task 3:** hubIsolation on the Task 2 tree: 9 tests, 3 pass, **6 fail** (.vscodeignore, CI job, detection matrix, Node order, CI_CHECKS and workflow page, release pattern). After the changes: 9 of 9.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Correctness] Relay suite proves the relay starts with no hub secret**
- **Found during:** Task 2
- **Issue:** the plan's truth "the relay starts with no hub secret present" was only implicit in the relay suite (the default hub secrets folder simply did not exist), and an operator's `NEAR_AI_HUB_SECRETS_DIR` in the shell would have leaked into it.
- **Fix:** the relay suite's Compose environment drops `NEAR_AI_HUB_` and `HUB_` settings, sets `NEAR_AI_HUB_SECRETS_DIR` to a folder that does not exist, and asserts that folder is absent after `up`.
- **Files modified:** relay/test/container/container.test.ts
- **Commit:** 85009103

**2. [Rule 2 - Correctness] Extra checks beyond the plan's list**
- dockerContext refuses any non-literal or wildcard allow-list line and requires the closure to stay under `src/domain` and out of gate, staff, services and agent.
- The hub container suite also checks the exported image has the empty state directory, `ExposedPorts` is only 8443/tcp, the root filesystem refuses writes outside `/tmp`, and the logs after the restart hold no key value.
- hubIsolation also checks the hub job uses nothing of `relay/`, follows the relay job, and the workflow page has the hub row.

No file outside the plan's `files_modified` list was changed.

## Decisions

The owner accepted the 32-CONTEXT defaults; no checkpoint came up. D-31 default kept: the hub port is published on 127.0.0.1 unless the operator sets `NEAR_AI_HUB_PUBLISH_ADDRESS`. Decisions made while building are in the frontmatter `decisions` list.

## Notes for later plans and the integration PR

- `.github/workflows/ci.yml`, `scripts/lib/workflow.mjs` and `scripts/verify-release-content.mjs` are gate paths: the integration PR needs the owner's gate approval (send the approval link at once).
- After the phase merges, the owner adds `hub` to main's branch protection (section 8 command now includes it).
- 32-18 adds `hub/src/store/`; it enters the image through `!hub/src` with no `.dockerignore` change. If 32-18 or 32-20 makes the hub bundle another extension file, the hub-side closure (HUB_SIDE) must already hold it, and dockerContext fails until `.dockerignore` gets the new `!src/` line.
- The hub container suite plants `relay/secrets/hub/hub_signing_key` during the build and refuses to run if that file already exists.

## Known Stubs

None.

## Threat Flags

None. The surfaces (build context, published port, CI gates, npm installs) are the plan's T-32-61 to T-32-64 and T-32-SC, each mitigated as planned.

## Self-Check: PASSED

- Created files present: hub/Dockerfile, hub/test/dockerContext.test.ts, hub/test/container/container.test.ts, src/test/hubIsolation.test.ts.
- Commits 05e97866, 85009103 and d558a1b5 are on feat/phase-32-17-hub-image-ci.
