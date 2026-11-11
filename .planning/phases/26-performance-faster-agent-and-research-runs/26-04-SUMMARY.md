---
phase: 26-performance-faster-agent-and-research-runs
plan: 04
requirements: [PERF-04, PERF-05]
status: complete
commit: 1af5dac
---
# 26-04 Summary: Parallelism and reloads

- WebFetch/WebSearch were already `concurrent`, CheckCitations is a read; now covered by a test.
- `src/agent/readOnlyShell.ts` + `ShellSession.fork()` + `AgentTool.concurrentFor`: strictly read-only Bash commands run in their own shell beside other lookups; everything else stays serial.
- `nearAi.agent.maxParallelWorktrees` (4) caps worktree sub-agents; the lead prompt tells parallel writers to use worktrees; the system prompt has a "Working fast" batching section.
- `onProgress` saves the transcript after every finished call; `repairTranscript` gives only unfinished calls a placeholder; cut-off runs from the last 12 h resume by themselves with a notice (`autoResumeAfterReload`).
- Tests: `parallelTools.test.ts` (6), `autoResume.test.ts` (3), a new auto-resume sidebar test in `conversations.test.ts`. The existing Resume/Dismiss sidebar tests now run with the setting explicitly off (unchanged assertions).
