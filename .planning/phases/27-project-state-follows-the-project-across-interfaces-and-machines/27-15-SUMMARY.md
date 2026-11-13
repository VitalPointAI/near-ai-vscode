---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 15
subsystem: state-sync
tags: [recovery-code, turn-on, restore, join, scheduler, keep-key, credentials, github-signin, status]

requires:
  - phase: 27-project-state-follows-the-project-across-interfaces-and-machines
    provides: "27-01 recovery code, keys and sealed objects; 27-03 sealed NEAR AI key copy (D-15); 27-04 run markers; 27-11/13 StateTransport and partial-clone mirror; 27-12 StateSync with profile and secret hooks; 27-14 pick-up card; 27-17 online-home flow and withGitHubAuth"
provides:
  - "src/services/syncFlows.ts: SyncUi, SyncEnv, turnOnFlow, enterCodeFlow, newCodeFlow, keepKeyFlow, turnOffFlow, afterRemoteFor, resolveRemote, readSyncSettings, buildStateSync, tokenRunner, SyncScheduler, SyncStatus, clampSyncInterval, SYNC_INTERVAL_DEFAULT, RETURN_PULL_AFTER_MS, PUSH_BATCH_MS, DEACTIVATE_PUSH_MS, COALESCE_MS, BLUR_IDLE_MS, SYNC_LEAK_EXPLANATION"
  - "src/services/stateRestore.ts: profileSourceFor, secretSourceFor, restoreProfiles, profileSyncHooks, adoptRemoteIdentity, recoverInterruptedAdoption, discardPreviousState"
  - "src/services/syncCommands.ts: registerSyncCommands, onSyncStatus, currentSyncStatus, flushSyncOnClose (six commands under category NEAR AI)"
  - "src/services/runEndHooks.ts: runStarted, runsInFlight (the count drops before listeners hear of a run end)"
  - "src/domain/redaction.ts: recovery-code shape removed by redactSecrets"
  - "package.json: six nearAi.sync.* commands and nearAi.sync.intervalMinutes (number, default 10, 0..1440)"
affects: [27-16, 27-18, sync-control, pickup-card, readme]

actuals:
  tokens: 39300
  tasks: 3
  commits: 5
plan_head_before: c3d00d82d4a0eb6e59d729e5ada2d4376d076fb9
plan_head_after: 670c9d8571ba6b6e6b14d97aa2be8f60d4352662

tech-stack:
  added: []
  patterns:
    - "Every flow is vscode-free: the questions to the person (SyncUi), the online-home setup, the building of a StateSync (makeSync) and the clock are injected, so the whole of turn-on, restore, join, rotate, key-file switch and scheduling runs on plain node with fakes and local bare repositories"
    - "The recovery code lives in locals of the flow that made it: generated, passed once to ui.showCodeOnce, wrapped to disk only after the person confirms, then zeroed; consent (what the git host can see) comes before anything is generated or written"
    - "A second computer opens the remote with the code through a throwaway mirror outside the state home, so a wrong code creates no folder at all; the state home, key and recovery wrap are adopted only after the sealed manifest opened"
    - "A join builds a re-keyed copy of the state home beside the real one (.near-ai/state.adopt-<random>), swaps by two renames, keeps the original as state.previous-<random> until a sync worked, and any failure or a cut-off run leaves or puts back the original"
    - "A remote address's userinfo never reaches the mirror config or a git argument: splitAddress writes the plain address and git gets the credentialed form as a url.<credentialed>.insteadOf rewrite in each call's environment (addGitConfigEnv appends, so the GitHub header and the rewrite coexist)"
    - "A new recovery code is carried by a pending flag in sync/state.json and named by the sealed index (wrapId); a computer whose wrap is older adopts the remote's newer one instead of pushing its own back, and a header that disagrees with the sealed index is treated as damaged"
    - "SyncScheduler takes the clock, the runs in flight and the sync itself as options; a fake clock drives every rule (coalesce 5 s, blur 60 s, return 5 min, push batch 2 min, backoff 1..30 min, close 3 s)"

key-files:
  created:
    - src/services/syncFlows.ts
    - src/services/stateRestore.ts
    - src/services/syncCommands.ts
    - src/test/stateRestoreProfile.test.ts
    - src/test/syncFlows.test.ts
    - src/test/syncMirrorCredentials.test.ts
    - src/test/helpers/flowFixtures.ts
  modified:
    - src/services/stateTransport.ts
    - src/services/stateGit.ts
    - src/services/stateSync.ts
    - src/services/stateKeys.ts
    - src/services/stateApiKey.ts
    - src/services/stateHome.ts
    - src/services/stateRecords.ts
    - src/services/threadStore.ts
    - src/services/onlineHome.ts
    - src/services/runEndHooks.ts
    - src/services/chat.ts
    - src/domain/redaction.ts
    - src/extension.ts
    - package.json

key-decisions:
  - "Credentials in a remote address (27-13 carry-forward): the mirror config gets the address without userinfo (all of it for http and https, only a password for ssh, whose user name is not a secret and is needed); git gets the credentialed form per call as an insteadOf rewrite in its environment. A mirror an earlier version wrote with userinfo is cleaned by the next sync"
  - "Automatic syncs never prompt (27-17 carry-forward): the scheduler builds each run's StateSync with tokenRunner(base, () => token(interactive)), which looks the GitHub session up silently unless the run is a person's click; an auth failure becomes 'Sync needs you to sign in. Choose Sync Project Now.' on the status. Flows a person starts may prompt"
  - "Consent first: the explanation of what the git host can and cannot see is confirmed before the code is made, and the wrap is written only after the person says the code is saved. The plan listed the code screen first"
  - "Joining reuses the thread store's own APIs (liveSnapshot, readArchive, importThread) with the old key held in memory, rather than converting sealed files byte by byte; archived threads come across live and the next retention pass archives them again. Plain files (runs, checkpoints, comparisons, choices, spend, pickup) are copied as they are; the old sync mirror and bookkeeping are not carried because the identity is new"
  - "restoreProfiles checks nothing against the provider while a sync applies records: it writes through ProfileStore.configure with a check that always defers, marks the profile stale, and the editor's glue then validates and selects it in the background, so no key is typed again and no sync waits on the network"
  - "A key is released only to the endpoint it was sealed for: a copy whose endpoint differs from the profile's base URL is skipped; asking AuthService for the key with another endpoint throws (it does not return undefined)"
  - "A locked project (key file off, an editor with no key) opens with the code and the wrap kept in its own folder (StateKeys.unlockWithCode), so enterCodeFlow also works on a project that never synced"
  - "The scheduler builds a StateSync per run so the silent or interactive token choice is per run; serialisation across instances is the mirror lock and the 'waiting' outcome, and one scheduler runs one sync at a time"

patterns-established:
  - "A flow test spies console and every ui message and then scans every file under every state home and every secret for the code with and without hyphens, plus a remote scan with positive controls; a mutation (the wrap-adoption rule, the address stripping) made the matching tests fail"
  - "Scheduler tests drive a FakeClock with advance(ms) that runs due timers in order and lets what each starts finish, so a 30-minute backoff takes milliseconds"

requirements-completed: [SYNC-04, SYNC-05, SYNC-03, SYNC-09]

coverage:
  - id: D1
    description: "Turning sync on resolves the remote, explains what the git host can and cannot see, shows a 13-group recovery code exactly once, writes the wrap only after the person confirms, and pushes; a second computer that enters the code gets the chat in full, the profile (validation stale) and the NEAR AI key saved under its own project scope for its endpoint only, with its own sealed copy written; nothing typed beyond the code"
    requirement: SYNC-04
    verification:
      - kind: integration
        ref: "dist/test/stateRestoreProfile.test.js#tracer: turning sync on shows the code once and pushes; a second computer that enters it gets the chat, the profile and the NEAR AI key"
        status: pass
    human_judgment: false
  - id: D2
    description: "Team profiles, profiles that reuse another project's key and refresh tokens are neither sent nor restored; the remote holds no plaintext key (scan with positive control); a wrong or malformed code gives the plain refusal and creates no folder in the project; turning on with no remote starts the online-home flow once and continues to the code and first push only when it reports a remote, and declining writes nothing"
    requirement: SYNC-04
    verification:
      - kind: integration
        ref: "dist/test/stateRestoreProfile.test.js#profiles that reuse another project's key and team profiles are not sent or restored, no refresh token travels, and no plaintext key is in the remote"
        status: pass
      - kind: integration
        ref: "dist/test/stateRestoreProfile.test.js#a wrong code, and a code that is not a code, give one plain refusal and create no state folder at all"
        status: pass
      - kind: integration
        ref: "dist/test/stateRestoreProfile.test.js#turning on with no remote starts the online-home flow once and goes on to the code and the first push only when it reports a remote; declining writes nothing"
        status: pass
    human_judgment: false
  - id: D3
    description: "A computer with chats of its own joins the synced project: its threads (one archived) and the online ones are all listed and whole, its chats go up, the folder kept from before is removed after the sync worked; a failure at either rename leaves the original byte-identical, a cut-off run is put back, a locked project is refused and declining changes nothing"
    requirement: SYNC-05
    verification:
      - kind: integration
        ref: "dist/test/syncFlows.test.js#join: a computer with chats of its own adds them to the synced project: all of its threads and the online ones are listed and readable, and nothing is lost"
        status: pass
      - kind: integration
        ref: "dist/test/syncFlows.test.js#join: a failure at either rename, or a cut-off run, leaves the original folder intact and a rerun completes"
        status: pass
      - kind: integration
        ref: "dist/test/syncFlows.test.js#join: chats that are locked on this computer are not touched, and declining the question changes nothing"
        status: pass
    human_judgment: false
  - id: D4
    description: "A new recovery code opens a fresh computer and the old one is refused; an older computer pushing later does not undo it; the message says copies already on the git host open with the old code until re-keyed"
    requirement: SYNC-04
    verification:
      - kind: integration
        ref: "dist/test/syncFlows.test.js#newCodeFlow: the new code opens a fresh computer and the old one is refused; an older computer syncing later does not undo it; the message says earlier copies still open with the old code"
        status: pass
    human_judgment: false
  - id: D5
    description: "keepKeyInProject off asks, shows a code once only when none exists, keeps this editor's copy and removes keys/local.key, a fresh editor is then locked and opens with the code; on writes the file at mode 0600; turning sync off stops everything and leaves the remote and local state as they are"
    requirement: SYNC-03
    verification:
      - kind: integration
        ref: "dist/test/syncFlows.test.js#keepKeyFlow(false) with no recovery code shows one once, asks, removes keys/local.key, and a fresh editor is locked until the code is entered; (true) writes the file again at mode 0600"
        status: pass
      - kind: integration
        ref: "dist/test/syncFlows.test.js#keepKeyFlow(false) when a recovery code exists shows no new code"
        status: pass
      - kind: integration
        ref: "dist/test/syncFlows.test.js#turnOffFlow stops syncing and leaves the remote branch and this computer's state as they are"
        status: pass
    human_judgment: false
  - id: D6
    description: "Across turn-on, restore, wrong code, new code, key-file off and turn-off, no console line, message, file under any state home, secret or remote object holds any recovery code (with or without hyphens) or the typed wrong one; redactSecrets removes anything shaped like a code and leaves prose alone"
    requirement: SYNC-04
    verification:
      - kind: integration
        ref: "dist/test/syncFlows.test.js#across every flow no console line, message, file under a state home, or secret holds the recovery code, with or without hyphens"
        status: pass
      - kind: unit
        ref: "dist/test/syncFlows.test.js#redactSecrets removes anything shaped like a recovery code and leaves ordinary prose alone"
        status: pass
    human_judgment: false
  - id: D7
    description: "After turn-on, sync and unlock with a credentialed remote no mirror, state folder or project file holds the userinfo, git received it only in its environment on every network call of a mirror, a mirror configured with userinfo by an earlier version is cleaned by the next sync"
    requirement: SYNC-05
    verification:
      - kind: integration
        ref: "dist/test/syncMirrorCredentials.test.js#after turn-on, sync and unlock with a credentialed remote, no mirror, state folder or project file holds the userinfo, and git got it only in its environment"
        status: pass
      - kind: integration
        ref: "dist/test/syncMirrorCredentials.test.js#a mirror configured by an earlier version with the userinfo in it is cleaned by the next sync"
        status: pass
    human_judgment: false
  - id: D8
    description: "Sync timing on a fake clock: nothing while off; a pull on open that activation does not wait for (status 'syncing', reason 'open'); a pull on return after 5 minutes and none after 4; a full sync a minute after losing focus; the interval while idle, skipped during a run, off at 0, rescheduled on change; a trigger during a run is kept and runs at its end; requests within seconds are one sync; pushes 2 minutes apart with Sync Project Now exempt; offline backoff 60, 120, 240, 480, 960, 1800, 1800 seconds and reset on success; one bounded push on close; only a click is interactive"
    requirement: SYNC-05
    verification:
      - kind: unit
        ref: "dist/test/syncFlows.test.js#sync is off until turned on: nothing is scheduled and the status says so"
        status: pass
      - kind: unit
        ref: "dist/test/syncFlows.test.js#a pull starts when the project opens, is not waited for, and the status says it is checking for updates"
        status: pass
      - kind: unit
        ref: "dist/test/syncFlows.test.js#a pull runs when the window comes back after five minutes away, and not after four"
        status: pass
      - kind: unit
        ref: "dist/test/syncFlows.test.js#the interval syncs while idle, is skipped during a run, can be turned off with 0, and follows the setting when it changes"
        status: pass
      - kind: unit
        ref: "dist/test/syncFlows.test.js#automatic pushes are at least two minutes apart; Sync Project Now is not held back"
        status: pass
      - kind: unit
        ref: "dist/test/syncFlows.test.js#offline failures back off 1, 2, 4 ... up to 30 minutes and a success resets it"
        status: pass
      - kind: unit
        ref: "dist/test/syncFlows.test.js#the editor closing tries one sync and gives up after three seconds, however long it hangs"
        status: pass
    human_judgment: false
  - id: D9
    description: "The remote is the stored one, else origin, else the only one, else the person's single pick among several (remembered in the state home), and no remote is 'none'; the status carries one plain sentence with no credentials, and no-home, needs-sign-in and attention are separate states; the interval setting and the six commands are declared as specified; tokenRunner adds the GitHub header only to the mirror's calls and only when a token exists"
    requirement: SYNC-09
    verification:
      - kind: integration
        ref: "dist/test/syncFlows.test.js#the remote is the stored one, else origin, else the only one; several and no origin ask once and remember; none is none"
        status: pass
      - kind: unit
        ref: "dist/test/syncFlows.test.js#the status says what happened in one plain sentence, never a URL with credentials or a secret, and a missing remote or a sign-in is its own state"
        status: pass
      - kind: unit
        ref: "dist/test/syncFlows.test.js#clampSyncInterval reads the setting the way package.json declares it"
        status: pass
      - kind: unit
        ref: "dist/test/syncFlows.test.js#tokenRunner signs git in for the mirror's calls only when a token exists, through the environment, and looks the token up only for those calls"
        status: pass
    human_judgment: false
  - id: D10
    description: "The VS Code glue: the input box and modal that show the code once, the password box for entering it, the commands in the Command Palette, the status listeners, the window-focus and configuration hooks, the key-file setting running its flow and reverting when it did not finish, and a restored profile being validated and selected in the background"
    verification: []
    human_judgment: true
    rationale: "syncCommands.ts needs a running editor. The pure parts it calls are tested; how the dialogs read and look, that the code is easy to copy from the input box, that a declined key-file switch puts the setting back, and that code-server (no GitHub provider) behaves are VALIDATION manual row 3: turn sync on, record the code, clone elsewhere, enter it, and see the chats, runs, comparisons, model choices and the key restored"
---

# Phase 27 Plan 15: Sync controls in plain words Summary

**Turn on project sync from the Command Palette: a recovery code shown once (never stored, logged or sent), a second computer restored with that code alone (chats, runs, comparisons, model choices and the NEAR AI key under its own scope), a join from a computer that already has chats, a new code, the key-file switch, and sync at safe moments with a plain-words status; mirror configs never hold URL userinfo and automatic syncs never prompt for GitHub.**

## Performance

- **Duration:** about 30 min (commit times 12:07 to 12:35)
- **Tasks:** 3 (one tracer, one TDD, one auto)
- **Files:** 7 created, 14 modified; 2 732 lines added, 37 removed

## Accomplishments

- **Turn on and restore.** `turnOnFlow` finds the remote (stored, origin, the only one, or the person's one pick), explains what the git host can and cannot see, shows the code once, writes the wrap after the person confirms it is saved, and does the first push. With no remote it starts the online-home flow and goes on only when that reports a remote. `enterCodeFlow` opens the remote through a throwaway mirror outside the state home (a wrong code creates no folder), adopts the project's id and key, and a full sync brings everything; the NEAR AI key arrives as the D-15 sealed copy, is opened in memory, and is saved under the new computer's own scope for the endpoint it was sealed for.
- **Join.** A computer with chats of its own re-keys them into a copy beside its state home, swaps by two renames, and keeps the original until a sync worked. Failures at either rename leave the original byte-identical; a cut-off run is put right by the next attempt.
- **New code, key file, turn off.** A new code reaches the remote with the next sync, and an older computer does not push its old wrap back over it. The key-file switch removes `keys/local.key` only with a recovery code in place and this editor's own copy kept; a locked editor opens with the code and the wrap kept in the project. Turning off changes nothing but the setting.
- **The code cannot leak.** A spy over console, every message, every file under every state home, every secret and the remote finds no code after any flow; `redactSecrets` removes anything shaped like one.
- **Safe moments.** A scheduler (tested on a fake clock) syncs after a run, after a minute out of focus, on Sync Project Now and every `nearAi.sync.intervalMinutes` while idle; pulls on open (without being waited for) and on return after five minutes; never during a run; joins requests close together; backs off 1 to 30 minutes when offline; keeps automatic pushes two minutes apart; one push on close cut off at three seconds. Status changes are published for the panel control.
- **Carry-forwards.** Mirror config never holds userinfo (27-13); background syncs ask GitHub silently and report "needs sign-in" (27-17); `runState`, `profileSource`, `secretSource` and `applyProfiles` are wired (27-12).

## Task Commits

1. **Task 1 (tracer): turn on, code once, restore on a second computer** - `c113616` (feat)
2. **Task 2 RED** - `b4eafad` (test, 7 of 9 fail)
3. **Task 2 GREEN** - `1e9819e` (feat, 9 of 9)
4. **Task 3: commands, safe triggers, remote choice, status** - `904c73e` (feat; syncFlows 25 passing)
5. **Run counting by resolved path** - `670c9d8` (fix)

**Plan metadata:** the docs commit that carries this SUMMARY, STATE.md and ROADMAP.md.

**TDD evidence.** Task 2's RED run failed 7 of 9: newCodeFlow, keepKeyFlow (both), turnOffFlow and the spy test (stubs rejecting), the cut-off join case (no recovery, no plain failure) and the redaction case. Two cases passed at RED, the basic join and the locked or declined join, because `enterCodeFlow` already joined (it was needed by the tracer). Mutation checks on the compiled output: disabling the wrap-adoption rule failed the new-code test for the intended reason ("the new code still opens it after the older computer pushed"); returning the address unstripped failed both credential tests. The builds were restored after each.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] Credentials in the mirror config (27-13 carry-forward)**
- **Found during:** Task 1
- **Issue:** `configurePartialClone` wrote the person's remote address, userinfo included, into `sync/mirror.git/config` inside the project folder.
- **Fix:** `splitAddress` (stateGit.ts) and an env rewrite in the transport; `addGitConfigEnv` appends to `GIT_CONFIG_COUNT`, and `withGitHubAuth` (27-17) now uses it so the GitHub header and the rewrite coexist.
- **Files modified:** `src/services/stateGit.ts`, `src/services/stateTransport.ts`, `src/services/onlineHome.ts`
- **Commit:** `c113616`

**2. [Rule 1 - Bug] A new recovery code would have been undone by any older computer's next push**
- **Found during:** Task 2
- **Issue:** each push carries the pusher's own wrap in the manifest header, so a computer holding the old wrap overwrote a rotation; and a sync with nothing else to send never pushed the new wrap at all.
- **Fix:** `wrapPending` in `sync/state.json`, `wrapId` in the sealed index, and `chooseWrap` (adopt the remote's wrap when the sealed index vouches for it; push the local one when a rotation is pending or the header disagrees with the index).
- **Files modified:** `src/services/stateSync.ts`, `src/services/stateRecords.ts`
- **Commit:** `1e9819e`

**3. [Rule 3 - Blocking] Seams in files the plan did not list**
- `StateSync.openRemote` and `remoteState` plus an option to not register the cold fetcher; `openApiKeyCopyText`, `readApiKeyCopyText`, `listApiKeyCopies`; `ProjectStateHome` takes an alternative folder; `ThreadStore.forgetCaches`; `StateKeys.unlockWithCode`, `keepDeviceCopy`, `writeLocalKeyFile`. All additive.
- **Commit:** `c113616`, `1e9819e`

**4. [Rule 1 - Bug] Runs in flight were counted by the string the chat passed**
- **Found during:** final review. A trailing slash or a different spelling would have hidden a run from the scheduler.
- **Fix:** keys are resolved paths.
- **Files modified:** `src/services/runEndHooks.ts`
- **Commit:** `670c9d8`

### Plan wording

- **Order on the first screens.** The plan lists the code screen before the explanation of what the git host can see; here consent comes first and the wrap is written only after the person confirms the code is saved, so declining anywhere writes nothing.
- **Redaction shape.** The plan names 8 groups of 4; D-18's code is 13 groups of 52 characters, so the pattern is 8 or more groups (either case) and 32 or more plain upper-case characters, which covers the full code and long pieces of it.
- **Wrong endpoint.** The plan says asking for a key with another endpoint "returns undefined"; `AuthService.getScopedApiKeyFor` throws, which is what the tracer test asserts.
- **`restoreProfiles` signature.** It takes a fourth `deps` argument (`keys`, optional `home`, `store`, `log`) because the data key is needed to open the copy, and its default store defers the provider check instead of calling the network in the middle of a sync. "Then markValidationStale" is kept; the glue validates and selects in the background afterwards.
- **Join method.** Threads are re-imported through the thread store's own APIs instead of converting sealed files one by one, so archived threads come across live and are archived again by the next retention pass.
- **Per-run StateSync.** The scheduler builds one StateSync per run so the silent or interactive token is chosen per run.

**Total deviations:** 4 auto-fixed (1 missing-critical, 2 bugs, 1 blocking), 6 wording differences. **Impact:** none on the contract; everything tightens the plan's own security goals.

## Authentication Gates

None. No real GitHub, token or network was used; sign-in is a fake in every test.

## Issues Encountered

None. The full suite (`dist/test/*.test.js`, 6 GB cap) is 1 638 tests: 1 628 pass, 9 skipped, 1 fails, the known `chatSendPath` "GSD slash command" failure. `npm run lint` is clean and the secret scan over the plan's commits is clean. `.planning/state.json` was already modified and was left alone.

## Known Stubs

None.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: credentials-in-environment | src/services/stateTransport.ts | The credentialed address (and the GitHub header) now reach git as `GIT_CONFIG_*` in the child's environment; covered by T-27-90 and the mirror test that no argument or file holds them |
| threat_flag: file-write | src/services/stateRestore.ts | A join keeps `.near-ai/state.previous-<random>` (the old state, as it was) until a sync worked; it sits inside the git-ignored `.near-ai` folder and is removed after the first successful sync |
| threat_flag: key-file | src/services/stateKeys.ts | `writeLocalKeyFile` writes `keys/local.key` again at mode 0600 when the setting is switched on |

The plan's register is covered: T-27-63 (spy test over console, messages, files, secrets and the remote, plus redaction), T-27-64 (endpoint-bound restore, tested), T-27-65 (team, linked and refresh-token data never collected, tested), T-27-66 (build aside, swap by rename, original kept, crash tests), T-27-67 (no setting is read for the remote), T-27-68 (scheduler skips during a run), T-27-90 (silent session for automatic syncs, token only in the child's environment), T-27-91 (every status sentence is redacted), T-27-92 (pushes two minutes apart), T-27-93 (close push cut off at three seconds, backoff to 30 minutes).

## Next Phase Readiness

- Plan 18's panel control can read `currentSyncStatus(root)` and subscribe with `onSyncStatus((root, status) => ...)`; `SyncStatus.reason === 'open'` is the pick-up card's "Checking for updates…".
- Plan 16 (README and the release notes) should state: what the git host can see (the text of `SYNC_LEAK_EXPLANATION`), that copies already on the git host still open with an old code until the data is re-keyed, and that the key file can be turned off.
- Not covered: re-keying the data after a new code, tombstones for removing a record, and `nearAi.sync.remote` (deferred by D-09).

## Self-Check: PASSED

- Files: `syncFlows.ts`, `stateRestore.ts`, `syncCommands.ts`, `stateRestoreProfile.test.ts`, `syncFlows.test.ts`, `syncMirrorCredentials.test.ts`, `helpers/flowFixtures.ts` exist.
- Commits `c113616`, `b4eafad`, `1e9819e`, `904c73e`, `670c9d8` are ancestors of HEAD; 5 measured by `git rev-list --count c3d00d8..HEAD` before this docs commit.
- Acceptance: stateRestoreProfile 4 passing, syncFlows 25 passing, 0 failing, privacy and conversations pass; `from 'vscode'` 0 in syncFlows.ts and stateRestore.ts; `RefreshToken` 0 in stateRestore.ts; `adopt-` 2 in stateRestore.ts; `registerSyncCommands(` 1 in extension.ts; the `nearAi.sync.intervalMinutes` and six-command node checks exit 0.
- Plan verification: full suite 1 628 of 1 638 with only the known failure; `npm run lint` clean; `node scripts/secret-scan.mjs --range c3d00d82..HEAD` clean.
