# Data platform research 01: discovery, connectors, extraction and ETL

**Researched:** 2026-11-18
**Scope:** how the on-premises data service finds an organization's data, pulls it in (first in full, then live), turns every format into text and structured records, stores it with a pointer back to the source and its permissions, and makes new sources easy to add.
**Overall confidence:** MEDIUM. Vendor API limits, licences and release data are HIGH (read from official docs and repository metadata on the research date). Throughput on the target GPU host is LOW (no direct benchmarks exist; numbers are extrapolated and need a spike).

---

## Summary

Build the ingestion layer the way a blockchain indexer is built: for every source, first run a resumable, throttled backfill of everything that exists, then keep up with a native change feed (Microsoft Graph delta, Google Drive changes, Gmail history, NTFS USN journal, macOS FSEvents, Linux fanotify, database CDC), with a durable cursor per source partition that advances only in the same database transaction that records the data. Treat deletions, moves, permission changes and label changes as "reorgs" that must flow through to every derived artifact, and run periodic reconciliation sweeps because every change feed in this list can silently drop events. Do not adopt a heavy connector platform as the core. Airbyte is the most complete catalog for our first sources, but every connector we need (SharePoint, OneDrive, Google Drive, Gmail, Outlook, Teams, Postgres, SQL Server, MySQL) is now under the Elastic License 2.0, which forbids offering it as a hosted or managed service and forbids exposing its UI or API in a product; that is a poor fit for an appliance we sell and may operate. The open source frameworks (dlt, Singer/Meltano, NiFi) are useful for structured sources but none of them covers the hard parts of M365 and Google Workspace (per-drive delta tokens, permission hierarchies, sensitivity labels, scoped mailbox access, Gmail history). So: write our own first-party connectors for M365, Google Workspace, endpoints and file shares against the vendor APIs, on a small connector contract modeled on the Singer/Airbyte message protocol (records plus state), use dlt for databases and REST sources, Debezium Server for database CDC, Apache Tika 4 plus Docling for extraction, a tiered OCR path that only sends hard pages to a local vision-language model, whisper.cpp for audio, and Postgres plus DuckLake (Parquet) for storage, with OpenLineage-shaped lineage records.

On the owner's question of whether to centralize data: the evidence (Glean, Elastic connectors, Microsoft Graph connectors, data catalogs) supports the lead's hybrid. Originals stay in place; the central layer holds extracted text, structure, embeddings and the graph, keyed to the source and inheriting its ACLs. I disagree on three points, set out in section 3: extracted text is still a copy of the content for legal and privacy purposes, a bounded re-extraction cache is worth having, and "immutable training snapshots" conflict with the right to erasure unless they are built to be rebuilt.

## Recommended stack

| Layer | Recommendation | Why |
|---|---|---|
| Connector contract | Our own small contract: a connector emits `RECORD`, `STATE`, `DELETE`, `ACL`, `LOG` messages, modeled on the Singer and Airbyte protocol (the Airbyte protocol repo is MIT) | Lets first-party, dlt-based and agent-written connectors share one runtime, one cursor store and one status model. No licence entanglement. |
| M365 connector (SharePoint, OneDrive, Exchange, Teams files) | First-party, built on Microsoft Graph SDK for Python (MIT) using per-drive `delta`, `Prefer: hierarchicalsharing` and `deltashowsharingchanges`, per-mailbox message delta, Exchange RBAC for Applications | Only way to get delta tokens, permission hierarchy and labels right within Microsoft's throttling budget. Onyx (MIT outside `ee/`) is a reference to read, not run. |
| Google Workspace connector | First-party, Drive API `changes` per user and per shared drive, Gmail `history.list`, service account with domain-wide delegation | Same reason; existing open connectors either lack permissions or are ELv2. |
| Endpoint collector | Small Rust agent: NTFS MFT enumeration plus USN journal on Windows, FSEvents with stored event IDs on macOS, fanotify (filesystem marks) with inotify fallback on Linux | Native journals give a cursor that survives restarts; plain watchers do not. |
| File shares (SMB/NFS) | Run the collector on the file server when possible (USN on Windows file servers, `zfs diff` on ZFS); otherwise SMB2 CHANGE_NOTIFY as a hint plus scheduled snapshot diffs | Remote shares have weak or no notifications. |
| Databases | dlt `sql_database` for backfill and cursor-column incremental; Debezium Server (Apache-2.0, runs without Kafka) for CDC on Postgres, MySQL, SQL Server | Mature, Apache-licensed, offline. |
| Extraction | Apache Tika 4.0 server (forked, crash-isolated parsers) for breadth including MSG and PST; Docling (MIT) for layout, tables, slides and complex PDFs | Tika covers the long tail safely; Docling gives better structure where it matters. |
| OCR | Tier 1: Tesseract or PP-OCRv5 on CPU for clean scans. Tier 2: local VLM (PaddleOCR-VL 0.9B, granite-docling-258M, or olmOCR-2-7B, all Apache-2.0) for hard pages | VLMs are far better on tables and handwriting but 10x to 50x slower; route by page difficulty. |
| Audio and video | whisper.cpp (MIT) with Vulkan or ROCm backend, large-v3-turbo by default | Runs on AMD; reported about 27x real time for turbo on Strix Halo. |
| Storage | Postgres (control plane: sources, cursors, item ledger, ACLs, lineage) plus DuckLake 1.0 (Postgres catalog, Parquet files) for analytical tables, plus a content-addressed blob store for derived artifacts | One host, SQL-native lakehouse, cheap small updates; Iceberg export kept as an option. |
| Dedup | BLAKE3 or SHA-256 content hash for exact duplicates; MinHash LSH (datasketch, MIT) on extracted text for near duplicates | Standard, cheap, explainable. |
| Lineage | OpenLineage event shapes stored in Postgres; Marquez (Apache-2.0) optional viewer | Open standard without running a separate service on day one. |

**Avoid as dependencies:** Airbyte connectors and platform (ELv2), Elastic connectors (ELv2), Nango (ELv2; free self-host is auth only), Marker and Chandra model weights (modified OpenRAIL-M, commercial limits), MinerU (Apache-2.0 plus extra terms: attribution for online services, licence above thresholds), extract-msg (GPL-3.0), Sling (GPL-3.0), Airweave (MIT but archived June 2026), MarkItDown's audio and image-caption extras (they call web-hosted services).

---

## 1. Ingestion model: backfill, then live tail (the indexer pattern)

The owner compares the first scan to blockchain indexing: accumulate the known history, then stay in sync. That framing fits well and the vendors' own guidance already says the same thing. Microsoft's scanning guidance for SharePoint and OneDrive is literally "Discover, Crawl, Notify, Process changes", with delta query as both the initial crawl and the change feed ([Microsoft scan guidance](https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts/scan-guidance)). Confidence: HIGH for the pattern, MEDIUM for the per-source details marked below.

### 1.1 Per-source backfill and live tail

| Source | Backfill (cursor to checkpoint) | Live tail (native change feed) | Stable item id (survives rename/move) | Gaps and how we notice |
|---|---|---|---|---|
| SharePoint and OneDrive | `GET /drives/{id}/root/delta` with no token pages through every item; checkpoint the `@odata.nextLink` | Same delta call with the saved `@odata.deltaLink` (1 resource unit with token). Webhook on the drive root (`updated` only, max lifetime 42,300 minutes, average latency under 1 minute, maximum 6 hours) is only a "come and look" hint | `driveItem.id` (plus `sharepointIds`) | Delta token can expire (HTTP 410 resync); Microsoft recommends a safety delta at most once a day even with webhooks |
| Site and drive discovery | `GET /sites` (app-only lists all site collections), `/sites/{id}/drives`, `/users/{id}/drive` | `/sites` webhook for new sites; sites delta is beta only | site id, drive id | New libraries appear without a drive-level event; re-enumerate daily |
| Exchange mail | Per mailbox, per folder `messages/delta`; checkpoint nextLink | Folder-level delta link; webhook lifetime max 10,080 minutes (1,440 with resource data) | message id is not stable across folder moves; use `immutableId` (`Prefer: IdType="ImmutableId"`) | Folder moves look like delete plus add unless immutable ids are used (MEDIUM: verify in spike) |
| Teams files | They live in the team's SharePoint site, so they arrive through the SharePoint drives | Same as SharePoint | driveItem id | None extra |
| Teams chat messages | Protected API; needs Microsoft approval form; channel `getAllMessages` was metered, and Microsoft says metering ended 25 Aug 2025 but some pages still describe payment models | chatMessage webhook max 3 days | message id | Defer to a later phase |
| Google Drive (My Drive per user) | `changes.getStartPageToken` first, then `files.list` for the full listing; checkpoint pageToken | `changes.list` from the saved token, oldest first; `newStartPageToken` when done; `changes.watch` channel (max about 7 days, not auto-renewed) as a hint | `fileId` | Notifications carry no details; channels must be recreated; poll as the source of truth |
| Google shared drives | Per shared drive listing with `driveId` | `changes.list` with `driveId` per shared drive | `fileId` | New shared drives need re-enumeration (`drives.list`) |
| Gmail | Read `historyId` from the profile first, then `messages.list` plus `messages.get` | `history.list` from the stored `historyId`; `watch` needs Cloud Pub/Sub and renewal at least every 7 days | message id | History kept "at least one week, often longer"; HTTP 404 means full resync |
| Windows endpoint (NTFS) | Enumerate the MFT (`FSCTL_ENUM_USN_DATA`), very fast, admin rights | USN change journal; store `(volume, journal id, next USN)` | NTFS file reference number | Journal id changes or records wrap: full MFT re-enumeration and diff |
| macOS endpoint | Directory walk (or Spotlight index as a hint) | FSEvents with `sinceWhen` = stored event id plus volume UUID; history replays then `HistoryDone` | inode plus volume UUID (FSEvents reports paths only, so stat on receipt) | `MustScanSubDirs` or `EventIdsWrapped` flags: rescan that subtree; needs Full Disk Access (deployed by MDM profile) |
| Linux endpoint | Directory walk | fanotify with filesystem marks and file handles (directory events since kernel 5.1); inotify fallback is per directory and not recursive | `(st_dev, inode)` or file handle | `FAN_Q_OVERFLOW` drops events; network filesystems are not reported |
| SMB share (remote) | Recursive listing; record `(path, file id, size, mtime, ACL hash)` | SMB2 CHANGE_NOTIFY with `WATCH_TREE` as a hint only | SMB file id where the server exposes it | `STATUS_NOTIFY_ENUM_DIR` means "too many changes, rescan"; notifications are lost on reconnect; scheduled snapshot diff is the real feed |
| NFS share | Recursive listing | None in practice (NFSv4.1 directory delegations are rarely deployed) | inode via NFS file handle | Snapshot diff only; on ZFS or NetApp use the storage system's own diff or audit feed |
| Postgres | dlt `sql_database` or Debezium initial snapshot | Logical replication slot (Debezium or dlt `pg_replication`); store LSN | primary key | An abandoned slot retains WAL and can fill the server disk: monitor and drop slots on disconnect |
| SQL Server | Snapshot | SQL Server CDC (needs SQL Server Agent, so not on Express edition) or Change Tracking | primary key | CDC cleanup job deletes old change rows (default 3 days): resnapshot if offline longer |
| MySQL | Snapshot | binlog (row format) via Debezium; store GTID or file and position | primary key | binlog retention: resnapshot on gap |

Sources: [driveItem delta](https://learn.microsoft.com/en-us/graph/api/driveitem-delta?view=graph-rest-1.0), [subscription lifetimes and latency](https://learn.microsoft.com/en-us/graph/api/resources/subscription?view=graph-rest-1.0), [Drive changes](https://developers.google.com/workspace/drive/api/guides/manage-changes), [Drive push](https://developers.google.com/workspace/drive/api/guides/push), [Gmail sync](https://developers.google.com/workspace/gmail/api/guides/sync), [Gmail push](https://developers.google.com/workspace/gmail/api/guides/push), [fanotify(7)](https://man7.org/linux/man-pages/man7/fanotify.7.html), [FSEvents guide](https://developer.apple.com/library/archive/documentation/Darwin/Conceptual/FSEvents_ProgGuide/UsingtheFSEventsFramework/UsingtheFSEventsFramework.html), [NTFS change journal](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-2000-server/bb742450(v=technet.10)), [MS-SMB2 change notify](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-smb2/), [Teams API licensing](https://learn.microsoft.com/en-us/graph/teams-licenses), [Debezium Server](https://debezium.io/documentation/reference/stable/operations/debezium-server.html).

### 1.2 The cursor rule that makes backfill and live tail safe together

**Capture the live cursor before the backfill starts, and run the tail from that point while the backfill is still running.** This is how Debezium does snapshots (record the log position, snapshot, then stream from that position) and what Microsoft recommends (call delta again right after subscribing). It matters most for Gmail: if a large mailbox's backfill takes longer than the history retention window (about a week), a `historyId` saved at the end of the backfill would leave a hole, and one saved at the start would already be expired. Running both together closes the gap; idempotent upserts (section 1.4) make the overlap harmless.

Per source partition (a drive, a mailbox, a Google user, a shared drive, a volume, a table) store:

```
source_cursor(
  source_id, partition_key,
  phase            -- discovering | backfilling | tailing | resyncing | paused | error
  backfill_cursor  -- nextLink / pageToken / MFT position / last primary key
  backfill_done, backfill_total_estimate,
  live_cursor      -- deltaLink / startPageToken / historyId / (journal id, USN) / (FSEvents id, volume UUID) / LSN / GTID
  live_cursor_taken_at,
  last_event_at, last_success_at, last_error, throttled_until,
  reconcile_due_at
)
```

Advance a cursor only in the same Postgres transaction that commits the batch it covers. Subsquid uses the same rule: processor state and data commit together, so a crash replays the last batch rather than skipping it ([Subsquid unfinalized blocks](https://docs.sqd.dev/sdk/resources/unfinalized-blocks/)).

### 1.3 "Reorgs": deletions, moves, renames, permission and label changes

In a blockchain a reorg rewrites recent history. In our sources the equivalent events are:

| Event | How each feed reports it | What must happen downstream |
|---|---|---|
| Delete | Graph delta `deleted` facet; Drive `removed: true` or `trashed`; Gmail `messagesDeleted`; USN `FILE_DELETE`; fanotify `FAN_DELETE`; FSEvents `ItemRemoved`; snapshot diff "id missing" | Immediately hide from search, graph and agents (ACL deny). Purge derived text, chunks, embeddings and graph edges after a grace period that matches the source's recycle bin (SharePoint and Drive allow restore), unless a legal hold flag is set. Mark any dataset version containing the item as "contains revoked items". |
| Restore from recycle bin | Reappears in delta or changes | Un-hide; reuse derivatives if the content hash is unchanged. |
| Move or rename | Same stable id, new parent or name | Update path and parent in place; do not re-extract (content hash unchanged). Re-evaluate inherited ACL because the new parent may grant different access. |
| Permission change | Graph: `Prefer: deltashowsharingchanges` annotates items whose sharing changed; `Prefer: hierarchicalsharing` returns sharing only at permission roots; security webhooks via `prefer:includesecuritywebhooks`. Drive: permission change shows as a file change. NTFS: USN reason `SECURITY_CHANGE`. Linux: `FAN_ATTRIB` | Recompute effective ACL for the subtree; propagate to every derived artifact before the next query is served. This is the most security-critical path. |
| Group membership change | Not in the content feed. Graph `users/delta` and `groups/delta`; Admin SDK for Google | Identity sync on its own, faster schedule (Glean runs "identity crawls" separately, from every 10 minutes to every 8 hours depending on source). |
| Sensitivity or classification label change | Graph `extractSensitivityLabels` on the item; Drive Labels on the file | Re-evaluate policy (some labels may forbid TEE inference or training use). |

The derivation graph makes this tractable: every artifact (text, chunk, embedding, graph edge, dataset row) records the `(source_id, item_id, version)` it came from. A reorg invalidates that node and everything downstream of it, the same way graph-node closes entity versions past a reverted block ([graph-node indexing notes](https://www.mintlify.com/graphprotocol/graph-node/core-concepts/indexing)) and the Substreams SQL sink replays a history table in reverse ([Substreams reorg handling](https://docs.substreams.dev/reference-material/sql/reorg-handling)).

### 1.4 Exactly-once effect

Feeds deliver at least once and sometimes out of order. Get an exactly-once *effect* with:

- **Identity key:** `(source_id, source_item_id)`.
- **Version key:** the source's own version marker (Graph `cTag` for content, `eTag` for metadata; Drive `version` or `md5Checksum`; Gmail `historyId`; file `(size, mtime, USN)`), plus our content hash after download.
- **Upsert rule:** apply only if the incoming version is newer than the stored one; a duplicate or older event is a no-op.
- **Derivative key:** `(content_hash, extractor_name, extractor_version, options_hash)`. The same attachment in 500 mailboxes is extracted once; upgrading the extractor re-runs only that key.
- **Download guard:** Graph's guidance is to use `cTag` to skip downloads whose content did not change.
- **External side effects** (webhooks to other systems, notifications) go through an outbox table written in the same transaction, never directly, because Subsquid's docs warn that rollback does not undo external effects.

### 1.5 Reconciliation sweeps

Every feed in section 1.1 can drop events (queue overflows, expired channels, missed webhooks, journal wraps, history expiry). Industry practice is the same everywhere: Microsoft recommends a daily safety delta; Glean schedules periodic full crawls that also remove stale content ([Glean crawling types](https://docs.glean.com/connectors/crawling-types), [Glean deletion](https://docs.glean.com/connectors/crawling-deletion)); Elastic connectors only remove deleted documents during full syncs ([Elastic content syncs](https://www.elastic.co/docs/reference/search-connectors/content-syncs)).

Plan three levels:

1. **Catch-up (every few minutes to hourly):** call the change feed even without a notification. Cheap (1 resource unit per Graph delta page with token, 2 quota units per Gmail `history.list`).
2. **Id-set diff (daily to weekly per partition):** list ids and version markers only, compare with the ledger, fix differences. This is the indexer's "re-check after a gap".
3. **Full re-verify (monthly or on demand):** includes ACL recomputation. Run in off-peak hours; Microsoft says throttling is more likely in business hours of the tenant's region.

Any feed error that means "you missed something" (Graph 410, Gmail 404, USN journal id change, FSEvents `MustScanSubDirs`, `FAN_Q_OVERFLOW`, `STATUS_NOTIFY_ENUM_DIR`) moves that partition to `resyncing` and triggers level 2 automatically.

### 1.6 What "caught up" means, and the status the UI shows

A partition is **caught up** when (a) its backfill is complete, (b) the last change-feed call returned no further pages and was made within the freshness target (for example 15 minutes), (c) the extraction queue holds no items for that partition older than the target, and (d) no reconciliation diff is outstanding. A source is caught up when all its partitions are. This mirrors an indexer's "synced block equals chain head".

Per-source status for the VS Code control panel:

| Field | Meaning |
|---|---|
| Phase | Discovering, Backfilling, Live, Resyncing, Paused, Needs attention |
| Backfill progress | items done / estimated total. Estimates: drive `quota.used` and folder `childCount`, mailbox folder `totalItemCount`, Gmail profile `messagesTotal`, MFT record count |
| Sync lag | now minus the time of the last successful change-feed call that reached "no more pages" |
| Processing backlog | items fetched but not yet extracted, shown separately from sync lag so a slow OCR queue is not mistaken for a broken connector |
| Last event | time and type of the last change seen |
| Throttle state | "Microsoft asked us to wait until hh:mm" from `Retry-After` |
| Coverage | partitions included, excluded by policy, and failing |

### 1.7 Prior art compared

| System | Cursor | "Reorg" handling | Replay or reconcile | What we take |
|---|---|---|---|---|
| The Graph (graph-node) | block pointer per subgraph | entity versions carry a `block_range`; revert closes or deletes versions past the reverted block | reindex from start block | versioned rows so a change can be undone cleanly |
| Substreams | opaque cursor carrying fork context | sink keeps a history table and replays it in reverse | resume from cursor | store enough history to reverse derived writes |
| Subsquid | last processed block plus "hot" unfinalized blocks | rolls back DB state for orphaned blocks; warns external side effects are not rolled back | re-run batch handler | commit data and cursor together; outbox for side effects |
| NEAR Lake | start block height; no built-in resume (you track it) | NEAR has fast finality, so simple | re-read blocks from S3 | note: NEAR Lake was deprecated on 24 Mar 2026 ([NEAR docs](https://docs.near.org/data-infrastructure/tutorials/near-lake-framework)) |
| Glean | per connector | deletion notifications plus full crawls; separate identity crawls | scheduled full crawl | split content, identity and ACL schedules |
| Elastic connectors | per sync job | full, incremental and access-control syncs; deletions in full sync only | full sync | three sync types are a good UX vocabulary |
| Microsoft Graph connectors | per connection | per-item ACL (user, group, everyone, deny wins); external groups for non-Entra groups | connector-specific crawls | ACL model shape ([Graph connectors items](https://learn.microsoft.com/graph/connecting-external-content-manage-items)) |

---

## 2. Comparison tables

### 2.1 Connector frameworks

Repository data read from the GitHub API on 2026-11-18. Confidence: HIGH for licence and dates, MEDIUM for coverage judgements.

| Framework | Licence | Lang | Stars | Latest release | Last push | Incremental / CDC | Our first sources covered | Adding a connector | Offline on-prem |
|---|---|---|---|---|---|---|---|---|---|
| **dlt** | Apache-2.0 | Python | 6.1k | 1.32.0 (2026-10-29) | 2026-11-18 | `dlt.sources.incremental`, state stored with the data; `pg_replication` CDC source | SharePoint (lists and files, incremental on modification date), filesystem (local, SFTP, Google Drive via fsspec), IMAP inbox, `sql_database` (30+ databases). No Exchange Graph, Gmail API or Teams | Easy: Python functions with decorators; declarative `rest_api` source | Yes, a library, no server |
| **Singer / Meltano** | MIT (Meltano), Apache-2.0 (SDK) | Python | 2.7k | v4.4.1 (2026-10-07) | 2026-11-18 | STATE messages; log-based CDC in some taps | Community `tap-ms-graph`, MeltanoLabs `tap-gmail`; nothing solid for SharePoint or Drive | Medium: Singer SDK | Yes |
| **Airbyte** | ELv2 (platform and the connectors we need); MIT for protocol and Python CDK | Python, Java, Kotlin | 22.4k | v2.0.0 (2025-10-15) | 2026-11-18 | Per-stream state; DB CDC via Debezium | Best coverage: SharePoint 0.10.5 (alpha, community), OneDrive (alpha), Google Drive (certified), Gmail (GA), Outlook (alpha), Teams (alpha), Postgres, SQL Server, MySQL (certified). All `license: ELv2` in connector metadata | Easiest for REST: low-code YAML manifests and Connector Builder | Yes, but heavy (Kubernetes-based) |
| **Apache NiFi** | Apache-2.0 | Java | 6.3k | 2.12.0 (2026-09-13) | 2026-11-18 | Stateful List/Fetch processors; MySQL binlog processor | ListGoogleDrive/FetchGoogleDrive, ListSmb/FetchSmb; no SharePoint processor found | Medium: GUI flows; Python processors in 2.x | Yes, heavy JVM |
| **Debezium** | Apache-2.0 | Java | 13.4k | 3.7.1.Final (tag) | 2026-11-18 | True log-based CDC for Postgres, MySQL, SQL Server, Oracle, MongoDB | Databases only | N/A | Yes; Debezium Server runs without Kafka, file or Redis offsets |
| **Apache SeaTunnel** | Apache-2.0 | Java | 9.8k | n/a | 2026-11-18 | CDC connectors | Mostly databases and warehouses | Medium | Yes, heavy |
| **Onyx** (search app) | MIT except `ee/` (Enterprise licence) | Python | 33.5k | n/a | 2026-11-18 | Polling per connector | SharePoint, Google Drive, Gmail, Teams and many more; permission sync is Enterprise only | N/A (app, not a framework) | Yes | 
| **Elastic connectors** | ELv2 | Python | 134 | n/a | 2026-11-16 | full, incremental, access-control syncs | SharePoint Online, Google Drive, Gmail, Outlook, network drive, with document-level security | Medium | Yes, needs Elasticsearch |
| **rclone** | MIT | Go | 61k | v1.76.0 (2026-11-06) | 2026-11-18 | Listing and checksums, no change feed | OneDrive/SharePoint, Google Drive, SMB, SFTP | N/A (tool) | Yes |
| **Airweave** | MIT | Python | 6.5k | n/a | archived | n/a | n/a | n/a | do not use |
| **Nango** | ELv2 | TS | n/a | n/a | n/a | syncs are paid only | auth for many APIs | n/a | free self-host is auth only |
| **Sling** | GPL-3.0 | Go | 0.9k | n/a | 2026-11-17 | yes | databases | n/a | licence blocks embedding |

**Airbyte licence, read carefully.** The repository root `LICENSE` is Elastic License 2.0. ELv2 has three limits: you may not provide the software to third parties as a hosted or managed service that gives access to a substantial set of its features; you may not circumvent licence keys; you may not remove notices ([ELv2 text](https://www.elastic.co/licensing/elastic-license)). Airbyte's FAQ adds that you may not "sell a product that directly exposes Airbyte's UI or API" and may not sell it "as an ELT/ETL tool", while internal use and "bringing data in on behalf of customers" is allowed ([Airbyte licence FAQ](https://docs.airbyte.com/platform/developer-guides/licenses/license-faq)). Older pages still say connectors are MIT; the connector `metadata.yaml` files say `ELv2`, and those are authoritative. Our product is an appliance whose core value is "a governed connector platform with a control panel", which is close to what ELv2 is written to stop, and if we ever operate appliances for customers it is plainly a managed service. Copying ELv2 connector code into our connectors would make them derivative works under ELv2. Verdict: do not depend on Airbyte; reading its code to understand an API is fine. An organization that already runs Airbyte itself could be supported later as an optional source.

### 2.2 Extraction and parsing

| Tool | Licence | Latest | Formats that matter to us | Runs on | Quality notes | Speed (reported) |
|---|---|---|---|---|---|---|
| **Apache Tika 4.0** | Apache-2.0 | 4.0.0 (2026-08-18) | Very broad (office, PDF, email MSG via POI, PST via java-libpst, archives, metadata); Markdown output by default in 4.x | CPU, JVM | Good text, weak layout and tables; parsers now run in forked, crash-isolated processes | Fast on born-digital files (LOW: measure) |
| **Docling** | MIT | v2.150.1 (2026-11-14) | PDF, DOCX, XLSX, PPTX, legacy Office (via LibreOffice), HTML, images, EML and MSG, audio and video (ASR extra), iWork | CPU or GPU (PyTorch) | Strong layout, tables, reading order; VLM pipeline with granite-docling | Standard pipeline about 1.5 pages/s on CPU (16 threads), 7.9 pages/s on RTX 5090; VLM 2.4 pages/s on L40S |
| **Unstructured (open source)** | Apache-2.0 | 0.27.37 (2026-11-06) | Office, PDF, HTML, EML, MSG, images; no PST, no audio | CPU, optional GPU for hi_res | Good element typing; hi_res mode is slow | n/a |
| **MarkItDown** | MIT | v0.1.9 (2026-10-21) | Office, PDF, HTML, images, audio, ZIP, EPUB, Outlook MSG (extra) | CPU | Lightweight, lossy on layout. README warns it performs I/O with process privileges and says not to pass untrusted input; captioning and transcription "rely on web-hosted services" | Fast |
| **Tesseract** | Apache-2.0 | 5.5.4 (2026-10-28) | Images, scanned pages | CPU | Fine on clean scans, poor on tables and handwriting | roughly 1 to 3 s per page per core (LOW) |
| **PaddleOCR (PP-OCRv5)** | Apache-2.0 | v3.7.0 (2026-06-11) | Images, scans, 100+ languages | CPU or GPU | Better than Tesseract on hard scans | GPU support on AMD depends on PaddlePaddle ROCm builds (risk) |
| **PaddleOCR-VL (0.9B)** | Apache-2.0 weights | updated 2026-11-06 | Full page parsing incl. tables, formulas | GPU (transformers or vLLM) | olmOCR-bench about 80 (self-reported) | n/a |
| **olmOCR-2-7B** | Apache-2.0 weights | 2025-10 | Full page to Markdown | GPU | olmOCR-bench about 82.4 | slow on bandwidth-limited GPUs |
| **granite-docling-258M** | Apache-2.0 weights | 2025 | Full page, used inside Docling | GPU or CPU | Tiny; good structure | 2.0 to 3.8 pages/s on RTX 5070/5090 |
| **DeepSeek-OCR** | MIT | 2025 | Full page | GPU | olmOCR-bench about 75 to 76 | n/a |
| Chandra 2, Marker | Apache code, modified OpenRAIL-M weights | 2026 | Best scores (Chandra about 85.9) | GPU | Weights: free only for research, personal use and startups under USD 2M, cannot compete with their API | **Licence blocks us** |
| MinerU | Apache-2.0 plus extra terms | 2026 | PDF parsing | GPU | Strong | Attribution for online services, commercial licence above thresholds: avoid |
| **whisper.cpp** | MIT | v1.9.5 (2026-10-06) | Audio, video soundtracks | CPU, Vulkan, ROCm | large-v3 and turbo | Strix Halo: large-v3 about 4.5x real time (ROCm); large-v3-turbo about 27x real time (Vulkan, one report) |
| faster-whisper | MIT | 2026 | Audio | CTranslate2 (CPU, CUDA; ROCm builds exist) | Same models | about 2x whisper.cpp on Strix Halo in one report |

Email and archives: Tika parses MSG (Apache POI HSMF) and PST (java-libpst), both Apache-2.0, so we need no GPL code. `libpff` is LGPL-3.0 (usable if dynamically linked); `extract-msg` is GPL-3.0 (avoid); `readpst` is GPL (avoid).

Benchmark sources: [Docling GPU docs](https://docling-project.github.io/docling/usage/gpu), [Docling technical report](https://arxiv.org/abs/2408.09869), [Hugging Face OCR models blog](https://huggingface.co/blog/ocr-open-models), [olmOCR-bench aggregations](https://www.codesota.com/ocr/benchmark/olmocr-bench), [whisper-rocm on Strix Halo](https://github.com/davidguttman/whisper-rocm), [whisper.cpp Strix Halo discussion](https://github.com/ggml-org/whisper.cpp/discussions/3536). OCR scores come from different runs and some are self-reported: treat as rank order, not exact numbers.

### 2.3 Storage and transformation

| Option | Licence | Status | Fit |
|---|---|---|---|
| **Postgres** | PostgreSQL | mature | Control plane: sources, cursors, item ledger, ACL tables, lineage, outbox. Also DuckLake's catalog. |
| **DuckDB** | MIT | v2.0.0 (2026-10-21) | Analytics engine on one host; reads Parquet directly |
| **DuckLake** | MIT | 1.0 (2026-04-13), stable spec with backward compatibility | Lakehouse whose metadata lives in Postgres; data inlining for small writes suits a stream of small changes. Recommended. Check DuckLake on DuckDB 2.0 in the spike. |
| **Apache Iceberg** (pyiceberg) | Apache-2.0 | 1.12.0 (2026-09-30) | Best multi-engine interoperability; needs a catalog service; heavier for many small commits. Keep as an export format. |
| **Delta Lake** (delta-rs) | Apache-2.0 | rust 1.0.0 (2026-09-28) | Fine, but no advantage over DuckLake on one host |
| **OpenLineage** | Apache-2.0 | 1.55.0 (2026-10-30) | Event model for runs, jobs, datasets and facets; we emit it, Marquez can show it |
| **datasketch** | MIT | 2026-10 | MinHash LSH for near duplicates |

---

## 3. Should data stay in place or be centralized?

**The lead's working recommendation:** originals stay in place as the system of record; the central layer holds catalog, extracted text, structured derivatives, embeddings and graph, keyed back to the source, kept in sync, inheriting ACLs and labels, deleted when the source is deleted; raw copies only for immutable training snapshots, decommissioned or at-risk sources, and systems without reliable live access; moving originals is only ever a human-approved proposal.

### 3.1 What the evidence says

| Practice | What they copy | Pointer and ACL | Deletion |
|---|---|---|---|
| Glean | Indexed content and derived data, stored in a cloud project in the customer's own cloud account | Per-document permissions from identity crawls | Removed on source deletion notification "within minutes to a few hours", otherwise at the next full crawl; derived data in models is governed by their privacy policy |
| Elastic connectors | Extracted text and metadata into an Elasticsearch index | Document-level security via access-control sync | Only full syncs delete |
| Microsoft Graph connectors | Parsed text into Microsoft's index; max 4 MB per item, which Microsoft says is "typically 10% of the original file size" for docx, ppt and PDF | Per-item ACL of users, groups, everyone, with deny winning | Connector deletes items |
| Data catalogs (Purview, DataHub, OpenMetadata) | Metadata, schemas, samples, classification results; not content | Pointer to the asset | Rescan |
| Lakehouse "medallion" practice | Raw copy ("bronze") kept so transformations can be re-run | Usually table-level grants | Retention policies |

So enterprise search, which is the closest analogue, does exactly what the lead proposes: copy extracted text plus ACL, keep a pointer, leave originals alone. Catalogs go further toward "in place". Lakehouse practice is the outlier: it keeps raw copies for reprocessing.

**Storage ratio.** Microsoft's figure of about 10% parsed text to original size for common office formats is the best published number (HIGH for Microsoft's claim, MEDIUM as a general rule). Images, audio and video yield far less text per byte; plain text and email bodies yield closer to 50 to 100%. Embeddings change the picture: a 1,024-dimension float32 vector is 4 KB, often larger than the 1 to 2 KB text chunk it describes, so the embedding store can be bigger than the text store unless vectors are quantized (int8 is 1 KB, binary is 128 bytes). Planning estimate for 20 TB of originals: 0.5 to 2 TB of text, a similar or larger amount of embeddings at float32, and a few hundred GB with quantization (LOW: estimate, validate on a real corpus).

### 3.2 Legal hold, right to erasure, reproducible datasets

- **Legal hold.** M365 and Google Vault apply holds at the source; a user deleting a held item keeps it in the source's preservation store. Our derivatives are still electronically stored information that may be discoverable. The deletion pipeline must check a hold flag before purging, and holds must be importable (manually at first) so a held item's derivatives are not purged while litigation is pending.
- **Right to erasure.** Erasure must reach every derivative: text, chunks, embeddings, graph nodes and edges, dataset rows, caches and backups. The derivation graph in section 1.3 is what makes this provable. Fine-tuned model weights are the hard case: the European Data Protection Board's Opinion 28/2024 says models trained on personal data cannot be assumed anonymous ([EDPB Opinion 28/2024](https://www.edpb.europa.eu/our-work-tools/our-documents/opinion-board-art-64/opinion-282024-certain-data-protection-aspects_en)). The practical answer is provenance (know which model versions saw which items) plus a retrain or retire policy, not unlearning.
- **Reproducible training datasets.** Reproducibility wants immutable snapshots; erasure wants deletion. They conflict.

### 3.3 Where I disagree with the working recommendation

1. **Extracted text is a copy, not "just a derivative".** For privacy, security and discovery, the text of a contract is as sensitive as the PDF. The hybrid saves storage and keeps the source authoritative, but it does not reduce risk much. The central layer needs the same controls as a raw copy: encryption at rest, ACL inheritance, holds, erasure. The design is right; the framing should not suggest the central layer is lower-risk.
2. **Keep a bounded re-extraction cache.** Lakehouse practice keeps raw data so better models can re-process it. Re-fetching from the source is not free: a tenant under 1,000 licences gets 1.2 million SharePoint resource units per app per day, and every download costs 1. Re-running a better OCR model over a million scanned pages would burn most of a day's budget per million files and compete with live sync. Recommend an encrypted, content-addressed cache of originals for file types we expect to re-extract (scans, images, audio), with a size cap and a TTL, deleted on source deletion like any derivative. This is a cache, not a system of record.
3. **Training snapshots should be rebuildable, not frozen raw copies.** Store a dataset as a manifest: item ids, versions, content hashes, extractor versions and the transformation code version. Keep the materialized rows, but when an item is erased, publish a new dataset version without it and mark the old one revoked; the manifest proves what changed. Raw-copy snapshots for training are the riskiest objects in the system and should be the exception, needing explicit approval.
4. **Endpoints are rarely a reliable system of record.** Laptops go offline, get lost, get wiped. Files that exist only on an endpoint (not in a synced OneDrive or Drive folder) probably fall under "no reliable live access" by default. The policy should say so explicitly rather than leave it to case-by-case judgement.
5. **Never read cloud placeholder files on endpoints.** OneDrive Files On-Demand, Google Drive for desktop and iCloud show cloud files as local placeholders. Reading one downloads it. An endpoint collector that opens every file would trigger a mass download and duplicate what the cloud connector already ingests. Detect sync roots and placeholder attributes (Windows `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS`, macOS File Provider) and skip them, letting the cloud connector own those files.

I agree with the rest: originals stay in place, ACLs and labels follow the source, deletion follows the source, consolidation of originals is only ever a proposal a person approves.

---

## 4. Discovery

### 4.1 Endpoints (Windows, macOS, Linux)

- **Windows:** enumerate the MFT through `FSCTL_ENUM_USN_DATA` (what Everything uses; indexes a million files in seconds; needs admin), then tail the USN journal. Advise admins to size the journal at least 32 MB to avoid wraps (voidtools guidance). Windows Search's index can give a quick first inventory without admin, but it covers only indexed locations.
- **macOS:** Full Disk Access via an MDM privacy profile (PPPC) is required to see user folders; without it the collector sees almost nothing. Spotlight (`mdfind`) is a fast hint; FSEvents with stored ids gives the change feed.
- **Linux:** fanotify filesystem marks need `CAP_SYS_ADMIN`; directory-entry events since kernel 5.1; queue limit configurable since 5.13. Fallback: inotify per directory plus periodic walk.
- **What to look for:** office documents, PDFs, images, audio, mail stores (PST, OST, MBOX, Apple Mail), file databases (SQLite, Access `.mdb/.accdb`, `.db`), CSV and XLSX exports, and database client configs (ODBC DSNs) that point to servers. Any credentials found in config files must not be stored; flag the location so an admin can route the credential through the broker.
- **Exclude by default:** OS and program directories, caches, sync-root placeholders (section 3.3), developer build outputs, and anything policy excludes.

### 4.2 File shares

- Enumerate shares through Active Directory (published shares, DFS namespaces, computer objects) and `NetShareEnum` on file servers; NFS exports through `showmount -e` where allowed.
- Prefer a collector on the file server itself (USN on Windows file servers). For NAS appliances use the vendor's own change or audit feed (NetApp FPolicy, ZFS `zfs diff` between snapshots) when available. Otherwise schedule snapshot diffs.
- NTFS and SMB ACLs must be read alongside content (SIDs resolved through AD) so access follows the source.

### 4.3 Microsoft 365

**Discovery calls:** `GET /sites` (all site collections, app-only), `/sites/{id}/drives`, `/users` then `/users/{id}/drive` and mailboxes, `/groups` for teams. Teams files are in each team's SharePoint site.

**Permissions and admin consent:**

| Need | Least privilege | Broad option | Notes |
|---|---|---|---|
| Files in chosen sites | `Sites.Selected` plus per-site grant | `Files.Read.All` / `Sites.Read.All` | A community report says adding `Files.Read.All` alongside `Sites.Selected` re-opens all sites; never combine them (MEDIUM) |
| Correct permission processing | | `Sites.FullControl.All` | Microsoft's scan guidance says this is needed "to process permissions correctly"; many admins will refuse it. Test how much ACL fidelity we get with read scopes only (open question) |
| Mail in chosen mailboxes | Exchange **RBAC for Applications**: `Application Mail.Read` scoped to a management scope or administrative unit | `Mail.Read` in Entra (tenant-wide) | RBAC for Applications replaces Application Access Policies. Grants are a union: the Entra grant must be removed or scoping has no effect. Permission changes take 30 minutes to 2 hours to apply ([Exchange RBAC for Applications](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)) |
| Identity for ACLs | `User.Read.All`, `GroupMember.Read.All` | | |
| Sensitivity labels | `extractSensitivityLabels` on items (beta-era docs list Files/Sites Read scopes) | | Verify v1.0 permission table |
| Teams chats | Protected API, approval form | | Defer |

**Throttling (official, 2026):**

| Limit | Tenant 0 to 1,000 licences | 1,001 to 5,000 | 50,000+ |
|---|---|---|---|
| SharePoint per app per tenant, 24 h | 1,200,000 resource units | 2,400,000 | 6,000,000 |
| SharePoint per app per tenant, 1 min | 1,250 | 2,500 | 6,250 |
| Per app ingress and egress | 400 GB per hour each | same | same |
| Resource unit costs | 1: get item, delta with token, download; 2: list children, delta without token; 5: any permission operation incl. `$expand=permissions` | | |

Source: [Avoid getting throttled in SharePoint Online](https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online). Graph's general limit for other workloads is per app per tenant in resource units per 10 seconds by tenant size ([Graph throttling limits](https://learn.microsoft.com/en-us/graph/throttling-limits)). Honour `Retry-After`, pause all threads on 429, decorate traffic with a `User-Agent` of the form `ISV|Company|App/Version`, and do not create extra app ids to dodge limits (Microsoft calls that out and the tenant bucket is shared anyway).

**Implication:** permission reads at 5 units each dominate. 1 million files with per-item permission reads is about 5 million units, over four days of budget for a small tenant, before downloads. Using `Prefer: hierarchicalsharing` so we only read permissions at permission-hierarchy roots is essential.

**Notifications without a public endpoint.** Graph webhooks need a public HTTPS URL, which an on-premises appliance usually lacks. Options: poll delta (cheap, recommended default), or have Graph deliver to Azure Event Hubs and pull from it outbound ([Graph via Event Hubs](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-event-hubs)), which needs an Azure subscription. The same applies to Google: Drive push channels need an HTTPS endpoint; Gmail push uses Cloud Pub/Sub, which supports outbound pull. Default to polling; offer push as an optional low-latency mode.

### 4.4 Google Workspace

- **Auth:** a service account with domain-wide delegation. The admin pastes the client id and the scopes into the Admin console: `drive.readonly` (or `drive.metadata.readonly` for inventory only), `gmail.readonly`, `admin.directory.user.readonly`, `admin.directory.group.readonly`. The service account key goes into the credential broker; prefer keyless or short-lived credentials where possible (open question).
- **Discovery:** list users and groups through the Admin SDK; list shared drives with `drives.list` using domain admin access; per user, impersonate and read My Drive and Gmail.
- **Change feeds:** `changes.list` per user and per shared drive; Gmail `history.list` per user.
- **Quotas (official, read 2026-11-18):** Drive API 1,000,000 quota units per minute per project and 325,000 per minute per user per project ([Drive limits](https://developers.google.com/workspace/drive/api/guides/limits)); Gmail 1,200,000 quota units per minute per project and 6,000 per minute per user, with `messages.get` 20 units (60 for full or raw format), `messages.list` 5, `history.list` 2, `watch` 100 ([Gmail quota](https://developers.google.com/workspace/gmail/api/reference/quota)). At 60 units per raw message, one user's mailbox backfills at about 100 messages per minute; a 100,000-message mailbox takes about 17 hours. Parallelize across users (MEDIUM: verify these figures, which differ from older published values).

### 4.5 Databases on the network

- Ask Active Directory first: SQL Server registers service principal names (`MSSQLSvc/...`), so an LDAP query finds most SQL Servers without scanning. Also read ODBC DSNs and connection strings found by endpoint collectors.
- Network scan only on subnets the policy approves (`nmap -sV` on common ports: 1433, 1434/udp browser, 5432, 3306, 1521, 27017, 6379, 9200). Scans can trip intrusion detection; make scanning a separate, explicit policy switch.
- Discovery only produces a candidate list. Connecting needs a credential from the broker and an admin approval per database, because database access is far more sensitive than file metadata.
- CDC prerequisites: Postgres `wal_level=logical` and a replication slot; SQL Server Agent running for CDC (not available on Express edition, so use Change Tracking or cursor polling there); MySQL row-based binlog with enough retention.

---

## 5. Making new sources easy

**For a non-technical admin, "a few clicks":**

1. **Catalog** of source types in the control panel, each with a plain description, the exact permissions it will request and why, and estimated backfill time.
2. **One consent step per cloud.** M365: either a vendor-published multi-tenant app (one admin-consent link) or a per-organization app registration created by a guided script, with a certificate credential held by the broker. The per-organization app is more sovereign and fits "data stays on premises"; recommend it, with the script doing the clicking. Google: domain-wide delegation needs the admin to paste one client id and a scope list; a Marketplace app would make it one click but ties us to Google's listing process.
3. **Scope picker** with safe defaults (for example "all SharePoint sites except these", "mailboxes in this group"), mapped to `Sites.Selected` grants and Exchange management scopes.
4. **Dry run first:** inventory only (names, sizes, counts, sensitive-label counts) before any content is read; admin approves the policy once; then backfill starts.

**Manifest-based connectors.** For REST sources, a declarative manifest (auth, pagination, record selector, incremental cursor field, deletion signal, ACL mapping) covers most SaaS APIs. dlt's `rest_api` source and Airbyte's low-code YAML prove the shape; we should define our own schema (do not copy Airbyte's ELv2 manifests).

**Agents writing connectors safely:**

- The agent writes a manifest first, code only when the manifest schema cannot express the source.
- The connector runs in a sandbox: no filesystem access, network egress allowed only to the declared API hosts, credentials injected by the broker at request time (the connector never sees the raw secret, only a scoped token or a broker-signed request).
- Read-only scopes enforced by the broker, not by trust in the connector.
- A conformance test suite every connector must pass against recorded fixtures: pagination, resume from checkpoint, incremental cursor, deletion handling, ACL mapping, throttling behaviour, idempotent replay.
- A person approves the connector and its requested scopes before first run; the diff of any later change needs approval again.

---

## 6. Scale and cost

### 6.1 Volumes to plan for

Published benchmarks for mid-size organizations are thin and dated. The Osterman figure of about 20 TB of unstructured data for medium and large companies, growing about 20% a year, is the only direct one ([summary](https://formtek.com/blog/unstructured-data-average-large-medium-sized-companies-manage-20-terabytes-of-unstructured-data/)). Planning model for a 500-person organization (LOW, derived, validate with the inventory dry run):

| Item | Estimate |
|---|---|
| Files across M365, Drive, shares, endpoints | 2 to 10 million |
| Email messages | 10 to 30 million (mail dominates item counts) |
| Raw bytes | 5 to 50 TB |
| Scanned PDF pages needing OCR | 0.5 to 5 million |
| Audio and video | hundreds to a few thousand hours |

### 6.2 Throughput on one Strix Halo class host (128 GB unified memory)

No direct benchmarks exist for most of these tools on this chip. The GPU (Radeon 8060S) is limited by about 256 GB/s memory bandwidth; Vulkan is often faster than ROCm in llama.cpp-style workloads ([Phoronix ROCm 7 on Strix Halo](https://www.phoronix.com/review/amd-rocm-7-strix-halo/3)). Estimates (LOW unless noted):

| Stage | Estimate | Time for the planning model |
|---|---|---|
| M365 fetch, small tenant | bound by 1,250 RU per minute, about 20 downloads per second at best; permission reads 5 RU each | 1 million files: about 1 to 5 days depending on permission strategy (MEDIUM, from official limits) |
| Gmail fetch | about 100 messages per minute per user, parallel across users | 10 million messages: days, bound by per-user quota |
| Tika text, born-digital | tens of documents per second across CPU cores | 5 million documents: about 1 to 3 days |
| Docling standard pipeline | about 1.5 pages/s CPU; GPU on this chip perhaps 2 to 5 pages/s | use only where layout matters |
| Cheap OCR (Tesseract or PP-OCRv5, CPU, all cores) | about 5 to 15 pages/s | 1 million pages: about 1 to 2 days |
| VLM OCR (0.9B to 7B) | about 0.2 to 2 pages/s | 1 million pages: 6 to 60 days, hence tiering |
| whisper.cpp large-v3-turbo | about 20 to 27x real time (one report) | 2,000 hours: about 3 to 4 days |
| Embeddings (small model) | hundreds to a few thousand chunks per second | not the bottleneck |

**Conclusion:** source API quotas set the pace of backfill for cloud sources, and OCR plus transcription set the pace for processing. The UI must show backfill and processing backlog separately (section 1.6), and the scheduler must let live sync pre-empt backfill so new changes stay fresh while the history fills in.

---

## 7. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Admins refuse tenant-wide scopes (`Files.Read.All`, `Sites.FullControl.All`) | High | `Sites.Selected` plus Exchange RBAC scoping; show exactly what each scope is for; measure ACL fidelity without FullControl |
| ACL drift: a permission revoked at the source still visible in our store | High (security) | Separate fast ACL and identity sync; hide on doubt; reconcile ACLs in every sweep |
| Throttling or blocking by Microsoft during backfill | High | Budget resource units per tenant, honour `Retry-After` globally, run backfill off-peak, never multiple app ids |
| Missed change events | Medium | Three-level reconciliation; automatic resync triggers |
| Gmail history expiry during long backfills | Medium | Start the tail before the backfill; full resync on 404 |
| Endpoint collectors hydrating cloud placeholders | High (bandwidth, duplication) | Skip sync roots and placeholder attributes |
| Malicious or malformed files crashing or exploiting parsers | High | Tika 4 forked parsers, extraction in a sandboxed worker with no network, size and time limits, MarkItDown only with `convert_local` |
| OCR and transcription backlog of weeks | Medium | Tiered OCR, priority queue by policy, clear backlog display |
| Licence contamination (ELv2, GPL, OpenRAIL-M weights) | High | Licence check in CI for dependencies and model weights; only Apache, MIT, BSD, PostgreSQL, LGPL dynamic |
| PaddlePaddle on AMD GPUs | Medium | Run PaddleOCR-VL through transformers or vLLM, or keep PP-OCRv5 on CPU |
| DuckLake youth | Medium | Keep Postgres as the system of record for state; Parquet files are portable; Iceberg export path |
| Network scanning flagged as an attack | Medium | Scanning off by default, explicit policy, AD-first discovery |

---

## 8. Open questions

1. How much ACL fidelity do we get for SharePoint without `Sites.FullControl.All`? Needs a test tenant.
2. Do Graph delta `nextLink` values expire during a multi-day backfill, and how does a 410 resync behave on very large drives?
3. Exchange message identity across folder moves: confirm `immutableId` behaviour with delta.
4. Real throughput of Docling, PaddleOCR-VL, olmOCR-2 and whisper.cpp on Strix Halo under ROCm vs Vulkan. A one-week spike with a fixed 1,000-page and 10-hour test set would replace most LOW numbers here.
5. Google Drive and Gmail quota figures differ from older published values; confirm in the Cloud console of a test project.
6. Can the credential broker hold Google service account keys as short-lived credentials (workload identity federation) on an on-premises host?
7. Legal hold import: can we read hold status from Purview and Google Vault through APIs, or must admins mark holds manually?
8. Teams chat messages: is approval for protected APIs realistic for an on-premises product?
9. Which dataset retention and erasure policy does the organization's privacy officer accept for fine-tuning sets?
10. Licence of `dots.ocr` weights was not confirmed.

## 9. Suggested phase order (for the roadmap)

1. **Ingestion core:** connector contract, cursor store, item ledger, idempotent upserts, status model, reconciliation framework, filesystem connector on the appliance itself. Everything else plugs into this.
2. **M365 connector:** sites and drives with delta, permissions via hierarchical sharing, identity sync, mail with scoped RBAC. Needs deeper research on ACL fidelity and throttling budgets.
3. **Extraction pipeline:** Tika plus Docling router, sandboxed workers, content-addressed derivatives, tiered OCR, whisper.cpp. Needs a throughput spike on the target host.
4. **Google Workspace connector.**
5. **Endpoint collectors and file shares:** Windows first (USN), then macOS (FSEvents, MDM profile), then Linux; SMB snapshot diff.
6. **Databases:** dlt backfill plus Debezium CDC, AD-based discovery.
7. **Lifecycle and governance:** deletion propagation, legal hold flags, erasure proofs, dataset manifests.
8. **Easy sources:** catalog UI, manifest connectors, agent-written connectors with conformance tests.

Phases 2, 3 and 5 are independent once phase 1 exists and can run in parallel.

---

## Sources

Official vendor documentation (HIGH):
- Microsoft scan guidance for OneDrive and SharePoint: https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts/scan-guidance
- SharePoint Online throttling and resource units: https://learn.microsoft.com/en-us/sharepoint/dev/general-development/how-to-avoid-getting-throttled-or-blocked-in-sharepoint-online
- Microsoft Graph throttling limits: https://learn.microsoft.com/en-us/graph/throttling-limits
- driveItem delta: https://learn.microsoft.com/en-us/graph/api/driveitem-delta?view=graph-rest-1.0
- Graph subscription lifetimes and latency: https://learn.microsoft.com/en-us/graph/api/resources/subscription?view=graph-rest-1.0
- Graph notifications through Azure Event Hubs: https://learn.microsoft.com/en-us/graph/change-notifications-delivery-event-hubs
- Exchange Online RBAC for Applications: https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac
- Selected permissions overview: https://learn.microsoft.com/graph/permissions-selected-overview
- extractSensitivityLabels: https://learn.microsoft.com/en-us/graph/api/driveitem-extractsensitivitylabels?view=graph-rest-1.0
- Teams API licensing: https://learn.microsoft.com/en-us/graph/teams-licenses
- Graph connectors API limits: https://learn.microsoft.com/graph/connecting-external-content-api-limits
- Graph connectors items and ACLs: https://learn.microsoft.com/graph/connecting-external-content-manage-items
- Google Drive changes: https://developers.google.com/workspace/drive/api/guides/manage-changes
- Google Drive push notifications: https://developers.google.com/workspace/drive/api/guides/push
- Google Drive limits: https://developers.google.com/workspace/drive/api/guides/limits
- Gmail sync: https://developers.google.com/workspace/gmail/api/guides/sync
- Gmail push: https://developers.google.com/workspace/gmail/api/guides/push
- Gmail quota: https://developers.google.com/workspace/gmail/api/reference/quota
- fanotify(7): https://man7.org/linux/man-pages/man7/fanotify.7.html
- FSEvents programming guide: https://developer.apple.com/library/archive/documentation/Darwin/Conceptual/FSEvents_ProgGuide/UsingtheFSEventsFramework/UsingtheFSEventsFramework.html
- NTFS change journal explained: https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-2000-server/bb742450(v=technet.10)
- MS-SMB2 change notifications algorithm: https://msdn.microsoft.com/en-us/library/cc246705.aspx
- Debezium Server: https://debezium.io/documentation/reference/stable/operations/debezium-server.html
- Elastic License 2.0: https://www.elastic.co/licensing/elastic-license
- Airbyte licence FAQ: https://docs.airbyte.com/platform/developer-guides/licenses/license-faq
- Airbyte connector metadata (licence fields): https://github.com/airbytehq/airbyte/tree/master/airbyte-integrations/connectors
- dlt verified sources: https://dlthub.com/docs/dlt-ecosystem/verified-sources/
- dlt SharePoint source: https://dlthub.com/docs/dlt-ecosystem/verified-sources/sharepoint
- dlt filesystem source: https://dlthub.com/docs/dlt-ecosystem/verified-sources/filesystem/basic
- Meltano Hub tap-ms-graph: https://hub.meltano.com/extractors/tap-ms-graph
- NiFi Google Drive processors: https://nifi.apache.org/components/org.apache.nifi.processors.gcp.drive.ListGoogleDrive/
- Apache Tika 4.0.0: https://tika.apache.org/4.0.0/ and Tika Pipes: https://tika.apache.org/docs/4.0.x/pipes/index.html
- Docling supported formats: https://docling-project.github.io/docling/usage/supported_formats/
- Docling GPU performance: https://docling-project.github.io/docling/usage/gpu
- Docling technical report: https://arxiv.org/abs/2408.09869
- Unstructured supported file types: https://docs.unstructured.io/open-source/introduction/supported-file-types
- MarkItDown README: https://github.com/microsoft/markitdown
- DuckLake 1.0 announcement: https://ducklake.select/2026/04/13/ducklake-10/
- EDPB Opinion 28/2024 on AI models: https://www.edpb.europa.eu/our-work-tools/our-documents/opinion-board-art-64/opinion-282024-certain-data-protection-aspects_en
- Onyx licence: https://github.com/onyx-dot-app/onyx/blob/main/LICENSE
- MinerU licence: https://github.com/opendatalab/MinerU/blob/master/LICENSE.md
- Chandra commercial usage: https://github.com/datalab-to/chandra
- Glean crawling types: https://docs.glean.com/connectors/crawling-types
- Glean deletion: https://docs.glean.com/connectors/crawling-deletion
- Glean security architecture: https://docs.glean.com/security/architecture
- Elastic content syncs: https://www.elastic.co/docs/reference/search-connectors/content-syncs
- Onyx connectors and permissioning: https://docs.onyx.app/admins/connectors/overview and https://docs.onyx.app/enterprise_edition/permissioning
- Subsquid unfinalized blocks: https://docs.sqd.dev/sdk/resources/unfinalized-blocks/
- Substreams SQL sink reorg handling: https://docs.substreams.dev/reference-material/sql/reorg-handling
- NEAR Lake Framework (deprecation note): https://docs.near.org/data-infrastructure/tutorials/near-lake-framework
- Nango free self-hosting: https://nango.dev/docs/guides/platform/free-self-hosting

Repository metadata (HIGH, GitHub API, 2026-11-18): dlt-hub/dlt, meltano/meltano, airbytehq/airbyte, apache/nifi, debezium/debezium, apache/seatunnel, onyx-dot-app/onyx, elastic/connectors, rclone/rclone, airweave-ai/airweave, slingdata-io/sling-cli, apache/tika, docling-project/docling, Unstructured-IO/unstructured, microsoft/markitdown, tesseract-ocr/tesseract, PaddlePaddle/PaddleOCR, ggml-org/whisper.cpp, SYSTRAN/faster-whisper, duckdb/duckdb, duckdb/ducklake, apache/iceberg, delta-io/delta-rs, OpenLineage/OpenLineage, ekzhu/datasketch, libyal/libpff, TeamMsgExtractor/msg-extractor. Model licences from Hugging Face model cards: PaddlePaddle/PaddleOCR-VL, allenai/olmOCR-2-7B-1025, ibm-granite/granite-docling-258M.

Secondary and community sources (MEDIUM or LOW):
- Graph-node indexing notes (mirror): https://www.mintlify.com/graphprotocol/graph-node/core-concepts/indexing
- Hugging Face blog on open OCR models: https://huggingface.co/blog/ocr-open-models
- olmOCR-bench aggregation: https://www.codesota.com/ocr/benchmark/olmocr-bench
- whisper.cpp large-v3 on Strix Halo (ROCm): https://github.com/davidguttman/whisper-rocm
- whisper.cpp on Strix Halo with Vulkan: https://github.com/ggml-org/whisper.cpp/discussions/3536
- Phoronix, ROCm 7 on Strix Halo: https://www.phoronix.com/review/amd-rocm-7-strix-halo/3
- Everything (voidtools) USN journal sizing: https://www.voidtools.com/forum/viewtopic.php?p=81400
- Sites.Selected combined with Files.Read.All (community Q&A): https://learn.microsoft.com/en-us/answers/questions/5621045/sites-selected-not-working-as-expected-with-files
- Unstructured data volume survey summary: https://formtek.com/blog/unstructured-data-average-large-medium-sized-companies-manage-20-terabytes-of-unstructured-data/
