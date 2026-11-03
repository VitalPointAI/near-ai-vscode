# Roadmap: Near AI for VSCode

## Milestones

- Milestone 1: Phases 1-6 (SHIPPED)
- **v0.4.0 A working core and a native NEAR agent runner**: Phases 7-12 (SHIPPED)
- **0.4.x line**: ongoing releases on top of v0.4.0 (current; 0.4.5 published 2026-10-29)
- **v0.5.0 Trusted-source knowledge base**: PAUSED 2026-10-29 and moving to a separate project. Its roadmap, requirements, research and Phase 13 plans are archived in `.planning/milestones/v0.5.0-paused/`; the Phase 13 code lives on the local branch `gsd/phase-13-sovereignty-gate-post-quantum-cryptography-and-the-encrypted`.
- 🚧 **v0.6.0 Team Mode**: Phases 60-67 (current milestone; planning started 2026-10-31)

## 0.4.x line

Work here ships as 0.4.x releases: a `hotfix/0.4.N` branch from `main`, then the full unit, e2e and release checks, then the Marketplace and GitHub release once the owner approves that version.

| Release | Date | Highlights |
|---------|------|------------|
| 0.4.1 | 2026-10-28 | Build-tooling security fixes; tests stay honest |
| 0.4.2 | 2026-10-28 | Auto approval mode; 429 retry storm fixed |
| 0.4.3 | 2026-10-28 | Approval mode picker in the chat bar |
| 0.4.4 | 2026-10-29 | Conversations, steering, accurate spend, Agent Activity overview, Tools directory |
| 0.4.5 | 2026-10-29 | Team Studio; stalled replies retried and reported; reporting token in Settings |

Next phases are added here (integer numbering continues from 25) when 0.4.x work is planned with GSD.

## v0.6.0 Team Mode

**Milestone goal:** Turn the single-developer harness into a team harness where several people, each running their own NEAR AI agents, work one project toward Open-GSD milestones and releases without colliding, overspending or leaking secrets.

**Inputs:** `.planning/REQUIREMENTS.md` (33 requirements), `.planning/research/v0.6.0-team-mode-addendum.md` (the spec; it governs wherever it differs from this file).

**Phase numbering:** this milestone uses Phases 60-67. They are the spec's Phases 25-32 renumbered in order (25 to 60, 26 to 61, 27 to 62, 28 to 63, 29 to 64, 30 to 65, 31 to 66, 32 to 67), because Phase 25 belongs to the parallel 0.4.x line. The spec file keeps its original numbers; translate with this mapping when reading it.

**Ground rules for every phase:**
- Existing projects keep working with no forced setup or migration, and the existing test suite stays green. From Phase 63 on, the always-on workflow (task workspaces, review, one path into the main branch, releases and recovery) applies to every project, a single developer included; it is introduced with a plain-language first-run explanation and can be turned off per project. The multi-person layer (signed coordination log between people, invites and roster, per-member NEAR keys and spend caps, handing work between people) stays opt-in until a second person joins. (updated 2026-11-02; Phases 60 to 62 were built and verified on Team Mode being explicitly enabled and are unchanged)
- No developer knowledge required: agents do all git work behind plain actions and report it in plain words; git terms appear only in an optional details view. (added 2026-11-02)
- `npm run lint` and the full `npm test` pass at the end of every phase; from Phase 62 on, `npm run test:e2e` passes too.
- `src/domain/team/*` and `src/team/*` never import `vscode` and add no runtime dependencies. Money is integer nano-USD. Event ordering never uses wall-clock time.
- The coordination log carries metadata only: no prompts, source, diffs, tool output or secrets. No secret is ever written to the log, `team.json`, settings, transcripts, audit or fixtures.

**Execution order:** Phases run in numeric order, 60 to 67. After Phase 60, Phases 61 and 62 are independent of each other. After Phase 63, Phases 64, 65 and 66 are independent of one another (66 also needs 61), so they can be reordered.

**Phase summary:**

- [x] **Phase 60: Team core: identity, signed event log, git transport, roster** - Enable Team Mode and share one signed, verified coordination log over the project's git remote (completed 2026-11-01)
- [ ] **Phase 61: Invitations, joining, removal, NEAR org and key integration** - Invite by email, join with a single-use code, remove cleanly, with NEAR access and keys following
- [ ] **Phase 62: Work model, GSD import, Team Board (live, read and move)** - A live board of milestones, phases, plans and tasks, with permission-checked moves
- [ ] **Phase 63: Claims, leases, claim workspaces, LeaseGuard, duplicate checks** - Exclusive claims and path leases enforced in the agent runtime, per-claim branches, duplicates refused
- [ ] **Phase 64: Dispatcher, offers, Next Task, agent execution under claims** - Ready work is offered or assigned per policy, and Next Task prepares a claim in one action
- [ ] **Phase 65: Integration merge train, verification, review gate, STATE regeneration** - One rebased, scope-checked, verified, independently reviewed path into the integration branch
- [ ] **Phase 66: Budgets, allocations, provider caps, reconciliation, alerts, model policy** - Allocations, a hard NEAR per-key cap, reconciliation, alerts and model policy
- [ ] **Phase 67: Metrics, collaboration, team memory, team stop, release readiness, relay transport, hardening** - Metrics, comments and handoffs, team memory, team-wide stop, a release readiness card, and an optional relay

### Phase 60: Team core: identity, signed event log, git transport, roster

**Goal**: A lead can turn on Team Mode for a project, and two clones of it share one signed, append-only coordination log over the project's own git remote in which every client verifies every event, roles are enforced and no secret is ever written.
**Depends on**: Nothing (first phase of this milestone; builds on the shipped 0.4.8 extension)
**Requirements**: TEAM-01, TEAM-04, SEC-01, SEC-04
**Scope**: Pure team core in `src/domain/team/` (types, the role-by-action matrix and `decideTeamAction`, a deterministic `reduce(events)` materializer) and Node I/O in `src/team/` (Ed25519 device keys via `node:crypto`, event envelope with Lamport clock, the `CoordinationTransport` interface, and the git transport on the orphan branch `near-ai/coordination` with compare-and-swap push, bounded jittered retry, a dedicated bare mirror under extension global storage, no force-push and `GIT_TERMINAL_PROMPT=0`). Roster events, the Enable Team Mode command, rejected-event diagnostics and a verify-log command. An unreachable remote shows a visible "Team sync paused" state instead of failing silently.
**Research flags**: Borrow the transport interface, signed-roster and threat-model patterns from the paused v0.5.0 design in `.planning/milestones/v0.5.0-paused/`, not its encrypted knowledge base.
**Success Criteria** (what must be TRUE):
  1. A lead runs `NEAR AI: Enable Team Mode` on an initialised project and gets a team, an owner device key held only in SecretStorage, the orphan branch `near-ai/coordination` and a committed `.planning/.near-ai/team.json`; canary strings placed in keys and prompts never appear in the log, `team.json`, settings or audit. (TEAM-01, SEC-01)
  2. Two VS Code instances on two clones share one coordination branch; an event appended by one is materialised identically by the other, and replaying the same committed events always yields the same state (property test). (TEAM-04)
  3. A forged event (bad signature, unbound key, or insufficient role under the spec's role matrix) is rejected by both clients, never changes state, and is listed with its reason in the Rejected events diagnostics; role permissions are enforced both when writing and when reading the log. (TEAM-04, SEC-04)
  4. Concurrent appends from both clients never lose an event: a test with several child-process clients appending to a local bare repository ends with every event present and no force-push.
  5. Solo projects (no `.planning/.near-ai/team.json`) behave exactly as 0.4.8: the existing suite is unchanged and green, and `npm run lint` and the full `npm test` pass.

**Plans**: 12/12 plans complete (12/12 executed) in 7 waves

**Wave 1**
- [x] 60-01-PLAN.md — Tracer: signed genesis round trip between two clones over a real bare remote; type contracts, canonical JSON, identity (TEAM-04)

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 60-02-PLAN.md — `decideTeamAction` full spec 6.3 matrix and `assertNoSecrets` (SEC-04, SEC-01)
- [x] 60-03-PLAN.md — Transport hardening: CAS retry with rebuild, push classification, mirror lock, rewritten-branch quarantine, paused status (TEAM-04)
- [x] 60-04-PLAN.md — Event validation: envelope, exact-key bodies with email hashes, policy validators (TEAM-04)

**Wave 3** *(blocked on Wave 2 completion)*
- [x] 60-05-PLAN.md — Full materializer, positional revocation, snapshots, seeded property test (TEAM-04, SEC-04)
- [x] 60-06-PLAN.md — `team.json` as untrusted input, atomic writes, trust pin, `team-roster` audit (SEC-01, TEAM-01)

**Wave 4** *(blocked on Wave 3 completion)*
- [x] 60-07-PLAN.md — `TeamLog`: write-side checks, two-clone convergence, forgery suite, snapshot writer (TEAM-04, SEC-04, SEC-01)

**Wave 5** *(blocked on Wave 4 completion)*
- [x] 60-08-PLAN.md — `enableTeamMode` core, team.json-only commit, rollback, canary (TEAM-01, SEC-01)
- [x] 60-09-PLAN.md — Sync scheduler, `TeamSession`, status bar, Verify Team Log, audit wiring (TEAM-04, SEC-01)
- [x] 60-10-PLAN.md — Concurrency test with forked child-process clients (TEAM-04)

**Wave 6** *(blocked on Wave 5 completion)*
- [x] 60-11-PLAN.md — `registerTeamMode` with solo parity, package.json contributions, command flows, phase gate (TEAM-01, SEC-01)

**Wave 7** *(gap closure for UAT G-60-1)*
- [x] 60-12-PLAN.md — Poll cadence cannot be starved by window-state events: ignore unchanged focus, anchor focus-loss re-arm to the last run, refresh focus after each run, fake-clock and session regression tests (TEAM-04)

### Phase 61: Invitations, joining, removal, NEAR org and key integration

**Goal**: A lead can bring people into the team and remove them cleanly: invite by email with a role and allocation, the invitee joins with a single-use code and gets their own NEAR access and API key, and removal releases everything the member held and makes their keys worthless.
**Depends on**: Phase 60
**Requirements**: TEAM-02, TEAM-03
**Scope**: Invite bundle, join flow, `member.invited` / `member.joined` / `member.removed` / `device.*` handling, and the `nearOrg.ts` client for organization, invitation, workspace key, spend-limit and usage endpoints, using the existing reporting sign-in session for the lead. Release of claims, leases and allocations on removal is defined in the materializer and proven on fixture state here; it is proven end to end in Phases 63 and 66 when those features exist.
**Research flags**: (1) Confirm exact NEAR endpoint paths and field casing against `https://docs.near.ai/llms.txt` (the spend-limit text says `spend_limit`, the schema says `spendLimit`). (2) Owner decision 1: confirm whether a key's spend limit is lifetime or per period, and which NEAR organization role may set it and may create workspace keys.
**Success Criteria** (what must be TRUE):
  1. A lead invites a person by email with a role and allocation and gets a copyable invite bundle (repo URL, team ID, coordination ref, single-use code) holding no secret beyond the code; the invitee runs `NEAR AI: Join Team`, joins only if the code matches an unexpired, unused invite, and stays an observer until the lead confirms (default policy); on confirm, in a team with a NEAR organization, the lead's client creates the member's API key in the team workspace with the member's allocation as an enforceable spend limit (members are not NEAR org members, so only the owner and leads can change it), and the key reaches only the member's device sealed to it, stored only in project-scoped SecretStorage; a lead invitee also accepts a NEAR organization invitation as admin. (TEAM-02)
  2. A lead removes a member: the member's claims, leases and allocations are released with branches preserved, their devices are revoked, every client rejects later events signed by their keys, the NEAR key's spend limit is set to zero before the key is revoked (and, for a lead, the organization member removed), and a checklist reminds the lead to remove repository access. (TEAM-03)
  3. Invite, join and remove complete end to end in tests against a fake NEAR API server (organization, invitation, workspace key, spend-limit and usage endpoints), with one opt-in live test behind an environment flag, and in a manual check against a real NEAR organization.
  4. After the full invite, join and remove flow, a privacy canary finds no secret (API key, session token, clear-text invite code) in the coordination branch, `team.json`, settings, audit or transcripts.
  5. Solo projects behave exactly as 0.4.8: the existing suite is unchanged and green, and `npm run lint` and the full `npm test` pass.

**Plans**: 24/24 plans executed in 13 waves (Waves 8 to 13 are the fix pass for the owner's 61-UAT findings, 2026-11-03)
**UI hint**: yes

**Wave 1**
- [x] 61-01-PLAN.md — Tracer: invite and self-bound join with a code-derived countersignature over real git; join rules, commit-time expiry, cancel, re-issue (TEAM-02)
- [x] 61-02-PLAN.md — Typed NEAR org, invitation, key, spend-limit and usage client plus a fake NEAR server with the real quirks (TEAM-02, TEAM-03)
- [x] 61-03-PLAN.md — X25519 seal key per device, sealed key delivery crypto, strict-shape secret exemptions (TEAM-02)

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 61-04-PLAN.md — Kept per-team NEAR session with refresh rotation, team key profile, shared browser sign-in (TEAM-02)
- [x] 61-05-PLAN.md — member.key-sealed event, device seal keys, rotation rule and the lead's attention list (TEAM-02)

**Wave 3** *(blocked on Wave 2 completion)*
- [x] 61-06-PLAN.md — Release of claims, leases and allocations on removal; snapshot compatibility and determinism (TEAM-03)
- [x] 61-07-PLAN.md — Lead invites: one-string bundle, repo URL cleaning, lead NEAR admin invitation, re-issue, cleanup checklist (TEAM-02)
- [x] 61-08-PLAN.md — Link a team to a NEAR organization with a team.json-only commit (TEAM-02)

**Wave 4** *(blocked on Wave 3 completion)*
- [x] 61-09-PLAN.md — Join: bundle, clone offer, observer until confirmed, lead accepts NEAR invitation, own key without an organization (TEAM-02)
- [x] 61-10-PLAN.md — Confirm: lead-created key capped at the allocation, sealed to the member's device and installed; rotation (TEAM-02)
- [x] 61-11-PLAN.md — Remove: limit 0, member.removed, revoke, org removal for leads, checklist, removed member's cleanup (TEAM-03)

**Wave 5** *(blocked on Wave 4 completion)*
- [x] 61-12-PLAN.md — Session reactions: confirmation notifications, pending count, key install, own removal, Join offer, key-scope tagging (TEAM-02, TEAM-03)

**Wave 6** *(blocked on Wave 5 completion)*
- [x] 61-13-PLAN.md — Commands: Invite, Join, Manage Team Members, Link NEAR Organization, Sign Out of NEAR (TEAM-02, TEAM-03)

**Wave 7** *(blocked on Wave 6 completion)*
- [x] 61-14-PLAN.md — Full-flow test on three clones and the fake NEAR, privacy canary, opt-in live test, phase gate (TEAM-02, TEAM-03)

**Wave 8** *(gap closure for 61-UAT G-61-1 to G-61-6)*
- [x] 61-15-PLAN.md — "Your organization" in the core flows' text (join, invite, remove, key delivery, link, team file, NEAR AI client manual steps) (TEAM-02, TEAM-03)
- [x] 61-16-PLAN.md — Online home core: reachable-by-teammates check, team setup shared check, share exactly team.json (TEAM-02)
- [x] 61-17-PLAN.md — Sidebar Team section model and page: state-driven buttons, board summary slot, setup steps for SETUP-01 (TEAM-02)

**Wave 9** *(blocked on Wave 8 completion)*
- [x] 61-18-PLAN.md — Join catch-up core: same-project copy brought up to date safely before joining (TEAM-02)
- [x] 61-24-PLAN.md — "Your organization" in the commands and session, one-line linking explanation with Link now or Not now, renamed titles, banned term and discovery scan (TEAM-02, TEAM-03)

**Wave 10** *(blocked on Wave 9 completion)*
- [x] 61-19-PLAN.md — Enable connects NEAR AI in place and checks the online home up front; Share Team Setup; prompts seam (TEAM-01, TEAM-02)

**Wave 11** *(blocked on Wave 10 completion)*
- [x] 61-20-PLAN.md — Invite shares first with one confirmation; Join uses catch-up (TEAM-02)
- [x] 61-21-PLAN.md — Team section host in the NEAR AI sidebar: buttons run the commands, live refresh, e2e probe (TEAM-02)

**Wave 12** *(blocked on Wave 11 completion)*
- [x] 61-23-PLAN.md — Invite modal with Copy invite and how to send it; Link Your Organization shares; push helpers removed (TEAM-02)

**Wave 13** *(blocked on Wave 12 completion)*
- [x] 61-22-PLAN.md — Real-window e2e: enable, invite, join from a behind copy, confirm; full phase gate (TEAM-01, TEAM-02, TEAM-03)

### Phase 62: Work model, GSD import, Team Board (live, read and move)

**Goal**: Every member sees one live Team Board built from the project's GSD roadmap, phases, plans and tasks, sees other members' changes within one poll, and can move cards only along permitted transitions.
**Depends on**: Phase 60
**Requirements**: BOARD-01, BOARD-02, BOARD-03
**Scope**: `gsdImport.ts` (ROADMAP, phase directories and `*-PLAN.md` frontmatter to a WorkItem graph with stable IDs derived from GSD IDs), the `item.*` events and state machine, the board webview in the NEAR AI container and as an editor panel (client code in `media/board/`, nonce CSP, provider outside `chat.ts`), swimlanes, filters, card face and detail, and the Team status bar line. Claim, dispatch and integration actions arrive in later phases; here the board reads and moves. The 2 s relay latency half of BOARD-02 is proven in Phase 67.
**Success Criteria** (what must be TRUE):
  1. Importing this repository's own `.planning` produces a correct graph of milestones, phases, plans and tasks with dependencies, scope, estimate and state, and re-importing it is a no-op that updates rather than duplicates items. (BOARD-01)
  2. A member opens the Team Board and sees cards in state columns with swimlanes by member, phase or milestone, card face and detail (dependencies, scope, estimate, history) and the mine, ready, blocked and by-requirement filters; the board is keyboard operable, has screen-reader labels, never relies on colour alone, and respects reduced motion. (BOARD-01)
  3. A move made by member A appears on member B's board within one poll interval. (BOARD-02)
  4. Moves are permission-checked and follow only permitted transitions; an illegal drop snaps back and says why. (BOARD-03)
  5. Solo projects behave exactly as 0.4.8: the existing suite is unchanged and green, and `npm run lint`, the full `npm test` and `npm run test:e2e` pass.

**Plans**: 14/23 plans executed in 12 waves (Waves 7 to 12 are the fix pass for the owner's 62-UAT findings, 2026-11-03; they run after Phase 61's fix pass, 61-22)
**UI hint**: yes
**Owner amendments (2026-11-03)**: the board opens only in its own editor tab and the sidebar Team section shows a summary; a lead assigns cards (signed item.assigned and item.unassigned, claims stay in Phase 63); planless phases show as Backlog cards; Done folds by default; layout and drag are proven in a real window with real screenshots the owner reviews (recorded in 62-CONTEXT.md and 62-UI-SPEC.md by 62-17).

**Wave 1**
- [x] 62-01-PLAN.md — Item events: confirm the signed bodies, then validators, item.move permission row and the state machine on write and read, two-clone tracer (BOARD-01, BOARD-03)
- [x] 62-02-PLAN.md — Integration-branch reader: private ref fetch, .planning snapshot, tree hash, remote head, ancestry, size caps (BOARD-01)
- [x] 62-03-PLAN.md — Pure GSD parser and fixtures: roadmap, frontmatter, tasks, current and archived milestones, HEAD survey (BOARD-01)

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 62-04-PLAN.md — Computed ready, columns, progress, ready count, card history, snapshots with items, determinism and forgery suites (BOARD-01, BOARD-02, BOARD-03)
- [x] 62-05-PLAN.md — Importer: idempotent import, cancel on vanish, cleaning, stale guard, two-lead race, live import of this repo's .planning, privacy canary (BOARD-01)

**Wave 3** *(blocked on Wave 2 completion)*
- [x] 62-06-PLAN.md — Pure board model and move planner: columns, lanes, filters, card face, detail, refusal copy (BOARD-01, BOARD-02, BOARD-03)
- [x] 62-07-PLAN.md — Session: change hook, board-visible polling, automatic import, D-17 status bar, one-poll proof (BOARD-01, BOARD-02)

**Wave 4** *(blocked on Wave 3 completion)*
- [x] 62-08-PLAN.md — Board host: view and panel, CSP, message parser, moves with native prompts, commands, solo parity (BOARD-01, BOARD-02, BOARD-03)
- [x] 62-09-PLAN.md — Board client core: both layouts, filters, lanes, states, live region, keyboard model, styles (BOARD-01, BOARD-03)

**Wave 5** *(blocked on Wave 4 completion)*
- [x] 62-10-PLAN.md — Move to... menu (BOARD-03)
- [x] 62-11-PLAN.md — Kanban drag and drop with snap-back and reasons (BOARD-03)
- [x] 62-12-PLAN.md — Card detail drawer and drill-in (BOARD-01)
- [x] 62-13-PLAN.md — New item and edit: form and host handling (BOARD-01, BOARD-03)

**Wave 6** *(blocked on Wave 5 completion)*
- [x] 62-14-PLAN.md — E2E team scenario in a real VS Code, release content, phase gate (BOARD-01, BOARD-02, BOARD-03)

**Wave 7** *(gap closure for 62-UAT G-62-1 to G-62-6; blocked on Phase 61's fix pass, 61-22)*
- [ ] 62-15-PLAN.md — Assignment events: confirm the shape, then item.assigned and item.unassigned with rules, permission, removal release and pinned hashes (BOARD-02, BOARD-03)
- [ ] 62-16-PLAN.md — Verification tools: Xvfb framebuffer to PNG, board layout probe (not packaged), DevTools client for a real-input drag (BOARD-01, BOARD-03)
- [ ] 62-17-PLAN.md — Board only in its own editor tab: no sidebar board view, nothing opens by itself; owner amendments recorded (BOARD-01)
- [ ] 62-18-PLAN.md — Sidebar Team section board summary: ready, blocked and mine beside Open board (BOARD-01, BOARD-02)

**Wave 8** *(blocked on Wave 7 completion)*
- [ ] 62-19-PLAN.md — Board model: assignee on cards and member rows, planAssign and the person list, planless phases as Backlog cards, folded defaults (BOARD-01, BOARD-03)

**Wave 9** *(blocked on Wave 8 completion)*
- [ ] 62-20-PLAN.md — Assign and unassign from Move to... and the card detail, native person list, the person on the card, seen within one poll (BOARD-02, BOARD-03)

**Wave 10** *(blocked on Wave 9 completion)*
- [ ] 62-21-PLAN.md — Real-window layout: solid toolbar band, one board scroller, aligned columns and lanes, open on active work; probe and screenshots at four widths and four themes (BOARD-01)

**Wave 11** *(blocked on Wave 10 completion)*
- [ ] 62-22-PLAN.md — Real drag in a real window: allowed drop lands, refused drop snaps back with the reason, Escape cancels, keyboard path kept (BOARD-03)

**Wave 12** *(blocked on Wave 11 completion)*
- [ ] 62-23-PLAN.md — Realistic board with teammates and assignments, final screenshot set, full gate, owner review and hands-on repeat (BOARD-01, BOARD-02, BOARD-03)

### Phase 63: Claims, leases, claim workspaces, LeaseGuard, duplicate checks

**Goal** (updated 2026-11-02): In every project, a single developer's agents included, each task is worked in its own workspace that agents prepare behind the plain action "Start this task". No two people, and no two agents, can work the same item or the same files at the same time, agents are stopped from writing outside what they hold, and abandoned work is never lost. Claims between people use the coordination log once a second person joins.
**Depends on**: Phase 62
**Requirements**: CLAIM-01, CLAIM-02, CLAIM-03, CLAIM-04, CLAIM-05, ASSIGN-03, FLOW-01, UX-01, SETUP-01
**Scope**: `leases.ts` (conservative glob-to-glob overlap, scope derived from `files_modified`, integration-owned shared paths that cannot be leased exclusively, named resource leases), the claim protocol (claim and lease grant in one batch commit, heartbeat, expiry measured by the observer rather than the author's clock), `claimWorkspace.ts` generalising `agent/worktree.ts` (branch `near-ai/<itemId>/<memberShort>`, commit trailers), LeaseGuard in `decidePermission`, the `RequestLease` tool, sub-leases and wave ordering for sub-agents, duplicate-card and patch-id duplicate-code checks (the merge train in Phase 65 invokes the patch-id check), and offline and crash-recovery behaviour for claims. (updated 2026-11-02) Claims and workspaces work in any project without setting up a team, with the first-run explanation and the per-project off switch; the plain actions "Start this task" and "Fix what the reviewer found" hide branches and worktrees.
**Success Criteria** (what must be TRUE):
  1. Two clients racing to claim the same item, or items with overlapping scopes, produce exactly one winner in 100 of 100 randomised runs, and the loser is told who took it; a property test shows glob overlap never reports two overlapping scopes as disjoint. (CLAIM-01, CLAIM-02)
  2. An agent Write, Edit, delete or rename outside its lease set is refused with an explanation of who holds the path (or that it is out of scope) and how to ask for it, and `RequestLease` appends a request that is granted when the path is free; sub-agents in one claim hold disjoint sub-leases that cannot overlap, and wave N+1 tasks start only after wave N completes. This is covered by extended `agentTools.test.ts` and `worktreeIsolation.test.ts`. (CLAIM-03, ASSIGN-03)
  3. A claim with no heartbeat within the lease TTL expires and its item returns to ready with a "has prior work on branch X" note; the branch survives and is offered to the next claimant, who continues from it instead of restarting. Each claim runs in its own branch and worktree with attribution trailers on its commits. (CLAIM-04)
  4. Creating a card that overlaps an open item on title tokens, requirement IDs or scope requires the creator to link, merge or confirm "distinct" with a recorded reason, and a claim whose diff is already contained in the integration head is marked duplicate. (CLAIM-05)
  5. Existing projects keep working with no forced setup or migration (the workflow is introduced with a plain-language first-run explanation and can be turned off per project, and the multi-person layer stays off until a second person joins): the existing suite is unchanged and green, and `npm run lint`, the full `npm test` and `npm run test:e2e` pass.
  6. A single developer with no team set up gets a separate workspace per task from "Start this task", with the same lease and recovery protections, and no team setup step. (FLOW-01)
  7. A person can complete starting a task, recovering abandoned work and resolving a duplicate without git or developer knowledge: the plain actions "Start this task" and "Fix what the reviewer found" are the only required steps, results are reported in plain words, git details appear only in an optional details view, and a test that scans user-facing text for developer terms (like `src/test/teamPlainLanguage.test.ts`) covers every new message. (UX-01)
  8. After connecting NEAR AI, one guided setup walks through what the project is for (agent team), where it is kept (the folder becomes a repository automatically; connecting or creating an online home is offered; one person can work with no online home), who else is working on it (invite by email with role and allocation, or just me for now) and spending limits. Every step is skippable, done steps show as done, and the setup can be reopened later. It extends the 0.4.14 next-step menu rather than replacing it. (SETUP-01)

**Plans**: TBD

### Phase 64: Dispatcher, offers, Next Task, agent execution under claims

**Goal**: Ready work finds the right member without anyone hunting for it: the dispatcher offers or assigns per policy, and `Next Task` turns the best eligible item into a claimed, prepared workspace and chat session in one action, with agents always running under a member and a claim. (updated 2026-11-02) Next Task works for one person too: a single developer gets the next ready task prepared in one action without setting up a team, and offers between people apply once a second person joins.
**Depends on**: Phase 63
**Requirements**: ASSIGN-01, ASSIGN-02, UX-01
**Scope**: Pure `dispatch.ts` (readiness, the seven hard eligibility filters, weighted scoring, proposals, re-dispatch triggers, a team-wide concurrent-agent cap), the suggest, offer (default) and auto modes with offer timeouts and decline reasons feeding scoring, the `NEAR AI: Next Task` command, board button and `/next` chat action, and the GSD execute flow requiring an active claim in Team Mode, with agent runs attributed to member and claim.
**Success Criteria** (what must be TRUE):
  1. With three simulated members and a ten-plan phase, dispatch respects every hard filter (item ready, role, availability and working hours, WIP limit, allocation headroom, no lease conflict, separation of duties) and produces identical proposals for a fixed state and clock. (ASSIGN-01)
  2. In suggest mode proposals appear on the board only; in offer mode (the default) the top candidate gets Accept, Decline or Later and an unanswered offer passes to the next candidate after the timeout; in auto mode the item is claimed for the top candidate at once and they can release it. (ASSIGN-01)
  3. `Next Task` (command, board button and `/next`) claims the best eligible item for the caller, prepares its claim workspace and opens a chat session pre-loaded with the plan, its must-haves and the GSD execute command, in one action. (ASSIGN-02)
  4. In Team Mode the GSD execute flow refuses to run a plan without an active claim for it, and every agent run is attributed to its member and claim.
  5. Existing projects keep working with no forced setup or migration (the workflow is introduced with a plain-language first-run explanation and can be turned off per project, and the multi-person layer stays off until a second person joins): the existing suite is unchanged and green, and `npm run lint`, the full `npm test` and `npm run test:e2e` pass.
  6. A person can complete picking up, accepting or declining the next task, alone or in a team, without git or developer knowledge: the plain actions "Next Task" and "Start this task" are the only required steps, results are reported in plain words, git details appear only in an optional details view, and a test that scans user-facing text for developer terms (like `src/test/teamPlainLanguage.test.ts`) covers every new message. (UX-01)

**Plans**: TBD

### Phase 65: Integration merge train, verification, review gate, STATE regeneration

**Goal** (updated 2026-11-02): In every project, a single developer included, the merge train (or PR mode) is the one way work reaches the main branch: one rebased, scope-checked, verified and independently reviewed path, presented as the plain actions "Send for review" and "Ship it", and STATE.md progress comes from the log instead of hand edits.
**Depends on**: Phase 63
**Requirements**: INTEG-01, INTEG-02, INTEG-03, FLOW-01, UX-01
**Scope**: `integration.ts` merge train run by the client holding the `integrator` lease (any eligible client takes over when it expires): rebase in a scratch worktree, scope check, patch-id duplicate check, `team.policy.verifyCommands` plus the GSD verifier against `must_haves`, the review gate (`human`, `agent` or `agent-then-human`), fast-forward merge with restart on a moved head. Shared-path strategies (union merge for CHANGELOG, regenerated STATE.md, dependency changes re-resolved on the integration head, lead escalation otherwise), optional `pull-request` mode, regenerated STATE.md, calibration update, and `integration.merged` recording model IDs, agent team version and GSD core version. Fixture-repository tests cover rebase conflict, scope violation, verify failure, semantic conflict and duplicate patch. (updated 2026-11-02) The path applies to every project without setting up a team; for a single developer the reviewer-not-author rule is met by an independent review agent, and "Fix what the reviewer found" sends the findings back to the author's agents.
**Success Criteria** (what must be TRUE):
  1. Code reaches the integration branch only through the merge train (or PR mode): a claim is rebased onto the current head in a scratch worktree, a rebase conflict returns it to in-progress with the conflicting file list, and a head that moved during merge restarts the claim at the rebase step. (INTEG-01)
  2. A claim with an out-of-scope edit is held for lead approval with its diff stat, and a semantic conflict (each claim passes alone, the combined head fails) is caught because verification runs on the rebased tree; verify failures and duplicate patches are recorded and returned. (INTEG-02)
  3. A member's own agent cannot satisfy that member's review; the review comes from another member (or that member's reviewer agent) per policy, and findings appear on the card. (INTEG-02)
  4. After a merge, STATE.md progress is regenerated from the log with no hand edit, the estimation calibration is updated with actual versus estimated cost, leases are released and the item is marked done. (INTEG-03)
  5. Existing projects keep working with no forced setup or migration (the workflow is introduced with a plain-language first-run explanation and can be turned off per project, and the multi-person layer stays off until a second person joins): the existing suite is unchanged and green, and `npm run lint`, the full `npm test` and `npm run test:e2e` pass.
  6. A single developer with no team set up sends work through the same path into the main branch, and its review comes from an independent review agent, never the agent that wrote the work. (FLOW-01, INTEG-02)
  7. A person can complete sending work for review, fixing findings and shipping it to the main branch, including a conflict, without git or developer knowledge: the plain actions "Send for review", "Fix what the reviewer found" and "Ship it" are the only required steps, results are reported in plain words, git details appear only in an optional details view, and a test that scans user-facing text for developer terms (like `src/test/teamPlainLanguage.test.ts`) covers every new message. (UX-01)

**Plans**: TBD

### Phase 66: Budgets, allocations, provider caps, reconciliation, alerts, model policy

**Goal**: Money is controlled at three layers: leads set the team budget and member allocations, no member can spend beyond theirs, NEAR enforces a hard per-key cap, and spend is reconciled and alerted.
**Depends on**: Phase 61, Phase 63
**Requirements**: BUDGET-01, BUDGET-02, BUDGET-03, BUDGET-04, BUDGET-05, UX-01 (UX-01 added 2026-11-02)
**Scope**: `budget.ts` arithmetic in integer nano-USD, the budget and allocation events, `SpendTag` extended with team, member, claim and work item, signed per-claim `spend.summary` events, the provider spend-limit layer through `nearOrg.ts` (raised on each grant; absent and visibly so when no NEAR organization is configured), pre-flight checks in `outboundGuard` and the run budget, the claim-level overrun guard, reconciliation against NEAR per-key usage, 50, 80 and 100% alerts, forecast-to-complete on the milestone card, and team model policy enforced in `capabilityRouter` (allowed models per role, TEE-only switch).
**Research flags**: Spend-limit semantics are confirmed in Phase 61 research; if limits are per period rather than lifetime, map `budgetPeriod` to the provider limit here instead of using cumulative grants.
**Success Criteria** (what must be TRUE):
  1. A lead sets the team budget and grants or revokes member allocations (never beyond the unallocated budget), a member requests more with a reason and an item link, and the lead's decision is logged. (BUDGET-01)
  2. A member at 100% of their allocation cannot start a run, a run's effective cap is the minimum of run, daily, member and ring-fence remaining, a claim reaching its estimate times the overrun factor pauses at the next turn boundary, and a model or non-TEE route disallowed by team policy is refused for that role. (BUDGET-03)
  3. The provider spend limit on a member's NEAR API key is set and raised on each grant through the API (a fake server in tests), and the board says so plainly when no NEAR organization is configured. (BUDGET-02)
  4. Reconciliation against NEAR per-key usage flags a seeded 10% discrepancy as unreconciled and shows both figures, and alerts at 50, 80 and 100% of member, ring-fence and team budgets reach the member and lead as a notification, a card badge and a `budget.alert` event. (BUDGET-04, BUDGET-05)
  5. A privacy canary run of the full flow so far (enable, invite, join, claim, run, integrate, budget), with canary strings in prompts, files and keys, finds none on the coordination branch, in `team.json`, audit or settings; existing projects keep working with no forced setup or migration and the multi-person layer stays off until a second person joins; and `npm run lint`, the full `npm test` and `npm run test:e2e` pass.
  6. A person can complete setting, requesting and reading budgets and alerts without git or developer knowledge: plain actions such as "Set the budget" and "Ask for more" are the only required steps, results are reported in plain words, git details appear only in an optional details view, and a test that scans user-facing text for developer terms (like `src/test/teamPlainLanguage.test.ts`) covers every new message. (UX-01)

**Plans**: TBD
**UI hint**: yes

### Phase 67: Metrics, collaboration, team memory, team stop, release readiness, relay transport, hardening

**Goal**: The team can see how it is doing and finish a release together: metrics from the log, comments and handoffs across members, shared memory through approved proposals, a team-wide stop, a release readiness card, an optional real-time relay, and the whole flow hardened end to end.
**Depends on**: Phase 64, Phase 65, Phase 66
**Requirements**: METRIC-01, COLLAB-01, COLLAB-02, SEC-02, SEC-03, BOARD-04, UX-01
**Scope**: `metrics.ts` and the Team Metrics panel with CSV and JSON export (extending `usageExport.ts`; peer visibility off by default, no activity tracking), comments, mentions, handoffs (the receiver must accept), blockers with escalation and approval routing to a lead, team memory scoped `personal` or `team` with team writes only through `memoryApproval.ts` proposals that land through integration, the `team.stop` and `team.resume` events, untrusted wrapping of all teammate text, the milestone card (progress, burn, forecast, release readiness checklist, attributed release notes, starting `/gsd-complete-milestone`), and `relayTransport.ts`. The planner may split this phase; the relay is separable and can ship last, carrying the relay half of BOARD-02 (board changes within 2 s) and the malicious-relay harness borrowed from the paused v0.5.0 design. (updated 2026-11-02) Release readiness and recovery apply to every project, a single developer included, in plain words: "Ship it" for a release and "Undo that release" (with a hotfix path) to recover. Multi-person collaboration features (comments and mentions between people, handoffs, approval routing to a lead, peer metrics, the relay) appear only when there are several people.
**Research flags**: Review the paused v0.5.0 relay threat model and malicious-relay test harness (`.planning/milestones/v0.5.0-paused/`) before planning the relay.
**Success Criteria** (what must be TRUE):
  1. Per-member, per-agent and per-milestone metrics match hand-computed fixtures and export as CSV or JSON without prompts or code, and a milestone card shows progress, burn, forecast and a release readiness checklist from which the lead can start milestone completion. (METRIC-01, BOARD-04)
  2. Comments, mentions, handoffs, blockers and approval routing work across members, and a team memory entry is written only through an approved proposal and lands on the integration branch through the merge train. (COLLAB-01, COLLAB-02)
  3. A team stop issued by a developer halts every member's agents and refuses new runs until a lead resumes, and instructions injected into a comment do not change agent behaviour (the existing untrusted-content tests extended). (SEC-02, SEC-03)
  4. The optional relay transport passes the malicious-relay harness (a malicious relay can withhold but not forge) and delivers board changes to other members within 2 s, while git remains the default transport.
  5. The two-window `npm run test:e2e` scenario passes (enable, invite, join, claim, run a stub agent, integrate, and see done on both boards); existing projects keep working with no forced setup or migration, with the existing suite unchanged and green; and `npm run lint` and the full `npm test` pass.
  6. A person can complete checking release readiness, shipping a release and undoing it without git or developer knowledge: the plain actions "Ship it" and "Undo that release" are the only required steps, results are reported in plain words, git details appear only in an optional details view, and a test that scans user-facing text for developer terms (like `src/test/teamPlainLanguage.test.ts`) covers every new message. (UX-01)

**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 60 → 61 → 62 → 63 → 64 → 65 → 66 → 67

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 60. Team core | v0.6.0 | 12/12 | Complete    | 2026-11-01 |
| 61. Invitations, joining, removal, NEAR org and key integration | v0.6.0 | 24/24 | In Progress (fix pass planned) | - |
| 62. Work model, GSD import, Team Board | v0.6.0 | 14/23 | In Progress (fix pass planned) | - |
| 63. Claims, leases, claim workspaces, LeaseGuard, duplicate checks | v0.6.0 | 0/TBD | Not started | - |
| 64. Dispatcher, offers, Next Task | v0.6.0 | 0/TBD | Not started | - |
| 65. Integration merge train | v0.6.0 | 0/TBD | Not started | - |
| 66. Budgets, allocations, provider caps | v0.6.0 | 0/TBD | Not started | - |
| 67. Metrics, collaboration, team stop, relay, hardening | v0.6.0 | 0/TBD | Not started | - |
