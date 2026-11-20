# Phase 41: Organization policy foundation (F1) - Research

**Researched:** 2026-11-20, against `origin/main` at 2f9b922b (after PR #139).
**Domain:** signed layered policy, pinned root of trust, one endpoint list, one authorization record, one routing decision, organization modes, provider interface, architecture and copy ratchets. Pure TypeScript inside the extension.
**Confidence:** HIGH for the code audit (every path opened or grepped this session); MEDIUM for prior art (official documents fetched this session); recommendations are marked as such.

<user_constraints>
## User Constraints

No `41-CONTEXT.md` existed in the phase folder while this was written (checked four times). The binding decisions are the owner-approved coherence review (PR #139), all twelve defaults accepted (`.planning/research/coherence/REVIEW.md` section 11). Once `41-CONTEXT.md` exists its Decisions override the recommendations here.

### Locked (REVIEW section 11, accepted)
- Q1: F1 is Phase 41, before 32.1, 32.2, 33.1, 36 and 37, including the passport schema from 74.1 (schema and report mode only).
- Q2: the root key arrives in a signed enrolment file from the security contact, fingerprint read aloud like the safety code; DID later (Phase 71).
- Q3: the safety patch (REVIEW section 8, S1 to S8) ships first as one PR; Phase 41 builds on it and never redoes it.
- Q6: classified and Protected C without an accreditation record: warn and record now, refuse once the organization layer exists.
- Q7: residency enforced in the gate (`route.residency`) in Phase 41; the hub runs the same core in Phase 35.
- Q8: glossary adopted ("private" only for verified; scale shown with level; "Team Mode" retired from copy).
- Q9: Edit Policy only where this device can sign.
- Q10: exercise flag is a signed project-layer attribute.
- Q12: architecture test with a recorded baseline and `ModelEndpoint` in Phase 41; mechanical move PR after; Phase 32 not disturbed.
- Interim rule (REVIEW 5): until an organization issuer exists, every authorization and trust line that cites one says "self-signed on this computer".

### Claude's discretion
File layout, plan split, field names inside the stated shapes, enrolment file format, baseline storage, test names.

### Deferred (out of scope)
Passport enforcement, T0 lane, Western defaults (74.1); org-tee verifier (74.2); Cohere adapters (36, 37); Get Started and removal of the staff `where` question and discovery `locality` (32.1); `LocalServerAdmin` implementations (32.2); positions, delegation, the replica source of the project layer (33.1); hub loading the organization layer (35); the mechanical move PR; Team Mode migration (L2); Phase 71 credentials (the `did` slot already exists: `BundleIssuer.did`, `src/domain/gate/bundle.ts:43-44`).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description (REVIEW 9.2, verbatim) | Research support |
|----|-------------|------------------|
| FND-01 | Organization layer: enrolment file, pinned issuer fingerprint read aloud, personal and project layers that narrow only, declared narrowing direction per key, Reset touching only the personal layer. | Audit A, B; "Enrolment and the pin"; "Layer composition"; state machines 1 to 3 |
| FND-02 | Bundle v2 sections, `requires`, `needs-update`, v1 read as v2. | Audit A; S6 row; "Bundle v2 in code" |
| FND-03 | `endpoints[]` replacing `routing.localHosts` (migration at today's effect, one-time notice). | Audit A; S1 row; pitfalls 3 and 4 |
| FND-04 | One `authorizations[]` record with kinds and inner signatures; "self-signed on this computer" until an issuer exists. | Audit B; pitfall 6 |
| FND-05 | Residency section and `route.residency`; accredited-device rule in report mode. | Audit A, I; S1 row |
| FND-06 | One dependency-free label module; `decideRoute` as the one decision function; `privacyMode` and `teeOnly` folded in as floors; `TrustFacts`. | Audit A, C, G; S4 and S7 rows |
| FND-07 | The mode table (`src/domain/org/modes.ts`) and `term()`, moved from 32.1; the copy lint with its baseline. | Audit F; portfolio design 5.2 to 5.4 |
| FND-08 | Passport schema only (WP-0 of 74.1): the `models` section shape, parsed in report mode; 74.1 keeps enforcement, the T0 lane and the defaults. | Provenance design 5.1 to 5.3, 12.1, 14 |
| FND-09 | `ModelEndpoint` and `LocalServerAdmin` interfaces with `NearAiClient` as the first adapter; the architecture test with its baseline; the policy editor shell that receives proposals. | Audit D, E, H |
</phase_requirements>

## Project Constraints

The repository has no root `CLAUDE.md` or `AGENTS.md` (checked). From the owner's global rules and the brief:
- Never touch the NEAR credentials folder (the gate floor already refuses it, `src/domain/gate/floor.ts` `CREDENTIAL_STORES`).
- Tests always capped: `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 300 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'npm run compile && node scripts/run-tests.mjs dist/test/<file>.test.js'`; the full suite once at the phase gate (MemoryMax=6G, timeout 1800, under `flock "$HEAVY_LOCK"`); never bare `node --test`; one heavy run at a time.
- Smallest relevant test after each edit; signing, policy and routing tests always blocking; never weaken a failing test.
- Parallel worktrees where files do not overlap; one integration and one full run after merge.
- Copy: no em-dashes, "your organization", "NEAR AI", "VS Code"; public repository, no personal or company names in code, docs or fixtures.
- Every changed state transition gets a test.
- 0.4.x line: squash PRs with the agent-review gate; `CHANGELOG.md` `## Unreleased` (only `### Fixes` today); SECURITY.md is checked word for word by `src/test/gateDocs.test.ts`.

## Summary

Phase 41 mostly reshapes code that exists. Main already has a strict, signed, fail-closed bundle (`src/domain/gate/bundle.ts`, `src/gate/bundleStore.ts`), a pure `decideRoute` (`src/domain/gate/routing.ts:416`), a dependency-free label algebra (`labels.ts` imports only `shape.ts`; `dominance.ts` only `labels.ts`), one signer and verifier with closed purposes (`src/domain/team/signedPayload.ts`), key-status sources kept apart (`src/domain/team/keyStatus.ts`), a SecretStorage marker a disk writer cannot reset (`src/gate/clockMarker.ts`), a read-aloud word code (`src/domain/replica/safetyCode.ts`) and an SPKI-pinned fetch (`src/services/connectionBinding.ts` `pinnedFetch`). Missing: a second trust root pinned in SecretStorage, per-key narrowing composition, a sectioned v2 document read through a feature registry, an endpoint-centric `decideRoute`, and the two ratchets.

Three findings change the plan. (1) The safety patch edits exactly the functions F1 rewrites (`parseBundle`, `BUNDLE_FAILURES`, `isLocalRouteHost`, `decideRoute`, `routeAllows`, the staff label helpers), so every F1 plan branches after the patch merges. (2) `POLICY-SCHEMA.md` has three details that break in code: `maxLabel` is one label but ceilings are per scale; inner-signature fields named `signature` and `key` are not exempt from the secret scanner `signPayload` runs, so random signatures would be refused at random; and "migration at today's effect" conflicts with "Protected B needs a TLS pin". (3) Team Mode `teeOnly` and `allowedModels` are parsed and stored (`src/domain/team/policy.ts:16,129-130`) but nothing reads them, so the live evaluators to fold are `nearAi.privacyMode` and member `privacy: private`.

**Primary recommendation:** plan 41-01 alone settles bundle v2, the feature registry, `endpoints[]`, the authorization record and every new id, keeping today's `PolicyBundle` fields as the effective view all consumers read; then parallel groups (layers and enrolment; decision core and labels; modes and copy lint; passports; provider and architecture test; editor shell), then the caller fold-in, then one integration plan owning `package.json`, `extension.ts`, SECURITY.md, README and CHANGELOG.

## Architectural Responsibility Map

| Capability | Primary tier | Secondary | Rationale |
|---|---|---|---|
| v2 parsing, feature registry, endpoint and authorization schemas, layer composition, enrolment check, `decideRoute`, residency, `TrustFacts`, label module, passports, proposal diff | Domain (pure) `src/domain/gate` | none | No I/O, caller passes `now`; must compile for the hub later |
| Modes and `term()` | Domain `src/domain/org` (new) | editor and pages consume | Data table like `doctrine.ts` |
| `ModelEndpoint`, `LocalServerAdmin`, message types | Domain `src/domain/provider` (new) | `nearAiClient.ts` is the adapter | Removes the type-only domain leaks |
| Issuer pin, organization layer files | Node host `src/gate` | none | Same trust model as `clockMarker.ts`, `bundleStore.ts` |
| Route facts gathering | Editor `src/services/nearAiClient.ts` `checkRoute` | domain decides | Local facts only, no fetch at decision (OFFL-01) |
| Enrol dialog, policy editor page | Editor `src/services`, `media/policy` | domain | Same split as `invite.ts` and `staffMultiUserCommands.ts` |
| Architecture test, copy lint | `src/test` | none | Read sources from the repository root like the boundary tests |

## Standard Stack

No new dependency; nothing to install, so no package legitimacy audit applies. Reuse: `signPayload`, `verifyPayload`, `canonicalBytes`, `fingerprintOf`, `isStrictBase64url` (`src/domain/team/signedPayload.ts`, `canonical.ts`); `KeyStatusLookup`, `NO_KNOWN_KEYS` (`keyStatus.ts`); `checkKeys`, `ownValue`, `isRecord`, `childPath`, `refused`, `Parsed<T>`, `parseIsoMillis` (`src/domain/gate/shape.ts`); `normaliseFingerprint`, `peerFingerprint`, `pinnedFetch` (`src/services/connectionBinding.ts`); `SAFETY_WORDS` (`src/domain/replica/safetyWords.ts`, 2,048 words); `node:crypto`; `node:test`; `scripts/run-tests.mjs`.

## Prior art (only what changes a decision)

- **TUF** [CITED: theupdateframework.github.io/specification/latest]: clients "MUST ship with trusted root keys" (2.1.1); rotation signs the new root "with both the new and old root keys" (6.1), walked one version at a time (5.3); "Clients MUST NOT trust an expired file" and "MUST NOT replace a metadata file with a version number less than the one currently trusted" (4.3). **Take:** pin on enrolment where a disk writer cannot reach; rotation file signed by old and new key; monotonic `issuedAt` on the organization layer (today's `replaced` rule generalised); expiry fails closed. **Not now:** thresholds and delegated roles (reserve the field).
- **Chrome and Firefox enterprise policy** [CITED: support.google.com/chrome/a/answer/9037717; firefox-admin-docs.mozilla.org]: fixed precedence, "a mandatory policy still overrides a recommended policy"; Firefox lets Group Policy beat a dropped `policies.json` so a user cannot override the company. **Take:** fixed precedence, organization on top. **Do not take:** "top wins, rest ignored": our personal layer may still be stricter, so composition is a per-key meet.
- **Kubernetes ValidatingAdmissionPolicy** [CITED: kubernetes.io/docs/reference/access-authn-authz/validating-admission-policy]: actions `Deny`, `Warn`, `Audit`. **Take:** report mode as a first-class action (record `wouldRefuse`, notice, allow) for FND-05 accredited and FND-08 passports.
- **Cedar** [CITED: docs.cedarpolicy.com/auth/authorization.html]: default deny; "If any `forbid` policy evaluates to `true`, then the final result is `Deny`"; response names the determining policies. **Take:** any refusing check wins, the decision names what allowed it (`TrustFacts.allowedBy`). **Do not take:** "skip a policy that errors": the gate refuses on error (`routeCheckFailed`, `routing.ts:356`).
- **Git `extensions.*`** [CITED: git-scm.com/docs/repository-version]: an unknown extension means "the operation MUST NOT proceed"; with no extensions keep version 0. **Take:** `requires` with refuse-on-unknown (S6, FND-02), and the issuer tooling names a feature only when the section is present, so plain bundles still read on older clients.
- **HPKP, RFC 7469** [CITED: rfc-editor.org/rfc/rfc7469]: a backup pin "that does NOT refer to an SPKI in the certificate chain" is required (2.5); bricking (4), long lifetimes (4.1), hostile pinning (4.5). **Take:** `tlsPins` is a list of one to four SPKI hashes so a server key can rotate; pins come only from the signed policy (no trust on first use), which removes hostile pinning.
- **Signal safety numbers, SSH fingerprints** [CITED: signal.org/blog/safety-number-updates]: 60 digits from two 30-digit fingerprints. **Take:** a static fingerprint is attacked offline for as long as the attacker likes. The six-word code (66 bits) is safe only because it is interactive and nonce-bound (`safetyCode.ts` header). The issuer fingerprint needs twelve words (132 bits) under its own domain string.
- **Label lattice** [ASSUMED: Bell-LaPadula]: join is least upper bound, meet greatest lower bound. The repository already joins this way per scale and compares across scales only through signed mappings (`dominance.ts` header). **Take:** add `meet` for K31 (effective clearance) and `atLeast` for the staff floors.

## Code audit (A to K)

Every path exists on main unless marked otherwise. Paths the designs cite that **do not exist**: `src/domain/gate/models.ts`, `src/domain/gate/trust.ts`, `src/gate/policyReader.ts`, `src/domain/org/`, `src/domain/provider/`, `src/platform/`, `src/domain/core/`.

### A. Gate policy today

`src/domain/gate/bundle.ts` (701 lines):
- `BUNDLE_VERSION = 1` (21). `BUNDLE_FIELDS` (95-98): `'bundleVersion', 'vocabulary', 'issuer', 'issuedAt', 'expiresAt', 'ceiling', 'scales', 'mappings', 'clearances', 'routing', 'defaultLabel', 'anchorRoots', 'statusLists', 'maxOfflineAge'` [VERIFIED: src/domain/gate/bundle.ts:95-98]. `PolicyBundle` (63-81); `BundleCeiling` with the optional `mcpLabelCeilings` (47-61, the "optional v1 key" precedent).
- `defaultBundlePayload` (125-157) from `SCALE_PRESETS` and `DEFAULT_ROUTING`; `SELF_SIGNED_LIFETIME_DAYS = 365`, `RENEW_WINDOW_DAYS = 30`. `bundleHash` (160) over `canonicalBytes`. `inBundleOrder` (378-394) sorts clearances and mappings in a draft; `parseSetList` (356-372) makes set-like lists sorted and unique so equal bundles hash equally (v2 lists need the same).
- `checkNumbers` (467-485): every number anywhere must be a non-negative safe integer.
- `parseBundle` (491-558): version and vocabulary first, then exact keys. Callers: `isDefaultBundle` (663), `verifyBundleEnvelope` (684), `src/gate/bundleStore.ts:418` (`applyPolicyDraft`). Nothing else parses a bundle.
- `RESET_FIX` (563), `BUNDLE_FAILURES` (570-594), `failedClosed` (605), `payloadReason` (611), `shapeReason` (621), `FAILED_CLOSED_VERBS = ['read','plan']` (598).
- `verifyBundleEnvelope` (678-701): `verifyPayload(..., { purpose: 'policy-bundle', status })`, parse, then the D-12 repeat check (payload issuer must equal envelope signer, `issuedAt` must equal `signedAt`), clock-behind, expiry.

`src/domain/gate/shape.ts`: `GATE_SHAPE_FAILURES` (7-18), `Refusal`, `Parsed<T>` (22-23), `checkKeys(value, path, required, optional)` (60-69), `parseIsoMillis` (78-82, exactly `YYYY-MM-DDTHH:MM:SS.sssZ`).

`src/gate/bundleStore.ts` (426): file `<globalStorage>/gate/policy-bundle.json`; drafts `policy-draft.json` and `.base`; lock order bundle, identity-create, key-history (header 19-20). `verifyDisk` (106-131) uses `localKeyStatus(identityDir(...))`, so only this device's own key history is accepted (`unknown-key` otherwise); a valid file whose hash is not the SecretStorage marker's is `replaced` (127-129). `install` (152-179), `ensurePolicyBundle` (265-302, default only on a true first install via `earlierInstallEvidence`), `tryRenew` (221-239), `resetPolicyToDefaults` (323-369, keeps the old file as `.replaced-<ms>`), `applyPolicyDraft` (383-426, sets issuer and dates itself).

`src/gate/host.ts` (853): `start`/`begin` (174, 740-753) never throw; `bundleState()` (185) re-checks expiry against a high-water clock; `labelPolicy()` (269-273) returns `SCALE_PRESETS` when failed closed; `routingNow()` (485-488); `reset()` (592), `applyPolicyDraft()` (607), `onDidChange` (617); `announce()` records `policy.*` events. Readers of the bundle's fields outside tests: `src/agent/gateAdapter.ts`, `src/agent/gateLabels.ts`, `src/domain/gate/decide.ts`, `src/gate/host.ts`, `src/gate/sessionMark.ts` (`routingOf`, 108-112), `src/services/agentSession.ts`, `src/services/gateCommands.ts`. **Recommendation:** keep `BundleState.valid.bundle: PolicyBundle` as the effective view (composed result projected on today's names) and add `layers` beside it; no consumer changes in plan 41-01.

`src/services/gateCommands.ts` (764): commands `nearAi.policy.reset`, `nearAi.label.set`, `nearAi.policy.edit`, `nearAi.policy.applyDraft` (35-38), `nearAi.policy.show`. Show Policy is a read-only virtual text document (`POLICY_SCHEME`, `policyDocumentText` 119-200, registered in `registerPolicySurfaces` 267-330), not a webview. `editPolicy` (650-666) writes pretty JSON to global storage and opens it in a normal editor; `applyPolicyDraftCommand` (679-706); `resetPolicy` (748-764) modal; `labelShown` (481-486) prints raw keys (S8).

`src/domain/gate/routing.ts` (458): `ROUTING_TIERS`, `TIER_ORDER` (16-20); `RoutingTable { levels, handling, compartments, localHosts }` (29-37); `DEFAULT_ROUTING` (40-61; Public any-cloud; Internal, Confidential, Protected A, NATO Unclassified attested-cloud; the rest local-only; `localHosts: []`); `parseLocalHosts` (122-136, `*.example.com` allowed); `tierForLabel`, `tierForMark`, `strictestLabelOf` (170-208); `hostnameOf` (210); `isLocalRouteHost` (227-236, loopback or any pattern, no scheme check); `RouteFacts` (288-307); `ROUTE_RULES` (309-321); `ROUTE_REFUSALS` (333-341); `ROUTE_CHECK_FAILED_TEXT` (344, mentions Reset); `whyNotLocal` (369); `decideAttested` (393); `decideRoute(mark, routing, facts, defaultLabel)` (416-426); `routingWhileFailedClosed` (433). Only caller of `decideRoute`: `nearAiClient.ts:1275` in `checkRoute` (1242-1310). `tierForMark`/`routingWhileFailedClosed` also in `src/agent/gateAdapter.ts:911-918` and `sessionMark.ts:111`.

Others: `decide.ts` `GATE_RULE_IDS` (161-175, includes `ROUTE_RULES`), `RECORD_RULE_IDS` (186); `labels.ts` (`SCALE_PRESETS` 54-59, `LABEL_EVENT_IDS` 69, `levelIndex`, `labelKey`, `parseLabel`, `parseClearance`, `parseMapping`, `CLEARANCE_SELF_ASSERTED_TEXT`); `dominance.ts` (`whyNotDominated`, `dominates`, `joinLabels`, `raiseMark`, `markDominated`); `trustBadge.ts` (`TRUST_BADGE_STATES = ['verified-private','model-verified','not-verified']`, `TrustBadgeFacts.route: 'near'|'local'`, `trustBadgeFor` 129); `record.ts`, `vocabulary.ts` (`parseHostPattern` 99), `floor.ts`, `manifest.ts`, `words.ts`, `labelMap.ts`, `lowerings.ts`.

### B. Signing

- Signed bytes: `PAYLOAD_DOMAIN` (`near-ai-vscode/signed-payload/v1`), purpose, canonical JSON (`payloadSigningInput` 88-91). `verifyPayload` never throws; order shape, size (`MAX_PAYLOAD_BYTES = 256 * 1024`), purpose, key, time, signature, key status (155-213).
- `PAYLOAD_PURPOSES` on main: `'policy-bundle', 'grant', 'approval-answer', 'key-record', 'label-map', 'label-declassify', 'staff-ledger', 'staff-ledger-head', 'staff-decision', 'staff-replica', 'staff-invite', 'staff-join-request', 'staff-cell-grant', 'staff-replica-mark'` [VERIFIED: src/domain/team/signedPayload.ts:28]. Phase 32's unmerged branch appends `'staff-hub-session', 'staff-hub-file', 'staff-hub-join'` with `GENERATED_PATHS` entries.
- Adding a purpose (Phase 31, D-49): append in order with a phase comment; add a sample to `SAMPLES` and update the exact-list assertion in `src/test/teamSignedPayload.test.ts` (63-79, 135); add a test like the D-49 one (139-159: round trip, `wrong-purpose` for every other purpose, edited purpose `bad-signature`).
- Secret scanner: `signPayload` runs `assertNoSecrets` (125-131). Only a key named exactly `publicKey` with 43 base64url characters, or `sig` with 86, is exempt (`src/domain/team/secrets.ts` `isExemptKeyMaterial`, 51-53) [VERIFIED: src/domain/team/secrets.ts:26-27,51-53]; other random base64url can match a token pattern (the reason `GENERATED_PATHS` exists, `signedPayload.ts` 32-35).
- `fingerprintOf(raw)` = `dev-` plus 32 hex of SHA-256 (128 bits) (`canonical.ts:95-97`). `keyStatus.ts` header: "Callers choose the sources."
- Safety code: `safetyCode` (`safetyCode.ts:39-58`), domain `near-ai/safety-code/v2`, six words, 66 bits, safe because of the joiner's nonce (header 7-12). Copy: "Read these six words to the staff lead: ..." (`src/services/staffMultiUserCommands.ts:440`), button `SIX_WORDS_MATCH = 'The six words match'` (53, 465-467).
- File-borne signed items: `src/domain/replica/invite.ts` (`.near-staff-invite`, `readInvite(file, now)`, closed `INVITE_REFUSALS`, "text is size-capped before it is parsed"). Phase 32's `hubFile.ts` (branch only) is the closest enrolment analogue: signed by the server's own key, `certPin` = SHA-256 of the SPKI DER, size cap, closed refusals.

### C. Privacy evaluators (every call site)

| Evaluator | Where | Call sites |
|---|---|---|
| `SovereigntyMode` | `src/domain/privacy.ts:14` | `src/domain/config.ts:2,12,39`; `src/domain/multimodal.ts:3,67`; `src/services/privacyPreflight.ts:8-9,21,29,128,156` |
| `nearAi.privacyMode` | `package.json:632-644` | `src/services/settings.ts:40`; `outboundGuard.ts:33-48`; `chat.ts:906-908,997,1160`; `teamStudioAi.ts:21,60-62,139-141`; `teamStudioPanel.ts:102`; `modelComparisonPanel.ts:96-105`; `modelComparisonPage.ts:43,53,62`; `webSearchSetup.ts:30-50`; `src/extension.ts:454` |
| `OutboundGuard.check` | `src/services/outboundGuard.ts:37-53` | `chat.ts:907,1032`; `teamStudioAi.ts:109,155`; `chatParticipant.ts:122` |
| `PrivacyPreflight` | `src/services/privacyPreflight.ts:28` | `outboundGuard.ts:34`; `policyGate.ts:14`; `multimodalIntake.ts:57`; `multimodalOrchestrator.ts:131`; `generationService.ts:58`; `agentOrchestrator.ts:211` |
| member `privacy: private` | `routeAllows` `src/services/agentSession.ts:279-283`, `PrivateRoute` (277) | `agentSession.ts:1546-1566`; `teamStudioAi.ts:2,53,70,133`; `privateRouteFor` (`providerCache.ts:70`) from `chat.ts:997`, `teamStudioPanel.ts:101` |
| fallback privacy | `fallbackModelsFor` `src/gsd/library.ts:267-302` | `agentSession.ts:1566` |
| picker word | `modelPrivacyLabel` returns `'Private · runs in NEAR TEE'` [VERIFIED: src/services/chatBridge.ts:139] | `chatBridge.ts:479`; `chat.ts:997`; `chatParticipant.ts:160` |
| Team Mode `teeOnly`, `allowedModels` | `src/domain/team/policy.ts:10,16,129-130`, `types.ts:45` | **none**: no code reads them; `request.teeOnly` in `agentSession.ts:178,1566` is the `privacyMode` setting |

### D. Provider

- `src/services/nearAiClient.ts` is 1,930 lines. Types used elsewhere: `ChatMessage` (19), `ToolCall` (25), `AgentMessage` (32), `ToolDefinition` (37), `CompletionEvent` (42), `ModelInfo` (49), `UsageMetadata` (86). Class at 434; option `route: 'near' | 'local'`.
- **Importers: 33 non-test files** (the review's 34 is off by one) and 80 test files. Only 10 name the class: `agent/attachments.ts`, `agent/extraTools.ts`, `agent/toolCatalog.ts`, `domain/auth.ts`, `services/agentSession.ts`, `services/chat.ts`, `services/generationService.ts`, `services/providerFactory.ts` (constructs), `services/spendTracking.ts` (constructs at 176, 253), `services/toolsDirectory.ts`. The other 23 import types or helpers only.
- Methods used outside: `streamCompletion` (`agent/loop.ts`, `agent/context.ts`), `streamChatEvents` (`chatParticipant.ts`), `completeOnce` (`agent/safetyModel.ts`, `cyberHandoff.ts`, `cyberAssembly.ts`, `teamStudioPanel.ts`), `cooldownRemainingMs` (`agent/loop.ts`), listing (`providerFactory.ts`, `providerCache.ts`, `capabilityRouter.ts`), images and audio (`generationService.ts`, `teamStudioAi.ts`, `extraTools.ts`, `attachments.ts`), attestation (`agentSession.ts`), spend (`spendReconciler.ts`, `spendAccount.ts`, `spendTracking.ts`).
- The agent loop already takes a structural type: `client: { streamCompletion(...): AsyncGenerator<CompletionEvent>; cooldownRemainingMs?(model: string): number }` (`src/agent/loop.ts:172`); `agent/context.ts` and `agent/safetyModel.ts` likewise.
- Factory: `src/services/providerFactory.ts` (66 lines) `clientsFor` builds the NEAR client (binding only on NEAR's own endpoint) and, for hybrid, a second `NearAiClient` with `route: 'local'` (38). `ResolvedProvider` in `src/domain/auth.ts:54-61` (`client: NearAiClient`) causes that file's leak. `src/services/providerCache.ts`: `activeProvider` (29), `clientFor` (60), `privateRouteFor` (70).
- **No local model adapters exist**: a local runtime is the same OpenAI-compatible client with `listLocalModels`; nothing installs, deletes or hash-checks a model.
- Attestation: `src/services/attestation.ts` (373: `verifyResponse`, `attestedTlsFingerprint`, `verifyTdxQuote`), `connectionBinding.ts` (317: `NEAR_TLS_FINGERPRINT_KIND = 'public-key-sha256'`, `pinnedFetch`).

**Proposed interfaces (no behaviour change; `NearAiClient` already has every method):**

```ts
// src/domain/provider/messages.ts: the seven types above moved verbatim; nearAiClient.ts re-exports them, so 33 importers compile unchanged.
// src/domain/provider/endpoint.ts
export interface EndpointFacts { readonly route: 'near' | 'local'; readonly baseUrl: string; readonly nearEndpoint: boolean; readonly endpointId?: string }
export interface ModelEndpoint {
  readonly facts: EndpointFacts; // the only addition to NearAiClient: a getter
  streamCompletion(model: string, messages: AgentMessage[], tools: ToolDefinition[], signal?: AbortSignal,
    options?: { idleTimeoutMs?: number; turnTimeoutMs?: number; maxOutputTokens?: number }): AsyncGenerator<CompletionEvent>;
  completeOnce(model: string, messages: AgentMessage[], options: { maxTokens: number; signal?: AbortSignal; noThinking?: boolean }):
    Promise<{ text: string; usage: UsageMetadata; reasoning?: string; finishReason?: string }>;
  cooldownRemainingMs?(model: string): number;
}
// src/domain/provider/localServer.ts (interface only; 32.2 implements)
export interface LocalServerAdmin {
  readonly kind: string; // data, not a union, so 32.2 adds kinds without editing this file
  identify(signal?: AbortSignal): Promise<{ readonly version?: string } | undefined>;
  listInstalled(signal?: AbortSignal): Promise<readonly LocalModelEntry[]>;
  install?(entry: LocalCatalogueEntry, signal?: AbortSignal): Promise<void>;
  remove?(model: string, signal?: AbortSignal): Promise<void>;
  verifyHash(model: string, sha256: string, signal?: AbortSignal): Promise<boolean>;
}
```

Listing stays off the interface: it differs by route today (`listModels`, `listLocalModels`, `listModelsWithPricing` chosen in `providerCache.ts`), so including it would force a behaviour decision before 32.2. **Movable in Phase 41 without touching files other active phases own:** `agent/loop.ts`, `agent/context.ts`, `agent/safetyModel.ts` (type names), `domain/state/threadView.ts`, `domain/state/threadCapture.ts` (type imports from `domain/provider/messages`, removing two baseline lines). Keep `domain/auth.ts` as is: changing `ResolvedProvider.client` touches `chat.ts` and `agentSession.ts` (frozen sizes, and S4's files). None of these appear in the Phase 32 branch diffs.

### E. Architecture

- `src/test/teamBoundaries.test.ts` (246): line-based scanner (`STATIC_FORM`, `SIDE_EFFECT_FORM`, `CALL_FORM`, `importsOf`), `RULES` per folder (`domain/team`, `domain/gate` (anything under `domain`), `domain/staff`, `team`, `gate` (plus type-only `services/auth` and `services/stateMirrorLock`)), `scan(folder, minimumFiles)`, "has teeth" tests. `src/test/replicaBoundaries.test.ts` (241): the scanner copied (to avoid registering tests twice), `HUB_SIDE`, `hubSideClosure`. **Phase 32's branch edits `replicaBoundaries.test.ts`.**
- Violations found by scanning every non-test file:
  - Domain leaks, **five files** (DEVELOPER-STRUCTURE says seven): `domain/auth.ts` (type `NearAiClient`), `domain/state/threadView.ts` (types `AgentMessage`, `ToolCall`), `domain/state/threadCapture.ts` (type `AgentMessage`), `domain/state/syncStatus.ts` (types from `services/syncFlows`), `domain/cyberLimits.ts` (value `normalizeCommand` from `agent/permissions`).
  - Folder cycles (edges each way): agent and services (14/112), agent and domain (223/1), agent and mcp (8/5), agent and staff (24/1), agent and gsd (9/7), benchmark and services (5/12), domain and services (4/358), gate and services (8/29; gate's eight are the allowed auth and lock imports), gsd and services (1/14), services and staff (30/11), services and team (21/7).
  - `SCALE_PRESETS` outside `domain/gate`: `domain/staff/guardScan.ts`, `domain/staff/obs/observation.ts`, `gate/chatLabel.ts` (S7 fixes these three), `gate/host.ts:272` and `agent/gateLabels.ts:225` (failed-closed fallbacks, allowed), `services/agentSession.ts:590`, `services/threadStore.ts:96,107`, `services/staffMultiUserCommands.ts:287`, `staff/replica/membership.ts:229,280` (not named in S7).
  - `getConfiguration(`: 54 calls in 19 files. Files over 800 lines: 23; largest `agent/commandSafety.ts` 2,900, `services/agentSession.ts` 2,738, `services/teamStudioPage.ts` 2,236, `agent/teamTemplateHistory.ts` 2,046, `services/nearAiClient.ts` 1,930, `staff/staffHost.ts` 1,612, `services/chat.ts` 1,517, `agent/gateAdapter.ts` 1,400, `staff/replica/membership.ts` 1,384.
- **Baseline today** (`src/test/architecture-baseline.json`, one sorted list per rule plus `fileSizes`): 5 leak lines, about 40 cycle edge lines (excluding allowed auth and lock imports), about 8 `SCALE_PRESETS` lines after S7, 19 settings files, 23 frozen sizes. Under 150 lines.

### F. Copy lint

- Sources: `package.json` (84 commands, 51 settings), 228 `show*Message` calls in non-test files, quick picks, host-built HTML in ten webview hosts, 23 page scripts under `media/` (exclude `media/vendor`).
- Reusable patterns: `src/test/staffDoctrine.test.ts` "every doctrine term lives in doctrine.ts" (265-277) and "no em-dash" (280-286, `String.fromCharCode(0x2014)`); `gateDocs.test.ts` word-for-word docs checks (64-77).
- Day-one hits (rough): em-dash 50 in 10 `src` files and 32 in 5 page scripts; `TEE` about 39 service literals and 16 page places; `tier` about 44 and 62; `profile` about 170 and 68; `GSD` 15 and 12; "Team Mode" 18; the title `'Near AI: First Project'` once (`src/services/onboarding.ts:12`); provider-before-organization zero. **Recommendation:** baseline as counts per file and rule (`{ "src/services/chat.ts": { "em-dash": 3 } }`), so moving code does not churn it; enforce brand, title prefix, em-dash, provider-before-organization and `term()` words on day one; glossary words baselined with an allowed-context table.

### G. Label code paths

- `src/domain/staff/obs/observation.ts`: `splitLabel`, `rankOf` (153-156, presets), `labelAtLeast` (159-161), `joinTemplateLabels` (167-172); callers `obs/importers.ts:246`, `obs/store.ts:257`, `obs/feeds.ts:210`, `cop/picture.ts:250,317`, `cop/features.ts:454`. Labels are `scale/level` strings.
- `src/domain/staff/guardScan.ts`: `scaleMarkings` (86-95) and the header ceiling check in `guardScan` (238-243).
- `src/gate/chatLabel.ts`: `markOf` (61-70), `raiseBy` (73-77), used by `judgeChatLowering` (85-110).
- `src/domain/replica/kindSchemas/roster.ts:17-20` copies the token patterns so the hub-side file imports nothing from the gate (shape only, not order: a second spelling, not a second evaluator).
- Missing from the gate algebra: `atLeast(label, floor, scales)`, `meetClearance(a, b, scales, mappings)`, `parseLabelKey('scale/level', scales)`.

### H. Policy editor

- Today: Show is a virtual text document, Edit is raw JSON in an editor, Apply and Discard are notification buttons, Reset is a modal.
- Webview to copy: `src/services/mcpView.ts` (138 lines): one panel per module, `localResourceRoots: [media, shared]`, nonce `randomBytes(16)`, CSP `default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'`, `media/shared/base.css`, layout probe (`src/services/layoutProbe.ts`), a `state` message on change and visibility, a validated `switch (message.type)`; pages `media/mcp/mcp.js`, `mcp.css`. (`onboarding.ts` is smaller but uses the banned title prefix.)
- Smallest shell: pure `proposalOf(base, next, scales)` returning `{ section, key, before, after, direction: 'narrows' | 'widens' | 'neutral', effect }[]` with one plain sentence each; the page shows the list, the target layer and Apply (only when this device signs that layer), Export request (organization layer) or Discard; "Show as stored" opens today's JSON view. Flows call one `openPolicyProposal(change)`.

### I. Records and rule ids

- Closed lists: `ROUTE_RULES` into `GATE_RULE_IDS` (`decide.ts:161`), `RECORD_RULE_IDS` (186) and `MODEL_REQUEST_RULES` (`record.ts:351`); `validateDecisionRecord` refuses unknown ids (`idsKnown`, 368-378); `withKnownRule` maps them to `record.unknown-rule` (117-128). A refusing route rule needs a sentence in `ROUTE_REFUSALS` (enforced by type). A policy event goes in `POLICY_EVENT_IDS` (`bundle.ts:31`), which also makes it a valid `api.operation` (`record.ts:363`).
- D-49 rule: name every id the phase will write in the first plan that ships.
- `policy.version` is the literal `'bundle-1'` (`record.ts:293-294`), asserted in `gateRecords.test.ts`; a v2 effective policy writes `'bundle-2'`.
- Logs (`src/gate/decisionLog.ts`): unsigned JSONL in `gate/decisions/` and `gate/model-requests/`. The hash-chained local audit (ADR-011) is in REVIEW 2.1 under F1 but not in FND-01 to FND-09 (open question 6).

### J. Test conventions

`npm run compile` (`vendor-libs.mjs && tsc`), output `dist/test/*.test.js`; `npm test` runs `scripts/run-tests.mjs` (per-run TMPDIR, process group; no concurrency cap). 49 `src/test/gate*.test.ts` files exist (for example `gateBundle`, `gateBundleStore`, `gateBundleTrust`, `gateCommands`, `gateDocs`, `gateRouting`, `gateRouteTiers`, `gateRouteGuard`, `gateRecords`, `gateRecordIds`, `gateTrustBadge`, `gateOutbound`, `gateLabels`, `gateDominance`). Helpers in `src/test/helpers/` (`vscodeStub.ts`: `createVscodeStub`, `installVscodeStub`, `createFakeContext`; `gateFixtures.ts`; `gateBundleChild.ts`). No `src/test/fakes/` yet.

### K. Release and docs

Version 0.4.35; `CHANGELOG.md` `## Unreleased` / `### Fixes`. SECURITY.md sections F1 updates: "Which models are private" (42), "The trust badge on each answer" (58), "Your policy file and decision records" (335, "Your own device key, held on this computer, signs it"), "Classification labels and routing" (465), "The outbound check" (1163), "Known limitations" (1908). `gateDocs.test.ts` (79-100) asserts phrases of the policy section.

## Safety patch interaction

The `fix/safety-patch` worktree had no edits at 2f9b922b. Functions on main each item must change:

| Item | Functions on main | After it | Phase 41 extends | Collision |
|---|---|---|---|---|
| **S1** | `isLocalRouteHost` (`routing.ts:227`), `whyNotLocal` (369), `decideAttested` (393), `decideRoute` (416), `ROUTE_RULES` (309), `ROUTE_REFUSALS` (333), likely `RouteFacts` (288) and `hostnameOf` (210); `checkRoute` (`nearAiClient.ts:1242`); a one-time notice in `host.ts` or `gateCommands.ts`; SECURITY.md routing | exact host and https for local-only levels; classified and Protected C never off loopback; `route.not-accredited` | FND-03 encodes S1 as endpoint `scheme` and ceilings; FND-05 adds the `accredited-device` authorization, report mode | High: same functions |
| **S4** | `routeAllows` (`agentSession.ts:279`), `fallbackModelsFor` (`gsd/library.ts:267`), `OutboundGuard.check` (`outboundGuard.ts:37`), `privacyPreflight.ts:128,156`, `modelPrivacyLabel` (`chatBridge.ts:138`), `chooseTeamModel`/`chooseImageModel` (`teamStudioAi.ts:50,128`), a floor on `SessionRoute` (`sessionMark.ts:58`) or `RouteFacts`, `decideRoute`, `checkRoute` | `decideRoute` takes a minimum tier; private asks pass the bound-connection check; picker says "NEAR AI private hardware (checked each time it is used)" | FND-06 retires `SovereigntyMode`, moves `routeAllows` out of `agentSession.ts`, makes the floor one input of the endpoint-centric decision, `TrustFacts` replaces the picker word | High: `decideRoute` signature, `agentSession.ts` |
| **S6** | `BUNDLE_FIELDS` (95), `parseBundle` (491), `RESET_FIX`/`BUNDLE_FAILURES` (563-594), `shapeReason` (621), `failedClosed` (605), likely a "signed here" fact on the failed state from `verifyBundleEnvelope` (678); `policyDocumentText`, `resetPolicy` (`gateCommands.ts:119,748`); `policyProblem` (`gateStatusBar.ts:33`); `ROUTE_CHECK_FAILED_TEXT` (`routing.ts:344`); `gateDocs.test.ts` | optional `requires` in v1; any id refuses `needs-update` ("update the extension"); Reset offered only when this device signed | FND-02 turns the id check into a feature registry and adds sections and layers | High: Plan 41-01 starts from the patched parser |
| **S7** | `rankOf`, `labelAtLeast`, `joinTemplateLabels` (`observation.ts:153-172`) and six callers; `scaleMarkings`, `guardScan` header (`guardScan.ts:86,238`); `markOf`, `raiseBy`, `judgeChatLowering` (`chatLabel.ts:61-110`); scales from `labelPolicy` (`host.ts:269`) | three evaluators use the active scales; presets only when failed closed | FND-06 adds `atLeast`, `meetClearance`, `parseLabelKey` and replaces the string helpers; architecture test bans `SCALE_PRESETS` with the rest in the baseline | Medium |

S2 and S8 also touch `routing.ts` lists and `gateCommands.ts` `labelShown`; Group B edits `gateCommands.ts` after S8.

## Bundle v2 in code (plan 41-01)

1. **One normalised document, two wire forms.** `parsePolicyDocument` accepts `bundleVersion: 1` (today plus S6's `requires`) and `2` (sections) and returns one v2-shaped `PolicyDocument`. v1 maps per POLICY-SCHEMA 3 (`ceiling` to `agents`; scales, mappings, defaultLabel, routing to `labels`; `localHosts` to `endpoints`; `clearances` to `people.clearances`). Signed bytes and `bundleHash` unchanged; only an Edit writes v2. `parseBundle` stays as a wrapper returning today's view.
2. **Feature registry.** `src/domain/gate/features.ts`: `KNOWN_FEATURES` keyed `endpoints@1`, `authorizations@1`, `residency@1`, `models@1`, `people@1`, `onboarding@1`, `limits@1`. A section present without its id in `requires` is malformed; an id the table lacks is `needs-update`. Groups D and F each add one line.
3. **Layer envelope.** `layer: 'organization' | 'personal' | 'project'`, `parent?: { hash, issuer }`; v1 reads as `personal`.
4. **`endpoints[]`.** POLICY-SCHEMA 5 with three changes: `ceiling: Clearance[]` instead of `maxLabel` (pitfall 3); `tlsPins: string[]` (one to four 64-hex SPKI hashes); `scheme: 'https' | 'http-loopback'` checked against the host. Classes `local`, `org-plain`, `org-tee`, `nearai-tee`, `vendor-tee`, `vendor-region`, `forwarded`, `closed-api`. Sorted by `id`, unique.
5. **`authorizations[]`.** Each entry is a `SignedPayload<AuthorizationBody>` with new purpose `policy-authorization`. Body: `id`, `kind` (`protected-b`, `t1-risk`, `accredited-device`, `residency-exception`, `declassify`), `subject` (endpoint, model, device or item id), `scope` (`projects`, `labels`, `uses`), `conditions`, `evidence`, `namedPerson: { name, role }`, `issuedAt`, `expiresAt` (90 days for `t1-risk` per provenance O3; 365 for `protected-b` per Cohere 6.3; 365 recommended for the rest), `revokedBy?`. The envelope's `signer.publicKey` and `sig` are the inner signature (secret-scanner exempt). Verify with `status` built from `people.signers` in the organization layer, or this device alone when there is none, which is the "self-signed on this computer" case.
6. **Ids the D-49 way.** Route rules `route.residency`, `route.endpoint-ceiling`, `route.endpoint-pin`, `route.authorization-missing`; policy events `policy.enrolled`, `policy.organization-updated`, `policy.migrated`, `policy.proposal-exported`, `policy.reset-personal`; purposes `org-enrolment`, `policy-authorization`, `policy-proposal` (after Phase 32's three if merged).
7. **Size.** 256 KiB may not hold up to 256 passports plus endpoints; give the organization layer `maxBytes` 1 MiB (the verifier takes it) and raise the file cap in step.
8. **Numbers.** No fractions: `limits.spend` in nano-USD (`dailyNanoUsd`).

## Enrolment and the pin (FND-01)

- **File** `.near-org-enrolment`, capped at 64 KiB before parsing, read as hostile input: `SignedPayload` purpose `org-enrolment`, signed by the issuer key itself (self-signed root). Payload: `v: 1`, `organization: { name, contacts }`, `issuer: { fingerprint, publicKey, did? }`, `issuedAt`, `expiresAt`, `serial`, `rotation?: { previous: { fingerprint, publicKey }, sig }`, and the first organization layer, so "enrolled with no rules" cannot exist.
- **Words:** twelve words from `SAFETY_WORDS` over SHA-256 of `near-ai/org-issuer/v1` and the raw key (132 bits). Modal: "Ask your security contact to read their twelve words. Compare them with these: ..." with one button `The twelve words match`; hex fingerprint under details.
- **Pin** in SecretStorage (`nearAi.gate.organizationIssuer`) with the last accepted `issuedAt`; files under `gate/organization/`. `earlierInstallEvidence` counts that folder. Write the layer file first with the pin as pending, then the pin (the `announceNextHash` pattern).
- **Updates:** accept a later file only when signed by the pin and newer than the last accepted; expired fails closed ("Your organization's rules ended on {date}. Ask {contact} for the current rules.") with the 30-day renewal notice.
- **Key sources stay separate:** organization layer against the pin only; personal layer against `localKeyStatus` only; authorizations against named signers only. Never `combineKeyStatus` across them.
- **Issuer tooling:** recommended `scripts/org-issuer.mjs` (create issuer key file kept offline, sign enrolment and layers, rotation) plus in-memory test fixtures (open question 2).

## Layer composition (FND-01)

- `composeLayers({ organization?, personal, project? }) -> { effective, ignored }` in `src/domain/gate/layers.ts`.
- `NARROWING` table: one direction per key path (`tier-stricter`, `subset`, `number-lower`, `ceiling-dominated`, `boolean-safe`, `organization-only` for `people.signers`, `onboarding.contacts`). A test enumerates every accepted key and fails when one lacks a direction.
- At load a wider personal value is replaced by the organization value and listed in `ignored` ("These personal settings are wider than your organization allows and have no effect"); a new personal edit that widens is refused with the key named.
- Reset under an organization layer re-signs only the personal layer. The personal file is always this device's, so Reset stays available for it even when unreadable; never for the organization file.

## Module layout and FILE OWNERSHIP

| Group (wave) | Requirement | Owns (new unless "changes") |
|---|---|---|
| **41-01 Schema contract** (wave 1, alone, after the safety patch) | FND-02, FND-03 schema, FND-04 | `src/domain/gate/policyDocument.ts`, `features.ts`, `endpoints.ts`, `authorizations.ts`, `src/test/helpers/policyFixtures.ts`; changes `bundle.ts`, `record.ts` (version literal), id lists in `routing.ts`, `src/domain/team/signedPayload.ts`, `gateBundle*.test.ts`, `teamSignedPayload.test.ts` |
| **B Layers and enrolment** (wave 2) | FND-01 | `layers.ts`, `enrolment.ts`, `src/gate/organizationStore.ts`; changes `src/gate/bundleStore.ts`, `host.ts`, `installEvidence.ts`, `src/services/gateCommands.ts` |
| **C1 Decision core** (wave 2) | FND-03 migration use, FND-05, FND-06 pure | `residency.ts`, `trust.ts`; changes `routing.ts` (functions), `labels.ts`, `dominance.ts` |
| **D Modes and copy lint** (wave 2) | FND-07 | `src/domain/org/modes.ts`, `terms.ts`, `peopleSection.ts`, `src/test/copyLint.test.ts`, `copy-lint-baseline.json`; one line in `features.ts`; a `domain/org` rule in `teamBoundaries.test.ts` |
| **F Passports** (wave 2) | FND-08 | `src/domain/gate/models.ts`, `shippedPassports.ts`; one line in `features.ts` |
| **G Provider and architecture test** (wave 2) | FND-09 | `src/domain/provider/messages.ts`, `endpoint.ts`, `localServer.ts`, `src/test/architecture.test.ts`, `architecture-baseline.json`; changes the top and class line of `nearAiClient.ts`, `agent/loop.ts`, `agent/context.ts`, `agent/safetyModel.ts`, `domain/state/threadView.ts`, `threadCapture.ts` |
| **E Editor shell** (wave 2) | FND-09 | `src/domain/gate/proposal.ts`, `src/services/policyEditor.ts`, `media/policy/policy.js`, `policy.css` |
| **C2 Fold-in** (wave 3, after C1 and G) | FND-06 wiring | `src/services/privateRoute.ts`; changes `nearAiClient.ts` (`checkRoute`), `sessionMark.ts`, `outboundGuard.ts`, `privacyPreflight.ts`, `domain/privacy.ts`, `domain/config.ts`, `domain/multimodal.ts`, `gsd/library.ts`, `agentSession.ts` (imports), `teamStudioAi.ts`, `chatBridge.ts`, `modelComparisonPage.ts`, `observation.ts` and callers, `guardScan.ts`, `chatLabel.ts`, `trustBadge.ts` |
| **Integration** (wave 3, last) | all | changes `package.json` (enrol, import rules, open editor; `privacyMode` text), `src/extension.ts`, SECURITY.md, README.md, CHANGELOG.md, `gateDocs.test.ts`; the "baseline is tight" check and the one full run |

Order: 41-01 first because every group imports its types and its signed shapes are expensive to change (undo-cost note). C2 is sequential after C1 (functions) and G (both touch `nearAiClient.ts`). Shared lines: `features.ts` (D, F, one line each), `routing.ts` (41-01 lists, then C1 functions). Phase 32 overlap: append purposes after its three; leave `replicaBoundaries.test.ts` alone (keep both boundary tests until the move PR); leave `staffMultiUserCommands.ts` and `membership.ts` in the baseline.

## Common Pitfalls

1. **Building on main instead of the patch.** Plans 41-01 and C rewrite what S1, S4, S6 change. First task of each plan: check `requires`, `needs-update`, `route.not-accredited` and the S4 floor exist on the base. Warning sign: a plan that defines `needs-update`.
2. **A second root mixed into the first.** `combineKeyStatus(localKeyStatus, pin)` would let this device sign an "organization" layer (K1). Test: a layer signed by the device key is `unknown-key`.
3. **`maxLabel` as one label.** One `scale/level` cannot say "Protected B and org Restricted"; cross-scale needs a mapping. Use `ceiling: Clearance[]` with `markDominated` (the `mcpLabelCeilings` shape per server). Warning sign: tests only on `org`.
4. **"Today's effect" vs "Protected B needs a pin".** After S1 an exact https entry may take Protected B unpinned; criterion 3 refuses it. Migrate exact https entries with a ceiling up to the levels that need no pin (org Confidential, Protected A, NATO Unclassified) and say in the notice that Protected B now needs a pin. A narrowing, but owner-visible (open question 1).
5. **Six words for a static key.** 66 bits is a second-preimage target with unlimited time. Twelve words, separate domain; test the domain differs from `SAFETY_CODE_DOMAIN`.
6. **Inner signature names the scanner flags.** `signature` and `namedPerson.key` are not exempt; carry each authorization as a `SignedPayload` (exempt `publicKey`, `sig`). Test: 2,000 random authorizations sign without refusal.
7. **Fractions in a signed policy.** `checkNumbers` refuses `12.5` and fails the whole bundle. Integers with the unit in the name.
8. **Lock-out on enrolment.** Refusing a wider personal layer at load fails the policy closed on day one; clamp and list instead.
9. **Rollback and freeze.** Stored last `issuedAt`, refuse older, expiry fails closed, renewal notice.
10. **Baseline tests that fight parallel plans.** Per-plan tests fail only on new or increased violations; the "baseline is tight" check runs once in Integration.
11. **Frozen files grow.** Move `routeAllows` and `privateRefusal` to `src/services/privateRoute.ts` and the facts part of `checkRoute` to a pure `routeFactsFor`; the size budget proves it.
12. **SECURITY.md drift.** `gateDocs.test.ts` asserts today's sentences; Integration edits docs and test together, with exact-text checks for the words, the self-signed sentence and `needs-update`.
13. **Treating `teeOnly` as live.** Nothing reads it; record the mapping for L2 only.
14. **Designs citing missing paths.** First task of each plan checks every cited path.

## State machines touched

1. **Policy load** (`GateHost`): `starting`, `valid` (with `renewDue`), `failed-closed(reason)`, plus `needs-update` (S6) and `organization-expired`. An organization failure fails the whole policy closed (never fall back to personal alone); a personal failure fails closed with personal Reset offered; both valid compose to `valid`. Ambiguous: failed closed with an unknown signer must still offer Reset for the personal file, never for the organization file. Stuck risk: expired organization layer with an unreachable contact (30-day notice, contact named).
2. **Enrolment:** `not-enrolled` to `file-read` (cap, parse, self-signature) to `words-shown` to `confirmed` (layer installed, pin written, `policy.enrolled`) or `declined` (nothing written). From enrolled: `layer-updated` (newer), `rotated` (signed by the old key, words shown again), `refused` (older, wrong issuer, expired). No unenrol in Phase 41 (open question 3). A pending pin with no layer reads as not enrolled.
3. **Composition:** organization absent, valid or failed; personal valid or failed; project absent or valid; output effective plus `ignored`. Closed ambiguity: personal wider than organization (clamp, list, never fail).
4. **Migration notice:** `v1-with-localHosts` read as v2, notice pending; shown once (`policy.migrated`, a `globalState` flag); the next Edit writes v2. A lost flag only repeats the notice.
5. **Proposal:** `drafted`, `shown`; personal layer `applied` (`policy.edit`) or `discarded`; organization layer `exported` (`policy.proposal-exported`, signed `policy-proposal` file) then `pending` until a newer organization layer arrives (`resolved` or still pending with its date; discardable); `stale` when the base hash changed (`STALE_DRAFT_TEXT`, D-53).
6. **Route decision:** after today's tier, local and attested checks, in order: endpoint by exact host, ceiling, authorization (Protected B off-organization), accredited (report: record `route.not-accredited`, allow), residency, passport (report: `wouldRefuse`), floor (S4). One rule and one sentence per refusal; report mode never refuses.

## Assumptions Log

| # | Claim | Section | Risk if wrong |
|---|---|---|---|
| A1 | Lattice meet and join as in Bell-LaPadula | Prior art | Low: the repository already joins this way |
| A2 | S4 adds a floor to `decideRoute` or `SessionRoute`; S6 adds a signer fact to the failed-closed state | Safety patch | Medium: re-read the merged patch and adjust names |
| A3 | 1 MiB fits an organization layer | Bundle v2 | Low: a constant |

## Open Questions (recommended defaults)

1. **Migrated `localHosts` and Protected B.** Migrate up to the levels that need no pin; Protected B needs the organization to add `tlsPins`. Needs owner confirmation (it can refuse a setup S1 still allowed).
2. **Issuer tooling.** `scripts/org-issuer.mjs` in Phase 41, documented in SECURITY.md; no UI.
3. **Leaving an organization.** No command in Phase 41; only an issuer-signed release (reserve purpose and schema) or a full reset of the extension's storage (the existing "new computer" case).
4. **Project layer source.** Type, parser and composition with an in-memory input in Phase 41; the single-machine source with 32.1, the shared source with 33.1.
5. **Copy lint scope.** As in audit F.
6. **Local audit hash chain (ADR-011).** Out of Phase 41 (not in FND-01 to FND-09); note it for 32.1's record writer.
7. **Listing on `ModelEndpoint`.** Stays on the concrete class until 32.2.

## Environment Availability

Code and test only. Node and npm build the repository; `systemd-run`, `choom`, `flock` are the standard wrappers. No hub, relay or network service needed.

## Validation Architecture

| Property | Value |
|---|---|
| Framework | `node:test`, `node:assert/strict`, compiled by `tsc` to `dist/test` |
| Quick (one file) | `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 300 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'npm run compile && node scripts/run-tests.mjs dist/test/<file>.test.js'` |
| Full (phase gate) | `flock "$HEAVY_LOCK" systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 1800 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'npm run compile && node scripts/run-tests.mjs dist/test/*.test.js scripts/test/*.test.mjs'` |

| Req | Behaviour | Test files (new unless "extend") |
|---|---|---|
| FND-01 | narrows only; widening edit refused with key named; wider personal clamped; direction table complete; device-signed organization layer refused; twelve words, distinct domain; pin in SecretStorage; older layer refused; expiry fails closed; Reset personal only; crash between layer and pin | `gateLayers`, `gateEnrolment`, `gateOrganizationStore`, `gateBundleStore` (extend) |
| FND-02 | v1 default reads as v2 with the same effective view and hash; unknown feature `needs-update`, no Reset text; section without its id malformed; first Edit writes v2 | `gateBundleV2`, `gateBundle` (extend) |
| FND-03 | endpoint schema; each `localHosts` form migrates; notice once | `gateEndpoints` |
| FND-04 | kinds; maximum expiry per kind; verified only against named signers; self-signed flag; 2,000 random signings | `gateAuthorizations`, `teamSignedPayload` (extend) |
| FND-05 | `route.residency`; residency exception; accredited report records and allows | `gateResidency` |
| FND-06 | decision table per class and tier, floors, pin and authorization for Protected B; `TrustFacts`; `atLeast`, `meetClearance`; staff helpers agree with the gate on a custom scale; `privacyMode` and `privacy: private` through `decideRoute` | `gateDecideRoute`, `gateTrustFacts`, `gateLabelModule`, `gateRouting`, `gateRouteTiers`, `gateRouteGuard`, `gateOutbound` (extend) |
| FND-07 | four modes, every concept key, behaviour table, declining never in assignment modes; lint passes with baseline, fails on a planted hit | `orgModes`, `copyLint` |
| FND-08 | each WP-0 refusal; stricter overlapping match; `useTierFor` table; report mode | `gatePassports` |
| FND-09 | `NearAiClient` assignable to `ModelEndpoint`; fake endpoint drives the loop; architecture test has teeth and passes with baseline; proposal directions and sentences | `providerEndpoint`, `architecture`, `gatePolicyProposal` |
| Docs | SECURITY.md and README word for word | `gateDocs` (extend) |

**Sampling:** per task, the one changed test with the quick command (signing, layer and routing tests blocking); per wave merge, the gate set (`gate*.test.js`, `teamSignedPayload`, `teamBoundaries`, `replicaBoundaries`, `architecture`, `copyLint`, the staff obs tests) with the quick wrapper; phase gate, the full suite once. **Wave 0 gap:** shared signed-layer and enrolment fixtures (`src/test/helpers/policyFixtures.ts`) belong to 41-01.

## Security Domain

| ASVS | Applies | Control |
|---|---|---|
| V4 access control | yes | narrowing-only composition, default deny, `decideRoute` |
| V5 input validation | yes | `checkKeys` parsers, size caps before parse, own properties only |
| V6 cryptography | yes | the one Ed25519 signer, SHA-256, nothing hand-rolled |
| V9 communications | yes | https off loopback, SPKI pins via `pinnedFetch` |

| Threat | STRIDE | Mitigation |
|---|---|---|
| Self-signed organization rules or authorizations | Elevation | separate key sources; "self-signed on this computer" |
| Swapped enrolment file | Spoofing | twelve words, pin in SecretStorage |
| Older organization layer put back | Tampering | stored `issuedAt` |
| Withheld updates | Denial | expiry fails closed, renewal notice |
| Protected B over an unpinned link | Disclosure | https, `tlsPins`, ceiling, authorization |
| Wider personal settings | Elevation | per-key directions |

## Sources

**Primary (HIGH):** repository at 2f9b922b (every `src/` path above); `git diff --stat origin/main...feat/phase-32-*`; `.planning/research/coherence/*`; `.planning/ROADMAP.md` Phase 41; model provenance design 5, 8.3, 12, 14; portfolio design 5; guided onboarding 4, 6.4, 9, 12; Cohere vault 5, 6, 7.5.

**Secondary (MEDIUM, fetched this session):** https://theupdateframework.github.io/specification/latest/ ; https://git-scm.com/docs/repository-version ; https://docs.cedarpolicy.com/auth/authorization.html ; https://support.google.com/chrome/a/answer/9037717 ; https://kubernetes.io/docs/reference/access-authn-authz/validating-admission-policy/ ; https://www.rfc-editor.org/rfc/rfc7469 ; https://signal.org/blog/safety-number-updates/ ; https://firefox-admin-docs.mozilla.org/guides/policies-configuration/

**Tertiary (LOW):** Bell-LaPadula summary, training knowledge, tagged [ASSUMED].

**Valid until:** the safety patch merges (then re-check the S-item names), or 14 days.
