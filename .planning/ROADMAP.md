# Roadmap: Near AI for VSCode

## Milestones

- Milestone 1: Phases 1-6 (SHIPPED)
- **v0.4.0 A working core and a native NEAR agent runner**: Phases 7-12 (SHIPPED)
- **0.4.x line**: ongoing releases on top of v0.4.0 (current; 0.4.29 published 2026-11-17 (release PR #77, tag v0.4.29), then 0.4.30 to 0.4.32 through release PRs #84, #88 and #93; 0.4.33 in preparation; Phase 27 shipped as 0.4.20 and its record closed 2026-11-17; Phases 28 and 29 planned; Phases 30 to 35, multi-user staff workspaces and your organization's sync hub, added 2026-11-19 as two staff collaboration drops; Phases 36 and 37, Cohere Model Vault as a third inference endpoint, added 2026-11-20 to build after Phase 32; Phases 32.1 and 32.2, guided setup and the local model manager, inserted 2026-11-20 to build after Phase 32 and before Phase 36; Phase 33.1, assigned positions and handover, inserted 2026-11-20 after Phase 33; Phases 38 to 40, the portfolio view, added 2026-11-20 after drop B; the coherence review of 2026-11-20 (`.planning/research/coherence/REVIEW.md`) adds a safety patch first, then Phase 41, the organization policy foundation, before Phases 32.1, 32.2, 33.1, 36 and 37, and places capital projects as Phases 42 and 43; Phase 44, accreditation evidence and a compliance dashboard, added 2026-11-20 to run beside the others because it changes no extension UI; Phase 45, export-controlled technical data (Controlled Goods Program and ITAR), added 2026-11-20 after Phase 41, with its dashboard overlays in Phase 44)
- **The former v0.5.0 knowledge-base plan** (Trusted-source knowledge base; never shipped, so its number was reassigned on 2026-11-18): PAUSED 2026-10-29. On 2026-11-18 the owner brought its knowledge base back as the viewing layer of v0.6.0 Data platform instead of a separate project: each of its Phases 13-24 is carried, changed, superseded or deferred there (table in that section, and marked in the archive). Its roadmap, requirements, research and Phase 13 plans are archived in `.planning/milestones/v0.5.0-paused/`; the Phase 13 code lives on the local branch `gsd/phase-13-sovereignty-gate-post-quantum-cryptography-and-the-encrypted`.
- **The former v0.6.0 Team Mode branch plan** (never shipped, so its number was reassigned on 2026-11-18): Phases 60-67 on the unmerged, local-only branch `feat/team-fix-pass` (Phase 60 complete, 61 and 62 built with re-tests open, 63-67 not started). Its identity and signed-event core lands on `main` in v0.5.0 Phase 69; the rest is the later milestone L2 (disposition table there).
- **v0.5.0 Governed agent platform**: Phases 68-74, with 74.1 and 74.2 inserted 2026-11-19 for model provenance (numbered v0.7.0 until 2026-11-18; Phase 68 complete: merged as PR #50, 052d5cf, and `relay` is a required check on main since the owner's D-19 step, 2026-11-15; Phase 69 complete, PRs #59 and #61; Phase 70 executed, every PR merged, part 4e last as #95 on 2026-11-18; replanned 2026-11-15 from the owner's platform direction; split 2026-11-18, when its relay phases became their own milestone)
- **v0.6.0 Data platform**: Phases 85-101, after Stage 1 and before the relay (owner, 2026-11-18); it contains L1a, the host and local inference
- **v0.7.0 Messaging relay**: Phases 75-84, split from the governed agent platform on 2026-11-18, after the data platform
- **v0.8.0 Cybersecurity**: Phase 25 (executed; deferred by the owner until everything else in this plan is finished, may move to its own product)
- **Later milestones L1b and L2-L6** (outlined 2026-11-15; L1 split 2026-11-18): Theia appliance (its host and local inference, L1a, moved into v0.6.0 Data platform); Team Mode on the governed core; routines and signed packages; verifiable identity and policy on NEAR; edge grouping, compute pooling and HQ federation; Theia desktop app and learned skills

## 0.4.x line

Work here ships as 0.4.x releases: a `hotfix/0.4.N` branch from `main`, then the full unit, e2e and release checks, then the Marketplace and GitHub release once the owner approves that version.

| Release | Date | Highlights |
|---------|------|------------|
| 0.4.1 | 2026-10-28 | Build-tooling security fixes; tests stay honest |
| 0.4.2 | 2026-10-28 | Auto approval mode; 429 retry storm fixed |
| 0.4.3 | 2026-10-28 | Approval mode picker in the chat bar |
| 0.4.4 | 2026-10-29 | Conversations, steering, accurate spend, Agent Activity overview, Tools directory |
| 0.4.5 | 2026-10-29 | Team Studio; stalled replies retried and reported; reporting token in Settings |
| 0.4.36 | Preparing | Organization policy, routing and privacy fixes, sync hub for operators, and accreditation evidence |

Next phases are added here (Phases 26 to 44 so far, with inserted decimal phases 32.1, 32.2, 33.1 and 44.1) when 0.4.x work is planned with GSD.

### Patch line (updated 2026-11-15)

0.4.6 to 0.4.23 are published (the CHANGELOG has each). Patches that need no GSD phase:

| Release | State | Scope |
|---------|-------|-------|
| 0.4.23 | Published 2026-11-15 (PR #51, release PR #52) | Agent model never silently replaced, GenerateImage model choice, agents kept out of `.near-ai/state/keys`, image review workflow, the three #48 sync follow-ups |
| 0.4.24 | Next | The four #46 review minors (run-tests cleanup on exit; cap the "Other agents" list in `src/gsd/tools.ts`; the legacy team consent key in `src/agent/teams.ts` near line 200; `attachments-cleared` versus the chip handler in `media/chat/chat.js`) and three documentation mismatches checked against the code: README "Good to know" says per-response attestation signatures are not verified yet, but SECURITY.md and `src/services/attestation.ts` show they are; SECURITY.md says fully-autonomous mode writes protected files without asking while README says destruction, publishing and reading keys always ask (make both say what the code does today; Phase 70 then changes the behaviour); SECURITY.md says teams have no shared memory, but team knowledge graphs exist |


### Phase 26: Performance: faster agent and research runs

**Goal**: Research projects and agent runs in general finish in hours, not days: no run stalls on an approval nobody is there to give, context stays small and cacheable, slow model calls fail over to a backup, independent work runs in parallel, a reload resumes the run, research projects get a lighter GSD profile with cheap deterministic verifiers, and every run records where its time went.
**Depends on**: Nothing (builds on the shipped 0.4.x agent runtime, approval policy, activity history and Open-GSD integration)
**Requirements**: PERF-01 … PERF-07
**Evidence (before)**: two research projects' `.planning/.near-ai/activity.json`: 26 and 13 Bash calls hung exactly 15 minutes on an unanswered approval (two runs died after about 3 h of these); median model call sent about 190k input tokens for about 285 output tokens with no cache hits recorded; model call p90 56–123 s, max about 14 min; every role ran on Flash models; one tool call per model turn; a VS Code reload killed 4.4 h and 0.6 h runs. Full baseline in `26-VERIFICATION.md`.
**Success Criteria** (what must be TRUE):
  1. A sub-agent's read-only, test, lint, typecheck, gate-script and in-worktree write commands run without a card in Auto and Edits-auto modes, while a push, a delete outside the worktree, publishing and a credential path still ask; an approval nobody answers returns "awaiting approval" to the agent within the short sub-agent wait and stays queued, and three in a row pause the run with a message. (PERF-01)
  2. Context is compacted at about 70k tokens by default, large files are read in ranges, sub-agents hand back bounded summaries, the request prefix is byte-stable across turns (tested), and cached input tokens appear in the activity log. (PERF-02)
  3. A model call that passes its deadline (120 s by default) is retried on the backup model, and planner, verifier, analyst, editor and red-team roles resolve to the deep tier while fetch and extract roles resolve to fast. (PERF-03)
  4. Web tools and read-only shell commands run concurrently, fan-out across worktrees is capped by a setting, and the system prompt tells agents to batch independent calls. (PERF-04)
  5. After a reload, a cut-off run resumes by itself with a notice (switchable), and completed tool calls are not repeated. (PERF-05)
  6. Research and writing projects get a research GSD profile (coarse phases, quick mode for content edits, the plan-checker only for plans that change gates or verifiers) and a scaffold of deterministic verifier scripts. (PERF-06)
  7. The activity log is bounded by size rather than 100 events, each run records wall time split into model, tool, approval and idle time with input, cached and output tokens, and a report command prints the breakdown; the before baseline is in VERIFICATION. (PERF-07)
**Plans:** 5 plans (complete 2026-11-10; verification in 26-VERIFICATION.md)

Plans:
- [x] 26-01-PLAN.md — Measurement: size-bounded activity log, per-run time and token split, run report command and the before baseline (PERF-07)
- [x] 26-02-PLAN.md — Approvals without stalls: unattended auto-approval classes, non-blocking sub-agent approvals, pause after three timeouts (PERF-01)
- [x] 26-03-PLAN.md — Context and models: compaction threshold, ranged reads, bounded reports, cache-stable prefix, model deadline with backup, tier routing (PERF-02, PERF-03)
- [x] 26-04-PLAN.md — Parallelism and reloads: read-only shell pool, worktree fan-out cap, batching instruction, auto-resume without repeats (PERF-04, PERF-05)
- [x] 26-05-PLAN.md — Research GSD profile and verifier scaffold, docs, verification (PERF-06)

### Phase 27: Project state follows the project across interfaces and machines (0.4.20)

**Goal**: A person opens a project in any interface (code-server from any browser, desktop VS Code, another machine) and finds the same chats, run records, checkpoints, model comparison results and applied model choices, is offered "pick up where you left off", and never has to set the profile up again or pay to redo work already done; everything that leaves the machine is encrypted end to end.
**Depends on**: Nothing (builds on the shipped 0.4.19 storage, transcripts, profile store and model comparison panel). Ships as release 0.4.20 before v0.7.0 Phase 68 (now v0.5.0).
**Requirements**: SYNC-01 … SYNC-09
**Evidence (before)**: 2026-11-13 the owner opened in desktop VS Code a week of work done through code-server on the same host. Projects are mounted at the same path, so project ids match, but chats, runs, checkpoints and `evals/` live in each editor's own `globalStorage` (code-server holds 5 transcript folders and the 2026-11-12 comparison; desktop stops at 2026-11-06), applied model recommendations are written to *user* settings (`modelComparisonPanel.ts` `applyRecommended`, ConfigurationTarget.Global), and the API key plus the transcript encryption key (`nearAi.transcripts.key`) are in each editor's SecretStorage (code-server: the browser), so the profile needed setting up again and copied transcripts could not be decrypted.
**Success Criteria** (what must be TRUE):
  1. With the same project folder opened in code-server and in desktop VS Code on one host, both show the same chat list, run records, checkpoints, comparison runs and applied model choices; work done in one appears in the other on next open without any manual step. (SYNC-01, SYNC-06)
  2. On first start of 0.4.20 each editor merges what its own storage already holds for the project into the project's state home, idempotently and without overwriting or deleting anything; the owner's existing code-server and desktop data both survive. (SYNC-02)
  3. Transcripts are encrypted with a per-project data key that is portable: unlocked on this device from SecretStorage and on a new device by the recovery code; a wrong code and a tampered bundle are refused with a plain message and leave state untouched. (SYNC-03, SYNC-04)
  4. Turning sync on shows a high-entropy recovery code once (never stored or logged); on a second machine with the same project cloned, entering it restores chats, runs, comparisons, model choices and the NEAR AI key without re-entering the key, through an encrypted bundle on a dedicated branch of the project's own git remote (never `main`); a leak test proves no plaintext transcript, key or prompt reaches the remote. (SYNC-04, SYNC-05)
  5. Opening the project on a different interface or machine shows a "Pick up where you left off" card (last chat, last run state, current GSD phase and next step); one click reopens it and nothing re-runs or spends money. (SYNC-07)
  6. All git work for sync is done by the extension and reported in plain words; conflicts from two machines merge per record with no lost entries (tested). 0.4.20 ships through the release PR with CHANGELOG and README updated. (SYNC-05, SYNC-08)
**Plans:** 36/36 plans executed (11 waves; gap closure 27-19 to 27-25 from 27-UAT.md, then 27-26 to 27-36 from the PR #40 review 27-REVIEW.md in 5 waves, all before 27-16)
**Status (checked 2026-11-17)**: complete (36/36 plans). PR #40 merged and release 0.4.20 was cut through release PR #41 on 2026-11-14 (fixes followed in 0.4.21 and 0.4.22), so SYNC-08 is met. The owner passed the real-host check on 2026-11-17 (27-UAT.md test 8, "your own old chats open in both real editors", with 0.4.29); every UAT gap is resolved; 27-16-SUMMARY.md is written and 27-VERIFICATION.md is passed.

Plans:
- [x] 27-01-PLAN.md — Wire format and crypto core: recovery code, scrypt wrap, padded AEAD objects, sealed manifest, every refusal (owner confirms the contract first)
- [x] 27-02-PLAN.md — Merge laws: records, forks, tombstones, append-only thread entries, property tests; random temp names in shared writers
- [x] 27-03-PLAN.md — Project state home and shared data key on one host (D-04, D-10), new settings, sealed NEAR AI key copy for a second editor (D-15)
- [x] 27-04-PLAN.md — Run liveness across editors (writer + heartbeat), markers, checkpoints and activity in the state home
- [x] 27-05-PLAN.md — Full thread history captured before compaction; shared ThreadStore; no pruning (D-07, D-12, D-13)
- [x] 27-06-PLAN.md — Reopen with every message: tool-step cards, chunked rendering, history list from the index
- [x] 27-07-PLAN.md — 5 live conversations, crash-safe archive, reopen makes live (D-08)
- [x] 27-08-PLAN.md — @near chat participant turns recorded and reopened in the panel (D-07)
- [x] 27-09-PLAN.md — Comparisons and applied model choices follow the project; import offer (D-06)
- [x] 27-10-PLAN.md — Safe migration from each editor's storage; project spend history mirror (D-05, D-11)
- [x] 27-11-PLAN.md — Git transport: private mirror, anonymous commits, remote as a parameter, leak scan (D-01, D-09)
- [x] 27-12-PLAN.md — Two-machine sync: collect, verify, merge, apply; refusal leaves state untouched
- [x] 27-13-PLAN.md — Archived threads as cold objects with lazy fetch; consolidation and size limits
- [x] 27-14-PLAN.md — "Pick up where you left off" card (D-03)
- [x] 27-15-PLAN.md — Sync on/off, recovery code shown once, restore on a second machine with the NEAR AI key (D-02); no remote routes into the online-home setup; sync status published
- [x] 27-17-PLAN.md — "Give this project an online home": GitHub repo public or private on click, gh or pasted-URL fallback, separate checked code push, resumable (D-14, SYNC-09)
- [x] 27-18-PLAN.md — Visible sync control in the chat panel bar with five states, errors on the control, dismissible turn-on prompt (D-16)
- [x] 27-19-PLAN.md — Gap G-27-2: older comparisons saved with mode "run" are read as "rerun" by every reader
- [x] 27-20-PLAN.md — Gap G-27-6a: no extra branch; after the person's code push the GitHub default moves from near-ai/state to their branch (pasted address: the setting to change)
- [x] 27-21-PLAN.md — Gap G-27-6c: NEAR AI's own records in .planning/.near-ai/ stay off the code push by default
- [x] 27-22-PLAN.md — Gaps G-27-4a, G-27-4c: whole labels at every side bar width with a real-window clipping guard; error sentence under the control
- [x] 27-23-PLAN.md — Gap G-27-6b (and 6a repair with a click): "Put This Project's Code Online", setup re-run offers the push; README and SECURITY
- [x] 27-24-PLAN.md — Gaps G-27-4b, G-27-4d: "No online home · Set up" on panel open; one sentence per sync failure
- [x] 27-25-PLAN.md — Gap G-27-4d: one time formatter for card and control; invitation after connecting NEAR AI
- [x] 27-26-PLAN.md — Review B1 (git): sync's mirror and hooks out of the project; planted hook and mirror config run nothing
- [x] 27-27-PLAN.md — Review B1 (where state goes): sync switch, remote choice and online-home progress in each editor's storage; guarded legacy adoption
- [x] 27-28-PLAN.md — Review B1 (keys), m3: key files trusted only when private, untracked and checked; tracked state folder refused; meta.json lock; key cache by state id
- [x] 27-29-PLAN.md — Review B1 (agent), checkpoints, m1: one shared protected-path rule for .near-ai and *.git; state folder reads ask; Revert bounded to the workspace
- [x] 27-30-PLAN.md — Review B2, B3, state.json, new-code message: one sync owner and lock per root, wrap generations, reset rule tied to the remote tip
- [x] 27-31-PLAN.md — Review join findings: refuse while runs are live, lock across copy and swap, catch-up, keep what was not carried
- [x] 27-32-PLAN.md — Review task list: text matching before the item number; no reminder after a closing question
- [x] 27-33-PLAN.md — Review model choices: one role writes one role; visible clear and descriptions; cleared choices sync; status cache
- [x] 27-34-PLAN.md — Review run liveness: hold sends to a conversation running elsewhere and follow it; migrated markers; activity re-check; migration back-off
- [x] 27-35-PLAN.md — Review minors: hidden chat view drains; Chat-view footer kept as a notice; hex digests not redacted; repo names never gh options
- [x] 27-36-PLAN.md — Review docs and the one full gate: README, SECURITY.md, CHANGELOG honest and complete; full review dispositions
- [x] 27-16-PLAN.md — Phase gate, owner check on the real host, README/SECURITY, feature PR and release 0.4.20 (feature PR and release done 2026-11-14; owner host check passed 2026-11-17)

### Phase 28: Secure development workflow setup step
**Goal**: A person with no git knowledge turns on a protected way of working for a software project in one guided Project Setup step: CI on every pull request as required checks, an independent automatic review before anything reaches the default branch, and releases that wait for their approval, adapted to their project from this repository's own kit.
**Depends on**: Nothing in flight (the DevOps team member exists since 0.4.16). Planned by the owner on 2026-11-05 as its own phase on `main`; may run beside Phase 69 and Stage 1 because it touches only the setup flow and templates.
**Requirements**: DEVF-01, DEVF-02, DEVF-03, DEVF-04
**Success Criteria** (what must be TRUE):
  1. Project Setup for a software project offers a "Secure development workflow" step in plain words; it is skippable, shows as done when done, can be reopened, and the DevOps member carries it out. (DEVF-01)
  2. The step installs this repository's own kit adapted to the project: CI on every pull request (tests, secret scan, dependency audit) as required checks, the separate-reviewer automatic review gate with the owner's approval for changes to the gate, the merge, tag and release workflow with publishing behind the owner's approval, and the bootstrap. (DEVF-02)
  3. Nothing outside the repository is changed by an agent and no token is asked for or stored: branch protection, environments and secrets are written as exact commands for the person to approve and run, and the step checks afterwards and says what is still missing. (DEVF-03)
  4. Re-running the step on a project that already has part of the kit adds only what is missing and never overwrites the person's own workflow files without showing the difference first. (DEVF-04)
**Research flags**: Which parts of this repository's kit (`scripts/merge-pr.mjs`, the agent review workflow, `prepare-release`) generalise to other project types; the kit is also the pull-request mode of Team Mode's merge train later (L2).
**Plans:** 3 plans
**UI hint**: yes

Plans:
- [ ] 28-01-PLAN.md — Software Project Setup tracer, exact preview and safe local file application (wave 1)
- [ ] 28-02-PLAN.md — Exported CI review, merge, release and human bootstrap workflow (wave 2, depends on 28-01)
- [ ] 28-03-PLAN.md — Owner setup, effective GitHub evidence and disposable repository acceptance (wave 3, depends on 28-02)

The first profile is a GitHub.com project with an npm lockfile and declared build and test
commands. Implementation proves local behavior with fixtures. Live protection and publication
acceptance require the owner-approved disposable target and a distinct reviewer.

### Phase 29: A cleanup member with a safe CleanUp tool
**Goal**: The software team tidies what agents leave behind (test output, screenshot folders, temporary mirrors) so it stops filling disk and memory, without ever deleting something important or in use: safety lives in a CleanUp tool and in the gate, not in a prompt.
**Depends on**: Phase 70 (the tool declares a manifest, and its never-touch list joins the gate's floor). Planned by the owner on 2026-11-05.
**Requirements**: CLEAN-01, CLEAN-02, CLEAN-03, CLEAN-04, CLEAN-05
**Success Criteria** (what must be TRUE):
  1. CleanUp offers as candidates only items the extension recorded as created by agent runs, or a short built-in list of known-disposable locations. (CLEAN-01)
  2. Never-touch rules are checked in code and are part of the gate's floor: tracked files and files deliberately kept, `.git`, `.env*`, keys and credentials (including `~/.near-credentials`), `.planning`, anything outside the project and the system temp area, anything changed in the last hour, and anything a running process has open or uses as its folder; links out, `..`, the home folder and over-broad patterns are refused. (CLEAN-02)
  3. Nothing is deleted at once: items move to a recoverable quarantine with a manifest, a Restore command brings them back, and a purge happens only after a retention window of about 7 days. (CLEAN-03)
  4. A dry-run list comes first, and the person confirms anything not on the known-disposable list, anything large or of unknown origin, and every permanent purge. (CLEAN-04)
  5. The cleanup member gets only CleanUp and read-only tools (no Bash, no Write), and a disaster test proves each never-touch rule. (CLEAN-05)
**Plans:** 4 plans

Plans:
- [ ] 29-01-PLAN.md — Register the cleanup member and preview artifacts with verified provenance.
- [ ] 29-02-PLAN.md — Enforce never-touch rules and record recoverable quarantine.
- [ ] 29-03-PLAN.md — Restore artifacts and require separate human approval for permanent purge.
- [ ] 29-04-PLAN.md — Verify a managed artifact producer and cleanup lifecycle in the built Workbench.

### Staff collaboration: multi-user staff workspaces (Phases 30 to 35, added 2026-11-19)

Design: `.planning/research/multiuser-sync/DESIGN.md` (research beside it in `RESEARCH.md`). Owner decisions of 2026-11-19: everyone can co-edit products from the first release; concurrent conflicting decisions show "contested" and need a fresh decision; your organization's sync hub is built in the first phases and runs standing watches, which supersedes note 11's Q5 ("attended runs only") for multi-user projects with a hub; the hub is its own service in the relay's Docker Compose stack; Team Mode (L2) moves onto this layer. Until Phase 33 ships, staff projects are single-machine, and the README says so from 0.4.35.

These phases ship in the 0.4.x line as two staff collaboration drops, like staff drops 1 and 2: **drop A** is Phases 30 to 33 (live multi-user staff projects through the hub), **drop B** is Phases 34 and 35 (offline transports, shared agent work, observations, hub watches). They need nothing from Phases 71 to 74: identities and clearances stay declared by the staff lead and every surface says so; Phase 70's labels (on `main`) give the label cells. Requirement ids MUS-01 to MUS-12 are defined in the design (section 18) and are added to REQUIREMENTS.md when Phase 30 is planned.

### Phase 30: Replication contract and co-editing core
**Goal**: Every machine that holds the same signed entries computes the same staff state, and product text can be edited by several people and agents at once with every change attributed.
**Depends on**: Nothing in flight (builds on Phase 69's signer and key status, Phase 70's labels, the staff release state machine)
**Requirements**: MUS-01, MUS-02, MUS-03
**Success Criteria** (what must be TRUE):
  1. Entry format version 2 (per-writer, per-stream hash chains with cited heads, sealed bodies, blobs), the deterministic fold and the state digest exist as pure code, and property tests show any delivery order, duplication or partition of entries from up to five writers folds to the same state and digest. (MUS-01)
  2. Two signed entries at one position by one writer produce a proof and quarantine that device on every machine, whatever the arrival order; a changed old entry breaks only that writer's chain. (MUS-01)
  3. Product text is a Yjs document carried in signed entries; random concurrent edits by persons and agents converge, every character's author is the writer that inserted it, and an update under another writer's client id is rejected. Yjs and `lib0` are vendored at pinned versions with licences (owner question 1). (MUS-02)
  4. Versions pin a content hash that must equal the text at the state vector named; concurrent conflicting decisions on one version fold to "contested" and only a fresh decision that has seen them settles it; no agent actor can approve, reject, release or supersede. (MUS-03)
**Plans:** 12/12 plans executed in 5 waves (1 {01}; 2 {02, 03}; 3 {04, 05, 06, 07, 08, 09}; 4 {10, 11}; 5 {12})

Plans:
- [x] 30-01-PLAN.md — Vendor Yjs 13.6.33 and lib0 0.2.119 (automatic pin gate, hash manifest checked at compile, test and release), the staff-replica purpose, SECURITY.md
- [x] 30-02-PLAN.md — Tracer: two writers each sign and seal one doc.update; same text and digest in both orders; every layer of the replica core and its shared contracts
- [x] 30-03-PLAN.md — CRDT spike (D-22): update sizes, full state and garbage collection for a 30-page, 20-author product
- [x] 30-04-PLAN.md — Entry hardening and closed schemas for the project, roster, registers, watches, runs and obs families; project reducer
- [x] 30-05-PLAN.md — Per-writer chains: equivocation proof and quarantine in any order, tamper, withholding, lamport, roster citation, future time
- [x] 30-06-PLAN.md — Co-editing core: ownership check, hostile updates, per-character attribution, deletion records, compaction
- [x] 30-07-PLAN.md — Decision algebra: effective, contested, settling, pending-confirmation, every table row under all permutations
- [x] 30-08-PLAN.md — Products and versions: proposals checked against the text at their snapshot, numbering, owner prompt, gate chain to awaiting-decision
- [x] 30-09-PLAN.md — Total order against a topological reference, checkpoints with order tips, incremental fold and refold, transport types
- [x] 30-10-PLAN.md — Decisions on versions through the fold: every 15.4 and 15.5 row, forbidden acts, attribution summary, source changed
- [x] 30-11-PLAN.md — Canonical vectors for Phases 31 and 32 and the hub; the replica import boundary
- [x] 30-12-PLAN.md — Integration: default reducers, convergence properties across every family, full suite and release check once

### Phase 31: Staff roster, cell keys and migration
**Goal**: A staff lead turns a staff project multi-user, invites people by signed file, and decides what each person may see, and today's ledgers move into the new format without loss.
**Depends on**: Phase 30
**Requirements**: MUS-04, MUS-05, MUS-06
**Prerequisites from Phase 30** (open owner decisions in 30-UAT.md; each must be settled and built before any transport or store feeds the fold):
  1. Bind each Yjs client id to its writer through the signed roster, so no admitted writer can take another's attribution by registering the id first.
  2. Late joiners: decide whether a writer's log may start from a signed checkpoint that records each writer's head (this may add a lamport per head to the checkpoint format, so decide before Phase 32 signs checkpoints).
  3. Refuse an update above a byte limit before Yjs decodes it, and decode in a memory-capped worker (a 4 MiB hostile update used about 1.16 GB in a probe).
  4. Schedule the Phase 30 review warnings WR-01..WR-09, recommended as the first plan of this phase.

**Success Criteria** (what must be TRUE):
  1. Genesis and a single-writer, linear roster (members, seats, decision roles, declared clearances, devices, the hub member) exist; two lead devices changing the roster offline produce a visible split that only the lead's choice resolves. (MUS-04)
  2. Invite and join work by file alone (signed invitation, signed join request with the one-time secret, six-word safety code, admission), and expired, reused or wrong-secret invitations are refused. (MUS-04)
  3. Each label cell has its own epoch key wrapped only to devices cleared for it; removing a member or device rekeys the affected cells, and the UI says that what they already received stays with them. (MUS-05)
  4. Turning a project multi-user verifies today's product, decision, calculator and wargame ledgers, imports each with its legacy head hash, keeps the legacy chains verifiable, rewrites `.planning/staff/**` as projections, and is idempotent; a project that never turns on multi-user behaves exactly as before. (MUS-06)
**Plans:** 23 plans in 10 waves (planned 2026-11-19; hardening of Phase 30 first, then WP-R1 and WP-R2 in parallel)

Plans:
- [ ] 31-01-PLAN.md: Wave 1. Shared hardening contracts: optional RosterView members, client id slots (slot * 2^20 + counter), agent seats default deny
- [ ] 31-02-PLAN.md: Wave 2. Fold driver: re-delivered entries skipped by hash, reducer-stage holds retried with the same context (findings c, d; IN-03)
- [ ] 31-03-PLAN.md: Wave 2. Update limits before decode (256 KiB / 2 MiB), pre-decode skim with the struct cap, heap ceiling probe, linear delete check (WR-07, IN-02)
- [ ] 31-04-PLAN.md: Wave 2. Text reducer: compaction with a held or refused update in its past (finding a, WR-04), client ids bound to roster slots, caps and lazy documents (WR-02, WR-05, WR-08)
- [ ] 31-05-PLAN.md: Wave 2. Decisions, causal graph and project reducer: WR-02 governance acts, WR-06, WR-09, IN-01
- [ ] 31-06-PLAN.md: Wave 2. Forks with three or more branches resolvable by any chosen branch (finding b, WR-03)
- [ ] 31-07-PLAN.md: Wave 3. Versions reducer: WR-01 gate verdicts only from allowed members, proposal and act caps, blob size checks
- [ ] 31-08-PLAN.md: Wave 3. Checkpoint version 2 heads (seq, hash, lamport, roster) so a late joiner's log starts from a checkpoint; checkpointV2 vectors
- [ ] 31-09-PLAN.md: Wave 4. Kind schema additions, invite.void and four signed-payload purposes (D-49)
- [ ] 31-10-PLAN.md: Wave 4. Memory-capped decode worker, release content entry, SECURITY.md
- [ ] 31-11-PLAN.md: Wave 4. Projection adapter: fold output to today's ledger views and files
- [ ] 31-12-PLAN.md: Wave 5. WP-R1 tracer: genesis, invite file, join file, safety code, admit, grant opened, one doc.update through the real roster view
- [ ] 31-13-PLAN.md: Wave 5. Replica store on disk, cross-window lock, signed high-water marks, rollback refused, SECURITY.md
- [ ] 31-14-PLAN.md: Wave 6. Membership and device state machines (DESIGN 15.1, 15.2), slots, hub member
- [ ] 31-15-PLAN.md: Wave 6. Cells, grants, rekey, label leak test, write-down rule, SECURITY.md
- [ ] 31-16-PLAN.md: Wave 6. Invite, join and welcome files with every refusal (expired, reused, voided, wrong secret)
- [ ] 31-17-PLAN.md: Wave 6. Deputy lead, handover, roster split and choose, roster-branch-not-chosen
- [ ] 31-18-PLAN.md: Wave 7. X25519 device key and key ring in SecretStorage, ReplicaProject (roster folded first, genesis pin), SECURITY.md
- [ ] 31-19-PLAN.md: Wave 8. Migration: verify first, import with legacy heads, reconstruct, projections, legacy files moved, idempotent
- [ ] 31-20-PLAN.md: Wave 8. Host flows for the roster commands, rekey with the agreed sentence, SECURITY.md
- [ ] 31-21-PLAN.md: Wave 9. Staff host reads a shared project from the fold; single-machine parity test
- [ ] 31-22-PLAN.md: Wave 9. Make a Single-Machine Copy
- [ ] 31-23-PLAN.md: Wave 10. Commands behind nearAi.staff.multiUserPreview, manifest tests, SECURITY.md, full suite and release check once

### Phase 32: Your organization's sync hub
**Goal**: Your organization runs one small service that carries staff projects live between people, keeps ciphertext for cells it is not cleared for, and can do no worse than withhold, which clients detect.
**Depends on**: Phase 30 (formats); Phase 31 at integration (roster checks). May run beside Phase 31.
**Requirements**: MUS-07, MUS-08
**Success Criteria** (what must be TRUE):
  1. A `hub/` workspace beside `relay/`, built like the relay (Node 26, `node:sqlite`, no runtime dependencies, distroless image, secrets from files, redacting logger, health check, required CI job), runs as its own service and profile in the relay's Compose stack with the relay's hardening, its own volume and secrets, and TLS ended at the hub. (MUS-07)
  2. The hub checks every append against the roster and the cell's access list, serves live updates and presence over server-sent events, signs checkpoints, and accepts join requests only with a valid invitation secret. (MUS-07)
  3. A malicious-hub harness (withhold, delay, replay, reorder, roll back, fork the view, inject, corrupt a blob, serve another project's stream) is detected and named by clients or is harmless, and a restore from an old backup is refused as a rollback and refilled by clients. (MUS-08)
  4. The hub reads only the roster and the cells granted to it; a byte capture shows only ciphertext for every other cell. The operator section covers certificates, pins, backups and the restore drill. (MUS-08)
**Plans:** 28 plans in 14 waves (planned 2026-11-20; Part A, the PR #130 review findings, and Part B, products in label cells, first; then the hub)

Plans:
- [x] 32-01-PLAN.md: Wave 1. Start Again resumable, recovers from the set-aside folder
- [x] 32-02-PLAN.md: Wave 2. Remove by member id, Join refuses no file, secret file folder sync
- [x] 32-03-PLAN.md: Wave 1. Single-machine copy: head mark before rename, recovery
- [x] 32-04-PLAN.md: Wave 1. Membership: lead-role removal test, lean roster branches, no-secret texts
- [x] 32-05-PLAN.md: Wave 1. Staff host reopens a shared project after Start Again
- [x] 32-06-PLAN.md: Wave 1. Test hygiene: parity in a child, real token shape, key-phrase assertions, D-05 record
- [x] 32-07-PLAN.md: Wave 2. Mark durability and a bound on refused entries
- [x] 32-08-PLAN.md: Wave 1. Pure product-cell rules: base cell roster only, pin-above-cell, import scope, baseCellHeldProducts
- [x] 32-09-PLAN.md: Wave 3. Label cells on the host: create on demand, grant by clearance, write products there
- [x] 32-10-PLAN.md: Wave 4. Make Multi-User converts labelled projects into label cells
- [x] 32-11-PLAN.md: Wave 5. Host and single-machine copy read every held cell
- [x] 32-12-PLAN.md: Wave 5. Make Multi-User asks the lead's clearance, the copy shows its notice, preview projects told the way forward
- [x] 32-13-PLAN.md: Wave 5. Label leak test and Part B docs
- [x] 32-14-PLAN.md: Wave 6. hub/ workspace: guard, config, secrets, state dir, logger, health, TLS server, key generation, boundary test
- [x] 32-15-PLAN.md: Wave 6. Hub file, invitation hub field, new signed purposes (pure)
- [x] 32-16-PLAN.md: Wave 6. Hub witness: the client's malicious-hub findings (pure)
- [x] 32-17-PLAN.md: Wave 7. Hub image, Compose service and profile, CI job, release exclusions
- [x] 32-18-PLAN.md: Wave 7. Hub store: SQLite schema, entries, blobs, checkpoints, equivocations, invites, enrolments; kill -9 drill
- [x] 32-19-PLAN.md: Wave 8. Append checks, roster cache, enrolment, equivocation, limits
- [x] 32-20-PLAN.md: Wave 9. Sessions bound to TLS and the HTTP API (heads, append, entries, blobs, enrol)
- [x] 32-21-PLAN.md: Wave 10. Server-sent events and presence
- [x] 32-22-PLAN.md: Wave 11. Signed checkpoints
- [x] 32-23-PLAN.md: Wave 11. Client hub transport and one-shot sync
- [x] 32-24-PLAN.md: Wave 11. Hub in the roster: admit with base grant, grant cells with the trade-off sentence, revoke
- [x] 32-25-PLAN.md: Wave 12. Join requests through the hub
- [x] 32-26-PLAN.md: Wave 13. Malicious-hub harness and restore drill
- [x] 32-27-PLAN.md: Wave 13. Ciphertext-only byte capture and no outbound calls
- [x] 32-28-PLAN.md: Wave 14. Operator section, SECURITY.md, CHANGELOG, requirements, close-out

### Phase 33: Live multi-user staff projects
**Goal**: Several people work one staff project at the same time from their own machines, see each other and each other's edits live, and decide products with signed, verifiable decisions.
**Depends on**: Phases 30, 31 and 32; Phase 41 (trust line, `term()`, copy lint, architecture test)
**Requirements**: MUS-09, POST-01
**Success Criteria** (what must be TRUE):
  1. Product editors are bound to the shared text: local and remote edits interleave without echo, undo removes only your own edits, other people's cursors show with names, and Show Who Wrote This attributes every part to a person or to an agent on a named person's machine. (MUS-09)
  2. The Staff Room shows who is online and what they work on, the sync control shows every connection state in one plain sentence with one action, and an offline banner explains that work is kept and may become contested. (MUS-09)
  3. Two- and three-person scenarios over a real hub pass: co-edit, propose, guard, approve on another machine with equal digests; approve offline and reject online shows contested until a fresh decision; a late joiner loads from a compaction. (MUS-09)
  4. A two-compartment label leak test over the hub passes, README and SECURITY describe multi-user staff projects with the self-declared and not-accreditation sentences, and drop A is released in 0.4.x. (MUS-09)
**Plans:** 2/20 plans executed locally in 8 waves (planned 2026-11-21, revised the same day to keep each plan within its file and context budget; a tracer first, the feature registry and signed session features in wave 1, `roster.require` and `hub.readmit` settled together in wave 2, the closing plan and the release PR wait for the owner's gate approval and release OK)
**UI hint**: yes

Plans:
- [x] 33-01-PLAN.md: Wave 1. Tracer: two computers, one real hub, one typed change seen live; the sync state machine and the update feed
- [x] 33-02-PLAN.md: Wave 1. Phase 32 follow-ups: join request cap (IN-06), Start Again count check (IN-02), withheld products notice
- [ ] 33-03-PLAN.md: Wave 2. POST-01 `roster.require` with the fold-wide stop, and `hub.readmit` with the witness clearing
- [ ] 33-04-PLAN.md: Wave 2. Editor binding core: no echo, undo only your own changes, read-only header, resync, seeded fuzz
- [ ] 33-05-PLAN.md: Wave 2. Shared version acts, contested read model, changed-while-deciding refusal
- [ ] 33-06-PLAN.md: Wave 2. Server address store, compactor for late joiners, live projection of unopened products
- [ ] 33-07-PLAN.md: Wave 3. Hub rules: needs-update for appends and sessions, per-entry blob-missing, restore mode
- [ ] 33-08-PLAN.md: Wave 3. Client sync: features announced, presence post, new outcomes, re-admit clears distrust, pull from a checkpoint base
- [ ] 33-09-PLAN.md: Wave 4. Live replicator in full: events, findings, every state reachable, sentences and actions
- [ ] 33-10-PLAN.md: Wave 4. Editor live service: one replicator per install, bindings, projector, compactor, join requests, Sync Now
- [ ] 33-11-PLAN.md: Wave 5. Share with people step, server commands with re-admit, invitation files, preview switch retired
- [ ] 33-12-PLAN.md: Wave 5. Presence sealed per cell, people list, cursors with names
- [ ] 33-13-PLAN.md: Wave 5. Staff Room live: people, sync sentence, offline banner, contested and join cards
- [ ] 33-14-PLAN.md: Wave 6. Two- and three-person scenarios over a real hub, leak test with presence, CI step (gate path)
- [ ] 33-15-PLAN.md: Wave 6. README, SECURITY.md, operator guide and CHANGELOG with the word-for-word docs test (gate path)
- [ ] 33-16-PLAN.md: Wave 7. Close-out: tight baselines, every check once, verification record, integration PR after the owner's gate approval
- [ ] 33-17-PLAN.md: Wave 8. Prepare the next available 0.4.x release for Drop A after Phase 33 merges. The owner approves merge, tag and publish.
- [ ] 33-18-PLAN.md: Wave 1. Wire pieces: feature registry, signed session features, server pin words
- [ ] 33-19-PLAN.md: Wave 3. Editor binding in VS Code: adapter, undo keybindings, take or restore, Show Who Wrote This
- [ ] 33-20-PLAN.md: Wave 5. Sync word in the one NEAR AI status item

**Note (2026-11-20)**: plan POST-01 into this phase: a generic `roster.require` feature check, so a client that lacks a feature a project needs refuses to fold it instead of ignoring entries it does not know. It must be in the field before Phase 33.1 ships positions, because an older client that ignored a relief would keep accepting the relieved holder's writes (`.planning/research/portfolio-and-assignment/DESIGN.md`, 3.9).

**Re-aimed (owner, 2026-11-23)**: built natively in Theia, not through the VSIX compatibility layer: a Monaco co-editing binding, native presence and cursors, a native Staff Room, and Share with people on the Sterling work-area page. Each person gets their own Theia Cloud session; secrets and long-term keys move to OpenBao through the native Theia foundation, which this phase now depends on. Design: `.planning/research/multiuser-hosting/DESIGN.md`, sections 9.2 and 13.

**Re-planned for native Theia (2026-11-23)**: 31 plans in 12 waves. Details are in `33-CONTEXT.md`, section "Re-aim to native Theia", decisions D-50 to D-68, owner items 22 to 29. The plan list above is not edited here; this note gives the current state.
- **Done** on `feat/phase-33-live-multi-user`: 33-01, 33-02, 33-04 and 33-19. 33-19 stays in the tree, never attached in the image.
- **To finish** in wave 1: 33-05 (merge `367a45ec`), 33-06 (retry window and live projection) and 33-18 (WIP on `feat/phase-33-18-wire-pieces`).
- **Engine plans** kept with adjustments: 33-03, 33-07, 33-08, 33-09, 33-12 (engine only) and 33-14.
- **Superseded** by native plans: 33-10 by 33-24, 33-11 by 33-27, 33-13 by 33-26, 33-20 by 33-28.
- **New plans:**
  - P7, the session-key fold (33-21) and the hub's acceptance of session keys (33-22).
  - P6, workbench session keys (33-23).
  - The native live engine (33-24) and its module registration (33-31).
  - Monaco co-editing (33-25).
  - The native Staff Room (33-26).
  - Share with people on the work-area page (33-27).
  - The Sterling status entry (33-28).
  - Native cursors and Show Who Wrote This (33-29).
  - Two-browser acceptance against the built image (33-30).
- **Order:** native plans start after Phase 46-01, 46-02 and 46-07 are on `main`.
- **Release:** criterion 4's release is the next Sterling container image by digest (33-17 replanned). There is no VSIX or Marketplace release.

### Phase 33.1: Assigned positions and handover (INSERTED)
**Goal**: In military, public service and capital projects work, people are posted to positions that outlive them by someone with the authority to do so; they cannot decline, only report for duty or report unable with a reason the tasker decides on; a handover passes a position's authority and keys from one holder to the next at a single point, never leaving it empty or held by two.
**Design**: `.planning/research/portfolio-and-assignment/DESIGN.md`, Part A (sections 3 and 4) and 10.2.
**Depends on**: Phase 33 (live roster host flows, hub append checks, POST-01); Phase 41 (mode table and `term()`, moved there from Phase 32.1 by the coherence review); Phase 71 (core) (credentials, `did:webvh`, status lists, the checker and issuance; revised 2026-11-24, owner: credentials): 33.1-04 and waves 4 to 7 wait for its checker (71-07), and 33.1-12 and the observer plans wait for the hub checks (71-09) and issuance (71-12) (33.1 D-38); Phase 33.2 (the wrap entry point; it merges between 33.1 waves 7 and 8): 33.1-19 and 33.1-23 to 33.1-26 wait for 33.2-02, 33.2-05 and 33.2-06 (33.1 D-41).
**Inserted**: 2026-11-20 by owner decision D1 in the design (accepted with all its defaults the same day).
**Requirements**: POST-02, POST-03, POST-04, POST-05, POST-06, POST-07, POST-08, POST-09 (in REQUIREMENTS.md since 2026-11-24; POST-09, observer positions, added by the owner the same day)
**Prerequisite**: POST-01 belongs to Phase 33; this phase registers `positions@1` on it.
**Success Criteria** (what must be TRUE):
  1. A J1 delegate posts a person to "Watch Officer, night" from 1 December (from today in the built-image check); the person chooses "Confirm it is you" in a hosted session ("Prove this computer" on a single machine) and compares the safety code, sees no Decline, and reports for duty from the start date after a passkey confirmation; the roster records the J1 as orderer and the lead's delegation as authority. (POST-02, POST-03, POST-04, POST-05)
  2. A report-unable reason, signed by the posted person's enrolled key, reaches only the tasker; Confirm, Defer and Reassign each lead to their state; an unanswered posting becomes overdue after 2 days (owner decision D4; a policy may set another number) with the tasker's actions. (POST-04, POST-08)
  3. In a handover, a decision the outgoing holder signs after the incoming's report is refused, the incoming reads new entries and the outgoing cannot, and a membership change between order and report forces a restage, in random fold orders and through an offline split. (POST-06)
  4. Acting postings move decision roles and back on return; a dual-hatted person cannot approve a product they own; a client without the positions feature refuses the project with the update sentence. (POST-01, POST-07)
  5. An existing multi-user project switched to an assignment mode (Defence Team in the Defence edition, Military elsewhere) gives the same decisions and grants after migration from seats; invitation-mode projects keep their screens and outcomes, with silent positions per seat. (POST-08)
  6. An industry observer invited into an Observer position until an end date is admitted only after your organization's security contact approves; they see only the copies staff release to them from key groups whose approved releasability allows their nationality or organization, and nothing of the roster (no name, position or member key); they comment in their own stream, which no other observer can read, and cannot edit, decide or post; after the end date your organization's server refuses their writes. (POST-09)
**Research flags**: (1) Military and public service terms (handover, relief in place, transfer of authority, acting, temporary duty) checked against doctrine and policy sources in the terms register before shipping (owner decision D11).
**Undo cost**: Medium: new roster kinds are permanent in shared logs, so settle their schemas in the first plan.
**Plans:** 26 plans in 13 waves (Codex planned eight on 2026-11-23; re-planned for native Theia on 2026-11-24: engine plans host-neutral, native Staff Room sections, signing through the Phase 46 key service; details in `33.1-CONTEXT.md`, 33.1 D-01 to 33.1 D-37 and 21 owner items, 17 of them accepted and item 21 answered by the owner; 33.1 D-36, 33.1 D-37 and plan 26 added 2026-11-24; revised the same day for credentials, 33.1 D-38 to 33.1 D-40)
**UI hint**: yes

Plans:
- [ ] 33.1-01-PLAN.md: Wave 1. Tracer and the permanent shapes (checkpoint): a person-key order and the member's own report on two replicas and the real hub
- [ ] 33.1-02-PLAN.md: Wave 2. The words that follow how a person serves in the Defence Team mode, and the terms register check
- [ ] 33.1-03-PLAN.md: Wave 2. `positions@1`, the shared project's signed mode and settings, and the person-key rule for every posting act
- [ ] 33.1-04-PLAN.md: Wave 3. Delegation under `mayDelegate`, who may be posted, device proof by the posting file
- [ ] 33.1-05-PLAN.md: Wave 4. Atomic handover: staged key changes, who prepares them, restaging, offline convergence
- [ ] 33.1-06-PLAN.md: Wave 5. Report unable, the personnel key group, Confirm, Defer, Reassign and overdue
- [ ] 33.1-07-PLAN.md: Wave 6. Acting, temporary, relief and vacancy; decisions that name their position and separation of duties
- [ ] 33.1-08-PLAN.md: Wave 7. Migration from seats, one record for the lead, team files that name positions
- [ ] 33.1-09-PLAN.md: Wave 7. Native: posting cards and tasker actions in the Sterling Staff Room
- [ ] 33.1-10-PLAN.md: Wave 8. Native: the posting file and Share with people in assignment modes
- [ ] 33.1-11-PLAN.md: Wave 8. Native: the position workspace and rechecks in an open session
- [ ] 33.1-12-PLAN.md: Wave 13. Close-out on the built image: criteria 1 to 6 in two browsers, SECURITY.md, the full suites once
- [ ] 33.1-13-PLAN.md: Wave 4. A posting delivered and proven through your organization's server
- [ ] 33.1-14-PLAN.md: Wave 7. The acting position checked at your organization's server, on replay and before signing
- [ ] 33.1-15-PLAN.md: Wave 1. Your organization's people rules handed to the workbench by one hidden extension command
- [ ] 33.1-16-PLAN.md: Wave 7. Presence that shows each person once, in the position they work in, and grants nothing
- [ ] 33.1-17-PLAN.md: Wave 1. One passkey confirmation per person action, and only the person signer for person-key kinds
- [ ] 33.1-18-PLAN.md: Wave 3. Observer shapes, the observer invitation and one fold of an observer stream
- [ ] 33.1-19-PLAN.md: Wave 8. Observers placed into Observer positions with their own cell; releasability and signer-approved markings at the key grant
- [ ] 33.1-20-PLAN.md: Wave 11. A holder of your organization's security contact credential approves outside observers, bound to their credential evidence; release markings approved by a release authority; nothing widens without a new approval
- [ ] 33.1-21-PLAN.md: Wave 9. Releases to an observer, their comments and staff replies; what may be written in an observer stream
- [ ] 33.1-22-PLAN.md: Wave 12. Native: inviting and releasing to observers, the feedback inbox, markings, the approval card (what the observer's credentials prove, to security contacts only) and the observer's own view
- [ ] 33.1-23-PLAN.md: Wave 9. Every key wrap through releasability; a narrowed marking rekeys in the same action
- [ ] 33.1-24-PLAN.md: Wave 10. The observer's own client without the roster, and the server's narrow view for observers
- [ ] 33.1-25-PLAN.md: Wave 9. Observer invitations that survive restarts and lead handovers, and a way out when one cannot be completed
- [ ] 33.1-26-PLAN.md: Wave 10. The security-office key group: outside observers' credentials sealed for your organization's security contacts only, cited elsewhere by hash (33.1 D-37, 33.1 D-39)

**Amendment (2026-11-24, from Phase 48.1, observer compliance AC-21.400, AC-21.401, PS-6; owner decision on B4; revised the same day, owner: credentials)**: what an outside observer must hold depends on what they may see: nothing more for key groups marked public; their `AccessAgreementCredential` (PS-6) and an organization-to-organization agreement record in the signed policy (AC-21) for any marked key group; and their `VisitClearanceCredential` as well for any ITAR, CGP or EAR compartment. The table is part of the policy's `credentials@1` section, which your organization may only tighten, and Phase 71 (core)'s `mayRelease` applies it at the approval, at every release and at every serve. The approval binds the hashes of the observer's credentials, which are sealed for your organization's security contacts only. Planned as 33.1 D-37 in 33.1-01, 33.1-18, 33.1-20, 33.1-22 and 33.1-26 (48.1-HANDOFFS.md H-18). Phase 48.1-19 writes the hub and workbench statements from 33.1's tests once this is on `main`; the vocabulary, authorities and rules of behaviour are in `docs/security/hosted-observers.md` (48.1-05).

**Version safety (2026-11-24)**: observer streams follow the rule for every shared, signed format (32.1 D-60): the observer invitation names the stream's features (`observers@1`), your organization's server holds back a staff entry an observer's Sterling cannot read yet, and `observers@1` is its own roster feature (33.1 D-36, in 33.1-01, 33.1-18, 33.1-19 and 33.1-24).

**Credentials (owner, 2026-11-24)**: access is decided by DIDs with W3C Verifiable Credentials and enforced by the data itself, with zero trust (`.planning/research/data-centric-access/RESEARCH.md`). The roster stand-ins (`clearance`, `serves`, `nationality`, `organization`, the lead-written `did`, `project.mode.signers`) are replaced by the member's own `did:webvh`, credentials cited by hash (33.1 D-39) and the policy's trusted-issuer section; one checker decides every posting, wrap and release, the level included, for everyone who holds a marked key group (owner decision O5). Positions, postings, handover, observer streams and no-roster observers stay. `cell.marking` and label-change entries carry an optional `basis` (33.1 D-40). From wave 8 on every wrap goes through Phase 33.2's `wrapForDevice`, and observers get the post-quantum wrap with keys from their join request (33.1 D-41); release copies reserve an optional label binding for 45.1-04 (33.1 D-42); the project feature `verified-clearance@1` switches on owner decision O11 (33.1 D-39).

**Re-planned for native Theia (2026-11-24)**: Codex's plans are kept where they hold (D-01 to D-05) and re-aimed: native Theia sections in place of VS Code screens, engine code host-neutral, every posting act signed by the person key after a fresh passkey confirmation, and Defence edition text that never calls the folder a project. Criteria 1, 2 and 5 above were edited on 2026-11-24 to the native words (Confirm it is you, the enrolled key, an assignment mode). Waves 1 to 6 run beside Phase 33's waves 5 to 7 on their own integration branch; waves 7 to 12 wait for Phase 33's last waves; the phase lands with or after Phase 33's PR. Observer positions (POST-09, criterion 6, D-27 to D-35) were added by the owner on 2026-11-24, and the same day the owner decided that observers receive no roster: staff release chosen versions into each observer's own stream. Outside observers are not usable on a real site until Phase 47 guest accounts (planned) ship (D-33).

### Phase 33.2: Post-quantum cell keys (cell-wrap/v2) (INSERTED)
**Goal**: Every cell key shared with a device is wrapped with a hybrid of P-256 and ML-KEM-768, both listed by the Cyber Centre for Protected B, so shared work stays protected against future quantum computers; projects switch through `roster.require`, each cell moves at its next epoch, nobody is left without keys, and no Protected B work is ever wrapped the old way.
**Inserted**: 2026-11-24 from the owner's decision O3 ("PQC if acceptable, else P-256"; a PQC option is acceptable), `.planning/research/data-centric-access/RESEARCH.md` section 10. The research placed it in Phase 71 (core); it is its own phase next to the cells it changes (33.2-CONTEXT.md D-01).
**Depends on**: Phase 33 merged (33-03 `roster.require`, 33-18 feature registry, 33-21 to 33-23 session keys and the hosted envelope, 33-24 and 33-26 the native engine and Staff Room). It edits the roster and wrap files that Phase 33.1 also edits, so it merges between 33.1's wave 7 and wave 8, or after 33.1 if that window has passed. **It must be on `main` before any site holds Protected B data**; until then 48.1-09 lists the X25519 cell wrap as an open crypto condition.
**Requirements**: WRAP-01, WRAP-02, WRAP-03, WRAP-04, WRAP-05
**Success Criteria** (what must be TRUE):
  1. An epoch key wrapped with `near-ai/cell-wrap/v2` (P-256 ECDH and ML-KEM-768, HKDF-SHA256, AES-256-GCM) opens only on the device it names, for the cell and epoch it names; frozen vectors pass; old wraps stay readable. (WRAP-01)
  2. Every device, hosted person and hub publishes its post-quantum keys bound to its Ed25519 key, the safety words cover them, and the private keys live only in the keyring, the Transit-KEK envelope or the hub's key file. (WRAP-02)
  3. A grant for hundreds or thousands of devices fits in signed pages committed by one roster entry, and a missing page recovers like any missing blob. (WRAP-03)
  4. New shared work starts switched; a lead switches an existing project in one step, each cell moves at its next epoch, late computers get keys in one step, and after the switch the fold and your organization's server refuse any new X25519 wrap. (WRAP-04)
  5. A Protected B cell is never wrapped with X25519; a CI check fails if any wrap path bypasses the one entry point; SECURITY.md says which wrap protects shared work, and ML-KEM-1024 with P-384 is reserved for Protected C and classified work. (WRAP-05)
**Undo cost**: High. The wire format, `device.kem` and grant pages are permanent in shared logs; they are settled at 33.2-01's checkpoint.
**Plans:** 5/8 plans executed in 7 waves (planned 2026-11-24 on `docs/phase-71-core-plan`; decisions D-01 to D-11 and three owner items in `33.2-CONTEXT.md`)
**UI hint**: yes

Plans:
- [x] 33.2-01-PLAN.md: Wave 1. Tracer: one epoch key wrapped with `cell-wrap/v2` and opened; runtime confirmations and the probe; the permanent shapes checkpoint
- [x] 33.2-02-PLAN.md: Wave 2. The second device key binding: `device.kem`, the descriptor's `kem`, safety words, join requests, the hub check
- [x] 33.2-03-PLAN.md: Wave 2. Grant pages committed by the founding entry
- [x] 33.2-04-PLAN.md: Wave 3. Where the new private keys live (keyring, Transit envelope, hub) and publishing the binding at open
- [x] 33.2-05-PLAN.md: Wave 4. `wrap@2` through `roster.require` with the probe; new projects switched at creation; the cutover rule in the fold and the hub
- [ ] 33.2-06-PLAN.md: Wave 5. Every wrap path through one entry point; the Protected B rule; the CI check; SECURITY.md
- [ ] 33.2-07-PLAN.md: Wave 6. The Switch, Move and Give keys cards in the native Staff Room
- [ ] 33.2-08-PLAN.md: Wave 7. Close-out on the built image, the full suites once, the integration PR after the owner's gate approval

### Phase 34: Offline transports for staff projects
**Goal**: Staff projects keep syncing where the hub cannot be reached: through any git server your organization runs, between machines in one room, and by file across an air gap.
**Depends on**: Phase 33
**Requirements**: MUS-10
**Success Criteria** (what must be TRUE):
  1. Git with one ref per writer per stream syncs without push races, never touches project branches, and does not lock the Phase 27 or Team Mode mirrors (isolation test). (MUS-10)
  2. Export for... writes a sealed bundle of what the recipients lack within a chosen label ceiling, and Import Staff Bundle verifies, folds and reports what arrived, including decisions that became contested. (MUS-10)
  3. A LAN peer link runs only after the person agrees, with device-key-pinned certificates and mutual signed challenges bound to the TLS session. (MUS-10)
  4. Two sites cut off for a simulated day converge to the same state by bundle, then by hub, and any mix of transports converges. (MUS-10)
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 34 to break down)

### Phase 35: Shared agent work, observations and hub watches
**Goal**: Agent teams on different people's machines coordinate instead of duplicating work, observations reach the people cleared for them without flooding links, and standing watches keep running on the hub when nobody is at a computer.
**Depends on**: Phase 33 (Phase 34 not required)
**Requirements**: MUS-11, MUS-12
**Success Criteria** (what must be TRUE):
  1. Run summaries, lanes and claims with leases are shared; two people's runs on one product take different sections, a double claim after a partition is shown with Let Theirs Continue or Keep Mine, and transcripts and chats stay per person. (MUS-11)
  2. Observation segments travel as sealed blobs by slice (cell, feed, area, time), high-rate positions are coalesced keeping first and last, per-link budgets set the source `degraded` rather than dropping silently. (MUS-11)
  3. A watch can be assigned to the hub (granted cells only) with fallback to an attended machine; the hub writes only matches and drafts, never decisions; rate limits, a daily spend cap, routing by label and three kill switches (lead's signed switch, per-watch pause, operator's file switch) are each tested; match ids are the same on hub and edge. Note 11's Q5 is superseded for these projects only. (MUS-12)
  4. Drop B is released in 0.4.x with the operator section for hub watches. (MUS-12)
**Plans:** 0 plans
**UI hint**: yes

Plans:
- [ ] TBD (run /gsd-plan-phase 35 to break down)

### Coherence review: one system, one vocabulary, one front door (safety patch and Phase 41, added 2026-11-20)

Review: `.planning/research/coherence/REVIEW.md` (with `GLOSSARY.md`, `POLICY-SCHEMA.md`, `EXPERIENCE.md` and `DEVELOPER-STRUCTURE.md` in the same folder). The owner added features one at a time and asked for them to work together as one product with professional UI, UX and DX and no confusion from the complexity. Four independent reviews were merged into one. **Gate:** no new user-facing phase (32.1, 32.2, 33.1, 36, 37, 38 to 40, 42, 43 and the 74.1 and 74.2 builds) starts until the review merges. Phase 32 (the sync hub) continues; Phases 28 and 29 are not blocked.

Order: (1) the **coherence safety patch**, one small PR in the patch line for eight issues in shipped code (review section 8: `localHosts` wildcards and plain http for Protected B and above, a notice for classified work on an unaccredited computer, "private" meaning the verified connection check, the PRC-origin sentence on staff teams, `requires` and "update" texts in the bundle parser, labels ranked against the active scales, scale names shown with levels); (2) **Phase 41**; (3) Phases 32.1 and 32.2, then the rest as listed below. Milestones in plain words are in the review, section 9.

### Phase 41: Organization policy foundation (F1)
**Goal**: Your organization can hand its rules to every computer, and every feature reads them the same way: one signed policy in sections that only narrows below your organization, one list of where AI may run, one kind of signed exception, one label and routing decision, one table of organization modes and words; an older extension asks to be updated instead of reset.
**Depends on**: Phase 70 (the bundle, labels, routing, records); the coherence safety patch. Builds **before** Phases 32.1, 32.2, 33.1, 36 and 37 (numbered 41 rather than 32.0 because GSD reads a decimal as part of its integer phase, and Phase 32 is mid-build). May run beside Phases 32 to 35 (different files: `src/domain/gate`, `src/gate`, `src/domain/org`, `src/domain/provider`).
**Added**: 2026-11-20 by the coherence review.
**Requirements**: FND-01 to FND-09 (defined in `.planning/research/coherence/REVIEW.md`, section 9.2; added to REQUIREMENTS.md when Phase 41 is planned)
**Success Criteria** (what must be TRUE):
  1. A computer enrolled with your organization's signed enrolment file (fingerprint read aloud) accepts policies from that issuer; a personal change that would widen any key is refused with the key named; Reset touches only the personal layer. (FND-01)
  2. A bundle that names a feature this client lacks in `requires` gives "update the extension", never Reset; every v1 bundle reads as v2 unchanged. (FND-02)
  3. Existing `routing.localHosts` entries work as `org-plain` endpoints at today's effect with a one-time notice; a Protected B request to an endpoint without a TLS pin, or with a region that breaks a residency rule, is refused before sending with a plain sentence. (FND-03, FND-05)
  4. Protected B to a third-party endpoint, a T1 acceptance and an accredited device are each one `authorizations[]` record; one signed by the person who uses it is shown as "self-signed on this computer". (FND-04)
  5. `privacyMode: tee-only`, Team Mode `teeOnly` and `privacy: private` all decide through `decideRoute`; staff observations, the chat label and the gate agree on a custom scale; the trust line shows where it ran, what was verified and what allowed it. (FND-06)
  6. The mode table and `term()` produce every mode word; the copy lint and the architecture test pass with recorded baselines that can only shrink. (FND-07, FND-09)
  7. The passport schema parses in report mode; `NearAiClient` sits behind `ModelEndpoint`; setup flows that change rules open the policy editor on a proposal. (FND-08, FND-09)
**Research flags**: (1) Owner questions Q1, Q2, Q6, Q7 in the review. (2) Enrolment file format and fingerprint reading, checked against the safety code flow (`src/domain/replica/safetyCode.ts`).
**Amended 2026-11-20 (Controlled Goods Program and ITAR, `.planning/research/compliance-dashboard/CGP-ITAR.md`, section 12)**: FND-02 also parses an `exportControl` section in report mode and ships `routing.compartments` defaults of `local-only` for the reserved compartments `CGP`, `ITAR` and `EAR`; FND-04 also accepts the authorization kinds `export-person` and `export-endpoint`, and `decideRoute` reserves the rule id `route.export-control`. Shapes only, so signed policies never need a schema change; the behaviour is Phase 45.
**Undo cost**: Medium to high: bundle v2 and the authorization record are signed into policies, so settle their schemas in the first plan.
**Plans:** 15 plans in 5 waves (planned 2026-11-20; starts after the coherence safety patch merges; decisions D-01 to D-64 in `41-CONTEXT.md`, owner confirmations listed there)

Plans:
- [x] 41-01-PLAN.md: Wave 1. Contract: bundle v2 document, feature ids, endpoints and the localHosts migration, authorizations (with the export-control kinds), sections (with exportControl in report mode), every new id and signing purpose, CGP, ITAR and EAR local-only in the starting rules
- [x] 41-02-PLAN.md: Wave 2. Layers that only narrow: the narrowing table, composition, wider personal values clamped and listed
- [x] 41-03-PLAN.md: Wave 2. Enrolment file, twelve words read aloud, the issuer script
- [x] 41-04-PLAN.md: Wave 2. One label module: staff observations, guard scan and the chat label rank through it
- [x] 41-05-PLAN.md: Wave 2. Model passport schema in report mode, shipped passports, use tier
- [x] 41-06-PLAN.md: Wave 2. Organization modes, term() and the people section
- [x] 41-07-PLAN.md: Wave 2. ModelEndpoint and LocalServerAdmin, NearAiClient as the first adapter
- [x] 41-08-PLAN.md: Wave 2. Proposals and the policy editor shell
- [x] 41-09-PLAN.md: Wave 3. Organization store and host: the pin, updates, rollback, Reset of the personal layer only, v2 writes
- [x] 41-10-PLAN.md: Wave 3. decideRoute over endpoints, authorizations, residency, accredited devices and passports; TrustFacts
- [x] 41-11-PLAN.md: Wave 3. Copy lint with a baseline that only shrinks
- [x] 41-12-PLAN.md: Wave 3. Architecture test with a baseline that only shrinks
- [x] 41-13-PLAN.md: Wave 4. Private, TEE only and Team Mode inputs through decideRoute; the trust line on every answer
- [x] 41-14-PLAN.md: Wave 4. Add your organization's rules, NEAR AI: Policy, notices and palette
- [x] 41-15-PLAN.md: Wave 5. Copy sweep, SECURITY.md, README, CHANGELOG, baselines tight, requirements, full suite

### Guided setup: viable options, a plain recommendation and local models (Phases 32.1 and 32.2, added 2026-11-20)

Design: `.planning/research/guided-onboarding/DESIGN.md`. Owner request and agreed shape of 2026-11-20: setup asks about the work in plain words (role; personal information; Protected A, B or classified markings; client information under a contract security clause; must it stay in Canada), turns the answers into a project label that the signed policy's routing table then decides on, so the guide is a front door to the gate and never a second gate; it offers only options that are viable on that machine (detected, configured, allowed by the policy, and answering a test request), never local models where no local server answers; it gives one recommendation with a one-sentence reason and greys ruled-out options with the reason; the policy wins, and when answers need what it does not allow the guide says who to ask and offers no workaround; Protected C and classified work get no recommendation; changes are previewed before Apply, re-runs show only differences, and answers are recorded. Then each role lands where it works, and with the data platform the guide offers the matching one-click connections. A local model manager shows what the machine can run (unified memory on Strix Halo and GB10 first), installs Western models from passports with verified hashes and licences, and assigns tiers. Both phases ship in the 0.4.x line after Phase 32 and before Phases 36 and 37, so Cohere's options arrive through the guide; they need only the Phase 70 gate, may run beside Phases 33 to 35 (different files), and share one contract before running in parallel. The data-connection step (GUIDE-09) lands in Phase 89. Requirement ids GUIDE-01 to GUIDE-09 and LMOD-01 to LMOD-07 are defined in the design (section 16) and are added to REQUIREMENTS.md when Phase 32.1 is planned. Open owner decisions D1 to D11 are in the design (section 17), each with a default.

### Phase 32.1: Guided setup with viable options and a plain recommendation (INSERTED)
**Release**: Ship Get Started in its own release once the end-to-end setup flow is verified and the feature merges.
**Goal**: A person setting up a project answers a few plain questions about their work, sees only the options that really work on their machine and that your organization allows, gets one recommendation with a reason, applies it after seeing what will change, and lands where their role works; the answers are recorded and can be changed later.
**Depends on**: Phase 32 (build order, owner 2026-11-20); Phase 70 (labels, routing, the bundle, records); Phase 41 (organization policy, endpoints, residency rule, mode table and `term()`, the passport schema, the policy editor for proposals; coherence review 2026-11-20). Phase 74.1 enforcement not required: the guide reads the passport schema from Phase 41.
**Inserted**: 2026-11-20 at the owner's request.
**Requirements**: GUIDE-01, GUIDE-02, GUIDE-03, GUIDE-04, GUIDE-05, GUIDE-06, GUIDE-07, GUIDE-08, ORG-01, ORG-02, ORG-03, ORG-04 (organization modes added 2026-11-20, `.planning/research/portfolio-and-assignment/DESIGN.md` section 5; the ids are defined in that design's requirements table and added to REQUIREMENTS.md when Phase 32.1 is planned); VSAFE-01, VSAFE-02 (version safety, owner, 2026-11-24)
**Success Criteria** (what must be TRUE):
  1. On a laptop with no local AI and a NEAR AI key, a developer answering "internal work, Canada No" is recommended NEAR AI private hardware with its reason, and local appears only under "Not available here" with the hardware reason. (GUIDE-01, GUIDE-03, GUIDE-04)
  2. With a local server serving a passported model, an analyst answering "sensitive personal information" gets the project labelled Protected B and is recommended this computer; NEAR AI is greyed with the routing sentence; a hosted option appears for Protected B only when the policy records an authorization for it. (GUIDE-02, GUIDE-04, GUIDE-05)
  3. Secret, Protected C, or contract work without written Contract Security Program approval stops with a plain sentence and no option, and the label is applied. (GUIDE-02)
  4. A policy that locks Canada greys NEAR AI and non-Canadian vaults with the residency reason; nothing outside the verified policy is ever offered, and no policy edit or label lowering is suggested. (GUIDE-06)
  5. Check answers lists what will change before Apply; a re-run shows only differences and never lowers a label; a signed record holds the answers, viability snapshot, policy hash, options, recommendation and choice. (GUIDE-07)
  6. Staff officers land in the Staff Room with their section's team and developers in chat with the project team; the path works by keyboard and screen reader, and nothing animates with reduced motion; existing profiles and discovery answers work unchanged. (GUIDE-08)
  7. One mode table sets words and joining behaviour together: a staff officer's setup suggests Military mode and the Staff Room then says "Post a person"; a policy fixing Public service shows the mode as set by your organization; a software project keeps "Invite", unchanged. (ORG-01, ORG-02, ORG-03, ORG-04)
**Research flags**: (1) Open owner decisions D1 to D4, D6, D7 and D9. (2) Exact probe ports and signature endpoints per local server, checked against current releases. (3) Mapping of personal information to Protected A or B to be confirmed by your organization's security officer before rollout.
**Undo cost**: Low to medium: an optional `onboarding` bundle key and a `setupGuide` entry in `project.json`.
**Plans:** 20 plans in 6 waves (planned 2026-11-21; decisions D-01 to D-44 in `32.1-CONTEXT.md`, owner confirmations listed there; plan 01 is the shared contract Phase 32.2 builds on)
**UI hint**: yes

Plans:
- [ ] 32.1-01-PLAN.md: Wave 1. Shared contract alone: step and option registry, viability reducer, device class seam, server probe table and adapter registry, answers, record event ids, guide policy accessor
- [ ] 32.1-02-PLAN.md: Wave 2. Answers to a proposed label, stop rules, pure `recommend()` over the real `decideRoute`
- [ ] 32.1-03-PLAN.md: Wave 2. Option cards from `TrustFacts`, mode suggestion (ORG-04), landing resolver
- [ ] 32.1-04-PLAN.md: Wave 2. Viability host: probes, ordered identification, fixed test request, NEAR AI check, memory-only device provider, 90-second ceiling
- [ ] 32.1-05-PLAN.md: Wave 2. Announced servers: DNS wire codec with fuzz test, one-shot mDNS, DNS SRV
- [ ] 32.1-06-PLAN.md: Wave 2. Confirmed scans of listed ranges, network facts, certificate pin, approval as a proposal
- [ ] 32.1-07-PLAN.md: Wave 2. Hash-chained local audit (`auditChain.ts`, `setupAuditLog.ts`) and the guide record
- [ ] 32.1-08-PLAN.md: Wave 2. Webview kit: typed protocol, several scripts per page, accessibility scan helper
- [ ] 32.1-09-PLAN.md: Wave 2. Staff "where" question and discovery `locality` removed, derived locality
- [ ] 32.1-10-PLAN.md: Wave 2. Project layer store and sink, project-scoped Canada wired into the gate (owner D14)
- [ ] 32.1-11-PLAN.md: Wave 3. Session reducer, page messages, change list, screen models
- [ ] 32.1-12-PLAN.md: Wave 3. Apply engine: label raise only, clearance gap as proposal, connections, proposals, choice reason
- [ ] 32.1-15-PLAN.md: Wave 3. Registered steps, landing host, context keys, first-run guarantee, exercise flag
- [ ] 32.1-13-PLAN.md: Wave 4. Get Started host and controller; success criteria 1 to 5 as scenarios
- [ ] 32.1-14-PLAN.md: Wave 4. The Get Started page on the kit, keyboard, screen reader and reduced motion
- [ ] 32.1-16-PLAN.md: Wave 4. Discovery in the guide: found servers listed as not approved
- [ ] 32.1-17-PLAN.md: Wave 5. Front door wiring, hidden aliases, legacy step forwarding, walkthrough checklist
- [ ] 32.1-18-PLAN.md: Wave 5. Chat welcome: one Get Started button
- [ ] 32.1-19-PLAN.md: Wave 5. SECURITY.md, README, docs site, CHANGELOG
- [ ] 32.1-20-PLAN.md: Wave 6. Close-out: First Project page removed, end-to-end scenario, baselines tightened, full suite once, UAT and verification

**Re-aimed (owner, 2026-11-23)**: built natively in Theia, not through the VSIX compatibility layer. The guide is what "Set up Sterling" opens from the Sterling Get Started page; its checklist becomes a section of that page; plan 17's walkthrough and title-bar entry are dropped, and there is no second home page. Hosted sessions offer only servers your organization's policy lists. Executed engine plans carry over; it now depends on the native Theia foundation. Design: `.planning/research/multiuser-hosting/DESIGN.md`, sections 9.1 and 13.

**Native re-plan (2026-11-23)**: decisions D-45 to D-58 in `32.1-CONTEXT.md` ("Re-aim to native Theia"), research R-N1 to R-N8 in `32.1-RESEARCH.md`. Kept as done on `feat/phase-32.1-get-started`: 01 to 11, 14, 15, 16; 12 and 13 finish as written. Superseded: 17, 18, 19, 20. New: 21 (engine facts: hosted rule, Defence edition kinds, work-area landings, bridge constants) and 27 (chat card) in wave 5; 22 (Defence Team mode), 23 (extension bridge, checklist rows, landing) and 25 (native Set up Sterling widget) in wave 6; 24 (front door activation) in wave 7; 26 (Set up Sterling and Your setup on Get Started, Planning page) in wave 8; 28 (documents) in wave 9; 29 (close-out on the built image) in wave 10. The guide's engine stays in the extension host beside the one live gate and talks to the native widget through commands (owner item N1). Starts after Phase 46 and PR #166 merge, on `feat/phase-32.1-native` (D-55).

**Version safety (owner, 2026-11-24)**: "the application should always keep itself up to date". Decisions 32.1 D-60 to 32.1 D-69 in `32.1-CONTEXT.md` ("Version safety"), requirements VSAFE-01 and VSAFE-02. Every shared, signed format follows one rule: an authoring check first, an edge refusal as the backstop, and no text ever tells a person to update anything. New plans: 30 (wave 7: policy features named by what a document uses, `work-areas@1` for the four work areas and `defence-team@1` for the Defence Team mode, and the check in the tool that signs your organization's rules, reading each site's release from its signed evidence export), 31 (wave 8: a release that cannot read new rules refuses them whole and keeps the last good rules in force, the update applies itself after the site is updated, one plain status line, administrator details), 32 (wave 9: every other update sentence asks the administrator, and a copy-lint rule keeps it so). Plan 28 waits for 31 and plan 29 for all three. Sessions following the site's version are Phase 46's 46-09 and Phase 47's 47-32; site releases in the signed export are Phase 48's 48-11. The class check (D-69) lists the team files, the signed bundle, the federation user export (47-14 amended) and the observer kinds of Phase 33.1, which need plan lines there.

### Phase 32.2: Local model manager (INSERTED)
**Goal**: On the appliance or any capable computer, a person sees what local models the machine can run and how fast, installs the recommended Western models with verified hashes and accepted licences, assigns them to the tiers, and the guide then offers local AI as a viable option.
**Depends on**: Phase 32.1's shared contract (device class, server adapters, viability); Phase 41 (`LocalServerAdmin`, the `models.localCatalogue` schema); may run beside the rest of 32.1. Phase 85 later sets the appliance's default server and replaces estimates with measurements.
**Inserted**: 2026-11-20 at the owner's request.
**Requirements**: LMOD-01, LMOD-02, LMOD-03, LMOD-04, LMOD-05, LMOD-06, LMOD-07
**Success Criteria** (what must be TRUE):
  1. On a Strix Halo machine the page shows the unified memory the GPU can use (or how to raise it), fit bands and speed estimates per model and quantization, and a benchmark replaces the estimates with measured numbers. (LMOD-01, LMOD-03)
  2. Models installed through Ollama and through a llama.cpp models folder are verified against the signed catalogue's hash; a changed file is rejected and never reaches the server; the licence is shown and accepted first. (LMOD-02, LMOD-05)
  3. Assigning models to the fast, standard and deep tiers passes the test and tool-calling requests, and the guide then shows local AI as viable. (LMOD-04, LMOD-06)
  4. PRC-origin and passport-less models install only into the research lane's list and never appear in a tier selector; removal asks first and names the tiers affected; every action is recorded. (LMOD-04, LMOD-05, LMOD-07)
**Research flags**: (1) Open owner decisions D5, D8, D10 and D11. (2) Whether Ollama's model layer digest equals the GGUF file's sha256. (3) Unified memory figures on Strix Halo (GTT limits) and GB10 (`nvidia-smi` reports no memory) from Phase 85.
**Undo cost**: Low: a catalogue inside `ceiling.models` and the manager's own folder.
**Plans:** 17 plans in 7 waves (planned 2026-11-21; decisions D-01 to D-36 in `32.2-CONTEXT.md`; starts from 32.1-01's merge on its own branch, later plans wait for named 32.1 plans)
**UI hint**: yes

Plans:
- [ ] 32.2-01-PLAN.md: Wave 1. GGUF header reader, memory and fit bands, speed estimate, device bandwidth table
- [ ] 32.2-02-PLAN.md: Wave 1. Hardware detection with unified memory (Strix Halo, GB10, Apple), fixed tools, no shell
- [ ] 32.2-03-PLAN.md: Wave 1. Shipped local catalogue and local passport rows (hashes fetched at execution), served ids
- [ ] 32.2-04-PLAN.md: Wave 1. Local model state machine, job rules, record specs, page protocol
- [ ] 32.2-05-PLAN.md: Wave 2. Download engine: allowlist with redirect checks, disk check, streaming hash, range reads
- [ ] 32.2-06-PLAN.md: Wave 2. Optional `listModels`, list-only adapters, finding servers (after 32.1-04)
- [ ] 32.2-07-PLAN.md: Wave 2. Tool-calling and embedding tests, benchmark (after 32.1-04)
- [ ] 32.2-08-PLAN.md: Wave 2. Records through the 32.1 audit log (after 32.1-07)
- [ ] 32.2-09-PLAN.md: Wave 2. Optional model signature check (after 32.1-10)
- [ ] 32.2-10-PLAN.md: Wave 3. Install, update, remove; Ollama blob push with digest check; llama.cpp models folder
- [ ] 32.2-11-PLAN.md: Wave 3. Models by job service and recommendations
- [ ] 32.2-12-PLAN.md: Wave 4. Manager service, view model, estimates
- [ ] 32.2-13-PLAN.md: Wave 5. Local AI feeds the guide's viability; Get Started step
- [ ] 32.2-14-PLAN.md: Wave 5. The Local models page (after 32.1-08)
- [ ] 32.2-15-PLAN.md: Wave 6. Command, wiring, model picker link (after 32.1-17, 32.1-18, 32.1-20)
- [ ] 32.2-16-PLAN.md: Wave 6. SECURITY.md, README, CHANGELOG, docs site (after 32.1-19)
- [ ] 32.2-17-PLAN.md: Wave 7. Close-out: end-to-end scenario, full suite once, UAT and verification (after 32.1-20)

### Cohere Model Vault: a third inference endpoint (Phases 36 and 37, added 2026-11-20)

Design: `.planning/research/cohere-model-vault/DESIGN.md`. Owner decisions of 2026-11-20 ("go with your recommendations"): Cohere Model Vault becomes a third provider beside NEAR AI and local, and project setup offers any combination; an Encrypted vault counts as attested only while Cohere's pinned proxy and the extension's own check both pass; a Standard vault is its own class, "sovereign region, not attested", never counted as private hardware; no vault receives Protected B without a signed authorization in your organization's policy (assessment reference, named person, expiry), and classified content never goes to a vault; cost control is manual until Cohere publishes a lifecycle API. Both phases ship in the 0.4.x line after Phase 32: they need only the Phase 70 gate on `main`, so they do not wait for Phases 71 to 74; Phase 74.1 enforces the vault model passports when it lands and Phase 74.2 reuses Phase 37's transport and verdict shapes. Phase 36 may run beside Phases 33 to 35 (different files). Requirement ids CVLT-01 to CVLT-11 are defined in the design (section 14) and are added to REQUIREMENTS.md when Phase 36 is planned. Open owner decisions D1 to D6 are in the design (section 15), each with a default.

### Phase 36: Cohere Model Vault provider, sovereign-region class and cost control
**Goal**: Your organization can add Cohere vaults beside NEAR AI and local, each request goes only where the label, use tier and policy allow, a Standard vault is never treated as private hardware, Protected B reaches a vault only with a recorded authorization, and vault running costs are visible and limited.
**Depends on**: Phase 32 (build order, owner 2026-11-20); Phase 70 (the bundle, labels, routing, trust badge). Phase 74.1 not required: its passport check covers vault models when it lands. Phase 32.1: vaults are offered as guide options (Standard, Encrypted) through its option registry, and the vault readiness check is their viability check (`.planning/research/guided-onboarding/DESIGN.md`, section 12). Phase 41: vaults are `endpoints[]` entries, Protected B authorizations are `authorizations[]` records, the client is a `ModelEndpoint` adapter, and the trust line replaces a fourth badge state (coherence review 2026-11-20).
**Requirements**: CVLT-01, CVLT-02, CVLT-03, CVLT-04, CVLT-05, CVLT-06, CVLT-07
**Success Criteria** (what must be TRUE):
  1. A person ticks NEAR AI, local and a Canadian Standard vault in setup and adds the key once; a chat at `org/Public` or `org/Internal` can use a model on the vault, while a label outside the vault's signed ceiling is refused for it with a plain sentence and nothing is sent. (CVLT-01, CVLT-02, CVLT-03)
  2. A Standard vault answer is never shown as private, `tee-only` blocks it, and a bundle that lists Protected C, `org/Restricted`, any classified level or NATO Restricted and above for a vault is refused as a whole. (CVLT-03, CVLT-05)
  3. Protected B content is refused for every vault without an authorization, allowed with a valid signed one in scope, refused again after it expires, and the route record and trust badge name the authorization. (CVLT-04)
  4. A paused vault gives the not-ready card before a run starts, with Open vault page and Check again; the idle warning appears after the set time; estimated vault hours appear in the spend view, count toward the daily and per-run limits, and stopping at the limit says that it does not stop the hourly charge. No undocumented endpoint is called. (CVLT-06, CVLT-07)
  5. Existing NEAR, local and hybrid profiles and discovery answers work unchanged; SECURITY.md and README describe vaults, the two classes and the Protected B rule.
**Research flags**: (1) Open owner decisions D1 (a fourth badge state), D2 (Standard vault default ceiling), D3 (auto-pause later). (2) Questions for Cohere C1 to C3, C6, C9 to C12: lifecycle API, paused responses and billing, streaming and tool calling, CCCS Medium assessment, the region's cloud and facilities.
**Undo cost**: Medium: a new optional bundle key and authorization records are signed into policies, so settle the schema in WP-0.
**Plans:** 0 plans
**UI hint**: yes

Plans:
- [ ] TBD (run /gsd-plan-phase 36 to break down)

### Phase 37: Cohere Encrypted Vault as an attested endpoint
**Goal**: An Encrypted vault counts as attested private hardware only while Cohere's proxy and this extension's own check both prove it, and nothing is sent when they do not.
**Depends on**: Phase 36 (and through it Phase 41).
**Requirements**: CVLT-08, CVLT-09, CVLT-10, CVLT-11
**Success Criteria** (what must be TRUE):
  1. With Docker or Podman present, setup starts Cohere's proxy from the digest pinned in the signed policy on a random loopback port, the readiness check proves the attestation, and an `org/Internal` chat is answered with the verified private badge and the vault sentence. (CVLT-08, CVLT-10, CVLT-11)
  2. A different image digest, a port held by another process, a refused proxy connection, an expired or wrongly signed attestation token, an empty policy match, or an Integritee policy release whose Sigstore bundle does not verify each refuse before sending, and the rule is recorded; nothing ever falls back to the plain vault endpoint or another endpoint. (CVLT-08, CVLT-09, CVLT-10)
  3. Without a container runtime the Encrypted vault is shown as unavailable on that machine with the reason, and no request reaches its endpoint. (CVLT-08)
  4. Protected B to an Encrypted vault is refused without an authorization even when attested; route records carry platform, policy release, token hash and proxy image digest. (CVLT-10, CVLT-11)
**Research flags**: (1) Encrypted vaults run only in the US today (Canada and the EU "coming soon"). (2) Questions for Cohere C4, C5, C7, C8: Canada date, Command in Encrypted, attestation without the proxy and the SEV-SNP token format, the proxy's source and signatures. (3) Open owner decisions D4 (shared proxy) and D5 (SEV-SNP proxy-only). (4) Revisit a Node-only verifier when Cohere publishes the protocol or a supported JavaScript client.
**Undo cost**: Low to medium: a transport behind one interface and an optional `attestation` object in a vault entry.
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 37 to break down)

### Portfolio view: mixed organizations rolled up for prioritization and resource allocation (Phases 38 to 40, added 2026-11-20)

Design: `.planning/research/portfolio-and-assignment/DESIGN.md`, Part C (section 6) and 10.4. Owner request of 2026-11-20: a whole defence portfolio mixes units of different modes (commands, public service branches, capital project offices, software cells); each keeps its own mode, words and joining rules, and everything rolls up into one strategic portfolio view for prioritization and resource allocation, as decision support where people decide and agents draft. Units release signed, labelled publications into the portfolio's write-only intake cells; the portfolio never receives units' cells; each view is labelled at the join of its inputs, raised by signed aggregation rules, and a viewer below it sees only views within their clearance and learns nothing about the rest. These phases ship in the 0.4.x line after drop B, on fictional data and one hub. Later stages are lines in Phase 97 (views), Phase 100 (feeds), Phase 71 (verified publishers) and L5 (cross-hub relay); real data waits for Phase 71, the Stage 1 gate and an accredited host. Requirement ids PORT-01 to PORT-12 are defined in the design and added to REQUIREMENTS.md when Phase 38 is planned.

### Phase 38: Organization tree, publications and label-safe roll-up
**Goal**: Units of different modes agree to report to a portfolio and release signed, labelled publications into write-only intake cells, and the portfolio folds them into views whose label covers the whole under signed aggregation rules.
**Depends on**: Phases 34 and 35 (drop B: hub changes and bundle transport); Phase 33.1 (supply from positions); Phase 41 (modes, the label module; it builds the one aggregation evaluator that Phase 93 extends); Phase 70 (labels).
**Requirements**: PORT-01, PORT-02, PORT-03, PORT-04, PORT-05, PORT-06
**Success Criteria** (what must be TRUE):
  1. A Military-mode unit and a Public service unit each publish status, risks and supply counts, and neither can read the other's publications or the portfolio's (byte capture on the hub). (PORT-01, PORT-02, PORT-03)
  2. Many Protected B items across three units raise the combined view under the default aggregation rule; a Protected B viewer is offered only narrowed, suppressed or coarsened views, each labelled, and "Why this label" names the rule. (PORT-05, PORT-06)
  3. A viewer below a unit's label sees identical screens whether or not that unit exists; a missing publication shows as withheld to cleared viewers only. (PORT-03, PORT-06)
  4. Publications move between two hubs by sealed bundle file and fold to the same digest. (PORT-03)
**Research flags**: (1) Treasury Board clause-level detail (gating, approval limits, independent review) confirmed by a person, since automated reading was refused. (2) Default aggregation rules set with your organization's security officer. (3) Open owner decisions D6 to D8 in the design.
**Undo cost**: Medium to high: publication and agreement formats travel between organizations, so settle them in the first plan.
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 38 to break down)

### Phase 39: Portfolio Room, prioritization and scenarios
**Goal**: The portfolio office sets weighted criteria, people score with agent-drafted evidence, and scenarios with the efficient frontier are compared and decided by named people.
**Depends on**: Phase 38.
**Requirements**: PORT-07, PORT-08, PORT-09
**Success Criteria** (what must be TRUE):
  1. A criteria set whose weights do not sum to 100 or with a criterion without anchors is held; an agent score without a publication citation is refused; scorers differing by more than one anchor level need a reconciliation note. (PORT-08)
  2. The constrained frontier for a fictional 120-project portfolio matches a brute-force reference on small cases and otherwise completes or says "best found, not proven optimal". (PORT-09)
  3. Two board members deciding one scenario version differently at once make it contested; the approved scenario produces downward priority publications released by a person; no agent can reach these acts. (PORT-07, PORT-09)
**Plans:** 0 plans
**UI hint**: yes

Plans:
- [ ] TBD (run /gsd-plan-phase 39 to break down)

### Phase 40: Capacity, allocation, dependencies and gates
**Goal**: Demand and supply across units are matched by skill, clearance and period, reallocations become taskings each unit fills in its own mode, and cross-unit dependencies and gate calendars show what will slip.
**Depends on**: Phase 38 (and Phase 39 for decisions).
**Requirements**: PORT-10, PORT-11, PORT-12
**Success Criteria** (what must be TRUE):
  1. A Secret demand is never matched by Protected B supply; an approved reallocation reaches a unit as a tasking, its tasker posts two people, and the next supply publication shows the change. (PORT-10)
  2. A viewer who cannot see an upstream milestone sees their own item at risk only through its own published forecast, with no hint of the hidden edge. (PORT-11)
  3. A fictional project rated above its unit's capacity class is flagged for higher approval from profile thresholds, with no threshold in code. (PORT-12)
**Plans:** 0 plans
**UI hint**: yes

Plans:
- [ ] TBD (run /gsd-plan-phase 40 to break down)

### Capital projects on the staff method (Phases 42 and 43, added 2026-11-20)

Design: `.planning/research/capital-projects/DESIGN.md` (PR #110), placed by the coherence review (`.planning/research/coherence/REVIEW.md`, section 9 and conflict K26). The method core (WP-P0) is built on the replica layer (a pack is a set of stream kinds and fold rules), not on the single-chain ledger the multi-user work replaces; the capital Portfolio Room is the portfolio view's capital tab. Fictional data only until the Stage 1 gate and an accredited host; live feeds stay with Phase 100.

### Phase 42: Capital project offices on the replica (capital drop 1)
**Goal**: A capital project office and a small-project team work an equipment project through its phases and gates on the staff method, with every figure traced to a calculator record and every gate decided by a named person.
**Depends on**: Phase 33.1 (positions and handover); Phase 41 (the `directives.capital` section, `term()` and the Capital projects mode); Phases 30 to 33 (the replica layer).
**Requirements**: to be defined from the capital design (sections 2 to 7 and 10) when Phase 42 is planned.
**Plans:** 0 plans
**UI hint**: yes

Plans:
- [ ] TBD (run /gsd-plan-phase 42 to break down)

### Phase 43: Programme and portfolio offices, the capital tab (capital drop 2)
**Goal**: Programme and portfolio offices run on the same method, and the Portfolio Room shows capital projects in its capital tab, with file-import feeds.
**Depends on**: Phase 42; Phase 39 (the Portfolio Room).
**Requirements**: to be defined from the capital design (sections 5.4, 5.5, 8 and 9) when Phase 43 is planned.
**Plans:** 0 plans
**UI hint**: yes

Plans:
- [ ] TBD (run /gsd-plan-phase 43 to break down)

### Security accreditation: evidence and a compliance dashboard (Phase 44, added 2026-11-20)

Design: `.planning/research/compliance-dashboard/DESIGN.md`. Accreditation (security assessment and authorization) is your organization's decision for the system it deploys; the product supplies the control text per level (ITSP.10.033 and its Medium profile ITSP.10.033-01, which replaced ITSG-33 Annexes 3A and 4A Profile 1 in 2026), its implementation statements, a responsibility matrix, automatic evidence and an honest gap list, all generated from one OSCAL source. Planned, not planned in detail.

### Phase 44: Accreditation evidence and compliance dashboard
**Goal**: Anyone preparing a security assessment of a system that uses this product can see, per level (Unclassified, Protected A, Protected B, later Classified on the appliance), the exact controls, what the product does for each with live evidence from CI, what your organization must do, and every gap with its remediation and owner, and can download each release's documentation package in OSCAL and readable form.
**Depends on**: Nothing in flight (reads the docs site from PR #141 and CI as they are). Runs in parallel with Phases 30 to 43 and the patch line: it touches `compliance/` (new), `docs-site/`, `scripts/` and `.github/workflows/` (gate files, owner approval), never `src/` or `media/`. Later picks up the Phase 41 audit chain and Phase 75 relay authentication as evidence.
**Requirements**: ACCR-01 to ACCR-14 (defined in the design, section 18; ACCR-13 and ACCR-14, the Controlled Goods Program and ITAR overlays, added 2026-11-20 from `CGP-ITAR.md`; added to REQUIREMENTS.md when Phase 44 is planned)
**Success Criteria** (what must be TRUE):
  1. The Protected B page lists every ITSP.10.033-01 control with its state; each control shows the attributed official text, our statement, the responsibility, the evidence with its CI run and time, and for a gap the remediation, owner and phase. (ACCR-01, ACCR-03, ACCR-07, ACCR-08)
  2. Deleting or skipping a test that a Met control relies on turns it Not met in the same PR's summary; a lapsed daily audit turns its controls Stale. (ACCR-04, ACCR-05, ACCR-06, ACCR-10)
  3. A control with a statement but no evidence is never Met, and no source file can set a status. (ACCR-06)
  4. A release's package validates with `oscal-cli`, imports into Compliance Trestle, verifies against its checksums and attestation, and holds no secrets, prompt content or organization data. (ACCR-09, ACCR-11)
  5. A change to an official source page is reported within a week; the importer lists every difference from the unofficial conversions. (ACCR-02)
  6. The incident response plan, supported-versions table, threat model and data-flow diagrams exist with review dates; the relay image is scanned and has an SBOM; releases carry attestations; CODEOWNERS covers gate paths; `docs` is a required check. (ACCR-12)
**Research flags**: Treasury Board Directive on Security Management Appendix B clauses; whether the Cyber Centre will publish a machine-readable catalogue; the Unclassified reference set (CAN/DGSI 104 versus CPCSC Level 1); ITSP.40.111 status of Ed25519 and scrypt; which repository settings a read-only token can read.
**Plans:** 18/19 plans executed in 6 waves (planned 2026-11-21; decisions D-01 to D-50 in `44-CONTEXT.md`, owner confirmations listed there; the catalogue data lands first in its own data PR (44-16, D-42) and every workflow change last (44-19, D-33); owner checkpoints in 44-06, 44-09, 44-16 and 44-19)
**UI hint**: yes (docs site pages only; no extension UI)

Plans:
- [x] 44-01-PLAN.md: Wave 1. Package skeleton and the tracer: a fixture control from catalogue through a statement, an evidence rule and a per-test report row to a computed state in the dashboard JSON; vendored OSCAL schema; no status in any source; VSIX exclusions
- [x] 44-02-PLAN.md: Wave 1. Per-test report from the runner, secret scan of a folder with a JSON summary, compliance trust roots as gate paths
- [x] 44-03-PLAN.md: Wave 1. Incident response plan, supported versions, threat model, data-flow diagrams, crypto inventory, Controlled goods and ITAR guidance page; the gap register and POA&M items
- [x] 44-04-PLAN.md: Wave 2. Status engine: six states, tailoring, known limitations, unsettled and self-signed rows, signed expiring risk acceptances, gap states
- [x] 44-05-PLAN.md: Wave 2. Dashboard contract and view library, organization overlay merged in memory, components loader and responsibility, output word lint with Phase 41 parity
- [x] 44-06-PLAN.md: Wave 2. Importer foundation: source registry, licence gate, polite fetch, Cyber Centre page helpers, normalized page hash and weekly watch (owner checks parse5 and yaml)
- [x] 44-07-PLAN.md: Wave 2. Collectors in the run: mapped tests with every reason, CI checks, secret scan, required documents, crypto inventory
- [x] 44-08-PLAN.md: Wave 2. Collectors for the supply chain and GitHub: audits, SBOMs and the relay image scan, release integrity, attestations, settings, review trail, code scanning
- [x] 44-09-PLAN.md: Wave 2. CI tool pins for oscal-cli, Syft, Grype and Compliance Trestle (owner checks them before they run)
- [x] 44-10-PLAN.md: Wave 3. ITSP.10.033 catalogue importer, English and French
- [x] 44-11-PLAN.md: Wave 3. ITSP.10.033-01 Medium profile with its English and French differences, the Protected A profile, the NIST base catalogue and the cross-check
- [x] 44-12-PLAN.md: Wave 3. ITSP.10.171 and -01, baseline controls with the Unclassified and CPCSC Level 1 profiles, ITSG-33 Profile 3 and our Annex 3A crosswalk
- [x] 44-13-PLAN.md: Wave 3. Controlled Goods and ITAR requirement catalogues, our mappings with unsettled and official-signature rows, overlay profiles
- [x] 44-14-PLAN.md: Wave 3. Evidence bundle with manifest and redaction, and the full dashboard generator
- [x] 44-15-PLAN.md: Wave 3. The Accreditation section of the docs site, compliance:refresh, the loopback overlay view and the refresh timer
- [x] 44-16-PLAN.md: Wave 4. Catalogue data in its own PR after the licence re-check and the owner's review
- [x] 44-17-PLAN.md: Wave 4. Release documentation package and the pull request summary
- [x] 44-18-PLAN.md: Wave 5. Component definitions, statements, evidence rules and overlay statements on the real catalogues
- [ ] 44-19-PLAN.md: Wave 6. Workflows and gates: compliance and relay image jobs, scheduled evidence, CodeQL, release package and attestations, CODEOWNERS, the owner's steps

### Phase 44.1: Accreditation control implementation and evidence closure

**Goal**: Verify and close product control and evidence gaps for Unclassified and Protected A first. Extend the assessment to Protected B, the Classified appliance baseline, and applicable ITSP.10.171, CPCSC Level 1, Controlled Goods, and ITAR overlays as their prerequisites and deployment scope become available.

**Depends on**: Phase 44's dashboard, evidence rules and plan of action and milestones (POA&M). Work can proceed alongside other phases and does not gate general development or releases.

**Baseline for triage**: The published v0.4.36 snapshot shows 521 product rows with no implementation statement or linked gap across Unclassified (3), Protected A (259), and Protected B (259). These represent 259 distinct published control IDs. Verify the responsible component and existing implementation before assigning remediation. Track any evidence gap separately from confirmed missing implementation. The 179 Classified reference rows relate to the appliance scope.

**Success Criteria** (what must be TRUE):

1. Each applicable control has a responsible owner and a verifiable disposition. The POA&M distinguishes missing implementation, missing evidence, inherited or sponsor responsibilities, and reviewed exclusions. Every open action links to a delivery phase or a sponsor assessment action.
2. Product-owned gaps close when the implementation works in the stated release and scope and the assessor can inspect dated evidence such as a screenshot, reproducible test result, configuration snapshot, or audit record.
3. The export reports product evidence separately from inherited and sponsor evidence, and shows pending items until verified. Draft sponsor responses identify evidence to collect and decisions to confirm. Sensitive artifacts remain in the authorized assessor location.
4. Assess Unclassified and Protected A first. Review Protected B, the Classified appliance, and each applicable overlay when scope is established. Authorization remains with the responsible organization.
5. The submission review confirms that the report's applicable sponsor and deployment fields contain verified entries, with a rationale and authority for each exclusion. Its diagrams reflect the assessed deployment's components, trust boundaries, data flows, and operating dependencies. The submission includes the linked evidence, completed applicable forms, sponsor concurrence, independent assessor findings, and the authorized decision or the sponsor's confirmed submission route and outstanding decision step. Generated draft text and unfilled fields remain tracked until the sponsor or assessor supplies the required information.

**Requirements**: COVR-01 to COVR-05 (coverage amendment, 2026-11-25); extends ACCR-03, ACCR-04, ACCR-06, ACCR-07 and ACCR-10.

**Coverage amendment (2026-11-25, owner brief):** the dashboard at 32007751 has 12,242 component cells reading "No statement yet", because every component is assessed against every control. The amendment adds a reviewed per-component applicability map (a component with no part shows "Not applicable to this component" with its reason; estimated about 8,016 cells, two thirds), statements and evidence for every applicable pair (about 1,787 pairs, of which about 275 are generated from the inventory), a rule that a statement needs evidence a CI job reports, and a coverage ratchet in the required `docs` job. Order: Unclassified and Protected A, then Protected B, then the appliance and the overlays. Decisions in `44.1-CONTEXT.md`, measurement and estimate in `44.1-RESEARCH.md`, cross-phase pairs in `44.1-HANDOFFS.md`.

**Plans:** 24 plans: the first 4 as planned, then the coverage amendment's 20 plans in 8 waves (05, then 06 and 08, then 07, then 09, then 10 to 21 in parallel, then 22, 23 and 24).

- [x] 44.1-01-PLAN.md: Verify evidence reaches the local assessor package and map existing audit and incident practices with their documented limits. Check the published bundle after the reviewed release.
- [ ] 44.1-02-PLAN.md: Triage and close Unclassified and Protected A implementation and evidence gaps by control owner (amended: triage over applicable cells once 44.1-07 lands).
- [ ] 44.1-03-PLAN.md: Review Protected B, the Classified appliance and applicable overlays after their prerequisites and scope decisions (amended: product steps in 44.1-23 and 44.1-24).
- [ ] 44.1-04-PLAN.md: Populate and verify the deployment submission, diagrams, forms and approval records.
- [x] 44.1-05-PLAN.md: Tracer: one component's "Not applicable to this component" with its reason, from a signed rule to the real hosted level.
- [x] 44.1-06-PLAN.md: The full applicability rules from the catalogue, the generated map and its drift check, and your organization's stage 1 review.
- [ ] 44.1-07-PLAN.md: The coverage measure and ratchet in the required docs job, the stage 1 sign-off, and the machinery gate.
- [x] 44.1-08-PLAN.md: A statement needs evidence a CI job reports; the review files are gate paths; the drawer and SSP show each component's reason.
- [ ] 44.1-09-PLAN.md: Supply-chain and inventory statements for every component, generated from the inventory with each component's evidence.
- [ ] 44.1-10-PLAN.md: Extension statements and evidence.
- [ ] 44.1-11-PLAN.md: Hub statements and evidence.
- [ ] 44.1-12-PLAN.md: Release pipeline (the supplier's process) statements and evidence.
- [ ] 44.1-13-PLAN.md: Model endpoints and relay statements and evidence, with links for the relay's unbuilt messaging.
- [ ] 44.1-14-PLAN.md: Workbench statements and evidence.
- [ ] 44.1-15-PLAN.md: Keycloak statements and evidence.
- [ ] 44.1-16-PLAN.md: oauth2-proxy and Theia Cloud statements and evidence.
- [ ] 44.1-17-PLAN.md: OpenBao and HSM statements and evidence.
- [ ] 44.1-18-PLAN.md: RKE2 and cert-manager statements and evidence.
- [ ] 44.1-19-PLAN.md: Ingress and image registry statements and evidence.
- [ ] 44.1-20-PLAN.md: Offline bundle statements and evidence.
- [ ] 44.1-21-PLAN.md: Site logging and site storage statements and evidence.
- [ ] 44.1-22-PLAN.md: Integration: held rows, new gaps, the full suite once, the measured coverage and both statement gates.
- [ ] 44.1-23-PLAN.md: Protected B: statements checked against its expectations and the stage 2 sign-off.
- [ ] 44.1-24-PLAN.md: The appliance and the overlays in the map, after 44.1-03's scope decision, and the stage 3 sign-off.

### Export-controlled technical data: Controlled Goods Program and ITAR (Phase 45, added 2026-11-20)

Design: `.planning/research/compliance-dashboard/CGP-ITAR.md`. Owner request of 2026-11-20: "also consider what we need to show compliance for the Controlled Goods Program and ITAR." Meeting either regime is your organization's obligation, confirmed by its counsel, designated official and empowered official; the product provides controls and evidence. Sending controlled technical data to an AI model is a transfer to whoever runs it (Defence Production Act s. 37(3); 22 CFR 120.50, 120.56), and the ITAR encryption carve-out (120.54(a)(5)) covers storage and transmission, not a model reading the data. So controlled content stays on this computer or goes only to endpoints your organization's officials have approved by a signed decision. Planned, not planned in detail.

### Phase 45: Export-controlled technical data: markings, eligibility, routing and records
**Goal**: Content marked Controlled goods (Canada), ITAR or US export-controlled (EAR) reaches only people and AI services your organization's designated official or empowered official has approved; every send, share, refusal and lowering is recorded, kept and exportable for them; and a possible release opens an incident with the regulators' clocks shown.
**Depends on**: Phase 41 (the `exportControl` section, the two authorization kinds, `decideRoute`, the audit chain, the policy editor); Phase 32.1's question registry for the setup questions; Phase 33.1 (positions) for the officials in shared projects. Runs beside Phases 32.2 to 37 (different files) except the setup question file. Hub, data platform and relay checks are one requirement line each in their own phases; Phase 71 later issues person decisions as credentials; Phase 72 adds the network fence.
**Requirements**: EXPC-01 to EXPC-10 (to be defined from the design, sections 6 to 9 and 11, when Phase 45 is planned)
**Success Criteria** (what must be TRUE):
  1. A file marked ITAR is never sent to NEAR AI Cloud, a Cohere vault or an unapproved organization server; the person sees a plain sentence and who to ask, and a `route.export-control` record exists. A local model still answers.
  2. Only a signed `export-person` decision from the regime's official gives a person a reserved compartment; a self-declared clearance never does; an expired decision rekeys the person's controlled key groups.
  3. While a chat holds a reserved compartment, agent tools that reach the network are refused and local file tools still work.
  4. Marking a file controlled after it was sent to an ineligible service opens an incident that shows the Controlled Goods Regulations' three-day rule and the ITAR disclosure timing, notifies the export-control contact, and closes only with a signed step.
  5. Export-control records are tamper-evident, never pruned automatically, show their earliest permitted pruning date, and export as a signed bundle readable on paper.
  6. Setup asks about technical data for military or defence goods in plain words, "Not sure" applies both markings, and the guide stops for an unregistered organization.
**Research flags**: BIS cloud computing advisory opinions; any DDTC or PSPC statement on AI services; the Export Control List Group 2 guide for legend rules; a FIPS 140-3 validated provider for the hub's runtime.
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 45 to break down)

### Phase 45.1: NATO and Five Eyes exchange, part 1: labels, binding, adapter and base TDF (INSERTED)
**Goal**: Your organization can send released work to allies and receive theirs at the release boundary, with labels a NATO system can read, bound to their content by a signature; nothing leaves without the same credential check as any release, and nothing received reaches work until a person accepts it. Our own cells stay the storage format.
**Inserted**: 2026-11-24 from the owner's decision O1 and NATO direction ("ensure NATO interoperability as soon as practicable with the ZTDF adapter if that's the best option"), `.planning/research/data-centric-access/RESEARCH.md` sections 2.2, 2.4 and 11 (research row I). Part 2 is Phase 45.2.
**Depends on**: Phase 71 (core): 71-03 (the profile signer), 71-06 (`agreements@1`), 71-07 (`mayRelease`); Phase 33.1-21 (the release act) for 45.1-04. Phase 45 only for export-controlled content, which is refused until Phase 45 ships. L5 is not needed for file exchange. Runs beside Phase 33.1's later waves.
**Requirements**: XCHG-01, XCHG-02, XCHG-03, XCHG-04
**Success Criteria** (what must be TRUE):
  1. Your organization's signed policy maps each label to a NATO-readable form (STANAG 4774 categories) that its security officer confirms; a label with no mapping is refused for export; mapping out and back gives the same label. (XCHG-01)
  2. Every release copy and every export carries a signed label binding (4778-style) over the label, the mapping version and the content hash, signed by a staff session key or your organization's release key and never naming a person, and a changed label or content is refused. (XCHG-02)
  3. A release authority exports a released version to a partner through the same `mayRelease` check as any release, against the partner's agreement, after a passkey step-up, and the export is recorded; a received object is verified, mapped and held until a person accepts it. (XCHG-03)
  4. Base TDF objects from the public OpenTDF specification go out to a partner's key and come in through our own non-exportable receiving key in OpenBao. (XCHG-04)
**Research flags**: (1) Never design the ZTDF half from vendor descriptions (research pitfall 13). (2) Not a cross-domain guard and not accreditation (pitfall 14). (3) The OAEP hash partners accept (45.1-02).
**Undo cost**: Medium. The label table is policy data; the exchange records are permanent in shared logs (settled at 45.1-03's checkpoint).
**Plans:** 5 plans in 5 waves (planned 2026-11-24 on `docs/phase-71-core-plan`; decisions D-01 to D-10 and four owner items in `45.1-CONTEXT.md`)
**UI hint**: yes

Plans:
- [ ] 45.1-01-PLAN.md: Wave 1. Tracer: the `labelInterop` table (feature `label-interop@1`) and the signed label binding
- [ ] 45.1-02-PLAN.md: Wave 2. Base TDF from the public OpenTDF specification; partner key access; our receiving key in OpenBao
- [ ] 45.1-03-PLAN.md: Wave 3. The exchange adapter at the release boundary, with the exchange record shapes checkpoint
- [ ] 45.1-04-PLAN.md: Wave 4. The binding on every release copy; Export for a partner and Received objects in the workbench
- [ ] 45.1-05-PLAN.md: Wave 5. SECURITY.md, the full suites once, the verification record, the integration PR after the owner's gate approval

### Phase 45.2: NATO and Five Eyes exchange, part 2: ZTDF and the NATO texts (INSERTED)
**Goal**: Your organization's exports to allies carry labels, a binding and core metadata exactly as ADatP-4774, 4778, 4778.2 and 5636 define them, in the label policy of the information's owner with the provenance of every value shown, conformant to the principles of the AC322 Data Centric Reference Architecture, inside a ZTDF-compatible object built on the public OpenTDF specification whose key access reaches a partner's key access server; partners' objects in those forms are read, checked and held until a person accepts them, and partners' files in formats that are not ZTDF are accepted into quarantine, kept as our protected cell plus a ZTDF-compatible form where conversion is possible, and never trusted beyond what their source proves. ZTDF conformance stays unverified until ACP-240(A) or a partner's KAS with its own samples is available.
**Inserted**: 2026-11-24 as a stub (research row J); planned 2026-11-24 on `docs/phase-45.2-plan` from the texts the owner provided: AC/322-D(2025)0056 (DCRA v2, used for its principles and not in place of ACP-240(A), which defines ZTDF and is not held), ADatP-4774, ADatP-4778, ADatP-4778.2, ADatP-5636 and 5636.1 (local, gitignored, cited by section only), and the public OpenTDF specification 4.3.0 as the base for a ZTDF-compatible profile; label values not yet verified are drafted as tracked assumptions with provenance (owner, 2026-11-24). Owner defaults confirmed 2026-11-24.
**Depends on**: Phase 45.1 (45.1-01 for 45.2-01, 45.1-02 for 45.2-05, 45.1-03 for 45.2-06 and 45.2-13, 45.1-04 for 45.2-07, 45.1-05 for 45.2-08); Phase 70.1's 70.1-01 on main before wave 6 (45.2-16 reuses its marking reader) and, through it, Phase 71 (core); 46-07 for the workbench tasks; PR #191 (gap register fields) for 45.2-08 and 45.2-11. ACP-240(A), verified label policies and partner samples are not prerequisites: each is swapped in by a gap-closure plan when it arrives (`45.2-RESEARCH.md` section 10).
**Requirements**: XCHG-05, XCHG-06, XCHG-07, XCHG-08, XCHG-09
**Success Criteria** (what must be TRUE):
  1. Every export carries an ADatP-4774 originator label in the information owner's policy and an alternative label in the common partner policy, written from label policy profiles your security officer adopted, each value showing its provenance; an operational export that would use an assumed value is refused unless your security officer records an exception; a partner's labels are mapped in and joined, never lowered, and an unmappable label is refused. (XCHG-05)
  2. Every export carries an ADatP-4778 binding object with the seven ADatP-5636 mandatory metadata elements, signed by your organization's release key to the ADatP-4778.2 cryptographic artefact profile; partner binding objects and sidecar files are read in every form the texts allow, and a changed label, metadata entry or payload is refused. (XCHG-06)
  3. A ZTDF-compatible object on OpenTDF 4.3.0 carries the label and the binding as signed assertions, with every point where ZTDF may differ behind one profile; key access reaches partner key access servers listed and pinned in the signed policy, both ways; classical key access is capped at Protected B or its equivalent, recorded, and refused from 2036. (XCHG-07)
  4. An AC322 conformance matrix cites a passing test for every claim; control statements and the hosted registers carry evidence; our XML is checked against the texts' own schemas; a development round trip runs against the OpenTDF quickstart's KAS, and an acceptance trial with an ally's or vendor's KAS and its own samples is the acceptance check. (XCHG-08)
  5. Partners' files in formats that are not ZTDF (OpenTDF and TDF3 objects, binding objects and sidecars, labelled Office documents, marked and unlabelled files) arrive in quarantine through one adapter per format, are kept as our protected cell plus a ZTDF-compatible form where conversion is possible, with what was lost or assumed recorded, are never shown or kept as more trusted than their source proves, and become work only through an exchange officer's label, which never lowers the sender's; no key is ever unwrapped with RSA-OAEP SHA-1. (XCHG-09)
**Research flags**: (1) AC322 is an architecture blueprint, not a ZTDF specification; never cite it for ZTDF. (2) No text, schema or example from an ADatP enters the repository; NATO values appear only in the NATO profile file and its test. (3) Signed bindings follow ADatP-4778.2 but are not yet checked with a partner (G384). (4) Not a cross-domain guard. (5) Partners have no post-quantum key access type (G356). (6) The texts' printed examples contain errata (research section 8). (7) The Canadian label policy is assumed and has no OID (G355). (8) ITSP.40.111 v5 does not recommend SHA-1, so stock OpenTDF senders' OAEP SHA-1 keys open only through their own key server (G455), and 2048-bit partner RSA keys end with 2030 (G502). (9) Labelled mail and chat are a NATO form but not built here (G503).
**Undo cost**: Medium. The label tables, profiles and partner pins are policy data; the exchange record values are permanent (settled at 45.2-13's checkpoint, which replaced 45.2-07's); the ZTDF profile is swappable by design; the inbound adapters are added and removed in one registry.
**Plans:** 17 plans in 10 waves (planned 2026-11-24 on `docs/phase-45.2-plan`; decisions D-01 to D-23, all owner defaults confirmed 2026-11-24, owner actions and a hand-off ledger in `45.2-CONTEXT.md`; amended 2026-11-25 on `docs/phase-45.2-inbound-adapters` with inbound format adapters, D-24 to D-35, seven defaults accepted by the owner 2026-11-25)
**UI hint**: yes

Plans:
- [ ] 45.2-01-PLAN.md: Wave 1. Tracer: our own narrow XML reader and writer (4778.2 normalization); one label out as ADatP-4774 and back
- [ ] 45.2-11-PLAN.md: Wave 1. Label policy profiles with provenance (NATO public-unverified, Canadian DND/CAF assumed), the operational rule, a gap row per unverified value
- [ ] 45.2-13-PLAN.md: Wave 1. Inbound adapter interface, the record values checkpoint, tracer: an unlabelled partner file held and labelled by a person; never more trusted, never lower
- [ ] 45.2-14-PLAN.md: Wave 1. One hardened archive reader for arrivals and the Office tools; the no-fetch rule for inbound adapters
- [ ] 45.2-02-PLAN.md: Wave 2. The `labelXml` table adopting the profiles, every 4774 structure from the text's examples, labels coming in
- [ ] 45.2-03-PLAN.md: Wave 2. ADatP-4778 binding objects with the ADatP-5636 mandatory metadata; sidecar files; every binding form read
- [ ] 45.2-04-PLAN.md: Wave 3. Signed bindings to the ADatP-4778.2 cryptographic artefact profile; the `release-p256-<site>` key and certificate; key inventory rows
- [ ] 45.2-05-PLAN.md: Wave 3. Part 2b: the ZTDF-compatible profile on OpenTDF 4.3.0, extending 45.1-02
- [ ] 45.2-06-PLAN.md: Wave 4. Key access to partner key access servers (push and pull); partners, trust anchors and profile overrides in `exchangePartners`; the classical-key cap
- [ ] 45.2-15-PLAN.md: Wave 5. Inbound OpenTDF and TDF3 objects (OAEP SHA-1 senders only through rewrap, per ITSP.40.111 v5), ZTDF-profile objects kept as received, the ZTDF-compatible stored form, G455
- [ ] 45.2-07-PLAN.md: Wave 6. NATO-format export recorded, the export dialog, the import dialog and the Received objects card with exchange-officer decisions
- [ ] 45.2-16-PLAN.md: Wave 6. Inbound binding objects (standalone, sidecar, embedded, in Office packages) and marked files; every adapter under fuzz
- [ ] 45.2-08-PLAN.md: Wave 7. AC322 conformance matrix, SECURITY.md, crypto inventory, data flow, control statements, G356 and G384, the exchange register rows
- [ ] 45.2-17-PLAN.md: Wave 7. Markings on PDF files read in the workbench backend with the PDF reader the image already ships
- [ ] 45.2-09-PLAN.md: Wave 8. Schema and copy checks against the texts, full suites once, the integration PR after the owner's gate approval
- [ ] 45.2-10-PLAN.md: Wave 9. Conformance harness (every arrival format too) and the development round trip against the OpenTDF quickstart's KAS (pinned, reviewed, registered first)
- [ ] 45.2-12-PLAN.md: Wave 10. Acceptance trial with an ally's or vendor's KAS and its own samples (waits for them)

### Phase 46: Native Theia foundation
**Goal**: The Sterling workbench becomes a real, tested Theia product: its extension lives in a workspace package with its own build, tests and CI job; native widgets call engine code through one backend service pattern; every secret a person saves is stored per person in your organization's OpenBao (or the OS keyring on a single machine) and survives restarts; long-term keys never enter the session; the session knows who signed in; nothing in the image calls out except to addresses your policy lists.
**Depends on**: the hosting design (`.planning/research/multiuser-hosting/DESIGN.md`, owner decisions D1 to D11, 2026-11-23); the Theia spike (`.planning/spikes/theia-team-studio/`, PR #162); the compliance fit check (`compliance/resources.json`, PR #164). Runs beside Phase 47 from day one.
**Requirements**: FND-T-01, FND-T-02, FND-T-03, FND-T-04, FND-T-05, FND-T-06, FND-T-07, FND-T-08, FND-T-09, FND-T-10 (from DESIGN.md section 8: P1, P2, P3, P4, P5, P8, P9, P11 and the image build of P10); VSAFE-03 (version safety, owner, 2026-11-24)
**Success Criteria** (what must be TRUE):
  1. The workbench builds, tests and runs from a workspace package in CI, in a browser test against the built container; nothing remains only under `.planning/spikes/`.
  2. A native widget calls engine code in the backend through one JSON-RPC service pattern, with the same refusals the extension host gives.
  3. A secret saved in the workbench survives a container restart, is readable only by that person, and is stored in OpenBao (or the OS keyring on a single machine); no secret is held only in memory.
  4. Signing with a person's long-term key happens inside OpenBao and is refused without a fresh hardware-key or passkey sign-in.
  5. The session knows the signed-in person from the forwarded sign-in token, and renews or ends with it.
  6. The image makes no outbound call (telemetry, update checks, Open VSX, public registries) except to addresses in your organization's policy; the image and the hub run one Node major; every resource it adds has a passing entry in `compliance/resources.json`.
**Plans:** 8/9 plans executed in 5 waves (planned 2026-11-23; requirements FND-T-01 to FND-T-10 and decisions D-01 to D-43 in `46-CONTEXT.md`; needs #165 and #166 merged first; 46-09 and 46 D-44 to 46 D-47 added 2026-11-24 for version safety, VSAFE-03). Waves 1 to 4 (46-01 to 46-08) complete 2026-11-24 on `feat/phase-46-wave-1`: the verification gaps closed (STERLING_MODEL_SERVERS as one JSON array on both sides, the activity tracker answered, the release image's browser egress proof), the Defence preview's Get Started, rail and work-area pages merged in with the work-area creation command ported into the extension, the activity tracker answered on the pod IP (47-15's lab), and main (#182 to #185) merged. 46-09 (wave 5) is not executed yet.

Plans:
- [x] 46-01-PLAN.md: Wave 1. Tracer and evidence gate: the spike becomes the `workbench/` package on a digest-pinned UBI 9 minimal base with Node 26, Get Started opens with its native addons; one JSON-RPC helper; Release workflow points at `workbench/Dockerfile`
- [x] 46-02-PLAN.md: Wave 2. Session identity: who signed in from the forwarded token and `THEIACLOUD_SESSION_USER`, OpenBao jwt login, renew and revoke, Retry on failure, step-up link
- [x] 46-03-PLAN.md: Wave 2. Air gap and image hardening: addresses only from configuration, a test that the image calls nothing else, one Node major
- [x] 46-04-PLAN.md: Wave 2. Compliance fit before use for the workbench packages and the VSIX boundary
- [x] 46-05-PLAN.md: Wave 2. Copy lint covers the workbench and accepts Sterling and SovAI; the two #162 command handlers report errors
- [x] 46-06-PLAN.md: Wave 2. Workbench CI job; the Release workflow adds the image SBOM, a scan, and key-mode cosign signing in `container-release`
- [x] 46-07-PLAN.md: Wave 3. Per-person secrets in OpenBao KV (or the OS keyring, never memory) and a `KeyService` on Transit with the step-up check; one person cannot read another's secrets
- [x] 46-08-PLAN.md: Wave 4. End-to-end browser proof against the built image with a real OpenBao (a secret survives a restart, person mismatch, no egress) and the contract Phase 47 consumes
- [ ] 46-09-PLAN.md: Wave 5. Sessions follow the site's version: the image's release facts, the signed release file in every release, the "new version is ready" notice, and the move at the next idle stop or sign-in with nothing unsaved (version safety, 32.1 D-66)

### Phase 47: On-premise deployment stack and offline bundle
**Goal**: Your organization can install and run the Sterling workbench for many people at a site it owns, connected or fully disconnected: RKE2, a local image registry, HAProxy ingress, cert-manager with an OpenBao CA, Keycloak with sign-in by passkeys or hardware keys only, self-hosted Theia Cloud (one session per person), OpenBao with HSM unseal, and the sync hub, all from a signed offline bundle with no outbound calls.
**Depends on**: the hosting design (DESIGN.md sections 4 to 7, 10, 11; decisions O2 to O6 accepted 2026-11-23); the compliance fit check (every component needs a passing entry); Phase 46's image only for the end-to-end run. Runs beside Phase 46 from day one.
**Requirements**: DEP-01 to DEP-13 (defined in `47-CONTEXT.md`, from DESIGN.md section 8's deployment work and section 11's Theia Cloud hardening list; DEP-13, guest accounts for outside observers, added 2026-11-24 by the owner for Phase 33.1 D-33); VSAFE-03 (version safety, owner, 2026-11-24)
**Success Criteria** (what must be TRUE):
  1. A site installs from one signed offline bundle (images, vendored charts, realm and policy as code) on air-gapped hardware, and nothing in the running stack calls out.
  2. A person signs in with a passkey or a hardware security key, as the site's policy sets, never a password; a lost key is replaced by administrator-attested re-enrolment; two keys are registered per person.
  3. Each person gets their own Theia session with a durable workspace volume; idle sessions stop; per-person secrets come from OpenBao, unsealed by an HSM (or Shamir where no HSM exists).
  4. Theia Cloud runs from images we rebuilt, signed and published with an SBOM, with the oauth2-proxy defaults fixed and the sign-in token forwarded to the session.
  5. HQ and an edge site trust each other through PKI and signed bundles only, with no shared database; the sync hub runs as a Kubernetes Deployment, several per site.
  6. Every component has a compliance fit entry and the key ceremony and recovery runbooks exist.
  7. (Added 2026-11-24, owner.) An outside observer signs in to a site with a guest account. It uses a passkey or hardware key only, is created at the lead's request (with the security contact's approval for allied military and industry), has its own OpenBao entity and keys, and never holds an administrator role. At its end date the account is disabled, its sessions are stopped and its entity is disabled without an operator. Nothing is deleted except through the runbook's two-person step. A guest reaches another site only when a signed user export explicitly includes them.
**Plans:** 28/37 plans executed in 13 waves (planned 2026-11-23; requirements DEP-01 to DEP-13 and decisions D-01 to D-69 in `47-CONTEXT.md`; D-57, 2026-11-23: sign-in strength is the site setting `signInKeys`, `passkeys` by default, `hardware-only` recommended for production; D-02 revised 2026-11-24, owner: the first goal is one HQ with about 400 concurrent people, sizes stay per-site values; 47-19 to 47-21 added 2026-11-24, owner: guest accounts for outside observers, D-58 to D-65, owner items 12 to 20 accepted by the owner on 2026-11-24, "accept guest defaults"; 47-32 and 47 D-66 to 47 D-69 added 2026-11-24 for version safety, VSAFE-03; 47-22 to 47-31 and 47-33 are the compliance follow-ups: decisions D-70 to D-83 in `47-COMPLIANCE-CONTEXT.md`, planned 2026-11-24 from a compliance audit (owner: obligations the controls require are planned by us; owner decisions a to d applied: separate release and site keys, 3-2-1 off-site copy, 5-year audit retention, RTO 8 h and RPO 24 h), with amendments to 47-16, 47-17 and 47-18; waves revised so plans that edit the same files never share a wave)

Plans:
- [x] 47-01-PLAN.md: Wave 1. Pin tools and artifacts; spikes S1 (cosign key mode with hauler) and S3 (Postgres image source); pinned image bases
- [x] 47-02-PLAN.md: Wave 1. Vendored charts with a SHA-256 lock, the offline render path and the site example file
- [x] 47-03-PLAN.md: Wave 2. Pin every third-party image; list our rebuilt and released images; release descriptors per chart
- [x] 47-04-PLAN.md: Wave 3 (merged with #172). Gate PR: checker chart and tool kinds, fit entries, component files, deploy CI check, tag-signed deploy-images workflow (owner approval)
- [x] 47-05-PLAN.md: Wave 4. Site base: RKE2 node config, Zot registry, Kyverno signed-image admission
- [x] 47-06-PLAN.md: Wave 4. Signed offline bundle build, check and import; signed-file mechanism
- [x] 47-07-PLAN.md: Wave 4. OpenBao as code: PKCS#11 seal, sterling-workbench and step-up roles, policies, two-key enrolment
- [x] 47-08-PLAN.md: Wave 4. Keycloak realm as code: passwordless WebAuthn only, `signInKeys` policy (passkeys or hardware-only), shared rpId, step-up acr levels
- [x] 47-09-PLAN.md: Wave 4. Rebuilt Theia Cloud and oauth2-proxy images; hardened session pod template
- [x] 47-10-PLAN.md: Wave 4. Encrypted storage class, OpenSearch with Fluent Bit, Prometheus, Harbor values
- [x] 47-11-PLAN.md: Wave 4. Sync hubs as single-writer StatefulSets; Keycloak's Postgres
- [x] 47-12-PLAN.md: Wave 4. Workbench AppDefinition, site environment ConfigMap, session environment policy
- [x] 47-13-PLAN.md: Wave 5. Ingress and certificates from the OpenBao PKI intermediate; HAProxy ingress
- [x] 47-14-PLAN.md: Wave 5. HQ and edge federation: signed user export and import, PKI files, revocation lists
- [x] 47-15-PLAN.md: Wave 5. Theia Cloud deployment: chart patch, oauth2-proxy alpha config, values, spike S7
- [x] 47-16-PLAN.md: Wave 7 (amended 2026-11-24). Site install script with preflight refusals (now also the time source and the import host clock); node clock files; OpenSearch policies applied; published digests recorded
- [x] 47-17-PLAN.md: Wave 7 (amended 2026-11-24). Operator runbooks: install (time source, banner, escrow), update, key ceremony (escrow custody), enrolment, recovery, moves, backup and restore, and the new recovery plan
- [x] 47-35-PLAN.md: Wave 8. Prepare and verify the lab-specific site configuration offline
- [x] 47-18-RENDER-PREVIEW-PLAN.md: Wave 9. Render the full lab-core release selection offline
- [x] 47-18-STORAGE-PREFLIGHT-PLAN.md: Wave 10. Check the proposed encrypted lab storage budget against the rendered requests
- [ ] 47-18-PLAN.md: Wave 11. Air-gapped lab end-to-end run from the signed bundle, also proving the clock check, the notice, the escrow and the first restore drill
- [x] 47-19-PLAN.md: Wave 6. Guest accounts by hand: the `guests` group and lifecycle attributes only in the realm (no `serves`, `nationality`, `organization`, `security-contacts` group or token claims; approver checked by `SecurityContactCredential`; revised 2026-11-24, owner: credentials), `guests.mjs` create, extend, end, list, the guest path in `enrol.mjs`, OpenBao `guest-expiry` and `guest-removal` policies
- [ ] 47-20-PLAN.md: Wave 8 (after 47-16 and 47-23). Automatic end at the guest's end date: CronJob with limited access in Keycloak, OpenBao and Kubernetes, the `guest-expiry` image, compliance register (gate path); credentials end on their own at the same date
- [ ] 47-21-PLAN.md: Wave 8 (after 47-17). Guests per site unless named in a signed user export (`--include-guests`, `guests@1`, target-site check); a guest record carries lifecycle fields and the DID only; the guest accounts runbook
- [x] 47-22-PLAN.md: Wave 6. Time for air-gapped sites (AU-8, SC-45): chrony configuration as code, node and import host clock checks
- [x] 47-23-PLAN.md: Wave 7. System use notice (AC-8) on every sign-in page, per language, from the realm site file
- [x] 47-24-PLAN.md: Wave 7. Scheduled snapshots: OpenBao Raft with a snapshot-only token, the OpenSearch audit store with a proven restore (CP-9, CP-10)
- [x] 47-25-PLAN.md: Wave 6. Escrow of the RKE2 token, encryption configuration and longhorn-crypto key, with stale-escrow checks (CP-9)
- [ ] 47-26-PLAN.md: Wave 6. Gate PR: register entries for grype, syft, RKE2, Longhorn, OpenSearch, OpenBao (owner approval)
- [x] 47-27-PLAN.md: Wave 7. Recovery order, RTO and RPO settings, restore-test record and restore drill as code (CP-2, CP-10)
- [x] 47-28-PLAN.md: Wave 7. Maintenance checks (drain, upgrade, certificates) and the maintenance runbook (MA-2, MA-6, SI-2)
- [ ] 47-29-PLAN.md: Wave 8. Bundle SBOMs, Grype scans, offline vulnerability database, change and impact record, signed database refreshes (RA-5, RA-5(2), SI-2, CM-4)
- [ ] 47-30-PLAN.md: Wave 9. Media handling: markings, outbound check, unlisted-file refusal, transfer records, the media runbook (MP-4, MP-5, MP-7, SI-3, AC-4)
- [ ] 47-31-PLAN.md: Wave 9. Revocation on disable: OpenBao tokens and Theia sessions ended within the site bound when a person is disabled or removed, sharing the guest-expiry mechanism (AC-2(3), AC-2(4), AC-12, IA-4)
- [ ] 47-32-PLAN.md: Wave 13 (after 47-33’s installer test baseline). The site's release record from the signed release file, with what its user import reads, mounted live in every session; an update never stops a running session; the user export carries `requires` (47-14 amended; version safety, 47 D-66 to 47 D-69)
- [ ] 47-33-PLAN.md: Wave 12. Off-site copy, required (3-2-1): daily locked copies of the encrypted backups and the audit archive to a second organization site with a signed, chained manifest; signed media for disconnected sites; quarterly drill from the copy (CP-6, CP-9)
- [x] 47-34-PLAN.md: Wave 8 (added 2026-11-25, owner: G447 option (a) with the officer notice, D-84). Officer-run removal of ended guests' secrets after a passkey step-up, the end records, and the read-only retention check that alerts officers by email and in the workbench

**Tracked follow-up**: Phase 47 guest accounts (planned). A site guest account type for outside observers: the realm-as-code group, the enrolment script's guest path and the runbook entry. Phase 33.1's outside observers (POST-09, 33.1 D-33) are not usable on a real site until it ships; it is planned separately as a Phase 47 plan.

### Phase 48: Load and accreditation verification
**Goal**: Before any capacity or compliance claim is made for the hosted workbench, we measure it: a load test on our own hardware to the target number of concurrent sessions, and OSCAL components and evidence rules for every component of Phases 46 and 47 so the compliance dashboard shows the hosted deployment's real state.
**Depends on**: Phases 46 and 47 for the running stack; the evidence-rule work starts as soon as each component in Phase 47 is chosen; Phase 44's compliance machinery.
**Requirements**: VER-01 to VER-nn (defined when planned, from DESIGN.md sections 10, 12 and 13(e)); VSAFE-04 (version safety, owner, 2026-11-24)
**Success Criteria** (what must be TRUE):
  1. A repeatable load test on our own hardware reaches the target concurrent sessions (revised 2026-11-24, owner: the first goal is one HQ with about 400 concurrent people, so the target is 400 sessions with start bursts of 200; was 1,000 or more) and records session start time, steady-state resource use per person, operator throughput and ingress behaviour; capacity figures in docs come only from it.
  2. Each component of Phases 46 and 47 has an OSCAL component definition and evidence rules, and the dashboard shows its controls from collected evidence, never assumed.
  3. The open verification items in DESIGN.md section 12 are each closed with evidence or recorded as a gap with an owner and date (Keycloak CVE-2026-6856 fix version, HSM and Go FIPS certificate status, Traefik with Theia Cloud).
**Plans:** 11 plans in 4 waves (planned 2026-11-23; requirements VER-01 to VER-09 and decisions D-01 to D-27 in `48-CONTEXT.md`; D-02, D-20 and VER-01 revised 2026-11-24, owner: HQ target of about 400; 48-11, 48 D-28, 48 D-29 and VSAFE-04 added 2026-11-24 for version safety)

Plans:
- [x] 48-01-PLAN.md: Wave 1. Hosted levels and overlay, 13 component definitions with no statements yet, control text, hosted docs pages
- [x] 48-02-PLAN.md: Wave 1. Signed site evidence export and the `deployment` collector (7-day window, trust file, `site-export`)
- [x] 48-03-PLAN.md: Wave 1. Load-test harness core: stages, measurements, hashed run file, generated capacity page, docs check that refuses hand-typed figures
- [x] 48-05-PLAN.md: Wave 1. Verification register, the design's section 10 conditions, gaps and POA&M items with owners and dates
- [ ] 48-04-PLAN.md: Wave 2. Hub load driver and a browser sample with a WebAuthn virtual authenticator (needs Phase 46's workbench package)
- [x] 48-06-PLAN.md: Wave 2. CI wiring for deployment evidence, the load-test step and the workbench and deploy test reports; gate PR 1
- [ ] 48-07-PLAN.md: Wave 3. Phase 46 components: workbench statements and evidence rules, release pipeline re-assessed for the image; gate PR 2
- [ ] 48-08-PLAN.md: Wave 3. Phase 47 components and the hub: statements and evidence rules, Met/Stale/missing test, section 10 switch; gate PR 3
- [ ] 48-09-PLAN.md: Wave 3. Rig load run to the HQ target of 400 sessions and beyond as headroom (revised 2026-11-24), capacity page and sizing defaults, reference site export; gate PR 4
- [ ] 48-10-PLAN.md: Wave 4. Rig experiments (Traefik vs HAProxy, prewarm and cold start, step-up, kms-pkcs11, revocation lists), register closure, owner decisions
- [ ] 48-11-PLAN.md: Wave 2. The signed site evidence export carries the site's Sterling release and the policy features it reads (schema 2), read by your organization's rules tool before it signs (version safety, VSAFE-04; gate PR)

### Phase 48.1: Hosted SA&A completeness (INSERTED)
**Goal**: Every documentation and evidence obligation that the controls require of the hosted deployment is identified, planned and delivered by us, not left for the owner to spot (owner, 2026-11-24): exchanges and interconnections, external services, the hosted SSP, the threat model and criticality, alerting and audit review, audit store integrity and retention, key management, the hosted crypto inventory, observers, privacy, incident playbooks, roles and separation of duties, suppliers, and continuous monitoring. Generated from one source with CI drift checks wherever possible; written by hand only what cannot be generated.
**Depends on**: the component catalogue (CM-8, the generated catalogue and the OSCAL inventory; on main since #184; built on, not duplicated); Phase 47 (47-14 and 47-16 before the key separation); Phase 48's compliance machinery and its statement plans 48-04, 48-07 and 48-08, which it fits around; Phase 33.1 for the observer statements. The Phase 47 follow-ups planned in parallel (time source, bundle image scanning, contingency and backup runbooks, media handling, maintenance, the AC-8 notice, guest accounts) are referenced, not planned here.
**Requirements**: SAA-01 to SAA-14 (defined in `48.1-CONTEXT.md`, one per audit area, with their control ids)
**Success Criteria** (what must be TRUE):
  1. Each of the fourteen areas has a gap row from the first plan, and its documents are required documents whose generated blocks a required CI job keeps in step with their sources (exchanges, services, ports and services, diagrams, key inventory, crypto inventory, suppliers, roles, alerts, system description).
  2. The hosted SSP names the Sterling system and id and carries information types, the boundary with what the site inherits, users and roles, recovery objectives and generated diagrams; the extension SSPs are unchanged.
  3. Audit failures raise alerts that cannot be silently broken by a missing input; audit records are archived daily to write-once object storage with a signed, chained manifest whose signing is restricted to the archive's service account (a cluster administrator could sign the current day's manifest but cannot alter a day already archived, and a second signature in a day raises an alert), are kept 1,825 days, and leave the online store only after the archive holds them.
  4. Every hosted key is inventoried from code with its lifecycle; the supplier release key and the organization site key are separated as the owner decided, with the development site key in SoftHSM2 refused at production sites.
  5. Every 48.1 obligation shows on the hosted dashboard from current documents and passing tests, and its gap closes only on that evidence.
**Plans:** 6/23 plans executed in 7 waves (planned 2026-11-24, revised the same day after the independent plan check and the owner's decisions a to d, all answered; decisions D-01 to D-27 in `48.1-CONTEXT.md`; cross-phase items in `48.1-HANDOFFS.md`; each wave lands as one combined pull request with one owner gate approval)

Plans:
- [x] 48.1-01-PLAN.md: Wave 1. Tracer: the generated-document path with the exchange and interconnection register, the drift check in the required docs job, the documents contract, every 48.1 gap row
- [x] 48.1-02-PLAN.md: Wave 1. Alertmanager to the site mail server; OpenBao and audit-shipping alerts with target-up or series-count guards; the stale comment fixed
- [x] 48.1-03-PLAN.md: Wave 1. Privacy inventory, retention and disposal (departed people's volumes), testing data, PIA input pack
- [x] 48.1-04-PLAN.md: Wave 1. Eight hosted incident playbooks (the six named, plus credential issuer or status-list key compromise and a stale status list at an edge) and the continuous monitoring strategy (disconnected edges by signed file)
- [x] 48.1-05-PLAN.md: Wave 1. Observer documents: releasability vocabulary and authority, agreements and clearances, rules of behaviour
- [x] 48.1-22-PLAN.md: Wave 1 (own early pull request). The owner's one-command development site key: SoftHSM2 token under ~/.config/sterling-signing, key made inside it, only the public key and URI printed, safe to run twice
- [ ] 48.1-06-PLAN.md: Wave 2. External services as a fit-checked `service` kind and their register; model-endpoints and the Controlled Goods and ITAR overlays in the hosted scope
- [ ] 48.1-07-PLAN.md: Wave 2. Hosted threat model by trust boundary (every T-47 row), criticality analysis, hosted data flows
- [ ] 48.1-08-PLAN.md: Wave 2. Key management plan and a code-checked key inventory; the cosign, timestamp and crypto-erase limits
- [ ] 48.1-10-PLAN.md: Wave 2. Roles and separation-of-duties matrix from the policies, invariant tests, training outline
- [ ] 48.1-12-PLAN.md: Wave 2. Certificate, backup and admission alerts; the generated alert list; the auditor review runbook
- [ ] 48.1-09-PLAN.md: Wave 3. Hosted crypto inventory per component with open conditions planned; supplier register from resources.json
- [ ] 48.1-11-PLAN.md: Wave 3. Ports, protocols and services, the network and boundary diagram and workload rights from the rendered charts
- [ ] 48.1-17-PLAN.md: Wave 3 (own pull request, after 47-14 and 47-16). Owner decision a applied: two-key bundle build and signed files through pkcs11-tool with stock cosign verification, the SoftHSM2 test in CI, the softhsm-signing-token preflight refusal
- [ ] 48.1-14-PLAN.md: Wave 3. Audit archive tools: daily export, signed and chained manifest, deletion only of verified archived days, the signature watch, the offline verifier with an anchor and an expected last day, sign-only OpenBao policy
- [ ] 48.1-13-PLAN.md: Wave 4. Hosted SSP: Sterling name and id, information types, boundary and inheritance, RTO and RPO from 47-27's two site-wide settings, users and roles, diagrams
- [ ] 48.1-16-PLAN.md: Wave 4. No retention-policy delete for audit records, the archiver's delete right, 730 days online, archive and sign-watch alerts, clock-error and escrow-currency alerts, the archive and retention documents
- [ ] 48.1-20-PLAN.md: Wave 4. The write-once object store: S3 object-lock target, cited evaluation (not MinIO), fit entry, and the local second site on this machine
- [ ] 48.1-23-PLAN.md: Wave 5 (tail; after 47-22, 47-24, 47-25 and 47-33 merge). Alerts on the Phase 47 follow-ups' signals: clock error, escrow currency (longhorn-crypto only), snapshot and off-site job results
- [ ] 48.1-15-PLAN.md: Wave 5. Audit archive at the site: our image, the archive and sign-watch CronJobs, the object store and 1,825-day settings, the fit register repoint
- [ ] 48.1-18-PLAN.md: Wave 6. Statements and evidence rules for the 48.1 controls
- [ ] 48.1-21-PLAN.md: Wave 6. Key separation in the inventory, key plan, playbooks and fit register text
- [ ] 48.1-19-PLAN.md: Wave 7. Observer statements for the hub and the workbench once Phase 71 (core)'s credential release check and 33.1's observer waves are on main: access and visit-clearance credentials, the agreements record and the clearance level for marked material (48.1-HANDOFFS.md H-18)

### Phase 48.2: Live compliance evidence in the workbench (INSERTED)
**Goal**: A Sterling Sovereign AI workbench, fresh from install or from a plain `docker run`, opens the Compliance view on its release's own evidence, verified against keys from your organization's configuration, with every state and freshness judged against the current time; at a site, the site's own evidence arrives live on top; nothing that cannot be verified is shown as passing.
**Inserted**: 2026-11-25 from the owner's direction of 2026-11-24 and 2026-11-25 ("yes, plan that as long as the compliance evidence is always a real-time understanding of the product's compliance status"): the image shipped with no evidence and the view told people to mount the public projection.
**Depends on**: Phases 44 and 48 (the status engine, evidence bundle, signed site evidence export); 46-09 for 48.2-07 (the release workflow); 47-32 (the live mount pattern), 48.1-15 (Kubernetes auth), 48.1-17 (site-key signing), 47-29 (offline rescan), 48-07 and 48-08 (statements) for the later waves. Waves 1 to 5 need nothing else in flight.
**Requirements**: LCE-01, LCE-02, LCE-03, LCE-04, LCE-05, LCE-06, LCE-07, LCE-08, LCE-09, LCE-10
**Success Criteria** (what must be TRUE):
  1. Every release image carries its SBOM, vulnerability scan, evidence bundle with the engine's inputs, OSCAL package, gap register and road-to-production page in one data-only layer under a manifest the release key signs, and the view shows them as of the release build. (LCE-01)
  2. Every cell shows its source, as-of time, freshness (Current, Ageing, Out of date) and verification, re-judged by the one status engine every 60 seconds and on every change; a vulnerability scan ages from its database's build date and goes out of date past the policy threshold, and a site rescan with a newer signed database brings it back. (LCE-02, LCE-03, LCE-06)
  3. Evidence is verified before display against your organization's site key (or a release key a person configured on a single computer); a tampered source shows nothing but its reason, and an unverifiable one shows Not verified and never passes. (LCE-04)
  4. A site collector's in-cluster facts and the operator's signed export, rescan and agreements reach every session within the collect interval plus about two minutes through a read-only mount, each with its own time, never cached as if current; air-gapped and disconnected edges work from local signed sources only. (LCE-05, LCE-06, LCE-09)
  5. The view layers release then site evidence, keeps "Authorization is your organization's decision", and in Restricted Mode with no site evidence shows the release evidence clearly labelled, in the original theme with lifted cards. (LCE-07)
  6. `compliance:refresh` writes the public projection 0644 so the README's read-only mount works for the workbench user; the phase's statements, evidence rules, documents and gap rows G475 to G479 exist. (LCE-08, LCE-10)
**Plans:** 11/17 plans executed in 10 waves (planned 2026-11-25 on `docs/live-compliance-evidence-plan`, revised the same day after the independent plan check; decisions D-01 to D-30, six owner questions, defaults accepted by the owner 2026-11-25, hand-offs H-1 to H-10 in `48.2-CONTEXT.md`; each wave lands as one combined pull request with one owner gate approval)
**UI hint**: yes (`48.2-UI-SPEC.md`, approved by the owner 2026-11-25; 48.2-10 Task 1 still checks that it is on main)

Plans:
- [x] 48.2-01-PLAN.md: Wave 1. Tracer: a judgement re-judged now by the backend over a checked release folder; every bundle's judgement with full parity; the view's first use
- [x] 48.2-02-PLAN.md: Wave 1. compliance:refresh writes the public projection 0644 and 0755 with a umask test; gap rows G475 to G479 (after `feat/phase-48-statements`); wave 1's gate
- [x] 48.2-03-PLAN.md: Wave 2. Freshness in the engine: Current, Ageing, Out of date; the default table with the vulnerability and live kinds; tighten-only policy; the clock case; site observations replace release ones
- [x] 48.2-04-PLAN.md: Wave 2. A Node verifier for cosign key-mode P-256 bundles held equal to the pinned cosign; anchors only from configuration and checked against the site key; Verified, Not verified, Did not verify
- [x] 48.2-05-PLAN.md: Wave 3. The release evidence writer, content and command: SBOM, the scan dated by its database, the compliance package, the gap register and road-to-production; the no-package and no-bundle forms
- [x] 48.2-06-PLAN.md: Wave 3. Site evidence formats: the trust document your site key signs with the collector's key versions, the live feed, the operator's export, rescan and agreements, verification to observations
- [x] 48.2-17-PLAN.md: Wave 3. Only the install identity may write the trust anchor (Kyverno policy and Roles); every session gets the site key from the site file to check the anchor against
- [ ] 48.2-07-PLAN.md: Wave 4 (after 46-09). The image build order, hotfixes included: the software image, its SBOM and scan, one data-only evidence layer proven by one script; the manifest signed in key mode with the P-256 release key
- [x] 48.2-08-PLAN.md: Wave 4. The live site layer in the session: the read-only mount watched, verified, layered and re-judged; the long poll; control text; the projection as a Not verified source
- [x] 48.2-09-PLAN.md: Wave 5. The site collector program: in-cluster facts with their own times, signed through OpenBao Transit at the trust document's key version, written to the live ConfigMap
- [x] 48.2-10-PLAN.md: Wave 5 (starts with the approved UI-SPEC). The Compliance view: release then site cards, the four facts per cell, Restricted Mode, live updates
- [ ] 48.2-11-PLAN.md: Wave 6 (after 47-32). The collector CronJob, least-rights RBAC, the live and operator ConfigMaps, the projected session mount, network reach, the interval setting
- [x] 48.2-16-PLAN.md: Wave 6. The one focused browser check of the view on the built image: Restricted Mode, live site evidence, tampered, anchor mismatch, projection
- [ ] 48.2-12-PLAN.md: Wave 7 (after 48.1-15 and 48.1-17). The collector's Transit key, versions and audience-bound sign-only role; the site trust document signed with your site key and installed as the install identity
- [ ] 48.2-13-PLAN.md: Wave 8. Release evidence re-signed with the site key at bundle build and installed; one command to publish operator evidence as the publish identity; the site evidence runbook with key rotation
- [ ] 48.2-14-PLAN.md: Wave 9 (after 47-29). The offline rescan as site evidence that replaces an ageing release scan
- [ ] 48.2-15-PLAN.md: Wave 10 (after 48-07 and 48-08). Statements and evidence rules, the documents with the real-time table, the full suites once, the release-preview check and the owner gate

## Milestone v0.5.0: Governed agent platform

**Milestone goal:** Every agent the extension runs works under a governance layer a person can see and check (one policy gate with a floor nothing overrides, delegation that only narrows, run contracts, a sandbox where protected folders are absent, credentials the agent never holds), deciding offline from a signed local policy.

**Renumbered 2026-11-18** (owner: "considering we are on 0.4 now, lower the rest to start at 0.5"): this milestone was v0.7.0 until then and is now v0.5.0; the data platform is v0.6.0, the messaging relay v0.7.0, and Cybersecurity keeps v0.8.0 and stays last. The never-shipped former v0.5.0 knowledge-base plan and former v0.6.0 Team Mode branch plan gave up their numbers. Dated records (CONTEXT, PLAN, SUMMARY and VERIFICATION files, PR titles) keep the numbers they were written with, so "v0.7.0 Phase 68" there means this milestone.

**Split 2026-11-18** (owner, data platform decision 2): the data platform comes after Stage 1 and before the relay, so the relay stages (Phases 75 to 84) left this milestone and are their own milestone, v0.7.0 Messaging relay, after v0.6.0 Data platform (Phases 85 to 101). Phase numbers, requirements and their mappings are unchanged. This milestone keeps Phase 68 (the relay foundation, complete, shipped as "v0.7.0 Phase 68", now v0.5.0) and Stage 1 (Phases 69 to 74). Until the split the milestone was "Governed agent platform and messaging relay"; the second half of its goal (people reaching their teams from Microsoft Teams, Signal and Telegram) is now the relay milestone's goal.

**Replanned 2026-11-15** from the owner's platform direction (`.planning/PROJECT.md`, "Platform direction"; research in `.planning/research/platform-direction/`). The milestone was "Messaging relay: Teams, Signal and Telegram" (Phases 68-76 plus 71.1 and 75.1). Phase 68 stands as built; the relay phases after it are renumbered (table below) and gain the designs the owner named: capability manifests, run contracts and channel pairing, plus a single gate with a non-overridable floor, restrict-only delegation, execution backends, a credential broker and request-bound signed approvals.

**Amended 2026-11-15** with the identity, credential and classification design the owner approved (`.planning/PROJECT.md`, Platform direction decisions 8-13; evidence in `.planning/research/platform-direction/identity-research.md`): classification labels and routing by label join Phase 70 (CLAS-01 … CLAS-07); standard DIDs (`did:key`, `did:webvh`), verifiable credentials with status lists and delegation that narrows at every link join Phase 71 (VCRD-01 … VCRD-07, DLGT-08), which now opens with a research step; L4 and L5 change to roots-only anchoring behind a backend interface, HQ's roles and a per-level maximum offline age. Phase 69 is unchanged.

**Amended 2026-11-16** with the owner's agent authorization decisions (`.planning/PROJECT.md`, Platform direction decisions 14-17; evidence in `.planning/research/platform-direction/agent-authz-prior-art.md`): NEAR function-call access keys are used only for agents' and nodes' on-chain calls, which is milestone L4 (draft ANCH-09 … ANCH-15); off-chain capabilities stay in private credentials, so Phase 73's broker gains CRED-08 (it checks a signed invocation bound to each request against the agent's credentials, with audience binding and receipts); the automatic trust badge check of CLAS-08 is now the owner's decision (Phase 70, criterion 8), and Phase 71 gains a research flag so its binding credential can later bind on-chain keys. Phases 70, 71 and 72 keep their requirements.

**Amended 2026-11-19** with the owner's model provenance decisions (design in `.planning/research/model-provenance/DESIGN.md`): two phases are inserted after Phase 74 as decimals, because Phase 75 is taken by the relay. Phase 74.1 adds model passports in the signed policy (optional `ceiling.models`), use tiers T0 to T3 checked on every model request, the isolated T0 research lane, Western defaults in one place, the different-lineage rule for checking roles and provenance on outputs; PRC-origin models are allowed at T0, at T1 only with a signed, time-boxed risk acceptance by a named senior person, and never at T2 or T3. Phase 74.2 adds your organization's own attested hosting (`org-tee`). Phase 74.1 needs only Phases 69 and 70, so it may run beside Phases 71 to 74 and ship in 0.4.x as it lands. The v0.6.0 model factory (Phases 98 and 99) changes base to Nemotron 3 and uses PRC models as teachers only, in the T0 lane (amendment at the top of `.planning/research/data-platform/04-model-factory-and-opportunity-agent.md`).

**Why it was one milestone, and why it split.** On 2026-11-15 (when it was numbered v0.7.0) it stayed one milestone because the owner asked for v0.7.0 to be replanned with these designs folded in, Phase 68 already shipped as "v0.7.0 Phase 68" (PR #50), and the relay's later phases depend on the governance phases in one chain (a relay run needs a contract, a sandbox and signed approvals); splitting would also have stopped Phase 75, which touches only `relay/`, from running beside Stage 1. On 2026-11-18 the owner put the data platform between Stage 1 and the relay, which made the split necessary. The chain is kept by dependencies (Phase 77 waits for the Stage 1 gate and the data platform gate), and Phase 75 keeps its permission to start early in its own worktree.

### Order of work across every stream (sequencing summary, updated 2026-11-18)

| Step | Work | Why here |
|------|------|----------|
| 1 | **0.4.23** (PR #51 and release PR #52): done, published 2026-11-15 | It closes a live gap (agents could read the project's key folder) and `main` is strict, so the extension line goes first. |
| 2 | **PR #50** (Phase 68): merged 2026-11-15 as 052d5cf; the owner added `relay` to branch protection the same day (D-19, done); then a small relay housekeeping PR: the relay's README, Compose file, build script and tests point at the new phase numbers, and the Signal sidecar re-check date (2026-12-10, now before the Signal phase) was to be met by re-pinning (owner, 2026-11-15; changed 2026-11-18: the pin is left to lapse and Phase 82 re-pins it) | The foundation is done; leaving it open blocks every relay phase, and the date falls due long before Phase 82. |
| 3 | **0.4.24 patch**: the four #46 review minors and the three doc mismatches; **Phase 27 record close** (done 2026-11-17: the owner's check on the real host passed, 27-16 summary written) | Small debt, cleared before the engine changes; SECURITY.md and README must agree before Phase 70 changes the floor. |
| 4 | **Phase 69, Team Mode reconciliation** (`feat/team-fix-pass` archived on GitHub at 4207080): done, PR 1 #59 and PR 2 #61 merged 2026-11-15 | Phase 70's signed policy, Phase 71's grants and Phase 80's approvals all need device identities and the signed log. Building them a second time would leave two trust cores. |
| 4a | In parallel: **Phase 28** (secure development workflow setup step) and the **OpenShell spike** (done, see openshell-spike.md) | Phase 28 touches only setup and templates; the spike feeds Phase 72. |
| 4b | **0.4.33** (the release PR from `release/0.4.33`: Phase 70's part 4e, the trust badge, and the new team's icon fix), then **the follow-up patch** (the review follow-ups carried from Phase 70's part 4 PRs) | `main` is strict, so the extension line goes first, and the follow-ups touch the gate code that Phases 71 to 74 build on. |
| 4c | **Staff collaboration drops A and B, Phases 30 to 35** (owner, 2026-11-19): multi-user staff workspaces on signed per-writer logs, co-edited products, your organization's sync hub with live updates, presence and hub watches, then offline transports. Drop A is Phases 30 to 33, drop B Phases 34 and 35. May run beside Stage 1; needs nothing from Phases 71 to 74 | Staff projects are single-machine until then (README from 0.4.35), and the owner wants real-time shared staff work; the hub shares only the relay's build and Compose patterns, so it can be built before the relay phases. |
| 4d | **Coherence review** (2026-11-20, `.planning/research/coherence/REVIEW.md`): then the coherence safety patch, then **Phase 41** (organization policy foundation), then Phases 32.1, 32.2, 33.1, 36 and 37 on it; capital projects as Phases 42 and 43 | The features were designed one at a time on different foundations; building the shared foundation first keeps them one product and avoids breaking older clients. Phase 32 continues meanwhile |
| 5 | **Stage 1, Phases 70 to 74**: gate, manifests and classification labels, identities, credentials and delegation, execution backends, credential broker, run contracts. Phase 70 is executed (every PR merged by 2026-11-18, part 4e last as #95; its verification record is still to write). **Phase 29** (cleanup member and CleanUp tool) follows Phase 70 | The vocabulary and the gate come first because everything else is checked by them; delegation narrows what the gate checks; backends make protected folders absent; the broker needs the backends' network fence; contracts refer to capabilities, grants and backends. |
| 5a | **Stage gate**: Stage 1 verified and merged before the data platform reads your organization's data (Phase 88 on) and before Phase 77 starts. v0.8.0 is deferred to the end (owner, 2026-11-15) | The relay must not run tools, and the data platform must not read real data, before verified clearances, the broker, contracts and sandboxes exist. |
| 6 | **v0.6.0 Data platform, Phases 85 to 101** (owner, 2026-11-18): the host and local inference (L1a), the data map, sources connected in one click and collectors installed by device management, extraction, classification and labels, erasure and the personal mark, holds and requests, search, ask and analytics, the model factory and the opportunity agent. Phases 85 and 86 may start during Phases 72 to 74 (the host and a test tenant only) | The owner put it after Stage 1 and before the relay. It extends the Stage 1 gate (labels, clearances, the broker, contracts) and needs all of it before it reads real data. |
| 6a | **Data platform gate**: Phases 85 to 101 verified and merged before Phase 77 lets the relay run tools | Owner priority (2026-11-18). |
| 7 | **v0.7.0 Messaging relay, Stage 2, Phases 75 to 81**: inbound authenticity and channel manifests (may start once Phase 70 is merged, beside Phases 71 to 74), identity and pairing, the Teams 1:1 slice under a contract in a sandbox, the setup view, budgets, the command surface with signed approvals, group chats | Trust boundary before any happy path, 1:1 before groups, budgets once real runs exist, approvals where remote answers arrive. |
| 8 | **v0.7.0 Messaging relay, Stage 3, Phases 82 to 84**: Signal, Telegram, ops and release | Further channels are a manifest plus one adapter once Teams is the reference; release needs every surface to exist. |
| 9 | **Later milestones**, outlined below: the Theia appliance (L1b; its host and local inference, L1a, are built in v0.6.0 Data platform), Team Mode on the governed core, routines and signed packages, verifiable identity and policy on NEAR, edge grouping and HQ federation, Theia desktop and learned skills | Each depends on v0.5.0's layer; the order and reasons are in that section. |

### Old and new phase numbers

Phase 68 records (CONTEXT, PLAN, SUMMARY and VERIFICATION files) use the old numbers. Read them through this table. `relay/README.md`, `relay/compose.yaml`, `relay/scripts/build.mjs` and the relay tests were moved to the new numbers in the relay housekeeping PR.

| Old | New | Phase |
|-----|-----|-------|
| 68 | 68 | Relay foundation (unchanged, complete) |
| - | 69 to 74 | Stage 1, new: Team Mode reconciliation, gate, delegation, execution backends, credential broker, run contracts |
| 69 | 75 | Inbound authenticity, allowlisting and channel manifests ("Phase 69 JWT validation" in the relay README means Phase 75) |
| 70 | 76 | Identity, tenants, requesters and pairing |
| 71 | 77 | Teams 1:1 slice under a contract in a sandbox (the single-instance lock and the runner entry, "Phase 71" in Phase 68 records) |
| 71.1 | 78 | Messaging setup view and pairing |
| 72 | 79 | Budgets and spend ledger on run contracts |
| 73 | 80 | Command surface, run lifecycle and signed approvals ("Phase 73" approval mapping in 68-05) |
| 74 | 81 | Group-chat discipline |
| 75 | 82 | Signal channel (the sidecar re-check, "Phase 75" in the Compose file) |
| 75.1 | 83 | Telegram channel |
| 76 | 84 | Ops, onboarding and release (the runbook, "Phase 76") |

### Carried from Phase 68

| Item | Source | Lands in |
|------|--------|----------|
| IN-04 message text retention (decided 2026-11-15: blank on acknowledgement) | 68-REVIEW-FIX, 68-CONTEXT deferred | Phase 75, decided before it stores real messages |
| A1 log redaction matches sensitive keys by containment | 68-SECURITY advisory | Phase 75 |
| A3 `connectionsCheckingInterval` near 1 s with a read-back test | 68-SECURITY advisory | Phase 75 |
| A6 tenant resolved through `getBinding` before `acceptInbound` | 68-SECURITY advisory | Phase 76 |
| D-21 single-instance lock on the state directory (AR-68-01) | 68-CONTEXT, 68-SECURITY | Phase 77 |
| A2 refuse any `NEAR_AI_KEY_` plain env name whatever its case | 68-SECURITY advisory | Phase 77 |
| Signal sidecar re-pin (tag 0.101, signal-cli 0.14.8, lapses about 2026-12-10; owner 2026-11-18: let it lapse, re-pin before first start) and A4 sidecar hardening | 68-CONTEXT D-21, 68-SECURITY | Phase 82 |
| Operator runbook (reverse proxy, TLS, backups, upgrades) | 68-CONTEXT deferred | Phase 84 |

> **Naming trap.** This milestone's relay is the *messaging* relay at `relay/`. It is **not** the ciphertext sync relay of the paused former v0.5.0 knowledge-base plan (RELAY-01/02 archived in `.planning/milestones/v0.5.0-paused/`) and **not** the planned `relayTransport.ts` board sync on the unmerged Team Mode branch. The RELAY-01/02 ids are reused here deliberately and scoped as "Phase 68 RELAY-01/02" in REQUIREMENTS.md (they were scoped as "v0.7.0 RELAY-01/02" before the renumbering).

### Phase 68: Relay foundation
**Goal**: An operator runs the relay as their own host-side service — its own workspace, its own state directory, its own hardened container — before any chat traffic is accepted.
**Depends on**: Nothing in this milestone (builds on the shipped harness and extension)
**Requirements**: RELAY-01, RELAY-02, RELAY-03, RELAY-04
**Success Criteria** (what must be TRUE):
  1. A clean checkout installs the relay workspace on Node 26.13.1 with `engines` pinned so an older runtime refuses to start, its lockfile separate from the extension's, and exactly one new runtime dependency (`jose`) — while the extension keeps its existing Node target and zero-dependency bundle untouched. (RELAY-01)
  2. `GET /healthz` on a running relay reports version, uptime, whether the Teams verifier and the Signal sidecar are operational, and the count of in-flight runs, observable without reading logs. (RELAY-02)
  3. Killing the relay with queued messages and in-flight run records and restarting it loses nothing: all state (run records, conversation bindings, tenant registry, pending approvals, message queues) lives in one git-ignored directory readable only by the relay's OS user. (RELAY-03)
  4. The relay ships as a container image built without a shell or package manager, and every secret (bot secret, tenant API keys, Signal registration material) is read at startup from an operator-supplied source and never appears in the image, the state directory listing, or a log line. (RELAY-04)
**Research flags**: (1) `node:sqlite` is RC in Node 26 — name the JSON-file-per-tenant fallback for registry/state now so storage choices in later phases stay honest. (2) Pin the exact `signal-cli-rest-api` sidecar version in the container definition this early; verify the image's bundled signal-cli age at integration time (Phase 75 in the old numbering, now Phase 82).
**Plans:** 8/8 plans executed (8 waves, run one after another; owner checkpoints: package pins D-20 in 68-01, gate approval and branch protection D-19 in 68-08)
**Status (2026-11-15)**: complete, verified (68-VERIFICATION.md, 4/4 must-haves) and merged as PR #50 (052d5cf). The owner's D-19 step (68-08 Task 3) is done: since 2026-11-15 main requires `relay` alongside the other checks. Its carried items are listed above.

Plans:
**Wave 1**
- [x] 68-01-PLAN.md — Relay workspace on Node 26: owner confirms package pins (D-20), guard entry, strict settings, GET /healthz end to end; workspace and Node guard rules with tests (RELAY-01, RELAY-02)

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 68-02-PLAN.md — Redacting logger as the relay's only output path (D-11), first log lines, health and logging contract tests (RELAY-02, RELAY-04)

**Wave 3** *(blocked on Wave 2 completion)*
- [x] 68-03-PLAN.md — Extension isolation: vsce lists no relay/ path, relay state and secrets git-ignored, root isolation test on Node 24 (RELAY-01)

**Wave 4** *(blocked on Wave 3 completion)*
- [x] 68-04-PLAN.md — Private state directory (D-07, D-17) and node:sqlite store behind RelayStore, schema v1, kill -9 drill (RELAY-03)

**Wave 5** *(blocked on Wave 4 completion)*
- [x] 68-05-PLAN.md — Full RelayStore contract suite: tenants, bindings, queues, runs, approvals; schema versioning and stable instance id (RELAY-03)

**Wave 6** *(blocked on Wave 5 completion)*
- [x] 68-06-PLAN.md — Secrets from files only (D-08, D-09, D-10), stable phone-label key (D-18), end-to-end no-leak run (RELAY-04)

**Wave 7** *(blocked on Wave 6 completion)*
- [x] 68-07-PLAN.md — Distroless image and hardened Compose with the Signal profile, container hardening suite, operator README (RELAY-04)

**Wave 8** *(blocked on Wave 7 completion)*
- [x] 68-08-PLAN.md — relay CI job and required check, VSIX release-content patterns, docs, full phase gate, owner hand-off (D-19) (Tasks 1-2 done with a green gate and merged in PR #50; Task 3, the owner's D-19 branch-protection step, done 2026-11-15)

### Stage 1: identity and governance core (Phases 69-74)

These phases change the extension's engine (`src/agent`, `src/domain`, `src/team`, with no `vscode` import in the core) and land on `main` one feature PR at a time. Everything here is editor-independent, so it moves to Theia unchanged; new UI stays small additions to existing views.

### Phase 69: Team Mode reconciliation: identities and signed events on main
**Goal**: The identity, signed-event and permission core built for Team Mode (Phase 60, verified on the unmerged `feat/team-fix-pass` branch) runs on current `main`, so the governance phases build on one tested set of device keys, signatures and permission rules; projects without Team Mode behave exactly as before, and what remains of the former v0.6.0 Team Mode branch plan has a recorded place in the new plan.
**Depends on**: Nothing in this milestone. Starts now that 0.4.23 is merged and published (2026-11-15), so the port is done once against a quiet `main`. Owner first: push `feat/team-fix-pass` to GitHub as an archive branch, and commit or record the five uncommitted files in its legacy worktree.
**Requirements**: TMR-01, TMR-02, TMR-03, TMR-04, TMR-05
**Success Criteria** (what must be TRUE):
  1. `feat/team-fix-pass` (local only today: 776 commits on top of 0.4.11, last commit 2026-11-05) is on GitHub as an archive branch, and the five uncommitted files in its legacy worktree are committed or recorded, before any code moves. (TMR-01)
  2. On `main`, a lead turns on Team Mode and two clones share one signed coordination log over the project's own remote; forged, unbound or under-privileged events are rejected by both with a reason, and replaying the same events always gives the same state. Phase 60's success criteria hold again on `main`, re-verified rather than assumed. (TMR-02)
  3. A project with no team file behaves exactly as before: the full suite is green, and a canary run finds no secret in the log, `team.json`, settings or audit. (TMR-03)
  4. A person's device identity signs and verifies any canonical payload (a policy bundle, a grant, an approval answer), and a key rotation or revocation is itself a signed event that later checks honour; Phases 70, 71 and 80 use this one interface. (TMR-05)
  5. Every phase and requirement of the former v0.6.0 Team Mode branch plan has a recorded disposition (landed here, carried to the Team Mode milestone, folded into a named new phase, or retired), and its carried ids that collide with live ids (TEAM-01..04, SETUP-01) carry a `TM-` prefix. (TMR-04)
**Research flags**: (1) The branch forked at 0.4.11; `main` is at 0.4.22 or later, with Phases 26 and 27 in between. Decide per file whether to port by cherry-pick or re-apply from the Phase 60 SUMMARY files; `src/extension.ts`, the `package.json` contributions and `src/agent/permissions.ts` changed most. (2) Team Mode's coordination transport and Phase 27's sync both run private git mirrors: check they cannot share or lock each other's mirror. (3) Phases 61, 62 and 62.1 stay on the archive branch for milestone L2 (owner, 2026-11-15); the branch is archived on GitHub at 4207080.
**Undo cost**: Low for the code (additive, inert while Team Mode is off). Higher for the signing interface (TMR-05): grants and policy bundles signed through it outlive a change.
**Plans:** 15/15 plans executed (one per wave; PR 1 is plans 01-08 on `feat/team-core-on-main`, PR 2 is plans 09-15 on `feat/team-signed-payloads`)

Plans:
**Wave 1**
- [x] 69-01-PLAN.md — TMR-01 archive check, worktree install, pure domain core from ae5e9e1

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 69-02-PLAN.md — transport, git runner, identity and git transport with their tests

**Wave 3** *(blocked on Wave 2 completion)*
- [x] 69-03-PLAN.md — event log, team.json, audit mirror, Enable, canary, forgery and concurrency

**Wave 4** *(blocked on Wave 3 completion)*
- [x] 69-04-PLAN.md — two windows on one mirror with main's lock, reserved sync refs, isolation test

**Wave 5** *(blocked on Wave 4 completion)*
- [x] 69-05-PLAN.md — VS Code adapters, activation, solo parity, fix 9e49bc5

**Wave 6** *(blocked on Wave 5 completion)*
- [x] 69-06-PLAN.md — preview setting and palette gating, plain words, manifest and boundary tests

**Wave 7** *(blocked on Wave 6 completion)*
- [x] 69-07-PLAN.md — one identity per person per install, rollback rule (D-22), Team Mode e2e in a real window (D-30)

**Wave 8** *(blocked on Wave 7 completion)*
- [x] 69-08-PLAN.md — PR 1 gate, Phase 60 criteria re-verified on main, open PR 1

**Wave 9** *(blocked on Wave 8 completion)*
- [x] 69-09-PLAN.md — device.rotated end to end

**Wave 10** *(blocked on Wave 9 completion)*
- [x] 69-10-PLAN.md — payload signer and key status

**Wave 11** *(blocked on Wave 10 completion)*
- [x] 69-11-PLAN.md — local signed key history

**Wave 12** *(blocked on Wave 11 completion)*
- [x] 69-12-PLAN.md — the identity writes and backfills its own history

**Wave 13** *(blocked on Wave 12 completion)*
- [x] 69-13-PLAN.md — rotation and revocation helpers for the person's key

**Wave 14** *(blocked on Wave 13 completion)*
- [x] 69-14-PLAN.md — disposition record of the former v0.6.0 Team Mode branch plan (TMR-01, TMR-04)

**Wave 15** *(blocked on Wave 14 completion)*
- [x] 69-15-PLAN.md — automated check that PR 1 is on main, rebase PR 2, gate, open PR 2 (no owner checkpoint, D-30)

### Phase 70: Capability vocabulary, manifests and one gate with a floor
**Goal**: Every tool call passes one gate that decides from declared capabilities, classification labels and a signed local policy, with a floor no mode, setting or delegation can override; the same gate decides where a model request may go from the label of what the session has read, and it never needs the network.
**Depends on**: Phase 69 (the policy bundle is signed with a device identity)
**Requirements**: GATE-01, GATE-02, GATE-03, GATE-04, GATE-05, GATE-06, GATE-07, OFFL-01, OFFL-02, OFFL-03, CLAS-01, CLAS-02, CLAS-03, CLAS-04, CLAS-05, CLAS-06, CLAS-07, CLAS-08
**Success Criteria** (what must be TRUE):
  1. Every built-in tool and every MCP server tool has a capability manifest (effects, hosts, credential handles, the contexts it may run in); a test enumerates every registered tool and every execution path (file tools, Bash, MCP calls, sub-agent spawns) and fails if one lacks a manifest or reaches execution without passing the gate; an undeclared MCP tool is treated as the most restrictive kind. (GATE-01, GATE-02, GATE-03, GATE-04)
  2. The Tools page and team member cards show each tool's manifest in plain words, and a local stdio MCP server is labelled as running on this machine with the person's own permissions and is refused in unattended runs unless named. (GATE-03)
  3. In every approval mode, fully-autonomous included, the key folder and credential stores are refused, and writes into `.git/` and `.near-ai/` state, publishing and destruction ask a person with no "always allow"; fully-autonomous means "no approval needed within the policy's grant", never "gate off"; the SECURITY.md limitation "fully-autonomous writes protected files without asking" is removed because it is no longer true. (GATE-05, GATE-06)
  4. With the network unplugged, every decision is made from a local policy bundle signed by the person's device identity; a missing, unsigned, tampered or expired bundle leaves only the floor plus read and plan, and the person is told in plain words how to fix it; a fresh install creates and signs its first bundle, so nothing breaks. (OFFL-01, OFFL-02)
  5. Every decision is recorded with actor, capability, outcome and the rule that decided it, and the bundle carries a version, expiry, issuer and empty slots for anchor roots, status list references and a maximum offline age per level. (GATE-07, OFFL-03)
  6. Files, folders, chats, projects and tool output carry labels from the bundle's scale presets (commercial, the two Canadian government scales, NATO); access is allowed only when the actor's clearance dominates the label, and a session that has read a label marks everything it writes, sends or summarizes with it until a person declassifies, which is recorded. (CLAS-01, CLAS-02, CLAS-03, CLAS-04)
  7. Each model request goes only where the session's label allows (any cloud, attested NEAR AI Cloud only, local only, or nowhere); Protected B content with no local model configured is refused with a plain explanation instead of reaching a cloud, and the label settings and SECURITY.md say the gate prevents mistakes and does not accredit a device for classified information. (CLAS-05, CLAS-06, CLAS-07)
  8. Every cloud answer shows a plain trust badge (Verified private model; Model verified, connection not proven; Not verified) with the full attestation on request, checked automatically on every answer from a TEE model (one signature request per answer, the attestation report reused for 10 minutes; owner, 2026-11-16), and a level that requires attested cloud is sent only after a pre-send check that the connection is bound to the enclave. (CLAS-05, CLAS-08)
**Research flags**: (1) The capability grammar: start from IronClaw's manifest fields and the Hermes grammar (both in `.planning/research/platform-direction/`), version it, refuse unknown verbs, and reserve verbs for inference routes and GPU devices so later milestones need no grammar change. (2) Migration: approval modes, auto-allow switches, allow rules, protected paths (`src/domain/protectedPaths.ts`) and unattended rules (`src/agent/unattended.ts`) map into the bundle with no change in behaviour except the floor. (3) The relay reuses the vocabulary, but its workspace test lets only `relay/src/runner` import extension code: decide how the types are shared. (4) Labels and routing (`identity-research.md`, section 4): the default label of a fresh install must keep routing as it is today (no behaviour change but the floor); where file and folder labels are stored (a map in the project, not file attributes) and how a label follows a copy, a rename and Phase 72's copy-and-apply; the `attested-cloud` tier reuses the per-request attestation and signature check in `src/services/attestation.ts`, and `local-only` builds on today's local and hybrid profiles. (5) Presets: the NATO list comes only from secondary copies, and modelling the Canadian Protected and Classified families as two scales is the plan's reading, so your organization's security officer confirms both before release; no CCCS Medium (formerly PBMM) assessment of NEAR AI Cloud was found, so Protected B stays local only by default. (6) Not accreditation (research risk 9): the wording of CLAS-07 is checked against what the gate actually guarantees.
**Undo cost**: High. The vocabulary, the label format and the bundle format are what edge devices hold offline and what anchored roots will commit to (only roots go on chain): settle them before they ship.
**Plans:** 32 plans (one per wave; after the planning PR, PR 1 is plans 01-07 on `feat/gate-vocabulary`, PR 2 is plans 08-15 on `feat/gate-shadow`, PR 3 is plans 16-18 on `feat/gate-floor`; part 4 is five PRs (replanned 2026-11-17, D-49): 4a is plans 19 and 28a on `feat/gate-route-check`, 4b is plans 20, 21 and 28b on `feat/gate-labels`, 4c is plans 22, 23, 24 and 28c on `feat/gate-session-mark`, 4d is plans 25 and 28d on `feat/gate-attested-routing`, 4e is plans 26, 27 and 28e on `feat/gate-trust-badge`)
**UI hint**: yes

Plans:
**Wave 1**
- [x] 70-01-PLAN.md — capability vocabulary v1, shape helpers, the glob move and the pure gate folder boundary (PR 1)

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 70-02-PLAN.md — labels v1, the four scale presets, dominance with a property test, the join, the label texts (PR 1)

**Wave 3** *(blocked on Wave 2 completion)*
- [x] 70-03-PLAN.md — policy bundle v1, its default, fail-closed sentences, the clock rule and renewal (PR 1)

**Wave 4** *(blocked on Wave 3 completion)*
- [x] 70-04-PLAN.md — the pure route decision, label map v1 and the label-map signing purpose (PR 1)

**Wave 5** *(blocked on Wave 4 completion)*
- [x] 70-05-PLAN.md — tool and MCP manifests v1 and their plain words (PR 1)

**Wave 6** *(blocked on Wave 5 completion)*
- [x] 70-06-PLAN.md — the floor, decide() layered over today's settings, the OCSF decision record, offline decisions (PR 1)

**Wave 7** *(blocked on Wave 6 completion)*
- [x] 70-07-PLAN.md — PR 1 gate and open (no behaviour change)

**Wave 8** *(blocked on Wave 7 completion)*
- [x] 70-08-PLAN.md — manifests on the core, web, graphics, image, memory and security tools, the tool catalog, Tools page words (PR 2)

**Wave 9** *(blocked on Wave 8 completion)*
- [x] 70-09-PLAN.md — manifests on the gsd, cyber, knowledge and MCP tools, member card words, the manifest field required (PR 2)

**Wave 10** *(blocked on Wave 9 completion)*
- [x] 70-10-PLAN.md — MCP manifests: restrictive for new servers, legacy for existing ones, declare per tool (PR 2)

**Wave 11** *(blocked on Wave 10 completion)*
- [x] 70-11-PLAN.md — the signed policy file on disk, fresh install, fail closed, renewal, the decision log; D-48 code-server check named (PR 2)

**Wave 12** *(blocked on Wave 11 completion)*
- [x] 70-12-PLAN.md — the gate on chat runs and sub-agents in shadow, started at activation, cards as transport (PR 2)

**Wave 13** *(blocked on Wave 12 completion)*
- [x] 70-13-PLAN.md — the gate on cyber steps and comparison runs, the execution path enumeration test, offline runs (PR 2)

**Wave 14** *(blocked on Wave 13 completion)*
- [x] 70-14-PLAN.md — status bar, Show Policy, Reset Policy to Defaults, setup step, SECURITY.md and README policy and MCP sections (PR 2)

**Wave 15** *(blocked on Wave 14 completion)*
- [x] 70-15-PLAN.md — automated check that PR 1 is on main, rebase, gate, open PR 2 (formats, fail-closed change and the D-48 release blocker named)

**Wave 16** *(blocked on Wave 15 completion)*
- [ ] 70-16-PLAN.md — classifier effect tags for publish, destroy and protected writes; credential-store detection (PR 3)

**Wave 17** *(blocked on Wave 16 completion)*
- [ ] 70-17-PLAN.md — the floor enforced in every mode, the deliberate protectedPaths test change, SECURITY.md and README in the same plan (PR 3)

**Wave 18** *(blocked on Wave 17 completion)*
- [ ] 70-18-PLAN.md — automated check that PR 2 is on main, rebase, gate, open PR 3 with the owner's open questions

**Wave 19** *(blocked on Wave 18 completion)*
- [ ] 70-19-PLAN.md: the route check in NearAiClient.request with a session route at every request site, a record for every model request, attested-cloud held to a proven binding, part 4's ids (PR 4a)

**Wave 20** *(blocked on Wave 19 completion)*
- [ ] 70-28a-PLAN.md: automated check that PR #76 is on main, rebase, log growth measured, gate, open PR 4a with the D-48 release blocker

**Wave 21** *(blocked on Wave 20 completion)*
- [ ] 70-20-PLAN.md: signed label maps, Set Label, clearance checks on every read path, labels that follow renames, no silent re-signing (PR 4b)

**Wave 22** *(blocked on Wave 21 completion)*
- [ ] 70-21-PLAN.md: Edit Policy and Apply Policy Draft with a stale-draft check, clearance texts in Show Policy, 4b docs (PR 4b)

**Wave 23** *(blocked on Wave 22 completion)*
- [ ] 70-28b-PLAN.md: automated check that PR 4a is on main, rebase, gate, open PR 4b (names the label map format and the D-48 release blocker)

**Wave 24** *(blocked on Wave 23 completion)*
- [ ] 70-22-PLAN.md: the session high-water mark: raised at the shared hook, shared with sub-agents, written to files, calls that could leave this computer held (PR 4c)

**Wave 25** *(blocked on Wave 24 completion)*
- [ ] 70-23-PLAN.md: the chat keeps and shows its label, a merge never lowers it, Lower This Chat's Label with a recorded reason (PR 4c)

**Wave 26** *(blocked on Wave 25 completion)*
- [ ] 70-24-PLAN.md: local-only on this computer, Protected B and Confidential kept local, SECURITY.md labels and routing section (PR 4c)

**Wave 27** *(blocked on Wave 26 completion)*
- [ ] 70-28c-PLAN.md: automated check that PR 4b is on main, rebase, gate, open PR 4c (names the routing meanings and the D-48 release blocker)

**Wave 28** *(blocked on Wave 27 completion)*
- [ ] 70-25-PLAN.md: the pre-send connection binding (research, NEAR AI Cloud source, pinned connection) and the after-answer check with Check again (PR 4d)

**Wave 29** *(blocked on Wave 28 completion)*
- [ ] 70-28d-PLAN.md: automated check that PR 4c is on main, rebase, gate, open PR 4d (quotes the connection binding finding, names the D-48 release blocker)

**Wave 30** *(blocked on Wave 29 completion)*
- [ ] 70-26-PLAN.md: the trust badge on every cloud answer: three states from checks that ran, a timeout, details and full attestation, theme-aware (PR 4e)

**Wave 31** *(blocked on Wave 30 completion)*
- [ ] 70-27-PLAN.md: trust badges kept across reloads, the end-to-end badge check, SECURITY.md and README badge text (PR 4e)

**Wave 32** *(blocked on Wave 31 completion)*
- [ ] 70-28e-PLAN.md: automated check that PR 4d is on main, rebase, phase coverage and validation records, gate, open PR 4e (closes Phase 70)

**Cross-cutting constraints:** <!-- gsd:generated -->
- The full gate passes once inside the cap: lint and suite, e2e under xvfb with the Wayland variables removed, verify:release and the range secret scan (D-34).

### Phase 70.1: Classification engine (INSERTED)
**Goal**: One pure engine decides what any classification proposal may do to a label, under your organization's signed policy, and records what it did: automatic steps only raise or keep, everything lower goes to a person with the authority, and content above what the system may hold is a possible spill.
**Inserted**: 2026-11-24 from the AI classification research (`.planning/research/ai-classification/RESEARCH.md`, section 7.1). Owner decision D1 (AI proposes data attributes only) is accepted; D2 to D6 and D8 to D14 are owner-confirmed 2026-11-24 at the research defaults (`70.1-CONTEXT.md`).
**Depends on**: Phase 70 (all 32 plans merged: PR 4b #85 writes labels to disk, PR 4c #87 the session mark) and Phase 41 (the v2 policy document). No model and no network. Runs beside Phase 71 (core) and Phase 33.
**Requirements**: CLSF-01, CLSF-02, CLSF-03, CLSF-04, CLSF-05
**Success Criteria** (what must be TRUE):
  1. Every proposal is one closed record with its bases, confidence, model and prompt hashes and a rationale labelled at the item's label, with no field for any person attribute; the decision log holds hashes and ids only. (CLSF-01)
  2. A proposal starts from the labels the content inherits and can only raise or keep them; seeded property tests and the model-free red-team set show that no text, visible or hidden, lowers any field or suppresses a floor, and a result for older content changes nothing. (CLSF-02)
  3. Raise thresholds come from cost ratios in the signed policy with raise, suggest and nothing bands; markings, guide rules, detectors, compilation rules and source labels are floors; a model judgement alone raises only the level; shadow mode only suggests; a recall drop tightens a threshold; a large raise also goes to review. (CLSF-03)
  4. Your organization's guide and compilation rules, code words, fact types, model roles and enforcing levels live in the signed `classification@1` section, are evaluated by pure code over typed facts and a session's running fact set, and newer or lower layers can only tighten them. (CLSF-04)
  5. `label.auto-raised`, `label.exception-queued`, `label.exception-resolved`, `label.could-be-lower` and `label.affirmed` are named and recorded, and anything above the system-high gives a possible spill: raised to the system-high with `local-only` and `no-agent-tools`, frozen and queued. (CLSF-05)
**Undo cost**: High. The proposal record, the event ids, the basis kinds and the section keys are permanent once shipped; 70.1-01 ends with the owner's shapes checkpoint.
**Plans:** 4/5 plans executed in 4 waves (planned 2026-11-24 on `docs/phase-70.1-74.3-plan`; decisions D-01 to D-22 and four owner-confirmed items in `70.1-CONTEXT.md`)

Plans:
- [x] 70.1-01-PLAN.md: Wave 1. Tracer: a marking raises a label through `classification@1`, the engine and the record; record v1, the five events, the owner's shapes checkpoint
- [x] 70.1-02-PLAN.md: Wave 2. The asymmetric rule: thresholds and bands, judgements, shadow, review, stale results, the possible spill, property tests
- [x] 70.1-03-PLAN.md: Wave 2. Guide and compilation rules, code words and fact types in the signed section; lower layers only tighten; Show Policy words
- [x] 70.1-04-PLAN.md: Wave 3. `assess()`, the hidden-instruction detector and the model-free red-team set
- [ ] 70.1-05-PLAN.md: Wave 4. The full suite once, the verification record, the integration PR after the owner's gate approval

### Phase 71: Identities and verified credentials (core), pulled forward
**Goal**: Verified credentials are the only source of access attributes. Every person, agent and machine acts under its own standard DID. Clearance, compartments, nationality, affiliation, how a person serves, export eligibility, agreements and the authority to issue arrive only as signed credentials that can be revoked. Data decides who may open it from its own label, through one pure check that the fold, your organization's server, the key-wrap preparers and the session all call. Keycloak only signs people in.
**Re-scoped 2026-11-24** (the owner's data-centric access direction, `.planning/research/data-centric-access/RESEARCH.md`, decisions O1 to O11 accepted): the identity and credential core is pulled forward and runs now beside Phase 33, Phase 33.1's waves 1 to 3, Phase 46 and 47-13 to 47-18 (research rows B and E). Agent delegation (DLGT-02 to DLGT-08) moves to Phase 71.1, which stays in Stage 1. The hybrid cell wrap the research put here moves to Phase 33.2, next to the cells it changes (71-CONTEXT.md D-02). Plan, requirement and API ids for other planners: `.planning/research/data-centric-access/PLAN-IDS.md`.
**Depends on**: Phase 70 (labels, dominance, the signed policy) and Phase 69 (the signer and key status). Plans 71-01 to 71-08 need nothing else. 71-10, 71-12 and 71-13 need 46-02 and 46-07 on `main` (47-07 is on `main`). 71-09 and 71-13 need Phase 33's hub and native Staff Room plans (33-22 to 33-26).
**Requirements**: DLGT-01, VCRD-01, VCRD-02, VCRD-03, VCRD-04, VCRD-05, VCRD-06, VCRD-07, DCAC-01, DCAC-02, DCAC-03, DCAC-04, DCAC-05, DCAC-06
**From the portfolio design (2026-11-20)**: positions and portfolio publishers become verified credentials here, so a posting and a publication can be checked against a person's credential, not only the device key (`.planning/research/portfolio-and-assignment/DESIGN.md`, 10.4).
**From the AI-classification research (coordinator, 2026-11-24)**: `ClassificationAuthorityCredential { scale, upTo, scope }` joins the credential types, and agents and devices can never issue: the checker refuses it structurally, with a property test (71-CONTEXT.md D-06, D-07).
**Builds on Phase 69 (unchanged)**: the payload signer accepts any Ed25519 signer object (69 D-20) and every check honours one key-status lookup (69 D-09, D-21). The `eddsa-jcs-2022` proof is a second proof format beside Phase 69's signed-payload envelope, using the same signer object, the same raw key and the same canonical JSON, so there is still one signer (69 D-10). Phase 69's device key becomes the device's `did:key` with no key change; 69 D-06's wording about a `did:near` identity is superseded by decision 10.
**Research step (first: plans 71-01 and 71-02)**: (a) JCS conformance: our `eddsa-jcs-2022` signing input against the W3C vectors and Digital Bazaar's cryptosuite both ways, the integer-only subset equal to RFC 8785 for every input the profile allows, and domain separation from Phase 69's inputs (71-01, the tracer). (b) `did:webvh` hosting and caching: SCID, verifying from a cached copy, pre-rotation with an offline root, hosting on the sync hub behind the site's ingress, HQ as witness, the DIF vectors. (c) Status list sizing, time to live and the per-level maximum offline age (O6). (O8) The FIPS posture for Ed25519 with `did:webvh`, with `ecdsa-jcs-2019` and P-256 officer keys as the ready fallback for a strict-FIPS site (71-02). Each item ends with a verdict; a FALLBACK verdict applies the accepted fallback (O9) to the plans that depend on it.
**Success Criteria** (what must be TRUE):
  1. Every person, agent and machine acts under its own DID: agents and machines under `did:key` from their Ed25519 key (Phase 69's device identity maps to it unchanged), people and your organization's root under `did:webvh`, made by the person's own backend at first sign-in and by an offline ceremony for the root; each DID document holds only the identifier, verification methods, controller and services and validates as DID Core 1.0; a computer is bound to its person by a credential and cut off by revoking it. (DLGT-01, VCRD-06)
  2. Every access attribute arrives only as a credential in our narrow VC 2.0 profile (`eddsa-jcs-2022`, second suite `ecdsa-jcs-2019`, no new runtime dependency) that passes the W3C vectors and cross-verifies both ways with Digital Bazaar's libraries in tests; revoking or suspending it in its status list takes effect at the next check; a holder shows only the atomic or threshold credentials a check asks for. (VCRD-01, VCRD-02, VCRD-03, VCRD-04, VCRD-05)
  3. Your organization's signed policy names, in `credentials@1`, the root DID and what each role may issue, the status lists, the time to live, the maximum offline age per level and the credentials required by sensitivity (only ever tightened), and in `agreements@1` its organization-to-organization agreements; only people with a role credential from the root can issue, and an agent or device key never can. (DCAC-01)
  4. An entry that relies on a person's attribute cites its evidence by hash, and every replica gives the same answer whatever list it holds; one `mayRelease` decides every wrap, release and serve with the full dominance for every holder, observers included, and releasability for everyone. (DCAC-02, DCAC-03)
  5. Your organization's server refuses an append built on stale evidence and stops serving a member whose credential was revoked, and the lead rekeys in one action; the session refuses protected actions when its credential check is stale, with Retry; an epoch key opens in a session only while the person's fresh credentials allow it; an edge refuses past the level's maximum offline age. (DCAC-04)
  6. Inside your organization the gate's clearance comes only from verified credentials; on a computer with no organization, the person's declared clearances work as today and are shown as declared, not verified. (VCRD-07)
  7. Officers issue, revoke and suspend credentials from their own session with their person key after a passkey step-up; status lists are signed by the HQ status-list key in OpenBao, each signature authorized only by an officer's step-up; your organization's server serves the DID logs and status lists, and a trust export carries them to a disconnected edge. (DCAC-05, DCAC-06)
**Research flags**: (1) DID methods are decided (owner-confirmed 2026-11-15, Platform direction decision 10): `did:key` and `did:webvh`, not `did:near`. (2) Identity lifetime: persistent per person; rotation (`did:webvh` pre-rotation for the root, 71-02's verdict for people) and revocation (status lists for credentials, Phase 69's key history for device keys). (5) Threshold credentials show a holder's maximum level to anyone they present all of them to: present only what a check asks (research risk 7). (6) Revocation lag: a device holding keys offline is trusted until its next contact, bounded by the per-level maximum offline age, now set in this phase (O6), and by rekeying. (7) Not post-quantum: every proof names its cryptosuite so a second suite can sit beside it. (8) Device clocks: expiry checks go through one clock helper that Phase 74's clock rule later tightens. (9) On-chain keys come in L4: keep the binding credential (VCRD-06) able to name a NEAR account, a public key and its allowed methods. Flags 3 and 4 (spend in grants, nesting) moved to Phase 71.1.
**Undo cost**: High. The DID methods, the credential profile, the status list format and the evidence citation shape are what edge devices hold offline and what shared logs cite; settle them before they ship.
**Plans:** 12/14 plans executed in 9 waves (planned 2026-11-24 on `docs/phase-71-core-plan`; decisions D-01 to D-21 and five owner items in `71-CONTEXT.md`)
**UI hint**: yes

Plans:
- [x] 71-01-PLAN.md: Wave 1. Tracer and research item (a): one clearance credential through our `eddsa-jcs-2022` profile, cross-verified with Digital Bazaar and the W3C vectors (package check first)
- [x] 71-02-PLAN.md: Wave 1. Research items (b), (c) and O8: `did:webvh` hosting and caching, status list sizing and lifetimes, the FIPS posture with the fallback ready
- [x] 71-03-PLAN.md: Wave 2. The narrow VC 2.0 profile, every credential type, the second suite `ecdsa-jcs-2019`
- [x] 71-04-PLAN.md: Wave 2. `did:key` for devices from Phase 69 keys; `did:webvh` log verification from a cached copy
- [x] 71-05-PLAN.md: Wave 3. Bitstring Status List: build, sign, verify, staple, cite by hash
- [x] 71-06-PLAN.md: Wave 3. Trusted issuers in the signed policy (`credentials@1`, `agreements@1`), the issuer authority chain, agents and devices never issue
- [x] 71-07-PLAN.md: Wave 4. The credential checker: evidence cited by hash, `mayRelease`, freshness and offline age, the gate's clearance
- [x] 71-08-PLAN.md: Wave 5. The person's wallet, the gate's clearance from credentials in your organization, the command-line verifier
- [x] 71-09-PLAN.md: Wave 5. Your organization's server serves logs and status lists, checks cited evidence on append and serve, and tells the lead when a holder is revoked
- [x] 71-10-PLAN.md: Wave 6. Identities in use: a person's `did:webvh` at first sign-in, your organization's root DID and role credentials offline, binding a computer
- [x] 71-11-PLAN.md: Wave 6. The trust export carries logs, status lists and the issuer section to edges
- [x] 71-12-PLAN.md: Wave 7. Issuance from the officer's own session: the Issue credential card, the status-list key in OpenBao, revoke and suspend
- [ ] 71-13-PLAN.md: Wave 8. Freshness in the session: the credential state, key release in hosted sessions, sign-in tokens that only authenticate
- [ ] 71-14-PLAN.md: Wave 9. SECURITY.md and README, the full suites once, the verification record, the integration PR after the owner's gate approval

### Phase 71.1: Agent delegation that only narrows (INSERTED)
**Goal**: An agent can never hold more than it was delegated: a lead passes only a subset of what it holds and every link of the chain is checked, grants expire, depth and fan-out are capped, and members report results in a declared shape.
**Split from Phase 71 on 2026-11-24** (data-centric access research, section 5.2): the identity and credential core was pulled forward as Phase 71; agent delegation stays in Stage 1, before Phase 72, in the order of the milestone. **Naming trap:** records dated before 2026-11-15 that say "Phase 71.1" mean the messaging setup view, now Phase 78.
**Depends on**: Phase 71 (credentials, the checker, `did:key` for agents); 33.1-04's `mayDelegate` (the one delegation rule).
**Requirements**: DLGT-02, DLGT-03, DLGT-04, DLGT-05, DLGT-06, DLGT-07, DLGT-08
**Success Criteria** (what must be TRUE):
  1. A delegation gives a member the intersection of the lead's grant, the member's `tools:` line and the task's request; a property test shows no delegation ever widens, and the gate enforces it, not the prompt. (DLGT-02)
  2. Each grant is a delegation credential signed by its delegator, with an expiry, a budget, a level cap, roles, compartments and a depth limit, recorded in the signed log; the gate refuses an expired, unsigned or tampered grant. (DLGT-03)
  3. A tree deeper than the limit or wider than its fan-out caps is refused with a plain reason, and leaves never get spawning, scheduling, outbound messages, skill or memory writes, or tool and policy changes unless their grant names them. (DLGT-04, DLGT-05)
  4. A member asked for a declared result shape returns it or gets one correction turn, a restart reports an unfinished result as unknown, and the Agent Activity view shows for each agent what it may do, the level, roles and compartments it holds, and its DID. (DLGT-06, DLGT-07)
  5. A chain that widens level, roles, compartments, expiry or depth at any link, or holds a revoked or suspended credential anywhere, is refused with a plain reason. (DLGT-08)
**Research flags**: (3) Spend in grants needs a running total held by the parent, not a static comparison of amounts and periods (spike finding). (4) Existing teams that nest deeper than the new default get a clear message, not a silent failure. Agents act under a raise-only delegation for labels (AI-classification research 6.4).
**Undo cost**: High. The grant format is what edge devices hold offline.
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 71.1 to break down)

### Phase 72: Execution backends on a copy, with a guarded apply
**Goal**: An agent's commands can run behind a real boundary: on a copy of the project inside a container or an OpenShell sandbox where protected folders are simply absent, with the changes brought back through an apply step that treats them as untrusted, shows the person the diff first and refuses anything that could reach outside the copy; the person always sees which boundary a run has.
**Depends on**: Phase 70, Phase 71 (per-agent policies and the delegation check). Research reads the OpenShell spike result first.
**Requirements**: EXEC-01, EXEC-02, EXEC-03, EXEC-04, EXEC-05, EXEC-06, EXEC-07, EXEC-08, EXEC-09, EXEC-10
**Spike result (2026-11-15, `.planning/research/platform-direction/openshell-spike.md`)**: OpenShell 0.1.8 on Linux with rootless Podman blocked all 20 escape cases against the key folder (absent from the copy, or present but outside the Landlock allowlist), allowed only the declared host, method and binary, injected a fake credential only on the bound endpoint and placement, and its prover rejected widened children in about 50 ms. About 50 ms is added per command and about 1 s per sandbox start, so one sandbox per run is the unit. The most important finding is on the way back: `openshell sandbox download` recreates symlinks as the sandbox made them, so a relative link to `../.near-ai/state/keys/local.key` would point at the real key once applied to the checkout.
**Success Criteria** (what must be TRUE):
  1. A project or run chooses host (today's behaviour, labelled as text checks only), container (Docker or Podman, network off unless the policy allows it) or OpenShell (Linux first, version pinned); the chat and Agent Activity say which boundary a run has, sandbox blocks appear there with the binary, host, rule and reason from the sandbox's own log, and on Windows and Intel Macs the choice is container or host, labelled, with nothing claiming isolation it does not have. (EXEC-01, EXEC-07)
  2. The copy is built by the extension from tracked files and uncommitted changes, never `.near-ai/state`, `.git` or another floor path, and never by bind-mounting the live checkout or relying on `.gitignore` filtering; the spike's 20 escape cases (`openshell-spike/tests/key-escape.sh`: run-time built paths, base64, `npm run`, recursive walks, links, `/proc`) are regression tests that fail if the key folder becomes readable. (EXEC-02, EXEC-04)
  3. Changes come back only as a diff the person sees before anything is applied, computed on the host from regular files; symlinks (including a relative link back to the key folder), special files, mode changes and paths under protected locations are refused or shown as flagged, and Revert covers what was applied. (EXEC-03)
  4. The OpenShell policy for a run is generated from the agent's grant and the team policy, never written by hand or by an agent: enforce mode, `landlock: hard_requirement`, a non-root user, network rules per binary, and a fixed vocabulary of file paths that a child may only drop or make read-only; when a lead delegates, the child's policy is checked against the parent's with the pinned prover and anything but `within_boundary` is refused, while MCP rules, which the prover cannot model, are left to Phase 71's subset check. (EXEC-05, EXEC-06)
  5. On Linux a guided setup installs the pinned OpenShell release after checking its checksums and build attestations, generates the local certificates and gateway signing keys, runs the gateway as a user service with telemetry off, keeps its sockets under the short runtime folder (the 108-byte socket path limit), and re-verifies on upgrade; under code-server the gateway runs on the host and the editor reaches it only over its own authenticated API, never through a container runtime socket. Workload images are pinned by digest, loaded where the gateway's runtime finds them, built for arm64 and amd64, and a dev server the agent starts is reachable by the person only through a forward the person can see. (EXEC-08, EXEC-09, EXEC-10)
**Research flags**: (1) Start with the spike's recommended next step as the first plan: one agent turn through the OpenShell API inside the extension (Linux, behind a setting) with copy-in, diff-out and the apply guard, before the rest is planned in detail. (2) OpenShell is 0.1.x with weekly releases and some Experimental interfaces: pin, verify attestations, re-test on every bump. (3) The gateway binary is about 113 MB: a separate guided install, not a download inside the VSIX. (4) One backend interface for agent shells and the cyber harness (`src/services/cyberSandbox.ts`), so v0.8.0's VM tier becomes another backend. (5) GPU devices: NVIDIA works through `--gpu` and Container Toolkit CDI specs, with device paths added to Landlock automatically; AMD works only by listing `/dev/kfd` and `/dev/dri` in the policy (plus CDI `amd.com/gpu`, the `render` and `video` groups, and an untested seccomp path) and needs a hardware test on a Strix Halo machine before anything is promised. AMD first (owner, 2026-11-15): the first plan of this phase includes an OpenShell bring-up on the owner's Strix Halo machine (x86-64, rootless Podman, the gateway and one sandbox, the copy-and-diff flow, then `/dev/kfd` and `/dev/dri` passthrough with the `render` and `video` groups and a ROCm smoke test such as `rocminfo` inside the sandbox); NVIDIA and arm64 validation follow and never block the AMD path. If AMD GPU passthrough fails inside OpenShell, the container backend with explicit device passthrough is the AMD fallback, labelled as weaker isolation. Grants carry no device by default here; the appliance milestone turns them on. (6) macOS Apple Silicon through Docker Desktop or a Podman machine is supported by OpenShell but untested by us. (7) The copy-and-diff flow for long builds, `node_modules` and dev servers.
**Undo cost**: Medium. The relay, the cyber harness and the appliance all build on the backend interface; the apply guard's rules protect the person's checkout and must not loosen later.
**Plans:** 0 plans
**UI hint**: yes

Plans:
- [ ] TBD (run /gsd-plan-phase 72 to break down)

### Phase 73: Credential broker
**Goal**: Agents never hold a real key: credentials are named by handle and bound to the hosts and placements they may reach, sandboxed processes see placeholders, a real credential is added only after the broker has checked a signed invocation for that exact request against the agent's private credentials, and tool output is checked for secrets before it reaches a model.
**Depends on**: Phase 72 (the guarantee needs the backends' network fence); Phase 71 (the credentials and delegation chain the broker checks, CRED-08)
**Requirements**: CRED-01, CRED-02, CRED-03, CRED-04, CRED-05, CRED-06, CRED-07, CRED-08
**Success Criteria** (what must be TRUE):
  1. Every credential an agent may use is a named handle bound to its audience hosts, and the extension refuses to send it anywhere else (MCP headers, web tools, project commands). (CRED-01)
  2. In container and OpenShell runs the process sees only a placeholder; the real value is added at the boundary only on a request to the bound endpoint in the bound placement (OpenShell providers, which refused endpoint and placement mismatches in the spike), and a canary leak test finds no real credential in the sandbox, its environment, a log line, the transcript or a model request. (CRED-02, CRED-06)
  3. Shell output, MCP results and fetched pages are checked for known secret formats before they reach a model, and a match is held back and shown, as prompts already are; this also covers an approved endpoint that echoes a credential back, which OpenShell does not scrub. (CRED-03)
  4. On the host backend the existing environment scrub stays and the UI says the broker's guarantee needs a sandbox; SECURITY.md says that the sandbox supervisor terminates TLS on the machine to enforce rules and add credentials, so request contents pass through it. (CRED-04)
  5. A child agent gets a credential handle only when its grant names it, and no credential value ever appears on a command line, in a process list or in a log (providers are created through the API or the bare-key form). (CRED-05, CRED-07)
  6. Before a real credential is added, the broker checks a signed invocation bound to that exact request (issuer, subject, audience, command, arguments, proof chain, nonce, a short expiry) against the agent's private credentials and their status; a replayed, expired, re-targeted or wider invocation is refused, every credential and lease is bound to one audience and the agent's own token is never passed through, a missing capability gets 403 `insufficient_scope` naming what a person can grant, and each use leaves a receipt in the signed log. (CRED-08)
**Research flags**: (1) The container backend's egress path: header injection for known APIs versus TLS interception with a per-run certificate authority (IronClaw's process sandbox does the latter); with OpenShell, use its providers and never a second broker in series. (2) Keep NEAR AI model calls in the extension, outside the sandbox, where possible (spike recommendation). (3) Migrating MCP connection settings that hold header and environment values today. (4) Signed invocations and audience binding (owner, 2026-11-16, PROJECT.md decisions 15 and 17; `agent-authz-prior-art.md`, section 8.4): take UCAN 1.0's invocation fields, its receipts and its revocation rules, ERC-7715's typed permission shapes for the approval a person reads, ERC-7710's one enforcer per restriction type, the audience binding of MCP authorization 2025-11-25 and RFC 9421 request signatures; decide where the invocation is signed (the engine outside the sandbox signs for the agent's identity, so a sandboxed process never holds a signing key), how the nonce record survives a restart, how the check sits with OpenShell's own endpoint binding (one broker, never two in series, flag 1), and, if NEP-413's message layout is reused, our own tag and recipient, documented, because NEP-413 expects a full-access key. Off-chain capabilities never go into NEAR's public key list (decision 15). (5) The broker is a single point of failure and the one store of every real credential (prior-art risks 11 and 12): redaction of everything it logs, what happens when it is down (fail closed, said plainly), and audience binding so it cannot be used as a confused deputy.
**Undo cost**: Medium. The invocation and receipt formats are written to the signed log, so settle them in research.
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 73 to break down)

### Phase 74: Run contracts
**Goal**: Every run no person started from the chat carries a signed contract with caps on cost, tool calls, time and sub-agents; a contract wider than its issuer's authority is refused before anything runs, and run admission works offline.
**Depends on**: Phase 71, Phase 72, Phase 73
**Requirements**: CTRT-01, CTRT-02, CTRT-03, CTRT-04, CTRT-05, CTRT-06, OFFL-04
**Success Criteria** (what must be TRUE):
  1. A contract names allowed capabilities, a cost cap, a tool-call cap, a wall-clock cap, the largest sub-agent tree, the backend required, whether approvals may wait or must deny, and an expiry, and it is signed by its issuer. (CTRT-01)
  2. A contract wider than its issuer holds (capabilities, budget, backend) is refused before anything runs, with the reason in plain words; admission needs no network and checks the chain of grants and credentials up to the person's signed policy, with status from cached status lists, and anything the local copy cannot cover fails closed. (CTRT-02, OFFL-04)
  3. Each cap stops the run at the next turn or tool call with an honest report naming partial results, and the effective cost cap is the smallest of the contract, the run budget and the daily limit. (CTRT-03)
  4. Unattended sub-agent runs in the editor get a contract derived from the lead's grant, and an approval nobody answers in a contract run expires to deny, never to allow. (CTRT-04, CTRT-05)
  5. The contract's hash and issuer are in the signed log at start and end, with actual use against each cap. (CTRT-06)
**Research flags**: (1) Reconcile with today's caps (`nearAi.agent.maxRunCostUsd`, the daily limit, `maxRunTokens`, the loop guard, the turn limit, Phase 26's unattended approval rules) so there is one effective cap, not two that disagree. (2) Clock trust: expiry on an edge device with no network time needs a rule (a monotonic counter, or a time vouched for by the last signed bundle); Phase 71's credential and grant expiry checks use the same rule (`identity-research.md`, risk 8).
**Undo cost**: Medium to high: the relay and routines store contracts.
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 74 to break down)

### Phase 74.1: Model passports, use tiers and Western defaults (INSERTED)
**Goal**: Every model request is checked against a signed model passport for the use tier of that request, so a model is used only for work your organization has approved it for; PRC-origin models stay available for research in an isolated lane; the extension ships Western defaults from one place; checking roles run on a different model family; and every output says which model, artifact and passport produced it.
**Depends on**: Phase 70 (the bundle, the gate, labels and routing); Phase 69 (the signer for risk acceptances); Phase 41 (the passport schema in report mode, the `models` section with `requires`, acceptances as `authorizations[]` records; coherence review 2026-11-20). It needs nothing from Phases 71 to 74, so it may run beside them; Phase 71 later replaces the device-key signature on acceptances with a credential.
**Inserted**: 2026-11-19 at the owner's request (model provenance decisions 1 to 4, `.planning/research/model-provenance/DESIGN.md`).
**Requirements**: MPRV-01, MPRV-02, MPRV-03, MPRV-04, MPRV-05, MPRV-06, MPRV-07, MPRV-08, MPRV-09, MPRV-10
**Success Criteria** (what must be TRUE):
  1. The signed bundle accepts an optional `ceiling.models` with passports (developer, origin, lineage, licence, legal flags, hosting class, artifact hash, evaluation reference, highest use tier, expiry, re-evaluation triggers) and T1 risk acceptances, under strict key checks; a bundle without it parses as before, and a model with no passport is usable at T0 only. (MPRV-01, MPRV-02)
  2. Each request's use tier (T0 to T3) is worked out from local facts (tools, context, writes, role, label, project type, lane) and only rises in a session; `checkRoute` refuses a model whose passport does not cover it, before anything is sent, with a plain sentence and a list of models that would pass, and nothing ever retries on another model by itself. (MPRV-03, MPRV-04)
  3. A PRC-origin model is refused for agent work, code, Protected B, staff and classified work, and for plain chat unless a signed, time-boxed risk acceptance by a named senior person covers that project and label; an expired passport or acceptance, or any re-evaluation trigger, drops the model to T0. (MPRV-05)
  4. An isolated research workspace (the T0 lane) runs adversary models with no project data and no write, run, network or MCP tools, and is the only place the cyber harness and Compare Models evaluations of PRC models open. (MPRV-06)
  5. Model defaults live only in `AGENT_DEFAULTS` and name Western passports (Nemotron 3, Command A+, gpt-oss-120b, Whisper, FLUX); duplicates in settings, config and the cyber handoff are gone, and a value a person set is kept. When no allowed model is available, the person sees the ways forward (organization hosting, a closed Western model only where the label allows any cloud, waiting for NEAR, the research workspace); a bundle without model rules runs in report mode until it adopts them. (MPRV-07, MPRV-08)
  6. Reviewers, the release guard, the tradecraft reviewer, red team, editor, plan checker and the safety classifier never run on the same model family as the work they check; with no other family allowed, a person decides. (MPRV-09)
  7. Route records, staff product headers and staff ledger entries carry the model, artifact hash and passport hash, and a per-project AI bill of materials (CycloneDX ML-BOM) lists every model used with its lineage. (MPRV-10)
**Research flags**: (1) Owner confirmations O1 to O5 in the design (report mode for installs with no organization policy, staff tiers, 90-day acceptances, the acceptance signer before Phase 71, shipped Western passports capped at T2). (2) The questions for NEAR (N1 to N8): Western models in the TEE, provenance fields in `/v1/models`, change notice, the weights hash in attestation, a Canadian region, licence pass-through. (3) Exact Western model ids are pinned only when hosted; passports never match by brand name (Llama-Nemotron and OpenReasoning-Nemotron are different lineages). (4) Switching embeddings rebuilds the knowledge base index.
**Undo cost**: Medium: passports and acceptances are written into signed bundles and records, so settle the schema in WP-0.
**Planned**: 2026-11-24 on `docs/phase-74.1-plan` (`.planning/phases/74.1-model-passports-use-tiers-and-western-defaults/`). The licence check found Command A+ 05-2026 under Apache 2.0 at Cohere and Hugging Face. Owner decisions of 2026-11-24: Command A+ runs through Cohere Model Vault or your organization's on-premise hosting, not NEAR AI's private hardware; report mode stays the default with a notice nobody can dismiss, and a security officer's signed Stop agent work now switch turns enforce on at once (mechanism recommended by Claude; 74.1-18 to 74.1-20 run when Phase 71 core including 71-09, 46-07 and 47-32 are on main; the rest of 74.1 merges in waves without them, with C-11 open until they land); under enforce every role needs your organization's evaluation; no self-signed exceptions (74.1-CONTEXT.md D-05, D-16, D-18a, D-20, D-28). Ten considerations (C-1 to C-10, 74.1-CONTEXT.md D-26) are filed in the gap register by 74.1-01 at execution as G407 to G416 (POA&M g408 to g416), with G417 (C-11, switch not landed) and G418 (C-12, the minute not measured) reserved for 74.1-16 and 74.1-17 if their condition holds, the next ids above PR #193's, re-checked at execution and before the integration PR merges. `/gsd-ui-phase 74.1` runs after wave 2 and before wave 3. Phase 74.3 depends on every plan; its interfaces are listed in 74.1-RESEARCH.md section 4.
**Plans:** 20 plans in 8 waves
**UI hint**: yes

Plans:
- [ ] 74.1-01-PLAN.md: Wave 1. Licences checked at the publishers and corrected (first task), Granite rows, every shipped model in the fit register, the ten considerations filed
- [ ] 74.1-02-PLAN.md: Wave 1. Tracer: a PRC model refused for agent work under enforce, before anything is sent; record and trust fields
- [ ] 74.1-03-PLAN.md: Wave 2. Every caller says its use; the project reaches the decision
- [ ] 74.1-04-PLAN.md: Wave 2. A sentence for every reason, the T1 exception (your organization's only), the non-commercial licence rule, the models that would pass, no retry
- [ ] 74.1-05-PLAN.md: Wave 2. Western defaults by passport in one place and the job resolver
- [ ] 74.1-06-PLAN.md: Wave 3. Passport lifecycle, re-evaluation triggers, revocation, evaluation before any role under enforce
- [ ] 74.1-07-PLAN.md: Wave 3. The research workspace
- [ ] 74.1-08-PLAN.md: Wave 3. The different-family rule, the safety classifier and the run's models by job
- [ ] 74.1-09-PLAN.md: Wave 4. Checking roles in team and staff runs; both families in records
- [ ] 74.1-10-PLAN.md: Wave 4. The cyber harness and Compare Models in the research lane
- [ ] 74.1-11-PLAN.md: Wave 4. Exceptions (t1-risk) drafted, signed and sent as a request under your organization's rules only
- [ ] 74.1-12-PLAN.md: Wave 5. Picker and directory words, the end of bare "Private", Apply only for writing-approved answers
- [ ] 74.1-13-PLAN.md: Wave 4. The empty-state card and the report-mode notice nobody can dismiss
- [ ] 74.1-14-PLAN.md: Wave 5. Staff product headers and signed entries carry the model and approval
- [ ] 74.1-15-PLAN.md: Wave 4. The per-project AI bill of materials (CycloneDX 1.6)
- [ ] 74.1-16-PLAN.md: Wave 7. Compliance statements (SA-4, SR-3, SR-4, SA-11, CM-8, CM-6), the gap register, the docs
- [ ] 74.1-17-PLAN.md: Wave 8. One full verification run, the owner's check on the Sterling container, the integration PR
- [ ] 74.1-18-PLAN.md: Wave 5. The signed model switch: format, the security officer check, its effect, desktop and edge import
- [ ] 74.1-19-PLAN.md: Wave 6. Stop agent work now and Return to report: the security officer's control in the workbench
- [ ] 74.1-20-PLAN.md: Wave 6. The hosted path: the hub publishes the verified switch, sessions mount and apply it

### Phase 74.2: Your organization's attested model hosting (INSERTED)
**Goal**: A model server your organization runs on confidential-computing hardware in a Canadian data centre counts as private once its attestation is verified, exactly like NEAR's private hardware, so Western models can serve labels that need attested hosting before NEAR hosts them.
**Depends on**: Phase 74.1 (passports and the `org-tee` hosting class); Phase 70 (routing and connection binding).
**Inserted**: 2026-11-19 at the owner's request (model provenance decision 1).
**Requirements**: OTEE-01, OTEE-02, OTEE-03, OTEE-04
**Success Criteria** (what must be TRUE):
  1. The bundle's optional `routing.attestedHosts` names each organization host with its expected measurements, accepted hardware roots and allowed model artifact hashes; a host it does not name never counts as attested. (OTEE-01)
  2. A request to a named host is sent only after its attestation verifies and the connection is bound to it (the D-50 rule); a wrong measurement, an unexpected weights hash or an unbound connection is refused before anything is sent, in plain words. (OTEE-02, OTEE-03)
  3. A verified `org-tee` model satisfies `attested-cloud` and is recorded with hosting `org-tee` and its attested artifact hash. (OTEE-04)
**Research flags**: (1) Run the same open-source private inference stack NEAR uses so one verifier serves both, or add a second verifier for NVIDIA NIM on confidential computing. (2) Attestation proves code and weights, not location: the Canadian location is recorded as a contractual fact. (3) The end-to-end check needs your organization's hosting to exist; the code and tests do not. (4) Reuse Phase 37's `VaultTransport` and `AttestationVerdict` shapes (`.planning/research/cohere-model-vault/DESIGN.md`, section 7.5) if Phase 37 lands first.
**Undo cost**: Low to medium: a new optional bundle key and a new hosting class.
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 74.2 to break down)

### Phase 74.3: Classification assistant (INSERTED)
**Goal**: A local Western model proposes labels with their bases as people write; the originator affirms the label in one signed step when they submit or release; only a person holding a `ClassificationAuthorityCredential` lowers it; content above what the system may hold is frozen and reported. AI proposes data attributes only, never person attributes.
**Inserted**: 2026-11-24 from the AI classification research (section 7.1). Owner decision D1 is accepted and D7 is revised: gpt-oss (20b primary, 120b at HQ), Nemotron 3 Nano, IBM Granite including Granite Guardian, and Command A+ only on the Cohere Model Vault classes and your organization's own on-premise hosting through its signed passport, never NEAR AI's hosting; your organization's signed passport may widen hosting (owner, 2026-11-24; 74.1 D-05) (a hosting rule: Command A+ 05-2026 is Apache-2.0, per Phase 74.1's licence check); each model gets a role only after evaluation and red-team at that level; no PRC models. The other owner decisions are owner-confirmed 2026-11-24 at the research defaults (`74.3-CONTEXT.md`); the UI design pass is not waived.
**Depends on**: Phase 70.1; Phase 74.1 (planned on `docs/phase-74.1-plan`; 74.3 imports its interfaces I-1 to I-12 of `74.1-RESEARCH.md` section 4: the passport step, the checking job's tier, the one matcher, the family rule, evaluation, passport state and triggers, the artifact rule, the shipped rows, trust facts, no retry, the model resource kind, the model-endpoints implemented requirements); Phase 71 (core) 71-03, 71-05 to 71-08, 71-12 and 71-13 (the research's "plans 1 to 5 and 7", mapped through `PLAN-IDS.md`); Phase 46 (46-01 to 46-08, `KeyService` and step-up in 46-07); Phase 33 (33-21 `session.certify` and the version acts, 33-23 the engine entry); Phase 33.1's marking plans 33.1-01 and 33.1-18 to 33.1-21 (74.3-13 only); a model server your organization lists (Phase 85's host or its own; Phase 74.2 for `org-tee`; Phase 36 for Command A+ through Model Vault).
**Requirements**: CLSF-06, CLSF-07, CLSF-08, CLSF-09, CLSF-10, CLSF-11, CLSF-12, CLSF-13, CLSF-14
**Success Criteria** (what must be TRUE):
  1. Content is classified only on a model server your organization's policy lists, at the system-high of its security domain and never on a commercial cloud, by a Western model whose passport covers the checking job and whose family differs from the writer's, with a second family at the levels the policy marks; any failure leaves the item unassessed with its rules, never lower. (CLSF-06)
  2. Every candidate model has a licence check and a compliance fit entry the resource check enforces, and gets a role at a level only after a signed evaluation report (per-level recall, over-classification, override rate, review load and time; red-team gate) passes there; model raises begin only after the shadow period and the blind audit's recall target. (CLSF-07)
  3. A native Classification panel beside the editor shows the label, each basis in plain words and the model and passport, offers only upward actions, and moves each item through six states, none of which waits on the network or a model. (CLSF-08)
  4. Submitting or releasing an item, including to an observer, needs the originator's one-step signed affirmation; the record names the person who classified it and the model that assisted. (CLSF-09)
  5. A label comes down, by any path, only with the signed approval of a person whose verified `ClassificationAuthorityCredential` covers the level and scope, after a passkey step; agents and devices never lower; a request is never dropped. (CLSF-10)
  6. A possible spill is frozen for sharing and reported, without its content, to your organization's security officer, who resolves it. (CLSF-11)
  7. Every output an agent writes, sends or summarizes is classified and raises the chat's label, including compilations spread over a conversation. (CLSF-12)
  8. A raise on a shared cell narrows its marking with its basis and leaves out holders `mayRelease` no longer allows at the next key; a lower marking needs an authority's `marking.approve`; observers never see proposals, rationales or bases. (CLSF-13)
  9. Proposals arrive a few seconds after edits settle and never block typing; the sizing estimates for an HQ of about 400 people are recorded as estimates until Phase 85 measures them, and the operator guide states no capacity figure. (CLSF-14)
**Research flags**: (1) llama.cpp token probabilities under grammar-constrained output on quantized gpt-oss (74.3-01; agreement signals are the fallback). (2) Command A+'s exact licence id and the Granite and Granite Guardian model ids (74.3-02). (3) Phase 85's throughput numbers. (4) Your organization's security classification guide format.
**Undo cost**: Medium to high. The affirmation, lowering approval, evaluation report and request formats are signed and stored; each is settled in its plan.
**Plans:** 15 plans in 10 waves (planned 2026-11-24 on `docs/phase-70.1-74.3-plan`; decisions D-01 to D-30 and six owner-confirmed items in `74.3-CONTEXT.md`; UI contract `74.3-UI-SPEC.md`, approved 2026-11-24)
**UI hint**: yes

Plans:
- [ ] 74.3-01-PLAN.md: Wave 1. Tracer: one item through a policy-listed model server to a recorded proposal; the closed answer, the confidence signal, fail closed
- [ ] 74.3-02-PLAN.md: Wave 1. The candidate models, their licence checks and compliance fit entries enforced by the resource check
- [ ] 74.3-03-PLAN.md: Wave 2. The runner at system-high: server and passport choice, two families, hidden text, the queue
- [ ] 74.3-04-PLAN.md: Wave 2. Evaluation and red-team: per-level metrics, calibration, the signed report, the shipped sets
- [ ] 74.3-05-PLAN.md: Wave 2. The native Classification panel to the UI-SPEC: the state machine with P3 and P12 to P16, the copy, lifted cards, the Raise dialog, the status bar entry
- [ ] 74.3-08-PLAN.md: Wave 2. Lowering only through `ClassificationAuthorityCredential`: the rule, the signed approval, the chat judge, the OpenBao inbox
- [ ] 74.3-06-PLAN.md: Wave 3. Signed affirmation before submit and release: the Affirm dialog
- [ ] 74.3-07-PLAN.md: Wave 3. Agent outputs and chats
- [ ] 74.3-09-PLAN.md: Wave 4. The Request a lower label dialog, Classification Reviews and its Requests section, approvals applied, Set Label's lower path
- [ ] 74.3-10-PLAN.md: Wave 5. The spill alert: the stored freeze, the Possible spills section, the signed resolution delivered back to the item
- [ ] 74.3-11-PLAN.md: Wave 6. Roles and the trial period on 74.1's passport state; the Model evaluation section
- [ ] 74.3-12-PLAN.md: Wave 7. The Blind audit section, the audit windows every session reads, the panel blind during an audit
- [ ] 74.3-13-PLAN.md: Wave 8. Cells: raise to the next key, lowering through `marking.approve`, observer release needs affirmation
- [ ] 74.3-15-PLAN.md: Wave 9. Render and accessibility checks of the UI-SPEC on the built image
- [ ] 74.3-14-PLAN.md: Wave 10. Sizing estimates, the operator guide, SECURITY.md, controls, full suites, integration PR

**Stage gate (after Phase 74):** Phases 69-74 are verified and merged before the data platform reads your organization's data (Phase 88 on) and before Phase 77 lets the relay run tools; Phase 77 also waits for the data platform gate (owner, 2026-11-18). The extension's releases carry each Stage 1 phase as it lands. v0.8.0 waits until everything else is finished (owner, 2026-11-15).

### Requirement coverage for this milestone

| Phase | Requirements | Count |
|-------|--------------|-------|
| 68 Relay foundation | RELAY-01 … RELAY-04 | 4 |
| 69 Team Mode reconciliation | TMR-01 … TMR-05 | 5 |
| 70 Capability vocabulary, manifests and one gate | GATE-01 … GATE-07, OFFL-01 … OFFL-03, CLAS-01 … CLAS-08 | 18 |
| 71 Identities, credentials and delegation that only narrows | DLGT-01 … DLGT-08, VCRD-01 … VCRD-07 | 15 |
| 72 Execution backends on a copy, with a guarded apply | EXEC-01 … EXEC-10 | 10 |
| 73 Credential broker | CRED-01 … CRED-08 | 8 |
| 74 Run contracts | CTRT-01 … CTRT-06, OFFL-04 | 7 |
| 74.1 Model passports, use tiers and Western defaults | MPRV-01 … MPRV-10 | 10 |
| 74.2 Your organization's attested model hosting | OTEE-01 … OTEE-04 | 4 |
| **Total** | | **81** |

Before the split of 2026-11-18 one table covered Phases 68 to 84 with 134 requirements; 67 stay here and 67 moved with Phases 75 to 84 to v0.7.0 Messaging relay (its table is at the end of that milestone). RUNL-05 (approvals in the private chat) is retired: APRV-01 … APRV-04 replace it with request-bound, signed approvals. The identity amendment of 2026-11-15 added CLAS-01 … CLAS-07 (Phase 70), DLGT-08 and VCRD-01 … VCRD-07 (Phase 71): 117 to 132. The owner added CLAS-08 (the trust badge, Phase 70) on 2026-11-16: 133. The owner's agent authorization decisions of 2026-11-16 added CRED-08 (signed, request-bound invocations checked by the broker, Phase 73): 134 in total. The L4 drafts ANCH-09 … ANCH-15 are not counted. The model provenance amendment of 2026-11-19 added MPRV-01 … MPRV-10 (Phase 74.1) and OTEE-01 … OTEE-04 (Phase 74.2): 81 in this milestone; their full text is drafted in the design and goes into REQUIREMENTS.md when the phases are planned.

## Milestone v0.6.0: Data platform

**Milestone goal:** Once installed, the platform finds your organization's data on its machines, file shares, Microsoft 365 and Google Workspace, reads it once from the beginning and then keeps up with every change, gives every item a full description card and a label that only rises, and lets people and agents search it, ask about it, report on it and turn it into small specialist models trained on your organization's own machines, always within their clearance and the source's own permissions. Policy is set once, and people see only real exceptions.

**Adopted 2026-11-18.** The owner accepted the research and design in `.planning/research/data-platform/` (`00-DESIGN.md`, decisions in its section 10) and the draft milestone `01-DRAFT-MILESTONE.md`, which is kept as the record; this roadmap and REQUIREMENTS.md are now the source of truth. Decisions 1 to 13 of the design's section 10.1 and its 32 settled-in-design choices were accepted as recommended. Decision 14 was changed to one-click connection ("easy from the start"), and the owner added collectors that are simple to install and training only on your organization's own machines or hardware endpoints it controls. PROJECT.md, Platform direction decisions 18 to 25, records them.

**Version:** v0.6.0, set by the owner on 2026-11-18 when the versions were renumbered to start at 0.5. v0.8.0 stays with the deferred cybersecurity milestone. Phases 85 to 101 are read from this heading, so v0.5.0 can be closed with `/gsd-complete-milestone` without taking them along.

**Where it sits.** After Stage 1 (v0.5.0, Phases 69 to 74, with Phases 28 and 29 beside it) and before v0.7.0 Messaging relay (Phases 75 to 84, below). Phases 85 and 86 need no Stage 1 code (the host and a test tenant), so they may start while Phases 72 to 74 finish. Nothing that reads your organization's real data starts before the Stage 1 gate, because it needs verified clearances (Phase 71), the credential broker (Phase 73) and run contracts (Phase 74). The milestone contains L1a, the host and local inference (Phase 85 and the host parts of Phase 88); L1b, the Theia appliance, stays a later milestone.

**Data platform gate (after Phase 101):** Phases 85 to 101 are verified and merged before Phase 77 lets the relay run tools (owner priority, 2026-11-18).

**Size.** 17 phases, more than the standard 4 to 6, as decided (design decision 2). The six stages (A to F) are the natural checkpoints: the data map ships value early, and the model factory runs beside the sources.

### Ground rules (carried from the paused knowledge base and Stage 1)

- A success criterion counts only when a test drives the real path. Source-text tests do not count.
- Every phase that adds a network destination extends the network-spy test; every phase that adds a place where data is written extends the canary leak scan.
- From Phase 88 on, every new view or count is computed reader-relative and extends the two-compartment indistinguishability test.
- Every new event id is named before it ships (D-49). Every gate format change is a v2 beside v1 (D-22).
- The licence check in CI covers code and model weights from Phase 85.
- Test runs on the host use memory caps (cgroup limits) and one heavy job at a time.
- Unlabelled content is never sent to a cloud model to find out what it is.

### Owner decisions and where they land

| Decision (design section 10.1; owner, 2026-11-18) | Answer | Phases |
|---|---|---|
| 1 Host slice of L1 | Split: L1a, the host and local inference, is built here; L1b, the Theia appliance, stays later | 85, 88; L1b |
| 2 Milestone identity | Its own milestone, Phases 85 to 101, between Stage 1 and the relay; the relay becomes its own milestone | this section |
| 3 Plaintext on the host | Postgres in plaintext on an encrypted disk, per-item keys for erasable content, an encrypted blob store; said plainly in SECURITY.md | 85, 88, 94, 101 |
| 4 Python on the host | Pinned, sandboxed worker containers; the engine and the gate stay TypeScript | 85, 92, 93, 98 |
| 5 Raw copies | Only the capped re-extraction cache (on by default for scans, images and audio, 10 percent of the host disk, 180 days), the write-once hold store and rare approved training snapshots | 92, 95 |
| 6 Mail and personal folders | Off by default; turned on only after your organization confirms a privacy assessment and an employee notice; mail then label-only | 89, 90, 91 |
| 7 What people learn about items they cannot see | Strict indistinguishability by default; "existence only" placeholders as an opt-in per scale | 96 |
| 8 Personal mark defaults | Own areas only; 5 GB and 20,000 items per person; location-only off; notice at override time, any delay at most 90 days and recorded | 94 |
| 9 Erasure and trained models | Retrain from the manifest within 30 days; the incumbent model takes over if the deadline passes | 99 |
| 10 Derivatives as records | They follow the original's retention class, are searched in requests and are listed as processing (pending counsel) | 94, 95, 101 |
| 11 Teacher models | Local, or attested NEAR AI TEE models as inference where the label's routing allows; training itself never leaves your organization's hardware | 98 |
| 12 Going live | One click to shadow, a second click for canary; auto-promotion off by default | 98 |
| 13 First training data | Chat and run logs first; organization data only after classification, holds and erasure exist, opt-in per source or collection and signed | 98, 99 |
| 14 Source onboarding (changed) | One-click connection: an administrator signs in once, and setup creates your organization's own app registration in its own tenant with a certificate generated on the host (private key never leaves the host, held in the broker) and grants admin consent; no shared multi-tenant app that we publish; Google Workspace and file shares get the same one click | 86, 89, 90, 91 |
| Added: collectors | Small signed native packages pushed by device management, zero-config enrolment with a code, automatic updates, a local notice with the personal mark; agentless where possible | 91 |
| Added: training hardware | Fine-tuning only on your organization's own machines or hardware endpoints it controls | 98 |

### What it absorbs from the paused knowledge base

The knowledge base of the paused former v0.5.0 knowledge-base plan returns here as the viewing layer (owner requirement R8), instead of moving to a separate project. Each paused phase is marked in `.planning/milestones/v0.5.0-paused/ROADMAP.md` with where it went. The Phase 13 code on its local branch is read with `git show` and ported piece by piece; it is not merged as a branch.

| Former v0.5.0 phase | Disposition | Lands in |
|---|---|---|
| 13 Sovereignty gate, PQ crypto, encrypted log | Carries with changes: PQ primitives, signed segments, the four-timestamp fold, crypto-shredding, canary scan and network spy harnesses carry; envelope v2 for lattice labels; sharded item-key store; per-label routing replaces KB mode; device identity replaces the KB vault | 88 (log and harnesses), 94 (crypto-shredding) |
| 14 Encrypted scalable store and search | Superseded by the host store (Postgres, pgvector, BM25). "Benchmark first" and "damaged data reported, never replaced by an empty base" carry | 88, 96 |
| 15 Intake with agent tools | Changes: connectors replace hand intake; quote-verified evidence, untrusted-on-read fencing, proposed links with undo, importers (CSV, STIX, GeoJSON), the offline gazetteer and the panel shell carry | 96 (evidence, links, shell), 100 (importers) |
| 16 Admiralty grading and reports | Carries as an optional trust layer for intelligence projects; ReportBuilder and ReportVerifier carry for all reports | 97 (reports); grading after this milestone |
| 17 RAFT network and slices | Changes: RAFT becomes one ontology profile; slices become saved scopes | 97 |
| 18 Feeds, unattended work, alerts | Superseded in part: feeds become connectors; the spend governor carries; tripwires become insights | 92 and 96 (governor), 97 (insights) |
| 19 Team sharing | Superseded by L2 | none |
| 20 Compartments, roles, access | Changes, and becomes the core: compartments are label compartments, roles are Phase 71 credentials; the reader-relative rule and the two-compartment indistinguishability test carry unchanged | 88, 93, 96, 101 |
| 21 Ciphertext relay | Superseded by the Phase 68 relay and L5 | none |
| 22 Globe and timeline | Timeline carries; the globe is deferred | 97 |
| 23 Forecasting | Deferred, intelligence projects only | none |
| 24 Hardening and release | Carries, extended to the database, caches and model server logs | 101 |

### Canadian English and French

Canadian deployments require a user-switchable English and French experience across the Workbench, setup and administration, plus both language renditions of approved shared products. Add source-linked translation and professional review to published outputs. Evaluate approved local or private translation options through Model Factory and extend the same controls to authorized multilingual document intake. Track the cross-cutting requirements LANG-01 to LANG-03 across Workbench localization, Phase 96 and Phase 98. See [Canadian official-language requirements and sequencing](research/canadian-official-languages.md).

### Stage A: host and spikes (Phases 85-87)

### Phase 85: Host and local inference on Strix Halo (L1a), measured
**Goal**: The always-on host your organization owns runs the platform's container stack on the Strix Halo machine, installs with one command from a signed offline bundle, serves local models to the extension, and the throughput numbers the design estimates are measured rather than guessed.
**Depends on**: Nothing in code. Owner decisions 1 (L1a in this milestone) and 4 (Python worker containers). May start while Stage 1 Phases 72 to 74 finish.
**Requirements**: SPIKE-01, SPIKE-02, SPIKE-03
**Success Criteria** (what must be TRUE):
  1. The stack installs with one command from a signed offline bundle, comes up with no network and survives a host reboot, and RLS refuses a query that carries no clearance token. (SPIKE-01)
  2. A chat in the extension answers from a model served on the host through a hybrid profile, with ROCm and Vulkan both measured. (SPIKE-02)
  3. One LoRA adapter on a 4B base is trained on the host, converted, served and answers through the extension. (SPIKE-03)
  4. A measurement table replaces the low-confidence estimates of research reports 01 section 6.2, 03 section 1.2 and 04 section 3.4, and the design is updated wherever a number changes a decision. (SPIKE-03)
**Research flags**: Spike by definition. The exact ROCm and PyTorch pairing for gfx1151, how much of the unified memory the GPU can address, and Vulkan as the dependable fallback. SPIKE-01 and SPIKE-02 build the lasting host (L1a), not a throwaway (decision 1 rejected a throwaway host); L1b later adds Theia, the engine and the relay to the same stack.
**Undo cost**: Medium: the offline bundle format and image layout are what your organization installs on a machine without network.
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 85 to break down)

### Phase 86: Microsoft 365 connector spike
**Goal**: The Microsoft 365 risks, including the one-click setup path, are answered against a real test tenant before the connector is built.
**Depends on**: A test tenant; nothing in code. Owner decision 14 (one-click connection). May run beside Phase 85.
**Requirements**: SPIKE-04, SPIKE-05, SPIKE-06, SPIKE-09
**Success Criteria** (what must be TRUE):
  1. A written finding per question, each with the recorded calls, feeds the Phase 89 plan. (SPIKE-04, SPIKE-05, SPIKE-06)
  2. From one administrator sign-in, the setup sequence creates an app registration in the test tenant, uploads a certificate generated on the host whose private key never leaves it, and grants admin consent for the least permissions, each with a reason an administrator can read; the certificate then rotates with no new sign-in, and nothing of the sign-in is kept. (SPIKE-09)
  3. A budget calculator predicts backfill days for a given inventory within 25 percent of a measured run on the test tenant. (SPIKE-06)
**Research flags**: Spike by definition. Which public client the administrator's one sign-in goes through, so that no app of ours or of any other publisher has to exist in your organization's tenant before setup, and what that sign-in can do while it lasts; whether Exchange RBAC for Applications scoping (for mail, which is off by default) can be set in the same flow or needs a command shown to the administrator; how the app adds its next certificate itself with proof of the current one.
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 86 to break down)

### Phase 87: Extraction and OCR throughput spike
**Goal**: The extraction and OCR tiers are chosen from measurements on the host, not estimates.
**Depends on**: Phase 85.
**Requirements**: SPIKE-07, SPIKE-08
**Success Criteria** (what must be TRUE):
  1. Pages per second and accuracy per tier are recorded on the fixed test set, and the page-difficulty router sends no more than the measured share of pages to the GPU tier. (SPIKE-07, SPIKE-08)
  2. The backlog estimate for the 500-person planning model (research report 01 section 6.1) is recomputed from these numbers. (SPIKE-07)
**Research flags**: Spike by definition; weight licences confirmed for every OCR and vision model tried.
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 87 to break down)

### Stage B: the data map and the sources (Phases 88-92)

### Phase 88: Ingestion core, governed store and the data map
**Goal**: Your organization sees a live map of what data exists, where, how big, who owns it and how fresh it is (inventory and metadata only, no content), and everything shown is filtered by the viewer's clearance and the source's permissions from the first screen.
**Depends on**: Phase 85; the Stage 1 gate (Phases 70, 71, 73 and 74).
**Requirements**: DATA-01, DATA-02, DATA-03, DATA-04, DATA-05, DATA-06, DATA-07, DATA-08, DSEC-01, DSEC-02, DSEC-03
**Success Criteria** (what must be TRUE):
  1. Pointing the host at a folder tree fills the data map within the measured time, the source moving from `proposed` through `backfilling` to `live` with each state's reason shown; deleting, renaming and re-permissioning files there shows up within the freshness target. (DATA-03, DATA-05, DATA-06, DATA-08)
  2. Killing the host mid-batch replays that batch with no duplicate and no gap, and a forced "missed something" signal moves the source to `degraded` and resyncs it with nothing lost. (DATA-01, DATA-02, DATA-04)
  3. Two people with different clearances and permissions see different maps, each identical to the map of a base that never held the other's items (the indistinguishability test), and an item whose permission snapshot is stale is hidden, never shown. (DSEC-01, DSEC-02, DATA-08)
  4. No content is read in dry-run mode, every discovered item carries the ingest-default label from its first moment, every label, permission and lifecycle event is in the signed governance log, and the canary scan finds no content in the store, logs or caches. (DATA-07, DSEC-03)
**Research flags**: Standard patterns documented in the research; plan without a research step. The host parts of L1a land here (the governed store and its RLS on the Phase 85 stack).
**Undo cost**: High: the connector contract, the item ledger keys and the label store format are what every connector and every later phase writes to.
**Plans:** 0 plans
**UI hint**: yes

Plans:
- [ ] TBD (run /gsd-plan-phase 88 to break down)

### Phase 89: Microsoft 365 connector with one-click connection
**Goal**: An administrator connects Microsoft 365 with one sign-in, and SharePoint, OneDrive and Exchange appear in the data map, then backfill and stay in sync, with their permissions and labels.
**Depends on**: Phases 86 and 88; Phase 73 (the broker holds the certificate).
**Requirements**: DATA-09, DATA-10, DATA-11, DATA-12, DATA-13, CONN-01, CONN-02, GUIDE-09 (the guided setup's data-connection step, `.planning/research/guided-onboarding/DESIGN.md` section 11)
**Success Criteria** (what must be TRUE):
  1. On the test tenant, an administrator signs in once and setup creates your organization's own app registration with a certificate generated on the host and admin consent; no shared app is used, nothing of the sign-in is kept after setup, and the sites, drives and mailboxes appear as a `proposed` source in inventory-only mode. (CONN-01, DATA-09)
  2. A backfill completes and the source reaches `live`, and a file's permission change hides the file from a removed person before their next query. (DATA-10, DATA-11)
  3. A forced 410 moves the source to `degraded` and then back to `live` with no lost item. (DATA-10)
  4. The wizard shows every permission with its reason, mail stays off until your organization's confirmation is recorded, and Purview labels (unreadable and double-key items included) map to our labels and never lower them. (DATA-12, DATA-13)
  5. A setup interrupted midway finishes on re-run without duplicating anything, the certificate rotates with no new sign-in, and Disconnect lists what setup created and removes it only after the administrator confirms. (CONN-02)
**Research flags**: Permission fidelity and budgets from Phase 86; the v1.0 permission table for label reads.
**Plans:** 0 plans
**UI hint**: yes

Plans:
- [ ] TBD (run /gsd-plan-phase 89 to break down)

### Phase 90: Google Workspace connector with one-click connection
**Goal**: An administrator connects Google Workspace with one sign-in, and Drive, shared drives and Gmail appear in the data map and stay in sync, with their permissions and Drive labels.
**Depends on**: Phase 88; Phase 73. Uses the setup behaviour of CONN-02 from Phase 89.
**Requirements**: DATA-14, DATA-15, DATA-16, CONN-03
**Success Criteria** (what must be TRUE):
  1. On a test domain, an administrator signs in once and setup creates the project, service account and credential in your organization's own Google Cloud and authorizes exactly the listed scopes; a step Google allows only in its admin console is one prefilled page that setup opens and then checks. (CONN-03, DATA-14)
  2. A mailbox larger than the history window backfills with no gap. (DATA-15)
  3. Removing a user from a shared drive hides its items from that user within the permission target, and Drive labels map to our labels and never lower them. (DATA-16)
**Research flags**: Quotas checked in a test project; keyless or short-lived service-account credentials on an on-premises host (organization policies that block service-account keys are common); which setup steps Google exposes through APIs (project, API enablement, service account, domain-wide delegation) and which need the one prefilled admin console page. Mail follows decision 6.
**Plans:** 0 plans
**UI hint**: yes

Plans:
- [ ] TBD (run /gsd-plan-phase 90 to break down)

### Phase 91: Endpoint collectors, file shares and simple install
**Goal**: Windows, macOS and Linux machines and file shares are discovered and kept in sync without ever pulling cloud placeholder files down; file shares are read from the host with nothing installed on the file servers, and endpoint collectors install, enrol and update through your organization's device management with no setup on each machine.
**Depends on**: Phase 88; Phase 71 (enrolment gives each collector a device binding credential); Phase 73 (the broker holds the file-share account).
**Requirements**: DATA-17, DATA-18, DATA-19, DATA-20, DATA-21, CONN-04, COLL-01, COLL-02, COLL-03, COLL-04, COLL-05, COLL-06
**Success Criteria** (what must be TRUE):
  1. A machine with a synced cloud folder causes zero placeholder downloads, and files that live only on that machine show "may disappear" in coverage. (DATA-17, DATA-18, DATA-19)
  2. Wrapping the change journal or overflowing the event queue triggers a rescan of the affected folders, with no lost item. (DATA-17, DATA-18)
  3. An administrator connects file shares with one sign-in, the host reads them over SMB and NFS with nothing installed on the file servers, and their NTFS and POSIX permissions hold for every reader. (CONN-04, DATA-20, COLL-05)
  4. A collector pushed silently by device management (an MSI through Intune or Group Policy, a signed pkg through Jamf or Intune, a .deb or .rpm, or the one-line install) enrols with the host from a code with no prompt on the machine, talks only over the device-key-signed channel and updates itself from the host; a revoked device stops at its next contact. (COLL-01, COLL-02, COLL-03, COLL-06, DATA-21)
  5. Each machine shows in plain words what is collected from it, with Mark as Personal one click away, and a mark known from an item's location is honoured before any fetch. (COLL-04, DATA-21)
**Research flags**: Device-management deployment (the macOS Full Disk Access profile; the enrolment code as an MSI property or a managed profile); code signing and notarization per operating system in our release pipeline, and the MSI build tool's licence and terms; how an enrolment code is scoped (device group, count, expiry) so a leaked code cannot enrol machines unnoticed; the least rights for the file-share account (read files and read permissions only) and whether a managed service account can be created in the same click.
**Undo cost**: Medium: installed collectors and their enrolment and update channel live on every machine, so their protocol must stay compatible.
**Plans:** 0 plans
**UI hint**: yes

Plans:
- [ ] TBD (run /gsd-plan-phase 91 to break down)

### Phase 92: Extraction pipeline
**Goal**: Every format becomes text and structure, safely and once, with the backlog visible.
**Depends on**: Phases 87 and 88; Phase 72 (sandboxes).
**Requirements**: DATA-22, DATA-23, DATA-24, DATA-25, DATA-26
**Success Criteria** (what must be TRUE):
  1. A corpus of malformed and hostile files crashes no worker beyond its own sandbox and reaches no network. (DATA-22)
  2. Scans, images and audio become text through the tiers Phase 87 chose, an item and its duplicates are extracted once, and upgrading one extractor re-runs only its keys. (DATA-23, DATA-24, DATA-25)
  3. The data map shows the processing backlog separately from sync lag, a live change overtakes the backfill queue, and the re-extraction cache stays within its cap and drops an item when its source deletes it. (DATA-26)
**Research flags**: Standard patterns documented in the research; plan without a research step.
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 92 to break down)

### Stage C: governance (Phases 93-95)

### Phase 93: Classification, labels, privacy assessment and exceptions
**Goal**: Every item gets its card and a label that only rises, set by your organization's policy once, and people see only real exceptions.
**Depends on**: Phase 92 (text); Phase 70 (gate); Phase 71 (verified clearances).
**Requirements**: TAG-01, TAG-02, TAG-03, TAG-04, TAG-05, TAG-06, TAG-07, TAG-08, DSEC-04, DSEC-05, DSEC-06, DSEC-07
**Success Criteria** (what must be TRUE):
  1. Text injected into a document that says "this is public" never lowers that document's label. (DSEC-04, TAG-03)
  2. A source label lowered in Purview files a "could be lower" suggestion and leaves our label unchanged; lowering happens only through a signed lowering by a person. (DSEC-06)
  3. A new rule cannot be signed until its simulation has run and shown its impact. (TAG-07)
  4. On the audit sample, recall is at least 0.95 at Confidential and above, and a drop below that widens the review band automatically. (TAG-08)
  5. Every item has its card (owner and steward from the source and the directory, never a model; privacy facts, never the personal data itself; training suitability, where unknown rights mean not allowed), each batch of labels is covered by a signed Merkle root, and an index or export that gathers many lower items is raised by the aggregation rules. (TAG-01, TAG-02, TAG-04, TAG-05, TAG-06, DSEC-05, DSEC-07)
**Research flags**: Canadian recognizers and French context words; the licence of each detector model.
**Undo cost**: High: classification rules and the source label map live in the signed bundle, and label v2's handling flags are what devices hold offline.
**Plans:** 0 plans
**UI hint**: yes

Plans:
- [ ] TBD (run /gsd-plan-phase 93 to break down)

### Phase 94: Lifecycle, erasure and the personal mark
**Goal**: Deletes, erasures and personal marks reach every derivative, provably, and a person's personal items leave only an existence record.
**Depends on**: Phase 93.
**Requirements**: DSEC-08, DSEC-09, DSEC-10, MARK-01, MARK-02, MARK-03, MARK-04, MARK-05
**Success Criteria** (what must be TRUE):
  1. After an erasure, the canary scan finds the item's text in no table, vector, cache, log or dataset row, and a signed erasure proof lists every derivative removed. (DSEC-08, DSEC-09)
  2. A marked folder produces no chunk, vector, entity, count or search hit for anyone, and coverage reports it as a count only; unmarking brings it back at the ingest default and never lower than its old label. (MARK-02, MARK-03)
  3. An agent cannot set a mark, a mark where policy forbids it is refused at once with the reason, and the defaults of decision 8 apply until your organization changes them in the signed bundle. (MARK-01, MARK-04)
  4. Each item shows its retention class, which its derivatives follow, the ROT report lists candidates without deleting anything, and unusual marking (volume, timing after a hold notice) starts the stepped escalation from metadata alone. (DSEC-10, MARK-05)
**Research flags**: Standard patterns documented in the research; plan without a research step.
**Plans:** 0 plans
**UI hint**: yes

Plans:
- [ ] TBD (run /gsd-plan-phase 94 to break down)

### Phase 95: Legal holds and access requests
**Goal**: Holds and requests are first-class cases across every source and every derivative, with clocks, custody and an honest coverage statement.
**Depends on**: Phase 94; Phase 71 (officer roles); Phase 29 (the CleanUp never-touch list).
**Requirements**: HOLD-01, HOLD-02, HOLD-03, HOLD-04, HOLD-05, HOLD-06, HOLD-07, HOLD-08, HOLD-09, HOLD-10
**Success Criteria** (what must be TRUE):
  1. A hold shows each source as `pending` until it confirms and stays visibly `partial` while a source has no hold feature or failed and its write-once copy runs; deleting a held item at the source keeps its derivatives, records the attempt and alerts the hold administrator. (HOLD-01, HOLD-02, HOLD-04)
  2. CleanUp, retention, ROT and dataset and model deletion each refuse a held item through their own code check. (HOLD-03)
  3. A request reaching 95 percent of its time shows the warning, and an extension cannot be recorded without its notice. (HOLD-05)
  4. A request's search covers our indexes, live source searches (with cursor age) and lineage down to derivatives and models, under a time-boxed grant with recusal and the two-person rule above the officer's clearance, and every redaction is confirmed one by one with its exemption code. (HOLD-06, HOLD-07, HOLD-09)
  5. A released package verifies against its signed manifest, its coverage statement names every source not searched, and a personal-mark override shows `notice-pending` to the privacy officer until notice is sent. (HOLD-08, HOLD-10)
**Research flags**: Purview and Vault hold API maturity (some parts were beta only); regime clock data reviewed by counsel.
**Undo cost**: High: custody logs, hold manifests and release packages are legal records.
**Plans:** 0 plans
**UI hint**: yes

Plans:
- [ ] TBD (run /gsd-plan-phase 95 to break down)

### Stage D: the knowledge layer (Phases 96-97)

### Phase 96: Search, context graph, entity pages and ask
**Goal**: People find anything they are cleared for in one search box, see everything about a customer or project across sources, and ask questions answered with citations, within their clearance. The paused knowledge base becomes this view layer.
**Depends on**: Phase 93.
**Requirements**: KB-01, KB-02, KB-03, KB-04, KB-05, KB-06, KB-07, KB-08, KB-15
**Success Criteria** (what must be TRUE):
  1. A person cleared only for compartment A gets results, entity pages and answers identical to those from a base that never held compartment B. (KB-07, KB-08)
  2. A search with a very selective clearance still returns the full top-k. (KB-01)
  3. Every answer's citations open the exact source span, and the answer carries its high-water label and is routed by it. (KB-02, KB-06)
  4. Entity pages show a customer or project across sources; a merge of two entities is a proposal with undo, and model-written relations run only on priority items under the spend governor, each backed by a verified quote. (KB-03, KB-04, KB-05)
  5. With your organization's opt-in for a scale, a person sees only that an item exists, its steward and a request-access button, and only for items whose discovery description a person approved; with it off (the default), nothing shows. (KB-15)
  6. The right-side Context Graph action opens the same native landing in English and French. With a governed workspace data source, people can explore the authorized graph by strategic, operational or tactical detail, then narrow it by area of interest, activity, responsibility and time. Citations reopen the source version and span the reader can access.
**Research flags**: Mosaic and Splink licences and dependency trees; pgvector recall at low clearance.
**Plans:** 0 plans
**UI hint**: yes

Plans:
- [ ] TBD (run /gsd-plan-phase 96 to break down)

### Phase 97: Analytics, reports, insights and views
**Goal**: Dashboards, reports and suggested insights appear without setup, with every number computed under the viewer's clearance.
**Depends on**: Phase 96.
**From the portfolio design (2026-11-20)**: the knowledge base views become the rendering and ad-hoc analysis layer over the portfolio's publication fold (Phases 38 to 40), with the same viewer-clearance rule; the aggregation rule evaluator built in Phase 38 is the one Phase 93 extends.
**Requirements**: KB-09, KB-10, KB-11, KB-12, KB-13, KB-14
**Success Criteria** (what must be TRUE):
  1. Dashboard totals for two clearances each match the totals of the corresponding single-clearance base. (KB-09)
  2. Model-written SQL that tries to set its own clearance is refused, and every question shows the SQL it ran. (KB-10)
  3. A report fails verification after any underlying figure changes. (KB-12)
  4. Suggested insights appear with no setup, each with its query; the graph explorer and timeline replay ("as known at T") work within saved scopes and say when a view was cut at its cap; and a label-change preview shows who would gain or lose access before a label changes. (KB-11, KB-13, KB-14)
  5. People can save a graph view and subscribe to changes they are authorized to see. A workspace owner can publish a versioned mission context. Human and delegated agent workflows resolve that same definition under current membership, source access and clearance. Hidden changes generate no observable update, and revocation suppresses queued delivery and clears stale evidence.
**Research flags**: Standard patterns documented in the research; plan without a research step.
**Plans:** 0 plans
**UI hint**: yes

Plans:
- [ ] TBD (run /gsd-plan-phase 97 to break down)

### Stage E: the model factory (Phases 98-99)

### Phase 98: Model factory v1, first specialist from chat and run logs
**Goal**: One specialist goes from proposal card to live for one role, trained on suitable approved hardware from your organization's network, matching or beating the incumbent, with rollback tested. The Model Factory also owns the planned classification and protection adviser's training and fine-tuning.
**Depends on**: Phase 85 (the host trainer); Phase 74 (contracts). It needs none of Phases 88 to 97, so it runs beside them. Owner decisions 11, 12 and 13.
**Requirements**: FAC-01, FAC-02, FAC-03, FAC-04, FAC-05, FAC-06, FAC-07, FAC-08, FAC-09
**Success Criteria** (what must be TRUE):
  1. A specialist for one role is live, is at least as good as the incumbent on held-out tasks, and is cheaper or faster. (FAC-03, FAC-04, FAC-05, FAC-07)
  2. A session below the model's label cannot route to it, and requests fall back to the incumbent while the host is down. (FAC-08)
  3. One click takes a specialist to shadow and a second to canary (auto-promotion off by default), and a rollback restores the previous model in one click with a recorded reason. (FAC-06)
  4. No training job calls any network destination outside the machine it runs on. (FAC-01)
  5. A training job that names a machine outside your organization's listed training targets, or a base whose licence is blocked, is refused before it starts. If no approved target fits the workload, the proposal shows why it is infeasible. Teacher calls follow the label's routing. (FAC-02, FAC-09)
**Research flags**: Phase 85 measures the reference ROCm and PyTorch pairing. Check the chosen target's backend, capacity and approval for each workload.
**Plans:** 0 plans
**UI hint**: yes

Plans:
- [ ] TBD (run /gsd-plan-phase 98 to break down)

### Phase 99: Opportunity agent, data-gap planning and specialists from organization data
**Goal**: The always-watching agent finds optimization opportunities in how the system and the business are used, proposes them on one-click cards, plans how to get missing data, and trains specialists on classified organization data within rights, marks and labels.
**Depends on**: Phase 98; Phase 93 (training suitability); Phase 94 (erasure triggers retraining); Phase 74.
**Requirements**: OPP-01, OPP-02, OPP-03, OPP-04, OPP-05, OPP-06, OPP-07
**Success Criteria** (what must be TRUE):
  1. With content access off, the agent proposes at least one real opportunity from metadata alone, on a card that says who can approve it. (OPP-01, OPP-02, OPP-03)
  2. A goal with too few examples produces a data plan rather than a dead end. (OPP-04)
  3. An erasure that touches a dataset retrains and swaps the adapter, or falls back to the incumbent, within the deadline. (OPP-07)
  4. The agent cannot read content its approver's clearance does not dominate. (OPP-02)
  5. A specialist trained on organization data uses only training-allowed items from sources or collections opted in with a signature, one compartment at a time, and no opportunity scores a named person. (OPP-05, OPP-06)
**Research flags**: Standing-policy wording for content clustering; employee-monitoring notice text.
**Plans:** 0 plans
**UI hint**: yes

Plans:
- [ ] TBD (run /gsd-plan-phase 99 to break down)

### Stage F: continual sources and release (Phases 100-101)

### Phase 100: Easy sources: catalog, manifest connectors, agent-written connectors, databases
**Goal**: Adding a new source takes a few clicks, and agents can write new connectors safely.
**Depends on**: Phase 88; Phases 72 and 73. May start any time after Phase 92 if capacity allows.
**Requirements**: DATA-27, DATA-28, DATA-29, DATA-30, DATA-31, DATA-32
**From the portfolio design (2026-11-20)**: financial, procurement and schedule sources feed the portfolio's publications (Phases 38 to 40) as released, labelled items, never as raw cross-unit access (`.planning/research/portfolio-and-assignment/DESIGN.md`, 10.4).
**Success Criteria** (what must be TRUE):
  1. An agent writes a connector for a REST source that passes conformance and runs after one approval. (DATA-28, DATA-29, DATA-30)
  2. A connector that tries an undeclared host is blocked and recorded. (DATA-29)
  3. A Postgres source reaches `live` through CDC, and dropping its connection releases the replication slot. (DATA-31)
  4. The source catalog shows each source in plain words with its exact scopes, their reasons and an estimated backfill time, and CSV, STIX and GeoJSON imports and the offline gazetteer from the paused knowledge base work through it. (DATA-27, DATA-32)
**Research flags**: Standard patterns documented in the research; plan without a research step.
**Plans:** 0 plans
**UI hint**: yes

Plans:
- [ ] TBD (run /gsd-plan-phase 100 to break down)

### Phase 101: End-to-end hardening and release
**Goal**: The milestone keeps its promises under attack-style and at-scale checks, and the product copy says only what is true.
**Depends on**: Phases 85 to 100.
**Requirements**: DSEC-11, DSEC-12, DSEC-13, DATA-33
**Success Criteria** (what must be TRUE):
  1. The canary scan, the network spy and the indistinguishability test cover every flow, view, count, answer, dashboard and specialist, and every DSEC check is green in CI. (DSEC-11, DSEC-12)
  2. The scale run at 1 million items and 10 million mail headers on one host meets its recorded budgets. (DSEC-13)
  3. SECURITY.md and README say plainly that content is in plaintext on the host's encrypted disk and what clearances guarantee, and counsel's review items from decisions 6, 8, 9 and 10 are recorded as closed or explicitly deferred. (DATA-33)
**Research flags**: Standard patterns documented in the research; plan without a research step.
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 101 to break down)

### Order and parallel waves

| Wave | Phases | Why this order |
|------|--------|----------------|
| 0 | 85, 86 (during the Stage 1 tail) | They remove hardware and tenant uncertainty and touch no product code |
| 1 | 87, 88, 98 | 88 and 98 need only the host; 87 needs the host |
| 2 | 89, 90, 91, 92 (100 optional) | All plug into 88's contract independently |
| 3 | 93 | Needs text from 92 |
| 4 | 94, 96 | Both need labels; neither needs the other |
| 5 | 95, 97, 99, 100 | 95 needs 94; 97 needs 96; 99 needs 93, 94 and 98 |
| 6 | 101 | Everything |

Sequential links that cannot be split: 93 waits for 92 (classification needs text); 95 waits for 94 (holds suspend the deletion paths 94 builds).

**Visible value by wave:** wave 1 delivers the data map on the host and the first local specialist; wave 2 extends the map to every first source, each connected in one click and inventory-only on its first day; wave 4 delivers search and ask; wave 5 delivers holds, requests, dashboards and the opportunity agent.

### Requirement coverage for this milestone

| Phase | Requirements | Count |
|-------|--------------|-------|
| 85 Host and local inference on Strix Halo (L1a) | SPIKE-01 … SPIKE-03 | 3 |
| 86 Microsoft 365 connector spike | SPIKE-04 … SPIKE-06, SPIKE-09 | 4 |
| 87 Extraction and OCR throughput spike | SPIKE-07, SPIKE-08 | 2 |
| 88 Ingestion core, governed store and the data map | DATA-01 … DATA-08, DSEC-01 … DSEC-03 | 11 |
| 89 Microsoft 365 connector with one-click connection | DATA-09 … DATA-13, CONN-01, CONN-02 | 7 |
| 90 Google Workspace connector with one-click connection | DATA-14 … DATA-16, CONN-03 | 4 |
| 91 Endpoint collectors, file shares and simple install | DATA-17 … DATA-21, CONN-04, COLL-01 … COLL-06 | 12 |
| 92 Extraction pipeline | DATA-22 … DATA-26 | 5 |
| 93 Classification, labels, privacy assessment and exceptions | TAG-01 … TAG-08, DSEC-04 … DSEC-07 | 12 |
| 94 Lifecycle, erasure and the personal mark | DSEC-08 … DSEC-10, MARK-01 … MARK-05 | 8 |
| 95 Legal holds and access requests | HOLD-01 … HOLD-10 | 10 |
| 96 Search, context graph, entity pages and ask | KB-01 … KB-08, KB-15 | 9 |
| 97 Analytics, reports, insights and views | KB-09 … KB-14 | 6 |
| 98 Model factory v1 | FAC-01 … FAC-09 | 9 |
| 99 Opportunity agent and data-gap planning | OPP-01 … OPP-07 | 7 |
| 100 Easy sources | DATA-27 … DATA-32 | 6 |
| 101 End-to-end hardening and release | DSEC-11 … DSEC-13, DATA-33 | 4 |
| **Total** | | **119** |

The draft had 106. Adopting it added SPIKE-09 and CONN-01 … CONN-04 (decision 14 as changed), COLL-01 … COLL-06 (collector packaging and enrolment), FAC-09 (training only on your organization's own machines or hardware endpoints it controls) and KB-15 (decision 7's opt-in placeholder, which no draft requirement built): 119.

## Milestone v0.7.0: Messaging relay

**Milestone goal:** People reach their teams from Microsoft Teams, Signal and Telegram through a relay, without VS Code: the group sees only the finished result, the working thread stays private to whoever asked, and every relay run executes under a contract in a sandbox, on the governance layer of v0.5.0.

**Split from the governed agent platform on 2026-11-18** (owner, data platform decision 2; that milestone was numbered v0.7.0 until the renumbering the same day and is now v0.5.0): the relay stages run after v0.6.0 Data platform. Phase numbers, requirements and their mappings do not change. Phase 68, the relay foundation, stays recorded in v0.5.0 because it shipped as "v0.7.0 Phase 68" (now v0.5.0); its carried items are in v0.5.0's "Carried from Phase 68" table, and its old and new numbers are in v0.5.0's table of them. Phase 75 keeps its permission to start early in its own worktree, because it touches only `relay/`; Phase 77, the first phase that runs tools for people, waits for the Stage 1 gate and the data platform gate.

**Version:** v0.7.0, set by the owner on 2026-11-18 when the versions were renumbered to start at 0.5.

### Stage 2: the relay on the governed core (Phases 75-81)

Build order follows the trust boundary, as before: inbound authenticity with adversarial tests before any happy path (6 of 8 ranked pitfalls are High and sit here), then identity and pairing, then a Teams 1:1 slice (deliberately not groups first), the setup view, budgets once real runs exist, the command surface with signed approvals, and group discipline. What changed on 2026-11-15: channels are manifests, people pair, and every relay run executes under a contract in a sandbox.

### Phase 75: Inbound authenticity, allowlisting and channel manifests
**Goal**: Nothing forged, replayed, expired, emulator-shaped or unallowlisted reaches a model, proven by adversarial tests before any happy path; every channel is a manifest in the gate's vocabulary, and its operator half is configured once.
**Depends on**: Phase 68; Phase 70 (the vocabulary); Phase 73 for audience-bound credentials. It touches only `relay/`, so it may start in its own worktree once Phase 70 is merged, beside Phases 71-74.
**Requirements**: AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-05, AUTH-06, CHAN-01, CHAN-02, CHAN-03
**Success Criteria** (what must be TRUE):
  1. Every adversarial case (forged signature, tampered body, expired token, wrong issuer or audience, mismatched `serviceUrl`, replayed request, emulator-shaped token without the development flag) is rejected with 403 before anything runs, the verifier also checks clock skew, and the suite fails the build if any case is accepted; a release build cannot be configured into an unverified mode. (AUTH-01, AUTH-02, AUTH-05)
  2. The same message arriving twice (platform retry, reconnect resend, edited event) starts exactly one run, verification is always paired with the dedupe ledger, and the inbound path acknowledges within about a second and works afterwards. (AUTH-03, AUTH-06)
  3. A message from a tenant or group that is not allowlisted is refused in the channel with a plain explanation and never reaches a model. (AUTH-04)
  4. Teams is described by a channel manifest (ingress verification, body limit, egress hosts, credential handles and how each is injected); the relay refuses to start a channel whose manifest and operator-supplied secrets disagree, sends each credential only to its audience, and no agent can change the operator half. (CHAN-01, CHAN-02, CHAN-03)
**Decision (IN-04, owner 2026-11-15)**: blank the payload on acknowledgement. Background: `ackMessage` keeps up to 1 MiB of message text per `done` row with no limit in time. Decide before this phase stores real messages: blank the payload on acknowledgement (the dedupe key alone recognises a redelivery; recommended), or purge `done` rows after N days.
**Carried from Phase 68**: A1 (match sensitive log keys by containment before real auth data is logged), A3 (`connectionsCheckingInterval` near 1 s with a read-back test before the port sits behind the webhook); `jose` comes into use here.
**Research flags**: PITFALLS ranks 6 of 8 pitfalls High on this boundary. The manifest shape starts from IronClaw's `[channel]` section (see `ironclaw-analysis.md`, R6).
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 75 to break down)

### Phase 76: Identity, tenants, requesters and pairing
**Goal**: Every message binds to a tenant and a requester from the verified envelope alone, tenants and paired people are identities in the new model, a person pairs their chat account to act with their own authority, and isolation between tenants is a tested property.
**Depends on**: Phase 69 (identities), Phase 75
**Requirements**: IDNT-01, IDNT-02, IDNT-03, IDNT-04, IDNT-05, PAIR-01, PAIR-02, PAIR-03, PAIR-04
**Success Criteria** (what must be TRUE):
  1. Each inbound message binds to a tenant from the verified envelope alone, never from message text, and one that cannot be bound is refused rather than guessed; the store resolves the binding before it accepts a message. (IDNT-01)
  2. A test proves a result and its working thread reach only the tenant, conversation and requester that produced them, and each tenant has its own workspace and uses only its own key. (IDNT-03, IDNT-04)
  3. Each tenant has an identity whose authority, held as signed credentials (never inside its DID document), bounds every run for that tenant, and each requester is recorded on first sight and survives a restart. (IDNT-02, IDNT-05)
  4. A person pairs their chat account in two steps (a one-time code from the operator side or the person's own editor, confirmed in the chat), recorded as a signed event; until paired a person cannot start runs or approve anything and is told how to pair; unpairing, account changes and recycled phone numbers never carry a pairing over. (PAIR-01, PAIR-02, PAIR-03)
  5. No agent can pair, unpair or change anyone's pairing. (PAIR-04)
**Carried from Phase 68**: A6 (resolve the tenant through `getBinding` before `acceptInbound`, or enforce the binding inside the store).
**Research flags**: (1) Confirm Teams tenant, thread and requester field paths against a live tenant before the schema is frozen. (2) Proactive 1:1 messaging after a group mention depends on the bot's install scope, the highest derail risk in the relay; verify here and record the fallback for Phase 81 and the Phase 84 threat model. (3) Everyone must pair (owner, 2026-11-15).
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 76 to break down)

### Phase 77: Teams 1:1 slice under a contract in a sandbox
**Goal**: A person asks a question in a private Teams chat and the team answers, composed headlessly from the existing engine and streamed live under the tenant's own bot identity; the run executes under a contract issued from the tenant's and requester's authority, inside a container or OpenShell sandbox, never on the relay host itself. First end-to-end value, deliberately before any group work.
**Depends on**: Phase 74 (the Stage 1 gate), the data platform gate (Phase 101; owner priority, 2026-11-18), Phase 76
**Requirements**: RUNL-01, RUNL-03, TEAM-01, TEAM-02, TEAM-03, TEAM-04, EXEC-11, CTRT-07
**Success Criteria** (what must be TRUE):
  1. The relay runs a team headlessly by composing the existing engine, tools, team library, model client, checkpoints and run markers together with the gate, grants and contracts, and the extension's own behaviour is unchanged by it. (RUNL-01)
  2. A customer's administrator installs the bot as an external app without it joining their organization; it works in 1:1 and group chats inside a threaded conversation, is addressed by direct message in a 1:1 and by mention in a group, greets once per thread, and presents the team's configured name, avatar and personality. (TEAM-01, TEAM-02, TEAM-04)
  3. A person asks in a 1:1 and receives the team's finished answer there, with progress streamed live, and discrete updates where in-group streaming is not available. (RUNL-03, TEAM-03)
  4. Every relay run executes in a container or OpenShell sandbox on a copy of the tenant's workspace with only placeholders for that tenant's credentials; with no sandbox reachable the relay refuses to run tools and says so in the chat. (EXEC-11)
  5. Every relay run carries a contract issued under the tenant's authority and the requester's pairing, and a refused contract is explained in the chat. (CTRT-07)
**Carried from Phase 68**: D-21 single-instance lock on the state directory (the first queue consumer lands here), A2 (refuse any `NEAR_AI_KEY_` plain env name whatever its case), the runner entry in `relay/scripts/build.mjs`, and the `.dockerignore` lines for the agent core.
**Research flags**: (1) Headless composition with the gate and contracts has never been done: the first runner boot is a spike with its fallback written down before group work starts. (2) Teams in-group streaming is undocumented: spike it; post-don't-stream is the accepted fallback. (3) A sandbox from a containerized relay: an OpenShell gateway beside the relay, never the container runtime socket inside the relay container (spike and analysis agree).
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 77 to break down)

### Phase 78: Messaging setup view and pairing
**Goal**: An operator connects the relay to its channels from a simple view in the extension instead of a written procedure: they see whether the relay is up, see each channel's state, connect Teams, manage who may message the bot, and issue and revoke pairings.
**Depends on**: Phase 77 (Teams works end to end, so the view connects something real), Phase 76 (pairing)
**Requirements**: SETUP-01, SETUP-02, SETUP-03, SETUP-04, SETUP-05
**Inserted**: 2026-11-15 at the owner's request as Phase 71.1 ("a simple UI for connecting the relay to supported communication channels"; channels Teams, Signal and Telegram; WhatsApp dropped); renumbered 78 the same day.
**Success Criteria** (what must be TRUE):
  1. A Messaging view in the extension shows the relay's health and one card per channel (Teams, Signal, Telegram) with its state: Not set up, Connected or Down. (SETUP-01)
  2. The view talks to the relay only through a local admin endpoint that authenticates the operator with a token read from a secret file, listens on loopback by default, and is never served on the public webhook port; no secret value ever reaches the webview or VS Code settings. (SETUP-02)
  3. The Teams card walks the operator through connecting the bot: app ID and secret are written to the relay as secret files, the connection is verified, and the app package for your organization's admin to install is produced. (SETUP-03)
  4. The operator sees and edits, per channel, who may message the bot, and changes apply without restarting the relay. (SETUP-04)
  5. The view lists paired people per channel, issues one-time pairing codes and revokes pairings, through the same admin endpoint. (SETUP-05)
**Research flags**: Keep the view a thin client of the relay's admin endpoint, so the Theia appliance reuses the endpoint and rebuilds only the screen.
**Plans:** 0 plans
**UI hint**: yes

Plans:
- [ ] TBD (run /gsd-plan-phase 78 to break down)

### Phase 79: Budgets and spend ledger on run contracts
**Goal**: Spend is capped where runs happen: a tenant's cap always applies, a conversation's cap defaults to unlimited, every run contract's cost cap fits inside both, and every recorded total reconciles with the extension's ledger.
**Depends on**: Phase 77 (real relay runs and contracts exist to clamp)
**Requirements**: BUDG-01, BUDG-02, BUDG-03, BUDG-04
**Success Criteria** (what must be TRUE):
  1. A tenant's spend is capped and a run that would exceed the cap is refused before it is billed, with a plain in-channel explanation instead of silence. (BUDG-01)
  2. A per-conversation cap exists and defaults to unlimited, so a busy group can be clamped without every group needing configuration at onboarding. (BUDG-02)
  3. Every run's spend is recorded against its tenant, conversation and requester in an append-only ledger, and the totals in chat match the extension's ledger for the same key. (BUDG-03)
  4. A relay run's contract cost cap is the smallest of the requester's grant, the tenant's remaining budget and the conversation's remaining budget, computed in integer nano-USD with the same arithmetic the editor uses, so Team Mode allocations can reuse it later. (BUDG-04)
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 79 to break down)

### Phase 80: Command surface, run lifecycle and request-bound signed approvals
**Goal**: Runs are controllable from plain text with honest lifecycle semantics (queued when busy, resumed or honestly reported when interrupted, steerable, cancellable with a receipt), and every approval, in the chat or in the editor, is bound to the exact request, answered by an identified person, signed, and expires to deny.
**Depends on**: Phase 79 (`cost` reports against the ledger)
**Requirements**: RUNL-02, RUNL-04, RUNL-06, RUNL-07, CMND-01, CMND-02, CMND-03, APRV-01, APRV-02, APRV-03, APRV-04
**Success Criteria** (what must be TRUE):
  1. Concurrent runs are capped globally and overflow waits in a durable queue; a run interrupted by a restart resumes inside the existing window or reports in the channel that it died, and is never left in an unknown state. (RUNL-02, RUNL-04)
  2. A person can send a follow-up while a run works, and it reaches the run or waits durably; a person can cancel from plain text with no buttons and gets an honest confirmation naming partial artifacts. (RUNL-06, RUNL-07)
  3. `help`, `status`, `cancel`, `cost`, `pause` and `resume` mean the same in every channel and each names the run it refers to; `status` reports elapsed time, current step and spend so far; `cost` reports against the tenant's and the group's budget in the extension's terms. (CMND-01, CMND-02, CMND-03)
  4. An approval is bound to a digest of the exact request (actor identity, capability, arguments, run, contract, expiry); an answer applies only to that digest, so a changed or replayed request needs a new answer, and only the requester or an approver the contract names may answer. (APRV-01, APRV-02)
  5. In the chat the request reaches the requester's private thread durably and an answer continues the run, recorded as an event the relay signs to attest the verified, paired identity; in the editor the person's device identity signs; an unanswered request expires to deny; "always allow" becomes a signed, scoped, expiring grant rather than a local setting; the editor and the relay show the same approval object. (APRV-02, APRV-03, APRV-04)
**Reuse pointers**: durable restart lives in `src/services/runMarkers.ts` (not `runActivity.ts`), with `AUTO_RESUME_WITHIN_MS` 12 h and `MAX_AUTO_RESUMES` 3; the relay must not import `src/services/chat.ts`; the relay store's approval rows mirror the extension's `ApprovalRequest` (68-05).
**Research flags**: Hermes's approval transports (immutable request with id and digest, deny on failure, approver lists) in `hermes-analysis.md`, H4.
**Undo cost**: Medium: signed approval records are kept for audit, so their shape outlives a change.
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 80 to break down)

### Phase 81: Group-chat discipline
**Goal**: In groups the bot is a good citizen: an acknowledgement and the finished result, in the right thread, and nothing else, with group text treated as untrusted input and documents and files flowing both ways without leaking the working thread.
**Depends on**: Phase 80
**Requirements**: GRP-01, GRP-02, GRP-03, GRP-04, GRP-05
**Success Criteria** (what must be TRUE):
  1. A group chat receives an acknowledgement and the finished result and nothing else: the working thread, tool output and internal narration stay in the requester's private chat. (GRP-01)
  2. Replies in a threaded channel land in the thread that caused them, and follow-ups in the group reuse the same thread. (GRP-02)
  3. Group text is treated as untrusted input: members' words cannot redirect where results go, reveal the private working thread, or widen what the run may do, because a run's authority comes only from its contract. (GRP-03)
  4. Document results (PDF, DOCX) are delivered as signed, expiring links so delivery does not depend on the customer tenant's file-storage provisioning. (GRP-04)
  5. A person can drag a file into the chat and have the run use it as input, with the same result-only discipline holding for what comes back. (GRP-05)
**Research flags**: If the install scope blocks proactive 1:1 messages (Phase 76), the documented fallback (everything in-group, result-only) is recorded here and carried into Phase 84's known limitations.
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 81 to break down)

### Stage 3: more channels and release (Phases 82-84)

### Phase 82: Signal channel
**Goal**: The same disciplined experience works over Signal through a supervised, version-pinned sidecar described by a channel manifest, with its own allowlist, pairing and registration-material safety net.
**Depends on**: Phase 81 (Teams semantics are the reference), Phase 78 (the Signal card lives in the setup view)
**Requirements**: SGNL-01, SGNL-02, SGNL-03, SGNL-04, SGNL-05
**Success Criteria** (what must be TRUE):
  1. The relay speaks Signal through a supervised sidecar running a pinned version that is never auto-upgraded, sharing credentials over a socket restricted to the relay's OS user, and the sidecar runs with the relay's container hardening. (SGNL-01)
  2. A group on the relay's Signal number can be allowlisted, and messages from groups that are not allowlisted are rejected. (SGNL-02)
  3. Every text command, acknowledgement, result and document attachment works in Signal with the same semantics as Teams, using quoted replies in place of threads, and Signal people pair the same way. (SGNL-03)
  4. An onboarding path exists for provisioning the relay's number, backing up its registration material, and recovering it, because losing that material means losing the number. (SGNL-04)
  5. The Signal card in the Messaging view registers or links the relay's number, backs up its registration material and sends a test message. (SGNL-05)
**Carried from Phase 68**: re-pin the sidecar to a current release before it first starts (tag 0.101 with signal-cli 0.14.8 lapses about 2026-12-10, and the owner chose on 2026-11-18 to let it lapse until this phase) and A4 (give the sidecar the relay's hardening before it first starts).
**Research flags**: Pin the exact signal-cli version and verify the image's bundled signal-cli age before integrating; confirm the group-id wire format for `/v2/send`; the sidecar image must exist for arm64 as well as amd64 (OPS-07).
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 82 to break down)

### Phase 83: Telegram channel
**Goal**: The same disciplined experience works over Telegram, with the same trust boundary as Teams and Signal: nothing forged, replayed or unallowlisted reaches a model.
**Depends on**: Phase 82 (channel parity is measured against Teams and Signal)
**Requirements**: TGRM-01, TGRM-02, TGRM-03, TGRM-04
**Inserted**: 2026-11-15 at the owner's request as Phase 75.1; renumbered 83 the same day.
**Success Criteria** (what must be TRUE):
  1. The Telegram card in the Messaging view connects a bot from its BotFather token, stored as a relay secret file; the relay registers its own webhook with a secret token and rejects any update that does not carry it. (TGRM-01)
  2. Telegram updates go through the same inbound checks as the other channels (replay window, duplicate update ids, allowlist), proven by adversarial tests before the happy path. (TGRM-02)
  3. A Telegram chat or group can be allowlisted, and every text command, acknowledgement, result and document attachment works with the same semantics as Teams, using replies in place of threads. (TGRM-03)
  4. Each Telegram message binds to a tenant and a requester from the verified update alone, and tenant isolation holds for Telegram in the same tested way as the other channels. (TGRM-04)
**Research flags**: Telegram does not sign updates; the webhook secret token header and an unguessable webhook path are the authenticity mechanism. Confirm Bot API group privacy mode for mentions before planning. Do not copy IronClaw's "linked devices" (acting as the person's own account).
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 83 to break down)

### Phase 84: Ops, onboarding and release
**Goal**: A customer's admin and an operator can install, deploy and operate the relay, with its sandbox, without the core team in the room; the threat model is written down, CI keeps the trust boundary closed after release, and the relay runs on both target machine architectures.
**Depends on**: Phase 83 (all surfaces exist to be documented and defended). The written install and deploy steps cover only what the Messaging view (Phase 78) does not.
**Requirements**: OPS-01, OPS-02, OPS-03, OPS-04, OPS-05, OPS-06, OPS-07
**Success Criteria** (what must be TRUE):
  1. A customer's administrator can install the bot into their tenant by following a written package of steps, including what to verify and how to upgrade. (OPS-01)
  2. An operator can deploy the relay on their own host by following a written playbook covering the reverse proxy, redirect-URI validation, key provisioning, backup and the OpenShell gateway beside the relay; the relay refuses to run tools when no sandbox is reachable, and nothing gives the relay container a container runtime socket. (OPS-02, OPS-06)
  3. A threat model documents each surface, what authenticates it and the failure it prevents, including the governance layer as the relay uses it (contracts, sandbox, signed approvals, pairing), and names the accepted residual risks, including the Phase 81 proactive-message fallback if install scope forced it. (OPS-03)
  4. An append-only activity log lets an operator replay a run and answer a customer's "what happened here?" without access to the customer's chat. (OPS-04)
  5. The adversarial suite and the tenant-isolation test run in CI, so a future change cannot quietly reopen a closed pitfall; the relay image builds for arm64 and amd64 from one definition, pinned by a multi-architecture digest, and starts on an x86-64 Strix Halo class machine first (the owner's first test hardware) and then on an arm64 DGX Spark class machine. (OPS-05, OPS-07)
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 84 to break down)

### Requirement coverage for this milestone

| Phase | Requirements | Count |
|-------|--------------|-------|
| 75 Inbound authenticity, allowlisting and channel manifests | AUTH-01 … AUTH-06, CHAN-01 … CHAN-03 | 9 |
| 76 Identity, tenants, requesters and pairing | IDNT-01 … IDNT-05, PAIR-01 … PAIR-04 | 9 |
| 77 Teams 1:1 slice under a contract in a sandbox | RUNL-01, RUNL-03, TEAM-01 … TEAM-04, EXEC-11, CTRT-07 | 8 |
| 78 Messaging setup view and pairing | SETUP-01 … SETUP-05 | 5 |
| 79 Budgets and spend ledger on run contracts | BUDG-01 … BUDG-04 | 4 |
| 80 Command surface, run lifecycle and signed approvals | RUNL-02, RUNL-04, RUNL-06, RUNL-07, CMND-01 … CMND-03, APRV-01 … APRV-04 | 11 |
| 81 Group-chat discipline | GRP-01 … GRP-05 | 5 |
| 82 Signal channel | SGNL-01 … SGNL-05 | 5 |
| 83 Telegram channel | TGRM-01 … TGRM-04 | 4 |
| 84 Ops, onboarding and release | OPS-01 … OPS-07 | 7 |
| **Total** | | **67** |

These 67 were part of the governed agent platform's 134 (then v0.7.0, now v0.5.0) until the split of 2026-11-18; nothing was re-mapped. RUNL-05 is retired (see v0.5.0's coverage note).

## Milestone v0.8.0: Cybersecurity

**Milestone goal:** The cybersecurity harness (target picker, legal disclaimer, defensive and offensive scans, engagement ledger) is verified end to end, its twelve regional disclaimers are accepted by the owner, and it ships as its own release, 0.8.0.

**Moved 2026-11-13** out of the 0.4.x line at the owner's request, so the cyber module is planned and released under its own number. Phase 25 keeps its number (its plans, summaries and commits already use it). Its code is already in the extension, and parts reached users in 0.4.x releases; this milestone closes UAT and the owner legal review, then adds any follow-up phases. **Order (owner, 2026-11-15):** deferred until everything else in this plan is finished; it may move to its own product. When it resumes, its sandbox runs through the shared execution backend interface from Phase 72. A follow-up phase (numbered when planned) adds the isolated VM enclave recorded in PROJECT.md as another backend of that interface (OpenShell's MicroVM driver is a candidate), with the breakout suite as its release gate; until then a scan never claims VM isolation.

### Phase 25: Cybersecurity harness with a target picker, offensive and defensive scans

**Goal**: A user picks a target — this workspace, a URL/host, an address range, or a local container — in a dedicated Cybersecurity view, accepts a region-aware legal-use disclaimer once per engagement, and runs either a defensive audit or an offensive exploit scan in which the NEAR AI models plan, execute, verify, and report, producing reproducible findings, an exploit that works or a clear account of why it does not, and an exportable audit trail.
**Depends on**: Nothing (builds on the shipped 0.4.x agent runtime, approval policy, and `src/security/` dependency scanner)
**Requirements**: CYBER-01 … CYBER-12
**Scope**: An *engagement* record is the unit of work: target, authorization statement, allowed modes (passive, active, intrusive), window, rate limit, exclusions, sandbox, and the accepted disclaimer with region, timestamp, and extension version, stored in `.planning/security/` and immutable once a run starts. The panel is a second view alongside Chat with a target picker (workspace folder, URL/host/IP, CIDR, git repo, local container), a mode selector (Defensive, Offensive, Full), a profile (quick, standard, deep), and live run activity; it must work in light, dark, and high-contrast themes and keep a table view of every finding. The harness core is a model-driven loop with planner, operator, critic, and reporter roles over a tool registry: built-in HTTP/TCP/DNS/TLS probes that need no external binary, optional host tools (`nmap`, `httpx`, `nuclei`, `nikto`, `sqlmap`, `testssl.sh`, `semgrep`, `trivy`, `gitleaks`, `whatweb`) detected and reported when absent, and a shell step that is always approval-gated. Defensive work covers recon, headers/TLS/DNS, secrets and dependency and IaC scanning, CVE mapping, and hardening advice; offensive work covers fingerprinting, vulnerability discovery, exploit selection or development, sandboxed PoC execution, access verification, post-exploitation proof, and cleanup. Every intrusive action passes `decidePermission` and the capability policy, is rate-limited and timed out, and is written to an append-only engagement ledger with tool, arguments, result, and reasoning. Findings are normalized (CVSS 3.1/4.0, CWE, CVE, OWASP) with evidence, exact reproduction commands, and a per-run diff, and export as Markdown, JSON, and SARIF. Models are treated as untrusted and interchangeable — a raw-completion abliterated model without native tool calling is driven through a structured protocol with parse-repair, retries, and context compaction — and a run can be replayed from its transcript. The disclaimer is shown before the first scan, names the region's law (US CFAA, UK Computer Misuse Act, EU directive, Australia, Canada, India, …) with a plain "you confirm you own or are authorized to test this target" statement, defaults to "not authorized" for public-sector and critical-infrastructure destinations, and blocks active and intrusive modes until accepted.
**Success Criteria** (what must be TRUE):
  1. From the Cybersecurity view a user selects each target kind (workspace, URL/host, CIDR, container), sees the resolved scope and a plan before it runs, and cannot start a passive, active, or intrusive scan without an accepted disclaimer that records region, timestamp, and engagement id; declining leaves the target untouched. (CYBER-01, CYBER-02, CYBER-03)
  2. A defensive scan of a deliberately misconfigured test service finds the seeded issues (missing headers, expired certificate, outdated dependency, committed secret) with evidence and a reproduction command each, and a scan of a clean service reports no findings from the seeded set. (CYBER-06, CYBER-07)
  3. An offensive scan against a local vulnerable target in the sandbox reaches a verified proof of access from a developed or adapted exploit, cleans up after itself, and reports honestly when an exploit fails; a run against a patched target says plainly that no exploit worked. (CYBER-08, CYBER-09)
  4. Any intrusive action without approval is refused, the stop control halts a run within one tool call, rate and time limits are enforced, and the engagement ledger replays the run tool-for-tool so a second person can audit exactly what was sent to the target. (CYBER-10, CYBER-11)
  5. The same engagement runs end to end against a model with no native tool calling through the structured protocol, and its transcript replay reproduces the findings without contacting the network where the tools allow it. (CYBER-04, CYBER-05, CYBER-11, CYBER-12)

**Research flags**: (1) Which host tools are commonly installed or installable per platform, and their output formats, before writing parsers; prefer JSON output and mark missing tools rather than falling back silently. (2) Sandbox choice for offensive work on Linux, WSL, macOS, and Windows (container vs a separate devcontainer vs a throwaway folder) and how cleanup is proven. (3) Legal text per region, reviewed as plain-language statements rather than advice, plus the public-sector/critical-infrastructure blocklist. (4) Tool-call protocol for raw-completion models: schema, parse-repair, and how to detect a model that cannot follow it. (5) Whether the harness reuses the existing agent loop and approval path or needs a second, tighter loop, and what that costs in tests. (6) Network destinations the harness adds, so they join the declared allowlist and the leak scan.
**Plans:** 8 plans (executed 25-01…25-08; UAT in progress in 25-UAT.md, parked at test 2 of the list on 2026-11-12)

## Later milestones (outlined 2026-11-15)

Outlines, not plans: each gets a version number, requirements and phases (numbered from 102 on; 85 to 101 are the data platform) when the owner starts it. All of them come after v0.6.0 Data platform and v0.7.0 Messaging relay. Draft requirement ids are listed in REQUIREMENTS.md under "Later milestones". All of them build on v0.5.0's governance layer; none needs IronClaw, Hermes or OpenShell as a product we depend on, only their designs, OpenShell's policy format and its prover.

**Recommended order and why.** (1) The Theia appliance (L1b) first, because it is the owner's first Theia product and it is how edge devices are deployed; its host and local inference (L1a) are already built inside v0.6.0 Data platform (owner, 2026-11-18), because an edge device with no connectivity is useless without a local model and the data platform needs the host first. (2) Team Mode next, because its built work decays the longer it waits and people's identities (invites, roster, device revocation) are what anchoring and federation need. (3) Routines and signed packages, the main autonomy lever, once people can sign standing orders as a team. (4) Verifiable identity and policy on NEAR, once agent, person and node identities all exist to anchor. (5) Edge grouping, compute pooling and HQ federation, which needs the appliance, people, anchoring and revocation. (6) The Theia desktop app with learned skills last, because learned skills are the riskiest self-modification and the desktop UI is where they and routines are best reviewed. Routines (3) depend only on v0.5.0 and can move earlier if the owner wants autonomy sooner.

### L1a: Host and local inference (built in the data platform milestone)
**Split (owner, 2026-11-18, data platform decision 1):** L1 is split in two. L1a, the always-on host and local inference, moved into v0.6.0 Data platform, which needs the host before the relay exists: the Compose stack on amd64 with the Strix Halo machine first, ROCm and Vulkan passthrough, the local inference service exposed through the hybrid provider as `local` models, and an offline start from a signed bundle (Phase 85, and the host parts of Phase 88). It needs no Theia, relay or OpenShell. Of the L1 draft requirements, L1a meets the AMD and amd64 half of APPL-02, APPL-03 and APPL-05 and the single-machine half of INFR-01 and INFR-03, through SPIKE-01 and SPIKE-02; the rest stays in L1b. L1b builds on L1a's stack rather than a second one.

### L1b: Theia appliance on one machine
**Goal**: A team runs on one machine it owns, connected or not: the L1a host gains Theia in the browser, the agent engine, the relay and an optional OpenShell gateway, local models on an NVIDIA or AMD GPU, and NEAR AI Cloud as a burst target when the network and the policy allow.
**Scope** (what L1a has not already built): Multi-architecture images (arm64 for DGX Spark class GB10 machines, amd64 for Strix Halo class machines) pinned by manifest-list digest and loadable offline as a signed bundle; GPU passthrough optional and vendor-neutral (NVIDIA Container Toolkit and CDI; AMD ROCm through `/dev/kfd` and `/dev/dri`; a CPU or Vulkan fallback), with sandboxes passing exactly the devices a grant names; a local inference service exposed to the engine as a provider next to NEAR AI Cloud, built on today's local and hybrid profiles (`src/domain/auth.ts`, `src/services/providerFactory.ts`, `privateRouteFor`, the `privacy: private` member rule); routing local first, then a NEAR AI Cloud burst, decided by the gate (private data never bursts to a non-TEE target; NEAR AI TEE models count as private only when attested; burst spend counts against the run contract); a full offline start in which the cloud is simply unavailable; the current VSIX inside Theia as the bridge for the first release (the `@nearai` chat participant is stubbed in Theia, and Theia stores AI keys in clear text, so we keep our own secret handling).
**Depends on**: v0.5.0 (execution backends, gate, contracts), v0.7.0 Messaging relay, and L1a (v0.6.0 Data platform).
**AMD first (owner, 2026-11-15):** the first test hardware is an AMD Ryzen AI Max (Strix Halo) machine, so L1 is built and accepted on AMD first (L1a, in Phase 85, already proves the host and local inference there): amd64 images, ROCm and Vulkan passthrough, and a local inference server proven on Strix Halo before the arm64 GB10 and NVIDIA path, which follows without blocking it.

**Research flags**: Phase 85 (L1a) answers the Strix Halo inference questions first and L1b inherits its findings. Local inference on Strix Halo first (gfx1151 iGPU, large unified memory): ROCm support level for gfx1151 in each candidate (vLLM ROCm builds, llama.cpp with ROCm/HIP and with Vulkan, Ollama, SGLang), Vulkan as the dependable fallback, and how much of the unified memory the GPU can address; then GB10 arm64 with CUDA; AMD passthrough inside OpenShell needs a hardware test on a Strix Halo machine (the spike found AMD works only by listing `/dev/kfd` and `/dev/dri` in the policy, with the `render` and `video` groups and the seccomp path untested); Theia version, branding and how the VSIX bridge behaves; whether several people share one appliance (one container per person or team until Theia Cloud is needed).
**Undo cost**: Medium: the offline bundle format and image layout are what people install on machines without network.
**Phases**: TBD.

### L2: Team Mode on the governed core (the rest of the former Team Mode branch plan)
**Goal**: Several people, each with their own agents, work one project without colliding, overspending or leaking secrets, now on the identities, gate, grants and backends of v0.5.0 rather than beside them.
**Scope and disposition of the former v0.6.0 Team Mode branch plan** (the branch `feat/team-fix-pass`, archived in Phase 69):

| Team Mode branch phase | Disposition |
|--------------|-------------|
| 60 Team core | Landed on `main` by Phase 69. |
| 61 Invitations, joining, removal, organization and key integration (33/35 plans) | Carried: close its owner re-test chain (61-32 to 61-35), then land on `main`. Key delivery and device revocation reuse Phase 69's signing interface. |
| 62 Team Board and 62.1 timeline (built; 62-29 and the 62-30 gate open) | Carried: land after the re-test chain closes. It is the largest webview; weigh rebuilding it as a Theia widget instead (L6). |
| 63 Claims, leases, claim workspaces, LeaseGuard | Partly superseded: claims between people stay; path leases become constraints the Phase 70 gate checks (no second gate); claim workspaces use Phase 72's copy-and-apply backends instead of another worktree mechanism. |
| 64 Dispatcher and Next Task | Carried; agent claims are signed under agent identities (Phase 71). |
| 65 Merge train and review gate | Carried; its pull-request mode uses the secure workflow kit from Phase 28 so there is one review path. |
| 66 Budgets and allocations | Re-based: allocations become spend constraints in grants and use the budget arithmetic of BUDG-04; per-key caps at the provider stay. |
| 67 Metrics, collaboration, team memory, team stop, release readiness, relay transport | Carried, except: team memory proposals share the staged-proposal pipeline with learned skills (L6), team stop builds on the gate's stop, and `relayTransport.ts` is superseded by L5's federation transport. |

The full record, with the archive evidence and a disposition for every one of the branch plan's 34 requirements, is `.planning/research/v0.6.0-disposition.md`.

Also carried: the shared code-server follow-ups (owner, 2026-11-05). Phase 27 already moved chats, run records, checkpoints and project spend history into each project's own state folder, so with one copy of the project per person those are per person already; what remains is the editor-wide spend ledger and daily limit per person, a recovery code that unlocks an encrypted backup of the person's device key and own NEAR AI key, and "Replace my device" (the lead accepts the person back as the same member).
**Depends on**: Phase 69 and v0.5.0 Stage 1.
**Moves onto the staff replication layer (owner, 2026-11-19):** when L2 starts, Team Mode's coordination log moves onto the per-writer signed logs, roster and transports of Phases 30 to 34 (`.planning/research/multiuser-sync/DESIGN.md`, section 18.1), so there is one multi-writer log in the product. Kept: the canonical form, payload signer, key status and history, device identity, git runner, scheduler, team file, Enable and the audit mirror; event bodies and role rules become entry kinds and fold checks; `materialize.ts` becomes a fold. Replaced: `eventLog.ts`, `gitTransport.ts` and `transport.ts` (the compare-and-swap branch is retired after an import). The transport privacy flag below is then met by the per-cell keys of that layer.
**Research flags**: Drift: the branch forked at 0.4.11; every month on the archive raises the cost of landing 61 and 62. The Team Mode branch ids that collide with live ids carry a `TM-` prefix (Phase 69). Transport privacy (Calimero evaluation, 2026-11-15, section 5.4, recommended instead of Calimero): encrypt each Team Mode event payload to the member device keys over the existing git transport, leaving signatures and hashes in clear, so the git host and the network see only ciphertext and sizes; removing a member re-encrypts future events only; roots over the ciphertext hashes can still be anchored in L4, written at fixed intervals so timing reveals nothing. Phase 69's plaintext signed log is not changed by this; it is a decision for this milestone.
**Phases**: TBD (the planner may reuse the Team Mode branch phase content under new numbers).

### L3: Routines and signed packages
**Goal**: Teams do standing work without a person starting each run, and your organization shares teams, skills and tools as signed packages, all inside the governance layer.
**Scope**: Routines as markdown files (team, schedule or trigger, task, run contract), signed by a person and expiring; agents may propose routines, only a person creates them; unattended firings get no approvals (anything that needs one is denied and reported); the emergency stop covers routines; routines run headlessly on the relay host or appliance engine, and in the editor only while it is open (said plainly); a minimal list in today's UI, the full surface in Theia. Signed packages in the cross-vendor Agent Plugins v1 layout (`plugin.json`, `skills/`, `agents/`, `teams/`, `mcp.json`) with a capabilities block that maps one-to-one onto grant constraints; package code never runs in the extension or engine process; the Hermes lifecycle (installed disabled, pinned to a commit, scanned with a non-overridable "dangerous" verdict, fresh consent when an update widens capabilities); installing is a governed action never available to member agents. Also per-MCP-server spend limits and tool schemas loaded on demand (MCP sampling stays off).
**Depends on**: v0.5.0 (contracts) and v0.7.0 Messaging relay (relay, signed approvals); L2 for team-signed routines.
**Research flags**: IronClaw's routine guardrails and no-result sentinel; Hermes `/goal` as a small bounded continuation; how a routine's contract is renewed before expiry without silent widening.
**Future item (owner, 2026-11-16)**: team packages can later be listed in the agent marketplace exchange. The `.near-team.json` share file from 0.4.26 reserves a `listing` field (always null today) and a `formatVersion`, so a signed version 2 (Phase 69's signer) and a marketplace listing can be added without breaking files already shared. No selling UI until then.
**Phases**: TBD.

### L4: Verifiable identity and policy on NEAR
**Goal**: The identities, credentials and policies v0.5.0 keeps locally are anchored on NEAR without anything readable on chain, revocation has one source of truth, agents and nodes write on chain only with narrow keys that a person adds and removes, and anyone given the data can check an agent's chain of authority.
**Scope** (revised 2026-11-15, PROJECT.md Platform direction decision 13, owner-confirmed): nothing readable on chain: one anchor account per organization writes only 32-byte Merkle roots over DID log heads, status lists and policy bundle hashes, at fixed intervals even when nothing changed, so timing does not show who was added or revoked; credentials, clearances, roles, relationships, DID documents and ciphertext of any of them stay off chain; the anchor is one interface (`anchor(root, kind, epoch)`, `latest(kind)`) with public NEAR mainnet first and a NEAR confidential backend once NEAR accepts third-party contracts and data on its private shard; HQ is the credential issuer, the `did:webvh` host and witness, the status list publisher and the only anchor writer, with your organization's root key offline under `did:webvh` pre-rotation and a separate online issuing key; run admission checks the anchored roots once per run and issues a short-lived signed lease, never per action, and the local gate decides every action; offline, the signed local copy decides and anything wider fails closed; revocation through HQ's status lists, committed in the roots, cached with `validUntil` and checked at run start and lease renewal; a grant credential references the run's generated OpenShell policy by hash, with the prover result recorded and our own subset check for what the prover cannot model (MCP tools, spend, schedules, depth, expiry); the hash-chained audit log (OCSF records) included in the roots from time to time, queued while offline; the activity dashboard shows each agent's DID and delegation chain in plain words.
**Scope added 2026-11-16** (PROJECT.md, Platform direction decisions 14-17, owner): NEAR function-call access keys for on-chain calls only (option (a)). Each agent or node that may write on chain gets its own function-call key on your organization's account, whose only receiver is the registry contract, listing only the methods its grant allows, with a small allowance (ANCH-09); a child key's methods are a non-empty subset of its parent's, since an empty list means every method (ANCH-10); keys are added only with a person's full-access key or by the orchestrator under authority a person delegated, and removed only by a person running the exact command the product shows (ANCH-11); the registry contract checks the signing key against the delegation chain and revocation beside NEAR's own key check, both must allow and a revocation in either wins (ANCH-12); registry methods are cheap and move no value (ANCH-13); on-chain keys are dedicated, bound to the agent's or node's DID by a credential and rotated (ANCH-14); chain reads fail closed (ANCH-15). Off-chain capabilities (external APIs, model providers, messaging channels) never go in the key list: they stay in private credentials checked by Phase 73's broker (CRED-08), with only roots on chain. Option (b), a public key registry for off-chain capabilities with hashed method names, was considered and declined (decision 15 gives the reasons).
**From the data platform (2026-11-18):** release package manifest roots, hold manifests and governance-log roots can be anchored the same way, roots only (data platform design, section 8.2).
**Depends on**: v0.5.0 (DIDs, credentials, status lists, grants, signed bundles, generated sandbox policies, the broker's signed invocations), L1a (an always-on host for HQ's roles, built in v0.6.0 Data platform), L2 (people and device revocation).
**Owner action (closed 2026-11-18)**: the owner asked NEAR whether the private shard will accept third-party contracts and data; the answer is that if it happens it will not be anytime soon. Roots-only anchoring on public NEAR is the plan of record for L4, with no confidential backend scheduled. The anchor interface (ANCH-07) stays, so a backend can be added later without changing what is anchored; revisit only if NEAR announces third-party contracts on the private shard.
**Research flags**: (1) NEAR confidential today (`identity-research.md`, section 1): Confidential Intents moves balances only; the private shard runs only the Intents engine, has no public RPC and takes no third-party contracts (risk 1). Its trust model is seven permissioned validators and a TEE bridge with no NEP or source found (risk 2), and several claims about it come only from secondary sources that disagree (risk 11): re-check all of it before building the confidential backend. (2) Calimero Network, evaluated 2026-11-15 (`.planning/research/platform-direction/calimero-evaluation.md`): not now. Calimero 1.0 (release candidate, 2026-10 and 2026-11) removed all NEAR integration (0.10.1-rc.9, 2026-03-25) and its peer-to-peer sync; it is now a leader-ordered confidential cloud on Intel TDX servers (3 nodes, GCP images), with no LAN or offline groups, no NEAR anchoring, only an insecure dev mode on AMD Strix Halo and NVIDIA GB10 (no TDX), a TypeScript client with runtime dependencies and no independent audit. Revisit only if HQ moves onto Intel TDX hosting and Calimero ships a stable, audited 1.0 that supports our hardware. (3) Metadata: the anchor account and its timing show that your organization exists and is active; roots are written at fixed intervals, even when nothing changed, so timing reveals nothing about who was added or revoked (risk 3; the Calimero evaluation recommends the same). (4) Issuer key compromise at HQ undermines everything: offline root key, online issuing key, pre-rotation, and a tested recovery drill (risk 6). (5) Not post-quantum: anchored roots stay valid commitments, but Ed25519 signatures need a migration path; the post-quantum work of the paused former v0.5.0 knowledge-base plan is relevant (risk 10). (6) Cost and latency of anchoring: 1 NEAR per 100 KB of contract state, so only the latest root per kind is kept in state and history goes to event logs. (7) The prover cannot prove sub-folder narrowing, so the file-path vocabulary stays fixed; spend constraints need running totals, not static comparisons (spike). Risks from the prior-art report (`.planning/research/platform-direction/agent-authz-prior-art.md`, section 8.5) for the function-call keys of 2026-11-16: (8) Privacy of key lists (risk 1): anyone can list your organization's account keys with each key's receiver and method names, and see when each was added and removed, so the list shows how many agents and nodes write on chain and how often they change, and every registry call shows which key signed it and when; decision 15 keeps off-chain capabilities out of it, and research weighs what remains against decision 13 (for example fixed-interval writes, as for the roots). (9) Key sprawl and staking cost (risk 7): one key per agent or node per grant, about 100 bytes and 0.001 NEAR staked each, and a transaction for every add and remove; session-key systems report sprawl and revocation hygiene as their main weakness, so keys stay few, the product shows the person how many exist and what they stake, and keys no grant needs are offered for removal (by a shown command). (10) Revocation latency (risk 8): a key keeps working on chain until a person removes it, and the contract's own check sees a revocation only once it is in the latest anchored status root; UCAN calls revocation "the last line of defense", so allowances stay small, expiry short and grants narrow. (11) The key-adding power is the prime target (risk 6): whoever holds a full-access key on your organization's account can mint any capability, and the subset rule is enforced only by the code that builds the add; research decides how the orchestrator adds keys under delegated authority without holding a full-access key itself (for example a person signs each add the orchestrator prepares, or a contract method with its own subset check), keeps full-access keys with people (offline where possible) and makes any key added outside the product visible; it also decides whether the anchor account, the account that holds the agents' and nodes' keys and the registry contract's account are one account or separate, since separating them limits what one leaked full-access key can do. (12) The broker as a single point of failure (risk 11) and a confused deputy (risk 12): Phase 73's broker holds every real credential, so it needs redaction, an availability plan and a fail-closed default, and every credential and lease stays bound to one audience (CRED-08). (13) The other NEAR rules in the report: NEP-413 expects a full-access key (risk 2), so any reuse of its layout carries our own tag and recipient; at most 2,000 bytes of method names per key and 256 per name (risk 4); a stolen key can still send transactions until its allowance is spent (risk 5, ANCH-13); the credential chain and the key list can disagree, so both must allow and either revocation wins (risk 10, ANCH-12); a free public RPC can be down, rate-limited or wrong (risk 9, ANCH-15). The first design question is how the registry contract checks a delegation chain when nothing readable is on chain (for example a credential hash with an inclusion proof against the latest anchored root).
**Undo cost**: High: anything put on chain is permanent; roots-only keeps that to 32-byte commitments that reveal nothing, and every function-call key ever added or removed stays in your organization's account history.
**Phases**: TBD.

### L5: Edge grouping, compute pooling and HQ federation
**Goal**: Machines at the edge link up with no internet to share work and GPU power, and federate with an HQ server when connectivity returns, syncing identities, policy, audit and results without either side being able to forge the other's records.
**Scope**: Node identities as `did:key` bound to your organization by a credential (issued by a person with authority, revocable through the status list); local grouping by discovery on the local network with mutual authentication by node identity and binding credentials, each node's gate still deciding alone; offline verification (revised 2026-11-15, Platform direction decision 13): before going offline a device syncs your organization's DID log, the DID logs of the people it works with, all status lists, the policy bundle and the latest anchor roots with inclusion proofs, verifies locally and checks the cached copies against the roots; each level has a maximum offline age after which new access at that level fails closed; two offline devices exchange stapled status lists signed by your organization; on reconnect, sessions that ran on stale data are re-evaluated and flagged; a second site may hold its own issuer DID under a narrower delegation; compute pooling for local inference across linked machines, NVIDIA and AMD; routing extended to local, then linked machines, then the HQ cluster, then a NEAR AI Cloud burst, each hop only where policy, privacy tier and contract allow; federation sync of identities, policy (down, as signed bundles that never widen an edge's anchored authority), audit (up, hash-chained, gaps detected) and results; inference federation to an HQ cluster as one more provider.
**Coherence review (2026-11-20):** L5 is hub-to-hub federation of the replica layer's signed streams (Phases 30 to 35); "relay" means the messaging relay only, and the portfolio's "hub-to-hub relay" below is that federation. The list that follows predates the hub.
**Builds on**: Phase 27's encrypted sync (bundles over git with a recovery code, records merged without loss); Team Mode's signed coordination log and git transport; the ciphertext relay design of the paused former v0.5.0 knowledge-base plan (a relay that stores only ciphertext, checks signed append capabilities, and can withhold but not forge; RELAY-01/02 in `.planning/milestones/v0.5.0-paused/`); the planned `relayTransport.ts`, which this transport replaces.
**From the data platform (2026-11-18):** catalog federation between edge and HQ, per-label-cell keys for edge devices that store data, and pooled compute for extraction and training (data platform design, section 8.2).
**From the portfolio design (2026-11-20):** hub-to-hub relay of sealed portfolio publications with checkpoints naming their signer, verified publishers and positions across organizations, and cross-organization portfolios; the publication format does not change (`.planning/research/portfolio-and-assignment/DESIGN.md`, 6.11).
**Depends on**: L1a and L1b, L2, L4.
**Research flags**: Pooling across heterogeneous NVIDIA and AMD nodes is hard and must be flagged honestly: one model split across vendors may not be practical, so expect per-vendor pools with request-level balancing; options to evaluate include llama.cpp RPC, vLLM and SGLang multi-node, and Ollama per node behind a router; OpenShell has nothing for pooling (the spike: a model server on each box behind an allowed endpoint, or a Kubernetes cluster); clock trust without network time (offline age uses monotonic counters and last-sync time, not the wall clock alone: `identity-research.md`, risk 8); offline revocation lag: a revoked person keeps working on a device until its cached list or the level's maximum offline age runs out, so each level's limit is set deliberately (risk 5; the research's values are examples only); conflict rules when an edge and HQ both changed policy; the federation transport can reuse Team Mode's git transport with event payloads encrypted to member device keys and signatures and hashes left in clear (works over any git remote or a LAN bare repository; Calimero evaluation, 2026-11-15, recommended instead of Calimero, which has no LAN or offline groups), and anchor roots are written at fixed intervals so timing reveals nothing.
**Undo cost**: High for the federation record formats.
**Phases**: TBD.

### L6: Theia desktop app and learned skills
**Goal**: People who want a local install get a desktop app from the same code, with Team Studio and chat rebuilt as Theia widgets and agents, a routines screen, and teams that get better at recurring work through skills a person approves.
**Scope**: Desktop app from the appliance's code; Team Studio, chat and the board as Theia widgets or Theia AI agents; our gate in front of every tool, including tools Theia provides; routines UI; learned skills only as staged proposals (diff, the run that produced it, a scan verdict) approved by a person into a scope, signed, with the skills folder protected from file tools and no proposals from runs that read untrusted content; named agents with personalities and decision agents (PROJECT.md planned features) in the rebuilt team builder, with a decision agent acting only under a grant. The VS Code extension keeps shipping while the shared core makes that cheap.
**Depends on**: L1b, L3.
**Research flags**: Theia AI's agent, skill and MCP formats (they already read `agent.md`, `SKILL.md` and MCP); which of today's webviews to rebuild first.
**Phases**: TBD.

## Institutional staff support

### Phase 102: Institutional joint staff teams

**Goal**: Provision the institutional joint staff teams in Workbench with
branch-specific skills, constrained tools and clear human ownership for all
149 duties in the reviewed blueprint. Support unit L4, brigade L3, division
L2 and joint L1/L0 profiles for the US, NATO and Canada.

**Depends on**: The staff product and Team Studio foundations, plus publication
of the reviewed institutional blueprint. Local synthetic development can use
the exact reviewed blueprint commit while the merge queue is held. Live source,
delegation and delivery acceptance retain their own prerequisites.

**Success criteria**:

1. A person can provision the institutional Command Group, J3 and J7 teams and
   run the first fictional decision, action and lessons handoffs through the
   ordinary Workbench staff experience.
2. Every J1–J9, Command Group and Special Staff duty has a tested agent
   contribution, accountable human, draft output and scoped tool contract.
3. Changes to source authority or review version hold the relevant handoff.
   Human decision and release remain distinct and verifiable.

See [Phase 102 planning record](https://github.com/VitalPointAI/near-ai-vscode/blob/main/.planning/phases/102-institutional-joint-staff-teams/102-CONTEXT.md)
for the duty inventory and build order.

Plans:
- [ ] First synthetic Command Group, J3 and J7 handoffs
- [ ] J2/J6 stewardship and J5/J9 institutional drafts
- [ ] J4/J8 ordinary resource and reconciliation workflows
- [ ] J1/Special Staff administrative support and full profile acceptance

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 27. Project state follows the project (0.4.20) | 36/36 | Complete: shipped in 0.4.20; owner host check passed | 2026-11-17 (released 2026-11-14) |
| 28. Secure development workflow setup step | 0/TBD | Not started | - |
| 29. A cleanup member with a safe CleanUp tool | 0/TBD | Not started (after Phase 70) | - |
| 30. Replication contract and co-editing core | 12/12 | In Progress (staff collaboration drop A) | - |
| 31. Staff roster, cell keys and migration | 0/23 | Planned (drop A) | - |
| 32. Your organization's sync hub | 28/28 | Complete: all 28 plans executed; released with drop A after Phase 33 | 2026-11-20 |
| 33. Live multi-user staff projects | 2/20 | In Progress (drop A release) | - |
| 33.1. Assigned positions and handover | 0/25 | Planned (native re-plan 2026-11-24; after Phase 33's wave 4, before drop B) | - |
| 33.2. Post-quantum cell keys (cell-wrap/v2) | 5/8 | In Progress 2026-11-24 (after Phase 33; between 33.1 waves 7 and 8; before any site holds Protected B data) | - |
| 34. Offline transports for staff projects | 0/TBD | Not started (drop B) | - |
| 35. Shared agent work, observations and hub watches | 0/TBD | Not started (drop B release) | - |
| 32.1. Guided setup with viable options and a plain recommendation | 0/20 | Planned 2026-11-21 (after Phases 32 and 41, before Phase 36) | - |
| 32.2. Local model manager | 0/17 | Planned 2026-11-21 (after 32.1-01, the shared contract) | - |
| 36. Cohere Model Vault provider, sovereign-region class and cost control | 0/TBD | Not started (after Phases 32 and 41; may run beside 33 to 35) | - |
| 37. Cohere Encrypted Vault as an attested endpoint | 0/TBD | Not started (after Phase 36) | - |
| 38. Organization tree, publications and label-safe roll-up | 0/TBD | Not started (portfolio view; after drop B) | - |
| 39. Portfolio Room, prioritization and scenarios | 0/TBD | Not started (after Phase 38) | - |
| 40. Capacity, allocation, dependencies and gates | 0/TBD | Not started (after Phase 38; may run beside 39) | - |
| 41. Organization policy foundation (F1) | 0/15 | Planned (after the coherence safety patch; before 32.1, 32.2, 33.1, 36 and 37) | - |
| 42. Capital project offices on the replica | 0/TBD | Not started (after Phase 33.1) | - |
| 43. Programme and portfolio offices, the capital tab | 0/TBD | Not started (after Phases 42 and 39) | - |
| 44. Accreditation evidence and compliance dashboard | 18/19 | In Progress (no dependency in flight; may run beside any phase) | - |
| 44.1. Accreditation control implementation and evidence closure | 1/4 local | Control triage and implementation underway | - |
| 45.1. NATO and Five Eyes exchange, part 1 | 0/5 | Planned 2026-11-24 (after Phase 71 plans 03, 06 and 07; 45.1-04 after 33.1-21) | - |
| 45.2. NATO and Five Eyes exchange, part 2 (ZTDF) | 0/12 | Planned 2026-11-24 (after 45.1's plans; 45.2-12 waits for a partner's KAS and samples) | - |
| 46. Native Theia foundation | 8/9 | 46-01 to 46-08 complete 2026-11-24 on `feat/phase-46-wave-1` (integration PR waits for the owner's gate approval); 46-09 (version safety, added 2026-11-24 by #185) not executed | - |
| 47. On-premise deployment stack and offline bundle | 26/35 | In Progress 2026-11-23 (beside 46) | - |
| 48. Load and accreditation verification | 5/10 | Planned 2026-11-23 (waves 1 and 2 can start now; 3 and 4 after 46, 47 and the rig) | - |
| 48.1. Hosted SA&A completeness | 6/23 | In Progress 2026-11-24, revised the same day (owner items a to d answered; starts after the component catalogue merges; cross-phase items in 48.1-HANDOFFS.md) | - |
| 48.2. Live compliance evidence in the workbench | 11/17 | In Progress 2026-11-25, revised after the plan check (waves 1 to 5 can start now, 48.2-07 after 46-09 and 48.2-10 after the approved UI-SPEC; waves 6 to 10 after 47-32, 48.1-15, 48.1-17, 47-29, 48-07 and 48-08; six owner questions with defaults in 48.2-CONTEXT.md) | - |
| 68. Relay foundation | 8/8 | Complete (v0.5.0 Governed agent platform); merged as PR #50 (052d5cf); `relay` required on main (D-19) | 2026-11-15 |
| 69. Team Mode reconciliation | 15/15 | Complete: PR 1 #59 and PR 2 #61 merged | 2026-11-15 |
| 70. Capability vocabulary, manifests and one gate | 32/32 | Executed: all parts merged (last #95); verification record to write | - |
| 70.1. Classification engine | 4/5 | In Progress 2026-11-24 (pure; may start now, beside Phase 71 core and Phase 33) | - |
| 71. Identities and verified credentials (core), pulled forward | 12/14 | In Progress 2026-11-24 (re-scoped; plans 01 to 08 run now beside Phases 33, 33.1 waves 1 to 3, 46 and 47; 10, 12 and 13 after 46-02 and 46-07) | - |
| 71.1. Agent delegation that only narrows | 0/TBD | Not started (split from Phase 71 on 2026-11-24; Stage 1, before Phase 72) | - |
| 72. Execution backends on a copy, with a guarded apply | 0/TBD | Not started (spike done 2026-11-15) | - |
| 73. Credential broker | 0/TBD | Not started | - |
| 74. Run contracts | 0/TBD | Not started | - |
| 74.3. Classification assistant | 0/15 | Planned 2026-11-24 (after 70.1 and 74.1; lowering after Phase 71 core 71-12 and 71-13; cells after 33.1's marking plans) | - |
| 85. Host and local inference on Strix Halo (L1a), measured | 0/TBD | Not started (v0.6.0 Data platform; may start during Phases 72 to 74) | - |
| 86. Microsoft 365 connector spike | 0/TBD | Not started (may start during Phases 72 to 74) | - |
| 87. Extraction and OCR throughput spike | 0/TBD | Not started | - |
| 88. Ingestion core, governed store and the data map | 0/TBD | Not started (after the Stage 1 gate) | - |
| 89. Microsoft 365 connector with one-click connection | 0/TBD | Not started | - |
| 90. Google Workspace connector with one-click connection | 0/TBD | Not started | - |
| 91. Endpoint collectors, file shares and simple install | 0/TBD | Not started | - |
| 92. Extraction pipeline | 0/TBD | Not started | - |
| 93. Classification, labels, privacy assessment and exceptions | 0/TBD | Not started | - |
| 94. Lifecycle, erasure and the personal mark | 0/TBD | Not started | - |
| 95. Legal holds and access requests | 0/TBD | Not started | - |
| 96. Search, context graph, entity pages and ask | 0/TBD | Not started | - |
| 97. Analytics, reports, insights and views | 0/TBD | Not started | - |
| 98. Model factory v1, first specialist from chat and run logs | 0/TBD | Not started | - |
| 99. Opportunity agent, data-gap planning and specialists from organization data | 0/TBD | Not started | - |
| 100. Easy sources: catalog, manifest connectors, agent-written connectors, databases | 0/TBD | Not started | - |
| 101. End-to-end hardening and release | 0/TBD | Not started | - |
| 75. Inbound authenticity, allowlisting and channel manifests | 0/TBD | Not started (v0.7.0 Messaging relay, after the data platform; may start early in its own worktree) | - |
| 76. Identity, tenants, requesters and pairing | 0/TBD | Not started | - |
| 77. Teams 1:1 slice under a contract in a sandbox | 0/TBD | Not started | - |
| 78. Messaging setup view and pairing | 0/TBD | Not started | - |
| 79. Budgets and spend ledger on run contracts | 0/TBD | Not started | - |
| 80. Command surface, run lifecycle and signed approvals | 0/TBD | Not started | - |
| 81. Group-chat discipline | 0/TBD | Not started | - |
| 82. Signal channel | 0/TBD | Not started | - |
| 83. Telegram channel | 0/TBD | Not started | - |
| 84. Ops, onboarding and release | 0/TBD | Not started | - |
| 25. Cybersecurity harness (v0.8.0) | 8/8 | Deferred to the end; may become its own product | - |
