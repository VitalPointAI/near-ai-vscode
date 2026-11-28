---
phase: 46-native-theia-foundation
plan: launcher-storage
type: execute
wave: 5
depends_on: [46-launcher-capacity]
files_modified:
  - scripts/launch-local-workbench.mjs
  - workbench/test/local-workbench-launch.test.mjs
autonomous: true
requirements: []
must_haves:
  truths:
    - "The workstation check measures available space at the local path reported as Docker's data root before any image acquisition."
    - "An unavailable observation leaves the prerequisite result and CPU and memory observations intact."
    - "Normal launch and explicit repair do not perform a storage observation."
  artifacts:
    - path: scripts/launch-local-workbench.mjs
      provides: read-only capacity observation for the filesystem visible at Docker's data root
  key_links:
    - from: workbench/test/local-workbench-launch.test.mjs
      to: scripts/launch-local-workbench.mjs
      via: recording fixture for the pinned Docker info query and host filesystem observation
---

# Report Docker data-root storage during Workbench setup

<objective>
Extend the existing Linux launcher check to give the operator a storage observation before
acquiring an approved Workbench image. This measures the filesystem visible in the launcher’s mount namespace
at the daemon’s configured data-root path. Separate containerd or workspace mounts can have
different capacity. Readiness continues to describe software prerequisites. Capacity
qualification and package installation retain their separate acceptance conditions.
</objective>

<tasks>

<task type="tracer" tdd="true">
  <name>Show available storage alongside the existing workstation check</name>
  <files>scripts/launch-local-workbench.mjs, workbench/test/local-workbench-launch.test.mjs</files>
  <read_first>Read the existing check-only Docker info query, its recording fixture, the launcher capacity summary and the host provisioning draft. Verify DockerRootDir and Node statfs fields in the versioned sources below.</read_first>
  <behavior>After the existing prerequisite checks pass, retain their wording and exit behavior and the current CPU and memory line. Append a line for the filesystem visible locally at Docker's data-root path, reporting available GiB and exact bytes. Zero bytes is a valid observation. A missing or invalid path, an absent or failed filesystem call, and unusable results yield the fixed line "Docker data-root filesystem space is unavailable." Other mounts can have different available space. Launch and repair retain their current data and control flow.</behavior>
  <action>Retain the three-second deadline on the single pinned Docker info call and extend its fixed projection for NCPU, MemTotal and JSON-encoded DockerRootDir. Use a line break between the existing numeric pair and the encoded path. Keep the two observations independent, so malformed storage information does not suppress CPU and memory and invalid CPU and memory values do not suppress a usable path. Accept only a nonempty, absolute Linux path in a single JSON string with no control characters. Pass only that configured path to an injected, read-only statfs call using { bigint: true }. Compute available bytes as BigInt bavail times positive BigInt frsize. Use positive BigInt bsize only if frsize is missing or zero. Treat other invalid statistics as unavailable. Keep exact byte formatting in BigInt and round the GiB for display. Never display the raw path or diagnostics. Perform no filesystem read beyond volume metadata and no check-time discovery of other paths.</action>
  <verify>Extend the existing fixture before implementation. Assert the exact pinned info command, the configured nondefault path and BigInt options, and valid measurements on both Linux architectures. Cover distinct frsize and bsize, distinct bavail and bfree, the bsize fallback, exact values larger than a safe integer, zero space, path omission or malformed input without a probe, a rejected probe with a fixed error line, and preservation of valid observations when the other reading is unavailable. Ensure normal launch and explicit repair never invoke statfs and still use the approved digest. Record the expected tests-first failure and run the full focused launcher test under Node 26 and the shared resource cap. Verify syntax and whitespace without invoking a live Docker engine.</verify>
  <done>The operator sees one accurately scoped filesystem capacity reading or a concise unavailable message. The diagnostic does not assert a storage minimum or installation readiness.</done>
</task>

</tasks>

[Docker CLI info and formatting](https://docs.docker.com/reference/cli/docker/system/info/) · [Engine 28 system information fields](https://github.com/moby/moby/blob/v28.0.0/api/types/system/info.go) · [Node 26 filesystem statistics](https://nodejs.org/download/release/v26.13.1/docs/api/fs.html#class-fsstatfs)
