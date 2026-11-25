# Key ceremony

**What it is for.** Creating and holding the keys a Sterling site trusts: the HQ offline root CA, each site's intermediate, the OpenBao seal (an HSM, or Shamir shares), your organization's signing keys, the Transit keys auditors verify, and the escrow of the keys a restore needs (D-38, D-50, D-73, D-80).

**Who attends.** At least two key custodians and the site administrator. No one person ever holds a complete key or key backup (split knowledge).

**What you need.** An offline machine, or the HSM, never connected to a network during the ceremony; approved removable media; the install media (cosign and your organization's public key); the vendor's HSM procedure; the ceremony record form your organization uses. Record who did what and when, and keep destruction records for any media you destroy.

## 1. The HQ offline root CA

Create the root on the offline machine or inside HQ's HSM, with a long validity your organization sets. Store its key only on the offline machine or the HSM, with an off-site backup held by two custodians. Its certificate goes on every site's install media.

**HQ root revocation list validity.** Issue the root's revocation list with a next-update time long enough for edge sites to keep working while HQ is lost (`recovery-plan.md`, degraded modes). Your organization sets that period.

## 2. A site's intermediate

The site's intermediate key is made inside its OpenBao and never leaves it. `install.mjs apply` stops before the site PKI until this is done.

1. At the site: `node deploy/openbao/pki-files.mjs csr --out <csr file> --key <site key> --site <site file> --bao <address> --ca-file <site CA> --token-file <token file>`. The CSR file is signed so HQ knows which site sent it.
2. Carry the signed CSR file to HQ on approved media (the media handling runbook).
3. At HQ, offline: check the CSR file's signature, then sign it with the root.
4. Carry the signed certificate file back.
5. At the site: `node deploy/openbao/pki-files.mjs import-intermediate --in <signed certificate file> --public-key <public key> --root <HQ root pem> --chain-out <chain file> --bao <address> --ca-file <site CA> --token-file <token file>`. It checks the certificate before anything changes and writes the chain for the site file's `siteCaChain`.
6. `node deploy/bundle/install.mjs apply --from 46` with the same flags as before.

## 3. OpenBao: HSM or Shamir

**With an HSM (the default, seal `pkcs11`).** The site HSM must hold a FIPS 140-3 Level 3 certificate and run in its approved mode. HSM hardware is export-controlled: it follows your organization's Controlled Goods and ITAR procedures.

1. Initialise the token by the vendor's procedure, with the label the site's OpenBao file names (`sterling.pkcs11.tokenLabel`).
2. Create an AES-256 key labelled as the OpenBao seal expects (`sterling.pkcs11.keyLabel`). OpenBao creates no key material.
3. Put the PIN into the Secret `openbao-hsm-pin` (key `pin`) with `kubectl apply -f -`, the manifest on stdin, never on a command line.

**Without an HSM (seal `shamir`).** Decide the number of shares and the threshold. Each share is held by a different custodian. After every restart of an OpenBao pod, the threshold of custodians each enter their share with `bao operator unseal`.

**Initialisation.** When `install.mjs apply` stops after OpenBao, run `bao operator init` in the first OpenBao pod with the custodians present. Hand each recovery key (or unseal share) to a different custodian on approved media. The initial root token is used once, to create the operator tokens the runbooks name, then revoked. Then run `install.mjs apply --from 40`.

**Custodians in OpenBao.** Add each custodian's entity to the group `key-custodians` (made by `deploy/openbao/apply.mjs`). Two of them approve every key move (`moving-a-person.md`).

## 4. Two signing keys

Owner decision a: two different keys sign two different things.

- **The release key** is the existing cosign key in the protected GitHub environment `container-release` (owner as reviewer, release tags only, no admin bypass). It signs our images and releases only. It is never keyless and never used on pull requests or forks.
- **Your organization's site key** signs bundles, re-signed images, user exports, CSRs and revocation lists.
  - The ceremony generates it inside the production HSM. It never exists outside the HSM.
  - Record the key's PKCS#11 URI, without the PIN.
  - Its public key goes on the install media and into the site file as `organizationPublicKey`.
  - Signing uses the pinned cosign 3.1.4, with the private-key operation done through OpenSC `pkcs11-tool` (pkcs11-sign.mjs, 48.1-17).
  - User exports, CSRs and CRLs are signed by passing the site key's PKCS#11 URI as `--key`.
  - Development uses SoftHSM2 through the same PKCS#11 URI path: the owner runs new-dev-site-key.sh once (48.1-22; never an agent) and puts the printed public key in the site file. A production site refuses a SoftHSM2 signing token (the preflight rule `softhsm-signing-token`, 48.1-17).

## 5. HSM backup

1. Back the HSM up to a second HSM by the vendor's procedure, with two custodians present.
2. Keep the second HSM at your organization's second site with the off-site copy, but carried separately from the backups.
3. Record the backup: `node deploy/bundle/escrow.mjs record-key-backup --out <folder> --token-label <label> --token-serial <serial> --backup-ref <the backup's identifier> --custodians <a,b> --held-at <site>`. The record holds names only, no key material and no PIN.

## 6. Transit keys auditors verify

1. Create the keys `audit-archive` (48.1-14) and `offsite-manifest` (47-33) by running `deploy/openbao/apply.mjs` at the ceremony. Both are non-exportable.
2. Export each public key to your organization's auditors, and record its fingerprint (SHA-256 of the public key) on the ceremony record.
3. Record the first archive manifest's day and digest as the auditors' verification anchor, and the first off-site manifest the same way.

## 7. Escrow custody

The escrow folders from `escrow-node.sh save` and `escrow.mjs export` hold the RKE2 server token, the encryption configuration and the `longhorn-crypto` key: everything a rebuilt site needs to read its backups.

- Two key custodians write them to approved media and seal it.
- They store it with the recovery keys' custody, never with the backups and never on the backup target or the off-site copy.
- They keep the digest-only `escrow-record.json` with the site's runbook records.
- They make a new escrow whenever a check reports it stale (`bundle-update.md`, `maintenance.md`).
