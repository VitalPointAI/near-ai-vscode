---
phase: 46-native-theia-foundation
plan: arm64-release-evidence
completed: 2026-11-26
---

# Linux ARM64 archive, egress and scan evidence

The native ARM64 job passed its three selected backend egress cases. It saved the same tested image as the archive verified and scanned by the x86-64 evidence job. The pinned scan reported zero High or Critical findings with available fixes. [Native job](https://github.com/VitalPointAI/near-ai-vscode/actions/runs/45837222918/job/139970208208) · [Scan job](https://github.com/VitalPointAI/near-ai-vscode/actions/runs/45837222918/job/139972447045)

| Evidence | Exact value |
|---|---|
| Reviewed source commit | `832b81746592f227982a3f3e6e36cc18fdf5731e` |
| Separate evaluation commit | `7d0f9246291087fb67d61c88e11c6bca900517bd` |
| Matching tree | `ee333a455ca09f2b08eaf8872e5411fd45816839` |
| Native image ID | `sha256:24bf55901b058c2be9b132629f33d659e2a2f459296fac31df81ce53c67c1c8b` |
| Compressed archive SHA-256 | `587c3a8e3821b583476b1b5c300a7a35af974f0e9805c393f9a6dfd67fa6be70` |
| CycloneDX SBOM SHA-256 | `7f4331fa66f269a2114393ca3d97d51c293be2e83563a024c6f2615f929ce805` |
| Grype database build time | `2026-11-26T06:22:34Z` |

Local verification passed 29 workflow checks and 18 shell execution cases. Independent review passed CI blob `1db396f` and test blob `353df25`. The evaluation’s docs job rejected the previous smoke summary’s closing sentence. The scoped docs correction passed all five local road-to-production tests. [Evaluation run](https://github.com/VitalPointAI/near-ai-vscode/actions/runs/45837222918)

This evaluation leaves the native browser checks and Phase 46-09 release facts for follow-up. It did not publish an image or change any release asset. G555 and G556 retain their original scope.

## Open conditions

None.
