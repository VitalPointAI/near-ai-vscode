# Phase 61 deferred items

## Found during 61-15 (2026-11-03)

- `src/test/teamGsdImport.test.ts` "every plan committed at HEAD parses, and HEAD gives milestone v0.6.0 with phases 60 to 67 and finished phases 60 and 61" fails (actual 24 plans in phase 61, expected 14), and `src/test/teamImport.test.ts` "this repository's own .planning at HEAD imports into a correct graph" fails (`plan:61-15` is `backlog`, expected `done`). Both read this repository's own `.planning` at HEAD and assume Phase 61 is finished with 14 plans. They fail since the fix-pass plans 61-15 to 61-24 were committed (7b3a441), before any 61-15 code change, and are unrelated to the wording rename. They should be brought in line with the fix pass (for example by the final full-suite plan 61-22) once the gap-closure plans are done.

## Found during 61-16 (2026-11-03)

- `src/test/teamSession.test.ts` "an unreachable remote pauses with a redacted reason, backs off to 10 minutes, retries on focus and recovers" failed once in the all-team run (58+ files in one `node --test`, MemoryMax=6G) with "the paused state is written once while it lasts: 2 !== 1". It passed 3 times alone (`--test-name-pattern`) and in a full `teamSession.test.js` run (21/21). The test does not touch `src/team/projectHome.ts`; the only shared change is `networkEnv` becoming an export, with no behaviour change. It looks timing-sensitive under load; worth a look in the final full-suite plan (61-22).
  - Resolved in 62-18 (commit 9e49bc5): git's reason for an unreachable remote carries the connect time ("after 0 ms"), which moves with load, and the session's dedupe key included it. See the phase 62 deferred-items entry.
