# Maintenance

**What it is for.** Keeping a running Sterling site patched and its certificates current without losing data, quorum or trust: node operating system patches, RKE2 upgrades, certificate renewal, HSM firmware, patch timelines and maintenance records (MA-2, MA-6, SI-2).

**Who does it.** Site operators. Key custodians join for the HSM and for the site intermediate.

**What you need.** The import host with the site file, kubectl (RKE2's) and the imported bundle; console or SSH access to each node; your organization's change log; for the HSM, the vendor's procedure and two key custodians.

Every risky step below starts with a check. A check that prints a problem has refused the step: fix the problem first, never work around it.

## 1. Before any maintenance

1. Record the change in your organization's change log: what you will change, when, who does it and which components it touches (MA-2).
2. Run `node deploy/bundle/maintenance.mjs cert-check`.
3. Tell people their sessions will stop for the window. A stopped session keeps its workspace volume.
4. Take fresh backups: `rke2 etcd-snapshot save` on a server, and `kubectl create job --from=cronjob/<name>` for the OpenBao snapshot and the Postgres dump (backup-and-restore.md).

## 2. Node operating system patching

Updates come only from the site's own OS repository mirror. The mirror is refreshed by media under the media handling runbook (media-handling.md). Patch one node at a time:

1. `node deploy/bundle/maintenance.mjs drain-check --node <node> --site <site file>`. It refuses when the drain would break etcd quorum, take an OpenBao server while another is not Ready, or remove a Longhorn volume's only healthy copy. It warns with the hubs and the number of sessions the drain stops.
2. `kubectl cordon <node>`, then `kubectl drain <node> --ignore-daemonsets --delete-emptydir-data`.
3. Update the node from the site repository and reboot it.
4. On the node, `sh check-time.sh <node folder>`: the clock must still follow the site's time source.
5. Wait until the node is Ready, then `kubectl uncordon <node>`.
6. Wait until every Longhorn volume is healthy again before the next node.

## 3. RKE2 upgrade

A new RKE2 arrives only in a new signed bundle. Check and import it first (bundle-update.md), then run:

`node deploy/bundle/maintenance.mjs upgrade-check --bundle <imported bundle folder> --site <site file>`

It refuses a downgrade, a jump of more than one minor version, a node that is not Ready, nodes on different versions, and backups older than 24 hours (`--max-backup-age-hours`), and it includes every cert-check problem. Upgrade one minor version per bundle and never downgrade.

Upgrade the servers one at a time, then the agents. For each node:

1. On a server: `rke2 etcd-snapshot save`.
2. `maintenance.mjs drain-check --node <node>`, then drain as in section 2.
3. Write the node folder from the new bundle (`node deploy/bundle/install.mjs node-files`) and run its `install-node.sh` on the node. It checks every pinned file and the node clock again.
4. Wait until the node is Ready, then uncordon it.

## 4. Certificates

- cert-manager renews the site's leaf certificates by itself. `maintenance.mjs cert-check` names any that is not Ready, overdue for renewal or within 7 days of expiry.
- The site intermediate is renewed through the key ceremony well before cert-check's horizon (90 days by default): `pki-files.mjs csr` at the site, signed by the HQ root (key-ceremony.md).
- The HQ root is renewed by HQ's own key ceremony.
- RKE2's own certificates are valid for 365 days. RKE2 renews any that is expired or within 120 days of expiry each time it starts (docs.rke2.io, Certificates). Restarting `rke2-server` on each server, one at a time, renews them. `rke2 certificate rotate` makes new ones instead.
- Run cert-check monthly and before every change.

## 5. HSM firmware

With the key custodians present, follow the vendor's procedure. Install only firmware versions listed on the module's CMVP certificate; any other version leaves the FIPS 140-3 approved mode. Before you start, take an OpenBao Raft snapshot (`kubectl create job --from=cronjob/openbao-raft-snapshot`). After the update, restart one OpenBao pod and see it unseal by itself before you restart the others.

## 6. Patch timelines (SI-2)

Your organization's patch timelines by severity apply from a bundle's `created` date (in its `manifest.json`). The timelines are your organization's decision; this runbook does not set them.

## 7. Maintenance records and spares (MA-2, MA-6)

Record each maintenance in the change log: the date, the people, the components, the check outputs, the bundle version before and after, and anything that did not go as written here. Keep your organization's support agreements and spares for the HSM and the nodes current, with the vendors' response times written down.
