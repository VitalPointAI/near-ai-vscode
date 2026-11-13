---
gsd_state_version: "1.0"
milestone: v0.7.0
milestone_name: Messaging relay — Teams and Signal
current_phase: 27
current_phase_name: Project state follows the project across interfaces and machines (0.4.20)
status: planning
stopped_at: Completed 27-02-PLAN.md
last_updated: "2026-11-13T13:48:53.513Z"
state_head: 4976814df91c4deef4842b87d1fa0b5530a792cb
progress:
  total_phases: 9
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
last_activity: 2026-11-13
last_activity_desc: v0.7.0 roadmap created (Phases 68-76, 45 requirements mapped); REQUIREMENTS.md traceability written
---

# Project State

## Current position

Milestone: v0.7.0 Messaging relay — Teams and Signal (Phases 68-76)
Phase: 27 (Project state follows the project across interfaces and machines (0.4.20)) — EXECUTING
Next: `/gsd-plan-phase 27`; then Phase 68 Relay foundation

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

## Notes

- v0.5.0 (trusted-source knowledge base) is paused and moving to a separate project. Archive: `.planning/milestones/v0.5.0-paused/`. Code: local branch `gsd/phase-13-sovereignty-gate-post-quantum-cryptography-and-the-encrypted` (not pushed).
- Release checklist for 0.4.x: tsc, lint, full `npm test`, full `npm run test:e2e` (both scenarios), `npm run verify:release`, then publish only with the owner's OK for that version.

## Session

**Last session:** 2026-11-13T13:48:53.496Z
**Stopped at:** Completed 27-02-PLAN.md
**Resume file:** None

## Performance Metrics

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 27 P02 | 13 min | 3 tasks | 12 files |

## Decisions

- [Phase 27]: 27-02: mergeRecordSets is a set function (family grouping, dedupe by rev, supersede, tombstones, canonical fork placement), not a pairwise fold, so merge order cannot change the result
- [Phase 27]: 27-02: the newest tombstone of each id is always kept and liveRecords() hides it; thread entries are keyed by (thread,id) and the earliest copy is kept
