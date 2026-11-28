---
phase: 48-load-and-accreditation-verification
plan: terminal-fixture
completed: 2026-11-28
---

# Terminal fixture selection correction

The local journey snapshots terminal widget IDs before opening the new terminal. It requires one new widget and one current terminal tab that belongs to that widget. It checks ownership of the focused xterm input before typing the existing fictional command and again before submitting it once. The fixture succeeds when it reads the expected marker. Selection, focus and marker failures have fixed diagnostic messages. The terminal step still measures the complete action under the existing browser and journey deadlines.

The selector follows pinned Theia 1.77.0. Its terminal frontend assigns the default `terminal-<number>` ID to a `terminal-container`, and its shell renders `shell-tab-<widget ID>`. The shell overrides Lumino's tab renderer and inherits the `lm-mod-current` class for the current tab. The recorded input uses xterm's `textarea.xterm-helper-textarea` inside the selected widget.

## Verification

- RED reached the recorded selection assertion with the old code. The older visible terminal received the action and produced the same fictional marker. RED log SHA-256 `132548a2a9fcdfe7963ffe941a3821e27948c1132f50bc1e3d5dfd0b5980b3c9`.
- All 12 cases in `loadtest/test/browser.test.ts` passed with zero skips on Node 26.13.1. The recorder checked the new terminal, missing or ambiguous selection, focus loss before typing or before submission, and the wrong marker. `npm --prefix loadtest run lint`, syntax and exact-range checks passed with existing lock-identical offline dependencies. Test log SHA-256 `16f88a8a8902a90aee0a3ccf8573715f62a6bc7e9086752f5dbf0de476d2658d`.
- This was a recorded local fixture. A live attempt with the pinned image and modified journey needs separate one-shot approval. Terminal channel readiness and the cause of the previous missing marker remain unverified.

## Open conditions

- **G322.** The hosted deployment still needs target-stage load evidence in a hashed run file or a record of the reached stage and reason.
- **G323.** Representative per-hub load at the target remains unmeasured.
