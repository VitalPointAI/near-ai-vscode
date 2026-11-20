# Security accreditation: evidence, gaps and a compliance dashboard

**Status:** design, for the owner's OK. Docs only: nothing here is built yet.
**Written:** 2026-11-20, against `origin/main` after the local documentation site merged (PR #141).
**Owner request (2026-11-20):** "We will need to obtain security accreditation (ITSG-33 controls and those from its successor from the Canadian Centre for Cyber Security). Perhaps as part of the docs site or in another area, we must provide a dashboard that reports compliance in real-time and provides the exact security control documentation required for each level of accreditation, and clearly showing where we are deficient at each level (and what needs to be done to reach compliance)."
**Agreed shape:** the orchestrator's proposal (section 2), refined here by research.
**Fits into:** the docs site (`docs-site/`, PR #141), CI (`.github/workflows/ci.yml`) and the release workflow (`.github/workflows/release.yml`), the guided setup's labels and its "never overclaim" rule (`.planning/research/guided-onboarding/DESIGN.md`, sections 4 and 14), the coherence glossary (`.planning/research/coherence/GLOSSARY.md`), the organization policy's `authorizations[]` records (Phase 41) and the Phase 25 cybersecurity harness (a later evidence source).
**Extended by:** `CGP-ITAR.md` in this folder (2026-11-20): Canada's Controlled Goods Program and the US ITAR as two overlays beside the level pages, plus the markings, person and endpoint decisions, records and incidents they need.
**Proposed phase:** Phase 44, in the 0.4.x line. It changes no part of the extension's user interface, so it can run beside Phases 30 to 43 (section 18).

## 1. Key points first

1. **The successor to ITSG-33 exists and is now in force.** The Canadian Centre for Cyber Security (the Cyber Centre) replaced ITSG-33 in 2026 with the series "Cyber security and privacy risk management: A lifecycle approach". The control catalogue is **ITSP.10.033** (in effect 2026-03-31, replaces ITSG-33 Annex 3A, aligned with NIST SP 800-53 Rev. 5, adds privacy controls and Canada-only items numbered from 400). The medium baseline is **ITSP.10.033-01** (in effect 2026-04-02, replaces Annex 4A Profile 1, "Protected B / Medium integrity / Medium availability"). The overview **ITSP.10.035** (in effect 2026-10-29) replaces the ITSG-33 overview. ITSP.10.036, ITSP.10.037 and ITSP.10.033-02 replace Annexes 1 and 2 and add assessment guidance. Section 3 has the full list and what is still unreplaced.
2. **We cannot be accredited; a deployed system can.** Security assessment and authorization is the decision of the organization that runs the system (the extension plus, where it uses them, its sync hub, relay, appliance and model endpoints). What we can do is hand that organization, and its assessor, everything that is ours to supply: the exact control text per level, our implementation statement for each control, who is responsible for what (product, your organization, or shared), evidence collected automatically, and an honest gap list with the work to close each gap.
3. **The control text may live in our public repository, with attribution.** The Government of Canada open data catalogue lists ITSP.10.033, ITSP.10.033-01, ITSP.10.171, ITSP.10.171-01, ITSG-33 and ITSP.50.103 under the **Open Government Licence - Canada**, which allows copying, adapting and redistributing, commercially too, with the attribution statement. We keep the text in its own folder with that attribution, a note that it is an unofficial representation, and the source address and hash it was taken from. Profiles the Cyber Centre only sends by email (its control spreadsheets and the cloud profiles it hands to providers) are never committed.
4. **One machine-readable source: NIST OSCAL.** ITSP.10.033 follows NIST SP 800-53, and OSCAL is NIST's format for catalogues, profiles, component definitions, system security plans, assessment plans and results, and plans of action. The dashboard pages, the documentation package and the files an assessor imports into their own tool are all generated from one `compliance/` folder in OSCAL JSON. No official OSCAL edition of ITSP.10.033 exists yet; we build ours from the official pages and cross-check it against two unofficial conversions (an AWS sample repository and the CISO Assistant library).
5. **Our own small TypeScript tooling, standard tools for checking.** A dependency-light generator in this repository writes the OSCAL files and the dashboard data; NIST's `oscal-cli` (public domain) validates and resolves profiles in CI; IBM's Compliance Trestle (Apache 2.0) is the recommended hand-off tool for organizations and assessors, not a build dependency. Lula, CISO Assistant, GovReady-Q and OpenSCAP were compared (section 5.3).
6. **"Real time" means every CI run.** Every pull request shows how it changes control status; every merge to `main` produces a fresh evidence bundle; every release attaches a snapshot of it with checksums. The local dashboard refreshes from the latest `main` bundle. Evidence older than its freshness window turns the control to **Stale**, which counts as not met.
7. **Status comes from evidence, never from prose.** A control is shown as **Met** only when it has an implementation statement, at least one passing piece of evidence from a test, scan or check (or, for controls no machine can check, a signed statement by a named person with an expiry date), and all of that evidence is fresh. Nobody types a status. Words like "compliant", "accredited" or "certified" never appear about the product.
8. **One page per level.** Unclassified, Protected A, Protected B, and later Classified (on the appliance only). Each page lists every control in that level's profile with one of six states (Met, Partly met, Not met, Stale, Not applicable with a reason, Your organization's responsibility), and every gap carries the concrete remediation, an owner and, where one exists, the phase that closes it.
9. **The biggest gaps today** (section 14): no incident response plan and no supported-versions table; the gate's decision records are not tamper-evident and cannot be exported; no provenance attestation for the VSIX or the relay image, no publisher signature of our own; no CVE scan or SBOM for the relay container; no static analysis; no CODEOWNERS; no inbound authentication on the relay yet; no backup and recovery guidance; no standalone threat model or data-flow diagram; and the docs build is not yet a required check.
10. **Phase 44** builds it: the `compliance/` source, the importer, the collectors, the status engine, the dashboard pages and the release package. It touches `compliance/` (new), `docs-site/`, `scripts/` and the two workflows, never `src/` or `media/`. An in-extension organization view is a later phase after Phase 41.

## 2. The request and the agreed shape

| # | Agreed point | Where in this design |
|---|---|---|
| 1 | Accreditation is the deploying organization's decision for its deployed system; the product supplies control text, implementation statements, a responsibility matrix, automatic evidence and a per-level gap report | Sections 4, 7, 10 |
| 2 | Machine-readable first: evaluate OSCAL (catalogue, profile, component definition, SSP, assessment plan and results, POA&M); dashboard, package and assessor hand-off from one source | Section 5 |
| 3 | "Real time" = every CI run and merge updates evidence and status; releases snapshot it; stale evidence flagged | Sections 8, 12 |
| 4 | Lives in the docs site, a page per level, plus a CI job; levels follow the guided setup and the glossary | Sections 6, 10, 12 |
| 5 | Research first, cite everything, treat downloaded code and data as untrusted | Sections 3, 5 and 19; nothing downloaded was run |

## 3. What the Cyber Centre and the Government of Canada publish today

All dates were checked on the official pages on 2026-11-20 (sources in section 19).

### 3.1 The successor series to ITSG-33

| Publication | What it is | In effect | Replaces |
|---|---|---|---|
| ITSP.10.035 | Overview, Cyber security and privacy risk management: A lifecycle approach | 2026-10-29 | ITSG-33 Overview |
| ITSP.10.036 | Organizational cyber security and privacy risk management activities | (series) | ITSG-33 Annex 1 |
| ITSP.10.037 | System lifecycle cyber security and privacy risk management activities | (series) | ITSG-33 Annex 2 |
| ITSP.10.033 | Security and privacy controls and assurance activities catalogue | 2026-03-31 | ITSG-33 Annex 3A |
| ITSP.10.033-01 | Suggested organizational security and privacy control and activity profile, Medium impact | 2026-04-02 | ITSG-33 Annex 4A, Profile 1 (Protected B / Medium / Medium) |
| ITSP.10.033-02 | Assessment of security and privacy controls and assurance activities | (series) | new; the CPCSC derives its assessment procedures from it |
| ITSP.10.032 | Calculating robustness for boundary controls | (series) | new |

What changed that matters to us:

- ITSP.10.033 is aligned with NIST SP 800-53 Rev. 5 (ITSG-33 Annex 3A was based on older NIST revisions), adds privacy controls and the PM (program management), PT (personal information and transparency) and SR (supply chain risk management) families, and numbers Canada-only controls and activities from 400 (for example SA-400, IA-04(400)).
- Assurance-related items are called **activities**, not controls. They are mostly engineering, documentation and assessment tasks, which is where most of a software product's evidence lands.
- ITSP.10.033-01 is a baseline to tailor, not a checklist: it suggests security assurance level SAL2 for most items and SAL3 for critical ones, a maximum robustness level RL3, and has "suggested placeholder values" and "profile-specific notes" columns. Its page says the Cyber Centre's control spreadsheet is available on request from contact@cyber.gc.ca.
- Allocation is common, hybrid or system-specific (ITSP.10.035), which maps directly onto the responsibility matrix in section 7.

### 3.2 What has no successor yet

- **Annex 4A Profile 3 (Secret / Medium / Medium)** is still published on the ITSG-33 page and has no ITSP.10.033 counterpart that we found. It remains the only published suggested baseline for a Secret system.
- **No Low or High profile** in the new series. Protected A work is tailored down from ITSP.10.033-01 (or uses ITSP.10.171 for contractors, see 3.4). Protected C has no published baseline.
- The **ITSG-33 page itself** still says "The information remains valid" (unchanged since 2012), while ITSP.10.035 says it supersedes it. We treat ITSP.10.035 as authoritative and keep ITSG-33 identifiers only as a cross-reference for assessors who still use them.
- **Harmonized TRA (TRA-1)**, the joint CSE and RCMP threat and risk assessment method, is still the 2007 edition and is still cited by ITSP.10.033. No successor found.

### 3.3 Cloud services (our model endpoints and any hosted hub)

- The Cyber Centre's **Cloud Security Assessment Program** (page updated 2026-06-19) assesses commercial cloud services up to Protected B against **Cloud Low, Cloud Medium and Cloud High** baselines "developed based on the GC's security control catalogue", following **ITSM.50.100** (Cloud service provider IT security assessment process, 2018, still listed). It uses third-party assessors (currently FedRAMP-accredited firms; a Canadian accreditation with the Standards Council of Canada is in progress) and is not for classified systems. Its profiles and reports are obtained from contact@cyber.gc.ca.
- **ITSP.50.103** (Guidance on the security categorization of cloud-based services) carries the low and medium cloud profiles in its annexes; the Medium one replaced the 2016 "PBMM" cloud profile (the name still used informally). ITSP.50.105 covers cloud security assessment and authorization.
- For us: a cloud model endpoint used for Protected B is the provider's assessment (inherited controls) plus your organization's own authorization. That is exactly what the guided setup already says (guided-onboarding design, section 4.5), and it is recorded as an `authorizations[kind=protected-b]` record in your organization's policy (Phase 41).

### 3.4 Treasury Board policy and contractors

- **Directive on Security Management**: Appendix B (Mandatory procedures for information technology security control) is where Government of Canada departments' duty to manage IT security and authorize systems sits; Appendix J is the **Standard on Security Categorization** (what Protected A, B and C and the classified levels mean). The Treasury Board site refused automated retrieval on 2026-11-20, so the exact Appendix B clauses are an open item for the phase researcher (they change none of the design).
- **Contract Security Program** (PSPC): the Contract Security Manual, chapter 7, says a contractor must not store, process or create protected or classified information on its own IT systems until the Program issues a written IT approval letter, after an IT security inspection (Annex D). Our package is meant to make that inspection faster, not to replace it.
- **Canadian Program for Cyber Security Certification (CPCSC)** for defence suppliers: Level 1 (annual self-assessment, 13 controls) launched April 2026; Level 2 (98 controls, accredited certification body) and Level 3 (130+ controls, assessed by National Defence) are in development. Its standard is **ITSP.10.171** (the Canadian version of NIST SP 800-171, second release 2025-10-28, tailored from ITSP.10.033-01, for specified information "no less than low (Protected A)"), with **ITSP.10.171-01** for assessment.
- **Small organizations**: the Cyber Centre's Baseline cyber security controls for small and medium organizations (v1.2), now the national standard CAN/DGSI 104 for the CyberSecure Canada certification, is the usual reference for unclassified work.

### 3.5 Machine-readable editions

| Source | Format | Status | Licence | Use here |
|---|---|---|---|---|
| Cyber Centre pages for ITSP.10.033 and -01 | HTML and PDF | official | Open Government Licence - Canada (open data records) | **Primary source** for our import |
| Cyber Centre spreadsheet of ITSP.10.033-01 | spreadsheet, by email | official | not openly published | Never committed; an organization may use its own copy |
| `aws-samples/cccs-oscal-samples` | OSCAL JSON and CSV: CCCS catalogue, NIST modifications profile, ITSP.10.033-01 (440 ids), ITSP.10.171 (157), Cloud Medium (338), PBHVA overlay, SaaS FedRAMP recognition | unofficial ("not reviewed or approved by CCCS"); the ITSP.10.033-01 and ITSP.10.171 profiles are dated 2025-04-28, before the official releases | MIT-0 (code) | Cross-check of control selections and our OSCAL structure |
| CISO Assistant library (`itsp.10.033.yaml`, `itsp.10.171.yaml`, ITSP.10.033 to 800-53 mapping) | YAML | unofficial; catalogue dated 2026-03-31, mapping 2026-11-10 | catalogue marked "Open Government Licence - Canada"; app AGPL-3.0 | Cross-check of text and the 800-53 mapping |
| `usnistgov/oscal-content` v1.6.0 | OSCAL NIST SP 800-53 Rev. 5 catalogue and baselines | official (NIST) | public domain | Base catalogue that ITSP.10.033 tailors |
| `bionicspy/oscal-content` issue 15 | proposal to generate an ITSP.10.033 OSCAL catalogue | open, no code | n/a | Nothing to reuse yet |

No official OSCAL edition of any Cyber Centre publication was found.

### 3.6 The licence answer

- The open data records for ITSP.10.033, ITSP.10.033-01, ITSP.10.171, ITSP.10.171-01, ITSG-33 and ITSP.50.103 all carry the **Open Government Licence - Canada** (licence id `ca-ogl-lgo`). That licence lets anyone copy, modify, publish, translate, adapt and distribute the information, including commercially, provided the attribution statement is included ("Contains information licensed under the Open Government Licence - Canada"), without implying endorsement, and without official symbols.
- CSE's website terms (which appear to cover cyber.gc.ca) are narrower: non-commercial reproduction is free, commercial redistribution needs written permission. The publication-specific open licence is the more specific grant and is what CISO Assistant relies on too.
- **Decision (default):** store the control text in `compliance/catalogs/` with a `NOTICE` that carries the attribution, the source address, the retrieval date, the SHA-256 of what was retrieved, and "unofficial representation, not reviewed or endorsed by the Cyber Centre". Never commit the emailed spreadsheets or cloud profiles, logos or the Canada wordmark. If the owner prefers zero exposure to the narrower site terms, the importer can run at build time instead and the repository keeps only control ids, our statements and the hashes (open decision D2).
- NIST SP 800-53 text (public domain) is stored as is.

## 4. Who is assessed, and what we supply

Accreditation in Government of Canada practice is a **security assessment and authorization** of a system by its authorizing official. For this product the system is whatever your organization deploys:

| Component | Who runs it | Today |
|---|---|---|
| The VS Code extension on each computer | your organization's users | shipped |
| Messaging relay | your organization (container on its server) | foundation (Phase 68); inbound authentication in Phase 75 |
| Sync hub ("your organization's server") | your organization | Phase 32 |
| Appliance (L1a host, L1b appliance) | your organization, on premises | Phase 85 and later |
| Model endpoints: NEAR AI Cloud (attested), Cohere Model Vault, your organization's own hosting, local models | provider or your organization | NEAR AI and local shipped; others planned |
| Development and release pipeline (this repository, GitHub, the Marketplace) | us | shipped |

The product supplies, per control: the official text, our implementation statement (what the product does and where in code and tests), the responsibility split, the evidence, and the gap with its remediation. Your organization supplies: the system boundary and categorization, its own policies, people, physical and operational controls, which components it runs, the cloud provider assessments it relies on, and the authorization decision itself. Section 7 says how the two halves meet.

## 5. Source of truth

### 5.1 OSCAL, and why

OSCAL is chosen because:

- ITSP.10.033 is an adapted NIST SP 800-53 Rev. 5, and OSCAL is NIST's own model for that catalogue, its baselines and everything built on them. Our Canadian catalogue is an OSCAL **profile** over the NIST catalogue plus an OSCAL **catalogue** of the Canada-only 400-series items, the same structure the AWS sample uses.
- It covers the whole chain the request needs: catalogue and profile (the exact text per level), **component definition** (our implementation statements and what each component provides or leaves to the customer), **system security plan** (the organization's plan, prefilled with our part), **assessment plan** and **assessment results** (our evidence), and **plan of action and milestones** (the gaps).
- Assessors and GRC tools import it (Trestle, CISO Assistant through its own importers, FedRAMP tooling, Lula), so the hand-off is a file, not a reformatting job.
- It is JSON with published JSON Schemas, so a Node and TypeScript repository can generate and validate it without a second language in the build.

Alternatives considered: a custom YAML model (simpler, but every assessor would need a converter and we would reinvent profile resolution); spreadsheets (what the Cyber Centre and eMASS-style tools use, but not diffable or testable; we export a spreadsheet view instead, section 11).

### 5.2 The `compliance/` folder

```
compliance/
  catalogs/            NIST 800-53 Rev. 5 (from usnistgov/oscal-content) and the Canadian catalogue
    NOTICE             attribution, sources, retrieval dates, hashes, "unofficial representation"
  profiles/            ITSP.10.033-01 medium; our tailored Protected A selection; ITSP.10.171;
                       a reference set for Unclassified; Annex 4A Profile 3 (classified, later)
  components/          one OSCAL component definition per component in section 4, with
                       implementation statements, responsibility, and links to evidence rules
  evidence-rules/      which collector result proves which statement (section 8)
  attestations/        signed statements by a named person for controls no machine can check
  mappings/            ITSG-33 Annex 3A ids to ITSP.10.033 ids; ITSP.10.171 to ITSP.10.033
  tailoring/           per level: not-applicable decisions with reasons, parameter values
  poam/                remediation items that are not yet phases (owner, target, link)
```

It is its own package (like `relay/` and `docs-site/`): its own lockfile, exact versions, installs with scripts off. Generated files (resolved profiles, the evidence bundle, the dashboard data, the package) are build outputs, never committed, so nothing on `main` can drift from what CI computed.

### 5.3 Prior art compared

| Project | What it is | Licence, language | Maturity (2026-11) | Fit for us |
|---|---|---|---|---|
| NIST OSCAL and `oscal-content` | the format, schemas and the 800-53 catalogue | public domain; XML, JSON, YAML | OSCAL v1.2.3 (2026-08); content v1.6.0 (2026-10) | **Adopt**: the model and base catalogue |
| `oscal-cli` (metaschema-framework) | validate OSCAL (schema and constraints), resolve profiles, convert formats | public domain; Java | v3.2.0 (2026-05) | **Adopt in CI only**, one pinned and checksummed download in its own job; JSON Schema alone cannot check OSCAL's constraints or resolve profiles |
| Compliance Trestle (oscal-compass, originally IBM) | OSCAL authoring in git: split and assemble, Markdown SSP authoring, transforms, detached signing | Apache-2.0; Python | v5.2.1 (2026-11), OpenSSF best-practices badge | **Recommend as the hand-off tool** for organizations and assessors; not a build dependency (keeps Python out of our CI). Its Markdown-per-control authoring pattern is what our implementation statements copy |
| Lula (Defense Unicorns) | "GitOps for compliance": Lula 1 (Go) linked OSCAL component definitions to automated validations and wrote assessment results; Lula 2 (TypeScript, `lula2`) is a spreadsheet and YAML control editor | Apache-2.0 | Lula 1 in maintenance; Lula 2 "early stages, expect breaking changes" (v0.9.5) | **Borrow the idea** of validations bound to statements that produce OSCAL observations; do not depend on either |
| CISO Assistant (intuitem) | full GRC web application with ITSP.10.033, ITSP.10.171 and the 800-53 mapping as libraries | AGPL-3.0 community, commercial enterprise; Python and Svelte | very active, 4.6k stars | **Cross-check source** for text and mapping; a GRC tool an organization may run; never embedded (AGPL, and a server) |
| GovReady-Q | compliance server that writes SSPs from questionnaires | GPL-3.0; Python | last push 2024-12 | Not used: stale, server, copyleft |
| OpenSCAP and ComplianceAsCode | host configuration scanning (SCAP, XCCDF) and hardening content | LGPL-2.1 and BSD-3-Clause | very active | **Later evidence source** for the appliance's operating system (L1b), not the source of truth |
| `aws-samples/cccs-oscal-samples` | unofficial OSCAL CCCS catalogue and profiles | MIT-0; JSON and a shell script | last change 2025-10 | **Cross-check** our selections; its profiles predate the official ITSP.10.033-01 |

Everything above was read through the GitHub API and its documentation, not cloned or run. Anything adopted is pinned by version and hash and reviewed before first use.

### 5.4 The importer

`compliance:import` (run by a maintainer, not by CI) fetches the official English and French ITSP.10.033 and ITSP.10.033-01 pages, extracts each control or activity (id, title, statement, GC discussion, related items, references), writes the OSCAL catalogue and profile, and records source address, retrieval time and hash in `NOTICE`. A second step diffs the result against the AWS sample and the CISO Assistant library and prints every disagreement in control selection or text for a person to resolve; the import PR goes through the normal review. A weekly CI job re-fetches the pages and fails the `compliance-source` check (non-blocking) when a page hash changes, so a Cyber Centre revision is noticed within a week.

## 6. Levels and profiles

Levels follow the guided setup's labels and routing (guided-onboarding design, sections 4.3 and 4.4) and the glossary's "scale name plus level" wording.

| Dashboard level | Labels it covers | Reference set (profile) | Deployments in scope | Notes |
|---|---|---|---|---|
| **Unclassified** | Organization: Public, Internal (and Confidential on the org scale) | Cyber Centre baseline controls for small and medium organizations (as an ITSP.10.033 selection), plus CPCSC Level 1 for defence suppliers | extension with NEAR AI attested cloud or local models; relay and hub if used | No Government of Canada accreditation level exists for unclassified systems; the page says "good practice", not accreditation |
| **Protected A** | Canada, Protected: Protected A | Our tailored selection of ITSP.10.033-01 with every removal justified; ITSP.10.171 as an overlay for contractors; cloud endpoints: Cloud Low or Medium assessment | as above; cloud only through attested routes (today's routing) | No official low profile exists (section 3.2), so tailoring decisions are shown, not hidden |
| **Protected B** | Canada, Protected: Protected B | **ITSP.10.033-01** (official); cloud endpoints: provider's Cloud Medium assessment through ITSM.50.100 as inherited controls; contractors: Contract Security Program IT approval and ITSP.10.171 (CPCSC Level 2 or 3); optional PBHVA overlay for high value assets | local by default; hosted endpoints only with an `authorizations[kind=protected-b]` record | Matches the guide's Protected B copy |
| **Classified** (later) | Canada, Classified: Confidential and Secret | ITSG-33 Annex 4A **Profile 3** (Secret / Medium / Medium), until a successor is published | the appliance only (L1b), never cloud | Page lists the documentation an assessor needs and states that the product makes no claim; COMSEC, emanation and physical security are your organization's |
| Overlays: **Controlled goods (Canada)**, **ITAR** | Labels carrying the reserved compartments `CGP`, `ITAR`, `EAR`, on any level | Requirement catalogues from the Defence Production Act Part 2, the Controlled Goods Regulations and 22 CFR 120 to 130, mapped to ITSP.10.033 and product controls (`CGP-ITAR.md`, section 10) | this computer, or endpoints with a signed `export-person`/`export-endpoint` decision | Not levels: they combine with any level. Most rows are your organization's responsibility; the TEE question is shown as unsettled |
| Not covered | Protected C, Top Secret, NATO Restricted and above | none published or not applicable | none | Page states the guide's stop rule: such work runs only on systems accredited for that level |

Each level page also shows which components the level assumes (for example Protected B assumes local models or an authorized endpoint, and the relay with inbound authentication), so an organization reads only what applies to how it deploys.

## 7. The responsibility matrix

Each control in each component definition carries one responsibility value, using ITSP.10.035's allocation words and OSCAL's export model:

| Value | Meaning | OSCAL |
|---|---|---|
| **Product** | the product implements it fully when configured as documented | `implemented-requirement` with `by-component` statement, `provided` export |
| **Shared** | the product provides a part; your organization must do the rest | `provided` plus `responsibility` statements naming exactly what the organization does |
| **Your organization** | nothing in the product does it (personnel screening, physical security, the authorization itself) | `responsibility` only; the page says "your organization's responsibility" and never Met |
| **Inherited** | a provider covers it (cloud endpoint, GitHub, the Marketplace) | `inherited` with the provider's assessment reference, which your organization records |
| **Not applicable** | does not apply to this component, with a reason a reviewer approved | tailoring record with reason and reviewer |

The **customer responsibility matrix** (one row per control and component: responsibility, what we provide, what you must do, the evidence we supply) is generated from these files as a page, a CSV and a spreadsheet. An organization's own answers to the "what you must do" column go into an **organization overlay** folder that it keeps privately (section 13); the dashboard merges it locally when given, so it can see its whole system, and the public repository never holds it.

## 8. Evidence collectors and freshness

Each collector turns something CI or a person already produces into OSCAL observations tied to statements through `evidence-rules/`. Tests are tied to controls in one place (`evidence-rules/*.json`: control and statement to test file and test name), not by comments scattered through tests; a check fails when a referenced test no longer exists, is skipped or was not run.

| Collector | Source | Example controls | Freshness window | Exists today |
|---|---|---|---|---|
| CI checks | the required checks on the commit (lint, test, e2e, release-content, audit, secret-scan, relay, docs) | SA-11, SA-15, CM-3, SA-10 | current `main` head or the release tag | yes (needs collecting) |
| Mapped tests | test reporter output per test (gate, approvals, labels, outbound check, redaction, keys, attestation, relay secrets and container hardening) | AC-3, AC-4, AC-6, AC-16, SI-10, IA-5, SC-8, SC-12, SC-13, SC-28, AU-3 | current `main` head | tests yes; per-test report no |
| Dependency audit | `npm audit` JSON for the extension, relay and docs site; the SBOM's OSV check | RA-5, SI-2, SR-3 | 24 hours (scheduled daily run) | partly (exit code only) |
| SBOM | CycloneDX `sbom.cdx.json` in the VSIX; relay image SBOM (missing) | CM-8, SR-4 | per release | extension yes, relay no |
| Secret scan | `scripts/secret-scan.mjs` result | IA-5, SC-28 | current `main` head | yes |
| Workflow hardening | existing workflow tests (pinned actions, read-only permissions) | CM-2, SR-3, SA-10 | current `main` head | yes |
| Repository settings | branch protection, tag ruleset and environments read with a read-only token, compared with `docs/development-workflow.md` section 8 | CM-3, CM-5, AC-5, SA-10 | 7 days (scheduled) | settings yes, check no |
| Review and approval trail | per merged PR: agent-review status from `near-ai-reviewer`, owner gate approvals, the publish environment approval | CM-3, CM-4, SA-11 | per merge | yes (needs collecting) |
| Release integrity | tag matches main, SHA-256 checksums across jobs; provenance attestation (missing) | SI-7, SR-4, CM-14 | per release | partly |
| Documentation checks | required documents exist, have a "last reviewed" date inside the window and named sections (SECURITY.md, incident response, threat model, data flow, backup and recovery) | IR-1, IR-8, PL-2, SA-5, CP-2 | 365 days | partly |
| Crypto inventory | the algorithms used (AES-256-GCM, HKDF-SHA256, scrypt, Ed25519, TLS) listed and checked against ITSP.40.111 and ITSP.40.062 | SC-12, SC-13 | per release | no |
| Signed attestations | a statement by a named person with an expiry, signed with the existing signed-payload format | policy and procedure controls, PM, PS | its own expiry, at most 365 days | no |
| Cybersecurity harness (later) | Phase 25 SARIF findings against a deployed system | RA-5, CA-8 | 30 days | Phase 25 |

Evidence never includes secrets, prompt content, personal details or organization data: collectors keep counts, ids, hashes, run addresses and pass or fail, and the bundle passes the secret scan before upload.

## 9. How status is computed (and stays honest)

Per control, per component, per level:

1. Responsibility **Your organization** shows as that, and is Met only in the organization's own merged view, from its own evidence.
2. **Not applicable** needs a tailoring record with reason and reviewer; without one the control is Not met.
3. Otherwise collect the statement's evidence rules. **Met** = an implementation statement exists, every rule has a result, every result passed, and none is older than its window. **Partly met** = some statements of the control are Met and others are not, or the statement itself declares a known limitation (shared with SECURITY.md's "Known limitations" table, so the two cannot disagree). **Stale** = would be Met but a result is too old. **Not met** = no statement, no evidence, or a failing result.
4. The level summary counts Stale as not met.

Rules that keep it honest:

- No status field exists in any source file; the only way to change a status is to change evidence or code. A unit test of the status engine proves that a control with a statement but no evidence is Not met.
- Removing, skipping or renaming a mapped test makes its control Not met in the same PR, and the PR summary shows that drop.
- Product copy and generated documents never say compliant, accredited or certified (a lint over the generated output enforces the guided setup's "overclaiming compliance" rule); they say "evidence shows" and "your organization decides".
- Control text and our statements are kept apart on every page: official text is quoted and attributed; our text is marked as ours.
- The importer's diff and every `not applicable` decision go through normal PR review; changes under `compliance/tailoring/` are gate files (owner approval), like `SECURITY.md`.

## 10. The dashboard pages

A new **Accreditation** section in the docs site sidebar, beside Security:

- **Overview**: plain-words explanation (who authorizes, what the product supplies, how to read the pages), one card per level with counts (Met, Partly met, Not met, Stale, Not applicable, Your organization's responsibility), the evidence time and commit, and a banner when the latest evidence is older than 24 hours.
- **One page per level** (Unclassified, Protected A, Protected B, Classified): filters by family, state, component and responsibility; one row per control with the state, a one-line reason and the gap. Opening a control shows: the official text with attribution, our implementation statement, the responsibility split, each piece of evidence (what, when, which commit, link to the CI run), and for gaps the **remediation** (concrete work), the **owner** (a role: maintainers, release owner, your organization's security officer) and the **phase** or POA&M item that closes it.
- **Gaps** page: every gap across levels, sorted by how many levels it blocks, which is the roadmap view of compliance.
- **Responsibility matrix** page and its CSV and spreadsheet downloads.
- **Evidence** page: every collector, its last result and freshness, so a stale collector is visible on its own.
- **Package** page: download the documentation package for a release (section 11) and how to verify it.
- **Your organization** (only when an overlay folder is given locally): the merged view of the whole system.

The pages are static Docusaurus pages that read one generated JSON file at view time, so refreshing evidence does not need a site rebuild. `npm run compliance:refresh` in `docs-site/` downloads the latest `main` evidence bundle with `gh`, verifies its checksum (and attestation once that exists), and writes the JSON; the docs site's optional user service runs it every 15 minutes. Light, dark and high-contrast themes and keyboard use follow the existing site.

## 11. The documentation package (what an assessor receives)

Built by CI for every release and attached to the GitHub release with SHA-256 checksums:

- **OSCAL files**: the resolved profile per level; the component definitions; a **system security plan draft** per level with our parts filled and your organization's parts as clearly marked placeholders; an **assessment plan** listing what each collector checks and how; **assessment results** from this release's evidence; a **plan of action and milestones** from the gaps.
- **Readable documents**: per level, a Markdown and PDF rendering of the SSP draft, the responsibility matrix (CSV and spreadsheet), the gap list, and a crosswalk from ITSG-33 Annex 3A ids to ITSP.10.033 ids for assessors still working from ITSG-33.
- **Evidence bundle**: the collector outputs (redacted), test reports, `npm audit` reports, SBOMs, the review and approval trail, with a manifest of hashes.
- **Supporting documents** as they exist: SECURITY.md, the development workflow, incident response plan, threat model and data-flow diagrams, backup and recovery guidance.
- A `README` that says what the package is, that it is not an authorization, which release and commit it describes, how to verify the checksums, and how to load it into Trestle or a GRC tool.

## 12. CI and release integration

| Trigger | What runs | Result |
|---|---|---|
| Pull request | `compliance` job: validate the source with JSON Schema; compute status for the PR head from its own check results; write a job summary of controls whose state changes | Non-blocking at first; once stable, a drop from Met on `main` without a matching tailoring or POA&M change fails the job (open decision D5) |
| Merge to `main` | `compliance` job after the other checks: build the evidence bundle and dashboard JSON, upload as a workflow artifact | The dashboard's "latest" |
| Daily schedule | dependency audits, repository settings check, freshness recompute | Keeps Stale honest when nothing merges |
| Weekly schedule | source-page hash check (section 5.4) and `oscal-cli` validation and profile resolution | Notices Cyber Centre revisions |
| Release tag | `release.yml` builds the package from the release commit's evidence and attaches it with checksums | The snapshot an organization assesses |

Nothing is committed back to `main` by CI (protected branch, no bot commits). Workflow changes are gate files, so Phase 44's workflow PR waits for the owner's gate approval like any other.

## 13. Security of the dashboard itself

- **Local only.** The docs site serves on 127.0.0.1; the dashboard has no server code, accounts or write paths.
- **Public repository.** Only product information goes into the repository: what the product does, its tests and its gaps, at the same level of detail as SECURITY.md's known limitations. Vulnerabilities are never described in the dashboard before a fix; they go through private reporting.
- **No organization data in the repository.** An organization's overlay (its boundary, people, providers, authorizations, evidence) lives in a folder it chooses outside this repository; the dashboard reads it read-only and never uploads it. A test proves the published bundle contains no overlay content.
- **No secrets in evidence.** Collectors write ids, counts, hashes and pass or fail, never logs with tokens or prompt content; the bundle runs through the secret scan and the existing redaction before upload; the settings check uses a read-only fine-grained token in its own environment.
- **Integrity.** Each bundle carries a manifest of SHA-256 hashes; `compliance:refresh` verifies it; once artifact attestations are added (gap G4), it verifies those too.
- **Downloaded sources are data.** The importer parses HTML and JSON as data, never executes anything from it, and changes land only through reviewed PRs.

## 14. Current evidence and the biggest gaps

What already stands up well (each becomes evidence with a collector):

- Change control: every change through a PR, required checks, an independent agent review from a separate identity, owner approval for gate files and for publishing, linear history, tag protection (`docs/development-workflow.md`, `scripts/lib/workflow.mjs`).
- Supply chain basics: lockfiles, actions pinned by SHA, the relay image pinned by digest, distroless and non-root, installs without scripts for the relay and docs site, a CycloneDX SBOM in the VSIX checked against OSV, VSIX contents verified, checksums carried from build to publish; the Marketplace signs extensions and VS Code verifies that signature at install.
- Product controls with tests: the gate (one decision function, a floor nothing overrides, a signed policy bundle as ceiling), labels and routing, the outbound check, approvals, protected paths, redaction, untrusted content fencing, attestation of model answers and connection binding, keys in SecretStorage, AES-256-GCM project state, relay secrets from files and log redaction, about 110 security test files.
- Disclosure: private vulnerability reporting (SECURITY.md).

The biggest gaps, with remediation and owner:

| # | Gap | Controls | Remediation | Owner | Closes in |
|---|---|---|---|---|---|
| G1 | No incident response plan, no supported-versions table, no response-time commitment | IR-1, IR-4, IR-6, IR-8, SI-5 | Write `docs/incident-response.md` (product side: triage, fix, advisory, Marketplace rollback, notify) and a supported-versions table in SECURITY.md; a responsibility row for your organization's own IR | maintainers | Phase 44 (docs) |
| G2 | Gate decision records are not tamper-evident and cannot be exported | AU-9, AU-10, AU-6, AU-4 | Hash-chained local audit with signed heads (already planned), plus an export command for assessors | maintainers | Phase 41 (chain); export as a POA&M item |
| G3 | Relay has no inbound authentication yet | AC-17, IA-2, IA-9, SC-23 | As planned | maintainers | Phase 75 |
| G4 | No build provenance or attestation for the VSIX, the relay image or the package | SR-4, SR-11, SI-7, CM-14 | GitHub artifact attestations in `release.yml`; verify in `compliance:refresh` | release owner | Phase 44 |
| G5 | No CVE scan or SBOM for the relay container | RA-5, CM-8, SR-4 | Image SBOM and a pinned scanner in the `relay` job, failing on high or critical | maintainers | Phase 44 |
| G6 | No static analysis (SAST) | SA-11(1) | CodeQL or Semgrep in CI, results as evidence | maintainers | Phase 44 |
| G7 | No CODEOWNERS; review routing is by convention | CM-5, AC-5 | Add CODEOWNERS for gate paths and `compliance/` | owner | Phase 44 |
| G8 | No backup and recovery guidance for the relay and hub | CP-9, CP-10 | Operator runbook (already planned) | maintainers | Phase 84 (relay), Phase 32 (hub restore drill) |
| G9 | No standalone threat model or data-flow diagram | RA-3, PL-8, SA-17 | One threat model and Mermaid data-flow diagrams per component, reviewed yearly | maintainers | Phase 44 (docs) |
| G10 | Root installs run dependency scripts, dev dependencies use ranges, no automated update alerts | SR-3, SI-2, CM-2 | `.npmrc` with exact saves for the root, scripts off where possible, Dependabot alerts for security updates only | maintainers | POA&M item |
| G11 | No central log forwarding or retention guidance | AU-6, AU-11, SI-4 | Document what each component logs, where, how long; a forwarding option for your organization's SIEM | shared | relay Phase 84; extension POA&M |
| G12 | Docs build not a required check | CM-3 | Make `docs` (and later `compliance`) required | owner | Phase 44 |
| G13 | Attestation checks skip TCB status, revocation and measurements | SC-8, SR-11 | As listed in SECURITY.md; use the provider's full verifier until then | maintainers | POA&M item |

## 15. State machines this adds

- **Control status** (per control, component and level): Not met, Partly met, Met, Stale, Not applicable, Your organization's responsibility. Transitions come only from evidence results, the clock (Met to Stale when a window passes), tailoring records (to or from Not applicable, reviewed) and statement changes. No transition comes from a person typing a status; there is no stuck state because Stale always returns to Met or Not met at the next collection.
- **Evidence item**: collected, passed or failed, then stale at its window. A collector that stops running shows its own Stale state on the Evidence page, so a silent collector cannot keep controls Met.
- **Gap (POA&M item)**: open, planned (has a phase or target date), in progress, closed (the control turns Met) or risk accepted (a signed acceptance by a named person with an expiry, shown as such, never as Met). Closing is automatic from status; an expired acceptance reopens the item.
- **Source catalogue**: current, then changed upstream (weekly hash check), re-imported through a PR. The dashboard shows which source version each page uses.

## 16. Risks

| Risk | Mitigation |
|---|---|
| Readers take the dashboard as an accreditation or a promise | "Your organization decides" on every page, the word lint (section 9), the package README; the guide's "never overclaim" rule applies |
| Our import of ITSP.10.033 differs from the official text | Two independent cross-checks, source hashes, weekly change detection, "unofficial representation" notice, and a link to the official page on every control |
| Mapping a test to a control overstates what it proves | Statements say exactly what is proven and what is not; evidence rules are reviewed like code; Partly met is used freely |
| Publishing gaps helps attackers | Same level of detail as the existing public known-limitations table; vulnerabilities only after a fix |
| The narrower CSE site terms are read as controlling | Default relies on the publication-specific open licence; open decision D2 offers fetch-at-build instead |
| Collector or settings token misuse | Read-only fine-grained token in its own environment, no write scopes; collectors run on `main`, never on PR code with secrets |
| Upstream revisions (ITSP.10.033-01 is new; Low or Secret profiles may appear) | Weekly check; levels are data in `profiles/`, so a new profile is a PR, not a redesign |
| Maintenance load of hundreds of statements | Statements per component, shared statements reused across levels; start with the Protected B profile and derive the others |

## 17. Open decisions with defaults

| # | Question | Default |
|---|---|---|
| D1 | Where does the dashboard live? | In the docs site, a new Accreditation section; an in-extension organization view later, after Phase 41 |
| D2 | Store Cyber Centre text in the repository or fetch at build? | Store, with the Open Government Licence attribution and the unofficial-representation notice (section 3.6) |
| D3 | Which ITSP.10.033 edition and language? | English and French from the official pages, the current edition, pinned by hash |
| D4 | Which profile drives the first build? | ITSP.10.033-01 Medium (Protected B) first, then derive Protected A and Unclassified; Classified page with the Annex 4A Profile 3 list and "no product claim" when the appliance phase starts |
| D5 | Does the `compliance` job block merges? | Non-blocking for the first release of it; then blocking only on a drop from Met without a reviewed tailoring or POA&M change |
| D6 | Freshness windows | Test and check evidence: current `main` head; audits: 24 hours; repository settings: 7 days; harness scans: 30 days; documents and attestations: 365 days |
| D7 | Hand-off tool recommended to organizations | Compliance Trestle (Apache 2.0); the package is plain OSCAL so any OSCAL tool works |
| D8 | Validation tool in CI | `oscal-cli`, pinned and checksummed, in a weekly job and the release job; JSON Schema validation in the per-PR job |
| D9 | How tests are tied to controls | One mapping in `compliance/evidence-rules/`, checked for missing or skipped tests, not comments in tests |
| D10 | Include ITSP.10.171 and CPCSC levels for defence suppliers? | Yes, as an overlay on the Protected A and Protected B pages, from the start |
| D11 | Show your organization's view from a private overlay folder in the docs site? | Yes, local only, read-only, never uploaded |
| D12 | Controlled Goods Program and ITAR? | Yes, as two overlay pages from requirement catalogues (`CGP-ITAR.md`, sections 10 and 14; ACCR-13, ACCR-14) |

## 18. Phase proposal

### Phase 44: Accreditation evidence and compliance dashboard

**Goal:** Anyone preparing a security assessment of a system that uses this product can see, per level, the exact controls, what the product does for each with live evidence, what your organization must do, and every gap with its remediation, and can download a release's documentation package in OSCAL and readable form.

**Depends on:** nothing in flight. It reads the docs site (PR #141) and CI as they are; it later picks up the Phase 41 audit chain and the Phase 75 relay authentication as evidence. **Runs in parallel** with Phases 30 to 43 and the patch line: it touches `compliance/` (new), `docs-site/`, `scripts/` (new collector scripts) and `.github/workflows/` (new jobs), never `src/`, `media/` or `.planning/phases/` of other phases. Shared files: `.github/workflows/ci.yml` and `release.yml` (gate files, owner approval; land in one PR), and `docs-site/sidebars.js` (one new category).

**Requirements:**

- ACCR-01: The `compliance/` package holds the NIST 800-53 Rev. 5 catalogue, the Canadian catalogue and profiles in OSCAL JSON with an attribution `NOTICE`, source addresses, retrieval dates and hashes, and validates against the OSCAL schemas.
- ACCR-02: A maintainer-run importer builds the ITSP.10.033 catalogue and ITSP.10.033-01 profile from the official pages and reports every disagreement with the two unofficial conversions; a weekly job detects upstream changes.
- ACCR-03: Component definitions exist for the extension, relay, release pipeline and model endpoints (hub and appliance as placeholders), each control with an implementation statement and one responsibility value.
- ACCR-04: Evidence rules tie statements to collectors; a check fails when a mapped test is missing, skipped or not run.
- ACCR-05: Collectors produce a redacted evidence bundle with a hash manifest on every merge to `main` and on a daily schedule (CI checks, mapped tests, audits, SBOMs, secret scan, workflow hardening, repository settings, review and approval trail, release integrity, documentation checks).
- ACCR-06: The status engine computes the six states from evidence and freshness only; no source file carries a status; Stale counts as not met.
- ACCR-07: Docs-site Accreditation section: overview, one page per level, gaps, responsibility matrix, evidence and package pages, reading generated JSON refreshed without a rebuild.
- ACCR-08: Every gap shows remediation, owner and the phase or POA&M item; risk acceptances are signed, expire and never show as Met.
- ACCR-09: Each release attaches the documentation package (OSCAL SSP draft, assessment plan and results, POA&M, resolved profiles, responsibility matrix, ITSG-33 crosswalk, evidence bundle, README) with checksums and artifact attestations.
- ACCR-10: The pull request job summarizes control state changes; a drop from Met without a reviewed tailoring or POA&M change fails it once D5's switch is made.
- ACCR-11: Nothing generated says compliant, accredited or certified about the product; the evidence bundle holds no secrets or organization data; an organization overlay is merged locally only.
- ACCR-12: Gaps G1, G4, G5, G6, G7, G9 and G12 from the design are closed or have a dated POA&M item.
- ACCR-13: Controlled goods (Canada) and ITAR overlays: requirement catalogues from the official texts with source hashes and an unofficial-representation notice, mapped to ITSP.10.033 and NIST SP 800-53 controls and to product statements, shown as two Accreditation pages with the same six states (`CGP-ITAR.md`, section 10).
- ACCR-14: The copy lint refuses "ITAR compliant", "CGP compliant" and similar phrases about the product; rows that depend on unsettled questions (TEEs, encrypted storage at third parties) are never Met; a docs page gives the interim settings and what the product cannot stop (`CGP-ITAR.md`, sections 10.3 and 11).

**Success criteria** (what must be TRUE):

1. Opening the Protected B page lists every ITSP.10.033-01 control with its state; opening any control shows the attributed official text, our statement, the responsibility, the evidence with its CI run and time, and for a gap the remediation, owner and phase. (ACCR-01, ACCR-03, ACCR-07, ACCR-08)
2. Deleting or skipping a test that a Met control relies on turns that control Not met in the same PR's summary; letting a daily audit lapse turns its controls Stale and the level counts drop. (ACCR-04, ACCR-05, ACCR-06, ACCR-10)
3. A control with a statement but no evidence is never Met, proved by a status engine test; no source file can set a status. (ACCR-06)
4. A release's package validates with `oscal-cli`, imports into Compliance Trestle, verifies against its checksums and attestation, and contains no secret, prompt content or overlay data. (ACCR-09, ACCR-11)
5. Changing one character on an official source page is reported by the weekly job; the importer's cross-check lists every selection or text difference with the unofficial conversions. (ACCR-02)
6. With a sample organization overlay given locally, the "Your organization" view shows the whole system's matrix, and the published bundle and site build contain none of it. (ACCR-11)
7. The incident response plan, supported-versions table, threat model and data-flow diagrams exist with review dates; the relay job scans its image and produces an SBOM; releases carry attestations; CODEOWNERS covers gate paths; `docs` is a required check. (ACCR-12)

**Research flags:** the exact Treasury Board Directive on Security Management Appendix B clauses (the site refused automated retrieval); whether the Cyber Centre will publish OSCAL or a machine-readable catalogue (ask contact@cyber.gc.ca, which would replace our importer); how far the Unclassified reference set should follow CAN/DGSI 104 versus CPCSC Level 1; which crypto items ITSP.40.111 lists for Ed25519 and scrypt; whether GitHub's API exposes environment approvals and branch protection to a read-only token without admin rights.

**Later (not in Phase 44):** an in-extension organization view of the same data on Phase 41's `authorizations[]` records; OpenSCAP evidence for the appliance; Phase 25 harness findings as evidence; the Classified page's content when L1b is planned.

## 19. Sources

Cyber Centre and Government of Canada (all retrieved 2026-11-20):

- ITSP.10.033 foreword and introduction: https://www.cyber.gc.ca/en/guidance/cyber-security-privacy-risk-management/itsp10033/foreword-overview-introduction
- ITSP.10.033-01 Medium impact profile: https://www.cyber.gc.ca/en/guidance/cyber-security-privacy-risk-management/suggested-organizational-security-privacy-control-activity-profile-medium-impact-itsp10033-01
- ITSP.10.035 Overview: https://cyber.gc.ca/en/guidance/cyber-security-privacy-risk-management/cyber-security-privacy-risk-management-lifecycle-approach-overview-itsp10035
- ITSP.10.036: https://www.cyber.gc.ca/en/guidance/cyber-security-privacy-risk-management/organizational-cyber-security-privacy-risk-management-activities-itsp10036
- ITSG-33 (still published, Annex 4A Profile 3): https://www.cyber.gc.ca/en/guidance/it-security-risk-management-lifecycle-approach-itsg-33
- ITSP.10.171: https://www.cyber.gc.ca/en/guidance/protecting-controlled-information-non-government-canada-systems-and-organizations-itsp10171
- ITSP.10.171-01: https://cyber.gc.ca/en/guidance/assessing-security-requirements-specified-information-itsp10171-01
- Cloud Security Assessment Program: https://www.cyber.gc.ca/en/tools-services/cloud-security-assessment-program
- ITSM.50.100: https://cyber.gc.ca/en/guidance/cloud-service-provider-information-technology-security-assessment-process-itsm50100
- ITSP.50.103: https://cyber.gc.ca/en/guidance/guidance-security-categorization-cloud-based-services-itsp50103
- ITSP.50.105: https://cyber.gc.ca/en/guidance/guidance-cloud-security-assessment-and-authorization-itsp50105
- Harmonized TRA (TRA-1): https://cyber.gc.ca/en/guidance/harmonized-tra-methodology-tra-1
- Baseline cyber security controls for small and medium organizations: https://cyber.gc.ca/en/guidance/baseline-cyber-security-controls-small-and-medium-organizations
- Directive on Security Management (not retrievable automatically): https://www.tbs-sct.canada.ca/pol/doc-eng.aspx?id=32611
- Contract Security Manual: https://www.canada.ca/en/public-services-procurement/services/industrial-security/security-requirements-contracting/contract-security-manual-contracting-government-canada/contract-security-manual.html and IT security requirements: https://www.canada.ca/en/public-services-procurement/services/industrial-security/security-requirements-contracting/safeguarding-equipment-sites-assets-information/information-technology-security-requirements.html
- CPCSC program overview: https://www.canada.ca/en/public-services-procurement/services/industrial-security/security-requirements-contracting/cyber-security-certification-defence-suppliers-canada/program-overview.html
- Open data records (licence `ca-ogl-lgo`), via the open.canada.ca catalogue API: ITSP.10.033 (ddad8760-bf9b-47aa-890d-67da202aca6a), ITSP.10.033-01 (06179c95-a0e0-446f-8f53-9208f8b41eb9), ITSP.10.171 (ec66c9c2-a150-45b9-bd2d-0ca0f24ee7ff), ITSP.10.171-01 (7bef2eec-539a-4750-b7ec-dfa776da7658), ITSP.50.103 (4d68aa91-cb32-4177-8bc1-56a5e3d572c5)
- Open Government Licence - Canada: https://open.canada.ca/en/open-government-licence-canada
- CSE website terms and conditions: https://www.cse-cst.gc.ca/en/about-apropos/terms-and-conditions

OSCAL and tools (read through the GitHub API, nothing run):

- NIST OSCAL: https://pages.nist.gov/OSCAL/ and https://github.com/usnistgov/OSCAL ; content: https://github.com/usnistgov/oscal-content
- oscal-cli: https://github.com/metaschema-framework/oscal-cli
- Compliance Trestle: https://github.com/oscal-compass/compliance-trestle
- Lula: https://github.com/defenseunicorns/lula (Lula 1: https://github.com/defenseunicorns-labs/lula1)
- CISO Assistant: https://github.com/intuitem/ciso-assistant-community (libraries `itsp.10.033.yaml`, `itsp.10.171.yaml`, `mapping-itsp.10.033-and-nist-sp-800-53-rev5.yaml`)
- GovReady-Q: https://github.com/GovReady/govready-q
- OpenSCAP: https://github.com/OpenSCAP/openscap ; ComplianceAsCode: https://github.com/ComplianceAsCode/content
- AWS CCCS OSCAL samples: https://github.com/aws-samples/cccs-oscal-samples and the AWS Security Blog post "Using OSCAL to express Canadian cybersecurity requirements as compliance-as-code"
- Proposal for an ITSP.10.033 OSCAL catalogue: https://github.com/bionicspy/oscal-content/issues/15
- VS Code extension signature verification: https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security

Repository evidence: `.github/workflows/ci.yml`, `agent-review.yml`, `release.yml`; `scripts/lib/workflow.mjs`; `scripts/extension-sbom.mjs`; `scripts/secret-scan.mjs`; `docs/development-workflow.md` (sections 3 to 8); `docs/testing.md`; `SECURITY.md` (known limitations, how changes reach a release, reporting); `src/domain/gate/`, `src/gate/`, `src/services/attestation.ts`, `src/domain/state/keys.ts`, `relay/src/`, `relay/Dockerfile`.
