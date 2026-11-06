---
status: investigating
trigger: "0.6.4 re-test (owner, 2026-11-05), carol step 9: after the automatic join (her request accepted) she gets a notification that she is on Scratch Team, but her chat/Connect screen does not change; it should show the no-organization team status (own key or saved profile), as bob's does"
created: 2026-11-05T17:00:00Z
updated: 2026-11-05T19:30:00Z
---

## Current Focus

hypothesis: NOT CONFIRMED. Three layers were checked and each does the right thing on its own: the model built from the real log, the host's automatic refresh after the automatic join (stub, real git, real commands), and the page's redraw of the Connect group (fake DOM, the preview's team.js and readiness.js). The failure is in what only the real code-server window has.
test: next, a real-window reproduction in code-server (two browser profiles, Ask to join -> accept -> automatic join) with the extension-host probe (teamSectionTap facts, NEAR_AI_E2E=1) recording every team-state the page receives and what it drew, plus a temporary channel line when a Team section refresh fails or takes longer than a few seconds
expecting: either no team-state reaches carol's page after the join (host side: a refresh that throws or never finishes; see suspect S1), or one arrives and is not drawn (page side, S2)
next_action: gap-closure plan 61-33 starts with that real-window repro; the GREEN host test in src/test/teamConnectRefresh.test.ts stays as the guard for the layer already ruled out
bug_class: Mandelbug (environment-dependent: reproduced only in the owner's code-server run, not in the stub)

## Symptoms

expected: RETEST.md step 9 "carol is on the team, and her Connect screen asks for her own key or a saved profile" (the Connect group's status becomes "Scratch Team has no organization linked, so each person uses their own key. Set up a new profile with your key or use a saved profile.")
actual: the notification "You are on Scratch Team now..." appears; the Connect screen stays as it was before the join
errors: none shown; carol's NEAR AI Team channel (code-server exthost30) has no error line
reproduction: Brave profile "Carol test", folder team-check-3/carol (a copy made before the team existed); Connect screen -> Ask to join -> Copy request; alice accepts in Members; carol waits up to a minute without clicking
started: 0.6.4 preview

## Eliminated

- hypothesis: "the host builds the wrong Connect part for carol after the join (for example still the waiting request, or not on the team)"
  evidence: scratchpad carolmodel.js replays the real shared mirror (163 entries) and builds carol's Team section input exactly as teamSectionHost.teamInput does, at log lengths 157, 158 and 163: carol (mbr-92b10892cca82fb2) is found by her device fingerprint, role observer pending developer, then developer; the model's connect.status is ownKeyStatus('Scratch Team') every time, and boardSummary does not throw.
  timestamp: 2026-11-05T18:40:00Z
- hypothesis: "the host does not refresh the Team section by itself after the automatic join (only button clicks refresh)"
  evidence: src/test/teamConnectRefresh.test.ts 'after the automatic join ...' (GREEN): carol's copy made before the team existed, Ask to join, the owner accepts in Members, carol's next sync joins by itself, and with no host.refresh() after the join the page's last team-state has connect.status === ownKeyStatus(TEAM). Run with production's boardSummary dep too. restartSession's changed() (teamCommands.ts:374-380) and the new session's onStateChange both reach refresh().
  timestamp: 2026-11-05T19:00:00Z
- hypothesis: "the page does not redraw the Connect group when a new team-state arrives inside PR #7's panel"
  evidence: scratchpad carolpage.js with the preview build (team-preview dist, fake DOM, readiness.js + team.js, PR #7's #welcome-connect): after NO_PROFILE and the waiting model the group shows "Your request to join Scratch Team is waiting..." with Show my request and Use a saved profile; after the on-team, not-linked model it shows ownKeyStatus with only Use a saved profile.
  timestamp: 2026-11-05T19:10:00Z

## Evidence

- timestamp: 2026-11-05T16:45:00Z
  checked: carol's project files and the team log (read only)
  found: carol/.planning/.near-ai has team.json (09:56 local) and audit.json, no auth-profiles.json. The shared mirror's log has carol's member.joined at 14:59:01.564Z (lamport 156) and alice's automatic confirm (member.role-changed) at 14:59:07.899Z (lamport 157). accepted-requests.json lists carol.
  implication: the automatic join and the automatic confirm both happened; carol had no profile, so her page was on the Connect screen throughout (correct), and she never set up her profile in step 9.
- timestamp: 2026-11-05T16:47:00Z
  checked: the automatic join path (src/services/team/teamSession.ts:851-883 completeRequest -> runCommand(ASK_TO_JOIN_COMMAND, {complete:true}) -> src/services/team/memberCommands.ts:917-947 runCompletion)
  found: on 'joined' it calls deps.restartSession(projectRoot) (line 939) and then reports "You are on <team> now." restartSession ends with changed(), which the Team section host follows (teamSectionHost.ts:165 handleSubscription -> refresh()).
  implication: the notification proves restartSession returned, so changed() fired.
- timestamp: 2026-11-05T16:50:00Z
  checked: test coverage of the automatic refresh
  found: every teamSectionHost test that crosses a join calls host.refresh() itself after the command (src/test/teamSectionHost.test.ts:566-645); teamAskToJoin.test.ts attaches no host.
  implication: until today nothing checked that the page gets a new team-state by itself after the automatic join (now covered, GREEN).
- timestamp: 2026-11-05T16:52:00Z
  checked: test environment confound
  found: the owner's three people share one code-server, so one globalStorage: team/team-e00e55d0.../ (coordination.git mirror and its file lock, notified.json, accepted-requests.json, invites.json, pin.json) is the same folder for alice, bob and carol. Secrets are per browser profile. Each Brave profile is its own extension host (alice exthost28, bob exthost29, carol exthost30).
  implication: per-computer records are shared between the three windows in this setup; a real team never has that. Kept as a suspect (S3), not proven.
- timestamp: 2026-11-05T18:00:00Z
  checked: code-server logs for carol's window (logs/20261104T105001/exthost30, remoteagent.log)
  found: NEAR AI Team channel: "Your copy of the project was brought up to date." / "This computer is not yet approved..." (the first session, no device key) / "Team sync is running for Scratch Team." twice (old and restarted session) / "You are on Scratch Team now. Your lead confirms you as a developer." / the no-organization and no-key notices. No error, no refusal, no busy-mirror line. The extension host (pid 127229) never exited. All browser connections "reconnected" at 15:14:57 (a drop sometime before that).
  implication: the join and the restart completed in the real host; nothing was logged about the Team section (its refresh failures are not logged at all, see S1).
- timestamp: 2026-11-05T19:00:00Z
  checked: GREEN host-level test src/test/teamConnectRefresh.test.ts (third test) and the page experiment scratchpad carolpage.js
  found: both pass (see Eliminated).
  implication: the defect needs the real window to reproduce.

## Suspects (ranked, to settle with the real-window repro)

- S1 (host, most likely): a Team section refresh that throws or never finishes in the real extension host. Every refresh failure is swallowed with no trace (src/services/team/teamSectionHost.ts:285-299, `.catch(() => undefined)` at line 296), and refreshes run one after another on one chain, so one refresh that never settles (any awaited step in input()/teamInput(), for example VS Code's secret storage read in joinRequestPending, teamCommands.ts:321-336) stops every later team-state for that window. In the stub every await settles.
- S2 (page): the team-state reached the code-server page while its browser window was in the background (the owner switched Brave windows to accept as alice) and was not drawn. Weaker: the notification of the same moment did arrive.
- S3 (environment): the shared globalStorage of this one-server test (all three people on one mirror and one mirror lock) delayed the restarted session's first sync. Weak: the next poll (15 s focused) would have corrected the screen within the minute the owner waited.

- timestamp: 2026-11-06T03:45:00Z
  checked: the stricter VS Code check (61-33 Task 2): the team-ask window's Connect check after the automatic join, with no nudge and no click, bounded at 30 s (commit 8792786)
  found: it passed in 251 ms. The session's own state change reaches the page and the Connect group is redrawn in a real VS Code window.
  implication: the defect is not in the layer a VS Code window has. It is in what code-server adds: a browser frame, a hidden or backgrounded tab, or one server's shared global storage (S3).
- timestamp: 2026-11-06T03:50:00Z
  checked: src/test/e2e/codeServerTeam.ts (commit 8792786): the real packaged extension in code-server, in a real browser, with a listener on the sidebar frame recording every team-state it receives; variants A, B and C
  found: the harness is written and compiles. The runs of variants A, B and C were not completed in this session (each is a heavy run of code-server plus a browser and needs the owner's approval, which was not given while the session was unattended).
  implication: the code-server reproduction is the next step; the harness prints each variant's received team-states and the NEAR AI Team channel lines, which are the trace Task 1 added.

## Resolution

root_cause: ""
fix: ""
verification: ""
files_changed: []
guard_test: "src/test/teamConnectRefresh.test.ts after the automatic join ... (GREEN, commit 5297b2d)"
observability_gap: "src/services/team/teamSectionHost.ts:296 swallows every refresh failure without a channel line, so a stale Team section or Connect group leaves no trace; whatever the cause, the fix plan should log refresh failures (once per reason) and the time a refresh took"
