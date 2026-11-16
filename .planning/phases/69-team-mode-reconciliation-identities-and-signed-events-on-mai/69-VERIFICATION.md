---
phase: 69-team-mode-reconciliation-identities-and-signed-events-on-mai
verified: 2026-11-16T03:00:00Z
status: human_needed
score: 5/5 must-haves verified
covered_files: [".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-01-PLAN.md",".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-01-SUMMARY.md",".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-02-PLAN.md",".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-02-SUMMARY.md",".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-03-PLAN.md",".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-03-SUMMARY.md",".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-04-PLAN.md",".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-04-SUMMARY.md",".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-05-PLAN.md",".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-05-SUMMARY.md",".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-06-PLAN.md",".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-06-SUMMARY.md",".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-07-PLAN.md",".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-07-SUMMARY.md",".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-08-PLAN.md",".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-08-SUMMARY.md",".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-09-PLAN.md",".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-09-SUMMARY.md",".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-10-PLAN.md",".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-10-SUMMARY.md",".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-11-PLAN.md",".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-11-SUMMARY.md",".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-12-PLAN.md",".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-12-SUMMARY.md",".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-13-PLAN.md",".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-13-SUMMARY.md",".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-14-PLAN.md",".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-14-SUMMARY.md",".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-15-PLAN.md",".planning/phases/69-team-mode-reconciliation-identities-and-signed-events-on-mai/69-15-SUMMARY.md","src/domain/team/keyRecords.ts","src/domain/team/keyStatus.ts","src/domain/team/materialize.ts","src/domain/team/permissions.ts","src/domain/team/signedPayload.ts","src/domain/team/validate.ts","src/services/team/teamCommands.ts","src/team/enable.ts","src/team/identity.ts","src/team/keyHistory.ts","src/team/teamFile.ts"]
covered_digest: "v4:sha256:405e209604f2d5dc028ed0dfba31cd61d7089c31c5a1fff490024eb61a1c329a"
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "The owner merges PR #61 (plans 69-09 to 69-15: device.rotated, payload signer, key status, solo key history, disposition record) into main"
    expected: "origin/main then holds src/domain/team/signedPayload.ts, keyStatus.ts, keyRecords.ts and src/team/keyHistory.ts. Today main holds only PR 1 (#59, 1cbcb9b), so TMR-05 and the disposition record (TMR-04, TMR-01 evidence) exist on the open PR branch only. PR #61 shows CLEAN with its checks green."
    why_human: "Merging is an owner decision gated by the agent review and the owner's approval (D-17, D-30); the phase goal says the core runs on main, and that is true for the identity and signed-event core but not yet for the TMR-05 signer."
  - test: "After the 0.4.x release that carries PR 1 and PR 2, turn on nearAi.team.preview, run NEAR AI: Enable Team Mode on a scratch repository with a remote, then NEAR AI: Verify Team Log"
    expected: "Team.json is committed and pushed, Verify Team Log reports no rejected events, anything odd is filed as a new issue"
    why_human: "Recorded in 69-VALIDATION.md as the owner's post-release manual check and explicitly not a gate (D-30). The extension-host e2e test is the automated stand-in and was reported green (20 of 20) by the caller; it was not re-run for this report."
---

# Phase 69: Team Mode reconciliation: identities and signed events on main Verification Report

**Phase Goal:** The identity, signed-event and permission core built for Team Mode (Phase 60, verified on the unmerged `feat/team-fix-pass` branch) runs on current `main`, so the governance phases build on one tested set of device keys, signatures and permission rules; projects without Team Mode behave exactly as before, and what remains of v0.6.0 has a recorded place in the new plan.
**Verified:** 2026-11-16
**Status:** human_needed (every truth verified in the code; the only open items are the owner's merge of PR #61 and the owner's post-release try, neither of which is a code gap)
**Re-verification:** No, initial verification
**Checkout verified:** branch `feat/team-signed-payloads` at 7b51e34, which is PR 1 (#59, squash 1cbcb9b on origin/main) plus the 39 commits of PR 2 (#61, open, mergeStateStatus CLEAN, CI checks green). The brief named 1cbcb9b; the checkout is 7b51e34 because it contains PR 2.

## Goal Achievement

### Observable Truths (ROADMAP success criteria, the contract)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `feat/team-fix-pass` is on GitHub as an archive branch and the loose files in its legacy worktree are committed or recorded, before any code moved (TMR-01) | VERIFIED | `git ls-remote origin refs/heads/feat/team-fix-pass` printed `4207080ca394d36cf36bbed37b179d8f8400b721`, the exact sha the record names. `.planning/research/v0.6.0-disposition.md` records the check, the 777 commits above the 0.4.11 fork point, and the six paths of the archive commit (the roadmap said five; the sixth is an empty `.gitkeep`, noted in the record). The legacy-worktree "status is clean" line is owner-machine state and could not be re-run here; it is recorded evidence, accepted as a record check per D-01. |
| 2 | On main a lead enables Team Mode and two clones share one signed log over the project's own remote; forged, unbound or under-privileged events are rejected by both with a reason; replay is deterministic; Phase 60's criteria hold again on main (TMR-02) | VERIFIED | Run here: 507 tests, 0 fail across the 26 team test files (teamEnable, teamLog "two clients on two clones converge ... byte-identical state", teamForgery "rejected with the same reasons by both clients, never change state", teamPermissions, teamMaterialize, teamGitTransport, teamValidate, teamIdentity and the rest). `teamConcurrency` (2), `teamSharedMirror` (6) and `teamMirrorIsolation` (4) each run alone at concurrency 1: all pass. 69-08-SUMMARY holds the Phase 60 criteria table; the tests it names exist and pass. No `vscode` import in `src/domain/team` or `src/team` (grep empty; `teamBoundaries` pins it, and its scanner has a teeth test). No dependency change in `package.json` across the phase (diff has only the two commands, the two settings and the two `commandPalette` entries). |
| 3 | A project with no team file behaves exactly as before: suite green, and a canary finds no secret in the log, `team.json`, settings or audit (TMR-03) | VERIFIED | `teamSoloParity` passes: one `fs.stat`, no timers, channel, status item, storage or team module loaded at activation; no workspace folder touches nothing. Canary scanners (`teamCanary` helper, SEC-01 canaries in teamEnable and teamCommands, teamKeyRotation key-rendering check, teamSecrets, teamAudit) pass. The core-file edits to existing code are three small ones (`extension.ts` registration, one `AuditEventType` member in `approval.ts`, the same string in `auditStore.ts`). Full suite 2632 pass and e2e 20 of 20 and CI green on PR #61 are the caller's figures; they were not re-run (instruction). |
| 4 | A device identity signs and verifies any canonical payload through one interface, and key rotation or revocation is itself a signed event that later checks honour (TMR-05) | VERIFIED (on the PR #61 branch only; see human item 1) | Read and probed. `signPayload` / `verifyPayload` in `src/domain/team/signedPayload.ts`: domain-separated input (`near-ai-vscode/signed-payload/v1\n<purpose>\n` plus canonical bytes), closed purpose list, caller-supplied expected purpose, never throws. Probe against the compiled output: round trip ok; wrong purpose refused as `wrong-purpose`; relabelling the purpose field gives `bad-signature`; a one-field tamper gives `bad-signature`; revoked gives `key-revoked`; rotated with a signing time at or after the rotation gives `key-rotated`, before it verifies; no known key gives `unknown-key`; a fractional number and an unknown purpose are refused on signing with plain text; null, numbers, strings, arrays and partial objects all return `malformed` without throwing; the implicit account id is 64 hex characters; no private key material in the envelope. Team side: `device.rotated` is in the event union, `validate.ts` exact-key body, `permissions.ts` row, `materialize.ts` reference rule (old key must be bound and unrevoked, new fingerprint unused, a member rotates only with the key it retires) and transition (old key keeps its fingerprint in the index, successor added in the same event so there is never a moment with two active keys or none). `teamKeyStatus` reads the roster and `eventLog.verifyAll` shows rotated and revoked keys with their real status. Solo side: `keyRecords.ts` replays a signed, hash-chained created/rotated/revoked history that fails closed on any change, gap, swap, truncation (head kept in SecretStorage), oversize or hostile getter, and `keyHistory.ts` writes it under a file lock; `identity.ts` backfills a created record on first need, repairs a crashed rotation or revocation, and never forgets a pre-existing key on a failed Enable (D-22). Tests pass: teamSignedPayload, teamKeyStatus, teamKeyHistory (including two processes rotating at once: exactly one wins), teamKeyRotation (crash before the record, after the record, and during the pending delete are each finished by the next call). |
| 5 | Every v0.6.0 phase and requirement has a recorded disposition, and colliding ids carry a `TM-` prefix (TMR-04) | VERIFIED | `.planning/research/v0.6.0-disposition.md` has rows for phases 60, 61, 62, 62.1, 63, 64, 65, 66, 67 and for all 34 archive requirement ids with a disposition from a closed list, a reason, and a "same id elsewhere" column. TM-TEAM-01..04 and TM-SETUP-01 are prefixed. Exactly four ids are landed (TM-TEAM-01, TM-TEAM-04, SEC-01, SEC-04), each tied to named Phase 69 tests. `REQUIREMENTS.md` (line 481) and `ROADMAP.md` (line 653) link to it. `teamDisposition` passes and pins the shape, the archive sha and the absence of local paths. |

**Score:** 5/5 truths verified (0 present, behavior-unverified; the behavior-dependent truths 2 and 4, state transitions and crash or concurrency invariants, each have a passing test that exercises them).

### Context decisions spot-checked (D-01..D-31)

| Decision | Status | Evidence |
|----------|--------|----------|
| D-06 one identity per person per install, only in SecretStorage | VERIFIED | `DEVICE_KEY_SECRET = 'nearAi.identity.deviceKey'`; no per-team key name in `src/`; Enable calls `loadOrCreateDeviceIdentity`. |
| D-11 / D-12 / D-23 mirror and ref isolation | VERIFIED | `RESERVED_SYNC_REFS` and the case-insensitive equal, under and prefix check in `teamFile.ts`; teamFile ref table and `teamMirrorIsolation` pass (team append and state sync at once, neither waits on the other's lock, sync never carries `team.json`). |
| D-13 / D-24 preview gating | VERIFIED | `package.json` hides Enable unless `config.nearAi.team.preview`, Verify unless preview or `nearAi.team.active`; Enable refuses in the core (`previewEnabled !== true` returns `preview-off`) as well as in the command. |
| D-20 / D-21 signer accepts any Ed25519 signer; rotation versus revocation stated plainly | VERIFIED | `PayloadSigner` interface; `PAYLOAD_FAILURES['key-rotated']` says only revoking stops a copied key; the message test pins no em-dash. |
| D-22 failed Enable keeps an existing identity | VERIFIED | `forgetCreatedDeviceIdentity` deletes only a key this call created with a history of exactly its own created record; a revoked record is written first. |
| D-27 manifest test replaced | VERIFIED | `teamManifest` passes against main's `package.json`. |

### Required Artifacts

| Artifact | Status | Details |
|----------|--------|---------|
| `src/domain/team/{canonical,types,permissions,policy,secrets,validate,materialize,recentMap}.ts` | VERIFIED | Present, substantive, covered by passing tests. |
| `src/domain/team/{signedPayload,keyStatus,keyRecords}.ts` | VERIFIED | Present, substantive (199, 68, 223 lines), probed. Not on origin/main yet (PR #61). |
| `src/team/{identity,keyHistory,enable,eventLog,gitTransport,teamFile,auditMirror,syncScheduler,runGit,transport}.ts` | VERIFIED | Present and wired. `keyHistory.ts` is PR #61 only. |
| `src/services/team/{teamCommands,teamSession,teamStatusBar}.ts` | VERIFIED | Wired from `extension.ts` through `registerTeamMode`; lazy import keeps solo activation to one stat. |
| `.planning/research/v0.6.0-disposition.md` | VERIFIED | See truth 5. |

### Key Link Verification

| From | To | Via | Status |
|------|----|-----|--------|
| `extension.ts` | `registerTeamMode` | activation, `teamModeTestApi` for e2e | WIRED |
| `enable.ts` | `identity.loadOrCreateDeviceIdentity` / `forgetCreatedDeviceIdentity` | per-person identity, D-22 rollback | WIRED |
| `identity.ts` | `keyHistory.appendKeyRecord` | created, rotated and revoked records | WIRED |
| `keyHistory.ts` | `signPayload` (purpose `key-record`) and `replayKeyHistory` | one signer, one verifier | WIRED |
| `eventLog.verifyAll` | `teamKeyStatus(state)` | rotated and revoked keys shown as such | WIRED |
| `signPayload` / `verifyPayload` | any production caller | none yet | ORPHANED by design: Phases 70, 71 and 80 are the consumers (D-10). The only in-tree callers are the key history and the tests. No UI command rotates or revokes yet (teamKeyRotation pins "no rotate or revoke command"), also by design. |

### Data-Flow Trace (Level 4)

Key status flows from signed records (roster events or the signed key history) to the verifier; no static or hardcoded status source. A history that cannot be read yields `NO_KNOWN_KEYS` (fail closed), never "trusted".

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Team group (26 files, concurrency 2) | the wrapped `tsc` plus `node --test` over the explicit file list | 507 tests, 0 fail | PASS |
| Process-level tests alone | `teamConcurrency`, `teamSharedMirror`, `teamMirrorIsolation` at concurrency 1 | 2, 6, 4 pass | PASS |
| Signer and verifier hostile-input probe | scratch script over `dist/` (not committed) | all refusals as expected, nothing thrown | PASS |
| Archive branch on the remote | `git ls-remote origin refs/heads/feat/team-fix-pass` | 4207080ca394d36cf36bbed37b179d8f8400b721 | PASS |

### Probe Execution

No probe scripts are declared by the phase. Step 7c: not applicable.

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| TMR-01 | Archive branch preserved, loose files committed or recorded | SATISFIED | Truth 1. |
| TMR-02 | Core runs on main, no vscode import, no new dependency | SATISFIED | Truth 2 and boundary test. |
| TMR-03 | Solo parity, canary | SATISFIED | Truth 3. |
| TMR-04 | Dispositions and `TM-` prefixes | SATISFIED | Truth 5. |
| TMR-05 | One signer and verifier, rotation and revocation honoured | SATISFIED on the PR #61 branch; not on main until merged | Truth 4. |

No orphaned requirements: REQUIREMENTS.md maps only TMR-01..TMR-05 to Phase 69 and the plans claim all five.

### Anti-Patterns Found

None. No TODO, FIXME, TBD, XXX or HACK in `src/domain/team`, `src/team` or `src/services/team`; no em-dash and no local machine path in those folders or in the disposition record; no stub returns on the paths read.

### Human Verification Required

#### 1. Merge PR #61

**Test:** The owner reviews and merges PR #61 through the normal gates.
**Expected:** `origin/main` then contains the payload signer, key status, key history and the disposition record. The roadmap states the goal as "runs on current main", and TMR-05 is marked complete in `REQUIREMENTS.md` and the traceability table while its code is on an open PR branch.
**Why human:** Merge is the owner's gate (D-17, D-30). Until it happens, ROADMAP and REQUIREMENTS read as complete one step ahead of main.

#### 2. Owner try after release (not a gate)

**Test:** After a published 0.4.x version carries both PRs, run Enable Team Mode and Verify Team Log on a scratch repository with the preview setting on.
**Expected:** No rejected events; report anything odd as an issue.
**Why human:** Recorded in `69-VALIDATION.md` as manual-only; the owner will not try a PR build (D-30).

### Gaps Summary

No code gaps. Every roadmap success criterion is backed by code read here and by tests run here. Two minor, non-blocking notes:

- `69-VALIDATION.md` still shows `status: draft`, `nyquist_compliant: false` and unticked sign-off boxes (its own header says sign-off is completed by validate-phase after execution). That is a record to close, not a behavior gap.
- The 2632-test full suite, the 20 of 20 e2e run and the green CI on PR #61 are the caller's figures; this report ran only the targeted team group and the three process-level tests (all green) and a hostile-input probe of the signer.

---

_Verified: 2026-11-16_
_Verifier: Claude (gsd-verifier)_
