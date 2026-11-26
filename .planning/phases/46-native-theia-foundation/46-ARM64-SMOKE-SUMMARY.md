---
phase: 46-native-theia-foundation
plan: arm64-smoke
completed: 2026-11-26
---

# Native Linux ARM64 Workbench candidate

The first native ARM64 evaluation built the existing Workbench release target from the verified CI extension. It started as UID 10001, returned the exact health response on loopback, found the bundled extension, loaded `drivelist`, and completed the `node-pty` shell check. The packaging prerequisite and native job both passed. [Native job](https://github.com/VitalPointAI/near-ai-vscode/actions/runs/45834553568/job/139960903748)

| Evidence | Exact value |
|---|---|
| Reviewed source commit | `80443be29d428499cfdcc71b55052fcd334e6f58` |
| Separate evaluation commit | `308c3b9b784fff6669f70d8dbe0485fea0e74b46` |
| Matching tree | `ca957e15840db177b2f91d5e607311e9b918f685` |
| Verified extension SHA-256 | `a3a3874288c80f98669bf77bc7d017f85a40771735425a6be0aa3b5b542c6365` |
| Native candidate image ID | `sha256:f2287e03529941e3a95f24ebeaad5c6e382a7a100067a900304bb8ef32e3944f` |
| Native Node 26 base manifest | `sha256:f97629c56128784f159ec8259ff5a85afe01064e6aa91adb1d54428bb6cce9d7` |
| Native UBI 9 base manifest | `sha256:2caabd01df9c31b37f61d19e515c9913d77f0a1ece3558d30fed8ed56490914a` |

Independent review passed CI blob `708770cc` and test blob `3627bd3d`. The local verification ran 28 workflow checks and 14 shell cases with zero failures. The evaluation branch was pushed and dispatched for evidence. The change has no PR and the candidate image has no registry reference. Native egress, browser checks, scan evidence and protected ARM64 distribution are covered by follow-up work. The owner deferred macOS setup and development.

## Open conditions

None within the native build and startup proof.
