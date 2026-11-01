---
phase: "60"
slug: "team-core-identity-signed-event-log-git-transport-roster"
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: "2026-11-01"
---

# Phase 60 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Remote coordination branch to client | Every event fetched from `near-ai/coordination` is untrusted until the materialiser accepts it (schema, team, bound device, signature, Lamport, permission at that position) | Signed events, snapshots, team-file copy (public; must hold no secret) |
| team.json to client | The trust anchor committed on the code branch; parsed as attacker-influenced input and pinned on first sight | Team id, owner device key, genesis id, remote and ref names |
| Extension to git child processes | argv-only spawn, mirror-local hooks path, fsck on fetch, URL never stored | Remote URL (may carry credentials), refs, object data |
| Extension to SecretStorage / global storage | Device private key only in SecretStorage; mirror, pin and audit mark in global storage | Ed25519 private key (secret), trust pin, mirror state |
| Client to UI (status bar, output channel, notifications) | All remote-derived text is redacted, flattened and capped before display | Names, ids, paths, reasons, git error text |

---

## Threat Register

Extracted from the `<threat_model>` tables of 60-01 to 60-11 (T-60-SC appears in every plan and is listed once). Evidence (file:line and covering tests) for every row is in the 2026-11-01 security audit (gsd-security-auditor, ASVS L1).

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-60-01 | Spoofing | materialize.ts genesis check | high | mitigate | First event must match anchor eventId, owner fingerprint, public key and signature, else the whole log is refused with the D-10 text (tested by client C) | closed |
| T-60-02 | Tampering | canonical.ts | high | mitigate | Signature input is canonical bytes; file text must equal canonicalize(parse(text)); floats, -0, lone surrogates and deep nesting rejected (Task 2 vectors) | closed |
| T-60-03 | Information disclosure | identity.ts | high | mitigate | Private key only in SecretStorage and a closure-held KeyObject; JSON.stringify(identity) test proves no key material serialises; no key literal in fixtures | closed |
| T-60-04 | Tampering | gitTransport.ts mirror config | medium | mitigate | Mirror-local core.hooksPath to an empty dir; explicit URL and refspec; argument arrays, no shell | closed |
| T-60-05 | Information disclosure | runGit.ts error text | medium | mitigate | redactGitMessage strips URL userinfo and applies redactSecrets before any status reason; the remote URL is never stored | closed |
| T-60-SC | Tampering | npm/pip/cargo installs | high | mitigate | No package installs in this plan; package.json dependencies unchanged (RESEARCH Package Legitimacy Audit lists none) | closed |
| T-60-06 | Elevation of privilege | permissions.ts | high | mitigate | Full matrix as data with a test per cell; removed members denied; one owner; no self role change | closed |
| T-60-07 | Elevation of privilege | permissions.ts device rules | high | mitigate | Lead cannot add or revoke owner devices (D-32), so a lead cannot obtain a key that signs as the owner | closed |
| T-60-08 | Information disclosure | secrets.ts | high | mitigate | assertNoSecrets throws before any write; detector covers D-23 shapes plus redactSecrets by difference; message never contains the value | closed |
| T-60-09 | Denial of service | secrets.ts walker | low | accept | Explicit stack and depth cap 64; inputs are bounded by the 16 KB event limit and small team.json; residual cost negligible | closed |
| T-60-10 | Tampering | gitTransport.ts fetch | high | mitigate | Ancestry check of the trusted head after every fetch plus persisted pin; rewrite refused and quarantined, state kept (D-33) | closed |
| T-60-11 | Repudiation | gitTransport.ts read | medium | mitigate | Only first-parent added files become entries; modified, deleted, merged or unexpected files become anomaly rows; content read from the adding commit | closed |
| T-60-12 | Information disclosure | status reasons, diagnostics | high | mitigate | redactGitMessage on every reason; URL never stored or logged; canary userinfo test | closed |
| T-60-13 | Tampering | lost-race retry | high | mitigate | Builder re-invoked per attempt so Lamport, prev and sig are fresh; landed pushes recognised by ancestry (no duplicates) | closed |
| T-60-14 | Denial of service | append retries | medium | mitigate | Bounded retries with jittered backoff; busy result instead of a throw; per-mirror mutex | closed |
| T-60-15 | Elevation of privilege | user hooks on mirror | medium | mitigate | Mirror-local core.hooksPath to an empty dir verified against a failing global pre-push hook | closed |
| T-60-16 | Denial of service | malicious remote withholding events | low | accept | Not preventable by a client (honest limit in RESEARCH); status shows offline or stale and Verify Team Log reports the head | closed |
| T-60-17 | Tampering | parseEventFile | high | mitigate | Exact keys, canonical-bytes equality (duplicate keys and whitespace rejected), strict id, key and signature shapes, file-name equality | closed |
| T-60-18 | Denial of service | parseEventFile | medium | mitigate | 16 KB size gate before parsing; depth limit through canonicalize; parse inside try/catch mapped to malformed event | closed |
| T-60-19 | Tampering | prototype keys in JSON | medium | mitigate | No spread or Object.assign of parsed input; exact-key validation rejects __proto__ and constructor keys | closed |
| T-60-20 | Information disclosure | member bodies | medium | mitigate | Only salted emailHashes in signed bodies (D-31); a body with an emails key is rejected | closed |
| T-60-21 | Spoofing | applyEntry steps 3-4 | high | mitigate | Device must be bound to the author by an earlier accepted roster event and verify the signature with that key | closed |
| T-60-22 | Elevation of privilege | applyEntry step 6 | high | mitigate | decideTeamAction at that log position (same function as the write side); fixture tests per role | closed |
| T-60-23 | Tampering | revoked or removed authors | high | mitigate | Positional checks (D-11): events after revocation or removal are rejected, earlier ones stay valid | closed |
| T-60-24 | Denial of service | Lamport poisoning | medium | mitigate | Rejected events never move highLamport; jump cap 1000; MAX_LAMPORT in schema | closed |
| T-60-25 | Tampering | replayed events | medium | mitigate | Duplicate-id and Lamport-not-greater checks | closed |
| T-60-26 | Tampering | forged snapshot | high | mitigate | snapshot.written accepted only when it matches the replayed state hash; loaded snapshots are provisional and signed by an owner or lead device | closed |
| T-60-27 | Spoofing | team.json genesis anchor | high | mitigate | Strict validation plus a local trust pin that refuses a changed team or owner key; bounded by code-branch write access (honest limit documented) | closed |
| T-60-28 | Elevation of privilege | team.json remote and ref fed to git | high | mitigate | REMOTE_NAME_PATTERN cannot start with a dash; ref pattern with no .., // or .lock; values only ever passed as separate argv entries | closed |
| T-60-29 | Information disclosure | team.json and audit writes | high | mitigate | assertNoSecrets before every write; audit metadata limited to ids, role, type and lamport | closed |
| T-60-30 | Tampering | concurrent team.json writes | medium | mitigate | Per-path promise chain plus temp-file-then-rename; failures rethrown with cleanup cause | closed |
| T-60-31 | Repudiation | duplicated or missing audit entries | low | mitigate | Deterministic audit ids plus a persisted high-water mark | closed |
| T-60-32 | Information disclosure | prepareEvents | high | mitigate | assertNoSecrets on every body before signing; SecretLeakError propagates and the remote head is asserted unchanged | closed |
| T-60-33 | Elevation of privilege | prepareEvents and applyEntry | high | mitigate | One decideTeamAction on write and read; forgery suite asserts equal reason text for owner and fixture roles | closed |
| T-60-34 | Tampering | retried appends | medium | mitigate | Builder re-stamps lamport, prev, id and sig per attempt; test with an injected CAS loss | closed |
| T-60-35 | Tampering | snapshot writer | medium | mitigate | Only owner or lead signers write; snapshot.written must match the replayed state hash on every client; race loser skips | closed |
| T-60-36 | Information disclosure | enableTeamMode inputs and outputs | high | mitigate | assertNoSecrets on inputs before key creation, on bodies, team.json and audit entries; canary scan of every git object and written file | closed |
| T-60-37 | Information disclosure | owner email | medium | mitigate | Only emailHash(teamId, email) is signed (D-31); test asserts the plain address is absent from remote objects and team.json | closed |
| T-60-38 | Tampering | user's staging area and branch | medium | mitigate | git add -f plus git commit --only of team.json; other staged files untouched; code branch never pushed (tests assert both) | closed |
| T-60-39 | Denial of service | partial enable | medium | mitigate | Remote-exists check before key creation; push failure rolls back key and mirror; commit failure unstages and explains the manual command; re-run reports the existing team | closed |
| T-60-40 | Information disclosure | remote URL with credentials | high | mitigate | The URL is never read into persisted data; ls-remote and transport use the remote name or an in-function URL; canary userinfo scan | closed |
| T-60-41 | Information disclosure | status tooltip and output lines | high | mitigate | redactGitMessage on every reason; canary password test on tooltip and output | closed |
| T-60-42 | Denial of service | polling an unreachable or hostile remote | medium | mitigate | Exponential backoff to 10 minutes, single flight, pollSeconds clamped 5..3600 | closed |
| T-60-43 | Spoofing | output channel lines built from remote data | low | accept | Only validated event ids (pattern-checked) or file paths and fixed reason strings are printed; no free text from bodies is echoed except validated names in the members list | closed |
| T-60-44 | Tampering | changed team.json between sessions | high | mitigate | checkTrustPin at session start; mismatch stops the session with a plain message | closed |
| T-60-45 | Tampering | lost or duplicated events under races | high | mitigate | End-state test: every event once, linear, no forced update, fresh replay with zero rejections | closed |
| T-60-46 | Denial of service | shared mirror contention across processes | medium | mitigate | Retry fetch lock races, unique temp index and pin names; shared-mirror test | closed |
| T-60-47 | Information disclosure | command UI and settings | high | mitigate | Command never writes configuration; canary scan of output, notifications, status bar and storage after Enable and Verify | closed |
| T-60-48 | Denial of service | activation in solo projects | medium | mitigate | One fs.stat, no static team-core imports, no timers or UI; solo-parity test spies on timers and require.cache | closed |
| T-60-49 | Tampering | user's code branch | medium | mitigate | Push happens only when the user clicks Push; tests assert the remote main is unchanged otherwise | closed |
| T-60-50 | Elevation of privilege | pollSeconds from workspace settings | low | mitigate | Setting is application-scoped so a repository's .vscode/settings.json cannot make clients hammer the remote; scheduler clamps 5..3600 | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-60-01 | T-60-09 | The secret walker costs some CPU; it has an explicit stack and a depth cap of 64, and inputs are bounded by the 16 KB event limit and a small team.json | Plan 60-02 threat model | 2026-10-31 |
| AR-60-02 | T-60-16 | A malicious remote can withhold events; a client cannot prevent this. Status shows offline or stale and Verify Team Log reports the head | Plan 60-03 threat model | 2026-10-31 |
| AR-60-03 | T-60-43 | Remote-derived text appears in output lines; only pattern-checked ids, paths, fixed reasons and validated names are printed, and 60-09 also redacts and flattens through `safeReason` | Plan 60-09 threat model | 2026-10-31 |

**Residual risks carried from summaries (not separate threats):**
- 60-02: a value of exactly public-key shape (43 chars) under `publicKey`, or signature shape (86 chars) under `sig`, is exempt from token patterns; the materialiser binds fingerprint to key, and a test locks the exemption to those keys and lengths.
- 60-02: `Bearer <word>` prose is refused on write (redactSecrets treats it as a secret); the user can reword.
- 60-06: the trust-pin anchor is only as strong as write control on the code branch (RESEARCH Pitfall 10) and on local global storage.
- 60-09: `AuditStore.persist` swallows write failures; mitigated by read-back confirmation in `teamSession.ts`. A store-level failure report is a follow-up.

**Advisories (non-blocking at ASVS L1; follow-up before work dispatch or spend phases):**
- A1 (T-60-27, T-60-44): the trust pin is stored under a directory keyed by the team id it protects, so a team.json whose `teamId` is changed maps to an empty directory and is re-pinned as first-seen. Only a changed genesis id or owner key under the same team id is refused. Exposure in Phase 60 is small (the swapped team is read-only on this machine, as device keys are per team), but it would not pass L2. Bind the pin to the project (workspace or remote) and ask the user to confirm a team change.
- A2 (T-60-26): `parseSnapshotFile` and `deserialiseState` have no production caller yet; `sync` and `verifyAll` always replay from genesis. Re-check when a snapshot fast path is wired.

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-11-01 | 61 (51 unique ids) | 61 (58 mitigate, 3 accept) | 0 | gsd-security-auditor (ASVS L1, block on high) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-11-01
