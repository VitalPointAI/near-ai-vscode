---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 23
subsystem: deploy
status: complete
tags: [keycloak, ac-8, system-use-notice, login-theme, i18n]
requires: [47-08, 47-14, 47-19]
provides:
  - "Realm site setting systemUseNotice (language to text, en required); realm message sterlingSystemUseNotice; loginTheme sterling"
  - "deploy/charts/sterling-keycloak-theme: ConfigMap sterling-login-theme, release order 54 in sterling-identity"
  - "apply.mjs exports noticeProblems, applyNotice and messageText"
affects: [47-18, 47-20, 48]
tech-stack:
  added: []
  patterns:
    - "Realm messages are MessageFormat patterns: apostrophes doubled and braces quoted before they are written"
key-files:
  created:
    - deploy/charts/sterling-keycloak-theme/Chart.yaml
    - deploy/charts/sterling-keycloak-theme/templates/theme.yaml
    - deploy/charts/sterling-keycloak-theme/files/theme.properties
    - deploy/charts/sterling-keycloak-theme/files/footer.ftl
    - deploy/values/sterling-keycloak-theme.release.json
  modified:
    - deploy/keycloak/realm.json
    - deploy/keycloak/apply.mjs
    - deploy/values/site.example/sterling-keycloak-realm.yaml
    - deploy/values/keycloakx.yaml
    - deploy/test/realm.test.mjs
key-decisions:
  - "Keycloak 26.8.2 formats every message with Java MessageFormat: a site text with an apostrophe rendered 'your organizations policies'. apply.mjs writes the notice with apostrophes doubled and braces quoted (messageText), so the page shows the site file's text exactly; checkRealm compares against that form"
  - "On Keycloak 26.8.2 kc_locale on the first authorization request does not switch the language; the page's own language picker (login-actions with kc_locale=fr) and ui_locales=fr on the request both do. The page lists en and fr from the realm's supportedLocales"
  - "footer.ftl splits the notice on blank lines into paragraphs inside one element with id sterling-system-use-notice and role note, and keeps FreeMarker's HTML escaping (no no_esc)"
requirements-completed: [DEP-04]
duration: ~45m
completed: 2026-11-25
estimate:
  tokens: 60000
  tasks: 3
actuals:
  tokens: 5512
  tasks: 3
  commits: 3
plan_head_before: 5bd9b7530d5c3156987ce6e2e87336f06b442f03
plan_head_after: 1f939b5752093cb62f4a5572afe3f1541abf824c
---

# Phase 47 Plan 23: System use notice Summary

**Every Keycloak sign-in page of realm sterling, the passkey page and the administration console's sign-in included, now shows your organization's system use notice in the person's language before they sign in; shown on Keycloak 26.8.2 with the realm applied by keycloak-config-cli 6.5.1.**

## Performance

- Tasks: 3 of 3. Commits: `f0e5175a` (Task 1, tracer), `4e247eb1` (Task 2), `1f939b57` (Task 3).

## Tracer (Task 1)

Under the heavy lock and the memory cap: Keycloak `quay.io/keycloak/keycloak@sha256:75b5c435...` (26.8.2, `start-dev`, https with a throwaway CA) with `deploy/charts/sterling-keycloak-theme/files` mounted read-only at `/opt/keycloak/themes/sterling/login`, and keycloak-config-cli `@sha256:303b5c80...` applying the realm that `apply.mjs --site deploy/test/fixtures/site.ci.yaml` checks, written out as JSON. Pages were fetched over https with a cookie jar (PKCE, as the realm requires). Containers and the network were removed in the same run.

```
apply.mjs realm for the CI site: checkRealm problems 0; loginTheme sterling; supportedLocales ["en","fr"]; defaultLocale en
keycloak-config-cli run 1: exit 0; ran in 00:04.638
keycloak-config-cli run 2: exit 0; ran in 00:00.907            (nothing to change)
GET /realms/sterling/protocol/openid-connect/auth?client_id=sterling-sessions&...: 200; the passkey page (form id webauth); html lang en
  <div id="sterling-system-use-notice" role="note"> <p>This is a restricted system. Use it only if you are authorized, and only for purposes
  your organization&#39;s policies allow. ... handled under your organization&#39;s privacy notice.</p>
the page's language picker (login-actions/authenticate ... kc_locale=fr): 200; html lang fr
  <p>Ce système est à accès restreint. Utilisez-le seulement si vous y êtes autorisé, ... Les connexions et l&#39;activité ... de votre organisation.</p>
the sign-in request with ui_locales=fr: 200; notice starts "Ce système est à accès restreint. Utilisez-le seulement s"
GET /admin/sterling/console/: 200 (the console page, which signs in through client security-admin-console)
GET the administration console's sign-in (auth request of client security-admin-console): 200; notice "This is a restricted system. ..."
PUT localization en/sterlingSystemUseNotice with markup, quotes, an apostrophe, an accent and two paragraphs (as apply.mjs writes it): 204
  rendered: <p>Line one &lt;b&gt;bold&lt;/b&gt; &lt;script&gt;alert(1)&lt;/script&gt; &quot;quoted&quot; l&#39;accès é.</p> <p>Second paragraph.</p>
  the text as typed: "Line one <b>bold</b> <script>alert(1)</script> \"quoted\" l'accès é.\n\nSecond paragraph."
```

The first run showed "your organizations policies": Keycloak drops a single apostrophe (MessageFormat). The fix (deviation 1) was made before Tasks 2 and 3, and the tracer was re-run end to end with the results above.

The administration console at `/admin/sterling/console/` is a page that sends the browser on with script; curl does not run script, so the tracer fetched the sign-in request that page makes (client `security-admin-console`, redirect back to the console). It is the realm's login theme, so it carries the notice.

## Task 2: the notice rules (TDD)

Four cases in `realm.test.mjs`. Run against the `apply.mjs` before this plan, all four fail (the notice per language, the refusals, only `en`, the quoting); against this plan's `apply.mjs` they pass. Task 1 had to hold the implementation, because the tracer needed it, so the RED run was taken by putting the earlier `apply.mjs` back for the run only. No existing case changed.

## Task 3: the theme as a ConfigMap

Chart `sterling-keycloak-theme` 0.1.0 renders ConfigMap `sterling-login-theme` with `theme.properties` and `footer.ftl` from `files/`. The descriptor puts it in `sterling-identity` at order 54, before `keycloakx` at 55, with no images and no site file. `keycloakx.yaml` adds volume `login-theme` (ConfigMap `sterling-login-theme`, `optional: false`) mounted read-only at `/opt/keycloak/themes/sterling/login`. One render case checks both releases.

## Verification

- `deploy/test/realm.test.mjs`, `render.test.mjs` and `rke2.test.mjs` with the pinned helm, under the memory cap: 36 run, 36 pass (the global render invariants and the namespace coverage included). This plan added 5 cases to realm.test.mjs.
- `node deploy/keycloak/apply.mjs --site deploy/test/fixtures/site.ci.yaml --dry-run` exits 0; `footer.ftl` has `sterlingSystemUseNotice` and no `no_esc`; `theme.properties` has the line `parent=keycloak.v2`.
- `node scripts/resource-check.mjs`: passed, 141 resources; the component catalogue matches.

## Deviations from Plan

**1. [Rule 1 - Bug] Apostrophes disappeared on the page.** Keycloak formats realm messages with MessageFormat. `apply.mjs` now writes the notice with `'` doubled and `{` `}` quoted, and the behaviour "a notice with quotes, an apostrophe and accented letters survives unchanged" is checked on the page (tracer) and as the quoted form in `localizationTexts` (test). Commit `f0e5175a`.

**2. The French page is reached through the language picker or `ui_locales`,** not `kc_locale` on the first authorization request, which Keycloak 26.8.2 ignores there. The plan's check is met with the picker's `kc_locale=fr`.

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

- Files exist: Chart.yaml, theme.yaml, theme.properties, footer.ftl, sterling-keycloak-theme.release.json.
- Commits `f0e5175a`, `4e247eb1` and `1f939b57` are ancestors of HEAD.

## Open conditions

- The default English and French wording needs your organization's legal review (47-COMPLIANCE-CONTEXT owner item 7).
- A real browser with a passkey, the console's script redirect, and the theme mounted from the ConfigMap in a cluster belong to the lab run (47-18).
- Node console and SSH banners with the same text are the OS hardening baseline's (D-76, runbook line), not this plan's.
