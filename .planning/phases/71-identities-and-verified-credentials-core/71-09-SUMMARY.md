---
phase: 71-identities-and-verified-credentials-core
plan: 09
subsystem: hub-trust
status: partial
tags: [trust-routes, did-webvh-hosting, status-lists, compare-and-swap, evidence-pep, freshness, access-under-review]
requires:
  - "71-04: verifyWebvhLog, parseWebvhDid"
  - "71-05: verifyStatusList, statusAt, newerThan, keepsRevocations"
  - "71-06: credentials@1 (statusLists with their keys), verifyOrganizationLayer"
  - "71-07: checkEvidence(citation, context), checkFreshness(..., siteKind), credentialClock"
provides:
  - "hub/src/store/trustStore.ts: TrustStore (policy, listEntry, getLog, putLog, putWitness, didStates, newestList, listByHash, newest, putStatusList, recordCited, citedOf, underReview, allLogs, newestLists, heldListState), hostPathOf, TRUST_REFUSALS"
  - "hub/src/http/trustRoutes.ts: the /v1/trust routes, staff only"
  - "hub/src/http/body.ts: route errors and body reading shared by both route files"
  - "hub/src/append/evidencePep.ts: checkEntryEvidence, citationOf, carriesEvidence"
  - "hub settings HUB_ORGANIZATION_POLICY and HUB_ORGANIZATION_KEY; schema v4 (trust_logs, trust_lists, trust_cited)"
  - "append refusals stale-evidence, evidence-malformed, evidence-refused (with the checker's reason); session refusal access-under-review"
affects: [71-10, 71-11, 71-12, 71-13, 33.1-24, 47 site values]
tech-stack:
  added: []
  patterns:
    - "The hub verifies with the extension's own pure credential code through @ext imports; the hub-side closure gains HUB_TRUST_SIDE"
    - "A status list version is kept only above the newest (schema trigger); the PUT route also requires exactly one above (compare-and-swap)"
    - "Who is staff comes from the hub's roster at its head (the member role), never from a token claim or group"
key-files:
  created:
    - hub/src/store/trustStore.ts
    - hub/src/http/trustRoutes.ts
    - hub/src/http/body.ts
    - hub/src/append/evidencePep.ts
    - hub/test/trustRoutes.test.ts
    - hub/test/evidencePep.test.ts
    - hub/test/helpers/trustWorld.ts
  modified:
    - hub/src/http/routes.ts
    - hub/src/config.ts
    - hub/src/main.ts
    - hub/src/store/schema.ts
    - hub/src/store/hubStore.ts
    - hub/src/append/checks.ts
    - hub/src/http/session.ts
    - hub/test/config.test.ts
    - hub/test/helpers/closure.ts
    - hub/test/helpers/hubHarness.ts
    - src/test/helpers/credentialWorld.ts
    - compliance/gaps.json
    - docs-site/content/security/road-to-production.md
decisions:
  - "A trust route serves a device whose member holds the member role at the hub's roster head; anyone else, observers and guest accounts included, gets 403 not-staff"
  - "A list's route name is the last part of its id: the policy's list id must be https://<host>/v1/trust/status/<name>"
  - "The member's DID for an evidence check is the issuer of the cited DeviceBindingCredential that binds the writing device's key"
  - "Cited credentials reach the hub as blobs the append names for that entry (blobRefs), opened with the entry's cell key"
  - "The hub's own list copy counts as fetched now (the hub is the source), so the time to live never refuses at the hub; superseded does"
  - "The first copy of a list on a hub may be any version (gap G426)"
metrics:
  completed: 2026-11-24
estimate:
  tokens: 115060
  tasks: 3
actuals:
  tokens: 31200
  tasks: 2
  commits: 4
plan_head_before: 7600a8b9
plan_head_after: f7770400
---

# Phase 71 Plan 09: The sync hub as trust host and enforcement point Summary

Tasks 1 and 2 are done. Task 3 (the rekey card for the lead) is blocked: its precondition, 33-26's `src/domain/staff/staffRoomLive.ts` on `main`, is not met on any branch.

- **Trust host:** the hub hosts people's did:webvh logs and your organization's signed status lists, for staff members of the site only. A log is stored only when the whole log verifies and grows the one held. A list is stored only when signed by the key your organization's rules name for it, newer, keeping every revocation, and exactly one version above the held one.
- **Enforcement point:** every entry the hub can open that cites evidence is checked with the fold's own checker and then for freshness against the hub's newest lists.
- **A later revocation:** once the hub's newest list sets a bit of a credential a member's entries cited, that member's sessions and event streams are refused until a newer list lifts a suspension. A revocation never clears.

## Routes as built

| Route | Answer |
|---|---|
| `GET /v1/trust/did/<path>/did.jsonl` | 200 the log byte for byte (`text/jsonl`), 404 when none |
| `POST /v1/trust/did/<path>/did.jsonl` (body: the whole log, at most 1 MiB) | 201 stored, 200 `{ stored: false }` for the same log, 422 refused |
| `GET /v1/trust/did/<path>/did-witness.json` | 200 or 404 |
| `PUT /v1/trust/did/<path>/did-witness.json` (at most 256 KiB) | 201 or 200; 422 when the held log does not verify with it |
| `GET /v1/trust/status/<name>` | 200 the newest signed list, 404 when none or not in the rules |
| `PUT /v1/trust/status/<name>` (at most 128 KiB) | 201, 200 same list, 409 `version-conflict`, 422 refused |

- `<path>` is the DID's own path (`people/<id>`; `.well-known` for none), at most 16 parts.
- Every route needs a hub session (401 otherwise). Then the member check: 403 `not-staff`, with a body that names no DID and no key. Then your organization's rules: 503 `no-policy`. A body over its limit is refused 413 before it is read. DELETE answers 405; nothing is ever deleted.

### Refusal ids

- **Trust routes (`TRUST_REFUSALS`):** no-policy, wrong-path, wrong-scid, not-an-extension, not-in-policy, not-newer, revocation-cleared, version-conflict; plus the log's own `WEBVH_FAILURES` reason (bad-entry-hash, pre-rotation, ...) and the list's `STATUS_LIST_FAILURES` reason (status-list-signer, ...).
- **Append (`APPEND_REFUSALS`, per entry):**
  - `stale-evidence`: a cited list is older than the hub's newest by more than the grace;
  - `evidence-malformed`: `evidence` or `status` not in the PLAN-IDS shape;
  - `evidence-refused` with `evidence: <EVIDENCE_REFUSALS id>` (credential-missing, member-key, revoked, ...).
- **Session (`SESSION_REFUSALS`, `AUTH_REFUSALS`):** `access-under-review`, 403.

### Settings

`HUB_ORGANIZATION_POLICY` (absolute path of your organization's signed rules) and `HUB_ORGANIZATION_KEY` (43 base64url characters). Without both, or with rules that do not verify or hold no credentials section, the trust routes answer 503, the hub judges no evidence, and the projects keep syncing. The rules are verified again at most once a minute, so an expired layer stops the routes.

## Verification

- **Failing first:** the new test files did not compile before `trustStore.ts`, `trustRoutes.ts` and `evidencePep.ts` existed.
- **Tests added:** `trustRoutes` 14 (at least 10 asked), `evidencePep` 10 (at least 8 asked), and 1 in `config` for the two settings.
- **Tests run (capped, under the heavy-command lock, Node 26.13.1, 2026-11-24):**
  - hub lint (`tsc`) clean;
  - `trustRoutes`, `evidencePep`, `config`, `workspace`, `api`, `noOutbound`, `append`, `session`, `maliciousHub` and `hubStore`: 188 tests, 185 passed and 3 failed in the first run; 3 were skipped (the older-Node cases, which need `NEAR_AI_HUB_OLD_NODE`);
  - the 3 failures were in the new `evidencePep` file: a refused entry's place was not used again by the test's next entry (seq-gap). The test helper was fixed, not the hub;
  - the second run (`evidencePep`, `trustTransfer`, `trustRoutes`, `startup` and `workspace`): 61 tests, 58 passed, 0 failed, 3 skipped (the same older-Node cases).
- **Acceptance greps:**
  - `wc -l < hub/src/http/routes.ts`: 643 (under 800);
  - `grep -c checkFreshness hub/src/append/checks.ts`: 1 (the call itself is in `evidencePep.ts`, deviation 2);
  - `road-to-production.mjs --check` passes with G426.

## Deviations from Plan

**1. Cited status entries are kept in the hub's store (`trust_cited`), not in memory in `rosterCache.ts`.** The plan says "in rosterCache.ts, keep citedStatusByMember". A memory map is lost at a restart, after which a revoked member would be let in again. The table is append-only; `TrustStore.citedOf` and `underReview` read it, and `session.ts` asks through an `underReview` option. `rosterCache.ts` is unchanged.

**2. The evidence check lives in `hub/src/append/evidencePep.ts`; `checks.ts` calls it.** That keeps `checks.ts` to the wiring; its header names the order (checkEvidence, then checkFreshness).

**3. `routes.ts` shrank from 709 to about 640 lines.** The route errors and body reading moved, unchanged, to `hub/src/http/body.ts`, which both route files use; `routes.ts` re-exports `ROUTE_ERRORS`.

**4. Schema v4 instead of files.** The trust data is three STRICT tables in `hub.db` (the store's one database), so it is in the same backup. The rules are in the schema: a log may only grow, a list version only rises, nothing is deleted. The PUT's exact compare-and-swap is in code, so an edge's import (71-11) may skip versions.

**5. The list's version rule is checked in code and by the schema.** Two concurrent version-2 puts: the second sees version 2 held and answers 409; the schema's unique version would refuse it too.

**6. `src/test/helpers/credentialWorld.ts`:** `Person` gains its `log`, so a host test can serve the people's logs. No existing test changes.

**7. The hub's open event streams of a member now under review are ended when a list is stored,** as the plan's threat T-71-34 asks; their next call is refused by the session check.

**8. [Rule 3 - Blocking] The hub image's allow-list, found by the full hub suite (fix eafc17c8).** `.dockerignore` lets in only the hub-side closure, and `dockerContext.test.ts` forbade any `src/domain/gate/` file in it. The credential checker reads your organization's signed rules through the gate's pure readers. So the `!src/` lines were regenerated from `hubSideClosure`, and the rule now holds for the replica side's own closure, which still reaches no gate file.

**9. [Rule 1 - Bug] The compliance count pin.** `compliance/test/gaps.test.ts` pins the number of gaps. The G426 commit did not raise it; the full compliance run found it, and it now says 412 (G426 and G427).

## Not done: Task 3

The hub does not send `credential-revoked` and no rekey card exists. The task's precondition, 33-26's `src/domain/staff/staffRoomLive.ts` on `main`, is not met on `main` or any branch. So the lead is not told of a revocation, though the hub still refuses the revoked member. This is plan work, not a gap: Task 3 runs when 33-26 lands.

## Open conditions

- **G426:** first copies on trust (log addresses, a list on an empty hub) and evidence checked only where the hub can read.

## Known Stubs

None.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: new-endpoint | hub/src/http/trustRoutes.ts | The /v1/trust routes, staff-only, as planned (T-71-31, T-71-32, T-71-36) |
| threat_flag: first-come | hub/src/store/trustStore.ts | Log addresses and a first list copy are taken on trust (G426) |

## Self-Check: PASSED

All created files exist. Commits eee02137, b6f74d9f and f7770400 are on the branch.
