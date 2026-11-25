---
phase: 71-identities-and-verified-credentials-core
plan: 13
subsystem: credential-enforcement
status: complete
tags: [session, key-release, freshness, token-facts, hub-trust-source, wallet, d-11, d-18, d-19]
requires:
  - "71-07: checkEvidence, mayRelease, checkFreshness"
  - "71-08: Wallet, TrustSource, cacheState"
  - "71-09: the hub's trust routes"
  - "71-12: the issuer service, the inbox pickup and IssuerTrustId"
  - "33-24: the staff live engine and LiveReplicator (on main as 99373e04)"
  - "46-02, 46-07: SessionIdentity, KeyService, the person's OpenBao KV"
provides:
  - "src/gate/hubTrustSource.ts: HubTrustSource (refresh, mode, sentence), HubTrustFetch, HUB_TRUST_TEXT, listNameOf"
  - "src/gate/wallet.ts: Wallet.keepFresh, Wallet.wantedDids, RefreshingTrustSource, WalletView.lists"
  - "src/staff/replica/hubTransport.ts: trustText, putTrustList, trustSession; LiveReplicator.trust()"
  - "src/staff/replica/keyRelease.ts: KeyReleaseCheck, keyReleaseFor, ReleaseDecision, KEY_RELEASE_TEXT, UNREADABLE_LABEL, ReleaseMemory"
  - "DeviceKeyRing.load(..., check?), recheck(), withheldCells(); ReplicaProjectDeps.keyRelease"
  - "workbench credentials/credential-cache.ts: createCredentialCache, CredentialCacheId, identityStatusWith; credentials/token-facts.ts: tokenFactsOf, tokenClaimsOf"
  - "StaffLiveEngine: keyRelease option, trustSession(), recheckKeys(); StaffStatusRow.access"
  - "IdentityStatus.credentials (the session's credential state); the status bar entry and SovAI: Check My Access Again"
affects: [71-14, 33-28, 47 site values, 47-19]
tech-stack:
  added: []
  patterns:
    - "One wallet, one checker: the hosted session runs the extension's own Wallet and HubTrustSource from the staff engine bundle, beside the key ring, so the facts the wallet makes are the ones mayRelease accepts"
    - "The key ring asks at every release, not once: settle, each read and the reading path, so a view that turns stale or a session that ends stops the next release"
key-files:
  created:
    - src/gate/hubTrustSource.ts
    - src/staff/replica/keyRelease.ts
    - src/test/gateHubTrustSource.test.ts
    - src/test/staffKeyRelease.test.ts
    - workbench/extension/src/node/credentials/credential-cache.ts
    - workbench/extension/src/node/credentials/token-facts.ts
    - workbench/test/credentials-credential-cache.test.ts
    - workbench/test/credentials-token-claims.test.ts
  modified:
    - src/gate/wallet.ts
    - src/staff/replica/hubTransport.ts
    - src/staff/replica/liveReplicator.ts
    - src/staff/replica/keyring.ts
    - src/staff/replica/replicaProject.ts
    - workbench/extension/src/node/staff/staff-live-engine.ts
    - workbench/extension/src/node/staff/staff-engine.ts
    - workbench/extension/src/node/staff-backend-module.ts
    - workbench/extension/src/common/staff-live.ts
    - workbench/extension/src/common/identity.ts
    - workbench/extension/src/node/credentials/credentials-backend-module.ts
    - workbench/extension/src/node/credentials/device-slots.ts
    - workbench/extension/src/node/credentials/identity-service.ts
    - workbench/extension/src/node/credentials/issuer-service.ts
    - workbench/extension/src/browser/credentials/credentials-frontend-module.ts
    - workbench/tools/staff-engine-entry.ts
    - workbench/test/staff/staff-live-engine.test.ts
    - compliance/gaps.json
    - compliance/test/gaps.test.ts
    - docs-site/content/security/road-to-production.md
    - .planning/phases/71-identities-and-verified-credentials-core/71-HANDOFFS.md
    - .planning/phases/71-identities-and-verified-credentials-core/71-VALIDATION.md
decisions:
  - "Lowest-level parts with no compartment and no releasability, and unmarked parts, are released without credentials (O11, T-71-53); everything else needs a fresh view, checkFreshness and mayRelease"
  - "An ended session, or a wallet read OpenBao refuses (403: entity disabled or token revoked), releases nothing, the unmarked base part included"
  - "At an edge a stale view still counts within the level's maximum offline age (O6); in a connected session only a fresh view counts"
  - "Your organization's rules reach the session as a mounted signed file (STERLING_ORGANIZATION_POLICY) checked against STERLING_ORGANIZATION_POLICY_KEY, as the hub reads its own; no new hub route"
  - "The officer's role credentials travel beside each issued credential in the inbox and wallet items, so a holder can cite them as evidence"
metrics:
  completed: 2026-11-25
estimate:
  tokens: 105055
  tasks: 3
actuals:
  tokens: 50200
  tasks: 3
  commits: 3
plan_head_before: 99373e04
plan_head_after: cd466d0a
---

# Phase 71 Plan 13: Freshness at the session and at key release Summary

All three tasks are done. In a hosted session, an epoch key now reaches the staff engine only after the cell's own label allows it for the person's verified credentials, checked fresh at that moment. The session always says whether its check is fresh. Credential code reads nothing from a sign-in token but who signed in and how recently.

- **The session's state:** the hosted session checks the person's wallet folder in OpenBao with the extension's own `Wallet`, and keeps the logs and lists fresh from your organization's hub (`HubTrustSource`). It says fresh, stale or unavailable, through the identity status RPC and a status bar entry with Retry.
- **Key release:** every project's key ring asks `keyReleaseFor` at settle, at every read and on the reading path. A refused key is dropped from memory, and the project's row names the part held back.
- **Tokens:** `TokenFacts { sub, acr, authTime, exp }` is the only thing credential code takes from a token. A token full of groups and attributes gives the same decisions, and a static test refuses any other claim under `credentials/`.
- **The wallet's trust source:** `HubTrustSource` fetches over the replica's one pinned hub connection (`HubTransport.trustSession`, no second HTTP client). `Wallet.keepFresh` refreshes it in the background, so a decision never waits on the network. The hosted session runs both. The VS Code extension has the same code but does not build its wallet yet (G468).

## The states and sentences as built

The session's credential state (`IdentityStatus.credentials`; the sentences are 71-08's `CACHE_STATE_TEXT`):

| State | When | Sentence | Action |
|---|---|---|---|
| fresh | every list used was fetched within the status time to live | Your credentials are checked and up to date. | none |
| stale | the time to live has passed since the oldest list used was fetched | Your credentials have not been checked recently, so protected actions wait until they are. Try again to check them now. | Retry |
| unavailable | nothing checked yet, a needed list or log is not held, the wallet folder cannot be read, or OpenBao refused the person's token | Your credentials cannot be checked here right now, so protected actions are refused. Connect to your organization's server and try again. | Retry (after connecting) |

The status bar shows "Your access needs a fresh check" (stale) or "Your access cannot be checked" (unavailable), with the sentence as its tooltip. Choosing it runs **SovAI: Check My Access Again**. Nothing shows while the state is fresh or when your organization has no credential rules.

The key release check (`KEY_RELEASE_TEXT` and the reasons of `ReleaseDecision`):

| Reason | When | Sentence on the part | Action |
|---|---|---|---|
| (released) | no credentials@1; an unmarked part (the base part is one); the lowest level of a scale with no compartment and no releasability | none | none |
| stale | connected session, view past the time to live | the stale sentence above | retry |
| unavailable | nothing checked, or a needed list missing | the unavailable sentence above | connect |
| freshness | `checkFreshness` refuses (a superseded list, or at an edge past the level's maximum offline age) | its own sentence (71-07 `FRESHNESS_REFUSALS`) | retry or connect |
| not-cleared | `mayRelease` refuses | You are not cleared for this work. Ask your organization's security officer if you need access. | none |
| label-unreadable | a label is sealed and none opens under the key, or it does not read | This work's marking cannot be read here, so it stays closed. Ask the project lead to check it. | none |
| session-ended | the session is not active, the cache was stopped, or OpenBao refused the person's own token (an entity disabled) | Your session has ended, so this work is closed. Sign in again to open it. | none |

## As built, for later plans

- **For 33-28 (the browser's sync status part):** `StaffStatusRow.access = { sentence, action? }` is set while a part of the project is held back. The slot `status-part.ts` is still empty (G469).
- **For Phase 47 (site values):**
  - `STERLING_ORGANIZATION_POLICY`: the absolute path of your organization's signed rules file, mounted read-only.
  - `STERLING_ORGANIZATION_POLICY_KEY`: its issuer key, 43 base64url characters, the same values the hub reads as `HUB_ORGANIZATION_POLICY` and `HUB_ORGANIZATION_KEY`.
  - Without both, the session has no credential state and nothing changes (D-08) (G465).
- **Inbox and wallet items:** `{ format, credential, roles }`. `roles` holds the officer's current role credentials for that type, at most 8. The wallet cites them as the issuer's evidence.
- **For the extension (G468):** build `Wallet` from SecretStorage with `HubTrustSource` over `LiveReplicator.trust()` and imported trust files, pass it to `GateHost`, and run `keepFresh`.
- **G427, two of its three parts now in service:**
  - The person's log is posted through their own hub session once a shared project is live (`publishToHub` over `HubTransport.trustSession().postLog`, D-24).
  - Binding a computer gets its lists from the session's rules.
  - Left: the site's `STERLING_DID_DOMAIN`.

## Verification

**Tests added: 26.** Each file meets or passes its plan minimum:
- `src/test/staffKeyRelease.test.ts`: 8 (at least 6);
- `src/test/gateHubTrustSource.test.ts`: 7 (at least 5). One of them covers the trust calls over a scripted hub's pinned connection;
- `workbench/test/credentials-credential-cache.test.ts`: 7 (at least 6);
- `workbench/test/credentials-token-claims.test.ts`: 3 (at least 2);
- `workbench/test/staff/staff-live-engine.test.ts`: 1 (the wiring).

**Tests changed:** none weakened. `compliance/test/gaps.test.ts` pins the gap count, which rises from 453 to 455 (G468 and G469).

**Focused runs** (capped, under the heavy-command lock, 2026-11-25):
- **Task 3:** `gateHubTrustSource`, `gateWallet`, `gateOffline` and `gateCredentialClearance`: 27 of 27.
- **Task 2:** `staffKeyRelease`, `staffReplicaKeyring`, `replicaCellLeak`, `staffReplicaProject`, `gateHubTrustSource`, `staffHubTransport`, `staffLiveReplicator` and `architecture`: 130 of 131. The one failure, `hubTransport.ts` at 1,205 lines, was fixed to 1,200 before the commit. `architecture` passed in the full run.
- **Task 1:**
  - the workbench lint (both `tsc` runs) passed;
  - `npm --prefix workbench test`: 257 passed, 0 failed, 3 skipped. Two of the skips need a real hub binary, and they run in the full suite. The third needs the built browser bundle.
- `compliance/test/gaps.test.ts`: 21 of 21. `build-road-to-production.mjs --check` passed.

**Acceptance greps:**
- `realm_access` or `.groups` in credential code, outside comments: 0;
- `KeyReleaseCheck` in `keyring.ts`: 4;
- `node:https` or `node:http` imports in `hubTrustSource.ts`: 0.

**The full suites** ran once in 71-14 (see `71-VERIFICATION.md`):
- root: 6,974 of 6,994 passed;
- hub: 487 of 491;
- workbench: 259 of 260, with the real-hub tests run;
- compliance: 614 of 614.

Every failure there came from 71-14 or the environment, none from this plan's code. `architecture` passed in the full root run.

## Deviations from Plan

**1. Task order: 3, then 2, then 1.** The session's cache (Task 1) runs Task 3's trust source, and Task 2's check reads the wallet view Task 3 extends. Each task still has its own commit.

**2. Flat workbench test files (H-71-01, option a):** `workbench/test/credentials-credential-cache.test.ts` and `credentials-token-claims.test.ts`. `71-VALIDATION.md` and H-71-01 are updated.

**3. The sentences are 71-08's.** The plan quotes "Your access needs a fresh check." and "Connect to your organization's server, then Retry." The code already owns `CACHE_STATE_TEXT` (tested since 71-08), and its stale and unavailable sentences say the same with Retry. Those sentences are kept. "Your access needs a fresh check" is the status bar's short label.

**4. Where your organization's rules come from in a session.** Nothing gave the session your organization's signed rules. They now come the way the hub reads its own: a mounted file named by `STERLING_ORGANIZATION_POLICY`, verified against `STERLING_ORGANIZATION_POLICY_KEY` at most once a minute. There is no new hub route. Phase 47 renders both (G465).

**5. [Rule 2 - Missing critical] Role credentials travel with each credential.**
- **The problem:** every verifier needs the issuing officer's role credential as cited evidence (71-07), but 71-12's inbox item carried the credential alone. No hosted wallet could ever have verified anything.
- **The fix:** `issue` now writes `roles` (the officer's current role credentials for that type) into the inbox item, and the pickup copies them into the wallet item.
- **Tests:** the existing issuer and identity tests pass unchanged; the cache test reads them.

**6. [Rule 3 - Blocking] The hub session for the cache and the issuer.** The plan's trust source needs the person's hub connection.
- **Before:** `HubTransport` had no trust calls.
- **Now:** it gains `trustText`, `putTrustList`, `postTrustLog` and `trustSession`, over its one pinned connection and session. `LiveReplicator.trust()` and `StaffLiveEngine.trustSession()` expose it.
- **The issuer service:** `IssuerTrustId` now gives it the rules and this session. Its 71-12 stub is gone.

**7. [Rule 3] `publishToHub` is now called** once a hub session is live, with the inbox pickup that waited for it (G427 narrowed).

**8. The check takes the opened label.** `KeyReleaseCheck` is `(cell, label)`, where the ring has already opened the label in memory. A sealed label that does not open is passed as `UNREADABLE_LABEL`. `keyReleaseFor` takes the rules as a function, so a policy that changes is read at each release.

**9. Memory bookkeeping lives in `keyRelease.ts` (`ReleaseMemory`, `forgetInMemory`).** `staffReplicaKeyring.test.ts` checks that `keyring.ts` holds exactly one `.delete(`, the join secret's SecretStorage delete. That test is unchanged.

**10. `replicaProject.ts` stays at its frozen 1,200 lines** (architecture D-45):
- the new deps field imports its type inline;
- two `cellKeys` import lines are merged;
- one doubled blank line is removed.

**11. Beyond the plan's files, for people to see the state (no silent wait):**
- the status bar entry and **SovAI: Check My Access Again** in `credentials-frontend-module.ts`;
- `StaffStatusRow.access` on the project's row. Its browser part is 33-28's (G469).

**12. `subjectOf` (71-12) now reads through `token-facts.ts`** (`tokenClaimsOf`), so one file decodes tokens. Its existing test is unchanged.

**13. `HubTrustSource` passes the DID it asks for to `verifyWebvhLog`,** so a log served at a path is taken only when one of its versions names that DID.

**14. Tests were written with the code, not run red on the base.** Every new test file imports a module that did not exist before this plan, so none could compile on the base.

**15. [Rule 1 - Bug, found by the wiring test] A cached key deadlocked the first fold under a check.**
- **What happened:** with a check, a key read from the SecretStorage cache is withheld until settle opens its label. But `holds()` still said the ring held it, so the host offered no reading key for the base part. The roster could not be read, so settle never saw a cell, and nothing was ever released.
- **The test that found it:** staff-live-engine's key release wiring test (asked was empty while the ring held 2 cached keys).
- **The fix:** with a check, `holds()` and the reading path count a key only once it is released. Until then the host reads the roster with reading keys, which are themselves checked, exactly as a device without a cache does.
- **Regression test:** `staffKeyRelease.test.ts`, "a key from the cache is handed out only after settle opens its label".

**16. The wiring test folds once itself.** The replicator is faked and never folds, so the test calls `state()` once, as an exchange does, then reports a status.

## Open conditions

- **G465 (narrowed):** the session now reads your organization's rules, the hub session and the hosted wallet. Left: Phase 47 renders `STERLING_ORGANIZATION_POLICY`, `STERLING_ORGANIZATION_POLICY_KEY`, `STERLING_STATUS_LIST_KEY` and `STERLING_OPENBAO_ISSUER_ROLE`, names `credentialIssuers` at the key ceremony, and an end-to-end test runs against a real OpenBao and hub.
- **G468 (new):** the VS Code extension does not build its wallet yet, so under credential rules its gate gives no clearance (it fails closed).
- **G469 (new):** the browser's sync status part (33-28) does not show `StaffStatusRow.access` yet. The status bar does show the session's stale and unavailable states.
- **G427 (narrowed):** a hosted session makes no identity until the site sets `STERLING_DID_DOMAIN`.
- **G467:** unchanged.

## Not done here

- **DCAC-04 stays partial (plan work, no gap):** the hub's revocation event and the lead's rekey card are 71-09 Task 3, which waits for 33-26. The wrap preparer's check belongs to Phase 33.2.

## Known Stubs

None. The 71-12 stub (`IssuerTrustId` bound to `undefined`) is replaced. With no organization rules set, the session has no credential state by design (D-08).

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: new-setting | workbench/extension/src/node/credentials/credentials-backend-module.ts | Reads the file `STERLING_ORGANIZATION_POLICY` names (absolute path only), verified against `STERLING_ORGANIZATION_POLICY_KEY` before any use. Same trust as the hub's own setting. |
| threat_flag: new-client-call | src/staff/replica/hubTransport.ts | GET, PUT and POST on `/v1/trust/*` over the existing pinned connection and session. Targets are checked against the trust routes' shape. |

T-71-51 to T-71-54 are mitigated as planned:
- T-71-51: `TokenFacts`, the equality test and the static test.
- T-71-52: the check at every release, with the key dropped on refusal.
- T-71-53: the stale and unavailable states with Retry; lowest-level parts are unaffected.
- T-71-54: the pinned connection, and every object verified.

T-71-55 is accepted and stated in SECURITY.md (71-14).

## Self-Check: PASSED

- **Files:** every created file exists.
- **Commits:** bb2525c0 (Task 3), fe0680d7 (Task 2) and cd466d0a (Task 1) are on `feat/phase-71-13-14`.
