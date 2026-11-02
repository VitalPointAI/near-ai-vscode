---
gsd_state_version: "1.0"
milestone: v0.6.0
milestone_name: Team Mode
current_phase: 61
current_phase_name: Invitations, joining, removal, NEAR org and key integration
status: verifying
stopped_at: Completed 61-14-PLAN.md
last_updated: "2026-11-02T03:40:58.846Z"
last_activity: 2026-11-01
last_activity_desc: Phase 61 execution started
state_head: a2def69c2d45a88833188de5e6cdaeb2c943eb80
progress:
  total_phases: 8
  completed_phases: 1
  total_plans: 26
  completed_plans: 26
  percent: 13
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-11-01)

**Core value:** Several people, each running their own private NEAR AI agents, work one project toward Open-GSD milestones and releases without colliding, overspending or leaking secrets.
**Current focus:** Phase 61 — Invitations, joining, removal, NEAR org and key integration

## Current Position

Phase: 61 (Invitations, joining, removal, NEAR org and key integration) — EXECUTING
Plan: 14 of 14
Status: Phase complete — ready for verification
Last activity: 2026-11-01 — Phase 61 execution started

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

Last session: 2026-11-02T03:40:58.693Z
Stopped at: Completed 61-14-PLAN.md
Resume file: None

## Notes

- v0.5.0 (trusted-source knowledge base) is paused here and moving to a separate project. Archive: `.planning/milestones/v0.5.0-paused/`. Code: local branch `gsd/phase-13-sovereignty-gate-post-quantum-cryptography-and-the-encrypted` (not pushed).
- Release checklist for 0.4.x: tsc, lint, full `npm test`, full `npm run test:e2e` (both scenarios), `npm run verify:release`, then publish only with the owner's OK for that version.
