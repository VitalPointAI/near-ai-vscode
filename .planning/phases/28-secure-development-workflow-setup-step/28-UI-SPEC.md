---
phase: "28"
slug: secure-development-workflow-setup-step
status: approved
shadcn_initialized: false
preset: none
created: "2026-11-26"
---

# Phase 28 UI design contract

## Design System

| Property | Value |
| --- | --- |
| Tool | none. Inherit the existing editor-native Project Setup interface. |
| Preset | Existing default host theme. |
| Component library | Native Quick Pick, commands, and editor diff. Use existing webview buttons and disclosure patterns if the step needs a detail view. |
| Icon library | Existing host Codicons. Pair `shield` and `check` with textual labels. |
| Font | `--vscode-font-family` for prose, `--vscode-editor-font-family` for paths, commands and diffs. |

Use the step registry in `src/services/setupSteps.ts` and the folder-bound Quick Pick in `src/services/setupMenu.ts`. Workbench's **Current project setup** already calls the same command. Reuse the editor diff pattern in `src/services/teamUpdateCommands.ts`. Any custom detail content follows existing setup controls in `media/chat/setup.js` and `media/chat/chat.css`. Apply the same interaction contract in each host that exposes Project Setup.

## Spacing Scale

| Token | Value | Usage |
| --- | --- | --- |
| xs | 4px | Icon-to-label and inline status gaps. |
| sm | 8px | File row and action spacing. |
| md | 16px | Section spacing and detail-view padding. |
| lg | 24px | Separation between local files and owner setup. |

The host owns native picker and editor metrics. In a detail view, wrap actions into reading order and stack sections at narrow widths. Let file paths wrap and keep horizontal scrolling inside command or diff content.

## Typography

| Role | Size | Weight | Line height |
| --- | --- | --- | --- |
| Body | 13px | 400 | 1.5 |
| Status, label and code | 12px | 400 | 1.45 |
| Section heading | 16px | 600 | 1.25 |

These are local detail-view roles. Native surfaces inherit host font size and scale. Render commands as text in the editor font with accessible labels separate from command content.

## Color

| Role | Value | Usage |
| --- | --- | --- |
| Dominant (60%) | `--vscode-sideBar-background`, fallback `--vscode-editor-background` | Page surface. |
| Secondary (30%) | `--vscode-editorWidget-background`, border `--vscode-panel-border` | Detail groups and file review. |
| Accent (10%) | `--vscode-button-background` with `--vscode-button-foreground` | The single action that advances the current state. |
| Blocking message | `--vscode-editorWarning-foreground` with the host's usual text contrast | Conflicts, stale checks and unresolved owner work. Include a readable status and recovery action. |

Reserve accent for **Prepare workflow**, **Add missing files**, **Check repository settings**, or the current recovery action. Use `--vscode-focusBorder` for keyboard focus. Use a named state and, where helpful, an icon for all status indicators. Existing high-contrast and diff settings apply. No new theme or destructive color treatment is required.

## Copywriting Contract

| Element | Copy |
| --- | --- |
| Setup step | **Secure development workflow** |
| Step detail | Prepare checks for proposed changes, independent review, and releases that wait for your approval. |
| First action | **Prepare workflow** |
| Preview heading | **Review proposed files** |
| File actions and labels | **View changes**, **Add missing files**, **Already present**, **Your file differs** |
| No changes | **No files to add.** Check repository settings to see what still needs attention. Use this message when required files match the kit or meet verified compatibility. |
| Conflicts only | **Some files differ.** View changes, reconcile the affected files, and refresh the preview. |
| Owner heading | **Finish setup in GitHub** |
| Owner actions | **Copy command**, **Check repository settings**. Announce **Command copied** without moving focus, or explain how to select the command if copying fails. |
| Owner explanation | Run these steps in your own GitHub session. Workflow setup never asks for a token. |
| Remote unavailable | **Repository settings could not be verified.** Check access to the repository, then try again. |
| Local placement unavailable | **Workflow files can’t be added here.** Open the project in a supported, writable Workbench and reopen Project Setup. |
| Stale file proposal | **Project files changed.** Prepare a new preview before applying changes. |
| Project switched | **The selected project changed.** Open Project Setup again to continue. |
| Skip and return | **Skip for now**. Reopen **Secure development workflow** from Project Setup. |
| Verified | **Secure development workflow (done)** |
| Replacement | If a later task enables replacement, show the exact diff and require an explicit file-specific **Replace file** action. The first path adds missing files and leaves conflicts visible. |

## Interaction Contract

1. Offer the optional step to a software project through the existing Project Setup entry. Resolve the selected project before generating a proposal. Use the existing supported profile or supply the one clear reason setup cannot proceed. Show that the DevOps member prepares the proposal. Keep role name, project, and proposed repository visible where people make decisions.
2. Preparing produces a preview. Present a deterministic list with relative file path, effect, and status for every managed file. Use the native diff for differing content. **Add missing files** applies only the previewed additions, leaves existing files intact, and reports the resulting state for each entry. Show the apply action only when the selected workspace can safely place the reviewed files. On a stale preview, changed project, or unresolved write, return to review. Show completed work and remaining files after a partial result.
3. Show local files and remote settings as separate stages. Give the owner separately labelled instructions for required checks on the default branch, independent review, and release approval. Include the separately labeled owner-run credential and secret setup and any required first-run bootstrap. Show any prerequisite evidence each command expects, including correct repository and branch, existing check identity and first run when required. Copy is a clipboard action for one displayed command. Repository or branch text must be a verified value. The view must not execute commands, solicit credential values, or display stored secrets.
4. Bind **Check repository settings** to the selected repository, default branch and current workflow revision. Mark the step done only when the required local files are compatible and fresh remote observations confirm every required condition. An unresolved local conflict stays visible even when remote checks pass. Show a text result for each condition: **Verified**, **Needs owner action**, or **Could not verify**. Unsupported repository capabilities or permissions stay visibly unresolved. Display when verified, and downgrade to **Check again** if the evidence is no longer current. Keep the step reopenable after success and after a skip.
5. Keyboard order follows the visible reading order. File diff has a unique accessible name that includes the file path. On close, return focus to the invoking file row or setup entry. Use a polite live status for prepare/apply/check results, with a readable error announcement for blocked actions. Keep focus where it is during passive refresh. Render repository values, file paths and command previews as text. The renderer never treats a repository-supplied string as markup.

The primary visual anchor is the chosen project and repository during preparation, the file
list during preview, the outstanding owner conditions during handoff, and the status list
and verification time after checking. Each has one next action tied to the active state.

## UI Considerations

Applicable state considerations resolved: 10 covered.

| Category | Elements | Status | Resolution |
| --- | --- | --- | --- |
| empty | Review list | ✅ covered | Matching files route to repository verification. Conflicts alone stay in review with a targeted reconciliation action. |
| loading | Prepare, apply and check | ✅ covered | Name the active operation, disable repeat submission, and retain existing visible data. |
| error | Local preview and remote verification | ✅ covered | A failure remains incomplete and offers the matching recovery action. |
| populated | Preview and verified state | ✅ covered | File rows disclose effects and a verified state requires affirmative current evidence. |
| partial | Files and repository settings | ✅ covered | Show each completed, pending, differing or unverified item independently. |
| stale | Project and proposal | ✅ covered | A stale proposal cannot apply, and a changed project requires reopening Setup. |
| unsupported host | Local file placement | ✅ covered | Keep the preview available and hide the write action. Explain how to open a supported, writable project. |
| overflow | File names and commands | ✅ covered | Labels wrap, command text remains selectable, and only the diff or code region scrolls horizontally. |
| zero-one-many | File entries and check results | ✅ covered | Use one consistent labelled list for files and one for owner conditions; preserve keys across updates. |
| keyboard and re-entry | Skip, diff, check and done | ✅ covered | Completion announcements preserve focus and the setup row stays reachable after skip and verification. |

## Registry Safety

No UI registry or third-party components are needed. Use editor-native primitives and existing repository styles.

## Checker Sign-Off

- [x] Dimension 1 Copywriting passes.
- [x] Dimension 2 Visuals passes.
- [x] Dimension 3 Color passes.
- [x] Dimension 4 Typography passes.
- [x] Dimension 5 Spacing passes.
- [x] Dimension 6 Registry Safety passes.
- [x] Dimension 7 Inventory Provenance passes.

Independent UI check passed with follow-up copy and state clarifications. The phase remains planned.
