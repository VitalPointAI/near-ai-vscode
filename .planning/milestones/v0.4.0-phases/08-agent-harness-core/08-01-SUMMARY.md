# 08-01 Summary: agent harness core

Completed 2026-10-26. Clean-room implementation in `src/agent/`; no third-party agent-runtime code is copied or bundled.

| Requirement | What exists | Evidence |
| --- | --- | --- |
| HARN-01 | `NearAiClient.streamCompletion` streams one tool-calling turn over NEAR's OpenAI-compatible API, assembling indexed tool-call fragments, with usage and the `inference-id`. `AgentRun` alternates model turns and tool execution with a turn limit and cancellation; consecutive read-only calls run in parallel, state-changing calls one at a time. Run cost: estimates summed per turn; actual cost for all turns in one `POST /v1/billing/costs`. | `agentLoop.test.ts` (scripted model, fragment assembly), `chatSendPath.test.ts` |
| HARN-02 | Read (numbered lines, paging, binary/directory refusal), Write, Edit (exact unique match or replace_all; must Read first), Glob, Grep (VS Code's bundled ripgrep, located for old and new layouts, or a JS fallback), all confined to the workspace including through symlinks. | `agentTools.test.ts`, `agentBasics.test.ts` |
| HARN-03 | Persistent bash session (cd and exports carry over; stdin from /dev/null; marker-based exit codes; timeout kills the process group and restarts), background jobs with BashOutput and KillShell. | `agentBasics.test.ts` |
| HARN-04 | `decidePermission`: reads/plans run; writes follow `nearAi.actionPolicy`; commands follow deny list → run grants → allow list (simple commands only) → policy; emergency stop denies all; likely credential files ask before reading. Approval cards show diffs or exact commands with Allow / Allow for this run / Deny + note. | `agentBasics.test.ts`, `agentLoop.test.ts`, sidebar render check |
| HARN-05 | `RunCheckpoints` snapshots each file before its first change in a run, persisted to extension storage; one Revert restores edits and deletes created files. Shell side effects are not captured, and the UI says so. | `agentBasics.test.ts`, `chatSendPath.test.ts` (approve → edit → revert through the sidebar host) |
| HARN-06 | TodoWrite publishes the task list, pinned above the composer. | `agentTools.test.ts`, render check |
| HARN-07 | Tool calls, model turns, and run outcomes recorded in ActivityStore (titles and outcomes only, no file contents). | `agentSession.ts` |
| HARN-08 | Implemented from scratch for this extension, including the system prompt (`src/agent/systemPrompt.ts`). | review |
| MODEL-02/03 | Profiles are NEAR AI Cloud, a local OpenAI-compatible runtime (key optional), or hybrid (both, routed per model). Local models are labelled "Local · runs on this machine", allowed in TEE-only mode, and never trigger NEAR catalog or billing calls; each key goes only to its own endpoint. | `chatSendPath.test.ts` (local and hybrid) |

Not in this phase: `@nearai` stays chat-only (agent runs there come with phase 9's interactive approvals); sub-agents, context compaction, and resumable transcripts are phase 10.
