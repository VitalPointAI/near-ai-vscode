---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 21
subsystem: code-push-check
tags: [gap-closure, G-27-6c, code-push, privacy, allowlist]
status: complete

requires:
  - phase: 27-project-state-follows-the-project-across-interfaces-and-machines
    provides: "27-17 codePushCheck.ts (planCodePush, pushProjectCode, history scan)"
provides:
  - "src/services/codePushCheck.ts: NEAR_AI_PROJECT_FOLDER, SHARED_PROJECT_FILES allowlist, CodePushPlan.heldBack and trackedPrivate, summary notes, public-repository block"
affects: [27-22, 27-23, release-notes]

requirements-completed: [SYNC-09]

actuals:
  tokens: 4605
  tasks: 2
  commits: 3
plan_head_before: 30a0549c0fe27fd0816db27b1652cc53f4404ffa
plan_head_after: a3ff61a53b4915a037b856a8cf52a3cca946f553

tech-stack:
  added: []
  patterns:
    - "Fail-closed allowlist for a mixed folder: the shared files are named, every other path under the folder (including later additions and nested files) is held back by exact-prefix and exact-name matching"
    - "A test reads the extension's own source for the names it writes and checks both directions (no stale allowlist entry, every other name held back), so the allowlist cannot drift"

key-files:
  created: []
  modified:
    - src/services/codePushCheck.ts
    - src/test/codePushCheck.test.ts

key-decisions:
  - "Allowlist is team.md, project.json, verifiers.json; everything else in .planning/.near-ai/ is held back (fail closed)"
  - "agent-team.json is held back although it records the accepted project team: the shared form of the team is team.md, and agent-team.json also carries acceptance timestamps, history and the reusable-team binding. When in doubt, held back"
  - "Held-back untracked files are left off the list and never written to .gitignore; the ignore click stays only for blocked secrets"
  - "A held-back record git already tracks stays on the list (git add does not remove it, and the history carries it anyway): named in the summary as going up, or on a public repository the push is blocked with advice to run git rm --cached first"
  - "The history scan is unchanged"

patterns-established:
  - "Plan paths are project-root relative (heldBack, trackedPrivate); notes strip the NEAR AI folder prefix and list at most 10 names, then 'and N more'"

coverage:
  - id: D1
    description: "Untracked auth-profiles.json and activity.json are left off the push list and named in the summary as staying on this computer; team.md and project.json go up; the held-back files stay untracked and .gitignore is not created or changed"
    requirement: SYNC-09
    verification:
      - kind: unit
        ref: "src/test/codePushCheck.test.ts#NEAR AI per-person records stay on this computer: left off the list, named in the summary, never staged, .gitignore untouched"
        status: pass
    human_judgment: false
  - id: D2
    description: "The allowlist is in step with the files the extension writes (no stale entry; every other name written there is held back), and an unknown file or a nested file (including a nested team.md) is held back"
    requirement: SYNC-09
    verification:
      - kind: unit
        ref: "src/test/codePushCheck.test.ts#the allowlist is in step with the source: no stale entry, and every other file the extension writes there is held back"
        status: pass
      - kind: unit
        ref: "src/test/codePushCheck.test.ts#a file NEAR AI does not know yet, and a nested one, are held back (the allowlist fails closed)"
        status: pass
    human_judgment: false
  - id: D3
    description: "docs/team.md, .planning/team.md, .planning/auth-profiles.json and .planning/.near-ai-old/x.json are ordinary code (exact folder prefix, exact names)"
    requirement: SYNC-09
    verification:
      - kind: unit
        ref: "src/test/codePushCheck.test.ts#a file named like a shared one elsewhere, or beside a look-alike folder, is ordinary code"
        status: pass
    human_judgment: false
  - id: D4
    description: "A tracked NEAR AI record on a public repository blocks the push with one sentence naming the file and git rm --cached; nothing is committed or pushed. On private or unknown it is named as already saved in git and going up; declining pushes nothing, accepting pushes"
    requirement: SYNC-09
    verification:
      - kind: unit
        ref: "src/test/codePushCheck.test.ts#a NEAR AI record git already tracks: a public repository is blocked with advice to remove it from git, nothing is committed or pushed"
        status: pass
      - kind: unit
        ref: "src/test/codePushCheck.test.ts#a NEAR AI record git already tracks on a private or unknown repository is named in the summary as going up; declining pushes nothing, accepting pushes"
        status: pass
    human_judgment: false
  - id: D5
    description: "Every earlier guarantee is unchanged: the 19 existing codePushCheck tests (secret names and content, history scan, ignore click, identity, no force option) pass unmodified, and the 28 onlineHome tests pass"
    requirement: SYNC-09
    verification:
      - kind: unit
        ref: "src/test/codePushCheck.test.ts#the source has no force option anywhere"
        status: pass
      - kind: unit
        ref: "src/test/onlineHome.test.ts"
        status: pass
    human_judgment: false
---

# Phase 27 Plan 21: NEAR AI per-person records stay off the code push Summary

**The code push now leaves NEAR AI's per-person and per-run records in `.planning/.near-ai/` on this computer by default, pushing only a three-file allowlist of shared project configuration, and names what stays behind in the summary.**

## What was built

- `SHARED_PROJECT_FILES = ['team.md', 'project.json', 'verifiers.json']` and `NEAR_AI_PROJECT_FOLDER = '.planning/.near-ai/'` in `src/services/codePushCheck.ts`. Matching is by exact folder prefix and exact relative name, so `.planning/.near-ai-old/`, `docs/team.md`, `.planning/team.md` and `.planning/.near-ai/sub/team.md` behave as the plan describes.
- `planCodePush` returns `heldBack` (untracked NEAR AI records, removed from `files`) and `trackedPrivate` (held-back records git already tracks, which stay on the list).
- `pushProjectCode` adds a summary note: "These NEAR AI files hold your own account and run records and stay on this computer: auth-profiles.json, activity.json." (at most 10 names, then "and N more"). A tracked record gets its own note saying it is already saved in git and goes up with the code. On a public repository a tracked record blocks the push with one sentence naming the file and the advice to run `git rm --cached` first. Nothing is written to `.gitignore` for held-back files.

## Finding confirmed (owner asked to check before deciding)

In an extension-managed project `.planning/.near-ai/` is not ignored by the extension. `src/services/scratch.ts` adds only `.near-ai/attachments/`, `.near-ai/scratch/` and `.near-ai/state/` (the `.near-ai/` at the project root, a different folder from `.planning/.near-ai/`). This repository's own `.gitignore` ignores the whole `.planning/.near-ai/` folder, and `SECURITY.md` says "Add it to `.gitignore` if you do not want it committed". So these files are untracked and not ignored in a typical project, and `git ls-files --others --exclude-standard` lists them. That is how `auth-profiles.json` reached the real push.

## Per-file decision table

Every file the extension writes under `.planning/.near-ai/`, by reading its writer.

| File | Writer | What it holds | Decision |
|------|--------|---------------|----------|
| `team.md` | `src/agent/projectTypes.ts` (via `Teams.projectTeamFile`, `setupSteps.ts`, `teamUpdates.ts`) | The project's team description that AGENTS.md guidance points at; edited by the person | Shared (allowlisted) |
| `project.json` | `src/agent/projectTypes.ts` `applyProjectType` (also `gsd/researchProfile.ts`) | Project type, goal, red-team flag, template version, guidance fingerprint, GSD profile | Shared (allowlisted) |
| `verifiers.json` | `src/gsd/verifierScaffold.ts` `VERIFIER_MANIFEST` | SHA-256 of each scaffolded verifier script; the scripts under `scripts/verify/` go up with the code, so the manifest that vouches for them should too | Shared (allowlisted) |
| `auth-profiles.json` | `src/services/profileStore.ts` | Organization name, endpoint, profile ids (no key); the file that was pushed in the real run | Held back |
| `activity.json` | `src/services/activityStore.ts` | Per-person activity and cost records | Held back |
| `audit.json` | `src/services/auditStore.ts` | Approval and spend audit events (up to 500) | Held back |
| `resume.json` | `src/services/resumableExecution.ts` | Resume snapshots: sessions, agents, pending approvals, budgets | Held back |
| `generation.json` | `src/services/generationService.ts` | Generation ledger for generated media | Held back |
| `generated/` | `src/services/generationService.ts` | Generated media files (binary) | Held back |
| `multimodal.json` | `src/services/multimodalOrchestrator.ts` | Multimodal run ledger | Held back |
| `multimodal/` | `src/services/multimodalIntake.ts` | Managed copies of intake artifacts | Held back |
| `reputation.json` | `src/services/reputation.ts` | Per-profile reputation scores and evidence | Held back |
| `context-graphs.json` | `src/services/contextGraphStore.ts` | Memory graphs with audit metadata | Held back |
| `agent-profiles.json` | `src/services/agentProfiles.ts` | Agent profile registry, lifecycle and operational facts | Held back |
| `agent-orchestrator.json` | `src/services/agentOrchestrator.ts` | Routing and lifecycle events of runs | Held back |
| `agent-team.json` | `src/services/projectInitialization.ts` | Accepted team, acceptance history and timestamps, reusable-team binding | Held back (judgment call; see key decisions). Moving it to shared later is one list entry |
| any other name, nested path | none yet | Unknown | Held back by default |

## Residual risks (stated, not changed)

- The history scan is unchanged: a record that was committed earlier and deleted later is not treated as a secret, because these files hold no keys. A person who committed `auth-profiles.json` and then removed it still publishes it with the branch history. The tracked-record handling only covers files in the current index.
- A held-back record that is tracked and committed on a private repository goes up with the code after the person sees the note and clicks; only a public repository is blocked.

## Deviations from Plan

None - plan executed as written. Three of the five Task 2 behaviour tests (allowlist in step, unknown and nested held back, look-alike paths) already passed after Task 1 because the Task 1 implementation is itself the fail-closed allowlist; the two tracked-record tests were the genuine RED, committed before the implementation.

## Verification

- `tsc -p tsconfig.json` and `node --test dist/test/codePushCheck.test.js` under the memory cap: 25 tests, 25 pass (19 existing unmodified, 1 tracer, 5 new).
- `node --test dist/test/onlineHome.test.js`: 28 pass.
- `npm run lint`: exit 0.
- Acceptance greps: `SHARED_PROJECT_FILES`, `heldBack` and `trackedPrivate` each appear well above the required counts.

## Commits

- `75b034a` feat(27-21): keep NEAR AI per-person records off the code push (tracer)
- `966a0d1` test(27-21): add failing tests for tracked NEAR AI records and the allowlist class (RED)
- `a3ff61a` feat(27-21): fail closed for NEAR AI records and handle tracked ones (GREEN)

## Known Stubs

None.

## Threat Flags

None. T-27-98 is mitigated as planned; no new network, auth or file-access surface was added.

## Self-Check: PASSED

- src/services/codePushCheck.ts and src/test/codePushCheck.test.ts exist and contain the changes.
- Commits 75b034a, 966a0d1 and a3ff61a are ancestors of HEAD.
