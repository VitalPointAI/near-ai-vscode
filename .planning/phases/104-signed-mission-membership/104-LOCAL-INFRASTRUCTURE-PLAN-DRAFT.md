---
phase: 104-signed-mission-membership
plan: local-infrastructure
type: execute
wave: 1
depends_on: []
autonomous: false
draft: true
requirements: []
files_modified:
  - workbench/extension/src/common/sterling-resource-inventory.ts
  - workbench/extension/src/browser/sterling-resource-inventory-module.ts
  - workbench/test/sterling-resource-inventory.test.ts
  - workbench/test/e2e/resource-inventory.spec.ts
  - workbench/README.md
must_haves:
  truths:
    - An operator can compare reported capabilities and the age of a local infrastructure snapshot in Resource Inventory.
    - Missing capacity stays unknown. Reported capacity grants no permission, workload eligibility, or assurance that the resource is currently available.
    - The workspace trust and selected root govern every read. Infrastructure reports cannot be edited or linked into a work area through the inventory.
  artifacts:
    - path: workbench/extension/src/browser/sterling-resource-inventory-module.ts
      provides: Read-only infrastructure planning in the normal Resource Inventory view
  key_links:
    - from: workbench/extension/src/browser/sterling-resource-inventory-module.ts
      to: workbench/extension/src/common/sterling-resource-inventory.ts
      via: The existing guarded local snapshot reader and a distinct report format
---

# Browse a local infrastructure planning report

<objective>
An administrator can open Resource Inventory in a trusted workspace and compare infrastructure capabilities from a manually supplied planning report. This first useful slice supports planning with fictional, public or otherwise approved non-sensitive inventory metadata. It adds no data source, discovery, signed scope, hardware admission or job control.
</objective>

<context>
Base is main `688b1abf6456d65db9637c03c67ecf90560b0901`. The existing inventory opens through Resource Management or `sterling.resources.open`, uses one bounded workspace export, and already has selected-root and trust checks, filtering, refresh, and provenance. #251 guards edits against a stale catalogue. Reuse those mechanisms. Phase 104's MHUB-01 and MHUB-02 and G564 govern the later authorized resource view. This local display claims none of those requirements. Phase 104-01's test-only scope proof at `4076a8625` and 104-02's operational readiness draft at `7e083fba7` supply authority boundaries. They are absent on this base and are not code dependencies of the local report.

Reviewed research `bc9bcb3f9` extends the landed #227 training-target design with standalone workers, Kubernetes, existing AI/HPC schedulers, inference, storage and registries. The local comparison covers Kueue for Kubernetes admission and quota, Run:ai/KAI for existing GPU-oriented Kubernetes deployments and Slurm for installed HPC environments. Use the capability distinctions from the comparison without choosing or integrating a scheduler. Keep scheduler identifiers and job semantics outside this display. Confirm the research, Phase 104 refs and existing inventory contract before planning review. No new requirement or gap ID is assigned.
</context>

<execution_preflight>
Independent exact plan check precedes implementation. Use the existing isolated worktree, Node 26.13.1, matching preapproved Workbench and root lock dependencies, and an already usable offline browser and native Workbench harness. Keep runtime verification in a private loopback environment, with a new ordinary profile and fictional records and roots. Resolve these local tool inputs before claiming the browser path verified. The existing approval to start this feature covers this local planning slice. It grants no backend, production data or live scope.
</execution_preflight>

<tasks>
<task type="tracer" tdd="true">
  <name>Compare reported resources in the existing inventory</name>
  <files>workbench/extension/src/common/sterling-resource-inventory.ts, workbench/extension/src/browser/sterling-resource-inventory-module.ts, workbench/test/sterling-resource-inventory.test.ts, workbench/test/e2e/resource-inventory.spec.ts, workbench/README.md</files>
  <read_first>workbench/extension/src/common/sterling-resource-inventory.ts, workbench/extension/src/browser/sterling-resource-inventory-module.ts, workbench/extension/src/browser/sterling-resource-catalogue.ts, workbench/extension/src/browser/sterling-work-area-resource-links.ts, workbench/test/e2e/playwright.config.ts</read_first>
  <behavior>
  - A bounded hand-written report with two accelerator vendors and different resource kinds renders in the current inventory. Existing search and category facilities work. The view shows reported provider or owner alias, capability, optional reported capacity and report time. Show unknown for absent capacity and display zero as zero. A plainly visible heading or status describes a local planning report and says that availability and permissions have not been verified.
  - Switching roots, entering a work-area link request, withdrawing workspace trust, or reading invalid content clears the previous infrastructure result. The regular inventory and public catalogue keep their existing behavior. An already queued stock-link action refuses if its final fresh read finds an infrastructure report, even if source and record IDs match. A read queued under an old root, trust state or link context cannot restore prior details.
  </behavior>
  <action>
  Use a single discriminated `schemaVersion: 2, kind: "infrastructure"` format in the existing `.planning/.near-ai/resource-inventory.snapshot.json` path. Keep the existing version 1 parser contract and catalogue writer. Decode the infrastructure report separately in the existing common module and distinguish the two typed results in the view. Use the existing bounded local regular-file reader, parent and file metadata checks, visible refresh, and stale connection cancellation. Reuse the existing view, list and text-node rendering. Make this input a distinct typed read-only snapshot. Older Workbench builds refuse schema version 2 and cannot mistake the report for linkable stock. A workspace has one snapshot in this slice. Do not overwrite or generate existing files from the app.

  The closed JSON envelope has exactly six required keys, `schemaVersion`, `kind`, `sourceId`, `source`, `generatedAt`, and `resources`. Use the existing source ID, source label and UTC timestamp validators, 512 KiB file and parser limits, and at most 1,200 rows. Each row requires exactly `id`, `name`, and `category`, with allowed optional keys `owner`, `capability`, `capacity`, `capacityUnit`, and `asOf`. Reuse the existing ID, display-name and UTC timestamp validators. Literal categories are `standalone-compute`, `cluster-compute`, `inference`, `storage`, and `registry`. Owner and capability use the existing 120-character label rules. Capacity and capacityUnit must both be present or both be absent. Capacity is a nonnegative safe integer, including zero, and capacityUnit uses the existing 32-character label rules. Absent capacity stays unknown. The optional asOf is the reported observation time, separate from generatedAt and the local read time. Reject any additional keys, malformed rows and duplicate IDs. Store no structured endpoint, filesystem path, host identity, job details, policy grant or credential fields. Labels are local text claims and are never dereferenced. The README records a small fictional JSON example, the absence of automatic discovery or synchronization and the one-file-per-workspace limit.

  The selected root is a local display context. Trust is the existing Workbench file-access prerequisite and supplies no mission scope. Do not add a mission identifier, network route, signed policy lookup, capacity reservation, edit, copy-resource-reference or link action for these records. In the normal display hide Copy reference and the reference field, Edit entry, Add entry, Archive entry and Link resource for infrastructure data. When a link request becomes active, clear the view through the existing connection reset, suppress infrastructure rows and details, and show that these reports cannot be linked. At the initial link guard and again before the callback require a linkable legacy stock report. Drain any pending source.readTask, recheck the captured connection, request, trust and link action, then start an explicit final read with the unchanged-ETag optimization disabled. Ensure it starts after the pending read settles and is not coalesced with an older refresh or poll. Recheck the same currentness, format, source ID and selected record after that read and invoke the callback from the same synchronous turn. The pre-existing external replacement window after the last completed read remains. This plan does not require filesystem locking or change the work-area writer. Leave the existing catalogue edit guard intact. Do not introduce a second view, writer, schema framework, service or cache.
  </action>
  <verify>
  <automated>Run tests first in the existing inventory suite, including v1 compatibility, supported categories, unknown versus zero capacity, and refusal of partial capacity pairs, duplicate IDs, legacy state fields and unknown keys at both levels. Under the shared heavy lock and handover cap with pinned Node/dependencies, run from workbench `npm run lint`, `node scripts/build.mjs` and `node ../scripts/run-tests.mjs dist/test/sterling-resource-inventory.test.js dist/test/sterling-work-area-resource-links.test.js`. Run the canonical `npm run build` once on the exact modified Workbench for the browser. Add one case in the inventory-specific browser spec using the existing normal menu or palette entry and test/e2e/playwright.config.ts. From workbench select it with `./node_modules/.bin/playwright test -c test/e2e/playwright.config.ts resource-inventory.spec.ts -g 'Resource Inventory shows a local infrastructure report'` in the existing private loopback harness. Start the harness with a disposable Theia multi-root workspace listing two regular fictional file roots, one per report kind. Reuse the existing trust prompt and palette conventions and compare the selected roots through the inventory folder control. Check both kinds of record, local planning status, capacity handling, clearing on root change or invalid refresh, and absence of Copy reference and edit/link controls for infrastructure. Seed a valid fictional snapshot before the restricted launch and assert no infrastructure rows or details appear behind the trust guidance. Exercise opening the ordinary work-area link context after infrastructure is visible and assert the previous rows and controls are cleared. At the existing view/FileService seam deterministically defer a stock poll, start the link, replace stock with same-ID infrastructure, then release the poll with stale stock and require a distinct final read and zero callback calls. Also defer an infrastructure read, withdraw trust, then complete that read and assert it cannot restore any rows, details or actions. Prefer the existing trust and selection surfaces in the browser for ordinary presentation, and use controlled injected trust/file reads for the race rather than timing sleeps. Compare fixture files before and after. Record exact build and focused browser evidence.</automated>
  <fails_when>A report becomes linkable stock, grants an operational conclusion, exposes any previous root after a selection or trust change, alters the input files, or breaks existing inventory behavior.</fails_when>
  </verify>
  <done>Record exact test-first and focused verification evidence after independent review. A user can browse both kinds of snapshot in the normal inventory with current-workspace provenance and without an effect beyond reading.</done>
</task>
</tasks>

<verification>
Review the exact enrolment or scope boundary if work changes from reading a user-selected local file. Live mission inventory requires G564 and a verified owning hub, active member/device grant, signed resource visibility and operation authority, scoped status freshness, connector choice and normalized output from the assessed deployment. Model Factory placement remains separate under FAC-09. Data Map discovery, cross-domain sharing, hardware admission or training require their existing approvals. Keep this useful first slice if those conditions are still open.
</verification>

<output>
Write the corresponding summary after implementation and independent verification. End it with `## Open conditions` and cite G564 for live mission authority. Record any other applicable existing conditions without inventing an ID.
</output>
