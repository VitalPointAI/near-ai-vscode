# 09-01 Summary: Open-GSD on the runner

Completed 2026-10-26. The Codex bridge (`gsdRunner.ts`, `gsdUpdater.ts`) is removed; Open-GSD's Claude runtime runs on the extension's own agent runner over NEAR AI.

| Requirement | What exists | Evidence |
| --- | --- | --- |
| RUN-01 | `GsdRuntime` installs `@opengsd/gsd-core@<exact version> --claude --global` with `CLAUDE_CONFIG_DIR` set to `<extension storage>/gsd/<version>/`, never `~/.claude`. Each version keeps its own directory (the installer writes absolute paths); `current.json` points at the active one. | `workspaceIsolation.test.ts` (fake installer laying out a real runtime) |
| GSD-03/04/05 | In NEAR AI projects only, an installed runtime is checked at startup and daily; installs happen only when a workflow runs. A new version must pass `selfTest` (VERSION, gsd-tools, loadable skills and agents, every runtime include resolves) before `current.json` moves; a failing release leaves the previous version active; one previous version is kept. Exact versions only; failures are reported. | `workspaceIsolation.test.ts` |
| RUN-02 | `library.ts` discovers skills (`skills/*/SKILL.md`, legacy `commands/**`) and agents (`agents/*.md`) from whatever version is installed, parses frontmatter generically (unknown keys ignored), substitutes `$ARGUMENTS`, expands `@` includes recursively (absolute, `~/.claude/…`, project-relative, runtime-relative, trailing punctuation tolerated), and maps model tiers by name pattern. | `gsdCompatibility.test.ts` against the real Open-GSD 1.19.0 install: self-test clean, all 72 skills and 35 agents load and expand |
| RUN-03 | The sidebar's `/` menu lists every installed skill with its argument hint, refreshed from the host; `/gsd-plan-phase 3` and `/plan-phase 3` both work; `@nearai` slash commands hand off to the sidebar. | `chatSendPath.test.ts`, `sidebarChat.test.ts` |
| RUN-04 | AskUserQuestion (Claude Code's published schema) pauses the run and renders a question card with options, multi-select, and free text; the answers return to the same run. | `chatSendPath.test.ts` (GSD skill run) |
| RUN-05 | The agent's shell gets `CLAUDE_CONFIG_DIR`; when no `node` is on PATH, a wrapper running VS Code's bundled Node is added; `ELECTRON_RUN_AS_NODE` never leaks into commands. | `runtime.ts`, `shell.ts` |
| Agent / Task | GSD sub-agents run as nested runner runs: the definition's instructions (includes expanded), only its declared tools that exist, its tier's model (falling back to the chat's model when the provider lacks it), shared approvals and run grants, prefixed activity rows, and costs counted in the run total. | `chatSendPath.test.ts` |
| CHAT-05 | Status line: STATE.md progress plus live sub-agent count and today's spend; no more `undefined`. | `gsdStatus.ts` |
| Skill, WebFetch | Skill loads another skill's expanded instructions; WebFetch (https only, approval required) returns page text. | `gsd/tools.ts` |

Open: RUN-06 (a full new-project → plan → execute run on NEAR AI) needs a live NEAR AI key and is verified in phase 12's opt-in live tests. Background sub-agents, Workflow, and MCP tools are phase 10.
