---
phase: 46-native-theia-foundation
plan: arm64-browser-evidence
completed: 2026-11-26
---

# Native Linux ARM64 browser evidence

The native browser job passed against the same tested and scanned ARM64 Workbench archive. The existing browser egress case passed for `127.0.0.1` and `localhost`. The selected Get Started case verified its setup actions and work-area cards in the same container. The complete evaluation workflow passed. [Browser job](https://github.com/VitalPointAI/near-ai-vscode/actions/runs/45841495686/job/139987766138) · [Full evaluation](https://github.com/VitalPointAI/near-ai-vscode/actions/runs/45841495686)

| Evidence | Exact value |
|---|---|
| Reviewed source commit | `30c186ebaf90f4ad90820bf79ec89d2c99c0c048` |
| Separate evaluation commit | `fc82a3939c4a0be7e76ba3d77c16e40a6a40333c` |
| Matching tree | `c5f68653d8af6085df2e548b87eb9ea5e9bcc468` |
| Native image ID | `sha256:51a50572ce3b9db66e95a79143b74ac54cfacf435ffe558bc66ee26b088a72dd` |
| Compressed archive SHA-256 | `f9b88b42ad9c24269d6f35e53b799836f24a5fa17a79e13cb04da0abb540546b` |
| CycloneDX SBOM SHA-256 | `b452bb17822a93f3ef0992f0e0f5bd4c6a25c5ef4b2b0cdf02b8273cf10ba299` |
| Headless Shell ZIP SHA-256 | `b136462898353d94c7fab50f9cdaa6d8f0d4c190153916936aa0a03353a26bf2` |

The owner approved that exact ZIP for the two disposable CI checks. The pinned Playwright 1.65.0 CLI launched the checked native executable. Independent source review and local verification passed 30 workflow tests, 16 shell checks, six config checks, Workbench type checking, and the five documentation checks. The archive scan found zero High or Critical findings with available fixes.

The result is native Linux ARM64 evaluation evidence. Formal release facts and guarded publication have separate plans. macOS remains deferred.

## Open conditions

None.
