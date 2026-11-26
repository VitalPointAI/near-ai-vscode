# Updating a site with a newer bundle

**What it is for.** Bringing a running site up to a newer Sterling bundle. An update uses the same signed format and the same commands as the first install; the scripts only upgrade what is there (D-47).

**Who does it.** The site operator.

**What you need.** The new bundle, your organization's public key from the install media, the site file and site folder, the install state folder, and an OpenBao token file. Record the change in your organization's change log first (`maintenance.md`).

## OpenSearch upgrade hold

On an existing site, stop before applying a bundle that would upgrade OpenSearch unless the upgrade has been verified for that site and bundle. The general apply command below includes OpenSearch when it is enabled. Passing bundle and preflight checks verifies inputs and rendering. Upgrade verification also needs to cover the existing site's audit data and policies.

Fresh full-site installs remain available through `site-install.md`.

## The steps

1. **Check.** `node deploy/bundle/check.mjs --bundle <new bundle> --public-key <public key>`.
   - **If the check refuses the bundle, do not import it.** Nothing has touched the site. Ask HQ for a new bundle and say what the check printed.
2. **RKE2.** If the bundle carries a newer RKE2, follow `maintenance.md` section 3 (it starts with `maintenance.mjs upgrade-check`). Otherwise go on.
3. **Import.** `node deploy/bundle/install.mjs import --site <site file> --state <state> --bundle <new bundle> --public-key <public key> --out <install folder>`.
4. **Preflight.** `node deploy/bundle/install.mjs preflight --site <site file> --site-dir <site folder> --bundle <install folder>`.
5. **Apply again.** `node deploy/bundle/install.mjs apply --site <site file> --site-dir <site folder> --state <state> --bao <address> --ca-file <site CA> --token-file <token file>`. Every release is upgraded in order. The realm (`deploy/keycloak/apply.mjs`) and OpenBao's policies (`deploy/openbao/apply.mjs`) are applied again by the same scripts; a second run of either changes only what differs.
6. **Status.** `node deploy/bundle/install.mjs status ...` until every line is ready.

## After an update

- **Escrow checks (D-73).** On a server node: `sh escrow-node.sh check <escrow-record.json>`. On the import host: `node deploy/bundle/escrow.mjs check --record <escrow-record.json>`. If either reports a key rotated since the escrow, make a new escrow (`site-install.md`, the first escrow) and hand it to the key custodians.
- **Keep the last two verified bundles** on the backup target. The registry is not backed up: it is rebuilt from the last verified bundle (`backup-and-restore.md`).

## Going back to the previous bundle

If applying the previous bundle includes OpenSearch, verify that rollback for the site before continuing. Import the previous verified bundle (step 3) and apply again (step 5). The charts roll back to the previous versions. Never go back across an RKE2 minor version: RKE2 is never downgraded (`maintenance.md`). If a database schema moved forward in the update, restore from the backup taken before it (`backup-and-restore.md`).
