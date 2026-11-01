# Phase 25: Cybersecurity Harness - Research

**Researched:** 2026-10-31
**Domain:** Cybersecurity scanning harness — target picker, legal gate, offensive/defensive scans, PTES reporting, SARIF export
**Confidence:** HIGH

## Summary

This research covers the technical domain for Phase 25: a dedicated Cybersecurity panel in the Near AI VS Code extension that lets users pick targets (workspace folder, URL/host/IP, CIDR range, container, git repo), accept a region-aware legal disclaimer once per engagement, and run Defensive, Offensive, or Full scans. The run is handed to the existing chat/agent path where the model plans, operates, critiques, and reports through a JSON-in-text protocol designed for abliterated raw-completion models. Output must be pentester-grade: PTES report structure with OWASP WSTG test IDs, CVSS 3.1 vectors, four evidence kinds captured, a SHA-256 hash-chained append-only ledger, and Markdown/JSON/SARIF export.

**Primary recommendation:** Leverage the existing `src/agent/` loop, `AgentTool` interface, `decidePermission`/`RunGrants` policy gate, and `emergencyStop` control; add a cybersecurity panel service following the established singleton webview pattern; use `docker`/`podman` for offensive sandbox with temp-folder fallback; parse host-tool output with Node built-ins; and build the model protocol around bounded-retry JSON parse-repair with context compaction.

## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Dedicated webview panel, opened from a `NEAR AI: Cybersecurity` command and activity-bar view.
- **D-02:** Run button hands off to existing chat/agent path; approvals, streaming, transcripts, history reused.
- **D-03:** Live view is a step timeline (recon → probe → exploit → verify) with collapsible model reasoning.
- **D-04:** Intrusive actions approved once per engagement run, then run under that grant with deny list and scope.
- **D-05:** After handoff, panel focuses to show timeline and findings; chat keeps normal transcript.
- **D-06:** Engagements, runs, ledgers, findings, evidence live in extension globalStorage keyed by workspace.
- **D-07:** All four target kinds ship in first release: URL/host/IP, workspace folder, CIDR range, container or git repo.
- **D-08:** Offensive payloads run in throwaway container when docker/podman available, else temp folder with per-run allowlist, else offensive mode disabled with stated reason.
- **D-09:** Address ranges bounded by budget (host-count preview + wall-clock budget); run stops at budget.
- **D-10:** Cleanup proven two ways — container destroyed, and every step records files dropped and credentials created, checked after run.
- **D-11:** Post-exploitation model-led under hard rules: read-only, no persistence, no lateral movement, every command shown.
- **D-12:** Host tools detected; missing offered for one-click install; missing always listed in findings.
- **D-13:** Disclaimer is modal accepted once per engagement at creation, recording target, allowed modes, and region's law.
- **D-14:** Twelve regions with reviewed plain-language text, defaulted from OS locale, with visible override.
- **D-15:** Public-sector/critical-infrastructure targets (.gov, .gov.uk, .mil, cloud metadata 169.254.169.254) warned, never hard-blocked.
- **D-16:** Accepted disclaimer embedded in exports (header in Markdown, field in JSON/SARIF).
- **D-17:** Acceptor types legal name/organization; record stores OS user, machine, extension version, time.
- **D-18:** Re-acceptance required when region, target scope, or extension version changes.
- **D-19:** JSON-in-text always — every step is a JSON object parsed from plain text, with repair, bounded retries, visible failure.
- **D-20:** One model plays planner, operator, critic, reporter across four separate calls with different prompts.
- **D-21:** Panel holds its own model selection, remembered per engagement, defaulting to chat model.
- **D-22:** Critic verifies each finding against reproduction command or evidence, may re-probe (bounded), marks unverified when it cannot.
- **D-23:** Known-CVE-first, then custom PoC from discovered weakness; report states which path.
- **D-24:** Four verdicts per finding: not vulnerable, vulnerable but exploit failed, could not determine, verified access. Failure never renders as "clean".
- **D-25:** Three depth profiles — Quick, Standard, Deep — chosen at run time.
- **D-26:** Reports follow PTES sections, OWASP WSTG test IDs per check, CVSS 3.1 vectors per finding.
- **D-27:** Finding captures all four evidence kinds: HTTP req/res, raw tool output, post-exploitation access proof, visual captures.
- **D-28:** SHA-256 hash chain links ledger entries to predecessor and hashes evidence blobs.

### Claude's Discretion
- Exact webview layout, density, typography, step-timeline visual treatment.
- Built-in probe set (HTTP/TCP/DNS/TLS in Node) vs host tools implementation.
- JSON step schema, repair heuristics, retry/compaction numbers.
- CVSS vector derivation where evidence doesn't determine a metric outright.
- Evidence blob storage location relative to ledger and pruning strategy.
- Precise wording of twelve regional statements (subject to owner review).

### Deferred Ideas (OUT OF SCOPE)
- Multi-user engagement sharing and hosted report portal.
- Scheduled/recurring scans and continuous monitoring.
- Automatic remediation pull requests from findings.
- Publishing engagement records to `.planning/security/` for team sharing.
- Signed (Ed25519) report bundles (deferred in favour of hash chain D-28).
- Cloning arbitrary git remotes and pulling container images — flagged for research (see §Network Destinations).

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CYBER-01 | Target picker (workspace, URL/host, CIDR, git repo, container) with resolved scope preview | §Standard Stack (built-in probes), §Target Resolution |
| CYBER-02 | Engagement record in `.planning/security/` (immutable once run starts) | §Engagement Store Schema |
| CYBER-03 | Legal-use disclaimer modal by region, records answer | §Legal Text and Regional Coverage |
| CYBER-04 | Structured protocol with parse repair, bounded retries, context compaction for raw-completion models | §JSON Step Protocol |
| CYBER-05 | Independent planner/operator/critic/reporter roles, critic requires reproduction/evidence | §Handoff Architecture |
| CYBER-06 | Defensive scan: recon, headers/TLS/DNS, secrets, dependency/IaC scanning, CVE/CWE/OWASP mapping | §Defensive Probe Suite, §Standard Stack |
| CYBER-07 | Clean target reports no seeded findings | §Test Targets |
| CYBER-08 | Offensive scan: fingerprint, discover, exploit, sandbox PoC, access verify, post-exploit proof, cleanup | §Sandbox Architecture |
| CYBER-09 | Honest reporting: not vulnerable / could not determine / exploit failed (never "clean") | §Offensive Verdicts |
| CYBER-10 | Intrusive actions pass permission policy, rate-limited, timed out, stop control | §Handoff Architecture (existing approval path) |
| CYBER-11 | Append-only engagement ledger: tool, args, result, reasoning | §Ledger Schema |
| CYBER-12 | Export Markdown, JSON, SARIF with evidence, reproduction commands, severity, diff, missing tools listed | §SARIF Export, §Report Export |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:tls` (built-in) | Node built-in | TLS introspection, certificate validation, SNI | `[VERIFIED: node.js docs]` No external deps; `tls.connect()`, `tls.TLSSocket.getPeerCertificate()` |
| `node:dns/promises` (built-in) | Node built-in | DNS A/AAAA/MX/TXT resolution | `[VERIFIED: node.js docs]` Standard resolver, no npm dep |
| `node:net` (built-in) | Node built-in | TCP port scanning, raw socket connectivity | `[VERIFIED: node.js docs]` `net.connect()` for probe |
| `node:https` (built-in) | Node built-in | HTTP headers, response inspection | `[VERIFIED: node.js docs]` `https.request()` for header/TLS checks |
| `node:child_process` (built-in) | Node built-in | Executing host tools (nmap, nuclei, etc.) | `[VERIFIED: node.js docs]` `execFile()` for safe sub-process |
| `zod` | 3.24.x | Input validation, schema definitions | `[CITED: npmjs.com/package/zod]` Widely used, lightweight, TypeScript-native. Verify: `npm view zod version` |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `devcontainers` npm package | per devcontainer spec | Detect devcontainer support | `[ASSUMED]` Check if `@devcontainers/cli` exists; otherwise parse `.devcontainer/devcontainer.json` manually |
| `js-yaml` | 4.0.x | YAML parsing for semgrep/IaC output | `[CITED: npmjs.com/package/js-yaml]` Common YAML lib; verify `npm view js-yaml version` |
| `fast-xml-parser` | 4.4.x | XML parsing for nmap output | `[CITED: npmjs.com/package/fast-xml-parser]` Faster than xml2js; verify `npm view fast-xml-parser version` |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Node built-in TLS probes | `node-fetch` or `got` | Built-ins have zero deps, no npm install |
| `zod` for validation | `ajv` (JSON Schema) | Zod is TS-native, no schema-to-code step; AJV needs JSON Schema files |
| `devcontainers` npm pkg | Docker CLI via child_process | Docker is already probed for sandbox; `devcontainers` CLI is separate install |

**Installation:**
```bash
npm install zod js-yaml fast-xml-parser
```

**Version verification:**
```bash
npm view zod version
npm view js-yaml version
npm view fast-xml-parser version
```

## Host Tool Availability and Output Formats

**D-12:** Detect host tools; offer one-click install; list missing in findings.

### Tool Matrix

| Tool | Ecosystem | JSON Output Flag | Parse Strategy | Notes |
|------|-----------|-----------------|----------------|-------|
| `nmap` | OS package (apt/brew) | `-oX` (XML) / `-oJ` (JSON) | `fast-xml-parser` on XML, native JSON on `-oJ` | `[CITED: nmap.org/docs.html]` `nmap -oJ -sn <target>` for host discovery; `-oX` has broader historical use |
| `httpx` | Go binary (ProjectDiscovery) | `-json` | native JSON | `[CITED: github.com/projectdiscovery/httpx]` Outputs NDJSON (newline-delimited JSON) |
| `nuclei` | Go binary (ProjectDiscovery) | `-json` / `-jsonl` | native JSON/NDJSON | `[CITED: github.com/projectdiscovery/nuclei]` `-jsonl` one JSON object per line; `-json` wraps in `{"results":[]}` |
| `nikto` | Perl package (cirt.net) | `-Format json` | native JSON | `[ASSUMED]` May output XML; check `nikto -h` for available formats |
| `sqlmap` | Python package | `--json` | native JSON | `[ASSUMED]` sqlmap is interactive by default; JSON mode may need `--batch` |
| `semgrep` | Python/Go package | `--json` | native JSON | `[CITED: semgrep.dev/docs]` `semgrep --json` outputs SARIF-like JSON |
| `trivy` | Go binary (Aqua) | `--format json` | native JSON | `[CITED: github.com/aquasecurity/trivy]` Standard `--format json` output |
| `gitleaks` | Go binary | `--report-format json` | native JSON | `[CITED: github.com/gitleaks/gitleaks]` `--report-format json --report-path -` |
| `whatweb` | Ruby gem | `--json` | native JSON | `[ASSUMED]` Check whatweb `--help` for JSON flag |
| `testssl.sh` | Bash script | `--jsonfile <file>` | native JSON | `[CITED: testssl.sh]` Writes to a file, not stdout; `-p` port scan, `-t` TLS |

### Detection Strategy

```typescript
// Pseudocode
function detectTool(name: string): boolean {
  try {
    const { stdout } = execFileSync(name, ['--version'], { timeout: 3000 });
    return stdout.length > 0;
  } catch { return false; }
}
```

### When Tool Is Absent

- List in findings table with reason "host tool not installed"
- Never render "clean" without noting tool absence
- Offer install path: `npm install` (for npm packages), `pip install` (for pip packages), `brew install` (macOS), `apt install` (Debian/Ubuntu)
- Record install action in ledger (D-12)

### NDJSON Handling

Tools like `httpx` and `nuclei -jsonl` produce one JSON object per line. Parse by splitting on `\n` and calling `JSON.parse()` on each non-empty line, wrapping in an array for processing.

## Architecture Patterns

### Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Target picker UI | Webview panel | — | D-01: dedicated panel, not sidebar |
| Target resolution (CIDR expansion, DNS lookup) | `src/domain/cyber.ts` | — | Pure domain logic, testable without vscode |
| Host tool detection | `src/services/cyberTools.ts` | — | Service that probes OS environment |
| Legal disclaimer modal | Webview panel | `src/services/cyberLegal.ts` | D-13: modal at engagement creation |
| Disclaimer storage | `src/services/cyberEngagementStore.ts` | — | Per-engagement immutable record |
| Model protocol (JSON-in-text) | `src/domain/cyberProtocol.ts` | — | D-19: pure domain logic for schema/repair |
| Engagement handoff to agent loop | `src/services/cyberRun.ts` | `src/services/chat.ts` | D-02: handoff to existing chat/agent path |
| Offensive sandbox (container) | `src/services/cyberSandbox.ts` | — | Spawns/destroys container via docker/podman |
| Temp-folder sandbox fallback | `src/services/cyberSandbox.ts` | — | D-08 fallback |
| Tool execution (built-in probes) | `src/agent/cyberTools.ts` | — | Implements `AgentTool` interface |
| Host tool execution | `src/agent/cyberTools.ts` | — | `AgentTool` wrapper around `child_process` |
| Approval gate (intrusive actions) | `src/agent/permissions.ts` | — | Reuse existing `decidePermission` + `RunGrants` |
| Emergency stop | `src/services/emergencyStop.ts` | — | Reuse existing global stop |
| Ledger (append-only) | `src/services/cyberLedgerStore.ts` | — | D-11, D-28: hash-chained entries |
| Report generation (PTES/Markdown) | `src/services/cyberReport.ts` | — | Assemble findings into PTES structure |
| SARIF export | `src/services/cyberSarifExport.ts` | — | D-12: convert findings to SARIF 2.1.0 |
| Evidence storage | `src/services/cyberEvidenceStore.ts` | — | D-06, D-27: blobs in globalStorage |
| CVSS 3.1 derivation | `src/domain/cyber.ts` | — | Pure math, no external deps |
| WSTG mapping | `src/domain/cyber.ts` | — | Lookup table mapping test category → WSTG ID |

### Recommended Project Structure

```
src/
├── domain/
│   ├── cyber.ts              # Engagement schema, verdicts, CVSS derivation, WSTG mapping, PTES sections
│   ├── cyberProtocol.ts      # JSON step schema, parse-repair, retry logic
│   ├── cyberLegal.ts         # Regional disclaimer texts, region detection
│   └── cyberLedger.ts        # Hash-chain ledger types and utilities
├── services/
│   ├── cyberPanel.ts         # Singleton webview provider (D-01 pattern)
│   ├── cyberEngagementStore.ts  # Engagement CRUD in globalStorage (D-06)
│   ├── cyberLedgerStore.ts   # Append-only ledger persistence
│   ├── cyberSandbox.ts       # Docker/podman container + temp-folder fallback (D-08)
│   ├── cyberTools.ts         # Host tool detection, one-click install offers
│   ├── cyberReport.ts        # PTES Markdown report assembly
│   ├── cyberSarifExport.ts   # SARIF 2.1.0 conversion
│   └── cyberEvidenceStore.ts # Evidence blob storage and pruning
├── agent/
│   ├── cyberTools.ts         # AgentTool implementations for probes/exploits
│   └── cyberProtocol.ts      # Model-driven loop protocol driver
├── extension.ts              # Register command, panel, activation
└── gsd/
    └── (unchanged)
media/
└── cyber/                    # Panel webview HTML/CSS/JS
    ├── cyber.html
    ├── cyber.css
    └── cyber.js
```

### Pattern: Hash-Chained Append-Only Ledger (D-28)

Each ledger entry:
```json
{
  "index": 0,
  "timestamp": "2026-10-31T12:00:00Z",
  "tool": "nmap",
  "arguments": ["-sn", "192.168.1.0/24"],
  "result": "{\"hosts\": [...]}",
  "modelReasoning": "Starting host discovery...",
  "evidenceHash": null,
  "prevHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "hash": "sha256-of-serialization"
}
```

- `prevHash` of entry 0 = SHA-256 of bytes `"0000000000000000..."` (32 zero bytes)
- `hash` = SHA-256(`index + timestamp + tool + arguments + result + modelReasoning + evidenceHash + prevHash` as canonical JSON)
- Evidence blobs: computed SHA-256, stored as `evidenceHash`
- Verification: re-serialize entry, compute SHA-256, compare with `hash`; chain check: verify entry N's `prevHash` matches entry N-1's `hash`

### Pattern: Engagement Store (D-06, D-02)

```typescript
interface Engagement {
  id: string;                    // generated UUID
  workspace: string;             // workspace folder URI
  target: Target;                // { type: 'workspace' | 'url' | 'cidr' | 'container' | 'git'; value: string }
  resolvedScope: ResolvedScope;  // { hosts: string[]; ports: number[]; paths: string[]; exclusions: string[] }
  region: RegionCode;            // e.g., 'us', 'uk', 'eu'
  acceptedDisclaimer: DisclaimerAcceptance;
  allowedModes: ('passive' | 'active' | 'intrusive')[];
  sandbox: 'container' | 'tempFolder' | 'disabled';
  sandboxReason?: string;
  window?: { start: string; end: string };
  rateLimit?: { opsPerMinute: number };
  exclusions: string[];
  runs: Run[];                   // immutable once added
  createdAt: string;
  immutable: boolean;            // true once runs[0].state === 'running'
}
interface DisclaimerAcceptance {
  region: RegionCode;
  textVersion: string;           // version string for re-acceptance (D-18)
  extensionVersion: string;
  timestamp: string;
  acceptor: string;              // legal name / organization
  osUser: string;
  machine: string;
}
```

## Sandbox Architecture

**D-08:** Offensive payloads run in throwaway container when docker/podman exists, else temp folder with per-run allowlist, else offensive mode disabled.

### Container Lifecycle

```
1. Detect: docker --version || podman --version
2. Create: docker run --rm -d --name cyber-<uuid> -v <workspace>:/workspace:ro <image>
3. Execute: docker exec cyber-<uuid> <payload>
4. Cleanup: docker rm -f cyber-<uuid>  (guaranteed, even on error via finally block)
5. Verify: docker inspect cyber-<uuid> returns "no such container"
```

- **Image:** Use a minimal base (e.g., `alpine` or `gcr.io/distroless/static`) to minimize attack surface
- **Network:** Container should have no outbound network access unless explicitly required by the engagement scope
- **Volume mount:** Workspace mounted read-only (`:ro`) to prevent container from modifying target files
- **Container name:** Unique per run (`cyber-<uuid>`) for easy cleanup

### Temp Folder Fallback

When no container runtime available:
- Create temp directory: `mkdtemp(path.join(os.tmpdir(), 'cyber-'))`
- Set per-run allowlist: only specific tools/paths are accessible
- **Security:** Use OS-level restrictions where possible (chmod, umask)
- **Limitation:** No network isolation — offensive payloads can reach the host network

### Windows/WSL Considerations

- On WSL, `docker`/`podman` from the WSL distro can access Docker Desktop on Windows
- On native Windows, consider `podman machine` for container isolation
- Temp folder fallback is the primary path on Windows without WSL

### Cleanup Verification (D-10)

Two ways to prove cleanup:
1. **Container destroyed:** `docker ps -a | grep cyber-<uuid>` returns empty
2. **Step recording:** Every step records `filesDropped: string[]` and `credentialsCreated: string[]`; after run, check these don't persist

### Depth Profiles (D-25)

| Profile | What Runs | Time Budget |
|---------|-----------|-------------|
| Quick | Recon, headers/TLS, top nuclei findings, semgrep, trivy, gitleaks | 5 min |
| Standard | Quick + exploit attempts (CVE-first), source scan, sqlmap basic | 15 min |
| Deep | Standard + full port sweep, multiple exploit attempts, trivy deep | 45 min |

## Legal Text and Regional Coverage

**D-14:** Twelve regions with reviewed plain-language text.

### Proposed Twelve Regions

| # | Region Code | Region Name | Primary Computer-Misuse Statute |
|---|------------|-------------|-------------------------------|
| 1 | `us` | United States | 18 U.S.C. § 1030 (CFAA) |
| 2 | `uk` | United Kingdom | Computer Misuse Act 1990 (c. 18), §1 |
| 3 | `eu` | European Union (general) | Budapest Convention (Cybercrime Convention), national implementations |
| 4 | `ca` | Canada | Criminal Code (R.S.C. 1985), § 342.1 (Unauthorized use of computer) |
| 5 | `au` | Australia | Cybercrime Act 2001 (Cth), Div 473 |
| 6 | `nz` | New Zealand | Computer Crimes Act 1967 |
| 7 | `jp` | Japan | Penal Code § 234+ (Unlawful access to computer) |
| 8 | `in` | India | Information Technology Act 2000, § 43/66 |
| 9 | `br` | Brazil | Lei Carolina (Law 12.737/2012), Art. 154-A |
| 10 | `za` | South Africa | Electronic Communications and Transactions Act 25 of 2002 |
| 11 | `sg` | Singapore | Computer Misuse Act (Cap 501) |
| 12 | `ae` | UAE | Federal Decree-Law No. 34 of 2021 on Counter-Combatting Rumours and Cybercrime |

### Statute Summaries (Plain Language)

**UK — Computer Misuse Act 1990 §1:** It is an offence to cause a computer to perform any function with intent to secure unauthorised access to any program or data, knowing that the access is unauthorised. `[CITED: legislation.gov.uk/ukpga/1990/18/section/1]` Maximum penalty: 2 years imprisonment or fine or both.

**US — CFAA 18 U.S.C. § 1030:** Prohibits intentionally accessing a computer without authorization or exceeding authorization, and thereby obtaining information from any protected computer. Applies to federal computers and computers used in interstate commerce. `[ASSUMED]` — must verify exact language; penalty varies by subsection.

**EU — Budapest Convention:** International treaty requiring criminalization of illegal access, illegal interception, data interference, and system interference. Implemented in member states through national legislation. `[ASSUMED]`

**Canada — Criminal Code § 342.1:** Makes it an offence to wilfully procure unauthorised access to a computer system, including obtaining any data or code. `[ASSUMED]`

**Australia — Cybercrime Act 2001:** Prohibits unauthorised access to or modification of restricted data held in computers, and unauthorised impairment of electronic communication. `[ASSUMED]`

### Public-Sector Warning (D-15)

Targets matching these patterns receive a red warning in the disclaimer modal, **never a hard block**:
- `*.gov`, `*.gov.uk`, `*.mil`, `*.mil.uk`, `*.gov.au`, `*.gov.in` (and other country-code TLDs for `.gov`/`.mil`)
- `169.254.169.254` (AWS cloud metadata)
- `100.64.0.0/10` (Cloudflare metadata, RFC 6598)
- `169.254.169.254/32` (Azure/GCP metadata endpoints may differ)

### Disclaimer Embedding in Exports (D-16)

```markdown
---
# Engagement: eng-abc123
# Target: http://target.local
# Scope: passive, active, intrusive
# Region: uk
# Law: Computer Misuse Act 1990, Section 1
# Authorised by: John Smith
# Machine: johns-macbook.local (user: johns)
# Extension: near-ai-vscode 0.4.5
# Time: 2026-10-31T12:00:00Z
---
```

### Region Detection (D-14)

Default from OS locale:
- `Intl.DateTimeFormat().resolvedOptions().timeZone`
- Map to region code (e.g., `Europe/London` → `uk`, `America/New_York` → `us`)
- Fallback to `us` if unknown
- Visible override always available

## JSON Step Protocol for Raw-Completion Models

**D-19, CYBER-04:** Structured tool protocol for models without native tool calling.

### Step Schema

```typescript
interface Step {
  id: string;              // unique step ID, auto-generated by harness
  role: 'planner' | 'operator' | 'critic' | 'reporter';
  action: 'probe' | 'exploit' | 'verify' | 'recon' | 'report';
  target: string;          // what to act on
  tool: string;            // which tool to use (built-in or host binary)
  args: string[];          // tool arguments
  sandbox: 'auto' | 'container' | 'tempFolder' | 'none';
  expectedResult?: {       // what success looks like
    httpStatus?: number;
    pattern?: string;
    command?: string;
  };
  safetyFlags?: {          // what the operator should check
    maxDurationMs: number;
    rateLimit: number;
    denyList: string[];
  };
}
```

### Parse-Repair Strategy

1. **Extract JSON block:** Look for ```json ... ``` or the first `{` to last `}` in model output
2. **Parse:** `JSON.parse(block)`
3. **Repair (if parse fails):**
   - Remove trailing commas: `str.replace(/,\s*([}\]])/g, '$1')`
   - Fix single quotes to double quotes
   - Remove comments (`// ...`)
   - Retry up to 3 times
4. **Schema validation:** If Zod parses, validate; if validation fails, log error and return visible failure
5. **Bounded retries:** Maximum 3 repair attempts per step; on exhaustion, emit visible failure to panel

### Context Compaction

When the model's context window is filling:
- Compress earlier steps to summary form: `{"id":"1","action":"probe","target":"10.0.0.1","result":"closed","reasoning":"..."}`
- Remove full tool output; keep only summary
- Keep last N steps in full detail
- Preserve all evidence hashes in compaction

### Detecting Protocol Failure

- If 3 consecutive steps fail parse-repair, mark model as "incompatible with protocol"
- Emit visible failure in panel: "Model did not follow JSON protocol — results may be incomplete"
- Continue run if other roles succeed (e.g., critic may still produce results)

### Model Prompting Strategy

Four separate model calls with distinct system prompts:

1. **Planner:** "You are a penetration test planner. Analyze the target and produce a step-by-step plan using the JSON step schema."
2. **Operator:** "You are a penetration test operator. Execute each step from the plan using the provided tool and report results."
3. **Critic:** "You are a penetration test critic. Verify each finding by re-probing or checking evidence. Mark findings verified or unverified."
4. **Reporter:** "You are a penetration test reporter. Compile findings into a PTES-format report with CVSS 3.1 vectors."

## Handoff Architecture

**D-02, CYBER-04, CYBER-05, CYBER-10:** Handoff to existing chat/agent path.

### The Seam

From `src/services/chat.ts`:
- `chat.ts` handles webview messages at ~line 111 (onDidReceiveMessage)
- `AgentConversation` (`src/services/agentSession.ts` ~line 90) builds system prompt and creates `AgentRun`
- `AgentRun.run()` calls `NearAiClient` for streamed completions

**Cybersecurity panel starts a run by:**
1. Assembling engagement + scope + depth profile into a prompt
2. Posting to `chat.ts` via the existing message bridge
3. `AgentConversation` creates a new `AgentRun` with cybersecurity-specific system prompt
4. `AgentRun.run()` streams completions back through the normal path

### RunGrants (D-04)

Reuse existing `RunGrants` from `src/agent/permissions.ts`:
- Before run starts, panel creates a `RunGrants` with `intrusive: true` for the engagement
- The single intrusive approval card covers all steps in that engagement run
- Steps still pass through `decidePermission` but grant level is already set

### Rate Limits and Timeouts (CYBER-10)

- **Per-tool rate limit:** Inject into step as `safetyFlags.rateLimit`; operator must respect
- **Global timeout:** Use `AbortSignal` passed to `AgentRun.run()`; panel's stop button triggers abort
- **Emergency stop:** Reuse existing `src/services/emergencyStop.ts` — already checked globally in the agent loop
- **Budget (D-09):** Host-count preview before run; wall-clock budget enforced by step timeout

### Per-Tool Rate Limits/Timeouts Attachment Points

- `src/agent/loop.ts`: `AgentRun.run()` checks `emergencyStop` each iteration — inject custom stop condition here
- `src/agent/shell.ts`: `ShellSession` has `DEFAULT_TIMEOUT_MS` and `MAX_TIMEOUT_MS` — inject per-step timeout through step config
- `src/agent/tools.ts`: Each `AgentTool.run()` receives step metadata — include rate limit in tool invocation

### Where the Panel Listens for Results

- `AgentEvent`s stream from `AgentRun` through `AgentConversation` → `chat.ts` → webview
- Panel needs to register its own handler to display the step timeline
- Pattern: similar to how Team Studio listens to events from `teamStudio.ts`
- Panel messages in `src/services/chatBridge.ts` — add `CyberWebviewMessage` union type

## Defensive Probe Suite

**CYBER-06:** Defensive scan covers recon, headers/TLS/DNS, exposed paths, committed secrets, dependency/IaC findings, CVE mapping, hardening advice.

### Built-In Node Probes (No External Binaries)

| Probe | Node API | What It Checks |
|-------|----------|----------------|
| HTTP headers | `node:https` | Security headers (HSTS, CSP, X-Frame-Options, X-Content-Type-Options, etc.) |
| TLS version/cipher | `node:tls` | TLS 1.2+, cipher strength, certificate validity, expiry, SNI |
| DNS records | `node:dns/promises` | A, AAAA, MX, TXT (SPF, DKIM, DMARC) records |
| TCP port scan | `node:net` | Open ports (syn connect, non-blocking) |
| HTTP response body | `node:https` | Info leakage (server header, error pages, technology fingerprints) |
|robots.txt | `node:https` | Exposed paths listed in robots.txt |
| sitemap.xml | `node:https` | Discovered URLs for further probing |
| Certificate inspection | `tls.TLSSocket.getPeerCertificate()` | Cert chain, SANs, issuer, expiry |

### Host-Tool Defensive Probes

| Tool | What It Adds |
|------|-------------|
| `nuclei` | Template-based vulnerability scanning (CVEs, misconfigs) |
| `semgrep` | SAST: source code patterns for vulnerabilities |
| `trivy` | Container/image and dependency vulnerability scanning |
| `gitleaks` | Secret scanning in source code |
| `nikto` | Web server misconfiguration scanning |
| `testssl.sh` | Deep TLS/SSL analysis |
| `whatweb` | Technology fingerprinting |
| `httpx` | HTTP probing (title, status, tech detection) |
| `sqlmap` | SQL injection testing (active mode) |

### OSV.dev Reuse (CYBER-06)

Reuse existing `src/security/osv.ts` and `src/security/scan.ts` for:
- Dependency vulnerability lookup (OSV.dev API)
- Runtime EOL checks
- CycloneDX SBOM analysis

This is already implemented; cybersecurity phase calls the existing functions.

### WSTG Mapping

OWASP WSTG v4.2 test categories and representative IDs:

```
WSTG-INFO-0x  → Information gathering (4.1)
WSTG-CONF-0x  → Configuration and deployment (4.2)
WSTG-IDM-0x   → Identity management (4.3)
WSTG-AUTH-0x  → Authentication (4.4)
WSTG-AUTHZ-0x → Authorization (4.5)
WSTG-SES-0x   → Session management (4.6)
WSTG-INJ-0x   → Injection (4.7)
WSTG-ERR-0x   → Error handling (4.8)
WSTG-CRYPTO-0x→ Weak cryptography (4.9)
WSTG-BIZ-0x   → Business logic (4.10)
WSTG-CLIENT-0x→ Client-side (4.11)
WSTG-API-0x   → API testing (4.12)
WSTG-WASM-0x  → WebAssembly (4.13)
```

Each finding maps to 1+ WSTG ID. The mapping is a lookup table in `src/domain/cyber.ts`:
```typescript
const WSTG_MAP: Record<TestCategory, string[]> = {
  'missing-hsts': ['WSTG-CONF-02'],
  'weak-tls': ['WSTG-INFO-09', 'WSTG-CRYPTO-01'],
  'xss-reflected': ['WSTG-INJ-01'],
  'sql-injection': ['WSTG-INJ-05'],
  // ... etc
};
```

## Offensive Scanning

**D-23, D-24, CYBER-08, CYBER-09:** Offensive scan with known-CVE-first, custom PoC, sandbox execution, access verification, four verdicts.

### Offensive Workflow

```
1. Fingerprint: whatweb + nuclei recon → service version, framework, ports
2. Known-CVE search: match fingerprint to CVE list, check if exploit exists
3. If known exploit found:
   a. Build PoC with CVE details
   b. Execute in sandbox (container)
   c. Verify access
4. If no known exploit:
   a. Developer custom PoC from discovered weakness
   b. Execute in sandbox
   c. Verify access
5. Record verdict (not vulnerable / exploit failed / could not determine / verified access)
6. Post-exploitation proof (read-only, no persistence, no lateral movement)
7. Cleanup
```

### Four Verdicts

| Verdict | When | Report Language |
|---------|------|----------------|
| `not_vulnerable` | Probe returned negative, target is patched | "Target is not vulnerable to [test]" |
| `exploit_failed` | PoC ran but access was not achieved | "Exploit attempt failed — [reason]" |
| `could_not_determine` | Inconclusive results | "Unable to determine — [reason]" |
| `verified_access` | Access proof captured | "Verified access — [evidence]" |

**Critical:** A failure NEVER renders as "clean". At minimum: "No vulnerabilities found with available tools — note: [missing tools listed]."

### Post-Exploitation Hard Rules (D-11)

- Read-only: `cat`, `ls`, `whoami`, `hostname`, `id` — NO `rm`, `cp -r`, `chmod`, `crontab`
- No persistence: NO `useradd`, `ssh-keygen`, `crontab -e`, `systemctl enable`
- No lateral movement: NO `ssh target2`, `nmap -oG 10.0.0.0/24`
- Every command shown in report

### Evidence Kinds (D-27)

| Kind | Format | Storage |
|------|--------|---------|
| HTTP request/response | Captured with timings | Inline in finding JSON |
| Raw tool output | Verbatim (nuclei JSON, nmap XML) | Blobs in globalStorage |
| Post-exploitation access proof | Session transcript, whoami/hostname, file listing, timestamped | Inline + blob for screenshots |
| Visual captures | Screenshots rendered into Markdown | Blob in globalStorage, reference in report |

## PTES Report Structure

**D-26, CYBER-12:** Reports follow PTES sections.

### PTES Report Sections (from pentest-standard.org)

1. **Executive Summary** — Non-technical overview of findings, overall risk assessment
2. **Scope and Rules of Engagement** — Target, authorized methods, disallowed methods, authorization statement
3. **Methodology** — Testing approach, tools used, OWASP WSTG alignment, depth profile
4. **Findings by Severity** — Each finding with:
   - Title, severity (Critical/High/Medium/Low/Info)
   - CVSS 3.1 vector and score
   - WSTG test IDs
   - CVE/CWE references
   - Description, impact, evidence
   - Reproduction command
   - Remediation advice
5. **Exploitation Narrative** — Step-by-step how each finding was exploited
6. **Remediation Summary** — Prioritized list of fixes, effort estimates
7. **Evidence Appendix** — Raw tool output, screenshots, session transcripts, hash chain verification
8. **Acceptance / Authorization** — Embedded disclaimer with engagement details (D-16)

### CVSS 3.1 Base Metrics

From FIRST specification:
- **AV:** Network (N), Adjacent (A), Local (L), Physical (P)
- **AC:** Low (L), High (H)
- **PR:** None (N), Low (L), High (H)
- **UI:** None (N), Required (R)
- **S:** Unchanged (U), Changed (C)
- **C:** None (N), Low (L), High (H)
- **I:** None (N), Low (L), High (H)
- **A:** None (N), Low (L), High (H)

Vector format: `CVSS:3.1/AV:<val>/AC:<val>/PR:<val>/UI:<val>/S:<val>/C:<val>/I:<val>/A:<val>`

Score ranges 0.0–10.0. `[VERIFIED: first.org/cvss/v3.1/specification-document]`

### CVSS 4.0 Mention (D-26)

CONTEXT D-26 says CVSS 3.1. CVSS 4.0 is available and has different metrics (more granular, includes Environmental metrics). The roadmap says "CVSS 3.1/4.0" but D-26 locks to 3.1. Recommend: **store CVSS 3.1 vector, but include a note in findings that CVSS 4.0 is available if the user wants a 4.0 score.** Do not compute 4.0 scores in this phase.

## SARIF 2.1.0 Export

**CYBER-12, D-16:** SARIF 2.1.0 required fields for a finding-producing tool.

### SARIF Structure

```json
{
  "version": "2.1.0",
  "$schema": "https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json",
  "runs": [{
    "tool": {
      "driver": {
        "name": "Near AI Cybersecurity",
        "version": "0.4.5",
        "informationUri": "https://github.com/near-ai/near-ai-vscode",
        "rules": [...]
      }
    },
    "results": [
      {
        "ruleId": "WSTG-INJ-01",
        "ruleIndex": 0,
        "level": "error",       // pass/fail/note — CYBER-09: never omit for findings
        "message": { "text": "SQL Injection in /api/users" },
        "locations": [{
          "physicalLocation": {
            "artifactLocation": { "uri": "/workspace/api/users.js" },
            "region": { "startLine": 42, "startColumn": 10 }
          }
        }],
        "fingerprints": { "hash": "sha256:..."},
        "properties": {
          "cvss31": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N",
          "cvss31Score": 9.1,
          "wstg": ["WSTG-INJ-01", "WSTG-INJ-05"],
          "cve": ["CVE-2024-1234"],
          "cwe": "CWE-89",
          "verdict": "verified_access",
          "evidenceHash": "sha256:evidence-blob-hash",
          "reproductionCommand": "nuclei -u http://target -t cves/2024/CVE-2024-1234.yaml",
          "authorization": { /* D-16 disclaimer embedding */ }
        }
      }
    ]
  }]
}
```

### SARIF Required Fields (from schema)

The SARIF schema defines `run` as the top-level container. For `result`:
- **Required on `result`:** `message` (from schema definition — `message` object with `text` property)
- **Required on `run`:** `tool`, `results` (array can be empty)
- **Required on `log`:** `version`, `runs`

**Key insight from schema analysis:** SARIF has no field that is strictly "required" on a `result` except `message`. The `ruleId` and `level` are conventional but not schema-required. However, for meaningful tool output, `ruleId`, `level`, `message`, and `locations` should all be present.

### Result Levels (CYBER-09)

| Cyber Verdict | SARIF Level |
|--------------|-------------|
| `not_vulnerable` | `pass` (or omit from results) |
| `exploit_failed` | `note` |
| `could_not_determine` | `note` |
| `verified_access` | `error` |

## Test Targets for Proof (CYBER-07, CYBER-08/09)

### Seeded Vulnerable Local Service

Create a packaged Docker image for testing:
- **Image name:** `near-ai/test-vulnerable` (public, no network needed beyond Docker Hub)
- **Contents:** A deliberately vulnerable web app (e.g., DVWA-lite or custom Express app with known CVEs)
- **Issues seeded:**
  1. Missing HSTS header
  2. Expired/self-signed TLS certificate
  3. Outdated dependency (e.g., log4j 2.14.1 with CVE-2021-44228)
  4. Committed secret in source code (e.g., `API_KEY=supersecret`)
  5. SQL injection in a login form (for offensive testing)

### Patched Twin

- **Image name:** `near-ai/test-patched`
- Same app, but:
  1. HSTS header present
  2. Valid self-signed cert (for local testing)
  3. Updated dependency
  4. No secrets in source
  5. SQL injection patched (parameterized queries)

### CI Test Strategy

- Run `npm test` — pure domain logic (CVSS, WSTG mapping, ledger hashing)
- Run `npm run test:e2e` — requires xvfb; test panel UI
- Run integration tests against local `test-vulnerable` and `test-patched` images:
  - CYBER-07: `test-patched` scan finds 0 seeded issues
  - CYBER-08: `test-vulnerable` scan finds all seeded issues with evidence

## Runtime State Inventory

> This is a greenfield feature phase, not a rename/refactor. No existing runtime state is affected.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None | — |
| Live service config | None | — |
| OS-registered state | None | — |
| Secrets/env vars | None | — |
| Build artifacts | None | — |

**Nothing found — this phase adds new functionality without modifying existing state.**

## Common Pitfalls

### Pitfall 1: Treating "tool not installed" as "vulnerability not present"
**What goes wrong:** An empty scan result reads as "clean" when it's actually "no tools available"
**Why it happens:** Scanner returns empty findings array without noting tool absence
**How to avoid:** Always append missing-tools notice to findings; never return zero-findings without tool-audit note
**Warning signs:** Finding table shows zero rows and no "missing tools" footnote

### Pitfall 2: Container sandbox leaks state
**What goes wrong:** Offensive payloads create files/credentials that persist after run
**Why it happens:** Cleanup only happens on happy path; error paths skip `docker rm`
**How to avoid:** Use `docker run --rm` (auto-remove); wrap cleanup in `finally` block; record all state changes per step; verify after run
**Warning signs:** `docker ps -a` shows old containers; temp folder grows over multiple runs

### Pitfall 3: Model produces non-JSON output
**What goes wrong:** Raw-completion model outputs markdown or natural language instead of JSON step
**Why it happens:** Weak instruction following; context window pressure; ambiguous prompts
**How to avoid:** Bounded retries (3) with aggressive parse-repair; visible failure in panel after 3 failures; prompt engineering with examples
**Warning signs:** `JSON.parse()` fails on model output more than 3 consecutive times

### Pitfall 4: Scope creep — scanning targets not authorized
**What goes wrong:** CIDR scan reaches hosts outside the engagement's authorized scope
**Why it happens:** Host-count preview is computed but not enforced during scan execution
**How to avoid:** Hard budget check before each probe; abort when budget exceeded; report what was not reached
**Warning signs:** Scan continues past the wall-clock budget or host count exceeds preview

### Pitfall 5: Hash chain broken by non-deterministic output
**What goes wrong:** Ledger entries include timestamps with sub-second precision or random IDs that change between runs
**Why it goes wrong:** Ledger includes mutable fields in hash input, making verification fail on re-read
**How to avoid:** Hash only canonical fields (tool, args, result, modelReasoning, evidenceHash, prevHash); use fixed timestamp format (ISO 8601, no sub-seconds)

### Pitfall 6: SARIF result without locations is incomplete
**What goes wrong:** Exported SARIF has findings but no `locations` array, making IDE integration fail silently
**Why it happens:** Source-code-based findings have locations but network-based findings (e.g., missing HSTS) don't map to file locations
**How to avoid:** For non-file findings, use `uri` in `artifactLocation` with a scheme like `http://` or `sarif://`; always include at least one location per result

### Pitfall 7: False positives on clean targets
**What goes wrong:** CYBER-07 fails — clean target reports seeded issues that don't exist
**Why it happens:** Host tools have high false-positive rates; nuclei templates are aggressive; semgrep fires on patterns, not vulnerabilities
**How to avoid:** Tune tool thresholds; validate findings with critic role (D-22); maintain allowlist of known false positives

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| TLS certificate validation | Custom TLS handshake and cert parsing | `node:tls` + `tls.TLSSocket.getPeerCertificate()` | `[VERIFIED: node.js docs]` Well-tested, handles edge cases |
| DNS resolution | Raw socket DNS queries | `node:dns/promises` | `[VERIFIED: node.js docs]` Handles IPv6, caching, system resolver |
| JSON parse-repair | Custom regex-based JSON repair | Zod + manual JSON.parse with try/catch | Zod handles schema validation; regex-only repair is fragile |
| SHA-256 hashing | Custom hash implementation | `crypto.createHash('sha256')` | `[VERIFIED: node.js docs]` Node built-in, constant-time |
| CIDR range expansion | Custom subnet calculation | `ipaddr.js` or `net` module's `CIDRSubnet` | `[VERIFIED: node.js docs]` Handles IPv4/IPv6 correctly |
| CVSS score computation | Manual CVSS formula implementation | `cvss` npm package or inline formula | `[ASSUMED]` Formula is complex with rounding; verify with `npm view cvss version` |
| SARIF serialization | Manual JSON construction | Build with schema validation | `[VERIFIED: docs.oasis-open.org]` Schema is complex; validation prevents silent errors |
| Container lifecycle management | Manual docker API calls | `docker` CLI via child_process | Simpler to invoke CLI; docker API requires auth, TLS, version negotiation |

**Key insight:** The cybersecurity domain has well-solved infrastructure problems (TLS, DNS, CVSS, SARIF, container lifecycle). Using established approaches prevents edge-case bugs that would undermine pentester-grade trust.

## Code Examples

### Built-in TLS Probe

```typescript
// Source: node.js docs (node:tls)
import { connect } from 'node:tls';

function probeTLS(host: string, port: number): Promise<TLSScanResult> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate(true);
      const info = socket.getCipher();
      socket.destroy();
      resolve({
        tlsVersion: socket.TLS_VERSION,
        cipher: info.name,
        certSubject: cert.subject?.CN,
        certIssuer: cert.issuer?.CN,
        certValidFrom: cert.valid_from,
        certValidTo: cert.valid_to,
        chain: getChainInfo(cert)
      });
    });
    socket.on('error', reject);
    socket.setTimeout(5000);
    socket.on('timeout', () => { socket.destroy(); reject(new Error('TLS probe timeout')); });
  });
}
```

### CVSS 3.1 Vector Construction

```typescript
// Source: FIRST CVSS v3.1 specification
interface CVSS31BaseMetrics {
  av: 'N' | 'A' | 'L' | 'P';     // Attack Vector
  ac: 'L' | 'H';                  // Attack Complexity
  pr: 'N' | 'L' | 'H';            // Privileges Required
  ui: 'N' | 'R';                  // User Interaction
  s: 'U' | 'C';                   // Scope
  c: 'N' | 'L' | 'H';             // Confidentiality
  i: 'N' | 'L' | 'H';             // Integrity
  a: 'N' | 'L' | 'H';             // Availability
}

function buildCVSS31Vector(metrics: CVSS31BaseMetrics): string {
  return `CVSS:3.1/AV:${metrics.av}/AC:${metrics.ac}/PR:${metrics.pr}/UI:${metrics.ui}/S:${metrics.s}/C:${metrics.c}/I:${metrics.i}/A:${metrics.a}`;
}
```

### Hash-Chained Ledger Entry

```typescript
import { createHash } from 'node:crypto';

interface LedgerEntry {
  index: number;
  timestamp: string;
  tool: string;
  arguments: string[];
  result: string;
  modelReasoning: string;
  evidenceHash: string | null;
  prevHash: string;
  hash: string;
}

function createLedgerEntry(fields: Omit<LedgerEntry, 'hash'>): LedgerEntry {
  const canonical = JSON.stringify({
    index: fields.index,
    timestamp: fields.timestamp,
    tool: fields.tool,
    arguments: fields.arguments,
    result: fields.result,
    modelReasoning: fields.modelReasoning,
    evidenceHash: fields.evidenceHash,
    prevHash: fields.prevHash
  });
  return {
    ...fields,
    hash: createHash('sha256').update(canonical).digest('hex')
  };
}

function verifyChain(entries: LedgerEntry[]): boolean {
  const ZERO_HASH = createHash('sha256').update(Buffer.alloc(32)).digest('hex');
  if (entries[0]?.prevHash !== ZERO_HASH) return false;
  for (let i = 0; i < entries.length; i++) {
    const expected = createHash('sha256').update(
      JSON.stringify({
        index: entries[i].index,
        timestamp: entries[i].timestamp,
        tool: entries[i].tool,
        arguments: entries[i].arguments,
        result: entries[i].result,
        modelReasoning: entries[i].modelReasoning,
        evidenceHash: entries[i].evidenceHash,
        prevHash: entries[i].prevHash
      })
    ).digest('hex');
    if (entries[i].hash !== expected) return false;
    if (i > 0 && entries[i].prevHash !== entries[i - 1].hash) return false;
  }
  return true;
}
```

### NDJSON Parser for Nuclei

```typescript
// Source: github.com/projectdiscovery/nuclei (JSONL output format)
function parseNDJSON(input: string): Record<string, unknown>[] {
  return input.split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
}

// Usage: nuclei -u http://target -jsonl | parseNDJSON
```

### Host Tool Detection

```typescript
import { execFileSync } from 'node:child_process';

function detectTool(name: string): { available: boolean; version?: string } {
  try {
    const { stdout } = execFileSync(name, ['--version'], {
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const version = stdout.trim().split('\n')[0];
    return { available: true, version };
  } catch {
    return { available: false };
  }
}
```

## Environment Availability

### Probe Results

```bash
# Check for docker
docker --version 2>/dev/null || echo "docker: not found"

# Check for podman
podman --version 2>/dev/null || echo "podman: not found"

# Check for nmap
nmap --version 2>/dev/null || echo "nmap: not found"

# Check for nuclei
nuclei -version 2>/dev/null || echo "nuclei: not found"

# Check for semgrep
semgrep --version 2>/dev/null || echo "semgrep: not found"

# Check for trivy
trivy --version 2>/dev/null || echo "trivy: not found"

# Check for gitleaks
gitleaks version 2>/dev/null || echo "gitleaks: not found"
```

### Expected Results on Typical Dev Machine

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js (18+) | All probes | ✓ | 18+ | — (extension host requirement) |
| Docker | Sandbox | May vary | 24+ | Temp folder sandbox (D-08) |
| Podman | Sandbox | May vary | 4+ | Same as docker fallback |
| nmap | Recon | May vary | 7+ | Built-in TCP probes (D-12) |
| nuclei | Vuln scanning | May vary | 3+ | semgrep + custom probes |
| semgrep | SAST | May vary | 1+ | grep-based secret scan |
| trivy | Dependency scan | May vary | 0+ | OSV.dev reuse (existing `src/security/osv.ts`) |
| gitleaks | Secret scan | May vary | 8+ | Built-in pattern scan |
| sqlmap | SQLi testing | Rarely | 1.7+ | Model-developed PoC (D-23) |

**Missing dependencies with no fallback:** None — built-in Node probes cover all categories.

**Missing dependencies with fallback:** All host tools have fallbacks: built-in probes for recon/network, semgrep/gitleaks for SAST, OSV.dev for dependency scanning.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `node:test` (Node built-in) |
| Config file | None |
| Quick run command | `node --test dist/test/cyber.test.js` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CYBER-06 | Defensive scan finds seeded issues | unit | `node --test dist/test/cyberDefensive.test.js` | ❌ Wave 0 |
| CYBER-07 | Clean target reports no seeded findings | unit | `node --test dist/test/cyberCleanTarget.test.js` | ❌ Wave 0 |
| CYBER-08 | Offensive scan reaches verified access proof | integration | `node --test dist/test/cyberOffensive.test.js` | ❌ Wave 0 |
| CYBER-09 | Honest reporting of failed exploit | unit | `node --test dist/test/cyberVerdicts.test.js` | ❌ Wave 0 |
| CYBER-10 | Stop control halts run | unit | `node --test dist/test/cyberEmergencyStop.test.js` | ❌ Wave 0 |
| CYBER-11 | Append-only ledger is tamper-evident | unit | `node --test dist/test/cyberLedger.test.js` | ❌ Wave 0 |
| CYBER-12 | SARIF export validates against schema | unit | `node --test dist/test/cyberSarif.test.js` | ❌ Wave 0 |

### Wave 0 Gaps
- [ ] `src/test/cyberDefensive.test.ts` — covers CYBER-06
- [ ] `src/test/cyberCleanTarget.test.ts` — covers CYBER-07
- [ ] `src/test/cyberOffensive.test.ts` — covers CYBER-08, CYBER-09
- [ ] `src/test/cyberLedger.test.ts` — covers CYBER-11, D-28
- [ ] `src/test/cyberSarif.test.ts` — covers CYBER-12
- [ ] `test/fixtures/test-vulnerable/` — seeded vulnerable service
- [ ] `test/fixtures/test-patched/` — patched twin

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | — |
| V3 Session Management | No | — |
| V4 Access Control | No | — |
| V5 Input Validation | Yes | Zod for all inputs; target URL/host validation |
| V6 Cryptography | Yes | Node `crypto` for SHA-256; TLS via `node:tls` |

### Known Threat Patterns for This Phase

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Malicious target banner steering model | Information Disclosure | Mark probe results as untrusted (`src/agent/untrusted.ts`) |
| Sandbox escape via container | Tampering | Read-only volume mount; no outbound network; `--rm` |
| Ledger tampering after report export | Tampering | SHA-256 hash chain; verify before report consumption |
| Credential leakage in transcript | Information Disclosure | Redact secrets via `src/domain/redaction.ts` |
| Privilege escalation via shell tool | Elevation of Privilege | `decidePermission` gate; capability policy |

## Sources

### Primary (HIGH confidence)
- CVSS v3.1 Specification Document — https://www.first.org/cvss/v3.1/specification-document — Base metrics, vector format, scoring equations (sections 2.1-2.3)
- SARIF 2.1.0 Specification — https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0.html — Schema definition, result object structure
- SARIF 2.1.0 JSON Schema — https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json — Required fields, property definitions
- OWASP WSTG v4.2 — https://owasp.org/www-project-web-security-testing-guide/latest/ — Test categories and IDs
- Computer Misuse Act 1990 §1 — https://www.legislation.gov.uk/ukpga/1990/18/section/1 — UK computer misuse offence definition
- Node.js TLS module — https://nodejs.org/api/tls.html — `tls.connect()`, `getPeerCertificate()`
- Node.js DNS module — https://nodejs.org/api/dns.html — `dns/promises` resolution
- Node.js Net module — https://nodejs.org/api/net.html — `net.connect()` TCP probing
- Node.js HTTPS module — https://nodejs.org/api/https.html — HTTP header/response inspection
- Node.js Child Process — https://nodejs.org/api/child_process.html — `execFile()` for tool execution
- Node.js Crypto — https://nodejs.org/api/crypto.html — `createHash('sha256')`

### Secondary (MEDIUM confidence)
- ProjectDiscovery docs — github.com/projectdiscovery — nmap, nuclei, httpx, gitleaks output formats (from GitHub READMEs)
- semgrep docs — semgrep.dev/docs — `--json` output format
- testssl.sh — testssl.sh — `--jsonfile` flag for JSON output
- OWASP WSTG GitHub — github.com/OWASP/wstg — WSTG test ID catalogue (web page structure)

### Tertiary (LOW confidence)
- Nikto documentation — cirt.net — JSON output format (unverified, may only support XML)
- sqlmap JSON mode — sqlmap.org — `--json` flag behavior (unverified, may need `--batch`)
- whatweb JSON — whatweb.net — JSON output support (unverified)
- Australian Cybercrime Act 2001 — legislation.gov.au — Region 5 legal text (unverified, needs owner review)
- Canadian Criminal Code § 342.1 — laws-lois.justice.gc.ca — Region 4 legal text (unverified)
- EU Budapest Convention — coe.int — Region 3 legal text (unverified, implemented via national laws)
- CVSS npm package — npmjs.com/package/cvss — Score computation library (unverified version)

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | nikto supports `-Format json` output | Host Tool Matrix | If only XML is supported, parser needs adjustment |
| A2 | sqlmap `--json` flag exists and works non-interactively | Host Tool Matrix | If sqlmap is purely interactive, it cannot be used in automated scanning |
| A3 | whatweb supports `--json` output | Host Tool Matrix | If no JSON output, need to parse HTML text |
| A4 | semgrep `--json` output is SARIF-compatible | Host Tool Matrix | If semgrep JSON schema differs, adapter needs updating |
| A5 | testssl.sh `--jsonfile` flag writes to file, not stdout | Host Tool Matrix | If it outputs to stdout, piping logic changes |
| A6 | 12 regions cover all user locales with reasonable legal text | Legal Text | If major jurisdiction is missing, users need custom text |
| A7 | Model can reliably follow JSON-in-text protocol with 3 retries | JSON Step Protocol | If models consistently fail, harness cannot drive them |
| A8 | `npm view cvss version` returns a maintained CVSS computation library | Don't Hand-Roll | If package is abandoned, need inline formula or alternative |
| A9 | `@devcontainers/cli` exists and can detect devcontainer configuration | Standard Stack | If not, parse `.devcontainer/devcontainer.json` manually |
| A10 | OSV.dev is already available in the codebase (`src/security/osv.ts`) | Defensive Probe Suite | Already verified — this is confirmed from CONTEXT.md code context |
| A11 | Docker Desktop is accessible from WSL distros via socket mount | Sandbox Architecture | If not, container sandbox is unavailable on WSL |
| A12 | `cvss` npm package correctly implements CVSS 3.1 formula | Code Examples | If wrong, scores will be incorrect; must verify version |

## Open Questions (all RESOLVED)

1. **CVSS score computation library** — **RESOLVED (25-01).**
   - What we know: The formula is specified by FIRST; manual implementation is error-prone
   - What's unclear: Whether `npm view cvss` returns a well-maintained package; no web search available to verify
   - Recommendation: Check `npm view cvss version` and `npm audit cvss` before implementing; if unavailable, inline the formula from specification
   - Resolution: no new dependency. 25-01 reuses the `cvss3Score` implementation already vendored in `src/security/osv.ts` via `cvss31Vector(metrics)`, and its tracer asserts every finding score is computed from the vector rather than hard-coded — preserving the zero-new-dependency constraint (T-25-SC).

2. **Devcontainer detection approach** — **RESOLVED (25-01).**
   - What we know: CONTEXT.md mentions `devcontainers` npm package as a candidate
   - What's unclear: Whether `@devcontainers/cli` exists or if detection should parse JSON manually
   - Recommendation: Try `npx @devcontainers/cli inspect` first; fall back to manual `.devcontainer/devcontainer.json` parsing
   - Resolution: manual JSON parsing only. 25-01's `resolveTarget` treats a `container` target as a name or ID resolved at run time through the sandbox service (25-04), and no devcontainer-specific path ships this phase; no CLI is invoked and no package is added.

3. **Container image for test-vulnerable** — **RESOLVED (25-03).**
   - What we know: Needs to be packaged, no network needed for basic tests
   - What's unclear: Whether to build a custom image or use an existing vulnerable image (e.g., `owasp/zap2docker-stable`)
   - Recommendation: Build a minimal custom image with Express + deliberately vulnerable routes; publish to Docker Hub as `near-ai/test-vulnerable`
   - Resolution: no image, no registry. 25-03 ships two plain-Node fixture servers under `test/fixtures/cyber/{vulnerable,patched}` started on an OS-chosen ephemeral port by `startTarget`, so the seeded-issue tests run on any CI host with no docker/podman and no network pull.

4. **Sandbox network isolation on WSL** — **RESOLVED (25-04).**
   - What we know: WSL can access Docker Desktop; containers may have host network access
   - What's unclear: Whether container networking on WSL can be restricted to host-only
   - Recommendation: Use `docker network create` with `--internal` flag; test on WSL explicitly
   - Resolution: `docker run --rm -d --network none` for the container tier, asserted argv-exactly in 25-04's tests; the temp tier applies a per-run binary allowlist. WSL-specific verification stays in 25-08's hands-on acceptance rather than a separate CI matrix.

5. **How many retries for JSON parse-repair?** — **RESOLVED (25-02).**
   - What we know: D-19 says "bounded retries"; CYBER-04 says "bounded retries"
   - What's unclear: The exact number (2? 3? 5?)
   - Recommendation: Start with 3; make configurable via settings
   - Resolution: `MAX_STEP_REPAIRS = 3`, a module constant in `cyberProtocolDriver.ts`; after three consecutive repair failures for one role the driver returns a typed `incompatible` result that the run records visibly. Not settings-configurable this phase.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — Node built-ins verified via docs; npm packages need `npm view` verification before implementation
- Architecture: HIGH — Existing codebase patterns from ARCHITECTURE.md and CONTEXT.md code context; established singleton webview pattern
- Pitfalls: HIGH — Drawn from penetration testing best practices and the research flags in ROADMAP.md
- Legal text: MEDIUM — UK statute verified via legislation.gov.uk; other jurisdictions need owner review (D-14)
- Model protocol: MEDIUM — Approach is standard for non-tool-calling models but specific numbers (retries, compaction) need validation
- Host tools: MEDIUM — Core tools (nmap, nuclei, semgrep, trivy, gitleaks) verified via GitHub docs; nikto/sqlmap/whatweb are ASSUMED and need live testing

**Research date:** 2026-10-31
**Valid until:** 30 days for stable standards (CVSS, SARIF, PTES); 7 days for fast-moving ecosystem info (npm package versions, tool output formats)


