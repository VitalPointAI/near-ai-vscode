---
status: resolved
trigger: "0.6.4 re-test (owner, 2026-11-05), bob step 5: after Join a team -> 'This team has no organization linked...' -> Paste your own key -> key checked, bob's sidebar stays on the Connect screen and never shows he was accepted"
created: 2026-11-05T17:00:00Z
updated: 2026-11-05T21:00:00Z
awaiting: the owner's re-test of step 5 (and the Connect-screen space in PR #7's panel) on the next preview build
---

## Current Focus

hypothesis: CONFIRMED. Two causes in the same path. (a) The join command's own-key path writes a working, selected profile straight into auth-profiles.json and then only restarts the team session; nothing asks the sidebar page for a fresh profile-status, so the page keeps the 'connect' readiness it had before the join. (b) The own key is installed as the team key profile (profile-team-*, "<team> (team key)"), not as the person's own profile.
test: src/test/teamConnectRefresh.test.ts, first two tests (RED)
expecting: fixed when the page gets one refresh-status after the own-key join and the selected profile is not a team profile id
next_action: none in this session (diagnose only). Gap-closure plan 61-32.
bug_class: Bohrbug (deterministic, every own-key join from the Connect screen)

reasoning_checkpoint:
  hypothesis: "bob's Connect screen stays because memberCommands.join (memberCommands.ts:826) ends with restartSession only, and the profile was written by installTeamKey through its own ProfileStore (join.ts:322), so no profile-status reaches the page; readiness.js keeps 'connect'"
  confirming_evidence:
    - "bob's auth-profiles.json: profile-team-8c2f37d697 valid and selected at 14:52:25; readiness.js welcomeState maps that to 'ready', so only a missing profile-status explains the Connect screen"
    - "code-server logs: bob's first window (exthost29, 14:51-15:24) logged no model load after the join; after his reload at 15:24:44 (exthost31) the chat loaded the model catalog with the same profile within 2 s"
    - "RED: the page attached to the Team section host gets only team-state after the join, never {host-request refresh-status}"
  falsification_test: "if a refresh-status (or profile-status) reached the page after the join and the screen still stayed, the readiness rule or the page would be at fault; the RED test shows none is sent"
  fix_rationale: "ask the page for a fresh profile status whenever Team Mode changes the project's profile (own key at join, saved profile at join already does through sidebar.refresh, removal's removeTeamKey), and install the own key as the person's own profile"
  blind_spots: "the removal path (removedClient.ts:124 removeTeamKey) has the same shape and was not exercised here; the code-server multi-tab secret loss (item 7) can independently make a selected profile lose its key"
  candidate_causes:
    - "code: no refresh-status after the own-key install (memberCommands.ts:826, join.ts:322)"
    - "code/data: own key stored as a team key profile (join.ts:322 -> teamKeyProfile.ts:136-139)"
    - "environment: code-server secret storage per browser profile (ruled out: key present, the reload worked)"
  and_gate: "no for the stuck screen (the missing refresh alone explains it); the team-key storage is a separate defect that does not cause the stuck screen but makes the stored profile wrong"

## Symptoms

expected: "Paste your own key: the key is checked and the chat appears" (RETEST.md step 5); the own key becomes bob's own profile, selected for the project, and the Connect screen gives way to the chat and the Team section without a reload (61-30)
actual: the key is checked, then the sidebar stays on "Connect NEAR AI to start ... Scratch Team has no organization linked, so each person uses their own key. Set up a new profile with your key or use a saved profile." It never shows that alice confirmed him.
errors: none shown
reproduction: code-server 4.144, 0.6.4 preview, Brave profile "Bob test", folder team-check-3/bob (a copy made before the team existed); Connect screen -> Join a team -> paste invite -> name Bob -> Paste your own key -> paste a valid NEAR AI key
started: 0.6.4 preview (first build with 61-30's own-key pick on the Connect screen)

## Eliminated

- hypothesis: "the Connect readiness rule does not count a team-key profile as a working profile"
  evidence: media/chat/readiness.js:20-27 and media/chat/setup.js welcomeState read only activeProfileId and validation.status; no rule looks at the profile id prefix or the (team key) name. bob's auth-profiles.json has active.profileId = profile-team-8c2f37d697 with validation.status 'valid', which welcomeState maps to 'ready'. A fresh profile-status would have shown the chat (and did, after bob's reload).
  timestamp: 2026-11-05T16:40:00Z
- hypothesis: "the profile was saved but not selected (activeProfileId unset)"
  evidence: bob/.planning/.near-ai/auth-profiles.json has "active":{"profileId":"profile-team-8c2f37d697","selectedAt":"2026-11-05T14:52:25.942Z"}; the file stores the selection under "active", not "activeProfileId" (exportMetadata maps it). The profile is selected and valid.
  timestamp: 2026-11-05T16:40:00Z
- hypothesis: "the key never reached this browser's secret storage (code-server per-profile storage), so the profile does not work"
  evidence: after bob's window reloaded at 15:24:44 (code-server remoteagent.log; exthost31), the NEAR AI channel shows the model catalog request at 15:24:47 with that profile (the pricing endpoint's 501 line), so the key was there and worked.
  timestamp: 2026-11-05T18:10:00Z

## Evidence

- timestamp: 2026-11-05T16:30:00Z
  checked: /home/aaron/projects/scratch/team-check-3/bob/.planning/.near-ai/auth-profiles.json (read only)
  found: one profile, profileId profile-team-8c2f37d697, displayName "Scratch Team (team key)", organization "Scratch Team", validation valid at 14:52:25.941Z, selected at 14:52:25.942Z. bob's member.joined is at 14:51:44.993Z (audit.json), alice's confirm (member.role-changed) at 14:53:08.338Z.
  implication: the join stored bob's own key as the team-key profile and selected it; the project has a working profile on disk.
- timestamp: 2026-11-05T16:32:00Z
  checked: src/team/join.ts:306-329 installPastedKey
  found: the pasted own key is installed with installTeamKey (src/team/teamKeyProfile.ts:117-152), which configures profile id teamProfileId(teamId) named "<team> (team key)" with organization = team name, through its own ProfileStore instance.
  implication: the own key is stored as a team key profile, not as the person's own profile; and it is written outside the sidebar's profile flow.
- timestamp: 2026-11-05T16:34:00Z
  checked: src/services/team/memberCommands.ts:820-835 (join after joinTeam returns ok)
  found: the only follow-up is deps.restartSession(projectRoot) (line 826) and notices. restartSession (src/services/team/teamCommands.ts:374-380) restarts the session, clears Just me, brings up the board and calls changed(); nothing posts refresh-status or calls the sidebar's refresh(). The Use a saved profile branch does refresh, because nearAi.useSavedProfile ends with sidebar.refresh() (team-preview src/extension.ts:335-341).
  implication: the team section host gets a new team-state (so the Connect group's status switches to the no-organization sentence, which is what the owner saw), but the chat page never gets a new profile-status.
- timestamp: 2026-11-05T16:36:00Z
  checked: who sends profile-status (team-preview src/services/chat.ts:436-441, 479, 674, 832-843; src/services/panelView.ts:55-58; src/services/team/teamSectionHost.ts:148-163)
  found: profile-status is sent on page load, on a refresh-status request from the page, and after a chat attempt with no provider. The only Team Mode path that asks for one is teamSectionHost.keyInstalled (line 154, posting refresh-status at line 158), subscribed to session.onKeyInstalled (line 148), which fires only in TeamSession.installKey (src/services/team/teamSession.ts:810) for a key a lead delivered. There is no watcher on auth-profiles.json.
  implication: the own-key install at join (and any other profile written by Team Mode outside the session) is invisible to the page until a reload.
- timestamp: 2026-11-05T16:38:00Z
  checked: media/chat/team.js:241-250, 61-71 (team-preview)
  found: the Connect group is drawn while readiness.current() is not 'ready'; readiness only changes on a profile-status message. The team-state the host posted after the restart updates only the group's status text.
  implication: matches the owner's screen exactly: Connect panel stays, status switches to "Scratch Team has no organization linked...".
- timestamp: 2026-11-05T16:39:00Z
  checked: consequences of storing an own key as a team key profile (team-preview)
  found: src/services/profileIndex.ts:58-62 leaves profile-team-* out of the saved-profile list (bob cannot reuse his own key in another project); src/team/removedClient.ts:124 removeTeamKey deletes that profile and its key when bob is removed; src/services/providerCache.ts:28-29 tags its spend as 'team'; a later lead-delivered team key (if the team links an organization) is installed under the same profile id and overwrites bob's own key with no previousProfileId kept (teamKeyProfile.ts:143-146 skips previous === profileId). src/test/teamJoinCommand.test.ts:349 pins the team profile id for the own key ('the checked key is this project's profile'), so 61-30 kept this on purpose ("Paste your own key keeps today's masked input and check").
  implication: a second, separate defect in the same path: the own key should be the person's own profile. The fix changes that assertion (a behaviour change the owner asked for, not a weakened test).
- timestamp: 2026-11-05T18:05:00Z
  checked: code-server logs (/home/aaron/projects/services/code-server/data/share/logs/20261104T105001)
  found: bob's first window exthost29 (14:51:21 to 15:24:44): "NEAR AI Team" channel ends with the join lines; "NEAR AI" channel is empty (no model or provider work after the join). bob's next window exthost31 (from 15:24:46, after a reload): the "NEAR AI" channel has the model catalog request at 15:24:47.893Z.
  implication: with a fresh profile-status on load, the same profile works at once; the stuck screen is only the missing refresh.
- timestamp: 2026-11-05T18:20:00Z
  checked: RED test src/test/teamConnectRefresh.test.ts (run under the memory cap: node --test dist/test/teamConnectRefresh.test.js)
  found: "Join with Paste your own key: the page is asked for a fresh profile status..." fails: "it got ["team-state"]", 0 !== 1. "...the own key becomes the person's own profile, not the team key profile" fails: "not profile-team-de8fb56825", true !== false.
  implication: both causes reproduced on real git with the real commands and the real Team section host.

## Resolution

root_cause: "(1) src/services/team/memberCommands.ts:826: after joinTeam succeeds the join command only restarts the team session; the own key was written straight into the project's profile file by src/team/join.ts:322 (installTeamKey with its own ProfileStore), and no path asks the sidebar page for a fresh profile-status (the only Team Mode trigger is teamSectionHost.ts:148/154-158 on session.onKeyInstalled, fired only for a lead-delivered key at teamSession.ts:810). The page's readiness (media/chat/readiness.js) stays 'connect' until a reload. (2) src/team/join.ts:322 installs the person's own key with installTeamKey, so it becomes the team key profile profile-team-<hash> named '<team> (team key)' (teamKeyProfile.ts:136-139): left out of the saved-profile list, deleted on removal, tagged as team spend, and overwritten by a later lead-made team key."
fix: "Plan 61-32. (1) The pasted own key becomes the person's own profile: src/team/teamKeyProfile.ts installOwnKey (one check_api_key, then ProfileStore.configure as 'My NEAR AI key', profile id deriveProfileId(projectRoot, 'My NEAR AI key'), organization = the organization id from the check, key bound to the checked address, Buffer zero-filled in finally, no join.json or key.json) replaces installTeamKey in src/team/join.ts installPastedKey. (2) Every Team Mode profile change asks the sidebar once for a fresh profile status: TeamModeHandle.onProfileChanged (src/services/team/teamCommands.ts) is told by the member commands after an own-key join and after the unfinished-join reset (src/services/team/memberCommands.ts profileChanged()); TeamSession.onProfileChanged (src/services/team/teamSession.ts) is told after a delivered team key is installed and after the clean-up of the person's own removal; the Team section host (src/services/team/teamSectionHost.ts) follows both and posts {type:'host-request', payload:{type:'refresh-status'}} once per change, then refreshes. The join message now ends 'Your NEAR AI key is now this project's profile.' (3) Connect-screen spacing (UAT item 5): media/chat/chat.css rules for #welcome-connect .team-connect (12px above, 10px padding, a thin top line in the panel border colour), .team-connect-actions (wrapping flex, gap 6px 10px as PR #7's row) and the status margins; media/chat/team.js reports gapAbovePx in the probe facts."
verification: "Under the memory cap: Task 1 set (teamConnectRefresh, teamJoin, teamJoinCommand, teamMemberCommands, teamSectionHost, teamAskToJoin, teamJoinRequest) 125/125 pass, both RED tests of 5297b2d green with teamConnectRefresh.test.ts unchanged; Task 2 set (teamOwnKeyProfile, teamConnectRefresh, teamSectionHost, teamRemove, teamKeyScope, teamFlow, teamSessionMembers, teamConfirm, profileIndex, teamAskToJoin) 126/126 pass; Task 3 set (teamSectionPage, teamPlainLanguage) 44/44 pass; the invite launch (NEAR_AI_E2E_ONLY=invite, xvfb-run, WAYLAND_DISPLAY, XDG_SESSION_TYPE and DISPLAY unset) 25/25 pass, including the team-join window's gapAbovePx >= 10 check. Awaiting the owner's re-test in code-server on the next preview build (step 5, and the space in PR #7's real panel)."
files_changed: [src/team/teamKeyProfile.ts, src/team/join.ts, src/services/team/memberCommands.ts, src/services/team/teamCommands.ts, src/services/team/teamSession.ts, src/services/team/teamSectionHost.ts, media/chat/chat.css, media/chat/team.js, src/test/teamJoin.test.ts, src/test/teamJoinCommand.test.ts, src/test/teamFlow.test.ts, src/test/teamSectionHost.test.ts, src/test/teamOwnKeyProfile.test.ts, src/test/teamSectionPage.test.ts, src/test/e2e/suite.ts]
correct_behaviour: "Per 61-30 and the owner (2026-11-05): Paste your own key makes the key the person's own profile (a normal profile id, a plain name such as 'My NEAR AI key', organization from the key check), selected for this project and recorded in the saved-profile list; the sidebar is asked for a fresh profile status at once, so the Connect screen gives way to the chat and the Team section (Members, board) without a reload. The same refresh follows every other Team Mode profile change (lead-delivered key already does; removal's removeTeamKey and the unfinished-join reset should too)."
red_commit: 5297b2d
red_tests: ["src/test/teamConnectRefresh.test.ts: Join with Paste your own key: the page is asked for a fresh profile status once the key works, so the Connect screen gives way to the chat", "src/test/teamConnectRefresh.test.ts: Join with Paste your own key: the own key becomes the person's own profile, not the team key profile"]
test_to_change_with_fix: "src/test/teamJoinCommand.test.ts:349 asserts the own key is teamProfileId(teamId); it must assert the person's own profile instead"
