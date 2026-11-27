---
phase: 102-institutional-joint-staff-teams
plan: studio-setup
type: execute
wave: 10
depends_on: ["102-REVIEW"]
files_modified:
  - media/teams/teams.js
  - media/teams/teams.css
  - src/services/teamStudioPage.ts
  - src/services/teamStudioPanel.ts
  - src/services/teamStudioStaffSetup.ts
  - src/services/staffSetup.ts
  - src/services/staffSetupCommand.ts
  - src/agent/teams.ts
  - workbench/test/e2e/get-started.spec.ts
  - src/test/teamStudioPage.test.ts
  - src/test/staffSetup.test.ts
autonomous: true
requirements: []
user_setup: []
must_haves:
  truths:
    - Staff setup opens in Team Studio and names the actual selected project.
    - A person can continue with one supported section or review coverage for a complete staff.
    - Complete-staff preview, cancellation and stale workspace requests write nothing.
    - The existing single-section roster confirmation and replacement checks remain required.
  artifacts:
    - path: media/teams/teams.js
      provides: Staff scope and section selection with keyboard focus
    - path: src/services/teamStudioPanel.ts
      provides: Host-owned project binding and supported template projection
    - path: src/test/teamStudioPage.test.ts
      provides: End-to-end webview messages and setup scope regression
  key_links:
    - from: media/teams/teams.js
      to: src/services/staffSetupCommand.ts
      via: Exact Team Studio host messages and a host-owned project selection
---

# Team Studio section setup and complete-staff preview

<objective>
Let a user see the destination project and the staff sections it can set up before leaving the Studio. Continue with the selected existing section or inspect the coverage needed for a complete staff, with a clear return path.
</objective>

<execution_context>
@/home/aaron/aspire-home/.codex/gsd-core/workflows/execute-plan.md
</execution_context>

<context>
@.planning/phases/102-institutional-joint-staff-teams/102-STAFF-SETUP-UI-SPEC.md
@.planning/phases/32.1-guided-setup-with-viable-options-and-a-plain-recommendation/32.1-09-PLAN.md
@src/agent/staff/templates.ts
@src/services/staffSetupCommand.ts
@src/services/teamStudioPage.ts
@src/services/teamStudioPanel.ts

Start from the current Team Studio spec and reconcile the ordinary setup entry with the protected staff remediation. Normal templates are J2, J3, J4 and J5. The protected institutional fixtures supply no shipped choices. Existing Team Studio messages and setup commands parse exact fields, and the setup roster and replacements already require a person's confirmation. Keep that contract. Use approved UI choices and ordinary administrative workflow wording for this slice.
</context>

<tasks>

<task type="tracer" tdd="true">
  <name>Open the project-bound staff chooser from Team Studio</name>
  <files>media/teams/teams.js, media/teams/teams.css, src/services/teamStudioPage.ts, src/services/teamStudioPanel.ts, src/services/teamStudioStaffSetup.ts, src/services/staffSetup.ts, src/services/staffSetupCommand.ts, src/agent/teams.ts, src/test/teamStudioPage.test.ts, src/test/staffSetup.test.ts, workbench/test/e2e/get-started.spec.ts</files>
  <read_first>Trace the existing exact host message, root subscription, Staff Setup command, registry and Team Studio browser harness.</read_first>
  <action>
    Extend the existing webview and host tests first. Opening the chooser selects or identifies the project via the host, shows each available section, and provides a read-only complete-staff coverage view. Cancel restores focus to the Studio action. An unsupported section or a stale project reply triggers no setup. Verify a valid section reaches the existing roster review for the exact previewed project. A changed root while questions are open must hold writes. Preserve the Staff Room and Chat callers.

    Separate open, project selection, and continuation. Use exact message keys and reject any caller-supplied workspace path. Assign an opaque host-owned ID to each chooser opening. Tie that ID, the workspace revision and the selected root to every async picker result, preview and continuation. Resolve the host-selected directory and capture its physical identity using its resolved path and filesystem device and inode. A same-path root with a changed identity is a different project. Recheck its identity at continuation, before presenting the roster and before the first write. If the runtime cannot establish a stable directory identity, hold setup. Invalidate the session on reopen, back, cancel, panel disposal or workspace changes. Before forwarding Continue, atomically consume the issued ID and keep an in-flight guard until setup returns. An obsolete folder pick may neither publish a preview nor start setup. In a multiple-folder window use the existing folder picker. Pass its selected root by a host-only setup option and retain the public command contract. Test out-of-order picker responses, late Continue after reopen, repeated Continue, and cancel, dispose or workspace change while a picker is pending. In each case assert that only the current session can start setup and that obsolete requests cause zero writes. Isolate the new host work from the shared Studio page to keep its current architecture limit.

    Bind the write plan to the original selected project's reviewed input snapshot. Capture the raw project, profile, and AGENTS values used to derive planned writes and retain them through the questions. If any changed before presenting the roster, discard the computed plan and require a new review from fresh inputs. Never take a new baseline for an old derived write. Validate the selected root and all reviewed baselines before the first write, and continue to use the existing compare-and-swap writer and rollback. At replacement review, name the library team and make clear that the library is shared across projects. Bind the reviewed target and its identity to the mutation. Inspect the existing library mutation contract first. If no existing operation can guard that identity at archive time under the library's mutation boundary, hold replacement from this entry and explain how to return to review without changing files. Preserve ordinary callers. Test a same-path file edit during questions, an edit after confirmation opens, an identical or empty directory substituted at the same root path, and a replacement target changed after confirmation begins. Assert neither project is written and the changed shared team is neither archived nor overwritten.

    Reuse the existing section and profile registries. Read the selected project's saved profile and inherited model location from authoritative project policy, and show those read-only where available. List known human assignments and linked staff teams using existing project records and their verified links. Show retain, create, replacement, or appointment status where these facts establish it. If a fact or a reconciliation result is unavailable, show the reason, such as a missing appointment, an unverified link or unavailable batch reconciliation. A template alone establishes section availability only. Cover one linked team, a recorded human appointment, and an unresolved row in the read-only preview test. Existing links or appointments do not authorize new writes. Follow GUIDE-08 for shared defaults. Leave batch setup behind the reviewed plan and authorization prerequisites in the UI specification.

    Reuse Studio cards and selection controls. Keep the heading and focus predictable on entry, back and cancel. Supply the English and French copy contract for this view, using the shared locale when it becomes available in Team Studio. Stay within existing file and package architecture limits.
  </action>
  <verify>
    <automated>phase_tmp=$(mktemp -d) && flock -o /home/aaron/.cache/claude-code-tmp/heavy.lock systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 540 env PATH="/home/aaron/.nvm/versions/node/v24.22.3/bin:$PATH" NODE_OPTIONS=--max-old-space-size=1536 TMPDIR="$phase_tmp" bash -c 'npm run compile && node --test dist/test/teamStudioPage.test.js dist/test/staffSetup.test.js dist/test/staffTeamLinkage.test.js dist/test/copyLint.test.js dist/test/architecture.test.js'</automated>
    Extend the release-only Team Studio scenario in `workbench/test/e2e/get-started.spec.ts` with a test named `Team Studio staff setup previews the selected project`. Run from `workbench` with the existing installed Playwright and a private disposable bundled Workbench containing the exact verified VSIX.
    <automated>STERLING_BUNDLED_EXTENSION=1 WORKBENCH_URL="$phase_workbench_url" ./node_modules/.bin/playwright test -c test/e2e/playwright.config.ts get-started.spec.ts -g 'Team Studio staff setup previews the selected project'</automated>
    Set phase_workbench_url to the test Workbench's private address. Require one real pass and zero skips. Exercise selected project, complete-staff preview, Escape, focus return and existing section confirmation on desktop and a narrow viewport. Observe both fictional projects and the shared team target after stale confirmation cases in the root tests. Record source revision, exact bundle hash, command result and whether any file changed in the summary.
    <fails_when>A fixture role or unsupported command is offered, a stale or wrong project can receive setup, preview makes changes, existing entry points stop working or an accessible control becomes unreachable at narrow width.</fails_when>
  </verify>
  <done>Users can choose and review staff setup in Studio and reach a real existing section path. Whole-staff apply stays pending its authorized batch transaction.</done>
</task>

</tasks>
