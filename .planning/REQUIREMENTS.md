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
