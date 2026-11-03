---
gsd_state_version: "1.0"
milestone: v0.6.0
milestone_name: Team Mode
current_phase: 62
current_phase_name: Work model, GSD import, Team Board (live, read and move)
status: verifying
stopped_at: Completed 61-21-PLAN.md
last_updated: "2026-11-03T23:20:39.195Z"
last_activity: 2026-11-02
last_activity_desc: Phase 62 execution started
state_head: 27edb934563d52c3433fd3c51d6506f61fcc5392
progress:
  total_phases: 8
  completed_phases: 1
  total_plans: 59
  completed_plans: 48
  percent: 13
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-11-01)

**Core value:** Several people, each running their own private NEAR AI agents, work one project toward Open-GSD milestones and releases without colliding, overspending or leaking secrets.
**Current focus:** Phase 62 — Work model, GSD import, Team Board (live, read and move)

## Current Position

Phase: 62 (Work model, GSD import, Team Board (live, read and move)) — EXECUTING
Plan: 14 of 14
Status: Phase complete — ready for verification
Last activity: 2026-11-02 — Phase 62 execution started

Progress: [█░░░░░░░░░] 13%

## Performance Metrics

**Velocity:**
- Total plans completed: 12
- Average duration: -
- Total execution time: 0.0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 60 | 12 | - | - |

*Updated after each plan completion*
**Per-Plan Metrics:**

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 60 P01 | 13 min | 2 tasks | 12 files |
| Phase 60 P02 | 14min | 2 tasks | 4 files |
| Phase 60 P03 | 25min | 2 tasks | 3 files |
| Phase 60 P04 | 20min | 2 tasks | 3 files |
| Phase 60 P05 | 50 min | 2 tasks | 3 files |
| Phase 60 P06 | 5 min | 2 tasks | 6 files |
| Phase 60 P07 | 40 min | 3 tasks | 3 files |
| Phase 60 P08 | 10 min | 2 tasks | 3 files |
| Phase 60 P09 | 35 min | 2 tasks | 6 files |
| Phase 60 P10 | 38 min | 2 tasks | 4 files |
| Phase 60 P11 | 10 min | 3 tasks | 8 files |
| Phase 60 P12 | 25min | 2 tasks | 5 files |
| Phase 61 P01 | 50 min | 3 tasks | 10 files |
| Phase 61 P02 | 35min | 2 tasks | 3 files |
| Phase 61 P03 | 15min | 2 tasks | 5 files |
| Phase 61 P04 | 15 min | 3 tasks | 8 files |
| Phase 61 P05 | 8 min | 3 tasks | 11 files |
| Phase 61 P06 | 10 min | 2 tasks | 2 files |
| Phase 61 P07 | 10min | 3 tasks | 5 files |
| Phase 61 P08 | 12 min | 2 tasks | 3 files |
| Phase 61 P09 | 45min | 2 tasks | 2 files |
| Phase 61 P10 | 20 min | 3 tasks | 3 files |
| Phase 61 P11 | 13 min | 3 tasks | 4 files |
| Phase 61 P12 | 40min | 3 tasks | 8 files |
| Phase 61 P13 | 55 min | 3 tasks | 8 files |
| Phase 61 P14 | 15 min | 3 tasks | 8 files |
| Phase 62 P01 | 13 min | 3 tasks | 12 files |
| Phase 62 P02 | 8 min | 2 tasks | 2 files |
| Phase 62 P03 | 10 min | 2 tasks | 9 files |
| Phase 62 P04 | 35 min | 3 tasks | 8 files |
| Phase 62 P05 | 40 min | 3 tasks | 4 files |
| Phase 62 P06 | 70min | 3 tasks | 5 files |
| Phase 62 P07 | 22 min | 3 tasks | 11 files |
| Phase 62 P08 | 45 min | 3 tasks | 7 files |
| Phase 62 P09 | 62 min | 3 tasks | 4 files |
| Phase 62 P10 | 18 min | 2 tasks | 2 files |
| Phase 62 P11 | 6 min | 2 tasks | 2 files |
| Phase 62 P12 | 36 min | 2 tasks | 4 files |
| Phase 62 P13 | 105 min | 3 tasks | 6 files |
| Phase 62 P14 | 70min | 3 tasks | 9 files |
| Phase 61 P15 | 30min | 3 tasks | 13 files |
| Phase 61 P16 | 12 min | 3 tasks | 3 files |
| Phase 61 P17 | 8 min | 3 tasks | 9 files |
| Phase 61 P18 | 11 min | 3 tasks | 5 files |
| Phase 61 P24 | 35min | 3 tasks | 12 files |
| Phase 61 P19 | 19min | 3 tasks | 11 files |
| Phase 61 P20 | 12min | 2 tasks | 4 files |
| Phase 61 P21 | 11min | 3 tasks | 9 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Milestone]: Team Mode uses Phases 60-67 (spec phases renumbered in order) because Phase 25 belongs to the parallel 0.4.x line.
- [Milestone]: Coordination storage is the orphan branch `near-ai/coordination`; default dispatch mode is `offer`; peer metrics are off by default; the integration default is the local merge train.
- [Milestone]: Evidence-based model defaults move to v0.7.0 or a 0.6.x release.
- [Phase 60]: Canonical nesting depth counts containers: 16 accepted, 17 rejected; any failure of the first event refuses the whole log
- [Phase 60]: Rewritten coordination branch pauses the client with a sticky pause and a quarantine ref (D-33 pulled into 60-01)
- [Phase 60]: 60-02: permission cells are checked before owner overrides; secret detector exempts only strict publicKey and sig shapes
- [Phase 60]: 60-03: fetches land in a staging ref and the trusted ref moves only after the ancestry check; unanswered pushes are resolved by the next fetch's ancestry check
- [Phase 60]: 60-04: validators return full 'invalid event body: <path>' reasons; rejection id is the parsed event id when it matches the pattern, else the file path
- [Phase 60]: 60-05: stateHash covers state.rejected, so snapshot.written bodies are computed after any preceding rejections; replay keeps every client in agreement
- [Phase 60]: 60-05: member.availability without workingHours keeps the hours on record; member.joined outside genesis rejects as not permitted: only the owner joins at genesis in this version
- [Phase 60]: 60-06: team.json refuses any extra key including policy; the signed log stays the only source of policy
- [Phase 60]: 60-06: roster audit mirror secret-checks all new entries before appending any; corrupt trust or mark files fail closed
- [Phase 60]: 60-07: batch prev chains event to event (first uses the head id); a snapshot over a state holding a secret-like value is skipped as a reported conflict, not thrown; append returns the user's AppendResult and the snapshot outcome is read via lastSnapshot()
- [Phase 60]: 60-08: failures after the genesis landed (team.json unsaved, trust pin refused, commit refused) keep the device key and return commit-failed; only a failed or non-landing genesis push rolls back key and mirror
- [Phase 60]: 60-08: an unreadable team.json is reported as exists-locally and left untouched, never overwritten
- [Phase 60]: 60-09: roster audit mirror uses a fresh AuditStore per attempt and confirms each entry by reading audit.json back, since AuditStore.persist swallows write failures
- [Phase 60]: 60-09: TeamSession adopts its signer after the first sync by matching the device fingerprint to a roster member; backoff never shortens a poll interval longer than 10 minutes
- [Phase 60]: 60-10: shared-mirror config.lock race fixed in gitTransport.ts (conditional config writes plus lock retry) rather than in the test
- [Phase 60]: 60-11: ENOENT and ENOTDIR both mean solo; Enable checks for an existing team before asking questions; Push offered only on a branch; commit-failed still starts the session
- [Phase 60]: G-60-1: unchanged-focus window-state events are ignored; focus loss re-arms anchored to the last run; cadence re-reads focused() after each run (60-12)
- [Phase 60]: 60-12 review: the scheduler uses a monotonic clock (performance.now) and caps a focus-loss re-arm at one full delay; post-run callback failures are reported and the next poll is still armed
- [Phase 61]: 61-01: invite/join shapes confirmed as recorded (HKDF/PKCS#8 derived key, 300 s commit-time skew, D-15 confirmation); invitedEvent kept after join so used invitations stay distinguishable
- [Phase 61]: 61-02: createKey also reconciles (list by name, revoke) after a 5xx; listMembers has no email on the real route; checkApiKey 402 may carry empty ids
- [Phase 61]: 61-03: sealTo accepts 16 to 512 byte plaintext and re-rolls any draw the write-side detector would flag (cap 8); randomness source is an optional 4th parameter
- [Phase 61]: A refused refresh that finds the stored refresh token unchanged waits 300 ms and re-reads once before reporting the NEAR sign-in expired, because the winning window stores its rotated token only after NEAR answers it
- [Phase 61]: installTeamKey verifies the key with check_api_key (retrying invalid and unavailable) before touching any profile or stored key, so a bad re-delivery never replaces the working key; removeTeamKey restores the remembered profile only if the team profile is still active
- [Phase 61]: 61-05: member.key-sealed confirmed as recorded (Task 1 auto-selected confirm-recorded); every delivery is a new key, so device add and revoke both rotate and an existing key is never re-sealed
- [Phase 61]: 61-05: memberAttention lists one item per member (confirm, then deliver-key, then rotate-key); leads are included, only the owner is excluded
- [Phase 61]: 61-06: released claims keep their leaseIds; lease records are dropped from state.leases (Phase 63 decides on clearing the list)
- [Phase 61]: 61-07: re-issue is bound to the original email and carries name, role and allocation over; a lost invites.json write never fails an invite already in the log
- [Phase 61]: 61-07: cleanup.json errors are scrubbed with scrubNearText plus the team secret detectors, and a damaged checklist is reported and never replaced
- [Phase 61]: 61-08: commitTeamFileOnly is shared by Enable and NEAR link; linkNearOrganization checks the trust pin before rewriting team.json and leaves the written link in place on a commit failure
- [Phase 61]: 61-09: JoinResult gains additive code invalid-name; Join never deletes keys it did not create; offline write with unreadable log keeps keys; leads accept only the team organization's invitation
- [Phase 61]: 61-10: rotation cap is old limit minus lifetime usage floored at 0; old key is zeroed then revoked only after the new key is in the log; a member with no seal-capable device left is told the old key stays valid on computers that already hold it
- [Phase 61]: 61-10: deliverMemberKey refuses a member who already has a key and the append builder re-checks the key being replaced, so two leads cannot leave an unrecorded spendable key; TeamLog.findEvent added to read sealed entries
- [Phase 61]: 61-11: removeMember asks the permission question and refuses self-removal before any NEAR call; finished NEAR steps are kept as done items only when a step is unfinished; the lead's NEAR organization member is matched by email hash, and with no email from NEAR (the real server) the step is a manual item naming the lead
- [Phase 61]: 61-12: notification buttons call nearAi.team.manageMembers with action confirm, remove, deliver-key or rotate-key; shown-once messages are remembered by event id in notified.json (ids only)
- [Phase 61]: 61-12: keyScope is decided when a provider entry is built; team profile = team, other profile in a project with team.json = personal, solo = no tag and no ledger field
- [Phase 61]: 61-12: Join offer only where a command runner is supplied; a failed key install is not retried for 5 minutes
- [Phase 61]: The seven-day lifetime is the first item in the Invite lifetime pick so Enter chooses the recommended one
- [Phase 61]: Commands read the fresh team.json for the NEAR link and restart the session after a link or a join
- [Phase 61]: The spend-cap sentence is shown only in a team with a NEAR organization; an unlinked team gets the no-organization notice
- [Phase 61]: The unfinished-join reset is offered only after a fresh sync shows this computer is not on the team list
- [Phase 61]: 61-14: the lifecycle, privacy canary and full gate passed with no production change; the coordination push between cap and revoke is proven by counting remote event files at each NEAR call
- [Phase 61]: 61-14: TEAM-02 and TEAM-03 ticked; only the manual real-NEAR organization check and the live test run remain for the owner
- [Phase 62]: Plan 62-01: item event bodies, stored WorkItem shape, item.move row and transition rules confirmed as recorded (confirm-recorded); parent kind is checked at the reference step (itemParent), mark done ends a hold
- [Phase 62]: 62-02: the integration branch is fetched with --no-write-fetch-head into refs/near-ai/integration/<branch> and .planning is read from that ref by plumbing; symlinks under .planning are listed, never read
- [Phase 62]: Plan identity for GSD import comes from the file name; frontmatter phase is only cross-checked — Archived plans have no frontmatter and the frontmatter phase is a slug (62-03)
- [Phase 62]: GsdMilestone.current means the repository's current milestone (STATE.md, construction sign, current bullet); archived milestones build from the bullet range and .planning/milestones folders only — Keeps the board's current flag independent of which milestone a lead asks to see (62-03)
- [Phase 62]: 62-04: an unplanned phase (no live plan) counts complete for dependants only when stored done — An unplanned phase must not release the phases that wait on it
- [Phase 62]: 62-04: snapshot parseWorkItem refuses claimId and ringFenceNanoUsd until a claim phase stores them — Nothing in Phase 62 writes them and claims must stay empty; parser and writer widen together
- [Phase 62]: Dependencies outside the imported graph are dropped with a warning, so a plan waiting on an older milestone is not stuck as dependency-missing
- [Phase 62]: import.json stores the milestone asked for (empty means current) so auto-mode unchanged-tree skips compare like with like
- [Phase 62]: Size fit order: list caps, trailing must-haves (first stays), trailing file paths, then must-haves halved to 40 characters
- [Phase 62]: Import permission is checked before any fetch; a developer gets 'not permitted' and nothing is touched
- [Phase 62]: 62-06: hold is offered only from Ready; model counts describe the default milestone selection while cards of every milestone are in the model — UI-SPEC offered-moves table; the client filters locally with no host round trip
- [Phase 62]: 62-06: lane keys are unassigned, item ids, board and all; refusals map omits the card's own column and any column it may enter — Stable ids let the client update in place; a missing entry means the drop is offered
- [Phase 62]: 62-07: a visible board only changes what the scheduler reads (one timer); opening it syncs at once, closing it returns to the unfocused delay
- [Phase 62]: 62-07: the automatic import is role-gated (owner, lead) before any git call, once a minute on a monotonic clock, one notice per window, failures one redacted line
- [Phase 62]: 62-07: canWrite means a device key for a non-removed member; reachability and trust are the board's job through boardStatus
- [Phase 62]: 62-08: the host plans a board move three times (known state for the prompt, current state after the prompts, fresh state inside log.append) and shows a card-state refusal after an offered move as the stale sentence naming the newest author
- [Phase 62]: 62-08: nearAi.teamMode context key is set once after the first session starts and cleared on dispose; the board module loads only by dynamic import after a session starts
- [Phase 62]: 62-08: page protocol host-to-page detail is {type:'detail', ...CardDetail}; a dismissed prompt answers refused with reason empty and the page clears the pending line silently
- [Phase 62]: Board client icons are inline SVG instead of vendored codicons; kanban columns are a fixed 256 px so only --vscode-* variables appear in board.css
- [Phase 62]: Board client: Move to... shows only for owner and lead and is aria-disabled when offline, paused or removed; feature scripts own #menu and #item-form, board.js owns an empty aside#detail
- [Phase 62]: 62-10: menu.js shows only refusals to requests it sent; menu closes when the card's moves change; Tab refocuses the opener and keeps its default
- [Phase 62]: 62-11: every kanban cell accepts a board drag so a refused drop can give its reason; a drag still active at dragend counts as cancelled
- [Phase 62]: 62-12: the boardDetail out-of-memory crash came from the fake DOM, not detail.js; fake DOM tree links are non-enumerable so a failing assertion on a node prints about 30 lines (fakeDom.test.ts guards it) — Node 24 assert inspects a failed comparison at depth 1000 and myers-diffs the lines (memory about 8 x L^2 bytes) even with a custom message; enumerable doc/parentNode/childNodes made one node print millions of lines
- [Phase 62]: 62-12: Edit exists in the card detail only for a board item the viewer may edit; a blocked card shows the blocked notice and the host's 'It is blocked.' under Why this is not ready — UI-SPEC title block and Card Detail section 3; the page formats nothing it can take from the host's message
- [Phase 62]: 62-13: the item form borrows the page's one VS Code API through NearAiBoard.getDraft/setDraft in board.js; saved { itemId } is a new host-to-page message and a refusal for a new item carries itemId ''
- [Phase 62]: 62-13: the host re-checks create and edit permission on fresh state inside the append, writes one item.created with the estimate, and answers a non-whole-number estimate from the parse-failure path while other malformed drafts stay unanswered
- [Phase 62]: 62-14: the host does not send a state with error when the board model cannot be built; the page's slow-load message with Try again and Show details covers it
- [Phase 62]: 62-14: BOARD-01/02/03 ticked; the 2 s relay half of BOARD-02 stays with Phase 67; owner-only manual checks (themes, reflow, screen reader, density, two real windows) remain
- [Phase 61]: 61-15: a member's key is called AI key and a link-wide key team key; every manual step says your organization's settings on the NEAR AI website
- [Phase 61]: 61-15: pin texts already name the command title NEAR AI: Link Your Organization; the command and adapter text are renamed in 61-24
- [Phase 61]: 61-16: an http or https address with a user part, or ssh with a password, is not-shareable with cleanRepoUrl's credentials sentence, stricter than the invite's credential stripping (cleanRepoUrl unchanged)
- [Phase 61]: 61-16: the setup-only share commit reuses the local team.json blob or serialiseTeamFile bytes, never canonical JSON, so the lead's merge or rebase cannot conflict
- [Phase 61]: 61-16: shareTeamSetup re-plans every attempt; a first upload of the whole branch runs only with the consented first-upload plan, otherwise it returns changed
- [Phase 61]: 61-17: offline or paused makes Check the team the one primary action and the status the connection text
- [Phase 61]: 61-17: while the team setup is not shared or not reachable, a manager gets Share instead of Invite someone
- [Phase 61]: 61-17: sidebar modules post through window.nearChat (chat.js's frozen post); team.js never calls acquireVsCodeApi or setState
- [Phase 61]: 61-17: setup steps turn-on and share are required, invite and link optional (plain data for SETUP-01)
- [Phase 61]: 61-18: Join in an existing copy of the same project catches it up (fetch by remote name, merge --ff-only) only after every check passes; refusals are local-changes, unshared-work, other-version, not-shared or offline
- [Phase 61]: 61-18: an untracked or ignored team.json counts as local-changes, since a fast-forward would overwrite an ignored file silently
- [Phase 61]: 61-18: an invite naming a link team.json lacks triggers the same catch-up once; an unpublished link keeps the existing refusal
- [Phase 61]: 61-24: Link Your Organization explains linking only when the team has no organization link; a linked team goes straight to the pickers
- [Phase 61]: 61-24: 'Invite without NEAR' became 'Invite without signing in' (linked team, not signed in); Not now from the Link command says Nothing was changed plus NO_ORG_NOTICE
- [Phase 61]: 61-24: people-facing files are found by convention and a naming scan reads every Team Mode literal and command title (src/test/helpers/plainWords.ts)
- [Phase 61]: 61-19: Enable connects NEAR AI in place (Connect NEAR AI modal, connectNearAi bound to configureApiKey), re-checks once and otherwise says nothing was changed; it never names NEAR AI: Set Up
- [Phase 61]: 61-19: Enable checks the online home before any question; a local folder or a password in the address gets one modal with Turn on anyway or Not now, and Turn on anyway ends without a share button
- [Phase 61]: 61-19: Share Team Setup (nearAi.team.share, owner or lead) shares only team.json after one confirmation via shareFlow.ensureTeamSetupShared; Enable's Share with my team runs it; consent survives Try again except a new first upload
- [Phase 61]: 61-19: every teamCommands prompt goes through teamPrompts; scripted answers only with NEAR_AI_E2E exactly 1 and promptTap.script set; teamPrompts.js is the one extra module at solo activation
- [Phase 61]: 61-20: Invite checks the online address locally before the organization choice, so an unreachable project is said before anything is asked; the org choice then comes first and one Share and continue confirmation covers the link
- [Phase 61]: 61-20: Join not-ready reasons each get one plain sentence (Get a fresh copy for local changes, unshared work and other version; no button for not shared; Try again for offline); the invite address is used only for a download the person chooses
- [Phase 61]: 61-20: every membership prompt goes through teamPrompts; Link now inside Invite offers no share of its own (linkFlow offerShare false)
- [Phase 61]: 61-21: the sidebar Team section host follows the running session (handle.onDidChange, session onStateChange re-followed after restart, its own actions, visibility); a team project still starting is waited for once, a failed start shows the team as unreachable with Check the team
- [Phase 61]: 61-21: the teamSetupShared check runs only for an owner or a lead, at most once a minute on a monotonic clock while the sidebar is shown, and at once after Share, Invite, Link, Turn on and Join
- [Phase 61]: 61-21: only {type:'team-action', action} with a known id runs anything, through TEAM_ACTION_COMMANDS; one action at a time; teamSectionTap.probe only with NEAR_AI_E2E exactly 1
- [Phase 61]: 61-21: the manager status adds how many people wait in Members (managerStatus waiting count)

### Pending Todos

None yet.

### Blockers/Concerns

- [Phase 61]: Owner decision 1 (NEAR spend-limit semantics: lifetime or per period, and which org role may set it) is confirmed in Phase 61 research; Phase 66 depends on the answer.
- [Phase 60]: The real-window re-test of G-60-1 (60-UAT test 3) ran mostly unfocused because the desktop window lost OS focus; the unfocused cadence and focus-gain syncs were observed, the focused 5 s cadence was covered by unit tests only.
- [Phase 67]: The planner may split this phase; the relay transport is separable and can ship last.

## Deferred Items

Items acknowledged and deferred at milestone close, most recent first:

| Category | Item | Status | Deferred At | Milestone |
|----------|------|--------|-------------|-----------|
| *(none)* | | | | |

## Session Continuity

Last session: 2026-11-03T23:20:38.891Z
Stopped at: Completed 61-21-PLAN.md
Resume file: None

## Notes

- v0.5.0 (trusted-source knowledge base) is paused here and moving to a separate project. Archive: `.planning/milestones/v0.5.0-paused/`. Code: local branch `gsd/phase-13-sovereignty-gate-post-quantum-cryptography-and-the-encrypted` (not pushed).
- Release checklist for 0.4.x: tsc, lint, full `npm test`, full `npm run test:e2e` (both scenarios), `npm run verify:release`, then publish only with the owner's OK for that version.
