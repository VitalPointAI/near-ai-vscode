---
phase: 26-performance-faster-agent-and-research-runs
plan: 03
requirements: [PERF-02, PERF-03]
status: complete
commit: 413cee9
---
# 26-03 Summary: Context and models

- `contextAction()` compacts at `compactAtTokens` (70 000) or the window's critical level, trims from 80 % of it.
- Read without a range on a file over 600 lines returns 400 lines plus an outline.
- Sub-agent reports capped at 12 000 characters (`boundedReport`); the Open-GSD prompt asks for one sub-agent per plan/task/workstream returning a summary.
- `completionRequestBody()` builds every request; a test proves tools are byte-identical and messages a byte prefix across turns, and cached tokens reach the activity log.
- Model stall deadline (`modelStallSeconds`, 120: time to first token and between chunks; a steady stream is never cut; 30-min ceiling per reply) retries once on `backupModel` (standard tier, then deep, only models as private as the chat's).
- Tier routing defaults: planner, plan-checker, verifier, analyst, editor, red-team → deep; fetch, extract → fast.
- Tests: `contextDiscipline.test.ts` (4), `modelDeadline.test.ts` (3). `roleModels.test.ts`: the gsd-planner default expectation moved from undefined to `deep`, the owner-approved PERF-03 change.
