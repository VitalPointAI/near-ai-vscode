---
phase: 48-load-and-accreditation-verification
plan: 04
subsystem: loadtest
tags: [hub, loopback, run-file, teardown]
requirements: [VER-01, VER-02]
status: task-1-verified-task-2-approved
duration: 5min
completed: 2026-11-26
plan_head_before: b6685b81caf0a7db03339fe9f7747984a5925ae7
plan_head_after: 3bd12637ec0c69264bc4a1e0b95e9864cbd30f0d
commits: 2
actuals:
  tokens: 7287
  tasks: 1
  commits: 2
---

# 48-04 Loopback hub experiment and browser approval

Task 1 observed five concurrent event streams and accepted appends during a
five-second smoke window against the repository's hub composition. The fixture
uses a test-owned certificate and synthetic identities in a private loopback
namespace. A different target is refused before dial and a wrong pin results
in zero HTTP requests. [Fixture integration](../../../loadtest/hub-driver/hub.integration.ts)

The fixture wrote a verified scratch schema 2 experiment with one sanitized
hub observation. CPU and memory remained unmeasured. Existing schema 1 runs
continued to verify and the capacity output stayed unchanged. The ordinary
CLI has no new command or endpoint option. [Run-file reader](../../../loadtest/src/runfile.ts)

## Verification

- The approved host preflight found only `lo`, with no default IPv4 or IPv6
  routes. It used Node 26.13.1, esbuild 0.28.2 and OpenSSL 3.5.5. The copied
  tooling lived in the isolated worktree, with installed metadata matching
  its hub and compliance lockfiles. No dependency install or download ran.
- RED commit `615fb8997f4e3329169a9e2338435b59c214f9fe` followed a capped
  test that verified schema 1 and then failed on the unrecognized schema 2
  hub field. GSD returned `RED_EVIDENCE_OK`.
- GREEN commit `3bd12637ec0c69264bc4a1e0b95e9864cbd30f0d` passed both type
  checks, all 40 focused tests and four private-loopback integration tests
  under the shared lock and 4 GiB cap. None were skipped. A stalled handshake
  released the worker and closed the peer socket on both the TERM-to-SIGKILL
  path and direct IPC disconnect. Both negatives produced no success result.
- The isolated compiler config needed the existing hub SQLite declaration
  and JavaScript module resolution. The test supervisor observes process
  exit and closed IPC separately because explicit IPC disconnect did not
  emit the combined child close event in the initial run. The peer socket's
  close was observed independently by the parent fixture.

## Task 2 owner decision

The owner approved `@playwright/test`, `playwright` and `playwright-core`
at exactly 1.65.0 and Linux x64 Chromium 158.0.8127.18, Playwright revision
1254, from `cdn.playwright.dev` via the recorded redirect to
`storage.googleapis.com/chrome-for-testing-public/158.0.8127.18/linux64/`.
The coordinator relayed this approval on 2026-11-26 for the isolated hub
performance fixture only. This plan staged no browser package or binary
before that approval.

The workbench tree matches main `99373e04`. All three registry tarballs
were published on 2026-11-05. The three locally cached archives matched
the lockfile SHA-512 values before extraction into this worktree's
ignored tool directory. No package lifecycle script, full workbench
install or new browser download ran for this checkpoint. The browser
preflight used the cached Phase 46 copies.
[Workbench lockfile](../../../workbench/package-lock.json) ·
[Phase 46 package and browser evidence](../46-native-theia-foundation/46-01-SUMMARY.md) ·
[Test-only component record](../../../compliance/resources.json)

Playwright loaded from the isolated worktree and its browser manifest
matched revision 1254. Both cached executables reported 158.0.8127.18.
The SHA-256 of Chromium was
`76bcde21a2f8c9d4fbbf42afbeab011817d000552d093e5f5e89c9b8808f4231`.
The SHA-256 of Chrome Headless Shell was
`41ff61e6e65b8d16b40631f4f094b46ec02f1a0f5375ae477c1d478f1fc2d89d`.

The offline replay ran under the shared lock with 4 GiB and no swap.
It confirmed a separate network namespace with only `lo` and no
default routes, passed both type checks, and passed 40 focused tests
and four synthetic loopback hub tests with no skips. The browser
executables were invoked only to read their version.

## Task 3A local activity profile

Tests-first `996bce85` reproduced four missing-loader failures after the
type check passed. Implementation `12f26985` passed the type check and all
51 local load-test unit cases with zero skips under the shared cap. The
v1 profile loads three synthetic files, edits one, names one fixed fixture
terminal action and includes an idle step. Its 20 percent idle share and
one-second wait are fixture inputs. The canonical profile identity is
`sha256:345ea21f7d79350b414e09b4c797e0827dd3e6a022b01f0e72e940d1d69aee57`.
The existing run CLI's raw-byte profile hash and all stage accounting stay
outside this checkpoint. [Activity profile](../../../loadtest/profiles/activity-v1.json)

The complete Workbench lockfile also installed from the existing read-only
package cache with lifecycle scripts disabled. The run installed 885 packages
on Node 26.13.1 in a process namespace containing only loopback. The lockfile
SHA-256 was `aa97b95f83b72c140e5a373ac4a7d3e6800ed7a38a271985f08bf25ed0e65044`.
This verifies the locked dependencies. Task 3B still needs a digest-identified
image built from the exact Workbench context and proof that the service and
browser share an isolated loopback namespace.

## Self-Check: PASSED

The two measured Task 1 commits and their files are present on the
execution branch. The measured execution metadata above records Task 1.
The Task 2 checkpoint changes only this record. Independent source and
evidence review passed Task 3A at `12f26985` and `edb0a5d2`. The namespace
blocked an npm update metadata check. Package installation used the local
cache, with no browser or stage execution.

## Open conditions

- **G322.** Hosted target-scale and active-browser measurements still need
  authorized site work. Task 3B requires a verified local image built from
  `workbench/Dockerfile` and the shared private loopback fixture. No browser
  session or rig activity ran.
- **G323.** Representative hub load and resource measurements on the rig
  remain pending. The local experiment supplies no capacity figure.
