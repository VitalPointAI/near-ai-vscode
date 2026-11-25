---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 28
subsystem: deploy
status: complete
tags: [maintenance, ma-2, ma-6, si-2, cm-4, certificates, drain, upgrade, rke2, lab-vm]
requires: [47-11, 47-13, 47-22]
provides:
  - "deploy/bundle/maintenance.mjs: cert-check, drain-check, upgrade-check (exports certCheck, drainCheck, upgradeCheck)"
  - "deploy/runbooks/maintenance.md: patching and drain, RKE2 upgrade order, certificates, HSM firmware, patch timelines, records and spares"
affects: [47-17, 47-18, 47-29, 48.1-04]
tech-stack:
  added: []
  patterns:
    - "Each risky maintenance step starts with a check that refuses before harm"
key-files:
  created:
    - deploy/bundle/maintenance.mjs
    - deploy/test/maintenance.test.mjs
    - deploy/runbooks/maintenance.md
  modified: []
key-decisions:
  - "Confirmed on docs.rke2.io (Certificates): RKE2 client and server certificates are valid 365 days; any expired or within 120 days of expiry is renewed each time RKE2 starts (since v1.33.1+rke2r1; 90 days before); rke2 certificate rotate makes new ones. cert-check's API server message and the runbook say so"
  - "A missing CronJob is its own refusal ('not installed, so there is no backup from it'), not a stale backup with a command that cannot work"
  - "The API server certificate is read by a TLS handshake with the kubeconfig's CA; the TLS server name is set only for a host name, never for an IP address"
  - "Versions compare as numbers (major, minor, patch, rke2r), so 1.37.10 is above 1.37.9"
requirements-completed: [DEP-02, DEP-11]
duration: ~1h
completed: 2026-11-24
estimate:
  tokens: 50000
  tasks: 3
actuals:
  tokens: 8400
  tasks: 3
  commits: 2
plan_head_before: b324400c
plan_head_after: d0589d64
---

# Phase 47 Plan 28: Maintenance checks and runbook Summary

**Three checks now refuse the dangerous maintenance mistakes before they happen, and on an air-gapped RKE2 node cert-check refused a 30-day site intermediate at the 90-day horizon and passed it at 10, drain-check refused draining the only etcd server, and upgrade-check named the missing etcd snapshot until one was taken.**

## Performance

- Tasks: 3 of 3. Commits: `fbbef17e` (Tasks 1 and 2: one module and one test file), `d0589d64` (Task 3, the runbook).

## Task 1: cert-check against a real API server

On the wave-7 lab VM (RKE2 v1.37.2+rke2r1 from 47-16's node folder), through an SSH forward of the API server, with the guest's own kubectl. A stand-in `sterling-site-ca` ConfigMap in `cert-manager` holds a chain made with openssl in the scratchpad: a 30-day intermediate signed by a 400-day root. The cluster has no cert-manager, so no Certificates are listed.

```
node deploy/bundle/maintenance.mjs cert-check
  cert-check: the site CA chain's site intermediate (CN=Lab site intermediate) expires Dec 24 23:03:03 2026 GMT, in 29 days (horizon 90):
  renew it through the key ceremony: pki-files.mjs csr, signed by the HQ root (key-ceremony.md).        exit 1
node deploy/bundle/maintenance.mjs cert-check --horizon-days 10      cert-check: no problem found.     exit 0
node deploy/bundle/maintenance.mjs cert-check --horizon-days 400 (to show every source is read)
  ... site intermediate ... in 29 days; ... HQ root (CN=Lab HQ root) ... in 399 days: renew it in HQ's key ceremony.
  the API server certificate expires Nov 24 22:00:20 2027 GMT, in 364 days (horizon 400): restart rke2-server on each server, one at a time
  (RKE2 renews certificates within 120 days of expiry when it starts), or run rke2 certificate rotate.  exit 1
```

The same run also exercised the other two checks against the real node:

```
node deploy/bundle/maintenance.mjs drain-check --node sterling-lab --site <lab site>
  drain-check: draining sterling-lab leaves 0 Ready etcd servers of 1; etcd needs 1 to keep quorum.   exit 1
node deploy/bundle/maintenance.mjs upgrade-check --bundle <manifest with rke2 1.38.0+rke2r1> --site <lab site>
  the newest etcd snapshot is missing, older than 24 hours: run rke2 etcd-snapshot save on a server.
  CronJob sterling-openbao/openbao-raft-snapshot ... CronJob sterling-identity/sterling-postgres-dump ... (not installed in lab-core)
  the site intermediate ... (the cert-check problem)                                                    exit 1
rke2 etcd-snapshot save --name before-upgrade -> Snapshot before-upgrade-sterling-lab-1795561410 saved.
upgrade-check again -> the etcd problem is gone (read from ETCDSnapshotFile); the rest remain.         exit 1
```

The CronJob wording was then corrected to "not installed, so there is no backup from it; install its release before an upgrade" (decisions). `vm.sh down`: stopped, lock released.

## Task 2: drain-check and upgrade-check

`deploy/test/maintenance.test.mjs`, 12 cases on kubectl fixtures: the five cert-check cases (Ready, not Ready, overdue and within 7 days, an intermediate and a root inside the horizon with their actions, the API certificate), etcd quorum refused and allowed, an OpenBao server while another is not Ready, a volume's only healthy replica refused, a degraded one warned and Longhorn skipped on other storage, hubs and sessions warned, version rules (no version, downgrade including the rke2r number, two minor steps, a node not Ready, mixed versions, numeric compare), stale and missing backups with their commands and the flag's limit, and cert-check problems inside upgrade-check.

First run: 11 of 12 passed; the failing case compared a recorded kubectl call without its `-o json` suffix (a test mistake, fixed in the test).

## Task 3: the maintenance runbook

`deploy/runbooks/maintenance.md`: before any maintenance (the change log, cert-check, tell people, fresh backups); node OS patching one node at a time (drain-check, cordon and drain, update from the site repository, `check-time.sh`, uncordon, wait for healthy volumes); the RKE2 upgrade (bundle-update.md, upgrade-check, servers one at a time then agents, `rke2 etcd-snapshot save`, the new node folder's `install-node.sh`, one minor version per bundle, never a downgrade); certificates (cert-manager, the site intermediate by `pki-files.mjs csr`, the HQ root, RKE2's 120-day renewal); HSM firmware (CMVP-listed versions only, a snapshot first, one OpenBao pod at a time); patch timelines left to your organization; records and spares. The plan's verify (terms and every `deploy/...` path) passes.

## Verification

- `deploy/test/maintenance.test.mjs`: 12 run, 12 pass (all added).
- Wave close: see 47-17-SUMMARY.md.

## Deviations from Plan

**1. [Rule 1 - Bug] Node's deprecation of an IP TLS server name** (found in the lab): the server name is set only for host names. Commit `fbbef17e`.

**2. Missing CronJob wording** (found in the lab): a missing CronJob gets its own message. Commit `fbbef17e`.

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

- Files exist: maintenance.mjs, maintenance.test.mjs, maintenance.md.
- Commits `fbbef17e` and `d0589d64` are ancestors of HEAD.

## Open conditions

- G424: drain-check's Longhorn and OpenBao rules have run only on fixtures; they run on Phase 48's multi-node lab-full rig.
