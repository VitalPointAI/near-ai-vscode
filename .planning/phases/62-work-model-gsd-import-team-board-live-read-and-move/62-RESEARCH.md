# Phase 62: Work model, GSD import, Team Board (live, read and move) - Research

**Researched:** 2026-11-02
**Domain:** Signed work-item events on the team log, a GSD-file importer that reads the integration branch through git, a pure board model, and a VS Code webview (sidebar list plus editor-panel kanban) with live updates
**Confidence:** HIGH for everything read from this repository, MEDIUM for UX and policy choices that CONTEXT leaves to discretion (flagged in the Assumptions Log)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Import: source, writer, trigger**
- **D-01:** Import reads `.planning` from the team's integration branch as committed (`policy.integrationBranch`, default `main`), through git (for example `git show <ref>:<path>` / `ls-tree`), never from the importing member's working tree. Unmerged local drafts never reach the board. — **Reversibility:** costly — every item ID and state derivation assumes one source of truth.
- **D-02:** Only the owner and leads may write `item.imported` / `item.updated` / `item.cancelled` produced by import. `decideTeamAction` enforces this on write and on read.
- **D-03:** A lead's (or owner's) client re-imports automatically when the integration branch's `.planning` changes (detected on fetch, for example by the tree hash of `.planning` at the branch head), and a `NEAR AI: Import Plans to Team Board` command runs it on demand. Re-import that finds no change writes nothing (idempotent). If several leads' clients race, the transport's CAS re-validation turns the loser into a no-op.
- **D-04:** Item IDs are stable and derived from GSD IDs (`milestone:v0.6.0`, `phase:62`, `plan:62-03`, `task:62-03-2`), so re-import updates rather than duplicates. — **Reversibility:** one-way — IDs are signed into the log.
- **D-05:** A plan or phase that disappears from the roadmap on re-import gets `item.cancelled` with reason "no longer in the roadmap". Nothing is ever deleted; a renumbered plan becomes one cancelled card and one new card.
- **D-06:** State source: on first import a plan whose `*-SUMMARY.md` exists on the integration branch starts `done`, otherwise `backlog`. After that the log owns state. Re-import updates title, dependencies, scope (`files_modified`), estimate, requirements, wave and must-haves, but never moves a card. A plan that gains a SUMMARY later is flagged "done in GSD" for a lead to confirm (D-12). This keeps GSD files the plan of record and the log the status of record (spec D7).

**Cards and hierarchy**
- **D-07:** Plans are the cards. Tasks are WorkItems in the graph (for later dispatch and sub-agent leases) but appear as a checklist in the plan card's detail, not as cards in the columns.
- **D-08:** Milestones and phases are WorkItems in the graph shown as swimlane headers with progress (plans done / total, weighted by estimate) when grouping by phase or milestone, not as cards in the columns. Only plans and board-created items move through states.
- **D-09:** The board shows the current milestone (the active one in ROADMAP) by default, with a milestone picker for others. Archived milestones are imported only when a lead asks.

**States and moves this phase**
- **D-10:** States are the spec's: `backlog`, `ready`, `claimed`, `in-progress`, `in-review`, `integrating`, `done`, plus `blocked` (a flag with a reason, any state before done) and `cancelled`.
- **D-11:** `ready` is computed, not moved. Every client derives it identically from the log by the spec's ready rule: all `depends_on` done, estimate present, scope declared (files_modified or globs), no unresolved blocker, phase not frozen, and not held. A lead can **hold** a plan in backlog (a signed `item.updated` hold flag) and **release** the hold. Ready derivation is pure and deterministic (no wall clock).
- **D-12:** Moves a person can make in this phase: **block / unblock** with a reason (owner, lead; the claimant joins in 63), **cancel / reopen** (owner, lead; reopen returns to backlog), **mark done** (owner or lead confirms "done in GSD" while integration does not exist yet), and **hold / release**. Every move goes through `decideTeamAction` and the state machine on write and on read; an invalid event is rejected like any other (Phase 60 D-09).
- **D-13:** All columns show in every phase. Dropping into a column that claim or integration owns (`claimed`, `in-progress`, `in-review`, `integrating`) is refused and snaps back with a plain reason ("Claiming arrives with claims" style wording, final text at the planner's discretion). Empty columns can be collapsed.
- **D-14:** Items can be created on the board this phase: a "New item" form (type bug, chore or spike; title, description, scope globs, estimate) writes `item.created`, and edits write `item.updated` / `item.estimated`, with permissions from the 6.3 matrix (owner, lead, developer for own drafts). Writing them back as GSD quick tasks when done (`nearAi.team.writeQuickTasks`) waits for Phase 65.

**Board layout, moving, status bar**
- **D-15:** Sidebar: a webview view in the NEAR AI container showing a compact list grouped by state (collapsible groups with counts, filters) and an "Open Team Board" action. Editor panel: the full kanban with swimlanes. One webview codebase in `media/board/`, two layouts chosen by available width. Nonce CSP, no remote resources, provider outside `chat.ts`.
- **D-16:** Moving: drag and drop in the kanban plus a keyboard-reachable "Move to..." menu on every card, which is the only way in the sidebar list. Only permitted targets are offered. A refused drop snaps back and the reason is announced in a live region and shown on the card.
- **D-17:** Team status bar: "Team: N ready · M pending" (ready plans plus members awaiting confirmation from Phase 61); clicking opens the board. "Ready for you" and spend join in Phases 64 and 66.
- **D-18:** Swimlanes by member (default), phase, milestone or none. Filters: mine, ready, blocked, by requirement ID, by phase ("over budget" and "ready for me" wait for 66 and 64). Card face: GSD ID and title, state, assignee initials when claimed (63), dependency count, blocked flag, estimate, age in state. Card detail: description, must-haves, dependencies, scope, task checklist (D-07), history from the log. Accessibility per UX-CONTRACT: keyboard operable, screen-reader labels, never colour alone, reduced motion respected.

### Claude's Discretion
- WorkItem type shapes and event body schemas beyond the constraints above (exact keys, validators in the Phase 60 style).
- How "phase frozen" is represented until a later phase defines freezing.
- Exact wording of refusal reasons and empty states (plain language, no em-dashes).
- Board styling within VS Code theme variables; whether drag and drop uses HTML5 DnD or pointer events.

### Deferred Ideas (OUT OF SCOPE)
- Writing board-created items back as GSD quick tasks when done (Phase 65, with integration).
- "Ready for me", "over budget" filters and spend on cards (Phases 64 and 66); milestone release readiness card (Phase 67).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| BOARD-01 | The board reflects GSD milestones, phases, plans and tasks, re-imports idempotently, and shows dependencies, scope, estimate and state. | Sections "GSD file formats (verified)", "Import design", "Event bodies", "Board model". Importing HEAD of this repo yields 98 items (1 milestone, 8 phases, 26 plans, 63 tasks) in one batch. |
| BOARD-02 | Board changes from any member appear on every other member's board within the poll interval (git) or within 2 s (relay). | "Live updates": state is applied incrementally by the transport, so a poll costs one fetch plus O(new events); a `TeamSession` change hook and a board-visible poll trigger are the two missing pieces. Relay half is Phase 67. |
| BOARD-03 | Moves are permission-checked and only follow permitted transitions. | "State machine and permissions": one pure `planMove` used by the UI (which targets to offer) and by the write path; the materializer re-checks with `decideTeamAction` plus transition preconditions on read. |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

No `CLAUDE.md` exists in the repository root (confirmed by the orchestrator). The binding constraints are the ones in `.planning/PROJECT.md` and `.planning/ROADMAP.md` (Phase 62 ground rules) plus the user's global rules:

- `src/domain/team/*` and `src/team/*` never import `vscode`; no new runtime dependencies (the repo has no `dependencies` block at all, only `devDependencies`); integer money; ordering never uses wall-clock time. [VERIFIED: ROADMAP.md lines 35-37 and package.json]
- `npm run lint` and the full `npm test` pass at the end of every phase; **from Phase 62 on `npm run test:e2e` passes too**. [VERIFIED: ROADMAP.md line 35: "`npm run lint` and the full `npm test` pass at the end of every phase; from Phase 62 on, `npm run test:e2e` passes too."]
- The coordination log carries metadata only: no prompts, source, diffs, tool output or secrets. [VERIFIED: ROADMAP.md line 37]
- Global verification cadence (user CLAUDE.md): after an edit run the smallest relevant unit/type/lint check; run the whole suite once at the phase boundary; security, authorization, data-integrity and architectural-boundary checks block immediately; never weaken a failing test to get green; broad visual/browser sweeps are diagnostic unless a functional or accessibility contract is touched.
- Solo parity: a project without `.planning/.near-ai/team.json` behaves exactly as 0.4.8 (activation does one `fs.stat` and nothing else). [VERIFIED: teamCommands.ts header comment lines 1-4 and teamSoloParity.test.ts header]
- Product strings authored in this phase use no em-dashes (enforced for existing team strings by a test, `teamManifest.test.ts`); imported titles are user data and may contain them.

## Summary

Phase 62 is mostly a pure-domain phase with two thin adapters. The Phase 60/61 core already gives everything the board needs: an incremental materializer (`fetchLocked` reads only `${lastProcessed}..${LOCAL_REF}`), a CAS append builder that re-derives intents from fresh state, `decideTeamAction` on both sides, 16 KB-per-event validation, and a sync scheduler. What is missing is (1) the eight `item.*` event bodies, validators and transitions, plus a snapshot parser for items (the current one hard-refuses non-empty `items`), (2) a pure GSD importer, (3) a git reader for the integration branch, (4) a pure board view model, and (5) the webview host and client.

The importer is robust against this repository's real files. I prototyped a restricted frontmatter reader and a ROADMAP reader against every `*-PLAN.md` (82 files, 76 with frontmatter, 6 archived ones with none) and both ROADMAPs (`HEAD` and `main`): zero parse failures, largest item body about 3.2 KB (16 KB limit), a full import of the current milestone is **98 events in a single commit** (about 0.4 s of git plumbing). One real hazard was found and verified: a must-have string in `61-02-PLAN.md` contains "a bearer token", which `assertNoSecrets` flags, so a naive import of this repository's own `.planning` would throw and write nothing; the importer must sanitize per field. A second structural fact the planner must respect: **`main` does not yet contain the Phase 60-67 roadmap** (it lives on the milestone branches), so success criterion 1 is proven by reading a ref that has it (`HEAD` or the milestone branch), and the reader must take the ref as a parameter.

**Primary recommendation:** Build bottom-up in this order: item event types/validators/state machine with a two-clone tracer over real git, then the pure importer on committed fixtures plus this repo's `HEAD`, then the pure board model (`planMove` shared by UI and write path), then the `TeamSession` hooks, then the webview host and `media/board/` client; keep every GSD-derived and teammate-authored string as plain data rendered with `textContent` only.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Item event bodies, validators, state machine, ready rule | Domain (`src/domain/team/`, pure) | - | Must be identical on every client and run on read; no I/O, no `vscode` |
| GSD parsing into a WorkItem graph (`gsdImport.ts`) | Domain (pure; takes file texts) | - | Spec 5.1 puts it in `domain/team/`; testable on fixtures |
| Reading `.planning` from the integration branch | Node I/O (`src/team/`) | - | git plumbing through `runGit`; never touches working tree |
| Import orchestration (diff graph vs state, build intents, append) | Node I/O (`src/team/`) | `TeamLog.append` | Idempotency and CAS live in the log builder |
| Board view model, filters, lanes, `planMove` | Domain (pure) | - | One function decides "which targets are offered" and "is this move legal" |
| Session hooks (change event, board-visible polling, auto-import, status text) | VS Code adapter (`src/services/team/`) | `src/team/syncScheduler.ts` | Needs focus/visibility and the `vscode` status bar |
| Webview provider, panel, CSP, message validation | VS Code adapter (`src/services/team/boardView.ts`) | - | Spec 5.1; not in `chat.ts` |
| Rendering, drag and drop, keyboard menu, live region | Webview client (`media/board/`) | - | Plain JS, `textContent` only; no authority |
| Permission authority | Domain (`decideTeamAction`) | Host re-check on write | The webview is never trusted |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node built-ins (`node:crypto`, `node:child_process` via `runGit`, `node:fs/promises`, `node:test`) | Node v24.22.2 here; extension targets VS Code `>=1.101.0` | Everything: canonical JSON, git, tests | Project rule: no new runtime dependencies [VERIFIED: package.json has no `dependencies`; `engines.vscode` is `>=1.101.0`] |
| TypeScript | `^5.7.2` (strict, ES2022, commonjs) | Source | Existing toolchain [VERIFIED: package.json, tsconfig.json] |
| `@types/vscode` | 1.101.0 | Webview and view APIs | Existing [VERIFIED: package.json] |
| `@vscode/test-electron` | 2.5.2 (VS Code 1.144.0 is cached in `.vscode-test`) | E2E | Existing [VERIFIED: package.json; `ls .vscode-test`] |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Existing `canonical.ts`, `secrets.ts`, `identity.ts` (`ulid`, `newEventId`), `runGit.ts`, `eventLog.ts` | in repo | Canonical bytes, secret guard, ids, git, append | Reuse; do not re-implement |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hand-written restricted frontmatter reader | A YAML library | Forbidden by "no new runtime dependencies"; also a full YAML parser is a larger attack surface for hostile branch content than a reader that extracts only known keys |
| HTML5 drag and drop | Pointer events or a vendored DnD helper | Spec section 12 allows a vendored helper listed in the SBOM; HTML5 DnD needs none, works in webviews, and the keyboard Move menu is the WCAG-conformant alternative anyway |
| jsdom for client tests | The repo's hand-rolled fake DOM + `node:vm` pattern (`toolsPage.test.ts`) | jsdom is a new package (needs the legitimacy gate); the existing pattern is enough if `board.js` keeps logic in small pure functions |

**Installation:** none. **Package Legitimacy Audit:** this phase installs no external packages.

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| (none) | - | - | - | - | - | No external packages are installed in this phase |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```text
 integration branch (remote)                                   coordination branch (remote)
   .planning/ROADMAP.md, STATE.md                               near-ai/coordination: events/*.json
   phases/**/NN-MM-PLAN.md, *-SUMMARY.md                                   ^                |
        |                                                                  | append (CAS)   | fetch (incremental)
        | git fetch -> private ref refs/near-ai/integration/<branch>       |                v
        v                                                       +----------+----------------+--------------+
 IntegrationSource (src/team)                                   |  TeamLog.append / GitTransport.fetch    |
  ls-tree, cat-file --batch (size-checked)                      |  validate -> materialize (items Map)    |
        | file texts                                            +----------+----------------+-------------+
        v                                                                  | state()        | onUpdate(entries)
 gsdImport (domain, pure) --> WorkItem graph                               v                v
        |                                              TeamSession (services/team) --> onStateChange(listener)
        v                                                  |  syncOnce: trusted? lead/owner?          |
 importPlans (src/team): diff(graph, state.items)          |   -> auto-import gate (ls-remote head)   |
   -> intents: imported / updated / cancelled              |   -> status bar "Team: N ready · M pending"
   -> log.append(state => intents)  [builder re-runs on CAS loss]                                     |
                                                           v                                          v
                                           BoardController (services/team/boardView.ts)         setBoardVisible()
                                             buildBoardModel(state, viewer, filters)  (domain, pure)  -> faster poll
                                             planMove(state, viewer, itemId, target)  (domain, pure)
                                                  | postMessage {type:'state'} (throttled, only if changed/visible)
                                                  v
                          media/board/board.js  (sidebar list <520 px, kanban >= 520 px)
                            click / drag / Move menu --> {type:'move',...} --> parseBoardMessage --> controller --> log.append
                            refusal --> {type:'refused'} --> snap back + aria-live announcement
```

### Recommended Project Structure
```
src/domain/team/
  types.ts          # + item event body types, WorkItem additions, TeamEventBodyMap entries, new rejection reasons
  work.ts           # NEW pure: item id helpers, readiness(), effectiveColumn(), transition preconditions, phaseProgress()
  validate.ts       # + 8 item body validators (exact keys), exported shared field validators
  materialize.ts    # + item reference checks, applyTransition cases, parseWorkItem for snapshots
  permissions.ts    # + item.move action (managers), actionForEvent(event, state?)
  gsdImport.ts      # NEW pure: parseFrontmatter (targeted), parseRoadmap, parsePlanTasks, buildGraph, diffGraph
  board.ts          # NEW pure: buildBoardModel(), planMove(), availableMoves(), filters, lanes, countReady()
src/team/
  integrationSource.ts  # NEW git reads: fetch private ref, tree hash, ls-tree, size-checked cat-file --batch
  importPlans.ts        # NEW orchestration: read -> graph -> diff -> append; stale-source guard; secret sanitising
src/services/team/
  boardView.ts      # NEW provider (sidebar view), panel, CSP html, parseBoardMessage, BoardController, boardTap
  teamSession.ts    # + onStateChange(), setBoardVisible(), auto-import gate, ready count in status extras
  teamStatusBar.ts  # + ready/pending text, click target
  teamCommands.ts   # + nearAi.team.openBoard, nearAi.team.importPlans (solo: SOLO_TEXT), setContext key
media/board/
  board.js board.css  # one codebase, two layouts
```

### Pattern 1: Targeted frontmatter reader (extract only known keys, skip the rest by indentation)
**What:** Parse `---` ... `---`, then read only `phase`, `plan`, `wave`, `depends_on`, `files_modified`, `requirements`, `autonomous`, `gap_closure`, `estimate.{tokens,confidence,tasks}`, `must_haves.truths`. Every other top-level key (`user_setup`, `coupling_justified`, `gap_ids`, `must_haves.artifacts/key_links/prohibitions/assumptions`) is skipped by indent, never interpreted.
**When to use:** always for `*-PLAN.md`; the file is attacker-influenced input (anyone who can push to the integration branch controls it).
**Verified shapes in this repo** (survey of all 76 frontmatters): `phase:` is a slug starting with the number (`61-invitations-...`), not a bare number; `plan:` is an unpadded integer (`plan: 12`); `wave:` integer; `depends_on:` is one of `[]`, inline `[61-09, 61-10]`, quoted inline `["61-09"]`, or a block list (`depends_on:` then `  - 06-04`); `requirements:` inline or block list; `files_modified:` always a block list, no glob characters in any entry (0 of all entries match `[*?[{]`); `estimate:` always the four keys `tokens, raw_tokens, tasks, confidence`; `must_haves:` always has `truths`, `artifacts`, `key_links` (27 also have `prohibitions`, 1 has `assumptions`); `autonomous:` `true` (71) or `false` (5); `gap_closure: true` on 15 plans. Double-quoted scalars parsed with `JSON.parse` succeeded for all of them. No block scalars (`|`, `>`), no tabs, no anchors in any frontmatter. [VERIFIED: survey scripts run this session over `find .planning -name "*-PLAN.md"`]
**Example (essential logic, tested this session against all 76 files):**
```ts
// Source: prototype in the research scratchpad, 0 failures over 76 frontmatters. Domain code: no I/O.
function scalar(raw: string): string | number | boolean | null {
  const s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) { try { return JSON.parse(s) as string; } catch { return s.slice(1, -1); } }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (s === 'true') return true; if (s === 'false') return false; if (s === 'null' || s === '~' || s === '') return null;
  return /^-?\d+$/.test(s) ? Number(s) : s;
}
// Inline list: split on commas outside quotes. Block list: following lines that start with "- " at deeper indent.
// Nested map (estimate:, must_haves:): read child keys at the next indent; ignore children you do not know.
// Build with Object.create(null) or Maps and never spread parsed input (Phase 60 T-60-19 pattern, validate.ts header).
```
Limits to enforce: file size cap checked with `cat-file --batch-check` before reading (the transport does the same, `blobSizes`), max lines, max list lengths, linear-time line scanning only (no nested quantifiers).

### Pattern 2: Identity comes from the file name, not the frontmatter
**What:** Derive `(phase, plan)` from `^(\d+(?:\.\d+)?)-(\d+)-PLAN\.md$` on the file name. Cross-check against frontmatter and record a warning on disagreement. Normalise phase by stripping leading zeros (`01` -> `1`, `05.1` -> `5.1`) and pad plan to two digits, so `plan:61-12`, `plan:5.1-02`.
**Why:** the frontmatter `phase:` is a slug and archived plans have no frontmatter at all (6 of 82: `01-01`, `01-02`, `02-01`, `02-02`, `03-01`, `03-02` under `.planning/milestones/v0.4.0-phases/`). Archived layouts vary: `milestones/v0.4.0-phases/NN-slug/`, and `milestones/v0.5.0-paused/phases-13-sovereignty-gate-.../13-06-PLAN.md`. Locating plans by file-name pattern anywhere under `.planning/` works for all of them. [VERIFIED: `find` and `ls` this session]

### Pattern 3: Roadmap-down graph, orphan plans skipped
**What:** The milestone section comes from `^## ` headings; `^#{3,4}\s+Phase\s+(\d+(?:\.\d+)?):\s*(.+)$` belongs to the latest `##` section; `**Depends on**:` -> `Phase\s+(\d+(?:\.\d+)?)` matches; `**Requirements**:` -> comma list (also the range form `CYBER-01 … CYBER-12` on `main`); plan checklist lines `^- \[([ xX])\]\s+(\d+(?:\.\d+)?-\d+)-PLAN\.md\s*[—–-]+\s*(.+)$` give plan titles (strip a trailing `(REQ-01, REQ-02)` group); `**Plans**` may be written `**Plans**:` or `**Plans:**`. Only plans whose phase is in the imported milestone's section are imported. Phase 25's eight PLAN files exist under `.planning/phases/25-.../` on this branch but Phase 25 is not in this branch's ROADMAP (it is in `main`'s, under `## 0.4.x line`), so they are orphans: skip and warn, never attach them to v0.6.0. [VERIFIED: ran heading/checklist regexes against `git show HEAD:.planning/ROADMAP.md` and `git show main:.planning/ROADMAP.md`: HEAD gives phases 60-67 under section `v0.6.0 Team Mode` with 12, 14, 0... plans; main gives phase 25 under `0.4.x line` with 0 plans]
**Current milestone:** STATE.md frontmatter `milestone:` (HEAD: `milestone: v0.6.0`, main: `milestone: 0.4.x`) matched against the section's leading version token; fallback the top "Milestones" bullet marked `🚧` or containing `current`. [VERIFIED: `.planning/STATE.md` lines 1-4 on HEAD; `git show main:.planning/STATE.md` head]

### Pattern 4: Plans are located by tree listing, SUMMARY by existence only
`git ls-tree -r -z --full-tree <ref> -- .planning` gives every path and blob sha. Read blobs only for `ROADMAP.md`, `STATE.md` and the `*-PLAN.md` files; `*-SUMMARY.md` needs only to appear in the listing (`<NN>-<MM>-SUMMARY.md` next to `<NN>-<MM>-PLAN.md`). Measured on this repo (226 files under `.planning`): `rev-parse HEAD:.planning` 2 ms, `ls-tree -r` 3 ms, `cat-file --batch` of every PLAN/SUMMARY/ROADMAP/STATE blob (2.2 MB) 22 ms. [VERIFIED: `time` runs this session]

### Pattern 5: Reading the integration branch (D-01)
**Recommended:** fetch into a **private ref in the project's own repository** and read from it:
```bash
git -C <projectRoot> fetch --no-tags --quiet <remote> +refs/heads/<branch>:refs/near-ai/integration/<branch>
git -C <projectRoot> rev-parse refs/near-ai/integration/<branch>:.planning          # tree hash, change detector
git -C <projectRoot> ls-tree -r -z --full-tree refs/near-ai/integration/<branch> -- .planning
git -C <projectRoot> cat-file --batch-check='%(objectname) %(objecttype) %(objectsize)'   # sizes first, then --batch for wanted blobs
git -C <projectRoot> ls-remote <remote> refs/heads/<branch>                           # cheap per-poll "did it move" gate
```
Verified in a scratch repo: after the fetch the user's branches and `git status` were untouched, the private ref's `.planning` tree hash differed from a local `main` that held an unpushed draft commit, and the unpushed file did not appear in the private ref's listing. So unmerged local drafts cannot reach the board. [VERIFIED: scratch repo run this session]
**Why not the coordination mirror:** the mirror (`coordination.git`) is a dedicated bare repo that fetches only the coordination ref, and its remote URL is deliberately never stored (it travels in the environment, `networkTarget`, gitTransport.ts lines ~391-395). Fetching a whole project branch into it would download the full code history into extension storage. The project repo already holds the objects and the user's credential helper and `core.sshCommand` already apply. If the planner prefers the mirror, reuse `networkTarget`/`withMirrorLock` rather than copying them. [CITED: src/team/gitTransport.ts]
**Never read the local branch:** reading the member's local `main` would put unpushed commits on the shared board. The ref given to the parser is a parameter; tests pass a fixture ref or `HEAD`.
**Change detection (D-03):** persist `{ treeHash, sourceCommit }` per team in the team storage dir (like `notified.json`, `writeFileAtomic`); equal `.planning` tree hash means skip parsing entirely. `.planning` also contains `.near-ai/` (audit.json, team.json) and STATE.md, which change often, so a changed hash only triggers a parse and a diff; the diff is what makes it a no-op.

### Pattern 6: Diff-based idempotent import
**What:** Build the graph once per source commit. Inside `log.append(state => ...)` (re-run after every CAS loss) project each graph item and each existing `origin: 'import'` item to its **imported-field projection** and compare canonical JSON:
- id absent in state -> `item.imported` (full item; `state` is `done` when a SUMMARY exists, else `backlog`; D-06)
- id present, projection differs -> `item.updated` with only the changed keys (never `state`, except nothing: D-06 says re-import never moves a card; a gained SUMMARY sets the `summary` flag)
- id present in state for this milestone, `origin: 'import'`, not in graph, state not `done`/`cancelled` -> `item.cancelled` with reason `no longer in the roadmap` (D-05); tasks of a vanished plan are cancelled the same way
- nothing to do -> return `{ conflict: IMPORT_NOOP }` (the caller maps it to "Team Board is up to date"). `GitTransport.appendExisting` also refuses an empty event list (`'There were no events to write.'`), so never return `[]` and expect success.
Order events deterministically: milestone, phases by numeric order, plans by (phase, plan), tasks by (plan, index). A parent must precede its children inside one batch because the read side checks the parent exists.
**Do not cancel items outside the imported milestone** (a new current milestone must not cancel the previous milestone's done items).
**Stale-leader guard (flapping):** two leads whose clients last fetched different integration heads would otherwise alternate updates (the staler one "reverts" the newer one). Record the imported source commit on the milestone item (`source`, 40-hex) in the same batch as any content change, and before importing check `git merge-base --is-ancestor <newHead> <state source>`: if the head you read is an ancestor of the recorded source, skip. Content-neutral head moves write nothing (idempotency), and a stale client at an in-between head finds its diff empty anyway. [ASSUMED: design recommendation, see A7]

### Pattern 7: One pure function decides both UI and write path
`planMove(state, viewerId, itemId, target) -> { ok: true; intent: EventIntent } | { ok: false; reason: string }` and `availableMoves(state, viewerId, itemId)` built from it. The webview receives, per card, the list of offered targets (D-16 "only permitted targets are offered"); the host calls `planMove` again inside `log.append(state => ...)` so a stale UI gets a fresh refusal ("Dana already blocked this") instead of a silent overwrite, and the materializer re-checks on read.

### Anti-Patterns to Avoid
- **Letting a board edit an imported item's GSD-owned fields.** Re-import compares against the log, so a lead's board edit of an imported title or scope would be reverted by the next import and then flap. Imported items are read-only except for moves (hold, block, cancel, done); only `origin: 'board'` items are editable (consistent with D-06 and spec D7).
- **Aborting the whole import on one secret-like string.** See Pitfall 1.
- **Putting state or history derived from the UI into `TeamState`.** History is a view over accepted events; keep it out of the hashed state (see Pattern 8).
- **Posting a full model on every poll.** Compare the serialised model with the last posted one (the activity view does exactly this, `lastJson`) and post only on change and only while visible.
- **Using `innerHTML` for any card text.** Titles, must-haves, reasons and names come from the log (teammates) or from files on the integration branch; render with `textContent` only (the activity page header comment states the same rule, media/activity/activity.js lines 1-3).

### Pattern 8: History for the card detail (D-18) is not consensus state
`SyncResult.accepted` is delivered by `log.sync()`, but events applied by the transport after the client's own append (`fetchLocked` inside `appendExisting`, then `this.notify(entries)`) reach listeners only through `transport.onUpdate`. Subscribe at the transport (`TeamSession` owns it) and let `BoardController` keep a bounded per-item history (for example last 50 item-event summaries: type, author name, `at` display-only, one-line text) in memory. The first sync of a session replays the whole log (`this.lastProcessed === undefined ? LOCAL_REF : ...` in `fetchLocked`), so a freshly opened window rebuilds history without extra reads. History therefore never enters `TeamState`, the snapshot or the state hash. [VERIFIED: gitTransport.ts fetchLocked and appendExisting] [ASSUMED: choice not to persist history in state, see A9]

### Suggested plan slicing (for the planner, discretionary)
1. Tracer: `item.created` + `item.blocked` signed by A, materialised by B over a real bare remote (types, validators, transitions skeleton, `parseWorkItem` so snapshots with items load).
2. Full item events, state machine, `readiness`, permissions (`item.move`, `actionForEvent(event, state)`), frozen-shape tests, determinism property test with item events.
3. `gsdImport.ts` parsers and graph on committed fixtures (including the 6 no-frontmatter archived shapes) plus a live test on `HEAD`.
4. `integrationSource.ts` + `importPlans.ts` (diff, cancel, sanitising, stale guard, no-op), two-lead race test.
5. `board.ts` pure model: columns, lanes, filters, progress, `planMove`.
6. `TeamSession`: `onStateChange`, `setBoardVisible`, auto-import gate, ready count, status bar text and click target; commands registered solo-safe.
7. `boardView.ts` host (provider, panel, CSP, message parser, controller, tap) and manifest entries.
8. `media/board/` client (both layouts, DnD, Move menu, live region, reduced motion) with vm tests.
9. Board-created items (New item form, edits) end to end.
10. Live two-client proof, e2e scenario, `verify-release-content.mjs` list, phase gate.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Canonical JSON, size, event path | A second serializer | `canonicalize`, `MAX_EVENT_BYTES`, `eventPath` (canonical.ts) | Bytes are signed forever; lone surrogates and floats throw |
| Secret refusal | A new detector | `assertNoSecrets` / `findSecrets` (secrets.ts), applied per field before building intents | Same detector the write side will apply anyway |
| Signing, ids | New id scheme | `signEvent`, `newEventId`, `ulid()` (identity.ts) for `item:<ulid>` | Board-created ids follow spec 7 `item:<ulid>` |
| Append with CAS | Direct git writes | `TeamLog.append(intents)` | Builder re-runs on lost races; replays the batch through the materializer |
| Permission decisions | Role `if`s in the UI | `decideTeamAction` + `planMove` | Single decision point (spec 6.3) |
| Poll scheduling | New timers | `SyncScheduler` (`nudge`, `focusChanged`) | Handles backoff, overlap, focus |
| Git invocation | `exec`/shell | `runGit` (array args, timeout, `GIT_TERMINAL_PROMPT=0`) | No shell, bounded |
| Atomic local files | `writeFile` | `writeFileAtomic`, `runSerialised` (teamFile.ts) | Import-state file |
| Hostile-text display | Ad hoc escaping | `displayText`/`safeReason` (teamStatusBar.ts) for status bar and notifications; `textContent` in the webview | Escapes `$(icon)` syntax, bounds length |
| Frontmatter YAML | A general YAML engine | The targeted reader above | No dependency, bounded, safe |
| Drag and drop library | A vendored helper | Native HTML5 DnD + keyboard menu | Fewer moving parts, keyboard path is the conformance route |

**Key insight:** every hard part (ordering, signing, CAS, permissions, size, secrets) already exists and is verified; this phase's risk is in the seams (snapshot parser, permission mapping, per-field sanitising, solo-parity loading), not in new algorithms.

## Verified facts about the code (with verbatim quotes)

### Event types and ids
`TEAM_EVENT_TYPES` already lists the eight work events: `'item.imported', 'item.created', 'item.updated', 'item.estimated', 'item.blocked', 'item.unblocked', 'item.cancelled', 'item.reopened'` [VERIFIED: src/domain/team/types.ts:14]. They are not in `IMPLEMENTED_EVENT_TYPES` (types.ts:41: `export const IMPLEMENTED_EVENT_TYPES: readonly ImplementedEventType[] = ['team.created', 'member.invited', 'member.joined', 'member.role-changed', 'member.removed', 'device.added', 'device.revoked', 'member.availability', 'member.skills', 'member.key-sealed', 'policy.changed', 'snapshot.written'];`), so today they are rejected as `unsupported event type for this version` (validate.ts:68). Adding the bodies to `ImplementedEventBodies` and the list makes `BODY_VALIDATORS: Record<ImplementedEventType, BodyValidator>` (validate.ts:235), `actionForEvent`'s switch (permissions.ts:177) and `applyTransition`'s switch (materialize.ts:284) compile errors until each handles the new types, which is the guard rail to keep.

### Current WorkItem and state types (to be extended)
- `export type ItemKind = 'milestone' | 'phase' | 'plan' | 'task' | 'chore' | 'bug' | 'spike' | 'review';` and `export type ItemState = 'backlog' | 'ready' | 'claimed' | 'in-progress' | 'in-review' | 'integrating' | 'done' | 'cancelled';` [VERIFIED: types.ts:8-9]
- `export interface WorkItem { id: string; kind: ItemKind; title: string; parentId?: string; gsd?: { phase: string; plan?: string; wave?: number; file?: string }; dependsOn: string[]; scope: string[]; requirements: string[]; mustHaves: string[]; estimate?: { tokens: number; nanoUsd?: number; confidence?: 'low' | 'medium' | 'high' }; state: ItemState; blocked?: { reason: string; by: string; since: string }; claimId?: string; tags: string[]; ringFenceNanoUsd?: number }` [VERIFIED: types.ts:70]
- `TeamState.items: Map<string, WorkItem>` and the state serialises `items: toPlain(state.items)` (a key-sorted pair array) [VERIFIED: materialize.ts:436]. With no items it serialises `[]`, so **logs without item events keep byte-identical state and hash** (`STATE_HASH_VERSION = 1`, materialize.ts:453; no bump is required for Phase 60/61 logs). Once items exist, the stored WorkItem key set is part of the hash: treat the shape as frozen after release, like the signed event bodies, and pin it with a test.
- `releaseHeldWork` (Phase 61) already sets `item.state = 'ready'` and deletes `claimId` for released claims (materialize.ts:272-275). Phase 62 never has claims, but treat stored `ready` and stored `backlog` as the same "unclaimed" set when deriving the column, otherwise a stored `ready` would bypass the computed rule.

### Snapshot parser refuses items today (must change)
`deserialiseState` contains `emptyList(root.items, 'items');` and the comment "Later phases fill these; a Phase 60 snapshot must carry them empty and at their defaults." (materialize.ts:665-666). A snapshot written after the first import therefore **fails to load** (`invalid snapshot: items`). Loading is "provisional ... the client still replays from genesis" (materialize.ts:692-693), so it is not a correctness failure, but new members would lose the snapshot shortcut and the round-trip property (`serialiseState(restored) === text`, line 684) is the documented guarantee. Add `parseWorkItem` for the pair array. Note `shortText` caps strings at `MAX_TEXT = 200` (materialize.ts:483), but must-have strings can reach 520 characters in this repo, so the item parser needs its own limits matching the validators. [VERIFIED: sources read]

### Limits that shape the bodies
- `export const MAX_EVENT_BYTES = 16 * 1024;` [VERIFIED: canonical.ts:7]; `MAX_DEPTH = 16` (canonical.ts:6); numbers must be safe integers (canonical.ts:31), so no fractional values anywhere (confidence is a string; progress is computed as integer percent).
- `prepareEvents` measures the signed size with a full-length signature placeholder and returns `{ conflict: R.tooLarge }` (eventLog.ts:100-106), i.e. one oversize item would fail the whole batch. The importer must fit each item (truncate code-point-safe, cap list lengths) before building the intent.
- `MAX_LAMPORT_JUMP = 1000` (materialize.ts:13) is checked against the previous accepted event, so a 98-event or 300-event batch is fine.
- Existing validators to reuse (export as needed): `invalid`, `child`, `checkKeys`, `isRecord`, `isSafeIntegerInRange`, `matches`, `validateName` (80-char names), `CONTROL_CHARACTERS` (validate.ts:84), `isRelativePosixPath` (policy.ts, currently not exported).

### Permissions today
Rows (permissions.ts:44-48): `'item.create': row(true, true, 'own-draft', false, false)`, `'item.edit': row(true, true, 'own-draft', false, false)`, `'item.estimate': row(true, true, 'own-draft', false, false)`, `'item.claim': row(true, true, true, 'review-items', false)`, `'item.assign': MANAGERS` where `const MANAGERS = row(true, true, false, false, false);`. `'own-draft'` is evaluated as `'ownDraft' in action && action.ownDraft` (permissions.ts:130). `actionForEvent(event)` takes **no state** (permissions.ts:177), so it cannot compute "is this my own draft"; it must gain an optional `state` argument (existing roster callers keep working). `eventLog.prepareEvents` evaluates the permission against the pre-batch state (eventLog.ts:96-98), so a developer must not rely on a same-batch `item.created` followed by `item.estimated`: the New item form writes **one** `item.created` that already carries the estimate.

### Transport and polling
- Incremental application: `readRange(this.lastProcessed === undefined ? LOCAL_REF : \`${this.lastProcessed}..${LOCAL_REF}\`)` then `for (const entry of entries) entry.verdict = this.materializer.apply(this.current, entry);` and `this.notify(entries)` (gitTransport.ts fetchLocked). **No re-materialisation per poll.**
- A batch commit writes one event per file with two git spawns each (`hash-object -w`, `update-index --add --cacheinfo`, gitTransport.ts ~777-778). Measured 100 events at 0.39 s. [VERIFIED: timing run]
- `checkCandidate` clones the whole state (`structuredClone`) per append check (materialize.ts:30-32): fine for hundreds of items.
- Poll: `DEFAULT_POLL_SECONDS = 15`, `UNFOCUSED_POLL_MS = 120_000`, `MIN_POLL_SECONDS = 5` (syncScheduler.ts:11-15). The scheduler chooses the delay from `focused()`; Phase 60 D-19 explicitly defers the "board-visible" trigger to this phase. [VERIFIED: syncScheduler.ts; 60-CONTEXT.md D-19]

### Status bar and tests that pin it
Current text: `` `Team: ${displayName(teamName)}${suffix}` `` with suffix `` ` (${pending} pending)` `` (teamStatusBar.ts), click command `VERIFY_LOG_COMMAND`. Tests that pin this and must be updated deliberately: `teamSession.test.ts:226` (`assert.equal(lastItem().command, 'nearAi.team.verifyLog');`), `teamSessionMembers.test.ts:236, 253, 282, 288-290` (`'Team: Alpha (1 pending)'`, `'Team: Alpha (2 pending)'`, `'Team: Alpha'`), `teamManifest.test.ts:~38` (status bar command constant equals the registered command).

### Tests that treat `item.created` as "not implemented yet"
`teamValidate.test.ts:101` (`type: 'item.created'` -> unsupported), `teamValidate.test.ts:232` (`validateBody('item.created', {})` -> unsupported), `teamSession.test.ts:319` (`type: 'item.created'` for the "update the extension" report). Switch these to a still-unimplemented type such as `claim.taken`. `teamPermissions.test.ts:~101` asserts `kinds.length, 28` and a table row per kind (adding `item.move` makes 29 plus a row and a label).

### Extension wiring facts
- The NEAR AI container is `nearAiSecondaryViewContainer` and holds one view today: `{"type":"webview","id":"nearAiChatView","name":"Chat","visibility":"visible"}` [VERIFIED: package.json contributes.views]. The chat view is registered with `retainContextWhenHidden: true` (extension.ts); the board should use `getState/setState` instead (VS Code docs: retainContextWhenHidden "has high memory overhead").
- `registerTeamMode` registers commands at activation and imports team modules only by dynamic `import()`; `teamSoloParity.test.ts` proves solo activation loads no module under `team/`, `domain/team/`, `services/team/` except `teamCommands.js` and `memberCommands.js`, makes one `stat`, and creates no timers. A statically imported board provider module under `services/team/` would break that test unless it is lazily loaded or the allowlist is extended on purpose. [VERIFIED: teamSoloParity.test.ts header and `loadedTeamModules`]
- The e2e suite asserts every contributed command has a registered handler (`contributed.filter((command) => !registered.has(command))` equals `[]`), so `nearAi.team.openBoard` and `nearAi.team.importPlans` must register at activation in solo projects too. [VERIFIED: src/test/e2e/suite.ts]
- `scripts/verify-release-content.mjs` has a hard-coded `required` list of media files (lines ~65-99); add `extension/media/board/board.js` and `board.css`.

## GSD file formats (verified inventory)

| Fact | Evidence |
|------|----------|
| 82 `*-PLAN.md` files under `.planning` (v0.4.0 archive 33, v0.5.0-paused 15, phases/25: 8, phases/60: 12, phases/61: 14) | `find .planning -name "*-PLAN.md" \| sed ... \| uniq -c` |
| 76 have YAML frontmatter, 6 do not (all in `milestones/v0.4.0-phases/01..03`, markdown "Tasks" bullet lists and a "Requirements covered" section instead) | survey |
| Top-level keys: `phase, plan, wave, type, requirements, must_haves, files_modified, estimate, depends_on, autonomous` on all 76; `gap_closure` 15; `user_setup` 2; `gap_ids` 1; `coupling_justified` 1 | survey |
| `type: execute` on all 76 | survey |
| Body tags: `<objective>`, `<execution_context>`, `<context>`, `<tasks>`, `<task type="...">` (81 plain, 107 with `tdd="true"`, 2 checkpoint tasks with `gate=` and `auto_select=`), `<verification>`, `<success_criteria>`, `<output>`, `<threat_model>` | `grep -ho "<task[^>]*>"` |
| Task block shape: `<task type="tracer" tdd="true">` then `<name>Task N: title</name>`, `<files>a, b, c</files>`, `<read_first>`, `<behavior>`, `<action>`, `<verify>`, `<acceptance_criteria>`, `<done>` | read `61-12-PLAN.md` |
| Largest observed: 11 truths, truth length max 520 chars, 19 `files_modified`, path length max 93, task name max 215 chars, up to 10 files per task | stats run |
| Largest projected item body (title, files, truths, requirements, dependsOn) 3,149 bytes (`25-05-PLAN.md`), against a 16,384 byte event | stats run |
| 60/61: 26 plans, 63 tasks, 26 SUMMARY files (every plan has one) | `ls`, regex count |
| So a first import of the v0.6.0 milestone at `HEAD`: 1 + 8 + 26 + 63 = **98 `item.imported` events**, all 26 plans `done`, phases 62-67 with no plans | derived |
| `estimate.tokens` is present on all 76 (e.g. `96050` in 61-12, `68000` in 25-01) | survey, read |

ROADMAP forms: top "Milestones" bullet list (`- 🚧 **v0.6.0 Team Mode**: Phases 60-67 (current milestone; ...)`), `## v0.6.0 Team Mode` section, `### Phase NN: Title`, bold field lines (`**Goal**:`, `**Depends on**:`, `**Requirements**:`, `**Scope**:`, `**Plans**:`/`**Plans:**`, `**UI hint**: yes`), wave labels `**Wave N**` / `**Wave 7** *(gap closure for UAT G-60-1)*`, checklist lines `- [x] 60-01-PLAN.md — Tracer: ... (TEAM-04)`, and a trailing progress table (ignore it). Older forms may use `- [ ] 01-01: name` without the `-PLAN.md` suffix; accept both.

## Event bodies and validators (recommended exact shapes)

All bodies follow the Phase 60 rule "exact keys, unknown keys rejected" (`checkKeys(body, 'body', required, optional)`), validated with `Object.keys` and own-property checks and never copied with spread (validate.ts header). Reasons are the fixed prefix `invalid event body: <path>` (`invalid(path)`, validate.ts:29). New fixed rejection reasons to add to `TEAM_REJECTION_REASONS` (suggested texts): `itemExists: 'item already exists'`, `itemMissing: 'referenced item does not exist'`, `itemParent: 'parent item does not exist'`, `itemState: 'item cannot make that move from its current state'`, `itemBlocked: 'item is already blocked'`, `itemNotBlocked: 'item is not blocked'`, `itemTerminal: 'item is already done or cancelled'`.

```ts
// Shared field shapes (recommended). All strings: no control characters (CONTROL_CHARACTERS), trimmed length bounds.
const GSD_ITEM_ID  = /^(?:milestone|phase|plan|task):[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;   // D-04: milestone:v0.6.0, phase:62, plan:62-03, task:62-03-2
const BOARD_ITEM_ID = /^item:[0-9A-HJKMNP-TV-Z]{26}$/;                                      // spec 7: item:<ulid>
const REQUIREMENT_ID = /^[A-Z][A-Z0-9]{0,15}-\d{1,3}$/;                                      // TEAM-02, BOARD-01, SEC-04 (observed forms)
// Caps (joint size is finally bounded by MAX_EVENT_BYTES, so the importer truncates before building):
// title 1..200, description <= 2000, scope <= 64 entries each isRelativePosixPath <= 200, requirements <= 32,
// mustHaves <= 16 entries each <= 600 chars (observed max 520 chars / 11 entries), dependsOn <= 32 GSD ids,
// estimate { tokens: safe int 1..10^12, confidence?: 'low'|'medium'|'high' }, reason 1..200, gsd { phase: /^\d+(\.\d+)*$/, plan?: /^\d{2,3}$/, wave?: int 1..99, file?: relative posix path <= 200 }.
```

| Event | Exact keys (`required` / *optional*) | Notes |
|-------|--------------------------------------|-------|
| `item.imported` | `id, kind, title, state, dependsOn, scope, requirements, mustHaves, tags` / *parentId, gsd, estimate, summary, active, source* | `kind` in milestone/phase/plan/task; `id` prefix must equal `kind`; `state` in `backlog`/`done`; `parentId` must exist (ordering) and have the parent kind; `summary: true` when SUMMARY exists; `active: true` only on a milestone; `source` only on a milestone (40-hex commit). Import-origin only. |
| `item.created` | `id, kind, title, scope, requirements, mustHaves` / *description, estimate, tags* | `kind` in bug/chore/spike; `id` matches `BOARD_ITEM_ID`; creates `origin: 'board'`, `createdBy: author`, `state: 'backlog'`. Carries the estimate so a developer's single-event creation is complete. |
| `item.updated` | `id, changes` | `changes` exact-key object with at least one of *title, description, scope, requirements, mustHaves, dependsOn, estimate, gsd, tags, summary, active, source, hold, state*. `state` only the literal `'done'` this phase; `hold` boolean; `summary`/`active` import-only; text-field edits only on `origin: 'board'` items unless the author is the importer (owner or lead) |
| `item.estimated` | `id, estimate` | action `item.estimate` (own draft rule) |
| `item.blocked` | `id, reason` | not done/cancelled, not already blocked |
| `item.unblocked` | `id` | must be blocked |
| `item.cancelled` | `id, reason` | not already `cancelled` or `done`; import uses `no longer in the roadmap` |
| `item.reopened` | `id` | from `cancelled` (and, recommended, `done`) to `backlog`; also clears `blocked` and `hold` (A3) |

State machine this phase (stored `state`; `blocked` and `hold` are flags): `backlog`/`ready` (unclaimed) -> `done` (mark done) or `cancelled`; `cancelled`/`done` -> `backlog` (reopen). Anything involving `claimed`, `in-progress`, `in-review`, `integrating` is rejected on read with `itemState` until Phase 63/65 add their events (this is also what makes D-13's refusals hold on the read side, not only in the UI). A pure `transitionProblem(item, event) -> string | undefined` is called from `referenceProblem` (D-09 step 7).

**Computed `ready` (D-11), pure:**
```ts
// src/domain/team/work.ts (recommended)
export type NotReady = 'not-unclaimed' | 'held' | 'blocked' | 'no-estimate' | 'no-scope' | 'dependency-open' | 'dependency-missing' | 'phase-held' | 'phase-dependency-open';
export function readiness(items: ReadonlyMap<string, WorkItem>, id: string): { ready: boolean; reasons: NotReady[] } {
  const item = items.get(id);
  if (item === undefined || (item.kind !== 'plan' && item.origin !== 'board')) return { ready: false, reasons: ['not-unclaimed'] };
  const reasons: NotReady[] = [];
  if (item.state !== 'backlog' && item.state !== 'ready') reasons.push('not-unclaimed');
  if (item.hold === true) reasons.push('held');
  if (item.blocked !== undefined) reasons.push('blocked');
  if (item.estimate === undefined) reasons.push('no-estimate');
  if (item.scope.length === 0) reasons.push('no-scope');
  for (const dep of item.dependsOn) {
    const target = items.get(dep);
    if (target === undefined) reasons.push('dependency-missing');
    else if (target.state !== 'done') reasons.push('dependency-open');   // cancelled counts as open: a lead must fix the dependency
  }
  const phase = item.parentId === undefined ? undefined : items.get(item.parentId);
  if (phase?.hold === true) reasons.push('phase-held');                  // "phase frozen" = the phase item is held
  return { ready: reasons.length === 0, reasons: [...new Set(reasons)].sort() };
}
```
"Phase frozen" representation (discretion): a phase is frozen when its item carries `hold: true`, set with the same `item.updated {hold}` event by a lead. Whether a plan also waits for its phase's own `**Depends on**` phases to be complete is not stated in the spec rule; recommended yes (inherit: all plans of each depended-on phase are done), flagged A4. Weighted progress for lane headers: `done` estimate tokens over non-cancelled estimate tokens, falling back to counts when the denominator is 0; integer percent `Math.floor(100 * done / total)`.

**Permission mapping (D-02, D-12, D-14):**

| Event | `decideTeamAction` action | Who passes |
|-------|---------------------------|------------|
| `item.imported` | `{ kind: 'item.create', ownDraft: false }` | owner, lead |
| `item.created` | `{ kind: 'item.create', ownDraft: true }` | owner, lead, developer |
| `item.updated` (no `hold`/`state` key) | `{ kind: 'item.edit', ownDraft }` | owner, lead; developer when `item.origin === 'board' && item.createdBy === author && state is unclaimed` |
| `item.updated` with `hold` or `state` | `{ kind: 'item.move' }` | owner, lead |
| `item.estimated` | `{ kind: 'item.estimate', ownDraft }` | as edit |
| `item.blocked` / `unblocked` / `cancelled` / `reopened` | `{ kind: 'item.move' }` | owner, lead (claimant joins in Phase 63) |

`item.move` is one new matrix row (`MANAGERS`) with a label (`'moving items'`) because the spec 6.3 table has no transition row and D-12 names exactly owner and lead. The alternative that adds no row (route lifecycle moves through `item.edit` with `ownDraft: false` and add a role check inside the transition function) works too but hides a permission outside the matrix that tests diff row by row. Flagged A2.

**Snapshot form:** extend `parseSnapshotFile`/`deserialiseState` to rebuild `items` from `[id, item]` pairs with a strict `parseWorkItem`, keep `claims`, `leases`, `allocations`, `integrationQueue` required-empty. Add the round-trip property for states containing items.

## Board model, columns and moves

`buildBoardModel(state, viewerId, options)` (pure; `nowMs` passed in for "age in state") returns plain JSON: `columns` (always all of backlog, ready, claimed, in-progress, in-review, integrating, done, plus cancelled collapsed by default), cards (plans and `origin: 'board'` items only), lanes, filter facets, milestone picker data, per-card `moves`, `canWrite`, `canImport`, `counts`. `effectiveColumn(item)`: cancelled -> `cancelled`; done -> `done`; claim/review/integration states as stored; unclaimed -> `ready` when `readiness(...).ready` else `backlog`. `blocked` is a badge with the word "Blocked" in the card's own column, never a column. Tasks appear in the plan card's checklist (D-07); a plan card also shows a "Done in GSD, confirm" marker when `summary === true` and the card is not `done` (D-06).

Lanes: member (default; before Phase 63 everything is "Unassigned" plus "created by" for board items), phase, milestone, none. Lane headers for phase/milestone show weighted progress (D-08). Filters: mine (board items I created; claims later), ready, blocked, requirement id, phase. Default milestone = the milestone item with `active: true`, with a picker for the others (D-09), so the importer writes `active` on the current milestone and clears it on a previous one.

Column drops map to one function (suggested table, `planMove`):

| Drop target | From | Result |
|-------------|------|--------|
| done | unclaimed | `item.updated {state:'done'}` (mark done), managers only |
| cancelled | unclaimed, blocked | `item.cancelled {reason}` (ask for a reason) |
| backlog | ready (or unclaimed) | `item.updated {hold:true}` (hold) |
| backlog | cancelled, done | `item.reopened` |
| ready | held backlog | `item.updated {hold:false}` (release) |
| ready | backlog, not computed ready | refused with the missing pieces (no estimate, no scope, open dependency, blocked) |
| claimed, in-progress, in-review, integrating | any | refused: plain reason that claiming and integration arrive in later updates (D-13) |
| (menu only) | any non-terminal | block (reason) / unblock |

Keyboard "Move to..." menu items = exactly the `moves` entries marked allowed; the menu is the only path in the sidebar list (D-16).

## Webview design

- **Registration:** sidebar view `{"type":"webview","id":"nearAiTeamBoardView","name":"Team Board","when":"nearAi.teamMode"}` added to `views.nearAiSecondaryViewContainer`; set the context key with `executeCommand('setContext', 'nearAi.teamMode', true)` only after a team session starts. In a solo project the key is unset, the view is hidden, and `nearAi.team.openBoard` shows `SOLO_TEXT` (`'Team Mode is not on for this project. Run "NEAR AI: Enable Team Mode" to turn it on.'`, teamCommands.ts) and starts nothing, matching how `verifyLog` already behaves. Hiding rather than showing a welcome view is what keeps "solo behaves exactly as 0.4.8" literally true. Register the provider at team session start (before setting the context key) so VS Code never asks for it in solo. [ASSUMED: view hidden in solo, A8]
- **Editor panel:** `createWebviewPanel('nearAiTeamBoard', 'Team Board', ViewColumn.Active, { enableScripts: true, localResourceRoots: [media/board] })`, one at a time (`panel.reveal()` like `mcpView.ts`), `retainContextWhenHidden` off, `webview.getState()/setState()` for filters and collapsed groups (as `chat.js` does).
- **HTML:** same pattern as `mcpView.ts`/`panelView.ts`: `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}';">`, nonce from `randomBytes(16).toString('base64')`, assets via `asWebviewUri`, no remote resources, no inline script or style. [VERIFIED: mcpView.ts, panelView.ts]
- **Protocol:** host parser in the style of `parseActivityViewMessage` (exact keys per message type, id regexes, length caps, unknown types ignored). Webview -> host: `ready`, `move {itemId, target, reason?}`, `block {itemId, reason}`, `unblock {itemId}`, `new-item {draft}`, `edit-item {itemId, changes}`, `import-plans`, `open-board`, `detail {itemId}`, `visible {value}`. Host -> webview: `state {model}`, `refused {itemId, reason}`, `notice {text}`, `detail {itemId, history}`. The webview never signs and never decides: the host calls `planMove` inside `log.append`, and the materializer re-checks.
- **Layouts:** one script, `ResizeObserver` on the root, compact list when narrower than about 520 px, kanban otherwise (D-15). Both surfaces get the same model.
- **Accessibility:** columns are labelled regions (`section` + `aria-labelledby`) with `ul`/`li` cards; each card has a text state label plus an icon (never colour alone), a `Move to...` button with `aria-haspopup="menu"` and `aria-expanded`, opening a `role="menu"` with `role="menuitem"` items (arrow keys, Home/End, Escape returns focus to the button); the sidebar groups are buttons with `aria-expanded`; one visually hidden `role="status" aria-live="polite"` element announces refusals and a one-line summary of remote changes (not every card); `@media (prefers-reduced-motion: reduce)` disables transitions and the move animation; `@media (forced-colors: active)` keeps borders (existing precedent: `media/activity/activity.css:86-87`); theme through `--vscode-*` variables already in use elsewhere (`--vscode-foreground`, `--vscode-descriptionForeground`, `--vscode-panel-border`, `--vscode-focusBorder`, `--vscode-errorForeground`, `--vscode-button-*`, `--vscode-editorWidget-background`). Drag and drop is the pointer path; WCAG 2.2 SC 2.5.7 (AA) requires that "All functionality that uses a dragging movement for operation can be achieved by a single pointer without dragging", which the Move menu satisfies. [CITED: https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html]
- **Untrusted text:** every title, must-have, reason and member name is set with `textContent`; names pass `displayText`-style flattening on the host before they reach the model.

## Live updates (BOARD-02)

What exists: the transport applies new commits incrementally and calls `onUpdate` listeners with the applied entries. What is missing:

1. **A session-level change hook.** `TeamSession.transport` is private; add `onStateChange(listener)` wrapping `transport.onUpdate` (fires also for the client's own appends, because `appendExisting` ends with `fetchLocked` which notifies). `BoardController` subscribes, throttles to at most about 4 posts per second, serialises the model and posts only if it changed and only while a surface is visible (copy the activity view's `lastJson`/`UPDATE_MS` approach, activityView.ts).
2. **A board-visible poll trigger.** The scheduler polls at 15 s only when `focused()` is true, else every 120 s. A board visible in an unfocused window (second monitor) would update every 2 minutes, which breaks "within one poll interval" in the case the owner cares about. Add `TeamSession.setBoardVisible(boolean)` and make the scheduler's focus input `windowFocused || boardVisible`, calling `scheduler.focusChanged(...)` on change. [VERIFIED: syncScheduler.ts comment lines 1-6 and `focusChanged`]
3. **Ready count for the status bar** computed in `syncOnce` extras (pure `countReady(state)`), so the bar updates on the same poll.

Refresh cost: per poll one fetch plus O(new events) apply, then `buildBoardModel` is O(items + edges) (hundreds of items) and a JSON compare. Nothing re-reduces from genesis.

Proof strategy:
- **Node, deterministic (primary BOARD-02 proof):** two real-git clones as in `teamSessionMembers.test.ts` / `teamFlowRig.ts` (`createTeamFixture`, injected `SchedulerTimers` fake clock). Client A (lead) moves a card; advance B's fake clock by exactly `pollSeconds * 1000`; assert B's `buildBoardModel` shows the move after that single scheduler run and not before. Also assert unfocused + board visible polls at the focused interval.
- **E2E (real host + webview):** `env -u ELECTRON_RUN_AS_NODE DISPLAY=:0 node dist/test/e2e/run.js`. It can prove: the board webview loads its script under the CSP, the host sends a `state` message, a `host-request` style passthrough (as the chat sidebar offers, `panelView.request`) makes the real `board.js` post a `move` that reaches the host, a second node-level client's append shows up in a later `state` message after `session.nudge()`/`sync()`, and a refused move produces `refused`. It cannot click or drag inside the webview DOM (extension-host tests have no DOM access), so DnD/keyboard behaviour is covered by vm tests of `board.js`. In xvfb the window may report unfocused, so the e2e must nudge rather than wait 120 s. The e2e scenario needs a team: add a test seam (extend `NearAiTestApi` or expose the `TeamModeHandle`) that creates the bare remote, enables Team Mode through `enableTeamMode` with the host's `context.secrets`, then runs `nearAi.team.openBoard` (which lazily starts the session as `verifyLog` does). [ASSUMED: seam choice, A15]

## Solo parity (question 6)

Register `nearAi.team.openBoard` and `nearAi.team.importPlans` in `registerTeamMode` next to `enable` and `verifyLog`; each starts with the same `teamFileExists` check `verifyLog` uses and, if there is no team, shows `SOLO_TEXT` and returns (no import of team modules, no timers, no storage). Do not call `setContext` in solo. Statically import nothing new from `services/team/` in `teamCommands.ts`; load `boardView` with `await import('./boardView')` inside the handler. Extend `teamSoloParity.test.ts` with: activation creates no board provider, no `setContext` call, and the two commands only explain; `teamManifest.test.ts` with the two commands (category NEAR AI, `$(...)` icons, no em-dash), the view entry with its `when`, and no new dependency.

## Common Pitfalls

### Pitfall 1: A real must-have string trips the secret guard and aborts the import
**What goes wrong:** `assertNoSecrets` runs on every intent body (`prepareEvents`, eventLog.ts:89) and throws `SecretLeakError`, so one flagged string writes nothing. **Verified on this repo:** `61-02-PLAN.md` has a truth beginning "No error message, thrown error or fake-server request log ever contains a bearer token, a ..."; `findSecrets({title: <that text>})` returned `[ '$.title' ]` (the `bearer\s+...` pattern is case-insensitive, secrets.ts:19). Every other truth, task name and path in all 76 plans passed.
**Why it happens:** the detector is deliberately aggressive and plan text legitimately talks about secrets.
**How to avoid:** sanitise per field before building the intent: run `findSecrets` on each string; replace a flagged string with a fixed deterministic placeholder (for example `(withheld: secret-like text)`) and list it in the import report. The placeholder is deterministic, so a re-import compares equal and stays a no-op. Never skip the whole item silently, never lower the detector.
**Warning signs:** import reports `contains a secret-like value at $.mustHaves[3]`.

### Pitfall 2: Truncation or odd characters make the canonical form throw
**What goes wrong:** `canonicalize` throws on lone surrogates (canonical.ts:34), so `title.slice(0, 200)` that splits a surrogate pair turns the whole batch into `malformed event`. Newlines or tabs in YAML scalars fail `CONTROL_CHARACTERS` validation.
**How to avoid:** truncate by code points; collapse whitespace runs to one space; strip control characters; then validate with the same validators the read side uses before building the intent.

### Pitfall 3: Snapshots with items cannot be loaded
See "Snapshot parser refuses items today". Also `shortText`'s 200-char cap would reject long must-haves. Test: serialise -> deserialise round trip and `stateHash` equality on states with items; parse a signed snapshot file that contains items.

### Pitfall 4: `main` does not contain the roadmap success criterion 1 depends on
`git show main:.planning/ROADMAP.md` lists only Phase 25; the Phase 60-67 roadmap is on `gsd/milestone-v0.6.0-team-mode` and this branch (HEAD has 226 files under `.planning`, main 150). A test hard-wired to `main` fails or, worse, silently imports the wrong milestone. Tests and the live criterion check pass an explicit ref (`HEAD`), and a committed fixture snapshot of ROADMAP + a few PLAN/SUMMARY files gives deterministic assertions; the live test asserts structural invariants only (phase ids 60-67 present, `plan:60-01` done, task count equals the count of `<task` blocks it reads) so it survives repo growth.

### Pitfall 5: Flapping between leads with different fetch freshness
See Pattern 6 (stale-leader guard).

### Pitfall 6: Batch intents and `ownDraft`
`prepareEvents` checks permissions against the pre-batch state, so a same-batch create-then-edit by a developer is refused on write though valid on read. Keep board creation single-event; managers are unaffected.

### Pitfall 7: Existing tests encode the old behaviour
Listed under "Tests that treat `item.created` as not implemented", "Status bar and tests that pin it" and the `kinds.length, 28` assertion. Update them in the wave that changes the behaviour, in the same commit, and say so in the plan.

### Pitfall 8: Poll cadence for a visible-but-unfocused board
See Live updates item 2.

### Pitfall 9: Webview message trust
A compromised or buggy page can post anything. The host must validate every message (exact keys, id patterns, text caps) and re-run `planMove` on fresh state; never act on a role or permission claimed by the page.

### Pitfall 10: Solo-parity regression by a static import
A new top-level `import './boardView'` in `teamCommands.ts` loads `services/team/boardView.js` at activation and fails `teamSoloParity.test.ts`. Use dynamic import in handlers.

### Pitfall 11: Orphan and archived plan files
Phase 25's plan files are in `.planning/phases/` but not in this branch's ROADMAP; archived plans may lack frontmatter and use different directory names. Locate by file name, attach to a phase only when the ROADMAP has that phase, otherwise report and skip.

## Code Examples

### Item body validator in the Phase 60 style
```ts
// Source: pattern of BODY_VALIDATORS in src/domain/team/validate.ts (exact keys, first failure wins, fixed reason prefix)
'item.blocked': (body) => checkKeys(body, 'body', ['id', 'reason'])
  ?? validateItemId(body.id, 'body.id')
  ?? validateReason(body.reason, 'body.reason'),
'item.created': (body) => checkKeys(body, 'body', ['id', 'kind', 'title', 'scope', 'requirements', 'mustHaves'], ['description', 'estimate', 'tags'])
  ?? validateChoice(body.kind, ['bug', 'chore', 'spike'], 'body.kind')
  ?? (matches(body.id, BOARD_ITEM_ID) ? undefined : invalid('body.id'))
  ?? validateTitle(body.title, 'body.title')
  ?? validateScope(body.scope, 'body.scope')
  /* ... */,
```

### Permission mapping with state
```ts
// Source: extends actionForEvent in src/domain/team/permissions.ts:177; state is optional so roster callers are unchanged
case 'item.imported': return { kind: 'item.create', ownDraft: false };
case 'item.created': return { kind: 'item.create', ownDraft: true };
case 'item.estimated': return { kind: 'item.estimate', ownDraft: isOwnDraft(state, event.body.id, event.author) };
case 'item.blocked': case 'item.unblocked': case 'item.cancelled': case 'item.reopened': return { kind: 'item.move' };
case 'item.updated': return 'hold' in event.body.changes || 'state' in event.body.changes
  ? { kind: 'item.move' } : { kind: 'item.edit', ownDraft: isOwnDraft(state, event.body.id, event.author) };
```

### Import intent builder (idempotent, CAS-safe)
```ts
// Source: TeamLog.append contract, src/team/eventLog.ts:250 ("intents ... called with the freshest state on every attempt")
const result = await log.append((state) => {
  const intents = diffGraphToIntents(graph, state.items, { sourceCommit });   // pure, sorted, size-fitted, secret-sanitised
  return intents.length === 0 ? { conflict: IMPORT_NOOP } : intents;
});
if (!result.ok && result.reason === IMPORT_NOOP) return { changed: 0 };
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Spec: import reads files from the working tree on GSD command completion | Read the integration branch through git; trigger on change detection | CONTEXT D-01 (2026-11-02) | Unmerged drafts never reach the board; parser takes file texts, not paths |
| Spec: `Plan` cards from `PLAN.md`, tasks from `<task>` | Same, but milestone/phase are lane headers, tasks are checklists | D-07, D-08 | Fewer cards; graph still complete for Phase 63/64 |
| Spec `blocked` as a state | Flag on any pre-done state | D-10 | `blocked` is a badge, not a column |
| Spec status line `Team: 2 ready for you · 1 in review · $12.40/$40.00` | `Team: N ready · M pending`, click opens board | D-17 | Ready-for-you and spend added in 64/66 |

**Deprecated/outdated in the spec:** phase numbers (spec 25-32 are repo 60-67), `at`-based timestamps for blocked `since` (use the event's display-only `at`, never for ordering).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Imported items carry **no `description`** (titles, scope, must-haves only); the ROADMAP `**Goal**` text is not written to the log, to honour "never plan bodies beyond must-have strings" | Event bodies | If the owner wants goals on phase lane headers, add an optional `description` (capped) to imported phase/milestone bodies; cheap now, a validator change later |
| A2 | Add one permission row `item.move` (managers) for lifecycle moves instead of reusing `item.edit` | Permission mapping | Different row count/tests; behaviour for roles is identical either way |
| A3 | `item.reopened` is allowed from `done` as well as `cancelled`, lands in `backlog`, and clears `blocked` and `hold` | Event bodies | If reopening a done card is unwanted, restrict to cancelled |
| A4 | A plan is ready only if its phase's depended-on phases are complete (all their non-cancelled plans done) in addition to its own `depends_on` | Computed ready | Phase 63 plans become ready too early if omitted; too late if plans of a dependent phase are unfinished by design |
| A5 | Status bar shows `Team: N ready · M pending` only once the log has board items (otherwise unchanged text), drops the team name from the text (kept in tooltip), and the click opens the board when sync is ok and verifies the log when it is not | Status bar | Literal D-17 reading vs keeping the name; tests need updating either way |
| A6 | Integration branch is fetched into a private ref `refs/near-ai/integration/<branch>` inside the project's repository | Pattern 5 | A team may prefer the mirror; the reader is behind one function so it can move |
| A7 | `source` commit on the milestone item plus an ancestor check prevents lead-to-lead flapping | Pattern 6 | If omitted, concurrent leads with different fetch freshness can write conflicting updates |
| A8 | The sidebar view is hidden in solo (`when: nearAi.teamMode`) and the command explains; no welcome view in solo | Webview design | If the owner wants the view visible in solo with a welcome message, solo UI changes (breaks literal 0.4.8 parity) |
| A9 | Card history is an in-memory view of accepted item events held by the board adapter, not part of `TeamState` | Pattern 8 | If persistence across reload without replay is needed, it must go into hashed state or a cache file |
| A10 | Board-created items cannot depend on other items this phase (no field in the form) | Event bodies | Dependencies on board items arrive with later phases; `item.created` has no `dependsOn` |
| A11 | Plans with `gap_closure: true` get tag `gap-closure`; other frontmatter flags (`autonomous`) are not imported | Event bodies | Minor; tags are optional metadata |
| A12 | Observers and reviewers see the board read-only (no moves offered); read-only clients without a device key see it with moves hidden and `READ_ONLY_TEXT` | Board model | None for correctness; UX choice |
| A13 | Archived or frontmatter-less plans get tasks from a `## Tasks` bullet list as a best-effort fallback and no estimate (so never ready) | GSD formats | Archived import is on request only (D-09); acceptable gap |
| A14 | New shared error texts, refusal wording and the 520/600/200 caps are suggestions | Event bodies | Caps change a validator; fine before release |
| A15 | E2E needs a test seam in `NearAiTestApi` (or an exposed `TeamModeHandle`) to enable a team in the real host | Live updates | Without it the board cannot be exercised in e2e; alternative is a pre-seeded workspace with a committed team and a stored device key |
| A16 | `/gsd-ui-phase 62` (roadmap marks `UI hint: yes`) is worth running before planning the webview plans | Webview design | Skipping risks rework of layout/a11y decisions; the UX contract asks for owner review of visual surfaces |

## Open Questions (RESOLVED)

Resolved by the orchestrator on 2026-11-02 under the owner's auto-advance, taking the researcher's recommendations (Q3 adjusted to the approved UI-SPEC):

- Q1 RESOLVED: no roadmap Goal text on lane headers this phase.
- Q2 RESOLVED: fetch the integration branch into a private ref in the project repo, behind one function boundary; the ref is a parameter.
- Q3 RESOLVED: the Team status bar always gets its icon, tooltip and accessibility label (UI-SPEC, fixes the Phase 61 UI review); with no items on the log it shows the team text without counts, and once items exist it shows `Team: N ready · M pending`.
- Q4 RESOLVED: a missing dependency blocks readiness with reason `dependency-missing` shown on the card.
- Q5 RESOLVED: no confirmation for auto-import; one notice per window ("Imported N items to the Team Board") when something was written, none on a no-op.


1. **Should phase and milestone `**Goal**` text appear on lane headers?**
   - What we know: CONTEXT forbids plan bodies beyond must-have strings; a Goal is roadmap text, not a plan body, but not a title or must-have either.
   - What's unclear: whether the owner treats it as metadata.
   - Recommendation: omit in this phase (A1); revisit with the owner at plan review.
2. **Where should the integration branch be fetched (project repo private ref vs coordination mirror)?**
   - Recommendation: private ref in the project repo (A6); one function boundary keeps it swappable.
3. **Status bar text when the log has no items yet, and whether the team name stays.**
   - Recommendation: unchanged text until items exist; then `Team: N ready · M pending` (A5).
4. **Should unresolved (missing) dependencies block readiness?**
   - Recommendation: yes, conservatively, with the reason `dependency-missing` visible on the card, because a dependency on a plan outside the imported milestone cannot be proven done.
5. **Does an auto-import on window open need a first-run confirmation?**
   - What we know: D-03 mandates automatic re-import for leads.
   - Recommendation: no confirmation, but one notice per window ("Imported N items to the Team Board") when something was written; none for a no-op.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | build, tests | yes | v24.22.2 | - |
| git | import reader, transport tests | yes | 2.53.0 | - |
| TypeScript toolchain (`node_modules`, `dist/`) | compile, lint | yes | ^5.7.2 | - |
| VS Code test binary | e2e | yes (cached) | 1.144.0 in `.vscode-test/` | `@vscode/test-electron` downloads if missing |
| X display | e2e | yes (`DISPLAY=:0`, sockets X0 and X1 present) | - | `xvfb-run` is **not installed**, so `npm run test:e2e` (which uses `xvfb-run -a`) cannot be used here; use `npm run compile && env -u ELECTRON_RUN_AS_NODE DISPLAY=:0 node dist/test/e2e/run.js` |
| Remote git host | none (tests use local bare repos) | n/a | - | - |

**Missing dependencies with no fallback:** none. **With fallback:** `xvfb-run` (use the explicit `DISPLAY=:0` command).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `node:test` on compiled output (`node --test dist/test/*.test.js`), Node v24.22.2; real git in temp dirs; `vscodeStub` for adapters; `node:vm` + hand-rolled fake DOM for `media/**/*.js`; extension-host e2e via `@vscode/test-electron` |
| Config file | none for tests; `tsconfig.json` (rootDir `src`, outDir `dist`, strict) |
| Quick run command | `npx tsc -p tsconfig.json && node --test dist/test/<file>.test.js` (the pattern the Phase 60/61 plans use); one compiled file ran in 0.11 s here (`teamPermissions`, 60 tests) |
| Full suite command | `npm run lint && npm test` (lint is `tsc --noEmit`; test is `npm run compile && node --test dist/test/*.test.js`) |
| E2E command | `npm run compile && env -u ELECTRON_RUN_AS_NODE DISPLAY=:0 node dist/test/e2e/run.js` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| BOARD-01 | Frontmatter/roadmap/task parsing incl. variants (inline/block lists, quoted, no-frontmatter, decimal phases, CRLF, hostile input) | unit | `node --test dist/test/teamGsdImport.test.js` | Wave 0 |
| BOARD-01 | Live import of this repo's `.planning` at `HEAD` yields 1 milestone, 8 phases, 26 plans, 63 tasks, plans 60-xx/61-xx `done`; re-import writes 0 events | integration (real git) | `node --test dist/test/teamImport.test.js` | Wave 0 |
| BOARD-01 | Unpushed local draft never imported (private ref vs local branch); `main`-only fixture; orphan plans skipped | integration | `node --test dist/test/teamImportSource.test.js` | Wave 0 |
| BOARD-01 | Idempotency, update-not-duplicate, cancel on vanish ("no longer in the roadmap"), summary-gained flag, other-milestone items untouched, bearer-token string sanitised, 98-event batch size | integration | `node --test dist/test/teamImport.test.js` | Wave 0 |
| BOARD-01 | Item event validators exact-key, caps, id/kind coherence, frozen signed shapes | unit | `node --test dist/test/teamItemValidate.test.js` | Wave 0 |
| BOARD-01 | Snapshot with items: serialise/deserialise round trip, hash equal, signed snapshot file loads; Phase 60/61 hashes unchanged | unit | `node --test dist/test/teamMaterialize.test.js dist/test/teamRelease.test.js dist/test/teamItemSnapshot.test.js` | partly exists |
| BOARD-01 | Board model: columns, lanes, filters (mine, ready, blocked, requirement, phase), weighted progress, card face/detail fields | unit | `node --test dist/test/teamBoardModel.test.js` | Wave 0 |
| BOARD-01 | Ready rule truth table incl. determinism (no clock), property test: same events any batching -> same readiness | unit | `node --test dist/test/teamWork.test.js` | Wave 0 |
| BOARD-02 | Two clones: A moves, B shows it after exactly one poll interval (fake clock); board-visible unfocused window polls at the focused interval | integration | `node --test dist/test/teamBoardLive.test.js` | Wave 0 |
| BOARD-02 | Session change hook fires for own and remote appends, throttled post only on change and only when visible | unit (stub) | `node --test dist/test/teamBoardView.test.js` | Wave 0 |
| BOARD-02 | Real webview receives `state` after a second client's append; webview script loads under CSP | e2e | `... node dist/test/e2e/run.js` (new test in `suite.ts`) | Wave 0 |
| BOARD-03 | `decideTeamAction` mapping for every item event x role; developer own-draft only; imported items manager-only | unit | `node --test dist/test/teamPermissions.test.js dist/test/teamItemPermissions.test.js` | partly exists |
| BOARD-03 | Illegal moves rejected on write (conflict text) and on read (rejection reason); claim/integration columns refused; `planMove` offers only permitted targets | unit + integration | `node --test dist/test/teamBoardMoves.test.js` | Wave 0 |
| BOARD-03 | Forged item events (bad role, wrong state, duplicate id, missing parent) never change state and are listed as rejected | integration | `node --test dist/test/teamForgery.test.js dist/test/teamItemForgery.test.js` | partly exists |
| UI/a11y | `board.js` in vm: both layouts by width, Move menu keyboard flow, DnD drop -> `move` message, refusal snap-back + live region text, reduced-motion class, `textContent` only (hostile title inert) | unit (vm) | `node --test dist/test/boardClient.test.js` | Wave 0 |
| Solo parity | No board provider/`setContext`/team modules/timers in solo; both commands explain; manifest entries; verify-release list | unit | `node --test dist/test/teamSoloParity.test.js dist/test/teamManifest.test.js` | exist, extend |
| Privacy | Canary through import and board-created items: nothing secret-like on the coordination branch, `team.json`, audit | integration | `node --test dist/test/teamInvitePrivacy.test.js dist/test/teamItemPrivacy.test.js` | partly exists |

### Sampling Rate
- **Per task commit:** `npx tsc -p tsconfig.json && node --test dist/test/<the touched file>.test.js` (seconds).
- **Per wave merge:** all `dist/test/team*.test.js`, `dist/test/boardClient.test.js` (`node --test dist/test/team*.test.js dist/test/boardClient.test.js`).
- **Phase gate:** `npm run lint`, `npm test`, then the e2e command; all green before `/gsd-verify-work`. Permission, snapshot-determinism, secret and solo-parity tests block immediately when touched.

### Wave 0 Gaps
- [ ] `src/test/teamGsdImport.test.ts` plus a committed fixture directory of real-shape GSD files (ROADMAP with checklist and waves, PLAN with inline and block lists, no-frontmatter PLAN, SUMMARY, decimal phase, CRLF, a hostile PLAN with 1 MB, prototype keys, lone surrogate, bearer-token must-have).
- [ ] `src/test/teamImport.test.ts`, `teamImportSource.test.ts` (real git: bare remote, clone with an unpushed draft commit, `HEAD` live check).
- [ ] `src/test/teamItemValidate.test.ts`, `teamItemSnapshot.test.ts`, `teamItemPermissions.test.ts`, `teamItemForgery.test.ts`, `teamItemPrivacy.test.ts`, `teamWork.test.ts`, `teamBoardModel.test.ts`, `teamBoardMoves.test.ts`, `teamBoardLive.test.ts`, `teamBoardView.test.ts`.
- [ ] `src/test/boardClient.test.ts` and a shared fake DOM helper (extract/extend the one inline in `toolsPage.test.ts`: needs `keydown`, `dragstart`/`dragover`/`drop` with `preventDefault` and `dataTransfer`, `focus`, `ResizeObserver` stub, `classList`).
- [ ] Extend `src/test/helpers/teamEvents.ts` `buildScenario` (seeded, `mulberry32`) with item events for the determinism property; add an item fixture builder to `teamHarness.ts`.
- [ ] Extend `vscodeStub.ts` for `registerWebviewViewProvider`, `createWebviewPanel` (or reuse the harness style of `activityView.test.ts`) and the `setContext` command.
- [ ] Edit existing tests listed in Pitfall 7 in the same commit as the behaviour change.
- [ ] E2E: team seam (A15), `boardTap` export in `boardView.ts`, new tests in `src/test/e2e/suite.ts`; add `board.js`/`board.css` to `scripts/verify-release-content.mjs`.
- Framework install: none.

## Security Domain

`security_enforcement` is not set to `false` in `.planning/config.json`, so this section applies.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no (device-key identity exists from Phase 60) | existing Ed25519 signing |
| V3 Session Management | no | - |
| V4 Access Control | yes | `decideTeamAction` on write and on read; `item.move`, `ownDraft`; host re-checks every webview request |
| V5 Input Validation | yes | exact-key body validators; targeted frontmatter reader with size/line/list caps; host-side `parseBoardMessage`; code-point-safe sanitising |
| V6 Cryptography | no new use | existing canonical JSON and Ed25519; never hand-roll |
| V7 Error handling and logging | yes | failures go to the NEAR AI Team output channel via `safeReason`; no empty catch |
| V12 Files and resources | yes | file-size caps before reading blobs; no path from untrusted data is used to open files (paths come from `ls-tree`, `gsd.file` is stored as text) |
| V14 Configuration | yes | nonce CSP `default-src 'none'`, `localResourceRoots` limited to `media/board`, no remote resources |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Hostile PLAN/ROADMAP on the integration branch (huge, deep, `__proto__`, regex bombs) | Denial of service, Tampering | size cap via `cat-file --batch-check`, line and list limits, `Object.create(null)`/Maps, no spread of parsed input, linear regexes |
| Secret-like text in plan strings reaching the log | Information disclosure | per-field `findSecrets` sanitising before `assertNoSecrets`; metadata-only fields |
| Teammate text rendered as HTML in the board (stored XSS) | Tampering, Elevation | `textContent` only, CSP without `unsafe-inline`, host flattens names |
| Spoofed webview messages | Spoofing, Elevation | strict message parser, fresh-state `planMove`, role from the log not the page |
| Forged or out-of-role item events | Tampering, Elevation | same validators and `decideTeamAction` on read; rejected events listed with reason |
| Flapping imports / log spam | Denial of service | diff-based no-op, stale-source guard, one batch per change |
| Unpushed or local content imported | Information disclosure, Integrity | read the remote-fetched private ref only |
| Item text later fed to agents as instructions | Elevation | out of scope here; flag for Phase 64 Next Task (teammate text is untrusted via `untrusted.ts`, SEC-03 in Phase 67) |

## Sources

### Primary (HIGH confidence, read in this session)
- Repository code: `src/domain/team/{types,validate,materialize,permissions,canonical,secrets,policy,invite}.ts`, `src/team/{eventLog,gitTransport,runGit,transport,syncScheduler,enable,teamFile,identity,auditMirror}.ts`, `src/services/team/{teamSession,teamCommands,teamStatusBar}.ts`, `src/services/{activityView,mcpView,panelView}.ts`, `src/extension.ts`, `package.json`, `tsconfig.json`, `scripts/verify-release-content.mjs`, `media/*/*.{js,css}` (patterns), tests `teamPermissions`, `teamValidate`, `teamSession`, `teamSessionMembers`, `teamManifest`, `teamSoloParity`, `teamRelease`, `toolsPage`, `activityView`, `e2e/suite.ts`, helpers.
- Planning inputs: `62-CONTEXT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md`, `UX-CONTRACT.md`, `v0.6.0-team-mode-addendum.md` (sections 5.2, 6.3-6.5, 7, 8, 10, 11), `60-CONTEXT.md` (D-02/03/07/09/12/17/19/24/30-34), `61-12`/`61-13` SUMMARY and PLAN.
- Experiments run: survey of all `*-PLAN.md` frontmatter and body tags; prototype frontmatter and roadmap parsers (0 failures); item size statistics; `findSecrets` on the real 61-02 string; git timing (`ls-tree`, `cat-file --batch`, 100-event plumbing commit); private-ref fetch scratch repo; `node --test dist/test/teamPermissions.test.js` (60 pass).

### Secondary (MEDIUM confidence)
- [CITED: https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html] SC 2.5.7, Level AA, requirement sentence quoted above.
- [CITED: https://code.visualstudio.com/api/extension-guides/webview] `retainContextWhenHidden` cost, `getState/setState`, CSP and `localResourceRoots`, message passing, `vscode-light`/`vscode-dark`/`vscode-high-contrast` body classes and `--vscode-*` variables. (The page does not document `WebviewViewProvider` details; those were taken from this repo's `panelView.ts`.)

### Tertiary (LOW confidence)
- None relied upon.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - no new packages; all reuse verified by reading the code.
- Architecture: HIGH for the domain/event/import design (prototyped against real files), MEDIUM for webview structure (patterns verified, but the board itself is new and not run in a host).
- Pitfalls: HIGH - the bearer-token hit, the snapshot refusal, the pinned tests and the `main` roadmap gap were each observed directly.

**Research date:** 2026-11-02
**Valid until:** 2026-12-02 (stable internal codebase; revisit if Phase 61 closes with changes to `teamSession.ts` or the status bar)
