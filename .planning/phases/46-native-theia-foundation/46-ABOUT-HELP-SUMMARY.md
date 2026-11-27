---
phase: 46-native-theia-foundation
plan: about-help
completed: "2026-11-27"
status: verified-local
---

# About Sterling Sov AI in the Help menu

Help, Manage and the command palette open the existing About dialog with the live extension version. The product caption follows the Canadian User setting. The standalone Theia framework About entry remains available. The Workbench application title and extension display name now read Sterling Sov AI. The package identifiers, command IDs and version lookup are unchanged.

## Verification

- Independent plan review and both GSD validation checks passed. Before the source edit, the capped local registration probe found no Help action and the old captions and metadata. The same probe passed all six checks after the edit.
- Capped Workbench lint and production build passed on the isolated source. The focused Chromium case passed once without a bundled extension and once using the attested published v0.4.43 VSIX, SHA-256 `a60c2b39cd63b36ba0e239ed7e8f805012f3953109eec990ff3daaa5d6e3e27d`. It verified all three entry points in both Canadian languages, exact version or unavailable status, the Workbench browser title, keyboard dismissal, focus restoration and live language changes.
- Shared workspace preference files retained their original bytes in both sessions. Local evidence is in `.scratch/about-help/`. The published VSIX provided the active extension version for this browser check. Its existing manifest predates the source display-name change.

## Open conditions

- **G374** remains open for signed installed-site release facts. The packaged checks for these changes run in the normal gated release workflow.
