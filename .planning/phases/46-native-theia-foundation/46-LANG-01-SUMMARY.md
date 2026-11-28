---
phase: 46-native-theia-foundation
plan: "lang-01"
completed: "2026-11-27"
status: verified-local
---

# Canadian English and French in Get Started

The normal Workbench User Settings screen offers English (Canada) and Français (Canada) for the SovAI Get Started journey. It saves the choice in the user profile. The existing view updates its visible labels, accessibility text and language without reloading or replacing the view. The user still controls motion, keyboard focus and project context.

The view reads the exact user value and listens to the User preference provider. A conflicting entry in shared workspace settings cannot override the displayed language or suppress a user change. This first increment applies to the native Get Started surface.

## Verification

- The independently verified About harness at `066bc468d` was integrated at `9a1379d84`. The real browser test first failed on the missing User Settings control.
- Source `d849bb8e0` passed capped Workbench lint, native build and a focused browser run in private loopback. The test switched English to French, reopened in a fresh browser with French selected and switched to English. It checked current view and keyboard focus, a translated accessible label and a narrow layout. The intentionally conflicting shared settings file stayed byte-identical.
- Exact independent review and range scan passed. Logs and hashes are under `/tmp/sovai-lang-01-native.LhdqR3/`.

LANG-01 still requires broader Workbench, administration and documentation parity, packaged browser verification and qualified Canadian French review. LANG-02 and LANG-03 track approved bilingual product renditions and translation model qualification.

## Open conditions

- **G62** remains open for real source admission and production confinement in future staff translation workflows.
