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

