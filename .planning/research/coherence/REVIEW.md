# Coherence review: one system, one vocabulary, one front door

**Status:** review and proposal for the owner. Docs only: no code changed.
**Written:** 2026-11-20, against `origin/main` at 15bc560c (after #138).
**Inputs:** four independent reviews of the same brief (architecture and data model, user experience and vocabulary, policy and security model, developer experience and code structure), merged here. Every claim carried forward was checked against `origin/main`; where the reviews disagreed, the code decided, and the reason is given.
**Gate:** no new user-facing phase (32.1, 32.2, 33.1, 36, 37, 38 to 40, the 74.1 and 74.2 builds, and the new capital phases) starts until this review merges. Phase 32 (the sync hub) is mid-build and continues.

Companion files in this folder:

- `GLOSSARY.md`: one word per concept, the collisions resolved, the copy lint.
- `POLICY-SCHEMA.md`: bundle v2, layers, the endpoint list, the authorization record, the decision function, the policy editor.
- `EXPERIENCE.md`: Get Started, Settings, the trust line, role Homes, palette and title bar, shared patterns, accessibility.
- `DEVELOPER-STRUCTURE.md`: layers and the architecture test, shared kits, the ADR list, conventions for new phases.

## 1. Key points first

1. **Each feature is sound alone, but they were built on four different foundations.** This review picks one of each: one signed policy, one list of where AI may run, one exception record, one label and routing decision, one identity, one way to share with people, one record format, one provider interface.
2. **"Your organization's rules" cannot reach anyone yet.** On main the only policy a computer accepts is one it signed itself, so the person can widen any rule and sign their own exceptions. Eight designs assume an organization-signed policy. A small foundation phase (F1, proposed as Phase 41) adds it before the guided setup, Cohere and positions.
3. **Fix seven things in shipped code first, in one small patch.** The worst: Protected B and Secret can go to any host named in `routing.localHosts`, wildcards included, with no certificate pin and no authorization; "private" teams and "TEE only" trust NEAR's catalogue instead of the verified connection check; and an older extension that meets a newer policy turns read-only and suggests a Reset (section 8).
4. **One front door.** "Get Started" (the guided setup) absorbs the ten other setup paths. Later phases add steps to it, never new setup commands.
5. **One trust line, no fourth badge state.** Every answer says where it ran, what was verified, and what allowed it. That handles the Cohere Standard vault without changing the three shipped proof levels.
6. **One vocabulary.** "Team" means agents; people are members, in the words of their organization's mode. "Private" means verified private hardware or this computer, nothing else. "Tier", "cell", "profile" and "Team Mode" leave the screens. A copy lint keeps it that way.
7. **One policy editor.** Every setup flow that changes rules (vault, Western defaults, found servers, risk acceptances) proposes a change there instead of writing the policy itself.
8. **The palette and title bar shrink by half.** Staff, cyber and simulation commands show only in projects that use them; the chat title bar goes from 17 entries to 7; one Settings page replaces five surfaces.
9. **Developers get one architecture test with a recorded baseline,** shared kits (webview, records, policy reader, labels, provider interface, `term()`, test fakes) and 15 one-line ADRs.
10. **The roadmap becomes eleven milestones in plain words,** with the foundation and the passport schema before 32.1, 32.2, 36 and 37, and capital projects placed after 33.1 on the replica layer (section 9).

## 2. System map

### 2.1 The shared foundations

| Foundation | One model | On main today | Built in |
|---|---|---|---|
| **Organization policy and its pinned root** | Bundle v2: sections, `requires`, organization layer signed by a pinned issuer, personal and project layers that only narrow (`POLICY-SCHEMA.md`) | v1, exact keys, signed only by this device (`src/domain/gate/bundle.ts`, `src/gate/bundleStore.ts`) | F1 |
| **One endpoint list** | `endpoints[]`: id, class, exact host, scheme, TLS pin, region, `maxLabel`, attestation, provider | `routing.localHosts` (wildcards, no pin); designs add `attestedHosts`, `vaults`, org-plain hosts, discovery hosts | F1 |
| **One authorization record** | `authorizations[]` with `kind`: protected-b, t1-risk, accredited-device, residency-exception, declassify; inner signature by a named person listed in the organization layer | `label-declassify` purpose only; designs add four more shapes | F1 |
| **One label service and one decision function** | dependency-free label module (`dominates`, `join`, `atLeast` over the active scale table); `decideRoute(label, use, endpoint, authorizations, residency, passport, clearance)` | gate routing (`src/domain/gate/routing.ts`) beside `nearAi.privacyMode` (`src/domain/privacy.ts`, `src/services/outboundGuard.ts`), Team Mode `teeOnly`, member `privacy: private` (`src/services/agentSession.ts` `routeAllows`), and a second label ranking in `src/domain/staff/obs/observation.ts` | S4, S7 now; F1 |
| **Identity** | one device key per install (X25519 bound to it); one person id per organization (the roster member id, with an optional `did`); one device lifecycle | device key is already shared (`src/team/identity.ts`, `src/staff/replica/keyring.ts`); two person ids (Team Mode `Member.id`, roster member id) | F1 adds the `did` slot; L2 maps Team Mode ids |
| **Positions and roles** | three nouns: **position** (a person's authority, on the roster), **agent job** (in a team file), **model for a job**. Every shared project has positions; in invitation mode they are created silently per seat. One delegation rule: a subset of what the delegator holds, with scope, expiry and depth | seven "role" vocabularies; staff setup's `humanLead` beside the roster's lead roles | 33.1 (positions), F1 (mode table, `term()`) |
| **Signed records** | shared facts are replica v2 entries; local audit is the OCSF record, hash-chained, with periodic signed heads; standalone artifacts use `signedPayload` envelopes | unsigned OCSF JSONL (`src/domain/gate/record.ts`), staff v1 ledgers, replica v2, Team Mode CAS log, spend and cyber ledgers | F1 (local audit chain); 31 to 35 (replica) |
| **Provider interface** | `ModelEndpoint` (stream, models, endpoint facts) and `LocalServerAdmin`; one verifier interface (`AttestationVerdict`, Cohere 7.5) for NEAR, Cohere Encrypted and org-tee | concrete `NearAiClient` (1,930 lines, 34 importers), `providerFactory.ts` with `route: 'near' \| 'local'` | F1 (interface); 32.2, 36, 37, 74.2 (adapters) |
| **Sync and federation** | personal state: Phase 27 (My computers); shared state: the replica layer for every multi-person feature, carried by the hub, git, LAN or file; federation: hub to hub of the same streams (L5); the data host is a hub client; the relay is messaging only | three systems: Phase 27 sync, staff replica, Team Mode git log | 31 to 35; L2 moves Team Mode; L5 rewritten |

### 2.2 Every feature on the foundations

| Feature | Policy | Endpoints and routing | Authorizations | Identity and positions | Records | Provider | Sync |
|---|---|---|---|---|---|---|---|
| Chat and agents (shipped) | `agents`, `labels` | `decideRoute` | declassify | device key | local audit | `ModelEndpoint` | My computers |
| Project teams, Team Studio, Team Live (shipped) | `models.defaults` | `privacy: private` as a floor in `decideRoute` | none | agent jobs only | local audit | `ModelEndpoint` | My computers |
| Team Mode (preview, frozen) | `agents` | floor | none | person id (imported at L2) | Team Mode log, import-only at L2 | | replica at L2 |
| Staff teams and Staff Room (shipped) | `labels`, `models` (T3, exercise flag in the project layer) | `decideRoute` | t1-risk later | positions | replica | `ModelEndpoint` | replica |
| Multi-user staff and the hub (30 to 35) | issuer pinned in genesis; hub loads the organization layer | hub runs the same gate core | | positions, roster | replica | hub watches through `ModelEndpoint` | hub, git, LAN, file |
| Guided setup (32.1) | reads `onboarding`, `organization`; writes proposals | `recommend()` calls `decideRoute` | shows them | suggests a mode | local audit | lists endpoints | project stream in shared projects |
| Local model manager (32.2) | `models.localCatalogue` | `local` endpoints | | | local audit | `LocalServerAdmin` | |
| Network discovery (32.1) | `onboarding.discovery` | proposes endpoints | personal approvals off by default | | local audit | | |
| Cohere vaults (36, 37) | `endpoints` (vendor-region, vendor-tee) | `decideRoute` | protected-b | | local audit | Cohere adapter, verifier | |
| Model provenance (74.1, 74.2) | `models` (schema in F1) | class matches passport | t1-risk | | output headers | org-tee verifier | |
| Assigned positions and modes (33.1) | `people.organization` | | | core | replica | | replica |
| Portfolio (38 to 40) | `labels.aggregation` | | | tasker positions | publications | | hub, L5 |
| Capital projects (42, 43 proposed) | `directives.capital` | | | positions (pack) | replica | | replica |
| Data platform (85 to 101) | `labels.classification`, `sourceLabels`, `data` | local endpoints | declassify, overrides | officer positions; Phase 71 credentials | governance facts on the replica; item Merkle roots on the host | local endpoints | hub client |
| Messaging relay (75 to 84) | `agents.contexts` | `decideRoute` | | requester pairing, DID (Phase 76) | local audit | | messaging only |

## 3. Glossary

See `GLOSSARY.md`. It gives one user word per concept, the words users never see, the words organization modes change, the resolution of each collision (Confidential, team, roster, lead, cell, profile, mode, private, tier, relay, mark) and the copy lint.

## 4. Experience map

See `EXPERIENCE.md`: Get Started and how each of the ten other setup paths folds in; one Settings page plus admin Organization rules; one trust line (where it ran, what was verified, what allowed it) replacing the Cohere fourth badge state; role Homes; palette, title bar and status bar reductions; shared patterns; accessibility.

## 5. Policy schema v2

See `POLICY-SCHEMA.md`: sections; `requires` so older clients say "update" not "reset"; the organization layer signed by a pinned issuer with personal and project layers that only narrow; Reset touching only the personal layer; one `endpoints` list (label ceiling, region, TLS pin) replacing `localHosts`, `attestedHosts` and `vaults`; one authorization record (Protected B, T1 acceptance, accredited devices, residency exceptions, declassify); one decision function; one policy editor where every setup flow proposes changes.

**Interim rule:** until the organization layer exists, every acceptance, authorization and trust line that cites one says "self-signed on this computer".

## 6. Developer structure

See `DEVELOPER-STRUCTURE.md`: the layer table and one architecture test with a recorded baseline; shared kits (webview kit with typed messages, record writer, policy reader, label service, `ModelEndpoint`, `term()`, shared test fakes); ADR-001 to ADR-015; conventions for new phases.

## 7. Conflicts (one merged table)

Found by: **A** architecture, **E** experience, **P** policy, **D** developer experience. **Shipped** = the conflict is in code on `origin/main` today (some rows are partly shipped, partly design). Severity: high (a person would be confused, or a security rule could be bypassed), medium, low.

| # | What conflicts | By | Sev | Shipped | Resolution | Changes |
|---|---|---|---|---|---|---|
| K1 | Designs assume an organization-signed policy (provenance 5.1, Cohere 6.2 and 6.3, guided 9, portfolio 5.4, data platform 6, capital 2.3); `bundleStore.ts` accepts only this device's own key, Edit widens freely, and a person can self-sign T1 acceptances and Protected B authorizations | A P | high | yes | Organization layer with a pinned issuer; personal and project layers narrow only; inner signatures by named people listed by the issuer; "self-signed on this computer" until then | F1; bundle.ts, bundleStore.ts, gateCommands.ts, every design's copy, SECURITY.md |
| K2 | `parseBundle` refuses unknown keys (`checkKeys`, `unknown-field`) while each design adds an "optional v1 key"; capital 2.3 says a new `bundleVersion`; failure text says Reset | A P D | high | yes | `requires` feature ids and `needs-update` text now (S6); sections in v2; Reset never offered for a bundle this device did not sign. Decided between the reviews: `requires` (A, P) over "reserve every section now" (D), because reserving cannot cover fields nobody has designed yet; `minClient` kept only to word the message | S6, F1 |
| K3 | Five endpoint lists: `routing.localHosts`, `attestedHosts`, `vaults`, org-plain hosts, `onboarding.discovery.hosts` | A P | high | partly | One `endpoints[]`; discovery and setup only propose entries | F1; provenance 8.3, Cohere 6.2, guided 6.4 |
| K4 | Protected B and Secret go `local-only`, which accepts any `localHosts` match including `*.` wildcards, with no scheme check, TLS pin or authorization (`routing.ts` `isLocalRouteHost`); Cohere requires an authorization even for an attested vault; guided R9 extends it to NEAR and org-tee with a record that has only a `vault` field | P | high | yes | Now: exact host and https for Protected B, nothing classified off loopback (S1). F1: `maxLabel`, TLS pin, authorizations keyed by endpoint id | S1, F1; routing.ts, Cohere 6.3, guided R9 |
| K5 | Classified: the guide stops (4.4), but the gate sends Secret to any loopback or `localHosts` model without a word; "accredited devices" (guided D3) is not in the gate | P | high | yes | Warn and record `route.not-accredited` now (S2); `accredited-device` authorization in F1; refuse once the organization layer exists (Q6) | S2, F1 |
| K6 | Three privacy evaluators: gate routing tiers, `nearAi.privacyMode` (`SovereigntyMode`, `outboundGuard.ts`), Team Mode `teeOnly`; plus member `privacy: private` (`agentSession.ts` `routeAllows`) and the picker's "Private · runs in NEAR TEE" (`chatBridge.ts`) trusting the catalogue's `privacyBoundary === 'tee'` instead of the fresh bound-connection check | A E P | high | yes | All of them become a floor of `attested-cloud` inside `decideRoute`, so "private" always means the verified check (S4); `SovereigntyMode` retired in F1 | S4, F1; privacy.ts, outboundGuard.ts, agentSession.ts, team/policy.ts |
| K7 | Staff templates are "private by default" (`j2Template.ts`, `j3Operations.ts` `private: true`; `releaseGuard.ts`); the private TEE models on NEAR today are all PRC-origin (provenance 4.2), which provenance forbids at T2 and T3, and staff projects are T3 | P E | high | yes | Say it plainly now (S5); exercise on fictional data is the only staff mode offered until an organization T3 passport exists; staff templates move from `privacy: private` to "needs T3 and verified or local" with 74.1 | S5; staff templates, provenance 8.5 |
| K8 | Two label evaluators: the gate ranks against the bundle's scales; `observation.ts` (`rankOf`, `labelAtLeast`, `joinTemplateLabels`), `guardScan.ts` and `gate/chatLabel.ts` (`markOf`, `raiseBy`) rank against the shipped `SCALE_PRESETS` | D A | high | yes | Use the active bundle's scale table (S7); ban `SCALE_PRESETS` outside the gate and the starting rules in the architecture test | S7, F1 |
| K9 | `org/Confidential` and `ca-classified/Confidential` share a level name; the guide's draft Q2 lists "Classified documents (Confidential, Secret, Top Secret)". Reviewers disagreed on severity: checked on main, Set Label picks the scale first and shows keys such as `org/Confidential` (`gateCommands.ts` `labelShown`), so it is medium on main and high in the guide's copy | E | med | yes | Always show scale name plus level (S8); group pickers by scale; the guide's copy names the scale; owner question on renaming the `org` level's display name to "Sensitive" | S8; guided 4.2 |
| K10 | Residency ("must stay in Canada") only rules options out in the guide's `recommend()` (guided R3); nothing in `decideRoute` knows a location. Checked: nothing on main asks or enforces residency, so this is design only, not a shipped-code fix | P | high | no | `residency` section and `route.residency` in F1; 32.1 must not ship the Canada question before the rule exists | F1; guided R3, Cohere 6.4, provenance 8.3 |
| K11 | A Standard Cohere vault gets `org/Internal` by default (Cohere 6.2, D2) while `DEFAULT_ROUTING` sends Internal only to attested cloud: one setup click lowers Internal's protection | P | high | no | Default `org/Public` only; Internal an unticked box with the reason | Cohere 6.2 (note applied), Q5 |
| K12 | Guided 9.2 "never writes the bundle", but the vault setup (Cohere 6.2), the guide's vault step (guided 12), discovery approval (6.4.1) and "Adopt the Western defaults" (provenance 8.5) all write policy | P E | high | no | Every flow writes a proposal into one policy editor | F1; guided, Cohere, provenance (notes applied) |
| K13 | Where inference may run is asked four times: `projectInitialization.ts` `locality`, `staffSetupCommand.ts` "Where may the members' models run?", Cohere 10.1 ticks, guided 4.3 (derived) | E | high | partly | One source: the project label plus the policy, chosen in the guide; remove `locality` and the staff `where` question in 32.1 | 32.1; staff setup, Cohere 10.1 |
| K14 | Trust: three badge states (`trustBadge.ts`), Cohere's fourth "Sovereign region, not attested" (6.5, D1), the Staff Room "18 of 18", a Protected B line, tier refusals; the local route has no badge, so an `org-plain` server across the network looks like this computer | E P | high | partly | One trust line: Runs on, Verified, Allowed; no fourth state | trustBadge.ts, Cohere 6.5 (note applied), Q4 |
| K15 | Under the Western defaults every staff officer's first run is refused (provenance 6.1 T3, 8.5 no private T2 or T3 model on NEAR today) | E P | high | no | The guide never lands a person on a surface with no allowed model; staff offers exercise only until a T3 passport exists | 32.1, provenance 8.5 |
| K16 | Ten ways in and no front door (Set Up opens "Near AI: First Project", Project Setup, Set Up Project Team, Set Up a Staff Team, four profile commands, Project Sync, Online Home, Team Mode, Make Multi-User, web search, verifiers); designs add five more | E D | high | yes | Get Started absorbs them; old ids as aliases; a step registry for later phases | 32.1; `EXPERIENCE.md` 1 |
| K17 | Hosting class words (provenance 8.3, Cohere 6.1) beside `ProviderBoundary`, `RolePrivacy`, `AgentLocality`, `TeamPrivacyBoundary`, `ProviderKind`, discovery `locality` | A | med | partly | `class` is the one stored fact per endpoint; every other word is derived through `TrustFacts` | F1; agents.ts, modelRoles.ts, privacy.ts, providerFactory.ts |
| K18 | Who decides: staff setup's section lead (`humanLead`, approves products), MUS 7.1's staff lead (writes the roster), separate decision roles, PORT 3.1 decision roles on positions; seven "role" vocabularies | A E | high | partly | Decision authority lives on the position and the person posted to it; the team file names a position, never a person; before multi-user the local person holds every position. Three nouns: position, agent job, model for a job | 33.1; staff setup, MUS 7.1, PORT 3.1, guided Q1 "kind of work" |
| K19 | Use tier (T0 to T3) beside routing tier beside vault `acceptLevels`; model "tiers" (fast, standard, deep) | A E | med | partly | Users see plain use words and "Models by job"; no "tier" on screens; one `decideRoute` reads both axes | F1, copy lint |
| K20 | Two person ids (Team Mode `Member.id`, roster member id), neither with a DID slot | A | med | yes | Roster member id is the person id; optional `did` field now; Team Mode imports at L2 | F1 (slot), L2, Phase 71 criterion |
| K21 | Two delegation algebras: roster `authority.delegate` (PORT 3.2) and Phase 71 delegation credentials; Team Mode `permissions.ts` matrix | A | med | partly | One pure delegation rule (subset, scope, expiry, depth) used by the roster now and wrapped as credentials in Phase 71 | 33.1, Phase 71 |
| K22 | The mode table and `term()` sit in 32.1 (an onboarding phase) while 33.1 needs them and its fold rule `mayDecline` is security-relevant | A | med | no | Move them into F1; the guide reads them | ROADMAP 32.1, 33.1, 41 |
| K23 | Shared-project state outside the replica: guide answers in `.planning/.near-ai/project.json` through git (unsigned shared state), labels in a per-install signed `labels.json` (`labelMapStore.ts`) whose signature only verifies for its writer | A | med | partly | In shared projects the project label, guide answers and mode are project-stream entries; single-machine projects keep the files | 32.1, replica project kinds |
| K24 | Three organization servers with no stated relation: hub (MUS 10), data host (DP 3), relay; hub watches route "by the cell's route" with no bundle, passports or verifier on the hub; hub spend cap set by policy (MUS 21.2), operator (10.6) or Phase 35 (D-62); L5 still builds on Phase 27 sync, Team Mode's git transport and `relayTransport.ts` | A P E | med | no | Hub = sync service, loads the organization layer and runs the same gate core; cap = lower of policy and operator; data host = hub client plus its own store; relay = messaging only; L5 rewritten as hub federation; one user word "your organization's server" | Phase 35, MUS 10.6 (note applied), DP 1.1, ROADMAP L5 |
| K25 | Records: unsigned OCSF JSONL, the guide's claimed "signed with the device key" record (guided 8.5) that no code produces, DP's revived Phase 13 governance log, staff v1 ledgers, replica v2, Team Mode events | A | med | partly | Two families: replica entries for shared facts, hash-chained local audit with signed heads; nothing called "signed" per record until it is | F1, guided 8.5 (note applied), DP 3 (note applied) |
| K26 | Capital WP-P0 generalizes `ledger.ts` and `personDecisions.ts` (single chain), which the replica is replacing; its own Portfolio Room (CAP 8) beside PORT 6.5; no roadmap phase | A E | med | no | Re-base on the replica (pack = stream kinds plus fold rules); one Portfolio Room with a capital tab; Phases 42 and 43 | capital 8, 10 (notes applied), ROADMAP |
| K27 | Aggregation rules in DP 6.2 (v0.6.0, Phase 93) and needed by Phase 38 (0.4.x); the chat-count rule changes the session label and so changes routing | A P | low | no | One evaluator in `domain/gate`, built in Phase 38, extended by Phase 93; one schema with `effect` and `remedy`; chat label raises recorded | Phase 38, 93 |
| K28 | Three "this project elsewhere" stories: Project Sync with recovery code, Team Mode (preview), staff replica with hub, invitation file, safety code, Add My Other Machine; three device stories | A E | med | yes | Two ideas: My computers and Share with people; one device lifecycle on the roster; freeze Team Mode until L2 | `EXPERIENCE.md` 6, ADR-009, ADR-010 |
| K29 | Model choice in four places: planned `models`, Team Mode `allowedModels`/`teeOnly`, member pins, settings | P | med | partly | Team policy and pins choose only among what the effective policy allows; one resolver | F1, 74.1 |
| K30 | Exercise flag drops a staff project from T3 to T2 with no signature, reason or record (provenance 6.1, O2) | P | med | no | Project-layer attribute, set at genesis or by the lead with a reason, shown on every staff screen | F1, provenance 6.1 (note applied) |
| K31 | Clearances from three sources: bundle (self), roster `member.admit` (lead), Phase 71 credentials | P | med | partly | Effective clearance = meet of personal and roster clearance; credentials replace both later; shown in "Why this label" | F1, Phase 71 |
| K32 | Discovery "personal approvals where the policy allows" (guided 6.4.1) with no key or storage | P | med | no | `onboarding.discovery.personalApprovals`, default false; when on, an endpoint at `maxLabel org/Public` only | F1, guided 6.4.1 |
| K33 | Spend: person setting, Team Mode allocations, vault hours (Cohere 9.4), hub cap | P | low | partly | `limits.spend` ceilings; person and team narrow inside | F1 |
| K34 | Staff release identity "identified by the device key that signs the policy bundle" (staff 10, 4.1) breaks once the organization signs the policy | P | low | no | Decisions are signed by the person's device or credential, never "the policy key" | staff 10 4.1 (note applied) |
| K35 | Palette: 84 commands, 30 "Staff:", only 14 hidden; chat title bar 17 entries; five or more status bar items | E | med | yes | `when` contexts, 7 title-bar entries, one status item | `EXPERIENCE.md` 5 |
| K36 | No settings place: 51 flat settings (29 under `agent.*`); Tools, Spending Limits, MCP, Show and Edit Policy are separate surfaces; Show, Edit, Apply Draft and Reset Policy in every palette | E | med | yes | One Settings page, categories, Advanced; Organization rules page; Reset only inside it | `EXPERIENCE.md` 2 |
| K37 | "Team", "roster", "lead", "cell", "profile", "mode", "mark" each mean two to six things | E A | med | yes | `GLOSSARY.md` section 4 | copy lint, designs |
| K38 | Three run views (Team Live, Agent Activity, Staff Room) and four title styles | E | low | yes | One run view with a staff layout; plain-noun titles | `EXPERIENCE.md` 6 |
| K39 | Staff setup shows "Step 6 of 6" for four different questions (`staffSetupCommand.ts` `steps = 6`) | E | low | yes | True counts, then fold into the guide | 32.1 |
| K40 | Branding: "Near AI: First Project", "Near AI for VSCode" (ROADMAP title), "NEAR AI for VS Code" (README); GSD jargon in commands | E | low | yes | "NEAR AI", "VS Code", "Workflows" in user copy | copy lint |
| K41 | No provider interface: Cohere adds `route: 'vault'` and three API shapes to `NearAiClient`; guided adds eight local adapters | D A | high | yes | `ModelEndpoint` and `LocalServerAdmin` before 32.2 and 36 | F1, ADR-005 |
| K42 | Domain reaching up (`domain/auth.ts`, `domain/state/*` to services; `cyberLimits.ts` to agent); folder cycles; `withFileLock` and `SecretStorageLike` in services but used as infrastructure | D | med | yes | Layer table, `platform/node`, architecture test with baseline, one mechanical move PR | ADR-001 |
| K43 | Same names for different things: three `policy.ts`, two `routing.ts`, triple folders for team, staff and gate; designs cite paths that do not exist | D | med | yes | Renames in ADR-002; a paths check in every plan | ADR-002, conventions |
| K44 | Signing primitives live in `domain/team/` but serve replica, gate and staff | D | low | yes | Move to `domain/core/` with re-exports | ADR-002 |
| K45 | Ten hand-built webview hosts, four CSP variants, untyped page scripts | D | med | yes | Webview kit with typed messages | ADR-012 |
| K46 | Settings read in 19 files though `services/settings.ts` exists; `nearAi.team.*` and `nearAi.teams.*` prefixes | D | low | yes | One accessor; test against `contributes.configuration` | ADR-013 |
| K47 | Command ids with no namespace (`nearAi.setup`, `nearAi.projectSetup`, `nearAi.setupProjectTeam`, `nearAi.setUpStaffTeam`, ...) | D E | med | yes | Namespaces and hidden aliases | ADR-013 |
| K48 | Duplicated helpers: about 20 atomic writers, `isRecord` 11 times, four untrusted-text fences | D | med | yes | One of each | `DEVELOPER-STRUCTURE.md` 2 |
| K49 | Test fakes duplicated; one flat glob; no default concurrency cap in `scripts/run-tests.mjs` (one process per core, with a recorded out-of-memory kill) | D | med | yes | `src/test/fakes/`, area folders, heavy shard, a default cap | ADR-015 |
| K50 | Planned `hub/` copies the relay's logger, secrets, state folder and health; servers on Node 26, extension CI on Node 24 | D | low | no | `services-kit/` shared by `relay/` and `hub/`; ADR on Node versions. Phase 32 continues; the kit is extracted after it, not during | ADR-014 |
| K51 | "Relay" names the messaging relay, the paused ciphertext relay, `relayTransport.ts` and L5's "hub-to-hub relay" | A | low | yes | "Relay" means messaging only | ROADMAP L5, glossary |

## 8. Shipped-code fixes (do first, one small PR)

These are in code on `origin/main` today and should not wait for F1 or the redesign. Proposed as **one patch PR**, `fix(gate): coherence safety patch`, in the 0.4.x patch line, before F1 starts. Each item is small, narrows behaviour or changes copy, and keeps current flows working; each changed transition gets a test.

| # | Issue (code) | Risk in one sentence | Smallest safe fix | Owner decision? |
|---|---|---|---|---|
| S1 | `isLocalRouteHost` (`src/domain/gate/routing.ts`) lets any `routing.localHosts` match, including a `*.example.com` wildcard over plain http, satisfy `local-only`, the tier for Protected B, Protected C, every classified level and NATO Restricted and above, with no TLS pin and no authorization | A mistyped or broad host pattern sends Protected B or Secret content in clear text to whatever server answers that name. | For levels whose tier is `local-only`: a non-loopback host must match an **exact** `localHosts` entry (no wildcard) and the client must use **https**; Protected C, classified and NATO Confidential and above never go to a non-loopback host (new rule `route.not-accredited`, plain sentence). Loopback is unchanged. `localHosts` is empty by default, so only people who edited their policy are affected; they get a one-time notice naming the entry | Yes (Q3): it can refuse a setup someone relies on today |
| S2 | `DEFAULT_ROUTING` sends Secret and Top Secret to any loopback model silently; the guide design says classified work belongs only on accredited systems | A person is told nothing when classified content is processed on an unaccredited laptop. | Report mode: when a chat's label is classified or Protected C, show one notice per chat ("This computer is not recorded as accredited for {label}. Nothing stops you yet; your organization may require an accredited system.") and record `route.not-accredited` in the decision log. No refusal yet | Yes (Q6): warn now, refuse once the organization layer exists |
| S3 | Residency. Checked: nothing on main asks or enforces "must stay in Canada" | None today; the risk is the 32.1 question shipping before the rule. | No code change. F1 adds the `route.residency` rule, and 32.1 depends on F1 | No |
| S4 | "Private" trusts the catalogue: member and team `privacy: private` (`routeAllows` in `src/services/agentSession.ts`), `nearAi.privacyMode: tee-only` (`src/services/outboundGuard.ts`), Team Mode `teeOnly`, and the picker's "Private · runs in NEAR TEE" (`src/services/chatBridge.ts`) all accept `privacyBoundary === 'tee'` plus an attestation-capable route; the gate's `attested-cloud` tier requires a fresh bound connection (D-50) but only applies when the label needs it | A "private" agent or a "TEE only" user at an `org/Public` or unlabelled project can be answered over a connection nobody proved private, while the screen says private. | Treat each as a floor: when a member, team or `tee-only` asks for private, `decideRoute` runs with the tier raised to at least `attested-cloud`, so the bound-connection check decides, and refusals use the existing binding sentences. The picker says "NEAR AI private hardware (checked each time it is used)" | No: it only narrows. Owner informed that private runs may now be refused when the connection proof is stale |
| S5 | Staff templates mark every team private (`src/agent/staff/j2Template.ts`, `j3Operations.ts` `private: true`; `src/domain/staff/releaseGuard.ts` `privacy: private`), and the private TEE models NEAR offers today are all from PRC developers (provenance 4.2), which the provenance decision forbids for T2 and T3 work | Staff officers read "private models only" as "approved for operational work" while every such model is one their own rules will forbid. | Copy only: the staff setup's last screen and the team file's "Private models only" bullet add one sentence: "The private models NEAR AI offers today come from developers in the People's Republic of China. Use this team only on fictional or exercise material until your organization approves a model for operational work." README and SECURITY.md say the same. No routing change | Yes (part of Q3): confirm the sentence, and whether staff setup should prefer a local model when one answers |
| S6 | `parseBundle` refuses any unknown key (`checkKeys`, `BUNDLE_FIELDS`); `unknown-field`, `unsupported-version` and `vocabulary-unknown` texts say "Run NEAR AI: Reset Policy to Defaults" | Once an organization policy exists, an older client would go read-only and its advice would wipe that policy. | (a) Accept an optional `requires: string[]` in v1 now; an unknown feature id refuses with a new `needs-update` text that says "update the extension" and never Reset. (b) Reword the three texts to put "Update the extension" first, and offer Reset only when the bundle's signer is this device, saying what Reset discards. Fail-closed behaviour is unchanged | No |
| S7 | `src/domain/staff/obs/observation.ts` (`rankOf`, `labelAtLeast`, `joinTemplateLabels`), `src/domain/staff/guardScan.ts` and `src/gate/chatLabel.ts` (`markOf`, `raiseBy`) rank labels against the shipped `SCALE_PRESETS`, not the active bundle's scales | With a custom or extended scale, the staff checks and the chat label disagree with the gate about whether something is above a floor, and a chat label on that scale cannot be read. | Pass the active `ScaleTable` from the gate host (`policy.scales`) and call the gate's `dominates` and `joinLabels`; presets remain the fallback only when the policy failed closed (today's `host.ts` behaviour) | No |
| S8 | `labelShown` in `src/services/gateCommands.ts` shows raw keys (`org/Confidential`, `ca-classified/Confidential`) | Two different "Confidential" levels with opposite routing look alike to anyone who does not read scale ids. | Show the scale's own name with the level everywhere a label is shown ("Organization: Confidential", "Canada, Classified: Confidential"), and group the Lower Label list by scale. Ids unchanged | No (the display rename to "Sensitive" is Q8, later) |

Tests: one focused test per item in the existing gate and staff test files (refusal and allow transitions for S1, S2 notice once per chat, S4 floor with stale and fresh binding, S6 `requires` and texts, S7 custom-scale ranking, S8 display). SECURITY.md and README updated in the same PR for S1, S2, S4 and S5.

## 9. Rebuilt roadmap

### 9.1 Milestones in plain words

| # | Milestone | After it, a person can | Phases (today's ids kept) |
|---|---|---|---|
| 1 | **Safety patch** | trust that "private" means checked, that Protected B and Secret never go to a loosely named server, and that an older extension asks to be updated instead of reset | patch PR (section 8) |
| 2 | **Shared staff projects** | work one staff project with colleagues at the same time through your organization's server | 31, 32 (continues now), 33 with POST-01 |
| 3 | **One foundation** | receive your organization's rules on every computer, see one list of where AI may run and one kind of signed exception, and see older versions ask for an update | **41 (F1)**, including the passport schema from 74.1 |
| 4 | **One front door** | answer four plain questions in Get Started, see only options that work, and land where their work is; install local models safely | 32.1, 32.2 |
| 5 | **Positions, offline and shared agent work** | be posted to a position, hand it over, keep working offline or across an air gap, and share agent watches | 33.1, 34, 35 |
| 6 | **More places to run AI** | use a Cohere vault in Canada, with Protected B only under a named authorization | 36, 37 |
| 7 | **Capital projects and the portfolio** | run capital project offices on the staff method, and roll mixed units up into one Portfolio Room | 42 (after 33.1), 38, 39, 40, 43 (after 39) |
| 8 | **Governed agents** (runs beside 2 to 7, as today) | rely on verified identities, delegation that only narrows, sandboxes, a credential broker, run contracts, model approvals by use and your organization's own attested hosting | 71, 72, 73, 74, 74.1 (enforcement), 74.2 |
| 9 | **Data platform** | connect sources in one click and search, ask and analyse labelled data | 85 to 101 (v0.6.0) |
| 10 | **Messaging relay** | reach their teams from Microsoft Teams, Signal and Telegram | 75 to 84 (v0.7.0) |
| 11 | **Later** | the appliance, Team Mode moved onto shared projects, routines, identity on NEAR, federation, the desktop app; cybersecurity last | L1b, L2 to L6; Phase 25 (v0.8.0) |

Phases 28 (secure development workflow step) and 29 (cleanup member) are not blocked by this review; Phase 28 registers as a Get Started checklist step (`registerSetupStep` exists today).

### 9.2 F1 numbering: Phase 41, recommended

Recommended: **Phase 41, "Organization policy foundation"**, with an explicit dependency note that it builds before 32.1, 32.2, 33.1, 36 and 37. Why not 32.0: GSD reads decimals as inserted after their integer phase, so "32.0" would read as part of Phase 32, which is mid-build in other worktrees, and it would sort beside 32's plans. Phase 41 is the next free integer, keeps every existing id stable, and the dependency lines make the order explicit.

F1 contents (requirement ids FND-01 to FND-09, added to REQUIREMENTS.md when Phase 41 is planned):

- FND-01 Organization layer: enrolment file, pinned issuer fingerprint read aloud, personal and project layers that narrow only, declared narrowing direction per key, Reset touching only the personal layer.
- FND-02 Bundle v2 sections, `requires`, `needs-update`, v1 read as v2.
- FND-03 `endpoints[]` replacing `routing.localHosts` (migration at today's effect, one-time notice).
- FND-04 One `authorizations[]` record with kinds and inner signatures; "self-signed on this computer" until an issuer exists.
- FND-05 Residency section and `route.residency`; accredited-device rule in report mode.
- FND-06 One dependency-free label module; `decideRoute` as the one decision function; `privacyMode` and `teeOnly` folded in as floors; `TrustFacts`.
- FND-07 The mode table (`src/domain/org/modes.ts`) and `term()`, moved from 32.1; the copy lint with its baseline.
- FND-08 Passport schema only (WP-0 of 74.1): the `models` section shape, parsed in report mode; 74.1 keeps enforcement, the T0 lane and the defaults.
- FND-09 `ModelEndpoint` and `LocalServerAdmin` interfaces with `NearAiClient` as the first adapter; the architecture test with its baseline; the policy editor shell that receives proposals.

### 9.3 How today's numbering maps

| Today | Becomes |
|---|---|
| 0.4.x Phases 26, 27 (shipped) | unchanged |
| 0.4.x Phases 28, 29 | unchanged; 28 is a Get Started step |
| 0.4.x Phases 30 to 35 (staff collaboration drops A and B) | milestones 2 and 5 |
| 0.4.x Phases 32.1, 32.2 (inserted) | milestone 4, now after Phase 41 |
| 0.4.x Phase 33.1 (inserted) | milestone 5, mode table from Phase 41 |
| 0.4.x Phases 36, 37 | milestone 6, after Phase 41 |
| 0.4.x Phases 38 to 40 | milestone 7 |
| Capital design (PR #110, no phase) | Phases 42 and 43, milestone 7 |
| New | Phase 41 (F1), milestone 3 |
| v0.5.0 Phases 68 to 70 (shipped or executed) | unchanged |
| v0.5.0 Phases 71 to 74, 74.1, 74.2 | milestone 8; 74.1's schema moves to Phase 41 |
| v0.6.0 Phases 85 to 101 | milestone 9 |
| v0.7.0 Phases 75 to 84 | milestone 10 |
| v0.8.0 Phase 25 | milestone 11, last |
| L1a | inside v0.6.0 (unchanged) |
| L1b, L2 to L6 | milestone 11; L5 rewritten as hub federation |

Users see feature names only, never phase numbers.

## 10. Amendments to existing designs

> Amended 2026-11-25 (Phase 48.4, plan 48.4-01): a row for the sovereignty status design.

"Applied" means a short dated note was added to that design file in this PR. "Follow-up" means a larger rewrite, done when the phase is planned.

| Design | What changes | State |
|---|---|---|
| model-provenance | 5.1: `ceiling.models` becomes the v2 `models` section with `requires: models@1`; schema lands in Phase 41 | applied |
| | 8.3: `routing.attestedHosts` becomes `endpoints[]` entries of class `org-tee` | applied |
| | 5.3 acceptances become `authorizations[kind=t1-risk]` with inner signatures | follow-up (74.1 plan) |
| | 6.1 exercise flag becomes a signed project-layer attribute | applied |
| | 8.5 "Adopt the Western defaults" writes a proposal to the policy editor | follow-up |
| | Retire bare "Private" in the picker, README tagline and staff templates (with S4, S5) | follow-up (74.1 integration) |
| cohere-model-vault | 6.5: fourth badge state superseded by the trust line | applied |
| | 6.2: vault entries become `endpoints[]` entries; Standard default `org/Public` only (Q5) | applied |
| | 6.3: Protected B authorization becomes `authorizations[kind=protected-b]` keyed by endpoint id | applied |
| | 6.4: residency enforced by `route.residency`, not only `acceptLevels` | applied |
| | 5.1 profiles reference endpoints by id; WP-CLIENT becomes a `ModelEndpoint` adapter | follow-up (36 plan) |
| guided-onboarding | 9.2: the guide and every flow write proposals into one policy editor; it still never writes the bundle | applied |
| | 8.5: the record is local audit (hash-chained), not "signed with the device key" until signed heads exist | applied |
| | 4.2: Q1 "role" becomes "kind of work"; Q2 names the scale for "Confidential" | applied |
| | 9.3: `onboarding` becomes a v2 section; discovery `personalApprovals` default false | applied |
| | R3 residency: the guide reads `route.residency`; mode table moves to Phase 41 | applied |
| | 12: staff setup's `where` question and discovery `locality` removed | follow-up (32.1 plan) |
| portfolio-and-assignment | 5.4: `organization` becomes `people.organization` in v2; the mode table and `term()` build in Phase 41 | applied |
| | 6.5: the one Portfolio Room; capital views become its capital tab | applied |
| | 3.2: posting authority uses the one delegation rule shared with Phase 71 | follow-up (33.1 plan) |
| data-platform | 3: governance facts ride the replica as entries; item label Merkle roots stay on the host; the host is a hub client | applied |
| | 6.2: aggregation has one evaluator in `domain/gate`, built in Phase 38 | applied |
| | 4.5 copy "personal mark" becomes "Personal: keep out of the catalogue" | follow-up |
| staff-teams (design 10) | 7.1: "private by default" means the gate's verified check; the PRC-origin sentence until an organization T3 approval exists | applied |
| | 4.1: decisions are signed by the person's device or credential, not "the policy key" | applied |
| | "check the roster" becomes "check the team"; section lead becomes a position | follow-up |
| multiuser-sync | 10.6 and 21.2: hub spend cap is the lower of policy and operator; the hub loads the organization layer and runs the same gate core | applied |
| | 19 UX: "your organization's server" as the user word; Add My Other Machine joins My computers | follow-up |
| capital-projects | 8: Portfolio Room merged into portfolio 6.5 as a capital tab | applied |
| | 10.2: WP-P0 re-based on the replica (pack = stream kinds plus fold rules), not `ledger.ts` | applied |
| | 10.5: placed as Phases 42 (after 33.1) and 43 (after 39) | applied |
| | 2.3: the capital profile is a v2 `directives.capital` section with `requires` | applied |
| sovereignty-status (2026-11-25) | glossary rows, copy lint rule 6 phrases, the second status bar item | applied (48.4-01) |

## 11. Owner questions

The four reviews asked about 35 questions. Merged into twelve, each with the recommended default.

| # | Question | Recommended default | Why |
|---|---|---|---|
| Q1 | Add the foundation phase F1 as **Phase 41**, built before 32.1, 32.2, 33.1, 36 and 37, including the passport schema from 74.1? | Yes | Without it "set by your organization" has no delivery path, and every new key would break older clients. |
| Q2 | How does a computer learn its organization's root key before Phase 71? | A signed enrolment file from the security contact, with the fingerprint read aloud like the safety code; a DID later | It works offline and matches a pattern people already use. |
| Q3 | Ship the safety patch (section 8) first, including tightening `localHosts` for Protected B and above (S1) and the PRC-origin sentence on staff teams (S5)? | Yes, as one small PR before Phase 41 | These are live gaps in shipped code; each fix narrows or clarifies. |
| Q4 | Cohere D1: add a fourth badge state, or name the place in every answer and keep three proof levels? | Keep three; add "Runs on" (the trust line) | One trust story instead of five; "cannot be checked" stops looking like "check failed". |
| Q5 | Cohere D2: Standard vault default ceiling? | `org/Public` only; Internal an unticked box with the reason | Internal goes only to attested hardware today; one click should not lower that. |
| Q6 | Classified or Protected C on a computer with no accreditation record? | Warn and record now; refuse once the organization layer exists | Tells people the truth now without breaking anyone before organizations can issue accreditation records. |
| Q7 | Enforce rules everywhere: residency in the gate, the hub running the same gate core and organization rules, hub spend cap the lower of policy and operator? | Yes (residency in Phase 41, hub in Phase 35) | A setup answer that any later choice can undo is not a rule. |
| Q8 | Adopt the glossary: "team" for agents only, members for people, retire the "Team Mode" name and freeze Team Mode until L2, "private" only for verified, always show scale with level, and display the `org` "Confidential" level as "Sensitive" (id unchanged)? | Yes | Ends the collisions the reviews found, most importantly the two "Confidential" levels. |
| Q9 | Make Get Started the only setup command (old ids as aliases for two minor releases), hide staff, cyber and simulation commands outside their projects, one Settings page, and Edit Policy only where this device can sign? | Yes | One front door and half the palette for most people. |
| Q10 | Positions for every shared project (invisible in invitation mode), one delegation rule, and the exercise flag as a signed project attribute? | Yes | One authority model; no unrecorded way to lower a staff project's rules. |
| Q11 | Re-base capital projects on the replica as Phases 42 and 43, one Portfolio Room with a capital tab, and data platform governance facts on the replica instead of a revived Phase 13 log? | Yes | Avoids building on the format multi-user retires and a second portfolio screen. |
| Q12 | Developer structure: architecture test with a recorded baseline and `ModelEndpoint` in Phase 41, one mechanical move PR after it, `@ts-check` for page scripts before any bundler, a shared server kit after Phase 32? | Yes | Later phases land in the target layout without a big-bang rewrite, and Phase 32 is not disturbed. |
