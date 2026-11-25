---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 21
subsystem: deploy
status: complete
tags: [guests, keycloak, federation, version-safety, dep-13, d-64, d-69, runbook]
requires: [47-14, 47-17, 47-19, 47-34, 71-11, 71-12]
provides:
  - "users.mjs export --include-guests with --target-site, --sites and --site-exports (the target-site check); import --include-guests with --realm-site, --requested-by, --approved-by, --approver-credential, --trust and --approval-ref"
  - "USERS_FEATURES ['guests@1']; a file naming a guest writes requires ['guests@1']; the optional guest record { guest: { until, requestedBy, approvedBy, approvalRef }, did }"
  - "deploy/keycloak/site-evidence.mjs: the signed site evidence verifier deploy/ carries (a copy of compliance/src/signed.ts verifyEnvelope), parseSitesFile and newestSiteEvidence"
  - "deploy/runbooks/guest-accounts.md and its line in deploy/runbooks/README.md"
affects: [47-20, 47-31, 47-32, 48-11, 32.1-30]
tech-stack:
  added: []
  patterns:
    - "A guest leaves a site only when named at both ends; every refusal before any Keycloak call"
    - "The authoring check reads only facts.sterling.reads of the target's newest verified schema 2 export; anything less counts as not reading (fail closed)"
key-files:
  created:
    - deploy/keycloak/site-evidence.mjs
    - deploy/runbooks/guest-accounts.md
  modified:
    - deploy/keycloak/users.mjs
    - deploy/keycloak/guests.mjs
    - deploy/test/federation.test.mjs
    - deploy/runbooks/README.md
key-decisions:
  - "The target-site check is written against 48-11's planned schema 2 shape (facts.sterling = { release, reads: { <format>: [ids] } }) and 32.1-30's sites file ({ sites: [{ id, name, role, publicKey, fingerprint }] }); neither is on main, so every real target refuses until 48-11 and 47-32 land, which is the side the plan names as safe"
  - "deploy/ cannot import compliance/src/signed.ts in the offline bundle (deploy-tree.tar packs deploy/ only), so site-evidence.mjs carries a copy of verifyEnvelope; a parity test checks both accept and refuse the same envelopes"
  - "A guest's DID at export comes from the site's people directory through the guest's own entity guest-<id> (a guest-operator token); a guest with no DID is refused, because the destination's security contact could not issue their credentials"
  - "Import refuses a guest whose name belongs to a member at the destination, and only adds missing keys to a guest already there; the account's dates are never changed by an import"
requirements-completed: [DEP-13]
duration: ~1h30
completed: 2026-11-25
estimate:
  tokens: 60000
  tasks: 2
actuals:
  tokens: 19500
  tasks: 2
  commits: 2
plan_head_before: 99373e04f4c9a1bf0766218ea4c9da1d922b35d6
plan_head_after: f58e66ccc31da780debd98b72e59c937ecc2e088
---

# Phase 47 Plan 21: Guests between sites and the guest accounts runbook Summary

**A guest now reaches another site only when named at both ends of a signed user export, and only when the target site's own signed evidence shows its import reads guest records; they arrive in /guests with an end no later than the source's, under the destination's lead and security contact. Shown between two Keycloak 26.8.2 realms applied by keycloak-config-cli 6.5.1. The guest life cycle has one runbook.**

## Performance

- Tasks: 2 of 2. Commits: `f2071b8b` (Task 1, tracer), `f58e66cc` (Task 2).
- Base check: `users.mjs` with `USERS_FEATURES` and the `requires` refusal (47-14 as amended by D-69), `federation.test.mjs`, `deploy/runbooks/README.md` (47-17) and `checkGuestRequest` (47-19) are on the base. 48-11's schema 2 deployment collector is not (deviation 1).

## Tracer (Task 1)

Under the heavy lock and the memory cap: two Keycloak `quay.io/keycloak/keycloak@sha256:75b5c435...` (26.8.2, `start-dev`, on 127.0.0.1 only), each with the realm `apply.mjs` prepares for the CI site (checkRealm problems 0) applied by keycloak-config-cli `@sha256:303b5c80...` (6.5.1); a throwaway cosign key pair; site `edge-b`'s evidence exports signed at run time with a test Ed25519 key listed in a test sites file. The containers and network were removed in the same run.

```
A: ivy.industry in ["/guests"], guestUntil 2027-01-24T20:24:28Z, passwordless keys ["aXZ5LWtleS0x","aXZ5LWtleS0y"]
export without --include-guests: refused "ivy.industry is a guest. Guests stay at their site unless you name them with --include-guests (D-64). Nothing was exported."; file written false
export --include-guests, edge-b's export without guests@1 in reads.users: refused "edge-b runs Sterling 0.4.40, whose user import does not read guests@1 (guest records), so a guest would
  arrive there as an ordinary member. Ask its administrator to update the site and send a fresh site evidence export. Nothing was exported."; file written false
export --include-guests, edge-b reads guests@1: written true, signature true; requires ["guests@1"]; ivy's record keys ["username","email","firstName","lastName","enabled",
  "emailVerified","credentials","guest","did"]; guest {"until":"2027-01-24T20:24:28Z","requestedBy":"lead.hq","approvedBy":"sec.hq","approvalRef":"VR-001"}
import at B without --include-guests: ok false, "ivy.industry is a guest. Guests come to this site only when you name them with --include-guests (D-64)"; Keycloak calls 0
import at B with --include-guests: ada.staff created (1 key); ivy.industry created (2 keys), guest {"until":"2027-01-24T20:24:28Z","did":"did:key:z6MkfictionalIvyIndustry"}; writes POST users, POST users
B: ivy.industry enabled true, groups ["/guests"], requiredActions []
B: attributes {"guestApprovedBy":["sec.one"],"guestUntil":["2027-01-24T20:24:28Z"],"guestRequestedBy":["lead.one"],"guestApprovalRef":["VR-002"]}
B: guestUntil 2027-01-24T20:24:28Z <= A's 2027-01-24T20:24:28Z: true; ended attributes absent: true
B: passwordless keys ["aXZ5LWtleS0x","aXZ5LWtleS0y"] (A: ["aXZ5LWtleS0x","aXZ5LWtleS0y"])
B: ada.staff groups []
second import: ada.staff unchanged, ivy.industry unchanged; writes 0
```

Two stand-ins, stated plainly: the guest's DID at A and the approver's DID at B came from fakes of the OpenBao people directory, and the approver's `SecurityContactCredential` check was a stand-in returning "holds". The real verifier tool and people directory are shown end to end in 47-19's tracer; the CLI path with a real OpenBao belongs to the lab run (G423). The guest rules ran with `issuing: true`, the value a release with a reachable credential card (71-12, G465) gives; this release keeps `CREDENTIAL_CARD_REACHABLE` false, so `users.mjs import --include-guests` refuses every guest here, as `guests.mjs create` does (G449).

## Task 1: guest-aware export and import (TDD)

RED: with the new cases written first, `federation.test.mjs` did not load (`Cannot find module deploy/keycloak/site-evidence.mjs`; `exportUsersToFile` missing). GREEN after the change: `federation.test.mjs` and `guests.test.mjs` 58 run, 58 pass.

Cases added to `federation.test.mjs` (13): export refuses an unnamed guest, an ended guest, a guest past their end and a named non-guest, with no file; the guest record's shape and `requires`, and a staff-only file unchanged; the target-site check (missing flags, a site not in the sites file, no export, an export 8 days old, a schema 1 export, an export signed by another site's key, `reads.users` empty or absent, a newer export overriding an older one), each with no file and zero Keycloak calls, and the accepted case; the verifier copy against `compliance/src/signed.ts` on six envelopes; eight import refusals with zero Keycloak calls (not named, guests off, no credential card, no approval reference, an end that has passed, `requires` without `guests@1`, a `serves` field, no DID); and the import round trip (in `/guests`, the end within `maxDays`, the destination's approval, the same credential ids, a second import unchanged, a refused approver and a staff account of the same name stopping before any write).

Two existing cases changed with the plan's behaviour, not weakened: the `USERS_FEATURES` assertion now expects `['guests@1']`, and "a file needing a feature this import does not read" now runs twice, as a 47-14 site (`features: []`) refusing `guests@1` and as this release refusing `marking@1`.

## Task 2: the runbook

`deploy/runbooks/guest-accounts.md` starts with what it is for, who does it and what they need, then nine sections: what a guest account is for (roles, and what a guest can never do), the states table (no state waits forever), turning guests on (including a check that `sterling-guest-expiry` is installed), creating and enrolling in person, extending and ending early (the revocation request), the automatic end, a guest at another site (with `.near-trust-export` imported first through the hub's `--trust-import`), collecting site-issued keys, and removing records. Section 9 states the residual risk of T-47-140 plainly: for the step-up window the officer's token can delete any guest's secrets, never a staff member's, so a hand-made request could remove an active guest's secrets; the workbench refuses that and OpenBao's audit log records every request. The plan's runbook check passes. `deploy/runbooks/README.md` lists it after enrolment.

## Verification

- `federation.test.mjs` and `guests.test.mjs` with the pinned cosign, under the memory cap: 58 run, 58 pass.
- The runbook check of Task 2: passes (every term, every `deploy/...` path, the README line).
- `grep -c "guests@1" deploy/keycloak/users.mjs` is 7; `grep -c -- "--target-site" deploy/keycloak/users.mjs` is 6.
- The full deploy suite (`deploy/test/*.test.mjs`) with the pinned helm and cosign, under the memory cap, once at the end: 281 run, 281 pass (13 of them added by this plan).

## Deviations from Plan

**1. [Base check] 48-11's schema 2 collector is not on main.** The base check names it. The plan also says that until 48-11 and 47-32 land every target counts as not reading guests, the safe side. The check is written against 48-11's planned contract and refuses a schema 1 export, so nothing can pass early. If 48-11 lands with another shape, guest exports keep refusing (fail closed) until this check is aligned.

**2. [Rule 3 - Blocking] A copy of the envelope verifier in `deploy/keycloak/site-evidence.mjs`.** The offline bundle packs `deploy/` only, so `users.mjs` cannot import `compliance/src/signed.ts` at a site. The plan allows this ("copy only what it needs and add a test that checks an envelope both accept"); the parity test covers accept and five refusals.

**3. [Rule 3 - Blocking] `guests.mjs` exports `checkApproval`.** The import admits a guest under the destination's lead and security contact with 47-19's own function; it was module-private. One word; no behaviour change.

**4. [Rule 2 - Correctness] A guest's DID needs an OpenBao token at export.** The record carries the DID (plan behaviour), which lives in the site's people directory, not in Keycloak. `export --include-guests` therefore also takes `--bao` and `--bao-token-file` (guest-operator, which already reads guest entities and the people directory). A guest with no DID is refused.

**5. [Rule 2 - Correctness] A guest's name that belongs to a member at the destination is refused** before any write, so a guest record never changes a staff account.

## Known Stubs

None.

## Threat Flags

None. T-47-73, T-47-74 and T-47-125 are mitigated as planned; T-47-75 is in the runbook.

## Self-Check: PASSED

- Files exist: `deploy/keycloak/site-evidence.mjs`, `deploy/runbooks/guest-accounts.md`.
- Commits `f2071b8b` and `f58e66cc` are ancestors of HEAD.

## Hand-offs

- 48-11: the guest export reads `payload.schema === 2` and `payload.facts.sterling.reads.users` only. Keep that shape, or align `newestSiteEvidence` in the same change.
- 47-32: the site's release record must list `guests@1` under `reads.users` (this release's `USERS_FEATURES`).
- 32.1-30: the sites file here is the shape that plan fixes; `parseSitesFile` should match its `parseSitesFile`.
- 47-20: the runbook names `sterling-guest-expiry` in `sterling-identity` and tells the operator to check it is installed before creating guests; 47-20 is stopped at its checkpoint (keycloak-config-cli 6.5.1 refuses the admin permission), so the CronJob does not exist yet.

## Open conditions

- G449 and G465: guests stay off. `users.mjs import --include-guests` refuses every guest on this release, as `guests.mjs create` does, until the credential card is reachable.
- 48-11 and 47-32 are not on main: until a site's export carries `facts.sterling.reads.users`, `export --include-guests` refuses every target (the safe side).
- 47-20 is not done: the automatic end the runbook's section 6 describes does not exist yet; section 3 tells the operator to check for it before creating any guest.
- G423: the CLI path against a real OpenBao (the guest's and the approver's DID), the hub's `--trust-import` at the destination and the walk-through of the runbook belong to the lab run with guests on (47-18).
