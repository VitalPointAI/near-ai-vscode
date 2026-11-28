---
phase: 46-native-theia-foundation
plan: launcher-capacity
completed: 2026-11-26
---

# Workbench setup capacity readings

The Workbench setup check reports the logical CPU count and total memory that the local Docker engine sees. A failed or unreadable capacity query leaves the software prerequisite result intact and explains that the readings are unavailable. The figures help diagnose setup. Measured hardware limits belong to the workstation acceptance plan.

The revised plan `d9749a58` and the launcher and fixture diff passed independent review. Tests first reproduced the missing capacity line. All seven existing launcher checks then passed in both raw and bundled Node 26 runs, with zero skips. Bundled CLI help and whitespace checks passed. The fixture verifies both Linux architectures, refused and malformed observations, and that only check mode queries capacity. No live Docker engine was contacted.

## Open conditions

None.
