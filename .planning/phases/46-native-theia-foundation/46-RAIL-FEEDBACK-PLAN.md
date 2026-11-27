---
phase: 46-native-theia-foundation
plan: rail-feedback
type: execute
wave: 5
depends_on: [46-08]
files_modified:
  - workbench/extension/src/browser/sterling-welcome-module.ts
  - workbench/extension/src/browser/sterling-welcome.css
  - workbench/test/e2e/get-started.spec.ts
autonomous: true
requirements: []
must_haves:
  truths:
    - "A failed shortcut shows its name and tells the user to try again."
    - "The rail still attempts to run commands as the plugin starts."
  artifacts:
    - path: workbench/extension/src/browser/sterling-welcome-module.ts
      provides: visible retry feedback for failed shortcut opens
  key_links:
    - from: workbench/test/e2e/get-started.spec.ts
      to: workbench/extension/src/browser/sterling-welcome-module.ts
      via: existing development image without the bundled plugin
---

# Give feedback when a Workbench sidebar shortcut fails

<objective>
Give the user a visible next step when an enabled right sidebar shortcut cannot open. A first click on Chat can arrive before its plugin registers the command. The rail currently logs to the browser console and the user sees no result.
</objective>

<tasks>

<task type="tracer" tdd="true">
  <name>Report failed shortcut opens in the Workbench notification area</name>
  <files>workbench/extension/src/browser/sterling-welcome-module.ts, workbench/extension/src/browser/sterling-welcome.css, workbench/test/e2e/get-started.spec.ts</files>
  <read_first>Read the rail module, the MessageService usage in session activity, and the Get Started browser test and container flag.</read_first>
  <behavior>On a failed open, show the shortcut name and ask the user to wait a moment and retry. Keep the command attempt, normal navigation, and planned button state. Leave the existing Chat collapse and animation code path intact.</behavior>
  <action>Use one shared open handler and Theia's existing MessageService for failed rail opens. Keep caught diagnostics in the console and use fixed wording for both the toast and an initially empty, visually hidden role=status region in the rail. Theia’s toast markup has no live role. The status stays in the accessibility tree and leaves focus on the shortcut. In the existing development-image rail test, activate Chat with Enter and Team Studio by clicking in the branch where the container confirms the bundled plugin is absent. Assert the visible notifications and that keyboard activation updates the live status without moving focus or disabling Chat. Keep the released-image success case.</action>
  <verify>
    <automated>Run Workbench lint and the focused rail browser test using the existing development image path. Confirm the assertions fail before the change when an authorized isolated runner is available. Leave the existing release-image positive test in place.</automated>
    <fails_when>A missing command leaves an enabled button with no visible feedback, or a failed open disables the shortcut or ordinary navigation regresses.</fails_when>
  </verify>
  <done>Users can recover from a rejected shortcut click and ordinary navigation continues to work.</done>
</task>

</tasks>
