---
phase: 25-cybersecurity-harness-with-offensive-and-defensive-scanning
plan: 06
subsystem: security
tags: [cybersecurity, offensive, verdicts, sarif, exploit, sandbox, access-proof]

requires:
  - phase: 25-03
    provides: "the vulnerable/patched fixture pair and startTarget; CyberHttpProbe's capture shape and fenceUntrusted discipline"
  - phase: 25-04
    provides: "sandbox tiers and verifyCleanup, postExploitAllowed's read-only allowlist, CyberExploitTool/CyberPostExploitTool"
  - phase: 25-05
    provides: "CyberLedgerStore/CyberEvidenceStore, startCyberRun's four-role engine, the critic"

provides:
  - "cyberVerdicts.ts: VERDICT_LANGUAGE for all four verdicts, requiresReason, verdictToSarifLevel, renderVerdict that refuses a failure verdict without a reason"
  - "cyberOffensive.ts: runOffensiveScan (fingerprint -> exploit -> access check -> read-only proof -> cleanup), persistFindings, verdictLinesFor"
  - "CyberFingerprintProbe: title, Server, X-Powered-By, framework hints, and exploit-shaped hints"

affects: [25-07, 25-08]

actuals:
  tokens: 18400
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "One rendering function per verdict, and the failure verdicts are refused without a reason rather than rendered with an empty slot"
    - "The exploit runs only through the sandbox; a disabled tier or a failed sandbox start is could_not_determine, never a host execution"
    - "The access proof is captured inside the open session and hashed, so the finding's evidenceHash points at real bytes"
---

# Plan 25-06 — the offensive path

## What landed

| Commit | Content |
|---|---|
| (commit 1) | `src/domain/cyberVerdicts.ts` + `cyberVerdicts.test.ts` |
| (commit 2) | `CyberFingerprintProbe`, `src/services/cyberOffensive.ts` + `cyberOffensive.test.ts` |

## Requirements

- **CYBER-08** — the vulnerable fixture reaches `verified_access`: the exploit runs in the sandbox, its output matches the expected proof, the read-only access proof is captured with a timestamp and hashed, and `cleanup.sandbox === 'verified'` with no leftover recorded files.
- **CYBER-09** — every non-access outcome is one of the four verdicts and carries its reason. `exploit_failed` covers "ran and mismatched" and "exited non-zero"; `could_not_determine` covers a disabled tier, a failed sandbox start, and an out-of-scope target. `renderVerdict` **throws** rather than render `exploit_failed — ` with an empty slot.
- **D-23** — `exploitPath` is recorded on the result and in the ledger entry's arguments, so the report can say whether a known CVE or a custom PoC was used. The known-CVE path also carries its `cve`.
- **D-11** — the post-exploitation commands are restricted to 25-04's allowlist, and `result.commands` lists every one that ran for the report.
- **D-10** — cleanup is verified both ways: `sandbox.stop()` plus `verifyCleanup` over the recorded files and credentials, with the outcome written as its own ledger entry.

## Decisions worth recording

**A disabled tier is a verdict, not an error.** The plan's prohibition says the exploit path must never skip the sandbox, so `sandbox.tier === 'disabled'` produces `could_not_determine` naming the tier's reason and returns before any executor is touched. The test asserts the fake sandbox recorded zero executions.

**The access proof is captured before `stop()`.** The proof commands run while the session is still open, then the proof text is hashed. If they ran after `stop()` the blob would be a hash of an error message, and the finding's evidence would prove nothing.

**The exploit's stdout blob stays verbatim; the finding text is redacted.** That is deliberate: the stored blob is the evidence of record (D-27's discipline), while `evidenceExcerpt` and every ledger `result` field go through `redactSecrets`. The test feeds a payload that prints the fixture's seeded key and asserts the key is absent from the proof blob and from the finding text.

## Deviations from the plan

**1. [Rule 1 — bug] The probe inventory test in `cyberDefensive.test.ts` needed updating for the new probe.**
Adding `CyberFingerprintProbe` makes `cyberProbes()` return nine tools; the 25-03 test asserted exactly eight. Its assertion is now nine with the new name in the list — the change is a count, not a weakening.

**2. [Rule 2 — missing critical functionality] `runOffensiveScan` takes an injectable `execute`.**
The plan's key_links said the service composes `CyberExploitTool`; it does, through `defaultExecute` calling `sandbox.exec`. The optional `execute` seam exists so the test can script outputs per command without a real `node poc.js`, which keeps the suite fast and offline.

**3. [Rule 1 — bug] The verdict summary test compared a rebuilt list against itself.**
The first version of the last `cyberVerdicts.test.ts` case asserted `verdictSummary(...)` equals a list built with a different `evidence` substitution, so it could never fail meaningfully. It now asserts the specific lines and the no-"clean" property.

## Verification

| Gate | Command | Result |
|---|---|---|
| Lint / typecheck | `npm run lint` | exit 0 |
| Plan tests | `node --test dist/test/cyberVerdicts.test.js dist/test/cyberOffensive.test.js` | 14 pass, 0 fail |
| Full suite | `npm run compile && node --test dist/test/*.test.js` | 729 tests, 721 pass, 0 fail, 8 skipped |

Acceptance greps:

| Criterion | Required | Actual |
|---|---|---|
| `exploitPath` in `cyberOffensive.ts` | ≥ 2 | 2 |
| `assertCleanedUp`/`verifyCleanup` | ≥ 1 | 2 |
| `untrusted: true` in `cyberProbes.ts` | ≥ 8 | 9 |
| all four verdict strings in `cyberVerdicts.ts` | present | present |
| `from 'vscode'` in the two new modules | none | none |

## Issues encountered

- `npm run compile` is required before a full run; `scripts/vendor-libs.mjs` vendors `vendor/pdfjs`, without which eight document/graphics tests fail. Worth repeating in 25-08's release checklist.

## Next phase readiness

- **For 25-07 (panel and exports):** `renderVerdict(finding)` is the one line a report or SARIF result should carry; `verdictToSarifLevel(verdict)` maps straight to the SARIF `level` field. `runOffensiveScan`'s `cleanup` object is what the run record's cleanup section should show, and `persistFindings` puts the findings into the chain so `replayRun` (25-05) returns them.
- **For 25-07 (offensive UI):** the service needs the panel to supply `SandboxAccess` from the engagement's resolved tier, and `inScope` from the same scope check the grant uses. `exploitPath` is the string to display beside a finding so a reader knows a CVE or a custom PoC was used.
- **Known gap for 25-07:** `runOffensiveScan` is a single planned exploit, not a loop. A full offensive run that tries several candidates is the panel's job to sequence (one `runOffensiveScan` per candidate, sharing the engagement's budget).

## Self-check: PASSED

Both plan files pass (14/14), `npm run lint` exits 0, the full suite is 721 pass / 0 fail with 8 pre-existing skips, every acceptance grep meets its threshold, no dependency was added, and neither new module imports `vscode`.
