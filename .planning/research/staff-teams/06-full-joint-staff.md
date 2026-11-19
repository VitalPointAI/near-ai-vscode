# 06: The full joint staff as a team of teams

> **Edition update (2026-11-18).** This note used JP 5-0 of 1 December 2020. JP 5-0 of 1 July 2025 supersedes it and was read from the owner's reference copy for design note 10. JPP step names are unchanged; US Joint COA tests are now suitable, feasible, acceptable, distinguishable, complete; the fourth planning function is plan evaluation; annex I is Knowledge, Information, and Data Management and annex K is Command, Control, Communications, Computer, and Cybersecurity Systems. See design note 10, sections 2.6, 2.8 and 2.9. Annex O and P titles differ between the 2020 JP 5-0 appendix used here (O Foreign Disclosure, P Host-Nation Support) and the AY26 Campaign Planning Handbook (O Host Nation Support, P Foreign Disclosure); CJCSM 3130.03 settles it. JP 5-0 (2025) removed the joint plan example appendix.

**Researched:** 2026-11-18
**Scope:** the whole staff (every J section and its members), at strategic, operational and tactical level, under US, Canadian and NATO doctrine, and a design for running it as a "team of teams" in the NEAR AI VS Code extension.
**Companion files:** the J2, J5, J3 and J4 teams are researched separately in files 02, 03 and 05 in this folder. This file covers everything else (command group, personal and special staff, J1, J6, J7, J8, J9) and how all sections work as one staff.
**Sources:** public and unclassified only. Every claim carries a source key such as [S1]; the Sources section at the end gives each source's title, date and URL. Claims marked **Mapping** are this file's own synthesis from the cited doctrine, not a statement any one publication makes.
**Overall confidence:** HIGH for US joint and Army structure and annex ownership (read in the doctrine text); MEDIUM for NATO (current AJP text, but the NATO planning directive with annex templates is not public); MEDIUM to LOW for Canadian tactical staff (most Canadian Army staff manuals sit behind a Defence 365 account).

---

## Summary

1. **Every doctrine uses the same skeleton.** A commander, a deputy, a chief of staff (COS) who runs the staff, a senior enlisted adviser (US command senior enlisted leader, CSEL; Canadian chief warrant officer, CWO), personal and special staff, and numbered staff sections J1 to J6, with J7, J8 and J9 added when the mission needs them [S1, II-8 to II-17; S16, B.2 to B.4]. The COS is the integrator: the COS coordinates the sections, supervises estimates, plans and orders, and owns the battle rhythm [S1, II-10 to II-11; S5].
2. **The numbers do not mean the same thing everywhere.** A US joint task force (JTF) J-7 is training and education and its J-8 is resource management and finance [S1, II-17]; the US Joint Staff's J-7 is Joint Force Development and its J-8 is Force Structure, Resources and Assessment [S7; S8]; NATO's J8 is budget and finance, J9 is civil-military cooperation (CIMIC) and J10 is strategic communications [S16, B.4]. Annex letters differ even more: Annex K is communications in US joint plans [S2, A-9], civil affairs in US Army orders [S9, 2-75], and health services in the 2008 Canadian list [S10, 5E1-2]. A template must pick one **doctrine profile** per run and never mix them.
3. **The staff works as one through cross-functional venues.** Boards, bureaus, centres, cells and working groups (B2C2WG) and operational planning teams (OPTs) cut across the J-code "stovepipes"; each section keeps a running estimate that feeds them; the COS disciplines a battle rhythm that ends in commander decisions [S4; S1, IV battle rhythm; S9, 2-12, 4-1].
4. **Command authority stays with the commander.** Critical information requirements (CCIRs) "belong exclusively to the commander" [S1, IV-2]; the staff recommends and then carries out the decision even when it differs from its advice [S9, 2-32]. In the extension, the commander is always the person, never an agent.
5. **The extension cannot nest teams today.** A run works with exactly one team, of at most 12 members; members can be given the `Agent` tool, but they can only start members of that same team or Open-GSD agents (code citations in section 5.1). A full staff (command group, up to nine J sections and a dozen special staff) needs either a 12-member staff team of section leads (a workaround that works now) or a small extension change: a member line `team: <slug>` that makes that member the lead of another team (proposed in section 5.3).
6. **Scaling is mostly subtraction.** At battalion the COS becomes an executive officer, there is no resource manager, no dedicated plans officer and no knowledge management officer; at division and above the G-5, knowledge management officer and operations research analyst appear [S9, 2-36, 2-41, 2-65, 2-103, 2-108]. J7, J8 and J9 are optional even at JTF level [S1, II-17].
7. **Doctrine is moving.** The current JP 3-33 (June 2022, "Joint Force Headquarters") is behind a CAC login; this file uses the public 31 January 2018 edition [S1; S3]. Canada is replacing its operational planning process with NATO's AJP-5 from 2026/2027 and adopting NATO APP-28 for tactical planning by August 2026 [S11], so Canadian templates should follow NATO formats.

---

## 1. The joint staff structure

### 1.1 United States

**Strategic level: the Joint Staff.** The Joint Staff in Washington supports the Chairman of the Joint Chiefs of Staff through directorates J-1 to J-8: J-1 Manpower and Personnel, J-2 Intelligence, J-3 Operations, J-4 Logistics, J-5 Strategy, Plans and Policy, J-6 Command, Control, Communications and Computers/Cyber, J-7 Joint Force Development, and J-8 Force Structure, Resources and Assessment [S6]. Three of these differ from the field-headquarters meaning of the same number:

- **J-6** advances "C4/Cyber across all domains" for the joint force and is the Joint Staff's chief information officer [S12].
- **J-7** is responsible for the six functions of joint force development: doctrine, education, concept development and experimentation, training, exercises and lessons learned [S7].
- **J-8** evaluates and develops force structure requirements, assesses whether the joint force can execute the defense strategy, reviews Service programs, and runs war games and net assessments [S8].

There is no J-9 on the Joint Staff [S6]. Confidence: MEDIUM (official web pages, read through search results because jcs.mil refused direct fetches).

**Operational level: combatant command (CCMD) and JTF headquarters.** JP 3-33 says the traditional J-code organization "continues to be the preferred basic staff structure for joint HQ": J-1, J-2, J-3, J-4, J-5 and J-6, with additional directorates "for training and education, resource management, and civil-military operations" when the mission needs them [S1, II-12]. Its Figure II-2 marks J-7 (Training), J-8 (Resources) and J-9 (CMO) as "optional directorates established at JFC's discretion" [S1, II-14]. The Joint Staff J7's training division reports that the traditional structure (commander, deputies, CSEL, COS, personal and special staffs, J-staff) "is most effective" for both CCMD and JTF headquarters [S4, section 2.0]. Confidence: HIGH.

**Tactical level: Army G and S staff.** FM 6-0 (May 2022) gives every Army staff a COS (division and above) or executive officer (XO, brigade and battalion) and three groups: coordinating, special and personal staff [S9, 2-41]. The coordinating staff are G-1/S-1 Personnel, G-2/S-2 Intelligence, G-3/S-3 Operations, G-4/S-4 Logistics, G-5 Plans, G-6/S-6 Signal, G-8 Financial Management and G-9/S-9 Civil Affairs Operations [S9, 2-47 to 2-75]. Confidence: HIGH.

### 1.2 Canada

**Strategic level: the Strategic Joint Staff (SJS).** The SJS "provides military analysis and advice to the Chief of the Defence Staff" so the CDS can lead the CAF strategically, through five divisions: Operations, Support, Plans, Strategic Initiatives and Coordination [S13]. It is organized by division, not by J-number. Confidence: MEDIUM.

**Operational level: Canadian Joint Operations Command (CJOC).** CJOC "plans, directs, and integrates all-domain military operations in Canada, across North America, and around the world", except those run only by Canadian Special Operations Forces Command or NORAD. It commands Joint Task Force North, the Canadian Joint Response Force Headquarters, CAF task forces at home and abroad, and the Canadian Forces Joint Operational Support Group, supported by air, maritime, space and cyber component commands [S14]. The public page names the commander and a chief warrant officer but does not publish the J-staff chart [S14]. Confidence: MEDIUM.

**Canadian joint staff branches in planning.** CFJP 5.0 assumes J-branches: "it is more convenient to have each branch (for example J1, J2, J3, J4, J5, and J6) conduct their respective staff analyses", followed by a coordination meeting; COAs are produced "under the direction of the COS/J5 Plans" [S10, chapter 4, staff analysis]. Confidence: HIGH for 2008 doctrine; the process is being replaced (see 1.2 last paragraph).

**The command team.** Canadian doctrine pairs the commander with the senior non-commissioned member: the command team "is widely accepted as the combination of a Commander and CPO1 or CWO", and the construct applies "predominantly at the tactical or operational level"; at strategic level it becomes a "Senior Leadership Team" [S15, 2.4]. An RCAF Journal article describes the CWO as "one of the closest advisers to the commander" and not a commander: decisions on the use of force rest with officers [S17]. Confidence: MEDIUM.

**Tactical level: Canadian Army G staff.** Public Canadian sources confirm brigade headquarters G staff branches, for example a brigade headquarters' "integral G9 team" and planning "in the G5 [planning] shop" during Exercise Unified Resolve [S18]. The battle group and unit staff manuals (for example B-GL-321-005, Battle Group in Operations) are not public; Canadian Army doctrine is published in the Canadian Army Doctrine Library "via Defence 365", which needs a DND account [S19]. Confidence: LOW for battle group detail (gap).

**Operational research.** CJOC has an operational research and analysis (OR&A) team from DRDC's Centre for Operational Research and Analysis; since 2014 its work program has been "determined via an annual call letter process" to CJOC Headquarters and its subordinate organizations [S20]. Confidence: MEDIUM.

**Planning doctrine in transition.** The Canadian Forces College plans to teach NATO's AJP-5 as "the new CAF joint planning process at the operational level" from the 2026/2027 academic year, and the Canadian Army will adopt APP-28 "by August 2026", replacing the Canadian Army Operational Planning Process [S11]. Confidence: MEDIUM (Army journal article, 2 April 2026).

### 1.3 NATO

AJP-3 Edition D (August 2025) is the current public statement of a NATO JTF headquarters [S16, Annex B]:

- **Principal advisers:** "The commander usually has three principal advisors: the chief of staff (COS), the political advisor and the legal advisor" [S16, B.2].
- **Functional advisers and deputies:** gender, cultural, strategic communications, public affairs, military engineering, provost marshal and medical advisers, often grouped "in a special advisory group"; "usually a deputy commander and deputy/assistant COS are appointed" [S16, B.3].
- **Staff directorates:** "Typically, the staff directorates are: personnel and administration (J1), intelligence (J2), operations (J3), logistics (J4), plans (J5), and communications systems (J6). Staffs likely have additional staff directorates, e.g. training (J7), budget and finance (J8), civil-military cooperation (J9), strategic communications (J10), medical (JMED) and military engineering (JMILENG). In some headquarters J3 and J5 may be combined" [S16, B.4].
- **Numbering is the commander's choice:** "the numbering may vary from commander to commander" [S16, B.4].

Confidence: HIGH (the gov.uk copy marks UK national additions in boxes; this file cites only the NATO text unless it says "UK national element").

### 1.4 The command group

| Role | What doctrine says it does | US | Canada | NATO |
|---|---|---|---|---|
| Commander | Responsible to the establishing authority; supervises all planning; sets C2 relationships, policies and succession; keeps higher informed [S1, II-8 to II-10]. Owns CCIRs [S1, IV-2]. | Commander, JTF (CJTF) | Commander (with the CWO as the "command team") [S15] | Commander [S16, B.1] |
| Deputy commander | Principal assistant; may also serve as COS; represents the commander; assumes command if needed; chairs designated boards; supervises designated planning and units [S1, II-10]. Usually from a different Service [S1, II-10]. | DCJTF | Deputy commander (Mapping: same role) | Deputy commander [S16, B.3] |
| Chief of staff | "Key JTF staff integrator and synchronizer": directs the directorates, supervises staff estimates, plans and orders, manages the battle rhythm and appoints a battle rhythm manager, sets up liaison, supervises staff training and the joint manning document [S1, II-10 to II-11]. Delegates "ruthlessly"; may use a deputy COS for day-to-day staff work [S5, 2.0]. Produces and disseminates the commander's terms of reference [S4, 2.0]. | COS (XO at Army brigade and battalion [S9, 2-41]) | COS; "COS/J5 Plans" directs COA work [S10] | COS: "coordinates the work of the staff divisions by giving clear direction and setting priorities" [S16, B.2] |
| Senior enlisted adviser | "Key advisor to the commander", primary adviser on enlisted personnel, monitors discipline, morale and readiness, may be command spokesperson and liaison to multinational contingents [S1, II-11 to II-12]. Army CSM "transmits the commander's intent across the formation" [S9, 1-31]. | CSEL; Army CSM | CPO1/CWO, part of the command team, adviser not commander [S15; S17] | Not described in AJP-3 Annex B (gap) |

### 1.5 Personal and special staff

JP 3-33 lists personal and special staff who handle "special matters over which the CJTF wishes to exercise close, personal control": public affairs officer, staff judge advocate, chaplain, surgeon, inspector general, provost marshal, comptroller, headquarters commandant, historian, safety officer and policy adviser, "as directed" [S1, II-17]. FM 6-0 adds that law or regulation requires the inspector general, staff judge advocate and chaplain to be personal staff, with direct access to the commander [S9, 2-129].

| Role | Purpose | Plan product it owns | Source |
|---|---|---|---|
| Legal (US SJA; NATO and CAF legal adviser, LEGAD) | Principal legal adviser; international law, mandates, rules of engagement (ROE) | US joint: Appendix 2 (Legal) to Annex E, ROE appendix to Annex C, help with Annex W [S1, XIV]. Army: Appendix 11 (ROE) to Annex C, Tab C (Legal Support) to Annex F [S9, 2-144]. CFJP 5.0: Annex AA (Legal) and Annex E (ROE) [S10, 5E1] | [S1; S9; S16, B.2] |
| Political adviser (POLAD) | Adviser on foreign policy, political issues and relations with international and non-governmental organizations [S16, B.2]. Does "not have the responsibility or capacity to represent the broader DOS portfolio" [S1, XIII-4] | Input to estimates and the J9 forum (Mapping) | [S1; S16] |
| Public affairs officer (PAO) | Advises the commander, with direct access "in an independent advisory role" [S16, B.3] | US joint: Annex F [S1, XIV-1 to XIV-4]. Army: Annex J [S9, 2-140]. CFJP 5.0: Annex X [S10, 5E1-3] | [S1; S9; S10] |
| Chaplain | Religious support; required personal staff [S9, 2-129] | US joint: religious support parts of plans and annexes [S1, XIV]. Army: religious support tab to Appendix 2, Annex F [S9] | [S1; S9] |
| Surgeon / medical adviser | Principal adviser on health service support and force health protection [S1, XIV] | US joint: Annex Q [S1, XIV]. Army: Appendix 9 to Annex E, Appendix 3 to Annex F [S9, 2-146]. NATO: medical Annex QQ [S16, B.19] | [S1; S9; S16] |
| Inspector general (IG) | Required personal staff [S9, 2-129] | Army: Annex U [S9, 2-135] | [S9] |
| Protocol | Army aide-de-camp duties include "coordinating protocol activities" [S9, 2-130]; JP 3-33 lists a headquarters commandant for the headquarters itself [S1, II-17] | None | [S1; S9] |
| Knowledge and information manager | US joint: the COS appoints an information management officer (IMO) who writes the information management plan and chairs the joint information management board [S1, IV]. Army: knowledge management officer (KMO) at division and above, "coordinated by the COS or XO", with coordinators at brigade and battalion [S9, 2-103] | US joint: Annex I (Knowledge and Information Management) exists in the plan format [S2, A-9]. Army: helps the G-3 with Annex R (Reports) and Annex Z (Distribution); no annex of its own [S9, 2-53, 2-103] | [S1; S2; S9] |
| Operations research and analysis (US ORSA; CAF OR&A) | "Principal advisor to the COS and the commander on analytical techniques", often action officer of the assessment working group, at division and higher [S9, 2-107 to 2-108]. CJOC has a DRDC OR&A team [S20] | Army: helps the G-5 write Annex M (Assessment) [S9, 2-108] | [S9; S20] |
| Comptroller | Financial adviser when no J-8 is set up [S1, XII-1] | See J8 | [S1] |
| Historian, safety officer, provost marshal | Listed personal and special staff [S1, II-17]; Army safety officer writes the risk management appendix [S9, 2-142] | Army: Appendix 2 (Risk Management) to Annex E | [S1; S9] |
| Gender, cultural and StratCom advisers | NATO functional advisers [S16, B.3] | NATO: StratCom handled by J10 [S16, B.18] | [S16] |

### 1.6 How they relate

```
                         COMMANDER (decides; owns CCIR, intent, COA choice)
                              |
      +-----------------------+-------------------------+
      |                       |                         |
 Deputy commander     Senior enlisted adviser    Personal staff (direct access:
 (stands in, chairs   (CSEL / CSM / CWO;          legal, IG, chaplain, PAO, surgeon,
  some boards)         adviser, not a commander)  POLAD; NATO principal advisers =
                                                  COS + POLAD + LEGAD)
                              |
                       CHIEF OF STAFF (integrates, synchronizes, owns battle rhythm)
                              |
   +-----+-----+-----+-----+-----+-----+-----+-----+-----+   special staff (KM/IM, ORSA,
   J1    J2    J3    J4    J5    J6    J7*   J8*   J9*      historian, safety, PM, comptroller)
   (* optional in US JTF; NATO adds J10 StratCom, JMED, JMILENG)

 Cross-cutting: boards, centres (JOC), working groups, OPT/JPG drawn from every box above.
```

Sources for the diagram: [S1, II-8 to II-17; S4, 2.0 to 3.0; S9, 2-41 to 2-44, 2-129; S16, B.2 to B.4]. The vertical lines are accountability: directorate principals "remain accountable through the COS to the Commander" [S1, II-12]. The horizontal venues are where the work is integrated [S4, 3.0].

---

## 2. The sections not covered elsewhere

The J2, J3, J4 and J5 teams are in files 02, 03 and 05. Below are J1, J6, J7, J8 and J9. "Annexes" gives the owning annex in each doctrine profile; owners marked **Mapping** are assigned by function, not by an explicit doctrinal sentence.

### 2.1 J1 Personnel (Manpower and Personnel)

| Item | Content |
|---|---|
| Role | "Principal staff assistant to the CJTF on manpower management, personnel management, personnel readiness, and personnel services for the total force (military, DOD civilian, and DOD contractor)"; maintains the joint manning document (JMD) [S1, V-1]. NATO J1: personnel policies, entitlements, morale, welfare, recreation, postal services, safety, prisoner-of-war administration and casualty reporting, coordinated with national contingents [S16, B.7]. |
| Responsibilities | Personnel management, manpower, augmentation, accountability and strength reporting, rotation policy, pay and entitlements policy, postal, morale welfare and recreation, casualty reporting, evaluations, awards, civilian personnel [S1, V-1]. Co-chairs the JMD working group with the J-3 [S1, V-1]. |
| Owned products | The JTF personnel estimate during joint planning [S1, V-1]; the JMD [S1, V-1]; personnel accountability policy [S1, V-1]. |
| Annexes | US joint: Annex E (Personnel) [S2, A-8]. US Army: Tabs A (Human Resources Support) and E (Band Operations) to Appendix 2 (Personnel Services Support) of Annex F (Sustainment) [S9, 2-48]. CFJP 5.0: "Personnel Services" appendix to Annex R (Logistics) [S10, 5E1-2] and, Mapping, Annex Y (Casualty Estimation) with the medical staff. |
| Inputs | Task organization and force list (J3/J5), casualty estimates (surgeon; NATO JOPG casualty estimation is "an interdisciplinary task" [S22, 2.22]), every section's billet requests (J7, J8 and J9 each send their personnel requirements "to the JTF J-1" [S1, XI-1, XII-1, XIII-2]). |
| Outputs and handoffs | Strength and readiness picture to J3 and the commander (Mapping: a typical friendly force information requirement); entitlement policy coordinated with J-8 [S1, XII-3]; legal, chaplain and surgeon coordination [S9, 2-48]. |

### 2.2 J6 Communications systems, C4 and cyber

| Item | Content |
|---|---|
| Role | Provides "a protected, interoperable joint communications system" for command and control, including architecture and plans; "also manages activities described in JP 3-12, Cyberspace Operations" [S1, II-16]. NATO J6: communication and information systems (CIS) support and interoperable procedures; usually sets up a joint command, control and communication support centre [S16, B.14]. |
| Responsibilities | Publish communications plans, annexes and operating instructions and coordinate subordinate plans [S1, X]; establish a joint network operations control centre (JNCC) [S1, X]; review component communications plans [S1, X]. "Communications planners must be integral members of the JPG" [S1, II-16]. |
| Owned products | Communications estimate and architecture; the JNCC situational picture; spectrum and network plans (Mapping from [S1, X; S9, 2-68]). |
| Annexes | US joint: Annex K (C4 Systems) and Appendix 16 (Cyberspace Operations) to Annex C [S1, X; S2, A-9]. US Army: Annex H (Signal) [S9, 2-68]; cyber electromagnetic appendix to Annex C is the CEWO's [S9]. CFJP 5.0: Annex Q (Communications and Information Systems) [S10, 5E1-2]. |
| Inputs | Task organization and C2 relationships (J3/J5), the information management plan (IMO/KMO), host-nation and coalition network constraints (J9, J2 for foreign disclosure, Mapping). |
| Outputs and handoffs | Feasibility of each COA's communications [S9, 2-68: "determining the supportability and feasibility of the signal plans"]; network status to the JOC (Mapping); information sharing arrangements with mission partners [S1, X]. In NATO, CIS activities critical to information operations go through the information activities coordination board [S16, B.14]. |

### 2.3 J7 Joint force development, training and exercises

| Item | Content |
|---|---|
| Role | US JTF: optional; "assists the commander in planning and executing the joint training and education programs for the staff and theater-assigned forces"; "most likely formed for a standing JTF" [S1, II-17; XI-1]. NATO J7: manages in-theatre training during work-up, trains augmentees, hands lessons to the relief force; may not be needed for short operations [S16, B.15]. US Joint Staff J-7 at strategic level: doctrine, education, concepts and experimentation, training, exercises and lessons learned [S7]. |
| Responsibilities | Prepare training guidance for the commander's approval; identify training requirements from the mission; allocate training resources; maintain unit readiness status; include continuity-of-operations training under degraded conditions [S1, XI-2]. Run the lessons learned process with a lesson manager [S1, XI-3 to XI-4]. |
| Owned products | Training guidance, staff orientation and reception training, mission rehearsal and exercise plans, lessons learned reports [S1, XI-2 to XI-4]. |
| Annexes | US joint: no dedicated annex in the JP 5-0 list [S2, A-8 to A-9] (Mapping: training content goes into Annex C or a staff directive). CFJP 5.0: Annex BB (Training and Exercises) [S10, 5E1-3]. |
| Inputs | Mission and tasks (J3/J5), personnel arrivals (J1), lessons from operations (all sections). |
| Outputs and handoffs | Billet requests to J1 and capability requests to the J-3 request-for-forces manager [S1, XI-1]; readiness status to J3 (Mapping); lessons to the next rotation [S16, B.15]. |

### 2.4 J8 Force structure, resources and assessment (and finance)

| Item | Content |
|---|---|
| Role | US JTF: optional "Resource Management and Financial Support Directorate" that helps "in determining the command's resource requirements, identifying sources of funding, establishing internal management controls, and conducting operation assessment" [S1, II-17]. The COS and commander decide whether it has assessment duties [S1, XII-1]. NATO J8: under a JOA financial controller, prepares and executes the common-funded mission budget, "first in and last out" [S16, B.16]. US Joint Staff J-8 at strategic level: force structure, programs and net assessment [S8]. Army G-8: financial management, chairs funding boards at higher echelons [S9, 2-69]. |
| Responsibilities | Principal financial management adviser; single point of contact; cost capture and reporting; internal controls; a requirements review board process; entitlement policy with J-1; logistics and contracting coordination with J-4 [S1, XII-2 to XII-3]. |
| Owned products | Cost estimates and funding plan; budget execution reports; requirements board outputs (Mapping from [S1, XII-2 to XII-3]); where assigned, the operation assessment (Mapping: shared with J5 and ORSA). |
| Annexes | US joint: "Prepare paragraph 4 (Administration and Logistics) of the base plan for annex W (Operational Contract Support)" [S1, XII-2]; Annex N (Assessments) where the J-8 owns assessment (Mapping). US Army: Appendix 4 (Financial Management) and Tab B of Appendix 2 to Annex F [S9, 2-70]. CFJP 5.0: Annex FF (Financial Support) [S10, 5E1-3]. |
| Inputs | Concept of support (J4), contracts (J4), personnel numbers (J1), COA resource needs (J5), mission partner support requests (J9). |
| Outputs and handoffs | Funding and fiscal-law constraints to every COA; boards for acquisition requirements; with J-1 on pay; with J-4 on contracting [S1, XII-2 to XII-3]. |

### 2.5 J9 Civil-military cooperation and interagency

| Item | Content |
|---|---|
| Role | US JTF: optional "Civil-Military Operations Directorate/Interagency Operations Directorate"; "a hub from which the CJTF can facilitate unified action"; "the initial and primary POC for interorganizational coordination and the single, physical location for representatives/LNOs" [S1, XIII-1]. Other placements: a cell in J-3 or J-5, or a joint interagency coordination group [S1, XIII-3]. NATO J9: "supports the commander in achieving objectives through synchronizing military and non-military activities", leads civil factor integration, and "enables and facilitates civil-military interaction" [S16, B.17]; the assistant chief of staff J9 is "the coordinating authority over CIMIC assets across all components" [S21, chapter 3]. Army G-9/S-9: required from brigade combat team to theatre army [S9, 2-73]. |
| Responsibilities | Bring interorganizational views into OPTs, assessments, commander briefs and the operations centre; keep a close link with the POLAD; run an interorganizational coordination working group; manage liaison officers and key leader engagements; maintain links to higher and component J-9s [S1, XIII-4 to XIII-5]. Work with the SJA on legal obligations [S1, XIII-4]. NATO CIMIC staff: identify and assess civil factors, assess the impact of military action on non-military audiences, assess requests for military support from non-military actors, set up information sharing [S21, chapter 4]. |
| Owned products | The CIMIC estimate, "a continuous process" and repository for civil factors [S21, chapter 4]; civil factor assessments using PMESII and ASCOPE [S21, chapter 4]; the stakeholder map and coordination mechanisms [S1, XIII-2]. |
| Annexes | US joint: Annex G (Civil-Military Operations) and Annex V (Interagency-Interorganizational Coordination) [S2, A-7 to A-9]. US Army: Annex K (Civil Affairs Operations), and Annex V with the G-3 [S9, 2-75]. NATO: "the CIMIC concept of operation (typically Annex W to plans)" [S21, chapter 4]. CFJP 5.0: Annex W (Civil-Military Co-operation) [S10, 5E1-3]. |
| Inputs | Intelligence on the environment (J2: "cooperation between J2 and J9 is crucial" for situational awareness [S23]); legal limits (LEGAD); diplomatic context (POLAD); host-nation support needs (J4). |
| Outputs and handoffs | Civil considerations into J3 current operations and J5 long-term, branch, sequel and transition plans; civil telecom use with J6; training with civilian actors with J7; locally employed civilians and linguists with J1 [S23]. |

---

## 3. How the staff works as one

### 3.1 Battle rhythm

- **Definition.** "A battle rhythm is a cycle of command and staff activities intended to synchronize current and future operations"; "typically, the COS manages the JTF HQ's battle rhythm" [S1, IV battle rhythm]. Army: the COS or XO oversees it and "ensures activities are logically sequenced so that the output of one activity informs another activity's inputs" [S9, 4-1].
- **Design it around decisions.** First arrange B2C2WGs "around the commander's decision requirements with decision venues (boards) as culminating events"; map a "critical path" from an OPT or working group "all the way to a decision board and back" [S4, 4.0].
- **Three event horizons.** Current operations, future operations and future plans; OPT membership is set by "the J5 for future plans, J35 for future operations, and J33 for current operations" [S4, 3.0].
- **Discipline.** Each event needs a charter (the "7-minute drill") with task, purpose, inputs and outputs; an event "that has no output and only provides generic situational awareness ... may not belong on the battle rhythm" [S4, 4.0]. Protect "white space" with no meetings [S4, 4.0].
- **Scarce experts.** "High-demand/low-density" experts such as the POLAD and SJA "may not be able to support multiple simultaneous events" [S4, 4.0].

### 3.2 B2C2WG and centres

The J7 paper describes cross-functional "Boards, Bureaus, Centers, Cells, and Working Groups [B2C2WGs] and OPTs" overlaid on the vertical J-code structure to stop knowledge being "stovepiped" [S4, 1.0 and 3.0].

| Venue | Doctrinal meaning | Source |
|---|---|---|
| Board | "A designated group ... appointed by the commander ... that meets with the purpose of providing guidance or decision"; command boards chaired by the commander, functional boards by a delegated leader [S4, 3.0]. Army: a board has "delegated decision authority"; that is what separates it from a working group [S9, 4-48]. | [S4; S9] |
| Working group | "A more permanent cross-functional organization" for enduring problems across all three horizons; members inform and are informed by their parent directorate [S4, 3.0]. A large HQ may have "100+" on a menu but run "30-40" at once [S4, 3.0]. | [S4] |
| OPT / JPG | Solves "a single problem ... on a single event horizon"; usually dissolves when done [S4, 3.0]. | [S4] |
| Centre | "Permanent, cross-functional staff integrating organizations"; the joint operations centre (JOC) is the most familiar, usually looking 72 to 96 hours ahead [S4, 3.0]. | [S4] |
| Plans management board | A best practice that "directs, prioritizes, coordinates, and synchronizes activities between and among staff directorates" [S4, 3.0]. | [S4] |
| Information management board | Chaired by the IMO; oversees information flow across the JTF [S1, IV]. | [S1] |

### 3.3 The joint planning group (JPG) or OPT as a cross-functional team

- US joint: planners "should establish a team of experts", "often called JPGs, OPTs, operational planning groups, or cross-functional teams", "normally led by either the plans directorate (J-5) or the operations directorate (J-3)" [S2, II-16]. The J-5's JPG "should include representation from all JTF principal and special staff sections, components and other interagency partners" [S1, II-16]. Logistics and communications planners must be "integral members of the JPG" [S1, II-16].
- NATO: the joint operations planning group (JOPG) studies higher directives and does interdisciplinary tasks such as casualty estimation [S22, 2.22 and chapter 3]. A UK national element in AJP-3 calls the JPG "the principal working-level planning group", under J5 direction, with J2 representation "fundamental" [S16, UK B.4] (UK, not NATO, text).
- Canada (2008): each branch does its own staff analysis, then a coordination meeting; the COS/J5 Plans directs COA development and the COS/J3 Plans coordinates it [S10, chapter 4].

### 3.4 Running estimates by every section

- "A staff estimate is an evaluation of how factors in a staff section's functional area support and impact the mission"; estimates start in mission analysis, mature during COA work, "are continually updated", and "can be expanded to the relevant annex or appendix during plan development" [S2, III-26 to III-27].
- Each directorate reviews the situation from its own view, examines the factors and assumptions it is responsible for, analyzes each COA, and "concludes whether the mission can be supported" [S2, C-2].
- "Running estimates always include recommendations for anticipated decisions" [S9, 2-13]; "failure to maintain running estimates may lead to errors or omissions" [S9, 2-13].
- Section directors must share "a common staff estimate" with OPTs and WGs, because one expert cannot attend every meeting [S4, 3.0].

**Mapping for the extension:** each section team's first product is a running estimate file with fixed headings (mission and situation from the section's view; facts; assumptions; constraints; risks; COA supportability; recommendations; proposed PIR or FFIR). This is the "contract" that lets sections work in parallel and the COS integrate.

### 3.5 Orders production: annex ownership

Doctrine assigns paragraphs and annexes to sections, which is what makes parallel drafting possible: each section owns separate files.

**US joint (JP 5-0, 1 December 2020, Appendix A annex list [S2, A-8 to A-9]).**

| Annex | Title | Owner | Basis |
|---|---|---|---|
| A | Task Organization | J-3 with J-5 | Mapping (Army G-3/G-5 analogue [S9, 2-53, 2-65]) |
| B | Intelligence | J-2 | Mapping (Army G-2 [S9, 2-50]) |
| C | Operations | J-3 (SJA writes the ROE appendix; J-6 with J-3 the cyberspace appendix 16) | [S1, X, XIV]; Mapping for J-3 |
| D | Logistics | J-4 | Mapping |
| E | Personnel | J-1 (SJA writes Appendix 2, Legal) | [S1, V, XIV] |
| F | Public Affairs | PAO | [S1, XIV] |
| G | Civil-Military Operations | J-9 (or CMO cell in J-3) | [S1, XIII]; Mapping |
| H | METOC Operations | J-3 METOC staff | Mapping |
| I | Knowledge and Information Management | COS through the IMO/KMO | Mapping from [S1, IV] |
| J | Command Relationships | J-3 / J-5 | Mapping |
| K | C4 Systems | J-6 | [S1, X] |
| L | Environmental Considerations | J-4 (engineer) | Mapping |
| M | Not currently used | none | [S2] |
| N | Assessments | J-5 or J-8 (with ORSA) | Mapping from [S1, II-17; S9, 2-108] |
| O | Foreign Disclosure | J-2 | Mapping |
| P | Host-Nation Support | J-4 | Mapping (Army G-4 [S9, 2-59]) |
| Q | Health Services | Surgeon | [S1, XIV] |
| R | Reports | J-3 with IMO/KMO | Mapping (Army [S9, 2-53]) |
| S | Special Technical Operations | J-3 | Mapping |
| T | CBRN Response | J-3 | Mapping |
| U | Notional Counterproliferation Decision Guide | J-3 / J-5 | Mapping |
| V | Interagency-Interorganizational Coordination | J-9 (or J-5) | [S1, XIII; S2, I-24]; Mapping |
| W | Operational Contract Support | J-4, with J-8 writing paragraph 4 input | [S1, XII-2]; Mapping for J-4 |
| X | Execution Checklist | J-3 | Mapping |
| Y | Commander's Communication Strategy | PAO with communication synchronization staff | Mapping |
| Z | Distribution | COS / J-3 | Mapping |

Base order: paragraph 3 coordinating instructions carry the CCIRs, "expanded upon in annex B, annex C, annex G, annex I, annex V, and annex R" [S2, A-7]; paragraph 4 covers sustainment, logistics, personnel and refers to E, F, G, H, L, B (geospatial) and Q; paragraph 5 covers command relationships and C4 (Annex K) [S2, A-7 to A-8].

**US Army (FM 6-0, May 2022; owners stated in the text [S9, chapter 2]).**

| Annex | Owner |
|---|---|
| A Task Organization, C Operations | G-3/S-3, with the G-5 at division and above [S9, 2-53, 2-65] |
| B Intelligence | G-2/S-2 [S9, 2-50] |
| D Fires | Chief of fires / fire support coordinator [S9] |
| E Protection | Chief of protection [S9] |
| F Sustainment | G-4/S-4 for the annex and base order paragraph 4; G-1 tabs, G-8 Appendix 4, surgeon Appendix 3, SJA Tab C, chaplain religious support tab [S9, 2-48, 2-59, 2-70, 2-144, 2-146] |
| G Engineer | Engineer officer [S9] |
| H Signal | G-6 [S9, 2-68] |
| J Public Affairs | PAO [S9, 2-140] |
| K Civil Affairs Operations | G-9/S-9 [S9, 2-75] |
| L Information Collection | G-3/S-3 with the G-2/S-2 [S9, 2-53] |
| M Assessment | G-3 and G-5, with ORSA help [S9, 2-53, 2-108] |
| N Space Operations | Space operations officer [S9, 2-120] |
| P Host-Nation Support, W Operational Contract Support | G-4/S-4 [S9, 2-59] |
| R Reports, Z Distribution | G-3/S-3 with the KMO [S9, 2-53] |
| U Inspector General | IG [S9, 2-135] |
| V Interorganization-Interagency Coordination | G-9 with the G-3 [S9, 2-53, 2-75] |

**Canada (CFJP 5.0, April 2008, standard annex lettering [S10, Appendix 1 to Annex E of chapter 5]).** CFJP 5.0 lists the letters but not owners; owners below are Mapping.

| Annex | Title | Owner (Mapping) |
|---|---|---|
| A | Conduct of Operations | J3 |
| B | Task Organization and Command Relationships | J3 / J5 |
| C | Forces, Missions/Tasks | J3 / J5 |
| D | Intelligence | J2 |
| E | Rules of Engagement | J3 with legal adviser |
| F, G, H, I | Maritime, Land, Air, Amphibious Operations | J3 with component staffs |
| J | Force Protection | J3 |
| K | Health Services Support | Surgeon / J4 Med |
| L, O, P | Psychological Operations, Information Operations, Electronic Warfare | J3 information operations (J2, J6 support) |
| M, N, U, V | Arms Control, Nuclear Operations, NBC Environment, Combat Survival | J3 |
| Q | Communications and Information Systems | J6 |
| R | Logistics (appendix: Personnel Services) | J4 (J1 owns the personnel appendix) |
| S | Movements | J4 |
| T | Environmental Support (geographic, meteorological, oceanographic) | J2 / J3 |
| W | Civil-Military Co-operation | J9 |
| X | Public Affairs | PAO |
| Y | Casualty Estimation | J1 with surgeon |
| Z | Conflict Termination and De-escalation (Transition Strategy) | J5 |
| AA | Legal | Legal adviser |
| BB | Training and Exercises | J7 |
| CC | Documentation, Records and Reports | COS / IM staff |
| DD | Space Operations | J3 |
| EE | Engineer Support | Engineer |
| FF | Financial Support | J8 |
| GG | Non-NATO Force Procedures | J3 / J5 |
| YY, ZZ | Miscellaneous; Distribution | COS |

**NATO (current).** Current NATO plans use the same double-letter style but some letters have moved: CIMIC is "typically Annex W" [S21, chapter 4] (unchanged), while medical is now "Annex QQ" [S16, B.19] where CFJP 5.0 used Annex K [S10]. The full current list sits in NATO's planning directive (COPD), which is not public. Because Canada is adopting AJP-5 [S11], a CAF profile should be marked "verify letters against the current NATO planning directive before use" (gap).

### 3.6 The commander's decision cycle, CCIR and the COS

- **CCIR.** "CCIRs are elements of information the commander identifies as critical to timely decision making ... CCIRs belong exclusively to the commander" [S1, IV-2]. They have two parts: priority intelligence requirements (PIRs) on the adversary and environment, and friendly force information requirements (FFIRs) on own forces; "PIRs drive requests for information"; "FFIRs drive reporting" [S1, IV-2 to IV-3]. "CCIRs change as the decisions the commander must make change" [S1, IV-3].
- **Decision support.** "Commander-centric organizations outperform staff-centric organizations" [S4, 1.0]. Staffs should understand the commander's decision style and set "touch points" [S4, 4.0].
- **The COS's synchronizing role.** The COS integrates the staff "across time, organization, and information and knowledge"; disciplines the move between event horizons with "hand-off briefs"; and prioritizes staff effort, which "nobody else on the staff can do ... routinely" [S5, 3.0]. A combatant commander's view: the COS should "synchronize versus control staff efforts" [S5, 1.0]. The COS establishes "what the Commander needs to know, when and in what form" [S5, 2.0].
- **Night orders.** A "Joint Operations Directive" or "night orders" summarizes operations, intent and tasks from decision boards [S4, 3.0]. Mapping: the extension's equivalent is the COS's end-of-run summary.

---

## 4. Scaling by level

"Not all joint HQs are the same. Mission requirements determine specific capabilities and functions" [S4, 1.0]. Large headquarters "often take on unnecessary functions" [S4, 2.0; S1, II-12]. The table shows what exists, merges or vanishes.

| Role or section | Strategic (US Joint Staff; CAF SJS) | Operational (CCMD, CJOC, NATO JFC, JTF HQ) | Division / corps (G staff) | Brigade (US S staff; CA G staff) | Battalion / unit (S staff) |
|---|---|---|---|---|---|
| Commander and deputy | CJCS supported by the Joint Staff [S6]; CDS supported by the SJS [S13] | Commander and one or more deputies [S1, II-10] | Commander, deputy commanders (Mapping) | Commander, deputy (Mapping) | Commander |
| COS | Director of the Joint Staff (Mapping) | COS, maybe deputy COS [S5, 2.0; S16, B.3] | COS [S9, 2-41] | XO [S9, 2-41] | XO [S9, 2-41] |
| Senior enlisted | US: senior enlisted adviser (Mapping); CAF: CWO in a "Senior Leadership Team" [S15, 2.4] | CSEL; CPO1/CWO [S1, II-11; S15] | CSM [S9, 1-31] | CSM | CSM [S9, 1-31] |
| J1 / G1 / S1 | J-1 [S6] | J1 [S1, V] | G-1 | S-1 | S-1 exists "at battalion and all higher echelons" [S9, 2-47] |
| J2 to J4 | Yes [S6] | Yes [S1, II-12] | G-2 to G-4 | S-2 to S-4 | S-2 to S-4 (some sustainment units combine intelligence and operations [S9, 2-36]) |
| J5 / G5 plans | J-5 Strategy, Plans and Policy [S6]; SJS Plans division [S13] | J5 (NATO: J3 and J5 "may be combined" [S16, B.4]) | G-5 "typically exists at divisions and higher" [S9, 2-65] | No dedicated S-5; plans cell in the S-3 [S9, 2-65] (Canadian brigades show a G5 [S18]) | Plans cell in S-3 [S9, 2-65] |
| J6 / G6 / S6 | J-6 C4/Cyber, CIO [S12] | J6 [S1, X] | G-6 | S-6 | S-6 [S9, 2-68] |
| J7 | Joint force development [S7] | Optional; standing JTFs [S1, XI-1]; NATO optional [S16, B.15] | Training is a G-3 task (Mapping) | Vanishes into S-3 (Mapping) | Vanishes into S-3 (Mapping) |
| J8 | Force structure, resources and assessment [S8]; SJS Support division [S13] | Optional resource management [S1, XII]; NATO budget and finance [S16, B.16] | G-8 financial management [S9, 2-69] | Vanishes (Mapping) | "No resource manager" [S9, 2-36] |
| J9 | None on the Joint Staff [S6] | Optional CMO/interagency [S1, XIII]; NATO J9 CIMIC [S16, B.17] | G-9 | S-9 required in a brigade combat team [S9, 2-73]; CA brigade G9 [S18] | Only in special operations battalions [S9, 2-73] |
| J10 StratCom | Not researched | NATO J10 [S16, B.18] | IO officer, PAO (Mapping) | PAO duties (Mapping) | Not present (Mapping) |
| Legal, chaplain, IG, PAO, surgeon | Yes (Mapping) | Yes [S1, II-17] | Yes [S9, 2-129] | Some shared with higher (Mapping) | Chaplain; others from higher (Mapping) |
| KM / IM | Not researched | IMO appointed by COS [S1, IV] | KMO at division and above [S9, 2-103] | KM coordinators [S9, 2-103] | KM coordinators [S9, 2-103] |
| ORSA / OR&A | J-8 analysis [S8] | CJOC OR&A team [S20] | ORSA at "division and higher" [S9, 2-108] | Vanishes (Mapping) | Vanishes (Mapping) |
| POLAD | Not researched | Yes [S1, II-17; S16, B.2] | Rare (Mapping) | Vanishes (Mapping) | Vanishes |
| Working groups | Not researched | 30 to 40 active [S4, 3.0] | Many [S9, 4-34] | "Fewer working groups" [S9, 4-34] | Few [S9, 4-34] |

**Extension profiles (Mapping).**

- **Strategic:** COS lead plus J1, J2, J3, J4, J5, J6, J7, J8 (force structure and assessment meaning), POLAD, legal, PAO, ORSA. No J9 section (fold interagency into J5). Products: strategic estimate, options papers, assessments [S2, B; S8].
- **Operational (default "full staff"):** all of J1 to J9, the special staff team, KM, ORSA. Products: operational estimate, mission analysis, COAs, OPLAN or OPORD with annexes.
- **Tactical, brigade or battalion:** S1, S2, S3 (with a plans cell), S4, S6, S9 at brigade; legal and chaplain as advisers; no J7, J8, ORSA or POLAD sections. Products: OPORD with Army annex letters or Canadian (APP-28) formats.

---

## 5. A team of teams for the extension

### 5.1 What the extension can do today

Read from the worktree at `/home/aaron/projects/codequity/near-ai-vscode/.claude/worktrees/staff-teams-research` (branch `docs/staff-teams-research`):

- **Team file format.** Markdown with frontmatter (`name`, `description`, optional `privacy: private`) and one `## member` section per member, with optional `role:`, `model:`, `tools:`, `reports-to:` and last `privacy:`, then instructions (`src/agent/teams.ts`, `renderTeam`, around line 152; README "Teams, attachments, images, and memory").
- **Size.** "A team can have at most 12 members" (`src/agent/teams.ts` line 125; `src/agent/teamMarkdown.ts` line 231). Member names must match `^[a-z0-9][a-z0-9-]{0,39}$` (`teams.ts` line 39), so `j1/planner` is not a legal name but `j1-planner` is.
- **One team per run.** The members a run can start come from `request.team ?? request.memberTeam` (`src/services/agentSession.ts`, `teamMembersOf`, around line 1345). The spawnable pool is that team's members plus the workflow's own agents and Open-GSD agents, de-duplicated by name, first wins (`spawnableAgents`, around line 1335). **There is no way for a team to reference, contain or call another team.**
- **Members can start sub-agents, but only from the same pool.** A member's default tools exclude `Agent` (`teams.ts` line 41, `DEFAULT_TOOLS`). If its `tools:` line names `Agent`, it gets the Agent tool (`agentSession.ts` around line 1507), so it can start other members of the same team or Open-GSD agents. A foreground child makes the parent hand its concurrency slot back while it waits, so nested starts do not deadlock (`agentSession.ts` lines 1522 to 1560).
- **Parallelism limits.** `nearAi.agent.maxParallelAgents` defaults to 8 (maximum 16) and `nearAi.agent.maxParallelWorktrees` to 4 (`package.json` lines 574 to 586).
- **Lead behaviour.** The lead prompt tells the lead to start every independent part in the same turn, give each member its own area, use `isolation: "worktree"` for members that change files, merge branches one at a time, resolve conflicts or hand them to the owning member, and run checks once after all merges (`teams.ts`, `teamLeadPrompt`, line 348, and `PARALLEL_MERGE_NOTE`, line 331). This already matches the owner's standing direction (parallel work in separate areas, then merge).
- **Hierarchy is drawn, not enforced.** `reports-to:` shows hierarchy in Team Live and is checked for loops by Team Studio (README; `teams.ts` lines 21 to 24), but the lead prompt does not use it to route work.
- **Privacy.** `privacy: private` keeps a member (or, in frontmatter, every member) on a NEAR TEE or local model, and the run stops rather than fall back to a forwarded model (README; `teams.ts` line 93 onward).
- **Per-team knowledge.** Each team file has its own knowledge graph keyed by `teamKnowledgeKey` (`agentSession.ts` around line 1437).

**Conclusion:** a 9-section staff with its own section teams cannot be expressed today. Either flatten it into one 12-member team of section leads (5.4) or add nested teams (5.3).

### 5.2 The design goal

Map doctrine onto the extension's run model:

| Doctrine | Extension |
|---|---|
| Commander | The person. Approves mission, CCIR, COA and the final order. Never an agent. |
| Chief of staff | The staff team's lead agent (the run lead). Owns the battle rhythm (the run plan), sets section areas, integrates, resolves conflicts, escalates decisions. |
| Section (J1 to J9) | A section lead member that, with nesting, runs its own section team. |
| Running estimate | A file per section with fixed headings, updated each cycle. |
| OPT / JPG | A COA wave where J5 drafts and every section tests supportability in parallel. |
| Decision board | A pause where the COS asks the person to decide (the Ask tool), with the options and staff recommendation. |
| Annex ownership | File ownership: each section writes only its own annex files; the COS writes the base order and the annex index. |
| Synchronization matrix | A cross-check the COS (or an orders checker) runs after merge: task organization vs Annex A, CCIR vs Annexes B and R, timelines across annexes. |

### 5.3 Proposed extension change: section teams as nested leads

**Proposal.** Allow a member to point at another saved team:

```markdown
## j6-lead
role: J6 communications and cyber section lead
team: j6-section
reports-to: chief-of-staff
privacy: private
Lead the J6 section. Produce the J6 running estimate and Annex K ...
```

When the staff lead starts `j6-lead`, the runner starts a **nested team run**: the child gets `teamLeadPrompt(j6Section, task)` and the J6 section's members as its spawnable pool, instead of a single sub-agent. Rules the change needs:

1. **Pool scoping.** The nested lead's pool is its own section team's members (plus Open-GSD agents), not the staff team's. This removes name clashes and keeps sections in their lanes.
2. **Depth limit of 2** (staff team, then section team). A section team may not itself contain `team:` members. Team Studio should flag a `team:` line that names a team which has its own `team:` members, and any cycle (A refers to B refers to A), the same way it flags reports-to loops today.
3. **Consent covers the tree.** A project or imported staff team must not become a way round approval: approving the staff team asks about every referenced team that is not already approved, and the consent fingerprint includes the referenced files (today a project team's consent is asked again "when the file changes", README).
4. **Privacy is inherited, never relaxed.** If the staff team is private, every nested section run is private regardless of the section file.
5. **One budget and one stop.** Nested runs share the run's slots (`maxParallelAgents`), worktree slots, daily spend limit, TEE-only mode and Emergency stop. The existing slot hand-back already prevents a parent from starving its child.
6. **Two-level merge.** Section members work in worktrees and merge into the section lead's branch; section leads report one branch each; the COS merges section branches one at a time into the run branch and runs checks once. This is `PARALLEL_MERGE_NOTE` applied twice.
7. **Team Live** draws the section team under its lead (it already draws helpers under the card that started them, `teamLiveState.ts`), and the activity feed records `parentAgentId` (already recorded, `agentSession.ts` around line 1582).
8. **Knowledge.** Each section keeps its own team knowledge graph; the staff team keeps its own. A nested run writes to its section's graph.
9. **Member cap stays 12 per team.** A full staff is then 12 staff-team members times up to 12 per section team.

**Smaller alternative** if nested runs are too large a change: a `sections:` list in the staff team frontmatter that the COS can pass to a new `RunSectionTeam` tool (same rules 1 to 8). The member-line form above is preferred because it reuses the existing member, model, privacy and reports-to machinery and shows in the existing editor.

### 5.4 Workaround that works today (no code change)

- One staff team, `privacy: private`, with up to 12 members: the run lead acts as COS; members are section leads `j1-lead` to `j9-lead`, `special-staff` (legal, POLAD, PAO, chaplain, surgeon, IG, protocol rolled into one adviser member), `km-officer`, and `orders-checker`.
- Each section lead does its own section's work (no section team). Give `Agent` only to the COS (implicit) so sections cannot start each other; this keeps lanes clean.
- Prefix every name with the section code (`j1-`, `j6-`) so later nesting does not clash.
- Each member's instructions name its files (its area) and what it must not touch.
- For a tactical profile, drop J7, J8 and J9 and add an S-9 only at brigade.

### 5.5 How a full-staff run spreads and integrates the work

All waves below follow the lead rules already in `teamLeadPrompt`: everything independent starts in the same turn; each part writes only its own files; members that change files work in their own worktree.

| Wave | Parallel work (separate areas) | Integration by the COS | Human decision |
|---|---|---|---|
| 0 Receipt | COS reads the task and higher guidance and issues a staff warning order to all sections at once (Mapping from [S10, Wng O]) | Sets areas, deadlines and the doctrine profile and level | Person confirms the mission and the profile |
| 1 Estimates | Every section writes its running estimate in parallel; J2 environment analysis in parallel with the rest [S2, C-2] | COS merges into a mission analysis brief: facts, assumptions, constraints, proposed CCIR (PIR from J2, FFIR from J1, J3, J4, J6) | **Board 1:** person approves the mission statement, CCIR and planning guidance [S1, IV-2] |
| 2 COA development | J5 (with J3) drafts two or three COAs | COS checks they are distinct | None |
| 3 COA analysis | Every section tests each COA's supportability in parallel and states "whether the mission can be supported" [S2, C-2] | COS builds the comparison; disagreements become explicit trade-offs, not hidden edits | **Board 2:** person selects a COA |
| 4 Orders production | Each section drafts its own annexes in parallel (section 3.5 tables); J3 drafts base order paragraphs 1 to 3, J4/J1 paragraph 4, J6 paragraph 5 [S2, A-5 to A-8] | COS merges files, writes the annex index, runs the synchronization check (orders checker), sends conflicts back to the owning section | **Board 3:** person approves and signs; agents never mark an order as issued |
| 5 Assessment cycle | Sections update running estimates against reports | COS writes the "night orders" summary [S4, 3.0] | Person adjusts CCIR as decisions change [S1, IV-3] |

**Conflict rules (Mapping).**

1. A conflict inside one section's area goes back to that section.
2. A conflict between sections (for example a J4 throughput limit against a J3 timeline) is resolved by the COS when one side is clearly a fact (the fact wins); otherwise it becomes a decision for the person with both sides stated.
3. Nothing in a CCIR, the mission, the selected COA, ROE or legal advice is changed by the COS; those go to the person [S1, IV-2; S16, B.2].
4. Personal staff advice (legal, IG, chaplain) is reported to the person unedited, matching their direct access [S9, 2-129].

### 5.6 Full member roster (operational profile)

**Staff team: `joint-staff-operational` (12 members, lead acts as COS).**

| Member | Role | Model | Tools (suggested) | Area |
|---|---|---|---|---|
| j1-lead | J1 personnel section lead | standard | read, write | `staff/j1/` |
| j2-lead | J2 intelligence section lead (see file 02) | deep | read, web, write | `staff/j2/` |
| j3-lead | J3 operations section lead (see file 05) | deep | read, write | `staff/j3/` |
| j4-lead | J4 logistics section lead (see file 05) | deep | read, write | `staff/j4/` |
| j5-lead | J5 plans section lead, runs the JPG (see file 03) | deep | read, write | `staff/j5/` |
| j6-lead | J6 C4 and cyber section lead | standard | read, write | `staff/j6/` |
| j7-lead | J7 training, exercises and lessons section lead | standard | read, write | `staff/j7/` |
| j8-lead | J8 resources, finance and assessment section lead | standard | read, write | `staff/j8/` |
| j9-lead | J9 CIMIC and interagency section lead | standard | read, web, write | `staff/j9/` |
| special-staff | Lead of the personal and special staff team | deep | read, write | `staff/special/` |
| km-officer | Knowledge and information manager: file layout, annex index, Annex I / R / Z drafts, distribution | standard | read, write, documents | `staff/km/`, `orders/index` |
| orders-checker | Synchronization and red team: cross-annex consistency, doctrine profile check, unclassified check | deep | read only, writes `staff/checks/` | `staff/checks/` |

**Section teams (each a separate team file; at most 12 members).**

| Section team | Members |
|---|---|
| `j1-section` | j1-lead (lead); j1-manning (JMD, augmentation, billet requests from other sections) [S1, V-1]; j1-accountability (strength, casualty reporting, personnel recovery support) [S1, V-1]; j1-services (pay and entitlement policy with J8, postal, morale welfare and recreation, awards) [S1, V-1; XII-3]; j1-civilians-contractors (civilian and contractor personnel) [S1, V-1] |
| `j6-section` | j6-lead; j6-architect (communications architecture, Annex K) [S1, X]; j6-network-ops (JNCC picture, network status) [S1, X]; j6-cyber (cyberspace appendix with J3) [S1, X]; j6-spectrum (spectrum and information assurance, Mapping from [S9, 2-68]); j6-info-sharing (mission partner sharing) [S1, X] |
| `j7-section` | j7-lead; j7-training-guidance (training guidance and requirements) [S1, XI-2]; j7-exercise-planner (rehearsals, exercises, Annex BB in CAF profile) [S1, XI-2; S10]; j7-reception (staff orientation and reception) [S1, XI-2]; j7-lessons (lesson manager) [S1, XI-3] |
| `j8-section` | j8-lead; j8-cost-estimator (cost of each COA) [S1, XII-3]; j8-budget (funding sources, fiscal limits, common-funded budget in NATO) [S1, XII-1; S16, B.16]; j8-contracting-liaison (with J4 on Annex W) [S1, XII-2]; j8-assessment (operation assessment with ORSA, Annex N, Mapping) [S1, II-17] |
| `j9-section` | j9-lead; j9-civil-factors (CIMIC estimate, PMESII and ASCOPE) [S21, chapter 4]; j9-interagency (stakeholder map, interorganizational working group, Annex V) [S1, XIII]; j9-cmo-planner (Annex G or W) [S2; S21]; j9-liaison (LNOs and key leader engagement plans) [S1, XIII-4] |
| `special-staff` | special-staff (lead); legal-adviser (ROE, legal appendix, law of armed conflict review of every annex) [S1, XIV; S9, 2-144]; polad (political considerations) [S16, B.2]; pao (Annex F or J or X by profile) [S1, XIV; S9, 2-140; S10]; chaplain [S9, 2-129]; surgeon (Annex Q or QQ) [S1, XIV; S16, B.19]; inspector-general (Annex U in Army profile) [S9, 2-135]; protocol (visits and key leader engagement logistics) [S9, 2-130]; orsa-analyst (assessment methods) [S9, 2-107]; historian [S1, II-17]; safety-officer (risk management appendix) [S9, 2-142]; provost-marshal [S1, II-17] (12 members; drop historian or provost marshal to add a NATO gender or cultural adviser [S16, B.3]) |
| J2, J3, J4, J5 | See files 02, 03 and 05 |

**Instruction pattern for every member (Mapping).** Each member's instructions should state: the doctrine profile and level; its area (files) and what it must not touch; its inputs (which other sections' estimates to read); its output file with fixed headings; "recommend, do not decide"; the unclassified rule (6.2); and what it hands back to its lead (one paragraph plus the file path).

**Example section-team file (abridged).**

```markdown
---
name: J9 section (CIMIC and interagency)
description: Civil factors, interagency coordination and civil-military annexes for the joint staff.
privacy: private
---

## j9-civil-factors
role: CIMIC analyst
model: deep
tools: Read, Glob, Grep, WebSearch, WebFetch, CheckCitations, Write
reports-to: j9-lead
privacy: private
Your area is staff/j9/civil-factors.md. Using only public, unclassified sources or the scenario pack,
identify and assess civil factors (PMESII, ASCOPE) and the effect of each COA on non-military audiences.
Recommend; do not decide. Hand back a one-paragraph summary and the file path.
```

---

## 6. Pitfalls

### 6.1 Doctrinal errors to avoid

| Pitfall | Why it is wrong | Prevention | Source |
|---|---|---|---|
| Treating J-numbers as universal | JTF J-7 is training and education, Joint Staff J-7 is joint force development; JTF J-8 is resources and finance, Joint Staff J-8 is force structure and assessment; NATO J8 is budget and finance and adds J10 | Name sections by function in prompts ("J8 budget and finance (NATO)"), set by the doctrine profile | [S1, II-17; S7; S8; S16, B.4] |
| Mixing annex letters | K is C4 (US joint), civil affairs (Army), health services (CFJP 5.0); W is contract support (US) and CIMIC (NATO, CFJP 5.0); PA is F, J or X | One profile per run; the orders checker rejects letters from another profile | [S2; S9; S10; S21] |
| Using superseded doctrine as current | JP 3-33 (2018) is replaced by the June 2022 "Joint Force Headquarters" edition; Canadian planning is moving to AJP-5 and APP-28 | Label each template with the edition used and its date; flag "verify against current edition" | [S1; S3; S11] |
| Quoting UK national text as NATO | The gov.uk AJP-3 adds UK boxes (for example the JPG paragraph) | Cite only NATO paragraphs for the NATO profile | [S16] |
| Making the senior enlisted adviser or POLAD a decision maker | CSEL and CWO advise; the POLAD does not represent all of the foreign ministry | Advisers produce advice files only | [S1, II-11, XIII-4; S17] |
| Staff-centric design | "Commander-centric organizations outperform staff-centric organizations" | Every wave ends in a decision for the person | [S4, 1.0] |
| Stovepiped sections | J-code structures stovepipe knowledge | Shared running estimates; COS-run cross-functional waves | [S1, II-12; S4, 3.0] |
| Meeting sprawl | Events with no output waste the commander's and staff's time | Every wave has named inputs and outputs (a "7-minute drill") | [S4, 4.0] |
| Spinning up every section at tactical level | Brigades and battalions lack G-5, KMO, ORSA, resource manager | Level profiles in section 4 | [S9, 2-36, 2-65, 2-103, 2-108] |
| Overloading scarce experts | POLAD and SJA are high-demand, low-density | Run legal and POLAD once per wave over all annexes, not per annex | [S4, 4.0] |

### 6.2 Keeping templates unclassified

- **Use only public editions.** The current US joint publications need a CAC for web access, and some are on SIPR only [S3]; Canadian Army doctrine is on Defence 365 [S19]; NATO's planning directive is not public (section 3.5). Templates must cite only public documents, such as those in the Sources list.
- **Never paste restricted text into a team file or prompt.** Team files are plain Markdown, can be imported and exported, and are sent to a model when Team Studio reviews them (README "Improve with AI"). Treat them as public.
- **Mark outputs.** Doctrine formats carry a classification at "the top and bottom of every page" [S10, Annex F format]. Templates should write "UNCLASSIFIED - EXERCISE" (or the organization's own public marking) and use fictional scenarios.
- **Keep runs private anyway.** Mark the staff team and all section teams `privacy: private` so that work stays on NEAR TEE or local models (README "Private teams"). This protects client and scenario material; it is not a licence to process classified information, which no part of this extension is accredited for.
- **The orders checker** should fail a run that contains classification markings above unclassified, real unit operational details, or text quoted from non-public doctrine.

### 6.3 Human command authority

- Doctrine is explicit: CCIRs "belong exclusively to the commander" [S1, IV-2]; "commanders are the principal decision makers" and the staff "derives its authority from its commander" [S9, 2-32]; the commander "drives the TOR" [S4, 2.0].
- In the extension the commander is the person. Agents may draft, analyze and recommend; they must not approve a mission statement, CCIR, COA, ROE or an order, or mark an order as issued. Each board in section 5.5 is a pause for the person.
- Personal staff advice goes to the person unedited (section 5.5, rule 4).
- If the person delegates a decision (for example "pick the COA with the lowest logistics risk"), the COS records the delegation and the reason in the run summary, so the decision remains traceable to the person.

---

## 7. Gaps and open questions

1. **Current JP 3-33 (June 2022).** Not publicly downloadable; this file uses the 2018 edition. J-7, J-8 and J-9 descriptions may have changed [S3].
2. **NATO annex letters.** The full current list is in NATO's non-public planning directive; only Annex W (CIMIC) and Annex QQ (medical) are confirmed from public text [S21; S16].
3. **Canadian battle group and unit staff.** Public sources confirm brigade G staff only; battle group designations (for example S-staff or appointment titles) need the Defence 365 library [S18; S19].
4. **CJOC J-staff chart.** Not on the public CJOC page [S14].
5. **NATO strategic headquarters staff** (SHAPE) not researched.
6. **Extension change size.** Nested team runs (5.3) touch the runner, consent, Team Studio checks, Team Live and spend accounting; this needs a phase plan and tests for every new transition (staff run started, section run started, section run failed, consent refused for a referenced team, cycle detected).

---

## Sources

All accessed 2026-11-18. Where a site refused direct download, the Internet Archive copy of the same official URL was read; both are given.

| Key | Title | Publisher | Date | URL |
|---|---|---|---|---|
| S1 | Joint Publication 3-33, Joint Task Force Headquarters | US Joint Chiefs of Staff | 31 January 2018 | http://www.jcs.mil/Portals/36/Documents/Doctrine/pubs/jp3_33.pdf (read via https://web.archive.org/web/20180219015407/http://www.jcs.mil/Portals/36/Documents/Doctrine/pubs/jp3_33.pdf) |
| S2 | Joint Publication 5-0, Joint Planning | US Joint Chiefs of Staff | 1 December 2020 | https://www.jcs.mil/Portals/36/Documents/Doctrine/pubs/jp5_0.pdf (read via https://web.archive.org/web/20220715183645/https://www.jcs.mil/Portals/36/Documents/Doctrine/pubs/jp5_0.pdf) |
| S3 | Joint Doctrine Hierarchy and status chart (lists JP 3-33 as "Joint Force Headquarters"; "Web access to these JPs requires a CAC") | US Joint Staff J7 | 12 December 2024 | https://www.jcs.mil/Portals/36/Documents/Doctrine/pubs/status.pdf (read via https://web.archive.org/web/20250206004927/https://www.jcs.mil/Portals/36/Documents/Doctrine/pubs/status.pdf) |
| S4 | Insights and Best Practices Focus Paper: Joint Headquarters Organization, Staff Integration, and Battle Rhythm, Third Edition | Joint Staff J7 Deployable Training Division | September 2019 | https://www.jcs.mil/Portals/36/Documents/Doctrine/fp/jtf_hq_org_fp.pdf |
| S5 | Insights and Best Practices Focus Paper: Chief of Staff (COS) Roles and Functions at Joint Headquarters, First Edition | Joint Staff J7 Deployable Training Division | April 2015 | https://www.jcs.mil/Portals/36/Documents/Doctrine/fp/cos_fp.pdf |
| S6 | Joint Chiefs of Staff: Directorates (J-1 to J-8 list) | US Joint Chiefs of Staff | Undated web page | https://www.jcs.mil/Directorates/ |
| S7 | J7 Joint Force Development | US Joint Chiefs of Staff | Undated web page | https://www.jcs.mil/Directorates/J7-Joint-Force-Development/ |
| S8 | J8 Force Structure, Resources, and Assessment | US Joint Chiefs of Staff | Undated web page | https://www.jcs.mil/Directorates/J8-Force-Structure-Resources-Assessment/ |
| S9 | FM 6-0, Commander and Staff Organization and Operations | Headquarters, Department of the Army | May 2022 | https://armypubs.army.mil/epubs/DR_pubs/DR_a/ARN35404-FM_6-0-000-WEB-1.pdf |
| S10 | CFJP 5.0, The Canadian Forces Operational Planning Process (OPP), Change 2 (B-GJ-005-500/FP-000) | Department of National Defence, Strategic Joint Staff | April 2008 | https://publications.gc.ca/collections/collection_2010/forces/D2-252-500-2008-eng.pdf (record: https://publications.gc.ca/site/eng/9.693032/publication.html) |
| S11 | Operational and Tactical Planning in the CAF (Lt-Col Gilbert Desgrosseilliers) | Canadian Army, Line of Sight | 2 April 2026 | https://www.canada.ca/en/army/services/line-sight/articles/2026/04/operational-and-tactical-planning-in-the-caf.html |
| S12 | J6 C4/Cyber | US Joint Chiefs of Staff | Undated web page | https://www.jcs.mil/Directorates/J6-C4-Cyber/ |
| S13 | Strategic Joint Staff | Department of National Defence | Page date 2021-11-01 | https://www.canada.ca/en/department-national-defence/corporate/organizational-structure/strategic-joint-staff.html |
| S14 | Canadian Joint Operations Command (CJOC) | Department of National Defence | Page date 2026-10-14 | https://www.canada.ca/en/department-national-defence/corporate/organizational-structure/canadian-joint-operations-command.html |
| S15 | Beyond Transformation: The CPO1/CWO Strategic Employment Model (cat. D2-289/2011) | Department of National Defence | 2011 | https://publications.gc.ca/collections/collection_2024/mdn-dnd/D2-289-2011-eng.pdf |
| S16 | AJP-3, Allied Joint Doctrine for the Conduct of Operations, Edition D Version 1 (with UK national elements) | NATO Standardization Office; UK Ministry of Defence | August 2025 | https://assets.publishing.service.gov.uk/media/6964e72799fbdc498faecce2/AJP_3_Ed_D_V1-O.pdf |
| S17 | The Role of the Chief Warrant Officer within Operational Art (CWO Kevin West) | Royal Canadian Air Force Journal, Vol. 4, Issue 3 | Summer 2015 | https://www.canada.ca/en/air-force/corporate/reports-publications/royal-canadian-air-force-journal/2015-vol4-iss3-08-the-role-of-the-cwo.html |
| S18 | Integrating enablers: Experiments with a Combat Support Group on Ex Unified Resolve (Chris Thatcher) | Canadian Army Today | 15 May 2023 | https://canadianarmytoday.com/?p=17766 |
| S19 | Canadian Army Doctrine Development (B-GL-007-001/FP-001) | Canadian Army, Line of Sight | 21 January 2026 | https://www.canada.ca/en/army/services/line-sight/articles/2026/01/canadian-army-doctrine-development.html |
| S20 | A strategic review of the CJOC OR&A work program (Mark Rempel), D68-9/104-2018E-PDF | DRDC Centre for Operational Research and Analysis | October 2018 | https://publications.gc.ca/site/eng/9.881903/publication.html |
| S21 | AJP-3.19, Allied Joint Doctrine for Civil-Military Cooperation, Edition B Version 1 | NATO Standardization Office (UK-hosted copy) | June 2025 | https://assets.publishing.service.gov.uk/media/6acf5296c84c8ff1bc8b80fb/AJP_3_19_EdB_CIMIC.pdf |
| S22 | AJP-5, Allied Joint Doctrine for the Planning of Operations, Edition B Version 1 (with UK national elements) | NATO Standardization Office; UK Ministry of Defence | June 2026 | https://assets.publishing.service.gov.uk/media/6ae9d7b9c4e9914878121f16/AJP_5_EdB_UKNE_WEB_updated.pdf |
| S23 | CIMIC-COE Handbook, 2.4 Integration in the HQ | NATO Civil-Military Cooperation Centre of Excellence | Undated (copyright 2026) | https://www.cimic-coe.org/handbook-entries/welcome-to-the-cimic-handbook/ii-fundamentals/2-4-integration-in-the-hq/ |

**Repository sources** (worktree `/home/aaron/projects/codequity/near-ai-vscode/.claude/worktrees/staff-teams-research`): `src/agent/teams.ts`, `src/agent/teamMarkdown.ts`, `src/agent/projectTypes.ts`, `src/services/agentSession.ts`, `src/services/teamStudioPage.ts`, `src/gsd/tools.ts`, `package.json`, `README.md` (sections "Teams, attachments, images, and memory" and "Team Mode (preview)").
