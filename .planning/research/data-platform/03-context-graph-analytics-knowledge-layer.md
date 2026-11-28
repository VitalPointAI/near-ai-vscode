# 03: Context graph, search, analytics and reporting, and the knowledge-base interaction layer

**Researched:** 2026-11-18
**Area:** the context graph built from all of your organization's ingested data, hybrid search, analytics and reporting, and how the paused v0.5.0 "trusted-source knowledge base" becomes the interaction layer on top of the data platform.
**Overall confidence:** MEDIUM. Licences, maintenance status and documented features are HIGH (read from project pages, release notes and commit lists). Quality comparisons rest on a few papers that partly disagree (MEDIUM). Cost per million documents on local hardware is an estimate built from published throughput figures and stated assumptions (LOW to MEDIUM, see section 1.2).
**Companion files:** the discovery and ingestion, and the classification and labelling research in this folder cover how items arrive and get their labels. This file assumes every item arrives with a label in the shape the owner already approved (Platform direction decision 11: `{scale, level, compartments, releasability, handling}`).

---

## Summary

Build the context graph as a layer of *evidence rows* over the governed store, not as a separate graph database: every entity mention, relationship and chunk is a row that points back to the exact span of the source item it came from and carries that item's label, and every entity, edge, count and summary a person sees is computed at read time from only the rows their clearance dominates. Use PostgreSQL on the host (the appliance from milestone L1) with pgvector for semantic search, a Postgres-licensed BM25 extension (or built-in full-text search) for keywords, plain tables plus recursive queries for graph traversal (Apache AGE optional for Cypher), and Postgres row-level security as the single enforcement point, fed by the policy gate. Do not adopt full Microsoft GraphRAG: it is now in maintenance mode, its precomputed community summaries mix labels, and LLM extraction of a million documents takes roughly three months on one Strix Halo machine. Instead extract cheaply for everything (embeddings, small-model entity tagging, noun-phrase co-occurrence, structured fields), run LLM relation extraction only on high-value or frequently queried items, and do the expensive reasoning at question time within the asker's clearance (the LazyGraphRAG pattern). Build dashboards natively in our webview with DuckDB and Mosaic or Perspective over a host query endpoint, rather than embedding Superset or Metabase. The paused v0.5.0 plan maps well: its store and search phase is superseded by this store, its compartments become label compartments, its "reader-relative derived views" rule and two-compartment indistinguishability test become the central test of the whole platform, and its intake, grading, RAFT, globe and timeline phases become views on the context graph. The Phase 13 code (hybrid post-quantum signing and key wrap, the signed encrypted log, per-item erasure keys, the canary scan and network spy harnesses) carries over, but the envelope's single compartment string and the single-file item-key vault must change before they can hold labelled data at a million-item scale.

## Bastion design reference

The Phase 96 Bastion crosswalk (`96-BASTION-CROSSWALK.md`)
maps Bastion's entity navigation, source detail, saved views and match review to
the SovAI requirements. Its first synthetic case compares an authorized graph
against the same graph with restricted evidence present. The production graph
still uses Phase 93 access decisions and exact source spans.

## Recommended design

1. **One store, evidence-first.** Postgres on the appliance host holds items (metadata and parsed text), chunks, embeddings, entity mentions, relation evidence and entity links. Each row has a `label_id`. The graph is a *view*: an entity is the set of its visible mentions, an edge is the set of its visible evidence. Nothing derived is stored without the label of the most restrictive input (the session high-water rule from decision 11, applied to data).
2. **Enforce labels in the database, decided by the gate.** Postgres row-level security (RLS) policies call one label-dominance function against the reader's clearance, which the gate sets per transaction from verified credentials (v0.7.0 Phases 70 and 71). The application role does not own the tables, has no `BYPASSRLS`, and tables use `FORCE ROW LEVEL SECURITY`. People and agents never get a raw database connection.
3. **Two enforcement layers, not one.** Cryptography decides what reaches a device (an edge device or laptop only receives ciphertext for label cells it holds keys for, the paused Phase 19 and 20 design). RLS decides what reaches a session or agent on a host that serves many people. Inference routing by `handling` (decision 11) decides which model may see the result.
4. **Tiered extraction.** Tier 0 for every item: parse, chunk, embed, tag entities with a small local model, record noun-phrase co-occurrence, lift structured fields. Tier 1 on demand or for priority sources: LLM relation extraction with quote-verified spans (the paused Phase 15 rule). Tier 2 at question time: graph walk plus LLM reasoning over only what the asker may see.
5. **Entity resolution as proposals, never destructive merges.** Deterministic keys first (email, tax id, domain, account number), then embedding blocking, then an LLM or probabilistic judge, then a person for low-confidence links. A link is a row with evidence and its own label (the join of both sides), reversible, exactly like the paused "proposed links with undo" (INTAKE-05).
6. **Hybrid search in SQL.** BM25 plus vector nearest neighbours fused by reciprocal rank fusion, reranked by the attested `Qwen3-Reranker-0.6B` or a local reranker, with pgvector iterative index scans turned on so label filtering does not starve results.
7. **Analytics native, BI optional.** Automatic dashboards are our own webview components (Mosaic vgplot or Perspective) fed by host-built, label-filtered query results over a message bridge, consistent with the paused panel rule (strict CSP, no network, capped DTOs). Natural-language questions become SQL over a curated set of views, run read-only, shown with the SQL, and can never widen access because RLS still applies.
8. **The paused knowledge base is the interaction layer.** Its panel shell, registers, provenance views, grading, slices, RAFT diagram, globe and timeline become views over the context graph. Admiralty grading becomes an optional trust layer per source, required for intelligence projects.

```
 sources ──> ingestion and classification (files 01, 02) ──> labelled items
                                                               │
          ┌────────────────────────────────────────────────────┤
          │ Tier 0: chunk, embed, small-model entity tags,      │
          │ co-occurrence, structured fields                    │
          │ Tier 1: LLM relations with verified quotes (queued) │
          v                                                    v
   Postgres (host): items, chunks+vectors, mentions, evidence, links, labels
          │   RLS: label_dominates(clearance, row.label)  <── gate sets clearance per transaction
          v
   query service (TypeScript engine): search, graph walk, SQL over views, insights
          │   answers labelled with the session high-water mark; routing by handling
          v
   webview / Theia widget: estate map, search, entity pages, graph, timeline, globe, ask
```

---

## 1. Building a context graph from mixed enterprise data

### 1.1 Approaches compared

| Approach | How it builds the graph | Provenance to source | Quality evidence | Licence and status | Verdict for us |
|---|---|---|---|---|---|
| **Microsoft GraphRAG** | LLM extracts entities and relationships per chunk, clusters communities (Leiden), LLM writes community reports at several levels | Entities and relationships link to text units; community reports are LLM summaries that mix many sources | Strong on global "sensemaking" questions; repo warns "GraphRAG indexing can be an expensive operation" | MIT. Repo now says it is "largely in maintenance mode": bug and CVE fixes only, no new features (HIGH) | **Do not adopt.** Cost, maintenance mode, and precomputed reports that blend labels |
| **LazyGraphRAG** (Microsoft Research, Nov 2024) | NLP noun-phrase extraction and co-occurrence at index time; LLM work deferred to query time | Concepts link to chunks; summaries made per query | Microsoft reports indexing cost "identical to vector RAG and 0.1% of the costs of full GraphRAG", and comparable global-query quality at "more than 700 times lower query cost" (HIGH, vendor's own benchmark) | Pattern described in a blog; folded into the GraphRAG library per secondary sources (MEDIUM) | **Adopt the pattern** (implement ourselves): cheap index, reasoning at question time inside the asker's clearance |
| **LightRAG** (HKU) | LLM extracts entities and relations per chunk, merges descriptions by name; dual-level (local and global) retrieval | Returns retrieved contexts and citations; supports document deletion with graph regeneration | Benchmarks in its paper; README says for local use "Qwen3-30B-A3B-Instruct is a reasonable minimum" | MIT, active (news to 2026-07). Postgres is the recommended production backend; has a plain-table Postgres graph store and an AGE store (HIGH) | **Use as reference and for spikes**, not as the runtime: Python service, name-matching dedupe, its "workspace" is "not a security boundary" |
| **nano-graphrag** | Compact re-implementation of GraphRAG | As GraphRAG | Reference quality only | MIT; last activity reported around January 2026, trackers mark it inactive (MEDIUM) | **Skip** |
| **HippoRAG 2** (OSU) | LLM open information extraction to triples, then Personalized PageRank over a phrase and passage graph | Passages are graph nodes, so every answer path ends at source passages | Authors report it beats GraphRAG, LightRAG and RAPTOR on multi-hop QA with fewer tokens; one independent study confirms low token cost, another (GraphRAG-Bench) found the longest indexing wall-clock time (MEDIUM) | MIT; supports local vLLM or OpenAI-compatible servers (HIGH) | **Borrow the retrieval idea** (PageRank seeded by query entities over the evidence graph) |
| **Graphiti** (Zep) | Incremental, bi-temporal graph from "episodes"; facts carry validity windows and are invalidated, not deleted | Every derived fact traces back to its episode | Paper arXiv 2501.13956 | Apache-2.0; backends Neo4j and FalkorDB, Kùzu deprecated (MEDIUM) | **Borrow the temporal model**: it matches the paused four timestamps (occurred, reported, recorded, graded) |
| **Neo4j LLM Knowledge Graph Builder** | Chunks documents, links chunks, LLM extraction, embeddings | Chunk nodes linked to entities | Demo-grade tool | Apache-2.0 per listings (verify), needs Neo4j (MEDIUM) | **Skip** (ties us to Neo4j) |
| **Small extraction models** (GLiNER, GLiNER2) | Schema-driven entity tagging and classification; relation extraction claimed for newer checkpoints | Exact character spans | Fast on CPU; GLiNER2 base about 205M parameters (MEDIUM) | Apache-2.0 for the open checkpoints (MEDIUM) | **Adopt for Tier 0** entity tagging in a local worker |

What the evidence says about *when* a graph helps: GraphRAG-Bench (Xiang et al., ICLR 2026) finds graph retrieval is not uniformly better; plain retrieval matches or beats it for single-fact lookups, while graph methods hold up better on multi-hop reasoning and as the corpus grows (MEDIUM, read through summaries of the paper). So the product should answer most questions with hybrid search and use graph walks for "how is X connected to Y", "everything about this customer across sources" and multi-hop questions.

### 1.2 Cost per million documents on local hardware

These are estimates, not measurements. Assumptions: one AMD Ryzen AI Max "Strix Halo" machine (the owner's first hardware, decision 7); 1,000,000 mixed items averaging about 1,500 tokens of text after parsing (1.5 billion tokens); 600-token chunks (about 2.5 million chunks); `Qwen3-30B-A3B` at 4-bit for extraction, which LightRAG names as the local minimum. Published llama.cpp figures for that model on Strix Halo are about 600 to 750 tokens per second for prompt processing and about 60 to 66 tokens per second for single-stream generation, with wide spread between builds and backends (MEDIUM). I assume prompt-prefix caching of the fixed instructions and about 3x aggregate generation from parallel slots (inference).

| Method | Main work per million documents | Rough wall-clock on one Strix Halo | Electricity (about 140 W) | Notes |
|---|---|---|---|---|
| Embeddings only (`Qwen3-Embedding-0.6B`) | 1.5B tokens through a 0.6B model | Days (assumed 2,000 to 8,000 tokens/s: about 2 to 9 days) | Small | Needed in every design |
| Tier 0 (embeddings + GLiNER-class tags + noun phrases) | As above plus a 0.2B tagger and CPU NLP | About 1 to 3 weeks | Small | LazyGraphRAG-class index |
| LightRAG-style LLM extraction | About 1.5B new prompt tokens and about 1.25B output tokens | About 3 months (about 27 days prompt, about 70 days generation), plus 20 to 30% for description merging | About 300 to 400 kWh | Output tokens dominate |
| HippoRAG 2 OpenIE | Similar prompt load, shorter outputs | About 2 to 3 months | Similar | Studies disagree on its wall-clock |
| Full GraphRAG | LightRAG-class extraction plus multi-level community reports, rebuilt as data changes | About 4 to 6 months | Higher | One 2026 paper estimates about USD 10,000 for 100k documents at cloud API prices (MEDIUM, single source) |

Conclusion: on our target hardware the cost of LLM extraction is time, not money. A full LLM pass over a million documents is a quarter of a year on one box, and new data keeps arriving. That is why the design runs LLM extraction only where it pays (contracts, reports, intelligence sources, items people actually open or ask about), queues it under the background spend governor from the paused Phase 18, and pools machines or bursts to NEAR AI TEE models only where the label's routing tier allows (decision 11 and milestone L5).

### 1.3 Entity resolution across sources

The problem: the same customer appears as a row in a spreadsheet, a signature in an email and a party in a contract. Current practice (several 2024 to 2025 papers) is a pipeline of cheap normalization, blocking, then matching, then graph-level consistency, with a person for uncertain cases. Popular graph RAG systems (LightRAG, GraphRAG) dedupe only by exact name match, which a 2025 paper calls out as a main source of graph noise (MEDIUM).

Recommended pipeline:

1. **Deterministic keys** from structured fields: email address, domain, phone in E.164, company registry or tax number, account or customer id, IBAN. These links are high confidence and cheap.
2. **Normalization**: case, punctuation, legal suffixes ("Inc", "Ltd"), transliteration, nickname tables for people.
3. **Blocking**: embedding of the mention plus its context, and shared neighbours in the graph (the same email domain, the same contract), to produce small candidate groups.
4. **Matching**: for structured records, a Fellegi-Sunter probabilistic model (Splink); for text mentions, a local LLM that judges a whole candidate group at once (group-wise matching cuts calls several-fold compared with pairwise in the LLM-CER results, MEDIUM).
5. **Review**: links below a threshold become proposals in the panel with evidence and one-action accept or undo (the paused INTAKE-05 behaviour).
6. **Label of a link**: the fact "A and B are the same customer" is derived from both items, so the link row carries the join (most restrictive combination) of both labels. A reader who sees only one side never learns the other exists.

| Tool | Fit | Licence | Note |
|---|---|---|---|
| **Splink** | Structured and semi-structured records; runs on DuckDB; claims a million records on a laptop in about a minute | MIT (MEDIUM); one wrapper notes a GPL-2.0 `python-igraph` dependency, to verify | **Use** as a Python worker in the appliance for tabular sources |
| **dedupe** (Python) | Active-learning record linkage | MIT | Alternative to Splink |
| **Zingg** | ML entity resolution on Spark | AGPL-3.0 (MEDIUM) | **Avoid** (copyleft over a network service; Spark is heavy) |
| **Senzing** | Commercial entity resolution engine | Proprietary; free evaluation capped at about 100k to 250k records (sources differ) | **Avoid** as a default |
| **LLM group judge** (our code) | Text mentions after blocking | Ours | Runs through the gate, so labels decide local versus attested cloud |

### 1.4 Keeping provenance to the source item

Every derived row keeps a pointer to the exact source and span. Proposed minimum shape (names illustrative):

| Table | Key columns | Purpose |
|---|---|---|
| `item` | `item_id`, `source_id`, `source_uri`, `content_hash`, `label_id`, `occurred_at`, `reported_at`, `recorded_at` | One ingested thing; its label comes from classification |
| `chunk` | `chunk_id`, `item_id`, `char_start`, `char_end`, `label_id`, `embedding`, `tsv` | Search unit; label inherited from the item (or narrower) |
| `mention` | `mention_id`, `item_id`, `char_start`, `char_end`, `surface`, `type`, `extractor`, `confidence`, `label_id` | One appearance of an entity in one item |
| `entity` | `entity_id` only | An opaque cluster id; no name or attributes stored here |
| `mention_entity` | `mention_id`, `entity_id`, `method`, `evidence`, `label_id` | Resolution decision (deterministic, Splink, LLM, person) |
| `relation_evidence` | `evidence_id`, `subject_mention`, `object_mention`, `predicate`, `quote_start`, `quote_end`, `extractor`, `label_id`, `valid_from`, `valid_to` | One supported claim of a relationship, with the verified quote |
| `entity_link` | `a`, `b`, `method`, `evidence`, `label_id`, `state` (proposed, accepted, undone) | Cross-source identity, reversible |

Rules that keep provenance honest: a relationship without a verified quote span is rejected into quarantine (paused Phase 15 rule); the extractor and model id are stored so a bad model's output can be withdrawn in bulk; erasing an item (crypto-shredding, paused PQC-02) cascades to its chunks, mentions and evidence, and every entity and edge recomputes without them.

---

## 2. Graph and vector storage

### 2.1 Graph stores

| Store | Licence (verified) | Runs embedded or on one host | Label enforcement inside traversal | Status | Verdict |
|---|---|---|---|---|---|
| **Neo4j Community** | GPLv3; Enterprise under a commercial licence (HIGH) | One host (JVM server) | Role-based and sub-graph access control are **Enterprise only**; Community has none (HIGH) | Active | **Not suitable**: we could not enforce labels inside the database without buying Enterprise |
| **Memgraph** | Community under Business Source License 1.1 (not open source); Enterprise under its own licence (HIGH) | One host | Label-based access control is **Enterprise only**; Enterprise from about USD 25,000 a year (MEDIUM) | Active | **Not suitable** for the same reason, plus BSL |
| **Apache AGE** (Postgres extension) | Apache-2.0 | Inside Postgres on one host | Postgres RLS on label tables; PR #2309 (merged 2026-01-20) enforces RLS for Cypher reads and for CREATE, SET, MERGE and DELETE in the executor; a crash under forced RLS was fixed in PR #2475 (HIGH) | Active: 1.7.0.x supports Postgres 17 and 18 (EDB notes, March 2026), master is on Postgres 18 | **Optional** add-on for Cypher; RLS support is young, so test it hard |
| **Kùzu** | MIT | Embedded | None built in | **Archived 2025-10-10**, last release 0.11.3 (HIGH); secondary sources say Apple acquired the company (LOW) | **Do not use** |
| **LadybugDB** (Kùzu fork) | MIT (MEDIUM) | Embedded; Node.js and WASM bindings | None built in | Community fork, 0.17.x in mid 2026 (MEDIUM) | **Watch** for an offline single-user mode only |
| **RyuGraph** (Kùzu fork) | MIT (MEDIUM) | Embedded | None | Company-backed fork (MEDIUM) | Watch |
| **FalkorDB** | SSPLv1 for the core; FalkorDBLite's own package says BSD while bundling the SSPL module (HIGH for core) | Redis module server; "Lite" embedded runtime | No per-label security found | Active | **Avoid** (SSPL is not open source and reaches into services we ship) |
| **Postgres SQL/PGQ** (`GRAPH_TABLE`) | PostgreSQL licence | In core | Would be ideal: graph queries act like security-invoker views over the base tables | **Reverted from Postgres 19 on 2026-09-07** (47 commits, "design issues too late to address"); Postgres 19 GA is scheduled for 2026-11-19 without it (HIGH) | **Revisit for Postgres 20** |
| **Plain Postgres tables + recursive CTEs** | PostgreSQL licence | One host | Full RLS on every table, the same as all other data | Mature | **Recommended default** (LightRAG ships the same idea as `PGTableGraphStorage`) |
| **DuckPGQ** (DuckDB extension) | MIT | Embedded | None | Research-grade; not available for the newest DuckDB (HIGH) | Analytics experiments only |

Why plain tables win for us: our graph questions are mostly one to three hops from a seed entity ("everything about this customer", "who links these two"), which recursive CTEs and indexed joins handle well at millions of rows, and it keeps one enforcement mechanism for everything. Use AGE only if Cypher authoring becomes a real need, and keep graph algorithms that need the whole graph (PageRank, community detection) in a worker that reads through the same label-filtered path.

### 2.2 Vector stores and hybrid search

| Store | Licence | Embedded or host | Keyword (BM25) | Filtering behaviour | Verdict |
|---|---|---|---|---|---|
| **pgvector** | PostgreSQL licence | Inside Postgres | Pair with Postgres full-text search, or **pg_textsearch** (BM25, Postgres licence, v1.0 GA 2026-04, HIGH) | Approximate indexes filter *after* the scan, so selective filters return too few rows; 0.8 added iterative index scans (`hnsw.iterative_scan`, capped by `hnsw.max_scan_tuples`, default 20,000) (HIGH). RLS applies to vector rows like any rows (EDB) | **Recommended** on the host |
| **ParadeDB pg_search** | AGPL-3.0 or commercial (HIGH) | Inside Postgres | BM25 (Tantivy) | As Postgres | **Avoid** (AGPL); use pg_textsearch |
| **LanceDB** | Apache-2.0 | Embedded; Node.js package | BM25 full-text index; hybrid with reciprocal rank fusion by default; true prefilter supported (HIGH) | Prefilter applied to both halves of a hybrid query | **Recommended for an offline single-user mode** if one is needed |
| **Qdrant** | Apache-2.0 | Server on one host; **Qdrant Edge** runs in-process (Rust crate 0.6.x, Python 0.3.x; started as a private beta in July 2025) | Sparse vectors (BM25-like) | Filterable HNSW builds extra links per indexed payload value; tenant index with `is_tenant: true`; indexes must exist before ingestion (HIGH) | Good second choice if vector scale outgrows pgvector; a second store means a second enforcement point |
| **sqlite-vec** | MIT/Apache-2.0 | Embedded | SQLite FTS5 | Metadata columns and up to 4 partition keys; stable 0.1.6, 0.1.10 still alpha (MEDIUM) | Small offline caches only |

Sizing note (inference): 2.5 million chunks at 1,024 dimensions is about 10 GB as float32, about 5 GB as `halfvec`, plus HNSW overhead, which fits a 128 GB unified-memory machine that also runs a model. At ten times the chunks, use `halfvec` or binary quantization with reranking, or a shorter embedding size if the embedding model supports it (Qwen3-Embedding reportedly supports user-chosen dimensions; verify in phase research). pgvector HNSW and IVFFlat index at most 2,000 dimensions for `vector` and 4,000 for `halfvec` (MEDIUM).

Hybrid query recipe (sketch, runs under RLS so every arm is already filtered):

```sql
WITH kw AS (
  SELECT chunk_id, row_number() OVER (ORDER BY bm25_score DESC) AS r
  FROM chunk_bm25_search($query) LIMIT 100),
vec AS (
  SELECT chunk_id, row_number() OVER (ORDER BY embedding <=> $qvec) AS r
  FROM chunk ORDER BY embedding <=> $qvec LIMIT 100)
SELECT chunk_id, sum(1.0 / (60 + r)) AS rrf
FROM (SELECT * FROM kw UNION ALL SELECT * FROM vec) u
GROUP BY chunk_id ORDER BY rrf DESC LIMIT 40;   -- then rerank the top 40
```

### 2.3 Enforcing labels and clearances inside traversal and vector search

The goal is that results never include, count, hint at or summarize anything the person may not see. The paused plan already states the test: a reader with only compartment A sees exactly what they would see in a base that never had B (ORG-01). That test now covers search, graph, dashboards and answers.

**Rules:**

1. **Every row carries a label**, including derived rows (chunks, mentions, evidence, links, cached summaries, insight records). A derived row's label is the join of its inputs' labels (most restrictive level, union of compartments, intersection of releasability, union of handling). This is Palantir's "markings propagate through derivation" and our session high-water mark applied to data.
2. **Entities and edges have no stored attributes.** An entity's name, type, attributes and degree are aggregated at query time from visible mentions; an edge exists for a reader only if at least one supporting evidence row is visible, and its strength is computed from visible evidence only. A merged "golden record" stored as one row would leak the restricted half.
3. **One policy, everywhere.** `CREATE POLICY ... USING (label_dominates(app_clearance(), label_id))` on every table, with `FORCE ROW LEVEL SECURITY`. The clearance comes from the gate. Do not let SQL text set it: if the clearance lives in a plain `SET app.clearance`, any SQL that runs in that session (including model-written SQL) can raise it. Set it through a `SECURITY DEFINER` function that verifies a short-lived token signed by the gate, and run model-written SQL only after parsing it to a SELECT over allowed views.
4. **Filter inside the index scan, not after.** With RLS the label predicate joins the vector query, so turn on pgvector iterative scans and test recall at low clearance. For very selective clearances, partition or partially index by label cell (the Qdrant tenant pattern applied to labels).
5. **No precomputed cross-label summaries.** GraphRAG-style community reports, entity descriptions, "top entities" lists and autocomplete dictionaries are built per label cell or computed per query. Any cache (answers, embeddings of questions, prompt caches on a shared model server) is keyed by the clearance that produced it.
6. **No side channels to people or agents.** No direct database connections, no `EXPLAIN` output, no planner statistics, no total-hit counts computed before filtering, no "N results hidden", no timing-sensitive error paths. Facet counts and dashboard totals are computed under RLS.
7. **Labels on answers.** The answer to a question carries the session high-water label of everything the agent read, and the gate routes the generation step by `handling` (local only, attested TEE, any cloud).
8. **Crypto below, RLS above.** A device that stores data locally (edge, laptop) receives only label cells it holds keys for; there RLS adds nothing, because the bytes are not present. A shared host decrypts for many people, so RLS is the control there. Both are needed.

Known pitfalls of Postgres RLS to design around (standard Postgres behaviour, HIGH): table owners and superusers bypass RLS unless forced; views run with their owner's rights unless created with `security_invoker`; functions not marked `LEAKPROOF` in user predicates can be evaluated in ways that reveal rows through errors; RLS adds cost to every query, so the dominance check must be a cheap indexed lookup (precompute each label's bitset of compartments and its level).

---

## 3. Analytics and reporting

### 3.1 Tools compared

| Tool | Licence | What it gives | Embedding and security | Fit |
|---|---|---|---|---|
| **Apache Superset** | Apache-2.0 | Full BI: SQL Lab, charts, dashboards | Embedded SDK in a sandboxed iframe with backend-minted guest tokens carrying RLS clauses (`EMBEDDED_SUPERSET` flag; default JWT secret must be changed) (HIGH). A Superset 6.0 user reports session bleed between an admin session and guest tokens in the same browser (LOW) | Heavy (Python, Redis, metadata DB). Its RLS is a second, clause-based enforcement point. **Optional appliance add-on** for analysts, connected through the same Postgres RLS, never the default surface |
| **Metabase** | AGPL for the open-source edition | Friendly query builder | Open source offers only static ("guest") embedding with a "Powered by Metabase" badge; interactive embedding and row-level sandboxing need paid plans (MEDIUM) | **Avoid** |
| **Evidence Core** | MIT (HIGH) | Reports as SQL plus Markdown, built to a static site; DuckDB in the browser | The commercial product is Evidence Studio; Core is the open framework | Good model for **generated reports**, but its build step and browser DuckDB would see unfiltered data unless we feed it filtered results |
| **Observable Framework** | ISC | Data apps | Team says it lacks bandwidth for both and is focusing on Notebooks 2.0 (MEDIUM) | **Avoid** for new work |
| **DuckDB + Mosaic (vgplot)** | DuckDB MIT; Mosaic open source from the UW Interactive Data Lab (licence to verify) | Linked, cross-filtered charts over millions of rows; queries can go to a server DuckDB rather than in-browser WASM | We control every query, so results are label-filtered on the host | **Recommended** for automatic dashboards |
| **Perspective** | Apache-2.0 | WASM pivot table and charts for large and streaming data | Runs fully inside the webview on data we send | **Recommended** for the "explore a table" view |

DuckDB's place: as an in-process analytics engine in the host's query service, reading label-filtered extracts from Postgres (through a role that is subject to RLS) or Parquet snapshots written per label cell. It is not a second store of record.

### 3.2 Natural language to SQL with local models

- Best published open model results on the BIRD benchmark are about 70 to 72% execution accuracy (Arctic-Text2SQL-R1 7B, 14B and 32B, May 2025 snapshot, HIGH). So roughly one answer in three or four can be wrong on hard schemas.
- Vanna, the best-known open-source library, was **archived on 2026-03-29** (HIGH). WrenAI's core is Apache-2.0 with a semantic layer (MDL) and Ollama support, but it is a separate multi-service stack, and its licence file reserves AGPL for future modules (MEDIUM).
- Recommendation: build a small tool in our TypeScript engine, not a dependency. The model writes SQL only against a curated semantic catalog of views (with business names, metrics and join paths), the host parses it, allows only SELECT over those views with a row limit and timeout, runs it under the reader's RLS, and shows the SQL and the result together with an "explain this query" option. Accuracy can be wrong; access cannot widen, because enforcement never depends on the generated SQL.
- Use the same path for agents: an agent tool `query_data` that returns the rows and the SQL, fenced as untrusted content when fed back into a prompt (the paused INTAKE-04 rule).

### 3.3 Showing analytics in a VS Code webview or from the host

- **Default:** render in our own webview (and later as a Theia widget) with Mosaic or Perspective bundled in the extension, a strict CSP with no network, and data arriving as capped, host-built results over the message bridge. This is the paused Phase 15 panel rule, and it works the same in VS Code, code-server and Theia.
- **Embedding a host-served BI app** (Superset) means adding its origin to `frame-src` and `connect-src`, and mapping localhost through `asExternalUri` in remote and code-server setups, which some users report maps to unexpected ports and cannot forward websockets (MEDIUM). It weakens the panel's no-network rule and adds a token flow. Offer it only as an "open in browser" link from the appliance, not inside the panel.
- **Reports** (the paused `ReportBuilder` and `ReportVerifier`) render from the store, carry the report's high-water label, and fail verification if any figure or grade differs from the store at generation time. Exports carry the label.

---

## 4. Mapping onto the paused v0.5.0 plan (Phases 13 to 24)

Disposition key: **Carries** (keep as planned), **Changes** (keep the intent, change the design), **Superseded** (the data platform or v0.7.0 and later milestones replace it).

| Phase | Paused scope | Disposition | What changes and why |
|---|---|---|---|
| **13** Sovereignty gate, post-quantum crypto, encrypted log | `TeeGatedClient`, KB mode, hybrid Ed25519 + ML-DSA-65 signatures and ML-KEM-768 + X25519 key wrap (vendored noble bundle), signed sealed segments, reference fold (current, history, as known and as happened at T), per-item keys and crypto-shredding, plaintext redaction, canary scan, network spy | **Carries, with changes** | Carries: PQ primitives, segment signing, verification tamper matrix, fold with four timestamps, crypto-shredding, canary and network-spy harnesses (all valuable for the platform's audit and erasure). Changes: (a) the per-project "TEE or local only" mode is replaced by per-label routing tiers decided by the v0.7.0 gate (decision 11); (b) the KB identity vault (24-word phrase) is replaced by the v0.7.0 device identity (`did:key`, Phase 69) and credentials (Phase 71); (c) the envelope's single compartment string `c` cannot express a lattice label (level, compartment set, releasability, handling), so the envelope needs a version 2 or `c` must become a key-domain id with the label in the body (undo cost: high once data exists); (d) the item-key vault is one file capped at 64 MiB and rewritten atomically, which cannot hold per-item keys for millions of items; it needs a sharded key store. (e) The log becomes the record of governance events (labels, reclassifications, links, grades, erasures, grants) and content-addressed encrypted snapshots, while the query store is a disposable materialization rebuilt from it |
| **14** Encrypted scalable store and search | Several-million-entry disk-backed encrypted index, `sql.js` per partition bake-off, quarantine instead of empty base, semantic search via the gate | **Superseded** by the data platform store | The store becomes Postgres + pgvector + BM25 on the host. Carries: benchmark-first with recorded budgets, "damaged data is reported, never replaced by an empty base", embeddings only through the gate. Changes: the client-side "no plaintext index on disk" guarantee cannot hold in the same form for a server database (Postgres has no community transparent data encryption), so it becomes full-disk encryption on the host plus per-item keys for erasable content; this is an owner decision (open question 2) |
| **15** Source and claim intake with agent tools | One intake pipeline, quote-verified claims, untrusted on read, CSV, STIX, GeoJSON importers, proposed duplicate links with undo, offline gazetteer, KB panel shell | **Changes** | Ingestion and discovery replace hand-run intake (files 01 and 02). Carries unchanged: untrusted-on-read fencing, quote-verified relation evidence, proposed links with undo (now the entity resolution review queue), importers, GeoNames gazetteer, and the panel shell rules (strict CSP, capped DTOs), which become the platform's UI shell |
| **16** Admiralty grading, thresholds, reports | Agent-proposed A-F / 1-6 grades with evidence diffs, echo and contradiction detection, thresholds, verified reports | **Carries** as an optional trust layer | Required for intelligence and OSINT projects; for enterprise data it generalizes to source reliability and data-quality scores. `ReportBuilder` and `ReportVerifier` carry into all reporting. Exports carry labels instead of compartment names |
| **17** RAFT network and slices | Actors, relationships, functions, tensions; Cytoscape or Sigma diagram; saved slices; slice-scoped agent runs | **Changes** | RAFT becomes one ontology profile and view over the context graph. Slices become saved scopes (by source, label, entity, time, place); slice-scoped runs carry and match "delegation only narrows" (decision 12). Renderer research carries to the graph explorer |
| **18** Standing feeds, unattended work, alerts | RSS, MCP, folder feeds; background spend governor; tripwires | **Superseded in part** | Feeds are absorbed by continuous connectors. The spend governor carries and matters more (Tier 1 extraction runs for months). Tripwires generalize into suggested insights and alerts |
| **19** Team sharing through git or a shared folder | Signed E2E sync, invites by key, rotation on removal, conflicts side by side | **Superseded** by L2 (Team Mode with payloads encrypted to member device keys) and L5 (federation) | Rollback, fork and withholding detection and "conflicts shown, never silently resolved" carry as design inputs |
| **20** Compartments, roles, access | Per-compartment keys, roles, Access view, reader-relative derived data, indistinguishability test | **Changes** (core of the platform) | Compartments map to label compartments; roles come from v0.7.0 credentials; the Access view becomes label and clearance administration. The reader-relative rule and the two-compartment indistinguishability test carry unchanged and extend to every view in this file. Group key management carries for what goes to edge devices; key-per-cell must handle label combinations (open question 6) |
| **21** Ciphertext relay | Org-hosted relay that sees only ciphertext | **Superseded** by the v0.7.0 relay (Phase 68) and L5 federation, which cites this design | Malicious-relay harness and metadata threat model carry |
| **22** Globe, imagery, timeline replay | MapLibre globe, layers per source, as known and as happened replay | **Carries** as views | Any geocoded item and any time-stamped item. "As known at T" is valuable beyond intelligence (audit: what did we know, when) |
| **23** Forecasting and calibration | Bayesian, Hawkes, calibration, ACH | **Carries, deferred** | Intelligence projects only; enterprise "suggested insights" start with simpler anomaly and change detection |
| **24** End-to-end hardening and release | Allowlist sweep, canary scan everywhere, scale and accessibility checks, honest copy | **Carries** | Extend the canary scan to the database, caches and model-server logs, and the indistinguishability test to dashboards and answers |

**Phase 13 code on the local branch** (named in the paused README; read with `git show`, not checked out): `src/kb/crypto/` (canonical JSON, hybrid signatures, X-Wing key wrap, at-rest sealing, identity), `src/kb/log/` (envelope v1, segments, genesis, HLC, keyring, fold, item keys, verification), `src/kb/redact.ts`, `src/services/teeGatedClient.ts`, `src/domain/destinations.ts` and the test helpers `canaryScan`, `networkSpy` and `fakeNearServer`, with 0.4.4 merged and 0.4.5 not. The fold's four timestamps and erasure semantics (a tombstone is retroactive, the item keeps its skeleton) are exactly what the platform's audit log needs. Two limits found by reading it: envelope v1 has `c: string` (one compartment) and item kinds limited to `claim`, `source` and `attachment`; the item-key vault caps at 64 MiB in a single file.

---

## 5. "Magic" interaction: what people see with no setup

### 5.1 How comparable products do it

| Product | Pattern | Lesson for us |
|---|---|---|
| **Glean** | Connectors crawl content, permissions and activity; an Enterprise Graph of people, projects and entities plus a personal graph per employee (announced 2025-09-25); permissions synced from sources and checked at query time (MEDIUM, vendor pages) | Entity pages and "people who know about this" come for free once mentions and activity exist. Permission checks at query time are table stakes |
| **Microsoft 365 Copilot** | Grounds answers in a permission-trimmed semantic index over Graph; oversharing became the main deployment problem, answered with Restricted Content Discovery (blocks a whole site from Copilot regardless of permissions), sensitivity labels and DLP (MEDIUM) | Permission-trimmed retrieval surfaces everything that was already overshared. Classify on ingest, default unclassified items to restrictive, and show oversharing as an insight |
| **Microsoft Purview Data Map** | Automatic scanning and classification (sampling for databases) feeding Data Estate Insights: where sensitive data is, how it moves (MEDIUM) | "What data you have and where" is a dashboard generated from ingestion metadata, not from content |
| **Palantir Foundry** | Markings are mandatory controls that propagate through derivation and are checked at each access; lineage shows the impact of removing a marking (HIGH, official docs) | Same as our derived-row label rule; add a "what changes if this label changes" preview (the paused downgrade-impact view) |
| **Tableau Pulse, ThoughtSpot Spotter** | Metrics with automatically detected insights and summaries | Insights must be metric-based and explainable, with the query behind each |
| **Onyx** (open source enterprise search) | MIT core with connectors; permission sync is an Enterprise Edition feature (MEDIUM) | Confirms permission-aware retrieval is the hard, valuable part |

### 5.2 What our users see on day one

1. **Your data estate** (automatic): sources found, items by type, size, label and owner, freshness, and the ingestion state of each source (discovered, fetching, parsed, classified, indexed, graphed, quarantined, failed) with the reason for any stuck state. All counts computed under the viewer's clearance.
2. **One search box**: hybrid search with facets (source, type, label, time, person, organization, place), each result showing its source, label badge and the matching span; open the item, its entity mentions, or the graph around it.
3. **Entity pages**: automatically for frequent people, organizations, customers, projects and places: every mention across sources, related entities, a timeline, and proposed links to confirm or undo.
4. **Ask anything within your clearance**: an agent with tools for search, graph neighbourhood, SQL over views and timeline. Every sentence cites items; the answer carries its label; the model used is chosen by the label's routing tier.
5. **Suggested insights** (explainable, each with the query or evidence behind it): new or fast-growing entities, unusual volume, new connections between entities, contradictions and echoes (paused grading features), stale or orphaned data, possible oversharing (sensitive content in a widely shared location), and items still unclassified.
6. **Graph, map and timeline** views from the paused plan, opened from any search result or entity page, never a whole-graph hairball (the paused slice cap with a truncation notice carries).

What users must not see: any hint that something hidden exists (no "results hidden", no counts that differ from a base without it). This trades away "request access" flows unless the owner decides otherwise (open question 3).

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Leakage through derived artifacts**: merged entity records, summaries, embeddings, autocomplete, facet counts, graph degree, cached answers, shared prompt caches on a model server | High | Labels on every derived row, reader-relative aggregation, caches keyed by clearance, the indistinguishability test over every view (paused ORG-01) |
| **Clearance spoofing from model-written SQL** (a session variable that SQL can change) | High | Clearance set only through a verifying security-definer function; parse and allowlist model SQL |
| **Mislabelled data at ingestion** makes every downstream answer wrong or leaky (the Copilot oversharing lesson) | High | Unclassified items default to the most restrictive cell until classified; reclassification recomputes derived rows; label-change impact preview |
| **LLM extraction takes months** at a million documents on one machine | High for expectations | Tiered and lazy extraction, priority queue, spend governor, pooling (L5) and attested burst only where labels allow; say so in product copy |
| **Graph quality**: hallucinated relations and false entity merges | Medium | Quote-verified evidence only, reversible links, person review below a threshold, bulk withdrawal by extractor id |
| **Licences**: Neo4j Community (no security), Memgraph BSL, FalkorDB SSPL, Metabase AGPL, pg_search AGPL, Zingg AGPL | Medium | Stay on Postgres, pgvector, pg_textsearch, AGE, LanceDB, DuckDB, Mosaic, Perspective; check Splink's dependency tree |
| **Abandoned or frozen projects**: Kùzu archived, Vanna archived, GraphRAG in maintenance mode, nano-graphrag inactive, Observable Framework deprioritized, Postgres SQL/PGQ reverted | Medium | Borrow designs, own the small amount of code, avoid hard dependencies |
| **RLS recall and performance**: HNSW post-filtering returns too few rows for low clearances; policy cost on every query | Medium | Iterative scans, partitions or partial indexes per label cell, a benchmark at low clearance as a gate |
| **Two enforcement points** if Superset or another BI tool is added | Medium | BI connects through the same Postgres RLS, never its own row rules alone; keep it optional |
| **Server-side plaintext** on the appliance weakens the paused "no plaintext on disk" promise | Medium | Disk encryption, per-item keys for erasable content, honest copy; owner decision |
| **Python workers** (GLiNER, Splink, NLP) in a TypeScript, low-dependency product | Low to medium | Run them as sandboxed, pinned containers in the appliance behind the gate; keep the engine free of them |
| **NL-to-SQL accuracy** about 70% on hard schemas | Medium | Curated views, SQL shown with every result, "confidence" never presented as fact |

## Open questions for the owner

1. **Source of truth**: does the signed, encrypted log hold all ingested content, or only governance events plus content-addressed encrypted snapshots, with source systems remaining the system of record? (This file recommends the second.)
2. **Plaintext on the host**: is a server-side index in plaintext inside Postgres on an encrypted disk acceptable for the appliance, given that the paused plan promised no plaintext on disk anywhere?
3. **Hidden results**: should people ever learn that something exists that they cannot see (for example to request access), or is strict indistinguishability the rule everywhere?
4. **First views**: which ship first: estate map, search, entity pages and ask (recommended), before the graph, globe, grading and forecasts?
5. **Grading scope**: Admiralty grading on every source, or only in intelligence projects?
6. **Keys for label combinations**: items labelled with several compartments need "must hold all of them" encryption (for example an item key wrapped under a key derived from every required compartment key). This belongs to the crypto and sync research.
7. **Python in the appliance**: acceptable as pinned, sandboxed worker containers for extraction and entity resolution?
8. **Superset**: offer it as an optional appliance add-on for analysts, or not at all?

## Sources

Confidence: HIGH means an official project page, documentation, commit list or release note was read; MEDIUM means several secondary sources agreed, or one primary source was read only through a summary; LOW means a single secondary source.

Context graph construction
- Microsoft GraphRAG repository (MIT, maintenance mode, indexing cost warning), HIGH: https://github.com/microsoft/graphrag
- LazyGraphRAG, Microsoft Research blog, 2024-11-25, HIGH: https://www.microsoft.com/en-us/research/blog/lazygraphrag/
- LightRAG repository (MIT, backends, local model guidance), HIGH: https://github.com/HKUDS/LightRAG
- HippoRAG repository (MIT, local vLLM), HIGH: https://github.com/OSU-NLP-Group/HippoRAG
- HippoRAG 2 paper, "From RAG to Memory", MEDIUM: https://arxiv.org/abs/2502.14802
- "When to use Graphs in RAG" (GraphRAG-Bench), ICLR 2026, MEDIUM: https://arxiv.org/abs/2506.05690
- GraphRAG-Bench (domain-specific reasoning), MEDIUM: https://arxiv.org/abs/2506.02404
- RAGU paper (GraphRAG cost estimates), LOW: https://arxiv.org/pdf/2607.11683
- nano-graphrag activity, MEDIUM: https://github.com/gusye1234/nano-graphrag and https://www.beamforai.com/tools/gusye1234/nano-graphrag
- Graphiti, MEDIUM: https://github.com/getzep/graphiti and https://arxiv.org/abs/2501.13956
- Neo4j LLM Knowledge Graph Builder, MEDIUM: https://github.com/neo4j-labs/llm-graph-builder
- GLiNER2 paper and model card, MEDIUM: https://arxiv.org/abs/2507.18546 and https://huggingface.co/fastino/gliner2-large-v1
- Strix Halo llama.cpp throughput, MEDIUM: https://raw.githubusercontent.com/kyuz0/strixhalo-homelab/HEAD/AI/llamacpp-performance.md and https://forum.level1techs.com/t/strix-halo-ryzen-ai-max-395-llm-benchmark-results/233796

Entity resolution
- LLM entity matching ("Match, Compare, or Select?"), MEDIUM: https://arxiv.org/abs/2405.16884
- Knowledge graph denoising with entity resolution ("Less is More"), MEDIUM: https://arxiv.org/abs/2510.14271
- Splink, MEDIUM: https://pypi.org/project/splink/ and https://github.com/moj-analytical-services/splink
- Zingg licence, MEDIUM: https://github.com/zinggAI/zingg
- Senzing evaluation limits, LOW: https://senzing.com/build-or-buy-entity-resolution/

Graph and vector stores
- Neo4j licensing, HIGH: https://neo4j.com/licensing/ and https://neo4j.com/docs/operations-manual/current/authentication-authorization/
- Memgraph licences and enterprise features, HIGH: https://memgraph.com/legal and https://github.com/memgraph/memgraph
- Apache AGE RLS support, PR #2309, HIGH: https://github.com/apache/age/pull/2309
- Apache AGE 1.7.0.1 release notes (Postgres 17 and 18), HIGH: https://www.enterprisedb.com/docs/pg_extensions/apache_age/rel_notes/apache_age_1.7.0.1_rel_notes/
- Kùzu archived; forks, MEDIUM: https://oneuptime.com/blog/post/2026-08-12-kuzu-archived-pin-0-11-3-fork-or-migrate/view and https://ladybugdb-web.pages.dev/ and https://github.com/predictable-labs/ryugraph
- FalkorDB licence, HIGH: https://docs.falkordb.com/references/license
- Postgres SQL/PGQ revert, HIGH: https://www.commandprompt.com/blog/two-features-just-left-postgresql-19/ and https://www.postgresql.org/message-id/E1x3f62-00000003sxD-0vdk@gemulon.postgresql.org
- Postgres 19 release timing, HIGH: https://www.postgresql.org/about/news/postgresql-19-rc-1-released-3409/
- DuckPGQ status, HIGH: https://duckdb.org/community_extensions/extensions/duckpgq
- pgvector 0.8 iterative scans and filtering, HIGH: https://www.postgresql.org/about/news/pgvector-0.8.0-released-2952/ and https://docs.pgedge.com/pgvector/v0-8-5/iterative-index-scans/
- RLS with pgvector (EDB), MEDIUM: https://www.enterprisedb.com/docs/pg_extensions/pgvector/security/
- pg_textsearch v1.0 (Postgres licence), HIGH: https://www.postgresql.org/about/news/pg_textsearch-v10-3264
- ParadeDB pg_search licence, HIGH: https://pgxn.org/dist/pg_search/
- LanceDB hybrid and full-text search, HIGH: https://docs.lancedb.com/search/hybrid-search/ and https://lancedb.com/docs/search/full-text-search
- Qdrant filtering and multitenancy, HIGH: https://qdrant.tech/documentation/search-design/vector-search-filtering/ and https://qdrant.tech/documentation/deploy-and-scale/multitenant-search/
- Qdrant Edge, MEDIUM: https://qdrant.tech/edge/ and https://docs.rs/crate/qdrant-edge/latest
- sqlite-vec metadata and partition keys, MEDIUM: https://github.com/asg017/sqlite-vec/releases
- PGlite and pgvector, LOW: https://github.com/electric-sql/pglite
- Permission-aware retrieval practice, LOW to MEDIUM: https://tianpan.co/blog/2026-04-17-vector-store-access-control-rag-rls and https://dev.to/venkathub/permission-aware-rag-enforcing-document-acls-at-retrieval-time-54a7

Analytics and reporting
- Superset embedded SDK and guest-token RLS, HIGH: https://apache.googlesource.com/superset/+show/HEAD/superset-embedded-sdk/README.md
- Superset 6.0 embedding discussion (session bleed report), LOW: https://go.mail-archive.com/notifications@superset.apache.org/msg252899.html
- Metabase embedding tiers, MEDIUM: https://metabase.com/docs/master/embedding/interactive-embedding
- Evidence Core and Studio, MEDIUM: https://evidence.dev/blog/evidence-core and https://docs.evidence.dev
- Observable direction, MEDIUM: https://talk.observablehq.com/t/where-is-observable-going/10372 and https://observablehq.com/notebook-kit/
- Mosaic, HIGH: https://idl.uw.edu/mosaic/what-is-mosaic and https://github.com/uwdata/mosaic
- Perspective, MEDIUM: https://github.com/finos/perspective
- Arctic-Text2SQL-R1 and BIRD results, HIGH: https://arxiv.org/abs/2505.20315 and https://www.snowflake.com/en/blog/engineering/arctic-text2sql-r1-sql-generation-benchmark/
- Vanna archived, MEDIUM: https://github.com/vanna-ai/vanna
- WrenAI, MEDIUM: https://github.com/Canner/WrenAI
- VS Code webview and asExternalUri limits, MEDIUM: https://github.com/coder/code-server/issues/6504 and https://github.com/microsoft/vscode/issues/194751

Comparable products
- Glean Enterprise Graph and personal graph, MEDIUM: https://www.glean.com/product/knowledge-graph and https://www.glean.com/enterprise-context/personal-graph and https://www.businesswire.com/news/home/20250925784461/en
- Microsoft 365 Copilot data protection and oversharing controls, MEDIUM: https://learn.microsoft.com/en-us/copilot/microsoft-365/microsoft-365-copilot-architecture-data-protection-auditing and https://techcommunity.microsoft.com/blog/microsoft365copilotblog/mitigate-oversharing-to-govern-microsoft-365-copilot-and-agents/4448744
- Microsoft Purview Data Estate Insights, MEDIUM: https://docs.azure.cn/en-us/purview/concept-insights
- Palantir Foundry markings and propagation, HIGH: https://palantir.com/docs/foundry/security/markings and https://palantir.com/docs/foundry/security/access-control-propagation/
- OpenMetadata auto-classification, MEDIUM: https://docs.open-metadata.org/latest/how-to-guides/data-governance/classification/auto-classification
- Tableau Pulse insights, MEDIUM: https://help.tableau.com/current/online/en-gb/pulse_insights_platform_insight_types.htm
- Onyx, MEDIUM: https://github.com/onyx-dot-app/onyx

Internal inputs (repository documents, read for this research)
- Paused v0.5.0 milestone: README, ROADMAP (Phases 13 to 24), REQUIREMENTS, research, and the owner's brief in `.planning/milestones/v0.5.0-paused/`
- Phase 13 code on the local branch named in that README (read with `git show`)
- Platform direction decisions 8 to 17 in `.planning/PROJECT.md` and `.planning/research/platform-direction/identity-research.md` (label and clearance model, routing tiers)
- Later milestones L1 to L6 in `.planning/ROADMAP.md`
