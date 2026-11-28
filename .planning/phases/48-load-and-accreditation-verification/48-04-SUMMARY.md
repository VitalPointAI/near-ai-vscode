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
This verifies the locked dependencies used for the Task 3B preflight below.

## Task 3B local fixture readiness

The revised plan at `2503f3faf` pins the signed bundled v0.4.41
linux/amd64 release. The exact published image was already in the local
Docker store. The isolated archive at
`.claude/worktrees/codex-phase4804-image-evidence.r5QrF7/workbench.tar`
has SHA-256 `f662a1c7e8e11dbf653eaaeaf0b9c5867954db5d085dcb755a74f537ab96a599`.
Its OCI manifest, config and all six layer digests checked. The config
records source `f755813f7cf1d3f62908a165715e65d304fb16fb`, UID `10001:0`
and the original Workbench entrypoint. The protected release workflow
verified the signature and SBOM before publication.
[Protected build and release](https://github.com/VitalPointAI/near-ai-vscode/actions/runs/45935191405)

The owner approved one disposable local fixture and cleanup of its
test-created container and workspace. The exact rootless import retained
manifest `sha256:b36a590c61bd979e6aaa1ce16d6ce34adc2f862a1444d1af9fd8e9cf211a6bb9`
and config `sha256:d40f068134d3d2047977a5fdc7f864cbbac79151b8d6886a913625b953a19867`.
Podman reported network mode `none` and an empty published-port list.
The preflight checked a 2 GiB service limit and a 4 GiB runner limit
with zero swap. Before navigation, the live listener and exact
Chromium 1254 process shared `net:[4026533678]`, distinct from the host
namespace. The namespace contained only loopback, and Workbench
listened on literal `127.0.0.1:3000`. The import, preflight and final
sample logs are under `.claude/worktrees/codex-phase4804-local-trial.bJCVcv`.

## Task 3B local trial

The bounded run reached Get Started, opened all three synthetic
documents, verified the exact Notes edit on disk, ran the fixed
terminal echo with a fresh marker, and completed the idle step.
The standalone WebAuthn fixture registered a virtual passkey and used
it for an assertion. The standalone server still bound literal
loopback. Chromium used the separate `localhost` origin mapped
explicitly to `127.0.0.1` to satisfy the WebAuthn effective-domain
requirement. Workbench used its literal loopback origin. The browser
refused a separate Workbench webview origin outside the fixture route list.
[WebAuthn effective-domain check](https://www.w3.org/TR/webauthn-3/#sctn-createCredential)

| Local fixture step | Elapsed ms |
|---|---:|
| Get Started | 6,232 |
| Open three documents | 614 |
| Edit and save | 324 |
| Fixed terminal echo | 735 |
| Idle | 1,001 |
| Standalone synthetic sign-in | 10 |

These are elapsed times from one local fixture run. The existing
measure and capacity suites passed all 12 tests with zero skips,
including separate active and idle inputs. The named scratch harness,
final timings and checksums are retained in the same evidence
directory. The exact test-created container and its private workspace
were removed after the run. The archive, imported image and logs
were retained.

## Task 3B command and stage accounting

The separate `sample --no-auth --once` command checks the private
fixture descriptor, live rootless image and listener, the runner and
Chromium namespaces, the workspace and the resource caps. It permits
only fixed fixture origins, refuses redirects before Chromium follows
them and claims the fixture once before browser launch. It returns
local timings and the canonical profile identity with a configured
sample count and stage total of one. Get Started timing ends when the
welcome view appears, before any workspace trust interaction. At the
75-second journey deadline, the sample fails and starts bounded
Chromium shutdown. A stalled graceful close triggers forced process
group shutdown, and the command waits for the process exit.

The controller gives the existing per-person accounting only distinct
completed stage sessions that fall inside each hold window. The ordinary
rig command supplies no local sample data. Type checking and all 59
load-test cases passed, with zero skips. The command, isolation checks,
redirect refusal, welcome timing, and stage accounting used local
fakes. A disposable Node process verified forced shutdown and reaping
after the fake browser connection and graceful close both stalled. The approved
fixture evidence above came from the scratch harness before the command
was registered. The registered command still needs an authorized
end-to-end run on a fresh exact fixture.

## Registered sample and save check

The owner-approved one-shot run on November 28 used exact source `0a07a74e4`, the released v0.4.41 image and Chromium 1254. The CLI verified isolation before navigation. It opened the fictional workspace, saved `notes.md`, then failed the save check with exit 1. It emitted no complete timings or rig evidence. The registered log SHA-256 is `d2cbb91a46829f0576a1a9fdf562a9a3ceadc64f03d806d7134d48e2dad89a92`. The original contents of the other two files matched, and the saved `notes.md` SHA-256 `b5e8ab83ff08ced309056cfab0664068d89676d2771b21ca7313c8dac1acb7d3` exactly matches the original bytes plus the typed suffix. The assertion had stripped the original trailing newline before making its comparison. Scoped cleanup removed the test-created container and workspace. The cleanup log SHA-256 is `d3dc4f33eab97ec2cd50017541078acb1e6f18efee7eb020202c3eef9d6812ce`.

The corrected check compares the exact original bytes plus the suffix it types. The new focused regression reproduced the same failure before the fix. Afterward all 60 offline load-test checks and the pinned TypeScript check passed. Independent source review passed.

## Corrected registered retry

The owner approved one retry using exact source `dc0bf380c0ee0615fc50f043b9981488b370240e`, the same published v0.4.41 archive and pinned Chromium 1254. The registered command passed isolation and the corrected save assertion. The saved `notes.md` again matched SHA-256 `b5e8ab83ff08ced309056cfab0664068d89676d2771b21ca7313c8dac1acb7d3`. The other two fictional files were unchanged.

The command stopped with exit 1 when the synthetic terminal action did not write its marker. The backend log records two terminal channels. The browser code selects the first visible terminal without binding it to the newly opened terminal, but the logs do not identify which terminal received the input. No complete timing sample, passkey result or representative rig evidence was produced.

Scoped cleanup removed the disposable container and fictional workspace. The image archive, dedicated image store, logs and one-use claim remain in `.claude/worktrees/codex-phase4804-local-trial.5kTGxJ`. The registered retry log SHA-256 is `4dfd221e268677216f4b968c52528348ecab3fdb568225322637b117cd74021a`. The backend log SHA-256 is `def9e65db706e1d48f2dcf18c629dce14cb471b15fae5583140d2da60658ade8`; cleanup log SHA-256 is `a0f8cf876c40df5cdc306485ddefaac21bdbffb119b3a2130e6aa5207f962b1f`. This completed the one approved retry.

## Self-Check: PASSED

The two measured Task 1 commits and their files are present on the
execution branch. The measured execution metadata above records Task 1.
The Task 2 checkpoint changes only this record. Independent source and
evidence review passed Task 3A at `12f26985` and `edb0a5d2`. The namespace
blocked an npm update metadata check. Package installation used the local
cache. The subsequent exact fixture trial recorded live browser process
identity and the completed browser activity above.

## Open conditions

- **G322.** An authorized end-to-end run of the registered command on a fresh exact test fixture and authorized hosted target-scale and active-browser measurements remain open.
- **G323.** Representative hub load and resource measurements on the rig remain pending. The measured times above apply to one local fixture.
