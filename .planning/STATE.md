---
gsd_state_version: "1.0"
milestone: v0.7.0
milestone_name: messaging-relay-teams-signal
current_phase: 68
status: planning
stopped_at: v0.7.0 roadmap created; Phase 68 ready to plan
last_updated: "2026-11-13T01:05:13.000Z"
state_head: 6fb1522794e0fc44eb16c49b8c63916902546f7c
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
Phase: 68 Relay foundation — not planned
Next: `/gsd-plan-phase 68`, or `/gsd-quick` for small changes

## Accumulated Context

### Roadmap Evolution

- Milestone v0.7.0 added 2026-11-13: Messaging relay — Teams and Signal. Phases 68-76 map all 45 v0.7.0 requirements (RELAY, AUTH, IDNT, RUNL, CMND, GRP, BUDG, TEAM, SGNL, OPS); traceability table in REQUIREMENTS.md.
- Phase numbering starts at 68: branch-shipped phases end at 26; the unmerged `feat/team-fix-pass` branch already claims Phases 60-67 for v0.6.0 — 68 keeps both honest.
- Phase 26 completed on branch perf/research-runs: Performance — faster agent and research runs (PERF-01…07, 5 plans, verified).
- Phase 25 shipped: Cybersecurity harness (CYBER-01…12).

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

**Last session:** 2026-11-13T01:05:13.000Z
**Stopped at:** v0.7.0 roadmap written (ROADMAP.md, STATE.md, REQUIREMENTS.md traceability)
**Resume file:** None
