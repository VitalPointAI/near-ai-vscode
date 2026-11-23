---
phase: 33-live-multi-user-staff-projects
plan: 04
status: complete
subsystem: staff editor binding and replica text
tags: [staff-room, yjs, editor-binding, local-history, replication]
requires: [33-01]
provides: [BoundText, EditorBinding, roster-bound edit batching, product-scoped relative positions]
affects: [33-19, 33-10, 33-12]
tech-stack:
  added: []
  patterns: [version-checked rendering, expected edit queue, origin-scoped history]
key-files:
  created:
    - src/staff/replica/editorBinding.ts
    - src/test/helpers/fakeBoundDocument.ts
    - src/test/staffEditorBinding.test.ts
  modified:
    - src/domain/replica/doc.ts
    - src/staff/replica/productEditing.ts
    - src/staff/replica/productFeed.ts
    - src/test/helpers/liveWorld.ts
    - src/test/staffProductFeed.test.ts
    - src/test/staffLiveTracer.test.ts
requirements-completed: [MUS-09]
actuals:
  tokens: 21332
  tasks: 2
  commits: 10
completed: 2026-11-22
plan_head_before: 9adbcb29a694fea32ad036a5d600956546bdde98
plan_head_after: af2244d6f43c2fd11b24816b334d37d6978f22ec
---

# Phase 33 Plan 04 · Shared editor binding

Two replicas can edit the same product through the abstract editor binding. They converge without echoing rendered changes, preserve each author's undo history, and keep the generated header read-only. This completes the shared-text core portion of MUS-09.

## Contract as built

- `BoundDocument` supplies text, versions, change snapshots and a version-checked edit method. `EditorBinding` translates editor offsets, applies fold-accepted updates, and ignores notifications for its own programmatic edits. A generated header refresh replaces the header range. Rapid edits to the protected header are restored together and show one notice.
- Native undo and redo restore the editor from the result of the local-origin Yjs history. The first native history notification shows “Undo in a shared product removes only your own changes.” `BoundText` also exposes capture boundaries and plain-data change notifications for remote edits and history operations.
- The binding normalizes CRLF on opening and pasting. Its automatic batching collects fitting changes for 500 ms. An oversized transaction is encoded into ordered Yjs records of at most 200 KiB and remains one undo item. A refused record retains its place and bytes ahead of later edits.
- A dropped write at the same editor version gets one corrective write and one fixed log line. A sixth recovery within one minute stops the binding. A conflicting newer editor version is left intact, and captured edits can still flush.
- `relativeAt` and `indexOf` convert between document offsets and product-scoped Yjs positions. The opaque tokens combine a scope hash and canonical Yjs bytes and are capped at 47 decoded bytes. Receivers skip positions whose items have yet to arrive or whose editor offsets are stale.

## Verification

- `npm run compile`, the combined task test run, and `npm run lint` succeeded under the planned local systemd scope, memory and swap limits, shared lock and timeout. The test runner used Node 24.22.3. The isolated TLS loopback hub used Node 26.13.1.
- The combined run passed **125 tests with zero failures or skips** across `staffEditorBinding`, `staffProductFeed`, `replicaDoc`, `replicaAttribution`, `replicaBoundaries`, `staffLiveTracer`, `copyLint` and `architecture`. The binding file has **16 top-level tests**. Seeds **3304** and **43117** exercised 100 rounds each. Failures report the seed and round.
- The six tracer checks included a 300 KiB Unicode paste reaching a second device through two ordered records. The binding tests used two local stores, a fake editor and the verified replica feed. The tracer exercised the real transport and the store-first and offline behavior.
- The final acceptance cases reproduced a failed rapid-header restore and a missing capture-boundary API before their corrections in `af2244d6`. Earlier test-first failures included missing timer persistence, dropped writes stopping the binding, refusal of an oversized paste, and missing relative-position APIs.
- The required history and header checks passed. `doc.ts` is **618 lines**, below the 800-line cap. Yjs still loads only from `doc.ts`. The boundary, replica document, and attribution suites and both lint baselines are unchanged from the plan base.

## Plan notes and integration limits

- Task 1's historical preflight found the 397-line `doc.ts` and the planned editing and feed files on `9adbcb29`. Its literal `splitProductFile` export check pointed at `projection.ts`, where the helper was already imported from `src/domain/staff/products.ts`. The final implementation uses the established product header boundary.
- The segmented Yjs encoder and scoped position support took `doc.ts` beyond Task 1's approximate addition target while staying below the plan's hard cap. The native history path renders from canonical text through the same version-checked edit path. The fuzz reuses the existing seeded replica generator.
- [Plan 33-19](./33-19-PLAN.md) declares 33-04 as its sole prerequisite. Its first task can start with a test `BindingSource`. The exact prerequisite exports each exist once, and the manifest has no keybindings. The plan's unanchored `BoundDocument` check also counts `BoundDocumentChange`.
- The first missing artifact for 33-19's later outside-file handling is 33-06's `liveProjection.ts` and its last-projected record. [Plan 33-10](./33-10-PLAN.md) supplies the production `BindingSource` and attaches the adapter to open products. Cursor transport and decorations are in [Plan 33-12](./33-12-PLAN.md). This verification covered the core and local hub. Production VS Code wiring and interaction checks remain open.
