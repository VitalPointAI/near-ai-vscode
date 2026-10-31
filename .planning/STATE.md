---
gsd_state_version: "1.0"
milestone: v0.6.0
milestone_name: Team Mode
status: planning
last_updated: "2026-10-31T11:04:17.000Z"
last_activity: 2026-10-31
progress:
  total_phases: 8
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-10-31)

**Core value:** Several people, each running their own private NEAR AI agents, work one project toward Open-GSD milestones and releases without colliding, overspending or leaking secrets.
**Current focus:** Phase 60 - Team core: identity, signed event log, git transport, roster

## Current Position

Phase: 60 of 67 (Team core: identity, signed event log, git transport, roster); phase 1 of 8 in this milestone
Plan: Not started
Status: Ready to plan
Last activity: 2026-10-31 - Roadmap created for milestone v0.6.0 (Phases 60-67, 31/31 requirements mapped)

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**
- Total plans completed: 0
- Average duration: -
- Total execution time: 0.0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Milestone]: Team Mode uses Phases 60-67 (spec phases renumbered in order) because Phase 25 belongs to the parallel 0.4.x line.
- [Milestone]: Coordination storage is the orphan branch `near-ai/coordination`; default dispatch mode is `offer`; peer metrics are off by default; the integration default is the local merge train.
- [Milestone]: Evidence-based model defaults move to v0.7.0 or a 0.6.x release.

### Pending Todos

None yet.

### Blockers/Concerns

- [Phase 61]: Owner decision 1 (NEAR spend-limit semantics: lifetime or per period, and which org role may set it) is confirmed in Phase 61 research; Phase 66 depends on the answer.
- [Phase 67]: The planner may split this phase; the relay transport is separable and can ship last.

## Deferred Items

Items acknowledged and deferred at milestone close, most recent first:

| Category | Item | Status | Deferred At | Milestone |
|----------|------|--------|-------------|-----------|
| *(none)* | | | | |

## Session Continuity

Last session: 2026-10-31
Stopped at: Roadmap for v0.6.0 Team Mode written (Phases 60-67); next is `/gsd-plan-phase 60` (optionally `/gsd-discuss-phase 60` first)
Resume file: None

## Notes

- v0.5.0 (trusted-source knowledge base) is paused here and moving to a separate project. Archive: `.planning/milestones/v0.5.0-paused/`. Code: local branch `gsd/phase-13-sovereignty-gate-post-quantum-cryptography-and-the-encrypted` (not pushed).
- Release checklist for 0.4.x: tsc, lint, full `npm test`, full `npm run test:e2e` (both scenarios), `npm run verify:release`, then publish only with the owner's OK for that version.
