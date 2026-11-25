# Experience map: one front door, one settings place, one trust line

Part of the coherence review (`REVIEW.md` in this folder). Written 2026-11-20 against `origin/main` at 15bc560c. Counts below were taken from `package.json` on that commit: 84 commands, 51 settings.

## 1. One front door: Get Started

**NEAR AI: Get Started** is the guided setup (Phase 32.1). It keeps the `nearAi.setup` command id. Every other setup path folds into it, either as a step the guide runs or as an item on the checklist the guide leaves behind (GUIDE 10). Old command ids stay as hidden aliases that open Get Started at the right step, for two minor releases.

| Existing path (main or design) | Becomes |
|---|---|
| Set Up, which opens "Near AI: First Project" (`src/services/onboarding.ts`) | Removed. Its cards become the checklist after landing |
| Chat setup card "Connect NEAR AI to start" (`media/chat/setup.js`) | One button: Get Started |
| Project Setup… menu (`src/services/setupSteps.ts`) | The checklist, keeping the `registerSetupStep` registry as the guide's step registry |
| Set Up Project Team… | The software step of the guide; also offered in Team Studio |
| Set Up a Staff Team (`src/services/staffSetupCommand.ts`) | The staff step of the guide: question 1 gives the section, the policy gives doctrine and level, and only echelon or variant is asked. Its "Where may the members' models run?" question is removed: the label and the policy decide |
| Project discovery `locality` and `riskLevel` (`src/services/projectInitialization.ts`) | `locality` removed (label and policy decide); `riskLevel` stays only inside the team recommendation |
| New, Select, Use a Saved and Remove Profile | The guide's options screen, and Settings > Connections |
| Cohere vault setup (Cohere 10.1), local model manager (Phase 32.2) | Options inside the guide, also in Settings > AI services and models. Adding a vault produces a policy proposal (`POLICY-SCHEMA.md`, section 7) |
| Turn On Project Sync, Give This Project an Online Home, Put This Project's Code Online | Checklist item "My computers" |
| Enable Team Mode, Make This Staff Project Multi-User, Join Staff Project | "Share with people" (owner) and opening an invitation file (joiner). An invitation file opens Get Started already filled in |
| Set Up Web Search, Set Up Research Verifiers, Spending Limits, Manage MCP | Checklist items and Settings sections |
| Data connections (GUIDE 11, Phase 89), data platform policy wizard (DP 1, Phase 93), messaging setup view (Phase 78) | Admin steps of Get Started, each ending on the policy editor |
| Secure development workflow step (Phase 28) | A checklist step registered with the guide |

**Rule for every later phase:** a setup flow is a step or an option registered with the guide (`{ id, title, state(), viability(), run() }`). It never adds a new top-level setup command.

**First-run guarantee:** the guide runs viability and the passport check before landing, and never lands a person on a surface with no allowed model. Under the Western defaults (provenance 6.1 and 8.5) a staff project needs T3 and no shipped passport reaches T3; until an organization passport exists, the staff step offers "exercise on fictional data" only and says why on the options screen. A refusal card is never the first thing a new user sees.

## 2. One settings place, plus Organization rules

**NEAR AI Settings** (rebuild of the Tools page shell) with sections:

1. Connections and AI services
2. Models by job: one table replacing the 11 model settings and `roleModels`, with defaults from the organization (provenance 8.4)
3. Autonomy and approvals
4. Spending
5. My computers and sharing
6. Tools: web search, MCP, verifiers, skills
7. Your organization's rules (read-only for members; opens the policy editor)
8. Advanced: opens VS Code settings filtered to the topic

`contributes.configuration` is split into titled categories matching those sections. Timing knobs move to Advanced: `approvalTimeoutMinutes`, `subagentApprovalWaitSeconds`, `approvalTimeoutsBeforePause`, `modelStallSeconds`, `compactAtTokens`, `maxOutputTokens`, `activity.*`, `history.liveConversations`, `maxParallelWorktrees`, `team.pollSeconds`.

**Organization rules** is the policy editor of `POLICY-SCHEMA.md` section 7, shown to administrators from their Home. Show, Edit, Apply Draft and Reset Policy leave the palette for everyone except as aliases that open it. Reset sits inside it.

## 3. One trust line

One component, used in chat answers, agent cards, product rows, the Staff Room and the status bar popover. Three parts, always in this order:

> **Runs on** NEAR AI private hardware · **Verified** · **Allowed** for Canada, Protected: Protected B by J. Smith's authorization PB-007 until 1 Dec 2027

- **Runs on**: the place, from the glossary, always named, including this computer and your organization's server. Naming the place is what makes the Cohere design's fourth badge state unnecessary: a Standard vault reads "Runs on Cohere vault in Canada (dedicated to your organization) · Not verified: this service cannot be checked", with a neutral icon. A check that failed reads "Check failed: {reason}" with a warning icon. "Cannot be checked here" and "check failed" now look different, which was the real worry behind Cohere D1, and CLAS-08's three proof levels stay as they are (`src/domain/gate/trustBadge.ts`, `TRUST_BADGE_STATES`).
- **Verified**: the three shipped proof levels and their sentences.
- **Allowed**: the label it carried and what let it go: the routing table ("Allowed for Organization: Internal"), an authorization, a risk acceptance or a model approval, plus "(self-signed on this computer)" until the organization layer exists.
- Counts use the same words: the Staff Room's "18 of 18" becomes "18 of 18 agents verified".
- Refusals use the same parts with provenance 6.3's opening: "Nothing was sent. {What}. {Why}. {What you can do}. {Who to ask}." Never a raw rule id; "Who to ask" always in the same place (GUIDE 13, WCAG 3.2.6).

Code: one `TrustFacts` record (label, use, endpoint class, region, verification state, allowing record) in `src/domain/gate/trust.ts`, produced by the decision function and read by the badge, the picker, the record and the status bar (`DEVELOPER-STRUCTURE.md`).

## 4. Role Homes

The chat view's title-bar "Home" opens one page filtered by kind of work:

| Person | Lands on after Get Started | Home shows |
|---|---|---|
| Developer | chat with the project team | chat, team, checklist |
| Staff officer | Staff Room on their section's board (an invitation file opens Get Started at question 1 set to their section) | Staff Room, products awaiting decision, people present |
| Portfolio analyst | Portfolio Room (Phases 39 and 40), data views once they exist (Phases 96 and 97) | Portfolio Room, "Why this label" |
| Administrator | policy editor | Organization rules, People (positions and postings), Your organization's server (status) |
| Everyone | | "Change setup answers" |

## 5. Palette, title bar and status bar

> Amended 2026-11-25 (Phase 48.4, sovereignty status, plan 48.4-01): the sovereignty item is the one second permanent status bar item.

- **Palette.** New context keys (none exist today besides the team-active key in `src/services/team/teamSession.ts`): every staff command gets `when: nearAi.staffProject`; cyber commands `nearAi.cyberProject` (or move to the Cybersecurity page); simulation commands `nearAi.simulationRunning` or the staff context. Approve, Reject and Release stay commands for security reasons (STAFF-UX 4) but only in staff projects. A software project drops from about 70 visible commands to about 35. Command ids move to namespaces (`nearAi.setup.*`, `nearAi.team.*`, `nearAi.staff.*`, `nearAi.policy.*`) with hidden aliases.
- **Chat title bar.** Icons: New Chat, History, Home, Stop (only while a run is going). Overflow: Settings, Status, Help. 17 entries become 7. "Save Continuity Checkpoint" moves to History.
- **Status bar.** One NEAR AI item: label, trust and sync in one short line ("Protected B · Verified · Synced"); clicking opens the trust and sync popover. Emergency stop shows only while a run is going. The separate gate, scan, simulation and Team Mode items fold into the popover.
- **Sovereignty item (Phase 48.4).** The one second permanent status bar item, in the Sterling workbench and in the desktop extension, left of the policy item: "Sovereignty: {state}", with the first worst row's short reason when it is not Met. It is never folded into the trust and sync popover, because it is the every-page credibility signal the owner asked for (Q9). Clicking it opens the sovereignty card. In the workbench only one item shows: the desktop extension's item stays hidden when the workbench provides its own.

## 6. Shared patterns

- **Panel titles:** plain nouns, no prefix: Get Started, Settings, Your organization's rules, Team Studio, Run (with a staff layout), Staff Room, Portfolio Room, Agent Activity, Cybersecurity, Compare Models. Brand is "NEAR AI" and "VS Code" everywhere.
- **One run view.** Team Live and the Staff Room show the same run; the Staff Room is the run view's staff layout. Agent Activity stays as history and export. The command reads "Watch the Run".
- **Empty state.** One component for "open a folder first" (13 messages start "Open a project" today, each worded differently): one sentence, one button.
- **Confirmations.** A modal only for something that cannot be undone or that touches the rules. The button says what it does. Every confirmation names what stops working (GUIDE 8.4).
- **Multi-step flows.** One webview stepper (GUIDE 13), not chains of quick picks. Where a quick pick chain stays, its "Step n of m" must be true (the staff setup today shows step 6 for four different questions, `staffSetupCommand.ts`).
- **Two sharing ideas only:** My computers (Project Sync with the recovery code, which also absorbs Add My Other Machine) and Share with people (the replica layer for every project type, as MUS 18.1 already plans for L2).

## 7. Accessibility

GUIDE 13 becomes the house standard for every webview, enforced by the webview kit: native radio groups and buttons, `aria-disabled` with the reason as text, one polite live region per page, focus moved to the heading on step change, meaning never carried by colour alone, reduced motion honoured, every action reachable by keyboard. The kit's tests check each page for these (`DEVELOPER-STRUCTURE.md`, section 2). Focused browser checks run for the guide and the trust line because they carry a security contract; broad visual sweeps stay diagnostic.
