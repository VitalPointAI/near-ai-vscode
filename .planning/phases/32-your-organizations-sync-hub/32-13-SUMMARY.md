---
phase: 32-your-organizations-sync-hub
plan: 13
subsystem: staff replica (label leak test; Part B documentation)
status: complete
tags: [replica, cells, labels, clearance, leak, canary, docs, D-15, D-16, D-23, D-24, D-56, MUS-05]
requires: [32-07, 32-09, 32-10]
provides:
  - "src/test/staffReplicaLabelLeak.test.ts: the two-compartment leak test on real installs, with canaries and positive controls, and the SECURITY.md check"
  - "SECURITY.md: ### Labelled products in shared projects; the cell keys introduction says the base cell carries only the roster; the refusal bullet replaced"
  - "CHANGELOG.md: Unreleased, Military staff teams bullets for Part B"
affects: [32-11, 32-12, Phase 33]
tech-stack:
  added: []
  patterns:
    - "canary byte search: UTF-8 plus base64 and base64url at each of the three byte offsets, over file names and bytes, recursing folders"
    - "every negative search paired with a positive control that finds the same canaries where they belong"
key-files:
  created:
    - src/test/staffReplicaLabelLeak.test.ts
  modified:
    - SECURITY.md
    - CHANGELOG.md
decisions:
  - "The scene is built once per test file (memoized) and the relay once on top of it; node:test runs a file's tests in order, and each test asserts only what holds both before and after the relay"
  - "The grant path for a member is syncTo of the base cell and its own cell plus every grant on the lead's disk that wraps the member's device (stronger than syncTo alone)"
  - "The search also covers standard base64, beyond the plan's base64url, since some stored values use it"
  - "The withdraw is written by the lead as a person with section_lead:j4 (owner side), so its reason reaches the lead's fold and the positive control can find it"
  - "## Unreleased already existed in CHANGELOG.md; only ### Military staff teams was added under it, after ### Fixes"
  - "Defaults of 32-CONTEXT.md taken as accepted; the plan has no checkpoint. The tracer gate passed on the automated verify."
metrics:
  duration: "about 40 minutes"
  completed: 2026-11-20
estimate:
  tokens: 60031
  tasks: 3
actuals:
  tokens: 9188
  tasks: 3
  commits: 3
plan_head_before: 7a065afbaae6b715a04c741da67836e1b85feed3
plan_head_after: 613fd223e61d584b75841841b226488c094af085
---

# Phase 32 Plan 13: Label leak test and Part B documentation Summary

A byte search for canaries shows that a member below a label cell never receives that cell's key or plaintext. This holds through the grant path and when a mistaken relay hands them every entry, blob and grant. The base cell holds only base kinds and no product text. SECURITY.md and CHANGELOG.md now say where labelled products live and who receives them.

## What was built

**src/test/staffReplicaLabelLeak.test.ts** (11 tests)

The scene is built with labelCellWorld and the labelCells API only:
- The lead is declared {org, Restricted, [KESTREL, OSPREY]}.
- X is declared {org, Confidential, [KESTREL]} and admitted before the cells exist.
- Cell A {org, Confidential, [KESTREL]} and cell B {org, Confidential, [OSPREY]} are made with `ensureLabelCell`.
- Y is declared {org, Confidential, [OSPREY]} and admitted after the cells.
- Each cell gets one product, made with `appendProductEntry` (product.create, doc.client, doc.update) and `proposeVersion`. The version header carries `org/Confidential//<TOKEN>`. Each product then gets a `version.withdraw` with a reason.
- Canaries per cell: the product name, its title, a phrase of its text, the label token, and the withdraw reason.

The tests:
1. "Y never receives cell A ..." and "X never receives cell B ...": no grant of the cell below is in the member's welcome file. No grant of it on the lead's disk wraps the member. After the grant path the member holds its own cell's key and no key for any epoch of the cell below. Its roster view answers `cellGrantees` undefined for that cell, and its disk holds no grant of it.
2. "mistaken relay" (two tests, Y and X): every entry of every stream, every blob and every grant on the lead's disk is handed to the member. The member still holds no key of the cell below. Every entry of that cell waits `awaiting-key`. The entries are not in the fold order or the applied list, and not in the held, refused, kept, rejected or quarantined lists. The fold has no digest for that cell.
3. "mistaken relay" (two tests): no canary of the cell below is in any of these places:
   - the member's fold families;
   - every staff host text (replay, snapshot, list, and status and productState of each listed product) from a `StaffHost` with replica options over the member's folder;
   - every file name and byte under the member's project folder (the store included) and global storage;
   - the member's secret names and values.
4. "single-machine copy": `makeSingleMachineCopy` by Y and by X. No canary of the cell below is in any file name or byte of the copy folder, or in the copy result.
5. "positive control": the same searches find every canary of the member's own cell in its fold families. They find the product name in its host texts, and the name and text in its copy. In the lead's fold they find every canary of both A and B.
6. "base cell": every base stream entry is opened with the base key on the lead. Each is the genesis or a kind `baseCellAllows` accepts. No name, title, text or reason canary of A or B is in any base body or blob the base entries name. Label tokens are not searched here, because declared clearances are roster data (D-13). A control runs the same search over A and B opened with their own keys and finds their canaries.
7. The SECURITY.md test. The heading appears once, inside the multi-user section and after the cell keys subsection. It names `org/Internal`, write up, never down, only the staff lead, the deputy, the hub, the repository, and the not-copied sentence. It quotes `PREVIEW_WAY_FORWARD_TEXT` and `NOT_CLEARED_TEXT('that label')` word for word. The cell keys subsection says "carries only the roster". The old refusal bullet is gone, and the clearances subsection points to the new one. The file has no em-dash.

**SECURITY.md**
- The opening of "Cell keys, wraps and rekey" now says three things:
  - the base cell carries only the roster;
  - every member holds it, and so will your organization's sync hub;
  - every product is in the cell for its label, `org/Public` included.
- Every phrase the existing tests read is kept.
- In "People and clearances are declared by the staff lead", the bullet "Labelled products are not made multi-user yet" is replaced by "Labelled products get a part of their own", which points to the new subsection.
- New "### Labelled products in shared projects", after the cell keys subsection. Its bullets cover:
  - a part per label, and the base part carrying only the roster;
  - the `org/Internal` default and a label kept for life;
  - write up, never down, for pins;
  - the D-19 sentence;
  - the legacy part;
  - 0.4.35 projects and the hub, with the D-22 sentence;
  - a member below a part, and the not-copied sentence;
  - product files and repositories.

**CHANGELOG.md**: "### Military staff teams" under "## Unreleased", with four new bullets in the style of the 0.4.35 ones.

## Verification

Every run used the memory cap wrapper and the shared focused lock.

- Task 1 verify: 2 tests, 2 pass.
- Task 2 verify (staffReplicaLabelLeak, replicaCellLeak): 13 tests, 13 pass.
- Task 3 verify (staffReplicaLabelLeak, replicaCellLeak, staffReplicaMembership, staffReplicaStore, gateDocs, changelogSections, then `npm run lint`): **134 tests, 134 pass, 0 fail, lint exit 0**.
- Acceptance greps:
  - `^### Labelled products in shared projects$` in SECURITY.md: 1.
  - `^## Unreleased$` in CHANGELOG.md: 1. It was already 1 at HEAD; the plan expected 0.
  - Em-dashes: SECURITY.md 0, CHANGELOG.md 3. All three are in released sections, and the new section has none.
- Test names include "never receives", "mistaken relay", "single-machine copy", "base cell" and "positive control".

### Failing first and teeth (D-66)

The leak tests check behaviour that already exists. They passed on the wave 4 code the first time, so no leak defect was found. Their teeth were shown by planting and by mutation. Compiled JS was changed, run, then restored and compared byte for byte.

| Change | Result |
| --- | --- |
| Scratch plant: the text canary, base64url at byte offset 2, written to `.planning/staff/replica/plant.txt` in the member's store before the search | 2 fail, the two "no canary" tests, each naming `<TOKEN> text in .planning/staff/replica/plant.txt` |
| The same plant, with the search cut to UTF-8 only | 9 pass. The plant goes unnoticed, so the base64 forms are needed |
| `clearedFor` returns true for every cell (membership.js) | 2 of 2 fail, in the scene's own check "nobody but the lead is cleared for OSPREY when B is made" |
| `buildWelcome` puts every grant in the welcome file (invite.js) | 9 of 9 fail. The joining computer refuses the welcome ("welcome-refused"), a second guard |

- The SECURITY.md test failed first on the unchanged documents (1 fail), then passed after the edits.
- The plant was removed (restored compiled test file). Each run makes fresh temporary installs.

## For 32-11 (single-machine copy)

The copy part of the leak test runs against the copy as it stands after wave 4. Y's copy carries B's product and text and no A canary, and X's copy carries A's and no B canary. So the copy built from the member's own fold already holds every cell that member holds. The test asserts no sentence that 32-11 adds. When 32-11 adds the line "Parts of this project you are not cleared for were not copied." to the copy result, this test checks it against the canaries of the cells the copy did not hold. If that line, or any listing of what was not copied, names a product, title, label token or reason of a cell the computer does not hold, the "single-machine copy" test fails. SECURITY.md quotes that sentence word for word, so 32-11 should use exactly that text.

## Deviations from Plan

1. **[Plan wording] CHANGELOG "## Unreleased" was already there** (with "### Fixes"). Only "### Military staff teams" was added under it. The acceptance grep is 1, as expected after the change.
2. **[Strengthening] The search also covers standard base64**, and the grant path also hands each member every grant on the lead's disk that wraps its device. Nothing was weakened.
3. **Branch name:** the plan names `feat/phase-32-13-label-leak`. The orchestrator made `feat/phase-32-13-label-leak-docs`, and that branch was used.

Files touched: only the three in the plan's files_modified, plus this summary.

## Known limits

- The staff host texts do not include product file text: on a member, the host reads products from the fold. Any product files the shared project writes in the member's folder are covered by the project folder search.
- The searches cover what exists after wave 4. Hub delivery (later plans) is not exercised here.

## Known Stubs

None.

## Threat Flags

None beyond the register:
- **T-32-220:** the canary byte search over every output and folder, with positive controls (Tasks 1 and 2).
- **T-32-221:** SECURITY.md says plainly not to commit product files to a repository that people who are not cleared can read (Task 3).
- **T-32-SC:** no package was installed.

## Self-Check: PASSED

- FOUND: src/test/staffReplicaLabelLeak.test.ts, SECURITY.md, CHANGELOG.md
- FOUND: 0a8c7464, 01e115d6, 613fd223 (ancestors of HEAD)
