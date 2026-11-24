# Phase 48: Load and accreditation verification - Research

**Researched:** 2026-11-23
**Domain:** Load testing a Theia Cloud deployment on our own hardware; extending the Phase 44 compliance machinery (OSCAL components, evidence rules, collectors, levels) to a hosted deployment; closing DESIGN section 12 verification items with dated evidence.
**Confidence:** MEDIUM-HIGH. The compliance machinery was read in full and the hosted-scope behaviour was run in a scratch copy (HIGH). The Theia Cloud service, operator and chart facts were read from source (HIGH). Certificate facts were read from NIST CMVP pages and go.dev (HIGH where marked). Ingress reload metrics, load-generator sizing and Phase 46/47 final names are LOW or MEDIUM and are marked.

## Provenance tags used

`[VERIFIED: x]` read or run this session from the named file, page or command. `[CITED: url]` taken from an official page without a second check. `[ASSUMED]` training knowledge, an absence of evidence, or inference; listed in the Assumptions Log. In-repo discrete values carry a path, line range and a verbatim quote. A claim that rests on something being absent (no FIPS build found, no volume handling found) is `[ASSUMED]` by rule even when a search was run.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

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
  - From Phase 47 (deployment): `rke2`; `image-registry` (Harbor at large sites, Zot at small ones); `ingress` (HAProxy; RKE2 Traefik as a tested variant); `cert-manager`; `keycloak`; `keycloak-postgres`; `theia-cloud` (operator, service, landing page, webhook and the `oauth2-proxy` sidecar); `openbao` (with the HSM, or SoftHSM2 on lab rigs, which is never evidence for a FIPS claim); `site-storage` (the CSI storage class); `site-logging` (a log store that is not AGPL; Loki is not chosen); the existing `hub` re-assessed for Kubernetes, several hubs per site and certified session keys.
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
- **D-26:** Items the design already decided (synced passkeys mean device-bound where policy says hardware only; one shared relying-party ID, O3) are recorded with the evidence rule that proves the configuration, not reopened.

### Gate paths
- **D-27:** `compliance/src/`, `components/`, `evidence-rules/` and `levels.json` are gate paths (owner approval). Plans that change them end with an owner checkpoint, and gate-path changes land in as few pull requests as possible (44 D-33 pattern).

### Claude's Discretion
- Load generator choice, run-file schema and where the harness lives, within D-19 to D-22.
- How collectors are grouped and how the deployment export is signed, within D-13 to D-16.
- Wave split, as long as evidence-rule work for a component starts as soon as Phase 47 chooses that component.

### Deferred Ideas (OUT OF SCOPE)
- Multi-site and HQ-to-edge load (federation, sealed bundles under load) until L5 federation exists.
- Continuous performance regression on every release; this phase delivers a repeatable manual or scheduled run on the rig.
- A fork of the Theia Cloud operator or a KubeSpawner-style broker; only if the load test shows the operator cannot reach the target (recorded as a gap with a phase).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| VER-01 | A repeatable load test, kept as code, runs on our own hardware against the Phase 47 stack and the Phase 46 image by digest, in stages to 1,000 or more concurrent sessions with start bursts of 500+. | Service API drives sessions (section "Load test: how to drive Theia Cloud"); zero-dependency Node orchestrator plus one Playwright browser sample; stage controller; hardware is the schedule risk (Environment Availability). |
| VER-02 | Each run writes one hashed run file with inputs, hardware, image digests and chart versions, and per stage: session start time (p50, p95, p99; cold, and warm if a pool is tested), steady-state CPU and memory per person under the activity profile, operator reconcile throughput, shared Ingress object size and ingress reload time, etcd size and load per session, and load per hub. | Run-file outline; every metric derived from Kubernetes objects, Prometheus and the shared Ingress object (section "Measurement sources"); the operator exposes no metrics, so reconcile throughput is derived from object timestamps. |
| VER-03 | Capacity figures in docs and the per-site sizing defaults (volume size, idle timeout, memory per person) are read from a run file; a check refuses a capacity figure without one; a stage not reached is reported as not reached. | Generated `docs/hosting/capacity.md` plus a docs test in `docs-site/test/` (not a gate path); no false positives found in today's docs. |
| VER-04 | Every component of Phases 46 and 47 has an OSCAL component definition with one responsibility per implemented requirement and statements only for behaviour that exists. | A component file with no statements loads and validates (run in scratch); loader enforces exactly one responsibility per implemented requirement; existing `components.test.ts` hard-codes the six ids and must be edited. |
| VER-05 | Every statement has an evidence rule: a test rule on a Phase 46 or 47 test, or an observation rule from a deployment collector; missing, stale or silent evidence is never Met. | Rule schema and evaluators read; `checkRuleTargets` makes a rule on a test that does not exist fail an existing test, so statement and rule land together once the test exists. |
| VER-06 | Deployment collectors read a signed deployment evidence export from a site and emit only ids, counts, hashes, times and pass or fail. | One `deployment` collector using `verifyEnvelope` from `signed.ts`; `redactObservation` allow-list; a window entry in `rules.ts` is required or evidence never ages. |
| VER-07 | The dashboard shows the hosted deployment's scope per level from collected evidence: the reference site publicly, a customer site only in its local overlay view. | Separate hosted levels work with no status-engine change (run in scratch). The organization overlay cannot carry product evidence (`mergeOverlay` skips non-"your-organization" rows); the customer path is a local bundle built from their own export and refreshed with `--from-dir`. |
| VER-08 | Every DESIGN section 10 condition maps to a statement with an evidence rule, or a gap with remediation, owner and phase. | Section 10 traceability table below (condition, component, evidence kind, controls). |
| VER-09 | Every DESIGN section 12 item is closed with dated evidence (desk record or rig experiment) or recorded as a gap with an owner and a date; the Traefik and prewarm results change O2 and the pool default only through the owner. | Draft verification register with findings from this session (Keycloak, Go FIPS, HSM, UBI 9, Theia Node range closed at the desk; the rest rig-pending or gaps). |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

No `./CLAUDE.md` or `./.claude/CLAUDE.md` exists in the worktree (only `.claude/commands/`). The user's global instructions and memory apply and are treated with the same authority as locked decisions:

- **Capped heavy runs:** always `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 300 ...`; one heavy run at a time (memory note "Cap test memory").
- **Lean implementation:** every change traces to a requirement; tests only for new logic, reproduced bugs, or security, authorization, privacy, money and data-integrity boundaries; extend existing tests and mechanisms instead of adding files, frameworks or scanners.
- **Verification cadence:** smallest relevant checks after an edit; full suite once at the phase boundary; security, data-integrity and architectural-boundary checks block immediately.
- **Vocabulary:** "your organization", never "NEAR organization"; NEAR AI is only the provider (memory "Organization naming"). Sterling and SovAI are the product names in the Theia edition.
- **Parallel by default:** independent pieces run in separate worktrees; sequence only on a real dependency (stated in the Wave guidance below).
- **Gate paths need the owner:** `scripts/lib/workflow.mjs` lines 595-619 list them (see Sources); the memory note "Send gate approval links" applies when a PR waits on the owner.
- **Delete nothing without asking;** NEAR key rules do not touch this phase.

## Summary

Phase 48 has three tracks that share almost no files and can run in parallel: (1) the **compliance track** (hosted levels, component definitions, evidence rules, one deployment collector), most of which lands in gate paths; (2) the **load-test track** (a new `loadtest/` folder, run files, a generated capacity page and a docs check), none of it in a gate path; (3) the **verification track** (a dated desk-records document, gaps and POA&M items, rig experiments). The one hard external dependency is hardware: the 1,000-session stage needs a rig the owner has not yet described, and this dev machine (16 cores, 28 GiB) is nowhere near it. The plan must treat "stage not reached" as a normal, recorded result (D-10) and must not let the schedule wait on the rig for the other two tracks.

**The compliance machinery needs no status-engine change for a separate hosted scope.** I added a no-statement `keycloak` component and a `hosted-protected-b` level (same Protected B profile, components `keycloak`, `hub`, `release-pipeline`) to a scratch copy and ran the real `bundle` command: it built and validated, produced 417 rows for the hosted level, and the Keycloak row read `not-met` with reason `no-statement`. Four small gate-path edits are still needed: a window entry for the new collector in `rules.ts` (without it a new collector's evidence is judged "at the head commit" and never goes stale), the collector registration in `bundle.ts`, the new level ids in `controlText.ts` (otherwise hosted rows show control ids instead of titles and have no text drawer), and the exact id list in `compliance/test/components.test.ts`. The honest consequence: every in-scope component must carry a statement (or a reviewed Not-applicable record) for a control before that control can read Met, so the hosted levels will read mostly "Not met / No statement yet" for a long time. That is the intended honest start, but the plan should say so up front and not add bulk Not-applicable tailoring to make numbers look better.

**Deployment evidence fits the existing signed-payload machinery.** A site export is an Ed25519 envelope in the extension's signed-payload format, verified with the existing `verifyEnvelope` against a trust list in a new gate file beside `attestations/signers.json`. The collector sets each observation's `collectedAt` from the signed generation time (as the documents collector does with review dates), so a lapsed export goes Stale instead of reading current. The collector derives pass or fail from counts under thresholds held in collector source, so a changed site script cannot weaken a check. The public dashboard reads one committed signed export (non-gate folder); a customer builds a local bundle from their own export and trust list and refreshes their local docs site with the existing `--from-dir` option.

**Load driving is plain REST, so the load generator is not the hard part.** Theia Cloud's service enforces that the request's `user` equals the authenticated user, so the harness needs one test-realm identity per simulated person. The expensive and non-obvious parts are: representative per-person load (a session with no connected frontend is not representative and may be reaped by the idle monitor), the single shared Ingress object that the operator edits for every session (etcd's request limit is 1.5 MiB), a single leader-elected operator with no metrics endpoint, the 110-pods-per-node default, and per-person volumes that cannot be prewarmed. A zero-dependency Node orchestrator plus Playwright (Apache-2.0) for the browser sample is the leanest fit. k6 is AGPL-3.0 and is not needed.

**Primary recommendation:** Land one early gate PR that puts the hosted levels, empty component definitions, the `deployment` collector and its window and registration in scope (so gaps are visible from day one), build the `loadtest/` harness and desk records in parallel in non-gate folders, add statements and rules per component only when the Phase 46 or 47 behaviour and its test exist, and close DESIGN section 12 with the dated records drafted below.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Driving sessions, bursts, stage control | Load-generator host (on the rig network) | Rig cluster | Plain REST to the Theia Cloud service; needs only network reach and a test-realm client. |
| Time to a usable workbench (sample) | Load-generator host (Chromium) | Rig cluster | Only a real browser proves the workbench renders; limited by generator memory, so it is a sample. |
| Per-person CPU and memory, etcd, ingress, operator timing | Rig cluster (Prometheus and Kubernetes API) | Load-generator host (collects and hashes) | D-22: the cluster's own metrics, not the generator's estimates. |
| Run file, hash, capacity page, docs check | Repository (`loadtest/`, `docs-site/test/`) | CI (docs job) | Capacity figures must be traceable to a committed hashed file. |
| Deployment evidence export | Rig cluster (script on the site, key held by the operator) | Repository (signed file committed) | D-16: collectors read a file offline and never call into a site. |
| Signature check, freshness, pass or fail derivation | Compliance package (collector) | CI (`compliance` job) | Thresholds live in gate-path source so the site script cannot weaken them. |
| Hosted scope, components, statements, rules | Compliance data (`levels.json`, `components/`, `evidence-rules/`) | Docs site (pages) | The dashboard computes every state; no source file carries one. |
| Desk records and gaps | Documents (`docs/security/`), `gaps.json`, `poam/` | Documents collector (365-day window) | D-24: dated record with source address; unconfirmed items become gaps. |
| Customer-site view | Customer's own machine (local bundle, local docs site) | — | Never uploaded; the overlay mechanism only covers "your organization" rows. |

## Standard Stack

### Core

| Library or tool | Version | Purpose | Why standard here |
|-----------------|---------|---------|-------------------|
| Node built-ins (`fetch`, `node:crypto`, `node:test`, `node:child_process`) | Node 24 (this machine v24.22.3 `[VERIFIED: node --version]`) | Orchestrator, token minting, run file, hashing, tests | The compliance package already runs on Node 24 with built-in type stripping and no runtime dependencies `[VERIFIED: compliance/README.md:26]` "no runtime dependencies beyond Node built-ins. It runs on Node 24 or later with Node's built-in type stripping; there is no build step." |
| `kubectl` (rig tool, not a repo dependency) | the rig's RKE2 version | Reads Session, Deployment, Pod, Ingress objects and `--raw` metrics | Reads the cluster's own records (D-22); invoked with `execFile`. Licence `[ASSUMED]` Apache-2.0. |
| Prometheus HTTP API (`/api/v1/query_range`) | the rig's Prometheus (Phase 47 "site-logging"/metrics) | cAdvisor, kube-apiserver and etcd series | Phase 47 D-19 requires Prometheus-compatible metrics. Prometheus is Apache-2.0 `[VERIFIED: gh api repos/prometheus/prometheus, 2026-11-23]`. |
| `playwright` | pin to the release Phase 46 pins for `workbench/` (npm latest today 1.65.1 `[VERIFIED: npm view playwright version]`) | Browser sample with a CDP WebAuthn virtual authenticator | Apache-2.0 `[VERIFIED: npm view playwright license]`; Phase 46 D-28 already adopts it, so one fit entry and one version. |

### Supporting

| Library | Version | Purpose | When to use |
|---------|---------|---------|-------------|
| `scripts/lib/workflow.mjs` `scanLine` | in repo | Secret scan of run files | Reuse the scanner `redact.ts` already imports `[VERIFIED: compliance/src/redact.ts:4]` "import { scanLine } from '../../scripts/lib/workflow.mjs';" |
| `compliance/src/signed.ts` `canonicalize`, `signingInput`, `verifyEnvelope`, `fingerprintOf` | in repo | Canonical JSON and hash for run files; envelope verification for the site export | Do not write a second canonical form. |

### Alternatives Considered

| Instead of | Could use | Tradeoff |
|------------|-----------|----------|
| Node orchestrator | k6 (Grafana) | AGPL-3.0 `[VERIFIED: gh api repos/grafana/k6 .license.spdx_id = AGPL-3.0, 2026-11-23]`; needs a fit decision for no gain, since the service API is plain REST and the cluster, not the generator, is the bottleneck. |
| Node orchestrator | Locust | MIT `[VERIFIED: gh api repos/locustio/locust]`; adds a Python runtime and its dependency tree to the rig and to the fit register. |
| Node orchestrator + Playwright | Artillery with its Playwright engine (what TUM's scale tests use) | MPL-2.0 `[VERIFIED: gh api repos/artilleryio/artillery]`; TUM's suite uses Playwright, Artillery and TypeScript and "does not mention k6 or Locust" `[CITED: eduide.github.io/Docs/developer/projects/theia-scale-tests]`; the page reports no results, no metrics and no session count reached, only a goal of "hundreds of concurrent IDE instances". It is written against the Java stack and its landing page, so it is a reference, not a base. |
| Playwright browser sample | A headless Theia RPC client | Cheaper per session but undocumented and fragile; a time-boxed spike only (Open Question 6). |

**Installation (load-test folder only):**
```bash
npm --prefix loadtest ci --ignore-scripts
npx --prefix loadtest playwright install chromium   # on a connected prep machine; the rig needs a mirrored browser build
```

**Version verification:** `npm view playwright version` returned 1.65.1 (modified 2026-11-23); `npm view playwright dependencies` shows only `playwright-core` 1.65.1; no postinstall script `[VERIFIED: npm view]`.

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `playwright` | npm | created 2015-01-23 (the seam's "too-new" reason is the age of the latest version, published 2026-11-13) | about 181.9M per week | github.com/microsoft/playwright | SUS | Flagged: planner adds a `checkpoint:human-verify` before the install; resolve by pinning the same release Phase 46 pins for `workbench/` rather than the newest. |
| `playwright-core` (transitive) | npm | same repo | about 202.8M per week | github.com/microsoft/playwright | SUS | Same flag (version-age artefact only). |

`playwright` [WARNING: flagged as suspicious by `gsd-tools query package-legitimacy check` (reason: too-new); verify before using.] Run: `node gsd-tools.cjs query package-legitimacy check --ecosystem npm playwright playwright-core`, 2026-11-23.

**Packages removed due to [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** `playwright`, `playwright-core`.

No other npm package is recommended. Tools that run only on the rig (kubectl, Prometheus, the browser binary) are not npm packages and are discussed under Pitfall 7.

## Architecture Patterns

### System Architecture Diagram

```
 TRACK 1  LOAD TEST (rig)                                     TRACK 2  EVIDENCE (compliance)
 ------------------------                                     -------------------------------
 stage plan (50,250,500,1000,..)                              site (rig) --export script--> signed envelope
        |                                                           (facts: ids, counts, hashes,
        v                                                            versions, generatedAt)
 test-realm Keycloak  --token per user-->  Theia Cloud service           |
 (load-test client,   (user must equal      POST /service/session        v
  test realm only)     token user)           |                    committed file
                                             v                    compliance/site-evidence/<site>.json
                                     operator (leader-elected)             |
                                       Session CR -> Deployment/Pod/       v
                                       Service/ConfigMaps/PVC       collectors/deployment.ts
                                       + edits ONE shared Ingress    verifyEnvelope(purpose, trust list)
                                             |                       derive pass/fail from counts
              +------------------------------+--------+              collectedAt = signed generatedAt
              v                              v        v                     |
        sampled browser              kubectl timeline  Prometheus           v
        (Playwright + CDP            (creation, Ready, (cAdvisor, apiserver, Observation[]  --window 'settings'-->
         virtual authenticator)       url, Ingress      etcd, ingress)       |                  (rules.ts entry)
              |                       size, rules)           |               v
              +----------+-----------------+----------------+         evidence rules (observation / test)
                         v                                             |  statements in components/*.json
                 loadtest/runs/<id>.run.json  (hash, queries,          v
                 hardware, digests, per-stage results, "not reached")  buildDashboard -> hosted levels
                         |                                             (hosted-protected-a / -b)
                         v                                                    |
        docs/hosting/capacity.md (generated)  <-- docs test refuses           v
        sizing defaults (volume, idle, memory)    hand-typed figures    public docs site (reference site)
                                                                        customer: local bundle + --from-dir

 TRACK 3  VERIFICATION: docs/security/hosted-verification-records.md (dated desk records, documents collector,
 365 days) + compliance/gaps.json + poam/ (owner, date) + rig experiments recorded as run files (kind: experiment)
```

### Recommended Project Structure

New files, smallest set. Gate-path files are marked `(gate)`.

```
loadtest/                            # own package.json (playwright only, exact) + lockfile
  README.md                          # tool table (kubectl, Prometheus, browser) and rig run order
  src/service.ts                     # Theia Cloud service client (token, start, stop, list, activity)
  src/keycloak.ts                    # test-realm token minting (direct grant, test realm only)
  src/stages.ts                      # stage controller: hold, burst, record "not reached"
  src/measure.ts                     # kubectl + Prometheus readers; stores the queries it ran
  src/profile.ts + profiles/activity-v1.json   # versioned activity profile
  src/browser.ts                     # Playwright sample with CDP WebAuthn
  src/hub.ts                         # hub load driver (spike; Open Question 7)
  src/runfile.ts                     # schema, canonical hash (signed.ts canonicalize), verify, secret scan
  src/capacity.ts                    # render docs/hosting/capacity.md, sizing defaults, docs check
  test/*.test.ts                     # fixtures: fake service, fake Prometheus, fake kubectl output
  runs/<id>.run.json                 # committed run and experiment files
docs/hosting/capacity.md             # generated from a run file
docs/security/hosted-verification-records.md   # desk records, "Last reviewed:", H2 per closed item
docs-site/test/capacityFigures.test.mjs        # refuses a capacity figure without a run id
compliance/src/collectors/deployment.ts (gate) # + collectorDeployment.test.ts, fixtures
compliance/attestations/site-signers.json (gate)  # trust list for site exports (same shape as signers.json)
compliance/site-evidence/reference.json        # signed export of the rig (NOT a gate path)
compliance/components/<id>.json (gate)         # one file per hosted component
compliance/evidence-rules/hosted-<area>.json (gate)
compliance/levels.json (gate)                  # hosted-protected-a / -b
compliance/gaps.json + poam/*.json             # NOT gate paths
```

Edits to existing files: `compliance/src/rules.ts` (one `OBSERVATION_WINDOWS` entry, gate), `compliance/src/bundle.ts` (add the collector to `COLLECTORS`, gate), `compliance/src/controlText.ts` (add hosted level ids, gate), `compliance/test/components.test.ts` (the exact id list) and `compliance/test/levels.test.ts`, `.github/workflows/ci.yml` (gate: supply the `deployment` input and, if Phases 46 and 47 add packages, their per-package test reports), `compliance/resources.json` (gate: re-point `workbench` entries from `extension`), docs-site accreditation page(s).

### Pattern 1: A separate hosted scope in `levels.json` (no engine change)

**What:** Add level entries that reuse an existing profile and list the hosted components. **When:** from the first gate PR, so "No statement yet" is visible (D-11).
**Verified by running** the bundle command on a scratch copy (Node v24.22.3, 2026-11-23): hosted level `counts` were `met 0, not-met 304, your-organizations-responsibility 113` (417 rows), the Keycloak component row was `["keycloak","not-met","no-statement"]`, existing levels were unchanged, the dashboard schema and copy lint passed, and `levels.test.ts` still passed.

```json
{
  "id": "hosted-protected-b",
  "title": "Hosted deployment: Protected B",
  "kind": "level",
  "profile": "profiles/itsp-10-033-01-medium.json",
  "components": ["keycloak", "hub", "release-pipeline"],
  "claim": true
}
```
(`levels.schema.json` requires `id`, `title`, `kind`, `profile`, `components`, `claim` `[VERIFIED: compliance/schemas/levels.schema.json]` `"required":["id","title","kind","profile","components","claim"]`; `kind` is `"enum":["level","overlay"]`.)

**Recommendation:** two entries, `hosted-protected-a` and `hosted-protected-b`; do not add hosted overlays now (ITSP.10.171, CPCSC, CGP and ITAR rows are almost all "your organization's responsibility"); record that as a follow-up, not silent scope (Open Question 2). The dashboard builds one row per level and control, and each in-scope component adds a component row `[VERIFIED: compliance/src/dashboard.ts:110-118]` "An in-scope component that says nothing about the control is not skipped: it is assessed as \"No statement yet\"".

### Pattern 2: A component definition with no statements

Valid and loadable. This minimal shape passed `loadComponents` and the OSCAL validator in scratch (it mirrors `compliance/components/appliance.json` minus `control-implementations`):

```json
{"component-definition":{"uuid":"<uuid-v4>","metadata":{"title":"Keycloak","last-modified":"2026-11-23T00:00:00Z","version":"0.1.0","oscal-version":"1.2.1"},"components":[{"uuid":"<uuid-v4>","type":"service","title":"Keycloak","description":"Keycloak (no statements yet).","props":[{"name":"component-id","ns":"urn:near-ai-vscode:compliance","value":"keycloak"}]}]}}
```
`[VERIFIED: compliance/src/model.ts:4]` `export const NS = 'urn:near-ai-vscode:compliance';` and `[VERIFIED: compliance/src/components.ts]` the loader reads `component['control-implementations'] ?? []`, so none is allowed. The file name must equal the component id because `scripts/resource-check.mjs` derives ids from file names `[VERIFIED: scripts/resource-check.mjs, knownIds]` "readdirSync(componentsDir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5))". One component per file.

### Pattern 3: A deployment collector over a signed export

**What:** One collector `deployment` reads a signed envelope file, verifies it with `verifyEnvelope`, and emits one observation per check. Failures throw `collectorError` so the bundle records the collector as ran-and-failed and every rule on it reads `missing-result`.
**Rules it must obey:** `redactObservation` accepts subjects matching `^[a-z0-9][a-z0-9._/@:-]{0,127}$`, count keys matching `^[a-z][a-z0-9-]{0,31}$` with non-negative safe integers, a 64-hex `hash`, and keeps `runUrl` only when it starts with `https://github.com/` `[VERIFIED: compliance/src/redact.ts:6-21]`.

```ts
// Sketch only. Names are real: verifyEnvelope and TrustedKey are exported from compliance/src/signed.ts;
// collectorError(code, message) from compliance/src/collectors/github.ts:15.
export const SITE_EXPORT_PURPOSE = 'site-evidence-export';           // inside every signature; never changes once signed
export const deploymentCollector: Collector<{ file: string; keys: readonly TrustedKey[] }> = Object.freeze({
  id: 'deployment',
  window: 'settings',                                                 // and the same entry in OBSERVATION_WINDOWS
  async collect(input, context) {
    const verdict = verifyEnvelope(JSON.parse(await context.readFile(input.file)), { purpose: SITE_EXPORT_PURPOSE, keys: input.keys, now: context.now });
    if (!verdict.ok) throw collectorError(`export-${verdict.reason}`, `deployment: ${verdict.message}`);
    const facts = parseFacts(verdict.payload);                        // strict allow-list, counts and booleans only
    return CHECKS.map((check) => ({ collector: 'deployment', subject: check.subject, passed: check.derive(facts),
      collectedAt: verdict.signedAt, commit: context.commit, counts: check.counts(facts) }));
  }
});
```
`collectedAt: verdict.signedAt` is the point: freshness then measures the site's evidence, not the CI run. The documents collector does the same with review dates `[VERIFIED: compliance/src/collectors/documents.ts]` `collectedAt: review?.toISOString() ?? context.now.toISOString()`.

**Why the window entry is mandatory.** `[VERIFIED: compliance/src/rules.ts:33-37]` `/** The window for a collector id; unknown collectors are judged against the head commit. */ ... return Object.hasOwn(OBSERVATION_WINDOWS, collector) ? OBSERVATION_WINDOWS[collector] : 'head';` and `[VERIFIED: compliance/src/status.ts]` a `head` result is fresh only when `result.commit === head`. A new collector with no entry would therefore read Met for as long as CI ran at the same commit, whatever the age of the site export. The available windows are `[VERIFIED: compliance/src/model.ts:68-75]` `head`, `audit: 24 * HOUR_MS`, `settings: 7 * DAY_MS`, `harness: 30 * DAY_MS`, `document: 365 * DAY_MS`, `attestation: 365 * DAY_MS`. **Recommendation: `settings` (7 days)** for one collector id; the export script itself reports whether audit streams were flowing in its last day as a fact. Success criterion 2 ("a fixture export with a lapsed audit shows Stale") is then proven with a fixture older than 7 days. Owner may prefer 24 hours or 30 days (Open Question 4).

**Signing.** Use the extension's envelope, not a new format: `signingInput(purpose, unsigned)` is exported, so an on-site script can compute the bytes and have any Ed25519 signer sign them, then attach `sig`. Trust anchors go in `compliance/attestations/site-signers.json` (gate path), same shape as `signers.json` (`fingerprint`, `name`, `publicKey`, `role`; schema `signers.schema.json`). Do not reuse `signers.json` itself: its entries are the people who may sign risk acceptances. **Key custody:** do not sign with a key held by the system being assessed (OpenBao Transit on the rig would mean a compromised OpenBao can sign its own clean bill of health); use a dedicated key held by the operator, HSM-backed where available. For a lab rig, Transit is acceptable and must be recorded as such `[ASSUMED]` (Transit's `ed25519` output format `vault:v1:<base64>` is from training knowledge; confirm on the rig).

### Pattern 4: Statements and rules that land together

Each statement needs at least one rule, and a rule needs its target: test rules name a file plus exact literal test name; observation rules name a collector plus subject. `compliance/test/components.test.ts` line 52 asserts every test rule resolves in the checkout `[VERIFIED: compliance/test/components.test.ts:52-55]` `test('every mapped test rule has an exact literal target in the checkout', ...)`, so a rule pointing at a Phase 46 or 47 test that is not merged yet fails an existing CI test. This agrees with D-12: add the statement, the rule and (for test rules) the report package together, when the behaviour and its test exist. Rule id pattern `^[a-z0-9][a-z0-9.-]{0,95}$`; statement id pattern `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` `[VERIFIED: compliance/schemas/evidence-rule.schema.json]`. Existing convention: `hub.cp-09.restore` `[VERIFIED: compliance/evidence-rules/hub.json]` `"id":"hub.cp-09.restore","component":"hub","control":"cp-09","statement":"cp-09_smt.restore","kind":"test"`.

New test packages (Phase 46's `workbench/`, Phase 47's `deploy/`) must write a per-test report in their CI jobs the way `hub` does `[VERIFIED: .github/workflows/ci.yml:346]` `NEAR_AI_TEST_REPORT: test-report-hub.ndjson`, and the `compliance` job must list them: `[VERIFIED: .github/workflows/ci.yml:505]` `["root", "relay", "hub"].map(packageName => ({ package: packageName, file: ... }))`. Check both Phase 46 and 47 plans for this; if missing it is a one-line gate edit in Phase 48.

### Pattern 5: Load-test run file

One JSON file per run with `kind: "load" | "experiment" | "dry-run"`. Outline (schema is the planner's):

```
{ "schema": 1, "kind": "load", "id": "<date>-<rig>",
  "inputs": { "stages": [...], "profile": {"id","version","sha256"}, "appDefinition": {...}, "sessionsPerUser": 1 },
  "hardware": { nodes (role, cpu, memory, disk, NIC), storageClass, network },
  "versions": { "workbenchImage": "sha256:...", "theiaCloud": {"commit","chart"}, "keycloak", "openbao", "ingress": {"kind","version"}, "rke2", "hub": "sha256:..." },
  "stages": [ { "target": 500, "reached": true|false, "reason": "...", "start": {...}, "perPerson": {...},
                "operator": {...}, "ingress": {...}, "etcd": {...}, "hubs": [...], "queries": [{ "name","text","from","to" }], "raw": [{ "file","sha256" }] } ],
  "hash": "sha256:<canonical hash of everything above>" }
```
Hash with `canonicalize` from `signed.ts` (sorted keys, safe integers only: store durations as integer milliseconds and bytes as integers). A run with `kind: "dry-run"` is never accepted by the docs check as a capacity source.

### Anti-Patterns to Avoid

- **A new collector with no `OBSERVATION_WINDOWS` entry** (evidence never goes stale; see Pattern 3).
- **Statements written ahead of behaviour** ("anticipatory prose"); breaks D-12 and the target-resolves test.
- **Bulk Not-applicable tailoring** to make hosted rows turn green; a reviewed reason per record is the rule `[VERIFIED: compliance/src/status.ts]` an unreviewed exclusion is `not-applicable-unreviewed` and counts as not met.
- **Trusting the site script's `passed` flag**; derive pass or fail in the collector from counts.
- **Putting capacity numbers anywhere except the generated page**; and extrapolating a stage not reached.
- **Registering non-discoverable tools in `resources.json`** (see Pitfall 7).

## Don't Hand-Roll

| Problem | Don't build | Use instead | Why |
|---------|-------------|-------------|-----|
| Signed evidence file | A new signature or file format | `signed.ts`: `canonicalize`, `signingInput`, `verifyEnvelope` | One canonical form already proven against the extension (`signedParity.test.ts`); refuses wrong purpose, future time, bad key, bad signature. |
| Observation hygiene | Ad hoc scrubbing | `redactObservation` and `assertNoSecrets` | The allow-list already enforces ids, counts, hashes, times only (D-13). |
| Freshness | Own age checks | Window table in `rules.ts` and `isFresh` in `status.ts` | The engine already turns lapsed evidence into Stale. |
| Hosted scope | A second dashboard or status field | Extra `levels.json` entries | Verified to work with no engine change. |
| Desk records | A new records store | `docs/security/*.md` with `Last reviewed: YYYY-MM-DD` and the documents collector (365 days) | Same mechanism as the other required documents `[VERIFIED: compliance/src/collectors/documents.ts]` `LAST_REVIEWED_PATTERN = /^Last reviewed: (\d{4}-\d{2}-\d{2})/m`, `DOCUMENT_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000`. |
| OIDC login for load | A custom login emulator | Keycloak direct grant on the test realm for API tokens; Playwright with a virtual authenticator for the browser sample | Production flows have no password path to emulate. |
| Load generator | k6 or Locust | `fetch` plus a stage loop | The service API is REST; the generator is not the bottleneck. |
| Resource inventory | A second register | `scripts/resource-check.mjs` + `resources.json` for npm, image, action, vendored kinds | Already enforced in the `lint` job. |

**Key insight:** every piece of "evidence plumbing" this phase needs already exists. The work is data (components, rules, levels, records) plus one collector and one harness; resisting new frameworks keeps it reviewable.

## Load test: how to drive Theia Cloud

### Service API `[VERIFIED: eclipse-theia/theia-cloud documentation/openapi.json on main, read via gh api 2026-11-23]`

| Method and path | Summary | Notes |
|-----------------|---------|-------|
| `POST /service/workspace` | Create workspace | Needed because persistence is on (Phase 47 D-24); one PVC per person. |
| `POST /service/session` | Start a new session | `SessionStartRequest` requires `["appId","user","appDefinition"]`; optional `workspaceName`, `timeout` ("Number of minutes to wait for session launch. Default is 3 Minutes."), `env`. |
| `POST /service` | Launch Session | `LaunchRequest` requires `["appId","user"]`; creates or reuses a workspace and starts. |
| `PATCH /service/session` | Report session activity | `SessionActivityRequest` requires `["appId","sessionName"]`. |
| `DELETE /service/session`, `GET /service/session/{appId}/{user}`, `GET /service/session/performance/{appId}/{sessionName}` | stop, list, per-session CPU and memory | The performance endpoint reports `cpuAmount`, `cpuFormat`, `memoryAmount`, `memoryFormat`; use Prometheus for the run, keep this only as a cross-check. |

**Auth model.** The service runs Quarkus OIDC `[VERIFIED: java/service/.../application.properties]` `quarkus.oidc.enabled=true`. `appId` must equal the service's configured auth token `[VERIFIED: BaseResource.java:49]` `if (request == null || request.appId == null || !request.appId.equals(appId))`. With Keycloak on, the request user must equal the authenticated user `[VERIFIED: BaseResource.java:87-92]` `} else if (request.user == null || request.user.equals(theiaCloudUser.getIdentifier())) {` ... `info(correlationId, "User specified in the request does not match the authenticated user."); throw new TheiaCloudWebException(Status.FORBIDDEN);`. **Consequence:** one test-realm user per simulated person (unique email; session ownership is an email allowlist, DESIGN hardening item 12). Admin endpoints need an admin role `[VERIFIED: AdminOnlyFilter.java]` "Admin privileges required to access this resource."

**Tokens.** The Theia Cloud client is public (Keycloak.md: "our client is not confidential but public") `[VERIFIED: documentation/Keycloak.md]`. In the **test realm only**, enable direct access grants on the load-test client and mint tokens with a password grant for synthetic users; mint them before each burst with a lifespan longer than the stage so the burst measures Theia Cloud, not Keycloak password hashing. Record the test-realm delta from production (no attestation or AAGUID check, password grant on) in the run file; the production realm keeps every non-WebAuthn flow off and the test realm never enters the offline bundle (D-19). Phase 47's rendered-manifest tests should assert no load-test client exists in the production realm; coordinate that one assertion.

### What a "session start" is, measured three ways (all recorded)

1. Request to `Session.status.url` set and `operatorStatus: HANDLED` `[VERIFIED: ResourceStatus.java + OperatorStatus.java]` fields `operatorStatus`, `operatorMessage`; constants `NEW`, `ERROR`, `HANDLING`, `HANDLED`; `SessionStatus` adds `url`, `error`, `lastActivity`.
2. Request to pod `Ready` (Pod condition transition time) and to the first successful response through the ingress for the session address (route propagation).
3. Request to a usable workbench in a real browser (sample only): the Get Started page rendered. Define the locator once in the profile.

Cold versus warm: record whether the image was already on the node. The chart ships an image-preloading DaemonSet, `preloading.enable: true` by default `[VERIFIED: theia-cloud-helm charts/theia-cloud/values.yaml:429-431]`; run cold-start with and without it and with a cold registry cache, because image pull from Harbor or Zot is likely part of cold start `[ASSUMED]`.

### Representative load per person (D-21)

A pod with no connected browser is not a person. The activity monitor is a VS Code extension that "will expose a rest service, where an external service can ping the extension" `[VERIFIED: node/monitor/README.md]`; Theia starts plugin hosts per frontend connection `[CITED: .planning/research/multiuser-hosting/RESEARCH.md section 1]`. Two consequences `[ASSUMED]` (behaviour on a failed ping and on a missing plugin host is not verified): sessions with no frontend may be treated as idle and reaped, and their memory is not representative.

Recommended design: every stage runs two populations and reports them separately.
- **Bulk sessions** started through the API, kept alive by `PATCH /service/session` activity reports and a raised test `timeout` on a copy of the production AppDefinition (identical otherwise), reported as "started, no frontend".
- **Active sample** of M sessions with a real browser running the versioned activity profile (open files, edit, terminal command, idle share). **Per-person CPU and memory figures come only from the active sample**; the run file states M and the stage total. A claim then reads "N concurrent sessions, M of them with an active frontend running profile P". Measure first how many browsers one generator host can drive (memory is the limit), then size M.
- Optional spike: a headless Theia RPC client to raise the active share cheaply (Open Question 6).

### Browser sample with a WebAuthn virtual authenticator

Chromium only: Playwright reaches the authenticator through a CDP session (`WebAuthn.enable`, then `WebAuthn.addVirtualAuthenticator` before navigating; resident-key and user-verification options set for passkeys; the `credentialAdded` event can gate the flow) `[CITED: community guides surfaced by search; official CDP page redirects to its WebAuthn domain and was not readable via fetch]`. A second claim, a Playwright 1.61+ `browserContext.credentials` cross-browser API, came from one source only and is `[ASSUMED]`; check Playwright's own docs before relying on it. Keycloak policy in the test realm must accept the virtual authenticator's attestation (production uses attestation `direct` plus an AAGUID allowlist); list that delta in the run file.

### Measurement sources (D-22)

| Measure | Source | Notes |
|---------|--------|-------|
| Per-person CPU and memory | Prometheus cAdvisor series on the session pods, filtered to the active sample | Keep the idle (no frontend) population separate. |
| Session start timeline | `kubectl get session,deployment,pod -o json` creation and condition times | Operator reconcile latency = Deployment creation time minus Session creation time. |
| Operator throughput | Derived: Deployments created per 10-second window during the burst | **The operator has no metrics endpoint**: neither the operator nor the service pom lists micrometer, prometheus or health artifacts `[VERIFIED: grep of java/operator/.../pom.xml and java/service/.../pom.xml; service pom has only quarkus-smallrye-openapi]` (absence; treat as `[ASSUMED]`-grade for "no endpoint at all"). Also cross-check with kube-apiserver request counts by user agent. |
| Single active reconciler | Fact | `LeaderElectionTheiaCloudOperatorLauncher` uses a Lease lock named `theia-cloud-operator-leaders` `[VERIFIED: LeaderElectionTheiaCloudOperatorLauncher.java:44]`, so running extra replicas does not add throughput. |
| Shared Ingress object | `kubectl get ingress <ingressname> -o json | wc -c` and rule count, sampled per stage and per 50 sessions in the burst | The operator edits one shared Ingress per AppDefinition for every session add and remove `[VERIFIED: TheiaCloudIngressUtil.java]` `client.network().v1().ingresses().inNamespace(namespace).withName(ingress.getMetadata().getName()).edit(...)`; the AppDefinition field is `ingressname` `[VERIFIED: documentation/Architecture.md]` "Name of the ingress where the rules for sessions will be added". etcd's default request limit is 1.5 MiB `[VERIFIED: etcd.io/docs/v3.5/dev-guide/limit]` "By default, the maximum size of any request is 1.5 MiB." |
| Route propagation ("ingress reload time") | Time from the Ingress object containing a session's rule to the first successful response through the ingress | Controller-agnostic, so it works for HAProxy and Traefik. The HAProxy controller serves Prometheus on port 1024 at `/metrics` `[CITED: haproxy.com/documentation/kubernetes-ingress/administration/metrics]`, but I could not confirm any reload-count or update-duration metric name (the page was truncated); on the rig, list the series and store the names (Open Question 5). |
| etcd | Prometheus series from the etcd and kube-apiserver endpoints | Default quota 2 GiB and suggested maximum 8 GiB `[VERIFIED: etcd.io/docs/v3.5/dev-guide/limit]`; commit and WAL fsync histograms exist `[VERIFIED: etcd.io/docs/v3.5/metrics]` `etcd_disk_backend_commit_duration_seconds`, `etcd_disk_wal_fsync_duration_seconds`. DB-size and per-resource object-count metric names vary by etcd and Kubernetes version `[ASSUMED]`: resolve names from the live `/metrics` at run start and store them with the queries. |
| Hub load | Pod CPU and memory from cAdvisor; client-side append latency; `/healthz` latency | The hub exposes only `/healthz` with `version`, `uptimeSeconds`, `store` `[VERIFIED: hub/src/health.ts]`. Target per hub: "10 projects, 150 persons, 400 devices, 300 concurrent event streams, 50 entries per second" `[VERIFIED: .planning/research/multiuser-sync/DESIGN.md:441]`. |

### Rig dimensions the plan must not forget

- Kubernetes' stated large-cluster envelope is "No more than 110 pods per node" `[VERIFIED: kubernetes.io/docs/setup/best-practices/cluster-large]`; 1,000 session pods plus platform pods need at least ten worker nodes or a raised kubelet `maxPods` (a recorded setting, not a silent default).
- Design estimate: about 1 to 2 GiB and 0.25 to 1 vCPU per session `[CITED: DESIGN.md section 7, "Capacity [estimate]"]`, so roughly 1 to 2 TiB of worker memory at 1,000 sessions. Keep this marked as an estimate until a run replaces it (D-09).
- 1,000 PVCs on the encrypted storage class: record provisioning time inside the cold-start figure; the storage class is Phase 47's choice.
- Stages (D-20): 50, 250, 500, 1,000, above while the rig allows. A stage not reached is recorded with the reason; the capacity page prints "not reached", never an extrapolation.

## Compliance machinery: answers to the research questions

1. **Separate hosted scope without engine change:** yes (Pattern 1). Needed edits: `controlText.ts` (so rows get titles and the text drawer: scratch result `hosted-protected-b` row `title: "ac-02"`, no `textFile`, versus `protected-b` `title: "Account management"`, `textFile: "text/itsp-10-033/ac.json"`) `[VERIFIED: ran bundle in scratch]`; `[VERIFIED: compliance/src/controlText.ts:29]` `{ file: 'itsp-10-033/catalog.json', source: 'itsp-10-033', pathPart: '/itsp10033', levels: ['unclassified', 'protected-a', 'protected-b'] }`.
2. **Dashboard with new components (#160):** every in-scope component gets a row per control; a component with no statement reads `no-statement`. Aggregation: a control reads Met only when every assessable in-scope component row is Met `[VERIFIED: compliance/src/status.ts]` `if (states.every((state) => state === 'met')) return { state: 'met', reason: 'met' };`. Today no level has a Met control (scratch: Protected B `met 0`, `not-met 304`), and the hosted levels start the same. With 16 in-scope components the arithmetic is unforgiving; this favours fewer, area-level components (Open Question 1).
3. **Collector shape, signing, freshness:** Pattern 3.
4. **Organization overlay and customer site:** `mergeOverlay` changes a row only when `component.responsibility !== 'your-organization'` is false `[VERIFIED: docs-site/src/compliance/lib.mjs:78]` `if (component.responsibility !== 'your-organization') continue;`, so an overlay cannot carry product or shared evidence. The customer path: run `compliance bundle` locally with their own export and trust list in the inputs, then `compliance-refresh --from-dir <bundle>` `[VERIFIED: docs-site/scripts/compliance-refresh.mjs:75]` `fromDir = option('from-dir')`; the "Your organization" view then lists every level in that local dashboard (`OrganizationView.jsx` maps `result.levels`). Nothing is uploaded; `check-build-isolation.mjs` keeps overlay markers out of the build.
5. **Gaps and POA&M for verification items:** gaps are control-keyed, not item-keyed. `[VERIFIED: compliance/schemas/gaps.schema.json]` a gap needs `id` (`^[GX][0-9]+$`), `title`, `controls` (at least one), `remediation`, `ownerRole` (enum `maintainers`, `release-owner`, `owner`, `shared`) and exactly one of `closesInPhase` or `poam`. A POA&M item (`compliance/poam/g<N>.json`, schema `poam-item.schema.json`) needs `milestones` with a `phase` or a `targetDate` (`YYYY-MM-DD`). Latest ids today: `G320`/`g320` and `X12` (323 gaps; `[VERIFIED: python read of compliance/gaps.json and ls compliance/poam]`). So each unresolved verification item becomes a `G321+` gap (re-check the highest id when writing, since other phases add gaps) on the controls it affects (for example SC-13 for crypto module status, SI-02 for flaw remediation, SC-12 for HSM) with a POA&M milestone carrying the target date; the owner role is the "owner" the owner asked for. Gaps and POA&M are not gate paths `[VERIFIED: scripts/lib/workflow.mjs:595-619]` (the list names `compliance/tailoring/`, `sources.json`, `catalogs/`, `attestations/`, `src/`, `components/`, `evidence-rules/`, `responsibility/`, `profiles/`, `levels.json`, `resources.json` and the scripts, not `gaps.json` or `poam/`). Adding the hosted levels changes `levelsBlocked` for gaps without `profiles` (scratch, same inputs with and without the hosted level: G1 `levelsBlocked` 4 to 5, G26 3 to 4, G129 3 to 4; states stayed `planned`) and `evidenceProgress` considers the new rows; scope new gaps with `profiles` where honest.
6. **Gate paths:** `[VERIFIED: scripts/lib/workflow.mjs:595-619]` includes `/^\.github\//`, `/^scripts\/resource-check\.mjs$/`, `/^compliance\/resources\.json$/`, `/^compliance\/attestations\//`, `/^compliance\/src\//`, `/^compliance\/components\//`, `/^compliance\/evidence-rules\//`, `/^compliance\/levels\.json$/`. Not gate: `compliance/test/`, `compliance/gaps.json`, `compliance/poam/`, `compliance/site-evidence/`, `docs/`, `docs-site/`, `loadtest/`.

## Section 10 traceability (VER-08), first mapping

"Test" means a Phase 46 or 47 CI test the rule can name once it exists. "Obs" means an observation from the `deployment` collector. "Doc" means a dated record or attestation (365 days). Control ids are proposals; a control absent from the level's profile never shows (checked: `sc-13`, `sc-12`, `sc-08`, `sc-23`, `sc-28`, `ia-02`, `ia-05`, `au-02`, `au-12`, `ac-12`, `si-02`, `si-07`, `cm-02`, `cm-06`, `sa-10`, `cp-09`, `sr-03`, `sr-11` are in the Medium profile; `sr-04`, `cm-14`, `sc-06` and `sc-03` are not) `[VERIFIED: python read of profiles/itsp-10-033-01-medium.json, 417 ids]`.

| Component (id) | Section 10 condition | Evidence kind | Likely controls |
|---|---|---|---|
| `rke2` | FIPS build with Canal and bundled FIPS components | Obs (version, host `fips_enabled`), Doc | sc-13, sc-12 |
| `rke2` | STIG and CIS profile | Test (rendered RKE2 config in `deploy/rke2/`), Obs | cm-06, cm-07 |
| `rke2` | Kubernetes audit policy on Session and Workspace records | Test (policy file), Obs (audit stream present) | au-02, au-12 |
| `keycloak` | FIPS strict with BC-FIPS on a FIPS host, OpenJDK 21 | Obs (startup flag, host flag), Doc (cert record, see register) | sc-13 |
| `keycloak` | Version with CVE-2026-6856 fixed | Obs (version at or above the pinned minimum held in collector source), Doc | si-02 |
| `keycloak` | Password and OTP authenticators disabled | Test (realm as code), Obs (live realm: password and OTP authenticator count 0) | ia-02, ia-05 |
| `keycloak` | Events shipped to the audit store | Obs (listener enabled, events counted) | au-02, au-12 |
| `theia-cloud` | Rebuilt by us on a FIPS-capable JRE, signed, SBOM and provenance | Obs (per image digest: signature, SBOM, provenance), Test (build job) | sa-10, sr-03, sr-11, si-07 |
| `theia-cloud` | oauth2-proxy defaults fixed (TLS verify on, secure cookies, real secret, token forwarded) | Test (Phase 47 D-56 rendered-manifest assertions) | sc-08, sc-23, ia-02 |
| `theia-cloud` | Audit on Session and Workspace records; pinned to the assessed commit | Obs, Test (`charts.lock.json`, digests) | au-12, cm-02 |
| `openbao` | HSM-held keys through External Keys or a self-built FIPS binary with certificate checked | Obs (seal type, plugin checksum), Doc (HSM certificate record) | sc-12, sc-13 |
| `openbao` | Audit device to a tamper-evident store | Obs (device enabled); tamper-evidence stays gap G2 | au-09 |
| `openbao` | Documented key ceremony | Doc (runbook record with `Last reviewed`), attestation | sc-12 |
| `openbao` (HSM) | FIPS 140-3 Level 3 model in approved mode; `kms-pkcs11` tested | Doc (certificate record for the chosen model), rig experiment; SoftHSM2 never counts | sc-12, sc-13 |
| `ingress` | HAProxy FIPS only with a validated OpenSSL provider on a FIPS host | Obs (image base and host flag); otherwise gap | sc-13, sc-08 |
| `ingress` | RKE2 Traefik variant, untested | Rig experiment record; no statement until tested | sc-08 |
| `image-registry` | Signature-enforced import and admission, scanning, SBOM storage, OIDC, audit log | Obs (admission policy enforcing, unsigned admitted count 0), Test | si-07, sa-10, ra-05, au-12 |
| `image-registry` | FIPS build | Gap (no upstream FIPS build found `[ASSUMED]`) | sc-13 |
| UBI 9 bases (`workbench`, `theia-cloud`, `keycloak`) | Host in FIPS mode and the RHEL OpenSSL FIPS provider | Obs (`fips_enabled`), Doc (certificate record, register row) | sc-13 |
| `workbench` | UBI 9 base, Node with OpenSSL 3 FIPS provider on a FIPS host; signing and unwrapping through OpenBao or the HSM | Test (P4 tests in `workbench/`), Obs (`crypto.getFips()` result in the export) | sc-12, sc-13 |
| `cert-manager` | Not assessed; CA issuer chained to OpenBao PKI, no ACME | Test (rendered manifests: no ACME issuer) after the fit entry | sc-12, sc-23 |
| `hub` | Re-assessed for Kubernetes, several hubs, certified session keys | Test (hub tests, Phase 47 manifest tests), Obs (hub workload settings) | cp-09, sc-08, ac-03 |
| `keycloak-postgres`, `site-storage`, `site-logging` | Not assessed; encryption at rest declared, TLS to Postgres, non-AGPL log store | Test (install check for storage class), Obs | sc-28, sc-08, au-09 |
| Negative conditions (ingress-nginx, k3s in production, Debian and Alpine at Protected B) | Must not appear | Test (rendered production profile assertions) | cm-07, sc-13 |

Anything with no evidence path at assessment time becomes a gap on the affected controls with the owner role and a POA&M date (Verification section).

## Common Pitfalls

### Pitfall 1: Evidence that never ages
**What goes wrong:** a new collector is judged at the head commit, so a month-old export reads current.
**Why:** `windowForCollector` falls back to `'head'` for unknown ids (rules.ts:33-37).
**Avoid:** add the window entry and a test that a fixture export older than the window reads Stale (success criterion 2).
**Warning sign:** dashboard rows Met while `collectedAt` is weeks old.

### Pitfall 2: Rules ahead of tests, statements ahead of behaviour
**What goes wrong:** the existing `compliance` test "every mapped test rule has an exact literal target in the checkout" fails, and the dashboard describes behaviour that does not exist.
**Avoid:** one commit per component batch: behaviour exists, test exists, statement, rule, report package.

### Pitfall 3: Existing tests that name the component list
`compliance/test/components.test.ts:46-49` asserts the exact list `['appliance', 'extension', 'hub', 'model-endpoints', 'relay', 'release-pipeline']`. In scratch, adding `keycloak.json` made "all six component definitions load as OSCAL content" fail. Update the list (and its title) in the same PR. `[VERIFIED: ran in scratch, 2026-11-23]`

### Pitfall 4: Hosted rows without titles
Without the `controlText.ts` level ids the hosted rows show the control id as the title and have no text drawer. Add the hosted ids to the `itsp-10-033` entry (and any other catalogue the hosted levels' profile uses).

### Pitfall 5: "Met" is unreachable by design for a long time
A control is Met only when every in-scope component row is Met or reviewed Not applicable. Do not respond with bulk tailoring. Report the honest state (Not met, "No statement yet", Your organization's responsibility) and let statements arrive per component.

### Pitfall 6: Organization overlay is not a product-evidence channel
Overlay evidence only upgrades rows whose responsibility is `your-organization`. A plan that tells customers to "put your export in your overlay" will not change a single product row. Use the local bundle path.

### Pitfall 7: The resource register cannot hold what it cannot discover
`scripts/resource-check.mjs` flags an entry whose resource is not discovered as stale `[VERIFIED: scripts/resource-check.mjs, check()]` "nothing in the repository uses it any more; remove the stale entry", and it discovers npm packages only from the listed manifests `[VERIFIED: scripts/resource-check.mjs:13]` `PACKAGE_FILES = Object.freeze(['package.json', 'relay/package.json', 'hub/package.json', 'docs-site/package.json', 'compliance/package.json'])`. So (a) a `loadtest/package.json` dependency has no register entry required and an entry for it would be flagged stale until the list includes that file (Phase 46 D-32 and Phase 47 D-52 already plan edits to the same line and to image discovery), and (b) kubectl, Prometheus and the browser build cannot be registered at all; document them in `loadtest/README.md`. D-19's "every new tool has a compliance fit entry" is therefore satisfiable only for what the checker can discover; the one-line `PACKAGE_FILES` addition for `loadtest/package.json` needs owner approval and conflicts with the scope fence "Read only: scripts/resource-check.mjs" (Open Question 3). Fallback with no gate change: keep the harness dependency-free and run the browser sample from a pinned Playwright already registered by Phase 46.

### Pitfall 8: Gap scoping
Gaps without `profiles` cover every level, including the hosted ones, so adding hosted levels changes `levelsBlocked` and `evidenceProgress` for existing gaps. Review the existing deployment-evidence gaps (G26, G129 and others) and add `profiles` or new gaps deliberately.

### Pitfall 9: Service API user binding
Starting a session as another user is refused (403). A single admin token cannot start 1,000 people's sessions. One test-realm identity per person; unique emails.

### Pitfall 10: Sessions without a frontend
Not representative, possibly reaped (Representative load section). Report the bulk and the active sample separately; never print the bulk figure as "per person".

### Pitfall 11: Node count and pod density
110 pods per node default; PVC provisioning and image pull storms dominate cold start. Record `maxPods`, storage provisioner and whether images were preloaded.

### Pitfall 12: One shared Ingress object
Every session add and remove edits the same object; at thousands of rules it approaches etcd's 1.5 MiB request limit and produces patch contention and controller churn `[ASSUMED: contention behaviour; the object size and limit are verified above]`. Measure bytes per rule and project the limit as a recorded ratio, not a claim.

### Pitfall 13: Eager-start code paths can be O(sessions)
The eager release path lists pods across the cluster `[VERIFIED: EagerSessionHandler.java ~509-512]` `client.kubernetes().pods().list().getItems().stream().filter(p -> p.getMetadata().getName().startsWith(deploymentName)).findAny()`. Not on the default (lazy) path; relevant only if a pool is tested.

### Pitfall 14: Prewarm cannot hold a person's volume
See Verification register row 9: upstream and EduIDE both describe pools of temporary workspaces. Do not design the pool experiment as "attach the volume after claim"; design it as "does a pool help ephemeral sessions, and what does a persistent person pay at cold start".

### Pitfall 15: Test realm drift and credentials
The test realm differs from production (password grant on, no attestation check). Record the delta; generate test passwords per run, keep them in the rig's secret store, run the run file through the secret scanner, and keep the test realm out of the offline bundle.

### Pitfall 16: Dishonest statistics
p99 from a handful of samples is noise. Store n, and print p99 only when n supports it (the run file records n; the capacity page prints "n too small" otherwise). Use one percentile method (nearest rank) with a fixture test.

### Pitfall 17: Certificates age out
The Go FIPS module page warns "Older Go Cryptographic Module versions continue to be supported and available for as long as a more recent version has not obtained a CMVP validation certificate. Once a more recent version has obtained a CMVP validation certificate, older versions will be removed." `[VERIFIED: go.dev/doc/security/fips140]`. With v1.26.0 certified, `GOFIPS140=v1.0.0` may disappear from future toolchains: pin the Go toolchain and module version in Phase 47's rebuild jobs and record the certificate in the desk record.

## Code Examples

### Start a session as a test user (Theia Cloud service)
```ts
// Shapes from documentation/openapi.json (SessionStartRequest requires appId, user, appDefinition).
const response = await fetch(`${serviceUrl}/service/session`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ appId, user: email, appDefinition, workspaceName, timeout: 3 }),
});
```

### Per-session timeline from Kubernetes (no generator estimates)
```bash
kubectl get sessions.theiacloud.io -o json       # metadata.creationTimestamp, status.operatorStatus, status.url
kubectl get deployments,pods -l <session-label> -o json
kubectl get ingress <ingressname> -o json | wc -c   # shared object size; count .spec.rules as well
```
(The Session kind and group names are from the CRD files `[VERIFIED: SessionV1beta7*.java]`; confirm the plural and group on the rig with `kubectl api-resources`.)

### Verbatim in-repo values the examples above rely on
- `export const NS = 'urn:near-ai-vscode:compliance';` (compliance/src/model.ts:4)
- `export const FRESHNESS = Object.freeze({ head: 'head', audit: 24 * HOUR_MS, settings: 7 * DAY_MS, harness: 30 * DAY_MS, document: 365 * DAY_MS, attestation: 365 * DAY_MS } as const);` (model.ts:68-75)
- `'no-statement': 'No statement yet: the product does not yet describe how it supports this control.',` (model.ts REASONS)
- `export function collectorError(code: string, message: string, status?: number): CollectorError {` (collectors/github.ts:15)
- `export function signingInput(purpose: string, unsigned: Readonly<Record<string, unknown>>): Buffer {` and `export function verifyEnvelope(envelope: unknown, options: VerifyOptions): EnvelopeVerdict {` (signed.ts)
- `export const GATE_PATHS = Object.freeze([` ... `/^compliance\/levels\.json$/` (scripts/lib/workflow.mjs:595-619)

### Docs check for hand-typed capacity figures (shape)
A pure function `findCapacityFigures(text)` flags a number followed by sessions, people, persons or users, or a number with GiB, MiB, TiB or vCPU in a sentence about a session or person, in a fixed file set (`docs/hosting/**`, `docs-site/content/**`, `README.md`, `hub/README.md`), and passes only text inside the generated block carrying a run id that exists and verifies. A grep of today's `README.md`, `CHANGELOG.md`, `docs/`, `hub/README.md`, `relay/README.md`, `docs-site/content`, `SECURITY.md` for a count plus those nouns found no capacity statement (the hits were unrelated prose), so the rule can start strict. The check runs in the existing `docs` job through `docs-site/test/`; no workflow edit is needed.

## Verification register: draft findings (VER-09, D-24, D-25)

All lookups were made on 2026-11-23. "Closed (desk)" means the record can be written now with these sources; "Rig" means a recorded experiment is required; "Gap" means no confirmable evidence and an owner and date are needed.

| # | DESIGN 12 item | State | What was found |
|---|----------------|-------|----------------|
| 1 | No public proof of 1,000+ sessions | Rig | VER-01 to VER-03; nothing to close at the desk. TUM's suite reports no result `[CITED: eduide.github.io/Docs/developer/projects/theia-scale-tests]`. |
| 2 | Hub capacity | Rig | Same run; target numbers quoted above. |
| 3 | Keycloak CVE-2026-6856 | Closed (desk) | Fixed upstream in Keycloak 26.6.2, released 2026-05-19: "[CVE-2026-6856] Acceptable AAGUID policy bypass via packed self-attestation in WebAuthn registration" `[VERIFIED: keycloak.org/2026/05/keycloak-2662-released]`. Fix commits for issue 48388 (`3ba245c3...`, `e03bc865...`, committed 2026-04-27) are ancestors of tags 26.8.0 and 26.8.2 (GitHub compare API returned `ahead` with `behind_by 0` for both) and 26.6.2 carries a diverged backport `[VERIFIED: gh api repos/keycloak/keycloak/compare, 2026-11-23]`. Latest upstream release seen: 26.8.2 (Nov 5) `[VERIFIED: github.com/keycloak/keycloak/releases]`. Pin 26.8.2 or later (minimum 26.8.0). The same 26.6.2 notice also fixes CVE-2026-37982, "token replay during execute-actions enabling unauthorized WebAuthn enrollment", which bears directly on the enrolment flow (DESIGN 6 step 9). Red Hat's Bugzilla entry 2460004 shows the CVE as affecting "RHBK 26.4 and Keycloak 26.6", status NEW, "Patch in progress", last modified 2026-04-22, no fixed-in version `[VERIFIED: bugzilla.redhat.com/show_bug.cgi?id=2460004]`: **if a site uses the Red Hat build rather than upstream, the RHBK fix version is unconfirmed (gap).** A separate WebAuthn policy bypass, CVE-2026-8830 (client-side), appeared in search results and its fix version was not checked `[ASSUMED]`. |
| 4 | HSM FIPS 140-3 certificates | Closed for candidates; chosen model is a gap until purchase | Thales Luna K7 Cryptographic Module (the module in Luna Network and PCIe HSM 7): **#4684**, FIPS 140-3, Active, Level 3, validated 4/2/2024, updated 7/7/2025, sunset 4/1/2029, firmware 7.8.4 and 7.8.5 with bootloaders 1.1.1, 1.1.2, 1.1.4, 1.1.5, "When operated in approved mode" `[VERIFIED: csrc.nist.gov certificate/4684]`. Entrust nShield 5s: **#5329**, Active, Level 3, sunset 8/18/2029, updates through 11/10/2026, caveat "When installed, initialized and configured as specified in Section 11.3 of the Security Policy" `[VERIFIED: csrc.nist.gov certificate/5329]`; **#4745**, Active, Level 3, sunset 7/30/2029, firmware primary 13.2.4 `[VERIFIED: certificate/4745]`; **#4765** is Historical, "Replaced by certificate #5329" `[VERIFIED: certificate/4765]`. Utimaco: **#5223** "u.trust Anchor", Active, Level 3, sunset 3/31/2031 `[VERIFIED: certificate/5223]`; Utimaco's own page says the u.trust General Purpose HSM Se-Series "has achieved FIPS 140-3 Level 3 validation" (press date 14 Apr 2026) but states no certificate number or firmware `[VERIFIED: utimaco.com blog page]`, and NIST search for vendor Utimaco returned only #5223 and #4992 (Atalla ACS): **the Se-Series certificate is not confirmed and #5223 must not be assumed to cover it `[ASSUMED]`**. The certificate must match the purchased model, firmware and approved mode; record it when the owner buys (owner item 5). |
| 5 | Go FIPS module | Closed (desk) | go.dev: v1.0.0 "is covered by CMVP Certificate #5247 and CAVP Certificate A6650" (available from Go 1.24.8, 1.25.2, 1.26); v1.26.0 "is covered by CMVP Certificate #5581 and CAVP Certificate A8028" (from Go 1.26.12, 1.27.5, 1.28) `[VERIFIED: go.dev/doc/security/fips140]`. NIST: **#5247** Go Cryptographic Module, Geomys LLC, Active, Level 1, initial 4/27/2026, update 7/7/2026, sunset 4/26/2031 `[VERIFIED: certificate/5247]`; **#5581** Active, Level 1, initial 11/13/2026, update 11/20/2026, sunset 11/12/2031, "When operated in approved mode" `[VERIFIED: certificate/5581]`. The NIST pages did not show module version strings; the version-to-certificate mapping rests on go.dev `[CITED]`. Caveats from go.dev: a validated module alone "may not ... satisfy all relevant regulatory requirements", and Go+BoringCrypto "is incompatible with the native FIPS 140-3 mode". |
| 6 | Traefik with Theia Cloud | Rig | Chart `ingress.controller` supports "nginx", "haproxy", or null; "Using null or an unknown value results in only explicitly specified annotations being used" `[VERIFIED: theia-cloud-helm values.yaml:325-329]`; `hosts.usePaths: false` is the default and gives each session its own host `[VERIFIED: values.yaml:62-70]`. RKE2 packages ingress-nginx and Traefik, and "Starting with v1.36, Traefik is the default for new clusters"; ingress-nginx "went EOL in March 2026" `[VERIFIED: docs.rke2.io/networking/networking_services]`. That page does not mention FIPS, so "RKE2's FIPS-built Traefik" remains `[ASSUMED]` until the RKE2 FIPS page is read. Upstream Theia Cloud issue #464 (move off nginx) closed 2026-04-09 with HAProxy as the new default; a commenter mentions Traefik as a k3s default. Experiment matrix: HAProxy and Traefik, each in host-based and path-based mode, recording rule add latency, route propagation, WebSocket survival through a session and Ingress size growth. |
| 7 | `kms-pkcs11` plugin (v0.3.0) | Rig | `kms-pkcs11-v0.3.0` (2026-11-03) is still the newest `kms-pkcs11` tag in `openbao/openbao-plugins` releases `[VERIFIED: gh api repos/openbao/openbao-plugins/releases]`. Test against the chosen HSM; SoftHSM2 proves wiring only. |
| 8 | Theia Cloud project health | Closed (desk, refresh) | Latest release 1.2.0 (2026-04-09); repository pushed 2026-11-20 `[VERIFIED: gh api repos/eclipse-theia/theia-cloud]`. Unchanged: pin, fork only if needed (D-06). |
| 9 | Prewarm pool with personal volumes | Desk plus rig | EduIDE: "a saved workspace (`volume`) always starts cold, because Kubernetes cannot attach a volume to a running pod. Pools serve only temporary workspaces" `[CITED: eduide.github.io/Docs/developer/platform/session-prewarming]`; its pool pods are bare pods with claim by label patch. Upstream Theia Cloud: `--eagerStart` is "not fully supported at the moment", `minInstances` are "started eagerly without an existing user" `[VERIFIED: documentation/Architecture.md]`; chart `eagerStart: false` `[VERIFIED: values.yaml:223]`; the eager release path deletes the pod "to clean temporary workspace files" `[VERIFIED: EagerSessionHandler.java]`, and a search of that file for volume or storage handling found only that comment (absence, so `[ASSUMED]` that upstream eager start has no persistent-workspace support). Expected outcome: pool stays 0 for persistent workspaces; record cold-start p50, p95, p99 against the owner's 60-second default (owner item 6), with and without the preloading DaemonSet. |
| 10 | Step-up re-authentication through the sidecar | Rig | Not verifiable at the desk. Experiment: from a running session, force a fresh WebAuthn step and observe a new `auth_time` and `acr` through oauth2-proxy; record result. |
| 11 | Synced passkeys | Decided (D-26) | Record the rule that proves the configuration (realm as code: device-bound passkeys, attestation `direct`, non-empty AAGUID list), not an experiment. |
| 12 | Shared relying-party ID | Decided (D-26) | Record the rule on the `rpId` site value being the parent domain (Phase 47 D-08). |
| 13 | Large smart-card revocation lists | Rig | Experiment: CRL size versus Keycloak memory and refresh; or local OCSP responder. |
| 14 | Theia 1.77 supported Node range | Closed (desk) | Theia v1.77.0 root `package.json` has `"engines": {"node": ">=24"}`; its CI matrix is `node: [24.x, 26.x]` `[VERIFIED: gh api eclipse-theia/theia contents at ref v1.77.0: package.json and .github/workflows/ci-cd.yml:72]`. The hub's Node 26 is inside the tested matrix, so P11 on Node 26 is supported by Theia's own CI; the workbench's native addons (node-pty) still need Phase 46's build proof. |
| 15 | UBI 9 OpenSSL FIPS provider (D-24 desk item) | Closed (desk) | **#5573** "Red Hat Enterprise Linux 9 - OpenSSL FIPS Provider", Red Hat Inc., FIPS 140-3, Active, Level 1, validated 11/9/2026 (atsec), sunset 10/28/2029, "validated only when operated in approved mode" `[VERIFIED: csrc.nist.gov certificate/5573]`; the earlier **#4857** is Historical, "Replaced by certificate #5573" (software 3.0.7-395c1a240fbfffd8) `[VERIFIED: certificate/4857]`. Red Hat's page lists #5573 against the OpenSSL row for RHEL 9.0 through 9.8 (for example `openssl-fips-provider-3.0.7-6.el9` on 9.8) `[VERIFIED: access.redhat.com/compliance/fips]`. The UBI image versus RHEL host distinction (the validated module runs on a RHEL host in FIPS mode) stays a condition. |
| 16 | BC-FIPS for Keycloak strict mode (extra item from DESIGN 10) | Closed for the module; Keycloak coupling is a gap | BC-FJA **#4743** (version 2.0.0, Active, Level 1, sunset 7/28/2029) and **#4943** (version 2.1.1, Active, Level 1, sunset 1/16/2030, interim validation caveat) `[VERIFIED: certificate/4743, certificate/4943]`. Which BC-FIPS version Keycloak 26.8.x accepts in strict mode was not checked. |
| 17 | Harbor and Zot FIPS builds (D-24 desk item) | Gap | No upstream FIPS build or documentation was found for goharbor or project-zot; third-party FIPS images exist (Chainguard, Minimus; commercial) `[ASSUMED: absence plus search results]`. Zot is Go, so our own `GOFIPS140` build is possible `[ASSUMED]`; Harbor is multi-component. Gap with owner and date; decide Harbor-without-FIPS (conditions) versus rebuild. |

Desk records go into `docs/security/hosted-verification-records.md` with `Last reviewed: YYYY-MM-DD` in the first 40 lines and one H2 per closed item, each H2 holding the source address, the date and what the source says. To be evidence it must be added to `REQUIRED_DOCUMENTS` in `documents.ts` (gate) with the headings listed; `[VERIFIED: compliance/src/collectors/documents.ts]` the collector checks headings and the review date only, never the text, so only closed rows get headings and open items live in `gaps.json`. The `docs/security/crypto-inventory.md` table (read row by row by the crypto collector) and `data-flow.md` (required headings) also need hosted rows; edit them through the same gate PR.

## State of the Art

| Old approach | Current approach | When changed | Impact |
|--------------|------------------|--------------|--------|
| ingress-nginx as the default controller | HAProxy (Theia Cloud default) or Traefik (RKE2 default from v1.36) | ingress-nginx EOL March 2026 | D-05 stands: HAProxy until Traefik is tested. |
| Marketplace VSIX evidence | Image digest, signature, SBOM, attestations (P10) | D1, 2026-11-23 | `release-pipeline` rules change with the image; `workbench` resources move off `extension`. |
| FIPS 140-2 Go BoringCrypto | Go native FIPS 140-3 module (`GOFIPS140`) | Go 1.24 | Two validated module versions exist now (#5247, #5581); the two modes are incompatible. |
| FIPS 140-2 HSM certificates | FIPS 140-3 certificates | 140-2 certificates moved to historical on September 21, 2026 `[CITED: Thales search summary]` | Require 140-3 certificates in desk records. |

**Deprecated or outdated:** ingress-nginx (archived), Theia Cloud's pinned oauth2-proxy v7.12.0 (Phase 47 D-22), nShield 5s certificate #4765 (Historical).

## Runtime State Inventory

Not a rename or migration phase. Omitted. One related note for Phase 46's `extension` stand-in: `compliance/resources.json` entries for workbench resources are filed under component `extension` until this phase adds a `workbench` component, then must be re-pointed in a gate PR (the checker rejects an unknown component id).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | OpenBao Transit signs ed25519 and returns `vault:v1:<base64>`; usable by the on-site export script | Pattern 3 | Exporter needs a different key mechanism; no plan change otherwise. |
| A2 | Sessions with no connected frontend may be reaped by the idle monitor and are not representative | Representative load | If wrong, bulk sessions are cheaper to keep and more representative than assumed; the two-population design still holds. |
| A3 | The operator and service expose no metrics endpoint at all (only absence from pom grep) | Measurement sources | If a metrics endpoint exists, use it in addition to derived timings. |
| A4 | etcd and kube-apiserver metric names (DB size, object counts) vary by version | Measurement sources | Names resolved at run start and stored; low risk. |
| A5 | HAProxy controller reload metric names unknown | Measurement sources | Route-propagation measure is independent of names. |
| A6 | Image pull from the site registry is part of cold start | Load test | Cold-start decomposition needs separate pull timing. |
| A7 | Ingress edit contention grows with rule count | Pitfall 12 | Measure and report only observed values. |
| A8 | Utimaco Se-Series certificate not confirmed; #5223 may or may not cover it | Register row 4 | Wrong mapping would put a wrong certificate in a record; keep it a gap until Utimaco names the number. |
| A9 | RKE2's Traefik is a FIPS build | Register row 6 | If not, Traefik variant fails the SC-13 condition. |
| A10 | Upstream eager start has no persistent-workspace support (absence) | Register row 9 | Pool experiment design changes; rig experiment confirms. |
| A11 | No upstream FIPS build for Harbor or Zot | Register row 17 | A documented build would close a gap sooner. |
| A12 | CVE-2026-8830 is a separate issue whose fix version was not checked | Register row 3 | An unfixed WebAuthn policy bypass could remain in the pinned version. Check before pinning. |
| A13 | Playwright 1.61+ `browserContext.credentials` exists | Browser sample | Irrelevant if the CDP path is used. |
| A14 | Control ids proposed in the traceability table | Section 10 table | Rows would not appear; verified against the Medium profile for the ids listed. |
| A15 | `kubectl` is Apache-2.0 and available on the rig | Standard Stack | A different client could be used. |

## Open Questions

1. **Component granularity and ids (reconcile with Phase 47).** Phase 48 CONTEXT D-17 assumes fourteen fine-grained ids. Phase 47's context (D-53, branch `docs/phase-47-plan`) suggests area-level ids for register entries: "for example `deploy-platform`, `deploy-identity`, `deploy-sessions`, `deploy-secrets`", reusing `hub` and adding component files "only if the checker requires them". Phase 46's context files workbench resources under `extension` until this phase adds `workbench`. Because a hosted control reads Met only when every in-scope component row is Met or reviewed Not applicable, fewer components make the hosted rows meaningful sooner. **Recommendation:** at plan time read the landed Phase 47 plan; adopt whichever ids it uses; if it uses `deploy-*`, create those component files (one per area, statements naming several products where honest) and make `workbench`, `hub`, `release-pipeline` the other in-scope components; keep D-17's fine-grained ids only where Phase 47 already chose them. The owner decides if the two disagree.
2. **Hosted scope shape.** Two entries (Protected A and B), no hosted overlays yet, and an owner note that hosted levels will read mostly Not met until statements land. D-18 default says "and their overlays"; recommend deferring them (nearly all rows are Your organization's responsibility). Owner confirms.
3. **Fence conflict on `scripts/resource-check.mjs`.** D-19 wants fit entries for load-test tools; the checker only discovers listed manifests. Either approve a one-line `PACKAGE_FILES` addition for `loadtest/package.json` in the single gate PR (Phases 46 and 47 edit the same line, so coordinate order), or keep the harness dependency-free and pin Playwright through Phase 46's `workbench/`. Recommendation: approve the one-line edit.
4. **Export freshness and transport.** Window `settings` (7 days) recommended; alternatives 24 hours (`audit`) or 30 days (`harness`). Transport recommendation: the signed export is a committed file under a non-gate folder updated by a reviewed PR (no workflow or secret needed; trust is the key list in a gate file). Automating through a release asset or a scheduled workflow is a later change (`.github/` is a gate path). Owner picks the window.
5. **Ingress reload metric.** On the rig, list the HAProxy and Traefik series and store the names; if a reload histogram exists, add it beside route propagation.
6. **Active-frontend share.** The browser sample size M is bounded by generator memory. A time-boxed spike on a headless RPC client could raise it; go or no-go after measuring one browser's cost.
7. **Hub load driver.** `hub/test/helpers/` (`hubWorld.ts` builds signed entries, `hubClient.ts` holds a pinned TLS 1.3 connection) is the nearest reusable driver `[VERIFIED: file list and headers read]`, but it imports `@ext/domain/...` aliases and lives under `hub/test`. Cross-package import from `loadtest/` needs a small path setup, or the driver runs from a hub script. Highest-risk piece of VER-02 "load per hub"; schedule it last in the harness.
8. **Rig hardware.** Owner item 1. Until it exists the plan produces a harness proven against fixtures and a small lab, a `dry-run` run file the docs check refuses, and a recorded "not reached" for every stage the hardware cannot hold.
9. **Export signing key custody.** Dedicated operator-held key (recommended) versus OpenBao Transit on the lab rig (acceptable for the lab, recorded).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node | harness, compliance package | yes | v24.22.3 | — |
| npm | lockfiles, `npm ci` | yes | (with Node) | — |
| `systemd-run`, `choom`, `timeout` | capped test runs | yes (ran the capped runner in scratch) | — | — |
| Python 3 | ad hoc checks only | yes | system | not required by the harness |
| Docker, Podman | image builds, small lab | yes | system | — |
| `kubectl`, `helm`, `kind`, `k3s`/`rke2` | rig access, lab shakedown | no on this machine | — | on the rig; for a lab shakedown install kind or k3s on a connected host |
| Prometheus, Harbor, Keycloak, OpenBao, Theia Cloud | the run | no (Phase 47 stack on the rig) | — | none: the load test needs the stack |
| `oras`, `skopeo`, `cosign`, `syft`, `grype` | image evidence | no on this machine | — | Phase 46 and 47 pin their own copies in CI |
| Compliance package dependencies | collector tests | not installed in the worktree | `npm --prefix compliance ci --ignore-scripts` works (ran in scratch: 12 packages) | — |
| Test rig hardware | VER-01 stages | unknown | — | **Blocking for the 1,000 stage.** This machine has 16 cores and 28 GiB. Record stages not reached (D-10). |
| HSM | `kms-pkcs11` experiment | no | — | SoftHSM2 proves wiring only; certificate item stays a gap |

**Missing with no fallback:** the rig itself (1,000-session stage, hub-under-load, Traefik, prewarm, step-up, CRL experiments).
**Missing with fallback:** local lab tools (install on demand); HSM (SoftHSM2 wiring test).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `node:test` through the repository runner `scripts/run-tests.mjs`; TypeScript run by Node 24 type stripping in `compliance/`; `.mjs` tests in `docs-site/` |
| Config file | none; `compliance/package.json` scripts call the same runner (`npm --prefix compliance ci --ignore-scripts` once per checkout) |
| Quick run command | `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 300 node scripts/run-tests.mjs compliance/test/collectorDeployment.test.ts` |
| Full suite command | `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 300 npm --prefix compliance test` then the same wrapper with `node scripts/run-tests.mjs docs-site/test/*.test.mjs loadtest/test/*.test.ts` (one heavy run at a time) |

(I ran the runner in a scratch copy with the exact wrapper: `levels.test.ts` passed 3 of 3 with a hosted level present.)

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| VER-01 | Stage controller holds, bursts, and records a stage it cannot reach with a reason | unit (fake service) | `... node scripts/run-tests.mjs loadtest/test/stages.test.ts` | no, Wave 0 |
| VER-02 | Run file hashes canonically, verifies, refuses a tampered file, passes the secret scan, stores queries | unit | `... loadtest/test/runfile.test.ts` | no, Wave 0 |
| VER-02 | Percentiles (nearest rank), start-time derivation from object timestamps, reconcile throughput windows | unit on fixtures | `... loadtest/test/measure.test.ts` | no, Wave 0 |
| VER-03 | Docs check fails on a hand-typed figure, passes generated text, refuses a `dry-run` source and an unreached stage printed as a number | unit | `... docs-site/test/capacityFigures.test.mjs` | no, Wave 0 |
| VER-04 | Every component in `levels.json` has a definition file; definitions load; one responsibility per requirement | unit (extend `levels.test.ts`, edit `components.test.ts` id list) | `... compliance/test/levels.test.ts compliance/test/components.test.ts` | yes (edit) |
| VER-05 | Every statement has a rule; every test rule resolves in the checkout | existing tests | `... compliance/test/components.test.ts` | yes |
| VER-06 | Collector: valid export yields allow-listed observations; tampered, wrong purpose, unknown key, oversize, future-dated export is refused and yields no observation; collector derives pass from counts; `collectedAt` equals signed time | unit with a fixture signer | `... compliance/test/collectorDeployment.test.ts` | no, Wave 0 |
| VER-06 | Window: `deployment` evidence older than 7 days reads Stale, not Met | unit (extend `evidenceRules.test.ts`) | `... compliance/test/evidenceRules.test.ts` | yes (edit) |
| VER-07 | Hosted level lists every hosted component and every row traces to a rule and a result; a fixture export with a lapsed date shows Stale | integration on `buildDashboard` with the real level and component files | `... compliance/test/dashboard.test.ts` (add one case) | yes (edit) |
| VER-08 | Section 10 table rows each map to a statement-with-rule or a gap with `ownerRole` and a POA&M milestone | unit over `gaps.json` and `poam/` (extend `gaps.test.ts`) | `... compliance/test/gaps.test.ts` | yes (edit) |
| VER-09 | Verification records document has the headings and a fresh `Last reviewed` (documents collector); each open item has a gap with an owner and a date | existing collector test plus one `gaps.test.ts` assertion | `... compliance/test/collectorDocuments.test.ts` | yes (edit) |

Not tests (manual or rig, recorded as run files): the load stages themselves; Traefik, prewarm, step-up, `kms-pkcs11` and CRL experiments; owner checkpoints on gate PRs; the check that the production realm and offline bundle contain no load-test client (Phase 47 test, coordinate).

### Sampling Rate
- **Per task commit:** the single mapped test file with the capped wrapper.
- **Per wave merge:** `npm --prefix compliance test` and `node scripts/resource-check.mjs`, then docs and loadtest tests.
- **Phase gate:** full suite once, `node compliance/src/cli.ts validate`, a local `bundle` build with the real hosted levels (as run in scratch), and the dashboard JSON inspected for the hosted scope before `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] `loadtest/` folder, `package.json`, lockfile, test scaffold (fake service, fake Prometheus, fake kubectl output).
- [ ] `compliance/test/collectorDeployment.test.ts` and a fixture signer (generate an Ed25519 key in the test; no key material committed).
- [ ] `docs-site/test/capacityFigures.test.mjs`.
- [ ] Edit `components.test.ts` id list; add the levels-reference-real-components test to `levels.test.ts`.
- [ ] `npm --prefix compliance ci --ignore-scripts` in the worktree.
- [ ] Reconcile component ids with the landed Phase 46 and 47 plans (Open Question 1).

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (test realm) | Direct grant only in the load-test client of the test realm; production realm has no password or OTP path; per-run generated test passwords kept in the rig's secret store |
| V3 Session Management | yes | Token lifespan set to the stage; sessions stopped at stage end; no token in run files |
| V4 Access Control | yes | Service enforces user equals token user; load-test admin role never used for user-scoped calls |
| V5 Input Validation | yes | Export parsed through a strict allow-list after signature check; size limit from `MAX_PAYLOAD_BYTES` (256 KiB) in `signed.ts`; run files validated before the capacity page renders |
| V6 Cryptography | yes | Ed25519 envelope via `verifyEnvelope`; SHA-256 via `node:crypto`; never hand-rolled |
| V8 Data Protection | yes | Evidence holds ids, counts, hashes, times, pass or fail (D-13); `redactObservation`; secret scan on run files and bundle |
| V10 Malicious Code and supply chain | yes | Exact-pinned Playwright, `npm ci --ignore-scripts`, register entry; downloaded browser builds mirrored and checksummed |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Forged or edited site export | Tampering, Spoofing | Envelope signature plus trust list in a gate file; wrong purpose or unknown key is refused |
| Replay of an old valid export | Repudiation | `collectedAt` is the signed time, so replay only shows Stale |
| Site script lies about pass or fail | Tampering | Collector derives pass or fail from counts under thresholds in gate-path source |
| Compromised OpenBao signs its own evidence | Elevation | Dedicated operator-held signing key (HSM-backed where available) |
| Test realm or load-test client reaches production or the offline bundle | Elevation | Phase 47 render test asserts none; harness refuses to run against a realm marked production |
| Secrets or personal data in run files and evidence | Information disclosure | Allow-listed fields only; secret scan; no emails of real people (synthetic identities) |
| Capacity claim without a recording | Repudiation | Generated capacity page and docs test (VER-03) |
| Overclaiming certificates | Spoofing | Desk record states source address, date and exact wording; unconfirmed items stay gaps; SoftHSM2 never evidence |

## Wave guidance (for the planner)

Independent pieces (no shared files, DB or port) and the single dependency each has:

- **Wave 0 (serial, small):** install compliance dependencies; reconcile component ids against landed Phase 46 and 47 plans; scaffold `loadtest/`.
- **Gate PR 1 (owner checkpoint), early:** `levels.json` hosted entries, no-statement component files, `deployment` collector with its window entry, registration in `bundle.ts`, level ids in `controlText.ts`, `site-signers.json`, edited tests, and the `ci.yml` input. This puts every gap on the dashboard immediately (D-11) and uses one approval.
- **In parallel with Gate PR 1 (non-gate):** the `loadtest/` harness (service client, stages, measurement, run file, capacity page and docs test); desk records document, `gaps.json` and POA&M items; the Playwright sample; the hub driver spike last.
- **Rig track (needs hardware, owner):** dry-run shakedown, then stages, then experiments; each result is a committed run file and a register row.
- **Gate PR 2 and 3:** statements, rules and report packages per component batch, as Phase 46 and 47 behaviour and tests land; one PR per batch rather than per component (D-27); include the `resources.json` re-pointing from `extension` to `workbench` and the `PACKAGE_FILES` line if approved.
- **Docs:** hosted accreditation page(s) in `docs-site/content/accreditation/` (not gate), generated capacity page, verification register page.

## Sources

### Primary (HIGH confidence)
- Repository files read this session: `compliance/README.md`, `levels.json`, `schemas/levels.schema.json`, `schemas/evidence-rule.schema.json`, `schemas/gaps.schema.json`, `schemas/poam-item.schema.json`, `schemas/tailoring.schema.json`, `schemas/resources.schema.json`, `src/{components,dashboard,status,model,rules,gaps,bundle,cli,signed,redact,tailoring,responsibility,controlText,package}.ts`, `src/collectors/{types,documents,attestations,sbom,release,tests,audit,crypto,github}.ts`, `src/commands/bundle.ts`, `test/{levels,components,componentsLoader,evidenceRules}.test.ts`, `components/{appliance,hub}.json`, `evidence-rules/hub.json`, `resources.json`, `scripts/resource-check.mjs`, `scripts/lib/workflow.mjs:595-619`, `.github/workflows/ci.yml` (compliance job), `.github/CODEOWNERS`, `docs-site/src/compliance/lib.mjs`, `docs-site/scripts/{compliance-refresh,serve}.mjs`, `docs-site/test/pages.test.mjs`, `hub/src/health.ts`, `hub/test/helpers/*`, `.planning/research/multiuser-hosting/{DESIGN,RESEARCH}.md`, `.planning/research/multiuser-sync/DESIGN.md:441`, `.planning/ROADMAP.md` Phases 46 to 48, Phase 44 CONTEXT, Phase 46 and 47 CONTEXT (branches `docs/phase-46-plan`, `docs/phase-47-plan`; their plans do not exist yet).
- Scratch experiments (copy of `compliance/`, `npm ci --ignore-scripts`, Node v24.22.3): real `bundle` command with a hosted level and a no-statement component; `levels.test.ts` and `components.test.ts` with the capped runner.
- Theia Cloud source on main via `gh api`: `documentation/{openapi.json,Architecture.md,Keycloak.md}`, `java/service/.../{BaseResource,AdminOnlyFilter,TheiaCloudUser,application.properties}`, `java/operator/.../{TheiaCloudIngressUtil,LeaderElectionTheiaCloudOperatorLauncher,EagerSessionHandler,LazySessionHandler}`, `java/common/.../{ResourceStatus,OperatorStatus,SessionStatus}`, `node/monitor/README.md`; `theia-cloud-helm charts/theia-cloud/values.yaml` and templates.
- NIST CMVP certificate pages (csrc.nist.gov): 4684, 4743, 4745, 4765, 4857, 4943, 5223, 5247, 5329, 5573, 5581.
- go.dev/doc/security/fips140; keycloak.org/2026/05/keycloak-2662-released; bugzilla.redhat.com/show_bug.cgi?id=2460004; github.com/keycloak/keycloak (releases, compare API); access.redhat.com/compliance/fips; docs.rke2.io/networking/networking_services; etcd.io/docs/v3.5/dev-guide/limit and /metrics; kubernetes.io/docs/setup/best-practices/cluster-large.
- Theia v1.77.0 `package.json` and `.github/workflows/ci-cd.yml` via `gh api`.

### Secondary (MEDIUM confidence)
- eduide.github.io/Docs/developer/platform/session-prewarming and /developer/projects/theia-scale-tests (derivative project docs, fetched and summarised).
- haproxy.com/documentation/kubernetes-ingress/administration/metrics (truncated read).
- utimaco.com blog page on Se-Series FIPS 140-3 (vendor statement without a certificate number).
- GitHub API licence fields for grafana/k6, locustio/locust, microsoft/playwright, artilleryio/artillery, prometheus/prometheus.

### Tertiary (LOW confidence, marked)
- Community guides on Playwright and CDP WebAuthn (search summaries only).
- Third-party FIPS images for Harbor and Zot (search summaries).

## Metadata

**Confidence breakdown:**
- Standard stack: MEDIUM-HIGH. Harness stack is lean and verified for licences and versions; kubectl and Prometheus are rig tools I could not inspect.
- Architecture: HIGH for the compliance side (read and run); MEDIUM for the load side (service and operator read, nothing run against a cluster).
- Pitfalls: HIGH for compliance and gate behaviour (run or read); MEDIUM for scale behaviours marked `[ASSUMED]`.
- Verification items: HIGH for rows with NIST or official pages; LOW for Utimaco mapping, Harbor and Zot, RKE2 Traefik FIPS.

**Research date:** 2026-11-23
**Valid until:** 2026-12-07 for certificate and release facts (NIST updates and Keycloak, Theia Cloud and Go releases move quickly); 30 days for the compliance-machinery findings unless Phases 46 or 47 change the shared files first.
