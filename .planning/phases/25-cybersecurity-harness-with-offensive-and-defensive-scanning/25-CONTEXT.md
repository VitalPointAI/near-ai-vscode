# Phase 25: Cybersecurity harness with a target picker, offensive and defensive scans - Context

**Gathered:** 2026-10-30
**Status:** Ready for planning

<domain>
## Phase Boundary

A dedicated Cybersecurity panel in which the user creates an engagement (target, scope, modes, region), accepts one legal-use disclaimer per engagement, and starts a Defensive, Offensive, or Full run. The run is handed to the existing chat/agent path, where the NEAR AI model plans, operates, critiques, and reports through a JSON-in-text protocol that works without native tool calling. Output is a pentester-grade report following PTES and OWASP WSTG, with captured evidence, a hash-chained ledger, and Markdown/JSON/SARIF export.

This phase does **not** add: multi-user engagement sharing, a hosted report portal, scheduled or recurring scans, continuous monitoring, automatic remediation pull requests, or a signed report bundle. Those belong in later phases.
</domain>

<decisions>
## Implementation Decisions

### Surface and entry
- **D-01:** A dedicated webview panel, opened from a `NEAR AI: Cybersecurity` command and the activity-bar view, like Team Studio and Tools. Not a sidebar view. — **Reversibility:** costly — the panel's message bridge, media assets, and contribution points would all move if this became a sidebar view.
- **D-02:** The panel's Run button assembles the engagement and hands off to the existing chat/agent path, so approvals, streaming, transcripts, and history are reused rather than reimplemented. — **Reversibility:** costly — a harness-owned loop would replace `AgentRun` wiring, approval plumbing, and the transcript model.
- **D-03:** The live view is a step timeline (recon → probe → exploit → verify) showing tool, target, duration, and result per step, with collapsible model reasoning notes. Not a raw terminal stream.
- **D-04:** Intrusive actions are approved **once per engagement run** ("intrusive scan of N targets under engagement E — allow for this run"), then run under that grant, still subject to the deny list and the engagement's scope.
- **D-05:** After handoff the panel focuses itself to show timeline and findings; chat keeps the normal transcript.
- **D-06:** Engagements, runs, ledgers, findings, and evidence live in extension globalStorage keyed by workspace, not in the repo. — **Reversibility:** costly — moving to `.planning/security/` later means a migration plus a decision about what gets committed and shared with a team.

### Targets and sandbox
- **D-07:** All four target kinds ship in the first release: URL/host/IP, workspace folder, CIDR range, and container or git repo.
- **D-08:** Offensive payloads run in a throwaway container when `docker` or `podman` is available, otherwise a temp folder with a per-run allowlist. If neither can be made safe, offensive mode is **disabled with a stated reason**, not silently degraded. — **Reversibility:** costly — a container-first sandbox shapes tool invocation, path handling, and how cleanup is proven.
- **D-09:** Address ranges are bounded by a **budget, not a cap**: mandatory host-count preview plus a wall-clock budget; the run stops at budget and reports what it did not reach.
- **D-10:** Cleanup is proven two ways — the ephemeral container is destroyed at the end, **and** every step records files dropped and credentials or accounts created, checked after the run.
- **D-11:** Post-exploitation is model-led under hard rules: read-only, no persistence, no lateral movement, and every command shown in the report.
- **D-12:** Host tooling is detected; missing tools are offered for one-click install (npm/pip/brew/apt), each install recorded in the ledger; missing tools are always listed in findings so an empty result never reads as clean.

### Legal gate
- **D-13:** The disclaimer is a modal accepted **once per engagement**, at creation, recording target, allowed modes, and the region's law. Every run in that engagement reuses it.
- **D-14:** Twelve regions ship with reviewed plain-language text, defaulted from the OS locale, with a visible override. — **Reversibility:** costly — twelve reviewed texts are versioned content that must be re-reviewed on any change.
- **D-15:** Public-sector and critical-infrastructure targets (`.gov`, `.gov.uk`, `.mil`, cloud metadata addresses) are **warned, never hard-blocked**: shown in red in the modal, and the user decides.
- **D-16:** The accepted disclaimer is **always embedded** in exports — a header block in Markdown, a field in JSON and SARIF — carrying engagement id, scope, region, law, acceptor, and time.
- **D-17:** The acceptor types a legal name or organization; the record also stores OS user, machine, extension version, and time.
- **D-18:** Re-acceptance is required when the region or target scope changes, and when the extension version changes, so the stored acceptance always matches the shipped text. — **Reversibility:** costly — the acceptance is embedded in exported reports, so loosening the rule retroactively changes what a past report claims.

### Models and protocol
- **D-19:** The model is driven by **JSON-in-text always**: every step is a JSON object parsed from plain text, with repair, bounded retries, and a visible failure. No reliance on native tool calling. — **Reversibility:** one-way — the protocol, its prompts, its tests, and every recorded ledger are shaped by this; adopting native tool calling later needs a second protocol plus a replay migration.
- **D-20:** One model plays planner, operator, critic, and reporter across four separate calls with different prompts.
- **D-21:** The panel holds its own model selection, remembered per engagement, defaulting to the chat model on first use.
- **D-22:** The critic verifies each finding against a reproduction command or captured evidence, **may re-probe a specific step** (bounded retries) to gather evidence, and marks a finding unverified when it still cannot.

### Offensive path
- **D-23:** Known-CVE-first, then a custom PoC developed from the discovered weakness; the report states which path was taken.
- **D-24:** Four verdicts per finding: not vulnerable, vulnerable but exploit failed, could not determine (with a reason), verified access. A failure never renders as "clean".
- **D-25:** Three depth profiles — Quick (recon, headers/TLS, top findings), Standard (adds exploit attempts and source scan), Deep (full port sweep, CVE sweep, multiple exploit attempts, replay-ready) — chosen at run time.

### Reporting and evidence
- **D-26:** Reports follow PTES sections (executive summary, scope and rules of engagement, methodology, findings by severity, exploitation narrative, remediation, evidence appendix), with OWASP WSTG test ids per check and CVSS 3.1 vectors per finding.
- **D-27:** A finding captures all four evidence kinds: HTTP request/response captures with timings, raw tool output stored verbatim (nuclei JSON, nmap XML, semgrep SARIF), post-exploitation access proof (session transcript, `whoami`/`hostname`, file listing, timestamped), and visual captures rendered into the Markdown report.
- **D-28:** A SHA-256 hash chain links each ledger entry to its predecessor and hashes every evidence blob, so the report can prove nothing was edited after the fact. — **Reversibility:** one-way — once reports claim a verified chain, changing the hash construction breaks verification of every existing report.

### Claude's Discretion
- Exact webview layout, density, and typography of the panel; the step-timeline visual treatment.
- Built-in probe set and implementation (HTTP/TCP/DNS/TLS in Node) versus host tools, as long as the floor is "no external binary required".
- The JSON step schema, repair heuristics, and retry/compaction numbers.
- CVSS vector derivation where the evidence does not determine a metric outright (must be shown, not hidden).
- Where evidence blobs sit relative to the ledger inside globalStorage, and how they are pruned.
- The precise wording of the twelve regional statements, subject to owner review before release.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase definition
- `.planning/ROADMAP.md` — Phase 25 goal, scope, success criteria, research flags
- `.planning/REQUIREMENTS.md` — CYBER-01…12, the requirement set this phase must satisfy

### Project conventions
- `.planning/PROJECT.md` — product principles that bind this phase (private by default, user control, gated writes and network, transparency)
- `.planning/UX-CONTRACT.md` — streaming status, visible approvals, interruptibility, accessibility, theming
- `.planning/codebase/ARCHITECTURE.md` — layers, webview message passing, activation gating
- `.planning/codebase/CONVENTIONS.md` — naming, error handling, layering (`src/domain` has no `vscode` import), comment habits
- `.planning/codebase/TESTING.md` — `node --test`, hand-written doubles, real git in temp dirs, what not to mock
- `.planning/codebase/CONCERNS.md` — the inline-webview-string debt this panel must avoid
- `.planning/codebase/STRUCTURE.md` — where new modules belong

### Standards the report must satisfy
- PTES (Penetration Testing Execution Standard) — report section structure (D-26)
- OWASP Web Security Testing Guide — WSTG test ids per check (D-26)
- CVSS 3.1 specification — vector and score per finding (D-26)
- SARIF 2.1.0 — export schema (CYBER-12)

No repository copies of these standards exist; the researcher must pull the exact PTES section list, the WSTG id catalogue, and the SARIF 2.1.0 field requirements.
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/security/scan.ts`, `src/security/osv.ts`, `src/security/lockfiles.ts` — OSV.dev dependency checks, runtime EOL checks, CycloneDX SBOM; the workspace target's supply-chain portion reuses this rather than re-implementing it.
- `src/agent/securityTool.ts` — the existing `SecurityScan` tool shape and its `SecurityAccess` consent gate, which new harness tools should mirror.
- `src/services/securityScan.ts` — consent modal, diagnostics, status bar, output channel, and the "ask once per project" pattern; a template for the per-engagement gate.
- `src/agent/tools.ts` — the `AgentTool` interface (`capability`, `parse`, `title`, `preview`, `sensitive`, `risky`, `untrusted`, `run`) that new probe and exploit tools must implement.
- `src/agent/permissions.ts` — `decidePermission`, deny and allow lists, `RunGrants`, and `decidePermissionAsync` with the safety model; intrusive actions must ride this.
- `src/services/emergencyStop.ts` — the global stop control that covers part of CYBER-10.
- `src/services/teamStudioPanel.ts`, `src/services/toolsPage.ts`, `src/services/activityView.ts`, `src/services/mcpView.ts` — singleton webview-panel patterns with `media/` assets and typed messages; the Cybersecurity panel follows one of these.
- `media/tools/tools.js`, `media/activity/activity.js` — client renderers to imitate for the step timeline.
- `src/services/chatBridge.ts` — the typed message pattern; the panel needs its own message union rather than additions to `ChatWebviewMessage`.

### Established Patterns
- `src/domain/` stays free of `vscode` imports; engagement records, verdicts, severity, the disclaimer catalogue, and CVSS derivation belong there so they are testable under plain Node.
- `src/services/` holds stateful stores; the engagement store and ledger store belong there.
- Activation is gated on `workspaceContains:.planning/.near-ai/**`; the Cybersecurity command needs its own activation event or must reuse the existing one.
- Panels are singletons in module scope, disposed on close, with `retainContextWhenHidden` where a run must survive a tab switch.
- Webview client code lives in `media/<area>/*.js|css`, never inline strings; `src/services/chat.ts` is the cautionary example.

### Integration Points
- `src/extension.ts` — command registration and the view container; the Cybersecurity command and panel registration land here.
- `src/services/agentSession.ts:540` — where the tool list is assembled (`CORE_TOOLS` + web + graphics + `securityTool` + MCP + memory); harness tools join here behind a mode flag so ordinary chat does not carry them.
- `src/services/chat.ts` and `chatBridge.ts` — the handoff path the panel's Run button uses to start a run with a composed prompt.
- `src/agent/untrusted.ts` — target responses are outside content; probe results must be marked untrusted so a malicious target banner cannot steer the run.
- `src/services/activityStore.ts`, `src/services/auditStore.ts` — existing activity and audit patterns the engagement ledger should follow without being conflated with them.

</code_context>

<specifics>
## Specific Ideas

- The owner's bar: "enable someone to properly audit and report findings to the level expected of a pen tester" — the report and its evidence are the product, not a by-product of the scan.
- "Needs to be able to export a suitable report and evidence as well as capture approvals and ensure people are able to operate within legal bounds."
- Built for abliterated raw-completion models: assume no native tool calling, weak instruction following, and validate every step.
- The consent copy in `src/services/securityScan.ts` ("…No code or file contents are sent…") is the register to match: plain, specific, honest about what leaves the machine.

</specifics>

<deferred>
## Deferred Ideas

- Multi-user engagement sharing and a hosted report portal — later phase.
- Scheduled or recurring scans and continuous monitoring — later phase.
- Automatic remediation pull requests from findings — later phase.
- Publishing engagement records to `.planning/security/` for team sharing — deferred; globalStorage was chosen (D-06), so a "publish engagement" action would be its own phase.
- Signed (Ed25519) report bundles — considered, deferred in favour of the hash chain (D-28).
- Cloning arbitrary git remotes and pulling container images may need their own network allowlist entry; flagged for research rather than decided here.
</deferred>

---

*Phase: 25-Cybersecurity harness with a target picker, offensive and defensive scans*
*Context gathered: 2026-10-30*
