# Phase 28 pattern map

**Mapped against:** `5bfeba0af` · 2026-11-26

The current software Project Setup, team and GitHub hosting paths provide integration seams. Proposed filenames below are ownership suggestions for the planner.

## File classification

| Proposed surface | Role and data flow | Tracked analog | Match |
| --- | --- | --- | --- |
| `src/services/setupSteps.ts` and extension activation | Setup catalogue and host registration | `src/services/setupSteps.ts`, `src/services/setupMenu.ts`, `src/extension.ts` | Exact |
| Workflow setup command and confirmation | Controller · project-scoped request and response | `src/services/teamUpdateCommands.ts`, `src/services/teamUpdates.ts` | Role and flow |
| Kit preview and application | Service · deterministic transform and file I/O | `src/services/teamUpdates.ts`, `src/team/teamFile.ts` | Role and flow |
| Default branch and setup evidence reader | Service · read-only queries against fixed repo identity | `src/services/onlineHome.ts`, `src/services/githubApi.ts` | Partial, mutating routes excluded |
| Exported workflow kit | Config and user-run utilities · source, checks and review evidence | `.github/workflows/ci.yml`, `.github/workflows/agent-review.yml`, `.github/workflows/release.yml`, `scripts/lib/workflow.mjs` | Policy analog, repository-specific implementation |
| Host and workflow checks | Tests · injected GitHub, local files and menu | `src/test/setupSteps.test.ts`, `src/test/teamUpdate.test.ts`, `src/test/onlineHome.test.ts`, `scripts/test/workflow.test.mjs`, `scripts/test/workflow-files.test.mjs` | Exact or role and flow |

## Setup catalogue and project team

`src/services/setupSteps.ts:16–43` defines `SetupContext` and the step's command, availability and completion probes. Register the new step with `registerSetupStep(step, after)` and any project fact with `registerSetupFacts(name, provider)` using activation disposables, as `src/services/setupMenu.ts:69–74` does for web-search readiness. Menu rows are rebuilt on every open (`setupSteps.ts:159–180`), so completed entries remain actionable. A missing, invalid, unsupported or unreadable project fact should evaluate explicitly to `false` in Phase 28 availability; the general menu uses `true` as fallback for an exception from `isAvailable`.

`src/services/setupMenu.ts:24–44` captures the selected folder and rechecks it across asynchronous menu work and before dispatch. Apply the same invariant inside the phase command at its own confirmation and application boundaries. `src/extension.ts:232` registers Project Setup. The existing Theia Workbench shortcut in `workbench/extension/src/browser/sterling-work-areas-module.ts:36–45` calls `nearAi.projectSetup`. `src/services/chat.ts:727` also delegates to that command. Keep one extension host service behind both entry points. The checked-out source contains no separate native Phase 28 setup or alternate command owner.

`src/agent/projectTypes.ts:127–147` supplies the software template and its named `devops` member. That member already owns reviewable workflow changes and leaves remote settings and credentials to a person. `applyProjectType` at lines 314–323 records `type: type.id` and preserves other keys in `.planning/.near-ai/project.json`. Use that explicit project type, the actual configured team (`src/agent/teams.ts:418` onward) and the existing consent boundary (`src/agent/teams.ts:290–330`), with an actionable no-team or no-DevOps state. Other team starting points or customized teams may omit the role. Do not infer authorization from a template label or use the broad team tool list as authority to write workflow files; the setup action should approve exact project-local effects through a host-controlled preview. `src/test/projectTypes.test.ts:102–114` asserts the DevOps remit.

## Preview, write, retry

| Existing pattern | What to copy |
| --- | --- |
| `src/services/teamUpdateCommands.ts:25–44` | Compare exact current and proposed text as in-memory documents using `vscode.diff`, then return to the person's explicit choice. Cancellation leaves files unchanged. |
| `src/services/teamUpdates.ts:127–163` | Plan from current state again after confirmation, refuse a change that makes the preview stale, and prepare all intended text before writes. Keep partial failures visible. Use this design with a workflow-specific service. |
| `src/team/teamFile.ts:162–198` | Serialize mutations and write through an exclusively created temporary file. Its replacement semantics are for an already authorized existing file. Phase 28 missing files need exclusive final placement so a newly appeared user file is preserved. |
| `src/services/onlineHome.ts:391–413` | Resolve the exact Git root, distinguish a nested project from its parent repository, and read configured remote values without applying rewrite rules. Pin the selected root and repository through the confirmation. |

Build rows for missing, byte-identical, and conflicting files before presenting a diff. An existing user file stays in place pending a fresh, explicit decision for its exact replacement. If input changes after preview, replan. Use fixed project-relative output names, reject linked or out-of-root destinations, and cover a race that places an existing file before apply. A retry can reuse the same classification and only offer absent work. Keep setup completion distinct from local files present so unverified remote prerequisites remain visible.

## Default branch and kit boundary

`src/services/githubApi.ts:24–42,71–83,103–111` is a pattern for parsing a bounded repository response and validating `default_branch`. Unknown evidence is not a default branch of `main`, and a local checkout branch is not the remote default. `src/services/onlineHome.ts:294–332` mixes human-controlled publish with an existing feature-specific default-branch mutation. Reuse its validation and identity patterns only. Phase 28 assessment must have a read-only adapter and separate user-run instructions, with no token request, storage, remote mutation, or completion inferred from displayed instructions. Use injected read fixtures like `src/test/helpers/onlineHomeFakes.ts:22–56`.

The CI, review and release workflow files and `docs/development-workflow.md` are the kit's policy examples. `scripts/lib/workflow.mjs:5–27,233–291,595–632` shows expected check/reviewer identity, exact-head review and distinct gate-path logic. `scripts/merge-pr.mjs` delegates to `scripts/lib/merge.mjs`; `scripts/prepare-release.mjs` uses SemVer, a remote tag check, and repository-specific package/lockfile/changelog assertions; `scripts/bootstrap-agent-review.mjs` is an operator tool, not a setup command. Extract the portable invariants, adapt to verified project facts and omit Sterling-specific CI jobs, organization identities, package assumptions and release targets. Reuse contract test shapes for checks bound to the correct app/workflow and commit, a new head invalidating review, owner approval on gate changes, and publication waiting for approval. There is no tracked general-purpose exporter or verified remote-settings completion reader at this revision.
