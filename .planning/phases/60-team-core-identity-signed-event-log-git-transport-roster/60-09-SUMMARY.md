---
phase: 60-team-core-identity-signed-event-log-git-transport-roster
plan: 09
subsystem: team
tags: [scheduler, backoff, status-bar, output-channel, verify-log, audit-mirror, vscode-adapter, redaction]

requires:
  - phase: 60-03
    provides: "GitTransport status, onDiagnostic and redactGitMessage"
  - phase: 60-06
    provides: "checkTrustPin, teamStorageDir, mirrorRosterEvents, fileMirrorMark"
  - phase: 60-07
    provides: "TeamLog.sync, verifyAll, VerifyReport"
provides:
  - "SyncScheduler: VS Code-free polling with focus-aware intervals, single flight, nudge and exponential backoff to 10 minutes"
  - "createTeamStatusBar and statusText: Team: <name>, Team sync paused: remote unreachable, Team sync paused: log rewritten"
  - "TeamSession.start and createVscodeTeamSession: trust pin, transport, TeamLog, scheduler, roster audit mirror and the NEAR AI Team output channel"
  - "formatVerifyReport and TeamSession.verifyLog: the Verify Team Log report and summary notification"
  - "projectAuditSink: roster audit sink that confirms every entry on disk"
  - "vscodeStub test helper installed through Module._load for a whole test file"
affects: [60-10, 60-11, 61]

actuals:
  tokens: 18227
  tasks: 2
  commits: 4
plan_head_before: 24ff40de7cb094240e1089b7b4c7323c0820ef6f
plan_head_after: 753a6018f029103ba0a326ee6b566fd425530c0d

tech-stack:
  added: []
  patterns:
    - "Scheduler owns WHEN, the session owns WHAT: run() returns healthy or not, errors go to onError, nothing is dropped"
    - "Held-until-stored queue: accepted roster events stay in the session until the audit mirror has really stored them"
    - "Same failure written once until it changes or clears, so a remote that stays down does not fill the channel every poll"
    - "Fresh AuditStore per mirror attempt plus read-back from audit.json, because AuditStore.persist swallows write errors"

key-files:
  created:
    - src/team/syncScheduler.ts
    - src/services/team/teamStatusBar.ts
    - src/services/team/teamSession.ts
    - src/test/teamScheduler.test.ts
    - src/test/teamSession.test.ts
    - src/test/helpers/vscodeStub.ts
  modified: []

key-decisions:
  - "A failure never shortens a poll interval: the delay after failures is max(base, min(600000, base * 2^failures)), so a 3600 s poll stays 3600 s"
  - "TeamSession.start waits for the scheduler's first run instead of syncing twice; the scheduler's start() invokes run synchronously, which the single-fetch assertion in the test pins"
  - "The signer is adopted after the first sync by matching this computer's device fingerprint to a roster member, because the member id is only known once the log has been read; a key that matches no member keeps the session read-only"
  - "Accepted roster events wait in a session queue until mirrorRosterEvents succeeds, since a later sync would not hand them over again"
  - "Rejected events are deduplicated by event id plus reason, so a replayed id with a different reason is still shown"
  - "The session disposes the status bar it was given, so one dispose call tears everything down"

patterns-established:
  - "Text from the remote (names, event ids, paths, reasons) goes through safeReason: redactGitMessage, control characters flattened, 400 character cap"
  - "Tests for vscode adapters install the stub at file top and require the adapter modules lazily"

requirements-completed: [TEAM-04, SEC-01]

coverage:
  - id: D1
    description: "Polling follows D-19: pollSeconds clamped 5..3600 when focused, 120 s unfocused, immediate run on start, focus and nudge, never two syncs at once"
    requirement: TEAM-04
    verification:
      - kind: unit
        ref: "src/test/teamScheduler.test.ts (13 tests via node --test dist/test/teamScheduler.test.js)"
        status: pass
    human_judgment: false
  - id: D2
    description: "A failing or throwing sync backs off 30 s, 60 s ... capped at 600 s, a healthy run resets, focus retries at once, stop prevents any later run"
    requirement: TEAM-04
    verification:
      - kind: unit
        ref: "src/test/teamScheduler.test.ts#an unhealthy or throwing run doubles the delay per failure up to 10 minutes and a healthy run resets it"
        status: pass
      - kind: integration
        ref: "src/test/teamSession.test.ts#an unreachable remote pauses with a redacted reason, backs off to 10 minutes, retries on focus and recovers"
        status: pass
    human_judgment: false
  - id: D3
    description: "The status bar shows Team: <name>, Team sync paused: remote unreachable with a redacted reason tooltip, and Team sync paused: log rewritten with the D-33 sentence"
    requirement: TEAM-04
    verification:
      - kind: integration
        ref: "src/test/teamSession.test.ts#an unreachable remote pauses with a redacted reason, backs off to 10 minutes, retries on focus and recovers"
        status: pass
      - kind: integration
        ref: "src/test/teamSession.test.ts#a rewritten coordination branch shows the log rewritten state with the D-33 sentence"
        status: pass
    human_judgment: true
    rationale: "Wording and look of the status bar item in a real editor window is a UX judgment that stub tests cannot assert"
  - id: D4
    description: "Verify Team Log prints events, members with roles and device fingerprints, head, snapshots and every rejected event with its reason, plus a summary notification; unsupported events say to update the extension"
    requirement: TEAM-04
    verification:
      - kind: integration
        ref: "src/test/teamSession.test.ts#verifyLog prints the full report to the channel, shows a summary and Show details opens the channel"
        status: pass
      - kind: integration
        ref: "src/test/teamSession.test.ts#a raw-pushed event with a broken signature is printed once, listed by verifyLog and never mirrored to audit"
        status: pass
      - kind: integration
        ref: "src/test/teamSession.test.ts#an event of an unsupported type makes verifyLog tell the user to update the extension"
        status: pass
    human_judgment: false
  - id: D5
    description: "Accepted roster events reach the project audit log once across restarts; rejected events appear in the channel once per session and never in audit; an audit write that does not reach disk is retried"
    requirement: SEC-01
    verification:
      - kind: integration
        ref: "src/test/teamSession.test.ts#start creates the mirror, syncs once, shows Team: <name> and writes two team-roster entries that a restart does not repeat"
        status: pass
      - kind: integration
        ref: "src/test/teamSession.test.ts#an audit write that does not reach disk is reported once, keeps the mark back and is retried on the next sync"
        status: pass
    human_judgment: false
  - id: D6
    description: "No credential, URL userinfo or em-dash reaches a tooltip, output line or notification, whether git reports the URL or throws it; a changed team.json stops the session before any timer exists"
    requirement: SEC-01
    verification:
      - kind: integration
        ref: "src/test/teamSession.test.ts#credentials in a git error never reach the tooltip, the channel or a notification, whether git reports them or throws them"
        status: pass
      - kind: integration
        ref: "src/test/teamSession.test.ts#a changed team.json stops the session with TrustPinError and creates no timers or status bar item"
        status: pass
    human_judgment: false

duration: about 35 min
completed: 2026-11-01
status: complete
---

# Phase 60 Plan 09: Team session, scheduler and status bar Summary

**Focus-aware polling scheduler with backoff to 10 minutes, a TeamSession composition root with Team sync paused states, the Verify Team Log report, and a roster audit mirror that confirms every entry on disk**

## Performance

- **Duration:** about 35 min
- **Started:** about 2026-11-01T12:47:00Z (start time was not recorded precisely)
- **Completed:** 2026-11-01T13:23:00Z
- **Tasks:** 2
- **Files modified:** 6 (all new)

## Accomplishments
- `SyncScheduler` (no VS Code import) runs once at start, then every `pollSeconds` (clamped 5..3600, non-numbers fall back to 15) when focused and every 120 s when unfocused. A focus event or a nudge runs at once, any number of nudges during a run give exactly one follow-up, and runs never overlap. Failures double the delay up to 600 s, a healthy run resets it, and `stop()` guarantees no later run even for a run in flight. A throwing error handler is written to the host log, not lost.
- `TeamSession.start` checks the trust pin first (a mismatch rejects with `TrustPinError` before any transport, timer or status bar work), loads the device key if present (a clone without one runs read-only and says so), builds the transport and `TeamLog`, and waits for the scheduler's first sync so start syncs exactly once.
- The status bar shows `Team: <name>`, `Team sync paused: remote unreachable` (tooltip carries the redacted, single-line reason plus the retry promise) and `Team sync paused: log rewritten` (tooltip is the D-33 sentence). Paused states get the warning background.
- `verifyLog` runs `TeamLog.verifyAll` under a progress title, prints the report (header, status, events, head, members with role and device fingerprints, snapshots, every rejected event with its reason, secret-like warnings, the D-07 update sentence) and shows a summary with a Show details action. Problems turn it into a warning.
- Rejected events are written to the channel once per event id and reason per session and never reach audit. Accepted roster events wait in a session queue until `mirrorRosterEvents` has stored them, so a failed audit write is retried on the next sync and a restart never duplicates entries.
- `createVscodeTeamSession` wires the real editor services: window focus, `nearAi.team.pollSeconds` changes (nudge), notifications, progress and `AuditStore`, and puts every disposable on `context.subscriptions`.

## Task Commits

1. **Task 1: SyncScheduler** - `25c5b33` (feat), `cd06407` (test)
2. **Task 2: TeamSession, status bar, verify report, vscode stub** - `6846f33` (feat), `753a601` (test)

**Plan metadata:** recorded in the following docs commit.

## Files Created/Modified
- `src/team/syncScheduler.ts` - polling scheduler
- `src/services/team/teamStatusBar.ts` - status text rules, `safeReason`, status bar item
- `src/services/team/teamSession.ts` - composition root, `formatVerifyReport`, `projectAuditSink`, `createVscodeTeamSession`
- `src/test/teamScheduler.test.ts` - 13 tests under fake timers
- `src/test/teamSession.test.ts` - 13 tests on real git with the stub
- `src/test/helpers/vscodeStub.ts` - recording vscode stub (output channels, status bar items, notifications, config, window state)

## Decisions Made
See `key-decisions` above. The one worth restating: the audit carry-forward from 60-06 is handled inside this plan's files (see Deviations).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Audit mirror mark could advance past entries that never reached disk (carry-forward from 60-06)**
- **Found during:** Task 2 (audit mirroring)
- **Issue:** `AuditStore.persist` swallows write failures, so `mirrorRosterEvents` would advance its high-water mark past entries that were only in memory, and they would be lost for good.
- **Fix:** `projectAuditSink` in `teamSession.ts` uses a fresh `AuditStore` per mirror attempt and reads `audit.json` back after every append, throwing when the entry is not there. A throw keeps the mark where it was; the session keeps the events in its queue, writes `Team audit mirror failed, it will try again: ...` once, and retries on the next sync. A fresh store per attempt also avoids a long-lived store overwriting entries other writers add to the same file. `AuditStore` and `auditMirror.ts` are untouched (they are outside this plan's `files_modified`).
- **Files modified:** `src/services/team/teamSession.ts`
- **Verification:** `teamSession.test.ts#an audit write that does not reach disk is reported once, keeps the mark back and is retried on the next sync` (a file sits where `.planning` should be; no mark file; after recovery exactly two entries, not four)
- **Committed in:** `6846f33`

**2. [Rule 2 - Missing Critical] Backoff must not shorten a long poll interval**
- **Found during:** Task 1
- **Issue:** the plan's `min(600000, base * 2 ** failures)` would turn a 3600 s poll into 600 s after a failure, polling a struggling remote more often.
- **Fix:** `max(base, min(600000, base * 2 ** failures))`. Identical for every base up to 600 s.
- **Files modified:** `src/team/syncScheduler.ts`
- **Verification:** `teamScheduler.test.ts#a failure never shortens a poll interval that is already longer than the cap`
- **Committed in:** `25c5b33`

**3. [Rule 2 - Missing Critical] Hostile and multi-line text is flattened before display**
- **Found during:** Task 2
- **Issue:** names, event ids, file paths and git reasons come from the remote or from git output; control characters or very long text in a tooltip, notification or channel line is a spoofing and noise risk (T-60-43).
- **Fix:** `safeReason` (redactGitMessage, control characters to spaces, 400 character cap) for every remote-derived string; `$(` in a team name is escaped so it renders as typed.
- **Files modified:** `src/services/team/teamStatusBar.ts`, `src/services/team/teamSession.ts`
- **Verification:** `teamSession.test.ts#formatVerifyReport lists refused logs, ... and flattens hostile text`
- **Committed in:** `6846f33`

---

**Total deviations:** 3 auto-fixed (3 missing critical). All stay inside the planned files.
**Impact on plan:** No scope creep. Deviation 1 closes the 60-06 follow-up; the other two harden behaviour the plan already specified.

## Issues Encountered
- Modern git strips the userinfo from its own "unable to access" message, so the plan's unreachable-URL canary alone does not exercise our redaction. Added a second test where a stubbed git runner reports and throws the full credential URL; both the status text and every output line stay clean.
- The writing tool turned ` `, ` ` and `—` escapes into raw characters in two source files; they were put back as escapes, and a non-ASCII scan of all six files is clean.

## Known Stubs

None.

## Threat Flags

None. No new network endpoints or trust boundaries beyond the ones in the plan's threat model (T-60-41 to T-60-44 are covered by tests: credential canary, backoff and clamping, validated names and ids, trust pin before anything else).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- 60-11 (activation, solo parity) can call `createVscodeTeamSession(context, projectRoot, teamFile, channel)` only when team.json exists and must register the command `nearAi.team.verifyLog` (the status bar item already points at it) to call `session.verifyLog()`.
- `package.json` does not yet contribute the `nearAi.team.pollSeconds` setting (default 15, minimum 5, maximum 3600) or the `nearAi.team.verifyLog` command; the session reads the setting with a default of 15 so it works without it, but 60-11 should declare both. Not done here because `package.json` is outside this plan's `files_modified`.
- Follow-up outside this plan: giving `AuditStore.persist` a way to report failure would let `projectAuditSink` drop its read-back.
- The session exposes `sync`, `verifyLog`, `nudge`, `focusChanged`, `dispose`; no `append` yet. 60-10 and later plans that write events will need access to the signing `TeamLog` (it is swapped in after the first sync once the member is known).

## Self-Check: PASSED

- Files present: `src/team/syncScheduler.ts`, `src/services/team/teamStatusBar.ts`, `src/services/team/teamSession.ts`, `src/test/teamScheduler.test.ts`, `src/test/teamSession.test.ts`, `src/test/helpers/vscodeStub.ts`.
- Commits present on this branch: `25c5b33`, `cd06407`, `6846f33`, `753a601`.
- Plan verification: `npm run lint` exit 0; `node --test dist/test/team*.test.js` 320 tests pass, 0 fail; full `node --test dist/test/*.test.js` 890 tests, 882 pass, 0 fail (the rest are existing skipped live tests); `git diff` of `src/services/chat.ts` against the merge base is empty; `package.json` unchanged.
- Acceptance criteria re-run: 600_000 and 120_000 present in the scheduler, no vscode import in `src/team/syncScheduler.ts`, no empty catch or discarded promise in `src/services/team` or the scheduler, `Team sync paused: remote unreachable`, `'NEAR AI Team'`, `mirrorRosterEvents(` and `redactGitMessage` (status bar) matched, no em-dash in `src/services/team`, the scheduler or the new tests.

---
*Phase: 60-team-core-identity-signed-event-log-git-transport-roster*
*Completed: 2026-11-01*
