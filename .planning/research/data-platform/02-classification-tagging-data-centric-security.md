# Automatic classification, metadata tagging, privacy assessment and data-centric access control

Research report, written 2026-11-18 for the data platform goal (owner, 2026-11-18): the product discovers and ingests all of your organization's data, tags every item with key attributes including a classification and a privacy assessment, and shows each item only to the agents and people with the right clearances. Your organization sets policy once; people are asked only on real exceptions.

Read-only research. Nothing in the code changed. Sources were found by web search and, where it mattered, by reading the primary page. Markers:

- **[V]** read on the primary source (vendor documentation, specification, statute page or paper) in this session.
- **[S]** secondary: a vendor blog, a law firm summary, an aggregator, or a search summary of the primary page.
- **[M]** from memory, not re-checked in this session. Verify before relying on it.
- **[I]** my own inference or recommendation.

This is not legal advice. The legal notes in section 9 tell you what to ask counsel, not what the law requires of your organization.

---

## 0. Summary

Detectors and models should only ever **propose** facts about an item. Your organization's signed policy turns those facts into a label, and the label only rises. Every automatic step can raise a label, and only a person can lower one, with a signed and recorded reason. That is the rule the gate already applies to chats and files, and it is the right rule to scale to millions of items. The evidence says no detector is good enough to trust on its own. Microsoft says the stock Presidio analyzer is "not very accurate" without tuning. A 2026 multilingual benchmark measured Presidio's recall on the highest-risk personal data at 0.07. LLM detectors are stronger but give different answers to the same file and lose recall under distribution shift. So the design has to tolerate errors: fail toward the higher label, run everything locally (unclassified content cannot be sent to a cloud model to be classified), measure accuracy through continuous sampling audits, and send to a person only what the policy cannot settle. A higher label that blocks the people who were using the item, a source label that disagrees, special-category personal data, and anything that would lower a label all go to a person. Access is the intersection of two checks: label dominance from the gate, and the source system's own permissions (SharePoint, Drive, file shares) captured at sync. Every derived thing carries the join of its inputs' labels: chunks, embeddings, summaries, context graph edges, datasets and fine-tuned models. A model trained on Confidential data is a Confidential model. Do not adopt OpenMetadata, DataHub or Atlas as the system of record for labels, because each brings its own authorization engine. Borrow their schemas (OpenMetadata classifications with mutual exclusion and tag mapping, DataHub glossary terms and structured properties, Atlas propagation along lineage, OpenLineage facets), and keep the gate as the only policy decision point. One honest limit: clearances stay self-declared until Phase 71's verifiable credentials arrive. Until then, organization-wide ingest must use the source ACL as the real boundary and the label as a routing and mistake-prevention control, and it must say so. Because originals stay in their sources, access requests and legal holds work through each source's own tools (Purview eDiscovery and Priva, Google Vault), plus a write-once store for sources with no hold feature. Our layer adds what those tools lack: one case across every source and every derivative (models included), a deadline engine, a signed chain of custody and an honest coverage statement (section 9). People can mark data as personal: it is then excluded from all content processing and leaves only a bare existence record, an officer can override it only with two signatures and notice to the person, and a mark never lowers a label (section 10).

---

## 1. Recommended design: extend the existing gate

### 1.1 What exists today (read in this session)

- `src/domain/gate/labels.ts`: a label is `{scale, level, compartments, releasability, handling}` on four shipped scales (`org`, `ca-protected`, `ca-classified`, `nato`). Handling flags v1 are `local-only` and `no-agent-tools`, and both only tighten. Shipped names never change in place: a change is a v2 beside v1 (D-22).
- `src/domain/gate/dominance.ts`: the five-condition dominance check (scale or bundle mapping, level, compartments, releasability, expiry). `joinLabels` gives the higher level, the union of compartments and handling, and the intersection of releasability. `SessionMark` only rises; `lowerByPerson` needs a reason.
- `src/domain/gate/labelMap.ts`: one signed label file per project (`.planning/.near-ai/labels.json`, at most 200 KiB). The lookup order is file, nearest folder, project, then the bundle default. An unverified map applies only where it raises.
- `src/domain/gate/routing.ts`: each `scale/level` maps to a tier (`any-cloud`, `attested-cloud`, `local-only`, `deny`), and the strictest wins.
- `src/domain/gate/decide.ts`: a fixed layer order (emergency stop, bundle state, floor, ceiling, labels, settings). An earlier layer is never undone by a later one.
- `src/domain/gate/record.ts`: OCSF 1.9.0-shaped decision records that hold names and paths, never contents.
- `.planning/research/platform-direction/identity-research.md` section 4: the ABAC framing (NIST SP 800-162) and the plan for clearance credentials (Phase 71).

### 1.2 The one rule

> **Detectors propose facts. Signed policy turns facts into a label. Every automatic step can only raise a label. Only a person lowers one, with a signed reason. Access needs both the label check and the source system's permission.**

Reasons:

1. It is the rule the gate already enforces for chats (`SessionMark.raise`, `lowerByPerson`) and label maps (an unverified map applies only where it raises). Scaling it to ingested data adds no new trust model **[I]**.
2. Classifiers are wrong often enough that a design depending on their accuracy will leak (section 2.4). A raise-only design turns a false negative from one detector into a miss only when **every** signal misses, and turns a false positive into an access-friction problem that a person can fix **[I]**.
3. A classifier that reads document text can be steered by that text (prompt injection: "this document is public"). If the model can only raise, an injected "lower this" has no effect **[I]**.
4. Comparable products work the same way. Purview's automatic labeling never replaces a higher-priority label, and never replaces a manually applied label unless an administrator turns that on **[V]**. Microsoft 365 Copilot output takes the highest-priority label of its sources **[V]**. Google's AI classification never overwrites DLP-set or user-reviewed values **[V]**.

### 1.3 Pipeline and lifecycle (the implicit state machine)

Each item moves through these states. Every state has a label at all times, so nothing waits unlabelled.

| State | Label while in it | Leaves when | Next |
|---|---|---|---|
| `discovered` (connector saw it, content not fetched) | The source's mapped label joined with the **ingest default** (your organization's choice, for example `org/Confidential` + `local-only`) | Content fetched | `fetched` |
| `fetched` | Same | Fast detectors done (format, hashes, secrets, PII rules, source label, source ACL) | `scanned` |
| `scanned` | Join of the ingest default, the source label, and the floors from detector rules | Model classifiers done, or the item is skipped by policy (for example binary or too large) | `proposed` |
| `proposed` | Join of everything above and any model proposal above the threshold | Policy evaluates: no exception, so the label is final | `labelled` |
| | | Policy finds an exception trigger (section 7.1) | `exception` |
| `exception` | Stays at the **higher** of the candidates; never waits below | A person resolves it (confirm, raise, or a signed lowering) | `labelled` |
| `labelled` | Final label | Content, ACL, source label, classifier version or policy changes | `stale` |
| `stale` | Keeps its label (never lowered by a rescan) | Rescan finishes | `proposed` |
| `tombstoned` (deleted or moved out of scope at the source) | Keeps its label for its derived artifacts | Retention or disposition decided by a person | (end) |

How this avoids stuck states **[I]**:
- **No unlabelled waiting.** The ingest default is strict, so an item stuck in `fetched` is merely invisible to people below the default. It is never exposed.
- **An exception never blocks the people the source already allows if the label would not block them.** The queue orders exceptions by impact (section 7.3), and every exception has an age shown to the reviewer. An exception older than the policy's limit is escalated, not dropped.
- **A rescan never lowers.** When a rescan would give a lower label, it files a "could be lower" suggestion for the item's steward in a weekly batch, so stale high labels are found without auto-lowering.

### 1.4 What changes in the gate

| Change | Where | Why |
|---|---|---|
| **Classification rules** in the signed bundle: `facts -> minimum label`, for example "≥1 Canadian SIN with checksum, or ≥10 email addresses with names" gives `org/Confidential` plus compartment `PERSONAL` if your organization uses it. "Health card number" gives `ca-protected/Protected B`. "Secret found" gives `org/Restricted` + `no-agent-tools`. | `bundle.ts` (new section), new pure `classify.ts` | Your organization sets policy once. Detectors stay replaceable. Rules are deterministic and testable. |
| **Source label map** in the bundle: a Purview label id or a Google label choice maps to `scale/level` (+ compartments, handling). Unknown or unmapped labels map to the **strictest** tier your organization names. | `bundle.ts` | Read existing labels and never lower them (section 4). |
| **Item label store** for organization-scale data: rows in a local database. Each sync batch gets a signed Merkle root over `(itemId, labelKey, evidenceHash, revision)`. | New store beside `labelMapStore.ts` | The per-project label map has a 200 KiB cap and is meant for a project tree, not millions of items. A signed root per batch keeps tamper detection without a signature per row. |
| **Label v2 handling flags**: add `no-train` (content may not enter a training or fine-tuning set) and, if wanted, `no-summarize-down` (no lower-label description may be written). Both only tighten. | `labels.ts` as v2 beside v1 (D-22) | Training is a new use that a dominance check alone does not cover. |
| **Source-access layer** in `decide`: after labels, an item read needs the acting person's principal in the item's captured source ACL. An agent acts for a person, so its effective access is (agent clearance) ∩ (person clearance) ∩ (person's source ACL). | `decide.ts` new layer `source.acl` | Keeps SharePoint and Drive permissions as an extra constraint (section 6.5). |
| **Derived-artifact labels**: chunk, embedding, summary, graph node or edge, dataset and model each get `join(labels of inputs)`, using the existing `raiseMark`. | New `derived.ts` | A model trained on Confidential data carries Confidential (section 6.4). |
| **Aggregation rules**: "a set holding personal data about ≥N distinct people, or ≥M items in compartment X, is at least level L". The rules are evaluated on indexes, exports, datasets, and on a chat's running count of distinct labelled items read. | `classify.ts` + `sessionMark.ts` | Many Internal items together can be Confidential (section 11.3). |
| **Cases and holds**: a request or hold case with regime deadline rules from the bundle, a request-scoped grant, a package declassification, and `legalHold` checks in every deletion path (sync, retention, ROT, CleanUp) | New `cases.ts`, `holds.ts`; CleanUp never-touch list | Section 9 |
| **Personal mark**: a person-signed mark that stops processing, leaves an existence record, and has a two-person override; never touches the label | New `personalMark.ts`; bundle `personalMark` policy | Section 10 |
| **New label events**, named before they ship (D-49): `label.auto-raised`, `label.source-mapped`, `label.exception-queued`, `label.exception-resolved`, `label.could-be-lower`, plus `mark.personal-set`, `mark.override`, `hold.applied`, `hold.change-observed`, `hold.released`, `case.release`. | `labels.ts` `LABEL_EVENT_IDS` | Every automatic raise has a decision record. |

### 1.5 Where classification runs

Unclassified content has to be treated at the ingest default, so **classification runs where that default may go**. With the shipped routing, an ingest default of Confidential or above means `attested-cloud` or `local-only`. Sending unlabelled files to an ordinary cloud model to find out whether they are sensitive defeats the purpose **[I]**. Recommended:

1. **Tier 0 (every item, cheap, deterministic):** media type, hashes, size, source metadata, source label, source ACL, retention label, secret rules, PII pattern rules with checksums and context words.
2. **Tier 1 (every text item, small local models):** span PII detection (GLiNER-family or OpenAI Privacy Filter via ONNX), language, near-duplicate signature, embedding.
3. **Tier 2 (only where needed, local LLM):** sensitivity proposal, topics, document type, business function, summary, retention category. Run it on items Tier 0 and 1 cannot settle, on a sample of the rest for audit, and on items an agent or person is about to use.

---

## 2. Automatic classification and tagging

### 2.1 PII and entity detectors

| Tool | What it is | Licence | Fully local | Accuracy evidence | Verdict |
|---|---|---|---|---|---|
| **Presidio** (moved from Microsoft to the independent Data Privacy Stack organization in June 2026) | Framework: pattern recognizers with checksums and context words, plus spaCy NER, plus pluggable model recognizers (a built-in `GLiNERRecognizer`; LangExtract can use a local Ollama model) | MIT [V] | Yes | Microsoft's evaluation page says the stock analyzer is "not very accurate" and that configuration raised F-score by about 30%; it recommends F2, which weights recall [S]. REDACT (2026, 25 languages): Presidio recall on HIGH-sensitivity categories **0.07** [V]. A vendor test on synthetic data: precision 0.982, recall 0.666 [S]. Fails mainly on non-standard formats [V]. | **Use as the frame and for checksum-backed identifiers** (cards, SIN-style numbers, IBAN). Do not trust it alone for names, health or free-text personal data. |
| **GLiNER** (`urchade/GLiNER`, `gliner_multi_pii-v1`) | Small bidirectional span-extraction model; any label set at inference time (zero-shot) | Apache-2.0 [V] | Yes (CPU possible, ONNX path documented by Presidio) | Independent SPY comparison (vendor blog): average F1 about 0.38 for GLiNER PII variants, 0.47 for GLiNER2-PII [S]. | **Use for names, organizations, addresses and custom entity types** (customers, projects) in Tier 1. |
| **NVIDIA GLiNER-PII** | GLiNER large v2.1 fine-tuned on 55+ PII and PHI types | NVIDIA Open Model License [V] | Yes | Strict F1 at threshold 0.3: 0.70 (Argilla PII), 0.64 (AI4Privacy), 0.87 (Nemotron-PII). Synthetic training data; "performance varies by domain, format, and threshold" [V] | Good coverage of health types. Check the licence terms with counsel before shipping it. |
| **OpenAI Privacy Filter** (April 2026) | Bidirectional token classifier, 1.5B total / about 50M active parameters, 128K context, 8 categories | Apache-2.0 [S] | Yes, laptop-class | Self-reported F1 97.43% on PII-Masking-300k after annotation fixes [S]. Tonic's benchmark: precision 0.77 to 0.85, and the gap is almost all recall; 10% default recall on web-crawl PII [S]. | **Second Tier 1 opinion**: take the union of spans with GLiNER. Too few categories to stand alone. |
| **spaCy NER alone** | General NER (person, organization, place) | MIT [M] | Yes | Fails on unseen surface forms and entity boundaries [V] | Only inside Presidio. |
| **Local generative LLM** (for example a Qwen-class model through a local runtime) | Prompted or fine-tuned extraction with JSON output | Varies by model | Yes, needs a GPU for volume | REDACT: LLM detectors more robust than Presidio, with HIGH tier their strongest slice [V]. "Mind the Gap" (2026): Qwen2.5-3B shows entity-type confusion and generation instability under shift; no single architecture is reliable across categories [V]. | **Tier 2 only**, for context-dependent judgements ("is this a medical history?"). Too slow and too unstable for every span. |

Canadian gap **[M]**: Presidio's predefined recognizers cover several countries, but I found no built-in Canadian SIN, provincial health card (OHIP, RAMQ and others) or driver's licence recognizer. Write them as pattern recognizers with checksum validation (SIN uses Luhn) and English and French context words. Quebec content needs French-language NER and context words.

### 2.2 Secret detection

| Tool | Licence | How it works | Local-only fit |
|---|---|---|---|
| **gitleaks** | MIT [V] | Regex and entropy rules in a TOML file; no live verification [S] | **Recommended.** Reuse its rule set as data alongside the repo's existing `src/team/secrets.ts`. |
| **TruffleHog** | AGPL-3.0 [V] | Many detectors with **live verification** against provider APIs [S] | Verification sends the found secret to the provider, which is egress from a local-only context. AGPL also matters if it is bundled. Do not use verification. |
| **detect-secrets** (Yelp) | Apache-2.0 [V] | Baseline file and diff, flags only new secrets [S] | Good for repositories; less useful for one-time organization-wide discovery. |

Policy recommendation **[I]**: a found secret raises the item to your organization's top `org` level with `no-agent-tools`. It also raises a security finding for the cyber harness, and the catalog never stores the secret value, only its type and a salted fingerprint.

### 2.3 Local LLM classifiers for sensitivity, topics, owner, function and retention

What the evidence says:

- **Fine-tuned local beats prompted cloud on a fixed scheme.** TorchSight (arXiv 2605.20368, May 2026) fine-tuned Qwen 3.5 27B on 78,358 samples. It scored 95.0% category accuracy on its own 1,000-document benchmark and 93.8% on an external held-out set. Commercial models scored 75.4% to 79.9% with the same prompt [V]. It is the author's own benchmark, so treat the numbers as indicative.
- **Four-level public/internal/confidential/restricted is hard at the top.** A small open classifier reports 0.83 accuracy, but F1 of 0.974 for Public and only **0.645 for Restricted**, on 77 held-out rows of synthetic data [S]. The top level is the rarest and the most costly to miss.
- **Same file, different answer.** Google warns that "LLMs are inherently probabilistic rather than deterministic," so identical files may get different labels [V].
- **Custom models need labelled examples.** Google's AI classification needs at least 100 labelled files per label option, each with at least 500 characters, and recommends waiting until every option's recall reaches 80% [V].

Recommended use **[I]**:

| Attribute | Method | Output |
|---|---|---|
| Sensitivity level | Local LLM with constrained JSON output over your organization's level definitions and examples; three samples at temperature > 0, majority vote; agreement used as a confidence signal | Proposed `scale/level` + calibrated probability + short rationale (stored with the item's label) |
| Topics | Embedding similarity to your organization's taxonomy terms, confirmed by the LLM | Up to 5 taxonomy ids |
| Document type | Rules on format and structure first (invoice, contract, minutes, code, slide deck), LLM fallback | One type from a closed list |
| Business function and process | LLM over a closed list, with strong priors from the source location (site, team, shared drive) | Function id + process id |
| Owner or steward | Never guessed by the LLM: source owner, creator, last modifier, site owner, then directory manager chain | Candidate steward; a person confirms |
| Retention category | Source retention label first (Graph `getRetentionLabel`), else LLM proposal mapped to your organization's retention schedule | Retention class id; a person confirms classes that lead to destruction |

Later, fine-tune a small local model on your organization's own audited labels (section 7.3). This is the step that moved TorchSight from about 78% to 95%.

### 2.4 Accuracy, false positives and negatives, and calibration

- **The two errors cost different things.** A false negative (too low) leaks content to the wrong model or person. A false positive (too high) locks out people who need the item, and users then route around the system. Presidio's own guidance weights recall (F2) for this reason [S]. For a raise-only system, false positives are the main usability risk, so measure both **[I]**.
- **Report accuracy per level, never one overall number.** Overall accuracy is dominated by the many Public and Internal items. The Restricted-level F1 of 0.645 above is the number that matters [S].
- **Calibrate per level.** Purview's sensitive information types use three confidence levels, with low = 65 and medium = 75 (third-party material gives high = 85) [V]/[S]. Confidence rises with supporting evidence within a proximity window (Microsoft's examples use 300 characters) [V]. Google gates custom models on recall ≥ 80% [V]. Recommended **[I]**: fit a per-level threshold on the audited sample so that recall for each level at or above Confidential is at least 0.95 at the accepted error rate. Conformal risk control gives a distribution-free way to set that threshold and to route the rest to review [S].
- **Ensembles beat any single detector.** No single architecture is reliable across categories [V]. Taking the **union** of spans from pattern rules, GLiNER and Privacy Filter raises recall, and the raise-only policy absorbs the extra false positives **[I]**.
- **Distribution shift is the norm.** Every system degrades on out-of-distribution inputs [V]. Your organization's own documents are out of distribution for every public benchmark, so the sampling audit in section 7.3 is not optional **[I]**.

### 2.5 What runs fully locally

All of it: Presidio, GLiNER and GLiNER-PII, OpenAI Privacy Filter, gitleaks rules, a local LLM, a local embedding model and near-duplicate hashing. The only network calls are to the source systems (Graph, Drive) to read content, labels, ACLs and retention labels. Presidio and GLiNER are Python. Either run them in a local sidecar process, or run the ONNX exports in the extension's Node host and port the pattern recognizers to TypeScript. The stack research decides that **[I]**.

---

## 3. Privacy assessment per item

### 3.1 How products model it

| Product | Model of privacy attributes | Notes |
|---|---|---|
| **Microsoft Purview** | Sensitive information types (pattern + supporting evidence + proximity + confidence levels), trainable classifiers, exact data match; sensitivity labels with priority; separate retention labels [V] | Labels are protection and handling; privacy facts live in classification results, not in the label. |
| **Varonis** | Classification hits combined with permissions, exposure and activity ("who can reach it") [S] | Claims 98% to 99% accuracy with no published method [S]. The useful idea is pairing sensitivity with exposure. |
| **BigID** | Correlation first: links found values to a **data subject identity**, then classifies; organizes by **residency** for cross-border analysis; keeps a hashed graph per person for access requests [S] | The useful idea is per-subject correlation, which supports access and deletion requests. |
| **OneTrust** | Data mapping and records of processing: data elements, categories of data subjects, processing activities, legal basis, retention, recipients, transfers, structured to match GDPR Article 30 [S] | Lawful basis and purpose belong to a **processing activity**, not to a file. |
| **OpenMetadata** | `PII.Sensitive` / `PII.NonSensitive` auto-tags from column-name rules plus Presidio entity recognition on sample rows; confidence default 80; mutually exclusive classifications; **tag mapping** (applying `Personal Data.Personal` also applies `Data Classification.Confidential`); manual PII tags are never overwritten [V] | The closest open model to "facts imply a sensitivity". |
| **DataHub** | Glossary terms (hierarchical, `is_a Classification.PII`), tags, typed structured properties; the built-in classifier was removed, so classification is a custom plug-in [V] | Good vocabulary model; weak built-in detection today. |
| **Google Drive** | Admin-defined labels with badged or options-list fields; DLP rules and AI classification set values [V] | No privacy schema; labels are generic fields. |

### 3.2 Minimal privacy attribute schema to adopt

Rule **[I]**: store **facts about** personal data, never the personal data itself. Store counts, categories and salted fingerprints, which is consistent with the decision records that "hold names and paths, never file contents". Lawful basis and purpose belong to a processing-activity record that items point to, as in OneTrust and GDPR Article 30.

```jsonc
"privacy": {
  "personalData": "present",            // present | absent | unknown            (auto)
  "categories": ["contact", "identifier.government", "financial"],   // closed list (auto)
  "specialCategories": ["health"],      // GDPR Art. 9 style; also Quebec "sensitive" (auto proposes, a person confirms)
  "dataSubjectTypes": ["employee", "customer"],                   // employee | customer | patient | child | applicant | public-figure | other (auto proposes)
  "subjectCountEstimate": "11-100",     // bucketed, never exact names (auto)
  "identifiability": "direct",          // direct | indirect | pseudonymous | anonymous (auto)
  "jurisdictions": ["CA-QC", "CA-ON"],  // from source location, subject signals, language (auto proposes)
  "sourceResidency": "CA",              // where the source system stores it (auto, from connector)
  "processingActivityRef": "ropa:hr-payroll",   // link to a record of processing (a person confirms)
  "lawfulBasisRef": "from processing activity", // never guessed per item
  "retentionClassRef": "rc:hr-7y",      // shared with the lifecycle layer
  "assessmentRefs": ["pia:2026-04-hr-system"],  // PIA or DPIA covering it (a person)
  "evidence": { "detectorVersions": {"presidio": "2.2.363"}, "hits": {"CA_SIN": 3}, "confidence": 0.93 },
  "fingerprints": ["salted-hash..."],   // optional, for access and deletion requests, kept local-only
  "reviewedBy": null                    // set when a person confirms (signed)
}
```

How it feeds the label **[I]**: the signed classification rules read `privacy.*` facts and produce label floors. For example, special category health with direct identifiability gives at least `ca-protected/Protected B` if your organization uses that scale, or `org/Restricted`. Privacy does not get its own access engine.

---

## 4. Interop with existing labels

### 4.1 Microsoft Purview sensitivity labels on M365 files

- **List the tenant's labels:** `GET /security/dataSecurityAndGovernance/sensitivityLabels` (v1.0). With the application permission `SensitivityLabels.Read.All` it returns all tenant labels [V]. The fields are `id`, `name`, `displayName`, `priority`, `sensitivity`, `isAppliable` (false for a parent with sublabels), `hasProtection`, `isDefault`, `applicationMode`, `actionSource` and `sublabels` [V].
- **Read a file's label:** `POST /drives/{drive-id}/items/{item-id}/extractSensitivityLabels` (v1.0, `Files.Read.All`) returns `labels[]` of `{sensitivityLabelId, assignmentMethod, tenantId}`. It first returns stored metadata and re-extracts from the content when that is stale [V]. It returns **423 Locked** with `fileDoubleKeyEncrypted`, `fileDecryptionNotSupported` or `fileDecryptionDeferred` [V]. It is not supported in SharePoint Embedded containers [V].
- **Read the label from the file itself** (file shares, downloads): newer Office files keep label metadata in `docMetadata/LabelInfo.xml` (namespace `http://schemas.microsoft.com/office/2020/mipLabelMetadata`). Older files use custom properties `MSIP_Label_<GUID>_Enabled`, `_SetDate`, `_Method`, `_Name`, `_SiteId`, `_ContentBits`. When both exist, LabelInfo wins, and a removed label is recorded with `removed="1"` [V].
- **Retention labels** are separate: `GET /drives/{drive-id}/items/{item-id}/retentionLabel`, with `isLabelAppliedExplicitly` telling explicit from inherited [V].
- **Priority is ambiguous across Microsoft's own pages.** The Graph resource says "lower numbers indicate higher priority" for `priority`, and "lower is less sensitive" for `sensitivity` [V]. The Purview auto-labeling page says the label in the last position has the highest priority and "the highest order number wins" [V]. **Do not derive our level from Microsoft's numbers.** Map each label id explicitly in the signed bundle **[I]**.
- **Users can lower Purview labels.** A label policy can require a justification to remove or replace a label, and the change is audited [S]. Justification is not required between sublabels of one parent [S]. So a source label may go **down** between syncs.

### 4.2 Google Drive labels

- Labels are defined in the Admin console's Label manager and read through the Drive Labels API. File values are set with `files.modifyLabels` (atomic; `removeLabel` removes) [V]. Values are read with `files.get` / `files.listLabels` [M].
- Only badged labels or single-select options fields can drive DLP rules [S]. AI classification trains one field per label and needs 100+ labelled files per option [V].
- **Google decides precedence by who set the value, not by sensitivity.** DLP-rule values outrank AI values, which outrank defaults [V]. A user can remove a label, and AI can apply it again later [V]. One Admin Help summary says a DLP-set value can overwrite a default even when the default was higher [S].

### 4.3 Mapping onto our scales, never lowering

Recommended rules **[I]**:

1. **An explicit, signed mapping table** in the bundle: `{system: "purview", tenantId, labelId} -> Label` and `{system: "google", labelId, fieldId, choiceId} -> Label`. A security officer approves it once. Parent labels map through their sublabels.
2. **Unmapped, unknown, inactive, or unreadable (423) labels map to the strictest level your organization names**, with an exception queued so someone adds a mapping. Double-key encrypted files cannot be read by the service at all: treat them as top level, `local-only`, and metadata-only.
3. **The item's label = join(our classification, mapped source label).** The source can raise our label. A source lowering (a Purview downgrade with justification, a Google value change) **never lowers ours**. It files a `label.could-be-lower` suggestion that cites the source change, so a person can sign a lowering.
4. **Never write our label back to the source by default.** Write-back (`assignSensitivityLabel`, `modifyLabels`) changes your organization's M365 or Workspace state and can trigger encryption. Offer it later as an explicit, per-label opt-in **[I]**. Assigning labels through Graph is a metered API [M].
5. **This matches what Microsoft does for Copilot output.** It inherits the highest-priority source label and never overrides a higher manual label [V].

---

## 5. Data catalogs to build on or borrow from

| | **OpenMetadata** | **DataHub** | **Amundsen** | **Apache Atlas** |
|---|---|---|---|---|
| Licence | Apache-2.0 [V] | Apache-2.0 [V] | Apache-2.0 [V] | Apache-2.0 [V] |
| Maturity (GitHub, 2026-11-18) | Very active, ~15.8k stars, pushed today [V] | Very active, ~13k stars, pushed today [V] | **Archived** (September 2026) [V] | Active but slow, ~2.2k stars, 2.6.0 release candidates [V] |
| Tag and classification model | Classifications (optionally **mutually exclusive**) holding tags; glossary; tiers; **tag mapping** across classifications [V] | Tags (light), glossary terms (controlled, hierarchical, `is_a`), typed structured properties, domains [V] | Tags and badges [M] | Typed classifications with attributes, propagated along lineage [V] |
| Auto-classification | Built in: column-name rules + Presidio on sample rows, confidence 80 by default [V] | Built-in classifier **removed**; write a custom `Classifier` [V] | None [M] | None built in; external tools tag [M] |
| Lineage | Table and column lineage [M] | Table and column lineage [M] | Basic [M] | Lineage with **classification propagation**; Ranger then enforces on the derived copy [V] |
| Unstructured documents | Weak: built around tables, dashboards, pipelines [M] | Weak, same [M] | Tables only [M] | Hadoop-ecosystem entities [M] |
| Runtime weight | Java server, Python ingestion, SQL database, search cluster [M] | Java services, Kafka, search cluster, SQL database [M] | n/a | Java, graph store, Solr, Kafka [M] |
| Can it sit behind our policy engine? | Only as a metadata mirror. It has its own roles and policies, a second decision point. | Same | n/a | Its enforcement partner (Ranger) is a separate decision point. |

**Recommendation [I]:** do **not** make any of them the system of record for labels or access. Each is a server stack with its own authorization, and none models unstructured office documents well. **Borrow:**
- OpenMetadata's **mutually exclusive classification** (one level per scale), its **tag mapping** (a fact tag implies a sensitivity tag), and its "never overwrite a manual tag" behaviour.
- DataHub's split between **tags**, **glossary terms** and **typed structured properties**. It maps cleanly onto our layers.
- Atlas's **propagation along lineage**, the same idea as our `join` over derived artifacts.
- **OpenLineage** facets (Apache-2.0) for lineage, schema, ownership and data quality events [V].

For organizations that already run OpenMetadata or DataHub, add a later **one-way export** connector: we push metadata and labels as tags; their changes never lower ours.

---

## 6. Enforcement models

### 6.1 ABAC framing

NIST SP 800-162 defines ABAC as decisions from subject attributes, object attributes, requested operations and environment conditions, evaluated against policy [V]. In our terms **[I]**:

| ABAC role | Ours |
|---|---|
| Subject attributes | Person's and agent's clearances (self-declared now, verified credentials in Phase 71); groups from the directory; source-ACL principal ids |
| Object attributes | The item's label + the item card (section 8) |
| Environment | Routing tier proof (attested connection), online or offline, bundle freshness |
| Policy decision point (PDP) | `decide.ts`, pure and offline |
| Policy enforcement points (PEP) | Agent tools, model routing, the catalog and search query layer, dataset assembly, export |
| Policy information point (PIP) | Item store, ACL snapshot, directory snapshot |
| Policy administration point (PAP) | Signed bundle editing (Edit Policy, Apply Policy Draft) |

### 6.2 Policy engines

| Option | Licence | Strength | Weakness for us | Verdict |
|---|---|---|---|---|
| **Our evaluator** (`dominance.ts`, `decide.ts`) | ours | Pure TS, offline, already reviewed, fixed layer order | Needs a compiler to SQL and vector filters | **Keep as the one PDP** |
| **OPA / Rego** | Apache-2.0 [V] | **Partial evaluation compiles a policy into SQL WHERE clauses** for data filtering, within a defined Rego fragment [V] | Go runtime or WASM; a second policy language to sign and review | Borrow the **idea** (compile the decision into a query filter). Do not adopt. |
| **Cedar** | Apache-2.0 [V] | Analyzable, typed, principal / action / resource / context | Partial evaluation for data filtering is experimental [S] | Watch it; possible later for organization-authored rules |
| **XACML 3.0** | OASIS standard [M] | Obligations, PIP and PEP vocabulary | XML-heavy; no realistic TS engine | Borrow terms only |

### 6.3 Row and column security in databases

- **Postgres** (an HQ or organization-hosted store): row-level security policies, **default deny** when RLS is on and no policy applies [V]. Use `security_barrier` views so user-supplied functions cannot see rows before the filter, and know that only `LEAKPROOF` functions run before policy quals [V]. Column privileges come from `GRANT`, not from policies [S]. Pattern **[I]**: a session variable carries the caller's compiled clearance and principal set, and a policy checks `label_rank <= clearance_rank AND compartments <@ held AND acl_principals && caller_principals`.
- **DuckDB has no row-level security in core** [S]. MotherDuck's secure views run on MotherDuck's servers, not in DuckDB [V]. A plain view is not a security boundary when the caller can open the file **[I]**. The same holds for SQLite. **On a device, the PEP must be our query layer.** Agents never get raw SQL on a store that holds rows above their clearance **[I]**.

### 6.4 Following the data into derived stores

| Derived thing | Label rule | Enforcement | Evidence |
|---|---|---|---|
| Chunk | Item label (or a higher portion label if a rule fires on that chunk) | Stored with label key, compartments, releasability, ACL set id | [I] |
| **Embedding** | Same as its chunk | **Pre-filter** in the vector query, never post-filter; separate index partitions per routing tier | Vec2Text recovered 92% of 32-token inputs exactly from embeddings, including full names from clinical notes; "embeddings should be handled with the same precautions as raw data" [V]. Post-filtering leaks through skipped code paths and sparse results [S]. |
| Summary, title and description written by a model | Join of its sources; a lower "discovery description" only through a signed person lowering | Shown only to callers who dominate it | [I] |
| Context graph node and edge | Edge label = join(both endpoints, the item that asserted it) | Graph queries filter edges as well as nodes; an edge "Customer X ↔ Project Y" can itself be Confidential | [I] |
| Search index (FTS) | Per-row label | Same compiled filter as the vector store | [I] |
| Chat or agent run | Existing `SessionMark` rises with what it reads, including search snippets and summaries | Existing gate | in repo |
| **Training or fine-tuning dataset** | Join of every included item; items with `no-train` or without training rights are excluded at assembly | Dataset assembly is a gate-checked tool | [I] |
| **Fine-tuned model or adapter** | **Join of its training dataset's label**, recorded in the model card; routing tier follows that label | A Confidential model runs only where Confidential may go, and only for callers who dominate it; querying it raises the caller's mark | Training-data extraction and membership inference are well established; memorization grows with model size and repetition [V]. Deduplication cut memorized output roughly tenfold [S]. |
| Exports and reports | Join of contents; aggregation rules apply | Gate on the export tool | [I] |

Atlas and Ranger show the same pattern in production: a classification propagated to a derived table makes the tag-based policy apply there "without administrator intervention" [V].

### 6.5 Keeping the source system's ACLs as an extra constraint

- **Capture at sync:** Graph `driveItem` delta returns sharing information for changed items. Microsoft recommends `Prefer: hierarchicalsharing` to see how changes propagate [V]. A user report says the delta token misses permission changes caused by **group membership** changes [S].
- **So [I]:** store ACLs as principal ids (users, groups, sharing-link scopes). Expand groups at query time from a directory snapshot that is refreshed on its own schedule. Run a periodic full permission rescan. **Fail closed** when an item's ACL snapshot is older than your organization's limit (for example 24 hours), except for people who already passed the label check and are named directly on the item.
- **Sharing links:** "Anyone with the link" and "people in your organization" scopes map to special principals. Policy decides whether "anyone" counts as everyone in your organization for agents (default: no) **[I]**.
- **The rule is an intersection, never a union.** The label can block someone SharePoint allows. SharePoint can block someone the label allows. Neither can grant what the other refuses **[I]**.
- **File shares:** read NTFS or POSIX ACLs at scan time with the same principal model [M].

---

## 7. Human in the loop only on exceptions

### 7.1 What goes to a person

Only these, each tied to a policy rule **[I]**:

1. **Lowering anything:** a rescan suggests lower, a source label went down, or someone asks. This always needs a signed person action (existing `lowerByPerson` semantics).
2. **A raise that would remove access** for people who used the item in the last N days, or for the source ACL's audience. The raise applies at once; the steward is asked to confirm or to sign a lowering.
3. **Conflicting signals:** for example the source says Public while the detectors find government identifiers, or two scales disagree. The higher candidate applies while it waits.
4. **Low-confidence top-level proposals:** the calibrated probability of a level at or above Restricted (or Protected B) falls between the "ignore" and "auto-apply" thresholds.
5. **Special-category personal data** found where the policy has no processing activity covering it.
6. **Unmapped source labels** and unreadable (encrypted) items.
7. **Personal or mailbox content** in scope for a person's review, only if your organization's assessment allows it (section 11.7).

### 7.2 What "set once" looks like in comparable products

| Product | Set-once controls | Exception handling |
|---|---|---|
| Purview | Default label per policy; mandatory labeling; service-side auto-labeling policies. **At least one simulation must run** before a policy can apply labels. Simulation takes up to 12 hours and supports 20M matched files. Throughput is 500,000 files per tenant per day; up to 100 policies [V] | Client-side recommendations users can accept or reject; justification on downgrade [V]/[S] |
| Google Workspace | Badged classification label, default values, DLP rules, AI classification trained on 100+ files per option [V] | Users review AI values; reviewed values are never overwritten by AI [V] |
| OpenMetadata | Classification definitions, confidence threshold, tag mapping rules [V] | Manual tags never overwritten [V] |
| Varonis | Out-of-the-box policy packs; bulk fixes where existing labels disagree with classification [S] | Manual reconciliation [S] |

What we copy **[I]**:
- **A one-time policy wizard:** pick scales; map existing Purview or Google labels; pick the ingest default; accept or adjust the shipped classification rules; pick what is out of scope (mail, personal drives).
- **Mandatory simulation:** a new or changed classification rule first runs in shadow mode over a sample and shows "would raise N items, would block M people from K items". Only then can a person sign it into the bundle.

### 7.3 Review queue and sampling audit

- **The queue is ordered by impact:** (people who would lose access) × (uncertainty) × (level). It is grouped by steward, so one person sees one batch per week, not one prompt per file **[I]**.
- **Bulk actions on clusters:** near-duplicate and same-folder items are reviewed as one decision **[I]**.
- **Sampling audit:** each week, draw a stratified random sample from every level (oversample the top levels and recent detector or model versions). A reviewer labels it blind. The results give per-level precision and recall, re-fit the thresholds (section 2.4), and become the training set for the organization's own fine-tuned classifier **[I]**.
- **Targets to start with [I]:** recall ≥ 0.95 for each level at or above Confidential; precision ≥ 0.80 for each level that blocks access, so lock-outs stay rare. A drop below target on a level raises that level's auto-apply threshold and widens the review band until it recovers.
- Every decision is an OCSF-shaped record: rule fired, detector versions, before and after label, actor.

---

## 8. The full item metadata schema (owner addition, 2026-11-18)

Every item gets one **item card**. The card is layered so that each layer can be filled by a different stage, and each attribute is marked:

- **A**: auto-derived locally.
- **A→H**: auto-proposed; a person confirms only on exception (section 7.1) or when the attribute drives destruction or lowering.
- **H**: human only.

The card itself carries the item's label: titles, summaries and entity lists reveal content, so they are never shown to someone who cannot see the item **[I]**.

### 8.1 Descriptive

| Attribute | Mark | Derived locally from | Standard mapping |
|---|---|---|---|
| `id` | A | Hash of (source system, tenant, source item id) | `dcterms:identifier` |
| `title` | A | Source title or file name, else first heading, else LLM | `dcterms:title`, `schema:name` |
| `summary` | A | Local LLM, 2 to 4 sentences, generated at the item's tier | `dcterms:abstract`, `schema:abstract`, OpenMetadata `description` |
| `topics[]` | A | Embedding similarity to your organization's taxonomy, LLM-checked | `dcat:theme` (taxonomy), `dcat:keyword`, DataHub glossary terms |
| `entities.people[]`, `.customers[]`, `.products[]`, `.projects[]` | A | NER (GLiNER with custom labels) then **matching against your organization's directories** (identity directory, CRM customers, product and project lists); stored as graph node ids, not names | `schema:mentions`, `schema:about` |
| `language` | A | Language identification model [M] | `dcterms:language` |
| `documentType` | A | Structure rules, LLM fallback, closed list | `dcterms:type`, `schema:additionalType` |
| `businessFunction`, `businessProcess` | A→H | LLM over a closed list + source location priors | DataHub and OpenMetadata `domain` |
| `owner`, `steward` | A→H | Source owner, creator, site owner, directory manager chain | `dcat:contactPoint`, `dcterms:publisher`, OpenLineage ownership facet, OpenMetadata and DataHub owners |
| `created`, `modified` | A | Source metadata | `dcterms:created`, `dcterms:modified` |

### 8.2 Technical

| Attribute | Mark | Derived locally from | Standard mapping |
|---|---|---|---|
| `mediaType`, `format` | A | Magic bytes, not the file extension | `dcat:mediaType`, `dcterms:format` |
| `byteSize`, `pageCount`, `wordCount` | A | Parser | `dcat:byteSize` |
| `checksum` | A | SHA-256 of content | `spdx:checksum` (added in DCAT 3) |
| `schema.columns[]`: `{name, dataType, semanticType, nullable, tags}` | A | Table and database introspection; **semantic type** (email, amount, currency, date, id, name, free text) from column-name rules + value sampling through Presidio, as OpenMetadata does | OpenMetadata `Table.columns`, DataHub `SchemaMetadata`, OpenLineage `schema` facet, Croissant `Field` |
| `rowCount` | A | Count or estimate | OpenLineage `dataQualityMetrics` |
| `qualityScore` | A | Parse success, OCR confidence, null and invalid ratios, boilerplate ratio | OpenLineage data quality facets |
| `freshness` | A | Modified time vs the expected cadence for its type | none |
| `exactDupOf`, `nearDupCluster` | A | Content hash; MinHash or SimHash over shingles (the method used in "Deduplicating Training Data" [S]) | none |

### 8.3 Provenance and lineage

| Attribute | Mark | Derived locally from | Standard mapping |
|---|---|---|---|
| `source.system`, `source.tenant`, `source.container` (site, drive, share, database) | A | Connector | `dcat:Catalog` / `dcat:DataService` |
| `source.path`, `source.url` | A | Connector | `dcat:accessURL`, `dcterms:source` |
| `version`, `previousVersion` | A | Source ETag or version id | `dcat:version`, `dcat:previousVersion` |
| `derivedFrom[]` with relation (extracted, chunk-of, summary-of, converted, joined) | A | Pipeline | `prov:wasDerivedFrom`, OpenLineage lineage facets |
| `ingest.firstSeen`, `ingest.lastSynced`, `ingest.contentHash` | A | Pipeline | none |
| `ingest.cursorRef` | A | Delta token per connector and drive (kept on the connector, referenced from items) | none |
| `pipeline.extractorVersion`, `pipeline.classifierVersions` | A | Pipeline | none; **needed for drift** (section 11.2) |

### 8.4 Usage

| Attribute | Mark | Derived locally from | Note |
|---|---|---|---|
| `access.count30d`, `access.lastAccessed` | A | Source audit logs where your organization allows; our decision log | Aggregate counts only |
| `usedBy.groups[]` | A | Same, aggregated to team or group | **Named-person usage is employee monitoring** (section 11.7); keep it in the local decision log, not in the card |
| `readByRuns[]` | A | Decision records (OCSF) of agent reads | Run ids, rolling window |

### 8.5 Security

| Attribute | Mark | Derived locally from |
|---|---|---|
| `label` (our `Label`, one per scale used) | A, lowering H | Classification rules + source label map + lineage joins |
| `labelEvidence` (rules fired, detector and model versions, confidences, hit counts) | A | Pipeline |
| `sourceLabels[]`: `{system, labelId, name, method, readAt}` | A | Graph `extractSensitivityLabels`, LabelInfo.xml, Drive labels |
| `sourceAcl`: `{principals[], linkScopes[], inherited, capturedAt}` | A | Graph permissions and delta, Drive permissions, file system ACLs |
| `handling[]` | A, H | Rules (`local-only`, `no-agent-tools`, v2 `no-train`) |
| `privacy` (section 3.2) | A→H | Detectors + rules |
| `secrets`: `{count, types[]}` | A | gitleaks-style rules |
| `exception`: `{state, reason, openedAt, resolvedBy}` | A, H | Queue |
| `personalMark`: `{scope, markedAt, markSig, overrides[]}` | H (the person only) | The person's signed mark (section 10). A marked item keeps **only** an existence record; every other layer is empty. The mark never changes `label`. |

### 8.6 Lifecycle

| Attribute | Mark | Derived locally from |
|---|---|---|
| `retentionClass` | A→H | Source retention label (Graph `getRetentionLabel`), else LLM proposal mapped to your organization's schedule |
| `retainUntil` | A | Computed from the class and the trigger date |
| `legalHold` / `holds[]`: `{caseId, mechanism (purview, vault, worm, own), appliedAt, confirmedAt, wormRef}` | A→H | Set by a signed hold case (section 9.7), confirmed per source. A hold blocks disposition, lowering, deletion propagation and CleanUp purges, and propagates along lineage to derivatives. |
| `rot`: `{redundant, obsolete, trivial, reasons[]}` | A | Redundant = in a duplicate cluster and not canonical. Obsolete = superseded version, or untouched for N years past retention. Trivial = temporary or near-empty files |
| `disposition` | H | **Never automatic**: deleting needs a person (your organization's rule and ours) |

### 8.7 Training suitability

| Attribute | Mark | Derived locally from | Standard mapping |
|---|---|---|---|
| `training.rights`: `{basis, licence, tdmReserved, consentNeeded}` | A→H | Source and contract type (own work product, licensed third-party content, customer data), licence detection, a **TDMRep** reservation in the file or site [V] | Croissant `license`; usage conditions in **ODRL** (Croissant 1.1) [V] |
| `training.allowed` | A (computed) | `rights.basis` known and permitted, no `no-train`, no special categories unless policy allows, privacy facts permit it | none |
| `training.quality` | A | Quality score, language, length, boilerplate, near-duplicate membership | Croissant RAI fields (`rai:dataCollection` and others) [V] |
| `training.taskFit[]` | A | Document type → tasks (QA pairs, classification examples, code, instructions) | none |
| `training.dedupCluster` | A | Same as `nearDupCluster` | none |
| `training.inheritedModelLabel` | A | The label a model trained on it would inherit (its own label, plus any dataset aggregation rule) | none |

Default **[I]**: `rights.basis = unknown` means **not allowed**. Training is opt-in per source or collection, signed by a person.

### 8.8 How items become findable through search and agent tools

```text
                 +-------------------+
 connectors ---> | item card store   | <-- labels, ACL snapshot, lineage
                 | (structured, FTS) |
                 +---------+---------+
                           |
         +-----------------+------------------+
         |                 |                  |
   keyword index     vector index        context graph
   (FTS5-style)    (per-tier partitions)  (entities, edges)
         \                 |                  /
          +-------- query planner ------------+
                           |
          gate compiles caller's clearance + principals
          into a pre-filter (label rank, compartments,
          releasability, ACL principal set, tier)
                           |
                 agent tools / people search
```

- **Three indexes, one filter.** Keyword search finds exact names and codes. Vector search finds meaning. The context graph answers "everything about customer X" or "who works on project Y". Each row carries the item's label key, compartments, releasability, ACL set id and tier. The gate compiles the caller's effective access into one filter that is applied **inside** each query (the OPA partial-evaluation idea), never after it [V]/[I].
- **Facets come from the card:** type, function, owner, topic, freshness, language, quality and training suitability. "Recent contracts for customer X owned by Legal" is a filter, not a hope.
- **Agent tools** **[I]**: `catalog.search(query, facets)`, `catalog.describe(itemId)`, `catalog.lineage(itemId)`, `catalog.similar(itemId)`, and `dataset.assemble(criteria, purpose)`. Each is gate-checked. Results raise the run's `SessionMark` by the labels of what they return, snippets and summaries included. `dataset.assemble` refuses items whose `training.allowed` is false and reports the resulting dataset label before anything is copied.
- **Discoverability above clearance.** By default an item a caller cannot read does not exist for them, because titles and summaries leak. Your organization may instead choose "existence only" (a placeholder with steward and a request-access button) per scale. This is the classic unclassified title of a classified document, and it needs a person-approved discovery description **[I]**.
- **Embeddings are computed locally**, stored in partitions by routing tier, and carry the item's label (Vec2Text, section 6.4).

### 8.9 Example card (abbreviated)

```jsonc
{
  "id": "it_9f1c...",
  "label": [{ "scale": "org", "level": "Confidential", "compartments": ["HR"], "releasability": [], "handling": ["no-train"] }],
  "descriptive": { "title": "2026 salary bands", "summary": "...", "topics": ["tx:compensation"], "documentType": "spreadsheet",
                   "businessFunction": "fn:hr", "steward": "dir:group/hr-ops", "language": "en" },
  "technical": { "mediaType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "byteSize": 48211,
                 "schema": { "columns": [{ "name": "Base", "semanticType": "amount" }, { "name": "Employee ID", "semanticType": "id" }] },
                 "rowCount": 412, "qualityScore": 0.91, "nearDupCluster": "nd_77" },
  "provenance": { "source": { "system": "sharepoint", "container": "site:hr", "url": "..." }, "version": "etag-41",
                  "pipeline": { "classifierVersions": { "presidio": "2.2.363", "sens-llm": "org-ft-3" } } },
  "usage": { "access": { "count30d": 14 }, "usedBy": { "groups": ["hr-ops"] } },
  "security": { "sourceLabels": [{ "system": "purview", "labelId": "5feb...", "method": "standard" }],
                "sourceAcl": { "principals": ["grp:hr-ops"], "linkScopes": [], "capturedAt": "2026-11-18T10:00:00.000Z" },
                "privacy": { "personalData": "present", "categories": ["financial", "identifier.employee"], "dataSubjectTypes": ["employee"],
                             "subjectCountEstimate": "101-1000", "jurisdictions": ["CA-ON"], "processingActivityRef": "ropa:payroll" } },
  "lifecycle": { "retentionClass": "rc:hr-7y", "legalHold": false, "rot": { "redundant": false, "obsolete": false, "trivial": false } },
  "training": { "rights": { "basis": "employee-personal-data" }, "allowed": false, "inheritedModelLabel": "org/Confidential+HR" }
}
```

---

## 9. Access-to-information requests, subject requests and legal hold (owner addition, 2026-11-18)

The owner confirmed the **hybrid**: originals stay in their source systems, and the central layer holds derivatives kept in sync (item cards, chunks, embeddings, entities and graph edges, summaries, datasets, models). That shapes both duties **[I]**:

- **The original at the source is what gets produced and preserved.** Derivatives help find it, but a package is built from the original, fetched and hashed at collection time.
- **Derivatives may be records too.** Under the Access to Information Act a "record" covers documentary material in any form, and the Act covers records that can be produced from machine-readable records [M]. Summaries, entity lists and model outputs held centrally may therefore be responsive. Ask counsel how your organization treats them, and give them a retention class (section 8.6).
- **A hold must reach two places:** the original, through the source's own mechanism or a write-once copy, and every derivative, through our own hold flag along lineage.

### 9.1 The regimes and their clocks

| Regime | Who | Clock | Extension | Missed deadline |
|---|---|---|---|---|
| **Access to Information Act** (federal records) | Federal institutions | 30 days (s. 7) [S] | s. 9: large volume, consultations, third-party notice; extensions over 30 days are notified to the Information Commissioner [M] | Deemed refusal (s. 10(3)) [S] |
| **Privacy Act** (own personal information, federal) | Federal institutions | 30 days (s. 14) [V] | Up to 30 more days (s. 15), with notice to the requester within the first 30 days [V] | Deemed refusal [M] |
| **PIPEDA** access request | Private sector (commercial activity; employees of federally regulated employers) | 30 days (s. 8(3)) [S] | Up to 30 more days (s. 8(4)), with written notice within the first 30 days [S] | Deemed refusal (s. 8(5)) [S] |
| **Quebec private sector act** | Enterprises in Quebec | 30 days [M] | Limited [M] | Deemed refusal [M] |
| **Provincial FOI** (for example Ontario FIPPA and MFIPPA) | Provincial and municipal institutions | 30 days [M] | Statutory extensions with notice [M] | Deemed refusal [M] |
| **Alberta PIPA, BC PIPA** | Private sector | Alberta 45 days, BC 30 days [M] | Statutory [M] | Complaint to the commissioner [M] |
| **GDPR Art. 15** (data subject access) | Controllers | One month (Art. 12(3)) [M] | Two more months where needed, with notice in the first month [M] | Complaint, fines [M] |
| **US FOIA** | US federal agencies | 20 working days [M] | 10 working days for unusual circumstances [M] | Constructive exhaustion; suit [M] |

Design **[I]**: the deadline rules are **data in the signed bundle**, one entry per regime. Each entry holds the calendar or business-day basis, the holiday calendar, the clock start, the stop-the-clock events (fee or clarification, where the regime allows them), the extension grounds and the notice templates. A request case stores its regime, its received time and every clock event. The case shows "due in N days" and warns at 50%, 80% and 95% of the time used. An extension cannot be recorded without its notice being sent first (for PIPEDA and the Privacy Act, within the first 30 days).

### 9.2 Finding everything about a subject or topic

1. **Resolve the subject into identifiers [I]:** name variants, email addresses, employee and customer ids, phone numbers, account ids. Draw them from the identity directory and CRM, and use BigID-style correlation to link identifiers to one person [S]. Optional salted fingerprints in `privacy.fingerprints` (section 3.2) let the platform find items holding an identifier without storing it in clear.
2. **Search our layer:** the catalog, keyword, vector and graph indexes (section 8.8), under the case's request-scoped grant (section 9.6).
3. **Search the sources live, too**, because our index lags by its sync cursor. Use Purview eDiscovery or Priva Subject Rights Requests for M365, Vault search for Workspace, and connector searches elsewhere. Record both result sets and the cursor age at search time **[I]**.
4. **Follow lineage outward.** Every responsive original pulls in its derivatives (`derivedFrom`): chunks, summaries, graph edges, dataset memberships, and the **models trained on those datasets** (from the model card). Model weights are not produced. The response lists the processing ("your data was used to train model M on date D") because GDPR Art. 15 asks for information about processing as well as copies [M].
5. **Topic requests** (ATIP-style "all records about X") use the same path with topic and entity filters in place of identifiers.

### 9.3 Building the package: redaction and exemption review

Steps, after the EDRM stages from collection to production [S]:

1. **Collect** each original from its source with its version id and a SHA-256 hash.
2. **De-duplicate** using `exactDupOf` and `nearDupCluster`, and thread email.
3. **Review** for relevance, then exemptions. Under the Access to Information Act these include personal information (s. 19), third-party information (s. 20), advice (s. 21) and solicitor-client privilege (s. 23) [M]. Other people's personal information is removed from an individual's PIPEDA package [M].
4. **Redact.** Presidio's anonymizer and image redactor can **propose** redactions locally [M]. A person confirms each one with an exemption code. Redactions are **burned in** to a rendered copy, never drawn as an overlay, and a redaction log lists page, exemption and reason.
5. **Release.** A package carries the join of its contents' labels until release. Releasing it to a requester is a declassification, so it uses the existing signed person-lowering path with a recorded reason, now applied to a package **[I]**.

**Integrate, do not rebuild [I]:** Microsoft Priva Subject Rights Requests already does estimate, review, in-place redaction and export for M365 data. It pauses large searches (300K items or 300 GB) for refinement [S]. Purview eDiscovery and Google Vault do search and export inside their suites. ArkCase is an open-source case management system aimed at FOIA, with redaction and audit trails [S]. Relativity is the usual choice for large legal review [M]. What we add is the layer none of them has: one case across every source, our own derivatives, models trained on the data, the deadline engine, the custody log and the coverage statement.

### 9.4 Chain of custody and audit trail

- Every step is an OCSF-shaped record: who searched what, with which query and index versions, at what cursor age, what was collected (hash, source version), each review decision, each redaction with its exemption, and each release **[I]**.
- A package **manifest** lists every item hash and redaction log entry. Its Merkle root is signed by the officer's key. Optionally the root is anchored the way the platform already plans to anchor 32-byte roots **[I]**.
- The log is append-only and kept for the case's retention period. It is itself subject to any hold.

### 9.5 An honest coverage statement

Generated for every request and every hold **[I]**:

| Part | Content |
|---|---|
| Searched | Each connected source, its sync cursor age at search time, and the live searches run |
| Known but not connected | Systems in your organization's inventory with no connector (from the setup wizard and discovery) |
| Unreadable | Counts by reason: double-key encrypted, 423 from Graph, password-protected, corrupt, unsupported format |
| Excluded by personal mark | **Counts only**, and whether an override was sought (section 10.4) |
| Outside the platform | Entered by the officer: paper, personal devices, third-party processors, backups |
| Statement | Plain words: "We searched A, B and C as of these times. We did not search D and E, for these reasons." |

### 9.6 Who may run a request or a hold

- **A role credential, not a self-declared clearance.** Running a request or a hold needs a verified role (for example `AccessOfficer`, `PrivacyOfficer`, `LegalHoldAdmin`) as a Phase 71 credential. **Until then, requests and holds run in the source systems' own tools**, where admin roles are enforced. Our layer shows metadata and coverage only **[I]**.
- **A request-scoped, time-boxed grant.** The case grants read access to responsive items only, for that case, and it expires at close. Every read is a record **[I]**.
- **A two-person rule above the officer's clearance.** Items above the officer's own clearance, or in compartments they do not hold, are reviewed by a second person cleared for them. Under the Access to Information Act, consulting the originating institution is the usual path [M].
- **Agents propose, people decide.** Agents can search, cluster and propose redactions under the case grant, with local-only routing for anything above Internal. They never decide an exemption or a release **[I]**.
- **Recusal.** An officer cannot run a request about themselves or their own reporting line **[I]**.

### 9.7 Legal hold

**Lifecycle (the hold state machine) [I]:**

| State | Meaning | Leaves when |
|---|---|---|
| `draft` | Scope being defined: custodians, sources, date range, topics | An authorized person signs it |
| `issuing` | Applied per source; each source shows `pending` until it confirms (Purview says a hold can take up to 24 hours to take effect [S]) | Every source confirms, or one fails |
| `active` | Preserved; change monitoring on; custodian notices out | A release is proposed |
| `partial` | A source failed or has no hold feature and its write-once copy is still running | Fixed, so `active`; this state shows a visible warning and never times out silently |
| `release-proposed` | Release requested with a reason | Signed by an authorized person |
| `released` | Per-source holds removed; our suspensions lifted; normal retention resumes after a grace period | (end) |

**Applying holds through each source's own mechanism:**

| Source | Mechanism | Notes |
|---|---|---|
| Microsoft 365 (Exchange, SharePoint, OneDrive, Teams) | Purview eDiscovery case + hold policy through Graph: `POST /security/cases/ediscoveryCases/{id}/legalHolds`, then `userSources` and `siteSources` [S] | Parts of the hold API have been beta-only, which is not supported in production [S]. SharePoint and OneDrive keep held content in the **Preservation Hold library**: deleted content is copied there, and **edits are not all copied unless site versioning is on** [S]. |
| Item-level M365 retention | Retention labels read through Graph `getRetentionLabel` [V]; a "retain" label can be set on items [M] | Useful for narrow, item-scoped holds; not a substitute for a case hold |
| Google Workspace | Vault matter + `matters.holds.create`, one corpus per hold (`MAIL`, `DRIVE`, and others), scoped to accounts **or** an org unit, with `includeSharedDriveFiles` for Drive [S] | The caller needs Vault privileges on the matter [S] |
| File shares, local disks, databases, any source with no hold feature | Copy originals to a **write-once hold store** with hash, path, ACL and timestamps. S3 Object Lock or MinIO object locking with a **legal hold** (independent of retention periods; compliance mode cannot be removed even by an administrator). Both were assessed by Cohasset against SEC 17a-4(f) [S]. Databases: a consistent snapshot export. | Use the removable **legal hold** flag, not a compliance-mode retention period, so release is possible. Copying an object does not carry its lock (MinIO) [S]. |
| **Our own layer** | `legalHold` on the item card, propagated along lineage to every derivative | See below |

**Suspending our own deletions while a hold is on [I]:**

- **Deletion propagation:** when a held original is deleted at the source, keep its derivatives, mark them `source-deleted-during-hold`, and record the event.
- **Retention purges and ROT disposition:** skipped for held items, with the hold id shown.
- **The cleanup team member's purges:** held items go on the CleanUp tool's never-touch list. This must be a check inside the tool, not an instruction to the agent.
- **Re-embedding and re-summarizing:** may add new versions but never overwrite held versions.
- **Dataset and model deletion:** held datasets and model cards (and weights, if in scope) are kept.
- **The personal mark** does not suspend a source hold (section 10.4).

**Detecting and recording change attempts at the source [I]:**

- Graph delta reports changed and deleted items [V]. The Microsoft 365 unified audit log and Google's audit logs (Reports API, which Google also uses for Gemini file access) give actor and time [S].
- For file shares, a scheduled hash scan, or a file system watcher where available.
- Each change on a held item becomes a `hold.change-observed` record with before and after hashes, actor and time, and the hold admin is alerted. Because the original is preserved by the source mechanism or our write-once copy, nothing is lost. The record still shows who tried what, which matters for spoliation questions.

**Custodian notices, acknowledgment and release:**

- Purview eDiscovery (Premium) documents hold notices, reminders at intervals, escalation to the custodian's manager, and a custodian portal for acknowledgment [S]. A competitor claims parts of this were retired in 2025 [S], so check the tenant. Google Vault has no custodian notice workflow [M].
- **Ours [I]:** send the notice through the product's channels (Teams, mail, the extension) in plain words: what to keep, what not to do, and who to ask. Track acknowledgment signed with the custodian's device key. Send reminders and escalate on a schedule in the hold. Re-affirm periodically. Send a release notice. Use Purview's workflow instead where your organization already runs it.

**Defensibility [S]/[I]:**

- **EDRM** describes the stages from information governance through identification, preservation, collection, processing, review, analysis, production and presentation. It is conceptual, not a waterfall [S].
- **Sedona Canada Principles** stress proportionality and cooperation, and Ontario's Rule 29.1.03(4) refers to them [S].
- **US FRCP 37(e)** asks for "reasonable steps" proportional to the case, not perfection [S].
- Following an established process consistently helps, and departing from it without reason hurts [S].
- So defensibility comes from a written hold procedure that the product enforces, records proving each step, an honest coverage statement, and proportional scope. Preserving everything forever costs money and privacy, and it is not what the standards ask for **[I]**.

### 9.8 Gaps in our current design

1. **No case or matter object, and no deadline engine.** Nothing in the gate models a request or a hold with a clock.
2. **Lowering exists only for chats and files.** Releasing a redacted package needs a package-level signed declassification.
3. **The item store, identity resolution and fingerprints are planned, not built.**
4. **Our own deletion paths do not know about holds:** sync deletion propagation, retention, ROT, and the planned cleanup member's purges.
5. **Roles are self-declared until Phase 71.** No enforced officer or hold-admin role exists yet.
6. **No write-once store.** Signed roots exist only for the label map today.
7. **No source audit-log ingestion**, so change attempts at the source are not detected.
8. **No inventory of systems we do not connect to**, which an honest coverage statement needs.
9. **No burned-in redaction rendering, no redaction log, and no exemption code lists per regime.**
10. **No answer yet on erasure for models.** A deletion request (GDPR Art. 17) can remove derivatives, but cannot remove a person from trained weights. Retraining without the data, or documenting why not, is a policy decision.
11. **The legal status of derivatives as records** (section 9, introduction) is undecided.

### 9.9 Integrate rather than rebuild

| Need | Integrate with | We add |
|---|---|---|
| M365 holds and searches | Purview eDiscovery (Graph eDiscovery API) | Cross-source case, coverage, our derivatives |
| M365 subject requests | Microsoft Priva Subject Rights Requests | Non-M365 sources, model and dataset disclosure |
| Workspace holds and searches | Google Vault API | Same |
| FOIA and ATIP case tracking | ArkCase (open source) [S], or the tool your organization already uses | Deadline rules per regime, signed custody |
| Large review | Relativity [M] | Export with labels and hashes |
| Write-once storage | S3 Object Lock or MinIO object locking [S] | Hold manifests, hashes, lineage |
| Redaction proposals | Presidio anonymizer and image redactor [M] | Person-confirmed exemption codes |

---

## 10. The personal and private mark (owner addition, 2026-11-18)

### 10.1 Recommendation

People can mark data as **personal**, which excludes it from all content processing. **Your organization's policy decides where the mark is allowed and how much it may cover.** The platform keeps only a **bare existence record** for a marked item, so holds, coverage statements, quotas and abuse checks still work without reading the content. An authorized officer can override the mark only under a recorded, two-person, signed process, and the person is told. **A personal mark is never a label and never lowers one** **[I]**.

Why an existence record rather than nothing at all **[I]**:
- Without it, a coverage statement cannot even say "N personal items were not searched".
- The cleanup member could not know to leave the items alone.
- Abuse (business data hidden under the mark) could not be noticed without reading content.
- A legal hold could not account for what it did not process.

The record holds no content, no title and no plain path, so it reveals far less than any index.

### 10.2 How marking works

| Scope | How it is set | Policy controls |
|---|---|---|
| **File or folder** | "Mark as personal" in the product; signed by the person's device key; recorded as `mark.personal-set` | Allowed only inside the person's own areas (their OneDrive, home directory, own mailbox folders); never in shared sites, team drives, systems of record or databases |
| **A personal area or location** | Set in the setup wizard or by the person: a "Personal" folder in OneDrive, a named mail folder, a local folder | The organization can pre-create the area and name it; it can require personal data to live **only** there (location-only mode) |
| **Source level** | A personal account or connector the organization lets people attach (for example a personal calendar) is never ingested | On or off per source type |
| **Native signals honoured** | Outlook's "Private" flag on messages and appointments [M]; a Purview or Google label your organization maps to `personal` in the source label map | The mapping is in the signed bundle |

Policy fields in the bundle **[I]**: `personalMark: { allowed, scopes[], locationOnly, maxBytesPerPerson, maxItemsPerPerson, forbiddenContainers[], overrideRoles[], noticeDefault, noticeMaxDelayDays }`.

Rules **[I]**:
- **Only the person can set the mark.** Agents cannot. Applying it is a person action like lowering a label, signed and recorded locally. Governance sees counts, not the record.
- **Unmarking re-enters the item at the ingest default**, and its label becomes the join of any earlier label and the new classification.
- **A mark that breaks policy is refused at once**, with the reason (for example "shared drives cannot hold personal items in your organization").

### 10.3 What "completely excluded" means

**Excluded:**
- Content fetch where the mark is known from location or metadata before fetching.
- Text extraction, classification and the privacy assessment.
- Embeddings, entities and context graph nodes or edges.
- Summaries, search hits for anyone (the owner keeps their normal access in the source system, unchanged).
- Agent access, aggregation counts in analytics, and training.

**Kept, the existence record:**

```jsonc
"personalItem": {
  "pathHmac": "hmac-sha256(org-key, normalized path)",   // not reversible without your organization's key
  "source": "onedrive", "owner": "dir:user/…", "scope": "folder",
  "byteSize": 1048576, "itemCount": 37, "modified": "2026-11-02",
  "sourceHash": "quickXorHash from source metadata, if offered",  // compare without downloading [M]
  "labelKey": "org/Confidential",          // any label it already had: kept, never lowered
  "markedAt": "2026-11-18T10:00:00.000Z", "markSig": "…",
  "holds": [], "overrides": []
}
```

**Derivatives that existed before marking** are removed from the central layer, **except** when a hold covers the item. Then they are sealed, kept and not used, and the person is told why **[I]**.

**Interaction with labels [I]:** the mark changes **processing**, never **protection**. A marked item keeps its label, its routing tier and its source ACL. The mark cannot move content to a lower tier, cannot make it visible to anyone new, and cannot be used to shed a label: unmarking never restores a lower label. Under an override, the item is processed at the higher of its label and the case's minimum label.

### 10.4 Conflicts with legal duties, and the override

- **Legal hold:** source-level holds (Purview, Vault) cover a custodian's whole mailbox or drive and do not know our mark, so personal items stay preserved at the source. Our layer still creates no derivatives. The coverage statement reports them as counts **[I]**.
- **eDiscovery and access requests:** personal data on corporate systems can be responsive. For federal records, whether an employee's personal record is "under the control" of an institution follows the Supreme Court's two-part control test (Canada (Information Commissioner) v. Canada (Minister of National Defence), 2011 SCC 25) [M]. A person's own access request is never blocked by their own mark.

**The override process [I]:**
1. An authorized officer files an override with the case id, the legal basis, a scope (specific items, paths or search terms, never "everything"), and a duration.
2. A second authorized person approves it.
3. Both sign with verified role credentials. Before Phase 71, the override runs in the source's own eDiscovery tool instead.
4. It is recorded as `mark.override`.
5. Processing is case-scoped: nothing enters the general index. Case derivatives are destroyed at case close, unless a hold applies.
6. **The person is told at the time of override by default.** A delay is allowed only when counsel records a reason (for example notice would compromise an investigation) and a latest notice date. The override stays in `notice-pending` until notice is sent, and that state is visible to the privacy officer, so it cannot be forgotten.

### 10.5 Abuse: business data hidden under a personal mark

Detection that does not read content **[I]**:

| Signal | Source |
|---|---|
| Volume and growth vs the policy quota and vs peers in the same role | Existence records |
| **Timing**: marks applied just after a hold notice, a request, or a resignation | Existence records + case and HR events |
| **Sharing**: a "personal" item shared with many colleagues or externally | Source ACL (metadata) |
| **Origin**: moved or copied from a shared site or system of record | Source audit log metadata |
| **Hash match**: the marked item's source hash equals a hash of a known business item, compared without downloading where the source exposes file hashes | Source metadata [M] |
| Types and sizes typical of system exports (large spreadsheets, database dumps) | Extension and size only |

The response escalates in steps:
1. First a private notice to the person: "this looks like work data; unmark or move it".
2. Then counts to the privacy officer.
3. **Sampling content only under a recorded override** (section 10.4), on the smallest sample that answers the question, with notice per policy.

### 10.6 Employee-privacy law points that favour the mark

- **R v. Cole, 2012 SCC 53:** an employee had a reasonable, though diminished, expectation of privacy in personal information on a work computer, especially where personal use was permitted. Information close to the "biographical core" weighs most [S].
- **Bărbulescu v. Romania** (ECtHR Grand Chamber, 2017): monitoring needs clear prior notice, and its scope and intrusion are weighed [S].
- **OPC workplace guidance (2023):** monitoring should be specific, targeted and the least intrusive means [S].
- **Ontario ESA:** the monitoring policy should describe the mark and the override [V].
- **Alberta and BC PIPA:** notice applies [S]. **Quebec Law 25:** confidentiality by default (s. 9.1) and the PIA (s. 3.3) [S]/[V].
- **GDPR:** data protection by design and by default (Art. 25), minimization (Art. 5(1)(c)), employment rules (Art. 88) [M]. The Article 29 Working Party's Opinion 2/2017 on data processing at work discusses giving employees private spaces [M].

**[I]** A bounded personal mark is concrete evidence of proportionality and privacy by default. It makes organization-wide ingest easier to defend. It does not replace your organization's notice and assessment duties (section 11.7).

### 10.7 Comparable products

| Product | Personal or private exclusion | Limits |
|---|---|---|
| **Microsoft 365** | Restricted Content Discovery hides a SharePoint site from organization-wide search and Copilot without changing permissions; off by default; Restricted SharePoint Search is being retired [S]. Outlook "Private" flag [M]. | SharePoint sites only, not OneDrive [S]; set by admins, not by the person; eDiscovery still reaches everything [M] |
| **Google Workspace** | Admins choose which data sources Workspace Intelligence (Gemini) may use. Files under IRM (no download, print or copy) are not retrieved by Gemini [S] | No per-person or per-folder personal exclusion; Vault reaches everything [S]/[M] |
| **Glean** | Per-connector exclusions by owner, folder, shared drive or sensitivity label; "hiding" affects only Glean results [S] | No global personal setting; a user request notes Outlook's Private flag is not respected [S] |
| **Ours (proposed)** | Person-set mark, bounded by signed policy; existence record; two-person signed override with notice | New; needs verified roles for overrides (Phase 71) |

---

## 11. Risks and pitfalls

### 11.1 Mislabeling at scale
- **Under-labelling** leaks, and nobody sees it happen. Mitigations: an ensemble union of detectors, raise-only rules, a strict ingest default, and recall-first thresholds on the top levels with weekly audits **[I]**.
- **Over-labelling** locks people out and teaches them to copy content around the system. Mitigations: impact-ordered review, "could be lower" batches for stewards, and lock-out metrics on the dashboard **[I]**.
- **Prompt injection into the classifier.** Document text can try to talk the LLM into a low label. Mitigations: the LLM can only raise; deterministic floors come first; output is constrained JSON; the policy is never in the prompt **[I]**.

### 11.2 Label drift
Causes: content edits, a new detector or model version, a policy change, a source label change, ACL changes. Mitigations **[I]**: store `classifierVersions` per item and rescan items whose deciding detector changed; trigger a rescan on content hash change; never auto-lower on rescan; show drift on the dashboard (raises and could-be-lowers per week, by source).

### 11.3 Aggregation
Canada's Standard on Security Categorization says the category of a repository "reflects the impact of aggregation", because compromising a group can cause more injury than any single item [V]. The TBS notice on personal information in the aggregate applies this to personal data [V]. Many Internal items about one customer or one person can together be Confidential **[I]**. Mitigations: aggregation rules in the bundle; evaluate them on indexes, exports, datasets and a chat's running distinct-item count; and treat the context graph as an aggregate by default.

### 11.4 Inference through models, embeddings and summaries
- Training data can be extracted from language models, and membership inference identifies training members [V]. **A model inherits the join of its training labels.** That label never comes down because of DP-SGD, filtering or "we only used summaries", except by a signed person decision **[I]**.
- Embeddings can be inverted (Vec2Text) [V]. Summaries and titles carry content. Graph edges reveal relationships even when the nodes are visible.
- Deduplication reduces memorization [S]. It is a quality measure, not a reason to lower a label **[I]**.

### 11.5 Source-label semantics
- The meaning of Purview's priority numbers differs between Microsoft pages (section 4.1). Use the explicit mapping only.
- Google decides precedence by who set the value, not by sensitivity, and AI can re-apply a label a user removed [V].
- Encrypted and double-key files cannot be read by the service (423) [V]. Treat them as top level and metadata-only.

### 11.6 ACL sync lag
Delta may miss group-membership changes [S]. Mitigations: group expansion at query time, a full rescan schedule, and fail closed when the snapshot is stale (section 6.5).

### 11.7 Legal notes (ask counsel; not legal advice)

| Regime | What matters for discovery, classification and scanning | Product implication [I] |
|---|---|---|
| **PIPEDA** (federal, commercial activity; covers employee data only for federally regulated employers) | Safeguards proportionate to sensitivity [M]; purposes a reasonable person would consider appropriate [M]. The OPC's 2023 workplace guidance: monitoring should be specific, targeted and appropriate; assess privacy risks first; set retention for monitoring data; employees keep access rights; privacy rights cannot be waived as a condition of work [S] | The privacy assessment and decision log support access requests; monitoring data (usage by named people) has its own retention |
| **Bill C-36, Protecting Privacy and Consumer Data Act** | Tabled 2026-06-15 to replace PIPEDA's privacy part; LEGISinfo shows it at second reading with no committee stage yet [V]; a new commission and fines up to C$25M or 5% of revenue are reported [S] | Design to the stricter reading now; re-check before release |
| **Quebec Law 25** (private sector act, P-39.1) | **PIA before any project to acquire, develop or overhaul an information system involving personal information** (s. 3.3), proportionate to sensitivity, amount, distribution and format [V]. Highest confidentiality by default (s. 9.1) [S]. PIA before transfer outside Quebec [S]. Technology that identifies, locates or profiles must be off by default (s. 8.1) [S] | Deploying organization-wide ingest at a Quebec organization **is itself** a PIA trigger: ship a PIA template and the facts it needs (categories, volumes, locations, flows) from the catalog. Defaults: strictest. |
| **Alberta PIPA, BC PIPA** | Employee personal information may be collected, used and disclosed without consent when reasonable for managing employment, with notice; Alberta requires reasonable notice to current employees first [S] | Scanning employee content needs a notice your organization gives before it starts |
| **Ontario** | No general private-sector privacy law for provincially regulated employers' employee data [S]. The ESA requires a **written electronic monitoring policy** for employers with 25+ Ontario employees on January 1, in place by March 1, with a copy to employees [V]. Intrusion upon seclusion tort exists (Jones v. Tsige, 2012) [M] | Scanning mail and drives is electronic monitoring. Your organization's policy must describe it. Usage-by-person data is monitoring data. |
| **GDPR** | DPIA under Art. 35. WP248's nine criteria, with two or more usually meaning a DPIA; the EDPB treats employee monitoring as systematic monitoring of vulnerable subjects, which meets two [S]. Art. 30 records of processing; Art. 9 special categories [M]. Member-state employment rules, for example German works-council co-determination over technical monitoring [M] | Ship a DPIA pack; lawful basis comes from processing activities, not items; works-council approval may gate rollout |
| **EU AI Act and copyright** | Providers must identify and respect TDM opt-outs when training [S]; TDMRep is a machine-readable opt-out [V] | `training.rights.tdmReserved` is read from files and sites and blocks training |
| **Canadian government security** | Aggregation raises categorization [V]; Protected B handling | Aggregation rules (9.3); Protected B stays local-only by default (already in routing) |

**Scanning mail and personal folders: recommended defaults [I].**
1. Off by default. Turning it on requires your organization to confirm, in the policy wizard, that a PIA or DPIA and an employee notice or monitoring policy exist. The confirmation is recorded.
2. Folders and mailboxes your organization marks personal, plus common personal-folder names, are excluded unless policy says otherwise.
3. Prefer **label-only mode** for mail: classify and keep the card (counts and categories); do not keep content, chunks or embeddings.
4. No person reviews personal content as part of the exception queue unless the policy names that role. Exceptions about personal items go to the item's owner first.
5. Classification output is never used to evaluate an employee's performance. Say so in the product's notice text.
6. People can see the cards about their own items (access rights).

### 11.8 Self-declared clearances (the honest limit)
Until Phase 71 verifiable credentials arrive, a clearance is "your own word" (SECURITY.md). Data-centric security over organization-wide data **cannot** rest on that. **[I]** Until then:
- The **source ACL is the enforced boundary** for people.
- Labels decide routing (which model may see content) and agent tool access on the device.
- The product says this in the same plain words SECURITY.md uses.
- Organization-wide ingest for multiple people should ship after, or together with, verified clearances.

### 11.9 Cost and throughput
Purview itself caps service-side auto-labeling at 500,000 files per tenant per day [V]. A local LLM over every item will be slower. The tiered pipeline (section 1.5) keeps the LLM on uncertain items, samples and items about to be used **[I]**.

---

## 12. Open questions

1. **Where does ingestion run?** On each device, on a node your organization runs (HQ, edge), or both? This decides where the item store and its signed roots live, and how the "edge offline + HQ federation" direction applies.
2. **Compartments for privacy?** Should personal-data categories become compartments (need-to-know, for example `HR`, `HEALTH`), or stay facts that only raise levels? Compartments give real need-to-know but need verified clearances to mean anything.
3. **Label v2 contents:** confirm `no-train`; decide on `no-summarize-down` and a per-scale "existence only" discovery mode.
4. **Write-back to Purview and Google:** never, opt-in per label, or for raises only?
5. **Which fine-tuned local classifier, and on whose hardware?** The audit loop produces training data; the stack research picks the model and runtime.
6. **Aggregation thresholds:** who sets N and M per scale; is there a shipped default?
7. **ACL staleness limit and group expansion source** (Entra ID, Google directory, LDAP) per connector.
8. **Retention and disposition:** read-only reporting of ROT, or a guided disposition flow (always person-confirmed)?
9. **Legal review:** confirm the Quebec PIA trigger reading, the Ontario monitoring-policy wording to ship, and GDPR works-council needs before any customer rollout. Re-check Bill C-36's stage.
10. **Derivatives as records:** are summaries, entity lists and model outputs records for access-to-information purposes, and what retention class do they get?
11. **Erasure and models:** after a deletion request, retrain without the data, or document why not?
12. **Personal mark policy defaults:** quota size, location-only mode, and the default notice delay limit for overrides.
13. **Notice channel for holds:** use Purview's custodian workflow where present, or always our own?
14. **Licences to clear:** the NVIDIA Open Model License for GLiNER-PII; AGPL for TruffleHog (excluded above); the Croissant specification's licence (the sources disagree).

---

## 13. Confidence

| Area | Confidence | Why |
|---|---|---|
| Graph and Purview label APIs, file metadata | High | Read on Microsoft Learn and the Office protocol specifications |
| Google Drive labels and AI classification behaviour | High for documented rules, Medium for the DLP-over-default detail | Admin Help page read; one detail is from a search summary |
| Detector accuracy | Medium | Mostly 2026 preprints and vendor benchmarks; no benchmark on documents like your organization's own |
| Catalog comparison | High for licence and status (GitHub API), Medium for runtime details (from memory) | |
| Enforcement patterns | High for OPA, Postgres and Vec2Text; Medium for vector store practice (practitioner blogs) | |
| Access requests and legal hold | Medium | Hold and search APIs read on vendor pages or reference docs; statutory clocks partly from memory; defensibility from secondary sources |
| Personal mark | Medium for products and case law (secondary), Low for the design itself (no product does all of it; it needs validation with counsel and users) | |
| Legal | Medium | Statute pages read for Quebec s. 3.3 and Ontario ESA; the rest is law firm summaries. Not legal advice. |

---

## 14. Sources

Detection and classification
- Presidio repository (MIT, Data Privacy Stack): https://github.com/data-privacy-stack/presidio
- Presidio moving to Data Privacy Stack (secondary): https://www.everydev.ai/developers/data-privacy-stack
- Presidio GLiNER recognizer sample: https://microsoft.github.io/presidio/samples/python/gliner
- Presidio LangExtract recognizer (Ollama): https://microsoft.github.io/presidio/samples/python/langextract
- Presidio evaluation guidance (F2, tuning): https://microsoft.github.io/presidio/evaluation
- GLiNER repository: https://github.com/urchade/GLiNER
- NVIDIA GLiNER-PII model card: https://huggingface.co/nvidia/gliner-PII
- Knowledgator GLiNER-PII: https://huggingface.co/knowledgator/gliner-pii-large-v1.0
- GLiNER2-PII and the SPY comparison (vendor blog): https://pioneer.ai/blog/gliner2-pii-open-source-privacy-filtering-with-pii-detection
- OpenAI Privacy Filter: https://openai.com/index/introducing-openai-privacy-filter/
- Tonic benchmark of Privacy Filter (vendor): https://www.tonic.ai/blog/benchmarking-openai-privacy-filter-pii-detection
- REDACT multilingual PII benchmark (arXiv 2606.19881): https://arxiv.org/abs/2606.19881
- Mind the Gap: Robustness Risks in PII Detection Systems (arXiv 2609.03464): https://arxiv.org/abs/2609.03464
- Security document classification with a fine-tuned local LLM (arXiv 2605.20368): https://arxiv.org/abs/2605.20368
- Four-tier sensitivity classifier model card: https://huggingface.co/aitrainingdatabroker/document-sensitivity-tier-classifier
- Conformal selective labeling (arXiv 2510.14581): https://arxiv.org/html/2510.14581v1
- Calibration and risk-controlled refusal (arXiv 2509.01455): https://arxiv.org/html/2509.01455v3
- gitleaks: https://github.com/gitleaks/gitleaks
- TruffleHog: https://github.com/trufflesecurity/trufflehog
- detect-secrets: https://github.com/Yelp/detect-secrets
- Secret scanner comparison (secondary): https://appsecsanta.com/secret-scanning-tools/gitleaks-vs-trufflehog

Microsoft Purview and Graph
- sensitivityLabel resource (v1.0): https://learn.microsoft.com/en-us/graph/api/resources/security-sensitivitylabel?view=graph-rest-1.0
- driveItem extractSensitivityLabels: https://learn.microsoft.com/en-us/graph/api/driveitem-extractsensitivitylabels?view=graph-rest-1.0
- driveItem getRetentionLabel: https://learn.microsoft.com/en-us/graph/api/driveitem-getretentionlabel
- driveItem delta (sharing, hierarchicalsharing): https://learn.microsoft.com/en-us/graph/api/driveitem-delta
- Delta and permission changes (user report): https://learn.microsoft.com/en-za/answers/questions/1833589/delta-token-does-not-work-for-tracking-permission
- Automatic labeling (overrides, simulation, limits, priority): https://learn.microsoft.com/en-us/purview/apply-sensitivity-label-automatically
- Sensitive information types (confidence levels, proximity): https://learn.microsoft.com/purview/sit-sensitive-information-type-learn-about
- MIP metadata: https://learn.microsoft.com/en-us/information-protection/develop/concept-mip-metadata
- Sensitivity Label Information part (LabelInfo.xml): https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/c0599e21-b77f-475e-99e0-bd647f60bcbb
- LabelInfo versus custom document properties: https://learn.microsoft.com/it-it/openspecs/office_file_formats/ms-offcrypto/13939de6-c833-44ab-b213-e0088bf02341
- Copilot label inheritance: https://learn.microsoft.com/en-us/copilot/microsoft-365/microsoft-365-copilot-architecture-data-protection-auditing
- Label change justification (training module): https://learn.microsoft.com/en-us/training/modules/describe-purview-data-solutions/3-describe-sensitivity-labels-policies
- Auto-labeling capacity increase (message center): https://mc.merill.net/message/MC1452372

Google Workspace
- files.modifyLabels: https://developers.google.com/drive/api/reference/rest/v3/files/modifyLabels
- Set a label field on a file: https://developers.google.com/workspace/drive/api/guides/set-label
- AI classification of Drive files: https://knowledge.workspace.google.com/admin/security/label-google-drive-files-automatically-using-ai-classification
- Enhanced content classification (2021 announcement): https://workspaceupdates.googleblog.com/2021/12/enhanced-content-classification.html

Privacy products
- Varonis automated labeling (vendor): https://www.varonis.com/blog/automated-data-labeling
- BigID identity-aware data mapping (vendor): https://bigid.com/?p=1692
- OneTrust data mapping glossary (vendor): https://www.onetrust.com/glossary/data-mapping/

Catalogs and metadata standards
- OpenMetadata classification: https://docs.open-metadata.org/v2.0.x/how-to-guides/data-governance/classification/classification
- OpenMetadata auto-classification: https://docs.open-metadata.org/latest/how-to-guides/data-governance/classification/auto-classification
- DataHub classification (custom classifiers): https://docs.datahub.com/docs/metadata-ingestion/docs/dev_guides/classification
- DataHub glossary term entity: https://docs.datahub.com/docs/generated/metamodel/entities/glossaryterm
- DataHub repository: https://github.com/datahub-project/datahub
- OpenMetadata repository: https://github.com/open-metadata/OpenMetadata
- Amundsen repository (archived): https://github.com/amundsen-io/amundsen
- Apache Atlas repository: https://github.com/apache/atlas
- Atlas classifications drive Ranger policies: https://docs.cloudera.com/runtime/7.3.1/cdp-governance-controlling-access-tags/topics/atlas-controlling-data-access-with-tags.html
- OpenLineage facets: https://openlineage.io/docs/spec/facets/
- W3C DCAT 3: https://www.w3.org/TR/vocab-dcat-3/
- Croissant 1.1 specification: https://docs.mlcommons.org/croissant/docs/croissant-spec-1.1.html
- Croissant paper: https://arxiv.org/html/2403.19546v2
- TDM Reservation Protocol: https://w3c.github.io/tdm-reservation-protocol
- Deduplicating Training Data Makes Language Models Better: https://arxiv.org/abs/2107.06499

Enforcement
- NIST SP 800-162: https://csrc.nist.gov/pubs/sp/800/162/upd2/final
- OPA SQL data filtering tutorial: https://openpolicyagent.org/docs/filtering/tutorial-sql-filtering
- OPA partial evaluation for data filters: https://www.openpolicyagent.org/docs/filtering/partial-evaluation
- Cedar: https://docs.cedarpolicy.com/
- AuthZEN notes on Cedar partial evaluation: https://hackmd.io/@oidf-wg-authzen/Sk7F3DBRkl
- PostgreSQL CREATE POLICY: https://www.postgresql.org/docs/current/sql-createpolicy.html
- PostgreSQL rules and privileges (security_barrier): https://www.postgresql.org/docs/18/rules-privileges.html
- MotherDuck secure views: https://motherduck.com/docs/key-tasks/sharing-data/secure-views/
- OpenFGA RAG authorization: https://openfga.dev/docs/modeling/agents/rag-authorization
- Vector store access control (practitioner): https://tianpan.co/blog/2026-04-17-vector-store-access-control-rag-rls
- Text Embeddings Reveal (Almost) As Much As Text: https://arxiv.org/abs/2310.06816
- Scalable Extraction of Training Data from (Production) Language Models: https://arxiv.org/abs/2311.17035
- Google Research on privacy in LLMs: https://research.google/blog/privacy-considerations-in-large-language-models/

Access requests, legal hold and personal exclusion
- Graph ediscoveryHoldPolicy: https://learn.microsoft.com/en-us/graph/api/resources/security-ediscoveryholdpolicy
- Graph create legalHolds: https://learn.microsoft.com/en-us/graph/api/security-ediscoverycase-post-legalholds
- Create holds in eDiscovery: https://learn.microsoft.com/purview/edisc-hold-create
- Retention for SharePoint and OneDrive (Preservation Hold library): https://learn.microsoft.com/en-us/purview/retention-policies-sharepoint
- Hold notifications and custodian communications: https://learn.microsoft.com/en-us/purview/ediscovery-managing-custodian-communications
- Claim that Purview hold communications were retired (vendor): https://blogs.opentext.com/why-microsoft-purview-falls-short-for-defensible-legal-hold/
- Priva Subject Rights Requests workflow: https://learn.microsoft.com/privacy/priva/subject-rights-requests-workflow
- Priva data estimate and retrieval: https://learn.microsoft.com/privacy/priva/subject-rights-requests-data-retrieval
- Google Vault holds (REST): https://developers.google.com/workspace/vault/reference/rest/v1/matters.holds
- Google Vault holds guide: https://developers.google.com/workspace/vault/guides/holds
- Amazon S3 Object Lock: https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html
- MinIO object locking: https://docs.min.io/community/minio-object-store/administration/object-management/object-retention.html
- Cohasset assessment of MinIO (SEC 17a-4(f)): https://www.min.io/cohasset/assessment-of-compliance-with-sec-rule-17a-4f
- ArkCase: https://www.arkcase.com/
- EDRM model: https://edrm.net/wiki/edrm-model/
- Sedona Canada Principles (summary): https://en.wikipedia.org/wiki/Sedona_Canada_Principles
- FRCP 37(e) reasonable steps (Duke Judicature): https://judicature.duke.edu/wp-content/uploads/sites/3/2020/10/may2017_rule37.pdf
- Deemed refusal and ATIA extensions (Information Commissioner, 2026 OIC 29): https://www.oic-ci.gc.ca/en/decisions/final-reports/innovation-science-and-economic-development-canada-re-2026-oic-29
- ATIA extension case (Federal Court of Appeal summary): https://www.lawtimesnews.com/case-law/federal-court-of-appeal/extension-of-time-limit-to-deal-with-request-did-not-meet-requirements-of-s-91-of-access-to-information-act-can/264751
- Privacy Act s. 14: https://laws-lois.justice.gc.ca/eng/acts/P-21/section-14.html
- Privacy Act s. 15: https://laws-lois.justice.gc.ca/eng/acts/P-21/section-15.html
- OPC on PIPEDA access time limits: https://www.priv.gc.ca/en/privacy-topics/accessing-personal-information/obligations-for-organizations/02_05_d_54_ati_02/
- PIPEDA access interpretation bulletin: https://priv.gc.ca/en/privacy-topics/privacy-laws-in-canada/the-personal-information-protection-and-electronic-documents-act-pipeda/pipeda-compliance-help/pipeda-interpretation-bulletins/interpretations_05_access
- SharePoint Restricted Content Discovery: https://learn.microsoft.com/en-us/sharepoint/restricted-content-discovery
- Google Workspace Intelligence controls: https://knowledge.workspace.google.com/admin/generative-ai/workspace-intelligence/control-workspace-intelligence
- Google Gemini privacy hub (IRM files not retrieved): https://knowledge.workspace.google.com/admin/gemini/generative-ai-in-google-workspace-privacy-hub
- Glean excluding content: https://docs.glean.com/connectors/excluding-content
- Glean hiding content: https://docs.glean.com/administration/search/hiding-content
- Glean request on Outlook private items: https://community.glean.com/discussion/669/feature-request-option-to-exclude-private-confidential-outlook-emails-from-glean-indexing
- R v. Cole, 2012 SCC 53: https://decisions.scc-csc.ca/scc-csc/scc-csc/en/12615/1/document.do
- Barbulescu v. Romania (Council of Europe summary): https://coe.int/en/web/portal/news-2017/-/asset_publisher/StEVosr24HJ2/content/echr-monitoring-an-employee-s-electronic-communications-amounted-to-a-breach-of-his-right-to-private-life

Legal and government
- Quebec Act respecting the protection of personal information in the private sector: https://www.legisquebec.gouv.qc.ca/en/document/cs/p-39.1
- Bill C-36 on LEGISinfo: https://www.parl.ca/legisinfo/en/bill/45-1/C-36
- Bill C-36 summary (DLA Piper): https://www.dlapiper.com/insights/publications/2026/06/canada-tables-bill-c36-the-protecting-privacy-and-consumer-data-act
- Ontario ESA written policy on electronic monitoring: https://www.ontario.ca/document/your-guide-employment-standards-act-0/written-policy-electronic-monitoring-employees
- OPC Privacy in the Workplace: https://www.priv.gc.ca/en/privacy-topics/employers-and-employees/02_05_d_17/
- OPC workplace guidance summary (BLG): https://www.blg.com/en/insights/2023/06/new-opc-guidance-privacy-in-the-workplace
- Alberta personal employee information: https://www.alberta.ca/personal-employee-information
- Employment data processing in Canada (Baker McKenzie): https://resourcehub.bakermckenzie.com/en/resources/global-data-and-cyber-handbook/north-america/canada/topics/data-processing-in-the-employment-context
- Ontario employee privacy gap (Gowling WLG): https://gowlingwlg.com/en/insights-resources/articles/2022/new-era-of-privacy-rights-in-ontario-workplaces
- EDPB opinion on DPIA lists (employee monitoring): https://www.edpb.europa.eu/sites/default/files/files/file1/2018-09-25-opinion_2018_art._64_be_sas_dpia_list_en.pdf
- What is subject to a DPIA (IAPP): https://iapp.org/news/a/what-is-and-what-isnt-subject-to-a-dpia-under-gdpr-an-update
- TBS Standard on Security Categorization: https://www.tbs-sct.canada.ca/pol/doc-eng.aspx?id=32614
- TBS direction on personal information in the aggregate: https://www.canada.ca/en/government/system/digital-government/policies-standards/spin/security-policy-implementation-notice-direction-security-categorization-personal-information-aggregate.html
