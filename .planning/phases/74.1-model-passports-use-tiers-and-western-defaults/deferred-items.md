# Phase 74.1: deferred items (out of scope for the plan that found them)

Found during the full root suite run after 74.1-07, 10, 11, 12, 13 and 15 (2026-11-25, head ab456267; 6682 tests, 8 skipped).

- **`spendSendPath.test.ts` "S1. a GSD plan step in auto mode ... every request is in the ledger"** fails with "an auto GSD step asks the person for nothing" (the researcher's `probe` asks). It fails the same way on the branch's starting head ad1e78c2 (checked by building that tree apart and running the one test), so it predates these plans; it is likely 74.1-08's safety classifier of another family finding none on the test's fake catalogue. Owner of the fix: whoever closes 74.1-08's follow-ups, before 74.1-17's full run.
- **`cyberSandboxDocker.test.ts` "the container has no outbound network unless a scope explicitly asks for one"** failed once under the full run's load (14 s) and passes alone, on this head and on ad1e78c2. Infrastructure (Docker under load), not a code change; rerun the shard in 74.1-17.
