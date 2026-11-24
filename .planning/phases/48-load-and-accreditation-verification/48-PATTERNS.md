# Phase 48: Load and accreditation verification - Pattern Map

**Mapped:** 2026-11-23
**Files analyzed:** 17 (new or modified file groups)
**Analogs found:** 15 / 17 (two have no in-repo analog)

All analog paths below were checked as git-tracked source (`git ls-files` on the collector, test and docs-site test returned them). None is a gitignored mirror.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `compliance/src/collectors/deployment.ts` (gate) | collector | file-I/O + transform (signed envelope in, observations out) | `compliance/src/collectors/documents.ts` plus `compliance/src/signed.ts` `verifyEnvelope` | role-match |
| `compliance/test/collectorDeployment.test.ts` + `compliance/test/fixtures/collectors/deployment/*` | test | fixture-based | `compliance/test/collectorDocuments.test.ts` | exact |
| `compliance/src/rules.ts` (add `OBSERVATION_WINDOWS` entry, gate) | config | transform | the same table, lines 20-31 | exact |
| `compliance/src/bundle.ts` (add to `COLLECTORS`, gate) | registry | batch | `COLLECTORS` array, lines 26-31 | exact |
| `compliance/src/controlText.ts` (hosted level ids, gate) | config | transform | `CATALOGUES[].levels` arrays | exact |
| `compliance/attestations/site-signers.json` (gate) | config | trust list | `compliance/attestations/signers.json` | exact |
| `compliance/site-evidence/reference.json` | data | signed export file | none in repo; envelope per `signed.ts` | no analog |
| `compliance/components/<id>.json` (workbench, rke2, image-registry, ingress, cert-manager, keycloak, theia-cloud, oauth2-proxy, openbao, hsm, site-storage, site-logging, offline-bundle; gate) | model | OSCAL data | `compliance/components/hub.json` (statements), `appliance.json` (no statements) | exact |
| `compliance/evidence-rules/hosted-<area>.json` (gate) | config | rule data | `compliance/evidence-rules/hub.json` | exact |
| `compliance/levels.json` (add `hosted-protected-a/b`, gate) | config | data | entries at lines 1-30 | exact |
| `compliance/test/components.test.ts`, `levels.test.ts` (edit id list) | test | assertion | `components.test.ts` line 46-50 | exact |
| `compliance/gaps.json` + `compliance/poam/gNNN.json` | data | register | `gaps.json` G1, `poam/g02.json` | exact |
| `compliance/resources.json` (load-test tools only, gate) | config | register | existing entries | exact |
| `docs/security/hosted-verification-records.md` | document | desk records | `docs/security/*.md` plus `REQUIRED_DOCUMENTS` | role-match |
| `compliance/src/collectors/documents.ts` (add the new doc to `REQUIRED_DOCUMENTS`, gate) | collector | file-I/O | same file, lines 14-22 | exact |
| `loadtest/src/*.ts`, `loadtest/test/*.test.ts` | utility / test | request-response, batch | `compliance/` package layout (Node 24 type stripping, `node:test`) | partial |
| `loadtest/src/runfile.ts` | utility | transform (canonical hash) | `compliance/src/signed.ts` `canonicalize` | role-match |
| `docs-site/test/capacityFigures.test.mjs` | test | file-I/O | `docs-site/test/pages.test.mjs` | role-match |

## Pattern Assignments

### `compliance/src/collectors/deployment.ts` (collector, signed file in, observations out)

**Analog:** `compliance/src/collectors/documents.ts` (collector shape, injected `readFile`, counts-only observations, `collectedAt` taken from the evidence's own date) and `compliance/src/signed.ts` (verification).

**Collector interface** (`compliance/src/collectors/types.ts`):
```ts
export interface CollectorContext {
  readonly now: Date;
  readonly commit: string;
  readonly runUrl?: string;
  readonly fetchJson?: FetchJson;
  readonly readFile: (file: string) => Promise<string>;
}
export interface Collector<Input = unknown> {
  readonly id: string;
  readonly window: WindowKind;
  collect(input: Input, context: CollectorContext): Promise<Observation[]>;
}
```

**Frozen collector with typed input, required-input guard** (`documents.ts` lines 58-65):
```ts
export const documentsCollector: Collector<DocumentsInput> = Object.freeze({
  id: 'documents',
  window: 'document',
  async collect(input: DocumentsInput, context: CollectorContext): Promise<Observation[]> {
    if (!input || typeof input.repoRoot !== 'string' || input.repoRoot === '') throw new Error('documents collector: input.repoRoot is required');
```

**Date from the evidence, not the run** (`documents.ts`, observation push):
```ts
collectedAt: review?.toISOString() ?? context.now.toISOString(),
commit: context.commit,
counts: { missing: 0, 'missing-headings': missingHeadings, ... }
```
For deployment use `collectedAt: verdict.signedAt` so a lapsed export reads Stale.

**Envelope verification** (`signed.ts` 75-103; never throws, returns a verdict):
```ts
export interface TrustedKey { readonly fingerprint: string; readonly publicKey: string; }
export interface VerifyOptions { readonly purpose: string; readonly keys: readonly TrustedKey[]; readonly now: Date; readonly maxBytes?: number; }
export type EnvelopeVerdict =
  | { ok: true; payload: unknown; signer: TrustedKey; signedAt: string }
  | { ok: false; reason: EnvelopeFailure; message: string };
export function verifyEnvelope(envelope: unknown, options: VerifyOptions): EnvelopeVerdict
```
Also exported: `canonicalize`, `signingInput(purpose, unsigned)`, `fingerprintOf`, `isStrictBase64url`.

**Error handling:** on `!verdict.ok` throw `collectorError(...)` (`compliance/src/collectors/github.ts:15`, per RESEARCH) so the bundle records ran-and-failed and rules read `missing-result`. Derive `passed` in the collector from counts and thresholds in source; never trust the site's own flag.

**Redaction allow-list** every observation must satisfy (`compliance/src/redact.ts` 6-21): subject `^[a-z0-9][a-z0-9._/@:-]{0,127}$`, count keys `^[a-z][a-z0-9-]{0,31}$` with non-negative safe integers, 64-hex `hash`, ISO `collectedAt`, 40-hex `commit`, `runUrl` only `https://github.com/...`.

---

### `compliance/test/collectorDeployment.test.ts` (test, fixtures)

**Analog:** `compliance/test/collectorDocuments.test.ts`

**Imports, fixed clock and injected readFile** (lines 1-22):
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { CollectorContext } from '../src/collectors/types.ts';
import { redactObservation } from '../src/redact.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'collectors', 'documents');
const NOW = new Date('2026-11-21T00:00:00.000Z');
const COMMIT = 'c'.repeat(40);
function context(files: Readonly<Record<string, string>>): CollectorContext {
  return { now: NOW, commit: COMMIT, readFile: async (file) => {
    if (Object.hasOwn(files, file)) return files[file];
    throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
  } };
}
```
**Cases to copy:** exact `deepEqual` on one passing observation; an edge-of-window case (documents test checks 365 vs 366 days; here 7 days for `settings`); a missing-field case that asserts `passed: false` and counts; `assert.doesNotMatch(JSON.stringify(observation), ...)` to prove no raw text leaks. Add: wrong purpose, untrusted key, tampered payload each throw. Success criterion 2 fixture: an export older than 7 days produces Stale through `buildDashboard` (see `compliance/test/dashboard.test.ts`, not read; planner to check).

Fixture folders under `compliance/test/fixtures/collectors/` currently: audit, checkout, ci, crypto, documents, github, sbom, secret-scan, tests. Add `deployment/`.

---

### `compliance/src/rules.ts`, `bundle.ts`, `controlText.ts` (small registrations, gate)

**rules.ts** (lines 20-31): a collector with no entry is judged against the head commit and never goes stale. Add one line:
```ts
export const OBSERVATION_WINDOWS: Readonly<Record<string, WindowKind>> = Object.freeze({
  audit: 'audit',
  settings: 'settings',
  harness: 'harness',
  document: 'document',
  documents: 'document',
  crypto: 'document',
  attestation: 'attestation',
  attestations: 'attestation'
  // add: deployment: 'settings'
});
```

**bundle.ts** (lines 5-17 imports, 26-31 list; order is part of the public contract, append):
```ts
import { codeScanningCollector } from './collectors/codeScanning.ts';
export const COLLECTORS: readonly Collector[] = Object.freeze([
  testsCollector, ciCollector, secretScanCollector, documentsCollector, cryptoCollector, auditCollector, sbomCollector,
  releaseCollector, attestationsCollector, settingsCollector, reviewsCollector, codeScanningCollector
]);
```
A collector runs only if `collector.id in inputs.collectors` (line ~112), otherwise it records `ran: false`. The CLI and `.github/workflows/ci.yml` (compliance job near line 505, `["root","relay","hub"].map(...)`) must supply the `deployment` input and any new test-report packages (`NEAR_AI_TEST_REPORT: test-report-hub.ndjson`, ci.yml:346).

**controlText.ts** (`CATALOGUES`, e.g.): hosted level ids go into each catalogue's `levels` array:
```ts
{ file: 'itsp-10-033/catalog.json', source: 'itsp-10-033', pathPart: '/itsp10033', levels: ['unclassified', 'protected-a', 'protected-b'] },
```
Add `hosted-protected-a` and `hosted-protected-b` there or hosted rows show ids and no text drawer.

---

### `compliance/attestations/site-signers.json` (trust list, gate)

**Analog:** `compliance/attestations/signers.json` (current content `{"signers": []}`); entry shape per RESEARCH: `fingerprint`, `name`, `publicKey`, `role`; schema `compliance/schemas/signers.schema.json`. Do not reuse `signers.json` (its entries sign risk acceptances).

---

### `compliance/components/<id>.json` (OSCAL component definitions, gate)

**Analog with statements:** `compliance/components/hub.json`. **Analog with none:** `compliance/components/appliance.json`. File name equals component id (`scripts/resource-check.mjs` `knownIds` strips `.json`).

**Skeleton** (from `hub.json`; one component per file, `component-id` prop in NS `urn:near-ai-vscode:compliance`):
```json
{"component-definition":{"uuid":"<v4>","metadata":{"title":"Hub","last-modified":"2026-11-21T00:00:00Z","version":"0.1.0","oscal-version":"1.2.1"},
 "components":[{"uuid":"<v4>","type":"service","title":"Hub","description":"Optional synchronization hub.",
  "props":[{"name":"component-id","ns":"urn:near-ai-vscode:compliance","value":"hub"}],
  "control-implementations":[{"uuid":"...","source":"catalogs/itsp-10-033/catalog.json","description":"Hub recovery safeguards.",
   "implemented-requirements":[{"uuid":"...","control-id":"cp-09","description":"Hub restore drill.",
     "props":[{"name":"responsibility","ns":"urn:near-ai-vscode:compliance","value":"shared"}],
     "statements":[{"uuid":"...","statement-id":"cp-09_smt.restore","description":"...","remarks":"Your organization chooses backup schedules and recovery."}]}]}]}]}}
```
No-statement start (D-12): omit `control-implementations`; loader reads `?? []`. Exactly one `responsibility` prop per implemented requirement. Statement text describes only behaviour that exists; remarks say "Your organization ...". UUIDs here are hand-assigned sequential (`00000000-0000-4000-8000-000000004xxx`) for hub; any unique v4 is accepted.

`compliance/test/components.test.ts` line 46-50 hard-codes the six ids and must be edited:
```ts
test('all six component definitions load as OSCAL content', () => {
  const loaded = loadComponents(COMPONENTS);
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.components.map((component) => component.id), ['appliance', 'extension', 'hub', 'model-endpoints', 'relay', 'release-pipeline']);
});
```

---

### `compliance/evidence-rules/hosted-<area>.json` (rules, gate)

**Analog:** `compliance/evidence-rules/hub.json`

**Test rule** (file plus exact literal test name; id `^[a-z0-9][a-z0-9.-]{0,95}$`, convention `<component>.<control>.<topic>`):
```json
{"rules":[{"id":"hub.cp-09.restore","component":"hub","control":"cp-09","statement":"cp-09_smt.restore","kind":"test","test":{"file":"hub/test/restoreDrill.test.ts","path":[],"name":"restore drill: an old backup restored ..."}}]}
```
**Observation rule:** `kind: "observation"` with collector plus subject (schema `compliance/schemas/evidence-rule.schema.json`; planner should read an existing observation rule in `compliance/evidence-rules/extension.json` or `release-pipeline.json` for exact keys, not extracted here).

**Constraint:** `compliance/test/components.test.ts` "every mapped test rule has an exact literal target in the checkout" fails if the test is not merged. Land statement, rule and target together. The name must be a plain string literal (no `${}`).

---

### `compliance/levels.json` (hosted scope, gate)

**Analog:** the `protected-a` entry (lines ~20-30), same keys required by `levels.schema.json`: `id, title, kind, profile, components, claim`.
```json
{ "id": "protected-a", "title": "Protected A", "kind": "level", "profile": "profiles/protected-a.json",
  "components": ["extension","model-endpoints","relay","hub","release-pipeline"], "claim": true }
```
RESEARCH shows the `hosted-protected-b` entry uses `"profile": "profiles/itsp-10-033-01-medium.json"`; for `hosted-protected-a` use the profile the `protected-a` entry names (`profiles/protected-a.json` as above). The planner should confirm which profile file the existing `protected-b` entry uses and mirror it. Also edit `compliance/test/levels.test.ts` (not read).

---

### `compliance/gaps.json` and `compliance/poam/gNNN.json` (not gate paths)

**Analog:** `gaps.json` entry G1 and `poam/g02.json`.
```json
{ "closesInPhase": "44.1", "controls": ["ir-01"], "id": "G1", "ownerRole": "maintainers", "remediation": "...", "title": "..." }
```
```json
{ "controls": ["au-04"], "gap": "G2", "id": "g02",
  "milestones": [ { "phase": "32.1", "title": "..." }, { "targetDate": "2027-05-31", "title": "..." } ],
  "ownerRole": "maintainers", "remediation": "...", "title": "..." }
```
Existing POA&M files run `g02..g320` and `x01..x10`. Take the next free numbers. For D-24 unconfirmed desk items, use an owner role plus `targetDate` (VER-09). Keys are sorted alphabetically in both files; keep that.

---

### `docs/security/hosted-verification-records.md` (desk records, 365-day window)

**Analog:** `docs/security/*.md` and the `REQUIRED_DOCUMENTS` entry (`documents.ts` 14-22):
```ts
{ path: 'docs/security/threat-model.md', reviewRequired: true, headings: ['What is protected', 'Trust boundaries', 'Threats and mitigations', 'What the product cannot stop'] },
```
Rules: a line starting `Last reviewed: YYYY-MM-DD` in the first 40 lines (`LAST_REVIEWED_PATTERN = /^Last reviewed: (\d{4}-\d{2}-\d{2})/m`), exact `## ` headings, one H2 per closed item. Adding the doc to `REQUIRED_DOCUMENTS` is a gate-path edit and makes a missing file an observation that fails. Check how an existing doc such as `docs/security/crypto-inventory.md` opens (not read).

---

### `loadtest/` harness (utility, request-response + batch) and its tests

**Analog:** the `compliance/` package conventions: Node 24 built-in type stripping, no build step, `node:test` plus `node:assert/strict`, fixtures injected (`readFile`, `fetchJson`), ESM `.ts` imports with explicit `.ts` extensions (`import ... from './model.ts'`). `compliance/package.json` and `compliance/tsconfig.json` are the templates for `loadtest/package.json` (own lockfile, exact versions). Per CONTEXT open item 6, default is dependency-free; Playwright only for the browser sample, pinned to the Phase 46 release.

**Injectable network edge** (copy the idea from `FetchJson` in `types.ts`):
```ts
export type FetchJson = (url: string, init?: { readonly method?: string; readonly headers?: Readonly<Record<string, string>> }) => Promise<unknown>;
```
Service client, Keycloak token client, kubectl and Prometheus readers should all take injected functions so tests use fakes.

**Run-file hashing:** reuse `canonicalize` from `compliance/src/signed.ts` (sorted keys, safe integers only, no negative zero, no lone surrogates). Store durations as integer ms and bytes as integers. Secret scan: `import { scanLine } from '../../scripts/lib/workflow.mjs';` (as `compliance/src/redact.ts:4` does).

Heavy runs must use `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 300 ...`.

---

### `docs-site/test/capacityFigures.test.mjs` (test, file-I/O)

**Analog:** `docs-site/test/pages.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lintPage } from '../../compliance/src/wordLint.ts';

const pages = join(new URL('..', import.meta.url).pathname, 'content/accreditation');
test('pages have no prohibited claim wording', () => readdirSync(pages).filter((name) => name.endsWith('.mdx')).forEach((name) => assert.deepEqual(lintPage(readFileSync(join(pages, name), 'utf8'), name), [], name)));
```
Style: one-line `test(name, () => ...)` per rule, `.mjs`, path via `new URL('..', import.meta.url).pathname`, directly imports `.ts` from `compliance/src`. The new test should read the generated `docs/hosting/capacity.md`, require a run id and hash that matches a committed `loadtest/runs/*.run.json` (kind `load`, never `dry-run`), and fail on a bare capacity figure elsewhere. Accreditation page wording lint (`lintPage`) applies to any page added under `docs-site/content/accreditation`; a hosted-scope page there must keep "Your organization decides" opening (pages.test.mjs lines 12-15) if added to the `expected` list.

---

### `compliance/resources.json` (gate)

**Analog:** existing entries; keys visible: `id` (`npm:<name>`), `kind`, `where` (package file list), `component`, `scope`, `purpose`, plus more fields not extracted (planner: read one full entry and `compliance/schemas/resources.schema.json`). `scripts/resource-check.mjs` line 13 `PACKAGE_FILES` lists only `package.json, relay/package.json, hub/package.json, docs-site/package.json, compliance/package.json`; a `loadtest/package.json` is invisible unless that list is edited (CONTEXT open item 6).

## Shared Patterns

### Fail-closed evidence (all compliance files)
**Source:** `compliance/src/status.ts` and `rules.ts`. Met needs statement, rule and fresh passing result; unknown collector means window `head`; a collector error becomes `missing-result`; an in-scope component with no statement is `no-statement` (dashboard.ts 110-118). Do not add Not-applicable tailoring to improve hosted numbers; an unreviewed exclusion counts as not met.

### Counts-only evidence
**Source:** `compliance/src/redact.ts` allow-list (above). Apply to every new collector and run-file summary that enters the bundle.

### Test-name literal mapping
**Source:** `compliance/src/rules.ts` `hasStringLiteral` and `compliance/test/components.test.ts` target check. Apply to every test rule on Phase 46 and 47 tests; CI jobs for new packages must write `NEAR_AI_TEST_REPORT` ndjson and be listed in the compliance job.

### Gate paths
Gate edits batch into as few PRs as possible with an owner checkpoint (D-27). Non-gate: `compliance/site-evidence/`, `gaps.json`, `poam/`, `loadtest/`, `docs/`, `docs-site/test/`.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `compliance/site-evidence/reference.json` and the on-site export script | data / script | signed export | No site export exists; follow the `signed.ts` envelope (`signingInput(purpose, unsigned)` then attach `sig`). The extension's `src/domain/team/signedPayload.ts` is the original signer and parity test `signedParity.test.ts` is the reference. Planner should read those two before writing the script. |
| `loadtest/src/browser.ts` (Playwright with CDP WebAuthn virtual authenticator) | utility | browser automation | No Playwright code exists in the repo until Phase 46 lands; use RESEARCH section on the browser sample. |
| `loadtest/src/stages.ts`, `service.ts`, `measure.ts` | utility | stage control, REST, kubectl/Prometheus | No load or cluster client code exists; follow the `compliance/` conventions only for structure and injection. Use RESEARCH tables for Theia Cloud service endpoints. |

## Metadata

**Analog search scope:** `compliance/` (src, collectors, test, components, evidence-rules, attestations, gaps, poam, levels), `docs-site/test`, `docs/security`, `scripts/resource-check.mjs`, `hub/test` listing.
**Not read:** RESEARCH.md lines 382-735 (the file was truncated at 381; the open questions, section 10 traceability table, verification register draft and wave guidance were not consulted). The planner must read them. Also unread: `dashboard.test.ts`, `levels.test.ts`, existing observation-kind rule files, `signedParity.test.ts`.
**Files scanned:** about 20 read, directory listings for the rest.
**Pattern extraction date:** 2026-11-23
