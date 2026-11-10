# Requirements: Near AI for VSCode — 0.4.x line

## Phase 25 requirements: Cybersecurity harness

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

- [ ] **PERF-01**: No approval stalls. Sub-agents auto-approve read-only and verification commands (tests, lint, typecheck, gate scripts the plan names, `git status/log/diff/show`) and commands that write only inside the run's own worktree, using the existing safety rules; pushes, deletes outside the worktree, publishing and credential paths still ask. An approval that is needed returns "awaiting approval" to the agent after a short, configurable wait, stays queued for the user, and notifies them; three consecutive approval timeouts pause the run with a clear message.
- [ ] **PERF-02**: Context discipline. Compaction at about 60–80k tokens (configurable); large file reads default to ranges; each GSD plan, task or research workstream runs as a sub-agent with fresh context and returns a bounded summary; the system and tool prefix is stable and history append-only so NEAR's prompt cache can hit; `cached_tokens` is recorded in the activity log; a test proves the prefix is byte-stable across turns.
- [ ] **PERF-03**: Models by tier, with deadlines. A model-call deadline (default about 120 s, configurable) retries on a backup model, reusing the safety check's second-model pattern; tier routing resolves planner, verifier, analyst, editor and red-team roles to `deep` and bulk fetch and extract roles to `fast` (routing and plumbing only; the role tiers themselves are set on feat/pdf-docx-output).
- [ ] **PERF-04**: Parallelism. WebFetch, WebSearch and CheckCitations run concurrently; read-only shell commands run in a pool beside the serial mutating shell; the orchestrator fans out independent members or workstreams in parallel worktrees under a configurable cap; the system prompt tells agents to batch independent tool calls in one turn.
- [ ] **PERF-05**: Survive reloads. Runs cut off by a VS Code reload resume automatically with a visible notice and a setting to turn it off; resumed runs do not repeat completed tool calls.
- [ ] **PERF-06**: Research-mode GSD profile. Research and writing projects use bigger phases and quick mode for content edits; the plan-checker runs only for plans that change gates or verifiers; research projects get a scaffold of deterministic verifier scripts (citation resolution, figure recompute, internal-path leak check). Implemented through `src/gsd/` and project-type guidance without editing role definitions.
- [ ] **PERF-07**: Measurement. The activity log's 100-event cap per session is replaced by a size bound; each run records wall time split into model wait, tool time, approval wait and idle, with input, cached and output tokens; a report command prints that breakdown for a project; the before baseline from two real projects is in the phase VERIFICATION.

| Requirement | Plan |
|-------------|------|
| PERF-01 | 26-02 |
| PERF-02 | 26-03 |
| PERF-03 | 26-03 |
| PERF-04 | 26-04 |
| PERF-05 | 26-04 |
| PERF-06 | 26-05 |
| PERF-07 | 26-01 |
