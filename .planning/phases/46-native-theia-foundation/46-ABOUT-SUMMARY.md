---
phase: 46-native-theia-foundation
plan: "about"
completed: "2026-11-27"
status: verified-local
---

# About SovAI

The native Manage menu and command palette open an accessible About dialog. It reads the active SovAI extension manifest and displays its version. A missing, failed or stalled extension command produces a clear unavailable message. Closing the dialog allows a new lookup. All labels have stable localization keys.

## Verification

- Source `ac94f51ae` passed root and Workbench lint, root compile, architecture 13/13, range scan and offline VSIX verification. The VSIX is `edacdc289b48534a87a8093f5f044eccb493f5b4b98b6066b7d9a54a23eacebe`. A controlled timeout probe verified bounded retry and timer cleanup.
- Native source build and the unchanged Playwright acceptance passed in separate bundled and unbundled private loopback runs after the Escape correction `617a04f33`. The test exercised Manage, the palette, exact version or unavailable, keyboard dismissal and focus. The earlier real native run reproduced the Escape defect. Final logs are in `/tmp/sovai-about-window.KNH5Le/`.
- Both source checkpoints passed independent review. The native browser used the verified local VSIX and a disposable Workbench compiled from the candidate. Container-image verification is separate.

## Open conditions

- The combined container/browser acceptance needs the exact candidate Release and unbundled images through the normal Workbench checks. **G374** remains open for signed installed-site release facts. About displays the running extension version and makes no claim about the site-wide installed state.
