# Design 10: military staff team templates (J2, J5, J3, J4, then the full staff)

Date: 2026-11-18. Status: design with the owner's decisions of 2026-11-18 applied (all twelve questions in section 9.3 accepted as recommended) and terms verified against the owner's reference library (section 2.8). Nothing here is built yet.

**Conforms to the coherence review (2026-11-20):** the agent lists are called the team, never the roster (roster means the signed list of people, Military mode only); the run's lead agent is the "coordinating agent"; the human section lead becomes a position, so `decision_for` and "Reports to" name positions and the team file never names a person (before multi-user the local person holds every position); approvals are signed by the person's device or credential, never "the policy key"; "private" means the gate's verified check through `decideRoute`, with the PRC-origin sentence, and staff templates move to "needs operational-work approval and verified private hardware or this computer" with Phase 74.1; staff setup becomes the staff step of Get Started (no "where may the models run" question, true step counts); exercise on fictional data is the only staff mode until your organization approves a model for operational work, and the exercise flag is a signed project-layer attribute; labels are shown as scale name plus level and ranked by the one label service over the active scale table; the per-server MCP ceiling is the v2 `agents.mcp.labelCeilings` key; the Staff Room is the staff layout of the one run view with the one trust line ("18 of 18 agents verified"); staff commands show only in staff projects; shared staff projects keep their settings on the replica layer; "Doctrine" and "model for the job" replace "doctrine profile" and "tier" on screens. Superseded text is kept with dated notes. See `.planning/research/coherence/REVIEW.md` (conflicts K7, K13, K15, K18, K23, K30, K34, K37, K38, K39; fixes S4, S5, S7, S8) and `GLOSSARY.md`.

Inputs: research notes 00 (the earlier staff-cell prototype), 01 (agent exchange), 02 (J2), 03 (J3 and J4) and 05 (J5) in this folder; the extension's team runtime (`src/agent/teams.ts`, `teamCheck.ts`, `projectTypes.ts`, `teamTemplateHistory.ts`), its MCP client (`src/mcp/`) and the Phase 70 gate (`src/domain/gate/`). Notes 06 to 09 did not exist when this was written; where they land later they extend this design rather than replace it. Two public doctrine texts were read in full for this design and are cited directly: CFJP 5.0, The Canadian Forces Operational Planning Process, Change 2, April 2008 (B-GJ-005-500/FP-000, public on the Government of Canada publications site), and AJP-5, Allied Joint Doctrine for the Planning of Operations, Edition B Version 1 with UK national elements (public on the UK government publishing site). No passage of either is copied beyond short phrases. The owner then supplied a reference library (JP 5-0 of July 2025, a JP 3-0 extract, JP 1 Volume 1, JP 3-14, the Army War College AY26 Campaign Planning Handbook, and Canadian Army publications); section 2.8 lists them by title and edition and records what changed. Section 2.9 lists what they do not settle.

Citations: "02 T12" means note 02, Table 12; "03 A11" means note 03, section A11; "05 T5" means note 05, Table 5; "00 s6" means note 00, section 6; "01 s4" means note 01, section 4. "CFJP 5.0 art. 404" and "AJP-5 3.50" cite the publications by article or paragraph.

---

## 1. Key points first

1. **Three doctrine profiles, not four.** Owner decision (2026-11-18): US Joint (JPP, JP 5-0), US Army (MDMP, FM 5-0) and NATO/Canadian (AJP-5 Edition B at strategic and operational level, APP-28 at tactical level). There is no separate "CAF OPP" profile. CFJP 5.0 (2008) stays as a reference column in the crosswalk for users who still meet it.
2. **Levels are a second setting** (strategic, operational, tactical). Each profile allows some levels and picks the process: NATO/Canadian at tactical level runs APP-28; US Joint at tactical level is steered to US Army MDMP. Each section template has a team variant per level.
3. **Four section templates first, in demo order J2, J5, J3, J4**, each with 12 agents (the hard limit), including one release-guard per team. Every product has exactly one drafting owner. No agent has a persona name or a rank, and no agent decides: the people posted to the deciding positions (the commander and others) approve.
4. **One shared release state machine for every staff product**: draft, guard-checked, awaiting decision, approved or rejected, released. Only a person holding the deciding position moves a product from awaiting decision to approved. Agents cannot reach that transition at all, because the verb is not exposed as a tool.

> **Coherence review (2026-11-20):** on screens the doctrine setting is called **Doctrine** (not "doctrine profile"); `staff.profile` and `PROFILE.md` keep their names in code and files, and this design keeps "profile" in its prose. A team's agents are "the team" or "the agents", never "the roster", because in Military mode the roster is the signed list of people. See `.planning/research/coherence/GLOSSARY.md`, section 4.
5. **Shared products have a single writer each** (COP layers, CCIR register, synchronization matrix, DST and DSM, RFI tracker, assessment plan). Other sections propose entries; the owner merges. This is the same "separate areas, then merge" rule the extension already gives every team's coordinating agent.
6. **Team of teams is a new extension feature.** A team file member may reference another team (`team:`) or borrow one member of another team (`uses:`). The referenced team runs as a nested team under its own coordinating agent, in its own worktree branch, with depth, privacy, consent and cost limits. It has its own state machine and tests. This is what makes a 9-section joint staff possible under the 12-member cap.
7. **Tools.** The templates run today on built-in tools. New local tools (staff-products, cop-map with milsymbol, battle-rhythm, orders, intel-workbench, logstat, movement, consumption calculator, guard-scan) make products structured and checkable. Partner tools wait for one small gate change: a label ceiling per MCP server in the signed policy, plus fenced tool descriptions.
8. **Demo data: TRADOC ODIN's DATE scenarios and the Worldwide Equipment Guide.** They are public and reachable without a login, and a 2021 TRADOC FOIA reply (seen through a secondary summary) says WEG content is approved for public release. No licence or terms page could be read, and ODIN now redirects to a new address. Recommendation: do not bundle ODIN files; link to them and ship our own small fictional starter scenario, until the owner has written confirmation.
9. **Roadmap: ship as 0.4.x feature releases now, in three drops** (J2 and J5 with the shared mechanisms; J3 and J4 with the tool servers; team of teams and the full staff), before the remaining v0.5.0 governed-platform phases. The templates need none of Phases 71 to 74; partner MCP use waits for the per-server ceiling, which is a small Phase 70 follow-up.
10. **Verified against the owner's references** (section 2.8). JP 5-0 of July 2025 replaces the 2020 edition: the US Joint COA tests are now suitable, feasible, acceptable, distinguishable, complete; the fourth planning function is plan evaluation; the J-3 leads crisis planning; most joint annex letters are now filled. JP 3-14 (2023) sets the space planner's vocabulary. The Canadian Army texts move the NATO/Canadian profile from JIPB to JIPOE and IPB and add influence activities and a chaplain rule. Section 2.9 lists what is still to confirm and which item each document would change.

---

## 2. Doctrine profiles and levels

### 2.1 The settings

| Setting | Values | Where it lives | Default |
|---|---|---|---|
| `staff.profile` | `us-joint`, `us-army`, `nato-ca` | Project file `.planning/.near-ai/project.json` (follows the project); a VS Code setting `nearAi.staff.defaultProfile` seeds new projects | `us-joint` |
| `staff.level` | `strategic`, `operational`, `tactical` | Same | `operational` |
| `staff.nation` | `ca`, `nato` (only with `nato-ca`) | Same | `ca` |
| `staff.horizons` | current ops, future ops, future plans in hours | Same | 24 and 96 hours (03 A3; 05 s1, from JP 3-33 2018). User-editable, never constants |
| `staff.phases` | free list of phase names | Same | empty: the user names phases (03 A2; JP 5-0 2025 says phases are unique to each operation and the commander sets their number) |
| `staff.planningType` | `campaign`, `contingency`, `crisis` (JP 5-0, 2025) | Same | `contingency`. `crisis` makes the J3 director the planning lead's decision-for role and allows JPP steps to run at the same time |

> **Coherence review (2026-11-20):** on a single computer these settings stay in `project.json`. In a shared staff project they are project-stream entries on the replica layer (with the project label and the organization mode), so every member's computer reads the same signed values instead of an unsigned file carried by git. The exercise flag (section 7, item 9) is not one of these settings: it is a signed project-layer attribute. See `.planning/research/coherence/REVIEW.md`, conflicts K23 and K30.

Valid combinations, and what each selects:

| Profile | Strategic | Operational | Tactical |
|---|---|---|---|
| US Joint | JPP inside the four planning functions; CCMD or Joint Staff products (05 T2) | JPP at JTF level (05 T2) | Not offered: the setup screen says JPP is a joint process and offers US Army MDMP instead |
| US Army | Not offered | Not offered (an Army operational-level HQ in a joint fight uses JPP; offered as US Joint) | MDMP, corps to battalion; troop leading procedures below (05 s2) |
| NATO/Canadian | AJP-5 Ed B with the COPD as procedure; with `ca`, Canadian strategic functions (see 2.5) | AJP-5 Ed B | APP-28 (secondary sources only, see 2.4) |

The profile and level feed three things at run time: the vocabulary file every agent reads first (step names, product names, annex letters, J/G/S codes), the team variant the template uses, and the coordinating agent's workflow table. Changing either after work has started is allowed and is recorded; products already approved keep the profile they were approved under (a field in their header), so nothing approved is silently renamed.

### 2.2 Crosswalk of steps

Rows are the work. CFJP 5.0 is a reference column only (owner decision). "Secondary" marks text not read in a primary public copy.

| # | Work | US Joint JPP (JP 5-0, July 2025) | US Army MDMP (FM 5-0, 2024) | NATO AJP-5 Ed B (strategic, operational) | NATO APP-28 (tactical; secondary) | CFJP 5.0, 2008 (reference only) | Key outputs |
|---|---|---|---|---|---|---|---|
| 1 | Start | 1 Planning initiation | 1 Receipt of mission | 1 Planning initiation (Stage 2 of the operations planning process); commander's initial planning guidance and warning order (AJP-5 3.15) | 1 Receipt of mission | Stage 1 Initiation: commander's initial direction, Wng O (art. 402) | Timeline, warning order, initial guidance, planning group formed |
| 2 | Understand | 2 Mission analysis (operational design runs before and alongside it; JIPOE feeds it) | 2 Mission analysis (ADM before or alongside if ill-structured) | 2 Mission analysis, with operations design; restated mission; commander's planning guidance (AJP-5 3.18 to 3.43) | 2 Mission analysis (no formal operational design) | Stage 2 Orientation: mission analysis by the commander and selected staff; mission analysis brief presented by the COS or J5 Plans; Commander's Planning Guidance and Wng O; JIPB (art. 312, 403) | Facts and assumptions, tasks, limitations, COG analysis, CCIRs, criteria, restated mission, intent and guidance |
| 3 | Build options | 3 COA development | 3 COA development | 3 COA development: adversary COAs evaluated first; viability tests (AJP-5 3.45, 3.50) | 3 COA development | Stage 3: staff analysis of factors; enemy COAs first; own COAs; Information Brief; viability (art. 304, 404) | COA statements and sketches; adversary MLCOA and MDCOA |
| 4 | Test options | 4 COA analysis and wargaming | 4 COA analysis (war game) | 4 COA analysis | 4 COA analysis | Inside Stage 3: COA validation, wargaming (art. 404.8 to 404.9) | Wargamed COAs, sync matrix, decision points, DST and DSM, branches, refined CCIRs |
| 5 | Compare | 5 COA comparison | 5 COA comparison | 5 COA validation and comparison | 5 COA comparison | Inside Stage 3: compare COAs with a decision matrix (art. 404.10) | Comparison matrix, recommendation with risk |
| 6 | Decide (human) | 6 COA approval | 6 COA approval | 6 Commander's COA decision | 6 Commander's decision | Inside Stage 3: Decision Brief, commander selects, staff writes CONOPS (art. 404.11 to 404.13) | Decision brief; the decision is a person's |
| 7 | Write the plan | 7 Plan or order development | 7 Orders production, dissemination and transition | 7 Plan development: CONOPS and OPLAN (Stage 4) | 7 Transition (orders) | Stage 4 Plan Development: CONOPS approved by the initiating authority first; annexes and SUPLANs; branches and sequels; plan approval; Impl O or OP O (art. 405) | Plan or order with annexes, transition brief |
| 8 | Keep it valid | Plan evaluation function (refine, adapt, terminate planning, or execute); IPRs; operation assessment (JP 5-0 ch. VI and app. H) | Assessment (FM 5-0 ch. 8) | Operations assessment (AJP-3); COPD phases 5 and 6 | Not a step | Stage 5 Plan Review: progress review (supplementary Wng O, Frag O) and periodic review at least every 24 months; a register of plans (art. 406, 315) | Updated plan, branches and sequels, assessment reports |

Sources: JP 5-0 (July 2025) figures IV-2 and IV-3 and ch. IV para 3; 05 T1 and s1 to s4; 03 A7, A12; 02 T3 to T5; CFJP 5.0 art. 304, 312, 315, 402 to 406; AJP-5 figure 3.1, 3.15, 3.45, 3.50.

**COA tests per profile** (the J5 `lead-planner` agent applies the right list):

| Profile | Tests |
|---|---|
| US Joint | Suitable, feasible, acceptable, distinguishable, complete (JP 5-0, July 2025, ch. IV, COA development; the AY26 Campaign Planning Handbook calls it the SFA-DC test). The 2020 edition's first test was "adequate" |
| US Army | Feasible, acceptable, suitable, distinguishable, complete (FM 5-0; confirm wording in WP-J5) |
| NATO/Canadian | Feasibility, acceptability, completeness and compliance, exclusivity, suitability (AJP-5 3.50) |
| CFJP 5.0 reference | Suitability, feasibility, acceptability, compliance, exclusivity, completeness (art. 304) |

### 2.3 Annex letters per profile

The orders tool takes the annex list from the profile; a member never writes a letter from memory. This is the classic error the research found (03 Summary 4; 05 Summary 9).

| Subject | US Joint (JP 5-0, 2025 and 2017; AY26 Campaign Planning Handbook OPORD format) | US Army (FM 5-0, 2024, app. D) | NATO/Canadian (NATO COPD letters, owner decision 19 Nov 2026) |
|---|---|---|---|
| Task organization | A | A | B (Task Organisation and Command Relationships) |
| Intelligence | B | B | D |
| Operations | C | C | A (Concept of Operations) |
| Logistics or sustainment | D (Logistics) | F (Sustainment) | R (Logistics), S (Movements) |
| Fires | No lettered annex; an appendix to C | D | II (Joint Targeting) |
| Rules of engagement | Appendix to C | Appendix to C | E |
| Health services | Q (Health Services) | Within F | QQ (Medical) |
| Information | No lettered annex; the template carries it in C (Appendix 3). Y is Communication Synchronization | Within C | SS2 (Information Operations), under SS (Strategic Communications) |
| Communications | K (Command, Control, Communications, Computer, and Cybersecurity Systems) | H (Signal) | Q (Communications and Information Systems) |
| Engineer | No lettered annex; L is Environmental Considerations | G | EE (Military Engineering) |
| Legal | Appendix to E (Personnel) | Tab C to Appendix 2 to F | AA |
| Public affairs | F | J | TT |
| Assessment | N (Assessments) | M | OO (Operations Assessment) |
| Contracting and finance | W (Operational Contract Support) | W (OCS) | FF (Financial Support, with contracting) |
| Interagency | V (Interagency-Interorganizational Coordination) | V | No separate annex; W is CIMIC |

Notes:
- **US Joint**: JP 5-0 (July 2025) names A (Task Organization), B (Intelligence), C (Operations), D (Logistics), E (Personnel), I (Knowledge, Information, and Data Management), N (Assessments), R (Reports), V (Interagency-Interorganizational Coordination) and W (Operational Contract Support), and lists A, B, C, D, J, K, S, V and Z for a level 3 CONPLAN. The AY26 Campaign Planning Handbook's OPORD format gives the full A to Z list (M not used). The handbook has O Host Nation Support and P Foreign Disclosure; the JP 5-0 (2017) annex list has no annex O and gives P to Host-Nation Support, and no source gives foreign disclosure a letter, so the profile uses P for host-nation support and asks a person where foreign disclosure goes. The 2025 JP 5-0 names neither O nor P and leaves formats to CJCSM 3130.03. The fires, information, ROE and legal placements and their sources are in the terms register (section 2.9).
- **US Army**: from FM 5-0 (2024) Appendix D, table D-2 (the annex formats are in Appendix E).
- **NATO/Canadian**: AJP-5 does not list annexes; it points to the COPD for the CONOPS and OPLAN formats and list of annexes. The owner decided (19 Nov 2026) to use the NATO COPD letters: the COPD Interim V2.0 (2013) list with the published COPD V3.0 (2021) changes (Info Ops SS2 and PsyOps SS4 under SS StratCom), and the V2.0 letter where the V3.0 placement is not public. These replace the CFJP 5.0 Chapter 5 Annex E Appendix 1 letters the first drop used. **Intelligence is Annex D** and Logistics is R, so "Annex D is Logistics" (joint) and "Annex D is Fires" (Army) are both wrong here.

### 2.4 What is public, and what is not

| Text | Status for this design | What it supports | Confirmation needed |
|---|---|---|---|
| JP 5-0 (1 July 2025) | Owner's reference copy, read in full (section 2.8). Supersedes the 1 Dec 2020 edition with Change 1 (1 July 2024) that notes 02, 03, 05 to 09 used | US Joint profile | None for step names, COA tests, plan levels and the annex letters it names; formats sit in CJCSM 3130.03 (2.9) |
| JP 1 Volume 1, Joint Warfighting (27 Aug 2023); JP 3-0 (18 June 2022) chapter VII and appendix D (JADO) extract; JP 3-14 (23 Aug 2023) extract; AY26 Campaign Planning Handbook (Army War College) | Owner's reference copies, read (2.8) | Joint functions, competition continuum, space mission areas, campaign design and assessment, the joint annex list | The rest of JP 3-0 was not in the extract (2.9) |
| JP 2-0 (2022), JIPOE Joint Guide, JP 4-0 (2023), JP 3-04 (2022), CJCSM 3130.03 | CAC only, or not released (02 T1; 03 A1, B1) | Names and editions only; method from public older editions, cited by title and edition | Section 2.9 |
| FM 5-0 (Nov 2024), FM 3-0 (Mar 2025), ATP 2-01.3 (2019 with C1) | Public, read (05; 02) | US Army profile | ATP 2-01.3 Change 2 (2024) and FM 2-0 (2023) seen only second-hand (02 s3.8) |
| AJP-5 Ed B (June 2026) | Public, read in full (05; and for this design) | NATO/Canadian profile at strategic and operational level | Its annex scheme sits in the COPD (Q2) |
| COPD | Not public (05 Edition check) | Phase names only, from AJP-5's UK annex | Q2 |
| APP-28 | Restricted; step names from a NATO centre-of-excellence handbook (05; 03 A8) | NATO/Canadian tactical | None of the owner's Canadian Army references mentions APP-28 (2.8); section 2.9 |
| Canadian Army: Land Operations B-GL-300-001/FP-001 (2008) and CADN 16-01 (2016); Canada's Army B-GL-300-000/FP-000 (1998); Army Training for Land Operations B-GL-300-008/FP-001 (2014); CADN 13-01 (2013); Toward Land Operations 2021 (2009); FITE concept paper A-FD-005-000/AG-001 (2019) | Owner's reference copies, read (2.8) | Canadian land terms: planning process at formation level, battle procedure, IPB, operational functions, influence activities, chaplain engagement rules | None is a staff duties, orders or planning guide (2.9) |
| CFJP 5.0 (2008) | Public, read in full | Reference column; Canadian annex list; functions such as strategic watch | None (reference only) |
| CFJP 2-0 (2011), CFJP 4-0 (2016) | No public copy found (02 s3.8; 03 B6) | Canadian J2 and J4 terms only through secondary sources | Q4 |

### 2.5 Canadian items that still apply under the NATO/Canadian profile

- **Names.** The deployable joint HQ is the Canadian Joint Response Force Headquarters, renamed on 10 August 2026; templates never say "1 Cdn Div" (03 A8). CJOC plans, directs and integrates all-domain operations except those run only by CANSOFCOM or NORAD (03 A8). CJOC J3 and J5 internal branch names are not public: describe functions, never invent branch names (03 A8 gap; 05 s3).
- **Authorities.** The Chief of Defence Intelligence has functional authority over defence intelligence; Commander CJOC leads defence intelligence requirements for joint operations (02 s3.3). The CDS's critical intelligence requirements and friendly force information requirements exist at strategic level (CFJP 5.0 art. 118), so the strategic J2 team answers CDS CIRs.
- **Domestic operations.** At strategic level in domestic operations, PIRs are usually replaced by a statement of the intelligence problem that drives the threat assessment (CFJP 5.0, CDS directive format). Collection on persons in Canada is legally restricted (02 Pitfall 11). A domestic switch in the template turns on both rules and the "assistance to civil authorities" framing.
- **Support structure.** Four lines of support, the JTF Support Component, and the CJOC J4 weekly logistics and ammunition reports replace a US-style daily LOGSTAT as the headline report (03 B6, B12 item 9).
- **Doctrine order.** Canada puts NATO doctrine first, then the five-nation multilateral doctrine (02 s3.3). This is why the Canadian templates use NATO terms.
- **Canadian Army land terms** (tactical level, `ca`), from Land Operations (2008) and CADN 16-01 (2016):
  - Land Operations (2008) has formation headquarters plan with the CF operational planning process (the CFJP 5.0 stages): long-range and mid-range planning in the plans centre, short-range planning (FRAGOs) in the operations centre, and battle procedure for commanders without a staff. Neither it nor CADN 16-01 mentions APP-28. The tactical NATO/Canadian profile still runs APP-28 (owner decision, 2.1); from these texts it takes the plans centre and operations centre split, battle procedure below staff level, and the terms below.
  - Intelligence at land tactical level is IPB, run by the G2; the intelligence cycle is direction, collection, processing, dissemination.
  - The five operational functions are Command, Sense, Act, Shield and Sustain. A Canadian J3 running estimate uses them as its headings in place of the seven US joint functions.
  - Logistics in land tactical text is combat service support (CSS).
  - "Operational environment" has replaced "battlespace", which is obsolete (CADN 16-01). So the NATO/Canadian profile says JIPOE at joint levels and IPB at tactical level; JIPB appears only in the CFJP 5.0 reference column.
  - CADN 16-01 sets the information operations umbrella aside for doctrinal purposes and plans influence activities instead (PSYOPS, key leader engagement, civil support, posture, profile and presence, and media relations).
- **Chaplain support.** Religious leader engagement is chaplain ministry, not intelligence collection and not an influence activity, and a religious area assessment is not intelligence preparation (CADN 13-01). The special staff's `chaplain-support` member therefore takes no tasks from the J2 collection plan or the influence plan; it reports only information that bears on force safety.

### 2.6 Corrections to the research notes

The research was written before CFJP 5.0 had been read and before the owner's NATO decision. These corrections apply to the templates:

| Note | What it said | Correction | Source |
|---|---|---|---|
| 05 T1, T4, T6, s3 | CF OPP stage questions ("What is happening?"), a COS planning directive, and a plan wargame in Stage 4 | Those come from the Canadian Army staff college handbook (tactical CAOPP), not CFJP 5.0. CFJP 5.0 Stage 2 ends with the Commander's Planning Guidance and a Wng O; Stage 4 is CONOPS approval, annexes and SUPLANs, branches and sequels, plan approval and issue | CFJP 5.0 art. 403, 405 |
| 03 A8 | The CFOPP Orientation stage produces "the JIPOE" | CFJP 5.0 uses JIPB (joint intelligence preparation of the battlespace) | CFJP 5.0 art. 403.3 |
| 05 Edition check | CFJP 5.0 could not be read | Read in full for this design; it explicitly does not cover tactical planning, and at strategic level it runs the Force Employment Planning Process with a strategic watch | CFJP 5.0 art. 116, 117 |
| 05 T7, 02 T13 | Canadian profile "CF OPP" | Replaced by the NATO/Canadian profile (owner decision) | Owner 2026-11-18 |
| 02 T5, 03 B3 | Canadian logistics annex not covered | Canadian reference list: Logistics R, Movements S, HSS K, Legal AA, Financial Support FF | CFJP 5.0 Ch 5 Annex E App 1 |
| 02, 03 | FM 3-0 dated October 2022 | Current edition is March 2025 | 05 Edition check |
| 05 s4 | Red teaming is in AJP-5 | Only as a UK national element: AJP-5 says the technique "is not described in NATO doctrine". The J2 red cell is common NATO practice | AJP-5 UK 2.15 |
| 02, 03, 05 to 09 | JP 5-0 of 1 December 2020 is the current edition | JP 5-0 of 1 July 2025 supersedes it (and its Change 1 of July 2024). Step names are unchanged | JP 5-0 (2025), summary of changes |
| 05 s1 and T6 step 3a | US Joint COA tests: adequate, feasible, acceptable, distinguishable, complete | Suitable, feasible, acceptable, distinguishable, complete | JP 5-0 (2025) ch. IV |
| 05 T1, s4 | Fourth planning function is "plan assessment" | Plan evaluation (refine, adapt, terminate planning, or execute); operation assessment is chapter VI | JP 5-0 (2025) ch. I and IV |
| 05 s1 (operational design) | Elements listed as one block of thirteen, including military end state and termination; method of five steps | Elements grouped as overarching (objective, transitions, COG, effects, culmination), organizing the operation (LOOs, LOEs, decisive points, direct and indirect approach, operational reach), time (arranging operations, anticipation), forces and functions, and balancing. The method has eight steps: understand strategic direction and guidance, understand the OE, define the problem, identify assumptions, develop operational approaches, identify decisions and decision points, refine the operational approach, prepare planning guidance. The 2025 text does not use "military end state"; the AY26 handbook still does | JP 5-0 (2025) ch. III; AY26 handbook ch. 3 |
| 06 s3.5, 09 | Annex I is Knowledge and Information Management; Annex K is C4 Systems | I is Knowledge, Information, and Data Management; K is Command, Control, Communications, Computer, and Cybersecurity Systems | JP 5-0 (2025) ch. I and VI |
| 05, 06 | The J5 leads joint planning | The J-5 coordinates staff planning for campaigns and contingencies; the J-3 coordinates it in a crisis. Planning groups are led by the J-5 or the J-3 | JP 5-0 (2025) ch. IV |
| 03 s A5, 08 | JP 3-14 (2023) rewrite "reported", not read | Read: the space mission areas are space domain awareness, offensive and defensive space operations, PNT, ISR, SATCOM, environmental monitoring, missile warning, nuclear detonation detection, spacecraft operations and spacelift. Space control, space coordinating authority, space negation and counterspace were removed | JP 3-14 (2023) summary of changes, executive summary, ch. III |
| 02 T3, 10 (earlier draft) | NATO/Canadian profile names the preparation step JIPB | JIPOE at joint level, IPB at tactical level; "battlespace" is obsolete in Canadian Army usage | CADN 16-01; Land Operations (2008) |
| 03 A5, 10 (earlier draft) | Canadian vocabulary is "information operations" | Canadian Army land planning uses influence activities; Annex O keeps its CFJP 5.0 title | CADN 16-01 |

### 2.7 Levels and team scaling

Every section template ships three team variants. The full tables are in section 3 per team; the pattern is:

| Level | What changes in every team |
|---|---|
| Strategic | Longer horizons (months to years); policy, interagency and partner seats grow; targeting and tactical cells drop; J2 warning analysis replaces the watch; products such as the strategic estimate, commander's estimate, campaign inputs (05 T2; 02 T14) |
| Operational | The full 12 (the default and the demo) |
| Tactical | G or S codes; IPB, MDMP or APP-28 vocabulary; fewer members (J2: 6 at brigade, 4 at battalion; J3 and J4: about 9; J5 folds into the S-3 plans cell at brigade, none at battalion) (02 T14; 03 A13, B11; 05 T5 scaling) |

### 2.8 Verified against owner references

The owner supplied local copies of the publications below (2026-11-18). They were read for this design; none is copied into the repository and they are cited by title, number and edition only. Some files did not hold what their names suggested; the table records what each one is.

| Reference (title, number, edition, issuing body) | What it is | Supersedes or relation |
|---|---|---|
| JP 5-0, Joint Planning, 1 July 2025 (US Joint Chiefs of Staff) | Current joint planning doctrine | Supersedes JP 5-0 of 1 December 2020 with Change 1 of 1 July 2024, the edition notes 02, 03, 05 to 09 used |
| JP 3-0, Joint Campaigns and Operations, 18 June 2022 (Joint Chiefs of Staff), extract | Chapter VII (campaigns and operations in armed conflict) and appendix D (fundamentals of joint all-domain operations, dated 10 September 2024) only | Same edition the notes named; most of the publication is not in the extract |
| JP 1 Volume 1, Joint Warfighting, 27 August 2023 (Joint Chiefs of Staff) (file named RM-03) | Capstone joint doctrine | Source for the seven joint functions and the competition continuum |
| JP 3-14, Joint Space Operations, 23 August 2023 (Joint Chiefs of Staff), extract | Front matter, executive summary and chapter III (planning and assessment of joint space operations) | Revises the 10 April 2018 edition |
| Campaign Planning Handbook, Academic Year 2026 (US Army War College) | Teaching handbook built on JP 5-0 (2025) | Replaces the AY25 handbook cited in note 02 |
| B-GL-300-000/FP-000, Canada's Army, 1998 (English and French) | Army capstone of 1998 | Superseded by Land Operations (2008) |
| B-GL-300-001/FP-001, Land Operations, 1 January 2008 (English; FP-002 French) | Canadian Army capstone doctrine | Supersedes the 1998 capstone |
| CADN 16-01, Land Operations Doctrine: an updated summary, 27 May 2016 (English and French) | Summary and update of Land Operations (2008) | Amends usage, not the publication |
| CADN 13-01 (13-1), Religious Leader Engagement, 24 July 2013 | Chaplain engagement doctrine note | None |
| B-GL-300-008/FP-001, Army Training for Land Operations, 14 June 2014 (English; FP-002 French) | Army training doctrine | Supersedes the 20 July 2010 edition |
| B-GL-310-001/AF-001, Toward Land Operations 2021: Studies in Support of the Army of Tomorrow Force Employment Concept, 2009 (English; AF-002 French) | Future concept studies, not doctrine | None |
| A-FD-005-000/AG-001, Future Integrated Training Environment, concept paper, version 1, 1 August 2019 (Canadian Army Doctrine and Training Centre; AG-002 French) | Training and simulation concept | None |

None of the Canadian files is an Army planning, staff duties or orders guide. They do not give a Canadian Army orders format, annex letters, G and S staff titles below the G2, or a battle group staff layout.

What changed in this design because of them:
1. **JP 5-0 edition.** The US Joint profile now cites JP 5-0 (July 2025). The seven JPP step names are unchanged (planning initiation, mission analysis, COA development, COA analysis and wargaming, COA comparison, COA approval, plan or order development).
2. **COA validity tests.** US Joint: suitable, feasible, acceptable, distinguishable, complete (the first test was "adequate" in 2020). Changed in 2.2, the J5 instructions, the UX concept and the prototype.
3. **Planning functions.** Strategic guidance analysis, concept development, plan development and plan evaluation; plan evaluation ends in refine, adapt, terminate planning or execute. Changed in crosswalk row 8.
4. **Operational design.** Design now comes before the JPP in JP 5-0 and has an eight-step method and grouped elements (2.6). The design-planner instructions follow it; "military end state" is used only in the profiles that still use it.
5. **Plan levels and orders.** Four levels of planning detail (commander's estimate, base plan, CONPLAN, OPLAN; level 3T when a TPFDD is needed) and the joint orders (WARNORD, PLANORD, ALERTORD, OPORD, PTDO, DEPORD, EXORD, FRAGORD) are as the design assumed. No change.
6. **Annex letters, US Joint.** Filled from JP 5-0 (2025) and the AY26 handbook: D Logistics, E Personnel, F Public Affairs, I Knowledge, Information, and Data Management, K Command, Control, Communications, Computer, and Cybersecurity Systems, N Assessments, Q Health Services, V Interagency-Interorganizational Coordination, W Operational Contract Support. Changed in 2.3. The O and P conflict is in 2.9.
7. **J-staff roles.** The J-5 leads campaign and contingency planning and the J-3 crisis planning; planning groups are led by either; plans move from the J-5 to J-3 future operations at transition; the red cell is a J-2 product and the red team a separate body (JP 5-0 appendix G). Added `staff.planningType` (2.1) and the crisis rule (3.1).
8. **Joint functions and phasing.** Seven joint functions (JP 1 Vol 1, 2023) name the J3 running estimate sections. The competition continuum is cooperation, competition below armed conflict and armed conflict. Phases are named per operation, which keeps `staff.phases` empty by default.
9. **Space.** The J3 cyber-space-planner uses the JP 3-14 (2023) mission areas and never the retired terms.
10. **Campaign design and assessment.** The AY26 handbook confirms SFA-DC, the four groups of design elements and the MOE, MOP and indicator definitions the assessment framework uses. No change beyond annex N.
11. **Canadian land terms.** JIPOE (joint) and IPB (tactical) replace JIPB in the NATO/Canadian profile; influence activities for the Canadian Army; five operational functions; CSS; plans centre and operations centre; the chaplain rule (2.5). The Canadian texts in hand predate APP-28 and do not mention it; the tactical profile still runs APP-28 by owner decision.
12. **Owner decisions.** All twelve questions in 9.3 and the UX concept's questions are accepted; the NATO/Canadian annex column and the APP-28 tactical profile ship as plain terms.

### 2.9 Still to confirm

The status of every doctrine term the templates use is kept in one place: the terms register, [TERMS-REGISTER.md](TERMS-REGISTER.md). Each row names the profile, the term, the value in use, and whether it is confirmed (with the public source and edition), confirmed by the owner, or a best guess (with the document that would confirm it). The values themselves live only in `src/domain/staff/doctrine.ts`.

Documents that would settle the remaining best guesses, by title only:

- CJCSM 3130.03A, Planning and Execution Formats and Guidance: US Joint appendix placements for fires, rules of engagement and legal.
- The full NATO COPD V3.0: the V3.0 letters beyond the published StratCom changes, including public affairs.
- APP-28 (full text): the tactical step names.
- CFJP 2-0 (2011): Canadian joint JIPOE and requirements management terms.
- JP 2-0 (2022): the US joint credibility grade 1 wording.
- ATP 3-35 (2023): the US Army RSOI term.
- TRADOC written reply on WEG and DATE release: bundling demo data (section 8, Q5).

### 2.10 How a person sets up a staff project (added 2026-11-20, coherence review)

Staff setup is the **staff step of Get Started**, not its own command (`EXPERIENCE.md`, section 1; conflicts K13, K16, K39). "Set Up a Staff Team" stays as a hidden alias that opens Get Started at this step for two minor releases.

| Setting | Where it comes from |
|---|---|
| Section (J2, J3, J4, J5, full staff) | Get Started question 1, "kind of work". An invitation file for a shared staff project opens Get Started with it already set to the person's section |
| Doctrine and level | Your organization's rules (`directives.doctrine`) when they set them; otherwise asked once, with the defaults in 2.1 |
| Echelon or variant | The only staff question always asked |
| Where the agents' models may run | **Not asked.** The project label and your organization's rules decide, through `decideRoute`. The earlier question "Where may the members' models run?" is removed |
| Who decides | The positions in the team file (`decision_for`, "Reports to"). Before the project is shared, the local person holds every position; in a shared project the people posted to them decide (assigned positions design, 3.1; Phase 33.1) |
| Exercise or operational | Exercise on fictional data is the only choice offered until your organization approves a model for operational work (section 7, item 9). The options screen says why |

Step counts shown are true ("Step 2 of 3"), never a fixed "of 6". The step never lands a person on a surface with no allowed model: it runs the viability and model approval check first, and a refusal card is never the first screen.

> **Superseded 2026-11-20 (coherence review):** the setup flow shipped in 0.4.x (`staffSetupCommand.ts`) asks where the members' models may run and shows "Step 6 of 6" for four questions, and it calls the agent list "the roster" ("check the roster"). Those stay until Phase 32.1 folds the flow into Get Started; the copy says "check the team" from the next patch. The decisions it carries (profile, level, nation, horizons) are unchanged.

---

## 3. The section templates

### 3.1 Conventions for all four

**Team file.** Standard format (`src/agent/teams.ts`): frontmatter `name`, `description`, `privacy: private`; then one `## slug` per member with `role`, `model`, `reports-to`, `tools`, `privacy` (last), then instructions. Every instruction stays under the 1,200-word warning (`teamCheck.ts`), says what the member owns and must not touch, and ends with what it hands back, so `teamCheck` shows no `no-deliverable`, `no-separate-areas` or `no-integration` findings.

> **Coherence review (2026-11-20):** `privacy: private` keeps its file syntax but means the gate's verified check: `decideRoute` runs with a floor of verified private hardware or this computer, so a stale or unproven connection is refused rather than trusted from the catalogue (fix S4). The team file shows it as "Private models only", followed by the PRC-origin sentence (section 7). With Phase 74.1 the staff templates change from `privacy: private` to "needs operational-work approval and verified private hardware or this computer", so a staff team asks for a model your organization approved for operational work rather than any private one (conflict K7). A team file names positions (`decision_for`, the "Reports to" column), never a person. See `.planning/research/coherence/REVIEW.md`.

**Who leads.** The run's coordinating agent (called the lead agent in code and in this design's tables) coordinates (spawns members, starts parallel lanes in one turn, merges), as `teamLeadPrompt` already requires. The section chief member is the section's integrator and author of its estimate and annex: it merges the members' products into the section's deliverables. The coordinating agent's workflow per step (tables below) goes into the team description and the project guidance (AGENTS.md block), the way `RESEARCH_WORKFLOW` does today. On screens it is always the "coordinating agent"; "lead" for people is the mode word for who decides membership (in Military mode, the staff lead position).

**The coordinating agent's tools (decided 0.4.35, after the owner's D-48 J2 run).** Tools offered equal tools allowed: every agent is offered exactly the tools its grants let it call (`AgentTool.offeredTo`, `offeredTools`), and the call-time checks stay as the second line. The lead gets no read access to the picture: the grant-gated servers (intel-workbench, observations, cop-map, logistics, orders, battle-rhythm) stay the members', because the lead coordinates and the section chief integrates, so the lead learns the picture from the members' reports. From staff-products and guard-scan the lead keeps what the host lets it call (status, list, register_read, wargame read, step, lint, scan); propose, verdict, submit, withdraw and register are offered to members only. A staff lead's prompt adds a section (`staffLeadNote`): it names the integrator, says not to do the members' reading, and says to mark the step and start that step's lanes within its first two turns. The coordinating agent keeps the chat's model (the person's choice); members run on their own model for the job (fast, standard or deep, the column "Model for the job" below).

**Every member's instructions open with the same four lines** (a shared preamble, kept short):
1. Read `.planning/staff/PROFILE.md` first (profile, level, nation, vocabulary, annex letters, horizons). Use its terms only.
2. Exercise and fictional data only. Never load or write classified material, real unit identifiers or current-operations content. Stop and report if you see any.
3. You recommend; the person posted to a position decides. Mark every decision you identify as `DECISION FOR: <position>` with options and risk. Never write "approved", "selected" or "released" about your own work.
4. Your area is the files listed under "Owns". Propose changes to anyone else's product as an entry in `.planning/staff/proposals/`, never by editing it. If you are waiting on another section, write `WAITING ON <section>: <what>` and carry on with what does not depend on it (00 s5).

**Tool groups** used below: READ = Read, Glob, Grep, TodoWrite, Recall, Remember. WRITE = Write, Edit. DOCS = CreateDocument, CreatePdf, CreatePresentation, RenderSvg. WEB = WebSearch, WebFetch, CheckCitations. STAFF = `mcp:staff-products` (new, section 4.1: read registers, propose state changes, never approve). Other `mcp:` names are the new local servers in section 6. A team marked private writes `privacy: private` on every member (meaning the gate's verified check, see the note under "Team file").

**Products** are Markdown files at `products/<section>/<product>.md` with a header block (section 4.1) and fixed headings. Structured registers (PIR register, CCIR register, sync matrix, LOGSTAT) are JSON or CSV beside them, written through the tools so the gates can check them mechanically (02 s3.5).

**Fixes to the earlier prototype**, applied in every template (00 s6):
- J5 owns the planning products (JPP, MDMP plans cell, JOPG) for campaign and contingency planning. In crisis planning JP 5-0 (2025) puts the J-3 in charge of staff planning: the planning group template is the same, and its `DECISION FOR` and hand-off lines name the J3 director instead of the J5 director when the run is marked crisis; J35 is future operations under the J3 (branches, 24 to 96 hours); J33 or the JOC is current operations. No duplicate COA developers across teams: COAs are the J5 cells'; J3 and J4 only check them.
- Role slugs only. No persona names, no ranks, no US-only branch codes.
- The intelligence estimate (j2-chief) and the INTSUM (j2 watch-officer) each have an owner, as do every other product listed.
- No agent in a command role. Command decisions appear only as `DECISION FOR` items.
- JIPOE at joint levels, IPB with OAKOC only at tactical level.

### 3.2 J2 Intelligence (demo 1)

Based on 02 T8, T9, T12, T13 and s3.6, with the prototype's release officer merged into the shared release-guard.

**Team (operational level, 12 agents)**

| # | Slug | Job | Model for the job | Tools | MCP grants | Reports to |
|---|---|---|---|---|---|---|
| 1 | `j2-chief` | J2 integrator: intelligence estimate, J-2 staff estimate, intelligence annex | deep | READ, WRITE, DOCS, CheckCitations, STAFF | `mcp:intel-workbench` | (the person posted to the J2 position) |
| 2 | `requirements-manager` | PIR, IR and RFI management | standard | READ, WRITE, STAFF | `mcp:intel-workbench` | j2-chief |
| 3 | `collection-manager` | Collection plan and requests (recommends, never tasks) | standard | READ, WRITE | `mcp:intel-workbench`; later partner imagery search (read-only) | j2-chief |
| 4 | `jipoe-analyst` | JIPOE steps 1 and 2 (IPB steps 1 and 2 at tactical level) | deep | READ, WEB, WRITE, RenderSvg | `mcp:cop-map` (read, terrain layer write) | j2-chief |
| 5 | `geoint-analyst` | Terrain, weather, imagery, geospatial overlays | standard | READ, WEB, WRITE, RenderSvg | `mcp:cop-map` (terrain layer write) | jipoe-analyst |
| 6 | `osint-analyst` | Public-source collection against assigned requirements | standard | READ, WEB, WRITE | `mcp:intel-workbench` (source register) | j2-chief |
| 7 | `threat-analyst` | JIPOE steps 3 and 4: adversary evaluation and COAs | deep | READ, WEB, WRITE | `mcp:intel-workbench`, `mcp:cop-map` (threat layer write) | j2-chief |
| 8 | `watch-officer` | Current intelligence, indications and warning, INTSUM, INTREP | fast | READ, WEB, WRITE | `mcp:intel-workbench`, `mcp:cop-map` (read) | j2-chief |
| 9 | `target-analyst` | Target intelligence at system and function level (fictional scenarios only) | deep | READ, WRITE | `mcp:cop-map` (read) | threat-analyst |
| 10 | `red-cell` | Plays the adversary commander in the wargame; reverse JIPOE | deep | READ, WEB, WRITE | none | j2-chief |
| 11 | `tradecraft-reviewer` | Blocking analytic-standards gate (section 4.4) | deep | READ, CheckCitations, WebFetch, Write | `mcp:intel-workbench` (lint) | j2-chief |
| 12 | `release-guard` | Blocking release gate (section 4.2), with J2 compilation and releasability checks | standard | READ, Write (guard report only), STAFF | `mcp:guard-scan` | j2-chief |

**Instruction outlines**

- **j2-chief.** Job: turn the commander's guidance into intelligence direction; give the lead the lanes; integrate; recommend PIRs for approval; keep the PIR review in every cycle (02 T8). Owns: intelligence estimate, J-2 staff estimate, intelligence annex (letter from PROFILE.md: B, B or D), mission analysis brief input. Headings (estimate): Situation; Adversary capabilities; Adversary COAs in order of probability; Key judgements with likelihood terms; Intelligence gaps; Conclusions. Boundary: "Your output is the estimate and the annex, not the PIRs' approval and not collection tasking." Hands back: the estimate, annex, brief input, and the list of `DECISION FOR: commander` items (PIR approval).
- **requirements-manager.** Job: keep the PIR and IR register and RFI log; tie every PIR to a decision point and a latest time of value; break PIRs into indicators and specific information requirements; close answered PIRs (02 T9). Owns: PIR and IR register, RFI log (J2 entries in the shared RFI tracker). Headings: Requirement; Decision point supported; Indicators; Latest time of value; Status. Boundary: "Your output is the register, not a PIR the commander has approved." Hands back: register, RFIs to higher, proposed PIR changes. Logistics and operations information requirements from J4 and J3 enter here like any other requirement (02 s3.4).
- **collection-manager.** Job: match requirements to capabilities; build requirement to indicator to NAI to capability recommendations; avoid single-discipline reliance (02 T10). Owns: collection plan, collection requests. Headings: Requirement; Indicator; NAI; Recommended capability; Timing; Needs J3 approval or partner. Boundary: "Your output is a recommendation; the J3 approves asset allocation and you never task assets." Hands back: collection plan and requests.
- **jipoe-analyst.** Job: JIPOE steps 1 and 2 across all five domains, the electromagnetic spectrum and the information dimension (02 s3.2): limits of the operational environment, PMESII and ASCOPE, environment effects on both sides, avenues, key terrain. Owns: OE definition, environment effects products. Headings: Operational environment limits; Systems view; Effects on adversary; Effects on friendly forces; Gaps. Boundary: "Your output is steps 1 and 2, not adversary COAs." Hands back: products with graded sources and a gap list for requirements-manager.
- **geoint-analyst.** Job: MCOO or terrain effects, weather effects matrix, LOC and infrastructure overlays as GeoJSON (02 T12). Owns: COP terrain layer, weather effects matrix. Boundary: "Your output is terrain and weather analysis, not threat assessment." Hands back: overlays, matrices, imagery notes, each source graded.
- **osint-analyst.** Job: public collection against assigned requirements only; every item in the source register with URL, dates, reliability (A to F) and credibility (1 to 6) graded separately, origin and a deception note; never profile individuals in your own country (02 T12, Pitfall 11). Owns: source register entries, OSINT report. Boundary: "Your output is graded source material, not finished analysis." Hands back: register entries and report.
- **threat-analyst.** Job: JIPOE steps 3 and 4; start from existing threat models (the WEG for exercises); capabilities, COGs, adversary sensing and targeting of friendly forces; every adversary COA in probability order with situation template, COA statement and HVT list; MLCOA and MDCOA named; event template and matrix; analysis of competing hypotheses (02 T12, s3.2). Owns: adversary evaluation, adversary COA set, HVT list, event template and matrix, threat assessment. Boundary: "Your output is the adversary's options, not friendly COAs and not targeting decisions." Hands back: COA set, templates, HVT list, event matrix.
- **watch-officer.** Job: current intelligence and I&W; watch event-matrix indicators; one INTSUM per cycle; an INTREP whenever an indicator fires; cover competition below armed conflict (02 s3.2). Owns: INTSUM, INTREP, indicator board. Headings (INTSUM): Period; Significant activity; Assessment of intent; Changes since last; Gaps. Boundary: "Your output is facts and short assessments with likelihood terms, not new estimates." Hands back: INTSUM, INTREPs, new gaps.
- **target-analyst.** Job: target system analysis at system and function level; HVT analysis; intelligence on HPTs after the wargame; BDA inputs (02 T9). Owns: target intelligence product. Boundary: "Your output is intelligence on notional target systems in a fictional scenario, never a named real person or place and never an engagement recommendation." Hands back: HVT analysis, HPT intelligence, BDA inputs.
- **red-cell.** Job: play the adversary commander to win; action, reaction and counteraction against each friendly COA, first against the MLCOA then the MDCOA; reverse JIPOE of friendly forces for OPSEC and deception (02 T12; AJP-5 UK 2.15 b). Owns: red cell log. Boundary: "Your output is the adversary's play, not an independent critique of the plan (that is the red team)." Hands back: adversary log and lessons for the event template.
- **tradecraft-reviewer.** See section 4.4. Boundary: "You check; you never rewrite another member's judgement." Ends with exactly `SIGN-OFF` or `NOT READY` and numbered fixes.
- **release-guard (J2 variant).** See section 4.2, plus: compilation check (individually releasable items that together reveal more), releasability and tear-line preparation, dissemination list. Boundary: "You advise; a person releases." Ends with exactly `CLEARED` or `HOLD` with reasons.

**Lead workflow per step** (‖ means parallel lanes started in one turn; merges are done by j2-chief unless stated)

| Step (crosswalk #) | Lanes | Merge | Gate and handoff |
|---|---|---|---|
| 1 Start | j2-chief direction and time plan ‖ watch-officer baseline ‖ osint-analyst first sweep ‖ threat-analyst pulls existing threat models | j2-chief: initial RFIs | None; RFIs out |
| 2 Understand | jipoe-analyst ‖ geoint-analyst (steps 1 and 2) ‖ threat-analyst (step 3, then 4 once 1 to 3 are ready) ‖ requirements-manager (gaps to PIR candidates), then collection-manager | j2-chief: MA brief input, J-2 staff estimate draft | tradecraft-reviewer, then release-guard; to J5; PIRs as `DECISION FOR: commander` |
| 3 Build options | threat-analyst final COA set ‖ target-analyst HVT analysis ‖ red-cell prepares adversary play ‖ geoint-analyst mobility for friendly COAs | j2-chief | Gates; to J5 and J3 |
| 4 Test | red-cell plays adversary in the J5 wargame ‖ threat-analyst refines event template ‖ requirements-manager PIRs from decision points ‖ target-analyst HPT intelligence | j2-chief with J3: DST inputs | Gates; to J5, J3 |
| 5 Compare | j2-chief J-2 staff estimate per COA ‖ tradecraft-reviewer alternatives and assumptions check | j2-chief | To J5 |
| 6 Decide | None (human) | None | Decision recorded |
| 7 Write the plan | j2-chief annex and estimate ‖ collection-manager final plan ‖ release-guard dissemination plan ‖ watch-officer execution indicator board | j2-chief | Gates; annex to J5 plans-writer |
| 8 Execute and review | watch-officer INTSUM cycle ‖ requirements-manager PIR review ‖ threat-analyst COA updates | j2-chief | Evaluation and feedback |

Profile differences: US Joint uses the six-category intelligence process; NATO/Canadian uses the four-stage cycle (direction, collection, processing, dissemination) and CCIRM or IRM and CM (02 T2, T6), with JIPOE at joint levels. Tactical uses IPB names and the MDMP or APP-28 table (02 T4); with the Canadian nation setting the tactical section is the G2 (Land Operations, 2008). The J-2 intelligence estimate is appendix 11 to annex B under US Joint (JP 5-0, 2025).

**Level variants** (02 T14, plus the guard in every variant):

| Level | Members | Changes |
|---|---|---|
| Strategic | 9: j2-chief, requirements-manager, collection-manager (national and partner requests), jipoe-analyst (theatre systems view), threat-analyst, warning-analyst (replaces watch-officer: emerging and enduring warning problems; with the Canadian nation setting, answers CDS critical intelligence requirements), red-cell, tradecraft-reviewer, release-guard | Drops target-analyst and geoint-analyst (folded into jipoe-analyst); horizons in months and years |
| Operational | 12 (the team above) | Full JIPOE, annex, collection plan, targeting support, INTSUM cycle |
| Tactical, brigade or division | 7: s2-lead, ipb-analyst (all four IPB steps, OAKOC, MCOO), collection-manager (information collection plan), watch-officer, target-analyst (HPTL inputs), tradecraft-reviewer, release-guard | IPB and MDMP or APP-28 names; hours, not days |
| Tactical, battalion | 5: s2-lead, ipb-analyst, watch-officer, tradecraft-reviewer, release-guard | Finished products for company troop leading procedures (02 T4) |

The guard is never dropped.

**Handoffs** (02 s3.4)

| To | What J2 gives | What J2 needs back |
|---|---|---|
| J5 | JIPOE, adversary COAs, COGs, estimate, J-2 staff estimate, annex, red cell in the wargame | Friendly COAs for the wargame; decision points |
| J3 | Current intelligence and warnings, HVT analysis, event template and DST inputs, collection plan for allocation approval, BDA inputs, adversary intelligence capability for OPSEC | Approved allocation; operational reports; FFIRs |
| J4 | Terrain, weather and infrastructure effects on LOCs; threats to LOCs, ports and bases | Logistics information requirements |

### 3.3 J5 Plans (demo 2)

Based on 05 T3 to T6, with one change to fit the release-guard in 12: assessment is drafted by the design planner during planning and owned by the J3 assessment analyst in execution (shared product, section 4.3). This matches JTF J5 duties (recommend MOEs and MOPs, coordinate their adjustment with the J3) (05 T3).

**Team (operational level, 12 agents)**

| # | Slug | Job | Model for the job | Tools | MCP grants | Reports to |
|---|---|---|---|---|---|---|
| 1 | `lead-planner` | Chief of plans; planning group lead; wargame chief controller | deep | READ, WRITE, DOCS, STAFF | `mcp:orders`, `mcp:wargame` (in `mcp:staff-products`) | (the person posted to the J5 director position; the COS position above) |
| 2 | `policy-planner` | Strategy and policy; political-military analysis; interagency inputs; limitations with legal | deep | READ, WEB, WRITE | none | lead-planner |
| 3 | `design-planner` | Operational design (ADM at tactical level); assessment framework draft | deep | READ, WRITE, RenderSvg | none | lead-planner |
| 4 | `coa-cell-a` | COA development cell A | standard | READ, WRITE, RenderSvg | `mcp:cop-map` (read; plans layer write) | lead-planner |
| 5 | `coa-cell-b` | COA development cell B | standard | READ, WRITE, RenderSvg | `mcp:cop-map` (read; plans layer write) | lead-planner |
| 6 | `red-cell-seat` | J2 seat: adversary COAs and adversary play (replaced by the J2 team's red-cell in team-of-teams mode) | standard | READ, WRITE | none | lead-planner |
| 7 | `red-team` | Independent challenge of assumptions and logic | deep | READ, Grep, Write (critique file only) | none | none in the team (reports to the human COS) |
| 8 | `future-ops-seat` | J3 or J35 seat: force availability, branches, transition | standard | READ, WRITE | none | lead-planner |
| 9 | `sustainment-seat` | J4 seat: logistics estimate inputs, feasibility, sustainment annex inputs | standard | READ, WRITE | `mcp:logistics` (calculator, read) | lead-planner |
| 10 | `legal-support` | Assists the human legal adviser; drafts, never clears | standard | READ, WRITE | none | lead-planner |
| 11 | `plans-writer` | Plans and orders writer; wargame recorder; annex tracker | standard | READ, WRITE, DOCS | `mcp:orders` | lead-planner |
| 12 | `release-guard` | Blocking release gate | standard | READ, Write (guard report only), STAFF | `mcp:guard-scan` | lead-planner |

**Instruction outlines**

- **lead-planner.** Job: run the process and timeline (one-third, two-thirds at tactical level), give each COA cell a distinct theme before it starts, run the validity tests from PROFILE.md, control the wargame, integrate estimates, run the comparison against approved criteria (05 T6). Under US Joint, apply the five COA validity tests (suitable, feasible, acceptable, distinguishable, complete) and the comparison methods of JP 5-0 appendix E. Owns: planning timeline, warning orders, facts and assumptions ledger, proposed restated mission and proposed intent, mission analysis brief, DST and DSM drafts from the wargame, comparison matrix, COA decision brief content, CONOPS, sequel list, transition brief. Boundary: "Your output is a recommendation with risk, not a selected COA." Hands back: the step's products and the `DECISION FOR: commander` list.
- **policy-planner.** Job: analyse higher direction and policy; constraints and restraints with legal-support; strategic estimate and commander's estimate at strategic level; interagency inputs; IPR material (05 T3). Owns: guidance analysis, limitations list, strategic estimate (strategic level), interagency annex inputs. Boundary: "Your output is analysis of direction and policy, not operational design and not COAs." Hands back: those products.
- **design-planner.** Job: follow the operational design method of JP 5-0 (2025) (understand strategic direction, understand the OE, define the problem, identify assumptions, develop operational approaches, identify decisions and decision points, refine the approach, prepare planning guidance); COG analysis (critical capabilities, requirements, vulnerabilities); operational approach; lines of operation and effort; decisive points; objectives with their conditions and transitions (the term "military end state" only where the profile uses it: US Army, NATO/Canadian and the CFJP 5.0 reference); then the assessment framework (objective, effect, MOE, indicator; task, MOP) built from that design (05 T3, Pitfalls MOE and MOP). Under NATO/Canadian, operations design sits in mission analysis (AJP-5 3.19); at tactical level design is off unless the problem is ill-structured (05 Pitfalls). Owns: problem statement, COG analysis, operational approach graphic, LOO and LOE, assessment framework draft. Boundary: "Your output is the design and the measures, not COAs." Hands back: those products; the assessment framework transitions to the J3 assessment-analyst at step 7.
- **coa-cell-a and coa-cell-b.** Job: develop the COA in the theme the lead assigned, within the commander's guidance; statement and sketch, initial task organization, deployment concept; self-test against the profile's COA tests (05 T4). Owns: `coa-a` or `coa-b` files only. Boundary: "Your output is one distinct COA; you do not compare COAs." Their instructions differ by theme and file area, which keeps `teamCheck`'s overlap check quiet. Hands back: COA statement, sketch, tests passed or failed.
- **red-cell-seat.** As the J2 red cell (3.2) at reduced depth: enemy COAs first (CFJP 5.0 art. 404.4; AJP-5 3.45), adversary play in the wargame. Boundary: "Your output is the adversary's view, not a critique of our plan."
- **red-team.** Job: challenge assumptions, logic, bias and analogies at the end of mission analysis and after each wargame; check for bias toward a favourite COA (05 T6 steps 2a, 4a). Owns: `red-team-critique` only; no write access to plan files. Boundary: "Your output is critique; you never fix the plan." Under NATO/Canadian the member's description says red teaming is a UK national element, not NATO doctrine, and the commander may switch it off. Hands back: numbered findings; dissent is shown in the decision brief, never dropped.
- **future-ops-seat.** Job: force availability in mission analysis; friendly manoeuvre in the wargame; the branch list with triggers; transition brief with the lead (05 T3). Owns: branch list (planning), transition checklist. Boundary: "Your output is branches; sequels belong to the lead-planner." In team-of-teams mode the J3 future-ops-planner takes this seat.
- **sustainment-seat.** Job: logistics estimate inputs, feasibility per COA, consumption per COA from user-entered factors through the calculator, sustainment annex inputs. Boundary: "Your output is feasibility evidence, not the concept of support (the J4's)." Replaced by the J4 log-plans-officer in team-of-teams mode.
- **legal-support.** Job: draft legal considerations for limitations, ROE requests, COAs and the plan for the human legal adviser; list questions for that adviser (05 T3). Owns: legal input drafts. Boundary: "Your output is a draft for a qualified legal adviser to review; it is never legal advice and never clears anything." Every product carries `LEGAL REVIEW REQUIRED`.
- **plans-writer.** Job: record the wargame; assemble the base plan or order in the profile's format; keep the annex tracker (owner, status, letter from the profile); consistency and cross-reference checks across annexes (05 T3). Owns: base plan or order, annex tracker, wargame record, brief decks. Boundary: "Your output is the assembled document; annex content belongs to its owners." Hands back: assembled plan with an open-items list.
- **release-guard.** Section 4.2.

**Lead workflow per step** (05 T6, adapted)

| Step | Lanes | Merge | Gate |
|---|---|---|---|
| 1 Start | lead-planner timeline and warning order ‖ policy-planner guidance analysis ‖ design-planner initial framing ‖ red-cell-seat starts JIPOE or IPB inputs | lead-planner | Commander's initial guidance (human) |
| 2 Understand | Every member writes its estimate in its own file at once; design-planner COG and approach; policy-planner and legal-support limitations; sustainment-seat logistics inputs; design-planner evaluation criteria and assessment draft | lead-planner integrates facts, assumptions, tasks, proposed restated mission and intent | red-team review in parallel with the integration; then guard; MA brief; commander approves restated mission and issues guidance (human) |
| 3 Build options | coa-cell-a ‖ coa-cell-b ‖ red-cell-seat enemy COAs ‖ future-ops-seat and sustainment-seat feasibility checks | lead-planner validity tests; merges or reshapes COAs that are not distinct (one integrator, not parallel) | US: commander guidance on COAs to analyse; NATO/Canadian: commander's guidance for refinement of tentative COAs (AJP-5 3.51) |
| 4 Test | Sequential within a COA (turn order matters); COAs wargamed one after another against the same adversary COAs; plans-writer records | lead-planner: sync matrix, DST, DSM drafts, branches | red-team after each COA |
| 5 Compare | Members score their functional criteria at once | lead-planner | None |
| 6 Decide | plans-writer builds the decision brief; lead-planner recommends | None | **Commander decides.** Agents never select |
| 7 Write the plan | plans-writer base ‖ each annex owner in its own file (other sections' annexes arrive as products) ‖ future-ops-seat branches | lead-planner integration pass, plans-writer consistency check | Guard; commander signs; NATO/Canadian: CONOPS approval by higher before the full plan (AJP-5 Stage 4; CFJP 5.0 art. 405) |
| 8 Transition and review | lead-planner and future-ops-seat transition brief ‖ design-planner hands assessment framework to J3 | lead-planner | J3 accepts the plan (human) |

**Level variants** (05 T5 scaling): strategic keeps policy-planner deep, adds IPR decks, future-ops-seat becomes a component and supporting command seat; tactical renames to G or S codes, folds policy-planner into lead-planner and adds a `fires-seat`; an MDO option replaces coa-cell-b with a `convergence-planner` (domain rows and windows of opportunity in the sync matrix, 05 s2). At brigade the template is labelled "S-3 plans cell", never "S-5" unless the user sets it (05 Pitfalls).

**Handoffs**: J2 provides JIPOE, adversary COAs and the red cell; J3 receives the approved plan at transition, the DST and DSM, the sync matrix and the assessment framework; J4 provides the logistics estimate and writes the logistics annex. Sequels stay with J5; branches go to J3 future operations (03 A3; 05 T3).

### 3.4 J3 Operations (demo 3)

Based on 03 A9 to A12. Two changes: ROE requests are drafted by the j3-director with legal review (the prototype's separate ROE officer did not fit; legal interpretation is a human legal adviser's, 00 s2); the battle rhythm calendar is the joc-chief's in a standalone J3 and the chief of staff's in the full staff.

**Team (operational level, 12 agents)**

| # | Slug | Job | Model for the job | Tools | MCP grants | Reports to |
|---|---|---|---|---|---|---|
| 1 | `j3-director` | J3 integrator: running estimate, CCIR proposals, operations annex, ROE request drafts | deep | READ, WRITE, DOCS, STAFF | `mcp:orders`, `mcp:cop-map` (read) | (the person posted to the J3 director position) |
| 2 | `joc-chief` | Current operations: COP, event log, shift brief, battle drills, battle rhythm (standalone) | standard | READ, WRITE, STAFF | `mcp:cop-map` (operations layer write, merge), `mcp:joc-log`, `mcp:battle-rhythm` | j3-director |
| 3 | `watch-officer` | Logs reports, checks against CCIR and DSM triggers (may run as two instances) | fast | READ | `mcp:joc-log` (append), `mcp:cop-map` (read) | joc-chief |
| 4 | `future-ops-planner` | J35: branches, FRAGO drafts, DST and DSM in execution, sync matrix in execution | deep | READ, WRITE | `mcp:orders`, `mcp:staff-products` (sync matrix, DSM) | j3-director |
| 5 | `fires-effects-coordinator` | Concept of fires; fires appendix; targeting working group | deep | READ, WRITE | `mcp:staff-products` (targeting workbook) | j3-director |
| 6 | `targeting-officer` | Notional target list and working group products; combat assessment tracking | standard | READ, WRITE | `mcp:cop-map` (read), targeting workbook | fires-effects-coordinator |
| 7 | `information-planner` | Information activities synchronization | deep | READ, WRITE | `mcp:battle-rhythm` (read) | j3-director |
| 8 | `cyber-space-planner` | Cyber and space support requests, lead times, convergence windows | standard | READ, WRITE | none | j3-director |
| 9 | `airspace-maritime-liaison` | Airspace and maritime coordination needs and conflicts | standard | READ, WRITE | `mcp:cop-map` (read) | j3-director |
| 10 | `assessment-analyst` | Assessment cell: MOE and MOP register, data plan, assessment brief | deep | READ, WRITE, RenderSvg | none | j3-director |
| 11 | `liaison-coordinator` | LNO list, shared RFI tracker, suspense dates | fast | READ, WRITE | `mcp:staff-products` (RFI tracker) | j3-director |
| 12 | `release-guard` | Blocking release gate | standard | READ, Write (guard report only), STAFF | `mcp:guard-scan` | j3-director |

**Instruction outlines**

- **j3-director.** Job: synchronize to intent and battle rhythm; consolidate running estimates (one section per joint function: C2, information, intelligence, fires, movement and maneuver, protection, sustainment, from JP 1 Volume 1, 2023; with the Canadian nation setting, the five operational functions Command, Sense, Act, Shield, Sustain; 03 A2); propose CCIR; draft paragraph 3 and the operations annex (letter from PROFILE.md: C, C or A); draft ROE requests with `LEGAL REVIEW REQUIRED` (CAF reference annex E). Owns: J3 running estimate, CCIR register proposals, operations annex, ROE request matrix. Boundary: "Your output is options with risk; you never approve, release or decide." Running estimates must contain recommendations for anticipated decisions or the director rejects them (03 A14 item 8).
- **joc-chief.** Job: own the COP operations layer and merge the other layers into the published COP; event log; shift brief; battle drills from checklists; escalate any CCIR match at once; immediate FRAGO drafts for human release. Owns: COP (merge), event log, shift brief, battle rhythm calendar (standalone). Boundary: "Your output is the current picture and drafts; FRAGO release is a human's."
- **watch-officer.** Job: log reports in standard format (DTG, source, what was reported), match against CCIR and DSM triggers, flag matches. Boundary: "Your output is facts, never interpretation" (03 A14 item 7). Tools exclude Write: it appends only through `mcp:joc-log`.
- **future-ops-planner.** Job: branches inside the future-operations horizon; DSM current; FRAGO drafts; request J2 and J4 checks for each branch; hand sequels to J5 (03 A3). Owns: branch plans, sync matrix and DST and DSM in execution. Boundary: "Your output is branches; sequels are the J5's."
- **fires-effects-coordinator.** Job: integrate fires and non-lethal effects into the concept of operations; run the targeting working group; prepare board packages. Owns: concept of fires, fires appendix (Army: Annex D), board packages. Boundary: "Your output is a package carrying `DECISION FOR: commander or delegate` and `LEGAL REVIEW REQUIRED`; you never nominate or approve real targets" (03 A11).
- **targeting-officer.** Job: keep the notional target list and working group products; track combat assessment with the J2; check every entry against the no-strike and restricted lists the human supplies. Boundary: "Notional entries in the exercise box only."
- **information-planner.** Job: synchronize information activities (enable, protect, inform, influence, attack, from ADP 3-13) with operations; NATO/Canadian vocabulary uses information operations at joint level (annex O in the CAF reference list) and, with the Canadian nation setting at tactical level, influence activities (CADN 16-01). Boundary: "Draft inputs only; any outward-facing message needs human and public affairs approval" (03 A5).
- **cyber-space-planner.** Job: turn needs into support requests to supporting commands; track lead times and convergence windows. Space requests use the JP 3-14 (2023) mission areas only (space domain awareness, offensive and defensive space operations, PNT, ISR, SATCOM, environmental monitoring, missile warning, nuclear detonation detection, spacecraft operations, spacelift) and name the space products they feed (the space operations directive, master space plan and the weekly combined space tasking order are the space command's, never this member's). Never use the retired terms space control, counterspace, space negation or space coordinating authority. Boundary: "State plainly when capability details are unknown or not public; never guess them" (03 A5).
- **airspace-maritime-liaison.** Job: collect airspace and maritime coordination needs from all lanes and the J4 (resupply flights), flag conflicts, prepare requests for the responsible human authority. Boundary: "Requests, not control measures."
- **assessment-analyst.** Job: take the J5's assessment framework at transition; run the assessment working group; recommend changes with evidence; data separated from judgement (03 A6). Owns: MOE and MOP register, data plan, assessment brief. Boundary: "Assessment, not new plans."
- **liaison-coordinator.** Job: track LNOs, RFIs and suspenses across sections; chase overdue items. Owns: the shared RFI tracker. Boundary: "You never answer an RFI for another section."
- **release-guard.** Section 4.2.

**Lead workflow per step** (03 A12)

| Step | Lanes | Merge | Gate |
|---|---|---|---|
| 1 Start | j3-director warning order inputs and timeline ‖ joc-chief keeps current operations running | j3-director | None |
| 2 Understand | Every member writes its initial running estimate at once; fires, information, cyber and space list capabilities and limits; liaison-coordinator opens the RFI tracker | j3-director: CCIR proposal, consolidated estimate | Guard; CCIR as `DECISION FOR: commander` |
| 3 Build options | Supports J5 cells: fires concept per COA ‖ cyber-space lead times ‖ future-ops force checks | j3-director | To J5 |
| 4 Test | Wargame support against the J2 red cell; fires and future-ops at the table ‖ assessment-analyst refines measures with J5 | J5 lead-planner owns the wargame outputs | None |
| 5 Compare | Score J3 criteria | j3-director | To J5 |
| 6 Decide | Decision brief inputs | None | Human |
| 7 Write the plan | j3-director operations annex ‖ fires appendix ‖ information inputs ‖ assessment annex (Army M) | j3-director | Guard; to J5 plans-writer; transition brief accepted by a human J3 |
| 8 Execute | Battle rhythm loop: watch-officer report, CCIR or DSM trigger, future-ops branch, FRAGO draft, human release; assessment cycle | joc-chief (COP), j3-director (estimate) | Every FRAGO through the release state machine |

**Level variants** (03 A13): strategic keeps 12 with campaigning and competition activities; tactical about 9 (merge information-planner with cyber-space-planner, and airspace-maritime-liaison with liaison-coordinator; battle captain and battle NCO wording; convergence-window tracker for MDO).

**Handoffs** (03 A9): to J2 operational priorities for collection, contact reports; to J5 execution feedback for sequels; to J4 priorities of support, and the J4 returns sustainment feasibility, logistics decision points for the DSM and LOGSTAT summaries for the COP.

### 3.5 J4 Logistics (demo 4)

Based on 03 B2, B7 to B10. Seven core functions, one member each (03 Summary 3).

**Team (operational level, 12 agents)**

| # | Slug | Job | Model for the job | Tools | MCP grants | Reports to |
|---|---|---|---|---|---|---|
| 1 | `j4-director` | J4 integrator: logistics running estimate, concept of support, logistics annex | deep | READ, WRITE, DOCS, STAFF | `mcp:orders` | (the person posted to the J4 director position) |
| 2 | `log-plans-officer` | Theatre logistics overview, logistics estimate, supportability per COA, logistics decision points | deep | READ, WRITE | `mcp:logistics` (calculator, movement read) | j4-director |
| 3 | `jloc-chief` | Logistics current operations: LOGSTAT consolidation, LOGCOP layer, logistics sync matrix | standard | READ, WRITE, STAFF | `mcp:logistics` (logstat), `mcp:cop-map` (logistics layer write) | j4-director |
| 4 | `supply-planner` | Classes of supply, days of supply, forecasts, critical items | standard | READ, WRITE | `mcp:logistics` (calculator, logstat read) | j4-director |
| 5 | `maintenance-planner` | Readiness summary, recovery, repair parts, maintenance concept | standard | READ, WRITE | `mcp:logistics` (readiness import) | j4-director |
| 6 | `mobility-planner` | Deployment, distribution, movement control, JRSOI | deep | READ, WRITE | `mcp:logistics` (movement), `mcp:cop-map` (read) | j4-director |
| 7 | `engineer-planner` | Engineering support to sustainment: LOCs, infrastructure, base camps | standard | READ, WRITE | `mcp:cop-map` (read) | j4-director |
| 8 | `ocs-planner` | Operational contract support requirements and review packages | standard | READ, WRITE | none | j4-director |
| 9 | `health-services-planner` | Assists the human surgeon: medical concept of support, patient movement concept | deep | READ, WRITE | `mcp:logistics` (calculator, notional rates) | j4-director |
| 10 | `services-mortuary-planner` | Field services and mortuary affairs concepts | standard | READ, WRITE | `mcp:cop-map` (read) | j4-director |
| 11 | `logstat-analyst` | Validates LOGSTATs against definitions and plausibility rules | fast | READ | `mcp:logistics` (logstat validate) | jloc-chief |
| 12 | `release-guard` | Blocking release gate, with J4 extras | standard | READ, Write (guard report only), STAFF | `mcp:guard-scan` | j4-director |

**Instruction outlines**

- **j4-director.** Job: keep the force supported to the commander's priorities; sustainment feasibility per COA and branch; logistics CCIR proposals; concept of support; the logistics annex with the letter from PROFILE.md (joint D, Army F, NATO/Canadian R with S for movements). Boundary: "You never commit resources, sign contracts or approve priorities." Hands back: estimate, concept, annex, decisions for humans.
- **log-plans-officer.** Job: theatre logistics overview and logistics estimate from step 1, because support planning runs alongside force planning (03 B3); supportability screen per COA; logistics wargame (consumption per COA and phase); logistics decision points into the DSM through a proposal. Boundary: "Every number comes from a calculator call that shows its formula and user-entered factors" (03 B12 item 1).
- **jloc-chief.** Job: logistics watch: LOGSTAT in, validate (through logstat-analyst), consolidate, forecast, LOGCOP, exceptions to the JOC; logistics sync meeting. Canadian nation setting: weekly logistics and ammunition reports (03 B6). Name it "JTF J4 JLOC", never just "JLOC" (03 B4). Boundary: "Escalate shortfalls that match CCIR; never change priorities."
- **supply-planner.** Job: forecast by class and days of supply from user factors; compare forecast with reported use; name critical items. Boundary: "No invented rates; no government factor tables."
- **maintenance-planner.** Job: readiness, recovery, parts constraints. Boundary: "Recommend priorities; never set them."
- **mobility-planner.** Job: deployment and distribution concept; feasibility of notional movement tables (lift, ports, timing against required dates); JRSOI concept; routes coordinated with the J3 airspace liaison (03 B4). Boundary: "Notional movement tables only; never build or import a TPFDD; never claim real lift or port data."
- **engineer-planner.** Job: infrastructure and LOC support; coordinate with the J3 and the J2 for infrastructure information. Boundary: "Sustainment engineering, not mobility and countermobility for the scheme of manoeuvre."
- **ocs-planner.** Job: turn shortfalls into contract support requirements and review packages for the human board; host-nation support needs. Boundary: "Never select vendors or commit funds."
- **health-services-planner.** Job: draft the medical concept of support and patient movement concept with notional rates the user enters. Boundary: "Your output assists a qualified surgeon and medical planner; it is never medical advice or a clinical decision." Every output carries `SURGEON REVIEW REQUIRED`.
- **services-mortuary-planner.** Job: field services; mortuary affairs concept (collection points, evacuation flow, personal effects procedures) in respectful plain language. Boundary: "No personal data, ever."
- **logstat-analyst.** Job: validate each report against definitions and plausibility rules (no fuel above capacity, consistent "on hand"); flag errors to the sender. Boundary: "Never fix numbers silently."
- **release-guard (J4 variant).** Section 4.2, plus: block real stock levels, real unit holdings and real contract values.

**Lead workflow per step** (03 B10)

| Step | Lanes | Merge | Gate |
|---|---|---|---|
| 1 Start | log-plans-officer theatre overview ‖ jloc-chief stock baseline (notional) ‖ mobility-planner infrastructure scan | j4-director | None |
| 2 Understand | Seven functional planners assess their areas at once, from one shared task list and force list | log-plans-officer then j4-director: logistics estimate, constraints, critical shortfalls | Guard; to J3 and J5 |
| 3 Build options | Supportability screen per COA, one planner per function ‖ calculator runs per COA | log-plans-officer | To J5 |
| 4 Test | Logistics wargame: consumption per COA and phase ‖ distribution timeline ‖ decision points | log-plans-officer | Proposals to the DSM owner |
| 5 Compare | Score logistics criteria | j4-director | To J5 |
| 6 Decide | Sustainment risk brief | None | Human |
| 7 Write the plan | Concept of support ‖ functional appendices in parallel ‖ Canadian SUPLAN inputs | j4-director | Guard; annex to plans-writer |
| 8 Execute | JLOC loop: jloc-chief ‖ logstat-analyst continuous; planners called for branches | jloc-chief | Exceptions to the JOC |

**Level variants** (03 B11): strategic 12 (global distribution, strategic estimate; Canadian fourth line); tactical about 9 (merge engineer-planner into mobility-planner, services-mortuary-planner into supply-planner; LOGSTAT out to 72 hours; Canadian first and second line).

**Handoffs** (03 B7): to J3 feasibility per COA and branch, logistics decision points, LOGSTAT exceptions, Class V and III demand signals; to J5 feasibility of plans and sequels, long-lead items; from J2 threat to LOCs, ports and stocks.

---

## 4. Shared mechanisms

### 4.1 Staff products and the release state machine

> **Coherence review (2026-11-20):** a person's approval is signed by that person's device key or, from Phase 71, credential, never by "the device key that signs the policy bundle", because the organization will sign the policy. Who may decide lives on the position the person holds (assigned positions design, 3.1). See `.planning/research/coherence/REVIEW.md`, conflicts K18 and K34.

**Product header** (YAML at the top of each product file):

```yaml
product: intelligence-estimate
section: j2
owner: j2-chief
profile: us-joint          # profile and level it was written under
level: operational
version: 3
state: awaiting-decision
label: org/Internal        # from the Phase 70 label map; exercise data only; shown as "Organization: Internal"
decision_for: commander    # a position; the person posted to it is recorded on approval
depends_on: [jipoe-steps-1-2@2, adversary-coas@4]
guard: { verdict: CLEARED, at: 2026-11-18T14:02Z, report: guard/intelligence-estimate-v3.md }
```

**States and transitions**

| From | To | Trigger | Who may trigger | Guard condition |
|---|---|---|---|---|
| (none) | draft | Owner writes the first version | The owning member, through `staff-products.propose` | Writer is the product's owner |
| draft | guard-checked | Release-guard verdict `CLEARED` (and for J2, tradecraft `SIGN-OFF` first) | Release-guard member through `staff-products.verdict` | Verdict refers to this exact version hash |
| draft | draft (held) | Guard verdict `HOLD` or tradecraft `NOT READY` | Guard or tradecraft member | Reasons recorded |
| guard-checked | awaiting-decision | Owner or the section's integrator submits for decision | Owner, the section integrator, or the person holding the section's position | Product names `decision_for` (a position) |
| guard-checked or awaiting-decision | draft | Any edit to the file | Anyone (detected by hash) | Version incremented; earlier verdicts void |
| awaiting-decision | approved | A person approves | **Only a named human, through the UI or a command** | The person holds the `decision_for` position (before the project is shared, the local person holds every position); signed by that person's device key, or credential from Phase 71; person, position and name recorded; not callable as a tool. *Superseded 2026-11-20 (coherence review): this cell first read "Person identified by the device key that signs the policy bundle", which breaks once your organization signs the policy (K34).* |
| awaiting-decision | rejected | A person rejects, with reasons | Only a named human | Reasons required |
| rejected | draft | Owner revises | Owner | Rejection reasons linked |
| approved | released | A person releases (may be the same act as approval for products marked "release on approval") | Only a named human | Approved version hash unchanged |
| released | superseded | A newer version of the same product is released | Only a named human | Old version kept read-only |
| any non-terminal | withdrawn | Owner or a person withdraws | Owner or a person | Reason recorded |

Rules:
- The approve, reject and release verbs exist only as VS Code commands and UI actions. `staff-products` exposes `propose`, `verdict`, `submit`, `withdraw`, `status` and `list` to agents; its capability manifest declares no `approve`. A test proves an agent run cannot reach them through any tool, MCP server or shell command that edits the header (the header is checked against the decision log, so a hand-edited `state: approved` without a matching signed record reads as `draft (tampered)`).
- Every transition is a record in the existing decision log (`src/domain/gate/record.ts`) with product, version hash, from, to, actor (member or person) and reason. Approvals are signed with the person's device key. Until Phase 71, the identity is self-declared and the UI says so with the existing `CLEARANCE_SELF_ASSERTED_TEXT` wording.
- Downstream products that depend on a product whose approved version changes get a "source changed" mark and drop back to draft only when their owner accepts the change (00 s1, product lifecycle). Dependency propagation is what keeps a figure from going stale when a fact changes (the research team's derived-values rule).

> **Coherence review (2026-11-20):** records follow the two families of ADR-011. In a shared staff project every transition and every approval is a replica entry signed by the writer's device key; on a single computer the transition goes to the local audit record (hash-chained, with periodic signed heads once that lands) and the approval itself carries the person's device signature, as decided in Q10. Who may approve is read from the position, not from a role string: `decision_for` names a position, and the approval is valid only if the signer is posted to it when signing (positions and the one delegation rule from Phase 33.1). Approve, Reject and Release stay commands for security reasons but appear only in staff projects (`when: nearAi.staffProject`). See `.planning/research/coherence/REVIEW.md`, conflicts K18, K21, K25 and K35.

**Tests** (WP-SHARED): one test per row of the table (allowed transition succeeds and is recorded), one per forbidden transition (agent approve, approve without guard, release without approval, approval of a stale hash, edit after approval, tradecraft skipped for J2, rejected without reasons, guard verdict for another version), tamper detection, reload persistence, and dependency propagation.

### 4.2 Release-guard (one per team)

Common instructions (each team adds a short variant):
- Run `guard-scan` on the product first (deterministic checks), then review what the scan cannot judge.
- Hold if the product contains: classification or caveat markings of any scale (TOP SECRET, SECRET, CONFIDENTIAL used as a marking, NATO RESTRICTED and above, PROTECTED B or C, CUI, "EYES ONLY", "REL TO" and the like); coordinates outside the project's exercise box; names on the project's real-entity list (user-supplied: real units, people, bases); text matching a restricted-doctrine fingerprint list (titles that are not public, such as JP 3-04); a decision written as made rather than marked `DECISION FOR: <role>`; numbers in J4 products with no calculator record; personal data.
- Check compilation: whether releasable items together reveal more (EO 13526 section 1.7(e); the Canadian guidance that a bundle may be more sensitive than its parts) (02 Pitfall 10; 05 s6). A suspected compilation is a `HOLD` with the question for a person with authority.
- Write `CLEARED` or `HOLD` with numbered reasons to `guard/<product>-v<n>.md`. Never edit the product.
- Boundary: "Your output is a verdict and reasons; you never release and you never fix."

`guard-scan` is deterministic and local (section 6.2), so the guard is not a single point of model judgement. The model review covers what rules cannot (implicit decisions, compilation).

> **Coherence review (2026-11-20):** every check that compares a label (the guard's markings, the product's label against the template ceiling, the observation checks) ranks it with the one label service (`dominates`, `join`, `atLeast`) over the active policy's scale table, never the shipped `SCALE_PRESETS`; the presets are only the fallback when the policy failed closed. Labels in guard reports are shown as scale name plus level ("Canada, Classified: Confidential", never a bare "Confidential"), and the organization scale's Confidential level is displayed as "Sensitive" (id unchanged). See `.planning/research/coherence/REVIEW.md`, fixes S7 and S8, and owner question Q8.

### 4.3 Shared products and owners

Single writer per product; others propose entries in `.planning/staff/proposals/<product>/` and the owner merges. In a standalone section team, the owning member is the seat member named in brackets.

| Product | Owner (full staff) | Contributors (by proposal) | Readers | Notes |
|---|---|---|---|---|
| COP: published picture | J3 joc-chief (merges layers) | Layer owners below | All | `cop-map` holds one GeoJSON file per layer plus an event log (03 A5) |
| COP operations layer | J3 joc-chief | J3 members | All | |
| COP threat layer | J2 threat-analyst | geoint-analyst, watch-officer | All | |
| COP terrain layer | J2 geoint-analyst | jipoe-analyst | All | |
| COP logistics layer (LOGCOP) | J4 jloc-chief | J4 planners | All | |
| COP plans layer (COA sketches) | J5 lead-planner | coa cells | All | Plans layer never merges into the current picture |
| CCIR register | J3 j3-director proposes the whole; PIR part from J2 requirements-manager; FFIR part from J3 | J4 logistics CCIR | All; watch-officer and jloc-chief monitor | The commander approves (release state machine) |
| Synchronization matrix | J5 lead-planner during planning (plans-writer records); J3 future-ops-planner from transition | All sections | All | Transition is a recorded event |
| DST and DSM | J5 lead-planner from the wargame; J3 future-ops-planner in execution | J2 threat-analyst (NAIs, indicators), J4 log-plans-officer (logistics decision points) | All | The DSM becomes the JOC trigger table: decision point, indicator, NAI, recommended action, decision maker (03 A6) |
| RFI tracker | J3 liaison-coordinator | Every section | All | Section entries owned by their section (J2 requirements-manager for intelligence RFIs) |
| Assessment plan | J5 design-planner in planning; J3 assessment-analyst in execution | J2 indicators | All | Annex N (Assessments) under US Joint; the six operation assessment steps of JP 5-0 (2025) appendix H |
| Facts and assumptions ledger | J5 lead-planner | All | All | Status per assumption, invalidation trigger, owner |
| Annex tracker | J5 plans-writer | Annex owners | All | Letters from the profile |
| Battle rhythm calendar | Chief of staff (full staff); J3 joc-chief (standalone) | J4 events, J2 cycles | All | `.ics` through `battle-rhythm` |
| Running estimates | Each section integrator | Its members | All | |

### 4.4 The J2 tradecraft gate

Two parts, both blocking, in this order: tradecraft, then release-guard.

1. **Mechanical lint** (`intel-workbench.lint`): only ICD 203 likelihood terms or their alternatives (almost no chance to almost certain, with ranges, 02 T10); no likelihood term and confidence level in the same sentence; every key judgement marked as judgement, every fact sourced; every source has a reliability grade (A to F) and a credibility grade (1 to 6) recorded separately, an origin and dates; two reports with the same origin never count as independent confirmation; every PIR has a decision point and latest time of value; every HVT appears in an adversary COA; MLCOA and MDCOA both named.
2. **Reviewer judgement** (`tradecraft-reviewer`): the ICD 203 analytic standards (objectivity, independence from political considerations, timeliness, all available sources, the tradecraft standards) and tradecraft standards (sourcing, uncertainty, distinguishing information from assumptions and judgements, alternatives, relevance, logical argument, explaining changes in judgement, accuracy, visual information); key assumptions check and devil's advocacy on key judgements (02 T10, s3.7 item 8).

NATO/Canadian profile: same gate; the grading table follows AJP-2.1 (the older Canadian text reads credibility 1 as "confirmed by other sources", 02 T10). Output: `SIGN-OFF` or `NOT READY` with numbered fixes, recorded as a verdict on the exact version.

### 4.5 What the UI needs (data and events, not screens)

Screens belong to the separate UX concept. The UI needs these read models and events, all written to the project state so they survive reloads and are available to Team Live and Agent Activity:

> **Coherence review (2026-11-20):** there is one run view. The Staff Room is its staff layout (the command reads "Watch the Run"), and Agent Activity stays as history and export, so the read models below feed one view, not three. Every agent card, product row and count uses the one trust line (Runs on, Verified, Allowed) from `TrustFacts`: the Staff Room's "18 of 18" reads "18 of 18 agents verified". The decision queue shows the `decision_for` position and, once the project is shared, the person posted to it. Every staff screen shows whether the project is an exercise (section 7, item 9). See `.planning/research/coherence/EXPERIENCE.md`, sections 3 and 6.

| Read model | Fields |
|---|---|
| Staff run | run id, team or team-of-teams tree, profile, level, nation, exercise flag, current crosswalk step per section, started, cost so far |
| Step board | per section: step, lanes (member, status, product), merge status, gate status |
| Product registry | product, section, owner, version, state, label, decision_for, depends_on, guard and tradecraft verdicts, source-changed flag |
| Decision queue | product, version, decision_for position (and the person posted to it), options with risk, dissent (red team), requested at, deadline from the timeline |
| Shared registers | CCIR, RFI tracker, sync matrix, DSM, assumptions ledger, annex tracker |
| COP | layers, owners, last update, event log tail |

| Event | Payload |
|---|---|
| `staff.step.entered` | run, section, step, profile names for the step |
| `staff.lane.started` / `.finished` | run, section, member, product, outcome |
| `staff.merge.started` / `.conflict` / `.resolved` | run, section, branches, files, who resolved |
| `staff.product.state` | product, version, from, to, actor, reason |
| `staff.gate.verdict` | product, version, gate (tradecraft or guard), verdict, reasons |
| `staff.decision.requested` / `.recorded` | product, version, role, person (on record), decision |
| `staff.rfi.opened` / `.answered` / `.overdue` | RFI id, from, to, suspense |
| `staff.ccir.triggered` | CCIR id, report, member, time |
| `staff.cop.updated` | layer, owner, feature count, change summary |
| `staff.team.nested` | parent run, child run, team reference, state (section 5) |
| `staff.waiting` | member, section waited on, what is needed |

### 4.6 Amplifying the staff, not replicating it

What these teams do that a human staff cannot do at the same speed, and which the demos should show:
- **All estimates at once.** Every section's mission analysis estimate runs in parallel lanes in minutes, with the integrator merging, instead of a sequential staff cycle.
- **Mechanical cross-checks no tired staff officer runs**: every PIR tied to a decision point; every HVT in a COA; every annex with an owner and the right letter; every number with a formula; every assumption with an invalidation trigger.
- **Change propagation.** When a fact or assumption changes, every product built on it is marked and its owner told, the moment it changes.
- **Wargame ledger to products.** The recorded wargame produces the sync matrix, DST, DSM and branch list directly rather than being retyped.
- **A decision queue for the commander** with options, risk and dissent side by side, so command time (the scarcest resource, 03 A4) is spent on decisions only.
- **Running estimates that stay running** through the battle rhythm loop in execution.

---

## 5. Team of teams (extension feature)

### 5.1 Need

A team holds at most 12 members (`parseTeam`). A joint staff has nine J sections, special staff and a command group, each with up to 12 members. Today a member can start sub-agents only from the run's own agent pool (`agentSession.ts`: a member with `Agent` in its tools spawns from the same pool). So a full staff needs a member that **is** another team.

### 5.2 Team file syntax

Two new optional member lines, parsed like `role:` (backward compatible: an older build reads them as the first line of the instructions, so they come after `tools:` and before `privacy:`, which stays last):

```markdown
## j2
role: J2 intelligence section
team: j2-intelligence
pin: 4f1c9a02d7e3b6aa
privacy: private

Lead the J2 section for this staff run. Report the section's products and decisions.

## red-cell
role: J2 red cell in the planning group
uses: j2-intelligence/red-cell
pin: 77ab01c3e9f0d211
```

- `team: <slug>` makes the member a **team reference**: spawning it starts a nested team run whose lead gets `teamLeadPrompt` for the referenced team, with the member's own instructions as the tasking.
- `uses: <team>/<member>` makes the member a **borrowed member**: its role, tools, model and instructions come from that member of the other team. This is how a JPG team takes J2's red cell and J4's plans officer without duplicating them.
- `pin:` is the referenced team's fingerprint, written by Team Studio when the reference is made (the same fingerprint scheme as `projectTeamAllowed`). A changed referenced team asks again before it runs.

### 5.3 Rules

| Rule | Value |
|---|---|
| Depth | A staff run may start team references; a nested team may not start further references (depth 2). A borrowed member may not itself be a reference |
| Size | Each team still has at most 12 members; a reference counts as one |
| Cycles | A reference graph with a cycle is refused at parse and at run |
| Consent | A referenced team must be one of the person's teams or an approved import (`libraryTeamAllowed`); an unapproved one asks first; a declined one refuses the reference, and the parent run continues without that section |
| Privacy | Strictest wins: a private parent makes every nested team private; a private nested team stays private under a parent that is not. "Private" is the gate's verified floor in `decideRoute` for every nested run (coherence review, S4) |
| Cost | `nearAi.agent.maxRunCostUsd` and the daily limit apply to the whole tree; each nested run shows its own spend |
| Concurrency | The existing "waiting for a free slot" queue applies across the tree; a new setting caps nested teams running at once (default 4) |
| Unattended | Nested team runs follow the gate contexts of the parent; MCP tools in nested runs still need `unattendedMcp` |
| Worktrees | Each nested team works on its own branch `staff/<run>/<section>`; its members' worktrees merge into that branch first (two-level merge); the parent run's coordinating agent merges sections one at a time, conflicts to the owning section |
| Gate | The Agent tool's manifest gains an effect for a team reference (`spawn` with agent `team:<slug>`) so every nested start is recorded |

### 5.4 State machine for one team reference

| From | To | Trigger | Notes |
|---|---|---|---|
| (none) | requested | Parent lead calls Agent with a reference member | Event `staff.team.nested` |
| requested | resolving | Always | Look up team, check pin, depth, cycle, privacy |
| resolving | refused | Missing team, cycle, depth exceeded, private member needed but no model passes the verified check and your organization's rules for this use | Terminal; parent told why in the refusal sentence ("Nothing was sent. {What}. {Why}. {What you can do}. {Who to ask}.") and continues |
| resolving | awaiting-consent | Unapproved import, or pin differs | Person asked once |
| awaiting-consent | ready | Person approves | Pin updated |
| awaiting-consent | refused | Person declines | Terminal |
| awaiting-consent | requested | Question closed without answer | Asked again next time; this run treats it as refused |
| resolving | ready | All checks pass | |
| ready | queued | No free nested slot | |
| queued | running | Slot frees | |
| ready | running | Slot free | Branch created |
| running | waiting | Nested lead reports `WAITING ON` another section or a human decision | Parent sees what it waits for |
| waiting | running | Input arrives | |
| running | reporting | Nested lead finishes | |
| reporting | merging | Parent starts merging the section branch | |
| merging | done | Merged, checks pass | Terminal |
| merging | conflict | Merge conflict | Handed to the section with both sides |
| conflict | merging | Section returns a resolution | |
| running, waiting, queued | cancelled | Person or parent stops it | Terminal; partial work kept on the branch |
| running | failed | Error, cost cap, or timeout | Terminal; other sections are not blocked |

No state can wait forever: `waiting` has the timeline's suspense as a deadline and moves to `failed` with a report when it passes; `awaiting-consent` ends when the question closes.

**Tests** (WP-TOT): parse and render round trip with `team:`, `uses:`, `pin:`; older-format compatibility (a build that ignores the lines still parses); each transition above, including every refusal reason; consent with a changed pin; privacy inheritance both ways; depth 3 refused; cycle refused at parse and at run; cost cap across the tree; concurrency queue; two-level merge with a conflict resolved by the section; one failed section does not block the others; unattended context rules; gate records for nested spawns; Team Studio checks (`team-ref-missing`, `team-ref-cycle`, `team-ref-depth`, `team-ref-privacy`).

### 5.5 Full staff and planning group templates

- **Joint staff (team of teams), 12 members**: `chief-of-staff` (integrator; battle rhythm owner; decision queue; deep), `j1`, `j2`, `j3`, `j4`, `j5`, `j6`, `j7`, `j8`, `j9` (team references), `special-staff` (team reference: legal-support, political adviser support, public affairs support, surgeon support, chaplain support, gender adviser support, engineer, red-team as the command red team reporting to the COS), `staff-release-guard`. Each support role assists a human and never replaces one.
- **Joint planning group**: the J5 team with `red-cell-seat`, `future-ops-seat` and `sustainment-seat` replaced by borrowed members (`uses: j2-intelligence/red-cell`, `uses: j3-operations/future-ops-planner`, `uses: j4-logistics/log-plans-officer`). Still 12, and works with only four section teams installed.
- **Later section templates** (after the first four): J1 personnel, J6 communications and CIS, J7 training and lessons, J8 resources and finance, J9 civil-military, special staff, and functional teams (fires and targeting, information, cyber and space) that a J3 may reference instead of its single members at operational and strategic level.

---

## 6. Skills, tools and MCP

**Label ceiling** below means the highest label a call to the tool may carry under the default policy. Staff templates carry a **template ceiling** on top of everything: exercise and fictional data at Organization: Internal, NATO: Unclassified or Canada, Protected: Protected A at most, and nothing higher whatever the device allows, because labels are not accreditation (`LABELS_NOT_ACCREDITATION_TEXT`). The ceiling is compared with the one label service over the active scale table (coherence review, S7).

### 6.1 Tools that exist today

| Tool | Use in the templates | Licence | Label ceiling |
|---|---|---|---|
| Read, Glob, Grep, Write, Edit, TodoWrite | Products, registers, proposals | Part of the extension | Template ceiling (local) |
| Remember, Recall, TeamKnowledge | Running estimates across sessions; section memory | Extension | Template ceiling (local) |
| CreateDocument, CreatePdf, CreatePresentation | Orders, annexes, briefs | Extension | Template ceiling (local) |
| RenderSvg, VectorizeImage | COA sketches, matrices, graphics | Extension | Template ceiling (local) |
| WebSearch, WebFetch, CheckCitations | OSINT, doctrine checks, citation checks | Extension; results from the open web | Public only for anything sent: the existing outbound check refuses labelled text in queries; a query can still reveal interest, so OSINT queries are scoped to the fictional scenario |
| Agent | Lead spawning members; team references (section 5) | Extension | Inherits the parent run |
| MCP client (`mcp:<server>`) | All new servers below | Extension | Per server (6.2, 6.3) |

### 6.2 New local tools and servers to build

All are local, in-process or local stdio servers written in-house under the extension's licence, each with a person-readable capability manifest (Phase 70) that declares every tool, `runsOn: local`, and no hosts unless stated.

| Tool or server | What it does | Third-party parts and licence | Label ceiling |
|---|---|---|---|
| `staff-products` (built in) | Product header, release state machine verbs for agents (propose, verdict, submit, withdraw, status, list), registers (CCIR, RFI, assumptions, annex tracker, sync matrix, DST and DSM, targeting workbook), wargame ledger | None | Template ceiling |
| `guard-scan` (built in) | Deterministic release checks: marking patterns for every shipped scale, exercise-box geofence, real-entity list, restricted-title list, decision wording, personal-data patterns, numbers without calculator records | None (geofence with a small point-in-polygon routine) | Template ceiling |
| `cop-map` | Layers as GeoJSON, military symbols, event pins, import and export, a rendered map for briefs | milsymbol (MIT; MIL-STD-2525 and APP-6 symbols, 03 A10, 05 s5), MapLibre GL JS (BSD-3-Clause), MGRS conversion (mgrs, MIT); vendored and reviewed, never fetched at run time | Template ceiling for layers. **Map tiles are the risk**: fetching tiles from a public server reveals the area of interest. Default to offline tiles or a plain grid; online tiles only at Public, with OpenStreetMap data under ODbL and the tile server's usage policy |
| `battle-rhythm` | Events, inputs, outputs, attendees as `.ics`; suspense tracking for RFIs and decisions | iCalendar format (RFC 5545); no library needed | Template ceiling |
| `orders` | Assembles WARNORD, FRAGO, OPORD, OPLAN, CONOPS and annexes in the profile's format and letters; versioning; consistency and cross-reference checks; release through the state machine | None (uses CreateDocument and CreatePdf) | Template ceiling |
| `intel-workbench` | Source register with separate grades and origin, PIR to indicator to NAI matrix, event matrix, ICD 203 lint, INTSUM and INTREP skeletons, DTG helpers | None | Template ceiling |
| `logistics` (logstat, calculator, movement) | LOGSTAT schema, definitions per echelon, plausibility rules, consolidation, diff against forecast; consumption calculator (user-entered factors times force list times days, formula always shown; ships no government factor tables); notional movement tables and lift feasibility; road routing on a local graph | Routing: OSRM (BSD-2-Clause) or GraphHopper (Apache-2.0) on OpenStreetMap extracts (ODbL); vehicle routing with OR-Tools (Apache-2.0) (03 B8) | Template ceiling; routing runs locally on a downloaded extract so no route request leaves the machine |
| `joc-log` | Append-only timestamped event log; CCIR and DSM trigger matching | None | Template ceiling |

Skills (files every member reads, shipped with the templates, not code): `doctrine-profile` (one per profile: step names, products, annex letters, J/G/S codes, COA tests), `planning-templates`, `facts-assumptions-ledger`, `cog-analysis`, `wargame-ledger`, `assessment-framework`, `annex-tracker` (05 s5), `icd203-standards` and `source-grading` (02 T10), `logstat-definitions` (03 B5). They live in the project's `.planning/staff/` so the person can read and edit them.

### 6.3 Partner integrations deferred to the agent exchange

None is in a default template. Each needs the per-server label ceiling (WP-GATE) first, and the exchange's identity, mandates and attestation later (01 s4).

| Integration | Members | Licence or terms | Label ceiling until the exchange exists |
|---|---|---|---|
| Public imagery catalogues (STAC search, Sentinel and Landsat) | geoint-analyst, collection-manager | Open data; community MCP servers unreviewed (02 T11) | Public (queries reveal interest) |
| Commercial imagery vendors' official servers | geoint-analyst | Commercial licence; key as a secret | Public, remote only, ask every call |
| Global news and conflict-event datasets (community MCP servers) | watch-officer, osint-analyst | Dataset terms vary; accounts required for some; large attack surface (02 T11) | Public |
| OpenStreetMap search and geocoding servers | geoint-analyst, mobility-planner | ODbL and usage policies | Public |
| National and coalition intelligence reporting (HUMINT, SIGINT, MASINT, CI) | All-source analysts | Government systems; need legal authority and accredited enclaves | Out of scope for the extension (02 Summary 8) |
| Fires and targeting systems of record; air tasking | fires, targeting | Government | Out of scope (03 A10) |
| Logistics systems of record and TPFDD tooling | J4 | Government | Out of scope (03 B8) |
| Another organization's staff agents through A2A | Any | Exchange mandates and signed cards (01 s1, s2) | Set by the exchange's listing level |

Rules until the per-server ceiling and fenced descriptions exist (01 s4, "minimum for staff teams"): remote servers only; every tool declared in a restrictive manifest; scoped to named members, never the whole team; never unattended; ask before every call that sends data; every labelled level kept off partner servers by `decideRoute` (the per-server ceiling below, and from Phase 41 each partner as an `endpoints[]` entry with its own `maxLabel`), so a labelled chat cannot reach a partner; least-scope tokens per partner; results reviewed by a person before they enter a product.

---

## 7. Safety and classification

> **Coherence review (2026-11-20):** "private" here means the gate's verified check (a fresh, bound connection to private hardware, or this computer), not the catalogue's claim. The private models NEAR AI offers today all come from developers in the People's Republic of China, which the model provenance decision forbids for operational work, so staff teams say so plainly and run on fictional or exercise material until your organization approves a model for that use. See `.planning/research/coherence/REVIEW.md`, section 8 (S4, S5).

1. **Unclassified templates, private models only, exercise first.** Every staff team ships with `privacy: private`, which the gate enforces as a floor: the agents' models run only on NEAR AI private hardware that passed the verified check on a fresh, bound connection, or on this computer (`decideRoute`, fix S4). The team file and the last setup screen add: "The private models NEAR AI offers today come from developers in the People's Republic of China. Use this team only on fictional or exercise material until your organization approves a model for operational work." (fix S5). Templates, skills and demo data are unclassified and fictional. The project guidance says real operational plans belong on accredited systems (05 s6). With Phase 74.1 the templates move from `privacy: private` to "needs operational-work approval and verified private hardware or this computer" (conflict K7).

   > **Superseded 2026-11-20 (coherence review):** this item first read "Unclassified templates, private by default. Every staff team ships with `privacy: private` (NEAR TEE or local model only)." That trusted the catalogue's claim of private hardware and implied the models were fit for operational work; the owner's decision to ship private teams stands, with the meaning and sentence above.
2. **Human decision authority.** Every approval is a human transition in the release state machine (4.1). Agents write `DECISION FOR`, never "approved". This matches doctrine (the planning responsibility is inherent in command: 05 s1 point 7; CFJP 5.0 art. 404.12 "the Commander selects") and the DND/CAF AI strategy's traceability requirement (05 s6). Targeting packages carry commander-or-delegate and legal review marks; nothing appears to automate target nomination (03 Summary 7).
3. **Compilation risk.** A staff team compiles by design. The release-guard checks compilation on every product; the project shows an aggregation warning when real-looking unit, location or capability data accumulates; partner tools see only what one call needs, and nothing yet tracks what one partner received over time, so partner use stays Public-only (01 s5 item 3).
4. **Partner MCP rules** until the per-server ceiling and fenced tool descriptions ship: section 6.3.
5. **Support roles assist humans.** `legal-support`, `health-services-planner`, the special-staff supports and `services-mortuary-planner` draft for qualified people. Their products carry `LEGAL REVIEW REQUIRED` or `SURGEON REVIEW REQUIRED`, which the guard checks for, and their instructions say they never give legal or medical advice.
6. **No collection on own-nation persons, no real targeting, no personal data** (02 Pitfalls 11 and 12; 03 B12 item 8).
7. **Restricted doctrine.** No text from CAC-only or unreleased publications is pasted into templates; they are cited by title and edition only (03 A14 item 3). The guard's restricted-title list enforces it for products.
8. **Labels are not accreditation**, and clearances are self-declared until Phase 71: the staff step of Get Started shows both existing sentences. Effective clearance is the lower of the person's own declared clearance and the roster's clearance for this project. A chat labelled classified or Protected C on a computer with no accreditation record gets one notice per chat and a `route.not-accredited` record now, and is refused once your organization's rules exist (fix S2, owner question Q6).
9. **Exercise first, and a signed exercise flag** (added 2026-11-20, coherence review, conflicts K15 and K30, owner question Q10). Staff projects are operational work (use T3 in the model provenance design). Until your organization approves a model for operational work, the staff step of Get Started offers only "exercise on fictional data" and says why; it never lands a person on a staff surface with no allowed model. The exercise flag, which lets a staff project run at the lower use level, is a project-layer attribute of the signed policy: set at genesis or by the person in the staff lead position with a reason, recorded like a label lowering, and shown on every staff screen ("Exercise: fictional data only"). It is never a plain project setting.

---

## 8. Demo dataset

**Source.** TRADOC's ODIN (OE Data Integration Network) links the Worldwide Equipment Guide (WEG), the Decisive Action Training Environment (DATE) scenarios and force structures, and the TC 7-100 opposing-force series (02 T11, s3.5).

**What was confirmed (2026-11-18)**:
- ODIN is reachable without a login; the old address now redirects (HTTP 301) to a new host under the Army's renamed training command. The page is a script application, and no terms of use, licence or distribution notice could be read from it.
- A 2021 TRADOC reply to a FOIA request, as summarised by search results (the request page itself refused automated reading), says the WEG content is approved for public release and ODIN is open to all without a login.
- Related DATE material and TRADOC intelligence pages carry "approved for public release; distribution unlimited" wording, but no DATE or WEG volume with its own Distribution Statement A marking was seen.
- US government works are generally not subject to US copyright, but that is a general rule, not a licence for this content, and it says nothing about use outside the US.
- Some DATE settings place fictional states on real-world terrain. The exercise box therefore uses real coordinates, and `guard-scan`'s geofence must allow that box while still blocking anything outside it.
- An allied national DATE adaptation exists on another government's site under that government's copyright; do not use it without its own licence.

**Recommendation.**
1. Do not bundle ODIN files in the extension. Ship a link and a "bring your scenario" import that reads files the user downloads.
2. Ship our own small fictional starter scenario, written in-house: a fictional region, fictional forces and notional numbers, enough for a 20-minute J2 to J4 demo. It is ours to license, and it carries no real coordinates.
3. Ask TRADOC (the renamed command's G-2) in writing to confirm public release and any attribution wording for the WEG and DATE before any extract is bundled (Q5).
4. Record the access date, address and distribution wording of every downloaded volume in the scenario's source register, as the research team already does for sources.

---

## 9. Build plan

### 9.1 Work packages

WP-0 lands first because every other package imports its schema; everything after it runs in parallel worktrees from the same base, then one integration. One line on the dependency: WP-0 is the shared contract (profile vocabulary, product header schema, member preamble), so it cannot run beside its consumers.

| WP | Scope | Worktree | Depends on | Tests |
|---|---|---|---|---|
| WP-0 Contract | Profile data (`us-joint`, `us-army`, `nato-ca`) with steps, COA tests, annex letters, codes; level validity; planning type (crisis switches the planning lead to the J3); product header schema; member preamble; `staff` project type skeleton with settings in `project.json` (project-stream entries once the project is shared; coherence review, K23) | `feat/staff-contract` | None | Profile tables parse; every profile and level combination valid or refused as in 2.1; annex letters per profile (joint D logistics, N assessments, Army D fires, NATO/Canadian D intelligence, R logistics); US Joint COA tests start with "suitable", never "adequate"; JP 3-14 retired space terms are rejected by the vocabulary lint; planning type `crisis` names the J3 director and the transition; schema round trip |
| WP-J2 | J2 template, three level variants, skills (`icd203-standards`, `source-grading`), project guidance, template history entry | `feat/staff-j2` | WP-0 | `parseTeam` passes for every variant; 12-member cap; `checkTeam` has no warnings and no parallel-work advice; every product in 3.2 has exactly one owner; instructions contain the boundary sentence and a deliverable; vocabulary switch (JIPOE versus IPB, Annex B versus D); red-team prompts from the earlier prototype's authority tests (J2 must not task collection, approve PIRs or decide) produce refusals in a scripted run |
| WP-J5 | J5 template, variants (including MDO and tactical), skills (planning templates, wargame ledger, COG, assessment framework) | `feat/staff-j5` | WP-0 | As WP-J2; COA cells have distinct themes and areas (no `overlap` finding); red-team has no write access to plan files; COA tests per profile; agents never write "selected" in a scripted run |
| WP-J3 | J3 template and variants | `feat/staff-j3` | WP-0 | As WP-J2; watch-officer has no Write; FRAGO drafts go through the state machine; fires packages carry both review marks |
| WP-J4 | J4 template and variants, `logstat-definitions` skill | `feat/staff-j4` | WP-0 | As WP-J2; every number in a sample estimate traces to a calculator record; Canadian weekly report variant; annex letter per profile |
| WP-SHARED | `staff-products` (state machine, registers, wargame ledger), `guard-scan`, release-guard instructions, tradecraft lint, UI read models and events (4.5) | `feat/staff-products` | WP-0 | Every transition and every forbidden transition in 4.1; tamper detection; dependency propagation; guard-scan fixtures per rule (markings for every shipped scale, geofence in and out, restricted titles, decision wording); ICD 203 lint fixtures; events emitted once per transition |
| WP-TOT | Team of teams: `team:`, `uses:`, `pin:` parsing and rendering; nested runs; rules in 5.3; state machine in 5.4; Team Studio checks; gate manifest effect | `feat/team-of-teams` | None (generic feature) | Section 5.4 test list |
| WP-COP | `cop-map` server with vendored milsymbol and MapLibre, offline tiles | `feat/cop-map` | WP-0 (layer ownership) | Layer ownership enforced; symbol rendering snapshots for a small set; no network call with offline tiles (asserted by the gate record) |
| WP-ORD | `orders` and `battle-rhythm` | `feat/staff-orders` | WP-0 | Annex assembly per profile; consistency check catches a wrong letter and a missing owner; `.ics` round trip |
| WP-LOG | `logistics` server (logstat, calculator, movement) | `feat/staff-logistics` | WP-0 | Plausibility rules; formula shown on every result; no factor tables shipped; routing with no network |
| WP-INT | `intel-workbench` | `feat/intel-workbench` | WP-0 | Source register grades separate; origin-based independence; PIR to decision point rule; INTSUM skeleton |
| WP-GATE | Label ceiling per MCP server in the signed policy bundle (from bundle v2, the `agents.mcp.labelCeilings` key, named in `requires`; coherence review, POLICY-SCHEMA section 2); fenced and length-limited MCP tool descriptions; notice when a server's tools or descriptions change (01 s4) | `feat/gate-mcp-ceiling` | None (Phase 70 follow-up) | Call refused when the chat mark is above the server's ceiling at every routing tier; bundle parse rejects unknown levels; description fencing; change notice |
| WP-DEMO | Starter fictional scenario, scenario import, demo scripts per section, acceptance fixtures (required headings, terms, citations per profile, after the earlier prototype's validation fixtures, 00 s5) | `feat/staff-demo` | WP-0 | Fixtures pass on the starter scenario with each template |
| Integration | Merge in order WP-SHARED, WP-GATE, servers, section templates, WP-TOT; joint staff and planning group templates; README Teams and Team Studio text; template history; one full verification run; UAT script per demo | `feat/staff-integration` | All | Full suite once; end-to-end J2 then J5 demo on the starter scenario; team-of-teams planning group run |

### 9.2 Where it fits the roadmap

Recommendation: **yes, ship as 0.4.x feature releases before the remaining v0.5.0 governed-platform work, in three drops**:
1. **Drop 1 (demo order J2, J5):** WP-0, WP-SHARED, WP-J2, WP-J5, WP-INT, WP-DEMO. The templates run on today's team runtime; the state machine and guard are what make a demo safe to show.
2. **Drop 2 (J3, J4):** WP-J3, WP-J4, WP-COP, WP-ORD, WP-LOG, WP-GATE.
3. **Drop 3:** WP-TOT, the joint staff and planning group templates, then the further sections.

Why: the owner's demo priority; the templates need nothing from Phases 71 to 74 (identities, broker, contracts), only the Phase 70 gate already on main plus one small ceiling change; and the earlier owner decision that v0.5.0 Stage 1 phases ship in 0.4.x as they land means a 0.4.x feature line is the normal vehicle. What waits for v0.5.0: verified approver identities (Phase 71; until then approval is device-key signed and self-declared, said plainly), partner identity and tokens (Phases 71 and 73), and run contracts for unattended staff loops (Phase 74). Fine-tuning of staff specialists comes from the v0.6.0 model factory, which can use the approved product history and gate verdicts as training signals; nothing in this design blocks that.

> **Coherence review (2026-11-20):** the three drops stand. Later staff work lands on the shared foundations instead of its own: staff setup folds into Get Started (Phase 32.1), decision authority moves onto positions with the one delegation rule (Phase 33.1), shared staff projects use the replica layer (Phases 31 to 35), the per-server MCP ceiling and the exercise flag live in policy bundle v2 (Phase 41), and the templates' model requirement changes with Phase 74.1. Staff commands get `when: nearAi.staffProject` so they leave the palette in other projects. See `.planning/research/coherence/REVIEW.md`, section 9.

### 9.3 Owner decisions on the open questions

The owner accepted every recommendation below on 2026-11-18. Every term is stated plainly; terms that a later reference may change are listed in 2.9 and change in one place, the profile file.

| # | Question | Who | Recommendation | Decision |
|---|---|---|---|---|
| Q1 | Approve the three profiles (US Joint, US Army, NATO/Canadian) and the level settings with JPP not offered at tactical level | Owner | Approve as in 2.1 | Accepted (owner, 2026-11-18) |
| Q2 | NATO OPLAN annex letters: is Intelligence Annex D and Logistics Annex R in the current COPD, as in CFJP 5.0's NATO-derived list? | NATO-cleared planner with COPD access | Ship the CFJP 5.0 list as the NATO/Canadian column; change the profile file if a COPD holder finds a difference | Accepted (owner, 2026-11-18) |
| Q3 | APP-28 step names and products (restricted text) | Canadian Army reviewer | Ship the tactical NATO/Canadian profile with the APP-28 step names from secondary sources | Accepted (owner, 2026-11-18) |
| Q4 | Canadian J2 and J4 terms against CFJP 2-0 (2011) and CFJP 4-0 (2016); JIPOE or JIPB in current Canadian joint usage (JIPOE chosen, 2.5); CJOC J-branch functions | Canadian SME (intelligence and logistics) | Use AJP-5 and NATO terms until reviewed | Accepted (owner, 2026-11-18) |
| Q5 | Written confirmation from TRADOC on WEG and DATE release and attribution | Owner (letter) | Do not bundle until confirmed; ship our own starter scenario | Accepted (owner, 2026-11-18) |
| Q6 | J5 fits the release-guard by moving the assessment framework to design-planner in planning and J3 in execution | Owner | Accept | Accepted (owner, 2026-11-18) |
| Q7 | Release-guard tier: standard (recommended) versus fast | Owner | Standard: it is the last automated check before a human | Accepted (owner, 2026-11-18) |
| Q8 | Step and product names in JP 2-0 (2022), the JIPOE Joint Guide, JP 4-0 (2023), and the annex titles in CJCSM 3130.03 | A CAC holder | Cite public editions by title and edition. JP 5-0 and JP 3-0 are now settled by the owner's references (2.8); the rest is in 2.9 | Accepted (owner, 2026-11-18) |
| Q9 | Ship drop 1 as the next 0.4.x feature release | Owner | Yes | Accepted (owner, 2026-11-18) |
| Q10 | Should approval of a staff product require the Phase 69 signed identity (device key) now, or a simple named confirmation until Phase 71 | Owner | Device-key signed, with the self-declared notice | Accepted (owner, 2026-11-18) |
| Q11 | Red team under the NATO/Canadian profile (UK national element, not NATO doctrine) | Owner and Canadian SME | Keep it, labelled optional, on by default | Accepted (owner, 2026-11-18) |
| Q12 | Which later sections come next after the first four (J6 and J1, or the special staff) | Owner | Special staff next (legal, political, public affairs supports), because every planning demo touches them | Accepted (owner, 2026-11-18) |

### 9.4 Open questions from the coherence rewrite (2026-11-20)

The coherence review settled the vocabulary, positions, the exercise flag and the private meaning. These two points it did not settle; each has a recommended default and nothing is built until the owner answers.

| # | Question | Recommended default | Why |
|---|---|---|---|
| Q13 | Agent slugs that use words the glossary keeps off main screens (`red-cell-seat`, `future-ops-seat`, `sustainment-seat`, `coa-cell-a`, `coa-cell-b`): rename the slugs? | Keep the slugs (they are ids in saved team files and template history); show the job text on screens ("J2 view in the planning group", "COA development cell A"). "Red cell" and "COA cell" stay as doctrine words, allowed by the copy lint in Military mode only | Renaming ids breaks saved teams and imports for no gain in meaning; "cell" here is doctrine, not the key-group meaning the glossary removes |
| Q14 | Should the staff step of Get Started prefer a model on this computer when one answers (the open part of review Q3)? | Yes: offer this computer first for exercise work when a local model answers, still exercise only until your organization approves a model for operational work | Keeps exercise data on the computer, and avoids the PRC-origin models for people who have a local one; it does not lift the operational-work rule |
