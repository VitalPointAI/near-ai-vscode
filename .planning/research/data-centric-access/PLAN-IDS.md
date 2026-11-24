# Plan ids for the data-centric access work

Written 2026-11-24 on `docs/phase-71-core-plan`, from `RESEARCH.md` in this folder (owner decisions O1 to O11, all accepted) and the coordinator's AI-classification amendments of the same day. The planners amending 33.1, 47-19 to 47-21, 47-14 and 48.1 cite the ids below. Names marked **permanent** become part of signed objects or shared logs once a plan writes them.

## Phases

| Phase | Name | State |
|---|---|---|
| 71 | Identities and verified credentials (core), pulled forward | 14 plans in 9 waves. Keeps the ROADMAP number; re-scoped |
| 71.1 | Agent delegation that only narrows | Stub, 0 plans. DLGT-02 to DLGT-08 move here. Stays in Stage 1, before Phase 72 |
| 33.2 | Post-quantum cell keys (`cell-wrap/v2`) | 7 plans in 6 waves. Must merge before any site holds Protected B data |
| 45.1 | NATO and Five Eyes exchange, part 1: labels, binding, adapter, base TDF | 4 plans in 4 waves |
| 45.2 | NATO and Five Eyes exchange, part 2: ZTDF and the NATO texts | Stub, 0 plans. Trigger: your organization receives ACP-240 Ed A and ADatP-4774/4778 |

Research report rows map to these phases: B is 71-01 to 71-08; E is 71-09 to 71-13; the wrap (research plan 6) is Phase 33.2; I is 45.1; J is 45.2. The research's "plans 1 to 5" (verifier, `mayRelease`) are 71-03 to 71-07.

## Plans

| Id | Wave | What it delivers | Others wait for it |
|---|---|---|---|
| 71-01 | 1 | Tracer: one `ClearanceCredential` through our `eddsa-jcs-2022` profile, cross-verified with Digital Bazaar and the W3C vectors (research item a). Package check first | |
| 71-02 | 1 | Research: `did:webvh` hosting and caching, status list sizing and lifetimes, the FIPS posture for Ed25519 (O8) with the fallback ready. Verdict per item | 48.1-08 and 48.1-09 (key and crypto inventory facts) |
| 71-03 | 2 | The narrow VC 2.0 profile, every credential type below, the second suite `ecdsa-jcs-2019` | |
| 71-04 | 2 | `did:key` for devices (Phase 69 keys unchanged), `did:webvh` log verification from a cached copy | |
| 71-05 | 3 | Bitstring Status List: build, sign, verify, staple, cite by hash | |
| 71-06 | 3 | `credentials@1` and `agreements@1` policy sections; issuer authority chain; agents and devices never issue | 33.1-03 (`project.mode` cites the policy hash), 33.1-20 (`agreements[]`), 48.1-05 |
| 71-07 | 4 | The credential checker (API below) | 33.1-04, 33.1-19, 33.1-20, 33.1-23, 33.2-04, 45.1-03 |
| 71-08 | 5 | The person's wallet, the gate's clearance from credentials, the verifier tool `scripts/credential-check.mjs` | 47-19 (`guests.mjs create --approved-by`), 47-20 |
| 71-09 | 5 | Sync hub: serves logs and status lists, checks cited evidence on append and serve, revocation watch | 33.1-24 (observer server view), 33.1 observer waves |
| 71-10 | 6 | A person's `did:webvh` at first sign-in, your organization's root DID and role credentials (offline), binding a computer | |
| 71-11 | 6 | Trust export file `.near-trust-export` (logs, lists, issuer section) and its import at an edge | 47-14 (runs beside it; no shared file) |
| 71-12 | 7 | Issuance from the officer's own session (Issue credential card), status-list key in OpenBao, revoke and suspend, the wallet inbox | 33.1 observer waves (33.1-18 to 33.1-25), 47-20 (early end revokes) |
| 71-13 | 8 | Credential cache state in the session (`fresh`, `stale`, `unavailable`), key release in hosted sessions, tokens authenticate only | |
| 71-14 | 9 | SECURITY.md and docs, full suites once, verification record, integration PR | 48.1 statements (48 D-11: only what is on main) |
| 33.2-01 | 1 | Tracer: one epoch key wrapped with `cell-wrap/v2` and opened; research confirmations; permanent shapes checkpoint | |
| 33.2-02 | 2 | Second device key binding: `device.kem`, the descriptor's `kem` | |
| 33.2-03 | 2 | Grant pages | |
| 33.2-04 | 3 | `wrap@2` through `roster.require`, cutover rule in fold and hub, Protected B rule, CI check, SECURITY.md | 48.1-09 (X25519 open condition closes when this is on main) |
| 33.2-05 | 4 | Where the new private keys live: keyring, Transit envelope, hub | |
| 33.2-06 | 5 | Native Switch and Give keys cards; scheduled rekey per cell | |
| 33.2-07 | 6 | Close-out on the built image, integration PR | |
| 45.1-01 | 1 | Tracer: `labelInterop@1` table and the signed label binding | 33.1-21 (release copies carry the binding) |
| 45.1-02 | 2 | Base TDF manifest from the public OpenTDF spec; partner key access; receive key in OpenBao | |
| 45.1-03 | 3 | The exchange adapter at the release boundary; export record checkpoint | |
| 45.1-04 | 4 | Binding on every release copy and export; SECURITY.md; close-out | |

## Requirement ids (added to REQUIREMENTS.md on this branch)

- **Phase 71:** DLGT-01, VCRD-01 to VCRD-07, and new DCAC-01 to DCAC-06 (data-centric access control).
- **Phase 71.1:** DLGT-02 to DLGT-08 (moved from Phase 71).
- **Phase 33.2:** new WRAP-01 to WRAP-05.
- **Phase 45.1:** new XCHG-01 to XCHG-04. **Phase 45.2:** XCHG-05 to XCHG-08 (drafts until the texts arrive).

## Credential types (71-03; type names permanent)

Person attributes, each about one person `did:webvh` subject:

| Type | Claims | Issued by (role named in `credentials@1`) |
|---|---|---|
| `MembershipCredential` | `{ organization }` | Your organization (enrolment officer) |
| `ClearanceCredential` | `{ scale, atLeast }` (threshold; one per level held) | Security officer |
| `CompartmentCredential` | `{ compartment }` | Compartment owner |
| `ServiceCredential` | `{ serves }` (the six 33.1 values) | J1 or HR authority; security contact for allied military and industry |
| `NationalityCredential` | `{ nationality }` (ISO 3166-1 alpha-3 or a 48.1 D-25 group token) | Security officer or security contact. HQ issues `CAN` to staff at enrolment (O5) |
| `AffiliationCredential` | `{ organization }` | Security contact |
| `ExportEligibilityCredential` | `{ regime, basis }` | Designated official (CGP) or export-person authority (Phase 45) |
| `AccessAgreementCredential` | `{ agreement, scope }` | Security contact (PS-6) |
| `VisitClearanceCredential` | `{ request, site, from, until }` | Security contact |
| `ObserverAccessCredential` | `{ project, position, cells, until }` | Security contact |

Authority (role) credentials, issued from your organization's root (offline) or by a holder the policy allows:

| Type | Claims |
|---|---|
| `IssuerRoleCredential` | `{ credentialType, scale?, upTo?, compartments?, regimes? }`: may issue that type within those limits |
| `SecurityContactCredential` | `{ scope }` |
| `ReleaseAuthorityCredential` | `{ scope }` |
| `ClassificationAuthorityCredential` | `{ scale, upTo, scope }`: may lower or declassify up to `upTo`; `scope: own-items` is the originator's authority (AI-classification research 6.4) |
| `RoleCredential` | `{ role, scope }` |

Devices: `DeviceBindingCredential { device, class }` (issued by the person to a device `did:key`). Reserved for Phase 71.1: `DelegationCredential`. Status: the W3C `BitstringStatusListCredential`.

Not a credential: the organization-to-organization agreement is a record in the signed policy's `agreements@1` section (`{ id, partner, tokens, levelCeiling, compartments, until }`), cited by `marking.approve` and by exports.

## Structural rules the checker enforces

- **Agents and devices never issue** (AI-classification research 5.2, coordinator 2026-11-24). An issuer is your organization's root or a person `did:webvh` whose key is a Transit person key that signs only after a passkey step-up. `credentials@1` and every role credential name only person `did:webvh` subjects. A `did:key`, or any key that is the subject of a `DeviceBindingCredential` or a delegation, is refused as an issuer. Property test in 71-06.
- **Evidence by hash.** The fold checks only cited evidence; freshness is checked only at the enforcement points.
- **Releasability for every holder** of a marked cell (O5); full dominance (level and compartments) for observers too.
- **Revocation never clears.** Suspension clears only by an issuer of that type, with a step-up.

## Checker API (71-07 unless named; `src/domain/credentials/`, pure)

| Name | File | Use |
|---|---|---|
| `issueCredential(signer, unsigned, suite)`, `verifyCredential(value, options)`, `credentialHash(credential)` | `profile.ts` (71-03) | Sign, read and hash (SHA-256 of the JCS bytes, proof included) |
| `verifyStatusList(value)`, `statusAt(list, index, purpose)` | `statusList.ts` (71-05) | Read a signed list and one bit |
| `didKeyFromDevice(publicKey)`, `resolveDidKey(did)`, `verifyWebvhLog(log, cached?)` | `src/domain/did/` (71-04) | DIDs |
| `issuerAuthority(credential, roles, policy, didState)` | `issuerAuthority.ts` (71-06) | Is this issuer allowed to issue this, within its ceiling |
| `checkEvidence(citation, evidence, context)` | `evidence.ts` | **Fold-time.** Deterministic: proof, issuer authority under the cited policy, subject is the member's DID, dates at the entry's signed time, bit clear in the cited list, list valid at the entry's time within the level's maximum offline age |
| `mayRelease(facts, label, context)` | `mayRelease.ts` | **The decision** for every wrap, release and serve |
| `eligibleForPosition(facts, position)` | `mayRelease.ts` | Posting check: required clearance and `eligibleServes` (replaces 33.1 D-15's roster clearance) |
| `checkFreshness(citation, newest, level, policy, now)` | `freshness.ts` | **Enforcement points:** hub append and serve, wrap preparer, session |
| `declaredClearanceCounts(level, policy, projectRequiresCredentials)` | `clearance.ts` | O11: legacy declared clearances count only for unmarked and lowest-level cells |
| `clearanceFromCredentials(facts, scales)` | `clearance.ts` | VCRD-07: the gate's clearance |
| `presentFor(request, wallet)` | `present.ts` (71-08) | Present only what a check asks (VCRD-05) |
| `credentialClock(entrySignedAt, witnessAt?, bundleTime?, counter?)` | `clock.ts` | One clock helper (Phase 74 tightens it) |
| `node scripts/credential-check.mjs --holder <did> --type <Type> [--scope <s>]` | 71-08 | Command-line verifier for `deploy/` tools (47-19) |
| `bindLabel(signer, binding)`, `verifyLabelBinding(value, content)` | `src/domain/exchange/labelBinding.ts` (45.1-01) | Signed label binding (4778-style) |
| `wrapForDevice(input)`, `unwrapEpochKeyV2(input)` | `src/domain/replica/cellWrapV2.ts` (33.2-01) | Every wrap path calls `wrapForDevice`, which picks the format |

## Shapes other plans should reserve (proposed; 33.1-01's checkpoint settles the 33.1 ones)

- On entries that rely on a person's attributes: `evidence: string[]` (credential hashes) and `status: [{ list, hash, validFrom }]` (the status list credentials checked). Credentials travel as sealed blobs: staff credentials in the personnel key group (33.1-06), observer credentials in a security-office key group.
- `release.copy` gains an optional `binding` (the SHA-256 of a `LabelBinding` blob, 45.1-01).
- `project.mode` cites the policy hash whose `credentials@1` section names the issuance rules (replaces `signers`).
- Rekey after a credential revocation uses the existing reason `clearance-lowered` (no new value in `CELL_REKEY_REASONS`).
- Replica features (Phase 33's `roster.require`): `wrap@2` (33.2-04). A project-level `credentials@1` requirement for O11 is 33.1's to register; the rule it switches on is `declaredClearanceCounts`.
- Wrap v2 constants (33.2-01, permanent after its checkpoint): info `near-ai/cell-wrap/v2`, binding domain `near-ai-vscode/device-kem/v2`, kind `device.kem`, wire version byte 2; version byte 3 reserved for ML-KEM-1024 + P-384.

## New owner items raised by planning

1. **Solo installs (VCRD-07 against "devices never issue").** VCRD-07 says a person with no organization issues their own credentials from their device DID. The new rule forbids device keys as issuers. Default in the plans: with no organization policy in force, the gate keeps the person's own declared clearances on their own computer, shown as "declared, not verified"; they are never credentials and never satisfy a check in a shared project, a hub, a wrap or your organization's policy.
2. **The fallback (O9) and "devices never issue".** O9's fallback names `did:key` officers as issuers. Default: under the fallback only an officer's Transit person key that the signed policy names as a person key may issue; device and agent keys stay refused.
3. **Our credential context URL** (written into every credential). Default `https://w3id.org/sterling/credentials/v1`, registered with w3id.org before the first real credential; verification never fetches it.
