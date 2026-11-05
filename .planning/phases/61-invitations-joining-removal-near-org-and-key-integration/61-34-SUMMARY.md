---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 34
subsystem: team-mode
tags: [team-mode, saved-profiles, secret-storage, code-server, web-ui, notice, readme, gap-closure]

requires:
  - phase: 61-27
    provides: "The saved-profile list (listSavedProfiles, runUseSavedProfile) and ProfileStore.validate's SOURCE_UNAVAILABLE and SOURCE_REMOVED reasons"
  - phase: 61-32
    provides: "The own-key Join profile and the profile-changed signal, which this plan's check now also covers in the list"
provides:
  - "ProfileStore.savedKeyHere(entry): true or false only, from the presence of an API key or sign-in token under the entry's own scope; a local-only profile counts as here"
  - "runUseSavedProfile offers usable entries first, labels the rest 'Its key is not on this computer or browser.', and never calls use() for one; only-unavailable says so with Set up a new profile"
  - "ProfileStore.validate names a listed source whose key is not here instead of 'was removed'; useSavedProfile may replace this project's own profile of the same name when that profile has no key here (the way back after a folder move)"
  - "The empty-list words: 'There are no saved profiles yet. Profiles from your other projects appear here after you open each of those projects once with this version of NEAR AI.'"
  - "src/domain/webTabNotice.ts offerWebTabNotice: one-time Got it notice in a web UI, remembered as soon as it is shown, tried again if it could not be shown"
  - "README: the moved or renamed folder bullet (Good to know) and the one code-server tab per browser profile bullet (Troubleshooting)"
affects: [61-35, 62-28, 62-30 gate, 0.4.16 cherry-pick, team-preview merge]

actuals:
  tokens: 11608
  tasks: 3
  commits: 6
plan_head_before: b7329019b19c4ca3255271ff30f8e498c8d780c8
plan_head_after: 87f3d04aafd24dbd20f5d1f0f4cabd2eac33767d

tech-stack:
  added: []
  patterns:
    - "A presence check turns the stored value into a boolean at once and never returns, logs or shows it (savedKeyHere)"
    - "A once-only notice takes an injected host ({web, state, tell}) like offerProxyAdvice, so it is tested without VS Code"
    - "The shown flag is written as soon as the notice is shown and cleared again if showing it failed, so a notice that could not be shown is retried at the next start"

key-files:
  created:
    - src/domain/webTabNotice.ts
    - src/test/webTabNotice.test.ts
  modified:
    - src/services/profileStore.ts
    - src/services/profileIndex.ts
    - src/extension.ts
    - src/test/profileIndex.test.ts
    - src/test/profileStore.test.ts
    - src/test/savedProfileUi.test.ts
    - README.md
    - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/deferred-items.md

key-decisions:
  - "61-34: the saved-profile list is shared but keys are per browser profile or computer, so the list asks savedKeyHere for each entry and lists an entry whose key is not here as unavailable rather than hiding it; another person's entries are not hidden here (61-35 owns that)"
  - "61-34: a reused profile whose source entry is still listed but has no key here says 'Its key is not on this computer or browser. Set up a new profile here, or choose another.'; a source that was really removed keeps saying it was removed"
  - "61-34: useSavedProfile may replace this project's own profile of the same name only when that profile has no key, sign-in token or local key here, which is the way back after a folder move; one with a key here is still refused"
  - "61-34: the web UI notice carries Only Got it (a one-time notice, so a Don't show again choice would mean nothing) and shows in any web UI, solo projects included, never on the desktop (owner decision C, 2026-11-05)"
  - "61-34: the reason line goes through redactSecrets as on main (0.4.15), so the next merge has nothing to resolve there"

patterns-established:
  - "Presence, not a value: an availability question about a secret answers a boolean and is never written into a message, a picker item, a memento or a log line"

requirements-completed: [TEAM-02]

coverage:
  - id: D1
    description: "Use a saved profile offers only profiles whose key is in this computer's or browser's storage, lists the rest as unavailable with a plain reason, and never uses an unavailable one"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "src/test/profileIndex.test.ts#tracer: Use a saved profile lists a profile whose key is not on this computer or browser as unavailable, never uses it, and says why; #with only profiles whose key is not here ...; src/test/profileStore.test.ts#savedKeyHere answers true or false only ...; #savedKeyHere counts a local-only profile as available"
        status: pass
    human_judgment: false
  - id: D2
    description: "A reused profile whose source is still listed but whose key is not here says so instead of saying it was removed; a removed source still says it was removed"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "src/test/profileStore.test.ts#a reused profile whose source is still listed but whose key is not here says so, not that it was removed (and the existing removed-source test, unchanged)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The empty saved-profile list explains itself, and a moved or renamed project has a written, tested way back to its saved key"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "src/test/profileIndex.test.ts#a project folder moved or renamed: Use a saved profile lists its profile under the old folder name and using it works with the original key; #with no saved profiles ...; src/test/profileStore.test.ts#a saved profile never replaces this project's own profile of the same name while that profile has its key here"
        status: pass
    human_judgment: true
    rationale: "The README line and the deferred stable project id are documentation; the owner reads the wording in the 0.6.5 re-test."
  - id: D4
    description: "A web UI says once, with Got it, to keep one tab per browser profile, and the README's code-server tips say the same"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "src/test/webTabNotice.test.ts (6 tests: exact words, desktop silent, shown once, retried after a failure, the activation wiring, the README tips)"
        status: pass
    human_judgment: true
    rationale: "The notice is seen in a real code-server; the extension-host and code-server launches are read-only windows, so the owner confirms the one-time behaviour in 0.6.5."

duration: 8min
completed: 2026-11-05
status: complete
---

# Phase 61 Plan 34: Use a saved profile offers only profiles whose key is here, the empty list and the moved folder explain themselves, and a web UI warns once about several tabs

**A saved profile is now offered only where its key actually is, an unavailable one says why in plain words and is never used, an empty list and a moved folder have written answers, and a browser-based editor says once to keep one tab per browser profile.**

## Performance

- **Duration:** 8 min for the wrap-up (the three tasks were committed before this session; their RED and GREEN commits are listed below)
- **Completed:** 2026-11-05
- **Tasks:** 3 (tracer + 2 auto), each RED then GREEN
- **Files modified:** 10 (2 created)

## Accomplishments

- `ProfileStore.savedKeyHere(entry)` (src/services/profileStore.ts): the entry's own scope is checked through the existing presence check and turned into a boolean at once. A local-only profile counts as present because its key is optional; a malformed project id or profile id answers false without touching storage. 61-35 builds on this check.
- `runUseSavedProfile` (src/services/profileIndex.ts): `UseSavedProfileDeps.hasKey` is asked for every listed entry; usable entries come first, the rest carry `${organization}. Its key is not on this computer or browser.` in their detail. Choosing an unavailable entry shows `${name}: its key is not on this computer or browser. Set up a new profile here, or choose another.` with **Set up a new profile** and **Choose another**, and never calls `use()`. Only unavailable entries produces one message with **Set up a new profile**. A `hasKey` that throws counts as not here, so a storage failure cannot offer an entry.
- `ProfileStore.validate` distinguishes a listed source whose key is not here (KEY_NOT_HERE) from a source that was removed (SOURCE_REMOVED, unchanged and still green). `useSavedProfile` may replace this project's own profile of the same name only when that profile has no key, sign-in token and local key here, which is the tested way back after a folder move.
- The empty list says: 'There are no saved profiles yet. Profiles from your other projects appear here after you open each of those projects once with this version of NEAR AI.' with **Set up a new profile**.
- src/domain/webTabNotice.ts: `offerWebTabNotice({ web, state, tell })` shows `NEAR AI: keep one tab of this editor per browser profile. ...` with **Got it** once in a web UI, writes the shown flag as soon as it is shown, clears it again if showing failed, and returns `'not-web' | 'already-shown' | 'shown'`. Called at activation next to `suggestProxySupportOff`, ignoring a failure.
- README: a **Good to know** bullet for a moved or renamed folder and its way back, and a **Troubleshooting** bullet for one code-server tab per browser profile and what to do after a lost key. deferred-items.md records the stable project id as deferred with the 61-UAT proposal.

## Task Commits

1. **Task 1 (tracer): only profiles whose key is here, and the words for the rest**
   - `4ca5416` test (RED)
   - `3cf3f63` fix (GREEN)
2. **Task 2: the empty list, and the moved folder's way back**
   - `1bb060b` test (RED)
   - `5ff10db` fix (GREEN)
3. **Task 3: the one-time web UI notice and the README tip**
   - `1822f62` test (RED)
   - `87f3d04` fix (GREEN)

## Test results (all under the memory cap)

- Task 1 verify (`npx tsc` + profileIndex, profileStore, savedProfileUi): 27 tests, 27 pass, 0 fail.
- Task 2 verify (`npx tsc` + profileIndex, profileStore): 25 tests, 25 pass, 0 fail.
- Task 3 verify (`npx tsc` + webTabNotice, proxyAdvice, profileIndex): 19 tests, 19 pass, 0 fail.
- All acceptance greps hold: `savedKeyHere` in profileStore.ts and extension.ts; `not on this computer or browser` in profileIndex.ts and profileStore.ts; `after you open each of those projects once` (1); `renaming a project folder` in README.md; `stable project id` in deferred-items.md; `offerWebTabNotice` in extension.ts; `one code-server tab per browser profile` in README.md.
- Invite launch under `NEAR_AI_E2E_ONLY=invite` (xvfb-run, hidden screen, MemoryMax=6G): 25 window checks passed, exit 0, including the team-join window.
- Full `npm test` (MemoryMax=6G, timeout 1800): 2235 tests, 2222 pass, 2 fail, 11 skipped. Both failures are the RED tests committed in 6ff8876 (`src/test/teamBoardReopenColumn.test.ts`, reopen to Backlog), which plan 62-28 closes; they are not caused by this plan.

## Decisions Made

See key-decisions above. In short: an unavailable entry is listed, not hidden (hiding is 61-35's job); presence is a boolean and nothing else; the notice is retried if it could not be shown; the moved-folder way back may replace only a profile of the same name that has no key here.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The empty list was not the only wording missing: the only-unavailable case needed its own sentence**
- **Found during:** Task 1 GREEN
- **Issue:** with every listed entry unavailable, an empty picker would have been shown.
- **Fix:** one message with **Set up a new profile** and no picker, covered by its own test.
- **Files modified:** src/services/profileIndex.ts, src/test/profileIndex.test.ts
- **Commit:** 3cf3f63

**2. [Test setup] A `hasKey` that throws counts as not here**
- **Found during:** Task 1 GREEN
- **Issue:** a storage read failure would otherwise reject the whole list and leave the person with no message.
- **Fix:** the answer is wrapped so a rejection answers false, and the entry is listed as unavailable.
- **Commit:** 3cf3f63

**3. [Owner constraint] The replaced-profile rule was needed for the moved-folder way back**
- **Found during:** Task 2 GREEN
- **Issue:** after a folder move, the project's own profile of the same name is still listed with no key here, so `useSavedProfile` refused the saved profile as a duplicate and the documented way back did not work.
- **Fix:** the duplicate refusal now applies only when that own profile still has a key, sign-in token or local key here; a new test pins both halves.
- **Files modified:** src/services/profileStore.ts, src/test/profileStore.test.ts
- **Commit:** 5ff10db

**4. [Fact shape] src/test/savedProfileUi.test.ts passes `hasKey`**
- Its two tests build the deps by hand, so they name `hasKey: async () => true` (its profile is local-only, whose key is optional).
- **Commit:** 3cf3f63

---

**Total deviations:** 4 (2 behaviour fixes inside the plan's own scope, 1 test setup, 1 test shape). **Impact:** no change of scope.

## Issues Encountered

None blocking. Note for 61-35: the saved-profile list is still shared across everything using this VS Code's global state, so on a shared code-server another person's entries are listed here (they would show as unavailable, since their keys are not in this browser). Hiding them is 61-35's task, and the check this plan added is what it will use.

## Commits that do not depend on Team Mode (for the 0.4.16 cherry-pick, owner decision C)

All six commits touch only files that also exist on `main`, with these three exceptions, and none of them needs a Team Mode module:

- `src/test/savedProfileUi.test.ts` (touched by `3cf3f63`) exists only on this branch; on main the file does not exist, so that commit's 3-line edit there is dropped.
- `.planning/phases/61-.../deferred-items.md` (touched by `5ff10db`) is branch-only planning; it is dropped for main and the planning note stays here.
- Everything else (`src/services/profileStore.ts`, `src/services/profileIndex.ts`, `src/extension.ts`, `README.md`, the three test files that main has) applies with the ordinary merge, and `isTeamProfileId` already exists on main.

Order to cherry-pick onto a branch from `main`: `4ca5416`, `3cf3f63`, `1bb060b`, `5ff10db`, `1822f62`, `87f3d04`. A dry run in a throwaway worktree at `origin/main` (`eb83319`) showed: `4ca5416` and `1822f62` apply clean; `3cf3f63` conflicts only on the branch-only `src/test/savedProfileUi.test.ts`, where taking main's side (file absent) and dropping that hunk resolves it; `1bb060b` conflicts only on the import line of `src/test/profileIndex.test.ts` (main adds `writeFile`, this plan adds `rename`; keep both); `5ff10db` conflicts on the branch-only `deferred-items.md` (drop it) plus `src/services/profileStore.ts` and `src/test/profileStore.test.ts` (both sides added lines in the same regions; main's PR #14 test for a reused profile pointed at another address must stay alongside the new tests); `87f3d04` conflicts only on the `src/extension.ts` import region, where main's import list differs. No production logic differs.
