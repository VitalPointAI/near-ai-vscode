---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 19
subsystem: deploy
status: complete
tags: [guests, keycloak, openbao, dep-13, ac-2, ia-8, credentials, revocation-requests, zero-trust]
requires: [47-07, 47-08, 47-13, 47-14, 71-08, 71-10]
provides:
  - "deploy/keycloak/guests.mjs: create, link, extend, end, list, expire (exports checkGuestRequest, guestStatus, endGuest, expireGuests, createGuest, linkGuest, extendGuest, listGuests, fileRevocationRequest, kubectlSessions)"
  - "Realm: group guests (no role) and six admin-only guest life-cycle attributes; checkRealm refuses credential fields, a security-contacts group and attribute or group claims in tokens"
  - "deploy/openbao/enrol.mjs: guest entity guest-<id>, guest rules before any OpenBao write"
  - "OpenBao policies guest-operator, guest-expiry, guest-removal and the jwt role guest-expiry"
affects: [47-20, 47-21, 47-31, 71-12]
tech-stack:
  added: []
  patterns:
    - "Read before write on identity/entity/name: a write to a missing name creates an entity"
    - "Create-only inbox writes tell 'already filed' from 'not allowed' with sys/capabilities-self"
key-files:
  created:
    - deploy/keycloak/guests.mjs
    - deploy/openbao/policies/guest-operator.hcl
    - deploy/openbao/policies/guest-expiry.hcl
    - deploy/openbao/policies/guest-removal.hcl
    - deploy/test/guests.test.mjs
  modified:
    - deploy/keycloak/realm.json
    - deploy/keycloak/apply.mjs
    - deploy/openbao/enrol.mjs
    - deploy/openbao/apply.mjs
    - deploy/values/site.example/sterling-keycloak-realm.yaml
    - deploy/test/realm.test.mjs
    - deploy/test/openbao.test.mjs
    - compliance/gaps.json
    - compliance/test/gaps.test.ts
    - docs-site/content/security/road-to-production.md
key-decisions:
  - "The approver's DID comes from the site's people directory (kv/data/site/people/<entity of keycloak-<approver id>>, written by the person's own backend, 71-10), never from an operator flag, so an operator cannot pair one person's account with another person's credential"
  - "guests.mjs uses its own operator policy guest-operator (read approver entities and the people directory, enable or disable guest entities, create-only revocation requests); enrolment.hcl keeps no kv path, as its test requires"
  - "OpenBao 2.7.3 treats a second create-only KV write as an update (403, not the cas mismatch); fileRevocationRequest reads sys/capabilities-self on 403 and reports 'already filed' only when the token holds create there"
  - "A write to identity/entity/name/<missing> creates the entity (200), so the plan's '403 on creating a new guest-x' cannot hold; the guest-expiry token can make only an empty, disabled entity with no alias, metadata or policy, and enrol.mjs refuses such an entity"
  - "guest-removal leaves out kv/metadata/users/*: the existing invariant that every per-person KV path is entity-templated is kept; the removal of a guest's KV secrets is the owner's decision (G447)"
  - "An early end files a revocation request only when the guest has an entity: without one the guest never had a DID in the people directory, so no credential was issued to them"
  - "A second end keeps the first end's time and reason; extend refuses a guest holding a role, another group or an OpenBao policy, so an account ended fail-closed is never re-enabled as it was"
requirements-completed: [DEP-13]
duration: ~2h
completed: 2026-11-25
estimate:
  tokens: 85044
  tasks: 3
actuals:
  tokens: 30150
  tasks: 3
  commits: 4
plan_head_before: 1791f9212ef7ef2ef261a803807ba31ff19977d6
plan_head_after: 1278258bc6c5916be1bed015fe3c9d3842c44489
---

# Phase 47 Plan 19: Guest accounts Summary

**A guest is created only at a lead's request with a security contact whose SecurityContactCredential passes the product's own checker, enrols with two keys into their own `guest-<id>` OpenBao entity under the staff policies, and is ended by hand with every token cut at once; shown end to end on Keycloak 26.8.2, keycloak-config-cli 6.5.1 and OpenBao 2.7.3 in podman.**

## Performance

- Tasks: 3 of 3. Commits: `2998c629` (Task 1, tracer), `d6425c4c` (Task 2), `1d9e841a` (Task 3), `1278258b` (gap G447).
- Base check: 47-13 and 47-14 are on the base (identity provider `hq` in realm.json, `deploy/keycloak/users.mjs` present, 47-13's kubernetes auth in `deploy/openbao/apply.mjs`), and 71-08's verifier tool is on the base at `deploy/tools/credential-check.mjs` (H-71-02, deviation 1).

## Tracer (Task 1)

Under the heavy lock and the memory cap: Keycloak `quay.io/keycloak/keycloak@sha256:75b5c435...` (26.8.2, `start-dev`, https with a throwaway CA), keycloak-config-cli `@sha256:303b5c80...` (6.5.1) and OpenBao `openbao-ubi@sha256:bb94f6b1...` (2.7.3, dev). The realm is the one `apply.mjs` prepares for the CI site. sec.one's `SecurityContactCredential` was issued with the credential engine's own builders under a test policy (a fictional organization root, test status lists), and their DID was written to the people directory as their backend does. Ids are shown as `<id>`. Containers and the network were removed in the same run.

```
realm prepared for the CI site: checkRealm problems 0
keycloak-config-cli 6.5.1 -> exit 0; ran in 00:04.374
groups: [{"path":"/guests","realmRoles":[],"clientRoles":{},"subGroupCount":0}]
user profile guest attributes: guestUntil, guestRequestedBy, guestApprovedBy, guestApprovalRef, guestEndedAt, guestEndedReason, each {"view":["admin"],"edit":["admin"]}
openbao apply.mjs --jwt-pubkey <tracer RSA key> -> exit 0 (24 written; a second run 24 unchanged)
POST staff lead.one: 201; PUT two synthetic passwordless keys: 204       (sec.one the same)
enrol.mjs enrol --user sec.one -> exit 0  created entity, alias, person-<id>, kek-<id>
guests.mjs create (approver credential revoked in the site list) -> exit 1
    refused: sec.one's SecurityContactCredential does not hold: A cited credential is revoked.  Nothing was changed.
users before 2, after the refused create 2
guests.mjs create --user ada.observer ... --no-link -> exit 0
    created guest ada.observer (Keycloak id <id>) until 2026-12-25T04:00:27Z, requested by lead.one, approved by sec.one (VR-001).
    The account is ready. Send the registration link with guests.mjs link --user ada.observer when the guest is at the enrolment desk.
guest: enabled true, requiredActions ["webauthn-register-passwordless"], attributes guestUntil, guestRequestedBy, guestApprovedBy, guestApprovalRef only
guest groups: ["/guests"]; realm-management roles: none
PUT users/{guest} with two synthetic passwordless credentials: 204; passwordless credentials now 2; attributes unchanged: true
enrol.mjs enrol --user ada.observer -> exit 0  created entity, alias, person-<id>, kek-<id>
entity guest-<id>: metadata {"account":"guest","keycloak_user_id":"<id>"}, policies [], groups [], disabled false
transit/keys/person-<guest entity>: ed25519, exportable false; kek-<guest entity>: aes256-gcm96, exportable false
guest login sterling-workbench: 200; policies ["sterling-workbench"]; entity is guest-<id>: true
guest writes and reads kv/data/users/<guest entity>/mail/work: 200, 200
guest reads staff's kv/data/users/<sec.one entity>/mail/work: 403
guest step-up login: 200; policies ["sterling-workbench","sterling-workbench-sign"]
step-up token signs with person-<guest entity>: 200; with person-<sec.one entity>: 403
guests.mjs end --user ada.observer --no-sessions -> exit 0
    Keycloak account disabled / Keycloak sessions ended / end recorded / OpenBao entity guest-<id> disabled / revocation request filed
after end: Keycloak enabled false; guestEndedAt and guestEndedReason added, the four other attributes unchanged
POST users/{guest}/logout: 204
entity guest-<id> disabled true; metadata kept
revocation request guest-<id>-guest-ended: {"entity":"guest-<id>","format":"sterling-revocation-request/1","job":"guests.mjs end","keycloakId":"<id>","reason":"guest-ended","seenAt":"..."}, version 1
the guest's open token (900 s left): lookup-self 403; reads its own KV path 403; the step-up token signs 403
guests.mjs end again -> exit 0  end already recorded at ...; revocation request already filed; request still version 1, job guests.mjs end
```

The two keys were added to the existing account with `PUT users/{id}` and `credentials` (47-14's probe), so no twin account was needed. Keycloak refuses two credentials of one person with the same `userLabel` and reports it as 409 "User exists with same username or email"; the synthetic keys therefore have distinct labels.

Tracer gate: the tracer was re-run end to end after Tasks 2 and 3, with the same results.

## Task 2: the guest rules (TDD)

RED, before the change (`realm.test.mjs` and `guests.test.mjs`): 4 realm cases failed (the guests group, the attributes and credential fields, security-contacts, the token-claim mappers) and `guests.test.mjs` did not load (`does not provide an export named 'expireGuests'`). The `checkGuestRequest` refusals already passed: Task 1's `create` needed them.

GREEN: `checkRealm` refuses a missing or loaded `guests` group, a guest attribute that anyone but an administrator can view or edit, `serves`, `nationality` or `organization` in the user profile, a `security-contacts` group anywhere, and any attribute, group, aggregated-attribute or script mapper on a client or client scope whose `access.token.claim` is not `false`. `guests.mjs` gained `extend`, `list` and `expire`, `guestStatus` and `expireGuests`.

## Task 3: OpenBao policies and role (TDD)

RED: 3 new cases failed (guest-expiry, guest-removal, the role in the dry run). GREEN after the policies and the role. Then OpenBao 2.7.3 dev with `apply.mjs` (run 1: 24 written; run 2: 24 unchanged):

```
login guest-expiry with a sterling-sessions token: 400 invalid audience (aud) claim
login guest-expiry with audience sterling-guest-expiry but azp sterling-sessions: 400 claim "azp" does not match
login guest-expiry with the client's token: 200; policies ["guest-expiry"]; ttl 300 s; renew-self 403; explicit_max_ttl 300
disabled true on guest-<id>: 204 (entity disabled true)
disabled false on guest-<id>: 403
disabled "true" (string) on guest-<id>: 403          (the JSON boolean true is the form OpenBao 2.7.3 accepts)
a policies field on guest-<id>: 403
disabled true on keycloak-<id>: 403; read keycloak-<id>: 403
write a new guest-x (no such entity): 200 -> exists, disabled true, metadata null, policies [], aliases 0   (deviation 3)
create revocation-requests/guest-<id>-guest-ended (cas 0): 200
overwrite it (cas 0): 403; overwrite it (no cas): 403; read it: 403; delete it: 403; delete its metadata: 403
create a staff request revocation-requests/keycloak-<id>-disabled: 403
read a person's KV path: 403
capabilities-self on the request path: 200 ["create"]; stored request unchanged (version 1)
revoke-self: 204; after it, read guest-<id>: 403
guest-removal DELETE identity/entity/name/guest-<id> with X-Vault-Wrap-TTL: 200, wrap_info present, data null; the entity still exists
guest-removal DELETE transit/keys/person-<entity> with X-Vault-Wrap-TTL: 200, wrap_info present
guest-removal DELETE kv/metadata/users/<entity>/x: 403 (not granted, deviation 4)
```

## Verification

- `node deploy/keycloak/guests.mjs --help` lists create, link, extend, end, list and expire.
- `deploy/test/guests.test.mjs`, `openbao.test.mjs` and `realm.test.mjs` with the pinned helm, under the memory cap: 49 run, 49 pass. Added by this plan: 17 in guests.test.mjs (new), 4 in openbao.test.mjs, 4 in realm.test.mjs.
- `node deploy/keycloak/apply.mjs --site deploy/test/fixtures/site.ci.yaml --dry-run` exits 0; the dry run of `deploy/openbao/apply.mjs` lists `policy guest-expiry`, `policy guest-removal` and `jwt role guest-expiry`.
- `compliance` gap tests (gaps, noStatus, riskAcceptance): 51 run, 51 pass.
- `sterling-workbench.hcl`, `sterling-workbench-sign.hcl` and the two staff roles' bodies are unchanged (no diff).

## Deviations from Plan

**1. [Rule 3 - Blocking] The verifier tool's path (H-71-02).** The plan names `scripts/credential-check.mjs`; 71-08 built it at `deploy/tools/credential-check.mjs`, which the offline bundle packs. The precondition was checked against that path, and `guests.mjs` calls it with `--holder <DID> --type SecurityContactCredential --credential <file> --trust <folder> --at <now> --holder-name <name>`. `create` and `extend` therefore take `--trust <folder>` (the site's trust folder: your organization's signed rules, DID logs, status lists).

**2. [Rule 3 - Blocking] The operator's token.** `create` must read the approver's DID and `end` must write a revocation request, but the enrolment policy holds no kv path, and its test says so. New policy `guest-operator` (read `identity/entity/name/keycloak-*` and `kv/data/site/people/*`, read and `disabled` only on `identity/entity/name/guest-*`, create-only `kv/data/site/revocation-requests/guest-*`, `sys/capabilities-self`). Commit `2998c629`.

**3. [Rule 1 - Plan assumption] A write to a missing entity name creates it.** OpenBao 2.7.3 has no existence check on `identity/entity/name/<name>`, so `guest-expiry` cannot be refused when it writes a new `guest-x`; it makes an empty, disabled entity with no alias, metadata or policy. It grants nothing. `endGuest` and `extend` read before they write, and `enrol.mjs` refuses a `guest-<id>` it did not make (disabled, or without this account's id and `account: guest`); a half-finished earlier enrolment (enabled, matching metadata) is adopted. Also found: `POST identity/entity` with a name that exists updates that entity and returns 204 with no data.

**4. [Rule 4 avoided by narrowing] guest-removal without the KV delete.** The plan's `kv/metadata/users/*` delete breaks the existing invariant "every per-person path is templated on the entity" in `openbao.test.mjs`. The test was not weakened: the path is left out, and the decision is the owner's (G447).

**5. [Rule 2] `sys/capabilities-self` in guest-expiry.** A create-only writer gets 403 for a request that exists (OpenBao counts it as an update). Without this check a misconfigured policy would look like "already filed" and an officer would never see the request.

**6. [Rule 2] Extend refuses a guest holding a role, a group or a policy**, and a second end keeps the first end's time and reason.

**7. Connection flag `--site` left out.** `guests.mjs` needs no site file; the Keycloak and OpenBao addresses are flags, as in `enrol.mjs`.

## Known Stubs

None.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: new-policy | deploy/openbao/policies/guest-operator.hcl | The operator's guest token reads approvers' entities and the people directory (DIDs only), and enables or disables guest entities; not in the plan's register (deviation 2) |

## Self-Check: PASSED

- Files exist: guests.mjs, guest-operator.hcl, guest-expiry.hcl, guest-removal.hcl, guests.test.mjs.
- Commits `2998c629`, `d6425c4c`, `1d9e841a` and `1278258b` are ancestors of HEAD.

## Open conditions

- G447 (owner): how a guest's KV secrets are removed after the retention period.
- Guests are turned on at a site only on a release that includes 71-12 (the revocation card that reads the requests, and the security contact's issuing). 71-12 is not on main.
- The registration link through a real mail server, and a real WebAuthn registration, are not shown here (synthetic keys); they belong to the lab run with guests on (47-18).
- 47-20 builds the in-cluster job on `expireGuests`, `endGuest` and the role `guest-expiry`; 47-31 moves the shared functions into `deploy/keycloak/lib/offboard.mjs`.
