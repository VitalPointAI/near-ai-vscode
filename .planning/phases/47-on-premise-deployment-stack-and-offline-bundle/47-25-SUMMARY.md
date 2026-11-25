---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 25
subsystem: deploy
status: complete
tags: [escrow, backup, cp-9, cp-10, rke2, longhorn, hsm, cronjob, lab-vm]
requires: [47-05, 47-10]
provides:
  - "deploy/rke2/escrow-node.sh save <out-dir> | check <record>: the RKE2 server token and secrets-encryption configuration to escrow media, digest-only record, stale escrow named by file"
  - "deploy/bundle/escrow.mjs export --out | check --record | record-key-backup: longhorn-crypto to escrow media with one digest per key, the in-cluster record ConfigMap sterling-escrow-record, and HSM key backup records with no key material"
  - "CronJob sterling-escrow-currency in the sterling-storage release (daily 05:00 UTC): the signal 48.1-16's escrow-currency alert reads"
  - "Escrow record format sterling-escrow/1 (kind rke2, longhorn-crypto or hsm-key-backup)"
  - "deploy/test/escrow.test.mjs"
affects: [47-16, 47-17, 47-18, 47-26, 47-27, 47-33, 48.1-16]
tech-stack:
  added: []
  patterns:
    - "Digest-only escrow records: values stay on custody media, the record goes with the runbook records and into the cluster as a ConfigMap"
key-files:
  created:
    - deploy/rke2/escrow-node.sh
    - deploy/bundle/escrow.mjs
    - deploy/test/escrow.test.mjs
    - deploy/charts/sterling-storage/templates/escrow-currency.yaml
  modified:
    - deploy/values/sterling-storage.release.json
    - compliance/gaps.json
    - compliance/test/gaps.test.ts
key-decisions:
  - "Confirmed on RKE2 v1.37.2+rke2r1: the encryption configuration is /var/lib/rancher/rke2/server/cred/encryption-config.json and the token /var/lib/rancher/rke2/server/token; rke2 secrets-encrypt rotate-keys rewrites the configuration and leaves the token"
  - "The longhorn-crypto record holds one SHA-256 per key over the decoded value from the start (Task 3's form), not first a whole-data digest; check compares per key and names changed, missing and added keys"
  - "The escrowed longhorn-crypto.json is a Secret manifest (apiVersion, kind, metadata, type, data), so a restore is kubectl apply of the escrowed file"
  - "The CronJob mounts the record ConfigMap and the Secret as optional volumes: a site with no escrow yet gets a failed Job (the alert), not a pod that waits forever for its volume"
  - "record-key-backup needs two distinct custodians and refuses every option it does not know, so no PIN or key file can be passed"
  - "Split for the 48.1 ledger: longhorn-crypto currency is the in-cluster CronJob; the RKE2 token and encryption configuration are node files no restricted pod may read, so their currency is escrow-node.sh check, run after every rke2 secrets-encrypt rotate-keys (maintenance runbook) and on 48.1-04's monthly checklist"
requirements-completed: [DEP-02, DEP-11]
duration: ~30min
completed: 2026-11-24
estimate:
  tokens: 40000
  tasks: 3
actuals:
  tokens: 9400
  tasks: 3
  commits: 3
plan_head_before: faf87769d8728c566e5981117f57a968e69065c6
plan_head_after: 2119ddd1
---

# Phase 47 Plan 25: Escrow of the restore keys Summary

**One command each puts the RKE2 server token, the secrets-encryption configuration and the longhorn-crypto key on custody media with a digest-only record; on a real RKE2 node the escrow was current after save and named encryption-config.json as stale after `rke2 secrets-encrypt rotate-keys`, and the same held for a stand-in longhorn-crypto Secret; a daily CronJob gives 48.1-16's alert its signal.**

## Performance

- Tasks: 3 of 3. Commits: `00a96143` (Task 1), `58277300` (Task 2), `2119ddd1` (Task 3); the gap filing and this SUMMARY are in the plan's
  docs commit. Interleaved with 47-22's commits on the same branch (one lab VM served both), so `commits: 3` counts this plan's own
  (`git log faf87769..HEAD --grep '(47-25)'`).

## Task 1: escrow on a real RKE2 node and cluster

Same VM run as 47-22 (air-gapped Rocky 9.9 in FIPS mode, RKE2 installed with `install-node.sh` and 47-22's clock files, node Ready).
`escrow-node.sh` was copied into the node folder.

```
ls -l /var/lib/rancher/rke2/server/cred/encryption-config.json /var/lib/rancher/rke2/server/token
  -rw-------. 1 root root 245 ... encryption-config.json      -rw-------. 1 root root 109 ... token
rke2 secrets-encrypt status -> Encryption Status: Enabled; Current Rotation Stage: start; Server Encryption Hashes: All hashes match

sh escrow-node.sh save /root/escrow-test
  escrow-node: saved token and encryption-config.json with escrow-record.json in /root/escrow-test
  exit 0; drwx------ /root/escrow-test; -rw------- encryption-config.json, escrow-record.json, token
  record: { "format": "sterling-escrow/1", "kind": "rke2", "host": "sterling-lab", "createdAt": "2026-11-24T22:23:10Z",
            "files": [ { "name": "server/token", "sha256": "d168e832..." },
                       { "name": "server/cred/encryption-config.json", "sha256": "3f10863a..." } ] }
sh escrow-node.sh check /root/escrow-test/escrow-record.json
  escrow-node: escrow current (2 files, escrow of 2026-11-24T22:23:10Z)   exit 0

rke2 secrets-encrypt rotate-keys -> keys rotated, reencryption finished   exit 0
  status -> Current Rotation Stage: reencrypt_finished; Server Encryption Hashes: All hashes match
sh escrow-node.sh check /root/escrow-test/escrow-record.json
  escrow-node: server/cred/encryption-config.json rotated since the escrow on 2026-11-24T22:23:10Z; make a new escrow   exit 1
```

Stand-in `longhorn-crypto` in a new `longhorn-system` namespace (lab-core has no Longhorn; keys CRYPTO_KEY_PROVIDER, CRYPTO_KEY_VALUE from
32 random bytes, CRYPTO_PBKDF), then `escrow.mjs` on the host through an SSH forward of the API server, with `KUBECTL` set to the guest's
own kubectl and kubeconfig:

```
node deploy/bundle/escrow.mjs export --out $W/lab/lh-escrow
  escrow: wrote longhorn-crypto.json and escrow-record.json (3 keys: CRYPTO_KEY_PROVIDER, CRYPTO_KEY_VALUE, CRYPTO_PBKDF) in $W/lab/lh-escrow
  exit 0; drwx------ lh-escrow; -rw------- escrow-record.json, longhorn-crypto.json
  record: kind longhorn-crypto, resourceVersion 1451, createdAt 2026-11-24T22:24:32Z, keys [3 names with sha256]
kubectl -n longhorn-system get configmap sterling-escrow-record -> CRYPTO_KEY_PROVIDER.sha256, CRYPTO_KEY_VALUE.sha256, CRYPTO_PBKDF.sha256,
  escrow-record.json (digests and names only)
node deploy/bundle/escrow.mjs check --record .../escrow-record.json -> escrow: escrow current   exit 0
(the Secret re-applied with a new CRYPTO_KEY_VALUE)
node deploy/bundle/escrow.mjs check --record .../escrow-record.json
  escrow: CRYPTO_KEY_VALUE changed since the escrow on 2026-11-24T22:24:32Z; make a new escrow.   exit 1
```

No token or key value appears in any transcript: a search of every lab output file for the escrowed CRYPTO_KEY_VALUE found 0 matches, and
the token was never printed. `vm.sh down`: stopped, lock released.

## Task 2: escrow rules locked by tests

`deploy/test/escrow.test.mjs`, 6 cases: modes and matching digests; current then stale naming only the changed file; refusals inside the data
folder and over an existing record (the first record kept); export and check with a fake kubectl, including a missing Secret; no Secret value
in any console line or spawned argument; record-key-backup's record, its refusal of pin, soPin and keyFile fields and of
`--pin`, `--pin-file`, `--key`, `--key-file` and `--so-pin`, and of a single custodian.

The first run (cases written after Task 1's code) failed one case: the leak check listed every Secret value, and CRYPTO_KEY_PROVIDER's
value `secret` is also the word in kubectl's own `get secret` argument. The check now looks for the passphrase, the one confidential value,
encoded and decoded; the other two are fixed words. No script change was needed.

## Task 3: the in-cluster escrow-currency check

- `export` also applies ConfigMap `sterling-escrow-record` in `longhorn-system` through `kubectl apply -f -` with the manifest on stdin:
  `<key>.sha256` per key and the record. A failed apply exits 1 and says the escrow-currency check cannot see this escrow.
- `templates/escrow-currency.yaml` in `sterling-storage` (rendered with the storage class, so only when `storageProvider` is longhorn):
  CronJob `sterling-escrow-currency`, `0 5 * * *` in `Etc/UTC`, `concurrencyPolicy: Forbid`, `backoffLimit: 0`, our `sterling/openbao`
  by digest through the descriptor's new `images` entry (`escrowCurrency.image`, part `ref`), Secret and ConfigMap mounted read-only,
  runAsNonRoot 65532, read-only root, no privilege escalation, all capabilities dropped, RuntimeDefault seccomp, no service account token.
  Its sh script hashes each key file the record names and exits 1 on a changed, missing or added key or on no record, printing key names only.
- 3 cases added: one digest per decoded key; the ConfigMap on stdin with no value, and a failed apply reported; the rendered CronJob's
  read-only mounts, security context, schedule, image by digest, no env or secretKeyRef, and no Secret value in any rendered document.

## Verification

- Task 1 automated verify (syntax, help naming export, exit 2 with no arguments): passes.
- `deploy/test/escrow.test.mjs deploy/test/render-site.test.mjs deploy/test/render.test.mjs` with the pinned helm 4.3.2, under the cap:
  20 run, 20 pass (9 added here).
- Wave close, `deploy/test/*.test.mjs` with helm 4.3.2 and cosign 3.1.4 under the cap: 116 run, 116 pass, 0 skipped.
- `compliance/test/gaps.test.ts` (count 391 to 393 for G419 and G420): 19 run, 19 pass.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Leak check false positive (test only)**
- Found during: Task 2's first run. Fixed as above; commit `58277300`.

### Plan adjustments

- Task 1 wrote the per-key record form Task 3 specifies directly, instead of a whole-data digest replaced two tasks later.
- The CronJob's Secret and ConfigMap volumes are optional, so a missing escrow fails the Job instead of leaving the pod pending.

### Lab-only steps (not in the shipped files)

- The default route via 10.0.2.2 (47-22's run). The host used the guest's own kubectl through an SSH forward of port 6443; no kubectl is
  pinned on the import host yet (47-16's tools).

## Known Stubs

None. The CronJob renders with the reserved unpublished `sterling/openbao` digest until the image is published, like the OpenBao release;
G419 tracks running it.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: information-disclosure | deploy/bundle/escrow.mjs | The digest-only record and ConfigMap hold SHA-256 digests of each longhorn-crypto value; safe only while CRYPTO_KEY_VALUE is random (G420, to 47-16) |

## Self-Check: PASSED

- Files exist: escrow-node.sh, escrow.mjs, escrow.test.mjs, escrow-currency.yaml.
- Commits `00a96143`, `58277300` and `2119ddd1` are ancestors of HEAD.

## Open conditions

- G419: the escrow-currency CronJob has run only in render and unit tests; 47-18's lab run with the published sterling/openbao digest runs it.
- G420: the longhorn-crypto value must be random for digest-only records to be safe; 47-16 generates it and refuses a short one.
- G35: backup reliability, custody and key access evidence at a site (shared).
