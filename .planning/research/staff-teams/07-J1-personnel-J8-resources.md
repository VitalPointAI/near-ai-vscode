# J1 Personnel and J8 Resources: doctrine research for agentic staff teams

> **Edition update (2026-11-18).** This note used JP 5-0 of 1 December 2020. JP 5-0 of 1 July 2025 supersedes it and was read from the owner's reference copy for design note 10. JPP step names are unchanged; US Joint COA tests are now suitable, feasible, acceptable, distinguishable, complete; the fourth planning function is plan evaluation; annex I is Knowledge, Information, and Data Management and annex K is Command, Control, Communications, Computer, and Cybersecurity Systems. See design note 10, sections 2.6, 2.8 and 2.9.

**Researched:** 2026-11-18
**Scope:** US joint and Army doctrine plus Canadian joint doctrine and policy, used to build two team templates for the NEAR AI VS Code extension: a J1 (manpower and personnel) team, and a J8 (force structure, resources and assessment, or in a JTF, resource management and financial support) team. Both work at strategic, operational and tactical levels. At tactical level the J1 becomes the S1 or G1, and the J8 becomes the S8 or G8 (financial management officer).
**Sources:** Public and unclassified only. Each claim carries a source tag such as [S5]. The numbered list at the end gives title, publisher, date and URL.
**Overall confidence:** MEDIUM to HIGH. The core doctrine was read in full from public copies of the official PDFs: JP 1-0 (2020), JP 3-80 (2016, validated 2018), JP 3-33 (2018), JP 5-0 (2020), FM 4-1 (September 2025), FM 5-0 (November 2024), FM 1-06 (2011), CJCSI 5123.01J (January 2026), CFJP 3.0 (2010) and CFJP 5.0 (2008). The weak spots are Canadian: no public CFJP personnel publication text, no public CJOC J1 or J8 organisation, and no Canadian tactical finance doctrine was found.

**Confidence tags used below** (same scheme as files 02, 03 and 05):
- **[H]** the claim was read in the primary text or on an official government page.
- **[M]** an official publication or page was confirmed by two or more public sources, or was read only as an official summary or search extract.
- **[L]** only one secondary source supports it. Never present an [L] claim as settled.
- **(design)** marks a recommendation of this research, not a doctrinal statement.

**Model tiers** use the extension's three tiers, `deep`, `standard` and `fast`. Judgement roles get `deep`, structured production gets `standard`, and monitoring, extraction and checking get `fast`. Team files follow `src/agent/teams.ts`: frontmatter with `name`, `description` and optional `privacy`, then one `## member` section each with `role`, `model`, `tools`, `reports-to` and `privacy` lines [S41][H].

**Method note.** The Joint Staff and Army Publishing Directorate sites refuse automated downloads, so JP 1-0, JP 3-80 and FM 1-06 were read from Internet Archive copies of the public irp.fas.org PDFs, and CJCSI 5123.01J and the Joint Staff J8 page from Internet Archive copies of the jcs.mil originals. FM 4-1 was read from armypubs.army.mil directly. Downloaded files were only converted to text. Nothing was run. The GSD research cache seam was not used, because this task was limited to writing this one file.

---

## Summary (key points first)

1. **The Army personnel manual changed in 2025, and a template that cites FM 1-0 is out of date.** FM 4-1, Human Resources Support, dated 15 September 2025, supersedes FM 1-0 (25 August 2021) [S5][H]. It recasts HR as part of sustainment with two core competencies, "man the force" and "provide HR services" [S5 para 1-20][H][S9][H]. The joint J1 baseline is still JP 1-0, Joint Personnel Support, 1 December 2020 [S1][H].

2. **The J1's core outputs are few and well defined.** The personnel estimate (with a casualty estimate inside it), the joint manning document (JMD) for the headquarters, Annex E (Personnel) to the plan, and the daily joint personnel status and casualty report (JPERSTAT) during execution [S1 II-6, III-1 to III-3, A-1][H]. Each becomes one owned product of one team member.

3. **The J1 coordinates; the Services account.** "Service component commanders are responsible for maintaining accountability of their forces." The J1 builds joint strength by "combining daily Service component strength reports into the JPERSTAT" and its casualty reporting is "not to duplicate Service reporting procedures" [S1 II-6, II-9][H]. A J1 agent team therefore works on aggregate reports. It is not the system of record for individual people.

4. **J1 data is the most sensitive data any staff team will touch, and the extension's labels already decide where it can go.** In the shipped routing table, `ca-protected/Protected B` and `org/Restricted` are local-only: they never leave the computer, not even to the NEAR private cloud [S40][H]. A chat's label rises with what any of its agents reads and only a human can lower it [S40][H]. So by-name personnel data must be handled in a separate, local-only run, and only aggregated, de-identified products should reach the main J1 team (design). Section A11 sets out this two-zone design.

5. **Casualty information needs extra care in both countries.** Canada's DAOD 5018-1 (31 January 2025) says the casualty report "must not contain any personal medical information", forbids disclosing medical information without the casualty's written consent, and bars media statements until next of kin are notified [S17][H]. FM 4-1 requires "very clear verbiage" on safeguarding casualty information "to prevent premature and erroneous disclosure and to protect patient privacy" [S5 para 3-26][H]. No agent should ever draft a notification to a family.

6. **"J8" means three different jobs, and the template must say which one.** On the Joint Staff, J8 is force structure, resources and assessment: it runs the JROC secretariat and capability analysis [S11][H][S12][H]. At a combatant command it is typically resources and assessments: planning, programming, budgeting and executing funds, plus analysis [S13][H]. In a JTF it is the optional "resource management and financial support directorate", which "could simply focus on comptroller requirements for the JTF and have no assessment responsibilities" [S3 XII-1][H]. In Canada the JTF J8 is "financial and comptrollership" [S15 para 0417][H].

7. **JCIDS is gone, so a strategic J8 template must use the new process.** CJCSI 5123.01J (15 January 2026) records the disestablishment of JCIDS and creates the Joint Force Requirements Process (JFRP), with the JROC refocused on Joint Force Design, Joint Capability Integration and combatant command requirements through "Joint Operational Problems" [S12][H]. Combatant commands still submit capability gaps through Integrated Priority Lists (IPLs) [S12 Encl C][H]. The Joint Staff J8 web page still describes JCIDS [S11][H], which shows how quickly official pages lag.

8. **Money decisions belong to people with delegated authority, by law.** US obligations must be "incurred only by authorized individuals and only with proper authorization", within purpose, time and amount limits, to avoid Antideficiency Act violations [S2 I-3][H]. In Canada, commitment (Financial Administration Act section 32), payment requisition (section 33) and certification (section 34) can only be exercised by people designated in the DND delegation instrument [S27][M], and no one may hold both section 33 and section 34 authority for the same payment [S29][M]. A J8 agent drafts, costs, checks and tracks. It never commits, certifies, obligates or pays.

9. **Where the money annex lives differs by publication, and the template must pick a profile.** JP 3-80 puts finance in "appendix 3 (Finance and Disbursing) to annex E (Personnel)" [S2 I-4, II-2][H]. The later JP 3-33 has the J8 prepare "paragraph 4 ... of the base plan for annex W (Operational Contract Support)" [S3 XII-2][H]. The Army puts it in Tab B (Financial Management) to Appendix 2 to Annex F (Sustainment) [S6][H]. The Canadian CFJP 5.0 list has a separate Annex FF, Financial Support [S16][H].

10. **Assessment has three possible owners, and two other teams already claim it.** JP 5-0 lets the commander or chief of staff put the assessment element in a special staff section, a separate section, or inside operations or plans [S4 VI-11][H]. A strategic assessment working group is typically chaired from "a J-3, J-5, or J-8 element" [S4 VI-5][H]. The J3 and J5 templates (files 03 and 05) each have an assessment member. The J8 template should carry an assessment seat that is switched off unless the commander assigns assessment to the J8 (design).

11. **Proposed teams.** A J1 main team of 8 members plus a 2-member local-only "by-name cell" run separately, and a J8 team of 9 members at strategic level, 8 at operational level and 5 at tactical level. Every decision (COA approval, JMD validation, award approval, entitlement requests, fund commitment, contract approval, casualty notification) stays with a named human.

---

## Edition check (as of 2026-11-18)

| Publication | Edition used | Status and notes | Tag |
|---|---|---|---|
| JP 1-0, Joint Personnel Support | 1 December 2020, supersedes 31 May 2016 [S1] | Current joint J1 baseline. The 2020 revision added operation assessment and "Removed Annex E from Appendix B", so the annex format now comes from CJCSM 3130.03 [S1 iii, III-3] | H |
| FM 4-1, Human Resources Support | 15 September 2025, supersedes FM 1-0 of 25 August 2021 [S5] | Current Army HR doctrine | H |
| ATP 1-0.1, Techniques for HR Support to Operations | 16 November 2023 (as listed in FM 4-1 references) [S5] | S1 and G1 techniques; not read | M |
| AR 600-8-6, Personnel Accounting and Strength Reporting | 27 June 2022 (as listed in FM 4-1) [S5] | Not read | M |
| JP 3-80, Resource Management | 11 January 2016, validated 10 January 2018 [S2] | Renamed and renumbered from JP 1-06. No newer edition found | H |
| JP 3-33, Joint Task Force Headquarters | 31 January 2018 [S3] | A June 2022 edition titled "Joint Force Headquarters" is reported by a bookseller only [S43][L]. Verify before shipping | H (2018 text) |
| JP 5-0, Joint Planning | 1 December 2020 [S4] | No newer edition found (also checked in files 03 and 05) | H |
| FM 5-0, Planning and Orders Production | November 2024 [S6] | Current | H |
| FM 1-06, Financial Management Operations | 4 April 2011 read [S7]; an April 2014 edition exists [S8] | 2014 text not read. FM 4-1 lists FM 4-0, Sustainment Operations (14 August 2024) as the sustainment capstone [S5] | H (2011), M (2014) |
| CJCSI 5123.01J, JROC charter and JFRP | 15 January 2026 [S12] | Replaces JCIDS (CJCSI 5123.01I). A "Change 1" is listed on jcs.mil but was not read | H |
| CFJP 3.0, Operations | 1st edition, issued 2010-07 [S15] | Defines J1 and J8 in a JTF HQ | H |
| CFJP 5.0, The Canadian Forces OPP | Change 2, April 2008 [S16] | Being replaced by NATO AJP-5 alignment; see files 03 and 05 [S42][M] | H |
| Military Personnel Management Doctrine | B-GL-005-100/FP-001 [S20] | Cited by DAOD 5002-0. Text not found online. A "CFJP 1.0" designation could not be confirmed [S21][L] | M (exists), L (date) |
| DAOD 5018-1, Military Casualty Reporting | 31 January 2025 [S17] | Replaced CFAO 24-1 | H |

---

## Part A: J1 Personnel

### A1. Doctrine baseline

| Publication | What the template takes from it |
|---|---|
| JP 1-0 (2020) [S1][H] | J1 functions, JMD, JPERSTAT, personnel estimate format, Annex E, casualty, pay, postal, MWR, awards, civilians and contractors, personnel visibility, assessment |
| JP 3-33 (2018) [S3][H] | JTF J1 organisation and duties, JMD working group, six JMD sourcing categories |
| JP 5-0 (2020) [S4][H] | Where staff estimates fit in the JPP |
| FM 4-1 (2025) [S5][H] | S1 and G1 by echelon, PASR, casualty and replacement operations, HR systems, people analytics, manual fallback |
| FM 5-0 (2024) [S6][H] | G-1 and S-1 duties in COA analysis, Annex F Appendix 2 Tab A (HR support) |
| CFJP 3.0 (2010) [S15][H] | Canadian JTF J1 definition |
| CFJP 5.0 (2008) [S16][H] | Canadian staff analysis by branch, annex list (Personnel Services appendix to Annex R, Annex Y Casualty Estimation) |
| DAOD 1000-7, 5002-0, 5018-1, 5050-0 [S19][S20][S17][S18][H] | Canadian personnel policy framework, casualty reporting, records and privacy |

### A2. What a joint J1 does

- **Mission.** "A J-1's function is to enhance personnel readiness and operational capabilities of the joint force." The J1 plans and assesses force structure, personnel sustainment and support concepts for each phase; advises the staff; and coordinates with higher, lower, supporting and supported J1s, other government departments, host nations and multinational forces [S1 I-3][H].
- **Principles.** Command emphasis (the JFC gives objectives to the J1 early and prioritises personnel requirements, including language and specialty skills), synchronization, integration, and flexibility and responsiveness [S1 I-2][H].
- **Organisation.** A notional J1 has a personnel readiness division (plans and policy, and optionally a joint personnel operations center, the JPOC, linking the J1 to current and future operations), a human capital division (joint manpower, JMD), and a personnel services division (internal military and civilian programmes) [S1 I-2 to I-3][H]. JP 3-33 calls the third one the military personnel division in a JTF [S3 V-2][H].
- **Primary responsibilities.** Personnel management, manpower management (JTD and JTMD), personnel augmentation (joint individual augmentation, JIA), joint personnel training and tracking activities and joint personnel processing centers (JPTTA, JPPC), personnel accountability and strength reporting, rotation policy, civilian employees, pay and entitlements, postal operations, MWR, casualty operations and reporting, and awards and decorations [S1 II-4 to II-9][H]. JP 3-33 adds personnel performance evaluations, and support to reserve call-up, stop-loss, noncombatant evacuation, personnel recovery and detainee operations [S3 V-1][H].
- **The JTF J1** is "principal staff assistant to the CJTF on manpower management, personnel management, personnel readiness, and personnel services" and "maintains the JMD" [S1 III-5][H][S3 V-1][H]. It covers the total force: military, DoD civilian and DoD contractor [S3 V-1][H].

### A3. Personnel accountability, strength reporting and personnel visibility

- **Joint level.** The J1 combines daily Service component strength reports into the JPERSTAT, which may go into the JFC's daily SITREP. The format is in CJCSM 3150.13, Joint Reporting Structure, Personnel Manual. "The J-1 ensures direct accountability for joint HQ personnel" [S1 II-6][H]. The J1 and J3 cross-check strength figures and task organisation changes, and the J1, J3 and J4 set reporting requirements at the start of an operation [S1 II-4][H].
- **Personnel visibility.** DMDC's Joint Personnel Accountability Reconciliation and Reporting (JPARR) application reconciles Service deployment systems and other sources (SPOT for contractors; Army DTAS, Marine Corps SPA, Air Force DCAPES; plus DCPDS, FMTS, DBIDS, DFAS, DTS, JAMMS and others) and produces an automated SIPRNET joint personnel strength report [S1 III-6 to III-7][H]. The supported combatant commander publishes visibility policy for ports, reception, JRSOI, JPPCs, transit and more [S1 III-6 to III-8][H].
- **Army level.** Personnel accounting and strength reporting (PASR) is "the by-name management of the location and duty status of every person". Strength reporting "is the numerical end product of by-name data" [S5 para 1-23][H]. Company commanders report daily duty status to the battalion S-1, which runs PASR for the battalion [S5 para 1-21][H]. SABIR in IPPS-A is the primary PASR tool [S5 para 1-23][H]. DTAS is the deployed database of record and SPOT covers contractors authorised to accompany the force (CAAF) [S5 para 3-6, 3-7][H].
- **Degraded mode.** If DTAS and SPOT are unavailable, "reports such as the PERSTAT report must be completed manually". PERSTATs are standardised snapshots that "can be easily transmitted via voice if necessary" (format in FM 6-99) [S5 para 3-6][H]. FM 4-1 also warns about planning for "corrupted personnel status" reports in contested networks [S5 para 1-50][H]. **Template use (design):** the strength analyst must accept a manual PERSTAT table as input and must flag stale or inconsistent snapshots instead of filling gaps.
- **Decision value.** A 2026 Army Sustainment article on FM 4-1 calls real-time personnel asset visibility "the bedrock of a commander's decision-making process" and notes that reported strength below 75% can be a critical decision threshold [S9][H]. Thresholds belong in a setting the human sets, not in the prompt (design).

### A4. Manning the joint headquarters: the JMD

- **What it is.** The JMD "will define the JTF HQ's overall manpower requirements". It can be filled by units, multinational partners, other government departments and contractors. FMTS is "a SIPRNET-based system of record to document all JMDs". The JMD "is not a sourcing mechanism" in itself [S1 III-1][H].
- **Minimum content.** Command, activity, department, line number, billet title, duty description, grade, skill or specialty, security clearance, source type, Service, location, latest arrival date and tour length [S1 III-2][H]. **Template use:** these 14 fields are the column schema of the JMD workbook the manning member produces.
- **Six sourcing categories.** Unit, general or flag officer, multinational, contractor, other US government departments and agencies, and JIA [S3 V-3][H]. JIA "is meant to be the last method" and may not fill permanent shortfalls or exercise positions [S3 V-4][H].
- **Process.** The CJTF drafts the JMD with the establishing commander's staff; the combatant command J1 fills what it can internally before Joint Staff J-1 validation under CJCSI 1301.01; the establishing command J1 maintains the JMD; any change needs Joint Staff J-1 validation [S1 III-2 to III-3][H]. A JMD working group, chaired by the J1 with a J3 co-chair, validates positions, tracks by-name arrivals and departures, and submits change requests [S1 III-3][H][S3 V-1][H].
- **Checklist.** JP 1-0 Appendix C gives a JMD validation checklist: is the requirement directed by the President or SecDef, is it for an operational-level C2 HQ, could a unit do the mission instead, "Has a joint personnel estimate been performed", have assigned forces been exhausted, is each position justified [S1 C-1][H]. **Template use:** the checklist becomes the manning member's self-check before a JMD goes to the human J1.

### A5. Casualty operations, the casualty estimate and replacements

- **Casualty estimate.** "The personnel estimate should contain a casualty estimate." Service components build casualty estimates under Service directives and give them to the J1, who shares them across the force. They feed COA evaluation, replacement flow, medical planning, transport planning and evacuation policy [S1 A-1][H]. In the Army, the G-1 or S-1, "assisted by the surgeon section, provides casualty estimates using the medical planner's toolkit" [S6 para 5-156][H].
- **Joint casualty reporting** "is based on CCDR guidance" and focused on keeping commanders aware. It typically uses the DCIPS personnel casualty report, OPREP-3 event reports or the JPERSTAT, depending on intensity [S1 II-8 to II-9][H]. Notification of next of kin is each Service's business [S1 II-8][H].
- **Army casualty operations.** DCIPS is "the DOD authoritative system of record for casualty and mortuary affairs reporting". The theater casualty information center reports to HRC's casualty and mortuary affairs division; casualties include deceased, DUSTWUN, missing, injured and ill, and units report civilians, contractors and other Services' personnel too [S5 para 3-27, 3-28][H]. Large-scale combat losses "have the potential to overwhelm the casualty reporting process" [S5 para 3-28][H], and the 2026 article says casualty doctrine is "largely theoretical, untested in major exercises" [S9][H].
- **Canada.** The parent unit commanding officer completes a casualty report (CASREP) "by the fastest possible means" to the Canadian Forces Integrated Command Centre at NDHQ, with follow-ups when the situation changes. The CASREP "must not contain any personal medical information"; notification is done by the CO with a chaplain, who assigns a Designated Assistant; no media statement until emergency contacts are notified [S17 paras 3.4 to 3.6, 4.2 to 4.6, 5.8][H]. CFJP 5.0 reserves Annex Y for casualty estimation [S16 5E1-3][H].
- **Replacement operations** depend on coordination across echelons and sustainment support, and are prioritised from strength reports [S5 para 1-23, 1-24][H].

### A6. Personnel services, civilians and contractors

- **Pay and entitlements.** The commander makes determinations and the Joint Staff J-1 recommends. Equity across Services and timeliness are the two tests. Imminent danger pay "is not retroactive and is not effective until a request for it is approved" by the PDUSD(P&R) [S1 II-7][H]. The J8 or comptroller coordinates entitlement policy through the J1 [S2 II-3][H][S3 XII-3][H].
- **Postal** is usually given to the J1, coordinated with the Military Postal Service Agency, and needs J3 and J4 help with lift [S1 II-7][H].
- **MWR.** The combatant command J1 is responsible for external MWR support to a subordinate joint force; programmes include fitness, exchange, entertainment, phones, internet and rest and recuperation [S1 II-8][H].
- **Awards.** The J1 publishes guidance and moves recommendations through channels, but "awarding authority for many decorations is retained by the Military Department Secretaries" [S1 II-9][H].
- **Civilians and contractors.** Combatant commanders state civilian requirements through global force management and set theatre admission requirements for DoD expeditionary civilians and CAAF; CAAF process through a JPPC unless waived; detail is in DoDI 3020.41 [S1 II-6, II-7][H]. **Template use:** contractor personnel accountability is a J1 job; contract requirements and funding are J4 and J8 jobs (see Part C).
- **Other duties.** Language and regional expertise requirements (CJCSI 3126.01), sexual assault prevention and response programme oversight, and personnel support to multinational operations [S1 I-2, III-8, App Q][H]. SAPR case handling is never an agent task (design).

### A7. J1 planning products and assessment

- **Personnel estimate.** The J1 "assists the commander in reaching a decision by estimating whether a particular operation or mission is supportable from a personnel perspective" [S1 III-1, A-1][H]. The J1 reviews mission and situation from a personnel view, considers threat and force protection, sets personnel decision criteria, analyses and compares COAs, and concludes "whether the mission can be supported and which COA can best be supported" [S1 A-1 to A-2][H].
- **Personnel estimate format (JP 1-0 Appendix A)** [S1 A-3 to A-5][H]. This is the heading skeleton of the lead's output file:
  1. Mission
  2. Situation and considerations: area characteristics; enemy strength and capabilities as they affect personnel; friendly dispositions and own COAs; logistic situation; C2 situation; personnel assumptions; special features (for example civil and indigenous labour); regional and language expertise requirements; personnel situation
  3. Personnel analysis of own COAs
  4. Comparison of own COAs (advantages and disadvantages, worksheet)
  5. Conclusions: can the mission be supported; which COA is best supported; major personnel deficiencies and recommendations
- **Annex E (Personnel).** When the concept of operations is set, "the J-1 provides input to the OPLAN in annex E (Personnel)" in the CJCSM 3130.03 format [S1 III-3][H]. JP 1-0 now gives only administrative instructions, because the sample format was removed in 2020 [S1 iii, B-1][H].
- **Army.** The G-1 develops "the personnel support portion of annex F (Sustainment)" [S5 para 2-18][H]; FM 5-0 places it in Tab A (Human Resources Support) to Appendix 2 (Personnel Services Support) to Annex F [S6][H]. Army Annex E is Protection, not Personnel [S6][H].
- **Canada (CFJP 5.0 list).** Annex R (Logistics) has a Personnel Services appendix; Annex Y is Casualty Estimation; the service support paragraph includes "Personnel Replacement and Holding Policy" [S16 5E-3, 5E1-2 to 5E1-3][H]. Each branch, J1 included, does its own staff analysis before COA development [S16 3-12][H].
- **Assessment.** JP 1-0 (2020) added operation assessment: personnel assessment helps "determine the effectiveness of allocated resources" and whether "an increase, decrease, or change to resources is required" [S1 III-9][H]. The FM 4-1 HROC "uses HR planning considerations to develop performance indicators" [S5 para 2-19][H].

### A8. US Army S1 and G1 (FM 4-1)

- **Two core competencies.** Man the force (personnel information management, PASR, replacement operations, casualty operations, personnel readiness management) and provide HR services (essential personnel services, postal, band, MWR) [S5 para 1-20, 1-22][H].
- **Echelons.** The ASCC G-1 is "the principal staff officer for all matters concerning HR support (military and civilian)", interacts with the combatant command J-1, and writes the personnel part of Annex F [S5 para 2-17, 2-18][H]. The theatre HROC runs strength management, accountability and the casualty information center [S5 para 2-19, 2-20][H]. The brigade S-1 is "the principal staff advisor to the brigade commander for all matters concerning HR support including talent management"; the battalion S-1 plans, provides and coordinates HR support for the battalion; corps and division HQ battalion S-1s do brigade-type work [S5 para 2-30 to 2-32][H].
- **Systems.** IPPS-A is "the HR system of record across all Army components"; HR staff "must understand manual processes when IPPS-A and other HR systems are not available for extended periods" [S5 para 1-34][H]. IPPS-A reporting uses Oracle Business Intelligence Enterprise Edition [S5 para 4-43][H].
- **People analytics.** FM 4-1 endorses "data-driven and goal-focused methods of studying people processes" to give commanders insight into strength and readiness, and asks for data "that is useable, secure, and integrated with Army enterprise systems" [S5 para 4-40, 4-41][H]. This is the closest doctrinal hook for an AI J1 assistant. It speaks of units and readiness, not judgements about named soldiers.

### A9. Canadian doctrine and policy for the J1

- **J1 in a JTF.** "The J1 staff assists the commander with the formulation of personnel policies for the management of the JTF personnel. This staff is also responsible for administering the military and civilian personnel within the JTFHQ" [S15 para 0417c(1)][H].
- **Policy framework.** DAOD 1000-7 sets the functional areas of military personnel management under the Chief of Military Personnel: selection, recruiting, production planning, occupational structure, training, career management, morale and welfare, health services, chaplaincy, family support, compensation and benefits, and CAF personnel readiness [S19][M]. The CMP policy framework is CAFMPI 05/22 [S19][M].
- **Personnel doctrine.** DAOD 5002-0 cites "B-GL-005-100/FP-001, Military Personnel Management Doctrine" [S20][H]. A CFC service paper reportedly dates it June 2008 [S21][L]. No public text was found, and the "CFJP 1-0" title in the brief could not be confirmed. Its number sits in the same B-GL-005 series as CFJP 4-0 Support (B-GL-005-400/FP-001, see file 03) [S43][M], so it is most likely the joint personnel keystone, but the template should cite it by its number, not as "CFJP 1-0", until the title is confirmed.
- **CJOC J1 today.** OP FUTURE, led by the CJOC J1 Chief Warrant Officer with 2nd Canadian Division, is modernising annual readiness and deployment administration: automating processes, removing paper, and building an application that joins Monitor MASS and other Military Command Software tools, reachable through the MyCAF app. It also revises Military Human Resources Records Procedures Topic 23 on international deployments, adds an operational administration course for HR administrators, and proposes a central CJOC pay office for Reservists deployed on Class C service [S22][H].
- **Records and privacy.** CAF personnel records are managed "in accordance with the Privacy Act and National Defence Security Orders and Directives"; PeRMIS is the electronic records system; records go to Library and Archives Canada after release [S18][H]. Protected B is the level whose compromise could cause "serious injury" to an individual [S24][H]. Treating by-name personnel and casualty records as at least Protected B is this research's reading, not a quoted rule (design).
- **Systems.** Monitor MASS and MCS applications [S22][H]; HRMS, a public service HR tool also used by military managers, upgraded from 8.9 to 9.2 in April 2026 [S23][M]; PeRMIS [S18][H]; DRMIS for finance (Part B).
- **Structure changes.** The 1st Canadian Division HQ was renamed the Canadian Joint Response Force HQ in August 2026, and Canada is aligning joint planning with NATO AJP-5 (files 03 and 05) [S42][M]. No public description of the CJOC J1 or CJRF HQ J1 organisation was found (gap).

### A10. J1 roles, owned products and handoffs

| Role (doctrine) | Owns | Hands to | Receives from |
|---|---|---|---|
| J1 director (human) | Approves personnel estimate, Annex E, JMD submissions; chairs JMD WG | Commander, COS, CCMD J1 | All J1 members |
| Personnel readiness (strength) | JPERSTAT or PERSTAT consolidation, strength vs authorised, personnel readiness picture | J3 (task organisation, combat power), J4, commander's SITREP | Service components, subordinate S1s |
| Human capital (manning) | JMD, JMD WG pack, augmentation requests, rotation policy options | Establishing CCMD J1, Joint Staff J-1 (via human) | Every staff section (billet needs), J8 (finance billets) [S3 XII-1] |
| Casualty planner | Casualty estimate (with surgeon), casualty reporting procedures, replacement plan | Surgeon, J4 (evacuation, mortuary affairs), J3 | Service components, J2 (threat), surgeon |
| Personnel services | Pay and entitlements policy (with J8), postal, MWR, awards, evaluations | J8 (entitlement costs), J4 (postal lift), PAO | Services, CCMD J1 |
| Civilians and contractors | Civilian and CAAF accountability policy, theatre admission requirements, JPPC procedures | J4 and OCS cell (contract terms), J3 | J4 (contract lists), SPOT exports |
| JPOC (current operations) | Personnel events log, personnel CCIR watch, SITREP personnel paragraph | J3 JOC | Component reports |

**Handoffs to other teams (design, aligned with files 02 to 05):** J2 gives threat and environment factors for paragraph 2 of the estimate; J3 gives task organisation and receives strength and casualty CCIR alerts; J4 receives casualty estimates for evacuation and mortuary affairs and gives contractor lists; J5 receives the personnel estimate at mission analysis and the COA supportability verdicts; J8 receives entitlement and billet cost drivers.

### A11. Personal data: labels, marks and a two-zone design

What the extension already does [S40][H]:
- A label is a level on a scale plus optional compartments and handling flags (`local-only`, `no-agent-tools`). Shipped scales include `org`, `ca-protected` and `nato`.
- Routing by default: `org/Public` any cloud; `org/Internal`, `org/Confidential`, `ca-protected/Protected A` attested NEAR private cloud only; `org/Restricted` and `ca-protected/Protected B` and C local-only.
- A chat's label rises with what any agent in it reads, helpers included. A file a labelled chat writes takes the chat's label. Only a human lowers a chat's label, with a recorded reason.
- Each chat message gets a privacy check: "personal data asks first".

Consequences for J1 (design):
1. **Two zones, two runs.** A **by-name zone** (rosters, casualty details, JMD with names, awards nominations, pay records) labelled `ca-protected/Protected B` or `org/Restricted`, with compartment `PERS` and handling `local-only`. A **aggregate zone** (strength counts, fill rates, casualty totals by formation, JMD by billet without names) labelled `ca-protected/Protected A` or `org/Confidential`. Because a chat's label rises when any helper reads a file, the by-name work must run as its own small team in its own chat, never as a member of the main J1 team. Otherwise the whole J1 team becomes local-only.
2. **Lowering is the human release step.** The by-name cell writes an aggregate file that inherits Protected B. A named human checks it and lowers it to the aggregate level with a reason, using the existing lower-label command. That is exactly where a human privacy check belongs, and it leaves a record.
3. **A local model is required for by-name work.** Protected B is local-only by default because no CCCS Medium assessment of NEAR AI Cloud was found [S40][H]. If no local model is set up, the by-name cell cannot run, and the work stays with humans. The template must say so up front.
4. **US equivalents.** DoD privacy rules are DoDI 5400.11 and the breach plan in DoDM 5400.11 Volume 2 [S36][M][S37][M]. Navy guidance marks PII as "CUI PRVCY" [S38][L]. The extension has no US CUI scale, so map US PII to `org/Restricted` with compartment `PRVCY` (design) and have the organisation's privacy officer confirm.
5. **No decisions about individuals.** People analytics in FM 4-1 is about unit strength and readiness [S5 para 4-40][H]. Canada's Directive on Automated Decision-Making applies to systems that make or support administrative decisions affecting a person's rights or interests, with human final decision at the highest impact level [S39][M]. Whether its current scope covers internal decisions about members was not confirmed [S39][L]. The J1 templates should simply never rank, score, select or predict anything about a named person (design).
6. **Small numbers re-identify people.** "One casualty in the battalion signals platoon" names a person to anyone in the unit. The privacy guard suppresses or rolls up small counts below a threshold the privacy officer sets (design).
7. **No web tools near personal data.** Members in the by-name cell get `Read`, `Write` and `Edit` only, no `WebSearch`, `WebFetch` or `Bash` (design).

### A12. J1 skills, tools and MCP

| Capability | Built from | Class | Notes |
|---|---|---|---|
| Personnel estimate, Annex E, Army Annex F Tab A, Canadian Annex R appendix and Annex Y skeletons | JP 1-0 App A and B, FM 5-0, CFJP 5.0 [S1][S6][S16] | Built in (product-side templates) | Profile switch: joint, Army, Canadian OPP, AJP-5 |
| JMD workbook | 14 JP 1-0 fields, 6 sourcing categories [S1][S3] | Built in | Billet view (aggregate zone) and by-name view (by-name cell only) |
| PERSTAT and JPERSTAT consolidator | Aggregate table schema; FM 6-99 PERSTAT format [S5] | Built in | Accepts manual tables for degraded mode; flags stale or conflicting rows |
| Casualty estimate calculator | Planning factors entered by a human from approved Service sources [S1 A-1] | Built in | Never ships rates; the Army medical planner's toolkit is a government tool [S6] |
| De-identifier and small-cell suppressor | Local script, run in the by-name cell | Built in, local-only | Writes aggregate candidate files for human lowering |
| Public strength statistics | FY25 Defense Manpower Profile Report [S34]; DND Departmental Results Report and GC InfoBase FTE data [S35] | Public | For exercise realism and sanity checks only |
| Army HR system of record (IPPS-A, SABIR) | Government | Partner integration | Out of scope in the unclassified product [S5] |
| Deployed accountability (DTAS, SPOT, JAMMS, JPARR) | Government, some on SIPRNET | Partner integration | Out of scope [S1][S5] |
| Casualty systems (DCIPS; Canadian CASREP to CFICC) | Government | Partner integration | Out of scope; never automate [S5][S17] |
| JMD system of record (FMTS, SIPRNET) | Government | Partner integration | Export and import of an unclassified JMD spreadsheet only [S1] |
| Canadian HR systems (Monitor MASS, MCS apps, HRMS, PeRMIS) | Government | Partner integration | Out of scope [S22][S23][S18] |
| Commercial HR information systems | Commercial vendors | Commercial, partner integration | Only through an organisation-approved connector, in the by-name zone |

Product-side MCP servers to build (design): `j1-templates` (estimate and annex skeletons by profile), `jmd` (billet register with validation checks), `perstat` (aggregate consolidation and trend), `deidentify` (local only, refuses to run on a cloud route).

### A13. Proposed J1 team

**Main team: `j1-personnel` (8 members), `privacy: private`.** Reads only aggregate-zone files.

| # | Name | Role | Tier | Tools | Instructions in brief |
|---|---|---|---|---|---|
| Lead | `j1-lead` | J1 lead: personnel estimate and Annex E integrator | deep | Read, Glob, Grep, Write, Edit, Remember, Recall, CreateDocument | Run the team to the commander's guidance and the planning timeline. Write the personnel estimate in the JP 1-0 Appendix A format and the personnel annex for the chosen profile. Conclude whether the mission is supportable and which COA is best supported, and list deficiencies with recommendations. **Never approve, decide or release.** Mark every decision "for the J1 and commander". Hand back: estimate file, annex draft, open decisions list. |
| 1 | `strength-analyst` | Personnel readiness: strength and JPERSTAT | standard | Read, Write (own files), `perstat` | Consolidate component strength reports into a JPERSTAT or PERSTAT table. Compare to authorised strength. Flag gaps, stale reports and conflicts; do not fill them in. Work on aggregates only; refuse any file with names or service numbers. Hand back: strength table, trend notes, flags. |
| 2 | `manning-officer` | Human capital: JMD and augmentation | standard | Read, Write (own files), `jmd` | Build and maintain the JMD by billet with the 14 JP 1-0 fields and a sourcing category per billet. Run the Appendix C checklist on every billet. Prepare the JMD working group pack and augmentation request drafts. JIA is the last resort and never for permanent or exercise billets. Hand back: JMD workbook, change requests, checklist results. |
| 3 | `casualty-planner` | Casualty estimate, reporting procedures and replacements | deep | Read, Write (own files), casualty calculator | Build the casualty estimate per COA from planning factors the human supplies, with the surgeon team's input. Draft casualty reporting procedures and the replacement plan. Never use real names, never include medical detail, never draft any family notification or media statement. Hand back: casualty estimate by COA, procedures appendix, replacement flow. |
| 4 | `personnel-services-planner` | Pay and entitlements policy, postal, MWR, awards, evaluations, language needs | standard | Read, Write (own files) | Draft entitlement policy options for equity and timeliness and pass costs to the J8 team. Draft postal, MWR and awards guidance. Note who holds each approval authority. Hand back: services appendix, entitlement requests for human submission. |
| 5 | `civilian-contractor-planner` | DoD and DND civilians, contractors, JPPC and personnel visibility | standard | Read, Write (own files) | Draft civilian and contractor accountability policy, theatre admission requirements and JPPC procedures. Coordinate contract terms with the J4 OCS member; do not write contract requirements. Hand back: visibility policy, admission checklist. |
| 6 | `jpoc-watch` | Joint personnel operations center watch (execution) | fast | Read, Write (append to log), Grep | Watch incoming aggregate reports against the personnel CCIR list. Log facts, flag matches to the lead and to the J3 JOC at once. Draft the personnel paragraph of the SITREP. Do not interpret beyond the reports. |
| 7 | `privacy-guard` | Privacy and release guard | fast | Read, Grep | Check every outgoing J1 product. Block names, service numbers, SIN or SSN, dates of birth, medical details, home addresses, next of kin, small counts below the set threshold, missing labels, and any decision not routed to a named human. Return the reason. |

**By-name cell: `j1-by-name-cell` (2 members), separate team, run in its own chat, labelled Protected B or org Restricted, local model only.**

| # | Name | Role | Tier | Tools | Instructions in brief |
|---|---|---|---|---|---|
| Lead | `roster-steward` | By-name reconciliation and de-identification | fast (local) | Read, Edit, Write, `deidentify` | Reconcile rosters, JMD fills and arrivals by name. Produce aggregate tables with small-cell suppression. Write them as candidate files for a human to check and lower. No web tools, no shell. Never copy a name into an aggregate file. |
| 1 | `privacy-guard` | Same guard, inside the cell | fast (local) | Read, Grep | Check every candidate aggregate before the human sees it. |

Sample frontmatter (design):

```markdown
---
name: J1 by-name cell
description: Local-only by-name personnel reconciliation. Writes aggregates for a human to check and lower.
privacy: private
---
```

**Parallel lanes.** Strength, manning, casualty, services and civilian-contractor members work in parallel on separate files. The lead integrates. The guard sits in series only on the release path. The by-name cell runs on its own schedule (for example before each daily report) and feeds the main team only through human-lowered files.

### A14. J1 mapping to JPP, MDMP and OPP, and to execution

| JPP step [S4] / MDMP [S6] / CF OPP stage [S16] | J1 team activity | Parallel with |
|---|---|---|
| 1 Planning initiation / Receipt of mission / Initiation | Lead opens the personnel estimate. Manning starts a draft JMD from the HQ template. Strength pulls the current picture. | J2, J3, J4, J5, J8 start their estimates |
| 2 Mission analysis / Mission analysis / Orientation | Personnel facts, assumptions and limitations; personnel decision criteria; initial casualty planning factors requested; JMD by mission tasks (the JMD WG works "in support of the J-3- or J-5-led mission analysis") [S3 V-4][H] | All J1 members |
| 3 COA development / COA development / COA development (with staff analyses) | Personnel supportability of each COA: manning, rotation, replacement and special skills | J4 and J8 supportability checks |
| 4 COA analysis (wargame) | Casualty estimate per COA, replacement flow, strength trend through the phases; J1 notes for the sync matrix | J4 evacuation, surgeon |
| 5 COA comparison | Score COAs on the J1 criteria (estimate paragraph 4) | Every team scores its own criteria |
| 6 COA approval | Lead's paragraph 5 conclusions feed the decision brief. **The commander decides.** | None (decision gate) |
| 7 Plan or order development / Orders production / Plan development | Annex E (joint) or Annex F Tab A (Army) or Annex R personnel appendix and Annex Y (Canada); JMD submitted by the human J1 | J8 finance appendix, J4 Annex D or F |
| Execution / Plan review | Daily JPERSTAT; casualty reporting procedures in force; JMD WG cycle; replacement tracking; personnel inputs to the assessment working group | J3 JOC, J8 status of funds |

### A15. What scales by level (J1)

| Aspect | Strategic (Joint Staff J-1, CCMD J1; CMP and CJOC J1) | Operational (JTF J1; CJRF HQ or JTF J1) | Tactical (division or corps G1, brigade and battalion S1; Canadian unit orderly room) |
|---|---|---|---|
| Focus | Joint manpower programme (JTD, JTMD), JIA validation, theatre policy, global force management inputs [S1 II-5, C-1] | JMD, JPERSTAT, Annex E, casualty and replacement plans [S1][S3] | PASR, daily duty status, EPS, casualty reports from the point of injury [S5] |
| Products | Policy, theatre visibility rules, JMD validation | Estimate, annex, JMD, JPERSTAT | PERSTAT, personnel part of Annex F, running estimate |
| Data | Aggregates only | Aggregates, plus a by-name cell for JMD fills | Mostly by-name; the agent team should be small and mostly in the by-name zone, or not used |
| Team | Main team without `jpoc-watch`; add a policy writer if needed | Full main team plus by-name cell | Lead, strength, casualty, guard, plus the by-name cell (about 4 plus 2) |
| Human counterpart | Director J-1, CCMD J1 | JTF J1 | G1 or S1, HR NCOs; Canadian HR administrators [S22] |

### A16. J1 pitfalls

1. **Putting by-name data in the main team.** One helper read raises the whole chat to local-only, and only a human can lower it [S40]. Keep the by-name cell separate.
2. **Citing FM 1-0.** It was superseded by FM 4-1 on 15 September 2025 [S5].
3. **Wrong annex letters.** Joint Annex E is Personnel [S1]; Army Annex E is Protection and personnel lives in Annex F Appendix 2 Tab A [S6]; the Canadian 2008 list uses Annex R (personnel services appendix) and Annex Y (casualty estimation) [S16]. Use a doctrine profile.
4. **Medical detail or premature disclosure in casualty products.** Forbidden in Canadian CASREPs and warned against in FM 4-1 [S17][S5]. The guard blocks medical terms; no agent drafts notifications or media lines.
5. **Duplicating Service accountability.** The J1 consolidates; the Services account [S1 II-6, II-9]. An agent must not "correct" component numbers, only flag them.
6. **No degraded mode.** Doctrine expects manual PERSTATs when systems are down [S5 para 3-6]. A template that only reads system exports fails exactly when it matters.
7. **Assuming the J1 decides.** Awards authority sits with Service Secretaries [S1 II-9]; imminent danger pay needs PDUSD(P&R) approval [S1 II-7]; JMD changes need Joint Staff J-1 validation [S1 III-3].
8. **Misusing JIA.** Not for permanent shortfalls or exercises [S3 V-4].
9. **Small-cell re-identification and profiling** (A11 points 5 and 6).
10. **Casualty planning factors invented by a model.** Rates come from approved Service sources entered by a human [S1 A-1].
11. **LSCO scale.** Doctrine warns casualty volumes can overwhelm reporting [S5 para 3-28][S9]. The casualty planner must show the surge load, not only the average.

---

## Part B: J8 Force Structure, Resources and Assessment

### B1. Doctrine baseline

| Publication | What the template takes from it |
|---|---|
| JP 3-80 (2016, validated 2018) [S2][H] | Financial management (FM) = resource management (RM) plus finance support; comptroller roles; essential elements of RM; fiscal controls; funding authorities; JRRB; comptroller checklist |
| JP 3-33 (2018) [S3][H] | Optional JTF J8, its scope, its responsibilities, assessment role decided by the CJTF and COS |
| JP 5-0 (2020) [S4][H] | J8 focus on resource changes; assessment ownership options; Joint Staff J-8 global force management work |
| CJCSI 5123.01J (2026) [S12][H] and the 7 November 2025 reform memo [S14][H] | Strategic J8: JROC, JFRP, IPLs, Joint Operational Problems, end of JCIDS |
| Joint Staff J8 page [S11][H]; AFRICOM J8 page (2017) [S13][H] | Strategic and combatant command J8 mission statements |
| FM 1-06 (2011) [S7][H]; FM 5-0 (2024) [S6][H] | Army G-8 and S-8 duties, Annex F Appendix 2 Tab B |
| CFJP 3.0 (2010) [S15][H]; CFJP 5.0 (2008) [S16][H] | Canadian JTF J8; finance as a planning factor; Annex FF |
| DND Financial Administration Manual, TBS delegation directive, DND audits [S25 to S29][M] | FAA sections 32, 33, 34; DRMIS |

### B2. Three different jobs called "J8"

| Level | Name and mission | Main outputs |
|---|---|---|
| Joint Staff | Force Structure, Resources and Assessment Directorate. "Charged with providing support to CJCS for evaluating and developing force structure requirements"; runs war games and politico-military seminars; maintains models and analysis capabilities; Director J-8 is JROC Secretary and Joint Capabilities Board chair [S11][H] | JROC and JCB support, JFRP management, capability analysis [S12 Encl C][H]; Forces For assignment tables and apportionment tables, and leads the Joint Force Sufficiency Assessment (JFSA) [S4 D-3, D-4][H] |
| Combatant command | For example AFRICOM "J8 Resources and Assessments": "plans, programs, budgets, and executes fiscal resources"; "manages the headquarters' resourcing and requirements processes; allocates and executes funding; facilitates technological development; and provides critical analysis" [S13][H] | IPLs and capability gap submissions [S12 Encl C][H]; budget execution; command assessment support. The command comptroller may instead sit as its own directorate, inside the J4, or as special staff [S2 II-1][H] |
| JTF | Resource management and financial support directorate, optional. "The J-8 could simply focus on comptroller requirements for the JTF and have no assessment responsibilities" [S3 XII-1][H]. If there is no J8, the comptroller is personal or special staff [S2 II-2][H][S3 XII-1][H] | Finance and RM guidance, cost estimates, funding sources, status of funds, internal controls, JRRB support [S2][S3] |
| Army (tactical) | G-8, "assistant chief of staff, financial management" [S5 glossary][H]; S-8, "battalion or brigade financial management officer" [S6 para 5-158][H] | Funding guidance in OPORDs and FRAGOs, spend plans, status of funds, managers' internal control programme [S7 para 1-97][H] |
| Canada | JTF J8 "Financial and comptrollership": advises the commander and staff "on all financial aspects" and liaises with other government departments, NGOs and host nation authorities on in-theatre financial matters [S15 para 0417c(8)][H]. CJOC has a J8 [S30][L][S31][L]; deployed task forces have had a Task Force Comptroller, for example on Operation ATHENA [S32][L] | Finance planning factor, Annex FF, commitment control under FAA s.32 |

**Template consequence (design):** one J8 template with three profiles: `strategic` (force structure and requirements), `operational` (JTF comptroller and RM), and `tactical` (G-8 or S-8). Assessment is an optional seat in all three.

### B3. Resource management and finance support in operations

- **Two core competencies.** JP 3-80 "Clarifies the two core competencies of financial management as resource management and finance support" [S2 summary][H].
- **Ten essential elements of RM.** Financial advice to the commander; developing command resource requirements; identifying funding sources; determining costs; acquiring funds; distributing and controlling funds; tracking costs and obligations; capturing costs; reimbursement; accounting and fiscal validation, internal controls, assistance visits and accounting support [S2 III-1][H][S3 XII-3][H]. Each becomes a checklist line in the J8 lead's instructions.
- **Fiscal controls.** Obligations only by authorised individuals with proper authorization (for example an execute order), only after an appropriation or continuing resolution, and within purpose, time and amount [S2 I-3][H]. ADA concerns "are more pronounced when substantial contingencies occur in the third or fourth quarter" [S2 I-3][H]. The RM policy section must ensure no violations of 31 USC 1517, 1301 and 1341 [S2 II-4][H].
- **Comptroller organisation in a JTF.** RM policy section (staff estimate, finance appendix, economic analysis, DFAS liaison, internal controls), RM budget section (sources of funds, cost estimates, fund control and tracking), finance policy section (pay entitlement policy with the J1, disbursing policy, local procurement with the J4), finance funding section (host nation banking, currency for procurement) [S2 II-4 to II-5][H].
- **JTF J8 responsibilities (JP 3-33).** Principal FM adviser; single point of contact; set JTF FM responsibilities and lead agents; review estimated and actual costs; internal controls; a process such as a JRRB or JFUB for acquisition requirements; entitlement policy through the J1; logistics and contracting coordination with the J4; funding sources and obligation authority; funding availability for local contracts; early deployment of finance personnel; a limited depository account if needed [S3 XII-2 to XII-3][H]. The J8 also states its own billet needs to the J1 and requests extra capabilities via the J3 [S3 XII-1][H].
- **Boards.** The comptroller is an advisory, non-voting member of the joint requirements review board, which controls "mission critical, high-dollar contract requests" and checks that military, multinational and host nation support were considered before buying commercially [S2 II-2 to II-3][H].
- **Costing.** Unplanned contingency costs are first absorbed from existing funds; Service component resource managers separate incremental and total costs and report to DFAS and OUSD(C) [S3 XII-4][H]. JP 3-80 warns that "misuse of terminology (e.g., confusing incremental and offset costs) can lead to an inaccurate cost estimate" [S2 III-4][H]. Component commanders report monthly incremental costs to DFAS, OUSD(C) and the J-8 [S2 II-5][H].
- **Funding authorities.** JP 3-80 Appendix E covers appropriations and authorities including ACSA (10 USC 2341 to 2350) and CERP, and notes that "FMS and ACSA are the only authorities available to DOD to lease defense articles and services" [S2 App E][H]. Legal review is required: the comptroller works "with the legal advisor" to comply with 31 USC 1301 [S3 XII-4][H][S2 App D][H].

### B4. Where the money annex lives (crosswalk)

| Profile | Location of FM in the plan | Writer | Source |
|---|---|---|---|
| Joint (JP 3-80) | Appendix 3 (Finance and Disbursing) to Annex E (Personnel) | CCMD comptroller or joint force comptroller | [S2 I-4, II-2, II-3][H] |
| Joint JTF (JP 3-33) | Paragraph 4 (Administration and Logistics) of the base plan for Annex W (Operational Contract Support), with a financial management appendix | JTF J8 or comptroller | [S3 XII-2, XII-4][H] |
| Army | Tab B (Financial Management) to Appendix 2 (Personnel Services Support) to Annex F (Sustainment); base order paragraph 4d | G-8 or S-8 | [S6][H] |
| Canada (CFJP 5.0, 2008) | Annex FF Financial Support: appendices for funding, contracting, cashier services, local labour, host nation and mutual support arrangements, non-public fund accounting; base plan paragraph 4g "Financial Support Services" | J8 | [S16 5E-3, 5E1-3][H] |
| NATO AJP-5 (Canadian target) | Not confirmed in this research | | Gap; see file 05 |

The two joint publications disagree. Until a newer JP 3-33 or JP 3-80 is read, the template should write the FM appendix once and let the profile decide where it attaches (design).

### B5. Operation assessment and the J8

- JP 5-0 treats changes in "funding, forces, and time available" as "typically a ... J-8 focus", alongside J2-focused environment changes [S4 VI-2][H].
- The strategic assessment working group lead is "typically from a J-3, J-5, or J-8 element" [S4 VI-5][H]. The commander or COS should pick one director or staff entity to own the collective assessment, placed in a special staff section, a separate staff section, or inside operations or plans, each with stated trade-offs [S4 VI-11][H].
- In a JTF "the CJTF and COS will determine the scope of the J-8's role in the assessment process" [S3 XII-1][H]. The comptroller also assesses the effectiveness of RM itself and records lessons learned [S2 III-1][H].
- Assessment in personnel and resource terms asks whether allocated resources are effective and whether a change in resources is required [S1 III-9][H].
- **Template use (design):** the J8 `assessment-analyst` seat is off by default. When the commander assigns assessment to the J8, it is switched on and the J3 and J5 assessment members (files 03 and 05) become contributors that feed it, not parallel owners. Always one owner per assessment product.

### B6. Strategic J8: requirements and force structure

- **The reform.** A 7 November 2025 memorandum from the Office of the Secretary of War directed the VCJCS to "commence the disestablishment of JCIDS", stop JROC validation of component requirements, re-orient the JROC to rank "Joint Force Key Operational Problems", and set up a Requirements and Resourcing Alignment Board with CAPE [S14][H].
- **The new charter.** CJCSI 5123.01J (15 January 2026) introduces the JFRP, which "replaces the JCIDS in its entirety"; Service and component requirement validation now belongs to the Services and components [S12 para 1][H]. The Director J-8 chairs the JCB, is JROC Secretary, runs two functional capabilities boards, manages the JFRP and provides requirements, acquisition and resourcing expertise [S12 Encl C][H].
- **Combatant commands** advise the JROC on their requirements, "Identify, prioritize, and submit capability gaps via IPLs", submit joint urgent and emergent needs, and give operational feedback on joint capabilities [S12 Encl C][H].
- **Naming.** Recent official documents use "Department of War" and "DoW" alongside DoD terms [S12][S14][H]. Templates should accept both names.
- **Template use (design):** the strategic profile adds a `force-structure-analyst` that drafts IPL entries, gap statements framed as Joint Operational Problems, and JFSA-style sufficiency notes from unclassified, notional inputs. It does not touch programme or budget figures that are not public.

### B7. US Army G-8 and S-8

- In 2008 the Army merged Finance and Comptroller into one branch, combining RM and finance operations; "The individual with singular responsibility for FM at the theater Army, corps, and division level is the G-8" [S7 intro][H].
- The division G-8 is staff proponent for all FM in the division area, and if the division is a JTF HQ, "singularly responsible for all FM within the JTF AOR". It provides budget estimates, conducts FM planning with contracting, the fiscal lawyer and the sustainment cell, distributes and controls funds, reports status of funds, estimates and reports costs, issues fiscal guidance through OPORDs and FRAGOs, sets funded levels per brigade, and runs the managers' internal control programme [S7 para 1-96, 1-97][H].
- A brigade combat team "requires an FM capability" to issue FM guidance, submit funding requirements, report status of funds, manage requirement packets for boards, coordinate field ordering officers and pay agents, manage the purchase card programme and coordinate internal controls [S7 para 1-117][H]. GFEBS supports FM "at the lowest level" [S7 para 1-118][H].
- In COA analysis the G-8 or S-8 "assesses the commander's assigned area to determine the best use of resources for each COA", covering finance support and resource management, and special funding needs [S6 para 5-158][H]. Base order paragraph 4d names special programmes such as CERP, the DoD Small Rewards Program and train and equip programmes [S6][H].

### B8. Canadian J8: finance and comptrollership in a JTF

- **Definition.** Financial and comptrollership (J8) is one of the nine JTF joint staff divisions [S15 para 0417c(8)][H].
- **Planning.** Finance is a planning factor: "The source of operational funding, foreign currency requirements and financial aspects of mutual support arrangements in coalition. NATO or UN operations can be critical factors" [S16 para 303z][H]. COA feasibility asks whether "sufficient resources" are available and acceptability weighs "estimated costs" [S16 5E-2][H].
- **Annex FF** (see B4) [S16][H].
- **Delegated authorities.** Section 32 is the authority to confirm a "sufficient free balance" before a contract [S27][M]; section 34 certifies "contract performance and price, entitlement or eligibility for the payment" [S28][M]; only people designated in A-FN-100-002/AG-006 may exercise them, with limits set by position in a delegation matrix [S27][M]; no one exercises both section 33 and 34 for the same payment [S29][M] (archived TBS directive; confirm against the current one).
- **Systems.** DRMIS, built on SAP, is DND's system of record for departmental transactions and is being modernised [S25][M]. An Army audit found delegation forms stored in DRMIS but "no automated controls restricting authorities based on those forms" [S26][M]. The template must not assume the system enforces delegations.
- **Organisation.** CJOC has a J8 (a Deputy J8 is named in a public biography [S30][L]; a 2026 DND award cites "Canadian Joint Operations Command J8 operations and financial stewardship" [S31][L]); deployed operations have used a Task Force Comptroller [S32][L]; JTF Central had a comptroller branch [S31][L]. No public CJOC J8 organisation chart was found (gap).

### B9. J8 roles, owned products and handoffs

| Role | Owns | Hands to | Receives from |
|---|---|---|---|
| J8 or comptroller (human) | FM guidance, funding decisions within delegation, board votes as advisory member | Commander, CCMD comptroller | J8 team |
| Cost estimator | Cost estimate per COA and per phase, incremental vs offset split, cost capture structure | J5 (COA comparison), commander | J4 (requirements, contracts), J1 (entitlement drivers), J3 (forces and timeline) |
| Funding authorities analyst | Candidate funding source per requirement, purpose-time-amount screen | SJA or JAG (legal review), J8 human | J4, J9 (civil projects), J5 |
| Requirements board coordinator | JRRB or JFUB packets, alternative-source check | Board chair (human), J4 OCS | Requesting staff sections |
| Funds execution tracker | Status of funds, commitments, obligations, burn rate, cost reports | CCMD comptroller (via human), commander | Accounting exports |
| Finance support planner | Disbursing, currency, LDA, pay agents and field ordering officers, host nation banking; Canadian cashier services | J4, J1 (pay), components | Components, DFAS or DND finance |
| Controls reviewer | Internal control checklist, separation of duties, audit trail | Inspector general (via human), J8 human | All J8 products |
| Assessment analyst (optional) | Assessment framework and reports when assigned | Commander's assessment board | J2, J3, J5 inputs |
| Force structure analyst (strategic) | IPL drafts, gap statements, sufficiency notes | JROC process (via humans) | J5 strategy, J3 operations |

**Handoffs to other teams (design):** J4 gives logistics and contract requirements and receives funding availability; J1 gives entitlement and billet cost drivers and receives entitlement funding checks; J5 receives cost per COA at COA comparison; J3 receives resource constraints and assessment results; J9 or civil affairs gives civil project requirements (CERP-like); legal review is a human seat outside the team.

### B10. J8 skills, tools and MCP

| Capability | Built from | Class | Notes |
|---|---|---|---|
| Cost model workbook | Cost factors entered by a human; incremental and total columns | Built in | Never ships real cost factors |
| Funding authority screen | Purpose, time, amount checklist from JP 3-80 [S2]; Canadian FAA s.32 free balance check [S27] | Built in | Output always says "legal review required" |
| Status of funds tracker | Spreadsheet or CSV exports | Built in | Burn rate, thresholds, Q3 and Q4 warnings [S2 I-3] |
| Board packet builder | JRRB packet fields [S2 II-2] | Built in | Shares the contract requirement list with the J4 team |
| Internal control checklist | JP 3-80 Appendix B comptroller checklist [S2] | Built in | Separation of duties check for Canadian s.33 and s.34 [S29] |
| Assessment register | MOE and MOP register shared with J3 and J5 teams | Built in | Single owner rule (B5) |
| US public spending data | USAspending API; endpoints need no authorization [S33] | Public | Exercise realism, contract history research |
| Canadian public spending data | GC InfoBase and departmental results data [S35] | Public | Same use |
| US accounting systems (GFEBS, GAFS, SABRS and others) | Government [S2 App J][S7] | Partner integration | Out of scope |
| DRMIS (SAP) | Government [S25] | Partner integration | Out of scope |
| Spreadsheet and BI tools | Commercial or open source | Commercial or public | Local files only |

Product-side MCP servers to build (design): `fm-templates` (FM appendix by profile), `cost-model`, `funds-status`, `board-packets`. All write only to the J8 folder and carry the folder's label.

**Labels for J8 data (design):** budget execution and cost estimates `org/Confidential` (attested cloud); contract and vendor data `org/Restricted` if procurement-sensitive (local-only); pay data per person goes to the J1 by-name cell, never to the J8 team.

### B11. Proposed J8 team

**`j8-resources`, `privacy: private`. 9 members at strategic level, 8 at operational, 5 at tactical (see B13).**

| # | Name | Role | Tier | Tools | Instructions in brief |
|---|---|---|---|---|---|
| Lead | `j8-lead` | J8 lead: resource estimate and FM guidance | deep | Read, Glob, Grep, Write, Edit, Remember, Recall, CreateDocument | Integrate the team. Write the resource part of the staff estimate: costs per COA, funding risks, recommendations. Draft FM guidance and the FM appendix for the profile. **Never commit, obligate, certify or approve funds, and never vote on a board.** Every money action is "for the comptroller or delegated authority". Hand back: estimate, appendix, decisions list. |
| 1 | `cost-estimator` | Cost estimates | standard | Read, Write (own files), `cost-model` | Build incremental and total cost estimates per COA and phase from human-supplied factors. Never mix incremental and offset costs. State every assumption. Hand back: cost table with assumptions. |
| 2 | `funding-authorities-analyst` | Funding sources and fiscal law screen | deep | Read, Write (own files), WebSearch, WebFetch (public law and regulation only) | For each requirement, list candidate funding sources and authorities and test purpose, time and amount. Mark every result "candidate; legal review required by SJA or JAG". Never state that a use of funds is legal. |
| 3 | `requirements-board-coordinator` | JRRB or JFUB packets | standard | Read, Write (own files), `board-packets` | Build packets, confirm military, multinational and host nation alternatives were checked first, and track board decisions as recorded by humans. Coordinate with the J4 OCS member. |
| 4 | `funds-execution-tracker` | Status of funds | fast | Read, Write (own files), `funds-status` | Load exports, compute commitments, obligations, expenditures and burn rate against the spend plan. Flag thresholds and fiscal-year-end risk. Report facts only. |
| 5 | `finance-support-planner` | Disbursing, currency, banking, pay agents | standard | Read, Write (own files) | Plan finance support: disbursing points, currency needs, limited depository account requests, pay agent and field ordering officer coverage, host nation banking; Canadian cashier services. Coordinate pay entitlement with the J1 team. |
| 6 | `controls-reviewer` | Internal controls and release guard | fast | Read, Grep | Check every J8 product: separation of duties, audit trail, no claim that an agent certified or obligated funds, no real account numbers or vendor banking details, labels present. Block with a reason. |
| 7 | `assessment-analyst` | Assessment (optional, off by default) | deep | Read, Write (own files), assessment register | Only when the commander assigns assessment to the J8. Own the assessment framework and reports; take J3 and J5 inputs; separate data from judgement. When off, remove this member. |
| 8 | `force-structure-analyst` | Force structure and requirements (strategic profile only) | deep | Read, Write (own files), WebSearch, WebFetch | Draft IPL entries and capability gap statements framed as Joint Operational Problems, and sufficiency notes, from notional or public inputs. Never use non-public programme data. |

**Parallel lanes.** Cost, funding authorities, board packets, execution tracking and finance support run in parallel. The controls reviewer is in series on release. Assessment runs on the assessment cycle.

### B12. J8 mapping to JPP, MDMP and OPP, and to execution

| JPP step [S4] / MDMP [S6] / CF OPP stage [S16] | J8 team activity | Parallel with |
|---|---|---|
| 1 Initiation | Lead opens the resource estimate; finance support planner checks early deployment of finance personnel [S2 II-3] | All teams |
| 2 Mission analysis / Orientation | Resource facts, assumptions and constraints; known funding sources; rough cost order of magnitude; J8 billet needs to J1 [S3 XII-1]; assessment seat, if on, drafts the assessment approach | J1 estimate, J4 estimate |
| 3 COA development | Funding feasibility per COA (CFJP 5.0 feasibility and acceptability tests [S16 5E-2]) | J4 supportability |
| 4 COA analysis | Cost per COA and phase; funding risks into the wargame record | J4 consumption, J1 casualties |
| 5 COA comparison | Cost and funding criteria scored | All teams |
| 6 COA approval | Lead's cost summary in the decision brief. **Commander decides.** | Decision gate |
| 7 Plan or order development | FM appendix by profile (B4); FM guidance; internal control plan | J4 Annex D or F or W; J1 Annex E |
| Execution / Plan review | Status of funds cycle; board packets; cost capture and reporting; internal control checks; assessment cycle if assigned; resource-change triggers to J3 and J5 [S4 VI-2] | J3 JOC, J4 JLOC, J1 JPOC |

### B13. What scales by level (J8)

| Aspect | Strategic (Joint Staff J-8, CCMD J8; DND CFO and CJOC J8) | Operational (JTF J8 or comptroller; Canadian JTF J8) | Tactical (division G-8, brigade or battalion S-8) |
|---|---|---|---|
| Focus | Requirements (JFRP, IPLs), force sufficiency, programme and budget advocacy, command budget execution [S11][S12][S13] | Funding the operation: sources, costs, controls, boards, finance support [S2][S3] | Spend plans, funded levels per unit, status of funds, purchase card and pay agents [S7] |
| Assessment | Campaign and sufficiency assessment, often J8-led [S4 D-4, VI-5][S13] | Only if the CJTF assigns it [S3 XII-1] | Rarely; G-5 or G-3 usually leads (Army Annex M) (see file 05) |
| Team | All 9 (assessment seat as assigned) | 8 (no force structure analyst) | 5: lead, cost estimator, funds tracker, finance support planner, controls reviewer |
| Human counterpart | Director J-8, CCMD J8 or comptroller | JTF J8 or comptroller | G-8, S-8 |

### B14. J8 pitfalls

1. **An agent that looks like it spent money.** Obligation needs authorised people and proper authorization [S2 I-3]; Canadian s.32, 33 and 34 need delegated people [S27][S28]. The words "approved", "certified", "obligated" and "committed" are blocked from agent output unless quoting a human record.
2. **Fiscal law advice without a lawyer.** Purpose statute and funding authority choices need the legal adviser [S3 XII-4][S2 App D].
3. **Incremental and offset costs confused** [S2 III-4].
4. **Wrong annex placement**, because the joint publications disagree [S2][S3] (B4).
5. **Three assessment owners.** One owner per product, set by the commander [S4 VI-11][S3 XII-1] (B5).
6. **JCIDS language in a 2026 strategic template.** Use JFRP, JOPs and IPLs [S12][S14]. The official J8 page still shows JCIDS [S11].
7. **Fiscal-year-end blind spot.** Contingencies late in the year raise ADA risk [S2 I-3]; the tracker should warn.
8. **Assuming the system enforces delegation.** DRMIS did not, per audit [S26].
9. **Real banking, vendor or contract data in an unclassified demo.** Use notional vendors and amounts.
10. **No J8 in the JTF.** Then the comptroller is special staff [S3 XII-1]; the template needs a "comptroller only" profile with the same members.

---

## Part C: Cross-team contract, state machines and guardrails

**Shared artifacts (design, consistent with file 03 Part C):**

| Artifact | Writer | Readers |
|---|---|---|
| Personnel estimate | J1 lead | J5, J3, J4, J8 |
| JMD (billet view) | J1 manning officer | All staff teams (billet needs in), J8 (finance billets) |
| JPERSTAT or PERSTAT (aggregate) | J1 strength analyst | J3 JOC, commander's SITREP |
| Casualty estimate | J1 casualty planner | J4, surgeon, J5 |
| Resource estimate and cost per COA | J8 lead and cost estimator | J5, commander |
| Funding availability per requirement | J8 funding analyst (candidate only) | J4, J9 |
| Assessment register | Single owner set by commander (J3, J5 or J8) | All |

**Implicit state machines to build and test (design).** Every transition marked "human" can only be taken by a named person; the agent can only propose it.

1. **Product release** (all teams): draft, checked by guard, awaiting decision, approved or rejected (human), released. Same as file 03.
2. **JMD billet:** proposed, checked against the Appendix C list, endorsed by the JMD WG (human), validated (human, Joint Staff J-1 or establishing J1), sourced, filled (by-name cell only), arrived, departed, closed. Stuck-state risk: "validated" with no sourcing for weeks; the manning officer flags it.
3. **By-name to aggregate file:** written in the by-name cell (Protected B), checked by guard, lowered by a human with a reason, read by the main J1 team. A file that is never lowered never reaches the main team; that is the intended safe default.
4. **Casualty report support:** event logged by the JPOC watch (aggregate fact only), CCIR flagged to J3 and the human J1, report handled entirely by humans in the system of record, closed in the log when a human records closure. The agent never holds the open report.
5. **Funding request:** requirement received, candidate source identified, legal review requested, legal review returned (human), board decision recorded (human), funds committed (human, delegated), obligated (human), expended, reconciled. The tracker flags any request that has waited longer than a set time in one state.

**Human decision authority.** Commanders approve COAs and plans [S4]; Service Secretaries approve many awards [S1 II-9]; PDUSD(P&R) approves imminent danger pay [S1 II-7]; Joint Staff J-1 validates JMD changes [S1 III-3]; COs notify next of kin with a chaplain [S17]; delegated officers commit and certify funds [S2 I-3][S27][S28]; boards approve contracts [S2 II-2].

**Unclassified by design.** Notional people, units, amounts and vendors only. No connection to any government system listed as partner integration. No restricted doctrine text. The guards block real identifiers.

---

## Gaps and open questions

1. **Canadian personnel doctrine text.** B-GL-005-100/FP-001 was not found online, and the "CFJP 1-0" title is unconfirmed [S20][S21].
2. **CJOC and CJRF HQ J1 and J8 organisation.** No public charts. Do not invent branch names.
3. **Canadian tactical finance.** No public doctrine on brigade or unit comptrollers was found.
4. **NATO AJP-5 profile.** Where AJP-5 and the NATO annex list place personnel and finance was not checked. Cross-link with file 05.
5. **Newer JP 3-33 (reported June 2022) and FM 1-06 (2014)** were not read; the annex placement conflict in B4 may be resolved there.
6. **CJCSM 3130.03 Annex E format and CJCSM 3150.13 JPERSTAT format** were not read; confirm they are public before quoting.
7. **Canada's Directive on Automated Decision-Making scope after the June 2025 review** for internal decisions about members [S39].
8. **Whether J1 data counts as Protected B** is this research's reading of the Protected B definition [S24]; the organisation's security officer must confirm, as SECURITY.md already advises for the scales [S40].

---

## Sources

| # | Title | Publisher | Date | URL | Confidence |
|---|---|---|---|---|---|
| S1 | JP 1-0, Joint Personnel Support | Joint Chiefs of Staff (public copy; read via Internet Archive) | 1 Dec 2020 | https://irp.fas.org/doddir/dod/jp1_0.pdf | H (full text read) |
| S2 | JP 3-80, Resource Management | Joint Chiefs of Staff (public copy; read via Internet Archive) | 11 Jan 2016, validated 10 Jan 2018 | https://irp.fas.org/doddir/dod/jp3_80.pdf | H (full text read) |
| S3 | JP 3-33, Joint Task Force Headquarters | Joint Chiefs of Staff (DoD IG copy) | 31 Jan 2018 | https://www.dodig.mil/Portals/48/JP%203-33%20Joint%20Task%20Force%20Headquarters.pdf | H (chapters V, XII read) |
| S4 | JP 5-0, Joint Planning | Joint Chiefs of Staff | 1 Dec 2020 | https://www.jcs.mil/doctrine/joint-doctrine-pubs/5-0-planning-series | H (chapter VI, appendix D read) |
| S5 | FM 4-1, Human Resources Support | HQ, Department of the Army | 15 Sep 2025 | https://armypubs.army.mil/epubs/DR_pubs/DR_a/ARN44932-FM_4-1-000-WEB-1.pdf | H (read) |
| S6 | FM 5-0, Planning and Orders Production | HQ, Department of the Army | Nov 2024 | https://www.dvidshub.net/publication/issues/76328 | H (paras 5-156 to 5-159, annex formats read) |
| S7 | FM 1-06, Financial Management Operations | HQ, Department of the Army (public copy; read via Internet Archive) | 4 Apr 2011 | https://irp.fas.org/doddir/army/fm1-06.pdf | H (chapter 1 read) |
| S8 | FM 1-06, Financial Management Operations (2014 edition, library copy) | US Army War College library | Apr 2014 | https://dml.armywarcollege.edu/wp-content/uploads/2024/09/Army-FM-1-06-Financial-Mgmt-Ops-2014.pdf | M (existence only) |
| S9 | Forging the Human Dimension of Victory: Strengthening the Sustainment Warfighting Profession (MSG D. Minder) | army.mil, Army Sustainment | 15 Jul 2026 | https://www.army.mil/article/293609/forging_the_human_dimension_of_victory_strengthening_the_sustainment_warfighting_profession | H (article read) |
| S10 | The LOGSTAT: FM 4-1, Modernizing Human Resources Support | DVIDS | 5 Feb 2026 | https://www.dvidshub.net/audio/90277/logstat-fm-4-1-modernizing-human-resources-support | H (page read) |
| S11 | J8, Force Structure, Resources and Assessment Directorate | Joint Chiefs of Staff (read via Internet Archive) | Page as of 2026 | https://www.jcs.mil/Directorates/J8-Force-Structure-Resources-Assessment/ | H |
| S12 | CJCSI 5123.01J, Charter of the JROC and the Joint Force Requirements Process | Joint Staff J-8 (read via Internet Archive) | 15 Jan 2026 | https://www.jcs.mil/Portals/36/Documents/Library/Instructions/CJCSI%205123.01J.pdf | H |
| S13 | J8, Resources and Assessments | US Africa Command (archived page) | Archived 27 Jan 2017 | https://webarchive.library.unt.edu/web/20170127143819/http://www.africom.mil/about-the-command/directorates-and-staff/j8-resources-and-assessments | H (dated) |
| S14 | Reforming the Joint Requirements Process to Accelerate Fielding of Warfighting Capabilities | Office of the Secretary of War | 7 Nov 2025 (posted 10 Nov 2025) | https://media.defense.gov/2025/Nov/10/2003819442/-1/-1/1/REFORMING-THE-JOINT-REQUIREMENTS-PROCESS-TO-ACCELERATE-FIELDING-OF-WARFIGHTING-CAPABILITIES.PDF | H |
| S15 | CFJP 3.0, Operations (B-GJ-005-300/FP-001) | National Defence, Canada | Issued 2010-07 | https://publications.gc.ca/collections/collection_2011/dn-nd/D2-252-300-2010-eng.pdf | H (para 0417 read) |
| S16 | CFJP 5.0, The Canadian Forces Operational Planning Process, Change 2 | National Defence, Canada | Apr 2008 | https://publications.gc.ca/site/eng/9.693032/publication.html | H (text read) |
| S17 | DAOD 5018-1, Military Casualty Reporting | National Defence, Canada | Issued 31 Jan 2025 | https://www.canada.ca/en/department-national-defence/corporate/policies-standards/defence-administrative-orders-directives/5000-series/5018/5018-1-military-casualty-reporting.html | H |
| S18 | DAOD 5050-0, Canadian Armed Forces Personnel Records | National Defence, Canada | Modified 29 Jan 2025 | https://www.canada.ca/en/department-national-defence/corporate/policies-standards/defence-administrative-orders-directives/5000-series/5050/5050-0-canadian-armed-forces-personnel-records.html | H |
| S19 | DAOD 1000-7, Policy Framework for Military Personnel Management | National Defence, Canada | Modified 13 Apr 2023 | https://www.canada.ca/en/department-national-defence/corporate/policies-standards/defence-administrative-orders-directives/1000-series/1000/1000-7-policy-framework-military-personnel-management.html | M (read as extract) |
| S20 | DAOD 5002-0, Military Personnel Requirements and Production | National Defence, Canada | Modified 30 Sep 2015 | https://www.canada.ca/en/department-national-defence/corporate/policies-standards/defence-administrative-orders-directives/5000-series/5002/5002-0-military-personnel-requirements-and-production.html | H (reference read) |
| S21 | CFC service paper citing Military Personnel Management Doctrine (DGMP, June 2008) | Canadian Forces College | Not read | https://www.cfc.forces.gc.ca/papers/csc/csc48/sp/Wakeham.pdf | L (search extract only) |
| S22 | OP FUTURE: Modernization of annual readiness and deployment administration | National Defence, Maple Leaf | 3 Dec 2025 | https://www.canada.ca/en/department-national-defence/maple-leaf/defence/2025/12/op-future-modernization-annual-readiness-deployment-administration.html | H |
| S23 | HRMS upgrade: Enhancing your HR experience in April 2026 | National Defence, Maple Leaf | Jan 2026 | https://www.canada.ca/en/department-national-defence/maple-leaf/defence/2026/01/hrms-upgrade-enhancing-hr-experience-april-2026.html | M (search extract) |
| S24 | Levels of security | Public Services and Procurement Canada | Modified 27 Aug 2026 | https://www.canada.ca/en/public-services-procurement/services/industrial-security/security-requirements-contracting/safeguarding-equipment-sites-assets-information/levels-security.html | H |
| S25 | Assessment of the Defence Resource Business Modernization Programme | National Defence, Canada | Undated in extract | https://www.canada.ca/en/department-national-defence/corporate/reports-publications/audit-evaluation/assessment-defence-resource-business.html | M (search extract) |
| S26 | Audit of the Financial Management Controls and Practices of the Canadian Army | National Defence, Canada | Undated in extract | https://www.canada.ca/en/department-national-defence/corporate/reports-publications/audit-evaluation/audit-financial-management-controls-practices-canadian-army1.html | M (search extract) |
| S27 | Financial Administration Manual: Expenditure Initiation and Commitment Control | National Defence, Canada | Undated in extract | https://www.canada.ca/en/department-national-defence/corporate/policies-standards/financial-administration-manual/expenditure-initiation-commitment-control.html | M (search extract) |
| S28 | Financial Administration Manual: Account Verification, FAA Section 34 | National Defence, Canada | Undated in extract | https://www.canada.ca/en/department-national-defence/corporate/policies-standards/financial-administration-manual/account-verification-financial-administration-act-section-34.html | M (search extract) |
| S29 | Directive on Delegation of Financial Authorities (archived) | Treasury Board of Canada Secretariat | Archived | https://tbs-sct.gc.ca/pol/doc-eng.aspx?id=19282 | M (archived; search extract) |
| S30 | Biography, Col Samanta Jacques-Arsenault (Deputy J8, CJOC) | RCLSA | c. 2023 | https://rclsa-asrlc.org/wp-content/uploads/2023/03/Col_Samanta_Jacques-Arsenault.pdf | L |
| S31 | Defence Team members honoured with Chief Financial Officer Merit Awards (2026); also 2021 awards page (JTF Central comptroller branch) | National Defence, Maple Leaf | Apr 2026; Mar 2021 | https://www.canada.ca/en/department-national-defence/maple-leaf/defence/2026/04/dtm-honoured-cfo-meritawards.html and https://www.canada.ca/en/department-national-defence/maple-leaf/defence/2021/03/dt-members-awarded-prestigious-goc-chief-financial-officer-merit-award.html | L |
| S32 | Biography, BGen R.W.H. Goodyear (Task Force Comptroller, Op ATHENA Roto 2) | RCLSA | c. 2019 | https://rclsa-asrlc.org/wp-content/uploads/2019/12/BGen-Rick-Goodyear.docx | L |
| S33 | USAspending API endpoints | US Treasury, USAspending.gov | Current | https://api.usaspending.gov/docs/endpoints | M |
| S34 | FY25 Defense Manpower Profile Report | Office of the Under Secretary for Personnel and Readiness | FY2025 | https://prhome.war.gov/Portals/52/Documents/MRA_Docs/MPP/FY25%20Defense%20Manpower%20Profile%20Report%20-%20Publis.pdf | M |
| S35 | Departmental Results Report: Spending and human resources (links to GC InfoBase) | National Defence, Canada | 2023-24 report | https://www.canada.ca/en/department-national-defence/corporate/reports-publications/departmental-results-report/2023-24-index/spending-hr.html | M |
| S36 | DoDI 5400.11, DoD Privacy and Civil Liberties Programs | DoD (WHS issuances) | Jan 2019, Change 1 Dec 2020 | https://www.esd.whs.mil/Portals/54/Documents/DD/issuances/dodi/540011p.pdf | M |
| S37 | DoDM 5400.11, Volume 2, Breach Preparedness and Response Plan | DoD (WHS issuances) | 6 May 2021 | https://www.esd.whs.mil/Portals/54/Documents/DD/issuances/dodm/540011v2.PDF | M |
| S38 | DON PII Guide v2 (update) | US Naval Academy, Department of the Navy | 18 Mar 2026 | https://www.usna.edu/AdminSupport/Privacy/DONPIIGuidev2_UPDATE_20260318.pdf | L |
| S39 | Directive on Automated Decision-Making | Treasury Board of Canada Secretariat | Updated June 2025 (per secondary) | https://www.tbs-sct.canada.ca/pol/doc-eng.aspx?id=32592 | M (scope, impact levels via TBS guide extracts); L (2025 scope for internal decisions) |
| S40 | SECURITY.md, "Classification labels and routing"; README "Labels and clearances" | NEAR AI VS Code extension (this repository) | Current branch | `SECURITY.md`, `README.md`, `src/domain/gate/labels.ts` | H |
| S41 | Team file format | NEAR AI VS Code extension (this repository) | Current branch | `src/agent/teams.ts` | H |
| S42 | Operational and Tactical Planning in the CAF; Canadian Joint Response Force HQ (as used in files 03 and 05) | Canadian Army, Line of Sight; National Defence | 2 Apr 2026; Oct 2026 | https://www.canada.ca/en/army/services/line-sight/articles/2026/04/operational-and-tactical-planning-in-the-caf.html | M (read by sibling research) |
| S43 | Sibling research files 03 (J3 and J4) and 05 (J5), and bookseller listing for JP 3-33 (Jun 2022) | This repository; The Lightning Press | 2026-11-18; undated | `.planning/research/staff-teams/03-J3-operations-J4-logistics.md`, `05-J5-plans.md`; https://www.thelightningpress.com/joint-publications/ | M (files); L (listing) |
