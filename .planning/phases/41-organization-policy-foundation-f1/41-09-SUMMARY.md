---
phase: 41-organization-policy-foundation-f1
plan: 09
subsystem: gate policy (your organization's layer on disk, the layered load)
status: complete
tags: [policy, organization-layer, pin, enrolment, layered-load, bundle-v2, apply, reset, crash-recovery]
requires: [41-01 (verifyPolicyLayer, parsePolicyDocument, documentFromBundle, bundleViewOf, renewalPayload, migrateLocalHosts, policy events), 41-02 (composeLayers, wideningOf, widerThanOrganizationText), 41-03 (readEnrolmentFile, verifyOrganizationLayer, classifyEnrolment, organizationEndedText, contactShown, enrolment fixtures)]
provides:
  - organizationStore.ts (ORGANIZATION_DIR_NAME, ORGANIZATION_LAYER_FILE, ENROLMENT_RECORD_FILE, ORGANIZATION_ISSUER_SECRET, OrganizationPin, PendingOrganizationPin, OrganizationPinRead, readOrganizationPin, OrganizationStore, OrganizationStoreError, OrganizationLoad, OrganizationValid, OrganizationFailed, OrganizationEvent, OrganizationAcceptResult, OrganizationFilePreview, previewOrganizationFile, loadLayeredPolicy, recompose, LayeredPolicy, PolicyLayersView, migrationNoticeText, setOrganizationWriteProbe, NOT_ENROLLED_TEXT, DAMAGED_PIN_TEXT, WORDS_NOT_CONFIRMED_TEXT)
  - bundleStore.ts (BundleResult.stored, loadPersonalLayer, parsePolicyDraft, OwnedDraftFields, DRAFT_UPDATE_TEXT, ApplyOrganizationLayer, ApplyPolicyDraftInput; v2 reader in verifyDisk and install; renewal of the stored payload)
  - host.ts (GateHost.acceptOrganizationFile, policyLayers, recordPolicyEvent; begin, reset and applyPolicyDraft through the layered load)
  - installEvidence.ts (ORGANIZATION_RULES_FOLDER; the organization folder counts as evidence)
affects: [41-13 (policyLayers for the trust line and decideRoute), 41-14 (Add Your Organization's Rules command, previewOrganizationFile, notices, policy editor wiring), 41-15 (SECURITY.md)]
tech-stack:
  added: []
  patterns: [pending then commit in SecretStorage with read-back, a probe that stands for a crash, one key source per layer, organization failure decides first, the stored payload is signed and never the view]
key-files:
  created:
    - src/gate/organizationStore.ts
    - src/test/gateOrganizationStore.test.ts
  modified:
    - src/gate/bundleStore.ts
    - src/gate/host.ts
    - src/gate/installEvidence.ts
    - src/test/gateBundleStore.test.ts
decisions:
  - "The pin is stored as JSON under nearAi.gate.organizationIssuer: { v: 1, publicKey, serial, lastIssuedAt, layerHash, enrolledAt, pending? }. A pending first enrolment is stored alone as { v: 1, pending: { kind: 'enrol', ... } } and reads as not enrolled. Any other shape is `damaged` and fails closed; a new confirmed enrolment may replace it."
  - "setOrganizationWriteProbe: a probe that throws stands for the process ending at that step, so nothing after it runs, not even the clean-up. Every other failure puts back the old files and the old pin. This is what lets one probe test both 'a first enrolment crash is not enrolled' and 'an update crash rolls forward'."
  - "Roll forward at load (D-57): a committed pin with a pending update or rotate whose hash matches the layer file on disk, and which verifies against the pending key, is committed under bundle.lock and reported as policy.organization-updated. A newer layer signed by the pinned key found on disk is also committed and reported (D-14: newer is accepted)."
  - "A same-key enrolment file is an update of its layer: newer is applied, the same hash is `same` (nothing written), older or the same time with another hash is refused older. A handover's first layer may not be older than the rules in use."
  - "The verified enrolment envelope is kept as enrolment.json and verified against the pinned key (or a pending handover's key) every time your organization's name and contacts are read, so a name never comes from a file the pin did not sign. Contacts come from the layer's onboarding.contacts first, then that record."
  - "Failed sentences: expired is organizationEndedText(YYYY-MM-DD, contact); needs-update and clock-behind use the refusal's own sentence; every other failure is the refusal sentence without its general 'Ask your organization's security contact ...' ending, plus 'Ask {contact} for the rules file, then run NEAR AI: Add Your Organization's Rules.' A missing layer file and a damaged pin have their own sentences. None carries the ownPolicy mark."
  - "policy.organization-refused is recorded for a refused file through accept and, once at start, for a load that refused a file on disk (unknown key, bad signature, replaced, malformed and so on); not for a missing file, an expiry, a clock or update reason, or declining the twelve words."
  - "The composed hash is bundleHash({ organization, personal }). Edit Policy writes that hash as the draft's base; host.applyPolicyDraft maps it to the personal layer's hash it was composed from before the store's stale check."
  - "Apply is refused while your organization's layer fails (D-21: nothing is checked against a layer that cannot be read)."
  - "A v2 personal layer that fails for its content (not signer-mismatch, clock-behind or expired) while its signature verifies under this install's key history carries ownPolicy, as the v1 reader marks its own content failures."
  - "A v2 draft refusal caused by an unknown section or a newer feature ends with DRAFT_UPDATE_TEXT ('If a newer version of NEAR AI wrote this draft, update the extension first.'); v1 drafts keep today's messages word for word."
  - "migrationNoticeText: undefined for no changes; 'with the same effect as before.' when changes exist and none lost a level; otherwise the plan's sentence naming at most five hosts."
metrics:
  duration: ~75 min
  completed: 2026-11-20
actuals:
  tokens: 34777
  tasks: 3
  commits: 4
plan_head_before: 97a9bd229f899f1e0b8065c20260c3a57e76f5f4
plan_head_after: b5a11cf528d2fda1018617e2cffda885e536fd01
---

# Phase 41 Plan 09: Organization store and host Summary

Your organization's rules now reach this computer only through a signed file. A first enrolment or a key handover also needs the twelve words confirmed. The issuer key and the last accepted issuedAt are pinned in SecretStorage with a pending-then-commit order that survives a crash. Every decision reads the personal layer narrowed by your organization's layer. Apply writes a v2 personal layer and refuses an edit that widens past your organization. Reset under your organization's rules re-signs only the personal layer.

## What was built

- **organizationStore.ts** (897 lines, Node I/O only):
  - The pin. `readOrganizationPin` reads it as absent, pending-enrol, pinned or damaged. Every write is read back, as clockMarker.ts does.
  - `OrganizationStore.accept(text, { wordsConfirmed }, nowMs)` works under bundle.lock. The file's purpose decides its kind; the text is capped at 1 MiB before it is parsed. A first enrolment and a rotate need the words. The steps run in order: pin pending, probe `pin-pending`; the layer file (and the enrolment record for an enrolment file) written, with the old files kept as `.replaced-<ms>`, probe `layer-written`; read-back and verify; pin committed, probe `pin-committed`. It returns `policy.enrolled` or `policy.organization-updated` with the issuedAt and the first 16 hex characters of the fingerprint. Contacts are never put in the detail.
  - `OrganizationStore.load(effective)` never throws. It covers every state: none, valid with endsSoon, roll forward, and failed with your organization's sentence.
  - `previewOrganizationFile` reads a file the same way, writes nothing and never throws.
  - `recompose` and `loadLayeredPolicy` build `PolicyLayersView`: organization, personal (document, hash, stored), effective, ignored, migration, failedLayer and expiry.
  - `migrationNoticeText`.
- **bundleStore.ts** (580 lines):
  - `verifyDisk` and `install` route a payload with bundleVersion 2 through `verifyPolicyLayer` (purpose policy-bundle, this install's key history) and turn it into today's valid state with `bundleViewOf`. Every other payload keeps `verifyBundleEnvelope`, with its sentences and the ownPolicy mark unchanged. The `replaced` marker rule applies to both.
  - `BundleResult.stored` and `loadPersonalLayer`.
  - `tryRenew` signs `renewalPayload(stored, now)`, never the view.
  - `parsePolicyDraft`.
  - `applyPolicyDraft(…, { baseHash, organization? })` runs the `wideningOf` check and signs a v2 personal layer. `requires` lists layers@1, labels@1, agents@1 and the feature of each section present, sorted. When your organization's layer is in force, `parent` holds `{ hash, issuer fingerprint }`. Apply refuses any rewrite that would change the bundle view.
  - A fresh install and Reset still write the v1 starting rules.
- **host.ts** (910 lines):
  - `begin` uses `loadLayeredPolicy` and records the personal event, then any organization events once.
  - New methods: `policyLayers()`, `recordPolicyEvent(event, detail?)` and `acceptOrganizationFile(text, confirmation)`. A refused file is recorded as policy.organization-refused, then the error is rethrown.
  - `reset` and `applyPolicyDraft` recompose. Reset records `policy.reset-personal` under your organization's layer.
  - `bundleState()` returns `layers.expiry` once the effective policy ends.
  - `resetPolicyToDefaults` is still called only from bundleStore and host.
- **installEvidence.ts**: an `organization` folder with any entry, or one that cannot be read, counts as evidence. `ORGANIZATION_RULES_FOLDER` duplicates the name, and a test keeps the two equal.

## Tests

- gateOrganizationStore.test.ts: 21 tests. Task 1 added 4, Task 2 added 12 (including the extra D-57 handover-crash test), Task 3 added 4, plus the preview test.
- gateBundleStore.test.ts: 6 new tests (v2 Apply, v1/v2 draft refusals, v2 renewal, D-62 renewal, the organization folder as evidence, the v2 reader and replaced rule). The existing tests pass unchanged.
- Red first:
  - Task 1: the base (97a9bd22) has no `src/gate/organizationStore.ts` and no `acceptOrganizationFile`, so the test file does not compile there.
  - Task 2: the table passed on the Task 1 code, because the load states landed with the tracer. Two mutation checks on the compiled module showed what the table catches. With the organization-failed branch disabled (falling back to the personal layer), 3 tests failed: D-15, replaced, expired. Disabling the roll forward was caught by no test at first: the update crash is also covered by the "newer file signed by the pin" rule. I added the D-57 handover-crash test, which then failed under that mutation.
  - Task 3: on the Task 2 code, 9 of the 10 new tests failed (compile error on `ORGANIZATION_RULES_FOLDER`, then behaviour). The D-62 renewal test passes on the Task 2 code because renewal moved into Task 1 (see Deviations). On the base, `tryRenew` re-signed the view, so its compartments stay `{}` and that test fails there.
- Final runs (capped, locked):
  - The plan's Task 3 set (gateOrganizationStore, gateBundleStore, gateBundleTrust, gateLabelCommands, gateCommands, gateHostStart, gateActivation): 130/130. Task 2's host set (gateHostClock, gateHostLogs added): 32/32.
  - Gate set (`gate*.test.js`, teamSignedPayload, teamBoundaries, replicaBoundaries, `staffObs*.test.js`): 1162 tests, 1161 pass, 1 fail. The one failure is the known gateLayers "D-19: every key a section parser names is accounted for", which fails on the base and is being fixed on another branch. architecture.test and copyLint.test do not exist on this base yet (41-11 and 41-12).
  - `npm run lint` exits 0. `node scripts/secret-scan.mjs --range 97a9bd22..HEAD` is clean.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 3 - Blocking] Renewal of the stored payload moved from Task 3 into Task 1**
- Found during: Task 1. Once verifyDisk reads v2 personal layers, renewing from the view (as the base did) would rewrite a v2 layer as v1 and drop its sections. So `tryRenew` signs `renewalPayload(stored, now)` from the tracer commit on (b16bc817). The Task 3 renewal tests (v2 stays v2, D-62) still fail on the base.

**2. [Rule 1 - Copy] One named contact per failed sentence**
- Found during: Task 3. Appending "Ask {contact} for the rules file, ..." to an ORGANIZATION_LAYER_REFUSALS sentence that already ends "Ask your organization's security contact for a new rules file." asked twice. `withoutGeneralAsk` drops the general ending before the named one is added, and a test counts one "Ask". Commit 7ca95dcc.

**3. [Rule 2 - Correctness] Apply refused while your organization's layer fails**
- The plan passes the organization layer from `this.layers` to Apply. When that layer has failed, no widening check is possible, so the host refuses with "Nothing was changed: your policy cannot be trusted right now, so it cannot be edited." plus your organization's sentence. Tested.

**4. [Rule 2 - Correctness] Composed hash mapped to the personal hash for Apply**
- Edit Policy writes `state.hash` (the composed hash under your organization's layer) as the draft's base. Without mapping, every Apply under your organization would be stale.

**5. Test-side (no production impact)**
- The world helper flushes every host before removing its temp folder (a second host's log writes raced the cleanup).
- The "layer file with no pin" scenario starts the personal policy first. A stray organization file on a first start is now evidence of an earlier install, by design (D-13).
- A regex `\b` and an em-dash written through a shell string were corrected to escapes.

### Choices taken on defaults

Listed in the frontmatter `decisions`. No checkpoint was reached; the owner accepted every 41-CONTEXT default.

### Not done / blocked

- A shell command whose embedded test text contained an `rm(` call was refused by a safety check. Nothing ran. I made the same edits with the Edit tool, and the test that needed to break the layer writes bad JSON over it instead of removing it.

## Notes for later plans

- **41-14:**
  - `previewOrganizationFile(globalStorageDir, secrets, text, nowMs)` gives the kind, name, contacts, words and fingerprintHex for the modal. Then call `host.acceptOrganizationFile(text, { wordsConfirmed: true })`. The second call re-reads everything under the lock, so a file changed between preview and accept is judged again.
  - `host.policyLayers()` gives the ignored list (`ignoredSettingsNotice`) and the migration changes (`migrationNoticeText`). Record the notice with `host.recordPolicyEvent('policy.migrated')`.
  - `organization.endsSoon` drives the 30-day notice through `organizationEndingText`.
  - Edit Policy under your organization still writes the effective v1 view. Applying it as-is makes the personal layer the narrowed copy, which is never wider. Consider a personal-layer draft.
- **41-13:** `PolicyLayersView.effective` is the composed PolicyDocument. `BundleState.valid.bundle` stays today's view.
- **Gate set at the wave 3 merge:** host.ts is 910 lines (41-12 freezes above 1,200). organizationStore.ts is 897 lines (above the 800-line warning, under the 1,200 limit for a new file).

## Known Stubs

None. `ADD_RULES_COMMAND` names the command 41-14 registers ("NEAR AI: Add Your Organization's Rules"); the sentences use that name now.

## Threat Flags

None beyond the plan's register. Each threat has tests:
- T-41-90: the older-file accept refusal and the rolled-back file on disk.
- T-41-91: no personal fallback, checked by the mutation above.
- T-41-92: this computer's key refused unknown-key, on disk and through accept.
- T-41-93: widening refused with the key named.
- T-41-94: the enrol, update and handover crash tests.
- T-41-95: expiry with date and contact, endsSoon, and the clock set back.
- T-41-96: enrolled, organization-updated, organization-refused and reset-personal in the install log.
- T-41-SC: no package was installed.

## Self-Check: PASSED

- Files: src/gate/organizationStore.ts, src/test/gateOrganizationStore.test.ts, src/gate/bundleStore.ts, src/gate/host.ts, src/gate/installEvidence.ts and src/test/gateBundleStore.test.ts exist in the worktree.
- Commits: b16bc817, af104aa7, 7ca95dcc and b5a11cf5 are ancestors of HEAD on feat/phase-41-09-organization-store.
