---
phase: 46-native-theia-foundation
plan: "about"
type: execute
wave: 1
depends_on: []
files_modified:
  - package.json
  - src/extension.ts
  - workbench/extension/package.json
  - workbench/extension/src/browser/sterling-about-module.ts
  - workbench/test/container/get-started.test.ts
  - workbench/test/e2e/get-started.spec.ts
autonomous: true
requirements: []
estimate:
  tokens: 6500
  raw_tokens: 6500
  tasks: 1
  confidence: high
must_haves:
  truths:
    - Manage Settings and the command palette open the same read-only About SovAI dialog in the normal Workbench.
    - The displayed version equals the running SovAI extension manifest version, including after cold activation.
    - An absent, not-yet-ready or unavailable extension version gives the same clear unavailable state, and a later invocation can recover.
    - The modal can be used and dismissed by keyboard and has an accessible name.
  artifacts:
    - path: workbench/extension/src/browser/sterling-about-module.ts
      provides: Native Theia menu and command contribution and accessible informational dialog
    - path: src/extension.ts
      provides: No-input version command backed by active extension package metadata
    - path: workbench/test/e2e/get-started.spec.ts
      provides: One focused browser acceptance case reused for bundled and unbundled images
  key_links:
    - from: workbench/extension/src/browser/sterling-about-module.ts
      to: src/extension.ts
      via: Existing Theia hosted plugin command registry and exact internal command
---

<objective>
Add one native About SovAI entry to the normal Theia Manage Settings menu and command palette. Show the version of the SovAI extension running in the Workbench and offer a clear dismissal.
</objective>

<execution_context>
@/home/aaron/aspire-home/.codex/gsd-core/workflows/execute-plan.md
@/home/aaron/aspire-home/.codex/gsd-core/templates/summary.md
</execution_context>

<context>
@docs/development-workflow.md
@docs/testing.md
@workbench/package-lock.json
@workbench/extension/package.json

Base this scope on exact b6af516d2d512a432804f4e41b461e78ee6c58a8 and independently review the plan before execution. Use an isolated worktree, the shared heavy-job lock and project checks. Keep the root TypeScript project configuration, architecture rules and baseline unchanged. No new dependencies, preference, runtime setting, admin authority, network, shell action, deployment change, license panel, or onboarding changes.

The workbench lock pins Theia 1.77.0. The npm-cache tarballs for core and plugin-ext were checked against their lock SHA-512 before reading source. Core defines `CommonMenus.MANAGE_SETTINGS` below the existing `MANAGE_MENU` and registers that menu in the activity bar. The pinned `AbstractDialog` supplies the dialog lifecycle, Escape and focus containment, and focuses its accept control when opened. A button added through appendCloseButton does not get that initial focus. Its ordinary close tries to focus the element active at open, which may no longer belong to the document after menu or palette dismissal. Its stock `AboutDialog` reads application information and includes links, so use the existing `AbstractDialog` base without that provider. The actual hosted command path needs a contributed command placeholder for reliable cold activation: core `executeCommand` resolves an active handler before firing its activation event. The hosted plugin awaits handler registration. Use the root manifest's internal command contribution and explicit activation event, and hide the bridge from the palette. The native About command is the only user entry. [Theia 1.77.0 core and menu source](https://registry.npmjs.org/@theia/core/-/core-1.77.0.tgz) · [Pinned Dialog source](https://github.com/eclipse-theia/theia/blob/v1.77.0/packages/core/src/browser/dialogs.ts) · [Theia 1.77.0 plugin host source](https://registry.npmjs.org/@theia/plugin-ext/-/plugin-ext-1.77.0.tgz)

Local patterns are the injectable command contribution and singleton binding in `sterling-work-areas-module.ts`, the native dialog base in `sterling-resource-inventory-module.ts`, and the real packaged browser harness in `workbench/test/container/get-started.test.ts`. The root extension manifest is 0.4.41 at the base. The Workbench and native frontend package manifests use 0.1.0.
</context>

<tasks>

<task type="tracer" tdd="true">
  <name>Trace the normal About command to the running SovAI package metadata</name>
  <files>package.json, src/extension.ts, workbench/extension/package.json, workbench/extension/src/browser/sterling-about-module.ts, workbench/test/container/get-started.test.ts, workbench/test/e2e/get-started.spec.ts</files>
  <read_first>Read the pinned core common-menus, command registry and dialogs source, plugin-ext hosted command activation, the two local DI/dialog examples and both Get Started harness files.</read_first>
  <behavior>Manage Settings and the palette open one native About SovAI modal. A bundled extension shows its running version, and an absent extension shows Version unavailable. Keyboard dismissal restores focus to a usable Workbench.</behavior>
  <action>
    Write one focused Playwright case first in the existing Get Started spec. In a fresh disposable Workbench with a plain fixture folder, wait for hosted plugin contribution readiness without running an extension command. Observe registration of the contributed bridge placeholder, or wait for an existing SovAI manifest command to appear in the ordinary palette and dismiss the palette without selecting it. Listing a manifest contribution is a readiness check, while executing it would activate the extension. Then use Manage Settings as the first extension activation and verify the exact version. In the same focused coverage, exercise an early invocation while the native shell is ready and a disposable test-controlled hosted contribution has yet to register. Verify the fixed unavailable state, dismiss it, allow contribution registration, and retry through the normal action to obtain the version. Use a deterministic fixture readiness barrier where available. Record early timing as unverified if the existing harness cannot control it without a production hook, an injected command replacement or arbitrary sleeps. Close with Escape, reopen through the normal command palette, and close using the keyboard-accessible Close button. Check the modal accessible name, actual initial focus on Close, and actual focus return to the still-available launcher or a named focusable Workbench control after both Escape and keyboard Close. Exercise the normal menu or palette closing so the return assertion cannot pass through a detached menu item or document body. The existing container test should pass the expected version read independently from the bundle's exact `/plugins/extension/package.json` or an explicit absent sentinel. Require the exact bundled version when present and the fixed unavailable text when absent. Update the existing harness test counts by one for both images. Use the same case for both states. A missing reviewed image or Chromium is a reported verification prerequisite. Only an executable baseline that reaches the menu and fails on missing About supplies a meaningful RED.

    Register a private `nearAi.getSovAiVersion` extension command during the existing activation, using `context.subscriptions`. Declare its command contribution and explicit `onCommand` activation event in root package.json, and hide it via the commandPalette contribution's false condition. Make the callback reject input without doing work and return only a bounded version string or undefined from `context.extension.packageJSON.version`. Never return the full manifest, read a workspace path, hardcode the release number, use application info or use either native Workbench package manifest as a fallback. Avoid adding a shared package or a second runtime interface for this one scalar.

    Add the native `sterling.about` command labeled About SovAI and a menu action on `CommonMenus.MANAGE_SETTINGS` with a stable order. Bind a singleton as `CommandContribution` and `MenuContribution` and register the new frontend module in the native package manifest. Query the existing `CommandRegistry` for the exact bridge contribution before attempting execution. A native action invoked before registration is still available and immediately shows the existing fixed Version unavailable state. On each later invocation, recheck registration and execute the exact bridge ID with zero arguments when available. Treat missing, rejected and malformed results as the same fixed unavailable state, without caching failure or showing raw error detail. Display a small informational `AbstractDialog` with title About SovAI, `role="dialog"`, modal state and accessible name, text-only version content and one Close-labeled native accept control so pinned AbstractDialog puts initial focus there. Its return value has no effect. Capture a usable invoking focus target before awaiting the bridge, where available. After native detachment has completed and its inert state has cleared, restore focus to that target if still connected and focusable, otherwise use a stable, existing Workbench control such as the Manage button through the existing shell DOM. Account for the menu or palette launcher detaching during the command. Verify the receiving control actually owns focus after Escape and keyboard Close. Avoid stacking duplicate modals if the action is invoked again during an open. Use stable keys through the pinned Theia `nls.localize` API with English defaults for every new user-facing string, including command/menu and modal labels, accessible names, Close, the version label and unavailable status. This keeps those strings available to the future shared Canadian locale. Add no separate locale preference or translation claims. Leave the normal Theia About and settings actions intact.
  </action>
  <verify>
    <automated>phase_tmp=$(mktemp -d) && flock -o /home/aaron/.cache/claude-code-tmp/heavy.lock systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env PATH="/home/aaron/.nvm/versions/node/v26.13.1/bin:$PATH" NODE_OPTIONS=--max-old-space-size=1536 TMPDIR="$phase_tmp" npm_config_cache="$phase_tmp/npm" bash -c 'npm run compile && node scripts/run-tests.mjs dist/test/architecture.test.js && npm --prefix workbench run lint'</automated>
    On the exact verified source, run root lint and relevant verification and `npm run verify:release` under the same shared cap as separate heavy jobs before push. Inspect the verified VSIX manifest for the internal contribution, hidden palette rule and explicit activation event. Verify root tsconfig, workbench compilation configuration, architecture guard and baseline are unchanged. Run the existing focused container/browser harness with an authorized exact immutable local candidate Release image and an exact unbundled development image when available. Use isolated disposable loopback instances and existing pinned Chromium, no owner runtime or unreviewed image pull. Supply WORKBENCH_TEST_IMAGE explicitly to avoid the harness's implicit build. Report the exact image, VSIX, browser assertion and any unavailable acceptance evidence. Do not claim a packaged pass from a stub or an unverified preview.
    <fails_when>The normal menu or palette route cannot open, cold activation gives no bundled version, an absent plug-in yields the Theia app version or a failed command, or keyboard entry and dismissal fail.</fails_when>
  </verify>
  <done>The user gets the running product version or the unavailable state through the same accessible read-only dialog from both normal entry points.</done>
</task>

</tasks>

<verification>
Record the actual verification and exact source hashes for independent review. Follow the current branch gates, required exact-head checks and regular merge workflow. Make no release or runtime update from this plan.
</verification>
