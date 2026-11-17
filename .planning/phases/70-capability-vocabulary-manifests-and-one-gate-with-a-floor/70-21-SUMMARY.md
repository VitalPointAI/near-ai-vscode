---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 21
pr: 4b
subsystem: gate (policy editing, routing tiers)
status: complete
tags: [gate, policy, labels, routing, CLAS-02, CLAS-03, CLAS-05, CLAS-06, CLAS-07, GATE-07, D-41, D-53, D-57]
requires: ["70-20"]
provides:
  - "src/gate/bundleStore.ts: applyPolicyDraft, POLICY_DRAFT_FILE, POLICY_DRAFT_BASE_FILE, STALE_DRAFT_TEXT, PolicyEditResult"
  - "src/domain/gate/bundle.ts: inBundleOrder"
  - "GateHost.applyPolicyDraft (policy.edit with the old and new hashes)"
  - "src/services/gateCommands.ts: nearAi.policy.edit, nearAi.policy.applyDraft, editPolicy, applyPolicyDraftCommand, POLICY_ROUTING_NOT_LIVE_TEXT (replaces POLICY_LABELS_NOT_USED_TEXT), unlabelledDefaultText, editPolicyNotice, POLICY_APPLIED_TEXT"
  - "src/domain/gate/routing.ts: localHosts compared in lowercase"
  - "src/extension.ts: the local runtime prompt sentence (D-37)"
  - "SECURITY.md bullets 'Changing it' and 'Labels and clearances in this version'; README 'Labels and clearances'"
affects: [70-22, 70-24, 70-25, 70-28b]
tech-stack:
  added: []
  patterns: ["unsigned draft in extension storage with the base hash beside it", "apply through the host, as reset does", "docs pinned to code constants by gateDocs"]
key-files:
  created: [src/test/gateLabelCommands.test.ts, src/test/gateRouteTiers.test.ts]
  modified: [src/gate/bundleStore.ts, src/domain/gate/bundle.ts, src/gate/host.ts, src/services/gateCommands.ts, package.json, SECURITY.md, README.md, src/domain/gate/routing.ts, src/extension.ts, src/test/gateCommands.test.ts, src/test/gateDocs.test.ts]
decisions:
  - "Apply Policy Draft puts the draft's clearances and mappings in the parser's order before parsing; the order carries no meaning"
  - "Edit Policy refuses while the policy cannot be trusted (there is no hash to make a draft from); Reset Policy to Defaults is the way back"
  - "D-57 kept as planned: the client-level local-only tests and the prompt sentence ship in 4b as Task 4"
metrics:
  completed: 2026-11-17
  tasks: 4
estimate:
  tokens: 95049
actuals:
  tokens: 17729
  tasks: 4
  commits: 4
plan_head_before: 0a897d1cddffc3577926aeb8480b61b041789bbd
plan_head_after: 7f3ea4f05213bcf540b978283d13e3600781be9f
---

# Phase 70 Plan 21: Edit Policy, Apply Policy Draft and local-only through the client Summary

A person changes their own policy through an unsigned draft kept in this extension's storage, which Apply Policy Draft validates, signs with this install's key (setting the signer and dates itself), records as `policy.edit` with the old and new hashes and applies through the host, refusing an invalid or stale draft with nothing changed; Show Policy, SECURITY.md and README say exactly what 4b makes live; and local-only is shown, through the client, to mean a model on this computer.

## What was built

- **Task 1 (tracer), `4a40d3e9`.** `applyPolicyDraft` under `bundle.lock`: the stored policy must be valid and its hash equal the draft's base hash; the draft is parsed as JSON, put in the parser's list order, given this install's issuer and fresh dates, parsed by `parseBundle`, signed with `signPayload(..., 'policy-bundle', ...)`, written, read back and remembered. `GateHost.applyPolicyDraft` sets the state, records `policy.edit` (reason "The policy changed from <old> to <new>.") and tells its listeners, as `reset()` does. Commands (checked with `node -e`): `{"command":"nearAi.policy.edit","title":"Edit Policy","category":"NEAR AI"}` and `{"command":"nearAi.policy.applyDraft","title":"Apply Policy Draft","category":"NEAR AI"}`. Edit Policy writes `<globalStorage>/gate/policy-draft.json` and `policy-draft.base`, opens the draft and offers Apply and Discard with `CLEARANCE_SELF_ASSERTED_TEXT`, `LABELS_NOT_ACCREDITATION_TEXT` and the Pitfall 14 sentence.
- **Task 2, `67a32d69`.** Tests for invalid drafts (unknown field, level not in its scale, mapping within one scale, not JSON), stale drafts (after a reset, after another window's Apply), the extension's own signer and dates, and a self-added clearance that ends during a chat (the next read is refused with "your clearance for it ended on <date>", and Show Policy shows the date). Show Policy now shows `POLICY_ROUTING_NOT_LIVE_TEXT` instead of `POLICY_LABELS_NOT_USED_TEXT` (`grep -c POLICY_LABELS_NOT_USED_TEXT src/services/gateCommands.ts` is 0) and a "Default label" line with the Pitfall 14 sentence.
- **Task 3, `3684c752`.** SECURITY.md and README, quoted below; gateDocs pins both texts (imported), the three commands as package.json contributes them, and the changed phrases. `grep -c "What this version does not use yet" SECURITY.md` is 0 and `grep -c "Labels and clearances in this version" SECURITY.md` is 1.
- **Task 4, `7f3ea4f0` (D-57).** `gateRouteTiers.test.ts` through the client with hand-set marks: Protected B with only NEAR AI Cloud refused before fetch (fetch called 0 times); a loopback local runtime served, a remote one only once `routing.localHosts` names it; localhost, 127.0.0.1 and [::1] are local, 127.0.0.2, a LAN host, a trailing dot and a userinfo trick are not; empty catalog and no local client refused; a hybrid profile judged per client at local-only and at Confidential (`route.connection-not-bound` on the NEAR client, the local one sent; a NEAR-only profile refused with `route.no-local-model` whose sentence starts with the binding cause, fetch 0 times); a mark that rises mid-request applies from the next request; a model missing from the cached catalog refused at attested-cloud and local-only. The only code change needed: `isLocalRouteHost` compares the policy's names in lowercase. The local runtime URL prompt now says: "Only a runtime on this computer (localhost or 127.0.0.1) counts as local for content that must stay on this computer, unless your organization names its host in the policy." It accepts the same URLs.

### SECURITY.md bullet (in full)

> - **Labels and clearances in this version.** **NEAR AI: Set Label** labels a file, a folder or the project. Labels are kept in `.planning/.near-ai/labels.json`, signed with your device key, and travel with the project, so anyone who can read the project can read its labels, compartment names included: do not use a compartment name that is itself secret. A label file NEAR AI cannot verify (changed by hand, merged, or signed on another computer) only ever makes a label stricter, and it is signed again only after you confirm. A label file that cannot be read, or that was deleted or replaced by an older copy, stops agents reading the project until you put it back or sign the labels this computer last checked again with **NEAR AI: Set Label**. You can set only a label your own clearance covers; to add a clearance, use **NEAR AI: Edit Policy** and **NEAR AI: Apply Policy Draft**. An agent cannot read a file whose label your clearances do not cover, through the file tools, searches or a command that names it; a read a command does not show (a path built in a variable) is not seen. Content with no label takes your policy's default label, so a policy with no clearance on that scale cannot read it. Decision records hold the labels involved and stay on this computer. A label does not change where content is sent yet: every model request is routed by the default label and the routing tiers. Labels and routing are an organizational control that helps prevent mistakes. They check what NEAR AI itself sends to a model and what its own file tools read, and they cannot see everything a shell command or an add-on server does. They do not make this device accredited for classified information. Until verified credentials arrive, your clearance is the one you declared yourself, so it is not an enforced boundary.

A new bullet, **Changing it**, says Edit Policy opens an unsigned draft in this extension's storage, Apply Policy Draft checks it, sets the signer and dates, signs and records it with the old and new hashes, and an invalid or stale draft changes nothing. The "Your clearance is your own word" bullet with `CLEARANCE_SELF_ASSERTED_TEXT` is unchanged. The model-request bullet now says "A label does not change where content is sent yet, so every request is at the policy's default label".

### README paragraph (in full)

> - **Labels and clearances.** **NEAR AI: Set Label** labels a file, a folder or the project, and agents cannot read what your clearances do not cover. Add a clearance with **NEAR AI: Edit Policy** and **NEAR AI: Apply Policy Draft**. A label does not change where content is sent yet. Labels and routing are an organizational control that helps prevent mistakes. See [Your policy file and decision records](SECURITY.md#your-policy-file-and-decision-records).

## Red first

Task 1: the test failed to compile before the code (no draft constants or commands). Task 2: the Show Policy test failed (no `POLICY_ROUTING_NOT_LIVE_TEXT`); the invalid, stale, signer and expiry tests passed on their first run, because Task 1's `applyPolicyDraft` already did what they check. Task 3: with SECURITY.md and README held back, four gateDocs tests failed. Task 4: the lowercase policy-name case failed until `isLocalRouteHost` was changed; the other six cases passed against plan 19's route check, as the plan expected.

## Tests

- `gateLabelCommands.test.ts`: 9 tests. `gateRouteTiers.test.ts`: 8 tests. gateDocs: 2 tests added.
- Plan verify sets passed inside the cap; all `gate*` tests after Task 3: 617 pass, 0 fail. providerFactory and privateMembers pass unchanged.

## Existing tests changed (intended, as the plan says)

- `gateCommands.test.ts`, the Show Policy test: `POLICY_LABELS_NOT_USED_TEXT` is now `POLICY_ROUTING_NOT_LIVE_TEXT` in the same places; its three sentence checks now name the new sentence's words (as strict as before); the line `assert.doesNotMatch(text, /unlabell?ed/i, ...)`, which said the unlabelled-content sentence arrives with plan 21, now asserts that sentence is there. The title says "what is live" instead of "not used yet".
- `gateDocs.test.ts`: the phrase 'does not use them yet' became 'does not change where content is sent yet'; 'Nothing can be labelled yet, so every request is at the policy's default label' became 'A label does not change where content is sent yet, so every request is at the policy's default label'; 'The file also holds scales and clearances. This version stores and shows them and does not use them yet.' was removed with the bullet it pinned, which the plan replaces.

## Deviations from Plan

1. **[Rule 2] Apply puts clearances and mappings in the parser's order** (`inBundleOrder`), so a person who appends a clearance is not refused with "A list is not in the required order".
2. **The old and new hashes are in the `policy.edit` record's reason**, since the record has one policy hash field.
3. **Edit Policy refuses while the policy is failed closed** (no hash to make a draft from) and names the policy's own sentence.
4. **An Apply saves an open, unsaved draft first**, so what is applied is what the person sees.
5. **Task 4 touched `src/domain/gate/routing.ts`** (planned after the amendment in `4f2dee6f`) and added a source check for the prompt sentence.

## Threat Flags

None beyond the plan's register.

## Self-Check: PASSED

Files exist (`src/test/gateLabelCommands.test.ts`, `src/test/gateRouteTiers.test.ts`); commits `4a40d3e9`, `67a32d69`, `3684c752`, `7f3ea4f0` are ancestors of HEAD.
