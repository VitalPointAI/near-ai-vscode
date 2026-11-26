---
phase: 46-native-theia-foundation
plan: launcher-guide
completed: 2026-11-26
---

# First project and restart instructions

The launcher and manual Docker paths now lead to the same first-project, model profile and chat instructions. The guide gives the correct stop and restart commands for the container each method creates. Restarting with the same launcher image digest reuses the existing workspace volume.

The independent plan check passed for `99537d93`. A walkthrough matched each browser address, container name and restart path to the launcher and manual example. The documentation production build, pinned diff check and Workbench lint passed. The existing seven launcher tests passed both from source and in the Workbench test bundle. No test cases were added for the guide.

## Open conditions

None.
