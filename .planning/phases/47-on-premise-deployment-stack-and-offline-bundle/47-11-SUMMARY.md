---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 11
subsystem: deploy
status: complete
tags: [hub, statefulset, nodeport, tls-passthrough, postgres, pgdg, ubi9, backups]
requires: [47-04]
provides:
  - "deploy/hub (chart sterling-hub): StatefulSet hub-<name>, Services hub-<name> (ClusterIP) and hub-<name>-external (NodePort), Certificate hub-<name>-tls from site-pki-hub; descriptor sterling-hub with instances hubs, order 70"
  - "deploy/images/hub/image.json (the unchanged hub/Dockerfile) and deploy/images/postgres build definition with entrypoint.sh"
  - "deploy/charts/sterling-postgres: StatefulSet sterling-postgres (one replica), Service, Certificate sterling-postgres-tls from site-pki, CronJob sterling-postgres-dump and its PVC; order 50"
  - "site hub items { name, publicAddress, nodePort, storage }; deploy/values/site.example/sterling-postgres.yaml"
  - "deploy/test/render-stateful.test.mjs"
affects: [47-13, 47-16, 47-17]
tech-stack:
  added: []
  patterns:
    - "Secret files for a non-root user under fsGroup are 0440 (owner root, group the fsGroup), not 0400"
key-files:
  created:
    - deploy/hub/Chart.yaml
    - deploy/hub/values.yaml
    - deploy/hub/templates/statefulset.yaml
    - deploy/hub/templates/services.yaml
    - deploy/hub/templates/certificate.yaml
    - deploy/values/sterling-hub.yaml
    - deploy/values/sterling-hub.release.json
    - deploy/images/hub/image.json
    - deploy/images/postgres/image.json
    - deploy/images/postgres/entrypoint.sh
    - deploy/charts/sterling-postgres/Chart.yaml
    - deploy/charts/sterling-postgres/values.yaml
    - deploy/charts/sterling-postgres/templates/statefulset.yaml
    - deploy/charts/sterling-postgres/templates/service.yaml
    - deploy/charts/sterling-postgres/templates/backup.yaml
    - deploy/values/sterling-postgres.yaml
    - deploy/values/sterling-postgres.release.json
    - deploy/values/site.example/sterling-postgres.yaml
    - deploy/test/render-stateful.test.mjs
  modified:
    - deploy/images/postgres/Containerfile
    - deploy/images/README.md
    - deploy/test/fixtures/site.ci.yaml
    - deploy/values/site.example.yaml
key-decisions:
  - "Hub secret files are 0440: projected files are owned by root with the pod's fsGroup (65532) as group, so 0400 would leave the hub (uid 65532) unable to read them"
  - "Each hub item in the site file now needs publicAddress, nodePort and storage (the render refuses a missing one); the CI fixture's hub has them, and the site example's note says so (keys unchanged)"
  - "The NodePort Service keeps externalTrafficPolicy Local so the hub sees members' real addresses"
  - "Postgres copies the TLS key into the data folder with mode 0600 at every start, because Postgres refuses a key file it does not own; pg_hba.conf is rewritten at every start with hostssl scram-sha-256 lines only"
requirements-completed: [DEP-08, DEP-04]
duration: ~50min
completed: 2026-11-24
estimate:
  tokens: 80000
  tasks: 3
actuals:
  tokens: 9000
  tasks: 3
  commits: 3
plan_head_before: 7587fca8
plan_head_after: a01aada7
---

# Phase 47 Plan 11: The hubs on Kubernetes and Keycloak's Postgres Summary

**Each sync hub is its own one-replica StatefulSet with the Compose hardening and its own volume. Sessions reach it at hub-<name>.sterling-hubs.svc:8443 and members on its node port, both plain TCP to the TLS the hub ends itself with a site-PKI certificate. Keycloak's Postgres, built by us on UBI 9 from the signature-checked PGDG RPMs, refused a connection without TLS and accepted a verified TLS one.**

## Tasks

| Task | Result | Commit |
|---|---|---|
| 1. One hub end to end (tracer) | done; tracer gate re-ran the render test end to end before expanding | `9384355b` |
| 2. Hub reachability and certificate | done | `a5146a93` |
| 3. Keycloak's Postgres | done | `a01aada7` |

## Postgres, local build and TLS check

Built locally with podman (memory cap, heavy-run lock), with the pin's four files fetched by `install-tool.sh postgresql`:

```
/tmp/pgdg/postgresql18-18.7-1PGDG.rhel9.9.x86_64.rpm: digests signatures OK
/tmp/pgdg/postgresql18-libs-18.7-1PGDG.rhel9.9.x86_64.rpm: digests signatures OK
/tmp/pgdg/postgresql18-server-18.7-1PGDG.rhel9.9.x86_64.rpm: digests signatures OK
Successfully tagged localhost/sterling/postgres:s11
```

The container ran with a read-only root, `/run/postgresql` and `/tmp` on tmpfs, a test CA and a server certificate for `s11-pg`, and
`POSTGRES_ALLOW_CIDRS=10.0.0.0/8,172.16.0.0/12`. The client was a second container on an internal network:

```
first start: initdb, keycloak role and database; "database system is ready to accept connections"
without TLS (sslmode=disable)           -> FATAL: no pg_hba.conf entry for host "10.89.0.3", user "keycloak", database "keycloak", no encryption
verified TLS (sslmode=verify-full)      -> keycloak|t|TLSv1.3
verified TLS, wrong password            -> FATAL: password authentication failed for user "keycloak"
verified TLS, wrong host name           -> server certificate for "s11-pg" does not match host name "not-the-server"
pg_hba.conf: local all all scram-sha-256; hostssl all all 10.0.0.0/8 scram-sha-256; hostssl all all 172.16.0.0/12 scram-sha-256
```

The first run failed because podman's default tmpfs was not writable by uid 26
(`could not create lock file "/run/postgresql/.s.PGSQL.5432.lock"`). With `mode=1777` it starts. In Kubernetes the chart's memory
`emptyDir` with `fsGroup` 26 gives the same access.

## Verification

- `render-stateful.test.mjs` with the pinned helm, under the memory cap: 4 tests, all added by this plan, all pass. They ran in the same run
  as the render, site, sessions and rke2 tests (28 tests; the two failures there were 47-10 and 47-12 test fixes, rerun green).
- The rendered hub release has `kind: StatefulSet`, `replicas: 1`, `runAsUser: 65532`, `readOnlyRootFilesystem: true`, `sizeLimit: 16Mi`,
  `--healthcheck` and the four `HUB_*_FILE` variables. A two-hub site renders 2 StatefulSets and 4 Services. The NodePort uses the item's
  port, everything is TCP 8443, and the issuer is `site-pki-hub`. No Ingress routes to a hub.
- `sterling-postgres` renders `replicas: 1`, `kind: CronJob` with `sslmode=verify-full`, and both volumes on `sterling-encrypted`.
- `bash -n deploy/images/postgres/entrypoint.sh` is clean. `git diff origin/main -- hub/Dockerfile relay/compose.yaml` is empty.

## Deviations from Plan

**1. Secret mode 0440 instead of 0400** (allowed by the plan when 0400 cannot be read; reason above).

**2. [Rule 3 - Blocking] Hub items need more than a name**
- The plan's statefulset needs `publicAddress`, `nodePort` and `storage` per hub. The render refuses an item without them. The CI fixture's
  hub gained them, and the site example's `hubs` note describes the four fields; no site key was added or renamed.

**3. [Rule 2 - Missing critical] Postgres runs as uid 26 on a read-only root**
- `/run/postgresql` and `/tmp` are memory-backed `emptyDir` volumes. The dump CronJob verifies the server certificate
  (`sslmode=verify-full`).

`hub/Dockerfile` and `relay/compose.yaml` are unchanged (`git diff origin/main -- hub/Dockerfile relay/compose.yaml` is empty).

## Known Stubs

None. The hub image and the Postgres image have null digests in the lock until `deploy-images.yml` publishes them (the render uses the
reserved digest and the install refuses it).

## Self-Check: PASSED
