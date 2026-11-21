---
phase: 41-organization-policy-foundation-f1
plan: 03
subsystem: gate policy (root of trust for your organization's rules)
status: complete
tags: [enrolment, issuer-key, twelve-words, key-handover, issuer-tool, signed-shapes]
requires: [41-01 (org-enrolment and org-policy-layer purposes, verifyPolicyLayer, parsePolicyDocument, parseContacts, featureForSection, policyFixtures)]
provides:
  - enrolment.ts (ENROLMENT_FILE_EXTENSION, ORGANIZATION_RULES_FILE_EXTENSION, MAX_ENROLMENT_FILE_BYTES, ISSUER_WORDS_DOMAIN, ISSUER_WORD_COUNT, issuerWords, issuerWordsText, issuerFingerprintHex, ENROLMENT_REFUSALS, ORGANIZATION_LAYER_REFUSALS, verifyOrganizationLayer, readEnrolmentFile, buildOrganizationLayer, buildEnrolment, fileTextOf, ROTATION_DOMAIN, rotationSigningInput, classifyEnrolment, ISSUER_WORDS_MATCH, ROTATION_WORDS_LEAD, issuerWordsPrompt, issuerWordsQuestion, issuerDetailsLine, organizationEndedText, organizationEndingText, contactShown)
  - scripts/org-issuer.mjs (create-key, words, sign-layer, sign-enrolment, rotate)
  - src/test/helpers/enrolmentFixtures.ts (EXAMPLE_ORGANIZATION, organizationSections, enrolmentTextFor, rotationTextFor, rulesTextFor)
affects: [41-09, 41-14, 41-15]
tech-stack:
  added: []
  patterns: [size cap before parse, exact keys read as own properties, one key source per check, length-prefixed signing input under its own domain, builders read their own output back]
key-files:
  created:
    - src/domain/gate/enrolment.ts
    - scripts/org-issuer.mjs
    - src/test/gateEnrolment.test.ts
    - src/test/helpers/enrolmentFixtures.ts
    - scripts/test/orgIssuer.test.mjs
  modified: []
decisions:
  - "Times are epoch milliseconds (`now: number`), as verifyPolicyLayer takes them; readEnrolmentFile and verifyOrganizationLayer also take an optional lastValidAt (the clock marker) and pass it through, so turning the clock back never revives an expired file."
  - "verifyOrganizationLayer's lastIssuedAt is an ISO time or epoch milliseconds; one that cannot be read refuses the layer as older (fail closed). An older layer's `failure` is the BundleFailureReason 'replaced' (41-09 maps older to replaced)."
  - "readEnrolmentFile's deviceKey is this computer's public key as text or any object with publicKey (41-09 passes the device identity). The file is own-key when the issuer or the handover's previous key is this computer's."
  - "buildEnrolment's `rotation` option is the pinned key's signer: the builder signs the handover itself over rotationSigningInput, so no caller assembles a handover signature by hand."
  - "The builders cap lives (an enrolment file 1 to 90 days, a layer 1 to 366); the readers accept any later expiry, so 41-01's enrolmentFileFor (365 days) still reads."
  - "Extra refusals on the fail-closed side: an enrolment payload with v above 1 is needs-update (D-07), a handover to the same key is rotation-invalid, a key handed over from this computer's key is own-key."
  - "A refused enrolment whose first layer failed carries `layerReason` (the organization layer refusal) next to its own reason, for 41-09 and 41-14 to log."
  - "organizationSections() keeps org/Internal on this computer ('local-only') by default, the one visible sign that your organization's layer is in force (41-14's test reads it)."
  - "The tool loads dist/ with createRequire inside a try (the build-env-pack.mjs pattern) instead of a dynamic import(); it has no static import outside node:. --out must end with the file's extension (usage error otherwise). rotate takes the new key's passphrase from NEAR_ORG_ISSUER_NEW_PASSPHRASE or --new-passphrase-file, else the same passphrase."
metrics:
  duration: ~70 min
  completed: 2026-11-20
actuals:
  tokens: 24062
  tasks: 3
  commits: 4
plan_head_before: ce786119bcb5b7bd1016ed5ae49029d277c58bda
plan_head_after: 6628fd1048fa93529c4877aa7472543fd0ca085a
---

# Phase 41 Plan 03: Enrolment file, twelve words, issuer tooling Summary

A computer learns your organization's key only from a signed `.near-org-enrolment` file (64 KiB cap before parsing, signed by the key it names, carrying the first rules). The key reads aloud as twelve words over `near-ai/org-issuer/v1`. Every later rules file is checked against that one key and is never older than the last one accepted. A key handover needs the pinned key's signature under its own domain and a higher serial. An offline, dependency-free tool makes a passphrase-encrypted key file and every file the extension reads.

## What was built

- **enrolment.ts** (pure: `node:crypto` and `src/domain` only, no clock, no I/O; 611 lines):
  - Twelve words: sha256(`near-ai/org-issuer/v1` NUL, 4-byte length, raw key), the first 132 bits as twelve 11-bit indices into SAFETY_WORDS (imported, not edited). `issuerFingerprintHex` gives sha256 of the raw key in groups of four.
  - `verifyOrganizationLayer(file, { issuerPublicKey, now, lastIssuedAt?, lastValidAt? })`: 1 MiB cap before parsing, then 41-01's `verifyPolicyLayer` with a key source that knows only `issuerPublicKey`, then the order check. It returns `{ ok, document, hash, issuedAt, expiresAt, renewDue }` or `{ reason, message, failure }`.
  - `readEnrolmentFile(file, { now, deviceKey?, lastValidAt? })` checks in this order: 64 KiB cap, exact payload shape, signature by the named issuer only, signedAt equal to issuedAt, handover signature, own key, clock, expiry, then the first layer through verifyOrganizationLayer. It returns `{ ok, enrolment, layer, words, fingerprintHex }` or a refusal. It never throws.
  - `buildOrganizationLayer` writes the envelope itself and refuses envelope keys and unknown sections. `requires` is the sorted features of the sections present, and the document must pass parsePolicyDocument.
  - `buildEnrolment` refuses a file over 64 KiB with the D-56 sentence and reads its own output back.
  - `rotationSigningInput` (domain `near-ai/org-issuer-rotation/v1`, length-prefixed fields: new key, previous key, serial, issuedAt) and `classifyEnrolment` (enrol, same-key, rotate, older-file, other-organization).
  - Closed refusal records and the modal and expiry texts that 41-14 shows.
- **org-issuer.mjs**:
  - `create-key` generates an Ed25519 key, exports it as PKCS#8 PEM with `cipher: 'aes-256-cbc'` and the passphrase, and writes it with flag `wx` and mode 0600.
  - `words`, `sign-layer`, `sign-enrolment` and `rotate`. Every output is written once with `wx`, read back from disk with the extension's reader, and removed only if this same run wrote it wrong.
  - The passphrase comes from the environment or a file, has at least 12 characters, and is never an argument or output. Exit codes: 0 done, 1 refusal (one sentence), 2 usage.
- **enrolmentFixtures.ts**: real-builder fixtures for 41-09 and 41-14. Example Organization, Security desk, security@example.org.

## Constants for 41-15 (SECURITY.md)

`ISSUER_WORDS_DOMAIN` = `near-ai/org-issuer/v1`; `ROTATION_DOMAIN` = `near-ai/org-issuer-rotation/v1`; `ISSUER_WORDS_MATCH` = "The twelve words match"; `issuerWordsPrompt(words)` = "Ask your organization's security contact to read their twelve words. Compare them with these: " plus the words; `ENROLMENT_FILE_EXTENSION` = `.near-org-enrolment`; `MAX_ENROLMENT_FILE_BYTES` = 65536 (64 KiB).

## Tests

- gateEnrolment.test.ts has 8 tests:
  - three from Task 1: the tracer, the twelve words (independent BigInt computation plus a pinned list for the key of 32 bytes of 0x01), and unknown-key;
  - five from Task 2: a table of 21 broken enrolment files plus 6 allowed cases, a table of 14 broken layers plus 5 allowed cases, the handover (rotate, older-file, other-organization, same-key, enrol, forged, replayed serial, moved time, to itself, from this computer's key), plain sentences, and the modal words.
- orgIssuer.test.mjs has 7 tests: key file, words, enrolment, rules update, rotation, six refusals that write nothing (wrong passphrase, unknown section, envelope key, wrong shape, first rules over 64 KiB, missing file), and no secret on screen.
- Failing on the base first:
  - Task 1 tests on the base: tsc failed, because `../domain/gate/enrolment` does not exist.
  - Task 2 tests on the Task 1 code: tsc failed on 11 missing names (classifyEnrolment, rotationSigningInput, ROTATION_DOMAIN, the texts).
  - orgIssuer.test.mjs before the script existed: 7 of 7 failed.
- Mutation check: with the handover signature check removed in the compiled module, the handover test fails (then restored).
- Final capped, locked run: orgIssuer, every `gate*.test.js`, teamSignedPayload, teamBoundaries, replicaBoundaries and replicaSafetyCode gave 996 tests, 996 pass, 0 fail. `npm run lint` exits 0. `node scripts/secret-scan.mjs --range ce786119..HEAD` is clean.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 3 - Blocking] Refusal records landed with Task 1**
- verifyOrganizationLayer and readEnrolmentFile return reasons from ENROLMENT_REFUSALS and ORGANIZATION_LAYER_REFUSALS, so both records shipped in the Task 1 commit (ea871ca2). Task 2 added the table tests and the plain-sentence test for them, plus the handover, classify and texts.

**2. [Rule 1 - Copy rule] An em-dash character in a test**
- The plain-sentence test checked for the em-dash by writing the character itself. Commit e6a92343 changes it to the backslash-u-2014 escape. It also builds the "never NEAR organization" check from parts.

### Choices taken on defaults
These are listed in the frontmatter `decisions`. The owner accepted every 41-CONTEXT default. No checkpoint was reached.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. Tests cover T-41-30 to T-41-35:
- T-41-30: twelve words over their own domain, pinned.
- T-41-31: own-key and unknown-key.
- T-41-32: older against lastIssuedAt.
- T-41-33: forged, replayed and moved handovers.
- T-41-34: caps before parsing at 64 KiB and 1 MiB, and the `__proto__` key.
- T-41-35: encrypted PKCS#8 that will not open without the passphrase, mode 0600, and no "PRIVATE KEY" or passphrase in any output.

No key material is committed: tests make keys and passphrases at run time, and the PEM header is matched as `-{5}BEGIN ENCRYPTED PRIVATE KEY-{5}`.

## Notes for later plans

- 41-09: `classifyEnrolment(read, { publicKey, serial })`. An `org-policy-layer` file goes through `verifyOrganizationLayer(text, { issuerPublicKey: pin.publicKey, now, lastIssuedAt: pin.lastIssuedAt, lastValidAt })`. A failure's `failure` field is the BundleFailureReason to build the failed state from ('replaced' for older).
- 41-14: `enrolmentTextFor(issuerKey())` gives Example Organization, whose layer routes org/Internal to local-only. `rotationTextFor(old, new)` gives serial 2. `rulesTextFor(key, sections)` gives a rules update.

## Self-Check: PASSED

- Files: all 5 created files are present in the worktree.
- Commits: ea871ca2, 4b9614b1, e6a92343, 6628fd10 are ancestors of HEAD on feat/phase-41-03-enrolment.
