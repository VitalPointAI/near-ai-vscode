# Codex port audit

Written 2026-11-24 against `origin/main` at `873d9234`, on branch `feat/codex-port`.

**Scope.** The 48 Codex commits that `git cherry` reports as missing from `origin/main` across `docs/assigned-positions-delivery`, `docs/sterling-container-runbook`, `docs/theia-container-release`, `feat/staff-center-workspaces`, `feat/sterling-container-publish`, `feat/theia-chat-connection-state`, `feat/theia-defence-work-area`, `feat/theia-portfolio-room`, `feat/theia-resource-inventory` and `feat/theia-team-studio-preview`. The handover notes are in the main checkout's `.planning/CODEX-TAKEOVER.md` (not on `main`).

**Why `git cherry` over-reports.** Codex worked in `.planning/spikes/theia-team-studio/`. Phase 46 (#187, `5ed892af`) moved that folder to `workbench/` with `git mv`, so no Codex Theia commit has a matching patch on `main` even where its content is there. Each commit below was therefore checked by content: the Codex branch tip's `extension/` tree against `workbench/extension/`, and each non-spike file against `main`.

**What the content check found.** `workbench/extension/src/browser` on `main` matches the tip of `feat/theia-team-studio-preview` (`b968c8b6`) file for file, except five files where `main` is newer (Phase 46 work: verified evidence bundles, build-time documentation, the Outline move that waits for Chat, the shared service helper, glossary copy fixes). Those five differ in one Codex feature only: the SA&A archive download (`4b96f4ad`). Everything else Codex built in the Theia workbench is on `main`. The gaps are in the bundled extension (`src/`, `media/`, `package.json`) and the product name in the documentation.

## Duplicates (same change under two SHAs)

| Kept | Same change | Why two |
|---|---|---|
| `e7fc76c7` | `5d3355f4` | cherry-picked onto the integration branch |
| `1b6007ac` | `50d5861f` | rebased onto the integration branch |
| `6b92f9a2` | `96b05d57` | rebased |
| `83d02529` | `c9ae0347` | rebased |
| `c27b3dd1` | `36321370` | rebased |
| `7e200953` | `fb705874` | rebased |
| `08bfb4a4` | `0595fd16` | the same 33.1 plan package on the integration and plan branches |
| `441c088f` + `7dd8da3e` | `041c9957` (part) | the GHCR workflow, its runbook and its roadmap note |

## Summary

| Commit | Subject | On main | Verdict | Reason |
|---|---|---|---|---|
| `637bff5c` | SovAI commands and official theme logos | Partly: logos and the workbench's SovAI category are on main; the bundled extension's 89 command categories, its `NEAR AI:` references, README, SECURITY.md and docs-site are not | **Port** | Owner direction: the product is Sterling Sovereign AI (SovAI); NEAR AI is only the provider |
| `3b9f071b` | chat and setup provider neutral | No | **Port** | Chat and setup still say "Connect NEAR AI to start" and "Ask NEAR AI" though local models and other services are offered |
| `2239ab49` | Canadian Edition workbench | Fully | Done | Hero, edition class and CSS are in `workbench/` (#173, moved by 46-01) |
| `14d6a842` | animated Get Started page | Fully | Done | #173; `main` has the newer Sterling Sovereign AI heading and the sample agent team button |
| `535dab5a` | native reference tabs and Defence Edition trails | Fully | Done | Documentation and Compliance views; `main` renders guides at build time (Phase 46) |
| `80605812` | compliance evidence visuals and warnings | Fully | Done | `main` also refuses a bundle with no matching verification record |
| `37ac1832` | Sterling navigation order, SA&A command label | Partly | **Port** (with `637bff5c`) | Rail order is on main; the SA&A command's SovAI category comes with the rename |
| `247a8a55` | chat drawer slides in and out | Fully | Done | `slideChat` and `collapseChat` in the welcome module |
| `b42b5fb1` | organize defence work areas, toggle the chat drawer | Partly: work-area pages, `sterling.chat.closeDrawer` and `sterling.workAreas.create` are on main; closing the last conversation does not hide the drawer | **Partly port** | The extension never calls `sterling.chat.closeDrawer`, so closing the last chat tab discards it instead of hiding the drawer |
| `881c0564` | open the shared Staff Center from Planning | Fully | Done (owner question 3) | The Planning page shows "Open Staff Center"; 33.1 D-23 plans "Open Staff Room" |
| `4b96f4ad` | download SA&A archives, keep Outline with editor tools | Partly: Outline move is on main (improved) | **Partly port** | In the browser workbench the SA&A ZIP is saved on the server side and the person has no way to get it |
| `e7fc76c7` | prompt to reconnect when a saved credential is missing | No | **Port** | A cloud profile whose key is gone shows the chat as ready, and the first message fails |
| `f73bc988` | discard setup choices after switching projects | No | **Port** | Project Setup can run a step in the project that was open when the menu was built |
| `c85c42af` | host-neutral proxy advice | No | **Port** | The advice names VS Code and prefixes "NEAR AI:"; the product runs in the Sterling workbench |
| `a5f94f44` | panel commands return no webview handles | Superseded | Superseded | 46-05's `panelCommand` does the same and reports a failure to open (#187) |
| `1b6007ac` | create typed defence work areas | Fully, reviewed | Done | `src/services/workAreaCommands.ts` (#187), with path checks; the `projects` kind was dropped on purpose (owner: "project" only in capability development) |
| `6b92f9a2` | capability development components | Fully | Done | Same file; components are read back on Get Started |
| `83d02529` | local DND and CAF Portfolio Room preview | Fully | Done | `sterling-portfolio-module.ts` (46-01 took it from `docs/theia-container-release`) |
| `46f92358` | native defence work-area landing pages | Fully | Done | `sterling-work-areas-module.ts` |
| `9fe67ddf` | source-scoped inventory references | Fully | Done | Module and `workbench/test/sterling-work-area-resource-links.test.mjs` |
| `c27b3dd1` | scoped local resource inventory picker | Fully | Done | `sterling-resource-inventory-module.ts` |
| `76fc05a4` | link scoped resources to work areas | Fully | Done | `sterling-work-area-resource-links.ts` |
| `7e200953` | reported asset identities and policy references | Fully | Done | Inventory module and common types |
| `b6d98f5e` | defence landing pages and shared inventory | Fully | Done | Area artwork and welcome wiring |
| `9893c76b` | open the active work-area page after creation | Fully | Done | `initializeLayout` and `readActiveWorkArea` |
| `2f4945a8` | synthetic teams through a native backend | Fully | Done | #162, now `team-preview-reader.ts` with the #162 review fixes |
| `84fcc6af` | native Team Studio in a local browser container | Fully | Done | #162; the image is now the hardened UBI image (46-01, 46-03) |
| `7ddff8a7` | local VSIX compatibility workbench | Superseded | Superseded | The release image's `bundled-plugin` stage carries the verified VSIX (#165, 46-01) |
| `48233465` | record chat and credential host gaps | Superseded | Superseded | Spike README notes; durable per-person secrets landed in 46-07 and the README was rewritten |
| `f4511437` | record Docker webview and team save verification | Superseded | Superseded | Spike README notes, replaced by the Phase 46 container and browser suites |
| `01a9f155` | verify streamed chat and history in an isolated host | No | **Superseded in form, gap recorded** | A Puppeteer script against the old spike image; Puppeteer is not a registered resource and `main` tests the image with Playwright. No Playwright spec yet covers Chat in the release image (see Left over) |
| `5a04d3d3` | verify Chat Stop with retained test resources | No | **Superseded in form, gap recorded** | Same tool as `01a9f155` |
| `441c088f` | release Sterling images through GHCR | Superseded | Superseded | `release.yml` publishes through the `container-release` environment with cosign signing and SBOM attestation (#168, #174, 46-06); Codex reused the `marketplace` environment |
| `7dd8da3e` | GHCR release runbook (WIP) | Superseded | Superseded | `docs/development-workflow.md` documents `container-release` |
| `041c9957` | record the container release workflow | Superseded | Superseded | ROADMAP note for the same workflow |
| `08bfb4a4` | plan signed postings and position workspaces (33.1) | Superseded | Superseded | 33.1 was re-planned for native Theia (#180) and verified credentials (#189); its CONTEXT maps every Codex plan to a new one |
| `5b188718` | 33.1 plan clarifications (WIP) | Superseded | Superseded | Mapped in 33.1-CONTEXT: design 2.11 is a deferred idea, 2.12's workspace part is D-16, D-19, D-20, D-23 |
| `e723a61d` | Planning and Staff Center workspaces (WIP) | Fully for the UI; design note superseded | Done | Planning page and artwork are on main; the design note is mapped in 33.1-CONTEXT |
| `b968c8b6` | work areas, inventory and planning state (WIP) | Partly: inventory UI is on main; catalogue fixtures and planning edits are not | **Ask the owner** (questions 4, 5) | The CAF catalogue files are provisional public-source inferences, not an authoritative record; the ROADMAP, REQUIREMENTS and STATE edits are for Phase 88 and the digital twin |
| `9225afe1` | plan and verify governed inventory delivery (88) | No | **Ask the owner** (question 5) | Eight plans written before #188 to #196 (verified credentials, 70.1 classification engine); Phase 88 waits for the Stage 1 gate |
| `174da11d` | plan the governed defence digital twin | No | **Ask the owner** (question 5) | Research note and ROADMAP lines for a direction the owner has not confirmed on `main` |

## Per commit: what it changes for a person

- **`637bff5c`** The Command Palette shows every extension command under **SovAI** instead of **NEAR AI**, and messages that tell a person which command to run say "SovAI: Policy" instead of "NEAR AI: Policy". README, SECURITY.md and the docs site say the same. Get Started shows the official Sterling logo for the light or dark theme (already on main).
- **`3b9f071b`** The chat's empty state says "Connect AI to start" and offers local models and NEAR AI Cloud, not only a NEAR AI key; the chat input says "Ask a question"; the first-project page says "Connect an AI provider"; the side bar is titled Chat with a chat icon; the product is named Sterling Sovereign AI.
- **`e7fc76c7`** A NEAR AI Cloud or hybrid profile whose saved key is missing shows "Your saved profile needs its connection checked again" instead of a ready chat. A keyless local profile stays ready.
- **`f73bc988`** If you switch projects while Project Setup is open, it says so and runs nothing, instead of running a step for the project you left; settings are read for the chosen project folder.
- **`c85c42af`** The browser and remote proxy advice talks about "the workbench" instead of VS Code and drops the "NEAR AI:" prefix.
- **`b42b5fb1`** (missing part) Closing the last conversation in the Sterling workbench hides the chat drawer and keeps the conversation; in other hosts it still closes the tab. The close button's "stops its run first" hint shows only when a tab would really close.
- **`4b96f4ad`** (missing part) After **SovAI: Generate SA&A Package…** saves the ZIP in the workbench, a **Download ZIP** button sends it to the person's browser.
- **`01a9f155`, `5a04d3d3`** No change for a person; they prove that streamed chat, history after reload and Stop work in the browser workbench.

## How main's decisions apply

- **Phase 46 made the native workbench the product.** Every Theia commit was taken into `workbench/` by 46-01; this port adds only what the extension side lacks.
- **Releases are container images through `container-release`.** `release.yml` signs with your organization's cosign key and attests the SBOM; the Codex GHCR workflow (`441c088f`) reused the `marketplace` environment and is superseded.
- **33.1 was re-planned on verified credentials (#189).** All Codex 33.1 plan text is mapped or deferred in `33.1-CONTEXT.md`.
- **The owner's 74.3 theme with lifted cards** is not touched by any port.
- **Frozen file sizes.** `src/services/chat.ts` is frozen at 1,517 lines; the drawer change goes into a new module so `chat.ts` does not grow.
- **Copy lint and glossary.** Ports keep every count at or below the baseline. The new `product-name` rule (zero baseline) refuses "NEAR AI for VS Code", "NEAR AI extension" and a "NEAR AI:" command prefix in any user copy, and a documentation check does the same for README, SECURITY.md, CONTRIBUTING.md, `docs/` and `docs-site/content/`.
- **"Your organization", never "NEAR organization"; no NATO texts.** No port adds either.
- **32.1 N4** planned to move only `nearAi.setup` to SovAI until "the release cutover that follows Phase 46". Phase 46 has merged and the owner has now directed the rename, so all categories move here; 32.1-24's "SovAI: Set up Sterling" is unaffected. 32.1-18 plans to replace the chat setup card ("Connect NEAR AI to start") with one Get Started button; after `3b9f071b` its starting text is "Connect AI to start".

## Kept as NEAR AI on purpose

- The provider: NEAR AI Cloud, NEAR AI private hardware, a NEAR AI key, the NEAR AI console, NEAR AI's usage total.
- Internal ids: `nearAi.*` settings and commands, `near-ai-vscode`, `.near-ai` folders, the `near-ai/state` branch, view and container ids.
- Signed or recorded formats: the audit record's `product.name` (`src/domain/gate/record.ts`), so existing records and new ones agree.
- The SA&A and OSCAL system name (`compliance/src/oscalSsp.ts`, `src/services/saaPackage.ts`, `src/services/saaSponsorReport.ts`): owner question 1.
- `CHANGELOG.md` history and the `.planning` record.

## Owner questions

1. **SA&A system name.** The OSCAL SSP, the SA&A package and the sponsor report name the system "NEAR AI for VS Code". Rename it to "Sterling Sovereign AI" for the next package? It is an accreditation identity, and `compliance/src/` is a gate path.
2. **Extension display name in the container.** This port sets the bundled extension's display name to "Sterling Sovereign AI" (Codex used "Sterling"). Confirm.
3. **Staff Center or Staff Room.** The Planning page on `main` says "Open Staff Center" (from `881c0564`); 33.1 D-23 plans "no Staff Center word" and "Open Staff Room". Which one?
4. **CAF catalogue files.** Keep the provisional public-source CAF catalogue snapshot and the historical vehicle index (`b968c8b6`, about 3,700 lines) out of `main` until Phase 88's governed store, or add them as demo data with their provenance?
5. **Phase 88 plans and the digital twin.** Take Codex's eight Phase 88 plans (`9225afe1`) and the digital twin research note (`174da11d`) into `main` for a re-check against #188 to #196, or leave them on their branches?

## Ported on `feat/codex-port`

| Codex commit | Port | How |
|---|---|---|
| `637bff5c` | `feat(sterling): name the product SovAI; NEAR AI is only the provider` | By hand (the Codex diff was made on the spike layout and an older main); adds copy lint rule 8 and the documentation check |
| `3b9f071b` | `feat(sterling): make chat and setup provider neutral` | By hand on top of the rename |
| `e7fc76c7` | `fix(chat): prompt to reconnect when a saved credential is missing` | `cherry-pick -x`, one conflict in `media/chat/chat.js` resolved to the Codex version |
| `f73bc988` | `fix(setup): discard choices after switching projects` | `cherry-pick -x`, test file conflict kept both sides |
| `c85c42af` | `fix(setup): use host-neutral proxy advice` | `cherry-pick -x`, clean |
| `b42b5fb1` (part) | `feat(chat): closing the last conversation hides the workbench chat drawer` | By hand, in a new `src/services/chatDrawer.ts` so the frozen `chat.ts` does not grow; the close button hint change is left out (wrong in other hosts) |
| `4b96f4ad` (part) | `feat(theia): download SA&A archives from the workbench` | By hand, both sides (extension offer and workbench command) |
| (follow-up) | `test(e2e): the end-to-end specs follow the SovAI names` | The browser egress spec ran "NEAR AI: Open Chat" and looked for "Message NEAR AI" |
| (follow-up) | `fix(sterling): keep NEAR AI in recorded and fingerprinted texts` | The focused tests found three texts whose words are recorded or compared (see Left over) |

## Left over

- Three product sentences still say NEAR AI because their words are recorded or compared:
  - `LABELS_NOT_ACCREDITATION_TEXT` ("They check what NEAR AI itself sends", also twice in SECURITY.md): the J2 and J4 staff guidance embeds it, so new words need new staff template versions (`node scripts/template-history.mjs` adds 289 lines), and `src/agent/teamTemplateHistory.ts` is frozen at 2,335 lines. Split that file first, then rename.
  - The scaffolded research verifiers' README (`src/gsd/verifierScaffold.ts`), a hashed verifier file: new words would mark it edited in projects scaffolded without a manifest. It still names "NEAR AI: Trust Research Verifiers"; the palette search still finds the command.
  - The team coordination commits' git author ("NEAR AI Team", `src/team/runGit.ts`).
- The component catalogue page `docs-site/content/architecture/components/workbench.md` is generated from `compliance/resources.json` (a gate file), whose workbench entry says "the NEAR AI chat"; the page keeps the register's words until that entry changes.
- A comment in `scripts/verify-release-content.mjs` (a gate file) still says "NEAR AI: Load Staff Exercise Scenario"; left to avoid a second gate file for a comment.
- A Playwright spec for Chat in the release image (streamed reply with a fake model server, history after reload, Stop), replacing the Puppeteer tool of `01a9f155` and `5a04d3d3`. It needs the release image with the bundled VSIX, like `get-started.spec.ts`'s create test.

## Checks on the merged branch (main at `bcc85d44`)

- Root: lint passes; the full suite runs 6,281 tests, 6,273 pass, 0 fail, 8 skipped (the existing skips). Copy lint (with rule 8), architecture (no frozen file grew; `chat.ts` stays at 1,517 lines) and the compliance fit check pass.
- Workbench on Node 26.13.1: lint passes, 106 of 106 unit tests pass, the production build passes.
- Tests added: copy lint rule 8 (two), the SA&A download offer, the last-conversation drawer close, the saved-credential welcome state (from `e7fc76c7`), the project switch during Project Setup (from `f73bc988`); extended: the onboarding provider button, the proxy advice words, the panel title prefix check.
- Not run here: the browser and container suites (they need the built image), and the docs site build.
- Gate file touched: `SECURITY.md` only.
