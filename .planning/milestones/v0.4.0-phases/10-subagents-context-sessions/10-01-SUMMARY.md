# 10-01 Summary: sub-agents, background work, context, and sessions

Completed 2026-10-26.

| Requirement | What exists | Evidence |
| --- | --- | --- |
| HARN-09, AGENT-01 | Agent/Task run GSD definitions in the foreground or with `run_in_background` (returns at once; the report reaches the parent before its next turn, and a run does not end while background agents work). A concurrency limit (`nearAi.agent.maxParallelAgents`, slot reserved atomically) and per-run turn limit apply. Running agents appear above the composer with Pause (before the next turn), Resume, and Stop. | `agentFleet.test.ts` (background, limit, pause) |
| AGENT-02/03, OBS-01 | Sub-agents record `kind: 'agent'` activity events with agent ID, role, task, model, tokens, cost, duration, and outcome, so the Tools-tab fleet view and analytics show real agents. | `agentFleet.test.ts` (AnalyticsStore fleet) |
| AGENT-04 | Each sub-agent has a stable visible identity (`<definition>-<id>`) and its rows, approvals, and controls carry it. | `agentSession.ts` |
| HARN-10, CTX-01/02/04 | Context use per turn from reported usage or an estimate, against the model's catalog window. Over 60% used, older tool output is trimmed; at Open-GSD's warning threshold (35% remaining) the user is told; at critical (25%) earlier history is summarized by the model (cut on a user-message boundary, never splitting a tool call from its result) and a context-critical handoff is written to `.planning/HANDOFF.json`. If summarizing fails, trimming still applies and the user is told. | `agentFleet.test.ts` |
| HARN-11, CHAT-04, CTX-03 | Full transcripts saved in extension storage per project (50 kept; `nearAi.agent.saveTranscripts`); History lists them and resumes one with its full context, replaying the visible turns. | `agentFleet.test.ts` |
| HARN-12 | WebFetch shipped in phase 9. Assessed: Open-GSD's `Workflow` tool and MCP servers (context7 and similar) are not provided; workflows receive an unavailable-tool error and use their documented fallbacks. WebSearch has no NEAR endpoint. | `SECURITY.md` limitations |

AGENT-05..07 (reputation, persistent agent profiles, accepted teams) are phase 11.
