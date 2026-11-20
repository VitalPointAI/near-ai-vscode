# Design: capital project governance teams

Date: 2026-11-18, with the owner's decisions applied (section 11). Status: design for a future feature. Nothing here is built yet.

**Conforms to the coherence review (2026-11-20):** the governance file is "Your directive" on screens and travels as the policy v2 `directives.capital` section with `requires`, signed by your organization's layer ("self-signed on this computer" until then); WP-P0 is re-based on the replica layer (a pack is stream kinds plus fold rules), not on `ledger.ts`; capital roles are positions on the roster, filled by appointment with the Capital projects mode words from `term()`, under the one delegation rule; the Project Room and portfolio views become tabs of the one Portfolio Room; capital setup is a Get Started step and rule changes are proposals in the one policy editor; "private profile" becomes "directive profile, kept out of the repository"; the small-project cell becomes the small-project office; labels show scale name plus level; routing goes through `decideRoute` and answers carry the trust line; placed as Phases 42 and 43. Superseded text is kept with dated notes; open questions with defaults are in section 12. See `.planning/research/coherence/REVIEW.md`.

Inputs: the staff contract (`src/domain/staff/`: doctrine, release state machine, ownership, products, events, team block); staff drop 1 on `feat/staff-drop1` (ledger, person decisions, guard-scan, registers, release-guard, tradecraft lint, write limits, read models, staff setup and commands, templates and grants under `src/agent/staff/`); the staff design (`.planning/research/staff-teams/10-STAFF-TEAMS-DESIGN.md` on `docs/staff-teams-research`, cited "the staff design 4.1"); the data platform design (`.planning/research/data-platform/00-DESIGN.md`) and the v0.6.0 milestone in `.planning/ROADMAP.md`.

Companion files in this folder: `profile.schema.json` (the profile schema, section 2.2) and `example-profile.json` (the neutral example profile, which passes the schema and the integrity checks in section 2.3).

**Source rule (owner, 2026-11-18).** Your organization's internal directive sets the structure this pack mirrors. Its text, names, numbers, sections and dates never appear in the repository and are never committed. In the repository every approval body, gate, path, document, role, check, deadline and threshold is a **neutral slot** with a neutral id and a neutral label. The directive's own names, values and section references live only in your organization's **directive profile** (kept out of the repository; shown on screens as "Your directive"), which maps each slot one-to-one to the directive's item and carries a "same as" reference to its section. Load your directive to see your own names. Every project, figure and name in this design and in the example profile is fictional.

Agents prepare, check and recommend. Named people decide.

---

## 1. Key points first

1. **A governance pack on the staff method.** A capital project team is a staff team with a different pack: lifecycle phases replace planning steps, gates replace the commander's decision, governance documents replace staff products. The release state machine, the signed ledger, the release-guard, single-writer ownership, registers, `DECISION FOR` and `WAITING ON` are reused as they are.
2. **One-to-one with your organization's directive, through neutral slots.** The pack has one slot for every approval body the directive names (16), one gate per directive gate in the same order (7), one path per directive path (4), one document slot per directive document at the phase where it is required (61), one role per directive role (21), one check per mechanical directive rule (61, plus 5 judgement checks), and one setting per directive deadline, threshold, band and limit (83). Section 2.5 lists every slot.
3. **Neutral in the repository, exact names on screen.** Each slot has a neutral id (`board-capability`, `gate-3`, `path-2`, `doc-business-case`) and a neutral label. The directive profile adds `name` (the directive's own term) and `sameAs` (its section). When it is loaded, every screen, team member, check, document header and decision dialog shows the directive's exact name and its "same as" reference, so it is obvious where the tool and the directive talk about the same thing.
4. **Generalize first (WP-P0), on the replica layer.** The staff contract hard-codes military sections, doctrines and steps as closed lists. Before any capital code, it becomes a "method core" with packs: the staff doctrine is the first pack, capital governance the second. A pack is a set of replica stream kinds plus fold rules, so capital decisions, baselines and gate records are signed replica entries like every other shared fact (section 10.2). Staff behaviour does not change. This is the only step that must run alone.
5. **Nothing organization-specific is hard-coded.** The path calculator, the lifecycle and gate machines, the deadline engine, the readiness lint and the guard read slots and settings from the loaded profile. The neutral example profile ships with made-up values; the directive profile is a configuration file in the same format, delivered as the `directives.capital` section of your organization's rules or kept in a git-ignored project file.
6. **The approval path is computed, never typed.** A pure path calculator takes cost (on each cost basis), the complexity and risk rating, the category and flags, and returns the path, the approving bodies in order, the document set, the overlays, the deadlines and a one-line explanation per rule.
7. **Person-only transitions.** Only a named person, posted to the position the chain names, records an endorsement or approval, through signed commands that no agent tool can reach, with a verb the profile allows for that body. Every waiting state has a deadline setting, so nothing waits forever.
8. **Four templates.** A project office (12 agents), a small-project office (6; called the small-project cell before 2026-11-20), a programme office as a team of teams (only for the largest or most complex projects), and a portfolio office (10). One owner per document slot, one readiness reviewer and one release-guard per team.
9. **A capital tab in the one Portfolio Room** (the portfolio design's, 6.5), with a Project tab for one project, and **files first, feeds with v0.6.0**.
10. **Placement: Phase 42 (after Phase 33.1) and Phase 43 (after Phase 39), before v0.6.0.** Fictional data only until verified identities and an accredited host exist. Equipment projects first, on a fictional demo project. (Originally "0.4.x, after staff drop 3"; see 10.5.)

---

## 2. The governance profile

### 2.1 How the one-to-one mapping works

- **Slots are fixed by the pack.** The capital pack defines the slot catalogue: the ids and neutral labels in section 2.5. Code, templates, checks, tests and the example profile refer only to slot ids.
- **A profile fills the slots.** A profile gives every slot its values (thresholds, deadlines, chains of bodies and verbs, required contents) and, in a directive profile, its `name` and `sameAs`. The example profile and the directive profile have exactly the same slot set; the integrity checks refuse a profile with a missing or extra slot.
- **Display rule.** `display.use` is `label` in the example and `name` in a directive profile. Every view renders `name` when the profile is set to use it, and shows `sameAs` beside it on hover and in `PROFILE.md`. Product headers keep the slot id, so a product written under one profile still resolves under another.
- **The crosswalk lives with the directive profile.** The table from neutral slot to the directive's item and section is held only in the directive profile (and any human-readable copy your organization keeps next to it, outside the repository). The repository holds the neutral side only.
- **The guard keeps the directive's text out.** The directive profile may list title and passage fingerprints under `restrictedSources`; the release guard holds any product that contains them. Names are allowed; passages are not.

### 2.2 What the profile holds (schema `profile.schema.json`)

Every item is `{ slot, label, name?, sameAs? }` plus the fields below. `name` and `sameAs` are absent in the example and required on every item in a directive profile.

| Block | Holds | Used by |
|---|---|---|
| `audience`, `display`, `source` | `example` or `private` (ids; `private` means the directive profile, kept out of the repository); which text to show; the source's title and a `doNotQuote` flag | Every view, release guard |
| `currency`, `costBases` | Currency and the cost bases thresholds are counted on | Path calculator, cost workbench, readiness lint |
| `rating` | The complexity and risk rating and its levels | Path calculator, overlays, risk views |
| `sizeClasses` | Size classes with lower and upper bounds as setting slots, a basis, and what happens exactly on a bound | Path calculator, setup |
| `categories`, `projectTypes` | Categories (with which are on) and project types | Setup, overlays, templates |
| `bodies`, `roles` | Every approval body and role, each with the verbs it may record (`note`, `review`, `endorse`, `approve`, `grant`, `direct`, `return`, `defer`) | Gate machine, decision commands, readiness lint |
| `phases`, `exceptionStates` | Phases in order with the gates and decisions needed to leave each; extended close-out, withdrawn, cancelled, closed | Lifecycle machine |
| `gates`, `decisions` | Each gate in order and each other decision, with its phase and its chain of actor and verb; gates list their package of document slots | Gate machine, readiness lint |
| `paths`, `pathRules` | Each path with its approving authority; ordered rules over setting and rating slots that pick a path | Path calculator |
| `estimateClasses` | Each class with its accuracy band, detail rule and the earliest decision it may support | Cost workbench, readiness lint |
| `settings` | Every threshold, limit, band, scale and deadline, with kind, unit, value, the basis (thresholds) and what it is counted from (deadlines) | Everything that compares or counts |
| `overlays` | Extra work a threshold, rating, path or category triggers, with the slots it adds | Path calculator, tracker |
| `documents` | Each document slot: kind, phases due, one owner member (and the small-project office owner where it applies), chain, paths, required contents | Templates, tracker, readiness lint |
| `checks` | Each check slot: family, kind (`lint`, `lint-and-review`, `review`) and the slots it reads | Readiness lint and reviewer |
| `teamOfTeamsWhen` | The condition that selects the programme office | Setup |
| `restrictedSources` | Titles and passage fingerprints that must never appear in a product | Release guard |
| `vocabulary` | Neutral terms with the organization's own term | `PROFILE.md`, members' wording |

### 2.3 Where the profile comes from, and how it is checked

> **Coherence review (2026-11-20):** the profile travels as the `directives.capital` section of policy bundle v2, named in `requires`, so no new `bundleVersion` is needed for it. See `.planning/research/coherence/REVIEW.md` and `POLICY-SCHEMA.md`.

The extension looks in this order and stops at the first it finds:

1. **Your organization's rules** (policy bundle v2, `.planning/research/coherence/POLICY-SCHEMA.md`). The `directives.capital` section carries the directive profile or names it by fingerprint, and the bundle names `directives.capital@1` in `requires`, so an older extension says "update the extension" instead of failing. In the organization layer (pinned issuer, Phase 41) it is your organization's directive and no project member can change it; a member who wants a change sends a proposal from the one policy editor to the security contact. In the personal layer, before an organization issuer exists, it is shown as "self-signed on this computer". A section change never needs a new `bundleVersion`.
2. **A project file outside version control**: `.planning/.near-ai/capital-profile.json`. This folder is already git-ignored. Setup confirms that with `git check-ignore` and refuses to write a profile anywhere that is not ignored.
3. **The shipped example profile**, clearly marked as an example.

> **Superseded 2026-11-20 (coherence review):** item 1 said "a new optional field" in the v1 bundle and "a new `bundleVersion` beside the old one, never a change in place". Policy v2 settles this: a new section named in `requires`, no envelope change (REVIEW conflict K2). The project file (item 2) is still allowed, as owner decision 1 says, unless the organization layer locks `directives.capital` (`onboarding.locked`); then only your organization's directive counts and the project file is reported as unused.

Where the profile is loaded or changed, the person never edits the rules by hand: loading a directive profile into the personal layer, or replacing it, opens the one policy editor on a proposal that says in plain words what changes (for example "gate-3 will need one more endorsement"). Capital setup itself is a step of Get Started (Q1 "Kind of work: Plan or manage capital projects"), not its own command.

Loading runs two checks, both blocking: the JSON schema, then the **integrity checks**: every slot unique and present; the slot set identical to the pack's catalogue; every chain actor exists and may use that verb; gates numbered in order; every phase's exit requirements are gates or decisions; every path reachable from the rules and the last rule an unconditional flag; every threshold names a basis and every deadline names what it counts from; every document has exactly one owner, and one small-project office owner when the small project path uses it; every reference in rules, overlays, checks and conditions resolves; an example profile carries no `name` or `sameAs`, and a directive profile carries both on every item.

`.planning/.near-ai/project.json` records only the profile's id, title and fingerprint (in a shared project, a `project.policy` entry on the project stream records it instead). Every product header records the fingerprint it was written and approved under.

| From | To | Trigger | Notes |
|---|---|---|---|
| (none) | example | No bundle profile and no project file | Banner: "Example directive: values are made up. Load your directive to see your own names." |
| (none) or example | loaded | A valid profile found | Fingerprint recorded |
| any | invalid | Schema or integrity check fails | Nothing runs against it; each problem shown with its path; the last valid profile stays in use and is named |
| loaded | changed | The fingerprint differs from the one recorded | The path calculator re-runs; the difference is shown and recorded as a replica entry (local audit record in a single-machine project); newly required documents enter the tracker in `draft` with their owner; approved products keep the fingerprint they were approved under |
| changed | loaded | The person posted to the project leader position (`role-project-leader`) accepts the change | Decision entry signed by that person's device key (credential from Phase 71) |
| loaded (project file) | loaded (organization) | Your organization's rules carry `directives.capital` | Your organization's directive wins; the project file is reported as unused, not deleted |

No state is stuck: `invalid` always names the profile still in use, and `changed` blocks only new gate submissions until a person accepts it.

### 2.4 The path calculator (pure function)

Inputs: the profile, and the project's category, type, cost record ids per basis (never typed numbers), rating (imported and confirmed by a person) and flags. `pathRules` is ordered and the first match wins. The neutral rule set, as the example profile ships it:

| Rule | When | Outcome |
|---|---|---|
| `rule-1` | cost on `basis-acquisition` below `set-threshold-small-floor` | flag for a person |
| `rule-2` | cost on `basis-total` below `set-threshold-major` | `path-1` |
| `rule-3` | rating above `set-limit-rating-delegation` | `path-4` |
| `rule-4` | rating equals `rating-3` | `path-3` |
| `rule-5` | rating at most `rating-2` and cost on `basis-total` at most `set-threshold-delegated-max` | `path-2` |
| `rule-6` | anything else | flag for a person |

Size classes set what happens exactly on a bound (`onBound`), so a value equal to a threshold is routed as the profile says and also flagged. Outputs: the path, the chain of bodies per gate and decision, the overlays that apply (with what each adds), the document set for the path, category and phase, the deadlines, the team template (from size class and `teamOfTeamsWhen`), and one explanation line per rule or overlay that fired, naming the basis it used. A changed input re-runs it and shows what changed. No clock, no I/O, no network.

### 2.5 The neutral structure, slot by slot

These tables are generated from `example-profile.json`. A directive profile fills the same slots with your organization's names, values and section references.

#### Approval bodies (16)

| Slot | Neutral label | Kind | Verbs it may record |
|---|---|---|---|
| `board-capability` | Capability board | board | approve, direct, note, return, defer |
| `board-programme` | Programme management board | board | approve, endorse, direct, note, return, defer |
| `board-resources` | Resource management committee | board | approve, direct, note, return, defer |
| `board-project-review` | Project review board | board | endorse, note, review |
| `board-infrastructure` | Infrastructure board | board | endorse, approve, note |
| `board-digital` | Digital board | board | review, endorse, return |
| `board-procurement-strategy` | Procurement strategy committee | board | review, endorse, approve |
| `board-financial-inputs` | Financial inputs committee | board | review, endorse |
| `board-change-control` | Change control board | board | approve, return, defer |
| `panel-independent-review` | Independent review panel | panel | review, note |
| `authority-minister` | Minister | authority | grant, approve, return |
| `authority-central` | Central approving authority | authority | grant, approve, return |
| `authority-central-staff` | Central agency staff | authority | review, note |
| `authority-deputy-head` | Deputy head | authority | grant, approve, return |
| `authority-delegated` | Delegated senior authority | authority | approve, return |
| `authority-contracting` | Contracting authority | authority | approve, review, return |

#### Roles (21)

| Slot | Neutral label | Verbs it may record |
|---|---|---|
| `role-project-leader` | Project leader | approve, endorse, note |
| `role-sponsor` | Project sponsor | approve, endorse, review |
| `role-implementer` | Project implementer | approve, endorse |
| `role-project-director` | Project director | review |
| `role-project-manager` | Project manager | review |
| `role-sponsor-executive` | Sponsor's senior executive | endorse, review |
| `role-capability-development` | Capability development staff | review, endorse, approve |
| `role-programme-coordination` | Programme coordination staff | review |
| `role-finance-officer` | Chief financial officer | approve |
| `role-costing-authority` | Costing authority | review, approve |
| `role-submissions-office` | Submissions office | review |
| `role-infrastructure-authority` | Infrastructure authority | approve, review |
| `role-digital-authority` | Digital authority | approve, review |
| `role-security-officer` | Chief security officer | approve, review |
| `role-benefits-authority` | Industrial benefits authority | review |
| `role-infrastructure-contracting` | Infrastructure contracting agent | approve |
| `role-legal-advisor` | Legal advisor | review |
| `role-integration-analyst` | Joint integration analyst | review |
| `role-capability-board-chair` | Capability board chair | approve |
| `role-senior-official` | Appointed senior official | approve |
| `role-operations-certifier` | Operational necessity certifier | approve |

#### Phases (7)

| Slot | Neutral label | Leaves the phase when |
|---|---|---|
| `phase-1` | Need identification | gate-1, gate-2 |
| `phase-2` | Options analysis | gate-3, gate-4 |
| `phase-3` | Transition to definition | dec-1 |
| `phase-4` | Definition | dec-16 |
| `phase-5` | Transition to delivery | gate-5, dec-2, dec-3 |
| `phase-6` | Delivery | gate-6, gate-7, dec-5 |
| `phase-7` | Close-out | dec-6 |

#### Exception states (4)

| Slot | Neutral label |
|---|---|
| `state-extended-closeout` | Extended close-out |
| `state-withdrawn` | Withdrawn |
| `state-cancelled` | Cancelled |
| `state-closed` | Closed |

#### Gates, in order (7)

| Slot | Neutral label | Phase | Chain (actor, verb) | Package |
|---|---|---|---|---|
| `gate-1` | Priority confirmed | phase-1 | board-resources approve | doc-priority-form |
| `gate-2` | Need and context confirmed | phase-1 | role-sponsor-executive endorse; board-capability approve | doc-strategic-case, doc-high-level-requirements, doc-management-plan, doc-complexity-rating, doc-benefits-plan, doc-schedule, doc-capability-impact, doc-capability-board-package |
| `gate-3` | Option chosen | phase-2 | board-project-review endorse; role-sponsor endorse; board-capability approve | doc-business-case, doc-scope-tiers, doc-requirements-preliminary, doc-high-level-requirements, doc-capability-board-package |
| `gate-4` | Governance confirmed | phase-2 | board-project-review endorse; role-project-leader approve | doc-charter, doc-management-plan, doc-review-record |
| `gate-5` | Departmental approval | phase-5 | board-project-review endorse; board-digital review; board-programme approve | doc-programme-board-package, doc-project-brief, doc-capability-impact, doc-requirements-statement, doc-management-plan, doc-complexity-rating, doc-cost-report, doc-approval-submission |
| `gate-6` | Initial capability accepted | phase-6 | board-project-review endorse; role-sponsor approve | doc-initial-capability-certificate |
| `gate-7` | Full capability accepted | phase-6 | board-project-review endorse; role-sponsor approve | doc-full-capability-certificate |

#### Other decisions (lifecycle and exception transitions) (16)

| Slot | Neutral label | Phase | Chain (actor, verb) |
|---|---|---|---|
| `dec-1` | Definition investment approval | phase-3 | board-project-review endorse; board-digital review; board-programme approve; board-resources approve; authority-minister grant; authority-central grant |
| `dec-2` | Delivery investment approval | phase-5 | board-programme approve; board-resources approve; authority-minister grant; authority-central grant |
| `dec-3` | Contracting approval | phase-5 | authority-contracting approve |
| `dec-4` | Conditional release under the tailored process | phase-5 | board-programme approve; board-resources approve |
| `dec-5` | Close-out entry | phase-6 | board-project-review endorse; role-project-leader approve |
| `dec-6` | Close-out complete | phase-7 | board-project-review endorse; role-programme-coordination review |
| `dec-7` | Extended close-out plan | phase-7 | board-project-review endorse; role-project-leader approve |
| `dec-8` | Withdrawal | any | role-sponsor approve; board-capability note |
| `dec-9` | Cancellation | any | board-project-review endorse; role-project-leader endorse; board-programme endorse; authority-deputy-head approve |
| `dec-10` | Fixed budget approach | phase-3 | board-project-review endorse; board-capability approve |
| `dec-11` | Funding change | phase-3 | board-programme approve; board-resources approve |
| `dec-12` | Significant requirement change | any | board-project-review endorse; board-capability approve |
| `dec-13` | Complexity rating acknowledgement | phase-3 | authority-central-staff review |
| `dec-14` | Definition waived or accelerated | phase-3 | board-programme approve |
| `dec-15` | Contingency release | phase-6 | board-project-review review; role-project-leader approve |
| `dec-16` | Definition complete | phase-4 | role-sponsor approve |

#### Approval paths (4)

| Slot | Neutral label | Approving authority |
|---|---|---|
| `path-1` | Small project path | authority-delegated |
| `path-2` | Delegated major path | authority-deputy-head |
| `path-3` | Ministerial path | authority-minister |
| `path-4` | Central authority path | authority-central |

#### Complexity and risk rating levels (4)

| Slot | Neutral label |
|---|---|
| `rating-1` | Rating 1 (lowest) |
| `rating-2` | Rating 2 |
| `rating-3` | Rating 3 |
| `rating-4` | Rating 4 (highest) |

#### Cost bases (6)

| Slot | Neutral label |
|---|---|
| `basis-total` | Total cost with taxes, benefits loading and contingency |
| `basis-base-year` | Base-year cost |
| `basis-base-year-ex-tax` | Base-year cost without taxes |
| `basis-acquisition` | Acquisition cost with taxes |
| `basis-procurement-value` | Equipment procurement value |
| `basis-sustainment` | Contracted sustainment to end of life |

#### Size classes (3)

| Slot | Neutral label | Lower bound | Upper bound | Basis |
|---|---|---|---|---|
| `class-small` | Small |  | set-threshold-major | basis-total |
| `class-major` | Major | set-threshold-major | set-threshold-delegated-max | basis-total |
| `class-major-large` | Major, large | set-threshold-delegated-max |  | basis-total |

#### Estimate classes (3)

| Slot | Neutral label | Earliest decision it may support |
|---|---|---|
| `est-1` | Order-of-magnitude estimate | gate-2 |
| `est-2` | Preliminary estimate | dec-1 |
| `est-3` | Committed estimate | dec-2 |

#### Categories (7)

| Slot | Neutral label | On at first release |
|---|---|---|
| `cat-equipment` | Equipment | yes |
| `cat-infrastructure` | Infrastructure | later |
| `cat-embedded-infrastructure` | Infrastructure within another project | later |
| `cat-digital` | Digital | later |
| `cat-restricted-access` | Restricted-access programme | later |
| `cat-munitions` | Munitions | later |
| `cat-operating` | Operating-funded investment | later |

#### Project types (8)

| Slot | Neutral label |
|---|---|
| `type-standard` | Standard |
| `type-multi-phase` | Multi-phase |
| `type-cyclical` | Cyclical |
| `type-small` | Small |
| `type-urgent` | Urgent |
| `type-programme` | Programme |
| `type-enduring` | Enduring programme |
| `type-portfolio` | Portfolio |

#### Overlays (extra work a threshold or category triggers) (19)

| Slot | Neutral label | Adds |
|---|---|---|
| `ovl-project-number` | Project number in the financial system | a computed value |
| `ovl-document-portal` | Core documents in the project portal | a computed value |
| `ovl-rating-required` | Complexity and risk rating | doc-complexity-rating, dec-13 |
| `ovl-formal-costing` | Estimate by the costing authority | doc-cost-report, doc-finance-attestation |
| `ovl-oversight-report` | Central oversight report | doc-oversight-report |
| `ovl-appointment-letter` | Appointed senior official | doc-appointment-letter |
| `ovl-leader-level` | Seniority of the project leader | a computed value |
| `ovl-independent-review` | Independent review panel | panel-independent-review, doc-independent-review-responses |
| `ovl-procurement-governance` | Procurement strategy committee | board-procurement-strategy |
| `ovl-industrial-benefits` | Industrial benefits | doc-industrial-benefits |
| `ovl-sustainment-case` | Sustainment business case | doc-sustainment-case |
| `ovl-contracting-authority` | External contracting authority | authority-contracting |
| `ovl-approval-board` | Which board grants departmental approval | board-programme, board-resources |
| `ovl-tailored-process` | Tailored approval process | dec-4, doc-tailored-package |
| `ovl-paper-decision-limits` | Limits on paper decisions at the capability board | a computed value |
| `ovl-urgent-process` | Urgent project processes | role-operations-certifier |
| `ovl-investment-plan` | Investment plan listing | a computed value |
| `ovl-digital` | Digital gate and concept case | board-digital, doc-digital-concept-case, doc-shared-services-requirements |
| `ovl-infrastructure` | Infrastructure authority involvement | role-infrastructure-authority, doc-infrastructure-requirements, board-infrastructure |

#### Documents (61)

| Slot | Neutral label | Phases due | Owner (project office) | Chain (actor, verb) | Paths |
|---|---|---|---|---|---|
| `doc-capability-gap` | Capability gap statement | phase-1 | requirements-analyst | role-sponsor endorse; board-capability note | path-2, path-3, path-4 |
| `doc-priority-form` | Investment priority input | phase-1 | options-analyst | role-sponsor approve; board-resources approve | path-2, path-3, path-4 |
| `doc-high-level-requirements` | High-level requirements | phase-1, phase-2 | requirements-analyst | board-project-review endorse; board-capability approve | path-2, path-3, path-4 |
| `doc-strategic-case` | Strategic case and option screening | phase-1 | options-analyst | role-sponsor-executive endorse; board-capability approve | path-2, path-3, path-4 |
| `doc-business-case` | Business case | phase-2 | options-analyst | board-project-review endorse; role-sponsor endorse; board-capability approve | path-2, path-3, path-4 |
| `doc-scope-tiers` | Scope tiers | phase-2 | options-analyst | board-project-review endorse | path-2, path-3, path-4 |
| `doc-complexity-rating` | Complexity and risk rating | phase-1, phase-3 | risk-analyst | role-sponsor-executive endorse; role-sponsor approve; authority-central-staff review | path-2, path-3, path-4 |
| `doc-management-plan` | Project management plan | phase-1, phase-3, phase-4 | project-office-lead | role-project-leader approve | path-1, path-2, path-3, path-4 |
| `doc-schedule` | Project schedule | phase-1, phase-2, phase-4, phase-6 | schedule-analyst | role-project-leader approve | path-1, path-2, path-3, path-4 |
| `doc-benefits-plan` | Benefits realization plan | phase-1 | benefits-analyst | role-sponsor approve | path-2, path-3, path-4 |
| `doc-capability-impact` | Capability impact annex | phase-1, phase-2 | impact-analyst | role-sponsor-executive review; role-infrastructure-authority approve | path-2, path-3, path-4 |
| `doc-charter` | Project charter | phase-2 | project-office-lead | board-project-review endorse; role-project-leader approve | path-2, path-3, path-4 |
| `doc-project-brief` | Project brief | phase-2, phase-3, phase-5 | project-office-lead | role-sponsor-executive endorse; board-project-review review | path-2, path-3, path-4 |
| `doc-requirements-preliminary` | Preliminary operational requirements | phase-2 | requirements-analyst | board-project-review endorse; role-capability-development endorse; role-sponsor approve | path-2, path-3, path-4 |
| `doc-requirements-statement` | Operational requirements statement | phase-4 | requirements-analyst | board-project-review endorse; role-capability-development endorse; role-sponsor approve | path-2, path-3, path-4 |
| `doc-infrastructure-requirements` | Infrastructure requirements | phase-3, phase-4 | impact-analyst | role-infrastructure-authority approve | path-2, path-3, path-4 |
| `doc-sustainment-case` | Sustainment business case | phase-2, phase-4 | procurement-planner | board-procurement-strategy review; role-project-leader approve | path-2, path-3, path-4 |
| `doc-costing-data` | Cost breakdown and costing data | phase-3, phase-5 | cost-analyst | role-costing-authority review | path-1, path-2, path-3, path-4 |
| `doc-cost-report` | Independent cost report | phase-3, phase-5 | cost-analyst | role-costing-authority approve | path-2, path-3, path-4 |
| `doc-finance-attestation` | Finance attestation | phase-3, phase-5 | cost-analyst | role-finance-officer approve | path-2, path-3, path-4 |
| `doc-funding-change-proposal` | Funding change proposal | phase-3 | cost-analyst | board-programme approve; board-resources approve | path-2, path-3, path-4 |
| `doc-funding-impact-analysis` | Funding change impact analysis | phase-3 | finance-analyst | role-programme-coordination review | path-2, path-3, path-4 |
| `doc-approval-submission` | Approval submission | phase-3, phase-5 | project-office-lead | role-sponsor approve; role-submissions-office review; authority-minister grant; authority-central grant | path-2, path-3, path-4 |
| `doc-equity-assessment` | Equity and inclusion assessment | phase-1 | assessments-analyst | role-sponsor review | path-2, path-3, path-4 |
| `doc-environmental-assessment` | Strategic environmental assessment | phase-1, phase-3 | assessments-analyst | role-sponsor review | path-2, path-3, path-4 |
| `doc-rights-assessment` | Treaty and rights implications assessment | phase-3 | assessments-analyst | role-legal-advisor review | path-2, path-3, path-4 |
| `doc-oversight-report` | Central oversight report | phase-3, phase-5, phase-7 | performance-reporter | role-project-leader approve | path-2, path-3, path-4 |
| `doc-review-record` | Project review board record | phase-2, phase-3, phase-4, phase-5, phase-6, phase-7 | project-office-lead | role-project-leader approve | path-2, path-3, path-4 |
| `doc-capability-board-package` | Capability board package | phase-1, phase-2 | project-office-lead | role-sponsor review; role-capability-board-chair approve | path-2, path-3, path-4 |
| `doc-programme-board-package` | Programme board package | phase-3, phase-5 | project-office-lead | role-programme-coordination review | path-2, path-3, path-4 |
| `doc-tailored-package` | Conditional release package | phase-5 | project-office-lead | board-programme approve; board-resources approve | path-3 |
| `doc-independent-review-responses` | Independent review response matrix | phase-1, phase-2 | requirements-analyst | role-project-director review | path-2, path-3, path-4 |
| `doc-market-engagement` | Market engagement drafts | phase-2, phase-4 | procurement-planner | authority-contracting approve | path-2, path-3, path-4 |
| `doc-bid-evaluation-plan` | Bid evaluation plan | phase-4 | procurement-planner | authority-contracting approve | path-1, path-2, path-3, path-4 |
| `doc-solicitation` | Solicitation requirements | phase-4 | procurement-planner | role-sponsor endorse; authority-contracting approve | path-2, path-3, path-4 |
| `doc-initial-capability-certificate` | Initial capability certificate | phase-6 | requirements-analyst | board-project-review endorse; role-sponsor approve; role-implementer approve | path-2, path-3, path-4 |
| `doc-full-capability-certificate` | Full capability certificate | phase-6 | requirements-analyst | board-project-review endorse; role-sponsor approve; role-implementer approve | path-2, path-3, path-4 |
| `doc-extended-closeout-plan` | Extended close-out plan | phase-7 | project-office-lead | board-project-review endorse; role-project-leader approve | path-1, path-2, path-3, path-4 |
| `doc-completion-report` | Project completion report | phase-7 | project-office-lead | board-project-review endorse; role-project-leader approve | path-1, path-2, path-3, path-4 |
| `doc-closeout-checklist` | Close-out checklist | phase-7 | project-office-lead | board-project-review review | path-1, path-2, path-3, path-4 |
| `doc-cancellation-report` | Cancellation report | state-cancelled | project-office-lead | board-project-review endorse; authority-deputy-head approve | path-1, path-2, path-3, path-4 |
| `doc-withdrawal-report` | Withdrawal report | state-withdrawn | project-office-lead | role-sponsor approve | path-1, path-2, path-3, path-4 |
| `doc-closure-notice` | Closure notice | phase-7 | project-office-lead | role-project-leader approve | path-1, path-2, path-3, path-4 |
| `doc-small-project-form` | Small project submission | phase-1 | small-project-lead | authority-delegated approve | path-1 |
| `doc-digital-concept-case` | Digital concept case | phase-1 | options-analyst | role-digital-authority approve | path-1, path-2, path-3, path-4 |
| `doc-shared-services-requirements` | Shared IT services requirements | phase-3 | impact-analyst | role-digital-authority review | path-1, path-2, path-3, path-4 |
| `doc-security-package` | Security requirements package | phase-2, phase-4 | assessments-analyst | role-security-officer approve | path-2, path-3, path-4 |
| `doc-risk-register` | Risk register | phase-1, phase-2, phase-3, phase-4, phase-5, phase-6 | risk-analyst | role-project-leader approve | path-1, path-2, path-3, path-4 |
| `doc-risk-plan` | Risk management plan | phase-2 | risk-analyst | role-project-leader approve | path-2, path-3, path-4 |
| `doc-performance-plan` | Performance management plan | phase-2 | benefits-analyst | role-project-leader approve | path-2, path-3, path-4 |
| `doc-performance-report` | Performance report | phase-4, phase-5, phase-6 | benefits-analyst | role-project-manager review; board-project-review note | path-2, path-3, path-4 |
| `doc-appointment-letter` | Senior official appointment letter | phase-2 | project-office-lead | authority-deputy-head approve | path-3, path-4 |
| `doc-lessons` | Lessons learned entries | phase-1, phase-2, phase-3, phase-4, phase-5, phase-6, phase-7 | project-office-lead | role-project-leader approve | path-1, path-2, path-3, path-4 |
| `doc-requirements-trace` | Requirements traceability matrix | phase-2, phase-4, phase-6 | requirements-analyst | role-project-leader approve | path-2, path-3, path-4 |
| `doc-procurement-plan` | Procurement strategy | phase-2, phase-3 | procurement-planner | role-project-leader approve; authority-contracting review | path-1, path-2, path-3, path-4 |
| `doc-industrial-benefits` | Industrial benefits plan | phase-2, phase-4 | procurement-planner | role-benefits-authority review | path-2, path-3, path-4 |
| `doc-assumptions-register` | Assumptions and constraints register | phase-1, phase-2 | options-analyst | role-project-leader approve | path-2, path-3, path-4 |
| `doc-interdependency-register` | Interdependency register | phase-1, phase-2, phase-6 | impact-analyst | role-project-leader approve | path-2, path-3, path-4 |
| `doc-fixed-budget-status` | Fixed budget status update | phase-4, phase-6 | cost-analyst | board-project-review note | path-2, path-3, path-4 |
| `doc-change-request` | Change request | phase-4, phase-6 | project-office-lead | board-change-control approve | path-1, path-2, path-3, path-4 |
| `doc-planning-readiness-package` | Planning meeting readiness package | phase-3, phase-5 | project-office-lead | role-programme-coordination review | path-2, path-3, path-4 |

#### Checks (66)

| Slot | Neutral label | Family | Kind |
|---|---|---|---|
| `chk-complete-01` | Every document the path and phase require exists with an owner and a state | completeness | lint |
| `chk-complete-02` | Strategic case has every required part | completeness | lint |
| `chk-complete-03` | Rated criteria include at least the minimum set | completeness | lint |
| `chk-complete-04` | Recommendation and management parts of the business case are complete | completeness | lint |
| `chk-complete-05` | Approval submission has every required section and appendix | completeness | lint |
| `chk-complete-06` | Project brief covers every required element and risk summary part | completeness | lint |
| `chk-complete-07` | Benefits plan has every minimum element | completeness | lint |
| `chk-complete-08` | Risk register rows have every required field | completeness | lint |
| `chk-complete-09` | Risk plan covers every required topic | completeness | lint |
| `chk-complete-10` | Capability impact annex addresses every impact line | completeness | lint |
| `chk-complete-11` | Subsidiary plans are separate or included as the rating requires | completeness | lint |
| `chk-complete-12` | Planning meeting readiness package is complete | completeness | lint |
| `chk-complete-13` | Cancellation report and extended close-out plan are complete | completeness | lint |
| `chk-complete-14` | Bid evaluation plan has criteria, scoring and selection method | completeness | lint |
| `chk-complete-15` | Performance plan has indicators, targets and a review schedule | completeness | lint |
| `chk-cost-01` | Every figure cites a calculator record | cost | lint |
| `chk-cost-02` | Figures state their basis and what they include | cost | lint |
| `chk-cost-03` | Each threshold test uses the basis the profile names | cost | lint |
| `chk-cost-04` | Estimate class fits the approval sought | cost | lint |
| `chk-cost-05` | Estimate range and detail fit the class's band | cost | lint |
| `chk-cost-06` | Low-accuracy estimates stay out of external and plan documents | cost | lint |
| `chk-cost-07` | Sustainment, operating and infrastructure costs estimated to the same accuracy, with funding source | cost | review |
| `chk-cost-08` | Contingency derived from risk analysis and used within scope | cost | review |
| `chk-cost-09` | Each scope tier carries a cost with confidence | cost | lint |
| `chk-cost-10` | Tailored release band computed and routed to the right body | cost | lint |
| `chk-consistency-01` | Same figures, quantities and places across documents | consistency | lint |
| `chk-consistency-02` | Business case parts agree, tables match text, scoring complete | consistency | lint-and-review |
| `chk-consistency-03` | Every outcome links to a requirement and a screening criterion | consistency | lint |
| `chk-consistency-04` | Options failing screening are marked not viable; status quo kept | consistency | lint |
| `chk-consistency-05` | Operational requirements contain every approved high-level requirement and exceed none | consistency | lint-and-review |
| `chk-consistency-06` | Equity findings appear in every document that must reflect them | consistency | lint-and-review |
| `chk-consistency-07` | Trace from gap to acceptance is unbroken | consistency | lint |
| `chk-consistency-08` | Milestones agree everywhere and change only with a new approval | consistency | lint |
| `chk-consistency-09` | Project leader named fits the phase and the delegation level | consistency | lint |
| `chk-consistency-10` | Rating agrees across the assessment, the brief and the path | consistency | lint |
| `chk-quality-01` | Business need within the sentence limit and traceable | quality | lint-and-review |
| `chk-quality-02` | Outcomes avoid vague terms and are measurable | quality | lint |
| `chk-quality-03` | Each high-level requirement has levels, is pass or fail, and states an effect | quality | lint-and-review |
| `chk-quality-04` | Business case within its page limit | quality | lint |
| `chk-quality-05` | Scoring explained; deciding factors when the top score is not recommended | quality | lint-and-review |
| `chk-quality-06` | Scope tiers start at the minimum requirement and include a preferred tier | quality | lint |
| `chk-quality-07` | Gap statement describes a gap, not equipment | quality | review |
| `chk-quality-08` | Board briefings within time, slide and language rules | quality | lint |
| `chk-risk-01` | Risk level matches the heat map value | risk | lint |
| `chk-risk-02` | High risks in definition or delivery have an escalation record | risk | lint |
| `chk-risk-03` | Cost and schedule risk impacts classed against the tolerance table | risk | lint |
| `chk-risk-04` | Action plans say what and when; residual risk assessed | risk | lint |
| `chk-risk-05` | Cost, schedule and scope risks aggregated | risk | lint |
| `chk-risk-06` | Harmful assumptions also registered as risks | risk | review |
| `chk-risk-07` | Interdependency risks recorded and reported | risk | lint |
| `chk-risk-08` | Mandatory considerations raised | risk | lint-and-review |
| `chk-benefits-01` | Every benefit has a results link, indicator, baseline, target and owner | benefits | lint |
| `chk-benefits-02` | Benefits plan updated at each gate and handed over at close-out | benefits | lint |
| `chk-benefits-03` | Indicators computed with the profile's bands, period and to date | benefits | lint |
| `chk-benefits-04` | A red indicator triggers an unscheduled review | benefits | lint |
| `chk-benefits-05` | Outcomes are not outputs | benefits | review |
| `chk-governance-01` | No agent text records a decision as made | governance | lint |
| `chk-governance-02` | Recorded verb fits the body | governance | lint |
| `chk-governance-03` | Every deadline tracked; overdue raises an item | governance | lint |
| `chk-governance-04` | Lessons entered at the end of each phase | governance | lint |
| `chk-governance-05` | Oversight report filed within its deadline | governance | lint |
| `chk-governance-06` | Stalled projects flagged | governance | lint |
| `chk-governance-07` | Appointment letter present where required | governance | lint |
| `chk-governance-08` | Every overlay that applies has been applied | governance | lint |
| `chk-governance-09` | Significant baseline change routed to the approving authority | governance | lint |
| `chk-governance-10` | Close-out within its deadline or an approved extended plan | governance | lint |

#### Settings (83)

| Slot | Neutral label | Kind | Unit | Counted from | Basis |
|---|---|---|---|---|---|
| `set-threshold-major` | Lower bound of a major project | threshold | currency-millions |  | basis-total |
| `set-threshold-small-floor` | Lower bound of the small project path | threshold | currency-millions |  | basis-acquisition |
| `set-threshold-delegated-max` | Upper bound of the delegated major path | threshold | currency-millions |  | basis-total |
| `set-threshold-project-number` | Cost at which an initiative gets a project number | threshold | currency-millions |  | basis-total |
| `set-threshold-rating-required` | Cost at which a complexity and risk rating is required | threshold | currency-millions |  | basis-total |
| `set-threshold-formal-costing` | Cost at which the costing authority prepares the estimate | threshold | currency-millions |  | basis-total |
| `set-threshold-oversight-report` | Cost at which the central oversight report is required | threshold | currency-millions |  | basis-total |
| `set-threshold-appointment-letter` | Cost at which a rating-3 project needs an appointed senior official | threshold | currency-millions |  | basis-total |
| `set-threshold-leader-senior` | Cost above which a rating 1 or 2 project needs a more senior project leader | threshold | currency-millions |  | basis-total |
| `set-threshold-independent-review` | Cost at which the independent review panel applies | threshold | currency-millions |  | basis-base-year-ex-tax |
| `set-threshold-procurement-governance` | Procurement value at which the procurement strategy committee applies | threshold | currency-millions |  | basis-procurement-value |
| `set-threshold-industrial-benefits` | Value above which industrial benefits apply | threshold | currency-millions |  | basis-procurement-value |
| `set-threshold-industrial-benefits-review` | Value from which industrial benefits are reviewed case by case | threshold | currency-millions |  | basis-procurement-value |
| `set-threshold-sustainment-case` | Sustainment value at which a sustainment business case is required | threshold | currency-millions |  | basis-sustainment |
| `set-threshold-internal-contracting` | Contract value above which an external contracting authority acts | threshold | currency-millions |  | basis-procurement-value |
| `set-threshold-programme-board-max` | Cost above which the programme board's approval is conditional on the resource committee | threshold | currency-millions |  | basis-total |
| `set-threshold-operating-board-min` | Operating-funded proposals: lower bound for the programme board | threshold | currency-millions |  | basis-total |
| `set-threshold-operating-board-max` | Operating-funded proposals: upper bound for the programme board | threshold | currency-millions |  | basis-total |
| `set-threshold-tailored-board-split` | Tailored release: cost above which the resource committee acts | threshold | currency-millions |  | basis-total |
| `set-threshold-urgent-small` | Urgent projects: upper bound of the small urgent process | threshold | currency-millions |  | basis-total |
| `set-threshold-urgent-max` | Urgent projects: upper bound of the delegated urgent process | threshold | currency-millions |  | basis-total |
| `set-threshold-investment-plan` | Cost at which a project is listed in the investment plan | threshold | currency-millions |  | basis-total |
| `set-threshold-ministerial-base` | Base approval limit before the department's class is applied | threshold | currency-millions |  | basis-total |
| `set-limit-rating-delegation` | Highest rating the department may approve itself | limit | rating |  |  |
| `set-band-tailored-secretarial` | Tailored release: cost change within which release is by paper | limit | percent |  |  |
| `set-band-tailored-board` | Tailored release: cost change within which a board releases | limit | percent |  |  |
| `set-limit-paper-cost-change` | Capability board: cost change above which a paper decision is not allowed | limit | percent |  |  |
| `set-limit-paper-schedule-change` | Capability board: schedule change above which a paper decision is not allowed | limit | months |  |  |
| `set-band-risk-schedule` | Risk tolerance for delay to capability milestones | band | months |  |  |
| `set-band-risk-cost` | Risk tolerance for cost against contingency | band | rule |  |  |
| `set-limit-significant-schedule-change` | Schedule change that counts as a significant baseline change | limit | calendar-days |  |  |
| `set-scale-risk` | Risk likelihood and impact scales | scale | levels |  |  |
| `set-band-scope-changes` | Indicator: changes to the project definition | band | count |  |  |
| `set-band-milestone-slippage` | Indicator: slippage to the next planned milestone | band | percent |  |  |
| `set-band-capability-slippage` | Indicator: slippage of the capability milestones | band | percent |  |  |
| `set-band-impact-analyses` | Indicator: requests for more resources | band | count |  |  |
| `set-band-spend-midyear` | Indicator: actual against forecast spend at mid-year | band | percent |  |  |
| `set-band-spend-yearend` | Indicator: actual against forecast spend at year end | band | percent |  |  |
| `set-band-authority-spent` | Indicator: share of spending authority spent, committed and forecast | band | percent |  |  |
| `set-limit-business-case-pages-full` | Business case page limit, full version | limit | pages |  |  |
| `set-limit-business-case-pages-light` | Business case page limit, light version | limit | pages |  |  |
| `set-limit-gap-statement-pages` | Capability gap statement length | limit | pages |  |  |
| `set-limit-need-sentences` | Business need length | limit | sentences |  |  |
| `set-limit-brief-minutes` | Board briefing length | limit | minutes |  |  |
| `set-limit-brief-slides` | Board briefing slide count | limit | slides |  |  |
| `set-limit-brief-languages` | Languages a board briefing must be in | limit | languages |  |  |
| `set-limit-rated-criteria-min` | Minimum rated criteria in the options analysis | limit | count |  |  |
| `set-deadline-review-record` | Project review board decision record circulated | deadline | working-days | after:meeting:board-project-review |  |
| `set-deadline-review-frequency` | Project review board meets at least every | deadline | months | after:meeting:board-project-review |  |
| `set-deadline-first-review` | First project review board after the need gate | deadline | months | after:gate-2 |  |
| `set-deadline-launch-meeting` | Launch meeting after the need gate | deadline | weeks | after:gate-2 |  |
| `set-deadline-charter` | Charter after options analysis starts | deadline | calendar-days | after:enter:phase-2 |  |
| `set-deadline-independent-review-first` | First independent review after the need gate | deadline | months | after:gate-2 |  |
| `set-deadline-options-duration` | Expected length of options analysis | deadline | years | after:enter:phase-2 |  |
| `set-deadline-capability-board-review` | Capability board: case to central staff for review before the meeting | deadline | working-days | before:meeting:board-capability |  |
| `set-deadline-capability-board-package` | Capability board: signed package before the meeting | deadline | working-days | before:meeting:board-capability |  |
| `set-deadline-capability-board-deck` | Capability board: briefing after the pre-brief | deadline | hours | after:prebrief:board-capability |  |
| `set-deadline-capability-board-final-deck` | Capability board: final briefing before the meeting | deadline | calendar-days | before:meeting:board-capability |  |
| `set-deadline-programme-board-package` | Programme board: package to the coordinating analyst before the meeting | deadline | working-days | before:meeting:board-programme |  |
| `set-deadline-programme-board-members` | Programme board: package to members before the meeting | deadline | working-days | before:meeting:board-programme |  |
| `set-deadline-programme-board-concurrence` | Programme board: concurrence before the meeting | deadline | working-days | before:meeting:board-programme |  |
| `set-deadline-planning-meeting` | Planning meeting after its readiness check | deadline | calendar-days | after:readiness-check |  |
| `set-deadline-planning-review` | Central staff review before the planning meeting | deadline | working-days | before:planning-meeting |  |
| `set-deadline-charter-age` | Charter signed no longer ago than this at the planning meeting | deadline | months | before:planning-meeting |  |
| `set-deadline-document-age` | Brief, rating and impact annex reviewed no longer ago than this at the planning meeting | deadline | months | before:planning-meeting |  |
| `set-deadline-tailored-brief-age` | Brief signed no longer ago than this in a tailored release package | deadline | months | before:dec-4 |  |
| `set-deadline-transition-minister` | Minimum length of the transition to definition on the ministerial path | deadline | months | after:enter:phase-3 |  |
| `set-deadline-transition-central` | Minimum length of the transition to definition on the central authority path | deadline | months | after:enter:phase-3 |  |
| `set-deadline-costing-min` | Shortest costing period | deadline | weeks | after:costing-request |  |
| `set-deadline-costing-max` | Longest typical costing period | deadline | weeks | after:costing-request |  |
| `set-deadline-rating-review` | Central agency review of the rating | deadline | working-days | after:submit:dec-13 |  |
| `set-deadline-rating-review-assumed` | Central agency review after which agreement may be assumed | deadline | working-days | after:submit:dec-13 |  |
| `set-deadline-oversight-report` | Central oversight report after each approval | deadline | calendar-days | after:approval |  |
| `set-deadline-oversight-report-team` | Project team completes the oversight report draft | deadline | calendar-days | after:draft-received |  |
| `set-deadline-stalled` | No recorded progress before a project is flagged as stalled | deadline | months | after:last-progress |  |
| `set-deadline-fixed-budget-update` | Fixed budget status update | deadline | months | after:dec-10 |  |
| `set-deadline-indicator-compile` | Indicators compiled every | deadline | months | periodic |  |
| `set-deadline-red-indicator` | Unscheduled review after a red indicator | deadline | calendar-days | after:indicator-red |  |
| `set-deadline-high-risk-escalation` | Escalation of a high risk in definition or delivery | deadline | calendar-days | after:risk-high |  |
| `set-deadline-closeout` | Close-out after full capability | deadline | months | after:gate-7 |  |
| `set-deadline-post-review-min` | Earliest post-implementation review after close-out | deadline | months | after:dec-6 |  |
| `set-deadline-post-review-max` | Latest post-implementation review after close-out | deadline | months | after:dec-6 |  |
| `set-deadline-lessons` | Lessons recorded at the end of every phase | deadline | event | at:phase-end |  |

---

## 3. The staff method mapped to capital governance

| Staff method | Capital governance pack | Reuse |
|---|---|---|
| Doctrine and level | Your directive (the governance profile), category, path and size class | Pattern reused; data from the profile |
| Crosswalk steps | Lifecycle phases | Pattern reused |
| Commander's decision | Gates and the bodies' recorded decisions | Person-only rule reused; gate machine new |
| `DECISION FOR: commander` | `DECISION FOR: <body or role>` | Marker reused as is |
| Staff product with header | Governance document with header (profile fingerprint, path, phase) | Reused after WP-P0 |
| Release state machine (`release.ts`) | Same machine for every document | Reused as is |
| Signed records (the staff v1 `ledger.ts` and `personDecisions.ts` today; replica entries from Phases 31 to 33) | Replica stream kinds: gate decisions, baselines, profile changes and deadline events, plus the product and person-decision kinds the staff pack already uses | Replica layer reused; capital stream kinds and fold rules new (10.2) |
| Release-guard (`releaseGuard.ts`, `guardScan.ts`) | Same, with a governance variant | Reused; variant new |
| Tradecraft gate (`tradecraftLint.ts` plus reviewer) | Readiness check (`readiness-lint` plus `readiness-reviewer`) | Pattern reused; rules from the profile |
| `calc:` references and the `number-without-calculation` guard rule | Cost workbench records | Guard rule reused; workbench new |
| Registers (`registers.ts`) | Risk, assumptions, requirements trace, interdependencies, actions, changes, decisions, document tracker | Engine reused; schemas new |
| Battle rhythm | Governance calendar and deadlines | Pattern reused |
| Staff Room | The capital tab and Project tab of the one Portfolio Room (section 8) | Components reused |
| Team of teams (staff drop 3) | Programme office and portfolio office | Reused unchanged |
| Staff positions on the roster (Phase 33.1) | Role slots and body recorders as positions, filled by appointment | Reused; Capital projects mode words from `term()` |
| Exercise data rule and real-entity list (`realEntities.ts`) | Fictional project register and the real-entity list (real projects, suppliers, people) | Reused |

---

## 4. Phases and gates

### 4.1 Lifecycle

Seven phase slots in order (`phase-1` need identification, `phase-2` options analysis, `phase-3` transition to definition, `phase-4` definition, `phase-5` transition to delivery, `phase-6` delivery, `phase-7` close-out) and four exception states (`state-extended-closeout`, `state-withdrawn`, `state-cancelled`, `state-closed`). Each phase lists in `exitRequires` the gates and decisions that must be recorded before the project leaves it. The path may make phases optional (the small project path goes from `phase-1` to delivery on `doc-small-project-form`).

### 4.2 Project lifecycle machine

| From | To | Trigger | Who | Guard condition |
|---|---|---|---|---|
| (none) | `phase-1` | The capital step of Get Started | Person | a person appointed to the `role-sponsor` position; profile loaded or example acknowledged |
| `phase-n` | `phase-n+1` | Every slot in `phase-n`'s `exitRequires` is recorded as decided | Recorded by a person holding the position the chain names | Each gate is `approved` and each decision recorded, for this project and profile fingerprint |
| `phase-1` | `phase-6` | The path marks the phases in between optional and its approval is recorded | Recorded by a person | `path-1` only |
| `phase-7` | `state-extended-closeout` | Close-out cannot finish within `set-deadline-closeout` | Recorded by a person | `dec-7` recorded |
| `phase-7` or `state-extended-closeout` | `state-closed` | `dec-6` recorded | Recorded by a person | Completion report approved, lessons recorded, benefits handed over |
| any before `phase-4` | `state-withdrawn` | `dec-8` | Person | Withdrawal report |
| any from `phase-4` | `state-cancelled` | `dec-9` | Recorded by a person | Cancellation report |
| any active | stalled (a flag, not a state) | No recorded progress for `set-deadline-stalled` | Deadline engine | Raises a portfolio item; cleared by any progress record |

The machine is pure and folded from the project's replica entries, like the release machine. No agent verb moves it. A phase change needs the recorded gate and decision slots, so a project's phase can never disagree with its gates.

### 4.3 Gate machine (one per gate or decision occurrence)

| From | To | Trigger | Who |
|---|---|---|---|
| (none) | preparing | Phase entered; package listed from the gate's `package` and the path | Lifecycle machine |
| preparing | package-ready | Every package document is `guard-checked` with a current `READY` | Mechanical |
| package-ready | preparing | Any package document changes (hash) | Mechanical |
| package-ready | submitted | A person submits to the next actor in the `chain`, with the meeting date | Person |
| submitted | endorsed | An actor whose chain verb is `endorse`, `review` or `note` records it | Person, with record reference |
| endorsed | submitted | The package goes on to the next actor in the chain | Person |
| submitted | approved | The last actor records `approve` or `grant`; conditions listed | Person, with record reference |
| submitted | returned | The actor returns it with reasons | Person |
| submitted | deferred | The actor defers to a date | Person |
| deferred | submitted | A person resubmits | Person |
| returned | preparing | Owners revise | Mechanical |
| approved | conditions-open | The approval has conditions | Mechanical |
| conditions-open | approved | Each condition closed by a person | Person |

The decision command refuses a verb the body's or role's `verbs` list does not contain. A body allowed only to endorse cannot be recorded as approving, which is one of the most common mix-ups in any multi-body approval chain.

**Who may record (positions).** Every role slot (`role-*`) is a position on the roster (assigned positions design, Phase 33.1); the person posted to it records that role's verbs. Every body slot (`board-*`, `panel-*`, `authority-*`) has a recorder position, "records decisions for {body}", and the record carries the body's own record reference. The team file names the position, never a person (REVIEW conflict K18). Before a project is shared, the one local person holds every position, as staff projects do today. Delegated authority (`authority-delegated`, mode word "Delegation of authority") uses the one delegation rule the roster uses and Phase 71 wraps as credentials: a subset of what the delegator holds, with scope, expiry and depth (K21).

### 4.4 Deadlines (nothing waits forever)

Every waiting state has a deadline setting from the profile (section 2.5, settings of kind `deadline`), never a constant in code. Each setting names what it is counted from (`anchor`: before a body's meeting, after a gate, after entering a phase, after an approval, after the last progress record) and its unit (working days, calendar days, weeks, months, hours). Working days use a holiday calendar the profile may include.

| Waiting state | Deadline slots |
|---|---|
| Package before a meeting of `board-capability` | `set-deadline-capability-board-review`, `set-deadline-capability-board-package`, `set-deadline-capability-board-deck`, `set-deadline-capability-board-final-deck` |
| Package before a meeting of `board-programme` | `set-deadline-programme-board-package`, `set-deadline-programme-board-members`, `set-deadline-programme-board-concurrence` |
| Decision record after a meeting of `board-project-review` | `set-deadline-review-record`; meetings at least every `set-deadline-review-frequency` |
| After `gate-2` | `set-deadline-launch-meeting`, `set-deadline-first-review`, `set-deadline-independent-review-first` |
| In `phase-2` | `set-deadline-charter`, `set-deadline-options-duration` |
| Planning meeting in `phase-3` and `phase-5` | `set-deadline-planning-meeting`, `set-deadline-planning-review`, `set-deadline-charter-age`, `set-deadline-document-age`, `set-deadline-transition-minister`, `set-deadline-transition-central`, `set-deadline-costing-min`, `set-deadline-costing-max` |
| `dec-13` with `authority-central-staff` | `set-deadline-rating-review`, `set-deadline-rating-review-assumed` |
| `dec-4` | `set-deadline-tailored-brief-age` |
| After any approval | `set-deadline-oversight-report`, `set-deadline-oversight-report-team` |
| In delivery | `set-deadline-indicator-compile`, `set-deadline-red-indicator`, `set-deadline-high-risk-escalation`, `set-deadline-fixed-budget-update` |
| After `gate-7` and close-out | `set-deadline-closeout`, `set-deadline-post-review-min`, `set-deadline-post-review-max` |
| Any phase | `set-deadline-lessons`, `set-deadline-stalled` |
| conditions-open, deferred | The condition's date, the deferred date |

Every overdue item lands in the decision queue with options, owner and source, so an overdue deadline is visible, never silent.

### 4.5 Original and current baselines

At each approval that sets scope, cost or schedule, a baseline replica entry records the approved baseline (scope by requirement, milestones, cost by year and basis, contingency) as an entry signed by the person who records the approval. The first such entry is the **original baseline** and is never rewritten. The **current baseline** changes only through an approved change request. Indicators are computed against both, with the bands in the indicator settings (`set-band-scope-changes`, `set-band-milestone-slippage`, `set-band-capability-slippage`, `set-band-impact-analyses`, `set-band-spend-midyear`, `set-band-spend-yearend`, `set-band-authority-spent`): period values against the current baseline and to-date values against the original, never re-baselined. This removes the common practice of rebuilding the original baseline by hand at each report.

---

## 5. Team templates

### 5.1 Conventions

Same as the staff design 3.1: team file format, `privacy: private` (which means the gate's verified check: verified private hardware or this computer, REVIEW S4), 12-agent cap, `teamCheck` clean, instructions under 1,200 words with an owns list, a boundary sentence and a hand-back. The shared preamble every member reads first:

1. Read `.planning/capital/PROFILE.md` first (rendered from the loaded profile: phase, path, bodies and their verbs, document owners, required contents, estimate classes, deadlines, role titles). Use its names only: with a directive profile loaded these are your organization's own names, each with its "same as" reference; cite the reference, never quote the source.
2. Fictional project data only until your organization's accredited setup says otherwise. Never write confidential decision material, bid or supplier-confidential information, personal data, or text from your organization's internal directives. Stop and report if you see any.
3. You prepare and recommend; named people and bodies decide. Mark every decision as `DECISION FOR: <body or role>` with options and risk. Never write that a body or person approved, endorsed, granted or noted anything.
4. Your area is the files listed under "Owns". Propose changes to anyone else's document under `.planning/capital/proposals/<document>/`, never by editing it. Every figure cites a `calc:` record. If you are waiting, write `WAITING ON <member or body>: <what>` and carry on with what does not depend on it.

**The no-decide rule.** The products tool bound to the capital pack exposes `propose`, `verdict`, `submit`, `withdraw`, `status` and `list` (today's `AGENT_PRODUCT_VERBS`) and a `register` verb. It has no approve, endorse, grant or gate-record verb. Approvals, endorsements and gate decisions exist only as VS Code commands that a person runs (the generalized `nearAi.staff.approveProduct` family, plus `recordGateDecision`, `acceptProfileChange` and `closeCondition`), signed with the person's device key, with the name and role the person gives. Until verified identities land (Phase 71) the dialog says the identity is self-declared, using the existing wording. A header edited by hand to `approved` without a matching signed record reads as tampered.

> **Coherence review (2026-11-20):** the private models NEAR AI offers today come from developers in the People's Republic of China, which the model provenance decision rules out for operational work. Capital templates say so in the same sentence as staff templates (REVIEW S5) and run on fictional data only, which owner decision 2 already requires. Real capital work counts as "operational work"; until your organization approves a model for it, the project carries the signed exercise flag set at genesis (open question 12, C3).

Decisions are signed by the person's device key (credential from Phase 71), never by the key that signs the policy, because your organization signs the policy (REVIEW K34). The person must hold the position the chain names.

Tool groups as in the staff design 3.1, plus `CAPITAL` (the pack-bound products server), `mcp:cost-workbench`, `mcp:schedule-risk` and `mcp:readiness-lint`. Grants follow `src/agent/staff/grants.ts`: owners get owner verbs, the coordinating agent gets lead verbs, the reviewer and guard get gate verbs only.

### 5.2 Project office (12): one significant project, any phase

| # | Slug | Job | Model by job | Tools | Reports to |
|---|---|---|---|---|---|
| 1 | `project-office-lead` | Integrator: management plan, charter, governance packs, close-out documents; merges lanes; assembles gate packages | deep | READ, WRITE, DOCS, CAPITAL (lead verbs) | (the person posted to the project manager position) |
| 2 | `requirements-analyst` | Needs statement, high-level and detailed requirements, trace from need to acceptance, acceptance certificate drafts | deep | READ, WRITE, CAPITAL | project-office-lead |
| 3 | `options-analyst` | Business case, screening and rated criteria, recommended option, assumptions register | deep | READ, WRITE, WEB, CAPITAL | project-office-lead |
| 4 | `cost-analyst` | Cost records, cost breakdown, estimate classes and ranges, life-cycle costs, affordability notes | deep | READ, WRITE, `mcp:cost-workbench` | project-office-lead |
| 5 | `schedule-analyst` | Work breakdown, schedule import, range estimates, milestones on both baselines, slippage | standard | READ, WRITE, `mcp:schedule-risk` | project-office-lead |
| 6 | `risk-analyst` | Risk register and plan, aggregation, heat map, evidence for the complexity and risk rating | deep | READ, WRITE, `mcp:schedule-risk` | project-office-lead |
| 7 | `procurement-planner` | Procurement strategy, market engagement, overlay applicability, evaluation plan draft | standard | READ, WRITE, WEB | project-office-lead |
| 8 | `impact-analyst` | Effects on people, training, infrastructure, information systems and support, each with a cost proposal; interdependency register | deep | READ, WRITE | project-office-lead |
| 9 | `assessments-analyst` | Drafts of the policy assessments the profile requires, for qualified specialists; never clears anything | standard | READ, WRITE, WEB | project-office-lead |
| 10 | `benefits-analyst` | Benefits realization plan, indicators, performance reports | standard | READ, WRITE, `mcp:schedule-risk` (indicators) | project-office-lead |
| 11 | `readiness-reviewer` | Runs `readiness-lint`, then judges; `READY` or `NOT READY` with numbered fixes | deep | READ, `mcp:readiness-lint`, CAPITAL (gate verbs) | project-office-lead |
| 12 | `release-guard` | Release gate with the governance variant (7.2) | standard | READ, `mcp:guard-scan`, CAPITAL (gate verbs) | project-office-lead |

`project-office-lead` is the coordinating agent; its slug is kept as an id. The "Model by job" column names the Fast, Standard or Deep model, never a tier.

**Instruction outlines** (each ends with its boundary sentence and hand-back):

- **project-office-lead.** Read the path calculator's output; open the phase's lanes in one turn; integrate; keep the document tracker; assemble each gate package with the decisions sought as `DECISION FOR` lines. Owns: management plan versions, charter, governance packs and draft decision records, close-out documents, lessons merge. Boundary: "Your output is a complete package and a recommendation; the project leader and the bodies decide." Hands back: the package, open items, decisions sought.
- **requirements-analyst.** State the gap as a capability, not a product; write requirements as measurable effects with minimum and desired levels; keep the trace from gap to acceptance. Owns: needs statement, requirements registers, trace matrix, acceptance drafts. Boundary: "Your output is requirements, not options or solutions." Hands back: registers and drafts, with every significant requirement change marked `DECISION FOR: <body>`.
- **options-analyst.** Screen options pass or fail against requirements, keep the status quo option, rate viable options with an explained method, and write deciding factors when the top score is not recommended. Owns: business case, assumptions register. Boundary: "Your output is analysis and a recommended option; you never select it."
- **cost-analyst.** Build every figure in the workbench with basis, class, range and formula; never put a number in a document without its `calc:` id; check the estimate class against the next gate. Owns: cost records, cost breakdown, cost summary. Boundary: "Your output is cost evidence; the finance authority your organization names owns the final estimate."
- **schedule-analyst.** Build or import the schedule, run range estimates, keep milestones on the original and current baselines, compute slippage. Owns: schedule register, milestone views. Boundary: "Milestone changes are a decision for the approving body."
- **risk-analyst.** Register risks with every field the profile requires, score on its scales, aggregate exposure, mark every risk the profile says must be escalated as `DECISION FOR: <body>`, and assemble rating evidence. Owns: risk register, risk plan, rating evidence. Boundary: "Your output is assessment; the project leader accepts or escalates."
- **procurement-planner.** Procurement options, market engagement, overlay applicability with the threshold basis named, evaluation plan draft. Boundary: "Your output is a draft for the contracting authority, which decides."
- **impact-analyst.** Walk every impact area the profile lists; send each cost to the cost-analyst as a proposal; keep the interdependency register. Boundary: "Your output is impact analysis; the owners of each area approve their parts."
- **assessments-analyst.** Draft each required assessment and show where its findings land in other documents. Every product carries `SPECIALIST REVIEW REQUIRED`, which the guard checks. Boundary: "Your output is a draft for qualified specialists; it never clears anything."
- **benefits-analyst.** Benefits linked to outcomes with indicator, baseline, target and owner; dis-benefits; indicators against the profile's bands. Boundary: "Your output is measurement; the sponsor owns benefits."
- **readiness-reviewer.** Section 7.1. Boundary: "You check; you never rewrite another member's document." Ends with exactly `READY` or `NOT READY`.
- **release-guard.** Section 7.2. Ends with exactly `CLEARED` or `HOLD`.

**One owner per document.** Each document slot names exactly one `owner` member (and a `smallCellOwner`, shown as "small-project office owner", where the small project path uses it; the schema id keeps its name because ids never change in place); the owners are listed in the documents table in section 2.5. Each member's "Owns" list is generated from those slots, shown with the profile's names. Setup refuses a profile whose document has no owner, or an owner that is not in the chosen template, and names the document.

**Coordinating agent workflow per phase** (‖ means lanes started in one turn):

| Phase | Lanes | Merge | Gates and decisions |
|---|---|---|---|
| `phase-1` | requirements-analyst `doc-capability-gap`, `doc-high-level-requirements` ‖ options-analyst `doc-strategic-case`, `doc-priority-form` ‖ cost-analyst first records ‖ impact-analyst `doc-capability-impact` ‖ assessments-analyst `doc-equity-assessment`, `doc-environmental-assessment` ‖ risk-analyst draft `doc-complexity-rating` ‖ benefits-analyst `doc-benefits-plan` | project-office-lead: `doc-management-plan`, `doc-capability-board-package` | `gate-1`, `gate-2` |
| `phase-2` | options-analyst `doc-business-case`, `doc-scope-tiers` ‖ cost-analyst records per option ‖ procurement-planner `doc-procurement-plan`, `doc-sustainment-case` ‖ requirements-analyst `doc-requirements-preliminary` ‖ impact-analyst ‖ risk-analyst `doc-risk-plan` ‖ benefits-analyst `doc-performance-plan` | project-office-lead: `doc-charter`, `doc-project-brief` | `gate-3`, `gate-4` |
| `phase-3` | cost-analyst `doc-costing-data` ‖ risk-analyst final `doc-complexity-rating` ‖ assessments-analyst `doc-rights-assessment` ‖ every owner updates | project-office-lead: `doc-planning-readiness-package`, `doc-programme-board-package`, `doc-approval-submission` | `dec-1` (and `dec-10`, `dec-11`, `dec-13` when they apply) |
| `phase-4` | requirements-analyst `doc-requirements-statement` ‖ procurement-planner `doc-bid-evaluation-plan`, `doc-solicitation` ‖ schedule-analyst detailed `doc-schedule` ‖ cost-analyst records at `est-3` | project-office-lead: delivery `doc-management-plan` | `dec-16` |
| `phase-5` | as `phase-3`, with the tailored release where it applies | project-office-lead: `doc-tailored-package` or `doc-approval-submission` | `gate-5`, `dec-2`, `dec-3` |
| `phase-6` | benefits-analyst `doc-performance-report` ‖ risk-analyst reviews ‖ schedule-analyst actuals ‖ requirements-analyst `doc-requirements-trace` | project-office-lead: `doc-review-record`, `doc-change-request` | `gate-6`, `gate-7`, `dec-5` |
| `phase-7` | project-office-lead `doc-completion-report`, `doc-closeout-checklist` ‖ benefits-analyst hand-over ‖ every owner's `doc-lessons` | project-office-lead: `doc-closure-notice` | `dec-6` |

### 5.3 Small-project office (6)

> **Superseded 2026-11-20 (coherence review):** named "small-project cell" until this date. "Cell" is not a Capital projects mode word (the mode table's group word is "project office"), and designs use "key group" for the label-key meaning, so the template is the small-project office. Behaviour is unchanged.

For projects in the profile's smallest size class or on a streamlined path: `small-project-lead` (plan, combined business case, close-out), `cost-analyst`, `procurement-planner`, `schedule-risk-analyst` (milestones and risks in one register), `readiness-reviewer` (the profile's rule subset for the path), `release-guard`. The small-project office's products feed the portfolio office's roll-up of small projects, which many oversight reviews ask for and few organizations keep.

### 5.4 Programme office (team of teams, 12)

Only for the largest or most complex projects, selected by the profile's `teamOfTeamsWhen` rule, and for programmes of several projects. Members: `programme-integrator` (deep; decision queue, governance calendar), team references `requirements-options`, `cost-finance`, `procurement-industry`, `schedule-risk`, `impact-integration`, `assessments`, `submissions`, borrowed members (`uses: capital-project-office/readiness-reviewer`, `uses: capital-project-office/release-guard`), plus `programme-readiness-reviewer` and `programme-release-guard`. Each referenced team stays at 12 or fewer; depth 2 and every team-of-teams rule in the staff design 5.3 apply unchanged. For a programme, each component project is a project office referenced from the programme office.

### 5.5 Portfolio office (10)

`portfolio-lead` (integrator; regular portfolio brief), `portfolio-analyst` (investment plan view, pipeline), `gate-coordinator` (governance calendar and deadlines; proposes dates, never books them), `performance-reporter` (indicator roll-up, reports due), `risk-aggregator` (portfolio heat map, escalations, interdependencies), `finance-analyst` (spent, committed and forecast against the profile's bands), `small-projects-analyst` (roll-up of small projects), `lessons-analyst` (searches past lessons for each new project at its start), `readiness-reviewer`, `release-guard`. The portfolio office reads every project's replica entries and registers through read models (and, for units that publish upward, their publications, portfolio design 6) and writes only portfolio products.

### 5.6 Variants

The profile's path and category select the variant: a streamlined path uses 5.3; most paths use 5.2; the paths and sizes `teamOfTeamsWhen` selects use 5.4. A category may add lanes (for example a digital category adds an architecture lane) through the profile's `categories` block, never through code.

---

## 6. Products, one owner each

Products are Markdown files at `products/capital/<document>.md` with the generalized header:

```yaml
product: doc-business-case        # the slot id; the view shows the profile's name for it
kind: document
pack: capital
unit: project-office
owner: options-analyst
profile: example-general@3f9c1e0a     # profile id and short fingerprint it was written under
variant: standard-path
phase: phase-2
version: 4
state: awaiting-decision
label: org/Internal                 # shown as "Organization: Internal"
decision_for: board-capability      # the next deciding slot in the chain; the person is recorded on the decision
depends_on: [doc-high-level-requirements@3, doc-costing-data@5]
guard: { verdict: CLEARED, at: 2026-11-18T14:02Z, report: guard/business-case-v4.md }
readiness: { verdict: READY, at: 2026-11-18T13:40Z, report: readiness/business-case-v4.md }
```

Every label is shown as scale name plus level, and your organization's `org/Confidential` level is shown as "Sensitive" (id unchanged). Which model may read a product is decided by the gate's one decision function, `decideRoute`, from the product's label and the use; the product row and every answer carry the trust line (Runs on, Verified, Allowed).

Registers (risk, assumptions, requirements trace, interdependencies, actions, change log, decision records, document tracker) are JSON beside their Markdown view and written through the `register` verb, so the checks read them mechanically. Shared registers have a single writer each; others propose, as in the staff design 4.3.

---

## 7. Checks

All three checks take the loaded profile as input. None holds a threshold, document name, deadline or band of its own.

### 7.1 Readiness check

Two parts, both blocking, in order, then the guard.

1. **`readiness-lint`** (deterministic), run on the exact version, against the path calculator's document list, the profile and the project's replica entries. It runs one check per check slot in the loaded profile: 54 `lint` and 7 `lint-and-review` slots, one per mechanical rule of the directive your organization's profile mirrors, in seven families (section 2.5 lists them all). Each check reads its numbers, document slots and settings from the profile through its `params`, so changing a limit or a required item is a profile change, never a code change. The families:

| Family | Example rules |
|---|---|
| Completeness | Every required-contents item of the profile for this document is present (`heading`, `register`, `field`, `link`); every document in the gate package exists and has an owner |
| Consistency | The same quantity in two documents resolves to one calculator record or to records that agree; requirement ids, option ids, risk ids and milestone ids match across documents; the recommended option is the same everywhere; the path, phase and profile fingerprint in every header match the project |
| Cost class against phase | Each estimate's class is allowed at the next gate; its range matches the class's accuracy band; totals used for a threshold are on the basis the profile names |
| Baseline integrity | The original baseline entry exists once and is unchanged; the current baseline differs from the last approved one only through approved change requests; indicators use the baseline the profile says |
| Risk | Every risk has the fields the profile requires; every risk at an escalation rating has an escalation record or an open item within its deadline |
| Benefits | Every benefit has indicator, baseline, target, owner and date |
| Deadlines | No package submitted after its readiness deadline without a recorded person's waiver |
| Wording | No decision written as made; terms from the profile's vocabulary; specialist marks present |

Each finding has the check slot, its name and "same as" reference from the loaded profile, the file and line, and a fix hint. The products tool refuses a `READY` verdict while a lint finding stands, exactly as the staff tool refuses a `SIGN-OFF` while the tradecraft lint has findings.

2. **`readiness-reviewer`** (judgement): the 5 `review` check slots, the judgement half of the 7 `lint-and-review` slots, the `review` required-contents items in the profile, plus general qualities of a strong case (alignment, clarity, consistency, traceability, defensibility) and a "likely questions" pass: the five questions the next body is most likely to ask, with where the package answers them. Output `READY` or `NOT READY` with numbered fixes, recorded as a verdict on the exact version.

### 7.2 Release guard (governance variant)

Runs `guard-scan` first, then reviews. The existing rules apply (`marking`, `label-ceiling`, `real-entity`, `restricted-title`, `decision-as-made`, `personal-data`, `secret`, `number-without-calculation`, `review-mark-missing`). The governance variant adds:

- markings for confidential decision material and supplier-confidential or bid information, from the active scales in your organization's rules (the gate's one label service, never a shipped copy of the scales), each shown as scale name plus level;
- the profile's `restrictedSources`: any title or phrase fingerprint from your organization's internal texts is a `HOLD`, so a member cannot paste directive text into a product;
- a low-accuracy estimate class in a document marked for an external audience;
- a specialist product without `SPECIALIST REVIEW REQUIRED`;
- compilation: several releasable cost and schedule items that together reveal a bid or negotiating position are a `HOLD` with the question for a person.

Verdict `CLEARED` or `HOLD` with numbered reasons, never a fix.

### 7.3 Every figure traced to a calculator record

`cost-workbench` record fields: id, description, work breakdown element, quantity, unit cost with source and date, formula shown, basis (as the profile defines bases), year, taxes, contingency with the risk analysis it came from, estimate class, range low and high, confidence, inputs it depends on, version. Escalation indices are entered by a person and versioned; no index tables ship.

Rules:
- every figure in a product cites `calc:<id>` (the existing `CALC_REFERENCE` pattern and guard rule);
- a record change marks every dependent product "source changed" (the staff dependency propagation);
- one quantity in two documents must resolve to one record or two records that agree;
- the class must fit the next gate, and the range must fit the class's band;
- threshold totals are computed per basis, and the path calculator reads them by id, never by a typed number.

---

## 8. Portfolio workspace

> **Coherence review (2026-11-20):** the Portfolio Room is one screen, the one in the assigned positions and portfolio design (6.5). The views below become its capital tab and the Project Room becomes a tab of it, built in Phase 43. See `.planning/research/coherence/REVIEW.md`, conflict K26.

The capital views are the **capital tab** of the one **Portfolio Room** (portfolio design 6.5), and the one-project view is its **Project tab**. They use Staff Room components (rail, teams, decision record, decision queue), draw read models folded from replica entries and publications only, and never write. Labels show scale name plus level, and counts use trust-line words ("18 of 18 agents verified").

> **Superseded 2026-11-20 (coherence review):** this section first described its own webview: "One webview, the **Portfolio Room**, built from Staff Room components (rail, squads, ledger, decision queue), plus a **Project Room** for one project. Both draw read models only and never write." It is merged into the portfolio design's room (REVIEW conflict K26, owner question Q11). The views below are unchanged.

| View | Content | Answers |
|---|---|---|
| Portfolio board | One row per project: phase rail with gate markers (gold only for decisions a person recorded), path, size class, rating, category, next body and date, readiness and guard state | Where is everything |
| Gates and calendar | Each body's meetings with every project's package deadlines counted back from them, and packages at risk | What must be ready when |
| Risk | Aggregated heat map; risks at escalation ratings with age and escalation state; interdependencies as a graph | Which risks are waiting too long |
| Schedule | Milestones against original and current baselines; slippage bands; stalled projects | How far each project has moved from what was approved |
| Spend | Spent, committed and forecast against the profile's bands, by year and basis | Whether money is used as planned |
| Baseline versus current | For each project, the original baseline, every approved change, and the current baseline side by side | The full change history in one place |
| Early warnings | Indicators trending toward amber or red, deadlines due soon, estimate classes too low for the next gate, rating changes that would change the path, high risks near their escalation deadline | What will go wrong next |
| Decision queue | Every `DECISION FOR` with options, risk and dissent; every overdue deadline | Where people's time goes |

Read models: `capital.project`, `capital.gateBoard`, `capital.documentRegistry`, `capital.decisionQueue`, `capital.riskRollup`, `capital.baseline`, `capital.spend`, `capital.deadlines`, `capital.warnings`. Events: `capital.phase.entered`, `capital.gate.state`, `capital.decision.recorded` (body, verb, record reference, person), `capital.baseline.approved`, `capital.profile.changed`, `capital.deadline.overdue`, `capital.indicator.band`, `capital.risk.escalated`, plus the method events (`method.product.state`, `method.gate.verdict`, `method.lane.*`, `method.merge.*`, `method.team.nested`, `method.waiting`), which keep their `staff.*` names as aliases.

---

## 9. Data platform feeds (v0.6.0)

| Source | Data | Before v0.6.0 | With v0.6.0 |
|---|---|---|---|
| Financial system of record | Commitments, actuals and forecast by work breakdown element; project status | CSV or spreadsheet export import | Manifest connector to the export location (Phase 100), or the office-suite and file-share connectors (Phases 89 to 91) |
| Procurement system | Requisitions, solicitations, contracts, amendments, values, milestones | Export import | Database or API connector (Phase 100) |
| Schedule tools | Schedule files in a standard exchange format | Import into `schedule-risk` | File-share or office-suite connector with a change feed |
| Risk system | Risk registers and ratings | Export import; a person confirms the rating | Connector (Phase 100) |
| Supplier performance (earned value) | Cost and schedule performance from contractors' reports | File import | Connector to the drop folder |
| Document library | Approved documents and their versions | Manual attach | Office-suite connector (Phase 89 or 90) |
| Lessons learned | Lessons by project type | Export import | Export connector |
| Public open data | Published tenders and contract awards, for demos and market research | Download import under its open licence | Catalog source (Phase 100) |

Rules: the data platform's gate applies unchanged (labels only rise automatically, reader-relative views, nothing unlabelled sent to a cloud model). Nothing reads real project data before the Stage 1 gate and an accredited host. Each mapping from a feed to the read models is a pure function tested with fictional fixtures, so the same mapping serves the file import now and the connector later. Field mappings for your organization's systems live in the directive profile or a mapping file beside it, never in the repository. A connector's source labels and feed defaults come from the `labels` section of your organization's rules, and setting up a feed is an admin step of Get Started that ends on the policy editor.

---

## 10. Reuse versus new, build packages and placement

### 10.1 Reuse versus new

| Component | Today | For capital teams |
|---|---|---|
| Release state machine (`release.ts`) | Staff, section typed as a J section | Reused after WP-P0 makes the unit a pack-validated string |
| Ledger and person decisions (`ledger.ts`, `personDecisions.ts`) | Drop 1 (staff v1, single chain) | Not generalized. Capital uses replica stream kinds and fold rules: gate decision, baseline, profile change, deadline event (10.2) |
| Product header and parse (`products.ts`, `parse.ts`) | `section`, `profile`, `level` | Generalized to `pack`, `unit`, `profile`, `variant`, `phase`, with staff keys read as aliases |
| Ownership and proposals (`ownership.ts`) | `SHARED_PRODUCTS` list in code | Reused; the list moves into the pack |
| Events and read models (`events.ts`, `readModels.ts`) | `staff.*` | Generic `method.*` with `staff.*` aliases; `capital.*` added |
| Registers (`registers.ts`) | `REGISTER_SCHEMAS` in code | Engine reused; schemas supplied by the pack |
| `guard-scan` and release-guard (`guardScan.ts`, `releaseGuard.ts`) | Staff rules and section variants | Reused; governance variant; `restrictedSources` from the profile |
| Tradecraft lint pattern (`tradecraftLint.ts`) | Fixed rules | Pattern reused for `readiness-lint`, rules generated from the profile |
| Write limits (`writeLimits.ts`) | `.planning/staff` | Reused per pack folder |
| Team block (`teamBlock.ts`) | Staff keys | Generalized keys with a pack id |
| Products tool and grants (`grants.ts`) | `staff-products` | A pack-bound products server; no approve verb, ever |
| Setup and commands (`staffSetup.ts`, `staffCommands.ts`) | Set Up Staff Team; staff decision commands | The capital step of Get Started (originally planned as "Set Up a Capital Project Team", superseded 2026-11-20); generalized decision commands plus gate, profile and condition commands, shown only in capital projects (`when` context) |
| Team of teams | Staff drop 3 | Reused unchanged |
| Staff Room components | UX concept | Reused for the capital and Project tabs of the one Portfolio Room |
| Roster positions and the delegation rule | Phase 33.1 | Reused: role slots and body recorders as positions |
| Profile schema, loader and example profile | none | New |
| Path calculator, lifecycle and gate machines, deadline engine | none | New |
| `readiness-lint`, cost workbench, schedule and risk tool | none | New |
| Feed mappings | none | New |

### 10.2 WP-P0: generalize the staff method core

> **Coherence review (2026-11-20):** WP-P0 is re-based on the replica layer: a pack is a set of stream kinds and fold rules over replica entries, not a generalization of the single-chain `ledger.ts` and `personDecisions.ts`, which the multi-user work replaces. See `.planning/research/coherence/REVIEW.md`, conflict K26.

One line on why it runs alone: every later package imports the pack interface and the generalized header, so nothing else can start before it lands.

Scope (re-based, 2026-11-20):
- A `MethodPack` in `src/domain/method/` declares its **replica stream kinds** (product, verdict, person decision, gate decision, baseline, profile change, deadline event) and the **fold rules** that turn those entries into state (release machine, lifecycle machine, gate machine, registers, read models). Signing, ordering, sync and offline work come from the replica layer (Phases 31 to 35), not from the pack.
- Who may write each kind is a position check against the roster, with Capital projects mode words from `term()`.
- `src/domain/staff/` becomes the first pack on the same terms, keeping every current export. Staff v1 ledgers are read through the replica's import, as the multi-user design plans; `ledger.ts` and `personDecisions.ts` are not generalized.
- The product header gains `pack`, `unit`, `variant` and `phase`; old headers parse unchanged. A capital pack skeleton loads the example profile.
- Depends on Phase 33.1 (positions) and Phase 41 (policy v2, `directives.capital` section shape, `term()`).

Tests (re-based): every existing staff test passes unchanged; a pack conformance suite both packs run; folds are pure and give the same state from the same entries in any arrival order the replica allows; a write by a person who does not hold the position is refused; header round trip with old and new keys; event aliases emitted once.

> **Superseded 2026-11-20 (coherence review):** the scope and tests below were the original plan, which generalized the single-chain ledger. They are kept for the record; the scope and tests above replace them (REVIEW conflict K26).

Original scope:
- A `MethodPack` interface in `src/domain/method/`: units (sections or offices), settings schema and resolver, steps or phases, product kinds and renderers, shared products and owner rules, register schemas, markers, member preamble, guard variants, lint rule provider, vocabulary renderer.
- The release machine, ledger, person decisions, ownership, registers engine, events, read models, write limits and team block move to the core and take a pack.
- `src/domain/staff/` becomes the first pack, with every current export kept (re-exports and aliases), so no caller changes.
- The product header gains `pack`, `unit`, `variant` and `phase`; old headers parse unchanged.
- A capital pack skeleton that loads the example profile.

Tests: every existing staff test passes unchanged; a pack conformance suite that both packs run; header round trip with old and new keys; old ledger files replay to the same state; event aliases emitted once, not twice.

### 10.3 Parallel build packages (after WP-P0, each in its own worktree)

| WP | Scope | Worktree | Depends on | Tests |
|---|---|---|---|---|
| WP-P1 Profile | Slot catalogue, `profile.schema.json` and the integrity checks (2.3), loader (bundle, ignored project file, example), profile state machine, display rule (`label` or `name` with `sameAs`), `PROFILE.md` renderer, `example-profile.json`, the `directives.capital` section parser (shape from Phase 41) and its policy-editor proposal | `feat/capital-profile` | WP-P0 | Schema and integrity accept the example and reject each malformed block and each broken reference; a profile with a missing or extra slot is refused; an example with a `name` is refused, a directive profile without one is refused; load order; refuses a non-ignored path; every profile-state transition; fingerprint stable across key order; a bundle using `directives.capital` without naming it in `requires` is refused, and an older client says "update"; an organization-layer directive cannot be changed by a member; a personal-layer directive shows "self-signed on this computer"; every view shows `name` and `sameAs` when a directive-style test profile is loaded |
| WP-P2 Path calculator | Pure function, explanations, change diff | `feat/capital-path` | WP-P0, WP-P1 schema | Table-driven cases at every bound of the example profile, on each basis; `onBound` behaviours; uncovered inputs flagged; a changed rating or cost shows the right diff; no clock or I/O |
| WP-P3 Lifecycle, gates, deadlines, baselines | Machines in 4.2 and 4.3, deadline engine in 4.4, baselines in 4.5 | `feat/capital-gates` | WP-P0 | One test per allowed and forbidden transition; no agent reaches a person-only transition; a person not holding the chain's position is refused; delegation narrower than the delegator only; a verb not allowed for a body refused; every waiting state has a deadline; working-day counting with a holiday calendar; stalled flag set and cleared; original baseline never rewritten; same state folded after reload |
| WP-P4 Readiness lint | Rule engine generating rules from the profile | `feat/capital-readiness` | WP-P0, WP-P1 schema | A passing and a failing fixture per rule family; rules change when the profile changes, with no code change; `READY` refused while a finding stands |
| WP-P5 Cost workbench | Records, bases, classes and bands, dependency propagation | `feat/cost-workbench` | WP-P0, WP-P1 schema | Formula shown on every result; class against gate; band check; basis-specific totals; no index tables shipped |
| WP-P6 Schedule and risk tool | Schedule import, range estimates, slippage, heat map, aggregation, indicators | `feat/schedule-risk` | WP-P0 | Import fixtures; indicator bands at their edges; period against current baseline and to-date against original |
| WP-P7 Templates and setup | Project office, small-project office, programme office, portfolio office; owner table from the profile; the capital step registered with Get Started (no new setup command); decision commands | `feat/capital-templates` | WP-P0; staff team of teams for the programme office | `parseTeam` and `checkTeam` clean; 12 cap; one owner per document for the example profile, and a refusal for a profile with none or two; boundary sentences; scripted runs in which no agent writes "approved" or reaches a decision command |
| WP-P8 Rooms | The capital tab and Project tab of the one Portfolio Room, from read models (Phase 43) | `feat/capital-rooms` | WP-P0; the Portfolio Room (Phase 39) | Read-model snapshots; reduced motion; keyboard flow; early warnings computed from fixtures |
| WP-P9 Demo | Fictional demo projects and acceptance fixtures | `feat/capital-demo` | WP-P0, WP-P1 | Fixtures pass with each template on the example profile |
| WP-P10 Feed mappings | Pure mappings and file importers per feed | `feat/capital-feeds` | WP-P0 | Fixture per feed; labels applied; no network call |
| WP-P11 Guard variant | Governance markings, `restrictedSources`, compilation prompt | `feat/capital-guard` | WP-P0, WP-P1 schema | Fixture per rule; a phrase from a test `restrictedSources` list is held; specialist mark checked |
| Integration | Merge P1, P2, P3, P5, P6, P11, P4, P7, P8, P9, P10 in that order; one full verification run; UAT script | `feat/capital-integration` | All | Full suite once; end-to-end from `phase-1` through `gate-5` on the demo project, with a person recording each gate |

Waves: wave 0 is WP-P0; wave 1 is WP-P1 to WP-P11 in parallel (packages that need the profile schema take it from WP-P1's first commit, which lands the schema before the loader); integration last.

### 10.4 Tests across the feature

- **State machines:** every allowed and forbidden transition of the profile, lifecycle and gate machines, folded again from the replica entries after reload.
- **Person-only rule:** no tool, MCP server, shell edit or header edit reaches approve, endorse, grant, gate record, profile acceptance or condition closing; a hand-edited header reads as tampered.
- **Profile-driven:** the same test suite runs against the example profile and a second, deliberately different test profile (other values, other chains, other names), and passes with no code change. This is what proves nothing is hard-coded.
- **One-to-one:** a test compares the slot catalogue in code with every profile it loads (same slot set, same labels), so no slot can be added or dropped on one side only. Your organization runs the same check, locally, on its directive profile; its result is reported, never the profile.
- **Source rule:** a repository check fails CI if a file under `resources/capital/` or `src/` contains a term from a denylist kept outside the repository supplied at test time (empty in public CI, filled locally by your organization).
- **Data handling:** fictional fixtures only; feed mappings make no network call; guard holds every marking scale shipped.

### 10.5 Roadmap placement

> **Coherence review (2026-11-20):** placed as Phase 42 (capital drop 1, after Phase 33.1, on the replica layer and positions) and Phase 43 (capital drop 2, after Phase 39, as the Portfolio Room's capital tab). The v0.6.0 feed step below is unchanged. See `.planning/research/coherence/REVIEW.md`, section 9.

**Phase 42 and Phase 43, before v0.6.0** (milestone 7, "Capital projects and the portfolio").

1. **Phase 42, capital drop 1** (after Phase 33.1, and so after Phase 41): WP-P0 to WP-P6, WP-P9, WP-P11, and the project office and small-project office, for the `equipment` category.
2. **Phase 43, capital drop 2** (after Phase 39): programme office and portfolio office, the capital and Project tabs of the Portfolio Room, file-import feeds.

> **Superseded 2026-11-20 (coherence review):** the placement was "0.4.x feature drops after staff drop 3, before v0.6.0", with drop 1 and drop 2 unnumbered. The contents of each drop are unchanged.
3. **With v0.6.0 (Phase 100, and Phases 89 to 91 for office-suite and file-share sources):** the feed mappings become connectors. Nothing reads real project data before the Stage 1 gate and an accredited host.

Why: the feature needs the staff contract, the replica layer and positions, the guard and team of teams, all of which ship in 0.4.x; it needs nothing from Phases 71 to 74 to run on fictional data; a second pack makes the method core a tested abstraction before the data platform adds more; and live financial and procurement feeds are what v0.6.0's connectors, labels and reader-relative views exist for, so connecting them earlier would duplicate that work.

### 10.6 Safety and data handling

- Private models only by default, which means the gate's verified check (verified private hardware or this computer), with the PRC-origin sentence while that is all NEAR AI offers; fictional data until your organization's accredited setup says otherwise; template ceiling at the lowest protected level, shown as scale name plus level, even where the device allows more (labels are not accreditation). Every request goes through `decideRoute`, so residency, authorizations and model approvals apply here as everywhere.
- Confidential decision material and supplier-confidential information are held by the guard, and the templates never ask for them.
- Approvals are signed with the person's device key by the person holding the position, self-declared until Phase 71, and the UI says so. Exceptions (for example Protected B in a hosted service) are one `authorizations[]` record, never a capital-specific form.
- Specialist drafts assist qualified people and say so on every product.
- Your organization's internal directives never enter the repository: their names, values and section references reach the teams only through the directive profile, outside the repository; requirements are met in the teams' own words; the guard holds any product that quotes a passage.

---

## 11. Owner decisions applied (2026-11-18)

| # | Decision | Where applied |
|---|---|---|
| 1 | Your organization's specifics live in a private profile loaded from the policy bundle or a git-ignored project file; the repository ships only a neutral example | 2.1, 2.3, 7.2, 10.4, 10.6 |
| 2 | Fictional data only until verified identities and an accredited host exist | 5.1, 9, 10.5, 10.6 |
| 3 | Generalize the staff code into a method core with packs rather than build a separate capital contract | 1, 10.2 |
| 4 | A general profile usable by any government department: the slot catalogue, the example profile and every rule are department-neutral | 2.1, 2.5, 4.1 |
| 5 | Team of teams only for the largest or most complex projects, selected by the profile's `teamOfTeamsWhen` rule | 5.4, 5.6 |
| 6 | Start with equipment projects (`cat-equipment` is the only category on at first release); other categories follow as profile data | 2.5, 10.5 |
| 7 | A fictional demo project: a medium equipment project (a fictional fleet replacement) taken from `phase-1` through `gate-5` on `path-2`, and a small fictional tooling project on `path-1`, both with made-up figures on the example profile | 10.3 (WP-P9) |
| 8 | Mirror your organization's directive one-to-one: one slot per body, gate (same order), path, document (at the phase it is required), role, mechanical rule, deadline and threshold, each with a neutral id and label in the repository; the private profile maps every slot to the directive's own name and section, and loading it is only a configuration step | 1, 2.1, 2.5, 7.1, 10.3, 10.4 |

> **Superseded 2026-11-20 (coherence review):** decisions 1 and 8 say "private profile"; it is now the **directive profile**, kept out of the repository and shown on screens as "Your directive", because "private" is reserved for verified private hardware (glossary). Decision 1's "policy bundle" is now the `directives.capital` section of your organization's rules. Decision 3 stands, re-based on the replica layer (10.2). The decisions themselves are unchanged.

## 12. Open questions from the coherence rewrite (2026-11-20)

The coherence review did not settle these. Each has a recommended default, used in this design until the owner decides.

| # | Question | Recommended default |
|---|---|---|
| C1 | Who records a board's, panel's or authority's decision, since a body is not a person? | One recorder position per body slot ("records decisions for {body}"), filled by appointment; the entry carries the body's own record reference. The roles that decide in person (`role-*`) are positions themselves |
| C2 | May a git-ignored project directive file be used when your organization's rules exist but carry no `directives.capital`? | Yes, unless the organization layer locks `directives.capital`; it is shown as "self-signed on this computer" |
| C3 | Which use is capital work for model approval: "chat you review" or "operational work"? | Real capital project work is operational work, like staff work. Fictional projects use the signed exercise flag set at genesis, which also fits owner decision 2 |
| C4 | Rename the schema field `smallCellOwner` to drop "cell"? | No; ids never change in place. Screens say "small-project office owner"; a later schema version may add an alias |
| C5 | The mode table's Capital word for `position` is "Role", which is also the slot prefix `role-*`. Keep it? | Keep "Role" on screens; in prose this design says "position" for the roster slot and "role slot" for the pack's `role-*` ids |
