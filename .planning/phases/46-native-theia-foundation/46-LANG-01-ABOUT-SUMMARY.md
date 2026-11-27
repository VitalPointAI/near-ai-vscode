---
phase: 46-native-theia-foundation
plan: lang-01-about
completed: "2026-11-27"
status: verified-local
---

# Canadian-language About SovAI

About uses the same Canadian display language as Get Started. Manage and the palette use the current caption when opened. A change to User Settings updates the title, accessible name, language, version message and footer button of an open dialog in place. The active extension manifest remains the source of the version. The single command preserves Escape, footer Enter and focus restoration.

## Verification

- The independently checked plan is `f46251e43`. The first private native browser run switched Get Started to French and failed on the missing French About entry before source was changed. The subsequent run exposed native Enter consumption, which the scoped dialog keyboard handling corrected.
- Source `ee4c781b8` passed capped Workbench lint, production source build and independent review. Separate private Chromium sessions passed the existing About case in unbundled and bundled Workbench. The unbundled run displayed the translated unavailable message. The bundled run used the previously verified local VSIX and showed its exact version 0.4.41.
- The same scenario opened both native entry points and switched the language from a second Settings page while the original dialog and its focused button stayed in place. About and the existing Get Started language scenario also passed consecutively in one unbundled session. Shared workspace settings bytes stayed unchanged in every run. Evidence is in `/tmp/sovai-about-fr.4gqKoZ`.

Exact packaged image acceptance and qualified Canadian French review remain part of LANG-01 verification. Other app surfaces and bilingual product renditions have their own acceptance requirements.

## Open conditions

- **G374** remains open for signed installed-site release facts. This work reports the extension version for the active Workbench.
