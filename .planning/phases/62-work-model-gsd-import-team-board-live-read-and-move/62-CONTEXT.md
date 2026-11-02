# Phase 62: Work model, GSD import, Team Board (live, read and move) - Context

**Gathered:** 2026-11-02
**Status:** Ready for planning
**Mode:** interactive (owner answered every gray area). Spec phase 27 = this Phase 62.
**Branch:** `gsd/phase-62-work-model-gsd-import-team-board-live-read-and-move` in the `.claude/worktrees/team-mode` worktree, cut from the Phase 61 tip (`310aa05`), with the released `v0.4.11` tag merged in (`85bfec9`). Phase 61 is awaiting the owner's real-NEAR check; Phase 62 depends only on Phase 60. Do not touch `main` or the Phase 25 cyber-harness work (another agent owns it).

<domain>
## Phase Boundary

The project's GSD roadmap, phases and plans (with their tasks) become signed work items on the team log. Every member sees one live Team Board built from them, sees other members' changes within one poll, and can move cards only along permitted transitions with permission checks.

Delivers: `gsdImport.ts` (ROADMAP, phase directories and `*-PLAN.md` frontmatter and tasks into a WorkItem graph with stable IDs), the `item.*` event validators and state machine, board-created items, the board webview (sidebar list and editor-panel kanban, client code in `media/board/`, nonce CSP, provider outside `chat.ts`), swimlanes, filters, card face and detail, and the Team status bar line.

Not in this phase: claims, leases and the claim/release/in-progress transitions (63), dispatch and Next Task (64), integration, review and the done-by-integration path plus writing board items back as GSD quick tasks (65), budgets and spend on cards (66), milestone release card, comments and mentions, and relay latency (67).

</domain>

<decisions>
## Implementation Decisions

### Import: source, writer, trigger
- **D-01:** Import reads `.planning` from the team's integration branch as committed (`policy.integrationBranch`, default `main`), through git (for example `git show <ref>:<path>` / `ls-tree`), never from the importing member's working tree. Unmerged local drafts never reach the board. — **Reversibility:** costly — every item ID and state derivation assumes one source of truth.
- **D-02:** Only the owner and leads may write `item.imported` / `item.updated` / `item.cancelled` produced by import. `decideTeamAction` enforces this on write and on read.
- **D-03:** A lead's (or owner's) client re-imports automatically when the integration branch's `.planning` changes (detected on fetch, for example by the tree hash of `.planning` at the branch head), and a `NEAR AI: Import Plans to Team Board` command runs it on demand. Re-import that finds no change writes nothing (idempotent). If several leads' clients race, the transport's CAS re-validation turns the loser into a no-op.
- **D-04:** Item IDs are stable and derived from GSD IDs (`milestone:v0.6.0`, `phase:62`, `plan:62-03`, `task:62-03-2`), so re-import updates rather than duplicates. — **Reversibility:** one-way — IDs are signed into the log.
- **D-05:** A plan or phase that disappears from the roadmap on re-import gets `item.cancelled` with reason "no longer in the roadmap". Nothing is ever deleted; a renumbered plan becomes one cancelled card and one new card.
- **D-06:** State source: on first import a plan whose `*-SUMMARY.md` exists on the integration branch starts `done`, otherwise `backlog`. After that the log owns state. Re-import updates title, dependencies, scope (`files_modified`), estimate, requirements, wave and must-haves, but never moves a card. A plan that gains a SUMMARY later is flagged "done in GSD" for a lead to confirm (D-12). This keeps GSD files the plan of record and the log the status of record (spec D7).

### Cards and hierarchy
- **D-07:** Plans are the cards. Tasks are WorkItems in the graph (for later dispatch and sub-agent leases) but appear as a checklist in the plan card's detail, not as cards in the columns.
- **D-08:** Milestones and phases are WorkItems in the graph shown as swimlane headers with progress (plans done / total, weighted by estimate) when grouping by phase or milestone, not as cards in the columns. Only plans and board-created items move through states.
- **D-09:** The board shows the current milestone (the active one in ROADMAP) by default, with a milestone picker for others. Archived milestones are imported only when a lead asks.

### States and moves this phase
- **D-10:** States are the spec's: `backlog`, `ready`, `claimed`, `in-progress`, `in-review`, `integrating`, `done`, plus `blocked` (a flag with a reason, any state before done) and `cancelled`.
- **D-11:** `ready` is computed, not moved. Every client derives it identically from the log by the spec's ready rule: all `depends_on` done, estimate present, scope declared (files_modified or globs), no unresolved blocker, phase not frozen, and not held. A lead can **hold** a plan in backlog (a signed `item.updated` hold flag) and **release** the hold. Ready derivation is pure and deterministic (no wall clock).
- **D-12:** Moves a person can make in this phase: **block / unblock** with a reason (owner, lead; the claimant joins in 63), **cancel / reopen** (owner, lead; reopen returns to backlog), **mark done** (owner or lead confirms "done in GSD" while integration does not exist yet), and **hold / release**. Every move goes through `decideTeamAction` and the state machine on write and on read; an invalid event is rejected like any other (Phase 60 D-09).
- **D-13:** All columns show in every phase. Dropping into a column that claim or integration owns (`claimed`, `in-progress`, `in-review`, `integrating`) is refused and snaps back with a plain reason ("Claiming arrives with claims" style wording, final text at the planner's discretion). Empty columns can be collapsed.
- **D-14:** Items can be created on the board this phase: a "New item" form (type bug, chore or spike; title, description, scope globs, estimate) writes `item.created`, and edits write `item.updated` / `item.estimated`, with permissions from the 6.3 matrix (owner, lead, developer for own drafts). Writing them back as GSD quick tasks when done (`nearAi.team.writeQuickTasks`) waits for Phase 65.

### Board layout, moving, status bar
- **D-15:** Sidebar: a webview view in the NEAR AI container showing a compact list grouped by state (collapsible groups with counts, filters) and an "Open Team Board" action. Editor panel: the full kanban with swimlanes. One webview codebase in `media/board/`, two layouts chosen by available width. Nonce CSP, no remote resources, provider outside `chat.ts`.
- **D-16:** Moving: drag and drop in the kanban plus a keyboard-reachable "Move to..." menu on every card, which is the only way in the sidebar list. Only permitted targets are offered. A refused drop snaps back and the reason is announced in a live region and shown on the card.
- **D-17:** Team status bar: "Team: N ready · M pending" (ready plans plus members awaiting confirmation from Phase 61); clicking opens the board. "Ready for you" and spend join in Phases 64 and 66.
- **D-18:** Swimlanes by member (default), phase, milestone or none. Filters: mine, ready, blocked, by requirement ID, by phase ("over budget" and "ready for me" wait for 66 and 64). Card face: GSD ID and title, state, assignee initials when claimed (63), dependency count, blocked flag, estimate, age in state. Card detail: description, must-haves, dependencies, scope, task checklist (D-07), history from the log. Accessibility per UX-CONTRACT: keyboard operable, screen-reader labels, never colour alone, reduced motion respected.

### Claude's Discretion
- WorkItem type shapes and event body schemas beyond the constraints above (exact keys, validators in the Phase 60 style).
- How "phase frozen" is represented until a later phase defines freezing.
- Exact wording of refusal reasons and empty states (plain language, no em-dashes).
- Board styling within VS Code theme variables; whether drag and drop uses HTML5 DnD or pointer events.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Spec (source of truth)
- `.planning/research/v0.6.0-team-mode-addendum.md` §5.2 (event types incl. `item.*`), §6.3 (permissions), §6.4 (work model, ready rule, states), §6.5 (Team Board), §7 (data model: WorkItem), §8 (VS Code contributions), §10 (phase 27 = Phase 62), §11 (testing).

### Planning
- `.planning/ROADMAP.md` Phase 62 — goal, scope, success criteria 1 to 5 (e2e gating starts here).
- `.planning/REQUIREMENTS.md` — BOARD-01, BOARD-02, BOARD-03.
- `.planning/PROJECT.md` — Team Mode constraints.
- `.planning/UX-CONTRACT.md` — accessibility, verbosity, privacy boundary.
- `.planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-CONTEXT.md` — D-02, D-03 (ordering), D-07 (type gating), D-09 (validation pipeline), D-12 (permissions), D-17/D-19 (append, polling), D-24 (solo parity).
- `.planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-CONTEXT.md` and its SUMMARYs — roster, pending confirmation count used by D-17, status bar and session wiring.

### Codebase maps
- `.planning/codebase/ARCHITECTURE.md`, `CONVENTIONS.md`, `TESTING.md` (refresh advised: the map is out of date since Phases 60 and 61).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/domain/team/{types,validate,materialize,permissions}.ts`: `item.*` types are declared in `TEAM_EVENT_TYPES` but not implemented; add validators and transitions in the same style.
- `src/team/eventLog.ts` (`TeamLog.append` builder with CAS re-validation), `src/team/runGit.ts` (git reads for D-01), `src/services/team/teamSession.ts` (sync loop, `onUpdate`), `teamStatusBar.ts` (status text, D-17), `memberCommands.ts` (command registration pattern).
- Webview patterns: `media/activity/`, `media/tools/`, `media/mcp/` with `src/services/activityView.ts`, `toolsPage.ts`, `mcpView.ts` (view providers, CSP, message passing, visibility handling).

### Established Patterns
- Team core never imports `vscode`; pure domain in `src/domain/team/`; tests with `node --test`, real git in temp dirs, the vscode stub for adapters; e2e via `node dist/test/e2e/run.js` (run as `env -u ELECTRON_RUN_AS_NODE DISPLAY=:0 node dist/test/e2e/run.js`).
- Every write: `decideTeamAction` then `assertNoSecrets`; the log carries metadata only (plan titles, IDs and file globs are metadata; never plan bodies beyond must-have strings the spec lists, never source or prompts).

### Integration Points
- `package.json`: a webview view in the NEAR AI container, commands `nearAi.team.openBoard`, `nearAi.team.importPlans`; solo projects see the board command explain how to enable Team Mode (D-24 of Phase 60).

</code_context>

<specifics>
## Specific Ideas

- Success criterion 1 is proven on this repository's own `.planning` (Phase 60 to 67 roadmap) read from the integration branch.
- The owner wants the board to look the same in every phase (D-13), with later-phase columns visible but refusing drops.

</specifics>

<deferred>
## Deferred Ideas

- Writing board-created items back as GSD quick tasks when done (Phase 65, with integration).
- "Ready for me", "over budget" filters and spend on cards (Phases 64 and 66); milestone release readiness card (Phase 67).

</deferred>

---

*Phase: 62-work-model-gsd-import-team-board-live-read-and-move*
*Context gathered: 2026-11-02*
