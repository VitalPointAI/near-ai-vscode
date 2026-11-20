---
phase: 30-replication-contract-and-co-editing-core
plan: 01
subsystem: build-and-supply-chain
tags: [yjs, lib0, esbuild, vendoring, sbom, signed-payload, supply-chain]
status: complete

requires:
  - phase: 29
    provides: signedPayload signer and the closed PAYLOAD_PURPOSES list
provides:
  - yjs 13.6.33 and lib0 0.2.119 as exact devDependencies, bundled to vendor/yjs/yjs.cjs with LICENSES.txt
  - scripts/crdt-vendor.json hash manifest, checked at compile, in a test and on the packaged VSIX
  - the staff-replica signing purpose (tenth payload purpose)
  - SECURITY.md section on the vendored Yjs and the replica core
affects: [30-02 tracer, 30-03 spike, replica core doc.ts, every replica header signature]

actuals:
  tokens: 6936
  tasks: 3
  commits: 3
plan_head_before: 3c11c8271ca5ff86de91d6bcd5a9fa12c282d235
plan_head_after: 277073a1a6fdb7b99c5a6ff354ef9b719583aee1

tech-stack:
  added: [yjs 13.6.33 (dev, bundled), lib0 0.2.119 (dev, bundled), isomorphic.js 0.2.5 (dev, not bundled)]
  patterns: [hash manifest checked at three points (compile, test, release), metafile-driven provenance check]

key-files:
  created:
    - scripts/entries/yjs.mjs
    - scripts/crdt-vendor.json
    - src/test/replicaVendor.test.ts
  modified:
    - package.json
    - package-lock.json
    - scripts/vendor-libs.mjs
    - scripts/verify-release-content.mjs
    - SECURITY.md
    - src/domain/team/signedPayload.ts
    - src/test/teamSignedPayload.test.ts

key-decisions:
  - "Pin gate ran automatically and passed before install (no human checkpoint, owner instruction)."
  - "lib0 is its own exact devDependency so yjs's ^0.2.99 range cannot drift to 0.2.120."
  - "Manifest input keys are normalised to the part from the last node_modules/ onward, so the hash is the same whether node_modules is a symlink or a real folder."

patterns-established:
  - "Vendored bundle provenance: scripts/crdt-vendor.json + checkCrdtManifest(metafile) in vendor-libs, replicated in a test helper and in verify-release-content."

requirements-completed: [MUS-02, MUS-01]

coverage:
  - id: D1
    description: "Yjs 13.6.33 and lib0 0.2.119 pinned exactly and bundled to vendor/yjs/yjs.cjs; bundled Yjs merges concurrent edits in both orders"
    requirement: MUS-02
    verification:
      - kind: unit
        ref: "src/test/replicaVendor.test.ts#the bundled Yjs merges two concurrent edits in both orders"
        status: pass
  - id: D2
    description: "Hash manifest checked at compile, in a test and on the VSIX bytes; changed or substituted file fails naming the file"
    requirement: MUS-02
    verification:
      - kind: unit
        ref: "src/test/replicaVendor.test.ts#a changed source file or built file is reported by name"
        status: pass
      - kind: integration
        ref: "npm run verify:release (Release content verified: 563 entries)"
        status: pass
  - id: D3
    description: "staff-replica is the tenth payload purpose, sample and exact list extended"
    requirement: MUS-01
    verification:
      - kind: unit
        ref: "src/test/teamSignedPayload.test.ts (29 tests)"
        status: pass
  - id: D4
    description: "SECURITY.md lists Yjs and lib0, the replica core, and the hash manifest check; no em-dash"
    requirement: MUS-02
    verification:
      - kind: other
        ref: "grep -c em-dash SECURITY.md is 0; lib0 count 3; replica core count 3"
        status: pass
---

# Phase 30 Plan 01: Vendored Yjs and the staff-replica purpose Summary

Yjs 13.6.33 and lib0 0.2.119 are now built from exact devDependency pins into `vendor/yjs/yjs.cjs`, hash-checked at compile, test and release time and listed in the SBOM, and `staff-replica` is the tenth signing purpose. Nothing in the extension calls either yet.

## What was done

1. **Task 1 (tracer), commit `3314f0cd`.** Ran the automatic pin gate (printed `crdt pin gate ok: lib0 0.2.119 is 52 days old`: yjs 13.6.33 asks for lib0 ^0.2.99, no preinstall/install/postinstall script on yjs, lib0 or isomorphic.js, npm integrity of yjs and lib0 equal to RESEARCH). Then installed the exact pins, added `scripts/entries/yjs.mjs`, made `bundle()` return its metafile, added the fourth bundle call, and wrote `replicaVendor.test.ts` with the two-document merge test and the manifest-row test. `vendor/manifest.json` has yjs 13.6.33 MIT and lib0 0.2.119 MIT (`bundledIn: yjs`); isomorphic.js is not bundled.
2. **Task 2, commit `96721bca`.** `scripts/crdt-vendor.json` records esbuild 0.28.2, the three packages with npm integrity, the sha256 of 29 bundled source files, two licence files and the built file. `checkCrdtManifest(metafile)` in `vendor-libs.mjs` refuses any mismatch naming each file and ends with the "reviewed change" sentence. `verify-release-content.mjs` requires `vendor/yjs/yjs.cjs` and `LICENSES.txt` and hashes `yjs.cjs` inside the VSIX. The test file grew to 7 tests (pins, lockfile integrity, all hashes, teeth, licence sections). The build is deterministic (three runs, same output hash 74fe708b...) and the bundle contains no absolute path. A manual tamper of one input hash made `node scripts/vendor-libs.mjs` fail naming `node_modules/lib0/array.js`; the manifest was restored.
3. **Task 3, commit `277073a1`.** `'staff-replica'` appended to `PAYLOAD_PURPOSES` (one changed line); `teamSignedPayload.test.ts` gained a `staff-replica` sample and the exact list now has ten entries (an extension of a closed list, nothing removed or loosened). SECURITY.md has the table row and the plain-words paragraph. `npm run verify:release` ran once and printed `Release content verified: 563 entries, 458 runtime JavaScript files, and 63 required release assets.`; `sbom.cdx.json` lists yjs 13.6.33 and lib0 0.2.119 (MIT) with no change to `scripts/extension-sbom.mjs`.

## Verification

- `replicaVendor.test.js` 7/7 pass, `teamSignedPayload.test.js` 29/29 pass, `staffCopSymbols.test.js` 4/4 pass (unchanged; `media/vendor/VENDORED.json` and `staffCopSymbols.test.ts` have no diff). All under the memory cap and the shared heavy lock.
- `npm ls yjs lib0 isomorphic.js`: 13.6.33, 0.2.119, 0.2.5. `package.json` has no `dependencies` key; the diff is two devDependency lines.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The worktree's `node_modules` symlink was replaced by a real folder**
- **Found during:** Task 1, Step 2
- **Issue:** The plan (and the orchestrator) expected `node_modules` in this worktree to be a symlink to the main checkout's, so the install would also land in the main checkout. `npm install` replaced the symlink with a real `node_modules` folder (about 289 MB) in the worktree, populated from the lockfile.
- **Effect:** The main checkout's `node_modules` was NOT touched (it has no `yjs` folder). This is safer than the plan expected. `node_modules/` is gitignored, so no commit is affected. Later plans in this worktree use the real folder; esbuild 0.28.2 and typescript work in it. The manifest hashes are independent of the symlink (keys normalised from the last `node_modules/`), so the main checkout produces the same output once Yjs is installed there.
- **Fix:** none needed; recorded here. I used `--ignore-scripts` on the real install so no other package's install script (esbuild, keytar, vsce-sign) re-ran; the three new packages have no install scripts.
- **Commit:** `3314f0cd`

**2. [Rule 1 - Hygiene] Dropped an unneeded eslint-disable comment** in `replicaVendor.test.ts` (the repo has no eslint config).

Otherwise the plan executed as written.

## Auth gates

None. The pin gate used the public npm registry read-only.

## Known Stubs

None.

## Threat Flags

None. The new surface (vendored Yjs in the shipped bundle, one new payload purpose) is the surface the plan's threat model covers (T-30-01 to T-30-05, T-30-SC).

## Notes for later plans

- The main checkout's `node_modules` does not have yjs, lib0 or isomorphic.js. Anyone building from the main checkout needs `npm ci` after this merges.
- The worktree's `near-ai-vscode-0.4.34.vsix` and `sbom.cdx.json` are gitignored build outputs from the one `verify:release` run.

## Self-Check: PASSED

Files found: scripts/entries/yjs.mjs, scripts/crdt-vendor.json, src/test/replicaVendor.test.ts. Commits 3314f0cd, 96721bca and 277073a1 are ancestors of HEAD.
