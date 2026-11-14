---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
verified: 2026-11-13T18:30:00Z
status: human_needed
score: 5/6 roadmap success criteria verified (SC6 release half pending 27-16 Tasks 2-3, not a gap); 4/4 extra decision truths verified
covered_files: [".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-01-PLAN.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-01-SUMMARY.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-02-PLAN.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-02-SUMMARY.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-03-PLAN.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-03-SUMMARY.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-04-PLAN.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-04-SUMMARY.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-05-PLAN.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-05-SUMMARY.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-06-PLAN.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-06-SUMMARY.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-07-PLAN.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-07-SUMMARY.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-08-PLAN.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-08-SUMMARY.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-09-PLAN.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-09-SUMMARY.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-10-PLAN.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-10-SUMMARY.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-11-PLAN.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-11-SUMMARY.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-12-PLAN.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-12-SUMMARY.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-13-PLAN.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-13-SUMMARY.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-14-PLAN.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-14-SUMMARY.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-15-PLAN.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-15-SUMMARY.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-16-PLAN.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-17-PLAN.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-17-SUMMARY.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-18-PLAN.md", ".planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-18-SUMMARY.md", "README.md", "SECURITY.md", "package.json", "src/extension.ts", "src/services/chat.ts", "src/services/stateSync.ts", "src/services/stateTransport.ts", "src/services/syncFlows.ts"]
covered_digest: "v4:sha256:2501a0c04f28c354983dbfc32fc13cabac2e40601b67b19092deee1b6a23ebb5"
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "Same project in code-server and desktop VS Code shows the same chats (full history, tool steps open), runs, checkpoints, comparisons and model choices (SYNC-01, SYNC-06; 27-03 D10, 27-10 D8, 27-09 D8)"
    expected: "Both History lists match, including the week of code-server chats and desktop chats; Compare Models shows the 2026-11-12 comparison without re-running; the import offer appears for choices applied globally earlier"
    why_human: "Needs two real editors with separate SecretStorage on the owner's host; tests use two stores on one folder, not two real extension hosts"
  - test: "Pick up where you left off in the other editor (SYNC-07; 27-14 D5)"
    expected: "Card shows last chat, run state and GSD phase with next step; Open chat reopens it; no new request in Agent Activity or spend; card reads in light, dark and high-contrast themes and is keyboard reachable"
    why_human: "Real UI and themes; the no-spend property is unit-tested through the handler but not observed in a real editor"
  - test: "Sync control visible on open and its VS Code glue (D-16; 27-18 D6 and D10, 27-15 D10)"
    expected: "'Sync off · Turn on' next to the profile control in both editors before any action, reachable with Tab, readable in light, dark and high-contrast; input box shows the recovery code once; Enter Recovery Code password box; Command Palette entries; key-file setting reverts when its flow does not finish"
    why_human: "Webview look, theme contrast and VS Code dialogs cannot be asserted without a DOM or a real extension host (no DOM harness in the repository)"
  - test: "Same-host key with sync off (D-15; 27-03 D10)"
    expected: "Use a project in code-server, then open it in desktop VS Code and send a message: no key prompt"
    why_human: "Two real editors with separate secret storage"
  - test: "Second-machine restore with the recovery code (SYNC-04, SYNC-05)"
    expected: "Turn sync on, record the code, clone to another path or machine, run NEAR AI: Enter Recovery Code: chats, runs, comparisons, model choices and the NEAR AI key are there without typing the key; the code was shown once and is not stored"
    why_human: "Real remote and a second clone; automated coverage uses a local bare remote"
  - test: "Pull on open on a second editor (D-17)"
    expected: "Card shows 'Checking for updates…' then the new chat, while the chat input stays usable"
    why_human: "Two real editors and a real remote"
  - test: "Online home on a scratch folder (SYNC-09, D-14; 27-17 D6)"
    expected: "'No online home · Set up' with a private choice creates the GitHub repository with only the near-ai/state branch; code push is a separate offer and blocks a planted .env; the near-ai/state branch holds only manifest.json and random .bin names, commits by near-ai-state with 'Update encrypted project state'; 'Not now' is remembered per workspace"
    why_human: "Needs a real GitHub account and the real VS Code GitHub authentication provider"
  - test: "Editor-glue behaviours marked human_judgment in SUMMARYs (27-04 D8, 27-05 D12, 27-06 D8 and D9, 27-07 D10, 27-08 D9, 27-13 D7)"
    expected: "30 s heartbeat fires in a real extension host and the 'running in another editor' notice shows; 'Locked conversation' item declines to open; reopened history draws in slices of 50 with text-only output and card toggles; QuickPick filtering; retention runs after each run and protects open tabs; @near reply button and threadId survive a Chat view session restore (assumption A15); history-error notice shows instead of opening a thread that cannot be read"
    why_human: "Webview drawing and VS Code API behaviour with no harness; each is covered by reading and by unit tests of the pure parts"
  - test: "27-16 Task 2: owner's hands-on check on the real host (pending)"
    expected: "Owner types 'approved' after the eight steps in 27-16-PLAN.md Task 2"
    why_human: "Owner decision; plan 27-16 has no SUMMARY yet"
  - test: "27-16 Task 3: feature PR, release/0.4.20 PR, v0.4.20 tag, owner approval of publish (pending, SYNC-08)"
    expected: "package.json and package-lock.json at 0.4.20, a '## 0.4.20' CHANGELOG section stating the D-11, D-12, D-13 and old-recovery-code limits, prepare-release check passes, both PRs squash-merged through agent review, v0.4.20 on origin, publishing approved by the owner in GitHub; nothing pushed to main directly"
    why_human: "Release process requires GitHub CI, review, merge and the owner's publish approval by design; the prohibition 'MUST NOT push to main or publish without owner approval' is judgment-tier and stays flagged until the PRs exist"
---

# Phase 27: Project state follows the project across interfaces and machines: Verification Report

**Phase Goal:** A person opens a project in any interface (code-server from any browser, desktop VS Code, another machine) and finds the same chats, run records, checkpoints, model comparison results and applied model choices, is offered "pick up where you left off", and never has to set the profile up again or pay to redo work already done; everything that leaves the machine is encrypted end to end.
**Verified:** 2026-11-13
**Status:** human_needed
**Re-verification:** No, initial verification
**HEAD verified:** c41d476 on feat/project-state-sync (103 commits ahead of origin/main 72ebd4e)

Starting hypothesis was that the goal was missed. It did not survive contact with the code: every roadmap criterion that does not depend on the release or on a real second editor is backed by code that exists, is wired into the extension and the chat panel, and is exercised by tests that I re-ran. What remains is real-host confirmation and the release, both already scheduled in plan 27-16.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SC1: Same project folder in two editors on one host shows the same chat list, runs, checkpoints, comparisons and applied model choices, with no manual step (SYNC-01, SYNC-06) | VERIFIED (real-host check in human list) | Everything is written to the git-ignored `.near-ai/state` home: `src/services/stateHome.ts` (paths for threads, archive, runs, checkpoints, comparisons, spend, choices, pointer, keys); `chat.ts:946` RunMarkers `dir: home.paths.runs`; `chat.ts:971` checkpoints `home.paths.checkpoints`; `src/benchmark/store.ts:86-88` ComparisonStore primary folder is `home.paths.comparisons`; `modelChoices.ts:96,182` choices file in the home; `threadStore.ts` threads and archive in the home; `spendMirror.ts` spend mirror. Choices are effective, not only stored: `settings.ts:26-81,134` resolves every model setting through `resolveSetting(inspected, projectChoice, ...)`. `applyRecommended` and `applyRole` (`modelComparisonPanel.ts:289-375`) write `writeProjectChoice` or Workspace, and the grep shows no `ConfigurationTarget.Global` write left in `modelComparisonPanel.ts` or `modelChoices.ts`. Tests: `stateHome`, `stateStores`, `activityShared`, `runMarkersForeign`, `modelChoices`, `modelComparisonPage`, `threadStore`-family tests all pass (see spot-checks) |
| 2 | SC2: First start of 0.4.20 merges each editor's own storage into the state home, idempotent, never overwriting newer, never deleting (SYNC-02) | VERIFIED | `extension.ts:105-111` `configureMigration` then `ensureMigrated(projectRoot)` for a set-up project; lazy `ensureMigrated` in `chat.ts:411,652` and `modelComparisonPanel.ts:60`. `stateMigration.ts` contains no `unlink`, `rm(`, `rmdir` or `rename(` (grep empty). `stateMigration.test.ts` (21 tests) includes source-tree hash identical before and after, run twice gives byte-identical home, newer record kept, A-then-B equals B-then-A, crash-then-rerun equals uninterrupted, old-key transcripts reported locked and migrated later |
| 3 | SC3: Transcripts use a portable per-project data key unlocked from SecretStorage on this device and by recovery code on a new one; a wrong code and a tampered bundle are refused plainly and leave state untouched (SYNC-03, SYNC-04) | VERIFIED | `stateKeys.ts`/`domain/state/keys.ts`/`recoveryCode.ts`/`objects.ts`; `stateRecovery.test.ts` (26 tests): wrong code, flipped wrapped key, flipped manifest, flipped object (with and without rewriting the listed hash), truncated, length-prefix lie, missing object, rolled-back sequence, other state id, huge kdf cost refused before scrypt, and "state home is byte-identical" after each refusal; wrong code on a fresh computer creates no state home (`stateRestoreProfile.test.ts:106`). Key file/SecretStorage/0600/ignored: `stateKeys.test`, `stateApiKey.test` |
| 4 | SC4: Turning sync on shows a high-entropy recovery code once (never stored or logged); on a second machine entering it restores chats, runs, comparisons, model choices and the NEAR AI key, through an encrypted bundle on a dedicated branch (never main); leak test proves no plaintext transcript, key or prompt reaches the remote (SYNC-04, SYNC-05) | VERIFIED (second-machine real run in human list) | Code is 256 bits, 52 chars (D-18) `domain/state/recoveryCode.ts`. `stateRestoreProfile.test.ts:24` tracer: sync on, second computer enters code, gets chat, profile and NEAR AI key. `stateTwoMachines.test.ts:89`: code never written anywhere in the state home. Branch is only `refs/heads/near-ai/state` (`stateTransport.ts:19`, push at line 323, no force; `stateSyncGit` test 112). `stateLeak.test.ts` seeds titles, prompts, tool output, model names, spend, checkpoint text, ids, key bytes in several encodings and the code itself, proves with a positive control that each seeded value was in what was sealed, then scans every blob, tree entry name, commit, message and ref of the bare remote: zero hits; tree names match the opaque pattern; only manifest plus random names; only ref is the state branch |
| 5 | SC5: Opening on another interface or machine shows the Pick up where you left off card (last chat, last run state, GSD phase and next step); one click reopens it; nothing re-runs or spends (SYNC-07) | VERIFIED (UI look and real-host confirmation in human list) | `pickupCard.ts`, `domain/state/pickup.ts`, `media/chat/pickup.js`; wired in `chat.ts:135-168,393-398,497-498,558,607,874` (send on open, write pointer on run end, handle click). Click handler reaches only `openSaved` and `markSeen` (`pickup.test.ts:196,211`), host accepts exactly two card messages (`pickup.test.ts:182`), building the model creates nothing when there is no state home (`pickup.test.ts:85`), phase and next step from `.planning` (`pickup.test.ts:248`), run states from markers across editors (`pickup.test.ts:346`) |
| 6 | SC6: All git work is done and reported in plain words by the extension; two machines merge per record with no lost entries (tested); 0.4.20 ships through the release PR with CHANGELOG and README updated (SYNC-05, SYNC-08) | PARTIAL: sync half VERIFIED; release half PENDING (27-16 Tasks 2-3), not a gap | Plain-word failures: `stateTransport.ts` MESSAGES table (offline, auth, rejected, policy, git-missing, no-remote, invalid-remote), redacted of URL userinfo. No-lost-entries: `threadMerge.test`, `stateMerge.test` (merge laws, property tests with seeded generator), `stateTwoMachines.test.ts:225` simultaneous pushes both end with both threads, lost race retried never forced. README and SECURITY.md updated (see Requirements). CHANGELOG has no `## 0.4.20` section and `package.json` is still 0.4.19: the plan assigns both to Task 3 (release skill), so this is pending, not failed |
| 7 | D-09 extra: nothing identifying leaves the machine in metadata (author, committer, message, names, timestamps) | VERIFIED | `stateGit.ts:31-36` fixed author/committer `near-ai-state` / `state@near-ai.invalid`, dates fixed at 2000-01-01, `STATE_COMMIT_MESSAGE = 'Update encrypted project state'`; `GIT_CONFIG*`, `GIT_AUTHOR_*`, `GIT_COMMITTER_*` stripped from inherited env; hooks, signing, helper transports, fsmonitor switched off; `commit-tree` refused without the identity env (line 117). `stateLeak.test.ts:115` and `stateIdentity.test.ts` assert exactly this on the remote's commits; `stateSyncGit.test.ts:61` proves the person's repository is untouched even if the process env points git at it |
| 8 | D-14 / SYNC-09: Online home is offered and runs only on click; public or private asked each time; fallbacks; separate checked code push | VERIFIED (real GitHub in human list) | `onlineHome.ts` (git init, remote add at line 328 only inside the flow), `onlineHomeVscode.ts:24` single `getSession('github', ['repo'])` for the flow, `codePushCheck.ts`, `domain/state/onlineHome.ts`; `syncFlows` routes no-remote into it (`stateRestoreProfile.test.ts:128`); `stateRemote.test.ts:69` a project with no remote is never given one outside the flow. `onlineHome.test.ts` (14 tests) and `codePushCheck.test.ts` pass |
| 9 | D-16 extra: visible sync control in the chat panel bar in five states, with a dismissible invitation | VERIFIED (look and themes in human list) | `panelView.ts:122-123` real `<button id="sync">` with aria-label plus polite live region; `media/chat/syncControl.js` (textContent only, aria-disabled not disabled while busy); `chat.js:1237-1240` renders `sync-status`; `chat.ts:161,558-568` posts status and routes clicks to `nearAi.sync.turnOn`, `.onlineHome`, `.now`; `chatBridge.ts:66-79,312` validates the message; six commands registered in `syncCommands.ts:175-194` and declared in `package.json:76-101`. `syncControl.test.ts` passes (19/19 per 27-18) |
| 10 | D-17 / D-08 / D-07 / D-12 / D-15 extra: sync timing rules, 5 live conversations with archive, full thread history, 2 MiB cap with marker, sealed NEAR AI key copy | VERIFIED | `syncFlows.ts` plus `syncFlows.test` (fake clock; no sync during a run, coalescing, backoff, interval clamp, deactivate bounded); `historyRetention.test`, `threadArchive.test`, `archiveMerge.test`, `stateLazyFetch.test`; `threadLog`/`threadReplay` tests; `TOOL_RESULT_CAP_BYTES = 2 MiB` (`threadEntries.ts:160`) with "output shortened, N MB" (`threadView.ts:108`); `stateApiKey.ts` hooked into auth at `extension.ts:84-91`, `stateApiKey.test` (sentinel scan, tamper, swap, rotation, removal). Settings declared with the exact ranges: `package.json:551-570`; `nearAi.sync.remote` correctly not declared (deferred by D-09; `stateRemote.test.ts:51`) |

**Score:** 5 of 6 roadmap criteria fully verified; SC6 is verified for sync and pending for the release. 4 of 4 additional decision truths verified. 0 truths present-but-behavior-unverified (every state-transition and ordering invariant has a named passing test).

### Deferred Items

None. The pending release work is in-phase (plan 27-16), not deferred to a later phase.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/domain/state/{recoveryCode,keys,objects,merge,records,threadEntries,threadView,threadCapture,retention,pickup,onlineHome,syncStatus,archiveProblem}.ts` | Pure crypto, merge and view core | VERIFIED | Present, substantive, imported by services |
| `src/services/state{Home,Keys,ApiKey,Records,Migration,Git,Transport,MirrorLock,Sync,Restore}.ts` | State home, key, migration, git transport, sync | VERIFIED | Present and wired (extension.ts, chat.ts, syncCommands.ts) |
| `src/services/{threadStore,threadArchive,participantRecorder,modelChoices,pickupCard,syncFlows,syncCommands,syncPanel,onlineHome,onlineHomeVscode,codePushCheck,spendMirror}.ts` | History, choices, pick-up, sync UX, online home | VERIFIED | Present and wired |
| `media/chat/{pickup,syncControl}.js`, `chat.js`, `chat.css`, `panelView.ts` | Webview pieces | VERIFIED | Loaded by panelView, rendered from host messages |
| `README.md`, `SECURITY.md` | Marketplace text and encryption model | VERIFIED | See Requirements |
| `CHANGELOG.md` `## 0.4.20`, `package.json` 0.4.20 | Release content | PENDING | Plan 27-16 Task 3 |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `extension.ts` | migration | `configureMigration` + `ensureMigrated` | WIRED | lines 105-111, 232 |
| `extension.ts` | sealed NEAR AI key copy | `auth.keyCopy = apiKeyCopyHooks(...)` | WIRED | lines 84-91 |
| `extension.ts` | sync commands and close flush | `registerSyncCommands`, `flushSyncOnClose` | WIRED | lines 205, 436 |
| `chat.ts` | pick-up card and sync chip | `pickup.send`, `syncPanelMessage`, run-end hooks | WIRED | see truths 5 and 9 |
| `settings.ts` | project model choices | `projectChoiceFor` + `resolveSetting` | WIRED | all model settings resolve project-level |
| `modelComparisonPanel.ts` | state home | `ComparisonStore` primary = `home.paths.comparisons`; apply writes project choice | WIRED | |
| `stateTransport` | remote | plumbing into a private mirror, push `commit:refs/heads/near-ai/state`, no force | WIRED | |
| `package.json` 0.4.20 -> `package-lock.json` | release bump | `prepare-release.mjs bump` | PENDING | Task 3 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| Sync chip | status model | `currentSyncStatus(root)` fed by syncFlows runtime | Real runtime status, `off` when no runtime | FLOWING |
| Pick-up card | `pickupCardModel` | pointer file + thread index + run markers + `.planning` | Reads real stores; nothing when no state home | FLOWING |
| History list | thread index | `threadStoreFor(...).index()` from state home | Real index, locked and archived labelled | FLOWING |
| Compare Models | comparisons and choices | `ComparisonStore` over the home, choices file | Real files | FLOWING |

### Behavioral Spot-Checks

Run from the worktree, memory capped and with an empty HOME, targeted files only (the full suite and e2e were run earlier by plan 27-16 Task 1 and were not repeated).

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Type check | `npx tsc -p tsconfig.json` (capped) | exit 0, no output | PASS |
| All phase-27 test files (33 files: state*, thread*, archive*, participantRecord, historyRetention, pickup, modelChoices, runMarkersForeign, activityShared, onlineHome, codePushCheck, sync*, modelComparisonPage) | `node --test <33 dist/test files>` (capped, HOME=empty dir) | tests 388, pass 388, fail 0, cancelled 0, skipped 0 | PASS |
| Debt markers | grep `TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER` over the 75 non-test files changed since origin/main | no matches | PASS |
| Test integrity | read `stateLeak.test.ts`, `stateRecovery.test.ts`, `stateSyncGit.test.ts` | Positive controls present (planted sentinel is found; seeded values proven to be in the sealed payload); refusal tests assert byte-identical state | PASS |

### Probe Execution

Step 7c: SKIPPED. No probe scripts are declared by the phase plans and none exist under `scripts/*/tests/probe-*.sh`.

### Requirements Coverage

Plan frontmatter IDs: SYNC-01 (plans 02, 03, 04, 05, 06, 07, 08, 10, 13), SYNC-02 (10), SYNC-03 (01, 03, 15), SYNC-04 (01, 12, 15, 18), SYNC-05 (01, 02, 11, 12, 13, 15, 18), SYNC-06 (09), SYNC-07 (04, 14), SYNC-08 (16), SYNC-09 (15, 17, 18). All nine IDs are claimed by at least one plan and defined in `.planning/REQUIREMENTS.md` lines 201-209. No orphans.

| Requirement | Source Plans | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| SYNC-01 | 02-08, 10, 13 | Project-local state home, full history, 5 live plus archive | SATISFIED | Truth 1 and 10 |
| SYNC-02 | 10 | Safe migration | SATISFIED | Truth 2 |
| SYNC-03 | 01, 03, 15 | Portable encryption | SATISFIED | Truth 3 |
| SYNC-04 | 01, 12, 15, 18 | Recovery code, KDF, wrapped key, refusals | SATISFIED | Truths 3, 4 |
| SYNC-05 | 01, 02, 11-13, 15, 18 | Git sync, merge, leak test, anonymous identity | SATISFIED | Truths 4, 6, 7 |
| SYNC-06 | 09 | Model choices follow the project | SATISFIED (real-host check in human list) | Truth 1 |
| SYNC-07 | 04, 14 | Pick-up card | SATISFIED (UI check in human list) | Truth 5 |
| SYNC-08 | 16 | Release 0.4.20 with CHANGELOG and README | PENDING (human_needed): README and SECURITY.md done in Task 1 (README names all three settings, "file permissions" sentence, online home, git-host table, troubleshooting; SECURITY.md has key hierarchy, scrypt parameters, AES-256-GCM, no escrow, anonymous commits, residual leaks, old-code caveat, post-quantum note; zero "NEAR organization"); CHANGELOG `## 0.4.20`, version bump, release PR, tag and owner approval not yet done (Tasks 2-3) | `package.json` version 0.4.19; `grep "^## 0.4.20" CHANGELOG.md` empty; REQUIREMENTS.md leaves SYNC-08 unchecked, correctly |
| SYNC-09 | 15, 17, 18 | Online home in one click | SATISFIED (real GitHub in human list) | Truth 8 |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | | No TBD/FIXME/XXX/TODO/HACK/placeholder in phase-modified non-test files | none | |

### Advisory observations (not blocking)

- `27-VALIDATION.md` frontmatter is still `status: draft`, `nyquist_compliant: false`, `wave_0_complete: false` and its sign-off checklist is unticked, although every Wave 0 test file it lists exists and passes. Update it at the phase boundary.
- 27-17's SUMMARY says there is one `getSession('github', ['repo'])` call site. There are two: `onlineHomeVscode.ts:24` (the online-home flow) and `syncCommands.ts:63` (the silent or click-time token for pushes, added by 27-15). Both are legitimate and the token never goes into git arguments (`syncMirrorCredentials.test`), but the summary wording is slightly off.
- `deferred-items.md` lists ten other writers still using pid-only temporary names (`.tmp-${process.pid}`) that can collide between a code-server container and the host editor. None is in the state home; they are noted for a follow-up, not a Phase 27 gap.
- `ROADMAP.md` shows 17/18 plans and 27-16 unchecked: expected until Task 3 finishes.
- Pre-existing, not caused by this phase: `chatSendPath.test.js` reads the person's real home Teams library (noted in `deferred-items.md`); the gate runs it with an empty HOME.

### Prohibitions

| Statement (27-16) | Verification | Status |
|-------------------|--------------|--------|
| MUST NOT push directly to main or publish to the Marketplace without the owner's approval in GitHub | judgment | UNVERIFIED, flagged: no PR or publish has happened yet, so nothing violates it; the flag clears only after Task 3 shows both PRs squash-merged and the publish approval was given by the owner. Non-authoritative review: `git log origin/main..HEAD` shows only feature-branch commits and this session pushed nothing |

### Human Verification Required

See the `human_verification` list in the frontmatter (10 items). In short: the real two-editor and two-machine scenario of 27-16 Task 2, the webview look in three themes, the VS Code glue marked `human_judgment` in the SUMMARYs of 27-03, 04, 05, 06, 07, 08, 09, 10, 13, 14, 15, 17 and 18, a real GitHub online-home run, and the 27-16 Task 3 release steps. 27-01 D1 (owner's D-18 decision) is a recorded decision, already satisfied.

### Gaps Summary

No gaps. Nothing the phase promised is missing, stubbed or unwired in the code. The phase cannot be called passed yet because (a) several outcomes can only be observed in real editors, on a real remote and on a real GitHub account, which the plans themselves reserve for the owner (27-16 Task 2), and (b) SYNC-08's release steps (version bump, CHANGELOG `## 0.4.20`, feature PR, release PR, v0.4.20 tag, owner's publish approval) belong to 27-16 Task 3 and have not run. Re-run this verification after 27-16 completes to move the status to `passed`.

---

_Verified: 2026-11-13_
_Verifier: Claude (gsd-verifier)_
