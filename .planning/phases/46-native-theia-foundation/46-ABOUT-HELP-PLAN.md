---
phase: 46-native-theia-foundation
plan: "about-help"
type: execute
wave: 4
depends_on: ["46-ABOUT", "46-LANG-01-ABOUT"]
files_modified:
  - package.json
  - workbench/package.json
  - workbench/extension/src/browser/sterling-about-module.ts
  - workbench/extension/src/browser/sterling-locale.ts
  - workbench/test/e2e/get-started.spec.ts
autonomous: true
requirements: [LANG-01]
must_haves:
  truths:
    - The Workbench title and installed extension display name show Sterling Sov AI.
    - Help offers a clearly named Sterling Sov AI version action in the selected Canadian locale.
    - The Help action displays the same running version or unavailable state as the existing Manage and palette actions.
  artifacts:
    - path: workbench/extension/src/browser/sterling-about-module.ts
      provides: The existing product About command from the Help menu
    - path: workbench/test/e2e/get-started.spec.ts
      provides: Browser coverage of the native Help entry in both locales
  key_links:
    - from: workbench/extension/src/browser/sterling-about-module.ts
      to: workbench/test/e2e/get-started.spec.ts
      via: Native Help menu invokes the same registered About dialog
---

# About Sterling Sov AI in the Help menu

<objective>
Make the running Sterling Sov AI version discoverable in the Workbench Help menu.
</objective>

<context>
The exact published base is `49b305a57` (v0.4.43). The native Theia Help menu's generic About action shows the framework package version. The Workbench has the correct product About action in Manage and the command palette. Theia 1.77.0 supplies the Help path and reads the action's registered command label on menu creation. The same command already follows the Canadian User preference.

Use the owner-directed visible name Sterling Sov AI in the About captions, extension display name and Workbench application title. Preserve the stable package identity, asset paths, repository links and command identifiers.
</context>

<tasks>

<task type="tracer" tdd="true">
  <name>Expose the existing product About action through Help</name>
  <files>package.json, workbench/package.json, workbench/test/e2e/get-started.spec.ts, workbench/extension/src/browser/sterling-about-module.ts, workbench/extension/src/browser/sterling-locale.ts</files>
  <behavior>The browser title and extension display name identify Sterling Sov AI. Native Help opens the existing About dialog named for Sterling Sov AI in Canadian English and French and reports the same exact version or unavailable status. Both other entry points and existing framework information stay available.</behavior>
  <action>First extend the existing browser test with the native Help menu route, both localized captions, product title and the version status. Preserve the Manage, palette, focus and dismissal coverage. Then register the existing About command in Theia's Help menu using its current label getter, and change only the two About titles in the locale catalogue. Change only the two visible metadata values in the package manifests. Keep all stable identifiers, the framework command, the version source and package versions unchanged.</action>
  <verify>
    <automated>phase_tmp=$(mktemp -d) && flock -o /home/aaron/.cache/claude-code-tmp/heavy.lock systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 300 env PATH="/home/aaron/.nvm/versions/node/v26.13.1/bin:$PATH" NODE_OPTIONS=--max-old-space-size=1536 TMPDIR="$phase_tmp" npm --prefix workbench run lint</automated>
    Run the `About SovAI opens` case through `workbench/test/e2e/playwright.config.ts` using the isolated native Workbench harness or exact approved packaged images. Use the shared cap and record separately any lighter registration-level RED or GREEN.
    <fails_when>The product title or display name differs from Sterling Sov AI, the Help action is missing, duplicated or stale after switching language, or opening it no longer gives the existing dialog with the correct version.</fails_when>
  </verify>
  <done>Help gives users the existing version dialog through one localized Sterling Sov AI entry.</done>
</task>

</tasks>
