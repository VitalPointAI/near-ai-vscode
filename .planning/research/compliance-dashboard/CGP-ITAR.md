# Controlled goods and ITAR: markings, eligibility, routing, records and evidence

**Status:** design, for the owner's OK. Docs only: nothing here is built yet.
**Written:** 2026-11-20, against `origin/main` after the compliance dashboard design merged (PR #144).
**Owner request (2026-11-20):** "also consider what we need to show compliance for the Controlled Goods Program and ITAR."
**Extends:** the compliance dashboard design (`DESIGN.md` in this folder, Phase 44). **Builds on:** the coherence review (`.planning/research/coherence/`: `POLICY-SCHEMA.md` labels, `endpoints[]`, `authorizations[]`, `people`, `residency`, `decideRoute`; `GLOSSARY.md`), the model provenance design (passports, hosting classes), the guided setup design (questions, contract security, residency), the Cohere vault design (regions, Encrypted vaults), the data platform design (labels on every row, compartments, key groups) and the multi-user staff design (roster, positions, key groups, the hub as a cleared member).

**This is not legal advice.** Meeting the Controlled Goods Program and the ITAR is your organization's obligation. Your organization's counsel, its designated official (Controlled Goods Program) and its empowered official or export-control officer (ITAR) decide what the rules require for its work and confirm every setting described here. The product provides controls that make those decisions enforceable, and records and evidence that show what happened. It never says a deployment is "compliant" with either regime.

## 1. Key points first

1. **Sending controlled technical data to an AI model is a transfer to whoever runs the model.** Canada's Defence Production Act defines "transfer" as disposing of a controlled good "or disclos[ing] its content in any manner" (s. 37(3)), and only registered or exempt people may examine, possess or receive one (s. 37(1) and (2)). The ITAR treats giving a foreign person access to technical data, including by letting them see it or by handing over the means to decrypt it, as a release and an export (22 CFR 120.50, 120.56). A prompt, an attached file, an agent's context and a model's answer that repeats the data are all disclosures.
2. **The default is: controlled data stays on this computer.** It may also go to an endpoint your organization runs that your organization has explicitly marked eligible for that regime, by a signed record from its designated official or empowered official. It never goes to a model service that cannot show eligibility (NEAR AI Cloud, a Cohere vault, any outside provider) unless such a record exists for that exact endpoint. The gate refuses with a plain sentence and records the refusal.
3. **Encryption in transit and at rest is not enough for a model.** The ITAR's encryption carve-out (120.54(a)(5)) covers only "sending, taking, or storing" data that stays end-to-end encrypted with no third party holding the means of decryption. A model must read the data in the clear to answer. In 2019 the State Department refused to extend the carve-out to data decrypted in transit "for processing", and said the data must be "continuously encrypted at all times while outside of an authorized security boundary". Whether a confidential-computing enclave (TEE) that the operator cannot read counts as "not provided to any third party" has **no official answer**; this design treats it as unsettled and does not count a TEE as eligible by itself.
4. **Markings are compartments on the label, beside the level.** "Controlled goods (Canada)", "ITAR" and "US export-controlled (EAR)" are three reserved compartments (`CGP`, `ITAR`, `EAR`). They combine with any level on any scale: "Organization: Internal, ITAR", or "Canada, Protected: Protected B, Controlled goods (Canada)". The label format, its join and the routing table already carry compartments on `main`; what is new is their fixed meaning, who may hold them and where they may go.
5. **Who may see it is a signed decision, not a self-declared clearance.** A person holds a controlled compartment only through an `export-person` authorization signed by the person posted to your organization's designated official or empowered official position, with its basis (assessed under the Controlled Goods Regulations, exempt, a US person, a Canadian-registered person, a licence or agreement) and its expiry. Agents inherit nothing: what an agent sends is checked against the endpoint, and what a person receives through sharing is checked against that person.
6. **Records are kept as the rules require, and never pruned on their own.** Every send, share, refusal, lowering and grant that involves a controlled compartment is a record (who, what by name and keyed hash, to whom or where, under which authorization, when). The Controlled Goods Regulations keep transfer records for the period of registration plus five years (s. 10(a)); the ITAR keeps records for five years from the licence's expiry or the transaction (122.5). The product never deletes these records by itself, and exports them for the officials.
7. **Possible releases become incidents with the regulators' clocks shown.** A file marked controlled after it was sent to a non-eligible service, a revoked endpoint that already received data, or a lowering without the official's signature opens an incident. The product shows the Controlled Goods Regulations' "within three days after the day on which they discover the breach" (s. 10(h)) and the ITAR's voluntary disclosure timing (127.12), drafts a factual summary from records, and notifies your organization's export-control contact. It never reports to a regulator itself.
8. **The dashboard gets two overlays.** In the Accreditation section, beside the ITSP profiles: a "Controlled goods (Canada)" page and an "ITAR" page, each listing the regime's requirements mapped to product controls, your organization's responsibilities and gaps, with the same six states and honesty rules as Phase 44. Most rows are honestly "your organization's responsibility" (registration, assessments, security plan, briefings, licences, reporting).
9. **Biggest gaps today:** no fixed meaning for export compartments; clearances are self-declared until Phase 71; no endpoint eligibility beyond `maxLabel` and region; agent network tools are refused only by the blunt `no-agent-tools` flag; decision records are not tamper-evident or exportable (Phase 44 gap G2); no retention rule, no incident flow, no content hash in records; the product's own encryption is strong but not from a FIPS 140-validated module.
10. **Where it lands:** Phase 41 reserves the shapes that get signed into policies (the `exportControl` section, two authorization kinds, the `route.export-control` step) so they never need a schema break; a new **Phase 45** builds the enforcement, person eligibility, setup question, records, retention, export and incidents; Phase 44 gains the two overlays; the hub (Phase 32 line), the data platform and the relay each pick up one requirement line. Section 12.

## 2. The request and the agreed shape

| # | Agreed point | Where |
|---|---|---|
| 1 | Research first, official sources, cite; treat downloads as untrusted | Sections 3, 4 and 15; nothing downloaded was run |
| 2 | Compliance is your organization's obligation; counsel and the officials confirm; the product provides controls and evidence | Header, sections 1, 9, 10 |
| 3 | Markings as compartments, separate from and combinable with levels; plain-words setup question; project and file defaults | Section 6 |
| 4 | Person attributes in the roster, checked like clearances; agents inherit nothing; hub and data platform enforce per key group | Section 7 |
| 5 | Endpoint eligibility in `endpoints[]`; default this computer or eligible organization endpoints; plain refusal, recorded | Section 8 |
| 6 | Records, retention, incident hooks, export for the officials | Section 9 |
| 7 | OSCAL overlays in the Accreditation section, same honesty rules | Section 10 |
| 8 | Gaps, risks, open decisions with defaults, where it lands | Sections 11 to 14 |

## 3. What the Controlled Goods Program requires

All checked on the official sites on 2026-11-20. The Defence Production Act (DPA) and the Controlled Goods Regulations (CGR, SOR/2001-32) are current to 2026-10-29; the Act was last amended in 2017 and the Regulations in 2016.

### 3.1 The law

- **Controlled goods** are the goods in the DPA schedule (s. 35): United States-origin ITAR defence articles and goods made from US-origin ITAR technical data (schedule item 2), Group 2 of Canada's Export Control List (munitions, item 3), item 5504 of Group 5 (item 4) and Group 6, missile technology (item 5), with listed exclusions. PSPC's "What are controlled goods" page says this includes "technology (for example, blueprints and technical specifications in paper or electronic format)".
- **The prohibition** (s. 37(1)): no person may knowingly examine, possess or transfer a controlled good unless registered (s. 38) or exempt (s. 39, 39.1). A registered or exempt person may not transfer a controlled good to, or "permit the examination of a controlled good by", anyone who is neither (s. 37(2)).
- **Transfer** "means … to dispose of it or disclose its content in any manner" (s. 37(3)). **Examine** "means to consider in detail or subject to analysis in order to discover essential features or meaning" (PSPC registration page). **Possession** includes constructive possession: the power and intention to control a good directly or through others (same page).
- **Penalties** (s. 45): for s. 37, up to $2,000,000 and ten years on indictment; each day is a separate offence (s. 45(4)); officers and directors can be personally liable (s. 46).
- **Not covered:** public servants acting in their duties and visiting forces (s. 36, CGR s. 1.1).

### 3.2 The regulations

| Topic | Rule | Section |
|---|---|---|
| Registration | Up to five years; not assignable; owners of 20% or more, the designated official and the authorized individual consent to a security assessment | CGR ss. 3, 3.1, 7, 8 |
| Designated official | Canadian citizen or permanent resident ordinarily resident in Canada; assessed before appointment and at least every five years | ss. 11, 12 |
| People | The designated official assesses every officer, director and employee who needs access, at least every five years, decides "the extent to which" each may examine, possess or transfer, and asks the Minister to assess anyone judged high risk; authorization applies only in the course of their duties | ss. 13, 14 |
| Assessment content | Identity, citizenship, references, five-year histories (criminal record, residences, education, employment, finances, travel), associations, clearances; the only test is the risk of transfer to someone neither registered nor exempt | ss. 4, 15 |
| Exemptions | Officers, directors and employees of an ITAR-registered US company, once they give the registrant the required evidence (s. 16(1), (2)); US government officials (s. 16(3)); temporary workers, international students and visitors only on the registrant's application with the designated official's signed statement (ss. 17, 18); valid up to three years (s. 23) | ss. 16 to 23 |
| Records of goods | Goods received (date, source), transferred (date, identity and address of the recipient) and disposed of, kept "during the period of registration and for a period of five years after the day on which the person ceases to be registered" | s. 10(a) |
| Records of people | The most recent assessment of each person who examines, possesses or transfers, kept two years after they stop; ITAR exemption evidence kept two years after access ends | s. 10(b), (c) |
| Security plan | Per place of business: procedures to control examination, possession and transfer; to report and investigate breaches; the security organization; the content of briefings and training | s. 10(e) |
| Training and briefings | For authorized people and for visitors | s. 10(f), (g) |
| Breach reporting | "any actual or potential security breach … within three days after the day on which they discover the breach" | s. 10(h) |
| Reports | Records available to the Minister; every six months, the name, date of birth and access level of each person assessed | s. 10(i), (j) |
| Changes | Within 10 business days; exemption changes within 5 business days | ss. 9, 19 |

PSPC's registration guideline adds that electronic records must be "safe from modification by unauthorized persons" (2.2), that the security plan includes "the procedures related to information technology (IT) security" (2.5), and that criminal breaches go to the police "immediately" (2.8).

The Regulations do not require a log of every person who looked at a good. Access is evidenced by the assessment and authorization records (s. 10(b), s. 13) plus what the security plan sets out. This design records more than the minimum because a model request is a transfer, and the transfer record of s. 10(a) applies to it.

### 3.3 What PSPC says about electronic data, IT and cloud

- **Cloud guidance** (PSPC, "Guidance on using and providing cloud solutions", modified 2025-05-08). For registrants: choose a CGP-registered provider; keep data residency in Canada, and for data stored outside Canada, Global Affairs Canada "must be consulted" about export permits; give access only to people assessed under CGR s. 15; let provider support touch the data only when the provider confirms in writing that security-assessed staff will handle it; encrypt in transit and at rest (FIPS named as an example); least privilege, secure connections, multi-factor authentication and audit logging; keep s. 10 records for cloud data; report breaches under s. 10(h). For providers: an unregistered provider risks breaking the Act through support work such as "reviewing the user's controlled data in decrypted form".
- **Security plan template** (dated 2026-07-09), section 7: where the computer or server is and how it is protected; remote access (VPN, whether files are downloaded); the cloud provider and server location; laptops and portable devices when travelling; backups "must be kept at a registered site". Access is limited to people "security assessed and approved by the designated official".
- **Not found:** a stand-alone CGP IT security guideline, or any PSPC statement about AI models, encryption keys or foreign nationals' access to IT systems beyond the above.
- **Changes ahead:** PSPC's red tape reduction review (modified 2026-05-05) says "PSPC will launch a review of the Controlled Goods Regulations to identify current program gaps". No amendment or timeline is published. The CGP roadmap makes fingerprint-based criminal record checks mandatory for designated officials. The Canadian Program for Cyber Security Certification (CPCSC) is a separate program for defence suppliers; Phase 44 already covers it as an overlay (decision D10).

### 3.4 What this means for an AI tool (our reading, for counsel to confirm)

- A model endpoint operator who receives controlled technical data in the clear is a recipient of a transfer. Unless that operator, and every person of theirs who can reach the data, is registered or exempt, the sender breaks s. 37(2). PSPC's cloud guidance reaches the same place for cloud support staff.
- Storing ciphertext with an unregistered provider is less clear: PSPC's wording ("reviewing … in decrypted form") points at plaintext, but "possession" includes constructive possession, and data stored outside Canada also raises export permits under the Export and Import Permits Act. **Unsettled; default: not eligible.**
- The CGP has no encryption carve-out like the ITAR's. A TEE reduces who can read the data, but the operator still runs, schedules and supports it. **Default: a TEE alone does not make an endpoint eligible.**
- Every person who can read the data through the product (a member of a shared project, an administrator of your organization's server, a reviewer of a data platform hold) is examining it.

## 4. What the ITAR requires

Text read from the official eCFR, current to 2026-11-18, and the Federal Register. The ITAR was reorganized in 2022; the section numbers below are the current ones.

### 4.1 Definitions

- **Defense article** (120.31): items and technical data designated in the US Munitions List (121.1), including technical data "recorded or stored in any physical form".
- **Technical data** (120.33(a)): information "required for the design, development, production, manufacture, assembly, operation, repair, testing, maintenance, or modification of defense articles", including drawings, plans, instructions and documentation, classified information, and software directly related to defense articles. Excludes general science and engineering principles, public-domain information (120.34) and basic marketing information.
- **Export** (120.50(a)): includes sending technical data out of the US, "releasing or otherwise transferring technical data to a foreign person in the United States (a deemed export)" ((a)(2)), and "the release of previously encrypted technical data" ((a)(6)). A release is deemed an export "to all countries in which the foreign person has held or holds citizenship or holds permanent residency" (120.50(b)).
- **Reexport and retransfer** (120.51, 120.52): the same acts abroad; a release abroad to a third-country national is a deemed reexport.
- **Release** (120.56(a)): "visual or other inspection by foreign persons of a defense article that reveals technical data"; oral or written exchanges; "use of access information to cause or enable a foreign person, including yourself, to access, view, or possess unencrypted technical data". Giving a foreign person **access information** (keys, network access codes, passwords; 120.55) needs the same authorization as the release itself (120.56(b)).
- **US person** (120.62) and **foreign person** (120.63): a lawful permanent resident or protected individual, US entities and US government are US persons; everyone and everything else is foreign.
- **Empowered official** (120.67): a US person, directly employed, empowered in writing, with independent authority to inquire, verify and refuse to sign without reprisal.

### 4.2 The encryption carve-out, 120.54(a)(5)

Not an export, reexport, retransfer or release: "Sending, taking, or storing technical data that is: (i) Unclassified; (ii) Secured using end-to-end encryption; (iii) Secured using cryptographic modules … compliant with … FIPS 140-2 or its successors, supplemented by software implementation, cryptographic key management and other procedures and controls that are in accordance with guidance provided in current … NIST publications, or by other cryptographic means that provide security strength that is at least comparable to the minimum 128 bits of security strength achieved by … AES-128; and (iv) Not intentionally sent to a person in or stored in a country proscribed in § 126.1 …; and (v) Not sent from a country proscribed in § 126.1." Data in transit over the internet is not stored in the countries it crosses (Note 1).

- **End-to-end encryption** (120.54(b)(1)): data is never unencrypted between the originator (or its in-country security boundary) and the intended recipient (or its boundary), and "the means of decryption are not provided to any third party". The recipient must be the originator, a US person in the US, or a person otherwise authorized (120.54(b)(2)).
- Access to the encrypted data alone is not a release (120.54(c)).
- **The State Department's reading** (preamble to the 2019 rule, 84 FR 70887, effective 2020-03-25): "If the technical data is decrypted by someone other than the sender, a U.S. person in the United States, or a person otherwise authorized … the original transmission was a controlled event"; "the means of decryption must not be provided to any third party and the data must not have the cryptographic protection removed at any point in transit"; it rejected requests to let data be decrypted in transit "for processing via applications, such as anti-virus software or spell-check": the data must be "continuously encrypted at all times while outside of an authorized security boundary"; it rejected a cloud safe harbour based on contracts alone and will look at third parties' conduct case by case.
- Russia's separate mention was folded into 126.1 in 2025 (90 FR 29720). A proposed rule of 2026-10-01 (91 FR 62361) changes only 120.54(a)(1).

### 4.3 Registration, records, disclosures

- **Registration** (122.1): anyone in the US in the business of manufacturing, exporting or temporarily importing defense articles or furnishing defense services registers with DDTC. Producers of unclassified technical data only are exempt from registration but still need licences (122.1(b)(2)).
- **Records** (122.5(a)): kept "for a period of five years from the expiration of the license or other approval, to include exports using an exemption …; or, from the date of the transaction". Electronic records must be reproducible on paper and changes recorded with who and when; available for inspection at any time (122.5(b)).
- **Voluntary disclosure** (127.12): an initial notification "immediately after a violation is discovered", then the full disclosure within 60 calendar days (extensions on request), with senior management's knowledge; it "may" be a mitigating factor. The duty to notify DDTC immediately about proposed or actual transfers involving a 126.1 country is separate (126.1(e)).

### 4.4 Canada and third-country nationals

- **Canadian exemption** (126.5(b)): unclassified USML articles and defense services may go to Canada without a licence for end use in Canada by the federal or a provincial government, by a "Canadian-registered person", or for return to the US. A **Canadian-registered person** is "any Canadian national (including Canadian business entities …), dual citizen of Canada and a third country other than a country listed in § 126.1, and permanent resident registered in Canada in accordance with the Canadian Defense Production Act" (the CGP). Any reexport or retransfer needs DDTC approval (126.5(d)). If the exporter knows the end user is not a qualified Canadian-registered person, a licence is needed (Note 1).
- **Exclusions** (Supplement No. 1 to part 126): classified items, MTCR items, space items and others; Note 12 excludes technical data specific to applied research, design methodology, engineering analysis or manufacturing know-how (build-to-print, build or design-to-specification, basic research and maintenance stay eligible). Much engineering and software work therefore needs a licence or agreement even in Canada.
- **Dual and third-country nationals** (126.18): transfers within an approved foreign end user to its bona fide regular employees who are dual or third-country nationals need no DDTC approval when the end user has effective anti-diversion procedures: a host-government security clearance, or screening for "substantive contacts" with 126.1 countries plus a non-disclosure agreement, and a technology security plan. 126.18(d) gives a separate route for exclusively NATO, EU, Australia, Japan, New Zealand or Switzerland nationals.
- **Proscribed countries** (126.1): a policy of denial for Belarus, Burma, China, Cuba, Iran, North Korea and Venezuela (126.1(d)(1)), with country-specific policies for others including Russia (126.1(d)(2)). Substantive contacts with (d)(1) countries are presumed to raise diversion risk.

### 4.5 The EAR and the 600 series, briefly

- Technology controlled under the Export Administration Regulations (for example 600-series and 9x515 items, formerly USML) follows parallel rules: a release to a foreign person in the US is a deemed export (15 CFR 734.13(a)(2)), counted against the person's **most recent** citizenship or permanent residency (734.13(b)), not all of them as the ITAR does; release includes visual inspection and access information (734.15); the encryption carve-out is 734.18(a)(5), with "other equally or more effective cryptographic means" instead of the AES-128 floor and Country Group D:5 instead of 126.1.
- For Canada, 600-series national security and regional stability licence requirements apply to all destinations "except Australia, Canada, or the United Kingdom" (742.4(a)(1), 742.6(a)(1)); other reasons for control can still apply, so each item is checked. The `EAR` compartment exists so such data is not sent to services by mistake; the eligibility rules are the same as ITAR's unless your organization narrows them.
- BIS advisory opinions on cloud computing and deemed exports (2009, 2011, 2014) exist; their holdings were not verified for this design (research flag). The BIS AI diffusion rule with model-weight controls was rescinded on 2026-11-19 (91 FR 74970); it concerned chips and compute, not technical data in prompts.

### 4.6 What this means for an AI tool (our reading, for counsel to confirm)

| Situation | Established | Unsettled |
|---|---|---|
| ITAR data in a prompt to a model operated by, or reachable by, foreign persons | A release to them (120.56(a)), an export to every country of their citizenship (120.50(b)), unless an authorization covers it | |
| ITAR data sent encrypted to a model that decrypts it to answer | Outside 120.54(a)(5): the model and its operator hold the means of decryption, and DDTC refused a processing exception | |
| A TEE model service where the operator's staff cannot read plaintext and keys live only in the attested enclave | | Whether an enclave run by a third party is "provided to any third party" (120.54(b)(1)(ii)); no DDTC ruling. The official routes are an advisory opinion or your organization's own legal opinion |
| ITAR data held by a Canadian registrant under 126.5, sent to a US-hosted model service | The data leaves the authorized end user; 126.5(d) requires DDTC approval for retransfer | Whether a US-person-only service in the US is a retransfer at all, and which exclusion notes apply to the data: counsel |
| Encrypted storage on your organization's server or a git host, with keys only on members' devices | Fits 120.54(a)(5) when the cryptography meets (iii), the recipient is authorized, and no 126.1 country stores it | Whether the product's cryptography meets (iii) through the "comparable security strength" branch rather than a FIPS-validated module: counsel and the empowered official |
| A local model on hardware your organization controls, used only by authorized people | No release beyond those people | |
| Logs, chat history, embeddings, summaries and fine-tuned weights made from technical data | Copies and derivatives in "any physical form" (120.31) are technical data when they reveal it | Whether model weights trained on technical data are themselves technical data in every case; default: treat them as controlled |

## 5. Who does what

| Party | Does |
|---|---|
| Your organization | Registers in the CGP and with DDTC where required; appoints the designated official and the empowered official; assesses people; obtains licences, agreements and exemptions; writes the security plan and technology security plan; decides which data is controlled and which endpoints are eligible, with counsel; trains and briefs; reports breaches and makes disclosures; keeps HR and assessment files |
| The product | Lets people mark data and sets safe defaults; refuses sends and shares that the signed decisions do not allow, with a plain reason; keeps refusal, send, share and lowering records, tamper-evident, never pruned by itself; detects possible releases and opens incidents with the clocks shown; exports records for the officials; shows evidence and gaps on the dashboard |
| Model and service providers | State their region, operator, registration and staff access facts in writing; your organization records them as evidence on an endpoint authorization |

## 6. Markings

### 6.1 Compartments, not levels

The label on `main` is `{ scale, level, compartments, releasability, handling }` (`src/domain/gate/labels.ts`). A compartment is need-to-know: a reader must hold every compartment on the label (`dominates`, condition 3), joins take the union, and the routing table can raise the tier for a compartment (`routing.compartments`). That is exactly the behaviour an export-control marking needs, so no new label field is added.

Three compartment tokens are **reserved** with a fixed meaning when the policy's `exportControl` section is present (section 6.4):

| Token | Shown as | Regime |
|---|---|---|
| `CGP` | Controlled goods (Canada) | DPA Part 2 and the CGR |
| `ITAR` | ITAR | 22 CFR 120 to 130 |
| `EAR` | US export-controlled (EAR) | 15 CFR 730 to 774, for example 600-series technology |

- **Separate from levels and combinable with them.** "Canada, Protected: Protected B, Controlled goods (Canada), ITAR" and "Organization: Internal, ITAR" are both valid. The level still decides its own routing; the compartment adds the export-control rules on top; the stricter result wins (`decideRoute`, section 8.2). Classified content with an export marking is still classified first: local only on an accredited device.
- **Releasability is not used for these.** Releasability tokens describe who a classified item may be released to by country; export-control eligibility depends on registration, exemptions and licences, not on nationality alone, so it lives in signed person decisions (section 7).
- **Never relaxes.** A compartment only adds restrictions. Removing one is a lowering that needs the official's signature (section 6.5).
- **Shown words.** Every label display adds the shown words after the level ("Organization: Internal · ITAR"). Tokens stay in records and administrator panes (glossary).

### 6.2 How setup asks

The guided setup (`.planning/research/guided-onboarding/DESIGN.md`, section 4.2) gains one choice in Q2 and two follow-up screens. Plain words, one question per screen, "Not sure" maps to the stricter reading.

| # | Screen heading | Choices | Shown when |
|---|---|---|---|
| Q2 (new choice) | What will this project's work touch? | adds: **Technical data for military or defence goods** (drawings, specifications, software or know-how for weapons, military equipment or their parts) | Always |
| Q2c | Which rules apply to it? (tick all that apply) | Controlled goods in Canada; US ITAR (from a US source, or marked ITAR); US export-controlled under the EAR (for example "600 series"); Not sure | Technical data ticked |
| Q2d | Is your organization registered in the Controlled Goods Program, and are you assessed or exempt for this work? | Yes, registered and I am assessed or exempt; Registered, but I am not sure about myself; Not registered; Not sure | Controlled goods or Not sure ticked in Q2c |

- **Not sure** in Q2c gives both `CGP` and `ITAR`, with "We treat this as controlled goods and ITAR until you know. Check the markings on the documents, or ask {export-control contact}."
- **Where the guide stops.** Q2d "Not registered" or "Not sure": "Only people registered in, or exempt from, the Controlled Goods Program may examine controlled goods. Ask {export-control contact} before you continue." The project label is still applied (so the gate's rules work at once), and the guide makes no recommendation for AI services. Any answer other than "Yes" also leaves the person without an `export-person` decision, so the gate keeps controlled content on this computer (section 8).
- **What the guide never does.** It never decides that data is or is not controlled, never records a person as assessed (only the official's signed decision does that, section 7), and never offers a hosted option for controlled work unless your organization's policy already lists that endpoint as eligible.
- **Contacts.** `onboarding.contacts[].topic` gains `export-control` (the designated official or empowered official, by position).
- **"What does this mean?" copy:** "Technical data for military goods is controlled. In Canada only people registered in, or exempt from, the Controlled Goods Program may see it, and sending it to an AI service counts as giving it to whoever runs that service. US ITAR data may be seen only by people its licence or exemption allows. Your organization's rules keep this data on this computer unless your designated official or empowered official has approved a specific AI service for it."

### 6.3 Project and file defaults

- **Project:** the setup answers raise the project label with the compartments (never lower an existing label). In a shared project the project label is a project-stream entry, so every member sees the same marking.
- **Files and folders:** the existing Set Label machinery labels a path; the export compartments are offered as ticks after the level ("Also controlled: Controlled goods (Canada), ITAR, EAR"). A folder marking covers what is inside it; a file can only add to its folder's marking.
- **Suggested markings (raise only).** A rule pack in the classification rules (data platform design, file 02; the gate's facts-to-minimum-label rules) suggests a compartment when a file carries a standard legend: an ITAR or EAR export warning statement, a "Controlled Goods" marking, a USML category or an Export Control List Group 2 item number in a header. The suggestion is shown to the person with the line that matched; it never lowers anything and never marks silently, because a wrong silent marking teaches people to ignore markings. Your organization can make a rule automatic in its policy.
- **Session mark:** a chat or agent run that reads a controlled file takes the compartment into its mark, so everything it produces afterwards (answers, edits, staff products, summaries) carries it.

### 6.4 The `exportControl` policy section

A new section of policy bundle v2 (`.planning/research/coherence/POLICY-SCHEMA.md`, section 2), named in `requires` as `exportControl@1`.

```json
"exportControl": {
  "v": 1,
  "regimes": ["CGP", "ITAR", "EAR"],
  "officials": [
    { "regime": "CGP",  "position": "designated-official" },
    { "regime": "ITAR", "position": "empowered-official" },
    { "regime": "EAR",  "position": "empowered-official" }
  ],
  "registration": { "CGP": { "registered": true, "reference": "<registration number>", "endsOn": null } },
  "suggestRules": "standard",
  "agentNetwork": "refuse",
  "retention": { "neverAutoPrune": true },
  "incidents": { "contacts": ["export-control"] }
}
```

| Key | Rule |
|---|---|
| `regimes` | Which reserved compartments have their fixed meaning. A regime not listed is an ordinary compartment |
| `officials` | The position whose holder signs `export-person`, `export-endpoint` and lowering decisions for each regime; the holder's key must be listed in the organization layer |
| `registration` | Facts your organization states (registration reference, the date registration ended, if it has); used for retention and shown on the dashboard |
| `suggestRules` | `standard` (the shipped legend rules as suggestions), `automatic`, or `off` |
| `agentNetwork` | `refuse` (default, section 8.4); there is no value that allows network tools on controlled content |
| `retention.neverAutoPrune` | Always true in v1; present so a later version cannot silently change it |
| `incidents.contacts` | Which `onboarding.contacts` topics are notified |

Narrowing direction: personal and project layers may add regimes, add suggestion rules and make them automatic; they may never remove a regime or change an official. Without the section, `CGP`, `ITAR` and `EAR` behave as ordinary compartments (today's behaviour), and the dashboard overlay shows the section's absence as a gap.

### 6.5 Lowering

Removing an export compartment from a label, a file, a chat or a staff product is a lowering (`label.declassify`). For a reserved compartment it needs an authorization of kind `declassify` scoped to that regime, signed by the regime's official, with a reason ("not technical data: general engineering principles", "released to the public by the originator with written approval"). The person who asks sees "Removing this marking needs {position}'s decision" and the request goes to the contact. Without the organization layer the decision is "self-signed on this computer" and the dashboard row stays Not met.

## 7. Who may see it

### 7.1 The person decision: `export-person`

One new authorization kind in the one `authorizations[]` list (`POLICY-SCHEMA.md`, section 2):

```json
{
  "id": "xp-2026-0142",
  "kind": "export-person",
  "subject": { "person": "<person id>" },
  "scope": { "regimes": ["CGP", "ITAR"], "projects": ["*"], "labels": ["ca-protected/Protected B"] },
  "conditions": {
    "CGP":  { "basis": "assessed", "extent": ["examine", "possess", "transfer"] },
    "ITAR": { "basis": "canadian-registered-person", "authority": "126.5", "excludes": ["supplement-1-note-12"] }
  },
  "evidence": "<reference in your organization's security file>",
  "namedPerson": { "name": "<designated official>", "key": "<key>" },
  "issuedAt": "2026-11-20T00:00:00Z",
  "expiresAt": "2031-11-20T00:00:00Z"
}
```

| Field | Rule |
|---|---|
| `basis` for `CGP` | `assessed` (CGR s. 13; maximum five years), `exempt-us-itar-registered` (s. 16(1), (2)), `exempt-us-official` (s. 16(3)), `exempt-temporary-worker`, `exempt-student`, `exempt-visitor` (ss. 17, 18; maximum three years, s. 23) |
| `extent` for `CGP` | The designated official's decision under s. 13(a): any of examine, possess, transfer. A person without `transfer` can read in a shared project but cannot send to any endpoint or share onward |
| `basis` for `ITAR` and `EAR` | `us-person` (120.62), `canadian-registered-person` (126.5), `licence` or `agreement` (with its number and expiry), `dual-third-country-126.18`, `exempt-other` (with the section) |
| `excludes` | Notes the official marks as not covered (for example Supplement No. 1 Note 12 for design methodology under 126.5); a label carrying a matching handling marker is refused for this person |
| `expiresAt` | At most five years for `assessed`, three years for an exemption, and never later than the licence or agreement it cites |
| `evidence` | A reference to your organization's own file. **No citizenship, date of birth or assessment content is stored in the policy or the roster**; those stay in your organization's security files (minimum personal information) |

Rules:

- **Signed by the official, never self-declared.** The `namedPerson` must hold the regime's official position (section 6.4). A declared clearance (`people.clearances`, personal layer) that lists a reserved compartment is ignored for that compartment, with a notice: "Controlled goods and ITAR access comes only from {position}'s decision."
- **Checked like a clearance.** The **effective clearance** (the meet of the personal and roster clearances, multi-user design 7.2) holds a reserved compartment only while a valid `export-person` decision covers the person, the regime, the project and the label's level. A separate check, `exportEligible(person, label)`, runs whenever a label carries a reserved compartment, whether or not clearances are otherwise enforced, so single-computer use is covered too.
- **In the roster.** A member entry (`member.invite`, `member.admit`, `member.update`) cites the decision ids; the people list shows "Allowed to see: Controlled goods (Canada) until {date}, decided by {name}". Expiry and revocation behave like a clearance change: the member's controlled key groups are rekeyed (multi-user design 8.3), and the lead sees "They keep what they already received. They will not receive anything new." That sentence is also a prompt to the official, because what they already received may need retrieval under the security plan.
- **Positions.** The designated official and the empowered official are positions (assigned positions design, Phase 33.1); handing over the position hands over the signing duty, and decisions signed by the previous holder stay valid until they expire or the new holder revokes them.
- **Phase 71.** From Phase 71 an `export-person` decision is issued as a verifiable credential with a status list, so revocation reaches offline machines within the policy's maximum offline age.

### 7.2 What the product can and cannot stop

- It **can** stop sends to AI services, sharing with other people (key groups, invitation files, bundle files, git remotes), agent tools, hub watches and data platform results.
- It **cannot** stop a person who has the file on their computer from opening it in the editor or copying it elsewhere. Who may hold the file on that computer is your organization's decision, enforced by its operating system, device and site controls under its security plan. The overlay says so on the relevant rows.

### 7.3 Agents inherit nothing

- An agent is not a person and never holds an export decision. What an agent may do with controlled content is decided by where it sends it (section 8) and which tools it uses (section 8.4).
- A sub-agent, a team's coordinating agent and a hub watch are checked the same way, against their own endpoint.
- An agent's output carries the mark of what it read, so a person without the decision cannot receive it through any sharing path.

### 7.4 Your organization's server, the data platform and the relay

- **Server (hub).** The hub is a cleared member (multi-user design 10.2). It may be granted a key group that carries a reserved compartment only when an `export-endpoint` decision (section 8.1) covers the hub itself: its location, who administers it, its backups (the CGP template says backups "must be kept at a registered site"). Without one, the hub holds only ciphertext for that group, which the end-to-end design already does: keys stay on members' devices. The hub's access lists are filtered by `exportEligible` before a stream is offered.
- **Data platform.** Every row carries its label, so the reserved compartments travel to chunks, vectors, entity pages, summaries, counts and caches. Row-level security and the reader-relative rule (data platform design 6.3) add `exportEligible` to the clearance check per key group; a specialist model trained on controlled rows carries the compartment and is served only through eligible endpoints to eligible people. Holds and access requests that touch controlled rows are reviewed only by people with the decision.
- **Messaging relay.** Messages that leave through outside messaging services (Microsoft Teams, Signal and others) are disclosures to those services. Content with a reserved compartment is never sent through the relay; its channel manifests (Phase 75) carry `maxLabel` and a "no export-controlled content" rule, and a refusal tells the person to open the project instead.

## 8. Where it may go

### 8.1 The endpoint decision: `export-endpoint`

A second new authorization kind, with `subject: { endpoint }`, signed by the regime's official:

| Condition | Meaning |
|---|---|
| `regimes` | Which reserved compartments it may receive |
| `region` | Must match the endpoint's `region`; for `CGP` the default rule is `CA` (PSPC cloud guidance) unless the decision cites a Global Affairs Canada consultation reference |
| `operator` | Who runs it: `your-organization`, or the provider's name with its CGP registration reference (CGP) and DDTC registration reference (ITAR, where it applies) |
| `access` | A written statement, recorded as `evidence`, of who can reach the data in the clear: "only people assessed or exempt under the CGR", "only US persons", "only people covered by licence {n}", including support staff and administrators |
| `crypto` | For storage or transmission that relies on encryption: the module (FIPS 140-3 certificate number) or the "comparable strength" basis, and who holds the keys; never a third party |
| `plaintext` | `none` (stores or carries ciphertext only, keys held by members) or `processes` (decrypts to compute, as every model does); `processes` requires `access` to cover everyone who can reach the plaintext |
| `legalBasis` | For any endpoint your organization does not run, a reference to the written legal opinion or authorization (licence, agreement, advisory opinion) it relies on |
| `expiresAt` | At most 365 days; also ends early on the endpoint's re-evaluation triggers (`hosting-change`, region change, operator change) |

The endpoint entry in `endpoints[]` gains nothing new beyond what it has (`class`, `host`, `region`, `tlsPin`, `attestation`, `provider`): eligibility is the signed decision, kept apart from the endpoint's technical facts, so a discovery or setup flow can never make an endpoint eligible by writing the list.

### 8.2 The route decision

`decideRoute` (`POLICY-SCHEMA.md`, section 6) gains step 7, **export control**, after the clearance step:

7. For each reserved compartment on the label: the endpoint is `local` (this computer), or a valid `export-endpoint` decision covers this endpoint, this regime, this project and this level; and the person asking holds a valid `export-person` decision with `transfer` in its extent for `CGP` (or the `ITAR` and `EAR` basis covering the work). Otherwise refuse with `route.export-control`.

Defaults (when `exportControl` is present):

| Endpoint | Default for a label with `CGP`, `ITAR` or `EAR` |
|---|---|
| `local` (this computer) | Allowed, for a person with the decision |
| `org-plain`, `org-tee` | Refused until an `export-endpoint` decision exists for that exact endpoint |
| `nearai-tee`, `vendor-tee`, `vendor-region`, `forwarded`, `closed-api` | Refused until an `export-endpoint` decision with a `legalBasis` exists; the product ships none, and the Cohere and NEAR AI options in setup are greyed with the reason |
| Agent network tools, MCP servers that reach the network, the relay, git remotes | Refused (section 8.4) |

Shipped routing default for the reserved compartments: `labels.routing.compartments = { CGP: "local-only", ITAR: "local-only", EAR: "local-only" }`, so even before step 7 is built the existing routing check keeps controlled content off every cloud class.

**Refusal sentences** (plain, one line, then "Why" and "Who to ask"):

- "This is marked ITAR. NEAR AI Cloud is not approved for ITAR data, so nothing was sent. Use a model on this computer, or ask {export-control contact}."
- "This is marked Controlled goods (Canada). Your organization's server at {host} is not approved for controlled goods, so nothing was sent."
- "You do not have a decision allowing you to send controlled goods. Nothing was sent. Ask {designated official position}."
- "Agents cannot use web search, fetch or online tools while this chat holds ITAR data."

Each refusal writes a decision record with `route.export-control`, the regime, the endpoint id and the reason, and never the content.

### 8.3 Trust line

The trust line (coherence `EXPERIENCE.md`, section 3) adds the export marking and what allowed it: "Runs on this computer · Controlled goods (Canada)" or "Runs on your organization's server (private hardware) · ITAR · allowed by {name}'s export decision {id} until {date}". A decision signed on the same computer by the person using it says "self-signed on this computer".

### 8.4 Agents, tools and the network

- While a chat's or run's mark holds a reserved compartment, agent tools that reach the network are refused: web search and fetch, MCP servers that are not on this computer, `git push` and `git fetch` to remotes not covered by an `export-endpoint` decision, package installs that upload, and commands the outbound check classifies as network. Local file tools stay available (under the label's other rules). This is narrower than `no-agent-tools`, which refuses every tool, and is applied by the same outbound classification the gate uses today.
- A shell command can still reach the network in ways the classifier misses; Phase 72's execution backends (network fence per binary) close that. Until then the overlay marks the row Partly met and names the limitation.
- Search queries, URLs and tool arguments built from controlled content are disclosures too; refusing the tool, not filtering its arguments, is the only reliable rule.

### 8.5 Local models and accredited hardware

The safest route is a local model or your organization's own server. The model provenance rules still apply (passport, origin, use), and the overlay adds organization rows: the computer or server sits at a registered site, is administered only by people with the decision, and its backups stay at a registered site. A model fine-tuned on controlled data is marked with the compartment and stays on eligible hardware.

## 9. Records, retention, incidents and export

### 9.1 What is recorded

| Event | Record | Regime need |
|---|---|---|
| A send to a model with a reserved compartment | Decision record: person, endpoint id, regime, authorization ids, label, file names and paths, keyed hash of each file's content and of the prompt, time | CGR s. 10(a) transfer record (recipient identity is the endpoint's operator); ITAR 122.5 record of an export under an exemption or licence |
| A refusal | `route.export-control` with reason | Evidence that the control works; security plan |
| A share | Key group grant, invitation, bundle file or hub grant for a controlled key group: recipient person or service, authorization ids, time | CGR s. 10(a) |
| A person or endpoint decision issued, renewed, expired, revoked | The authorization record and its lifecycle | CGR s. 10(b), (c); ITAR 122.5 |
| A marking added or removed | `label.set`, `label.declassify` with the official's decision | Security plan |
| A possible release | Incident record (section 9.3) | CGR s. 10(h); ITAR 127.12 |

- **Keyed hash, never content.** The decision record already carries names and paths, never content (`src/domain/gate/record.ts`). The new content hash is an HMAC under a key held on this install (and shared with the export decision's officials on export), so records can be matched against a file later without anyone outside being able to test guesses against them.
- **File names can reveal technical data** (a part number in a path). Export-control records are themselves labelled with the regime's compartment, so they are shared only with people holding the decision.
- **Tamper-evident.** These records go into the Phase 41 hash-chained local audit with signed heads (Phase 44 gap G2). The CGP guideline's "safe from modification by unauthorized persons" is the requirement this meets.

### 9.2 Retention

- Records that involve a reserved compartment are **never pruned automatically**. Pruning is a signed decision by the regime's official.
- The product computes and shows the **earliest permitted pruning date** for each record, from facts your organization states: CGR s. 10(a) records, five years after the date `exportControl.registration.CGP.endsOn` (unknown while registered, so "not before registration ends plus five years"); assessment and exemption records, two years after the person's decision ends (s. 10(b), (c)); ITAR records, five years after the cited licence or agreement expires, or after the transaction for an exemption (122.5(a)). Where several apply, the latest wins.
- Records are reproducible on paper (122.5(a)) through the export (9.4), and corrections are new records citing the old one, never edits.

### 9.3 Possible releases and incidents

The product opens an **incident** when it can see a possible release:

1. A file or folder gets a reserved compartment after records show it (same path, or the same keyed hash) was sent to an endpoint not eligible for that regime.
2. An `export-endpoint` decision is revoked or found wrong (region, operator or access changed) after controlled content went there.
3. A reserved compartment was lowered without the official's decision (only possible on an old client or by editing files outside the product; found by the audit chain check).
4. A key group with a reserved compartment was granted to a person or service whose decision had expired (a race between an offline grant and an expiry).
5. A person reports one ("Report a possible release" in the project's security menu).

Incident lifecycle: **detected** (time of discovery recorded) → **under review** by the regime's official → **reported** (with the official's reference and date) or **not a breach** (signed reason) → **closed**. An incident never closes without a signed step. The incident page shows, as information quoted from the regulations: "Controlled Goods Regulations s. 10(h): advise the Minister of any actual or potential security breach within three days after the day on which you discover it" (with the date that falls on), the guideline's "criminal breaches go to the police immediately", and for the ITAR "voluntary disclosure: initial notification immediately after discovery, full disclosure within 60 calendar days (22 CFR 127.12)". It drafts a factual summary from the records (what, when, where, under which decisions, who was involved), notifies `exportControl.incidents.contacts`, and never contacts a regulator, never decides whether something is a breach, and never deletes the records involved.

### 9.4 Export for the officials

"Export controlled-goods and ITAR records" (in the policy editor's Authorizations section and the dashboard's organization view) writes a signed bundle for a date range and regime: the records, the person and endpoint decisions in force, incidents, and the chain heads that prove nothing was removed, as JSON and CSV, readable on paper. Only a person with the regime's decision can run it, and the export itself is recorded. The CGR s. 10(j) six-monthly list is your organization's (it holds dates of birth the product never stores); the export gives the official the access decisions issued in the period to reconcile against it.

## 10. Evidence and the dashboard

### 10.1 Overlays in the OSCAL model

Phase 44's `compliance/` folder gains two **requirement catalogues** and their mappings. Neither regime is a control catalogue, so each requirement becomes an OSCAL control in its own catalogue, and each is mapped to ITSP.10.033 and NIST SP 800-53 controls and to product features:

```
compliance/
  catalogs/cgp/          DPA Part 2 and CGR requirements (ids CGP-37-2, CGP-10-a, CGP-10-h, ...)
  catalogs/itar/         ITAR requirements (ids ITAR-120.54-a5, ITAR-122.5, ITAR-126.5, ...)
  catalogs/NOTICE        sources, retrieval dates, hashes, "unofficial representation"
  profiles/overlay-cgp.json, profiles/overlay-itar.json
  mappings/cgp-to-itsp10033.json, mappings/itar-to-sp80053.json
```

- **Text and licence.** Canadian federal enactments may be reproduced without charge or permission when reproduced accurately and not presented as the official version (Reproduction of Federal Law Order, SI/97-5). The Code of Federal Regulations is a US government work. Both are stored with a notice that names the source, the retrieval date and hash, and "unofficial representation; the official text governs". PSPC guidance pages are cited by link and paraphrased, not copied.
- **Example rows:**

| Requirement | Product control (statement and evidence) | Responsibility |
|---|---|---|
| CGP-37-2: no transfer to, or examination by, a person neither registered nor exempt | `decideRoute` step 7 and `exportEligible`; mapped tests of refusals for every endpoint class, for shares, hub grants and agent tools | Shared: the product enforces signed decisions; your organization makes them |
| CGP-10-a: transfer records, retained | Send and share records, chain heads, never-auto-prune test, export | Shared |
| CGP-10-b: assessment records | `export-person` decisions with evidence references | Your organization (assessment files); product (decision records) |
| CGP-10-e(i): security plan procedures for examination, possession, transfer | Product sections a plan can cite (this design's sections 6 to 9, the published docs) | Your organization |
| CGP-10-h: breach within three days | Incident detection, clock display, contact notification | Shared |
| CGP-11 to 13: designated official, assessments | Positions and signing rules | Your organization |
| ITAR-120.54-a5: encrypted storage and transmission | Key groups (AES-256-GCM, X25519, keys only on members' devices), crypto inventory | Shared, **Partly met**: no FIPS-validated module (gap X8) |
| ITAR-120.56: no release to unauthorized foreign persons | Same as CGP-37-2 | Shared |
| ITAR-122.5: records five years, reproducible, changes attributed | Records, chain, export | Shared |
| ITAR-126.5, 126.18: Canadian and dual-national conditions | `export-person` bases and exclusions | Your organization |
| ITAR-127.12: voluntary disclosure | Incident flow | Your organization (product supports) |

### 10.2 Pages

The Accreditation section (`DESIGN.md`, section 10) gains two pages beside the level pages, **Controlled goods (Canada)** and **ITAR** (with EAR rows on the ITAR page). Each has the same filters, six states and per-row detail (official text, our statement, responsibility, evidence, gap with remediation, owner and phase). Each page opens with: "Meeting the Controlled Goods Program [the ITAR] is your organization's obligation. This page shows what the product does and what it leaves to you. Your counsel and your designated official [empowered official] decide."

### 10.3 Honesty rules

- The same status engine: no status is typed; Met needs a statement and fresh passing evidence; your organization's rows are never Met in the public view.
- The copy lint (coherence `GLOSSARY.md`, section 5) gains phrases that never appear about the product: "ITAR compliant", "ITAR certified", "CGP compliant", "CGP approved", "export compliant", "controlled goods approved".
- Rows about the TEE question and encrypted storage at third parties show **Unsettled** in their reason text, never Met, until your organization records its own legal basis in its private overlay.
- A self-signed decision ("self-signed on this computer") counts as Not met for every row that requires the official's signature.

## 11. Gaps today and the work to close them

| # | Gap | Remediation | Owner | Closes in |
|---|---|---|---|---|
| X1 | `CGP`, `ITAR`, `EAR` have no fixed meaning; nothing ties a compartment to a regime | `exportControl` section; reserved tokens; shown words | maintainers | Phase 41 (shape), Phase 45 (behaviour) |
| X2 | Clearances are self-declared; no signed person decision for export regimes | `export-person` kind; roster citations; `exportEligible` | maintainers | Phase 41 (kind), Phase 45; credentials in Phase 71 |
| X3 | Endpoints have `maxLabel` and `region` but no eligibility; an `org-plain` server reached by foreign administrators or in another country passes `local-only` today when named in `localHosts` | `export-endpoint` kind; `decideRoute` step 7 | maintainers | Phase 41 (kind and step slot), Phase 45 |
| X4 | Agent network tools are refused only by `no-agent-tools` (all tools), not by marking | Network-tool refusal from the outbound classification while the mark holds a reserved compartment | maintainers | Phase 45; full fence in Phase 72 |
| X5 | Decision records are not tamper-evident and cannot be exported (Phase 44 G2) | Phase 41 audit chain; export bundle | maintainers | Phase 41, Phase 45 |
| X6 | No retention rule; no content hash in records, so a later marking cannot find earlier sends | Never-auto-prune; earliest-prune computation; keyed content hash | maintainers | Phase 45 |
| X7 | No incident flow | Detection rules, lifecycle, clocks, contact notification | maintainers | Phase 45 |
| X8 | The product's encryption (AES-256-GCM, X25519, HKDF-SHA256 through `node:crypto`) is not run as a FIPS 140-validated module | Document the "comparable strength" basis in the crypto inventory (Phase 44); evaluate a FIPS-validated provider for the hub and the appliance, where the operating system can supply one | maintainers; your organization decides whether it suffices | Phase 44 (inventory); POA&M item |
| X9 | Setup has no export-control question; no `export-control` contact topic | Q2 choice, Q2c, Q2d, stop rule, copy | maintainers | Phase 45 through Phase 32.1's question registry |
| X10 | The hub, data platform and relay do not know export decisions | One requirement line each (section 12) | maintainers | Phase 32 line (hub grants), data platform phases, Phase 75 |
| X11 | No overlays on the dashboard | Catalogues, mappings, pages | maintainers | Phase 44 |
| X12 | No published guidance for organizations | "Controlled goods and ITAR" page in the docs site: what the product does, what it does not, the interim settings below | maintainers | Phase 44 (docs) |

**Interim settings an organization can use on `main` today** (to go on the X12 page, worded as options for its officials, not advice): mark controlled files and folders with compartments `CGP`, `ITAR` or `EAR` through Set Label; in the signed policy set `routing.compartments` for those tokens to `local-only` and keep `routing.localHosts` empty or limited to servers its officials have approved; add the `no-agent-tools` handling flag to those labels; do not share such projects through Team Mode or the relay.

## 12. Where it lands

| Piece | Lands in | Why |
|---|---|---|
| Shapes that get signed into policies: the `exportControl` section (parsed, report mode), authorization kinds `export-person` and `export-endpoint`, the reserved tokens, the `route.export-control` rule id, the `export-control` contact topic, the shipped `routing.compartments` default | **Phase 41** (two small additions to FND-02 and FND-04) | Phase 41 settles bundle v2 and the authorization record ("settle their schemas in the first plan", undo cost medium to high). Adding the shapes there costs little and avoids a later `requires` feature and a schema change in signed policies. No behaviour beyond parsing and the routing default |
| Enforcement: `exportEligible`, `decideRoute` step 7, network-tool refusal, trust line and refusal copy, lowering rule, setup questions, records with keyed hashes, retention, incidents, export, docs page | **New Phase 45** after Phase 41 | It is a feature with its own tests and copy, touching the gate, records and setup; too large to put inside the foundation, and it must not delay Phase 41, which five phases wait on. It can run beside Phases 32.1 to 37 except the setup question file, which it adds through 32.1's question registry once that exists |
| Hub grants and access lists check export decisions | One requirement in the hub line (Phase 32 if still open, otherwise Phase 35 or the first hub phase after Phase 45) | The hub runs the same gate core; the check is one call |
| Data platform rows, specialists and reviewers | One requirement in the data platform's access phase (the "compartments, roles, access" core) | Labels on every row already carry compartments |
| Relay refusal | Phase 75 channel manifests | Where outbound content is checked |
| Verifiable person decisions with status lists | Phase 71 | Same as clearances |
| Overlays, requirement catalogues, mappings, pages, copy-lint phrases | **Phase 44** (ACCR-13, ACCR-14) | It owns `compliance/` and the Accreditation section |

## 13. Risks

| Risk | Mitigation |
|---|---|
| Readers take the product's controls as compliance, or this design as legal advice | Header and page banners; copy lint phrases; "your organization decides" on every page; Unsettled rows never Met |
| Controlled data is never marked, so nothing applies | Setup question with "Not sure" mapped to the stricter reading; legend suggestions; folder markings; session marks carry forward; the docs page says plainly that unmarked data is treated by its level only |
| A wrong eligibility decision (provider facts change) | Decisions expire within 365 days and end on region, operator or hosting change; incidents on revocation after use |
| The TEE question is answered by regulators later, either way | Kept as data: an `export-endpoint` decision with a `legalBasis`; nothing in code assumes an answer |
| Keyed hashes or file names leak through records | Records labelled with the compartment; HMAC under an install key; never content |
| Personal information in decisions | Only basis, extent, expiry and a reference; no citizenship or assessment content |
| Agents reach the network through a path the classifier misses | Partly met until Phase 72's fence; stated on the overlay |
| Regulation changes (PSPC's announced review of the CGR; ITAR rulemaking) | Requirement catalogues pinned by source hash with Phase 44's weekly change check |
| People work around refusals by pasting into a browser | Out of the product's reach; the docs page names it as your organization's DLP and training responsibility |

## 14. Open decisions with defaults

| # | Question | Default |
|---|---|---|
| E1 | Reserved compartment tokens | `CGP`, `ITAR`, `EAR`; your organization may add ordinary compartments for programme-specific need-to-know |
| E2 | Setup "Not sure" about which rules apply | Both `CGP` and `ITAR` |
| E3 | May any third-party model service ever be eligible? | Only through an `export-endpoint` decision signed by the official with a `legalBasis` reference; the product ships none and never suggests one |
| E4 | Does a TEE make an endpoint eligible by itself? | No; treated as unsettled (section 4.6) |
| E5 | For `CGP`, must an eligible endpoint be in Canada? | Yes by default; an exception needs a Global Affairs Canada consultation reference on the decision |
| E6 | Who signs person and endpoint decisions? | The holder of the regime's official position, listed in the organization layer; self-signed decisions work locally but show as such and count as Not met |
| E7 | Store citizenship or assessment details? | No; basis, extent, expiry and a reference only |
| E8 | Record retention | Never pruned automatically; pruning is a signed decision after the computed earliest date |
| E9 | Content hash in records | Yes, keyed (HMAC under an install key) |
| E10 | Agent network tools on controlled content | Refused, no override in v1 |
| E11 | Legend rules for suggested markings | Suggest, never automatic, unless your organization's policy makes a rule automatic |
| E12 | Store the DPA, CGR and CFR text in the repository | Yes, with source, hash and "unofficial representation"; PSPC guidance by link only |
| E13 | Phase placement | Shapes in Phase 41; enforcement in a new Phase 45; overlays in Phase 44 |

**Research flags for the phases:** the BIS cloud computing advisory opinions' holdings; whether DDTC or PSPC has published anything on AI services by the time Phase 45 is planned; the Export Control List Group 2 guide (Global Affairs Canada) for the legend rules; whether a FIPS 140-3 validated provider can be used by the hub's Node runtime on the target operating systems; how CPCSC Level 2 and 3 controls overlap these overlays.

## 15. Sources

Canada (retrieved 2026-11-20):

- Defence Production Act (Part 2, ss. 35 to 46, and the schedule): https://laws-lois.justice.gc.ca/eng/acts/D-1/FullText.html
- Controlled Goods Regulations, SOR/2001-32: https://laws-lois.justice.gc.ca/eng/regulations/SOR-2001-32/FullText.html
- Reproduction of Federal Law Order, SI/97-5: https://laws-lois.justice.gc.ca/eng/regulations/SI-97-5/page-1.html
- PSPC, What are controlled goods: https://www.canada.ca/en/public-services-procurement/services/industrial-security/controlled-goods/what-are-controlled-goods.html
- PSPC, Register in the CGP (examine, possession): https://www.canada.ca/en/public-services-procurement/services/industrial-security/controlled-goods/about-program/register.html
- PSPC, Guideline on registration: https://www.canada.ca/en/public-services-procurement/services/industrial-security/controlled-goods/about-program/register/guideline-program-registration.html
- PSPC, Guidance on using and providing cloud solutions: https://www.canada.ca/en/public-services-procurement/services/industrial-security/controlled-goods/program-requirements/guidance-using-providing-cloud-solutions.html
- PSPC, Security plan template: https://www.canada.ca/en/public-services-procurement/services/industrial-security/controlled-goods/program-requirements/developing-security-plan/template.html and guideline: https://www.canada.ca/en/public-services-procurement/services/industrial-security/controlled-goods/program-requirements/developing-security-plan/guideline.html
- PSPC, CGP roadmap: https://www.canada.ca/en/public-services-procurement/services/industrial-security/controlled-goods/program-resources/program-roadmap.html
- PSPC, Red tape reduction review: https://www.canada.ca/en/public-services-procurement/corporate/acts-regulations/red-tape-reduction-review.html

United States (retrieved 2026-11-20; eCFR current to 2026-11-18):

- ITAR part 120 (120.31, 120.33, 120.34, 120.50 to 120.56, 120.62, 120.63, 120.67): https://www.ecfr.gov/current/title-22/chapter-I/subchapter-M/part-120
- 120.54: https://www.ecfr.gov/current/title-22/chapter-I/subchapter-M/part-120/section-120.54
- Part 122 (122.1, 122.5): https://www.ecfr.gov/current/title-22/chapter-I/subchapter-M/part-122
- Part 126 (126.1, 126.5 and Supplement No. 1, 126.18): https://www.ecfr.gov/current/title-22/chapter-I/subchapter-M/part-126
- Part 127 (127.12): https://www.ecfr.gov/current/title-22/chapter-I/subchapter-M/part-127
- 84 FR 70887 (2019-12-26), the encryption and release rule and its preamble: https://www.federalregister.gov/d/2019-27438
- 90 FR 29720 (2025-07-07), Russia folded into 126.1: https://www.federalregister.gov/d/2025-12560
- EAR 734.13, 734.15, 734.18, 740.2, 742.4, 742.6: https://www.ecfr.gov/current/title-15/subtitle-B/chapter-VII/subchapter-C
- BIS advisory opinions (cloud computing, not verified here): https://www.bis.gov/advisory-opinions

Repository: `src/domain/gate/labels.ts`, `dominance.ts`, `routing.ts`, `record.ts` (label shape, dominance, compartment routing, records without content); `.planning/research/coherence/POLICY-SCHEMA.md`, `GLOSSARY.md`; `.planning/research/compliance-dashboard/DESIGN.md`; `.planning/research/guided-onboarding/DESIGN.md`; `.planning/research/model-provenance/DESIGN.md`; `.planning/research/cohere-model-vault/DESIGN.md`; `.planning/research/data-platform/00-DESIGN.md`; `.planning/research/multiuser-sync/DESIGN.md`.
