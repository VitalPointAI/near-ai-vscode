---
phase: 102-institutional-joint-staff-teams
plan: studio-lang-01
type: execute
wave: 11
depends_on: ["102-STUDIO-SETUP", "46-LANG-01"]
files_modified:
  - workbench/extension/src/browser/sterling-locale.ts
  - workbench/extension/src/browser/sterling-locale-module.ts
  - workbench/extension/package.json
  - src/extension.ts
  - src/services/teamStudioPanel.ts
  - src/services/teamStudioStaffSetup.ts
  - src/services/staffSetupCommand.ts
  - media/teams/teams.js
  - src/test/teamStudioPage.test.ts
  - src/test/staffSetup.test.ts
  - workbench/test/e2e/get-started.spec.ts
autonomous: true
requirements: [LANG-01]
user_setup: []
must_haves:
  truths:
    - Canadian English and Canadian French in the Studio staff setup follow the existing persistent User Settings preference.
    - Switching language preserves the current project, selected section, preview, confirmation state and focus.
    - User-owned project and team names remain exactly as saved, and later user confirmation still guards every write.
  artifacts:
    - path: src/services/teamStudioStaffSetup.ts
      provides: Host-owned locale and project-safe display status
    - path: media/teams/teams.js
      provides: Bilingual accessible staff preview using the same session
    - path: workbench/test/e2e/get-started.spec.ts
      provides: Bundled browser proof of a live preference change
  key_links:
    - from: workbench/extension/src/browser/sterling-locale.ts
      to: src/services/teamStudioPanel.ts
      via: Packaged-proven raw User events or a dedicated native application-lifetime locale bridge
---

# Canadian English and French in Team Studio staff setup

<objective>
Let a person review or continue the Team Studio staff setup in either supported Canadian language. Keep the current project, content and setup decision intact when the display language changes.
</objective>

<context>
@.planning/REQUIREMENTS.md
@.planning/phases/102-institutional-joint-staff-teams/102-STAFF-SETUP-UI-SPEC.md
@.planning/phases/102-institutional-joint-staff-teams/102-STUDIO-SETUP-SUMMARY.md
@.planning/phases/46-native-theia-foundation/46-LANG-01-SUMMARY.md
@workbench/extension/src/browser/sterling-locale.ts
@src/services/teamStudioPanel.ts
@src/services/teamStudioStaffSetup.ts
@src/services/staffSetupCommand.ts
@media/teams/teams.js

The native Canadian locale preference is on main. Execute on a locally combined tree with the verified Studio setup or its exact landed equivalent. Keep this follow-up out of the earlier Studio delivery candidate. The extension host's preference registry uses the aggregate preference event, which can miss user-only changes shadowed by a hand-edited workspace value. The native Workbench reads the raw User provider. Use the packaged test to determine whether the existing host configuration can cover this case.
</context>

<tasks>

<task type="tracer" tdd="true">
  <name>Switch the live Studio staff chooser using the existing Canadian language control</name>
  <files>workbench/extension/src/browser/sterling-locale.ts, workbench/extension/src/browser/sterling-locale-module.ts, workbench/extension/package.json, src/extension.ts, src/services/teamStudioPanel.ts, src/services/teamStudioStaffSetup.ts, src/services/staffSetupCommand.ts, media/teams/teams.js, src/test/teamStudioPage.test.ts, src/test/staffSetup.test.ts, workbench/test/e2e/get-started.spec.ts</files>
  <read_first>Inspect how Workbench User Settings reaches the plugin host, how a current preview and confirmation hold their single-use project scope, and the existing private bundled Studio browser case.</read_first>
  <action>
    First extend the existing browser and host tests to switch the actual shared User setting while a project preview and selected section are open, then switch back. An existing workspace value must be unable to choose or block the User language. Verify accessible text, focus and section selection after each update, no duplicate host request, and cancellation restoring the original focus. Exercise any pending async preview selection so a locale change cannot revive an obsolete picker or start a write.

    Keep one language control. Use the existing host configuration route if the packaged tests establish equivalent raw-user behavior. Otherwise bind a dedicated singleton command and frontend application contribution in `sterling-locale-module.ts` and register that module in `workbench/extension/package.json`. Start the existing raw User preference observer at frontend startup and dispose it on stop. The contribution owns the latest validated locale and registers an internal read command that waits for the first raw User read when the providers are ready. It asks the extension host to refresh after each distinct observed change. Register that refresh handler in `src/extension.ts` at activation and read the locale through the native command on activation or opening a Studio panel to cover late registration and missed initial notifications. The refresh receives no preference values or project identifiers. Accept only `en-CA` or `fr-CA` from the native read, ignore stale async results after a newer refresh or panel disposal, and release panel subscriptions on disposal. Missing native commands leave other hosts on the documented fallback. Do not depend on Welcome or About having been opened. Keep English as the documented fallback for unsupported or unavailable values. Do not use user or workspace locale data as a policy or routing input. Do not create a parallel persisted setting, key, file, or translation service.

    Localize the Studio staff entry, chooser, read-only coverage and statuses, keyboard announcements, Studio-specific editor handoff labels, project confirmation, held and cancelled guidance and completion actions. Use stable semantic row state and section codes so a text translation cannot change offered IDs or action routing. Preserve canonical project, team and file names and the accepted staff classifications and slugs in storage. Keep existing shared helpers and ordinary non-Studio behavior. Capture the current display language for the editor picker when it opens, then use the most recent language for subsequent steps. Do not dismiss a live picker or change a decision because the preference changes. Changes in language update presentation only.

    Keep the Studio theme and full keyboard flow. Use the exact project and host-bound session for the final confirmation. Keep complete-staff preview read-only. Mark working Canadian French copy for qualified review before claiming complete localization.
  </action>
  <verify>
    <automated>npm run compile && node --test dist/test/teamStudioPage.test.js dist/test/staffSetup.test.js dist/test/copyLint.test.js dist/test/architecture.test.js</automated>
    Run the existing focused commands under the shared cap and an exact disposable bundled Workbench. Extend the existing Team Studio setup case to require a real passing live locale change, without using a webview-only setting shim. Verify that Studio starts in persisted French in a fresh app session with a shadowing workspace value, without opening Welcome or About, and then follows live User changes. Verify normal English fallback and retention of project context after French. Record one real pass with zero skips for the bundled case.
    <fails_when>A workspace overrides User Settings, a live preference change loses the session or its chosen section, an action targets a different project, accessible state is lost, or packaged verification skips the locale change.</fails_when>
  </verify>
  <done>One real setup surface supports both languages on the same scoped project. The exact browser result and professional review condition appear in the phase summary.</done>
</task>

</tasks>
