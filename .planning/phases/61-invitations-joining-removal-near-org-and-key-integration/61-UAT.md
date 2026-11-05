---
status: diagnosed
phase: 61-invitations-joining-removal-near-org-and-key-integration
source: [61-VERIFICATION.md human_verification, owner hands-on session on the 0.6.0 team preview build]
started: 2026-11-03T19:30:00Z
updated: 2026-11-05T19:30:00Z
---

## Current Test

number: none
name: stopped by the owner after issues; fix pass first (owner, 2026-11-03)
awaiting: gap closure

## Tests

Setup: preview VSIX 0.6.0 (Team Mode merged with released 0.4.13), code-server, scratch project `ALuhning/team-check-scratch` (private) with clones `alice` (lead) and `bob` (developer).

### 1. Enable Team Mode in a project with a working NEAR AI key
expected: Team Mode turns on with a plain confirmation.
result: issue
reported: "can't seem to enable team mode because setup isn't complete yet"
severity: major

### 2. Enable Team Mode with a local-only remote (first scratch attempt)
expected: told up front if teammates cannot reach the project's online home.
result: issue
reported: "didn't see any opportunity to copy the invite text/link" (invite was refused in the output channel only: "A local path cannot be shared with a teammate")
severity: major

### 3. Invite a developer and copy the invite
expected: invite completes and shows the invite with a Copy button.
result: issue
reported: "at step 6 after pasting the invite link/code, I'm shown a notification about having to get the project before joining the team - not sure what to do"
severity: blocker

### 4. Join from an existing copy of the project
expected: the invitee joins without git knowledge.
result: issue
reported: same as test 3 (Join said "Get the project" in an existing clone of the same repository)
severity: blocker

### 5. Flow uses buttons, not the command palette
expected: inviting and joining are seamless and easy to follow.
result: issue
reported: "we should properly surface these commands as buttons in the UI instead of having to go to the command palette repeatedly - this team invite/onboarding flow should be seamless and easy to follow."
severity: major

### 6. NEAR organization is understandable
expected: a person understands what linking does.
result: issue
reported: "it's also not clear what these NEAR organizations are..." and "we should just call it the organization, company or whatever. NEAR AI is the model/AI provider - everything else is ours."
severity: major

### 8. With no working profile, only profile setup is offered
expected: one button to set up the profile before anything else happens.
result: issue
reported: "Still seeing this in the chat window when a profile hasn't been set - no profile or setup required should trigger one button to set up the profile before anything else happens." (0.6.1 preview: Team section with Turn on Team Mode / Join a team, plus the welcome cards, planning links and 'No models - set up a profile')
severity: major

### 9. The Team section fits someone working alone
expected: a solo person (with their agent team) is not pushed to "turn on Team Mode"; they can dismiss the team prompt and still know how to invite people later.
result: issue
reported: "the Join Team/Start Team Mode card is persistent at top of the chat window. I think Start Team Mode is a bit odd as even solo developers are still working alongside the software development agent team, so effectively they are part of a team. However, should be a button that signifies it's a solo human developer project they can select to dismiss that card along with some indicator that they can invite others to join them at any time by doing X."
severity: major

### 7. Real NEAR organization check (key cap, removal, revoke) and opt-in live tests
expected: see 61-VERIFICATION.md human_verification 1 and 2.
result: blocked
blocked_by: prior-phase
reason: stopped before reaching it; resume after the fix pass.

## Summary

total: 9
passed: 0
issues: 8
pending: 0
skipped: 0
blocked: 1

## Gaps

- truth: "Enabling Team Mode in a project with no NEAR AI connection offers to connect right there (run the profile setup) and then continues enabling, instead of telling the person to run another command"
  status: failed
  reason: "User reported: can't seem to enable team mode because setup isn't complete yet"
  severity: major
  test: 1
  root_cause: "src/team/enable.ts:98 refuses with 'not-initialised' when .planning/.near-ai is missing and only names the command NEAR AI: Set Up (which opens the welcome page, not the key setup)"
  artifacts: [src/team/enable.ts, src/services/team/teamCommands.ts]
  missing: ["offer to run the key setup (nearAi.newProfile / configureApiKey) and resume enable"]
  debug_session: ""
- truth: "When the project's online home cannot be reached by teammates (a local path, file://, no remote), the person is told while turning Team Mode on, in plain words, with what to do; it is never discovered only at the first invite or only in the output channel"
  status: failed
  reason: "User reported: didn't see any opportunity to copy the invite text/link (refusal only in the output channel)"
  severity: major
  test: 2
  root_cause: "enable accepts any remote; inviteBundle.cleanRepoUrl refuses local paths at invite time and the message goes to the output channel"
  artifacts: [src/team/enable.ts, src/team/inviteBundle.ts, src/services/team/memberCommands.ts]
  missing: ["remote shareability check at enable time", "visible error with next step at invite time"]
  debug_session: ""
- truth: "Inviting someone first makes sure the team setup (team.json on the main branch and the coordination branch) is shared to the online home, sharing it automatically with consent, so every invite can actually be used"
  status: failed
  reason: "User reported: at step 6 after pasting the invite... notification about having to get the project before joining"
  severity: blocker
  test: 3
  root_cause: "Enable commits team.json on main but the share (push) offer is an easily missed notification; invite only warns about an unpushed NEAR link (teamFileUnpushed) and does not check that team.json itself is on the remote"
  artifacts: [src/services/team/memberCommands.ts, src/team/invite.ts, src/team/enable.ts]
  missing: ["share-before-invite step", "re-openable Share action"]
  debug_session: ""
- truth: "Joining from an existing copy of the same project fetches the latest version itself (fast-forward, no git words) and continues the join; only a different or missing project asks to download it"
  status: failed
  reason: "User reported: notification about having to get the project before joining the team - not sure what to do"
  severity: blocker
  test: 4
  root_cause: "src/team/join.ts:71 returns clone-needed whenever the open folder's team.json is missing or has another teamId, without checking whether the folder is a clone of bundle.repo that is simply behind"
  artifacts: [src/team/join.ts, src/services/team/memberCommands.ts]
  missing: ["same-repository detection (normalised remote URL)", "fetch + fast-forward of the main branch when clean", "plain message when the copy has local changes"]
  debug_session: ""
- truth: "Team actions are buttons in the NEAR AI sidebar: a Team section shows the next action (Turn on Team Mode, Invite someone, Join a team, Members, Open board, Share when something is not shared yet), so no step needs the command palette"
  status: failed
  reason: "User reported: we should properly surface these commands as buttons in the UI instead of having to go to the command palette repeatedly"
  severity: major
  test: 5
  root_cause: "Team actions exist only as palette commands; the sidebar has no team section"
  artifacts: [src/services/panelView.ts, media/chat/*, src/services/team/*]
  missing: ["Team section with state-driven buttons", "guided invite and join steps"]
  debug_session: ""
- truth: "The paying account is called 'your organization' everywhere (never 'NEAR organization'), with a one-line plain explanation of what linking does (each person gets a spending limit, paid from one place) and the choice 'Link now' or 'Not now, everyone uses their own key'"
  status: failed
  reason: "User reported: it's also not clear what these NEAR organizations are... we should just call it the organization, company or whatever"
  severity: major
  test: 6
  root_cause: "UI text names 'NEAR organization' and never explains it"
  artifacts: [src/services/team/memberCommands.ts, src/team/join.ts, package.json]
  missing: ["renamed command titles and messages", "one-line explanation", "'NEAR organization' added to the plain-language banned-term test"]
  debug_session: ""
- truth: "While the project has no working NEAR AI profile (none, or the selected one needs its key re-checked, or no folder is open), the sidebar shows only the profile setup: the Team section, welcome cards and planning-file links are hidden; the Team section and the 0.4.14 Connect NEAR AI panel (PR #7) use the same profile rule so they never disagree"
  status: failed
  reason: "User reported: no profile or setup required should trigger one button to set up the profile before anything else happens"
  severity: major
  test: 8
  root_cause: "teamSectionHost/teamSection model ignore profile state; the Connect panel from PR #7 is not on this branch (Team Mode is based on 0.4.13)"
  artifacts: [src/services/team/teamSectionHost.ts, src/domain/team/teamSection.ts, media/chat/team.js, src/services/panelView.ts]
  missing: ["profile-gated Team section", "shared profile-readiness rule with PR #7 welcomeState after main is merged in"]
  debug_session: ""
- truth: "No 'Team Mode' wording on screen: with no team, the Team section offers 'Invite someone' (turns on the team layer automatically, then invites), 'Join a team' and 'Just me for now'; 'Just me for now' dismisses the card for this project and leaves one quiet line on the empty chat ('Working solo with your agents. Invite people any time.') whose link starts the invite; 'Invite people' is also a Project Setup step; once people have joined, the section shows only Members, the board summary and Open board"
  status: failed
  reason: "User reported: the Join Team/Start Team Mode card is persistent at top of the chat window... should be a button that signifies it's a solo human developer project... indicator that they can invite others at any time"
  severity: major
  test: 9
  root_cause: "teamSection model's no-team state shows Turn on Team Mode / Join a team with no dismiss; wording predates the owner's no-solo-mode principle"
  artifacts: [src/domain/team/teamSection.ts, src/domain/team/teamSectionText.ts, media/chat/team.js, src/services/team/teamSectionHost.ts, src/services/team/teamCommands.ts]
  missing: ["Just me for now dismiss (per project, workspaceState)", "quiet invite-later line on the empty chat", "Invite someone that enables then invites in one flow", "Invite people as a setup step once main (PR #7 registry) is merged"]
  debug_session: ""

## Re-test on 0.6.3 (owner, 2026-11-04)

Passed: Connect-first screen, Working with your agents, Just me for now and the quiet line, Invite someone in one flow, Join from an existing copy, confirm from Members, no "Team Mode"/"NEAR organization" wording. Issues:
- truth: "A person can join a team without setting up their own NEAR AI profile: the Connect screen offers Join a team; when the team has linked its organization, joining delivers the team key (with the lead's spending limit) as their profile automatically; when it has not, the screen says plainly that they need their own key or a saved profile. A person without an invite can Ask to join: a short request they send to the lead, who accepts it in Members (an invite in reverse); once accepted they are on the team and receive the team key if there is one. A person can also choose a saved profile they set up before (another project) instead of entering a key again."
  status: failed
  reason: "User reported (0.6.3, step 3): we need to cater to a situation where someone doesn't want to setup their own profile and instead wants to join a team that already has a profile... ask for an invite to the team and if accepted, receive the profile information as well as automatically become part of the team. Alternatively, they may be wanting to use an existing profile they've setup before."
  severity: major
  test: 10
  root_cause: "Connect panel offers only own-key setup; join requires a working profile; no join-request flow; profiles are per project with no reuse"
  artifacts: [media/chat/readiness.js, media/chat/setup.js, src/services/team/memberCommands.ts, src/team/join.ts, src/team/teamKeyProfile.ts, src/services/profileStore.ts]
  missing: ["Join a team on the Connect screen", "team key becomes the profile on join (org-linked)", "Ask to join request/accept flow", "use a saved profile from another project"]
  debug_session: ""

## Re-test on 0.6.4 (owner, 2026-11-05)

Setup: preview 0.6.4 (Team Mode feat/team-fix-pass merged with main, team-preview 8777d43), code-server 4.144 in Brave, private scratch repo `ALuhning/team-check-scratch-3` with copies alice, bob, carol and alice-second (all made before the team existed), each person in a separate Brave profile; no organization linked. Script: /home/aaron/projects/scratch/team-check-3/RETEST.md. In this setup the three people share one code-server, so one globalStorage (team storage, coordination mirror, saved-profile list); only secrets are per browser profile.

Passed: Connect screen (step 1); alice Set up a new profile (2); Invite someone, with no email question for the owner (3); bob Join a team with no "Get the project" (4); alice Confirm (6); carol Ask to join and Show my request (7); alice Accept a request (8); carol confirmed automatically on alice's side (9, alice); Use a saved profile in alice-second (22). Issues:
- truth: "Join a team on a team without an organization, Paste your own key: once NEAR AI has checked the key, the sidebar gives way to the chat and the Team section at once, without a reload, and later changes (a lead confirming the person) show there"
  status: failed
  reason: "User reported (0.6.4, step 5): the key is checked, then bob's sidebar stays on 'Connect NEAR AI to start ... Scratch Team has no organization linked, so each person uses their own key. Set up a new profile with your key or use a saved profile.' and never shows that he was accepted (alice confirmed him)"
  severity: major
  test: 10
  root_cause: "src/services/team/memberCommands.ts:826: after joinTeam succeeds the join command only restarts the team session. The own key was written straight into the project's profile file by src/team/join.ts:322 (installTeamKey, its own ProfileStore), and nothing asks the sidebar page for a fresh profile-status: the only Team Mode trigger is src/services/team/teamSectionHost.ts:148/154-158 on session.onKeyInstalled, fired only for a lead-delivered key (src/services/team/teamSession.ts:810). The page's readiness (media/chat/readiness.js) stays 'connect' until a reload. bob's profile is valid and selected on disk; after his window reloaded at 15:24:44 the chat loaded models at once (code-server exthost31). The readiness rule does count a team-key profile (eliminated)."
  artifacts: [src/services/team/memberCommands.ts, src/team/join.ts, src/services/team/teamSectionHost.ts, src/services/team/teamCommands.ts, media/chat/readiness.js, src/test/teamConnectRefresh.test.ts]
  missing: ["one refresh-status to the sidebar page after every Team Mode profile change outside the session's key-installed event: own key at join (and, same shape, removal's removeTeamKey and the unfinished-join reset)", "RED src/test/teamConnectRefresh.test.ts 'Join with Paste your own key: the page is asked for a fresh profile status...' (5297b2d) made green"]
  debug_session: ".planning/debug/join-own-key-connect-stuck.md"
- truth: "The key a person pastes when joining a team without an organization becomes that person's own profile (a normal profile, in the saved-profile list for their other projects, kept when they leave the team, counted as personal spend), not the team key profile"
  status: failed
  reason: "Found while diagnosing step 5: bob's own key is stored as 'Scratch Team (team key)' (profile-team-8c2f37d697, organization 'Scratch Team')"
  severity: major
  test: 10
  root_cause: "src/team/join.ts:322 installs the pasted own key with installTeamKey (src/team/teamKeyProfile.ts:117-152), which names it '<team> (team key)' under teamProfileId(teamId) (teamKeyProfile.ts:136-139). Consequences: src/services/profileIndex.ts:58-62 leaves it out of the saved-profile list; src/team/removedClient.ts:124 (removeTeamKey) deletes it and its key when the person is removed; src/services/providerCache.ts:28-29 tags its spend as team spend; a later lead-made team key (if the team links an organization) is installed under the same id and replaces the person's own key with no earlier profile kept (teamKeyProfile.ts:143-146). 61-30 kept this on purpose ('keeps today's masked input and check'); src/test/teamJoinCommand.test.ts:349 pins it."
  artifacts: [src/team/join.ts, src/team/teamKeyProfile.ts, src/services/profileStore.ts, src/services/profileIndex.ts, src/test/teamJoinCommand.test.ts, src/test/teamConnectRefresh.test.ts]
  missing: ["own key installed through ProfileStore as a personal profile (plain name such as 'My NEAR AI key', organization from the key check), selected for the project and recorded in the saved-profile list", "teamJoinCommand.test.ts:349 changed to assert the personal profile (behaviour change asked by the owner, not a weakened test)", "RED src/test/teamConnectRefresh.test.ts 'Join with Paste your own key: the own key becomes the person's own profile...' (5297b2d) made green"]
  debug_session: ".planning/debug/join-own-key-connect-stuck.md"
- truth: "After the automatic join that follows an accepted request, the requester's Connect screen changes by itself to the next step: on a team without an organization, the sentence that each person uses their own key with Set up a new profile and Use a saved profile (as bob's screen shows after Join)"
  status: failed
  reason: "User reported (0.6.4, step 9): carol gets the notification that she is on Scratch Team, but her chat/Connect screen does not change"
  severity: major
  test: 10
  root_cause: "Not confirmed. Ruled out with evidence: the model built from the real log for carol is right (ownKeyStatus at every log length after her join); the host refreshes by itself after the automatic join (GREEN src/test/teamConnectRefresh.test.ts, real git and commands, no explicit refresh); the page redraws the Connect group inside PR #7's panel for that model (fake DOM with the preview's team.js). Carol's code-server channel shows the join and the restart finished with no error. Ranked suspects for the real window: S1 a Team section refresh that throws or never settles in the real extension host, invisible because src/services/team/teamSectionHost.ts:296 swallows every refresh failure and refreshes share one chain (285-299); S2 the code-server page not drawing a team-state that arrived while its Brave window was in the background; S3 the one-server test sharing one mirror and one globalStorage between alice, bob and carol."
  artifacts: [src/services/team/teamSectionHost.ts, src/services/team/memberCommands.ts, src/services/team/teamSession.ts, src/services/team/teamCommands.ts, media/chat/team.js, src/test/teamConnectRefresh.test.ts]
  missing: ["real-window reproduction in code-server (two browser profiles, Ask to join, accept, automatic join) with the extension-host probe recording each team-state the page gets and draws", "a channel line when a Team section refresh fails or takes more than a few seconds (once per reason)", "the fix the repro points to, with a real-window regression check"]
  debug_session: ".planning/debug/ask-join-connect-no-refresh.md"
- truth: "On the Connect screen the team group (status sentence and Join a team, Ask to join, Use a saved profile) sits clearly apart from PR #7's Set up a new profile row, with vertical space between them"
  status: failed
  reason: "User reported (0.6.4): add vertical space between the Connect panel's 'Set up a new profile' button and the team group below it"
  severity: cosmetic
  test: 8
  root_cause: "media/chat/team.js:260-271 (buildConnect) makes div.team-connect (p.team-connect-status and div.team-connect-actions) and team.js:296 appends it as the last child of PR #7's #welcome-connect, right after .welcome-connect-actions; media/chat/chat.css styles only .welcome-connect-actions (line 191 in the merged preview) and has no rule for .team-connect, so the group gets no top margin"
  artifacts: [media/chat/chat.css, media/chat/team.js]
  missing: ["a .team-connect rule (top margin about 12px, optionally a top border in the panel's border colour), and spacing for .team-connect-status and .team-connect-actions matching .welcome-connect-actions", "a layout-probe or screenshot check of the Connect panel with the team group"]
  debug_session: ""
- truth: "Use a saved profile offers only profiles whose key this browser or computer actually holds; a listed profile whose key is not here is labelled ('Its key is not on this computer or browser') and not offered as usable"
  status: failed
  reason: "User reported (0.6.4): the list offers a profile whose key is not in this browser's storage (it reads the project file's last check status, not key presence), then fails with 'The saved profile this one uses was removed'"
  severity: minor
  test: 10
  root_cause: "src/services/profileIndex.ts:80-83 listSavedProfiles returns every entry of the computer-wide list (VS Code globalState, which code-server keeps on the server, shared by every browser profile) and checkText (profileIndex.ts:169-173) labels it from the last check status in the source project's file. Key presence is checked only after the pick, in ProfileStore (src/services/profileStore.ts:270, hasStoredKey at :298), which then says SOURCE_REMOVED (:28) although the key was never removed, it lives in another browser's storage"
  artifacts: [src/services/profileIndex.ts, src/services/profileStore.ts, src/extension.ts]
  missing: ["check each entry's key in SecretStorage (by scope, never reading it out) before listing", "label entries without a key here and leave them out of the usable choices", "a failure message that says the key is not on this computer or browser instead of 'was removed'"]
  debug_session: ""
- truth: "After upgrading, Use a saved profile explains an empty list: profiles from other projects appear once each project has been opened with this version"
  status: failed
  reason: "User reported (0.6.4): after upgrading, the list is empty until each older project is opened once with the new version; the empty-list message should say so"
  severity: minor
  test: 10
  root_cause: "The list is written only by ProfileStore when a project's profiles are read or written (src/services/profileStore.ts:333-356 recordIndex), so projects not opened since the upgrade are not in it; the empty message (src/services/profileIndex.ts:141) says only that there are no saved profiles yet"
  artifacts: [src/services/profileIndex.ts, src/services/profileStore.ts]
  missing: ["empty-list message: 'Profiles from your other projects appear here after you open each of those projects once with this version of NEAR AI.' with Set up a new profile"]
  debug_session: ""
- truth: "Known limitation, recorded: moving or renaming a project folder keeps its saved key reachable (or the person is told plainly and offered to reconnect it)"
  status: failed
  reason: "User reported (0.6.4): moving or renaming a project folder cuts it off from its saved key because the project id is a hash of the path"
  severity: minor
  test: 10
  root_cause: "src/domain/auth.ts:102-105 createProjectCredentialScope derives the project id from the project identity, which ProfileStore sets to the workspace folder path (src/services/profileStore.ts:96-97); keys are stored under that scope, so a moved folder gets a new id and its profiles' keys are no longer found, and its saved-profile list entries keep the old id"
  artifacts: [src/domain/auth.ts, src/services/profileStore.ts, src/services/profileIndex.ts]
  missing: ["proposal: a stable project id kept in .planning/.near-ai/auth-profiles.json (its projectId field already exists) and used as the identity when present, with the path hash only for a new project; on a mismatch between the file's projectId and the path hash, offer 'This project moved. Reconnect its saved key?' which re-links the old scope (by reference, never reading the key out)", "until then, a README line under the profile section"]
  debug_session: ""
- truth: "In a web UI (code-server and other browser-based VS Code) the person is warned that several tabs of the same browser profile can lose each other's saved keys (NEAR AI keys, team keys, the team device key), and the README's code-server tips say to keep one tab per browser profile"
  status: failed
  reason: "User reported (0.6.4): code-server's LocalStorageSecretStorageProvider (vs/code/browser/workbench/workbench.js, storageKey 'secrets.provider') loads the whole secret bundle once per tab and writes its in-memory copy back on every set or delete, so two code-server tabs in one browser profile overwrite each other's secrets. Not ours to fix; the extension should warn and the README should say so."
  severity: major
  test: 11
  root_cause: "Upstream code-server behaviour (whole-bundle write-back per tab). The extension does not detect a web UI for this (vscode.env.uiKind is used only for sign-in and the proxy tip: src/extension.ts:125 here, :159 in the merged preview; src/services/nearSignIn.ts:48) and the README code-server notes (merged preview README.md around lines 568-580) cover runs and proxy support only. Losing the team device key leaves the computer unable to sign team events until it is re-invited."
  artifacts: [src/extension.ts, README.md, src/services/team/teamSession.ts]
  missing: ["a one-time notice when vscode.env.uiKind is Web: 'In a browser, keep one tab of this editor per browser profile. Two tabs in the same profile can overwrite each other's saved keys.' with Don't show again", "README code-server tip with the same rule and what to do after a lost key (set up the profile again; ask the lead to re-invite for a lost team device key)", "optional: a cheap self-check that a key just stored can still be read back on the next start, with a plain message when it cannot"]
  debug_session: ""
