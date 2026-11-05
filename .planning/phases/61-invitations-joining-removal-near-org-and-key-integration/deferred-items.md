# Phase 61 deferred items

## Found during 61-15 (2026-11-03)

- `src/test/teamGsdImport.test.ts` "every plan committed at HEAD parses, and HEAD gives milestone v0.6.0 with phases 60 to 67 and finished phases 60 and 61" fails (actual 24 plans in phase 61, expected 14), and `src/test/teamImport.test.ts` "this repository's own .planning at HEAD imports into a correct graph" fails (`plan:61-15` is `backlog`, expected `done`). Both read this repository's own `.planning` at HEAD and assume Phase 61 is finished with 14 plans. They fail since the fix-pass plans 61-15 to 61-24 were committed (7b3a441), before any 61-15 code change, and are unrelated to the wording rename. They should be brought in line with the fix pass (for example by the final full-suite plan 61-22) once the gap-closure plans are done.

## Found during 61-16 (2026-11-03)

- `src/test/teamSession.test.ts` "an unreachable remote pauses with a redacted reason, backs off to 10 minutes, retries on focus and recovers" failed once in the all-team run (58+ files in one `node --test`, MemoryMax=6G) with "the paused state is written once while it lasts: 2 !== 1". It passed 3 times alone (`--test-name-pattern`) and in a full `teamSession.test.js` run (21/21). The test does not touch `src/team/projectHome.ts`; the only shared change is `networkEnv` becoming an export, with no behaviour change. It looks timing-sensitive under load; worth a look in the final full-suite plan (61-22).
  - Resolved in 62-18 (commit 9e49bc5): git's reason for an unreachable remote carries the connect time ("after 0 ms"), which moves with load, and the session's dedupe key included it. See the phase 62 deferred-items entry.

## Found during 61-28 (2026-11-04)

- `src/test/turnEfficiency.test.ts` "web fetches requested in one turn run at the same time; a write between them still runs alone and in order" failed once in the full `npm test` run (MemoryMax=6G) with "two rounds of 150 ms, not four (457 ms)". It passed 3 times out of 3 alone. It measures wall-clock time against a 150 ms budget, so it is load-sensitive; 61-28 touches no agent or tool-scheduling code. Worth widening its margin or using an injected clock.

## The owner's 0.6.4 re-test (2026-11-05), found during 61-34

- A stable project id is deferred (61-UAT, the moved-folder item, G-61-15). Today the project id is a hash of the project folder's path (`src/domain/auth.ts` createProjectCredentialScope, identity set to the folder path in `src/services/profileStore.ts`), so moving or renaming a folder cuts it off from the keys saved under the old id. The proposal: keep the `projectId` already written in `.planning/.near-ai/auth-profiles.json` as the project's identity when it is present, use the path hash only for a new project, and on a mismatch between the file's `projectId` and the path hash offer "This project moved. Reconnect its saved key?", which re-links the old scope by reference (never reading the key out). Until then the README line under "Good to know" and the tested way back stand: Use a saved profile lists the profile under the folder's old name and using it works with the original key by reference (`src/test/profileIndex.test.ts`, "after a project folder is moved or renamed ..."; 61-34 also lets that saved profile replace the moved project's own profile of the same name when that profile has no key here).
