---
phase: 46-native-theia-foundation
plan: arm64-smoke
type: execute
wave: 1
depends_on: [46-01, 46-03, 46-06]
files_modified:
  - .github/workflows/ci.yml
  - scripts/test/workflow-files.test.mjs
autonomous: true
requirements: []
must_haves:
  truths:
    - "The optional native Linux ARM64 CI job builds the existing release target with the exact VSIX verified earlier in the same run."
    - "The candidate starts as UID 10001, serves loopback health, and exercises both native addons on ARM64."
    - "This CI work leaves the existing x86-64 checks and protected release publication in place."
  artifacts:
    - path: .github/workflows/ci.yml
      provides: read-only native ARM64 release-target smoke evidence
  key_links:
    - from: .github/workflows/ci.yml
      to: workbench/Dockerfile
      via: digest-pinned bases and the release target's checked VSIX
---

# Phase 46 native Linux ARM64 candidate

<objective>
Prove the existing Workbench release target can build and start on a native ARM64 Linux runner. Keep the candidate unpublished and leave ARM64 shipment, browser acceptance, and macOS setup to their follow-up work.
</objective>

<context>
`release-content` verifies and uploads the candidate VSIX on each CI run. The protected Release workflow already checks a VSIX hash before copying the VSIX and its checked Yjs vendor files into the build context. Reuse that chain. The Dockerfile compiles `drivelist` and `node-pty` on UBI against Node 26 headers and derives the addon path from `process.arch`. The npm lockfile already names ARM64 packages for esbuild, Parcel watcher and ripgrep. Phase 46 records the UBI pin as an image index and the test-only OpenBao index as containing ARM64. Resolve the exact Node and UBI ARM64 descriptors on the worker before treating them as verified. [CI](../../../.github/workflows/ci.yml) · [Release](../../../.github/workflows/release.yml) · [Dockerfile](../../../workbench/Dockerfile) · [Native smoke](../../../workbench/test/container/smoke.test.ts) · [Phase 46 research](46-RESEARCH.md)

GitHub documents `ubuntu-24.04-arm` as a native hosted runner. Use it directly to exercise C++ addon builds and runtime rather than adding emulation, a privileged setup step or a new action supplier. Use the existing pinned checkout, download and upload actions. A multi-platform publication would also need new evidence handling because the protected publisher carries one image archive, config ID and SBOM, and the current Syft, Grype and Cosign pins are Linux x86-64 binaries. [GitHub hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) · [Docker multi-platform builds](https://docs.docker.com/build/building/multi-platform/) · [Tool pins](../../../compliance/ci/tool-pins.json)

Automatic agent review requires a successful PR CI run, and the merge script refuses a failed extra check on the PR head. Run the candidate in an explicitly selected dispatch so ordinary PR and push runs do not depend on an experimental platform. Keep failures visible in the selected run. [Agent review](../../../.github/workflows/agent-review.yml) · [Merge script](../../../scripts/merge-pr.mjs) · [GitHub manual workflow runs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
</context>

<tasks>

<task type="tracer" tdd="true">
  <name>Build and smoke-test the verified candidate on a native Linux ARM64 worker</name>
  <files>.github/workflows/ci.yml, scripts/test/workflow-files.test.mjs</files>
  <read_first>Read the release-content and workbench jobs in ci.yml, the image and publish jobs in release.yml, workbench/Dockerfile and its dockerignore, workbench/test/container/smoke.test.ts, workbench/bin/healthcheck.mjs, .github/retry-registry-auth.sh, scripts/lib/workflow.mjs, and the relevant workflow tests.</read_first>
  <behavior>
    - Missing, ambiguous, or altered VSIX input fails before building. The ARM64 job consumes only the successful upstream packaging job's artifact in the same run and verifies its digest against the upstream job output.
    - A non-native worker, missing or ambiguous ARM64 base descriptor, wrong image architecture, failed native load or shell, or incorrect health response fails the ARM64 job. The existing workbench and compliance jobs keep their checks and evidence behavior.
    - Ordinary PR, push and unselected dispatch runs retain their current checks. Only an explicit ARM64 opt-in on a branch dispatch runs the candidate. A failed candidate fails that run without an error override.
    - Branch dispatches on main and release and hotfix refs do not run the candidate. The evaluation branch must contain the Workbench.
  </behavior>
  <action>
Write a focused failing workflow contract first in the existing test file. Pin the native label, dispatch guard, read-only same-run artifact and hash-check-before-build path, native and loopback smoke ordering, and preservation of existing branch protection and publish scope. Extend existing tests where they already cover a rule. Exercise checksum mismatch using an isolated synthetic fixture or an extracted Bash step in temporary scratch, without a daemon. Change only the CI dispatch input, packaging checksum output and ARM64 job, plus the focused test.

Add a typed boolean `workbench_arm64` input, default `false`, to the existing CI `workflow_dispatch`. Gate `workbench-arm64` at the job level on a branch dispatch with that input true and a branch under `chore/workbench-arm64-eval-`. Use no error override. In `release-content`, after `npm run verify:release`, identify the same one regular VSIX at the checkout root already uploaded by that job, fail if ambiguous, and emit its SHA-256 as a named job output only on that same opt-in. Keep the artifact name `vsix-${{ github.sha }}`, retention and consumers in place. In `workbench-arm64`, require `needs: release-content`, `runs-on: ubuntu-24.04-arm`, and a bounded job timeout. Check out with the existing pinned action and `persist-credentials: false`. Keep the job read-only, with no environment approval, write token, private registry login, signing, upload to a registry, or runtime secrets. Use the same commit as the packaging job. Pass GitHub expressions into shell steps through environment variables, quote expansions, validate hashes and IDs before use, and use fixed filenames or quoted file arguments rather than shell interpolation from branch names, artifacts, or registry output.

On the evaluation branch, fail if `workbench/package.json` is missing before any ARM download or build. Leave the existing x86-64 hotfix condition untouched. Use an evaluation commit with a different SHA and the exact same Git tree as the change being tested. Verify tree equality and ensure the evaluation SHA is absent from PR heads, main, and release candidates before dispatch. This keeps a failed evaluation off the commit inspected by the merge and release gates.

Download the pinned same-run VSIX artifact into a fresh runner directory, using the exact existing artifact name and no cross-run token or selectors. Require exactly one regular VSIX, validate the upstream output as a lowercase 64-character SHA-256, and compare it to a fresh hash before reading the archive. Copy the verified bytes to `release-input/sterling.vsix`. Extract only the release recipe's two fixed Yjs members into the existing vendor paths used by the Dockerfile. The engine build must still check those bytes against `scripts/crdt-vendor.json`. Use the existing Dockerfile, unchanged lockfiles and script-disabled install model.

On the trusted native runner, assert `uname -m` reports `aarch64` and the local Docker server identifies `linux/arm64` and reports a stable version of at least 28.0.0 before building. Read the literal pinned Node and UBI image references from the Dockerfile contract or check fixed expected references against it. Inspect their registry indices by the pinned index digest using `docker buildx imagetools inspect --raw`. Require one Linux ARM64 image manifest per pin, with v8 or no variant and a valid digest. Fail on a missing or ambiguous match. Record both exact index and child digests for the run. No unpinned image fallback. Build `--target release --platform linux/arm64 --provenance=false --sbom=false` from the same verified inputs using the existing Red Hat anonymous retry helper and a local-only candidate tag. Keep the existing supply-chain evidence obligations for later publication.

Inspect the built candidate for Linux ARM64, a valid inspected image ID and user `10001:0`. Start that image by ID on only `127.0.0.1::3000` with `STERLING_LISTEN_HOST=0.0.0.0` and `STERLING_PREVIEW_NO_SIGN_IN=accept`. Confirm that the returned container ID reports the expected image ID and one loopback publication. Poll `GET /healthz` through that literal loopback endpoint with no proxy or redirect, bounded overall and per-request time, and require 200 with body `ok` exactly. In that same running container confirm the bundled extension's package file. Run Node with `docker exec -w /app` to check `process.arch === 'arm64'`, Node 26, UID 10001, `drivelist.list` export, and `node-pty` executing an arithmetic shell command and exiting successfully after emitting the expected marker. Reuse the existing smoke test's native assertion pattern. Keep execution bounded, collect failures in the runner log and record successful image ID, platform, VSIX hash, and native/health outcomes in the job summary. The fresh runner provides isolation from the owner's containers.

The candidate check needs no Chromium download or extra browser packages. Existing x86-64 browser, egress, SBOM and release controls still run in their own jobs. ARM64 browser, egress, per-architecture SBOM/scan evidence, signed distribution and installer support need their own verified follow-up before release. Keep `CI_CHECKS`, existing names and `.github/workflows/release.yml` unchanged.
  </action>
  <verify>
    <automated>Observe RED and GREEN for `node --test scripts/test/workflow-files.test.mjs` using the shared cap and require the same opt-in for hashing and the ARM64 job, with no error override. Run `git diff --check BASE_SHA..CANDIDATE_SHA` with the exact refs after committing, and check the changed Bash bodies with `bash -n` after resolving or supplying fixture environment values. Use any existing authorized workflow syntax checker already available. Observe the job and its packaging prerequisite on an explicitly selected branch dispatch of the exact candidate when authorized. If a known infrastructure-only failure occurs after packaging passes, rerun the failed job rather than starting another complete workflow.</automated>
    <fails_when>The job requires publish credentials, accepts bytes that differ from the same-run verified VSIX, silently substitutes architecture or build input, reports success without the exact tested image and native and health proof, or changes the existing release evidence path.</fails_when>
  </verify>
  <acceptance_criteria>A read-only run on native ARM64 shows the verified VSIX SHA-256, two base child manifest digests, local image ID, loopback health and both successful native checks. Local static verification alone leaves the native result pending.</acceptance_criteria>
  <done>The CI run and all artifact and image identities are recorded in the summary, with any pending evidence explicitly marked.</done>
</task>

</tasks>

<verification>
Use the handover's shared heavy lock, systemd 6 GiB/zero swap cap and unique scratch directory for local checks. Keep host Docker unused. The CI and test files are protected gate paths. Collect exact evidence for SA-10 configuration and input identity, SA-11 developer testing and validation, and SI-07 integrity of the artifact used in the smoke. Evidence is scoped to this candidate. After independent plan and source review, apply the handover's combined gate order and existing owner approval. The PR records the checked state of the gate. The owner alone approves the gate.
</verification>

<output>
Record the reviewed source, capped results, exact ARM64 CI run link and image identity in `46-ARM64-SMOKE-SUMMARY.md` once executed, with an `## Open conditions` ending and applicable reserved gap IDs from the orchestrator. Any missing native evidence stays pending. No ARM64 availability or signed multi-platform release follows from a draft or a static workflow check.
</output>
