---
phase: 33-live-multi-user-staff-projects
plan: "19"
status: superseded
subsystem: shared editor reference adapter and attribution
tags: [staff, editor-binding, attribution, mus-09]
requires: [33-04]
provides: [registerStaffEditorBindings, BindingSource, authorRows, authorLabel, NOT_VERIFIED_TEXT]
affects: [33-25, 33-29, 33-30]
tech-stack:
  added: []
  patterns: [source-selected editor binding, local-origin history, readable historical attribution]
key-files:
  created:
    - src/services/staffEditorBinding.ts
    - src/domain/staff/whoWroteThis.ts
    - src/test/staffEditorBindingAdapter.test.ts
    - src/test/staffAttributionView.test.ts
  modified:
    - src/test/helpers/vscodeStub.ts
    - src/test/staffMultiUserManifest.test.ts
requirements: [MUS-09]
requirements-completed: []
duration: not recorded
completed: 2026-11-26
---

# Phase 33 Plan 19 shared editor reference summary

The VS Code adapter and its tests landed in [PR #208](https://github.com/VitalPointAI/near-ai-vscode/pull/208) as a reference for native Workbench. The [plan's November 23 amendment](33-19-PLAN.md#re-aim-amendment-2026-11-23) and [decision D-64](33-CONTEXT.md) supersede the original activation plan. The extension has no production caller for the adapter. The extension manifest on main omits its commands, shortcuts, palette entries and bound-editor context. Keep the reference in the tree under the existing owner decision.

## Historical verification

The capped runs recorded in the plan used an injected binding source, a VS Code-shaped stub and local fixture stores.

| Checkpoint | Evidence | Scope |
| --- | --- | --- |
| [Adapter](33-19-PLAN.md#local-task-1-adapter-checkpoint) | `9756ede07`. 77 focused checks passed, with zero failures or skips. A final build and all five adapter cases passed after tightening the lazy-load assertion. | Local typing, one remote workspace edit without echo, no replica load for an unbound document, close and flush, version races and line endings. |
| [Shared history](33-19-PLAN.md#local-task-2-shared-history-checkpoint) | `0ee1fe6f9`. 82 focused checks passed, with zero failures or skips. | Active-editor context, local-origin undo and redo, and preservation of peer edits. The shortcut assertions covered the pre-integration manifest. |
| [Attribution](33-19-PLAN.md#local-task-3-attribution-checkpoint) | `35eb53aad`. Build, lint and 133 focused checks passed, with zero failures or skips. | Historical roster names, text labels for people and agents, provisional spans, missing historical metadata and stale-view invalidation. |
| [Integration](https://github.com/VitalPointAI/near-ai-vscode/pull/208) | `99373e04f`. The integration record identifies unhandled commands in the extension end-to-end check and records their removal. | Main retains the adapter and model tests. The manifest invariant checks the absence of any production attachment or exposed editor command. |

On main `5bfeba0af`, the extension compiled and all 41 focused checks passed with zero
failures or skips. The selected suites cover the binding, VS Code adapter, attribution and
extension manifest.

The reference registers `nearAi.staff.undoMyChange`, `nearAi.staff.redoMyChange` and `nearAi.staff.showWhoWroteThis` when a test attaches it. The stub supplies editor and document change events, workspace edits, context recording, decorations and a quick pick. The original outside-file Take or Restore behavior was explicitly unfinished at the historical checkpoints. The evidence comes from fixture runs. Workbench activation and browser acceptance have their own plans.

## Native handoff

[Plan 33-25](33-25-PLAN.md) owns the native Workbench binding, local history and the outside-file choice. [Plan 33-29](33-29-PLAN.md) owns native cursors and **Show Who Wrote This**, using the retained attribution model. [Plan 33-30](33-30-PLAN.md) owns the two-browser Workbench acceptance. The native path still carries its own MUS-09 acceptance. The original dependent
[Plan 33-10](33-10-PLAN.md) is also superseded by native Plan 33-24.

## Open conditions

None.
