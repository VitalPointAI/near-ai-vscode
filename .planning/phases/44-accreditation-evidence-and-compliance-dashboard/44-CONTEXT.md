# Phase 44: Accreditation evidence and compliance dashboard - Context

**Gathered:** 2026-11-21
**Status:** Accepted by the owner on 2026-11-21 (see "Owner decisions" at the end). First decided on the owner's behalf. The owner accepted the compliance dashboard design (`.planning/research/compliance-dashboard/DESIGN.md`, PR #144) with all its defaults, and the Controlled Goods Program and ITAR extension (`CGP-ITAR.md`, PR #146). The owner was not available for questions, so the planning agent took the recommended option on every open point and recorded it here as D-01 to D-40. Decisions the owner should confirm are listed at the end under "For the owner to confirm", each with the default the plans use. Decisions already made by the owner are marked (owner). D-41 to D-50 were added after `44-RESEARCH.md` and change nothing the owner accepted.
**Source:** `DESIGN.md` (sections 3 to 18) and `CGP-ITAR.md` (sections 10 to 14) in `.planning/research/compliance-dashboard/`, the Phase 44 entry in `.planning/ROADMAP.md`, the coherence review (`.planning/research/coherence/`: GLOSSARY section 5, the copy lint), what Phase 41 built (copy lint with `COMPLIANCE_CLAIMS`, architecture test, `authorizations[]`), what Phase 32 built (`hub/` and its CI job), and `origin/main` at 1bf565b5.

<domain>
## Phase Boundary

Phase 44 gives anyone preparing a security assessment of a system that uses this product one honest, evidence-driven view of where it stands:

- **One machine-readable source.** A new `compliance/` package in NIST OSCAL JSON: the NIST SP 800-53 Rev. 5 catalogue, the Cyber Centre's ITSP.10.033 catalogue (with the Canada-only 400-series items) and the ITSP.10.033-01 Medium profile, our tailored Protected A selection, an Unclassified reference set, the ITSG-33 Annex 4A Profile 3 list for a later Classified page, and the Controlled Goods and ITAR requirement catalogues, each with an attribution `NOTICE`, source address, retrieval date and hash. (ACCR-01, ACCR-13)
- **An importer and a change watch.** A maintainer-run importer from the official pages, a cross-check against the two unofficial conversions, and a weekly source-hash job. (ACCR-02)
- **What the product does, per control.** OSCAL component definitions for the extension, relay, hub, release pipeline and model endpoints (appliance as a placeholder), each control with an implementation statement and one responsibility value. (ACCR-03)
- **Evidence, not prose.** Evidence rules tying statements to collectors; collectors that turn CI results, mapped tests, audits, SBOMs, the secret scan, workflow hardening, repository settings, the review trail, release integrity and document checks into a redacted evidence bundle with a hash manifest. (ACCR-04, ACCR-05)
- **One status engine.** Six states computed from evidence and the clock only; no source file carries a status; Stale counts as not met. (ACCR-06)
- **The Accreditation section of the docs site.** Overview, one page per level, the Controlled goods (Canada) and ITAR overlays, gaps, responsibility matrix, evidence and package pages, reading one generated JSON file refreshed without a rebuild, and a local-only "Your organization" view from a private overlay folder. (ACCR-07, ACCR-08, ACCR-11, ACCR-13)
- **The release package.** OSCAL SSP draft, assessment plan and results, POA&M, resolved profiles, responsibility matrix, ITSG-33 crosswalk, evidence bundle and README, with checksums and artifact attestations, validated by `oscal-cli`. (ACCR-09)
- **CI integration.** A non-blocking `compliance` job on pull requests that summarizes state changes, a merge and daily bundle, weekly validation, and the release package. (ACCR-10)
- **The honest words.** The same compliance-claim rule the Phase 41 copy lint applies to the extension, applied to every generated file and Accreditation page. (ACCR-11, ACCR-14)
- **Close the gaps it owns.** G1 (incident response plan, supported versions), G4 (attestations), G5 (relay image scan and SBOM), G6 (static analysis), G7 (CODEOWNERS), G9 (threat model, data-flow diagrams) and G12 (`docs` required); every other gap gets a phase or a dated POA&M item. (ACCR-12)

Not in this phase: an in-extension organization view (after Phase 41, on `authorizations[]`); any change under `src/`, `media/`, `hub/` or `relay/src/`; the hash-chained local audit and its export (Phase 32.1, the record writer; G2 stays a POA&M item and a "later evidence" row); relay inbound authentication (Phase 75, G3); export-control enforcement (Phase 45); Phase 25 harness findings and OpenSCAP evidence; the Classified page's content beyond the profile list and "no product claim".
</domain>

<decisions>
## Implementation Decisions

### Accepted from the designs (owner)
- **D-01 (owner):** The successor series is authoritative: ITSP.10.035 (overview), ITSP.10.033 (catalogue) and ITSP.10.033-01 (Medium profile, the Protected B reference). ITSG-33 identifiers are kept only as a crosswalk for assessors still using them.
- **D-02 (owner):** ITSG-33 Annex 4A Profile 3 is the only published Secret baseline and is used as the Classified reference until a successor is published. The Classified page lists it and says the product makes no claim; it is for the appliance only.
- **D-03 (owner):** Control text is stored in the repository under the Open Government Licence - Canada with the attribution statement, an "unofficial representation, not reviewed or endorsed by the Cyber Centre" notice, the source address, the retrieval date and the SHA-256 of what was retrieved (DESIGN D2). Emailed spreadsheets, cloud profiles, logos and the Canada wordmark are never committed.
- **D-04 (owner):** OSCAL JSON in `compliance/` is the one source; our own small TypeScript tooling generates and checks it; `oscal-cli` validates and resolves profiles in CI; Compliance Trestle is the recommended hand-off tool and a test fixture, never a build dependency.
- **D-05 (owner):** Six states, with these shown words: Met, Partly met, Not met, Stale, Not applicable (always with a reason), Your organization's responsibility. Nothing generated ever says the product is compliant, accredited or certified.
- **D-06 (owner):** Protected B (ITSP.10.033-01) is built first; Protected A and Unclassified are derived from it; the Classified page comes last.
- **D-07 (owner):** The `compliance` job is not blocking at first (DESIGN D5). The switch to blocking on a drop from Met without a reviewed tailoring or POA&M change is a later one-line change the owner makes.
- **D-08 (owner):** Gaps G1 to G13 are the design's list (DESIGN section 14), with X1 to X12 from `CGP-ITAR.md` section 11 on the overlay pages.
- **D-09 (owner):** Freshness windows are the design's D6: test and check evidence, the current `main` head (or the release tag); audits, 24 hours; repository settings, 7 days; harness scans, 30 days; documents and signed attestations, 365 days.
- **D-10 (owner):** ITSP.10.171 and CPCSC are an overlay on the Protected A and Protected B pages from the start (DESIGN D10); the organization's private overlay view is local only and read-only (D11); the Controlled goods (Canada) and ITAR overlays are two pages (D12, CGP-ITAR E12 and E13).

### Reuse terms, checked before any text is committed
- **D-11 (licence gate, an invariant not a judgement):** `compliance/sources.json` lists every source with its address, licence id, the evidence for that licence (for Government of Canada publications, the open.canada.ca record id and its `license_id`), the retrieval date and the hash. The importer writes control text only for a source whose recorded licence is in an allow list (`ca-ogl-lgo`, US public domain for NIST and the eCFR, the Reproduction of Federal Law Order for federal enactments); for any other source it writes ids, titles it may cite, and a link, never text. A test refuses a catalogue file with text from a source outside the allow list. The first import task re-reads each open data record's licence through the open.canada.ca API before committing anything, and stops if a record no longer says `ca-ogl-lgo`.
- **D-12 (per source):** Text stored: ITSP.10.033, ITSP.10.033-01, ITSP.10.171, ITSP.10.171-01 and ITSG-33 (for Annex 4A Profile 3 and the Annex 3A crosswalk) under `ca-ogl-lgo` if their records still say so; NIST SP 800-53 Rev. 5 from `usnistgov/oscal-content` (public domain); the Defence Production Act Part 2 and the Controlled Goods Regulations under the Reproduction of Federal Law Order (accurate, not presented as official); 22 CFR 120 to 130 (US government work). Also stored: the Cyber Centre's Baseline cyber security controls for small and medium organizations v1.2 (its open data record says `ca-ogl-lgo`, 44-RESEARCH.md). Ids and links only: CAN/DGSI 104 (all rights reserved), CPCSC Level 1 (canada.ca terms; it is 13 ITSP.10.171 ids, whose text is already stored) (canada.ca terms), PSPC and Treasury Board guidance pages (cited and paraphrased). The CSE website terms are noted in `NOTICE` as narrower; the publication-specific open licence is the grant relied on.
- **D-13:** The French text of ITSP.10.033 and -01 is imported beside the English (DESIGN D3) and kept in the same OSCAL files as a second `prose` part with `lang`; pages show English first with a link to the French. If the French page structure blocks a clean parse in the import plan, French ships as a POA&M item rather than delaying the English.

### Package and source layout
- **D-14:** `compliance/` is its own package like `docs-site/` and `relay/`: own `package.json` and lockfile, exact versions, `npm ci --ignore-scripts`, TypeScript compiled with the root's pinned compiler version, tests run through the repository's `node scripts/run-tests.mjs`. Folders as DESIGN section 5.2 plus `catalogs/cgp/`, `catalogs/itar/` and `sources.json`. Runtime dependencies: none beyond Node built-ins; development dependencies: TypeScript and a JSON Schema validator pinned exactly (the research step picks one).
- **D-15:** Generated files (resolved profiles, evidence bundle, dashboard JSON, package) are build outputs under `compliance/out/` (git-ignored), never committed, so nothing on `main` can drift from what CI computed.
- **D-16:** The OSCAL JSON Schemas for the pinned OSCAL version are vendored into `compliance/schemas/` with their source and hash (public domain), so per-PR validation runs offline.

### Status engine (ACCR-06)
- **D-17:** `computeStatus(control, component, level, evidence, now)` is a pure function in `compliance/src/status.ts`. Inputs are statements, responsibility values, tailoring records, evidence results and the clock; no input carries a status. The source schemas reject any `status`, `state` or `met` key anywhere under `compliance/` sources, and a test proves it.
- **D-18:** Rules (DESIGN section 9): Your organization's responsibility is never Met in the public view; Not applicable needs a tailoring record with a reason and a reviewer, otherwise Not met; Met needs a statement, every rule with a result, every result passed and fresh; Partly met when some statements are Met and others are not, or the statement declares a known limitation that SECURITY.md's "Known limitations" table also lists (a test checks the two agree); Stale when it would be Met but a result is too old; Not met otherwise. Level summaries count Stale as not met.
- **D-19:** Rows that depend on unsettled questions (the TEE question, encrypted storage at third parties, CGP-ITAR section 10.3) carry an `unsettled` reason and can never be Met; a self-signed decision counts as Not met for any row that requires an official's signature.
- **D-20:** A risk acceptance is a signed statement by a named person with an expiry (at most 365 days), using the existing signed-payload format verified with Node's built-in crypto; it is shown as "Risk accepted until {date}", never as Met, and an expired one reopens the gap.

### Evidence (ACCR-04, ACCR-05)
- **D-21:** Tests are tied to controls in one place, `compliance/evidence-rules/*.json` (control and statement to test file and test name), never by comments in tests. The check fails when a mapped test is missing, skipped, renamed or was not run.
- **D-22:** Per-test results come from a machine-readable report that `scripts/run-tests.mjs` writes when asked (an opt-in flag and output path; default behaviour unchanged). The CI `test` job uploads it as an artifact; the compliance job reads it. If the research step finds that Node's built-in reporters give this without a runner change, that is used instead.
- **D-23:** Collectors (DESIGN section 8): CI checks, mapped tests, dependency audits (JSON for root, relay, hub, docs site), SBOMs (VSIX now, relay image from G5), secret scan, workflow hardening (the existing `scripts/test/workflow-files.test.mjs`), architecture test and copy lint (Phase 41), the hub CI job (Phase 32), repository settings (read-only fine-grained token in its own environment, daily), review and approval trail, release integrity, documentation checks (required documents present with a "Last reviewed" date inside 365 days), crypto inventory. Each is a small module in `compliance/src/collectors/` with fixture tests; none needs network access in its unit tests.
- **D-24:** Evidence holds only ids, counts, hashes, run addresses, times and pass or fail; never logs, tokens, prompt content, personal details or organization data. The bundle runs through `scripts/secret-scan.mjs` before upload, and a test proves a bundle built with a sample organization overlay present contains none of it.
- **D-25:** The collectors run on `main` and on schedules only, never with secrets on pull request code. The pull request job computes status from the PR's own check results and artifacts with the default read-only token.
- **D-26:** The Phase 41 audit chain does not exist yet (the record writer and hash-chained audit moved to Phase 32.1), so AU-9 and AU-10 rows are Not met with gap G2, closing in Phase 32.1 (chain) and a POA&M item (export). Phase 75 relay authentication is the same for G3.

### Words (ACCR-11, ACCR-14)
- **D-27 (one rule, not two):** The compliance-claim rule already lives in the Phase 41 copy lint (`COMPLIANCE_CLAIMS` and its negation rule in `src/test/helpers/copyLintScan.ts`, which already includes "ITAR compliant", "CGP compliant" and the rest). Phase 44 does not change `src/`. Its output lint (`compliance/src/wordLint.ts`) runs over every generated file and every Accreditation page and uses the same phrase list and negation rule; a parity test in `compliance/test/` reads the phrase list from the Phase 41 source and fails when the two differ, so they cannot drift. Adding the Accreditation pages to `ALLOWED_CLAIM_CONTEXTS` is not needed because the extension's copy lint does not scan `docs-site/`.
- **D-28:** Each page opens with "Your organization decides" wording: what the product supplies, that it is not an authorization, and who authorizes. The overlay pages use the CGP-ITAR section 10.2 opening sentence. Official text is quoted and attributed; our text is marked as ours.

### Docs site (ACCR-07, ACCR-08)
- **D-29:** A new Accreditation category in `docs-site/sidebars.js`, beside Security. Pages are Docusaurus pages with React components that read `docs-site/static/compliance/dashboard.json` at view time, so refreshing evidence needs no rebuild. The site builds and renders an honest empty state ("No evidence yet: run compliance:refresh") when the file is missing.
- **D-30:** `npm run compliance:refresh` in `docs-site/` downloads the latest `main` bundle with `gh`, verifies the hash manifest (and the attestation once G4 lands), and writes the JSON. The docs-site user service may run it every 15 minutes; installing that timer is the owner's step.
- **D-31:** The Your organization view reads an overlay folder whose path is given locally (an environment variable or a git-ignored local file), merges it in the browser view only, and never writes it into `static/` or the build output; a test builds the site with a sample overlay present and checks the build output holds none of it.
- **D-32:** Pages follow the site's light, dark and high-contrast themes and keyboard use; filters by family, state, component and responsibility; each control opens to official text, our statement, responsibility, evidence (what, when, commit, CI run link), and for a gap remediation, owner (a role) and the phase or POA&M item.

### CI, release and the gaps it closes (ACCR-09, ACCR-10, ACCR-12)

On 2026-11-22 the owner approved including the official ITSG-33 Annex 3A statements in the assessor package so the Classified reference can pass full OSCAL validation. The docs dashboard continues to list IDs and titles and link to the publication.

- **D-33:** All workflow changes land in one plan and one PR section, because `.github/workflows/*` are gate files the owner approves: a `compliance` job in `ci.yml` (PR summary, merge bundle), a `compliance-scheduled.yml` workflow (daily freshness, audits, settings; weekly source hashes and `oscal-cli`), the package and attestations in `release.yml`, the relay image SBOM and scan in the `relay` job, and static analysis.
- **D-34:** Static analysis (G6) is CodeQL for JavaScript and TypeScript in its own workflow with actions pinned by SHA (GitHub-native, free for a public repository); results are evidence. The relay image SBOM and scan (G5) use pinned, checksummed tools the research step picks, failing on high or critical.
- **D-35:** Attestations (G4) use GitHub artifact attestations in `release.yml` for the VSIX and the package (and the relay image once it is published), with the narrowest job-level permissions; `compliance:refresh` verifies them with `gh attestation verify`.
- **D-36:** `.github/CODEOWNERS` covers the gate paths (`.github/`, `SECURITY.md`, `scripts/lib/workflow.mjs`, `compliance/tailoring/`, `compliance/sources.json`, `compliance/catalogs/`) (G7). Making `docs` (and later `compliance`) a required check (G12) is a repository setting only the owner can change; the plan ends with that instruction for the owner and the settings collector shows it until done.
- **D-37:** G1 and G9 documents live where the docs site already syncs from: `docs/security/incident-response.md`, `docs/security/threat-model.md` and `docs/security/data-flow.md` (Mermaid diagrams per component), each with a "Last reviewed" line, plus a supported-versions table in `SECURITY.md` (a gate file) and the "Controlled goods and ITAR" guidance page (X12) with the interim settings worded as options for your organization's officials. The crypto inventory (X8) is `docs/security/crypto-inventory.md` with the "comparable strength" basis and no FIPS claim. These are documentation outside the four code folders; they change no behaviour.
- **D-38:** Every other gap (G2, G3, G8, G10, G11, G13, X1 to X10) gets a POA&M item in `compliance/poam/` with an owner role and either its phase or a target date, so ACCR-12 holds.

### Order and branches
- **D-39:** One integration branch `feat/phase-44-accreditation`, plan branches from its HEAD, merged back after each wave, one integration PR (the Phase 31, 32 and 41 pattern), split after a wave only if the diff nears the reviewer's limit. Plans in one wave never change the same file. The workflow plan runs last so the owner's gate approval covers every workflow change at once.
- **D-40:** Statements are written first for the controls where evidence already exists (change control, supply chain, the gate, labels and routing, outbound check, approvals, redaction, keys, attestation, relay and hub hardening). Every other control in the profile still appears, honestly Not met with "No statement yet", or with its responsibility value where it is plainly your organization's (personnel, physical, the authorization itself). Responsibility is set per control by a reviewed family default table plus per-control exceptions, so a family default can never set a status.

### Added after research (44-RESEARCH.md)
- **D-41 (non-blocking really means non-failing):** `evaluateChecks` and `evaluateCommit` in `scripts/lib/workflow.mjs` refuse a merge or a tag when any check run on the commit failed, required or not. So the `compliance` job, the scheduled workflow, CodeQL and the relay image scan never conclude `failure` on findings while D-07 holds: findings go to the job summary and the evidence bundle, the steps that report them use step-level `continue-on-error`, and a workflow-files test proves each of these jobs cannot fail on a finding. A broken tool (cannot run at all) still fails, so a silent collector cannot look green.
- **D-42 (data in its own PR):** The NIST catalogue (several MB) and the imported ITSP catalogues exceed the agent reviewer's diff limit, so the generated catalogue data lands in its own data-only PR (importer output plus `sources.json` and `NOTICE`), reviewed by re-running the importer and comparing hashes, before the integration PR that holds the code. This is the one exception to D-39.
- **D-43 (OSCAL version):** Generated files are stamped OSCAL 1.2.1 and the 1.2.1 per-model JSON Schemas are vendored (oscal-cli 3.2.0 and Trestle 5.2.1 both target 1.2.1; the NIST content v1.6.0 is stamped 1.2.3, a superset that only adds enum values). NIST base catalogue: `oscal-content` v1.6.0 (SP 800-53 Rev. 5.2.0).
- **D-44 (validator and parsers):** ajv 8.20.0 with ajv-formats 3.0.1 (MIT, already in the repository's lockfiles), `strict: false` because OSCAL schemas use untyped `pattern`. Importer devDependencies `parse5` and `yaml` pinned exactly at a release at least two weeks old, each behind a human-verify checkpoint before its first install. The no-status test (D-17) walks every key and every `props[].name`, because OSCAL itself allows a prop named `status`.
- **D-45 (runtime):** `compliance/` is `"type": "module"` TypeScript run by Node's built-in type stripping (Node 24), checked by `tsc --noEmit`; no bundler.
- **D-46 (per-test report):** An opt-in environment variable `NEAR_AI_TEST_REPORT=<path>` makes `scripts/run-tests.mjs` add a JSON (or junit) reporter writing per-test pass, fail, skip and todo; unset, behaviour is unchanged (reporter flags in `NODE_OPTIONS` would also reach nested test runs, so the variable is read by the runner itself).
- **D-47 (tools for the relay image and the package):** Syft 1.57.2 for the image SBOM and Grype 0.122.1 for the scan, each downloaded by exact version and checked by SHA-256; Trivy is not used (its action and binary were compromised on 2026-03-19). The image scan runs in its own report-only job, not inside the required `relay` job. `oscal-cli` 3.2.0 from Maven Central, checked by SHA-256, on Java 11 or later. Attestations through `actions/attest` (v4) in a dedicated job with `id-token: write`, `attestations: write`, `contents: read`; CodeQL through `github/codeql-action` v4; all actions pinned by SHA.
- **D-48 (keep it out of the VSIX):** `compliance/` and `docs/security/` are added to `.vscodeignore` and to the forbidden patterns in `scripts/verify-release-content.mjs`, so none of it ships in the extension.
- **D-49 (word lint scope):** The official control text itself uses "compliant", "accredited" and "certified", so the output lint (D-27) scans only our own fields (statements, reasons, remediation, page copy, README) and never quoted official text.
- **D-50 (docs-site serving):** Pages are `.mdx` docs importing React components (the site has no pages plugin). `serve.mjs` serves `build/` on every request, so `compliance:refresh` writes the JSON to both `static/compliance/` and `build/compliance/`. The organization overlay is read through a loopback-only, read-only `serve.mjs` endpoint enabled only when a local overlay path is set; the static build never contains it. `gh attestation` needs a newer `gh` than some hosts have, so `compliance:refresh` says plainly when it cannot verify the attestation and treats the bundle as unverified (never as verified).

### Claude's Discretion
- Exact file names inside `compliance/src/`, the JSON shape of the dashboard file, and React component structure.
- Which JSON Schema validator, SBOM generator and image scanner are pinned, chosen by the research step on licence, maintenance and supply-chain record.
- How collectors are grouped into plans, as long as plans in one wave share no files.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Designs
- `.planning/research/compliance-dashboard/DESIGN.md` - the whole design: sources, licence, OSCAL, levels, responsibility, collectors, status rules, pages, package, CI, security, gaps G1 to G13, requirements ACCR-01 to ACCR-12.
- `.planning/research/compliance-dashboard/CGP-ITAR.md` - sections 10 to 14: overlays, honesty rules, gaps X1 to X12, interim settings, ACCR-13 and ACCR-14.
- `.planning/research/coherence/GLOSSARY.md` - section 5 (the copy lint rules, including the compliance claim) and the level wording.

### What exists to build on
- `src/test/helpers/copyLintScan.ts` (`COMPLIANCE_CLAIMS`, negation rule) and `src/test/copyLint.test.ts` - read only, the parity source for D-27.
- `.github/workflows/ci.yml` (jobs lint, test, release-content, audit, secret-scan, docs, relay, hub), `.github/workflows/release.yml` (build, release, publish), `.github/workflows/agent-review.yml`.
- `scripts/run-tests.mjs`, `scripts/secret-scan.mjs`, `scripts/extension-sbom.mjs`, `scripts/lib/workflow.mjs`, `scripts/test/workflow-files.test.mjs`.
- `docs-site/` (sidebars.js, scripts/sync-docs.mjs, scripts/serve.mjs, the user service), `docs/development-workflow.md` section 8 (branch protection, the owner's steps), `SECURITY.md` (known limitations, reporting).
- `.planning/phases/41-organization-policy-foundation-f1/41-CONTEXT.md` and `41-VERIFICATION.md` (the architecture test, copy lint baseline, authorizations), `.planning/phases/32-your-organizations-sync-hub/` (hub CI job).
</canonical_refs>

<code_context>
## Existing Code Insights

- The extension's copy lint scans `package.json`, `src/**` and `media/**` only, not `docs-site/` or `compliance/`, and its `ALLOWED_CLAIM_CONTEXTS` is empty and waiting for Phase 44; with D-27 it can stay empty.
- `docs-site/scripts/sync-docs.mjs` renders `docs/**/*.md`, SECURITY.md and other tracked Markdown into the site, so new documents under `docs/security/` appear without site changes.
- The `docs` CI job builds the site and fails on a broken link; it is not a required check yet.
- The relay job builds the image and runs `test:container`; it has no SBOM or scan.
- `release.yml` carries SHA-256 checksums from build to publish and refuses to change an existing release; it has no attestations.
- Actions are pinned by SHA with version comments; workflow hardening is tested in `scripts/test/workflow-files.test.mjs`.
</code_context>

<specifics>
## Specific Ideas

- Success criterion 2 is a real experiment in the verification plan: a fixture PR state with a mapped test removed shows the control drop to Not met in the summary; a fixture bundle with an audit result 25 hours old shows Stale.
- Success criterion 4 is checked by running the pinned `oscal-cli` on the package in CI and importing it with Trestle in a throwaway CI step (pinned, no install scripts beyond what Trestle needs, in its own job), not as a build dependency.
</specifics>

<deferred>
## Deferred Ideas

- In-extension organization view on `authorizations[]` (after Phase 41).
- OpenSCAP evidence for the appliance; Phase 25 harness findings as evidence; the Classified page's full content when L1b is planned.
- Turning the `compliance` job blocking (D-07), and making it a required check, after it has been stable.
</deferred>

## For the owner to confirm (one line each; recommended choice first)

1. D-11/D-12: licence gate; store text only for sources whose open licence is re-checked at import (ITSP.10.033 family, ITSG-33, NIST, DPA and CGR, CFR); ids and links only for CAN/DGSI 104, the small-organization baseline, CPCSC Level 1 and PSPC or Treasury Board pages.
2. D-13: French text imported beside English; French moves to a POA&M item if its pages do not parse cleanly.
3. D-22: per-test results through an opt-in report from `scripts/run-tests.mjs` (default behaviour unchanged).
4. D-27: reuse the Phase 41 compliance-claim phrase list through a parity test instead of a second list; no `src/` change.
5. D-33: all workflow changes in one plan, last, so one gate approval covers them.
6. D-34: CodeQL for static analysis; scanner and SBOM tool for the relay image picked by research, pinned and checksummed.
7. D-36: CODEOWNERS for gate paths and `compliance/` sources; the owner makes `docs` a required check.
8. D-37: G1, G9, X8 and X12 documents under `docs/security/` and a supported-versions table in `SECURITY.md` (documentation outside the four code folders).
9. D-39: one integration branch and one integration PR.
10. D-40: statements first where evidence exists; every other control shown honestly as Not met or your organization's responsibility.
11. D-41: reporting jobs never fail on findings (continue-on-error), because the merge and tag checks refuse any failed check.
12. D-42: catalogue data in its own data-only PR before the code PR.
13. D-43/D-44: OSCAL 1.2.1 schemas, NIST content v1.6.0, ajv 8.20.0; parse5 and yaml as importer devDependencies after a human check.
14. D-47: Syft and Grype pinned by checksum, in a report-only job; no Trivy.
15. D-48: compliance/ and docs/security/ kept out of the VSIX.
16. D-50: overlay through a loopback read-only endpoint of the local docs server; unverified bundles shown as unverified.
17. Protected B page lists every profile row (Selected and organization-wide); the 12 English and French profile differences are listed on the page and sent to the Cyber Centre by the owner.
18. ITSG-33 Annex 3A to ITSP.10.033 crosswalk generated by us from the NIST mapping and marked as ours (no official one exists).
19. The daily bundle is hashed but not attested; only release packages are attested.

---

*Phase: 44-accreditation-evidence-and-compliance-dashboard*
*Context gathered: 2026-11-21*

## Owner decisions (2026-11-21)

The owner accepted every default listed above, and explicitly confirmed the three that are hard to undo:

1. **Government text in the public repository:** control text is stored only for sources whose open licence is re-checked at import (ITSP.10.033 and -01, ITSP.10.171 and -01, ITSG-33, ITSP.50.103, the small-organization baseline, NIST, the Controlled Goods law and regulations, and the US CFR text); CAN/DGSI 104, CPCSC Level 1 and the PSPC and Treasury Board pages are ids and links only.
2. **Attestation scope:** only release packages are attested.
3. **Risk acceptances:** the existing signed-payload format with purpose `compliance-risk-acceptance`, with no signers listed at first.
