---
phase: 71-identities-and-verified-credentials-core
plan: 12
subsystem: credential-issuance
status: complete
tags: [issuance, status-list-key, issuer-stepup, revocation-requests, inbox, issue-credential-card, d-14, d-15, d-22]
requires:
  - "71-03: issueCredential, readCredential, verifyCredential, credentialHash"
  - "71-05: buildStatusList, signStatusList, verifyStatusList, setBit, clearSuspension, statusAt"
  - "71-06: issuerAuthority, credentials@1"
  - "71-09: GET|PUT /v1/trust/status/<name> with compare-and-swap; GET /v1/trust/did/<path>/did.jsonl"
  - "71-10: the person's DID record and directory entry; IdentityService"
  - "46-07: KeyService.sign (step-up enforced by OpenBao)"
provides:
  - "deploy/openbao: Transit key status-list-<siteName>, policy credential-issuers, jwt role sterling-issuer-stepup (only when the site file names credentialIssuers); planNotes, statusListKey, credentialIssuers, ISSUER_ROLE"
  - "workbench/extension/src/node/credentials/issuer-service.ts: createIssuerService (issuableTypes, review, issue, listIssued, revoke, suspend, clearSuspension, listRevocationRequests, resolveRequest), inboxVerifier, openBaoIssuerLogin, didHostPath"
  - "workbench/extension/src/common/issuer-service.ts: RPC /services/sterling-issuer, ISSUER_TEXT, REVOCATION_REASON_TEXT, INBOX_TEXT"
  - "IdentityService.collectInbox(check), inboxNews(); IdentityServiceRpc.inboxNews()"
  - "src/domain/credentials/issueForm.ts: issuableTypes, formFor, validateForm, reviewSentence, revokeSentence, suspendSentence, liftSentence, validUntilFor, ISSUE_FORM_TEXT"
  - "SovAI: Issue Credential (sterling.credentials.issue), the native card"
affects: [71-13, 71-14, 47-20, 47-31, 47 site values, 48.1 key inventory]
tech-stack:
  added: []
  patterns:
    - "Authority before any step-up, place or signature: the form's checks, then issuerAuthority on the very credential to be signed"
    - "Two tokens: the person's own session token for their own paths, the issuer step-up token (revoked after each call) for site paths and other people's inboxes"
    - "The card renders backend answers only; every sentence about a credential comes from issueForm.ts through the engine bundle"
key-files:
  created:
    - deploy/openbao/policies/credential-issuers.hcl
    - workbench/extension/src/node/credentials/issuer-service.ts
    - workbench/extension/src/common/issuer-service.ts
    - workbench/extension/src/common/issue-credential-card.ts
    - workbench/extension/src/browser/credentials/issue-credential-widget.ts
    - workbench/extension/src/browser/credentials/credentials-frontend-module.ts
    - workbench/extension/src/browser/issue-credential.css
    - workbench/test/credentials-issuer-service.test.ts
    - workbench/test/credentials-issue-credential-card.test.ts
    - src/domain/credentials/issueForm.ts
    - src/test/credentialsIssueForm.test.ts
  modified:
    - deploy/openbao/apply.mjs
    - deploy/test/openbao.test.mjs
    - deploy/values/site.example.yaml
    - workbench/extension/src/node/credentials/identity-service.ts
    - workbench/extension/src/node/credentials/credentials-backend-module.ts
    - workbench/extension/src/common/identity.ts
    - workbench/extension/package.json
    - workbench/tools/identity-entry.ts
    - compliance/gaps.json
    - compliance/test/gaps.test.ts
    - docs-site/content/security/road-to-production.md
    - .planning/phases/71-identities-and-verified-credentials-core/71-HANDOFFS.md
decisions:
  - "Status list places are claimed once each at kv/site/status-index/<purpose>-<list name>/<index> with check-and-set 0 (one retry with a new random index), not through the hub; the hub's compare-and-swap guards the list versions"
  - "A revocation request's person is shown by the name the issuing officer typed (kept in the issued register as personName); no name is signed into any credential"
  - "Revoke, suspend and lift are open to any holder of a current role for that credential type, not only the one who issued it; each officer's lists still show only what they issued"
  - "The last day of a credential is inclusive: validUntil is the start of the next day, UTC"
  - "The hosted wallet of checked inbox items is the person's own KV folder kv/users/<entity>/credentials-wallet/<hash>; 71-13 joins it to the extension's Wallet (G465)"
metrics:
  completed: 2026-11-24
estimate:
  tokens: 120062
  tasks: 3
actuals:
  tokens: 33000
  tasks: 3
  commits: 4
plan_head_before: 32007751
plan_head_after: 81286bde
---

# Phase 71 Plan 12: Issuance and revocation from the officer's own session Summary

All three tasks are done. An officer issues, revokes and suspends credentials in their own session, signed by their own person key, and the status lists are signed by the site's status-list key only through a step-up by a named officer. The revocation inbox that 47-20 and 47-31 file into reaches the officers who issued to that person, and a person's credentials reach their wallet at their next sign-in.

None of it is reachable in a hosted session yet: it needs 71-13's trust source (your organization's rules in the session), 33-23's hub session and the site's settings. All of that is G465. Binding a computer now takes its places from the person's own computer slots (D-25, owner 2026-11-25, which closed G466); see the D-25 section.

## OpenBao as built (for the 48.1 key inventory and Phase 47)

| What | Path or name | Notes |
|---|---|---|
| Status-list key | `transit/keys/status-list-<siteName>` | ed25519, `exportable: false`, `allow_plaintext_backup: false`. Created by `apply.mjs` on every site. `siteName` must be lower-case letters, digits and `-`. |
| Issuer step-up role | `auth/jwt/role/sterling-issuer-stepup` | `bound_claims: { acr: <stepUpAcr>, sub: <credentialIssuers> }`, TTL, max TTL and explicit max TTL all equal to `stepUpMaxAgeSeconds`, no period, `token_policies: [sterling-workbench, sterling-workbench-sign, credential-issuers]`. Only made when the site file names `credentialIssuers`; otherwise the dry run says so on stderr. |
| Policy `credential-issuers` | see below | Only that role holds it. The base role and the person's own step-up role do not. |

The `credential-issuers` policy (`${site.siteName}` filled in by `apply.mjs`):

| Path | Capabilities |
|---|---|
| `transit/sign/status-list-<siteName>` | update |
| `kv/data/users/+/credentials-inbox/*` | create |
| `kv/data/site/people/*` | read |
| `kv/metadata/site/people/*` | list |
| `kv/data/site/revocation-requests/*` | read |
| `kv/metadata/site/revocation-requests/*` | read, list, delete |
| `identity/entity/name/*` | read |
| `kv/data/site/issued/*` | create, read |
| `kv/metadata/site/issued/*` | list |
| `kv/data/site/status-index/*` | create |

- **Site file:** the new optional `credentialIssuers` is a list of distinct Keycloak subjects, the officers named at the key ceremony. It is documented in `deploy/values/site.example.yaml` and is empty by default.
- **What the policy cannot do:** read, update or delete an inbox item; write a revocation request; delete the issued register; read or administer any Transit key.

## The KV records as built (for 47-20, 47-31 and 71-13)

| Record | Path (in the `kv` mount) | Body | Written by |
|---|---|---|---|
| Revocation request | `site/revocation-requests/<entity name>-<reason>` | `{ format: 'sterling-revocation-request/1', entity, keycloakId, reason, seenAt, job }` | 47-20 and 47-31, once (`cas: 0`) |
| Issued register | `site/issued/<subject entity id>/<credential hash>` | `{ format: 'sterling-issued/1', type, issuer, personName, validUntil, revocation: { list, index }, suspension: { list, index } }` | the issuing officer, once |
| Status place claim | `site/status-index/<purpose>-<list name>/<index>` | `{ issuer, claimedAt }` | the issuing officer, once |
| Inbox item | `users/<subject entity id>/credentials-inbox/<credential hash>` | `{ format: 'sterling-inbox-item/1', credential }` | the issuing officer, create only |
| Wallet item | `users/<own entity id>/credentials-wallet/<credential hash>` | `{ format: 'sterling-wallet-item/1', credential }` | the person's own backend |

More on the records:
- **Reasons:** `disabled` and `removed` (47-31) and `guest-ended` (47-20). They are shown as "disabled in sign-in", "removed" and "guest access ended early".
- **Resolving a request:** the request's `entity` is the OpenBao entity *name* (`keycloak-<id>` or `guest-<id>`). The backend resolves it with `identity/entity/name/<name>`.
- **Another format:** a request in any other format is listed as "This request was written by a newer version." and is never removed.
- **No directory entry:** a subject with no people-directory entry is registered under `did-<their DID path, with dashes>`. Only `file` delivery is possible for them.

## The RPC as built (`/services/sterling-issuer`)

`issuableTypes()`, `review(request)`, `issue(request)`, `listIssued()`, `revoke(hash)`, `suspend(hash)`, `clearSuspension(hash)`, `listRevocationRequests()`, `resolveRequest(id)`.

- **The request:** `{ type, subject (did:webvh), personName, claims, until (YYYY-MM-DD, last day), delivery: 'inbox' | 'file' }`.
- **What comes back:** hashes, plain labels, states (`active`, `suspended`, `revoked`, `unknown`) and review sentences. Never a key, a token, an entity id, a status index or a credential body (except the `.near-vc` file the officer asked for).
- **The binding:** the RPC passes `{ presence: 'person', context: 'interactive' }`, because only the card in the person's own browser tab reaches it. Any other caller of the service is refused with "Credentials are issued by a person in their own session…" (D-07).

The steps of `issue`, in order:
1. the form's checks (`validateForm`);
2. `issuerAuthority` on the credential to be signed, which also requires that it does not outlast the role relied on;
3. the issuer step-up login (a stale step-up is refused with "Confirm with your passkey or security key"; a refused login means "not a named officer");
4. a people-directory lookup;
5. the two place claims;
6. `KeyService.sign`;
7. the inbox item or the file;
8. the register entry.

The issuer token is revoked after every call. `revoke` and `suspend` set the bit in the next list version, signed through `transit/sign/status-list-<site>`, then PUT to the hub. A 409 re-reads the list and tries once more. `clearSuspension` refuses a revoked credential and never touches a revocation list.

### For 47-20 (an early end revokes)

`fileRevocationRequest` on `feat/phase-47-wave-8` already writes exactly the format above. Nothing in 47-20 changes. The request stays until every credential issued to that person, by any officer, has its revocation or suspension bit set. Then an officer's `resolveRequest` removes all its versions. No script revokes anything.

## Verification

- **Tests were written alongside the code, not run red first, for tasks 2 and 3:**
  - task 1's six new tests were run on the unchanged `apply.mjs` and failed (6 of 19);
  - the task 2 and 3 test files import modules that did not exist before those tasks, so they could not have passed on the base.
- **Tests added:**
  - `deploy/test/openbao.test.mjs`: 6 (at least 5 asked);
  - `workbench/test/credentials-issuer-service.test.ts`: 13 (at least 10 asked);
  - `src/test/credentialsIssueForm.test.ts`: 6 (at least 6 asked);
  - `workbench/test/credentials-issue-credential-card.test.ts`: 4 (at least 4 asked).
- **One existing test was extended, not loosened:** `deploy/test/openbao.test.mjs`'s "every per-person path is templated". It now names its two exceptions exactly (the inbox and the status-list key path in `credential-issuers.hcl`), each with exactly its one capability, and keeps checking every other path.
- **Tests run (capped, under the heavy-command lock, Node 26.13.1, 2026-11-24):**
  - `deploy/test/openbao.test.mjs` with helm: 19 of 19. `render.test.mjs` and `render-pki.test.mjs`: 14 of 14.
  - The workbench lint (both `tsc` runs) and `npm --prefix workbench test`: 131 of 131. The three new flat files are among them (H-71-01 checked).
  - Root `npm run compile`, then `credentialsIssueForm`, `copyLint` and `architecture`: 54 of 54.
  - `compliance/test/gaps.test.ts`: 20 of 20.
  - The full root suite (`npm test`, TMPDIR=/tmp as CI): 6,474 tests, 6,465 passed, 1 failed, 8 skipped. The failure was `staffReplicaHubMembership` "not-a-roster-writer", where a random join nonce happened to look secret-like to `signPayload`. That code is not touched here. A rerun of the file passed 48 of 48. It is logged in `deferred-items.md`.
- **Acceptance greps:**
  - `sterling-issuer-stepup` in `apply.mjs`: 1;
  - the inbox block with `read`, `update`, `delete` or `list`: 0;
  - `issuerAuthority` in `issuer-service.ts`: at least 1;
  - key, engine or `node:crypto` imports in the widget: 0.

## Deviations from Plan

**1. Flat workbench tests** (H-71-01, option a): `workbench/test/credentials-issuer-service.test.ts` and `credentials-issue-credential-card.test.ts`, not `test/credentials/…`.

**2. The widget is `issue-credential-widget.ts`, a DOM `BaseWidget` like every other workbench page, not `.tsx`.** The extension's `tsconfig` has no JSX setting, and no workbench page uses React. The card's model is a separate Theia-free file (`common/issue-credential-card.ts`), and its test covers that model. The CSS sits at `src/browser/issue-credential.css`, because the extension build copies only `src/browser/*.css`.

**3. Status list places are claimed in KV, not through the hub.** The hub's compare-and-swap orders list versions; it has no allocation. Each place is claimed once at `kv/site/status-index/…` (check-and-set 0), with one retry on a clash, as the behaviour asks. The policy gains `create` there.

**4. The policy gains `list` on `kv/metadata/site/issued/*`** to find the register entries for a person (Rule 3). It gains no `delete` there.

**5. The register keeps `personName`, the name the officer typed.** The request's person is shown "with the person's name", and nothing else on the site holds a readable name (entities are `keycloak-<id>`). The name is never signed.

**6. The form runs in the backend.** The extension's browser code cannot import `src/domain`. So the backend runs `issueForm.ts` through the engine bundle and adds `issuableTypes` and `review` to the RPC, and every credential sentence comes from it. `issue` runs the same form checks before `issuerAuthority`. One test keeps `issuerAuthority`'s own refusal visible: the form passes, but your organization's rules no longer accept the suite.

**7. The issuer signs with the method of their DID whose key is their person key**, found from the DID's state, not a fixed `#key-1`.

**8. The last day is inclusive** (`validUntil` is the next day at 00:00Z). The review shows the year only when it is not the current year, which matches the plan's sentence ("until 31 March.") for this year.

**9. The hosted wallet is a KV folder of the person's own**, plus a one-time notice in the browser (`IdentityServiceRpc.inboxNews`). The extension's `Wallet` is SecretStorage under a host-dependent Theia key, which the backend cannot address reliably, so 71-13 joins the two (G465).

**10. G465 added, G466 added and then closed by D-25, G467 added; the gap count pin is 422.** `road-to-production.md` is regenerated.

## Not done here

- **71-13 is not started.** Its precondition is not met: 33-24 is only on `feat/phase-33-engine-wave-1`, not on `main`.
- **71-14 is not started.** It depends on 71-13 and ends at an owner checkpoint.

## D-25: a person claims their own computer's status list places (owner, 2026-11-25; closes G466)

The owner chose option (a), and it is built on this branch.

- **OpenBao** (`deploy/openbao/policies/sterling-workbench.hcl`, the session policy):
  - create and read on `kv/data/site/device-slots/{{identity.entity.id}}/slot-1` to `slot-5`, five exact paths and no others;
  - create on `kv/data/site/status-index/device-*`;
  - create on `kv/data/site/revocation-requests/{{identity.entity.name}}-computer-lost-*`.

  `credential-issuers` gains read on `kv/data/site/device-slots/*`, and list and delete on its metadata. No path lets a person update, delete or list a slot, claim under another entity, or sign a status list.
- **The cap of 5** is the five slot names. OpenBao has no sixth path, and `deviceSlotAllocator` (`workbench/extension/src/node/credentials/device-slots.ts`) refuses a sixth computer with "You already have 5 computers bound. Report one as lost, …".
- **Index space:** device places come from index 98,304 up (`DEVICE_INDEX_FROM`). Officers' places now come from below it (`issuer-service.ts`).
- **`bindComputer`** (71-10) uses that allocator in the backend module instead of refusing. A slot that already holds the same computer is used again, so a binding that stopped at the step-up never uses up a slot. A slot taken by another session is never overwritten.
- **A lost computer:**
  1. The person runs SovAI: Report a Lost Computer. It files `sterling-revocation-request/1` with reason `computer-lost` and the slot, under `keycloak-<sub>`, or `guest-<sub>` for a guest.
  2. The officer sees that one computer in "Credentials to revoke" and revokes it (`revokeComputer`, after the step-up).
  3. `resolveRequest` then removes the request and the slot, which frees it.

  For `disabled`, `removed` and `guest-ended` requests, all of the person's computers are listed and must be revoked before the request is removed. Their slots are kept as the record.
- **Tests added:**
  - `deploy/test/openbao.test.mjs`, 3:
    - own five slots only, never a sixth, never another entity's, never changed;
    - device places only, no list signature, a lost-computer report only under the person's own name;
    - officers read and free slots.

    The existing exact list of session paths gains the new paths.
  - `workbench/test/credentials-device-slots.test.ts`, 7:
    - the first slot and its device places;
    - the cap;
    - no overwrite;
    - never under another entity;
    - a retry after the step-up reuses the slot;
    - no lists, nothing claimed;
    - a lost computer is reported once, and a guest's report goes under the guest name.
  - `credentials-issuer-service.test.ts`, 2:
    - the lost-computer flow end to end;
    - an ended person's computers, and officers' places below the device quarter.
  - The card test gains the computer row.

## Open conditions

- **G465:** issuance is built but not reachable in a hosted session. It needs 71-13's trust source (your organization's rules in the session, and the hosted wallet joined to the extension's), 33-23's hub session, and Phase 47 to render `STERLING_STATUS_LIST_KEY` and `STERLING_OPENBAO_ISSUER_ROLE` and name `credentialIssuers` at the key ceremony.
- **G467:** a computer binding signed outside the workbench path is not counted or revocable through the slots, and device places are not limited per person in OpenBao (D-25's residual risk).
- **G427** (71-10) stays open. Its third part now needs only the status lists in the session (G465); binding itself is built (D-25).

## Known Stubs

- `IssuerTrustId` is bound to `{ policy: () => undefined, hub: () => undefined }` in `credentials-backend-module.ts`. Until 71-13 and 33-23 rebind it, every issuer call refuses with one plain sentence, and inbox items wait in the inbox. Nothing is half-made (G465).

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: new-endpoint | workbench/extension/src/node/credentials/credentials-backend-module.ts | RPC `/services/sterling-issuer`, as planned (T-71-45 to T-71-50); every signing path still needs the OpenBao-enforced step-up |
| threat_flag: new-policy-path | deploy/openbao/policies/credential-issuers.hcl | `kv/data/site/status-index/*` create and `kv/metadata/site/issued/*` list, beyond the plan's list (deviations 3 and 4); create-only and list-only |

## Self-Check: PASSED

All created files exist. Commits 90feb5db, b937ef60, d2cada4e and 81286bde are on `feat/phase-71-wave-7`.
