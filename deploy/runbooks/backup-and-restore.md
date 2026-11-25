# Backup and restore

**What it is for.** Knowing, for every stateful part of a Sterling site, what is backed up, when, where, and how to restore it (D-54, D-73). The order to restore a whole site in is `recovery-plan.md`.

**Who does it.** Site operators. Key custodians bring the escrow and, for OpenBao, the HSM or the Shamir shares.

**What you need.** kubectl (RKE2's), the install state folder, the escrow media (`key-ceremony.md`, escrow custody), and the last two verified bundles kept on the backup target.

Practise before you need it: `node deploy/bundle/drill.mjs verify` restores the database, the audit store and a volume into scratch copies and checks the bundle and the escrow, without touching live data (`recovery-plan.md`, the drill).

## RKE2 etcd

- **Backed up:** an etcd snapshot every 6 hours on each server, 28 kept (`etcd-snapshot-schedule-cron` and `etcd-snapshot-retention` in `deploy/rke2/config.yaml`). A snapshot also holds every Session and Workspace record and the encryption configuration (protected by the server token). Take one on demand with `rke2 etcd-snapshot save`.
- **Restore:** on one server, stop `rke2-server`, then `rke2 server --cluster-reset --cluster-reset-restore-path=<snapshot>`. It needs the server token from escrow: docs.rke2.io says the token must be restored, or passed as `token`, to restore any snapshot. Put the escrowed `token` back at `/var/lib/rancher/rke2/server/token` (or set `token` in `config.yaml`) first. Start `rke2-server`. On the other servers, follow docs.rke2.io's rejoin steps: stop RKE2, remove its database folder, start it again so it joins the restored cluster.

## OpenBao Raft snapshots

- **Backed up:** the CronJob `openbao-raft-snapshot` takes a Raft snapshot on a schedule onto the volume `openbao-snapshots`, with a token that can only read `sys/storage/raft/snapshot`. Take one on demand: `kubectl create job --from=cronjob/openbao-raft-snapshot openbao-raft-snapshot-now -n sterling-openbao`.
- **Restore:** `bao operator raft snapshot restore <snapshot file>` in an OpenBao pod, with an operator token. A snapshot is useless without the HSM (seal `pkcs11`) or the threshold of Shamir shares: bring the custodians.

## Keycloak's Postgres

- **Backed up:** every night at 00:30 UTC the CronJob `sterling-postgres-dump` writes `keycloak-<time>.dump` (a `pg_dump` in custom format) onto the volume `sterling-postgres-dumps`, kept 14 days. That volume is also in the Longhorn backups.
- **Restore:** stop Keycloak (`kubectl scale statefulset -n sterling-identity keycloakx --replicas=0`), then in the Postgres pod `pg_restore --clean --if-exists -d keycloak <dump>`, then start Keycloak again.

## Volumes (workspaces, hubs, Postgres, snapshots)

- **Backed up:** every volume on the encrypted class joins the default group: a daily snapshot (7 kept) and a daily backup to the site's backup target (14 kept) (`deploy/charts/sterling-storage/templates/recurring-jobs.yaml`).
- **Restore one person's volume:** in the Longhorn UI, restore the volume's newest backup to a new volume, then point a PVC at it (or replace the workspace's PVC while the person's session is stopped).
- **After the cluster is rebuilt:** restore the escrowed `longhorn-crypto` Secret first (`kubectl apply -f longhorn-crypto.json` from the escrow media), then restore volumes from the backup target. Without that key no backup of an encrypted volume can be read.

## The hubs

Each hub keeps a SQLite store and a blob folder on its own volume (MUS 10.9), backed up with the volumes above. **A restore is a rollback:** members' computers that already have newer entries refuse the older state and refill the hub. The hub's key files are kept apart in OpenBao (`kv/apps/hubs/<name>`), not on the volume. Losing a hub's keys means revoking that hub and admitting a new one.

## The OpenSearch audit store

- **Backed up:** `audit-*` and `logs-*` are snapshotted to the repository `sterling-snapshots` (a filesystem repository on an encrypted volume) under the snapshot-management policy `sterling-audit`, kept 1,825 days. The security index is never in a snapshot; the release re-creates it.
- **Restore a damaged index:** delete it, then restore it from the newest snapshot (`POST _snapshot/sterling-snapshots/<snapshot>/_restore` with `"indices": "<index>"`).
- **Restore beside the live data:** use `rename_pattern` and `rename_replacement`, as the drill does.
- Audit records older than the 730-day online window come from the write-once archive, not from snapshots.

## The registry

The registry is not backed up. Install it and import the last verified bundle again: `node deploy/bundle/install.mjs registry` and `node deploy/bundle/install.mjs import`. Keep the last two verified bundles on the backup target for this.

## The SoftHSM2 token volume (test and lab only)

In the lab and CI, OpenBao's seal is SoftHSM2 with its token folder on a volume. Losing that volume loses the lab's data set. A production site never uses SoftHSM2 (the preflight refuses it).

## The off-site copy (required, 3-2-1)

Owner decision d (D-81).

**Planned, not built yet.** The `sterling-offsite` CronJob and `offsite.mjs` described below are planned in 47-33; neither is in this repository yet. Until they are, a site has no automated off-site copy: your organization copies the Longhorn backup target and the audit archive to its second site by its own means, and records each copy. The steps below describe the planned behaviour.

- Every day the `sterling-offsite` CronJob (47-33) copies the Longhorn backup target (every volume's encrypted backup) and the write-once audit archive to a write-once store at your organization's second site. Archive objects are locked 1,825 days (owner decision b).
- A disconnected site writes the same set with `offsite.mjs pack` to signed media, under the media handling runbook.
- The receiving site runs `offsite.mjs verify`.
- The key backups and the escrow travel separately, with the custodians; never with the copy.
