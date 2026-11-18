# Research note 02: the J2 (joint intelligence) staff team

Date: 2026-11-18. Scope: a J2 agent team template for the NEAR AI VS Code extension that is correct under US and Canadian doctrine and works at the strategic, operational and tactical levels. This is the first team the owner will demo.

Method: public, unclassified sources only. Doctrine was read in full text where a public copy exists (several through the Internet Archive because the hosting sites now block automated download; both addresses are given in the source list). Every claim carries a source tag such as [S6]. Each tag resolves in the Sources section to a title, publisher, date and URL. A confidence mark follows the source list: HIGH means the primary text was read; MEDIUM means an official secondary source or an older edition of the primary; LOW means a catalogue, retail or directory listing. Anything written as "Proposal" is this note's design advice, not doctrine.

Related notes: [00-bastion-staff-teams.md](00-bastion-staff-teams.md) (what Bastion has, the extension's team file format) and [01-agent-exchange.md](01-agent-exchange.md) (partner MCP tools).

---

## 1. Summary

1. **Check which US publications are current before citing them.** JP 2-0, Joint Intelligence, is dated 26 May 2022 [S1], but the Joint Staff only gives the current text to users with a CAC [S2][S3]. The Joint Staff hierarchy chart of 12 December 2024 shows JP 2-0 as the only publication in the 2-0 series. It lists "Joint Intelligence Preparation of the Operational Environment" as a **Joint Guide**, not a JP [S3]. JP 2-01 (5 July 2017) and JP 2-01.3 (21 May 2014) are not on that chart, so treat them as superseded [S3]. Their public text [S5][S6] is still the best public reference for the method, and the templates should cite it as "public reference edition".
2. **The US joint intelligence process has six categories:** planning and direction; collection; processing and exploitation; analysis and production; dissemination and integration; evaluation and feedback [S4]. NATO and the CAF use a four-stage intelligence cycle: direction, collection, processing, dissemination [S23][S18]. The team's workflow should name both so it works for either audience.
3. **JIPOE is the J2's main planning product line.** It has four steps: define the operational environment; describe its impact; evaluate the adversary and other relevant actors; determine their COAs [S6]. It gives the JFC the most likely and most dangerous adversary COAs, situation templates, HVT lists, event templates and matrices, and named areas of interest [S6]. These products feed every JPP step from planning initiation to plan or order development [S6][S7].
4. **At tactical level the Army's IPB has the same four steps, renamed for the echelon:** define the OE, describe environmental effects, evaluate the threat, determine threat COAs [S9]. IPB feeds each of the seven MDMP steps and the company-level troop leading procedures [S9]. A retail listing shows a January 2024 Change 2 retitled "Intelligence Preparation of the Operational Environment" [S10, LOW]. Verify that on armypubs before shipping.
5. **Canada differs in process, product names and authorities.** The CAF OPP has five stages: initiation, orientation, COA development, plan development, plan review [S16]. The intelligence annex is **Annex D**, not Annex B [S16][S5]. Canadian doctrine uses NATO terms (CCIRM, JIPB, intelligence cycle) [S18][S16]. When NATO and allied doctrine conflict, NATO doctrine takes precedence for Canada [S17]. The Chief of Defence Intelligence (Commander CFINTCOM) has functional authority over all defence intelligence. Commander CJOC leads defence intelligence requirements for joint operations [S20][S21]. A Canadian JIOC was stood up in 2021 [S22].
6. **The J2 owns the intelligence product line but not decisions or asset allocation.** The commander approves PIRs and decides. The J2 prioritizes collection, but the J3 approves the allocation of collection assets [S15]. JIPOE HVTs become HPTs only through J3 and J5 wargaming [S6]. Red cells (J2 threat emulation) and red teams (independent alternative analysis) are different things [S5][S7].
7. **Analytic tradecraft should be built in as a hard gate.** Products must meet ICD 203: five analytic standards, nine tradecraft standards, and a fixed likelihood scale (for example "likely" means 55 to 80 percent). A confidence level and a likelihood term must never appear in the same sentence [S14]. The Army applies ICD 203 at operational and tactical levels too [S13]. Sources are graded with the NATO reliability (A to F) and credibility (1 to 6) scale, and the two grades are assessed separately [S24][S18].
8. **Only some disciplines fit public tools.** OSINT, GEOINT from public and commercial imagery, terrain, weather and reference data can all be public or commercial. HUMINT, SIGINT, MASINT and CI collection need legal authority and partner systems [S4][S20]. The default template therefore has no HUMINT, SIGINT, MASINT or CI collectors. It has all-source analysts who take in partner reporting through an MCP server only when the organization connects one.
9. **Proposal: a 12-member operational (JTF) team**, every member `privacy: private`. The members are j2-chief, requirements-manager, collection-manager, jipoe-analyst, geoint-analyst, osint-analyst, threat-analyst, watch-officer, target-analyst, red-cell, tradecraft-reviewer and release-officer. The lead directs the work and assembles the intelligence estimate and annex. A tradecraft gate and a release gate must pass before anything goes to the J3, J5 or J4. Scaling: about 8 members at strategic level (warning and partner focus, no targeting), and 6 members (brigade S2) or 4 (battalion S2) at tactical level.
10. **Classification rules.** Templates and their instructions stay unclassified. Work products use the extension's labels: the org scale plus Canada Protected, Canada Classified and NATO scales [S41]. The extension says plainly that labels are an organizational control, not accreditation, and that clearances are self-declared [S41]. Two more risks need explicit rules. Compiling unclassified OSINT can itself create classified information (EO 13526 section 1.7(e)) [S26]. Collecting on own-nation persons is legally restricted [S30][S20].

---

## 2. Tables

### Table 1. Doctrine currency (which edition to cite)

| Publication | Edition read | Status found | Public? | Use in templates | Conf. |
|---|---|---|---|---|---|
| JP 2-0, Joint Intelligence | 22 Oct 2013 [S4] | Current edition is 26 May 2022 [S1] | 2022 text needs a CAC [S2][S3]; 2013 is public | Cite JP 2-0 (2022) for authority; use the 2013 text for process detail, marked as public reference | HIGH (dates), MEDIUM (2022 content) |
| JP 2-01, Joint and National Intelligence Support to Military Operations | 5 Jul 2017 [S5] | Not on the 12 Dec 2024 hierarchy chart [S3] | Yes (2017) | Public reference for JIOC, JISE, J-2X, Annex B, FDO, collection management | MEDIUM |
| JP 2-01.3, JIPOE | 21 May 2014 [S6] | Not on the chart; JIPOE is now a Joint Guide [S3] | 2014 yes; guide needs a CAC | Public reference for the four JIPOE steps and JPP support | MEDIUM |
| JP 5-0, Joint Planning | 1 Dec 2020 [S7] | Still cited as current in an Aug 2024 Army War College handbook [S8] | Yes | JPP steps, red team versus red cell | HIGH |
| ATP 2-01.3, IPB | 1 Mar 2019 with Change 1, 6 Jan 2021 [S9] | Change 2, Jan 2024, retitled "Intelligence Preparation of the Operational Environment", per retail listing [S10] | Yes | IPB steps, MDMP and TLP support | HIGH (2019/2021), LOW (2024 change) |
| FM 3-0, Operations | Oct 2022 [S11] | Current | Yes | MDO, intelligence warfighting function | HIGH |
| FM 2-0, Intelligence | Not read | 1 Oct 2023, nested in FM 3-0, per news report [S12] | Yes (official) | Verify before quoting | MEDIUM |
| ATP 2-33.4, Intelligence Analysis | 10 Jan 2020 [S13] | Current as far as found | Yes | Structured analytic techniques, ICD 203 at all echelons | HIGH |
| ICD 203, Analytic Standards | 2 Jan 2015, amended 21 Jan 2022 [S14] | Now served from archive.dni.gov [S14] | Yes | Analytic standards and likelihood terms | HIGH |
| CFJP 5.0, CF Operational Planning Process | Change 2, Apr 2008 [S16] | No newer public edition found | Yes | OPP stages, Annex D | HIGH (text), MEDIUM (currency) |
| CFJP 01, Canadian Military Doctrine | 2009 [S17] | No newer public edition found | Yes | Doctrine precedence (NATO first) | HIGH |
| CFJP 2-0, Intelligence (B-GJ-005-200/FP-001) | Not found | 2011 edition exists per Canadian Forces College citations [S19] | No public copy found | Cite only as a reference; use the 2003 FP-000 [S18] for terms and mark it superseded | LOW |
| AJP-2, Allied Joint Doctrine for Intelligence, CI and Security | Ed A V2, Feb 2016 [S23] | Later editions may exist; not public | Ed A is NATO UNCLASSIFIED | Intelligence cycle, CCIRM | MEDIUM |
| AJP-2.1, Intelligence Procedures | Ed B V1, ratification draft 1 [S24] | Draft text | NATO UNCLASSIFIED | J2 current ops and J2 plans, source grading | MEDIUM |

### Table 2. The intelligence process, and what the team does at each stage

| US JP 2-0 category [S4] | NATO and CAF stage [S23][S18] | Team activity (Proposal) | Doctrine anchor |
|---|---|---|---|
| Planning and direction | Direction | j2-chief turns the commander's guidance into intelligence direction. requirements-manager drafts PIR candidates and IRs. Every PIR is tied to a decision point. | Successful PIRs are tied to decision points and reviewed in the battle rhythm [S15]. Direction is external (commander) and internal (senior intelligence officer to specialist elements) [S23]. |
| Collection | Collection | collection-manager writes the collection plan and requests. osint-analyst and geoint-analyst collect from public and commercial sources only. | Collection managers validate requirements, then match them to resources [S5]. J3 approves asset allocation [S15]. |
| Processing and exploitation | Processing (collation, evaluation, analysis, integration, interpretation) | osint-analyst and geoint-analyst register every item, grade it A to F and 1 to 6, and record provenance. | The evaluation step allocates a reliability and credibility rating [S18][S24]. |
| Analysis and production | (Processing) | jipoe-analyst, threat-analyst and target-analyst produce JIPOE and threat products. j2-chief writes the intelligence estimate. | Eight production categories: warning, current, general military, target, S&T, CI, identity, estimative [S4]. |
| Dissemination and integration | Dissemination | release-officer checks the label and releasability. Then products go to the J3, J5 and J4. watch-officer publishes INTSUMs and INTREPs. | "Write for release" and foreign disclosure [S15]. INTREP and INTSUM are standard NATO reports used by the CAF [S18]. |
| Evaluation and feedback | Feedback (built into dissemination) | tradecraft-reviewer checks every product against ICD 203. requirements-manager runs the PIR review and closes answered PIRs. | Evaluation and feedback are often the least observed parts of the process [S15]. Dissemination needs a feedback mechanism [S23]. |

### Table 3. J2 support to each JPP step (US joint)

Sources: JP 2-01.3 chapter VI [S6], JP 5-0 [S7], JP 2-01 [S5].

| JPP step [S7] | What intelligence must deliver | Main products | Goes to |
|---|---|---|---|
| 1. Planning initiation | A preliminary JIPOE of significant OE characteristics comes before initiation. Analysts monitor the situation and start new collection and production requirements. The J2 leads the systems understanding that feeds operational design [S6]. | Initial JIPOE update; initial RFIs; current intelligence; (US strategic) DIA dynamic threat assessment for top-priority plans [S6] | Commander, J5 (design) |
| 2. Mission analysis | JIPOE lets the staff tell the known from the unknown and set working assumptions. It helps the JFC form PIRs. The mission analysis brief must include an initial impact of the OE, an evaluation of the adversary, an intelligence collection plan, and adversary COAs [S6]. | JIPOE steps 1 to 4 (initial); proposed PIRs; initial collection plan; J-2 staff estimate [S5] | Commander (approves PIRs), J5, J3 |
| 3. COA development | The J2 identifies, evaluates and prioritizes all adversary COAs in time for friendly COA development. The J3 and J5 use step 3 for force ratios and the JIPOE HVT analysis to find targets [S6]. JIPOE also feeds deception planning [S6]. | Adversary COA set with MLCOA and MDCOA; situation templates; HVT list; adversary intelligence collection capabilities (for deception and OPSEC) | J5, J3 |
| 4. COA analysis and wargaming | The J2/JIOC or red cell plays the adversary [S6]. Each friendly COA is wargamed first against the most likely and then the most dangerous adversary COA [S6]. Decision points found in the wargame become the basis of PIRs and FFIRs [S6]. HVTs refined in the wargame become HPTs [S6]. | Red cell adversary play; refined event template and matrix; decision support template inputs (TAIs, decision points, time phase lines) built with the J3, J4, J5 and J6 [S6] | J5 (wargame lead), J3, targeting |
| 5. COA comparison | Intelligence risk and supportability of each friendly COA against the adversary COAs | J-2 staff estimate (intelligence capability to support each COA) [S5] | J5, commander |
| 6. COA approval | Commander's decision (human) | Intelligence input to the decision brief | Commander |
| 7. Plan or order development | Annex B (Intelligence) gives the adversary situation, priorities, tasks, products, requests to higher, the concept of intelligence operations and procedures. It is informed by the intelligence estimate and the J-2 staff estimate [S5]. | Annex B; intelligence estimate; collection plan; dissemination plan | J5 (plan), J3 (execution) |

### Table 4. IPB support to the MDMP (US Army tactical)

Source: ATP 2-01.3 chapter 2 [S9].

| MDMP step [S9] | IPB support [S9] |
|---|---|
| 1. Receipt of mission | Start IPB step 1; set the time allocated to IPB inside mission analysis [S9] |
| 2. Mission analysis | Full IPB. Outputs: intelligence gaps, information requirements, threat situation templates with COA statements and HVT lists, event templates and matrices, relative combat power matrices, terrain, weather and civil considerations decision aids, reconnaissance objectives, and the tempo and focus of information collection [S9] |
| 3. COA development | The primary IPB product is the threat situation template with its COA statement [S9] |
| 4. COA analysis (war game) | Threat situation templates and COA statements, event templates and matrices, relative combat power matrices [S9]. The S2 or G2 helps build the DST [S9] |
| 5. COA comparison and 6. COA approval | IPB conclusions refined from information collection during planning [S9] |
| 7. Orders production | IPB results go into the base order and annexes [S9] |
| Troop leading procedures (company) | The battalion intelligence cell gives the company commander finished products: threat situation templates and COA statements, terrain and weather products (MCOO, weather effects, light data), and civil considerations tools. Company commanders should not need to refine them [S9] |

### Table 5. J2 support to each OPP stage (Canada)

Source: CFJP 5.0 Change 2 [S16], with the 2003 CF intelligence doctrine for terms [S18].

| OPP stage [S16] | Intelligence work | Products |
|---|---|---|
| 1. Initiation | The CDS issues an Initiating Directive. The operational command, with strategic staffs, prepares intelligence assessments and starts joint intelligence preparation of the battlespace (JIPB) [S16]. Review of the situation draws on the JIPB [S16]. | Initial threat assessment; initial JIPB |
| 2. Orientation | Mission analysis leading to the Commander's Planning Guidance [S16]. The J2 develops the PIRs, focused on risk; at strategic level the SJS and J2 Plans complete them. In domestic operations a "statement of the intelligence problem" usually replaces PIRs [S16]. | PIRs; JIPB; threat assessment (at strategic level, CDI completes it [S16]) |
| 3. COA development | "Enemy courses should be developed first, regardless of which side has the initiative." The staff deduces the most likely and most dangerous enemy courses [S16]. | Enemy COAs (most likely, most dangerous); input to own COAs and their wargaming |
| 4. Plan development | The CONOPS becomes the plan. Annex D (Intelligence) has standard appendices: threat assessment, intelligence architecture, areas of intelligence responsibility and interest, CCIRM, target intelligence, HUMINT, IMINT, battlespace effects, enemy situation, enemy capabilities, enemy COA, security intelligence, SIGINT, OSINT, geomatic support [S16]. | Annex D and its appendices |
| 5. Plan review | Progress review and plan adjustment during execution [S16] | Updated threat assessment; INTSUMs |

### Table 6. Main differences between US, Canadian and NATO doctrine

| Topic | United States | Canada (CAF) | NATO |
|---|---|---|---|
| Doctrine precedence | National joint doctrine | NATO doctrine first, then US, UK, AUS, NZ multilateral doctrine, then other NATO nations' doctrine [S17] | Allied joint publications |
| Planning process | JPP, 7 steps [S7]; Army MDMP, 7 steps [S9] | OPP, 5 stages [S16] | Not compared here; NATO uses its own operations planning process (see gap list) |
| Intelligence process | 6 categories [S4] | Intelligence cycle, 4 stages (2003 doctrine) [S18] | Intelligence cycle, 4 stages [S23] |
| Preparation of the environment | JIPOE (joint) [S6]; IPB (Army) [S9] | JIPB in CFJP 5.0 and the 2003 doctrine [S16][S18] (the 2011 CFJP 2-0 term was not verified) | JIPOE, led by J2 Plans [S24] |
| Intelligence annex | Annex B (APEX) [S5] | Annex D [S16] | Not verified here |
| Requirements and collection | CRM, COM, collection management authority held by the JIOC for the J2 [S5] | CCIRM [S18][S16] | IRM and CM, formerly CCIRM [S24] |
| Senior intelligence authority | CCMD J2 with JIOC; JTF J2 with JISE [S5] | CDI has functional authority over all defence intelligence [S20]. Commander CJOC leads defence intelligence requirements for joint operations and issues joint intelligence doctrine [S20]. JIOC set up under a CFINTCOM and CJOC arrangement [S22]. | J2 current ops in the JOC; J2 plans supports J5 [S24] |
| Strategic requirements | DIA dynamic threat assessments, theater intelligence assessments, NISP [S5] | CDS Critical Intelligence Requirements; DND/CF strategic intelligence requirements maintained by CDI [S16] | Not covered |
| Coalition gateway | Foreign disclosure officer, NDP [S5][S28] | National intelligence cells (NICs) as gateways between national agencies and the JIC [S18] | Not covered |
| Security scales | Classified levels plus CUI [S26][S29] | Protected A, B, C and Classified Confidential, Secret, Top Secret [S27] | NATO Unclassified to Cosmic Top Secret (extension preset) [S41] |

### Table 7. What a J2 does at each level

| Level | US example | Canadian example | Focus | Typical products |
|---|---|---|---|---|
| Strategic (national and theater) | CCMD J2 and JIOC. National strategic intelligence serves the President, NSC, SecDef and CCDRs; theater strategic intelligence supports joint operations [S4]. The JIOC coordinates theater intelligence and plans the shift from peace to war [S1][S5]. | CDI and CFINTCOM; the Strategic Joint Staff; CDS CIRs; Intelligence and Operations Look Ahead; strategic I&W [S16][S20][S21] | Warning (emerging and enduring problems) [S4]; theater campaign support; national and allied integration | Theater intelligence assessment, DTA inputs, Annex B for campaign and contingency plans, NISP inputs (US) [S5]; strategic threat assessments (Canada) [S16] |
| Operational (JTF) | JTF J-2 with a JISE (or JTF JIOC). The J-2 plans and directs the effort, recommends PIRs, manages the JTF collection plan, asks the CCMD JIOC for JIPOE, gives continuous threat warning, and provides target intelligence and BDA inputs [S5]. | JTF J2 with a Joint Intelligence Centre supporting the JTF HQ, NICs, and CCIRM [S18]; reachback to CJOC and the JIOC [S20][S22] | Forecasting enemy capabilities, intentions and options more than current combat [S16] | JIPOE, intelligence estimate, Annex B or D, collection plan, INTSUM and INTREP, event templates, HVT list |
| Tactical (division, brigade, battalion) | G2 or S2 runs IPB inside the MDMP; the battalion cell gives finished products to companies [S9] | Brigade G2; Canadian Army terms match IPB (HVT, situation, event and decision support templates) [S40]; current unit structure not verified (see gaps) | Enemy, terrain, weather and civil considerations for the fight [S11] | Threat situation templates, MCOO, weather effects matrix, event template and matrix, HPTL inputs, PIR and information collection plan [S9] |

### Table 8. Roles in the J2 section: responsibilities, products and handoffs

"Doctrinal role" is the human position doctrine describes. "Team member" is the proposed agent (section 2, Table 12). A dash means no agent in the default template.

| Doctrinal role | Responsibilities | Products owned | Inputs | Outputs and handoffs | Team member |
|---|---|---|---|---|---|
| J2 (Director of Intelligence) and deputy | Plans and directs the intelligence effort for the JFC. Recommends PIRs, identifies shortfalls, makes sure the staff's intelligence needs are met [S5]. Supervises PIR, ISR and RFI management [S15]. Leads JIPOE and the systems view for design [S6]. Leads Annex B development (CCMD J2) [S5]. Chairs the JIPOE coordination cell [S6]. | Intelligence estimate; J-2 staff estimate; Annex B or D [S5][S16] | Commander's guidance, higher intelligence, all section products | Estimate and annex to J5; current picture to J3; PIR recommendations to commander | j2-chief |
| JIOC or JISE watch (current intelligence, I&W) | Continuous threat warning to the commander, battle staff and components [S5]; warning watch and RFI desk in the JISE [S5]; J2 current ops in the JOC [S24]; I&W in the ops/intel brief [S15] | INTSUM, INTREP, SUPINTREP [S18]; indicator board; daily ops/intel brief input | Collection results, OSINT feeds, unit reports | Warnings and current intelligence to J3 and JOC; tips to requirements-manager | watch-officer |
| All-source analysts (by domain or region) | OB analysis, terrorism and WMD, air, ground, naval, missile and space desks in the JISE or JIOC [S5]. Fuse all disciplines [S4]. | Adversary capabilities, OB, situation assessments | Single-source reports, OSINT, GEOINT | To threat-analyst and j2-chief | threat-analyst (plus jipoe-analyst) |
| JIPOE or IPB analysts | The four JIPOE or IPB steps [S6][S9] | OE definition, PMESII and systems views, environment effects, adversary COA set, situation templates, event template and matrix, NAIs [S6] | Mission, AO and AOI, higher JIPOE | To J5 and J3 for COA development and wargaming | jipoe-analyst (steps 1 and 2), threat-analyst (steps 3 and 4) |
| Targeting (target intelligence) | Target intelligence for the command targeting function and joint targeting boards; assessing targeting effectiveness [S5]; target development in the JISE [S5] | Target system analysis inputs; HVT list; BDA inputs [S5][S6] | JIPOE step 3 and 4, COGs | HVT list to J3 and J5 for HPT selection in the wargame [S6] | target-analyst |
| Collection manager (CM) | Validates requirements, matches them to resources, keeps requesters informed [S5]; analysis-driven collection management; JIOC exercises CMA and CRM [S5]; JCMB [S5][S24] | Collection plan; collection requests; ISR synchronization inputs | PIRs, indicators, NAIs | Collection plan to J3 for asset allocation approval [S15] | collection-manager |
| Requirements manager (PIR, IR, RFI) | Intelligence requirements management: records, validates and prioritizes requirements and RFIs [S24]; RFI desk [S5] | PIR and IR register; RFI log; indicator and specific information requirement matrix | Commander's guidance, decision points, gaps | PIR recommendations to j2-chief for commander approval; RFIs to higher | requirements-manager |
| Intelligence planners | Coordinate the planning and direction part of the process; develop and staff Annex B; work with collection managers and analysts on gaps [S5] | Annex B drafts; intelligence planning products | JPP outputs | To J5 planning teams | j2-chief (merged) |
| HUMINT | Intelligence from human sources [S4]; integrated with CI in the J-2X [S5] | HUMINT reports (single source) | Tasking under legal authority | Reports to all-source analysis | None (partner integration only) |
| SIGINT | Intelligence from foreign communications and noncommunications emitters [S4] | SIGINT reports | National systems | Reports to all-source analysis | None (partner integration only) |
| GEOINT (imagery and geospatial) | Imagery, IMINT and geospatial information [S4]; GEOINT cell at the JTF [S5]; geomatic support appendix in Annex D [S16] | Terrain analysis, imagery reports, overlays | Imagery, maps, elevation | To jipoe-analyst and target-analyst | geoint-analyst |
| OSINT | Intelligence from information any member of the public can lawfully get; it is open to manipulation and needs tradecraft review [S4] | Source register with grades; OSINT reports | Public and commercial sources | To all analysts | osint-analyst |
| CI | Five functions against foreign intelligence activities and sabotage [S4]; J-2X integrates CI and HUMINT [S5] | CI threat assessment (adversary intelligence collection capability) | Partner CI reporting | To J3 (OPSEC, force protection) and deception planners [S6] | None for collection; threat-analyst covers adversary intelligence capability from open sources |
| MASINT | Quantitative and qualitative analysis of physical attributes of targets and events [S4] | MASINT reports | Technical sensors | To all-source analysis | None (partner integration only) |
| I&W analyst | Warning: urgent communication about threats; emerging and enduring warning problems [S4] | Indicator lists; warning notices | Watch reporting | To commander and J3 | watch-officer (operational); dedicated warning-analyst at strategic level |
| Red cell | J-2 threat emulation [S5]; plays the adversary in the wargame [S6] | Adversary commander's view; reverse JIPOE of friendly forces [S6] | Adversary COAs, friendly COAs | To J5 wargame; deception insights to J3 and IO | red-cell |
| Red team | Independent from conventional analysts; reviews key assessments and OPLAN assumptions [S5]; crosses staff functions [S7] | Alternative analysis | All products | To commander and planners | Not a J2 member by doctrine; tradecraft-reviewer applies the diagnostic techniques inside J2 (see Pitfall 6) |
| Dissemination and knowledge manager | Push and pull dissemination set by the intelligence staff [S18]; portal and IM/KM program [S15] | Dissemination plan; product library | Approved products | To all staff and partners | release-officer |
| Foreign disclosure officer | Knows national disclosure policy; advises on sanitized or downgraded products; reviews release to multinational partners [S5][S28] | Release decisions; tear lines | Products for release | To partners | release-officer (advises only; a person decides) |
| GEOINT or METOC specialist (weather) | Weather effects on operations [S9] | Weather effects matrix | Forecasts | To jipoe-analyst | geoint-analyst |
| Information operations intelligence support | IO analysis in the JISE; liaison to the IO cell [S5] | Information environment analysis | OSINT | To IO cell | jipoe-analyst (information environment in step 2 [S6]) |
| National intelligence cell (coalition) | Gateway between a nation's agencies and the JIC [S18] | National releases | National systems | To JIC | None (partner integration) |

### Table 9. Product catalogue

| Product | Owner (member) | Doctrinal basis | Contents (minimum) | Consumers |
|---|---|---|---|---|
| Intelligence estimate | j2-chief | An appraisal of available intelligence that sets out the COAs open to the adversary and their order of probability [S5] | Situation, adversary capabilities, COAs ranked, conclusions | Commander, J5 |
| J-2 staff estimate | j2-chief | Intelligence and CI capability to support each friendly COA [S5] | Factors limiting collection, processing, analysis, dissemination | J5, commander |
| Annex B (US) or Annex D (CAF) | j2-chief, release-officer | Contents per Figure III-4 of JP 2-01 [S5]; Annex D appendices per CFJP 5.0 [S16] | See Tables 3 and 5 | J5, subordinate units |
| JIPOE or IPB products | jipoe-analyst, threat-analyst, geoint-analyst | Four steps [S6][S9] | OE definition, environment effects, adversary evaluation and COGs, COA set | J5, J3 |
| Adversary COAs: MLCOA and MDCOA | threat-analyst | Each COA in probability order, with a situation template, COA description and HVT list [S6] | Type of operation, earliest time, location, objectives, scheme, end state [S6] | J5, J3, red-cell |
| HVT list | threat-analyst, target-analyst | Part of each adversary COA [S6]; Army example in step 3 and 4 [S9] | Target sets by adversary function | J3 and J5 wargame |
| HPT list inputs | target-analyst | HVTs refined in wargaming become HPTs [S6]; the HPTL comes from MDMP step 3 [S9] | Intelligence on each HPT | J3, fires, targeting board |
| Event template and event matrix | threat-analyst, collection-manager | Built in JIPOE step 4 [S6] | NAIs, indicators, time windows | collection-manager, J3 |
| Decision support template inputs | threat-analyst, j2-chief | The DST is a combined intelligence and operations estimate in graphic form, built by the J2 to J6 [S6] | TAIs, decision points, time phase lines [S6] | J3, J5 |
| PIR and IR register, RFI log | requirements-manager | PIRs tied to decision points, reviewed in the battle rhythm [S15] | Requirement, decision supported, indicators, latest time of value | j2-chief, collection-manager |
| Collection plan | collection-manager | Principles of collection management [S5] | Requirement to indicator to NAI to asset recommendation | J3 (approves allocation) [S15] |
| INTSUM | watch-officer | Periodic summary of the adversary situation in the commander's area, with an assessment of future intent [S18] | Period, activity, assessment, changes | All staff |
| INTREP | watch-officer | Spontaneous report needing urgent attention, with deductions [S18] | Event, deduction | Commander, J3 |
| Threat assessment | threat-analyst | Annex D appendix [S16]; Bastion product [S42] | Threat actor, capabilities, intent, MLCOA, MDCOA | Commander, J3, J4 |
| Source register | osint-analyst, geoint-analyst | Evaluation step; independent reliability and credibility grades [S24][S18] | Source, URL, date, access date, grade, provenance | All analysts, tradecraft-reviewer |
| Tradecraft review | tradecraft-reviewer | ICD 203 [S14]; ATP 2-33.4 [S13] | Pass or fail per standard, fixes | j2-chief |
| Release review | release-officer | Foreign disclosure [S5][S15]; compilation rule [S26] | Label, releasability, aggregation check | j2-chief, then consumers |

### Table 10. Tradecraft and skills by member

Sources: ATP 2-33.4 [S13], ICD 203 [S14], JP 2-01.3 [S6], AJP-2.1 [S24].

| Member | Core tradecraft | Structured analytic techniques (ATP 2-33.4 names) [S13] |
|---|---|---|
| j2-chief | ICD 203 standards; bottom line up front; separating fact from judgement [S14] | Key assumptions check; indicators or signposts of change |
| jipoe-analyst | PMESII systems view; geospatial perspective; information environment [S6] | Sorting, chronologies, matrices, link analysis, event mapping |
| geoint-analyst | Terrain and weather effects; MCOO; imagery interpretation [S9][S4] | Matrices, event mapping |
| osint-analyst | Admiralty grading done twice, independently; provenance; deception awareness [S4][S24] | Quality of information check |
| threat-analyst | COG analysis; adversary COAs in probability order; deception and surprise [S6] | Analysis of competing hypotheses; Team A/Team B; high-impact/low-probability; "what if?" |
| target-analyst | Target system analysis; HVT and critical factors [S6][S9] | Functional analysis using critical factors analysis |
| red-cell | Threat emulation; reverse JIPOE [S6] | Red hat/team analysis; outside-in thinking |
| watch-officer | Indicators and warning; current intelligence [S4] | Indicators or signposts of change; chronologies |
| requirements-manager | PIR writing tied to decisions [S15] | Weighted ranking |
| collection-manager | Matching requirements to capabilities; avoiding over-reliance on one discipline [S5] | Matrices |
| tradecraft-reviewer | ICD 203 checklist; likelihood scale; source descriptors (ICD 206 named by ICD 203) [S14] | Key assumptions check; devil's advocacy; quality of information check |
| release-officer | Write for release; FD categories; compilation [S15][S26] | None |

The ICD 203 likelihood scale [S14]:

| Term | Alternative term | Range |
|---|---|---|
| almost no chance | remote | 01 to 05 percent |
| very unlikely | highly improbable | 05 to 20 percent |
| unlikely | improbable | 20 to 45 percent |
| roughly even chance | roughly even odds | 45 to 55 percent |
| likely | probable | 55 to 80 percent |
| very likely | highly probable | 80 to 95 percent |
| almost certain | nearly certain | 95 to 99 percent |

The NATO grading scale [S24] (the 2003 CF doctrine reads credibility 1 as "confirmed by other sources" [S18]):

| Reliability of the source | Credibility of the information |
|---|---|
| A Completely reliable | 1 Completely credible (older text: confirmed by other sources) |
| B Usually reliable | 2 Probably true |
| C Fairly reliable | 3 Possibly true |
| D Not usually reliable | 4 Doubtful |
| E Unreliable | 5 Improbable |
| F Reliability cannot be judged | 6 Truth cannot be judged |

### Table 11. Data sources and MCP servers

Access: **Public** means free (registration may be needed). **Commercial** means a paid licence. **Partner** means a government or alliance integration that an organization must arrange. No row here has been reviewed or run. Under the owner's rules, every MCP server is untrusted code until someone reads it, and it goes in with a person-written capability manifest scoped to named members [S43].

| Source or server | What it gives the J2 | Access | Members | Notes |
|---|---|---|---|---|
| Built-in WebSearch, WebFetch, CheckCitations | General OSINT, doctrine, citation checks | Public | osint, jipoe, threat, tradecraft | Already in the extension's research team [S43] |
| TRADOC ODIN: Worldwide Equipment Guide, DATE scenarios, TC 7-100 | Fictional OPFOR equipment and force structures and full training scenarios for demos | Public; no login, cleared for public release per a 2021 TRADOC FOIA reply [S31] | threat, red-cell, target | Best demo data: realistic and fictional, so there is no real-world targeting risk. Recheck access terms first |
| GDELT (for example cyanheads/gdelt-mcp-server) | Global news event stream for I&W and current intelligence | Public | watch, osint | Directory listing only [S35] |
| world-intel-mcp (community) | 68 tools across 27 domains, including ACLED conflict events and OpenSky flights | Public code; ACLED and OpenSky need accounts and have their own terms [S33] | osint, watch | Large attack surface; review carefully before use |
| global-sentinel-mcp (community) | GDELT, OpenSky, Cloudflare Radar, Polymarket | Public; anonymous OpenSky is rate-limited [S34] | watch | Drop prediction-market tools: they are not intelligence sources |
| OpenStreetMap servers (for example open-streetmap-mcp) | Geocoding, features, routes, infrastructure | Public; OSM usage policies apply [S36] | geoint, jipoe, target | Good for LOC and infrastructure analysis |
| GIS MCP servers (for example gis-mcp-server) | Spatial analysis, file operations | Public code [S37] | geoint | Local analysis keeps data private |
| Microsoft Planetary Computer STAC (planetary-computer-mcp) | Sentinel, Landsat and DEM search | Public [S38] | geoint, collection | Collection-manager can check imagery availability |
| Copernicus Data Space (copernicus-mcp) | Sentinel imagery | Public, free account [S39] | geoint | Community server |
| Planet (planetlabs/planet-mcp) | Commercial high-revisit imagery | Commercial; official vendor server [S32] | geoint | Needs a licence and an API key handled as a secret |
| Other commercial imagery, AIS, equipment and threat databases | Higher fidelity than public sources | Commercial | geoint, threat | Not researched here; list per customer |
| HUMINT, SIGINT, MASINT, CI reporting; national and coalition systems | Single-source reporting | Partner only | All-source analysts | Never in default templates. Needs accredited systems, which the extension does not claim to be [S41]. Route through the Agent Exchange design [S43] |
| Bastion MCP (`mcp__bastion__bastion`) | Exercise scenario, PIR tools, COP | Partner (Bastion instance) | j2-chief, requirements | Optional, as in the Bastion note [S42] |
| Proposal: local "intel-workbench" MCP | Source register with grades, PIR to indicator to NAI matrix, event matrix store, GeoJSON overlay writer, MGRS and DTG helpers, ICD 203 likelihood lint, INTSUM and INTREP skeletons | Built in-house; local only | All | Gives every member structured, checkable artifacts rather than prose |

### Table 12. Proposed team (operational level, 12 members)

Format follows the extension's team file: `role`, `model` (deep, standard, fast), `tools`, `reports-to`, `privacy` [S42]. Tool groups: READ = Read, Glob, Grep, TodoWrite, Recall, Remember. WEB = WebSearch, WebFetch, CheckCitations. WRITE = Write, Edit. DOCS = CreateDocument, CreatePdf, CreatePresentation, RenderSvg [S43]. `mcp__...` names are placeholders until a server is chosen.

| Member | role | model | tools | reports-to | Brief instructions |
|---|---|---|---|---|---|
| j2-chief | planner | deep | READ, WRITE, DOCS, CheckCitations | (lead) | Turns the commander's guidance into intelligence direction. Splits work into parallel lanes. Assembles the intelligence estimate, J-2 staff estimate and Annex B or D. Recommends PIRs but never approves them. Hands back: estimate, annex, MA brief input, list of decisions for the commander. |
| requirements-manager | planner | standard | READ, WRITE | j2-chief | Keeps the PIR and IR register and the RFI log. Ties each PIR to a decision point and a latest time of value. Breaks PIRs into indicators. Runs the PIR review each cycle. Hands back: register, RFIs, proposed PIR changes. |
| collection-manager | planner | standard | READ, WRITE, STAC and imagery search MCP (read only) | j2-chief | Builds the collection plan from PIRs, indicators and the event template's NAIs. Recommends capabilities and timing but never tasks assets. Marks what needs J3 approval or a partner. Hands back: collection plan and requests. |
| jipoe-analyst | researcher | deep | READ, WEB, WRITE, RenderSvg, OSM MCP | j2-chief | JIPOE steps 1 and 2 (IPB steps 1 and 2 at tactical level): OE limits, PMESII and ASCOPE, information environment, environment effects on both sides, avenues of approach, key terrain. Lists gaps for the requirements-manager. Hands back: step 1 and 2 products with sources. |
| geoint-analyst | researcher | standard | READ, WEB, WRITE, RenderSvg, OSM, GIS and STAC MCP | jipoe-analyst | Terrain, weather and imagery: MCOO or terrain effects, weather effects matrix, LOC and infrastructure overlays as GeoJSON. Grades each source. Hands back: overlays, matrices and imagery notes. |
| osint-analyst | researcher | standard | READ, WEB, WRITE, GDELT MCP | j2-chief | Public-source collection against assigned requirements only. Every item goes in the source register with URL, publication date, access date, A to F and 1 to 6 grades (assessed separately) and a deception note. No collection on people in your own country. Hands back: register entries and an OSINT report. |
| threat-analyst | researcher | deep | READ, WEB, WRITE | j2-chief | JIPOE steps 3 and 4. Uses existing threat models first (ODIN for exercises). Covers capabilities, COGs and adversary intelligence capability. Writes the full adversary COA set in probability order, each with a situation template, COA statement and HVT list; MLCOA and MDCOA must be named. Writes the event template and matrix. Uses ACH. Hands back: COA set, templates, HVT list. |
| watch-officer | researcher | fast | READ, WEB, WRITE, GDELT MCP | j2-chief | Current intelligence and I&W. Watches indicators from the event matrix. Writes an INTSUM per cycle and an INTREP whenever an indicator fires. Flags new gaps. Hands back: INTSUM, INTREPs, indicator board. |
| target-analyst | researcher | deep | READ, WRITE, OSM MCP | threat-analyst | Target system analysis and the HVT list at system and function level. Gives intelligence on HPTs after the wargame, plus BDA inputs. Works on exercise or fictional scenarios only and never on real, named people. Never recommends engagement. Hands back: HVT analysis and HPT intelligence. |
| red-cell | reviewer | deep | READ, WEB, WRITE | j2-chief | Plays the adversary commander in COA analysis: action, reaction, counteraction against each friendly COA, starting with the MLCOA and then the MDCOA. Runs a reverse JIPOE of friendly forces for deception and OPSEC. Hands back: wargame adversary log and lessons for the event template. |
| tradecraft-reviewer | reviewer | deep | READ, CheckCitations, WebFetch, Write | j2-chief | Blocking gate. Checks every product against the ICD 203 standards and the likelihood scale, with no likelihood and confidence in one sentence. Checks fact versus judgement, stated assumptions, alternatives, sourcing and grades. Runs a key assumptions check and devil's advocacy on key judgements. Writes SIGN-OFF or NOT READY with numbered fixes. |
| release-officer | reviewer | standard | READ, WRITE, DOCS | j2-chief | Blocking gate before any handoff. Confirms each product's label and releasability against the organization's policy. Checks for compilation risk (unclassified items that together reveal more). Applies write-for-release, prepares tear lines, and keeps the dissemination list and product library. Advises only; a person releases. Writes CLEARED or HOLD with reasons. |

### Table 13. Workflow mapped to JPP, OPP and MDMP, with parallel lanes

Proposal. Parallel lanes are marked with ‖. Doctrine allows overlap: JIPOE and IPB are continuous [S6][S9]; threat evaluation can start from existing threat models before step 1 is done [S9]; steps can run at the same time in a crisis [S7].

| JPP step (OPP stage; MDMP step) | Lane A | Lane B | Lane C | Gate and handoff |
|---|---|---|---|---|
| 1 Planning initiation (Initiation; Receipt of mission) | j2-chief: intelligence direction; time plan | watch-officer: current situation baseline ‖ osint-analyst: first source sweep | threat-analyst: pull existing threat models | None; initial RFIs out |
| 2 Mission analysis (Orientation; Mission analysis) | jipoe-analyst ‖ geoint-analyst: steps 1 and 2 | threat-analyst: step 3, then step 4 once steps 1 to 3 are ready | requirements-manager: gaps to IRs and PIR candidates, then collection-manager: initial plan | tradecraft-reviewer then release-officer, then MA brief input to J5 and the commander (PIRs approved by a person) |
| 3 COA development (COA development: enemy COAs first [S16]) | threat-analyst: final COA set, MLCOA and MDCOA | target-analyst: HVT analysis ‖ red-cell: prepares the adversary play | geoint-analyst: avenues and mobility for friendly COAs | Gates, then to J5 and J3 |
| 4 COA analysis and wargaming | red-cell: plays the adversary in the J5 wargame | threat-analyst: refines event template; j2-chief: DST inputs with J3 | requirements-manager: PIRs from decision points ‖ target-analyst: HPT intelligence | Gates, then to J5, J3 and targeting |
| 5 COA comparison | j2-chief: J-2 staff estimate per COA | tradecraft-reviewer: alternatives and assumptions check | None | To J5 |
| 6 COA approval | Commander (person) decides | None | None | Decision recorded |
| 7 Plan or order development (Plan development; Orders production) | j2-chief: Annex B or D, intelligence estimate | collection-manager: final collection plan ‖ release-officer: dissemination plan | watch-officer: execution indicator board | Gates, then annex into the plan |
| Execution and assessment (Plan review) | watch-officer: INTSUM cycle and INTREPs | requirements-manager: PIR review; closes answered PIRs | threat-analyst: updates COAs on change | Evaluation and feedback to j2-chief |

### Table 14. Scaling by level

| Level | Members | What changes |
|---|---|---|
| Strategic (CCMD, or CDI and CFINTCOM supporting the CDS and CJOC) | About 8: j2-chief, requirements-manager, collection-manager (national and partner requests), jipoe-analyst (theater systems view), threat-analyst, warning-analyst (replaces watch-officer; tracks emerging and enduring warning problems [S4]), red-cell, tradecraft-reviewer, release-officer (partner sharing is central [S15]). Drop target-analyst and geoint-analyst (fold into jipoe). | Products: theater intelligence assessment, DTA and NISP inputs (US) [S5]; CDS CIR responses, strategic threat assessment (Canada) [S16]; Annex B for campaign and contingency plans. Longer horizons (years, not hours). |
| Operational (JTF) | 12 (Table 12) | Full JIPOE, Annex B or D, collection plan, targeting support, INTSUM cycle. |
| Tactical, brigade or division (G2, S2) | 6: s2-lead, ipb-analyst (all four IPB steps, terrain and weather with OAKOC and MCOO), collection-manager (information collection plan), watch-officer, target-analyst (HPTL inputs to the targeting working group), tradecraft-reviewer (also does release) | IPB names, not JIPOE [S9]; MDMP mapping; hours not days |
| Tactical, battalion (S2) | 4: s2-lead, ipb-analyst, watch-officer, tradecraft-reviewer | Products tailored for company troop leading procedures [S9] |

### Table 15. Pitfalls (summary; details in section 3.7)

| # | Pitfall | Fix in the template |
|---|---|---|
| 1 | Citing superseded or restricted publications as if current | Table 1 currency marks; say "public reference edition" |
| 2 | Mixing echelon terms: OAKOC and IPB at a joint HQ, JIPOE in a battalion; Annex B in a CAF plan | Level variants and a nation switch (US or CAF) in the guidance |
| 3 | Planning only against the most likely adversary COA | Wargame each friendly COA against at least the MLCOA and MDCOA [S6] |
| 4 | J2 tasking collection assets or approving PIRs | CM recommends; J3 approves allocation [S15]; commander approves PIRs |
| 5 | HVT and HPT treated as the same | HVTs (JIPOE) become HPTs only after wargaming [S6] |
| 6 | Red cell and red team treated as the same | Red cell emulates the threat; red team is independent [S5][S7] |
| 7 | Mirror-imaging and deception | Plan for deception and reverse JIPOE [S6]; ACH; red cell |
| 8 | Fact and judgement mixed; likelihood and confidence in one sentence | ICD 203 gate [S14] |
| 9 | Grades: reliability and credibility not assessed separately; circular reporting counted as confirmation | Independent grading [S24][S18]; check independence of sources |
| 10 | Compiling unclassified data into a classified picture | release-officer compilation check [S26] |
| 11 | Collecting on own-nation persons | Hard rule in osint-analyst [S30][S20] |
| 12 | Real-world targeting by an AI | Exercise and fictional scenarios only; no engagement recommendations |
| 13 | Labels mistaken for accreditation | Template guidance quotes the extension's own disclaimer [S41] |
| 14 | PIRs not tied to decisions, or too many | PIR register requires decision point and latest time of value [S15] |
| 15 | Evaluation and feedback skipped | PIR review in every cycle [S15] |

---

## 3. Details

### 3.1 US joint doctrine

**Keystone and currency.** JP 2-0 is the keystone document for joint intelligence [S2]. The current edition is dated 26 May 2022 [S1]. The Joint Staff page says the full list of joint publications is on JEL+ with a CAC [S2]. The hierarchy chart dated 12 December 2024 marks current JPs as requiring a CAC for web access [S3]. That chart shows only JP 2-0 in the intelligence column. Under "Joint Guides" it lists "Joint Intelligence Preparation of the Operational Environment" [S3]. JP 2-01 and JP 2-01.3 do not appear [S3]. The most likely reading is that their content was folded into JP 2-0 (2022) and the JIPOE joint guide. That is an inference from the chart, not a stated rescission, so the confidence is MEDIUM.

**The process.** The 2013 JP 2-0 lists six interrelated categories of intelligence operations, from planning and direction to evaluation and feedback [S4]. The January 2026 CRS primer, which cites the 2022 JP 2-0, describes the same iterative process. It lists collection with processing and exploitation as one item, so it shows five lines while saying "six" [S1]. JIPOE is "the continuous process through which J-2 manages the analysis and development of products" that help the commander understand the OE [S4].

**Levels.** Strategic intelligence covers national strategic intelligence (for the President, NSC, Congress, SecDef, senior leaders and CCDRs) and theater strategic intelligence. Operational intelligence is used mainly by CCDRs, subordinate JFCs and component commanders. Tactical intelligence is used for battles, engagements and special missions [S4].

**Product categories.** Warning, current, general military, target, scientific and technical, counterintelligence, identity, and estimative intelligence [S4]. Warning carries urgency. Defense intelligence recognizes emerging warning concerns and enduring warning problems [S4].

**Organizations.** Each CCMD JIOC coordinates theater intelligence [S1]. JIOCs plan the shift from peacetime to wartime, do analysis-driven collection management, and exercise collection management authority for the J-2 [S5]. At a JTF a JISE is normally set up; a JTF JIOC can be set up for large or long campaigns [S5]. JISE capabilities can include OB analysis, collection management, target intelligence, IO analysis, a warning watch and an RFI desk [S5]. The JFC normally establishes a J-2X that combines HUMINT and CI [S5]. A JTF J-2 also liaises with the joint targeting coordination board, the JCMB, the IO cell, the personnel recovery team, the joint planning group, the GEOINT cell, the red team and the JIPOE coordination cell [S5].

**Annex B and the estimates.** The CCMD J-2 leads Annex B, using the CJCSM 3130.03 format. Two processes inform it: the intelligence estimate and the J-2 staff estimate [S5]. At strategic level DIA validates or produces a dynamic threat assessment for each directed plan, and the Joint Staff J-2 leads the national intelligence support plan [S5].

**JIPOE coordination cell.** A J-2 representative normally chairs it. Members can include DNI, combat support agency, J-3, J-4, J-5, collection management, red team, SOF, multinational and J-2X representatives [S6].

**Deception and humility.** Adversaries have US doctrine and may exploit JIPOE through deception, or by choosing a COA other than the obvious "most likely" one. Analysts can run a reverse JIPOE on their own forces [S6]. JIPOE "should not be considered a crystal ball", and planning only against the most likely COA leaves the force open to surprise [S6].

**Practice notes from the Joint Staff J7 (2019).** Collection is an operations and intelligence team effort and should not be delegated to the collection manager. The J2 prioritizes collection, but the J3 approves allocation of collection assets. J2 staffs often struggle with operational and strategic assessments. Foreign disclosure is critical, and FDO training helps a "write for release" culture. Evaluation and feedback are often the least observed parts of the process. Keep an intelligence representative in the J5 assessment working groups [S15].

### 3.2 Army IPB, the S2 and G2, and multidomain operations

**IPB.** IPB has four steps and is continuous [S9]. Its products are threat situation templates with COA statements and HVT lists, event templates and matrices, MCOOs and terrain assessments, and weather aids [S9]. Threat evaluation does not begin with IPB: staffs build threat models earlier and refine them during mission analysis [S9]. This is why the template lets threat-analyst start before step 1 is finished. During step 2, whenever assumptions fill gaps, the staff must make sure the commander knows which conclusions rest on assumptions [S9].

**MDMP and TLP.** Table 4 gives the step-by-step mapping. The battalion intelligence cell's finished products for company commanders (threat templates, terrain and weather aids, civil considerations tools) are the model for the 4-member battalion variant [S9].

**Multidomain operations (FM 3-0, 2022).** MDO is "the combined arms employment of joint and Army capabilities to create and exploit relative advantages", across the competition continuum [S11]. FM 3-0 describes the OE as five domains seen through the physical, information and human dimensions [S11]. The intelligence warfighting function covers understanding the enemy, terrain, weather, civil considerations and other significant aspects of the OE. It fuses reconnaissance, surveillance, security operations and intelligence operations: "Commanders drive intelligence and intelligence drives operations" [S11]. Commanders "must fight for intelligence and share it with adjacent units and across echelons" [S11]. Peer threats use sensor networks and long-range fires that exploit electromagnetic signatures [S11].

Template implications (Proposal):
- JIPOE step 1 must cover all five domains, the electromagnetic spectrum and the information dimension.
- threat-analyst must assess the adversary's sensing and targeting of friendly forces (signature management input to the J3).
- watch-officer must cover competition below armed conflict, not just combat.

FM 2-0 (2023) is reported to be nested in FM 3-0 and to describe ISR layers across space, air and land. That comes from a news report, not the manual [S12].

### 3.3 Canadian doctrine

**Precedence and alignment.** CF doctrine must be consistent with that of principal allies. Canada develops doctrine with the US, UK, Australia and New Zealand, so it stays compatible with NATO and the "five eyes" community. When NATO and allied doctrine conflict, the order is: NATO doctrine; Canada, US, UK, AUS and NZ multilateral doctrine; other NATO nations' doctrine; then other doctrine [S17]. Template consequence: the Canadian variant should use NATO terms first.

**Authorities.** DAOD 8008-0 (18 Dec 2017) defines defence intelligence as all intelligence from tactical to strategic level in support of military operations and planning. The CDI exercises functional authority over all defence intelligence programs and activities, but never overrides DM direction or CDS orders. Commander CJOC leads, coordinates and approves defence intelligence requirements for joint operations, directs assigned intelligence capabilities, and issues joint intelligence doctrine and procedures. Every defence intelligence activity must comply with Canadian and international law. Sensitive activities need consultation and DM or CDS approval [S20]. CFINTCOM's units include the Canadian Forces Joint Imagery Centre, the CF National Counter-Intelligence Unit, the Joint Meteorological Centre, the Mapping and Charting Establishment and Joint Task Force X (HUMINT) [S21].

**JIOC.** A Canadian JIOC stood up in August 2021. Its first phase merged the Joint Targeting Intelligence Centre and the CF Integrated Command Centre Intelligence Watch, under a temporary arrangement between CFINTCOM and CJOC. Its aims include integrating intelligence, operations and plans, supporting the CAF joint targeting capability and improving the intelligence watch. Initial capability was planned for 2024 to 2027 and full capability for 2027 to 2029 [S22]. Current status was not verified.

**OPP and Annex D.** See Table 5. The 2008 text names organizations that have since changed (for example CDI and SJS roles, and DFAIT) [S16], so the template should describe functions, not 2008 office names.

**JTF intelligence structure (2003 doctrine, superseded but the most detailed public text).** A Joint Intelligence Centre is the main intelligence organization supporting a JTF HQ. It fuses component capabilities in one place and keeps I&W, current intelligence, collection management and general military intelligence going in quiet periods. A production section has current intelligence, ORBAT, C2W support, target development and geographic data teams. Specialist staff cover EW, artillery, engineer, SF, maritime and OSINT. There are single-source feeds and liaison officers [S18]. National intelligence cells from contributing nations act as gateways to national agencies [S18]. CCIRM manages the collection plan [S18]. The CAF uses the NATO INTREP, INTSUM and SUPINTREP [S18]. The 2011 CFJP 2-0 (B-GJ-005-200/FP-001) is cited by Canadian Forces College papers [S19], but no public copy was found. A Canadian reviewer should check the template against it.

**NATO alignment (AJP-2, AJP-2.1).** NATO's cycle has four stages, and direction is both external (commanders) and internal (senior intelligence officer to specialist elements) [S23]. At operational level a task-organized intelligence staff provides J2 Current Operations embedded in the JOC, central to intelligence requirements management, collection management and JISR. J2 Plans supports the J5, supports targeting, and leads JIPOE [S24]. IRM and CM were formerly called CCIRM [S24]. The template's j2-chief and watch-officer split follows this current ops and plans divide.

### 3.4 Roles and handoffs to J3, J5 and J4

Proposal, from the doctrine above:

- **To J5 (plans):** JIPOE, adversary COAs with MLCOA and MDCOA, COGs and decisive points, intelligence estimate, J-2 staff estimate, Annex B or D, red cell play in the wargame, and an intelligence representative in assessment working groups [S6][S5][S15].
- **To J3 (operations):** current intelligence and warnings, step 3 evaluations for force ratios, HVT analysis, event template and DST inputs (NAIs, TAIs, decision points), collection plan for asset approval, BDA inputs, adversary intelligence capability for OPSEC and deception [S6][S5][S15].
- **To J4 (logistics):** effects of terrain, weather and infrastructure on sustainment and LOCs (step 2: avenues, key nodes and links, infrastructure) [S6]; threats to LOCs and bases from the threat assessment; J4 is a member of the JIPOE coordination cell [S6] and builds the DST with the J2 [S6].
- **From other sections:** commander's guidance and approved PIRs; friendly COAs from J5 for the wargame; approved asset allocation and operational reports from J3; logistics information requirements from J4 (Proposal: they enter the PIR and IR register like any other requirement).

### 3.5 Skills, tools and MCP

Tables 10 and 11 hold the detail. Three design points:

1. **Make products structured.** Most J2 products are tables, matrices and overlays: the PIR register, event matrix, collection plan, HVT list, source register. A local "intel-workbench" MCP or a set of file schemas lets the gates check them mechanically. For example: every PIR has a decision point; every HVT appears in a COA; every source has two grades and a date. Bastion's product registry fields are a starting point [S42].
2. **Prefer fictional, public exercise data for demos.** TRADOC's ODIN publishes the Worldwide Equipment Guide and the DATE scenarios, cleared for public release [S31]. A demo built on them shows real doctrine with no real-world sensitivity.
3. **Keep partner disciplines behind the exchange design.** HUMINT, SIGINT, MASINT and CI need authorities [S4][S20] and accredited systems. The extension's labels "do not make this device accredited for classified information" [S41]. Partner feeds belong in the governed exchange from note 01, with label ceilings per MCP server [S43].

### 3.6 Draft team file (operational variant)

This sketch uses the extension's team format [S42]. Instructions are shortened. Each must stay under the 1,200-word warning limit and say what it hands back.

```markdown
---
name: J2 Intelligence (JTF)
description: Joint intelligence staff for JPP or OPP planning and execution. Unclassified templates; work products follow your labels.
privacy: private
---

## j2-chief
role: planner
model: deep
tools: Read, Glob, Grep, TodoWrite, Recall, Remember, Write, Edit, CreateDocument, CreatePdf, CreatePresentation, RenderSvg, CheckCitations
privacy: private
You direct the J2 team and assemble its estimate. Turn the commander's guidance into intelligence direction, split the work into parallel lanes, and keep the PIR review in every cycle. You recommend PIRs; a person approves them. Write the intelligence estimate, the J-2 staff estimate and Annex B (US) or Annex D (CAF), as the project's NATION setting says. Nothing leaves the team without SIGN-OFF from tradecraft-reviewer and CLEARED from release-officer. Hand back: the estimate, the annex, the mission analysis brief input, and a list of decisions for the commander.

## threat-analyst
role: researcher
model: deep
tools: Read, Glob, Grep, TodoWrite, Recall, Remember, WebSearch, WebFetch, CheckCitations, Write, Edit
reports-to: j2-chief
privacy: private
Your area is JIPOE steps 3 and 4 (IPB steps 3 and 4 for tactical teams). Start from existing threat models. Write every adversary COA in order of probability, each with a situation template, COA statement and HVT list, and name the most likely and most dangerous. Write the event template and matrix with NAIs and indicators. Use analysis of competing hypotheses and plan for deception. Use ICD 203 likelihood terms only. Hand back: the COA set, templates and HVT list, with sources.

(... the other ten members as in Table 12 ...)
```

### 3.7 Pitfalls in detail

1. **Stale citations.** The public JP 2-01 and JP 2-01.3 are not on the current hierarchy chart [S3], and the 2022 JP 2-0 is CAC-only [S2]. Templates that quote "JP 2-01.3 (2014)" as current will look wrong to a doctrine expert. Write "JP 2-0 (2022); method per JP 2-01.3 (2014), public reference edition".
2. **Wrong frame for the echelon or nation.** At a joint HQ the frame is JIPOE [S6]. In a battalion it is IPB with the MDMP [S9]. In a CAF plan the intelligence annex is Annex D [S16], and Canadian doctrine puts NATO terms first [S17]. Bastion's J2 agents mixed these up [S42].
3. **Most-likely-only planning.** Doctrine requires wargaming each friendly COA against at least the MLCOA and MDCOA, and warns that the least likely COA may be chosen precisely to surprise [S6].
4. **Overreach by the J2.** The J2 recommends PIRs; the commander approves them. The J2 prioritizes collection; the J3 approves allocation [S15]. Bastion's own validation fixtures test that the J2 must not issue collection orders or make operational decisions [S42].
5. **HVT versus HPT.** HVTs come from JIPOE. They become HPTs only when wargaming shows their loss significantly helps a friendly COA [S6].
6. **Red cell versus red team.** The J-2 red cell emulates the threat. The red team is separate from the conventional analysts and reviews assessments and plan assumptions [S5][S7]. A J2 team can hold a red cell. A true red team should sit outside it, at command or planning cell level (Proposal), so the template's tradecraft-reviewer is a quality gate, not the command red team.
7. **Mirror-imaging and deception.** Adversaries know US doctrine and may deceive JIPOE analysts on intent or timing, or condition them to accept unusual activity as normal [S6]. OSINT is especially open to manipulation [S4].
8. **Analytic standards.** ICD 203 requires separating intelligence information from assumptions and judgements, stating assumptions, analysing alternatives, explaining changes in judgement, and using fixed likelihood terms. It bans putting a confidence level and a likelihood term in one sentence [S14].
9. **Source grading errors.** Reliability and credibility must be judged independently [S24][S18]. Older Canadian text defines credibility 1 as "confirmed by other sources" [S18]. Repeated reports from one origin are not independent confirmation (Proposal: the register records each item's origin).
10. **Compilation.** Under EO 13526 section 1.7(e), individually unclassified items may be classified when their compilation reveals an additional association or relationship [S26]. An AI that fuses large amounts of OSINT about one military topic can create exactly this. release-officer must flag compilations and hand the decision to a person with the right authority.
11. **Own-nation persons.** DoD intelligence components must collect information on US persons by the least intrusive means, and DoD treats publicly available information as least intrusive, not unrestricted [S30]. In Canada, defence intelligence must comply with Canadian and international law, and sensitive activities need senior approval [S20]. osint-analyst must not profile individuals in its own country.
12. **AI and targeting.** Doctrine gives the J2 target intelligence, not targeting decisions [S5][S6]. Proposal: target-analyst works only on fictional or exercise scenarios at system and function level, never names real people for action, and never recommends engagement.
13. **Labels are not accreditation.** The extension's labels check what NEAR AI sends to a model and what its own file tools read. They cannot see everything a shell command or add-on server does. Until verified credentials arrive, a clearance is self-declared, not an enforced boundary [S41]. Templates must stay unclassified, and classified material must never be loaded [S42]. Canada separates Protected A, B and C (injury outside the national interest) from Classified Confidential, Secret and Top Secret (injury to the national interest) [S27]. The extension ships those as two scales, with a note that a security officer should confirm them [S41].
14. **Foreign disclosure.** Classified military information goes to foreign governments only when there is a clearly defined benefit to the United States [S28]. The FDO advises on sanitized or downgraded products [S5]. release-officer can prepare and advise but cannot release.
15. **PIR sprawl and skipped feedback.** PIRs must be tied to decision points and reviewed in the battle rhythm. Evaluation and feedback are often neglected [S15].

### 3.8 Gaps and open questions

1. **CFJP 2-0 (2011) text.** Not found in public. A Canadian intelligence officer should review the Canadian variant, including whether current Canadian doctrine uses JIPOE or JIPB.
2. **JIPOE Joint Guide and JP 2-0 (2022) content.** CAC only [S2][S3]. A US reviewer with access should confirm that no step or product name changed from the 2014 public text.
3. **ATP 2-01.3 Change 2 (Jan 2024) and FM 2-0 (Oct 2023).** Seen only through a retail listing and a news report [S10][S12]. Fetch from armypubs before shipping.
4. **NATO COPD and the NATO intelligence annex letter.** Not researched. Needed for a NATO variant.
5. **Canadian brigade S2 and G2 structure today.** Sources were thin (college papers and a wiki-derived page); not used in the template.
6. **MCP servers.** None reviewed or run. Each needs a code review, a capability manifest and a label ceiling [S43].
7. **Current status of the Canadian JIOC phases after 2024.** Not verified [S22].

---

## Sources

Confidence: HIGH means the primary text was read; MEDIUM means an official secondary source, an older edition, or a draft; LOW means a catalogue, retail or directory listing. "Archive" gives the Internet Archive copy that was read when the original site blocked automated download.

- **[S1]** Congressional Research Service, "Defense Primer: Intelligence Support to Military Operations" (IF10574), updated 23 January 2026. https://www.everycrsreport.com/files/2026-01-23_IF10574_28b689723a8f28f80ac83360728474332e0fb859.html . MEDIUM.
- **[S2]** Joint Chiefs of Staff, "Joint Publications Intelligence Series" web page, snapshot 10 May 2026. https://www.jcs.mil/Doctrine/Joint-Doctrine-Pubs/2-0-Intelligence-Series ; archive http://web.archive.org/web/20260510212105/https://www.jcs.mil/Doctrine/Joint-Doctrine-Pubs/2-0-Intelligence-Series/ . HIGH.
- **[S3]** Joint Chiefs of Staff, "Joint Doctrine Hierarchy" chart, legend dated 12 December 2024. https://www.jcs.mil/Portals/36/Documents/Doctrine/pubs/status.pdf ; archive http://web.archive.org/web/20250206004927/https://www.jcs.mil/Portals/36/Documents/Doctrine/pubs/status.pdf . HIGH.
- **[S4]** Joint Chiefs of Staff, JP 2-0, "Joint Intelligence", 22 October 2013 (superseded by the 26 May 2022 edition). https://irp.fas.org/doddir/dod/jp2_0.pdf ; archive http://web.archive.org/web/20250616221100/https://irp.fas.org/doddir/dod/jp2_0.pdf . HIGH for the 2013 text.
- **[S5]** Joint Chiefs of Staff, JP 2-01, "Joint and National Intelligence Support to Military Operations", 5 July 2017. https://fas.org/irp/doddir/dod/jp2_01.pdf ; archive http://web.archive.org/web/20210125154337/https://fas.org/irp/doddir/dod/jp2_01.pdf . HIGH for the text; MEDIUM for currency.
- **[S6]** Joint Chiefs of Staff, JP 2-01.3, "Joint Intelligence Preparation of the Operational Environment", 21 May 2014. https://irp.fas.org/doddir/dod/jp2-01-3.pdf ; archive http://web.archive.org/web/20250306113845/https://irp.fas.org/doddir/dod/jp2-01-3.pdf . HIGH for the text; MEDIUM for currency.
- **[S7]** Joint Chiefs of Staff, JP 5-0, "Joint Planning", 1 December 2020. https://irp.fas.org/doddir/dod/jp5_0.pdf ; archive http://web.archive.org/web/20261010202527/https://irp.fas.org/doddir/dod/jp5_0.pdf . HIGH.
- **[S8]** US Army War College, "AY25 Campaign Planning Handbook", 14 August 2024 (lists JP 5-0 of 1 December 2020). https://media.defense.gov/2024/Aug/14/2003523369/-1/-1/0/AY25%20Campaign%20Planning%20Handbook_240814.PDF . MEDIUM (seen through search excerpt).
- **[S9]** Headquarters, Department of the Army, ATP 2-01.3, "Intelligence Preparation of the Battlefield", 1 March 2019, with Change 1 of 6 January 2021. https://irp.fas.org/doddir/army/atp2-01-3.pdf ; archive http://web.archive.org/web/20250608192807/https://irp.fas.org/doddir/army/atp2-01-3.pdf . HIGH.
- **[S10]** Barnes & Noble listing, "Army Techniques Publication ATP 2-01.3 Intelligence Preparation of the Operational Environment Change 2 January 2024", n.d., accessed 18 November 2026. https://www.barnesandnoble.com/w/army-techniques-publication-atp-2-013-intelligence-preparation-of-the-operational-environment-change-2-january-2024-united-states-government-us-army/1144826182 . LOW.
- **[S11]** Headquarters, Department of the Army, FM 3-0, "Operations", October 2022. https://irp.fas.org/doddir/army/fm3-0.pdf ; archive http://web.archive.org/web/20250611000306/https://irp.fas.org/doddir/army/fm3-0.pdf . HIGH.
- **[S12]** Theresa Hitchens, "With new intel doctrine, Army turning its sights to ISR modernization", Breaking Defense, 11 October 2023. https://breakingdefense.com/2023/10/with-new-intel-doctrine-army-turning-its-sights-to-isr-modernization/ . MEDIUM.
- **[S13]** Headquarters, Department of the Army, ATP 2-33.4, "Intelligence Analysis", 10 January 2020. https://irp.fas.org/doddir/army/atp2-33-4.pdf ; archive http://web.archive.org/web/20250630164329/https://irp.fas.org/doddir/army/atp2-33-4.pdf . HIGH.
- **[S14]** Office of the Director of National Intelligence, ICD 203, "Analytic Standards", signed 2 January 2015, with technical amendment signed 21 January 2022. https://www.dni.gov/files/documents/ICD/ICD-203.pdf (now redirects to https://archive.dni.gov/files/documents/ICD/ICD-203.pdf ). HIGH.
- **[S15]** Joint Staff J7 Deployable Training Division, "Insights and Best Practices Focus Paper: Intelligence Operations", third edition, September 2019. https://www.jcs.mil/Portals/36/Documents/Doctrine/fp/intell_ops_fp.pdf ; archive http://web.archive.org/web/20260429184256/https://www.jcs.mil/Portals/36/Documents/Doctrine/fp/intell_ops_fp.pdf . HIGH.
- **[S16]** Department of National Defence, CFJP 5.0 (B-GJ-005-500/FP-000), "The Canadian Forces Operational Planning Process (OPP)", Change 2, April 2008. https://publications.gc.ca/collections/collection_2010/forces/D2-252-500-2008-eng.pdf ; catalogue https://publications.gc.ca/site/eng/9.693032/publication.html ; archive http://web.archive.org/web/20261009052702/https://publications.gc.ca/collections/collection_2010/forces/D2-252-500-2008-eng.pdf . HIGH for the text; MEDIUM for currency.
- **[S17]** Department of National Defence, CFJP 01 (B-GJ-005-000/FP-001), "Canadian Military Doctrine", 2009. https://publications.gc.ca/collections/collection_2010/forces/D2-252-2009-eng.pdf ; catalogue https://publications.gc.ca/site/eng/9.692210/publication.html . HIGH.
- **[S18]** Department of National Defence, B-GJ-005-200/FP-000, "Joint Intelligence Doctrine" (Joint Doctrine Manual), 21 May 2003, superseded. Library and Archives Canada web archive https://bac-lac.wayback.archive-it.org/web/20061215091732/http://www.ops.forces.gc.ca/jointDoc/docs/jointIntelligenceDoctrine_e.pdf ; copy read http://web.archive.org/web/20061215100953/http://www.ops.forces.gc.ca/jointDoc/docs/jointIntelligenceDoctrine_e.pdf . HIGH for the text; superseded.
- **[S19]** Canadian Forces College, Joint Command and Staff Programme service paper (CSC 49) citing "B-GJ-005-200/FP-001, Canadian Forces Joint Publication 2-0, Intelligence, 2011", n.d. https://www.cfc.forces.gc.ca/papers/csc/csc49/sp/WilliamsL.pdf . LOW (citation seen through search excerpt; paper not readable).
- **[S20]** National Defence, DAOD 8008-0, "Defence Intelligence", date of issue 18 December 2017. https://www.canada.ca/en/department-national-defence/corporate/policies-standards/defence-administrative-orders-directives/8000-series/8008/8008-0-defence-intelligence.html . HIGH.
- **[S21]** National Defence, "Canadian Forces Intelligence Command", page modified 7 July 2025. https://www.canada.ca/en/department-national-defence/corporate/organizational-structure/canadian-forces-intelligence-command.html . HIGH.
- **[S22]** National Defence, The Maple Leaf, "Joint Intelligence Operations Centre stands up", 6 December 2021. https://www.canada.ca/en/department-national-defence/maple-leaf/defence/2021/12/joint-intelligence-operations-centre-stands-up.html . HIGH.
- **[S23]** NATO Standardization Office, AJP-2, "Allied Joint Doctrine for Intelligence, Counter-Intelligence and Security", Edition A Version 2, February 2016 (NATO UNCLASSIFIED). https://jadl.act.nato.int/ILIAS/data/testclient/lm_data/lm_152845/Linear/JISR04222102/sharedFiles/AJP2.pdf ; archive http://web.archive.org/web/20250513070343/https://jadl.act.nato.int/ILIAS/data/testclient/lm_data/lm_152845/Linear/JISR04222102/sharedFiles/AJP2.pdf . MEDIUM (later editions may exist).
- **[S24]** NATO Standardization Office, AJP-2.1, "Allied Joint Doctrine for Intelligence Procedures", Edition B Version 1, ratification draft 1, undated (NATO UNCLASSIFIED). https://jadl.act.nato.int/ILIAS/data/testclient/lm_data/lm_152845/Linear/JISR04222102/sharedFiles/AJP21.pdf ; archive http://web.archive.org/web/20241211165709/https://jadl.act.nato.int/ILIAS/data/testclient/lm_data/lm_152845/Linear/JISR04222102/sharedFiles/AJP21.pdf . MEDIUM (draft).
- **[S26]** The White House, Executive Order 13526, "Classified National Security Information", 29 December 2009, section 1.7(e). https://www.archives.gov/isoo/policy-documents/cnsi-eo.html . HIGH.
- **[S27]** Treasury Board of Canada Secretariat, "Directive on Security Management, Appendix J: Standard on Security Categorization", in force (date as shown on the page), sections J.2.4.1 and J.2.4.2. https://www.tbs-sct.canada.ca/pol/doc-eng.aspx?id=32614 . MEDIUM (seen through search excerpt).
- **[S28]** Department of Defense, DoD Directive 5230.11, "Disclosure of Classified Military Information to Foreign Governments and International Organizations", 16 June 1992. https://irp.fas.org/doddir/dod/d5230_11.htm . HIGH for the text; currency not checked.
- **[S29]** Department of Defense, DoD Instruction 5200.48, "Controlled Unclassified Information (CUI)", effective 6 March 2020 (Department of the Air Force reprint). https://static.e-publishing.af.mil/production/1/saf_aa/publication/dodi5200.48_dafi16-1403/dodi5200.48_dafi16-1403.pdf . MEDIUM.
- **[S30]** US Indo-Pacific Command news, "DoD releases update of manual governing defense intelligence activities" (DoD Manual 5240.01), August 2016. https://www.pacom.mil/Media/News/News-Articles/Article/912071/dod-releases-update-of-manual-governing-defense-intelligence-activities/ . MEDIUM (seen through search excerpt; later revisions not checked).
- **[S31]** MuckRock, FOIA request "OPFOR Worldwide Equipment Guide (TRADOC)", TRADOC reply 2021. https://www.muckrock.com/foi/united-states-of-america-10/opfor-worldwide-equipment-guide-tradoc-116963/ ; ODIN at https://odin.tradoc.army.mil/ . MEDIUM.
- **[S32]** Planet Labs, "planet-mcp" repository, n.d., accessed 18 November 2026. https://github.com/planetlabs/planet-mcp . LOW (not reviewed).
- **[S33]** mdskills.ai directory, "world-intel-mcp", n.d., accessed 18 November 2026. https://www.mdskills.ai/mcp-servers/world-intel-mcp . LOW.
- **[S34]** PyPI, "global-sentinel-mcp", n.d., accessed 18 November 2026. https://pypi.org/project/global-sentinel-mcp/ . LOW.
- **[S35]** Claude Marketplaces directory, "gdelt-mcp-server" (cyanheads), n.d., accessed 18 November 2026. https://claudemarketplaces.com/mcp/cyanheads/gdelt-mcp-server . LOW.
- **[S36]** Glama directory, "open-streetmap-mcp" (jagan-shanmugam), n.d., accessed 18 November 2026. https://glama.ai/mcp/servers/@jagan-shanmugam/open-streetmap-mcp . LOW.
- **[S37]** LobeHub directory, "GIS MCP Server" (matbel91765), n.d., accessed 18 November 2026. https://lobehub.com/mcp/matbel91765-gis-mcp-server . LOW.
- **[S38]** PyPI, "planetary-computer-mcp", n.d., accessed 18 November 2026. https://pypi.org/project/planetary-computer-mcp/ . LOW.
- **[S39]** Glama directory, "copernicus-mcp" (wb1016), n.d., accessed 18 November 2026. https://glama.ai/mcp/servers/wb1016/copernicus-mcp . LOW.
- **[S40]** Canadian Army, Line of Sight, "Intelligence Preparation of the Battlefield" glossary, 15 October 2021. https://www.canada.ca/en/army/services/line-sight/articles/2021/10/intelligence-preparation-of-the-battlefield.html . MEDIUM (glossary only; confirms that Canadian Army terminology uses IPB, HVT, situation, event and decision support templates).
- **[S41]** This repository, `src/domain/gate/labels.ts` (`SCALE_PRESETS`, `LABELS_NOT_ACCREDITATION_TEXT`, `SCALE_PRESETS_CAVEAT_TEXT`) and `src/domain/gate/dominance.ts` (releasability in the clearance check), at release 0.4.33, read 18 November 2026. HIGH.
- **[S42]** This repository, `.planning/research/staff-teams/00-bastion-staff-teams.md` (Bastion J2 agents, product registry, validation fixtures, the extension's team file format), 18 November 2026. HIGH (internal).
- **[S43]** This repository, `.planning/research/staff-teams/01-agent-exchange.md` (partner MCP controls), and `src/agent/projectTypes.ts` (tool groups, research team Admiralty practice), 18 November 2026. HIGH (internal).

(Tag S25 was withdrawn during research and is intentionally unused.)
