---
phase: 46-native-theia-foundation
plan: local-launcher
completed: 2026-11-26
---

# Local Workbench launcher

The source checkout now includes a command to start an approved Linux x86-64 Workbench image by digest. It checks the local engine, release image and existing resources before starting, uses a persistent workspace volume, and prints the browser address after checking the loopback health endpoint. Retry retains the same container and volume. `--repair` can fetch the exact approved image if it is missing.

Independent review passed plan `8fa7b9fd` and the initial launcher blob `386954ba`. Raw Node 26 and bundled recording runs each passed five checks with zero skips. They cover initial setup, retry, refusal of a foreign resource, exact image acquisition and stable health publication. The subsequent launcher prerequisite plan adds a read-only check and preserves these behaviors.

This slice used injected Docker and HTTP operations. A real approved image and disposable host are needed for live setup verification.

## Open conditions

None.
