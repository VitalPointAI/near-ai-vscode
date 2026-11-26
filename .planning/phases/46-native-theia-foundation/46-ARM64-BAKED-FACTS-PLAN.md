---
phase: 46-native-theia-foundation
plan: arm64-baked-facts
type: execute
wave: 1
depends_on: [46-ARM64-RELEASE-EVIDENCE]
files_modified:
  - workbench/Dockerfile
  - workbench/Dockerfile.dockerignore
  - workbench/tools/build-engine.mjs
  - workbench/tools/release-facts-entry.ts
  - workbench/tools/release-facts.mjs
  - .github/workflows/ci.yml
  - scripts/test/workflow-files.test.mjs
autonomous: true
requirements: []
must_haves:
  truths:
    - "Only the separate evaluation tree adopts the five verified Phase 46-09 build blobs for this proof."
    - "The native ARM64 smoke container reads its own baked release facts as UID 10001 and those bytes equal the production writer's output from the same checkout."
    - "One evidence record binds the checked facts to the image ID and exact archive already used by the existing checks."
  artifacts:
    - path: .github/workflows/ci.yml
      provides: read-only ARM64 baked release facts comparison in the isolated evaluation tree
  key_links:
    - from: workbench/Dockerfile
      to: workbench/tools/release-facts.mjs
      via: the same compiled gate constants and digestless writer bytes
---

# Phase 46 Linux ARM64 baked release facts

<objective>
Prove the exact Phase 46-09 writer's output is readable and baked into the same native ARM64 candidate that the existing smoke, backend and archive jobs check. Keep the five-file integration on a separate evaluation-only tree.
</objective>

<context>
The ARM64 archive job already records the immutable tested image ID, verified VSIX and gzip archive SHA-256, and the scan uses that archive. The browser evidence uses the archive after both of those jobs pass. Adopt the independently reviewed representation from `feat/codex-phase-46-09` at `1f5bc53d1` for this one evaluation. The five paths are byte-identical to their producer commit `0825b219013107fa4aafb143f1eb97f6039df6fe`. [46-09 plan](46-09-PLAN.md) · [ARM64 archive plan](46-ARM64-RELEASE-EVIDENCE-PLAN.md) · [ARM64 browser plan](46-ARM64-BROWSER-EVIDENCE-PLAN.md)

| Exact path | Git blob |
| --- | --- |
| `workbench/Dockerfile` | `a16995d9f659e548cdcec7d6f84667200188dcf4` |
| `workbench/Dockerfile.dockerignore` | `f1b7a915ab290fa482b43c1a83e41ee59e0aa465` |
| `workbench/tools/build-engine.mjs` | `b84f77edaf544bcf09a06941c4ad4e97e340ae63` |
| `workbench/tools/release-facts-entry.ts` | `24d5909dcd9b1e15401eb58940b7b2756dfe5315` |
| `workbench/tools/release-facts.mjs` | `8fe9cf7a59527aca1a7171548235a0b50a0dae1b` |

The branch base has the same root package version source, gate feature, policy and vocabulary sources, Workbench lock and vendored Yjs pin as the reviewed 46-09 producer. The Docker ignore rule admits `package.json`; the build copies it to `/repo/package.json`. The engine bundler compiles `release-facts.cjs` from real gate sources. The production writer reads the root version and writes the digestless `sterling-release/1` facts. The runtime stage installs those bytes as `/opt/sterling/release.json` owned by root with mode `0644`, beneath a traversable `/opt/sterling` directory. Run the writer in the checkout after the tests-only engine build. In the runtime container, read the baked bytes, since the writer there would resolve its root package path to `/package.json`.
</context>

<tasks>

<task type="tracer" tdd="true">
  <name>Compare the production writer to the file in the exact native ARM64 smoke container</name>
  <files>workbench/Dockerfile, workbench/Dockerfile.dockerignore, workbench/tools/build-engine.mjs, workbench/tools/release-facts-entry.ts, workbench/tools/release-facts.mjs, .github/workflows/ci.yml, scripts/test/workflow-files.test.mjs</files>
  <read_first>Read the exact producer commit and branch head, Workbench ARM64 smoke and archive job, the existing workflow test convention, the scoped 46-09 summary and the plan for Phase 47-32 site acceptance.</read_first>
  <behavior>
    - A different image, missing or nonregular file, wrong reader or file metadata, or differing bytes fails the facts evaluation before its archive artifact is uploaded.
    - The record identifies the exact production writer source, tested image ID, existing VSIX and archive checksums, and checked facts SHA-256. The remaining ARM64 tests keep their original scopes.
  </behavior>
  <action>
Start from the reviewed ARM64 source tree in a dedicated evidence-only worktree and branch beneath `chore/workbench-arm64-eval-`. Do not fold this proof into the publishable ARM source tree. Import exactly the five blobs above and verify each blob and the unchanged gate and package inputs by independent review. Keep the protected release workflow byte-identical to the ARM64 base. Leave 46-09's site watcher, sign-in changes, policies, gaps, and protected publisher commits outside this proof. Before any dispatch, verify this exact tree and that the distinct evaluation SHA is absent from PR heads, main and release refs. Retain the existing default-off guard and its dedicated ref scope. The separate facts tree has a required facts check on this guarded ARM64 job.

Add one focused conformance case in the existing workflow test file before adding the facts step. Pin the existing immutable smoke image identity, checked default runtime user, production writer byte comparison and evidence upload order. Exercise matched and changed bytes or metadata with an exact extracted shell fixture in scratch. Reuse the repository's standard capped runner for the existing workflow tests. Any fixture supplies synthetic data and has no dependency on a Docker daemon or the browser binary.

Use the existing native smoke container before it stops. After its inspected `.Image` has matched the immutable native candidate, use `docker exec` with the container's configured user and its Node binary. Require `process.getuid() === 10001`, an ordinary file by `lstatSync`, UID and GID `0`, and mode `0644` at `/opt/sterling/release.json`. Stream only the file bytes to runner scratch and retain the exact image ID already passed to the archive job. No test mount, override, loader fixture, new port or new container is needed. Reuse the existing same-run verified VSIX, Workbench script-disabled dependencies and the native tests-only engine build. Run `node tools/release-facts.mjs` from `workbench/` with no digest argument and compare its raw bytes to the captured file with `cmp`. Fail on any difference, missing output or command error.

Only after both the facts comparison and the existing three backend cases pass, add the compared facts file and its SHA-256 to the existing archive evidence and summary. Bind it to the native image ID, same-run VSIX hash and existing gzip archive SHA-256. Preserve the exact archive creation, scan input, and browser evidence behavior. The independently scoped browser job keeps its own opt-in and original two selected checks, and loads the same checked archive when selected. Preserve the ordinary x86-64 workflow and all publishing, signing and site behavior.
  </action>
  <verify>
    <automated>Under the shared cap, record RED and GREEN for the focused workflow conformance check and exercise synthetic equality and refusal. Run Bash syntax checks for the changed steps. Following independent exact-source review, collect native evaluation evidence from the guarded distinct SHA and verify the facts and archive hashes against the same native image ID. Record that evaluation separately from the protected release.</automated>
    <fails_when>A fixture can stand in for baked data, the wrong runtime user can pass, the source has any unreviewed blobs, a byte mismatch can reach artifact upload, or the evidence can alter protected publication or an ordinary PR's result.</fails_when>
  </verify>
  <acceptance_criteria>The runner records the readable baked bytes from the exact tested ARM64 image and their byte equality to the reviewed production writer. All existing selected tests and archive identity remain intact.</acceptance_criteria>
  <done>Record the exact tree, runtime user, file metadata and facts and archive identities in the evaluation summary.</done>
</task>

</tasks>

<verification>
Use the handover's shared heavy lock, systemd 6 GiB/zero swap cap and unique scratch directory for local checks. Capture SA-10 build identity, SA-11 validation and SI-07 integrity evidence. G555 remains open for authorized site sign-in move evidence. G556 remains open for protected publication, signed immutable identities and Phase 47-32's two-release live site import and idle transition. The isolated facts proof does not close either gap.
</verification>

<output>
Write the evaluation summary with `## Open conditions` and the existing applicable gap IDs. Keep the evidence tree distinct from any release or PR source.
</output>
