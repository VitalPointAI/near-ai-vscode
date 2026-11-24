---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 12
subsystem: deploy
status: complete
tags: [theia-cloud, appdefinition, session-lifecycle, site-env, kyverno, hardening-13]
requires: [47-04]
provides:
  - "deploy/charts/sterling-sessions: AppDefinition sterling-workbench, ConfigMap sterling-site-env (ten STERLING_ names), ValidatingPolicy sterling-session-env; descriptor order 65 in theia-cloud"
  - "deploy/values/site.example/sterling-sessions.yaml (maxInstances, notifyAfterMinutes, maxSessionMinutes, resources, usePlaceholder, openVsxUrl, modelServers)"
  - "deploy/test/render-sessions.test.mjs; deploy/test/fixtures/sessions-placeholder.yaml"
affects: [47-15, 47-16, 47-18]
tech-stack:
  added: []
  patterns:
    - "A Kyverno ValidatingPolicy (CEL) selected by the sterling-session label that the operator template sets"
key-files:
  created:
    - deploy/charts/sterling-sessions/Chart.yaml
    - deploy/charts/sterling-sessions/values.yaml
    - deploy/charts/sterling-sessions/templates/appdefinition.yaml
    - deploy/charts/sterling-sessions/templates/site-env.yaml
    - deploy/charts/sterling-sessions/templates/session-env-policy.yaml
    - deploy/values/sterling-sessions.yaml
    - deploy/values/sterling-sessions.release.json
    - deploy/values/site.example/sterling-sessions.yaml
    - deploy/test/render-sessions.test.mjs
    - deploy/test/fixtures/sessions-placeholder.yaml
  modified: []
key-decisions:
  - "Theia Cloud's AppDefinition timeout counts minutes since the session was created, whatever the activity (BasicTheiaCloudOperator.isSessionTimedOut at 1.2.0; 0 = no limit). So the site's sessionTimeoutMinutes (idle minutes) maps to the activity tracker's timeoutAfter, and timeout is a separate per-site hard limit, 0 by default"
  - "The AppDefinition's ingressname is the theia-cloud chart's instances ingress (theia-cloud-demo-ws-ingress at 1.2.0 defaults); the test fails if the two disagree"
  - "STERLING_OPENBAO_ADDR is https://openbao.sterling-openbao.svc:8200 (the openbao chart's service; standbys forward to the active node)"
  - "The environment allow-list is the 13 THEIACLOUD_ names of the upstream template at e2d201fd; STERLING_LISTEN_HOST and THEIA_HOSTS are not set by our template (47-09), so not allowed"
requirements-completed: [DEP-06]
duration: ~40min
completed: 2026-11-24
estimate:
  tokens: 60000
  tasks: 2
actuals:
  tokens: 5500
  tasks: 2
  commits: 2
plan_head_before: abc78776
plan_head_after: 3325eb13
---

# Phase 47 Plan 12: The workbench AppDefinition, site environment and session environment policy Summary

**The workbench's AppDefinition renders offline with no prewarm pool, the site's capacity and idle values, IfNotPresent and the image from the lock by digest. Every session gets exactly ten site settings and no secret, and a fail-closed Kyverno policy stops a launch request from pulling any Secret, ConfigMap key or extra variable into a person's session.**

## Tasks

| Task | Result | Commit |
|---|---|---|
| 1. AppDefinition and site environment (tracer) | done; tracer gate re-ran the render test end to end before expanding | `05e59571` |
| 2. Hardening item 13: the session environment policy (TDD) | done | `3325eb13` |

## Verification

- `render-sessions.test.mjs` with the pinned helm, under the memory cap: 6 tests, all added by this plan, all pass. Three cover the
  AppDefinition, the lab placeholder and the site environment; three cover the policy's selection, its environment rules and its volume
  rules. A first run failed the placeholder test: the test put its fixture before the release's site file, which set usePlaceholder back to
  false. The test now passes the fixture as the site file, and the rerun is green.
- The rendered release contains `kind: AppDefinition`, `name: sterling-workbench`, `minInstances: 0`, `imagePullPolicy: IfNotPresent`, and
  a `ValidatingPolicy` `sterling-session-env` with `Deny`. `sterling-site-env` has 10 `STERLING_` keys. The AppDefinition's `ingressname`
  equals an Ingress the theia-cloud release renders.
- Final run of the whole `deploy/test/*.test.mjs` suite (pinned helm and cosign, memory cap): 58 tests, 58 pass, 0 skipped.
  `node scripts/resource-check.mjs`: passed, 123 resources. `node deploy/charts/vendor.mjs --check`: ok.
- TDD note: the policy tests were written with the policy; there was no separate RED run. 47-15's lab spike exercises the policy against a
  real launch request that names a Secret.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The idle timeout would have been a hard limit**
- The plan set the AppDefinition `timeout` to `${site.sessionTimeoutMinutes}`. In Theia Cloud 1.2.0 that field stops a session a fixed
  number of minutes after it was created, even while the person is working. The site setting, "idle minutes before a session is stopped",
  now sets `monitor.activityTracker.timeoutAfter`. `timeout` is the per-site `maxSessionMinutes`, 0 (no limit) in the example. The test
  asserts both.

## The session lifecycle in this chart

| State | Where it comes from |
|---|---|
| requested -> refused | `maxInstances` (400 in the HQ example, provisional); Theia Cloud refuses the launch. The text is the service's ("... has max instances reached."); the owner's wording needs a Phase 46 or upstream change (owner-confirm item 9) |
| starting -> failed | the launch request's timeout (the landing page, 47-15), and a Deployment refused by `sterling-session-env` |
| idle-warned / stopping | `notifyAfter` 25, `timeoutAfter` the site's `sessionTimeoutMinutes` (30), both provisional until Phase 48 (D-11) |
| stopped | the workspace volume is kept (class reclaimPolicy Retain, 47-10) |

## Known Stubs

None. The workbench image renders with the reserved digest until Phase 46 publishes it (reported as a test diagnostic); the lab uses the
pinned placeholder with `usePlaceholder: true`.

## Self-Check: PASSED
