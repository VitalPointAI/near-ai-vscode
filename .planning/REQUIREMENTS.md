# Requirements: Near AI for VSCode

## Milestone v0.7.0: Messaging relay — Teams and Signal

**Defined:** 2026-11-13
**Core value:** A person in a Microsoft Teams group chat or a Signal group asks the team for something, the answer arrives where they already are, and nobody involved opens VS Code. The group sees only the finished result; the working thread stays private to whoever asked.

> **What "relay" means here.** The new messaging relay at `relay/` — receive a chat message, drive an existing agent team, post the result back. **Not** the paused v0.5.0 ciphertext sync relay (RELAY-01/02, archived in `.planning/milestones/v0.5.0-paused/`) and **not** the planned `relayTransport.ts` board sync on the unmerged Team Mode branch. Those are separate, deliberate, unrelated work.

### Relay foundation

- [ ] **RELAY-01**: The relay runs as its own workspace with its own lockfile and exactly one runtime dependency (`jose`), on Node 26.13.1 (a release carrying all current security fixes, with `engines` pinned so an older runtime refuses to start), while the extension keeps its existing Node target and zero-dependency bundle; the two never share a lockfile.
- [ ] **RELAY-02**: The relay answers a health check that reports version, uptime, whether the Teams verifier and the Signal sidecar are operational, and the count of in-flight runs, so an operator knows the box is alive without reading logs.
- [ ] **RELAY-03**: All relay state (run records, conversation bindings, tenant registry, pending approvals, message queues) lives in a single state directory that is git-ignored and readable only by the relay's OS user, and a restart loses no queued message or in-flight run record.
- [ ] **RELAY-04**: The relay ships as a container image built without a shell or package manager, and every secret it needs (bot secret, tenant API keys, Signal registration material) is read at startup from an operator-supplied source and never appears in the image, the state directory listing, or a log line.

### Inbound authenticity and allowlisting

- [ ] **AUTH-01**: Every inbound request is authenticated before anything else happens — the token's signature, issuer, audience, expiry, clock skew and its `serviceUrl` claim match the running bot's configuration — and any failure returns 403 without running anything.
- [ ] **AUTH-02**: The verifier accepts bot-emulator traffic only when a development flag is set, and a release build cannot be configured into an unverified mode.
- [ ] **AUTH-03**: A signal that the same message arrived twice (platform retry, reconnect resend, edited event) starts exactly one run; signature validity alone is not treated as replay safety, so verification is always paired with the dedupe ledger.
- [ ] **AUTH-04**: A message from a tenant or group that is not allowlisted is rejected in the channel with a plain explanation and never reaches a model.
- [ ] **AUTH-05**: A suite of adversarial requests (forged signature, tampered body, expired token, wrong issuer/audience, mismatched serviceUrl, replayed request, emulator-shaped token) is part of the build and fails the build if any of them is accepted.
- [ ] **AUTH-06**: The inbound path acknowledges within about a second and does the work afterwards, so a slow agent never makes the platform retry.

### Identity, tenants and requesters

- [ ] **IDNT-01**: Each inbound message binds to a tenant from the verified envelope alone, never from message text, and a message that cannot be bound is refused rather than guessed.
- [ ] **IDNT-02**: Each request is attributed to the person who sent it, by a channel identity recorded on first sight, and that binding survives a restart.
- [ ] **IDNT-03**: A result and its working thread can only ever reach the tenant, conversation and requester that produced them; a test proves an answer generated for one tenant cannot be delivered to another.
- [ ] **IDNT-04**: Each tenant has an isolated workspace directory and uses only its own API key, so a run can neither read another tenant's files nor bill another tenant's key.

### Runner pool and run lifecycle

- [ ] **RUNL-01**: The relay runs a team headlessly by composing the existing agent engine, tools, team library, model client, checkpoints and run markers unchanged, with the extension itself not modified.
- [ ] **RUNL-02**: Concurrent runs are capped globally, and overflow waits in a durable queue rather than being dropped or failing.
- [ ] **RUNL-03**: A person can ask a question in a 1:1 chat and receive the team's finished answer in that same chat, with progress visible while it runs.
- [ ] **RUNL-04**: A run interrupted by a restart resumes automatically inside the existing window, or reports in-channel that it died; a run never disappears silently and its record is never left in an unknown state.
- [ ] **RUNL-05**: When the run needs approval, the requester gets a durable request in their private chat; answering it continues the run, and leaving it unanswered lets the run proceed as non-blocking and later denied on expiry, instead of stalling.
- [ ] **RUNL-06**: A person can send a follow-up while a run is working, and it reaches the run or waits durably in its queue.
- [ ] **RUNL-07**: A person can cancel a run from plain text with no buttons available, and receives an honest confirmation that names the partial artifacts if anything had completed.

### Text command surface

- [ ] **CMND-01**: `help`, `status`, `cancel`, `cost`, `pause` and `resume` work as text with identical meaning in both channels, and each answers with the run it refers to.
- [ ] **CMND-02**: `status` reports elapsed time, current step and spend so far for a run.
- [ ] **CMND-03**: `cost` reports spend against the tenant's and the group's budget in the same terms the extension shows.

### Group-chat discipline

- [ ] **GRP-01**: A group chat receives an acknowledgement and the finished result and nothing else; the working thread, tool output and internal narration stay in the requester's private chat.
- [ ] **GRP-02**: Replies in a threaded channel land in the thread that caused them, and follow-ups in the group reuse the same thread.
- [ ] **GRP-03**: Group text is treated as untrusted input: members' words cannot redirect where results go, reveal the private working thread, or widen what the run may do.
- [ ] **GRP-04**: Document results (PDF, DOCX) are delivered as signed, expiring links so delivery does not depend on the customer tenant's file-storage provisioning.
- [ ] **GRP-05**: A person can drag a file into the chat and have the run use it as input, with the same result-only discipline holding for what comes back.

### Budgets and spend

- [ ] **BUDG-01**: A tenant's spend is capped and a run that would exceed the cap is refused before it is billed, with a plain in-channel explanation instead of silence.
- [ ] **BUDG-02**: A per-conversation cap exists and defaults to unlimited, so a busy group can be clamped without every group needing configuration at onboarding.
- [ ] **BUDG-03**: Every run's spend is recorded against its tenant, conversation and requester in an append-only ledger, and the totals in chat match the extension's ledger for the same key.

### Teams channel

- [ ] **TEAM-01**: The bot is an external app that a customer's administrator installs without it joining their organisation, and it works in both 1:1 and group chats inside a threaded conversation.
- [ ] **TEAM-02**: The bot is addressed by mention in a group and by direct message in a 1:1, and a greeting on first encounter happens once per thread rather than on every membership event.
- [ ] **TEAM-03**: Progress is streamed live into the private 1:1 thread and, where the platform permits it, into the group thread; when in-group streaming is not available the bot posts discrete updates instead of failing.
- [ ] **TEAM-04**: The bot presents the team's own name, avatar and personality as configured for that tenant, not a generic bot identity.

### Signal channel

- [ ] **SGNL-01**: The relay speaks Signal through a supervised sidecar running a pinned version that is never auto-upgraded, sharing credentials over a socket restricted to the relay's OS user.
- [ ] **SGNL-02**: A group on the relay's Signal number can be allowlisted, and messages from groups that are not allowlisted are rejected.
- [ ] **SGNL-03**: Every text command, acknowledgement, result and document attachment works in Signal with the same semantics as Teams, using quoted replies in place of threads.
- [ ] **SGNL-04**: An onboarding path exists for provisioning the relay's number, backing up its registration material, and recovering it, because losing that material means losing the number.

### Operations, onboarding and release

- [ ] **OPS-01**: A customer's administrator can install the bot into their tenant by following a written package of steps, including what to verify and how to upgrade.
- [ ] **OPS-02**: An operator can deploy the relay on their own host by following a written playbook covering the reverse proxy, redirect-URI validation, key provisioning and backup.
- [ ] **OPS-03**: A threat model documents each surface, what authenticates it, and the failure it prevents, and names the accepted residual risks.
- [ ] **OPS-04**: An append-only activity log lets an operator replay a run and answer a customer's "what happened here?" without access to the customer's chat.
- [ ] **OPS-05**: The adversarial suite and the tenant-isolation test run in CI, so a future change cannot quietly reopen a closed pitfall.

### Traceability

| Requirement | Phase |
|-------------|-------|
| RELAY-01 | Phase 68 — Relay foundation *(v0.7.0 RELAY-01: messaging relay workspace — see the naming-trap note at the top of this milestone; not the archived v0.5.0 ciphertext-sync RELAY-01)* |
| RELAY-02 | Phase 68 — Relay foundation *(v0.7.0 RELAY-02: health check; same naming note)* |
| RELAY-03 | Phase 68 — Relay foundation |
| RELAY-04 | Phase 68 — Relay foundation |
| AUTH-01 | Phase 69 — Inbound authenticity and allowlisting |
| AUTH-02 | Phase 69 — Inbound authenticity and allowlisting |
| AUTH-03 | Phase 69 — Inbound authenticity and allowlisting |
| AUTH-04 | Phase 69 — Inbound authenticity and allowlisting |
| AUTH-05 | Phase 69 — Inbound authenticity and allowlisting |
| AUTH-06 | Phase 69 — Inbound authenticity and allowlisting |
| IDNT-01 | Phase 70 — Identity, tenants and requesters |
| IDNT-02 | Phase 70 — Identity, tenants and requesters |
| IDNT-03 | Phase 70 — Identity, tenants and requesters |
| IDNT-04 | Phase 70 — Identity, tenants and requesters |
| RUNL-01 | Phase 71 — Teams 1:1 vertical slice (headless composition of the agent engine) |
| RUNL-02 | Phase 73 — Command surface and run lifecycle |
| RUNL-03 | Phase 71 — Teams 1:1 vertical slice |
| RUNL-04 | Phase 73 — Command surface and run lifecycle |
| RUNL-05 | Phase 73 — Command surface and run lifecycle |
| RUNL-06 | Phase 73 — Command surface and run lifecycle |
| RUNL-07 | Phase 73 — Command surface and run lifecycle |
| CMND-01 | Phase 73 — Command surface and run lifecycle |
| CMND-02 | Phase 73 — Command surface and run lifecycle |
| CMND-03 | Phase 73 — Command surface and run lifecycle |
| GRP-01 | Phase 74 — Group-chat discipline |
| GRP-02 | Phase 74 — Group-chat discipline |
| GRP-03 | Phase 74 — Group-chat discipline |
| GRP-04 | Phase 74 — Group-chat discipline |
| GRP-05 | Phase 74 — Group-chat discipline |
| BUDG-01 | Phase 72 — Budgets and spend ledger |
| BUDG-02 | Phase 72 — Budgets and spend ledger |
| BUDG-03 | Phase 72 — Budgets and spend ledger |
| TEAM-01 | Phase 71 — Teams 1:1 vertical slice |
| TEAM-02 | Phase 71 — Teams 1:1 vertical slice |
| TEAM-03 | Phase 71 — Teams 1:1 vertical slice (in-group streaming spike + fallback) |
| TEAM-04 | Phase 71 — Teams 1:1 vertical slice |
| SGNL-01 | Phase 75 — Signal channel |
| SGNL-02 | Phase 75 — Signal channel |
| SGNL-03 | Phase 75 — Signal channel |
| SGNL-04 | Phase 75 — Signal channel |
| OPS-01 | Phase 76 — Ops, onboarding and release |
| OPS-02 | Phase 76 — Ops, onboarding and release |
| OPS-03 | Phase 76 — Ops, onboarding and release |
| OPS-04 | Phase 76 — Ops, onboarding and release |
| OPS-05 | Phase 76 — Ops, onboarding and release |

Coverage: 45 of 45 v0.7.0 requirements mapped, each to exactly one phase.

## Phase 25 requirements: Cybersecurity harness (milestone v0.8.0)

**Defined:** 2026-10-30
**Core value:** A user picks a target, accepts a plain legal-use statement, and gets a reproducible offensive and defensive security assessment that the model plans, runs, verifies, and reports — with every intrusive action approved, recorded, and replayable.

### Engagement and target selection

- [ ] **CYBER-01**: A user selects a target from a dedicated Cybersecurity view: a workspace folder, a URL/host/IP, a CIDR range, a git repository, or a local container. The resolved scope (hosts, ports, paths, exclusions) is shown before anything is sent, and modes that exceed the resolved scope are disabled with a reason.
- [ ] **CYBER-02**: An engagement is recorded in `.planning/security/` with target, authorization statement, allowed modes, window, rate limit, exclusions, sandbox, and the accepted disclaimer (region, timestamp, extension version); it is immutable once a run starts, and every run names its engagement.
- [ ] **CYBER-03**: Before any probe leaves the machine the user accepts a legal-use disclaimer that names the region's law in plain language and states that the user owns the target or is authorized to test it; the interactive path is a modal and records the answer, and declining leaves the target untouched.

### Models and protocol

- [ ] **CYBER-04**: The harness drives NEAR AI models through a structured tool protocol that works with a raw-completion abliterated model that has no native tool calling: parse repair, bounded retries, and context compaction, with a visible failure when a model cannot follow the protocol.
- [ ] **CYBER-05**: Independent planner, operator, critic, and reporter roles work from one engagement, and the critic marks a finding unverified unless a reproduction command or captured evidence supports it.

### Defensive scanning

- [ ] **CYBER-06**: A defensive scan covers recon, HTTP headers and security policy, TLS and certificates, DNS, exposed paths, committed secrets, dependency and IaC findings (reusing the OSV scanner), and maps results to CVE, CWE, and OWASP with hardening advice.
- [ ] **CYBER-07**: A defensive scan of a clean target reports no findings from the seeded issue set, so false positives are measured rather than assumed.

### Offensive scanning

- [ ] **CYBER-08**: An offensive scan fingerprints the target, discovers candidate vulnerabilities, selects or develops an exploit, runs it in the sandbox, verifies access with captured evidence, records a minimal post-exploitation proof, and cleans up after itself.
- [ ] **CYBER-09**: An offensive run reports honestly when no exploit works, and distinguishes "not vulnerable", "could not determine", and "exploit failed" in the report.

### Safety and audit

- [ ] **CYBER-10**: Every active or intrusive action passes the existing permission and capability policy and is rate-limited, timed out, and scoped to the engagement; a stop control halts a run within one tool call.
- [ ] **CYBER-11**: The engagement ledger is append-only and records each step's tool, arguments, result, and model reasoning, so a run can be replayed tool-for-tool and audited by a second person.
- [ ] **CYBER-12**: Findings export as Markdown, JSON, and SARIF, carry evidence, reproduction commands, severity, and a diff against the previous run of the same engagement, and the UI states which host tools were missing so an empty result is never read as clean.

---

The v0.5.0 requirements (55, trusted-source knowledge base) are archived with the paused milestone in `.planning/milestones/v0.5.0-paused/REQUIREMENTS.md`.

## Phase 26 requirements: Performance — faster agent and research runs

**Defined:** 2026-11-10
**Core value:** A research project (or any long agent run) finishes in hours, not days, without weakening a single approval protection.

- [x] **PERF-01**: No approval stalls. Sub-agents auto-approve read-only and verification commands (tests, lint, typecheck, gate scripts the plan names, `git status/log/diff/show`) and commands that write only inside the run's own worktree, using the existing safety rules; pushes, deletes outside the worktree, publishing and credential paths still ask. An approval that is needed returns "awaiting approval" to the agent after a short, configurable wait, stays queued for the user, and notifies them; three consecutive approval timeouts pause the run with a clear message.
- [x] **PERF-02**: Context discipline. Compaction at about 60–80k tokens (configurable); large file reads default to ranges; each GSD plan, task or research workstream runs as a sub-agent with fresh context and returns a bounded summary; the system and tool prefix is stable and history append-only so NEAR's prompt cache can hit; `cached_tokens` is recorded in the activity log; a test proves the prefix is byte-stable across turns.
- [x] **PERF-03**: Models by tier, with deadlines. A model-call deadline (default about 120 s, configurable) retries on a backup model, reusing the safety check's second-model pattern; tier routing resolves planner, verifier, analyst, editor and red-team roles to `deep` and bulk fetch and extract roles to `fast` (routing and plumbing only; the role tiers themselves are set on feat/pdf-docx-output).
- [x] **PERF-04**: Parallelism. WebFetch, WebSearch and CheckCitations run concurrently; read-only shell commands run in a pool beside the serial mutating shell; the orchestrator fans out independent members or workstreams in parallel worktrees under a configurable cap; the system prompt tells agents to batch independent tool calls in one turn.
- [x] **PERF-05**: Survive reloads. Runs cut off by a VS Code reload resume automatically with a visible notice and a setting to turn it off; resumed runs do not repeat completed tool calls.
- [x] **PERF-06**: Research-mode GSD profile. Research and writing projects use bigger phases and quick mode for content edits; the plan-checker runs only for plans that change gates or verifiers; research projects get a scaffold of deterministic verifier scripts (citation resolution, figure recompute, internal-path leak check). Implemented through `src/gsd/` and project-type guidance without editing role definitions.
- [x] **PERF-07**: Measurement. The activity log's 100-event cap per session is replaced by a size bound; each run records wall time split into model wait, tool time, approval wait and idle, with input, cached and output tokens; a report command prints that breakdown for a project; the before baseline from two real projects is in the phase VERIFICATION.

| Requirement | Plan |
|-------------|------|
| PERF-01 | 26-02 |
| PERF-02 | 26-03 |
| PERF-03 | 26-03 |
| PERF-04 | 26-04 |
| PERF-05 | 26-04 |
| PERF-06 | 26-05 |
| PERF-07 | 26-01 |

## Phase 27 requirements: Project state follows the project (0.4.20)

**Defined:** 2026-11-13
**Core value:** Whatever interface or machine a person opens a project on, they pick up where they left off: no lost chats, no profile set up again, no paying to redo comparisons. Anything that leaves the machine is encrypted end to end.

- [x] **SYNC-01**: Project-local state home. Every chat thread with its full conversation history (all messages, in order, never truncated or summarised away; the 5 most recent threads stay live by default, adjustable by a user setting, and older threads are archived, never deleted, and reopenable in full), run records, checkpoints, comparison runs, applied model choices, the project's spend history and the resume pointer live in a git-ignored folder inside the project, shared by every editor that opens it on this machine.
- [x] **SYNC-02**: Safe migration. On first start of 0.4.20 each editor merges its own existing storage for the project into the state home by record id; the merge is idempotent, never overwrites a newer record and never deletes the source.
- [ ] **SYNC-03**: Portable encryption. Transcripts are encrypted with a per-project data key that is wrapped per device in SecretStorage and by the recovery-code key; transcripts under an install-local key are re-encrypted by the editor that holds that key.
- [x] **SYNC-04**: Recovery code. A high-entropy code is shown once when sync is turned on and is never stored or logged; a strong KDF derives the wrapping key; the NEAR AI key travels wrapped; a wrong code and a tampered or truncated bundle are refused with a plain message and leave state untouched (tested).
- [x] **SYNC-05**: Cross-machine sync over the project's git remote. An encrypted bundle on a dedicated branch (never `main`), written without touching the person's working tree, index or current branch. Records from two machines merge with no lost entries (tested), and a leak test proves no plaintext transcript, key, prompt, title or record id reaches the remote (file names, paths, commit messages and branch names included). Everything pushed is end-to-end encrypted so only the user (recovery code or an unlocked device of theirs) can open it; no key escrow. Sync commits use a generic author/committer identity, never the person's git name or email. The remote is a parameter of the sync layer (a private-remote setting is specified but deferred). All of it is reported in plain words.
- [x] **SYNC-06**: Model choices follow the project. Comparison runs show in Compare Models in every interface; "Apply recommended" takes effect at project level in every interface without re-running; choices applied globally before 0.4.20 are offered for import.
- [ ] **SYNC-07**: Pick up where you left off. Opening the project on a different interface or machine shows the last chat, the last run's state and the current GSD phase with its next step; one click reopens it; nothing re-runs or spends money.
- [ ] **SYNC-09**: Online home in one click. A project with no git repo or no remote is offered "Give this project an online home". One click runs `git init` if needed, signs in to GitHub through VS Code, asks public or private (with plain notes on free-plan limits and visibility), creates the repo, adds the remote and pushes the sync branch. Pushing the person's own code is a separate offer behind a check for likely secrets. If GitHub sign-in is not available, the fallbacks are the `gh` CLI or pasting an existing repo URL. Everything is reported in plain words and nothing happens without the click.
- [ ] **SYNC-08**: Release 0.4.20 through the release PR, with CHANGELOG and README (Marketplace listing) updated.
