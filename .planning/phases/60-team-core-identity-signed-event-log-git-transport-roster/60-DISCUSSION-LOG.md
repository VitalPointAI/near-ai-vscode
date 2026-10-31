# Phase 60: Team core - Discussion Log

**Date:** 2026-10-31
**Mode:** auto. The owner instructed: answer every gray area from the spec (`.planning/research/v0.6.0-team-mode-addendum.md`) and the standing architecture rules, record decisions, and do not ask what the spec answers.

| Area | Question | Selected | Source |
|---|---|---|---|
| Coordination storage | Orphan branch or custom ref? | Orphan branch `near-ai/coordination`, ref recorded in team.json | Owner decision 2 default |
| Ordering | What is the total order? | First-parent commit order; Lamport tiebreak and monotone check; wall clock never | Spec 5.2, owner rule |
| Signing | Canonical form and key encoding | JCS-style sorted canonical JSON, integers only, Ed25519, base64url raw keys | Spec 5.2, v0.5.0 design |
| Event types | Declare all now or per phase? | Declare all; validate roster and policy now; others rejected as unsupported until their phase | Spec 5.2, phase scope |
| Trust anchor | How does a client know the log is its team's? | `team.json` pins genesis event id and owner key | v0.5.0 design |
| Permissions | Whole matrix now? | Whole 6.3 matrix in `decideTeamAction`, used on write and read | Spec 6.3, SEC-04 |
| Policy defaults | Which values? | Spec 7 defaults plus owner decisions 3-5; fractions stored as basis points | Spec 7, 14 |
| Device keys | Storage | SecretStorage only, `SecretStorageLike` type import | Spec 6.14, owner rule |
| Transport | Mirror, append, retry | Bare mirror in global storage, plumbing commits, CAS push, 5 jittered retries, re-validate | Spec 5.3 |
| team.json commit | Projects that gitignore `.planning/.near-ai/` | `git add -f`, `git commit --only`; never push code branches automatically | Codebase scout (this repo's .gitignore) |
| Secrets | Enforcement | `assertNoSecrets()` before every write plus canary test | SEC-01, owner rule |
| Solo parity | Startup cost without team.json | One `fs.stat`, nothing else | TEAM-01, D9 |
| Diagnostics | Where rejected events show | Output channel via Verify Team Log, status bar paused state | Spec 5.2, 6.15 |
| Two-instance proof | VS Code e2e or node tests? | Node tests with two clients on two clones now; two-window e2e in Phase 67 | Spec 11, roadmap |

## Deferred Ideas
- Ownership transfer between members.
- Custom ref as the default coordination storage.
