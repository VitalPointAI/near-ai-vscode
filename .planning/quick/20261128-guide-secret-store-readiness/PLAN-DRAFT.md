---
phase: 46-native-theia-foundation
plan: guide-secret-store-readiness
type: execute
wave: 1
depends_on: []
draft: true
autonomous: false
files_modified:
  - workbench/extension/src/browser/secret-store-frontend-module.ts
  - workbench/extension/src/common/secret-store.ts
  - workbench/test/key-store.test.ts
  - workbench/test/e2e/secrets.spec.ts
must_haves:
  truths:
    - When the backend confirms that this Workbench has no durable secret store, one native guide opens automatically and gives a reason, next steps and concrete limitations.
    - A person can continue with available features, reopen the guide using the status item or command palette, and check the backend's reported choice again.
    - A missing status response does not claim the store is missing or fixed. An available store choice does not claim a successful sign-in or secret operation.
  artifacts:
    - path: workbench/extension/src/browser/secret-store-frontend-module.ts
      provides: Native guided recovery, startup and reopen behavior for the existing status RPC.
    - path: workbench/extension/src/common/secret-store.ts
      provides: Bounded guidance for the existing store choices and known refusal reasons.
  key_links:
    - from: workbench/extension/src/browser/secret-store-frontend-module.ts
      to: workbench/extension/src/node/key-store-backend-module.ts
      via: Existing SecretStoreService.status RPC and startup-selected backend status.
---

# Guide Workbench setup when secret storage is unavailable

Use exact main `9525754fdb7c9f4daab9de56a31aec52f598eeca` as the execution base. The four guide paths are unchanged from the originally reviewed `688b1abf6456d65db9637c03c67ecf90560b0901`. Refresh the guide worktree to the execution base before source work. Use the Phase 46-07 and 46-08 status and hosted/local contracts and the guided setup direction in Phase 32.1. Independently review the exact draft before source work. The recovery UI is native Workbench. Welcome currently sends **Set up Sterling** to the extension's `nearAi.setup` menu. Leave that entry, Welcome, its language catalogue, the Rules repair, the launcher and the Identity Policy Builder files untouched.

## Recovery flow

Replace the warning toast in `SecretStoreView` with one native **Set up secret storage** guide on the first confirmed `unavailable` result in a frontend session. Start the check when the shell layout is ready as in `sterling-welcome-module.ts`. Use a compact, closable Workbench panel in the bottom area, using the `BaseWidget`, `WidgetManager` and `ApplicationShell` pattern from `sterling-work-areas-module.ts`. Keep Get Started and the existing workspace actions accessible. Use native headings, lists and buttons, a polite status element and the existing Workbench theme. On activation, move focus to the guide heading. Keep keyboard access and visible focus on the controls. Closing or selecting **Continue without secret storage** leaves the existing workspace usable and the status item available. Return focus to the invoking control where it remains attached, otherwise to the active Workbench area. The status item and a **SovAI: Secret storage setup** palette command both reopen the same panel through `sterling.secretStore.setup`. No repeat startup panel after dismissal in the same frontend session. Do not restore the guide from persisted layout state on a subsequent healthy startup.

Show the specific supported route in plain language:

| Backend evidence | What the guide says to do |
| --- | --- |
| `unavailable` with `SECRET_STORE_TEXT.noStore` | This Workbench cannot load the system keyring module or its native binding. The standalone container ships without that module and has no configured organization store in local mode. Use a hosted Workbench your organization has already configured, or ask its administrator to provision the approved authenticated OpenBao integration and restart or open the configured Workbench. A supported Workbench running directly on a computer can use its supported system keyring when that integration is available. |
| `unavailable` with `SECRET_STORE_TEXT.keyringFailed` | This Workbench could not open the computer's keyring. Unlock or restore its supported system keyring, or ask the computer's administrator to repair it. Restart the Workbench backend afterward. |
| `unavailable` with an absent or unrecognized reason | This Workbench has no usable secret store. Ask the administrator to confirm whether the supported system keyring or the organization's hosted store is configured and restart the backend after repair. |
| RPC rejected, timed out or returned an invalid kind | The choice could not be checked. Offer **Check again** on manual open. A failed check after previous unavailability preserves the last confirmed limitation as such and says the new check did not answer. |
| `keyring` or `openbao` | The backend selected the computer's keyring or the organization's secret store. No automatic guide or missing-store warning. On manual open, explain that this status reports store selection. Actual hosted sign-in and per-operation failures remain with their existing messages and recovery. |

Use only known reason values in `workbench/extension/src/common/secret-store.ts` to choose copy. Do not expose arbitrary backend reason text. The chooser in `key-store-backend-module.ts` caches one result for the life of the backend. **Check again** rereads that result without saving a secret, probing a provider or choosing a different store. State that reloading the tab alone cannot select a different store. After the administrator or user has corrected the system setup, restart the backend and reopen the browser. Only a new confirmed response can replace the last confirmed choice. Keep one in-flight check, discard timeout results or callbacks after shutdown, and avoid duplicate widgets under concurrent startup, command or status-item events. Reuse an already deployed status or dialog pattern where it directly helps.

When unavailability is verified, show these application effects:

- Profiles that rely on locally stored API keys or provider credentials cannot save or retrieve those credentials. `AuthService` reads and writes them through SecretStorage. Do not make claims about providers that require no saved credential.
- The application cannot verify and show the active signed Governance Rules or sign and apply a rule change in this Workbench. The trusted policy load uses SecretStorage and the ordinary gate retains its own fail-closed behavior, including the read-and-plan allowance where applicable. Use `src/gate/organizationStore.ts`, `src/gate/bundleStore.ts` and the normal Rules repair evidence to keep this statement precise.
- Shared staff projects cannot open in this local mode. `createEngine` in `staff-backend-module.ts` returns without a live engine when the local store is unavailable. Do not characterize all local project or Team Studio work as blocked.
- Documentation and trusted local Resource Inventory remain available with their existing access checks. Offer **Open Documentation** only if the existing internal `sterling.documentation.open` command is registered and enabled. Dispatch only that known command and show a local status if it fails. Otherwise, show the existing view name as text. Continue closes the guide and enables no blocked action.

Provide English and French guide copy in the owning secret-store module's copy table, following the existing native locale observer without modifying its shared catalogue or the existing RPC and refusal strings. Keep descriptions free of credential fields, tokens and configuration values. The guide cannot collect credentials, write settings or secrets, install a provider, change the policy floor, enroll a site, open an external address, or start a hosted or identity operation.

## Installer handoff

Provisioning is separate Phase 46/47 installer work. The installer should identify local versus managed hosted mode before first launch, check for the supported system keyring integration or the configured managed OpenBao path, and set up a missing prerequisite only through the approved supported route. Verify backend readiness before reporting setup complete. If a prerequisite cannot be set up or the user intentionally skips it, explain why and offer a guided stop or limited mode. The Workbench guide is the fallback for skipped setup or a store that becomes unavailable later. This plan adds no installer or backend changes.

<tasks>

<task type="auto" tdd="true">
  <name>Open and verify native secret storage guidance on confirmed startup failure</name>
  <files>workbench/extension/src/browser/secret-store-frontend-module.ts, workbench/extension/src/common/secret-store.ts, workbench/test/key-store.test.ts, workbench/test/e2e/secrets.spec.ts</files>
  <behavior>
    - The startup guide opens once in the existing local container case using confirmed backend unavailability. The reason, recovery, restart requirement and all four capability statements appear. Dismiss it by keyboard, verify Get Started remains usable, then reopen through the status item and palette command without a second instance.
    - Rechecking the unavailable backend keeps the limited-state message. An explicit unavailable secret operation after Continue still fails visibly through the existing probe. The guide's internal Documentation action opens the existing view without crossing an external boundary.
    - Reuse the existing missing-module and failed-keyring fixture cases to assert distinct guide copy. Add synthetic checks for no automatic display or restoration from a stale guide layout for selected `keyring` and `openbao`, rejected/timed-out status, and malformed status at startup. Verify a previously confirmed missing store remains clearly marked as the last confirmed choice when a recheck fails. Verify selected kinds do not claim live readiness and raw backend text is omitted.
  </behavior>
  <action>
    Add RED assertions to the existing `SPEC_STEP=unavailable` local browser case and the existing `key-store.test.ts` fixtures. Keep one store-specific mapping from backend status and last confirmed state to guide text, automatic display eligibility and persistent status. Keep panel lifecycle and activation in `SecretStoreView`. A layout restore must not create this transient guide independently of the current session's confirmed unavailable status. Change the existing notification flow without adding a readiness registry, backend RPC or provider probe. Keep controls focused through a status update, and disable Check again while a request is pending with a bounded waiting state. Drive real keyboard actions and observe a stable status statement in the browser. Exercise the guide's internal Documentation action and leave normal workspace trust and inventory policies untouched.
  </action>
  <verify>
    <automated>npm --prefix workbench run lint && node workbench/scripts/build.mjs && node scripts/run-tests.mjs workbench/dist/test/key-store.test.js</automated>
    <fails_when>Type checks or fixture tests fail, or the guidance maps an uncertain or selected status to a missing or fixed claim, exposes backend text, or gives the wrong reason-specific recovery.</fails_when>
    <automated>SPEC_STEP=unavailable node workbench/node_modules/playwright/cli.js test --config workbench/test/e2e/playwright.config.ts secrets.spec.ts</automated>
    <fails_when>The local unavailable guide fails to open once, omits specific limitations or recovery, cannot be dismissed and reopened by keyboard, cannot open registered internal Documentation, or blocked test-only save succeeds. Fail the preflight if the exact local browser, isolated workbench or fixture is absent or outside recorded approval.</fails_when>
  </verify>
  <done>Confirm the unavailable path through the ordinary frontend status RPC and local browser fixture. The same unavailable backend still refuses the existing synthetic secret probe after Continue. Documentation remains reachable. Confirm the healthy and unknown startup behavior in synthetic status tests. Confirm path scope, copy and no change to backend choice or policy trust. Record hosted browser verification separately as pending if it was outside existing approval.</done>
</task>

</tasks>

Run focused checks under the repository handover's shared heavy lock and memory cap, with disposable fictional profiles and already approved pinned artifacts. Before direct Playwright, record the exact candidate Workbench image or package digest, lock-matched Playwright and Chromium identity, existing synthetic secret-probe fixture digest and the disposable local launch scope against the approval that covers them. Set `WORKBENCH_URL` to that private loopback-only Workbench and `PLAYWRIGHT_BROWSERS_PATH` to the exact preapproved local browser path. The local backend must report unavailable without any provider or external egress. Run from repository root. Do not invoke `workbench/test/container/hosted-e2e.test.ts` for this evidence, because its top-level fixture starts OpenBao even when filtering to the local case. A missing artifact or approval leaves the browser check pending. A synthetic selectable-status result supplies no hosted browser verification. Record results and exact evidence limits in the quick SUMMARY with `## Open conditions` using the coordinator's gap process if applicable.
