---
phase: 46-native-theia-foundation
plan: launcher-check
type: execute
wave: 2
depends_on: [46-local-launcher]
files_modified:
  - scripts/launch-local-workbench.mjs
  - workbench/test/local-workbench-launch.test.mjs
  - docs-site/content/using/getting-started.md
autonomous: true
requirements: []
must_haves:
  truths:
    - "A developer can check workstation and local Docker prerequisites without an image or a write to Docker."
    - "The same prerequisite checks protect normal launch and image repair."
  artifacts:
    - path: scripts/launch-local-workbench.mjs
      provides: read-only workstation prerequisite check
  key_links:
    - from: workbench/test/local-workbench-launch.test.mjs
      to: scripts/launch-local-workbench.mjs
      via: recorded client-only and local daemon probes
---

# Phase 46 launcher prerequisite check

<objective>
Give someone setting up the Workbench a command to check the current launcher's supported platform, Node runtime, local Docker CLI and engine before they acquire an image. The current release builds Linux x86-64. The repository's RKE2 appliance provisioning script and development SoftHSM package recipe do not provide a Workbench host-package installer.
</objective>

<tasks>

<task type="tracer" tdd="true">
  <name>Check workstation prerequisites without changing the local engine</name>
  <files>scripts/launch-local-workbench.mjs, workbench/test/local-workbench-launch.test.mjs, docs-site/content/using/getting-started.md</files>
  <read_first>Read the verified local launcher and its recording fixture, and the setup guide.</read_first>
  <behavior>
    - `--check` requires neither an image reference nor a registry connection. A healthy workstation checks the Docker CLI and then the fixed local server. It never inspects or modifies images, containers or volumes and never probes application health. `--check` and `--repair` or `--image` together fail before Docker is contacted.
    - Check host platform, Node version and refused remote selectors before spawning Docker. Observe the Docker client before checking the socket. Distinguish absent client, failed client, missing or unavailable socket, access denial, missing daemon, old engine and unsupported engine platform. Show success only once the server passes. Report the detected host OS/architecture and required platform for incompatible hosts.
  </behavior>
  <action>
Reuse one prerequisite path for normal launch and the check, retaining exact image-reference validation before Docker work for launch. Use the same fixed local socket and scrubbed environment for the client-only `docker --host unix:///var/run/docker.sock --version` invocation and the existing server version query. Do not show raw Docker errors or ambient environment. A missing socket with a present client can mean the engine is absent or stopped, so report both remedies. Document that `--check` does not require an image, Node itself must already be available, and managed host package repair and measured capacity requirements need separate evidence. Preserve immutable image repair, owned resources, loopback health and direct-execution guard behavior.
  </action>
  <verify>
    <automated>Extend the existing recording test with grouped prerequisite transitions and exact command allowlist. Reproduce failure before changes. Run the raw Node 26 test and its existing bundled-import smoke under the shared cap. Check help and invalid flag combinations without invoking Docker.</automated>
    <fails_when>Check mode pulls or starts anything, visits an alternate endpoint, declares success before checking the daemon or misidentifies an absent CLI.</fails_when>
  </verify>
  <acceptance_criteria>Users can tell whether the current workstation can run the launcher and what to fix before bringing an image. No host package installation or live Docker access is part of this development run.</acceptance_criteria>
</task>

</tasks>
