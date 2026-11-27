---
phase: 46-native-theia-foundation
plan: "lang-01-about"
type: execute
wave: 3
depends_on: ["46-ABOUT", "46-LANG-01"]
files_modified:
  - workbench/extension/src/browser/sterling-about-module.ts
  - workbench/extension/src/browser/sterling-locale.ts
  - workbench/test/e2e/get-started.spec.ts
autonomous: true
requirements: [LANG-01]
user_setup: []
must_haves:
  truths:
    - Native Manage and the command palette offer one About command in the applied Canadian locale when opened.
    - The About dialog has the same version and dismissal behavior in both languages, including when the version is unavailable.
    - The current User setting controls About as well as Get Started without reload.
  artifacts:
    - path: workbench/extension/src/browser/sterling-about-module.ts
      provides: Locale-aware native About command label and dialog
    - path: workbench/test/e2e/get-started.spec.ts
      provides: Coverage through ordinary User Settings, Manage and command palette
  key_links:
    - from: workbench/extension/src/browser/sterling-about-module.ts
      to: workbench/extension/src/browser/sterling-locale.ts
      via: The existing User-scope locale observer and message catalogue
---

# LANG-01 · Canadian-language About SovAI

<objective>
Use the same Canadian display preference for About SovAI and Get Started. Preserve the running version, keyboard controls and focus.
</objective>

<execution_context>
@/home/aaron/aspire-home/.codex/gsd-core/workflows/execute-plan.md
@/home/aaron/aspire-home/.codex/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/phases/46-native-theia-foundation/46-ABOUT-SUMMARY.md
@.planning/phases/46-native-theia-foundation/46-LANG-01-SUMMARY.md
@workbench/package-lock.json
@docs/testing.md

The locally verified combined base is `9f8cf481c`. Both prerequisites share the Get Started browser spec. Use this isolated worktree for the follow-up and keep the existing submission candidate unchanged. Theia 1.77.0 retains the object passed to `CommandRegistry.registerCommand`. A menu action reads its command label when shown, and a new palette query reads command labels again. `AbstractDialog` exposes the title element and returns the accept button from `appendAcceptButton`.
</context>

<tasks>

<task type="tracer" tdd="true">
  <name>Localize the existing About entry and dialog through User Settings</name>
  <files>workbench/extension/src/browser/sterling-about-module.ts, workbench/extension/src/browser/sterling-locale.ts, workbench/test/e2e/get-started.spec.ts</files>
  <read_first>Read the three files and the pinned Theia command registry, action menu node, quick command service and AbstractDialog implementation. Review the bundled and unbundled acceptance harness.</read_first>
  <behavior>Switch to French using the native User Settings select. Find exactly one About entry in Manage and in a filtered command palette for each locale. Open À propos de SovAI from both, check the accessible dialog name, locale, version or localized unavailable text, footer button and keyboard dismissal. With the dialog attached, switch to English through User Settings in a second page of the same Workbench and check that the original dialog node and focused button persist while its labels change. Restore English even if an assertion fails. Keep the existing English keyboard and focus assertions.</behavior>
  <action>
    Extend the existing browser scenario and demonstrate that the French setting applies before the About caption assertion fails.

    Extend the typed locale messages and update the preference description to reflect the supported views. Keep one command and one menu action, with a command label getter and no static menu override. Use the existing locale observer for the About contribution and dispose its subscription at frontend shutdown. Read the latest applied locale after the existing asynchronous version lookup. If a preference event arrives while a dialog is attached, update the same visible title, accessible name, lang, version text and close button using their DOM nodes. Keep the version value, lookup timeout, retry, focus and keyboard behavior. Scope translation to app-owned About copy. Other Theia menus retain their own locale.
  </action>
  <verify>
    <automated>phase_tmp=$(mktemp -d) && flock -o /home/aaron/.cache/claude-code-tmp/heavy.lock systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env PATH="/home/aaron/.nvm/versions/node/v26.13.1/bin:$PATH" NODE_OPTIONS=--max-old-space-size=1536 TMPDIR="$phase_tmp" npm --prefix workbench run lint</automated>
    Run `playwright test --config test/e2e/playwright.config.ts test/e2e/get-started.spec.ts --grep 'About SovAI opens' --workers=1` from the Workbench with the existing private native harness in bundled and unbundled sessions. Use the normal container harness on the exact approved images at integration.
    <fails_when>French requires a reload, creates a duplicate command, leaves the About title or footer in English, changes the version value or allows dismissal to lose focus.</fails_when>
  </verify>
  <done>The existing About journey is accessible in both Canadian languages from normal Workbench entry points.</done>
</task>

</tasks>

<verification>
Get an independent plan check, record the exact RED and GREEN verification, and keep packaged acceptance and qualified Canadian French review open until evidenced.
</verification>
