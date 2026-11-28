---
phase: 47-on-premise-deployment-stack-and-offline-bundle
plan: 18-storage-preflight
completed: 2026-11-26
---

# Offline lab storage preflight

The lab preview accepts `--storage-plan <budget.json>` after the public key argument. Provide usable
capacity and reserved headroom in MiB, plus explicit amounts for all eight volume entries. The CLI
refuses an incomplete budget before running Helm. It compares the requests rendered by the pinned
charts with the budget, lists the fixed claims, and identifies the manually provisioned OpenBao
token claim. It reserves capacity for one retained Theia workspace. The actual claim name will be
known when that workspace is created.

Three regressions first failed because the option was missing. Independent source review also
found that the OpenBao test hook could conceal a missing reference in the real StatefulSet.
The tests reproduce that case and reject unexpected or unsupported claim layouts. All 97 affected
offline renderer, realm and installer tests passed on pinned Helm with zero skips.

## Open conditions

- G423: The live lab runner must feed the exact approved budget through site materialization, preflight and apply, confirm actual usable space on the encrypted guest, and match and bind the claims before use. The exact signed bundle and lab-specific image, live admission, passkey and workspace lifecycle still need verification.
- G424: The retained workspace and backup volumes still need the live recovery evidence assigned to the appropriate lab configurations and restore drivers.
