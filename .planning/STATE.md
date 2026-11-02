---
gsd_state_version: "1.0"
milestone: v0.6.0
milestone_name: Team Mode
current_phase: 61
current_phase_name: Invitations, joining, removal, NEAR org and key integration
status: executing
stopped_at: Phase 61 context gathered
last_updated: "2026-11-02T00:42:58.941Z"
last_activity: 2026-11-01
last_activity_desc: Phase 60 complete, transitioned to Phase 61
state_head: 40457b8829c65f98ef0da4de31bf0cada7a67b0f
progress:
  total_phases: 8
  completed_phases: 1
  total_plans: 26
  completed_plans: 12
  percent: 13
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-11-01)

**Core value:** Several people, each running their own private NEAR AI agents, work one project toward Open-GSD milestones and releases without colliding, overspending or leaking secrets.
**Current focus:** Phase 61 — Invitations, joining, removal, NEAR org and key integration

## Current Position

Phase: 61 (Invitations, joining, removal, NEAR org and key integration) — READY TO EXECUTE
Plan: Not started
Status: Ready to execute
Last activity: 2026-11-01 — Phase 60 complete, transitioned to Phase 61

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

Last session: 2026-11-01T22:48:47.235Z
Stopped at: Phase 61 context gathered
Resume file: .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-CONTEXT.md

## Notes

- v0.5.0 (trusted-source knowledge base) is paused here and moving to a separate project. Archive: `.planning/milestones/v0.5.0-paused/`. Code: local branch `gsd/phase-13-sovereignty-gate-post-quantum-cryptography-and-the-encrypted` (not pushed).
- Release checklist for 0.4.x: tsc, lint, full `npm test`, full `npm run test:e2e` (both scenarios), `npm run verify:release`, then publish only with the owner's OK for that version.
