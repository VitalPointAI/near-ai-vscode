---
status: awaiting_human_verify
trigger: "Governance policy page shows 'Your rules cannot be read right now.' on v0.4.43"
created: 2026-11-28T11:52:50Z
updated: 2026-11-28T12:07:16Z
---

## Current Focus

bug_class: bohrbug
hypothesis: An unavailable SecretStorage fails the gate's trusted read, and the Policy Editor replaces the specific refusal message with a generic one.
test: Open the normal policy command with a fresh synthetic Workbench storage profile whose SecretStorage rejects every operation. Compare with an available test store and an invalid signed file.
expecting: The unavailable branch records the existing no-secret-storage reason, but its webview drops the cause and keeps rules and edits unavailable.
next_action: Commit the independently reviewed patch on its isolated branch. Confirm the Governance message in the deployed Workbench after release.

reasoning_checkpoint:
  hypothesis: The policy page displays the generic message because an unavailable durable store blocks both trust checks and the editor drops the gate's specific failure sentence.
  confirming_evidence:
    - The normal command in a fresh synthetic profile got a failed-closed host with NO_SECRET_STORAGE_TEXT and no effective layer.
    - The real panel posted the exact reported generic notice. Before that assertion the test found no sections, no edit or proposal actions, a refused reset and no policy bundle on disk.
  falsification_test: A no-store fresh profile with a valid effective layer or a baseline Governance state message already showing NO_SECRET_STORAGE_TEXT would disprove the mechanism.
  fix_rationale: Forward the verified host's safe sentence when there is no usable editor state and tell the person how to recover the missing dependency. Leave the trust and signing code alone.
  blind_spots: The user's running container and exact installed VSIX bytes are outside scope. The v0.4.43 tag matches the baseline for every policy path involved. A production proxy and store were not exercised.
  candidate_causes:
    - 'Environment: local published Workbench without an authenticated durable SecretStorage provider.'
    - 'Code: the page loses the policy failure reason when the trusted view is unavailable.'
    - 'Data: unreadable or invalid policy data could yield the same generic notice, but the synthetic profile contains no policy or enrolled files.'
  and_gate: Yes for the reported no-store scenario and generic message together. The configured store failure induces the specific gate refusal, and the editor mapping masks it.

## Symptoms

expected: Open Governance policy and see the saved rules or the first-time empty state.
actual: Governance policy displays "Your rules cannot be read right now."
errors: "Your rules cannot be read right now."
reproduction: Open the Governance policy page in published v0.4.43. The owner’s workspace data is unavailable for inspection.
started: Reported on v0.4.43, release source 49b305a5724a48818d66e005ff9943187ddc9816.

## Eliminated

- hypothesis: Startup races or a missing webview asset produce the reported string.
  evidence: Production command awaits host.state before opening the panel. The string is set by the extension-host controller only when its synchronous view of the verified layers is undefined.
  timestamp: 2026-11-28T12:00:00Z

## Evidence

- timestamp: 2026-11-28T11:52:50Z
  checked: Session history and baseline
  found: The dedicated branch is clean at 688b1abf6456d65db9637c03c67ecf90560b0901. The local tag points at the reported release source. MemPalace and the fallback knowledge base are unavailable.
  implication: Compare the published source and designated base directly, using synthetic data.

- timestamp: 2026-11-28T12:00:00Z
  checked: Release and base versions of the policy activation, wiring and rendering code
  found: The relevant source is identical. The documented local Workbench image selects an unavailable key store when the keyring module is absent. All operations reject. ensurePolicyBundle reads the protected last-valid marker before reading the file or creating a device key. OrganizationStore fails while reading its pin and classifies a fresh profile with NO_SECRET_STORAGE_TEXT. The Policy Editor drops the resulting gate sentence when no verified layers are available.
  implication: Configuration explains the trusted-policy failure. Display code explains the generic notice. User-facing repair can expose the existing safe failure and next step while preserving the gate. Spectrum localization is unnecessary for the already isolated branch and configured per-test coverage is absent.

- timestamp: 2026-11-28T12:01:44Z
  checked: Focused real-wiring regression on pre-fix product source
  found: Running the Governance test with Node's test isolation disabled (test file in its own process) returned exit 1 with the exact generic notice. Every trust and policy-file assertion preceding the display check passed. TypeScript compiled with no diagnostics.
  implication: The application loses the cause between the normal command and panel rendering, while the policy gate works as specified.

- timestamp: 2026-11-28T12:04:31Z
  checked: Focused reproduction, boundary cases and exact pre-fix behavior
  found: The normal Governance command shows the reason and next step for unavailable storage. The same fresh profile opens valid policy once a synthetic store works. A corrupted signed file yields the safe bad-signature notice and the bytes stay intact. Previously compiled production modules reproduce the exact generic notice. Restoring the patched modules passes again.
  implication: The failure message changes without widening trust or permitting changes without a working store.

- timestamp: 2026-11-28T12:04:31Z
  checked: Existing durable provider paths and standalone release contract
  found: Workbench Phase 46 D-36 intentionally ships no OS keyring in a container. The approved keyring applies only to non-container single-machine runs with a working OS credential service. The container's supported path uses hosted OpenBao with an authenticated proxy, matching session user, CA validation, and scoped per-person JWT role and KV v2 access. The VSIX policy uses that store via the existing SecretStorage bridge.
  implication: The current standalone image cannot enable signed personal rules on its own. Its durable-provider deployment is distinct from fixing the Governance explanation.

- timestamp: 2026-11-28T12:06:31Z
  checked: Independent source review and main update through PR 254
  found: The reviewer passed the three changed source and test files with 187 checks. PR 254 changed no reviewed files and kept `nearAi.policy.open` as the Governance command. The isolated branch fast-forwarded to 9525754fdb7c9f4daab9de56a31aec52f598eeca with the three reviewed file hashes unchanged.
  implication: The independent verification covers the reviewed patch on the refreshed base.

## Resolution

root_cause: Local Workbench rejects SecretStorage reads required to verify policy, and Policy Editor substitutes a generic message for the reason the gate provides.
fix: Forward the existing safe gate failure to the Policy Editor when it has no usable view. For the fresh unavailable-store state, add the next step to set up a secret store and reopen the Workbench.
standalone_dependency: A real standalone setup must provision a supported durable secret store before trusted rules can load or be signed. The owner separately started guided installer and recovery work. This patch changes the diagnostic only. The current standalone preview continues to allow only reading and planning without a store.
verification:
  target_test: { result: pass }
  mutation_check: { result: skipped, reason_if_skipped: Stryker is not configured in this repository }
  no_op_deletion: { result: pass, deletion_justified_by_rca: false }
  adjacent_tests: { result: pass, suites_run: [gateCommands, policyEditor, gateEnrolCommand, gateOrganizationStore, gateBundleStore, gateHostStart, gateHostClock, copyLint], tests_passed: 187 }
  revert_and_reconfirm: { result: pass, bug_returned_on_revert: true, fixed_on_reapply: true }
  guardrail_verdict: accepted
  environment: Isolated worktree, TypeScript strict compile, Node 24 and disposable profiles. User runtime and packaged browser were not exercised.
oracle_type: derived
files_changed:
  - src/services/policyEditor.ts
  - src/services/policyEditorWiring.ts
  - src/test/gateCommands.test.ts
