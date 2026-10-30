# Feature Research

**Domain:** Analyst-grade trusted-source knowledge base (source grading, claim register, RAFT network, geospatial/temporal views, forecasting, team sharing) inside a VS Code extension with TEE-only agents
**Milestone:** v0.5.0 (new features only; v0.4.0 capabilities are dependencies, not research targets)
**Researched:** 2026-10-28
**Confidence:** MEDIUM overall. HIGH on Admiralty semantics and the reliability/credibility distinction (multiple consistent sources). MEDIUM on how Maltego, i2, Gephi and Palantir present graphs (vendor docs and product sheets plus prior knowledge; i2 Analyst's Notebook docs sit behind a login and could not be read). LOW on RAFT (no authoritative public definition found; the brief's definition governs) and on any "standard" report thresholds (none found; see below).

Evidence tags used below: [S#] = a source in the Sources list; [KNOW] = author background knowledge, not verified in this session; [OPINION] = recommendation by the researcher.

---

## 1. How the domain works (what analysts expect)

### 1.1 Admiralty grading in practice

- **Two axes, judged independently.** Reliability (A-F) rates the *source* and is cumulative: it reflects track record across many reports. Credibility (1-6) rates the *individual item*: is it logical, consistent with other information, and confirmed by independent sources. [S1][S2]
- **Definitions to reproduce exactly.** A completely reliable, B usually reliable, C fairly reliable, D not usually reliable, E unreliable, F reliability cannot be judged. 1 confirmed by other independent sources, 2 probably true, 3 possibly true, 4 doubtful, 5 improbable (not logical, contradicted), 6 truth cannot be judged. [S1] Doctrine (AJP-2.1) is not public; secondary sources agree on these labels, and a peer-reviewed reproduction exists (Kelly, Budescu, Dhami, Mandel, *Judgment and Decision Making* 20, e36, 2025) which should be the cited authority for label wording. [S2][S3]
- **F and 6 are not "worst".** They mean "no basis to judge", which is different from E ("unreliable, history of invalid information") and 5 ("contradicted"). Tools that sort A-F as a plain ordinal scale mis-rank them. [S1] ([OPINION]: treat F/6 as a separate "unrated" state in sorting, thresholds and charts.)
- **Common misuse (all analyst-community consensus; practitioner guides):**
  1. Conflating the axes: a sketchy source can report a true thing; a usually reliable source can report a false one. A D/F source's item can still be confirmed by independent sources, and an A source's item can be "improbable". [S2][S4]
  2. Counting echoes as corroboration: "two vendors reported it" is not two independent sources. Corroboration (credibility 1) requires independence, which means tracing each claim to its originating source and counting that origin once. Circular reporting is a known failure mode, and "provenance matters more than prevalence". [S2][S5]
  3. Treating reliability as global: a source reliable on malware analysis is not automatically reliable on geopolitics. [S4]
  4. Grade-and-forget: grading at intake and never revisiting, or letting source prestige set the item grade.
  5. Reading the code as a probability. The code is an evaluation of source and information, not a likelihood estimate; ICD 203 keeps confidence in the basis for a judgment and likelihood of an event as separate, and forbids combining them in one sentence. [S6]
- **How tools implement it.**
  - OpenCTI: reliability is an open vocabulary on the *source* (organizations, individuals, systems, reports), default is the Admiralty scale; confidence is a 0-100 number with an optional Admiralty template; with both Admiralty templates the overview shows combined notation such as "A1" or "B2". Users and groups carry a max confidence level, and a user cannot update or delete an entity whose confidence exceeds theirs. Where two confidence values are possible, take the lowest. [S7]
  - i2 Analyze: configurable grade types; the UK law-enforcement style scheme is source evaluation A-E plus intelligence evaluation 1-5 plus a handling code. In Analyst's Notebook (via iBridge) a chart item carries grade and source fields; a grade that does not match a defined value falls back to the chart's last value. [S8]
  - STIX 2.1: `confidence` is an integer 0-100; the spec work planned a normative mapping to Admiralty, WEP and low/med/high, and the Admiralty "6" was left out of the mapping because it was unclear whether it maps to 0. [S9] Consequence: STIX import/export of two-axis grades is lossy by design; keep the native pair and store STIX confidence as an imported/exported projection.
  - MISP ships an Admiralty-scale taxonomy (tag-style labels). [S4-adjacent: search result listing; not read in depth.]

### 1.2 Source and claim registers

- Intelligence practice evaluates information "in the processing stage", before it is used; a source register carries identity, type, access/handling, track record and the reliability grade, and each reported item carries its own credibility grade and a source reference. [S1][S10] ICD 206 (sourcing) and ICD 203 (analytic standards) are the reference standards for "cite sources, describe their quality, caveat weak sourcing" in finished products; I could not retrieve the directive text in this session. [S6][KNOW]
- Claim extraction by LLMs: known failure is hallucinated triples not supported by the text; with no provenance one cannot tell real from plausible. The credible tool pattern (e.g. sift-kg) keeps provenance links to source documents and passages and never merges entities without approval. [S11] ACLED's human pipeline standardises actor names so one group is not double-coded under aliases, records location and time precision, and runs three review rounds with intra- and inter-coder checks. [S12]
- ACLED also shows the schema analysts are used to for events: who (actors), what (event type), where (coordinates + precision score), when (date + precision), actor-type codes, summary, and the warning that Actor1/Actor2 do not mean aggressor/victim. [S12]

### 1.3 Grade thresholds in finished reports

- I found **no published standard** numeric threshold (no "reports must be B2 or better"). Practice is: the report cites sources with their quality, states analytic confidence based on number, variety and reliability of sources, and caveats thin sourcing; confidence levels themselves are inconsistently defined even inside the IC. [S6] The brief's per-project threshold is therefore a product feature, not a doctrine; defaults are an [OPINION] call.
- [OPINION] Threshold design that matches analyst habits:
  - Threshold = two independent minimums (reliability floor, credibility ceiling in numeric terms). F and 6 never pass a numeric floor; they are "unrated" and appear only in an "unconfirmed" section unless the project explicitly admits them.
  - Multi-source claims: show every citation with its own pair; evaluate the threshold on the claim's credibility and the best reliability among *independent* supporting origins. Needs a decision in discuss-phase.
  - Below-threshold material is never silently dropped from the base; the report either omits it or lists it in an "unconfirmed / below threshold" annex marked as such. Analyst can preview "what would change if the threshold moved".
  - Every reported claim renders `claim text [B2] (source ids)`; the finished report separates **evidence grade** (Admiralty) from **judgment likelihood and confidence** (ICD 203 style words) so the two are not conflated. [S6]

### 1.4 Network diagrams, slicing and filtering (comparable tools)

- **Maltego:** graph canvas; layouts Block, Hierarchical, Circular, Organic, Interactive Organic (re-lays out only near new results; for large graphs); Lock layout / Freeze / Refresh to keep analyst-arranged positions stable while results arrive; views that size entities by link count, in/out links, rank, weight; a List View with a Time column; the browser version adds graph, map and table views side by side with Quick Find, Filters and Layouts. [S13] Takeaway: **stable layouts under incremental update** and **degree/rank-based sizing** are expected; hairballs are managed by views, not by showing less.
- **Gephi:** filters are built as visual queries (with NOT/MASK, giant-component, flatten) and apply live; a timeline interval narrows the graph, and ranking/partition/layout/filters all follow the current timeline range; ForceAtlas2 layout; handles up to roughly 100k nodes/1M edges on desktop but dynamic networks can be unstable at large size. [S14]
- **i2 Analyst's Notebook / Analyze:** link charts, timeline, social-network analysis, statistical views, and a Chart Reader for sharing charts with non-licensed viewers; per-item source and grade fields. [S8][S15] Other i2 behaviours (conditional formatting, histogram filtering, chart merge) are [KNOW], not verified.
- **Palantir Gotham-style:** link graph + map (Gaia) + Timeline, Timewheel, Heatmap and Histogram as helper apps over one shared object model; access control per object and per property with a configurable tamper-evident audit trail. [S16] Takeaway: **one object store, many linked views**; selection in one view highlights in the others.
- **Conflict-mapping practice** (the nearest public cousin of RAFT): draw bigger circles for more powerful actors, main actors at centre, relationships typed (alliance / conflict / etc.). [S17]
- **RAFT:** no authoritative public definition found; one military-journal article applies it with systems theory to find the key actor whose disruption undermines cohesion, and a course card expands the acronym as in the brief. [S17] Use the brief as the spec: Actors = nodes, Functions = per-actor role attribute, Relationships = edges, Tensions = per-edge polarity (positive / negative / neutral) with relative strength. Research on policy networks notes tensions triggered by one or a few actors can destabilise a network, supporting a "tension hotspots" view. [S17]

### 1.5 Geospatial OSINT on a globe

- Cesium's imagery model is a stack of `ImageryLayer`s each backed by a provider, with per-layer alpha; WMTS providers can be time-dynamic via a clock-driven `{Time}` variable (NASA GIBS example). Layer visibility by `layer.show` is [KNOW], not verified. [S18]
- Analysts expect: layer panel (checkbox per source/source-type), click an event to get a detail card with source and grade, cluster/heat modes at scale, time slider that filters what is drawn, and precision shown honestly (point vs district vs country centroid). ACLED encodes location precision explicitly for this reason. [S12]
- [OPINION, important privacy point] Offline gazetteer protects place names, but **imagery/tile requests reveal the viewport** (region of interest) to the tile host. For defence/law-enforcement users the default should be a bundled low-resolution offline base (e.g. Natural Earth) with online tiles opt-in per layer and clearly labelled as network egress.

### 1.6 Timeline replay

- Gephi, Maltego (time column) and Palantir (Timeline/Timewheel) treat time as a *filter on the same data*, not a separate dataset: scrubbing a range changes the graph, map and list together. [S13][S14][S16]
- The brief's three timestamps (happened, reported, graded) enable **bitemporal replay**: "show the world as we *knew* it on date D" (reported/graded <= D) versus "show what actually happened by date D". Analysts need both: the first is the post-mortem/intelligence-failure view, the second is the situation timeline. [OPINION; follows from the data model]

### 1.7 Structured analytic techniques and forecasting outputs

- **ACH (Heuer):** hypotheses across the top, evidence down the side, each cell consistent / inconsistent / not applicable, each evidence row rated for credibility and relevance; the goal is to *disprove* hypotheses; evidence consistent with all hypotheses has low diagnostic value; later steps include sensitivity checks on critical evidence and listing indicators to watch. [S19] ACH is the natural backbone for "scenario probabilities with the explaining evidence": the Admiralty credibility grade feeds the evidence-credibility column directly.
- **Likelihood language:** ICD 203 fixes estimative terms tied to numeric ranges (remote 01-05% ... nearly certain 95-99%); do not mix terms from different rows without a disclaimer; do not put a confidence level and a likelihood in the same sentence; explain the basis of uncertainty. [S6]
- **Calibration:** forecasting tournaments score probabilities with the Brier score (0 perfect, 0.25 for always saying 50% on binary questions), and decompose it into reliability (calibration), resolution and uncertainty; calibration is shown with reliability diagrams; reliability/resolution estimated from few binned forecasts are over-optimistic. Superforecasters were distinguished by frequent updating and aggregation, not raw expertise. [S20][S21]
- [OPINION] Scenario sets should be mutually exclusive and collectively exhaustive (include "other"), sum to 100%, carry a horizon, resolution criteria and a change log; a forecast without resolution criteria cannot be scored.

### 1.8 Team collaboration on a shared base

- Intelligence teams expect **attribution on every change** (who/which agent, when, why), **review** before shared judgments change, and **no silent overwrite**. OpenCTI enforces this with authority levels: a lower-authority user cannot modify a higher-confidence entity. [S7] Palantir-style systems keep an immutable, auditable provenance trail. [S16]
- Signed append-only per-author logs (e.g. p2panda: Ed25519-signed operations, single-writer logs combined for multi-writer, optional payload deletion without breaking the log) are an established design; key rotation on member removal protects only future data, and anything the removed member already decrypted stays exposed; new members should not see old history unless it is shared explicitly. [S22] This matches the brief's "they keep what they already had" and should be stated plainly in the UI.
- Key-change safety: members should be able to verify each other's public keys out of band (key transparency literature). [S22]

---

## 2. Feature Landscape

Complexity: LOW (days), MEDIUM (1-2 weeks), HIGH (multi-week or research risk).
Deps refer to existing v0.4.0 capabilities (see section 4).

### Table Stakes (users expect these; absence undermines trust)

| # | Feature | Why expected | Complexity | Notes / existing-feature dependencies |
|---|---------|--------------|------------|----------------------------------------|
| TS1 | Two-axis grade on every source and claim, stored and displayed as separate fields and as a pair ("B2") | Core of the brief; the whole domain is built on the pair [S1][S7] | LOW | Never collapse to one number internally. F and 6 modelled as "unrated", not as worst. Show label text on hover (e.g. "Usually reliable / Probably true"). |
| TS2 | Grade history per source and per claim: every change keeps old value, new value, evidence refs, reason, author (agent or analyst), timestamp; analyst override recorded identically | Brief requirement; accountability and ICD 203 expect revisions to be explainable [S6] | MEDIUM | Natural fit for the append-only event log. Agent Activity shows proposed vs applied changes. |
| TS3 | Source register: id, name, type, owner/publisher, URL or file, retrieval date, content hash/snapshot, reliability, topic scope notes, first/last seen | Registers are the unit of source evaluation [S1][S10] | MEDIUM | Depends on web fetch (captures URL, date); attachments become sources. Content hash lets CheckCitations verify later. |
| TS4 | Claim register: atomic claim, quoted supporting span with pointer into the source, source refs, credibility, status (reported / corroborated / contradicted / retracted), event time, reported time, graded time | Analysts need claims traceable to a passage, not to a document [S11][S12] | MEDIUM-HIGH | Extraction must be span-grounded and verified (extend CheckCitations to check span exists in stored snapshot). Fetched text is untrusted: reuse injection fencing so a page cannot instruct the grader. |
| TS5 | Independent-origin corroboration rule: credibility 1 only if >= 2 independent originating sources; echoes collapse to one origin; contradiction required for 5 | Admiralty definition of 1; circular reporting is the standard failure [S1][S5] | MEDIUM-HIGH | Needs an "origin" field (who first reported) and a "derived-from" link between sources. Agent proposes origin tracing; analyst confirms. Hard business rule, not a suggestion. |
| TS6 | Per-project thresholds (reliability floor, credibility ceiling); reports exclude or flag below-threshold claims; each reported claim shows grade and sources; unrated (F/6) handled explicitly | Brief requirement [S6 for reporting practice] | MEDIUM | Hooks into the research report path; CheckCitations extended to also fail a report whose claim lacks grade/source or is below threshold without the flag. |
| TS7 | Manual add / edit of sources and claims and import of CSV, STIX, GeoJSON with a column/field mapping preview | Brief intake; analysts bring existing data | MEDIUM | STIX confidence (0-100) is lossy against two-axis grades [S9]: import as "unrated, imported-confidence=N" and let analyst/agent grade. GeoJSON gives geometry + properties. Validate before commit (dry run). |
| TS8 | Standing feeds (RSS, MCP, watched folder) landing in an **inbox/triage queue**, not straight into the graded base | Feeds are high-volume and mostly noise; analysts triage | MEDIUM | MCP connections exist; add dedupe by hash/URL, rate limits, spending-limit awareness. Items arrive ungraded (F/6) until graded. |
| TS9 | Entity resolution with human approval: aliases for actors, merge/split with undo, never auto-merge silently | ACLED standardises actor names; sift-kg never merges without approval [S11][S12] | MEDIUM-HIGH | Agents propose merges; approvals reuse existing approval policy. Alias list on each actor. |
| TS10 | RAFT network diagram: actor nodes (type by colour/icon, size by a chosen metric), function attribute on node, relationship edges typed, tension polarity (+ / - / neutral) with strength as colour + width/dash, legend, pan/zoom, search, select -> detail pane with claims and grades behind it | Standard link-chart behaviour [S13][S14][S16] | HIGH | Webview with a graph renderer. Every edge must open to its supporting claims (provenance). Encode polarity with shape/pattern as well as colour (accessibility). |
| TS11 | Stable, selectable layouts (force-directed, hierarchical, circular), lock/freeze so analyst-placed positions persist as new data arrives; PNG/SVG export | Maltego Lock/Freeze/Interactive Organic [S13] | MEDIUM | Persist node positions per slice/view, not in the global base. |
| TS12 | Slices: saved filter definitions over the one broad graph by geography, time window, topic, actor set (+ N-hop neighbourhood); slice is a view (query), not a copy | Brief requirement; Gephi/Palantir filter model [S14][S16] | MEDIUM-HIGH | Agents receive slice-scoped context and write back to the base with slice tag. Slice size shown (nodes/edges/claims) and token estimate before an agent runs. Dependency: spending limits. |
| TS13 | Globe with per-source / per-source-type layers on/off, click for event card (source, grade, times, precision), time filter | Brief; Cesium layer model [S18] | HIGH | Open-source stack; heavy webview assets; offline base default (see 1.5). Layer state saved per project. |
| TS14 | Offline geocoding with ambiguity handling: gazetteer match returns candidates; low-confidence match flagged; precision recorded (point / admin area / country); analyst can fix a pin | ACLED precision scores [S12]; "Springfield" problem [KNOW] | MEDIUM-HIGH | Gazetteer (GeoNames) ships or downloads once as data file; no per-lookup network. Never let an agent silently pick the first match. |
| TS15 | Three timestamps on every item (happened, reported, graded) with precision (exact / day / month / approximate) | Brief; temporal analysis requires it | LOW-MEDIUM | Handle unknown/range dates ("early March") explicitly. |
| TS16 | Timeline scrubber with play/pause/speed that drives the graph, globe and list together; step by event | Gephi/Palantir shared time filter [S14][S16] | MEDIUM-HIGH | Requires an "as of" query over the event log; keep replay deterministic. |
| TS17 | Scenario forecasts: mutually exclusive, collectively exhaustive scenario set, probabilities summing to 100%, horizon, resolution criteria, plain-language ICD 203 band alongside the number, evidence for and against each scenario with its grade | Forecasting practice and ICD 203 [S6][S19][S20] | HIGH | Evidence column reuses claim grades. Show the confidence-in-the-forecast separately from likelihood. |
| TS18 | Forecast change log: each update stores previous probabilities, triggering evidence, and reason | Updating is what separates good forecasters [S20]; ICD 203 expects explained changes [S6] | MEDIUM | Same event-log mechanism as grade history. |
| TS19 | Shared base: every event signed and attributed, visible author/agent on every change, member list with fingerprints, invite by public key | Attribution/audit expected [S7][S16]; brief decision | HIGH | Own crypto protocol is a risk; see Pitfalls. Show key fingerprints for out-of-band verification [S22]. |
| TS20 | Conflict visibility: concurrent edits to the same grade/claim are shown side by side and resolved by a recorded decision; never last-writer-wins silently | OpenCTI authority rules, audit culture [S7] | MEDIUM-HIGH | Log is append-only so both survive; "current value" is a resolution event. |
| TS21 | Sensitivity banner: project shows TEE-only status, encryption-at-rest state, and which models touched which items | Brief; privacy product principle | LOW-MEDIUM | Blocks non-TEE model selection for KB projects, including sub-agents, embeddings and attachments. |
| TS22 | Report export of graded reports and graph slices (Markdown/PDF/HTML with grades, sources, threshold applied; slice as GeoJSON/STIX/CSV/PNG) | Open question in brief; analysts must hand products to others | MEDIUM | Export must carry the grade and the threshold used; warn if exporting leaves the encrypted store (egress confirmation). |

### Differentiators (competitive advantage)

| # | Feature | Value proposition | Complexity | Notes |
|---|---------|-------------------|------------|-------|
| D1 | Agent-proposed grade changes shown as a **diff with evidence** ("B -> C because claims X and Y were contradicted by independent sources Z"), accepted/rejected in one click, with an auto-accept policy per project | Competing tools make the analyst do all grading; "self-improving" is the stated value | MEDIUM-HIGH | Agent Activity as the surface. Guardrail: agents cannot raise credibility to 1 without TS5 evidence; cannot move anything out of a published report without notification (D3). |
| D2 | **Reliability scoped by topic/domain** (a source is B on cyber, D on politics) with the headline grade derived from the claim's topic | Addresses misuse #3 directly [S4] | MEDIUM | Adds a (source, topic) table; threshold evaluation uses the claim's topic. |
| D3 | Grade-drift alerts and **report impact analysis**: when a source is downgraded, list reports/forecasts that relied on it and which claims now fall below the threshold | Nobody ships this well; follows from continuous regrading | MEDIUM-HIGH | Needs claim-to-report back-links. |
| D4 | "Threshold preview / what-if": slide the threshold or hypothetically downgrade a source and see which claims and scenario probabilities change | Sensitivity checks are an ACH step [S19] | MEDIUM | Pure recomputation, no model call needed for claims. |
| D5 | Echo detector: flag sources whose claims are textually near-identical to an earlier source's, propose "derived-from", and show corroboration count of *independent origins* next to raw count | Directly attacks the top misuse [S5] | MEDIUM-HIGH | Local embeddings must be TEE-attested or done with local lexical/shingle hashing; no non-TEE embeddings. |
| D6 | Contradiction detection across claims within a slice, surfaced as a review queue | Contradiction is how credibility 5 and downgrades are earned | HIGH | LLM judgement; needs precision-first tuning to avoid noise. |
| D7 | ACH matrix view per scenario set, auto-populated from graded claims (evidence x hypothesis, consistent/inconsistent/NA, credibility and relevance), showing diagnostic vs non-diagnostic evidence | Explains forecasts the way analysts are trained [S19] | HIGH | Matrix is the "explaining evidence" output for TS17. Analyst can edit cells; edits recorded. |
| D8 | Evidence-contribution view for each probability ("what pushed this scenario from 22% to 31%") | Meets ICD 203 explain-the-change expectation [S6] | HIGH | Requires an interpretable model (additive/Bayesian updates); black-box forecasters cannot supply it. |
| D9 | Calibration dashboard: track record of resolved forecasts, Brier score and reliability diagram, with the sample size shown and a "too few to judge" state | Calibration is the accepted measure of forecast quality [S20][S21] | MEDIUM-HIGH | Only meaningful after resolution events; ship scoring early so data accrues. |
| D10 | RAFT tension trends: per-edge tension history sparklines, tension hotspots (actors whose edges changed most), and trend forecasts with probability bands | Brief; tensions destabilising networks is the RAFT premise [S17] | HIGH | Tension values derive from graded claims over time; show the claims behind every point. |
| D11 | Grade-aware visual encoding: edge/node opacity or border by credibility, dashed for unrated, optional "hide below threshold" toggle on diagram and globe | Makes uncertainty visible instead of buried in a detail pane | MEDIUM | Must not rely on colour alone. |
| D12 | Linked brushing across graph, globe, timeline, and claim list (select in one, highlight in all) | Palantir-style one-object-many-views [S16] | MEDIUM-HIGH | Single selection model in the extension host; views are projections. |
| D13 | Bitemporal replay ("as known on D" vs "as happened by D") | Supports post-mortem and intelligence-failure analysis [OPINION] | MEDIUM | Free once three timestamps and the event log exist. |
| D14 | Indicators/tripwires per scenario: user-defined observable events that, when a feed item matches, raise a review item and prompt a forecast update | ACH's closing step is to list indicators to watch [S19] | MEDIUM-HIGH | Uses standing feeds + a matching agent run; spending-limit aware. |
| D15 | Slice-scoped agents with context budget: the agent's visible world is the slice, with the token cost shown beforehand | Keeps strategic/operational/tactical context within model windows | MEDIUM | Reuses spending limits and project memory retrieval. |
| D16 | Local-or-TEE model choice for forecasting with the trade-off stated in plain language (what leaves the machine, attestation state, cost) | Brief decision; privacy product differentiator | MEDIUM | Local model option conflicts with "TEE-only" for agents: forecasting local training sits outside the NEAR path, so document that no data leaves the machine. |
| D17 | Review/approval workflow on shared base: designated reviewer role for grade changes that cross a report threshold; comments on claims | Collaboration norm in analytic shops [OPINION] | HIGH | Implement as signed "review" events, not as a server. |
| D18 | Key-rotation UX that states exactly what a removed member keeps; new-member history grant is explicit ("share history from date X") | Honest security UX [S22] | MEDIUM | Counters false assurance. |

### Anti-Features (commonly requested, often problematic)

| # | Feature | Why requested | Why problematic | Alternative |
|---|---------|---------------|-----------------|-------------|
| A1 | One blended "confidence score" (0-100) replacing the A-F / 1-6 pair | Simple to sort, compare, and feed to ML; OpenCTI and STIX do this for machines [S7][S9] | Destroys the reliability/credibility distinction, which is the point of the method [S2][S4] | Keep the pair natively; derive a numeric projection only for export/sorting and label it as derived. |
| A2 | Auto-upgrading a source's reliability from volume, popularity, domain rank, or number of citations | Looks like "self-improving" | Echo chambers inflate it; reliability must reflect track record of *verified* reports [S1][S5] | Reliability moves only on evidence events (confirmed/contradicted claims) with shown reasons. |
| A3 | Counting repeated reports as corroboration | Higher "confirmations" feel better | Circular reporting; provenance over prevalence [S5] | Independent-origin count (TS5, D5). |
| A4 | Treating F/6 as "very low" or defaulting unknowns to E/5 | Convenient for thresholds | F/6 means cannot be judged, not bad [S1] | Separate "unrated" state; thresholds treat it explicitly. |
| A5 | Silent agent merging of actors or silent overwrite of analyst grades | Reduces review burden | Wrong merges poison the graph and are hard to detect; analysts lose trust [S11] | Proposals + approvals + undo; analyst override always wins and is recorded. |
| A6 | Auto-deleting below-threshold claims | Cleaner reports | Evidence later upgraded would be gone; destroys the audit trail | Keep in base; exclude or flag in report. |
| A7 | Spurious precision in forecasts ("37.4%") or probabilities from tiny event histories presented as model output | Looks rigorous | Overconfidence; reliability estimates from few forecasts are over-optimistic [S21] | Round or show intervals/bands with ICD 203 terms [S6]; display training-set size; "insufficient history" state. |
| A8 | Mixing confidence and likelihood in one statement | Natural phrasing | Explicitly prohibited by ICD 203 [S6] | Separate fields in the UI and report template. |
| A9 | Rendering the entire broad graph as a hairball by default | "Show everything" | Unusable, slow; Maltego/Gephi solve with views and filters [S13][S14] | Open on a slice; show counts and offer expand-by-N-hops. |
| A10 | Real-time collaborative co-editing with presence cursors | Familiar from docs tools | Conflicts with signed append-only, E2EE log on git/shared folder; large complexity for little analyst value | Asynchronous sync with visible pending changes and conflict review (TS20). |
| A11 | Cloud geocoding, cloud basemap defaults, or online place-name lookup | Better accuracy | Leaks the area of interest; tile requests reveal viewport [OPINION] | Offline gazetteer and bundled base; online tiles opt-in per layer with egress label. |
| A12 | Person-level targeting aids: facial recognition, scraping of private individuals, geolocating named private people automatically | Sometimes asked in OSINT tooling | Legal, ethical and reputational exposure for a defence/law-enforcement audience; outside a source-grading knowledge base | Keep to organisations, events, and public-role actors; leave individual-targeting workflows to the user's own authorised systems. |
| A13 | LLM as sole judge of credibility 1 or reliability A | Fast | Models can be steered by the content they grade (prompt injection via fetched pages) | Reuse injection defences, require independent-origin evidence, require analyst confirmation for the extremes (A, 1, E, 5). |
| A14 | User-defined arbitrary grading scales | i2 allows custom grade types [S8] | Breaks thresholds, STIX mapping, comparisons across teams; the decision is Admiralty | Admiralty only; a per-project display-label mapping if needed. |
| A15 | Promising that removing a member erases what they hold | Reassuring | Cryptographically false [S22] | State the limits (D18). |
| A16 | Pushing the shared log to any hosted service that can read it | Convenience | Brief requires the host to see ciphertext only | Git repo or shared folder with encrypted payloads; metadata minimisation noted as open issue. |

---

## 3. Feature Dependencies

```
Three timestamps (TS15)
    └──requires──> event log (append-only, signed) (TS19)
    └──enables──> timeline replay (TS16) ──enables──> bitemporal replay (D13)
                                         ──enables──> forecast change log (TS18), calibration (D9)

Two-axis grade (TS1)
    └──requires──> grade history (TS2) ──requires──> event log
    └──requires──> source register (TS3) + claim register (TS4)
          └──requires──> span-grounded extraction ──requires──> web fetch + injection fencing (existing)
          └──requires──> CheckCitations extension (existing)
    TS5 independent-origin rule ──requires──> origin / derived-from links ──enhanced by──> D5 echo detector
    TS6 thresholds ──requires──> TS1, TS4, TS5 (to be meaningful), research report path (existing)
    D1 agent grade diffs ──requires──> TS2 + Agent Activity (existing) + approval policy (existing)
    D3 impact analysis ──requires──> claim-to-report back-links
    D4 what-if ──requires──> TS6

Entity resolution (TS9) ──requires──> actors/aliases ──enables──> RAFT (TS10) ──enables──> slices (TS12)
RAFT tension trends (D10) ──requires──> TS10 + TS15 + graded claims behind every edge
Globe (TS13) ──requires──> geocoding (TS14) + TS15 + layer registry per source type
Linked brushing (D12) ──requires──> one selection model across TS10, TS13, TS16

Scenario forecasts (TS17) ──requires──> graded claims (TS1/TS4) + TS15 + slices (TS12)
    D7 ACH matrix ──enhances──> TS17 ; D8 evidence contribution ──requires──> interpretable model
    D9 calibration ──requires──> resolution criteria on TS17 + time to accrue data

Shared base (TS19, TS20, D17, D18) ──requires──> event log + key management (SecretStorage) 
Sensitivity (TS21) ──constrains──> every model call incl. sub-agents, attachments, embeddings (D5, D6, D15, D16)

Intake (TS7, TS8) ──feeds──> source/claim registers; feeds also require spending limits (existing)

Conflicts:
  A1 (single score) conflicts with TS1/TS6
  A10 (real-time co-edit) conflicts with TS19/TS20
  D16 local training conflicts with strict reading of TS21 unless documented as local-only
```

### Dependency Notes

- **Event log first.** Almost every table-stake (history, replay, attribution, conflict, forecast log) is a *projection of one signed append-only log*. Building grading as ordinary mutable rows and retrofitting the log later is the largest rework risk.
- **Provenance before graph.** Edges and forecasts are only as credible as the claims behind them; TS4/TS5 must exist before RAFT edges and scenario evidence rely on them.
- **Time before replay and forecasting.** Replay and calibration cannot be added later without re-importing history; capture the three timestamps from day one.
- **Globe and timeline are views, not stores.** They read the same objects as the graph; do not give them separate data.

---

## 4. Dependencies on existing (v0.4.0) features

| Existing feature | How v0.5.0 depends on it | Impact / risk |
|------------------|--------------------------|---------------|
| Web search/fetch with injection defences | Source intake and span-grounded claim extraction read untrusted pages; the grader must not obey instructions in them | Reuse fencing; add a test that a poisoned page cannot raise its own grade (A13). Store immutable snapshot + hash. |
| CheckCitations | Extend from "citation exists" to "claim span exists in stored source snapshot, grade shown, threshold met" | Low risk; natural home for report gating (TS6). |
| Project memory (context graph store) | Becomes (or is replaced by) the base. The graph store decision (encrypted SQLite/WASM vs append-only log + snapshots) is an open question in the brief | Biggest architectural dependency; features above assume the log. Migration path for existing memory needed. |
| Agent Activity | Surface for agent-proposed grades, merges, slice runs | Needs new event types and an approve/reject action. |
| Research project type and team | Research agents emit sources/claims; slice-scoped agents; KB projects force TEE-only | Team definitions need a "KB mode" and a slice parameter. |
| MCP connections | Standing feeds and external OSINT sources | Feed items enter the triage inbox (TS8). |
| Encrypted chats / attachments | Attachments become sources; chat must not leak graded content to non-TEE models | Enforce TEE-only for attachments and embeddings (TS21). |
| Spending limits | Continuous regrading, feed processing, and forecast runs can burn budget | Budgets per feed and per regrade sweep; show estimates before slice-wide runs. |
| Approval policy | Agent writes to shared base and grade changes need a gate | Reuse for TS9, D1, D17. |

---

## 5. MVP Recommendation (for roadmap ordering)

The brief ships everything in v0.5.0, so this is an ordering recommendation rather than a cut line. Build in this order; each layer is useful on its own and unblocks the next.

1. **Event log + three timestamps + encryption at rest** (TS15, TS19 core, TS21). Foundation for history, replay, sharing.
2. **Source and claim registers with Admiralty grading, history, independent-origin rule** (TS1-TS5).
3. **Thresholded, graded reporting + CheckCitations extension** (TS6, TS22 reports). First user-visible payoff; usable without any visual layer.
4. **Intake: manual/import, then feeds with triage** (TS7, TS8, TS9).
5. **RAFT diagram and slices** (TS10-TS12), then **agent-proposed grading diffs** (D1) and agents working within slices (D15).
6. **Geocoding, globe, layers** (TS13, TS14), then **timeline replay** (TS16, D13) and linked brushing (D12).
7. **Forecasting**: scenario sets with evidence and change log (TS17, TS18, D7), calibration scoring (D9) started as early as the first forecast so data accrues, then tension trends (D10).
8. **Shared base maturity**: conflict UI, review, key-rotation UX (TS20, D17, D18). The signed-log core is in step 1; the multi-user UX can land later, but the log design must assume multiple authors from the start.

**Highest-value differentiators to protect if time slips:** D1 (agent grade diffs with evidence), D3/D4 (impact and what-if), D5 (echo detector), D7/D8 (ACH-based explainable forecasts).
**Defer candidates if cut is forced:** D6 contradiction detection, D14 tripwires, D16 local-model training, D10 tension trend forecasting (all depend on accumulated data or are model-risky).

---

## 6. Open design decisions surfaced by this research (for discuss-phase)

1. Claim-level threshold rule when a claim has several sources of different reliability (best independent origin vs weakest). [OPINION recommended: best independent origin, show all.]
2. Treatment of F/6 in thresholds and sorting (recommended: separate "unrated" state).
3. Whether reliability is scoped by topic (D2) from the start; retrofitting changes the schema.
4. Default thresholds per project template (no doctrinal standard exists; propose a default and let the user edit).
5. Which tile hosts, if any, are allowed by default for the globe (recommend none; bundled offline base).
6. Interpretable forecasting methods only if D8 is kept (additive/Bayesian updating of scenario odds from graded evidence; ACH-style diagnostic weighting), versus black-box temporal models.
7. Whether to publish a human-readable grading guide in the UI (definitions of A-F/1-6 plus the independence rule) so team members grade consistently; ACLED-style inter-coder checks suggest periodic agreement checks between agents and analysts.
8. Metadata leakage on git/shared folders (file names, commit timing, author keys) despite ciphertext payloads.

---

## Sources

- [S1] Admiralty code (definitions of A-F, 1-6, F/6, independence): https://en.wikipedia.org/wiki/Admiralty_code (MEDIUM; page carries a single-source maintenance notice, definitions cross-checked against S2/S4)
- [S2] Source reliability and credibility explainer and misuse notes: https://pangearesearch.substack.com/p/the-admiralty-code-nato-6x6-system ; https://altss.com/glossary/source-reliability (MEDIUM-LOW, practitioner/vendor)
- [S3] Kelly, Budescu, Dhami, Mandel, Judgment and Decision Making 20, e36 (2025), peer-reviewed reproduction of the scale; cited via https://altss.com/glossary/source-reliability (text not read; verify before quoting)
- [S4] https://anticitizenone.medium.com/source-reliability-grading-and-analysis-483eeb57df1a ; https://skillselion.com/skills/tsale/awesome-dfir-skills/admiralty-system ; MISP taxonomy listing https://eugit.opencloud.lu/MISP/misp-taxonomies/src/commit/70c298b53c3f3ef196555708b06995b24b944e79/admiralty-scale (LOW-MEDIUM, practitioner)
- [S5] Circular reporting and independence: https://www.thecipherbrief.com/the-hidden-risks-of-ai-powered-intelligence ; https://dspace.ut.ee/bitstreams/a20eff60-9e14-4a30-ad4c-f1cb66c5ac05/download (MEDIUM-LOW; commentary and a master's thesis)
- [S6] ICD 203 and estimative language: https://www.dni.gov/files/documents/ICD/ICD-203.pdf (primary; PDF text could not be extracted this session, claims taken from a search summary of it) ; https://www.cisecurity.org/ms-isac/services/words-of-estimative-probability-analytic-confidences-and-structured-analytic-techniques ; ODNI research paper noting undefined confidence levels https://www.dni.gov/files/documents/FOIA/DF-2024-00001-NIU_Research_Short.pdf (MEDIUM)
- [S7] OpenCTI reliability and confidence (fetched and read): https://docs.opencti.io/latest/usage/reliability-confidence/ (HIGH for OpenCTI behaviour)
- [S8] i2 Analyze grading scheme https://docs.i2group.com/analyze/4.4.1/creating_grade_types.html ; iBridge grades https://docs.i2group.com/ibridge/9.4.0/defining_the_source_grades_of_a_type.html (MEDIUM; Analyst's Notebook docs at https://docs.i2group.com/anb/10.0.2/index.html require login)
- [S9] STIX 2.1 confidence and Admiralty mapping discussion (OASIS CTI list): https://lists.oasis-open.org/archives/cti/201702/msg00048.html ; EclecticIQ ingestion mapping https://docs.eclecticiq.com/ic/2.12.1/STIX_2.1_Common_Properties.html (MEDIUM; final normative appendix not read)
- [S10] Intelligence source and information reliability overview: https://en.wikipedia.org/wiki/Intelligence_source_and_information_reliability (MEDIUM-LOW)
- [S11] LLM knowledge-graph extraction and provenance: https://arxiv.org/pdf/2308.06374 ; https://arxiv.org/pdf/2502.09956 ; https://www.mintlify.com/juanceresa/sift-kg/concepts/how-it-works (MEDIUM-LOW; tool docs, no OSINT benchmark found)
- [S12] ACLED coding and review: https://acleddata.com/methodology/how-does-acled-code-and-review-data-ensure-quality ; https://acleddata.com/knowledge-base/how-does-acled-code-and-review-data-to-ensure-quality (HIGH for ACLED practice)
- [S13] Maltego graph sidebar (fetched): https://docs.maltego.com/support/solutions/articles/15000009615-graph-sidebar ; views https://docs.maltego.com/support/solutions/articles/15000010458-view-tab (HIGH for Maltego behaviour; timeline/filter specifics not confirmed)
- [S14] Gephi features and timeline/filters: https://www.gephi.org/features ; https://docs.gephi.org/User_Manual/gui (MEDIUM)
- [S15] i2 Analyst's Notebook overview: https://docs.i2group.com/anb/10.1.2/ ; https://www.scworld.com/product-test/i2-analysts-notebook (MEDIUM-LOW)
- [S16] Palantir Gotham product description and overviews: https://s3.documentcloud.org/documents/810526/1035-palantir-product-description-gotham.pdf ; https://goldingresearch.substack.com/p/inside-palantir-gotham (MEDIUM-LOW; dated vendor material)
- [S17] RAFT and actor/conflict mapping: https://www.pensamientoconjunto.com.pe/index.php/PC/article/download/171/175/762 ; https://www.helvetas.org/Publications-PDFs/Switzerland/VIC/CSPM_ParticipantWorksheets_June2025.pdf (LOW; no authoritative RAFT definition)
- [S18] Cesium imagery layers and GIBS time-dynamic WMTS: https://cesium.com/docs/tutorials/imagery-layers ; https://cesium.com/downloads/cesiumjs/releases/1.118/Build/Documentation/WebMapTileServiceImageryProvider.html (MEDIUM-HIGH)
- [S19] ACH (Heuer): https://en.wikipedia.org/wiki/Analysis_of_competing_hypotheses ; https://isc.sans.edu/diary/22460 ; NATO STO https://www.sto.nato.int/publications/STO Meeting Proceedings/STO-MP-SAS-114/MP-SAS-114-ANN-G.pdf (MEDIUM)
- [S20] Good Judgment Project / superforecaster calibration: https://goodjudgment.com/wp-content/uploads/2021/10/Superforecasters-A-Decade-of-Stochastic-Dominance.pdf ; https://aiimpacts.org/?p=1260 (MEDIUM)
- [S21] Brier score decomposition and optimism of binned estimates: https://ore.exeter.ac.uk/repository/handle/10871/34847 ; https://www.wikipedia.com/wiki/Brier_score (MEDIUM)
- [S22] Signed append-only logs, key rotation limits, key transparency: https://docs.rs/p2panda-core ; https://datatracker.ietf.org/doc/html/draft-keytrans-mcmillion-protocol (MEDIUM-LOW; key-rotation limits partly from patent text and general secure-messaging guidance, consistent with the brief's own "they keep what they already had")

Not covered by any source and flagged [KNOW]/[OPINION] in the text: Cesium `layer.show` toggle; i2 conditional formatting and chart merge; GDELT/Liveuamap analyst expectations; Metaculus track-record conventions; concurrent-edit semantics under key rotation in a signed log (needs phase-specific research).
