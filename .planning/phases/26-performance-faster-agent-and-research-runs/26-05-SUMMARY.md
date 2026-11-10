---
phase: 26-performance-faster-agent-and-research-runs
plan: 05
requirements: [PERF-06]
status: complete
commit: f5eee92
---
# 26-05 Summary: Research profile, docs

- `src/gsd/researchProfile.ts`: AGENTS.md block with its own markers, `granularity: coarse` when unset, `gsdProfile: research`, plan-checker skip only when every named plan's files_modified has no gate/verifier/test/CI file.
- `src/gsd/verifierScaffold.ts`: `scripts/verify/` with check-citations, check-figures, check-internal-paths, verify-all (node:fs/path/url only; pass the unattended check).
- Applied with research/writing project types (teamStudioPanel) and by `nearAi.setupResearchVerifiers`; switch `nearAi.gsd.researchProfile`.
- README settings and commands, CHANGELOG Unreleased, SECURITY.md "Sub-agents nobody is watching".
- Tests: `researchProfile.test.ts` (3).
