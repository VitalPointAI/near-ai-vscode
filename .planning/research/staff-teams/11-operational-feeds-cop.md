# Research note 11: operational feeds, the knowledge graph and the layers of the COP

Date: 2026-11-18. Status: research for the owner's need of 2026-11-18; nothing here is built or decided.

**The owner's need.** The J2 has many intelligence feeds: imagery, terrain and weather, OSINT from many web channels, and partner-only HUMINT and SIGINT, each category with several channels. They form a knowledge graph that the J2 and its agents slice to build real-time and future threat assessments and enemy courses of action (ECOAs). The J3 has friendly position data. Everything is a geolocated layer on the common operational picture (COP) and the globe.

**Inputs read first.** The data platform design (`.planning/research/data-platform/00-DESIGN.md`, cited "DP §n"): the connector contract, the backfill-then-live indexer, the evidence-row graph, labels, clearances and slices. The roadmap (`.planning/ROADMAP.md`): v0.6.0 Data platform, Phases 85 to 101, and its knowledge base views (the globe is deferred there; "22 Globe and timeline: Timeline carries; the globe is deferred", Phase 97). Design 10 (`10-STAFF-TEAMS-DESIGN.md`, cited "D10 n"): COP layer ownership (4.3), `cop-map` with milsymbol and MapLibre (6.2), partner integrations (6.3), WP-COP (9.1). The staff UX concept (`ux/STAFF-UX-CONCEPT.md`, cited "UX n"): map, libraries, CSP and budgets (5.10, 12). Drop 1 code on `feat/staff-drop1`: `src/domain/staff/scenario.ts` (scenario format and its guards), `intel.ts` (source register with two separate grades, origin-based independence, PIR register, collection plan, INTSUM and INTREP drafts), `doctrine.ts` (disciplines, partner-only disciplines, template label ceiling), `readModels.ts` (COP read model), and the starter scenario `resources/staff/scenarios/iron-lantern.json`.

**Method.** Public, unclassified sources only, through web search and direct reads of primary pages where they allowed it. Every external claim carries a source tag such as [F12]; the list is at the end with title, date, address and confidence. Confidence follows the research tooling: a single search excerpt is LOW; a primary page read directly or two agreeing sources is MEDIUM. Nothing here comes from a restricted document. STANAG content stays at the level of public catalogue descriptions and open-source tooling.

---

## 1. Summary

1. **One shape for everything.** Every feed message becomes an *observation row*: what was seen, where, when it was valid, when we learned it, who reported it, where the information first came from, two separate grades, and a label. Tracks are views over observations; COP feed layers are slices over observations; threat and ECOA products stay single-writer staff products (D10 4.3). The row is designed as a new labelled table beside the v0.6.0 evidence rows (`mention`, `mention_entity`, `relation_evidence`, `entity_link`, DP §5.1), so the drop 2 demo store migrates into the host without rework.
2. **Public and simulatable:** Cursor on Target (CoT) and the TAK protocol, AIS, ADS-B, OGC map and feature services, GeoJSON, KML, GeoPackage, GRIB2 and NetCDF weather, DTED, SRTM and Copernicus DEM terrain, OpenStreetMap and Natural Earth, RSS and Atom, GDELT. **Partner-only or classified in practice:** live STANAG 4607 GMTI and STANAG 4609 motion imagery, NFFI and FFI friendly force tracks, MIP4 exchanges, and all HUMINT and SIGINT reporting. Their formats are publicly described at a catalogue level; their real content enters only through a partner integration with a per-server label ceiling, routed `local-only`, and in staff projects only as fictional simulations within the template ceiling (D10 6, 6.3; drop 1 `STAFF_TEMPLATE_LABELS`).
3. **Licences decide more than formats do.** Ingest freely (with attribution): GDELT [F39], ECMWF open data under CC-BY-4.0 [F28], Environment and Climate Change Canada data under its end-use licence, which allows commercial use [F29], US National Weather Service data [F30], Copernicus DEM GLO-30 with its notice [F34], SRTM [F33], Natural Earth [F37], OpenStreetMap data under ODbL [F35]. **Do not ingest by default:** ACLED (its EULA of 1 November 2026 needs a public-sector licence for government bodies and written consent before its content is used as embeddings or knowledge-base input) [F40]; OpenSky data (no redistribution; research, education and government purposes only) [F15][F16]; X and Reddit content for this use (X bans surveillance and monitoring of protests [F42]; Reddit's 2024 policy bars government surveillance uses [F43]); a news API's free developer plan (development only) [F41].
4. **Map stack: MapLibre GL JS for both the 2D map and the globe.** It is BSD-3-Clause [F44] and has had a globe projection, with terrain, since version 5.0.0 in January 2025 [F44]; the UX note already checked version 6.19.0 (UX 12.2). One library means one code path, one CSP and one offline tile pipeline. CesiumJS (Apache-2.0, Cesium ion optional [F46]) stays an optional later bundle for true 3D analysis such as viewshed. deck.gl's GlobeView is still marked experimental [F45], so it is not chosen.
5. **TAK software is copyleft; the CoT wire is not.** TAK Server and ATAK-CIV are GPL-3.0 [F6][F8], OpenTAKServer GPL-3.0 [F5], CloudTAK AGPL-3.0 [F9], FreeTAKServer EPL-2.0 [F4]. None goes inside the extension or the host under the v0.6.0 licence rule (DP §7). Interoperate over the wire: write our own CoT codec (the base schema of event, point and detail is small and publicly described [F1]) and, for a demo with real TAK phones, run a TAK server as a separate optional process.
6. **PostGIS is GPL** [F50], which the v0.6.0 licence rule excludes. Spatial indexing on the host uses Postgres's own geometric types with GiST indexes, or the core `h3` extension (Apache-2.0 [F50]), unless the owner grants an exception.
7. **Real time keeps the v0.6.0 rules.** The label is stamped by the connector before a row exists; queues are bounded with a written policy per feed class (coalesce positions, never drop reports); tracks decay through `live`, `stale` and `lost`; replay is the v0.6.0 "as known at T" view (KB-14) using two times on every row (valid time and known time).
8. **Standing watches draft, people decide.** A watch binds an indicator to an NAI or area, a PIR and its latest time of value (drop 1 PIR register). A match drafts an INTREP and a revised threat assessment or ECOA *as drafts* in the release state machine, marks dependent products "source changed", and alerts a named person. No watch releases anything, and until Phase 74 run contracts exist, watches run only while a person has the staff run open.
9. **The IRON LANTERN demo replays as CoT, AIS and RSS streams on loopback**, plus simulated partner HUMINT and SIGINT through a mock partner server routed `local-only`. To put a fictional scenario on a real globe, anchor the scenario's fictional KQ grid in an *exercise frame* over empty ocean (around the oceanic pole of inaccessibility, 2,688 km from any land [F55]), with a synthetic coastline and terrain. **Finding:** the starter scenario's grid references only read consistently if northings grow southward (for example AA OAK at KQ 4332 is "north of Saltmere" at KQ 4335), which is the opposite of real grids. Fix it, or declare the axis, before any replay.
10. **Drop 2 demo slice** (section 9): the `cop-map` tool with a globe toggle and time slider; a local observation store; importers for GeoJSON, KML, CoT, RSS and AIS sentences; a weather and terrain layer from packs; the simulated streams; standing watches; agent slice tools. Eight work packages, seven of them parallel after a small contract package.
11. **For v0.6.0:** the observation table, spatial index and feed connectors on the host; public feed connectors through the manifest connector path (Phase 100); entity pages for units and platforms (Phase 96); and the globe, which the roadmap defers, should come back into Phase 97 as "map, globe and time replay" (an owner decision, section 11).

---

## 2. Feed standards and formats

### 2.1 Master table

"Sim" means we can generate realistic fictional messages ourselves with no partner and no restricted text. "Path" says how it enters: **I** importer (file), **C** connector (live, under the connector contract), **P** partner integration (MCP now, agent exchange later; labelled; `local-only`).

| Feed | What it carries | Encoding and transport | Licence or availability | Public? Sim? | Path | Sources |
|---|---|---|---|---|---|---|
| Cursor on Target (CoT) | One event per thing: `uid`, hierarchical `type` (atom, affiliation, battle dimension, function), `time`, `start`, `stale`, `how`; a `point` with WGS 84 `lat`, `lon`, height above ellipsoid `hae`, circular error `ce` and linear error `le`; a free `detail` element | XML over UDP multicast or TCP; the TAK protocol carries the same event as protobuf | Base schema publicly described; open codecs MIT and Apache-2.0 | Public; Sim yes | C, I | [F1][F3][F10][F58] |
| TAK protocol v1 | A `TakMessage` protobuf wrapping a CoT event | Mesh: header `0xbf 0x01 0xbf`; stream: `0xbf` then a varint length | Described in open implementations; TAK software is GPL-3.0 | Public; Sim yes | C | [F2][F6][F8] |
| AIS | Ship self-reports: MMSI (9-digit radio id whose first three digits give the issuing country), position, speed, course and heading (types 1 to 3, Class A; 18 and 19, Class B), static and voyage data such as name, type and destination (type 5, hand-entered and often wrong), aids to navigation (21), static data (24) | NMEA 0183 `!AIVDM` sentences with a 6-bit payload, multi-part messages reassembled | ITU-R M.1371 now free; open decoders (pyais MIT); US archive data CC0; free live stream service in beta with no SLA | Public; Sim yes | C, I | [F11][F12][F13][F14] |
| ADS-B | Aircraft position and identity by ICAO 24-bit address | Mode S; aggregators expose JSON | OpenSky: research, education, government purposes, no redistribution; a community aggregator publishes under ODbL | Public; Sim yes | C | [F15][F16][F17] |
| OGC WMS 1.3.0, WMTS 1.0.0 | Rendered map images and pre-cut tiles | HTTP | Open standards | Public; Sim n/a | C (tile source) | [F20] |
| OGC WFS 2.0, OGC API Features | Vector features; Features Part 1 core is WGS 84 longitude, latitude | HTTP, GML or GeoJSON | Open standards; Features Part 1 is also ISO 19168-1 | Public; Sim yes | C, I | [F20] |
| OGC SensorThings API 1.1 | Things, sensors, datastreams, observations, features of interest; each datastream is one sensor and one observed property | REST and MQTT, JSON | Open standard | Public; Sim yes | C | [F18][F57] |
| GeoJSON | Features in WGS 84 longitude, latitude | JSON (RFC 7946) | Open | Public; Sim yes | I | [F21] |
| KML | Placemarks, paths, polygons, ground overlays, time spans | XML | OGC standard | Public; Sim yes | I | [F22] |
| GeoPackage | Vector features, tile pyramids, tables in one SQLite file, built for mobile and offline use | SQLite | OGC standard | Public; Sim yes | I | [F19] |
| STANAG 4607 (GMTI) | Ground moving target radar data: packets of segments (mission, dwell with target reports, HRR, job definition, processing history) | Binary; implementation guide AEDP-7 | Standard sold through standards shops; AEDP-7 listed free; open parsers exist | Format public at catalogue level; Sim possible for fictional dwells; real feeds partner-only | P | [F23] |
| STANAG 4609 (motion imagery) | Full motion video with KLV metadata (MISB ST 0601 UAS Datalink Local Set: platform and sensor position, footprint) | MPEG-2 transport stream with a KLV data stream | NATO and MISB documents; vendor and open tooling | Format public at catalogue level; Sim of metadata only; real feeds partner-only | P | [F24] |
| NFFI and FFI (STANAG 5527) | Friendly force tracks: unique track id, position, optional symbol code | XML; HTTP, file drop or web services | STANAG 5527 Ed 2:2025 listed for sale; NFFI superseded by FFI | Format public at catalogue level; real tracks partner-only | P | [F25] |
| MIP4 (MIM and IES) | Coalition C2 information exchange (units, plans, orders, overlays); successor to JC3IEDM (STANAG 5525) | XML schemas generated from the MIM; web service messaging profile | MIP community products | High level only; partner-only | P | [F26] |
| C2SIM (SISO-STD-019-2020) | Orders and reports between C2 systems and simulations; core ontology; replaces MSDL and C-BML | Transport not specified by the standard; reference server exists | SISO standard | Public; Sim yes (exercise use) | P, later | [F27] |
| GRIB2 | Gridded weather fields (WMO format) | Binary | Format open; GDAL reads it | Public; Sim yes | I, C | [F31][F52] |
| NetCDF | Gridded and time series science data | Binary | Open; GDAL reads it | Public; Sim yes | I | [F52] |
| NOAA GFS (NOMADS), NWS API | Global forecast at 0.25 degree in GRIB2 at 00, 06, 12, 18 UTC; US forecasts, alerts and observations as GeoJSON, JSON-LD and CAP | HTTP; NWS needs a User-Agent and has unpublished rate limits | NWS data "intended to be open data, free to use for any purpose" | Public | C | [F30][F31] |
| ECMWF open data | IFS and AIFS forecasts, GRIB2, 0.25 degree | HTTP | CC-BY-4.0 with required attribution; whole real-time catalogue open since 1 October 2025 | Public | C | [F28] |
| ECCC MSC Datamart | Canadian model output (GDPS and others), GRIB2; AMQP push | HTTPS, AMQP | ECCC Data Services End-use Licence v2.1.1 (August 2026): worldwide, royalty-free, commercial use allowed, attribution, alerts reproduced unaltered | Public | C | [F29] |
| DTED levels 0, 1, 2 | Elevation posts about 900 m, 90 m, 30 m; 1 by 1 degree cells; WGS 84 horizontal, EGM96 heights | Binary (MIL-PRF-89020B) | Format public; GDAL reads it | Public format; Sim yes | I | [F32] |
| SRTM 1 arc-second | 30 m elevation, 60 N to 56 S, void-filled | DTED, BIL, GeoTIFF | Public domain per secondary sources; login to download | Public | I | [F33] |
| Copernicus DEM GLO-30 | 30 m global elevation | GeoTIFF | Free worldwide licence with a notice ("© DLR e.V." or "produced using Copernicus WorldDEM-30 © DLR e.V."); a few countries' tiles withheld | Public | I | [F34] |
| OpenStreetMap | Roads, buildings, land use, names | PBF extracts, vector tiles | ODbL; public tile servers forbid offline use and prefetching | Public | I | [F35][F36] |
| Natural Earth | Small-scale coastlines, borders, relief | Shapefile, GeoPackage | Public domain | Public | I | [F37] |
| RSS 2.0, Atom (RFC 4287) | Items with title, link, date, text; Atom has ids and update times | XML over HTTP | Open | Public; Sim yes | C, I | [F38] |
| GDELT 2.0 | Events, mentions and the global knowledge graph (people, organizations, locations, themes) every 15 minutes; DOC API (3 months, 250 records per query); GEO API (7 days) | CSV files, BigQuery, JSON APIs | Unlimited use including governmental, with citation and link | Public | C | [F39] |
| ACLED | Coded conflict events | API | EULA 1 November 2026: public-sector licence for government bodies; AI, embeddings and knowledge-base use need written consent; no redistribution | Public data, restricted use | Not by default | [F40] |
| News APIs | Article metadata and text | JSON | Free developer plans are typically development-only | Varies | C if licensed | [F41] |
| Social media | Posts, video | Platform APIs | X: no surveillance, no monitoring of protests or sensitive groups, government use on the enterprise tier; Reddit: no government surveillance uses | Restricted | Not by default | [F42][F43] |

### 2.2 Notes per family

**CoT and TAK.** The `type` string carries MIL-STD-2525 meaning: `a` (atom, a real object), then affiliation (`f` friend, `h` hostile, `n` neutral, `u` unknown, `a` assumed friend, `s` suspect, `p` pending, plus `j` joker and `k` faker), then the battle dimension and function codes, in upper case to keep them apart from CoT's own lower-case extensions; `a-h-G-U-C` is a hostile ground combat unit [F1][F58]. `stale` ends the event's validity, which gives track decay for free [F1]. `how` hints at how the position was produced, for weighting when fusing [F1]. The conversion from CoT type to a milsymbol symbol identification code (SIDC) is a table, not a model; open libraries already do CoT to GeoJSON both ways [F3]. The TAK protocol only changes the wrapper: a protobuf `TakMessage` after a `0xbf` header [F2].

**AIS.** Self-reported, unauthenticated radio. Static fields are hand-entered and often wrong [F11], and positions can be falsified: a peer-reviewed study documents AIS position falsification by tankers during ship-to-ship transfers [F54]. So AIS is evidence about what a transponder *said*, never proof of where a ship *was*; corroboration needs another origin (radar, imagery, a patrol). MMSI is a stable key but is the radio's id, not the hull's [F11].

**ADS-B.** The same caution applies (self-reported). The licence matters more than the format: OpenSky's licence forbids redistribution and limits purposes [F16], and its API docs ask for contact before any commercial use [F15]; a community aggregator's ODbL data is usable but share-alike applies if a derived database is used publicly [F17][F35].

**OGC services.** WMS and WMTS give pictures and tiles; WFS and OGC API Features give features; SensorThings gives sensor time series [F18][F20]. For the COP they are tile sources and feature connectors. Every request to an outside server reveals the area being looked at (D10 6.2), so they stay Public-only unless the server is your organization's own.

**STANAG 4607 and 4609 at a public level.** 4607 packs radar "dwells", each with many target reports (position, velocity, signal-to-noise) [F23]; 4609 carries video with a KLV metadata stream whose ST 0601 set gives platform and sensor position and the image footprint [F24]. What matters for the graph is the same as for any feed: each target report or footprint becomes an observation with time, place, error and source. A fictional generator for dwells and footprints is possible without restricted text; real feeds come from partners.

**NFFI, FFI, MIP, C2SIM.** NFFI and its successor FFI are track lists for friendly forces, each track with a unique id and optionally a symbol code [F25]. MIP4 exchanges a much richer C2 model through generated XML schemas [F26]. C2SIM links C2 systems to simulations [F27], which makes it the most natural exercise interface later. In this design friendly force tracks arrive as CoT in demos and as partner integrations in real use; MIP and C2SIM stay future partner integrations, recorded here so the observation row does not block them.

**Weather.** Gridded forecasts (GRIB2, NetCDF) and point products (NWS JSON and CAP alerts). Free global sources are ECMWF open data (CC-BY-4.0, attribution wording required) [F28], NOAA GFS [F31] and ECCC's Datamart (commercial use allowed, unaltered alerts) [F29]. Decoding GRIB2 belongs on the host in a sandboxed worker with GDAL (MIT) [F52], not in the extension.

**Terrain.** DTED (a military format with a public specification), SRTM (public domain) and Copernicus DEM (free with a notice) all read through GDAL [F32][F33][F34][F52]. On the map they become terrain-RGB tiles for hillshade and 3D, and contours computed in the browser by maplibre-contour (BSD-3-Clause) [F51].

**OSINT.** RSS and Atom are the cheapest and safest channel: a list of outlets your organization chooses, polled, with each item graded in the source register (drop 1 `intel.ts`). GDELT adds machine-coded events and locations every 15 minutes [F39], which suit indicators and warning when graded as a machine-coded secondary source. ACLED and social media are excluded by default for licence and policy reasons [F40][F42][F43]. Every outside query (search terms, bounding boxes) reveals interest (D10 6.1), so live OSINT queries run only in Public chats and against fictional scenarios in demos.

### 2.3 Public, partner-only and classified: how each enters

| Category | Examples | Where it enters | Label and routing | In the extension's staff templates |
|---|---|---|---|---|
| Public, open licence | GDELT, NWS, ECMWF, ECCC, SRTM, Copernicus DEM, Natural Earth, OSM extracts, chosen RSS | Importer now; host connector in v0.6.0 | Source default label from the signed policy (usually Public or Internal) | Allowed; queries scoped to the fictional scenario in demos |
| Public, restricted terms | ACLED, OpenSky, X, Reddit, news APIs | Only if your organization holds a licence that covers this use; recorded on the source card with `training.rights` set to no | As the licence requires; never `no-train` lowered | Off by default |
| Your organization's own | Friendly position reports, own patrol and liaison reports, own imagery footprints | Importer now; host connector later | Your organization's labels | Allowed within the template ceiling (org/Internal, NATO Unclassified, Protected A) |
| Partner-only | Coalition FFI tracks, GMTI, motion imagery, partner intelligence summaries | Partner integration: a remote MCP server under a person-written manifest, scoped to named members, ask-every-call, with the per-server label ceiling (WP-GATE); later the agent exchange with signed cards and mandates (note 01) | Partner labels mapped explicitly in the signed bundle; unmapped maps to the strictest level (DP §6.2); every labelled level routed `local-only` (note 01 s4) | Only as fictional simulations; a real partner feed above the template ceiling is refused in staff projects |
| Classified (HUMINT, SIGINT, MASINT, CI reporting) | National reporting | Accredited systems only | Not applicable | Out of scope (D10 6.3, 7); labels are not accreditation. The demo shows the *path* with fictional reports labelled as partner simulations |

The rule for anything partner-supplied, now and later: results arrive fenced as untrusted text, a person reviews them before they enter a product (D10 6.3), the chat's mark rises to the result's label, and the routing tier then keeps every later call local.

---

## 3. Data model

### 3.1 The observation row

One row per thing seen, at one place and time, by one channel. Rows are append-only: a correction is a new row that `supersedes` the old one. The row keeps exactly the four things the owner asked for (source, time, location, label) plus the grades and origin the J2 tradecraft gate needs (D10 4.4).

| Field | Meaning | v0.6.0 home |
|---|---|---|
| `obs_id` | Hash of feed, channel and the message's own id (CoT `uid` plus `time`, AIS sentence hash, RSS item id) so re-delivery is idempotent | Like the item identity key (DP §4.2) |
| `segment_item` | The feed segment (one feed, one channel, a short time window) the row came from; the segment is a normal item with a content hash, lineage and erasure | `item` |
| `feed`, `channel`, `discipline` | For example `ais` / `receiver-north` / `OSINT`; discipline from drop 1 `INTELLIGENCE_DISCIPLINES` | `item_card` facets |
| `valid_at` (and optional `valid_until`) | When the observation was true (CoT `time` and `stale`, AIS receive time, report's time of observation) | `relation_evidence.valid_from`, `valid_to` |
| `known_at` | When we received it; drives "as known at T" replay (KB-14) | `ingest.firstSeen` |
| `geometry` | Point (longitude, latitude, height) or line or polygon, in WGS 84 | New column, spatial index |
| `error` | Circular and vertical error in metres (CoT `ce`, `le`); a footprint for imagery | New |
| `how` | How the position was produced (GPS, estimated, derived, reported) | New |
| `subject_ref` | The raw identifier in the feed: CoT `uid`, MMSI, ICAO address, track number, unit designation as written | `mention` |
| `observed_type` | CoT type or SIDC as reported; affiliation as reported (a feed's affiliation is a claim, not a finding) | `mention` attributes |
| `attributes` | Speed, course, heading, name, free text excerpt with quote offsets | `mention`, quote spans |
| `source`, `origin` | Who provided it, and where the information first came from (drop 1 `SourceEntry.source` and `origin`); independence is by origin | `item_card.provenance` |
| `reliability`, `credibility` | Source reliability A to F and information credibility 1 to 6, two fields, never combined (drop 1 `readGrades`) | Admiralty layer, optional for intelligence projects (DP 10.2-22) |
| `deception_note` | What deception or bias could explain it ("none seen" is an answer) | `item_card` |
| `label_id` | The label, stamped at ingest | Every row labelled; RLS (DP §5.1) |
| `extractor` | Codec and version that produced the row | `pipeline.extractorVersion` |

**Feed segments are a new raw-copy reason.** A live stream cannot be re-read from its source the way a SharePoint file can, so to keep provenance and erasure the raw messages of each segment are kept in the encrypted, content-addressed blob store. The v0.6.0 storage rules allow raw copies only for documented reasons (DP §5.2, R3), so this needs an owner decision (section 11, Q2). Bounded by a retention class per feed.

### 3.2 Tracks

A track is a resolved entity plus its ordered observations. It is *computed for the reader*: the "last known position" a person sees uses only rows their clearance dominates, exactly as v0.6.0 computes entity attributes at read time (DP §3.5). A stored "current position" column would leak a higher-labelled update to a lower-cleared reader, so any materialized track table is kept per label cell, like the analytics files (DP §6.3).

### 3.3 The two grades on machine feeds

- **Reliability grades the channel** (the AIS receiver network, the patrol, the outlet). A person sets it in the source register once per channel; agents may propose it with evidence, as the paused knowledge base planned (ROADMAP, former Phase 16). Until a person grades a channel it is F ("cannot be judged").
- **Credibility grades each observation.** It starts at 6 ("cannot be judged") or the channel's default, and rises only through corroboration from an *independent origin* (drop 1 `independentlyConfirmed`).
- **Origin for machine feeds** is the emitter, not the relay: two AIS receivers hearing one transponder are one origin; an imagery pass and a patrol are two. Two OSINT items quoting one video are one origin, which the starter scenario already tests (OS-02 and OS-03 share an origin).

### 3.4 Entity resolution across feeds

| Entity kind | Strong keys | Weak evidence | Typical link |
|---|---|---|---|
| Unit | Designation plus echelon plus parent (`41 CSTL BDE`, brigade) | Location history, equipment seen, radio net (SIGINT) | Report mention to unit |
| Platform (vessel, aircraft, vehicle) | MMSI and IMO; ICAO address and callsign; CoT `uid` | Track continuity in time and space, size, behaviour | Track to platform; platform to unit |
| Equipment type | A type catalogue your organization chooses (the scenario's notional types in demos) | Imagery and video descriptions | Platform to type |
| Place and control measure | Gazetteer id, grid reference, NAI id | Names in text | Mention to place |
| Event | GDELT event id; report id | Time, place, actors | Event to unit and place |
| Person | Not modelled in staff projects | | Refused (D10 7 item 6) |

How links are made, all as v0.6.0 proposals with undo, never destructive merges (DP §3.5, `entity_link` states proposed, accepted, undone):
1. **Deterministic** on strong keys within a feed (same MMSI, same CoT `uid`).
2. **Spatiotemporal association** between feeds: a candidate pair must be reachable at plausible speed for its kind within the time gap and inside both error circles. The proposal records the distance, gap and speed as its evidence.
3. **Text mentions** of units and places, tagged by the v0.6.0 small-model tier and the offline gazetteer, each with a verified quote span.
4. **A person or an agent confirms**; an agent's confirmation is itself a labelled, undoable decision, and a link that would merge two sides (friendly and hostile) is always a person's call.

Deception is a property of the evidence, not of the entity: a false AIS identity or a state broadcast claim stays an observation with a deception note, linked with low credibility, never silently dropped.

### 3.5 Into the evidence-row graph

Each observation maps onto the v0.6.0 tables so that every fact keeps its source, time, location and label:

| Fact | Rows |
|---|---|
| "Report IM-04 saw vehicles in hides east of Port Calder at D-5 1130" | `observation` (polygon, time, IM-04 segment, grades B and 3) plus `mention` of the place |
| "Those vehicles belong to 2-41 MECH" | `mention_entity` (method: analyst or spatiotemporal; evidence; label) |
| "3-41 ARMD was on the south slope of Harrow Ridge from D-5 1130" | `relation_evidence` (subject unit, predicate `located-at`, object place, `valid_from`, quote span or observation ref, label) |
| "U-1 and the night contact in FR-01 are one craft" | `entity_link` proposed, with the association evidence; accepted by a person |
| "The MDCOA is defensive mining of the eastern channel" | A J2 product (drop 1 release state machine), whose `depends_on` lists the evidence rows; not a graph fact |

Derived things take the join of their inputs' labels (DP §6.2 `derived.ts`): a track, a corroboration count, a layer and a draft ECOA are never lower than the highest observation they used. The v0.6.0 aggregation rule (many low-labelled observations together can raise the level, DP §6.2 and 10.2-13) matters more for feeds than for documents, because tracks compile movement patterns; the release-guard's compilation check (D10 7 item 3) stays on every product.

---

## 4. Real time

### 4.1 Pipeline

```
 feeds (loopback sims now; host connectors later)
   CoT UDP/TCP   AIS sentences   RSS/Atom poll   GeoJSON/KML/GeoPackage files   partner MCP results (fenced)
        |              |               |                    |                            |
        v              v               v                    v                            v
 +--------------------------------------------------------------------------------------------------+
 | Feed runtime (sandboxed process, parse untrusted input, no outbound network except a configured  |
 | feed address; loopback only in drop 2)                                                            |
 |   codec -> observation rows -> LABEL STAMP (source default from signed policy; partner map;      |
 |   unmapped = strictest; above the template ceiling = refused) -> bounded queue per feed class     |
 +--------------------------------------------------------------------------------------------------+
        |  append (idempotent by obs_id; cursor per stream in the same write)
        v
 Observation store (drop 2: local segments in workspace storage; v0.6.0: host Postgres with RLS)
        |                     |                                   |
        v                     v                                   v
 Track view (reader-     Standing watches (indicator x       Slices for agents and people
 relative, decay)        NAI x PIR x LTIOV) -> drafts         (area, time, grade, discipline,
        |                     |  -> release state machine      unit, echelon), capped
        v                     v  -> alert a named person               |
 cop-map feed layers     intel-workbench (INTREP draft,                v
 (read-only views)       ECOA revision draft)                agent tools, map, time slider
```

### 4.2 Streaming ingest under the label gate

- **The connector contract carries over.** A stream emits the v0.6.0 messages (`RECORD`, `STATE`, `LOG`; `ACL` for sources with permissions; DP §3.1). `STATE` is the cursor: a CoT or AIS stream has no server cursor, so the cursor is the last `known_at` written, and a disconnection writes a **gap record** (from, to, reason) that the map and replay show.
- **A live-only source lifecycle.** The v0.6.0 source states (DP §4.1) gain one path: `approved` to `live` directly for streams with no history, with `degraded` on gap, overflow or a parse-error rate above a threshold. Sources with history (GDELT files, AIS archives) use the normal `backfilling` path. A **simulated** source is its own kind, always marked EXERCISE, and the COP shows a SIM badge on every layer it feeds.
- **The label exists before the row does.** No queue, cache or index ever holds an unlabelled observation. Unlabelled content is never sent to a cloud model to classify it (ROADMAP v0.6.0 ground rules).

### 4.3 Track storage and decay

| Track state | Enters when | Shown as | Leaves to |
|---|---|---|---|
| `live` | A new observation | Solid symbol, trail | `stale` when past the CoT `stale` time or the feed class interval |
| `stale` | No update within the interval | Faded symbol with "last seen 14 min ago" | `live` on update; `lost` after the class TTL |
| `lost` | Past the TTL | Hollow, dashed frame at the last known position with time | `live` on a resolved update; `closed` by a person or rule |
| `closed` | Person closes, or the entity was merged | Hidden; replayable | (end) |

Intervals and TTLs are per feed class and set in the source descriptor; defaults are design values to be measured in the demo, not claims about the feeds. Observations are never deleted by decay; only display state changes. Erasure and holds follow v0.6.0 (DP §4.2, §4.3).

### 4.4 Time replay

Two times per row give two replays (KB-14): **as happened** filters on `valid_at`; **as known** filters on `known_at <= T` and excludes rows superseded before T. "What did the J2 know when the commander decided?" is the second one. On the map, one shared clock (UX 13) drives a layer filter on the time property, the pattern of MapLibre's own time slider example [F44]. Products keep their version history in the release state machine, so replay can show which version of the threat assessment was current at T.

### 4.5 Standing watches

A watch is an armed indicator: condition (observation kinds, area or NAI, time window, minimum grades), the PIR and indicator it serves (drop 1 PIR register ids `PIR-n`, `IND-n`), its latest time of value, and the person to alert.

| Watch state | Meaning | Leaves to (trigger) |
|---|---|---|
| `proposed` | An agent or person drafted it | `armed` (a person approves); `rejected` |
| `armed` | Evaluated on every new observation | `matched`; `paused`; `expired` (LTIOV passed); `disarmed` (person) |
| `paused` | No attended run (until Phase 74), or its source is `degraded`; reason shown | `armed` on resume, with "missed while paused: N matches" queued, never dropped |
| `matched` | Condition met; event `staff.ccir.triggered` for CCIR matches, a new `staff.watch.matched` otherwise | `drafting` |
| `drafting` | A member run drafts an INTREP (drop 1 `draftIntrep`) and, if the match bears on an ECOA indicator, a revised threat assessment or ECOA ranking | `awaiting-review` |
| `awaiting-review` | Drafts sit in the release state machine; dependent products are flagged "source changed"; the named person is alerted | `armed` (after the person acknowledges); the drafts follow their own release path |
| `expired`, `disarmed`, `rejected` | Ended, with reason | (end) |

Rules: matches are de-duplicated per watch within a window, and alerts are rate-limited per person, with a digest instead of a flood. An ECOA revision uses ICD 203 likelihood terms and passes the tradecraft gate (D10 4.4) like any product. No watch tasks collection (the J2 recommends, the J3 approves; drop 1 `collection-recommend-only`) and none touches targeting. New event names (`staff.watch.matched`, `staff.watch.paused`, `feed.source.state`, `feed.gap`) are named before they ship (D-49).

### 4.6 Rate limits and backpressure

| Feed class | Examples | Under load | Never |
|---|---|---|---|
| High-rate positions | AIS, ADS-B, friendly position reports | Coalesce to the latest per track per tick for display; keep history sampled per track, with a gap note | Drop a track's first or last position |
| Discrete events | CoT spot reports, GDELT events | Queue; spill to disk; at the spill cap, set the source `degraded` with the reason | Drop silently |
| Text reports | RSS items, partner reports | Queue | Drop |
| Gridded | Weather runs | Replace by the newer run; keep the last N | Mix runs in one layer |
| Static | Terrain, OSM extracts | Bulk import job with progress | Block live feeds |

Outside limits are budgets in the source descriptor: the NWS API's limits are unpublished and need a User-Agent [F30]; GDELT's DOC API caps 250 records per query [F39]; the free AIS stream service closes a connection whose subscription arrives later than 3 seconds and offers no SLA [F14]. Inside the extension, the host sends the page at most 10 diffs a second (UX 12.4). Agents never subscribe to a firehose: they read capped slices and "changes since T" digests.

### 4.7 Offline and disconnected operation

- **Everything in drop 2 runs offline:** the simulated streams are on loopback, tiles and terrain come from packs, symbols and fonts are vendored (UX 12.2, 12.3).
- **Tiles.** Public OpenStreetMap tile servers forbid offline use and prefetching [F35]. Use a regional PMTiles extract cut from an OSM-derived basemap build (an ODbL produced work that needs visible attribution; the PMTiles specification is public domain) [F36], or Natural Earth for the globe (public domain) [F37], or your organization's own tile server.
- **Weather offline** is a snapshot with its model run time and age shown on the layer, so a stale forecast never looks current.
- **Reconnect** merges by `obs_id` (idempotent), so store-and-forward from a disconnected node cannot duplicate. Layers stay single-writer, so there is nothing to merge in products. Federation between edge and HQ stores is L5 (ROADMAP).
- **code-server and extension host restarts.** A hidden code-server tab can lose its extension host after about five minutes (UX 12.1). The feed runtime persists its cursor with each write, the simulator is deterministic from the scenario clock, and both resume where they stopped; the store rebuilds every view from segments.

---

## 5. Slicing

A slice is a saved scope (ROADMAP v0.6.0: "slices become saved scopes"), always clamped to the asker's clearance, for people and agents alike.

| Dimension | Examples | Notes |
|---|---|---|
| Area | Bounding box, polygon, NAI id, grid reference and radius, "within 10 km of Route IRON" | Spatial predicate inside the index scan, with the label predicate (DP §6.3) |
| Time | Valid-time window; known-time cut-off ("as known at T") | Both times on every row |
| Grade | Reliability at least B; credibility at most 3; "independently corroborated only" | Uses origin-based independence |
| Discipline and feed | OSINT only; AIS and radar; partner simulation | |
| Unit and echelon | "41 CSTL BDE and subordinates"; "battalion and above" | Graph walk over accepted `entity_link` and subordination relations |
| Affiliation | Hostile, unknown, suspect | Affiliation as assessed by the J2, not as claimed by the feed |
| Label | Never widened by the slice | Results identical to a store that never held what the reader cannot see (the two-compartment test, ROADMAP ground rules) |

**Agent tools** (local MCP server `observations`, each tool in a person-readable manifest, `runsOn: local`, no hosts; outputs capped and text fenced as untrusted):

| Tool | Returns | Caps and rules |
|---|---|---|
| `obs.slice` | Observations matching a slice | Max features per call; says when it was cut at the cap (KB-13 wording) |
| `obs.track` | One entity's track with grades and gaps | Reader-relative |
| `obs.near` | What is near a place or along a route in a window | |
| `obs.changes` | What changed in a slice since T (new, moved, went stale, went dark) | The main input for watch officers |
| `obs.corroboration` | For a claim or entity: independent origins, grades, contradictions | Same rules as drop 1 `corroboration` |
| `obs.timeline` | Events in a slice ordered by valid or known time | |
| `watch.propose`, `watch.list` | Draft a watch; list armed watches and recent matches | Arming is a person's step |
| `cop.layer.propose` | A proposal to a layer the member does not own | Owner merges (D10 4.3) |

People get the same slices on the map: lasso or NAI pick, time slider with a valid or known toggle, grade chips, discipline toggles and an echelon tree.

---

## 6. The COP and the globe

### 6.1 Layers and owners

The five product layers of design 10 stay as they are (operations J3, threat J2, terrain J2, logistics J4, plans J5; plans never merge into the current picture; D10 4.3, UX 5.10). Feed layers are new and are *views*, not products: nobody writes them by hand, so the single-writer rule applies to their **settings** (which channels, which grades, which decay).

| Feed layer | Settings owner | Content | Feeds |
|---|---|---|---|
| Friendly positions | J3 joc-chief | Own and coalition tracks | CoT now; FFI from partners later |
| Maritime picture | J3 (maritime liaison) with J2 contributions | AIS and radar tracks, dark contacts | AIS, CoT radar tracks |
| Air picture | J3 (airspace liaison) | ADS-B, CoT air tracks | ADS-B, CoT |
| Intelligence observations | J2 watch-officer | Graded observations from all disciplines | All J2 channels |
| OSINT events | J2 osint-analyst | Geocoded RSS and GDELT items | RSS, GDELT |
| Imagery footprints | J2 collection-manager | What was covered when, never the pixels in drop 2 | Imagery metadata, 4609 KLV footprints later |
| Weather | J2 geoint-analyst | Wind, sea state, precipitation, visibility; alerts | Weather packs |
| Terrain | J2 geoint-analyst | Hillshade, contours, MCOO overlays | DEM packs, OSM extracts |

The threat layer remains the threat-analyst's *assessment*, drawn from the observation layer but distinct from it: "41 CSTL BTY (two years old)" is a threat-layer feature citing TR-01, while TR-01's position is an observation.

### 6.2 Symbols

milsymbol (MIT; MIL-STD-2525C, D and E, FM 1-02.2, APP-6 B, D and E; version 3 renders to the 2525E and APP-6E look) [F48], vendored at 3.0.5 (UX 12.2). The profile picks APP-6 or 2525. CoT types map to SIDCs through a table [F58]. **Affiliation comes from the J2's assessment, not from the feed**: an AIS ship is "unknown" or "neutral" until assessed, and the card says who assessed it and from what. Frames, fills and dashed "anticipated" frames follow UX 5.10, so colour is never the only cue.

### 6.3 2D map and the globe

| Option | Licence | Strengths | Weaknesses | Verdict |
|---|---|---|---|---|
| MapLibre GL JS globe | BSD-3-Clause [F44] | One library for 2D and globe; terrain on the globe since 5.0.0 (January 2025) [F44]; already chosen for `cop-map` (D10 6.2) | GL JS only, not MapLibre Native [F44]; no full 3D analysis | **Use** |
| CesiumJS | Apache-2.0; Cesium ion an optional subscription [F46] | True 3D, 3D tiles, terrain analysis | Larger bundle; without ion you supply your own terrain and imagery, and the default world terrain and geocoder are unavailable [F46] | Later, optional lazy bundle for viewshed and 3D |
| deck.gl GlobeView | MIT | Fast large-data layers | GlobeView marked experimental [F45] | No |
| Kepler.gl | MIT [F47] | Good time playback and filter design [F47] | A full React application, heavy for a webview | Borrow the playback design only |

The webview constraints are already worked out in UX 12.3: no `unsafe-eval`, the MapLibre worker from a blob URL, `worker-src blob:`, bundled glyphs, offline tiles by default. That CSP spike is a prerequisite for WP-COP and covers the globe too.

### 6.4 Time slider, terrain and offline tiles

- **Time slider:** the shared clock filters every feed layer on `valid_at` (or `known_at` in "as known" mode); product layers show the version current at the clock time. Play, step and speed as in UX 13.
- **Terrain:** DEM packs converted to terrain-RGB tiles on the build machine; hillshade and 3D in MapLibre; contours by maplibre-contour [F51].
- **Offline tiles:** PMTiles packs (section 4.7). An organization tile server only when configured, only at the levels the policy allows (UX 12.3).

### 6.5 Fictional geography on a real globe

The starter scenario has a fictional grid (`grid.kind: fictional`, name `KQ`) and the scenario reader refuses real coordinates (drop 1 `scenario.ts`). CoT and AIS need WGS 84 positions, and a globe needs a place on Earth. Recommendation: an **exercise frame**.

- Add an optional `frame` to the scenario format as version 2 beside version 1 (D-22): a transform from the KQ grid to a small WGS 84 box over empty ocean near the oceanic pole of inaccessibility (48°52.6′S 123°23.6′W, 2,688 km from the nearest land [F55]), so nothing real is near and no real area of interest is revealed.
- Ship a synthetic coastline, rivers and DEM for the Kestrel Peninsula in that frame, generated from the scenario's features (Harrow Ridge, River Brenn, Brenn marshes), so terrain, contours and hillshade look real but are not.
- The guard-scan geofence allows exactly the frame box and refuses everything else (D10 6.2 `guard-scan`).
- Keep the SVG fictional map of UX 12.2 as the fallback when the map bundle is not loaded.

**Finding on the starter scenario.** Read as a normal grid (northings growing northward), several positions contradict their descriptions: AA OAK at KQ 4332 is "north of Saltmere" at KQ 4335; PL COPPER is "4 km south of Port Calder" (KQ 4614), yet 1-41 MECH sits "along PL COPPER north of Ashby Ford" at KQ 4519 with Ashby Ford at KQ 4522. Every description fits if northings grow *southward*. Before the frame transform is written, either renumber the northings in the scenario or record the axis in the frame. This is a one-line data decision but it affects every replayed position.

---

## 7. Open-source prior art to reuse

| Project | Licence | Maturity | What we take | Verdict |
|---|---|---|---|---|
| TAK Server | GPL-3.0 [F6]; open since June 2022 [F7] | Government product; pull requests vetted by the government [F7] | Wire compatibility tests | Interoperate; never embed |
| ATAK-CIV | GPL-3.0 [F8] | Repository archived 2 May 2025 [F8] | Reference for CoT detail conventions | Read only |
| FreeTAKServer | EPL-2.0 [F4] | Described as production stage [F4] | Optional separate server for demos with real TAK clients | Run beside, not inside |
| OpenTAKServer | GPL-3.0 [F5] | Active (over 1,100 commits; no tagged release shown) [F5] | Feature list as a checklist (data packages, missions, video) | Run beside, not inside |
| CloudTAK | AGPL-3.0 [F9] | Very active (over 13,000 commits) [F9] | Browser COP and ETL design ideas | Read only |
| pytak | Apache-2.0 [F10] | Library and gateways | Gateway patterns | Reference |
| node-cot (`@tak-ps/node-cot`) | MIT [F3] | Frequent releases; needs Node 22 [F3] | CoT to GeoJSON both ways | Candidate to vendor after review; or write our own small codec |
| takproto implementations | Varies | Community | TAK protocol framing [F2] | Reference for a later protobuf codec |
| OpenCPN | GPL-2.0 with other licences [F49] | Mature chart plotter with AIS target tracking and collision alerting [F49] | AIS display and alert conventions | Read only |
| pyais | MIT [F12] | Pure Python decoder and encoder | Host-side AIS decoding; test vectors | Use on the host; a small TypeScript decoder in drop 2 |
| OpenSky Network | Data licence restricts purposes and redistribution [F16] | Large research network | Nothing for demos | Not used |
| ADS-B community aggregator | ODbL data [F17] | Active | Optional live source with attribution | Later, Public only |
| Kepler.gl | MIT [F47] | Open governance; 3.x line [F47] | Time playback design | Design reference |
| deck.gl | MIT | Mature | Not needed | No |
| CesiumJS | Apache-2.0 [F46] | Mature | 3D analysis later | Optional later |
| MapLibre GL JS | BSD-3-Clause [F44] | Mature; globe since 5.0.0 [F44] | Map and globe | Use |
| milsymbol | MIT [F48] | Mature, single file, no dependencies [F48] | Symbols | Use |
| mil-sym (Mission Command) | Apache-2.0 (older JS line retired) [F48][F56] | Government-sponsored renderers incl. multipoint graphics [F56] | Multipoint tactical graphics later | Evaluate when graphics are needed |
| map.army | Hosted web application [F56] | Not confirmed as open source | Overlay exchange ideas | Reference |
| Protomaps and PMTiles | BSD-3-Clause code; spec public domain; basemap is an ODbL produced work [F36] | Mature | Offline tile packs | Use |
| maplibre-contour | BSD-3-Clause [F51] | Used in production [F51] | Contours from DEM | Use |
| GDAL | MIT, some files BSD [F52] | Mature | GRIB2, NetCDF, DTED, GeoTIFF on the host | Use on the host |
| PostGIS | GPL [F50] | Mature | Not under the v0.6.0 licence rule | Exception only by owner decision |
| h3-pg | Apache-2.0 [F50] | Accepted under the PostGIS project umbrella, December 2025 [F50] | Spatial cells on the host | Candidate |

No open-source "COP application" found is both maintained and permissively licensed with military symbols; the closest projects are renderers or copyleft TAK clients [F56][F9]. The extension's own `cop-map` on MapLibre and milsymbol remains the right build.

---

## 8. Demo strategy: IRON LANTERN as live feeds

### 8.1 What the J2 demo shows

The demo replays the scenario's own reports as feed traffic on a compressed clock, so the J2 room sees reports land on the map, the knowledge graph link them, watches fire, and the threat-analyst's ECOA drafts update, with a person deciding.

| Scenario item | Stream | Emitted as | What the room sees |
|---|---|---|---|
| Coalition forces (TF ANVIL, 1 MECH, RECCE, TG SHOAL) | CoT | Friendly position events every few seconds | J3 friendly layer moving along Route IRON |
| PR-11 patrol (D-6 0540) | CoT | Hostile infantry spot report at PL COPPER from the RECCE device | Threat observation, grade B and 2 |
| PR-12 patrol | CoT | Infrastructure point at Kell bridge, "intact, ford passable" | Terrain layer note |
| IM-04 imagery (D-5 1130) | CoT plus GeoJSON | Imagery footprint polygon and vehicle detections | Footprint layer; detections linked to 2-41 MECH and 3-41 ARMD as proposals |
| OS-02, OS-03 (D-5 1900, 2130) | RSS | Two items from two fictional outlets with one origin | The graph shows one origin; corroboration does not rise (drop 1 rule) |
| MV ORLA, coastal guard flotilla, fishing boat | AIS | `!AIVDM` sentences, fictional MMSIs from a reserved range | Maritime picture |
| MP-05 maritime (D-5 0310) | CoT | Radar track U-1, unknown sea surface, with no AIS | A "dark" contact beside the AIS tracks |
| FR-01, HR-02 human | Partner simulation (HUMINT) | Mock partner MCP results, labelled as partner simulations, routed `local-only` | Chat mark rises; trust badge shows local-only |
| EW-07 signals | Partner simulation (SIGINT) | Lines of bearing as observations | Located 41 CSTL BDE net, partner-labelled |
| TR-01 technical | Import | GeoJSON of the pre-invasion battery survey | Old observation, credibility 4 |
| HQ-07 higher INTSUM | Import | Document plus overlay | Higher's assessment with its own grade |
| OS-04 state broadcast (D-4 1800) | RSS | Item claiming the coast is mined, grade E and 4 | Deception note prompted |
| Weather | Pack | Synthetic front and sea state over the frame (or real public forecast for the frame point, which reveals nothing) | Sea state affects LA AMBER and the MCM detachment |

**The decisive moment.** A watch armed on NAI 3 (harbour approaches and eastern channel) for "small craft activity at night" matches MP-05 and then FR-01, two independent origins. The watch drafts an INTREP; the threat-analyst drafts a revision of the MDCOA "defensive mining of the eastern channel", raising its likelihood in ICD 203 terms and naming OS-04 as possible deception; dependent products show "source changed"; the watch officer (a person) is alerted and the commander's decision queue gets the PIR change. Nothing is released by an agent.

### 8.2 How the streams are produced

- **Inject script.** A JSONL file beside the scenario: each line is a scenario time (`D-5 0310`), a stream, and a message template referring to scenario ids. The generator maps D-day to a demo clock with a compression factor, uses a fixed seed, and emits CoT on a loopback UDP or TCP port, AIS sentences (our own encoder, with checksums) on loopback, an RSS file served from a loopback HTTP server or read as a file, and partner simulations from a mock MCP server.
- **Every message is marked.** CoT events carry an exercise marker in `detail`; RSS items carry "EXERCISE" in the title; AIS has no free-text field, so the source itself is a simulated source and every observation from it is tagged.
- **Nothing is transmitted on radio** and nothing leaves loopback; the network-spy test asserts it (ROADMAP ground rules).
- **The same fixture drives tests and the Staff Room Playground** (UX 11 item 6).

### 8.3 Safety of the demo data

The scenario guards already refuse markings, names on your organization's real-entity list and coordinates outside the exercise area (drop 1 `scenario.ts`). Add: fictional MMSIs from a reserved range, checked against nothing real; the frame geofence; no real place names in the synthetic terrain; and the "all fictional" statement on the COP's SIM badge.

---

## 9. Recommended demo slice for drop 2

### 9.1 Principles

Built on the v0.6.0 contracts, so nothing is thrown away:
- the observation row is the v0.6.0 row shape (section 3.1) with `label_id` from the existing gate;
- feed sources speak the connector messages (`RECORD`, `STATE`, `LOG`) and follow the source lifecycle;
- slices are saved scopes with the same dimensions the host will index;
- agent tool names and signatures are the ones the host will serve, so swapping the local store for the host query service changes the backend only;
- a one-shot "local staff store" connector in v0.6.0 imports drop 2 segments as a source.

### 9.2 What is in drop 2

1. **`cop-map`** (WP-COP, already planned): MapLibre and milsymbol vendored, layer ownership enforced, feed layers as read-only views, globe toggle, shared time slider, PMTiles and DEM packs, SIM badge.
2. **Local observation store**: append-only segments (NDJSON, one per feed, channel and hour) in the extension's workspace storage, not in git; a manifest with hashes; in-memory spatial grid and time index rebuilt on start; size cap per project; label per row; template ceiling enforced on write.
3. **Importers**: GeoJSON, KML (placemarks, paths, polygons, time spans), CoT XML (event, point, common detail elements), RSS 2.0 and Atom, AIS sentences (types 1 to 3, 5, 18, 19, 24). XML parsing with document type declarations and entity expansion turned off, since XML entity expansion attacks hit popular parsers as recently as 2026 [F53]. Parsing runs in a separate local process, not in the extension host.
4. **Weather and terrain layer** from packs: a synthetic DEM, coastline and weather for the exercise frame; a pack builder (on the developer machine, with GDAL) that turns a real DEM or forecast into the same pack format for real training areas. GRIB2 decoding stays out of the extension.
5. **Simulated streams**: the inject script and generator of section 8.2, and the scenario frame (version 2 beside version 1).
6. **Agent slice tools**: the `observations` server of section 5.
7. **Standing watches**: the state machine of section 4.5, attended runs only.

### 9.3 Work packages

One line on order: WP-OBS0 goes first because every other package imports its row schema, tool signatures and event names; everything after it runs in parallel worktrees from the same base, then one integration.

| WP | Scope | Worktree | Depends on | Tests |
|---|---|---|---|---|
| WP-OBS0 Contract | Observation row type and JSON Schema; feed source descriptor (class, decay, backpressure policy, default grades, label); slice type; tool signatures; event names; scenario frame schema (v2 beside v1) and the northing-axis fix | `feat/obs-contract` | WP-0 (drop 1) | Schema round trip; v1 scenarios still load; frame refuses a box that touches land in the bundled Natural Earth coastline; event names registered |
| WP-COP | `cop-map` as in D10 9.1, plus globe toggle, time slider, feed layers as views, SIM badge | `feat/cop-map` | WP-0, WP-OBS0 | Layer ownership enforced; feed layers not writable; no network call with offline packs (gate record); symbol snapshots; globe renders the frame; slider filters by valid and known time |
| WP-OBS Store | Segments, manifest, indexes, decay states, replay cursor, gap records, label clamp, size cap, rebuild after host restart | `feat/obs-store` | WP-OBS0 | Idempotent re-delivery; decay transitions at the right times; "as known at T" equals a store built only from rows known by T; restart rebuild; template ceiling refusal; two-label indistinguishability of slices |
| WP-IMP Importers | GeoJSON, KML, CoT, RSS and Atom, AIS codecs in a separate local process | `feat/obs-importers` | WP-OBS0 | Fixtures per format; malformed and hostile inputs (entity expansion, huge files, bad checksums, multi-part AIS out of order); CoT type to SIDC table |
| WP-SIM Streams | Inject script format, generator, loopback emitters, mock partner MCP server with partner-simulation labels | `feat/obs-sim` | WP-OBS0 | Deterministic output for a seed; resume from a cursor; nothing leaves loopback (network spy); every message marked; partner results routed `local-only` |
| WP-ENV Packs | Synthetic DEM, coastline and weather for the frame; pack format; pack builder script; contours and hillshade | `feat/obs-env` | WP-OBS0 | Pack validates; no real coordinates outside the frame; attribution strings present for any real-data pack |
| WP-WATCH | Watch state machine, matching, de-duplication, alerts, INTREP and ECOA revision drafts through the release state machine | `feat/obs-watch` | WP-OBS0 | Every transition and forbidden transition; no release by an agent; paused watch queues matches; LTIOV expiry; alert rate limit |
| WP-TOOLS | `observations` MCP server with manifests; built against an in-memory fake of the store | `feat/obs-tools` | WP-OBS0 | Caps and cut-off wording; label clamp; untrusted fencing; manifest declares no hosts |
| Integration and WP-DEMO2 | Merge, the IRON LANTERN J2 feed demo script and fixtures, UAT script | `feat/obs-integration` | All | Full suite once; scripted J2 run reaches the decisive moment of 8.1 with a person deciding |

### 9.4 What stays for v0.6.0

| Item | Phase |
|---|---|
| `observation` table, spatial index (GiST or `h3`), RLS and the two-compartment test over spatial slices | 88 (governed store), 96 |
| Feed source label maps and partner label mapping in the signed bundle | 93 |
| Feed segments as a documented raw-copy reason, with retention classes | 88, 94 (owner decision Q2) |
| Public feed connectors through declarative manifests: NWS, ECMWF, ECCC (AMQP), GDELT, RSS lists, an AIS stream with bounding boxes | 100 |
| GRIB2, NetCDF, DTED and DEM processing in sandboxed workers with GDAL | 92 |
| Entity pages for units, platforms and places; entity resolution at scale (Splink for tabular feeds) | 96 |
| Map, globe and time replay as knowledge base views (currently "globe deferred") | 97 (owner decision Q1) |
| Partner integrations through the agent exchange (signed cards, mandates) | Later milestone (note 01) |
| Edge offline stores and HQ federation | L5 |
| Specialist models for track classification or report triage | 98, 99 |

---

## 10. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Licence breach by ingesting restricted feeds (ACLED, OpenSky, social media) into a knowledge base that agents and future training read | High | Off by default; licence recorded on the source card; `training.rights` no; review before any connector is enabled [F40][F16][F42] |
| Area of interest revealed by outside requests (tiles, bounding-box subscriptions, search terms) | High | Offline packs; organization servers only; outside feeds Public-only; wide or bulk subscriptions (D10 6.2) [F14][F35] |
| Malicious feed input (XML entity expansion, oversized messages, crafted protobuf) | High | Separate parser process; DTD off; size and rate limits; fuzz fixtures [F53] |
| Deception and spoofing treated as fact (AIS, state media, staged video) | High | Two grades, origin independence, deception notes, corroboration tools; a feed's affiliation is a claim [F54] |
| Automation bias: agents' ECOA updates read as decisions | High | Drafts only; tradecraft gate; named person decides; ICD 203 wording (D10 4.4) |
| Compilation: tracks and patterns reveal more than any single observation | High | Join labels on derived rows; aggregation rules; release-guard compilation check (DP §6.2, D10 7) |
| Copyleft code entering the product (TAK servers and clients, PostGIS) | Medium | Wire interoperability only; licence check in CI; separate optional processes for demos [F5][F6][F8][F9][F50] |
| Real coordinates leaking into the fictional demo | Medium | Exercise frame over empty ocean; geofence; synthetic terrain [F55] |
| Grid axis inconsistency in the starter scenario misplaces units | Medium | Fix in WP-OBS0 (section 6.5) |
| Alert fatigue from chatty watches | Medium | De-duplication, rate limits, digests, LTIOV expiry |
| Webview performance and CSP for MapLibre's worker and the globe | Medium | The UX 12.3 spike before WP-COP; host sends at most 10 diffs a second |
| Extension host restarts (code-server) interrupt ingest | Medium | Cursor with every write; deterministic simulator; rebuild from segments |
| Personal data in feeds (small-craft MMSIs, private aircraft, OSINT about people) | Medium | No person entities in staff projects; OpenSky-style anonymization when publishing [F16]; v0.6.0 privacy facts |
| ODbL share-alike on a derived database used publicly | Low | Internal use only; attribution on the map [F35][F17] |
| Partner labels above the template ceiling arriving in a staff project | Medium | Refused at the label stamp; real partner data belongs on accredited systems (D10 7) |

---

## 11. Open questions

**For the owner**

| # | Question | Recommendation |
|---|---|---|
| Q1 | Bring the globe back into v0.6.0 as Phase 97 "map, globe and time replay" (it is deferred today)? | Yes: the owner's need puts every feed on the globe, and the MapLibre globe costs little beyond the 2D map |
| Q2 | Keep raw feed segments as a fourth documented raw-copy reason (streams cannot be re-read)? | Yes, encrypted, content-addressed, with a retention class per feed |
| Q3 | Exercise frame over empty ocean for IRON LANTERN, or keep fictional scenarios on the SVG map only? | The frame, so the demo shows the globe and real feed formats |
| Q4 | Fix the starter scenario's northings now (data change in drop 1's file) or declare the axis in the frame? | Fix the data; a southward axis surprises every reader |
| Q5 | Standing watches before Phase 74: attended runs only? | Yes; unattended watches wait for run contracts |
| Q6 | PostGIS exception to the licence rule, or GiST and `h3` only? | No exception unless the Phase 88 spike shows a real gap |
| Q7 | Offer a TAK server beside the demo so real TAK phones can join? | Optional: FreeTAKServer (EPL-2.0) as a separate process, never bundled |
| Q8 | ACLED and social media: excluded by default? | Yes, until your organization holds licences that cover this use |

**For spikes or phase research**

- MapLibre globe plus terrain inside a VS Code webview under the UX 12.3 CSP, and how many live tracks it holds within the budgets.
- Whether `h3` without its PostGIS bridge gives the slice performance needed at host scale (Phase 88).
- A KML subset that covers what partners actually send (Phase 100 research).
- Whether to vendor node-cot or write a smaller CoT codec (WP-IMP review).
- The ECMWF attribution wording to show on a weather layer [F28], and the ECCC wording [F29].
- STANAG 4607, 4609 and 5527 documents: buy through a standards body before any partner connector is designed; nothing here used their text.

---

## Sources

Confidence: MEDIUM means the primary page was read directly or two sources agreed; LOW means a single search excerpt, a catalogue listing or a secondary summary. Accessed 18 November 2026 unless stated. "n.d." means no date was shown.

- **[F1]** FreeTAKServer user documentation, "CoT domain" (architecture), n.d. https://babeloff.github.io/FreeTAKServer-User-Docs/About/architecture/cot_domain . MEDIUM.
- **[F2]** takproto documentation, "TAK Protocol Description", n.d. https://takproto.readthedocs.io/en/latest/tak_protocols/ ; pytak documentation, "Compatibility", n.d. https://pytak.readthedocs.io/en/latest/compatibility/ . LOW.
- **[F3]** npm, "@tak-ps/node-cot: Javascript Cursor-On-Target Library", versions to 14.44.3, n.d. https://npmjs.org/package/@tak-ps/node-cot ; Yarn listing https://classic.yarnpkg.com/en/package/@tak-ps/node-cot . LOW.
- **[F4]** Ecosyste.ms, "FreeTAKTeam/FreeTakServer" project listing (licence epl-2.0, production stage), n.d. https://awesome.ecosyste.ms/projects/github.com%2Ffreetakteam%2Ffreetakserver ; PyPI, "FreeTAKServer" https://pypi.org/project/FreeTAKServer/ . LOW.
- **[F5]** GitHub, "brian7704/OpenTAKServer" (GPL-3.0), n.d. https://github.com/brian7704/OpenTAKServer . MEDIUM.
- **[F6]** GitHub, "TAK-Product-Center/Server", n.d., and its LICENSE.md (GNU GPL v3). https://github.com/TAK-Product-Center/Server ; https://raw.githubusercontent.com/TAK-Product-Center/Server/main/LICENSE.md . MEDIUM.
- **[F7]** civtak.org, "TAK Server is now open source", 28 June 2022. https://civtak.org/2022/06/28/takserver-pr . LOW.
- **[F8]** GitHub, "deptofdefense/AndroidTacticalAssaultKit-CIV" (archived 2 May 2025) and its LICENSE.md (GNU GPL v3). https://github.com/deptofdefense/AndroidTacticalAssaultKit-CIV ; https://raw.githubusercontent.com/deptofdefense/AndroidTacticalAssaultKit-CIV/master/LICENSE.md . MEDIUM.
- **[F9]** GitHub, "dfpc-coe/CloudTAK" (AGPL-3.0), n.d. https://github.com/dfpc-coe/CloudTAK . MEDIUM.
- **[F10]** PyTAK documentation, "License" (Apache-2.0), n.d. https://pytak.readthedocs.io/en/latest/license/ ; GitHub https://github.com/snstac/pytak . LOW.
- **[F11]** E. S. Raymond, "AIVDM/AIVDO protocol decoding", version 1.58, 24 June 2023. https://gpsd.gitlab.io/gpsd/AIVDM.html . MEDIUM.
- **[F12]** PyPI, "pyais" (MIT), n.d. https://pypi.org/project/pyais/ . LOW.
- **[F13]** GitHub, "ocm-marinecadastre/ais-vessel-traffic" (CC0 1.0), n.d. https://github.com/ocm-marinecadastre/ais-vessel-traffic ; NOAA InPort, "Nationwide Automatic Identification System 2025" https://www.fisheries.noaa.gov/inport/item/77594 . LOW.
- **[F14]** aisstream.io, "Documentation" (beta, no SLA, subscription within 3 seconds, keep the key on a backend), n.d. https://aisstream.io/documentation . LOW.
- **[F15]** OpenSky Network, "The OpenSky Network API documentation", n.d. https://openskynetwork.github.io/opensky-api/ . MEDIUM.
- **[F16]** OpenSky Network, "General Terms of Use & Data License Agreement" (copy deposited on Zenodo), n.d. https://zenodo.org/records/6325961/files/LICENSE.txt?download=1 . MEDIUM (the official terms page refused automated reading).
- **[F17]** adsb.lol documentation, "Historical data" (ODbL 1.0), n.d. https://www.adsb.lol/docs/open-data/historical/ . LOW.
- **[F18]** Open Geospatial Consortium, "OGC SensorThings API Part 1: Sensing Version 1.1" (18-088), n.d. https://docs.ogc.org/is/18-088/18-088.html . LOW.
- **[F19]** Open Geospatial Consortium, "GeoPackage Encoding Standard", n.d. https://www.ogc.org/standard/geopackage/ ; https://www.geopackage.org/spec/ . LOW.
- **[F20]** Open Geospatial Consortium, "OGC API - Features" and the OGC Implementation Database listings for WMS 1.3.0, WMTS 1.0.0 and WFS 2.0, n.d. https://www.ogc.org/standard/ogcapi-features/ ; https://portal.ogc.org/public_ogc/compliance/product.php?pid=1874 . LOW.
- **[F21]** IETF, RFC 7946, "The GeoJSON Format", August 2016, and erratum 5069. https://www.rfc-editor.org/rfc/rfc7946 ; https://rfc-editor.org/errata/eid5069 . LOW.
- **[F22]** Open Geospatial Consortium, "KML" standard page, n.d. https://www.ogc.org/standard/kml/ . LOW.
- **[F23]** MITRE, "Evolution of a Standard: The STANAG 4607 NATO GMTI Format", n.d. https://www.mitre.org/news-insights/publication/evolution-standard-stanag-4607-nato-gmti-format ; Wireshark display filter reference "s4607" https://www.wireshark.org/docs/dfref/s/s4607.html ; GlobalSpec listing "AEDP-7" https://standards.globalspec.com/std/1605776/aedp-7 . LOW.
- **[F24]** stanag4609 project documentation, "Standards baseline", n.d. https://stanag4609.readthedocs.io/en/latest/STANDARDS/ . LOW.
- **[F25]** Standards shop listing, "STANAG 5527 Ed 2:2025", n.d. https://shop.standards.ie/en-ie/standards/stanag-5527-ed-2-2025-737591_saig_nato_nato_3635295 ; NATO Interoperability Standards and Profiles, volume 3, "Technical Services" https://nhqc3s.hq.nato.int/apps/architecture/nisp/volume3/ch01s03.html . LOW.
- **[F26]** Wikipedia, "Multilateral Interoperability Programme", n.d. https://en.wikipedia.org/wiki/Multilateral_Interoperability_Programme . LOW.
- **[F27]** C2SIM server documentation, "C2SIM in a nutshell", n.d. https://tno-mst.github.io/c2sim-server/c2sim-in-nutshell . LOW.
- **[F28]** ECMWF, "Open data", n.d. https://www.ecmwf.int/en/forecasts/datasets/open-data ; ECMWF forum, "Attribution Reminder under CC-BY-4 for ECMWF Products from the Real-time Catalogue" https://forum.ecmwf.int/t/attribution-reminder-under-cc-by-4-for-ecmwf-products-from-the-real-time-catalogue/14480 . LOW.
- **[F29]** Environment and Climate Change Canada, "Environment and Climate Change Canada Data Services End-use Licence", version 2.1.1, August 2026. https://eccc-msc.github.io/open-data/licence/readme_en/ ; "GRIB2 data format" https://eccc-msc.github.io/open-data/msc-data/readme_grib_en . MEDIUM.
- **[F30]** US National Weather Service, "API Web Service", n.d. https://www.weather.gov/documentation/services-web-API . MEDIUM.
- **[F31]** NOAA NCEP, "GFS products on NOMADS", n.d. https://www.nco.ncep.noaa.gov/pmb/products/gfs/nomads/ . LOW.
- **[F32]** GDAL, "DTED: Military Elevation Data" driver, n.d. https://gdal.org/drivers/raster/dted.html ; NGA, MIL-PRF-89020B, 23 May 2000 (archived) https://webarchive.library.unt.edu/eot2008/20081106021115/http://www.nga.mil/ast/fm/acq/89020B.pdf . LOW.
- **[F33]** USGS, "USGS EROS Archive: Digital Elevation: Shuttle Radar Topography Mission (SRTM)", n.d. https://www.usgs.gov/centers/eros/science/usgs-eros-archive-digital-elevation-shuttle-radar-topography-mission-srtm ; OpenStreetMap wiki, "Srtm" https://wiki.openstreetmap.org/wiki/Srtm . LOW.
- **[F34]** Copernicus, "License COPDEM 30" (PDF), n.d. https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/DEM/resources/license/License-COPDEM-30.pdf ; Registry of Open Data, "Copernicus Digital Elevation Model (DEM)" https://registry.opendata.aws/copernicus-dem/ . LOW.
- **[F35]** OpenStreetMap Foundation, "Tile Usage Policy", n.d. https://operations.osmfoundation.org/policies/tiles/ ; "Licence and Legal FAQ" https://osmfoundation.org/wiki/Licence_and_Legal_FAQ . LOW.
- **[F36]** Protomaps documentation, "Basemap downloads", n.d. https://docs.protomaps.com/basemaps/downloads . LOW.
- **[F37]** Natural Earth, "Terms of use", n.d. https://www.naturalearthdata.com/about/terms-of-use/ . LOW.
- **[F38]** IETF, RFC 4287, "The Atom Syndication Format", December 2005. https://www.rfc-editor.org/rfc/rfc4287 ; RSS Advisory Board, "RSS 2.0 Specification" https://www.rssboard.org/rss-specification . LOW.
- **[F39]** The GDELT Project, "About" (terms of use), n.d. https://www.gdeltproject.org/about.html ; GDELT blog, "GDELT 2.0: Our Global World In Realtime" https://blog.gdeltproject.org/gdelt-2-0-our-global-world-in-realtime/ ; "GDELT GEO 2.0 API Debuts" https://blog.gdeltproject.org/gdelt-geo-2-0-api-debuts/ . LOW.
- **[F40]** ACLED, "End User License Agreement", last updated 1 November 2026. https://acleddata.com/eula . MEDIUM.
- **[F41]** News API, "Terms", 30 April 2020. https://newsapi.org/terms . LOW.
- **[F42]** X Developer Platform, "Restricted use cases", n.d. https://docs.x.com/developer-terms/restricted-use-cases ; "Developer guidelines" https://docs.x.com/developer-guidelines . MEDIUM for the restricted use cases page.
- **[F43]** Technology news report, "Reddit locks down its public data in new content policy, says use now requires a contract", 9 May 2024. https://techcrunch.com/2024/05/09/reddit-locks-down-its-public-data-in-new-content-policy-says-use-now-requires-a-contract . LOW.
- **[F44]** MapLibre, "Globe View" roadmap item (released in GL JS 5.0.0, January 2025), n.d. https://maplibre.org/roadmap/maplibre-gl-js/globe-view ; GitHub "maplibre/maplibre-gl-js" (3-Clause BSD) https://github.com/maplibre/maplibre-gl-js ; example "Create a time slider" https://maplibre.org/maplibre-gl-js/docs/examples/create-a-time-slider/ . MEDIUM.
- **[F45]** deck.gl, "GlobeView (Experimental)", n.d. https://deck.gl/docs/api-reference/core/globe-view . LOW.
- **[F46]** GitHub, "CesiumGS/cesium" (Apache-2.0; Cesium ion optional), n.d. https://github.com/CesiumGS/cesium ; Cesium community forum, "Cesium ion licensing" https://community.cesium.com/t/cesium-ion-licensing/8633 . MEDIUM.
- **[F47]** kepler.gl documentation, "Time playback" user guide and release notes, n.d. https://docs.kepler.gl/docs/user-guides/h-playback ; https://docs.kepler.gl/release-notes . LOW.
- **[F48]** npm, "milsymbol" (MIT), n.d. https://npmjs.com/package/milsymbol . LOW (version and size measured in UX 12.2).
- **[F49]** GitHub, "OpenCPN/OpenCPN", n.d. https://github.com/opencpn/opencpn . LOW.
- **[F50]** PostGIS, LICENSE.TXT (GNU GPL), n.d. https://raw.githubusercontent.com/postgis/postgis/master/LICENSE.TXT (MEDIUM); PGXN, "h3" (Apache 2.0) https://pgxn.org/dist/h3/ (LOW); postgis-devel list, "PSC Vote: accept h3_pg under PostGIS umbrella", December 2025 https://lists.osgeo.org/pipermail/postgis-devel/2025-December/030706.html (LOW).
- **[F51]** GitHub, "onthegomap/maplibre-contour" (BSD 3-Clause), n.d. https://github.com/onthegomap/maplibre-contour . LOW.
- **[F52]** GDAL, "License", n.d. https://gdal.org/license.html ; "GRIB: WMO General Regularly-distributed Information in Binary form" https://gdal.org/drivers/raster/grib.html . LOW.
- **[F53]** Snyk, "XML Entity Expansion affecting fast-xml-parser", 2026. https://security.snyk.io/vuln/SNYK-JS-FASTXMLPARSER-15307668 ; OSV, "CVE-2026-33349" https://osv.dev/vulnerability/CVE-2026-33349 . LOW.
- **[F54]** Journal of Marine Science and Engineering, volume 12, issue 1, article 6, on AIS position falsification during ship-to-ship transfers, 2024. https://mdpi.com/2077-1312/12/1/6 . LOW.
- **[F55]** inaccessibility.net, "Point Nemo", n.d. https://inaccessibility.net/nemo/ . LOW.
- **[F56]** Mission Command projects, "missioncommand.github.io", n.d. https://missioncommand.github.io ; map.army, "About" https://www.map.army/about/en.html . LOW.
- **[F57]** Open Geospatial Consortium, "OGC SensorThings API" overview, n.d. https://ogcapi.ogc.org/sensorthings/overview.html . LOW.
- **[F58]** FreeTAKServer user documentation, "MIL-STD-2525" (CoT type table), n.d. https://babeloff.github.io/FreeTAKServer-User-Docs/About/architecture/mil_std_2525 . LOW.

Internal sources (this repository): DP = `.planning/research/data-platform/00-DESIGN.md`; ROADMAP = `.planning/ROADMAP.md` (v0.6.0 Data platform); D10 = `.planning/research/staff-teams/10-STAFF-TEAMS-DESIGN.md`; UX = `.planning/research/staff-teams/ux/STAFF-UX-CONCEPT.md`; note 01 = `01-agent-exchange.md`; note 02 = `02-J2-intelligence.md`; drop 1 code on branch `feat/staff-drop1` under `src/domain/staff/` and `resources/staff/scenarios/iron-lantern.json`.
