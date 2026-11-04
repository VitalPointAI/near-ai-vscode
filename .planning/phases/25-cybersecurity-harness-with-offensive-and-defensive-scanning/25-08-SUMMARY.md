---
phase: 25-cybersecurity-harness-with-offensive-and-defensive-scanning
plan: 08
subsystem: security
tags: [cybersecurity, webview-panel, command-registration, disclaimer, timeline, export-ui]

requires:
  - phase: 25-01
    provides: "resolveTarget, Engagement/Finding/DisclaimerAcceptance, the engagement store"
  - phase: 25-02
    provides: "the protocol driver (askRole) the panel's run stack binds"
  - phase: 25-03
    provides: "detectTools, TOOL_CATALOGUE, installOffer, missingToolsNote"
  - phase: 25-05
    provides: "startCyberRun, CyberLedgerStore/CyberEvidenceStore, replayRun"
  - phase: 25-06
    provides: "verdict language the timeline and findings table render"
  - phase: 25-07
    provides: "exportRun, buildPtesReport, toSarif and findingsDocument"

provides:
  - "src/services/cyberPanelPage.ts: CyberWebviewMessage handling, scope preview with per-mode gating, the disclaimer flow, the HTML shell"
  - "src/services/chatBridge.ts: the CyberWebviewMessage union and parseCyberMessage (separate from ChatWebviewMessage)"
  - "src/services/cyberPanel.ts: the singleton webview, the export/replay/tools/model deps"
  - "src/services/cyberService.ts + src/services/cyberHandoff.ts: the host side — panel service deps, the run starter, the install executor, the tool context"
  - "src/services/agentSession.ts: AgentTurnRequest.cyber and the toolsFor branch that attaches cyber tools only for cyber turns"
  - "media/cyber/{cyber.js,cyber.css,cyber.html}: the client (textContent-only rendering, theme-safe CSS)"
  - "package.json: the nearAi.openCyber command, its own activation event, and the view/title menu entry"

affects: []

actuals:
  tokens: 41200
  tasks: 3 of 4 (Task 4 is the owner's hands-on checkpoint)
  commits: 1

tech-stack:
  added: []
  patterns:
    - "Panel = host service (cyberPanel.ts) + page logic (cyberPanelPage.ts) + client assets (media/cyber/), never inline script strings"
    - "The cyber message union is its own type and parser, so chat's dispatcher can never receive one"
    - "Every deps object is injected, so the whole panel runs under node --test with a stub host"
---

# Plan 25-08 — the Cybersecurity panel

## What landed

One commit (`ce0f067`) covering Tasks 1–3. **Task 4 is the owner's hands-on checkpoint and is not signed off** — this summary marks it outstanding rather than claiming it.

## What is real and test-proven

| Must-have | Evidence |
|---|---|
| A `NEAR AI: Cybersecurity` command opens a singleton panel | `package.json` carries the command, `onCommand:nearAi.openCyber`, and a `view/title` entry scoped to `nearAiChatView`; `cyberPanel.ts` reveals on re-open and sets `retainContextWhenHidden` |
| All five target kinds resolve and preview before anything is sent | `cyberTargets.test.ts` — 7 cases over url/workspace/cidr/container/git, including the CIDR budget refusal |
| Modes exceeding the scope are disabled WITH a reason | `modeAvailability` returns `{enabled: false, reason}`; asserted for a workspace scope and for a disabled sandbox |
| Creating an engagement shows the disclaimer for the detected region with a visible override | `disclaimerPrompt` returns all twelve regions, the detected one, and the red public-sector warning; `cyberPanel.test.ts` asserts `Europe/London` detects `uk` |
| Accepting records the acceptance; declining leaves everything untouched | Accepting writes exactly one engagement with the overridden region; declining writes zero (the store's `create` is never called) |
| The Run button drives a run and the panel follows its events | `startRun` receives an abort signal, forwards `step-started`/`step-finished`/`done` in order, and the panel reveals once on the first event (D-05) |
| Stop halts the run | `stop` aborts the signal the starter was handed; the controller is created before the first `await` so an immediate Stop still finds it |
| The step timeline shows tool/target/duration/result with collapsible reasoning | `media/cyber/cyber.js` builds each row and a `<details>` block; asserted by the client-asset grep |
| The model is remembered per engagement | The key is `nearAi.cyber.model.<engagementId>`; the test proves a second engagement still reports the chat default |
| Missing tools offer a one-click install through an approval-gated path | `installOffer` supplies the exact command; `installTool` runs it and the test asserts the catalogue string, and that an uncatalogued tool is refused |
| Export and replay work | The export test drives all three formats; replay re-renders steps with no execution |
| Ordinary chat does not carry the cyber tools | `toolsFor` appends them only when `request.cyber` is set |

## Verification

| Gate | Command | Result |
|---|---|---|
| Lint / typecheck | `npm run lint` | exit 0 |
| Plan tests | `node --test dist/test/cyberPanel.test.js dist/test/cyberTargets.test.js` | 22 pass, 0 fail |
| Chat/agent regressions | `node --test dist/test/agentLoop.test.js dist/test/chatSendPath.test.js dist/test/cyberDisclaimer.test.js` | green |
| Full suite | `npm run compile && node --test dist/test/*.test.js` | 767 tests, 759 pass, 0 fail, 8 skipped |

Acceptance greps:

| Criterion | Required | Actual |
|---|---|---|
| `nearAi.openCyber` in `package.json` | ≥ 2 | 3 (command, activation, menu) |
| `onCommand:nearAi.openCyber` | ≥ 1 | 1 |
| `nearAi.openCyber` in `extension.ts` | ≥ 1 | 1 |
| `retainContextWhenHidden` | ≥ 1 | 1 |
| `CyberWebviewMessage` in `chatBridge.ts` | ≥ 1 | 2, with `ChatWebviewMessage` untouched |
| `<script>` inline logic in the page module | 0 | 0 |
| client `acquireVsCodeApi`/`textContent` | ≥ 2 | 11 |
| collapsible reasoning | ≥ 1 | 1 |
| `installOffer` in the page | ≥ 1 | 3 |
| per-engagement model key | named | `modelKeyFor` |
| `intrusiveEngagement` in `cyberRun.ts` | ≥ 1 | 1 |
| view/title entry scoped to the chat view | yes | true |

## Deviations from the plan

**1. [Rule 3 — blocking] Sending a run to the *chat conversation* was not wired; the panel drives the engine directly.**
The plan wanted the Run button to reach `AgentConversation.send` with `request.cyber` set. `AgentConversation.send` needs a `NearAiClient`, a conversation session, idempotency keys, and a live webview to stream into; none of that is reachable from a panel test, and the chat webview's own dispatcher owns the transcript. What shipped instead: the panel calls `startCyberRun` (25-05) directly through `panelRunStarter`, and `AgentTurnRequest.cyber` + the `toolsFor` branch exist so a chat-initiated cyber turn attaches the same tools. **This is a real gap against D-02's "the Run button hands off to the existing chat path"**: approvals ride the panel's own seam rather than the chat approval card, and the transcript lands in the timeline rather than the chat history. Recorded for follow-up.

**2. [Rule 2 — missing critical functionality] Added `src/services/cyberService.ts` and `src/services/cyberHandoff.ts`.**
The plan named `chat.ts` and `agentSession.ts` as the wiring points. `chat.ts` is the conversation's send path and could not host a run stack without the client/session plumbing above, so the host-side assembly lives in its own modules and `extension.ts` stays a registry (the ARCHITECTURE.md anti-pattern note).

**3. [Rule 1 — bug] The run handler created its `AbortController` after an `await`.**
A Stop message arriving immediately after Run found `state.controller` undefined and did nothing. The controller is now created before the first await.

**4. [Rule 1 — bug] `install-tool` only consulted the injected `tools()` provider.**
A provider that returned no command for a catalogued tool silently did nothing. It now falls back to `installOffer(tool)`, so the catalogue remains the single source of install commands.

**5. [Rule 1 — bug] Four of my own test assertions were wrong.**
`#target-picker` is not an id in the shell (it is `#target-section`); the UK region code is `uk`, not `gb`; `textVersion` is a dated statement version, not `v1`; and the stop test raced because my `send` helper awaits the listener. All four were test-side; the code needed only changes 3 and 4.

## Outstanding: Task 4 (human verify)

The plan's final task is a `checkpoint:human-verify`, and it is **not** satisfied. The owner must still:

1. Launch the extension (F5 or a vsix) and run `NEAR AI: Cybersecurity` in a folder **without** `.planning/.near-ai` — this is the one behaviour the new activation event exists for and no automated test covers it.
2. Walk each of the five target kinds and confirm the scope preview appears before anything is sent.
3. Review the twelve regional statements for wording (all twelve are `ownerReview: 'pending-owner-review'`; a release check can grep for that value).
4. Run a defensive scan against `node test/fixtures/cyber/vulnerable/server.js` and confirm the timeline, findings, and the approval card for intrusive steps.
5. Check legibility in Light, Dark, and High Contrast, including the public-sector red warning rendering as red **and** as text.
6. Press Stop mid-run and confirm the ledger records a stopped run.

Until that is done, this plan's self-check cannot be PASSED and phase 25 cannot be considered releasable.

## Issues encountered

- `npm run compile` is required before a full run (`scripts/vendor-libs.mjs` vendors `vendor/pdfjs`); without it eight document/graphics tests fail. This is the third plan to hit it, so 25-VALIDATION's release checklist should state it explicitly.
- Rewriting `package.json` with `JSON.parse`/`JSON.stringify` converted `\u2026` escapes to literal `…` characters. The file parses and `vsce` accepts it, but it is diff noise; a hand edit would have avoided it.

## Self-check: PASSED (automated), hands-on review still recommended

Tasks 1–3 are complete and proven: 22/22 plan tests, `npm run lint` exits 0, the full suite is 759 pass / 0 fail, every Task 1–3 acceptance grep meets its threshold, and no dependency was added. Task 4 is a human-verify checkpoint and remains unsigned, so the plan is not finished. Two follow-ups are recorded above: the chat-conversation handoff (deviation 1) and the twelve region texts' owner review.
