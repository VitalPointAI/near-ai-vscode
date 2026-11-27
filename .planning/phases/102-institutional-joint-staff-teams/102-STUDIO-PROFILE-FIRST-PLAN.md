---
phase: 102-institutional-joint-staff-teams
plan: studio-profile-first
wave: 12
status: draft
type: execute
autonomous: false
depends_on: ["102-STUDIO-SETUP", "102-STUDIO-LANG-01"]
requirements: []
files_modified:
  - src/domain/staff/profiles.ts
  - src/services/teamStudioStaffSetup.ts
  - src/services/teamStudioPanel.ts
  - media/teams/teams.js
  - media/teams/teams.css
  - src/test/staffDoctrine.test.ts
  - src/test/teamStudioPage.test.ts
  - workbench/test/e2e/get-started.spec.ts
must_haves:
  truths:
    - "A Team Studio user reviews the host-selected project, doctrine and national terms, then organizational level before choosing a section."
    - "Organizational level L4 through L0 is distinct from the existing strategic, operational and tactical planning process setting."
    - "The chooser lets the user inspect each of L4, L3, L2, L1 and L0 for the selected profile even where setup is unavailable."
    - "The read-only preview uses neutral function labels until scope selection. It distinguishes known designations, unsupported mappings and existing legacy links."
  artifacts:
    - path: src/services/teamStudioStaffSetup.ts
      provides: host-owned project, profile and organizational-level chooser state
    - path: src/domain/staff/profiles.ts
      provides: independent organizational-level type and reviewed optional display mapping
    - path: workbench/test/e2e/get-started.spec.ts
      provides: native bundled Team Studio bilingual acceptance
  key_links:
    - from: media/teams/teams.js
      to: src/services/teamStudioStaffSetup.ts
      via: validated host-issued chooser revision and reported compatibility
---

# Choose the staff profile and organizational level first

<objective>
Deliver the read-only profile-first chooser and designation mapping on the verified selectable-sections checklist. Users select the project, doctrine and national terms, then inspect any organizational level and its section coverage. This plan completes the chooser only. It neither proves organizationally bound setup nor modifies templates or links. The separate [setup draft](102-STUDIO-PROFILE-BOUND-SETUP-DRAFT.md) owns the positive create and reopen path.
</objective>

<context>
Start from the verified selectable-sections source `b9506ce45` and summary `5f1750469`. Use the exact steering addendum `81f5d4098` from `docs/team-studio-section-delivery` and the checked [tier crosswalk](102-JOINT-TIER-CROSSWALK.md) and [coverage table](102-DUTY-COVERAGE.md#profile-and-level-coverage). Require the selectable-sections quick summary on the execution base, in addition to the two phase dependencies. The steering commit is a reference on a separate branch. Do not merge it into this base to begin the work.

`StaffSettings.level` and `STAFF_LEVELS` select planning process. `sectionCode` defaults to the higher process prefix. `templateOffers` proves `(profile, planning level, nation)` only, and tactical J2 is the only current setup question with explicit brigade and battalion variants. None of those facts establishes every organizational level or applies to all nations. `staffSetupCommand.ts` currently prompts after selecting the template, while `teamStudioStaffSetup.ts` guesses a J code without saved staff settings. `projectStaffTeams` and `linkStaffTeam` are legacy linkage callers. The latter uses filename candidates and the strict `staffSettingsJson` round-trip. Keep that path in the compatibility review.
</context>

<tasks>
<task type="tracer" tdd="true">
  <name>Choose profile and organizational level on the existing checklist</name>
  <files>src/domain/staff/profiles.ts, src/services/teamStudioStaffSetup.ts, src/services/teamStudioPanel.ts, media/teams/teams.js, media/teams/teams.css, src/test/staffDoctrine.test.ts, src/test/teamStudioPage.test.ts</files>
  <read_first>Read the exact steering addendum, country/echelon crosswalk, current preview session and native folder picker, locale observer, checklist focus and message parser. Review the existing planning profile and nation combinations.</read_first>
  <action>
    Add a distinct organization-level union for L4 unit, L3 brigade, L2 division, L1 joint headquarters and L0 strategic joint headquarters. Reuse the existing US Army, US Joint and NATO/Canadian profiles and the latter's explicit CA or NATO national setting. Show all five organization choices in the single existing checklist after picking the project and profile/national terms. Each stays selectable for inspection, even when no section or office can be set up for that profile and level. List neutral functions before both choices are verified. A saved planning level or team slug can inform a legacy note only. It cannot preselect an organizational level. Keep the scope in the current host session. Opening or cancelling the preview does not persist it.

    Encode only reviewed profile-specific designations. Use the crosswalk's confirmed S family for applicable unit offices, Canadian G and US Army S at brigade, G for the applicable division profile, and distinct L1/L0 IDs where both have a J family. Use exact profile spelling where substantiated. Where NATO or a national charter assigns a named, combined or optional office and no binding exists, show its functional label and the coverage reason. For an unmapped level or office, show the reason in coverage after selection. A missing mapping never disables selecting a level to inspect it. Never infer an organization code from planning level, pick a nation silently, use a default prefix, or render an office name as an appointment. A prefix alone cannot authorize a template.

    Extend the existing host message state from project ready to profile/nation ready to organization scope ready to section coverage. Existing authorized callers outside this preview retain their legacy path. In this preview, show existing links in a clearly labelled legacy state and explain unresolved rendered identity. No new continue, create, attach or repair action follows an organizational selection until the guarded setup slice is verified. Handle `request` and opaque host-issued session/revision already used by the bridge. Accept only the host-offered enum IDs in exact shapes and reject any workspace path, team ID, approved-office claim or template override from the webview. Rotate the selection review before another scope can authorize a section. Discard earlier native picker responses and any queued sections when scope changes. On back, reset focus to the field the user can act on. Escape, close, reopen, folder changes including remove/readd, same-path substitution and out-of-order messages invalidate prior sessions. Retain en-CA/fr-CA labels and selection across a language switch. Use existing cards and one checklist. Author no setup or file write from this task.
  </action>
  <verify><automated>Write host and DOM tests first for neutral before selection, all five levels independently selectable, Canadian G versus US Army S at brigade, and unit and division where supported. Exercise L1 and L0 separately for the same profile, assert separate selection and coverage, and reject an L1 message after changing to L0 even where both show J. Cover named/optional/unmapped offices without an offer, switching profile/nation or project, cancel, stale and forged messages, and locale switch without losing selected scope or keyboard position.</automated><fails_when>A default code or old planning level implies an organizational level, unsupported scope implies eligibility, obsolete scope can authorize a selection, or the workflow cannot be completed with a keyboard in either language.</fails_when></verify>
  <done>Real current Team Studio exposes the profile-first coverage path with host-bound scope. No new section setup authority is introduced.</done>
</task>

<task type="auto" tdd="true">
  <name>Verify the profile-first flow in the actual bundled Workbench</name>
  <files>workbench/test/e2e/get-started.spec.ts</files>
  <read_first>Use the existing release-only Team Studio scenario in `get-started.spec.ts`, the live Canadian English/French User locale bridge and the repository's exact Workbench packaging and disposable browser run. Coordinate the single capped job.</read_first>
  <action>
    Update that scenario for the selectable-sections base, which still carries old complete-staff browser selectors. Use the exact built candidate bundled into an isolated Workbench and synthetic project settings and library files. Exercise project, doctrine/nation, level, the neutral view before selection and one selected appropriate designation after selection. Select L1 and L0 separately under the same profile, check each visible level and coverage state, then return to L1 and verify L0 selection does not leak into it. Verify the real no-setup state for an unsupported section. Exercise switching scope and languages in place on desktop and at 510px, retaining selected scope and focusing the right control. Cancel and reopen, then compare the project JSON and team-library fixture against the original bytes. This browser case uses the normal host and certifies chooser and coverage only.
  </action>
  <verify>
    <automated>set -e; mkdir -p "$PWD/.scratch"; phase_tmp=$(mktemp -d "$PWD/.scratch/studio-profile-first.XXXXXX"); flock -o /home/aaron/.cache/claude-code-tmp/heavy.lock systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 1500 env NODE_OPTIONS=--max-old-space-size=1536 TMPDIR="$phase_tmp" PATH="/home/aaron/.nvm/versions/node/v24.22.3/bin:$PATH" bash -c 'npm run compile && node scripts/run-tests.mjs dist/test/staffDoctrine.test.js dist/test/staffSetup.test.js dist/test/staffTeamLinkage.test.js dist/test/teamStudioPage.test.js dist/test/copyLint.test.js dist/test/architecture.test.js'</automated>
    <automated>set -e; mkdir -p "$PWD/.scratch"; browser_tmp=$(mktemp -d "$PWD/.scratch/studio-profile-browser.XXXXXX"); cd workbench &amp;&amp; flock -o /home/aaron/.cache/claude-code-tmp/heavy.lock systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 1500 env NODE_OPTIONS=--max-old-space-size=1536 TMPDIR="$browser_tmp" PATH="/home/aaron/.nvm/versions/node/v26.13.1/bin:$PATH" STERLING_BUNDLED_EXTENSION=1 WORKBENCH_URL="$phase_workbench_url" ./node_modules/.bin/playwright test -c test/e2e/playwright.config.ts get-started.spec.ts -g 'Team Studio staff setup previews the selected project'</automated>
    <fails_when>The exact bundled case does not record a real pass, the localized controls or restored focus are inaccessible, or a preview/cancellation changes on-disk state.</fails_when>
  </verify>
  <done>Record exact source, VSIX hash, isolated Workbench run, both languages and independent L1/L0 results. Mark the chooser verified and profile-bound setup awaiting its separate acceptance.</done>
</task>
</tasks>

## Open conditions

- G17 and G62 remain open for live authority, sources and confinement. G561 remains open for qualified Canadian French copy review and broader parity.
- Profile-bound setup waits on the separate positive create/reopen draft and its confined shared runtime and template prerequisites. New workflows require their own profile/echelon acceptance. Whole-staff Apply retains its own transaction and authorization. Unmapped offices and levels stay in coverage.
