---
phase: 46-native-theia-foundation
plan: arm64-release-evidence
type: execute
wave: 1
depends_on: [46-ARM64-SMOKE]
files_modified:
  - .github/workflows/ci.yml
  - scripts/test/workflow-files.test.mjs
autonomous: true
requirements: []
must_haves:
  truths:
    - "The isolated evaluation proves backend egress on the same native Linux ARM64 image whose archive is hashed and scanned."
    - "The x86-64 scan uses the checked archive bytes without running the ARM64 image or selecting another image."
    - "The evidence records whether formal baked release facts were verified against the reviewed Phase 46-09 source."
  artifacts:
    - path: .github/workflows/ci.yml
      provides: read-only ARM64 archive, backend egress and CycloneDX scan evidence
  key_links:
    - from: .github/workflows/ci.yml
      to: workbench/test/container/egress.test.ts
      via: the exact archived image ID and the existing three backend cases
---

# Phase 46 Linux ARM64 release evidence

<objective>
Extend the isolated native build check to preserve and scan the exact candidate archive and test its backend egress. Collect evidence for a future ARM64 Workbench release. Keep the release workflow, published digests, and ARM64 browser downloads outside this plan.
</objective>

<context>
The native smoke evaluation passed with the same-run verified VSIX, the pinned Node and UBI ARM64 base descriptors, loopback health and both native addons. Continue from the reviewed ARM64 smoke source. Retain its default-off dispatch, dedicated evaluation branch and different evaluation commit with the exact source tree. Record and verify the commit, tree, dispatch ref and job identities. Keep the evaluation SHA away from PR heads and release refs. [Native ARM64 run](https://github.com/VitalPointAI/near-ai-vscode/actions/runs/45834553568/job/139960903748) · [Smoke plan](46-ARM64-SMOKE-PLAN.md)

Main `99373e04` lacks baked release facts. The exact local 46-09 candidate `1f5bc53d` records local verification for source `0825b219` and `48e52c94`. Its writer blob `8fe9cf7a59527aca1a7171548235a0b50a0dae1b` computes `sterling-release/1` from the root package version and compiled policy feature list. Its exact image recipe bakes `/opt/sterling/release.json` without a digest. Before qualifying release facts on ARM64, independently verify the exact 46-09 source adopted in the evaluation tree and prove the baked file as UID 10001. G555 and G556 retain their recorded scope and status. A smoke-only tree can still record archive, scan and backend evidence with release facts pending. [46-09 plan](46-09-PLAN.md) · [Existing release workflow](../../../.github/workflows/release.yml)

The repository pins Syft 1.57.2, Grype 0.122.1 and Cosign 3.1.4 as Linux x86-64 executables. Use the existing pinned Syft and Grype on x86-64, with a Docker archive as input. This avoids ARM64 scanner adoption, a registry pull and cross-architecture runtime emulation. Cosign stays in the later protected publishing work. [Tool pins](../../../compliance/ci/tool-pins.json) · [Syft Docker archive support](https://oss.anchore.com/docs/reference/syft/cli/)
</context>

<tasks>

<task type="tracer" tdd="true">
  <name>Bind native backend egress and the pinned x86-64 scan to one ARM64 archive</name>
  <files>.github/workflows/ci.yml, scripts/test/workflow-files.test.mjs</files>
  <read_first>Read the reviewed Workbench ARM64 smoke job, workbench/test/container/egress.test.ts, workbench/test/helpers/docker.ts, workbench/scripts/build.mjs, .github/workflows/release.yml, compliance/ci/install-tool.sh and tool-pins.json. Read the exact 46-09 source and summary from its branch before planning the optional facts evidence.</read_first>
  <behavior>
    - Local workflow tests fail before implementation when the scanner can make a scan without prior native evidence or selecting bytes other than the exact archive from the same evaluation run.
    - Native control, planted-call detection and internal-network start, page, restart and loopback-only results all pass for the recorded image. Failure or omission of a selected case fails the evaluation. Browser egress and browser UI are recorded as pending.
    - The x86-64 scan rejects missing or mismatched archives before decompression or Syft. The CycloneDX, scanner outcome and data source refer to the evaluated ARM64 image, and a failed database or scan never appears as a clean result.
  </behavior>
  <action>
Add one focused contract to the existing workflow tests first. Check that both native job and scanner run only through the reviewed evaluation guard, the scanner depends on native success, the archive is hash-checked before scan, and no job can publish or sign. Run exact-shell fixtures for changed input and scanner operational failure. Preserve the existing x86-64 CI, required checks, release notes and protected publication path.

Extend the existing job after the native smoke. Pass the inspected immutable image ID to `docker save` and `WORKBENCH_TEST_IMAGE`. Save a single image as `sterling-arm64-image.tar.gz`, with pipe failures fatal. Record the compressed archive SHA-256, inspected image ID, verified VSIX hash and architecture. Verify the image ID has not changed. Use the existing Node 26.13.1 setup pin, `npm ci --ignore-scripts` in the Workbench, its existing tests-only build, and the already staged Yjs files. Run `dist/test/container/egress.test.js` through `scripts/run-tests.mjs` with `--test-concurrency=1` and name pattern `^(control:|a planted outbound call at start |on a network with no route out )`. Use the existing evidence reporter and require one passing record for each of the three exact selected leaf names. Leave the browser case out of this evaluation. Accept only the exact image selected by ID and check that the release-target extension is bundled. Upload the checked archive and native report with the existing pin only after these checks pass. No registry credentials, external product data or browser download.

If the exact candidate contains verified 46-09 source, extract `/opt/sterling/release.json` from the container based on the same inspected image ID and check it is readable by UID 10001. Run the reviewed writer against the same commit and compiled policy engine, then require byte equality with the baked file and record its hash. For a candidate tree without the verified 46-09 producer, record facts as pending without impersonating baked data. If a facts-ready candidate lacks the file, has a differing file or has a writer failure, fail the qualification. Do not publish this record as the release's signed asset.

Add a read-only, identically guarded x86-64 scan job using the existing runner and pinned checkout, download and upload actions. Require native job success and select only its archive in this workflow run. Validate the declared archive checksum format and exact input hash before decompressing to new runner scratch. Install the exact repository Syft and Grype pins with the existing verifier. Run Syft against `docker-archive:<checked tar>` and feed that CycloneDX SBOM to Grype with `--only-fixed --fail-on high`. Save the SBOM hash, scan JSON, Grype database version or update status, and exact archive hash in the report. A valid scan with a confirmed fixed-high threshold finding is report-only, consistent with the release policy. Require a valid report and confirm that it contains a threshold match before treating Grype status 2 as a finding. Missing or invalid evidence and tool or database errors fail the evaluation. Upload only the scoped read-only evidence and existing job summary. Use no Cosign, release environment, image push or mutation outside the evaluation run. [Grype result thresholds](https://oss.anchore.com/docs/guides/vulnerability/filter-results/)
  </action>
  <verify>
    <automated>Run the existing workflow tests with the mandated cap and record RED and GREEN. Validate the changed Bash bodies and exercise the bad archive path without Docker. After independent source review and authorization, use the reviewed dedicated dispatch with a different SHA whose Git tree equals the candidate. Record the evidence SHA, file hashes and native/scan links. Verify the exact three backend leaf tests passed and the ARM64 archive digest and image identity are identical through the native evidence and x86-64 scan.</automated>
    <fails_when>The check reports clean backend egress without the three selected cases, scans a different image, silently treats a scan failure as clean, or qualifies release facts without the checked producer and image artifact.</fails_when>
  </verify>
  <acceptance_criteria>The opt-in evaluation records one verified ARM archive, three backend egress results, a hash-bound CycloneDX and a truthful finding or failure result. It records baked facts checked or pending according to the evaluated tree.</acceptance_criteria>
  <done>The evidence remains read-only and exact to the reviewed candidate, with browser and release conditions explicitly open.</done>
</task>

</tasks>

<verification>
Use the handover's shared heavy lock, systemd 6 GiB/zero swap cap and a unique scratch folder for any local checks. Workflow changes are protected gate paths. Record exact SA-10 build identity, SA-11 developer testing, SI-07 integrity, and RA-05 scan evidence for the scoped evaluation. Do not run a release job to collect candidate evidence.
</verification>

<follow_up>
For browser egress and user-facing acceptance, use the existing Workbench Playwright suites against the same archived release target after approval of the exact ARM64 package source or organizational mirror. Playwright 1.65.0 names Chromium 158.0.8127.18 revision 1254, with Ubuntu 24.04 ARM64 `chrome-headless-shell-linux-arm64.zip` and `chrome-linux-arm64.zip`. Check the effective install or approved mirror inputs, including ffmpeg if needed, before acquisition. Keep this follow-up separate from the three backend tests. [Pinned browser versions](https://github.com/microsoft/playwright/blob/v1.65.0/packages/playwright-core/browsers.json) · [Pinned platform paths](https://github.com/microsoft/playwright/blob/v1.65.0/packages/playwright-core/src/server/registry/index.ts#L2391-L2479)

For protected publishing, recommend separate optional ARM64 image-reference and signed release-facts assets for Linux Workbench users. Reuse the strict `sterling-release/1` facts format for each image. The child manifest digest and its config establish the platform, and the compiled version and policy reads must match across both children. Retain the current canonical x86-64 `sterling-image.txt`, `sterling-release.json`, and Phase 47-32 exact signed digest lock contract. Both child digests require their own CycloneDX attestation and verification against the expected predicate. Protected publishing needs the approved 46-09 release contract, native archived-image browser and egress evidence, and an independent review of the exact registry and release workflow. Require checked artifact checksums before access to the registry, validate every remote digest and config against what was tested, distinguish true absence from authentication/transport failure, reuse only matching remote content on retry, and expose final release assets only after verification. No replacement of a published release or mismatching ref. A canonical signed OCI index remains a later design that must verify both descriptors and foreign-platform retrieval, and prove index/signature preservation through existing launcher and offline import. macOS is deferred. [Phase 47 site release plan](../47-on-premise-deployment-stack-and-offline-bundle/47-32-PLAN.md) · [OCI manifest semantics](https://github.com/opencontainers/distribution-spec/blob/main/spec.md#pushing-manifests)
</follow_up>

<output>
Write the summary after verification, recording local and native results separately. End with `## Open conditions` and cite the orchestrator's reserved IDs for remaining conditions. No new claim of ARM64 publishing, full egress or site compatibility follows from this candidate evidence.
</output>
