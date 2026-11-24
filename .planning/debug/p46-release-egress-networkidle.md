---
status: awaiting_human_verify
trigger: "Release image's browser egress check never reaches network-idle with the bundled extension, so workbench/test/e2e/egress.spec.ts (46-03's no-egress proof, run by workbench/test/container/egress.test.ts) times out before its checks run."
created: 2026-11-24T00:00:00Z
updated: 2026-11-24T16:55:00Z
---

## Current Focus

hypothesis: CONFIRMED - the wait condition, not the page. Playwright's main-frame networkidle is cleared by the bundled extension's late webview iframe and never re-armed on a quiet page
bug_class: Bohrbug (deterministic on the release target, 3/3 probe runs)
status_of_fix: fix applied and self-verified; awaiting owner approval of the gate files (release.yml, scripts/test/workflow-files.test.mjs)
reasoning_checkpoint:
  hypothesis: "egress.spec.ts times out on the release image because page.waitForLoadState('networkidle') waits on Playwright's per-frame bookkeeping: after the main frame first went idle (~2 s) it made more requests (images, the plugin icon), which cleared its self-idle bit without re-arming the timer; the bundled extension's chat webview iframe then attached (~3 s) and its idle timer recalculated the tree, removing 'networkidle' from the main frame; with no further main-frame HTTP request (the Team preview is RPC over the WebSocket) the event never fires again"
  confirming_evidence:
    - "release: 0 requests in flight for 60 s after the Team preview, yet a late waitForLoadState('networkidle') times out (15 s), in 3 of 3 runs at 127.0.0.1 and also at localhost"
    - "release: one page.evaluate(fetch('/healthz')) makes the same wait resolve after 501 ms, i.e. the 500 ms timer re-armed by a finished main-frame request"
    - "dev: no child frame; the late wait resolves in 0 ms"
    - "playwright-core 1.65 coreBundle.js: _stopNetworkIdleTimer clears _firedNetworkIdleSelf, _startNetworkIdleTimer returns early while 'networkidle' is set, _recalculateNetworkIdle removes it when _firedNetworkIdleSelf is false"
    - "outbound hook log during every probe: only 'allowed net 127.0.0.1:3000'"
  falsification_test: "if any request stayed in flight, or the late wait still timed out after a finished main-frame fetch, or the dev image also timed out, the hypothesis would be wrong; none of these happened"
  fix_rationale: "networkidle is not a readiness signal for this page; replace it with the deterministic readiness the spec actually needs (Get Started + Team preview shown + Theia's own 'Start of N plugin(s)' line when the image bundles N plugins) followed by a fixed observation window, recording from the first navigation. Recording moves to BrowserContext 'request' (also reports service-worker requests) and adds WebSockets, so the check covers more, not less"
  blind_spots: "at 127.0.0.1 the bundled extension's webview cannot load (Chromium refuses <uuid>.webview.127.0.0.1), so webview content is not exercised; at localhost only Theia's webview shell loaded, the extension's view content did not. The extension may also activate later than the 10 s window on other activation events"
  candidate_causes:
    - "code (test): the networkidle wait in workbench/test/e2e/egress.spec.ts - CONFIRMED"
    - "environment (tool): Playwright 1.65 networkidle bookkeeping does not re-arm after a late child frame on a quiet page - CONFIRMED contributing"
    - "code (product): a long-poll / retry / WebSocket churn from the bundled extension or plugin host - ELIMINATED (0 in flight, 1 WebSocket, 5 socket.io polling xhr all at upgrade)"
    - "config: the webview endpoint pattern {{uuid}}.webview.{{hostname}} at 127.0.0.1 - produces the late (blocked) frame; documented in README; not outbound"
  and_gate: "yes - needs (1) a main-frame request after the first idle, AND (2) a later lifecycle recalculation from a new child frame (the bundled webview, only on the release target), AND (3) no main-frame request afterwards. The dev image lacks (2), which is why it passes"

## Symptoms

expected: the browser part of the no-egress proof runs to completion against the release target and proves the page makes no request outside the allow list
actual: with the bundled VSIX the page never reaches Playwright networkidle; egress.spec.ts times out (120 s test timeout) before the same-origin and hook-log checks
errors: Playwright test timeout in egress.spec.ts at waitForLoadState('networkidle') (per 46-08-SUMMARY)
reproduction: npm run verify:release -> docker build --target release with release-input/sterling.vsix -> WORKBENCH_TEST_IMAGE=<tag> npm run test:container (egress.test.ts)
started: first observed in 46-08 when the release target was tested; development target passes

## Eliminated

## Evidence

- timestamp: 2026-11-24T00:00:00Z
  checked: .planning/phases/46-native-theia-foundation/46-08-SUMMARY.md line 82
  found: release target 3 of 4 egress tests pass; browser smoke timed out at networkidle; no outbound call seen
  implication: the wait condition is what fails; cause of continuous traffic unknown

- timestamp: 2026-11-24T15:44:00Z
  checked: diagnostic probe (scratchpad/probe/probe.mjs) against sterling-workbench:p46egress-release (built with near-ai-vscode-0.4.38.vsix from npm run verify:release), same flow as egress.spec.ts, 60 s observation after the Team preview showed
  found: 12 HTTP requests total, all same-origin (document, bundle.js/css, 2 images, the plugin icon svg, 5 socket.io polling xhr during the engine.io upgrade); one WebSocket to the same origin; 0 requests in flight at the end of the 60 s window; a waitForLoadState('networkidle') started right after load resolved at 2.4 s; at 3.5 s a child iframe attached and navigated to about:blank#blocked (Theia webview iframe: sandbox allow-scripts+allow-same-origin warning)
  implication: the page is NOT busy - no long-poll, no WebSocket churn, no retry loop. The difference from the dev image is the late-attached webview iframe

- timestamp: 2026-11-24T15:50:00Z
  checked: Playwright 1.65 playwright-core/lib/coreBundle.js Frame._startNetworkIdleTimer / _stopNetworkIdleTimer / _inflightRequestStarted / _inflightRequestFinished / _recalculateNetworkIdle
  found: a request starting after a frame has fired networkidle calls _stopNetworkIdleTimer, which sets _firedNetworkIdleSelf=false; when it finishes, _startNetworkIdleTimer returns early because 'networkidle' is still in _firedLifecycleEvents. The next _recalculateNetworkIdle (triggered by any frame lifecycle event or a child frame's own idle timer, e.g. a new iframe) sees _firedNetworkIdleSelf=false and REMOVES networkidle from the main frame. Nothing restarts the main frame's idle timer until another main-frame request finishes
  implication: candidate mechanism - main frame went idle (2.4 s), made more requests (images, plugin icon at ~3 s), then the webview iframe attached (3.5 s) and its timer recalculated -> main frame loses networkidle and, because the page then makes no more HTTP requests (the Team preview is RPC over the WebSocket), never regains it

- timestamp: 2026-11-24T16:05:00Z
  checked: probe2 - same flow, then a late waitForLoadState('networkidle', 15 s) with nothing in flight, then one page.evaluate(fetch('/healthz')) and the same wait again; release and dev images
  found: RELEASE - late wait TIMED OUT with 0 requests in flight; after one same-origin fetch from the main frame it resolved after 501 ms (the 500 ms idle timer). DEV - no child frame; late wait resolved after 0 ms
  implication: CONFIRMED. The page is idle; Playwright's main-frame networkidle flag was cleared by the late iframe's recalculation and is only re-armed by a main-frame request finishing, which never comes. Not a long-poll, WebSocket or retry; not an outbound call (hook log: 3 x allowed net 127.0.0.1:3000 only)

- timestamp: 2026-11-24T16:15:00Z
  checked: probe3 - iframe attributes on the release image at 127.0.0.1; probe at localhost
  found: the late iframe is the bundled extension's chat webview view (parent plugin-webview:<id>), src http://<uuid>.webview.127.0.0.1:<port>/webview/index.html; Chromium refuses the host (a name ending in a number must be an IPv4 address) and the frame shows about:blank#blocked - no request is made. At localhost the same iframe loads from <uuid>.webview.localhost:<port>, and its service worker issues requests that only BrowserContext 'request' reports (Request.frame() throws "Service Worker requests do not have an associated frame"); page.on('request') never sees them, and page.on('request') never sees WebSockets either
  implication: the webview is not busy and not outbound at 127.0.0.1 (README already says use localhost for webviews). The spec's recorder should be context-level and should record WebSockets, or it has blind spots

- timestamp: 2026-11-24T16:40:00Z
  checked: egress container suite (4 tests) with the new spec, WORKBENCH_TEST_IMAGE=release then dev
  found: release 4/4 pass (browser test 16.4 s); dev 4/4 pass (browser test 16.0 s)
  implication: the browser proof now runs to completion on both targets

## Resolution

root_cause: "The spec's page.waitForLoadState('networkidle') never resolves on the release image although the page is idle: Playwright 1.65 clears the main frame's idle bit when a request starts after the first networkidle and does not re-arm it when that request ends; the bundled extension's chat webview iframe (release target only) attaches afterwards and its idle timer recalculates the frame tree, removing 'networkidle' from the main frame; with no later main-frame HTTP request it never fires again. AND-gate: late main-frame request; late child frame; no main-frame request afterwards. Not a long-poll, WebSocket churn, retry or outbound call."
fix: "egress.spec.ts waits for deterministic readiness (Get Started + Team preview shown + Theia's 'Start of N plugin(s)' when STERLING_EXPECT_PLUGINS=N>0, set by egress.test.ts from /plugins in the image), then watches a fixed 10 s window; records via BrowserContext 'request' (adds service-worker requests) and page 'websocket' (adds WebSockets); asserts the recorder saw same-origin requests. Release workflow image job runs the egress suite against sterling-release:$TAG before docker save."
verification:
  target_test: { result: pass, detail: "egress suite (4 tests) release 4/4 (browser 16.4 s), dev 4/4 (browser 16.0 s)" }
  mutation_check: { result: pass, tool: "manual (no Stryker configured)", mutants: "spec A env unset -> fails closed (NaN); B STERLING_EXPECT_PLUGINS=2 on the one-plugin image -> poll fails, shows Theia's real 'Start of 1 plugin' line; C fetch + WebSocket to 127.0.0.2 planted in the observation window -> both listed; D unchanged spec -> passes. Workflow assertion: m1 egress line removed, m2 npm ci with scripts, m3 egress moved after docker save -> all fail the test; original passes" }
  no_op_deletion: { result: pass, deletion_justified_by_rca: true, detail: "the only removal is waitForLoadState('networkidle'), the wait the RCA shows never fires on an idle page; replaced by stronger readiness (plugin start count) + 10 s window, and recording widened to service-worker requests and WebSockets plus a vacuity guard" }
  adjacent_tests: { result: pass, detail: "workflow-files.test.mjs 25/25, resource-check 136 resources pass, workbench lint (tsc, includes test/**) clean; copy lint does not scan workbench/test" }
  revert_and_reconfirm: { result: pass, detail: "original HEAD spec on the same release image: Test timeout of 120000ms exceeded at page.waitForLoadState('networkidle') (line 28); new spec: passes" }
  guardrail_verdict: accepted
oracle_type: specified (allow list: same origin, data:, blob:; Theia's own plugin-start line with the image's plugin count)
files_changed: [workbench/test/e2e/egress.spec.ts, workbench/test/container/egress.test.ts, .github/workflows/release.yml, scripts/test/workflow-files.test.mjs]
