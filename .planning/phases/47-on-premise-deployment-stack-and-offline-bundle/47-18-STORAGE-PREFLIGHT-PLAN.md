---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 18-storage-preflight
type: execute
wave: 10
depends_on: ["47-18-render-preview"]
autonomous: true
requirements: [DEP-12, DEP-01]
files_modified:
  - deploy/lab/render.mjs
  - deploy/lab/storage-plan.mjs
  - deploy/test/render-site.test.mjs
  - .planning/ROADMAP.md
  - .planning/phases/47-on-premise-deployment-stack-and-offline-bundle/47-18-PLAN.md
  - .planning/phases/47-on-premise-deployment-stack-and-offline-bundle/47-32-PLAN.md
  - .planning/phases/47-on-premise-deployment-stack-and-offline-bundle/47-33-PLAN.md
must_haves:
  truths:
    - "The optional offline storage check verifies that the chart requests agree with the operator's explicit lab storage budget."
    - "The report identifies every fixed binding and distinguishes a manually provisioned token claim and a retained workspace reservation."
    - "The report carries no live acceptance or install authority."
  artifacts:
    - path: deploy/lab/render.mjs
      provides: normal entry point for the offline lab budget check
  key_links:
    - from: deploy/lab/render.mjs
      to: deploy/bundle/lib/render.mjs
      via: the same pinned Helm render used by the lab preview
---

# Check the proposed lab disk budget

<objective>
Give the operator an offline decision before starting a VM or importing any image. Test the
exact intended requests against the encrypted backing budget they supply and report what
will need binding. This is a lab step within G423. The draft uses the locally verified preview
as its parent. Submit only after that preview lands and the changes are revalidated.
</objective>

<tasks>
<task type="auto" tdd="true">
  <name>Reject unbudgeted volumes and verify the requests from the real chart renders</name>
  <files>deploy/lab/render.mjs, deploy/lab/storage-plan.mjs, deploy/test/render-site.test.mjs</files>
  <read_first>Read 47-18 Task 1, the render-preview summary, the lab settings, the release renderer and namespace descriptors, the four fixed StatefulSets and example values, and the Theia operator workspace flags.</read_first>
  <action>
    Add optional `--storage-plan &lt;file.json&gt;` after the existing public key argument.
    The JSON has exact fields `usableMiB`, `reserveMiB` and `volumesMiB`. Values must be
    positive safe integers in MiB. The volume object has exactly `registry`, `secrets`,
    `secretSnapshots`, `secretTokens`, `identity`, `identityDumps`, `hub` and `workspace`.
    The usable amount is the capacity available to the lab's backing filesystem before creating
    those volumes. Reserve space for expected remaining system/runtime writes and restore staging.
    Bound each volume at the signed 64-bit Kubernetes binary quantity limit (in bytes).
    Check the aggregate without numeric overflow, reject incomplete and over-budget inputs before
    Helm, and accept equality with the reserve already covered. Use no default amounts.
    Apply those amounts only to the known lab release values using the renderer's extra
    string settings for Zot, OpenBao and PostgreSQL. Use the scratch site settings for the hub
    instance and requested workspace size. Keep registry port, retention, image authority and
    normal no-plan mode as they are.
    Confirm sizes, namespace, lab-static class, and replica-derived counts in the actual manifests.
    Reuse splitDocs and metadataName. Validate the known pinned chart structure and fail if any
    standalone PVC or StatefulSet claim template is extra, missing, ambiguous, unexpected or
    mismatched. Identify the claim names derived from the exact StatefulSet and template
    names and replica ordinal, requiring the pinned zero start ordinal, with the descriptor
    namespace as the default for namespaced resources that omit it. Resolve every rendered
    PodSpec PVC claimName in its namespace against the roster. OpenBao's token claim is
    referenced but must be provisioned separately. Confirm the reference and budget the exact
    fixed claim. For Theia, check the operator's PVC size and class and require that the
    rendered Theia landing-page ConfigMap disables ephemeral storage. Check the AppDefinition
    active-instance limit separately. Budget one retained workspace and report it
    as a reservation without a fabricated claim name. The operator must limit retained test
    workspaces during the run. maxInstances applies to active instances only.
    Print the ordered allocation roster, reservation, accounted total and unallocated margin
    in the existing preview JSON. Continue to report actual guest headroom, binding, signed
    artifacts and live install as unverified. Do not apply, generate provisioning manifests,
    check a live cluster, or persist state beyond the existing report. Make 47-18 depend on
    this check. Its later runner must reuse the same settings translation for the reviewed
    budget in live materialization, preflight and apply, and check that effective requests
    match the offline roster after substituting the actual signed lab images and before creating or
    binding volumes. Shift the planned live lab
    and following backup and release waves to preserve their existing order.
  </action>
  <verify>
    <automated>Extend the existing pinned-Helm CLI suite. Test a plan with distinct per-volume values and exact arithmetic, a fit at the boundary, refusal of invalid or over-budget input before Helm, and refusal on an unexpected rendered claim, reference or request. Preserve the existing no-plan selection test. Run the focused renderer under the shared lock and resource cap with the verified Helm 4.3.2 binary: `env HELM="$PWD/compliance/out/tools/linux-amd64/helm" node scripts/run-tests.mjs deploy/test/render-site.test.mjs`.</automated>
    <fails_when>The CLI can claim fit while a configured request is missing or different, a fixed claim is omitted, a replica or extra PVC is ignored, the workspace size is wrong, or the output implies live binding or approval.</fails_when>
  </verify>
  <done>An operator can verify the full proposed lab storage budget offline. Before live use the actual encrypted guest backing, exact signed bundle and bindings, lifecycle, and restore evidence still need verification under G423 and G424.</done>
</task>
</tasks>
