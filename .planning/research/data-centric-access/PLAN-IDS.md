# Plan ids for the data-centric access work

Written 2026-11-24 on `docs/phase-71-core-plan`, from `RESEARCH.md` in this folder (owner decisions O1 to O11, all accepted) and the coordinator's AI-classification amendments of the same day. The planners amending 33.1, 47-19 to 47-21, 47-14 and 48.1 cite the ids below. Names marked **permanent** become part of signed objects or shared logs once a plan writes them.

## Phases

| Phase | Name | State |
|---|---|---|
| 71 | Identities and verified credentials (core), pulled forward | 14 plans in 9 waves. Keeps the ROADMAP number; re-scoped |
| 71.1 | Agent delegation that only narrows | Stub, 0 plans. DLGT-02 to DLGT-08 move here. Stays in Stage 1, before Phase 72 |
| 33.2 | Post-quantum cell keys (`cell-wrap/v2`) | 8 plans in 7 waves. Must merge before any site holds Protected B data |
| 45.1 | NATO and Five Eyes exchange, part 1: labels, binding, adapter, base TDF | 5 plans in 5 waves |
| 45.2 | NATO and Five Eyes exchange, part 2: ZTDF and the NATO texts | 17 plans in 10 waves (planned 2026-11-24 on `docs/phase-45.2-plan` from AC322, ADatP-4774, 4778, 4778.2, 5636 and OpenTDF 4.3.0; amended 2026-11-25 on `docs/phase-45.2-inbound-adapters` with inbound format adapters, 45.2-13 to 45.2-17, after the owner's direction of that day and 45.1 D-11). 45.2-12 waits for a partner's KAS and samples. Hand-off ledger in `45.2-CONTEXT.md` |

Research report rows map to these phases: B is 71-01 to 71-08; E is 71-09 to 71-13; the wrap (research plan 6) is Phase 33.2; I is 45.1; J is 45.2. The research's "plans 1 to 5" (verifier, `mayRelease`) are 71-03 to 71-07.

## Plans

| Id | Wave | What it delivers | Others wait for it |
|---|---|---|---|
| 71-01 | 1 | Tracer: one `ClearanceCredential` through our `eddsa-jcs-2022` profile, cross-verified with Digital Bazaar and the W3C vectors (research item a). Package check first | |
| 71-02 | 1 | Research: `did:webvh` hosting and caching, status list sizing and lifetimes, the FIPS posture for Ed25519 (O8) with the fallback ready. Verdict per item | 48.1-08 and 48.1-09 (key and crypto inventory facts) |
| 71-03 | 2 | The narrow VC 2.0 profile, every credential type below, the second suite `ecdsa-jcs-2019` | |
| 71-04 | 2 | `did:key` for devices (Phase 69 keys unchanged), `did:webvh` log verification from a cached copy | |
| 71-05 | 3 | Bitstring Status List: build, sign, verify, staple, cite by hash | |
| 71-06 | 3 | `credentials@1` and `agreements@1` policy sections; issuer authority chain; agents and devices never issue | 33.1-20 (`agreements[]`), 48.1-05 |
| 71-07 | 4 | The credential checker (API below) | 33.1-04, 33.1-19, 33.1-20, 33.1-23, 45.1-03 |
| 71-08 | 5 | The person's wallet (`.near-vc` files), the gate's clearance from credentials (after the owner answers item 1 at 71-02's checkpoint), the verifier tool `deploy/tools/credential-check.mjs`, shipped in the signed offline bundle | 47-19 (`guests.mjs create --approved-by`) |
| 71-09 | 5 | Sync hub: serves logs and status lists, checks cited evidence on append and serve, revocation watch | 33.1-24 (observer server view), 33.1 observer waves |
| 71-10 | 6 | A person's `did:webvh` at first sign-in, your organization's root DID and role credentials (offline), binding a computer | |
| 71-11 | 6 | Trust export file `.near-trust-export` (logs, lists, issuer section), a separate file beside 47-14's user export (confirmed), and its import at an edge | 47-14 (runs beside it; no shared file) |
| 71-12 | 7 | Issuance from the officer's own session (Issue credential card), status-list key in OpenBao, revoke and suspend, the wallet inbox, and the revocation card that reads the revocation request inbox | 33.1 observer waves (33.1-18 to 33.1-25); 47-20 and 47-31 write revocation requests and name 71-12's revocation card (no script revokes) |
| 71-13 | 8 | Credential cache state in the session (`fresh`, `stale`, `unavailable`), key release in hosted sessions, tokens authenticate only | |
| 71-14 | 9 | SECURITY.md and docs, full suites once, verification record, integration PR | 48.1 statements (48 D-11: only what is on main) |
| 33.2-01 | 1 | Tracer: one epoch key wrapped with `cell-wrap/v2` and opened; runtime confirmations and the probe; permanent shapes checkpoint | |
| 33.2-02 | 2 | Second device key binding: `device.kem`, the descriptor's `kem`, the optional `kem` on join requests (observer invitations included, so `observer.key` recipients get v2 keys), safety words, hub check | 33.1-18 (observer join request reserves the optional `kem`) |
| 33.2-03 | 2 | Grant pages | |
| 33.2-04 | 3 | Where the new private keys live (keyring, Transit envelope, hub) and publishing `device.kem` at open | |
| 33.2-05 | 4 | `wrap@2` through `roster.require` with the probe; new projects switched at creation; the cutover rule in fold and hub | |
| 33.2-06 | 5 | Every wrap path through `wrapForDevice` (its `read_first` names `observers.ts` and the `observerKeys` path); the Protected B rule; the CI check; SECURITY.md | 33.1-19 and 33.1-23 (wrap paths must call `wrapForDevice`); 48.1-09 (X25519 open condition closes when 33.2 is on main) |
| 33.2-07 | 6 | Native Switch, Move and Give keys cards; scheduled rekey per cell | |
| 33.2-08 | 7 | Close-out on the built image, integration PR | |
| 45.1-01 | 1 | Tracer: `labelInterop` table (feature `label-interop@1`) and the signed label binding | 33.1-01 (reserve the `release.copy` `binding` slot) |
| 45.1-02 | 2 | Base TDF manifest from the public OpenTDF spec; partner key access; receiving key in OpenBao | |
| 45.1-03 | 3 | The exchange adapter at the release boundary; `exchange.export` and `exchange.import` shapes checkpoint | |
| 45.1-04 | 4 | Binding on every release copy, signed by the staff session key that signs `release.copy`; Export for a partner and Received objects in the workbench. Waits for 33.1-21 | |
| 45.1-05 | 5 | SECURITY.md, full suites once, verification record, integration PR | 45.2-08 (rewrites its SECURITY.md section) |
| 45.2-01 | 1 | Tracer: our own narrow XML reader and writer; one label out as ADatP-4774 and back. After 45.1-01 | |
| 45.2-11 | 1 | Label policy profiles with provenance (`label-profile/1`; NATO public-unverified, Canadian DND/CAF assumed), `provenanceCheck`, a gap row per unverified value | |
| 45.2-13 | 1 | Inbound adapter interface (`InboundAdapter`, `recognizeArrival`), the record values checkpoint for exports and every arrival (replaces 45.2-07's), tracer: an unlabelled file held at the holding label and labelled by a person; never more trusted, never lower. After 45.1-03 | 45.2-07, 45.2-15, 45.2-16 |
| 45.2-14 | 1 | One hardened archive reader moved to `src/domain/archive/zip.ts` (the Office tools keep theirs through it); the no-I/O and no-release-signer rule for inbound adapters | 45.2-15, 45.2-16 |
| 45.2-02 | 2 | `labelXml` section (`label-xml@1`) adopting the profiles, every 4774 structure as our own vectors, labels coming in (`labelsIn`) | |
| 45.2-03 | 2 | ADatP-4778 binding objects with the seven ADatP-5636 mandatory elements; sidecar files; every binding form read | |
| 45.2-04 | 3 | Signed bindings to the ADatP-4778.2 cryptographic artefact profile; Transit key `release-p256-<site>` with a site PKI certificate | 48.1-08 (key inventory, hand-off H-7); Phase 47 site PKI (H-12) |
| 45.2-05 | 3 | ZTDF-compatible profile on OpenTDF 4.3.0 (`ZtdfProfile`), extending 45.1-02's `tdf.ts`. After 45.1-02 | |
| 45.2-06 | 4 | `exchangePartners` section (`exchange-partners@1`: purpose, KAS keys, trust anchors, profile overrides, classical cap), push and pull key access to partner KASs. After 45.1-03 | Phase 47 site runbook (egress and KAS client certificate, H-5) |
| 45.2-15 | 5 | Inbound TDF family: OpenTDF 4.3.0 and legacy TDF3 from stock tools (OAEP SHA-1 senders through rewrap only, per ITSP.40.111 v5), 45.1 objects, our ZTDF-compatible profile kept as received; the ZTDF-compatible stored form; G455 text | 45.2-07, 45.2-16 |
| 45.2-07 | 6 | NATO-format export recorded (no checkpoint: values settled at 45.2-13), the export dialog, the import dialog and the Received objects card with exchange-officer decisions. After 45.1-04 and 45.2-15 | |
| 45.2-16 | 6 | Inbound binding objects (standalone, sidecar, embedded, in Office and OPC packages) and marked files read through 70.1's `markingFloors` (no second marking reader); every adapter under fuzz. After 70.1-01 | |
| 45.2-08 | 7 | AC322 conformance matrix, SECURITY.md, crypto inventory and data flow (45.1's algorithms too, the SHA-1 and RSA-2048 rules), control statements. After 45.1-05 | 48.1-09 (crypto inventory, H-4) |
| 45.2-17 | 7 | PDF markings: the text-sample port in the workbench backend with the pdf.js copy the image already ships, run in a capped child process killed at its limit (its resource entry is 45.2-10 Task 2's) | 45.2-10 |
| 45.2-09 | 8 | Schema check against the texts' schemas, full suites once, integration PR | |
| 45.2-10 | 9 | Conformance harness (every arrival format too); development round trip against the OpenTDF quickstart's KAS (EC or SHA-256 key, never SHA-1), pinned, reviewed and registered first, in one gate pull request that also records the PDF reader's new use | |
| 45.2-12 | 10 | Acceptance trial with an ally's or vendor's KAS and its own samples, and the partner's samples in other formats | |

## Requirement ids (added to REQUIREMENTS.md on this branch)

- **Phase 71:** DLGT-01, VCRD-01 to VCRD-07, and new DCAC-01 to DCAC-06 (data-centric access control).
- **Phase 71.1:** DLGT-02 to DLGT-08 (moved from Phase 71).
- **Phase 33.2:** new WRAP-01 to WRAP-05.
- **Phase 45.1:** new XCHG-01 to XCHG-04. **Phase 45.2:** XCHG-05 to XCHG-08 (reworded 2026-11-24 when 45.2 was planned) and XCHG-09 (inbound format adapters, added 2026-11-25).
- **Phase 45.2 names (proposed; permanent once written):** policy features `label-xml@1` (section `labelXml`) and `exchange-partners@1` (section `exchangePartners`); label profile format `label-profile/1`; Transit key `release-p256-<site>` under the `exchange-release` policy; profile ids `ztdf-compatible/opentdf-4.3.0/1` and the NATO `urn:nato:stanag:4778:profile:cryptoartefact:1:2`; exchange format values `ztdf-profile/1` and `bdo` (settled at 45.2-07's checkpoint, possibly under `exchange@2`). **Amended 2026-11-25** (45.1 D-11, 45.2 D-34): open id sets under `exchange@1`, no `exchange@2`; arrived ids `tdf`, `ztdf-profile/1`, `bdo-4778`, `marked-file`, `unlabelled` (reserved, not written: `smtp-4778`, `xmpp-4778`); `stored` a `readonly string[]` of `cell` and `ztdf-profile/1`, `conversion` optional, and the one id set `KNOWN_ARRIVAL_FORMATS` and `KNOWN_STORED_FORMS` in 45.1's `src/domain/exchange/adapter.ts` (a record is readable when its `arrived` id is known and `cell` is in `stored`; coordinator decisions B1 and B2); stored profile id `ztdf-compatible/opentdf-4.3.0/stored/1`; conversion and import receipt ids as 45.2-CONTEXT D-34 lists; all confirmed at 45.2-13 Task 1.

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
| `ClassificationAuthorityCredential` | `{ scale, upTo, scope }`: may lower or declassify up to `upTo`; `scope: own-items` is the originator's authority (AI-classification research 6.4). Phase 71 issues and verifies it; enforcing it is deferred to Phase 70.1 and Phase 74.3 |
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
| `checkEvidence(citation, evidence, context)` | `evidence.ts` | **Fold-time.** Deterministic: proof, issuer authority under the cited policy, each cited status list signed by the status-list issuer key the cited policy's `credentials@1.statusLists` names (never checked through the person-issuer rule), subject is the member's DID, dates at the entry's signed time, bit clear in the cited list, list valid at the entry's time within the level's maximum offline age |
| `mayRelease(facts, label, context)` | `mayRelease.ts` | **The decision** for every wrap, release and serve |
| `eligibleForPosition(facts, position)` | `mayRelease.ts` | Posting check: required clearance and `eligibleServes` (replaces 33.1 D-15's roster clearance) |
| `checkFreshness(citation, newest, level, policy, now)` | `freshness.ts` | **Enforcement points:** hub append and serve, wrap preparer, session |
| `declaredClearanceCounts(level, policy, projectRequiresCredentials)` | `clearance.ts` | O11: legacy declared clearances count only for unmarked and lowest-level cells |
| `clearanceFromCredentials(facts, scales)` | `clearance.ts` | VCRD-07: the gate's clearance |
| `presentFor(request, wallet)` | `present.ts` (71-08) | Present only what a check asks (VCRD-05) |
| `credentialClock(entrySignedAt, witnessAt?, bundleTime?, counter?)` | `clock.ts` | One clock helper (Phase 74 tightens it) |
| `node deploy/tools/credential-check.mjs --holder <did> --type <Type> --credential <file> --trust <dir> [--scope <s>]` | 71-08 | Command-line verifier for `deploy/` tools (47-19). Its engine (`credential-checker.engine.mjs`, built from `src/domain/credentials/`) is generated by `deploy/bundle/build.mjs`, so the tool ships to operators in the signed offline bundle |
| `bindLabel(signer, binding)`, `verifyLabelBinding(value, content)` | `src/domain/exchange/labelBinding.ts` (45.1-01) | Signed label binding (4778-style). Signer is only `session:<writer>` (the certified staff session key that signs `release.copy`, 33.1 D-35) or `org-release:<site>` (your organization's release key, for exports); never a person DID or key |
| `wrapForDevice(input)`, `unwrapEpochKeyV2(input)` | `src/domain/replica/cellWrapV2.ts` (33.2-01) | Every wrap path calls `wrapForDevice`, which picks the format; an architecture test (33.2-06) refuses a direct `wrapEpochKey` call |

## Shapes other plans should reserve (proposed; 33.1-01's checkpoint settles the 33.1 ones)

- On entries that rely on a person's attributes: `evidence: string[]` (credential hashes) and `status: [{ list, hash, validFrom }]` (the status list credentials checked). Credentials travel as sealed blobs: staff credentials in the personnel key group (33.1-06), observer credentials in a security-office key group.
- `release.copy` gains an optional `binding` (the SHA-256 of a `LabelBinding` blob, 45.1-01).
- `project.mode` cites the policy hash whose `credentials@1` section names the issuance rules (replaces `signers`).
- Rekey after a credential revocation uses the existing reason `clearance-lowered` (no new value in `CELL_REKEY_REASONS`).
- Replica features (Phase 33's `roster.require`): `wrap@2` (33.2-05), `exchange@1` (45.1-03), `model-provenance@1` (74.1-14: the optional `model { id, artifactHash?, passportHash }` on `version.propose` and the staff product header keys `model`, `model_artifact`, `passport` in shared projects; an older client stops with `UPDATE_SENTENCE` through `missingFeatures`; permanent once written; added 2026-11-24 by the Phase 74.1 planning). A project-level `credentials@1` requirement for O11 is 33.1's to register; the rule it switches on is `declaredClearanceCounts`.
- Wrap v2 constants (33.2-01, permanent after its checkpoint): info `near-ai/cell-wrap/v2`, binding domain `near-ai-vscode/device-kem/v2`, kind `device.kem`, wire version byte 2; version byte 3 reserved for ML-KEM-1024 + P-384.

## New owner items raised by planning

1. **Solo installs (VCRD-07 against "devices never issue").** VCRD-07 says a person with no organization issues their own credentials from their device DID. The new rule forbids device keys as issuers. Default in the plans: with no organization policy in force, the gate keeps the person's own declared clearances on their own computer, shown as "declared, not verified"; they are never credentials and never satisfy a check in a shared project, a hub, a wrap or your organization's policy.
2. **The fallback (O9) and "devices never issue".** O9's fallback names `did:key` officers as issuers. Default: under the fallback only an officer's Transit person key that the signed policy names as a person key may issue; device and agent keys stay refused.
3. **Our credential context URL** (written into every credential). Default `https://w3id.org/sterling/credentials/v1`, registered with w3id.org before the first real credential; verification never fetches it.

Owner items for Phase 33.2 (the wrap as its own phase; Protected B never wrapped the old way; late computers never removed) and Phase 45.1 (exports from staff releases only; an RSA receiving key; no shipped NATO label values; the request for the NATO texts) are listed at the end of their CONTEXT files.

## Rules other planners should know

- **Protected B and the wrap (33.2 D-07).** From 33.2-06 on, a cell whose label routes `local-only` or `deny` (by default Protected B, Protected C and every classified level) is never wrapped with X25519. In a project that has not switched to `wrap@2`, such a cell cannot be shared until the lead switches.
- **One wrap entry point (33.2 D-09).** Every wrap path calls `wrapForDevice`; the architecture test refuses a direct `wrapEpochKey` call outside `cellKeys.ts` and `cellWrapV2.ts`. 33.1's later wrap paths (33.1-19, 33.1-23) follow it.
- **Trust export (71-11).** `.near-trust-export` is its own file beside 47-14's signed user export (confirmed); 47-14's runbook names it; no change to `deploy/keycloak/users.mjs`.
- **Status lists are signed by the HQ status-list key, and each signature is authorized only by an officer's step-up (O4).** The cited policy's `credentials@1.statusLists` names the key for each list; every verifier checks lists against it.
- **Observers and guests see no staff identity.** Your organization's server refuses every `/v1/trust` route (DID logs and status lists) to observer and guest principals (71-09). Label bindings in observer streams carry no person DID or key (45.1-04).
- **An agreement vouches for a partner's people only when your organization has vetted the partner (45.1 D-12, owner 2026-11-25).** `agreements@1` items gain an optional `clearanceProcessVetted { by, on, basis }`, set only in your organization's signed layer (`agreements.items` is organization-only); absent, malformed or future-dated means not vetted. `canExport` (45.1-03 Task 3) uses the agreement-level clearance only for a vetted partner; otherwise it needs a recipient `{ did, facts, policy }` (facts' subject bound to the DID in the domain; the credentials section of the policy in force required on that path, so a caller can never pass on a clearance alone) through `mayRelease`, or refuses. Callers (45.1-04, 45.2-07) supply all three. 45.2's NATO-format exports inherit the rule through `canExport`; this supersedes 45.2 hand-off H-6 ("`agreements@1` stays as it is") for this one field, and `exchangePartners` stays keyed by agreement id. Outside observers are unchanged (they always present their own credentials, 33.1 D-30). No gap id was needed (block G505 to G509 unused).

## `credentials@1` means three different things

The same string names three unrelated features. Keep them apart:

| Where | Registry | Owner | Meaning |
|---|---|---|---|
| Signed policy | `FEATURE_IDS` in `src/domain/gate/features.ts` | 71-06 | The policy has a `credentials` section (trusted issuers, status lists, offline ages, sensitivity rules) |
| Shared project | `KNOWN_REPLICA_FEATURES` in `src/domain/replica/features.ts` | 33.1-03 | O11: the project requires credentials above the lowest level (`declaredClearanceCounts`). 33.1-03 may give it a distinct id; this phase does not register it |
| User export | 47-14's export `requires` | none | Not used by these plans |

## Revocation request inbox (one format for 47-20 and 47-31)

- **Path:** `kv/data/site/revocation-requests/<entity>-<reason>`, written once with `cas: 0`.
- **Format:** `sterling-revocation-request/1`: `{ format, entity (OpenBao entity name), keycloakId, reason, seenAt, job }`. No secrets and no credential data.
- **Reasons:** `disabled` and `removed` (47-31, from Keycloak), `guest-ended` (47-20, an early end; an end on the date needs no request, since `validUntil` equals the end date).
- **Writers:** 47-20 and 47-31 only (create).
- **Reader:** 71-12's revocation card, through the issuer step-up role (read, list, delete on that path only). It resolves the entity to the person's DID through the people directory, and shows each officer only the credentials they issued to that person (the issued register `kv/site/issued/<entity>/<credential hash>`). The officer revokes or suspends in their own session after a step-up. The card deletes the request once every credential issued to that person is revoked or suspended. No script revokes anything.
