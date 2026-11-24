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
- **Status:** open, for 71-10 (the first plan that adds a workbench test).
