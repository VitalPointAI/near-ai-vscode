# Research: multi-user staff projects (sync between people, machines and sites)

Date: 2026-11-19. Research behind `DESIGN.md` in this folder. Read from `origin/main` at d3c2e00c (release 0.4.34).

Confidence tags: **HIGH** = read in our own code, or GitHub and npm metadata fetched on 2026-11-19; **MEDIUM** = project docs or several web sources agree; **LOW** = vendor claims or a single source.

Where the owner's decisions of 2026-11-19 differ from this research, the design follows the owner: co-editing from the first release (the research recommended single-writer products), the hub in the first phases (the research put it fourth), and watches on the hub (the research kept them on an attended machine).

## 1. Findings

1. **Today's staff state cannot be shared.** Each staff ledger is one hash chain per project, signed by this device and checked against keys this install trusts (HIGH). Concurrent appends make two chains with the same `seq`; a merge breaks the chain and products read `draft (tampered)`.
2. **Recommended shape: per-writer signed logs joined into a causal graph**, folded in one deterministic order. This is the shape of Hypercore's Autobase, Secure Scuttlebutt, Radicle and git-bug, and of the paused knowledge base design ("per-compartment streams, per-author hash chains").
3. **No off-the-shelf engine meets every constraint.** CRDT engines do not sign changes or replicate by label; Hypercore needs native modules; Matrix needs a homeserver per site; Electric and PowerSync need a central database and server authority; Ditto is closed. We borrow designs and write our own replication on code we already have.
4. **A CRDT still has a place**: for concurrent text, inside our signed entries. Yjs is the pick for the extension (pure JavaScript, MIT, mature, editor bindings to learn from).
5. **Four transports over one interface**: your organization's sync hub, a LAN peer link, git with one ref per writer, and a sealed bundle file.
6. **Need-to-know at replication**: one stream and one key per label cell, sender filtering, and ciphertext everywhere else.

## 2. Options surveyed

Repository and package facts fetched 2026-11-19 (HIGH unless marked).

| Option | Licence | Latest / activity | Node fit | Signs changes | Label-aware replication | Offline, air gap | Verdict |
|---|---|---|---|---|---|---|---|
| Automerge, automerge-repo | MIT | `@automerge/automerge` 3.5.0 (2026-09); repo 2.6.0-alpha | Rust to WASM | No | No; Keyhive (alpha) adds groups | Yes | Text CRDT candidate; not chosen |
| Keyhive, Subduction | Apache-2.0 | `@keyhive/keyhive` 0.8.2; Subduction "early preview" (MEDIUM) | WASM | Yes (capabilities) | Groups, not lattice labels | Yes | Watch; re-check 2027 |
| Yjs | MIT | 13.6.33 (2026-09); `lib0` 0.2.120 (2026-11) | Pure JavaScript | No | No | Yes, no auth model | **Chosen for text, inside signed entries** |
| y-sweet, y-websocket | MIT | y-sweet last push 2025-12 | JS / Rust server | No | No | Server needed | Not used |
| Loro | MIT | 1.18.0 (2026-11) | Rust to WASM | No | No | Yes | Fallback for text |
| Electric | Apache-2.0 | Active; hosted cloud winding down after a 2026-08 acquisition (MEDIUM) | Postgres and server | No | Server shapes | Server needed for writes | No |
| PowerSync | Service FSL, SDKs Apache-2.0 (MEDIUM) | Active | Postgres or Mongo plus backend | No | Server buckets | Client offline only | No |
| Ditto | Commercial, closed | Active; US defence contracts (LOW, vendor) | SDKs | Not public | Not public | Mesh over Wi-Fi, BLE, LAN | Not usable; evidence the pattern is wanted |
| cr-sqlite | MIT | Last push 2026-08 | Native SQLite extension | No | No | Yes | No (native) |
| Hypercore, Autobase | MIT / Apache-2.0 | hypercore 11.40.4, autobase 7.28.2 | Needs `rocksdb-native`, `sodium-native` | Yes, per writer | No | Yes | Borrow design: per-writer feeds, indexer checkpoints |
| Willow, Earthstar, Meadowcap | LGPL-3.0 (TS) | Last pushes 2025 | TS | Yes | Capabilities by area | Yes | Borrow area capabilities for slices |
| p2panda | MIT / Apache crates | Pre-1.0 (0.7.x) | Rust only | Yes | Access-control CRDT | Yes | Borrow ideas |
| Secure Scuttlebutt | MIT | `ssb-server` last push 2022 | JS | Yes | No | Yes | Dormant; borrow fork-as-evidence |
| Matrix | Spec open; Synapse AGPL-3.0; Dendrite archived 2024 | Room v12 with state res 2.1 (MEDIUM) | Homeserver per site | Yes | Rooms | Federation over intermittent links | Borrow "auth at the causal point"; do not run |
| Nostr | Libraries MIT | `go-nostr` archived 2025-11 | JS libs | Yes | No | With own relay | Borrow "signed events, dumb relay" |
| Git with merge drivers | GPL-2.0 binary we already call | Stable | Already used | Commit signing only | No | `git bundle` | Transport only |
| git-bug | GPL-3.0 | Active | Go | No | No | Yes | Borrow operation logs per entity in refs |
| Radicle (heartwood) | Apache-2.0 | 1.0 2024-09, 1.1 2024-12 (MEDIUM) | Rust | Yes, per-peer namespaces | Seeding policy | Yes | Borrow per-writer namespaces, seed role |
| Our own replication | Ours | n/a | Node, no dependencies | Yes | Yes | Yes | **Chosen** |

## 3. CRDT choice for co-edited text

| | Yjs | Loro | Automerge |
|---|---|---|---|
| npm, 2026-11-19 | 13.6.33, MIT, depends only on `lib0` (MIT) | `loro-crdt` 1.18.0, MIT | `@automerge/automerge` 3.5.0, MIT |
| Implementation | Pure JavaScript | Rust to WASM | Rust to WASM |
| Native modules | None | None (WASM) | None (WASM) |
| Maturity | In wide production since 2019; bindings for CodeMirror, Monaco, ProseMirror | Young, fast-moving | Mature; 3.0 cut memory more than tenfold (MEDIUM) |
| Relative positions for cursors | Yes | Yes | Yes (cursors API) |
| Fits the extension bundle and Theia | Yes, plain source through esbuild | WASM load in extension host | Same as Loro |
| Pick | **Yes** | Fallback | No |

None of the three signs changes or controls who may write. The design wraps update bytes in signed, encrypted entries and checks in the fold that each update only inserts under client ids registered to its writer, which gives attribution that cannot be forged.

## 4. Lessons taken

- **Matrix**: check authority at the causal point an entry cites, not by wall clock; keep authority changes linear, because general state resolution over concurrent membership changes has produced security bugs (state resets fixed only in room version 12 in 2025, CVE-2025-49090, MEDIUM).
- **Autobase**: writers append locally; a named indexer (our hub) signs checkpoints after which order is final.
- **Secure Scuttlebutt and Hypercore**: two signed entries at one position by one writer are a portable proof of misbehaviour.
- **Willow and Meadowcap**: a capability names an area (who, path, time) and narrows when delegated; we use it for observation slices.
- **Radicle and git-bug**: one ref namespace per writer makes git pushes race-free and fetch a set union.
- **Nostr**: signed events and a store-and-forward relay that cannot forge.
- **Paused knowledge base design**: ciphertext relay with append checks, per-compartment streams, lockbox key wraps, malicious-relay harness and two-compartment indistinguishability test.

## 5. Size estimates (to be measured)

| Stream | Rough size | Approach |
|---|---|---|
| Ledger and decision entries | About 1 KB each; a busy day a few thousand | Trivial for every transport |
| Product text updates | Small per typing batch; full state tens of KB per product | Compaction after checkpoints |
| Observations | About 0.5 KB a row; 100 rows a second is about 4 GB a day before compression | Segments as blobs, slices, coalescing, per-link budgets |
| Presence | A few hundred bytes every few seconds per person | Live links only, never stored |

## Sources

Own repository (HIGH): `src/domain/staff/ledger.ts`, `personDecisions.ts`, `ownership.ts`, `release.ts`, `obs/store.ts`; `src/staff/staffHost.ts`, `registerLock.ts`, `staffFiles.ts`, `watchAttendance.ts`, `observationStore.ts`, `logisticsHost.ts`; `src/services/staffCommands.ts`, `stateTransport.ts`; `src/team/*`; `src/domain/team/*`; `src/domain/state/records.ts`, `merge.ts`; `relay/compose.yaml`, `relay/README.md`; the staff teams design and note 11; the paused knowledge base research and roadmap.

Repository and package metadata (HIGH), GitHub API and npm registry, 2026-11-19: automerge/automerge, automerge/automerge-repo, inkandswitch/keyhive, yjs/yjs, yjs/y-websocket, jamsocket/y-sweet, loro-dev/loro, neondatabase/electric, powersync-ja/powersync-service, vlcn-io/cr-sqlite, holepunchto/hypercore, holepunchto/autobase, earthstar-project/earthstar, earthstar-project/willow-js, p2panda/p2panda, ssbc/ssb-server, element-hq/synapse, matrix-org/dendrite, nbd-wtf/go-nostr, git-bug/git-bug, radicle-dev/heartwood; npm `yjs`, `lib0`, `y-protocols`, `loro-crdt`, `@automerge/automerge`, `hypercore-storage` (depends on `rocksdb-native`), `sodium-universal` (depends on `sodium-native`), `@keyhive/keyhive`.

Web (MEDIUM unless marked):
- Automerge 3.0: https://automerge.org/blog/automerge-3/
- Keyhive: https://www.inkandswitch.com/project/keyhive/ ; https://automerge.org/docs/keyhive/ark-api-guide/
- Subduction: https://www.inkandswitch.com/newsletter/dispatch-014/ ; https://github.com/inkandswitch/subduction
- Autobase: https://docs.pears.com/building-blocks/autobase
- Matrix state resolution: https://matrix.org/blog/2025/08/project-hydra-improving-state-res/ ; https://matrix.org/docs/spec-guides/state-res-2.1/ ; https://spec.matrix.org/v1.19/rooms/v12/
- Element in defence (LOW, vendor): https://element.io/case-studies/bundeswehr ; https://element.io/mission-partner-environments
- Meadowcap and Earthstar: https://opencollective.com/earthstar/updates/meadowcap
- p2panda: https://nlnet.nl/project/P2Panda-groups/ ; https://docs.rs/crate/p2panda/0.7.1
- Radicle: https://radicle.xyz/2024/09/10/radicle-1.0.0 ; https://radicle.xyz/guides/protocol
- git-bug data model: https://github.com/git-bug/git-bug/blob/master/doc/model.md
- Electric acquisition: https://thenewstack.io/databricks-electric-wasm-agentic-postgres/
- PowerSync licensing: https://www.powersync.com/legal/licensing-terms
- Ditto defence awards (LOW, vendor and trade press): https://www.ditto.com/press-releases/us-air-force-awards-950m-contract-ditto-command-control
- Yjs: https://github.com/yjs/yjs ; https://docs.yjs.dev/
- y-sweet: https://github.com/jamsocket/y-sweet
