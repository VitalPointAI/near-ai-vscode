---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 01
subsystem: infra
tags: [cosign, hauler, zot, postgresql, pgdg, ubi9, rke2, helm, openbao, softhsm2, tool-pins, digest-pinning]
status: complete

requires: []
provides:
  - "SHA-256 pins for cosign, hauler, postgresql (+assets), helm, rke2 (+4 assets), kms-pkcs11, softhsm2 in compliance/ci/tool-pins.json"
  - "Digest-pinned base stages for eight rebuilt images under deploy/images/<name>/Containerfile"
  - "deploy/images/README.md: the image.json build-definition contract"
  - "Spike S1 result (cosign 3.1.4 key mode + hauler 2.1.2 offline) and Spike S3 result (PostgreSQL 18.7 PGDG on UBI 9)"
affects: [47-02, 47-03, 47-04, 47-06, 47-07, 47-09, 47-11, 47-16]

actuals:
  tokens: 5000        # chars/4 over the shipped diff (tool-pins.json + deploy/images), SUMMARY excluded
  tasks: 3
  commits: 4          # 3 task commits + this SUMMARY commit; the shared branch also carries 47-02's commits, not counted
plan_head_before: bbba39932adf4539852b4ca61820babe371ff6f7
plan_head_after: b7f094f9   # last task commit; the SUMMARY commit follows it

tech-stack:
  added: [cosign 3.1.4, hauler 2.1.2, helm 4.3.2, rke2 1.37.2+rke2r1, rke2-selinux 0.24-1.el9, kms-pkcs11 0.3.0, softhsm2 2.7.0, postgresql 18.7 (PGDG)]
  patterns:
    - "Pin kinds in tool-pins.json: archive binary (raw executable) and file (placed as-is), optional assets[] of {url, sha256}"
    - "FROM <registry>/<repo>:<tag>@sha256:<linux/amd64 manifest digest>"
    - "cosign 3.x key signing with an empty signing config (no Rekor, no TSA) instead of --tlog-upload=false"

key-files:
  created:
    - deploy/images/README.md
    - deploy/images/theia-cloud-operator/Containerfile
    - deploy/images/theia-cloud-service/Containerfile
    - deploy/images/theia-cloud-conversion-webhook/Containerfile
    - deploy/images/theia-cloud-landing-page/Containerfile
    - deploy/images/oauth2-proxy/Containerfile
    - deploy/images/postgres/Containerfile
    - deploy/images/openbao/Containerfile
    - deploy/images/openbao-softhsm/Containerfile
  modified:
    - compliance/ci/tool-pins.json

key-decisions:
  - "Keep hauler 2.1.2 (S1): it carries cosign v3 bundle referrers and preserves digests offline; oras is not needed"
  - "cosign 3.1.4 rejects --tlog-upload=false; sign with --signing-config pointing at an empty signing config (cosign signing-config create) and verify with --insecure-ignore-tlog"
  - "hauler --key cannot verify cosign v3 bundle signatures; verify with cosign before hauler store add and again after the copy at the site"
  - "Pin the linux/amd64 image manifest digest, not the index: hauler refuses --platform on an index digest, and the amd64 digest survives the copy with its own signatures"
  - "Zot must run with http.compat [docker2s2] to accept Red Hat (Docker media type) images unchanged"
  - "Postgres for Keycloak: PostgreSQL 18.7 from PGDG EL-9 RPMs on ubi9/ubi-minimal (S3 passed); no Red Hat registry image needed"

patterns-established:
  - "Every downloaded artifact is checked against the publisher's checksum before use and pinned once in tool-pins.json"

requirements-completed: [DEP-01, DEP-04, DEP-07, DEP-10]

coverage:
  - id: D1
    description: "cosign key mode and hauler carry a signed image and a signed file into an offline registry; signature verifies there"
    requirement: DEP-01
    verification:
      - kind: manual_procedural
        ref: "Spike S1 commands below (registry B in --network none, copy container on B's network namespace only)"
        status: pass
  - id: D2
    description: "PostgreSQL 18.7 runs on UBI 9 minimal from signature-checked PGDG RPMs"
    requirement: DEP-04
    verification:
      - kind: manual_procedural
        ref: "Spike S3 commands below (initdb, start, select version() with --network none)"
        status: pass
  - id: D3
    description: "Every phase download pinned by SHA-256 in tool-pins.json"
    requirement: DEP-07
    verification:
      - kind: other
        ref: "Task 1 and Task 3 <automated> node checks; 18 hashes, all 64-hex; each equal to the publisher checksum"
        status: pass
  - id: D4
    description: "Eight rebuilt images have digest-pinned base stages; build contract written"
    requirement: DEP-10
    verification:
      - kind: other
        ref: "Task 2 <automated> node check; node scripts/resource-check.mjs passes"
        status: pass

duration: 20min
completed: 2026-11-24
---

# Phase 47 Plan 01: Tool pins, rebuilt-image bases and spikes S1/S3 Summary

**cosign 3.1.4 key signing plus hauler 2.1.2 proven end to end into an offline Zot (signature verifies with no network), PostgreSQL 18.7 proven on UBI 9 minimal from signature-checked PGDG RPMs, and every phase download and rebuilt-image base pinned by SHA-256.**

## Performance

- Duration: about 20 minutes (03:19 to 03:39 UTC, 2026-11-24)
- Tasks: 3 of 3
- Files: 10 created, 1 modified

## Accomplishments

- Spike S1 passed: a cosign key signature made on the connected side verified in a second registry reached only through a container with no route out. hauler is kept.
- Spike S3 passed: PostgreSQL 18.7 (the highest major Keycloak 26.8 lists, "18.x, 17.x, 16.x, 15.x, 14.x") installs from the PGDG EL-9 RPMs on `ubi9/ubi-minimal` with RPM signature checks enforced, and answers `select version()`. No owner checkpoint is needed for the Red Hat registry path.
- `compliance/ci/tool-pins.json` now pins 10 tools with 18 SHA-256 values; the existing `oscal-cli`, `syft` and `grype` entries are unchanged (compared with `origin/main` as parsed JSON: unchanged; the only byte change in that region is the comma after `grype`'s closing brace).
- Eight Containerfiles carry only digest-pinned base stages; `deploy/images/README.md` defines `image.json`.

## Task Commits

1. Task 1, spikes S1 and S3, pins cosign, hauler, postgresql: `9a548bd9`
2. Task 2, base stages of the eight rebuilt images: `bc9042e6`
3. Task 3, pins helm, rke2, kms-pkcs11, softhsm2 and the build-definition contract: `b7f094f9`

## Every pin recorded

| Key | Version | sha256 (first 12) | Checked against |
|---|---|---|---|
| cosign | 3.1.4 | 424e2c97d0b4 | `cosign_checksums.txt` line `cosign-linux-amd64` |
| hauler | 2.1.2 | 5c4c5b54a4a2 | `hauler_2.1.2_checksums.txt` |
| postgresql (server RPM) | 18.7 | 67c997e865de | PGDG repo `primary.xml.gz` (its hash matched `repomd.xml`) |
| postgresql asset: client RPM | 18.7 | 9b1efaf68362 | same |
| postgresql asset: libs RPM | 18.7 | d7f708ca1836 | same |
| postgresql asset: PGDG-RPM-GPG-KEY-RHEL | fpr D4BF08AE67A0B4C7A1DBCCD240BCA2B408B40D20 | a70c95274260 | fingerprint read with `gpg --show-keys`; RPM key id 40bca2b408b40d20 |
| helm | 4.3.2 | d1c0278d46be | `helm-v4.3.2-linux-amd64.tar.gz.sha256sum` on get.helm.sh |
| rke2 (`rke2.linux-amd64.tar.gz`, bin `bin/rke2`) | 1.37.2+rke2r1 | 0568f48d772c | `sha256sum-amd64.txt` |
| rke2 asset: rke2-images-core.linux-amd64.tar.zst | | e517534d66ec | `sha256sum-amd64.txt` |
| rke2 asset: rke2-images-canal.linux-amd64.tar.zst | | 18728448092a | `sha256sum-amd64.txt` |
| rke2 asset: sha256sum-amd64.txt | | c924bec113c1 | GitHub release asset digest |
| rke2 asset: rke2-selinux-0.24-1.el9.noarch.rpm (release v0.24.stable.1) | 0.24-1 | f220147db3e6 | `sha256sum-centos9-noarch.txt`, the rpm.rancher.io stable EL9 repo metadata and the GitHub asset digest (all three equal) |
| kms-pkcs11 (tarball) | 0.3.0 | c112c670e1bc | `checksums-kms-pkcs11.txt` |
| kms-pkcs11 `binSha256` (extracted `openbao-plugin-kms-pkcs11_linux_amd64_v1`) | 0.3.0 | 96fefa80e721 | `checksums-kms-pkcs11.txt` line for the binary (re-hashed after extraction) |
| softhsm2 (GitHub tag archive) | 2.7.0 | be14a5820ec4 | no publisher checksum: hash taken on first download; the tag points at commit 13e6e86b83748fef74046dbf0c91f664b7acc1c3, which the GitHub API reports `verified: true, reason: valid` |

The rke2-selinux choice: RKE2 1.37's `rke2-common` RPM requires `rke2-selinux >= 0.12`, and the Rancher stable EL9 channel's newest is 0.24-1, the asset of GitHub release `v0.24.stable.1`. A release `v0.24.latest.1` carries a file of the same name; the pin is the stable one.

## Base images pinned (Task 2)

All are the linux/amd64 image manifest digest; each was fetched by digest and its bytes re-hashed to that digest.

| Base | Tag | linux/amd64 digest (first 12) | Index digest (for reference) | Used in |
|---|---|---|---|---|
| registry.access.redhat.com/ubi9/openjdk-21 | 1.24 | 678acf0a00bb | a207a1292e22 | operator, service, conversion webhook (`build`) |
| registry.access.redhat.com/ubi9/openjdk-21-runtime | 1.24 | 7fc9128f130f | 80663340693d | operator, service, conversion webhook |
| registry.access.redhat.com/ubi9/nodejs-22 | 9.9 | 806f1f15c1a2 | 9939252c87bd | landing page (`build`) |
| registry.access.redhat.com/ubi9/nginx-126 | 9.9 | 84a9a99efbef | a9948e4d1f7a | landing page |
| registry.access.redhat.com/ubi9/go-toolset | 1.27 (label version 1.27.3) | ecfbfea4a8c4 | 23c7cb17e9c5 | oauth2-proxy (`build`) |
| registry.access.redhat.com/ubi9/ubi-minimal | 9.9 | 2cb89feabb13 | 08d4c70f1baf | oauth2-proxy, postgres |
| quay.io/openbao/openbao-ubi | 2.7.3 | bb94f6b1f1a3 | 28c524c262af | openbao |
| registry.access.redhat.com/ubi9/ubi | 9.9 | 5a8bf48617eb | 6636b79fba9e | openbao-softhsm (`softhsm-build`) |

Research A16 is answered: the `go-toolset:1.27` image's version label is 1.27.3, so Go 1.24+ for `GOFIPS140` is there (read from the image config, not by running `go version`).

## Spike S1

Setup on this connected host. `D=compliance/out/tools/spike-s1` (git-ignored), binaries in `$D/bin`, scratch in `$D/work`. Every container run and the image pulls ran under `flock /home/aaron/.cache/claude-code-tmp/heavy.lock systemd-run --user --scope -q -p MemoryMax=6G choom -n 1000 -- timeout <s>`. cosign and hauler ran with `HOME=$D/work/home` so their caches stayed in the spike folder; `COSIGN_PASSWORD` came from the environment.

### Downloads (checked before anything ran)

```
curl -fsSL --proto =https --proto-redir =https -o $D/cosign/cosign-linux-amd64 https://github.com/sigstore/cosign/releases/download/v3.1.4/cosign-linux-amd64
curl ... -o $D/cosign/cosign_checksums.txt https://github.com/sigstore/cosign/releases/download/v3.1.4/cosign_checksums.txt
  release line: 424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa  cosign-linux-amd64
  sha256sum:    424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa
curl ... -o $D/hauler/hauler_2.1.2_linux_amd64.tar.gz https://github.com/hauler-dev/hauler/releases/download/v2.1.2/hauler_2.1.2_linux_amd64.tar.gz
curl ... -o $D/hauler/hauler_2.1.2_checksums.txt https://github.com/hauler-dev/hauler/releases/download/v2.1.2/hauler_2.1.2_checksums.txt
  release line: 5c4c5b54a4a249bbafebd069dda3df86622515c93fa6657b045e081d82b7b2ce  hauler_2.1.2_linux_amd64.tar.gz
  sha256sum:    5c4c5b54a4a249bbafebd069dda3df86622515c93fa6657b045e081d82b7b2ce
cosign version  -> GitVersion: v3.1.4, GitCommit 0e48502cf5ef34e2e60bbd3617aa19945712f705, go1.27.3
hauler version  -> GitVersion: 2.1.2, GitCommit f16c6e3, go1.27.2-X:boringcrypto
```

### Registries

Zot config (both): `{"distSpecVersion":"1.1.1","storage":{"rootDirectory":"/var/lib/registry"},"http":{"address":"0.0.0.0","port":"5000","compat":["docker2s2"]},"log":{"level":"warn"}}`

```
podman run -d --name p47s1-zot-a --memory 512m -p 127.0.0.1:5000:5000 -v $W/zot-config.json:/etc/zot/config.json:ro ghcr.io/project-zot/zot-linux-amd64:v2.1.23
podman run -d --name p47s1-zot-b --memory 512m --network none        -v $W/zot-config.json:/etc/zot/config.json:ro ghcr.io/project-zot/zot-linux-amd64:v2.1.23
podman inspect p47s1-zot-b --format '{{.HostConfig.NetworkMode}}'   -> none
```

Finding (for 47-02 and the site registry values): **Zot rejects Docker media-type manifests by default.** Without `"compat":["docker2s2"]` the copy of the UBI index failed: `PUT .../manifests/sha256:6e5529ed... : 415 Unsupported Media Type, manifest invalid` (the linux/amd64 child is `application/vnd.docker.distribution.manifest.v2+json`). Red Hat's UBI images use Docker media types, so the site Zot needs `http.compat: ["docker2s2"]` to store them unchanged (converting them would change the digest). A second, smaller finding: listening on `127.0.0.1` inside the container breaks rootless port publishing (`curl: (56) Connection reset by peer`); Zot must listen on `0.0.0.0` inside its own network namespace.

### Seed registry A by digest

```
IDX=sha256:dbd325b96bcd432dd42816d31412bdf1dc0fb973b79ed310344bc23c76c068db   # ubi9/ubi-micro:9.9 index (HEAD on registry.access.redhat.com)
hauler store add image registry.access.redhat.com/ubi9/ubi-micro@$IDX -s $W/store-seed
  -> ✓ added registry.access.redhat.com/ubi9/ubi-micro@sha256:dbd325b9... (59 layers, 34 MB)
     store info: 4 platforms (amd64, arm64, ppc64le, s390x) plus Red Hat's own sigs (5), atts (5), sboms (5), referrers (5, artifactType application/vnd.dev.sigstore.bundle.v0.3+json)
hauler store copy -s $W/store-seed --plain-http registry://127.0.0.1:5000
  -> copied artifacts to [127.0.0.1:5000]
curl http://127.0.0.1:5000/v2/_catalog  -> {"repositories":["ubi9/ubi-micro"]}
HEAD /v2/ubi9/ubi-micro/manifests/$IDX  -> Docker-Content-Digest: sha256:dbd325b9...   (upstream digest preserved into A)
```

Repository path mapping: `registry.access.redhat.com/ubi9/ubi-micro` became `ubi9/ubi-micro` (source host stripped, repository path kept). Files become `hauler/<file name>` (for example `hauler/manifest.json:latest`). hauler pushes digest-pinned images by digest only (no tag); the only tags created are the cosign `sha256-<hex>.sig/.att/.sbom` tags that came with the image.

### Key pair, sign, verify (cosign 3.1.4)

```
cosign generate-key-pair                       -> cosign.key ("BEGIN ENCRYPTED SIGSTORE PRIVATE KEY", 0600), cosign.pub ("BEGIN PUBLIC KEY")

cosign sign --key cosign.key --tlog-upload=false --allow-http-registry -y 127.0.0.1:5000/ubi9/ubi-micro@$IDX
  -> Flag --tlog-upload has been deprecated, prefer using a --signing-config file with no transparency log services
     Error: --tlog-upload=false is not supported with --signing-config or --use-signing-config. ...   (exit 1)

cosign signing-config create --out signing-config.json
  -> {"mediaType":"application/vnd.dev.sigstore.signingconfig.v0.2+json", "rekorTlogConfig":{}, "tsaConfig":{}}
cosign sign --key cosign.key --signing-config signing-config.json --allow-http-registry -y 127.0.0.1:5000/ubi9/ubi-micro@$IDX
  -> Signing artifact... Pushing signature to: 127.0.0.1:5000/ubi9/ubi-micro   (exit 0)
cosign verify --key cosign.pub --insecure-ignore-tlog --allow-http-registry 127.0.0.1:5000/ubi9/ubi-micro@$IDX
  -> "The signatures were verified against the specified public key" (exit 0)
     critical: {"identity":{"docker-reference":"127.0.0.1:5000/ubi9/ubi-micro@sha256:dbd325b9..."},"image":{"docker-manifest-digest":"sha256:dbd325b9..."},"type":"https://sigstore.dev/cosign/sign/v1"}

cosign sign-blob --key cosign.key --signing-config signing-config.json --bundle manifest.json.sigstore.json -y manifest.json
  -> Wrote bundle to file manifest.json.sigstore.json (exit 0)
cosign verify-blob --key cosign.pub --insecure-ignore-tlog --bundle manifest.json.sigstore.json manifest.json
  -> Verified OK (exit 0)
cosign verify-blob ... --bundle manifest.json.sigstore.json tampered.json
  -> Error: ... invalid signature when validating ASN.1 encoded signature (exit 1)
```

The flags that work on 3.1.4 (47-04 and 47-06 must use these, not `--tlog-upload=false`):

- sign image: `cosign sign --key <key> --signing-config <empty signing config> -y <image@digest>` (add `--allow-http-registry` only for a plain-HTTP lab registry). In CI the key is `--key env://COSIGN_PRIVATE_KEY`; the empty signing config is a committed file or made with `cosign signing-config create --out <file>`.
- verify image: `cosign verify --key <pub> --insecure-ignore-tlog <image@digest>`.
- sign file: `cosign sign-blob --key <key> --signing-config <empty signing config> --bundle <file>.sigstore.json -y <file>`.
- verify file: `cosign verify-blob --key <pub> --insecure-ignore-tlog --bundle <file>.sigstore.json <file>`.

Signature format: `cosign sign` writes a Sigstore bundle v0.3 as an **OCI 1.1 referrer** of the signed digest (manifest `sha256:bcfad4babe978b417494f853b5ad078fc09b34fc23e13e8018178447da842b33`, `artifactType: application/vnd.dev.sigstore.bundle.v0.3+json`, annotations `dev.sigstore.bundle.content: dsse-envelope`, `dev.sigstore.bundle.predicateType: https://sigstore.dev/cosign/sign/v1`); it does **not** write a `sha256-<hex>.sig` tag (the existing `.sig` tag, Red Hat's, kept its digest `sha256:9157c493...`). `sign-blob` writes a single JSON bundle file (`mediaType application/vnd.dev.sigstore.bundle.v0.3+json`, `verificationMaterial.publicKey`, `messageSignature.messageDigest` SHA2_256). The legacy tag format is still reachable through `--new-bundle-format=false`, which 3.1.4 marks deprecated ("this will be the only supported format in future versions"), so it is not used. For S2: Kyverno has to verify the bundle-referrer form.

### hauler on the connected side

```
hauler store add image 127.0.0.1:5000/ubi9/ubi-micro@$IDX --key $K/cosign.pub -s $W/store-a
  -> ERR signature verification failed ...: no matching signatures: ecdsa: Invalid IEEE_P1363 encoded bytes (x8) ... aborting   (exit 1)
hauler store add image 127.0.0.1:5000/ubi9/ubi-micro@$IDX --key $W/home/wrong.pub -s $W/store-wrongkey      -> exit 1
hauler store add image 127.0.0.1:5000/ubi9/ubi-micro@$IDX --platform linux/amd64 -s $W/store-plat1
  -> ERR platform linux/amd64 cannot be applied to digest-pinned image ...: the pinned digest is a multi-platform index, and storing one
     platform would leave that digest unpullable. Remove the platform ..., or pin the platform-specific child digest   (exit 1)
AMD64=sha256:6e5529ed4ca394a3cfbed2ea2cff0615b69b401a4e5d66d71364ec380634db10   # linux/amd64 child of $IDX
hauler store add image 127.0.0.1:5000/ubi9/ubi-micro@$AMD64 --platform linux/amd64 -s $W/store-plat2   -> exit 0, image only (no sigs, atts, sboms, referrers)
hauler store add image 127.0.0.1:5000/ubi9/ubi-micro@$AMD64 -s $W/store-plat4                          -> exit 0, image + atts, referrers, sboms, sigs (1 each)
hauler store add image registry.access.redhat.com/ubi9/ubi-micro:9.9 --platform linux/amd64 -s $W/store-tag
  -> keeps dev.hauler/image sha256:6e5529ed... (the linux/amd64 manifest digest) plus its referrers, sboms, atts, sigs
hauler store add image 127.0.0.1:5000/ubi9/ubi-micro@$IDX -s $W/store-a                                -> exit 0 (60 layers, 34 MB)
  store-a: our referrer present: dev.hauler/referrers/bcfad4ba...  subject=sha256:dbd325b9...;  index digest kept: sha256:dbd325b9...
hauler store add file manifest.json -s $W/store-a                  -> ✓ added hauler/manifest.json:latest
hauler store add file manifest.json.sigstore.json -s $W/store-a    -> ✓ added hauler/manifest.json.sigstore.json:latest
hauler store save -s $W/store-a -f haul.tar.zst                     -> haul.tar.zst, 30066666 bytes
```

Findings: **hauler's `--key` check cannot read cosign v3 bundle referrers**; it only tries the legacy `.sig` tag layers (here Red Hat's signatures, which fail against our key, so it aborts). The bundle build therefore runs `cosign verify --key` itself before `hauler store add image` (without `--key`), and the import runs `cosign verify` again after the copy. Without `--key`, hauler carries every referrer, including ours. **`--platform` with a digest pin is either refused (index digest) or drops the signatures (single-manifest digest)**, so the bundle adds images by digest without `--platform`.

### Site side, offline

The copy container shared only registry B's network namespace (`lo` only) and had only the public key mounted:

```
podman run --rm --name p47s1-copy --memory 1g --network container:p47s1-zot-b \
  -v $D/bin:/tools:ro -v $W/out:/haul:ro -v $W/keys/cosign.pub:/keys/cosign.pub:ro -v $W/c-work:/work -v <scratch>/s1-c-inner.sh:/inner.sh:ro \
  registry.access.redhat.com/ubi9/ubi-minimal@sha256:08d4c70f1baf6537a0728656cf7942d561e74a35916509d205b6519861266352 /bin/bash /inner.sh
inside:
  interfaces: lo
  curl -m 5 https://registry.access.redhat.com/v2/            -> curl: (6) Could not resolve host (exit 6)
  curl http://localhost:5000/v2/                              -> HTTP 200 (registry B)
  /tools/hauler store load -f /haul/haul.tar.zst -s /work/store-b              -> unarchiving completed successfully
  /tools/hauler store copy -s /work/store-b --plain-http registry://localhost:5000   -> copied artifacts to [localhost:5000]
  B catalog: {"repositories":["hauler/manifest.json","hauler/manifest.json.sigstore.json","ubi9/ubi-micro"]}
  HEAD /v2/ubi9/ubi-micro/manifests/$IDX   -> Docker-Content-Digest: sha256:dbd325b96bcd432dd42816d31412bdf1dc0fb973b79ed310344bc23c76c068db
  GET /v2/ubi9/ubi-micro/referrers/$IDX    -> f5e18400... (Red Hat's bundle) and bcfad4babe978b417494f853b5ad078fc09b34fc23e13e8018178447da842b33 (ours), both artifactType application/vnd.dev.sigstore.bundle.v0.3+json
  /tools/cosign verify --key /keys/cosign.pub --insecure-ignore-tlog --allow-http-registry localhost:5000/ubi9/ubi-micro@$IDX
     -> "The signatures were verified against the specified public key" (exit 0)
  /tools/hauler store extract -s /work/store-b -o /work/extracted hauler/manifest.json:latest   (and the .sigstore.json)
  sha256sum manifest.json -> a73a08b1782a3f0f9490a6d42860ab85b7710b28ceeebed4aa4d228cf895bf9d (same as before signing)
  /tools/cosign verify-blob --key /keys/cosign.pub --insecure-ignore-tlog --bundle manifest.json.sigstore.json manifest.json -> Verified OK (exit 0)
negative, same namespace:
  cosign verify --key wrong.pub --insecure-ignore-tlog --allow-http-registry localhost:5000/ubi9/ubi-micro@$IDX
     -> no matching attestations: ... accepted signatures do not match threshold, Found: 0, Expected 1 (exit 1)
```

Registry B was addressed as `localhost:5000` while the signature was made against `127.0.0.1:5000`: verification still passed, so the registry host in the signed claim does not bind the signature to one registry (it binds the digest). This matters because the site registry name differs from the build registry name.

### S1 results

| Question | Result |
|---|---|
| Digest preserved A to B | Yes. `sha256:dbd325b9...` in A and in B (and the same as upstream). Child manifests and referrers kept their digests too. |
| Index or manifest digest with `--platform linux/amd64` | With an index digest, hauler refuses. With a tag, hauler keeps the **linux/amd64 manifest digest** (`sha256:6e5529ed...`). Pinned form: the linux/amd64 manifest digest, added by digest without `--platform` (keeps its signatures). Task 2 uses this form. |
| Repository path mapping in B | Source host stripped, repository path kept: `registry.access.redhat.com/ubi9/ubi-micro` to `ubi9/ubi-micro`; files to `hauler/<name>`. 47-02's `sitePath` should implement exactly this. |
| Signature reached B (Pitfall 16) | Yes, as an OCI referrer (our bundle `bcfad4ba...`), plus the `.sig/.att/.sbom` tags that came with the image. |
| Decision | **Keep hauler 2.1.2.** oras is not needed. |

Teardown: `podman rm -f p47s1-zot-a p47s1-zot-b`; no `p47s1-` containers remain; the pulled Zot image was removed. The spike key pair (password-protected, spike only) stays in the git-ignored `compliance/out/tools/spike-s1/work/keys`.

## Spike S3

Keycloak database documentation (keycloak.org/server/db, read for 26.8.2): PostgreSQL tested version 18, supported "18.x, 17.x, 16.x, 15.x, 14.x". Chosen: PostgreSQL 18.

### Downloads (`D=compliance/out/tools/spike-s3`)

```
BASE=https://download.postgresql.org/pub/repos/yum/18/redhat/rhel-9-x86_64
curl ... $BASE/repodata/repomd.xml (+ .asc); primary = repodata/893734887e509d0d...-primary.xml.gz, its sha256 matched repomd.xml
curl ... https://download.postgresql.org/pub/repos/yum/keys/PGDG-RPM-GPG-KEY-RHEL
gpg --show-keys -> pub rsa3072 2023-12-19 [SC] D4BF 08AE 67A0 B4C7 A1DB CCD2 40BC A2B4 08B4 0D20, uid PostgreSQL RPM Repository <pgsql-pkg-yum@lists.postgresql.org>
```

| RPM | URL | SHA-256 (repo metadata = download) |
|---|---|---|
| postgresql18-server-18.7-1PGDG.rhel9.9.x86_64.rpm | `$BASE/postgresql18-server-18.7-1PGDG.rhel9.9.x86_64.rpm` | 67c997e865dee265d5194acafdd64db6a229cbb4bb56f5e6f0a67bc1572e0748 |
| postgresql18-18.7-1PGDG.rhel9.9.x86_64.rpm (client) | `$BASE/postgresql18-18.7-1PGDG.rhel9.9.x86_64.rpm` | 9b1efaf683626a0bdc3beeaed0d8a3e459151ec20b0918afa17c0cd80bbcc2c3 |
| postgresql18-libs-18.7-1PGDG.rhel9.9.x86_64.rpm | `$BASE/postgresql18-libs-18.7-1PGDG.rhel9.9.x86_64.rpm` | d7f708ca18365a2df3c8dc5fb4de146fe902893be78a26cf1ac7401d43557123 |
| PGDG-RPM-GPG-KEY-RHEL | `https://download.postgresql.org/pub/repos/yum/keys/PGDG-RPM-GPG-KEY-RHEL` | a70c9527426017d00fa4e6f9d2941d515357a27a7be82e155248ece53bbe5453 |

### Throwaway build (scratchpad, not shipped)

```
FROM registry.access.redhat.com/ubi9/ubi-minimal@sha256:08d4c70f1baf6537a0728656cf7942d561e74a35916509d205b6519861266352
COPY meta/PGDG-RPM-GPG-KEY-RHEL /tmp/pgdg/PGDG-RPM-GPG-KEY-RHEL
COPY rpms/ /tmp/pgdg/rpms/
RUN rpm --import /tmp/pgdg/PGDG-RPM-GPG-KEY-RHEL \
 && rpm -q gpg-pubkey --qf '%{NAME}-%{VERSION}-%{RELEASE}  %{SUMMARY}\n' \
 && rpm -K /tmp/pgdg/rpms/*.rpm \
 && microdnf install -y --nodocs --setopt=install_weak_deps=0 \
      glibc openssl-libs krb5-libs openldap libicu liburing lz4-libs libzstd libxml2 numactl-libs pam readline zlib \
      systemd-libs systemd util-linux shadow-utils alternatives \
 && rpm -ivh --define '_pkgverify_level all' /tmp/pgdg/rpms/*.rpm \
 && microdnf clean all && rm -rf /tmp/pgdg
USER postgres

podman build --memory 2g --network host -f <scratch>/s3/Containerfile -t localhost/p47s3-postgres:spike compliance/out/tools/spike-s3
  gpg-pubkey-08b40d20-6581afc1  PostgreSQL RPM Repository <pgsql-pkg-yum@lists.postgresql.org> public key
  /tmp/pgdg/rpms/postgresql18-18.7-1PGDG.rhel9.9.x86_64.rpm: digests signatures OK
  /tmp/pgdg/rpms/postgresql18-libs-18.7-1PGDG.rhel9.9.x86_64.rpm: digests signatures OK
  /tmp/pgdg/rpms/postgresql18-server-18.7-1PGDG.rhel9.9.x86_64.rpm: digests signatures OK
  microdnf: 25 packages from ubi-9-baseos-rpms and ubi-9-appstream-rpms; Complete.
  rpm -ivh: Verifying... postgresql18-libs, postgresql18, postgresql18-server installed; user postgres created (UID 26, GID 26)
  Successfully tagged localhost/p47s3-postgres:spike   (image 224 MB)

podman run --rm --name p47s3-pg --memory 1g --network none localhost/p47s3-postgres:spike bash -c '
  /usr/pgsql-18/bin/initdb -D /tmp/pgdata -A scram-sha-256 --pwfile=<(echo spike) -U postgres
  /usr/pgsql-18/bin/pg_ctl -D /tmp/pgdata -o "-k /tmp -c listen_addresses=" -l /tmp/pg.log -w start
  PGPASSWORD=spike /usr/pgsql-18/bin/psql -h /tmp -U postgres -Atc "select version()"
  PGPASSWORD=spike /usr/pgsql-18/bin/psql -h /tmp -U postgres -Atc "show ssl_library"
  /usr/pgsql-18/bin/pg_ctl -D /tmp/pgdata -w stop'
  -> server started
  -> PostgreSQL 18.7 on x86_64-pc-linux-gnu, compiled by gcc (GCC) 11.5.0 20240719 (Red Hat 11.5.0-17), 64-bit
  -> OpenSSL
  -> server stopped
```

Negative check, no key imported: `rpm -ivh --nodeps --justdb --define '_pkgverify_level all' postgresql18-libs-18.7-1PGDG.rhel9.9.x86_64.rpm` -> `package ... does not verify: Header V4 RSA/SHA256 Signature, key ID 08b40d20: NOKEY` (exit 1).

UBI packages the PGDG RPMs pulled in (all from the UBI 9 repositories, no Red Hat account): libfdisk, util-linux-core, systemd-rpm-macros, openssl, libutempter, libseccomp, libeconf, libdb, kmod-libs, gzip, cracklib, cracklib-dicts, pam, libpwquality, util-linux, expat, acl, dbus, systemd-pam, systemd, dbus-common, dbus-broker, liburing (ubi-9-appstream-rpms), numactl-libs, libicu. Installed versions of note: systemd-252-79.el9_9.1, liburing-2.12-1.el9, numactl-libs-2.0.19-3.el9, libicu-67.1-10.el9_6, openldap-2.6.13-1.el9, shadow-utils-4.9-17.el9, alternatives-1.24-2.el9, util-linux-2.37.4-28.el9_9.1.

Notes for 47-11:
- Add `tzdata`: initdb and the server warn `could not open directory "/usr/share/zoneinfo"` on ubi-minimal.
- `postgresql18-server` requires the `systemd` package (for its unit file); it comes from UBI and is not run.
- The PGDG directory holds only the newest 18.x build (only 18.7 is listed). When PGDG publishes 18.8 the pinned URLs may stop resolving, so the bundle build must keep the pinned RPMs it fetched (or a re-pin is needed).
- Decision: PGDG on UBI works, so the `rhel9/postgresql-NN` (registry.redhat.io) path is not needed and no Red Hat image is redistributed. Owner-confirm item 8 can close on the default.

Teardown: the throwaway image `localhost/p47s3-postgres:spike` was removed; no `p47s3-` containers remain.

## Files Created/Modified

- `compliance/ci/tool-pins.json`: seven new keys (`cosign`, `hauler`, `postgresql`, `helm`, `rke2`, `kms-pkcs11`, `softhsm2`); new archive kinds `binary` and `file`; new fields `assets`, and, where a later plan needs them, `fingerprint` (PGDG key asset), `binSha256` (kms-pkcs11 extracted binary, for OpenBao's `plugin` stanza) and `commit` (SoftHSM2 tag commit).
- `deploy/images/<name>/Containerfile` for the eight rebuilt images: comment plus digest-pinned `FROM` lines only.
- `deploy/images/README.md`: the build-definition contract.

## Decisions Made

See `key-decisions` above. The two that change other plans' wording:
1. **cosign signing flags.** 47-04's publish job and 47-06's bundle signing must use `--signing-config <empty signing config>`, not `--tlog-upload=false` (rejected by 3.1.4).
2. **hauler `--key` is not used.** cosign verifies before `hauler store add` and after the site copy.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `ARG OPENBAO_IMAGE` placed before the first FROM in openbao-softhsm**
- Found during: Task 2
- Issue: the plan says the ARG comes after the `softhsm-build` stage, but an ARG declared inside a stage cannot be used in a later `FROM`; only a global ARG (before the first FROM) can.
- Fix: the ARG is the first instruction; the comment says why. The file still contains `FROM ${OPENBAO_IMAGE}`.
- Files: deploy/images/openbao-softhsm/Containerfile. Commit: bc9042e6

**2. [Rule 3 - Blocking] Spike registry and signing adjustments**
- Found during: Task 1
- Issue: the planned sign command (`--tlog-upload=false`) fails on cosign 3.1.4; Zot rejected Docker media-type manifests; Zot listening on 127.0.0.1 broke port publishing.
- Fix: empty signing config; `http.compat: ["docker2s2"]`; listen on 0.0.0.0 inside the container. All recorded above as findings for later plans.
- Files: none in the repository (spike setup only).

**3. [Process] First S1 run used a podman store inside the spike folder**
- The first spike script exported `HOME` into the spike folder, which also moved podman's storage there, so two early containers lived in that store. They were removed with that store's `podman rm -f`, and its Zot image copy with `podman rmi`; later runs set `HOME` only for cosign and hauler. No effect on results.

Ordering note: the plan lists the PostgreSQL major as "16 or later"; the Keycloak 26.8 documentation lists 18 as tested, so 18 was used.

## Issues Encountered

None blocking. `podman system reset` on the stray spike store was refused by the permission classifier; targeted `podman rm -f` / `podman rmi` were used instead.

## Resource check

`systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 120 node scripts/resource-check.mjs` -> `Compliance fit check passed: 54 resources, each with a reviewed entry in compliance/resources.json.` (exit 0). The unextended checker does not read `deploy/images/` or the new tool-pins keys; their register entries land with 47-04.

## User Setup Required

None.

## Next Phase Readiness

- 47-02: implement `sitePath` as "strip the source host, keep the repository path"; site Zot needs `http.compat: ["docker2s2"]`.
- 47-03: pin third-party images by linux/amd64 manifest digest.
- 47-04: `install-tool.sh` needs kinds `binary` and `file`, `assets[]`, versions `x.y` and `x.y.z+build`, hosts `get.helm.sh` and `download.postgresql.org`; asset entries may carry an extra `checksumUrl` or `fingerprint` field; the publish job's cosign flags are the S1 ones.
- 47-06: verify with cosign before `hauler store add image` (no `--key`, no `--platform`), sign blobs with `sign-blob --bundle`, verify at import with `--insecure-ignore-tlog`.
- 47-11: PostgreSQL 18.7 recipe above, plus `tzdata`.
- S2 (Kyverno) must verify the cosign v3 bundle-referrer form; the legacy `.sig` tag is not written.

## Self-Check: PASSED

- FOUND: compliance/ci/tool-pins.json, deploy/images/README.md and the eight Containerfiles
- FOUND in history: 9a548bd9, bc9042e6, b7f094f9
- Task 1, 2 and 3 automated verify commands: exit 0
