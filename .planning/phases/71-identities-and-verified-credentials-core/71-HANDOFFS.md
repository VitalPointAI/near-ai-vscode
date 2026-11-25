# Phase 71: hand-off notes for later executors

**Written:** 2026-11-24, after wave 1 (71-01, 71-02). These are items later 71 plans must handle that their PLAN files do not say.

## H-71-01: workbench tests in subfolders are compiled but never run

- **Found by:** the 74.3 planner. Confirmed on `main` at 48313baa.
- **What happens today:** `workbench/scripts/build.mjs` compiles `test/**/*.test.ts` into `dist/test/...`. But `npm --prefix workbench test` runs only `dist/test/*.test.js`, the flat top level (only `dist/test/container/` has its own `test:container` script). A test at `workbench/test/credentials/x.test.ts` builds and then silently never runs.
- **Affected plans and files:**
  - 71-10: `workbench/test/credentials/identity-service.test.ts`
  - 71-12: `workbench/test/credentials/issuer-service.test.ts` and `issue-credential-widget.test.ts`
  - 71-13: `workbench/test/credentials/credential-cache.test.ts` and `token-claims.test.ts`
  - `71-VALIDATION.md` lists the same paths.
- **What the executor of 71-10, 71-12 or 71-13 does:** pick one fix and record it as a deviation.
  - (a) Put the tests at the flat level with a `credentials-` prefix, for example `workbench/test/credentials-identity-service.test.ts`, and update the plan's verify command and `71-VALIDATION.md`.
  - (b) Widen the runner to `dist/test/**/*.test.js` while keeping `dist/test/container/` out. This changes the workbench `test` script for every phase, so coordinate it first.
- **Check after either fix:** the run's `ℹ tests` count includes the new file's tests. A test file that compiles but never runs would let a plan's verify step pass with nothing checked.
- **Status:** closed. 71-10, 71-12 and 71-13 took option (a): `workbench/test/credentials-identity-service.test.ts`, `credentials-issuer-service.test.ts`, `credentials-issue-credential-card.test.ts`, `credentials-credential-cache.test.ts` and `credentials-token-claims.test.ts`; `71-VALIDATION.md` names the flat paths.

## H-71-02: the command-line credential check lives at `deploy/tools/credential-check.mjs`, not `scripts/`

- **Found by:** the 71-09 executor, from the 71-08 summary, 2026-11-24.
- **What is true:** 71-08 built the tool at `deploy/tools/credential-check.mjs`, with its generated engine `deploy/tools/credential-checker.engine.mjs` packed by `deploy/bundle/build.mjs` into the signed offline bundle (PLAN-IDS.md names the same path). Operators run it from the bundle; it needs no checkout and no compile.
- **Who is affected:** 47-19 (`guests.mjs create --approved-by`) expects `scripts/credential-check.mjs`.
- **What 47-19's executor does:** call `node deploy/tools/credential-check.mjs --holder <did> --type <Type> --credential <file> --trust <dir> [--scope <s>] [--at <time>] [--holder-name <name>]` (exit 0 holds, 1 refused with one sentence on stderr, 2 usage; the trust folder layout is in the 71-08 summary). Do not move the file: the bundle build and its test pin this path.
- **Status:** open, for 47-19.

## H-71-03: the sync hub's trust routes and settings, as built by 71-09

- **For:** 71-10 (posting a person's log), 71-11 (export and import), 71-12 (publishing lists), 71-13 (the session), and Phase 47's site values.
- **Routes:** `GET|POST /v1/trust/did/<path>/did.jsonl`, `GET|PUT /v1/trust/did/<path>/did-witness.json`, `GET|PUT /v1/trust/status/<name>`, where a list's id in `credentials@1.statusLists` is `https://<host>/v1/trust/status/<name>`. Every route needs a hub session of a device whose member holds the `member` role at the hub's roster head; observers and guests get 403 `not-staff`.
- **Settings:** `HUB_ORGANIZATION_POLICY` (absolute path of your organization's signed rules) and `HUB_ORGANIZATION_KEY` (its issuer key, 43 base64url characters). Without both, or when the rules do not verify or hold no `credentials` section, the trust routes answer 503 `no-policy` and the hub judges no evidence.
- **For 33-23:** a person's backend has no hub session of its own; decision D-24 posts the person's first log through their first hub session. 33-23's hosted hub session calls `IdentityService.publishToHub` (`workbench/extension/src/node/credentials/identity-service.ts`) once it is open (G427).

## H-71-04: what 71-13 plugs into the issuer service and the inbox pickup (71-12)

- **Written by:** the 71-12 executor, 2026-11-24.
- **The ports:** `createIssuerService` and `inboxVerifier` (`workbench/extension/src/node/credentials/issuer-service.ts`) take `policy()` (your organization's credentials@1 section and scales, verified) and `hub()` (the person's hub session: `getLog(path)`, `getList(name)`, `putList(name, text)`). The backend module binds both to `undefined` under the symbol `IssuerTrustId` (`credentials-backend-module.ts`). 71-13's hosted trust source rebinds `IssuerTrustId`; 33-23's hub session provides `hub()`. Nothing else changes.
- **The hosted wallet folder:** the inbox pickup moves each checked credential to `kv/users/<entity>/credentials-wallet/<credential hash>` = `{ format: 'sterling-wallet-item/1', credential }`, written with the person's own session token. The issuer service reads an officer's role credentials from the same folder. The extension's `Wallet` (`src/gate/wallet.ts`) reads SecretStorage `near-ai.credentials` and does not read this folder yet: 71-13's hosted `TrustSource` and wallet must join the two (G465).
- **Settings the site must render (Phase 47):** `STERLING_STATUS_LIST_KEY` (`status-list-<siteName>`, made by `deploy/openbao/apply.mjs`) and optionally `STERLING_OPENBAO_ISSUER_ROLE` (default `sterling-issuer-stepup`); the site file's `credentialIssuers` names the officers' Keycloak subjects (G465).
- **Device bindings (D-25, owner 2026-11-25):** `bindComputer` takes its places from the person's own computer slots (`device-slots.ts`, at most 5) once `policy()` gives the status lists; officers' places stay below index 98,304. Residual risk G467.
- **Status:** 71-13 done (2026-11-25): `IssuerTrustId` is bound to the credential cache's verified rules (`policy()`) and the person's hub session through a live shared project (`hub()`, `HubTransport.trustSession`); the inbox item carries the officer's role credentials (`roles`) and the pickup copies them into the wallet item, where the session's wallet reads them. Open for Phase 47: render `STERLING_ORGANIZATION_POLICY` and `STERLING_ORGANIZATION_POLICY_KEY` beside `STERLING_STATUS_LIST_KEY` and `STERLING_OPENBAO_ISSUER_ROLE` (G465).
- **For 71-13 (D-26):** the session's credential check must go through `checkEvidence` (or call `checkComputerBinding`), so a computer binding counts only when the person's DID document lists it. The person's backend publishes the longer log at the next hub session (`publishToHub`; `published` is set to false after a computer is listed).
