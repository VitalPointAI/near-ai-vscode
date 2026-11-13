# Roadmap: Near AI for VSCode

## Milestones

- Milestone 1: Phases 1-6 (SHIPPED)
- **v0.4.0 A working core and a native NEAR agent runner**: Phases 7-12 (SHIPPED)
- **0.4.x line**: ongoing releases on top of v0.4.0 (current; 0.4.19 published; 0.4.20 = Phase 27, next before v0.7.0)
- **v0.5.0 Trusted-source knowledge base**: PAUSED 2026-10-29 and moving to a separate project. Its roadmap, requirements, research and Phase 13 plans are archived in `.planning/milestones/v0.5.0-paused/`; the Phase 13 code lives on the local branch `gsd/phase-13-sovereignty-gate-post-quantum-cryptography-and-the-encrypted`.
- **v0.7.0 Messaging relay — Teams and Signal**: Phases 68-76 (in planning; requirements defined 2026-11-13)
- **v0.8.0 Cybersecurity**: Phase 25 (executed; UAT parked until after v0.7.0)

## 0.4.x line

Work here ships as 0.4.x releases: a `hotfix/0.4.N` branch from `main`, then the full unit, e2e and release checks, then the Marketplace and GitHub release once the owner approves that version.

| Release | Date | Highlights |
|---------|------|------------|
| 0.4.1 | 2026-10-28 | Build-tooling security fixes; tests stay honest |
| 0.4.2 | 2026-10-28 | Auto approval mode; 429 retry storm fixed |
| 0.4.3 | 2026-10-28 | Approval mode picker in the chat bar |
| 0.4.4 | 2026-10-29 | Conversations, steering, accurate spend, Agent Activity overview, Tools directory |
| 0.4.5 | 2026-10-29 | Team Studio; stalled replies retried and reported; reporting token in Settings |

Next phases are added here (integer numbering continues from 26) when 0.4.x work is planned with GSD.

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
**Plans:** 18 plans (11 waves)

Plans:
- [ ] 27-01-PLAN.md — Wire format and crypto core: recovery code, scrypt wrap, padded AEAD objects, sealed manifest, every refusal (owner confirms the contract first)
- [ ] 27-02-PLAN.md — Merge laws: records, forks, tombstones, append-only thread entries, property tests; random temp names in shared writers
- [ ] 27-03-PLAN.md — Project state home and shared data key on one host (D-04, D-10), new settings, sealed NEAR AI key copy for a second editor (D-15)
- [ ] 27-04-PLAN.md — Run liveness across editors (writer + heartbeat), markers, checkpoints and activity in the state home
- [ ] 27-05-PLAN.md — Full thread history captured before compaction; shared ThreadStore; no pruning (D-07, D-12, D-13)
- [ ] 27-06-PLAN.md — Reopen with every message: tool-step cards, chunked rendering, history list from the index
- [ ] 27-07-PLAN.md — 5 live conversations, crash-safe archive, reopen makes live (D-08)
- [ ] 27-08-PLAN.md — @near chat participant turns recorded and reopened in the panel (D-07)
- [ ] 27-09-PLAN.md — Comparisons and applied model choices follow the project; import offer (D-06)
- [ ] 27-10-PLAN.md — Safe migration from each editor's storage; project spend history mirror (D-05, D-11)
- [ ] 27-11-PLAN.md — Git transport: private mirror, anonymous commits, remote as a parameter, leak scan (D-01, D-09)
- [ ] 27-12-PLAN.md — Two-machine sync: collect, verify, merge, apply; refusal leaves state untouched
- [ ] 27-13-PLAN.md — Archived threads as cold objects with lazy fetch; consolidation and size limits
- [ ] 27-14-PLAN.md — "Pick up where you left off" card (D-03)
- [ ] 27-15-PLAN.md — Sync on/off, recovery code shown once, restore on a second machine with the NEAR AI key (D-02); no remote routes into the online-home setup; sync status published
- [ ] 27-17-PLAN.md — "Give this project an online home": GitHub repo public or private on click, gh or pasted-URL fallback, separate checked code push, resumable (D-14, SYNC-09)
- [ ] 27-18-PLAN.md — Visible sync control in the chat panel bar with five states, errors on the control, dismissible turn-on prompt (D-16)
- [ ] 27-16-PLAN.md — Phase gate, owner check on the real host, README/SECURITY, feature PR and release 0.4.20

## Milestone v0.7.0: Messaging relay — Teams and Signal

**Milestone goal:** A person in a Microsoft Teams group chat or a Signal group asks the team for something, the answer arrives where they already are, and nobody involved opens VS Code. The group sees only the finished result; the working thread stays private to whoever asked.

**Phase numbering:** v0.7.0 starts at Phase 68. Branch-shipped phases end at 26; the unmerged `feat/team-fix-pass` branch already claims Phases 60-67 for v0.6.0 — starting at 68 keeps every phase id globally unique whichever lands first. Requirements were defined 2026-11-13 in `.planning/REQUIREMENTS.md`; research lives in `.planning/research/` (STACK, FEATURES, ARCHITECTURE, PITFALLS, SUMMARY).

> **Naming trap.** This milestone is the *messaging* relay at `relay/`: receive a chat message, drive an existing agent team, post the result back. It is **not** the paused v0.5.0 ciphertext sync relay (whose RELAY-01/02 are archived in `.planning/milestones/v0.5.0-paused/`) and **not** the planned `relayTransport.ts` board sync on the unmerged Team Mode branch. The RELAY-01/02 ids are reused here deliberately and are scoped as "v0.7.0 RELAY-01/02" in REQUIREMENTS.md traceability; the ids themselves are not renamed.

Build order follows the trust boundary: foundation → inbound authenticity (adversarial tests before any happy path — 6 of 8 pitfalls are High and sit here) → identity/tenant registry → Teams 1:1 vertical slice (deliberately not groups first) → budgets once the run registry exists → command surface and lifecycle hardening → group discipline → Signal → ops and release.

### Phase 68: Relay foundation
**Goal**: An operator runs the relay as their own host-side service — its own workspace, its own state directory, its own hardened container — before any chat traffic is accepted.
**Depends on**: Nothing in this milestone (builds on the shipped harness and extension)
**Requirements**: RELAY-01, RELAY-02, RELAY-03, RELAY-04
**Success Criteria** (what must be TRUE):
  1. A clean checkout installs the relay workspace on Node 26.13.1 with `engines` pinned so an older runtime refuses to start, its lockfile separate from the extension's, and exactly one new runtime dependency (`jose`) — while the extension keeps its existing Node target and zero-dependency bundle untouched. (RELAY-01)
  2. `GET /healthz` on a running relay reports version, uptime, whether the Teams verifier and the Signal sidecar are operational, and the count of in-flight runs, observable without reading logs. (RELAY-02)
  3. Killing the relay with queued messages and in-flight run records and restarting it loses nothing: all state (run records, conversation bindings, tenant registry, pending approvals, message queues) lives in one git-ignored directory readable only by the relay's OS user. (RELAY-03)
  4. The relay ships as a container image built without a shell or package manager, and every secret (bot secret, tenant API keys, Signal registration material) is read at startup from an operator-supplied source and never appears in the image, the state directory listing, or a log line. (RELAY-04)
**Research flags**: (1) `node:sqlite` is RC in Node 26 — name the JSON-file-per-tenant fallback for registry/state now so storage choices in later phases stay honest. (2) Pin the exact `signal-cli-rest-api` sidecar version in the container definition this early; verify the image's bundled signal-cli age at integration time (Phase 75).
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 68 to break down)

### Phase 69: Inbound authenticity and allowlisting
**Goal**: Nothing forged, replayed, expired, emulator-shaped or unallowlisted ever reaches a model — the trust boundary is proven by adversarial tests before any happy-path handler exists.
**Depends on**: Phase 68
**Requirements**: AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-05, AUTH-06
**Success Criteria** (what must be TRUE):
  1. Every adversarial case — forged signature, tampered body, expired token, wrong issuer/audience, mismatched `serviceUrl`, replayed request, emulator-shaped token without the development flag — is rejected with 403 before anything runs, the verifier also checking clock skew, and the suite is part of the build and fails the build if any case is accepted. (AUTH-01, AUTH-02, AUTH-05)
  2. A signal that the same message arrived twice (platform retry, reconnect resend, edited event) starts exactly one run — signature validity alone is never treated as replay safety; verification is always paired with the dedupe ledger. (AUTH-03)
  3. A message from a tenant or group that is not allowlisted is rejected in the channel with a plain explanation and never reaches a model. (AUTH-04)
  4. The inbound path acknowledges within about a second and does the work afterwards, so a slow agent never makes the platform retry. (AUTH-06)
**Research flags**: PITFALLS ranks 6 of 8 pitfalls High and on this boundary — adversarial tests land here, before the vertical slice, not after.
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 69 to break down)

### Phase 70: Identity, tenants and requesters
**Goal**: Every message binds to a tenant and a requester from the verified envelope alone, and isolation between tenants is a tested property, not an intention.
**Depends on**: Phase 69
**Requirements**: IDNT-01, IDNT-02, IDNT-03, IDNT-04
**Success Criteria** (what must be TRUE):
  1. Each inbound message binds to a tenant from the verified envelope alone, never from message text, and a message that cannot be bound is refused rather than guessed. (IDNT-01)
  2. Each request is attributed to the person who sent it via a channel identity recorded on first sight, and that binding survives a restart. (IDNT-02)
  3. A test proves a result and its working thread can only ever reach the tenant, conversation and requester that produced them — an answer generated for one tenant cannot be delivered to another. (IDNT-03)
  4. Each tenant has an isolated workspace directory and uses only its own API key: a run can neither read another tenant's files nor bill another tenant's key. (IDNT-04)
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 70 to break down)

### Phase 71: Teams 1:1 vertical slice
**Goal**: A person asks a question in a private Teams chat and the existing agent team answers — composed headlessly, streamed live, under the tenant's own bot identity. First end-to-end value, deliberately before any group work.
**Depends on**: Phase 70
**Requirements**: RUNL-01, RUNL-03, TEAM-01, TEAM-02, TEAM-03, TEAM-04
**Success Criteria** (what must be TRUE):
  1. The relay runs a team headlessly by composing the existing agent engine, tools, team library, model client, checkpoints and run markers unchanged, with the extension itself not modified. (RUNL-01)
  2. A customer's administrator installs the bot as an external app without it joining their organisation; it works in 1:1 and group chats inside a threaded conversation, is addressed by direct message in a 1:1 and by mention in a group, and greets on first encounter once per thread rather than on every membership event. (TEAM-01, TEAM-02)
  3. A person asks a question in a 1:1 chat and receives the team's finished answer in that same chat, with progress visible while it runs. (RUNL-03)
  4. Progress streams live into the private 1:1 thread and, where the platform permits it, into the group thread; when in-group streaming is not available the bot posts discrete updates instead of failing. (TEAM-03)
  5. The bot presents the team's own name, avatar and personality as configured for that tenant, not a generic bot identity. (TEAM-04)
**Research flags**: (1) Headless harness composition has never been done — the first runner-child boot is a spike with its fallback documented before group work starts. (2) Teams in-group streaming is undocumented (FEATURES): spike it here; the accepted fallback is ack + discrete updates in-group ("post-don't-stream"), which TEAM-03 already permits.
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 71 to break down)

### Phase 72: Budgets and spend ledger
**Goal**: Spend is metered where runs happen and capped before the surface grows: a tenant's cap always applies, a conversation's cap defaults to unlimited, and every recorded total reconciles with the extension's ledger.
**Depends on**: Phase 71 (the run registry now exists — budgets attach to real runs)
**Requirements**: BUDG-01, BUDG-02, BUDG-03
**Success Criteria** (what must be TRUE):
  1. A tenant's spend is capped and a run that would exceed the cap is refused before it is billed, with a plain in-channel explanation instead of silence. (BUDG-01)
  2. A per-conversation cap exists and defaults to unlimited, so a busy group can be clamped without every group needing configuration at onboarding. (BUDG-02)
  3. Every run's spend is recorded against its tenant, conversation and requester in an append-only ledger, and the totals in chat match the extension's ledger for the same key. (BUDG-03)
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 72 to break down)

### Phase 73: Command surface and run lifecycle
**Goal**: Runs are controllable from plain text with honest lifecycle semantics: queued when busy, resumed or honestly reported when interrupted, approvable without stalling, steerable mid-run, cancellable with an honest receipt — and every state answerable through six commands that mean the same thing in both channels.
**Depends on**: Phase 72 (`cost` reports against the ledger this phase builds on)
**Requirements**: RUNL-02, RUNL-04, RUNL-05, RUNL-06, RUNL-07, CMND-01, CMND-02, CMND-03
**Success Criteria** (what must be TRUE):
  1. Concurrent runs are capped globally, and overflow waits in a durable queue rather than being dropped or failing. (RUNL-02)
  2. A run interrupted by a restart resumes automatically inside the existing window, or reports in-channel that it died; a run never disappears silently and its record is never left in an unknown state. (RUNL-04)
  3. When the run needs approval, the requester gets a durable request in their private chat; answering it continues the run, and leaving it unanswered lets the run proceed as non-blocking and later denied on expiry, instead of stalling. (RUNL-05)
  4. A person can send a follow-up while a run is working and it reaches the run or waits durably in its queue, and can cancel a run from plain text with no buttons, receiving an honest confirmation that names the partial artifacts if anything had completed. (RUNL-06, RUNL-07)
  5. `help`, `status`, `cancel`, `cost`, `pause` and `resume` work as text with identical meaning in both channels and each answers with the run it refers to; `status` reports elapsed time, current step and spend so far; `cost` reports spend against the tenant's and the group's budget in the same terms the extension shows. (CMND-01, CMND-02, CMND-03)
**Reuse pointers**: durable restart lives in `src/services/runMarkers.ts` (not `runActivity.ts`), constrained by `AUTO_RESUME_WITHIN_MS`=12h and `MAX_AUTO_RESUMES`=3; `src/agent/` has zero `vscode` imports and is the reuse surface; `src/services/chat.ts` is UI-bound — the relay must NOT import it.
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 73 to break down)

### Phase 74: Group-chat discipline
**Goal**: In groups the bot is a good citizen: an acknowledgement and the finished result, in the right thread, and nothing else — with group text treated as untrusted input and documents and files flowing both ways without leaking the working thread.
**Depends on**: Phase 73 (follow-up queues and threading semantics already exist)
**Requirements**: GRP-01, GRP-02, GRP-03, GRP-04, GRP-05
**Success Criteria** (what must be TRUE):
  1. A group chat receives an acknowledgement and the finished result and nothing else: the working thread, tool output and internal narration stay in the requester's private chat. (GRP-01)
  2. Replies in a threaded channel land in the thread that caused them, and follow-ups in the group reuse the same thread. (GRP-02)
  3. Group text is treated as untrusted input: members' words cannot redirect where results go, reveal the private working thread, or widen what the run may do. (GRP-03)
  4. Document results (PDF, DOCX) are delivered as signed, expiring links so delivery does not depend on the customer tenant's file-storage provisioning. (GRP-04)
  5. A person can drag a file into the chat and have the run use it as input, with the same result-only discipline holding for what comes back. (GRP-05)
**Research flags**: Proactive 1:1 messaging after a group @mention depends on the bot install scope — the highest derail risk in the milestone; if the scope blocks it, the documented fallback (everything in-group, result-only) is recorded here and carried into Phase 76's known limitations.
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 74 to break down)

### Phase 75: Signal channel
**Goal**: The same disciplined experience works over Signal through a supervised, version-pinned sidecar, with its own allowlist and its own registration-material safety net.
**Depends on**: Phase 74 (Teams semantics are the reference Signal parity is measured against)
**Requirements**: SGNL-01, SGNL-02, SGNL-03, SGNL-04
**Success Criteria** (what must be TRUE):
  1. The relay speaks Signal through a supervised sidecar running a pinned version that is never auto-upgraded, sharing credentials over a socket restricted to the relay's OS user. (SGNL-01)
  2. A group on the relay's Signal number can be allowlisted, and messages from groups that are not allowlisted are rejected. (SGNL-02)
  3. Every text command, acknowledgement, result and document attachment works in Signal with the same semantics as Teams, using quoted replies in place of threads. (SGNL-03)
  4. An onboarding path exists for provisioning the relay's number, backing up its registration material, and recovering it, because losing that material means losing the number. (SGNL-04)
**Research flags**: Pin the exact signal-cli version (locked decision, carried from Phase 68's container definition) and verify the sidecar image's bundled signal-cli age before integrating.
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 75 to break down)

### Phase 76: Ops, onboarding and release
**Goal**: A customer's admin and an operator can install, deploy and operate the relay without the core team in the room, the threat model is written down, and CI keeps the trust boundary closed after release.
**Depends on**: Phase 75 (all surfaces exist to be documented and defended)
**Requirements**: OPS-01, OPS-02, OPS-03, OPS-04, OPS-05
**Success Criteria** (what must be TRUE):
  1. A customer's administrator can install the bot into their tenant by following a written package of steps, including what to verify and how to upgrade. (OPS-01)
  2. An operator can deploy the relay on their own host by following a written playbook covering the reverse proxy, redirect-URI validation, key provisioning and backup. (OPS-02)
  3. A threat model documents each surface, what authenticates it, and the failure it prevents, and names the accepted residual risks — including the Phase 74 proactive-message fallback decision if install scope forced it. (OPS-03)
  4. An append-only activity log lets an operator replay a run and answer a customer's "what happened here?" without access to the customer's chat. (OPS-04)
  5. The adversarial suite and the tenant-isolation test run in CI, so a future change cannot quietly reopen a closed pitfall. (OPS-05)
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 76 to break down)

### v0.7.0 coverage

| Phase | Requirements | Count |
|-------|--------------|-------|
| 68 Relay foundation | RELAY-01, RELAY-02, RELAY-03, RELAY-04 | 4 |
| 69 Inbound authenticity and allowlisting | AUTH-01 … AUTH-06 | 6 |
| 70 Identity, tenants and requesters | IDNT-01 … IDNT-04 | 4 |
| 71 Teams 1:1 vertical slice | RUNL-01, RUNL-03, TEAM-01 … TEAM-04 | 6 |
| 72 Budgets and spend ledger | BUDG-01, BUDG-02, BUDG-03 | 3 |
| 73 Command surface and run lifecycle | RUNL-02, RUNL-04 … RUNL-07, CMND-01 … CMND-03 | 8 |
| 74 Group-chat discipline | GRP-01 … GRP-05 | 5 |
| 75 Signal channel | SGNL-01 … SGNL-04 | 4 |
| 76 Ops, onboarding and release | OPS-01 … OPS-05 | 5 |
| **Total** | | **45** |

## Milestone v0.8.0: Cybersecurity

**Milestone goal:** The cybersecurity harness (target picker, legal disclaimer, defensive and offensive scans, engagement ledger) is verified end to end, its twelve regional disclaimers are accepted by the owner, and it ships as its own release, 0.8.0.

**Moved 2026-11-13** out of the 0.4.x line at the owner's request, so the cyber module is planned and released under its own number. Phase 25 keeps its number (its plans, summaries and commits already use it). Its code is already in the extension, and parts reached users in 0.4.x releases; this milestone closes UAT and the owner legal review, then adds any follow-up phases. **Order:** after v0.7.0 (the relay); UAT stays parked until then.

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

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 27. Project state follows the project (0.4.20) | 0/TBD | Context gathered | - |
| 68. Relay foundation | 0/TBD | Not started | - |
| 69. Inbound authenticity and allowlisting | 0/TBD | Not started | - |
| 70. Identity, tenants and requesters | 0/TBD | Not started | - |
| 71. Teams 1:1 vertical slice | 0/TBD | Not started | - |
| 72. Budgets and spend ledger | 0/TBD | Not started | - |
| 73. Command surface and run lifecycle | 0/TBD | Not started | - |
| 74. Group-chat discipline | 0/TBD | Not started | - |
| 75. Signal channel | 0/TBD | Not started | - |
| 76. Ops, onboarding and release | 0/TBD | Not started | - |
| 25. Cybersecurity harness (v0.8.0) | 8/8 | UAT parked until after v0.7.0 | - |
