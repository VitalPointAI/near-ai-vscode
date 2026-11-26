---
phase: 46-native-theia-foundation
plan: launcher-arm64
completed: 2026-11-26
---

# Native Linux ARM64 launcher selection

The local launcher checks whether the Linux workstation and its Docker engine agree on x86-64 or ARM64. `--check` reports the verified platform before an image is needed. Launch and repair require an exact approved digest on that platform. ARM64 repair, startup, retry and mismatched-resource refusal use the same loopback and workspace checks as x86-64.

Independent review passed plan `8606b72`, launcher `1e9afd6` and fixture `f5df70f`. Tests first reproduced absent platform selection. Raw and bundled Node 26 runs each passed seven checks, and all five documentation checks and CLI help passed. The fixtures used recorded Docker and HTTP operations.

The native ARM64 Workbench ran successfully on the hosted test runner. The launcher still requires a signed published image for normal end-user setup. macOS remains deferred. [Native ARM64 evaluation](https://github.com/VitalPointAI/near-ai-vscode/actions/runs/45841495686)

## Open conditions

None.
