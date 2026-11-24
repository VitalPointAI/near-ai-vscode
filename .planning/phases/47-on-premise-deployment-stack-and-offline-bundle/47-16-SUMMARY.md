---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 16
subsystem: deploy
status: complete
tags: [install, preflight, invariants, secrets, bootstrap-ca, registry, apply, openbao, opensearch, rke2, lab-vm]
requires: [47-05, 47-06, 47-07, 47-08, 47-10, 47-11, 47-12, 47-13, 47-14, 47-15, 47-22]
provides:
  - "deploy/bundle/install.mjs: node-files, bootstrap-ca, registry, import, preflight, secrets, apply (--from, --release), status, retire-bootstrap"
  - "deploy/bundle/lib/preflight.mjs preflight(): one 'rule: message' line per refusal, open to 48.1-17's softhsm-signing-token"
  - "deploy/bundle/lib/invariants.mjs checkRendered(): the D-56 checks CI and the site both run"
  - "deploy/bundle/lib/registry-images.mjs: the site-neutral registry-images.tar in the bundle, named for the site registry by node-files"
  - "deploy/bundle/record-digests.mjs: verify, then record published digests"
  - "render.mjs releaseInputs/writeValues/helmEnv and siteDir: a site installs exactly what CI renders, with its own per-release folder"
  - "Descriptor field secrets in use: longhorn-crypto (bootstrap), postgres-superuser, keycloak-db, keycloak-admin-bootstrap"
  - "Bundle tool items carry their pin's version (47-28's upgrade-check reads the RKE2 one)"
affects: [47-17, 47-18, 47-20, 47-28, 47-29, 47-32, 48.1-17]
tech-stack:
  added: []
  patterns:
    - "Bootstrap secrets: a secret needed before OpenBao is made in memory, applied on stdin, never replaced, and copied into OpenBao by the secrets step"
key-files:
  created:
    - deploy/bundle/install.mjs
    - deploy/bundle/lib/preflight.mjs
    - deploy/bundle/lib/invariants.mjs
    - deploy/bundle/lib/registry-images.mjs
    - deploy/bundle/record-digests.mjs
    - deploy/test/install.test.mjs
  modified:
    - deploy/bundle/lib/render.mjs
    - deploy/bundle/build.mjs
    - deploy/test/render.test.mjs
    - deploy/rke2/install-node.sh
    - deploy/values/sterling-storage.release.json
    - deploy/values/sterling-postgres.release.json
    - deploy/values/keycloakx.release.json
key-decisions:
  - "registry-images.tar is site-neutral in the bundle (the bundle is the same for every site); node-files checks it against the signed manifest's digest, then names each image for the site registry by tag and by digest (io.containerd.image.name). install-node.sh already places images/*.tar, so it changed only in its header"
  - "longhorn-crypto cannot come from OpenBao first: OpenBao's own data volume is on the encrypted class. It is a bootstrap secret: made in memory before sterling-storage, applied on stdin, never replaced when present, and copied into kv/apps/storage by the secrets step. It is 256 random bits (43 base64url characters); a shorter value in OpenBao is refused (G420)"
  - "apply runs the secrets step itself right after OpenBao is unsealed and configured, so the releases that need application secrets find them; install.mjs secrets also runs on its own"
  - "The unseal stop resumes with --from 40 (OpenBao itself), so deploy/openbao/apply.mjs is never skipped; OpenBao installs without helm --wait because its pods are Ready only once unsealed"
  - "The OpenSearch objects are put with the credential of Secret opensearch-admin (username, password), not opensearch-internal-users, which holds only bcrypt hashes; curl --config on stdin through kubectl exec -i"
  - "bootstrap-ca keeps the CA key only inside 0600 Secret manifests in the 0700 state folder until registry and apply load them; retire-bootstrap removes them with Secret site-bootstrap-ca and the Keycloak bootstrap administrator, refusing while openbao-tls or zot-tls is not a Ready site-pki certificate, and refusing to delete the administrator while no other enabled master-realm user exists"
  - "The registry import account's password reaches htpasswd -niB on stdin (httpd-tools from the site's OS repository); it stays 0600 in the state folder until the secrets step moves it into kv/apps/registry and removes the file"
  - "Built digests are not recorded: deploy-images on v0.4.38 (run 45410982998) only planned; its build, publish and built digests jobs were skipped. Publication is pending and the lock's built digests stay null"
requirements-completed: [DEP-01, DEP-06, DEP-12]
duration: ~2h
completed: 2026-11-24
estimate:
  tokens: 100000
  tasks: 3
actuals:
  tokens: 29900
  tasks: 3
  commits: 3
plan_head_before: b324400c
plan_head_after: 73ccee3e
---

# Phase 47 Plan 16: The site install script Summary

**One Node script on the import host now runs a site install from the imported bundle: the preflight refuses every unsafe setting and re-runs CI's render invariants on the site's own values, node-files wrote a folder from which an air-gapped FIPS VM installed RKE2 with the registry image already named for the site registry, and apply installs every release in order, stopping at the two key ceremonies.**

## Performance

- Tasks: 3 of 3. Commits: `fa009b2b` (Task 1), `6ef2422f` (Tasks 2 and 3: they share `install.mjs` and its test), `73ccee3e` (fix: volume key before OpenBao). Wave 7's four plans share the branch; `commits: 3` counts this plan's own (`git log b324400c..HEAD --grep '(47-16)'`).

## Task 1: preflight and the shared invariants

- `lib/invariants.mjs` `checkRendered(rendered, { lock, registry })` holds the D-56 checks moved out of `render.test.mjs`: digest pins and lock membership, pull policy Always, ACME issuers, ingress-nginx and its class, k3s outside Secret values, Loki. `render.test.mjs` calls it and asserts `problems` is empty, and a new case feeds it one document per ruled-out pattern, so a weakened check fails the test.
- `lib/preflight.mjs` rules: `requested-storage`, `sign-in-keys`, `aaguid-allowlist`, `rp-id`, `storage-encryption`, `organization-key`, `bundle`, `unpublished-image`, `omitted-items`, `lab-placeholder`, `time-settings`, `host-clock` (47-22's `checkHostClock`; skipped with `--lab`), `softhsm-seal-token` (libsofthsm2 in the openbao site file, or the `sterling/openbao-softhsm` image in the render), and `render` (every `checkRendered` problem on the site's own render).
- `install.mjs preflight` on the CI site with a bundle whose manifest omits the workbench: exit 1 with `omitted-items: the bundle leaves out sterling/sterling-workbench`; with `--lab`: `host-clock: skipped (--lab).` then `preflight: the site is ready to install.`, exit 0 (both in `install.test.mjs`).

## Task 2: node files, bootstrap CA, registry, import, secrets, digests

### Lab: node-files to a running node (air-gapped VM)

A fresh VM (`deploy/lab/vm.sh up`, Rocky 9.9, FIPS, LUKS overlay, no route out). On the host: an install folder like the import writes (the four RKE2 artifacts, `registry-images.tar` written by `writeRegistryLayout` from spike S2's Zot store, a manifest with its digest), then `bootstrapCa` and `nodeFiles` with the lab site (registry `registry.lab.internal:30500`, refclock `PHC /dev/ptp0 poll 2`):

```
registry-images.tar (site-neutral) sha256:1aede718...8364a
node folder: audit-policy.yaml check-time.sh chrony.conf clock.env config.yaml escrow-node.sh images/ install-node.sh pins.sha256 psa.yaml
             registries.yaml rke2-images-canal... rke2-images-core... rke2-selinux-0.24-1.el9.noarch.rpm rke2.linux-amd64.tar.gz site-ca.crt
missing: sha256sum-amd64.txt (a checksum asset install-node.sh does not use)
pins.sha256 ends with: 5f6c9672...c7cc  images/registry-images.tar (the archive named for the site)
```

In the guest, `sh install-node.sh /home/lab/node7`:

```
check-time: clock synchronised: reference PHC0, stratum 1, bound 559.825 ms (limit 1000 ms)
install-node exit 0
kubectl get nodes -> sterling-lab   Ready   control-plane,etcd   v1.37.2+rke2r1
/var/lib/rancher/rke2/agent/images/registry-images.tar (77701120 bytes)
crictl images --digests -> registry.lab.internal:30500/project-zot/zot   v2.1.23   b68f727fe35c1   77.7MB
```

The registry's image was in containerd under the site registry's name and the bundle's digest before any registry existed (Pitfall 8). Lab-only, as in 47-05 and 47-13: `container-selinux` from the Rocky AppStream and a default route via 10.0.2.2.

### The rest of Task 2

- `bootstrap-ca` uses the host's `openssl` (EC P-256, 90 days): the CA is `CA:TRUE`, the registry certificate carries `DNS:<registry host>` (or an IP SAN) and verifies against the CA; both Secret manifests are 0600 in the 0700 state folder; a second run is refused (test with the real openssl).
- `registry`, `import` and `secrets` as in the decisions above; the secrets test shows no secret value in any spawned argv, kv written only when absent (`cas 0`), nothing written on a second run, Keycloak and Postgres sharing one password, and a short volume key refused.
- `build.mjs`: `registry-images.tar` from the lock's `image-registry` images (Zot and the Harbor set) through hauler, and `version` on every tool item.
- `record-digests.mjs --from --ci-registry --public-key` and `--release sterling/sterling-workbench=<ghcr ref>`: nothing is written unless every signature verifies; a name the lock does not list, or a workbench reference outside `ghcr.io/vitalpointai/near-ai-vscode`, is refused (test with an injected verifier). Not run: no image has been published (decisions).

## Task 3: ordered apply, ceremony stops, resume, status, retirement

Test cases with a fake runner (no cluster):

- the helm releases go in the descriptors' `order` (instances expanded, the registry and the realm release excluded), with `openbao-apply`, `secrets`, `realm` and `opensearch-objects` between them; `sterling-pki-bootstrap` is uninstalled just before `sterling-pki`;
- OpenBao not initialised: stop after `openbao`, "Follow deploy/runbooks/key-ceremony.md (OpenBao initialisation and unseal), then run install.mjs apply --from 40"; the resume re-applies OpenBao, then stops before `sterling-pki` until the intermediate is signed, and the next resume finishes;
- apply again only upgrades and never reinstalls the bootstrap release; admission is installed in Audit and switched to Deny as the last step only once the import recorded every signature present, and stays Deny afterwards;
- `retire-bootstrap` deletes nothing until `openbao-tls` and `zot-tls` are Ready `site-pki` certificates, then deletes Secret `site-bootstrap-ca`, the Keycloak bootstrap administrator and Secret `keycloak-admin-bootstrap`, and the bootstrap key files;
- the OpenSearch objects present in the rendered release (today the 47-10 retention policy; the snapshot repository and policy when 47-24 merges) go through `kubectl exec -i ... curl --config -` twice, the credential in no argv;
- the volume key is made before `sterling-storage` and OpenBao, only on stdin, never when it already exists, and the secrets step copies the cluster's value into OpenBao.

## Verification

- `deploy/test/install.test.mjs` with the pinned helm 4.3.2: 20 run, 20 pass (all added by this plan).
- `deploy/test/render.test.mjs`: 8 run, 8 pass (1 added: the shared invariants per pattern; the global invariants test calls `checkRendered`).
- First run of `install.test.mjs`: 17 of 18 passed. The failure was in the test: an unsynchronised clock gives three `host-clock` problems, not one; the case now compares the set of rule names.
- Wave close: `deploy/test/*.test.mjs` with helm 4.3.2 and cosign 3.1.4 under the cap, see 47-17-SUMMARY.md.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The volume key and OpenBao depended on each other**
- Found during: Task 3 (writing the runbook order). The storage class said `longhorn-crypto` comes from OpenBao `kv/apps/storage`, but OpenBao's own data volume is on that class.
- Fix: bootstrap secrets (decisions). Commit `73ccee3e`.

**2. [Rule 1 - Bug] Resuming after the unseal skipped OpenBao's configuration**
- Found during: Task 3. Resuming from the release after OpenBao would never run `deploy/openbao/apply.mjs`.
- Fix: the stop resumes from OpenBao itself; OpenBao installs without `--wait`. Commit `73ccee3e`.

**3. [Rule 1 - Bug] The OpenSearch credential**
- `opensearch-internal-users` holds bcrypt hashes, which cannot sign in. The put uses Secret `opensearch-admin`; declaring it is part of G421.

**4. [Rule 3 - Blocking] render.mjs shared with the install**
- `releaseInputs`, `writeValues`, `helmEnv` and `siteDir` added so the install and CI render identically; not in the plan's file list.

### Plan adjustments

- `registry-images.tar` is site-neutral in the bundle and named per site by node-files (decisions); `install-node.sh` needed only its header.
- `retire-bootstrap` also needs `--ca-file` (Keycloak's admin API over the site CA) and refuses to remove the bootstrap administrator while it is the only enabled master-realm user.
- `install.mjs secrets` is also run by apply after the unseal.

## Known Stubs

None in code. The undeclared application secrets are G421.

## Threat Flags

None beyond the plan's register: every new path that handles a secret (bootstrap CA, import account, volume key, OpenSearch and Keycloak credentials) keeps it on stdin, in memory or in 0600 files in the 0700 state folder, and the tests check argv.

## Self-Check: PASSED

- Files exist: install.mjs, preflight.mjs, invariants.mjs, registry-images.mjs, record-digests.mjs, install.test.mjs.
- Commits `fa009b2b`, `6ef2422f` and `73ccee3e` are ancestors of HEAD.

## Open conditions

- G421: only longhorn-crypto, postgres-superuser, keycloak-db, keycloak-admin-bootstrap and the registry account are written; the other application secrets are not declared yet.
- G423: apply, secrets, the OpenSearch objects, status and retire-bootstrap have run only against a fake runner; 47-18 installs a lab site with them.
- G420: the volume key is now generated with 256 random bits and a short one refused; it closes when 47-18 shows it in use and escrowed.
- G367: the import host clock check and the node clock files are now in the install (47-22's code wired here); drift alerting is 48.1's.
