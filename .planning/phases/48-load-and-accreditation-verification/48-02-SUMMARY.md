---
phase: 48-load-and-accreditation-verification
plan: 02
subsystem: compliance
status: complete
tags: [compliance, deployment-evidence, signed-export, collector, site-export]
requires: []
provides:
  - "deployment collector (id deployment, window settings) over a signed site export"
  - "site-export command and compliance/site-export/collect.sh"
  - "compliance/attestations/site-signers.json (empty trust list)"
affects: [48-06, 48-09]
tech-stack:
  added: []
  patterns:
    - "signed.ts envelope with purpose site-evidence-export; collectedAt = signedAt"
    - "strict frozen fact allow-list; pass derived in collector source"
key-files:
  created:
    - compliance/src/collectors/deployment.ts
    - compliance/src/siteExport.ts
    - compliance/src/commands/site-export.ts
    - compliance/site-export/collect.sh
    - compliance/attestations/site-signers.json
    - compliance/test/collectorDeployment.test.ts
    - compliance/test/siteExport.test.ts
    - compliance/test/fixtures/collectors/deployment/
  modified:
    - compliance/src/rules.ts
    - compliance/src/bundle.ts
    - compliance/src/cli.ts
    - compliance/src/riskAcceptance.ts
    - compliance/test/dashboard.test.ts
    - compliance/test/bundle.test.ts
    - compliance/README.md
decisions:
  - "The deployment export's signing time is its export time, and the collector refuses an export whose generatedAt differs from signedAt (export-time-mismatch), so the 7-day window starts when the facts were collected."
  - "The fact allow-list carries one hash leaf (kubernetes.auditPolicySha256) beyond the counts, booleans, enums and two versions, because the audit policy's SHA-256 is the observation hash."
  - "registry.unsignedImageResults counts every current fail or error result of the image policies in the policy reports, which is stricter than a last-day count."
  - "site-signers.json is excluded from loadRiskAcceptances, and loadSigners' checks are shared through parseSigners."
metrics:
  duration: "18 min"
  completed: 2026-11-24
estimate:
  tokens: 138072
  tasks: 3
actuals:
  tokens: 31400
  tasks: 3
  commits: 6
plan_head_before: bbba39932adf4539852b4ca61820babe371ff6f7
plan_head_after: 46244e3ef3764e4e50e12961715aad5c2d3b7119
---

# Phase 48 Plan 02: Deployment evidence path Summary

A site's read-only outputs become a signed `site-evidence-export` envelope. The new `deployment` collector checks that envelope offline against a gate-file trust list. It then emits sixteen observations that hold only counts, each dated at the export's signed time, so an export older than 7 days reads Stale.

## What was built

- **`compliance/src/collectors/deployment.ts`**: `SITE_EXPORT_PURPOSE = 'site-evidence-export'`, the frozen fact allow-list `FACT_SHAPE`, the threshold constants, sixteen checks written as pure functions (`CHECKS`), and `deploymentCollector` (id `deployment`, window `settings`, input `{ file, signersFile }`).
- **`compliance/src/siteExport.ts`**: one reader with a size cap for each collected file, plus `readSiteFacts(dir)`, `buildUnsignedExport`, `signExport`, `attachSignature`, `parseUnsignedExport` and a secret-scan refusal over the canonical envelope.
- **`compliance/src/commands/site-export.ts`**, registered in `cli.ts`. It has three modes: `--key`, or `--public-key` with `--emit-signing-input`, then `--unsigned` with `--attach-signature`.
- **`compliance/site-export/collect.sh`**: POSIX sh using read-only commands only.
- **`compliance/attestations/site-signers.json`**: `{"signers": []}`.
- **Engine wiring**: `rules.ts` has `deployment: 'settings'`, and `bundle.ts` appends `deploymentCollector` to `COLLECTORS` (13 collectors now).
- **README**: a new "Hosted deployment evidence" section.

## Fact allow-list (every key required, nothing else accepted)

| Group | Facts |
|---|---|
| keycloak | `distribution` (upstream, redhat, other), `version`, `fipsMode` (strict, non-strict, disabled), `passwordAuthenticators`, `otpAuthenticators`, `loadTestClients`, `userEventsEnabled`, `adminEventsEnabled`, `eventsLastDay` |
| openbao | `version`, `sealType` (pkcs11, shamir, transit, other), `auditDevices`, `auditEventsLastDay` |
| kubernetes | `auditPolicySha256`, `sessionsAudited`, `workspacesAudited`, `auditEventsLastDay`, `nodes`, `fipsNodes` |
| registry | `kind` (zot, harbor, other), `enforcingImagePolicies`, `unsignedImageResults`, `auditEventsLastDay` |
| images | `locked`, `signatureVerified`, `sbomVerified`, `provenanceVerified` |
| workbench | `sampledSessions`, `fipsSessions` |

Leaf types:
- Counts are non-negative safe integers.
- Versions match `VERSION_PATTERN`.
- The hash is 64 lower-case hex characters.

The payload is exactly `{ schema: 1, site, generatedAt, facts }`.

## The sixteen subjects and thresholds

| Subject | Passes when | Counts |
|---|---|---|
| keycloak/no-password-authenticator | passwordAuthenticators <= 0 | password-authenticators |
| keycloak/no-otp-authenticator | otpAuthenticators <= 0 | otp-authenticators |
| keycloak/no-load-test-client | loadTestClients <= 0 (prefix `loadtest-`) | load-test-clients |
| keycloak/cve-2026-6856-fixed | distribution upstream and version >= `KEYCLOAK_MIN_FIXED` 26.8.0, compared by number | below-fixed-version, unconfirmed-build |
| keycloak/events-shipped | user and admin events on and eventsLastDay >= 1 | events-last-day, user-events-off, admin-events-off |
| keycloak/fips-strict | fipsMode strict | not-strict |
| openbao/audit-device | auditDevices >= 1 and auditEventsLastDay >= 1 | audit-devices, events-last-day |
| openbao/hsm-seal | sealType pkcs11 | not-pkcs11 |
| kubernetes/audit-session-workspace | sessions and workspaces audited and auditEventsLastDay >= 1; hash = policy SHA-256 | unaudited-resources, events-last-day |
| kubernetes/fips-nodes | nodes >= 1 and fipsNodes = nodes | nodes, fips-nodes |
| registry/signature-enforced | enforcingImagePolicies >= 1 and unsignedImageResults <= 0 | enforcing-policies, unsigned-results |
| registry/audit | auditEventsLastDay >= 1 | events-last-day |
| images/signed, images/sbom, images/provenance | locked >= 1 and verified = locked | images, verified |
| workbench/fips-provider | sampledSessions >= 1 and fipsSessions = sampledSessions | sampled, fips-on |

## Refusal codes (collector errors; no observation is returned)

- `invalid-input`
- `signers-missing`, `signers-unreadable`, `signers-too-large`, `signers-invalid`
- `export-missing`, `export-unreadable`, `export-too-large` (file over 512 KiB, or canonical envelope over 256 KiB)
- `export-malformed`, `export-unsupported-version`, `export-wrong-purpose`, `export-key-mismatch`, `export-signed-in-future`, `export-bad-signature`, `export-unknown-key`
- `export-invalid-payload`, `export-unknown-fact`, `export-missing-fact`, `export-wrong-fact-type`, `export-time-mismatch`

## Upstream formats each reader follows

| File | Source | Format checked |
|---|---|---|
| keycloak-realm.json | `kcadm.sh get realms/<realm>` plus `get authentication/flows/<alias>/executions` for each bound flow | Keycloak Server Administration Guide, admin CLI section (keycloak.org/docs/latest/server_admin, read 2026-11-24); RealmRepresentation flow bindings; AuthenticationExecutionInfoRepresentation `providerId`, `requirement` |
| keycloak-serverinfo.json | `kcadm.sh get serverinfo` | `systemInfo.version`; `cryptoInfo.cryptoProvider` is the simple class name: `Fips1402StrictCryptoProvider` (strict), `FIPS1402Provider` (non-strict), `DefaultCryptoProvider` (disabled). Verified in keycloak/keycloak source: `common/.../FipsMode.java` and `ServerInfoAdminResource.createCryptoInfo` |
| keycloak-clients.json | `kcadm.sh get clients --fields clientId` | ClientRepresentation `clientId` |
| openbao-status.json | `bao status -format=json` | OpenBao `/sys/seal-status` docs (`type`, `version`; openbao/openbao website/content/docs/api/system/seal-status.mdx); seal type `pkcs11` (docs/configuration/seal/pkcs11.mdx) |
| openbao-audit.json | `bao read -format=json sys/audit` | OpenBao `/sys/audit` docs (map of path to `{ type, ... }`) |
| kubernetes-audit-policy.yaml | the RKE2 server's audit policy file | `audit.k8s.io/v1` Policy, rules first match, levels None, Metadata, Request, RequestResponse; Theia Cloud group `theia.cloud`, resources `sessions` and `workspaces` |
| nodes-fips.json, workbench-fips.json | `/proc/sys/crypto/fips_enabled`; `node -p "crypto.getFips()"` | 1 or 0 |
| kyverno-clusterpolicies.json | `kubectl get clusterpolicies.kyverno.io,imagevalidatingpolicies.policies.kyverno.io -o json` | Kyverno website docs: ImageValidatingPolicy `spec.validationActions: [Deny]` (policy-types/image-validating-policy.mdx); ClusterPolicy `validationFailureAction` and the `failureAction` field (guides/migration-to-cel.md) |
| kyverno-policyreports.json | `kubectl get policyreports,clusterpolicyreports.wgpolicyk8s.io -A -o json` | `results[].policy`, `results[].result` in pass, fail, warn, error, skip |
| images.json | `cosign verify` JSON output and `cosign verify-attestation` DSSE statements (predicateType, subject) for each digest in `deploy/bundle/images.lock.json` | `critical.image.docker-manifest-digest`; SPDX or CycloneDX predicate types; `https://slsa.dev/provenance/v*` |
| counts.json | OpenSearch `GET /<index>/_count?q=<time>:[now-1d TO now]` for each stream | `count`, `_shards.failed` |

The OpenSearch `_count` response shape and the cosign output shapes were not fetched from upstream in this session. They come from known tool behaviour, and 48-09 confirms them on the rig.

## Verification

- **Task 1:** lint, plus collectorDeployment, dashboard, bundle and riskAcceptance tests: 50 of 50 passed.
- **Task 2:** lint, plus collectorDeployment, dashboard, redaction and riskAcceptance tests: 51 of 51 passed. `validate` and `word-lint compliance/README.md` were clean, and the site-signers check exited 0.
- **Task 3:** lint, `sh -n collect.sh`, plus siteExport, collectorDeployment and cli tests: 22 of 22 passed. The full `npm --prefix compliance test` run passed 512 of 512, with 0 skipped.
- **Tests added:** collectorDeployment.test.ts has 7 tests and siteExport.test.ts has 9. dashboard.test.ts gained 3 (Met, Stale, and the 7-day edge). The bundle.test.ts count changed from 12 collectors to 13.
- **Acceptance greps:**
  - `deployment: 'settings'` appears once in rules.ts.
  - `deploymentCollector` appears twice in bundle.ts.
  - `site-evidence-export` appears once in deployment.ts.
  - `cve-2026-6856-fixed` appears once in deployment.ts.
  - `^## Hosted deployment evidence` appears once in the README.
  - `'site-export'` appears once in cli.ts.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The bundle test counted 12 collectors**
- **Found during:** Task 1.
- **Issue:** Appending `deploymentCollector` makes 13 collectors.
- **Fix:** Changed the asserted count in `compliance/test/bundle.test.ts` to 13.
- **Commit:** e863807c

**2. [Rule 1 - Bug] site-signers.json would have been read as a risk acceptance**
- **Found during:** Task 1.
- **Issue:** `loadRiskAcceptances` judges every `*.json` in `attestations/` except `signers.json`. The new trust list would have shown up as a refused acceptance on the Evidence page.
- **Fix:** Added `SITE_SIGNERS_FILE` and excluded it there. `loadSigners`' checks were also extracted into `parseSigners`, as the plan allowed, so the collector can check the trust list text.
- **File:** `compliance/src/riskAcceptance.ts` (gate file).
- **Commit:** e863807c

**3. [Plan detail] External signer options**
- **Issue:** `--emit-signing-input` needs the signer's public key inside the signed bytes, and attaching needs the exact unsigned envelope.
- **Fix:**
  - The emit mode takes `--public-key` and writes the unsigned envelope to `--out`.
  - The attach mode takes `--unsigned <file> --attach-signature <file> --out <file>` without `--sources` or `--site`.
  - `parseUnsignedExport` rebuilds the envelope from its payload and refuses any difference.

**4. [Plan detail] Registry kind and counts**
- **Issue:** None of the plan's files carries the registry product.
- **Fix:** `counts.json` is `{ windowHours: 24, registryKind, streams: { keycloak, openbao, kubernetes, registry } }`, and `collect.sh` fills `registryKind` from `REGISTRY_KIND`.

**5. [Plan detail] Secret scan without the allow marker**
- **Issue:** `scanLine` skips any line that carries the allow marker.
- **Fix:** The scan uses `matchRules`, the core of `scanLine`, which ignores that marker, so a payload cannot opt itself out.

**6. [Plan detail] Fixture moves**
- **Change:** The realm and client fixtures moved into `fixtures/collectors/deployment/site/` beside the other collected files.
- **Additions:** A test-only `helpers.ts` (generates keys at run time) and a `facts.json` that equals what the readers derive from `site/`.

### Gate files touched

`compliance/src/` (collectors/deployment.ts, siteExport.ts, commands/site-export.ts, cli.ts, rules.ts, bundle.ts, riskAcceptance.ts) and `compliance/attestations/site-signers.json`. These join gate PR 1 that 48-06 opens with the owner checkpoint (D-27). No CI wiring was changed; that is 48-06.

## Known limitations (for 48-09)

- **Realm flows:** The realm reader counts only realm-bound flows. Client-level `authenticationFlowBindingOverrides` are not read.
- **Kyverno:** The reader handles the cluster-scoped kinds only (ClusterPolicy, ImageValidatingPolicy). Namespaced Kyverno `Policy` objects are not counted as enforcing.
- **Formats:** Every reader follows upstream formats that have not been run on the rig. 48-09 runs `collect.sh` there and fixes any difference. That includes the Kyverno report kind, which may be `openreports.io` in newer Kyverno.
- **Red Hat build:** A Red Hat build of Keycloak fails `keycloak/cve-2026-6856-fixed` by design until its fix version is confirmed (register row 3).

## Threat model coverage

| Threat | Mitigation and test |
|---|---|
| T-48-04 Spoofing | Wrong purpose, unknown key and bad signature are refused (tests). |
| T-48-05 Tampering | The allow-list is strict and a `passed` fact is refused (tests). |
| T-48-06 Repudiation | Observations are dated at `signedAt`, with the 7-day edge tested. |
| T-48-07 Information disclosure | The facts allow-list, the secret refusal and the leak assertions are tested. |
| T-48-08 Denial of service | There is a cap on each source file and on the export file, plus the 256 KiB envelope cap. |
| T-48-09 Elevation of privilege | Detached signing is supported for HSM-held keys, and the trust list is empty. |
| T-48-SC Tampering | No new package was added. |

## Checkpoints

None reached. Owner item for 48-09: add the reference site operator's public key to `compliance/attestations/site-signers.json`.

## Self-Check: PASSED

- **Files:** All files listed above exist.
- **Commits:** ad184cb8, e863807c, 1af26f65, 92154138, f854a62c and 46244e3e are on the branch.

## TDD Gate Compliance

Each task has a `test(48-02)` RED commit followed by a `feat(48-02)` GREEN commit: ad184cb8 then e863807c, 1af26f65 then 92154138, and f854a62c then 46244e3e.
