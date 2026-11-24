---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 06
subsystem: deploy
status: complete
tags: [bundle, cosign, hauler, air-gap, signed-file, zot, harbor]
requires: [47-04]
provides:
  - "deploy/bundle/build.mjs (--out, --key, --staging-registry, --version, --ci-registry, --omit, --build-local, --images, --files, --public-key, --plain-http)"
  - "deploy/bundle/check.mjs (checkBundle) and deploy/bundle/import.mjs (importBundle, --registry-kind zot|harbor, --registry-auth, --registry-ca)"
  - "deploy/bundle/signed-file.mjs (signFile, verifySignedFile): the one check for every signed file (D-49)"
  - "deploy/bundle/lib/{manifest,cosign,hauler}.mjs; bundle format sterling-bundle/1"
  - "deploy/test/bundle-verify.test.mjs"
affects: [47-14, 47-16, 47-18]
tech-stack:
  added: []
  patterns:
    - "Check before copy: importBundle reaches its copy step only after checkBundle returns ok; the copy step is injectable so tests prove it never runs on a refusal"
    - "Our images are renamed to sterling/<name> in the staging registry with cosign copy; third-party images keep the hauler path mapping"
key-files:
  created:
    - deploy/bundle/build.mjs
    - deploy/bundle/check.mjs
    - deploy/bundle/import.mjs
    - deploy/bundle/signed-file.mjs
    - deploy/bundle/lib/manifest.mjs
    - deploy/bundle/lib/cosign.mjs
    - deploy/bundle/lib/hauler.mjs
    - deploy/test/bundle-verify.test.mjs
  modified: []
key-decisions:
  - "The store knows images and files only, so charts and tools travel as files under their own file names and are compared by name and content digest"
  - "Site tools are the raw pinned downloads (item digest = the pin's SHA-256), streamed and hash-checked by build.mjs itself, because install-tool.sh extracts archives and the nodes need the RKE2 tarball as published"
  - "Built and release images come from --ci-registry by recorded digest; a null digest is refused before anything is fetched unless --omit names it (recorded in omitted) or --build-local builds it"
  - "A signature file is <file>.sigstore.json beside the file; the public key always comes from the install media"
requirements-completed: [DEP-01, DEP-09]
duration: ~50min
completed: 2026-11-24
estimate:
  tokens: 75000
  tasks: 3
actuals:
  tokens: 12500
  tasks: 3
  commits: 3
plan_head_before: 4aa8f535
plan_head_after: f60cb5d4
---

# Phase 47 Plan 06: Signed offline bundle and the signed-file check Summary

**A bundle of the cert-manager controller and one file was built and signed on the connected side, verified offline, imported into a Zot with no network from a container that shared only that Zot's network namespace, and its signature verified there; eight refusal tests prove nothing is copied unless the manifest signature, the archive digest and every item digest verify.**

## Tasks

| Task | Result | Commit |
|---|---|---|
| 1. One image and one file end to end (tracer) | done; tracer gate re-ran the tracer end to end before expanding | `0332f313` |
| 2. Refusal invariants (TDD) | done, 8 tests | `6d8944de` |
| 3. The whole bundle, local builds, Harbor target | done | `f60cb5d4` |

## Tracer (Task 1)

Two Zot v2.1.23 containers: staging on `127.0.0.1:5200`, target with `--network none` (`podman inspect ... NetworkMode` -> `none`). A throwaway key
pair (cosign 3.1.4, `COSIGN_PASSWORD` from the environment).

```
node deploy/bundle/build.mjs --out bundle --key cosign.key --public-key cosign.pub --staging-registry 127.0.0.1:5200 --plain-http \
  --images quay.io/jetstack/cert-manager-controller --files small.txt --version 0.0.1-tracer
-> built: bundle with 2 items, archive sha256:699e6032...; manifest.json signed
   bundle/: manifest.json (742 B), manifest.json.sigstore.json, store.tar.zst (24.9 MB)
manifest.json:
  format sterling-bundle/1, version 0.0.1-tracer, archive store.tar.zst sha256:699e6032ae6e3b15e058e8438a59daeae01355b55cb8186a2b486531e101defa
  items: image jetstack/cert-manager-controller (ref quay.io/jetstack/cert-manager-controller:v1.21.3@sha256:9b262e94..., digest sha256:9b262e94...)
         file small.txt sha256:544adb8b...
node deploy/bundle/check.mjs --bundle bundle --public-key cosign.pub
-> verified: ... the manifest signature, the archive digest and 2 item digests (exit 0)
podman run --network container:t6-target ... node:24.22.2-trixie-slim
   fetch("https://quay.io/v2/") -> outbound: EAI_AGAIN
   node deploy/bundle/import.mjs --bundle /bundle --public-key cosign.pub --registry localhost:5000 --plain-http --out /work/out
-> imported: 2 items into localhost:5000 and /work/out; every image signature verified in the registry (exit 0); /work/out holds small.txt
   cosign verify --key cosign.pub --insecure-ignore-tlog --allow-http-registry localhost:5000/jetstack/cert-manager-controller@sha256:9b262e94...
-> The signatures were verified against the specified public key (exit 0)
```

## Verification

- `deploy/test/bundle-verify.test.mjs` with the pinned cosign, under the memory cap: 8 tests run, 8 pass (all 8 added by this plan). In every
  refusal case the copy spy ran 0 times; in the good case once.
- `node --check` on all seven scripts; `check.mjs --help` exits 0; `build.mjs --help` lists `--out`, `--key`, `--staging-registry`, `--version`,
  `--omit`, `--build-local`; `import.mjs --help` lists `--registry-kind`.
- Against the current lock, `build.mjs --out ... --key x.key --staging-registry 127.0.0.1:5200` exits 1 before fetching anything, naming the
  nine built images and `sterling/sterling-workbench` as having no published digest. With `--omit sterling/sterling-workbench --build-local` the
  plan is 38 third-party images, 9 to build, 14 charts and 8 tool downloads; an `--omit` typo is refused.
- `deploy-tree.tar` (same tar flags): 88 entries, none under `deploy/test/`, `deploy/lab/` or `deploy/charts/vendored/`.
- `grep COSIGN_PASSWORD deploy/bundle/lib/cosign.mjs`: named only in the comment; cosign reads it from the environment.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] A small `lib/hauler.mjs`**
- Found during: Task 1. build, check and import all run hauler with a private hauler folder and read the store listing, so the wrappers live
  in one module beside `lib/cosign.mjs` (not in the plan's file list).

**2. [Rule 1 - Bug] Relative `COSIGN` and `HAULER` paths**
- Found during: Task 2. The plan's command passes `COSIGN=compliance/out/tools/cosign`; a relative path broke once cosign ran in another
  working directory. Both are resolved from the working directory now. Commit `6d8944de`.

**3. Sequencing: the format and unpublished-digest refusals shipped in Task 1**
- `checkBundle` was written once with both refusals, so Task 2's tests passed on their first run (no separate RED for those two).

**4. Tracer harness: HOME**
- The first tracer run exported `HOME` into the scratch folder, which moved podman's storage there (47-01 hit the same); that store was removed
  and the run repeated with the real HOME. The results above are from the clean run.

## Notes for later plans

- 47-16: the node folder needs `pins.sha256` (from the `rke2` pin and assets, which this bundle carries as tool items) and the registry's own
  image as an OCI layout tar with the original manifest bytes named by tag and digest (spike S2, 47-05); install should write both from the
  bundle's items.
- The import host needs Node 22 or later from the site's OS repository; cosign and hauler come on the install media with the public key
  (research Decision 5) and are also in the bundle as tool items for the next update.

## Known Stubs

None.

## Self-Check: PASSED

- All 8 files exist; commits `0332f313`, `6d8944de`, `f60cb5d4` are ancestors of HEAD.
