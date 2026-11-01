# Phase 61: Invitations, joining, removal, NEAR org and key integration - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-11-01
**Phase:** 61-invitations-joining-removal-near-org-and-key-integration
**Areas discussed:** Lead's NEAR session, Invite bundle & code, Invitee's NEAR key setup, Confirm & remove failures

---

## Branch (pre-discussion)

| Option | Description | Selected |
|--------|-------------|----------|
| New phase-61 branch | From the Phase 60 tip in this worktree; main's sign-in fixes come in on rebase | ✓ |
| New branch + merge main | Merge main now; may conflict in .planning/ | |
| Stay on phase-60 branch | Commit Phase 61 context on the Phase 60 branch | |

**User's choice:** New phase-61 branch. Worktree confirmed: `.claude/worktrees/team-mode` (the legacy WSL path in `git worktree list` resolves to the same repo).

---

## Lead's NEAR session

| Option | Description | Selected |
|--------|-------------|----------|
| Keep in SecretStorage | Refresh token stored, refreshed as needed, sign-out command | ✓ |
| This window only | In memory, sign in once per window | |
| Per action | Sign in and out for every invite/remove/grant | |

| Option | Description | Selected |
|--------|-------------|----------|
| At first invite + command | Offered at first invite plus a Link command | ✓ |
| Command only | Only an explicit link command | |
| Ask at Enable too | Also during Enable Team Mode | |

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, visibly degraded | Log-only invite/join, own key, no provider cap, stated plainly | ✓ |
| No, org required | Inviting needs a linked organization | |

| Option | Description | Selected |
|--------|-------------|----------|
| Per team | `nearAi.team.nearSession.<teamId>`; invitee signed out after join | ✓ |
| One per machine | Shared across all projects and teams | |

---

## Invite bundle & code

| Option | Description | Selected |
|--------|-------------|----------|
| One pasteable string | `near-ai-invite-v1.<base64url>`, shown once, hash only stored | ✓ |
| String + vscode:// link | Adds a pre-filled deep link | |
| Readable text block | Labelled multi-line block | |

| Option | Description | Selected |
|--------|-------------|----------|
| 7 days, choosable | 24 h / 3 d / 7 d / 14 d | ✓ |
| 72 hours fixed | | |
| 24 hours fixed | | |

| Option | Description | Selected |
|--------|-------------|----------|
| member.removed on invitee | Invited status member; cancel = member.removed; Manage Invitations list | ✓ |
| New cancel event | Add member.invite-cancelled | |
| No cancel, expiry only | Re-issue replaces | |

| Option | Description | Selected |
|--------|-------------|----------|
| Strip creds; offer clone | Clean URL; offer Git: Clone and resume Join | ✓ |
| Strip creds; ask to open | Clean URL; tell user to clone first | |

---

## Invitee's NEAR key setup

| Option | Description | Selected |
|--------|-------------|----------|
| Create new, or paste | Create in team workspace by default; paste validated via /v1/check_api_key | ✓ |
| Always create new | | |
| Paste only | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Zero until lead confirms | Limit 0; lead's confirm sets it to the invite allocation | ✓ |
| Invite allocation at once | | |
| No limit until Phase 66 | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Team key becomes active | New project-scoped profile selected; personal kept | ✓ |
| Ask at join | | |

---

## Confirm & remove failures

| Option | Description | Selected |
|--------|-------------|----------|
| role-changed to invited role | No new event type | ✓ |
| New member.confirmed event | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Notification + Members list | Confirm/Remove buttons, status bar count, Manage Team Members | ✓ |
| Members list only | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Log anyway + retry list | Limit 0, member.removed, revoke key, remove org member; failed NEAR steps on a retry checklist | ✓ |
| Stop on NEAR failure | | |
| Log first, NEAR best effort | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Stop + discard team secrets | Stop sync, delete team device key, API key profile and NEAR session from SecretStorage | ✓ |
| Stop, keep secrets | | |

---

## Claude's Discretion

- Event body field names, bundle JSON shape, code alphabet/length (≥128 bits), key naming, wording, checklist persistence, module split, NEAR HTTP retry.
- D-09 (code proof without clear text in the log) was derived from success criterion 4 during context writing; the mechanism is for research to confirm.

## Deferred Ideas

- Re-joining after removal, second-device flow for existing members, per-role invite limits (not discussed; spec defaults apply).
- `vscode://` deep link for the bundle.
