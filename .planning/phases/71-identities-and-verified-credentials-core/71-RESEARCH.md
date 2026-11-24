# Phase 71 research step: did:webvh, status lists and the FIPS posture (71-02)

**Researched:** 2026-11-24 by Claude (agent) on `feat/phase-71-wave-1`, for research items (b), (c) and O8 of `71-CONTEXT.md` (D-03, D-11, D-13, D-14, O8, O9).
**Read by:** the preconditions of 71-04, 71-05 and 71-09 to 71-12 (the verdict lines below).

Evidence marks: **[primary]** the specification, standard, certificate or vendor document itself, read today; **[secondary]** another party's description; **[repo]** this repository; **[verified by running]** a short script of our own, run today with our own code and the installed Node, not committed; **[inference]** our reasoning from the cited facts; **[unverified]** not confirmed today.

Nothing downloaded was run. The DIF test suite was read as data only (its scripts, Docker files and implementations were not extracted or run). The two checks below that ran were our own scripts in the session scratchpad, using `dist/` compiled from this branch (`canonical.ts`, `multibase.ts`, `dataIntegrity.ts` of 71-01).

---

## (b) did:webvh

Sources: the did:webvh v1.0 specification, https://identity.foundation/didwebvh/v1.0/ (read 2026-11-24; it states v1.0 only gets clarifications "with no changes to the meaning" and that the editor's draft has moved on to a later version) **[primary]**; the DIF test suite https://github.com/decentralized-identity/didwebvh-test-suite at commit `435139032d93903859fc090cbf2ee2100a2e45ff` (2026-11-04, Apache-2.0) **[primary]**.

### The identifier and the SCID

- Form: `did:webvh:<scid>:<domain>[:<path segment>]*`. The SCID is exactly 46 base58btc characters: base58btc of the SHA-256 multihash (`0x12 0x20` + 32 bytes) of the JCS form of the first log entry with every SCID replaced by the literal `{SCID}` and `versionId` set to `{SCID}` **[primary: Method-Specific Identifier; Generate SCID]**.
- The SCID is immutable for the life of the DID, also under portability **[primary: DID Portability]**. Trust in a DID comes from outside (for us, the SCID pinned in the signed policy, D-12), never from the domain **[primary: warning in The DID to HTTPS Transformation]**.
- Proposed strings (fictional names):
  - your organization's root: `did:webvh:<scid>:hq.example.org:org`, log at `https://hq.example.org/org/did.jsonl`;
  - a person enrolled at HQ: `did:webvh:<scid>:hq.example.org:people:<id>`, log at `https://hq.example.org/people/<id>/did.jsonl`;
  - a person enrolled at an edge site: `did:webvh:<scid>:edge1.example.org:people:<id>`.

  `<id>` is a random opaque identifier made at creation, never a name, an email or the OpenBao entity id, because a DID is shown wherever a credential is presented **[inference]**. Path segments must not be `.`, `..`, empty, or contain `/`, `\` or NUL after percent-decoding **[primary]**.
- The DID-to-HTTPS rule turns each `:` path segment into a `/` path segment and appends `did.jsonl`; `did-witness.json` sits beside it when witnesses are used **[primary]**.

### Hosting on the sync hub behind the site's ingress

- The specification calls publication "a logical operation – how a deployment serves the did.jsonl content is not constrained", and a log "may be obtained from sources other than its corresponding HTTPS location … the same verification steps may be applied" **[primary: Create step 7; warning in DID to HTTPS]**.
- 71-09 plans the hub routes `GET /v1/trust/did/<path>/did.jsonl` and `did-witness.json` for authenticated members of the site **[repo: 71-09-PLAN.md]**. The site's ingress maps `https://<site host>/org/…` and `/people/…` to those routes, so the HTTPS location in the DID and the hub's route name the same file **[inference]**. Our own resolvers use the hub route (and the trust export, 71-11) directly.
- Two deliberate departures from public web hosting, both allowed by the "other sources" rule: logs are served to members only (D-16), and we do not send `Access-Control-Allow-Origin: *`, which the specification requires only so browsers anywhere can resolve **[primary: CORS section; inference]**. An outside resolver cannot resolve our DIDs; nothing in this phase needs one to.
- Content types: `text/jsonl` for the log, `application/json` for the witness file **[primary]**.

### Verifying a log from a cached copy, and resuming from cached verified state

- Every entry must be fully verified (proof and entry hash), even when only the latest document is wanted **[primary: Read (Resolve)]**. The specification's note allows a resolver that "caches previously verified state" to "retrieve only subsequent entries and resume processing after the last verified entry", "provided the cached state was itself produced by full verification and the cache has not been modified since" **[primary]**.
- What a cache must keep per DID, so it can resume and still answer historical questions **[inference from the Read steps]**:
  - the verified log bytes (all entries; history is needed to verify a credential at the time it was issued, through `versionTime`);
  - the SHA-256 of those bytes, to prove "not modified since" before resuming;
  - the last verified `versionId` (the next entry hash chains from it) and `versionTime` (the next must be strictly later);
  - the active parameters after the last entry: `method`, `scid`, `updateKeys`, `nextKeyHashes`, `witness`, `watchers`, `portable`, `deactivated`, `ttl`;
  - the `didIdMatchCount` result and the latest verified witness proofs.
- Resume: compare the cached hash with the stored prefix of the new copy, then verify only the new entries with the cached parameters; any mismatch in the prefix means a different history and the whole copy is refused **[inference]**.
- Edge clocks (research pitfall 12): an entry whose `versionTime` is more than about 5 minutes ahead of the resolver's clock "MUST cause resolution to fail" **[primary]**. An edge whose clock runs slow would then refuse a correct import. Recommendation for 71-04 and 71-11: treat that case as "not yet", keep the last verified state, and say so plainly, rather than marking the DID invalid; the specification also says resolvers "SHOULD NOT cache a DID that fails verification" **[primary; inference]**.
- Checked with our own code **[verified by running]**: every happy-path log in the DIF vectors (82 logs from six implementations: TypeScript, Python, Rust, Java, Java EECC, Dart; create, update, deactivate, key rotation, multi-update, several update keys, portable, portable move, pre-rotation, pre-rotation consumed, services, witnesses, an internationalized domain) verified with `canonical.ts`, `multibase.ts` and `verifyProof` of 71-01: SCID, entry-hash chain, authorized key, pre-rotation hashes and every eddsa-jcs-2022 proof. **82 of 82 passed.** That is also strong interim evidence for 71-01's JCS question: six independent JCS implementations produced bytes our canonical form reproduces exactly.
- That throwaway check was only a partial resolver. Of the 24 negative logs it refused 6; the rest test DID syntax, IP and traversal hosts, witness thresholds, duplicate witnesses, time order and cross-DID witness replay, which a partial check does not cover. 71-04 must implement the specification's whole "Resolver Validation Checklist" and run all of `negative-*` **[primary: checklist; repo: vectors]**.
- The suite's `resolutionResult.json` files are each implementation's raw output, not normalized ("no normalization is applied") **[primary: suite README]**, so 71-04 compares the document and the core metadata (`versionId`, `versionTime`, `scid`, `deactivated`, `updateKeys`), not whole files **[inference]**.

### Pre-rotation with an offline root key

- Pre-rotation is on once `nextKeyHashes` is non-empty. Each hash is base58btc of the SHA-256 multihash of the next key's Multikey string. While it is on, every entry must carry `updateKeys` and `nextKeyHashes` explicitly, every key in the new `updateKeys` must hash to a value in the previous `nextKeyHashes`, and the entry is signed by a key in its own `updateKeys` **[primary: Parameters; Pre-Rotation Key Hash; Authorized Keys]**. After use, a pre-rotation key "SHOULD be treated as spent and securely destroyed" **[primary]**.
- What `create-did` and the ceremony must keep (D-13) **[inference]**:
  - the current update key's sealed file and, in separate custody, the next update key's sealed file (its hash is in `nextKeyHashes`);
  - the full `did.jsonl`, and the SCID copied into the signed site file and `credentials@1`;
  - at each `rotate-did`: sign with the next key, make the key after it, commit its hash, destroy the spent key.
- Recommendation for 71-04 and 71-10: give the root DID a separate issuing key (its `assertionMethod`, used only by `issue-role`) from its update keys (used only to change the DID). Then a leaked issuing key is replaced by one log entry signed with the pre-rotated update key, and everything it issued can be revoked through the status lists. Cost: one more sealed key file in the same ceremony **[inference]**. Credentials issued by an earlier key still verify against the DID version in force at their `validFrom`, read from the log history **[inference from versionTime resolution, primary]**.

### People: with or without pre-rotation

**Recommendation: without (D-13's default).** **[inference]**
- A person's update key is their Transit key `person-<entity>` (ed25519, non-exportable, made only by the enrolment script) **[repo: deploy/openbao/enrol.mjs; 47-CONTEXT D-40]**. Transit makes a new key version only when the key is rotated **[primary: OpenBao Transit API, Rotate key]**, so the public key of a next version cannot be committed in advance. Pre-rotation would need a second Transit key per person and a change to the enrolment script.
- What pre-rotation would protect against (someone with the update key moving the DID to their own key) is covered more simply: the hub that hosts and witnesses a person's log refuses any entry that changes `updateKeys`. A person's update key is fixed for the life of that DID; a new key means re-enrolment and a new DID **[inference]**.
- A DID grants nothing by itself: access comes from credentials naming it, which are revoked through status lists (D-22) **[repo: 71-CONTEXT]**.
- Portability: a person moved between sites keeps their Transit key (export and import under Control Groups, 47 D-40) **[repo]**. Their DID can move with them only if `portable: true` was set in the first entry; it cannot be turned on later **[primary: Parameters, portable]**. Recommendation: `portable: true` for people's DIDs and the root, because trust is the pinned SCID, never the domain, and the specification requires resolvers to ignore earlier domains **[primary: DID Portability, security note; inference]**. This is a permanent choice made at creation.

### HQ as witness

- Witnesses must be `did:key` Ed25519 DIDs; `threshold` is an integer from 1 to the number of distinct witnesses; witness proofs are eddsa-jcs-2022 proofs over `{"versionId": …}`, kept in `did-witness.json`, which must be published before the log that contains the new entry; a witness must hold its own copy of the log and verify the candidate entry fully before signing **[primary: DID Witnesses]**.
- What a witness adds for us: an entry that reaches an edge through an export or another device carries proof that the hosting site accepted it, so two different versions of the same entry (a fork) cannot both be accepted **[inference]**.
- Which key signs: the hosting hub's own Ed25519 signing key (`HUB_SIGNING_KEY`, made by `--generate-key signing`) as a `did:key`, threshold 1. It is the party whose acceptance the proof states, and no new key is needed **[repo: hub/src/keys.ts, hub/src/secrets.ts; inference]**. Its witness inputs are 64-byte Data Integrity inputs, which can never equal a signed-payload input (71-01's domain-separation test) **[repo]**.
- Finding for the planner: D-13 says "HQ's hub is the witness". That works for every DID HQ hosts. A person first signing in at a disconnected edge site would wait for HQ. Recommendation: the hosting site's hub is the witness (HQ's hub for HQ people and for the root) **[inference]**. This is a planning detail for 71-04 and 71-10, not an owner question.

### Deactivation

- `deactivated: true` in a new entry; resolvers then return no document and report `deactivated: true`, while earlier versions stay resolvable by `versionId` or `versionTime` **[primary: Deactivate]**. With pre-rotation on, two entries are needed (turn pre-rotation off, then empty `updateKeys`) **[primary]**.
- For people (no pre-rotation): one entry, signed with their own key after a step-up, when they leave normally. When that is impossible (account already disabled), nothing is needed: the DID grants nothing once its credentials are revoked **[inference]**. Credentials issued in the past by a deactivated officer still verify at their issuance time through the log history **[primary: versionTime resolution; inference]**.
- Removing the log files is also called deactivation by the specification; we never do that, because history is needed for verification **[primary; inference]**.

### The proof suite

- For `did:webvh:1.0`: SHA-256 only, and "exactly eddsa-jcs-2022" for both log-entry proofs and witness proofs; a structurally valid proof in any other suite must be refused **[primary: Parameters, method]**. So `did:webvh` cannot be used under a strict FIPS rule that forbids Ed25519 (see O8).
- Log entries carry `proof` as an array **[primary: The DID Log File; repo: vectors]**. 71-01's `verifyProof` takes one proof object (its narrow credential rule); 71-04 passes each element of the array and requires at least one valid proof by an authorized key **[repo; inference]**.

### Sizes of a typical person log

Measured from the DIF vectors (bytes per JSON line, one verification method) **[verified by running]**:

| Entry | Size |
|---|---|
| First entry (create) | 1,362 to 1,556 bytes (1,801 with two update keys) |
| Each later entry (update, rotation, move, deactivation) | 1,217 to 1,708 bytes |
| A witness file with one proof for one entry | 536 bytes as the suite writes it (indented); about 400 bytes compact |

A person's log is one entry for most of their career and a few kilobytes at most; 400 people at HQ come to well under 2 MB, and a full export of logs to an edge is small **[inference]**.

did:webvh verdict: FULL. Every rule can be met with node:crypto, the existing canonical form and 71-01's multibase and proof code (82 of 82 DIF logs from six implementations verify with our code today), the hub can host logs on its trust routes behind the ingress, and people's DIDs need no pre-rotation. Conditions: 71-01's JCS verdict must be PASS; 71-04 implements the whole resolver checklist; a strict-FIPS site cannot use did:webvh (O8).

---

## (c) Status lists

Source: Bitstring Status List v1.0, W3C Recommendation 15 May 2025, https://www.w3.org/TR/2025/REC-vc-bitstring-status-list-20250515/ **[primary]**.

### What the specification fixes

- Minimum 131,072 entries (16 KB uncompressed) for herd privacy; a list shorter than that per `statusSize` is refused with `STATUS_LIST_LENGTH_ERROR` **[primary: 2.2 and 3.2]**.
- `encodedList` is multibase base64url (prefix `u`, no padding) of the GZIP of the bitstring; index 0 is the left-most bit **[primary]**.
- `revocation` "is not reversible"; `suspension` "is reversible" **[primary]**.
- `statusListIndex` is a base-10 string; issuers "SHOULD assign indexes randomly" **[primary]**.
- `ttl` is in **milliseconds**, optional, and "does not override or replace the validity period"; `validFrom` and `validUntil` are the list's own validity **[primary: 2.2]**. There is no suggested minimum or maximum validity **[primary: 7.2]**.
- Privacy: allocate indexes randomly and change lists as rarely as possible **[primary: 6.2]**.

### Sizes, measured with node:zlib

A 131,072-bit list with the given share of randomly chosen bits set, 20 random fills per row, on Node 24.22.3 and again on Node 26.13.1 (identical within a few bytes) **[verified by running]**:

| Bits set | GZIP default level (median; min to max) | GZIP level 9 (median) | `encodedList` characters (median) |
|---|---|---|---|
| 0 | 51 bytes | 51 bytes | 69 |
| 0.1 % (131) | 431 bytes (410 to 437) | 339 bytes | 576 |
| 1 % (1,311) | 2,123 bytes (2,106 to 2,143) | 1,885 bytes | 2,832 |
| 5 % (6,554) | 6,076 bytes (6,052 to 6,095) | 6,011 bytes | 8,103 |
| 20 % (26,214) | 12,285 bytes (12,269 to 12,298) | 12,285 bytes | 16,381 |
| 50 % (65,536) | 16,409 bytes | 16,409 bytes | 21,880 |

What that means for HQ **[inference]**: about 400 people with a handful of credentials each allocate a few thousand indexes (a few percent of the list), and only revoked or suspended ones are set, so a list stays under 1 KB compressed for years. The signed list credential is the encoded list plus about 1 KB of envelope and proof. Use GZIP level 9 (smaller at low fill; verifiers do not care).

### Recommendations

- **Lists per site, not per officer.** One revocation list and one suspension list per site, signed by that site's `status-list-<site>` Transit key (D-14). Every officer of the site uses the same pair, which is what the compare-and-swap below is for. Per-officer lists would tell a verifier who issued a credential by its list, multiply fetches and exports, and give each list a smaller crowd **[inference; primary: 6.1 and 6.2]**.
- **Random indexes, never reused.** Draw each index uniformly from the indexes never allocated on that list; record it in the issued register (`kv/site/issued/<entity>/<credential hash>`, D-22) **[repo]**. Never reuse an index, even after a credential expires: a reused index would make an old revoked credential look like the new one's status or the other way round **[inference]**. Allocation must be atomic: the officer's backend takes the index under the same compare-and-swap as the list. Start a new list pair when half the indexes are allocated (65,536), so random draws stay fast and the crowd stays large **[inference]**.
- **`validUntil` and `ttl` against O6.**
  - `ttl`: 900,000 ms (15 minutes), the connected time to live of O6; the hub also sends `Cache-Control: max-age=900` **[primary: ttl note; repo: O6]**.
  - `validUntil`: `validFrom` plus the longest maximum offline age in the policy (default 7 days, Protected A). Each verifier then applies its own level's age from the list's `validFrom` (D-11, D-17: Protected B 72 hours, classified 24 hours) **[inference]**.
  - A verifier refuses a list outside `validFrom` to `validUntil` (our profile's rule; VC 2.0 leaves validity checks to the verifier) **[inference]**.
- **The hub's grace.** Default grace = the time to live (15 minutes), as D-11 says: the hub refuses an append that cites a list whose `validFrom` is older than its newest list's `validFrom` by more than the grace. A list that has not changed is always "the newest", so no re-signing is needed at a connected HQ **[repo: D-11; inference]**.
- **Compare-and-swap for two officers.** The hub stores, per list, the current signed list and its hash. An update names the hash it was built on (outside the signed list, as a request field); the hub stores it only if that hash is still current, the new `validFrom` is later, no revocation bit is cleared, and the new list verifies against the policy key for that list (D-14). Otherwise it answers "changed since you started", and the officer's backend fetches the newer list, applies the same change again and signs again within the step-up window. No signed field is added **[inference]**.

### Finding: re-signing for edges

Under D-11 and D-17 an edge counts offline age from each list's own `validFrom`. A classified edge (24 hours) therefore needs a list signed within the last 24 hours in each import, even when no bit changed. Every list signature needs an officer's step-up (D-14, O4). So a security officer re-signs the site's lists when an export for a classified edge is cut, at most daily. This is a planning detail for 71-11 and 71-12 (do it in the same session as the export), not a reason for the fallback **[inference]**.

status lists verdict: FULL. The 131,072-entry list compresses to under 1 KB at HQ's expected fill (12.3 KB even at 20 percent), node:zlib and node:crypto cover building, signing and reading it, and the lifetimes fit O6 with the hub's grace and compare-and-swap; the only extra cost is a step-up re-sign when a list is exported to a classified edge.

---

## O8 FIPS posture

O8 (accepted): accept ITSP.40.111 v5's EdDSA recommendation, carry `ecdsa-jcs-2019` as a second credential suite, and record the `did:webvh` limit as a condition **[repo: RESEARCH.md section 8]**.

### Facts

| Question | Finding | Mark |
|---|---|---|
| Is EdDSA an approved FIPS signature algorithm? | Yes under FIPS 186-5: the Go Cryptographic Module's FIPS 140-3 certificates list "EDDSA SigGen" and "EDDSA SigVer" among Approved Algorithms (CMVP #5247, CAVP A6650; CMVP #5581, Active, sunset 2031-11-12, CAVP A8028) | [primary] https://csrc.nist.gov/projects/cryptographic-module-validation-program/certificate/5581 |
| Is Ed25519 approved in the validated OpenSSL FIPS provider? | No. The only OpenSSL FIPS 140-3 validation is the 3.1.2 provider (CMVP #4985, Active, sunset 2030-03-10); its security policy lists Ed25519 and Ed448 under "Non-Approved, Not Allowed Algorithms" and "Non-Approved Services". ECDSA on P-256 is approved | [primary] https://csrc.nist.gov/projects/cryptographic-module-validation-program/certificate/4985 and its security policy 140sp4985.pdf |
| OpenSSL 3.5 and 3.6's own FIPS provider | Their man pages list ED25519 among the FIPS provider's signatures without marking it unapproved (X25519 is marked unapproved), but OpenSSL's download page lists only 3.1.2 (FIPS 140-3) and 3.0.x (FIPS 140-2) as validated, and says other releases may use the 3.1.2 provider but "MUST NOT build and use their own FIPS provider" | [primary] https://docs.openssl.org/3.6/man7/OSSL_PROVIDER-FIPS/ ; https://openssl-library.org (downloads page) |
| The UBI 9 base | Red Hat Enterprise Linux 9 OpenSSL FIPS Provider, version 3.0.7, CMVP #5573 (validated 2026-11-09, Active, sunset 2029-10-28): its approved table has ECDSA P-224 to P-521 (FIPS 186-5) and no EdDSA; EdDSA is not in its non-approved tables either, so the module does not offer it in FIPS mode. "RSA and ECDSA (pre-hashed message)" is not allowed | [primary] https://csrc.nist.gov/projects/cryptographic-module-validation-program/certificate/5573 and 140sp5573.pdf; [inference] for "does not offer" |
| Does upstream Node 26.13.1 use a FIPS module? | No. It reports OpenSSL 3.5.9 and `crypto.getFips()` = 0; `--enable-fips` fails with "requires an active OpenSSL provider named fips". The UBI 9 system OpenSSL is not used by upstream Node (RESEARCH 10.2) | [verified by running]; [repo] |
| OpenBao's FIPS status | No official FIPS 140-3 build. Issue #1409 "Add FIPS-140-3 Compliant Build" is open (2025-06-05); the community call of 2026-09-17 put it into the 2027 roadmap discussions. A third party (wolfSSL) is evaluating OpenBao with wolfCrypt FIPS (#4164) | [primary] https://github.com/openbao/openbao/issues/1409 |
| Vault's note | "In FIPS 140-3 mode, the following algorithms are not certified and thus should not be used: chacha20-poly1305 and ed25519." | [primary] https://developer.hashicorp.com/vault/docs/secrets/transit |
| W3C status of `ecdsa-jcs-2019` | Data Integrity ECDSA Cryptosuites v1.0, W3C Recommendation 15 May 2025; section 3.3 defines `ecdsa-jcs-2019` (SHA-256 for P-256, the same two-hash input as eddsa-jcs-2022, a 64-byte r‖s signature for P-256) | [primary] https://www.w3.org/TR/2025/REC-vc-di-ecdsa-20250515/ |
| Can its examples be frozen as vectors? | Yes, for verification: Appendix A.5 (P-256) checked with our `canonical.ts` and `node:crypto`: the proof-options hash and the combined hash match, and the example signature verifies (SHA-256, `dsaEncoding: 'ieee-p1363'`); one flipped bit is refused. Not for byte-equal signing: the specification says signatures use the IEEE P1363 (r‖s) form and "SHOULD use the deterministic variant" of FIPS 186-5, but `node:crypto` signs with a random nonce (two signatures of the same input differ), so our tests sign then verify, and check the example by verifying it | [primary] A.5 Examples 49 to 59; [verified by running] |
| How Transit returns ECDSA P-256 signatures | Key type `ecdsa-p256`; `hash_algorithm` defaults to `sha2-256`; `prehashed` false (send the 64-byte Data Integrity input, Transit hashes it); `marshaling_algorithm` `asn1` (default, DER) or `jws`, "the version used by JWS", which also switches to URL-safe base64. JWS ES256 signatures are the 64-byte r‖s (RFC 7518 section 3.4). The returned value is prefixed `vault:v<key version>:` | [primary] https://openbao.org/docs/api/secret/transit/ ; RFC 7518 [primary, not re-read today] |
| ITSP.40.111 v5 | Recommends EdDSA on Edwards25519 (RESEARCH 3.1) | [primary, in RESEARCH.md] |

### Reading

- Ed25519 is an approved algorithm (FIPS 186-5) and recommended by ITSP.40.111 v5, but none of the modules our stack would actually run in has it as approved and validated today: upstream Node does not use a FIPS module at all, OpenBao has no FIPS build, the validated OpenSSL providers exclude it, and the Go module that approves it is not what OpenBao ships **[inference from the facts above]**.
- So a site whose rule is "only algorithms approved in a FIPS 140-3 validated module" cannot use Ed25519 credentials or `did:webvh:1.0` today. Every other site follows O8 as accepted **[inference]**.
- This is the same position as today's X25519 and AES-GCM in upstream Node, which RESEARCH 10.2 already records **[repo]**.

### The ready fallback for a strict-FIPS site

Only what changes; everything else in the profile stays (D-05: every proof names its suite):

1. **Credentials:** `ecdsa-jcs-2019` on P-256 (Multikey header `0x1200`, compressed key) instead of eddsa-jcs-2022. 71-03 already plans the second suite **[repo: 71-CONTEXT D-05]**. The W3C P-256 example (A.5) is frozen for verification, as above.
2. **Issuers:** no `did:webvh` (v1.0 allows only Ed25519). Officers issue from a P-256 `did:key` whose key is their own Transit person key of type `ecdsa-p256`, signed after the step-up, and the signed policy names that `did:key` as a person key (D-07 under the fallback, owner item 2). Devices and agents never issue **[repo: D-07]**. The root issues role credentials from an offline P-256 key named in the policy.
3. **Status lists:** an `ecdsa-p256` Transit status-list key, with the same step-up authorization (D-14).
4. **Signing through Transit:** `hash_algorithm=sha2-256`, `prehashed=false`, `marshaling_algorithm=jws`; strip `vault:v<N>:` and decode the URL-safe base64 to the 64-byte r‖s that `ecdsa-jcs-2019` puts in `proofValue` **[primary: Transit API; inference]**. Verification in Node uses `crypto.verify('sha256', hashData, { key, dsaEncoding: 'ieee-p1363' }, signature)` **[verified by running]**.
5. **What it still does not give:** a FIPS 140-3 validated module. Upstream Node and OpenBao are not validated builds, so a strict site also needs a validated build of each (for example Node against the Red Hat OpenSSL FIPS provider, and a FIPS build of OpenBao, which does not exist yet). That is a site accreditation matter, outside this phase **[inference]**.

### Condition text for 48.1-09 (crypto inventory)

Recorded in the gap register as **G350** ("Ed25519 does not run in a validated module anywhere in the stack": appliesAt protected-b, blocks production, closes in Phase 71), added by #191.

> **O8 (accepted 2026-11-24):** Verified credentials, people's and your organization's DIDs (`did:webvh` v1.0) and status lists are signed with Ed25519 (`eddsa-jcs-2022`). EdDSA is approved under FIPS 186-5 and recommended by ITSP.40.111 v5, but it runs in upstream Node 26.13.1's bundled OpenSSL 3.5.9 with FIPS off and in OpenBao Transit, which has no FIPS build; the validated OpenSSL FIPS providers (3.1.2, CMVP #4985; RHEL 9 3.0.7, CMVP #5573) do not approve it. Condition: a site that requires FIPS 140-3 validated modules uses the ready fallback (`ecdsa-jcs-2019` on P-256, officers' P-256 `did:key` person keys named in the signed policy, a P-256 status-list key, no `did:webvh`) and validated builds of Node and OpenBao. Open until such a site is planned.

O8 posture: accepted as decided; Ed25519 (eddsa-jcs-2022 and did:webvh) everywhere by default, with the ecdsa-jcs-2019 P-256 fallback specified above and its W3C example verified with node:crypto, and the 48.1-09 condition recorded; no module in our stack is FIPS 140-3 validated for Ed25519 today, which matters only to a site that requires validated modules.

---

## For the owner: items 1 and 2 (71-02 Task 3)

Both verdicts are FULL, so the fallback is not in use; item 2 only matters if a strict-FIPS site or a later FALLBACK verdict uses it.

1. **Solo installs (D-08, VCRD-07).** Default: with no organization policy in force, your own declared clearances keep working on your own computer, shown as "declared, not verified". They are never credentials, never cited as evidence, and never count in a shared project, a hub, a wrap or your organization's policy. No device key ever issues. VCRD-07's sentence "a person with no organization issues their own credentials from their device DID" is rewritten to say this. Alternative: the person signs their own credentials with a person key on the single computer, which needs a passkey there, changes today's setup, and needs 71-08 Task 2 revised first.
2. **The fallback and "devices never issue" (D-07).** Default: under the fallback (or at a strict-FIPS site), only an officer's person key that the signed policy names may issue; no device or agent ever issues. Alternative: keep O9's fallback as written, with `did:key` officers, and drop the structural rule while the fallback is in use.

**Answered by the owner on 2026-11-24: "defaults" for both items.** Solo installs keep "declared, not verified" clearances on their own computer only, and devices never issue; under the fallback only officers' person keys that the signed policy names may issue. Recorded as confirmations of D-07 and D-08 in `71-CONTEXT.md`, and VCRD-07's text in `REQUIREMENTS.md` is rewritten.
