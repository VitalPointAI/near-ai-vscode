---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 10
subsystem: state-sync
tags: [migration, state-home, idempotent, spend-mirror, old-key, retention]

requires:
  - phase: 27-project-state-follows-the-project-across-interfaces-and-machines
    provides: "27-02 unionLog and entry ids; 27-03 stateHomeFor and writeFileAtomic; 27-04 run markers and checkpoint format 2; 27-05/06 ThreadStore; 27-07 applyRetention and onRunEnded; 27-08 participant threads; 27-09 ComparisonStore with a state-home folder"
provides:
  - "src/services/stateMigration.ts: MigrationSources, MigrationReport, MigrationOptions, emptyReport, changesIn, PARTIAL_BEFORE_0_4_20, migrateEditorStorage, MigrationContext, MigrationExtras, configureMigration, ensureMigrated"
  - "src/services/spendMirror.ts: mirrorProjectSpend, readProjectSpend, formatProjectSpend, projectSpendSection, ProjectSpendMonth"
  - "src/services/threadStore.ts: ThreadStore.importThread, ImportedThread, ImportOutcome"
  - "src/services/transcripts.ts: TranscriptStore read-only mode, projectFolderHash"
  - "src/services/chat.ts: openConversationIds"
  - "src/test/helpers/legacyStorage.ts: legacyEditor, hashTree, savedRunFixture"
affects: [27-12, 27-13, 27-15, 27-16, sync, restore, pickup-card]

actuals:
  tokens: 24843
  tasks: 3
  commits: 4
plan_head_before: e3263072f0babbe1bd4c277cf0ce1b48f29c0d8e
plan_head_after: 1e63c8c20e3d6f1a339e43b77d7b5c11928889ae

tech-stack:
  added: []
  patterns:
    - "Each kind of record merges by its own id and rule (thread entries by union, markers by last sign of life, checkpoints and comparisons when absent or later, spend by entry id and version), so a second run writes nothing and A-then-B equals B-then-A"
    - "The source storage is opened read-only: a read-only TranscriptStore that does not re-save an old plain transcript, no use of RunCheckpoints.load (it sweeps temporary files), and a tree-hash test that proves nothing was added, changed, moved or removed"
    - "A per-item failure never stops the run: an unreadable or sealed-elsewhere conversation is counted locked and retried next start, a malformed file is counted skipped; only the test hook can end a run, as a crash would"

key-files:
  created:
    - src/services/stateMigration.ts
    - src/services/spendMirror.ts
    - src/test/helpers/legacyStorage.ts
    - src/test/stateMigration.test.ts
  modified:
    - src/services/threadStore.ts
    - src/services/transcripts.ts
    - src/services/chat.ts
    - src/services/modelComparisonPanel.ts
    - src/services/runReportCommand.ts
    - src/extension.ts

key-decisions:
  - "Spend lines are selected by entry id, not by the project tag on each line: a ledger entry's later versions (ended, tokens, final estimate) carry no project tag, so filtering lines by proj would drop them and leave an entry the ledger itself ignores"
  - "unionLog is applied to lines keyed by (entry id, version) rather than by entry id alone: keeping only the highest version of an id would discard the first line, which holds the entry's time, path and project, and SpendLedger ignores an entry whose first line is missing; settled costs are kept as distinct lines and ordered by key so the ledger reads the same file the same way"
  - "The old transcript key is read from SecretStorage without creating one: sharedTranscriptKey would make and store a fresh key for an editor that never had one, which can open nothing and adds a secret"
  - "A run marker from the editor replaces one in the state home when it is later by (endedAt or activeAt), an ended marker winning a tie; so a run in flight at upgrade is offered for resume even when the other editor's earlier run of that conversation had ended"
  - "Entries of a migrated conversation keep the first copy written (its writer and time are provenance, not part of the entry id); the logical state is the same whichever editor migrates first, and the order test compares ids, parents, roles and bodies"
  - "A migrated conversation that already exists in the archive is not brought back: missing entries go to the archive's delta file, the saved context and meta are left"
  - "meta.migrated records a hint that this editor's storage was merged, only when something changed and nothing is locked; nothing reads it, so correctness never depends on it"
  - "A tab saved by 0.4.19 triggers the merge before tabs reopen, so a conversation that was open at upgrade comes back with its history"

patterns-established:
  - "Pattern: ensureMigrated is a cached promise per project per extension host and never rejects; callers in a person's action (chat send, history, Compare Models) just await it"
  - "Pattern: a service that reads vscode-bound things takes a structural context type (MigrationContext) so it runs on plain node in tests"

requirements-completed: [SYNC-02, SYNC-01]

coverage:
  - id: D1
    description: "An old-key conversation from one editor becomes a full thread (entries, saved working list, meta) that an editor without the old key lists and opens, with the source folder's tree hash unchanged"
    requirement: SYNC-02
    verification:
      - kind: unit
        ref: "dist/test/stateMigration.test.js#tracer: code-server's old-key conversation becomes a full thread that another editor with no old key opens"
        status: pass
      - kind: unit
        ref: "dist/test/stateMigration.test.js#migration never touches the editor storage: the hash of its tree is the same before and after, plain and sealed transcripts alike"
        status: pass
    human_judgment: false
  - id: D2
    description: "Idempotent and never older over newer: a second run reports zero changes with a byte-identical state home; a conversation continued in the state home keeps its later context, time and title; the same conversation from two editors is one thread and a divergent one keeps both lines"
    requirement: SYNC-02
    verification:
      - kind: unit
        ref: "dist/test/stateMigration.test.js#running the migration twice: the second run reports zero changes and the state home is byte for byte the same"
        status: pass
      - kind: unit
        ref: "dist/test/stateMigration.test.js#migration never replaces newer: a conversation continued in the state home keeps its later context, its later time and its title"
        status: pass
      - kind: unit
        ref: "dist/test/stateMigration.test.js#the same conversation in both editors is one thread; one continued differently in each keeps both lines and loses nothing"
        status: pass
    human_judgment: false
  - id: D3
    description: "A sealed transcript with no old key (or the wrong one) is reported locked, left in place, no key is created for the editor, and the next start migrates it once the key is there; a summarised conversation is marked partial-before-0.4.20"
    requirement: SYNC-02
    verification:
      - kind: unit
        ref: "dist/test/stateMigration.test.js#a transcript whose old key is not here is reported locked, left in place, and migrated by the next run once the key is there"
        status: pass
      - kind: unit
        ref: "dist/test/stateMigration.test.js#an editor that never had an old key does not get one made for it, and a locked conversation is tried again after a new start"
        status: pass
      - kind: unit
        ref: "dist/test/stateMigration.test.js#a conversation marked partial when its earlier messages were summarised away, and a plain one is not"
        status: pass
    human_judgment: false
  - id: D4
    description: "Run markers (a run in flight at upgrade is offered for resume), this project's checkpoints (format 2, project-relative, loadable), saved comparisons and project spend (every version of an entry, never another project's) reach the state home; Team Mode, cyber, the runtime and the emergency stop are not touched"
    requirement: SYNC-02
    verification:
      - kind: unit
        ref: "dist/test/stateMigration.test.js#run markers: a run in flight at upgrade is offered for resume, a later marker in the state home is kept, a malformed one is skipped"
        status: pass
      - kind: unit
        ref: "dist/test/stateMigration.test.js#checkpoints: only this project's are copied, as format 2 with paths relative to the project, and they load and revert on any machine"
        status: pass
      - kind: unit
        ref: "dist/test/stateMigration.test.js#comparisons: saved runs are copied when absent, a damaged or unrelated file is skipped, and a newer run in the state home is kept"
        status: pass
      - kind: unit
        ref: "dist/test/stateMigration.test.js#spend: this project's entries are mirrored with every later version of them, never another project's, and the history adds up across editors"
        status: pass
      - kind: unit
        ref: "dist/test/stateMigration.test.js#Team Mode, cyber, the runtime and the emergency stop in the editor storage are left alone and not migrated"
        status: pass
    human_judgment: false
  - id: D5
    description: "Order and crash: editor A then B equals B then A; a crash after two conversations then a rerun equals an uninterrupted run; malformed files are skipped and counted without stopping the rest"
    requirement: SYNC-02
    verification:
      - kind: unit
        ref: "dist/test/stateMigration.test.js#migrating editor A then B gives the same state as B then A"
        status: pass
      - kind: unit
        ref: "dist/test/stateMigration.test.js#a crash after the first two conversations, then a rerun, ends equal to an uninterrupted run"
        status: pass
      - kind: unit
        ref: "dist/test/stateMigration.test.js#malformed files are skipped and counted, and never stop the rest from migrating"
        status: pass
    human_judgment: false
  - id: D6
    description: "The 5-live rule after migration: eight conversations leave five live and three archived with all eight listed; a rerun brings none back; an open tab's conversation stays live; an archived one gains missing entries in its archive and stays archived"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/stateMigration.test.js#after migration the 5-live rule applies: eight conversations leave five live and three archived, all eight listed, and a rerun brings none back"
        status: pass
      - kind: unit
        ref: "dist/test/stateMigration.test.js#an archived conversation is not brought back by a second migration, and entries it lacks are added to its archive"
        status: pass
    human_judgment: false
  - id: D7
    description: "ensureMigrated runs once per project, logs counts only, creates nothing for an editor with nothing to migrate; the run report gets a Project spend history section from every editor and none without a state home; the daily spend limit path is untouched"
    requirement: SYNC-01
    verification:
      - kind: unit
        ref: "dist/test/stateMigration.test.js#ensureMigrated runs once per project, logs only counts, and an editor with nothing to migrate leaves the project untouched"
        status: pass
      - kind: unit
        ref: "dist/test/stateMigration.test.js#the run report gets a project spend history section from every editor, and a project with no state home gets none"
        status: pass
      - kind: command
        ref: "git diff --quiet HEAD -- src/services/spendAccount.ts src/services/spendingLimits.ts"
        status: pass
    human_judgment: false
  - id: D8
    description: "On the owner's real host, both editors' old chats (code-server's five transcript folders and the 2026-11-12 comparison, desktop to 2026-11-06) appear in both editors after each runs 0.4.20 once; the activation, chat-send, history and Compare Models call sites behave in the real extension host"
    verification: []
    human_judgment: true
    rationale: "The vscode-bound wiring (activation, the send handler, the history command, the Compare Models panel, the run-end listener) is covered by tsc and by the pure service tests, not by an extension-host test; the two-editor result on real data is the 27-VALIDATION manual-only row and must not be tested against the owner's real folders from an agent"

duration: 16min
completed: 2026-11-13
status: complete
---

# Phase 27 Plan 10: Each editor's old data merges into the shared state home Summary

**Each editor's own globalStorage (conversations sealed with its old install-local key, run markers, checkpoints, comparisons and this project's spend) is merged into the project's state home by record id, read-only on the source, idempotent, in any order of editors, never over a newer record, with the 5-live rule applied at the end, and the project's spend history shown in the run report.**

## Performance

- **Duration:** 16 min
- **Started:** 2026-11-13T15:50Z
- **Completed:** 2026-11-13T16:06Z
- **Tasks:** 3 (tracer, then a TDD task and a wiring task)
- **Files modified:** 10 (4 created, 6 modified)

## Accomplishments

- `migrateEditorStorage` reads the editor's transcripts through a read-only `TranscriptStore` (it never saves, and reading an old plain transcript no longer re-saves it encrypted in the source folder), builds the thread entries from the start with `messagesToEntries`, and merges each through the new `ThreadStore.importThread`: entries by id, the saved working list only when later, the meta merged so a conversation continued since is never set back, nothing written when nothing is new, an archived conversation left archived with the missing entries in its archive delta file. A conversation whose model list begins with a summary is marked `partial-before-0.4.20`.
- Markers, this project's checkpoints (by activity run id or a path inside the project, written as format 2), saved comparisons and the project's spend lines follow the same rule of "add or take the later, never replace newer". A run in flight at upgrade, whose marker 0.4.20 no longer reads from the old place, can again be offered for resume.
- `ensureMigrated(root)` is one cached promise per project per extension host: it runs at activation for a NEAR AI project, and for any other folder on the first chat send, history list or Compare Models open, and before tabs reopen when 0.4.19 left saved tabs. It logs counts only. A locked item is tried again the next time the editor starts.
- After every run, the project's spend from this editor's ledger is mirrored into the state home; the run performance report appends a "Project spend history" section from every editor. `spendAccount.ts` and `spendingLimits.ts` are unchanged, so the daily limit still counts only this editor's ledger (D-11).

## Task Commits

1. **Task 1: Tracer, code-server's old-key transcript becomes a full thread that desktop opens** - `3786a61` (feat). Verified end to end (4 tests, 0 failing; threadLog, threadArchive and conversations still pass) before expansion.
2. **Task 2: markers, checkpoints, comparisons, spend, order, crash, retention** - RED `2a58fea` (test, 7 of 18 failing for the intended reason), GREEN `1395718` (feat, 18 of 18)
3. **Task 3: when it runs, spend mirrored after every run, spend history in the run report** - `1e63c8c` (feat)

**Plan metadata:** the docs commit that carries this SUMMARY, STATE.md and ROADMAP.md.

## Files Created/Modified

- `src/services/stateMigration.ts` - the migrator, the report, `configureMigration`, `ensureMigrated`
- `src/services/spendMirror.ts` - mirror, reader, formatter, `projectSpendSection`
- `src/services/threadStore.ts` - `importThread` and its types
- `src/services/transcripts.ts` - read-only mode, `projectFolderHash`
- `src/services/chat.ts`, `src/services/modelComparisonPanel.ts`, `src/services/runReportCommand.ts`, `src/extension.ts` - wiring
- `src/test/helpers/legacyStorage.ts`, `src/test/stateMigration.test.ts` (20 tests)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Spend lines selected by entry id, not by the project tag on each line**
- **Found during:** Task 2 (reading `SpendLedger.start`, `finish` and `apply`)
- **Issue:** The plan filters spend lines by `proj === projectScopeId` and merges with `unionLog` by (id, highest version). Only the first line of an entry carries `proj`; later lines carry only what changed, and a ledger entry whose first line is missing is ignored on read. Filtering by line would have dropped every finish line (tokens, final estimate), and keeping only the highest version would have dropped the first.
- **Fix:** An entry is the project's when any line of its id carries the tag; all its lines are copied, `unionLog` is keyed by (id, version), and a settled cost is copied when its request is the project's. The mirror also keeps the ids it already holds, so a run that began last month and ended this month is not lost.
- **Files modified:** `src/services/spendMirror.ts`
- **Verification:** the spend test asserts both versions of an entry are in the mirror, another project's entry and cost are not, and the monthly totals (including an entry that began in October and ended in November) are right.
- **Commit:** `1395718`

**2. [Rule 2 - Missing critical] TranscriptStore could rewrite the source**
- **Found during:** Task 1 (reading `TranscriptStore.read`)
- **Issue:** Reading a transcript saved before encryption re-saves it encrypted, which would have changed the editor's own folder and broken "never modify globalStorage".
- **Fix:** a read-only mode (`save` and `checkpoint` refuse, reading does not re-save), used only by the migration; `projectFolderHash` is exported so the migrator finds the same folders.
- **Files modified:** `src/services/transcripts.ts`
- **Verification:** the tree-hash test with a plain transcript.
- **Commit:** `3786a61`

**3. [Rule 2 - Missing critical] No old key is created**
- **Found during:** Task 3 (reading `sharedTranscriptKey`)
- **Issue:** The plan reads the old key through `sharedTranscriptKey`, which creates and stores a fresh key when there is none. An editor that never had one would gain a secret that opens nothing.
- **Fix:** the key is read with `secrets.get` and used only when it is 32 bytes; otherwise the sealed transcripts are counted locked.
- **Files modified:** `src/services/stateMigration.ts`
- **Verification:** the keyless-editor test asserts no `nearAi.transcripts.key` appears.
- **Commit:** `1395718`, `1e63c8c`

**4. [Rule 2 - Missing critical] Open tabs and tabs saved by 0.4.19**
- **Found during:** Task 3
- **Issue:** The 5-live step could archive a conversation open in a tab, and a tab saved by 0.4.19 reopens from the state home before its history is merged in.
- **Fix:** `openConversationIds` (exported from `chat.ts`) is passed to `configureMigration` as the protected ids, and the chat's start-up awaits `ensureMigrated` when saved tabs exist.
- **Files modified:** `src/services/chat.ts`, `src/extension.ts`
- **Commit:** `1e63c8c`

**Total deviations:** 4 auto-fixed (1 bug, 3 missing critical). **Impact:** no scope change; all four protect the "never lose or change the source" and "never lose spend history" promises.

## Authentication Gates

None.

## Issues Encountered

- The known `chatSendPath.test.js` "GSD slash command" failure is unchanged (it reads the real home Teams library); the 61 other tests of chat, send path, spend send path, run report, comparison page, participant recording and state stores pass.
- The spend mirror reads at most the newest 24 months of the project's history in the report. A spend entry billed through a profile linked from another project carries that project's tag and is not attributed here.

## Known Stubs

None.

## Threat Flags

None. The plan's threat register is covered: T-27-37 (tree-hash, merge-by-id and never-newer tests), T-27-38 (attribution by activity run id or a path inside the project; spend by entry id of the project tag), T-27-39 (the log test searches for a sentinel title and text), T-27-40 (malformed files skipped and counted), T-27-41 (the spend limit files are unchanged).

## Next Phase Readiness

Ready for 27-11 onward. The state home now holds each editor's old conversations, markers, checkpoints, comparisons and the project's spend history, so sync and the pick-up card can read one source. The manual two-editor check on the owner's real data is still to do at the phase gate.

## Self-Check: PASSED

- Files: `src/services/stateMigration.ts`, `src/services/spendMirror.ts`, `src/test/helpers/legacyStorage.ts`, `src/test/stateMigration.test.ts` exist.
- Commits `3786a61`, `2a58fea`, `1395718`, `1e63c8c` are ancestors of HEAD; `git rev-list --count e326307..HEAD` is 4.
- Acceptance: stateMigration 20 of 20; `grep -cE "\b(rm|unlink|rmdir|rename)\(" src/services/stateMigration.ts` is 0; `grep -c unionLog src/services/spendMirror.ts` is 4; `ensureMigrated(` is in extension.ts (2), chat.ts (2), modelComparisonPanel.ts (1); `mirrorProjectSpend` in extension.ts (2); the spend limit files have no diff.
- Plan verification: tsc clean; stateMigration, threadLog, modelChoices and conversations 76 of 76.
