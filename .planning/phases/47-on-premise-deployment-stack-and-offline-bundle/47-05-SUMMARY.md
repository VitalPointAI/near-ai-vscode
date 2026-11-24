---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 05
subsystem: deploy
status: complete
tags: [rke2, cis, fips, zot, kyverno, admission, cosign, pod-security, audit, network-policy, lab-vm]
requires: [47-04]
provides:
  - "deploy/lab/vm.sh: the air-gapped lab VM (up, ssh, copy, down, status) every later lab step uses"
  - "deploy/rke2/{config,registries,audit-policy,psa}.yaml and install-node.sh (hash-checked air-gap node install)"
  - "deploy/charts/sterling-admission (ImageValidatingPolicy site-images-signed, ValidatingPolicy site-registry-only), order 25"
  - "deploy/charts/sterling-network (namespaces with Pod Security labels, egress-site-only per namespace), order 15"
  - "Zot values (TLS, import account, docker2s2, referrers) and per-site files deploy/values/site.example/{zot,kyverno}.yaml"
  - "deploy/test/rke2.test.mjs"
affects: [47-06, 47-10, 47-13, 47-16, 47-18]
tech-stack:
  added: []
  patterns:
    - "Registry bootstrap: the registry's own image is an OCI layout tar with the original manifest bytes, named by tag and by digest, preloaded into containerd"
    - "Per-component site settings in deploy/values/site.example/<release>.yaml, named by the descriptor's site field"
key-files:
  created:
    - deploy/lab/vm.sh
    - deploy/rke2/config.yaml
    - deploy/rke2/registries.yaml
    - deploy/rke2/audit-policy.yaml
    - deploy/rke2/psa.yaml
    - deploy/rke2/install-node.sh
    - deploy/values/site.example/zot.yaml
    - deploy/values/site.example/kyverno.yaml
    - deploy/charts/sterling-admission/Chart.yaml
    - deploy/charts/sterling-admission/values.yaml
    - deploy/charts/sterling-admission/templates/image-policies.yaml
    - deploy/values/sterling-admission.yaml
    - deploy/values/sterling-admission.release.json
    - deploy/charts/sterling-network/Chart.yaml
    - deploy/charts/sterling-network/values.yaml
    - deploy/charts/sterling-network/templates/namespaces.yaml
    - deploy/charts/sterling-network/templates/egress.yaml
    - deploy/values/sterling-network.yaml
    - deploy/values/sterling-network.release.json
    - deploy/test/rke2.test.mjs
  modified:
    - deploy/values/zot.yaml
    - deploy/values/zot.release.json
    - deploy/values/kyverno.yaml
    - deploy/values/kyverno.release.json
key-decisions:
  - "Spike S2 passed: Kyverno 1.20 ImageValidatingPolicy with a static cosign key and ctlog.insecureIgnoreTlog: true verifies cosign v3 bundle-referrer signatures fully offline (research A1 confirmed); an unsigned digest, a tag-only reference and an off-registry image are all refused"
  - "site-registry-only is a Kyverno ValidatingPolicy (one admission engine), covering pods and pods/ephemeralcontainers"
  - "The Zot image is preloaded as an OCI layout tar holding the original linux/amd64 manifest bytes, named by tag and by digest; kubelet then finds <name>:<tag>@<digest> as already present"
  - "Kyverno trusts only the site CA for signature lookups (admissionController.caCertificates.data in the per-site file), so an unset CA fails closed"
  - "The lab VM uses QEMU's vvfat driver for the cloud-init seed when no ISO or FAT tool is on the host, ECDSA P-256 SSH keys (FIPS guests refuse Ed25519), -vga std (the firmware never reaches the boot loader without it) and ipv6=off"
requirements-completed: [DEP-02]
duration: ~2h40m
completed: 2026-11-24
estimate:
  tokens: 95000
  tasks: 3
actuals:
  tokens: 9000
  tasks: 3
  commits: 3
plan_head_before: 93c0872b157f0a011e6190dea9c54e16c21113e5
plan_head_after: 8999fe1f
---

# Phase 47 Plan 05: Site base (RKE2, Zot, Kyverno admission, namespaces and egress) Summary

**On an air-gapped Rocky 9.9 VM in FIPS mode, RKE2 1.37.2 came up from the pinned artifacts with the CIS profile, Zot served from a preloaded archive, and Kyverno admitted only the image digest signed with the lab organization key: the unsigned digest, the tag-only reference and the off-registry image were each refused with the policy's message.**

## Tasks

| Task | Result | Commit |
|---|---|---|
| 1. Spike S2 end to end (tracer): lab VM, RKE2, Zot, Kyverno admission | done; tracer gate re-ran the render test end to end before expanding | `1d299caf` |
| 2. RKE2 audit policy, Pod Security exemptions, snapshot settings, invariants (TDD) | done; RED (2 of 5 failing on the missing files) then GREEN | `cb909983` |
| 3. sterling-network: namespaces and egress-site-only for every release | done | `8999fe1f` |

## Spike S2

Everything below ran on this host under the heavy-run lock. The VM was started by `deploy/lab/vm.sh up` with
`LAB_MEMORY=5G LAB_MEMORY_MAX=6G LAB_CPUS=4 LAB_TIMEOUT=3600 LAB_LOCK=/home/aaron/.cache/claude-code-tmp/heavy.lock` (the shared lock of this
machine; the script's default is `$XDG_RUNTIME_DIR/sterling-heavy-run.lock` with a 10G cap, owner item E5) and the guest image
`Rocky-9-GenericCloud-Base-9.9-20261112.0.x86_64.qcow2` (sha256 `4f88f420...46d50e`, from the publisher's CHECKSUM file; the operator supplies it,
the repository pins no OS image).

### Guest

```
cat /proc/sys/crypto/fips_enabled -> 1          (cloud-init ran fips-mode-setup --enable and rebooted)
getenforce                        -> Enforcing
ip route                          -> 10.0.2.0/24 dev eth0 ... (no default route: QEMU user networking with restrict=on)
curl -m 5 https://registry.access.redhat.com/v2/ -> curl: (6) Could not resolve host (exit 6)
cloud-init: Datasource DataSourceNoCloud [seed=/dev/vdb1]   (QEMU vvfat seed disk labelled CIDATA)
```

### Node install

`deploy/rke2/install-node.sh /home/lab/node` with the node folder made on the admin host: the four pinned RKE2 artifacts, `pins.sha256`
(generated from the `rke2` pin in `compliance/ci/tool-pins.json` plus the Zot archive), the four node files substituted with
`render.mjs --substitute` and the lab bootstrap CA as `site-ca.crt`.

```
rke2-selinux: Header V4 RSA/SHA256 Signature, key ID e257814a: NOKEY   (installed; integrity is the SHA-256 pin, the Rancher key is not imported)
install-node: rke2-server started
kubectl get nodes -> sterling-lab   Ready   control-plane,etcd   v1.37.2+rke2r1   containerd://2.3.7-k3s1
rke2 secrets-encrypt status -> Encryption Status: Enabled; Server Encryption Hashes: All hashes match
kubectl run psa-check -n default (no securityContext) -> Forbidden: violates PodSecurity "restricted:latest"
audit.log: 2629 events, all level Metadata; 170 events on secrets, 0 of them with a requestObject
```

### Registry bootstrap (Pitfall 8)

The Zot image went in as `images/zot.tar`: an OCI layout holding the original linux/amd64 manifest `sha256:b68f727f...` byte for byte, named
`registry.lab.internal:30500/project-zot/zot:v2.1.23` and `...@sha256:b68f727f...` through `io.containerd.image.name`.

```
crictl images --digests -> registry.lab.internal:30500/project-zot/zot  v2.1.23  b68f727fe35c1  77.7MB
event: Container image "registry.lab.internal:30500/project-zot/zot:v2.1.23@sha256:b68f727f..." already present on machine
curl --cacert site-ca.crt https://registry.lab.internal:30500/v2/ -> HTTP 200
```

### Images and signatures into the site registry

On the connected side the images were copied by digest into a staging Zot, `ubi9/ubi-micro@sha256:6e5529ed...` was signed with the lab key
(cosign 3.1.4, `--signing-config` empty, S1 flags) and the haul was made without `--key` or `--platform`. In the guest:

```
hauler login registry.lab.internal:30500 -u import ...; hauler store copy -s store-b registry://registry.lab.internal:30500
_catalog -> kyverno/kyverno, kyverno/kyvernopre, kyverno/readiness-checker, ubi9/ubi-micro, ubi9/ubi-minimal
GET /v2/ubi9/ubi-micro/referrers/sha256:6e5529ed... -> our bundle sha256:5641721c... (dev.sigstore.bundle.content dsse-envelope) plus Red Hat's
cosign verify --key cosign.pub --insecure-ignore-tlog .../ubi9/ubi-micro@sha256:6e5529ed...   -> verified, exit 0
cosign verify --key cosign.pub --insecure-ignore-tlog .../ubi9/ubi-minimal@sha256:2cb89fea... -> no matching attestations ... Found: 0, Expected 1, exit 1
```

### Admission

Kyverno (rendered from our values, hooks and helm test pods left out) plus `sterling-admission` rendered with `admission.mode: Deny` and the lab
public key. Both policies `READY true`.

```
signed, site registry   .../ubi9/ubi-micro@sha256:6e5529ed...  -> pod/signed created; condition met; Running
unsigned, site registry .../ubi9/ubi-minimal@sha256:2cb89fea... -> denied: admission webhook "ivpol.validate.kyverno.svc-fail-finegrained-site-images-signed":
                          Policy site-images-signed failed: An image is not signed with your organization's key. Only signed images from the site registry may run.
off-registry            registry.access.redhat.com/ubi9/ubi-micro@sha256:6e5529ed... -> denied: admission webhook "vpol.validate.kyverno.svc-fail":
                          Policy site-registry-only failed: Every image must come from the site registry registry.lab.internal:30500.
signed but by tag       .../ubi9/ubi-micro:9.9 -> denied: Policy site-images-signed failed: image ... does not have a digest
```

**Research A1 (the transparency-log setting):** `ctlog.insecureIgnoreTlog: true` skips only the Rekor lookup. The signature itself was
still checked against the static key: the unsigned digest was refused, and the signed one was admitted with no route out of the VM. Key-only
admission therefore works fully offline.

`vm.sh down` powered the guest off and stopped the unit; `vm.sh status` -> `stopped`. The lock was released.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] install-node.sh pin lookup under `set -e`**
- Found during: Task 1 (lab run). The `while read` lookup returned the last `[` test's status, so the script exited silently.
- Fix: the comparison is an `if`. Commit `1d299caf`.

**2. [Rule 3 - Blocking] Lab VM boot, SSH and addressing**
- Found during: Task 1. Without `-vga std` the guest firmware never reached GRUB. In FIPS mode the guest's sshd offers only ECDSA host keys and
  refuses an Ed25519 user key, and with an SSH agent present `-i` alone hits "Too many authentication failures". QEMU user networking also
  hands out IPv6, and RKE2 then chose an IPv6-only cluster (node IP `fec0::...`, service `fd00:43::...`).
- Fix: `-vga std`, an ECDSA P-256 lab key, `IdentitiesOnly=yes`, `HostKeyAlgorithms=ecdsa-sha2-nistp256`, and `ipv6=off` on the netdev for the
  next VM. This run went on over IPv6 (the registry name pointed at the node's IPv6 address in `/etc/hosts` and a `hostAliases` patch on
  Kyverno); 47-16's lab run uses the IPv4-only VM. Commit `1d299caf`.

**3. [Rule 2 - Missing critical] Kyverno trusts only the site CA**
- The plan said "trust the registry CA"; there is no site global for the CA and site globals are frozen in this wave, so it is a per-site file
  `deploy/values/site.example/kyverno.yaml` (descriptor field `site`), written by the install script (47-16). In the lab the same ConfigMap and
  mount the chart renders from that value were applied by a patch, because the rendered file used the empty example.

**4. Sequencing: `config.yaml` was completed in Task 1**
- The tracer's node needed the audit and PSA paths, so `config.yaml` went in complete with Task 1; Task 2's RED was on the missing
  `audit-policy.yaml` and `psa.yaml` (2 of 5 tests failing with ENOENT), then GREEN.

**5. `sterling-network` lists its own namespace**
- The coverage rule (every release namespace listed) includes `sterling-network`, the descriptor's own namespace; it is listed with
  `create: false` like `sterling-registry` (13 namespaces, 13 policies).

### Lab-only steps (not in the shipped files)

- `container-selinux` is not on the Rocky 9 GenericCloud image and `rke2-selinux` needs it. For the lab it came from the Rocky 9 AppStream
  (`container-selinux-2.250.0-1.el9`, sha256 `4ceadd24...`), checked with `rpm -K` after importing the OS's own Rocky key. A site's OS repository
  must carry it; 47-16's preflight should check for it.
- The Zot PVC was bound to a hostPath PersistentVolume of class `sterling-encrypted` (no Longhorn in lab-core); the VM disk itself is the LUKS
  overlay.
- Pods resolve names through CoreDNS, not the node's `/etc/hosts`: the site's DNS must serve the registry name (lab: `hostAliases`).

## Known Stubs

None. `deploy/values/site.example/kyverno.yaml` leaves the CA empty on purpose (each site's own CA, written by 47-16), and it fails closed.

## Threat Flags

None beyond the plan's threat model (T-47-14 to T-47-17 are mitigated as planned).

## Verification

- `deploy/test/render.test.mjs` + `deploy/test/rke2.test.mjs` with the pinned helm, under the memory cap: 14 tests run, 14 pass (7 of them added
  by this plan, in rke2.test.mjs). The render test now also renders `sterling-admission` and `sterling-network`.
- A fake descriptor naming `fake-new-namespace` made the coverage test fail (`actual: [ 'fake-new-namespace' ]`); it was removed, not committed.
- `bash -n deploy/lab/vm.sh`, `sh -n deploy/rke2/install-node.sh`: clean. The rendered admission release contains `kind: ImageValidatingPolicy`.

## Self-Check: PASSED

- All 20 created files exist; commits `1d299caf`, `cb909983`, `8999fe1f` are ancestors of HEAD.
