---
gsd_state_version: "1.0"
milestone: v0.7.0
milestone_name: Governed agent platform and messaging relay
current_phase: 69
current_phase_name: Team Mode reconciliation
status: planning
stopped_at: "v0.7.0 replanned 2026-11-15 around the owner's platform direction; Phase 68 complete (PR #50 in review, owner D-19 step open); Phase 69 not planned yet"
last_updated: "2026-11-15T16:00:00.000Z"
state_head: 2fe6e976ceda86fe800620f2012d78fe85c6779d
progress:
  total_phases: 17
  completed_phases: 1
  total_plans: 8
  completed_plans: 8
  percent: 6
last_activity: 2026-11-15
last_activity_desc: "Replanned v0.7.0 as Governed agent platform and messaging relay (Phases 69-84); OpenShell spike result recorded"
---

# Project State

## Current position

Milestone: v0.7.0 Governed agent platform and messaging relay (Phases 68-84), replanned 2026-11-15 from the owner's platform direction (`.planning/PROJECT.md`, "Platform direction"). The roadmap's v0.7.0 section opens with the order of work across every stream.
Phase 68 (Relay foundation): complete and verified (4/4 must-haves, 8/8 plans); in review as PR #50. Open: the owner's D-19 step.
0.4.x line: 0.4.22 published 2026-11-14; 0.4.23 in review as PR #51, its release PR follows; 0.4.24 is next (the four #46 review minors and three documentation mismatches). Phase 27 shipped as 0.4.20; its record stays open until the owner's host check.
Phase 69 (Team Mode reconciliation): next to plan. Planning starts from the new roadmap, not from the old relay order.

Next, in order:
1. Owner: review and merge 0.4.23 (PR #51), then its release PR.
2. Owner: approve `agent-review-gates` on PR #50 and merge it, then add `relay` to main's branch protection (D-19, `docs/development-workflow.md` section 8). Then a small relay housekeeping PR: the relay README, Compose file, build script and tests point at the new phase numbers, and the Signal sidecar re-check date (2026-12-10) is met or moved to Phase 82.
3. The 0.4.24 patch; the owner's Phase 27 host check (27-UAT test 8 onward) and the 27-16 summary.
4. Owner: push `feat/team-fix-pass` to GitHub as an archive branch and commit or record the five uncommitted files in its legacy worktree. Then `/gsd-plan-phase 69`.
5. In parallel when wanted: `/gsd-plan-phase 28` (secure development workflow step). Phase 72 plans from the OpenShell spike result.

## Accumulated Context

### Roadmap Evolution

- 2026-11-15: v0.7.0 replanned and renamed "Governed agent platform and messaging relay" after the owner accepted the platform direction (no IronClaw fork; our engine gains the DID governance layer; offline gate; edge grouping and HQ federation; Theia container appliance first; NVIDIA and AMD GPUs). New Stage 1 Phases 69-74 (Team Mode reconciliation, gate with a floor, delegation, execution backends with a guarded apply, credential broker, run contracts). Relay phases renumbered: 69 to 75, 70 to 76, 71 to 77, 71.1 to 78, 72 to 79, 73 to 80, 74 to 81, 75 to 82, 75.1 to 83, 76 to 84 (the phase folders for 71.1 and 75.1 were renamed). 117 active requirements; RUNL-05 retired for APRV-01..04. Phases 28 (secure development workflow step) and 29 (cleanup member) added to the 0.4.x line. Six later milestones outlined (L1-L6). The OpenShell spike passed (33 of 33 key-folder escapes blocked; downloads keep symlinks, so the apply step treats changes as untrusted).
- 2026-11-15: Phases 71.1 (Messaging setup view) and 75.1 (Telegram) inserted; WhatsApp dropped.
- Phase 27 inserted 2026-11-13 in the 0.4.x line, ahead of v0.7.0 Phase 68: project state follows the project across interfaces and machines, shipping as release 0.4.20 (SYNC-01…08). Its decisions are in 27-CONTEXT.md. Shipped 2026-11-14 (PR #40, release PR #41).
- Milestone v0.7.0 added 2026-11-13: Messaging relay, Teams and Signal. Phases 68-76 mapped all 45 requirements then defined (later 54 with SETUP and TGRM).
- Phase numbering starts at 68: branch-shipped phases end at 26; the unmerged `feat/team-fix-pass` branch claims Phases 60-67 for v0.6.0; 68 keeps both honest.
- Phase 26 completed on branch perf/research-runs: Performance, faster agent and research runs (PERF-01…07, 5 plans, verified).
- Phase 25 (Cybersecurity harness, CYBER-01…12) moved 2026-11-13 out of the 0.4.x line into its own milestone v0.8.0 Cybersecurity. All 8 plans are executed; 25-UAT.md is parked at test 2, and the owner's review of the 12 regional disclaimers is still to do. Replan 2026-11-15: UAT may resume once Phase 72 is merged (owner to confirm).

### Locked decisions (encode, do not re-litigate)

- Platform direction (owner, 2026-11-15; verbatim in PROJECT.md): no IronClaw fork; our TypeScript engine gains the DID trust and governance layer; the gate works fully offline from a signed local copy and fails closed; edge devices group locally and federate to HQ; Theia container appliance first, desktop second, VS Code extension kept while cheap; IronClaw, Hermes Agent and OpenShell are design sources only (plus OpenShell's policy format and prover); NVIDIA and AMD GPUs, arm64 and amd64, linked machines, HQ cluster and NEAR AI Cloud burst.
- Phase 68 stands as built.
- Relay = workspace `relay/`, owner-hosted, multi-tenant; Node 26.13.1 and a separate lockfile; the extension stays on Node 24 with a zero-dependency bundle.
- Exactly one relay runtime dependency: `jose`. No HTTP framework, no Bot Framework SDK, no SQLite package (`node:sqlite`, JSON-file-per-tenant fallback), no test framework (`node:test`).
- Signal via a pinned `signal-cli-rest-api` sidecar; pin the exact signal-cli version.
- Group visibility result-only; work detail stays in the requester's private chat.
- The bot is an external app installed by a customer admin; it never joins the customer's Microsoft organization.
- Per-tenant budget cap always on; per-conversation cap defaults to unlimited.
- Every relay run executes under a contract in a sandbox (EXEC-11, CTRT-07); the relay never gets a container runtime socket.

### Open decisions (owner)

- IN-04 message text retention in the relay store: blank the payload on acknowledgement (recommended) or purge `done` rows after N days. Needed before Phase 75 stores real messages.
- Whether Phase 69 also lands Team Mode Phases 61, 62 and 62.1 (recommended: no, they go to milestone L2 after their re-test chain closes).
- DID method and identity lifetime (`did:near` or `did:key`; persistent per member or per run). Needed before Phase 71.
- Versioning: whether Stage 1 phases ship in 0.4.x releases as they land, with 0.7.0 at the milestone's end (recommended), or wait.
- Whether v0.8.0 UAT resumes after Phase 72 (recommended) instead of after all of v0.7.0.
- Whether unpaired chat users get the tenant's default contract (PAIR-02, recommended) or everyone must pair.
- The Signal sidecar re-check date (2026-12-10) falls before Phase 82: re-pin by then, or move the date in the relay housekeeping PR.
- The order of the later milestones L1-L6 (recommended order in ROADMAP.md).
- Whether a mixed NVIDIA and AMD group may stop at per-vendor pools with request balancing (POOL-01), since one model split across vendors may not be practical.

### Naming trap

- This milestone's relay is the messaging relay at `relay/`: NOT the paused v0.5.0 ciphertext sync relay (RELAY-01/02 archived in `.planning/milestones/v0.5.0-paused/`) and NOT `relayTransport.ts` board sync (unmerged branch; superseded by L5's federation transport).
- REQ-ID collisions: v0.5.0 used RELAY-01/02 for ciphertext sync (scoped as "v0.7.0 RELAY-01/02"). v0.6.0 uses TEAM-01..04 and SETUP-01 with other meanings; carried v0.6.0 ids take a `TM-` prefix (TMR-04).

### Reuse pointers

- Durable restart: `src/services/runMarkers.ts` (NOT `runActivity.ts`); `AUTO_RESUME_WITHIN_MS`=12h, `MAX_AUTO_RESUMES`=3.
- `src/agent/` has zero `vscode` imports: the reuse surface for headless composition. `src/services/chat.ts` is UI-bound; the relay must NOT import it.
- Team Mode core (identity, signed log, permissions) on the archive branch: `src/team/`, `src/domain/team/` (Phase 60 SUMMARY files are the spec).
- Local models and private routing to build on: `src/domain/auth.ts` (local and hybrid profiles), `src/services/providerFactory.ts`, `privateRouteFor` in `src/services/providerCache.ts`, `src/domain/privacy.ts`.
- OpenShell spike: `.planning/research/platform-direction/openshell-spike.md` and `openshell-spike/` (policies, DID drafts, the delegation verifier draft, escape tests).

### Research flags (embedded in phases)

- Phase 69: per-file port strategy from a 0.4.11 fork; two private git mirrors (Team Mode and sync) must not collide.
- Phase 70: capability grammar and policy bundle format (high undo cost); how the relay shares the vocabulary.
- Phase 71: DID method; persistent or per-run identities; spend as running totals.
- Phase 72: start with an in-extension integration spike; OpenShell 0.1.x pinning and attestations; gateway size; AMD GPU needs a Strix Halo hardware test; macOS untested.
- Phase 74: clock trust for expiry on edge devices without network time.
- Phase 76: Teams field paths against a live tenant; proactive 1:1 install scope (highest derail risk; fallback carried to Phases 81 and 84).
- Phase 77: headless composition with gate and contracts is a spike; Teams in-group streaming is undocumented (post-don't-stream fallback).
- Phase 82: pin and verify signal-cli; arm64 sidecar image.

### Blockers/Concerns

- Owner action pending (D-19): approve agent-review-gates on PR #50, then add relay to main's branch protection.
- `feat/team-fix-pass` exists only locally (not on GitHub) and its legacy worktree has five uncommitted files: archive it before Phase 69.
- The Signal sidecar re-check date (about 2026-12-10) recorded in `relay/compose.yaml`, `relay/README.md` and the container test now falls before the Signal phase.

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 261113-lbo | fix the chat task list not checking off finished tasks | 2026-11-13 | a770848 | [261113-lbo-fix-the-chat-task-list-not-checking-off-](./quick/261113-lbo-fix-the-chat-task-list-not-checking-off-/) |

## Notes

- v0.5.0 (trusted-source knowledge base) is paused and moving to a separate project. Archive: `.planning/milestones/v0.5.0-paused/`. Code: local branch `gsd/phase-13-sovereignty-gate-post-quantum-cryptography-and-the-encrypted` (not pushed).
- Release checklist for 0.4.x: tsc, lint, full `npm test`, full `npm run test:e2e` (both scenarios), `npm run verify:release`, then publish only with the owner's OK for that version.

## Session

**Last session:** 2026-11-15T16:00:00.000Z
**Stopped at:** v0.7.0 replanned around the owner's platform direction; next is the owner's merges (PR #51, PR #50 with D-19), the 0.4.24 patch, archiving `feat/team-fix-pass`, then `/gsd-plan-phase 69`
**Resume file:** .planning/ROADMAP.md (v0.7.0, "Order of work across every stream")

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
| Phase 68 P01 | 70min | 3 tasks | 15 files |
| Phase 68 P02 | 25min | 2 tasks | 7 files |
| Phase 68 P03 | 10min | 2 tasks | 3 files |
| Phase 68 P04 | 35min | 2 tasks | 9 files |
| Phase 68 P05 | 25min | 3 tasks | 6 files |
| Phase 68 P06 | 30min | 3 tasks | 9 files |
| Phase 68 P07 | 40min | 3 tasks | 6 files |

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
- [Phase 68]: D-20 answered by the owner: relay pins jose 6.2.17 and @types/node 26.6.6 (newest pair)
- [Phase 68]: Relay prints nothing and exits 1 on any failed start until plan 02's redacting logger exists (D-11)
- [Phase 68]: Redaction order is secrets, then phones, then the 500-character cut; the Logger keeps time, level and event reserved and writes colliding field names as field_{key}
- [Phase 68]: onRejected receives only a plain upper-case method token or OTHER, so client text cannot reach a log line
- [Phase 68]: Plan 68-04: schema v1 holds all five aggregates; crash writer is permit-driven so a kill lands within one message of the last ack; claimed messages return to queued on open
- [Phase 68]: 68-05: a conversation binding is never moved to another tenant (binding-conflict); approval answers succeed only strictly before expiresAt
- [Phase 68]: 68-06: plain-secret refusal runs before the state directory is created; secrets come only from {NAME}_FILE, CREDENTIALS_DIRECTORY or /run/secrets; phone-label key is SHA-256 of LOG_PSEUDONYM_KEY or a 0600 log-pseudonym.key created once
- [Phase 68]: 68-07: relay image code folder staged as /app-skel in the build stage (files 0444, folder 0555) because COPY --chmod also hit the /app folder
- [Phase 68]: 68-07: container suite checks files and links for shells and package managers, not the base image's empty etc/dpkg and var/lib/dpkg folders; docker build runs without --memory (BuildKit has no such flag)
- [Platform, 2026-11-15]: Owner accepted the platform direction (PROJECT.md, "Platform direction", decisions 1-6): no IronClaw fork, our engine gains the DID governance layer, offline gate from a signed local copy that fails closed, edge grouping and HQ federation, Theia container appliance first, outside projects as design sources only, the OpenShell spike, the v0.7.0 replan, NVIDIA and AMD GPUs with linked machines and a NEAR AI Cloud burst
- [Platform, 2026-11-15]: v0.7.0 stays one milestone (owner asked for v0.7.0 to be replanned; Phase 68 ships as v0.7.0; the relay depends on the governance phases in one chain) in three stages with a gate before the relay runs tools; relay phases renumbered 75-84
- [Platform, 2026-11-15]: Team Mode's Phase 60 core lands on main in Phase 69, ported onto current main rather than merging the 0.4.11-based branch; Phases 61, 62 and 62.1 wait for milestone L2 unless the owner decides otherwise
- [Platform, 2026-11-15]: The OpenShell spike's apply-path finding (downloads keep symlinks) makes the guarded apply a requirement (EXEC-03); the prover cannot prove sub-folder narrowing, so generated policies use a fixed file-path vocabulary (EXEC-05)
