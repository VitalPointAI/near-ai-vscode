---
phase: 60-team-core-identity-signed-event-log-git-transport-roster
fixed_at: 2026-11-01T00:00:00Z
review_path: .planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-REVIEW.md
iteration: 1
findings_in_scope: 13
fixed: 13
skipped: 0
status: all_fixed
---

# Phase 60: Code Review Fix Report

**Fixed at:** 2026-11-01
**Source review:** .planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 13 (CR-01, WR-01 to WR-12; Info findings IN-01 to IN-06 are out of scope for `critical_warning`)
- Fixed: 13 (WR-01 and WR-02 share one commit because they are one function)
- Skipped: 0

**Verification (ran in the linked worktree `.claude/worktrees/team-mode`, not a nested review-fix worktree, as instructed):**
- `npm run lint` (tsc --noEmit): clean.
- `npm test`: 939 tests, 931 pass, 0 fail, 8 skipped (the same 8 environment skips as before: ripgrep, LibreOffice, Open-GSD runtime, live NEAR AI tests). Baseline was 918 tests, 0 failing; 21 regression tests were added.
- Focused suites were run after every fix. Regression tests for CR-01 and WR-08 were also confirmed to fail with the fix removed.

Fixes that change logic are marked "requires human verification" below, because syntax and test checks cannot prove a condition is semantically right.

## Fixed Issues

### CR-01: `runGit` does not settle on timeout when git leaves a child process holding its pipes, which wedges all Team sync

**Files modified:** `src/team/runGit.ts`, `src/test/teamRunGit.test.ts` (new)
**Commit:** 53b3fc6
**Status:** fixed: requires human verification (process-group handling is platform specific; Windows keeps the old single-process kill)
**Applied fix:** On POSIX git is spawned `detached` (its own process group). On timeout the whole group gets `SIGKILL` (fallback to `child.kill`), and the promise is settled from the timer with exit code 124 and the usual message, then `stdout`/`stderr` are destroyed. `close` no longer matters after a timeout, and the now-unused `timedOut` flag was removed.
**Regression test:** a fake `git` shell script (first on `PATH` through `options.env`) starts `sleep 30` as a background helper that inherits the pipes, records its pid and waits. With `timeoutMs: 400` the test asserts code 124, settlement well under 5 s (without the fix it takes the full 30 s), and that the helper pid is dead within 3 s. Deterministic and about 0.4 s. A second test checks a normal `git --version` still returns its output. The first test is skipped on Windows.

### WR-01: Enable deletes the device key when an ambiguous push could not be confirmed either way

(Fixed together with WR-02 in the same commit; see below.)

### WR-02: A throw from `transport.append` during Enable leaves the device key and mirror behind

**Files modified:** `src/team/enable.ts`, `src/test/teamEnable.test.ts`
**Commit:** 6c5a470
**Status:** fixed: requires human verification (rollback decision logic)
**Applied fix:** The genesis write moved into `pushGenesis`, which wraps the append in `try/catch`. Outcomes:
- `exists`, or any definite non-offline failure (`refused`, `remote-rejected`, ...): roll back as before.
- An `offline` result (push produced no ref line) or a throw: ask the remote. `transport.fetch()` followed by a check that `transport.status().state === 'ok'`; then "head is our member.joined event" means landed, otherwise a definite failure (roll back). If the status is not `ok`, the outcome is unknown.
- If the confirming fetch itself throws (for example an unusable mirror folder), `git ls-remote --exit-code` is asked directly: exit 2 means definitely absent (roll back); anything else is unknown.
- Unknown now returns a new failure code `push-unconfirmed`: the device key and the mirror are kept, and the message names the manual check (`git ls-remote <remote> refs/heads/near-ai/coordination`) and says to keep this computer's NEAR AI data if the branch exists, because the key is the only owner key.
`teamCommands.ts` needed no change: it reports every code other than `commit-failed` as an error with the message text.
**Behaviour note:** a network-down failure (push offline and fetch offline) used to roll back and now keeps an unused key and mirror, as the review asked. Re-running Enable creates a fresh team id; the abandoned key is the cost of never destroying the only owner key.
**Regression tests:** push may have landed with fetch failing keeps the key and the mirror (`push-unconfirmed`); a throw on push and fetch with the remote answering "absent" rolls everything back; a push that lands and then throws is detected and Enable finishes. The existing "failed genesis push" and "lost reply but landed" tests pass unchanged.

### WR-03: One unexpected throw permanently poisons the `TeamSession.sync` chain

**Files modified:** `src/services/team/teamSession.ts`, `src/test/teamSession.test.ts`
**Commit:** 7cdb3f7
**Applied fix:** `sync()` now catches any rejection from `syncOnce`, reports it once as "Team sync failed unexpectedly: ..." (guarded in case the output channel itself throws), and returns `false` (so the scheduler backs off). The chain tail was already non-rejecting in effect; the result promise never rejects, as the doc comment says. This is slightly stronger than the review's snippet, which still rejected to the caller.
**Regression test:** a status bar whose `update` throws once; the sync resolves `false`, the next sync resolves `true` and both reached the remote.

### WR-04: A failed snapshot write loses the entries the same sync already applied

**Files modified:** `src/team/eventLog.ts`, `src/test/teamLog.test.ts`
**Commit:** 63d16d6
**Applied fix:** New private `trySnapshot()` turns a throw from `maybeWriteSnapshot` into a `{ ok: false, kind: 'refused', reason, attempts: 0 }` result and records it in `lastSnapshot()`. It is used in `sync()` and, for the same reason, in `append()` (a snapshot throw after a successful append used to make a landed append look failed).
**Regression test:** an owner client whose `commit-tree` throws, syncing five pending entries with a snapshot due: `sync()` returns all five accepted events plus a failed snapshot result carrying the message, and a second `fetch()` returns nothing (proving the entries would have been lost).

### WR-05: Roster audit entries record the author's final role, not the role at that log position

**Files modified:** `src/domain/team/types.ts`, `src/domain/team/materialize.ts`, `src/team/eventLog.ts`, `src/team/auditMirror.ts`, `src/services/team/teamSession.ts`, `src/test/teamMaterialize.test.ts`, `src/test/teamAudit.test.ts`
**Commit:** c8f48fc
**Status:** fixed: requires human verification
**Applied fix:** The accepted `EntryVerdict` gained an optional `authorRole`, read in `applyEntry` before `applyTransition` (genesis uses the owner's role). `SyncResult` gained `authorRoles` (event id to role). `TeamSession` stores the role per queued roster event and passes it to `mirrorRosterEvents`, whose `roleOf` callback is now `(memberId, event) => Role | undefined` (existing one-argument callers still type-check and the tests using them are unchanged). Roles are dropped from the session map once mirrored.
**Regression tests:** a lead who is later demoted yields `lead` then `developer` verdicts; `mirrorRosterEvents` records the role given per event instead of a single final lookup. The existing session audit test still sees `owner` through the new wiring. Note: Phase 60 logs cannot yet contain a non-owner author, so this is latent until later phases add joins; it is covered at the materialiser and mirror level.

### WR-06: A refused coordination log still shows a healthy "Team: name" status

**Files modified:** `src/services/team/teamSession.ts`, `src/services/team/teamStatusBar.ts`, `src/test/teamSession.test.ts`
**Commit:** 3e902df
**Applied fix:** After each sync, `syncOnce` reads `this.log.state().refused`. If set while the transport says `ok`, the status becomes `{ state: 'paused', reason: logRefused }`, the status bar shows "Team log not trusted" with a tooltip that carries the refusal reason, one warning notification is raised per session, and `syncOnce` returns `false` so the scheduler backs off.
**Regression test:** a session started with a team file whose genesis event id does not match the remote (fresh storage so the trust pin does not intervene): status text, tooltip (no "Team sync is working"), one warning only across two syncs, `false` return, no "sync is running" line.

### WR-07: The snapshot state hash covers version-dependent fields, so mixed-version teams will reject each other's snapshots

**Files modified:** `src/domain/team/materialize.ts`, `src/test/teamMaterialize.test.ts`, `src/test/helpers/teamEvents.ts` (comment only)
**Commit:** f1a4ddf
**Status:** fixed: requires human verification (signed/hashed format change)
**FORMAT CHANGE:** `stateHash(state)` is now `sha256(canonicalize({ hashVersion: 1, ...plainState }))` where `plainState` has `accepted`, `seenEventIds`, `rejected` and `snapshots` removed. Still hashed: `team`, `members`, `deviceIndex`, the later-phase maps, `stopped`, `head`, `highLamport`, `genesis` (and `refused` when set). `STATE_HASH_VERSION = 1` is exported so a later phase extends the hashed shape deliberately. `serialiseState`, the snapshot file shape and `deserialiseState` (which still requires and cross-checks the unhashed fields) are unchanged. No snapshot has shipped, so there are no old hashes to migrate.
**Why not more:** `head` and `highLamport` stay in the hash as the review asked, and `snapshot.written` is still checked against `coversThrough`/`lamport`. An older client that skipped a newer event type still has a different head and will still not match; this fix removes the bookkeeping divergence (rejected junk, counters, earlier snapshots), not the head divergence.
**Caution for the future snapshot fast path (A2):** the four excluded fields are no longer authenticated by the hash; they are covered only by the manager's snapshot-file signature plus the consistency checks in `deserialiseState`. A consumer that trusts a snapshot should recompute them by replay or treat them as advisory.
**Tests:** every existing determinism, forgery, snapshot and scenario test passed unchanged. The only edits to existing tests are two comments that said the hash covers `state.rejected`. New tests: rejected entries (unsupported type and forged signature), bumped counters and extra snapshot refs leave the hash unchanged, and a snapshot computed by a reader without the junk is accepted by one with it; members, policy, head, highLamport, later-phase fields and the hash version still change the hash.

### WR-08: The signed `prev` field is never checked, so it adds no integrity

**Files modified:** `src/domain/team/types.ts`, `src/domain/team/materialize.ts`, `src/test/teamMaterialize.test.ts`
**Commit:** 4f1752e
**Status:** fixed: requires human verification (signed data rule change)
**FORMAT CHANGE:** after the signature step, `applyEntry` rejects any event whose `prev` is not the head event id at that position, with the new fixed reason `TEAM_REJECTION_REASONS.prevMismatch` ("prev does not name the log head"). A genesis `team.created` whose `prev` is not `''` now refuses the log. Honest writers already satisfy this: `buildGenesisEvents` and `prepareEvents` derive `prev` from the accepted head and chain within a batch, and the CAS append re-derives it after every lost race. The `TeamEvent` type carries a comment saying `prev` is enforced.
**Tests:** no existing test needed changing (all helpers already used the head id). New tests cover an empty link, an older event id and an unknown id (all rejected, head unmoved, a correct link still accepted afterwards) and a validly signed genesis with a non-empty `prev`. Both fail with the check removed.
**Known limit:** an older client that rejects an unknown event type writes `prev` from its own (older) head, which a newer reader will reject. That client already fails the Lamport check against the same log, so D-07 behaviour for older writers is unchanged.

### WR-09: Enable fails with a misleading error for valid git branch names, and the two branch validators disagree

**Files modified:** `src/domain/team/policy.ts`, `src/team/teamFile.ts`, `src/team/enable.ts`, `src/test/teamValidate.test.ts`, `src/test/teamEnable.test.ts`
**Commit:** f167d6a
**Status:** fixed: requires human verification (signed policy field rule)
**FORMAT CHANGE (read side):** the `integrationBranch` check in signed policy is now `isGitRefName`, exported from `policy.ts`. It follows `git check-ref-format --branch`: any characters git allows (letters from any script, `+`, `@`, `#`, `,`, and so on) up to 255 characters, but not `..`, `@{`, `//`, a leading or trailing `/`, a trailing `.`, a leading `-`, a lone `@`, a component starting with `.` or ending in `.lock`. It also rejects control characters, spaces and invisible/bidi format characters (`U+200B..200F`, `U+2028..202E`, `U+2060..2064`, `U+2066..206F`, `U+FEFF`) so a signed name cannot spoof what a person reads. The old pattern capped names at 128 ASCII characters. `teamFile.ts` `validRef` now applies the same shared rules on top of its ASCII coordination-ref pattern, replacing its own copy of the component checks. `enableDefaults` falls back to `main` when the current branch would be refused (for example a branch with a zero-width character), so Enable does not fail on a name the user never chose.
**Tests:** `isGitRefName` is compared with the real `git check-ref-format --branch` over a corpus of 35 names (valid and invalid, ASCII and not); the beyond-git rules and the policy validator are asserted; Enable succeeds with a branch `feature/c++#1@café` and falls back to `main` for a zero-width branch. Existing branch tests (`feature/../main`, `-bad`, `has space`) are unchanged and pass.

### WR-10: A missing coordination branch on the remote is reported as healthy even after a trusted log existed

**Files modified:** `src/team/transport.ts`, `src/team/gitTransport.ts`, `src/services/team/teamStatusBar.ts`, `src/test/teamGitTransport.test.ts`, `src/test/teamSession.test.ts`
**Commit:** faabc43
**Status:** fixed: requires human verification
**Applied fix:** In `fetchLocked`, an `absent` failure is normal only when this client has never read the branch (no saved position and no `LOCAL_REF`). Otherwise the status is `offline` with the new exported `BRANCH_MISSING_REASON`. I chose `offline` rather than `paused` on purpose: `paused` is sticky (a rewrite must never be followed), whereas a deleted-then-restored branch should resume by itself, and the ancestry check still runs when it returns. The status bar shows "Team sync paused: log missing on remote".
**Tests:** transport level (read, delete on remote, offline with the reason and last good state kept, a never-read client still `ok`, restore and recover) and session level (status text, no "working" tooltip, recovery).

### WR-11: The audit mirror progress mark lives in per-team global storage, so a second clone of the same team never receives roster entries

**Files modified:** `src/team/auditMirror.ts`, `src/services/team/teamSession.ts`, `src/test/teamSession.test.ts`
**Commit:** 335b844
**Applied fix:** `fileMirrorMark(storageDir, scope?)` writes `audit-mark.<scope>.json`; the session passes `projectMarkScope(projectRoot)` (first 16 hex characters of the sha256 of the resolved project path). Without a scope the file name is unchanged, so `teamAudit` tests and the mark unit tests are untouched. The `sink.list` id check remains the second guard, so an old shared `audit-mark.json` is simply ignored and a first pass is deduplicated.
**Existing tests edited (and why):** the two session tests that read or checked `audit-mark.json` now compute the per-project file with the exported helpers. The second of them asserted the mark file does not exist after a failed audit write; with the old name that would have become trivially true, so it had to follow the fix.
**New regression test:** a second clone with the same global storage and team id gets its own two audit rows; the first checkout is not written twice.

### WR-12: The remote URL, which may embed credentials, is passed on git's command line

**Files modified:** `src/team/gitTransport.ts`, `src/test/teamGitTransport.test.ts`
**Commit:** 74ef837
**Status:** fixed: requires human verification (cannot be exercised against a real credentialed remote here)
**Applied fix:** `networkTarget(url)` returns a process-local remote name (`near-ai-team`) and an environment with `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` set to `remote.near-ai-team.url=<url>` (the index starts after any `GIT_CONFIG_COUNT` the user's environment already has). `fetch`, both `push` calls and the genesis `ls-remote` use the name; nothing is written to the mirror's config. Support is detected once with `git --version` (2.31 or later); an older git, or an unparsable version, falls back to the previous argument form.
**Tests:** a recording runner shows ls-remote, push and fetch carry no argument containing the remote URL and carry the three config variables in the environment, and the mirror's local config does not contain the URL; a runner that reports `git version 2.30.2` shows the argument fallback is used and the flow still works. All earlier transport, concurrency and session tests pass unchanged. Redaction of error text is unchanged.

## Skipped Issues

None.

## Notes for the reader

- IN-01 to IN-06 were out of scope (`fix_scope: critical_warning`) and were not changed. IN-03 (read versus push URL) is now easier to address because every network call goes through `networkTarget`.
- No existing assertion encoding buggy behaviour had to be changed other than the two session-test mark-file paths (WR-11) and two explanatory comments (WR-07).
- Files outside the phase's team code that were touched: none. `package.json` and dependencies are unchanged. `.planning/config.json` and `.planning/state.json` carry the orchestrator's uncommitted changes and were not modified or committed by this run.

---

_Fixed: 2026-11-01_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
