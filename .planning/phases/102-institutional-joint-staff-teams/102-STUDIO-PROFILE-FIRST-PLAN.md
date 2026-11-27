---
phase: 102-institutional-joint-staff-teams
plan: studio-profile-first
wave: 2
status: draft
type: execute
autonomous: false
depends_on: ["studio-setup", "studio-lang-01", "20261127-staff-section-selection"]
requirements: []
files_modified:
  - src/domain/staff/profiles.ts
  - src/services/staffSetup.ts
  - src/services/staffSetupCommand.ts
  - src/services/staffTeams.ts
  - src/services/teamStudioStaffSetup.ts
  - src/services/teamStudioPanel.ts
  - media/teams/teams.js
  - media/teams/teams.css
  - src/test/staffDoctrine.test.ts
  - src/test/staffSetup.test.ts
  - src/test/staffTeamLinkage.test.ts
  - src/test/teamStudioPage.test.ts
  - workbench/test/e2e/get-started.spec.ts
must_haves:
  truths:
    - "A Team Studio user reviews the host-selected project, doctrine and national terms, then organizational level before choosing a section."
    - "Organizational level L4 through L0 is distinct from the existing strategic, operational and tactical planning process setting."
    - "The preview uses neutral function labels until scope selection and offers only evidence-backed setup compatibility."
    - "The host binds reviewed scope, project identity and current bytes to each explicitly confirmed section. Legacy links survive reads, cancellation and refusal."
  artifacts:
    - path: src/services/teamStudioStaffSetup.ts
      provides: host-owned project, profile and organizational-level chooser state
    - path: src/domain/staff/profiles.ts
      provides: independent organizational-level type and guarded staff settings round trip
    - path: workbench/test/e2e/get-started.spec.ts
      provides: native bundled Team Studio bilingual acceptance
  key_links:
    - from: media/teams/teams.js
      to: src/services/teamStudioStaffSetup.ts
      via: validated host-issued chooser revision and reported compatibility
    - from: src/services/teamStudioStaffSetup.ts
      to: src/services/staffSetupCommand.ts
      via: a single-use reviewed project and organizational selection through the existing section handoff
---

# Choose the staff profile and organizational level first

<objective>
Turn the verified selectable-sections checklist into profile-first setup. A user picks the project, doctrine and national terms, then the organization's level. Team Studio shows the corresponding section names and supported setup actions and retains its final per-section review. Reuse the existing templates and prepare no new role, tool, source, or agent execution in this plan.
</objective>

<context>
Start from the verified selectable-sections source `b9506ce45` and summary `5f1750469`. Use the exact steering addendum `81f5d4098` from `docs/team-studio-section-delivery` and the checked [tier crosswalk](102-JOINT-TIER-CROSSWALK.md) and [coverage table](102-DUTY-COVERAGE.md#profile-and-level-coverage). The steering commit is a reference on a separate branch. Do not merge it into this base to begin the work.

`StaffSettings.level` and `STAFF_LEVELS` select planning process. `sectionCode` defaults to the higher process prefix. `templateOffers` proves `(profile, planning level, nation)` only, and tactical J2 is the only current setup question with explicit brigade and battalion variants. None of those facts establishes every organizational level or applies to all nations. `staffSetupCommand.ts` currently prompts after selecting the template, while `teamStudioStaffSetup.ts` guesses a J code without saved staff settings. `projectStaffTeams` and `linkStaffTeam` are legacy linkage callers. The latter uses filename candidates and the strict `staffSettingsJson` round-trip. Keep that path in the compatibility review.
</context>

<tasks>
<task type="tracer" tdd="true">
  <name>Choose profile and organizational level on the existing checklist</name>
  <files>src/domain/staff/profiles.ts, src/services/teamStudioStaffSetup.ts, src/services/teamStudioPanel.ts, media/teams/teams.js, media/teams/teams.css, src/test/staffDoctrine.test.ts, src/test/teamStudioPage.test.ts</files>
  <read_first>Read the exact steering addendum, country/echelon crosswalk, current preview session and native folder picker, locale observer, checklist focus and message parser. Review the existing planning profile and nation combinations.</read_first>
  <action>
    Add a distinct organization-level union for L4 unit, L3 brigade, L2 division, L1 joint headquarters and L0 strategic joint headquarters. Reuse the existing US Army, US Joint and NATO/Canadian profiles and the latter's explicit CA or NATO national setting. Show the organization choices in the single existing checklist after picking the project and profile/national terms. List neutral functions before both choices are verified. A saved planning level or team slug can inform a legacy note only. It cannot preselect an organizational level. A previously confirmed organizational scope may be shown as the current scope and reused explicitly.

    Encode only reviewed profile-specific designations. Use the crosswalk's confirmed S family for applicable unit offices, Canadian G and US Army S at brigade, G for the applicable division profile, and distinct L1/L0 IDs where both have a J family. Use exact profile spelling where substantiated. Where NATO or a national charter assigns a named, combined or optional office and no binding exists, show its functional label and the coverage reason. Show missing levels as selectable for coverage or unavailable with a reason. Never infer an organization code from planning level, pick a nation silently, use a default prefix, or render an office name as an appointment. A prefix alone cannot authorize a template.

    Extend the existing host message state from project ready to profile/nation ready to organization scope ready to section review. Handle `request` and opaque host-issued session/revision already used by the bridge. Accept only the host-offered enum IDs in exact shapes and reject any workspace path, team ID, approved-office claim or template override from the webview. Rotate the selection review before another scope can authorize a section. Discard earlier native picker responses and any queued sections when scope changes. On back, reset focus to the field the user can act on. Escape, close, reopen, folder changes including remove/readd, same-path substitution and out-of-order messages invalidate prior sessions. Retain en-CA/fr-CA labels and selection across a language switch. Use existing cards and one checklist. Author no setup or file write from this task.
  </action>
  <verify><automated>Write host and DOM tests first for neutral before selection, the five levels, Canadian G versus US Army S at brigade, unit and division where supported, and separate L1/L0 scope when the designation is J. Cover named/optional/unmapped offices without an offer, switching profile/nation or project, cancel, stale and forged messages, and locale switch without losing selected scope or keyboard position.</automated><fails_when>A default code or old planning level implies an organizational level, unsupported scope implies eligibility, obsolete scope can authorize a selection, or the workflow cannot be completed with a keyboard in either language.</fails_when></verify>
  <done>Real current Team Studio exposes the profile-first coverage path with host-bound scope. No new section setup authority is introduced.</done>
</task>

<task type="auto" tdd="true">
  <name>Bind eligible section setup to the reviewed organizational choice</name>
  <files>src/domain/staff/profiles.ts, src/services/staffSetup.ts, src/services/staffSetupCommand.ts, src/services/staffTeams.ts, src/services/teamStudioStaffSetup.ts, src/services/teamStudioPanel.ts, src/test/staffDoctrine.test.ts, src/test/staffSetup.test.ts, src/test/staffTeamLinkage.test.ts, src/test/teamStudioPage.test.ts</files>
  <read_first>Confirm exact template option evidence, profile/project settings read and write, library target guard, unverified-link repair and each existing setup/link caller. The registry stays at its exact base.</read_first>
  <action>
    Intersect current `templateOffers` with an independently reviewed, explicit section/profile/nation/organization mapping and existing exact local setup evidence. Record the supporting source and rendered configuration for each eligible row. The known tactical J2 battalion/brigade options can inform that review, but a legacy filename, a shared J prefix, or one successful generic render proves no organization compatibility. Leave any unproven pairing in coverage with a reason. Keep a valid existing link visible as coverage even when the new pairing is unverified. Do not add or expand a template, role, model route or assignment. Before opening any new native setup action, verify an existing compatible pair on the exact implementation base. If no such pairing can support a positive administrative setup case, ship the chooser as read-only coverage and record that narrow dependency. Do not manufacture an enablement example.

    Pass profile, explicit nation, organizational level and allowed planning options from the host session to `setUpStaffTeam`. Do not ask again for already confirmed choices or accept them through `requestedSection`. Keep legacy `StaffSettings.level` separate and explicitly review any planning choice the compatible template still needs. Confirm project, profile/nation, organizational level, section, distinct planning level if needed, and expected changes before running the existing guarded writer. Recheck physical identity, exact source bytes, current session revision and compatibility before review and commit. Preserve exact team target, one-use handoff, cancellation, project snapshot and rollback. A same tuple after a change does not revive an old session. After a successful write, re-read the project and issue a fresh handoff for the remaining checklist selections.

    Accept an optional independent `staff.organizationLevel` only if it can round-trip through `parseStaffSettings` and `staffSettingsJson` and survive all existing writers. Introduce no inferred value in older projects. Write the first value only in the same positive per-section transaction as an explicitly reviewed compatible setup, with no settings write from preview or cancel. Preserve unrelated project keys, planning level semantics, horizons, phases, and all prior link values. When an unbound legacy project already has links, require exact compatibility evidence for those existing links before setting organization level or adding a role. Otherwise hold the update and keep the links readable. A previously missing exact linked team can still follow the existing legacy repair, bound to the same profile and name with explicit review and no migration. Changing a saved profile, nation or organization with current links is preview-only in this slice. Keep link remapping out of scope.

    Check every existing setup or linking route before permitting persistent scope, including native command, Chat/Staff Room shortcuts and `linkStaffTeam`. Keep old callers' existing behavior on legacy projects while showing the appropriate scope or link check when a project has an explicit organization. A legacy caller may not silently rewrite or add a link across that scope. Reuse the project-bounded review or hold with a return to Team Studio. Keep existing links and their entry points readable. File ownership is sequential here because the host handoff and setup writer share the exact review contract. Independent future J1/J6/J7/J8/J9 draft authors own their content only and must integrate the shared registry/schema in a later reviewed phase.
  </action>
  <verify><automated>With fictional inputs, add regressions for an eligible exact scope reaching one ordinary native confirmation, a matching legacy missing-link repair, preserving legacy exact links through cancel/hold, schema round trip, explicit scope and default/unknown preservation, and refusing scope, directory or config changes after confirmation opens. Cover an inapplicable direct command/link call, same designation but wrong organization, shared target collision and late failure using existing focused setup and linkage checks. Control cases may use an inert harness. Run no team, model or provider.</automated><fails_when>Any unsupported setup starts, persisted scope can be inferred or changed through a bypass, a legacy link is replaced or relabeled without evidence, or a cancelled or stale review causes a write.</fails_when></verify>
  <done>Existing eligible section setup carries the reviewed scope to its current confirmation/write path. Coverage and independent dependency evidence remain explicit for unsupported pairs.</done>
</task>

<task type="auto" tdd="true">
  <name>Verify the profile-first flow in the actual bundled Workbench</name>
  <files>workbench/test/e2e/get-started.spec.ts</files>
  <read_first>Use the existing release-only Team Studio scenario in `get-started.spec.ts`, the live Canadian English/French User locale bridge and the repository's exact Workbench packaging and disposable browser run. Coordinate the single capped job.</read_first>
  <action>
    Update that scenario for the selectable-sections base, which still carries old complete-staff browser selectors. Use the exact built candidate bundled into an isolated Workbench and synthetic project settings and library files. Exercise project, doctrine/nation, level, the neutral view before selection and one selected appropriate designation after selection. Verify L1 and L0 are distinct even if both use J, and coverage honestly explains an unsupported row. Exercise switching scope and languages in place on desktop and 510px, retaining selected scope and focusing the right control. Reach one existing compatible native roster review if Task 2 establishes a pair, then cancel and assert no changes to the project JSON or team-library fixture. Where no compatible pair is evidenced, verify the real hold and mark setup acceptance open. The browser run uses the normal host; no test-only UI route, live source, agent turn or provider call.
  </action>
  <verify>
    <automated>set -e; mkdir -p "$PWD/.scratch"; phase_tmp=$(mktemp -d "$PWD/.scratch/studio-profile-first.XXXXXX"); flock -o /home/aaron/.cache/claude-code-tmp/heavy.lock systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 1500 env NODE_OPTIONS=--max-old-space-size=1536 TMPDIR="$phase_tmp" PATH="/home/aaron/.nvm/versions/node/v24.22.3/bin:$PATH" bash -c 'npm run compile && node scripts/run-tests.mjs dist/test/staffDoctrine.test.js dist/test/staffSetup.test.js dist/test/staffTeamLinkage.test.js dist/test/teamStudioPage.test.js dist/test/copyLint.test.js dist/test/architecture.test.js'</automated>
    <automated>set -e; mkdir -p "$PWD/.scratch"; browser_tmp=$(mktemp -d "$PWD/.scratch/studio-profile-browser.XXXXXX"); cd workbench &amp;&amp; flock -o /home/aaron/.cache/claude-code-tmp/heavy.lock systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 1500 env NODE_OPTIONS=--max-old-space-size=1536 TMPDIR="$browser_tmp" PATH="/home/aaron/.nvm/versions/node/v26.13.1/bin:$PATH" STERLING_BUNDLED_EXTENSION=1 WORKBENCH_URL="$phase_workbench_url" ./node_modules/.bin/playwright test -c test/e2e/playwright.config.ts get-started.spec.ts -g 'Team Studio staff setup previews the selected project'</automated>
    <fails_when>The exact bundled case does not record a real pass, the localized controls or restored focus are inaccessible, or a preview/cancellation changes on-disk state.</fails_when>
  </verify>
  <done>Record exact source, VSIX hash, isolated Workbench run, both languages and whether a compatible current setup is available. Keep coverage claims within the evidence.</done>
</task>
</tasks>

## Open conditions

- G17 and G62 remain open for live authority, sources and confinement. G561 remains open for qualified Canadian French copy review and broader parity.
- New staff templates and actual agent work depend on the separately verified shared restricted draft route and per-profile/echelon acceptance. Whole-staff Apply retains its own transaction and authorization. Unmapped offices and levels stay in coverage.
