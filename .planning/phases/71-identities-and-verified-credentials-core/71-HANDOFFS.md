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
- **Status:** 71-10 took option (a): `workbench/test/credentials-identity-service.test.ts`. Open for 71-12 and 71-13, which add their own flat `credentials-` files.

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
