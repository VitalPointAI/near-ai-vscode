# Policy schema v2: one signed policy, sectioned, layered

Part of the coherence review (`REVIEW.md` in this folder). Written 2026-11-20 against `origin/main` at 15bc560c. Built in the foundation phase F1 (Phase 41 in `.planning/ROADMAP.md`).

## 1. What is on main today, and why it cannot carry the designs

- `src/domain/gate/bundle.ts` parses bundle v1 with exact keys (`BUNDLE_FIELDS`, `checkKeys` in `src/domain/gate/shape.ts`). Any key it does not know refuses the whole file (`unknown-field`), and the failure text says "Run NEAR AI: Reset Policy to Defaults to sign a fresh one."
- `src/gate/bundleStore.ts` accepts only a bundle signed by this install's own device key. A bundle signed by any other key fails closed (`unknown-key`). There is no organization issuer, no pinned root, no way to receive a policy.
- Edit Policy and Apply Policy Draft (`src/services/gateCommands.ts`) let the person widen any key, and Reset re-signs the starting rules. SECURITY.md says this honestly.
- The designs add about 25 keys across nine designs, each as "an optional v1 key": `ceiling.models`, `routing.attestedHosts`, `routing.vaults`, `localCatalogue`, `onboarding` (with `discovery`), `organization`, `aggregation`, classification rules, source label map, feed defaults, the capital profile, the hub spend cap, accredited devices. The capital design (2.3) says a new field needs a new `bundleVersion`; provenance (5.1) says optional v1 key. They disagree.

So "your organization's rules, which your settings can only narrow" is a promise main cannot keep yet, and every new key would turn older clients read-only with advice that would wipe the policy.

## 2. Bundle v2 structure

```
bundleVersion: 2
vocabulary, issuer, issuedAt, expiresAt
layer: "organization" | "personal" | "project"
parent?: { hash, issuer }                 // personal and project layers name the layer they narrow
requires: ["endpoints@1", "models@1", ...]  // feature ids this bundle needs to be read correctly
minClient?: "0.4.40"                       // only used to word the "update" message

labels:    { scales, mappings, defaultLabel,
             routing: { levels, handling, compartments },
             aggregation, classification, sourceLabels, feedDefaults,
             lowering: { who, needsReason } }
endpoints: [ { id, class, host (exact; a wildcard only for class org-plain and only up to a stated maxLabel),
               scheme: "https" | "http-loopback", tlsPin?, region, maxLabel, attestation?, provider? } ]
authorizations: [ { id, kind: "protected-b" | "t1-risk" | "accredited-device" | "residency-exception" | "declassify"
                          | "export-person" | "export-endpoint",
                    subject: { endpoint | model | device | item }, scope: { projects, labels, uses },
                    conditions, evidence (assessment reference), namedPerson: { name, key },
                    signature (inner, by the named person), issuedAt, expiresAt (maximum per kind), revokedBy? } ]
models:    { mode: "report" | "enforce", unknownMaxTier, tierByLevel, tierByProject,
             passports, defaults, localCatalogue, order }
agents:    { maxMode, contexts, mcp: { unattended, labelCeilings } }
residency: { required?: "CA", byLevel? }
exportControl: { regimes, officials, registration, suggestRules, agentNetwork, retention, incidents }   // CGP-ITAR.md 6.4
people:    { clearances (personal layer only, self-declared),
             organization: { mode, allowedModes, projectMayChoose, settings } }
onboarding:{ contacts, locked, kindsOfWork, defaultScale,
             discovery: { networks, announce, scanRanges, personalApprovals (default false) } }
limits:    { spend: { dailyUsd, vaultHoursPerDay, hubDailyUsd }, trainingTargets }
data:      { personalMark, regimes }
directives:{ capital?, doctrine? }
reserved:  { anchorRoots, statusLists, maxOfflineAge }   // today's reserved v1 fields, unchanged meaning
classification: { systemHigh?, thresholds: { "scale/level": { costRatio, recallTarget (basis points), secondFamily } },
                  shadow: { defaultMode, levels }, roles: [ { passport, role, levels, evaluation, since } ],
                  review: { jumpLevels, topLevel, lowerRequestAgeDays }, markings: [ { id, pattern, label } ],
                  codeWords?: { listLabel, entries: [ { id, token, label } ] }, factTypes,
                  guideRules, compilationRules: [ { id, guideRef, label, description, when: { allOf, sameSubject }, then } ] }
                  // feature classification@1 (Phase 70.1, D-16); lower layers only tighten (D-17)
```

Naming: sections are nouns, keys are camelCase, ids are lowercase tokens. Each section carries its own `v`; `bundleVersion` changes only for envelope changes. A missing section means today's behaviour, stated in that section's parser.

## 3. Versioning: "update", never "reset"

- Every feature a bundle uses that an older client might not know is named in `requires` (`endpoints@1`, `models@1`, `residency@1`, `organization@1`, and so on). The issuer tooling adds it; a bundle that uses a section without naming it is refused as malformed.
- A client that meets an unknown feature id refuses with a new failure, `needs-update`: "Your organization's rules need a newer NEAR AI (version {minClient} or later). Update the extension. Until then NEAR AI can read and plan but not act." No mention of Reset.
- A field the client does not know inside a known section, not covered by `requires`, is still refused (today's strictness), but with the same update sentence when `bundleVersion` or `minClient` is newer than this client.
- Reset is never offered for a bundle this device did not sign.
- v1 bundles parse as v2: `ceiling` maps to `agents`, `scales`/`mappings`/`defaultLabel`/`routing` map to `labels`, `routing.localHosts` maps to `endpoints` (section 5), `clearances` maps to `people.clearances`. The first Edit writes v2.
- Precedent kept: reserved fields are validated for shape and ignored until a phase gives them meaning.

The shipped-code fix S6 (`REVIEW.md`, section 8) lands the `requires` field and the `needs-update` text in v1 now, so clients in the field already behave this way before any v2 bundle exists.

## 4. Layers: who signs, and narrow only

| Layer | Signed by | May hold | Rule |
|---|---|---|---|
| Organization | the organization issuer, pinned on install by a signed enrolment file the security contact hands out, with a fingerprint read aloud (like the safety code); a DID from Phase 71 | everything | the ceiling |
| Personal | this device key (as today) | any section | checked key by key to narrow the organization layer. Without an organization layer it is the whole policy, as today |
| Project | the project's lead (single machine: the person; shared: the roster's lead) in `project.genesis` or a `project.policy` entry | project label, mode (within `allowedModes`), exercise flag, locked answers | narrows only; a lowering is recorded with a reason |
| Settings and team files | not signed | model pins, `privacy: private`, `teeOnly`, spend numbers | narrowing inputs to the same check, never read as permission |

- **Narrowing is declared, not guessed.** Every key has a declared direction in one table in code: tier stricter, list a subset, number lower, `maxLabel` dominated, boolean only towards the safe value. A test fails when a key has no direction.
- **Inner signatures.** Each authorization carries the named person's own signature over the record, and the named person's key must be listed in the organization layer. When the named person's key is the same as the key of the person using it, every screen shows "self-signed on this computer".
- **Reset** under an organization layer resets the personal layer only. Without one it does what it does today.
- **The hub** loads the same organization layer (pinned at `hub.admit`) and runs the same pure gate core for hub watches (`REVIEW.md`, conflict K24).

**Interim rule until the organization layer exists:** every acceptance, authorization and trust line that cites one says "self-signed on this computer". The designs' "set by your organization" copy is shown only when the issuer is not this device.

## 5. One endpoint list

`endpoints[]` replaces `routing.localHosts` (on main), `routing.attestedHosts` (74.2), `routing.vaults` (36), "org-plain hosts" and `onboarding.discovery.hosts` (32.1).

| Field | Meaning |
|---|---|
| `id` | stable token; profiles, records and authorizations cite it |
| `class` | one of `local`, `org-plain`, `org-tee`, `nearai-tee`, `vendor-tee`, `vendor-region`, `forwarded`, `closed-api` |
| `host` | exact host. A `*.` pattern is allowed only for `org-plain`, and then only up to `org/Restricted` and Protected A |
| `scheme` | `https`, or `http-loopback` for this computer only |
| `tlsPin` | SPKI hash. Required for `org-plain` above Protected A |
| `region` | `CA`, `US`, `EU`, `unstated` (contractual fact for vendors; stated by the organization for its own) |
| `maxLabel` | the highest label this endpoint may receive; it can only narrow what the routing table allows, except for third-party endpoints where an authorization is required (below) |
| `attestation` | verifier spec for `org-tee`, `vendor-tee` (Cohere Encrypted), `nearai-tee` (implicit) |
| `provider` | which `ModelEndpoint` adapter talks to it |

Migration: each existing `localHosts` entry becomes an `org-plain` endpoint at today's effect, with a one-time notice that names what changed. Discovery and setup flows never write this list: they propose entries (section 7).

## 6. One decision function

`decideRoute(label, use, endpoint, authorizations, residency, passport, clearance)` in `src/domain/gate/`, in this order:

1. The label's routing tier gives the minimum endpoint class (`labels.routing`).
2. The endpoint's `maxLabel` caps it.
3. Protected B needs a `protected-b` authorization for any endpoint the organization does not run (`nearai-tee`, `vendor-*`). Classified needs an `accredited-device` authorization for the device and is never sent off the device. Protected C is treated as classified.
4. Residency: the endpoint's `region` must satisfy `residency` for this label or project (`route.residency`).
5. The passport covers the use and matches the class (`models`).
6. The clearance covers the label: effective clearance is the meet of the personal-layer clearance and the roster clearance for that project.
7. Export control (`route.export-control`): for each reserved compartment (`CGP`, `ITAR`, `EAR`) on the label, the endpoint is `local` or an `export-endpoint` authorization covers it, and the person holds an `export-person` authorization for that regime. Reserved compartments come only from those signed decisions, never from a self-declared clearance. See `.planning/research/compliance-dashboard/CGP-ITAR.md`, sections 6 to 8.

The same function serves the guide's `recommend()`, the model picker, sub-agent resolution, `privacy: private` members, `nearAi.privacyMode`, Team Mode's `teeOnly` and `allowedModels`, the hub and the Cohere adapter. Its output also feeds the trust line (`EXPERIENCE.md`, section 3) and the decision record. `privacyMode: tee-only` becomes a personal floor ("at least `attested-cloud`") inside it, and `SovereigntyMode` and `PrivacyPreflight`'s routing role are retired (the data-class checks for secrets and personal data stay, as label facts).

## 7. One policy editor

"NEAR AI: Policy" (user title: **Your organization's rules**, or **Your rules** without an organization) is one webview with sections: Labels and where they may go; Where AI runs (endpoints); Models; Authorizations; Agents and tools; People and organization; Setup and discovery; Limits.

- Show Policy, Edit Policy, Apply Policy Draft, the vault form (Cohere 6.2), "Adopt the Western defaults" (provenance 8.5), the discovery approval (guided 6.4.1) and the risk-acceptance command all open this editor on a **proposal**: a diff with its effect in plain words ("Internal work could go to a vault that is not attested").
- On a personal layer the person applies the proposal there. Under an organization layer it is exported as a request to `onboarding.contacts` and nothing changes locally.
- Edit controls appear only when this device can sign the layer shown. Others see the rules read-only with "who to ask".
- Raw JSON stays behind "Show as stored". Reset lives inside this page only, not in the palette.
- The guide keeps its rule "never writes the bundle": it writes proposals.

## 8. Standing defaults that change

| Default | Today or in a design | v2 |
|---|---|---|
| Standard Cohere vault ceiling when added | `org/Public`, `org/Internal` (Cohere 6.2, open decision D2) | `org/Public` only; Internal is an unticked box with "This vault is not attested; Internal work normally needs attested hardware" (owner question Q5) |
| Personal approval of a found server | "where the policy allows" (guided 6.4.1), no key | `onboarding.discovery.personalApprovals`, default false; when true, adds an endpoint at `maxLabel org/Public` only |
| Exercise flag (staff T3 to T2) | project setting, unsigned (provenance 6.1, O2) | project-layer attribute, set at genesis or by the lead with a reason, recorded, shown on every staff screen |
| Hub spend cap | "signed policy" (MUS 21.2) vs "operator" (MUS 10.6) vs Phase 35 | the lower of `limits.spend.hubDailyUsd` and the operator's file |
| Spend limits | person setting, Team Mode allocations, vault hours | `limits.spend` ceilings; person and team values narrow inside them |
