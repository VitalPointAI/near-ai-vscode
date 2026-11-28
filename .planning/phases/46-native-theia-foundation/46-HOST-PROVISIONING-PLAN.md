---
phase: 46-native-theia-foundation
plan: host-provisioning
type: execute
wave: 3
draft: true
depends_on: [46-local-launcher, 46-launcher-check]
files_modified:
  - docs-site/content/using/getting-started.md
autonomous: false
requirements: []
must_haves:
  truths:
    - "Ubuntu prerequisite assessment is read-only. Package application requires a separate verified manager contract and fresh-host approval."
    - "Mac support requires an operator-verified launch on physical hardware and authenticated evidence of the running profile and host-side forwarding."
  artifacts:
    - path: docs-site/content/using/getting-started.md
      provides: organization-managed prerequisite guidance and scope of verified host support
  key_links:
    - from: docs-site/content/using/getting-started.md
      to: scripts/launch-local-workbench.mjs
      via: existing read-only Linux launcher check as the workstation user
---

# Phase 46 Workbench host provisioning

<objective>
Tell the user whether the host can run the released Workbench. Record what must be verified before enabling package repair or claiming macOS support. Keep host package policy, native image availability, and model runtime requirements independent.

The owner deferred all macOS setup and development until Linux ARM64 works, including any Intel Mac trial. Apple silicon also requires a published, verified Linux ARM64 image.
</objective>

<context>
The existing launcher checks Linux x86-64 or ARM64, Node.js 26.13.1 or later in the Node.js 26 series, and a local Linux Docker Engine 28 or later that matches the host architecture. It can fetch an exact approved Workbench image. A signed published Linux ARM64 image remains a separate prerequisite for routine ARM64 setup. This draft permits review and planning only. Package application, device trials, and Mac support each require the applicable evidence below.
</context>

## Approved artifacts at setup and update

Every workstation install or update must verify the exact SHA-256 digests your organization approved. This applies to a standalone Workbench, an administrator adding a workstation through a hub, and same-machine setup when it installs software. It covers container images, installers, prerequisite packages and the complete set of dependencies the operation will install or update.

Before changing the workstation, verify that each artifact is approved for that operation and that the bytes to be applied match the approved digest. A tag or version can help locate the artifact. The verification and apply steps must use the same immutable artifact. If approval is missing, the architecture differs, or the bytes do not match, stop and tell the user which artifact needs attention. Show the current approved version and keep the existing workspace and working installation available when preparing an update. Complete readiness checks on the replacement before making it the active version.

The local launcher already accepts an operator-supplied exact image digest and verifies the image and platform. Organization-managed approval lookup, Add Workstation, managed package installation and update activation each need their own execution plan and verification. The existing same-machine guide expects an administrator-prepared, approved local hub image for development. An installer that acquires or updates the hub image must verify its approved digest at apply time.

<tasks>

<task type="checkpoint:human-verify">
  <name>Assess missing prerequisites on an approved fresh Ubuntu workstation</name>
  <files>docs-site/content/using/getting-started.md</files>
  <read_first>Read the local launcher and its check summary. Compare Docker's Ubuntu install instructions with Ubuntu's APT sources, authentication, and transaction documentation linked below.</read_first>
  <what-built>The Linux launcher already has a read-only check. This task records the assessment and the acceptance conditions for any later package remedy.</what-built>
  <action>
    Start with Ubuntu 24.04 LTS x86-64 and a fresh, administrator-approved target. In assessment use read-only OS, architecture and installed-software observations. Guide the operator to assess Node with the shell even when the launcher cannot run. When a supported Node is present, use the existing launcher check as the workstation user. Explain mismatched hardware, an absent runtime, and denied engine access separately. Report concrete capacity signals from checked sources. Numerical CPU, RAM and disk minima require measured acceptance.

    Keep package apply unimplemented. For a later plan, the administrator provides the root-managed APT snapshot, source-specific keyring and fingerprint, exact approved names, versions and artifact digests, and a review of the full dependency closure, maintainer scripts and services. Docker's recipe identifies docker-ce, docker-ce-cli and containerd.io. Include optional plugins only if required by the reviewed closure. Supply Node from a reviewed organization bundle or exact reviewed Node 26 package. A real package manager contract must enforce the complete approved closure before the first package mutation, including refusals for removals, upgrades or downgrades of installed packages and any unapproved addition. Require verified inputs and protection against concurrent change across validation and application. APT simulation alone is insufficient. Require independent review of this contract and a separate approval for a fresh test host before any package apply test. Retain host sources, socket permissions, existing services and container state.
  </action>
  <how-to-verify>Review the assessment against missing Node, unsupported architecture, absent Docker software and denied daemon access. The later fresh-host gate records the approved closure alongside the actual package delta, new service state and unprivileged launcher preflight. Verify that no pre-existing package or service changed. Preserve image verification as the separate launch step.</how-to-verify>
  <resume-signal>The operator records the prerequisite assessment. Keep package apply held for separate approval of the manager contract and fresh-host acceptance.</resume-signal>
</task>

<task type="checkpoint:human-verify">
  <name>Run an operator-verified trial on a preprovisioned macOS Colima profile</name>
  <files>docs-site/content/using/getting-started.md</files>
  <read_first>Read the launcher endpoint and publication checks, and Colima's profile, socket and forwarding sources linked below.</read_first>
  <what-built>The Linux release provides a checked local launch contract that the Mac trial must preserve. This task calls for an operator trial on a separately managed device.</what-built>
  <action>
    Use one already administrator-provisioned Colima Docker profile named `sterling` with an approved Colima, Lima, Docker CLI and guest image combination. The approved profile uses the host's native architecture, no mounted host directories or forwarded agent, no routable guest address, and no global Docker context or SSH configuration changes. Colima supports this configuration, including `--mount=none` from v0.10.0. Keep profile provisioning, daemon upgrades and any software acceptance outside the launcher. Docker Desktop is an alternative for an organization that manages its own installation and applicable license.

    On a dedicated physical device, the operator verifies the identity and effective settings of the live VM and approved profile for each start. Require an authenticated source of actual running profile and forwarding observations, bound to the same session and engine as the trial. The expected `~/.colima/sterling/docker.sock` under the workstation account's trusted home is only an endpoint. Bind commands to that literal user-owned Unix socket and refuse redirection or conflicting selectors. A socket or saved profile name cannot authenticate the running VM or its forwarding. Check effective forwarding before starting the Workbench on that profile. A missing or unverified prerequisite stops the trial with an explanation. Keep the Linux launcher contract unchanged.

    Use a published and verified native Linux ARM64 digest for Apple silicon. Use an accepted x86-64 release digest and physical Intel acceptance for any Intel support claim. The tested image and running engine architecture must match the device. Preserve the launcher image, ownership, workspace and publication invariants in trial checks. The trial is operator-verified. Automatic production support requires a separate checked design for per-start evidence and enforcement; leave Mac launcher code and production allowance outside this draft.
  </action>
  <how-to-verify>Require the approved profile, evidence contract, native release, and physical target before running the trial. Record authenticated per-start profile settings, the macOS host listener and local health, a negative reachability check against the Mac's LAN addresses from a separate device, and persistence after ordinary restart. Guest inspection and hosted macOS ARM runners cannot establish those host observations.</how-to-verify>
  <resume-signal>The operator records the result for the approved physical device, running profile and native image. Use it as evidence in a later production decision.</resume-signal>
</task>

</tasks>

<verification>
Independent plan check precedes any execution. Follow the shared heavy lock and resource cap in the handover, with one heavy job at a time. Keep the owner's services outside both acceptance targets. Record package and profile inputs and actual observations in the eventual summary.
</verification>

[Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/) · [Docker access on Linux](https://docs.docker.com/engine/install/linux-postinstall/) · [Ubuntu APT source keys](https://manpages.ubuntu.com/manpages/noble/man5/sources.list.5.html) · [APT archive authentication](https://manpages.ubuntu.com/manpages/noble/man8/apt-secure.8.html) · [APT transaction options](https://manpages.ubuntu.com/manpages/noble/man8/apt-get.8.html)

[Colima release and mount controls](https://github.com/abiosoft/colima/releases/tag/v0.10.0) · [Colima profile](https://github.com/abiosoft/colima/blob/main/config/profile.go) · [Colima socket](https://github.com/abiosoft/colima/blob/main/environment/container/docker/context.go) · [Lima port forwarding](https://lima-vm.io/docs/config/port/) · [Docker Desktop licensing](https://docs.docker.com/subscription-billing/desktop-license/) · [macOS runner limits](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#limitations-for-arm64-macos-runners)
