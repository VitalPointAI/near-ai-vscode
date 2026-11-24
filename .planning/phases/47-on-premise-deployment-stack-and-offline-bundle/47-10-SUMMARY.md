---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 10
subsystem: deploy
status: complete
tags: [longhorn, luks, storage-class, backups, opensearch, fluent-bit, prometheus, harbor]
requires: [47-04]
provides:
  - "deploy/charts/sterling-storage (StorageClass ${site.storageClass} encrypted with Secret longhorn-crypto; RecurringJobs sterling-daily-snapshot and sterling-daily-backup), order 39, enabledWhen storageProvider longhorn"
  - "OpenSearch roles audit-writer and auditor, TLS from Secret opensearch-tls, users from Secret opensearch-internal-users, retention policy ConfigMap opensearch-retention-policy"
  - "Fluent Bit in sterling-log-shipper with one output to opensearch-cluster-master.sterling-logging.svc (Secret opensearch-writer)"
  - "Prometheus with no remote write or read, data on the site class"
  - "Harbor at https://registry.${site.domain} through HAProxy, TLS Secret harbor-tls from site-pki, every built-in credential from Secrets"
  - "Per-site files site.example/{longhorn,opensearch,prometheus,harbor}.yaml; deploy/test/render-site.test.mjs"
affects: [47-13, 47-16, 47-17]
tech-stack:
  added: []
  patterns:
    - "One per-site file feeds two releases (longhorn and sterling-storage); charts ignore keys they do not know"
key-files:
  created:
    - deploy/charts/sterling-storage/Chart.yaml
    - deploy/charts/sterling-storage/values.yaml
    - deploy/charts/sterling-storage/templates/storageclass.yaml
    - deploy/charts/sterling-storage/templates/recurring-jobs.yaml
    - deploy/values/sterling-storage.yaml
    - deploy/values/sterling-storage.release.json
    - deploy/values/site.example/longhorn.yaml
    - deploy/values/site.example/opensearch.yaml
    - deploy/values/site.example/prometheus.yaml
    - deploy/values/site.example/harbor.yaml
    - deploy/test/render-site.test.mjs
  modified:
    - deploy/values/longhorn.yaml
    - deploy/values/longhorn.release.json
    - deploy/values/opensearch.yaml
    - deploy/values/opensearch.release.json
    - deploy/values/fluent-bit.yaml
    - deploy/values/fluent-bit.release.json
    - deploy/values/prometheus.yaml
    - deploy/values/prometheus.release.json
    - deploy/values/harbor.yaml
    - deploy/values/harbor.release.json
key-decisions:
  - "One Fluent Bit output for both streams: a modify filter tags records sterling_index audit or logs, and the opensearch output's Logstash_Prefix_Key picks audit-* or logs-*"
  - "OpenSearch ISM policies are API objects, not files: the policy is rendered into ConfigMap opensearch-retention-policy and the install script (47-16) applies it"
  - "Harbor's chart has no existing-Secret option for its internal database password or for the OIDC configuration overwrite; the install script passes both at install time from OpenBao, and the chart's public defaults are asserted absent from the render"
  - "The class is the cluster default and keeps released volumes (Retain); new volumes join the default recurring-job group, so the operator's workspace PVCs are backed up without naming them"
requirements-completed: [DEP-02, DEP-12]
duration: ~50min
completed: 2026-11-24
estimate:
  tokens: 70000
  tasks: 3
actuals:
  tokens: 7500
  tasks: 3
  commits: 3
plan_head_before: e7b2b683
plan_head_after: 817eb526
---

# Phase 47 Plan 10: Encrypted storage, site-local logs and metrics, and Harbor Summary

**Every rendered StorageClass is a Longhorn LUKS class keyed by one Secret, and every volume is covered by daily snapshots and backups. Fluent Bit ships the Kubernetes API audit log and every container log through exactly one output, the site's own OpenSearch over verified TLS. Prometheus writes nowhere. Harbor sits behind HAProxy with site TLS and no internet scanner, and none of the chart's public default credentials is rendered.**

## Tasks

| Task | Result | Commit |
|---|---|---|
| 1. Encrypted storage class (tracer) | done; tracer gate re-ran the render test end to end before expanding | `60cd1012` |
| 2. OpenSearch, Fluent Bit, Prometheus | done | `56ae81d7` |
| 3. Harbor | done | `817eb526` |

## Verification

- `render-site.test.mjs`, `render-stateful.test.mjs`, `render-sessions.test.mjs`, `render.test.mjs` and `rke2.test.mjs` with the pinned helm,
  under the memory cap, in one run: 28 tests. The first run had 26 passing and 2 failing; neither failure was in this plan's code. The
  placeholder test (47-12) layered its fixture before the site file, and the Harbor test treated the core configuration's `WITH_TRIVY:
  "false"` as a Trivy workload. Both tests were corrected, and the two files were run again: 10 of 10 pass. This plan added 4 tests, all
  in render-site.test.mjs.
- The rendered `sterling-storage` release has exactly one StorageClass, `sterling-encrypted`, with `encrypted: "true"`. No other release
  renders a StorageClass.
- The Fluent Bit configuration has one `[OUTPUT]` (`opensearch`, `opensearch-cluster-master.sterling-logging.svc`, `tls.verify On`) and tails
  `audit.log`. Prometheus renders no `remote_write`. Harbor renders `https://registry.site.example`, its ingresses use class `haproxy`, it
  has no Trivy workload or image, and it shows `WITH_TRIVY: "false"`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] Harbor's public default credentials**
- The chart defaults include `harborAdminPassword: Harbor12345`, `secretKey: not-a-secure-key`, a registry password and the internal
  database password `changeit`. Each now comes from a Secret (admin, secret key, core, XSRF, jobservice, registry, registry credentials).
  The database password and the OIDC overwrite JSON, which the chart only takes as values, are passed by the install script (47-16). The
  render test asserts that none of the defaults appears, in plain text or base64.

**2. [Rule 1 - Bug] The Harbor registry stays at one replica**
- Its filesystem storage is a ReadWriteOnce volume; more replicas need shared object storage.

**3. One output section** (key-decisions), and the retention policy rendered as a ConfigMap rather than created by the chart.

## Notes for later plans

- 47-13 issues Secrets `opensearch-tls` (name `opensearch-cluster-master.sterling-logging.svc`; `plugins.security.nodes_dn` names it) and
  `harbor-tls`.
- 47-16 writes `longhorn-crypto` (with PBKDF2 settings on a FIPS host), `opensearch-internal-users`, `opensearch-writer`, the Harbor Secrets
  and install-time values, and applies `opensearch-retention-policy`. Its preflight checks `cryptsetup`, `open-iscsi`, NFS client tools and
  `vm.max_map_count`.
- Tamper-evidence of the audit indices stays gap G2.

## Known Stubs

None. The Harbor database password and OIDC values are empty in the values on purpose; the install script supplies them, and a render that
is installed without them would fail Harbor's start, not run open.

## Self-Check: PASSED
