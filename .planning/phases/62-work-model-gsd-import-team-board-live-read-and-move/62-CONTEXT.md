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

## Owner decision (2026-11-03): self-assignment

Amends the assignment added after the hands-on check (G-62-5, D-18) and the 62-15 rule that only the owner and leads assign.

- Any confirmed member who is not an observer (owner, lead, developer, reviewer) may assign a card to themselves and unassign themselves. On the board they see "Assign to me" on an unassigned card and "Unassign me" on a card assigned to them, in the Move to... menu and the card detail.
- Owners and leads still assign and unassign anyone, with the person list.
- Observers cannot assign or unassign, and that includes a joined member who is still waiting for a lead to confirm them (they are observers until then).
- The signed events stay exactly as 62-15 made them (item.assigned { id, memberId }, item.unassigned { id }); a new permission path (item.assign-self) decides a member's own assignment on write and on read, so no event shape and no Phase 60 to 62 hash changes. Reviewers can now hold an assignment.
- Planner reading, confirmed in 62-25's checkpoint: a member can take only an unassigned card; a card assigned to a teammate changes hands only when that teammate unassigns themselves or a lead reassigns it, so nobody's card is taken over silently.
- Plans: 62-25 (permission path), 62-19 (model), 62-20 (board), 62-24 (real-window check and the owner's hands-on repeat).

---

*Phase: 62-work-model-gsd-import-team-board-live-read-and-move*
*Context gathered: 2026-11-02*

- Owner confirmed (2026-11-03): self-assignment applies only to an unassigned card; a card held by a teammate changes hands only when that teammate unassigns themselves or a lead reassigns it ("planned version"). The 62-25 checkpoint takes confirm-recorded.

## Owner amendments (2026-11-03, after the hands-on check)

The owner checked the 0.6.0 team preview by hand on 2026-11-03 and stopped the check to ask for a fix pass (62-UAT.md, gaps G-62-1 to G-62-7). These amendments are added to the decisions above and do not rewrite them; where the two differ, the amendment is the rule. Plans 62-15 to 62-25 build them.

- **The board opens only in its own editor tab (amends D-15, and AD-22 in 62-UI-SPEC.md).** The full board opens only as an editor tab, when the person chooses Open board in the sidebar Team section, clicks the Team status bar line or runs NEAR AI: Open Team Board. A second Open shows the tab that is already open. There is no Team Board view in the NEAR AI sidebar, and nothing opens by itself when Team Mode turns on or a session starts. The board page has no button or message that opens the board. The sidebar Team section shows a compact summary instead: how many cards are ready, how many are blocked, how many are mine, and Open board. (62-17 removes the sidebar view; 62-18 fills the summary. G-62-1.)
- **A lead assigns cards to people (amends D-18's "assignee initials when claimed (63)").** The owner or a lead assigns a card to a member, and unassigns it, from Move to... and from the card detail. Each change is a signed item.assigned or item.unassigned event, checked against permissions on write and on read like every other event. The card face shows the person, and the member lane uses the assignee. Claims, leases and the claimed and in-progress moves stay in Phase 63. Any member who is not an observer also assigns themselves and unassigns themselves with Assign to me and Unassign me; the rules are in the section "Owner decision (2026-11-03): self-assignment" above and are not repeated here. (62-15 events, 62-25 self-assignment path, 62-19 model, 62-20 board. G-62-5.)
- **Phases with no plans show as Backlog cards (amends D-08).** A phase that has no plans yet appears as a card in Backlog, so planned but unstarted work can be seen. Phases with plans stay lane headers with progress. (62-19. G-62-3.)
- **What starts open (refines D-13).** Backlog and Ready start expanded, and so does any lane with active or upcoming work. Done and Cancelled start folded, together with the four later columns (Claimed, In progress, In review, Shipping). A lane starts collapsed only when it holds nothing outside Done and Cancelled. (62-19 model, 62-21 page. G-62-3.)
- **Drag and drop works in a real window (D-16).** Dragging a card to an allowed column must work in a real VS Code window and in code-server, and a refused drop snaps back with its reason. An e2e that drags with real mouse input proves it. Move to... stays the keyboard path. (62-16 tools, 62-23. G-62-6.)
- **The toolbar is solid and the board is the only scroller.** The toolbar has a solid background, and the board region below it is the only part of the page that scrolls, so cards never pass under the toolbar or show through it. (62-21, proven by 62-22. G-62-2, G-62-4.)
- **Cards must be readable (G-62-7).** A folded column shows only its name and count and holds no cards. Titles wrap between words, never inside a word. A card's main button keeps card styling (left aligned, theme text colour), not the look of a plain button. (62-21, proven by 62-22.)
- **Real screenshots are part of verification.** Verification includes real screenshots of the board in a VS Code window on a hidden virtual screen, and the owner reviews them before the phase is accepted. (62-16 tools, 62-22 and 62-24.)

## Owner decision (2026-11-04): unassigning yourself

Found in the owner's re-test on 0.6.3 (62-UAT "Re-test on 0.6.3"): "Bob shouldn't be able to unassign himself from cards that Alice assigned him - only those he assigns himself." Narrows the self-assignment decision of 2026-11-03.

- A member who is not the owner or a lead can take themselves off a card only when they assigned it to themselves. A card the owner or a lead assigned to them stays theirs until the owner or a lead changes it.
- Assigning yourself an unassigned card, and the owner's and leads' assigning and unassigning of anyone, are unchanged.
- Every client records who made a card's current assignment (assignedBy, the author of the item.assigned event) and uses it on write and on read. The signed events, the hash version, card history and the pinned hashes stay as they are.
- On the board, Unassign me appears only on cards you took yourself; on a card a lead assigned to you, the card detail says "Assigned to you by {name}. Ask a lead to change it." instead.
- Teams that used the 0.6.x previews: a self-unassignment from a lead-assigned card that 0.6.3 accepted is rejected once everyone updates, so that card shows the member again.
- Plan: 62-26.

## Owner decision (2026-11-04): assignees move their own cards

"developers should be able to move cards they have been assigned." Any confirmed non-observer member who is the current assignee of a card (assigned by a lead or by themselves) may make the board moves on that card: mark done, block/unblock, hold/release, reopen. Cancel (and reopen from Cancelled) stays with the owner and leads (orchestrator default, owner may override). Owners and leads may still move any card. Enforced on write and read (actionForEvent with state), signed events unchanged. Drag follows the same rule.
