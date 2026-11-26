---
phase: 46-native-theia-foundation
plan: launcher-guide
type: execute
wave: 4
depends_on: [46-launcher-arm64]
files_modified:
  - docs-site/content/using/getting-started.md
autonomous: true
requirements: []
must_haves:
  truths:
    - "Both startup methods lead to one set of first-project and model profile instructions."
    - "Each startup method gives the correct way to stop and restart the same container."
  artifacts:
    - path: docs-site/content/using/getting-started.md
      provides: Local Workbench startup, first use and restart instructions
---

# Local Workbench getting-started guide

<objective>
Make it clear what to do after opening the Workbench and how to return to the same workspace later.
</objective>

<tasks>

<task type="auto">
  <name>Document the shared first-use path and the correct restart for each startup method</name>
  <files>docs-site/content/using/getting-started.md</files>
  <read_first>Read the guide, `scripts/launch-local-workbench.mjs`, and `46-LAUNCHER-ARM64-SUMMARY.md`. Trace both startup paths and record where the existing guide leaves launcher users without a clear next step or points them to the manual container name.</read_first>
  <action>
  Keep startup instructions for the launcher and manual Docker in their respective sections. End each with the browser address it uses and direct readers to one shared section for opening or creating a project, setting up a SovAI Chat profile with an approved reachable model server, and sending the first message. Explain that launcher users stop `sterling-local-workbench` and rerun the same `--image` command with the same digest to restart with the existing workspace volume. Keep the `sterling` stop and start commands with manual Docker. Preserve the current local preview, loopback, exact-digest and published platform requirements.
  </action>
  <verify>
    <automated>git diff --check 6ed46b323 &amp;&amp; npm run docs:build</automated>
    <fails_when>The diff check or docs build fails, or the two-path walkthrough finds an incorrect browser address, dead end, container name, restart command, persistence claim or published platform statement.</fails_when>
    <manual>Walk both paths from startup through the first message and back through stop and restart, with no running containers. Compare the container names, start commands and persistence statements with the launcher, its existing fixture and the manual Docker example.</manual>
  </verify>
  <done>Both paths reach the same first-project and profile instructions, describe their actual container and restart behavior, and preserve the published Linux x86-64 image and pending signed Linux ARM64 image. The docs build and walkthrough both pass.</done>
</task>

</tasks>
