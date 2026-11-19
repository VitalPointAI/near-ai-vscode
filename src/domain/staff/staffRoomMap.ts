// The Staff Room's map model (UX concept 5.5 and 5.10; WP-ROOM): the scenario's exercise frame, terrain, forces and control measures, and the J2's
// adversary courses of action, placed in one plane the page draws. Pure: no I/O, no clock, no vscode.
//
// The page draws this model through one map interface (media/staffRoom/staffMap.js). Today it is an SVG map of the fictional grid; drop 2's cop-map
// (MapLibre on the exercise frame) implements the same interface and reads the same model, so nothing here changes when the renderer does.
//
// Placement rules. A thing is placed from the grid references in its location text (`KQ 4532`), else from the named features, control measures and units
// that text mentions, in the order it mentions them. A thing that names no place in the exercise area (a ship 60 km west, an airfield on the mainland)
// is not drawn and is listed under "not on the map" with its location in words, so the table view and a screen reader still have it.
import { ADVERSARY_COA_TERMS, ICD203_CONFIDENCE_LEVELS, ICD203_LIKELIHOOD, INFORMATION_CREDIBILITY, SOURCE_RELIABILITY } from './doctrine';
import type { StaffSectionId } from './doctrine';
import type { CopModel } from './events';
import { gridCentre, gridReferencesIn } from './obs/frame';
import type { ExerciseFrame } from './obs/frame';
import { SHARED_PRODUCTS } from './ownership';
import type { Scenario, ScenarioForce } from './scenario';

/** Metres per map unit: 100 m, so a 1 km grid square is 10 units. */
export const MAP_UNIT_METRES = 100;
const PAD_METRES = 6000;
const MAX_TEXT = 600;

export type Affiliation = 'F' | 'H' | 'N' | 'U';
export type UnitIcon = 'inf' | 'mech' | 'arm' | 'arty' | 'recce' | 'hq' | 'sea' | 'air' | 'ew' | 'uas' | 'css' | 'police' | 'none';
export type Point = readonly [number, number];

/** The five product layers of the COP, each with one writer (design 10, 4.3), in drawing order. */
export const COP_PRODUCT_LAYERS = ['cop-terrain-layer', 'cop-operations-layer', 'cop-threat-layer', 'cop-logistics-layer', 'cop-plans-layer'] as const;
export type CopLayerId = (typeof COP_PRODUCT_LAYERS)[number];
const LAYER_TITLES: Readonly<Record<CopLayerId, string>> = {
  'cop-terrain-layer': 'Terrain', 'cop-operations-layer': 'Own forces and control measures', 'cop-threat-layer': 'Threat',
  'cop-logistics-layer': 'Logistics', 'cop-plans-layer': 'Plans (never merged into the picture)'
};

export interface MapLayer {
  readonly id: CopLayerId;
  readonly title: string;
  readonly owner: { readonly section: StaffSectionId; readonly member: string };
  /** Features drawn on this map from the scenario and products. */
  readonly drawn: number;
  /** Features the layer's writer last reported through the COP (staff.cop.updated), when it has. */
  readonly reported?: number;
  readonly updatedAt?: string;
}

export interface MapFeature {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly points: readonly Point[];
  readonly grid?: string;
  readonly description: string;
}

export interface MapUnit {
  readonly id: string;
  readonly designation: string;
  readonly kind: string;
  readonly affiliation: Affiliation;
  readonly side: string;
  readonly party: string;
  readonly icon: UnitIcon;
  readonly echelon?: string;
  readonly echelonMark: string;
  readonly hq: boolean;
  readonly at: Point;
  readonly grid?: string;
  readonly location: string;
  /** The best grade among the reports it rests on (`B2`), with the words of both scales; absent for own-force data. */
  readonly grade?: { readonly code: string; readonly words: string };
  readonly reports: ReadonlyArray<{ readonly id: string; readonly title: string; readonly grade: string }>;
  readonly anticipated: boolean;
  readonly layer: CopLayerId;
}

export interface MapGraphic {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly points: readonly Point[];
  readonly description: string;
  readonly layer: CopLayerId;
}

export interface EnemyCoa {
  readonly id: 'mlcoa' | 'mdcoa';
  readonly term: string;
  readonly title: string;
  readonly statement: string;
  /** The ICD 203 likelihood term and its range, and the confidence sentence, kept apart as the tradecraft gate requires. */
  readonly likelihood?: { readonly term: string; readonly range: string };
  readonly confidence?: string;
  readonly points: readonly Point[];
  readonly places: readonly string[];
}

export interface StaffMapModel {
  readonly available: boolean;
  /** Why there is no map: no scenario loaded, or it could not be read. */
  readonly reason?: string;
  readonly grid: { readonly name: string; readonly squareMetres: number; readonly unitMetres: number; readonly originEasting: number; readonly originNorthing: number };
  readonly frame?: { readonly kind: string; readonly origin: string; readonly extent: string; readonly axis: string };
  readonly viewBox: readonly [number, number, number, number];
  /** The land outline (an SVG path in map units), drawn from where land features and land forces are. */
  readonly land: string;
  readonly seaLabels: ReadonlyArray<{ readonly name: string; readonly at: Point }>;
  readonly features: readonly MapFeature[];
  readonly units: readonly MapUnit[];
  readonly graphics: readonly MapGraphic[];
  readonly ecoas: readonly EnemyCoa[];
  readonly layers: readonly MapLayer[];
  readonly offMap: ReadonlyArray<{ readonly id: string; readonly designation: string; readonly affiliation: Affiliation; readonly location: string }>;
}

const clip = (text: string, max = MAX_TEXT): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const SIDE_AFFILIATION: Readonly<Record<string, Affiliation>> = { friendly: 'F', 'host-nation': 'F', adversary: 'H', neutral: 'N', unknown: 'U' };

/** Echelon amplifiers of the symbology standards (MIL-STD-2525 and APP-6), above the frame. */
const ECHELON_MARKS: Readonly<Record<string, string>> = {
  team: 'Ø', crew: 'Ø', squad: '•', section: '••', platoon: '•••', detachment: '•••', company: 'I', battery: 'I', troop: 'I', battalion: 'II', squadron: 'II',
  regiment: 'III', group: 'III', brigade: 'X', division: 'XX', corps: 'XXX'
};

/** The icon inside a unit's frame, read from its type in words. */
export function unitIcon(kind: string): UnitIcon {
  const text = kind.toLowerCase();
  if (/uncrewed|\buas\b|drone/.test(text)) return 'uas';
  if (/electronic warfare/.test(text)) return 'ew';
  if (/vessel|ship|flotilla|task group|surface contact|boat|mine countermeasures/.test(text)) return 'sea';
  if (/air detachment|aircraft|airfield/.test(text)) return 'air';
  if (/police/.test(text)) return 'police';
  if (/armou?r|tank/.test(text)) return 'arm';
  if (/mechani[sz]ed/.test(text)) return 'mech';
  if (/artillery|battery|fires/.test(text)) return 'arty';
  if (/reconnaissance|recce/.test(text)) return 'recce';
  if (/service support|logistic|supply/.test(text)) return 'css';
  if (/infantry|militia|guard/.test(text)) return 'inf';
  if (/headquarters/.test(text)) return 'hq';
  return 'none';
}

const GENERIC_WORDS = new Set(['river', 'the', 'beach', 'island', 'ridge', 'bridge', 'ford', 'port', 'town', 'route', 'sea', 'strait', 'marshes', 'marsh', 'north', 'south', 'coast', 'of']);

/** The names a text may use for a place: its full name, and its one distinctive word ("Brenn" for "River Brenn"). */
function aliases(name: string): string[] {
  const out = [name];
  const words = name.split(/\s+/).filter((word) => !GENERIC_WORDS.has(word.toLowerCase()));
  if (words.length === 1 && words[0].length >= 4 && words[0].toLowerCase() !== name.toLowerCase()) out.push(words[0]);
  return out;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Place { readonly names: readonly string[]; readonly points: readonly Point[]; readonly linear: boolean }

/** Resolves location text to points in grid metres, in the order the text names them. */
class Resolver {
  private readonly places: Place[] = [];
  constructor(private readonly gridName: string, private readonly square: number) {}

  /** A named place. A linear one (a river, a ridge, a route) has no single point an axis could pass through, so an axis does not use it. */
  add(names: readonly string[], points: readonly Point[], linear = false): void {
    if (!points.length) return;
    const at = this.places.findIndex((place) => place.names[0] === names[0]);
    if (at >= 0) this.places.splice(at, 1);
    this.places.push({ names, points, linear });
  }

  /**
   * Grid references and named places in the text, ordered by where they appear; repeated neighbours (a name then its grid reference) merge. As a
   * `place`, a text with a grid reference is placed by its references only ("Eastern edge of Port Calder, KQ 4736" is at KQ 4736), and a text with an
   * offset ("60 km west of Gull Island") at that offset.
   */
  points(text: string, mode: 'path' | 'place' | 'axis' = 'path'): Point[] {
    if (mode === 'place') {
      const references = gridReferencesIn(text, this.gridName, this.square).map((reference): Point => { const centre = gridCentre(reference); return [centre.eastingMetres, centre.northingMetres]; });
      if (references.length) return references;
      const offset = this.offset(text);
      if (offset) return [offset];
    }
    const found: Array<{ index: number; points: readonly Point[] }> = [];
    for (const match of text.matchAll(new RegExp(`${escape(this.gridName)}\\s+\\d{4,10}(?![0-9])`, 'g'))) {
      const reference = gridReferencesIn(match[0], this.gridName, this.square)[0];
      if (reference) { const centre = gridCentre(reference); found.push({ index: match.index ?? 0, points: [[centre.eastingMetres, centre.northingMetres]] }); }
    }
    for (const place of this.places) {
      if (mode === 'axis' && place.linear) continue;
      for (const name of place.names) {
        const match = new RegExp(`(^|[^A-Za-z0-9-])${escape(name)}($|[^A-Za-z0-9-])`, 'i').exec(text);
        if (match) { found.push({ index: match.index + match[1].length, points: [centroid(place.points)] }); break; }
      }
    }
    found.sort((a, b) => a.index - b.index);
    const out: Point[] = [];
    for (const item of found) for (const point of item.points) {
      // A path skips a point next to the one before it; an axis skips any point it has already passed through.
      const near = (other: Point) => Math.hypot(other[0] - point[0], other[1] - point[1]) <= 600;
      if (mode === 'axis' ? !out.some(near) : !(out.length && near(out[out.length - 1]))) out.push(point);
    }
    return out;
  }

  /** An offset from a named place ("4 km south of Port Calder"), when the text gives one. */
  offset(text: string): Point | undefined {
    const match = /(\d+(?:\.\d+)?)\s*km\s+(north|south|east|west)\s+of\s+(.+)/i.exec(text);
    if (!match) return undefined;
    const base = this.points(match[3], 'path')[0];
    if (!base) return undefined;
    const metres = Number(match[1]) * 1000;
    const direction = match[2].toLowerCase();
    return [base[0] + (direction === 'east' ? metres : direction === 'west' ? -metres : 0), base[1] + (direction === 'north' ? metres : direction === 'south' ? -metres : 0)];
  }
}

function centroid(points: readonly Point[]): Point {
  const sum = points.reduce((acc, point) => [acc[0] + point[0], acc[1] + point[1]], [0, 0]);
  return [sum[0] / points.length, sum[1] / points.length];
}

/** The convex hull of points (monotone chain), counter-clockwise. */
function hull(points: readonly Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted;
  const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Point[] = [];
  for (const point of sorted) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop(); lower.push(point); }
  const upper: Point[] = [];
  for (const point of [...sorted].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop(); upper.push(point); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** A small deterministic wobble, so a coastline is not a perfect polygon and is the same on every draw. */
function wobble(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** A closed, smooth outline around a hull, pushed out by `pad` with a coastline wobble, as an SVG path in map units. */
function coastline(points: readonly Point[], pad: number, toMap: (point: Point) => Point): string {
  if (points.length < 3) return '';
  const shape = hull(points);
  const centre = centroid(shape);
  // Densify, then push each point out from the centre.
  const dense: Point[] = [];
  for (let i = 0; i < shape.length; i += 1) {
    const a = shape[i], b = shape[(i + 1) % shape.length];
    const steps = Math.max(2, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 1500));
    for (let s = 0; s < steps; s += 1) dense.push([a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps]);
  }
  const out = dense.map((point, index): Point => {
    const dx = point[0] - centre[0], dy = point[1] - centre[1];
    const length = Math.hypot(dx, dy) || 1;
    const push = pad * (0.75 + 0.5 * wobble(index + 1));
    return toMap([point[0] + (dx / length) * push, point[1] + (dy / length) * push]);
  });
  return closedSmooth(out);
}

/** A closed Catmull-Rom curve through points, as an SVG path. */
export function closedSmooth(points: readonly Point[]): string {
  const n = points.length;
  if (n < 3) return '';
  const f = (value: number) => Number(value.toFixed(1));
  let d = `M${f(points[0][0])},${f(points[0][1])}`;
  for (let i = 0; i < n; i += 1) {
    const p0 = points[(i - 1 + n) % n], p1 = points[i], p2 = points[(i + 1) % n], p3 = points[(i + 2) % n];
    d += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)},${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)},${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])},${f(p2[1])}`;
  }
  return `${d} Z`;
}

const SEA_WORDS = /\b(at sea|anchored|afloat|aboard|embarked|channel|harbour approaches|off the coast|offshore)\b/i;

/** The best (lowest) grade among a unit's reports, as `B2`, with the words of both scales. */
function bestGrade(grades: ReadonlyArray<{ reliability: string; credibility: string }>): { code: string; words: string } | undefined {
  const sorted = [...grades].sort((a, b) => a.reliability.localeCompare(b.reliability) || a.credibility.localeCompare(b.credibility));
  const best = sorted[0];
  if (!best) return undefined;
  const reliability = (SOURCE_RELIABILITY as Record<string, string>)[best.reliability] ?? best.reliability;
  const credibility = (INFORMATION_CREDIBILITY as Record<string, string>)[best.credibility] ?? best.credibility;
  return { code: `${best.reliability}${best.credibility}`, words: `Source: ${reliability.toLowerCase()}. Information: ${credibility.toLowerCase()}.` };
}

// ---- Adversary courses of action from the J2's product ---------------------------------------------------------------------------------------------

/** The section under a heading (any level) whose text starts with one of the names, up to the next heading of the same or a higher level. */
function section(body: string, names: readonly RegExp[]): string | undefined {
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (!heading || !names.some((name) => name.test(heading[2]))) continue;
    const level = heading[1].length;
    const out: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = /^(#{1,6})\s/.exec(lines[j]);
      if (next && next[1].length <= level) break;
      out.push(lines[j]);
    }
    return out.join('\n').trim();
  }
  return undefined;
}

/** Markdown reduced to plain sentences for a card. */
function plain(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/^\s*[-*]\s+/gm, '').replace(/[*_`>#]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
}

/** The ICD 203 likelihood term a text uses (the longest match), with its range; and the confidence it states, in its own words. */
export function estimativeLanguage(text: string): { likelihood?: { term: string; range: string }; confidence?: string } {
  const lower = text.toLowerCase();
  let best: { term: string; range: string; length: number } | undefined;
  for (const row of ICD203_LIKELIHOOD) {
    for (const form of [row.term, row.alternative, ...row.forms]) {
      if (new RegExp(`(^|[^a-z])${escape(form)}($|[^a-z])`).test(lower) && (!best || form.length > best.length)) best = { term: row.term, range: `${row.range[0]} to ${row.range[1]} percent`, length: form.length };
    }
  }
  const confidenceLevel = ICD203_CONFIDENCE_LEVELS.find((level) => new RegExp(`\\b${level} confidence\\b`).test(lower));
  const sentence = confidenceLevel ? text.split(/(?<=[.!?])\s+/).find((line) => new RegExp(`\\b${confidenceLevel} confidence\\b`, 'i').test(line)) : undefined;
  return { ...(best ? { likelihood: { term: best.term, range: best.range } } : {}), ...(sentence ? { confidence: clip(sentence.trim(), 300) } : {}) };
}

/** The MLCOA and MDCOA sections of the J2's adversary COA set (or a threat assessment), each with its statement and the places it names in order. */
export function readEnemyCoas(body: string | undefined): Array<{ id: 'mlcoa' | 'mdcoa'; text: string }> {
  if (!body) return [];
  const out: Array<{ id: 'mlcoa' | 'mdcoa'; text: string }> = [];
  const likely = section(body, [/^most likely/i, /\bMLCOA\b/]);
  const dangerous = section(body, [/^most dangerous/i, /\bMDCOA\b/]);
  if (likely) out.push({ id: 'mlcoa', text: likely });
  if (dangerous) out.push({ id: 'mdcoa', text: dangerous });
  return out;
}

// ---- The model -------------------------------------------------------------------------------------------------------------------------------------

export interface StaffMapInput {
  readonly scenario?: Scenario;
  readonly scenarioProblem?: string;
  /** The body of the J2's adversary COA set (or threat assessment), for the MLCOA and MDCOA overlays. */
  readonly enemyCoaBody?: string;
  readonly cop: CopModel;
}

function layerOwner(layer: CopLayerId): { section: StaffSectionId; member: string } {
  const shared = SHARED_PRODUCTS.find((entry) => entry.product === layer);
  const writer = shared?.owners[0]?.writer;
  return writer ? { section: writer.section, member: writer.member } : { section: 'j3', member: 'joc-chief' };
}

function emptyMap(reason: string, cop: CopModel): StaffMapModel {
  return {
    available: false, reason, grid: { name: '', squareMetres: 1000, unitMetres: MAP_UNIT_METRES, originEasting: 0, originNorthing: 0 }, viewBox: [0, 0, 1000, 600], land: '',
    seaLabels: [], features: [], units: [], graphics: [], ecoas: [], offMap: [], layers: layersOf(cop, {})
  };
}

function layersOf(cop: CopModel, drawn: Partial<Record<CopLayerId, number>>): MapLayer[] {
  return COP_PRODUCT_LAYERS.map((id) => {
    const reported = cop.layers.find((layer) => layer.layer === id);
    return {
      id, title: LAYER_TITLES[id], owner: reported ? { section: reported.owner.section, member: reported.owner.member } : layerOwner(id), drawn: drawn[id] ?? 0,
      ...(reported ? { reported: reported.featureCount, updatedAt: reported.updatedAt } : {})
    };
  });
}

/** Builds the map from the scenario (its frame, terrain, forces, control measures), the J2's adversary COAs and the COP layer read model. */
export function buildStaffMap(input: StaffMapInput): StaffMapModel {
  const scenario = input.scenario;
  if (!scenario) return emptyMap(input.scenarioProblem ?? 'No exercise scenario is loaded in this project. Load one with NEAR AI: Load a Staff Exercise Scenario.', input.cop);
  const frame: ExerciseFrame | undefined = scenario.region.frame;
  const gridName = frame?.grid ?? (scenario.region.grid.kind === 'fictional' ? scenario.region.grid.name : '');
  const square = frame?.squareMetres ?? 1000;
  if (!gridName) return emptyMap('This scenario has no fictional grid to draw.', input.cop);
  const resolver = new Resolver(gridName, square);

  // Pass 1: features placed where their location text puts them, so later text can name them.
  const linearKinds = new Set(['river', 'route', 'high-ground', 'beach', 'coast', 'marsh']);
  const featurePoints = new Map<string, Point[]>();
  for (const feature of scenario.region.features) {
    const points = linearKinds.has(feature.kind) ? gridReferencesIn(feature.location, gridName, square).map((reference): Point => { const centre = gridCentre(reference); return [centre.eastingMetres, centre.northingMetres]; }) : resolver.points(feature.location, 'place');
    featurePoints.set(feature.id, points);
    resolver.add(aliases(feature.name), points, linearKinds.has(feature.kind));
  }
  // Pass 2: a river or a route runs through the places its location names, in order ("through Ashby Ford to the sea at KQ 4227").
  for (const feature of scenario.region.features) {
    if (feature.kind !== 'river' && feature.kind !== 'route') continue;
    const points = resolver.points(feature.location, 'path');
    if (points.length > (featurePoints.get(feature.id)?.length ?? 0)) { featurePoints.set(feature.id, points); resolver.add(aliases(feature.name), points, true); }
  }
  // Control measures: grid references, named places, and "N km south of" offsets.
  const controlPoints = new Map<string, Point[]>();
  for (const measure of scenario.controlMeasures) {
    const points = resolver.points(measure.location, 'place');
    controlPoints.set(measure.id, points);
    resolver.add([measure.name], points);
  }
  // Forces: where their location text puts them.
  const partySide = new Map(scenario.parties.map((party) => [party.id, party.side]));
  const forcePoints = new Map<string, Point[]>();
  for (const force of scenario.forces) {
    const points = resolver.points(force.location, 'place');
    forcePoints.set(force.id, points);
    if (points.length) resolver.add([force.designation], points);
  }

  // Land: every land feature and every force on land.
  const landKinds = new Set(['coast', 'beach', 'high-ground', 'river', 'crossing', 'route', 'town', 'port', 'airfield', 'forest', 'marsh', 'other']);
  const landPoints: Point[] = [];
  for (const feature of scenario.region.features) if (landKinds.has(feature.kind)) landPoints.push(...(featurePoints.get(feature.id) ?? []));
  for (const force of scenario.forces) if (!SEA_WORDS.test(force.location) && unitIcon(force.kind) !== 'sea') landPoints.push(...(forcePoints.get(force.id) ?? []));
  // The picture's extent comes from the terrain and the control measures; a force placed far beyond it (a ship 60 km out) is listed, not drawn.
  const all: Point[] = [...landPoints, ...[...featurePoints.values()].flat(), ...[...controlPoints.values()].flat()];
  if (!all.length) return emptyMap('The scenario names no grid references on its grid, so there is nothing to place on the map.', input.cop);
  const minE = Math.min(...all.map((point) => point[0])) - PAD_METRES;
  const maxE = Math.max(...all.map((point) => point[0])) + PAD_METRES;
  const minN = Math.min(...all.map((point) => point[1])) - PAD_METRES;
  const maxN = Math.max(...all.map((point) => point[1])) + PAD_METRES;
  // Northings grow north (the frame's one axis): map y grows down, so it is measured from the top.
  const toMap = (point: Point): Point => [Number(((point[0] - minE) / MAP_UNIT_METRES).toFixed(1)), Number(((maxN - point[1]) / MAP_UNIT_METRES).toFixed(1))];
  const width = (maxE - minE) / MAP_UNIT_METRES;
  const height = (maxN - minN) / MAP_UNIT_METRES;
  // The picture is the exercise area itself; the renderer fills the rest of a wider stage with open sea.
  const wide = width;
  const viewBox: [number, number, number, number] = [0, 0, Number(width.toFixed(1)), Number(height.toFixed(1))];
  const gridOf = (point: Point): string => `${gridName} ${String(Math.floor(point[0] / square)).padStart(2, '0')}${String(Math.floor(point[1] / square)).padStart(2, '0')}`;

  const drawn: Partial<Record<CopLayerId, number>> = {};
  const count = (layer: CopLayerId) => { drawn[layer] = (drawn[layer] ?? 0) + 1; };

  const features: MapFeature[] = [];
  const seaLabels: Array<{ name: string; at: Point }> = [];
  for (const feature of scenario.region.features) {
    const points = featurePoints.get(feature.id) ?? [];
    if (feature.kind === 'sea' || feature.kind === 'strait') { seaLabels.push({ name: feature.name, at: [0, 0] }); continue; }
    if (!points.length || feature.kind === 'coast') continue;
    features.push({ id: feature.id, kind: feature.kind, name: clip(feature.name, 80), points: points.map(toMap), grid: gridOf(points[0]), description: clip(feature.description) });
    count('cop-terrain-layer');
  }
  // Sea names sit in the open water above the land, spread across the top.
  seaLabels.forEach((label, index) => { label.at = [Number((viewBox[0] + (wide * (index + 1)) / (seaLabels.length + 1)).toFixed(1)), 14 + index * 12]; });

  const units: MapUnit[] = [];
  const offMap: Array<{ id: string; designation: string; affiliation: Affiliation; location: string }> = [];
  const taken: Point[] = [];
  const reportsById = new Map(scenario.reports.map((report) => [report.id, report]));
  for (const force of scenario.forces) {
    const affiliation = SIDE_AFFILIATION[partySide.get(force.party) ?? 'unknown'] ?? 'U';
    const points = (forcePoints.get(force.id) ?? []).filter((point) => point[0] >= minE && point[0] <= maxE && point[1] >= minN && point[1] <= maxN);
    if (!points.length) { offMap.push({ id: force.id, designation: clip(force.designation, 80), affiliation, location: clip(force.location, 200) }); continue; }
    let at = toMap(points[0]);
    // Two units in one place stand side by side rather than on top of each other.
    for (let tries = 0; tries < 8 && taken.some((other) => Math.hypot(other[0] - at[0], other[1] - at[1]) < 22); tries += 1) at = [at[0] + 24, at[1] + (tries % 2 ? 14 : -10)];
    taken.push(at);
    const reports = force.reportedBy.map((id) => reportsById.get(id)).filter((report): report is NonNullable<typeof report> => Boolean(report));
    const grade = bestGrade(reports.flatMap((report) => (report.grade ? [report.grade] : [])));
    const layer: CopLayerId = affiliation === 'F' ? 'cop-operations-layer' : 'cop-threat-layer';
    count(layer);
    units.push({
      id: force.id, designation: clip(force.designation, 80), kind: clip(force.kind, 120), affiliation, side: partySide.get(force.party) ?? 'unknown',
      party: clip(scenario.parties.find((party) => party.id === force.party)?.name ?? force.party, 120), icon: unitIcon(force.kind),
      ...(force.echelon ? { echelon: force.echelon } : {}), echelonMark: echelonMark(force), hq: /headquarters/i.test(force.kind), at, grid: gridOf(points[0]),
      location: clip(force.location, 200), ...(grade ? { grade } : {}),
      reports: reports.map((report) => ({ id: report.id, title: clip(report.title, 160), grade: report.grade ? `${report.grade.reliability}${report.grade.credibility}` : 'ungraded' })),
      anticipated: /\breported\b|\bold\b|\bunconfirmed\b/i.test(force.location), layer
    });
  }

  const graphics: MapGraphic[] = [];
  const landBox = landPoints.length ? { minE: Math.min(...landPoints.map((p) => p[0])) - 2500, maxE: Math.max(...landPoints.map((p) => p[0])) + 2500 } : { minE, maxE };
  for (const measure of scenario.controlMeasures) {
    let points = controlPoints.get(measure.id) ?? [];
    if (!points.length) continue;
    if (measure.kind === 'phase-line' && points.length === 1 && /east-west|east to west|west to east/i.test(measure.location)) points = [[landBox.minE, points[0][1]], [landBox.maxE, points[0][1]]];
    else if (measure.kind === 'phase-line' && points.length >= 1 && /east-west/i.test(measure.location)) { const y = centroid(points)[1]; points = [[landBox.minE, y], [landBox.maxE, y]]; }
    else if (measure.kind === 'nai') {
      // An area of interest spans the points places it names, not the middle of a long road or ridge it mentions.
      const named = resolver.points(measure.location, 'axis');
      const spans = named.length >= 2 ? named : resolver.points(measure.location, 'path');
      if (spans.length > 1) points = [centroid(spans), ...spans];
    }
    const layer: CopLayerId = measure.kind === 'nai' ? 'cop-threat-layer' : 'cop-operations-layer';
    count(layer);
    graphics.push({ id: measure.id, kind: measure.kind, name: clip(measure.name, 60), points: points.map(toMap), description: clip(`${measure.location}. ${measure.description}`), layer });
  }

  const ecoas: EnemyCoa[] = readEnemyCoas(input.enemyCoaBody).map((entry) => {
    const text = plain(entry.text);
    const points = resolver.points(entry.text, 'axis').slice(0, 4).map(toMap);
    const language = estimativeLanguage(text);
    const term = entry.id === 'mlcoa' ? ADVERSARY_COA_TERMS.mostLikely : ADVERSARY_COA_TERMS.mostDangerous;
    if (points.length >= 2) count('cop-threat-layer');
    return {
      id: entry.id, term, title: entry.id === 'mlcoa' ? 'Most likely course of action' : 'Most dangerous course of action', statement: clip(text.split(/(?<=[.!?])\s+/).slice(0, 3).join(' '), 420),
      ...language, points: points.length >= 2 ? points : [], places: [] as string[]
    };
  });

  return {
    available: true,
    grid: { name: gridName, squareMetres: square, unitMetres: MAP_UNIT_METRES, originEasting: minE, originNorthing: maxN },
    ...(frame ? { frame: { kind: frame.kind, origin: `${frame.origin.latitude.toFixed(3)}, ${frame.origin.longitude.toFixed(3)}`, extent: `${frame.extent.eastings} by ${frame.extent.northings} squares of ${frame.squareMetres} m`, axis: frame.axis } } : {}),
    viewBox, land: coastline(landPoints, 3200, toMap), seaLabels, features, units, graphics, ecoas, layers: layersOf(input.cop, drawn), offMap
  };
}

function echelonMark(force: ScenarioForce): string {
  const word = (force.echelon ?? '').toLowerCase();
  return ECHELON_MARKS[word] ?? '';
}
