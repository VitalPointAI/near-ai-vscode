---
phase: 60-team-core-identity-signed-event-log-git-transport-roster
verified: 2026-11-01T16:00:00Z
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
  - "src/test/teamRunGit.test.ts"
covered_digest: "v4:sha256:36b336551e0b669c3ff63cd715b84fd2593e90098c538cbe654b31641b61e22e"
behavior_unverified: 0
overrides_applied: 0
coincidental_reliance_items: []
re_verification:
  previous_status: human_needed
  previous_score: 5/5
  gaps_closed:
    - "CR-01 accept-or-fix decision: fixed (settle from the timer, kill the process group) with a regression test"
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "In two real VS Code windows on two clones of one project with a shared remote, run NEAR AI: Enable Team Mode in window A, then open window B and let it sync. Then block the remote (point it at an unreachable host, then a stalled connection such as a listener that accepts and never answers) and watch the status bar in window B."
    expected: "Window B materialises the team and the owner's roster; the status bar reads 'Team: <name>' while syncing and 'Team sync paused: remote unreachable' when the remote is unreachable or stalled (a stalled fetch ends after at most 60 s), and recovers to 'Team: <name>' when the remote returns."
    why_human: "Automated tests drive two TeamLog/TeamSession clients on real git against a bare remote through a vscode stub. No test opens two real editor windows, and no test drives a stalled fetch all the way through TeamSession to the status bar text. The pieces are covered separately (see Behavioral Spot-Checks) but not as one flow."
---

# Phase 60: Team core: identity, signed event log, git transport, roster Verification Report

**Phase Goal:** A lead can turn on Team Mode for a project, and two clones of it share one signed, append-only coordination log over the project's own git remote in which every client verifies every event, roles are enforced and no secret is ever written.
**Verified:** 2026-11-01
**Status:** human_needed
**Re-verification:** Yes. The previous report was stale because the code review fix pass (CR-01 and WR-01 to WR-12, 12 commits, `53b3fc6` to `74ef837`) changed covered source files. Every truth was re-checked against the current code, the 13 fixes were each confirmed in code and by a regression test, and the full suite was re-run.

## Goal Achievement

The goal is achieved in code and the fixes did not break any success criterion. Evidence of this run: `./node_modules/.bin/tsc --noEmit` exits 0 and `npm test` reports 939 tests, 931 pass, 0 fail, 8 skipped (ripgrep, LibreOffice, Open-GSD runtime, live NEAR AI tests; all environment skips, unchanged from before). I did not run e2e. No truth failed. The status is `human_needed` for one reason only: the real two-window and stalled-network manual test is not covered by any automated test as one flow (see the human item and its scope below). The previous CR-01 accept-or-fix human item is resolved by the fix and is no longer open.

### Observable Truths

| # | Truth (ROADMAP success criterion) | Status | Evidence |
|---|-----------------------------------|--------|----------|
| 1 | Lead runs `NEAR AI: Enable Team Mode` and gets a team, owner device key only in SecretStorage, orphan branch `near-ai/coordination`, committed `.planning/.near-ai/team.json`; canaries never appear in log, team.json, settings or audit (TEAM-01, SEC-01) | VERIFIED | `src/team/enable.ts` still does preconditions, key creation, genesis push via `pushGenesis`, team.json commit, and `assertNoSecrets` on inputs (line 240) and team.json (266); `eventLog.ts:60,61,88` and `teamFile.ts:189`, `auditMirror.ts:106` guard the other write sites. Passing in the full run: Enable creates team/key/orphan branch/team.json-only commit; both SEC-01 canary tests; new WR-01/WR-02 tests. The WR-01/02 rollback defects are fixed (see review fix table), so the error paths no longer destroy the only owner key. |
| 2 | Two clones share one coordination branch; an event appended by one is materialised identically by the other; replay deterministic (property test) (TEAM-04) | VERIFIED | Convergence test ("two clients on two clones converge ... byte-identical state") and the seeded determinism property test still pass after the WR-07 (state hash) and WR-08 (prev check) format changes; no existing materialiser test needed editing for WR-08, and WR-07 changed only two comments in tests. |
| 3 | Forged event (bad signature, unbound key, insufficient role) rejected by both clients, never changes state, listed with reason in Rejected events diagnostics; roles enforced on write and on read (TEAM-04, SEC-04) | VERIFIED | `applyEntry` order is unchanged where it matters: bound device, then signature (`materialize.ts:233`), then the new `prev` check (236, after the signature so a forged event still reports `badSignature`), Lamport, then `decideTeamAction` at the log position. The write side still calls the same `decideTeamAction`. Forgery suite and permission matrix pass. New tests assert a wrongly linked event is rejected with `TEAM_REJECTION_REASONS.prevMismatch`, leaves the head unmoved, and a correct link is still accepted afterwards. |
| 4 | Concurrent appends never lose an event: child-process clients append to a local bare repo with every event present and no force-push (TEAM-04) | VERIFIED | `teamConcurrency.test.ts` passes (separate mirrors and a shared mirror directory, forked processes, linear history, no forced update). Writers derive `prev` from the accepted head and re-derive after each lost race (`eventLog.ts:86-108`), which is why WR-08 did not break concurrency. `grep` finds no force flag, `+` refspec in push, or `git push --force` in `gitTransport.ts` (only `rm -f` calls match "force"). |
| 5 | Solo projects behave exactly as 0.4.8; existing suite green; lint and full test pass | VERIFIED | Solo-parity test ("activation makes one fs.stat and no timers, channel, status item, storage or team module") still passes. tsc clean; `npm test` 939 tests, 0 fail. The fix pass touched no file outside the team code (`git diff` shows only `src/domain/team`, `src/team`, `src/services/team` and their tests). |

**Score:** 5/5 truths verified (0 present, behavior-unverified)

Scope statement from the ROADMAP: "An unreachable remote shows a visible 'Team sync paused' state instead of failing silently." Now verified for refused or fast-failing remotes AND for a stalled remote at the component level: `runGit` settles from its own timer and kills git's process group, a timed-out git (exit code 124) is classified `unreachable` by `classifyGitFailure` (no special case needed) and `classifyPush` ('offline' for 124, test at `teamGitTransport.test.ts:445`), and `teamStatusBar.ts` renders `Team sync paused: remote unreachable` for that status. Not exercised as one flow in a real editor: see the human item.

### Code review fix verification (CR-01 and WR-01 to WR-12)

Each fix was read in the current code and matched to a regression test that exists in the passing suite. The 6 info findings (IN-01 to IN-06) remain open by the review's scope and are recorded in `60-REVIEW-DISPOSITION.md`.

| Finding | Fix in code | Regression test | Success criteria impact |
|---------|-------------|-----------------|-------------------------|
| CR-01 | `runGit.ts`: git spawned `detached` on POSIX; timer calls `killTree` (`process.kill(-pid, 'SIGKILL')`, fallback `child.kill`), then `finish()` resolves `{code: 124, stderr: 'git timed out after N ms'}` and destroys stdout/stderr, without waiting for `close`; a `settled` guard makes later `close`/`error` events inert; timer cleared on every path. Windows keeps the single-process kill. | `teamRunGit.test.ts`: fake `git` starts a `sleep 30` helper that inherits the pipes; asserts code 124, settled in under 5 s, and the helper pid is dead within 3 s. Second test: a normal `git --version` is unaffected. | None broken. Closes the stalled-remote hole for the "Team sync paused" scope sentence. |
| WR-01 / WR-02 | `enable.ts` `pushGenesis`: a throw or an offline push is checked against the remote (fetch then `status().state === 'ok'` and head equals our `member.joined`; if fetch throws, `git ls-remote --exit-code`, exit 2 means absent). Only a definite failure rolls back; an unknown outcome returns `push-unconfirmed` and keeps the key and mirror. | Three new `teamEnable.test.ts` tests: may-have-landed keeps key and mirror; throw with remote answering absent rolls back; landed-then-threw is recognised and Enable finishes. Existing lost-reply and failed-push tests pass unchanged. | Criterion 1 unaffected (happy path unchanged). |
| WR-03 | `teamSession.ts` `sync()` catches any `syncOnce` rejection, reports once, returns `false`; the chain tail no longer rejects. | "a throw while showing the status does not stop later syncs (WR-03)". | None. |
| WR-04 | `eventLog.ts` `trySnapshot()` turns a snapshot throw into a refused `AppendResult`, used in `sync()` and `append()`; fetched entries and accepted events are kept. | "a snapshot write that throws does not discard the entries the same sync fetched (WR-04)". | None. |
| WR-05 | `EntryVerdict.authorRole` read before `applyTransition`; `SyncResult.authorRoles`; session stores role per queued roster event and passes it to the mirror (`roleOf(memberId, event)`). | Materialiser test (role at position, demotion) and mirror test. Latent in Phase 60 (only the owner can author), which the fix report states plainly. | None. |
| WR-06 | After each sync, `refused = log.state().refused` with transport `ok` becomes status `paused` with reason `logRefused`, text `Team log not trusted`, one warning per session, sync returns `false` (backoff). | "a coordination log that does not match the genesis anchor shows a paused not-trusted state, warns once and backs off (WR-06)". | Strengthens criterion 3's "visible" refusal. |
| WR-07 | `materialize.ts` `stateHash` hashes `canonicalize({hashVersion: 1, ...plainState})` minus `accepted`, `seenEventIds`, `rejected`, `snapshots`; `STATE_HASH_VERSION = 1` exported. **Format change**, no snapshot has shipped. | Two new tests: junk and counters do not change the hash; members, devices, policy, head, highLamport and the hash version still do. Existing snapshot and property tests pass unchanged. | Criterion 2 determinism still holds. |
| WR-08 | `applyEntry` rejects `event.prev !== state.head.eventId` with `prevMismatch`, after the signature step; genesis requires `prev === ''` (`applyGenesis`, line 80). **Format change.** | Tests for empty link, older id, unknown id, and a validly signed genesis with non-empty `prev`; the fix report says both fail with the check removed. | Honest writers already chain correctly (checked at `eventLog.ts:64,68,86-108`); two-clone, concurrency and forgery suites still pass. |
| WR-09 | One `isGitRefName` in `policy.ts` following `git check-ref-format --branch` plus control and invisible-format characters; used by `policy.ts` and `teamFile.ts` `validRef`; `enableDefaults` falls back to `main`. **Read-side format change.** | `isGitRefName` compared against the real `git check-ref-format --branch` over a 35-name corpus; Enable test with `feature/c++#1@café` and a zero-width branch. | None. |
| WR-10 | `gitTransport.ts` `fetchLocked`: an `absent` failure is normal only if this client never read the branch (no `pin`, no `LOCAL_REF`); otherwise status `offline` with `BRANCH_MISSING_REASON`, status bar `Team sync paused: log missing on remote`. | Transport-level and session-level tests including recovery when the branch returns. | None. |
| WR-11 | Audit mark file keyed by `projectMarkScope(projectRoot)` (`audit-mark.<scope>.json`); unscoped name unchanged. | "a second checkout of the same team on this computer still receives the roster entries in its own audit log (WR-11)". Two existing session tests edited only to follow the new file name (disclosed in the fix report). | None. |
| WR-12 | `networkTarget()` passes the URL as `remote.near-ai-team.url` through `GIT_CONFIG_COUNT/KEY/VALUE` in the git environment for fetch, both pushes and the genesis `ls-remote` (git 2.31 or later, detected once; older git falls back to the argument form). Nothing written to the mirror config. | Recording-runner test: no argument contains the URL, config variables present, mirror config lacks the URL; fallback test for git 2.30.2. | None. |

The fix report marks CR-01, WR-01/02, WR-05, WR-07, WR-08, WR-09, WR-10 and WR-12 as "requires human verification" because semantic correctness cannot be proven by tests alone. For the phase goal I judged them by reading the code against the tests, and they are consistent. The format changes (WR-07, WR-08, WR-09) are safe to take now because no signed event or snapshot exists in a real team yet; they would be breaking changes after Phase 61 ships joins.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/domain/team/{types,canonical,validate,permissions,policy,secrets,materialize}.ts` | Pure core | VERIFIED | Present, substantive, wired from `eventLog.ts` and `gitTransport.ts`; each has a passing test file |
| `src/team/identity.ts` | Ed25519 device key in SecretStorage | VERIFIED | Unchanged by the fix pass; no key material serialises |
| `src/team/gitTransport.ts`, `runGit.ts`, `transport.ts` | Mirror, CAS push, retry, quarantine, no force | VERIFIED | CR-01 caveat on `runGit.ts` removed; URL no longer on argv (WR-12) |
| `src/team/eventLog.ts` | TeamLog facade, snapshot writer | VERIFIED | Wired from `teamSession.ts` and `enable.ts` |
| `src/team/teamFile.ts`, `auditMirror.ts` | Untrusted team.json, trust pin, roster audit | VERIFIED | `assertNoSecrets` before every write |
| `src/team/enable.ts` | Enable core | VERIFIED | WR-01/02 rollback defects fixed |
| `src/team/syncScheduler.ts`, `src/services/team/*` | Scheduler, session, status bar, commands | VERIFIED | Registered in `extension.ts`; manifest contributes both commands and `nearAi.team.pollSeconds` |
| `src/test/teamRunGit.test.ts` | CR-01 regression | VERIFIED | New, passes |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `extension.ts` | `registerTeamMode` | call at activation | WIRED | Solo parity test passes |
| `eventLog.ts` write path | `permissions.decideTeamAction` | pre-sign check | WIRED | Unchanged |
| `materialize.ts` read path | `permissions.decideTeamAction` | step 6 | WIRED | Same function |
| write sites | `secrets.assertNoSecrets` | before write | WIRED | `eventLog.ts:60,61,88`, `teamFile.ts:189`, `auditMirror.ts:106`, `enable.ts:240,266` |
| `teamSession.ts` | `auditMirror` | roster mirror to AuditStore | WIRED | Now passes per-event author role and a per-project mark scope |
| `teamSession.ts` | `teamStatusBar.ts` | paused states (unreachable, rewritten, missing, not trusted) | WIRED | `BRANCH_MISSING_REASON` from `transport.ts`; `logRefused` from the materialiser reasons |
| `gitTransport.ts` | `runGit.ts` timeout (code 124) | classify as unreachable/offline | WIRED | `classifyGitFailure` default branch and `classifyPush` |

### Data-Flow Trace (Level 4)

Status bar and Verify report render from `TeamLog.state()` and `transport.status()`, populated by real git fetches and replays; the new refused and missing-branch states derive from real state (`log.state().refused`, `LOCAL_REF`/pin) and are tested against real git. FLOWING.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Type check / lint | `./node_modules/.bin/tsc --noEmit -p .` | exit 0 | PASS |
| Full suite (run once) | `npm test` | 939 tests, 931 pass, 0 fail, 8 skipped (environment) | PASS |
| Real git against a stalled server (independent of the repo test) | `runGit(['ls-remote','git://127.0.0.1:<port>/x.git'], {timeoutMs: 700})` against a local TCP listener that accepts and never answers | code 124 after 706 ms, stderr `git timed out after 700 ms`; no git or git-remote process left behind | PASS |
| No force push, no debt markers | grep `gitTransport.ts`; grep `TBD|FIXME|XXX` in `src/team`, `src/domain/team`, `src/services/team` | none found | PASS |

### Probe Execution

No probes declared by the phase. Skipped.

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
|-------------|--------------|-------------|--------|----------|
| TEAM-01 | 60-06, 60-08, 60-11 | Lead can enable Team Mode on an initialised project; solo projects unchanged | SATISFIED | Truths 1 and 5 |
| TEAM-04 | 60-01, 03, 04, 05, 07, 09, 10 | Every client verifies every event's signature and the author's permission at that log point | SATISFIED | Truths 2, 3, 4; `applyEntry` pipeline now also enforces `prev` |
| SEC-01 | 60-02, 06, 07, 08, 09, 11 | No secret written to log, team.json, settings or audit | SATISFIED | `assertNoSecrets` at all write sites; canary tests pass; URL credentials moved off argv (WR-12) |
| SEC-04 | 60-02, 05, 07 | Role permissions enforced on write and on read | SATISFIED | One shared `decideTeamAction`; forgery suite asserts equal reasons |

All four IDs from the ROADMAP and from the PLAN `requirements:` frontmatter (60-01 to 60-11) appear in REQUIREMENTS.md and are accounted for; no orphaned requirements for Phase 60. REQUIREMENTS.md still shows them as `Pending` / `In Progress`; updating the traceability table is bookkeeping for the orchestrator.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (open, info only) | n/a | IN-01 to IN-06 per `60-REVIEW-DISPOSITION.md` | Info | Timestamps format-checked only (IN-01), public-salted email hashes (IN-02), reads use the push URL (IN-03), no old-value guard on `update-ref LOCAL_REF` across windows (IN-04), tooltip blames the remote for any sync failure (IN-05), `commitFiles` loses the original failure when cleanup also fails (IN-06). None bears on a success criterion. |
| TBD/FIXME/XXX markers | n/a | none | n/a | n/a |

No blocker or warning anti-patterns remain from the previous report; CR-01 and WR-01 to WR-12 are fixed and tested.

Residual notes (not gaps): (a) the four fields excluded from the WR-07 hash (`accepted`, `seenEventIds`, `rejected`, `snapshots`) are no longer authenticated by the hash; the fix report notes this and the snapshot fast path has no production caller yet (advisory A2 in `60-SECURITY.md`), so it matters when that consumer is added. (b) `60-SECURITY.md` was written before the fix pass; the fixes reduce exposure (WR-12) or tighten checks (WR-08), but I did not re-run the security audit.

### Human Verification Required

#### 1. Two real windows and a stalled remote

**Test:** Run `NEAR AI: Enable Team Mode` in one VS Code window, open the second clone in another window and let it sync, then make the remote unreachable (unknown host) and separately stalled (a listener that accepts and never answers).
**Expected:** The second window shows the team and roster; the status bar shows `Team sync paused: remote unreachable` on failure, including the stalled case after at most about 60 s, and recovers to `Team: <name>` when the remote returns.
**Why human:** Tests use two clients on real git through a vscode stub, not two editor windows. The stalled path is proven in pieces (the CR-01 regression test, my independent real-git stall check showing a settle at the timeout, and the 124-to-offline classification and status text tests) but no test chains a stalled fetch through `TeamSession` to the status bar, and real editor windows are not exercised. This is the only open item, and it is the UAT test 1 already recorded in `60-UAT.md` (UAT test 2, the CR-01 decision, can now be closed as "fixed").

### Gaps Summary

No must-have failed and there are no `gaps:` for gap-closure planning. CR-01 is fixed, with a regression test and an independent real-git confirmation, so the previous accept-or-fix decision item is closed. The phase is ready to proceed once the manual two-window and stalled-network check is done (or explicitly waived by the owner).

---

_Verified: 2026-11-01_
_Verifier: Claude (gsd-verifier)_
