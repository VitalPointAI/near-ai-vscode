---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 34
subsystem: deploy, workbench
status: complete
tags: [guests, retention, si-12, ac-2, openbao, alertmanager, workbench, step-up]
requires: [47-19, 47-24, 48.1-02]
provides:
  - "End records sterling-guest-ended/1 (removeAfter = end + guests.retentionDays) filed by every end of an enrolled guest"
  - "OpenBao: policies guest-secrets-removal, guest-retention-check, security-officer-notices; jwt roles guest-secrets-removal and security-officer-notices bound to the site's securityOfficers; kubernetes role guest-retention-check"
  - "CronJob guest-retention-check: hourly, read-only but for the notice; alert GuestSecretsAwaitRemoval through Alertmanager"
  - "Workbench: GuestSecretsService (notice, candidates, remove) and the command Remove ended guests' secrets with the hourly notice"
affects: [47-20, 47-21, 47-31, 48.1-23]
tech-stack:
  added: []
  patterns:
    - "Officer authority in OpenBao: a jwt role bound to the step-up acr and to subjects the site file names, never Keycloak groups or claims"
    - "A count-only notice that a job writes and only officers can read"
key-files:
  created:
    - deploy/openbao/policies/guest-secrets-removal.hcl
    - deploy/openbao/policies/guest-retention-check.hcl
    - deploy/openbao/policies/security-officer-notices.hcl
    - workbench/extension/src/common/guest-secrets.ts
    - workbench/extension/src/node/guest-secrets-service.ts
    - workbench/extension/src/node/guest-secrets-backend-module.ts
    - workbench/extension/src/browser/guest-secrets-frontend-module.ts
    - workbench/test/guest-secrets-service.test.ts
  modified:
    - deploy/keycloak/guests.mjs
    - deploy/openbao/apply.mjs
    - deploy/openbao/policies/guest-operator.hcl
    - deploy/openbao/policies/guest-expiry.hcl
    - deploy/openbao/policies/guest-removal.hcl
    - deploy/values/openbao.yaml
    - deploy/values/site.example.yaml
    - deploy/values/site.example/sterling-keycloak-realm.yaml
    - deploy/test/fixtures/site.ci.yaml
    - deploy/test/guests.test.mjs
    - deploy/test/openbao.test.mjs
    - workbench/extension/package.json
    - compliance/gaps.json
key-decisions:
  - "D-84 (owner-confirmed 2026-11-25): option (a) with the notify addition, recorded in 47-CONTEXT.md; plan 47-34 added rather than stretching 47-19 or 47-21, because it spans OpenBao, a job and the workbench"
  - "Who is a security officer is the site file's securityOfficers (Keycloak ids named at the key ceremony), the same pattern 71-12 uses for credentialIssuers; with none named, both officer roles bind the subject not-set, so a removed officer never stays admitted"
  - "The job knows whose secrets wait without reading anyone's KV path: every end files an end record, and the officer's removal files a removal record; pending = newest end record per guest, past removeAfter, entity disabled, no removal record"
  - "The end record is keyed by the recorded end time, so ending again files nothing new and a guest extended and ended later gets a new record; the newest counts"
  - "The alert is posted to Alertmanager's API with a 3-hour endsAt by the hourly job; Alertmanager's repeat_interval re-sends the email while it lasts, and a count of 0 resolves it"
  - "Node's HTTP client has no LIST method, so the workbench lists with GET ?list=true"
requirements-completed: [DEP-13]
duration: ~1h30
completed: 2026-11-25
estimate:
  tokens: 70000
  tasks: 3
actuals:
  tokens: 27065
  tasks: 3
  commits: 3
plan_head_before: 6dbd8f27531960dcd632eb2defd2346f1a3706b7
plan_head_after: 6c17e4d14812f20a4d762190d920924323e9158a
---

# Phase 47 Plan 34: Removing ended guests' secrets Summary

**A security officer now removes ended guests' secrets in the workbench after a passkey step-up, with the delete held only by that officer's short step-up token, and an hourly read-only job reminds the officers by email and in the workbench, by count only, until they do; G447 is closed.**

## Performance

- Tasks: 3 of 3. Plan commit `6dbd8f27`; work commits `d4f6e532` (Tasks 1 and 2), `8712e071` (Task 3), `6c17e4d1` (G447 closed).
- `origin/main` (#202, #203) was merged into the branch first (`497e2b1d`).

## Task 1: end records and OpenBao as code (TDD)

RED: 9 cases failed (the end record, the retention setting, the three new policies, the two changed ones, the roles, and the per-person rule's exception). GREEN after:
- `guests.mjs`: every end of an enrolled guest files `sterling-guest-ended/1` (`entity`, `keycloakId`, `endedAt`, `removeAfter`) at `kv/data/site/guest-ended/guest-<id>-<end time>`, with `cas: 0`. A guest can't be created without `guests.retentionDays` (example: 365). `end` and `expire` now need `--realm-site`.
- **Policies:**
  - `guest-secrets-removal` lists and reads the records, creates and reads removal records, reads guest entities, and lists and deletes `kv/metadata/guests/*` (guests' secrets only; see the review fixes below; it first named `kv/metadata/users/*`).
  - `guest-retention-check` reads the records and writes only the notice.
  - `security-officer-notices` reads only the notice.
  - `guest-operator` and `guest-expiry` may create end records.
- **Roles:** jwt `guest-secrets-removal` (step-up acr plus the officers' subjects, the step-up window, that policy only), jwt `security-officer-notices` (the officers, 60 s), and kubernetes `guest-retention-check`. Officer ids must be lowercase UUIDs.
- **The per-person rule** in `openbao.test.mjs` now has exactly one named exception, `guest-secrets-removal.hcl`'s `kv/metadata/guests/*`. The test asserts that it exists and that no other policy can delete another person's secrets.

## Task 2: the retention check and its alert

CronJob `guest-retention-check` runs hourly with Forbid, the server image by digest, the restricted context, a read-only root and a projected token for its own audience. It counts pending guests, writes the notice, posts the alert, and prints the count only.

Proof, under the heavy lock: OpenBao 2.7.3 (our image) with `apply.mjs`'s policies and roles, Alertmanager v0.35.0 from the lock, and the rendered script run read-only as user 100 with a token holding only `guest-retention-check`:

```
apply.mjs: written policy guest-secrets-removal, guest-retention-check, security-officer-notices; jwt roles guest-secrets-removal,
  security-officer-notices; kubernetes role guest-retention-check
the rendered check (A past and disabled; B past but enabled again; C not yet past; D removed; E ended again later): exit 0;
  guests past retention with secrets not yet removed: 1
notice: {"checkedAt":"2026-11-25T12:23:59Z","count":1,"format":"sterling-notice/1"}
Alertmanager alerts: [{"name":"GuestSecretsAwaitRemoval","source":"guest-retention","summary":"... 1 ...","state":"active"}]
the check token reads a person's secret: 403; deletes it: 403; changes an entity: 403; writes an end record: 403
after A's removal record: exit 0; count 0; active alerts now: 0; notice count 0
```

## Task 3: the workbench (TDD)

`GuestSecretsService` and the frontend module (the notice every hour while the count is above 0, the command, the step-up prompt, a pick by end date, a confirm). `guest-secrets-service.test.ts` has 5 cases with a stateful fake. Proof with the service bundled from source against OpenBao 2.7.3 configured by `apply.mjs` for a site naming one officer:

```
officer notice(): {"kind":"ok","value":{"count":1,"checkedAt":"2026-11-25T12:40:00Z"}}
another person notice(): {"kind":"ok","value":null}
another person with a fresh step-up, candidates(): refused "Only your organization's security officers can remove ended guests' secrets."
the officer's token without the step-up acr, past the workbench guard, candidates(): refused (OpenBao's bound acr)
officer candidates(): [{"record":"guest-kc-ada-20250101T000000Z","endedAt":"2025-01-01T00:00:00Z","removeAfter":"2026-01-01T00:00:00Z"}]
officer remove(...): {"removed":2}; the guest's secrets after: none; staff's secret still there: true
removal record: {"entity":"guest-kc-ada","format":"sterling-guest-secrets-removed/1","record":"guest-kc-ada-20250101T000000Z","removedAt":"...","removedBy":"<officer entity>","secrets":2}
officer remove() again: refused "...removed already."
removal token: policies ["guest-secrets-removal"], ttl 300 s, explicit max 300 s; the officer's ordinary session token: ["sterling-workbench"]
```

## Verification

- `deploy/test/*.test.mjs` with the pinned helm and cosign: 239 run, 239 pass.
- Workbench `dist/test/*.test.js`: 119 run, 119 pass. `tsc --noEmit` is clean on `extension/tsconfig.json` and `tsconfig.json`.
- The root copy lint: 35 run, 35 pass.
- `compliance/test/*.test.ts`: 550 run, 550 pass. `build-road-to-production --check` and the secret scan are clean.
- Added by this plan: 2 cases in guests.test.mjs, 4 in openbao.test.mjs and 5 in guest-secrets-service.test.ts. One existing case in openbao.test.mjs gained the one exception D-84 names, and asserts that exception. The expected writes of two guests.test.mjs cases now include the end record, and the gap count assertion in the pull request's diff went from 422 to 424 (G448 and G449; merging main's own register entries later made it 434).

## Review fixes (PR #207 agent review)

- **Guests' secrets live apart from staff's.** New entity policy `guest-account`: `enrol.mjs` attaches it to every guest entity it makes or adopts (and refuses a guest entity holding any other policy). It denies `kv/users/<entity>/` on the same path `sterling-workbench` grants, so the deny wins, and gives the guest `kv/guests/<entity>/`. The workbench reads `identity_policies` from `lookup-self`: with `guest-account` the session's space is `guests`, and the key store and the person's DID record use `guests/<entity>/`. A re-login that changes the space fails the session. `guest-secrets-removal` now lists and deletes `kv/metadata/guests/*` only, so no officer request, the workbench's or a hand-made one, reaches a staff member's secrets. `guests.mjs` accepts `guest-account` as the one policy a guest may hold.
- **Residual risk, stated plainly:** OpenBao still cannot tell which guest. For the step-up window a named officer's hand-made request could delete the secrets of a guest who is still active. The workbench checks that the guest is disabled and past retention, and OpenBao's audit log records every request with the officer's entity (T-47-140).
- **Record first, then delete.** `remove()` writes the create-only removal record (cas 0) before any delete. If another officer wrote it first, the officer is told so and nothing is deleted; if the write fails, nothing is deleted. If a delete fails, the record stays, the guest is listed again, and the next removal finishes the deletes without a second record.
- **Guests stay off until 71-12.** The example realm settings ship `guests.maxDays: 0`. `guests.mjs create` and `extend` refuse a nonzero `maxDays` while this release has no `credential-issuers` policy (the 71-12 card), with a plain message and before any call; the site file cannot claim otherwise (G449).
- **The fail-closed check never passes a guest it could not check.** When a Keycloak or OpenBao read fails, `expireGuests` lists that guest as `unchecked` (the CLI prints it and exits 1), never as fine; a guest past their end is still ended.
- The `RAFT_SNAPSHOT` doc comment sits on its own constant again.

## Deviations from Plan

**1. [Rule 3] LIST as `GET ?list=true`** in the workbench (Node's HTTP client has no LIST method).

**2. [Rule 2] Malformed or non-guest record names are refused** before any call, and a walk of more than 10,000 secrets stops.

**3. Test and dependency setup only:** `workbench/node_modules` and `compliance/node_modules` were symlinked from sibling worktrees with the same lockfile to run the tests. The `compliance` one was removed afterwards; neither is committed.

## Known Stubs

None.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: per-person-exception | deploy/openbao/policies/guest-secrets-removal.hcl | A named officer's step-up token can list and delete guests' KV secrets (`kv/metadata/guests/*`) for at most the step-up window, and never a staff member's: every guest entity carries `guest-account`, which keeps its secrets under `kv/guests/` and denies it `kv/users/`. Residual: a hand-made request in the window could delete the secrets of a guest who is still active; the workbench refuses anything but a disabled guest past retention, and OpenBao audits every request (T-47-140, accepted residual risk under D-84) |

## Self-Check: PASSED

- Files exist: the three policies, the four workbench sources, the test file.
- Commits `d4f6e532`, `8712e071` and `6c17e4d1` are ancestors of HEAD.

## Hand-offs

- 47-21's runbook section 9 names the officer's step (amended in its plan).
- 47-20's in-cluster runner passes `retentionDays` to `expireGuests`.

## Open conditions

- G423: the job in a cluster (the projected-token login, Alertmanager's email to the site mail server) and the command in a real browser with a passkey step-up belong to the lab run (47-18).
- G449: guests stay off until a release includes 71-12.
