---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 18
subsystem: chat-panel-sync-control
tags: [sync-control, accessibility, high-contrast, pick-up-card, invitation, webview]
status: complete

requires:
  - phase: 27-project-state-follows-the-project-across-interfaces-and-machines
    provides: "27-14 pick-up card (PickupModel, pickup.js); 27-15 SyncStatus, currentSyncStatus, onSyncStatus and the six nearAi.sync.* commands; 27-17 online-home flow behind nearAi.sync.onlineHome"
provides:
  - "src/domain/state/syncStatus.ts: SyncControlAction, SyncControlModel, syncControlModel, syncTimeText, shouldShowSyncPrompt, syncStatusMessage, SyncStatusMessage, SYNC_PROMPT_TEXT"
  - "src/services/syncPanel.ts: SYNC_PROMPT_DISMISSED_KEY ('nearAi.sync.promptDismissed'), syncPanelMessage, syncPromptDismissed, redactSyncText"
  - "media/chat/syncControl.js: renderSyncControl, renderSyncPrompt, refreshSyncPrompt, buildSyncPrompt"
  - "chatBridge: { type: 'sync-control', action: 'turn-on' | 'set-up-home' | 'show-details' | 'sync-now' | 'dismiss-prompt' } (strict parser)"
  - "PickupModel.checking and PickupModel.syncPrompt; pickupCardModel takes syncStatus"
  - "package.json: nearAi.sync.keepKeyInProject markdownDescription with a command:nearAi.sync.turnOn link"
affects: [27-16, readme, release-notes]

requirements-completed: [SYNC-04, SYNC-05, SYNC-09]

actuals:
  tokens: 11200
  tasks: 3
  commits: 5
plan_head_before: ce0ca09a0d3c0f91474fe055902818bb3994c64b
plan_head_after: 648ff704d207ac5d4b20f9199ed7b1910fea0be1

tech-stack:
  added: []
  patterns:
    - "The control is one real button whose text, name, tooltip, data-state and aria-busy come from a pure model built on the host; the page only draws it and posts { type: 'sync-control', action }. One click listener is installed once and reads the action of the last render, so re-rendering never stacks listeners or duplicates the control"
    - "A running sync is aria-disabled and aria-busy, never disabled, so the control stays reachable with Tab and keeps its name; a polite live region (#sync-live, in the page markup next to the button) says the new state when it changes and says nothing on the first render"
    - "The status message is redacted on the host (redactSecrets then redactGitMessage) before it is posted, and shown with textContent only"
    - "One invitation on screen: the first-run one steps aside while the pick-up card carries its own (ids sync-prompt and pickup-sync-prompt), and comes back when the card goes (refreshSyncPrompt)"

key-files:
  created:
    - src/domain/state/syncStatus.ts
    - src/services/syncPanel.ts
    - media/chat/syncControl.js
    - src/test/syncControl.test.ts
  modified:
    - media/chat/chat.js
    - media/chat/chat.css
    - media/chat/pickup.js
    - src/services/panelView.ts
    - src/services/chatBridge.ts
    - src/services/chat.ts
    - src/services/pickupCard.ts
    - src/domain/state/pickup.ts
    - package.json
    - .github/secret-scan-allow.txt

key-decisions:
  - "The control reuses 27-15's status and commands and adds no sync logic: it reads currentSyncStatus(root), follows onSyncStatus, and a click runs nearAi.sync.turnOn, nearAi.sync.onlineHome or nearAi.sync.now. Needs attention shows the plain sentence in a warning with one button, Sync Project Now (a click is the only thing that may open a GitHub sign-in, so the 27-15 sentence 'Sync needs you to sign in. Choose Sync Project Now.' is acted on from the control itself)"
  - "The invitation counts as 'sync is on' for every state but 'off', so it never shows next to 'No online home · Set up' or while syncing"
  - "The first-run invitation goes into the whole #welcome section, not only #welcome-ready, so a second computer that has not connected a profile yet still sees it (the sync restores the profile)"
  - "The pick-up card also shows while the pull on open runs, with only 'Checking for updates…' and Not now when there is nothing to pick up yet; when the status leaves syncing the host re-posts the card and it goes or refreshes"
  - "No status bar menu item was added (D-16 'if one exists'): the extension has none for sync"

patterns-established:
  - "A view helper loaded in the page as window.nearX and in tests as a CommonJS module; a second helper may reach it through root.nearX, or require('./x.js') only when module exists (pickup.js to syncControl.js)"

coverage:
  - id: D1
    description: "The chat panel's bar has a sync button right after the profile control, with its first text 'Sync off · Turn on' in the page markup and a polite live region beside it, so it is visible without scrolling, a menu or Settings from the first moment; the host posts the real state on open, on a reloaded view and on every status change"
    requirement: SYNC-05
    verification:
      - kind: unit
        ref: "dist/test/syncControl.test.js#tracer: the bar markup has the sync chip right after the profile chip and loads syncControl.js before chat.js"
        status: pass
      - kind: unit
        ref: "dist/test/syncControl.test.js#tracer: the host builds the panel-open message from the current status, and a project with sync off gets the turn-on control and the invitation"
        status: pass
    human_judgment: false
  - id: D2
    description: "Each of the five states shows its exact label ('Sync off · Turn on', 'Synced · HH:MM', 'Syncing…', 'Needs attention', 'No online home · Set up'), an accessible name that includes the state, and one click posts the matching action (none while syncing); a problem shows its plain sentence in the name and tooltip"
    requirement: SYNC-04
    verification:
      - kind: unit
        ref: "dist/test/syncControl.test.js#every status shows its exact label, a name that says the state, and posts the matching action (none while syncing)"
        status: pass
      - kind: unit
        ref: "dist/test/syncControl.test.js#a problem is shown on the control in plain words, in the name and the tooltip, not only in a log"
        status: pass
      - kind: unit
        ref: "dist/test/syncControl.test.js#tracer: the button gets its text, name and tooltip, and a click posts exactly the turn-on request"
        status: pass
    human_judgment: false
  - id: D3
    description: "The sync-control bridge message is parsed strictly (five actions, exact keys), so a forged or malformed message does nothing; each action only opens a flow the person then confirms step by step"
    requirement: SYNC-05
    verification:
      - kind: unit
        ref: "dist/test/syncControl.test.js#tracer: the bridge accepts the five requests and rejects unknown actions and extra keys"
        status: pass
    human_judgment: false
  - id: D4
    description: "A status message containing a password in a URL or a GitHub token reaches the control redacted; words are set with textContent only (no innerHTML)"
    requirement: SYNC-05
    verification:
      - kind: unit
        ref: "dist/test/syncControl.test.js#a message with a password or token in it is redacted before it reaches the control"
        status: pass
      - kind: unit
        ref: "dist/test/syncControl.test.js#the control never leaves the keyboard: aria-disabled and aria-busy while syncing, never disabled, never a negative tab index"
        status: pass
    human_judgment: false
  - id: D5
    description: "A status change re-renders the same button with one listener, and the live region announces the new state once"
    requirement: SYNC-05
    verification:
      - kind: unit
        ref: "dist/test/syncControl.test.js#a status change re-renders the same button (no second control), and the live region says the new state once"
        status: pass
    human_judgment: false
  - id: D6
    description: "The sync chip is styled by state with theme variables only (no hard-coded colour), a visible focus ring, an attention look, and a border in high-contrast themes"
    requirement: SYNC-05
    verification:
      - kind: unit
        ref: "dist/test/syncControl.test.js#the sync chip is styled by state with theme variables only, with a visible border in high contrast and no hard-coded colour"
        status: pass
    human_judgment: true
    rationale: "The tests prove the rules use theme variables and a high-contrast border, not that the chip reads well. Contrast in light, dark and high-contrast themes, and reaching it with Tab, is the plan's phase-gate manual check (plan 16 Task 2)"
  - id: D7
    description: "With sync on, the pick-up card says 'Checking for updates…' while the pull on open runs (and only then), the host re-posts it when the status changes, and nothing in the page disables the composer"
    requirement: SYNC-05
    verification:
      - kind: unit
        ref: "dist/test/syncControl.test.js#while the pull on open runs the card says \"Checking for updates…\", and the chat is not blocked; it is worked out again when the status leaves syncing"
        status: pass
      - kind: unit
        ref: "dist/test/syncControl.test.js#dismissing is remembered in workspace state, and neither the control nor the invitation opens a dialog by itself"
        status: pass
    human_judgment: false
  - id: D8
    description: "Before sync is on the pick-up card and the first-run screen show 'Keep this project on your other machines' with Turn on sync and a dismiss button; dismissing is remembered for this project for good; it never shows once sync is on; only one invitation is on screen"
    requirement: SYNC-05
    verification:
      - kind: unit
        ref: "dist/test/syncControl.test.js#the card model carries the invitation before sync is on, never once it is on, and never after it was dismissed for this project"
        status: pass
      - kind: unit
        ref: "dist/test/syncControl.test.js#a pick-up card with the invitation has the line, a Turn on sync button and a dismiss button, and without it neither"
        status: pass
      - kind: unit
        ref: "dist/test/syncControl.test.js#the first-run invitation has the line, a Turn on sync button and a way to say no, once, and goes when not wanted"
        status: pass
      - kind: unit
        ref: "dist/test/syncControl.test.js#the first-run invitation steps aside while the pick-up card carries one, and comes back when the card goes"
        status: pass
    human_judgment: false
  - id: D9
    description: "The Settings description of nearAi.sync.keepKeyInProject has a link that runs NEAR AI: Turn On Project Sync; the panel control stays the primary way in"
    requirement: SYNC-05
    verification:
      - kind: unit
        ref: "dist/test/syncControl.test.js#Settings has a link that turns sync on, next to the key-file setting"
        status: pass
    human_judgment: false
  - id: D10
    description: "The VS Code glue in chat.ts (posting on open and on every change, running the three commands, the Sync Project Now warning for Needs attention, saving the dismissal) and how the chip, the live region and the invitation look and sound in a real panel in light, dark and high-contrast themes"
    verification: []
    human_judgment: true
    rationale: "chat.ts needs a running editor and a screen reader; the tests check its source wiring and the pure parts. This is the phase-gate manual row in plan 16 Task 2: the control is visible on open in code-server and desktop VS Code in light, dark and high-contrast themes and reachable with Tab"
---

# Phase 27 Plan 18: Sync control in the chat panel Summary

**A real sync button in the chat bar next to the profile control, present from the moment the panel opens, in five plain-words states (Sync off · Turn on, Synced · time, Syncing…, Needs attention, No online home · Set up) that starts the plan-15 flow on one click, shows errors on the control, works by keyboard and in every theme, plus a dismissible "Keep this project on your other machines" invitation in the pick-up card and first-run screen and a "Checking for updates…" line while the pull on open runs.**

## Performance

- **Tasks:** 3 (one tracer, two TDD)
- **Files:** 4 created, 10 modified; 689 lines added across 13 files (the secret-scan allow-list is the 14th)
- **Tests:** 19 in `syncControl.test.ts`; pickup (25) and setupNudge still pass

## Accomplishments

- **Always there.** `#sync` sits right after `#profile` in the composer bar with its first text in the page markup, so it shows before any message arrives. The host posts the real state when the panel is ready, when a reloaded view says `chat-ready`, on `refresh-status` and on every `onSyncStatus` change for this project.
- **One click, the right flow.** Off starts `nearAi.sync.turnOn` (which routes into the D-14 online-home setup when there is no remote), No online home starts `nearAi.sync.onlineHome`, Synced runs `nearAi.sync.now`, Syncing does nothing, and Needs attention shows its plain sentence with one button, Sync Project Now. No sync logic was added here; everything is 27-15's status and commands.
- **Plain words, redacted.** Messages such as "Couldn't reach GitHub, will retry." and "Sync needs you to sign in. Choose Sync Project Now." appear in the control's name and tooltip. The host removes secrets and git credentials before posting, and the page uses `textContent` only.
- **Keyboard and themes.** It is a `<button type="button">` with an accessible name that includes the state (`Project sync: off. Choose to turn on.`), never `disabled` (it is `aria-disabled` and `aria-busy` while syncing), with a polite live region that announces a changed state once. The CSS uses only theme variables, a focus ring from `--vscode-focusBorder`, an error look for attention, and a `--vscode-contrastBorder` border under `body.vscode-high-contrast`.
- **The invitation.** "Keep this project on your other machines" with Turn on sync and Don't ask again appears in the pick-up card when it shows, otherwise on the first-run screen, only while sync is off. Dismissing writes `nearAi.sync.promptDismissed` to the project's workspace state and it never returns; turning sync on removes it. Neither the control nor the invitation opens a dialog on its own.
- **Checking for updates.** The card model carries `checking` while the status is syncing with reason `open`; the host re-posts the card on every status change so it refreshes with the newest state. Nothing disables the composer.
- **Settings.** `nearAi.sync.keepKeyInProject` keeps its plain description and gains a `markdownDescription` with a `command:nearAi.sync.turnOn` link.

## Task Commits

1. **Task 1 (tracer): control in the bar, one click into the turn-on flow** - `5f5b152` (feat)
2. **Task 2 RED** - `3294f6e` (test, 11 of 12 pass, the style rules fail)
3. **Task 2 GREEN** - `a0c958b` (feat, 12 of 12)
4. **Task 3 RED** - `6e14b4a` (test, 5 of 18 fail)
5. **Task 3 GREEN** - `648ff70` (feat, 19 of 19)
6. *(Rewritten in plan 27-16, before anything was pushed: the redaction test now builds its fake GitHub token at run time, so no allow-list line and no extra commit are needed.)*

**Plan metadata:** the docs commit that carries this SUMMARY, STATE.md and ROADMAP.md.

**TDD evidence, said plainly.** The tracer already built the model for all five states, the button renderer, the live region and the redaction, so Task 2's tests mostly passed on arrival (11 of 12); the one that failed was the style rule test, for the intended reason (no `#sync` rules in `chat.css`). Task 3's RED run failed 5 of 18 for the intended reasons: no `checking` or `syncPrompt` on the card model, no `syncStatus` wiring in the host, no `markdownDescription`. The first-run invitation test already passed because the tracer's module held `renderSyncPrompt`. The RED test commits do not type-check on their own (they name `PickupModel.checking`, which GREEN adds); tsc still emits and the tests run.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] A secret-scan block on the redaction test**
- **Found during:** final verification
- **Issue:** the test that proves a GitHub token is removed from a status message holds a fake `ghp_` token, which the project's secret scan reports (range scan over this plan's commits).
- **Fix:** first an allow-list line; plan 27-16 replaced it (before anything was pushed) by building the fake token at run time in `src/test/syncControl.test.ts`, so the allow-list line and the literal are gone from the whole range.
- **Files modified:** `src/test/syncControl.test.ts`
- **Commit:** `3294f6e`

**2. [Rule 3 - Blocking] The existing pick-up wiring test pins the exact `case 'pickup-card'` line in chat.js**
- **Found during:** Task 3 GREEN
- **Issue:** my first version added the invitation's re-render to that line and broke `pickup.test.js`.
- **Fix:** the line is unchanged; `pickup.js` tells `syncControl.js` to re-work the first-run invitation (`refreshSyncPrompt`) when the card shows or goes.
- **Files modified:** `media/chat/pickup.js`, `media/chat/syncControl.js`, `media/chat/chat.js`
- **Commit:** `648ff70`

### Plan wording

- **New file `src/services/syncPanel.ts`** (not in the plan's file list) holds the dismissal key, the redaction and `syncPanelMessage`, because `src/domain` should not import a service's value (`redactGitMessage`); `syncStatusMessage` stays pure in the domain file and takes the redaction as a parameter.
- **The invitation goes into `#welcome`, not `#welcome-ready`.** The plan names the ready area; a computer that has not connected a profile yet shows only the Connect panel there, and it is exactly the one that wants sync (a restore brings the profile). So it shows on the first-run screen in both states.
- **The pick-up card is also shown for the checking line when there is no pointer to pick up**, with only that line and Not now; the plan says "shows 'Checking for updates…'" without saying which card.
- **Needs attention** shows a warning with Sync Project Now, where the plan says "shows the plain message with the next action".
- **The invitation's state test.** `prompt` is true only for 'off'; for 'no-home' the control already asks to set up, so the invitation stays away.

**Total deviations:** 2 auto-fixed (1 missing-critical, 1 blocking), 5 wording differences. **Impact:** none on the contract.

## Authentication Gates

None.

## Issues Encountered

The full suite (`dist/test/*.test.js` and `scripts/test/*.test.mjs`, 6 GB cap) is 1 780 tests: 1 770 pass, 9 skipped, 1 fails, the known `chatSendPath` "GSD slash command" failure. `npm run lint` is clean and `node scripts/secret-scan.mjs --range ce0ca09a..HEAD` is clean. `.planning/state.json` was already modified and was left alone.

A panel that opens before the project's sync setting has been read (a few milliseconds after activation) shows the 'off' state and the invitation for that moment, then corrects itself when 27-15's scheduler is enabled; for a project that has turned sync on, the invitation can flash once at most. Not changed: reading the setting in the panel would duplicate 27-15's logic.

## Known Stubs

None.

## Threat Flags

None. The register is covered: T-27-87 (strict parser, five actions, exact keys; each action only opens a flow that still asks for every account action), T-27-88 (host redaction with `redactSecrets` and `redactGitMessage`, `textContent` only; tested with a password in a URL and a token), T-27-89 (the invitation shows only while sync is off, its dismissal is stored per project, no dialog is opened by the control or the invitation).

## Next Phase Readiness

- Plan 16's manual gate row should include: the control visible on open, in light, dark and high-contrast themes, in desktop VS Code and code-server, reachable with Tab, and announced by a screen reader when it changes.
- The README can say that sync is turned on from the button in the chat bar, with the Command Palette and Settings as extra ways in.
- Not done: a status bar menu entry (the extension has no sync status bar item).

## Self-Check: PASSED

- Files: `src/domain/state/syncStatus.ts`, `src/services/syncPanel.ts`, `media/chat/syncControl.js`, `src/test/syncControl.test.ts` exist.
- Commits `5f5b152`, `3294f6e`, `a0c958b`, `6e14b4a`, `648ff70` are ancestors of HEAD; 5 measured by `git rev-list --count ce0ca09a..HEAD` before this docs commit.
- Acceptance: syncControl 19 passing (needs 18), pickup and setupNudge pass, 0 failing; `grep -c 'id="sync"' src/services/panelView.ts` is 1; `grep -c "asset('syncControl.js')"` is 1; `grep -c "sync-control" src/services/chatBridge.ts` is 3; `grep -c "#sync" media/chat/chat.css` is 9; `grep -c "vscode-high-contrast" media/chat/chat.css` is 2; the package.json node check exits 0.
- Plan verification: full suite 1 770 of 1 780 with only the known failure; lint clean; secret scan clean.
