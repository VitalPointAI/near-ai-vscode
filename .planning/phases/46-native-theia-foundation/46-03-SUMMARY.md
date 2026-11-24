---
phase: 46-native-theia-foundation
plan: 03
subsystem: infra
tags: [theia, egress, air-gap, allow-list, docker, ubi9, node26, hardening, playwright]
status: complete

requires:
  - phase: 46-01
    provides: "workbench/ package and image, test/helpers/docker.ts, smoke spec, /healthz"
  - phase: 46-02
    provides: "parseServiceAddress (the shared address rule)"
provides:
  - "readOutboundSettings(env) and allowedUrlPatterns(settings) (egress.ts)"
  - "SterlingRequestAllowList bound to BackendRequestAllowedContribution; a bad address setting exits 1 at start"
  - "test/helpers/outbound-hook.mjs (NEAR_AI_TEST_OUTBOUND_LOG, NEAR_AI_TEST_OUTBOUND_ALLOW; allowed/refused lines) for 46-08"
  - "container suites image.test.ts (hardening) and egress.test.ts (no egress), Playwright egress.spec.ts"
affects: [46-06, 46-08, 47]

actuals:
  tokens: 9200        # chars/4 over the added lines of the plan's diff (36,725 chars), SUMMARY excluded
  tasks: 3
  commits: 3          # measured: git rev-list --count plan_head_before..HEAD at SUMMARY time; the SUMMARY commit follows
plan_head_before: 19025aed45e1eb9dd6b88d94a1efbd28cfc57fbb
plan_head_after: cbaefbabb61f2aea8ae0fd3f45277c9d7bfc1d5b

tech-stack:
  added: []
  patterns:
    - "One address rule for every STERLING_* address (hosting-config parseServiceAddress), plus no wildcard host for the allow list"
    - "Allow-list-aware outbound recording hook mounted read-only, loaded with NODE_OPTIONS=--import, log copied out with docker cp"

key-files:
  created:
    - workbench/extension/src/node/egress.ts
    - workbench/extension/src/node/egress-contribution.ts
    - workbench/test/egress.test.ts
    - workbench/test/helpers/outbound-hook.mjs
    - workbench/test/container/image.test.ts
    - workbench/test/container/egress.test.ts
    - workbench/test/e2e/egress.spec.ts
  modified:
    - workbench/extension/src/node/sterling-backend-module.ts
    - workbench/Dockerfile

key-decisions:
  - "STERLING_MODEL_SERVERS: comma list of at most 32 absolute URLs on the shared rule (https, or http to a loopback address; no credentials, query, fragment or wildcard host); empty items are ignored; STERLING_OPEN_VSX_URL is one such URL or empty"
  - "The allow list is each address's exact origin, deduplicated, Open VSX first; never a pattern"
  - "The internal network covers start and restart; the browser smoke runs on a bridge network with the hook recording"
  - "The UBI minimal FROM lines name the tag 9.9-1795198179, which resolves to the same index digest"
  - "The runtime tree drops node_modules/@types: @theia/core lists @types/* as dependencies, so prune kept @types/node"

requirements-completed: [FND-T-01, FND-T-06, FND-T-08]

duration: about 25 min (including waits on the shared heavy lock)
completed: 2026-11-24
---

# Phase 46 Plan 03: Air gap and image hardening Summary

**A frontend-originated backend request can now reach only the addresses your organization configured, and by default it can reach none. A malformed address stops the workbench at start. Two new container suites show that the running image is hardened (non-root, minimal, loopback by default, healthy, Node 26 like the hub, every base pinned) and makes no outbound connection outside its allow list, at start, at restart and in the browser.**

## Owner approval needed in the PR

None. No gate file changed. `workbench/Dockerfile` is not a gate file. The fit check still passes with 124 resources. No package, image or tool was added.

## Dockerfile fixes the suite forced

1. **The UBI minimal FROM lines had no tag.** The plan's check is `name:tag@sha256:<64 hex>`. Both lines are now `registry.access.redhat.com/ubi9/ubi-minimal:9.9-1795198179@sha256:08d4c70f...`. `docker buildx imagetools inspect` confirmed that this tag resolves to the same index digest, so the bytes are unchanged. (Phase 47's Containerfiles use `:9.9@sha256:2cb89fea...`, the amd64 manifest of the same release.) Note for the verifier: 46-01-PLAN's artifact string `ubi9/ubi-minimal@sha256:08d4c70f...` no longer appears literally, because the tag now sits between the name and the digest.
2. **`@types/node` was in the runtime tree.** `@theia/core` lists `@types/body-parser`, `@types/express`, `@types/ws` and others as production dependencies, and they depend on `@types/node`, so `npm prune --omit=dev` keeps them. The build now removes `node_modules/@types` after the prune. Those packages hold only type declarations that nothing loads at run time.

## typescript in the runtime tree

**Present, as a peer of `opfs-worker`.** The suite reads `opfs-worker/package.json` inside the image and finds `typescript` in its `peerDependencies`. `@theia/filesystem` needs `opfs-worker` at run time, so `typescript` stays, as 46-01 recorded.

## @theia/ai-* folders in the runtime tree

`@theia/ai-core`, `@theia/ai-core-ui` and `@theia/ai-mcp`. All three come in through `@theia/plugin-ext`, and none of them is a model provider. None of `ai-openai`, `ai-anthropic`, `ai-ollama`, `ai-google`, `ai-hugging-face`, `ai-llamafile`, `ai-vercel-ai` or `ai-copilot` is present, and neither is `@theia/vsx-registry`.

## Planning choices (as reported)

1. **`STERLING_MODEL_SERVERS` format:** a comma-separated list of at most 32 absolute URLs. Each one is `https:`, or `http:` to `127.0.0.1`, `::1` or `localhost`. None may carry a user name, password, query, fragment or wildcard host. Empty or unset means none, and empty items are ignored. `STERLING_OPEN_VSX_URL` is one such URL or empty. A comma in it is refused. Both feed only the allow list in this phase. Costly (Phase 47 contract).
2. **The hook follows `hub/test/noOutbound.test.ts`,** but it lets allow-listed hosts (and `host:port` entries) and IPC paths through. Every attempt is logged as `allowed <kind> <target>` or `refused <kind> <target>`. A refused call throws with code `NEAR_AI_TEST_OUTBOUND`. Reversible.
3. **Start and restart run on an `--internal` network,** checked with `docker exec`. The browser smoke runs on a bridge network with the hook recording. Reversible.

## Tasks

| Task | Commit | Content |
|------|--------|---------|
| 1 | `6a057ac9` | egress.ts, egress-contribution.ts, the binding and start check in sterling-backend-module.ts; 8 unit tests |
| 2 | `7a80e0cd` | image.test.ts (9 tests); the two Dockerfile fixes above |
| 3 | `cbaefbab` | outbound-hook.mjs, egress.test.ts (4 tests), egress.spec.ts (1 Playwright test) |

## Verification (tests run, separate from tests added)

- Added: 21 tests. That is 8 unit tests in `egress.test.ts`, 9 in `container/image.test.ts`, 4 in `container/egress.test.ts`, and 1 Playwright spec that `egress.test.ts` runs.
- `npm --prefix workbench run lint`: clean.
- `npm --prefix workbench test`: 52 run, 52 passed.
- `npm --prefix workbench run test:container`, on a fresh build after the fixes: 22 run, 22 passed. That is `egress` 4, `image` 9, `openbao-identity` 5 (46-02) and `smoke` 4 (46-01, with its 2 Playwright tests).
- `node scripts/resource-check.mjs`: passed, 124 resources.
- Acceptance greps: `BackendRequestAllowedContribution` in sterling-backend-module.ts 2. `STERLING_MODEL_SERVERS` in egress.ts 4. No `@theia/` import in egress.ts. `10001` in image.test.ts 5. `STERLING_PREVIEW_NO_SIGN_IN` in image.test.ts 2. `^USER 10001:0$` in the Dockerfile 1. `NEAR_AI_TEST_OUTBOUND_ALLOW` in the hook 2. `--internal` 1. `page.on('request'` 1.
- No container, network or image was left behind. `docker ps -a`, `docker network ls` and `docker images` show no `sterling-workbench-test-*` or `sterling-egress-*` objects.

TDD RED:
- Task 1: the run with `egress.ts` and `egress-contribution.ts` set aside failed at the test build with `Could not resolve "../extension/src/node/egress.ts"` and `"../extension/src/node/egress-contribution.ts"`.
- Task 2: the first container run failed 2 of the 9 image tests on the 46-01 image, `present:@types/node` and the untagged UBI FROM lines. Those failures are the two fixes above. The other 7 image checks describe hardening 46-01 already built, so they passed on the base. `STERLING_MODEL_SERVERS` exiting 1 is new behaviour from Task 1.
- Task 3: the hook and suite are new. The planted-call test is the negative check: with a start-up `fetch('https://example.invalid/')` added through `NODE_OPTIONS`, the hook logs `refused fetch https://example.invalid/` and the suite's check fails with that target named.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 1 - Bug] Untagged UBI pins and `@types/node` in the runtime.** See "Dockerfile fixes the suite forced". Commit `7a80e0cd`.

**2. [Rule 2 - Correctness] Wildcard hosts are refused.** The WHATWG URL parser accepts `https://*.example.test`, and Theia's matcher would read it as a subdomain wildcard. Both address settings now refuse a host containing `*`. Commit `6a057ac9`.

**3. Overlap with 46-01's smoke test kept small.** Smoke already checks that the local bind guard refuses `0.0.0.0` without `accept`, so image.test.ts checks only the other side: with `accept`, the workbench serves on the published port.

Other small choices:
- `SterlingRequestAllowList` takes its settings in the constructor and is bound with `toDynamicValue`, so the unit test checks the exact patterns and Theia's own `isUrlAllowed` without a container. A small `OutboundSettingsContribution` resolves it during backend initialization, so a bad setting stops start instead of a later request.
- The default bind check gives `docker run` `--health-interval=2s`, so Docker reports `healthy` within seconds. The image's own `HEALTHCHECK` is unchanged.

## Backstop (not proven here)

The **release** target, with the bundled VSIX, is not built by these suites, which run the development target. That its start and first page load make no outbound call is to be confirmed on the first release image, as the plan's backstop truth says. The Dockerfile check confirms that the release stage sets only `THEIA_DEFAULT_PLUGINS=local-dir:///plugins`.

## Known Stubs

None.

## Threat Flags

None. The plan adds no endpoint. The hook is test tooling that is mounted at run time and never copied into the image.

## Self-Check: PASSED

All 7 created and 2 modified files exist. The commits `6a057ac9`, `7a80e0cd` and `cbaefbab` are on `feat/phase-46-02-03`.
