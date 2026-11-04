---
phase: 25-cybersecurity-harness-with-offensive-and-defensive-scanning
plan: 03
subsystem: security
tags: [cybersecurity, defensive-scanning, fixtures, iac, secrets, osv, host-tools, offline-tests]

requires:
  - phase: 25-01
    provides: "Finding/ResolvedScope/urlInScope, WSTG_MAP, hardeningAdvice, hashBlob, the CyberHttpProbe seam and CyberProbeDeps"
requires-other:
  - "src/security/scan.ts scanProject and src/security/osv.ts (consent-gated OSV path, reused not re-implemented)"
  - "src/agent/securityTool.ts SecurityAccess (the consent register and the not-checked wording)"
  - "src/agent/tools.ts AgentTool, ToolError, SKIP_DIRS conventions; src/agent/untrusted.ts fenceUntrusted; src/domain/redaction.ts redactSecrets"

provides:
  - "Offline seeded proof targets: test/fixtures/cyber/{vulnerable,patched} running on plain node, ephemeral loopback ports, no container"
  - "startTarget(kind) helper (src/test/cyberStartTarget.ts) that spawns a fixture, returns httpUrl/tlsUrl/fixtureDir/pid/close, and kills the process group"
  - "Seven further built-in probes: CyberTlsProbe, CyberDnsProbe, CyberTcpProbe, CyberRobotsProbe, CyberSecretsProbe, CyberIacProbe, CyberDependencyProbe — all capability 'read', untrusted, scope-validated"
  - "makeFinding/summarise/shellQuote helpers so every finding carries evidence hash, WSTG ids, CWE ids, and a reproduction command"
  - "CyberIacProbe: zero-dependency line-and-shape scanner for Terraform, CloudFormation, Kubernetes, Dockerfiles and CI workflows, with CWE per check"
  - "CyberSecretsProbe: pattern scanner whose finding text truncates every matched value to four characters"
  - "src/services/cyberTools.ts: TOOL_CATALOGUE (10 tools), detectTool/detectTools with an injectable runner, missingToolsNote, installOffer, jsonFlagIsAssumed"
  - "WSTG_MAP rows and hardening advice for every new check id"

affects: [25-04, 25-05, 25-06, 25-07]

actuals:
  tokens: 41200
  tasks: 3
  commits: 4

tech-stack:
  added: []
  patterns:
    - "Fixtures are plain .js started as a child process with READY <httpPort> <tlsPort> on stdout; certs are checked-in artifacts under test/fixtures/cyber/certs"
    - "Probes inject their I/O (fetchCapture, dns, tlsPeer, scan, now) so tests can run offline and assert a call was made"
    - "Absence is reported: the IaC probe always lists the IaC kinds it looked for, so 'checked and clean' never reads as 'nothing was checked'"
    - "A self-signed leaf is a finding; a private CA that merely fails system trust is not (false-positive control for CYBER-07)"
    - "Host tools are detected with one fixed execFile version command and never installed"
---

# Plan 25-03 — seeded targets and the defensive suite

## What landed

Three commits of work plus one cleanup, all on `gsd/phase-25-cybersecurity-harness`:

| Commit | Content |
|---|---|
| `e61372b` | fixture pair (servers, IaC, lockfiles, certificates), `startTarget`, `cyberFixtures.test.ts` |
| `a7b589a` | removed two stray compiled files (`probe.js`, `probe.js.map`) that a prior session had left in the fixture tree |
| `b82ce77` | seven new probes, `src/agent/cyberFiles.ts` walker, WSTG/hardening rows, `cyberDefensive.test.ts` |
| `7ab3d5d` | `src/services/cyberTools.ts` host-tool registry, `cyberCleanTarget.test.ts` |

## Requirements

- **CYBER-06** — every seeded weakness on the vulnerable fixture is a finding with evidence, a reproduction command, a WSTG id, and (where the check class has one) a CWE id. The IaC clause is delivered by a built-in probe with no new dependency, covering all five file kinds the plan named.
- **CYBER-07** — the patched twin scanned by the whole built-in set produces zero seeded-issue findings, proven by a control run that finds them on the vulnerable twin first.
- **CYBER-12** (partial, its missing-tools clause) — `missingToolsNote` names every catalogued tool that is absent, and `cyberCleanTarget.test.ts` asserts a zero-finding summary still carries it.

## Seeded issues and the check that finds each

| Seeded weakness | Check id | Where |
|---|---|---|
| no HSTS / nosniff / frame-options, versioned Server header | `missing-hsts`, `missing-*`, `server-version-disclosure` | headers of the fixture app |
| expired self-signed leaf | `tls-certificate-expired`, `tls-untrusted-chain` | `certs/vulnerable/server.pem` |
| `Disallow: /backup/`, `/admin` | `robots-disallowed-path` | fixture `/robots.txt` |
| `API_KEY=…`, `ENV API_KEY=…`, workflow `API_TOKEN:` | `committed-secret`, `iac-hardcoded-secret` | `config.env`, `Dockerfile`, `ci.yml` |
| ingress `0.0.0.0/0`, `public-read` ACL, unencrypted bucket | `iac-public-ingress`, `iac-unencrypted-storage` | `main.tf` |
| `USER root`, `FROM node:latest` | `iac-container-root`, `iac-unpinned-image` | `Dockerfile` |
| `uses: …@v4` x2 | `iac-unpinned-action` | `ci.yml` |
| `express 4.17.2` | `vulnerable-dependency` | `package-lock.json`, through the injected OSV scan |

## Deviations from the plan

**1. [Rule 3 — blocking] The helper lives at `src/test/cyberStartTarget.ts`, not `test/fixtures/cyber/startTarget.ts`.**
`tsconfig.json` has `rootDir: src`, so a `.ts` file under `test/` is never compiled and could not be imported by a compiled test. The helper resolves the fixture directory as `path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'cyber', kind)` from `dist/test/`, which reaches the same fixtures the plan named. The fixture tree itself is exactly `test/fixtures/cyber/` as planned.

**2. [Rule 3 — blocking] Certificates live at `test/fixtures/cyber/certs/{vulnerable,patched}/`, not inside each fixture directory.**
The workspace, secrets, and IaC probes scan `fixtureDir`. A self-signed `server.key` sitting inside the patched twin would have been found by the secrets probe as a committed private key, making the clean twin dirty for a reason the plan did not seed. Moving certs to a sibling directory keeps the twin clean while the fixtures still load them by relative path. The patched leaf is signed by a fixture CA (`ca.pem` committed, `ca.key` destroyed) so `issuer != subject`, which is what distinguishes it from the self-signed vulnerable leaf.

**3. [Rule 1 — bug] `tls-untrusted-chain` fires only on a self-signed leaf, not on "fails system trust".**
The first implementation reported every `!authorised` handshake. That made the patched twin dirty, because a private CA is never in the system store. `cyberCleanTarget.test.ts` caught it. A private-CA deployment is normal, so the check now requires `issuer === subject`.

**4. [Rule 1 — bug] The vulnerable Dockerfile's base image is `node:latest`, not `node:18`.**
`node:18` is a pinned tag, so `iac-unpinned-image` had nothing to find and the "five seeded IaC misconfigurations" must_have was one short. `node:latest` is the canonical unpinned form and is what the check reports.

**5. [Rule 1 — bug] The DNS probe only reports SPF/DMARC for a domain that publishes MX.**
Reporting a bare host for "no SPF" is a false positive (a host with no mail role needs no mail policy), which would have contradicted the CYBER-07 must_have. SPF/DMARC are checked only when the domain has at least one MX record, and the test covers both a mail domain and a bare host.

**6. [Rule 2 — missing critical functionality] `CyberHttpProbe` now calls `deps.onFindings`.**
25-01 created the probe without the findings callback, so its findings reached the text summary but never the ledger or the report. Every other probe in this plan routes through `onFindings`; the HTTP probe had to as well or the header findings would be the one class missing from 25-05's report.

**7. [Rule 2 — missing critical functionality] Added `src/agent/cyberFiles.ts`.**
The secrets, IaC, and robots probes all need a bounded workspace walk with the same skip list as `Glob`. Exporting `walk()` from `tools.ts` was not an option (it is module-private and shaped for `ToolContext`), so the shared walk, the scannable-read guard, and `lineAt` live in one small module the probes import.

## Verification

| Gate | Command | Result |
|---|---|---|
| Typecheck / lint | `npm run lint` | exit 0 |
| Plan tests | `node --test dist/test/cyberFixtures.test.js dist/test/cyberDefensive.test.js dist/test/cyberCleanTarget.test.js` | 17 pass, 0 fail |
| Full suite | `npm run compile && node --test dist/test/*.test.js` | 659 tests, 651 pass, 0 fail, 8 skipped |
| 25-01/25-02 regression | `node --test dist/test/cyberTracer.test.js dist/test/cyberEngagement.test.js dist/test/cyberProtocol.test.js` | 16 pass, 0 fail |

Acceptance greps, all run verbatim from the plan:

| Criterion | Required | Actual |
|---|---|---|
| `untrusted: true` in `cyberProbes.ts` | ≥ 8 | 8 |
| `getPeerCertificate\|resolve4\|net.connect` | ≥ 2 | 5 |
| `scanProject\|SecurityAccess` | ≥ 1 | 5 |
| `CyberIacProbe` | ≥ 1 | 1 |
| `CWE-` in `cyberProbes.ts` | ≥ 5 | 23 |
| `Dockerfile\|\.tf\|workflows` | ≥ 3 | 8 |
| `from 'vscode'` in the probe/registry | none | none |
| `nuclei\|nmap\|semgrep` in `cyberTools.ts` | ≥ 3 | 3 |
| `execFile` in `cyberTools.ts` | ≥ 1 | 3 |
| `missingToolsNote` in `cyberCleanTarget.test.ts` | ≥ 1 | 3 |
| `^test/\*\*$` in `.vscodeignore` | 1 | 1 |
| `READY` in both fixture servers | ≥ 1 each | 2 / 1 |
| fixture `require('express')` | 0 | 0 |
| `listen(0` in the vulnerable server | ≥ 1 | 2 |

## Issues encountered

- `npm run compile` (not bare `tsc`) is required before the full suite: `scripts/vendor-libs.mjs` populates `vendor/pdfjs`, and eight document/graphics tests fail without it. Worth knowing for 25-08's release run.
- A stale `dist/test/probe.test.js` (compiled from the stray fixture this plan deleted) fails the suite by importing a fixture that no longer exists. `dist/` is gitignored, so it only affects a worktree that predates the cleanup; `rm -rf dist && npm run compile` clears it.

## Next phase readiness

- **For 25-05 (run loop):** `cyberProbes(deps)` now returns eight tools; pass `onFindings` to collect structured findings for the ledger and report, and `security` (a `SecurityAccess`) to enable the OSV-backed dependency probe. Without `security`, a `scan` injection, or an explicit `deps.scan`, the dependency probe scans the folder live through `scanProject` — offline tests must inject one.
- **For 25-07 (panel):** `TOOL_CATALOGUE`, `installOffer(name)` and `jsonFlagIsAssumed(name)` are the panel's install-offer surface. `installOffer` only returns a string; no install is ever executed here. The three assumed JSON flags (nikto, sqlmap, whatweb) are flagged so the panel can say "verify the flag" rather than promise JSON.
- **For 25-06 (offensive):** the fixtures already carry the SQLi-shaped login route. `startTarget('vulnerable')` returns `httpUrl`; POST `/login` with `username="' OR '1'='1"` returns 200 and the patched twin returns 401.
- **`CyberTcpProbe`'s scope bound:** a scope that names ports caps the sweep per call; a `cidr` or `container` scope currently has `ports: []`, so the 32-port cap is the only bound. 25-04's budget should pass a port list into the scope.

## Self-check: PASSED

`npx tsc -p tsconfig.json` exits 0, all 17 plan tests pass, `npm run lint` exits 0, the full suite is 651/651 with 0 failures, and all 14 acceptance greps return the required values. No new npm dependency was added (`package.json` and `package-lock.json` are untouched by this plan), and neither `src/agent/cyberProbes.ts` nor `src/services/cyberTools.ts` imports `vscode`.
