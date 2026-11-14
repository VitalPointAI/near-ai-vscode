---
gsd_state_version: "1.0"
milestone: v0.7.0
milestone_name: Messaging relay — Teams and Signal
current_phase: 27
current_phase_name: Project state follows the project across interfaces and machines (0.4.20)
status: planning
stopped_at: Completed gap-closure plans 27-26..27-36 (full gate green)
last_updated: "2026-11-13T23:26:49.940Z"
state_head: 3110b24ca269ea278e1d7bb66bee43177cbc3a9a
progress:
  total_phases: 9
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
last_activity: 2026-11-13
last_activity_desc: "Completed quick task 261113-lbo: fix the chat task list not checking off finished tasks"
---

# Project State

## Current position

Milestone: v0.7.0 Messaging relay — Teams and Signal (Phases 68-76)
Phase: 27 (Project state follows the project across interfaces and machines (0.4.20)) — EXECUTING
Next: PR #40 re-review and merge, then 27-16 (release 0.4.20); then Phase 68 Relay foundation

## Accumulated Context

### Roadmap Evolution

- Phase 27 inserted 2026-11-13 in the 0.4.x line, ahead of v0.7.0 Phase 68: project state follows the project across interfaces and machines, shipping as release 0.4.20 (SYNC-01…08). Its decisions are in 27-CONTEXT.md.

- Milestone v0.7.0 added 2026-11-13: Messaging relay — Teams and Signal. Phases 68-76 map all 45 v0.7.0 requirements (RELAY, AUTH, IDNT, RUNL, CMND, GRP, BUDG, TEAM, SGNL, OPS); traceability table in REQUIREMENTS.md.
- Phase numbering starts at 68: branch-shipped phases end at 26; the unmerged `feat/team-fix-pass` branch already claims Phases 60-67 for v0.6.0 — 68 keeps both honest.
- Phase 26 completed on branch perf/research-runs: Performance — faster agent and research runs (PERF-01…07, 5 plans, verified).
- Phase 25 (Cybersecurity harness, CYBER-01…12) moved 2026-11-13 out of the 0.4.x line into its own milestone v0.8.0 Cybersecurity, worked after v0.7.0. All 8 plans are executed; 25-UAT.md is parked at test 2 of the list, and the owner's review of the 12 regional disclaimers is still to do.

### Locked decisions (encode, do not re-litigate)

- Relay = new workspace `relay/`, owner-hosted, multi-tenant; Node 26.13.1 + separate lockfile; extension stays Node 24 + zero-dep bundle.
- Exactly one new runtime dep: `jose`. No HTTP framework, no Bot Framework SDK, no SQLite package (`node:sqlite`, JSON-file-per-tenant fallback — RC in Node 26), no test framework (`node:test`).
- Signal via pinned `signal-cli-rest-api` sidecar container; pin the exact signal-cli version.
- Group visibility result-only (ack + finished result); work detail stays in requester's private 1:1/thread.
- Bot is an external app installed by a customer admin; never joins the customer's Microsoft org.
- Per-tenant budget cap always on; per-conversation cap defaults to unlimited.
- IN scope: Teams in-group streaming, admin onboarding runbook, two-way attachments. OUT: rich Adaptive-Card status UI.

### Naming trap

- This milestone = messaging relay at `relay/` — NOT the paused v0.5.0 ciphertext sync relay (RELAY-01/02 archived in `.planning/milestones/v0.5.0-paused/`) and NOT `relayTransport.ts` board sync (unmerged branch).
- REQ-ID collision: v0.5.0 used RELAY-01/02 for ciphertext sync; scope as "v0.7.0 RELAY-01/02" + the one-line note already in REQUIREMENTS.md. Do not rename requirement IDs there.

### Reuse pointers

- Durable restart: `src/services/runMarkers.ts` (NOT `runActivity.ts`); `AUTO_RESUME_WITHIN_MS`=12h, `MAX_AUTO_RESUMES`=3.
- `src/agent/` has zero `vscode` imports — safe reuse surface for headless composition.
- `src/services/chat.ts` is UI-bound — the relay must NOT import it.

### Research flags (embedded in phases)

- Teams in-group streaming undocumented → spike with post-don't-stream fallback (Phase 71; TEAM-03 already permits discrete updates).
- Pin exact `signal-cli` version; verify sidecar image's bundled signal-cli age (Phases 68, 75).
- Headless harness composition never done → first runner-child boot is a spike (Phase 71).
- Proactive 1:1 after group @mention depends on bot install scope — highest derail risk; fallback recorded in Phase 74 and carried into Phase 76 threat model.

### Blockers/Concerns

None yet.

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 261113-lbo | fix the chat task list not checking off finished tasks | 2026-11-13 | a770848 | [261113-lbo-fix-the-chat-task-list-not-checking-off-](./quick/261113-lbo-fix-the-chat-task-list-not-checking-off-/) |

## Notes

- v0.5.0 (trusted-source knowledge base) is paused and moving to a separate project. Archive: `.planning/milestones/v0.5.0-paused/`. Code: local branch `gsd/phase-13-sovereignty-gate-post-quantum-cryptography-and-the-encrypted` (not pushed).
- Release checklist for 0.4.x: tsc, lint, full `npm test`, full `npm run test:e2e` (both scenarios), `npm run verify:release`, then publish only with the owner's OK for that version.

## Session

**Last session:** 2026-11-13T20:02:28.913Z
**Stopped at:** Completed 27-22-PLAN.md
**Resume file:** None

## Performance Metrics

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 27 P02 | 13 min | 3 tasks | 12 files |
| Phase 27 P01 | 8 min | 3 tasks | 7 files |
| Phase 27 P03 | 11min | 3 tasks | 15 files |
| Phase 27 P04 | 11 min | 3 tasks | 12 files |
| Phase 27 P09 | 28min | 3 tasks | 11 files |
| Phase 27 P11 | 9 min | 3 tasks | 8 files |
| Phase 27 P05 | 10 min | 3 tasks | 9 files |
| Phase 27 P17 | 11 min | 3 tasks | 7 files |
| Phase 27 P06 | 20 min | 3 tasks | 14 files |
| Phase 27 P07 | 10 min | 3 tasks | 9 files |
| Phase 27 P08 | 6 min | 2 tasks | 6 files |
| Phase 27 P10 | 16 min | 3 tasks | 10 files |
| Phase 27 P12 | 70min | 3 tasks | 12 files |
| Phase 27 P13 | 65min | 3 tasks | 11 files |
| Phase 27 P14 | 40min | 3 tasks | 13 files |
| Phase 27 P15 | 30 min | 3 tasks | 21 files |
| Phase 27 P18 | 25min | 3 tasks | 14 files |
| Phase 27 P19 | 8 min | 2 tasks | 3 files |
| Phase 27 P20 | 25 min | 2 tasks | 4 files |
| Phase 27 P21 | 25min | 2 tasks | 2 files |
| Phase 27 P22 | 34 min | 3 tasks | 10 files |

## Decisions

- [Phase 27]: 27-02: mergeRecordSets is a set function (family grouping, dedupe by rev, supersede, tombstones, canonical fork placement), not a pairwise fold, so merge order cannot change the result
- [Phase 27]: 27-02: the newest tombstone of each id is always kept and liveRecords() hides it; thread entries are keyed by (thread,id) and the earliest copy is kept
- [Phase 27]: 27-01: recovery code is 256 random bits, 52 Crockford characters in 13 groups of 4, zero pad bits refused when non-zero (owner, D-18); sync format is symmetric-only so post-quantum safe by construction
- [Phase 27]: 27-01: kdf bounds also cap scrypt memory at 256 MiB; the 1 MiB manifest cap binds before the 10 000-entry cap (about 5 000 entries)
- [Phase 27]: 27-03: exclusive create is temp file plus hard link (wx fallback), so a reader never sees a partial key or meta file; ensure() repairs a missing inner .gitignore
- [Phase 27]: 27-03: a SecretStorage data key is trusted only against meta.keyCheck; transcriptKey() is the writer path, dataKey() the non-creating reader path
- [Phase 27]: 27-03: the sealed NEAR AI key copy is asked once per scope per host, released only to its sealed endpoint; no sync remote setting declared (D-09)
- [Phase 27]: 27-04: run liveness across editors by writer id plus 30 s heartbeat; the pid is trusted only for the same editor, any other editor's run is live while its marker is under 3 minutes old — A pid from another editor lives in another pid namespace (code-server container); trusting it caused double spend
- [Phase 27]: 27-04: only this editor's cut-off markers reach autoResumeChoice; another editor's cut-off run keeps its Resume button (SYNC-07); markers written to the old per-extension storage by 0.4.19 are no longer read — Spending money on a foreign run always takes the person's click (D-03)
- [Phase 27]: 27-04: checkpoints are format 2 (root-relative inside the project, absolute and marked outside), a relative path that is absolute or climbs out is refused on load; sub-agent worktrees stay in the editor's own storage — Checkpoints must be portable between editors and machines without a revert ever writing outside the project (T-27-17)
- [Phase 27]: 27-09: import offer lists only settings with no project choice, so an existing project choice is never replaced by the import
- [Phase 27]: 27-09: applying with no folder open and no explicit workspace value is refused rather than writing user settings (D-06)
- [Phase 27]: Sync commit identity is near-ai-state at the constant date 2000-01-01, set only on commit-tree; runStateGit refuses commit-tree without all six identity pairs
- [Phase 27]: Remote-facing StateTransport methods return Outcome<T> with a SyncFailure of one plain sentence; local reads throw StateRefusedError; MirrorBusyError propagates for the caller to word
- [Phase 27]: Remote addresses are validated when typed and again when a configured name resolves, so a hostile repository remote such as ext:: is refused
- [Phase 27]: Inherited GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY, GIT_CONFIG*, GIT_AUTHOR_* and GIT_COMMITTER_* are stripped inside runStateGit before options.env is applied
- [Phase 27]: 27-05: new thread entries chain from the entry the conversation last wrote or was opened at (ThreadStore.cover), not the log's global main-line tip, so a continuation made elsewhere becomes a branch — Chaining from the global tip would adopt another editor's concurrent entries into this conversation's lineage; an un-covered store re-chains from the start and entry ids dedupe
- [Phase 27]: 27-05: the thread log is captured before manageContext and on every save; a capture failure never stops a run, and managed messages are marked logged only when their originals were captured — The log must hold the untrimmed originals (D-07) without ever making a model run depend on disk writes
- [Phase 27]: 27-05: the history list and panel read only the state home; sessions saved under an editor's globalStorage stay unlisted until plan 10's migration — The old transcript store stays only for its key helpers; migration re-seals old transcripts under the project data key
- [Phase 27]: 27-17: the online-home flow keeps the GitHub token in one local variable (API Authorization header, or a runner wrapper adding GIT_CONFIG_* to the git child environment for https://github.com/ only) and saves only step, method, repo and startedAt; progress step is the last one finished and resume checks getRepo before it would ever create
- [Phase 27]: 27-17: the person's own code push uses a separate plain git runner (their hooks and config) behind a file list and secret check, and is its own question after the sync step; a folder inside another repository and a pasted address with a password or token are refused
- [Phase 27]: 27-06: the conversation log pins reopened-thread transcript entries when it trims live output, so no history is cut off
- [Phase 27]: 27-06: tool steps are paired with results by nearest earlier call id, and a tool card loads its output (textContent in a pre) only when first opened
- [Phase 27]: 27-06: a reopened thread reaches the page in batches of 200 and is drawn 50 per animation frame; later host messages queue behind it
- [Phase 27]: 27-07: reopening an archived thread touches it (lastUsedAt = now) so it ranks first; restores asked for by the rank rule or crash recovery keep its own last-use time
- [Phase 27]: 27-07: archive removal of live files is refused when log size, context.enc or meta.enc changed since the snapshot; retention also restores archived threads the rank rule puts live
- [Phase 27]: 27-08: a prompt that never reached the model (no folder, no profile, held back by the outbound guard) is not stored; a pre-0.4.20 session's one-time seed is stored even then
- [Phase 27]: 27-08: Chat view thread tail match also requires the preceding user text to equal the newest prompt and only considers a live newest chat-view thread; otherwise a new thread starts
- [Phase 27]: 27-08: a thread with a log and no saved context is reopened by building its context from the log main line; a run adds the panel system prompt when history has none
- [Phase 27]: Each record kind merges by its own id and rule (thread entries by union, markers by last sign of life, checkpoints and comparisons when absent or later, spend by entry id and version), so a rerun writes nothing and editor order does not matter
- [Phase 27]: Spend lines are selected by entry id, not by the project tag on each line, and unionLog is keyed by (entry id, version): later versions of a ledger entry carry no project tag and the first line holds the entry's time and path
- [Phase 27]: The old transcript key is read from SecretStorage without creating one; a sealed transcript with no key is counted locked and retried at the next start; the source folder is opened read-only
- [Phase 27]: Migration runs at activation only for a NEAR AI project, otherwise on the first chat send, history list or Compare Models open, and before saved tabs reopen; it logs counts only
- [Phase 27]: Sync pushes through the transport without holding the mirror lock itself; an in-process queue serialises sync/pull/unlock and MirrorBusyError is the waiting outcome
- [Phase 27]: SyncOutcome gains a failed kind carrying the transport SyncFailure so offline, sign-in and policy failures reach the scheduler
- [Phase 27]: Remote index entry counts must be covered by what this computer holds after reading every listed object, and the manifest state id must equal the project's; otherwise the bundle is refused before any write
- [Phase 27]: A changed local record is built as an edit of the remote head (makeRecord base) so one writer never forks against itself; spend months are united by line, not decided by newer-wins
- [Phase 27]: unlockFromRemote verifies the unwrap and manifest before the state home exists; a computer with remote state and no key of its own is refused as locked, never given a fresh key
- [Phase 27]: One cold object per thread: an archive is added as a cold object only when the remote index lists none for the thread; later entries travel hot or beside the archive
- [Phase 27]: Hot consolidation is built from the old hot objects, kept only if it holds every entry and record they held plus what the push sends; cold objects are never consolidated away; the 200-object rule is replaced by 20 hot objects or twice the live size
- [Phase 27]: Size limits stop new uploads and never delete: a warning from 500 MB, no new cold object from 1 GiB or 3500 listed objects, and the message says how many conversations stay on this computer only
- [Phase 27]: An archive that cannot be opened is explained in plain words and opens nothing; every write to that thread is refused, so an empty view is never saved over it; the archive files are not touched
- [Phase 27]: 27-14: the pick-up card shows only for a pointer from another editor newer than the last seen; its click calls only openSaved (never resume, auto-resume or a model request); a run marker carries waitingSince while a prompt is open
- [Phase 27]: Consent comes before the recovery code in turn-on: what the git host can and cannot see is confirmed first, and the wrap is written only after the person says the code is saved, so declining anywhere writes nothing.
- [Phase 27]: A remote address's userinfo is never written to the mirror config or passed as a git argument: git gets the credentialed form per call as a url insteadOf rewrite in its environment, and automatic syncs ask GitHub silently (only a click may prompt).
- [Phase 27]: A new recovery code is carried by a pending flag and named by the sealed index, so an older computer adopts the newer wrap instead of pushing its own back.
- [Phase 27]: Joining a synced project from a computer with chats builds a re-keyed copy beside the state home and swaps by two renames, keeping the original until a sync worked.
- [Phase 27]: 27-18: the sync control reuses 27-15's status and commands; Needs attention shows its plain sentence with one Sync Project Now button; the Turn on sync invitation appears only while sync is off, once on screen (first-run screen or pick-up card), dismissal stored per project in workspaceState nearAi.sync.promptDismissed
- [Phase 27]: 27-18: the first-run invitation goes into the whole welcome section so a computer with no connected profile yet still sees it; the pick-up card also shows 'Checking for updates…' while the pull on open runs
- [Phase 27]: 27-19: an older build's comparison mode run is read as rerun by one frozen LEGACY_RUN_MODES table inside parseSavedRun; every reader (store, migration, sync records) goes through it, guarded by a source test
- [Phase 27]: 27-20: default branch moves only away from near-ai/state, only after a pushed code result; pasted address names the setting (no API); sync still pushes near-ai/state only
- [Phase 27]: 27-21: code push holds NEAR AI per-person records back by default; allowlist team.md, project.json, verifiers.json; tracked records named or blocked on public
- [Phase 27]: 27-22: the profile and sync chips wrap their own text at every width (never an ellipsis) and the bar wraps at every width; a row break up to 480 px puts the pickers on the next row
- [Phase 27]: 27-22: controls a person must read whole carry data-must-read; the test-only layout probe reports clipped ones and the extension-host layout test fails on them in all five sync states at every side bar width
