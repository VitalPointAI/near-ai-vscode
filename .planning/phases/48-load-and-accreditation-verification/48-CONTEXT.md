# Phase 48: Load and accreditation verification - Context

**Gathered:** 2026-11-23
**Status:** Decided on the owner's behalf from the hosting design; nobody was available for questions. Decisions the design or the owner already settled are marked (owner). Open points took the design's default or the recommended option and are listed under "For the owner to confirm" with the default the plans use.
**Source:** ADR Ingest Express Path (`.planning/research/multiuser-hosting/DESIGN.md`, format narrative). The GSD ingest parser returned 0 decisions for DESIGN.md because its decisions are tables, so this file was written by hand from DESIGN sections 2, 4, 7, 10, 12, 13 and 14, `RESEARCH.md` sections 2 and 7, the Phase 48 entry in `.planning/ROADMAP.md`, the Phase 44 compliance package (`compliance/`) and `44-CONTEXT.md`, on `origin/docs/phases-46-48-plan` at 2fca5dc9.

<domain>
## Phase Boundary

Phase 48 makes every capacity and compliance statement about the hosted workbench rest on collected evidence:

- **A repeatable load test on our own hardware** to 1,000 or more concurrent Theia Cloud sessions. It records session start time, steady-state resource use per person, operator throughput under start bursts of 500+, the shared Ingress object's size and reload behaviour, etcd load per session, and sync hub load under the same run. Capacity figures in docs come only from a recorded run. (DESIGN 12 row 1, 13(e))
- **OSCAL component definitions and evidence rules for every component of Phases 46 and 47**, so the Phase 44 compliance dashboard shows the hosted deployment's real state from collected evidence, never assumed. Every section 10 condition becomes a statement with an evidence rule, or a recorded gap. (DESIGN 10)
- **The open verification items of DESIGN section 12 closed** with evidence, or recorded as a gap with an owner and a date: Keycloak CVE-2026-6856 fix version; HSM FIPS 140-3 and Go FIPS module certificate status; Traefik with Theia Cloud; the prewarm pool and how a person's volume attaches at claim; and the rest of that table. (DESIGN 12)

Not in this phase: building the product changes (Phase 46: P1 to P5, P8, P9, P11, the image build of P10) or the deployment stack, charts, realm and policy as code, offline bundle and runbooks (Phase 47); fixing what the load test finds beyond recording it as a gap with a phase (fixes go to the phase that owns the code); any commercial-cloud environment; any change to the status engine's rules (Phase 44 D-17, D-18).
</domain>

<decisions>
## Implementation Decisions

### Accepted from the design (owner)
- **D-01 (owner, D2):** On-premise only. The load test runs on our own hardware; no commercial cloud, no managed Kubernetes, no cloud load generator.
- **D-02 (owner, D3):** Target is 1,000 or more concurrent sessions per site, with start bursts of 500+.
- **D-03 (owner, D4):** One session per person (`sessionsPerUser: 1`), one pod per session; the test exercises that configuration, not a denser one.
- **D-04 (owner, D9):** Nothing counts toward any claim until it is in `compliance/` and assessed. Section 10 verdicts are starting points, not results.
- **D-05 (owner, O2):** HAProxy is the ingress until Traefik is tested. The Traefik test is in this phase; its result changes the default only if the owner then chooses to.
- **D-06 (owner, O5):** Theia Cloud pinned upstream; fork only if needed. The load test runs the exact pinned (or our rebuilt) commit Phase 47 deploys.
- **D-07 (owner, O6):** Workspace volume size and idle timeout per site are set after the load test; this phase supplies the measured inputs and a default per site size class.
- **D-08 (design 7):** The prewarm pool stays at 0 until this phase shows how a pooled pod gets the person's workspace volume at claim, and only if cold start is unacceptable.

### Honest evidence (invariants, not judgements)
- **D-09:** No capacity number appears in docs, the dashboard or a release note unless it is read from a recorded load-test run file (inputs, hardware description, image digests, chart versions, raw measurements, hash). A check refuses hand-typed figures. Design estimates (DESIGN 7 "Capacity") stay marked as estimates until replaced.
- **D-10:** A run that did not reach a stage records the stage it reached and why; nothing is extrapolated to a stage not reached.
- **D-11:** Phase 44 fail-closed rules hold unchanged: Met needs a statement, an evidence rule per statement and a fresh passing result per rule; a silent collector cannot look green (44 D-41); since #160 every in-scope component of a level is assessed and one with no statement shows "No statement yet". New components are put in scope from the start so their gaps are visible.
- **D-12:** Statements describe only behaviour that exists in the assessed release and deployment. A component whose Phase 47 work has not landed gets a definition with no statements, not anticipatory prose.
- **D-13:** Evidence holds only ids, counts, hashes, run addresses, times and pass or fail (44 D-24). Deployment evidence (Keycloak events, OpenBao audit, Kubernetes audit, registry audit) is summarized by a collector into counts and pass or fail; raw logs, tokens and personal details never enter the bundle.

### Evidence sources
- **D-14:** Three kinds of evidence, in this order of preference: (a) test rules on Phase 46 and 47 tests that run in CI (for example: the realm as code has no password or OTP authenticator; oauth2-proxy values have TLS verify on and secure cookies; OpenBao policies are templated per person); (b) observation rules from new collectors that read a deployment evidence export produced on a running site; (c) documents and attestations for what only a person can check (certificate numbers, key ceremony record), on the 365-day window.
- **D-15:** The reference site is the load-test rig. It is the deployment whose real state the public dashboard shows for hosted components; a customer site's state shows only in that organization's local overlay view (44 D-10).
- **D-16:** The deployment evidence export is a signed, hashed JSON file produced by a script that runs on the site and read by collectors offline. Collectors never call into a site over the network from CI.

### Component scope (assumed from Phase 47; reconcile names)
- **D-17:** Component ids are the file names under `compliance/components/`, which `scripts/resource-check.mjs` also uses to validate `resources.json` entries, so Phases 47 and 48 share this list. Assumed:
  - From Phase 46 (product): `workbench` (the Sterling workbench image: key store P3, key service P4, session identity P5, egress P8, Node P11); the existing `release-pipeline` re-assessed for the image (P10: digest, signature with your organization's key, CycloneDX SBOM, attestations).
  - From Phase 47 (deployment): `rke2`; `image-registry` (Harbor at large sites, Zot at small ones); `ingress` (HAProxy; RKE2 Traefik as a tested variant); `cert-manager`; `keycloak` (its Postgres is part of this component); `theia-cloud` (operator, service, landing page, webhook); `oauth2-proxy` (the session sidecar); `openbao`; `hsm` (a FIPS 140-3 Level 3 model; SoftHSM2 on lab rigs proves wiring only and is never evidence for a FIPS claim); `site-storage` (the CSI storage class); `site-logging` (a log store that is not AGPL, by owner decision; Loki is not chosen); `offline-bundle` (the signed bundle and its import checks); and the existing `hub` re-assessed for Kubernetes, several hubs per site and certified session keys.
  - This is the same id list Phase 47 uses (coordinated 2026-11-23). Until this phase adds `workbench`, Phase 46 files its new resources under `extension`; this phase moves them.
  - Phase 47 extends `scripts/resource-check.mjs` with a `chart` resource kind; this phase maps chart entries to components and does not change that script.
  - If Phase 47 needs a component id before this phase's file exists, whichever phase lands first creates the definition file with no statements; the other extends it, and the second to land reconciles names.
- **D-18:** Hosted components go into a separate hosted-deployment scope rather than into the existing product levels, so the extension's pages do not change meaning. Default: new `levels.json` entries for Protected A and Protected B (and their overlays) whose `components` are the hosted components plus `workbench`, `release-pipeline` and `hub`. Research checks the dashboard and levels loader support this without a status-engine change. (Gate path: owner approval.)

### Load test
- **D-19:** The load test is code in this repository, in its own folder with its own lockfile and exact versions, and every new tool has a compliance fit entry. It drives sessions through Theia Cloud's service API with tokens from a load-test-only Keycloak client in a test realm on the rig, and opens a sampled share of sessions in a real browser through a WebAuthn virtual authenticator to measure time to a usable workbench. The production realm keeps passwords and every non-WebAuthn flow off; the test realm is never in the offline bundle.
- **D-20:** Stages: 50, 250, 500, 1,000, then above 1,000 while the rig allows. Each stage holds steady state long enough to measure per-person use, then a burst of 500+ starts. The run file records every stage reached.
- **D-21:** Load per person is a scripted, versioned activity profile (open files, edit, run a terminal command, an idle share). An empty idle session is reported separately and never presented as the per-person figure.
- **D-22:** Metrics come from the site's own metrics store and the Kubernetes API, not the load generator's estimates; the run file stores the queries used.
- **D-23:** The sync hub is measured under the same run against its 150-people-per-hub target (MUS 10.9), with several hubs per site.

### Verification items (DESIGN 12)
- **D-24:** Desk items (Keycloak CVE-2026-6856 fix version, HSM model certificate numbers, Go FIPS module CMVP status, UBI 9 OpenSSL FIPS provider certificate, Harbor and Zot FIPS builds, the Theia 1.77 Node range if Phase 46 has not closed it) are closed by a dated record with the source address and what it says, as document evidence on the 365-day window. If not confirmable, the item becomes a gap with an owner and a date.
- **D-25:** Rig items (Traefik with Theia Cloud, prewarm pool with personal volumes, cold-start time, step-up re-authentication through the sidecar, `kms-pkcs11` against the chosen HSM, large CRL refresh) are closed by a recorded experiment on the rig, or by a gap with owner and date when the hardware is not available.
- **D-26 (amended 2026-11-23, owner: phone passkeys first):** Items the design already decided (sign-in strength is the site setting `signInKeys`: `passkeys` accepts any passkey including synced phone passkeys, `hardware-only` requires attestation, an AAGUID allowlist and device-bound keys, so synced passkeys fail it; `passkeys` is the default for development and the lab, `hardware-only` the recommended production setting; one shared relying-party ID, O3) are recorded with the evidence rule that proves the configuration of each level, not reopened. Which level a site runs is that site's setting; the register says `hardware-only` is recommended for defence production and that cross-device (hybrid QR) passkey sign-in needs an Apple or Google internet relay, so it is unavailable air-gapped. HSM items are unaffected.

### Gate paths
- **D-27:** `compliance/src/`, `components/`, `evidence-rules/` and `levels.json` are gate paths (owner approval). Plans that change them end with an owner checkpoint, and gate-path changes land in as few pull requests as possible (44 D-33 pattern).

### Claude's Discretion
- Load generator choice, run-file schema and where the harness lives, within D-19 to D-22.
- How collectors are grouped and how the deployment export is signed, within D-13 to D-16.
- Wave split, as long as evidence-rule work for a component starts as soon as Phase 47 chooses that component.
</decisions>

<requirements>
## Requirements (VER-01 to VER-09)

- **VER-01:** A repeatable load test, kept as code, runs on our own hardware against the Phase 47 stack and the Phase 46 image by digest, in stages to 1,000 or more concurrent sessions with start bursts of 500+.
- **VER-02:** Each run writes one hashed run file with inputs, hardware, image digests and chart versions, and per stage: session start time (p50, p95, p99; cold, and warm if a pool is tested), steady-state CPU and memory per person under the activity profile, operator reconcile throughput, shared Ingress object size and ingress reload time, etcd size and load per session, and load per hub.
- **VER-03:** Capacity figures in docs and the per-site sizing defaults (volume size, idle timeout, memory per person) are read from a run file; a check refuses a capacity figure without one; a stage not reached is reported as not reached.
- **VER-04:** Every component of Phases 46 and 47 has an OSCAL component definition with one responsibility per implemented requirement and statements only for behaviour that exists.
- **VER-05:** Every statement has an evidence rule: a test rule on a Phase 46 or 47 test, or an observation rule from a deployment collector; missing, stale or silent evidence is never Met.
- **VER-06:** Deployment collectors read a signed deployment evidence export from a site (Keycloak realm and events, OpenBao configuration and audit device, Kubernetes audit policy on Session and Workspace records, registry signature enforcement and audit, image signature, SBOM and provenance) and emit only ids, counts, hashes, times and pass or fail.
- **VER-07:** The dashboard shows the hosted deployment's scope per level from collected evidence: the reference site publicly, a customer site only in its local overlay view.
- **VER-08:** Every DESIGN section 10 condition maps to a statement with an evidence rule, or a gap with remediation, owner and phase.
- **VER-09:** Every DESIGN section 12 item is closed with dated evidence (desk record or rig experiment) or recorded as a gap with an owner and a date; the Traefik and prewarm results change O2 and the pool default only through the owner.
</requirements>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Designs
- `.planning/research/multiuser-hosting/DESIGN.md` - sections 4, 7, 10, 11, 12, 13 and 14.
- `.planning/research/multiuser-hosting/RESEARCH.md` - section 2 (Theia Cloud scale concerns, EduIDE prewarm, TUM scale tests) and section 7 (per-component compliance fit).
- `.planning/research/compliance-dashboard/DESIGN.md` - collectors, status rules, gaps, organization overlay.

### Compliance machinery (Phase 44)
- `compliance/README.md`, `compliance/levels.json`, `compliance/components/*.json`, `compliance/evidence-rules/*.json`, `compliance/schemas/evidence-rule.schema.json`, `compliance/resources.json`, `compliance/schemas/resources.schema.json`, `scripts/resource-check.mjs`.
- `compliance/src/collectors/types.ts` and existing collectors (`documents.ts`, `attestations.ts`, `sbom.ts`, `release.ts`); `compliance/src/components.ts`, `dashboard.ts`, `status.ts`, `model.ts`, `gaps.ts`.
- `.planning/phases/44-accreditation-evidence-and-compliance-dashboard/44-CONTEXT.md` - D-09, D-17 to D-25, D-33, D-41.
- `.planning/phases/44.1-accreditation-control-implementation-and-evidence-closure/` - product vs inherited vs sponsor evidence, deployment submission.

### Sibling phases (planned in parallel; reconcile names)
- `.planning/phases/46-*/` and `.planning/phases/47-*/` once their plans land.
</canonical_refs>

<code_context>
## Existing Code Insights

- Component ids are the file names in `compliance/components/`; `scripts/resource-check.mjs` rejects a `resources.json` entry whose `component` has no file.
- `levels.json` lists `components` per level; the dashboard assesses every in-scope component for every control (#160), so a component without statements shows "No statement yet": the honest start.
- Existing components: `extension`, `hub`, `relay`, `release-pipeline`, `model-endpoints`, `appliance`. Evidence rules are `test` (file plus exact literal test name) or `observation` (collector plus subject).
- Collectors share one interface (`Collector`, `CollectorContext` with injected `readFile` and `fetchJson`), so a deployment collector can read an export file with fixture tests and no network.
- The VSIX SBOM path in the evidence bundle moves to image evidence under P10 (DESIGN 10); `release-pipeline` rules change with it.
- Heavy runs are capped with `systemd-run --user --scope -p MemoryMax=4G ... choom -n 1000 timeout` (Phase 44 verify commands).
</code_context>

<specifics>
## Specific Ideas

- Success criterion 1: a run file from the rig that reached the 1,000 stage, and a docs check that fails when a capacity figure lacks a run id.
- Success criterion 2: the dashboard JSON for the hosted scope lists every hosted component, every row's state traces to a rule and a collected result, and a fixture export with a lapsed audit shows Stale.
- Success criterion 3: a verification register (one row per DESIGN 12 item), each row closed with an evidence reference or a gap in `compliance/gaps.json` or the POA&M with owner and date.
</specifics>

<deferred>
## Deferred Ideas

- Multi-site and HQ-to-edge load (federation, sealed bundles under load) until L5 federation exists.
- Continuous performance regression on every release; this phase delivers a repeatable manual or scheduled run on the rig.
- A fork of the Theia Cloud operator or a KubeSpawner-style broker; only if the load test shows the operator cannot reach the target (recorded as a gap with a phase).
</deferred>

<scope_fence>
## Scope Fence

- Write: `compliance/components/`, `compliance/evidence-rules/`, `compliance/src/collectors/` (deployment collectors) and the small registrations research found in `compliance/src/` (`rules.ts` observation window, `bundle.ts` collector list, `controlText.ts` hosted level ids) with their tests, a trust file for site export keys, `compliance/levels.json`, `compliance/gaps.json` and POA&M, `compliance/resources.json` (load-test tools only), the load-test harness folder, docs pages for capacity and the verification register.
- Read only: `src/`, `hub/src/`, the Phase 46 workbench package, Phase 47 charts and `scripts/resource-check.mjs` (their tests are mapped, not changed).
- Never: hand-written capacity numbers; a status in any source file; statements for behaviour not yet built; a commercial cloud environment.
</scope_fence>

## For the owner to confirm

1. **Test-rig hardware.** Default: our own rack sized from the design estimate for the top stage (DESIGN 7: about 1 to 2 GiB and 0.25 to 1 vCPU per session, so roughly 1.2 to 2.2 TiB worker memory and 300 to 1,000 vCPU for 1,000 sessions, plus platform overhead), 3 control-plane nodes with fast local disks for etcd, an encrypted storage class, and one HSM if available. Until that exists, run the stages the available hardware reaches and record the rest as not reached (D-10).
2. **Hosted scope in `levels.json` (D-18).** Default: separate hosted-deployment entries; alternative: add hosted components to the existing levels.
3. **Reference site as the public evidence source (D-15).** Default: the rig is the public reference site; customer sites only in local overlays.
4. **Test realm with a load-test client (D-19).** Default: on the rig only, never in the bundle; the production realm keeps every non-WebAuthn flow off.
5. **HSM model for the `kms-pkcs11` test.** Default: whichever FIPS 140-3 Level 3 model your organization buys; until then SoftHSM2 proves the wiring only and the certificate item stays a gap with owner and date.
6. **Load-test tool registration.** `scripts/resource-check.mjs` scans a fixed list of package files, so a `loadtest/package.json` would go unregistered. Default: the harness is a dependency-free Node script; its browser sample reuses the Playwright release Phase 46 pins and registers; no change to the script here (Phase 47 already extends it with a `chart` kind). If a dependency is needed, the one-line `PACKAGE_FILES` addition goes in this phase's single gate pull request with owner approval.
7. **Deployment export freshness and signing key.** Default: the 7-day `settings` window; signed with a dedicated site operator key listed in a new trust file (a gate path), not an OpenBao Transit key.
8. **Cold-start threshold.** Default: p95 time to a usable workbench under 60 seconds at the 1,000 stage; above that, the prewarm pool experiment decides whether the pool turns on.
</content>
</invoke>
