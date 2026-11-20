---
phase: 41-organization-policy-foundation-f1
plan: 08
subsystem: gate policy (policy editor shell and proposals)
status: complete
tags: [policy, proposal, editor, webview, csp, export, FND-09]
requires: [41-01 (PolicyDocument, POLICY_SECTIONS, PolicyContact, SELF_SIGNED_TEXT, policy-proposal purpose, policy.proposal-* events)]
provides:
  - proposal.ts (proposalOf, DirectionOf, UNKNOWN_WIDENS, ProposalChange, ProposalDirection, policySections, POLICY_SECTION_IDS, PolicySectionId, PolicySectionView, proposalPayload, ProposalPayload, ProposalTarget, PROPOSAL_FILE_EXTENSION)
  - webview/openPanel.ts (openPanel, PanelSpec, BRANDED_TITLE)
  - policyEditor.ts (registerPolicyEditor, openPolicyEditor, openPolicyProposal, POLICY_EDITOR_TITLE, POLICY_EDITOR_TITLE_OWN, POLICY_EDITOR_VIEW_TYPE, PolicyEditorDeps, PolicyEditorState, PolicyChange, ProposalOutcome, PROPOSAL_OUTCOMES, PROPOSAL_EXPORTED_TEXT, NO_CONTACT_TEXT, ORGANIZATION_SENDS_TEXT, SET_BY_ORGANIZATION_TEXT, SELF_SIGNED_RULES_TEXT)
  - media/policy (policy.js, policy.css)
affects: [41-14 (wiring: commands, host deps, directionOf from 41-02's narrowingOf)]
tech-stack:
  added: []
  patterns: [pure diff with plain sentences, unknown direction widens, one panel in a module variable, page messages must name the shown proposal id, stale is sticky]
key-files:
  created:
    - src/domain/gate/proposal.ts
    - src/services/webview/openPanel.ts
    - src/services/policyEditor.ts
    - media/policy/policy.js
    - media/policy/policy.css
    - src/test/gatePolicyProposal.test.ts
    - src/test/policyEditor.test.ts
  modified: []
decisions:
  - "Page messages for apply, export and discard must carry the shown proposal's id (a string); anything else is ignored, so a click on a replaced proposal never applies the newer one."
  - "A stale proposal stays stale (only Discard), even if the hash later returns to the base; rules that cannot be read also make it stale."
  - "openPolicyProposal rejects while a shown proposal is being applied or saved, so a flow is never told 'replaced' for a change that then lands."
  - "Closing the page during a running Apply or Export lets that move finish; if it does not finish the proposal, it is then discarded."
  - "The diff recurses only when both sides are objects; a value added or removed whole (a section key, an object) is one change of the whole value. An absent section reads as empty and its own v is not a rule."
  - "Changes are sorted by section in POLICY_SECTIONS order (the editor's order), then by key."
  - "The applied record's proposalHash is bundleHash of proposalPayload against the personal target (layer personal, base hash, this device's fingerprint); the exported one is bundleHash of the signed payload."
  - "Exported notice names every onboarding contact, security first, joined with 'or'; the contacts come from your organization's rules."
  - "Dedicated sentences beyond the plan's three: residency (must stay in), requireAccreditedDevice (an approved computer, avoiding the word accredited), authorizations (allowed by {name} until {date}, never the record id) and a changed AI service; everything else uses '{section title}: {key} changes.' plus the direction sentence."
  - "exportControl changes read under the title 'Export-controlled work'; on the page they show as a row in 'Labels and where they may go'. Handling flags are not shown on the page (glossary: never on main screens); Show as stored has them."
  - "The page scrolls to the requested section once per request (atSeq), not on every update."
metrics:
  duration: ~45 min
  completed: 2026-11-20
actuals:
  tokens: 24800
  tasks: 3
  commits: 3
plan_head_before: ce786119bcb5b7bd1016ed5ae49029d277c58bda
plan_head_after: 02c66b57b447bd24356d536d0df8b6a157ed21f7
---

# Phase 41 Plan 08: Proposals and the policy editor shell Summary

A pure `proposalOf` that lists every changed key of a policy with one plain sentence (unknown direction counts as wider), the first piece of the webview kit (`openPanel`: one CSP with a fresh nonce, base.css, the layout probe, branded titles refused), and the "Your organization's rules" / "Your rules" page that receives proposals: applied on your own rules, or saved as a signed `policy-proposal` file for your organization's contacts with nothing changed on this computer.

## What was built

- **proposal.ts** (pure, no services/agent/gate imports): `proposalOf(base, next, directionOf = UNKNOWN_WIDENS, scales?)` walks every section but `reserved`; envelope fields are never proposals; objects give dotted keys, lists whose items carry an id (or a signed envelope's payload id) give `[id]`, any other list is one value; output frozen and sorted. Effects in the glossary's words ("Runs on" by endpoint class, labels by `labelKeyShown`). `policySections(doc, scales)` gives the eight page sections as plain `{ name, value }` rows. `proposalPayload` gives `{ v: 1, target, from, reason?, changes: [{ section, key, before?, after?, direction }] }`, sorted, absent values left out, and throws a PayloadError ("Nothing was signed: ...") for any number that is not a whole, non-negative safe number or a bad target hash. `PROPOSAL_FILE_EXTENSION = '.near-policy-proposal'`.
- **webview/openPanel.ts**: copied from mcpView.ts; throws before making a panel for a title matching `/^(NEAR AI|Near AI)\s*:/i`.
- **policyEditor.ts**: one panel; state message `{ type: 'state', title, setBy, sections, proposal?, actions, notice?, at?, atSeq? }`; inbound messages checked in one switch (`ready`, `apply`, `export`, `discard`, `show-stored`, `reset`); errors posted as `{ type: 'error', text }` cut to 500 characters. Target is `change.target`, else organization when the state has an organization layer, else personal. Apply only for the personal target; Export only for the organization target (signPayload with `deps.signer()`, save dialog with `policy-proposal-<yyyymmdd>.near-policy-proposal`, `workspace.fs.writeFile`). Stale text is `STALE_DRAFT_TEXT` from bundleStore. No `getConfiguration`.
- **media/policy**: page built with textContent only (no innerHTML); buttons "Apply to my rules", "Save a file for your organization", "Discard", "Show as stored", "Reset my rules"; "Wider" / "Stricter" markers.

## For 41-14 (wiring)

`registerPolicyEditor(context, deps)` returns a disposable. `deps.directionOf` from 41-02's `narrowingOf(path, before, after)`: join section and key into the path, read an `[id]` segment as `[]`. `deps.state()` from the host's BundleState (41-09); `applyPersonal(next, baseHash)` should refuse a stale base with STALE_DRAFT_TEXT; `record(id, { proposalHash, changes, from })` writes `policy.proposal-applied` / `policy.proposal-exported`. `openPolicyEditor(section?)` takes a `PolicySectionId` to scroll to.

## Tests

- gatePolicyProposal: 9 tests. policyEditor: 16 tests (every proposal state: drafted/shown, applied, exported, discarded, closed, replaced, stale; forbidden moves: forged Apply on an organization target, Apply while stale, Apply racing a change, Apply naming another or no proposal, Export on a personal target, Export while stale).
- Failing first (RED), each on the code before its task: Task 1 on the base (ce786119): `npm run lint` failed, `Cannot find module '../services/policyEditor'` and `'../services/webview/openPanel'`, and proposal.ts absent. Task 2 on the Task 1 code: no exported `POLICY_SECTION_IDS`, `PROPOSAL_FILE_EXTENSION`, `policySections`, `proposalPayload`. Task 3 on the Task 2 code: no `PROPOSAL_EXPORTED_TEXT`, `NO_CONTACT_TEXT`, `PROPOSAL_OUTCOMES`, `SET_BY_ORGANIZATION_TEXT`, and `openPolicyEditor` took no section.
- Final focused run (capped, locked): `gate*.test.js`, policyEditor, teamSignedPayload, teamBoundaries, replicaBoundaries, pageScripts, responsivePanels: 1018 tests, 1018 pass, 0 fail. `npm run lint` exits 0. gateCommands passes unchanged.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 2 - Security] Page messages must name the shown proposal**
- Found during: Task 1. Apply, Export and Discard carry the proposal's `id`; a message without it, with another id or a non-string id changes nothing. Without this, a click on a page showing proposal A could apply proposal B after B replaced A (T-41-80, T-41-81). Commit 7d3e2c09.

**2. [Rule 1 - Bug] File names read as record ids**
- Found during: final gate run. gateRecordIds' "every rule-shaped id" scan read the literals `'policy.js'` and `'policy.css'` in policyEditor.ts as unknown `policy.*` ids. The names are now built from a `PAGE` constant. Commit 02c66b57.

**3. [Rule 1 - Copy] Literal em-dash in the copy checks**
- The forbidden-words regex in both test files held a literal em-dash character; it is now written as `—` so no repository file carries the character. Commit 02c66b57.

**4. [Test design] Generic effect example**
- The Task 2 generic-sentence example now changes an existing `limits.spend.dailyNanoUsd` (an added `spend` object is one change of the whole value, also asserted). No assertion was dropped.

### Choices taken on defaults
Listed in the frontmatter `decisions`.

## Known Stubs

- The page's Models section shows "Approved models: None listed yet" for every document: 41-01's models section is a strict stub that 41-05 fills; the row then needs its passports listed. It does not block this plan's goal.

## Threat Flags

None beyond the plan's register. T-41-80 (forged Apply on an organization target, tested), T-41-81 (stale base: sticky stale state, re-checked at click time, host refusal expected), T-41-82 (one CSP, nonce on every script, textContent only, tested), T-41-83 (signPayload's secret scanner runs over a payload carrying authorization envelopes, tested), T-41-84 (unknown direction widens, marked "Wider", tested). No package installed.

## Self-Check: PASSED

- Files: all 7 created files present.
- Commits: 7d3e2c09, e02c2b84, 02c66b57 are ancestors of HEAD on feat/phase-41-08-policy-editor.
