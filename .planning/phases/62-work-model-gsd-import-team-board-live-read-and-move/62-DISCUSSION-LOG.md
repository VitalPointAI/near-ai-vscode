# Phase 62: Work model, GSD import, Team Board (live, read and move) - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-11-02
**Phase:** 62-work-model-gsd-import-team-board-live-read-and-move
**Areas discussed:** Who imports, from where; Card granularity; Which moves exist now; Board layout and placement

---

## Who imports, from where

| Question | Options | Selected |
|---|---|---|
| Source | Integration branch (committed) / Current checkout | Integration branch |
| Importer | Owner and leads / Anyone with edit rights | Owner and leads |
| Trigger | Auto + on demand / On demand only / After GSD commands only | Auto + on demand |
| Removed items | Cancel with a reason / Flag, keep state | Cancel with a reason |
| State source | GSD sets first state only / GSD wins on every import | GSD sets first state only |

## Card granularity

| Question | Options | Selected |
|---|---|---|
| Tasks | Checklist inside the plan / Own cards | Checklist inside the plan |
| Hierarchy | Swimlane headers + summary / Cards too | Swimlane headers + summary |
| Scope | Current milestone / Everything | Current milestone |

## Which moves exist now

| Question | Options | Selected |
|---|---|---|
| Ready | Computed, lead can hold / Moved by hand / Both | Computed, lead can hold |
| Moves (multi) | Block/unblock, Cancel/reopen, Mark done (lead), Hold/release | All four |
| Later columns | Shown, drop refused / Hidden until their phase | Shown, drop refused |
| New items | Yes, create and edit / Not yet | Yes, create and edit |

## Board layout and placement

| Question | Options | Selected |
|---|---|---|
| Placement | Sidebar list + editor kanban / Kanban in both / Editor panel only | Sidebar list + editor kanban |
| Moving | Drag + move menu / Move menu only | Drag + move menu |
| Status bar | Ready + pending / Keep as is | Ready + pending |

## Claude's Discretion

Event body schemas, frozen-phase representation, refusal wording, styling and DnD mechanism.

## Deferred Ideas

Quick-task write-back (65); ready-for-me and over-budget filters (64, 66); release readiness card (67).
