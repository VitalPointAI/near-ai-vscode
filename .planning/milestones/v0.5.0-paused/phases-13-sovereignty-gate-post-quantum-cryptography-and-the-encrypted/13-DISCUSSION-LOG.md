# Phase 13: Sovereignty gate, post-quantum cryptography, and the encrypted event log - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-10-28
**Phase:** 13-sovereignty-gate-post-quantum-cryptography-and-the-encrypted-event-log
**Areas discussed:** Key recovery & lockout, Creating a KB project, Forwarded-model refusal, Erasure & tamper response

---

## Key recovery & lockout

| Option | Description | Selected |
|--------|-------------|----------|
| Encrypted file + passphrase | Passphrase-protected key file saved outside the workspace | |
| Recovery words only | 24-word seed; PQ keys derived deterministically | |
| Both | Words regenerate identity; file is a convenience copy | ✓ |

| Option | Description | Selected |
|--------|-------------|----------|
| No, blocking | Base can't be created until export saved and verified | ✓ |
| Skip with persistent warning | Deferrable with a banner | |

| Option | Description | Selected |
|--------|-------------|----------|
| Unlock with passphrase each session | Key wrapped by passphrase on disk | ✓ |
| Refuse KB projects there | Strictest; blocks WSL/code-server | |
| Trust VS Code's fallback store | Least friction, weakest | |

| Option | Description | Selected |
|--------|-------------|----------|
| Restore from export or retry | No create-new-key for this base | ✓ |
| Restore, retry, or start a new identity | Adds a separate new identity | |

---

## Creating a KB project

| Option | Description | Selected |
|--------|-------------|----------|
| New project only | No conversion of existing projects | ✓ |
| New or convert existing | Conversion encrypts/quarantines old plaintext | |

| Option | Description | Selected |
|--------|-------------|----------|
| Never, one-way | Permanent per project id | ✓ |
| Deliberate exit with confirmation | User-only command with audit entry | |

| Option | Description | Selected |
|--------|-------------|----------|
| Chat header + status bar | Persistent badge and status item | ✓ |
| Chat header only | Less noise | |
| You decide | Follow UX-CONTRACT.md | |

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, but .planning holds no findings | GSD artifacts allowed; findings in the base | ✓ |
| No GSD artifacts at all | Pure research workspace | |

---

## Forwarded-model refusal

| Option | Description | Selected |
|--------|-------------|----------|
| Shown disabled with reason | Greyed out with label | ✓ |
| Hidden entirely | Cleaner list | |

| Option | Description | Selected |
|--------|-------------|----------|
| Block with reason, offer TEE swap | User confirms re-route | ✓ |
| Block only | Manual fix | |
| Auto-substitute a TEE model | Silent switch, logged | |

| Option | Description | Selected |
|--------|-------------|----------|
| Treat as forwarded, refuse | Fail closed | ✓ |
| Warn and confirm per session | Weaker | |

| Option | Description | Selected |
|--------|-------------|----------|
| Loopback endpoint only | 127.0.0.1, ::1, unix socket | ✓ |
| Trust user-labelled endpoints | LAN boxes allowed | |

---

## Erasure & tamper response

| Option | Description | Selected |
|--------|-------------|----------|
| Claims, sources & attachments | Per-item keys; references show [erased] | ✓ |
| Whole entries only | Coarser | |
| You decide | Research decides | |

| Option | Description | Selected |
|--------|-------------|----------|
| Who, when, why | Tombstone with reason | ✓ |
| Id and time only | Minimal | |

| Option | Description | Selected |
|--------|-------------|----------|
| The user, never an agent | Agents only propose | |
| User or agent with approval | Agent triggers through approval gate | |

**User's choice:** "agent can trigger it with an explanation"
**Notes:** Follow-up asked whether agent-triggered erasure needs user approval first or runs immediately; user chose approval first (the explanation is shown in the approval prompt and becomes the tombstone reason).

| Option | Description | Selected |
|--------|-------------|----------|
| Read-only up to last good point | Report; writes blocked until resolved | ✓ |
| Refuse to open | Fully locked | |
| Open with warning, writes allowed | Most permissive | |

---

## Claude's Discretion

- KDF parameters, recovery-file format, phrase wordlist/encoding
- Per-segment signature vs hash tree
- Visual design of badge, locked screen, tamper report
- Message wording

## Deferred Ideas

None.
