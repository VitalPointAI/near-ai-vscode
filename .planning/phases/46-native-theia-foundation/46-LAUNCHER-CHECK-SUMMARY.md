---
phase: 46-native-theia-foundation
plan: launcher-check
completed: 2026-11-26
---

# Workbench launcher prerequisite check

`node scripts/launch-local-workbench.mjs --check` checks the host architecture, Node runtime, Docker client, local socket and engine before the user needs a release image. It gives different instructions for an absent client, an inaccessible or stopped engine, and an old or unsupported engine. Launch and image repair use the same prerequisite path. The check leaves the engine's images, containers and volumes untouched.

The exact plan `7deb92f`, launcher `47458aa` and recording test `1ca2b4a` passed independent review. The tests-first run showed the missing check path and the wrong order for diagnosing a missing Docker client. The corrected raw Node 26 and bundled runs each passed six checks with zero skips. CLI help and incompatible flag combinations also passed. No real Docker engine was contacted. The getting-started guide documents the new command and the supported Linux x86-64 setup.

Host software installation, capacity qualification and live setup verification are separate work. This plan covers read-only diagnostics and keeps the existing exact-image repair behavior.

## Open conditions

None.
