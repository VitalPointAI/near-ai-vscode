---
phase: 102-institutional-joint-staff-teams
plan: review
type: execute
wave: 9
depends_on: ["102-08"]
files_modified:
  - src/agent/gateAdapter.ts
  - src/agent/toolCatalog.ts
  - src/agent/staff/institutionalCommand.ts
  - src/domain/staff/institutionalBrief.ts
  - src/domain/staff/institutionalEvidence.ts
  - src/domain/staff/institutionalAccessibilityReview.ts
  - src/domain/staff/institutionalReconciliation.ts
  - src/domain/staff/institutionalServiceMonitoring.ts
  - src/services/staffSetupCommand.ts
  - src/services/staffSetup.ts
  - src/services/agentSession.ts
  - src/staff/institutionalDraftStore.ts
  - src/extension.ts
  - src/test/staffSetup.test.ts
  - src/test/institutionalBriefTracer.test.ts
  - src/test/gateCallArguments.test.ts
  - src/test/helpers/institutional
  - SECURITY.md
  - CHANGELOG.md
autonomous: true
requirements: []
user_setup: []
must_haves:
  truths:
    - The recorded bundle hash comes from the runtime used by the gate. A fixture pin cannot supply it.
    - Path and label checks preserve facts from the original tool input and the exact derived write target.
    - Ordinary Staff Setup exposes its existing production choices. Synthetic roles are reachable only from the isolated harness.
    - The affected trust boundary is documented and goes through the normal owner gate.
  artifacts:
    - path: src/agent/gateAdapter.ts
      provides: Audit provenance and caller and derived path checks
    - path: src/services/staffSetupCommand.ts
      provides: Production picker and explicitly scoped test setup route
    - path: SECURITY.md
      provides: Reviewable runtime and test trust boundaries
  key_links:
    - from: src/agent/gateAdapter.ts
      to: SECURITY.md
      via: Documented role and policy provenance and exact derived path enforcement
---

# 102 · First staff PR review corrections

<objective>
Correct the authorization and product exposure findings on PR #236 while retaining the existing, separately confined fixture acceptance.
</objective>

<execution_context>
@/home/aaron/aspire-home/.codex/gsd-core/workflows/execute-plan.md
</execution_context>

<context>
@SECURITY.md
@scripts/lib/workflow.mjs
@src/agent/gateAdapter.ts
@src/services/staffSetupCommand.ts
@src/services/agentSession.ts

The original staff head is `b268fa93c`. Its CI passed and the official reviewer refused it. Keep the verified institutional draft scenarios and the scoped About keyboard fix. The finished blueprint from #228 is already ancestry.
</context>

<tasks>

<task type="tracer" tdd="true">
  <name>Keep ordinary Staff Setup and runtime decisions scoped</name>
  <files>src/agent/gateAdapter.ts, src/agent/toolCatalog.ts, src/agent/staff/institutionalCommand.ts, src/domain/staff/institutionalBrief.ts, src/domain/staff/institutionalEvidence.ts, src/domain/staff/institutionalAccessibilityReview.ts, src/domain/staff/institutionalReconciliation.ts, src/domain/staff/institutionalServiceMonitoring.ts, src/services/staffSetupCommand.ts, src/services/staffSetup.ts, src/services/agentSession.ts, src/staff/institutionalDraftStore.ts, src/extension.ts, src/test/staffSetup.test.ts, src/test/institutionalBriefTracer.test.ts, src/test/gateCallArguments.test.ts, src/test/helpers/institutional, SECURITY.md, CHANGELOG.md</files>
  <read_first>Read the exact independent findings and existing compiled package rules, command registration, capability manifest and audit record builders.</read_first>
  <action>
    Capture a regression for ordinary registration with no fixture options and ensure even an unexpected fixture selection cannot write staging state. Use a named registration options object. Only the isolated harness injects the fixture routes. Remove production imports of inactive providers and move their executable fixture adapters under the already excluded test tree. Preserve ordinary setup and generic child behavior. Complete and verify package isolation before resubmitting. Reconcile 102-09, 102-10 and 102-11 with that boundary before their submissions. Record normal Workbench operation of the institutional roles as open under the existing authority and confinement conditions.

    Capture the hash of the actual runtime BundleState sample passed to the decision before any await, and use the same sample for the audit record at that stage. A fresh approval recheck uses its own captured state. A human decline without a recheck keeps the original question's provenance. An unavailable or invalid sample supplies no hash. Add a regression with a bundle change during an awaited decision or approval. Keep the original call arguments visible to the normal path and payload checks. Evaluate each tool's ordinary manifest transform once and retain facts from both input and projection. A host-derived draft destination is projected into the manifest and receives the same path and label checks. Test both directions independently with one allowed path and one refused path. Fixture pins remain additional restrictions. Establish recorded runtime provenance and exact one-file authority in the existing fixture regression and run the shared gate checks. Keep the existing architecture line limits.

    Document the decision record, raw input and derived target checks, shipped entry points and fictional harness limits in SECURITY.md and the phase evidence. The relevant protected path triggers the normal owner workflow. A future changelog entry may describe only a change actually visible to ordinary users. Summarize the existing About keyboard fix accurately. Make no owner or gate claim ahead of the actual workflow.
  </action>
  <verify>
    <automated>phase_tmp=$(mktemp -d) && flock -o /home/aaron/.cache/claude-code-tmp/heavy.lock systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 540 env PATH="/home/aaron/.nvm/versions/node/v24.22.3/bin:$PATH" NODE_OPTIONS=--max-old-space-size=1536 TMPDIR="$phase_tmp" bash -c 'npm run compile && node --test dist/test/staffSetup.test.js dist/test/institutionalBriefTracer.test.js dist/test/gateCallArguments.test.js dist/test/gateMarkReview3.test.js dist/test/copyLint.test.js dist/test/architecture.test.js'</automated>
    Under the same cap, run the repository's exact VSIX package and verification scripts on the candidate. List packaged fixture implementation paths and inspect production activation imports. The isolated tracer must still run through the fixtures in the test tree as a positive control. Verify that the package excludes their implementation bytes and production activation has no dependency on them.
    <fails_when>Fixture roles remain accessible on ordinary activation, a fixture pin becomes audit provenance, a path check is lost, or the existing scoped scenarios stop working.</fails_when>
  </verify>
  <done>Independent readback, complete relevant CI, official review and any actual waiting owner gate have their required evidence before merge.</done>
</task>

</tasks>
