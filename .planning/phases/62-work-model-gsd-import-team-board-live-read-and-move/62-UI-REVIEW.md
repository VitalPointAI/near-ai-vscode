# Phase 62 - UI Review

**Audited:** 2026-11-02
**Baseline:** 62-UI-SPEC.md (approved) plus .planning/UX-CONTRACT.md plus the PROJECT.md "No developer knowledge required" principle
**Screenshots:** not captured. Audited from code and tests; no browser run (no screenshots, no dev server, no interaction capture)
**Interaction captures:** off (not requested). All interaction findings are code-derived.

Files read: media/board/{board.js,detail.js,drag.js,form.js,menu.js,board.css}, src/services/team/{boardView.ts,teamStatusBar.ts,teamCommands.ts}, src/domain/team/boardText.ts, src/team/importPlans.ts (importResultText and failure reasons), package.json (contributes.commands), and the test list under src/test (boardClient, boardDetail, boardDrag, boardForm, boardMenu, teamBoardView, teamBoardAssets, teamBoardItems, teamBoardLive).

---

## Pillar Scores

| Pillar | Score | Key Finding |
|--------|-------|-------------|
| 1. Copywriting | 2/4 | The board matches the contract word for word, but the contract itself ships git/dev vocabulary (remote, team log, pattern/glob, merged, Push) in required paths |
| 2. Visuals | 3/4 | Inline SVG icons with text on every state; focal points follow the contract; cannot confirm real rendering without a browser |
| 3. Color | 3/4 | Theme variables only, no hex or rgb literals in board.css, high-contrast and forced-colors blocks present; 60/30/10 not checked visually |
| 4. Typography | 3/4 | Exactly 4 sizes (0.85/1/1.2/1.5em) and 2 weights (400/600), as declared |
| 5. Spacing | 3/4 | Mostly 4/8/12/16/24/32; a handful of 2px paddings off the declared scale |
| 6. Experience Design | 3/4 | Full keyboard, live-region, pending, refusal and offline coverage; progress/refusal paths depend on jargon-heavy text and a Verify Team Log escape hatch |

**Overall: 17/24**

---

## Top Priority Fixes

1. **BLOCKER: git/dev vocabulary in required board paths** (see "Developer-jargon findings", J-01 to J-14) - violates the owner's prime principle; people who do not know git cannot act on "team remote", "team log", "pattern ... src/services/**", "merged", "integration branch", "Push" - rewrite each string (replacements below) and amend UI-SPEC so the tests that pin the old words are updated, not deleted.
2. **WARNING: the paused/untrusted recovery path is "Run Verify Team Log"** (board.js:22-23, teamStatusBar.ts:38) - a non-developer is told to run a command to learn "why" with no plain outcome - offer a "Check the team" action in the banner that opens the result in plain words, and keep "Verify Team Log" only as the command-palette name.
3. **WARNING: the Files field asks for glob patterns** (form.js:18, form.js:23, boardView.ts:48) - the "Files this touches" field is a developer decision, and without it the item silently stays in Backlog (form.js:19) - make it optional with a plain label and a folder picker, or drop it from the form and let the lead add it later.
4. **WARNING: "Done in GSD, confirm" badge and "Wave", "Must-haves", "Kind", "Source" facts** (detail.js:92,178-186, boardText.ts:212) - unexplained internal vocabulary - rename to plain words (J-15 to J-19).
5. **WARNING: columns Claimed / In progress / In review / Integrating are shown now but cannot be used** (boardText.ts:17-19) - dead columns carry "arrives in a later update" captions and one uses a merge icon (board.js:15, detail.js:11) - collapse them by default or hide until Phase 63, and drop the `git-merge` icon.
6. **WARNING: status bar tooltip text is built from internal reason strings** (teamStatusBar.ts:100-111, `BRANCH_MISSING_REASON`, `TEAM_REJECTION_REASONS`) - reasons can carry git wording through `safeReason` - map each known reason to a fixed plain sentence and show the raw reason only in the output channel.
7. **WARNING: 2px paddings off the declared 4px grid** (board.css, 6 declarations such as `padding: 2px 8px`) - contract says multiples of 4 except listed exceptions; badge padding is not listed - move to 4px or add to the exception list.

---

## Developer-jargon findings

Ordered most important first. Each row: file:line, exact current string, replacement. Lines are from the files as read; `boardText.ts` is the shared source the board webview and host draw from.

| ID | Where | Current string | Why it breaks the principle | Plain-language replacement |
|----|-------|----------------|-----------------------------|----------------------------|
| J-01 | media/board/form.js:18 (hint), form.js:23 (error), src/services/team/boardView.ts:48 (host error) | `One pattern per line, for example src/services/**` and `Use one pattern per line, relative to the project folder, for example src/services/**.` | "Pattern", "glob" syntax (`**`), "relative to" a path; a required-looking decision in the New item form | Label `Files this touches (optional)` becomes `Parts of the project this covers (optional)`, hint `Add a folder or file name on each line, for example "settings". Leave empty if you are not sure.` Error `One of these lines is not a folder or file name in this project. Remove it and try again.` Best: a folder picker so no typing is needed |
| J-02 | media/board/form.js:19 | `Without files and an estimate this item stays in Backlog.` | Makes the glob field a gating decision | `This item stays in Backlog until you say which parts of the project it covers and roughly how big it is.` |
| J-03 | media/board/board.js:22, boardView.ts (same text), 62-UI-SPEC copy table | `The team log changed in a way the board cannot trust, so the board is paused. Run "NEAR AI: Verify Team Log" to find out why.` | "Team log" is the append-only git-backed log; "Verify" is an operator action | `Something unexpected changed in the shared team record, so the board is paused to protect your work. Choose "Check the team" to see what happened, or ask your lead.` |
| J-04 | media/board/board.js:23 | `The team log did not pass its checks, so the board is paused. Run "NEAR AI: Verify Team Log" to find out why.` | same | `The shared team record failed a safety check, so the board is paused. Choose "Check the team" to see what happened, or ask your lead.` |
| J-05 | src/domain/team/boardText.ts:39 (`REFUSALS.offline`), used in boardView.ts failureText | `The team remote could not be reached, so nothing was changed. Try again when you are back online.` | "Remote" is a git term | `The team could not be reached, so nothing was changed. Check your internet connection and try again.` |
| J-06 | media/board/board.js:17 (`T.slow`) | `This is taking longer than usual. The team remote may be slow.` | "remote" | `This is taking longer than usual. The connection to your team may be slow.` |
| J-07 | src/team/importPlans.ts:495 and :498 (import failure reasons that reach the import notice via `importResultText`, src/team/importPlans.ts:594-596) | `There is no integration branch to import from.` and `The integration branch was not found on the team remote` and `The team remote could not be reached (...)` | "integration branch" and "team remote" in a notice the board shows after Import plans | `The team's shared copy of the project could not be found, so nothing was imported.` / `The team could not be reached, so nothing was imported. Check your internet connection and try again.` |
| J-08 | src/team/importPlans.ts:534 | `The integration branch has no .planning folder.` | branch, `.planning` path | `This project has no plans to import yet. Plan your first phase, then import again.` |
| J-09 | src/services/team/boardView.ts:61 (`DONE_DETAIL`, modal on Mark done) | `Use this when the work is finished and merged. The whole team will see it as done, ...` | "merged" is a git step and is stated as a precondition | `Use this when the work is finished and added to the project. The whole team will see it as done, and plans that wait for it can become ready. You can reopen it later.` |
| J-10 | src/services/team/teamCommands.ts:17, :313-316 (Enable Team Mode result: the Push offer, reachable before the board exists) | `Push` button, message `team.json is committed on ${branch}. Push it when you are ready so teammates can see the team.`, then `Pushed ${branch} to ${remote}.` | commit, branch, push, remote, `team.json` | Button `Share with my team`; message `Team Mode is on. Share it so teammates can see the team.`; success `Shared with your team.` (the agent does the push) |
| J-11 | src/services/team/teamStatusBar.ts:12, 14, 111 (`PAUSED_UNREACHABLE_TEXT`, `PAUSED_MISSING_TEXT`, tooltip lead) | `Team sync paused: remote unreachable`, `Team sync paused: log missing on remote`, `The team remote could not be reached.` | "remote", "log" in the always-visible status bar | `Team sync paused: offline`, `Team sync paused: team record missing`, tooltip `The team could not be reached.` |
| J-12 | src/services/team/teamStatusBar.ts:13, 15, 38, 108 | `Team sync paused: log rewritten`, `Team log not trusted`, `Click to run Verify Team Log.`, `The team log did not pass its checks ... Team events are being ignored.` | "log rewritten" is a git history concept; "Verify Team Log" | `Team sync paused: record changed`, `Team record not trusted`, `Click to check the team.`, `The shared team record failed a safety check, so the board is paused and new team activity is ignored. Click to check the team.` |
| J-13 | package.json contributes.commands: nearAi.team.verifyLog title `Verify Team Log`; nearAi.team.importPlans title `Import Plans to Team Board` | `Verify Team Log` | "log" | Rename to `Check Team Record`. The import title is acceptable (plans is product vocabulary) |
| J-14 | src/services/team/teamSession.ts:50 and src/domain/team/boardText.ts:30 (`READ_ONLY_TEXT`, `NO_DEVICE_KEY_TEXT`), shown in the board read-only banner and refusals | `This computer has no device key for this team, so it can read the team log but not write to it.` | "device key", "write ... log" | `This computer is not yet approved to make changes for this team. You can look at the board. Ask your lead to approve this computer.` |
| J-15 | media/board/detail.js:92, boardText.ts:212 (accessible name) | `Done in GSD, confirm` badge and `Done in GSD, waiting for confirmation.` | GSD is internal tool vocabulary | `Looks finished, please confirm` and `The plan files say this is finished. Waiting for someone to confirm.` |
| J-16 | media/board/detail.js:14 and boardText.ts:56 (`IMPORTED_NOTE`), boardView.ts:53 | `This comes from the project plans. Change the plan files and the board updates.` and `Items from the project plans change only when the plan files change.` | "plan files" implies editing files | `This comes from the project plans. To change it, update the plan in Open-GSD and the board follows.` |
| J-17 | media/board/detail.js:178-186 | Fact labels `Wave`, `Kind`, `Source`; section `Must-haves`; `Requirements` | GSD-internal terms with no explanation | `Wave` becomes `Order within the phase`; `Kind` becomes `Type`; `Source` becomes `Where it came from`; `Must-haves` becomes `What must be true when it is done` |
| J-18 | src/domain/team/boardText.ts:17-19 and src/domain/team/boardText.ts:23 (`MOVE_LABELS`) | Column `Integrating`, caption `Merging arrives in a later update.`, refusal `Merging arrives in a later update. Nothing was moved.`; `git-merge` icon at board.js:15 and detail.js:11 | "merge" and a git icon on a visible column | Column `Shipping`, caption `Adding finished work to the project arrives in a later update.`, icon `check-all`/plain arrow; refusal `Adding finished work to the project arrives in a later update. Nothing was moved.` |
| J-19 | src/services/team/boardView.ts:67-68 (REASON_PROMPTS placeholders) | `For example: waiting for the API key` | "API key" is developer vocabulary (minor, product term for this extension) | Keep, but add a second neutral example: `For example: waiting for a teammate's answer` |

Not violations (checked): "tokens" estimates (the product's own unit; the form explains "A rough size is fine"), "Backlog", "Ready", "Review", "Phase", "Plan" (GSD product vocabulary the owner uses), "bug / chore / spike" (acceptable, but `spike` is jargon for non-developers; consider `Experiment`), no `.planning` path, SHA, JSON, frontmatter, slug, worktree, rebase, PR or HEAD string appears in the board webview or status bar. The raw output-channel lines (boardView.ts around the `Team Board: ... was not saved (${result.kind})` lines) are developer-facing details and acceptable as the optional details view.

Test impact: the old words are pinned by boardText/boardClient/boardForm/teamBoardView tests and by a test that greps authored strings for dashes; update the expected strings alongside the code. Do not weaken the dash grep.

---

## Detailed Findings

### Pillar 1: Copywriting (2/4)

Strengths: every state sentence ends with "Nothing was moved/saved." (boardText.ts:30-58, boardView.ts:42-55); CTAs are specific (`New item`, `Import plans`, `Move to...`); "Cancel" is reserved for the real action (`Cancel this item`, `Keep item`, boardView.ts:62-64); empty, error and loading states exist for every case in the contract copy table (board.js:17-24).

Defects:
- BLOCKER: the contract was approved with git vocabulary in it, so the code is faithful to a contract that violates the owner's principle. 19 jargon strings above, 14 of them in required or always-visible paths (empty-state import failure, paused banner, status bar, Mark done modal, New item form). Score capped at 2 for this reason alone.
- WARNING: `spike` as an item type (form.js Type select) and `Wave`/`Must-haves` have no explanation for non-developers.
- WARNING: dead-column captions ("Claiming arrives in a later update.", boardText.ts:17-19) repeat in four columns and in the list's empty groups; they read as unfinished product, not as guidance.

### Pillar 2: Visuals (3/4)

- Icons are inline SVG drawn with `createElementNS` (board.js ICONS, board.js:27-40) rather than the vendored codicon font in the contract. This is the contract's stated fallback and removes the font-vetting task; acceptable, but board.js:15 still maps Integrating to a `git-merge` glyph (see J-18).
- State is encoded as icon plus word everywhere (detail.js:90-93 badges, board.js column heads). Good.
- Focal points follow the contract (empty state heading at Display size, only the primary button filled, board.js:390).
- Cannot confirm: real layout, drawer overlay under 800px, horizontal scroll feel, drag image, because no browser run was done. Treated as unverified, not as passed.
- Eight columns are visible on first load, four of which are permanently empty this phase (board.js:11 `LATER`), which dilutes the Ready focal point. Collapse by default.

### Pillar 3: Color (3/4)

- board.css contains no `#hex` or `rgb()` literal (grep clean); all colour comes from `--vscode-*` variables, with `color-mix` for tints.
- `body.vscode-high-contrast` and `high-contrast-light` borders (board.css:168) and an `@media (forced-colors: active)` block (board.css:170) exist.
- Accent reservation list in the contract (focus ring, selected bar, drop outline, primary buttons, links, progress) is the only accent usage found by class; no per-state colours.
- Not verified: the muted-text-on-tinted-background contrast rule (contract line 143) and the 60/30/10 split, which need a rendered theme check. Docked a point for unverified contrast on the selected and drop-target tints.

### Pillar 4: Typography (3/4)

Distribution in board.css: font-size 0.85em x16, 1em x1, 1.2em x4, 1.5em x2; font-weight 400 x3, 600 x5. Exactly the 4 sizes and 2 weights declared. No px font sizes. Gap to 4/4: titles clamp (3 lines kanban, 2 list) and `overflow-wrap: anywhere` were not verified with a long-title fixture in a browser. The 0.85em Small size is used for 16 rules, including the readiness hint and field hints that carry the only explanation of the Files field (form.js:19); small, muted text is the wrong place for decision-critical guidance.

### Pillar 5: Spacing (3/4)

Declared scale used consistently: `gap: 8px` x6, `4px` x6, `12px` x4, `padding: 8px 12px` (cards) x4, `24px` drawer padding, `32px 12px` empty state. Off-scale values: `padding: 2px 8px`, `2px 12px`, `2px 4px`, `2px` (badge and chip rules). The contract lists 2px only for focus offset and radius, so these are undeclared exceptions. No arbitrary `[..px]` values (not Tailwind). Narrow-width and 280px breakpoints exist (board.css:153, 158).

### Pillar 6: Experience Design (3/4)

Covered (from code and the tests listed): loading with 10 second slow message (board.js:17, :363), error with Try again and Show details (board.js:327, :377), offline and paused banners, removed and read-only banners, pending state with `aria-busy`, refusal line with dismiss, stale-card refusal naming the teammate, single live region with debounced filter and change-summary announcements (board.js:115, :244, :738-750), reduced-motion block (board.css:179), keyboard model with M / Shift+F10 / ContextMenu (board.js:654), drag with Escape cancel and "Can't drop here" caption (drag.js:75), modal confirms only for Mark done and Cancel item, and a discard-changes guard in the form. Tests exist for client, detail, drag, form, menu, view, assets, items and live updates.

Defects:
- WARNING: the only recovery from a paused or untrusted board is a command-palette command named in jargon (J-03, J-04, J-12); no in-banner action.
- WARNING: the New item form can be submitted with no files and no estimate and the item silently lands in Backlog; the explanation is one muted line (form.js:19). A non-developer will not know why their item never becomes Ready.
- WARNING: four columns the user can see, hover and attempt to drag into cannot accept cards this phase (board.js:11); each attempt produces a refusal. Hide or collapse them until they work.
- WARNING: Enable Team Mode's "Push" choice (J-10) is a required decision before teammates see the board.
- Cannot confirm without a browser: drag feel, focus restoration after menu close, FLIP animation, narrow-width reflow. Listed in the contract as acceptance items for hands-on review.

---

## Files Audited

- media/board/board.js, detail.js, drag.js, form.js, menu.js, board.css
- src/services/team/boardView.ts, teamStatusBar.ts, teamCommands.ts (Enable, Import, Push flow)
- src/domain/team/boardText.ts
- src/team/importPlans.ts (importResultText and failure reasons)
- package.json (contributes.commands titles)
- .planning/phases/62-work-model-gsd-import-team-board-live-read-and-move/62-UI-SPEC.md (lines 1-554), .planning/UX-CONTRACT.md, .planning/PROJECT.md (Product principles)
- Test inventory: src/test/boardClient, boardDetail, boardDrag, boardForm, boardMenu, teamBoardView, teamBoardAssets, teamBoardItems, teamBoardLive, teamSessionImport (names and coverage only; test bodies were not read in full)

Registry audit: skipped (no components.json; shadcn not applicable).
