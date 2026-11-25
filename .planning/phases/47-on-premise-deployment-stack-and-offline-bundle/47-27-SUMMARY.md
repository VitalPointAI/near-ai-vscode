---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 27
subsystem: deploy
status: complete
tags: [contingency, cp-2, cp-9, cp-10, rto, rpo, restore-drill, restore-test-record]
requires: [47-11, 47-22, 47-25]
provides:
  - "deploy/bundle/lib/recovery.mjs: RECOVERY_GROUPS, RECORD_FORMAT, validateRecord, cronIntervalMinutes, scheduleProblems, computeStep, computeRecord"
  - "deploy/bundle/drill.mjs: plan, verify (postgres, registry-input, escrow, opensearch, volume; --confirm; --lab), record --check, record --add-step"
  - "Site setting recovery { rtoMinutes 480, rpoMinutes 1440 } in deploy/values/site.example.yaml"
  - "Record format sterling-restore-test/1"
affects: [47-17, 47-18, 47-24, 47-33, 48.1-13]
tech-stack:
  added: []
  patterns:
    - "Scratch-only restores: labelled sterling-drill=scratch, removed in finally paths, never touching live data"
key-files:
  created:
    - deploy/bundle/lib/recovery.mjs
    - deploy/bundle/drill.mjs
    - deploy/test/drill.test.mjs
  modified:
    - deploy/values/site.example.yaml
key-decisions:
  - "cronIntervalMinutes steps through 15 days, not 8, so a weekly schedule's gap is exact; it refuses an expression that fires less than twice in 15 days, and macros such as @daily"
  - "A record's achieved values are recomputed by the validator (minutes to two decimals); met is false for any step that did not pass, null when there is no backup time or no target"
  - "Components map to recovery groups: registry-input and escrow to platform, postgres to identity, opensearch to audit, a volume by its namespace (sterling-identity identity, sterling-hubs hubs, theia-cloud sessions)"
  - "The opensearch driver deletes the drill indices by name (action.destructive_requires_name refuses wildcard deletes)"
  - "The CI site file has no recovery object, so plan prints the targets as not set and exits 0 there; the site example carries 480 and 1440"
requirements-completed: [DEP-11, DEP-12]
duration: ~1h
completed: 2026-11-24
estimate:
  tokens: 60000
  tasks: 3
actuals:
  tokens: 13900
  tasks: 3
  commits: 1
plan_head_before: b324400c
plan_head_after: 9fc09856
---

# Phase 47 Plan 27: Recovery order, objectives and the restore drill Summary

**The recovery order, the 8-hour RTO and 24-hour RPO, every backup schedule measured against the RPO, and a restore drill that proves backups restore into scratch copies only are now one command each, with one validated sterling-restore-test/1 record per drill; on the lab VM an escrow drill against a real RKE2 node wrote a valid record.**

## Performance

- Tasks: 3 of 3 in one commit (`9fc09856`): the drivers of Tasks 2 and 3 share `drill.mjs` and its test file.

## Task 1: the plan from the real site files

CI site (no recovery set), `node deploy/bundle/drill.mjs plan --site deploy/test/fixtures/site.ci.yaml --site-dir deploy/values/site.example`:

```
RTO not set (owner item), RPO not set (owner item) (site-wide, recovery in the site file)
stage 0 platform        nodes; RKE2 by etcd restore with the escrowed token or a fresh install; the registry rebuilt from the last verified bundle
                        etcd: deploy/rke2/config.yaml etcd-snapshot-schedule-cron "0 */6 * * *", longest gap 360 minutes
1       secrets         the HSM and OpenBao
                        openbao-raft: no schedule found
2       identity        Keycloak and its Postgres
                        postgres-dump: CronJob sterling-postgres-dump "30 0 * * *", longest gap 1440 minutes
                        longhorn: RecurringJob sterling-daily-backup "0 2 * * *", longest gap 1440 minutes
3       registry        the registry's own service; admission back to Deny
gate    audit-pipeline  OpenSearch and Fluent Bit running before people return
4       sessions        ... longhorn: RecurringJob sterling-daily-backup "0 2 * * *", longest gap 1440 minutes
5       hubs            ... longhorn: RecurringJob sterling-daily-backup "0 2 * * *", longest gap 1440 minutes
6       audit           historical audit data from snapshots
                        opensearch-snapshot: no schedule found
exit 0
```

With the example's defaults (RTO 480, RPO 1440) every shipped schedule meets 1,440 minutes; the two schedules 47-24 adds are not on this branch yet, so plan exits 1 naming them:

```
plan: openbao-raft: no schedule found, so the RPO of 1440 minutes cannot be met for secrets.
plan: opensearch-snapshot: no schedule found, so the RPO of 1440 minutes cannot be met for audit.
```

With `rpoMinutes` 60:

```
plan: etcd: deploy/rke2/config.yaml etcd-snapshot-schedule-cron "0 */6 * * *" leaves up to 360 minutes between backups, more than the RPO of 60 minutes.
plan: postgres-dump: CronJob sterling-postgres-dump "30 0 * * *" leaves up to 1440 minutes between backups, more than the RPO of 60 minutes.
plan: longhorn: RecurringJob sterling-daily-backup "0 2 * * *" leaves up to 1440 minutes between backups, more than the RPO of 60 minutes.
(and the two missing schedules)   exit 1
```

## Tasks 2 and 3: the record and the drivers

13 test cases with a fake kubectl, one per behaviour line:

- the record validator (unknown group, finish before start, a wrong achieved value, an inconsistent met, an unknown result); the cron interval (360, 1440, 15, 4,320 for weekdays only; refuses `@daily` and an hour of 25); the plan's RPO refusal;
- verify refuses without `--confirm` or with another site name before any runner call;
- postgres: waits for a running dump, a restricted scratch pod (user 26, `sterling-drill=scratch`, `sterling/postgres` by digest, the dumps volume read-only), `initdb` and Postgres on a Unix socket only, `pg_restore`, one realm `sterling` and at least one user; the pod is deleted last, also when `pg_restore` fails;
- registry-input passes only when `checkBundle` accepts; escrow only when `checkEscrow` reports current;
- verify's record has a step per driver in recovery order with the site's targets;
- record `--add-step` appends a validated manual step; record `--check` exits 1 on an invalid record;
- opensearch: the credential only in the curl config on stdin; the newest successful snapshot; `audit-*` restored as `drill-<run id>-*` with `include_global_state` false; a count above zero; the copies deleted by name, also when the restore fails;
- volume: a temporary StorageClass with the site class's parameters plus `fromBackup` of the newest completed backup, a PVC, a read-only pod counting files; all three deleted, also when the pod never becomes ready;
- not-run with the reason when the site does not run the component; etcd-reset and openbao-restore refused without `--lab` and never run with it.

The cases were written after the code; their first run passed.

### Lab: an escrow drill on a real node

On the wave-7 lab VM (RKE2 from 47-16's node folder), through the API server forward, with a stand-in `longhorn-crypto` Secret:

```
node deploy/bundle/escrow.mjs export --out $W/lab/lh-escrow7     -> 2 keys escrowed
node deploy/bundle/drill.mjs verify ... --components escrow,etcd-reset --confirm hq
  drill: verify touches site lab; name it with --confirm lab.     exit 1
node deploy/bundle/drill.mjs verify ... --components escrow,etcd-reset --confirm lab --lab --escrow-record ... --operator lab-operator
  drill: etcd-reset is not run by the drill. Follow deploy/runbooks/backup-and-restore.md (etcd): rke2 server --cluster-reset ... then record it with drill.mjs record --add-step.
  drill: escrow: pass (escrow current: every longhorn-crypto key matches its digest)
  drill: record $W/lab/drill7/restore-test-lab-2026-11-24T230351876Z.json     exit 0
node deploy/bundle/drill.mjs record --check <that record> -> a valid sterling-restore-test/1 record
```

The postgres, opensearch and volume drivers need the identity stack, OpenSearch and Longhorn, which the lab VM does not run: postgres on 47-18's lab site, opensearch and volume on Phase 48's lab-full rig (G424).

## Verification

- `deploy/test/drill.test.mjs deploy/test/render.test.mjs` with helm 4.3.2 under the cap: pass (13 drill cases added).
- Wave close: see 47-17-SUMMARY.md.

## Deviations from Plan

- **Plan verify on the CI site** passes as written (no targets in the CI site file). With the example's targets it exits 1 until 47-24's two schedules exist; this is the intended refusal, not a defect.
- **The 15-day cron window** instead of 8 (decisions).

## Known Stubs

None.

## Threat Flags

None beyond the plan's register.

## Self-Check: PASSED

- Files exist: recovery.mjs, drill.mjs, drill.test.mjs; `recovery` is in the site example.
- Commit `9fc09856` is an ancestor of HEAD.

## Open conditions

- G424: the postgres, opensearch and volume drivers have run only on fixtures; postgres runs on 47-18's lab site, opensearch and volume on Phase 48's lab-full rig.
- G35: the OpenBao Raft and OpenSearch snapshot schedules come with 47-24; until then drill.mjs plan reports them missing against the RPO.
