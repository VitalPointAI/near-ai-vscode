---
phase: 26-performance-faster-agent-and-research-runs
status: passed
verified: 2026-11-10
requirements: [PERF-01, PERF-02, PERF-03, PERF-04, PERF-05, PERF-06, PERF-07]
---

# Phase 26 verification: Performance — faster agent and research runs

## Before baseline (PERF-07)

Measured with this phase's own report (`npm run report:runs -- <activity.json>`) on the activity logs of two of the owner's research projects (called
A and B because the repository is public). Both logs were written with the old 100-event cap per session, so event-based figures (model calls,
latencies, tool counts) are lower bounds; the per-agent counters in each session are not capped. Logs were read, never modified. Neither log had a
recorded run split, so the split is estimated from the summed agent counters, scaled to fit each run's wall time.

| | Project A | Project B |
| --- | --- | --- |
| Runs | 18 | 17 |
| Wall time | 59.7 h | 86.0 h |
| Model wait | 19.1 h (32%) | 24.7 h (29%) |
| Tools and sub-agents | 19.9 h (33%) | 30.6 h (36%) |
| Approval wait | 16.1 h (27%) | 21.2 h (25%) |
| Idle | 4.6 h (8%) | 9.4 h (11%) |
| Approvals nobody answered (agent counters) | 106 | 135 |
| Of those, 15-minute tool failures still in the capped event log | 20–26 | 12–18 |
| Input tokens | 811,823,374 | 792,478,800 |
| Cached input tokens | 0 (0%) | 0 (0%) |
| Output tokens | 5,537,754 | 6,934,059 |
| Model calls in the log | 512 | 449 |
| Model latency p50 / p90 / max | 8 s / 56 s / 871 s | 8 s / 123 s / 777 s |
| Input tokens per call, median / max | 191,653 / 604,909 | 185,840 / 351,114 |
| Output tokens per call, median | 284 | 289 |
| Tool calls per model call | 1.05 | 1.20 |
| Models | DeepSeek-V4.1-Flash (abliterated), GLM-5.3-Flash | the same |
| Runs ended by a VS Code reload | 1 (4.3 h of work) | 1 (20 min) |

Notes on the counts. The owner's brief counted 26 and 13 approval timeouts from the event log; pairing each failed tool call with the nearest
preceding start gives 24 and 18, strict start/end pairing 20 and 16, so the exact figure depends on how parallel calls are paired. The agent
counters (`approvalsExpired`, never capped) give 106 and 135, which is the figure the report now uses. The brief's 4.4 h and 0.6 h reload losses
were measured to the end of the run; the report measures to the last recorded event (4.3 h and 20 min).

What the baseline says: about a quarter of all wall time was a run waiting on an approval nobody was there to give; every request re-sent about
190k tokens to produce under 300 with no cache hits recorded; one tool call per model turn; and two runs were lost to reloads.

## Requirements

| Requirement | Evidence | Status |
| --- | --- | --- |
| PERF-01 | `src/agent/unattended.ts`, `decidePermissionAsync` (permissions.ts), `askApproval`/`pauseRun`/`lateApproval` (agentSession.ts). `unattendedApproval.test.ts`: safe commands and clean verify scripts run; `git push`, `rm -rf` outside, `npm publish`, `vsce publish`, `gh release`, `~/.ssh`, a NEAR key file, `~/.aws/credentials`, `curl`, `wget`, `node -e`, `bash -c "git push"` still ask; scripts with curl/rm/child_process/push/credential/outside paths/env/fetch/source still ask; approve-risky, the main run, the deny list and the emergency stop unchanged. `approvalStalls.test.ts`: "awaiting approval" after the short wait, three pause the run, a late allow resumes and reaches the lead; the main run still waits. | passed |
| PERF-02 | `contextAction` (context.ts), ranged Read (tools.ts), `boundedReport`, `completionRequestBody` (nearAiClient.ts). `contextDiscipline.test.ts` proves compaction at 70k on a 1M window, ranged reads with outline, report cap, a byte-stable request prefix over five turns of two runs, and cached tokens in the activity log and run split. | passed |
| PERF-03 | Stall deadline and backup in `AgentRun.modelTurn` (`stallMs`, re-armed on every streamed text, reasoning or tool-call progress event; `DEFAULT_TURN_CEILING_MS` 30 min); backup selection in chat.ts; `DEFAULT_ROLE_MODELS`. `modelDeadline.test.ts`: a slow but steady reply (text or tool-call progress) completes on the primary; a stalled first token retries on the backup with nothing to discard; a mid-stream stall retries without duplicated output; the backup is never cut; no backup means no cut; the client emits progress for tool-call deltas; tier routing for every named role. | passed |
| PERF-04 | `readOnlyShell.ts`, `ShellSession.fork`, `concurrentFor`, `Slots` worktree cap, lead and system prompts. `parallelTools.test.ts`: web tools concurrent, strict read-only recogniser, read-only Bash calls start together while a write runs alone and first, a forked shell runs at the agent's folder, the cap holds, prompts say to batch. | passed |
| PERF-05 | `onProgress` checkpoints, `repairTranscript`, `shouldAutoResume`, auto-resume in chat.ts. `autoResume.test.ts` and the new sidebar test in `conversations.test.ts`: state saved after each call, only unfinished calls get a placeholder, a cut-off run resumes by itself with a notice and does not repeat its finished Read. | passed |
| PERF-06 | `researchProfile.ts`, `verifierScaffold.ts`, teamStudioPanel hook, `nearAi.setupResearchVerifiers`, plan-checker gate in the spawn. `researchProfile.test.ts`: profile applied idempotently without overwriting, plan-checker skipped only for content-only plans, the scaffolded scripts pass the unattended check and catch citation, figure and leak problems. | passed |
| PERF-07 | `boundEvents`, `RunSplit`, `runReport.ts`, `scripts/run-report.mjs`, `nearAi.showRunReport`. `runReport.test.ts` (7 tests); the baseline above. | passed |

## Checks (final)

| Check | Result |
| --- | --- |
| `npm run lint` | exit 0 |
| `npm test` | `ℹ tests 1251` · `ℹ pass 1243` · `ℹ fail 0` · `ℹ skipped 8` (baseline before the phase: 1215 / 1207 / 0 / 8) |
| `npm run test:e2e` | both scenarios passed, exit 0 (`VSCODE_TEST_VERSION=1.143.1`, the cached build) |
| `npm ls --omit=dev --all` | `(empty)`: no runtime dependency added |
| `node scripts/secret-scan.mjs --range main..HEAD` | clean |

## Tests changed

- `roleModels.test.ts`: `roleModelFor('gsd-planner', DEFAULT_ROLE_MODELS)` now expects `deep` instead of `undefined`. This is the PERF-03 change the
  owner approved, not a weakened check; `gsd-executor` still has no default.
- `conversations.test.ts`: the test VS Code configuration reads `agent.autoResumeAfterReload` from a switch that is off by default, so the existing
  Resume and Dismiss tests keep testing the manual path with unchanged assertions; a new test turns it on and checks the automatic path.

## Deliberately not done

- Role definitions and tiers in `src/agent/projectTypes.ts` are untouched (owned by feat/pdf-docx-output).
- No undocumented request field (such as a prompt-cache key) is sent to NEAR; whether NEAR now reports cache hits needs a live run to confirm.
- No automatic merge of parallel worktrees.
- The "after" numbers need real runs on this build: run `npm run report:runs` on the same projects after a few runs and compare with the table above.
