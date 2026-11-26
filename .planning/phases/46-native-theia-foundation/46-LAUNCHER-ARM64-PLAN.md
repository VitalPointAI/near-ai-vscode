---
phase: 46-native-theia-foundation
plan: launcher-arm64
type: execute
wave: 3
depends_on: [46-launcher-check, 46-arm64-browser-evidence]
files_modified:
  - scripts/launch-local-workbench.mjs
  - workbench/test/local-workbench-launch.test.mjs
  - docs-site/content/using/getting-started.md
autonomous: true
requirements: []
must_haves:
  truths:
    - "A native Linux ARM64 host can pass the workstation engine check without a release image."
    - "Launch and repair require the exact approved digest for the detected native Linux architecture."
  artifacts:
    - path: scripts/launch-local-workbench.mjs
      provides: Native Linux x86-64 and ARM64 prerequisite and image selection
  key_links:
    - from: workbench/test/local-workbench-launch.test.mjs
      to: scripts/launch-local-workbench.mjs
      via: recorded local host, daemon and image platform
---

# Native Linux ARM64 launcher selection

<objective>
Bring the launcher's platform check into line with the natively verified Workbench build. Passing the check means the host and Docker can run a matching image. The currently published image is Linux x86-64. ARM64 runtime proof came from CI and a signed ARM64 image is a separate release step. macOS is deferred.
</objective>

<tasks>

<task type="tracer" tdd="true">
  <name>Match the host, engine and approved image architecture</name>
  <files>scripts/launch-local-workbench.mjs, workbench/test/local-workbench-launch.test.mjs, docs-site/content/using/getting-started.md</files>
  <read_first>Read the checked launcher, its test and guide. Read the passing native Linux ARM64 browser job in run 45841495686. Keep the current release image reference rule and local Unix socket.</read_first>
  <behavior>
    - Linux Node x64 selects Docker amd64. Linux Node arm64 selects Docker arm64. On both, `--check` reports the checked architecture and requires no image. Unsupported host or mismatched engine fails before looking up or changing resources.
    - A preloaded exact ARM64 digest and matching image ID follows the established local startup and retry. An image for a different CPU is refused before creating or starting resources. `--repair` can fetch exactly the supplied digest with the detected native platform. Neither launch nor repair falls back to a tag or emulation.
  </behavior>
  <action>
  Determine the supported architecture once from the process, require Docker's actual server OS and architecture to match, and select the same platform in pull and create. Keep exact image ID, digest, preview configuration, resource ownership, loopback readiness and persistence checks. Report supported CPU types and mismatches plainly. Update usage and the getting-started guide so prerequisite support and release image availability are distinguishable. Do not acquire an image, change a host or ship an ARM64 digest during this fixture-only plan.
  </action>
  <verify>
    <automated>Extend the existing injected launcher fixture with the ARM64 cold launch, mismatch and exact repair cases. Observe the expected RED. Under the shared heavy-job cap, run raw and bundled Node 26 tests, CLI help and whitespace verification.</automated>
    <fails_when>Matching ARM64 cannot pass preflight, a mismatched engine or image mutates resources, repair can change digests or platform, or existing x86-64 behavior regresses.</fails_when>
  </verify>
  <acceptance_criteria>The launcher selects the correct architecture from the native Linux workstation and reports what it checked. Its fixtures verify the exact image path for both platforms. Published ARM64 and live launcher acceptance remain separate evidence.</acceptance_criteria>
</task>

</tasks>
