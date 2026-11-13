# Phase 27 deferred items

Found during plan 27-02, out of scope for it (not caused by its changes). Nothing here blocks the phase.

## Other pid-only temporary file names (plan 27-02, Task 3)

Pitfall 3 (a code-server container and the host editor can share a pid) also applies to writers that build their temporary name as `<file>.tmp-<pid>` or `<file>.<pid>.tmp` and are NOT in the plan's list of six. Plans 04, 05 and 09 own `runMarkers.ts`, `transcripts.ts` and `benchmark/store.ts`. These were not assigned to any plan:

| File | Temporary name |
|------|----------------|
| `src/services/contextGraphStore.ts` (line 145) | `.tmp-${process.pid}` |
| `src/services/profileStore.ts` (line 343) | `.tmp-${process.pid}` |
| `src/services/cyberEngagementStore.ts` (line 145) | `.tmp-${process.pid}` |
| `src/services/cyberSarifExport.ts` (lines 180, 241) | `.tmp-${process.pid}` |
| `src/services/projectInitialization.ts` (line 35) | `.tmp-${process.pid}` |
| `src/services/reputation.ts` (line 58) | `.tmp-${process.pid}` |
| `src/services/agentProfiles.ts` (line 68) | `.tmp-${process.pid}` |
| `src/services/generationService.ts` (line 350) | `.tmp-${process.pid}` |
| `src/services/teamStudio.ts` (line 116) | `.tmp-${process.pid}` |
| `src/services/multimodalOrchestrator.ts` (line 248) | `.tmp-${process.pid}` |

Several of these write project-local files under `.planning/.near-ai/` that a shared state home may later carry, so a follow-up plan should switch them to the same `randomBytes(8)` suffix.
