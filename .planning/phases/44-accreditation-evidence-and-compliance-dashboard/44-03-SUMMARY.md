---
phase: 44-accreditation-evidence-and-compliance-dashboard
plan: 03
subsystem: security-docs
status: complete
tags: [security, incident-response, threat-model, crypto-inventory, cgp, itar, poam, docs-site]
requires: []
provides:
  - docs/security/ documents with "Last reviewed:" lines (read by the documents collector, 44-07)
  - crypto inventory table (read by the crypto collector, 44-07)
  - compliance/gaps.json and compliance/poam/*.json (read by gaps.ts, 44-04, and the dashboard, 44-14)
  - docs site rule docs/security/<name>.md -> security/documents/<name>
affects: [44-04, 44-07, 44-14, 44-18]
tech-stack:
  added: []
  patterns:
    - "docs/security/*.md render under Security, Security documents, through one targetFor rule"
    - "gap register and POA&M files: sorted keys, two-space indent, no status/state/met key"
key-files:
  created:
    - docs/security/incident-response.md
    - docs/security/threat-model.md
    - docs/security/data-flow.md
    - docs/security/crypto-inventory.md
    - docs/security/controlled-goods-and-itar.md
    - compliance/gaps.json
    - compliance/poam/g02.json
    - compliance/poam/g03.json
    - compliance/poam/g08.json
    - compliance/poam/g10.json
    - compliance/poam/g11.json
    - compliance/poam/g12.json
    - compliance/poam/g13.json
    - compliance/poam/x01.json
    - compliance/poam/x02.json
    - compliance/poam/x03.json
    - compliance/poam/x04.json
    - compliance/poam/x05.json
    - compliance/poam/x06.json
    - compliance/poam/x07.json
    - compliance/poam/x08.json
    - compliance/poam/x09.json
    - compliance/poam/x10.json
  modified:
    - SECURITY.md
    - docs-site/scripts/sync-docs.mjs
    - docs-site/sidebars.js
    - docs-site/.gitignore
decisions:
  - "Supported versions: the latest 0.4.x release only; a report is acknowledged within 7 days; a high or critical issue gets a fix or a published mitigation within 30 days (owner default 1, reversible)"
  - "POA&M milestones with no phase use the target date 2027-05-31 (owner default 2)"
  - "The five documents render under Security, Security documents (route /security/documents/<name>), not under Using NEAR AI, Reference (owner default 3)"
  - "X10's data platform milestone cites Phase 88 (governed store, reader-relative access from the first screen), the first phase the ROADMAP maps the former 'compartments, roles, access' core to"
  - "SECURITY.md links the incident response plan by its absolute GitHub URL, as every other repository link in SECURITY.md does, because SECURITY.md ships in the VSIX and docs/security/ does not"
metrics:
  duration: "about 12 minutes"
  completed: 2026-11-21
actuals:
  tokens: 15392
  tasks: 4
  commits: 4
plan_head_before: 932f73c9db34fc18b44f45e812a35cd68d249ce3
plan_head_after: 5ac6c2f9fba35720d35103c6b25e475b9f3ea56d
---

# Phase 44 Plan 03: Security documents and the gap register Summary

Five reviewed security documents (incident response, threat model, per-component data flows, a
cryptography inventory against ITSP.40.111 version 5, and the Controlled goods and ITAR guidance
page with interim settings) published under Security on the docs site, a supported-versions table
in SECURITY.md, and a 25-gap register with 17 POA&M items, every milestone carrying a phase or a
date.

## What was built

| Task | Commit | Result |
| --- | --- | --- |
| 1 (tracer) Incident response plan, supported versions, docs-site wiring | 956bc284 | `docs/security/incident-response.md` (six sections, response times); `## Supported versions` in SECURITY.md before "Reporting a vulnerability"; `targetFor` rule, five labels, sidebar `folder('Security documents', 'security/documents')`, `/content/security/documents/` ignored |
| 2 Threat model and data flows | c98d547f | `threat-model.md` (assets, boundaries per component, 20-row STRIDE table linking SECURITY.md sections, what the product cannot stop); `data-flow.md` (five plain Mermaid flowcharts) |
| 3 Crypto inventory and CGP/ITAR page | 35b4377f | `crypto-inventory.md` (12 algorithm rows, Basis section, no FIPS claim); `controlled-goods-and-itar.md` (CGP-ITAR 10.2 opening with both regimes, What the product does, What it does not do, Interim settings, the not-legal-advice line) |
| 4 Gap register and POA&M items | 5ac6c2f9 | `compliance/gaps.json` (G1 to G13, X1 to X12) and 17 files in `compliance/poam/` |

Docs-site route: the sync names the slug `/security/documents/<name>`; the build writes
`docs-site/build/security/documents/<name>.html` (for example `incident-response.html`), not
`.../incident-response.synced/index.html`.

## Owner defaults recorded (change any by editing the file)

1. **Supported versions and response times:** the latest 0.4.x release receives fixes, earlier
   releases do not; acknowledge within 7 days; a high or critical issue gets a fix or a published
   mitigation within 30 days. Stated as the maintainers' published commitment, not a contract.
   Files: `SECURITY.md`, `docs/security/incident-response.md`.
2. **Undated POA&M milestones:** target date 2027-05-31 (G2 export, G10, G11 extension guidance,
   G12, G13, X8).
3. **Where the documents render:** Security, "Security documents", through the `docs/security/`
   rule placed before the general `docs/` rule in `sync-docs.mjs`.

## Algorithms found (crypto inventory)

Found by grepping `src/`, `relay/src/`, `hub/src/` and `scripts/` (read only), tests excluded:

| Algorithm | ITSP.40.111 v5 column |
| --- | --- |
| AES-256-GCM | listed |
| HKDF-SHA256 | listed |
| scrypt (recovery code; also the issuer key file passphrase in `scripts/org-issuer.mjs`) | not listed |
| Ed25519 | listed with conditions |
| X25519 | not listed |
| SHA-256 | listed |
| HMAC-SHA256 (join proofs, hub enrolment, relay phone pseudonyms) | listed |
| ECDSA P-256 with SHA-256 (verifying Intel TDX quotes only) | listed |
| ECDSA secp256k1 with Keccak-256 (verifying NEAR AI Cloud answer signatures only, EIP-191) | not listed |
| Random numbers from `randomBytes` | listed |
| TLS through Node's defaults (TLS 1.3 only for the hub) | not listed (a protocol; ITSP.40.062 named) |
| MD5 (PDF `/ID` field only, no security role) | not listed |

SHA-1 and SHA-512 appear only in tests. The Basis section records that VS Code desktop runs the
extension in Electron's Node (BoringSSL), while code-server, the relay, the hub and the issuer tool
use Node's bundled OpenSSL; neither is run as a FIPS 140 validated module.

## Gap register

- Close in Phase 44 (`closesInPhase: "44"`, 8): G1, G4 (release-owner), G5, G6, G7 (owner), G9,
  X11, X12 (overlay both).
- POA&M (17): g02 (32.1, then 2027-05-31), g03 (75), g08 (84), g10 (2027-05-31), g11 (shared: 84,
  then 2027-05-31), g12 (owner, 2027-05-31), g13 (2027-05-31), x01 (45), x02 (45, 71), x03 (45),
  x04 (45, 72), x05 (32.1, 45), x06 (45), x07 (45), x08 (2027-05-31, evaluate a FIPS 140-3
  validated provider for the hub and the appliance), x09 (32.1, 45), x10 (35, 75, 88).
- **Data platform phase cited for X10: Phase 88** ("Ingestion core, governed store and the data
  map"), where the ROADMAP says everything shown is filtered by the viewer's clearance from the
  first screen and every view is reader-relative from Phase 88 on.
- Ids: gaps `G1`..`X12` (`^[GX][0-9]{1,2}$`), POA&M `g02`..`x10` (`^[gx][0-9]{2}$`), matching the
  schema patterns 44-04 will write. Control ids are lowercase ITSP.10.033 form (`ir-01`,
  `sa-11.01`) plus overlay ids from the 44-13 lists (`cgp-37-2`, `cgp-10-a`, `cgp-10-e`,
  `cgp-10-h`, `cgp-13`, `itar-120.54-a5`, `itar-120.56-a`, `itar-122.5`, `itar-126.5`,
  `itar-127.12`).

## Verification

- Task 1: sync plus `npm run docs:build` under the heavy lock (MemoryMax=4G): exit 0, "[SUCCESS]
  Generated static files", no broken links or anchors (`onBrokenAnchors: 'throw'`).
- Task 2: sync, both synced pages present, 5 Mermaid blocks; 4 and 5 `##` sections; one "Last
  reviewed" line each; 0 em-dashes. All five diagrams also parse with the site's own mermaid
  package (a scratch check script with a DOMPurify stub; not committed).
- Task 3: sync, both pages present, 13 table lines; header line exact; "FIPS 140 validated
  module" present; `## Interim settings` once; "is your organization's obligation" present; 0
  hits for compliant, accredited or certified in both files.
- Task 4: the plan's node check prints `gaps ok 25`; 17 POA&M files; 8 `closesInPhase` lines; an
  extra cross-check (each POA&M file named by its gap, `gap` points back, owner roles from the five,
  id patterns) passed. No `status`, `state` or `met` key; no em-dash.
- A second full docs build after Task 3 passed with all five pages
  (`docs-site/build/security/documents/*.html`).
- Not run here (the plan schedules them after the wave merge): 44-01's `noStatus.test.ts`, which
  does not exist on this branch yet, and `npm run verify:release`.

## Deviations from Plan

### Auto-fixed and adjusted

**1. [Rule 3 - Blocking] Ran `npm --prefix docs-site ci --ignore-scripts` to meet Task 1's precondition**
- The worktree had no `docs-site/node_modules`. The executor brief authorizes this exact command
  inside the worktree, capped; it installs the existing lockfile only, no new package.

**2. [Rule 1 - Accuracy] Interim setting 2 names the list of places (`endpoints`), not `routing.localHosts`**
- CGP-ITAR section 11 names `routing.localHosts`; on `main` policy v2 replaced it with the list of
  places where AI may run (SECURITY.md "Where AI may run", `src/domain/gate/endpoints.ts`). The page
  states what is true on `main`.

**3. [Rule 2 - Completeness] Crypto inventory covers more than the six named algorithms**
- Added HMAC-SHA256, ECDSA P-256 (verification), ECDSA secp256k1 with Keccak-256 (verification),
  random numbers, MD5 (PDF identifier) and the issuer tool's scrypt and Ed25519 use, all found by
  the grep the plan asks for.

**4. [Rule 2 - Correctness] Interim setting 4 adds multi-user staff projects**
- "Do not share through Team Mode or the relay" now also names a multi-user staff project, the
  other sharing path on `main`.

**5. Branch name outside the agent-* namespace**
- The executor's worktree allow-list expects `agent-*` branches; the orchestrator assigned
  `feat/phase-44-03-security-docs` (D-39 pattern). Commits were made there as instructed; the
  branch is not a protected or default branch.

## Notes for later plans

- **44-01 / verification after the wave merge:** `.vscodeignore` on this branch does not exclude
  `docs/security/` or `compliance/`; D-48 (owned by 44-01) adds both. Run `npm run verify:release`
  after the merge to prove neither is in the VSIX.
- **44-04:** the gap and POA&M files follow the artifact field lists exactly; `closesInPhase` is the
  string `"44"`; milestone `phase` values are strings (`"32.1"`, `"45"`); `overlay` is `"both"` on
  all twelve X gaps.
- **44-07:** every document carries `Last reviewed: 2026-11-21` at the start of a line; the crypto
  table's third column holds only `listed`, `listed with conditions` or `not listed`.
- **44-13 / 44-18:** control ids in the register were not checked against imported catalogues
  (they do not exist on this branch); a later check should confirm each id exists.
- **Phase 33 parallel edit of SECURITY.md:** this plan's SECURITY.md change is one compact block,
  the new `## Supported versions` section (10 lines) immediately before `## Reporting a
  vulnerability`, and nothing else.

## Threat model mitigations

- T-44-09: the threat model and data flows link to SECURITY.md sections and say they add no
  limitation the Known limitations table does not already name.
- T-44-10: none of the five documents uses compliant, accredited or certified; the CGP/ITAR page
  says it is not legal advice, that officials decide, and names the unsettled questions.
- T-44-SC: no package was added; only the existing docs-site lockfile was installed.

## Known Stubs

None.

## Owner actions

- None required for this plan. The three defaults above stand unless the owner edits them.

## Self-Check: PASSED

- All 23 created files and 4 modified files exist on the branch.
- Commits 956bc284, c98d547f, 35b4377f and 5ac6c2f9 are ancestors of HEAD.
