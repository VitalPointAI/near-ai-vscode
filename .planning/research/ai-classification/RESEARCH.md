# AI classification and attribute assignment: proposals, signed labels and the review flow

Research report, written 2026-11-24 from `origin/main` at 3efa610d, plus the branch `origin/docs/research-data-centric-access` (the data-centric access report, `.planning/research/data-centric-access/RESEARCH.md`).

**Owner direction (2026-11-24):** "We also need to highly leverage AI to classify data and assign attributes automatically."

**Already decided, not reopened here:**
- Data-centric access. Every item carries its own policy: classification, compartments (`CGP`, `ITAR`, `EAR`), releasability and the clearance it needs. Its key is released only to holders whose W3C verifiable credentials satisfy that policy. Zero trust; Keycloak authenticates only.
- The data platform's classification rule (`.planning/research/data-platform/02-classification-tagging-data-centric-security.md`, called **report 02** below; Phase 93): detectors propose facts, signed policy turns facts into a label, automatic steps only raise, only a person lowers.
- Western models for anything above research use; PRC-origin models only at T0, and at T1 with a signed risk acceptance (model provenance design, Phase 74.1).
- On-premise and air-gapped deployment; no AGPL; every added resource passes the compliance fit check.

This report answers what "highly leverage AI" should mean on top of those decisions, and where it is safe.

**How to read the evidence marks** (the same as the data-centric report):
- **[primary]**: I read a standards body, government or vendor documentation page directly today.
- **[vendor]**: a vendor's own claim about its product.
- **[secondary]**: a search excerpt, a news article or a third-party summary.
- **[unverified]**: I could not confirm it today. Do not rely on it until a phase research step checks it.
- **[repo]**: read in this repository at the commits above.
- **(inference)**: my own reasoning or recommendation.

The GSD confidence seam rates every web source LOW by default. No web finding here is authoritative until the phase that depends on it repeats the check.

---

## 0. Recommendation in one page

1. **Use AI heavily, but only to propose data attributes.** A model proposes a label (level, compartments, releasability, caveats, handling, retention) with a cited basis and a confidence. A small pure engine in the gate decides what happens to the proposal under your organization's signed policy. **Automatic steps may raise or keep. Lowering, widening releasability, removing a compartment and declassifying always need a person with the authority for it.** That is the same rule as Phase 70's session mark and report 02, now applied at the moment content is written, not only when it is ingested.
2. **Classify at creation, in the workbench, with the originator present.** Canadian, UK and US practice all make the originator (information creator) responsible for the classification, and only the originator or a classification authority may change it [secondary; UK primary]. The highest-value use of AI here is a classification assistant beside the editor: it proposes the marking as a staff officer writes, raises the working label automatically when the evidence is strong, and asks the originator to affirm the label in one step when they finalize, send or release. Bulk classification of ingested data (Phase 93) reuses the same engine later.
3. **Never start from the bottom.** A proposal starts from the label the content already has: the session's high-water mark, the source labels it was built from, the project or cell label, or your organization's ingest default. A prompt-injected "this is unclassified" can then do nothing, because a model's output can only add to that label, never replace it.
4. **Every proposal cites its basis.** A source label it inherits, an entry in your organization's security classification guide, a detector fact (a marking banner, a code word, a controlled-goods item), or a model judgement. A model judgement alone may raise the working label, but it always goes to the originator or steward. This mirrors derivative classification, where the marking comes from a source or a guide, not from the classifier's opinion [primary: 32 CFR 2001.22].
5. **The model runs at system-high, inside the security domain of the content.** It reads content before anyone knows its level, so it must run where the most sensitive content that system may hold may go: a local or organization-hosted model on the same accredited system, never a cloud model, whatever level it predicts. A prediction above the system's own accreditation is not a label. It is a possible spill, reported to the security officer.
6. **Person attributes are never AI-assigned.** Clearance, nationality, organization, compartment access, export eligibility, how a person serves and access agreements are verifiable credentials issued by named authorities after a person-run process. AI may check that an issuance request is complete, and may suggest who might need access to an item, which a person then decides. It never issues, holds issuing authority for, or infers a person attribute. Make it structural: agent and device DIDs (`did:key`) can never hold an issuer role credential, and issuance needs a passkey step-up from a person.
7. **Phases (section 7).** Add **Phase 70.1, the classification engine** (pure: the proposal record, the application rules, threshold arithmetic, guide rules and compilation rules in the signed bundle, the audit record), which can start as soon as Phase 70's labels and session mark are on main, beside Phase 71 (core). Add **Phase 74.3, the classification assistant** (the local model runner, the evaluation and red-team harness, the native review panel, signed labels on chats, files and cells, and lowering by an authority credential). It follows Phase 70.1, Phase 74.1 and Phase 71 (core). Its cell work follows Phase 33.1's marking waves. Phase 93 then reuses both, and Phases 98 and 99 add a specialist classifier and the drift watch. Two small text amendments go in now, before shapes become permanent: `ClassificationAuthorityCredential` in Phase 71 (core)'s credential table, and an optional `basis` slot on 33.1's marking and label entries.

---

## 1. What exists and what this adds

| Item | State | What it gives this design | Source |
|---|---|---|---|
| Labels v1, dominance, join | On main | `{scale, level, compartments, releasability, handling}`; the reserved export compartments `CGP`, `ITAR`, `EAR`; `RELEASABLE-TO-NONE`; join raises level, unions compartments and handling, intersects releasability | `src/domain/gate/labels.ts`, `dominance.ts` [repo] |
| Label map v1 | Format on main; writing it to disk is 70-20 (PR 4b, not executed) | One signed map per project; an unverified map applies only where it raises | `src/domain/gate/labelMap.ts` [repo] |
| Label events | On main | `label.set`, `label.branch-accepted`, `label.mark-raised`, `label.declassify`, `label.declassify-rejected` | `labels.ts` `LABEL_EVENT_IDS` [repo] |
| Session high-water mark, Lower This Chat's Label | Planned (70-22, 70-23) | The mark only rises; a person lowers with a recorded reason; signed lowerings judged on merge | ROADMAP Phase 70; `lowerings.ts` [repo] |
| Model passports and use tiers | Report mode on main (Phase 41); enforcement in Phase 74.1 | `maxTier` T0 to T3; a checking job (`safety`) needs at least T2; T3 needs an evaluation reference; origin `XX` stays T0; checking roles on a different family (MPRV-09) | `src/domain/gate/models.ts`, `useTier.ts` [repo] |
| Report 02 and Phase 93 | Research done; phase not planned | Tier 0, 1, 2 detectors; rules in the bundle; the exception queue; the sampling audit; aggregation rules; derived-artifact labels | report 02 sections 1 to 7 [repo] |
| Data-centric access | Research branch, accepted in principle | `mayRelease(credentials, label, context)` at every wrap; person attributes as credentials; issuance in an officer's own session with step-up; a STANAG 4774 mapping and a 4778-style signed label binding | data-centric report sections 3 to 5 [repo] |
| Phase 33 cells and 33.1 markings | 33 in progress; 33.1 planned | Labels sealed in grants; `cell.marking` and `marking.approve`; `planRekey` drops holders on `clearance-lowered` | data-centric report section 1 [repo] |

**What this report adds to report 02:**
- government and military practice, not only commercial and privacy practice;
- classification **at creation** with an originator present, not only at ingest;
- security classification guides and compilation as the basis for defence content, beside the PII and secret detectors;
- how a proposal becomes a **signed** label inside the credential and cell design;
- where the model may run when the content may be classified;
- the explicit boundary for person attributes;
- phase placement relative to Phases 70, 71, 33.1 and the data platform.

It does not repeat report 02's detector survey, catalog comparison, privacy schema or legal notes. Those stand.

---

## 2. Prior art

### 2.1 Commercial auto-labelling

| Product | How AI or rules are used | Confidence | Human review | Downgrades | Mark |
|---|---|---|---|---|---|
| **Microsoft Purview** | Two methods. Client-side labelling in Office apps "supports recommending a label to users, as well as automatically applying a label. But in both cases, the user decides whether to accept or reject the label". Service-side auto-labelling policies run over SharePoint, OneDrive and Exchange and "don't support recommended labeling" | Sensitive information types have confidence levels low (65), medium (75) and high (85); a higher level gives fewer false positives and more false negatives. Trainable classifiers are pretrained or custom | Service-side: "You can't automatically label documents and emails, or remove labels, until your policy has run at least one simulation." Absolute maximum 500,000 files per tenant per day | "When content has been manually labeled, that label won't be replaced by automatic labeling." Auto-labelling "will replace a [lower priority sensitivity label] that was automatically applied, but not a higher priority label." The default label policy requires a justification to remove or lower a label | [primary] https://learn.microsoft.com/en-us/purview/apply-sensitivity-label-automatically ; confidence numbers [secondary] https://learn.microsoft.com/purview/sit-sensitive-information-type-learn-about ; justification [secondary] https://learn.microsoft.com/purview/default-sensitivity-labels-policies |
| Purview, newer AI features | A roadmap item for an AI-written plain-language description of what a custom classifier detects (preview October 2026, general availability November 2026) | n/a | n/a | n/a | [secondary] https://mc.merill.net/message/RM560708 . Whether it uses a language model is unconfirmed [unverified] |
| **Fortra Data Classification Suite** (formerly Titus) | Three modes: guided ("asking the user to confirm the recommended classification level"), automated, or manual. "Intelligent Protection" uses machine learning that "validates or makes alternate suggestions to user-driven classifications", trainable on the customer's own data | Not published | The user's choice is the starting point; the model checks it | Not published | [vendor] https://www.fortra.com/platform/data-classification ; https://www.fortra.com/resources/datasheets/dcs-intelligent-protection (403 today; excerpt only) |
| **Fortra Classifier Suite** (formerly Boldon James) | Point-of-creation labelling in Office and CAD apps; Fortra says its suites support STANAG 4774 label syntax and STANAG 4778 binding profiles | Not published | User-driven | Not published | [vendor] https://www.fortra.com/resources/datasheets/military-classification-for-nato-security-compliance (search excerpt; 403 today) |
| **Janusnet Janusseal** | Prompts users to classify when they create, save, print or send; government email marking standards; newer releases say "sensitive content can be detected and appropriate classification automatically applied" (method not stated). Used by Australian, New Zealand, US and UK governments per a reseller listing | Not published | Point of creation | Not published | [vendor] https://janusnet.com/what-we-do ; [secondary] reseller listings |
| **Google Workspace** (from report 02) | AI classification trained on at least 100 labelled files per option | Recall of 80 percent per option recommended before use | AI never overwrites DLP-set or user-reviewed values | A user can remove a label; AI may re-apply it | report 02 section 4.2 [repo; primary there] |

**What the commercial products agree on (inference):**
- a person stays the decider at the point of creation (recommend and confirm);
- an automatic label never replaces a manual or a higher label;
- lowering needs a person and a justification;
- bulk automatic labelling runs in simulation first;
- none publishes how its confidence is calibrated or how it resists content written to fool it.

### 2.2 Government and military practice

**Canada.**
- *The originator decides.* Government of Canada training material says "the Originator of the information controls the classification of that information and is solely responsible for deciding if/when it can be declassified" [secondary: exhibit excerpt, https://foreigninterferencecommission.ca/fileadmin/foreign_interference_commission/Documents/Exhibits_and_Presentations/Exhibits/CAN026308.pdf]. The Privy Council Office's Cabinet confidences standard says marked documents "are to be assessed based on the information contained" and categorized under Appendix J, and that the categorization "may change during its lifecycle" [secondary: https://www.canada.ca/en/privy-council/services/publications/standard-security-cabinet-confidences.html].
- *Treasury Board's Standard on Security Categorization* (Directive on Security Management, Appendix J, effective 2019-07-01) sets the categories and injury tests [secondary: https://www.tbs-sct.canada.ca/pol/doc-eng.aspx?id=32614 ; the page refused automated fetches today, so its exact text on who categorizes and on review is **[unverified]**]. Report 02 read its aggregation clause directly on 2026-11-18: the category of a repository "reflects the impact of aggregation" [repo: report 02 section 11.3].
- *DND delegates classification authority in writing.* Open-government briefing note titles show "Classification authority letter of sub-delegation" records in 2025 [secondary: https://search.open.canada.ca/briefingt/record/dnd-mdn%2CHRCIV2025-0008230]. The National Defence Security Orders and Directives are on the DND network and were not read [unverified].
- *Generative AI guidance.* The Treasury Board guide asks institutions to make sure "the infrastructure and tools are appropriate for the security classification of the information", and staff are told never to put protected, classified or personal information into public generative AI tools [secondary: https://www.canada.ca/en/government/system/digital-government/digital-government-innovations/responsible-use-ai/guide-use-generative-ai.html ; https://www.canada.ca/en/government/system/digital-government/digital-government-innovations/responsible-use-ai/generative-ai-your-daily-work.html].
- *Agentic AI guide (2026-09-15).* "Accountability always ultimately rests with the designated human owner"; "include a review/confirmation step in the design" for actions that change a system's state; "Keep logs of tools used, actions taken, approvals given and key inputs/outputs"; treat external content as data, not instructions. It sets no data classification scheme [primary: https://www.canada.ca/en/government/system/digital-government/digital-government-innovations/responsible-use-ai/guide-use-agentic-artificial-antelligence.html].
- *Directive on Automated Decision-Making.* Its scope guide says the directive "covers individuals within and outside government", lists "appointing individuals to a position in the public service" and "launching an investigation into an individual's conduct" as administrative decisions, and puts "drafting documents" and actions that do not affect anyone's rights or interests out of scope [primary: https://www.canada.ca/en/government/system/digital-government/digital-government-innovations/responsible-use-ai/automated-decision-making/guide-scope-directive-automated-decision-making.html]. **So (inference):** proposing a document's label is most likely outside the directive, while an AI deciding a person's clearance or access would very likely be inside it. This is a second, independent reason for the boundary in section 5.2.
- *No CCCS or TBS guidance on using AI to categorize information was found* [unverified absence]. The joint guidance *Deploying AI Systems Securely* (April 2024), which the Cyber Centre co-sealed, covers running externally developed AI systems on premises in high-threat environments [secondary: https://www.cyber.gc.ca/en/news-events/joint-advisory-deploying-ai-systems-securely].

**United Kingdom.**
- *Government Security Classifications Policy, version 2.0 (updated 2024-08-05).* "Only the information creator from the originating organisation can reclassify" an asset (paragraph 37). Users may challenge a classification "with a reasoned argument" (paragraph 38). "Aggregated data sets of OFFICIAL information may warrant additional controls." The policy does not mention automated or AI classification [primary: https://www.gov.uk/government/publications/government-security-classifications/government-security-classifications-policy-html].
- *Technology-assisted sensitivity review* (University of Glasgow with The National Archives). Classifiers rank and prioritize documents for human sensitivity reviewers under FOI exemptions. The group's own earlier paper argues that a fully automated approach is unlikely to be acceptable to UK government departments, and a later journal paper studies how a classifier's accuracy and confidence affect reviewers [secondary: https://arxiv.org/pdf/1907.02956 ; https://www.dcs.gla.ac.uk/~graham/publications/PIR2014_gollins.pdf ; https://www.dcs.gla.ac.uk/~graham/publications/TOIS-McDonaldetal.pdf].

**United States.**
- *Derivative classifiers are named people.* "Derivative classifiers shall be identified by name and position, or by personal identifier, in a manner that is immediately apparent on each derivatively classified document" [primary: 32 CFR 2001.22(b), https://www.law.cornell.edu/cfr/text/32/2001.22].
- *Compilation.* Under Executive Order 13526 section 1.7(e), a compilation of individually unclassified items may be classified if it reveals an additional association or relationship that meets the standard, and that is not otherwise revealed. ISOO's checklist asks whether an original classification authority made that determination. FAS calls compilation "a policy that lends itself to misuse" [secondary: https://www.justice.gov/oip/page/file/1574551/download ; https://sgp.fas.org/library/compilations.pdf ; https://www.archives.gov/isoo/policy-documents/cnsi-eo.html].
- *CUI marking automation.* The Navy's 2022 prize challenge (under DoDI 5200.48) produced eight AI/ML prototypes for identifying and marking CUI. They were trained on simulated CUI because real CUI could not be used, and the first phase only tested CUI versus non-CUI. The Air Force's CUI working group was building an automated marking tool for correspondence. No department-wide fielding was found [secondary: https://www.navy.mil/Press-Office/News-Stories/Article/3251152/ ; https://www.af.mil/News/Article-Display/Article/2577849/].
- *State Department machine-learning declassification (from October 2022).* A model trained on reviewers' past decisions sorts cables into three groups: confident declassify, confident keep classified, and manual review. It "performed the same as human reviewers 97% to 99% of the time" and "reduced staff hours by at least 60%". It was designed to keep humans in the loop [secondary: https://fedscoop.com/how-the-state-department-used-ai-and-machine-learning-to-revolutionize-records-management/ ; https://transforming-classification.blogs.archives.gov/wp-content/uploads/sites/10/2024/07/State-AI-Pilot-Results-June-24-2024.pdf (image-only slides; numbers not read)]. A Databricks talk quotes 58.1 percent agreement in one quality-control check and human review on 20 percent of cables. These numbers conflict and are unexplained [secondary, unverified].

**NATO.**
- *Labels.* STANAG 4774 (ADatP-4774) gives the confidentiality label syntax: policy identifier, classification, categories and lifecycle fields. STANAG 4778 binds a label to data, optionally by signature, so that "the digital signature can usually also be used to validate the originator" [secondary: Isode paper, https://www.isode.com/wp-content/uploads/2026/03/Isode-Approach-to-Data-Centric-Security-using-NATO-Confidentiality-Labels.pdf ; data-centric report 2.2].
- *Research on predicting labels.* NCIA researchers applied classical machine learning, then deep learning, to predict NATO documents' classification from content (ICMCIS 2018), and STO IST-160 papers report predicting classification for documents with incomplete metadata [secondary: https://unpaywall.org/10.1109%2FICMCIS.2018.8398703 ; https://www.sto.nato.int/publications/STO%20Meeting%20Proceedings/STO-MP-IST-160/MP-IST-160-S4-5.pdf]. No fielded NATO auto-labelling service was found [unverified absence].
- *Principles of Responsible Use* (2021, reaffirmed in the revised AI strategy of 2024-07-10): lawfulness; responsibility and accountability; explainability and traceability; reliability; governability; bias mitigation [secondary: https://www.nato.int/cps/en/natohq/official_texts_227237.htm].

**What government practice agrees on (inference):**
- **A named person is the classifier of record.** The originator classifies, and only the originator or a delegated authority lowers or declassifies.
- **Marking derives from sources and guides.** A derivative marking comes from source documents or a classification guide.
- **Compilation needs an authority's determination.**
- **Machine learning is used for triage at volume**: CUI identification, declassification review, FOI sensitivity review. It sorts work into confident groups and a human-review group, and humans stay in the loop.
- **No policy found authorizes a machine to be the classification authority.**

### 2.3 Open-source classifiers and models

Report 02 section 2 surveyed the detectors and stands:
- Presidio (MIT) as the frame and for checksum-backed identifiers;
- GLiNER (Apache-2.0) and OpenAI Privacy Filter (Apache-2.0) as span detectors;
- gitleaks rules (MIT) for secrets; TruffleHog excluded (AGPL);
- a local LLM for context-dependent judgements.

**Added here:**

| Need | Candidate | Licence | Fit | Mark |
|---|---|---|---|---|
| The classification model (Tier 2) | `gpt-oss-20b` (fits one 16 GB-class GPU or a Strix Halo host); `gpt-oss-120b` at HQ | Apache-2.0 plus OpenAI's usage policy | Western; on the owner's model list; runs on llama.cpp (MIT), already the data platform's runtime | licence [repo: model provenance design]; runtime [repo: data platform 00-DESIGN] |
| A second opinion from another family | Nemotron 3 Nano or Command A+ | NVIDIA Open Model License; Command A+ recorded as Apache-2.0 in the provenance design | Different family, as MPRV-09 requires for checking roles | [repo]; Command A+'s licence is worth rechecking at phase research [unverified] |
| Prompt-injection and jailbreak detectors | NVIDIA NemoGuard JailbreakDetect; Nemotron content-safety models; IBM Granite Guardian | NVIDIA Open Model License (plus Llama or Gemma terms for some); Granite Guardian's licence not confirmed | **Not proposed.** They detect jailbreaks against chat assistants, not content written to fool a classifier, and the structural defences in section 3.6 do not depend on them | [secondary: https://build.nvidia.com/nvidia/nemoguard-jailbreak-detect/modelcard ; https://arxiv.org/abs/2412.07724v2] |
| PRC models (Qwen, GLM and others) | Any | Various | **Not for classification.** It is a checking job, so at least T2, and T3 for staff and classified work; PRC-origin models are capped at T0, or T1 with an acceptance | [repo: `models.ts`, `JOB_MINIMUM_TIER.safety = 'T2'`] |

### 2.4 Confidence, human review and downgrades across the prior art

| | Confidence used for | Human review | Downgrade |
|---|---|---|---|
| Purview | Choosing detector matches (65/75/85) | Recommend-and-confirm at creation; simulation before bulk | Manual, with a justification; automatic labels never replace manual or higher ones |
| Fortra | Not published | The user classifies; ML validates or suggests | Not published |
| State Department | Three groups: confident either way, or manual | The manual group, plus quality-control sampling | The task is declassification; humans in the loop by design |
| Glasgow / The National Archives | Ranking the review order | Every document still reviewed, faster | n/a |
| UK GSCP | n/a | n/a | Only the information creator |
| US derivative classification | n/a | The named derivative classifier | An original classification authority |

**Lesson for us (inference):** use confidence to choose between **automatic raise**, **suggestion** and **nothing**, never between lowering and keeping. A lowering is always a person's decision, whatever the model's confidence.

---

## 3. Safety design

### 3.1 The rule: asymmetric application

> **A model proposes. Signed policy decides. Automatic steps may raise or keep. Lowering, widening and declassifying need a person with the authority. The person who finalizes is the classifier of record.**

Which changes count as raising and which as lowering follows from the join in `dominance.ts` [repo]:

| Change | Direction | Automatic? | Who may do it otherwise |
|---|---|---|---|
| Level up (Protected A to Protected B; Confidential to Secret) | Raise | **Yes**, above the threshold (3.2) | Anyone with access |
| Level kept (the model confirms the current label) | Keep | **Yes** (recorded as support for the originator's affirmation) | n/a |
| Level down | Lower | **Never** | The originator, up to the level their `ClassificationAuthorityCredential` covers; above that, the classification authority |
| Compartment added (`ITAR`, `CGP`, `EAR`, a codeword) | Raise | **Yes** | Anyone with access |
| Compartment removed | Lower | **Never** | The compartment owner; for `CGP`, `ITAR` and `EAR`, your organization's designated official (Phase 45) |
| Releasability narrowed (removing a country; adding `CAN EYES ONLY`) | Raise | **Yes** | Anyone with access |
| Releasability widened (adding `REL TO USA`) | Lower (a release decision) | **Never** | A release authority (`ReleaseAuthorityCredential`, data-centric report 5.1) |
| Handling flag added (`local-only`, `no-agent-tools`, and report 02's `no-train`) | Raise | **Yes** | Anyone with access |
| Handling flag removed | Lower | **Never** | The originator or the steward |
| Retention class proposed | Neither | Proposal only | A person confirms any class that leads to destruction (report 02, DSEC-10) |
| Declassification, or release to an observer or a coalition | Lower | **Never** | A release authority, through `observer.release` or `marking.approve` |

Two limits on automatic raises, so that a raise cannot become a denial of service (inference):
- **A raise that removes access from people who used the item recently**, or from a cell's current holders, still applies at once. The originator or steward is told at the same moment, with a one-step "this is wrong, request lower".
- **A raise by more than one level, or to your organization's top level, also enters the review queue**, ordered by impact as in report 02 section 7.3.

### 3.2 Thresholds from the cost of each error

Under-classifying causes a spill. Over-classifying causes friction, and people then route around the system. Set the threshold for each level from the ratio of the two costs, then check it against measured recall.

**Rule (inference, standard decision theory):** raise to level L when the calibrated probability that the true level is at least L meets

`τ(L) = 1 / (1 + r(L))`, where `r(L)` = cost of under-classifying at L ÷ cost of over-classifying at L.

| Level (Canadian scales) | Example cost ratio r | Raise threshold τ | Recall target on the in-domain audit (3.8) |
|---|---|---|---|
| Protected A | 4 | 0.20 | 0.90 |
| Protected B, Confidential | 9 | 0.10 | 0.95 |
| Protected C, Secret | 19 | 0.05 | 0.98 |
| Top Secret | 49 | 0.02 | 0.99 |

The ratios are **examples** for your organization's security officer to set in the signed bundle (owner decision D5). Then:
- **Calibrate on audited data before enforcing.** A raw model probability is not a calibrated probability. Fit per-level calibration on the in-domain audit set. Use the probability of each choice under constrained output (llama.cpp exposes token probabilities) and agreement between samples and between two model families. A model's own stated confidence is not used (inference). Conformal risk control can set a per-level threshold with a finite-sample recall guarantee, but only while the audit set and live content come from the same distribution; the published work applies it to other domains, not to classification [secondary: https://arxiv.org/html/2603.00924v1 ; https://odr.chalmers.se/items/99cd5e04-1aaa-4f56-a083-ed04651bcc72/full].
- **Three bands per level:** at or above τ, raise; between τ/4 and τ, show a suggestion beside the editor with no change; below τ/4, show nothing (inference; the State Department's three groups are the same shape).
- **When recall on a level falls below target, lower that level's τ automatically** (more raises) until the audit recovers. Report 02's TAG-08 already does this for ingest.
- **Deterministic facts do not use thresholds.** A `SECRET` banner in the text, a code word on your organization's list, a controlled-goods item, a source label: each is a floor and raises with certainty.

### 3.3 Never classify from the bottom

A proposal's starting point is the **join** of:
- the session's high-water mark (CLAS-04), which already covers everything the author read;
- the labels of the sources the content was built from (copy and apply, attachments, citations);
- the project, folder or cell label;
- on ingest, the source label and your organization's ingest default (report 02).

The model can only add to that join. Report 02's raise-only rule covers prompt injection for items that already have a label. For **new** content, a classifier that starts from the lowest level would let an injected "this is unclassified" suppress a raise. Starting from the inherited join closes that gap: content written in a Secret session starts at Secret whatever the model says (inference).

**Synthesis outputs get classified as well as inheriting.** A summary of many unclassified items carries an unclassified mark, yet may reveal a classified association (3.5). So every output an agent writes, sends or summarizes runs through the classifier, and its result joins the inherited mark (inference).

### 3.4 Every proposal cites its basis

| Basis kind | Example | May raise automatically? | Confidence |
|---|---|---|---|
| `source` | Inherited from a labelled source the content quotes or was built from | Yes (it is the join) | Certain |
| `marking` | A banner or portion marking found in the text ("SECRET", "PROTECTED B", "CEO") | Yes, as a floor | Certain for a recognized marking |
| `guide` | An entry in your organization's security classification guide, matched by a signed rule ("unit + location + future date → Secret") | Yes | Certain when the rule's facts are present |
| `detector` | A checksum-valid identifier, a controlled-goods or USML item, a code word, a secret | Yes, through report 02's rules | Per detector |
| `compilation` | A signed compilation rule fired over extracted facts (3.5) | Yes | Certain when the rule fires |
| `judgement` | The model's own reading, with a short rationale | Yes, above τ; **always** also shown to the originator or steward | Calibrated probability |

Why (inference): this is how derivative classification already works (marking "derived from" a source or a guide). It makes a proposal checkable by the originator in seconds. It lets the audit separate rule errors from model errors. And a security classification guide becomes **signed rules plus retrieval**, so most defence content is classified by your organization's own guide, with the model's role limited to extracting facts and finding the guide entry.

**Security classification guides are often classified themselves (inference).** Rules and retrieved guide text are labelled at the guide's level. A prompt that contains them carries that level, and the classifier runs inside the guide's security domain (section 4).

### 3.5 Aggregation and compilation

Phase 93 already plans aggregation rules over indexes, exports, datasets and a chat's running count of distinct items (DSEC-07) [repo]. Defence content adds **compilation**: individually unclassified facts that together reveal a classified association.

Recommended (inference):
1. **The model extracts facts, rules decide.** The model extracts typed facts (unit, location, date, capability, person, operation name) into the proposal record. Signed compilation rules from your organization's guide decide the level, for example "unit identity + location + date of a future move → Secret". This keeps compilation decisions with the authority, as EO 13526 does with its original classification authority.
2. **Evaluate over the session, not only the document.** A chat's or agent run's running fact set is checked against compilation rules, so three harmless answers in a row that together reveal the association raise the session mark.
3. **The model may propose a new compilation rule**, as a card for the classification authority. It cannot apply one. A rule is signed only after its simulation has run (report 02's TAG-07 pattern).
4. **The context graph and search indexes are aggregates by default** (report 02).

### 3.6 Adversarial and prompt-injected content

Evidence: hidden instructions in PDFs steer LLMs even on trivial questions [secondary: https://arxiv.org/pdf/2508.13214]. Invisible text in papers flips LLM reviewers' accept or reject decisions, and real arXiv papers have been found carrying such instructions [secondary: https://arxiv.org/html/2512.10449v3]. Optimized injections beat manual ones and evade known-answer detection [secondary: https://arxiv.org/pdf/2403.17710]. Committees of diverse models improved robustness [secondary: https://arxiv.org/html/2504.18333v1].

| Attack | Defence | Kind |
|---|---|---|
| "This document is unclassified" in the text | The model can only add to the inherited join (3.3); a contradicting banner never lowers | Structural |
| Hidden text (white on white, zero-size font, metadata, comments, alt text) telling the classifier what to say | Extraction renders what a reader sees **and** what is hidden; hidden instructions addressed to a classifier or an AI are themselves a fact that raises and goes to review | Structural plus detector |
| Text that tries to make the model emit a label, change format or call tools | Constrained JSON output against a closed schema; no tools; the policy and thresholds are never in the prompt; content goes in a delimited data block | Structural |
| An optimized suffix that lowers the model's probability for a level | Deterministic floors and guide rules do not read the model; a second family must agree on "nothing to raise" for the top levels; red-team set (3.8) | Defence in depth |
| Over-classification as denial of service (text that forces everything to Top Secret, or narrows releasability to cut off a coalition partner) | Impact notice and the review queue (3.1); per-source and per-author rate of raises on the drift dashboard; the "request lower" path stays one step | Detection plus recovery |
| Poisoning a fine-tuned classifier through review decisions | Training examples only from signed reviewer decisions; two-person review for examples at your organization's top levels; a frozen golden set held out of training | Process |

The Treasury Board's agentic AI guide gives the same instruction in plain words: treat external content as data, not instructions [primary].

### 3.7 Drift

| Cause | Detection | Response |
|---|---|---|
| A new model artifact, quantization or prompt template | The passport's re-evaluation triggers (`artifact-change`, `quantization`, `fine-tune`) [repo: `models.ts`]; the frozen golden set re-run on every change [secondary: https://arxiv.org/pdf/2601.02370] | The classifier stays in shadow until the golden set passes; a passport drops to T0 on any trigger, so the classifier cannot be used for enforcement until re-evaluated |
| New content (a new operation, new code words, a new partner) | Weekly label-share per source and author; rate of originator overrides; rate of "could be lower" requests; agreement on a fresh sample against the golden set [secondary: https://www.enterpret.com/guides/the-6-signals-of-taxonomy-drift-in-an-llm-feedback-classifier] | A card for the security officer: update the guide's rules or the code-word list; thresholds re-fitted from the audit |
| A guide or policy change | The bundle hash in every proposal record | Items classified under the old rules are re-proposed; re-proposal never lowers (report 02's "could be lower" batch) |

### 3.8 Evaluation datasets and red-teaming

The difficulty is that an evaluation set at level L is itself at level L and cannot leave that domain. The Navy's CUI challenge hit the same wall and used simulated data [secondary].

| Set | Built from | Level and location | Used for |
|---|---|---|---|
| **Public capability set** | Declassified documents with their original markings (for example released diplomatic cables, which the State Department pilot used [secondary]) and released Canadian records; marking and banner fixtures | Unclassified; shipped with the tests if their licences allow | Choosing a base model; regression on every release |
| **Synthetic guide set** | Documents generated from your organization's own guide entries, each with its expected label and basis | At the guide's level, built inside that domain | Rule coverage and fact extraction |
| **In-domain golden set** | A stratified, blind sample of real items reviewed by two people, per level (report 02's TAG-08) | At each item's level, never exported | Calibration, recall per level, the enforcement gate |
| **Red-team set** | Injection documents, hidden text, compilation puzzles across several messages, French and mixed-language content, OCR'd scans, tables, images with text, near-miss code words, over-classification attacks | Unclassified fixtures, plus in-domain variants | A release gate: no red-team item may lower a label or suppress a floor |

**Metrics:**
- recall at or above each level (the number that matters);
- over-classification rate per level;
- originator override rate (raises reverted, suggestions declined);
- review load per person per week;
- time from save to proposal.

One overall accuracy number is never reported (report 02 section 2.4).

**Gate:** the classifier enforces automatic raises only after the shadow period (owner decision D10) and only while the in-domain recall targets of 3.2 hold. Before that, it suggests only. This is Purview's simulation rule, applied to a model (inference).

### 3.9 Audit record

One record per proposal, OCSF-shaped like the gate's decision records [repo: `record.ts`]:

| Field | Content | Why |
|---|---|---|
| `item`, `contentHash`, `revision` | What was classified, exactly | A proposal for an older revision is stale and discarded |
| `start` | The inherited join (3.3) | Shows the model only added |
| `proposal` | The label, per-field direction, and each basis with its kind and reference (guide entry id, rule id, detector id, source item) | The originator's check; the audit's error attribution |
| `confidence` | Calibrated probability per level, sample agreement, second-family agreement | Thresholds and drift |
| `model` | Passport id and hash, artifact hash, endpoint class, use tier | MPRV-10 already puts these on route records [repo: ROADMAP 74.1] |
| `prompt` | Template hash, rules and guide version hash (bundle hash), decoding settings | Reproducibility; drift attribution |
| `rationale` | A short reason, **labelled at the item's label** | It is derived content and may carry the content itself |
| `outcome` | `auto-raised`, `suggested`, `kept`, `none`; then `affirmed`, `reverted-by-request`, `lowered` with the actor | The state machine in 6.5 |
| `actor` | The agent `did:key` and its delegation for automatic steps; the person DID and the credential hash for each human decision | Accountability (3.10) |
| `signature` | Agent session key for automatic steps; the person's key with step-up for lowering | 4778-style binding of label to content |

Batches are covered by report 02's signed Merkle roots (DSEC-05). Records hold names, hashes and ids, never contents, except the labelled rationale.

### 3.10 Who is accountable

- **For content created in the workbench, the originator** (the person who writes, finalizes, sends or releases it) is the classifier of record. The record reads "Classified by: <person, position>, assisted by: <model passport>", following 32 CFR 2001.22(b)'s naming rule and the Canadian originator principle [primary; secondary]. The originator affirms the label at the finalize step (6.5), so no label becomes final without a named person.
- **Automatic raises are a machine action under a signed policy.** The security officer who signed the classification rules and thresholds is accountable for them, as the agentic AI guide's "designated human owner" [primary].
- **Lowering and declassification** belong to the originator within their delegated authority, or to the classification authority above it. That mirrors DND's written sub-delegations [secondary] and the UK's "only the information creator" [primary].
- **For ingested data with no present originator (Phase 93)**, the item's steward from the source and the directory (never a model; TAG-04) takes the originator's role.
- **The product never says the AI classified something.** It says the AI proposed, and names who affirmed.

### 3.11 Automation bias

A suggestion that is almost always right is soon accepted without being read. The Glasgow work studied how classifier confidence changes reviewers' behaviour [secondary].

Mitigations (inference):
- show the **basis**, not only the label;
- the blind audit sample hides the model's proposal from the reviewer (TAG-08 is already blind);
- measure each reviewer's agreement with the model against the audit;
- keep affirmation to a single deliberate step at finalize, rather than a prompt on every save that trains people to click through.

---

## 4. Where it runs

### 4.1 The system-high rule

The classifier reads content before its level is known. So it runs where **the highest level that system or source may hold** may go, not where the predicted level may go (inference, extending report 02 section 1.5):

| Deployment | System-high | Where the classifier runs |
|---|---|---|
| Single machine, commercial `org` scale, no organization policy | Your organization's ingest default (for example `org/Confidential`) | A local model; attested cloud only where the signed policy's routing allows that default |
| HQ on a Protected B network | Protected B | A model on the HQ's own hosts (`local` or `org-plain`), or `org-tee` (Phase 74.2) if the policy allows it for Protected B |
| HQ classified enclave (Secret) | Secret | A model on hosts inside the enclave only. Weights come in by your organization's approved transfer, and the artifact hash is checked against the passport |
| Edge laptop or tactical node | The edge's accreditation | A small local model, or rules only (4.4) |

**A prediction above system-high is a possible spill, not a label.** If a Protected B system's classifier finds a Secret marking or a guide rule for Secret, the content should not be on that system at all. The item is raised to the system's top level with `local-only` and `no-agent-tools`, frozen for sharing, and reported to your organization's security officer as a possible security incident with its basis (inference). This is one of the most valuable things the classifier can do.

### 4.2 The model must be approved for the job and the level

- **Use tier.** Classification is a checking job: its verdict gates where content may go. The shipped table already makes a checking job at least T2 [repo: `JOB_MINIMUM_TIER.safety`]. For staff projects and classified work it is T3, which needs a passport with an evaluation reference [repo: `models.ts` rule]. The evaluation reference is the gate of 3.8.
- **Origin.** Western bases only: gpt-oss, Nemotron 3, Command A+. PRC-origin models can never classify, because they are capped at T0, or T1 with an acceptance.
- **Family.** MPRV-09 already says a checking role never runs on the same family as the work it checks. A product drafted by a Nemotron agent is classified by gpt-oss, or the other way round. For the top levels, the second family must also agree on "nothing to raise" (3.6).
- **Accreditation, not "model clearance".** Weights hold no clearance (inference). What must be approved for level L is the **system**: the host, its network domain, its logs and caches, and the passport naming the exact artifact. The prompt, the KV cache, the logs and the rationale are all at the content's level and stay on that system.

### 4.3 A fine-tuned classifier carries its training data's label

Report 02 and FAC-03 already make a model's label the join of its training data [repo]. So a classifier fine-tuned on Secret review decisions is a Secret model. It runs only inside a Secret domain and cannot be copied to a Protected B system (inference). Recommended:
- the **base classifier** ships with prompts and the public and synthetic sets only, and can be used everywhere;
- each domain's **specialist** (Phase 98/99) is trained inside that domain, from that domain's signed review decisions, and stays there;
- **few-shot retrieval** of a domain's own labelled examples happens inside that domain, at their level.

### 4.4 Offline at edges

- **Rules always run.** Banners, code words, guide rules, compilation rules and source labels are pure TypeScript over the signed bundle, with no model and no network.
- **A small model if the hardware allows.** For example gpt-oss-20b, quantized, on a 16 GB-class GPU or a Strix Halo-class edge box (throughput in 4.5), named by a passport for that artifact.
- **With no model,** new content keeps the inherited join and the edge's strict default. The originator can still affirm their own label, which is the human classification act anyway. Each item is marked `unassessed` and queued.
- **On reconnect,** HQ's classifier re-proposes queued items. Its result only raises; a "could be lower" goes to the originator's weekly batch.
- **Nothing waits on the network.** Proposals are advisory to editing; only finalize asks for the originator's affirmation, and that works offline.

### 4.5 Throughput for an HQ of about 400 people

**Assumptions (inference, to be replaced by Phase 85 measurements):**
- about 30 classifiable items per person per day: products, sections, messages, agent outputs and attachments, each classified on save after edits settle, not per keystroke;
- **12,000 items a day**, half settled by rules alone, so **about 6,000 model calls a day**;
- about 2,000 input tokens and 150 output tokens per call, with one sample normally and three only near a threshold.

**Measured elsewhere:**
- gpt-oss-20b on a Strix Halo with llama.cpp: about 1,100 to 1,400 prompt tokens per second (pp512) and about 62 to 78 generated tokens per second (tg128); Vulkan was faster than ROCm [secondary: https://community.frame.work/t/amd-strix-halo-ryzen-ai-max-395-gpu-llm-performance-tests/72521 ; https://zenn.dev/robustonian/articles/gpt_oss_bench ; https://www.phoronix.com/review/amd-rocm-7-strix-halo/3];
- on one H100: about 700 tokens per second total at concurrency 1, rising to about 1,960 at concurrency 4 [secondary: https://docs.oracle.com/en-us/iaas/Content/generative-ai/benchmark-openai-gpt-oss-20b.htm].

**Estimate (inference):**

| | One Strix Halo host | One data-centre GPU (H100 or L40S class) |
|---|---|---|
| Time per call, single stream | about 1.6 s prompt + 2.1 s output ≈ 4 s | about 1 s or less [unverified] |
| Daily load (6,000 calls) | about 6.5 hours of single-stream time; spread over a working day with 2 to 4 parallel slots, fine | Under an hour |
| Peak (3 times the mean, about 20 calls a minute) | Proposals arrive 5 to 15 seconds after save: acceptable for a panel beside the editor, not for inline typing | Seconds |
| Backfill of an existing archive (1 million items × 2,000 tokens) | About 19 days of prompt processing: too slow alone. Use the tiers (rules first, the model only on unsettled, sampled and about-to-be-used items, as report 02 says) | About 2 days [unverified] |

**Recommendation (inference):**
- two inference hosts per HQ security domain, so one can fail;
- the assistant's proposals are asynchronous and never block typing;
- Phase 85 measures the real numbers on the host before Phase 74.3 sets its latency targets.

---

## 5. What it assigns

### 5.1 Data attributes

| Attribute | AI role | Applied automatically when | Confirmed or changed by |
|---|---|---|---|
| Level on the scale | Proposes with a basis | Raise above τ, or a deterministic floor | Originator affirms; lowering by authority |
| Caveats and handling (`CAN EYES ONLY`, Cabinet confidence, `local-only`, `no-agent-tools`, `no-train`) | Proposes | Adding | Removing by originator or steward |
| Compartments (`CGP`, `ITAR`, `EAR`, codewords) | Proposes from detectors (controlled-goods list, USML categories) and guide rules | Adding | Removing by the compartment owner or designated official |
| Releasability | Proposes narrowing from sources; **never proposes widening as a change**, only as a suggestion to a release authority | Narrowing | Widening by a release authority |
| Required clearance | Not assigned separately: it **is** the label's level, compartments and releasability, read by `mayRelease` | n/a | n/a |
| Retention class | Proposes from the records schedule | Never for destruction classes | A person confirms (report 02) |
| Topics, document type, function, privacy facts | Proposes (report 02 section 2.3 and 3.2) | Yes; these are descriptive, not access decisions | Correctable by anyone with access |
| Owner and steward | **Never guessed** (TAG-04) | n/a | From the source and the directory |
| STANAG 4774 label | Derived from the label through the mapping table the data-centric report recommends | With the label | The mapping is signed by the security officer |

### 5.2 Person attributes: the boundary

The owner said "assign attributes". **Recommendation: AI may propose data attributes. It must never assign, issue or infer person attributes.**

| Person attribute | Who issues it (data-centric report 5.1) | Why AI must not |
|---|---|---|
| Clearance (`ClearanceCredential`) | Your organization's security officer, after security screening | Screening is a person-run process under the Standard on Security Screening [unverified: not read today]. An AI decision about a person's access is an administrative decision under the Directive on Automated Decision-Making, whose scope covers employees and appointments [primary] |
| Nationality, organization | Security officer or security contact, after an identity check | Inferring nationality from a name or a writing style is discriminatory and wrong, and releasability would then rest on a guess |
| Compartment holdings | The compartment owner | Need-to-know is a human judgement by the owner |
| Export eligibility (`CGP`, `ITAR`, `EAR`) | Your organization's designated official (Phase 45) | A legal designation |
| How a person serves, position postings | J1 or HR authority; the posting authority (Phase 33.1) | Administrative decisions about a person |
| Access agreement, visit clearance | Security contact | A signed agreement or an approved visit |

**What AI may do on the person side (inference):**
- **Check an issuance request for completeness.** For example: "this visit request has no end date"; "this nationality is not in the policy's vocabulary". The officer still decides and signs.
- **Suggest who might need an item**, by position or role, to the originator or release authority as a release suggestion. A person then grants it through the normal release, so it is checked by `mayRelease` against verified credentials.
- **Watch for unusual access patterns** (the watching agent, Phase 99): flag them to the security officer on a card. It never suspends or revokes anything by itself.

**Make it structural, not a promise** (the "fix the class, not the instance" rule):
1. **Agents can never be issuers.** The `credentials@1` trusted-issuer section, and every issuer role credential, may name only person `did:webvh` subjects. An agent or device `did:key` can never be a trusted issuer or hold an issuer role credential. The verifier refuses such a chain. One property test in Phase 71 (core).
2. **Issuance needs a person present.** It already needs a passkey step-up in the officer's own session (data-centric report O4); an unattended or agent context is refused by the gate's floor.
3. **The classifier's output schema has no person fields.** It is a closed schema of label fields, bases, facts and confidence.
4. **`mayRelease` reads only verified credentials**, never a model's output (data-centric report 3.4; VCRD-07).

### 5.3 Position attributes

A position's `requiredClearance` and `eligibleServes` are data attributes of a resource (data-centric report 5.1). The establishment authority sets them; AI may propose them from the position's duties, as a suggestion that authority signs (inference).

---

## 6. Integration

### 6.1 From proposal to signed label

```
 content saved / output written / item ingested
        │
        ▼
 start = join(session mark, source labels, project/cell label, ingest default)        (pure)
        │
        ├──► Tier 0 rules: markings, code words, guide rules, detectors, compilation   (pure, signed bundle)
        │
        └──► model (local / org host, system-high, passport T2/T3, other family)
                 │  closed JSON: facts, label fields, bases, probabilities
                 ▼
 classify.decide(start, rules, model result, thresholds)  ──►  proposal record (3.9)
        │                                                     (pure: raise / suggest / keep / none)
        ▼
 auto-raise ──► label.auto-raised (agent did:key under a raise-only delegation)
 suggestion ──► shown in the Classification panel
        │
        ▼
 originator finalizes ──► affirms label (person key) ──► label bound to content hash (4778-style)
 request lower ──► authority's card ──► step-up ──► signed lowering (person key + ClassificationAuthorityCredential)
```

### 6.2 Phase 70: the gate

- **Reuse, no format change.** A raise goes through the existing paths: Set Label (70-20), the session mark (70-22), and the label map, where an unverified map applies only where it raises [repo]. The label map v1 needs no new field. Provenance lives in the proposal record and the label event, not in the map (inference: smaller undo cost).
- **Events.** Add the events report 02 already named, before they ship (D-49): `label.auto-raised`, `label.exception-queued`, `label.exception-resolved`, `label.could-be-lower`. Add one more, `label.affirmed`.
- **The engine is pure.** It goes in `src/domain/classify/`, importing only `labels.ts` and `dominance.ts`, and holds:
  - the proposal schema;
  - `decide()` (3.1, 3.2);
  - the compilation rule evaluator, which extends the Phase 38 aggregation evaluator that Phase 97 notes Phase 93 extends;
  - the record shape.

  The bundle gains a `classification@1` section: thresholds per level, guide rules, compilation rules, the code-word list, and the source label map from report 02.

### 6.3 Phase 33 cells and 33.1 markings

- **A raise on a cell's content raises the cell label.** The wrap preparer then writes the next epoch only for holders that `mayRelease` still allows. `planRekey` already handles a narrowing reason. Add `label-raised` beside `clearance-lowered` (inference).
- **A lowering or a releasability widening on a cell** goes through `marking.approve`, signed by a person holding the authority credential. It is already a 4778-style signature in the data-centric design.
- **Amendment now, while the shapes are open** (data-centric step A): marking and label-change entries carry an optional `basis: <proposal record hash>` slot. That is the only permanent-shape change this report needs.
- **Observers** never see proposals, rationales or bases. Release copies carry title, content and the affirmed marking only (33.1 D-35).

### 6.4 Phase 71 (core): credentials

- **Add `ClassificationAuthorityCredential { scale, upTo, scope }`** to the credential table. It names who may lower or declassify, and up to which level, issued from your organization's root like any role credential. It is the digital form of DND's written sub-delegations.
- **The originator's own authority to lower their own item** is the same credential with `scope: own-items`, issued at enrolment to the positions your organization names.
- **Agents act under a raise-only delegation** (DLGT-02: delegations only narrow). The delegation names the `label.raise` capability and no lowering capability, so the gate refuses an agent lowering whatever the prompt says.
- **The structural invariant of 5.2** (agents can never be issuers) is one verifier rule and one property test.

### 6.5 The review workflow in the workbench (and its state machine)

Native Theia panel "Classification" beside the editor (Sterling workbench). States of a piece of content:

| State | Label | Enters when | Leaves when |
|---|---|---|---|
| `draft` | The inherited join | Created | Saved, and edits settle |
| `assessing` | The same | A proposal is requested | The result arrives (to `proposed`), or the classifier is unavailable or times out (to `unassessed`) |
| `proposed` | The join plus any automatic raise | A result arrives for the **current** content hash; a result for an older hash is dropped | The originator finalizes (to `affirmed`), or requests lower (to `lower-requested`) |
| `unassessed` | The join plus rules only | No classifier, offline, or timeout | The classifier returns (to `proposed`), or the originator finalizes anyway (to `affirmed`, recorded as "no assistant") |
| `affirmed` | Final, signed by the originator | Finalize, send or release, with a one-step affirmation showing the bases | Content edited (to `draft`; the label never goes down by editing), or a lowering is approved |
| `lower-requested` | Unchanged (stays high) | Originator or steward asks, with a reason | The authority approves (to `affirmed` at the lower label) or refuses (back to `affirmed`); escalated after the policy's age limit, never dropped |

No state waits on the network or on a model: `assessing` always resolves to `proposed` or `unassessed`, and finalize works in both. What the panel shows:
- the label;
- each basis, in plain words, with a link to the guide entry or source;
- the model and passport (the trust line);
- Accept, Raise, Request lower.

Stewards get report 02's weekly impact-ordered batch for ingested items. Authorities get lowering cards with passkey step-up.

### 6.6 Data platform, model factory and the watching agent

- **Phase 93** reuses `src/domain/classify/` and the Phase 74.3 runner for ingested items. TAG-03 ("a local LLM, three samples, majority vote") becomes a call to the shared runner. Phase 93's own work narrows to connectors' source labels, privacy facts, the item card and the bulk exception queue.
- **Phase 98 (model factory)** can later train a **classification specialist** from signed review decisions, per security domain, with the label of its data (4.3). It is not the first specialist: decision 13 keeps the first one on chat and run logs [repo].
- **Phase 99 (the watching agent)** watches drift (3.7), override rates, spill alerts and guide gaps, and proposes cards: a new code word, a new compilation rule, a threshold change, a guide entry that is never matched. It never applies them.

---

## 7. Recommendation: phases, order and dependencies

### 7.1 New phases

**Phase 70.1: Classification engine (pure).**
- Goal: one pure engine decides what any classification proposal may do to a label, under signed policy, and records it.
- Contents:
  - `src/domain/classify/`: the proposal schema v1, `decide()` with the asymmetric rules and threshold bands, the compilation and guide rule evaluator, the record shape;
  - the bundle section `classification@1`;
  - the label events;
  - property tests: no proposal ever lowers any field; a stale content hash never applies; a prediction above system-high always gives the spill outcome;
  - the red-team fixtures that need no model (banners, hidden-text facts).
- Depends on Phase 70 PR 4b and 4c on main (labels written to disk, session mark). Needs no model and no network.
- Undo cost: high, because the record and the bundle section are permanent. Settle the record shape in plan 01.

**Phase 74.3: Classification assistant.**
- Goal: a local Western model proposes labels with bases at creation; the originator affirms them in the workbench; authorities lower them with a credential.
- Contents:
  - the runner (llama.cpp `local` and `org-plain` endpoints, system-high routing, passport check, two-family agreement at the top levels);
  - the evaluation harness (public, synthetic, golden and red-team sets) and the shadow mode;
  - the native Classification panel and the state machine of 6.5;
  - signed affirmation and lowering;
  - the spill alert;
  - cell integration: raise to rekey, lowering through `marking.approve`.
- Depends on:
  - Phase 70.1;
  - Phase 74.1 (passports enforced, Western defaults);
  - Phase 71 (core) plans 1 to 5 (verifier, `mayRelease`) and 7 (issuance, for `ClassificationAuthorityCredential`);
  - Phase 46-07 (key service, for person signatures);
  - a local inference host (Phase 85's host, or your organization's host; 74.2 if `org-tee`).
- Its cell plans also wait for Phase 33.1's marking waves (33.1-19 to 33.1-21) on main.
- Research flags:
  - the Phase 85 throughput numbers;
  - whether llama.cpp's token probabilities under grammar-constrained output are good enough for calibration;
  - Command A+'s weight licence;
  - your organization's guide format.

### 7.2 Amendments (text only, now)

| Where | Amendment | Why now |
|---|---|---|
| Phase 71 (core) credential table (data-centric report 5.1) | Add `ClassificationAuthorityCredential { scale, upTo, scope }`; add the invariant "agents and devices can never be issuers" and its property test | 71 (core) plans are being written now (data-centric step B) |
| 33.1 plan 01 permanent shapes | Optional `basis: <proposal hash>` on marking and label-change entries | Shapes become permanent at that checkpoint |
| Phase 70 events (D-49) | Name `label.auto-raised`, `label.exception-queued`, `label.exception-resolved`, `label.could-be-lower`, `label.affirmed` before PR 4c ships | Event ids never change in place |
| Phase 93 | Depends on 70.1 and 74.3; TAG-03 reuses the runner | Avoids a second classifier |
| Phases 98, 99 | A classification specialist (later) and drift cards | Same engine, same records |

### 7.3 Order

| Step | Work | Runs beside | Why |
|---|---|---|---|
| A (now, docs) | The amendments in 7.2 | Everything | Shapes and the credential table are still open |
| B | Phase 70.1 | Phase 71 (core) research and plans 1 to 6; Phase 33 waves; Phase 74.1 | Pure code in a new folder; it needs only labels and the session mark |
| C | Phase 74.3, chats, files and products (single machine and hosted sessions) | 33.1 waves 4 to 7 | Needs 70.1, 74.1, 71 (core) plans 1 to 5 and 7, 46-07 |
| D | Phase 74.3, cell plans | After 33.1's marking waves | Cells need `cell.marking` and `marking.approve` |
| E | Phase 93 (data platform) | Stage C order | Reuses B and C |
| F | Phases 98 and 99 additions | Stage E order | Need signed review decisions to train from |

Only B to C is a real dependency in sequence (the assistant needs the engine). Everything else runs in parallel with work already planned.

---

## 8. Compliance fit of what is added

| Resource | Kind and scope | Licence | Fit | Notes |
|---|---|---|---|---|
| `gpt-oss-20b`, `gpt-oss-120b` weights | Model artifact, runtime on the host | Apache-2.0 plus OpenAI's usage policy [repo: provenance design] | Pass expected, with a passport per artifact hash | SBOM and ML-BOM entry (MPRV-10); approved transfer into enclaves |
| Nemotron 3 Nano weights (second family) | Model artifact | NVIDIA Open Model License [repo] | Pass expected, with counsel's licence check (provenance N8) | Same as above |
| llama.cpp | Already the data platform's runtime | MIT [repo] | Already assessed in the data platform design | No new runtime component |
| Public evaluation sets (declassified documents) | Test data | Per source; government works are usually free to use, but check each [unverified] | Pass if licences are recorded | Copied with their licence |
| Jailbreak and injection detector models | Not proposed | NVIDIA Open Model License or unconfirmed | n/a | Section 2.3 |
| No service, no container, no new runtime library | n/a | n/a | n/a | The engine is pure TypeScript in the extension; the runner uses the existing `ModelEndpoint` interface |

Controls the design produces evidence for (inference, for the Phase 44 dashboard):
- AC-16 (security attributes): labels bound to content, with a signed provenance;
- AU-2, AU-3, AU-10 (audit content and non-repudiation): the proposal record and the person signatures;
- SI-4 (monitoring): the spill alert and the drift watch;
- SA-11 and SR-4 (testing and supply chain): the evaluation gate and the passport per artifact.

These are suggestions for the compliance register, not yet mapped [unverified].

---

## 9. Owner decisions, with defaults

| Id | Decision | Default recommended |
|---|---|---|
| D1 | The boundary: AI proposes data attributes only; person attributes are never AI-assigned or AI-issued; agents can never be issuers (structural) | **Yes** |
| D2 | The application rule: automatic raise or keep; lowering, compartment removal, releasability widening and declassification by a person with authority only | **Yes** |
| D3 | Who may lower | The originator for their own items up to the level of their `ClassificationAuthorityCredential { scope: own-items }`; above that, your organization's classification authority; releases and declassification by a release authority |
| D4 | When an automatic raise applies | **At once**, with an impact notice to the originator or steward; also queued for review when it jumps more than one level or reaches the top level |
| D5 | Cost ratios and recall targets per level | The examples in 3.2 (thresholds 0.20, 0.10, 0.05, 0.02; recall 0.90 to 0.99), set by your organization's security officer in the bundle |
| D6 | Where classification runs | **At system-high, inside the content's security domain**; never a commercial cloud; `org-tee` only where policy allows it for that level |
| D7 | Which models | gpt-oss-20b as the primary classifier (gpt-oss-120b at HQ if hardware allows), Nemotron 3 Nano as the second family; no PRC model for classification at any tier |
| D8 | Originator affirmation | **Required at finalize, send or release**: one step, showing the bases; editing is never blocked |
| D9 | Edges with no model | Rules only plus the strict default; the originator affirms; HQ re-proposes on reconnect, raising only |
| D10 | Shadow period before automatic raises | **4 weeks of suggestions only**, or until the in-domain golden set meets the recall targets, whichever is later |
| D11 | Security classification guides | Encoded as signed rules plus retrieval in `classification@1`, authored by your organization's security officer; guide text labelled at its own level |
| D12 | A prediction above system-high | A possible-spill incident to the security officer, with the item frozen for sharing |
| D13 | Directive on Automated Decision-Making | Treat document classification as out of scope but complete the Algorithmic Impact Assessment voluntarily, as the scope guide encourages; person attributes stay out of AI, so no administrative decision about a person is automated |
| D14 | Phase placement | Phases 70.1 and 74.3 as in section 7; the amendments of 7.2 now |

---

## 10. Pitfalls

### Critical

1. **Classifying from the bottom.** A model that starts at the lowest level lets injected or misleading text suppress a raise on new content.
   - **Prevention:** start from the inherited join (3.3).
   - **Detection:** a property test that no proposal result is below its start.
2. **A model running below the content's level.** Content of unknown level sent to a model on a lower system, or to a cloud, to find out its level.
   - **Prevention:** route at system-high (4.1) through the existing gate.
   - **Detection:** the route record shows the endpoint class for every classification call.
3. **AI drifting into person attributes.** A "helpful" feature that pre-fills clearance or nationality, or infers releasability from names.
   - **Prevention:** the structural rules of 5.2 and the closed output schema.
4. **No named classifier of record.** Labels that become final with only a machine actor.
   - **Prevention:** affirmation at finalize (D8), and the record's "Classified by" naming a person.
5. **Synthesis escaping compilation.** Summaries of unclassified items that reveal a classified association while inheriting an unclassified mark.
   - **Prevention:** classify every output (3.3) and evaluate compilation rules over the session (3.5).

### Moderate

6. **Over-classification fatigue.** Thresholds set by fear rather than audit lock people out, and they then copy content around the system.
   - **Prevention:** calibrated thresholds, impact notices, the one-step request lower, and the override rate on the drift dashboard.
7. **Rubber-stamp affirmation.**
   - **Prevention:** 3.11.
8. **A fine-tuned classifier copied across domains.**
   - **Prevention:** the model's label is its data's join (4.3), and FAC-08 serving dominance.
9. **Rationales leaking content.**
   - **Prevention:** label the rationale at the item's label; records otherwise hold hashes and ids only.
10. **Stale proposals.** A result for an older revision applied to newer content.
    - **Prevention:** a content-hash check in `decide()`.
11. **Throughput assumed, not measured.**
    - **Prevention:** Phase 85 numbers before 74.3 sets latency targets.

### Minor

12. **Guides that disagree with the model.** Guide rules win, because they are your organization's authority; the model's disagreement becomes a card.
13. **French and mixed-language content.** Include it in every evaluation set (report 02 flags French context words for Phase 93).
14. **Canadian and NATO scale mapping.** Use the one mapping table the data-centric report recommends (its pitfall 10).

### Phase-specific warnings

| Phase | Likely pitfall | Mitigation |
|---|---|---|
| 70.1 | The record shape is frozen before the assistant's needs are known | Plan 01 settles the record with the 74.3 panel's fields drafted beside it |
| 74.3 | Calibration from constrained-output probabilities may be poor on a quantized model | Research flag; fall back to two-family agreement plus sample agreement as the confidence signal |
| 74.3 | Enclave deployment of weights | Approved transfer and the hash check written into the operator guide |
| 93 | A second classifier grows inside the data platform | 93 depends on 70.1 and 74.3 and reuses them |
| 99 | The watching agent applying its own suggestions | Cards only; the gate refuses policy writes from agents (Phase 71 leaves never get policy changes) |

---

## 11. Gaps and what to verify later

- **Treasury Board Appendix J's exact text** on who categorizes, when, and how categories are reviewed. The page refused automated fetches today; read it in a browser before Phase 70.1's docs are written.
- **The National Defence Security Orders and Directives** on classification authority and sub-delegation (DND network only).
- **Fortra's and Janusnet's confidence handling** (no public documentation found).
- **The State Department pilot's thresholds and the conflicting agreement figures** (the slides are images only).
- **Calibration quality** of token probabilities under llama.cpp grammar-constrained output on quantized gpt-oss.
- **Strix Halo and data-centre GPU throughput** for this workload (Phase 85).
- **Licences** of Command A+ weights and of any public evaluation set.
- **Whether any CCCS publication addresses AI-assisted security categorization** (none found).
- **ADatP-4774's originator and alternative label elements** (the normative text was not read).

---

## Sources

Primary (read today):
- Microsoft Purview, Apply a sensitivity label automatically: https://learn.microsoft.com/en-us/purview/apply-sensitivity-label-automatically
- UK Government Security Classifications Policy v2.0 (2024-08-05): https://www.gov.uk/government/publications/government-security-classifications/government-security-classifications-policy-html
- Treasury Board, Guide on the Use of Agentic Artificial Intelligence (2026-09-15): https://www.canada.ca/en/government/system/digital-government/digital-government-innovations/responsible-use-ai/guide-use-agentic-artificial-antelligence.html
- Treasury Board, Guide on the Scope of the Directive on Automated Decision-Making: https://www.canada.ca/en/government/system/digital-government/digital-government-innovations/responsible-use-ai/automated-decision-making/guide-scope-directive-automated-decision-making.html
- 32 CFR 2001.22 (via Cornell LII): https://www.law.cornell.edu/cfr/text/32/2001.22

Secondary and vendor:
- Purview sensitive information types: https://learn.microsoft.com/purview/sit-sensitive-information-type-learn-about ; default label policies: https://learn.microsoft.com/purview/default-sensitivity-labels-policies ; roadmap RM560708: https://mc.merill.net/message/RM560708
- Fortra Data Classification: https://www.fortra.com/platform/data-classification ; Intelligent Protection: https://www.fortra.com/resources/datasheets/dcs-intelligent-protection ; NATO STANAG datasheet: https://www.fortra.com/resources/datasheets/military-classification-for-nato-security-compliance
- Janusnet: https://janusnet.com/what-we-do ; archTIS partnership: https://idm.net.au/node/14360
- Treasury Board Appendix J: https://www.tbs-sct.canada.ca/pol/doc-eng.aspx?id=32614 ; personal information in the aggregate: https://www.canada.ca/en/government/system/digital-government/policies-standards/spin/security-policy-implementation-notice-direction-security-categorization-personal-information-aggregate.html
- PCO Cabinet confidences standard: https://www.canada.ca/en/privy-council/services/publications/standard-security-cabinet-confidences.html
- Originator control (exhibit): https://foreigninterferencecommission.ca/fileadmin/foreign_interference_commission/Documents/Exhibits_and_Presentations/Exhibits/CAN026308.pdf
- DND classification authority sub-delegation (briefing note title): https://search.open.canada.ca/briefingt/record/dnd-mdn%2CHRCIV2025-0008230
- Guide on the use of generative AI: https://www.canada.ca/en/government/system/digital-government/digital-government-innovations/responsible-use-ai/guide-use-generative-ai.html ; Generative AI in your daily work: https://www.canada.ca/en/government/system/digital-government/digital-government-innovations/responsible-use-ai/generative-ai-your-daily-work.html
- Cyber Centre, Deploying AI Systems Securely: https://www.cyber.gc.ca/en/news-events/joint-advisory-deploying-ai-systems-securely
- Glasgow technology-assisted sensitivity review: https://arxiv.org/pdf/1907.02956 ; https://www.dcs.gla.ac.uk/~graham/publications/PIR2014_gollins.pdf ; https://www.dcs.gla.ac.uk/~graham/publications/TOIS-McDonaldetal.pdf ; https://www.dcs.gla.ac.uk/~graham/publications/ecir2018_mcdonald_als.pdf
- EO 13526 compilation: https://www.justice.gov/oip/page/file/1574551/download ; https://sgp.fas.org/library/compilations.pdf ; https://www.archives.gov/isoo/policy-documents/cnsi-eo.html
- Navy CUI challenge: https://www.navy.mil/Press-Office/News-Stories/Article/3251152/winners-announced-for-navys-controlled-unclassified-information-cui-tool-automa/ ; Air Force CUI: https://www.af.mil/News/Article-Display/Article/2577849/daf-continues-implementation-efforts-for-cui/
- State Department declassification pilot: https://fedscoop.com/how-the-state-department-used-ai-and-machine-learning-to-revolutionize-records-management/ ; https://transforming-classification.blogs.archives.gov/wp-content/uploads/sites/10/2024/07/State-AI-Pilot-Results-June-24-2024.pdf ; https://microsites.databricks.com/sites/default/files/dais/2024/D242175B_Stehle%20Declassification%20DAIS%20061324_1717249451337001bsd5.pdf
- NATO labels: https://www.isode.com/wp-content/uploads/2026/03/Isode-Approach-to-Data-Centric-Security-using-NATO-Confidentiality-Labels.pdf ; https://nhqc3s.hq.nato.int/apps/DCRA_Report/id-29d4122b072148f5aaf4882ecc5d963c/elements/id-389800bcd08f4393a156e82e80aa8454.html
- NCIA label prediction: https://unpaywall.org/10.1109%2FICMCIS.2018.8398703 ; https://www.sto.nato.int/publications/STO%20Meeting%20Proceedings/STO-MP-IST-160/MP-IST-160-S4-5.pdf
- NATO revised AI strategy summary: https://www.nato.int/cps/en/natohq/official_texts_227237.htm
- Prompt injection against LLM judges: https://arxiv.org/pdf/2508.13214 ; https://arxiv.org/html/2512.10449v3 ; https://arxiv.org/pdf/2403.17710 ; https://arxiv.org/html/2504.18333v1 ; https://arxiv.org/pdf/2602.14161
- Conformal and selective classification: https://arxiv.org/html/2603.00924v1 ; https://odr.chalmers.se/items/99cd5e04-1aaa-4f56-a083-ed04651bcc72/full
- Drift and audit sets: https://arxiv.org/pdf/2601.02370 ; https://www.enterpret.com/guides/the-6-signals-of-taxonomy-drift-in-an-llm-feedback-classifier
- NVIDIA guard models: https://build.nvidia.com/nvidia/nemoguard-jailbreak-detect/modelcard ; Granite Guardian: https://arxiv.org/abs/2412.07724v2
- Throughput: https://community.frame.work/t/amd-strix-halo-ryzen-ai-max-395-gpu-llm-performance-tests/72521 ; https://zenn.dev/robustonian/articles/gpt_oss_bench ; https://www.phoronix.com/review/amd-rocm-7-strix-halo/3 ; https://docs.oracle.com/en-us/iaas/Content/generative-ai/benchmark-openai-gpt-oss-20b.htm ; https://docs.vllm.ai/projects/recipes/en/latest/OpenAI/GPT-OSS.html

Repository (read at the commits named at the top):
- `.planning/research/data-centric-access/RESEARCH.md` (branch `origin/docs/research-data-centric-access`)
- `.planning/research/data-platform/02-classification-tagging-data-centric-security.md`, `00-DESIGN.md`
- `.planning/research/model-provenance/DESIGN.md`
- `.planning/ROADMAP.md`, Phases 33, 33.1, 70, 71, 74.1, 74.2, 85 to 99; `.planning/REQUIREMENTS.md` (CLAS, VCRD, TAG, DSEC, FAC, OPP)
- `src/domain/gate/labels.ts`, `dominance.ts`, `labelMap.ts`, `lowerings.ts`, `models.ts`, `useTier.ts`, `proposal.ts`

Nothing was downloaded and run; no third-party code was executed.
