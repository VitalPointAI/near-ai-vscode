# Roadmap: Near AI for VSCode

## Milestones

- Milestone 1: Phases 1-6 (SHIPPED)
- **v0.4.0 A working core and a native NEAR agent runner**: Phases 7-12 (SHIPPED)
- **0.4.x line**: ongoing releases on top of v0.4.0 (current; 0.4.22 published 2026-11-14; 0.4.23 in review as PR #51; 0.4.24 patch next; Phase 27 shipped as 0.4.20 with its record still open; Phases 28 and 29 planned)
- **v0.5.0 Trusted-source knowledge base**: PAUSED 2026-10-29 and moving to a separate project. Its roadmap, requirements, research and Phase 13 plans are archived in `.planning/milestones/v0.5.0-paused/`; the Phase 13 code lives on the local branch `gsd/phase-13-sovereignty-gate-post-quantum-cryptography-and-the-encrypted`.
- **v0.6.0 Team Mode**: Phases 60-67 on the unmerged, local-only branch `feat/team-fix-pass` (Phase 60 complete, 61 and 62 built with re-tests open, 63-67 not started). Its identity and signed-event core lands on `main` in v0.7.0 Phase 69; the rest is the later milestone L2 (disposition table there).
- **v0.7.0 Governed agent platform and messaging relay**: Phases 68-84 (Phase 68 complete; replanned 2026-11-15 from the owner's platform direction; relay phases renumbered)
- **v0.8.0 Cybersecurity**: Phase 25 (executed; UAT may resume once v0.7.0 Phase 72 is merged, owner to confirm)
- **Later milestones L1-L6** (outlined 2026-11-15): Theia appliance and local inference; Team Mode on the governed core; routines and signed packages; verifiable identity and policy on NEAR; edge grouping, compute pooling and HQ federation; Theia desktop app and learned skills

## 0.4.x line

Work here ships as 0.4.x releases: a `hotfix/0.4.N` branch from `main`, then the full unit, e2e and release checks, then the Marketplace and GitHub release once the owner approves that version.

| Release | Date | Highlights |
|---------|------|------------|
| 0.4.1 | 2026-10-28 | Build-tooling security fixes; tests stay honest |
| 0.4.2 | 2026-10-28 | Auto approval mode; 429 retry storm fixed |
| 0.4.3 | 2026-10-28 | Approval mode picker in the chat bar |
| 0.4.4 | 2026-10-29 | Conversations, steering, accurate spend, Agent Activity overview, Tools directory |
| 0.4.5 | 2026-10-29 | Team Studio; stalled replies retried and reported; reporting token in Settings |

Next phases are added here (integer numbering: Phases 26 to 29 so far) when 0.4.x work is planned with GSD.

### Patch line (updated 2026-11-15)

0.4.6 to 0.4.22 are published (the CHANGELOG has each). Patches that need no GSD phase:

| Release | State | Scope |
|---------|-------|-------|
| 0.4.23 | PR #51 in review, then its release PR | Agent model never silently replaced, GenerateImage model choice, agents kept out of `.near-ai/state/keys`, image review workflow, the three #48 sync follow-ups |
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
**Depends on**: Nothing (builds on the shipped 0.4.19 storage, transcripts, profile store and model comparison panel). Ships as release 0.4.20 before v0.7.0 Phase 68.
**Requirements**: SYNC-01 … SYNC-09
**Evidence (before)**: 2026-11-13 the owner opened in desktop VS Code a week of work done through code-server on the same host. Projects are mounted at the same path, so project ids match, but chats, runs, checkpoints and `evals/` live in each editor's own `globalStorage` (code-server holds 5 transcript folders and the 2026-11-12 comparison; desktop stops at 2026-11-06), applied model recommendations are written to *user* settings (`modelComparisonPanel.ts` `applyRecommended`, ConfigurationTarget.Global), and the API key plus the transcript encryption key (`nearAi.transcripts.key`) are in each editor's SecretStorage (code-server: the browser), so the profile needed setting up again and copied transcripts could not be decrypted.
**Success Criteria** (what must be TRUE):
  1. With the same project folder opened in code-server and in desktop VS Code on one host, both show the same chat list, run records, checkpoints, comparison runs and applied model choices; work done in one appears in the other on next open without any manual step. (SYNC-01, SYNC-06)
  2. On first start of 0.4.20 each editor merges what its own storage already holds for the project into the project's state home, idempotently and without overwriting or deleting anything; the owner's existing code-server and desktop data both survive. (SYNC-02)
  3. Transcripts are encrypted with a per-project data key that is portable: unlocked on this device from SecretStorage and on a new device by the recovery code; a wrong code and a tampered bundle are refused with a plain message and leave state untouched. (SYNC-03, SYNC-04)
  4. Turning sync on shows a high-entropy recovery code once (never stored or logged); on a second machine with the same project cloned, entering it restores chats, runs, comparisons, model choices and the NEAR AI key without re-entering the key, through an encrypted bundle on a dedicated branch of the project's own git remote (never `main`); a leak test proves no plaintext transcript, key or prompt reaches the remote. (SYNC-04, SYNC-05)
  5. Opening the project on a different interface or machine shows a "Pick up where you left off" card (last chat, last run state, current GSD phase and next step); one click reopens it and nothing re-runs or spends money. (SYNC-07)
  6. All git work for sync is done by the extension and reported in plain words; conflicts from two machines merge per record with no lost entries (tested). 0.4.20 ships through the release PR with CHANGELOG and README updated. (SYNC-05, SYNC-08)
**Plans:** 35/36 plans executed (11 waves; gap closure 27-19 to 27-25 from 27-UAT.md, then 27-26 to 27-36 from the PR #40 review 27-REVIEW.md in 5 waves, all before 27-16)
**Status (checked 2026-11-15)**: shipped. PR #40 merged and release 0.4.20 was cut through release PR #41 on 2026-11-14 (fixes followed in 0.4.21 and 0.4.22), so SYNC-08 is met. What remains of 27-16 is the record: the owner's check on the real host (27-UAT.md stops at test 8, "your own old chats open in both real editors") and the 27-16 summary.

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
- [ ] 27-16-PLAN.md — Phase gate, owner check on the real host, README/SECURITY, feature PR and release 0.4.20 (feature PR and release done 2026-11-14; owner host check and summary open)

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
**Plans:** 0 plans
**UI hint**: yes

Plans:
- [ ] TBD (run /gsd-plan-phase 28 to break down)

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
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 29 to break down)

## Milestone v0.7.0: Governed agent platform and messaging relay

**Milestone goal:** Every agent the extension runs works under a governance layer a person can see and check (one policy gate with a floor nothing overrides, delegation that only narrows, run contracts, a sandbox where protected folders are absent, credentials the agent never holds), deciding offline from a signed local policy. On that layer, people reach their teams from Microsoft Teams, Signal and Telegram through a relay without opening VS Code: the group sees only the finished result, the working thread stays private to whoever asked, and every relay run executes under a contract in a sandbox.

**Replanned 2026-11-15** from the owner's platform direction (`.planning/PROJECT.md`, "Platform direction"; research in `.planning/research/platform-direction/`). The milestone was "Messaging relay: Teams, Signal and Telegram" (Phases 68-76 plus 71.1 and 75.1). Phase 68 stands as built; the relay phases after it are renumbered (table below) and gain the designs the owner named: capability manifests, run contracts and channel pairing, plus a single gate with a non-overridable floor, restrict-only delegation, execution backends, a credential broker and request-bound signed approvals.

**Why one milestone, not two.** The owner asked for v0.7.0 to be replanned with these designs folded in, Phase 68 already ships as "v0.7.0 Phase 68" (PR #50), and the relay's later phases depend on the governance phases in one chain (a relay run needs a contract, a sandbox and signed approvals). Splitting would also stop Phase 75, which touches only `relay/`, from running beside Stage 1. The milestone is therefore one, in three stages with a gate between Stage 1 and the relay's first runs. It is larger than the standard 4 to 6 phases; the stages are the natural checkpoints.

### Order of work across every stream (sequencing summary)

| Step | Work | Why here |
|------|------|----------|
| 1 | **0.4.23** (PR #51, in review), then its release PR | It closes a live gap (agents could read the project's key folder) and `main` is strict, so the extension line goes first. |
| 2 | **PR #50** (Phase 68) merges; the owner approves `agent-review-gates` and adds `relay` to branch protection (D-19); then a small relay housekeeping PR: the relay's README, Compose file, build script and tests point at the new phase numbers, and the Signal sidecar re-check date (2026-12-10, now before the Signal phase) is either met or moved to Phase 82 (open question) | The foundation is done; leaving it open blocks every relay phase, and the date falls due long before Phase 82. |
| 3 | **0.4.24 patch**: the four #46 review minors and the three doc mismatches; **Phase 27 record close** (the owner's check on the real host, 27-UAT test 8 onward, then the 27-16 summary) | Small debt, cleared before the engine changes; SECURITY.md and README must agree before Phase 70 changes the floor. |
| 4 | **Phase 69, Team Mode reconciliation**, after the owner archives `feat/team-fix-pass` on GitHub | Phase 70's signed policy, Phase 71's grants and Phase 80's approvals all need device identities and the signed log. Building them a second time would leave two trust cores. |
| 4a | In parallel: **Phase 28** (secure development workflow setup step) and the **OpenShell spike** (running now) | Phase 28 touches only setup and templates; the spike feeds Phase 72. |
| 5 | **Stage 1, Phases 70 to 74**: gate and manifests, delegation, execution backends, credential broker, run contracts. **Phase 29** (cleanup member and CleanUp tool) follows Phase 70 | The vocabulary and the gate come first because everything else is checked by them; delegation narrows what the gate checks; backends make protected folders absent; the broker needs the backends' network fence; contracts refer to capabilities, grants and backends. |
| 5a | **Stage gate**: Stage 1 verified and merged before Phase 77 starts. **v0.8.0 cyber UAT** may resume once Phase 72 is merged (owner to confirm) | The relay must not run tools before contracts and sandboxes exist; the cyber harness should run on the shared backends rather than wait for the whole relay. |
| 6 | **Stage 2, Phases 75 to 81**: inbound authenticity and channel manifests (may start once Phase 70 is merged, beside Phases 71 to 74), identity and pairing, the Teams 1:1 slice under a contract in a sandbox, the setup view, budgets, the command surface with signed approvals, group chats | Trust boundary before any happy path, 1:1 before groups, budgets once real runs exist, approvals where remote answers arrive. |
| 7 | **Stage 3, Phases 82 to 84**: Signal, Telegram, ops and release | Further channels are a manifest plus one adapter once Teams is the reference; release needs every surface to exist. |
| 8 | **Later milestones**, outlined below: Theia appliance and local inference, Team Mode on the governed core, routines and signed packages, verifiable identity and policy on NEAR, edge grouping and HQ federation, Theia desktop and learned skills | Each depends on v0.7.0's layer; the order and reasons are in that section. |

### Old and new phase numbers

Phase 68 records, `relay/README.md`, `relay/compose.yaml`, `relay/scripts/build.mjs` and the relay tests use the old numbers. Read them through this table.

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
| IN-04 message text retention (open owner decision) | 68-REVIEW-FIX, 68-CONTEXT deferred | Phase 75, decided before it stores real messages |
| A1 log redaction matches sensitive keys by containment | 68-SECURITY advisory | Phase 75 |
| A3 `connectionsCheckingInterval` near 1 s with a read-back test | 68-SECURITY advisory | Phase 75 |
| A6 tenant resolved through `getBinding` before `acceptInbound` | 68-SECURITY advisory | Phase 76 |
| D-21 single-instance lock on the state directory (AR-68-01) | 68-CONTEXT, 68-SECURITY | Phase 77 |
| A2 refuse any `NEAR_AI_KEY_` plain env name whatever its case | 68-SECURITY advisory | Phase 77 |
| Signal sidecar re-pin (tag 0.101, signal-cli 0.14.8, due about 2026-12-10) and A4 sidecar hardening | 68-CONTEXT D-21, 68-SECURITY | Phase 82 (the date: step 2 above) |
| Operator runbook (reverse proxy, TLS, backups, upgrades) | 68-CONTEXT deferred | Phase 84 |

> **Naming trap.** This milestone's relay is the *messaging* relay at `relay/`. It is **not** the paused v0.5.0 ciphertext sync relay (RELAY-01/02 archived in `.planning/milestones/v0.5.0-paused/`) and **not** the planned `relayTransport.ts` board sync on the unmerged Team Mode branch. The RELAY-01/02 ids are reused here deliberately and scoped as "v0.7.0 RELAY-01/02" in REQUIREMENTS.md.

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
**Status (2026-11-15)**: complete and verified (68-VERIFICATION.md, 4/4 must-haves); in review as PR #50. Open: the owner's D-19 step (68-08 Task 3: approve `agent-review-gates` on PR #50, then add `relay` to main's branch protection after the merge). Its carried items are listed above.

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
- [ ] 68-08-PLAN.md — relay CI job and required check, VSIX release-content patterns, docs, full phase gate, owner hand-off (D-19) (Tasks 1-2 done with a green gate; Task 3 is the owner's D-19 step)

### Stage 1: identity and governance core (Phases 69-74)

These phases change the extension's engine (`src/agent`, `src/domain`, `src/team`, with no `vscode` import in the core) and land on `main` one feature PR at a time. Everything here is editor-independent, so it moves to Theia unchanged; new UI stays small additions to existing views.

### Phase 69: Team Mode reconciliation: identities and signed events on main
**Goal**: The identity, signed-event and permission core built for Team Mode (Phase 60, verified on the unmerged `feat/team-fix-pass` branch) runs on current `main`, so the governance phases build on one tested set of device keys, signatures and permission rules; projects without Team Mode behave exactly as before, and what remains of v0.6.0 has a recorded place in the new plan.
**Depends on**: Nothing in this milestone. Starts after 0.4.23 merges, so the port is done once against a quiet `main`. Owner first: push `feat/team-fix-pass` to GitHub as an archive branch, and commit or record the five uncommitted files in its legacy worktree.
**Requirements**: TMR-01, TMR-02, TMR-03, TMR-04, TMR-05
**Success Criteria** (what must be TRUE):
  1. `feat/team-fix-pass` (local only today: 776 commits on top of 0.4.11, last commit 2026-11-05) is on GitHub as an archive branch, and the five uncommitted files in its legacy worktree are committed or recorded, before any code moves. (TMR-01)
  2. On `main`, a lead turns on Team Mode and two clones share one signed coordination log over the project's own remote; forged, unbound or under-privileged events are rejected by both with a reason, and replaying the same events always gives the same state. Phase 60's success criteria hold again on `main`, re-verified rather than assumed. (TMR-02)
  3. A project with no team file behaves exactly as before: the full suite is green, and a canary run finds no secret in the log, `team.json`, settings or audit. (TMR-03)
  4. A person's device identity signs and verifies any canonical payload (a policy bundle, a grant, an approval answer), and a key rotation or revocation is itself a signed event that later checks honour; Phases 70, 71 and 80 use this one interface. (TMR-05)
  5. Every v0.6.0 phase and requirement has a recorded disposition (landed here, carried to the Team Mode milestone, folded into a named new phase, or retired), and carried v0.6.0 ids that collide with v0.7.0 ids (TEAM-01..04, SETUP-01) carry a `TM-` prefix. (TMR-04)
**Research flags**: (1) The branch forked at 0.4.11; `main` is at 0.4.22 or later, with Phases 26 and 27 in between. Decide per file whether to port by cherry-pick or re-apply from the Phase 60 SUMMARY files; `src/extension.ts`, the `package.json` contributions and `src/agent/permissions.ts` changed most. (2) Team Mode's coordination transport and Phase 27's sync both run private git mirrors: check they cannot share or lock each other's mirror. (3) Phases 61, 62 and 62.1 stay on the archive branch for the Team Mode milestone unless the owner chooses to land them here (open question).
**Undo cost**: Low for the code (additive, inert while Team Mode is off). Higher for the signing interface (TMR-05): grants and policy bundles signed through it outlive a change.
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 69 to break down)

### Phase 70: Capability vocabulary, manifests and one gate with a floor
**Goal**: Every tool call passes one gate that decides from declared capabilities and a signed local policy, with a floor no mode, setting or delegation can override, and the gate never needs the network.
**Depends on**: Phase 69 (the policy bundle is signed with a device identity)
**Requirements**: GATE-01, GATE-02, GATE-03, GATE-04, GATE-05, GATE-06, GATE-07, OFFL-01, OFFL-02, OFFL-03
**Success Criteria** (what must be TRUE):
  1. Every built-in tool and every MCP server tool has a capability manifest (effects, hosts, credential handles, the contexts it may run in); a test enumerates every registered tool and every execution path (file tools, Bash, MCP calls, sub-agent spawns) and fails if one lacks a manifest or reaches execution without passing the gate; an undeclared MCP tool is treated as the most restrictive kind. (GATE-01, GATE-02, GATE-03, GATE-04)
  2. The Tools page and team member cards show each tool's manifest in plain words, and a local stdio MCP server is labelled as running on this machine with the person's own permissions and is refused in unattended runs unless named. (GATE-03)
  3. In every approval mode, fully-autonomous included, the key folder and credential stores are refused, and writes into `.git/` and `.near-ai/` state, publishing and destruction ask a person with no "always allow"; fully-autonomous means "no approval needed within the policy's grant", never "gate off"; the SECURITY.md limitation "fully-autonomous writes protected files without asking" is removed because it is no longer true. (GATE-05, GATE-06)
  4. With the network unplugged, every decision is made from a local policy bundle signed by the person's device identity; a missing, unsigned, tampered or expired bundle leaves only the floor plus read and plan, and the person is told in plain words how to fix it; a fresh install creates and signs its first bundle, so nothing breaks. (OFFL-01, OFFL-02)
  5. Every decision is recorded with actor, capability, outcome and the rule that decided it, and the bundle carries a version, expiry, issuer and empty slots for chain anchoring and revocation lists. (GATE-07, OFFL-03)
**Research flags**: (1) The capability grammar: start from IronClaw's manifest fields and the Hermes grammar (both in `.planning/research/platform-direction/`), version it, refuse unknown verbs, and reserve verbs for inference routes and GPU devices so later milestones need no grammar change. (2) Migration: approval modes, auto-allow switches, allow rules, protected paths (`src/domain/protectedPaths.ts`) and unattended rules (`src/agent/unattended.ts`) map into the bundle with no change in behaviour except the floor. (3) The relay reuses the vocabulary, but its workspace test lets only `relay/src/runner` import extension code: decide how the types are shared.
**Undo cost**: High. The vocabulary and the bundle format are what edge devices hold offline and what DIDs will carry on chain: settle them before they ship.
**Plans:** 0 plans
**UI hint**: yes

Plans:
- [ ] TBD (run /gsd-plan-phase 70 to break down)

### Phase 71: Delegation that only narrows
**Goal**: An agent can never hold more than it was delegated: each agent acts under its own identity, a lead passes only a subset of what it holds, grants are signed and expire, depth and fan-out are capped, and members report results in a declared shape.
**Depends on**: Phase 70
**Requirements**: DLGT-01, DLGT-02, DLGT-03, DLGT-04, DLGT-05, DLGT-06, DLGT-07
**Success Criteria** (what must be TRUE):
  1. Every agent in a run acts under its own identity with a DID document (authority section filled, sandbox section reserved); no agent uses another agent's key or a shared credential pool. (DLGT-01)
  2. A delegation gives a member the intersection of the lead's grant, the member's `tools:` line and the task's request; a property test shows no delegation ever widens, and the gate enforces it, not the prompt. (DLGT-02)
  3. Each grant is signed by its delegator, carries an expiry and a budget, and is recorded in the signed log; the gate refuses an expired, unsigned or tampered grant. (DLGT-03)
  4. A tree deeper than the limit (default: the lead plus members; members spawn only when marked as orchestrators) or wider than its fan-out caps is refused with a plain reason, and leaves never get spawning, scheduling, outbound messages, skill or memory writes, or tool and policy changes unless their grant names them. (DLGT-04, DLGT-05)
  5. A member asked for a declared result shape returns it or gets one correction turn, a restart reports an unfinished result as unknown rather than guessing, and the Agent Activity view shows for each agent what it may do in plain words and its DID for anyone who wants to inspect it. (DLGT-06, DLGT-07)
**Research flags**: (1) DID method and account: the spike's draft (`openshell-spike/did/`, an `agentGuardrails` member with `authority` and `sandbox` sections, `did:near` as a placeholder) is the starting point; derive the agent's NEAR implicit account from its Ed25519 key offline and choose a method the anchoring milestone can adopt unchanged. (2) Identity lifetime: persistent per team member per project, or per run under a member identity. (3) Spend in grants needs a running total held by the parent, not a static comparison of amounts and periods (spike finding). (4) Existing teams that nest deeper than the new default get a clear message, not a silent failure.
**Undo cost**: High. The DID document shape and the grant format are what the anchoring milestone puts on chain.
**Plans:** 0 plans
**UI hint**: yes

Plans:
- [ ] TBD (run /gsd-plan-phase 71 to break down)

### Phase 72: Execution backends on a copy, with a guarded apply
**Goal**: An agent's commands can run behind a real boundary: on a copy of the project inside a container or an OpenShell sandbox where protected folders are simply absent, with the changes brought back through an apply step that treats them as untrusted, shows the person the diff first and refuses anything that could reach outside the copy; the person always sees which boundary a run has.
**Depends on**: Phase 70, Phase 71 (per-agent policies and the delegation check). Research reads the OpenShell spike result first.
**Requirements**: EXEC-01, EXEC-02, EXEC-03, EXEC-04, EXEC-05, EXEC-06, EXEC-07, EXEC-08, EXEC-09, EXEC-10
**Spike result (2026-11-15, `.planning/research/platform-direction/openshell-spike.md`)**: OpenShell 0.1.8 on Linux with rootless Podman blocked all 33 escape cases against the key folder (absent from the copy, or present but outside the Landlock allowlist), allowed only the declared host, method and binary, injected a fake credential only on the bound endpoint and placement, and its prover rejected widened children in about 50 ms. About 50 ms is added per command and about 1 s per sandbox start, so one sandbox per run is the unit. The most important finding is on the way back: `openshell sandbox download` recreates symlinks as the sandbox made them, so a relative link to `../.near-ai/state/keys/local.key` would point at the real key once applied to the checkout.
**Success Criteria** (what must be TRUE):
  1. A project or run chooses host (today's behaviour, labelled as text checks only), container (Docker or Podman, network off unless the policy allows it) or OpenShell (Linux first, version pinned); the chat and Agent Activity say which boundary a run has, sandbox blocks appear there with the binary, host, rule and reason from the sandbox's own log, and on Windows and Intel Macs the choice is container or host, labelled, with nothing claiming isolation it does not have. (EXEC-01, EXEC-07)
  2. The copy is built by the extension from tracked files and uncommitted changes, never `.near-ai/state`, `.git` or another floor path, and never by bind-mounting the live checkout or relying on `.gitignore` filtering; the spike's 33 escape cases (run-time built paths, base64, `npm run`, recursive walks, links, `/proc`) are regression tests that fail if the key folder becomes readable. (EXEC-02, EXEC-04)
  3. Changes come back only as a diff the person sees before anything is applied, computed on the host from regular files; symlinks (including a relative link back to the key folder), special files, mode changes and paths under protected locations are refused or shown as flagged, and Revert covers what was applied. (EXEC-03)
  4. The OpenShell policy for a run is generated from the agent's grant and the team policy, never written by hand or by an agent: enforce mode, `landlock: hard_requirement`, a non-root user, network rules per binary, and a fixed vocabulary of file paths that a child may only drop or make read-only; when a lead delegates, the child's policy is checked against the parent's with the pinned prover and anything but `within_boundary` is refused, while MCP rules, which the prover cannot model, are left to Phase 71's subset check. (EXEC-05, EXEC-06)
  5. On Linux a guided setup installs the pinned OpenShell release after checking its checksums and build attestations, generates the local certificates and gateway signing keys, runs the gateway as a user service with telemetry off, keeps its sockets under the short runtime folder (the 108-byte socket path limit), and re-verifies on upgrade; under code-server the gateway runs on the host and the editor reaches it only over its own authenticated API, never through a container runtime socket. Workload images are pinned by digest, loaded where the gateway's runtime finds them, built for arm64 and amd64, and a dev server the agent starts is reachable by the person only through a forward the person can see. (EXEC-08, EXEC-09, EXEC-10)
**Research flags**: (1) Start with the spike's recommended next step as the first plan: one agent turn through the OpenShell API inside the extension (Linux, behind a setting) with copy-in, diff-out and the apply guard, before the rest is planned in detail. (2) OpenShell is 0.1.x with weekly releases and some Experimental interfaces: pin, verify attestations, re-test on every bump. (3) The gateway binary is about 113 MB: a separate guided install, not a download inside the VSIX. (4) One backend interface for agent shells and the cyber harness (`src/services/cyberSandbox.ts`), so v0.8.0's VM tier becomes another backend. (5) GPU devices: NVIDIA works through `--gpu` and Container Toolkit CDI specs, with device paths added to Landlock automatically; AMD works only by listing `/dev/kfd` and `/dev/dri` in the policy (plus CDI `amd.com/gpu`, the `render` and `video` groups, and an untested seccomp path) and needs a hardware test on a Strix Halo machine before anything is promised. Grants carry no device by default here; the appliance milestone turns them on. (6) macOS Apple Silicon through Docker Desktop or a Podman machine is supported by OpenShell but untested by us. (7) The copy-and-diff flow for long builds, `node_modules` and dev servers.
**Undo cost**: Medium. The relay, the cyber harness and the appliance all build on the backend interface; the apply guard's rules protect the person's checkout and must not loosen later.
**Plans:** 0 plans
**UI hint**: yes

Plans:
- [ ] TBD (run /gsd-plan-phase 72 to break down)

### Phase 73: Credential broker
**Goal**: Agents never hold a real key: credentials are named by handle and bound to the hosts and placements they may reach, sandboxed processes see placeholders, and tool output is checked for secrets before it reaches a model.
**Depends on**: Phase 72 (the guarantee needs the backends' network fence)
**Requirements**: CRED-01, CRED-02, CRED-03, CRED-04, CRED-05, CRED-06, CRED-07
**Success Criteria** (what must be TRUE):
  1. Every credential an agent may use is a named handle bound to its audience hosts, and the extension refuses to send it anywhere else (MCP headers, web tools, project commands). (CRED-01)
  2. In container and OpenShell runs the process sees only a placeholder; the real value is added at the boundary only on a request to the bound endpoint in the bound placement (OpenShell providers, which refused endpoint and placement mismatches in the spike), and a canary leak test finds no real credential in the sandbox, its environment, a log line, the transcript or a model request. (CRED-02, CRED-06)
  3. Shell output, MCP results and fetched pages are checked for known secret formats before they reach a model, and a match is held back and shown, as prompts already are; this also covers an approved endpoint that echoes a credential back, which OpenShell does not scrub. (CRED-03)
  4. On the host backend the existing environment scrub stays and the UI says the broker's guarantee needs a sandbox; SECURITY.md says that the sandbox supervisor terminates TLS on the machine to enforce rules and add credentials, so request contents pass through it. (CRED-04)
  5. A child agent gets a credential handle only when its grant names it, and no credential value ever appears on a command line, in a process list or in a log (providers are created through the API or the bare-key form). (CRED-05, CRED-07)
**Research flags**: (1) The container backend's egress path: header injection for known APIs versus TLS interception with a per-run certificate authority (IronClaw's process sandbox does the latter); with OpenShell, use its providers and never a second broker in series. (2) Keep NEAR AI model calls in the extension, outside the sandbox, where possible (spike recommendation). (3) Migrating MCP connection settings that hold header and environment values today.
**Undo cost**: Medium.
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 73 to break down)

### Phase 74: Run contracts
**Goal**: Every run no person started from the chat carries a signed contract with caps on cost, tool calls, time and sub-agents; a contract wider than its issuer's authority is refused before anything runs, and run admission works offline.
**Depends on**: Phase 71, Phase 72, Phase 73
**Requirements**: CTRT-01, CTRT-02, CTRT-03, CTRT-04, CTRT-05, CTRT-06, OFFL-04
**Success Criteria** (what must be TRUE):
  1. A contract names allowed capabilities, a cost cap, a tool-call cap, a wall-clock cap, the largest sub-agent tree, the backend required, whether approvals may wait or must deny, and an expiry, and it is signed by its issuer. (CTRT-01)
  2. A contract wider than its issuer holds (capabilities, budget, backend) is refused before anything runs, with the reason in plain words; admission needs no network and checks the chain of grants up to the person's signed policy, and anything the local copy cannot cover fails closed. (CTRT-02, OFFL-04)
  3. Each cap stops the run at the next turn or tool call with an honest report naming partial results, and the effective cost cap is the smallest of the contract, the run budget and the daily limit. (CTRT-03)
  4. Unattended sub-agent runs in the editor get a contract derived from the lead's grant, and an approval nobody answers in a contract run expires to deny, never to allow. (CTRT-04, CTRT-05)
  5. The contract's hash and issuer are in the signed log at start and end, with actual use against each cap. (CTRT-06)
**Research flags**: (1) Reconcile with today's caps (`nearAi.agent.maxRunCostUsd`, the daily limit, `maxRunTokens`, the loop guard, the turn limit, Phase 26's unattended approval rules) so there is one effective cap, not two that disagree. (2) Clock trust: expiry on an edge device with no network time needs a rule (a monotonic counter, or a time vouched for by the last signed bundle).
**Undo cost**: Medium to high: the relay and routines store contracts.
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 74 to break down)

**Stage gate (after Phase 74):** Phases 69-74 are verified and merged before Phase 77 lets the relay run tools. The extension's releases carry each Stage 1 phase as it lands. v0.8.0's UAT may resume once Phase 72 is merged (owner to confirm).

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
**Open decision (IN-04, owner)**: message text retention. `ackMessage` keeps up to 1 MiB of message text per `done` row with no limit in time. Decide before this phase stores real messages: blank the payload on acknowledgement (the dedupe key alone recognises a redelivery; recommended), or purge `done` rows after N days.
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
  3. Each tenant has an identity whose authority section bounds every run for that tenant, and each requester is recorded on first sight and survives a restart. (IDNT-02, IDNT-05)
  4. A person pairs their chat account in two steps (a one-time code from the operator side or the person's own editor, confirmed in the chat), recorded as a signed event; until paired a person can start runs only within the tenant's default contract and cannot approve anything; unpairing, account changes and recycled phone numbers never carry a pairing over. (PAIR-01, PAIR-02, PAIR-03)
  5. No agent can pair, unpair or change anyone's pairing. (PAIR-04)
**Carried from Phase 68**: A6 (resolve the tenant through `getBinding` before `acceptInbound`, or enforce the binding inside the store).
**Research flags**: (1) Confirm Teams tenant, thread and requester field paths against a live tenant before the schema is frozen. (2) Proactive 1:1 messaging after a group mention depends on the bot's install scope, the highest derail risk in the relay; verify here and record the fallback for Phase 81 and the Phase 84 threat model. (3) Whether everyone must pair, or unpaired people get the tenant's default contract (PAIR-02, open question).
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 76 to break down)

### Phase 77: Teams 1:1 slice under a contract in a sandbox
**Goal**: A person asks a question in a private Teams chat and the team answers, composed headlessly from the existing engine and streamed live under the tenant's own bot identity; the run executes under a contract issued from the tenant's and requester's authority, inside a container or OpenShell sandbox, never on the relay host itself. First end-to-end value, deliberately before any group work.
**Depends on**: Phase 74 (the Stage 1 gate), Phase 76
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
**Carried from Phase 68**: re-check and re-pin the sidecar (tag 0.101, signal-cli 0.14.8; the record says before about 2026-12-10, see step 2 of the order of work) and A4 (give the sidecar the relay's hardening before it first starts).
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
  5. The adversarial suite and the tenant-isolation test run in CI, so a future change cannot quietly reopen a closed pitfall; the relay image builds for arm64 and amd64 from one definition, pinned by a multi-architecture digest, and starts on both an arm64 (DGX Spark class) and an x86-64 (Strix Halo class) machine. (OPS-05, OPS-07)
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 84 to break down)

### v0.7.0 coverage

| Phase | Requirements | Count |
|-------|--------------|-------|
| 68 Relay foundation | RELAY-01 … RELAY-04 | 4 |
| 69 Team Mode reconciliation | TMR-01 … TMR-05 | 5 |
| 70 Capability vocabulary, manifests and one gate | GATE-01 … GATE-07, OFFL-01 … OFFL-03 | 10 |
| 71 Delegation that only narrows | DLGT-01 … DLGT-07 | 7 |
| 72 Execution backends on a copy, with a guarded apply | EXEC-01 … EXEC-10 | 10 |
| 73 Credential broker | CRED-01 … CRED-07 | 7 |
| 74 Run contracts | CTRT-01 … CTRT-06, OFFL-04 | 7 |
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
| **Total** | | **117** |

RUNL-05 (approvals in the private chat) is retired: APRV-01 … APRV-04 replace it with request-bound, signed approvals.

## Milestone v0.8.0: Cybersecurity

**Milestone goal:** The cybersecurity harness (target picker, legal disclaimer, defensive and offensive scans, engagement ledger) is verified end to end, its twelve regional disclaimers are accepted by the owner, and it ships as its own release, 0.8.0.

**Moved 2026-11-13** out of the 0.4.x line at the owner's request, so the cyber module is planned and released under its own number. Phase 25 keeps its number (its plans, summaries and commits already use it). Its code is already in the extension, and parts reached users in 0.4.x releases; this milestone closes UAT and the owner legal review, then adds any follow-up phases. **Order (replanned 2026-11-15, owner to confirm):** UAT resumes once v0.7.0 Phase 72 (execution backends) is merged, so the harness's sandbox runs through the shared backend interface, instead of waiting for all of v0.7.0. A follow-up phase (numbered when planned) adds the isolated VM enclave recorded in PROJECT.md as another backend of that interface (OpenShell's MicroVM driver is a candidate), with the breakout suite as its release gate; until then a scan never claims VM isolation.

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

Outlines, not plans: each gets a version number, requirements and phases (numbered from 85 on) when the owner starts it. Draft requirement ids are listed in REQUIREMENTS.md under "Later milestones". All of them build on v0.7.0's governance layer; none needs IronClaw, Hermes or OpenShell as a product we depend on, only their designs, OpenShell's policy format and its prover.

**Recommended order and why.** (1) Theia appliance and local inference first, because it is the owner's first Theia product, it is how edge devices are deployed, and an edge device with no connectivity is useless without a local model. (2) Team Mode next, because its built work decays the longer it waits and people's identities (invites, roster, device revocation) are what anchoring and federation need. (3) Routines and signed packages, the main autonomy lever, once people can sign standing orders as a team. (4) Verifiable identity and policy on NEAR, once agent, person and node identities all exist to anchor. (5) Edge grouping, compute pooling and HQ federation, which needs the appliance, people, anchoring and revocation. (6) The Theia desktop app with learned skills last, because learned skills are the riskiest self-modification and the desktop UI is where they and routines are best reviewed. Routines (3) depend only on v0.7.0 and can move earlier if the owner wants autonomy sooner.

### L1: Theia appliance and local inference on one machine
**Goal**: A team runs on one machine it owns, connected or not: a Compose stack with Theia in the browser, the agent engine, the relay and an optional OpenShell gateway, local models on an NVIDIA or AMD GPU, and NEAR AI Cloud as a burst target when the network and the policy allow.
**Scope**: Multi-architecture images (arm64 for DGX Spark class GB10 machines, amd64 for Strix Halo class machines) pinned by manifest-list digest and loadable offline as a signed bundle; GPU passthrough optional and vendor-neutral (NVIDIA Container Toolkit and CDI; AMD ROCm through `/dev/kfd` and `/dev/dri`; a CPU or Vulkan fallback), with sandboxes passing exactly the devices a grant names; a local inference service exposed to the engine as a provider next to NEAR AI Cloud, built on today's local and hybrid profiles (`src/domain/auth.ts`, `src/services/providerFactory.ts`, `privateRouteFor`, the `privacy: private` member rule); routing local first, then a NEAR AI Cloud burst, decided by the gate (private data never bursts to a non-TEE target; NEAR AI TEE models count as private only when attested; burst spend counts against the run contract); a full offline start in which the cloud is simply unavailable; the current VSIX inside Theia as the bridge for the first release (the `@nearai` chat participant is stubbed in Theia, and Theia stores AI keys in clear text, so we keep our own secret handling).
**Depends on**: v0.7.0 (relay, execution backends, gate, contracts).
**Research flags**: Local inference servers per vendor and architecture (vLLM, llama.cpp, SGLang, Ollama) on GB10 arm64 with unified memory and on Strix Halo with ROCm or Vulkan; AMD passthrough inside OpenShell needs a hardware test on a Strix Halo machine (the spike found AMD works only by listing `/dev/kfd` and `/dev/dri` in the policy, with the `render` and `video` groups and the seccomp path untested); Theia version, branding and how the VSIX bridge behaves; whether several people share one appliance (one container per person or team until Theia Cloud is needed).
**Undo cost**: Medium: the offline bundle format and image layout are what people install on machines without network.
**Phases**: TBD.

### L2: Team Mode on the governed core (the rest of v0.6.0)
**Goal**: Several people, each with their own agents, work one project without colliding, overspending or leaking secrets, now on the identities, gate, grants and backends of v0.7.0 rather than beside them.
**Scope and disposition of v0.6.0** (the branch `feat/team-fix-pass`, archived in Phase 69):

| v0.6.0 phase | Disposition |
|--------------|-------------|
| 60 Team core | Landed on `main` by Phase 69. |
| 61 Invitations, joining, removal, organization and key integration (33/35 plans) | Carried: close its owner re-test chain (61-32 to 61-35), then land on `main`. Key delivery and device revocation reuse Phase 69's signing interface. |
| 62 Team Board and 62.1 timeline (built; 62-29 and the 62-30 gate open) | Carried: land after the re-test chain closes. It is the largest webview; weigh rebuilding it as a Theia widget instead (L6). |
| 63 Claims, leases, claim workspaces, LeaseGuard | Partly superseded: claims between people stay; path leases become constraints the Phase 70 gate checks (no second gate); claim workspaces use Phase 72's copy-and-apply backends instead of another worktree mechanism. |
| 64 Dispatcher and Next Task | Carried; agent claims are signed under agent identities (Phase 71). |
| 65 Merge train and review gate | Carried; its pull-request mode uses the secure workflow kit from Phase 28 so there is one review path. |
| 66 Budgets and allocations | Re-based: allocations become spend constraints in grants and use the budget arithmetic of BUDG-04; per-key caps at the provider stay. |
| 67 Metrics, collaboration, team memory, team stop, release readiness, relay transport | Carried, except: team memory proposals share the staged-proposal pipeline with learned skills (L6), team stop builds on the gate's stop, and `relayTransport.ts` is superseded by L5's federation transport. |

Also carried: the shared code-server follow-ups (owner, 2026-11-05). Phase 27 already moved chats, run records, checkpoints and project spend history into each project's own state folder, so with one copy of the project per person those are per person already; what remains is the editor-wide spend ledger and daily limit per person, a recovery code that unlocks an encrypted backup of the person's device key and own NEAR AI key, and "Replace my device" (the lead accepts the person back as the same member).
**Depends on**: Phase 69 and v0.7.0 Stage 1.
**Research flags**: Drift: the branch forked at 0.4.11; every month on the archive raises the cost of landing 61 and 62. The v0.6.0 ids that collide with v0.7.0 ids carry a `TM-` prefix (Phase 69).
**Phases**: TBD (the planner may reuse the v0.6.0 phase content under new numbers).

### L3: Routines and signed packages
**Goal**: Teams do standing work without a person starting each run, and your organization shares teams, skills and tools as signed packages, all inside the governance layer.
**Scope**: Routines as markdown files (team, schedule or trigger, task, run contract), signed by a person and expiring; agents may propose routines, only a person creates them; unattended firings get no approvals (anything that needs one is denied and reported); the emergency stop covers routines; routines run headlessly on the relay host or appliance engine, and in the editor only while it is open (said plainly); a minimal list in today's UI, the full surface in Theia. Signed packages in the cross-vendor Agent Plugins v1 layout (`plugin.json`, `skills/`, `agents/`, `teams/`, `mcp.json`) with a capabilities block that maps one-to-one onto grant constraints; package code never runs in the extension or engine process; the Hermes lifecycle (installed disabled, pinned to a commit, scanned with a non-overridable "dangerous" verdict, fresh consent when an update widens capabilities); installing is a governed action never available to member agents. Also per-MCP-server spend limits and tool schemas loaded on demand (MCP sampling stays off).
**Depends on**: v0.7.0 (contracts, relay, signed approvals); L2 for team-signed routines.
**Research flags**: IronClaw's routine guardrails and no-result sentinel; Hermes `/goal` as a small bounded continuation; how a routine's contract is renewed before expiry without silent widening.
**Phases**: TBD.

### L4: Verifiable identity and policy on NEAR
**Goal**: The identities, grants and policies v0.7.0 keeps locally are anchored on NEAR, revocation has one source of truth, and anyone can check an agent's chain of authority.
**Scope**: Agent, person and node identities anchored as NEAR implicit accounts with DIDs (the confidential-intents format), recording policy hash, parent DID, parent signature and expiry; run admission checks the chain once per run and issues a short-lived signed lease, never per action; offline, the signed local copy decides and anything wider fails closed; revocation on chain, cached with expiry and checked at run start and lease renewal; the DID's sandbox section references an OpenShell policy by hash (spike draft: an `agentGuardrails` member with `authority` and `sandbox`), with the prover result recorded and our own subset check for what the prover cannot model (MCP tools, spend, schedules, depth, expiry); the hash-chained audit log (OCSF records) anchored on chain from time to time, queued while offline; the activity dashboard shows each agent's DID and delegation chain in plain words.
**Depends on**: v0.7.0 (DID documents, grants, signed bundles, generated sandbox policies), L2 (people and device revocation).
**Research flags**: The NEAR account model and confidential-intents anchoring (open in PROJECT.md); costs and latency of anchoring; the prover cannot prove sub-folder narrowing, so the file-path vocabulary stays fixed; spend constraints need running totals, not static comparisons (spike).
**Undo cost**: High: anything put on chain is permanent.
**Phases**: TBD.

### L5: Edge grouping, compute pooling and HQ federation
**Goal**: Machines at the edge link up with no internet to share work and GPU power, and federate with an HQ server when connectivity returns, syncing identities, policy, audit and results without either side being able to forge the other's records.
**Scope**: Signed node identities (enrolled by a person with authority, revocable); local grouping by discovery on the local network with mutual authentication, each node's gate still deciding alone; compute pooling for local inference across linked machines, NVIDIA and AMD; routing extended to local, then linked machines, then the HQ cluster, then a NEAR AI Cloud burst, each hop only where policy, privacy tier and contract allow; federation sync of identities, policy (down, as signed bundles that never widen an edge's anchored authority), audit (up, hash-chained, gaps detected) and results; inference federation to an HQ cluster as one more provider.
**Builds on**: Phase 27's encrypted sync (bundles over git with a recovery code, records merged without loss); Team Mode's signed coordination log and git transport; the paused v0.5.0 ciphertext relay design (a relay that stores only ciphertext, checks signed append capabilities, and can withhold but not forge; RELAY-01/02 in `.planning/milestones/v0.5.0-paused/`); the planned `relayTransport.ts`, which this transport replaces.
**Depends on**: L1, L2, L4.
**Research flags**: Pooling across heterogeneous NVIDIA and AMD nodes is hard and must be flagged honestly: one model split across vendors may not be practical, so expect per-vendor pools with request-level balancing; options to evaluate include llama.cpp RPC, vLLM and SGLang multi-node, and Ollama per node behind a router; OpenShell has nothing for pooling (the spike: a model server on each box behind an allowed endpoint, or a Kubernetes cluster); clock trust without network time; conflict rules when an edge and HQ both changed policy.
**Undo cost**: High for the federation record formats.
**Phases**: TBD.

### L6: Theia desktop app and learned skills
**Goal**: People who want a local install get a desktop app from the same code, with Team Studio and chat rebuilt as Theia widgets and agents, a routines screen, and teams that get better at recurring work through skills a person approves.
**Scope**: Desktop app from the appliance's code; Team Studio, chat and the board as Theia widgets or Theia AI agents; our gate in front of every tool, including tools Theia provides; routines UI; learned skills only as staged proposals (diff, the run that produced it, a scan verdict) approved by a person into a scope, signed, with the skills folder protected from file tools and no proposals from runs that read untrusted content; named agents with personalities and decision agents (PROJECT.md planned features) in the rebuilt team builder, with a decision agent acting only under a grant. The VS Code extension keeps shipping while the shared core makes that cheap.
**Depends on**: L1, L3.
**Research flags**: Theia AI's agent, skill and MCP formats (they already read `agent.md`, `SKILL.md` and MCP); which of today's webviews to rebuild first.
**Phases**: TBD.

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 27. Project state follows the project (0.4.20) | 35/36 | Shipped in 0.4.20; owner host check and 27-16 summary open | 2026-11-14 (release) |
| 28. Secure development workflow setup step | 0/TBD | Not started | - |
| 29. A cleanup member with a safe CleanUp tool | 0/TBD | Not started (after Phase 70) | - |
| 68. Relay foundation | 8/8 | Complete; PR #50 in review; owner D-19 step after merge | 2026-11-15 (verified) |
| 69. Team Mode reconciliation | 0/TBD | Not started (next to plan) | - |
| 70. Capability vocabulary, manifests and one gate | 0/TBD | Not started | - |
| 71. Delegation that only narrows | 0/TBD | Not started | - |
| 72. Execution backends on a copy, with a guarded apply | 0/TBD | Not started (spike done 2026-11-15) | - |
| 73. Credential broker | 0/TBD | Not started | - |
| 74. Run contracts | 0/TBD | Not started | - |
| 75. Inbound authenticity, allowlisting and channel manifests | 0/TBD | Not started | - |
| 76. Identity, tenants, requesters and pairing | 0/TBD | Not started | - |
| 77. Teams 1:1 slice under a contract in a sandbox | 0/TBD | Not started | - |
| 78. Messaging setup view and pairing | 0/TBD | Not started | - |
| 79. Budgets and spend ledger on run contracts | 0/TBD | Not started | - |
| 80. Command surface, run lifecycle and signed approvals | 0/TBD | Not started | - |
| 81. Group-chat discipline | 0/TBD | Not started | - |
| 82. Signal channel | 0/TBD | Not started | - |
| 83. Telegram channel | 0/TBD | Not started | - |
| 84. Ops, onboarding and release | 0/TBD | Not started | - |
| 25. Cybersecurity harness (v0.8.0) | 8/8 | UAT parked; may resume after Phase 72 | - |
