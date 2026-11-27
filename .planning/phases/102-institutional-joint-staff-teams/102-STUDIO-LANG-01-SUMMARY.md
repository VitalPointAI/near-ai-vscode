---
phase: 102-institutional-joint-staff-teams
plan: studio-lang-01
completed: "2026-11-27"
status: verified-local
---

# Canadian English and French in Team Studio staff setup

Team Studio reads the existing Workbench User language through a native application contribution. It refreshes the staff setup chooser, coverage, announcements and editor handoff when that preference changes. Each open editor question keeps its labels until the person answers or leaves it. The following question uses the current language.

Language changes preserve the project name, selected section, review and confirmation. The host uses the same project-bound session and asks for confirmation before any write. Whole-staff coverage remains read-only.

## Verification

- The independently reviewed plan is `57923f881`. The first regression showed that the old chooser stayed in English. Focused tests at `692afbed7` passed 246 checks with zero skips, including stale language replies, retained focus and selection, and cancellation without changes. Native Workbench lint, production build and the commit-range secret scan passed.
- The clean local VSIX verified 3,176 entries, 630 runtime JavaScript files and 71 required assets. SHA-256 `a785333d91925d95b6fe0e380a5cf029a0739990fb0ae9bcbb061f8d7a0c921f`. The build reused the previous verified inventory for identical dependency locks and ran in an isolated network namespace.
- The bundled browser case at test-only revision `2d55720f0` passed once with zero skips in 8.6 seconds. It opened Studio in persisted French through the bundled command, exercised read-only coverage at 510 px, changed to English while a conflicting French workspace value stayed in place, kept the selected section and restored focus on cancellation. The private project and library snapshots matched. Earlier fixture failures occurred before setup at command-palette readiness, workspace trust and ambiguous command selection. Evidence is in `.scratch/package.9HmJNb/attempt4` in this worktree.

## Open conditions

- **LANG-01** still needs qualified Canadian French review and coverage of the remaining Workbench surfaces.
- **G17** remains open for verified appointments and actual role authority.
- **G62** remains open for production workspace confinement and reconciliation of shared-library links.
