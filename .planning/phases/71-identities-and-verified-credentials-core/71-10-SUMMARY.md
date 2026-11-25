---
phase: 71-identities-and-verified-credentials-core
plan: 10
subsystem: identities
status: complete
tags: [person-did, root-did, pre-rotation, role-credentials, key-ceremony, org-issuer, device-binding, people-directory]
requires:
  - "71-03: issueCredential, verifyCredential"
  - "71-04: buildGenesisEntry, buildUpdateEntry, nextKeyHash, verifyWebvhLog, methodsAt, didKeyFromDevice"
  - "71-09: POST /v1/trust/did/<path>/did.jsonl through a hub session"
  - "46-07: KeyService.sign (step-up enforced by OpenBao), personPublicKey"
provides:
  - "workbench/extension/src/node/credentials/identity-service.ts: createIdentityService (ensurePersonDid, publishToHub, bindComputer, status), openBaoKv, HubTrustSession, StatusAllocator"
  - "workbench/extension/src/node/credentials/credentials-backend-module.ts and RPC /services/sterling-identity (status, retry, bindComputer)"
  - "workbench engine/identity.cjs (tools/identity-entry.ts)"
  - "src/domain/did/deviceWords.ts: deviceIdentityWords, deviceFingerprint"
  - "src/gate/deviceIdentityCommand.ts: nearAi.identity.showThisComputer (Show This Computer's Identity)"
  - "scripts/org-issuer.mjs: create-did, rotate-did, issue-role; DID key files of their own kind (near-ai-org-did-key)"
  - "OpenBao policy sterling-workbench: create and read on kv/data/site/people/{{identity.entity.id}} only"
affects: [71-12, 71-13, 71-14, 33-23, Phase 47 site values]
tech-stack:
  added: []
  patterns:
    - "The person's DID is made by their own backend and posted through their own authenticated hub session (D-24)"
    - "The rules key and the root identity keys are sealed alike but of different kinds, so neither opens as the other"
key-files:
  created:
    - workbench/extension/src/node/credentials/identity-service.ts
    - workbench/extension/src/node/credentials/credentials-backend-module.ts
    - workbench/extension/src/common/identity.ts
    - workbench/tools/identity-entry.ts
    - workbench/test/credentials-identity-service.test.ts
    - src/domain/did/deviceWords.ts
    - src/gate/deviceIdentityCommand.ts
    - src/test/gateDeviceIdentity.test.ts
  modified:
    - workbench/extension/package.json
    - workbench/tools/build-engine.mjs
    - deploy/openbao/policies/sterling-workbench.hcl
    - deploy/test/openbao.test.mjs
    - scripts/org-issuer.mjs
    - scripts/test/orgIssuer.test.mjs
    - src/services/gateCommands.ts
    - package.json
    - compliance/gaps.json
    - docs-site/content/security/road-to-production.md
    - .planning/phases/71-identities-and-verified-credentials-core/71-CONTEXT.md
decisions:
  - "D-24 (coordinator, reported to the owner): option A. The DID is made at first sign-in and posted at the person's first hub session, through it, once; never a first log without a session, never officer-published"
  - "A person's DID path is people/<16 random hex characters>; the Transit person key is both the update key and the issuing key (#key-1)"
  - "The log and a published flag live at kv/users/<own entity>/identity/did-webvh; the directory entry is created after it, so a stopped session is finished later without a second signature"
  - "People's DIDs live under STERLING_DID_DOMAIN; without it a hosted session makes nothing (not-configured)"
  - "Device words: sha256('near-ai/device-identity/v1' NUL did), six 11-bit picks from the existing safety word list; the binding's device claim is dev- and the first 16 bytes of the same hash"
  - "create-did makes both key files itself; issue-role takes both --status (revocation) and --suspension"
metrics:
  completed: 2026-11-24
estimate:
  tokens: 110057
  tasks: 3
actuals:
  tokens: 22000
  tasks: 3
  commits: 3
plan_head_before: b6f74d9f
plan_head_after: 81922c8c
---

# Phase 71 Plan 10: Identities in use Summary

All three tasks are done.

- **Each person's DID** is made by their own backend at first sign-in, signed once with their own person key after the step-up.
- **The root and the officers' authority** are made offline, by people, in a key ceremony.
- **A single computer** is bound to its person once the six words match.

Two dependencies are not in service yet, so G427 stays open:
- the post to your organization's server needs a hub session, which waits for Phase 33's hosted keys;
- binding needs status list indexes, which wait for 71-12.

## Decision D-24 (71-10's checkpoint, coordinator 2026-11-24, reported to the owner)

**Option A.** The person's backend makes the DID at first sign-in and posts the log at the person's first hub session, through that authenticated session, once.

- **Rejected: B.** A first log without a session would add an unauthenticated route and widen G426's first-come risk.
- **Rejected: C.** Officers publishing people's logs; logs stay person-controlled.

Hub sessions in a hosted workbench arrive with Phase 33's hosted session keys (33-21 to 33-23), which are not on `main`. So `publishToHub` is built and tested against a fake hub, and its call site is 33-23's. Recorded in 71-CONTEXT.md.

## As built

### The person's DID (Task 1)

- **When:** `ensurePersonDid()` runs once the session identity is `active` (the backend waits at most five minutes, then Retry covers it). The steps:
  1. The person key's public key is read (`personPublicKey`).
  2. The genesis entry is built (`did:webvh:<SCID>:<STERLING_DID_DOMAIN>:people:<random id>`), with the person key as update key and issuing key `#key-1`.
  3. It is signed through `KeyService.sign` (step-up), checked with `verifyWebvhLog`, and kept at `kv/users/<entity>/identity/did-webvh` (`format: sterling-person-did/1`, did, path, log, published).
  4. Last, `kv/site/people/<entity> = { did }` is created (create only).
- **States** (`IdentityStatus`):
  - `not-configured`: no `STERLING_DID_DOMAIN`, no engine bundle, or a single computer;
  - `pending`: "Your identity is not set up yet.", with Retry;
  - `ready`: the DID, and whether your organization's server has it.
- **A step-up refusal or an unreachable store writes nothing new.** If a session stops between the two writes, the next one finishes the directory entry from the kept log without signing again.
- **`publishToHub(hub)`** posts `people/<id>` once. A refusal ("Your organization's server did not take your identity. It is sent again at your next session.") leaves `published: false`, and it is retried.
- **The OpenBao policy** allows create and read on `kv/data/site/people/{{identity.entity.id}}` only: no wildcard, no other person's entry, no update, list or delete.

### Binding a computer (Task 3)

- **Show This Computer's Identity** (`nearAi.identity.showThisComputer`) shows the Phase 69 device key as a did:key, unchanged, with six words. A Copy button copies the did:key. Nothing secret is shown, and no key is made.
- **`bindComputer(didKey, words, class)`** runs in the person's session (RPC `/services/sterling-identity`). It checks:
  1. the did:key;
  2. the six words (case and spacing ignored);
  3. that the person's identity exists;
  4. status list indexes from the `StatusAllocator` (71-12);
  5. then it signs through `KeyService.sign`, so the step-up applies.
- **The result** is a DeviceBindingCredential `{ id: did:key, device: dev-<32 hex>, class }`, issued by the person's did:webvh. It lasts 365 days and comes back as `computer-<8 hex>.near-vc` for the computer's wallet (`Wallet.importFile`, 71-08).
- **Until 71-12 provides the allocator,** it refuses with "Binding a computer needs your organization's status lists, which are not set up yet. Ask your organization's security officer." (G427).

### The org-issuer commands (Task 2)

```
node scripts/org-issuer.mjs create-did --key <root key file> --next-key <next key file> --domain <host> --out <name.did.jsonl> [--path org]
node scripts/org-issuer.mjs rotate-did --log <name.did.jsonl> --key <next key file> --next-key <new next key file> --out <name.did.jsonl>
node scripts/org-issuer.mjs issue-role --key <root key file> --log <name.did.jsonl> --type <role type> --subject <person did:webvh> \
  --claims <claims.json> --status <revocation list id>#<index> --suspension <suspension list id>#<index> --out <name.near-vc> [--days 365]
```

- **The DID strings:**
  - root: `did:webvh:<SCID>:<host>:org`;
  - people: `did:webvh:<SCID>:<host>:people:<16 hex>`.
- **Key files:** sealed like the rules key file, with kind `near-ai-org-did-key`. Neither key signs as the other (owner item 4).
- **Pre-rotation:** only the committed next key may rotate the root. `issue-role` gives the five role types to a person's did:webvh only, never to a did:key.
- **Exit codes:** 0 done, 1 refused (one sentence), 2 usage.

## Verification

- **Failing first:** the new test files did not compile before `identity-service.ts`, `deviceWords.ts` and `deviceIdentityCommand.ts` existed. The new policy test failed on the unchanged policy, and the org-issuer tests named commands the tool did not have.
- **Tests added:**
  - `workbench/test/credentials-identity-service.test.ts` 8 (at least 6 asked);
  - `src/test/gateDeviceIdentity.test.ts` 5 (at least 4 asked);
  - `scripts/test/orgIssuer.test.mjs` 8 (at least 8 asked);
  - `deploy/test/openbao.test.mjs` 1. Its existing exact list of session-policy paths gains the one new path; nothing is loosened.
- **Tests run (capped, under the heavy-command lock, 2026-11-24):**
  - the workbench lint and unit tests: 114 of 114, the identity file's 8 among them (H-71-01 checked: the file runs);
  - the full root suite: 6,461 tests, 6,453 passed, 0 failed, 8 skipped;
  - `deploy/test/openbao.test.mjs` with helm: 13 of 13.
- **Acceptance greps:**
  - `site/people/{{identity.entity.id}}` in `sterling-workbench.hcl`: 1;
  - `'issue-role'` in `org-issuer.mjs`: 2;
  - `Show This Computer's Identity` in `package.json`: 1.

## Deviations from Plan

**1. The workbench test is flat:** `workbench/test/credentials-identity-service.test.ts`, not `test/credentials/identity-service.test.ts` (H-71-01, option a), so the runner runs it.

**2. The post to the hub happens at the first hub session, not at first sign-in** (D-24). The plan put the post inside `ensurePersonDid`.

**3. `STERLING_DID_DOMAIN` is a new workbench setting.** The plan named no setting for the DID host. It is read by the credentials backend module only; the site chart does not render it yet (G427).

**4. Binding takes status indexes from a `StatusAllocator`.** Every credential carries one revocation and one suspension entry (D-05), and only your organization's issuance setup (71-12) may hand out indexes.

**5. `--suspension` is a second required flag for `issue-role`, and `create-did` makes both key files** (for the same reason as deviation 4, and as the action describes).

**6. The device words have their own derivation, in `src/domain/did/deviceWords.ts`.** They come from the existing safety word list; no new list. The join safety code needs an invite and a nonce, which a single computer does not have.

## Open conditions

- **G427:** the logs are not published until Phase 33's hosted session keys are on `main`; the site does not render `STERLING_DID_DOMAIN` yet; and binding waits for 71-12's status indexes.

## Known Stubs

- `StatusAllocator` has no production implementation; 71-12 provides it (G427). Until then `bindComputer` refuses with a plain sentence, and nothing is half-made.
- `publishToHub` has no production caller; 33-23's hosted hub session calls it (G427).

## Threat Flags

None. T-71-37 to T-71-40 are mitigated as planned: the templated directory path, the offline root with pre-rotation, no role for a did:key, and words plus a step-up before a binding.

## Self-Check: PASSED

All created files exist. Commits 95fa4c68, 5040455e and 81922c8c are on the branch.
