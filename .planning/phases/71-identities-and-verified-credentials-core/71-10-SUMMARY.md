---
phase: 71-identities-and-verified-credentials-core
plan: 10
subsystem: identities
status: partial
tags: [root-did, pre-rotation, role-credentials, key-ceremony, org-issuer]
requires:
  - "71-03: issueCredential, verifyCredential"
  - "71-04: buildGenesisEntry, buildUpdateEntry, nextKeyHash, verifyWebvhLog, methodsAt"
provides:
  - "scripts/org-issuer.mjs: create-did, rotate-did, issue-role; DID key files of their own kind (near-ai-org-did-key)"
affects: [71-12, 71-14]
tech-stack:
  added: []
  patterns:
    - "The rules key and the root identity keys are sealed alike but of different kinds, so neither opens as the other"
key-files:
  created: []
  modified:
    - scripts/org-issuer.mjs
    - scripts/test/orgIssuer.test.mjs
decisions:
  - "create-did makes both key files itself (never over an existing file); the root's DID document has one Multikey, #root, the key in force"
  - "issue-role takes both status entries, --status (revocation) and --suspension, because the profile requires one of each"
  - "A role credential is never dated before the root's latest log entry, so a verifier finds the signing key in force at its validFrom"
metrics:
  completed: 2026-11-24
estimate:
  tokens: 110057
  tasks: 3
actuals:
  tokens: 8100
  tasks: 1
  commits: 1
plan_head_before: b6f74d9f
plan_head_after: 95fa4c68
---

# Phase 71 Plan 10: Identities in use Summary

Task 2 is done: your organization's root identity and its role credentials are made offline with `scripts/org-issuer.mjs`. Tasks 1 and 3 stop at a decision (below): a person's backend has no way to reach the hub's trust routes today.

## The org-issuer commands as built

```
node scripts/org-issuer.mjs create-did --key <root key file> --next-key <next key file> --domain <host> --out <name.did.jsonl> [--path org]
node scripts/org-issuer.mjs rotate-did --log <name.did.jsonl> --key <next key file> --next-key <new next key file> --out <name.did.jsonl>
node scripts/org-issuer.mjs issue-role --key <root key file> --log <name.did.jsonl> --type <role type> --subject <person did:webvh> \
  --claims <claims.json> --status <revocation list id>#<index> --suspension <suspension list id>#<index> --out <name.near-vc> [--days 365]
```

- **The DID string:** `did:webvh:<SCID>:<host>:org` (another path with `--path`). The log is one line per entry; publish it at the hub as `/v1/trust/did/org/did.jsonl` (71-09).
- **Key files:** sealed like the rules key file (scrypt N = 2^17, AES-256-GCM, 0600, written once), with kind `near-ai-org-did-key`. The rules key cannot sign as the root identity, and a root key cannot sign rules: each refusal says the two are kept apart (owner item 4).
- **Pre-rotation:** `create-did` commits to the next key's hash; `rotate-did` accepts only that key and commits to a new next key. Any other key is refused in one sentence and nothing is written, not even the new key file.
- **issue-role:** the five role types only, for a person's `did:webvh` only. A `did:key` subject is refused ("A device or an agent never issues, so it never holds a role"). The credential must verify with the root key in force before the file is kept.
- Exit codes as before: 0 done, 1 refused (one sentence), 2 usage.

## Checkpoint: how does a person's backend post their DID log to the hub?

**Type:** decision. **Blocks:** Task 1 (`ensurePersonDid` posts the genesis log to the hub) and Task 3 (`bindComputer` needs the person's DID that Task 1 makes).

The hub's trust routes, like all its routes, need a hub session, and a hub session belongs to a person's **device in one project** (a challenge answered with that device's key on that TLS connection). A hosted workbench session at a person's first sign-in has no project device: Phase 33's hosted session keys (33-21 to 33-23) and the native engine (33-24) are not on `main`. The plan assumed the backend can post; it cannot today.

| Option | What it means | Cost |
|---|---|---|
| A. Post at the first hub session (recommended) | At first sign-in the backend makes the DID, signs it after the step-up, and writes `kv/site/people/<own entity>` and the log under the person's own KV prefix. The log is posted the first time the person's session opens a hub session (33-23's hosted session key). Until then the state is `identity-pending` only for hub-backed actions. | Needs 33-21 to 33-23 on `main`; no new hub route |
| B. A hub route for first logs without a session | The hub accepts a genesis log alone, unauthenticated, rate-limited per address. | Anyone reaching the hub can claim addresses (G426's first-come risk grows); a new unauthenticated surface |
| C. The officer's backend publishes logs | 71-12's officer session posts each person's log from the people directory. | Ties every person's identity to an officer's action; slower enrolment |

## Verification

- **Failing first:** the new tests named commands the tool did not have (usage, exit 2).
- **Tests added:** 8 in `scripts/test/orgIssuer.test.mjs` (at least 8 asked). The existing ones pass unchanged.
- **Tests run:** `npm run compile`, then `orgIssuer`, `credentialsTrustExport`, `architecture` and `credentialsEvidence` in one capped run under the heavy-command lock: 50 tests, 50 passed (2026-11-24).
- **Acceptance grep:** `grep -c "'issue-role'" scripts/org-issuer.mjs`: 2.

## Deviations from Plan

**1. `--suspension` is a second required flag.** The plan names one `--status`. The credential profile requires one revocation and one suspension entry on every credential (D-05), so the operator gives both.

**2. `create-did` makes both key files.** The plan's behaviour reads "both key files are sealed as create-key seals them and never overwritten"; the action says it makes the next key file at the same time. The tool makes both, refuses if either exists, and never overwrites.

## Not done: Tasks 1 and 3

They wait for the decision above. This is plan work, not a gap.

## Open conditions

None.

## Known Stubs

None.

## Threat Flags

None. T-71-38 and T-71-39 are mitigated by Task 2 as planned; T-71-37 and T-71-40 belong to the blocked tasks.

## Self-Check: PASSED

`scripts/org-issuer.mjs` and its test are changed as listed. Commit 95fa4c68 is on the branch.
