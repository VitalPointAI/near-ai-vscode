# Sovereignty status badge and card: Canadian criteria, dimensions and evidence

**Researched:** 2026-11-25, on branch `docs/research-sovereignty-status` from `origin/main` at fba66ee7.
**Status:** research for planning. Docs only: nothing here is built.
**Owner request (2026-11-25, verbatim):** "we need a badge on every page that acts like a sovereignty status badge. When clicked, it opens and shows sovereign status of the system as defined in Canadian sovereignty terms: model origin, keys held, data residency, hardware/softwareBoM location and attestation and anything else that Canadian sovereignty policy for digital and AI holds as the standard for what constitutes sovereign AI - research that and include that status card seeing as we pin the credibility of our product on it."
**Confidence:** HIGH for the Canadian control text (read from the ITSP.10.033 catalogue in this repository and from canada.ca and cyber.gc.ca pages fetched today); MEDIUM for 2026 policy statements (read from official pages, but some details came from page summaries); LOW where marked `[ASSUMED]`.

**How sources are tagged.** `[CITED: url, page date]` is an official page fetched on 2026-11-25 (page date as the page shows it). `[repo: path]` is a file read on `origin/main` today. `[secondary: url]` is a reputable non-official source. `[ASSUMED]` is not verified this session and is listed in section 12. Restricted texts in `docs/references/` are not quoted.

---

## 1. Key points first

1. **Canada has no single legal definition of "sovereign AI".** The federal AI minister has said publicly that the government is still working out the definition [secondary: https://betakit.com/canadian-sovereign-cloud-evan-solomon-all-in/]. The card therefore must not award a label. It should show, dimension by dimension, which published Canadian criterion is met, with the evidence and its source.
2. **The most authoritative and testable Canadian criteria are the Cyber Centre's own sovereignty controls.** ITSP.10.033 (catalogue in force 2026-03-31) has a Canadian control family, **SA-400 "Sovereignty and jurisdiction"**, with nine enhancements: threat and risk assessment, legal and contractual assessment, jurisdiction marking, data at rest, data in transit, data in use, extraterritorial compulsion, business lifecycle, and public ownership. It also has **SA-9(8)**, which keeps processing and storage within Canada [repo: `compliance/catalogs/itsp-10-033/catalog.json`]. The Medium profile (ITSP.10.033-01) selects SA-400 and SA-9(8) [repo: `compliance/profiles/itsp-10-033-01-medium.json`]. These controls are the backbone of the card.
3. **The policy layer agrees with the controls.**
   - The TBS Digital Sovereignty Framework (2025-11-12) defines digital sovereignty as the Government of Canada's ability to exercise autonomy over its digital infrastructure, data and intellectual property. It also says that full legal control comes only from self-delivery or from providers operating entirely under Canadian jurisdiction.
   - The 2018 white paper says the Government of Canada should "maintain exclusive control of the encryption keys".
   - Directive on Service and Digital 4.4.3.14 makes Canadian facilities the principal option for Protected B, Protected C and Classified data.
   - The national AI strategy *AI for All* (June 2026) says sovereign AI infrastructure "must be operated under Canadian control and Canadian law" and must not depend on "platforms that can be restricted or withdrawn at the discretion of a foreign government".
   - The Defence Industrial Strategy (February 2026) names "Secure Cloud" and "Artificial Intelligence" as Key Sovereign Capabilities. It warns about foreign restrictions on access to "IP, schematics and software updates".
4. **Proposed: 14 dimensions in four groups**, aligned with the four domains of the national standard CAN/DGSI 100-8 (second edition, 2026) as its SovereignReady programme describes them (data, operational, technological, organizational readiness):
   - **Data:** where data is stored, where data travels, where AI runs, who holds the keys, Canada-only handling rule.
   - **Technology:** where models come from, where the software comes from, where the hardware comes from.
   - **Operations:** who runs it, who issues identities, what can leave the site, who can switch it off.
   - **Governance:** which laws apply to outside services, and the assessments and authorization.
5. **Each dimension uses the Compliance view's own state words:** Met, Partly met, Not met, Unknown, Not verified, and Your organization's responsibility. The badge shows the **weakest** dimension (as the EU Cloud Sovereignty Framework uses minimum levels per objective), plus a count and a reason. It shows no score and never says "sovereign" as a verdict.
6. **Where SovAI is not sovereign today, plainly:**
   - The shipped default models are PRC-origin (GLM-5.3, Kimi K3, Qwen 3.6).
   - NEAR AI Cloud publishes no data-centre location, operating entity or retention terms, and its private hardware's roots of trust are US vendors' (Intel TDX and NVIDIA confidential computing).
   - The only Canadian-origin model family (Cohere Command A+) is not on NEAR, and the Cohere vault's attested ("Encrypted") kind is US-only.
   - Our build and release channel is GitHub and GHCR, which are US services.
   - The organization site key is in SoftHSM2. No HSM certificate is recorded, and OpenBao has no FIPS-validated build.
   - No site records its own location, operator or hardware.
   - No outside service has a jurisdiction recorded.
   - The SA-400 assessment and the SA-9(8) evidence are open gaps (G117, G111).
7. **What can be made genuinely strong:**
   - The on-premise stack runs with no outbound calls and is updated from a signed offline bundle.
   - Keys are generated and held at the site.
   - Identities are issued by your organization.
   - The egress allow-list is empty by default.
   - A local or organization-hosted model with a passport and an artifact hash gives full control of inference.

   With a Canadian-origin open-weight model (Command A+, Apache-2.0 per the 74.1 licence check) on your organization's own hardware in Canada, every data dimension can reach Met.
8. **The card must be built on the 48.2 evidence machinery, not beside it.** That means the one status engine re-judged against the clock, the release and site evidence layers, the Verified / Not verified / Did not verify outcomes, and the freshness words. Facts software cannot prove (the facility's country, who operates it, the hardware's origin, the HSM certificate) arrive as **operator-signed site declarations**. They are shown as "declared by {name}, signed", never as "verified location".
9. **The words "sovereign", "sovereignty" and "residency" are currently in the glossary's "never on main screens" column.** The badge needs a coherence-review amendment before it is built. The product's name contains "Sovereign", so the copy lint should also refuse overclaims ("fully sovereign", "100% Canadian", "sovereign by default").
10. **Twelve owner questions are in section 10, each with a recommended default.**

---

## 2. The Canadian criteria

### 2.1 Definitions Canada publishes

| Term | Canadian definition | Source |
|---|---|---|
| Digital sovereignty | The Government of Canada's ability to exercise autonomy over its digital infrastructure, data and intellectual property, and to make independent decisions about them "regardless of where technologies are developed, hosted, or supported". Complete sovereignty ("digital autonomy") is said not to be achievable. | TBS, *Digital Sovereignty: A Framework to improve digital readiness of the Government of Canada* [CITED: https://www.canada.ca/en/government/system/digital-government/digital-government-innovations/cloud-services/digital-sovereignty/digital-sovereignty-framework-improve-digital-readiness.html, page date 2025-11-12] |
| Data sovereignty | "Canada's right to control access to and disclosure of digital information that is subject to its legislation." | ITSP.10.033, SA-400 discussion [repo: `compliance/catalogs/itsp-10-033/catalog.json`, control `sa-400`]. The 2018 TBS white paper words it "...subject only to Canadian laws" [CITED: https://www.canada.ca/en/government/system/digital-government/digital-government-innovations/cloud-services/digital-sovereignty/gc-white-paper-data-sovereignty-public-cloud.html, page modified 2026-04-23] |
| Data residency | "the physical or geographical location of an organization's data while at rest." | ITSP.10.033, SA-400 [repo] |
| Jurisdiction | "a realm of authority, which in this context, references the ability to compel compliance from entities within that realm as the key threat." | ITSP.10.033, SA-400 [repo] |
| Sovereign capability (defence) | "Sovereign capabilities are those without which Canada cannot defend its sovereignty or meet its allied commitments." | *Canada's Defence Industrial Strategy* [CITED: https://www.canada.ca/en/department-national-defence/corporate/reports-publications/industrial-strategy/security-sovereignty-prosperity.html, 2026, Cat. D2-719/2026E-PDF] |
| Sovereign AI compute (programme wording) | A "Canadian-located, Canadian-governed system that ensures data residency, operational control, and decision-making authority". | AI Sovereign Compute Infrastructure Program [CITED: https://ised-isde.canada.ca/site/ised/en/ai-sovereign-compute-infrastructure-program, page date 2026-06-01] |
| Sovereign AI (strategy) | No formal definition. "Sovereignty in the AI era depends on three foundations": compute, cloud and connectivity; data; talent. "Sovereign AI starts with sovereign infrastructure", which "must be operated under Canadian control and Canadian law" and must not depend on "platforms that can be restricted or withdrawn at the discretion of a foreign government". | *Canada's National Artificial Intelligence Strategy: AI for All* [CITED: https://ised-isde.canada.ca/site/ised/en/canadas-national-artificial-intelligence-strategy-ai-all, page date 2026-06-08] |

**Consequence for the card.** Canada's definitions are about **control and legal compulsion**, not only location. ITSP.10.033 says it directly: "Exposure of a business function to a different legal jurisdiction can effectively remove sovereign legal barriers", and "Legal compulsion by sophisticated jurisdictions is exceedingly effective at bypassing other controls" [repo: `sa-400`]. The TBS framework adds that "Using a Canadian supplier or storing data in Canada does not guarantee data will be outside the jurisdiction" of foreign courts [CITED: framework, 2025-11-12]. A card that checks only "data in Canada" would overclaim.

### 2.2 Government of Canada digital sovereignty

**TBS white paper, *Data Sovereignty and Public Cloud* (2018; page modified 2026-04-23).** This paper says commercial public cloud can protect data up to Protected B under conditions, but "Canada cannot ensure full sovereignty over its data when it stores data in the cloud". While a provider operating in Canada is subject to a foreign country's laws, "Canada will not have full sovereignty over its data". Residency "does not mitigate against the application of foreign laws". It names US FISA as the primary risk. Mitigations: encrypt protected data in transit and at rest, and "maintain exclusive control of the encryption keys". The page notes that the 2025 framework is now the latest guidance. [CITED: white paper URL above]

**TBS *Digital Sovereignty* framework (2025-11-12).**
- Scope: Protected B and below.
- Risks named: data (legal control only through self-delivery or providers operating entirely under Canadian jurisdiction), global supplier dependence ("can also affect access to software, updates, or technical support"), and critical systems maintained outside Government of Canada control.
- Controls named: contract clauses on data access and disclosure, deplatforming risk, supplier diversification, supply chain visibility, open standards, vendor-neutral formats, "GC-controlled environments", reduced reliance on proprietary technology, and continuity and recovery "through alternate delivery methods".
- Next steps include "Ensuring transparency about operational control with all vendors, domestic and foreign".
- The CLOUD Act and FISA are named in footnote 1 as examples of US law. [CITED: framework URL above]

**Directive on Service and Digital, requirement 4.4.3.14.** Computing facilities in Canada (or in Government of Canada premises abroad) are to "be identified and evaluated as a principal delivery option for all sensitive electronic information and data under government control that has been categorized as Protected B, Protected C or is Classified". This is quoted by the Government of Canada Cloud Guardrails, whose validation asks departments to "Demonstrate that the service location is within Canada for all Protected B cloud services where configurable" [CITED: https://canada-ca.github.io/cloud-guardrails/EN/05_Data-Location.html]. The older *Direction for Electronic Data Residency* is archived and replaced by 4.4.3.14 [secondary: search result text of the canada.ca direction page; the page itself returned 404 today]. The policy instrument page at tbs-sct.canada.ca refused automated access today, so the requirement's wording is from the guardrail quotation. Note the wording: "principal delivery option", not an absolute ban. The departmental CIO decides exceptions [secondary: Guideline on Service and Digital as summarized in search results].

**SPIN 2017-01, *Direction on the Secure Use of Commercial Cloud Services*** (effective 2017-11-01, modified 2022-06-23). It covers Protected B / Medium / Medium. Its data residency section points to the Directive on Service and Digital. Its key management section says "Robust key management processes and procedures are also essential" but does not require Government of Canada-held keys [CITED: https://www.canada.ca/en/government/system/digital-government/modern-emerging-technologies/direction-secure-use-commercial-cloud-services-spin.html].

**Sovereign cloud procurement (2026).**
- A Shared Services Canada Question Period note (received 2026-02-09) says SSC "has launched a procurement process to establish Sovereign Canadian Cloud capabilities" that "prioritizes Canadian-owned and controlled cloud service providers". It gives no definition or criteria. It also records SSC's use of Supply Chain Integrity reviews since 2012, the up to $240 million AI Compute Challenge award to Cohere (March 2025) and a memorandum of understanding with Cohere on AI across government (August 2025) [CITED: https://search.open.canada.ca/qpnotes/record/ssc-spc%2CSSC-2026-QP-0902].
- Budget 2025 proposed about $925.6 million over five years for sovereign public AI infrastructure [secondary: https://mobilesyrup.com/2025/11/05/federal-budget-proposes-1-billion-go-towards-canada-ai/].
- ISED's *Enabling large-scale sovereign AI data centres* initiative led to a TELUS memorandum (May 2026) [CITED: https://www.canada.ca/en/innovation-science-economic-development/news/2026/05/government-of-canada-and-telus-advance-work-to-build-sovereign-ai-infrastructure.html (title and date from search result)].

**No published "Canadian sovereign cloud" definition was found.** The closest official wordings are "Canadian-owned and controlled" (SSC) and "Canadian-located, Canadian-governed ... data residency, operational control, and decision-making authority" (ISED AI SCIP).

### 2.3 Canadian Centre for Cyber Security

**ITSP.10.033, SA-400 family.** This is the most important source. The catalogue is stored in this repository under the Open Government Licence - Canada, retrieved 2026-11-21 [repo: `compliance/catalogs/NOTICE`]. Paraphrased with key words quoted:

| Control | Requirement (short) | Notes that matter for the card |
|---|---|---|
| SA-400 | A sovereignty and jurisdiction threat and risk assessment at organization, mission or system level: injury from "external legal compulsion", jurisdiction-specific threat, vulnerability and risk assessments. | "An organization simply may not be at liberty to take a risk management approach (e.g., due to legislative mandate or indigenous data sovereignty)". |
| SA-400(1) | Threat and risk assessment for data sovereignty, across the four surfaces of ITSP.10.037 (logical, physical, personnel, lifecycle). | |
| SA-400(2) | Legal and contractual assessment. | "any compulsive legislation is likely to take precedence over protective contracts or legislation". |
| SA-400(3) | Business process attribute marking. | Example markings: "Canadian Jurisdiction Only", "Sovereign Indigenous". |
| SA-400(4) | Data at rest: "Prevent data from residing in any other legal jurisdiction." | "If the data could, even momentarily, be written to non-volatile media, it must be considered at rest", including core dumps, swap, disaster recovery and decommissioning. |
| SA-400(5) | Data in transit: "Prevent data from transiting through any other legal jurisdiction." | |
| SA-400(6) | Data in use: "Prevent data from being used in any other legal jurisdiction." | "There is currently no approved method of encryption to protect data in use"; homomorphic encryption counts as cleartext. This is the inference-location criterion. |
| SA-400(7) | Extraterritorial compulsion: prevent compromise "by individuals or corporations that are being compelled by a different legal jurisdiction". | Covers loyalty, affiliated corporations and dual nationality. Related: MA-5. |
| SA-400(8) | Business lifecycle: prevent compromise by "lifecycle attacks embedded via legal compulsion". | "Most current systems contain elements from multiple legal jurisdictions, and a risk-based approach will be required"; "Strong network isolation is recommended as a compensating control". This is the hardware, software and model origin criterion. |
| SA-400(9) | Public ownership: arrangements "under Canadian public ownership for the entire lifespan of the system". | The strictest bar: ownership transfer of suppliers. |
| SA-9(5) | Restrict processing, storage and service location to organization-defined locations. | |
| SA-9(8) | "Restrict the geographic location of information processing and data storage to facilities located within the legal jurisdictional boundary of Canada." | Its discussion is written for high-impact information. |

The Medium profile selects SA-400 (base only) and SA-9(1), SA-9(2) and SA-9(8). It selects none of the SA-400 enhancements [repo: `compliance/profiles/itsp-10-033-01-medium.json`, checked by search for the ids]. The enhancements are still the clearest published statement of what "sovereign" means in Canadian security terms, so the card uses them as criteria. It labels them "criteria from ITSP.10.033", not "required by your profile".

**ITSP.40.111 v5** (effective 2026-05-29) [CITED: https://cyber.gc.ca/en/guidance/cryptographic-algorithms-unclassified-protected-protected-b-information-itsp40111]:
- Approves ML-KEM-512/768/1024 and ML-DSA-44/65/87, and EdDSA on Edwards25519 and Edwards448.
- Lists key establishment by elliptic-curve CDH and MQV on P-224 to P-521 only (X25519 is not listed).
- Section 13: modules "should be tested and validated under the Cryptographic Module Validation Program (CMVP)". This is a recommendation, not a requirement.
- Quantum-vulnerable schemes without a post-quantum partner are to be phased out by the end of 2035.

**Key custody.** The Government of Canada *Considerations for the Use of Cryptography in Commercial Cloud Services* (2019; page details 2025-10-22) defines three models [CITED: https://www.canada.ca/en/government/system/digital-government/digital-government-innovations/cloud-services/government-canada-consideration-use-cryptography-in-cloud.html]:
- KM-1, CSP-controlled keys ("The CSP has the ability to access the cryptographic keys and decrypt the data").
- KM-2, consumer-managed keys (the CSP can still access them).
- KM-3, consumer-controlled keys ("The CSP has no access to the cryptographic keys").

ITSP.50.106 (2020) says the same in section 3.3 [CITED: https://cyber.gc.ca/en/guidance/guidance-cloud-service-cryptography-itsp50106]:
- Bring-your-own-key is not consumer control: "Once you export the keys to a cloud KMS, they are accessible by the CSP".
- For organizations with "rigid compliance and regulatory requirements, we do not recommend" CSP-controlled keys.
- A third-party key manager can "separate the control of key material from the control of data".

ITSP.50.106 does not mention FIPS 140. The 2019 considerations page says "CSE recommends using cryptographic modules that have been validated under the Cryptographic Module Validation Program".

**Cloud assessment.** ITSP.50.105 (2020) says cloud assessment "is a shared responsibility", lists "data residency" among contract items, and notes that FedRAMP assessments never cover operation outside the United States [CITED: https://cyber.gc.ca/en/guidance/guidance-cloud-security-assessment-and-authorization-itsp50105]. The CCCS cloud service provider assessment programme (ITSM.50.100) was not fetched this session (see A3).

**Supply chain.**
- ITSAP.10.071, *Supply chain integrity risk assessments: Evaluation criteria* (2026-04-07), lists seven criteria: "Geopolitical context" (including surveillance and data residency laws, manufacturing locations, adversarial nations), "Foreign ownership, control and influence", "Business practices", "Cyber maturity", "Product vulnerability", "Exploitation of vulnerabilities" and "Product sensitivity" [CITED: https://cyber.gc.ca/en/guidance/supply-chain-integrity-risk-assessments-evaluation-criteria-itsap10071].
- ITSM.10.071 covers software supply chain threats [CITED: https://cyber.gc.ca/en/guidance/protecting-your-organization-software-supply-chain-threats-itsm10071].
- The Cyber Centre joined the CISA-led joint guidance on SBOMs: *A shared vision of SBOM for cyber security* (September 2025) [CITED: https://cyber.gc.ca/en/news-events/joint-guidance-shared-vision-software-bill-materials-cyber-security] and *2026 Minimum Elements for a Software Bill of Materials* (page modified 2026-07-29) [CITED: https://cyber.gc.ca/en/news-events/joint-guidance-minimum-elements-software-bill-materials].

**AI security guidance the Cyber Centre co-signed.**
- *Building trust in AI through a cyber risk-based approach*, with ANSSI (page modified 2025-02-04). It recommends "mapping the AI supply chain" and names "long-term loss of control over information systems" as a risk [CITED: https://www.cyber.gc.ca/en/news-events/joint-guidance-building-trust-artificial-intelligence-through-cyber-risk-based-approach].
- *Supply chain risks and mitigations for AI and machine learning* (page modified 2026-03-05): "using pre-trained models and third-party data sets can introduce unique supply chain risks" [CITED: https://www.cyber.gc.ca/en/news-events/joint-guidance-supply-chain-risks-mitigations-artificial-intelligence-machine-learning].

### 2.4 Canada's AI policy

- **National AI strategy *AI for All*** (page date 2026-06-08; released 2026-06-04 per [secondary: https://www.bakermckenzie.com/en/insight/publications/2026/06/canada-federal-government-releases-refreshed-national-ai-strategy]).
  - Pillar 4 is "Building the Canadian sovereign AI foundation".
  - Quotes: the infrastructure "must be operated under Canadian control and Canadian law", it must not rely on "platforms that can be restricted or withdrawn at the discretion of a foreign government", and "Canada will anchor its homegrown foundation model capabilities at home" (Cohere is named).
  - It also says "Canadian companies store sensitive data in foreign jurisdictions" and that such data "can be subject to decisions, rules, and legal regimes beyond Canada's direct control".
  - It plans investment in "sovereign cloud, AI, cyber and quantum initiatives" for government operations [CITED: ISED strategy URL above].
- **AI Sovereign Compute Infrastructure Program** (closed 2026-06-01). Its sovereignty wording is in section 2.1. Eligibility is limited to Canadian not-for-profits and post-secondary institutions "to uphold the program's sovereignty requirements" [CITED: ISED SCIP URL above]. One law firm summary says proposals needed Canadian ownership or legally enforceable control over the facility's full lifecycle [secondary: https://www.torys.com/our-latest-thinking/publications/2026/05/canada-launches-ai-scip].
- **AI Strategy for the Federal Public Service 2025-2027** (page date 2026-10-02).
  - Priority 1 supports Canadian suppliers to "ensure secure sovereign infrastructure and solutions".
  - It describes CANChat as keeping "all data is safeguarded and stored in Canada".
  - It lists "Technological sovereignty" among adoption challenges.
  - The planned governance framework includes "shutdown measures for emergencies" [CITED: https://www.canada.ca/en/government/system/digital-government/digital-government-innovations/responsible-use-ai/gc-ai-strategy-full-text.html].
- **Guide on the use of generative AI** (page date 2026-09-24).
  - "Don't enter sensitive or personal information into any tools not managed by the GC."
  - It flags "input data being stored on servers not controlled by the GC".
  - "Consider the requirements for information and data residency in the Directive on Service and Digital."
  - FASTER: "Secure: ensure that the infrastructure and tools are appropriate for the security classification of the information"; "Transparent: identify content that has been produced using generative AI" [CITED: https://www.canada.ca/en/government/system/digital-government/digital-government-innovations/responsible-use-ai/guide-use-generative-ai.html].
- **Directive on Automated Decision-Making.** It applies to systems that make or assist administrative decisions, and needs an Algorithmic Impact Assessment kept up to date (6.1.3). It was amended in 2025; the exact effective date was not confirmed today [CITED: https://www.canada.ca/en/government/system/digital-government/policies-standards/policy-service-digital-announcements/amendments-directive-automated-decision-making.html (title from search result)]. It is not a sovereignty criterion, but its transparency duties overlap with model provenance.
- **Voluntary Code of Conduct on advanced generative AI** (September 2023; page modified 2026-06-04). Principles: accountability, safety, fairness and equity, transparency, human oversight and monitoring, validity and robustness. Developers of public systems "Publish a description of the types of training data used" [CITED: https://ised-isde.canada.ca/site/ised/en/voluntary-code-conduct-responsible-development-and-management-advanced-generative-ai-systems]. This is relevant to the model provenance row.
- **AIDA** died with Bill C-27 at prorogation in January 2025. No standalone successor has been tabled. The June 2026 strategy points to several bills instead: Bill C-36 (*Protecting Privacy and Consumer Data Act*, tabled 2026-06-15, would replace PIPEDA and add automated-decision rules) and Bill C-34 (online safety) [secondary: https://www.dlapiper.com/insights/publications/2026/06/canada-tables-bill-c36-the-protecting-privacy-and-consumer-data-act; https://www.canadianlawyermag.com/news/general/artificial-intelligence-and-data-act-replacement-unlikely-under-new-national-ai-strategy-lawyers/394177]. Their status after July 2026 was not checked (A5).

### 2.5 DND/CAF

- **DND/CAF AI Strategy** (2024-03-11). The guiding principles require "appropriately classified data", "full consideration of Data Centric Security", "a secure space for AI application development", explainable and transparent outcomes, and building on Canadian strengths to "ensure sovereign AI foundations and capabilities" [CITED: https://www.canada.ca/en/department-national-defence/corporate/reports-publications/dnd-caf-artificial-intelligence-strategy/guiding-principles.html].
- **Defence Industrial Strategy** (February 2026). Key Sovereign Capability 3, "Digital Systems", includes "Secure Cloud; Artificial Intelligence; Quantum Computing and Communications".
  - "The Government recognizes IP and data as foundational to sovereign capability."
  - Foreign control "can lead to restrictions on the end-user having access to the needed IP, schematics and software updates".
  - For foreign purchases Canada will ensure "Canadian sovereign control over the operation and sustainment" [CITED: Defence Industrial Strategy URL above].
- **Not found:** no public CANSOFCOM AI or data-sovereignty requirement, and the Defence Data Strategy text was not retrieved this session (A6). The 2024 defence policy update *Our North, Strong and Free* was not checked for AI-sovereignty language (A6).

### 2.6 Standards bodies

- **CAN/DGSI 100-8, *Data Governance, Part 8: Framework for Digital Sovereignty*** (first edition 2023 "Framework for Geo-Residency and Sovereignty"; second edition "Revised 2026", listed as published with conformity assessment) [CITED: https://dgc-cgn.org/product/can-dgsi-100-8/]. The second edition adds a sovereignty assessment framework, guidance on AI and digital platforms, jurisdictional risk and third-party governance, and separates national from organizational sovereignty [secondary: https://www.lexpert.ca/news/technology-law/dgsi-expands-guidance-for-emerging-technologies-in-revised-national-standard-on-digital-sovereignty/394421, 2026-07-14]. The standard's text was not read this session (A2).
- **SovereignReady** (Digital Governance Council) assesses four domains: data sovereignty, operational sovereignty, technological sovereignty, and organizational readiness and risk management. Successful organizations receive "a statement of validation or verification and associated Trustmark"; review-level statements say "no significant issues were detected"; audit-level statements give "a positive conclusion" [CITED: https://dgc-cgn.org/product/sovereign-ready/]. This is the closest Canadian precedent for a sovereignty "badge": it is issued by an assessor, with stated assurance levels.
- **Standards Council of Canada** lists CAN/DGSI 100-8:2023 [CITED: https://ccn-scc.ca/standardsdb/standards/4031949 (from search result)].

### 2.7 Related law and policy

- **Export control.** This repository already has an accepted design for the Controlled Goods Program, ITAR and EAR: compartments, `export-person` and `export-endpoint` authorizations, CGP endpoints in Canada unless a consultation is cited, and "a TEE alone is not eligible" [repo: `.planning/research/compliance-dashboard/CGP-ITAR.md`, per the owner decisions recorded in PR #146]. The card's "which laws apply" row reads these markings; it does not re-decide them. This is not legal advice.
- **Privacy.** The Privacy Act and PIPEDA govern personal information; Bill C-36 would replace PIPEDA (section 2.4). For the card, privacy law is an input to the SA-400 assessment (which laws require data not be disclosed), not a separate dimension.
- **Foreign access as Canadian guidance frames it.**
  - The 2018 white paper names FISA.
  - The 2025 framework footnote names the CLOUD Act and FISA as examples.
  - ITSP.10.033 SA-400(2) warns that compulsive legislation is likely to override protective contracts, and SA-400(7) adds compulsion of individuals and corporations.
  - FISA section 702 was extended short-term in April 2026 [secondary: https://cyberscoop.com/congress-extends-section-702-surveillance-45-days/]. Its status after mid-2026 was not verified (A5).
  - The card should not track foreign statutes. It should record, per outside service, the jurisdictions that apply to its operator, which is what SA-400(2) and SA-400(7) ask.

### 2.8 Allied frameworks, for comparison only

**EU Cloud Sovereignty Framework, version 1.2.1 (October 2025)**, Directorate-General for Digital Services [CITED: https://commission.europa.eu/document/download/09579818-64a6-4dd5-9577-446ab6219113_en?filename=Cloud-Sovereignty-Framework.pdf, text extracted from the PDF today]:
- Eight objectives with scoring weights: SOV-1 Strategic (15%), SOV-2 Legal and Jurisdictional (10%), SOV-3 Data and AI (10%), SOV-4 Operational (15%), SOV-5 Supply Chain (20%), SOV-6 Technology (15%), SOV-7 Security and Compliance (10%), SOV-8 Environmental (5%).
- Five assurance levels:
  - SEAL-0 "No Sovereignty"
  - SEAL-1 "Jurisdictional Sovereignty"
  - SEAL-2 "Data Sovereignty"
  - SEAL-3 "Digital Resilience"
  - SEAL-4 "Full Digital Sovereignty: Technology and operations under complete EU control, subject only to EU law, with no critical non-EU dependencies".
- The SEAL "is used as a Minimum Assurance Level" per objective. Tenders "that do not offer the required (minimum) levels of assurance consistently across all objectives will be rejected", and "Material weaknesses identified in one or more contributing factor will result in lowering the overall assurance level recognized for the objective". The weighted score only sorts the tenders that pass.
- Contributing factors that map well to SovAI:
  - SOV-1: "Ability to sustain secure operations against requests to cease or suspend the service, or if vendor support is withdrawn".
  - SOV-3: "only the customer, not the provider, has effective control over cryptographic access to their data"; "auditability of AI model usage"; "Extent to which AI models and data pipelines are developed, trained, hosted, and governed under EU control".
  - SOV-5: "Geographic source of key physical parts"; "Jurisdiction and provenance of embedded code controlling hardware, firmware"; "location and jurisdiction governing software packaging, distribution, and updates".
  - SOV-7: "ability to develop, test, and apply security patches independently of non-EU vendors".
- The Commission's explainer (2026-06-01) says the overall score uses 48 criteria in eight categories. In the April 2026 tender, several providers reached SEAL-3 and one reached SEAL-2 [CITED: https://commission.europa.eu/news-and-media/news/sovereign-cloud-framework-explained-2026-06-01_en].

**France SecNumCloud 3.2** (2022-03-08). Section 19.6 adds protection against extra-European law, including ownership limits. Secondary sources give 24% individual and 39% collective non-EU ownership caps, but they disagree, so the figures are unconfirmed [secondary: https://scalingo.com/blog/referentiel-secnumcloud-3-2-evolutions-futur; official PDF https://cyber.gouv.fr/uploads/2014/12/secnumcloud-referentiel-exigences-v3.2.pdf not read]. **Gaia-X labels**: Level 1 is self-declared; Levels 2 and 3 need third-party attestation; Level 3 requires EU headquarters and no access from outside the EEA [secondary: https://gaia-x.eu/wp-content/uploads/2024/09/Compliance-Document_Marketing-Summary-2024.pdf]. **BSI C5** was not checked (A7).

**Lessons for the card.**
1. Credible schemes judge each objective separately and take the **minimum**, never an average. A weighted score is a ranking aid, not a verdict.
2. Every credible label is **issued by an assessor**, with an assurance level (self-declared, reviewed, audited). SovAI's card is a self-check from evidence, so it must say so, and it must show what is declared versus verified.
3. Supply chain (hardware, firmware, software packaging and updates) carries the highest EU weight, and it is the dimension where no Canadian product can claim full sovereignty today.
4. "Can it keep running if the foreign vendor stops?" is a first-class criterion in Canada (*AI for All*, TBS framework, Defence Industrial Strategy) and in the EU (SOV-1, SOV-7).

---

## 3. Dimensions and levels

### 3.1 Levels and rules

The card reuses the Compliance view's words (48.2 UI-SPEC, "Display state": "Met, Partly met, Not met, Stale, Not applicable, Your organization's responsibility", with "Not verified" in place of any state whose evidence is unverified) [repo: `.planning/phases/48.2-live-compliance-evidence-in-the-workbench/48.2-UI-SPEC.md`, lines 272-282]. It adds one word, **Unknown**, for "no evidence at all".

| State | Meaning on this card | Counts toward the badge as |
|---|---|---|
| **Met** | The Canadian criterion is met, and every input is verified evidence or a signed declaration within its freshness window. | Met |
| **Partly met** | Met in some respects, with a named shortfall. Examples: located in Canada but operated by a third party; allied rather than Canadian origin; keys held by your organization but not in a validated module. | Partly met |
| **Not met** | Evidence shows the criterion is not met. Examples: a reachable model service outside Canada; a PRC-origin model allowed beyond research use. | Not met |
| **Unknown** | There is no evidence either way. For example, a provider publishes no location. Unknown never reads as Met. | Unknown (ranked between Not met and Partly met for the badge) |
| **Not verified** | Evidence exists but did not verify (no configured key, expired signer). The card shows "Would be {state} if verified" only in the detail pane (48.2 D-18). | Not verified |
| **Stale** | The evidence is past its out-of-date threshold (48.2 D-12). | Stale |
| **Your organization's responsibility** | Only your organization can do it (for example, the SA-400 assessment, personnel screening). Shown with the gap id and what to do. | Not met until your organization records it |
| **Not used** | The dimension cannot apply. For example, no outside AI service is reachable under your rules, so "outside service jurisdiction" for AI is not used. | Ignored |

Rules:
1. **Worst-of.** The badge shows the worst state across all dimensions, in this order: Not met, then Unknown, then Not verified, then Stale, then Your organization's responsibility, then Partly met, then Met. It never averages or scores. (EU CSF lesson 1.)
2. **Judged against the Canadian criterion, not against your rules.** Your organization's rules may allow NEAR AI Cloud for Organization: Internal chat. That is allowed, but it is not Canadian control. The row says both: "Not met: runs outside Canada's control. Your organization's rules allow this for Organization: Internal." (Owner question Q1.)
3. **Exposure, not last use.** A dimension is judged on what this session **can** reach under the rules in force now (allowed endpoints, egress allow-list, allowed models), not only on what it used last. Per-answer facts stay in the trust line on each answer (CLAS-08). (Q3.)
4. **Declared is not verified.** Facts software cannot prove (the country of the facility, who operates it, hardware make and origin, HSM certificate, backup site location) count only as signed site declarations. They show as "Declared by {name} on {date}, signed with your site key". They can reach Met, but the detail pane always says "declared". Attestation proves code and weights, not location (model provenance DESIGN 8.3).
5. **Nothing is Met without a source and a time.** Every row shows source, as-of time, freshness and verification, exactly as Compliance view cells do (48.2 D-05).

### 3.2 The 14 dimensions

User words are proposals for the coherence review (section 6.5). Each "Feeds" cell lists evidence SovAI already has or can add.

#### Data

| # | Dimension (user words) | Canadian criterion and source | Met | Partly met | Not met | Feeds |
|---|---|---|---|---|---|---|
| D1 | **Where your data is stored** (at rest, including logs, telemetry, caches, swap, backups, decommissioning) | SA-400(4); SA-9(8); DSD 4.4.3.14; TBS white paper (residency does not stop foreign law) | Every store at a facility in Canada declared by the site; logs at the site; telemetry off and proven; backups and the off-site copy declared in Canada; no outside AI service retains prompts, or each retention is declared in Canada | Stores in Canada, but an outside AI service's retention is in Canada by contract only, or the off-site copy is not declared | A reachable outside service stores data outside Canada | Site declaration (new); storage class encrypted (47 D-17); log store at the site (47 D-19); telemetry off (46 D-26 and its container egress test); recovery settings (site file `recovery`); endpoint `region` per outside service |
| D2 | **Where data travels** (in transit) | SA-400(5); SC-8 | No exchange leaves the site (empty egress allow-list), or every outside exchange ends at a Canadian place on your organization's own network | Encrypted to a Canadian endpoint over the public internet: the path is not controlled | An outside exchange ends outside Canada | `compliance/hosted/exchanges.json` (15 exchanges, from/to/protection); site `egressAllow`; endpoint TLS pins; the live collector |
| D3 | **Where AI runs** (data in use) | SA-400(6) ("no approved method of encryption to protect data in use"); SA-9(8); *AI for All* (Canadian control and law); SCIP wording | Every reachable model service is this computer or your organization's own server at a site declared in Canada | A Canadian-region third-party service (for example a Cohere vault in Canada), or your organization's attested server whose location is not declared | Any reachable service with region US or EU, forwarded, or a closed API | `endpoints[]` class and region (`ENDPOINT_REGIONS` is `['CA', 'US', 'EU', 'unstated']`, and `unstated` never satisfies residency) [repo: `src/domain/gate/endpoints.ts`:23-28]; attestation verdicts; `STERLING_MODEL_SERVERS` |
| D4 | **Who holds the keys** | TBS white paper ("maintain exclusive control of the encryption keys"); KM-3 consumer-controlled keys; ITSP.50.106 3.3; ITSP.40.111 v5 (algorithms; CMVP "should"); SC-12 and SC-13 | Every key protecting your organization's data is generated and held by your organization in Canada, in a module with an active CMVP certificate, using ITSP.40.111 algorithms | Held by your organization, but in an unvalidated module or using an algorithm outside ITSP.40.111 (for example X25519) | A key that decrypts your data is held by an outside party (for example, a provider-terminated session key outside a verified enclave) | Site key token type (SoftHSM2 refused in production, G352); HSM certificate (G324); OpenBao seal and build (G351); person keys non-exportable in Transit (46-07, 47 D-40); crypto inventory (X8, G347, G350) |
| D5 | **Canada-only handling rule** | SA-400(3) (marking such as "Canadian Jurisdiction Only"); glossary "must stay in Canada" | A residency rule requiring CA is set for every label in use, and enforced | Set in report mode, or only for some labels | No residency rule (today's starting rules have none) | Policy `residency` section (`required`, `byLevel`) and the `route.residency` step [repo: `src/domain/gate/residency.ts`; `routing.ts`] |

#### Technology

| # | Dimension | Canadian criterion and source | Met | Partly met | Not met | Feeds |
|---|---|---|---|---|---|---|
| D6 | **Where models come from** (developer jurisdiction, weights licence, training data, who can update) | SA-400(8) (products "within the scope of compulsion" may carry embedded compromises); ITSAP.10.071 (geopolitical context, FOCI); *AI for All* (homegrown foundation models); DND/CAF AI Strategy (sovereign AI foundations); Voluntary Code (training data description); CCCS joint AI supply chain guidance | Every model allowed beyond research use is of Canadian origin (`origin: CA`), with your organization's passport, the exact artifact hash, open weights held by your organization (so no one else can change it), and your organization's evaluation | Allied origin (for example US, DE) with passport and artifact hash; or a Canadian model reached through an API whose weights the vendor can change | A model of adversary origin allowed beyond research use; or a model with no passport allowed beyond research use | Passports (`developer`, `origin`, `lineage.teachers`, `licence`, `legal`, `artifact.sha256`, `evaluation`, `maxTier`) [repo: `src/domain/gate/models.ts`, `shippedPassports.ts`]; Models by job; 74.1 enforcement records |
| D7 | **Where the software comes from** (SBOM origin, signing, attestation) | SA-400(8); SR-4, SR-11, CM-8; CCCS joint SBOM guidance (2025, 2026); ITSM.10.071; Defence Industrial Strategy (access to software updates) | Every component in the running image's SBOM is signed, verified at admission, has its supplier jurisdiction recorded and reviewed, and can be rebuilt by your organization from source held in Canada | SBOM and signatures verified, but supplier jurisdiction not recorded or foreign for some components | Unsigned or unverified image, or no SBOM | Release evidence folder (SBOM, scan, manifest) (48.2 LCE-01); Kyverno admission (47 D-15); signed bundle (47 D-47, D-48); `compliance/resources.json` (needs a supplier-jurisdiction field, section 5.3) |
| D8 | **Where the hardware comes from** (origin, location, firmware, attestation) | SA-400(8) (risk-based, network isolation as a compensating control); ITSAP.10.071 (manufacturing locations); SR-4; EU SOV-5 for comparison | Hardware in Canada under your organization's control, with a supply chain integrity review recorded per model, and the site isolated (empty or Canadian-only egress) | In Canada under your organization's control, no SCI review recorded | Runs on hardware outside Canada that a third party controls | Site hardware declaration (new); node count from the 48.2 collector; TEE attestation report (names the hardware vendor) |

#### Operations

| # | Dimension | Canadian criterion and source | Met | Partly met | Not met | Feeds |
|---|---|---|---|---|---|---|
| D9 | **Who runs it** (operational control, administrator and support access, foreign compulsion) | SA-400(7); MA-5; TBS framework ("transparency about operational control"); SCIP ("operational control, and decision-making authority") | Only your organization's people administer every component that holds your data; no supplier remote access; administrator screening recorded | Supplier support from a Canadian entity under contract, or screening not recorded | A foreign-jurisdiction operator administers a reachable component that holds your data | Air-gapped design (47 D-01, no supplier access path); realm admin roles; OpenBao operators; site declaration of operator and screening |
| D10 | **Who issues identities** | Institutional control (TBS framework); SA-400(7) | Every sign-in and credential is issued and checked by your organization's own authorities at your sites; sign-in keys hardware-only | Platform passkeys allowed (a phone passkey may be synced through the phone maker's cloud account) | Sign-in depends on an outside identity provider | Keycloak realm at the site (47 D-30); `signInKeys` (D-57); HQ offline root CA (47 D-50); DIDs and VCs issued by HQ (data-centric access) |
| D11 | **What can leave the site** (network egress) | SC-7; SA-400(8) ("Strong network isolation is recommended") | Egress allow-list empty, or only Canadian destinations your organization controls, and enforcement observed | Allows a Canadian third party | Allows a destination outside Canada or with no stated region | Site `egressAllow` (default `[]`) [repo: `deploy/values/site.example.yaml`:38]; NetworkPolicy; the live collector; 46 D-26 egress test |
| D12 | **Who can switch it off** (update dependency, kill-switch, deplatforming, ownership transfer) | *AI for All* ("restricted or withdrawn at the discretion of a foreign government"); TBS framework (deplatforming, "loss of access"); Defence Industrial Strategy (access to "software updates"); SA-400(9); EU SOV-1, SOV-7 | Every function keeps working with no outside service indefinitely (air-gap proven); updates arrive as signed offline bundles; your organization holds the source and can rebuild and patch on its own; no licence server | Runs offline, but patches come only from a foreign-hosted channel or a non-Canadian supplier | A function your organization relies on stops if a foreign provider revokes an account or key (for example, cloud-only models) | Offline bundle (47 D-47); no update checks or telemetry (46 D-26); licences in `resources.json`; release channel (exchange `container-registry`) |

#### Governance

| # | Dimension | Canadian criterion and source | Met | Partly met | Not met | Feeds |
|---|---|---|---|---|---|---|
| D13 | **Which laws apply to outside services** | SA-400(2); SA-9; TBS white paper (foreign law regardless of location); ITSAP.10.071 (FOCI) | Every outside service is operated by an entity under Canadian jurisdiction only, with an agreement reference and review date | A Canadian entity with foreign subprocessors, or a foreign entity processing in Canada under contract clauses | A foreign-jurisdiction service receives your data | `exchanges.json` (needs `jurisdiction` per exchange, G390); operator-signed exchange agreements (48.2 D-23) |
| D14 | **Assessments and authorization** | SA-400 and SA-400(1) TRA; SA-9(8) evidence; ITSP.10.033-01 Medium; your organization's authorization | SA-400 assessment recorded and in date; SA-9(8) evidence verified; no open sovereignty gap that blocks production at the level in use | Some recorded | None recorded | Compliance view state of SA-400, SA-9(5), SA-9(8); gaps G117, G111, G390 |

---

## 4. Where SovAI stands today

Judged against `origin/main` at fba66ee7 on 2026-11-25, for the two places SovAI runs: the hosted Sterling workbench at a site (Phases 46 and 47), and the desktop extension on one computer. "Today" means what is on main, not what is planned.

| # | Hosted site today | Desktop today | Why (with evidence) |
|---|---|---|---|
| D1 Data stored | **Unknown** | **Unknown** | The stack keeps every store at the site by design (47 D-01, D-17, D-19), but **no site file records where the site is**. `site.example.yaml` has no country, facility or operator field [repo]. G111 ("In-scope processing and storage locations need verified Canadian boundary evidence") is open. Outside AI services: NEAR AI publishes no retention or location terms (section 4.1). |
| D2 Data travels | **Partly met** at best | **Unknown** | All 15 exchanges are registered, and most are site-internal or file-based [repo: `exchanges.json`]. `model-servers` goes to whatever the policy lists. Paths over the public internet are not controlled. |
| D3 AI runs | **Met** for local or your own server once the site declares Canada; **Unknown** for NEAR AI; **Partly met** for a Cohere vault in Canada; **Not met** for closed APIs and the US-only Cohere Encrypted vault | same | The code already treats NEAR's private hardware as `region: 'unstated'` [repo: `src/domain/gate/trustBadge.ts`:185]. NEAR's docs name no data centres, entity or hardware, and NEAR describes a marketplace that routes work to third-party machines [CITED: https://docs.near.ai/; secondary: https://near.ai/?p=11080]. Cohere vault regions are US, EU and Canada for Standard; Encrypted is US only [repo: `.planning/research/cohere-model-vault/DESIGN.md`]. Which cloud provider runs Cohere's Canada region is unknown (that design's question C10). |
| D4 Keys | **Partly met** | **Partly met** | Keys are generated and held at the site: OpenBao Transit person keys are non-exportable (47 D-40), and the site key is in a PKCS#11 token. But the site key is in SoftHSM2 in development (G352), no HSM certificate is recorded (G324), OpenBao has no FIPS build (G351), Ed25519 has no validated module in the stack (G350), Node and Electron crypto is unvalidated (G347, X8), and the cell wrap today is X25519, which ITSP.40.111 v5 does not list (data-centric access research, decision O3: hybrid P-256 + ML-KEM-768 before Protected B). The supplier release key lives as a GitHub environment secret, but sites trust only the site key after re-signing (48.1-17, G396). For cloud inference, NEAR's enclave terminates the session, and the attestation roots are the hardware vendors'. |
| D5 Canada-only rule | **Not met** | **Not met** | The starting rules have no `residency` section ("Absent: no residency rule (D-33)") [repo: `src/domain/gate/routing.ts`:508-509]. The mechanism exists and works once your organization sets it. |
| D6 Models | **Not met** | **Not met** | The shipped defaults on main are PRC-origin: `z-ai/glm-5.3` (chat, standard), `moonshotai/kimi-k3` (deep), `Qwen/Qwen3.6-35B-A3B-FP8` (fast), `z-ai/glm-5.3-flash` (vision) [repo: `package.json` defaults]. Passports exist in code with origins (`cohere/command-a-plus` origin `CA`; Nemotron, gpt-oss US; DeepSeek, Kimi CN at T0) [repo: `src/domain/gate/shippedPassports.ts`], but Phase 74.1 (enforcement, Western defaults) is planned, not built. Command A+ is the only Canadian-origin family. NEAR does not host it (model provenance DESIGN 4.2, as of 2026-11-19). It is Apache-2.0 open weights (74.1 licence check), so it can run on your organization's own hardware. |
| D7 Software | **Partly met** | **Partly met** | Images are signed with cosign and checked at Kyverno admission; the bundle is signed and verified before import; an SBOM is made by Syft; scans by Grype (46 D-31, 47 D-15, D-47, D-48). The release evidence inside the image is planned (48.2), not built. `resources.json` has 141 entries with licence, fit and air-gap, but **no supplier or jurisdiction field** [repo]. The build runs on GitHub Actions. Many components are maintained by US-based foundations or companies (for example Red Hat UBI, CNCF projects) [ASSUMED, A8]. |
| D8 Hardware | **Unknown** | **Unknown** | No hardware inventory or origin is recorded anywhere. The first test hardware is AMD Strix Halo, then NVIDIA GB10 (platform direction, 2026-11-15); both are US-designed [ASSUMED, A9]. NEAR's private hardware is Intel TDX plus NVIDIA confidential computing GPUs [secondary: https://cryptobriefing.com/near-ai-private-model-execution-infrastructure/]. No Canadian-made general-purpose CPU or GPU exists at scale [ASSUMED, A9], so the realistic best is Met through a supply chain integrity review plus isolation (SA-400(8)'s risk-based wording), never "Canadian-made". |
| D9 Who runs it | **Your organization's responsibility** | **Your organization's responsibility** | There is no supplier access path to a site (47 D-01: no outbound dependency). Administrator screening and dual-nationality questions (SA-400(7)) are your organization's to record. NEAR and Cohere operators are outside your organization. NEAR's operating entity and jurisdiction are not published (D13). |
| D10 Identities | **Partly met** (`signInKeys: passkeys`, the default) / **Met** (`hardware-only`) | **Not used** (single person) | The realm is at the site, the offline root CA is at HQ, and there is no outside identity provider (47 D-30, D-50). Phone passkeys may sync through the phone maker's account [ASSUMED, A10]. |
| D11 Egress | **Met** (default `egressAllow: []`, once enforcement is observed by the collector) | **Unknown** | `egressAllow` defaults to empty [repo: `site.example.yaml`:38]; the workbench container proves no outbound calls at start (46 D-26). The desktop extension runs on a person's computer with no egress control of ours. |
| D12 Switch off | **Partly met** | **Not met** while models are cloud-only | The site runs offline from signed bundles with no update checks or telemetry, and sources are open-licence. But updates come only through GitHub and GHCR (exchange `container-registry`, "GitHub Container Registry to the HQ build host") [repo: `exchanges.json`:254-266], and NEAR or Cohere can revoke an API key. |
| D13 Outside laws | **Unknown** | **Unknown** | No exchange or resource records a jurisdiction (G390 open). Known facts: GitHub and GHCR are Microsoft services in the US [ASSUMED, A11]; Cohere is a Canadian company (SSC Question Period note, 2026-02-09); NEAR's operating entity is not published. Keyless GitHub attestations use the public Sigstore service (48.2 G476). |
| D14 Assessments | **Not met** | **Not met** | G117 (SA-400 assessment needs an approved sponsor assessment) and G111 (SA-9(8) location evidence) are open with `blocksProduction: true` [repo: `compliance/gaps.json`]. |

**Overall badge today: Not met.** That is the honest state. It is also the strongest credibility signal the card can give: a product whose card says "Not met: models come from outside Canada" on day one, and moves rows to Met as evidence lands, is more credible than a green badge.

### 4.1 Plain list: where SovAI is not sovereign today

1. **Default models are PRC-origin.** This is fixed by Phase 74.1 (Western defaults), but only Command A+ is Canadian; Nemotron and gpt-oss are US (allied: Partly met).
2. **NEAR AI Cloud is an unknown jurisdiction.** Its private hardware is verified by attestation, but no location, entity, subprocessor or retention terms are published, and the hardware roots of trust are US vendors'. Attestation proves the code and weights, not the country.
3. **No Canadian place hosts an attested Western model yet.** The org-tee path (Phase 74.2) and the NEAR hosting ask (Nemotron 3, Command A+, gpt-oss-120b) are open.
4. **The Cohere vault in Canada is not attested.** The Encrypted (attested) kind is US only, and Command is not offered encrypted.
5. **Build and release depend on GitHub (Actions, GHCR) in the US.** A site does not need it to run, but needs it for every update.
6. **Keys are not yet in validated hardware.** SoftHSM2 in development, no HSM certificate, OpenBao and Ed25519 unvalidated, X25519 wrap.
7. **No site declares its location, operator or hardware**, so residency and hardware are Unknown, not Met.
8. **No outside service has a recorded jurisdiction** (G390).
9. **The SA-400 assessment is not done** (G117). It is your organization's, but the card must show it.
10. **The desktop extension cannot vouch for the computer it runs on.** Most of its rows stay Unknown unless the person declares them.

---

## 5. How the card stays real-time and evidence-backed

### 5.1 Data flow

```
 Release evidence (in the image, signed)        Site live collector (every 15 min, signed)     Operator-signed site files
   SBOM, scan, manifest, statements               egress policy, admission, seal, nodes,          exchange agreements (48.2),
   (48.2 LCE-01)                                  release record (48.2 LCE-05)                    NEW: site sovereignty declaration
            \                                              |                                              /
             \                                             v                                             /
              +--------------------> verify (48.2 D-17..D-19: site key, purposes, times) <-------------+
                                                           |
 Policy in force (signed bundle: endpoints[] class+region, models.passports, residency, egressAllow, signInKeys)
 Gate facts (attestation verdicts, route records)          |
                                                           v
                                  one status engine: rejudge(judgement, { now, observations, policy })
                                  + sovereignty lens: compliance/sovereignty/dimensions.json
                                    (dimension -> controls -> evidence rules -> facts -> gaps)
                                                           |
                          +--------------------------------+---------------------------------+
                          v                                                                  v
                 Badge (status bar, every page)                                    Card (opens on click)
                 worst state + reason + count                                      14 rows, source / as-of / freshness / verification
                          |                                                                  |
                          +-------------- "See the controls" deep link ----------------------> Compliance view (filtered: Sovereignty)
```

### 5.2 Rules that keep it honest

- **One engine.** The sovereignty states are computed by the same `rejudge` the Compliance view uses (48.2 D-11). A new pure function, `sovereigntyFor(judgement, facts, now)`, maps each dimension from (a) control states for SA-400, SA-9(5), SA-9(8), SC-12, SC-13, SR-4, SR-11, CM-8, SC-7, IA-2 and MA-5, and (b) live policy and gate facts. The browser never computes a state (48.2 rule).
- **Re-judged against the clock**: at start, every 60 seconds and on every source change, using the 48.2 freshness words and thresholds. A new evidence kind is not needed: the site declaration uses the `document` kind (ageing after 335 days, out of date after 365). Recommend tightening to 90 and 180 days for declarations (Q7).
- **Policy facts are live.** The badge changes the moment your organization's rules change (a new endpoint, a residency rule, a model passport), because those facts come from the bundle in force, not from collected evidence.
- **Verification before display.** Release evidence, site live facts and site declarations follow 48.2 D-17 to D-19 (configured trust anchors only, purpose-bound signatures). An unverifiable source makes its rows Not verified, never Met.
- **Push without reload.** Use the 48.2 `waitForEvidence` long poll. When the connection drops, the badge says "Sovereignty: paused" and every freshness reads Unknown (48.2 D-25).

### 5.3 New inputs the card needs (the minimum)

| Input | Why | Shape (proposal) | Where it fits |
|---|---|---|---|
| **Site sovereignty declaration** | Location, operator, hardware and HSM facts cannot be proven by software | `sterling-site-sovereignty/1`, purpose `site-sovereignty`, signed with an operator key the site trust document names. Fields: facility country and province; operator legal name and jurisdiction; hardware inventory (make, model, assembly country if known, SCI review reference); HSM model and CMVP certificate number; backup and off-site copy country; administrator screening reference; `declaredBy`, `declaredAt` | 48.2 D-23 operator files: same publish command, same ConfigMap `sterling-site-evidence-operator` |
| **Supplier jurisdiction per resource** | D7, D12 and D13 need who maintains each component and under which law | Add `supplier` and `supplierJurisdiction` (ISO 3166 code or `unknown`) to `compliance/resources.json` and its schema; `unknown` is allowed and shows as Unknown | Gate file change (48.2 D-28); the fit check stays the one check |
| **Jurisdiction per exchange** | D2 and D13 | Add `operatorJurisdiction` and `location` to each exchange in `exchanges.json`; closes part of G390 | Hosted docs generator already reads this file |
| **Dimension map** | One reviewable place that says which controls, rules, facts and gaps feed each dimension | `compliance/sovereignty/dimensions.json`, read by the engine bundle and the docs site | Data only; validated by a schema test |

Nothing else is new: no new service, no new image, no new key.

### 5.4 Air-gapped and disconnected sites

- Every input is local: the image, the site files, the collector and the policy bundle. Nothing is fetched (48.2 D-08).
- An air-gapped site with an empty egress list and only local or own-server models has D2, D3 and D11 at their strongest, and D13 and D12's outside-service parts are **Not used**. This is the configuration where SovAI is most sovereign, and the card should make that visible.
- The clock comes from the on-site time source (47 D-71). A clock earlier than the release build is the 48.2 clock case: every freshness reads "Unknown: this computer's clock is earlier than the release build", and nothing is Met.
- Edge sites report their card upward inside the existing signed site evidence export (48.1-04). HQ's roll-up of edge sites is out of scope, as it is for 48.2.

### 5.5 The desktop extension (single computer)

The desktop extension has no site, no collector and no site key. It shows the policy-derived rows (D3, D5, D6, D12 for models, D13 for model services) live from the gate. The site rows read **Unknown: this computer is not part of a site. Where it is and who runs it are yours to record.** It never infers Canada from a time zone, locale or IP address.

---

## 6. UX recommendations

### 6.1 The badge (always visible)

- **Place:** a status bar item on the left of the Sterling workbench, contributed by the Sterling frontend module, so it is on every page and every editor without a per-page widget. In the desktop extension, a status bar item beside the gate item. This is better than a badge in each webview page, which would be N copies to keep equal and would miss native Theia widgets. (Q9)
- **Content:** codicon plus two words plus a reason, from the worst state:
  - all Met: `$(shield) Sovereignty: Met`
  - otherwise: `$(warning) Sovereignty: Not met · AI may run outside Canada` (the first worst row's short reason), and `· +3` when more rows share the worst state.
  - Unknown: `$(question) Sovereignty: Unknown · Site location not declared`.
  - Paused: `$(debug-pause) Sovereignty: paused`.
- **Colour:** none for Met (48.2 UI-SPEC: Verified is a fact, not a pass, so it is not green). Use the status bar's warning background only for Not met, which matches the Compliance view's warning icon for Not met and Partly met.
- **Accessible name:** one sentence: "Sovereignty: Not met. 3 of 14 not met, 2 unknown. AI may run outside Canada. Open the sovereignty card." Changes are announced politely, at most once a minute.
- **Never:** "Sovereign", "Fully sovereign", "Certified", a percentage or a score.

### 6.2 The card (on click)

A panel (not a modal) in the original theme with lifted cards (memory "original UI design"; 48.2 UI-SPEC elevation: layered `--theia-widget-shadow`, 1px top highlight in dark themes, `--theia-contrastBorder` in high contrast, no lift under reduced motion). Codicons and Theia variables only.

1. **Header card:** "Sovereignty of this workbench", the worst state, counts by state, "As of {time}", live indicator, and the scope line: "Judged against Canadian criteria (ITSP.10.033 SA-400 and SA-9(8), Treasury Board and AI strategy). This is a self-check from evidence, not an assessment. Authorization is your organization's decision."
2. **Four group cards** (Data, Technology, Operations, Governance), each with its rows. A row has the plain name, state word, one reason line, and the same source, as-of, freshness and verification chips as a Compliance view cell.
3. **Row detail (expand):**
   - the Canadian criterion with its source link (cyber.gc.ca, canada.ca);
   - what was checked and against what (for example "Allowed AI services: NEAR AI Cloud (Runs on NEAR AI private hardware, region not stated); this computer");
   - "Declared by" or "Verified" for each fact;
   - the gap ids and what moves it to Met (from the gap's remediation);
   - "See the controls" (opens the Compliance view filtered to that row's controls).
4. **Footer:** "What this card does not check": it does not check foreign laws themselves, the path packets take across the internet, or firmware inside hardware; links to the sources list.

Draft copy for D3 when NEAR is allowed (glossary words: Runs on, your organization):

> **Where AI runs · Not met**
> Your organization's rules let this workbench send content to NEAR AI Cloud. It runs on NEAR AI private hardware, which was verified, but NEAR AI does not say where that hardware is or who operates it.
> Canadian criterion: data in use stays in Canada (ITSP.10.033 SA-400(6), SA-9(8)).
> To meet it: use this computer or your organization's own server at a site declared in Canada, or ask NEAR AI to state its locations. [See the controls]

### 6.3 Relation to the Compliance view (no duplication)

- **The Compliance view is controls by level; the card is a lens across controls plus live configuration.** The card owns no evidence: every row reads the engine's judgement and the policy in force.
- **Facts only the card shows** (because they are configuration, not controls): which AI services are reachable now and where they run, which models are allowed and their origin, and the residency rule. These come from the gate, the same facts as the trust line.
- **Links both ways.** Each card row deep-links to the Compliance view with a new **Sovereignty** filter (the dimension map's controls). The Compliance view's SA-400 and SA-9(8) rows show "Part of the sovereignty card: {row}". One filter value is added to the view; no new page.
- **The road to production.** Gap rows that affect sovereignty carry the dimension id in their remediation text, so the card can list "what moves this row". This needs no gap schema change (Q12).

### 6.4 Accessibility

Follow the 48.2 UI-SPEC: WCAG 2.2 AA, one accessible sentence per row starting with the visible text, keyboard order header, then groups, then rows, Escape closes, focus returns to the status bar item.

### 6.5 Glossary and copy lint (coherence review needed first)

The glossary lists "sovereign region, residency" and "TEE-only, sovereignty mode" as **never on main screens** [repo: `.planning/research/coherence/GLOSSARY.md`, lines 18 and 25]. The owner's memory note requires a coherence review before any new user-facing phase. Proposed amendment:

| Concept | User word | Never on main screens |
|---|---|---|
| How far Canada controls this system, by dimension | **Sovereignty** (the card and badge name only) | SEAL, sovereignty score, sovereign region |
| A dimension | Plain names: "Where your data is stored", "Where data travels", "Where AI runs", "Who holds the keys", "Canada-only handling rule", "Where models come from", "Where the software comes from", "Where the hardware comes from", "Who runs it", "Who issues identities", "What can leave the site", "Who can switch it off", "Which laws apply to outside services", "Assessments" | dimension ids D1 to D14, SA-400 (detail pane only) |
| A signed fact your organization states | "Declared by {name} on {date}" | attestation (unless a hardware attestation verified it) |

Copy lint rule 6 (compliance claims) should also refuse "fully sovereign", "100% sovereign", "100% Canadian", "sovereign by default", "sovereignty certified" and "certified sovereign" anywhere in user copy and docs. The product name "Sterling Sovereign AI" stays allowed as a name.

---

## 7. Don't hand-roll

| Problem | Don't build | Use instead | Why |
|---|---|---|---|
| Judging states over time | A second status engine for sovereignty | 48.2 `rejudge` plus a pure lens function | Two engines drift; the owner's rule is one engine and nothing cached as current |
| Verifying site facts | A new signature format | 48.2 signed-payload envelope with a new purpose `site-sovereignty`, the trust document's operator keys | Same anchors, same Not verified and Did not verify behaviour |
| Delivering facts to sessions | A new service or hub path | The 48.2 projected ConfigMap mount and long poll | Already designed for air gap and for live updates |
| Model origin | A list of "Canadian models" in code | Passports (`origin`, `lineage`) in your organization's signed policy | Policy, not code, decides; shipped passports are starting rules |
| Location of AI services | IP geolocation or DNS guesses | `endpoints[].region` stated by contract, plus site declarations | Geolocation is not evidence; the code already says `unstated` never satisfies residency |
| A sovereignty score | Weighted percentages | Worst-of with counts | Canadian guidance gives no weights; the EU uses scores only to rank tenders that already pass every minimum |

---

## 8. Pitfalls

1. **Location equals sovereignty.** Data in a Canadian data centre run by a foreign-owned operator is still exposed to foreign compulsion (TBS framework; SA-400(7)). D3 and D13 must both be shown, and a Canadian region alone is Partly met.
2. **Attestation equals location.** A verified enclave proves code and weights, not the country or the operator (model provenance DESIGN 8.3). Never let a Verified attestation move D1 or D3 to Met.
3. **Allowed equals sovereign.** Your organization's rules may allow a non-Canadian service for low labels. The card must say "allowed" and "not met" together, or people will read the badge as approval.
4. **Unknown shown as Met.** A missing site declaration must be Unknown, and Unknown must rank below Partly met in the badge.
5. **Stale declarations.** A site declaration from last year about hardware that has since changed: use document freshness, and re-declare on every bundle update that changes nodes (the collector's node count disagreeing with the declaration gives Not verified).
6. **Overclaiming through the product name.** "Sterling Sovereign AI" plus a green badge reads as a certification. Keep the scope line and the copy lint additions.
7. **Desktop inference.** Never infer Canada from the locale, the time zone or the IP address.
8. **Allied equals Canadian.** US and EU origins are allied, not Canadian. Canadian definitions speak of "Canadian control and Canadian law" (*AI for All*). Allied origin is Partly met, never Met (Q6).
9. **Hardware perfectionism.** Requiring Canadian-made chips makes D8 permanently Not met, which teaches people to ignore the card. SA-400(8) itself is risk-based, so use SCI review plus isolation for Met (Q5).
10. **Duplicating the Compliance view.** The card must not have its own control list, evidence store or state words.

---

## 9. Proposed gap rows (no ids; reserve a block when planning)

Per the owner's "capture considerations" rule, the planning phase should file these in `compliance/gaps.json`, with ids from a reserved block:

| Title | appliesAt | blocksProduction |
|---|---|---|
| NEAR AI Cloud does not publish where its private hardware runs, who operates it, or how long it keeps prompts | now | false (shown as Unknown; G390 covers the register) |
| No site declares its facility country, operator, hardware or backup location | protected-a | true (part of G111's evidence) |
| Resources record no supplier or supplier jurisdiction | protected-a | false |
| The release channel (GitHub Actions and GHCR) is a US service; sites depend on it for every update | protected-b | false (POA&M item; your organization decides) |
| The shipped default models are PRC-origin until Phase 74.1 ships Western defaults | now | true (already implied by 74.1; link rather than duplicate if a row exists) |
| No attested model service runs in Canada (no org-tee yet; Cohere Encrypted is US-only) | protected-b | false |

---

## 10. Owner questions (each with a recommended default)

| # | Question | Recommended default |
|---|---|---|
| Q1 | Judge each dimension against the strict Canadian criterion, or against what your organization's rules require for the label in use? | **Strict Canadian criterion**, with "Your organization's rules allow this for {label}" beside any Not met that the rules allow. |
| Q2 | Badge summary: worst state, or a score? | **Worst state plus counts**; no score or percentage. |
| Q3 | Judge on what the session can reach now, or on what it used last? | **What it can reach now** (exposure). Per-answer facts stay in the trust line. |
| Q4 | Badge words | **"Sovereignty: {state} · {reason}"** with the Compliance view's state words plus Unknown, after a coherence-review glossary amendment (section 6.5). |
| Q5 | When can "Where the hardware comes from" be Met? | **Hardware in Canada under your organization's control, with a supply chain integrity review recorded per model, and site isolation**, per SA-400(8)'s risk-based wording. Not "Canadian-made". |
| Q6 | Is allied origin (US, EU, other Five Eyes) ever Met for models and software? | **No: Partly met.** Met needs Canadian origin (models) or a recorded review with your organization able to rebuild from source (software). |
| Q7 | How are location, operator, hardware and HSM facts supplied? | **An operator-signed site sovereignty declaration** through the 48.2 operator-file path, document freshness tightened to ageing after 90 days and out of date after 180. |
| Q8 | Add supplier and supplier-jurisdiction fields to `resources.json` and jurisdiction to `exchanges.json`? | **Yes**, with `unknown` allowed and shown as Unknown; fill them from the SBOM supplier fields and a review. |
| Q9 | Where does the badge appear? | **The status bar** of the Sterling workbench and of the desktop extension. The public docs site gets a static "How sovereignty is judged" page (criteria and sources), never a live state. |
| Q10 | Ask NEAR AI in writing for data-centre countries, operating entity and jurisdiction, subprocessors and prompt retention? | **Yes**, added to the existing NEAR hosting ask. Until answered, NEAR rows stay Unknown. |
| Q11 | Record the supplier's (Sterling's) own ownership and jurisdiction for SA-400(9) and D12? | **Yes**: the owner records Sterling Canada's ownership and the jurisdiction of the release channel, so the card can show the supplier row honestly. |
| Q12 | Tag sovereignty gaps by dimension? | **Yes, in remediation text only** (no gap schema change), so the card lists "what moves this row". |

---

## 11. Validation notes (for the plan)

The tests that matter, and only those (owner rule: protect behaviour, not counts):

- `sovereigntyFor` is pure: worst-of ordering; Unknown never counts as Met; a Not verified source never yields Met; a declaration past its threshold gives Stale; an allowed non-Canadian endpoint gives Not met with the "allowed" text.
- Parity: the badge's state equals the card's header state for the same judgement (one function feeds both).
- Policy change: adding an `endpoints[]` entry with `region: US` turns D3 to Not met within one re-judge, without a reload.
- Air-gapped fixture: empty egress, local model only, Canadian declaration, so D2, D3 and D11 are Met and D13 is Not used.
- Desktop fixture: site rows are Unknown with the stated sentence; no locale or IP is read.
- Copy lint: the new overclaim phrases are refused.
- One focused browser check of the status bar item and the card (critical credibility surface); broad screenshot sweeps stay non-blocking.

---

## 12. Assumptions log

| # | Claim | Section | Risk if wrong |
|---|---|---|---|
| A1 | The Directive on Service and Digital 4.4.3.14 wording is as the Cloud Guardrails quote it (the TBS policy page refused automated access today) | 2.2 | Low: the wording is stable and widely quoted |
| A2 | The CAN/DGSI 100-8 second edition's four domains match SovereignReady's (the standard's text was not read) | 1, 2.6 | Low: only the grouping of dimensions would change |
| A3 | ITSM.50.100 (CCCS cloud provider assessment) adds no sovereignty criterion beyond those listed (not fetched) | 2.3 | Low to medium: could add a D14 input |
| A4 | Exact DADM amendment date (2025) | 2.4 | Low: not a sovereignty criterion |
| A5 | Status of FISA 702 after mid-2026 and of Bills C-34 and C-36 after July 2026 | 2.4, 2.7 | Low: the card does not track foreign or pending statutes |
| A6 | No public CANSOFCOM or Defence Data Strategy sovereignty criterion exists beyond the DND/CAF AI Strategy (not retrieved) | 2.5 | Medium: a DND-specific criterion would add or tighten a row |
| A7 | BSI C5 adds nothing beyond the EU CSF for this purpose (not checked) | 2.8 | Low |
| A8 | Many stack components (Red Hat UBI, CNCF projects, Linux Foundation projects) are maintained by US-based organizations | 4 (D7) | Low: the card will show recorded supplier jurisdictions, not this summary |
| A9 | AMD and NVIDIA are US-designed, and no Canadian-made general-purpose CPU or GPU exists at scale | 4 (D8) | Low: drives Q5's default |
| A10 | Phone platform passkeys can sync through the phone maker's cloud account | 4 (D10) | Low: drives Partly met for `signInKeys: passkeys` |
| A11 | GitHub and GHCR are operated by Microsoft under US jurisdiction | 4 (D12, D13) | Low |
| A12 | NEAR AI's GPU marketplace means some private hardware belongs to third parties (from NEAR's own page, not independently confirmed) | 4 (D3) | Low: NEAR rows are Unknown either way |

---

## 13. Project constraints applied

From the owner's global instructions and memory notes:
- Lean implementation: no new service, image or key, and four data additions only (section 5.3).
- Compliance fit before adoption: every new input reuses existing fit-checked mechanisms.
- Capture considerations: the gap rows are in section 9.
- Derive obligations from controls: the obligations come from SA-400, SA-9(8), SC-12, SC-13, SR-4, SR-11, CM-8, SC-7 and MA-5.
- Original UI with lifted cards; product name Sterling Sovereign AI (SovAI); "your organization"; NEAR AI only as a provider.
- Coherence review before a new user-facing phase.

---

## 14. Sources

Fetched 2026-11-25 unless noted. "Page date" is the date shown on the page.

**Primary (official)**
- ITSP.10.033 catalogue (SA-400, SA-400(1) to (9), SA-9(5), SA-9(8), SC-12), cyber.gc.ca, retrieved 2026-11-21 into `compliance/catalogs/itsp-10-033/catalog.json` (Open Government Licence - Canada; source URL in `compliance/catalogs/NOTICE`); ITSP.10.033-01 Medium profile in `compliance/profiles/itsp-10-033-01-medium.json`.
- TBS, *Digital Sovereignty: A Framework to improve digital readiness of the Government of Canada*, page date 2025-11-12: https://www.canada.ca/en/government/system/digital-government/digital-government-innovations/cloud-services/digital-sovereignty/digital-sovereignty-framework-improve-digital-readiness.html
- TBS, *Government of Canada White Paper: Data Sovereignty and Public Cloud* (2018), page modified 2026-04-23: https://www.canada.ca/en/government/system/digital-government/digital-government-innovations/cloud-services/digital-sovereignty/gc-white-paper-data-sovereignty-public-cloud.html
- Government of Canada Cloud Guardrails, Data Location (quotes DSD 4.4.3.14): https://canada-ca.github.io/cloud-guardrails/EN/05_Data-Location.html
- SPIN 2017-01, modified 2022-06-23: https://www.canada.ca/en/government/system/digital-government/modern-emerging-technologies/direction-secure-use-commercial-cloud-services-spin.html
- *Government of Canada Considerations for the Use of Cryptography in Commercial Cloud Services* (2019, page details 2025-10-22): https://www.canada.ca/en/government/system/digital-government/digital-government-innovations/cloud-services/government-canada-consideration-use-cryptography-in-cloud.html
- ITSP.40.111 version 5, effective 2026-05-29: https://cyber.gc.ca/en/guidance/cryptographic-algorithms-unclassified-protected-protected-b-information-itsp40111
- ITSP.50.106 (2020): https://cyber.gc.ca/en/guidance/guidance-cloud-service-cryptography-itsp50106
- ITSP.50.105 (2020): https://cyber.gc.ca/en/guidance/guidance-cloud-security-assessment-and-authorization-itsp50105
- ITSAP.10.071, page modified 2026-04-07: https://cyber.gc.ca/en/guidance/supply-chain-integrity-risk-assessments-evaluation-criteria-itsap10071
- ITSM.10.071: https://cyber.gc.ca/en/guidance/protecting-your-organization-software-supply-chain-threats-itsm10071
- Joint SBOM guidance (shared vision): https://cyber.gc.ca/en/news-events/joint-guidance-shared-vision-software-bill-materials-cyber-security ; (2026 minimum elements, modified 2026-07-29): https://cyber.gc.ca/en/news-events/joint-guidance-minimum-elements-software-bill-materials
- Joint AI guidance with ANSSI (modified 2025-02-04): https://www.cyber.gc.ca/en/news-events/joint-guidance-building-trust-artificial-intelligence-through-cyber-risk-based-approach ; AI/ML supply chain (modified 2026-03-05): https://www.cyber.gc.ca/en/news-events/joint-guidance-supply-chain-risks-mitigations-artificial-intelligence-machine-learning
- *Canada's National Artificial Intelligence Strategy: AI for All*, page date 2026-06-08: https://ised-isde.canada.ca/site/ised/en/canadas-national-artificial-intelligence-strategy-ai-all
- AI Sovereign Compute Infrastructure Program, page date 2026-06-01: https://ised-isde.canada.ca/site/ised/en/ai-sovereign-compute-infrastructure-program
- SSC Question Period Note, Digital sovereignty (received 2026-02-09): https://search.open.canada.ca/qpnotes/record/ssc-spc%2CSSC-2026-QP-0902
- AI Strategy for the Federal Public Service 2025-2027, full text, page date 2026-10-02: https://www.canada.ca/en/government/system/digital-government/digital-government-innovations/responsible-use-ai/gc-ai-strategy-full-text.html
- Guide on the use of generative AI, page date 2026-09-24: https://www.canada.ca/en/government/system/digital-government/digital-government-innovations/responsible-use-ai/guide-use-generative-ai.html
- Voluntary Code of Conduct (September 2023, modified 2026-06-04): https://ised-isde.canada.ca/site/ised/en/voluntary-code-conduct-responsible-development-and-management-advanced-generative-ai-systems
- DND/CAF AI Strategy, Guiding Principles, page date 2024-03-11: https://www.canada.ca/en/department-national-defence/corporate/reports-publications/dnd-caf-artificial-intelligence-strategy/guiding-principles.html
- *Canada's Defence Industrial Strategy* (2026): https://www.canada.ca/en/department-national-defence/corporate/reports-publications/industrial-strategy/security-sovereignty-prosperity.html
- CAN/DGSI 100-8 product page (second edition, revised 2026): https://dgc-cgn.org/product/can-dgsi-100-8/ ; SovereignReady: https://dgc-cgn.org/product/sovereign-ready/
- European Commission, *Cloud Sovereignty Framework* v1.2.1 (October 2025): https://commission.europa.eu/document/download/09579818-64a6-4dd5-9577-446ab6219113_en?filename=Cloud-Sovereignty-Framework.pdf ; explainer 2026-06-01: https://commission.europa.eu/news-and-media/news/sovereign-cloud-framework-explained-2026-06-01_en
- NEAR AI documentation index: https://docs.near.ai/

**Secondary (reputable, used only where marked)**
- BetaKit on the minister's definition: https://betakit.com/canadian-sovereign-cloud-evan-solomon-all-in/
- Baker McKenzie on the June 2026 AI strategy: https://www.bakermckenzie.com/en/insight/publications/2026/06/canada-federal-government-releases-refreshed-national-ai-strategy
- Torys on AI SCIP: https://www.torys.com/our-latest-thinking/publications/2026/05/canada-launches-ai-scip
- Lexpert on CAN/DGSI 100-8 second edition (2026-07-14): https://www.lexpert.ca/news/technology-law/dgsi-expands-guidance-for-emerging-technologies-in-revised-national-standard-on-digital-sovereignty/394421
- DLA Piper on Bill C-36: https://www.dlapiper.com/insights/publications/2026/06/canada-tables-bill-c36-the-protecting-privacy-and-consumer-data-act ; Canadian Lawyer on AIDA: https://www.canadianlawyermag.com/news/general/artificial-intelligence-and-data-act-replacement-unlikely-under-new-national-ai-strategy-lawyers/394177
- CyberScoop on FISA 702 (April 2026): https://cyberscoop.com/congress-extends-section-702-surveillance-45-days/
- MobileSyrup on Budget 2025: https://mobilesyrup.com/2025/11/05/federal-budget-proposes-1-billion-go-towards-canada-ai/
- Scalingo on SecNumCloud 3.2: https://scalingo.com/blog/referentiel-secnumcloud-3-2-evolutions-futur ; Gaia-X Compliance Document summary 2024: https://gaia-x.eu/wp-content/uploads/2024/09/Compliance-Document_Marketing-Summary-2024.pdf
- CryptoBriefing on NEAR AI hardware: https://cryptobriefing.com/near-ai-private-model-execution-infrastructure/ ; NEAR AI GPU marketplace page: https://near.ai/?p=11080

**Repository (read on `origin/main` at fba66ee7)**
- `compliance/catalogs/itsp-10-033/catalog.json`, `compliance/profiles/itsp-10-033-01-medium.json`, `compliance/gaps.json` (G111, G117, G324, G347, G350, G351, G352, G378, G390, G396, X8), `compliance/hosted/exchanges.json`, `compliance/resources.json`
- `src/domain/gate/endpoints.ts`, `residency.ts`, `routing.ts`, `models.ts`, `shippedPassports.ts`, `trust.ts`, `trustBadge.ts`; `package.json` model defaults
- `deploy/values/site.example.yaml`, `deploy/host-packages.json`
- `.planning/research/model-provenance/DESIGN.md`, `.planning/research/cohere-model-vault/DESIGN.md`, `.planning/research/data-centric-access/RESEARCH.md`, `.planning/research/coherence/GLOSSARY.md`, `.planning/research/near-ai-platform.md`
- `.planning/phases/46-native-theia-foundation/46-CONTEXT.md`, `.planning/phases/47-on-premise-deployment-stack-and-offline-bundle/47-CONTEXT.md`, `.planning/phases/48.2-live-compliance-evidence-in-the-workbench/48.2-CONTEXT.md` and `48.2-UI-SPEC.md`, `.planning/phases/74.1-model-passports-use-tiers-and-western-defaults/74.1-CONTEXT.md`

**Metadata.** Research date 2026-11-25. Valid until about 2026-12-25 for policy (Canada's definitions are moving: the SSC sovereign cloud procurement, the CAN/DGSI 100-8 second edition and the EU framework update may all change criteria), and until the next change to the referenced repo files for the "today" column.
