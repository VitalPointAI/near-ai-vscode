# Phase 71: deferred items (out of scope, found during execution)

- **2026-11-24, wave 1, full root run.** Two existing tests depend on how long the temporary folder's path is. With the long scratchpad `TMPDIR` the local capped runs use, they fail. Neither touches Phase 71 code, and CI's short `/tmp` passes them.
  - `dist/test/cyberAssembly.test.js`, "the store path and the run root are the same workspace":
    - `cyberStorePath` (`src/services/cyberAssembly.ts`) cuts the workspace key to 80 characters, but the test expects the whole sanitised path.
    - It fails whenever that path is longer than 80 characters. It still fails with a shorter scratchpad path.
    - Fix: the test applies the same 80-character cut, or the code uses a hash of the path instead of truncating it.
  - `dist/test/autoApproval.test.js`, "the managed Open-GSD runtime's gsd-tools runs without an approval":
    - The approval prompt shortens the command, which cuts off the long temporary path before `gsd-evil`.
    - It passes with a shorter temporary path.
