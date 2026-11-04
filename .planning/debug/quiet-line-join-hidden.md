---
status: awaiting_human_verify
trigger: "Intermittent real-window e2e failure: the invitee's 'Join a team from the quiet line' click (teamSectionTap.probe / media/chat/team.js) sometimes answers 'hidden'; 2 more invitee steps and 3 lead-confirm steps then fail. Failed in 2 of ~4 full runs; passed alone (NEAR_AI_E2E_ONLY=invite) and in a second full run."
created: 2026-11-04T13:28:51Z
updated: 2026-11-04T13:50:00Z
---

## Current Focus

hypothesis: "CONFIRMED: shown() in media/chat/team.js walks parentNode up to the Document node, whose `hidden` property is the Page Visibility flag (document.hidden), not the element hidden attribute. When the invitee's VS Code window is fully covered by the lead's window on the shared xvfb screen, Chromium reports the page as hidden, shown() is false and the click probe answers 'hidden' while the line is drawn."
test: "Done: three full e2e runs in a row, all green (see Resolution.verification)."
expecting: "Owner or orchestrator confirms; the next full e2e runs in other plans stay green on the quiet-line join."
next_action: "None in this session. Fix 4ef4a06 (RED 4d73ca1); resolution recorded in the Phase 62 deferred-items.md."
reasoning_checkpoint:
  hypothesis: "The click probe refuses the quiet line because shown() reads Document.hidden (page visibility of a window covered by the other test window on the shared xvfb screen) as if it were the welcome's hidden attribute."
  confirming_evidence:
    - "dbg-invite1.log: 50/50 invitee probes report visibilityState 'hidden' and document.hidden true while welcome.hidden and transcript.hidden are false and the transcript holds only #welcome; lineShown false; click join -> err hidden."
    - "Both historic failure logs show the line drawn and unchanged 20 s later (a persistent, not transient, state), and the lead's section clicks (which do not use shown()) never fail."
  falsification_test: "With shown() limited to elements, an invite launch where the invitee's page is still reported hidden must pass the join; if it still answers 'hidden', the hypothesis is wrong."
  fix_rationale: "shown() is meant to answer 'is the line inside a hidden element (the welcome during a conversation)'. Stopping the walk at element nodes removes the page-visibility confusion at its source; using the same rule in describeLine makes the facts the test waits on equal to the click's precondition, so the test waits on a real signal."
  blind_spots: "Not verified which X11/Chromium mechanism marks the covered window hidden (empirically it does, for the whole run); a real person's window is not affected by the fix except that a covered window's line stays clickable, which matches the section's buttons."
  candidate_causes:
    - "code: shown() walks to Document and reads Document.hidden (confirmed)"
    - "environment: two test windows with the same default bounds on one xvfb screen without a window manager, so one is fully covered and its page reports hidden (the trigger; varies with launch timing)"
    - "data/state: Just me for now workspaceState leaking between launches (eliminated: fresh user-data dirs per window; justMe true was asserted in the previous step and the line was drawn)"
    - "code: a transcript append hiding #welcome (eliminated by welcomeHidden false, items ['welcome'])"
  and_gate: "yes - the failure needs both the code defect (shown() reading Document.hidden) AND the environment condition (the invitee's window covered by the lead's). Either alone does not fail: without the cover the page is visible; without the defect visibility is ignored. Fixing the code removes the failure regardless of stacking."
bug_class: "Bohrbug in shown() (deterministic given page visibility), triggered by an environment condition (window stacking on the shared hidden screen) that varies by launch timing."

## Symptoms

expected: "After Just me for now, the quiet line's Join a team link can be clicked through the probe, the join runs and the invitee joins as an observer."
actual: "The probe first reads the quiet line with Join a team (soloLine non-null, hidden: true, profile: 'ready'), then the click probe answers error 'hidden'. 20 s later the line is still drawn and the facts are unchanged (persistent, not a short blip)."
errors: "AssertionError [ERR_ASSERTION]: join is drawn in the Team section + 'hidden' - undefined; then 'Timed out after 20000 ms waiting for the Team section to show waiting for a lead. Last seen: {hidden:true, profile:'ready', soloLine:{...join...}}'; team-confirm then times out on Members with 1 waiting."
reproduction: "npm run compile && xvfb-run -a node dist/test/e2e/run.js (6G wrapper); intermittent, 2 of ~4 full runs. Logs: scratchpad full-e2e.log (62-24 first run) and e2e.log (integrated preview)."
started: "Since 61-26 added the quiet line and its shown() check (3a30dcd / 24a27ff)."

## Eliminated

- hypothesis: "Readiness race: the profile-status arrives after the click under load, so the section/line is concealed at click time"
  evidence: "Every failing fact reports profile 'ready' (historic logs and dbg-invite1.log), and the line stays drawn for 20+ s."
  timestamp: 2026-11-04T13:33:00Z

- hypothesis: "#welcome is hidden by chat.js append() (a notice or turn added to the transcript) or replaced when a conversation/view state changes"
  evidence: "dbg-invite1.log: welcome.hidden false and transcript children ['welcome'] on every invitee probe, including the refused click."
  timestamp: 2026-11-04T13:33:00Z

- hypothesis: "Just me for now (workspaceState) leaks from an earlier step or launch"
  evidence: "Each window has its own fresh --user-data-dir; the line is drawn exactly as the Just me step expects; leakage would change what is drawn, not whether a drawn line can be clicked."
  timestamp: 2026-11-04T13:33:00Z

- hypothesis: "The probe answered before the page re-rendered"
  evidence: "The refusal persists over 20 s of probes with identical facts; the line is drawn before and after the click probe."
  timestamp: 2026-11-04T13:33:00Z

## Evidence

- timestamp: 2026-11-04T13:28:51Z
  checked: "Both failing logs (scratchpad full-e2e.log, e2e.log)"
  found: "The failing state persists: the next step's facts 20 s later still show hidden:true, profile:'ready', soloLine with invite and join. So the line is drawn and connected (describeLine needs isConnected) but shown() is false for 20+ s."
  implication: "Not a readiness race (profile is 'ready') and not a re-render race (state stable for 20 s). An ancestor of the line reports hidden === true persistently."

- timestamp: 2026-11-04T13:28:51Z
  checked: "media/chat/team.js probe(): with the line drawn the section is hidden, so a line click goes through `inLine && shown(inLine.button)`, else `section.hidden` gives 'hidden'"
  found: "shown() loops `for (let at = node; at; at = at.parentNode) if (at.hidden === true) return false;` - the chain is button > p.team-solo > section#welcome > main#transcript > body > html > Document. Document.hidden is the Page Visibility API flag."
  implication: "Two candidates: welcome.hidden set by chat.js append() (any transcript item), or document.hidden true (page not visible)."

- timestamp: 2026-11-04T13:28:51Z
  checked: "src/test/e2e/run.ts inviteWindows()"
  found: "The lead's and the invitee's VS Code windows are launched at the same time on one xvfb screen with default size and position; there is no window manager. In the failing logs team-lead's first test finished before team-join's; in the passing logs team-join's finished first."
  implication: "Window stacking (which window covers the other) varies with launch timing, matching the intermittency."

- timestamp: 2026-11-04T13:33:00Z
  checked: "Instrumented invite launch (NEAR_AI_E2E_ONLY=invite, 6G wrapper, xvfb-run -a): every probe logged document.visibilityState, document.hidden, welcome.hidden, transcript.hidden, the transcript's children and shown(line). Log: scratchpad dbg-invite1.log"
  found: "Reproduced on the first try with the exact original signature (3 team-join + 3 team-confirm failures). All 50 team-join probes: vis 'hidden', docHidden true, welcomeHidden false, transcriptHidden false, items ['welcome'], lineShown false. All lead probes: vis 'visible'. Probe 10 'click join' answered err=hidden with the line drawn."
  implication: "H confirmed, H2 refuted: nothing was appended to the transcript and #welcome was never hidden. The only hidden 'ancestor' is the Document itself: the invitee's window was fully covered by the lead's window on the shared hidden screen, so Chromium reports its page as hidden for the whole run, and shown() treats Document.hidden (page visibility) as an element hidden attribute."

- timestamp: 2026-11-04T13:35:00Z
  checked: "RED unit tests in src/test/teamSectionPage.test.ts (fake DOM, h.setVisible(false) sets document.visibilityState 'hidden'), commit 4d73ca1"
  found: "29 tests, 27 pass, 2 fail: the covered-page test failed exactly like the e2e (click join -> facts with error 'hidden', no team-action); the facts/click agreement test failed because soloLine was reported while the welcome was hidden."
  implication: "The defect reproduces deterministically without real windows."

- timestamp: 2026-11-04T13:36:00Z
  checked: "Fix in media/chat/team.js (shown() stops at element nodes; describeLine uses shown()); page tests; two mutants (each half reverted alone)"
  found: "29/29 pass. Mutant 1 (walk to Document again) kills only the covered-page test; mutant 2 (describeLine back to isConnected) kills only the agreement test."
  implication: "Each half of the fix is pinned by its own test."

- timestamp: 2026-11-04T13:38:00Z
  checked: "Instrumented invite launch with the fix (scratchpad dbg-invite2.log)"
  found: "16/16 pass, but this time the invitee was on top: team-join 0/10 probes hidden, team-lead 11/14 hidden. The lead only clicks section buttons (no shown()), so a covered lead never failed."
  implication: "Stacking varies per run (matches the ~50% failure rate). A run with the invitee covered is still needed to falsify; looping the instrumented invite launch (scratchpad qlj-loop.sh)."

- timestamp: 2026-11-04T13:38:00Z
  checked: "Loop of the instrumented invite launch with the fix (scratchpad qlj-loop.out, dbg-loop1..3.log), one at a time under the 6G cap"
  found: "run 1: 16/16, invitee hidden 0/10, lead 10/14; run 2: 16/16, invitee 0/10, lead 11/14; run 3: 16/16, invitee hidden 10/10, lead 0/14. In run 3 probe 10 'click join' answered with no error while vis 'hidden', docHidden true, lineShown true, and the join, the lead-confirm and every later step passed."
  implication: "Falsification test passed: under the exact failing condition (the invitee's page reported hidden for the whole run) the fixed code clicks the line and the flow completes. Before the fix the same condition failed 6 tests (dbg-invite1.log)."

- timestamp: 2026-11-04T13:41:00Z
  checked: "Instrumentation removed (team.js and suite.ts back to the fix only); npm run compile, npm run lint; affected unit files teamSectionPage, sidebarChat, sidebarReadiness, teamSectionHost, teamSectionModel, teamSoloParity, teamPlainLanguage, fakeDom (4G cap)"
  found: "compile 0, lint 0; 102 tests, 101 pass, 0 fail, 1 skipped (the PR #7 parity seam, skipped by design on this branch)."
  implication: "No regression in the sidebar page, host or plain-language checks. Fix committed as 4ef4a06 after RED 4d73ca1."

## Resolution

root_cause: "shown() in media/chat/team.js (the quiet line's click check, 61-26) walked parentNode all the way to the Document and treated Document.hidden (the Page Visibility flag) as a hidden element; AND the invite launch's two windows share one xvfb screen with the same default bounds and no window manager, so one fully covers the other and Chromium reports the covered page as not visible. Whenever the invitee's window was the covered one (it depends on launch timing), its drawn Join a team was refused as 'hidden' for the whole run, while describeLine (isConnected only) still reported the line."
fix: "shown() stops at element nodes (at.nodeType === 1), so only a hidden element (the welcome during a conversation) puts the line away; describeLine uses shown() so the facts report the line exactly when a click on it is accepted (the e2e's wait is then the click's real precondition)."
verification:
  reproduction_before_fix: "dbg-invite1.log: invite launch alone, invitee page hidden 50/50 probes, click join -> 'hidden', 6 failures (the original signature)."
  unit_red_green: "teamSectionPage.test.js 27/29 at RED (4d73ca1), 29/29 at GREEN (4ef4a06)."
  mutation: "Reverting shown() alone fails only the covered-page test; reverting describeLine alone fails only the agreement test."
  falsification_real_window: "dbg-loop3.log: invitee page hidden 10/10 probes, click join accepted, 16/16 pass."
  affected_units: "102 tests, 101 pass, 0 fail, 1 skipped (PR #7 parity seam); npm run lint exit 0."
  full_e2e_x3: "npm run test:e2e under MemoryMax=6G + choom + timeout 1800, one at a time (scratchpad qlj-full1..3.log): run 1 exit 0, 90 pass, 0 fail, 139 s; run 2 exit 0, 90/90, 132 s; run 3 exit 0, 90/90, 133 s (project 8, plain 2, team 7, team-lead 5, team-join 7, team-confirm 4, board 57 each)."
  guardrail_verdict: accepted
files_changed: [media/chat/team.js, src/test/teamSectionPage.test.ts]
oracle_type: "specified (61-26 contract: the line is refused only while the welcome is hidden during a conversation; facts and click use one rule)"
