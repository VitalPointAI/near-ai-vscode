---
status: diagnosed
phase: 61-invitations-joining-removal-near-org-and-key-integration
source: [61-VERIFICATION.md human_verification, owner hands-on session on the 0.6.0 team preview build]
started: 2026-11-03T19:30:00Z
updated: 2026-11-03T21:00:00Z
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

### 7. Real NEAR organization check (key cap, removal, revoke) and opt-in live tests
expected: see 61-VERIFICATION.md human_verification 1 and 2.
result: blocked
blocked_by: prior-phase
reason: stopped before reaching it; resume after the fix pass.

## Summary

total: 8
passed: 0
issues: 7
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
