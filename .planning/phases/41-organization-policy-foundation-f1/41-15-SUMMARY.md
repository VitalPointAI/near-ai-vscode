---
phase: 41-organization-policy-foundation-f1
plan: 15
subsystem: docs, copy sweep, policy page, baselines, requirements (phase close-out)
status: complete
tags: [docs, security-md, copy-sweep, policy-page, edit-my-rules, trust-line, export-control, baselines, requirements, close-out]
requires: [41-01, 41-02, 41-03, 41-04, 41-05, 41-06, 41-07, 41-08, 41-09, 41-10, 41-11, 41-12, 41-13, 41-14]
provides:
  - SECURITY.md Phase 41 blocks (Your organization's rules on this computer; Layers, the policy page and versions; Where AI may run; Export-controlled content; The trust line), private-means-verified words, the outbound check's retired routing role, six Known limitations rows
  - README policy bullet and CHANGELOG "### Your organization's rules" under Unreleased
  - policy page actions Edit my rules and Apply my draft (PAGE_ACTIONS, PolicyEditorDeps.editOwn/hasDraft/applyDraft, PolicyEditorHooks.ownRules)
  - POLICY_DRAFT_SHAPE_TEXT (bundleStore.ts), NO_SIGNING_KEY_TEXT (labelMapStore.ts)
  - gateDocs.test.ts Phase 41 tests (15 new, 52 in all)
  - FND-01 to FND-09 ticked and traced
affects: [the Phase 41 integration PR, docs site build (docs-site/content/security/trust-model.md)]
tech-stack:
  added: []
  patterns: [docs checked word for word against the constant that owns each sentence, page actions offered by the host and checked again in the one message switch, prose counters that skip inline code]
key-files:
  created:
    - .planning/phases/41-organization-policy-foundation-f1/41-15-SUMMARY.md
  modified:
    - SECURITY.md
    - README.md
    - CHANGELOG.md
    - docs-site/content/security/trust-model.md
    - .planning/REQUIREMENTS.md
    - media/policy/policy.js
    - media/chat/chat.css
    - src/services/policyEditor.ts
    - src/services/policyEditorWiring.ts
    - src/services/gateCommands.ts
    - src/domain/gate/bundle.ts
    - src/domain/gate/routing.ts
    - src/gate/bundleStore.ts
    - src/gate/labelMapStore.ts
    - src/agent/gateAdapter.ts
    - src/agent/gateLabels.ts
    - src/test/gateDocs.test.ts
    - src/test/policyEditor.test.ts
    - src/test/responsivePanels.test.ts
    - src/test/gateBundle.test.ts
    - src/test/gateBundleStore.test.ts
    - src/test/gateLabelStore.test.ts
    - src/test/gateLabelCommands.test.ts
    - src/test/gateCommands.test.ts
    - src/test/gateMcpCeiling.test.ts
    - src/test/gateRouting.test.ts
    - src/test/gateEnrolCommand.test.ts
decisions:
  - "The policy page offers Edit my rules (runs Edit Policy on your own rules) and, while a draft waits, Apply my draft (runs Apply Policy Draft, which shows it as a proposal). Both only while your own rules can be read, this device holds the signing key and no Apply or save runs; each message is checked again in the switch. Apply my draft was added beside Edit my rules so a draft whose notice was dismissed is not stranded."
  - "Swept sentences name the page and its button: a reset offer is 'Open NEAR AI: Policy and choose Reset my rules ... it resets your own rules only'; a change pointer is 'in NEAR AI: Policy ... Edit my rules'; a look pointer is 'open NEAR AI: Policy'. Needs-update sentences are unchanged (update the extension, no reset)."
  - "The draft's proposer shown on the page ('Asked by:') is now 'Edit my rules' instead of 'Edit Policy'."
  - "Docs say 'a later release' where the plan wrote Phase 45 or Phase 35: an existing gateDocs test forbids phase numbers in the routing section, Known limitations and the README bullet."
  - "The clean-text counters (compliance claim, bare team, provider before organization) read prose with inline code removed, so an administrator token such as `accredited-device` is not a claim; planted claims prove the counters still count."
  - "Both baselines were already tight at this base (41-13 and 41-14 re-recorded their own reductions); no baseline line was added or removed here."
  - "FND-01 to FND-09 are ticked on the gate set's evidence (every test file 41-VALIDATION.md names for them ran green); the single traceability row keeps its two columns and now reads complete."
metrics:
  duration: ~95 min
  completed: 2026-11-20
actuals:
  tokens: 30700
  tasks: 5
  commits: 6
plan_head_before: 680c0cd1d9498a773c1bcd5998c2bce22c396967
plan_head_after: 72df24abc3b66d82b17877d7086df72949e39397
---

# Phase 41 Plan 15: Close-out (copy sweep, docs, baselines, requirements) Summary

Every sentence that sent people to a command that left the palette now points to NEAR AI: Policy, and the page itself can start an edit of your own rules (Edit my rules) and apply a waiting draft (Apply my draft). SECURITY.md, README and CHANGELOG say what Phase 41 does in the code's own words, checked word for word by 15 new gateDocs tests. The chat trust badge wraps its three-part line. Both baselines are tight, and FND-01 to FND-09 are ticked.

## Base check (Task 1)

- All 18 files the plan names exist at 680c0cd1. `KNOWN_BUNDLE_FEATURES` in bundle.ts: 2. Unticked FND lines: 9. 41-14 contributes `nearAi.policy.open` titled "Policy" (NEAR AI: Policy).
- main had not moved (origin/main 1c15e9cc is an ancestor of the base), so nothing was merged; the orchestrator merges origin/main before its full run.
- Wave-merge gate set on the unchanged base: 1371 tests, 1371 pass.

## Tasks

| Task | Name | Commit | Main files |
|------|------|--------|------------|
| 1 | Tracer: your organization's rules on this computer, checked word for word | 7ecea129 | SECURITY.md, gateDocs.test.ts |
| (orchestrator 2) | Edit my rules and Apply my draft on the policy page | 6fa3c233 | policyEditor.ts, policy.js, policyEditorWiring.ts, gateCommands.ts, policyEditor.test.ts |
| 2 | Copy sweep to NEAR AI: Policy | 4ff80a22 | bundle.ts, routing.ts, bundleStore.ts, labelMapStore.ts, gateCommands.ts, gateAdapter.ts, gateLabels.ts, policyEditorWiring.ts, eight pinned tests, gateEnrolCommand.test.ts |
| 3 | The rest of SECURITY.md, README, CHANGELOG (and the docs site page) | 57f9ed62 | SECURITY.md, README.md, CHANGELOG.md, gateDocs.test.ts, docs-site/content/security/trust-model.md |
| (orchestrator 3) | Trust badge wraps at narrow widths | 58d469bf | media/chat/chat.css, responsivePanels.test.ts |
| 4 | Both baselines tight | (no commit: verification only) | none |
| 5 | Requirements ticked | 72df24ab | .planning/REQUIREMENTS.md |

## What changed

- **Copy sweep (D-44, D-21, S6).** RESET_FIX now reads "Open NEAR AI: Policy and choose Reset my rules to sign a fresh one; it resets your own rules only." The unknown-field sentence points to Show as stored. STALE_DRAFT_TEXT, the draft shape error (now `POLICY_DRAFT_SHAPE_TEXT`), NO_DRAFT_TEXT, editPolicyNotice, the three stored-view notes, NO_LABELS_WHILE_FAILED_TEXT, notYourClearanceText, FAILED_CLOSED_LABEL_TEXT, ADD_CLEARANCE_HINT, localHostPatternNotice, ROUTE_CHECK_FAILED_TEXT, both MCP ceiling sentences and the label map's no-key error (now `NO_SIGNING_KEY_TEXT`) all name the page. Two `attempt()` labels that reached a user as "NEAR AI could not set up Reset Policy to Defaults." now say "the policy reset" and "policy drafts". The acceptance grep is 0 (16 on main, 17 at the base). `wc -l src/agent/gateAdapter.ts` is 1400 before and after.
- **Page actions.** `PolicyEditorDeps` gains optional `editOwn`, `hasDraft` and `applyDraft`; the state message carries `pageActions`; the switch handles `edit-own` and `apply-draft` only when offered. gateCommands passes `ownRules` (the storage folder, `editPolicy`, `applyPolicyDraftCommand`). A test harness with no flow never asks for the signer, so the existing "other messages are ignored" test is unchanged.
- **Docs.** SECURITY.md: the five new four-level blocks; the policy bullets ("When it cannot be trusted", "Reading it", "Changing it", the clearance pointers, the MCP ceiling pointer) name the page and its buttons; "Which models are private" quotes the tee-only words whole; the outbound check's step 3 says it no longer decides where a request goes; six Known limitations rows, and the "signed by your own key" row now says your organization's rules narrow them. README's policy bullet names the enrol command, the twelve words, the page, Reset my rules, the Protected B change and export-controlled content. CHANGELOG Unreleased has "### Your organization's rules" above "### Fixes" (a paragraph and eight bold-led bullets), and its S6 bullet no longer names Show Policy.
- **Docs site.** `docs-site/content/security/trust-model.md` names the enrol command, the twelve words, NEAR AI: Policy, Reset my rules and the trust line. `policy.synced.md` is generated from SECURITY.md by the docs build (the orchestrator runs it).
- **Trust badge CSS.** `.trust-badge` gains `flex-wrap: wrap`, `max-width: 100%` and `text-align: left`; each part (`.trust-badge > span`) gets `min-width: 0` and `overflow-wrap: anywhere`. No clipping rule is used.

## Tests and red runs

- Task 1: the new gateDocs test failed on the unchanged SECURITY.md (38 tests, 37 pass, 1 fail), then passed.
- Page actions: on the base policyEditor.ts and policy.js the new tests do not compile (`editOwn`, `hasDraft`, `applyDraft` are not keys of PolicyEditorDeps); with the change, policyEditor 18 of 18.
- Task 2: the two D-44 gateDocs tests did not compile on the Task 1 code (no `POLICY_DRAFT_SHAPE_TEXT`, no `NO_SIGNING_KEY_TEXT`), and the base holds 17 user strings they reject. After the sweep, 30 pinned assertions failed until updated to the new words (each `equal` still an `equal`, each `match` still matching the same part; negative checks for "Reset Policy to Defaults" became checks for "Reset my rules", so they keep their teeth).
- Task 3: on the docs as Task 2 left them, gateDocs.test.js fails to load (the new headings are missing). After the docs: gateDocs 52 of 52, copyLint 28 of 28.
- Trust badge: the new responsivePanels test fails on the base CSS (no `flex-wrap`); one existing gateTrustBadge check caught `white-space: normal` as the colour word "white", so that rule was dropped rather than the check changed.
- gateDocs.test.ts went from 37 tests to 38 (Task 1), 40 (Task 2) and 52 (Task 3).

## Verification

All runs used the memory wrapper and the shared lock.

- Task 2 set (gateDocs, gateBundle, gateBundleStore, gateLabelStore, gateLabelCommands, gateCommands, gateMcpCeiling, gateRouting, gateLabels, gateEnrolCommand, policyEditor): 305 of 305. copyLint, architecture, gateRecordIds, gateDecideRoute: 79 of 79. Lint exit 0.
- Final gate set with `NEAR_AI_BASELINE_TIGHT=1` (every `gate*.test.js`, teamSignedPayload, teamBoundaries, replicaBoundaries, `staffObs*.test.js`, orgModes, policyEditor, providerEndpoint, architecture, copyLint, responsivePanels, pageScripts, scripts/test/orgIssuer.test.mjs): 1413 tests, 1413 pass, 0 fail, 0 skipped, about 14 s. `npm run lint` exit 0 in the same run.
- Both "the baseline is tight" tests pass in tight mode.
- `node scripts/secret-scan.mjs --range 680c0cd1..HEAD`: clean.
- Em-dash counts are the same as the base: SECURITY.md 0, README.md 1, CHANGELOG.md 3. The branch diff adds none.
- Not run here, as the orchestrator asked: the full `npm test` and e2e, which it runs once after merging origin/main.

## Baselines (Task 4)

Normal mode and `NEAR_AI_BASELINE_TIGHT=1` both pass at the base, with no stale line, count or frozen size. Earlier plans had already re-recorded what they removed: 41-13 the frozen sizes of agentSession.ts (2754 to 2708) and nearAiClient.ts (1861 to 1860), and 41-14 the package.json glossary count (42 to 40). 41-07's two domain/state leaks were removed before 41-12 recorded the baseline. Neither baseline file changed in this plan. Nothing came from main.

## Requirements (Task 5)

FND-01 to FND-09 are ticked. Each one's test files from the 41-VALIDATION.md table ran green in the final gate set, judged against the amended text: FND-02 by gateBundleV2 (the exportControl section parsed in report mode) and gateBundle and gateDocs (the starting rules' `local-only` entries for CGP, ITAR and EAR); FND-04 by gateAuthorizations (export-person and export-endpoint) and gateRecordIds and gateDecideRoute (`route.export-control` named ahead and never returned). The section and its two-column traceability table came from the planning PR; the row now reads complete. If the orchestrator's full run fails for one of them, untick that line.

## Deviations from Plan

### Changes the orchestrator asked for

1. **No full suite or e2e here.** Task 5's full `npm test` and e2e runs were left to the orchestrator; the FND ticks rest on the gate set.
2. **Edit my rules on the policy page** (41-14's flagged stuck state), plus **Apply my draft**. With Edit Policy and Apply Policy Draft off the palette, a draft whose notice was dismissed could not be applied from anywhere a person sees, so the page offers both. Both are covered by allowed-side and refused-side tests in policyEditor.test.ts.
3. **The trust badge wraps** (media/chat/chat.css), with a CSS test in responsivePanels.test.ts.
4. **The docs site** trust model page was updated.

### Auto-fixed issues

**1. [Rule 1 - Copy] User strings outside the plan's list named old commands**
- The `attempt()` labels in gateCommands.ts, and the draft's proposer `DRAFT_FROM` ('Edit Policy', shown on the page as "Asked by"), both reached a user. They are now 'the policy reset', 'policy drafts' and 'Edit my rules'. gateEnrolCommand.test.ts (outside files_modified) pins the proposer, so that one assertion now says 'Edit my rules'. Commit 4ff80a22.

**2. [Rule 3 - Test reach] Sentences with no constant**
- The draft shape error and the label map's no-key error were inline strings. They are now `POLICY_DRAFT_SHAPE_TEXT` and `NO_SIGNING_KEY_TEXT`, so gateDocs reads them from their owners. Commit 4ff80a22.

**3. [Rule 1 - Accuracy] Plan wording the code does not support**
- "Phase 45" and "Phase 35" became "a later release". An existing gateDocs test forbids phase numbers in these sections.
- "the outbound check keeps its secret and personal-data checks as label facts": the code keeps them as its own data-class checks. The docs say that, and that where a request may go is the route check's alone.
- The accredited-device rule is described as record-only unless your organization's rules turn on `requireAccreditedDevice`, because with that switch on the code refuses.
- Under the starting rules, export-marked content "stays on this computer". That is true only because the starting rules name no other host, so the docs keep the qualifier.

### Files outside files_modified

media/policy/policy.js, src/services/policyEditor.ts, src/services/policyEditorWiring.ts, src/test/policyEditor.test.ts, media/chat/chat.css, src/test/responsivePanels.test.ts, docs-site/content/security/trust-model.md and src/test/gateEnrolCommand.test.ts (one assertion). The orchestrator asked for the first seven. The eighth is deviation 1. No Phase 32 file, STATE.md, ROADMAP.md or state.json was touched.

## Phase 41 decisions taken on defaults (gathered from 41-01 to 41-15)

The owner accepted every 41-CONTEXT default. Each plan took these choices where the plan left a choice open:

- **41-01 contract:** FEATURE_ID_PATTERN not widened (the base accepts `@N`). `verifyPolicyLayer` takes a personal layer only under policy-bundle and an organization layer only under org-policy-layer, and a project layer has no signing purpose. `verifyAuthorization` uses the listed signers whenever `signers` is given, and selfSigned means this device's key. An empty endpoint maxLabel reaches nothing, `[::1]` is loopback, and a discovery network needs a gateway or a DNS suffix. Residency values are sorted region lists and unstated is refused. Contacts are sorted by topic then name. Registration needs registered, reference and endsOn, and `scope.projects` never takes `*`. An update reason with a valid minClient uses needsUpdateSentence(minClient). An authorization envelope with another `v` reads as update. issuedAt that differs from the signing time is signer-mismatch.
- **41-02 layers:** the effective document is parsed again. If the combination does not parse, your organization's sections apply whole and `personal layer` is listed. A wider subset value takes your organization's value. Parser defaults and equal values are not listed. Absent keys follow their rule (`weakest` keeps, `strictest` drops and lists, boolean-safe takes the safe value). exportControl.officials is organization-only for its regimes. people.organization without your organization's block is dropped and listed. Passports are organization-only except a narrower hosting. models directions are declared key by key, with the higher tier as the narrower one.
- **41-03 enrolment:** times are epoch ms, with an optional clock marker. An unreadable lastIssuedAt refuses as older. The builders cap lives (enrolment 1 to 90 days, layer 1 to 366). Extra fail-closed refusals: v above 1, a handover to itself, a handover from this computer's key. A refused enrolment carries layerReason. The issuer tool loads dist through createRequire, `--out` must end with the extension, and rotate reads a separate new passphrase.
- **41-04 labels:** meetClearance narrows below mapping chains and fails closed on an unreadable expiresAt. The shown words for CGP, ITAR and EAR live in labels.ts.
- **41-05 passports:** an empty models section stays `{ v: 1 }`. Matching uses no regular expression (no backtracking). The closed GPT rows are narrowed to `openai/gpt-4*` to `openai/gpt-9*` so gpt-oss keeps its own row. Report mode only.
- **41-06 modes:** Corporate is the default mode. The military and public-service words are best guesses with source notes. Settings only tighten. `temporary` can be 'no', and effectiveBehaviour returns enrolAtReport.
- **41-07 provider:** message types moved to src/domain/provider. EndpointFacts carries route, base URL and one boolean, and `endpointId` is never set yet.
- **41-08 editor:** page messages must name the shown proposal id. Stale is sticky. Apply or export can finish after the page closes. Changes are sorted in editor order. The exported notice names every contact, security first. exportControl reads as "Export-controlled work", and handling flags stay off the page.
- **41-09 store:** the pin is JSON in SecretStorage, written pending then committed. A crash probe stands for process death. A layer found newer on disk is rolled forward. A same-key enrolment is an update. The enrolment record is verified on every read. Failed sentences name one contact. Apply is refused while your organization's layer fails. The composed hash maps to the personal hash. A v2 own-content failure carries ownPolicy. A newer draft says to update the extension.
- **41-10 decision core:** allowedBy is always present with a policy. A policy-step refusal is the plain refuse object. An authorization record carries its label. Records are deduplicated. route.endpoint-unknown also applies at any-cloud when a label needs an authorization. The trust place never calls a remote host this computer. Vendor places carry their region.
- **41-11 copy lint:** sources are parsed with the TypeScript parser. Copy sources go beyond the plan's list. Names and model instructions are not copy. Plurals match, the longest phrase wins, and the brand prefix counts once.
- **41-12 architecture:** upward-import is decided by layer rank plus the domain rule. Seams cover gate and team only (the staff lines are baselined). The scale-presets rule catches namespace reads. A `require('vscode')` in a comment is still reported.
- **41-13 client:** routePolicy carries policyVersion. routePolicyFor fails closed on any failed layer and memoizes the verified authorizations for 60 s. The outbound preview uses the model's own client (local models stay allowed under tee-only). The floor is frozen and copied. A pin mismatch is route.endpoint-pin. The line draws only with all four strings, and its separators are aria-hidden. Versions are stamped on a copy.
- **41-14 commands:** Edit Policy drafts the personal layer as stored. Apply refuses a stale or invalid draft before proposing. With no page, the stored view opens and Apply refuses. A file over 1 MiB is refused before it is read. The ignored-settings notice is told once per distinct list. "Policy: ends soon" uses no warning colour. Add Your Organization's Rules and NEAR AI: Policy stay in the palette, and five commands keep their ids with `when: false`.
- **41-15 close-out:** the decisions in this file's frontmatter: Edit my rules plus Apply my draft, the swept wording, "a later release" for phase numbers, prose counters that skip inline code, and no baseline change needed.

## Known Stubs

None added. `teamRouteInputs` (41-13) and the project layer (41-02) remain wired nowhere by design. The docs say no project carries rules in this version.

## Threat Flags

None beyond the plan's register:
- T-41-150: record-only rules are described as recording, and sentences are imported and checked.
- T-41-151: the Known limitations row says to compare the words over a channel you trust.
- T-41-152: no baseline grew.
- T-41-153: every reset offer says it resets your own rules only, and the needs-update sentences keep "update the extension" with no reset, tested.
- T-41-154: the rule 7 counter is 0 on every new block, a planted claim is counted, and the text says nothing grants access yet.

The new page actions add no trust boundary. They run existing flows, and each page message is checked again on the host.

## Self-Check: PASSED

- Files: every modified file listed above is in `git diff --name-only 680c0cd1..HEAD`.
- Commits 7ecea129, 6fa3c233, 4ff80a22, 57f9ed62, 58d469bf and 72df24ab are ancestors of HEAD on feat/phase-41-15-close-out.
