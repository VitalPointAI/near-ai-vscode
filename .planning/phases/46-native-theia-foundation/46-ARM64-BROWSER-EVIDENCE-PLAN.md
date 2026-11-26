---
phase: 46-native-theia-foundation
plan: arm64-browser-evidence
type: execute
wave: 1
depends_on: [46-ARM64-RELEASE-EVIDENCE]
files_modified:
  - .github/workflows/ci.yml
  - scripts/test/workflow-files.test.mjs
  - workbench/test/e2e/playwright.config.ts
  - workbench/test/container/egress.test.ts
  - workbench/test/helpers/docker.ts
autonomous: false
requirements: []
must_haves:
  truths:
    - "The opt-in Linux ARM64 browser evaluation loads the exact same-run archive tested and scanned already."
    - "The pinned Playwright driver launches the independently approved, hash-checked ARM64 Headless Shell with video off."
    - "The browser egress contract and one existing Get Started leaf pass against the verified Workbench."
  artifacts:
    - path: .github/workflows/ci.yml
      provides: opt-in evidence for native ARM64 browser egress and Get Started
  key_links:
    - from: .github/workflows/ci.yml
      to: workbench/test/container/egress.test.ts
      via: checked archive ID, explicit browser executable and selected browser leaf
---

# Phase 46 Linux ARM64 browser evidence

<objective>
Verify user-visible setup and browser egress against the same Linux ARM64 Workbench archive that passed backend egress and scanning. Keep this a read-only evaluation with its own browser opt-in and a single checked browser ZIP.
</objective>

<context>
Run `45837222918` passed native ARM64 egress and the archive scan reported zero fixed High or Critical findings. The docs summary format failure was corrected locally and is outside the ARM evidence. Reuse the reviewed dedicated branch guard and the separate evaluation commit with the exact reviewed Git tree. The browser job must consume the native archive and scan identity from its own workflow run. [Archive and scan run](https://github.com/VitalPointAI/near-ai-vscode/actions/runs/45837222918) · [Release evidence plan](46-ARM64-RELEASE-EVIDENCE-PLAN.md)

The stock Playwright 1.65.0 worker passes `use.launchOptions` to the browser, and a supplied `executablePath` selects the file directly before registry fallback. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` is a name for the Workbench test config to read explicitly. Treat video and trace as off in this evidence mode. The driver looks up FFmpeg for video recording. Its install CLI adds FFmpeg for a browser target even with `--only-shell`, so fetch the one fixed ZIP directly. The complete Headless Shell ZIP supplies the executable and its resource files. A second browser archive and FFmpeg are unnecessary for these two tests. This conclusion is from source inspection. The first approved native run establishes runtime compatibility on the worker. [Playwright launch code](https://github.com/microsoft/playwright/blob/v1.65.0/packages/playwright-core/src/server/browserType.ts) · [Worker fixtures](https://github.com/microsoft/playwright/blob/v1.65.0/packages/playwright/src/index.ts) · [Pinned platform paths](https://github.com/microsoft/playwright/blob/v1.65.0/packages/playwright-core/src/server/registry/index.ts)
</context>

<tasks>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Approve extracting and running the exact checked ARM64 Headless Shell in disposable CI</name>
  <files>.github/workflows/ci.yml</files>
  <read_first>Read the Workbench Playwright lock and Phase 46-01 package approval, the quarantined fetch evidence and the repository rules for package use.</read_first>
  <what-built>The exact Google object generation was fetched into quarantine directory `codex-scratch-arm64-browser.WS2OgS`. The publisher metadata reported modification on November 4, 2026, size 129936972 bytes, and MD5 `dXKa7nImzMEmBCmVN8DKVQ==`. The bytes matched the size and published MD5. The measured local SHA-256 is `b136462898353d94c7fab50f9cdaa6d8f0d4c190153916936aa0a03353a26bf2`. Extraction and execution remain pending.</what-built>
  <action>
  Review Chrome Headless Shell 158.0.8127.18, Playwright revision 1254, Linux ARM64, from Google's immutable object generation `1793763032023285`. Review the quarantined measurement and publisher evidence before treating the locally measured SHA-256 as the approved content pin. Confirm the existing package approval covers the unchanged locked Playwright JavaScript packages. Obtain approval to extract and run this one artifact in the disposable Linux ARM64 CI evaluation. Keep the scope to the verified URL, size and SHA-256. A missing, changed or unavailable approved object leaves the browser evaluation pending. [Exact quarantined source](https://storage.googleapis.com/chrome-for-testing-public/158.0.8127.18/linux-arm64/chrome-headless-shell-linux-arm64.zip?generation=1793763032023285) · [Pinned browser version](https://github.com/microsoft/playwright/blob/v1.65.0/packages/playwright-core/browsers.json) · [Pinned artifact path](https://github.com/microsoft/playwright/blob/v1.65.0/packages/playwright-core/src/server/registry/index.ts)
  </action>
  <how-to-verify>Review the exact supplier URL and generation, version, revision, architecture, checksum evidence and disposable workflow scope.</how-to-verify>
  <resume-signal>Record the owner's explicit approval to extract and use those exact bytes in the disposable ARM64 CI evaluation before enabling or executing it.</resume-signal>
  <decision>2026-11-26: The owner answered “I approve use of those exact bytes for that test.” The approval covers only the recorded archive and the two named checks on the disposable Linux ARM64 evaluation runner.</decision>
  <verify>The use approval names one checked Linux ARM64 ZIP, the exact source and approved SHA-256. The executable path is `chrome-headless-shell-linux-arm64/chrome-headless-shell` inside that ZIP.</verify>
  <done>The exact checked source and content pin have been reviewed and extraction and use are approved for the disposable ARM64 workflow.</done>
</task>

<task type="tracer" tdd="true">
  <name>Run scoped browser checks against the verified ARM64 archive</name>
  <files>.github/workflows/ci.yml, scripts/test/workflow-files.test.mjs, workbench/test/e2e/playwright.config.ts, workbench/test/container/egress.test.ts, workbench/test/helpers/docker.ts</files>
  <read_first>Read the reviewed native archive and scan jobs, existing egress and Get Started specs, Playwright config, the container helper and the exact artifact review. Validate the actual selected leaf names and paths against the candidate tree.</read_first>
  <behavior>
    - A default-off browser switch adds evidence only on the dedicated ARM64 evaluation branch. The vendor ZIP, archive and scan identities are checked before extraction and browser or image execution.
    - The browser runs only the existing egress parent test's browser case, preserving its two origins, plus one existing Get Started case against that same running release image. Missing or skipped proof fails the browser evaluation.
    - A mismatched source, hash, native architecture or required host library produces a visible failure. The existing x86-64 and ARM64 backend jobs keep their normal scope.
  </behavior>
  <action>
  Write the targeted workflow contract first and use synthetic ZIP/archive and browser path failures for local checks. Add a typed boolean browser opt-in, default false, to the existing evaluation dispatch. Give the browser job the same dedicated branch guards and require both the main ARM64 and browser inputs. Require success for `release-content`, `workbench-arm64` and `workbench-arm64-scan`. Use the native Ubuntu ARM64 runner and the repository's existing pinned actions. Use read-only permissions and the same-run archive and scan artifacts. Check the archive file's SHA-256 against the native output, then verify the scan evidence names the same archive hash, architecture and native image ID. Require local Linux ARM64 Docker Engine 28 or newer. Load the checked archive and inspect the matching immutable image ID, architecture and released user before passing that exact ID to the existing harness. The job fails on unexpected inputs before Docker load or browser launch.

  Pin the exact generation-specific browser ZIP URL and SHA-256 approved in the checkpoint. Fetch only that object using a fresh runner scratch directory, constrained HTTPS and the approved endpoint. Check content size and SHA-256 before extracting the complete subtree. Check the expected file and native architecture before launch. The explicit Playwright path skips the registry's automated library validation, so check the approved executable's shared library dependencies on the runner and fail on missing libraries. Keep the ZIP and extracted browser outside the Workbench and version control. Use the existing pinned Node 26.13.1 setup, the pinned Playwright JavaScript packages from `npm ci --ignore-scripts`, and the existing Workbench tests-only build. Stage its two vendor files from the same-run verified VSIX using the existing producer hash and staging procedure, retaining the test build's Yjs hash validation. Keep the directory cache fresh and empty, and exclude remote browser selectors such as `PW_TEST_CONNECT_WS_ENDPOINT` and `SELENIUM_REMOTE_URL` from the evaluation environment. The evaluation has no Playwright installer invocation, host browser fallback or package manager for host libraries.

  In the existing Workbench test config, use `WORKBENCH_ARM64_BROWSER_EVIDENCE=1` to require an explicit `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` and set `use.launchOptions.executablePath`, headless mode, `video: 'off'`, and `trace: 'off'`. The evidence switch must fail before running tests if the approved path is unavailable or the host is not Linux ARM64. In the existing `runPlaywright` helper, have the evidence path invoke the checked-out Workbench's installed `node_modules/playwright/cli.js` directly with the current Node executable and the existing arguments. Require the Playwright 1.65.0 CLI package in that path and fail if missing or wrong. Preserve the existing x86-64 and default helper invocation. Run only `in the browser smoke, with the NEAR AI chat open on the release image and no model servers set, nothing calls out` in `dist/test/container/egress.test.js` through the existing test reporter, with `WORKBENCH_TEST_IMAGE` set to the checked image ID. Keep its existing browser egress assertions at `127.0.0.1` and `localhost`, its workbench scope and backend hook assertions. Require the release's bundled extension.

  Within that same container and the evidence switch, reuse `runPlaywright` to run `get-started.spec.ts` with one suffix-anchored selected leaf, `Get Started shows the setup actions, and each work-area card opens its own page`. Require one real Playwright pass and zero failures or skips for that invocation before the parent test reports success. Preserve the existing Get Started release suite and recording tools. Record archive and browser hashes, loaded ARM64 image ID, both origins, exact selected leaf and the test result. No publication, credentials, live data or release facts changes.
  </action>
  <verify>
    <automated>Run the existing workflow tests under the capped wrapper and record RED and GREEN. Check the candidate Bash and local runner/config validation with synthetic files, then obtain independent source review. Dispatch only from the authorized distinct commit with the exact reviewed Git tree, and retain the same-run native, scan and browser job links plus all identity hashes.</automated>
    <fails_when>Browser evidence can run by default, the report names unchecked input, an installer or implicit CLI acquisition can run on the evidence path, cache or remote fallback can satisfy the evidence, either origin or the selected Get Started leaf lacks a real pass, or the approved browser archive cannot support the scope.</fails_when>
  </verify>
  <acceptance_criteria>The opted-in run produces browser egress and one Get Started result against the exact scanned Linux ARM64 archive using only the checked Headless Shell ZIP. An unavailable browser pin stays a blocking precondition.</acceptance_criteria>
  <done>The summary separates isolated native browser evidence from release publication and cites the applicable reserved gap IDs.</done>
</task>

</tasks>

<verification>
Use the handover's shared heavy lock, systemd 6 GiB/zero swap cap and unique scratch directory for local checks. The workflow and its test are protected gate paths. Collect SA-10 archive and browser identity, SA-11 developer testing and SI-07 input integrity evidence. Keep G555 and G556 as recorded. Publish and sign-off remain the existing protected release work.
</verification>

<output>
Write a summary after verification, with `## Open conditions` and the orchestrator's reserved gap IDs. Record the package review, exact trusted checksum source and real run verdict separately from local fixture results.
</output>
