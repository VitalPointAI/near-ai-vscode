# Data-centric access: verified credentials, key release and zero trust

Research report, written 2026-11-24 from `origin/main` at 378594c4, plus the branches `origin/docs/phase-33.1-amendments` (8974449e) and `origin/docs/phase-48.1-hosted-saa` (1b93fc30).

**Owner direction (2026-11-24, confirming the 2026-11-15 design):** "it's the DID with VCs given to each observer, personnel, etc... that determine what level of access they have and to what. Data will manage access itself based on the attributes it has including clearance required to view (data-centric security) and zero trust throughout."

**Accepted the same day (owner, through the coordinator):** verified credentials are the only source of authorization attributes; access is enforced where keys are released, driven by the data's own attributes; zero trust throughout, with Keycloak used for authentication only; the core of Phases 70 and 71 is pulled forward; the stand-in attribute fields are dropped. This report does not reopen those points. It recommends the specifics the owner confirms separately: the data format, the phase order, any new components and their compliance fit, and what replaces each stand-in.

**How to read the evidence marks.**
- **[primary]**: I read a standards body or project page directly today.
- **[vendor]**: a vendor's own claims about its product or a competitor's.
- **[secondary]**: a search excerpt or a third-party summary.
- **[unverified]**: I could not confirm it today. Do not rely on it until a phase research step checks it.
- **[repo]**: read in this repository at the commits above.
- **(inference)**: my own reasoning.

The GSD confidence seam rates every web source LOW by default. The marks above are finer than that, but no web finding here should be treated as authoritative until the phase that depends on it repeats the check.

---

## 0. Recommendation in one page

1. **Keep our own cells and key-release format. Do not adopt the OpenTDF platform or ZTDF as the internal format.** Our grants and wraps already are the key-release point that TDF's Key Access Server (KAS) provides, and they work with no network, which a TDF KAS does not. OpenTDF's open-source platform takes subject attributes from identity-provider claims, LDAP or SQL, not from W3C credentials. Its maker says the open-source edition has no FIPS option, no HSM binding, no ZTDF and no STANAG labelling [vendor]. Instead, take two things from the standards now:
   - a STANAG 4774 label mapping and a STANAG 4778-style signed label binding on every release copy and grant;
   - a TDF/ZTDF export and import adapter later, for coalition exchange (Phase 45 and L5), once the ZTDF text has been obtained through official channels.
2. **Change the cell wrap to a CCCS-approved curve before any site holds Protected B data.** Today's wrap is X25519 + HKDF + AES-256-GCM [repo]. CCCS ITSP.40.111 version 5 (effective 2026-05-29) lists elliptic-curve key agreement only on the NIST P-curves, and X25519 is not listed [primary]. Wrap format v2 should be HPKE-shaped DHKEM(P-256, HKDF-SHA256) with AES-256-GCM, with a hybrid ML-KEM-768 slot for the 2035 post-quantum deadline. Ed25519 signatures stay: ITSP.40.111 v5 recommends EdDSA on Edwards25519 [primary].
3. **Pull the identity and credential half of Phase 71 forward as "Phase 71 (core)". Split agent delegation off as Phase 71.1, which stays in Stage 1.**
   - What 71 (core) contains: the VC 2.0 `eddsa-jcs-2022` profile; Bitstring Status List; `did:key` for devices; `did:webvh` for people and your organization; the trusted-issuer section of the signed policy; the per-level maximum offline age (pulled from L5); one pure verifier that the fold, the hub and the wrap preparer all call; and wrap v2.
   - Order: its research step and pure engine plans run now, beside Phase 33 and 33.1's waves 1 to 3. 33.1's posting check (33.1-04) and observer waves (33.1-18 to 33.1-25) wait for its verifier. 47-19 to 47-21 and 47-14 are amended before they run. 48.1 is amended in text only.
4. **Add no new runtime component.** Credentials are issued in the issuing officer's own workbench session and signed by their person key in OpenBao Transit, after a passkey step-up. Their authority to issue is itself a credential from your organization's root. One HQ status-list key in Transit signs the status lists. The sync hub serves the `did:webvh` logs and status lists, and the signed site export carries them to disconnected edges. The only new resources are test-only devDependencies (Digital Bazaar's cross-check libraries) and W3C/DIF test vectors, each with a compliance fit entry.
5. **Every stand-in becomes either a credential or a data attribute** (section 5 has the full table).
   - **Person attributes become credentials:** clearance, compartments, how a person serves, nationality, organization, export eligibility, the access agreement and the visit clearance.
   - **Data attributes stay on the data:** the cell's sealed label, `cell.marking`, and the position's required clearance and `eligibleServes`.
   - **Keycloak** keeps only account-lifecycle attributes.
   - **The organization-to-organization sharing agreement** becomes a signed policy record, not a person credential.
6. **Fallback**, if Phase 71 (core)'s research step fails on JCS conformance or `did:webvh`: ship "credential-shaped" atomic credentials, using the same profile and the same entry slots (credential hashes cited in entries). Issuers are `did:key` officers named in the signed policy, there is no `did:webvh`, and revocation comes from short validity plus roster revocation entries. The upgrade to the full profile later changes no log shape (section 7).

---

## 1. Where the plans stand today (what this report changes)

| Plan item | State | What it does now | Source |
|---|---|---|---|
| Phase 31 roster (on main) | Built | `member.invite`, `member.admit` and `member.update` carry a `clearance` the lead's host decides; `planRekey` already handles `clearance-lowered` | `src/domain/replica/rosterMembers.ts`, `cellKeys.ts`, `invite.ts:360` [repo] |
| Phase 33 cells and wraps (on main, native re-plan in progress) | Built in part | Per-cell epoch keys; wraps are X25519 → HKDF-SHA256 → AES-256-GCM, 92 bytes, HPKE-shaped "so a standard library can replace it later as a new format version"; label sealed in each grant | `src/domain/replica/cellKeys.ts` header [repo] |
| Phase 33 D-61 | Planned | OpenBao Transit has no ECDH, so the person's X25519 private key is enveloped under their Transit KEK and opened into backend memory per session | `33-CONTEXT.md` D-61 [repo] |
| Phase 70 labels and gate (on main) | Built | `{scale, level, compartments, releasability, handling}`, dominance, session mark, routing by label; bundle has empty slots for anchor roots, status list references and a maximum offline age per level (OFFL-03) | `src/domain/gate/labels.ts`, `dominance.ts`; ROADMAP Phase 70 criterion 5 [repo] |
| Phase 41 people section (on main) | Built | `people.clearances` self-declared on the personal layer; `people.signers` lists keys allowed to sign authorizations | `src/domain/org/peopleSection.ts` [repo] |
| Phase 33.1 | Planned; plan 01's permanent-shapes checkpoint not yet answered | D-15: posting checks roster clearance. D-16: `did` on the member record, "no authority until Phase 71". D-21/D-29: `serves`. D-30: `nationality`, `organization`, `cell.marking`, `releasableTo` at the wrap. D-32: `observer.approve` binds name, serves, nationality, organization. D-37 (amendments branch): `agreementRef`, `visitClearanceRef`, `accessAgreementRef` strings | `33.1-CONTEXT.md` [repo] |
| Phase 47-19 to 47-21 | Planned, not executed | Keycloak user-profile attributes `serves`, `nationality`, `organization`; `security-contacts` group gates who may approve; guest export carries the attributes | `47-CONTEXT.md` D-59, D-61, D-64 [repo] |
| Phase 47-14 | Planned, not executed | Signed user export and import, PKI files, revocation lists between HQ and edges | ROADMAP Phase 47 [repo] |
| Phase 48.1 | Planned on its branch | Observer compliance (AC-21, AC-16, PS-6, PL-4) built on the 33.1 fields; D-25 makes the D-37 references required by sensitivity; key and crypto inventories | `48.1-CONTEXT.md` D-25, D-08 [repo] |
| Phase 71 | 0 plans | DIDs, VCs, status lists, delegation; opens with a research step (JCS conformance, `did:webvh` hosting, status list sizing) | ROADMAP lines 1090 to 1111 [repo] |

The useful fact: **none of the stand-in shapes in 33.1, 47-19 to 47-21 or 48.1 has been written into a shared log or run on a site yet.** 33.1 plan 01's checkpoint exists to settle them. Only Phase 31's `clearance` field is already in shipped code, and its logs can be read as legacy declarations with no authority (section 5.3).

---

## 2. Data-centric security formats: what fits

### 2.1 OpenTDF

| Question | Finding | Mark |
|---|---|---|
| Licence | BSD-3-Clause-Clear (platform and spec repositories). Not AGPL, so the licence alone is acceptable | [primary] https://github.com/opentdf/platform ; https://github.com/opentdf/spec |
| Maturity | Go platform, about 53 stars, 43 forks, 2,299 commits; spec version 4.3.0. Virtru (its maker) offers community support only for the open-source edition, with no SLA | [primary] repo page; [vendor] https://www.virtru.com/data-security-platform/opentdf-vs-dsp |
| Components | Four services: Policy (PAP), Authorization (PDP), Entity Resolution (PIP) and Key Access Server (PEP), mapped to NIST ABAC | [primary] https://opentdf.io/architecture |
| Key access | KAS "grants or withholds keys for TDF decryption"; clients call a `Rewrap` method at decrypt time. Creating a TDF works offline; decrypting needs a KAS | [primary] architecture page and spec README; [secondary] `access.AccessService/Rewrap` in https://pkg.go.dev/github.com/opentdf/backend-go@v0.1.14/pkg/access |
| Key algorithms | KAS wrapping keys `rsa:2048` and `ec:secp256r1` (the client branches on the algorithm and uses ECDH for EC) | [secondary] web-sdk PR #433 and java-sdk PR #344 excerpts; no official algorithm list found |
| How attributes are asserted | The Entity Resolution Service "by default ... can derive attributes from claims in an authentication token", or from LDAP or SQL; **subject mappings** "convert identity claims into access entitlements" | [primary] https://opentdf.io/architecture ; [secondary] platform PR excerpts (#3774, #3794) |
| W3C VCs | No support found in the architecture page, the repository page or a search. The attribute source is the identity provider, which is what the owner's direction rules out | [unverified absence] |
| Offline and air-gapped | Not addressed by OpenTDF or Virtru. Decrypt needs a reachable KAS, so a disconnected edge would need its own KAS holding KAS private keys (inference) | [vendor] comparison page; (inference) |
| FIPS and HSM | Open source: "Base AES encryption"; "Basic Key Access Service (KAS) implementation without hardware bindings". FIPS-validated options and HSMs are in Virtru's commercial DSP only | [vendor] comparison page |
| ZTDF, IC-TDF, STANAG | Open source: "Reference implementation of the standard JSON-based Trusted Data Format" only; "No native tagging service". ZTDF and IC-TDF support and "CCEB STANAGs" tagging are in the commercial DSP. The spec README says ZTDF is maintained separately | [vendor]; [primary] spec README |

**Fit with our design.**
- **The format idea fits.** A TDF manifest carries the encrypted payload, one or more `keyAccess` entries, a policy with data attributes, a policy binding and optional signed assertions. That is the same shape as our grant: `{cell, epoch, roster, labelSealed, wraps}` [repo].
- **The runtime does not fit:**
  - It is a second PDP and a second policy store beside the Phase 70 gate.
  - Its attributes come from Keycloak claims, which the direction forbids.
  - It needs a KAS online for every decrypt, so each disconnected edge would need its own KAS.
  - It adds a Go service with its own database to the Phase 47 stack.
  - Its open-source edition fails the compliance fit on FIPS and HSM.
  - It does nothing our cells do not already do.
- **Worth borrowing (as design, not code):**
  - the attribute-rule vocabulary (hierarchy, all-of, any-of), which matches our label algebra: level is a hierarchy, compartments are all-of, releasability is any-of [unverified: OpenTDF rule names from memory, not re-read today];
  - a logged record of every key release, which for us is a receipt per wrap.

### 2.2 NATO ZTDF, ACP-240, STANAG 4774 and 4778

| Item | Finding | Mark |
|---|---|---|
| ACP-240 Ed A | "Data-Centric Interoperability Concepts and Design Requirements", published by the CCEB and listed in NATO's C3 architecture repository. It combines data-centric security with zero trust and federated identity, describes ABAC and an access control framework, and "introduces the Zero Trust Data Format (ZTDF) for secure object encoding" | [primary] https://nhqc3s.hq.nato.int/apps/DCRA_Report/id-29d4122b072148f5aaf4882ecc5d963c/elements/id-e2fa11e8135b43919b09f88b8a5574a4.html |
| CCEB and Canada | The CCEB is the Five Eyes communications board, so Canada is a party. Virtru says ACP 240 was adopted by "FVEY partners and other allied nations" (2025-10-15) and is "being adopted by the U.S. Joint Chiefs of Staff" | [vendor] https://www.virtru.com/newsroom/virtru-data-security-platform-enables-acp-240-adoption-among-allied-nations-and-technology-partners ; Canada's membership is general knowledge [unverified today] |
| ZTDF | "A derivative of the Trusted Data Format" (Virtru); the ZTDF text itself was not found publicly | [vendor] https://www.virtru.com/blog/zero-trust/data-format-ztdf-the-clear-path-to-data-interoperability ; the text's availability is [unverified] |
| STANAG 4774 (ADatP-4774) | Confidentiality metadata label syntax: XML with a `PolicyIdentifier`, a `Classification` and `Category` elements (for example a "Releasable To" category), plus lifecycle fields | [secondary] https://www.isode.com/wp-content/uploads/2026/03/Isode-Approach-to-Data-Centric-Security-using-NATO-Confidentiality-Labels.pdf ; https://nhqc3s.hq.nato.int/apps/DCRA_Report/id-29d4122b072148f5aaf4882ecc5d963c/elements/id-389800bcd08f4393a156e82e80aa8454.html ; NISP https://nhqc3s.hq.nato.int/apps/architecture/nisp/pdf/NISP-Vol3-v15-release.pdf |
| STANAG 4778 (ADatP-4778) | Metadata binding mechanism: "how these labels are securely bound to data", with an optional cryptographic binding by digital signature, so a receiver can check that the label is valid, belongs to the data and that the data has not changed; ADatP-4778.2 holds the binding profiles (for example SMTP). One vendor's claim that the binding uses HMAC-SHA256 is unconfirmed | [secondary] https://www.army-technology.com/sponsored/data-centric-security-and-nato-confidentiality-labelling-securing-information-in-modern-defence-networks/ (Isode-sponsored, 2026-04-17); Isode paper; the normative texts were not read [unverified] |

**Fit.**
- **The ideas fit, and we already have both halves.** A 4774 label maps to our `Label`: the scale preset maps to the policy identifier, the level to the classification, and compartments and releasability to categories. A 4778 binding is a signature over the label and the data. Today the label is sealed inside the signed grant, but a release copy or an export carries no bound label of its own (inference from `cellKeys.ts` and 33.1 D-30/D-35).
- **Recommended now:**
  - a mapping table from each scale preset to a 4774 policy identifier, which your organization's security officer confirms, as the Phase 70 presets already need;
  - a signed label binding (label, content hash, signer, time) on every `observer.release` copy and every export. That is a few dozen lines on the existing signer.
- **ZTDF as a wire format later:** only once your organization obtains the ACP-240/ZTDF text through official channels. It would be an export and import adapter at the coalition boundary (Phase 45's export control and L5's federation), not our storage format.

### 2.3 US IC-TDF

- IC-TDF.XML is the ODNI IC CIO's "XML Data Encoding Specification for Trusted Data Format". It binds assertion metadata (IC markings) to data, applies to the US Intelligence Community, and "Joint and Coalition forces may use this specification, but it is not required". A commercial profile exists [secondary: excerpts of https://www.dni.gov/index.php/who-we-are/organizations/ic-cio/ic-technical-specifications/trusted-data-format, which now redirects to odni.gov; the current version is unverified, and a V2021-NOV package is referenced].
- **Fit: none for us.** It is XML-heavy and US-IC specific, and the Canadian scales are not IC markings. The only lesson worth carrying is the pattern it shares with ZTDF and 4778: assertions bound to the data by signature.

### 2.4 What fits our three hard cases

| Need | TDF KAS model (pull) | Our cells (push) | Recommendation |
|---|---|---|---|
| Key release as the enforcement point | KAS checks attributes on every decrypt | The wrap preparer and the hub check attributes when a wrap is written; a device holds epoch keys from then on | Keep push. Add the credential check at every wrap (one shared function), rekey on any revocation or lowered clearance (`planRekey` exists), and in hosted mode treat the OpenBao entity as the per-session kill switch (section 4.3) |
| Signed offline bundles | Policy and keys live on the platform | Signed policy bundle, signed grants, signed site exports | Keep. The export also carries `did:webvh` logs, status lists and the issuer trust section |
| Edge with no network | Needs a KAS at the edge, holding KAS private keys | Works: wraps are already on the device | Keep. Bound the exposure with the per-level maximum offline age and epoch rotation, and state the residual risk honestly (section 6) |

---

## 3. The VC 2.0 profile as the attribute source for key release

### 3.1 What is already decided and still holds

- W3C VC Data Model 2.0, Data Integrity `eddsa-jcs-2022` and Bitstring Status List are W3C Recommendations (2025-05-15) [primary in identity-research.md, 2026-11-15].
- `did:webvh` v1.0 is the current DIF specification:
  - a log "may be obtained from sources other than its corresponding HTTPS location", with the same verification steps;
  - pre-rotation is active once `nextKeyHashes` is non-empty;
  - witnesses and watchers are optional;
  - for `did:webvh:1.0`, the only cryptosuite allowed for log-entry proofs is "exactly `eddsa-jcs-2022`" [primary, read today: https://identity.foundation/didwebvh/v1.0/].

  So the people and organization method and the credential profile share one cryptosuite.
- CCCS ITSP.40.111 v5 recommends EdDSA on Edwards25519 and Edwards448, and says EdDSA without a post-quantum scheme "should be phased out by the end of 2035" [primary: https://cyber.gc.ca/en/guidance/cryptographic-algorithms-unclassified-protected-and-protected-b-information-itsp40111]. FIPS 186-5 also approves EdDSA [unverified today: https://csrc.nist.gov/pubs/fips/186-5/final].

### 3.2 Trust anchors and what each verifier holds offline

| Item | Where it comes from | How it reaches an edge with no network |
|---|---|---|
| Your organization's root `did:webvh`, with SCID pinned | Created at HQ in a key ceremony, root key offline, pre-rotation on | SCID in the signed site file and the signed offline bundle (47-06) |
| Issuer authority | A role credential chain from the root: "may issue ClearanceCredential on scale `ca-gc-classified` up to Secret", "may issue NationalityCredential", and so on | In the signed policy bundle's new `credentials@1` section (trusted issuer DIDs, the credential types each may issue, and their limits), cited by hash in `project.mode.policy` (33.1 D-11) |
| People's `did:webvh` logs | Hosted by HQ, served by the sync hub over the site's ingress | In the signed site export (47-14) and in each hub's cache |
| Status lists (revocation and suspension) | Signed by the HQ status-list key (OpenBao Transit, ed25519, non-exportable); 131,072 entries (16 KB raw), random indexes | Served by the hub; carried in the signed export; stapled between devices |
| Per-level maximum offline age, and status-list time to live | Signed policy bundle (fills Phase 70's empty OFFL-03 slot; pulled from L5) | In the bundle |
| The person's own credentials | Their wallet: hosted, `kv/users/<entity>/credentials/` in OpenBao (46-07); single machine, the keyring | Already on the device |

### 3.3 How each check verifies, and how it stays deterministic

The fold must give the same answer on every replica. Status lists change over time, so a fold that read "the latest list" would disagree between replicas. **Rule: entries cite their evidence by hash. The fold checks the cited evidence; the PEPs check freshness.**

1. **An entry that needs an attribute cites it.** A posting, a wrap, an admission, an approval or a release names the hashes of the credentials it relies on and the hash and `validFrom` of the status list it checked. The credentials travel as sealed blobs in the right cell:
   - staff credentials in the personnel key group (33.1-06);
   - observer credentials in a security-office key group wrapped only to your organization's security contacts (section 3.5).
2. **The fold checks, from cited data only:**
   - the proof (`eddsa-jcs-2022`);
   - that the issuer is trusted for that credential type and limit under the policy cited by `project.mode`;
   - that the subject DID is the member's DID and the person key is a verification method in its `did:webvh` log;
   - `validFrom` and `validUntil` at the entry's signed time;
   - that the status bit is clear in the cited list;
   - that the cited list was valid at the entry's time, within the level's maximum offline age.

   The same inputs give the same answer on every replica.
3. **The PEPs check freshness at the moment of action** (section 4). The hub refuses an append that cites a status list older than its newest one plus a grace period, and refuses to serve a stream to a holder whose bit is now set. The wrap preparer refuses to write a wrap from stale evidence.
4. **A later revocation is acted on, not folded backwards.** When a newer list shows a bit set, the hub (as a watch) or the lead's backend stages `cell.rekey` with reason `revoked` or `clearance-lowered`. The existing planner drops the holder from every affected cell's next epoch [repo: `planRekey`].
5. **Clocks.** Expiry uses the entry's signed time plus the hub's witness time. Offline, the last signed bundle's time and a monotonic counter apply (Phase 71 research flag 8; Phase 74's clock rule later tightens it).

### 3.4 Releasability and "clearance required" as credential checks

The data carries its own requirement: the cell's sealed label (true label) and its public `cell.marking` (what the server can read). One pure function, `mayRelease(credentials, label, context)`, built on `dominance.ts`, decides every wrap, every release and every serve:

| Data attribute | Credential needed | Rule |
|---|---|---|
| `level` on `scale` | `ClearanceCredential { scale, atLeast }` (threshold) | Some presented threshold is at least the level, on the same scale or through a mapping the policy approves |
| each compartment | `CompartmentCredential { compartment }` | Every compartment is held |
| releasability tokens | `NationalityCredential { nationality }` or `AffiliationCredential { organization }` | Some held token is in the marking; an empty marking means unrestricted; `RELEASABLE-TO-NONE` never matches |
| `CGP`, `ITAR`, `EAR` compartments | `ExportEligibilityCredential { regime, basis }` from your organization's designated official | Held for each regime (Phase 45's person decisions, pulled forward) |
| handling (for example `local-only`) | none: environment attributes | Checked by the gate's routing, as today |
| position's required clearance and `eligibleServes` (a position is a resource) | `ClearanceCredential`, `ServiceCredential { serves }` | At posting (replaces 33.1 D-15's roster clearance) |
| marked material released to an observer | `AccessAgreementCredential` (PS-6); `VisitClearanceCredential` for export compartments | 48.1 D-25's table becomes "credentials required by sensitivity", signed in the policy and only ever tightened |

**Two gaps in today's plans that this closes.**
- **Observers' level is not checked.** 33.1 D-30 checks releasability and export regimes at the wrap and the release, but not the level or the compartments for observers: plans 33.1-19, 33.1-21 and 33.1-23 mention no level or clearance check [repo]. The single `mayRelease` checks the full dominance for everyone.
- **The `serves` special case goes.** Today the releasability check applies only to allied-military and industry members (D-30). With credentials, the same rule can apply to every holder of a marked cell, as long as HQ issues a `NationalityCredential` (for example `CAN`) to staff at enrolment. That changes behaviour, so it is owner decision O5.

### 3.5 Selective disclosure, and observers who see no roster

- **Atomic and threshold credentials are enough here**, as decided (decision 9). Some examples:
  - A posting to a position that needs Secret asks only for `ClearanceCredential { atLeast: Secret }`. Members never see the person's highest clearance.
  - A release to an observer asks for nationality, organization, the access agreement and, where needed, the visit clearance and the level threshold. It never asks for anything else.
  - Research risk 7 (a full set of thresholds shows a person's maximum level) is handled by presenting only what the check asks for.
- **Observers still see no roster** (33.1 D-27, D-35 unchanged):
  - **The observer's side.** The observer holds their own credentials in their wallet. When they open a session they present a verifiable presentation to your organization's server, bound to the server's audience and a nonce and signed by their `observer.session` key, which their person key certified after a step-up.
  - **What the base cell holds.** The approver's backend binds the credential hashes into `observer.approve`. The credentials themselves sit in the security-office key group, so other staff see "approved" and never the observer's documents (as D-37 already limits the references to signers).
  - **What never reaches the observer:** staff credentials, the roster, status lists, and the names of the staff who wrote. Release copies carry title and content only (D-35).
- **Later**, for unlinkability across organizations: SD-JWT VC (RFC track) or BBS. Neither is needed for one HQ and its edges (identity-research.md 3.3).

---

## 4. Zero-trust consistency

NIST SP 800-207 places a policy decision point (PDP) and policy enforcement points (PEPs) in front of every resource, and decides per session or per request from subject, resource and environment attributes [primary in earlier research; https://csrc.nist.gov/pubs/sp/800/207/final]. CCCS's ITSM.10.008 "A zero trust approach to security architecture" (effective 2023-03-15) aligns with NIST and CISA [secondary: https://www.cyber.gc.ca/en/guidance/zero-trust-approach-security-architecture-itsm10008]. Mapped onto our parts:

| Zero-trust role | Our part | Changes |
|---|---|---|
| Authentication | Keycloak with passkeys or hardware keys only; `acr` and `auth_time` for step-up (47 D-57, 46 D-21) | **Authentication only.** No authorization decision reads a token claim, a group or a user-profile attribute. A test asserts that the session backend and the hub read only `sub`, `acr`, `auth_time` and expiry |
| Key custody and kill switch | OpenBao per-person entity, Transit person key and KEK (46-07, 47-07) | Unchanged. Disabling the entity stops every unwrap at once (section 4.3) |
| Policy information point | Verified credentials, status lists, `did:webvh` logs, the signed bundle | New (Phase 71 core) |
| Policy decision point | The pure gate and label code (`dominance.ts`) plus `mayRelease` | Extended, not duplicated: the fold, the hub, the preparer and the session backend call the same function |
| PEP: per action | The person's workbench backend (one person per backend, 46 D-03), on every RPC that reads, writes, decides or wraps | Checks session active, credential validity and status-list time to live, then dominance for the cell. A decision is cached for no longer than the list's time to live |
| PEP: per append and per serve | The sync hub | Verifies cited credentials and status freshness on append; sender filter on serve (MUS design 315) now reads verified credentials, not declared clearances |
| PEP: at key release | The wrap preparer (the lead's or a delegate's backend) and the hub's check of every grant | `mayRelease` at every wrap path the 33.1 D-30 list names (first grant, member-removal rekey, handover stage and restage, delegate's grant, marking narrowing) |

### 4.1 What changes in Phase 46's session identity

- **Unchanged:** the forwarded token, `THEIACLOUD_SESSION_USER`, OpenBao jwt login, renew and revoke, step-up, and the `identity → active → failed/stopping` states (46 D-22 to D-25).
- **Added: authentication only.** The session knows who signed in, and nothing it reads from the token grants access. 46-02's tests add the negative case: a token carrying extra claims or groups changes no decision.
- **Added: the wallet.** The person's credentials live at `kv/users/<entity>/credentials/` and are read only by their own backend.
- **Added: the person's DID.** Their `did:webvh` names the Transit `person-<entity>` public key as a verification method. Hosted mode needs no extra device-binding credential, because the key never leaves Transit.
- **Added: a new state.** `active` gains a sub-state for the credential cache: `fresh`, `stale` (past its time to live, so protected actions are refused with a plain reason and a Retry) and `unavailable`. That gives one more transition to test and no silent wait.

### 4.2 What changes in Phase 47's realm (47-19 to 47-21, 47-14)

- **Remove** the user-profile attributes `serves`, `nationality` and `organization` (D-59), and the guest export's copies of them (D-64).
- **Remove** the `security-contacts` group as the approver check (D-59, D-61). `guests.mjs create` instead verifies that `--approved-by` holds an unrevoked `SecurityContactCredential`, using the same verifier as a command-line tool. Keeping the group as well would mean two sources of truth for one authority.
- **Keep** the lifecycle attributes, which are AC-2 account management and grant no data access:
  - `guestUntil`;
  - `guestRequestedBy`, `guestApprovedBy` and `guestApprovalRef`;
  - `guestEndedAt` and `guestEndedReason`.

  Also keep the `guests` group as the account type, the expiry CronJob, and everything in D-60 to D-63.
- **Line up end dates.** A guest's `ObserverAccessCredential` (section 5) has `validUntil` equal to `guestUntil`, so a date end needs no extra step. `guests.mjs end` (an early end) also sets the credential's revocation bit, through the issuer tool, where the site holds the status-list key.
- **No authorization claims in tokens.** The realm-as-code test asserts that no protocol mapper puts attribute or group claims into the access token.
- **47-14's signed user export** carries `did:webvh` logs, status lists and the policy's issuer section to edges. A guest is still re-approved at the destination by its own security contact (D-64 unchanged), and that contact issues the destination's credentials.

### 4.3 Key release in hosted mode is closer to a KAS than it looks

In hosted mode the cell epoch keys and the person's X25519 (later P-256) private key sit in the person's OpenBao key store, under a KEK that only their entity can use (33 D-61) [repo]. Every session therefore unwraps through Transit, so disabling the entity, or ending the session, cuts access even to epochs already granted. That is per-session key release, close to the pull model, with no new component (inference).

On a single machine and at edges the device holds the keys, so the push model's limits apply (section 6, pitfall 2).

---

## 5. The re-plan

### 5.1 What replaces each stand-in

| Stand-in (where) | Replacement | Issuer, and its authority under the policy | Holder or subject | Status and validity |
|---|---|---|---|---|
| Roster `clearance` on `member.invite`, `admit`, `update` (Phase 31, on main; 33.1 D-15) | `ClearanceCredential { scale, atLeast }`, one per threshold | Your organization's security officer (role credential from the root) | Person `did:webvh` | `validUntil` = screening expiry; revocation and suspension bits |
| Personal-layer `people.clearances` (Phase 41 D-35) | Retired as an access input. Bundle v1 still parses it, but it grants nothing | none | none | none |
| `serves` on member records (33.1 D-21, D-29) | `ServiceCredential { serves }` with the six 33.1 values | J1 or HR authority; for allied military and industry, the security contact | Person | Revocation |
| `nationality` (33.1 D-30; 47 D-59) | `NationalityCredential { nationality }` (ISO 3166-1 alpha-3 or a group token, 48.1 D-25 vocabulary) | Security officer or security contact, after the identity and visit-request check | Person | Revocation; `validUntil` for guests = end date |
| `organization` (33.1 D-30; 47 D-59) | `AffiliationCredential { organization }` | Security contact | Person | Same |
| Compartment holdings | `CompartmentCredential { compartment }` | Compartment owner | Person | Revocation |
| Export regimes on the approval (33.1 D-30, D-32) | `ExportEligibilityCredential { regime, basis }` | Your organization's designated official (CGP), export-person authority (Phase 45) | Person | Revocation; `validUntil` |
| `accessAgreementRef` (D-37) | `AccessAgreementCredential { agreement, scope }` (PS-6) | Security contact, when the person signs | Person | `validUntil` = the agreement's end |
| `visitClearanceRef` (D-37) | `VisitClearanceCredential { request, site, from, until }` | Security contact, on an approved visit request | Person | `validFrom` and `validUntil` = the visit window |
| `agreementRef` (D-37) | Not a person fact: an `agreements[]` record (organization to organization) in the signed policy, like Phase 41's `authorizations[]`, cited by `marking.approve` | Your organization's policy authority | Organization | Policy expiry |
| `observer.approve` binding name, serves, nationality, organization (D-32) | Binds the hashes of the presented credentials, plus the invitation, position, key groups, end date and regimes (unchanged). Optionally issue an `ObserverAccessCredential { project, position, cells, until }` that the observer presents at every session | Security contact (must hold `SecurityContactCredential`) | Observer | `validUntil` = end date; an early end sets the bit |
| `project.mode.signers` / `people.signers` keys (33.1 D-11, D-32; Phase 41) | Trusted-issuer section `credentials@1` in the bundle, plus a role credential (`SecurityContactCredential`, `ReleaseAuthorityCredential`) that the signer presents | Root, then a delegated issuer | Person | Revocation |
| Member `did` written by the lead, "no authority" (D-16) | The member's own `did:webvh`, set at enrolment; credentials must name it and its log must list the person key | HQ hosts the log | Person | `did:webvh` deactivation |
| Keycloak `serves`, `nationality`, `organization`; the `security-contacts` group (47 D-59, D-61, D-64) | Removed (section 4.2) | none | none | none |
| Device keys on a single machine (Phase 69) | `did:key` from the same Ed25519 key; `DeviceBindingCredential` from the person | Person | Device | Revocation (lost device) |

**Stays a data attribute, unchanged in meaning:**
- the sealed label in each grant, and `cell.marking` with `marking.approve` (now a signature over the marking and its bound label, 4778-style);
- the position's `requiredClearance` and `eligibleServes`;
- handling flags.

### 5.2 What becomes dead, what changes, what stays

| Plan item | Verdict | Change |
|---|---|---|
| 33.1 plan 01 (permanent shapes checkpoint) | **Changes**, and is the key moment | Member records get `did` (self, verified) and `evidence: [credential hash]` slots, with no `clearance`, `serves`, `nationality` or `organization` values. Entries that rely on attributes carry `evidence` and `status: {list, hash, validFrom}`. `observers@1` covers the new evidence shapes |
| 33.1-03 (`project.mode`) | Changes | `signers` is replaced by the policy hash, whose `credentials@1` section names the trusted issuers |
| 33.1-04 (who may be posted) | Changes | Clearance and `serves` from credentials via `mayRelease` and an `eligible` check. Waits for the Phase 71 (core) verifier |
| 33.1-06 (personnel key group) | Changes, small | Also holds staff credential blobs |
| 33.1-15 (`nearAi.organizationPeople`) | Changes | Returns the effective policy, including `credentials@1`, not personal clearances |
| 33.1-18 to 33.1-20, 33.1-23, 33.1-24 (observers, markings, approval, wraps, observer server view) | **Change** | Evidence instead of fields; one `mayRelease` call; the security-office key group; VP at session open; wait for Phase 71 (core) |
| 33.1-21, 33.1-22, 33.1-25 (releases, native screens, invitation recovery) | Small text and shape changes | The approval card shows credentials (to signers only), not typed references |
| 33.1 D-37 (amendments branch, not merged) | **Dead as written** | Replaced by the credential table; do not merge its three strings |
| 33.1 D-27, D-28, D-31, D-34, D-35, D-36 | **Stay** | Observer stream, no roster, end dates, comments, invitation states, version safety |
| 33.1 positions, postings, handover, acting (waves 1 to 7 apart from 33.1-04) | **Stay** | No attribute in them changes |
| 47-19 | Changes, smaller | Drop three attributes and the group check; add the credential check of the approver |
| 47-20 | Small change | Early end also revokes the credential |
| 47-21 | Changes, smaller | The guest export carries no attributes |
| 47-14 | **Changes** | Also exports `did:webvh` logs, status lists and the issuer section |
| 47-07 | Small change | Adds one non-exportable Transit key `status-list-<site>` (ed25519) and a policy that lets only the issuer role sign with it |
| 48.1 D-25 and 48.1-05 (`hosted-observers.md`) | Changes, text | "Releasability tokens" from credentials; "Authority" from issuer and role credentials; "Agreements and clearances" as credential types |
| 48.1-08 (key inventory) | Changes | Adds the root key (offline, pre-rotation), the status-list key, person DID keys and the issuer role |
| 48.1-09 (crypto inventory) | Changes | Lists the X25519 cell wrap as an open condition until wrap v2 (section 6, pitfall 3) |
| 48.1-04 (playbooks) | Changes | Adds issuer or status-list key compromise, and a stale status list at an edge |
| 48.1, all other areas | Stay | Not touched |
| Phase 33 (in progress) | Stays, with one later addition | Cells, epochs, grants, `session.certify`, person-key signing stay. Wrap v2 comes with Phase 71 (core) as a format version with a rekey migration |
| Phase 41 | Changes, small | Personal clearances retired as an input; `credentials@1` bundle section added |
| Phase 70 | Stays | Gate, labels, dominance, routing unchanged. The `Clearance` passed in is now built from credentials (VCRD-07); fills the OFFL-03 slots |
| Phase 71 | **Splits** | 71 (core) pulled forward; 71.1 (DLGT-01 to DLGT-08, agent trees, result shapes) stays in Stage 1 before Phase 72 |
| L4 | Stays | Anchoring of roots is unchanged and later |
| L5 | Partly pulled forward | The per-level maximum offline age moves into 71 (core); federation transport stays in L5 |
| Phases 38 to 40, 45, 88 on | Gain | Verified publishers, export person decisions and data-platform clearances all come from the same credentials |

### 5.3 Existing logs with declared clearances (Phase 31 on main)

The fold keeps reading `clearance` on old member entries as a legacy declaration that grants nothing. After a project requires `credentials@1` (one `roster.require` entry, Phase 33's pattern), a cell above your organization's lowest level is wrapped only from credentials. Existing projects keep working for unmarked and lowest-level cells, and every screen shows the existing "declared, not verified" sentence until then. Owner decision O11 sets whether projects on fictional data may keep declared clearances.

### 5.4 Phase 71 (core): contents and order

**Research step (first; it decides between the recommendation and the fallback):**
- (a) JCS conformance against the W3C `eddsa-jcs-2022` vectors and Digital Bazaar's cryptosuite (research risk 12).
- (b) `did:webvh` v1.0:
  - SCID, log verification from a cached copy, and pre-rotation with an offline root;
  - hosting on the hub path behind the site's ingress;
  - HQ as a witness;
  - the DIF test vectors.
- (c) Status list sizing, time to live, and the per-level maximum offline age.
- (d) Wrap v2:
  - HPKE DHKEM(P-256, HKDF-SHA256) with AES-256-GCM on `node:crypto`;
  - whether Node 26's `node:crypto` offers ML-KEM for the hybrid slot [unverified].

**Plans (engine plans pure and host-neutral, in `src/domain/credentials/` and `src/domain/did/`):**
1. VC profile issue and verify, with frozen W3C vectors and a Digital Bazaar cross-check (devDependencies only).
2. Bitstring Status List: build, sign, verify, staple, cite by hash.
3. `did:key` mapping of Phase 69 device keys; `did:webvh` log verification from a cache.
4. The `credentials@1` bundle section: trusted issuers per type and limit, maximum offline age per level, the credentials required by sensitivity.
5. `mayRelease` and the evidence citation rule (section 3.3), with property tests that a cited, revoked or out-of-date credential never passes.
6. Wrap v2 with a format version, plus the `cell.rekey` migration.
7. Issuance in the officer's session (native "Issue credential" card, person key with step-up), and the status-list key in Transit (47-07 addition).
8. Hub: serve logs and lists; verify on append; the freshness PEP; the watch that stages rekeys.
9. Signed export of logs, lists and the issuer section (with 47-14).
10. Docs and SECURITY.md wording (the gate prevents mistakes and does not accredit).

**Order:**

| Step | Work | Runs beside | Why |
|---|---|---|---|
| A (now, docs only) | Answer 33.1 plan 01's shapes with evidence slots; amend 33.1 CONTEXT (D-15, D-16, D-21, D-29, D-30, D-32, D-37), 47-19 to 47-21, 47-14, 48.1 D-25 and plans 04, 05, 08, 09; drop the D-37 amendment; write Phase 71 (core) and 71.1 into the ROADMAP | Everything | Nothing permanent has been written yet; this is the cheapest moment |
| B | Phase 71 (core) research step and plans 1 to 6 | Phase 33 waves; 33.1 waves 1 to 3; 46; 47-13 to 47-18 | Pure engine code in new files; no shared file with 33 or 47 |
| C | 47-19 to 47-21 and 47-14 as amended | B | Smaller than planned; they now need only the verifier CLI from B |
| D | 33.1-04, then 33.1 waves 4 to 7 | after B plans 1 to 5 | The posting check needs the verifier |
| E | Phase 71 (core) plans 7 to 10 | D | They need 46-07's `KeyService` and 47-07's Transit key |
| F | 33.1 observer waves (33.1-18 to 33.1-25) | after E | Observers need issuance and the hub PEP |
| G | 48.1 statements for the observer area | after F on main | As already planned (statements wait for 33.1) |
| H | Phase 71.1 (agent delegation), then Phases 72 to 74 | Stage 1 order | Unchanged |

Step A has to come first: the shapes become permanent the moment 33.1 plan 01 writes them. B has to come before D, because the posting check needs the verifier. E needs 46-07 and 47-07 on main. Everything else runs in parallel.

### 5.5 Options, cost and risk

| Option | What it means | Cost | Risk |
|---|---|---|---|
| **1. Recommended: own cells, credentials core first, standards-aligned labels** | Section 5.4; no new runtime component; wrap v2; 4774 mapping and 4778-style binding; ZTDF adapter later | Phase 71 (core) is about 10 plans plus its research; 33.1 changes in about 9 plans; 47 gets smaller; 48.1 is text. Observers arrive after 71 (core) rather than with 33.1's first waves | JCS or `did:webvh` surprises (fallback ready); status distribution to edges; observer timeline slips by the length of 71 (core) |
| 2. Fallback: credential-shaped interim | Same profile and the same evidence slots. Issuers are `did:key` officers named in the policy, with no `did:webvh` and no status lists: short validity (for example 30 days) plus roster revocation entries | About 60 percent of option 1's engine work; no hub hosting of logs | Revocation is weaker (validity-bounded); two issuer models for a while; the upgrade still needs `did:webvh` |
| 3. Adopt the OpenTDF platform | KAS, policy and entity resolution beside or instead of the gate; TDF objects | A Go service and a database in the Phase 47 stack, Keycloak integration, a KAS at every edge, and a second PDP to keep in agreement with the gate | Attributes from IdP claims (against the direction); no FIPS or HSM in open source [vendor]; no ZTDF or STANAG [vendor]; fails the compliance fit; community support only |
| 4. Adopt ZTDF as the storage format | Re-encode cells as ZTDF objects | Unknown: the spec text is not public [unverified] | Format churn, commercial tooling, KAS model offline; nothing gained inside one organization |

**Recommendation: option 1. Fallback: option 2**, triggered only if Phase 71 (core)'s research step fails (a) or (b).

---

## 6. Pitfalls

### Critical

1. **A fold that reads live status lists.** Replicas would disagree and the log would fork.
   - **Prevention:** cite evidence by hash; freshness is enforced only at the PEPs (section 3.3).
   - **Detection:** a property test that folds in random orders with different list versions cached.
2. **Push-model revocation lag.** A device that already holds an epoch key can read that epoch after it is revoked.
   - **Prevention:** rekey on every revocation; in hosted mode, the OpenBao entity disable cuts unwraps per session; at edges, the per-level maximum offline age, client-enforced, plus epoch rotation.
   - **Honesty:** SECURITY.md says that a device holding keys offline is trusted until its next contact, and that this is not a KAS.
3. **X25519 in the cell wrap is not in CCCS ITSP.40.111 v5.** Section 5.3 lists ECC CDH and MQV only on P-224, P-256, P-384 and P-521 [primary]. The FIPS 140-3 guidance excludes curves that are not in SP 800-56A rev 3 from key agreement [secondary: OpenSSL FIPS provider man pages].
   - **Prevention:** wrap v2 on P-256 before any Protected B site; record X25519 as a crypto open condition in 48.1-09 until then.
4. **A second source of truth for the same attribute.** Keeping Keycloak attributes, `security-contacts`, `people.signers` or roster fields beside credentials would let the two disagree.
   - **Prevention:** remove them (section 5.1); a test that no decision reads a token claim.
5. **Permanent shapes written before this lands.** 33.1 plan 01 writes them into every shared log.
   - **Prevention:** step A first.

### Moderate

6. **Ed25519 under a strict FIPS 140-3 validated-module requirement.** ITSP.40.111 v5 recommends EdDSA [primary]. But Vault's FIPS 140-3 mode lists ed25519 as not certified [secondary: https://developer.hashicorp.com/vault/docs/v1.19.x/secrets/transit]; OpenBao's own FIPS status was not found; and OpenSSL 3.5's FIPS provider status for Ed25519 conflicts between distributions [secondary].
   - **Prevention:** every proof names its cryptosuite; keep `ecdsa-jcs-2019` (W3C Data Integrity ECDSA, https://www.w3.org/TR/vc-di-ecdsa/ [unverified today]) as a second suite for credentials.
   - **Note:** `did:webvh` v1.0 allows only `eddsa-jcs-2022` for its log [primary], so a strict-FIPS site could not use `did:webvh` as written. That is owner decision O8.
7. **Issuer or root compromise.**
   - **Prevention:** offline root with pre-rotation; issuance only by role-credentialed officers with step-up; a status-list key that cannot issue; a recovery drill (L4 flag 4).
8. **Credential bloat in shared logs.**
   - **Prevention:** blobs in cells, hashes in entries; a status list is 16 KB raw.
9. **Observer documents seen by all staff.**
   - **Prevention:** the security-office key group; the base cell holds hashes only.
10. **4774 mapping drift.** Two Canadian scales and NATO's policy identifiers do not line up one to one.
    - **Prevention:** one mapping table in the bundle, confirmed by your organization's security officer (Phase 70 flag 5 already asks for this).

### Minor

11. **Threshold credentials leak the maximum level** if a holder presents all of them. Present only what is asked.
12. **Edge clocks.** Use a monotonic counter and the last bundle time (Phase 74).
13. **The ZTDF text may only be available through official channels.** Do not design the adapter from vendor descriptions.

### Phase-specific warnings

| Phase | Likely pitfall | Mitigation |
|---|---|---|
| 71 (core) research | JCS subset differs from RFC 8785 on some input | Restrict the profile to inputs proven equal, or take the fallback |
| 71 (core) wrap v2 | Two wrap formats live during migration | Format version in the grant; `cell.rekey` to v2 at the next epoch; refuse v1 for new wraps after the switch |
| 33.1 | Evidence slots under-specified, then frozen | Settle the slot schema in plan 01 with the Phase 71 (core) profile draft beside it |
| 47-14 | Status lists in exports go stale at the edge | Per-level maximum offline age; export time stamped and signed |
| 48.1 | Statements claim credential enforcement before it is on main | 48 D-11 honest-evidence rule: statements only for what is on main |

---

## 7. Compliance fit of what is added

| Resource | Kind and scope | Licence | Fit | Notes |
|---|---|---|---|---|
| `@digitalbazaar/vc`, `@digitalbazaar/eddsa-jcs-2022-cryptosuite`, `@digitalbazaar/vc-bitstring-status-list` | npm, devDependency (test cross-check only) | BSD-3-Clause (identity-research.md 3.2, npm metadata of 2026-11-15) | pass expected, scope `build` | Nothing ships; pin exactly; air-gap fine from the lockfile |
| W3C VC and Data Integrity test vectors; DIF `did:webvh` test vectors | test data | W3C Software and Document licence; DIF licence [unverified] | pass expected | Copied into the test folder with their licence |
| OpenBao Transit key `status-list-<site>` (ed25519) | configuration of an existing component | OpenBao (already assessed) | pass with the FIPS condition of pitfall 6 | 48.1-08 key inventory |
| P-256 ECDH, HKDF-SHA256, AES-256-GCM on `node:crypto` | crypto of existing runtime | Node.js (already assessed) | pass | ITSP.40.111 v5 sections 5.3, 10.2, 4.2 [primary] |
| OpenTDF platform | Go service | BSD-3-Clause-Clear | **not proposed**; would fail on FIPS, HSM and the attribute source | section 2.1 |
| Keycloak OID4VCI as an issuer | feature of an existing component | Apache-2.0 | **not proposed** | Still experimental in Keycloak 26.x; issues SD-JWT VC and JWT VC rather than our profile; would make the identity provider an attribute authority [primary: https://www.keycloak.org/2026/01/issue-credentials-over-openid4vci ; https://www.keycloak.org/2026/07/keycloak-2670-released] |

No new runtime dependency, no new container, no new service.

---

## 8. Owner decisions needed

Each has the default this report recommends.

| Id | Decision | Default |
|---|---|---|
| O1 | Data format: own cells, OpenTDF, or ZTDF | **Own cells**, plus a STANAG 4774 mapping and 4778-style binding now; a ZTDF/TDF adapter later at the coalition boundary |
| O2 | Phase order | Section 5.4: docs amendments first; Phase 71 split into 71 (core), pulled forward, and 71.1 (agent delegation), kept in Stage 1; 33.1's posting check and observers wait for 71 (core) |
| O3 | Cell wrap v2 | **P-256** HPKE-shaped wrap before any Protected B site, with a hybrid ML-KEM slot for the 2035 deadline |
| O4 | Who issues, and where | **Credentialed officers issue from their own session** with their person key and step-up; one HQ status-list key in Transit; the hub serves logs and lists; no new issuer service |
| O5 | Releasability for everyone or only outside members | **Everyone** holding a marked cell needs a matching nationality or affiliation credential (HQ issues `CAN` to staff at enrolment) |
| O6 | Status list time to live and maximum offline age per level | Connected HQ: 15 minutes. Edges: Protected A 7 days, Protected B 72 hours, classified 24 hours. All are examples for the security officer to set |
| O7 | Which official issues which credential type | Section 5.1 table, recorded in `credentials@1` |
| O8 | FIPS posture for Ed25519 | Accept ITSP.40.111 v5's EdDSA recommendation; carry `ecdsa-jcs-2019` as a second credential suite; record the `did:webvh` limit as a condition |
| O9 | Accept the fallback (section 5.5, option 2) if the research step fails | Yes |
| O10 | Access agreement and visit clearance as credentials issued by your organization's security contact; foreign-issued credentials only later, through L5 trust lists | Yes |
| O11 | Projects that hold only declared clearances (Phase 31 logs) | Keep working for unmarked and lowest-level cells; anything above needs credentials once `credentials@1` is required |

---

## 9. Gaps and what to verify later

- OpenTDF's exact KAS algorithm list and any FIPS build: only SDK pull-request excerpts were found [secondary].
- The texts of ACP-240 ZTDF and ADatP-4774/4778: not read. Obtain them through your organization before designing the adapter.
- The current IC-TDF version [unverified].
- Whether OpenBao has any FIPS 140-3 validation, and the Ed25519 status in the OpenSSL FIPS provider of the UBI 9 base [secondary, conflicting].
- ML-KEM in Node 26's `node:crypto` [unverified].
- The W3C Data Integrity ECDSA status for `ecdsa-jcs-2019` [unverified today].

---

## Sources

Primary (read today):
- CCCS ITSP.40.111 v5: https://cyber.gc.ca/en/guidance/cryptographic-algorithms-unclassified-protected-and-protected-b-information-itsp40111
- DIF `did:webvh` v1.0: https://identity.foundation/didwebvh/v1.0/
- OpenTDF architecture: https://opentdf.io/architecture
- OpenTDF repositories: https://github.com/opentdf/platform ; https://github.com/opentdf/spec
- NATO C3 DCRA, ACP-240 Ed A: https://nhqc3s.hq.nato.int/apps/DCRA_Report/id-29d4122b072148f5aaf4882ecc5d963c/elements/id-e2fa11e8135b43919b09f88b8a5574a4.html
- Keycloak OID4VCI blog and 26.7.0 release notes: https://www.keycloak.org/2026/01/issue-credentials-over-openid4vci ; https://www.keycloak.org/2026/07/keycloak-2670-released

Standards cited from the earlier research (`.planning/research/platform-direction/identity-research.md`, checked 2026-11-15):
- W3C VC Data Model 2.0: https://www.w3.org/TR/vc-data-model-2.0/
- W3C Data Integrity EdDSA: https://www.w3.org/TR/vc-di-eddsa/
- W3C Bitstring Status List: https://www.w3.org/TR/vc-bitstring-status-list/
- NIST SP 800-162 (ABAC): https://csrc.nist.gov/pubs/sp/800/162/upd2/final
- NIST SP 800-207 (zero trust): https://csrc.nist.gov/pubs/sp/800/207/final

Secondary and vendor:
- Virtru, OpenTDF compared with its commercial platform: https://www.virtru.com/data-security-platform/opentdf-vs-dsp
- Virtru, ACP-240 adoption (2025-10-15): https://www.virtru.com/newsroom/virtru-data-security-platform-enables-acp-240-adoption-among-allied-nations-and-technology-partners
- Virtru, ZTDF: https://www.virtru.com/blog/zero-trust/data-format-ztdf-the-clear-path-to-data-interoperability
- Isode, data-centric security with NATO labels: https://www.isode.com/wp-content/uploads/2026/03/Isode-Approach-to-Data-Centric-Security-using-NATO-Confidentiality-Labels.pdf
- Army Technology (Isode-sponsored, 2026-04-17): https://www.army-technology.com/sponsored/data-centric-security-and-nato-confidentiality-labelling-securing-information-in-modern-defence-networks/
- NATO NISP volume 3: https://nhqc3s.hq.nato.int/apps/architecture/nisp/pdf/NISP-Vol3-v15-release.pdf
- ADatP-4774 element: https://nhqc3s.hq.nato.int/apps/DCRA_Report/id-29d4122b072148f5aaf4882ecc5d963c/elements/id-389800bcd08f4393a156e82e80aa8454.html
- ODNI IC-TDF page (search excerpts only): https://www.dni.gov/index.php/who-we-are/organizations/ic-cio/ic-technical-specifications/trusted-data-format
- CCCS ITSM.10.008: https://www.cyber.gc.ca/en/guidance/zero-trust-approach-security-architecture-itsm10008
- OpenBao Transit: https://openbao.org/docs/secrets/transit/
- Vault Transit FIPS note: https://developer.hashicorp.com/vault/docs/v1.19.x/secrets/transit
- OpenSSL FIPS provider: https://docs.openssl.org/3.6/man7/OSSL_PROVIDER-FIPS
- OpenTDF backend-go `Rewrap`: https://pkg.go.dev/github.com/opentdf/backend-go@v0.1.14/pkg/access

Repository (read at the commits named at the top):
- `.planning/PROJECT.md`, Platform direction decisions 8 to 17
- `.planning/ROADMAP.md`, Phases 33, 33.1, 46, 47, 48, 70, 71, L4 and L5
- `.planning/research/platform-direction/identity-research.md`
- `.planning/research/multiuser-sync/DESIGN.md`, sections 7.2 and 315
- `.planning/research/portfolio-and-assignment/DESIGN.md`
- Phase contexts: `33-CONTEXT.md` (D-60 to D-62), `33.1-CONTEXT.md` (D-11 to D-37, including the amendments branch), `46-CONTEXT.md` (D-03, D-17 to D-25, D-36 to D-38), `47-CONTEXT.md` (D-02, D-30, D-33, D-40, D-58 to D-65), `48.1-CONTEXT.md` (D-08, D-25)
- Code: `src/domain/gate/labels.ts`, `src/domain/gate/dominance.ts`, `src/domain/replica/cellKeys.ts`, `rosterCells.ts`, `rosterMembers.ts`, `invite.ts`, `src/domain/org/peopleSection.ts`

Nothing was downloaded or run; no third-party code was executed.
