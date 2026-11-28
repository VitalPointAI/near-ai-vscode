---
phase: 46-native-theia-foundation
plan: launcher-secret-readiness
status: draft
type: execute
wave: 1
depends_on: []
autonomous: true
files_modified:
  - scripts/launch-local-workbench.mjs
  - workbench/test/local-workbench-launch.test.mjs
  - docs-site/content/using/getting-started.md
requirements: []
must_haves:
  truths:
    - "A successful standalone workstation check tells the operator that saved credentials are unavailable in the released standalone Workbench."
    - "An operator who needs saved credentials knows when to contact their administrator and whether this launcher can supply the missing store."
    - "Standalone features that do not require saved credentials can still launch, and image repair still requires the exact approved digest."
  artifacts:
    - path: scripts/launch-local-workbench.mjs
      provides: "Plain secret-storage status in the existing standalone prerequisite check"
    - path: workbench/test/local-workbench-launch.test.mjs
      provides: "Recording of the check and launch boundaries"
    - path: docs-site/content/using/getting-started.md
      provides: "Getting-started steps for local use and administrator handoff"
  key_links:
    - from: scripts/launch-local-workbench.mjs
      to: workbench/test/local-workbench-launch.test.mjs
      via: "Existing launchLocalWorkbench injected Docker and health recorder"
    - from: docs-site/content/using/getting-started.md
      to: scripts/launch-local-workbench.mjs
      via: "Existing --check command and steps based on the reported result"
---

# Check secret storage during standalone Workbench setup

This draft covers the first implementation slice of the owner's request for the installer to check and set up a missing secret-store prerequisite. The base is `9525754fdb7c9f4daab9de56a31aec52f598eeca`. The completed launcher prerequisite check and exact-image repair are available on that base. No provider or setup effect is available to this launcher. The next section defines the scope of a separate provider installation plan.

## Deployment modes and evidence

| Mode | Current evidence and setup capability |
| --- | --- |
| Released standalone Workbench on Linux x86-64 | The workstation launcher runs a fixed local preview with a loopback browser URL and its own workspace volume. The released image builds without a working keytar binding, and this launch path supplies no OpenBao configuration or hosted sign-in. The app runs with its secret store unavailable. The launcher code also accepts Linux ARM64. A signed ARM64 release image is still pending in the getting-started guide at the base. |
| Native backend with a working OS keyring | The Phase 46 backend has this conditional path when no OpenBao address is configured. It requires keytar to load and the running backend user and session to reach a working keyring. A workstation daemon on its own does not provide a keyring to the released container. The launcher cannot install or select a native backend. |
| Organization-hosted Workbench | The backend selects OpenBao only when `STERLING_OPENBAO_ADDR` is configured. It also needs trusted transport and a matching authenticated session. The backend's store status reports the chosen store kind. A choice of OpenBao is configuration evidence. Actual session authentication and the required scoped operation are separate evidence. The getting-started guide describes hosted Workbench as planned and unreleased as a supported setup. |

Source references are Phase 46 context D-04, D-18, D-19, D-22, D-25, D-36 and D-43, `workbench/Dockerfile`, `workbench/extension/src/node/{hosting-config,key-stores,keyring-key-store,key-store-backend-module}.ts`, and `workbench/extension/src/common/secret-store.ts`. The launcher accepts HTTP 200 with body `ok` at its own validated loopback `/healthz` as web startup evidence. That response supplies no evidence about secret storage, sign-in, permissions, durability or credential use.

## Tasks

<task type="tdd">
  <name>Report the standalone secret-storage limitation during the existing check</name>
  <files>scripts/launch-local-workbench.mjs, workbench/test/local-workbench-launch.test.mjs</files>
  <behavior>Extend the existing check-order test with the standalone secret-storage result for both supported launcher architectures. Keep the recorder checks for host observations, image and container changes, and readiness probes. The red run must fail because the secret-storage result is missing. Existing launch and image-repair tests keep covering the successful launch URL, the absent digest and a mismatched digest.</behavior>
  <action>Add one plain line to the successful `--check` output after host, capacity and storage. Identify the result as a limit of the released standalone Workbench. State that it cannot save credentials, features that do not require saved credentials remain usable, and an administrator can advise on access to organization-hosted Workbench when available. Base the line on the launcher mode, with no host keyring probe, provider probe, container inspection, environment expansion, credential read, setup side effect or synthetic “ready” status. Keep the existing health check, environment restrictions, launch URL and `--repair` behavior. Use the existing recorder and run tests without a Docker connection.</action>
  <verify>
    <automated>node --test workbench/test/local-workbench-launch.test.mjs</automated>
    <fails_when>The check omits or misstates the standalone capability, its recorder observes an unexpected operation, or any launch and exact-image repair assertion fails.</fails_when>
  </verify>
  <done>An operator can tell before downloading an image whether this setup can save credentials, and the launch and repair boundary remains covered.</done>
</task>

<task type="auto">
  <name>Put the operator's next step beside the setup command</name>
  <files>docs-site/content/using/getting-started.md</files>
  <action>Update the existing paragraph immediately before or after the `--check` example. Explain that the released standalone launcher can start Workbench for work without saved credentials, and its explicit image repair can fetch the approved Workbench digest only. State when to contact the organization administrator and link to the existing hosted Workbench architecture section using the existing local reference. Reuse the explanation in the same guide's existing local-preview section where possible. Leave administrative deployment procedures in the site runbook.</action>
  <verify>
    <automated>git diff --check</automated>
    <fails_when>The proposed launcher, test or guide changes contain a whitespace error.</fails_when>
    Review the changed guide and exact check output together. The heading should distinguish saved credentials from web startup and explain which action the local launcher supports. Verify that its hosted-document anchor uses the existing link target and presents hosting as planned.
  </verify>
  <done>The getting-started guide gives a step someone with the released workstation setup can follow and identifies what requires administrator help.</done>
</task>

## Provider installation and actual readiness

Use the matching operational references before planning an installation. Native keyring capability is defined in `keyring-key-store.ts`. The hosted reference is `deploy/runbooks/site-install.md`, the key ceremony it links, `deploy/bundle/install.mjs`, and the existing `deploy/openbao/{apply,enrol}.mjs` tools. Those tools configure or enrol for an organization site. They do not make the standalone launcher a hosted installer. A running site, a successful service probe, or a store choice alone does not confirm that a specific Workbench user can save and retrieve their credentials.

Before any automatic remedy, choose the actual deployment mode and target and review the exact source and artifact closure. For native setup, this includes a supported Workbench distribution, the architecture-specific binding and keyring service, any prerequisite packages, the backend process identity and its session access. For hosted setup, this includes an approved site bundle and images, persistent storage and backups, initialization and seal handling, TLS trust, the site identity provider, session user, scoped JWT roles and KV policy. Pin and verify every package, image and dependency against the approved hashes before application. Keep credential material in its established secure handoff. The plan must name effects such as installs, configuration writes, service starts, vault initialization or unseal, account enrolment and any test write or deletion, and require the corresponding authority. Specify safe retry, recovery and rollback with the existing workspace and stores protected.

Verify readiness as the actual runtime identity in the selected mode: native backend user and session against the actual keyring, or the intended authenticated hosted session against its authorized per-person location. Use a specifically authorized isolated disposable value to test write, read, persistence across backend restart, and cleanup, plus fixture or controlled evidence that the wrong scope is refused. Report a bounded state and reason without exposing tokens, entity IDs or values. If the required operation has not been measured, report its readiness as unverified. A separate reviewed plan is required to implement this evidence and the appropriate remedy. There is no change to provider installation or readiness in this draft.

## Open conditions

- The standalone release still has no durable store. Provider installation and runtime readiness require the deployment choice, implementation, approved artifacts, scoped authority and evidence described above. This draft allocates no gap ID.
- Existing G374 remains open for the signed installed-site release facts used by hosted sessions. That gap addresses hosted version evidence and is independent of this standalone check.
