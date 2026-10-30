# Roadmap: Near AI for VSCode

## Milestones

- Milestone 1: Phases 1-6 (SHIPPED)
- **v0.4.0 A working core and a native NEAR agent runner**: Phases 7-12 (SHIPPED)
- **0.4.x line**: ongoing releases on top of v0.4.0 (current; 0.4.5 published 2026-10-29)
- **v0.5.0 Trusted-source knowledge base**: PAUSED 2026-10-29 and moving to a separate project. Its roadmap, requirements, research and Phase 13 plans are archived in `.planning/milestones/v0.5.0-paused/`; the Phase 13 code lives on the local branch `gsd/phase-13-sovereignty-gate-post-quantum-cryptography-and-the-encrypted`.

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
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 25 to break down)
