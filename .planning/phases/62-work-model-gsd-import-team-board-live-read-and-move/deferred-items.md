# Phase 62 deferred items

## teamBoardView.test.js runs out of memory when the whole file runs under the 1536 MB cap (found in 62-13, not caused by it)

- Symptom: `(ulimit -v 6000000; NODE_OPTIONS=--max-old-space-size=1536 timeout 300 node --test dist/test/teamBoardView.test.js)` passes 17 or 18 tests, then a child process dies with "Committing semi space failed. Allocation failed - JavaScript heap out of memory" while "a card that is not on the board is refused ..." runs. The same happens with `--max-old-space-size=3000`.
- It is not from 62-13: the identical run on the unchanged 62-12 boardView.ts (checked by building the old file) fails at the same test.
- Every test passes alone, and any run that skips either the first 4 or the 8 move-prompt tests passes (16 and 12 tests). The main process heap stays under 40 MB, so the growth is in a child process (git or a helper), and it only appears after about 17 real-git rigs in one file.
- Workaround used in 62-13: run the file in partitions with `--test-name-pattern` / `--test-skip-pattern` (all 27 tests pass that way).
- Suggested fix for a later plan: split teamBoardView.test.ts into two files, or find which helper process leaks per rig (suspect: fake NEAR server or an un-awaited git child in `closeRig`).
