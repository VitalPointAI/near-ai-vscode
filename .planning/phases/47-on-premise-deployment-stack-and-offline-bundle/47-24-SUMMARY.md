---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 24
subsystem: deploy
status: complete
tags: [backup, cp-9, cp-10, opensearch, openbao, raft, snapshots, au-9]
requires: [47-07, 47-10, 47-13, 47-19]
provides:
  - "OpenSearch: repository sterling-snapshots (ConfigMap opensearch-snapshot-repository), policy sterling-audit (ConfigMap opensearch-snapshot-policy), PVC opensearch-snapshots, CronJob opensearch-snapshot-check, site setting sterling.snapshots (cron, maxAgeDays, minCount, size)"
  - "OpenBao: CronJob openbao-raft-snapshot, ServiceAccount openbao-snapshot, PVC openbao-snapshots, policy and kubernetes role raft-snapshot, site setting sterling.snapshots (cron, keep, size)"
affects: [47-16, 47-17, 47-18, 47-27, 48.1-14, 48.1-16]
tech-stack:
  added: []
  patterns:
    - "Snapshot volumes carry helm.sh/resource-policy keep, so removing a release never removes its backups"
    - "A Kubernetes login to OpenBao uses a projected token for OpenBao's own audience, never the API server's"
key-files:
  created:
    - deploy/openbao/policies/raft-snapshot.hcl
  modified:
    - deploy/values/opensearch.yaml
    - deploy/values/site.example/opensearch.yaml
    - deploy/values/openbao.yaml
    - deploy/values/site.example/openbao.yaml
    - deploy/openbao/apply.mjs
    - deploy/test/render-site.test.mjs
    - deploy/test/openbao.test.mjs
    - compliance/gaps.json
    - compliance/test/gaps.test.ts
    - docs-site/content/security/road-to-production.md
key-decisions:
  - "The OpenSearch image has no find; the snapshot check uses shell built-ins, stat and date only (found by the container proof)"
  - "The raft-snapshot role names its own audience (sterling-openbao-snapshot) and the CronJob mounts a projected token for it with automountServiceAccountToken false, as cert-manager's role does, so the token cannot be replayed against the Kubernetes API"
  - "Both snapshot PVCs keep helm.sh/resource-policy: keep: uninstalling a release must not delete the backups"
  - "The deletion schedule of sterling-audit reuses the creation cron, and the check CronJob runs hourly at :15 UTC; neither adds a site setting"
requirements-completed: [DEP-05, DEP-11]
duration: ~50m
completed: 2026-11-25
estimate:
  tokens: 55000
  tasks: 2
actuals:
  tokens: 9450
  tasks: 2
  commits: 3
plan_head_before: fa57aaaeeb8285a560b517a4f5d12aacfe37e6af
plan_head_after: 8da398afca986cfdcbc9abbf440ffdd4a1c68af8
---

# Phase 47 Plan 24: Audit store and OpenBao snapshots Summary

**The audit and log indices are snapshotted daily to an encrypted volume and a deleted audit index came back with all 50 documents from the exact bodies the site installs; OpenBao Raft snapshots run every 6 hours with a token that can take a snapshot and nothing else.**

## Performance

- Tasks: 2 of 2. Commits: `0b8ebdb8` (Task 1, tracer), `c93beb85` (Task 2), `8da398af` (gap G448).

## Task 1: the audit store's snapshot and restore (tracer)

`deploy/values/opensearch.yaml` gains `path.repo`, the volume `snapshots` on every node (PVC `opensearch-snapshots`: ReadWriteOnce for one node, ReadWriteMany for several, on `${site.storageClass}`, kept on uninstall), ConfigMap `opensearch-snapshot-repository` (fs, compressed), ConfigMap `opensearch-snapshot-policy` (policy `sterling-audit`) and CronJob `opensearch-snapshot-check`. A render with `maxAgeDays` below 1,825 stops. The site example sets `sterling.snapshots` (01:30 UTC daily, 1,825 days, at least 7, 200Gi) with the 5-year note.

Container proof, under the heavy lock: OpenSearch `opensearchproject/opensearch@sha256:ffa260e4...` (3.10.0, the lock's image), single node, the security plugin disabled for this container only. The two bodies were taken from the ConfigMaps `renderRelease` renders for the CI site.

```
rendered bodies: repository fs, policy indices audit-*,logs-*, include_global_state false, max_age 1825d
PUT _snapshot/sterling-snapshots (rendered body): 200 {"acknowledged":true}
POST _plugins/_sm/policies/sterling-audit (rendered body): 201 policy sterling-audit-sm-policy
  stored: creation {"cron":{"expression":"30 1 * * *","timezone":"UTC"}}; deletion {"max_age":"1825d","min_count":7};
          snapshot_config {"indices":"audit-*,logs-*","ignore_unavailable":true,"timezone":"UTC","include_global_state":false,"repository":"sterling-snapshots","partial":false}
bulk 50 documents into audit-test-1: 200; count 50
snapshot tracer-1 on demand: 200; state SUCCESS; indices ["audit-test-1"]; include_global_state false
DELETE audit-test-1: 200; exists after: 404
restore audit-test-1: 200; shards {"total":1,"failed":0,"successful":1}; count 50
renamed restore (rename_pattern audit-(.+), drill-audit-$1): 200; drill-audit-test-1 count 50; live audit-test-1 count 51
  (one document was added to the live index after the first restore; the drill restore left it there)
the check script (from the rendered CronJob) with checkMaxGapMinutes 2160: exit 0; the newest snapshot is 0 minutes old (allowed: 2160)
the same with a gap of -1 minutes: exit 1
repository files: index-0 index.latest indices meta-<uuid>.dat snap-<uuid>.dat snapshot_shard_paths
```

The first run found that the image has no `find`, so the check could never pass; the script now uses shell built-ins, `stat` and `date`, and the proof was re-run end to end (tracer gate). Render cases in `render-site.test.mjs` cover the PVC on the site class, `path.repo` and the mount, both ConfigMaps parsing as JSON, the policy, the check's read-only volume and lack of credentials, the 1,824-day refusal, and the single-node ReadWriteOnce volume with the check pinned to the OpenSearch node.

## Task 2: OpenBao Raft snapshots (TDD)

RED: the 4 new cases in `openbao.test.mjs` failed (the policy, the role, the CronJob render, the script). GREEN after:
- `raft-snapshot.hcl`: `read` on `sys/storage/raft/snapshot` and nothing else;
- `apply.mjs`: policy `raft-snapshot` and role `raft-snapshot` on `auth/kubernetes` (ServiceAccount `openbao-snapshot` in `sterling-openbao`, audience `sterling-openbao-snapshot`, `token_ttl` 300, `token_max_ttl` 600, no default policy), after 47-13's mount, read before written;
- `openbao.yaml` `extraObjects`: ServiceAccount, PVC (kept on uninstall) and CronJob `openbao-raft-snapshot` (Forbid, OnFailure, the server image fields by digest, IfNotPresent, the restricted context with a read-only root, `/tmp` emptyDir, the site CA, a projected token);
- the site example: every 6 hours at :15 UTC, keep 28, 5Gi, with the note.

Container proof: our image built from `deploy/images/openbao` as 47-07 did (the kms-pkcs11 pin fetched and hash-checked by `install-tool.sh`, `podman build`), one Raft node, Shamir 1 of 1.

```
image localhost/sterling/openbao:w8: OpenBao v2.7.3
init (Shamir 1 of 1): 200; unseal: 200; raft peers: [["n1",true]]
write policy raft-snapshot (deploy/openbao/policies/raft-snapshot.hcl): 204
token: policies ["raft-snapshot"], ttl 300 s
bao operator raft snapshot save with that token: exit 0; saved openbao-20261125T042319Z.snap, 22553 bytes
the same token reads sys/policies/acl: 403; sys/policies/acl/raft-snapshot: 403
the same token reads kv/data/apps/x: 403
the same token restores a snapshot (POST sys/storage/raft/snapshot): 403
the same token renews itself: 403
```

And `apply.mjs` against OpenBao 2.7.3 dev, twice: run 1 wrote `policy raft-snapshot` and `kubernetes role raft-snapshot` (26 written); run 2 wrote nothing (26 unchanged).

## Verification

- `deploy/test/render-site.test.mjs`, `openbao.test.mjs`, `render.test.mjs` and `rke2.test.mjs` with the pinned helm, under the memory cap: 43 run, 43 pass. This plan added 2 cases to render-site.test.mjs and 4 to openbao.test.mjs.
- `deploy/test/install.test.mjs` and `drill.test.mjs` (47-16's apply step reads the two ConfigMaps by these names): 34 run, 34 pass.
- `node scripts/resource-check.mjs`: passed, 141 resources. Compliance gap tests: 51 run, 51 pass.

## Deviations from Plan

**1. [Rule 1 - Bug] The OpenSearch image has no `find`.** Found by the container proof; the check uses shell built-ins. Commit `0b8ebdb8`.

**2. [Rule 2 - Security] The snapshot job's own token audience.** The plan's role had no audience; a plain ServiceAccount token is also valid at the Kubernetes API. The role names `sterling-openbao-snapshot` and the CronJob mounts a projected token for it, as 47-13's cert-manager role does. Commit `c93beb85`.

**3. [Rule 2 - Data integrity] `helm.sh/resource-policy: keep` on both snapshot PVCs**, so removing a release keeps its backups.

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

- Files exist: raft-snapshot.hcl, the four values files, the two test files.
- Commits `0b8ebdb8`, `c93beb85` and `8da398af` are ancestors of HEAD.

## Hand-offs

- `opensearch.yaml` is shared with 48.1-16 (H-10): its retention change for `audit-*` and the `audit-archiver` role are not on main yet; whichever lands second keeps the other's settings.

## Open conditions

- G448: a ReadWriteMany snapshot volume on the encrypted Longhorn class for multi-node OpenSearch is unchecked until Phase 48's lab-full rig.
- G424: the in-cluster runs (the CronJobs, the projected-token login at `auth/kubernetes`, the Longhorn backups of both volumes, 47-16's apply step putting the two bodies through the API with the security plugin on) have not run live; the lab run (47-18) does them.
- G46: the sizes (200Gi, 5Gi) and schedules are provisional until Phase 48 measures them; the recovery point setting (47-27) is checked against them.
