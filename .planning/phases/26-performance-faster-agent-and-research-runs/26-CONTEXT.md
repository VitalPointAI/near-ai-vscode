# Phase 26: Performance — faster agent and research runs (context)

**Gathered:** 2026-11-10 (owner approved all seven recommendations; no discussion round)
**Branch:** perf/research-runs (worktree `.claude/worktrees/perf-research-runs`)

## Evidence

Measured from the activity logs (`.planning/.near-ai/activity.json`) of two of the owner's research projects, called project A and project B here because the repository is public (read only; the paths are in the owner's brief). The logs keep only the last 100 events per session, so every count below is a lower bound. The full baseline is reproduced by `npm run report:runs` and recorded in 26-VERIFICATION.md.

## Decisions

- **D-01 (PERF-01) Unattended class.** The new auto-approval applies to sub-agents only, and only in the `auto` and `mostly-autonomous` modes. `approve-risky` keeps asking for every command (the person chose that), `fully-autonomous` already allows everything. It is switchable (`nearAi.agent.unattendedAutoApprove`, default on).
- **D-02 (PERF-01) What the class allows.** A command the deterministic classifier already calls `safe` (read-only commands, read-only git, tests, lint, typecheck, builds, and writes inside the agent's own root, which is its worktree when it has one), and a verification script run by an interpreter when the script is inside the agent's root, is named like a check (verify, check, gate, lint, test, typecheck, validate, audit) or is named by the plan, and its text passes a static content check (no network, no deletes, no publishing, no credential paths, no subprocesses, no absolute paths outside the root). Never a command the classifier calls `risky`, never anything that reaches the network, and never a script the run itself wrote after reading outside content. The deny list, the tainted-download hold and sensitive-path checks run first, unchanged.
- **D-03 (PERF-01) Non-blocking approvals.** A sub-agent's approval card waits `nearAi.agent.subagentApprovalWaitSeconds` (default 20 s). Unanswered, the call returns "awaiting approval" to the agent and the card stays queued. A later "allow" grants that exact command for the rest of the run and tells the lead. The main run keeps the 0.4.19 park behaviour (the person is at the chat), with its wait still set by `nearAi.agent.approvalTimeoutMinutes`.
- **D-04 (PERF-01) Pause.** Three consecutive "awaiting approval" outcomes in one run (`nearAi.agent.approvalTimeoutsBeforePause`) pause every agent of the run before its next model turn, with a notice. Answering any approval, pressing Resume on an agent, or sending a message resumes.
- **D-05 (PERF-02) Compaction.** An absolute threshold `nearAi.agent.compactAtTokens` (default 70 000) beside the existing percentage thresholds: whichever comes first. Trimming starts at 80 % of it. Trimming keeps its existing step behaviour so the prefix changes rarely.
- **D-06 (PERF-02) Ranged reads.** Read without offset/limit on a file over 600 lines returns the first 400 lines with the file's length and an outline (Markdown headings) so the agent asks for ranges.
- **D-07 (PERF-02) Bounded reports.** A sub-agent's report to its lead is capped at 12 000 characters, with a note.
- **D-08 (PERF-02) Cache.** The request body is built by one exported function; a test drives a multi-turn run and asserts each turn's tools and messages are a byte-identical prefix of the next turn's. Cached tokens go into activity events and session stats.
- **D-09 (PERF-03) Deadline.** `nearAi.agent.modelDeadlineSeconds` (default 120, 0 off). A turn that passes it with a backup model available is cut and retried once on the backup; without a backup the turn keeps waiting (the idle timeout still catches a dead stream). The backup is `nearAi.agent.backupModel`, else the standard tier, else the chat model, among models at least as private as the chat's.
- **D-10 (PERF-03) Tier routing.** `DEFAULT_ROLE_MODELS` gains patterns that send planner, verifier, plan-checker, analyst, editor and red-team roles to `deep`, and fetch and extract roles to `fast`. A team member's own `model:` line still wins, so the role tiers set on feat/pdf-docx-output decide team members. `projectTypes.ts` is not touched.
- **D-11 (PERF-04) Read-only shell pool.** A Bash call whose command is strictly read-only (a fixed list of programs, read-only git subcommands, no redirects, substitutions, `cd` or background jobs) runs concurrently in a fresh shell forked from the agent's shell at its current folder, up to the existing batch size of 8. Permission checks are unchanged and per call.
- **D-12 (PERF-04) Worktree cap.** `nearAi.agent.maxParallelWorktrees` (default 4) caps sub-agents running in their own worktree at once, inside `maxParallelAgents`. The team lead prompt tells the lead to run members that change files in a git repository with `isolation: "worktree"` when several write at once.
- **D-13 (PERF-05) Auto-resume.** `nearAi.agent.autoResumeAfterReload` (default on): a run cut off in the last 12 hours resumes when its conversation reopens, with a notice. The transcript is checkpointed after every tool call; a resumed transcript gets a placeholder result for any call that has none, so finished calls keep their real results and are never re-run by the runner.
- **D-14 (PERF-06) Research profile.** `src/gsd/researchProfile.ts`: an AGENTS.md block with its own markers, `granularity: coarse` in `.planning/config.json` when unset, `gsdProfile: research` in project.json, the plan-checker skipped (with a "VERIFICATION PASSED — skipped" report) when no plan in its prompt changes a gate or verifier, and three dependency-free verifier scripts plus a runner in `scripts/verify/`. Applied when a research or writing project type is applied, or by the command "NEAR AI: Set Up Research Verifiers". Switch: `nearAi.gsd.researchProfile` (default on).
- **D-15 (PERF-07) Size bound.** Events per session are bounded by bytes (256 KiB by default) with a high count ceiling (5 000), not 100.

## Deliberately not done

- No change to role definitions or tiers in `src/agent/projectTypes.ts` (owned by feat/pdf-docx-output).
- No `prompt_cache_key` or other request field NEAR has not documented; caching relies on a stable prefix.
- No automatic merge of parallel worktrees; their branches are reported to the lead as today.
