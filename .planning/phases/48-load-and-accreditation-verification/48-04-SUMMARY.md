---
phase: 48-load-and-accreditation-verification
plan: 04
subsystem: loadtest
tags: [hub, loopback, run-file, teardown]
requirements: [VER-01, VER-02]
status: task-1-local-experiment-verified
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

# 48-04 Loopback hub experiment

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

## Self-Check: PASSED

The two measured commits and their files are present on the execution branch.
The diff leaves the hub, workbench, extension, deployment, load CLI and
committed run directories untouched. This summary covers Task 1 only.

## Open conditions

- **G322.** Hosted target-scale and active-browser measurements still need
  authorized site work. Task 2's owner approval for Playwright and the
  Chromium source remains pending. No browser or rig ran.
- **G323.** Representative hub load and resource measurements on the rig
  remain pending. The local experiment supplies no capacity figure.
