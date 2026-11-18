# J3 Operations and J4 Logistics: doctrine research for agentic staff teams

**Researched:** 2026-11-18
**Scope:** US joint and Army doctrine plus Canadian joint doctrine, used to build J3 (operations) and J4 (logistics) agent team templates for the NEAR AI VS Code extension. These are the third and fourth staff teams the owner will demo.
**Sources:** Public and unclassified only. Each claim carries a source tag such as [S12]. The numbered list is at the end, with title, publisher, date and URL.
**Overall confidence:** MEDIUM. The planning and orders material is HIGH, because the full public text of JP 5-0 (2020) and FM 5-0 (2024) was read directly. The newest editions of JP 3-0 (2022), JP 3-04 (2022) and JP 4-0 (2023) could not be read from an official copy, so the claims about them rest on official listings plus secondary summaries.

**Confidence tags used below:**
- **[H]** means the claim was read in the primary text or on an official government page.
- **[M]** means an official publication was confirmed by two or more independent public sources.
- **[L]** means only one secondary source supports it. The repo's `classify-confidence` seam rates any unverified web finding LOW, and a cross-checked one MEDIUM. HIGH is used here only when the primary text itself was read.

**Model tiers** use the extension's three tiers, `deep`, `standard` and `fast`, from `src/gsd/library.ts` (`DEFAULT_ROLE_MODELS`, `readModelTiers`). Judgement roles get `deep`, structured production gets `standard`, and monitoring, extraction and checking get `fast`.

---

## Summary

1. **Both teams fit the planning process the product already models.** JP 5-0 (1 December 2020) defines seven JPP steps: planning initiation, mission analysis, COA development, COA analysis and wargaming, COA comparison, COA approval, and plan or order development [S1][H]. FM 5-0 (November 2024) uses the same seven-step shape for the Army MDMP, ending in "orders production, dissemination, and transition" [S2][H]. The Canadian Forces OPP has five stages: Initiation, Orientation, COA Development, Plan Development and Plan Review [S29][H][S28]. One mapping table can therefore drive all three.

2. **The J3 owns execution, and its work is split by time horizon.** JP 5-0 says planning continues during execution in three overlapping venues. Future plans covers the next phase or sequels. Future operations covers branches and "is normally addressed by the J-3". Current operations "are usually addressed by the organization's joint operations center" [S1][H]. This split is the backbone of the J3 team: a JOC (current operations) lane, a future operations lane, and a hand-off to the J5 for future plans.

3. **The J4 runs alongside the J3 rather than after it.** JP 5-0 says support planning "is conducted concurrently with force planning" and covers all the core logistics functions: deployment and distribution, supply, maintenance, logistic services, OCS, joint health services, and engineering [S1][H]. Those are the same seven functions the owner listed, so each one becomes a J4 team member.

4. **Annex letters differ between joint and Army orders, and the templates must not mix them up.** In a joint plan, Annex C is Operations and Annex D is Logistics [S1][H]. In an Army OPORD, Annex C is Operations, Annex D is Fires and Annex F is Sustainment [S2][H]. A template that writes "Annex D" for logistics in an Army brigade order is doctrinally wrong.

5. **Several current doctrine sources are not public, so the templates must cite public substitutes.** JP 3-04, Information in Joint Operations (14 September 2022), "is not being publicly released" [S14][M]. The official jcs.mil copies of JP 3-0 (2022) and JP 4-0 (2023) could not be fetched for this research. Their editions and main changes were confirmed only from secondary sources [S3][S4][S34][M]. Templates should name the publication and edition and paraphrase public summaries. They must never embed restricted text.

6. **Canadian structures changed in 2026, and the templates must reflect that.** The former 1st Canadian Division Headquarters in Kingston, CJOC's deployable joint HQ, was renamed the Canadian Joint Response Force Headquarters on 10 August 2026 [S32][H]. The Canadian Army is moving to NATO APP-28 for tactical planning by August 2026, and the Canadian Forces College will teach NATO AJP-5 as the joint operational planning process from the 2026/27 academic year [S30][H]. The Canadian templates need a "CFOPP (legacy) or AJP-5" switch.

7. **Human decision authority is the design constraint, not an add-on.** Every decision point in doctrine belongs to a commander: COA approval [S1], target approval through boards [S9][S10], FRAGO release, and contract requirement validation through review boards [S41]. The agents draft, check and recommend. A named human decides and releases. Targeting outputs need extra care. The US standard for weapon systems is "appropriate levels of human judgment over the use of force" (DoDD 3000.09, 25 January 2023) [S67][M]. The templates are staff aids, not weapon systems, but a demo that appears to automate target nomination would draw exactly this scrutiny.

8. **The tool split is clear.** Maps and military symbols (MapLibre or Leaflet with the MIT-licensed `milsymbol` library [S55]), routing and optimisation (Apache-2.0 Google OR-Tools [S56]), calendars, structured LOGSTAT validators and consumption calculators can all be built from public or open-source parts. The systems of record (JADOCS and its successor JTIC2S [S57], GCSS-Army [S46], DRMIS [S52], JOPES or TPFDD tooling [S64], OPLOG Planner [S47]) are government systems. They need partner integration inside an accredited enclave and stay out of scope for the unclassified product.

---

## Part A: J3 Operations

### A1. Doctrine baseline

| Publication | Edition | Public status | What the template takes from it |
|---|---|---|---|
| JP 3-0, Joint Campaigns and Operations | 18 June 2022 [S3][S4][M] | Listed on jcs.mil. The official copy could not be fetched here. | Joint functions, campaigning, competition continuum, the operational framework |
| JP 5-0, Joint Planning | 1 December 2020 [S1][H] | Public text read | JPP steps, planning horizons, transition, annex list, assessment |
| JP 3-33, Joint Force Headquarters | 2018 edition public (titled Joint Task Force Headquarters) [S11b][M]. A June 2022 revision is reported by one vendor source [L]. | 2018 public | JTF HQ organisation, JOC, boards and cells |
| J7 focus paper, Joint Headquarters Organization, Staff Integration, and Battle Rhythm | 3rd edition, September 2019 [S8][M] | Public on jcs.mil | Battle rhythm and B2C2WG practice |
| JP 3-60, Joint Targeting | 28 September 2018 [S10][M] | Released through the DoD FOIA reading room | Joint targeting cycle, JTWG, JTCB |
| JP 3-09, Joint Fire Support | April 2019 [S13][M] | Public copy exists | Joint fires element (JFE) composition |
| J7 focus paper, Integration and Synchronization of Joint Fires | 4th edition, July 2018 [S12][M] | Public | Fires and targeting best practice |
| JP 3-04, Information in Joint Operations | 14 September 2022 [S14][M] | **Not publicly released** | Information joint function. Use public summaries only. |
| ADP 3-13, Information | 27 November 2023 [S15][M] | Public | Army information advantage |
| JP 3-14, Joint Space Operations | 2023 rewrite [S16][M] | Reported publicly | Space mission areas |
| JP 3-12, Joint Cyberspace Operations | Public 2018 edition. The current edition was not confirmed. [S17][L] | Public copy of the older edition | Cyberspace operations integration |
| FM 3-0, Operations | 1 October 2022 [S18][H] | Public | Multidomain operations, convergence |
| FM 5-0, Planning and Orders Production | November 2024 [S2][H] | Public text read | MDMP, running estimates, orders, DST and DSM |
| FM 6-0, Commander and Staff Organization and Operations | May 2022 [S21][M] | Public | Integrating cells (CUOPS, FUOPS, PLANS) |
| CFJP 3.0, Operations | 1st edition, 2010 [S27][H] | Public catalogue | Canadian joint operations keystone |
| CFJP 5.0, The CF Operational Planning Process | Change 2, April 2008 [S28][H] | Public catalogue | CFOPP stages |

### A2. Joint functions, campaigning and phasing

- **Joint functions.** JP 3-0 has listed seven joint functions since the 2017 edition with Change 1 (October 2018), when information was added as the seventh: command and control, information, intelligence, fires, movement and maneuver, protection, and sustainment [S7][M]. The 2022 summary of changes says it updates the information function to match JP 3-04 [S3][L]. **Template use:** the J3 running estimate gets one section per joint function, and each member's brief names the functions it covers.
- **Campaigning and the competition continuum.** The 2022 edition adds global integration, global campaigns, campaigning, and competition continuum terms [S3][M][S6]. The older "conflict continuum" construct was replaced by the competition continuum in that edition [S5][L]. **Template use:** the J3 templates should not assume a war-only frame. A strategic-level J3 template runs day-to-day campaigning activities as well as crisis response.
- **Phasing.** No public source found here confirms what JP 3-0 (2022) says about the older six-phase model [gap]. **Recommendation:** make phases a free-form, user-named list in the template (for example "Phase I: Shape" or "Phase 1: Deploy") rather than hard-coding the 2006 to 2017 six-phase model.

### A3. Current operations, future operations and future plans

| Venue | Doctrinal focus | Usual owner | Typical outputs |
|---|---|---|---|
| Current operations | "Immediate or very near-term issues associated with ongoing operations", handled by the JOC [S1][H] | J3 through the JOC chief | Event log, CCIR alerts, COP updates, battle drills, immediate FRAGOs |
| Future operations | "Branches to current, on-going operations", "normally addressed by the J-3" [S1][H] | J3 future operations (J35 in many HQs) | Branch plans, FRAGOs, refreshed DST and DSM, synchronisation matrix |
| Future plans | "The next phase of operations or sequels" [S1][H] | J5 | Sequel plans. Hand off to the J5 team. |

- **Horizon lengths depend on the HQ.** One public US planning instruction uses under 24 hours for current operations and 24 to 96 hours for future operations [S68][L]. The template should make these values settings, not constants.
- **Transition is a doctrinal event.** JP 5-0 says that internally "transition occurs between future plans, future operations, and current operations", often through a transition brief or drill [S1][H]. **Template use:** a plan only moves from the J5 or FUOPS lane into the JOC lane through an explicit transition step that produces a transition brief. This is a state-machine transition the product should model and test.

### A4. JOC, battle rhythm and B2C2WG

- **What battle rhythm is.** The J7 focus paper describes the HQ battle rhythm as the structure for managing the HQ's most important internal resource, the time of the commander and staff. It also says well-planned interaction between J-codes, working groups, operational planning teams and decision boards uses the analytical capacity of the whole staff [S8][M].
- **Boards versus working groups.** "The main difference is the level of authority granted by the commander." Commanders chair boards or delegate decision authority to senior staff within a functional area [S9][M]. Working groups prepare, and boards decide. JP 5-0 calls these cross-functional bodies "boards, cells, centers, and working groups" that manage the flow of information to decision makers within the battle rhythm [S1][H].
- **Army equivalent.** FM 6-0 groups the staff by warfighting function in functional cells and by time horizon in integrating cells (CUOPS, FUOPS, PLANS). The current operations integration cell has "all staff sections ... represented either permanently or on call" [S22][M].

**Notional battle rhythm events that a J3 team runs or supports.** Names vary by HQ. This is a template default for the user to edit, not doctrine.

| Event | Type | Chair or owner | J3 team input | Output | Decision authority |
|---|---|---|---|---|---|
| Shift change brief | Center (JOC) | JOC chief | Event log, open actions, CCIR status | Watch handover | None |
| Commander's update brief or battle update assessment | Board | Commander | COP summary, running estimate, assessment snapshot | Commander guidance | Human commander |
| Operations synchronisation meeting | Working group | J3 or J35 | Synchronisation matrix, FRAGO drafts | Synchronised tasks, FRAGO drafts | J3 (human) releases |
| Targeting working group | Working group | Fires or JFE | Draft target lists with J2 | Recommendations to the board | None |
| Joint targeting coordination board | Board | Commander or a delegate [S10][M] | Targeting WG product | Approved target lists and priorities | Human commander or delegate |
| Information working group | Working group | IO cell | Information activity synchronisation | Recommendations | None |
| Assessment working group, then board | WG, then board | Assessment cell, then commander | MOE and MOP data | Assessment, recommended changes | Human commander |
| Logistics synchronisation (J4-led) | Working group | J4 | Operations timeline and priorities | Sustainment synchronisation | J4 (human) |

### A5. Targeting, fires, information, cyberspace, space and the COP

**Joint targeting cycle (JP 3-60).** It has six phases, which can run at the same time and support both deliberate and dynamic targeting [S10][S11][M]:

| Phase | J2 lead or support | J3 lead or support |
|---|---|---|
| 1. End state and commander's objectives | Supports | Leads with the commander |
| 2. Target development and prioritisation | Leads target development (intelligence) | Prioritisation in the JTWG |
| 3. Capabilities analysis | Supports | Fires or JFE leads |
| 4. Commander's decision and force assignment | Supports | Fires prepares. **The commander decides.** |
| 5. Mission planning and force execution | Supports dynamic targeting | Components execute. The JOC tracks. |
| 6. Assessment (renamed in the 2018 edition; the new phase name was not confirmed here) [S10][L] | Leads battle damage and combat assessment | The assessment cell takes inputs |

*The J2 and J3 split in this table is a template recommendation drawn from the doctrine's structure. It is not a quoted doctrinal assignment [M].*

- **Joint fires element.** JP 3-09 (2019) added space component, civil-military directorate and NGO representation to the typical JFE [S13][M]. The JFE is the J3's fires integration body.
- **Information.** JP 3-04 replaced JP 3-13. It is not public [S14][M]. The Army's ADP 3-13 (November 2023) prefers "information advantage" over "information warfare" and sets out five information activities: enable, protect, inform, influence and attack [S15][M]. **Template use:** the IO or information planner synchronises information activities into the operations plan. Public affairs and influence content stay notional, and every external message needs human approval.
- **Space.** The 2023 rewrite of JP 3-14 drops "space control" and "counterspace" and uses mission areas such as space domain awareness and offensive and defensive space operations [S16][M].
- **Cyberspace.** JP 3-12 covers command and control of cyberspace operations [S17][L]. At JTF level the template treats cyber and space as requests to supporting commands, tracked by the J3. The specific command and control arrangements are mostly not public, so the templates must not guess them.
- **COP.** Army CUOPS practice puts intelligence, fires, electronic warfare, air, logistics, protection and liaison representatives in one room around the battle captain [S23][L]. The agent equivalent is one shared COP artifact, a map plus layered GeoJSON plus an event log, that every member reads and only the JOC chief and watch officers write to.

### A6. Execution tools

| Tool | Doctrine | Owner in the team | Template behaviour |
|---|---|---|---|
| Running estimate | Each staff section keeps one, covering facts, assumptions, friendly status, enemy, civil considerations, and conclusions and recommendations with risk. It "always include[s] recommendations for anticipated decisions" [S2][H]. | Every member keeps its own. The J3 director consolidates. | One structured file per member, updated every battle rhythm cycle |
| WARNORD | "A preliminary notice of an order or action that is to follow" [S2][H] | Future operations, or the lead during planning | Drafted at JPP steps 1, 2 and 6. A human releases it. |
| FRAGO | "An abbreviated operation order issued as needed to change or modify an order or to execute a branch or sequel" [S2][H] | Future operations, or the JOC for immediate changes | Uses the five-paragraph format with changes only. A human releases it. |
| CCIR | Supports both understanding and decision making, links decisions to branch and sequel execution, and is "not a rigid reporting list" [S24][M] | J3 director proposes. The commander approves. The JOC monitors. | A CCIR register. Any watch officer alert that matches a CCIR is escalated at once. |
| DST and DSM | The DST is "a combined intelligence and operations graphic based on the results of wargaming that depicts decision points"; it comes out of MDMP step 4 [S2][H]. The DSM shows when each decision should be made [S24][M]. | Future operations builds it in wargaming. The JOC uses it in execution. | The DSM becomes the JOC's trigger table: decision point, indicator, NAI or source, recommended action, and decision maker. |
| Assessment | Monitoring progress, then evaluating against MOEs and MOPs [S1][H]. The J7 Assessment and Risk paper (March 2020) [S25] and the Commander's Handbook (September 2011, including Appendix B on JTF assessment cell composition) [S26][M] | Assessment cell | MOE and MOP register, data plan and assessment brief, on a set cycle |

### A7. Tactical level: MDMP, S3 and G3, battle captain, MDO convergence

- **MDMP.** It has seven steps: receipt of mission, mission analysis, COA development, COA analysis, COA comparison, COA approval, and orders production, dissemination and transition [S2][H]. Steps can be revisited iteratively before the order is produced [S2][H].
- **The S3 and G3** lead operations at battalion or brigade (S3) and division or corps (G3). At division, the G35 (future operations) and G5 (plans) run the FUOPS and PLANS cells. CALL found that a division G4 could spare only one sustainment planner for PLANS during a warfighter exercise, and recommended permanent warfighting-function representation in FUOPS and PLANS [S22][M]. **Template use:** this supports giving the J3 and J4 teams a standing liaison seat in each other's lanes instead of ad-hoc planning teams.
- **Battle captain and battle NCO.** The battle captain helps the commander, XO and operations officer control current operations and runs the command post. The battle NCO helps manage the TOC and stands in when needed [S23][L]. ATP 6-0.5 (2017) holds the TOC battle drills [S23][L].
- **MDO and convergence.** FM 3-0 (October 2022) makes multidomain operations the Army's operational concept: "the combined arms employment of joint and Army capabilities to create and exploit relative advantages" [S18][H]. Convergence is "an outcome created by the concerted employment of capabilities against combinations of decisive points in any domain" to create effects against "a system, formation, decision maker, or in a specific geographic area" [S19][M]. Planners track convergence windows, such as when air, space, cyber and maritime assets become available through the air tasking order cycle, using execution checklists and targeting synchronisation matrices [S19][M]. **Template use:** the tactical J3 template includes a convergence-window tracker, a timeline of when each domain's capability is available against each decision point.

### A8. Canadian doctrine: CFJP 3.0, CJOC, and the J3 in a JTF HQ

- **CFJP 3.0, Operations** is the Canadian joint operations keystone, 1st edition 2010 (catalogue D2-252/300-2010E-PDF) [S27][H]. RCAF doctrine also cites it as B-GL-005-300/FP-001 [S27b][M].
- **CJOC** "plans, directs, and integrates all-domain military operations" in Canada, across North America and abroad, except operations run only by CANSOFCOM or NORAD. Its components are JTF North, the Canadian Joint Response Force HQ, CAF task forces, the Canadian Forces Joint Operational Support Group, and the HQ. It is supported by air, maritime, space (3 Canadian Space Division) and cyber (CAF Cyber Command) component commands [S31][H].
- **The deployable JTF HQ** is now the Canadian Joint Response Force HQ (Kingston). It is a "high-readiness, scalable, and deployable joint headquarters" focused on humanitarian assistance and disaster relief, non-combatant evacuation and National Command Element duties, and it was renamed on 10 August 2026 [S32][H]. **Template use:** do not label the Canadian JTF HQ template "1 Cdn Div".
- **Regional JTFs double-hat division staff.** One Canadian Forces College paper notes that the 4th Canadian Division G3 also serves as the JTF Central J3 [S33][L]. **Template use:** a Canadian domestic-operations template should let one human hold both a G3 and a J3 role.
- **Planning.** The CFOPP's five stages are Initiation, Orientation (which produces the commander's planning guidance and the JIPOE), COA Development, Plan Development (which turns the CONOPS into an operation order) and Plan Review (monitoring, assessment and reporting) [S29][H]. It has been the basis for joint operational planning since 2002. AJP-5 replaces it at the Canadian Forces College from 2026/27, and APP-28 replaces the Army's CAOPP by August 2026 [S30][H]. Operational design sits in the Orientation stage of the CFOPP and in Mission Analysis in AJP-5 [S30][H].
- **Gap.** No public source was found that sets out the CJOC J3 internal organisation, for example its watch centre or current and future operations branches. The Canadian J3 template should reuse the generic JOC, FUOPS and plans hand-off structure. That structure matches CFJP 5.0's joint operations planning group approach, as described in the DND sustainment evaluation [S52][H], but CJOC-specific branch names should not be invented.

### A9. J3 roles, products and handoffs

| Role | Products it owns | Handoff to J2 | Handoff to J5 | Handoff to J4 |
|---|---|---|---|---|
| J3 director | J3 running estimate (consolidated), CCIR proposals, operations concept, base order paragraph 3 and Annex C | Receives intelligence estimate and PIR. Sends operational priorities for collection. | Receives approved plan and transition brief. Returns execution feedback for sequels. | Sends priorities of support. Receives sustainment feasibility. |
| JOC chief | Event and SIGACT log, COP, shift brief, battle drill execution, CCIR alerts | Receives intelligence updates in the JOC | None directly | LOGSTAT summary feeds the COP |
| Watch officer, or battle captain or NCO at tactical level | Watch log entries, first reports, battle drill checklists | Passes contact reports for analysis | None | Passes logistics incident reports to the JLOC |
| Future operations planner | Branch plans, FRAGOs, synchronisation matrix, DST and DSM refresh | Asks for an updated enemy COA and event template | Receives sequels for transition. Coordinates the boundary between branch and sequel. | Requests a sustainment check for each branch |
| Fires and effects coordinator (JFE) | Concept of fires, fires appendix, joint fires synchronisation | Targeting WG partner. Receives target development. | Fires input to sequels | Class V (ammunition) demand signal |
| Targeting officer | JTWG agenda and products, draft target lists (notional), combat assessment tracking | Close partner throughout. The J2 owns target intelligence and BDA. | None | None |
| Information planner (IO cell) | Information activities synchronisation, inputs to the communication synchronisation WG | Receives information environment analysis | Information input to sequels | None |
| Cyber and space planner | Cyber and space support requests, integration timeline | Receives cyber and space threat picture | Long-lead requests | None |
| Airspace and maritime liaison | Airspace coordination inputs, maritime coordination notes, LNO summaries | None | None | Airspace for resupply flights |
| Assessment analyst | MOE and MOP framework, data plan, assessment brief | Receives indicators from intelligence | Assessment informs sequels and plan changes | Receives sustainment MOPs |
| Liaison coordinator | LNO roster, RFI tracker, coordination log | Routes intelligence RFIs | Routes plan RFIs | Routes logistics RFIs |

### A10. J3 skills, tools and MCP

| Capability | Built from | Class | Notes |
|---|---|---|---|
| COP and map with military symbols | MapLibre or Leaflet, OpenStreetMap tiles, `milsymbol` (MIT; MIL-STD-2525E and APP-6 E rendering from v3.0) [S55][M] | Public, open source | Product-side MCP: `cop-map` (layers, symbols, GeoJSON import and export, event pins) |
| Event log and CCIR monitor | Structured log plus rule matcher | Built in | Product-side MCP: `joc-log` (append-only, timestamped in DTG format) |
| Battle rhythm scheduler | iCalendar (.ics) files | Public | Product-side MCP: `battle-rhythm` (events, attendees, inputs, outputs) |
| Orders templates (WARNORD, FRAGO, OPORD, annexes) | FM 5-0 and JP 5-0 formats [S1][S2] | Public | Product-side MCP: `orders` (versioning, change tracking, release gate) |
| DST and DSM builder, synchronisation matrix | Structured tables | Built in | Shared with the J2 team |
| Targeting workbook | Notional target list schema | Built in, notional only | Never connect to real target data in the unclassified product |
| Fires and targeting systems of record | JADOCS (being replaced by JTIC2S) [S57][M], AFATDS [S57] | Partner integration, government | Out of scope. Document only as a future accredited adapter. |
| Air tasking and airspace control systems | Government systems | Partner integration | Out of scope |
| Weather and light data | Public national weather services | Public | Read-only fetch tool |
| Assessment data store | Tabular MOE and MOP register | Built in | Shared with the J5 team |

### A11. Proposed J3 team (12 members)

| # | Name | Role | Tier | Tools | Instructions in brief |
|---|---|---|---|---|---|
| Lead | `j3-director` | J3 director, team lead | deep | All read. Writes the consolidated running estimate, CCIR register and orders drafts. | Synchronise the team to the commander's intent and battle rhythm. Consolidate running estimates. Propose CCIR. Present decisions as options with risk. **Never approve, release or decide.** Route every decision to the named human. |
| 1 | `joc-chief` | JOC chief, current operations | standard | `joc-log`, `cop-map` (write), `battle-rhythm` | Own the COP and event log. Run the shift brief. Execute battle drills from checklists. Escalate any CCIR match at once. Draft immediate FRAGOs for human release only. |
| 2 | `watch-officer` | Watch officer (tactical: battle captain or NCO) | fast | `joc-log` (append), `cop-map` (read) | Watch incoming reports, log them in a standard format, check them against the CCIR register and DSM triggers, and flag matches. Never interpret beyond the facts reported. Run two instances in parallel for continuous coverage. |
| 3 | `future-ops-planner` | Future operations (J35) | deep | `orders`, DSM builder, synchronisation matrix | Develop branches inside the future operations horizon. Keep the DSM current. Draft FRAGOs. Request J2 and J4 checks for each branch. Hand sequels to the J5 team. |
| 4 | `fires-effects-coordinator` | Fires and effects cell (JFE) | deep | Targeting workbook, synchronisation matrix | Integrate joint fires and non-lethal effects into the concept of operations. Run the targeting working group. Prepare board packages. **Do not nominate or approve real targets.** Every package carries "commander or delegate decision required" and "legal review required". |
| 5 | `targeting-officer` | Targeting | standard | Targeting workbook, `cop-map` (read) | Keep the notional target list and JTWG products. Track combat assessment with the J2 team. Check every entry against the no-strike and restricted lists the human supplies. |
| 6 | `information-planner` | IO cell, information advantage | deep | `orders`, `battle-rhythm` | Synchronise information activities (enable, protect, inform, influence, attack [S15]) with operations. Draft inputs only. Any external-facing message needs human and public affairs approval. |
| 7 | `cyber-space-planner` | Cyber and space planner | standard | Requests tracker, synchronisation matrix | Turn needs into support requests to supporting commands. Track lead times and convergence windows. State plainly when capability details are unknown or not public. |
| 8 | `airspace-maritime-liaison` | Airspace and maritime liaison | standard | `cop-map`, coordination log | Collect airspace and maritime coordination needs from all lanes and the J4, flag conflicts, and prepare coordination requests for the responsible human authority. |
| 9 | `assessment-analyst` | Assessment cell | deep | MOE and MOP register, charts | Build the MOE and MOP framework at mission analysis, run the assessment WG, and recommend changes with evidence. Separate data from judgement. |
| 10 | `liaison-coordinator` | Liaison officers and RFI manager | fast | RFI tracker, coordination log | Track LNOs, RFIs and suspense dates across the J2, J4 and J5 teams. Chase overdue items. Do not answer RFIs on behalf of other teams. |
| 11 | `release-guard` | Classification and authority guard | fast | Reads every outgoing product | Block release if a product holds real unit identifiers, real coordinates outside the exercise box, classification markings, restricted doctrine text, or a decision not marked as needing a named human. Return a reason. |

**Parallel lanes.** The JOC (members 1 and 2), future operations (3), the fires and targeting pair (4 and 5), information, cyber and space (6 and 7), and assessment (9) work in parallel. They share only read access to the COP and the synchronisation matrix. The lead consolidates them. The guard sits in series on the release path only.

### A12. J3 mapping to planning steps and execution

| JPP step [S1] / MDMP step [S2] / CFOPP stage [S29] | J3 team activity | Runs in parallel with |
|---|---|---|
| 1 Planning initiation / Receipt of mission / Initiation | Lead drafts WARNORD 1 and a planning timeline (FM 5-0 suggests about 30% of planning time for mission analysis and 20% for COA development [S69][L]). The JOC keeps running current operations. | J2 starts JIPOE. J4 starts the logistics estimate. |
| 2 Mission analysis / Mission analysis / Orientation | Specified and implied tasks. Each member writes its initial running estimate. Fires, information, cyber and space list capabilities and limits. Assessment drafts the MOE and MOP framework. Lead proposes CCIR. | All J3 members. J2 and J4 estimates. |
| 3 COA development / COA development / COA development | With the J5, outline COAs. Fires gives a concept of fires per COA. Cyber and space give request lead times. | J4 checks supportability per COA. |
| 4 COA analysis and wargaming | Run the wargame against the J2 red cell. Produce the synchronisation matrix, DST, DSM and draft CCIR. | J4 logistics wargame (consumption per COA) |
| 5 COA comparison | Score against the commander's criteria. | Each staff team scores its own criteria. |
| 6 COA approval | Prepare the decision brief. **The human commander decides.** WARNORD 3 follows. | None (a decision gate) |
| 7 Plan or order development / Orders production, dissemination and transition / Plan development | Base order paragraph 3, Annex C (Operations), fires appendix, assessment annex (Army Annex M [S2]). Transition brief to the JOC. | J4 writes Annex D (joint) or Annex F (Army). |
| Execution / Plan review | Battle rhythm loop: watch, then CCIR or DSM trigger, then FUOPS branch, then FRAGO draft, then human release. Assessment WG and board on a set cycle. | J4 JLOC loop |

### A13. What scales by level (J3)

| Aspect | Strategic (Joint Staff or CCMD; CJOC HQ) | Operational (JTF or CJRF HQ) | Tactical (division, brigade, battalion; Canadian brigade or battle group) |
|---|---|---|---|
| Planning frame | Campaign plans, global integration, competition continuum [S3] | Joint operation plans and orders | MDMP or troop leading procedures (US). APP-28 from 2026 (Canada). [S2][S30] |
| Time horizons | Weeks to years | Days to weeks | Hours to days |
| Current operations body | Command centre or JOC | JOC | TOC or main CP, CUOPS integration cell [S22] |
| Fires and targeting | Deliberate targeting, strategic effects | JTWG and JTCB, JFE [S10][S13] | Targeting WG, convergence windows [S19] |
| Team size | Full 12 | Full 12 | Merge 6 with 7, and 8 with 10, for about 9 |
| Typical human counterpart | J3 directorate | JTF J3 | S3 or G3, battle captain |

### A14. J3 pitfalls

1. **Automating a decision.** Approving a COA, releasing a FRAGO, approving a target list and changing CCIR are command decisions [S1][S9][S10]. Every template must make the release path one-way: an agent drafts, a named human approves, and only then does the product move to "released". Model this as a state machine (draft, checked, awaiting decision, approved or rejected, released) and test every transition.
2. **Targeting aggregation.** Even notional target lists can read as real if they use real places. Confine exercise data to a fictional area or an exercise box. Have the guard block real coordinates outside it. Never connect to real targeting systems in the unclassified build [S57].
3. **Citing restricted doctrine.** JP 3-04 is not public [S14]. Paste no text from restricted publications into templates. Cite the edition and public summaries.
4. **Annex letter confusion.** Joint Annex D is Logistics. Army Annex D is Fires and Annex F is Sustainment [S1][S2].
5. **Out-of-date Canadian names.** The 1 Cdn Div HQ is now the CJRF HQ [S32]. CFOPP is giving way to AJP-5 and APP-28 [S30].
6. **Hard-coded horizons and phases.** Horizon lengths and phase models differ by HQ [S68]. Make them settings.
7. **A watch officer that interprets.** Fast-tier models must log facts, not conclusions. The JOC chief and the lead make interpretations.
8. **Running estimates without recommendations.** FM 5-0 requires recommendations for anticipated decisions [S2]. Reject an estimate that has none.

---

## Part B: J4 Logistics

### B1. Doctrine baseline

| Publication | Edition | Public status | What the template takes from it |
|---|---|---|---|
| JP 4-0, Joint Logistics | 20 July 2023, revising the 4 February 2019 edition [S34][M] | Public copy hosted by the US Army War College library. Not read directly here. | Core functions, the J-4, the JLOC and JDDOC, planning and control |
| JP 5-0, Joint Planning | 1 December 2020 [S1][H] | Public text read | Support planning concurrent with force planning, Annex D, TPFDD definition |
| J7 focus paper, Sustainment | 6th edition, May 2022 [S36][M] | Public | Building an operational-level concept of support |
| JP 4-09, Distribution Operations | Revision of the 5 February 2010 edition. Current date not confirmed. [S37][L] | Public copy | JDDOC, distribution, movement control |
| JP 3-35, Deployment and Redeployment Operations | 10 January 2018 public. A 31 March 2022 edition is cited by a Marine Corps order. [S39][M] | 2018 public | Deployment, JRSOI, TPFDD use |
| JP 4-10, Operational Contract Support | 4 March 2019 [S40][M] | Public copy | OCS integration, requirements review |
| JP 4-02, Joint Health Services | Public copy. Current edition not confirmed. [S42][L] | Public copy | Joint force surgeon, patient movement |
| JP 4-06, Mortuary Affairs | 12 October 2011 [S43][M]. JP 4-0 (2023) substantially rewrote its mortuary affairs appendix [S34][L]. | Public | Mortuary affairs |
| ADP 4-0, Sustainment | July 2019 [S44][M] | Public | Elements of sustainment, warfighting function |
| FM 5-0 | November 2024 [S2][H] | Public | Army Annex F (Sustainment), running estimates |
| CFJP 4-0, Support | 1st edition, 2016 (B-GL-005-400/FP-001) [S49][H] | Public catalogue entry not located. Cited by DND publications. | Lines of support, JTFSC |

### B2. The core logistics functions

JP 5-0 lists the core logistics functions for support planning as deployment and distribution, supply, maintenance, logistic services, OCS, joint health services, and engineering [S1][H]. JP 4-0's chapter on core logistic capabilities uses the same areas [S34][M].

| Function | Covers (template scope) | J4 team member | Key products |
|---|---|---|---|
| Deployment and distribution | Strategic and theater movement, JRSOI, distribution network, movement control [S1][S37][S39] | `mobility-planner` | Deployment concept, movement tables (notional), distribution plan |
| Supply | Classes of supply, stockage, days of supply, consumption forecasts [S46] | `supply-planner` | Supply estimate, forecast, critical item list |
| Maintenance | Equipment readiness, recovery, repair parts | `maintenance-planner` | Maintenance concept, readiness summary |
| Logistic services | Food service, water, field services and related services. Mortuary affairs is handled here in this template (see B4). | `services-mortuary-planner` | Services concept, mortuary affairs concept |
| Engineering | General engineering support to sustainment: LOCs, infrastructure, base camps | `engineer-planner` | Engineering support concept (coordinated with the J3 engineer) |
| Operational contract support | Contracted support requirements, contractor management, requirements review [S40][S41] | `ocs-planner` | Contract support integration plan inputs, requirement packages |
| Joint health services | Health service support, patient movement, force health protection [S42] | `health-services-planner` | Surgeon's estimate inputs, medical concept of support |

### B3. Logistics estimate, concept of support, Annex D, and sustainment in planning

- **Logistics estimate.** In mission analysis the J4 builds a theater logistics overview, and "from this theater logistics overview (TLO), a logistics estimate can identify known and anticipated factors that may influence the logistics support" [S1][H]. At strategic level the Joint Logistics Estimate is one of the joint strategic estimates [S1][H].
- **Support planning** "is conducted concurrently with force planning to determine and sequence logistics and personnel support" according to the CONOPS [S1][H]. **Template use:** the J4 team starts at JPP step 1, not after COA approval.
- **Annex D.** In a joint CONPLAN or OPLAN the usual annexes include A (Task Organization), B (Intelligence), C (Operations) and D (Logistics) [S1][H]. In an Army order, sustainment goes in Annex F [S2][H].
- **Running estimate.** The FM 5-0 running estimate format covers logistics as one staff section's area [S2][H]. The J4 director keeps the consolidated logistics running estimate.

### B4. The JLOC, JDDOC, movement control, the TPFDD, and mortuary affairs

- **JLOC and JDDOC.** A public summary of JP 4-0 Chapter V says the CCMD J-4 oversees theater logistics, with the JLOC and/or JDDOC expanding "to synchronize and optimize force and materiel flow" [S58][L]. JP 4-09 has a chapter on the JDDOC and on controlling distribution, including movement control [S37][L]. The CENTCOM DDOC was the first of these centres [S63][M]. **Template use:** model a `jloc-chief` as the J4's current-operations watch, the logistics counterpart of the JOC.
- **Name collision.** DLA runs its own "Joint Logistics Operations Center", a 24/7 DLA facility [S59][M]. Templates must say "JTF J4 JLOC" or "DLA JLOC" explicitly.
- **Joint movement center.** Army doctrine (an older FM 4-0) says a joint force commander may create a joint movement center to exercise directive authority over movement control [S38][L]. JP 4-01.3 was folded into JP 4-09 in 2010 [S37][L].
- **TPFDD, high level and public only.** JP 5-0 defines the TPFDD as "the time-phased force, non-unit cargo, and personnel data combined with movement data for the operation plan, operation order, or ongoing rotation of forces" [S1][H]. During a crisis the TPFDD "is populated by FPs [force providers] with unit and movement data and becomes available for execution" [S1][H]. TPFDD development procedures are in CJCSM 3122.02, which is publicly released only through FOIA [S64][M]. **Template use:** the J4 team reviews a notional movement table for feasibility (lift, ports, timing against required delivery dates). It never builds or imports a real TPFDD. That needs JOPES-family systems through a partner [S64].
- **Mortuary affairs.** JP 4-06 (2011) is the dedicated publication [S43][M]. JP 4-0 (2023) substantially rewrote its mortuary affairs appendix [S34][L]. The template gives mortuary affairs its own named duty inside the services planner. It covers planning (collection points, evacuation flow, personal effects procedures), uses only notional numbers, and handles no personal data.

### B5. Army sustainment at tactical level (ADP 4-0), the S4 and G4, and the LOGSTAT

- **ADP 4-0 (July 2019)** sets out four elements of sustainment: logistics, financial management, personnel services, and health service support. The 2019 edition made financial management a separate element [S44][M].
- **LOGSTAT flow.** Battalion S4s review company input and forward a consolidated battalion LOGSTAT to the brigade S4 and the support operations officer [S45][M]. A LOGSTAT shows on-hand stock and projected needs out to 72 hours [S46][M].
- **What goes wrong with LOGSTATs, and what the agent should check** (from "The Trouble with LOGSTATs", 11 February 2025 [S46][M]):
  - Unclear definitions of on-hand, consumed and "100 percent" per commodity. Fix: publish definitions per echelon.
  - Reports passed up without analysis. FM 4-0 calls a LOGSTAT "a compilation of data that requires analysis before action". Fix: validate rather than just consolidate, and flag impossible values such as fuel above tank capacity.
  - Colour bands (amber below 90%, red at 70%) trigger emergency resupply too early.
  - Separate the forward support company's own needs from the bulk stocks it carries.
  - Forecast against the mission with tools such as QLET, OPLOG Planner and Mercury, or with manual planning factors (ATP 5-0.2-1) that need no connectivity. Use a PACE reporting plan. Keep a logistics COP (LOGCOP).
- **Planning factors.** CASCOM's Planning Data Branch develops Army planning factors under AR 700-8, and OPLOG Planner delivers them to the field. It forecasts weight and pallets over time per class of supply. It has historically been distributed through Army Knowledge Online [S47][M]. **Template use:** the consumption calculator takes planning factors **entered by the user** and never ships government factor tables.

### B6. Canadian doctrine: CFJP 4-0 Support, the J4, and the JTF support structure

- **CFJP 4-0, Support, 1st edition (2016), B-GL-005-400/FP-001.** It defines second-line support as "support capabilities that are organic or allocated to a formation" [S49][H].
- **Four lines of support.** As quoted by secondary sources [S50][L]:
  - First line: organic to the ship, unit or squadron.
  - Second line: at formation level.
  - Third line: provided to a force in a theatre or along strategic lines of communication.
  - Fourth line: strategic resources such as national depots, contractors and industry.
- **JTF Support Component (JTFSC).** CFJP 4-0 names the JTFSC as the organisation that conducts operational-level support, answering to the JTF commander [S50][L]. A DND evaluation confirms that major domestic and expeditionary operations "may have an integral" JTFSC to arrange theatre-level support [S52][H]. A National Support Element has provided second-line and limited third-line support in practice, for example in Latvia [S49][H].
- **CJOC J4 reporting.** Deployed operations send reports to the CJOC Joint Support (J4) desk: a weekly logistics report plus equipment, ammunition status and ammunition expenditure reports [S52][H]. Expeditionary operations use operational support plans (SUPLANs), and support planning runs through the Joint Operations Planning Group [S52][H]. **Template use:** the Canadian J4 template produces a weekly logistics report rather than only a daily LOGSTAT.
- **CFJOSG.** The Canadian Forces Joint Operational Support Group, based at CFB Kingston with more than 1,100 personnel, is a "high-readiness formation that generates task-tailored operational and support capabilities". It includes 4 Canadian Forces Movement Control Unit, 3 Canadian Support Unit, 1 Engineer Support Unit, the Joint Signal Regiment and the Postal Unit [S51][H]. It is augmented by overseas operational support hubs. Two hubs (Middle East and Europe) were operational at the time of the 2021 evaluation [S52][H].
- **Systems and visibility.** DRMIS tracks stored supplies "but it cannot forecast theatre requirements". The 2021 evaluation recorded "loss of visibility while materiel is in transit" [S52][H]. The Joint Logistics Modernization Campaign Plan (issue date 1 August 2024) is the first campaign plan under the CDS Operational Sustainment Modernization Strategy [S53][M][S54].

### B7. J4 roles, products and handoffs

| Role | Products it owns | Handoff to J2 | Handoff to J5 | Handoff to J3 |
|---|---|---|---|---|
| J4 director | Consolidated logistics running estimate, concept of support, Annex D (joint) or Annex F (Army), priorities of support recommendation | Receives the threat to lines of communication, ports and stocks | Feasibility of plans and sequels. Long-lead requirements. | Sustainment feasibility per COA and branch. Logistics decision points for the DSM. |
| Logistics plans officer | Logistics estimate, theater logistics overview, supportability analysis per COA | Asks for infrastructure and threat data | Main J4 seat in J5 planning teams | Logistics input to wargaming |
| JLOC chief | LOGSTAT consolidation, LOGCOP, logistics synchronisation matrix, shortfall list | Receives threat warnings for convoys and nodes | None | Feeds the JOC COP and logistics CCIR alerts |
| Supply planner | Supply estimate, days-of-supply forecast, critical items | None | Long-term stockage | Class V and Class III feed to fires and manoeuvre |
| Maintenance planner | Readiness summary, maintenance concept | None | Reconstitution input | Combat power status |
| Mobility planner (deployment, distribution, movement) | Deployment and distribution concept, notional movement tables, JRSOI concept | Threat to ports and routes | Force flow for sequels | Route and movement conflicts |
| Engineer planner | Infrastructure and LOC support concept | Infrastructure intelligence requests | Base development | Mobility and route work coordination |
| OCS planner | Contract support requirements, requirement review packages, host-nation support needs | Contractor vetting needs are flagged to a human | Long-lead contracts | Contractor presence in the area |
| Health services planner | Medical concept of support, patient movement concept | Health threat (medical intelligence) | Medical sustainment for sequels | Casualty evacuation in the scheme of manoeuvre |
| Services and mortuary affairs planner | Field services concept, mortuary affairs concept | None | None | Collection points in the scheme of manoeuvre |
| LOGSTAT analyst | Validated LOGSTATs, forecasts against consumption | None | None | Exceptions to the JOC |

### B8. J4 skills, tools and MCP

| Capability | Built from | Class | Notes |
|---|---|---|---|
| LOGSTAT schema and validator | Structured form per echelon, definitions table, plausibility rules [S46] | Built in | Product-side MCP: `logstat` (submit, validate, consolidate, diff against forecast) |
| Consumption-rate calculator | User-supplied planning factors times force list times days | Built in | Never ship government factor tables. The user enters factors. |
| Inventory and readiness data | CSV or spreadsheet import | Public formats | Partner adapters for GCSS-Army [S46] and DRMIS [S52] stay out of scope. |
| Movement planning and routing | OSRM or GraphHopper road routing on OpenStreetMap, plus Google OR-Tools (Apache 2.0) for vehicle routing [S56][M] | Public, open source | Product-side MCP: `movement` (routes, lift calculator, timeline) |
| TPFDD and deployment systems | JOPES-family systems [S64] | Partner integration, government | Out of scope. Notional movement tables only. |
| Planning factor tools | OPLOG Planner, QLET, Mercury [S46][S47] | Government | Out of scope. Reference by name only. |
| LOGCOP | The shared `cop-map` with logistics layers (nodes, supply points, routes) | Public, open source | Same COP as the J3 team, separate layer |
| Scheduling | `battle-rhythm` MCP shared with the J3 team | Public format (.ics) | Logistics synchronisation events |

### B9. Proposed J4 team (12 members)

| # | Name | Role | Tier | Tools | Instructions in brief |
|---|---|---|---|---|---|
| Lead | `j4-director` | J4 director, team lead | deep | All read. Writes the logistics running estimate, concept of support and Annex D or F. | Keep the force supported to the commander's priorities. Give sustainment feasibility per COA and branch. Propose logistics CCIR. **Never commit resources, sign contracts or approve priorities.** Route decisions to the named human. |
| 1 | `log-plans-officer` | Logistics planner | deep | `orders`, calculator, `movement` | Build the theater logistics overview and logistics estimate from JPP step 1. Test each COA for supportability. Write logistics decision points into the DSM with the J3 team. |
| 2 | `jloc-chief` | JLOC watch | standard | `logstat`, `cop-map` (logistics layer) | Run the logistics current-operations watch. Consolidate LOGSTATs. Keep the LOGCOP and the logistics synchronisation matrix. Escalate shortfalls that match CCIR. |
| 3 | `supply-planner` | Supply | standard | Calculator, `logstat` | Forecast by class of supply and days of supply from user-entered factors. Compare forecast with reported use. Name critical items. |
| 4 | `maintenance-planner` | Maintenance | standard | Readiness import | Summarise readiness, recovery needs and parts constraints. Recommend priorities; never set them. |
| 5 | `mobility-planner` | Deployment, distribution and movement control | deep | `movement`, OR-Tools, `cop-map` | Build the deployment and distribution concept and check notional movement tables for feasibility. Coordinate routes and airspace with the J3 airspace liaison. Never claim real lift or port data. |
| 6 | `engineer-planner` | Engineer (sustainment) | standard | `cop-map` | Plan infrastructure and LOC support. Coordinate with the J3 engineer and the J2 for infrastructure information. |
| 7 | `ocs-planner` | Operational contract support | standard | Requirements tracker | Turn shortfalls into contract support requirements and review packages for the human board [S41]. Never select vendors or commit funds. |
| 8 | `health-services-planner` | Surgeon or J4 medical | deep | Calculator (notional), `cop-map` | Draft the medical concept of support and patient movement concept. Use notional casualty rates entered by the user. Every output carries "surgeon review required". |
| 9 | `services-mortuary-planner` | Logistic services and mortuary affairs | standard | `cop-map` | Plan field services and the mortuary affairs concept (collection points, evacuation, personal effects procedures). No personal data. Use respectful, plain language. |
| 10 | `logstat-analyst` | LOGSTAT validation and forecasting | fast | `logstat` | Validate every report against the definitions and plausibility rules [S46]. Flag errors to the sender. Never "fix" numbers silently. |
| 11 | `release-guard` | Classification and authority guard | fast | Reads every outgoing product | Same rules as the J3 guard. Also block real stock levels, real unit holdings and real contract values. |

**Parallel lanes.** The five functional planners (members 3 to 9) build their parts of the estimate in parallel from the same task list and force list. The plans officer and the lead integrate them. In execution the JLOC chief and the LOGSTAT analyst run continuously, and the planners are called for branches.

### B10. J4 mapping to planning steps and execution

| JPP / MDMP / CFOPP | J4 team activity | Runs in parallel with |
|---|---|---|
| 1 Initiation | Gather the force list, stocks (notional) and infrastructure. Start the theater logistics overview [S1]. | J3 WARNORD 1. J2 JIPOE. |
| 2 Mission analysis / Orientation | Logistics estimate: functional planners each assess their area. Logistics constraints and critical shortfalls go to the J3 and J5. | All functional planners in parallel |
| 3 COA development | Supportability screen per COA | J3 and J5 COA development |
| 4 COA analysis and wargaming | Logistics wargame: consumption per COA and phase, distribution timeline, logistics decision points into the DSM | J3 wargame |
| 5 COA comparison | Score logistics criteria | Other staff teams |
| 6 COA approval | Brief sustainment risk. **The human decides.** | None (a decision gate) |
| 7 Plan or order development / Plan development | Concept of support. Annex D (joint) or Annex F (Army). Canadian SUPLAN inputs [S52]. | J3 Annex C |
| Execution / Plan review | JLOC loop: LOGSTAT in, validate, consolidate, forecast, LOGCOP, exceptions to the JOC, logistics synchronisation meeting. Canadian weekly logistics report to the J4 desk [S52]. | J3 JOC loop |

### B11. What scales by level (J4)

| Aspect | Strategic (Joint Staff J4, CCMD J4; CJOC J4) | Operational (JTF J4 with JLOC; JTFSC) | Tactical (G4 and S4, support operations; Canadian NSE and CSS company) |
|---|---|---|---|
| Focus | Global distribution, industrial base, the strategic estimate [S1] | Theater distribution, JRSOI, the JLOC [S58] | Daily LOGSTAT, resupply, 72-hour forecast [S46] |
| Canadian line of support | Fourth line [S50] | Third line (JTFSC) [S50][S52] | First and second line [S49] |
| Key report | Strategic estimates | Theater logistics summaries. Canadian weekly logistics report [S52]. | LOGSTAT |
| Team size | Full 12 | Full 12 | Merge 6 into 5, and 9 into 3, for about 9 |

### B12. J4 pitfalls

1. **Invented numbers.** Language models produce plausible but false consumption rates and stock levels. Every number must come from a user-entered factor or a calculator call, and the tool output must show the formula. This is the logistics version of Barron's "analysis before action" point [S46].
2. **Leaking real planning factors or stock data.** Government planning factor tools are distributed through controlled channels [S47]. Ship no factor tables. Have the guard block real holdings.
3. **"JLOC" ambiguity.** A JTF J4 JLOC is not the DLA JLOC [S59].
4. **Building a TPFDD.** The unclassified product reviews notional movement tables only. A real TPFDD lives in government systems [S64].
5. **Annex lettering.** Joint uses Annex D, and the Army uses Annex F [S1][S2].
6. **Treating the J4 as a step after the J3.** Doctrine runs support planning alongside force planning [S1]. Start the J4 team at step 1.
7. **Colour bands without definitions.** Fixed amber and red thresholds trigger needless emergency resupply [S46]. Make the bands settings and show the underlying numbers.
8. **Medical and mortuary content.** Use notional rates only, require surgeon review, and handle no personal data.
9. **Canadian reporting differs.** The CJOC J4 desk expects weekly logistics and ammunition reports [S52], not only a US-style daily LOGSTAT.

---

## Part C: Cross-team contract and common guardrails

**Shared artifacts.** All four staff teams (J2, J3, J4, J5) read the same artifacts. Each team writes only its own layer or section:

| Artifact | Writer | Readers |
|---|---|---|
| COP (map plus layers) | J3 JOC (operations layer), J2 (threat layer), J4 JLOC (logistics layer) | All |
| CCIR register | J3 director proposes. A human approves. | All. Watch officers and the JLOC monitor. |
| DST and DSM | J3 future operations, with J2 and J4 entries | All |
| Synchronisation matrix | J3 future operations | All |
| Running estimates | Each team's lead | All |
| RFI tracker | Liaison coordinator | All |
| Battle rhythm calendar | J3 director, with J4 events | All |

**Human decision authority.** The product needs one release state machine for every product: draft, checked by the guard, awaiting decision, then approved or rejected, then released. Only a named human can take a product from awaiting decision to approved. This puts in code what doctrine assigns to commanders and boards [S1][S9][S10]. It also keeps the targeting workflow consistent with the human-judgement principle in DoDD 3000.09 [S67].

**Unclassified by design.**
- Use a fictional or exercise-box geography.
- Use notional units and numbers.
- Paste no restricted doctrine text [S14].
- Connect no government systems [S57][S64].
- Make the guard check everything, because unclassified pieces can become sensitive when combined. DoD policy treats classification by compilation as a distinct case (DoDM 5200.01, Volume 2, section on "classification as a result of compilation") [S66][L].

---

## Gaps and open questions

1. **JP 3-0 (2022) phasing text.** The treatment of the six-phase model could not be confirmed. Phases stay user-defined until it is.
2. **JP 4-0 (2023) primary text.** JLOC wording, the Appendix D mortuary affairs rewrite and the commercial capabilities material were confirmed only from secondary sources. This should be read from the Army War College copy [S34] before the J4 template is finalised.
3. **JP 3-60 phase 6 name.** The 2018 edition renamed it, but the new name was not confirmed.
4. **Current JP 3-12, JP 3-33, JP 4-02 and JP 4-09 editions** were not confirmed.
5. **CJOC J3 and J4 internal organisation.** No public description was found. Do not invent branch names.
6. **CFJP 4-0 primary text** was not located online. The lines of support come from secondary quotes.
7. **The AJP-5 mapping for Canada** is covered in the J5 research and should be cross-linked once that file lands.

---

## Sources

| # | Title | Publisher | Date | URL | Confidence |
|---|---|---|---|---|---|
| S1 | JP 5-0, Joint Planning | Joint Chiefs of Staff | 1 Dec 2020 | https://www.jcs.mil/doctrine/joint-doctrine-pubs/5-0-planning-series | H (public text read) |
| S2 | FM 5-0, Planning and Orders Production | HQ, Department of the Army | Nov 2024 | https://www.dvidshub.net/publication/issues/76328 | H (public text read) |
| S3 | JP 3-0, Joint Campaigns and Operations (listing) | Joint Chiefs of Staff | 18 Jun 2022 | https://www.jcs.mil/Doctrine/Joint-Doctrine-Pubs/3-0-Operations-Series/ | M |
| S4 | Lecture notice: Joint Publication (JP) 3.0 Joint Campaigns and Operations | US Naval War College | 21 Sep 2022 | https://usnwc.edu/_images/portals/0/News-and-Events/Lectures-of-Opportunity/09-21-22-C-135---Joint-Publication-JP-3.0-Joint-Campaigns-and-Operations049b.pdf | H (document read) |
| S5 | Conflict Continuum (editor's note) | The Lightning Press | Undated | https://www.thelightningpress.com/military-conflict-continuum/ | L |
| S6 | ACSC Joint Campaigning syllabus AY23 | Air University | AY2023 | https://www.airuniversity.af.edu/Portals/10/ACSC/curriculum/Syllabus_JC_AY23.pdf | M |
| S7 | Joint Publication 3-0, Joint Operations | NDU Press | 21 Jun 2017 | https://ndupress.ndu.edu/Media/News/Article/1223888/joint-publication-3-0-joint-operations/ | M |
| S8 | Joint Headquarters Organization, Staff Integration, and Battle Rhythm, 3rd ed. | Joint Staff J7 | Sep 2019 | https://www.jcs.mil/Portals/36/Documents/Doctrine/fp/jtf_hq_org_fp.pdf | M |
| S9 | Improving the Battle Rhythm to Operate at the Speed of Relevance | NDU Press, JFQ | 1 Jul 2021 | https://ndupress.ndu.edu/Media/News/News-Article-View/Article/2679728/improving-the-battle-rhythm-to-operate-at-the-speed-of-relevance/ | M |
| S10 | JP 3-60, Joint Targeting (FOIA release) | Joint Chiefs of Staff, via DoD ESD | 28 Sep 2018 | https://www.esd.whs.mil/Portals/54/Documents/FOID/Reading%20Room/Joint_Staff/21-F-0520_JP_3-60_9-28-2018.pdf | M |
| S11 | JP 3-60, Joint Targeting | Joint Chiefs of Staff (public copy) | 31 Jan 2013 | https://www.justsecurity.org/wp-content/uploads/2015/06/Joint_Chiefs-Joint_Targeting_20130131.pdf | M |
| S11b | JP 3-33, Joint Task Force Headquarters | Joint Chiefs of Staff (DoD IG copy) | 31 Jan 2018 | https://www.dodig.mil/Portals/48/JP%203-33%20Joint%20Task%20Force%20Headquarters.pdf | M |
| S12 | Integration and Synchronization of Joint Fires, 4th ed. | Joint Staff J7 | Jul 2018 | https://www.jcs.mil/Portals/36/Documents/Doctrine/fp/int_and_sync_jointfires.pdf | M |
| S13 | JP 3-09, Joint Fire Support | Joint Chiefs of Staff (public copy) | Apr 2019 | https://irp.fas.org/doddir/dod/jp3_09.pdf | M |
| S14 | DOD publishes revised doctrine on information (M. Pomerleau) | DefenseScoop | 7 Oct 2022 | https://defensescoop.com/2022/10/07/dod-publishes-revised-doctrine-on-information | H (article read) |
| S15 | Army releases first doctrinal publication focused on information | DefenseScoop | 27 Nov 2023 | https://defensescoop.com/2023/11/27/army-releases-first-doctrinal-publication-focused-on-information/ | M |
| S16 | New joint force space doctrine clarifies Space Command's offensive, defensive ops | Breaking Defense | Oct 2023 | https://breakingdefense.com/2023/10/exclusive-new-joint-force-space-doctrine-clarifies-space-commands-offensive-defensive-ops/ | M |
| S17 | JP 3-12, Cyberspace Operations (public copy) | Joint Chiefs of Staff | Edition not confirmed | https://irp.fas.org/doddir/dod/jp3_12.pdf | L |
| S18 | US Army TRADOC updates Army capstone doctrine, codifying shift to multidomain operations (R. Stenson) | army.mil | 10 Oct 2022 | https://www.army.mil/article/260943 | H (article read) |
| S19 | Convergence in MDO: A Guide for Junior Officers (CPT T. Myers) | army.mil | 30 Jun 2025 | https://www.army.mil/article/286694/convergence_in_mdo_a_guide_for_junior_officers | M |
| S21 | New and updated field manuals aid commanders, staffs | army.mil | May 2022 | https://www.army.mil/article/256079 | M |
| S22 | Staff Integration for LSCO: Transitioning Integrating Cells from Garrison to Warfighting (MAJ M. Manougian, CALL) | army.mil | 17 Mar 2025 | https://www.army.mil/article/283811/staff_integration_for_large_scale_combat_operations_transitioning_integrating_cells_from_garrison_to_warfighting | H (article read) |
| S23 | The Brigade Battle Captain | Company Leader (themilitaryleader.com) | 17 May 2021 | https://companyleader.themilitaryleader.com/2021/05/17/the-brigade-battle-captain/ | L |
| S24 | Commander's Critical Information Requirements, 4th ed. | Joint Staff J7 | c. 2020 | https://www.jcs.mil/Portals/36/Documents/Doctrine/fp/ccir_fp4th_ed.pdf | M |
| S25 | Assessment and Risk, 3rd ed. | Joint Staff J7 | Mar 2020 | https://www.jcs.mil/Portals/36/Documents/Doctrine/fp/assessment_risk2020.pdf | M |
| S26 | Commander's Handbook for Assessment Planning and Execution, v1.0 | Joint Staff J-7 | 9 Sep 2011 | https://www.jcs.mil/Portals/36/Documents/Doctrine/pams_hands/assessment_hbk.pdf | M |
| S27 | CFJP 3.0, Operations, 1st ed. (catalogue entry) | National Defence, Canada | 2010 | https://publications.gc.ca/site/eng/364825/publication.html | H |
| S27b | RCAF Doctrine: Expeditionary Air Operations (cites CFJP 3-0 number) | RCAF | 2017 | https://canada.ca/content/dam/rcaf-arc/documents/policies-standards/expeditionary-air-operations/b-ga-402-005-fp-001-royal-canadian-air-force-doctrine-expeditionary-air-operations.pdf | M |
| S28 | CFJP 5.0, The Canadian Forces Operational Planning Process, Change 2 (catalogue entry) | National Defence, Canada | Apr 2008 | https://publications.gc.ca/site/eng/9.693032/publication.html | H |
| S29 | Integrate Gender Perspectives through: The Operational Planning Process | National Defence, Canada | Modified 18 Jul 2019 | https://www.canada.ca/en/department-national-defence/corporate/reports-publications/integrating-gender-perspectives-operations/operational-planning-process.html | H |
| S30 | Operational and Tactical Planning in the CAF (LCol G. Desgrosseilliers) | Canadian Army, Line of Sight | 2 Apr 2026 | https://www.canada.ca/en/army/services/line-sight/articles/2026/04/operational-and-tactical-planning-in-the-caf.html | H |
| S31 | Canadian Joint Operations Command (CJOC) | National Defence, Canada | Page date 14 Oct 2026 | https://www.canada.ca/en/department-national-defence/corporate/organizational-structure/canadian-joint-operations-command.html | H |
| S32 | Canadian Joint Response Force Headquarters | National Defence, Canada | Modified 16 Oct 2026 | https://www.canada.ca/en/department-national-defence/services/operations/military-operations/conduct/canadian-joint-response-force-headquarters.html | H |
| S33 | JTF Central service paper (Robb), JCSP 44 | Canadian Forces College | 2017 to 2018 | https://www.cfc.forces.gc.ca/papers/csc/csc44/sp/robb.pdf | L |
| S34 | JP 4-0, Joint Logistics (public copy) | Joint Chiefs of Staff, hosted by the US Army War College | 20 Jul 2023 | https://dml.armywarcollege.edu/wp-content/uploads/2024/01/JP-4-0-Joint-Logistics-2023.pdf | M |
| S36 | Sustainment, 6th ed. | Joint Staff J7 | May 2022 | https://www.jcs.mil/Portals/36/Documents/Doctrine/fp/sustainment_6ed.pdf | M |
| S37 | JP 4-09, Distribution Operations (public copy) | Joint Chiefs of Staff | Edition not confirmed | https://irp.fas.org/doddir/dod/jp4_09.pdf | L |
| S38 | FM 4-0, Combat Service Support, Chapter 7 | GlobalSecurity (Army text) | 2003 edition | https://www.globalsecurity.org/military/library/policy/army/fm/4-0/chap7.htm | L |
| S39 | MCO 3000.18B (cites JP 3-35, 31 Mar 2022); JP 3-35 public copy, 10 Jan 2018 | USMC; Joint Chiefs of Staff | 2022; 2018 | https://www.marines.mil/Portals/1/Publications/MCO%203000.18B.pdf and https://irp.fas.org/doddir/dod/jp3_35.pdf | M |
| S40 | JP 4-10, Operational Contract Support | Joint Chiefs of Staff (public copy) | 4 Mar 2019 | https://irp.fas.org/doddir/dod/jp4_10.pdf | M |
| S41 | Joint operational contract support challenges | army.mil | c. 2017 | https://www.army.mil/article/189269/joint_operational_contract_support_challenges | L |
| S42 | JP 4-02, Joint Health Services (public copy) | Joint Chiefs of Staff, hosted by CDMRP | Edition not confirmed | https://cdmrp.health.mil/pubs/pdf/Joint%20Health%20Services%20Publication%20JP%204-02.pdf | L |
| S43 | JP 4-06, Mortuary Affairs | Joint Chiefs of Staff (public copy) | 12 Oct 2011 | https://irp.fas.org/doddir/dod/jp4_06.pdf | M |
| S44 | ADP 4-0, Sustainment | HQ, Department of the Army (public copy) | Jul 2019 | https://irp.fas.org/doddir/army/adp4_0.pdf | M |
| S45 | Using LOGSTAT reporting to train as we fight | army.mil | c. 2016 | https://www.army.mil/article/173373/using_logstat_reporting_to_train_as_we_fight | M |
| S46 | The Trouble with LOGSTATs (MAJ S. A. Barron) | army.mil | 11 Feb 2025 | https://www.army.mil/article/282967/the_trouble_with_logstats | H (article read) |
| S47 | Operational Logistics Planner for a Leaner, More Capable Expeditionary Army | army.mil | c. 2016 | https://www.army.mil/article/176706 | M |
| S49 | Supporting the Plan with a Plan for Support (Maj C. Hartwick), citing CFJP 4-0 Support, 1st ed. (2016) | Canadian Forces College / Canadian Army Line of Sight | 2021 | https://www.canada.ca/content/dam/dnd-mdn/army/lineofsight/files/articlefiles/en/los-Hartwick_EN.pdf | H (document read) |
| S50 | JCSP 49 service paper (Zedic), quoting CFJP 4-0 on the JTFSC; forum quote of the four lines | Canadian Forces College; milnet.ca | c. 2023 | https://www.cfc.forces.gc.ca/papers/csc/csc49/sp/Zedic.pdf and https://milnet.ca/forums/threads/time-to-invest-in-more-caf-logistics.123822/page-6 | L |
| S51 | Operational Support in Canada | National Defence, Canada | Page date 4 Mar 2026 | https://www.canada.ca/en/department-national-defence/services/operations/military-operations/conduct/support/units.html | H |
| S52 | Evaluation of Sustainment of Operations (ADM(RS), report 1258-3-034) | National Defence, Canada | May 2021 | https://www.canada.ca/en/department-national-defence/corporate/reports-publications/audit-evaluation/eval-sustain-operations.html | H |
| S53 | Joint Logistics Modernization Campaign Plan | National Defence, Canada | Issue date 1 Aug 2024 | https://www.canada.ca/en/department-national-defence/corporate/reports-publications/joint-logistics-modernization-campaign-plan.html | M |
| S54 | CAF Operational Sustainment Modernization Strategy | National Defence, Canada | 2023 | https://www.canada.ca/en/department-national-defence/corporate/reports-publications/canadian-armed-forces-operational-sustainment-modernization-strategy.html | M |
| S55 | milsymbol (repository); Cesium and milsymbol (blog) | Spatial Illusions; Cesium | Repository current; blog 20 Jul 2016 | https://github.com/spatialillusions/milsymbol and https://cesium.com/blog/2016/07/20/cesium-and-milsymbol | M |
| S56 | OR-Tools | Google | Repository current | https://github.com/google/or-tools | M |
| S57 | Army enters into development phase of the joint targeting fires product | army.mil | Mar 2024 | https://www.army.mil/article/274043/army_enters_into_development_phase_of_the_joint_targeting_fires_product | M |
| S58 | What Does a Joint Logistician Do? (summary of JP 4-0 Chapter V) | Blog (Mike K) | 27 Apr 2025 | https://the-other-side-of-history.blogspot.com/2025/04/what-does-joint-logistician-do.html | L |
| S59 | Synchronizing the effort (DLA JLOC) | Defense Logistics Agency | Undated | https://www.dla.mil/About-DLA/News/News-Article-View/Article/824237/synchronizing-the-effort/ | M |
| S63 | The USCENTCOM Train: The Deployment and Distribution Operations Center Turns 10 | NDU Press, JFQ | 30 Sep 2014 | https://ndupress.ndu.edu/Media/News/Article/577557/the-uscentcom-train-the-deployment-and-distribution-operations-center-turns-10/ | M |
| S64 | CJCSM 3122.02 (FOIA release); JOPES overview | Joint Staff | Various | https://www.esd.whs.mil/Portals/54/Documents/FOID/Reading%20Room/Joint_Staff/16-F-1277_CJCSM_3122.02.pdf and https://www.jcs.mil/Portals/36/Documents/Doctrine/Other_Pubs/jopes.pdf | M |
| S66 | DoDM 5200.01, Volume 2, Marking of Classified Information | DoD | Current issuance | https://www.dodig.mil/Portals/48/Documents/Policy/520001_vol2.pdf | L |
| S67 | DoD Directive 3000.09, Autonomy in Weapon Systems | DoD | 25 Jan 2023 | https://www.esd.whs.mil/Portals/54/Documents/DD/issuances/dodd/300009p.PDF | M |
| S68 | Joint Operations Planning instruction (planning horizons) | CAPMED (archived) | c. 2016 | https://webarchive.library.unt.edu/web/20161029233913/http://www.capmed.mil/CapMedServices/CapmedIssuance/Instructions/Joint%20Operations%20Planning.pdf | L |
| S69 | Planning: Preventing Preventable Problems in Military Decision-Making Process | army.mil | c. 2025 | https://www.army.mil/article/284810 | L |

*Source numbers S20, S35, S48, S60 to S62 and S65 are unused. They were dropped during drafting and kept out of the list to avoid citing anything not relied on.*
