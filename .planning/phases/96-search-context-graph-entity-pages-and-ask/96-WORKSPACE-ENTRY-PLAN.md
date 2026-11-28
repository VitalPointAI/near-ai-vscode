---
phase: 96-search-context-graph-entity-pages-and-ask
plan: workspace-entry
type: execute
wave: 1
depends_on: []
requirements: []
autonomous: true
files_modified:
  - workbench/extension/package.json
  - workbench/extension/src/browser/sterling-context-graph-module.ts
  - workbench/extension/src/browser/sterling-welcome-module.ts
  - workbench/extension/src/browser/sterling-locale.ts
  - workbench/test/e2e/get-started.spec.ts
must_haves:
  truths:
    - People open Context Graph from the right-side rail and get a real native landing page.
    - The landing describes current availability without revealing graph records or workspace contents.
    - The same route works in Canadian English and French and with keyboard navigation.
  artifacts:
    - path: workbench/extension/src/browser/sterling-context-graph-module.ts
      provides: Native Context Graph landing
  key_links:
    - from: workbench/extension/src/browser/sterling-welcome-module.ts
      to: workbench/extension/src/browser/sterling-context-graph-module.ts
      via: Registered native Workbench command
---

# Context Graph workspace

The owner wants a dedicated Context Graph landing from the right-side rail. People should be able to slice authorized evidence by area of interest, activity and responsibility, save their view, follow changes and restore the mission's shared context. Human and agent work in that workspace should start from the same versioned view definition and see the evidence each is permitted to use.

## Product contract

Use a **Strategic**, **Operational** or **Tactical** lens to set the level of detail for the same authorized graph. Cross-cutting filters narrow by area of interest, operation or activity, responsibility and time. Lenses are presets for the evidence shown. On the settled explorer, keep the approved motion, keyboard list, source inspector, reduced motion and motion pause from Phase 96-02. Distinguish events from user filter changes. Open citations at the exact authorized source version and span.

Phase 96 owns the rail, landing and live authorized exploration. Phase 97 already covers saved scopes and replay. Plan subscription and workspace publication as Phase 97 follow-ons. A saved view records a versioned query and permitted display preferences. Evaluate it again under current access when it opens. An authorized workspace owner can set a versioned shared default with a visible scope and history. Personal views stay personal until deliberately shared. Active work can pin a permitted version for reproducible outputs, with status when the workspace has changed. Failed revalidation clears unavailable evidence, including any pinned view.

Use a single governed host projection for the interactive browser, saved views, subscriptions and contextual input to human and agent workflows. Resolve owning hub, active workspace membership and recipient authority from trusted service state. Apply source ACL, clearance, label and mission scope independently, including for both endpoints of relationships and for source opening. Agent delegation narrows the work it may access. Scoped source citations, provenance, uncertainty, version and high-water label stay with derived context. Evidence is input to work, separate from instructions and authority to act.

Subscriptions are opt-in, in-app first, with pause and unsubscribe. Compute change only over a reader-relative projection, recheck authority at delivery and on reopening, and clear pending notices and stale content when access is lost or the workspace changes. A hidden change cannot create a badge, count, notification, timing signal or graph movement. A retry cannot deliver an update twice. Persist cursor state with its owner, workspace and view revision. Start real delivery only after current access, separate delegated use and revoke-while-queued are independently verified. Give people separate controls for changing the shared workspace default and subscribing to updates.

## Reuse and delivery order

- Exact base `6c09b6bdf` contains the native rail and Get Started browser suite. Use the current landed successor for delivery, and preserve the open Standing Orders patch when it lands. The approved Phase 96-01/02 fixture and motion spec at `9f021496f` are read-only reference material. This landing needs neither fixture as an execution dependency and claims no KB requirement completion. The phased product data path cannot use local task memory as its access decision.
- Cytoscape documents composing narrowing filters, OpenMetadata separates change collection from notification, and DataHub separates subscription authorization and asset visibility. Reuse the interaction and lifecycle patterns in the existing graph and update architecture. Keep renderer selection with the existing Phase 96 design. No new dependency or copied code in this slice.
- The real governed graph still requires Phase 93/G565, Phase 88 live ACL and revocation, and Phase 92 extraction. Mission contexts additionally depend on Phase 104/G564 claims and owning-hub evidence. The test-only prototypes do not satisfy these requirements.
- A follow-on generated-data trace may prove one saved view shared by a person and a delegated agent, the hidden-change comparison, reader-relative replay, workspace switch and revocation while an alert is queued. Review it as its own Phase 97 plan before execution. The production open, subscribe and workspace-default paths wait for their actual provider and permission evidence.

<tasks>
<task type="tdd">
  <name>Open the native Context Graph landing from the Workbench rail</name>
  <files>workbench/extension/package.json, workbench/extension/src/browser/sterling-context-graph-module.ts, workbench/extension/src/browser/sterling-welcome-module.ts, workbench/extension/src/browser/sterling-locale.ts, workbench/test/e2e/get-started.spec.ts</files>
  <action>Extend the existing Get Started and rail assertions first. Register one localized native Context Graph shortcut near Data Management, reusing the existing navigation and main-area widget pattern. Use a distinct existing graph-like Codicon. The landing explains what the view will contain and shows a truthful unavailable state while the governed provider is absent. Show no controls for unavailable actions and do not read project memory, raw sources, graph facts or mission labels. Follow the existing page theme and keyboard/focus conventions, and keep other rail controls and language behavior. No browser-side network route, sample packaging or backend activation.</action>
  <verify>From workbench run `node node_modules/typescript/bin/tsc --project tsconfig.json --noEmit` and `node node_modules/typescript/bin/tsc --project extension/tsconfig.json --noEmit`. Against a disposable isolated native Workbench built from exact source, use the existing pinned Chromium suite with `WORKBENCH_URL=LOCAL_URL npx --no-install playwright test -c test/e2e/playwright.config.ts get-started.spec.ts --grep 'Context Graph landing'`. The case fails if a keyboard press does not open or focus the landing, the view misstates availability, repeated open creates duplicate tabs, the English or French UI is wrong, or Get Started cannot be reopened. Check the exact source range.</verify>
  <done>The native entry lands on a real localized accessible page. The plan and handover still identify the production evidence needed for slicing, subscriptions and workspace context.</done>
</task>
</tasks>

[Cytoscape filter documentation](https://github.com/cytoscape/cytoscape-manual/blob/master/docs/Finding_and_Filtering_Nodes_and_Edges.md) · [OpenMetadata change events](https://github.com/open-metadata/OpenMetadata/blob/main/DEVELOPER.md) · [DataHub authorization policies](https://github.com/datahub-project/datahub/blob/master/docs/authorization/policies.md)
