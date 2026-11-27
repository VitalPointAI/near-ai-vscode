---
phase: 46-native-theia-foundation
plan: "lang-01"
type: execute
wave: 2
depends_on: ["46-ABOUT"]
files_modified:
  - workbench/extension/src/browser/sterling-locale.ts
  - workbench/extension/src/browser/sterling-welcome-module.ts
  - workbench/extension/src/browser/sterling-welcome.css
  - workbench/test/e2e/get-started.spec.ts
  - workbench/test/container/get-started.test.ts
autonomous: true
requirements: [LANG-01]
user_setup: []
must_haves:
  truths:
    - The normal Workbench User Settings persists en-CA or fr-CA outside the shared project. A missing or invalid user value selects en-CA.
    - Changing the user preference updates Get Started and its entry controls in the existing browser session, preserving focus, active workspace and UI state.
    - Get Started keeps equivalent visible and accessible copy in each locale and remains usable at the narrow Workbench breakpoint.
  artifacts:
    - path: workbench/extension/src/browser/sterling-locale.ts
      provides: Typed message catalogue and Theia user preference schema for the initial journey
    - path: workbench/test/e2e/get-started.spec.ts
      provides: Existing user journey exercised through the real Settings UI, the live view and a reopen
  key_links:
    - from: workbench/extension/src/browser/sterling-welcome-module.ts
      to: workbench/extension/src/browser/sterling-locale.ts
      via: Theia PreferenceContribution, exact User reads and the raw User provider event
---

# LANG-01 · Canadian-language Get Started journey

<objective>
Let a user open Get Started, choose English (Canada) or Français (Canada) from normal User Settings, and continue in the same Workbench session. This is the first LANG-01 journey. The other LANG-01 surfaces stay separately tracked. Document and agent output language are handled by LANG-02 and LANG-03.
</objective>

<execution_context>
@/home/aaron/aspire-home/.codex/gsd-core/workflows/execute-plan.md
@/home/aaron/aspire-home/.codex/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/REQUIREMENTS.md
@.planning/research/canadian-official-languages.md
@.planning/phases/46-native-theia-foundation/46-ABOUT-PLAN.md
@workbench/package-lock.json
@docs/testing.md

Draft base `1e5cfb7ea`. Sequence implementation after the About changes to both Get Started test files have landed or been integrated into the reviewed candidate. Check the final About scope and exact integration commit before writing either shared file. The proposed wave assumes that dependency. The normal native welcome module already loads through `workbench/extension/package.json`. Keep that registration and introduce the locale code through it. Use one worktree for execution and one writer for the five files. Leave About labels, unrelated destination page copy, extension webviews, generic Theia chrome, providers, deployment and release work to their existing lanes.

The repository pins Theia 1.77.0. Inspect its installed `@theia/core/lib/common/preferences/{preference-schema,preference-scope,preference-service}.d.ts` and `@theia/preferences/lib/browser/{preferences-contribution,util/preference-types,views/components/preference-select-input}.js`. The Preferences contribution's `workbench.action.openGlobalSettings` opens the User tab. The schema's `enumItemLabels` are rendered for enum preferences. `PreferenceScope.User` is the maximum allowed scope for this setting. The user settings provider delegates `user-storage:/user` to the server's Theia configuration directory through the existing user-storage provider. Verify persistence with the normal test session's existing user storage. Recreating a disposable container with a fresh home is a separate deployment lifecycle, outside this slice. Theia's built-in Configure Display Language action reloads the window. Theia 1.77.0's aggregate preference event may omit changes behind values read from a hand-edited higher scope. The native SovAI view subscribes to the pinned User provider before reading the exact user-only value. Review the factory binding in `@theia/core/lib/browser/frontend-application-bindings.js` and `@theia/core/lib/common/preferences/preference-provider.d.ts`.
</context>

<tasks>

<task type="tracer" tdd="true">
  <name>Switch the native Get Started journey through the existing User Settings</name>
  <files>workbench/extension/src/browser/sterling-locale.ts, workbench/extension/src/browser/sterling-welcome-module.ts, workbench/extension/src/browser/sterling-welcome.css, workbench/test/e2e/get-started.spec.ts, workbench/test/container/get-started.test.ts</files>
  <read_first>Read the pinned preference files named above, the two welcome source files, both Get Started test files at the integrated About head, and `workbench/test/helpers/docker.ts`.</read_first>
  <behavior>With Get Started open in a normal Workbench, switch to French in User Settings and observe the same view in French without a reload. Reopen with French still selected, then switch to English. A user preference change does not write a shared project preference or disturb workspace content.</behavior>
  <action>
    Extend the existing Get Started browser coverage before production edits. Start with the ordinary English view. Open User Settings through the command palette, search the setting, and select Français (Canada) with the keyboard through the rendered enum control. Verify the translated Get Started heading or tab, a visible call to action, one accessible control label and the localized region's `lang`, including upon return from Settings. Show the same document and Get Started widget are alive during the change, and that keyboard focus remains on the active settings control until the user deliberately leaves it. Reopen on the same disposable Workbench and re-check French from a fresh browser context, then switch back to English and confirm normal navigation. Require the first RED to reach the settings surface and fail on the missing behavior. Reuse the suite's isolated workspace. Seed an opposite or stale `sterling.displayLanguage` value in the disposable workspace's existing `.theia/settings.json` before opening the app. Keep that user-only key present in the shared file during both same-session transitions and after reopen. Assert that neither initial state nor live changes follow the shared value, and compare the shared file bytes before and after the journey. Use a stable existing fixture file and add no production hook or setting bridge for the test. Keep the About case and remaining assertions as integrated. If extending a current test keeps its state easy to follow, keep the test count and harness assertions. A separate case is justified only if it isolates this user preference journey from existing setup or plugin state.

    Register one `PreferenceContribution` with the existing welcome DI module. Add `sterling.displayLanguage` as a string enum of `en-CA` and `fr-CA`, with `enumItemLabels` of `English (Canada)` and `Français (Canada)`, default `en-CA`, `scope: PreferenceScope.User`, and language overrides disabled. Make its settings description searchable in either language. Use the pinned `PreferenceContribution`, `PreferenceSchema`, `PreferenceScope` and injected `PreferenceService` from `@theia/core/lib/common/preferences/index.js`. Resolve the pinned `PreferenceProviderProvider` binding for `PreferenceScope.User`. Observe its raw `onDidPreferencesChanged` batches for the locale key and await provider and service readiness for the initial value. Re-read `inspectInScope(name, PreferenceScope.User)` for each applied refresh. Dispose the listener with the view and leave ownership of the shared provider with Theia. Accept exactly the two codes and default to Canadian English for unset or invalid input. The native Settings enum already writes its selected value via the current scoped preference handler. If a shortcut is needed for discoverability, link to that same User Settings command and keep a single writer. Keep preference resolution independent of folder, workspace, organization and session overrides. A failed preference write leaves the prior applied language visible through the normal Settings error behavior.

    Keep one typed set of keys and complete paired maps. Use existing English copy as the baseline and provide reviewed Canadian French for the chosen view, its tab and shell entry. Translate the app-owned Get Started headings, edition label, instructions, work-area cards, actions, empty or failure text, active-area prefix, motion control, tooltips and accessibility names. Keep stable widget and command IDs, the SovAI mark and authored workspace titles intact. Apply `lang` to the localized view and its app-owned entry labels as applicable. Use a safe text update on mounted controls, along with attribute or widget-title updates. Preserve the existing control nodes, focus, active project display, motion state, opened view and selected rail state. Keep status and loading messages in the currently selected locale if their async action finishes after a switch. Preserve the current theme and visual hierarchy. Check both languages at the ordinary desktop width and one supported narrow width with keyboard focus visible, long labels wrapping, no clipped controls or sideways page scrolling, and the existing reduced-motion behavior. Modify the existing CSS only where the real French view demonstrates a layout issue.
  </action>
  <verify>
    <automated>phase_tmp=$(mktemp -d) && flock -o /home/aaron/.cache/claude-code-tmp/heavy.lock systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env PATH="/home/aaron/.nvm/versions/node/v26.13.1/bin:$PATH" NODE_OPTIONS=--max-old-space-size=1536 TMPDIR="$phase_tmp" npm --prefix workbench run lint</automated>
    Run the existing container acceptance harness on the exact reviewed source with an authorized immutable candidate image and existing pinned Chromium. Set `WORKBENCH_TEST_IMAGE` explicitly to avoid the harness's implicit build. Under the same shared cap, from `workbench`, run `node scripts/build.mjs` and `node ../scripts/run-tests.mjs --test-concurrency=1 dist/test/container/get-started.test.js` as one focused verification job. Use the existing suite-owned resources. Record meaningful RED, passing focused workflow, exact source and image identities, and any unavailable packaged verification or Canadian French copy review. Leave the applicable CI gate and broad suite to the normal integration boundary.
    <fails_when>The normal Settings control is absent or writes to a shared scope, the locale falls back after reconnecting to the same Workbench, switching triggers a reload or loses focus or project state, or the localized navigation and accessibility text is incomplete. A missing browser/image is unverified evidence.</fails_when>
  </verify>
  <done>One normal Workbench user journey is accessible and complete in both locales and persists through the existing user settings. Project data and policy stay unchanged.</done>
</task>

</tasks>

<verification>
Independently check the integrated About dependency, pinned preference API and real Settings-to-view behavior before implementation. Verify that the summary records the draft base, actual integration head, changed scope, exact test evidence and any open conditions. LANG-01 remains open for the remaining product surfaces.
</verification>
