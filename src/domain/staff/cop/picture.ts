// The COP picture the map component draws (design 10, 4.5; UX concept 5.10, 12.4 and 13; research note 11, 4.3, 4.4 and 6; WP-COP): display data only,
// built by the host from the layer files, the scenario and the observations, and posted to the page. Pure: no I/O, no clock, no vscode.
//
// The page never decides anything: it draws this picture and filters it by the shared clock. Every feature carries its layer, its words (affiliation,
// type, designation, source, grade, label, who put it there) and its times as numbers, so the time slider and the card need nothing else.
//
// Track budget. Measured in the CSP spike (SECURITY.md, "COP map"): MapLibre in the webview held 2,000 moving symbols at 10 updates a second with no
// dropped frames and no long task even on software rendering; at 5,000 the slowest frames doubled. So the picture carries at most COP_TRACK_BUDGET
// feed tracks, the most recently updated first, and says how many it left out. Product-layer features are never cut (a layer holds at most 2,000).
import type { Observation } from '../obs/observation';
import { buildTrack } from '../obs/tracks';
import type { DecayPolicy } from '../obs/feeds';
import type { TrackState } from '../obs/tracks';
import { parseIsoMillis } from '../../gate/shape';
import type { Scenario } from '../scenario';
import { gridCentre, gridReferencesIn, gridToWgs84 } from '../obs/frame';
import type { ExerciseFrame } from '../obs/frame';
import { joinTemplateLabels } from '../obs/observation';
import { FEED_LAYERS } from '../obs/layers';
import type { CopFeature, CopGeometry } from './features';
import { layerLabel } from './features';
import { copLayerTitle, PRODUCT_LAYERS, SEPARATE_LAYERS, writerText } from './layers';
import type { ProductLayer } from './layers';
import type { StaffWriter } from '../ownership';
import { describeSymbol, forceSidc, parseSidc } from './symbols';
import type { Geography } from './geography';
import { cotSidc } from '../obs/codecs/cot';

/** The most feed tracks the map draws at once (measured; see the header). */
export const COP_TRACK_BUDGET = 2000;
/** The most observations of one track the picture carries for replay: the latest ones. */
export const COP_TRACK_HISTORY = 20;
/** The host sends the page at most this many picture updates a second (UX 12.4). */
export const COP_MAX_UPDATES_PER_SECOND = 10;

export const PICTURE_VERSION = 1;
/** The layer id of the scenario's own order of battle and control measures, shown for reference while the product layers are empty. */
export const SCENARIO_LAYER = 'scenario-reference';

export type TimeMode = 'valid' | 'known';

export interface PictureProperties {
  readonly layer: string;
  readonly kind: string;
  readonly name: string;
  readonly sidc?: string;
  readonly anticipated?: boolean;
  readonly ecoa?: string;
  readonly ecoaRole?: string;
  /** Valid from and to, known at, superseded at: epoch milliseconds, absent when open. */
  readonly vf?: number;
  readonly vt?: number;
  readonly ka?: number;
  readonly sup?: number;
  /** A feed track's id and decay state; only its latest visible observation is drawn. */
  readonly track?: string;
  readonly state?: Exclude<TrackState, 'closed'>;
  /** From a simulated source: the SIM badge. */
  readonly sim?: boolean;
  readonly label: string;
  /** The card's lines, in words (affiliation in words, never colour alone). */
  readonly card: readonly string[];
}

export interface PictureFeature { readonly type: 'Feature'; readonly id: string; readonly geometry: CopGeometry; readonly properties: PictureProperties }

export interface PictureLayer {
  readonly id: string;
  readonly title: string;
  readonly kind: 'product' | 'feed' | 'reference';
  /** Who writes it (a product layer), who sets it (a feed layer), or where it comes from. */
  readonly owner: string;
  readonly label: string;
  /** Drawn apart from the current picture and off by default (the plans layer). */
  readonly separate: boolean;
  readonly visible: boolean;
  readonly simulated: boolean;
  readonly count: number;
  readonly note?: string;
}

export interface CopPicture {
  readonly version: typeof PICTURE_VERSION;
  readonly marking: string;
  readonly frame?: { readonly grid: string; readonly bounds: readonly [number, number, number, number]; readonly centre: readonly [number, number] };
  readonly geography?: Geography;
  readonly layers: readonly PictureLayer[];
  readonly features: readonly PictureFeature[];
  /** The adversary courses of action the threat layer has overlays for, with their roles. */
  readonly ecoas: ReadonlyArray<{ readonly id: string; readonly role?: string }>;
  /** The span the time slider covers, epoch milliseconds; absent when nothing carries a time. */
  readonly time?: { readonly min: number; readonly max: number };
  readonly budget: { readonly limit: number; readonly tracks: number; readonly shown: number; readonly note?: string };
}

const ms = (iso: string | undefined): number | undefined => {
  if (iso === undefined) return undefined;
  const value = parseIsoMillis(iso);
  return Number.isNaN(value) ? undefined : value;
};

function symbolWords(sidc: string | undefined): string | undefined {
  if (!sidc) return undefined;
  const parsed = parseSidc(sidc);
  return parsed.ok ? describeSymbol(parsed.value) : undefined;
}

function productFeature(layer: ProductLayer, feature: CopFeature): PictureFeature {
  const p = feature.properties;
  const words = symbolWords(p.sidc);
  const card = [
    words ?? p.kind.replace(/-/g, ' '), p.grid?.length ? `At ${p.grid.join(', ')}` : '',
    p.ecoa ? `${p.ecoa}${p.ecoaRole ? ` (${p.ecoaRole})` : ''}` : '', p.decision ? `Decision: ${p.decision}` : '',
    p.pirs?.length ? `PIRs: ${p.pirs.join(', ')}` : '', p.nais?.length ? `NAIs: ${p.nais.join(', ')}` : '', p.sources?.length ? `Sources: ${p.sources.join(', ')}` : '',
    `From the ${copLayerTitle(layer).toLowerCase()} layer, by ${p.by}, ${p.recordedAt}`, p.label, p.note ?? ''
  ].filter(Boolean);
  const vf = ms(p.validFrom);
  const vt = ms(p.validTo);
  const ka = ms(p.recordedAt);
  return {
    type: 'Feature', id: `${layer}/${feature.id}`, geometry: feature.geometry,
    properties: {
      layer, kind: p.kind, name: p.name, ...(p.sidc ? { sidc: p.sidc } : {}), ...(p.anticipated ? { anticipated: true } : {}),
      ...(p.ecoa ? { ecoa: p.ecoa } : {}), ...(p.ecoaRole ? { ecoaRole: p.ecoaRole } : {}),
      ...(vf !== undefined ? { vf } : {}), ...(vt !== undefined ? { vt } : {}), ...(ka !== undefined ? { ka } : {}), label: p.label, card
    }
  };
}

/** The scenario's forces and control measures as a read-only reference layer, at their grid references in the frame. */
export function scenarioReference(scenario: Scenario): PictureFeature[] {
  const frame = scenario.region.frame;
  if (!frame) return [];
  const sides = new Map(scenario.parties.map((party) => [party.id, party.side] as const));
  const at = (text: string) => gridReferencesIn(text, frame.grid, frame.squareMetres).map((reference) => {
    const point = gridToWgs84(frame, gridCentre(reference));
    return [Math.round(point.longitude * 1e7) / 1e7, Math.round(point.latitude * 1e7) / 1e7] as const;
  });
  const out: PictureFeature[] = [];
  for (const force of scenario.forces) {
    const points = at(force.location);
    const side = sides.get(force.party);
    const sidc = side ? forceSidc(force, side) : undefined;
    if (!points.length || !sidc) continue;
    out.push({
      type: 'Feature', id: `${SCENARIO_LAYER}/${force.id}`, geometry: { type: 'Point', coordinates: points[0] },
      properties: {
        layer: SCENARIO_LAYER, kind: 'symbol', name: force.designation, sidc, label: 'org/Internal',
        card: [symbolWords(sidc) ?? force.kind, force.kind, `At ${force.location}`, force.strength ?? '', force.reportedBy.length ? `Reported by ${force.reportedBy.join(', ')}` : 'Own forces or higher\'s order of battle', 'From the scenario, for reference'].filter(Boolean)
      }
    });
  }
  for (const measure of scenario.controlMeasures) {
    const points = at(measure.location);
    if (!points.length) continue;
    const geometry: CopGeometry = points.length >= 2 ? { type: 'LineString', coordinates: points } : { type: 'Point', coordinates: points[0] };
    out.push({
      type: 'Feature', id: `${SCENARIO_LAYER}/${measure.id}`, geometry,
      properties: { layer: SCENARIO_LAYER, kind: measure.kind, name: measure.name, label: 'org/Internal', card: [measure.kind.replace(/-/g, ' '), `At ${measure.location}`, measure.description, 'From the scenario, for reference'] }
    });
  }
  return out;
}

/** The observations the host gives the picture for the feed layers, already clamped to what the reader may see. */
export interface PictureFeeds {
  readonly rows: readonly Observation[];
  readonly visible: (label: string) => boolean;
  readonly now: number;
  /** The decay policy of a row's feed, or null for no decay. */
  readonly decay: (row: Observation) => DecayPolicy | null;
  /** The feed layers a row shows on (obs/layers.ts layersFor, by the row's feed category and format). */
  readonly layersOf: (row: Observation) => readonly string[];
}

export interface PictureInput {
  readonly marking: string;
  readonly frame?: ExerciseFrame;
  readonly geography?: Geography;
  readonly layers: ReadonlyArray<{ readonly layer: ProductLayer; readonly features: readonly CopFeature[]; readonly writer: StaffWriter; readonly problems?: readonly string[] }>;
  readonly feeds?: PictureFeeds;
  readonly scenario?: Scenario;
  readonly budget?: number;
}

function frameBounds(frame: ExerciseFrame): { bounds: [number, number, number, number]; centre: [number, number] } {
  const sw = gridToWgs84(frame, { eastingMetres: 0, northingMetres: 0 });
  const ne = gridToWgs84(frame, { eastingMetres: frame.extent.eastings * frame.squareMetres, northingMetres: frame.extent.northings * frame.squareMetres });
  return { bounds: [sw.longitude, sw.latitude, ne.longitude, ne.latitude], centre: [(sw.longitude + ne.longitude) / 2, (sw.latitude + ne.latitude) / 2] };
}

function feedFeatures(feeds: PictureFeeds, limit: number): { features: PictureFeature[]; perLayer: Map<string, { count: number; labels: string[]; sim: boolean }>; tracks: number; shown: number } {
  const visibleRows = feeds.rows.filter((row) => feeds.visible(row.label));
  const groups = new Map<string, Observation[]>();
  for (const row of visibleRows) {
    const key = row.trackId ?? `obs:${row.obsId}`;
    const list = groups.get(key);
    if (list) list.push(row); else groups.set(key, [row]);
  }
  const tracks = [...groups.entries()].map(([key, rows]) => {
    const view = rows[0].trackId ? buildTrack(key, rows, feeds.visible, feeds.now, feeds.decay(rows[0])) : undefined;
    const used = view ? rows.filter((row) => view.observations.includes(row.obsId)) : rows;
    const latest = used.reduce((a, b) => (parseIsoMillis(b.knownAt) > parseIsoMillis(a.knownAt) ? b : a));
    return { key, view, used, latest };
  }).filter((track) => track.used.length > 0);
  tracks.sort((a, b) => parseIsoMillis(b.latest.knownAt) - parseIsoMillis(a.latest.knownAt) || a.key.localeCompare(b.key));
  const kept = tracks.slice(0, limit);
  const features: PictureFeature[] = [];
  const perLayer = new Map<string, { count: number; labels: string[]; sim: boolean }>();
  for (const track of kept) {
    const superseded = new Map(track.used.filter((row) => row.supersedes).map((row) => [row.supersedes!, row.knownAt] as const));
    const history = [...track.used].sort((a, b) => parseIsoMillis(a.validAt) - parseIsoMillis(b.validAt)).slice(-COP_TRACK_HISTORY);
    const label = track.view?.label ?? joinTemplateLabels(track.used.map((row) => row.label)) ?? track.latest.label;
    for (const row of history) {
      if (row.geometry.type !== 'Point') continue;
      const layers = feeds.layersOf(row);
      for (const layer of layers) {
        const entry = perLayer.get(layer) ?? { count: 0, labels: [], sim: false };
        entry.count += 1; entry.labels.push(label); entry.sim = entry.sim || row.simulated;
        perLayer.set(layer, entry);
        const sup = superseded.get(row.obsId);
        const vt = row.validUntil ? parseIsoMillis(row.validUntil) : undefined;
        const name = row.attributes?.name ?? row.subjectRef ?? track.key;
        features.push({
          type: 'Feature', id: `${layer}/${row.obsId}`, geometry: { type: 'Point', coordinates: [row.geometry.coordinates[0], row.geometry.coordinates[1]] },
          properties: {
            layer, kind: 'track', name, ...(feedTrackSidc(row, layer) ? { sidc: feedTrackSidc(row, layer) } : {}),
            vf: parseIsoMillis(row.validAt), ...(vt !== undefined ? { vt } : {}), ka: parseIsoMillis(row.knownAt), ...(sup ? { sup: parseIsoMillis(sup) } : {}),
            track: track.key, ...(track.view ? { state: track.view.state === 'closed' ? 'lost' : track.view.state } : {}), ...(row.simulated ? { sim: true } : {}), label,
            card: [
              row.claimedIdentity ? `Feed claims ${row.claimedIdentity} (a claim, not the J2's assessment)` : 'Identity not assessed', `Track ${track.key}`,
              `Seen ${row.validAt}, known ${row.knownAt}`, `Source ${row.source}, origin ${row.origin}, graded ${row.reliability} and ${row.credibility}`,
              `Feed ${row.feed}/${row.channel}`, row.simulated ? 'SIM: simulated exercise data' : '', label
            ].filter(Boolean)
          }
        });
      }
    }
  }
  return { features, perLayer, tracks: tracks.length, shown: kept.length };
}

/**
 * The symbol a feed track is drawn with: a 20-digit code as the feed reported it, or a CoT atom type through the one CoT-to-symbol table
 * (obs/codecs/cot.ts). A feed's affiliation is a claim, not the J2's assessment (note 11, 6.2), so a CoT track is drawn as a friend only on the friendly
 * positions layer when it claims to be one, and as unknown everywhere else; the card still says what the feed claimed.
 */
export function feedTrackSidc(row: Pick<Observation, 'observedType' | 'claimedIdentity'>, layer: string): string | undefined {
  const type = row.observedType;
  if (!type) return undefined;
  if (/^[0-9]{20}$/.test(type)) return type;
  const friendly = layer === 'cop-feed-friendly' && (row.claimedIdentity === 'friend' || row.claimedIdentity === 'assumed-friend');
  return cotSidc(type, friendly ? row.claimedIdentity! : 'unknown');
}

/** Builds the picture: product layers (with their writers), feed layers as views, the scenario for reference, the budget and the time span. */
export function buildCopPicture(input: PictureInput): CopPicture {
  const limit = input.budget ?? COP_TRACK_BUDGET;
  const features: PictureFeature[] = [];
  const layers: PictureLayer[] = [];
  const byLayer = new Map(input.layers.map((entry) => [entry.layer, entry] as const));
  let productCount = 0;
  for (const layer of PRODUCT_LAYERS) {
    const entry = byLayer.get(layer);
    const own = (entry?.features ?? []).map((feature) => productFeature(layer, feature));
    productCount += own.length;
    features.push(...own);
    const separate = SEPARATE_LAYERS.includes(layer);
    const problems = entry?.problems?.length ? `${entry.problems.length} feature${entry.problems.length === 1 ? '' : 's'} could not be read` : undefined;
    layers.push({
      id: layer, title: copLayerTitle(layer), kind: 'product', owner: entry ? writerText(entry.writer) : '', label: layerLabel(entry?.features ?? []) ?? 'unjoinable labels',
      separate, visible: !separate, simulated: false, count: own.length, ...(problems ? { note: problems } : {})
    });
  }
  const feed = input.feeds ? feedFeatures(input.feeds, limit) : undefined;
  for (const entry of FEED_LAYERS) {
    const seen = feed?.perLayer.get(entry.layer);
    layers.push({
      id: entry.layer, title: entry.title, kind: 'feed', owner: `${entry.settingsOwner.section} ${entry.settingsOwner.member} (settings)`,
      label: seen ? joinTemplateLabels(seen.labels) ?? 'unjoinable labels' : 'org/Internal', separate: false, visible: Boolean(seen), simulated: seen?.sim ?? false,
      count: seen?.count ?? 0, ...(input.feeds ? {} : { note: 'No observation store is connected; the layer fills when one is.' })
    });
  }
  if (feed) features.push(...feed.features);
  if (input.scenario) {
    const reference = scenarioReference(input.scenario);
    features.push(...reference);
    layers.push({
      id: SCENARIO_LAYER, title: 'Scenario (reference)', kind: 'reference', owner: 'the loaded scenario, read only', label: 'org/Internal', separate: false,
      visible: productCount === 0, simulated: false, count: reference.length, note: 'The scenario\'s own order of battle and control measures, for reference until the product layers are written.'
    });
  }
  const ecoas = new Map<string, string | undefined>();
  for (const feature of features) if (feature.properties.ecoa) ecoas.set(feature.properties.ecoa, feature.properties.ecoaRole ?? ecoas.get(feature.properties.ecoa));
  const times = features.flatMap((feature) => [feature.properties.vf, feature.properties.vt, feature.properties.ka].filter((value): value is number => value !== undefined));
  const cut = feed && feed.tracks > feed.shown ? `Showing the ${feed.shown.toLocaleString('en-US')} most recently updated of ${feed.tracks.toLocaleString('en-US')} tracks (budget ${limit.toLocaleString('en-US')}).` : undefined;
  return {
    version: PICTURE_VERSION, marking: input.marking,
    ...(input.frame ? { frame: { grid: input.frame.grid, ...frameBounds(input.frame) } } : {}),
    ...(input.geography ? { geography: input.geography } : {}),
    layers, features,
    ecoas: [...ecoas.entries()].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })).map(([id, role]) => (role ? { id, role } : { id })),
    ...(times.length ? { time: { min: Math.min(...times), max: Math.max(...times) } } : {}),
    budget: { limit, tracks: feed?.tracks ?? 0, shown: feed?.shown ?? 0, ...(cut ? { note: cut } : {}) }
  };
}

/**
 * What the map draws at time `t`: in "valid" mode, what was true at t (valid from at or before t, until after t); in "known" mode, what was known by t
 * and not yet superseded. A feed track shows only its latest visible observation. The page (media/staff/copMap.js visibleFeatures) applies the same rule;
 * a test holds the two together.
 */
export function visibleFeatures(features: readonly PictureFeature[], t: number, mode: TimeMode): PictureFeature[] {
  const shown = features.filter((feature) => {
    const p = feature.properties;
    if (mode === 'valid') return (p.vf === undefined || p.vf <= t) && (p.vt === undefined || t < p.vt);
    return (p.ka === undefined || p.ka <= t) && (p.sup === undefined || t < p.sup);
  });
  const latest = new Map<string, PictureFeature>();
  const out: PictureFeature[] = [];
  for (const feature of shown) {
    const key = feature.properties.track === undefined ? undefined : `${feature.properties.layer}|${feature.properties.track}`;
    if (key === undefined) { out.push(feature); continue; }
    const at = (candidate: PictureFeature) => (mode === 'valid' ? candidate.properties.vf : candidate.properties.ka) ?? 0;
    const known = latest.get(key);
    if (!known || at(feature) > at(known) || (at(feature) === at(known) && feature.id > known.id)) latest.set(key, feature);
  }
  return [...out, ...[...latest.values()].sort((a, b) => a.id.localeCompare(b.id))];
}
