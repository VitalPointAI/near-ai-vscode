---
phase: 60-team-core-identity-signed-event-log-git-transport-roster
verified: 2026-11-01T00:00:00Z
status: human_needed
score: 5/5 must-haves verified
covered_files:
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-01-PLAN.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-01-SUMMARY.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-02-PLAN.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-02-SUMMARY.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-03-PLAN.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-03-SUMMARY.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-04-PLAN.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-04-SUMMARY.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-05-PLAN.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-05-SUMMARY.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-06-PLAN.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-06-SUMMARY.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-07-PLAN.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-07-SUMMARY.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-08-PLAN.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-08-SUMMARY.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-09-PLAN.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-09-SUMMARY.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-10-PLAN.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-10-SUMMARY.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-11-PLAN.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-11-SUMMARY.md"
  - "package.json"
  - "src/domain/approval.ts"
  - "src/domain/team/canonical.ts"
  - "src/domain/team/materialize.ts"
  - "src/domain/team/permissions.ts"
  - "src/domain/team/policy.ts"
  - "src/domain/team/secrets.ts"
  - "src/domain/team/types.ts"
  - "src/domain/team/validate.ts"
  - "src/extension.ts"
  - "src/services/auditStore.ts"
  - "src/services/team/teamCommands.ts"
  - "src/services/team/teamSession.ts"
  - "src/services/team/teamStatusBar.ts"
  - "src/team/auditMirror.ts"
  - "src/team/enable.ts"
  - "src/team/eventLog.ts"
  - "src/team/gitTransport.ts"
  - "src/team/identity.ts"
  - "src/team/runGit.ts"
  - "src/team/syncScheduler.ts"
  - "src/team/teamFile.ts"
  - "src/team/transport.ts"
covered_digest: "v4:sha256:8d9a13481c0dcdd7c93771aa35428b4cde7490e60361df93c76a20b0a583434b"
behavior_unverified: 0
overrides_applied: 0
coincidental_reliance_items: []
human_verification:
  - test: "In two real VS Code windows on two clones of one project with a shared remote, run NEAR AI: Enable Team Mode in window A, then open window B and let it sync. Then block the remote (for example, point the remote at an unreachable host or take the network down for a stalled-connection case) and watch the status bar."
    expected: "Window B materialises the team and the owner's roster; the status bar reads 'Team: <name>' while syncing and 'Team sync paused: remote unreachable' when the remote is unreachable, and recovers when the remote returns. A stalled (not refused) connection must also end in the paused state rather than leaving the last healthy text."
    why_human: "Automated tests drive two TeamLog/TeamSession clients on real git against a bare remote through a vscode stub. They do not open two real editor windows or exercise a stalled (non-refusing) network, which is the case CR-01 affects."
  - test: "Decide whether open review finding CR-01 (runGit timeout can leave sync wedged) is accepted for Phase 60 or must be fixed before the phase is closed."
    expected: "Either an explicit accept with reason, or a fix plan (settle from the timer and kill the process group), with a regression test that a timed-out git whose helper holds the pipes still settles."
    why_human: "This is a risk-acceptance decision. See the CR-01 analysis below."
---

# Phase 60: Team core: identity, signed event log, git transport, roster Verification Report

**Phase Goal:** A lead can turn on Team Mode for a project, and two clones of it share one signed, append-only coordination log over the project's own git remote in which every client verifies every event, roles are enforced and no secret is ever written.
**Verified:** 2026-11-01
**Status:** human_needed
**Re-verification:** No, initial verification

## Goal Achievement

The goal is achieved in code. Every numbered success criterion is backed by implementation I read and by tests I confirmed pass (full `npm test`: 918 tests, 910 pass, 0 fail, 8 skipped for unrelated environment reasons such as no LibreOffice or NEAR AI API key; `npm run lint` clean). No truth failed. Status is `human_needed` rather than `passed` because (1) real two-window and stalled-network behavior is not exercised by any test, and (2) the open critical review finding CR-01 needs an explicit accept-or-fix decision (see below). I did not run the e2e suite.

### Observable Truths

| # | Truth (ROADMAP success criterion) | Status | Evidence |
|---|-----------------------------------|--------|----------|
| 1 | Lead runs `NEAR AI: Enable Team Mode` and gets a team, owner device key only in SecretStorage, orphan branch `near-ai/coordination`, committed `.planning/.near-ai/team.json`; canaries never appear in log, team.json, settings or audit (TEAM-01, SEC-01) | VERIFIED | `package.json` contributes `nearAi.team.enable` and `nearAi.team.verifyLog`; `registerTeamMode` wired at `src/extension.ts` (diff vs main). `src/team/enable.ts` does preconditions, key creation, genesis push, `git add -f` plus `commit --only` of team.json (line ~265), and `assertNoSecrets` on inputs (193), team.json (219). Tests passing: "Enable creates the team, the device key, the orphan coordination branch and a team.json-only commit, and never pushes the code branch"; "SEC-01 canary: after Enable and Verify no secret or device key reaches the UI, settings, storage, team.json or any git object"; "SEC-01 canary: no secret reaches any git object, team.json, extension storage or the audit store after Enable and roster events". Caveat: Enable rollback has WR-01/WR-02 defects (error paths only). |
| 2 | Two clones share one coordination branch; an event appended by one is materialised identically by the other; replay is deterministic (property test) (TEAM-04) | VERIFIED | `src/team/gitTransport.ts` (ref `refs/heads/near-ai/coordination`, plain `push --porcelain`, no force, mirror `core.hooksPath` and `transfer.fsckObjects`), `src/team/eventLog.ts`, `src/domain/team/materialize.ts`. Tests passing: "two clients on two clones converge: events appended by A are materialised by B with byte-identical state"; "deterministic property: replay, incremental application and snapshot plus tail agree over seeded random logs". Caveat: tests use two clients on real git, not two editor windows (human item 1). |
| 3 | Forged event (bad signature, unbound key, insufficient role) is rejected by both clients, never changes state, is listed with reason in Rejected events diagnostics; roles enforced on write and read (TEAM-04, SEC-04) | VERIFIED | `materialize.ts` `applyEntry`: steps for bound device, signature, Lamport, and step 6 `decideTeamAction` at that log position (line ~109); `eventLog.ts` write side calls the same `decideTeamAction` (line ~96) inside the builder before signing. Rejections are written to the NEAR AI Team channel once per event (`teamSession.ts` `noteRejections`) and the Verify report prints `Rejected events: N` with per-event reasons (`teamSession.ts:90-91`). Tests passing: "raw forged events are rejected with the same reasons by both clients, never change state and are listed by verifyAll", "step order: an unbound device, a broken signature...", "positional revocation/removal", permission matrix suite. Caveat: `prev` is signed but not checked on read (WR-08), and a fully refused log shows a healthy status (WR-06); neither is part of this criterion. |
| 4 | Concurrent appends never lose an event: several child-process clients appending to a local bare repo end with every event present and no force-push (TEAM-04) | VERIFIED | `src/test/teamConcurrency.test.ts` with `helpers/teamAppendChild.ts` forks real processes. Passing: "4 forked clients with separate mirrors append 5 events each: every event once, linear history, no forced update, clean fresh replay"; "3 forked clients sharing one mirror directory ... converge the same way". Source has no force flag or `+` refspec in push (grep). |
| 5 | Solo projects (no team.json) behave exactly as 0.4.8; existing suite unchanged and green; lint and full test pass | VERIFIED | `registerTeamMode` does one `fs.stat` and loads team modules lazily (`teamCommands.ts` header and dynamic imports). Passing: "solo project: activation makes one fs.stat and no timers, channel, status item, storage or team module". Changes to existing files are minimal: one import and one call in `extension.ts`, one allow-list entry in `auditStore.ts`, one union member in `approval.ts`, manifest contributions. `npm run lint` exit 0; `npm test` exit 0 with 0 failing. |

**Score:** 5/5 truths verified (0 present, behavior-unverified)

Scope statement from the ROADMAP (not a numbered criterion): "An unreachable remote shows a visible 'Team sync paused' state instead of failing silently." Verified for refused or fast-failing remotes: `teamStatusBar.ts` defines `Team sync paused: remote unreachable` and `Team sync paused: log rewritten`, with session tests for unreachable remote, backoff and credential redaction. The stalled-connection sub-case is the CR-01 concern (below).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/domain/team/{types,canonical,validate,permissions,policy,secrets,materialize}.ts` | Pure core: canonical JSON, exact-key validation, role matrix, secret guard, deterministic reducer | VERIFIED | Present, substantive, imported by `eventLog.ts` and `gitTransport.ts`; each has a dedicated test file that passes |
| `src/team/identity.ts` | Ed25519 device key in SecretStorage | VERIFIED | Tests assert no key material serialises |
| `src/team/gitTransport.ts`, `runGit.ts`, `transport.ts` | Mirror, CAS push, retry, quarantine, no force | VERIFIED (CR-01 caveat on `runGit.ts`) | 750-line transport; hooks isolated; fsck on transfer |
| `src/team/eventLog.ts` | TeamLog write/read facade, snapshot writer | VERIFIED | Wired from `teamSession.ts` and `enable.ts` |
| `src/team/teamFile.ts`, `auditMirror.ts` | Untrusted team.json, atomic write, trust pin, roster audit | VERIFIED | `assertNoSecrets` before every write |
| `src/team/enable.ts` | Enable core | VERIFIED (error-path caveats WR-01/02) | Happy path, existing team, unreachable remote, lost reply, hook failure and push rollback are tested |
| `src/team/syncScheduler.ts`, `src/services/team/*` | Scheduler, session, status bar, commands | VERIFIED | Registered in `extension.ts`; manifest contributes both commands and `nearAi.team.pollSeconds` |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `extension.ts` | `registerTeamMode` | call at activation | WIRED | Present in diff; solo parity test passes |
| `eventLog.ts` write path | `permissions.decideTeamAction` | pre-sign check | WIRED | line ~96 |
| `materialize.ts` read path | `permissions.decideTeamAction` | step 6 | WIRED | line ~109, same function |
| `eventLog.ts` / `enable.ts` / `teamFile.ts` / `auditMirror.ts` | `secrets.assertNoSecrets` | before write | WIRED | grep confirms at all four write sites |
| `teamSession.ts` | `auditMirror` | roster mirror to AuditStore | WIRED | disk read-back confirmation; type `team-roster` added to allow-list |
| `teamStatusBar.ts` | transport status | paused text | WIRED | tests for unreachable and rewritten |

### Data-Flow Trace (Level 4)

Status bar and Verify report render from `TeamLog.state()` and `transport.status()`, which are populated by real git fetches and replays; no hardcoded or static data. FLOWING.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Lint | `npm run lint` | exit 0 | PASS |
| Full suite (run once) | `npm test` | 918 tests, 910 pass, 0 fail, 8 skipped (unrelated env) | PASS |
| CR-01 mechanism, generic | Node `spawn` of `sh -c 'sleep 4 & wait'`, SIGKILL parent at 300 ms | `close` fired only at 4010 ms | Confirms the mechanism exists in Node |
| CR-01 against real git | `runGit(['ls-remote','ssh://...'], {timeoutMs: 500})` with `GIT_SSH` stand-in that backgrounds a sleep | Settled at 508 ms with code 124 | Not reproduced with this ssh stand-in |

### Probe Execution

No probes declared by the phase. Skipped.

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
|-------------|--------------|-------------|--------|----------|
| TEAM-01 | 60-06, 60-08, 60-11 | Lead can enable Team Mode on an initialised project; solo projects unchanged | SATISFIED | Truths 1 and 5 |
| TEAM-04 | 60-01, 03, 04, 05, 07, 09, 10 | Every client verifies every event's signature and the author's permission at that log point | SATISFIED | Truths 2, 3, 4; `applyEntry` pipeline and positional revocation tests |
| SEC-01 | 60-02, 06, 07, 08, 09, 11 | No secret written to log, team.json, settings or audit | SATISFIED | `assertNoSecrets` at all write sites; three canary tests; advisory A2/A1 do not bear on writes |
| SEC-04 | 60-02, 05, 07 | Role permissions enforced on write and on read | SATISFIED | One `decideTeamAction` shared by both sides; forgery suite asserts equal reasons |

All four IDs from the ROADMAP and PLAN frontmatter appear in REQUIREMENTS.md and are covered by at least one plan; no orphaned requirements for Phase 60. Note: REQUIREMENTS.md still shows these as `Pending` / `In Progress`; updating the traceability table is bookkeeping for the orchestrator.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/team/runGit.ts` | 53-67 | Timeout kills only the git process and waits for `close` | Warning (CR-01) | See analysis below |
| `src/team/enable.ts` | 231-251 | Rollback runs on an unconfirmed push; append throw skips rollback | Warning (WR-01, WR-02) | Error-path only: can orphan or destroy the only owner key |
| `src/services/team/teamSession.ts` | 198-202 | Rejected sync promise poisons the chain | Warning (WR-03) | Needs an unexpected throw outside the guarded block |
| `src/team/eventLog.ts` | 179-193 | Snapshot failure discards already-applied entries | Warning (WR-04) | Roster audit and rejection reports lost until restart |
| `src/services/team/teamSession.ts` | 276-295 | Refused log displays "Team: name" | Warning (WR-06) | Weakens the "visible" trust failure signal |
| `src/domain/team/materialize.ts` | 213-244, 273-295 | `prev` unchecked (WR-08); snapshot hash includes version-dependent fields (WR-07) | Warning | Frozen-into-signed-data contracts; cheapest to fix now |
| `src/team/gitTransport.ts` | (WR-12) | Remote URL passed on git argv | Warning | URL with embedded credentials visible in process list |
| TBD/FIXME/XXX markers | n/a | None found in `src/team`, `src/domain/team`, `src/services/team` | n/a | n/a |

All 19 review findings (1 critical, 12 warning, 6 info) remain `open` in `60-REVIEW-DISPOSITION.md`. Security audit: 61 threats closed, 0 open, advisories A1 (trust pin keyed by team id) and A2 (snapshot parser has no production caller) are non-blocking.

### CR-01 vs the success criteria (explicit weighing)

- Does CR-01 defeat any numbered success criterion (1 to 5)? No. None of them depends on a git timeout, and each is proven by tests that pass.
- Does CR-01 defeat the ROADMAP scope sentence "An unreachable remote shows a visible 'Team sync paused' state instead of failing silently"? Not for the ordinary unreachable case (connection refused, DNS failure, auth failure, fast exit), where git exits non-zero and the paused state appears. It does undermine the stalled-connection case. In the code as written, if git times out and a helper keeps the stdout or stderr pipe open, `runGit` never resolves, `withMirrorLock` is never released, the scheduler's single-flight never clears, and the status bar keeps its last text with nothing logged. That is precisely a silent failure, and recovery needs a window reload. I confirmed the mechanism generically (parent killed, grandchild holds the pipe, `close` delayed 4 s) and the code at `runGit.ts:53-67` matches the review's description. I could not reproduce the hang with real git against an ssh stand-in (it settled in 508 ms), so the practical trigger is narrower than the review implies, but it is real and unprotected.
- My judgement: WARNING, not BLOCKER, because the phase goal and all five criteria hold and the failure needs a specific stall condition. It should be fixed or explicitly accepted before the phase closes, because the fix is small and local (settle from the timer, kill the process group) and the harm (silent permanent stall) is exactly what the phase promises to avoid. Items WR-06 (refused log shown as healthy) and WR-10 (missing remote branch reported healthy) are the next most relevant to the same "visible, not silent" intent.

### Human Verification Required

#### 1. Two real windows and a stalled remote

**Test:** Run Enable Team Mode in one VS Code window, open the second clone in another window, let it sync, then make the remote unreachable and also stalled (not just refused).
**Expected:** The second window shows the team and roster; status bar shows `Team sync paused: remote unreachable` on failure and recovers when the remote returns; a stalled connection also ends in the paused state.
**Why human:** Tests do not open real editor windows or simulate a stalled network.

#### 2. CR-01 accept-or-fix decision

**Test:** Review the analysis above.
**Expected:** Explicit accept with reason, or a fix and regression test before closing the phase.
**Why human:** Risk-acceptance call.

### Gaps Summary

No must-have failed, so there are no `gaps:` for gap-closure planning. The recommendation is to fix CR-01 and the closely related WR-01, WR-02, WR-03, WR-06 and WR-08 before further phases depend on the transport, since WR-07 and WR-08 concern contracts that become permanent once signed events exist in real teams.

---

_Verified: 2026-11-01_
_Verifier: Claude (gsd-verifier)_
