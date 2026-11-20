# Environment packs: terrain and weather for the COP map

An environment pack is a small folder of JSON files that gives the COP map its
terrain (hillshade, contours, coastline) and weather, offline. The map never
fetches a tile, raster, glyph or forecast: everything it draws for terrain and
weather comes from a pack on disk. This page is the format; the JSON Schema is
`resources/staff/env/env-pack.schema.json`.

The extension ships one pack, the synthetic pack for Exercise IRON LANTERN, in
`resources/staff/env/iron-lantern/`. It is fictional: a DEM, coastline and
forecast generated from a seed for the scenario's exercise frame over empty
ocean, so nothing on it is a real place or a real forecast.

## The folder

| File | Required | What it holds |
|---|---|---|
| `manifest.json` | yes | What the pack is, its bounding box, attribution and licence, and the SHA-256 and size of every other file |
| `dem.json` | yes | A digital elevation model: whole metres on a regular latitude and longitude grid |
| `coastline.geojson` | yes | Land polygons (`kind: land`) and coastline lines (`kind: coastline`) |
| `weather.json` | no | One forecast model run: a regular grid and one frame of values per valid time |
| `landcover.geojson` | no (version 2) | Land cover areas (`forest`, `scrub`, `farmland`, `beach`, `rock`, `built-up`, `marsh`) and roads and tracks (`road`, `track`) |
| `tiles/index.json` and `tiles/` | no (version 2) | Map tiles: `imagery` (WebP z5-10 over the frame, transparent and feathered beyond it), `imagery-detail` (WebP z11-13 over the land), `terrain` (Terrarium PNG z5-11, sea at 0 m, the 3D surface) and `relief` (Terrarium PNG z5-11 with the sea floor) |

The manifest can name only these file names, so a pack can never point at a
file outside its own folder. Version 2 adds `files.landcover` and
`tiles: { "path": "tiles/index.json", "sha256": ..., "bytes": ... }`; version 1
packs stay valid, and a version 1 manifest may not name either.

The tile index (`"format": "near-map-tiles"`) lists each set's format, zoom
range and bounds, and every tile as `["z/x/y", bytes, sha256, pixel digest]`,
one per line. The pixel digest is the first 16 hex characters of the SHA-256
of the tile's RGBA pixels before encoding, so a regeneration check compares
pixels even where two encoder builds write different bytes. Tile paths are
plain numbers inside the set's zoom range and bounds, at most 512 KB each, and
must start with their format's magic bytes; the extension checks the index's
hash and every tile before the map gets a tile address (SECURITY.md, "COP
map"). Terrarium heights decode as `R * 256 + G + B / 256 - 32768` metres,
MapLibre's own decoding; the bundled pack rounds them to a quarter metre and
adds no detail, so the contours lie on the 3D surface.

## manifest.json

```json
{
  "format": "near-env-pack",
  "version": 1,
  "id": "iron-lantern-synthetic",
  "title": "Exercise IRON LANTERN: synthetic terrain and weather",
  "data": "synthetic",
  "crs": "EPSG:4326",
  "bounds": [-124.077038, -49.326327, -122.70963, -48.427007],
  "frame": { "scenario": "iron-lantern", "grid": "KQ" },
  "generator": { "script": "scripts/generate-env-pack.mjs", "seed": 20270524, "version": 1 },
  "attribution": ["Synthetic exercise terrain and weather, generated from a seed. ..."],
  "licence": "MIT, the same licence as this extension",
  "files": {
    "dem": { "path": "dem.json", "sha256": "<64 hex>", "bytes": 51933 },
    "coastline": { "path": "coastline.geojson", "sha256": "<64 hex>", "bytes": 1432 },
    "weather": { "path": "weather.json", "sha256": "<64 hex>", "bytes": 30850 }
  }
}
```

- `bounds` is west, south, east, north in degrees (WGS 84). Every coordinate
  in every file lies inside it.
- `data` is `synthetic` (generated; needs `generator` with its script and seed,
  so anyone can make it again byte for byte) or `real` (built from real data;
  needs at least one `attribution` line and a `sources` list giving each
  source's `name` and `licence`, with an optional `url`; has no `generator`).
- `attribution` lines are shown under the map whenever one of the pack's
  layers is on.

## dem.json

```json
{ "format": "near-env-dem", "version": 1, "bounds": [w, s, e, n], "width": 117, "height": 117,
  "units": "m", "noData": -32768, "heights": [ ... ] }
```

`heights` holds `width x height` whole metres, row by row from north to south,
each row from west to east. The first value is at (west, north) and the last at
(east, south); the grid's points lie on the bounds. Heights at or below 0 are
sea. At most 2,049 points a side and 1,000,000 points in all.

## coastline.geojson

A GeoJSON FeatureCollection in `[longitude, latitude]`. Each feature is either
a `Polygon` with `properties.kind` `land`, or a `LineString` with `kind`
`coastline`, with an optional short `name`.

## weather.json

```json
{ "format": "near-env-weather", "version": 1, "bounds": [w, s, e, n], "width": 11, "height": 11,
  "model": { "name": "Synthetic exercise forecast", "runAt": "2027-05-17T18:00:00.000Z" },
  "stepHours": 6,
  "variables": [{ "id": "wind-speed", "units": "m/s" }, { "id": "wind-from", "units": "degrees" }, ...],
  "frames": [{ "validAt": "2027-05-18T00:00:00.000Z", "values": { "wind-speed": [ ... ], ... } }, ...] }
```

The grid has the same point order as the DEM. The variables a pack may carry,
each in exactly one unit, are `wind-speed` (m/s), `wind-from` (degrees, the
direction the wind blows from), `sea-state` (Douglas, 0 to 9), `visibility`
(km) and `precipitation` (mm/h); every frame has every declared variable.
Valid times strictly increase. A frame holds from its valid time until the
next frame's, and the last for `stepHours`.

The forecast is a snapshot. The map shows the model run and the lead time with
each frame, and shows no weather outside the frames, so a stale forecast never
looks current. In "as known" replay a frame shows only once its model run had
happened.

## Checks on load

The extension refuses a pack, and says why under the map, when:

- a file breaks the format above, or is larger than 8 MB;
- a file's size or SHA-256 does not match the manifest (the file was changed
  after the pack was made);
- any coordinate lies outside the manifest's bounds;
- the pack is drawn in a scenario's exercise frame and any coordinate lies
  outside that frame, or a synthetic pack was made for another scenario or
  grid;
- a real-data pack has no attribution or no sources with their licences.

## On the map

The COP map (and the Staff Room map that embeds it) adds three layers a person
toggles like any other: **Hillshade** and **Contours** (every 20 m, every
fifth line heavier and labelled with its height, with the coastline) from the DEM, and **Weather**, off by
default: wind arrows pointing downwind, longer for stronger wind; fog where
visibility is under 1 km; rain at 0.5 mm an hour or more; and rough sea at sea
state 4 or more, outlined with a dashed line. The time slider picks the weather
frame. The J2 geoint-analyst owns these layers' settings. Synthetic packs carry
the SIM badge.

With a version 2 pack the map's **Base map** offers **Imagery** (the pack's
imagery with 3D terrain from `terrain`), **Topographic** (colour relief and
hillshade from `relief`, the land cover in topographic tints, contours, roads,
tracks and the grid) and **Plain**. Hillshade and contours start off over
Imagery, whose light is baked in, and on over Topographic. The synthetic
imagery is drawn per pixel from the land cover, the DEM and the coastline:
the classes in true-colour tones, fields with hedgerows, woods with crowns,
streets and roofs in the towns, turquoise shallows to deep water, and the
DEM's hillshade baked in; nothing in it is a real place.

## Making packs

**Synthetic.** `npm run compile`, then `node scripts/generate-env-pack.mjs`
writes the IRON LANTERN pack's files from its seed; `--tiles` also makes every
tile and the index again (`npm run generate:env-pack`; it needs the
devDependency `@jsquash/webp`), and `--seed <n>` makes another pack. `--check`
fails if the committed files or the tile index are not what the seed makes, a
tile does not match the index, or a file in `tiles/` is not listed;
`--check-sample <n>` also draws n deep-zoom imagery tiles and every height
tile again and compares their pixels, and `--check-tiles` draws every tile
again (a few minutes). No GDAL and no network.

**From real data.** `scripts/build-env-pack.mjs` turns a real DEM (any format
GDAL reads, such as GeoTIFF or DTED) and, optionally, a GRIB2 or NetCDF
forecast into the same format, on a developer machine with GDAL installed. It
refuses to run in CI or without GDAL, runs the GDAL tools without a shell on
the files you name, makes no network request of its own, and checks the
result with the extension's own validator before writing it. Pass
`--attribution` and `--source "name|licence|url"` as your data's licences
require. GDAL does all the decoding; the extension never decodes GRIB2,
NetCDF or GeoTIFF.

Real-data packs are for real training areas, which need an exercise frame over
that area. Until that is designed, the map draws only a pack that lies inside
the loaded scenario's frame.
