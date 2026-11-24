---
phase: 46-native-theia-foundation
plan: 04
subsystem: compliance
tags: [compliance, resource-check, register, licences, vsix-boundary, d-07, d-32, d-39]
status: complete

requires:
  - phase: 46-01
    provides: "workbench/package.json, workbench/Dockerfile in IMAGE_FILES, the image register entries"
provides:
  - "PACKAGE_FILES includes workbench/package.json"
  - "register entries for the nine runtime @theia/* 1.77.0 packages, @theia/cli, @near-ai/sterling-workbench-extension and @playwright/test"
  - "a test that no Dockerfile in IMAGE_FILES has a FROM ${...} line"
  - "verify-release-content refuses extension/workbench"
affects: [46-06, 47, 48]

actuals:
  tokens: 9500        # chars/4 over the added lines of the three code commits
  tasks: 3
  commits: 3          # measured: git rev-list --count ae6f3c45..d2f4a668
plan_head_before: ae6f3c45ea9895c46474a74a4b733e7d61f14be0
plan_head_after: d2f4a668

tech-stack:
  added: []
  patterns:
    - "Licence conditions sit on the register entry whose tree brings the package in directly (found with npm ls --package-lock-only)"

key-files:
  created: []
  modified:
    - scripts/resource-check.mjs
    - scripts/test/resource-check.test.mjs
    - compliance/resources.json
    - scripts/verify-release-content.mjs

key-decisions:
  - "Licence notes go on the @theia entry whose own dependencies hold the package: @theia/core (jschardet, @vscode/codicons, fuzzy, xmlhttprequest-ssl), @theia/filesystem (busboy, streamsearch), @theia/cli (buffers, union; build only)"
  - "The node image's 'Pending 46-06' condition is dropped by 46-06 when the scan and signature land, on the same branch"

requirements-completed: [FND-T-10]

duration: about 40 min
completed: 2026-11-24
---

# Phase 46 Plan 04: Compliance fit and the VSIX boundary Summary

**The fit check now reads `workbench/package.json` beside `workbench/Dockerfile` and passes with 136 resources. Every package the workbench adds has a reviewed entry, and the #162 licence notes are written as conditions on the entries that bring each package in. A test stops any listed Dockerfile from hiding a base image behind `FROM ${...}`. The VSIX check refuses anything under `extension/workbench`.**

## Owner approval needed in the PR

These are gate files:
- `scripts/resource-check.mjs`: one change. `PACKAGE_FILES` gains `'workbench/package.json'`.
- `scripts/test/resource-check.test.mjs`: two new tests, both named `workbench: ...`.
- `compliance/resources.json`: 12 new entries, and the `where`, `purpose` and evidence of `npm:esbuild`, `npm:typescript` and `npm:@types/node` are updated.
- `scripts/verify-release-content.mjs`: one new `forbiddenPatterns` entry, `/^extension\/workbench(?:\/|$)/`.

## Licence conditions and the `npm ls` evidence

Source: `npm ls <name> --all --package-lock-only`, run in `workbench/` on Node 26.13.1. The lockfile licence comes from `package-lock.json` `packages[...].license`.

| Package | Licence in the lockfile | Brought in by | Register entry carrying the condition |
|---------|-------------------------|---------------|----------------------------------------|
| jschardet 2.3.0 | LGPL-2.1+ | `@theia/core` (direct) | `npm:@theia/core` |
| @vscode/codicons 0.0.45 | CC-BY-4.0 | `@theia/core` (direct) | `npm:@theia/core` |
| fuzzy 0.1.3 | none | `@theia/core` (direct) | `npm:@theia/core` |
| xmlhttprequest-ssl 2.1.2 | none | `@theia/core` > socket.io-client > engine.io-client | `npm:@theia/core` |
| busboy 1.6.0 | none | `@theia/filesystem` > multer | `npm:@theia/filesystem` |
| streamsearch 1.1.0 | none | `@theia/filesystem` > multer > busboy | `npm:@theia/filesystem` |
| buffers 0.1.1 | none (dev) | `@theia/cli` > @theia/ffmpeg > unzipper > binary | `npm:@theia/cli` (build only) |
| union 0.5.0 | none (dev) | `@theia/cli` > http-server | `npm:@theia/cli` (build only) |

The other @theia packages also reach these through their own dependency on `@theia/core`. The note sits on the entry that brings each package in directly.

### Fit

- **pass-with-conditions:**
  - `@theia/core`: the four licence notes above, plus the upstream Node OpenSSL (gap X8). Its crypto is `uses-platform`.
  - `@theia/filesystem`: busboy and streamsearch.
  - `@theia/terminal`: it gives a shell to whoever reaches the workbench. Hosted sites put it behind sign-in (Phase 47), and the image binds 127.0.0.1 by default.
  - `@theia/plugin-ext-vscode`: it runs VS Code extensions and pulls in `@theia/ai-core` and `@theia/ai-mcp` (confirmed in the lockfile through `@theia/plugin-ext`). Outbound requests go only to addresses your organization configures, and MCP servers run only when a person adds one.
  - `@theia/cli`: build only. It brings in buffers and union, and installs with `--ignore-scripts`.
  - `@playwright/test`: test only. Its airGap value is `needs-mirror` for the Playwright browser builds; offline runs use `PLAYWRIGHT_BROWSERS_PATH`.
- **pass:** `@theia/editor`, `monaco`, `navigator`, `preferences` and `workspace`. These are runtime, `airGap: ok` and `crypto: none`. `@near-ai/sterling-workbench-extension` is also pass: MIT (this repository), `uses-platform`.

The image entries are 46-01's and still pass. That includes the node image's condition "Pending 46-06: ... not yet signed or scanned". 46-06 drops that condition on this branch when the SBOM, scan and signature land.

## Planning choices (as reported)

1. Licence conditions go only on the specific `@theia/*` entries whose tree holds each package, not on all nine (table above). Reversible.
2. The image entries stay as 46-01 wrote them. This plan only checked that they still pass. 46-06 drops the node image's pending condition. Reversible.
3. I added no new isolation test. The `forbiddenPatterns` entry is proved by one `verify:release` run. Reversible.

## Verification (tests run, separate from tests added)

Tests added: 2, both in `scripts/test/resource-check.test.mjs`.

**RED on the base:**
- `workbench: the package manifest and the Dockerfile beside it are both read` failed: `resources.get('npm:@theia/core')` was `undefined`.
- `workbench: no Dockerfile the fit check reads names its base image through a build argument` passed on the base. It is a guard on a property that already held, because 46-01 uses only literal digest-pinned `FROM` lines. Its fixture half (a `FROM --platform=... ${BASE}` Dockerfile) shows that the helper reports the file.

**Runs:**
- `node scripts/resource-check.mjs`: "Compliance fit check passed: 136 resources".
- `node scripts/run-tests.mjs scripts/test/resource-check.test.mjs`: 14 run, 14 passed.
- `node scripts/run-tests.mjs compliance/test/levels.test.ts` (after `npm --prefix compliance ci --ignore-scripts`): 11 run, 11 passed.
- `npm run compile`, then `node scripts/run-tests.mjs dist/test/hubIsolation.test.js` (9 run, 9 passed), then `npm run verify:release`. Result: "Release content verified: 3104 entries". `workbench/` and `workbench/node_modules` were present during the run, and `unzip -l` finds 0 entries under `extension/workbench`.

Acceptance greps:
- `'workbench/package.json'` in the script: 1.
- `workbench` in the test: 6 or more.
- `"id": "npm:@theia/`: 10.
- `"id": "npm:@playwright/test"`: 1.
- `workbench/package.json` in the register: 15.
- `jschardet`: 1.
- `extension\/workbench`: 1.

## Deviations from Plan

None. The plan was executed as written.

## Known Stubs

None.

## Threat Flags

None. The plan adds no new endpoints or trust boundaries.

## Self-Check: PASSED

The commits 22d7c085, 4af0225f and d2f4a668 are on `feat/phase-46-04-06`, and all four modified files exist.
