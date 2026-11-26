---
phase: 46-native-theia-foundation
plan: same-machine-guide
completed: 2026-11-26
---

# Same-machine Workbench and hub guide

The getting-started guide explains how to start the Workbench and an optional hub on a single Linux x86-64 development machine. The hub example uses the same local Docker socket as the launcher, an approved image already on the machine, a dedicated Compose project and its own storage. The guide explains how to tell when each service is ready and how to stop and restart the hub.

Independent review passed plan `d688fcb6` and guide `f2b58401` against launcher merge `1bcef4f5`. The pinned diff check, shell syntax check and full production docs build passed. The walkthrough and build used no Docker, hub or secret operations. Live startup, managed installation and pairing are tracked in their existing work.

## Open conditions

None.
