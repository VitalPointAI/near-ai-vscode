# Recovery plan

**What it is for.** Bringing a Sterling site back after a serious loss, in an order that keeps people out until their actions are recorded, within your organization's recovery objectives (CP-2, CP-10; D-73). How to back up and restore each part is in `backup-and-restore.md`.

**Who does it.** The site administrator leads the restore. Key custodians bring the escrow, the HSM or the Shamir shares. Your organization's contingency lead decides when to start the plan, approves letting people back in, and reviews every drill record.

**What you need.** The escrow media; the last two verified bundles; the install media; access to the backup target and to the off-site copy; this plan and `backup-and-restore.md`.

## The recovery order

Restore in this order. Each group has an id that `drill.mjs` and the restore-test record use.

| Order | Group id | What comes back | From |
|---|---|---|---|
| stage 0 | `platform` | nodes; RKE2, by etcd restore with the escrowed token or by a fresh install; the registry rebuilt from the last verified bundle | etcd snapshots, escrow, bundles |
| 1 | `secrets` | the HSM and OpenBao | OpenBao Raft snapshots, HSM or Shamir shares |
| 2 | `identity` | Keycloak and its Postgres | the nightly dump, volume backups |
| 3 | `registry` | the registry's own service; admission back to Deny | the bundle (`install.mjs registry`, `install.mjs import`) |
| gate | `audit-pipeline` | OpenSearch and Fluent Bit running | the releases |
| 4 | `sessions` | Theia Cloud sessions and workspace volumes | volume backups |
| 5 | `hubs` | the sync hubs | volume backups |
| 6 | `audit` | historical audit data | OpenSearch snapshots, the audit archive |

**The audit gate.** Nobody is let back in at step 4 until the audit pipeline (OpenSearch and Fluent Bit) runs, so every action after the restore is recorded. The historical audit data comes back last, at step 6.

## RTO and RPO

The site file holds two site-wide objectives, accepted by the owner (decision c, 2026-11-24):

- `recovery.rtoMinutes: 480` (8 hours): the longest time to bring the whole site back in the order above.
- `recovery.rpoMinutes: 1440` (24 hours): the most data any backup may lose.

They are the single source your organization's system description reads. Run `node deploy/bundle/drill.mjs plan --site <site file> --site-dir <site folder>` to see the order, each backup's schedule and its longest gap, and every schedule that cannot meet the RPO.

## Degraded modes

- **HQ lost.** Edge sites keep running on their own Keycloak, OpenBao and hubs. No new bundles, user moves or intermediates arrive until HQ is back. The HQ root's revocation list must stay valid meanwhile; its validity period is set in the key ceremony (`key-ceremony.md`). HQ itself recovers in the order above.
- **An edge cut off from HQ.** Normal for an air-gapped edge. A linked edge that brokers HQ sign-in keeps its local people signing in; people who sign in through HQ cannot until the link returns, unless they were imported by signed user export (`moving-a-person.md`).

## The restore-test record

Every drill, automated or by hand, ends in one `sterling-restore-test/1` record (JSON):

- `format`, `site`, `bundleVersion`, and `scenario`: `verify`, `lab-full-site` or `component`;
- `startedAt` and `finishedAt` (UTC);
- `operator`, and optionally `witness`;
- `steps`, `findings` and `correctiveActions` (lists);
- `rtoTargetMinutes` (the site's `recovery.rtoMinutes`), `achievedRtoMinutes` (from the first restore step's start to the last step's end, for a full-site drill only) and `rtoMet`;
- `notes`.

Each step holds `group` (an id above), `component`, `kind` (`verify`, `restore` or `manual`), `backupTakenAt`, `startedAt`, `finishedAt`, `result` (`pass`, `fail` or `not-run`), `check` (what was compared), `achievedRpoMinutes` (start minus the backup's time), `achievedRtoMinutes` (the step's own time), `rpoTargetMinutes` (the site's `recovery.rpoMinutes`) and `met`. `node deploy/bundle/drill.mjs record --check <file>` recomputes every achieved value from the times and refuses a record that does not add up.

## The drill

- `node deploy/bundle/drill.mjs verify --site <site file> --site-dir <site folder> --components postgres,registry-input,escrow,opensearch,volume --confirm <site name> --out <folder>` restores into scratch copies only: a scratch database, renamed indices, a new volume. It checks the retained bundle and the escrow, removes every scratch object even when a step fails, and writes the record. Give it `--bundle` and `--public-key` for the bundle, `--escrow-record` for the escrow, `--opensearch-auth-file` for the audit store and `--volume <namespace/pvc>` for a volume.
- The lab-only and human steps (an etcd cluster reset, an OpenBao snapshot restore, HSM checks) are never run by the drill. Do them in the lab by `backup-and-restore.md`, timed, and add each one to the record with `node deploy/bundle/drill.mjs record --add-step <record> --group <id> --component <name> --kind manual --backup-taken <time> --started <time> --finished <time> --result <pass|fail> --check <what you compared>`.
- **Quarterly drill from the off-site copy** (owner decision d). Record each step with `drill.mjs record --add-step`:
  1. `offsite.mjs verify --day <recent day> --sample <n>` on the copy at the second site;
  2. a Longhorn restore of one volume backup from the copy at the second site;
  3. the archive verifier on the copied audit archive.
- Your organization sets how often to drill (at least the quarterly off-site drill) and reviews each record.

## When to update this plan

After a drill finding, after an incident, and after any change to the stack (a new component, a new backup, a changed schedule or objective).
