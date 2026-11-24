---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 17
subsystem: deploy
status: complete
tags: [runbooks, dep-11, key-ceremony, escrow, recovery, backup, enrolment, session-states]
requires: [47-05, 47-06, 47-07, 47-08, 47-10, 47-11, 47-12, 47-13, 47-14, 47-15, 47-22, 47-25]
provides:
  - "deploy/runbooks/README.md and nine runbooks: site-install, bundle-update, key-ceremony, enrolment, re-enrolment-and-recovery, moving-a-person, backup-and-restore, recovery-plan, session-states (maintenance.md is 47-28's)"
affects: [47-18, 47-21, 47-29, 47-30, 47-33, 48.1]
tech-stack:
  added: []
  patterns:
    - "Each runbook starts with what it is for, who does it and what they need; every command shown exists or is named with the plan that delivers it"
key-files:
  created:
    - deploy/runbooks/README.md
    - deploy/runbooks/site-install.md
    - deploy/runbooks/bundle-update.md
    - deploy/runbooks/key-ceremony.md
    - deploy/runbooks/enrolment.md
    - deploy/runbooks/re-enrolment-and-recovery.md
    - deploy/runbooks/moving-a-person.md
    - deploy/runbooks/backup-and-restore.md
    - deploy/runbooks/recovery-plan.md
    - deploy/runbooks/session-states.md
  modified: []
key-decisions:
  - "site-install.md follows the order the scripts actually need: bundle check, bootstrap CA, node files (file items extracted with the pinned hauler, since the import needs a registry), RKE2 on each node, registry, import, preflight, apply with the two ceremony stops (--from 40 after the unseal, --from 46 after the intermediate), status, admission to Deny, retire-bootstrap"
  - "The secrets step runs inside apply after the unseal (47-16); the runbook names install.mjs secrets as the same step on its own"
  - "Commands that later plans deliver are named with their plan and not as repository paths: offsite.mjs (47-33), pkcs11-sign.mjs and the softhsm-signing-token rule (48.1-17), new-dev-site-key.sh (48.1-22)"
  - "The RTO and RPO values are written in recovery-plan.md (480 and 1440): the plan's verify requires them, and they are the owner's accepted decision c"
requirements-completed: [DEP-11]
duration: ~1h
completed: 2026-11-24
estimate:
  tokens: 80000
  tasks: 3
actuals:
  tokens: 9800
  tasks: 3
  commits: 3
plan_head_before: b324400c
plan_head_after: ba51cb06
---

# Phase 47 Plan 17: The operator runbooks Summary

**Ten runbooks, in plain words, take a site operator and the key custodians from an air-gapped install through updates, the key ceremony, enrolment, recovery and maintenance, naming only commands the repository has (or the plan that delivers them).**

## Performance

- Tasks: 3 of 3. Commits: `37bcbd1c` (Task 1), `ab4628c1` (Task 2), `ba51cb06` (Task 3).

## What each task wrote

- **Task 1.** `README.md` (the ten runbooks and the order a new site uses them); `site-install.md` (prerequisites: FIPS nodes, OS repository packages including `httpd-tools` and `chrony`, install media, the on-site time source with `time.servers`, `time.refclocks`, `time.nts`, `time.maxClockErrorMs` and the import host's chrony from `clock.mjs`, login banners matching `systemUseNotice`, the security-relevant site settings; every `install.mjs` step in order; the first escrow; the egress confirmation); `bundle-update.md` (check, import, preflight, apply again, escrow checks after an update, the last two bundles kept, going back).
- **Task 2.** `key-ceremony.md` (HQ root and its revocation list validity, a site intermediate by signed file with `pki-files.mjs csr` and `import-intermediate`, HSM or Shamir, `bao operator init` and recovery key custody, `key-custodians`, the release key in `container-release` and the site key in the HSM by PKCS#11 URI, SoftHSM2 only in development, HSM backup to a second HSM with `escrow.mjs record-key-backup`, Transit keys auditors verify with their fingerprints, split knowledge, escrow custody apart from the backups); `enrolment.md` (`webauthn-register-passwordless`, both `signInKeys` levels, same-device passkeys, `enrol.mjs enrol`); `re-enrolment-and-recovery.md` (no recovery codes; in-person confirmation; `enrol.mjs rebind`); `moving-a-person.md` (`users.mjs export` with the site key's PKCS#11 URI as `--key`, `users.mjs import`, Control Group approvals at both sites).
- **Task 3.** `backup-and-restore.md` (etcd and `cluster-reset` with the escrowed token, `openbao-raft-snapshot`, the `pg_dump` nightly, volumes with `longhorn-crypto` restored first, hubs as a rollback, `sterling-snapshots` and `rename_pattern`, the registry rebuilt from the bundle, SoftHSM2 in the lab only, the off-site copy with `offsite.mjs verify`); `recovery-plan.md` (the order with the audit gate, RTO 480 and RPO 1440, degraded modes, the `sterling-restore-test/1` record field by field, `drill.mjs verify` and `record --add-step`, the quarterly drill from the off-site copy); `session-states.md` (the ten states with what to do).

Names were checked against the code: the Keycloak StatefulSet is `keycloakx`, the operator Deployment is `operator-deployment`, session pods carry `sterling-session`, the Postgres dump runs at 00:30 UTC and is kept 14 days, snapshots 7 and backups 14.

## Verification

- The three task verifies pass (terms per runbook, every `install.mjs` step in `site-install.md`, every backticked `deploy/...` path exists in all eleven runbooks).
- No runbook states a capacity figure; idle settings are marked provisional until Phase 48.
- **Wave 7 close** (47-16, 47-17, 47-27, 47-28 together):
  - `deploy/test/*.test.mjs` with the pinned helm 4.3.2 and cosign 3.1.4 under the cap: 162 run, 162 pass, 0 skipped. Added in wave 7: 46 (20 install, 13 drill, 12 maintenance, 1 render).
  - `compliance/test/gaps.test.ts`: 19 pass (count 393 to 396 for G421, G423, G424).
  - `node scripts/build-road-to-production.mjs --check` and `node scripts/resource-check.mjs`: pass.

## Deviations from Plan

- **The install order** in `site-install.md` differs from the plan's list where the scripts require it (decisions): the bootstrap CA comes before the node files, and the secrets step runs inside apply.
- **Future commands** are named with their plan, not as paths (decisions).

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

- The ten runbooks exist; commits `37bcbd1c`, `ab4628c1` and `ba51cb06` are ancestors of HEAD.

## Open conditions

- G423: the runbooks have not been walked on a cluster; 47-18 walks site-install, key-ceremony, backup-and-restore and recovery-plan and corrects each step that differs.
