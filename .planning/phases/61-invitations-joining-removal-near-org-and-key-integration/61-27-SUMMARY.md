---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 27
subsystem: auth
tags: [profiles, secret-storage, global-state, select-profile, gap-closure, cherry-pick-0.4.15]

requires:
  - phase: 61-26
    provides: "Team section and readiness rule; profiles stay per project"
provides:
  - "src/services/profileIndex.ts: the computer-wide list of saved profiles in VS Code global state (metadata only), copy links, and the Use a Saved Profile flow with injected window functions"
  - "OrganizationProfile.keySource: a profile reused from another project reads that project's key by reference"
  - "ProfileStore.useSavedProfile, getScope by reference (only for a copy chosen on this computer), remove that keeps the original key, plain error when the original is gone"
  - "Select Profile item 'Use a profile from another project' and the nearAi.useSavedProfile command ('Use a Saved Profile', NEAR AI)"
affects: [61-30, 0.4.15-release, 61-uat-retest]

actuals:
  tokens: 14775
  tasks: 3
  commits: 6
plan_head_before: 2050f568ec56dc9fc56bed9a9ed061fee4976ea9
plan_head_after: d30d97f5b5fe44e71348b2f27a315f03e921c6ba

tech-stack:
  added: []
  patterns:
    - "A copy keeps the original's profileId, so providerFactory's scope check holds and the key is read from the original scope with its endpoint binding"
    - "A reference is followed only when a copy link in global state says the person chose it on this computer; a reference in a project file alone reaches no key"
    - "A UI flow as a plain function taking pick, progress, info and error, so it is tested without a VS Code stub and cherry-picks to main"

key-files:
  created:
    - src/services/profileIndex.ts
    - src/test/profileIndex.test.ts
  modified:
    - src/services/profileStore.ts
    - src/domain/auth.ts
    - src/extension.ts
    - package.json
    - src/test/profileStore.test.ts

key-decisions:
  - "A reused profile keeps the original's profileId and stores keySource { projectId, profileId } of the original scope; normalizeProfile drops any other shape, a different profileId or a team id"
  - "getScope follows keySource only when the global-state copy link (recorded by useSavedProfile) matches; a copy found in auth-profiles.json without a link is loaded as needing a check and is invalid when checked (T-61-107)"
  - "A copy never writes a key: saveProfileApiKey, saveProfileRefreshToken and importLegacy refuse it, and configure on a copy first removes the copy (metadata only) so the new key goes to this project's own scope (T-61-108)"
  - "The Use a Saved Profile flow lives in profileIndex.ts (runUseSavedProfile with injected window functions) instead of extension.ts, so its tests need neither VS Code nor the Team-branch test helpers"

patterns-established:
  - "Saved-profile list: recordProjectProfiles after load and every persist; written only when its JSON changed; capped at 50 entries and 50 links"

requirements-completed: [TEAM-02]

coverage:
  - id: D1
    description: "A profile set up in project A is listed (name, folder name, check status) and used in project B by reference; the key is in SecretStorage once, under A's scope, and nowhere in the list or either profile file; a chat request from B is sent with A's key"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "src/test/profileIndex.test.ts#tracer: a profile set up in one project is listed and used in another by reference, and serves a chat request with the original key"
        status: pass
      - kind: unit
        ref: "src/test/profileIndex.test.ts#a team key profile is never offered for use elsewhere"
        status: pass
      - kind: unit
        ref: "src/test/profileIndex.test.ts#the saved-profile list fills when a project is opened and is written only when something changed"
        status: pass
      - kind: unit
        ref: "src/test/profileIndex.test.ts#a saved profile is used only when it comes from the list and from another project"
        status: pass
    human_judgment: false
  - id: D2
    description: "Removing a copy keeps the original profile and key; a copy whose original was removed is invalid with 'The saved profile this one uses was removed. Set up a new profile or choose another.'; a malformed source is dropped on load; a hand-written source reaches no key; a copy never writes the original's key"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "src/test/profileStore.test.ts#removing a reused profile removes only this project's copy; the original profile and its key stay"
        status: pass
      - kind: unit
        ref: "src/test/profileStore.test.ts#when the original profile is removed, the copy says plainly that it no longer works"
        status: pass
      - kind: unit
        ref: "src/test/profileStore.test.ts#setting up a reused profile again gives this project its own key and never writes the original project's key"
        status: pass
      - kind: unit
        ref: "src/test/profileStore.test.ts#a reused profile whose source is malformed in the profile file is dropped on load, and a hand-written source reaches no key"
        status: pass
    human_judgment: false
  - id: D3
    description: "Use a Saved Profile flow: pick by name and 'from <folder>' with check status, progress 'Checking your NEAR AI key', '<name> is ready for this project.'; none saved and failed check offer 'Set up a new profile'; activation sets up the list first; command contributed and registered"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "src/test/profileIndex.test.ts#Use a Saved Profile lists each saved profile by name and folder with its check status, uses the chosen one and says it is ready"
        status: pass
      - kind: unit
        ref: "src/test/profileIndex.test.ts#with no saved profiles, Use a Saved Profile says so plainly and offers Set up a new profile"
        status: pass
      - kind: unit
        ref: "src/test/profileIndex.test.ts#a saved profile that does not pass the check says why and offers Set up a new profile"
        status: pass
      - kind: unit
        ref: "src/test/profileIndex.test.ts#activation sets up the saved-profile list first, and Select Profile and Use a Saved Profile offer the choice"
        status: pass
    human_judgment: false
  - id: D4
    description: "In a real VS Code window, Select Profile and the chat's Choose profile show 'Use a profile from another project' and the picker reads plainly"
    verification: []
    human_judgment: true
    rationale: "The pickers and notifications are wired to vscode.window in extension.ts and are not driven by a real-window test in this plan; the owner's re-test of 61-UAT test 10 confirms it"

duration: 16min
completed: 2026-11-04
status: complete
---

# Phase 61 Plan 27: Use a profile from another project Summary

**A computer-wide list of saved NEAR AI profiles in VS Code global state (metadata only) lets Select Profile, the chat's Choose profile and the new Use a Saved Profile command reuse a profile from another project. The copy reads the original project's key by reference from SecretStorage. The key is never copied or shown, removing the copy never deletes it, and nothing in this plan imports Team Mode, so the six commits cherry-pick cleanly onto origin/main for 0.4.15.**

## Performance

- **Duration:** 16 min
- **Started:** 2026-11-04T20:33:11Z
- **Completed:** 2026-11-04T20:49:00Z
- **Tasks:** 3
- **Files modified:** 7

## Accomplishments

- G-61-9 (61-UAT test 10), saved-profile part, closed. A person can choose "Use a profile from another project" and pick a profile by its name and the folder it came from. The key is checked where it is stored ("Checking your NEAR AI key"), the profile becomes active, and the message says "<name> is ready for this project."
- `profileIndex.ts` keeps entries under `nearAi.savedProfiles` in global state. An entry holds the project scope id (a hash), the folder name only, the profile metadata and the check status. Team key profiles (`profile-team-*`, a plain prefix) and copies are never listed. The list fills as projects are opened with this version and is written only when it changed.
- `ProfileStore` records the list after load (also when there is no profile file yet) and after every write. `useSavedProfile` re-reads the entry from the list, so an entry the caller made up is refused. It also refuses the current project's own profiles, records a copy link, checks the key through `getScope` and selects the copy only when the check passes.
- The key is read by reference only. The tracer test puts a run-time canary key in SecretStorage and finds it exactly once, under A's scope. The canary is absent from the list, from both projects' `auth-profiles.json`, from every message and picker item, and from the returned profile. A chat request from B (`createNearAiProvider` + `listModels`) carries `Bearer <canary>` to the profile's endpoint.
- Removing a copy removes only its metadata and link. If the original is removed, the copy says "The saved profile this one uses was removed. Set up a new profile or choose another." and the failed-check message offers Set up a new profile (and Choose another when more are saved).

## Task Commits

1. **Task 1 (tracer) RED:** `b6ddbb9` test(61-27): a profile set up in one project is listed and used in another by reference (RED)
2. **Task 1 GREEN:** `e5323a2` feat(61-27): reuse a profile from another project by reference to its stored key (GREEN)
3. **Task 2 RED:** `5b2147d` test(61-27): removing a copy keeps the original key; a copy whose original is gone says so (RED)
4. **Task 2 GREEN:** `863164d` feat(61-27): a copy never removes the original key, and a broken copy says what to do (GREEN)
5. **Task 3 RED:** `c7122f8` test(61-27): Select Profile and Use a Saved Profile offer a profile from another project (RED)
6. **Task 3 GREEN:** `d30d97f` feat(61-27): Use a profile from another project in Select Profile and the Use a Saved Profile command (GREEN)

No REFACTOR commits were needed.

## TDD Gate Compliance

- **Task 1 RED:** `node --test --test-reporter=tap --test-name-pattern="^tracer" dist/test/profileIndex.test.js` exited 1. The target "tracer: a profile set up in one project is listed and used in another by reference, and serves a chat request with the original key" failed on its first assertion, "one saved profile is recorded" (`0 !== 1`). Classifier: RED_EVIDENCE_OK (target_test_failed). Semantic assessment: profileIndex.ts was declared only (init no-op, list returns []). The module loaded, so this was the planned behaviour assertion. A first attempt with a stub that threw inside the fixture was rejected by me as a fixture failure, and the stub was made inert. A whole-file TAP report was classified `invalid_record` ("Non-TAP data", from the multi-line diff blocks), so the target was re-run alone, as the reference allows.
- **Task 2 RED:** the target "when the original profile is removed, the copy says plainly that it no longer works" failed with expected the plain sentence, actual `HTTP 401`. Classifier: RED_EVIDENCE_OK (target_test_failed). The second new target (hand-written source) also failed on its planned assertion ("it is not trusted as checked"). Two new guards already passed at RED; see Deviations.
- **Task 3 RED:** the target "Use a Saved Profile lists each saved profile by name and folder..." failed with expected `'ready'`, actual `'cancelled'` (flow declared only). Classifier: RED_EVIDENCE_OK (target_test_failed). The other three new tests failed on their planned assertions.
- Every GREEN commit follows its RED commit.

## Files Created/Modified

- `src/services/profileIndex.ts`: the list (initProfileIndex, recordProjectProfiles, listSavedProfiles, findSavedProfile), the copy links (recordCopyLink, dropCopyLink, isLinkedCopy), isTeamProfileId and runUseSavedProfile. No run-time vscode import.
- `src/services/profileStore.ts`: recordIndex, getScope by reference via linkedSource, useSavedProfile, remove that keeps the original, validate for copies (source unavailable or removed), refusal to write keys for a copy, configure on a copy makes an own profile, and normalizeKeySource.
- `src/domain/auth.ts`: `OrganizationProfile.keySource?`.
- `src/extension.ts`: `initProfileIndex(context.globalState)` right after AuthService, the `nearAi.useSavedProfile` command, the Select Profile item, and useSavedProfile wiring vscode.window into the flow.
- `package.json`: contributes `nearAi.useSavedProfile`, "Use a Saved Profile", category NEAR AI.
- `src/test/profileIndex.test.ts` (new, 8 tests) and `src/test/profileStore.test.ts` (+4 tests).

## Verification

- Task 1 verify (`tsc` + profileIndex, profileStore, auth tests): exit 0, 14 tests, 14 pass. The tracer gate re-ran it in auto mode: passed.
- Task 2 verify (`tsc` + profileStore, profileIndex, providerFactory): exit 0, 19 tests, 19 pass.
- Task 3 verify (`tsc` + profileIndex, profileStore, extensionActivate, teamManifest, teamSoloParity): exit 0, 41 tests, 41 pass.
- Full `npm test` (6G cap, choom, one heavy run, nothing else running): exit 0, 1996 tests, 1985 pass, 0 fail, 11 skipped (the existing skips, none in this plan).
- Cherry-pick check: all six commits replayed on origin/main with `git merge-tree` (no checkout), no conflicts, and no `services/team` file in the result. That tree was extracted to the scratchpad: `tsc` passed, and profileIndex, profileStore, auth and providerFactory gave 27 tests, 27 pass.
- No file of this plan imports from src/team, src/domain/team or src/services/team (acceptance grep prints 0 for each).
- E2E was not run; the plan does not require it. The e2e check "contributed commands without a handler" covers the new command, which is registered in activate like every other command.

## Decisions Made

See key-decisions. In short: the copy keeps the original's profileId. The reference is followed only through a global-state link that useSavedProfile writes. A copy never writes or imports a key.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Security] A reference in a project file alone reaches no key (copy links)**
- **Found during:** Task 1
- **Issue:** As planned, normalizeProfile accepts a well-formed keySource. A cloned repository could ship `.planning/.near-ai/auth-profiles.json` with an active, "valid" copy naming another project's scope id (a hash of a guessable path). The extension would then use that key for requests in the cloned project. The endpoint binding stops a different URL but not NEAR AI Cloud itself. T-61-107 asks that keySource be "used only for a profile the person chose through useSavedProfile".
- **Fix:** useSavedProfile records a copy link {projectId, profileId, sourceProjectId} in global state, and getScope follows keySource only when that link exists. On load, an unlinked copy marked valid is loaded as stale, and checking it gives "That saved profile is no longer available. Set up a new profile or choose another."
- **Files modified:** src/services/profileIndex.ts, src/services/profileStore.ts
- **Verification:** profileStore.test.ts "...a hand-written source reaches no key"
- **Committed in:** e5323a2, 863164d

**2. [Rule 2 - Security] A copy never writes into the original project's key scope**
- **Found during:** Task 1
- **Issue:** saveProfileApiKey, saveProfileRefreshToken and importLegacy resolve their scope with getScope. For a copy that scope is the original's, so setting up the copy again would overwrite project A's key from project B (T-61-108).
- **Fix:** Those three methods refuse a copy with "This profile uses a key saved in another project. Set up a new profile to use a different key." configure on a copy first removes the copy (metadata only), so the new key goes to this project's own scope.
- **Files modified:** src/services/profileStore.ts
- **Verification:** profileStore.test.ts "setting up a reused profile again gives this project its own key and never writes the original project's key"
- **Committed in:** e5323a2

**3. [Rule 3 - Blocking] The Use a Saved Profile flow lives in profileIndex.ts, and the activation check reads the source**
- **Found during:** Task 3
- **Issue:** The plan asked for activation and command tests "with a stubbed vscode". The repo's stub (`src/test/helpers/vscodeStub.ts`) and `extensionActivate.test.ts` exist only on the Team branch, not on origin/main. Tests built on them would not compile after the cherry-pick to 0.4.15.
- **Fix:** The flow is `runUseSavedProfile(ui, deps)` in profileIndex.ts, with pick, progress, info and error passed in. extension.ts hands it vscode.window. The flow tests drive it with a recording UI. Activation order (`initProfileIndex(context.globalState)` before the sidebar, closeInterruptedRuns and every registerCommand), the registration and the manifest entry are checked by reading src/extension.ts and package.json. That pattern is already used in teamSectionHost.test.ts. extensionActivate.test.ts still runs activation green on this branch.
- **Files modified:** src/services/profileIndex.ts, src/test/profileIndex.test.ts
- **Committed in:** c7122f8, d30d97f

**4. [Rule 1 - Correctness] The copy keeps the original's profileId**
- **Found during:** Task 1
- **Issue:** providerFactory requires `scope.profileId === profile.profileId`. A copy with a new id would fail every chat request, and providerFactory is not in this plan's files.
- **Fix:** The copy uses the original's profileId (different projects never collide, since deriveProfileId hashes the folder). normalizeKeySource requires keySource.profileId to equal the profile's id.
- **Committed in:** e5323a2

---

**Total deviations:** 4 auto-fixed (2 security, 1 blocking, 1 correctness)
**Impact on plan:** Deviations 1 and 2 add the threat-model mitigations; they add no new surface. Deviation 3 keeps the plan cherry-pickable. No extra files beyond the plan's list.

## Issues Encountered

- At Task 2 RED, two new guards already passed. "Removing a reused profile..." passed because the old remove resolved the scope after dropping the profile, so it deleted the copy's own (empty) scope. Task 2 GREEN makes the skip explicit (`if (removed.keySource) dropCopyLink`). "Setting up a reused profile again..." passed because of the Task 1 write guard (deviation 2). Both are kept as regression guards; the RED targets were the other two tests.

## Known Limitations

- A chat request through a copy tags its spend with the original project's scope id (`spendTag.projectId = scope.projectId` in providerFactory). Spend accounts are per key, so totals and limits are unchanged, but per-project figures count B's use under A. Fixing this needs providerFactory to take the project id separately; that file is outside this plan.
- The list fills only as projects are opened with this version (as the plan states).

## User Setup Required

None.

## Next Phase Readiness

- 61-30 (Team Mode join flows) can call `nearAi.useSavedProfile`.
- For 0.4.15: cherry-pick b6ddbb9, e5323a2, 5b2147d, 863164d, c7122f8 and d30d97f onto main, in that order. They replay cleanly on origin/main and compile there.

## Self-Check: PASSED

- FOUND: src/services/profileIndex.ts, src/test/profileIndex.test.ts
- FOUND commits: b6ddbb9, e5323a2, 5b2147d, 863164d, c7122f8, d30d97f (all ancestors of HEAD)

---
*Phase: 61-invitations-joining-removal-near-org-and-key-integration*
*Completed: 2026-11-04*
