---
phase: 26-performance-faster-agent-and-research-runs
plan: 01
requirements: [PERF-07]
status: complete
commit: 91b89f0
---
# 26-01 Summary: Measurement

- Activity events are bounded by size (256 KiB per session, 5 000 ceiling) instead of the last 100 (`boundEvents`, on write and load).
- Model events record `cachedInputTokens` and `cacheHit`; tool ends record tool and duration and `errorCode: approval-pending`; session stats sum cached tokens and approval timeouts; each run records `run` = { wallMs, modelMs, toolMs, approvalWaitMs, idleMs, input/cached/output tokens } when its main agent ends. Idle covers pauses and waiting for background agents (new `waiting-agents` phase).
- `src/services/runReport.ts`, `scripts/run-report.mjs` (`npm run report:runs`), command `nearAi.showRunReport`.
- Tests: `src/test/runReport.test.ts` (7).
