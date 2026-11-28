---
phase: 46-native-theia-foundation
plan: launcher-secret-readiness
completed: 2026-11-28
---

# Standalone launcher secret storage check

The existing `--check` command and offline guide explain before download that the released standalone Workbench has no local keyring or organization secret store. They identify the effect on saved credentials and Standing Orders, continued use of local features that need no saved credentials, and the next step with an administrator. The same check covers both supported launcher architectures. Launch and exact-image repair retain their existing steps.

On Node 26.13.1, the recording test first failed because the line was missing. The final eight launcher checks passed in a private no-egress namespace with no real Docker operations or credential reads. Independent review checked the launcher boundary and both guide anchors. Retained final recorder SHA-256 `31fb68a2a559feef6a17fe8ee85568edc92b31301e24248cde3d34217d3747a2`.

This records the shipped standalone image's capability. Provider installation and actual credential readiness are separate work. A supported automated remedy needs a selected provider route and a verified scoped operation by the Workbench runtime identity.

## Open conditions

- **G374.** Signed installed-site release facts remain required for hosted sessions. This launcher check does not supply hosted installation evidence.
