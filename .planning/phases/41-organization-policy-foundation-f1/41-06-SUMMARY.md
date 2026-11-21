---
phase: 41-organization-policy-foundation-f1
plan: 06
subsystem: organization modes (domain/org)
status: complete
tags: [modes, term, people-section, policy-bundle-v2, fnd-07]
requires: [41-01 (parsePeopleSection stub, parseSetList, people@1, parsePolicyDocument)]
provides:
  - modes.ts (MODE_IDS, ModeId, CONCEPT_KEYS, ConceptKey, DEFAULT_MODE, SOURCE_STATUSES, ModeWord, WordSource, ModeBehaviour, ModeRow, MODES, ORGANIZATION_SETTING_KEYS, MAX_DELEGATION_DEPTH, DEFAULT_MAX_DELEGATION_DEPTH, DEFAULT_OVERDUE_DAYS, MIN_OVERDUE_DAYS, MAX_OVERDUE_DAYS, OrganizationSettings, EffectiveBehaviour, effectiveBehaviour)
  - terms.ts (term, modeName, HOW_YOUR_ORGANIZATION_WORKS, PlanningProfile, planningProfileFor)
  - peopleSection.ts (parsePeopleSection with organization filled; OrganizationBlock, ParsedOrganizationSettings, OrganizationSettings re-exported)
affects: [41-02 (NARROWING keys), 41-11 (copy lint reads term words), 33.1 (joining flows, delegation depth)]
tech-stack:
  added: []
  patterns: [one frozen data table for words and behaviour, term() as the only reader, settings that only tighten checked against every allowed mode]
key-files:
  created:
    - src/domain/org/modes.ts
    - src/domain/org/terms.ts
    - src/test/orgModes.test.ts
  modified:
    - src/domain/org/peopleSection.ts
decisions:
  - "Every military and public service word is best-guess except the Military handover words, confirmed-by-owner from portfolio D11; no public source was read this session, so none is marked confirmed and no source is cited as confirming a word."
  - "settings.temporary false gives behaviour temporary 'no' (a third value added to ModeBehaviour.temporary); settings.guests false gives 'if-policy-allows'."
  - "effectiveBehaviour returns EffectiveBehaviour (ModeBehaviour plus enrolAtReport, false by default per portfolio D3)."
  - "OrganizationSettings (all optional) lives in modes.ts and is re-exported by peopleSection.ts; the parsed form is ParsedOrganizationSettings with both numbers filled."
  - "Corporate dualHatting is false (5.3: temporary as guest only), while its dual word stays 'Member of two work teams' without offered false, as the plan lists it."
  - "allowedModes holds at most four entries (one per mode); planningProfileFor ignores a choice outside STAFF_PROFILE_IDS and gives nato-ca."
metrics:
  duration: ~23 min
  completed: 2026-11-20
actuals:
  tokens: 12300
  tasks: 3
  commits: 3
plan_head_before: ce786119bcb5b7bd1016ed5ae49029d277c58bda
plan_head_after: 3550a524
---

# Phase 41 Plan 06: Mode table, term() and the people section Summary

One frozen mode table holds the words and the joining behaviour of Military, Public service, Corporate and software and Capital projects for seventeen concepts; `term()` is the only reader; `people.organization` parses strictly, and its settings can only tighten, so declining can never be turned on where people are posted or appointed.

## What was built

- **modes.ts**: `MODE_IDS` (military, public-service, corporate, capital), the seventeen `CONCEPT_KEYS`, `DEFAULT_MODE` corporate (portfolio D12), `MODES` with each row's `name`, `words` (word, `also`, `offered`, `source`) and `behaviour` (portfolio 5.3), all frozen. Corporate words follow the owner's 2026-11-20 rule: Work team, Work team admin, Work team lead, Member of two work teams; no word in any mode is the bare word team (Capital's Project team member is the glossary's word). `ORGANIZATION_SETTING_KEYS` (sorted), depth 0 by default and at most 2, overdue days 1 to 30 (default 2), and `effectiveBehaviour(mode, settings)`, which only turns a permission off or the enrolAtReport duty on.
- **terms.ts**: `term(concept, mode = DEFAULT_MODE)` (TypeError for an unknown key or mode, never user input), `modeName`, `HOW_YOUR_ORGANIZATION_WORKS`, `planningProfileFor(mode, choice?)` with the staff doctrine profiles as one profile under term(). terms.ts spells no mode word; doctrine.ts is unchanged.
- **peopleSection.ts**: export name and signature unchanged (`parsePeopleSection(value, scales, path = 'people')`); only `organization?: never` became `organization?: OrganizationBlock`; clearances and signers parse as 41-01 left them. The block: strict keys, `mode` in MODE_IDS and in `allowedModes`, `allowedModes` non-empty, sorted and unique through `parseSetList`, `projectMayChoose` boolean, `settings` strict with tightening checked against every allowed mode (acting, dualHatting, mayDecline true refused `not-allowed-here` unless every allowed mode offers it). The parsed block always carries settings with both numbers filled, booleans only when written; its JSON copy parses deep-equal.

## Source notes (for the owner to confirm)

| Mode | Concept | Word | Status |
|---|---|---|---|
| military | position | Billet (also Position) | best-guess |
| military | group | Section (also Staff, Unit) | best-guess |
| military | join | Posting | best-guess |
| military | joined | Posted | best-guess |
| military | report | Report for duty | best-guess |
| military | unable | Report unable | best-guess |
| military | tasker | Tasking authority | best-guess |
| military | delegate | Delegate tasking authority | best-guess |
| military | acting | Acting (also Acting while so employed) | best-guess |
| military | temporary | Temporary duty (also Attached posting) | best-guess |
| military | dual | Dual-hatted | best-guess |
| military | handover | Handover (also Relief in place, Transfer of authority) | confirmed-by-owner (portfolio D11) |
| military | relieved | Relieved | best-guess |
| military | lead | Staff lead | best-guess |
| military | member | Staff officer | best-guess |
| military | people | Roster | best-guess |
| military | decision | Commander's decision | best-guess |
| public-service | position | Position | best-guess |
| public-service | group | Directorate (also Branch, Unit) | best-guess |
| public-service | join | Assignment | best-guess |
| public-service | joined | Assigned | best-guess |
| public-service | report | Report to the position | best-guess |
| public-service | unable | Report unable | best-guess |
| public-service | tasker | Delegated manager | best-guess |
| public-service | delegate | Delegate authority | best-guess |
| public-service | acting | Acting appointment | best-guess |
| public-service | temporary | Temporary assignment | best-guess |
| public-service | dual | Concurrent responsibilities | best-guess |
| public-service | handover | Handover | best-guess |
| public-service | relieved | Assignment ended | best-guess |
| public-service | lead | Responsible manager | best-guess |
| public-service | member | Employee | best-guess |
| public-service | people | People | best-guess |
| public-service | decision | Approved by the delegated authority | best-guess |

Each best-guess note says what would confirm it, by public title only (Queen's Regulations and Orders for the Canadian Forces and the CAF personnel administration orders; the NATO glossary AAP-06 or a public allied joint staff publication; the Public Service Employment Act and Treasury Board staffing and people management policies; a federal department's public organization charts and delegation instruments). Three are product wording and also ask the owner to confirm the phrase: Report unable (both modes), Staff lead, Report to the position. No note quotes any publication.

## Tests

- orgModes.test.ts: 17 tests (3 tracer, 6 for the table, 8 for settings and behaviour).
- Each task's tests failed first: Task 1 on the base (ce786119) did not compile (no `../domain/org/terms`; `organization` typed `never`); Task 2 on the Task 1 code did not compile (no SOURCE_STATUSES, planningProfileFor or behaviour); Task 3 on the Task 2 code did not compile (no MAX_DELEGATION_DEPTH, ORGANIZATION_SETTING_KEYS, effectiveBehaviour or OrganizationSettings). One Task 1 run then failed at runtime on the round trip (see deviation 1).
- Per-task verifies: Task 1 orgModes plus gateBundleV2 28/28; Task 2 orgModes plus staffDoctrine 25/25; Task 3 orgModes, gateBundleV2, gateBundle 101/101 and lint exit 0.
- Final gate set (capped, locked): `gate*.test.js`, orgModes, staffDoctrine, teamSignedPayload, teamBoundaries, replicaBoundaries, `staffObs*.test.js`: 1064 tests, 1064 pass, 0 fail. `npm run lint` exits 0. Secret scan over the plan's commits: clean.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 1 - Bug] Task 1 settings accepted the two numbers, not an empty object only**
- Found during: Task 1. The plan requires the parsed block to always carry `maxDelegationDepth` 0 and `overdueDays` 2, and its JSON copy to parse deep-equal; an empty-object-only settings parser refused its own output as unknown-field. Task 1 therefore parsed the two numbers (with their ranges); Task 3 added the booleans and tightening.
- Files: src/domain/org/peopleSection.ts. Commit: 1b00f22b.

**2. [Rule 2 - Correctness] `temporary` gained a third value and effectiveBehaviour returns enrolAtReport**
- The plan's settings include `temporary` and `enrolAtReport`, but ModeBehaviour had no value for "temporary turned off" and no enrolAtReport field. `ModeBehaviour.temporary` now allows 'no' (only effectiveBehaviour produces it) and `EffectiveBehaviour extends ModeBehaviour` adds `enrolAtReport`. The return type is still a ModeBehaviour. Commit: 3550a524.

### Other choices
- Military `position` and `acting` carry the design's parenthetical words in `also` (Position; Acting while so employed).
- The handover source note says "a whole unit or watch" (the design says team) to keep the bare word out of repository strings.

## Notes for the wave 2 merge and later plans

- 41-02 `NARROWING` needs: `people.organization.mode` subset (within allowedModes), `people.organization.allowedModes` organization-only, `people.organization.projectMayChoose` boolean-safe (false safe), settings `mayDecline`, `acting`, `temporary`, `dualHatting`, `guests` boolean-safe (false safe), `enrolAtReport` boolean-safe (true safe), `overdueDays` and `maxDelegationDepth` number-lower. This plan declares none.
- 41-01's `fullDocumentFor` fixture (src/test/helpers/policyFixtures.ts, not in this plan's files) has no `people.organization`. If 41-02 enumerates accepted keys from that fixture, the merge should add an organization block there, for example `{ mode: 'corporate', allowedModes: ['corporate', 'military'], projectMayChoose: true, settings: { maxDelegationDepth: 1, overdueDays: 3, enrolAtReport: true, guests: false, temporary: false, acting: false, dualHatting: false, mayDecline: false } }` (every setting key, all valid).
- Domain imports: src/domain/org imports only src/domain/gate (shape, bundle, labels, authorizations) and src/domain/staff/doctrine.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-41-60: refused at parse and ignored by effectiveBehaviour, both tested (including an own `mayDecline: true` beside a `__proto__` key). T-41-61: checkKeys and ownValue, no spread of parsed input, frozen output, unknown-field tests including `__proto__`, `constructor` and `toString`. T-41-62: words and behaviour in one row, with a test that a mode offers the Decline word exactly when it allows declining. T-41-SC: no package installed.

## Self-Check: PASSED

- Files: src/domain/org/modes.ts, src/domain/org/terms.ts, src/domain/org/peopleSection.ts, src/test/orgModes.test.ts present.
- Commits: 1b00f22b, 026f36c7, 3550a524 are ancestors of HEAD on feat/phase-41-06-modes-and-terms.
