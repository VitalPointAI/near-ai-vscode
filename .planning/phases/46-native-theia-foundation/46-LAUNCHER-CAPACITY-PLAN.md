---
phase: 46-native-theia-foundation
plan: launcher-capacity
type: execute
wave: 4
depends_on: [46-launcher-check, 46-launcher-arm64]
files_modified:
  - scripts/launch-local-workbench.mjs
  - workbench/test/local-workbench-launch.test.mjs
autonomous: true
requirements: []
must_haves:
  truths:
    - "The workstation check reports the CPU count and total memory Docker sees after its existing prerequisite checks pass."
    - "Unavailable observations preserve the prerequisite result and never expose Docker diagnostics."
  artifacts:
    - path: scripts/launch-local-workbench.mjs
      provides: read-only Docker capacity observations
  key_links:
    - from: workbench/test/local-workbench-launch.test.mjs
      to: scripts/launch-local-workbench.mjs
      via: recorded check-only Docker info query on the pinned local engine
---

# Report Docker capacity during Workbench setup

<objective>
Give the user diagnostic information before they need an image. This is an implementation slice of the owner's setup direction. The separate host provisioning draft governs workstation acceptance and measured minimums.
</objective>

<tasks>

<task type="tracer" tdd="true">
  <name>Report logical CPUs and total memory after the software check</name>
  <files>scripts/launch-local-workbench.mjs, workbench/test/local-workbench-launch.test.mjs</files>
  <read_first>Read the launcher prerequisite path, its recording fixture, and the host provisioning draft. Verify the CLI formatting contract and the fields in the Engine 28 API source.</read_first>
  <behavior>Preserve the current first line and exit status. Append the local Docker engine's logical CPU count and total RAM, formatted in GiB for readability. If the query fails or the response does not contain two positive safe integers, report that the capacity readings are unavailable.</behavior>
  <action>After prerequisites pass in check mode, use the pinned Docker wrapper once with info, a fixed format projecting NCPU and MemTotal, and a 3-second timeout. Bound the shape of the parsed response and print only fixed text and validated numbers. Use the existing fixture to exercise both architectures, a failed query, and missing or invalid values, and the existing command boundary. Launch and repair retain their current command path. Host provisioning, capacity qualification and physical acceptance remain separate.</action>
  <verify>Run the focused Node 26 fixture suite under the shared cap. Record the expected tests-first failure and the passing result. Check the full launcher suite and diff before review. Use recorded calls without invoking an engine.</verify>
  <done>The check gives a useful CPU and memory reading on a compatible engine and remains usable when the reading is unavailable.</done>
</task>

</tasks>

[Docker CLI info and formatting](https://docs.docker.com/reference/cli/docker/system/info/) · [Engine 28 system information fields](https://github.com/moby/moby/blob/v28.0.0/api/types/system/info.go)
