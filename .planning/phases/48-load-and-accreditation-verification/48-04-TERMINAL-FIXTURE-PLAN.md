---
phase: 48-load-and-accreditation-verification
plan: terminal-fixture
type: execute
wave: 1
depends_on: []
requirements: []
autonomous: true
files_modified:
  - loadtest/src/browser-journey.mjs
  - loadtest/test/browser.test.ts
must_haves:
  truths:
    - The fixture enters the fixed action only once, in the newly selected terminal.
    - The fixture distinguishes selection, focus and marker failures.
    - The existing isolation and overall deadlines govern the same journey.
  artifacts:
    - path: loadtest/src/browser-journey.mjs
      provides: Bounded terminal fixture selection and diagnostics
  key_links:
    - from: loadtest/test/browser.test.ts
      to: loadtest/src/browser-journey.mjs
      via: Recorded browser driver and no-effect refusal checks
---

# Verify the newly opened terminal before the fictional action

Exact browser source `dc0bf380` and retry record `b064ff6d2`. The approved retry passed the save check. The recorded marker was absent. The current action selects the first visible terminal, and pinned Theia 1.77 starts terminal channel setup asynchronously. Visibility alone does not show that the selected terminal receives input. The two recorded channel IDs do not establish the cause.

<tasks>
<task type="tdd">
  <name>Bind the existing fictional step to the new terminal</name>
  <files>loadtest/src/browser-journey.mjs, loadtest/test/browser.test.ts</files>
  <action>Extend the existing recorded browser test first. Use the pinned Theia terminal widget and tab identity to distinguish a newly opened, selected terminal from a pre-existing or concurrently selected sibling. Confirm the focused input belongs to that widget. The released browser interface exposes widget selection and keyboard focus. The marker remains the sole evidence that the action ran, with terminal channel readiness still unverified. Keep the exact constant fictional action and submit it once. Keep the existing isolation and overall timing bounds and measure the complete terminal step as before. On ambiguous selection, focus loss or absent/wrong marker, return one fixed stage reason without terminal text, paths or raw browser metadata. Do not change the source image, terminal behavior or test profile.</action>
  <verify>Run `npm --prefix loadtest run lint` and, from loadtest, `node ../scripts/run-tests.mjs test/browser.test.ts` on pinned Node with the existing offline dependencies. Cover a visible pre-existing terminal, new widget focus, no input on ambiguity and one successful send. Verify the exact range and record any remaining assumption about selectors or the pinned shell. The modified registered browser journey needs a separately approved one-shot trial.</verify>
  <done>Local evidence isolates terminal widget ownership and keyboard focus. Keep G322 and G323 open pending the applicable registered and representative measurements.</done>
</task>
</tasks>
