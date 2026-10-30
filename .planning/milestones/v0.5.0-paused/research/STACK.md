# Technology Stack: v0.5.0 Trusted-source knowledge base (additions only)

**Project:** NEAR AI for VS Code
**Milestone:** v0.5.0 (subsequent milestone; existing stack in `.planning/codebase/STACK.md` is NOT re-researched)
**Researched:** 2026-10-28
**Overall confidence:** MEDIUM-HIGH. Versions, licenses, and sizes below were read from the npm registry on 2026-10-28 or measured from the package tarballs (HIGH). Behavioural claims that rest on web search alone are tagged LOW or MEDIUM in the text. Items needing a spike are listed at the end.

## Guiding decisions (read this first)

1. **Prefer `node:crypto` over a crypto library.** The extension host is Node 22 (VS Code >= 1.101, Electron 35). `node:crypto` already provides Ed25519 sign/verify, X25519, HKDF, scrypt, AES-256-GCM and ChaCha20-Poly1305, and I confirmed these work on a local Node. It does not provide Argon2 (`crypto.argon2Sync` appears only in Node >= 24.7; the local Node 24 has it and Node 22 does not, so feature-detect it and fall back to scrypt). Add a library only for the one thing `node:crypto` lacks: a standard way to seal a key to a public-key recipient. For that, use `age-encryption`.
2. **The signed, encrypted event log is the source of truth; SQLite is a disposable read model.** "SQLite vs. event log with snapshots" is a false choice. The log is needed anyway (sharing, temporal replay, audit). Query slices need an indexed store. Build both: log is canonical, `sql.js` (in-memory SQLite in a worker thread) is the projection, persisted as an encrypted snapshot.
3. **Per-compartment key wrapping, not MLS, for group keys.** This knowledge base is durable shared state that new members must read from the start. MLS gives forward secrecy and post-compromise security, which work against late joiners reading history. Wrapping a compartment key to N members costs O(N) small records, which is fine into the thousands. MLS (`ts-mls`) is documented as an escalation path behind an interface, not a v0.5.0 dependency.
4. **Globe: MapLibre GL JS 6.x in globe projection, fully offline by default.** About 1.7 MB against about 14 MB for CesiumJS, per-layer visibility and time filtering are native style features, and the webview CSP can forbid all remote loads.
5. **Network diagram: Cytoscape.js** with compound nodes and fCoSE layout.
6. **Prediction: write it, do not install it.** There is no maintained JS library for Hawkes processes or forecast calibration. The math is small (EM for an exponential-kernel Hawkes, Beta/Gamma conjugate updating, Brier scoring, isotonic calibration) and should be unit-tested in-repo. Run it in a `worker_thread`.
7. **Everything ships vendored.** Follow the existing pattern: pinned `devDependencies`, bundled by `scripts/vendor-libs.mjs` (esbuild 0.28.2 is already there) into `vendor/<name>/` with `LICENSES.txt` and rows in `vendor/manifest.json` (feeds the extension SBOM). Webview libraries are bundled as browser IIFE/ESM and loaded through `webview.asWebviewUri`.

## Recommended stack

### 1. Local store: encrypted graph with time-stamps, revisions, slicing

| Technology | Version | Purpose | Runs in | Why |
|---|---|---|---|---|
| `sql.js` | 1.15.2 (MIT) | In-memory SQLite read model: sources, claims, actors, events, grade history, slices | Extension host, inside a `worker_thread` | Smallest mature SQLite-in-WASM that runs in Node with no native module and no persistence assumptions. `sql-wasm.wasm` is 685 KB, `sql-wasm.js` 47 KB. Same vendoring pattern as `@resvg/resvg-wasm`, which is already shipped. |
| `node:crypto` AES-256-GCM | built-in | Encrypt snapshot files at rest | Extension host | Same primitive and key-in-SecretStorage pattern already used for conversation storage. Reuse that code, do not add SQLCipher. |

How it fits together:
- **Persistence:** `db.export()` gives the whole database as a `Uint8Array`. Encrypt it (HKDF subkey per file, random 96-bit nonce, AAD = file name + schema version), write to a temp file, then atomic rename. Write snapshots on idle or debounce, never per event. Between snapshots, durability comes from the local append-only log tail, which is already encrypted.
- **Bitemporal schema (answers "roll time back"):** every claim carries `occurred_at`, `reported_at`, and a separate append-only `grade_history(claim_id, graded_at, reliability, credibility, evidence, reason, by_actor)`. "State as of T" is a query (`reported_at <= T` plus the last grade with `graded_at <= T`), not a replay. Replay for the UI is a cursor over those columns.
- **Slicing:** b-tree indexes on `occurred_at`, a coarse spatial cell id (integer tile or geohash prefix), and join tables for topic and actor sets. Final bounding-box and polygon filtering happens in code.
- **Limits of the chosen build (verified by inspecting the shipped wasm):** compiled with FTS3/FTS4 only. **No FTS5, no R*Tree.** JSON functions are present. FTS4 is enough for claim and source text search. The whole database lives in WASM memory (32-bit, 2 GB ceiling), and export cost is linear in size. Plan for a working ceiling of roughly 300k claims with their edges (about 300 MB). That is an estimate, so benchmark in the store phase. The product brief gives no volume figure, so ask for one in discuss-phase.
- **Do the heavy work off the host thread.** Import, snapshot export, replay-to-snapshot rebuilds, and forecasting run in a `worker_thread` so the extension host stays responsive.

Escalation path (do not build now): `@journeyapps/wa-sqlite` 2.0.10 ships `mc-wa-sqlite.wasm` (1.3 MB, SQLite3 Multiple Ciphers, FTS5 enabled; MIT per its LICENSE file). It would give page-level encryption and FTS5 but needs a custom Node VFS (plus a license-file check, because its README text about licensing is confusing). Take that road only if the in-memory ceiling is hit.

### 2. Signed, end-to-end encrypted, append-only event log (git / shared folder / org relay)

| Technology | Version | Purpose | Runs in | Why |
|---|---|---|---|---|
| `node:crypto` | built-in | Ed25519 signatures, SHA-256 content addressing, HKDF per-event subkeys, AES-256-GCM payload encryption | Extension host and relay | OpenSSL-backed, no dependency, same code on client and relay. |
| `age-encryption` | 0.3.1 (BSD-3-Clause) | Seal compartment keys to each member's recipient string (`age1...`); optional hybrid post-quantum recipients (`generateHybridIdentity`) | Extension host (and relay tooling) | age is a small, specified, widely reviewed format by Filippo Valsorda. "Invite by public key" maps directly onto an age recipient. Dependencies are only `@noble/{curves,ciphers,hashes,post-quantum}` and `@scure/base`. Node 20+. Pre-1.0 package, so pin the version and wrap it behind our own `KeyWrap` interface. |
| `git` CLI via `node:child_process` | system | Git transport | Extension host | Already used for worktrees (`src/agent/worktree.ts`). Reuses the user's existing credentials and config. |

Design that follows from the stack:
- **Identity per member:** one 32-byte seed in SecretStorage, expanded with HKDF into an Ed25519 signing key and an X25519/age encryption identity. The shareable "member card" is `{age recipient, ed25519 public key}` plus a self-signature and a short fingerprint for out-of-band verification. The invitation is the card.
- **Event envelope:** a signed cleartext header and an encrypted body. Header: `{v, compartmentId, epoch, authorKeyId, hlc, prevHashes, kind, bodyHash}`. Body: AES-256-GCM under a per-event subkey `HKDF(compartmentKey, eventId)`, so there is no nonce-reuse risk. Signature covers header and ciphertext hash.
- **Compartments and roles:** each compartment has its own symmetric key per epoch, wrapped (age) to each member with access. Roles (reader / analyst / approver / admin) and membership are themselves signed events in a membership chain, in cleartext so a relay can enforce them. This leaks the set of pseudonymous member key ids and roles to the host or relay. State that in the privacy copy.
- **Removal:** an admin-signed event creates epoch n+1 for the affected compartment, wrapped to the remaining members only. Removed members keep epochs they already held (matches the brief). The wrap record is about 150-250 B per member for X25519 recipients; hybrid PQ recipients are much larger (on the order of 1.5 KB per member, LOW confidence, measure), so make PQ an org-policy option, not the default.
- **Merge-friendliness:** one immutable file per event, named by content hash, under `log/<compartment>/<author>/`. Nothing is ever edited, so git merges and folder syncers never conflict. Use a hybrid logical clock (hand-written, about 50 lines) for ordering. Do not use `Date.now()` alone, and no Temporal polyfill is needed.
- **Snapshots:** a member with the analyst or admin role periodically publishes a signed, encrypted snapshot (the same encrypted `sql.js` export, plus the log frontier it covers). New clients load the latest verified snapshot, then replay only the tail. Clients verify every signature and every role themselves; the host or relay is never trusted for integrity.
- **Transport interface:** `LogTransport { listSince(frontier), fetch(ids), append(event) }` with three implementations: git, folder, relay. The core never knows which one it is on.

### 3. Organisation-scale sharing: self-hosted relay, group keys for hundreds of members

#### 3a. Group key management: per-compartment wrapping versus MLS

| Option | Version | Verdict |
|---|---|---|
| **Per-member key wrapping with age (recommended)** | `age-encryption` 0.3.1 | Rekey cost is O(members with access) small records. 500 members is about 100 KB of wraps for X25519 recipients. Works offline, works over git, a folder, or a relay, and gives new members full history, which the knowledge base needs. Compartments map one-to-one onto keys. The tradeoff is that there is no forward secrecy or post-compromise security: if a member's device is compromised, everything they could read is exposed. Mitigate with rotation on removal and on compromise. |
| MLS via `ts-mls` | 1.6.4 (MIT), dependency `@hpke/core` 1.9.0 | Not for v0.5.0. Its README says it has **not had a formal security audit**, and I could not find independent evidence that it passes the mlswg interop vectors (the search turned up nothing either way). MLS needs a delivery service to order commits, which the relay could provide, but not git or a folder. Its forward secrecy fights history access for late joiners; that would need a second history-key scheme alongside it. Keep the `KeyWrap`/`GroupKey` interface narrow so MLS can be added later for a compartment that truly needs forward secrecy. |
| OpenMLS compiled to WASM | none | I found no maintained npm package or reliable WASM build (LOW confidence: negative search result only). It would add a Rust toolchain and WASM glue to the build, plus a second crypto stack. Reject. |

Scaling notes for per-compartment wrapping: wrap on demand (publish a new epoch record only when membership or access changes), keep a key hierarchy of org root -> compartment key so a role change touches one compartment, and cache unwrapped keys in memory only (the long-lived secret is the member seed in SecretStorage). Budget: hundreds of members x tens of compartments = thousands of wraps in total, a few hundred KB, entirely fine.

#### 3b. The relay (self-hosted, sees only ciphertext, checks append signatures and roles)

| Technology | Version | Purpose | Why |
|---|---|---|---|
| Node.js | 24 LTS for the relay container (the relay does not run in VS Code, so it is not bound to the extension host's Node 22) | Runtime | Same language and the same `src/shared/log` verification code as the extension. Not subject to the extension's no-native-module rule, though we still avoid native modules to keep the image simple. |
| `node:http` + `node:crypto` | built-in | HTTP API and signature checks | **Recommended: zero runtime dependencies.** A security product's server should have a tiny supply chain. The API is small (below). |
| Storage: content-addressed files + `node:sqlite` index | built-in | Event blobs on disk, index of `(compartment, author, seq, hash)` | Built into Node 22.5+ and 24 with no native build. Node's docs still mark it as in development or release-candidate, so confirm its stability level in the Node 24 docs when you pick it up (MEDIUM confidence). Fall back to an append-only JSONL index plus plain files if you prefer zero risk. The relay never decrypts, so encryption at rest of the blobs adds nothing beyond disk-level encryption. |
| Push to clients | Server-Sent Events over HTTP | Live "new events" notifications | No dependency on `ws`. The client uses global `fetch` streaming in Node 22. SSE reconnect with `Last-Event-ID` fits an append-only log well. If a bidirectional socket is ever needed: `ws` 8.22.0 (MIT) on the server, Node 22's built-in global `WebSocket` on the client. |
| Optional framework | `hono` 4.13.14 + `@hono/node-server` 2.1.5 (MIT) | Only if routing and validation grow | Not needed for about 6 endpoints. `fastify` 5.12.7 is the heavier alternative. Not recommended. |

Relay API (sketch, to confirm in the architecture phase): `POST /v1/append` (verify header signature, verify author's role for that compartment and epoch from the membership chain, reject on mismatch, rate limit); `GET /v1/log?since=<frontier>`; `GET /v1/blob/<hash>`; `GET /v1/stream` (SSE); `GET /v1/membership`. Authentication is a per-request Ed25519 signature over method, path, timestamp and body hash by a member key (no passwords, no tokens to leak); the org can additionally put it behind mTLS or an OIDC proxy. TLS is terminated by the organisation's reverse proxy. The relay enforces roles for spam and availability control; clients re-verify everything, so a malicious relay can withhold or reorder data but cannot forge or read it.

Packaging the relay:
1. **OCI image (primary):** multi-stage Dockerfile, esbuild-bundled single file `relay.mjs`, on `gcr.io/distroless/nodejs24` (or `node:24-slim`), non-root user, read-only root filesystem, one volume `/data`. Publish to GHCR with the SBOM (extend `scripts/extension-sbom.mjs`) and a signature (cosign). Ship an example `compose.yaml` and a Helm-free `kubectl` manifest in `docs/`.
2. **npm package for `npx`/systemd users:** `@vitalpoint/near-ai-kb-relay` containing the same bundle. (Name is a placeholder; confirm the publisher scope.)
3. **Source in the extension repo, not in the VSIX by default:** `packages/relay/` sharing `src/shared/log/*` with the extension (monorepo workspace or a path alias bundled by esbuild). A VS Code command "Export relay bundle" may drop the 100 KB bundle and a Dockerfile into a chosen folder. Node SEA single-binary packaging is possible but still evolving (LOW confidence); do not rely on it.
4. Backup is a copy of `/data`; retention is "append-only, compact via client-published snapshots" because the relay cannot read or compact ciphertext.

### 4. Network diagram for the RAFT graph (webview)

| Library | Version | License | Purpose | Why |
|---|---|---|---|---|
| `cytoscape` | 3.34.4 | MIT | Graph rendering and interaction in the webview | Compound nodes (group actors by organisation or function), per-element data-driven styles (edge colour and width from tension sign and strength, node badges for Admiralty grade), selectors for slicing and highlighting, edge arrows and labels, built-in `cy.png()` export, mature and actively released (last release 2026-10-15). Canvas renderer is plenty for slices of hundreds to a few thousand nodes. |
| `cytoscape-fcose` | 2.2.0 | MIT | Force layout with compound-node and constraint support | Best-quality compound layout in the Cytoscape ecosystem. Last published 2023 (stable, but not actively maintained). Pulls `cose-base` 2.2.0 and `layout-base` 2.0.1 (MIT). |
| `cytoscape-cola` | 2.5.1 | MIT | Optional constraint-based layout for stable incremental updates during time replay | Add only if fCoSE re-layouts jump too much during replay. |

Do not use `elkjs` (current 0.12.1): its license is **EPL-2.0 OR GPL-3.0-or-later**, which complicates Marketplace redistribution and the SBOM. Do not use `cytoscape-svg` 0.4.0: **GPL-3.0**. For vector export, write about 80 lines that build SVG from node positions and styles, or use `cy.png({full: true, scale: 2})`.

Alternatives considered: **Sigma 4.0.4 + graphology 0.26.0** (MIT) is faster at tens of thousands of nodes (WebGL), but compound nodes, rich labels and edge styling take extra programs and plugins (`@sigma/edge-curve` 3.1.0); this product's diagrams are slices, so quality beats raw scale. **vis-network 10.1.4** (Apache-2.0 OR MIT): 84 MB unpacked, weaker styling. **@antv/g6 5.1.1** (MIT): capable but a heavier, less commonly vetted dependency. Cytoscape has an experimental WebGL renderer (since 3.31; some styles unsupported; maintainers call it a preview), so treat it as an opt-in for large slices only, not a dependency of the design.

The scale control is the slice itself. Cap rendered nodes (for example 2,000) and tell the user when a slice is truncated.

### 5. Open-source 3D globe with toggleable layers, open imagery, offline / no area-of-interest leak

| Technology | Version | License | Purpose | Why |
|---|---|---|---|---|
| `maplibre-gl` | 6.16.0 | BSD-3-Clause | Globe rendering in a webview | Globe projection is mature in 6.x (release notes show continued globe fixes for fill/line near poles, symbols, raster, custom layers, sky, poles reachable since 6.13.0; no open limitations listed). Download size is about 1.1 MB main + 0.5 MB worker + 72 KB CSS (measured). Layers: one GeoJSON source and layer group per OSINT source or source type, toggled with `setLayoutProperty(id, 'visibility', ...)`. Time replay is a filter expression on a `t` property, so no re-upload of data. Clustering is built in to GeoJSON sources. WebGL2 required. |
| `pmtiles` | 4.5.0 | BSD-3-Clause | Read vector or raster tile archives from a local single file | Lets the user bring an offline basemap (a Protomaps extract, ODbL data from OSM) without a tile server. |
| Natural Earth data | current release | Public domain | Bundled basemap: country boundaries, coastlines, populated places, and a low-zoom raster | Needs no attribution, no token, no network. A shaded-relief raster pyramid up to zoom 4 is about 341 tiles (estimate several MB; measure). Generate at build time into one PMTiles file in `vendor/basemap/`. |
| NASA GIBS | n/a (service) | Open NASA data, no key (terms page not confirmed in my fetch, check before shipping, MEDIUM) | Optional imagery, including daily time-dimension layers | Endpoint pattern `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/<layer>/default/<date>/<tileMatrixSet>/{z}/{y}/{x}.<ext>`. Every tile request tells GIBS what area the user is viewing. See the leak design below. |

No-leak design (this is the point of the choice):
- **Default is offline.** Bundled Natural Earth PMTiles only. The webview CSP carries no `https:` origin at all: `default-src 'none'; img-src ${cspSource} data: blob:; connect-src ${cspSource}; worker-src blob:; script-src 'nonce-...'; style-src ${cspSource}`. Any bug or injected content that tries to load a remote tile then fails by construction. This is the strongest guarantee available and it is cheap.
- **Tiles via message passing:** a custom `Source` for `pmtiles` (and `addProtocol` for MapLibre) asks the extension host for byte ranges of a local file and the host reads them. The webview never needs a network origin, and the host can log nothing about the viewed area.
- **Optional online imagery (GIBS):** off by default and gated behind a consent prompt that says the viewed area is revealed to NASA. A better option is an explicit "download global overview" action that fetches the whole world at a fixed low zoom (levels 0 to 5, about 1,365 tiles). This reveals nothing about the user's area of interest and can then be used offline. Do not prefetch the standard OSM tile servers (their usage policy forbids bulk downloads); use PMTiles extracts instead.
- **Worker under CSP:** v6 is ESM-only and loads its worker from a real URL. A webview cannot always start a Worker from a `vscode-webview-resource` URL, so plan to fetch the worker script text and start it from a Blob URL via `setWorkerUrl` with `worker-src blob:` (Mappedin and MapLibre docs describe `setWorkerUrl`; whether VS Code's webview origin accepts a direct URL is unconfirmed, see spikes).

Rejected for v0.5.0:
- **CesiumJS 1.146.0 (Apache-2.0).** Strong for true 3D, terrain, 3D Tiles, CZML and a built-in clock and timeline. Costs: `Build/Cesium` is about 14 MB (Cesium.js 5.9 MB, Assets 4.7 MB, Workers 1.2 MB, ThirdParty 1.1 MB, Natural Earth II imagery only 608 KB), needs `'wasm-unsafe-eval'` and several workers, and its defaults reach for Cesium ion (default imagery, geocoder). An offline setup works (`baseLayer` pointed at the bundled `Assets/Textures/NaturalEarthII`, `baseLayerPicker: false`, `geocoder: false`, ellipsoid terrain) but every default has to be switched off and verified in a network trace. Revisit only if the requirement grows to 3D terrain relief or 3D Tiles; the layered-events model does not need it.
- **deck.gl 9.4.0 (MIT):** useful for very large point sets and arcs, but adds about 6 MB unpacked and its interleaving with the MapLibre globe was not verified (LOW). MapLibre clustering is enough.
- **globe.gl 2.46.2 (three.js):** pretty, not a GIS: no vector basemap, no PMTiles, weaker layer model.

Spatial helpers: `@turf/boolean-point-in-polygon` 7.4.0, `@turf/bbox` 7.4.0, `@turf/distance` 7.4.0 (all MIT, modular, tree-shaken with esbuild), not the full `@turf/turf` bundle. `flatbush` 4.6.2 (ISC) for an in-memory bbox index over a slice if SQL cell filtering is not enough. `mgrs` 2.2.0 (MIT) for MGRS to lat/lon, which defence and law-enforcement users will paste. `@types/geojson` 7946.0.16 (dev only).

### 6. Offline gazetteer

| Data | Size (verified 2026-10-28 from download.geonames.org) | Use |
|---|---|---|
| `cities15000.zip` | 3.2 MB (about 25k places) | **Ship in the VSIX** as a preprocessed database. |
| `cities5000.zip` / `cities1000.zip` | 5.5 MB / 11 MB | Optional download packs. |
| `cities500.zip` | 13 MB (about 200k+ places) | Optional "detailed gazetteer" pack, downloaded once from the GeoNames dump server with a hash pinned in the extension. |
| `allCountries.zip` | 403 MB | **Do not bundle or load.** If ever offered, filter to feature classes A, P, H, T, L and to the countries of interest at pack-build time. |
| `alternateNamesV2.zip` | 196 MB | Do not bundle. Filter to preferred names in the languages the user chooses and add as an optional pack. |
| `admin1CodesASCII.txt`, `countryInfo.txt` | 148 KB, 31 KB | Ship (resolves region and country names). |

- **License:** GeoNames data is CC BY (the site says "cc-by licence", commercial use allowed). Redistribution inside the VSIX is fine with attribution in the README, the Third-Party notices, and the globe credits. Add the dataset to `vendor/manifest.json`.
- **Index format:** a build step (`scripts/build-gazetteer.mjs`, run at compile like `vendor-libs.mjs`) emits a read-only `gazetteer.sqlite` opened with `sql.js` (the gazetteer is not secret, so it is not encrypted). Table `places(id, name, ascii, norm, lat, lon, cc, admin1, fcode, pop)` with a b-tree index on `norm` (NFKD, diacritics stripped, lower-cased), prefix lookups with `norm >= ? AND norm < ?`, and an FTS4 table over names and alternates. Rank by exact match, then population, then feature class, then document context (country or region hints). Return a candidate list with confidence; **never silently pick** between "Paris, FR" and "Paris, TX". The agent or analyst resolves ambiguity and the choice is recorded as a claim attribute.
- **What it is not:** it is not street-level. Address geocoding offline (Nominatim, Pelias, Photon) is a different scale of problem (tens of GB). Treat it as out of scope; accept user-supplied coordinates, MGRS, and GeoJSON for precise locations.
- **Privacy:** every lookup is local. Do not write query strings to logs or telemetry.

### 7. Import formats and feeds

| Library | Version | License | Purpose | Why |
|---|---|---|---|---|
| STIX 2.1 | none (write a reader) | n/a | Import STIX bundles | A bundle is plain JSON (`{type: "bundle", objects: [...]}`). The one maintained JS package, `stix2` 1.1.0 (ISC), was last published 2022-08 and is a builder, not a robust importer. Write a typed reader mapping `identity`, `threat-actor`, `intrusion-set`, `campaign`, `location` (has latitude and longitude), `relationship` (`source_ref`, `target_ref`, `relationship_type`), `sighting`, `report`, `indicator` and `observed-data` to the graph. Validate shape in code and drop unknown types with a visible import report. Avoid pulling `ajv` 8.20.0 plus the OASIS JSON schemas just for this. |
| Admiralty mapping in STIX | n/a | n/a | Credibility | STIX `confidence` (0-100) maps to Admiralty credibility with the table in the STIX confidence-scale appendix, as implemented by the reference Python library: 1 = 90, 2 = 70, 3 = 50, 4 = 30, 5 = 10, 6 has no STIX value; reverse bands 80-100 = 1, 60-79 = 2, 40-59 = 3, 20-39 = 4, 0-19 = 5 (MEDIUM confidence: read from secondary sources, not the spec text itself, because the spec page truncated). STIX has **no source-reliability field**: on import, read the MISP taxonomy tags `admiralty-scale:source-reliability="a".."f"` and `admiralty-scale:information-credibility="1".."6"` if present, otherwise a custom `x_` property, otherwise mark ungraded for an agent to propose. On export, emit the same tags. |
| `papaparse` | 5.7.0 | MIT | CSV import | Delimiter auto-detection, BOM and quote handling, header mapping, tolerant of messy analyst files, small (271 KB unpacked). `csv-parse` 7.0.3 (MIT) is the alternative; pick one, and papaparse wins on messy input. Write CSV by hand and **escape formula-injection prefixes (`=`, `+`, `-`, `@`, tab, CR)** in every exported cell. |
| GeoJSON (RFC 7946) | none (write a reader) | n/a | Import | `FeatureCollection` / `Feature` with WGS84 lon/lat order. Map `properties` to claim fields through a mapping dialog; accept a time property or a `when` member. Validate coordinate ranges. No library needed. |
| `feedsmith` | 3.0.1 | MIT | RSS 2.0, Atom, RDF, JSON Feed, OPML | Typed, tolerant of namespace oddities, `sideEffects: false`, ESM and CJS, 808 KB unpacked, depends on `fast-xml-parser` ~5.11.1 and `entities` ^7.0.1. Gap: it does not list GeoRSS (`georss:point`) among its namespaces, so read GeoRSS from a second pass with `fast-xml-parser` directly. |
| `fast-xml-parser` | 5.11.2 (pin >= 5.5.6) | MIT | Transitive via feedsmith | **Security-relevant:** CVE-2026-26278 (unbounded DOCTYPE entity expansion, fixed 5.3.6) and CVE-2026-33036 (numeric entity bypass, fixed 5.5.6 per IBM's record; other sources give a slightly different range). Add an `overrides` entry pinning `>=5.11.2`, and configure the parser with DOCTYPE processing off. Feeds are untrusted input. |

Rejected: `rss-parser` 3.13.0 (last published 2023, drags in `xml2js`).

Feeds fetched by the extension must go through the existing fetch path with untrusted-content fencing, hidden-content stripping, and injection detection. Feed item text is attacker-controlled and is later shown to models. Fetching a feed reveals the user's interest to that host, so feeds are an explicit per-feed opt-in. MCP feeds use the existing MCP client; watched folders use `fs.watch` plus the same import readers.

### 8. Forecasting, prediction, and calibration (local JS, no new heavy dependency)

| Method | Implement as | Use for | Notes |
|---|---|---|---|
| Bayesian updating | Conjugate models in about 150 lines: Beta-Binomial (event happens or not), Dirichlet-Multinomial (scenario sets), Gamma-Poisson (event rates). Log-odds evidence ledger where each evidence item contributes a likelihood ratio weighted by its Admiralty grade. | Scenario probabilities with a visible "why" | Fully explainable: the report can list each evidence item and its effect on the odds. This answers "probabilities and their evidence". |
| Hawkes process (exponential kernel) | EM fit with closed-form M-step (no optimizer dependency), seeded simulation by Ogata thinning, a multivariate version for actor-pair excitation | "Events beget events" escalation, tension trends between actors | O(n) recursions for the exponential kernel. Spatiotemporal Hawkes on ACLED-type data is established in the literature, with exponential kernels preferred for tractability. Needs a seeded PRNG: write sfc32 or xoshiro128** (about 15 lines) so forecasts are reproducible; `pure-rand` 8.4.2 (MIT) is an acceptable substitute. |
| Tension trend (RAFT) | Discounted Beta posterior per relationship (exponential forgetting) plus a local-level Kalman filter on a tension score; Bayesian online change-point detection for regime shifts | "Is this relationship getting worse or better, and how sure are we" | About 200 lines total. No matrix library needed. |
| Temporal link prediction | Recency-weighted neighbourhood heuristics (time-decayed common neighbours, Adamic-Adar) and Hawkes pair intensity | Which relationships are likely to appear | Deterministic and explainable. |
| LLM scenario generation (user choice: TEE) | NEAR TEE model returns structured scenarios with stated probabilities; **calibrate** them against the track record | Narrative scenarios | Only models the user already allows for this project. Stated probabilities are inputs, not outputs: pass them through the calibration layer below. |
| Credible intervals | `@stdlib/stats-base-dists-beta-quantile` 0.2.3 (Apache-2.0 AND BSL-1.0 via `betaincinv`) | Beta quantiles for intervals | Optional; or implement a bisection on the regularised incomplete beta. |

Calibration (write in-repo, unit-test against known values): Brier score and its decomposition (reliability, resolution, uncertainty), multi-class Brier or ranked probability score, log score, reliability diagram with fixed-width and equal-mass bins, expected calibration error, Brier skill score against the base rate, **isotonic regression by pool-adjacent-violators** (about 40 lines) and Platt scaling for recalibration, with minimum-sample guards (do not recalibrate on fewer than about 30 resolved forecasts; show "insufficient history" instead of a false-precision number). Resolve forecasts automatically when their resolution event arrives in the base; record the forecast, its inputs, and the model version as append-only events so any past forecast can be re-explained.

Where it runs: all of the above are small statistical models. Default to local and run in a `worker_thread` so the extension host never blocks. "Train on TEE" for this milestone means asking a TEE model to reason over a slice, not shipping gradients; offer it as the user's choice per project.

## Alternatives considered

| Category | Recommended | Alternative | Why not |
|---|---|---|---|
| Local store | `sql.js` read model over an encrypted event log | `node:sqlite` | Plaintext on disk (no encryption), experimental on Node 22, and the extension's engine floor is Node 22. Revisit when the floor moves to Node 24. |
| Local store | `sql.js` | `node-sqlite3-wasm` 0.8.61 (MIT) | Writes straight to a plaintext file through a file VFS. Violates encrypt-at-rest. |
| Local store | `sql.js` | `@sqlite.org/sqlite-wasm` 3.54.1-build1 (Apache-2.0) | Its own README: Node supports in-memory databases without persistence. Same capability as `sql.js` with a larger surface. |
| Local store | `sql.js` | `@journeyapps/wa-sqlite` (mc build) | Real page-level encryption and FTS5, but needs a custom Node VFS. Escalation path only. |
| Local store | `sql.js` | Pure append-only log, no SQL | Slicing by time, place, topic and actor set becomes hand-written index code. |
| Crypto | `node:crypto` + `age-encryption` | `libsodium-wrappers-sumo` 0.8.4 (ISC, 554 KB unpacked, WASM) | Duplicates what OpenSSL gives for free; the only gain is XChaCha20 and sealed boxes, which per-event HKDF subkeys and age cover. |
| Crypto | `node:crypto` | `@noble/curves` 2.4.0, `@noble/ed25519` 3.2.0, `tweetnacl` 1.0.3 | Pure-JS reimplementations of primitives Node already has natively. `tweetnacl` was last published 2023. (noble still arrives transitively through age.) |
| Key sealing | `age-encryption` | Hand-rolled ECIES from X25519 + HKDF + AES-GCM | About 40 lines and no dependency, but a bespoke format. Take it only if the `age-encryption` pre-1.0 API proves unstable. |
| Group keys | per-compartment wrapping | MLS (`ts-mls` 1.6.4) | Unaudited per its README; forward secrecy conflicts with history access; needs ordered commits. See 3a. |
| Sync | `git` CLI | `isomorphic-git` 1.44.7 (MIT, 5 MB unpacked) | Slower, extra credential handling. System `git` is already a dependency. |
| Relay | `node:http` + SSE | Hono / Fastify / `ws` | Framework weight and supply chain for about 6 endpoints. |
| Graph view | Cytoscape.js | Sigma 4.0.4 + graphology; vis-network; G6 | See section 4. |
| Globe | MapLibre GL JS globe | CesiumJS 1.146.0; deck.gl 9.4.0; globe.gl | See section 5. |
| CSV | `papaparse` | `csv-parse` | Both fine; papaparse is gentler with messy files. |
| Feeds | `feedsmith` | `rss-parser` | Stale (2023), pulls `xml2js`. |
| Forecasting | in-repo TypeScript | `@tensorflow/tfjs` 4.22.0 (147 MB unpacked), `onnxruntime-web` 1.31.1 (151 MB unpacked), small calibration packages (`forecast-calibration-kit`, `@farhadarjmand/forecast-calibration`, 0.1.x, single author, weeks old) | Size, and unvetted supply chain for ten lines of arithmetic. Neural temporal-graph models (TGN and similar) would need a training stack and data volumes the product does not have, and they are not explainable. |

## What NOT to add (summary)

- Any native module (`better-sqlite3`, `sqlite3`, `sodium-native`, `keytar`): breaks the no-native-module rule and cross-platform packaging.
- SQLCipher / `node:sqlite` as the extension's store: plaintext or unavailable on the Node 22 floor.
- `elkjs` (EPL-2.0 OR GPL-3.0-or-later) and `cytoscape-svg` (GPL-3.0): license.
- The full `@turf/turf`, `cesium`, `deck.gl`, `tfjs`, `onnxruntime-web`: size, and no feature that the design needs.
- A CDN `<script>` or `<link>` for any library, tile, font or sprite: the CSP forbids it and the privacy promise depends on it.
- Mapbox GL JS or any library or style that needs a token; Cesium ion; the standard OSM tile servers for bulk prefetch.
- A hosted geocoder (Nominatim, GeoNames web services, Mapbox, Google): place names must never leave the machine.
- A telemetry or crash-reporting SDK in the relay or the webviews.
- MLS in v0.5.0 (revisit only with a concrete forward-secrecy requirement and an audited implementation).

## Integration points with the existing code

- `src/services/contextGraphStore.ts` (JSON ledger capped at 200 nodes and 400 edges per graph, 500 KB) stays as the agent-facing project memory. The knowledge base is a **new store** (for example `src/kb/`) with its own worker; `contextGraphMemory.ts` gets a slice-to-context adapter that hands agents a bounded slice, never the whole base.
- Encryption key: reuse the SecretStorage key-management code used for conversation storage. New secrets: member seed, per-compartment epoch keys (store as one JSON secret or as a keyring file encrypted under a SecretStorage master key).
- `scripts/vendor-libs.mjs`: add `bundle()` entries for `kb-worker` (sql.js + store code), `age-encryption`, `feedsmith`, `papaparse`, and `copy()` entries for `sql-wasm.wasm`, MapLibre, Cytoscape. MapLibre 6 is ESM-only, so bundle it as a browser ESM or IIFE with esbuild rather than copying a UMD file. Extend the `.vscodeignore` check in `scripts/verify-release-content.mjs` so the new vendor paths and `LICENSES.txt` files are required in the VSIX.
- Webviews: follow `panelView.ts` (nonce CSP, `localResourceRoots`) but with the stricter globe CSP above. Libraries are loaded via `asWebviewUri`. Map and graph webviews talk to the host by `postMessage` only (tile bytes, slices, edits).
- Egress: the relay and any feed or optional imagery fetch must go through `src/services/outboundGuard.ts` / `privacyPreflight.ts` so a destination outside "NEAR TEE or user-chosen" is blocked or prompts. Relay URL is a user-chosen endpoint and needs a visible approval, like MCP servers.
- Build tools: package.json already carries `overrides` for `undici` 7.30.1 and `@azure/msal-node` 7.1.2 (build-tool dependencies, updated after this research started; 0.4.1 is released). None of the additions interact with them. Add the `fast-xml-parser` pin to the same `overrides` block.

## Installation (all pinned devDependencies, vendored at compile time, matching the repo's convention)

```bash
# Local store, sharing, import
npm install -D --save-exact sql.js@1.15.2 age-encryption@0.3.1 feedsmith@3.0.1 papaparse@5.7.0 mgrs@2.2.0 \
  @turf/boolean-point-in-polygon@7.4.0 @turf/bbox@7.4.0 @turf/distance@7.4.0 flatbush@4.6.2

# Webview libraries
npm install -D --save-exact cytoscape@3.34.4 cytoscape-fcose@2.2.0 maplibre-gl@6.16.0 pmtiles@4.5.0

# Types
npm install -D --save-exact @types/geojson@7946.0.16 @types/papaparse

# Optional, only if needed
npm install -D --save-exact cytoscape-cola@2.5.1 @stdlib/stats-base-dists-beta-quantile@0.2.3
```

Relay (separate package, no runtime dependencies): build with the repo's esbuild 0.28.2 into one `relay.mjs`; Node 24 base image.

## Sizes (what ships in the VSIX)

Measured from tarballs: MapLibre about 1.7 MB (JS 1.1 MB, worker 0.5 MB, CSS 72 KB), `sql-wasm.wasm` 685 KB, `sql-wasm.js` 47 KB. From registry unpacked size (upper bounds, minified bundles will be smaller): `age-encryption` 93 KB plus noble (`@noble/curves` 1.6 MB, `ciphers` 0.5 MB, `hashes` 0.7 MB, `post-quantum` 0.7 MB unpacked; tree-shaking cuts this sharply), `feedsmith` 808 KB, `papaparse` 271 KB, `pmtiles` 380 KB. Cytoscape (5.7 MB unpacked with many builds) and fCoSE bundle sizes were not measured because my bundle-size run was killed; measure them in the first spike. Data: GeoNames `cities15000` about 3.2 MB zipped; Natural Earth basemap several MB. Total new VSIX weight should land around 8-15 MB. Optional packs are downloaded, not shipped.

## Open spikes before roadmap commitments

1. **MapLibre 6 worker and PMTiles under the VS Code webview CSP** (Blob worker versus direct URL, byte-range reads via host `postMessage`, no network in a devtools trace). Highest-risk item for the globe.
2. **`sql.js` ceiling and snapshot cost** on a synthetic 100k, 300k and 1M claim base; confirm export time and memory, and the worker-thread message cost.
3. **`age-encryption` in the bundled extension**: tree-shaken size, Node 22 compatibility under the extension host, hybrid PQ wrap size.
4. **Relay prototype**: append with role check, SSE, snapshot publication; confirm `node:sqlite` stability on the Node 24 image or fall back to files.
5. **Cytoscape bundle size and replay re-layout behaviour** (fCoSE versus cola) on a 2,000-node slice.
6. **STIX confidence mapping**: read the normative appendix of the STIX 2.1 spec directly (my fetch was truncated), and decide the reliability tag convention.

## Confidence

| Area | Confidence | Notes |
|---|---|---|
| Versions, licenses, unpacked sizes | HIGH | Read from npm registry on 2026-10-28. |
| sql.js feature set (no FTS5, no R*Tree) and wa-sqlite mc contents | HIGH | Inspected the shipped wasm and tarball. |
| `node:crypto` primitives | HIGH | Exercised locally; Node 22 versus 24 difference (Argon2) from Node docs and local test. |
| Cytoscape / MapLibre / Cesium trade-offs | MEDIUM | Sizes measured; behaviour under VS Code CSP unverified (spike 1). |
| GeoNames sizes and license | HIGH for sizes (directory listing), MEDIUM for license wording (site says "cc-by") | |
| STIX / MISP Admiralty mapping | MEDIUM | Secondary sources. |
| MLS versus wrapping | MEDIUM | Reasoned from requirements; `ts-mls` interop status unconfirmed; no OpenMLS-WASM package found (negative search, LOW). |
| Forecasting approach | MEDIUM | Standard methods; no JS library vetted because none worth adopting exists. Implementation effort is the risk, not feasibility. |

## Sources

- npm registry (`npm view` / `npm pack`, 2026-10-28) for all package versions, licenses, unpacked sizes and tarball contents (HIGH).
- GeoNames dump directory listing, https://download.geonames.org/export/dump/ (2026-10-28), and https://www.geonames.org/export/ for the license (HIGH/MEDIUM).
- NASA GIBS access basics, https://nasa-gibs.github.io/gibs-api-docs/access-basics/ (endpoints and time dimension; terms not stated on that page).
- MapLibre GL JS changelog, https://raw.githubusercontent.com/maplibre/maplibre-gl-js/main/CHANGELOG.md (first 100,000 characters read; v6 ESM-only, worker, globe fixes).
- CesiumJS Offline Guide, https://github.com/CesiumGS/cesium/blob/main/Documentation/OfflineGuide/README.md (via search summary, MEDIUM).
- Cytoscape.js WebGL preview, https://blog.js.cytoscape.org/2025/01/13/webgl-preview/ (MEDIUM).
- `@sqlite.org/sqlite-wasm` README, https://github.com/sqlite/sqlite-wasm (Node in-memory only).
- `ts-mls` README (bundled in the npm tarball): no formal audit, single dependency `@hpke/core`.
- `age-encryption` README (npm tarball): noble-only dependencies, hybrid identities.
- fast-xml-parser advisories CVE-2026-26278 and CVE-2026-33036 (search summaries; confirm on the GitHub advisory pages, MEDIUM).
- STIX confidence scales as implemented in the OASIS `stix2` Python library, https://stix2.readthedocs.io/en/latest/api/confidence/stix2.confidence.scales.html (MEDIUM); MISP `admiralty-scale` taxonomy (MEDIUM).
- VS Code 1.101 on Electron 35 / Node 22 (search summary, MEDIUM).
