# Installing a site from the bundle

**What it is for.** Installing a Sterling site on air-gapped hardware from one signed offline bundle (D-47). Nothing at the site reaches the internet; every image, chart and tool comes from the bundle, and nothing is used before its signature and digests are checked.

**Who does it.** The site operator, with the site administrator. Two key custodians join at the two ceremony stops (`key-ceremony.md`).

**What you need before you start.**

- **Nodes.** A RHEL-9-compatible OS on every node, in FIPS mode (`fips-mode-setup --enable`, then a reboot) with SELinux enforcing. The host packages Longhorn needs, `cryptsetup` and `open-iscsi`, and `container-selinux` and `chrony`, from your organization's own OS repository.
- **The import host.** Node.js 22 or later and `httpd-tools` (for `htpasswd`) from that repository, and `openssl`.
- **Install media, delivered separately from the bundle.** cosign, hauler and your organization's public key. Trust starts from the media, never from the bundle.
- **DNS names** under the site domain: `keycloak.<domain>`, the registry host, the session and hub host names, and one wildcard record, `*.webview.<instance>.<domain>` (`*.webview.ws.<domain>` with the example site folder), for the same HAProxy address as `<instance>.<domain>`. The workbench shows Chat, Team Studio, Agent Activity and Governance each from its own name under it, so without the record those pages stay blank. The site PKI puts that wildcard name on the sessions certificate; `status` (step 9) shows it ready.
- **Time.** Your organization provides an on-site authoritative time source on the site network: a GNSS-disciplined NTP appliance or a stratum-1 server, two or more recommended, never an internet pool (D-71). In the site file, `time.servers` lists them (host names or IP addresses), `time.refclocks` lists reference clocks attached to a node, `time.nts` turns on Network Time Security trusting the site CA, and `time.maxClockErrorMs` is the largest clock error a node or the import host may have (1000 by default; your organization decides). Every node and the import host run chrony from the site's OS repository. The import host gets the same configuration from `node deploy/bundle/lib/clock.mjs --site <site file> --out <folder>`: copy its `chrony.conf` to `/etc/chrony.conf` and restart chronyd. `install-node.sh` runs `check-time.sh` and stops a node whose clock is unsynchronised, follows its own local clock, or is beyond the limit; the preflight does the same for the import host. Workstations sync to the same source.
- **Notice.** The node console and SSH login banners show the same text as the realm's `systemUseNotice`, set through your organization's OS hardening baseline (D-76).
- **The site file.** Fill a copy of `deploy/values/site.example.yaml` and a folder of the per-release files from `deploy/values/site.example/` (the site folder below). Each setting's note says what it means. The ones that decide security:
  - `rpId`: your organization's one shared parent domain, the same in every site file, so a key registered at one site works at all of them (D-08);
  - `signInKeys` and `acceptableAaguids`: `passkeys`, or `hardware-only` with the approved hardware key models; an empty list is refused (D-31, D-57);
  - `requestedStorage`: the size of each workspace volume; there is no default (D-11);
  - `storageProvider` and `storageEncryptionAtRest`: Longhorn's encrypted class, or how your own storage is encrypted at rest (D-17);
  - `egressAllow`: the only outside addresses pods may reach, each one your organization's signed policy allows (D-01);
  - `recovery.rtoMinutes` and `recovery.rpoMinutes` (`recovery-plan.md`).

## The steps

Run every command on the import host from the folder the bundle's `deploy-tree.tar` was unpacked into, unless a step says a node. `<state>` is a folder only the operator can read; the install keeps its state and the bootstrap material there.

1. **Check the bundle.** `node deploy/bundle/check.mjs --bundle <bundle folder> --public-key <public key from the install media>`. If it refuses, do not go on: ask HQ for a new bundle.
2. **The bootstrap CA.** `node deploy/bundle/install.mjs bootstrap-ca --site <site file> --state <state>`. It makes a 90-day CA and the registry's certificate (D-16). `<state>/site-ca.crt` is the CA certificate.
3. **The node folder.** Extract the bundle's file items with the pinned hauler (`hauler store load -f store.tar.zst -s <store>`, then `hauler store extract -s <store> -o <files> hauler/<file name>:latest` for the RKE2 files and `registry-images.tar`), then: `node deploy/bundle/install.mjs node-files --site <site file> --out <node folder> --ca <state>/site-ca.crt --artifacts <files> --bundle <bundle folder>`. It writes the substituted RKE2 files, `install-node.sh`, `escrow-node.sh`, the clock files, `pins.sha256`, and the registry's own images named for your registry.
4. **RKE2 on each node.** Copy the node folder to the node and run `sh install-node.sh <node folder>` as root. It checks every file against `pins.sha256`, sets the clock from the site's source and checks it, then installs and starts RKE2. The first server first; then the others.
5. **The registry.** `node deploy/bundle/install.mjs registry --site <site file> --site-dir <site folder> --state <state>`. It applies the registry's certificate, makes the import account (its password reaches `htpasswd` on stdin only) and installs the registry.
6. **Import.** `node deploy/bundle/install.mjs import --site <site file> --state <state> --bundle <bundle folder> --public-key <public key> --out <install folder>`. It checks the bundle again, copies every image with its signature into the registry and verifies every signature there.
7. **Preflight.** `node deploy/bundle/install.mjs preflight --site <site file> --site-dir <site folder> --bundle <install folder>`. It refuses unsafe settings, unpublished or missing images, the lab placeholder, SoftHSM2 as the seal, a site without a time source, an import host whose clock fails, and anything the CI hardening checks find in your own render. Fix every line it prints before going on.
8. **Apply.** `node deploy/bundle/install.mjs apply --site <site file> --site-dir <site folder> --state <state> --bao <OpenBao address> --ca-file <state>/site-ca.crt --token-file <token file>`. It installs every release in order, makes the volume key before the first encrypted volume, and stops twice:
   - after OpenBao, until it is initialised and unsealed: `key-ceremony.md` (OpenBao initialisation and unseal), then `install.mjs apply --from 40` with the same flags. On that run it configures OpenBao (`deploy/openbao/apply.mjs`) and writes the static application secrets (`install.mjs secrets` does the same on its own);
   - before the site PKI, until the site intermediate is signed: `key-ceremony.md` (a site intermediate), then `install.mjs apply --from 46`.
   The realm is applied by `deploy/keycloak/apply.mjs` after Keycloak. Admission runs in Audit until the import has found every signature present; the last step of apply switches it to Deny.
9. **Status.** `node deploy/bundle/install.mjs status --bao <OpenBao address> --ca-file <state>/site-ca.crt --token-file <token file>`. Every release deployed, every pod ready, OpenBao unsealed, every certificate ready.
10. **Admission to Deny.** If status or apply said admission stays in Audit, run `install.mjs import` again, then `install.mjs apply` again; it switches to Deny once every signature is present.
11. **Retire the bootstrap.** Create your permanent Keycloak administrator first. Then `node deploy/bundle/install.mjs retire-bootstrap --site <site file> --state <state> --ca-file <state>/site-ca.crt`. It waits until site-pki serves `openbao-tls` and `zot-tls`, then removes the bootstrap CA and the Keycloak bootstrap administrator.

## After the install: the first escrow

The keys a restore needs must be in custody before the site is used (D-73):

1. On the first server node, as root: `sh escrow-node.sh save <custody folder>` (the RKE2 server token and the encryption configuration).
2. On the import host, once storage is installed: `node deploy/bundle/escrow.mjs export --out <custody folder>` (the `longhorn-crypto` key).

Custody is in `key-ceremony.md` (escrow custody), and how the escrow is used in `recovery-plan.md` and `backup-and-restore.md`.

## Confirm nothing calls out

Every namespace has an egress policy that allows only the site's own ranges and `egressAllow` (`deploy/charts/sterling-network`). The lab check is in `deploy/lab/`: the lab VM has no route out, and the same install works there.
