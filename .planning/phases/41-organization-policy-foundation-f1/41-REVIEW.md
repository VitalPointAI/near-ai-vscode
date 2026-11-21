---
phase: 41-organization-policy-foundation-f1
reviewed: 2026-11-20T00:00:00Z
depth: deep
files_reviewed: 29
files_reviewed_list:
  - src/gate/organizationStore.ts
  - src/gate/bundleStore.ts
  - src/gate/host.ts
  - src/gate/sessionMark.ts
  - src/gate/installEvidence.ts
  - src/domain/gate/enrolment.ts
  - src/domain/gate/policyDocument.ts
  - src/domain/gate/layers.ts
  - src/domain/gate/routing.ts
  - src/domain/gate/endpoints.ts
  - src/domain/gate/authorizations.ts
  - src/domain/gate/residency.ts
  - src/domain/gate/trust.ts
  - src/domain/gate/trustBadge.ts
  - src/domain/gate/models.ts
  - src/domain/gate/sections.ts
  - src/services/nearAiClient.ts
  - src/services/privateRoute.ts
  - src/services/policyEditor.ts
  - src/services/policyEditorWiring.ts
  - src/services/organizationRules.ts
  - src/services/gateCommands.ts
  - src/services/gateStatusBar.ts
  - src/services/outboundGuard.ts
  - src/services/teamStudioAi.ts
  - src/services/webview/openPanel.ts
  - media/policy/policy.js
  - media/chat/trustBadge.js
  - scripts/org-issuer.mjs
findings:
  critical: 2
  warning: 5
  info: 9
  total: 16
  necessity: 0
status: issues_found
---

# Phase 41: Code Review Report

**Reviewed:** 2026-11-20
**Depth:** deep (security focus)
**Files Reviewed:** 29
**Status:** issues_found

## Summary

Scope: the non-test source of `git diff origin/main...HEAD` on the Phase 41 branch, with the security paths read in full (organization store, enrolment, policy document v2, layers and narrowing, the decision function and its policy steps, authorizations, residency, the route policy wiring in the host and session mark, the client's pinned send, the policy editor page and its message handling, and the issuer script). Read for context only: proposal.ts, modes.ts, peopleSection.ts, shippedPassports.ts, useTier.ts, the label module changes and the two lint/architecture tests.

Severity words in this file: **Critical** (CR) is a blocker, **Warning** (WR) is what the caller called major, **Info** (IN) is minor.

What holds up well: the size caps run before every parse of hostile input; own-property reads and exact-key checks are consistent; the three key sources are not mixed (the organization layer is verified only against the pin, the personal layer only against this device's key history, authorizations only against `people.signers` or this device); rollback by an older or same-time organization layer is refused; a v1 bundle cannot be presented as an organization layer (purpose and layer must agree); the composition clamps every key the parsers accept, and the widening check at Apply is only a user-experience gate because load-time composition clamps anyway; the webview builds everything with `textContent`, the CSP is `default-src 'none'` with a nonce, and every page message is re-checked on the host.

Four findings were confirmed with an ad-hoc probe against the compiled `dist` (temporary folders and in-memory secrets only; no source touched): CR-01, CR-02, WR-01 and WR-03.

Necessity was not assessed separately (no necessity findings recorded).

## Critical Issues

### CR-01: Losing the pin silently drops your organization's rules (fail open to the personal layer)

**File:** `src/gate/organizationStore.ts:505-507` (with `readOrganizationPin` at 178-182)
**Issue:** `loadAt` returns `{ state: 'none' }` whenever the SecretStorage entry `nearAi.gate.organizationIssuer` is absent, even when `<globalStorage>/gate/organization/` holds a committed layer and enrolment record. With the D-57 write order (pending pin first, then files, then commit), files on disk with no pin are never a crash state of this store: every failed write removes its files and restores the old pin. So "layer present, pin absent" means the secret was lost (keyring reset, VS Code switching `--password-store`, a profile copied without its secrets, or the person running `secret-tool clear`). The result is that the personal layer alone becomes the policy, with no record and no notice. D-13 put the pin in SecretStorage "so a disk writer cannot reset" it, but removal of the secret is the easier attack and is not covered; D-16 says the only way out of an organization is a full storage reset.

Confirmed by probe: enrol with a layer that sets `org/Internal` to `local-only`, delete the secret, start a new host: state `valid`, organization `none`, `org/Internal` back to `attested-cloud`.

**Fix:** treat "pin absent and the organization folder holds a layer or an enrolment record" as damaged, not as never enrolled. The pending-enrol state already covers the crash of a first enrolment.
```ts
if (read.state === 'absent') {
  const leftovers = await namesInOrganizationFolder();          // layer or enrolment.json present
  if (leftovers.length > 0) return failedOrganization('damaged-pin', 'malformed', DAMAGED_PIN_TEXT, false);
  return { state: 'none' };
}
if (read.state === 'pending-enrol') return { state: 'none' };
```
Also clear the folder (move it aside) when a first enrolment's write fails, so a leftover from that path cannot lock the person out; add a test for "secret deleted after enrolment fails closed".

### CR-02: Residency (and the trust line) read the place from the host only, so a forwarded model on a listed NEAR AI host passes a residency rule

**File:** `src/domain/gate/routing.ts:682-695` (`placeOf`), used by the residency step at `routing.ts:769-774` and by `trust.ts:63-75`
**Issue:** for a listed entry, `placeOf` takes `entry.class` and `entry.region` from the host match alone and ignores the model. When your organization lists NEAR AI Cloud's host as `class: 'nearai-tee', region: 'CA'` (the shape D-24 exists for), a request for a model NEAR AI forwards to an outside provider (`privacyBoundary !== 'tee'`) is still treated as running on NEAR AI private hardware in Canada. At any level the routing table sends to `any-cloud` (org/Public by default, or org/Internal in a "any cloud, but in Canada" policy), `residency.required: ['CA']` is satisfied and the content goes to the outside provider. The implicit path (no entry) already does the right thing (`forwarded`, `unstated`); the listed path does not. The trust line then says "Runs on NEAR AI private hardware in Canada" for a forwarded answer, and the passport step's hosting check uses the wrong class (report only today, enforcement in 74.1).

Confirmed by probe: entry `{ class: 'nearai-tee', host: 'cloud-api.near.ai', region: 'CA' }`, model `privacyBoundary: 'cloud'`, `residency.required: ['CA']`, mark org/Public: allowed, endpoint reported as `nearai-tee`, `CA`.

**Fix:** derive the effective place from both the entry and the model; a non-TEE model on a `nearai-tee` (or `org-tee`, `vendor-tee`) entry is `forwarded` with region `unstated` and no ceiling credit:
```ts
if (found.kind === 'listed') {
  const entry = found.endpoint;
  const teeClass = entry.class === 'nearai-tee' || entry.class === 'org-tee' || entry.class === 'vendor-tee';
  if (teeClass && facts.model?.privacyBoundary !== 'tee') {
    return { endpoint: implicitPlace('forwarded') };   // residency then sees 'unstated'; ceiling/authorization steps cannot use the TEE entry
  }
  ...
}
```
Add a residency test with a forwarded model on a listed `nearai-tee` entry, and a trust-line test for the same case. Consider also refusing at parse time a `nearai-tee` entry whose host is not a NEAR AI Cloud host (see IN-07).

## Warnings

### WR-01: A missing or replaced organization layer cannot be repaired with the current rules file; the person is stuck failed closed

**File:** `src/gate/organizationStore.ts:368`, `391`, `642` (and the sentence at `514`)
**Issue:** when the layer file is missing (or a disk writer put an older signed layer in its place), `loadAt` fails closed and the sentence tells the person to "Ask {contact} for the rules file, then run Add Your Organization's Rules". Doing exactly that with the rules in use gives `kind: 'same'` (the file's hash equals `pin.layerHash`), `accept` returns without writing anything, and `addOrganizationRules` says "These are the rules already in use. Nothing was changed." The policy stays failed closed until your organization issues a newer file. The same happens with the pinned key's own enrolment file. A crash during an update after the old layer was renamed aside (`organizationStore.ts:675-678`) and before the new one was written also lands in `missing`, although the old layer is sitting next to it as `.replaced-<ms>` and D-57 promises that an update finishes at the next start.

Confirmed by probe: enrol, delete the layer file, start: `failed-closed missing`; add the same enrolment file again: still `failed-closed missing`, also at the next start.

**Fix:** in `accept`, for `same`, check the files on disk (layer reads back with `pin.layerHash`, record present) and rewrite them when they do not, without moving the pin; `previewOrganizationFile` should then report `repair`, not `same`. Replace the rename-aside-then-write in `write()` with a copy to `.replaced-<ms>` followed by `writeFileAtomic` over the original, so there is no window with no layer file.

### WR-02: A throw while building the route policy is swallowed and the request is decided without any policy step

**File:** `src/gate/host.ts:742-749` (`routePolicyNow`), consumed at `src/services/nearAiClient.ts:1186-1190`
**Issue:** `routePolicyNow` catches every error and returns `undefined`, and `decideRoute` with no policy decides "as the safety patch did": no endpoint list, no ceiling, no TLS pin, no `protected-b` authorization, no residency. Because the view's `routing.localHosts` is every `org-plain` host of the effective policy (`policyDocument.ts:314-316`), including personally approved Public-only ones, Protected B, NATO Restricted and org/Restricted would then go to any exact https `org-plain` host with no pin and no authorization. The client comment says "A throw is a failed check", which is what should happen, but the host converts the throw into "no policy". Nothing obvious throws today, so this is latent, but it is exactly the fail-open shape the phase is meant to remove.

**Fix:** let a throw propagate (the client already turns it into `routeCheckFailed()`), and return `undefined` only for the legitimate "no effective policy" states:
```ts
private routePolicyNow(now: number): RoutePolicyNow | undefined {
  const layers = this.policyLayers();
  return routePolicyFor(layers, now, this.deviceFingerprint(), policyVersionOf(layers));
}
```
Add a test where `routePolicy` throws and the request is refused with `route.deny` and `ROUTE_CHECK_FAILED_TEXT`.

### WR-03: `endpoints[].scheme` is parsed and signed but never enforced

**File:** `src/domain/gate/routing.ts:715-805` (no scheme check), `src/domain/gate/endpoints.ts:194-196`, `endpoints.ts:370-371` (migration writes `https`)
**Issue:** D-24 says `scheme` is `https`, or `http-loopback` only for a loopback host. Nothing in `decideRoute` reads it. For levels at `attested-cloud` (org/Internal, org/Confidential, Protected A, NATO Unclassified) the table check uses `named` strictness, which accepts plain http, and the policy steps only look up the entry by host. So content at those levels goes in cleartext over the network to an entry your organization declared `https`. Migrated `localHosts` entries are written as `scheme: 'https'` whatever the runtime uses, so the stored policy claims a protection that does not exist.

Confirmed by probe: entry `{ class: 'org-plain', host: 'llm.example.org', scheme: 'https', maxLabel: ['org/Confidential'] }`, local client at `http://llm.example.org:8080/v1`, mark org/Internal: allowed (`route.attested-cloud`).

**Fix:** in the policy steps, for a listed entry that is not `local`, refuse when `!usesHttps(facts.host)` (reuse `route.endpoint-pin` or name a new rule ahead), and record the migration's real effect: either keep migrated entries' http behaviour and say so in the notice, or tell the person in the migration notice that http to those hosts now stops.

### WR-04: The issuer key file uses PBKDF2 with 2048 iterations, and nothing checks the file is encrypted

**File:** `scripts/org-issuer.mjs:205-207`, `139-167`
**Issue:** `generateKeyPairSync(..., { cipher: 'aes-256-cbc', passphrase })` writes PKCS#8 PBES2 with PBKDF2-HMAC-SHA256 at OpenSSL's default of 2048 iterations (checked with `openssl asn1parse` on a key made the same way). This file is your organization's root of trust and is meant to be kept offline where an attacker who copies it can guess without limit; 2048 iterations with a 12-character minimum is weak. Separately, `signerFor` accepts an unencrypted `privateKeyPem` (Node ignores the passphrase for an unencrypted key), so a key file someone decrypted "temporarily" keeps working silently, and `create-key` never proves the passphrase opens the key it just wrote.
**Fix:** derive a wrapping key with `crypto.scrypt` (for example N=2^17, r=8, p=1) and store the private key as AES-256-GCM ciphertext with the salt and parameters in the key file; or at least re-encrypt with an explicit high iteration count via `openssl`-compatible PBES2 parameters. In `readKeyFile`, refuse a PEM that is not an encrypted PKCS#8 key. In `createKey`, call `signerFor(dist, out, passphrase)` after writing.

### WR-05: Report-only policy steps can still refuse a request by throwing

**File:** `src/domain/gate/routing.ts:776-792` (passport step), `753-768` (accredited-device report)
**Issue:** D-36 says report mode never refuses. The passport step (and the accredited-device report) run inline in `decidePolicySteps`; any exception there (a malformed passport date, a future change to `resolvePassport`, a mapping edge case) escapes `decideRoute`, and the client's catch turns it into `routeCheckFailed()`, a refusal of every request under that policy. Nothing obviously throws today; the gap is that the "never refuses" promise rests on these functions never throwing rather than on the structure.
**Fix:** wrap each report-only step in its own `try { ... } catch { wouldRefuse.add(rule) }`, so a failure is recorded as `wouldRefuse` and never changes `allowed`; add a test with a passport section whose step throws.

## Info

### IN-01: A same-key enrolment update keeps the old serial, so an abandoned older handover still applies

**File:** `src/gate/organizationStore.ts:368-370`
**Issue:** when the pinned key's own enrolment file updates the layer, the pin keeps `pin.serial` even when the file's serial is higher. A handover file your organization made earlier and then abandoned (serial between the two) still reads as `rotate` because only `serial > pin.serial` is checked.
**Fix:** on `update` from an enrolment file, pin `Math.max(pin.serial, enrolment.serial)`.

### IN-02: The widening check compares truncated display text

**File:** `src/domain/gate/layers.ts:1045` (with `shortText` at 386-389)
**Issue:** `wideningOf` treats an entry as already ignored when `key` and `yours` match, and `yours` is cut to 80 characters. A new, wider value whose first 77 characters equal those of an already clamped value is not refused before signing. Load-time composition still clamps it, so only the D-20 "refused before signing" promise is affected.
**Fix:** compare `stableText` of the full value (keep it on `Pending`) instead of the display text.

### IN-03: `requireAccreditedDevice` can be turned on by the personal layer

**File:** `src/gate/sessionMark.ts:251`, `src/domain/gate/layers.ts:146`
**Issue:** D-34 says the accredited-device rule refuses only when an organization layer is present "and says so". The value read is the effective one, and the narrowing rule lets the personal layer set it to `true`, so under any organization layer the person's own setting turns refusal on. This is a narrowing, so not a security hole, but it differs from the decision text and from the tests' framing.
**Fix:** read `layers.organization.document.agents.requireAccreditedDevice` for the switch, or record the decision change in CONTEXT.

### IN-04: Personal layers carry `parent` but nothing checks it

**File:** `src/gate/bundleStore.ts` (`personalLayerPayload`), `src/domain/gate/layers.ts:834`
**Issue:** a personal layer names the organization layer hash it narrowed, and renewal keeps it, but no reader compares it with the organization layer in force. Harmless today (composition always uses the current organization layer), but the field suggests a guarantee that does not exist.
**Fix:** either surface "your settings were made against older rules" when `parent.hash` differs, or document that `parent` is informational.

### IN-05: `.replaced-<ms>` copies of organization files accumulate without limit

**File:** `src/gate/organizationStore.ts:711-729`
**Issue:** every update keeps the old layer and record aside and nothing ever prunes them; with daily rules updates the folder grows indefinitely. Not a safety issue (files are never read back).
**Fix:** keep the last few copies, or document the growth.

### IN-06: A concurrent commit during load is reported as unreadable secret storage

**File:** `src/gate/organizationStore.ts:558-566`, `495-502`
**Issue:** when another window commits a different pin between the read and `commitFound`, the thrown error lands in `load`'s catch and the person sees "NEAR AI could not read its record of your organization's key in this computer's secret storage", which is not the cause and fails closed until reload.
**Fix:** on that specific mismatch, re-run `loadAt` once instead of failing.

### IN-07: An endpoint entry can claim `nearai-tee` for any host

**File:** `src/domain/gate/endpoints.ts:180-222`
**Issue:** nothing ties `class: 'nearai-tee'` to a NEAR AI Cloud host. Routing stays safe because the table checks need NEAR's own endpoint and a TEE model, but the trust line and residency read the declared class and region (see CR-02), so a misdeclared entry (in the personal layer without an organization, or a personally approved Public entry) makes the badge say "NEAR AI private hardware" for an outside host.
**Fix:** refuse `nearai-tee` unless `isNearCloudEndpoint('https://' + host)`.

### IN-08: Apply is offered on a personal proposal even when this device has no signer

**File:** `src/services/policyEditor.ts:191-195`
**Issue:** D-44 says Apply appears only when this device can sign the target layer. `actionsOf` offers `apply` for every personal proposal; `pageActionsOf` checks `signer()` but `actionsOf` does not. The host then creates or fails to load the identity at apply time.
**Fix:** return `['discard']` for a personal proposal when `host.deps.signer() === undefined`.

### IN-09: The private floor runs before the policy steps, not last as D-36 lists

**File:** `src/domain/gate/routing.ts:651-674`
**Issue:** D-36 orders the steps "... clearance, then the private floor (S4)". The floor is applied first, inside `decideByTable`, so when both the floor and a policy step would refuse, the record names the floor's rule. The effect (refused) is the same; only which rule is recorded differs.
**Fix:** record the decision in CONTEXT (the code's order is defensible) or move the floor check after the policy steps.

---

_Reviewed: 2026-11-20_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_

## Resolution

- CR-01, WR-01, IN-01: fixed in the organization store (branch feat/phase-41-16-review-store), each with a regression test that fails on the reviewed code.
- CR-02, WR-02, WR-03, WR-05, IN-07: fixed in routing, endpoints and the host (feat/phase-41-17-review-routing), each with a regression test.
- WR-04, IN-02, IN-08 and verification warning W1: fixed in the issuer tool, layers, the policy editor and the docs (feat/phase-41-18-review-issuer-docs), each with a regression test.
- IN-09: left as is. The private floor raises the tier the policy steps run at, so it is applied first; when both would refuse, the record names the floor's rule. The outcome is the same refusal.
- IN-03, IN-04, IN-05, IN-06: minor, left for a later phase (none widens what is allowed).
- SECURITY.md carries the new sentences, pinned by gateDocs.
