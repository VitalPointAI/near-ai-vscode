---
phase: 60-team-core-identity-signed-event-log-git-transport-roster
reviewed: 2026-11-01T00:00:00Z
depth: standard
files_reviewed: 23
files_reviewed_list:
  - package.json
  - src/domain/approval.ts
  - src/domain/team/canonical.ts
  - src/domain/team/materialize.ts
  - src/domain/team/permissions.ts
  - src/domain/team/policy.ts
  - src/domain/team/secrets.ts
  - src/domain/team/types.ts
  - src/domain/team/validate.ts
  - src/extension.ts
  - src/services/auditStore.ts
  - src/services/team/teamCommands.ts
  - src/services/team/teamSession.ts
  - src/services/team/teamStatusBar.ts
  - src/team/auditMirror.ts
  - src/team/enable.ts
  - src/team/eventLog.ts
  - src/team/gitTransport.ts
  - src/team/identity.ts
  - src/team/runGit.ts
  - src/team/syncScheduler.ts
  - src/team/teamFile.ts
  - src/team/transport.ts
findings:
  critical: 1
  warning: 12
  info: 6
  total: 19
status: issues_found
---

# Phase 60: Code Review Report

**Reviewed:** 2026-11-01
**Depth:** standard
**Files Reviewed:** 23
**Status:** issues_found

## Summary

The pure domain layer (canonical JSON, schema validation, permission matrix, materialiser, secret guard) is carefully built: the validation pipeline is ordered correctly, hostile-key handling is sound, positional device binding and the genesis anchor behave as described, and I found no way to forge or reorder accepted state from the log alone. The defects are concentrated at the edges where the pure core meets processes, I/O and the editor: git subprocess lifecycle, the Enable rollback path, error handling in the session and sync composition, and a few contracts that are frozen into signed data now but are version-fragile or unverified (`prev`, the snapshot state hash).

The two already-recorded advisories (A1 trust pin keyed by team id, A2 snapshot parsing has no production caller) are not re-reported. A2 does have one related forward-looking item (WR-07) that matters before a snapshot fast path is wired, because it concerns what is hashed, not who calls the parser.

No structural (fallow) findings were supplied for this run.

Scope notes: `approval.ts`, `auditStore.ts`, `extension.ts` and `package.json` were reviewed as phase-60 diffs only. Those diffs are correct and minimal (one union member, one allow-list entry, one registration call, two commands and one bounded application-scope setting). No findings against them.

## Critical Issues

### CR-01: `runGit` does not settle on timeout when git leaves a child process holding its pipes, which wedges all Team sync

**File:** `src/team/runGit.ts:53-67`
**Issue:** On timeout the code sends `SIGKILL` to the `git` process only and then waits for the `close` event to resolve. `close` fires only after every stdio stream has closed. `git fetch` and `git push` spawn helpers (`git-remote-https`, `ssh`) that inherit the stdout and stderr pipes. Killing the parent leaves those helpers alive, so the pipes stay open and `close` never fires. I reproduced the mechanism with `sh -c 'sleep 6 & wait'`, killing `sh` at 500 ms: the `close` event had still not fired at 2 s, so the promise would not settle until the grandchild exits. The stalled-connection case that triggers the timeout is the exact case where the helper keeps running.

The consequence is severe because every `fetch`, `readAll` and `append` runs inside `withMirrorLock` (`gitTransport.ts:92-106`). A `GitRunner` promise that never settles means the lock is never released. All later syncs queue behind it. The scheduler's `inFlight` also never clears, so no further polls run. The status bar stays at its last value and nothing is logged. Only a window reload recovers.

**Fix:** Settle from the timer instead of waiting for `close`, and kill the whole process group so the helpers die too.
```ts
const child = spawn('git', args, { cwd: options.cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: [...] });
const timer = setTimeout(() => {
  timedOut = true;
  try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); }
  // Do not wait for close: a helper may still hold the pipes.
  finish(() => resolve({ code: TIMED_OUT_CODE, stdout: Buffer.concat(out), stderr: `git timed out after ${timeoutMs} ms` }));
}, timeoutMs);
```
Also call `child.stdout?.destroy()` and `child.stderr?.destroy()` after settling so late data is not buffered.

## Warnings

### WR-01: Enable deletes the device key when an ambiguous push could not be confirmed either way

**File:** `src/team/enable.ts:236-251`
**Issue:** `appendGenesis` returns `kind: 'offline'` when the push produced no ref line (timeout, dropped connection), which by the code's own comment "may still have landed". Enable then calls `transport.fetch()` to find out. But `fetch()` does not throw when the remote is unreachable: it sets status `offline` and returns `[]`. So in the very situation that caused the ambiguity (network trouble), `landed` stays `false` and the code runs `rollback`, which forgets the device key and removes the mirror, and tells the user "Nothing was kept on this computer". If the push did land, the remote now holds a coordination log whose only owner key was destroyed. A later Enable is also blocked by `exists-remotely`. Only the throw path sets `fetchProblem`; the offline path is treated as "not landed".
**Fix:** Treat an unconfirmed fetch as unknown, not as failure. After `transport.fetch()`, check `transport.status().state`. If it is not `ok`, keep the key and mirror and return a distinct result that names the ambiguity and the manual step (for example, check whether `refs/heads/near-ai/coordination` exists on the remote, then re-run). Only roll back on a definite failure (`remote-rejected`, `refused`, or a successful fetch that shows the branch is absent).

### WR-02: A throw from `transport.append` during Enable leaves the device key and mirror behind

**File:** `src/team/enable.ts:231`
**Issue:** `createDeviceIdentity` stores the private key at line 208. The genesis `transport.append` at line 231 is not inside a `try`. `appendGenesis`, `ensureMirror`, `commitFiles` and `mustSucceed` all throw on filesystem or git errors (EACCES creating the mirror, `GitNotFoundError` mid-run, `GitCommandError`). A throw skips every `rollback` call, so an unreferenced device key stays in SecretStorage, the mirror directory stays on disk, and the command surfaces a generic error.
**Fix:** Wrap the append (and the whole block from key creation to the pushed check) in `try { ... } catch (error) { const problems = await rollback(...); throw/return fail('push-failed', ...) }`, subject to the WR-01 rule that an ambiguous outcome keeps the key.

### WR-03: One unexpected throw permanently poisons the `TeamSession.sync` chain

**File:** `src/services/team/teamSession.ts:198-202`
**Issue:** `sync()` builds `run = this.syncing.then(() => this.syncOnce())` and then stores `this.syncing = run.then(() => undefined)`. If `syncOnce` ever rejects, `this.syncing` is a rejected promise and every later `sync()` call does `this.syncing.then(...)`, which skips `syncOnce` and returns the same old rejection. The doc comment says "It never rejects", but `syncOnce` has code outside its `try`: `showStatus` (line 292, status bar and output channel calls) and `mirror`'s non-guarded parts. Any throw there (for example `appendLine` on a channel torn down during deactivation) kills syncing for the life of the session. The scheduler only sees repeated rejections of a stale error, and the output line is de-duplicated so it looks like one failure.
**Fix:** Make the chain tail non-rejecting and keep the caller's result:
```ts
const run = this.syncing.then(() => this.syncOnce());
this.syncing = run.then(() => undefined, () => undefined);
return run;
```
Also move `showStatus` and `mirror` inside the same try, or catch around them.

### WR-04: A failed snapshot write loses the entries the same sync already applied

**File:** `src/team/eventLog.ts:179-193` (consumed at `src/services/team/teamSession.ts:280-284`)
**Issue:** `TeamLog.sync()` fetches (which advances the transport's `lastProcessed` and applies entries to state), builds `accepted` and `rejected`, and then awaits `maybeWriteSnapshot()` with no guard. If the snapshot append throws (a `GitCommandError` from `commitFiles`, a `SecretLeakError` from `prepareEvents`, a filesystem error), `sync()` throws and the already-collected `accepted` and `rejected` lists are discarded. Because the transport has already advanced, the next fetch does not return those entries again. In the session, roster events from that fetch are never queued for the audit mirror and their rejections are never reported until the next full replay on restart. An owner or lead client whose snapshot write keeps failing would drop events on every affected sync.
**Fix:** Isolate the snapshot step so it cannot discard read results:
```ts
let snapshot: AppendResult | undefined;
try { snapshot = await this.maybeWriteSnapshot(); }
catch (error) { snapshot = { ok: false, kind: 'refused', reason: error instanceof Error ? error.message : String(error), attempts: 0 }; }
```

### WR-05: Roster audit entries record the author's final role, not the role at that log position

**File:** `src/services/team/teamSession.ts:338-345` (uses `src/team/auditMirror.ts:73-79`)
**Issue:** `mirror()` builds `roleOf` from `this.log.state().members`, the state after the whole sync. On a session start the entire history replays and is mirrored in one batch, so every historical entry is stamped with each author's current role. An event written by a lead who was later demoted is recorded as written by a developer (or as an owner event for any later promotion). The audit log is meant to record who could do what when (D-26), so this misstates history. The same applies to later batches that contain both a role change and later events by that member.
**Fix:** Capture the role at apply time. For example, have the materialiser verdict carry `authorRole` (read from `state.members.get(event.author)?.role` just before `applyTransition`), or have `TeamLog.sync` record it in a `Map<eventId, Role>` while iterating entries, and pass that map to `mirrorRosterEvents`.

### WR-06: A refused coordination log still shows a healthy "Team: name" status

**File:** `src/services/team/teamSession.ts:276-295`, `src/services/team/teamStatusBar.ts:294-307`
**Issue:** When the first event does not match the genesis anchor, the materialiser sets `state.refused` and rejects every entry. The transport status stays `ok`, `syncOnce` reports `status.state === 'ok'` as healthy, and the status bar shows "Team: <name>" with the tooltip "Team sync is working." The only signals are one output-channel line per rejected entry and the Verify report. This is the central trust failure the anchor exists to catch (wrong or swapped team), and the main UI says everything is fine. `SyncResult` does not carry `refused` at all.
**Fix:** After each sync, read `this.log.state().refused`. If set, show a distinct paused status (for example "Team log not trusted"), return `false` from `syncOnce` so the scheduler backs off, and raise one warning notification.

### WR-07: The snapshot state hash covers version-dependent fields, so mixed-version teams will reject each other's snapshots

**File:** `src/domain/team/materialize.ts:273-295` (checked at `:142-148`)
**Issue:** `stateHash` hashes the full serialised state including `rejected`, `accepted`, `seenEventIds`, `snapshots` and `head`. A `snapshot.written` event is valid only if its `stateHash` equals the reader's own hash at that position. A client that does not understand a newer event type records it in `rejected` with the "unsupported" reason and does not count it in `accepted` or `seenEventIds`. From that point its hash can never equal the hash computed by a newer client. It rejects every later `snapshot.written` as `snapshotMismatch`, which in turn leaves its `snapshots` list different, so the divergence is permanent. This directly undercuts D-07 (older clients must keep working past events they do not understand). Even within one version, any injected junk file between a manager computing the snapshot and the event landing changes `rejected` and invalidates the snapshot.

The hashed shape and the signed `snapshot.written` body are permanent once shipped, so this is cheapest to fix now.
**Fix:** Hash only the semantically derived, version-stable parts (team, members, deviceIndex, head, highLamport, and the Phase-N domain maps), and exclude `rejected`, `accepted`, `seenEventIds` and `snapshots` from the hashed form (keep them in the snapshot file only if needed, outside the hash). Version the hash input so later phases can extend it deliberately.

### WR-08: The signed `prev` field is never checked, so it adds no integrity

**File:** `src/domain/team/materialize.ts:213-244`, `src/domain/team/validate.ts:75`
**Issue:** `prev` is required, pattern-checked and signed, and the writer fills it with the head id (`eventLog.ts:84-109`). The reader never compares it to the log position. An event whose `prev` points anywhere (or at an event from another position) is accepted as long as lamport, signature and permission pass. Because the field looks like a hash-chain link, later code and reviewers may assume ordering or tamper evidence that does not exist.
**Fix:** In `applyEntry`, after the signature step, require `event.prev === state.head.eventId` (genesis: `''`) and reject with a fixed reason. The CAS append already guarantees a linear log, and the writer derives `prev` from accepted head only, so honest writers satisfy this. If you decide it must stay advisory, say so in `types.ts` and `60-CONTEXT.md` so nobody relies on it.

### WR-09: Enable fails with a misleading error for valid git branch names, and the two branch validators disagree

**File:** `src/domain/team/policy.ts:24,96-98`, `src/team/enable.ts:189-191`, `src/team/teamFile.ts:63-68`
**Issue:** `defaultTeamPolicy` takes the current branch (when there is no `main`) as the integration branch, and `validatePolicy` then checks it against `BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/`. Valid git branch names containing `+`, `@`, `#`, `~`, `,` or non-ASCII letters, or longer than 128 characters, fail with "The integration branch name is not valid." and the user has no prompt to change it (`teamCommands.ts` passes `defaults.integrationBranch` straight through). The reverse also holds: the pattern accepts names git rejects (`a//b`, `release.lock`, trailing `/`, a component starting with `.`), because `isIntegrationBranch` lacks the extra checks that `validRef` in `teamFile.ts` has. The branch name is signed into the genesis policy, so a bad one is permanent.
**Fix:** Share one validator that mirrors git's rules (`git check-ref-format --branch` semantics) and broaden the accepted alphabet. In Enable, if the default is rejected, fall back to `main` or ask the user, rather than failing the whole flow.

### WR-10: A missing coordination branch on the remote is reported as healthy even after a trusted log existed

**File:** `src/team/gitTransport.ts:482-488`
**Issue:** `classifyGitFailure` maps "couldn't find remote ref" to `absent`, and `fetchLocked` then sets status `ok` and returns `[]` without looking at `LOCAL_REF` or the pin. If the branch was deleted on the remote (a rewrite in the strongest form), clients keep showing "sync working" on stale state. D-33 intends a visible pause for a rewritten log; deletion is not distinguished from "never created". A later re-creation is caught by the ancestry check, but the window in between is silent.
**Fix:** In the `absent` case, if a `LOCAL_REF` or a pin exists, set status `paused` (or `offline` with a "branch missing on remote" reason) instead of `ok`.

### WR-11: The audit mirror progress mark lives in per-team global storage, so a second clone of the same team never receives roster entries

**File:** `src/services/team/teamSession.ts:344`, `src/team/auditMirror.ts:31-58`
**Issue:** `fileMirrorMark(this.storage)` writes `audit-mark.json` under `<globalStorage>/team/<teamId>/`, which is shared by every checkout or worktree of the same team on this machine, but the audit log it protects is per project (`<projectRoot>/.planning/.near-ai/audit.json`). After the first checkout mirrors up to lamport N, a second checkout (another clone, a worktree, or the same project re-cloned after its audit file was deleted) reads the mark, filters out everything at or below N, and never writes those entries into its own audit file.
**Fix:** Key the mark by project, for example `audit-mark.<sha256(projectRoot).slice(0,16)>.json`, or store it beside the audit file. Keep the idempotency check against `sink.list` as the second guard.

### WR-12: The remote URL, which may embed credentials, is passed on git's command line

**File:** `src/team/gitTransport.ts:455,658,712` (URL read at `:351`)
**Issue:** The code reads the push URL fresh each time precisely so it is "never stored or returned" (D-34), then passes it as an argv entry to `git fetch` and `git push`. Command-line arguments are readable by other local users via `ps` or `/proc/<pid>/cmdline`. For `https://user:token@host/...` remotes this exposes the credential for the duration of every poll (every 15 s while focused). Redaction of error text does not cover this path.
**Fix:** Pass the URL through the environment instead of argv, using git's config-via-environment (git 2.31 and later):
```ts
env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.team.url', GIT_CONFIG_VALUE_0: url, ...otherEnv }
// then: ['fetch', '--no-tags', '--quiet', 'team', `+${ref}:${INCOMING_REF}`] and ['push', '--porcelain', 'team', ...]
```
Environment variables of a process are readable only by the same user. Keep a fallback for older git if needed.

## Info

### IN-01: Event timestamps are format-checked only, and the audit mirror records the author's claimed time

**File:** `src/domain/team/validate.ts:16`, `src/team/auditMirror.ts:78`
**Issue:** `AT_PATTERN` accepts impossible values such as `2026-99-99T99:99:99Z`. `toRosterAuditEvent` copies `event.at` into the audit entry's `timestamp`, so any member can backdate or future-date their own audit rows, and the audit store's `from`/`to` string filters will place them wrongly.
**Fix:** Validate that `at` parses to a real date (`Number.isFinite(Date.parse(value))` and round-trips), and stamp the audit row with the local receipt time, keeping the author's `at` in metadata.

### IN-02: Email hashes are salted with a public value, so they can be confirmed by dictionary

**File:** `src/team/identity.ts:107-110`
**Issue:** `emailHash` is `sha256(teamId + ":" + email)`. The team id is public (it is in `team.json` and in every event), so anyone with the log can test candidate addresses offline. The UI text "stored only as a salted hash" overstates the protection.
**Fix:** Either state the real property plainly ("can be matched against a known address") or use a secret per-team salt that is not published (which would need a join-time exchange, so this may be a later-phase decision).

### IN-03: Reads use the push URL

**File:** `src/team/gitTransport.ts:351`
**Issue:** `git remote get-url --push` is used for both `fetch` and `push`. Projects that fetch from a read mirror and push elsewhere will read the coordination log from the push endpoint only.
**Fix:** Resolve the fetch URL with `git remote get-url` for fetch and `--push` for push.

### IN-04: `update-ref LOCAL_REF` has no old-value guard across windows

**File:** `src/team/gitTransport.ts:515`
**Issue:** `withMirrorLock` serialises within one process only. Two windows on the same mirror can race: window A, holding an older fetched head, can move `LOCAL_REF` backwards after window B advanced it. The ancestry check keeps this safe from false rewrite alarms, but B's next append then builds on an older parent and loses the CAS race unnecessarily.
**Fix:** `update-ref LOCAL_REF <head> <previous-local-or-zero-oid>` so a stale writer fails cleanly and retries.

### IN-05: The status tooltip blames the remote for any sync failure

**File:** `src/services/team/teamSession.ts:287-291`, `src/services/team/teamStatusBar.ts:301-306`
**Issue:** An unexpected local exception in `syncOnce` is turned into `{ state: 'offline', reason }`, and `statusText` renders every non-`ok`, non-rewritten state as "Team sync paused: remote unreachable". A local bug or full disk looks like a network problem.
**Fix:** Add a separate `error` state (or flag) for non-network failures with its own text.

### IN-06: `commitFiles` drops the original failure when cleanup also fails

**File:** `src/team/gitTransport.ts:742-747`
**Issue:** If removing the temporary index fails after an earlier failure, the thrown error has `cause: failure ?? error`, so the cleanup failure is lost and the message names only the cleanup problem while the real git failure is only the cause.
**Fix:** Throw the original `failure` and attach the cleanup error as its `cause` (as `withCleanupFailure` in `teamFile.ts` already does).

---

_Reviewed: 2026-11-01_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
