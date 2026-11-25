# Phase 71: deferred items (out of scope, found during execution)

- **2026-11-24, wave 1, full root run.** Two existing tests depend on how long the temporary folder's path is. Neither touches Phase 71 code. With `TMPDIR=/tmp`, the path CI uses, both pass (49 of 49, capped run of `dist/test/cyberAssembly.test.js` and `dist/test/autoApproval.test.js`). They fail only with the long scratchpad `TMPDIR` that local capped runs use.
  - `dist/test/cyberAssembly.test.js`, "the store path and the run root are the same workspace":
    - **Cause:** `cyberStorePath` (`src/services/cyberAssembly.ts`, line 29) sanitises the workspace path and keeps its first 80 characters. The test builds the expected key from the whole sanitised path, without that cut.
    - So the test passes only while the sanitised workspace path is at most 80 characters:
      - under `/tmp`: `tmp-near-ai-test-run-XXXXXX-near-ai-cyber-assembly-XXXXXX-workspace`, about 65 characters, passes;
      - under the scratchpad (and under a mid-length path such as `/home/aaron/.cache/claude-code-tmp/p71`): over 80 characters, fails.
    - **Latent code issue (not fixed here, owner of the cyber module to decide):** two workspaces whose sanitised paths share their first 80 characters would share one store. That goes against the test's own comment that "two workspaces with the same folder name must not share a store".
    - **Proper fix:** a key that stays unique when shortened, for example a readable prefix plus a hash of the whole path. The test should then derive its expected key the same way, never by loosening the assertion.
  - `dist/test/autoApproval.test.js`, "the managed Open-GSD runtime's gsd-tools runs without an approval":
    - **Cause:** the approval prompt shortens the command it shows, and a long temporary path pushes the `gsd-evil` marker past the cut.
    - It passes under `/tmp` and under a mid-length path. Local only, no product issue.

- **2026-11-24, 71-12, full root run.** `dist/test/staffReplicaHubMembership.test.js`, "not-a-roster-writer: a member's device cannot admit the hub; nothing is written", failed once with `PayloadError: Nothing was signed: the payload has a secret-like value at $.nonce.`
  - **Cause:** `buildJoinRequest` (`src/domain/replica/invite.ts`) signs a random nonce, and `signPayload`'s secret-like value check (`src/domain/team/signedPayload.ts`) sometimes matches a random value. The test flakes at random.
  - **Not 71's code;** a rerun of the file passed 48 of 48.
  - **Proper fix (owner of the replica code):** exempt the nonce field by its known shape, or draw nonces in a form the check never matches. Do not loosen the test.
