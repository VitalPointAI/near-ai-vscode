---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 18-render-preview
completed: 2026-11-26
---

# Offline lab-core release preview

The preview checks the 18 lab-core releases in the normal descriptor order. It combines the reviewed lab overrides with the selected example defaults in private scratch, verifies the Zot registry port and Keycloak settings, and reports unresolved image digests. Scratch is cleared after success or failure.

The new test first failed with the preview command absent. All 67 related offline checks then passed with pinned Helm, with zero skips. After the test was made to follow the current image lock, all eight focused renderer checks passed again. The new test checks the full release selection, matches the bootstrap port, verifies the output limits, rejects private or malformed key inputs, and checks cleanup on both successful and failed renders.

## Open conditions

- G423: The actual isolated install still needs the exact signed lab bundle and OpenBao image, storage sized for the VM, shared release selection across install steps, admission, passkeys and recovery. The preview worktree is based on Plan 47-35's verified branch. Publish only after that plan reaches main and the preview is reverified on current main.
