---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 20
subsystem: deploy
status: complete
tags: [guests, keycloak, fgap-v2, openbao, cronjob, image, dep-13, ac-2, d-63, d-65]
requires: [47-16, 47-19, 47-23, 47-34, 71-12]
provides:
  - "Client sterling-guest-expiry in realm.json (client scopes basic and kc-admin-api, no optional scope, fullScopeAllowed false) and its checkRealm rules; adminPermissionsEnabled on exactly when guests are on"
  - "deploy/keycloak/admin-permissions.mjs: the idempotent admin REST step that grants the client its one fine-grained permission (view, view-members, manage-members on the group guests), run by the realm applier Job after keycloak-config-cli when guests are on"
  - "guests.mjs expire --in-cluster (expireInCluster, kubeSessions); users.mjs httpCall and clientCredentialsToken"
  - "Image sterling/guest-expiry (deploy/images/guest-expiry) on ubi9/nodejs-22-minimal by digest, its lock entry and its own runtime register entry"
  - "Realm release with guests on: CronJob, ServiceAccount, Role and RoleBinding sterling-guest-expiry; Secret sterling-guest-expiry declared for install.mjs secrets"
affects: [47-18, 47-21, 47-31, 47-33, 48]
tech-stack:
  added: []
  patterns:
    - "A setting keycloak-config-cli cannot apply is written by an idempotent REST step in the same applier Job, with pinned request bodies, read before written"
    - "A per-image build-context allow-list (<Containerfile>.dockerignore) leaves the root .dockerignore to the relay and the hub"
key-files:
  created:
    - deploy/keycloak/admin-permissions.mjs
    - deploy/images/guest-expiry/Containerfile
    - deploy/images/guest-expiry/Containerfile.dockerignore
    - deploy/images/guest-expiry/image.json
    - deploy/charts/sterling-keycloak-realm/templates/guest-expiry.yaml
  modified:
    - deploy/keycloak/realm.json
    - deploy/keycloak/apply.mjs
    - deploy/keycloak/guests.mjs
    - deploy/keycloak/users.mjs
    - deploy/charts/sterling-keycloak-realm/templates/job.yaml
    - deploy/charts/sterling-keycloak-realm/values.yaml
    - deploy/values/sterling-keycloak-realm.release.json
    - deploy/values/site.example/sterling-keycloak-realm.yaml
    - deploy/bundle/images.lock.json
    - deploy/images/README.md
    - deploy/test/guests.test.mjs
    - deploy/test/realm.test.mjs
    - deploy/test/install.test.mjs
    - compliance/resources.json
    - compliance/gaps.json
key-decisions:
  - "keycloak-config-cli 6.5.1 refuses the admin-permissions client under fine-grained admin permissions v2 (HTTP 403); the coordinator chose the plan's fallback (2026-11-25): an idempotent admin REST step in the realm applier Job, after keycloak-config-cli, signing in as the same applier client"
  - "The expiry client's token takes client scopes basic and kc-admin-api only: Keycloak 26.8 answers 401 to an admin API token without the admin API audience, and basic keeps sub for OpenBao's user_claim; fullScopeAllowed false keeps every role out of the token"
  - "No realm-management role at all on the service account, query-users and query-groups included: the probe needed neither, so checkRealm and the REST step refuse every one"
  - "The base is split, not shared: a new runtime entry image:registry.access.redhat.com/ubi9/nodejs-22-minimal (component keycloak, crypto uses-platform). Sharing passed the checker with scope runtime, but one entry cannot be both the landing page's theia-cloud build stage with crypto none and this keycloak runtime that makes TLS calls (owner item 20's named alternative)"
  - "With guests off the realm release renders as before: the same Job name and containers, plus one environment variable for the client's secret"
requirements-completed: [DEP-13]
duration: ~3h (with the first stop at the checkpoint)
completed: 2026-11-25
estimate:
  tokens: 85044
  tasks: 3
actuals:
  tokens: 23500
  tasks: 3
  commits: 2
plan_head_before: 3f6aea48438a8a76431b4fd5411b8800742f01d5
plan_head_after: 64c259383ee3c973cb30f70f8cb168f1444f769d
---

# Phase 47 Plan 20: The automatic end of guest accounts Summary

**A guest past their end date is now ended without an operator by the CronJob sterling-guest-expiry, from our own signed image, with credentials that reach members of the group guests only: in Keycloak one fine-grained permission that the realm applier grants after keycloak-config-cli, in OpenBao the 5-minute guest-expiry token, in Kubernetes get, list and delete on Session records. Shown end to end on Keycloak 26.8.2 and OpenBao 2.7.3 with the built image.**

## Performance

- Tasks: 3 of 3, in one code commit `15c55147` (deviation 4), and `64c25938` (gaps G446, G421 and G449). The first run stopped at the plan's Task 1 checkpoint (`47-20-CHECKPOINT.md`, commit `3f6aea48`); the coordinator chose option 1 on 2026-11-25 and the plan continued.
- Base check: 47-16 (`install.mjs secrets` and its descriptor shape), 47-19 (`expireGuests`, the jwt role `guest-expiry`), 47-23 and 71-12 are on the base. `CREDENTIAL_CARD_REACHABLE` stays false and G465 stays open: nothing here needs either.

## The permission probe (the evidence 47-31 relies on)

Run twice on Keycloak 26.8.2 with the job's own client-credentials token and no realm-management role: first with the permission made through the admin console's REST calls (the checkpoint), then with the permission granted by the built image's step (the tracer below). Both times:

| # | Operation the job uses | Guest | Staff S |
|---|---|---|---|
| 1 | `GET group-by-path/guests`, `GET groups/{id}/members?briefRepresentation=false` | 200, 200; the guest listed with attributes | S not listed |
| 2 | `GET users/{id}` | 200 | 403 |
| 3 | `GET users/{id}/role-mappings` | 200 | 403 |
| 4 | `GET users/{id}/groups` | 200 | 403 |
| 5 | `PUT users/{id}` `enabled: false` | 204 | 403 |
| 6 | `PUT users/{id}` with `guestEndedAt` and `guestEndedReason` added | 204; the other attributes unchanged | 403 |
| 7 | `POST users/{id}/logout` | 204 | 403 |

No row needed its alternative. Also refused with the job's token: `GET users?username=`, `GET users/{S}/credentials`, `GET clients`, `GET groups` (all 403). Before the step granted the permission, the same token got 403 on every row: the client by itself reaches nothing. Service account roles: `default-roles-sterling` only, and `fullScopeAllowed: false` keeps it out of the token. **47-31 relies on this table, rows 1 and 7.**

## Tracer (Task 1, re-run end to end after Tasks 2 and 3)

Under the heavy lock and the memory cap. The image built with podman from the repository root (`podman build -f deploy/images/guest-expiry/Containerfile .`); Keycloak `quay.io/keycloak/keycloak@sha256:75b5c435...` (26.8.2, https with a throwaway CA); keycloak-config-cli `@sha256:303b5c80...` (6.5.1) applying the realm `apply.mjs` prepares for the CI site with guests on (checkRealm problems 0); OpenBao `openbao-ubi@sha256:bb94f6b1...` (2.7.3 dev, https) configured by `deploy/openbao/apply.mjs` with the realm's RS256 key. A master-realm client with a service account and the role `admin` stood in for the site's `keycloak-realm-applier`. Containers and network were removed in the same run.

```
image: uid=1001; node v22.23.4; /opt/sterling holds deploy/{bundle/{lib,signed-file.mjs},keycloak,openbao} only; touch /opt/sterling/x: Permission denied
       user 1001, entrypoint [node /opt/sterling/deploy/keycloak/guests.mjs]
realm (guests on): keycloak-config-cli ran in 00:04.759 (adminPermissionsEnabled true, client sterling-guest-expiry)
applier client as made (default scopes acr, basic, email, profile, roles, service_account, web-origins):
  permission step from the built image: exit 1 "read the realm: Keycloak answered 401"           (deviation 2)
kc-admin-api added to the applier client's default scopes (admin-cli has it by default):
  permission step run 2: exit 0  written: client policy / written: permission on the group guests
  permission step run 3: exit 0  unchanged: client policy / unchanged: permission on the group guests
enrol.mjs enrol: ada.observer (guest A), bo.observer (guest B), sam.staff (S) -> exit 0 each; guest entities hold ["guest-account"]
A's end moved into the past through the admin API
the built image: expire --in-cluster --no-sessions (read-only root, all capabilities dropped, user 1001) -> exit 0
  ended ada.observer: end date 2026-11-25T19:51:30Z passed
A: enabled false; guestEndedAt 2026-11-25T20:51:30Z; guestEndedReason "end date ... passed"; other attributes kept; Keycloak sessions 0
A: entity guest-<A> disabled true, policies ["guest-account"]; end record guest-<A>-20261125T205130Z filed
B unchanged (entity enabled); S unchanged (entity enabled)
with the job's own credentials: disable S in Keycloak -> 403
  OpenBao login guest-expiry: policies ["guest-expiry"], ttl 300 s
  disable keycloak-<S> in OpenBao -> 403
  set policies on guest-<B> -> 403
the probe table again on guest B and staff S: every row as in the table above
```

`deploy/openbao/apply.mjs` stopped at `kubernetes config (this cluster)` in the dev container (no in-cluster service account file); everything before it, the guest-expiry policy and jwt role included, was written, as the login shows.

## Task 2: the client's rules, the lock, the release and the register (TDD)

RED: on the base's `apply.mjs` and `realm.json` the four new realm cases fail (the client, its three token settings, its service account and the admin-permissions client, the realm switch). GREEN after the change. The client settings each have a refusal case: `defaultClientScopes` other than exactly `["basic","kc-admin-api"]` (missing one, one more, absent), `optionalClientScopes` not `[]` (one, absent), `fullScopeAllowed` not `false` (true, absent).

- `images.lock.json` lists `sterling/guest-expiry` under `built` (component `keycloak`, digest null until deploy-images publishes it).
- The release descriptor sets `guests.image` from it and declares Secret `sterling-guest-expiry` (key `client-secret`, 32 random bytes, kept in OpenBao `kv/apps/guest-expiry`). `install.test.mjs`'s secrets case now also expects that write and Secret and checks the value never reaches an argv.
- Register: the checker passed on a working copy with the shared `nodejs-22` entry at scope `runtime` and the new Containerfile in its `where`, but that entry's `component` (theia-cloud) and `crypto` (none) cannot describe this runtime, so the entries are separate. `node scripts/resource-check.mjs`: "Compliance fit check passed: 142 resources, each with a reviewed entry in compliance/resources.json." The component catalogue was regenerated in the same commit; `--check` matches.

## The permission step and the runner (Task 1, TDD)

Both were written before their tests, so their RED is the module-level one: the new cases did not load on the base (`does not provide an export named 'expireInCluster'`, `Cannot find module ... admin-permissions.mjs`). The cases:
- the step's exact request bodies on the first run (POST the client policy, POST the scope permission) and no write on the second; a drifted permission (an extra scope, another group, resource type Users) and a policy naming another client are written back to the pinned bodies; a switched-off realm, a realm-management role (`view-users` or `query-users`) and another permission on the client's policy are refused before any write;
- the runner: the token request carries the secret only in the Basic header (and in no URL or body); the OpenBao login names role `guest-expiry` with the client's token; only the guest's Session record is deleted, with the ServiceAccount token; revoke-self at the end; a refused OpenBao login still ends the guest in Keycloak and exits non-zero; missing settings and a refused client stop it.

## Task 3: the CronJob in the realm release (TDD)

RED: on the base chart the three render cases fail (guests off already, for the applier's new secret variable). GREEN after the template. With the CI site (guests off) the release renders a ConfigMap and the Job only, unchanged but for `STERLING_GUEST_EXPIRY_CLIENT_SECRET`; the Job keeps its name. With guests on it renders the CronJob (`*/15 * * * *`, Forbid, history 3 and 3, the locked image by digest, non-root, read-only root, capabilities dropped, RuntimeDefault, 128Mi, the secret at 0400, the site CA), the Role (`get`, `list`, `delete` on `sessions` of `theia.cloud` in `theia-cloud`, nothing else), the RoleBinding and the ServiceAccount (automount off; the CronJob pod alone mounts a token). The applier Job then runs keycloak-config-cli as an init container and `guest-expiry-permission` after it, with automount still off. `checkMinutes` outside 1 to 59 stops the render. `apply.mjs` hands helm the `--realm-site` file it checked (install.mjs already passes the site's own file); `node deploy/keycloak/apply.mjs --site deploy/test/fixtures/site.ci.yaml --dry-run` exits 0.

Lab proof pending: the CronJob in a cluster (the Session stop through the API, the RBAC, Kyverno admitting the signed image, the Job's init order) belongs to the phase verification lab run with guests on (G423).

## Verification

- `deploy/test/*.test.mjs` with the pinned helm and cosign, under the memory cap, once: 295 run, 295 pass (14 added by this plan: 7 in realm.test.mjs, 7 in guests.test.mjs; one install case extended).
- `scripts/test/resource-check.test.mjs` and `component-catalogue.test.mjs`: 20 run, 20 pass. `node scripts/resource-check.mjs` passes (142 resources); `build-component-catalogue.mjs --check` and `build-road-to-production.mjs --check` match.
- Compliance gap, noStatus, riskAcceptance and releaseEvidence tests after G446 and the G421 and G449 wording: 59 run, 59 pass (the register count assertion moves from 453 to 454). The secret scan is clean.

## Deviations from Plan

**1. [Checkpoint, decided] The permission is written by a REST step, not by keycloak-config-cli.** keycloak-config-cli 6.5.1 skips and then fails on the `admin-permissions` client under v2 (HTTP 403, `47-20-CHECKPOINT.md`). Coordinator's decision 2026-11-25: the plan's own fallback. checkRealm cannot see the permission, so the step carries the rule (only `guests`, only the three scopes, nothing else on the client's policy) and its tests pin the bodies; checkRealm refuses an `admin-permissions` client in realm.json.

**2. [Rule 3 - Blocking, found by the tracer] The applier client needs the client scope `kc-admin-api`.** On Keycloak 26.8 a master-realm client's token without the admin API audience gets 401 on realm sterling, for keycloak-config-cli's client-credentials login as much as for the step. The site's `keycloak-realm-applier` client is not declared anywhere yet (G421); its remediation now says it must carry `kc-admin-api`.

**3. [Rule 2 - Security] No realm-management role at all.** The plan allowed `query-users` or `query-groups` if needed; the probe needed neither, so both checkRealm and the step refuse every role.

**4. One code commit for three tasks.** `guests.test.mjs`, `realm.test.mjs` and `apply.mjs` carry parts of all three tasks; splitting them needs interactive staging, which is not available here.

**5. [Rule 3 - Blocking] `<Containerfile>.dockerignore`.** The root `.dockerignore` is the relay's and hub's allow-list and a hub test fixes its lines, so the image has its own allow-list beside its Containerfile, which docker BuildKit and podman both read (shown by the podman build: only `deploy/` reached the image). The image also copies `deploy/bundle/signed-file.mjs`, which `users.mjs` imports.

**6. [Rule 2] The applier Job's name includes the step's image only with guests on**, so a new image runs the step again and a site without guests keeps the same Job.

**7. [Tests] `install.test.mjs`'s secrets case** expects the new Secret in its exact lists and checks its value never reaches an argv (extended, not weakened).

## For Phase 48

Candidate control statements (D-65), not written here: AC-2 and AC-2(2) (the automatic end at the end date), AC-2(4) (Keycloak admin events and the job's log record each end), IA-8 (non-organizational users), IA-12 and PS-7 (external personnel), on `keycloak` and `openbao`.

## Known Stubs

None.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: new-admin-write | deploy/keycloak/admin-permissions.mjs | The realm applier Job now writes one fine-grained admin permission through the admin REST API with the master-realm applier client; it writes only the pinned policy and permission and refuses to run when anything else uses the client's policy (T-47-69) |

## Self-Check: PASSED

- Files exist: admin-permissions.mjs, the Containerfile, its .dockerignore, image.json, guest-expiry.yaml.
- Commits `15c55147` and `64c25938` are ancestors of HEAD.

## Hand-offs

- 47-31 reuses this client's shape and the runner's functions (`clientCredentialsToken`, `httpCall`, `kubeSessions`) and relies on the probe table above; its client holds `view-users` on purpose and must not use `admin-permissions.mjs`'s policy.
- 47-33 builds into the same image; the register entry's purpose already names it.
- The deploy-images workflow publishes `sterling/guest-expiry`; its lock digest stays null until then, like every built image.

## Open conditions

- G449 and G465: guests stay off, so neither the CronJob nor the permission step renders at any site until the credential card is reachable.
- G421: the site's `keycloak-realm-applier` client is not declared yet, and it must carry the client scope `kc-admin-api` on Keycloak 26.8.
- G423: the CronJob in a cluster (the Session stop through the Kubernetes API, the Role, Kyverno admitting the signed image, the applier Job's init order) belongs to the lab run with guests on (47-18).
