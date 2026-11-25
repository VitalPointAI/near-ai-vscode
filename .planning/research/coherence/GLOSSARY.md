# Glossary: one word per concept

Part of the coherence review (`REVIEW.md` in this folder). Written 2026-11-20 against `origin/main` at 15bc560c.

Rule: every concept has **one user word**. Words in the "never on main screens" column stay in code, records, admin detail panes and docs for administrators. Words in the last column change with the organization mode (portfolio-and-assignment design, 5.2), and are always produced by `term(concept, mode)`, never spelled in a host or page.

## 1. Content, use and where AI runs

> Amended 2026-11-25 (Phase 48.4, sovereignty status, plan 48.4-01): three rows for the sovereignty badge and card (Sovereignty, the fourteen dimension names, "Declared by {name} on {date}"), and the never-column note of "Data must stay in a country".

| Concept | User word | Never on main screens | Changes by mode |
|---|---|---|---|
| How sensitive content is | **Label**, always shown as scale name plus level: "Organization: Internal", "Canada, Protected: Protected B", "Canada, Classified: Confidential" | scale id, `org/...`, `ca-protected/...`, handling flags | no |
| Highest sensitivity a chat has reached | **Label** ("this chat's label", it can only go up unless a person lowers it with a reason) | mark, session mark | no |
| What kind of use a request is | **Use**, in plain words: "research only", "chat you review", "agent work", "operational work" | T0, T1, T2, T3, use tier | no |
| Where a model runs | **Runs on**: "this computer", "your organization's server", "NEAR AI private hardware", "Cohere vault in {region}", "outside provider ({name})" | hosting class, `nearai-tee`, `org-tee`, `vendor-tee`, `vendor-region`, `org-plain`, `closed-api`, `local` | no |
| What this extension checked | **Verified** / **Model verified, connection not proven** / **Not verified** (the three shipped proof levels), always followed by what | attested, attestation, TEE, enclave, TDX, SEV-SNP (details pane only) | no |
| Export-controlled content (reserved compartments `CGP`, `ITAR`, `EAR`) | Shown after the level: "Controlled goods (Canada)", "ITAR", "US export-controlled (EAR)" ("Organization: Internal · ITAR") | compartment token, regime, `exportControl` | no |
| A person or AI service approved for export-controlled content | "Allowed to see: Controlled goods (Canada) until {date}, decided by {name}"; "allowed by {name}'s export decision {id} until {date}" | `export-person`, `export-endpoint`, designated official, empowered official (admin and officials' pages only) | no |
| Data must stay in a country | "must stay in Canada" (or the region named) | sovereign region, residency (the sovereignty card's dimension is named "Canada-only handling rule"; "must stay in Canada" stays the rule's own sentence) | no |
| How far Canada controls this system, by dimension | **Sovereignty**: the badge and card name only, always followed by a state word ("Sovereignty: Met", "Sovereignty: Not met · {reason}"); the states are the Compliance view's words plus Unknown | SEAL, sovereignty score, sovereign region, sovereign (as a verdict), a percentage or a score | no |
| A dimension of the sovereignty card | The fourteen plain names, in order: "Where your data is stored", "Where data travels", "Where AI runs", "Who holds the keys", "Canada-only handling rule", "Where models come from", "Where the software comes from", "Where the hardware comes from", "Who runs it", "Who issues identities", "What can leave the site", "Who can switch it off", "Which laws apply to outside services", "Assessments" | dimension ids D1 to D14, SA-400 (detail pane only) | no |
| A signed fact your organization states | "Declared by {name} on {date}" (a fact the site checked itself reads "Verified") | attestation (unless a hardware attestation verified it) | no |
| The organization approved a model for a use | "Approved for {use words} until {date}" | model passport, `models.passports` (admins: "model approval") | no |
| A named person allowed an exception | **Exception** (owner, 2026-11-25): "Allowed by {name} until {date}". A model exception covers exactly one use, so the use is named: "Allowed for chat you review by {name} until {date}". An exception exists only under your organization's rules, so it has no self-signed form (74.1 D-20) | risk acceptance, authorization record, `t1-risk` (admin pages say "authorization") | no |
| The organization's rules for which models may do what | **Model policy** ("your organization's model policy"; "your rules for models" without an organization) | `models` section, passport set | no |
| Model rules that only record what they would refuse | "report only" ("Agent work is running outside your organization's model policy (report only).") | report mode, would-refuse, `mode: report` | no |
| The list of models that worked on a project | **AI bill of materials** (command "Export AI Bill of Materials") | AI-BOM, CycloneDX, ML-BOM | no |
| Protected B allowed in a hosted service | "Allowed for Protected B by {name}'s authorization {ref} until {date}" | `authorizations[kind=protected-b]` | no |
| The organization's signed rules | **Your organization's rules**; without an organization, **Your rules** | policy bundle, bundle keys, layer, issuer | no |
| The rules a fresh install starts with | **Starting rules** | default bundle, self-signed default | no |
| Model for a job (fast, standard, deep) | **Models by job**: "Fast model", "Standard model", "Deep model" | tier (for models), model role, model slot | no |
| Verified private models only (today's `nearAi.privacyMode: tee-only`) | "Only verified private hardware or this computer" | TEE-only, sovereignty mode | no |

Updated 2026-11-25 by 74.1-16 (UI-SPEC P13): "exception" is the user word, "(self-signed on this computer)" no longer applies to exceptions, and the model policy, report only and AI bill of materials words are added. The words of the security officer's switch ("Stop agent work now", "Return to report only", "stopped entirely") are added when the switch ships; it is not yet available (G418).

## 2. Agents and people

| Concept | User word | Never on main screens | Changes by mode |
|---|---|---|---|
| A group of agents | **Agent team** (every mode; never the bare word "team", owner 2026-11-20) | squad, roster (for agents), crew | no |
| One agent in a team | **Agent**, with its **job** | member (for agents), seat, role (for agents) | no |
| The agent that coordinates and merges | "coordinating agent" | lead (for agents), lead agent | no |
| A person in a shared project | **Member** (Corporate and software), staff officer (Military), employee (Public service), project team member (Capital) | seat, writer, device | yes |
| A slot that outlives the person | **Position** | seat, billet (except Military, where "billet" is the mode word) | yes |
| Joining a shared project | mode word: invitation, posting, assignment, appointment | join secret, genesis | yes |
| Who decides membership | mode word: team lead, staff lead, responsible manager, project leader | roster writer, `LEAD_ROLES` | yes |
| What a person may approve | **Decides** ("J2 Chief decides intelligence estimates") | decision roles, `decision_for` | yes (approve, endorse, commander's decision) |
| Signed list of people | **People** (Corporate, Public service, Capital), **Roster** (Military only) | genesis, `rosterPrev` | yes |
| Who can see a piece of shared work | "Who can see this" | cell, epoch, wrap, grant, key group | no |
| An organization unit | mode word: work team (Corporate), section, directorate, project office | node, cell (for units) | yes |
| Kind of organization | "How your organization works": Military, Public service, Corporate and software, Capital projects | organization mode | it is the switch |
| What you will do here (setup question 1) | "Kind of work" | role (for setup) | no |
| How much agents may do without asking | **Autonomy**: Ask before edits, Edits auto, Auto, Full auto | action policy, approval mode, `approve-risky` | no |

## 3. Places, connections and sharing

| Concept | User word | Never on main screens | Changes by mode |
|---|---|---|---|
| A workspace folder | **Project** | workspace (except in VS Code's own sense) | no |
| Projects rolled up | **Portfolio**, opened in the **Portfolio Room** | Project Room as a separate page (it is a tab) | no |
| A unit reporting upward | **Unit** | publication envelope, intake key | names follow the mode |
| A staff team's shared room (planning cycle, products, who is working) | **Staff Room** (owner, 2026-11-24; the Planning page's button is "Open Staff Room") | Staff Center, war room | no |
| Always-on organization machine | **Your organization's server** (status page lists what it does: sync, data, messaging) | hub, host, relay, appliance, L1a | no |
| An AI service | **AI service**: NEAR AI Cloud, this computer, your organization's server, Cohere vault | provider, endpoint | no |
| Saved key and address for an AI service | **Connection** | profile | no |
| A doctrine choice in staff setup | **Doctrine** | doctrine profile | no |
| The capital governance file | **Your directive** | governance profile, capital profile | no |
| Same person, other computer | **My computers** (recovery code; also covers Add My Other Machine) | Project Sync, online home (say "GitHub repository" once), key file | no |
| Working with other people | **Share with people** (invitation file and safety code) | Team Mode, multi-user, genesis, join secret, replica | joining words follow the mode |
| Workflows (Open-GSD) | **Workflows** | GSD, Open-GSD (Tools page detail only) | no |
| Research-only space | **Research workspace**; its one use is "research only" ("Research workspace. Adversary models allowed. No project data.") | T0 lane, `lane: t0` | no |
| Data platform personal opt-out | "Personal: keep out of the catalogue" | personal mark, mark | no |

## 4. Collisions the reviews found, and how they are resolved

| Word | Meanings today | Resolution |
|---|---|---|
| **Confidential** | `org/Confidential` (routes to attested cloud) and `ca-classified/Confidential` (local only); the guide's draft Q2 lists "Classified documents (Confidential, Secret, Top Secret)" | Checked on main: Set Label picks the scale first and shows keys like `org/Confidential` (`src/services/gateCommands.ts` `labelShown`), so a wrong pick needs two wrong steps today. Still medium: every display shows scale name plus level ("Organization: Confidential", "Canada, Classified: Confidential"), the Set Label list is grouped by scale, and the guide's copy names the scale. Owner question: rename the `org` level's display name to "Sensitive" while its id stays `Confidential` (ids never change in place, `labels.ts`). |
| **Team** | agents (Team Studio, Team Live, `teams.ts`) and people (Team Mode, PORT 5.2 Corporate column); later Microsoft Teams | Never bare. Agents: **agent team**; people in Corporate mode: **work team**; other modes use their own word (staff, section, unit, project team, and "Defence team member" in Military and Public service, owner 2026-11-21). The copy lint flags a bare "team". The name "Team Mode" is retired from user copy; Microsoft Teams is always "Microsoft Teams". |
| **Roster** | the agent list ("check the roster" in `staffSetupCommand.ts`) and the signed human roster (MUS 7.1) | People only, and only in Military mode. Staff setup says "check the team". |
| **Lead** | section lead (`humanLead`, approves products), staff lead (writes the roster), lead agent | People: the mode word for "who decides membership", and "decides" for approvals. Agents: "coordinating agent". The team file names a position, never a person (REVIEW conflict K18). |
| **Cell** | a label key group (MUS 8) and an organization unit (CAP 5.3 small-project cell, PORT 1.6 software cell) | Users never see the key meaning ("who can see this"). As a unit word it exists only where a mode table says so. Designs say "key group" for the first meaning in prose. |
| **Profile** | connection (`newProfile`, `selectProfile`, `useSavedProfile`, `removeProfile`), doctrine profile, capital profile, `gsd.researchProfile`, `agentProfiles.ts` | Connection, doctrine, your directive. The four profile commands become one Connections section. `gsd.researchProfile` stays an internal setting name. |
| **Mode** | action policy, privacy mode, Team Mode, organization mode, passport report or enforce mode, Calm | Autonomy; "Only verified private hardware or this computer"; retired; "How your organization works"; report or enforce is admin-only; Calm stays a display preference. |
| **Private** | catalogue claim (`privacy: private`, picker "Private · runs in NEAR TEE", `privacyMode`, `teeOnly`), README tagline, capital "private profile", "private by default" | Reserved for one meaning: runs on verified private hardware or on this computer, and only after the check passed. Team flags read "private models only" and mean the gate's verified check (REVIEW S4). Capital: "kept out of the repository". The README tagline is revisited with SECURITY.md when the trust line ships. |
| **Tier** | use tier (T0 to T3), routing tier, model tiers (fast, standard, deep) | No "tier" on any user screen. Use: plain use words. Routing: "where it may go". Models: "Models by job". |
| **Relay / hub / host** | messaging relay, paused ciphertext relay, `relayTransport.ts`, L5 "hub-to-hub relay"; sync hub; data host | User word "your organization's server". In designs: hub = sync service; data host = a hub client with its own store; relay = messaging only. L5 says "hub federation". |
| **Mark** | session mark, data platform personal mark | Users see "label" and "Personal: keep out of the catalogue". |

## 5. The copy lint

> Amended 2026-11-25 (Phase 48.4, plan 48.4-01): rule 6 refuses the sovereignty overclaims in user copy and in the documentation files, and "Sovereignty" is a glossary word confined to the badge and card sources.

One test, `src/test/copyLint.test.ts` (new, in the F1 foundation phase), reads every user string source: `package.json` command titles and setting descriptions, string literals passed to `showInformationMessage`, `showWarningMessage`, `showErrorMessage`, quick pick titles and items, the text nodes of `media/**/*.js` and host-built HTML, and the Sterling workbench's browser and common sources (`workbench/extension/src/browser` and `workbench/extension/src/common`, Phase 46 D-33). It fails when:

1. A word from the "never on main screens" columns appears outside an allowed context. Allowed contexts are listed in one table in the test (for example "attested" inside the trust details pane, "TEE" inside SECURITY.md quotes, "GSD" on the Tools page).
2. A mode-varying concept is spelled instead of produced by `term()` (the PORT 5.5 lint, extended).
3. A panel title has a prefix ("Near AI:", "NEAR AI:") or the brand is spelled other than "NEAR AI" and "VS Code". "Sterling", "SovAI" and "Sterling Sovereign AI" are the Sterling edition and command-category names and are always allowed; "NEAR AI" stays the provider's spelling and "your organization" the user word.
4. An em-dash appears in user copy.
5. The provider's name is put in front of "organization" (the user word is always "your organization"; NEAR AI is only the provider).
6. A compliance claim about the product appears: "compliant", "accredited", "certified", and the export-control phrases "ITAR compliant", "CGP compliant", "export compliant" (`.planning/research/compliance-dashboard/CGP-ITAR.md`, section 10.3), and the sovereignty overclaims "fully sovereign", "100% sovereign", "100% Canadian", "sovereign by default", "sovereignty certified" and "certified sovereign" (Phase 48.4 D-35). The overclaims are also refused in README.md, SECURITY.md, CONTRIBUTING.md, `docs/` and `docs-site/content/`. A sentence that negates the phrase before it is honest and allowed ("SovAI is not fully sovereign today"). "Sterling Sovereign AI" is a name, never a claim. "Sovereignty" is a rule 1 word allowed only in the badge and card sources, each named by its own allowed-context row as the plan that builds it lands; "SEAL" and "sovereignty score" are refused everywhere.
7. The product is called by an old name (owner, 2026-11-24: the product is **Sterling Sovereign AI**, short name **SovAI**, and NEAR AI is only the provider): "NEAR AI for VS Code", "the NEAR AI extension", or a "NEAR AI:" command prefix anywhere in a sentence. Commands are "SovAI: ..." in the Command Palette. The same names are refused in README.md, SECURITY.md, CONTRIBUTING.md, `docs/` and `docs-site/content/` (`CHANGELOG.md` is history and is not read). Internal ids (`nearAi.*` settings and commands, `near-ai-vscode`, `.near-ai` folders) do not change.

It starts with a checked-in baseline of today's hits, so it passes on day one and fails on any new hit; each copy fix deletes baseline lines (the same ratchet as the architecture test in `DEVELOPER-STRUCTURE.md`).
