---
status: awaiting_human_verify
trigger: "0.4.39 candidate image at http://127.0.0.1:18881: every webview page (Team Studio, Chat, Agent Activity, Governance) is blank; iframes point at http://<uuid>.webview.127.0.0.1:18881/webview/index.html and show about:blank#blocked. At http://localhost:18881 all webviews load."
created: 2026-11-25T00:00:00Z
updated: 2026-11-25T13:00:00Z
---

## Current Focus

bug_class: Bohrbug (deterministic: every load at 127.0.0.1)
hypothesis: CONFIRMED. Theia's frontend WebviewEnvironment substitutes location.host into {{uuid}}.webview.{{hostname}}; for a page at an IP literal the result (<uuid>.webview.127.0.0.1:<port>) is an invalid WHATWG URL, so the webview iframe is refused (about:blank#blocked). Hosted: the session chart and Theia Cloud values give *.webview.ws.<domain> no ingress rule or certificate name.
tdd_checkpoint:
  test_file: workbench/test/e2e/get-started.spec.ts (run by workbench/test/container/get-started.test.ts at http://127.0.0.1:<port>)
  test_name: "on the release image, the Team Studio and Chat shortcuts show their pages in their own webview origins"
  status: red
  failure_output: "the webview frame loaded Theia's webview page: Expected pattern /^https?:\/\/[^/]+\/webview\/index\.html\?/, Received about:blank#blocked (sterling-release:v0.4.39-candidate2; 1 failed, 3 passed)"
reasoning_checkpoint:
  hypothesis: "Webviews are blank at 127.0.0.1 because Theia's frontend WebviewEnvironment builds the iframe host <uuid>.webview.<location.host>; with an IP literal that host is an invalid WHATWG URL host, so Chromium refuses the navigation (about:blank#blocked)"
  confirming_evidence:
    - "candidate2 and the defence twin at 127.0.0.1: outer webview frame url about:blank#blocked, src http://<uuid>.webview.127.0.0.1:<port>/webview/index.html"
    - "new URL('http://x.webview.127.0.0.1:1/') throws ERR_INVALID_URL; the localhost form parses and resolves to loopback"
    - "the same image at localhost loads every webview (owner report; egress suite at localhost passes on candidate2)"
  falsification_test: "with the frontend mapping 127.0.0.1 -> localhost, the frame must load http://<uuid>.webview.localhost:<port>/webview/index.html and show Team Studio's heading and the chat textbox at 127.0.0.1; if it still shows about:blank#blocked, the hypothesis is wrong"
  fix_rationale: "the invalid host is produced in exactly one place (WebviewEnvironment.doInit's {{hostname}} substitution); replacing a loopback IP literal by localhost on the same port gives a valid, loopback-resolving, still cross-origin host that Theia's backend vhost regex ^.+\.webview\..+$ already accepts and its WS-upgrade check already refuses"
  blind_spots: "browsers other than Chromium resolving *.localhost (Firefox does since 84; Safari not checked); hosted path only rendered, not run on a real site (G470)"
  candidate_causes:
    - "code: Theia frontend host substitution (confirmed)"
    - "config: no THEIA_WEBVIEW_EXTERNAL_ENDPOINT set (ruled out as a fix: a fixed env value cannot carry the published port, and a non-default pattern triggers Theia's insecure-pattern warning)"
    - "environment: DNS cannot resolve the name (eliminated: the URL is invalid before any DNS lookup)"
  and_gate: "no for local runs (one cause); hosted runs have an independent second condition (no ingress rule, certificate name or DNS record for *.webview.<instance host>), fixed in the charts and recorded as G470/G471"
tdd_checkpoint_green: get-started suite on sterling-release:webview-fix-ae9c (branch build + candidate2's VSIX): 4 passed; egress suite: 4/4 with the browser smoke at 127.0.0.1 and localhost
next_action: owner opens the fixed release image at http://127.0.0.1:<port> and confirms Team Studio, Chat, Agent Activity and Governance render

## Symptoms

expected: webview pages (Team Studio, Chat, Agent Activity, Governance) render when the workbench is opened at http://127.0.0.1:<port>
actual: iframes point at http://<uuid>.webview.127.0.0.1:18881/webview/index.html; Chromium shows about:blank#blocked; pages blank
errors: about:blank#blocked (navigation to an unresolvable host)
reproduction: open the 0.4.39 candidate image at http://127.0.0.1:18881, click the Team Studio rail shortcut
started: 0.4.39 candidate (webview pages moved into the Theia workbench); localhost works

## Eliminated

## Evidence

- timestamp: 2026-11-25T00:00:00Z
  checked: node_modules/@theia/plugin-ext/src/main/browser/webview/webview-environment.ts and main/node/plugin-service.ts (1.77.0)
  found: frontend reads THEIA_WEBVIEW_EXTERNAL_ENDPOINT from the backend EnvVariablesServer (default {{uuid}}.webview.{{hostname}}) and replaces {{hostname}} with new Endpoint().host (location.host incl. port). Backend builds RegExp ^<pattern with {{uuid}}/{{hostname}} -> .+>$ and mounts /webview statics through vhost; with the default pattern any host matching ^.+\.webview\..+$ is served. No {{port}} placeholder exists.
  implication: for a page at 127.0.0.1:18881 the iframe host is <uuid>.webview.127.0.0.1:18881, which DNS cannot resolve. A fixed env value cannot carry the published port (the container listens on 3000 and is published on arbitrary ports), so the fix belongs in the frontend WebviewEnvironment.

- timestamp: 2026-11-25T00:10:00Z
  checked: node -e new URL('http://abc.webview.127.0.0.1:18881/') and new URL('http://abc.webview.localhost:18881/'); getent hosts
  found: the 127.0.0.1 form throws ERR_INVALID_URL (WHATWG URL: a host whose last label is a number is parsed as IPv4, and abc.webview.127.0.0.1 is not one); the [::1] form also invalid; the localhost form is valid and resolves to loopback
  implication: not a DNS miss: the URL itself is invalid, so Chromium refuses the iframe navigation and shows about:blank#blocked. No pattern of the form <x>.<ip literal> can ever work.

- timestamp: 2026-11-25T00:12:00Z
  checked: docker inspect (read-only) of sterling-theia-defence, sterling-candidate, sterling-latest; wv.cjs (headless Chromium) at http://127.0.0.1:18878 and :18881
  found: none sets THEIA_WEBVIEW_EXTERNAL_ENDPOINT. Both the defence twin and the candidate show the Team Studio iframe at http://<uuid>.webview.127.0.0.1:<port>/webview/index.html and both frames are about:blank#blocked
  implication: the older twin does not render webviews at 127.0.0.1 either; what renders there are the native Theia widgets (Get Started, work-area pages). No configuration on the twin to copy. The egress suite already documents this (egress.test.ts opens the page at localhost because at 127.0.0.1 "they are not valid names and the chat cannot load").

- timestamp: 2026-11-25T00:15:00Z
  checked: deploy/charts/sterling-sessions AppDefinition, deploy/values/theia-cloud.yaml, vendored theia-cloud 1.2.0 chart (instances-ingress.yaml, values.yaml, demo AppDefinition)
  found: hosted sessions are https://ws.<domain>/<session-uid>/ (usePaths false, instance prefix ws). Upstream exposes webviews with AppDefinition ingressHostnamePrefixes ["*.webview."] plus chart hosts.allWildcardInstances ["*.webview."] (adds the *.webview.ws.<domain> rule and TLS host). Ours sets neither; the oauth2-proxy cookie domain defaults to ws.<domain>, which covers its subdomains.
  implication: on a hosted site the default pattern gives <uuid>.webview.ws.<domain>, which has no ingress rule, no certificate name and no DNS record: webviews would be blank there too.

- timestamp: 2026-11-25T00:40:00Z
  checked: new e2e test against sterling-release:v0.4.39-candidate2 at http://127.0.0.1:<port> (capped)
  found: plugin start and the Team Studio tab (SovAI Team Studio) pass; the webview outer frame stays about:blank#blocked for 60 s; 1 failed, 3 passed
  implication: the test reproduces the owner's symptom deterministically in the release proof

- timestamp: 2026-11-25T00:42:00Z
  checked: src-gen/frontend/index.js module order (another worktree's build) and @theia/application-package ExtensionPackageCollector
  found: modules load in post-order of package dependencies; the Sterling extension declares only @theia/core, so all its modules load before @theia/plugin-ext's. Declaring @theia/plugin-ext would move every Sterling frontend AND backend module after plugin-ext and its dependencies (backend middleware order too)
  implication: rebind() is impossible without reordering; a container-level onActivation (inversify 6.2.2, applies to any binding of the id regardless of load order, result cached by the singleton scope) swaps the instance with no reordering

- timestamp: 2026-11-25T01:30:00Z
  checked: sterling-release:webview-fix-ae9c (this branch, candidate2's VSIX) with the get-started and egress container suites (capped)
  found: get-started 4 passed at 127.0.0.1 (Team Studio heading and chat textbox visible; frame origins http://<uuid>.webview.localhost:<port>, not the page origin); egress 4/4 with the browser smoke at 127.0.0.1 and at localhost. On candidate2 the same egress suite fails at 127.0.0.1 (chat textbox never visible)
  implication: the mapping fixes the owner's case and keeps the localhost case and the no-egress proof

- timestamp: 2026-11-25T12:30:00Z
  checked: revert build sterling-release:webview-revert-ae9c (this branch, same VSIX, only the webview-origin theiaExtensions entry removed) with the get-started suite; fixed image re-run twice more
  found: revert: 3 passed, 1 failed, frame about:blank#blocked (bug returns); fixed image: 3 of 3 runs green
  implication: the module alone fixes the symptom; the new test is stable on the fixed image

## Resolution

root_cause: "Theia's frontend WebviewEnvironment substitutes the page host into {{uuid}}.webview.{{hostname}}; for a page at 127.0.0.1 (or [::1]) that gives <uuid>.webview.127.0.0.1:<port>, an invalid URL host, so Chromium refuses every webview frame (about:blank#blocked). Hosted (independent): the sessions AppDefinition and the theia-cloud values gave *.webview.<instance host> no ingress rule and no certificate name."
fix: "workbench/extension/src/common/webview-origin.ts maps a page host of 127.0.0.1 or [::1] (with any port) to localhost on the same port; webview-origin-frontend-module.ts swaps WebviewEnvironment (container onActivation, no load-order change) for a subclass using it. Charts: AppDefinition ingressHostnamePrefixes [*.webview.], theia-cloud hosts.allWildcardInstances [*.webview.]; runbook wildcard DNS record; gaps G470 (real-site proof) and G471 (wildcard certificate acceptance)."
verification: "red on candidate2 and on the revert build (about:blank#blocked), green on the branch image 3 of 3; egress at 127.0.0.1 + localhost; workbench lint/117 unit/build; deploy, docs-site and compliance suites"
oracle_type: specified (frame URL must be /webview/index.html on ^http://<uuid>.webview.localhost:<port>$ and differ from the page origin; Team Studio h1 and the chat textbox visible) plus metamorphic in the unit test (every mapped host forms a valid URL)
files_changed: [workbench/extension/src/common/webview-origin.ts, workbench/extension/src/browser/webview-origin-frontend-module.ts, workbench/extension/package.json, workbench/test/webview-origin.test.ts, workbench/test/e2e/get-started.spec.ts, workbench/test/container/get-started.test.ts, workbench/test/e2e/egress.spec.ts, workbench/test/container/egress.test.ts, workbench/README.md, deploy/charts/sterling-sessions/templates/appdefinition.yaml, deploy/values/theia-cloud.yaml, deploy/values/site.example/theia-cloud.yaml, deploy/test/render-sessions.test.mjs, deploy/runbooks/site-install.md, compliance/gaps.json, docs-site/content/security/road-to-production.md]
