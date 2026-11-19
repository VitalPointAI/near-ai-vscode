// The features of a COP product layer (design 10, 4.3 and 6.2; UX concept 5.10; WP-COP): military symbols, control measures, overlays per adversary
// course of action and decision points, each a GeoJSON feature (RFC 7946) in exercise coordinates. Pure: no I/O, no clock, no vscode.
//
// A layer's features live in its product file as one FeatureCollection in a ```geojson block, under the headings drop 1 gave map layers, so the file is
// still a product the release state machine versions and the gates check. Members give positions as grid references on the scenario's fictional grid
// (`KQ 4532`); the exercise frame turns them into WGS 84 over empty ocean, and a position outside the frame is refused (the guard-scan geofence).
//
// Rules each layer keeps:
// - Affiliation is the J2's assessment (note 11, 6.2): a symbol with any identity but friend or assumed friend goes only on the threat layer.
// - Overlays per adversary course of action (`ecoa`, with MLCOA or MDCOA) go only on the threat layer.
// - Decision points go on the plans layer (the J5 lead-planner's DST in planning) or the operations layer (the J3 in execution); each names the
//   decision and the PIR or NAI that informs it (UX 13: decision points as stars tied to PIRs).
// - The plans layer holds sketches of what is planned: every symbol on it is anticipated (dashed frame).
// - Every feature carries a label inside the template ceiling; a layer's label is the join of its features' labels.
import { ADVERSARY_COA_TERMS, COP_CONTROL_MEASURES, ECHELONS, STANDARD_IDENTITIES } from '../doctrine';
import type { CopControlMeasure, Echelon, StandardIdentity, SymbolSet } from '../doctrine';
import { DEFAULT_INTEL_LABEL, isTemplateLabel } from '../intel';
import { formatGridReference, gridCentre, gridToWgs84, insideFrame, parseGridReference, wgs84ToGrid } from '../obs/frame';
import type { ExerciseFrame } from '../obs/frame';
import { joinTemplateLabels, OBS_MAX_VERTICES } from '../obs/observation';
import { parseIsoMillis } from '../../gate/shape';
import type { ProductLayer } from './layers';
import { buildSidc, describeSymbol, isAssessedIdentity, parseSidc, SYMBOL_ENTITIES } from './symbols';
import type { SymbolSpec } from './symbols';

/** A symbol, a control measure, or an overlay (a terrain or logistics area or line that is not a control measure, such as an MCOO zone). */
export const COP_FEATURE_KINDS = ['symbol', 'overlay', ...(Object.keys(COP_CONTROL_MEASURES) as CopControlMeasure[])] as const;
export type CopFeatureKind = (typeof COP_FEATURE_KINDS)[number];

export const COP_MAX_FEATURES_PER_LAYER = 2000;
export const COP_MAX_TEXT = 300;
export const COP_FEATURE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ECOA_ID = /^ECOA-[1-9][0-9]?$/;
const REF_ID = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
export const ECOA_ROLES = [ADVERSARY_COA_TERMS.mostLikely, ADVERSARY_COA_TERMS.mostDangerous] as const;
export type EcoaRole = (typeof ECOA_ROLES)[number];

/** Which kinds each product layer holds, and whether it may carry assessed identities, ECOA overlays and decision points. */
export const LAYER_RULES: Readonly<Record<ProductLayer, { readonly kinds: readonly CopFeatureKind[]; readonly assessed: boolean; readonly ecoa: boolean; readonly anticipatedOnly: boolean }>> = {
  'cop-operations-layer': { kinds: ['symbol', 'phase-line', 'boundary', 'route', 'axis-main', 'axis-supporting', 'objective', 'assembly-area', 'landing-area', 'tai', 'obstacle', 'decision-point', 'overlay'], assessed: false, ecoa: false, anticipatedOnly: false },
  'cop-threat-layer': { kinds: ['symbol', 'axis-adversary', 'objective', 'nai', 'tai', 'obstacle', 'phase-line', 'overlay'], assessed: true, ecoa: true, anticipatedOnly: false },
  'cop-terrain-layer': { kinds: ['overlay', 'obstacle', 'route'], assessed: false, ecoa: false, anticipatedOnly: false },
  'cop-logistics-layer': { kinds: ['symbol', 'route', 'assembly-area', 'overlay'], assessed: false, ecoa: false, anticipatedOnly: false },
  'cop-plans-layer': { kinds: ['symbol', 'phase-line', 'boundary', 'route', 'axis-main', 'axis-supporting', 'objective', 'assembly-area', 'landing-area', 'tai', 'decision-point', 'overlay'], assessed: false, ecoa: false, anticipatedOnly: true }
};

export type Lonlat = readonly [number, number];
export type CopGeometry =
  | { readonly type: 'Point'; readonly coordinates: Lonlat }
  | { readonly type: 'LineString'; readonly coordinates: readonly Lonlat[] }
  | { readonly type: 'Polygon'; readonly coordinates: readonly (readonly Lonlat[])[] };

export interface CopFeatureProperties {
  readonly kind: CopFeatureKind;
  /** The designation or name as written on the map: `1-41 MECH`, `PL COPPER`, `DP 2`. */
  readonly name: string;
  readonly sidc?: string;
  /** The grid references the geometry was given in, kept for people and briefs. */
  readonly grid?: readonly string[];
  readonly label: string;
  /** The reports or observations it rests on (`PR-11`, `obs-...`). */
  readonly sources?: readonly string[];
  readonly ecoa?: string;
  readonly ecoaRole?: EcoaRole;
  readonly decision?: string;
  readonly pirs?: readonly string[];
  readonly nais?: readonly string[];
  /** Planned or anticipated (dashed). Always true on the plans layer. */
  readonly anticipated?: boolean;
  /** When the feature holds: the time slider shows it from validFrom until validTo. */
  readonly validFrom?: string;
  readonly validTo?: string;
  /** When it entered the layer and who put it there: drives the "as known" replay. */
  readonly recordedAt: string;
  readonly by: string;
  readonly note?: string;
}

export interface CopFeature {
  readonly type: 'Feature';
  readonly id: string;
  readonly geometry: CopGeometry;
  readonly properties: CopFeatureProperties;
}

export interface CopFeatureCollection { readonly type: 'FeatureCollection'; readonly features: readonly CopFeature[] }

export type CopParsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };
const refuse = (message: string): { ok: false; message: string } => ({ ok: false, message });

class Refused extends Error {}
const fail = (message: string): never => { throw new Refused(message); };

function wrap<T>(work: () => T): CopParsed<T> {
  try {
    return { ok: true, value: work() };
  } catch (error) {
    if (error instanceof Refused) return refuse(error.message);
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function textOf(value: unknown, where: string, max = COP_MAX_TEXT): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(`${where} is one line of text of at most ${max} characters.`);
  return (value as string).trim();
}

function optionalText(record: Record<string, unknown>, key: string, where: string, max = COP_MAX_TEXT): string | undefined {
  const value = own(record, key);
  return value === undefined ? undefined : textOf(value, `${where}.${key}`, max);
}

function idList(record: Record<string, unknown>, key: string, where: string): string[] | undefined {
  const value = own(record, key);
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20 || !value.every((item) => typeof item === 'string' && REF_ID.test(item))) fail(`${where}.${key} is a list of at most 20 ids such as PR-11 or PIR-2.`);
  return [...new Set(value as string[])];
}

function timeOf(record: Record<string, unknown>, key: string, where: string): string | undefined {
  const value = own(record, key);
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || Number.isNaN(parseIsoMillis(value))) fail(`${where}.${key} is an ISO time in UTC such as 2026-11-18T14:00:00.000Z.`);
  return value as string;
}

// ---- Positions ------------------------------------------------------------------------------------------------------------------------------

/** One position given by a member: a grid reference on the scenario grid (`KQ 4532`) or [longitude, latitude] inside the frame. */
export type PositionInput = string | readonly [number, number];

function position(frame: ExerciseFrame, value: unknown, where: string): { lonlat: Lonlat; grid: string } {
  if (typeof value === 'string') {
    const reference = parseGridReference(value, frame.grid, frame.squareMetres);
    if (!reference) fail(`${where} is a grid reference on the ${frame.grid} grid, such as ${frame.grid} 4532, or [longitude, latitude].`);
    const centre = gridCentre(reference!);
    if (!insideFrame(frame, centre)) fail(`${where} (${value}) lies outside the exercise frame.`);
    const point = gridToWgs84(frame, centre);
    return { lonlat: [round(point.longitude), round(point.latitude)], grid: value.trim() };
  }
  if (Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    const [longitude, latitude] = value as [number, number];
    const grid = wgs84ToGrid(frame, { latitude, longitude });
    if (!insideFrame(frame, grid)) fail(`${where} [${longitude}, ${latitude}] lies outside the exercise frame; nothing outside it goes on the map.`);
    return { lonlat: [round(longitude), round(latitude)], grid: formatGridReference(frame, grid, 6) };
  }
  return fail(`${where} is a grid reference such as ${frame.grid} 4532, or [longitude, latitude].`);
}

/** Seven decimals of a degree is about a centimetre: enough, and it keeps files stable. */
function round(value: number): number {
  return Math.round(value * 1e7) / 1e7;
}

function positions(frame: ExerciseFrame, value: unknown, where: string, min: number): { lonlats: Lonlat[]; grid: string[] } {
  if (!Array.isArray(value) || value.length < min || value.length > OBS_MAX_VERTICES) fail(`${where} is a list of ${min} to ${OBS_MAX_VERTICES} positions.`);
  const read = (value as unknown[]).map((item, index) => position(frame, item, `${where}[${index}]`));
  return { lonlats: read.map((item) => item.lonlat), grid: read.map((item) => item.grid) };
}

/** The geometry a kind is drawn with: a symbol and a decision point are points; control measures name theirs; an overlay is a line or an area. */
export function geometryOfKind(kind: CopFeatureKind): 'point' | 'line' | 'area' | 'line-or-area' {
  if (kind === 'symbol') return 'point';
  if (kind === 'overlay') return 'line-or-area';
  return COP_CONTROL_MEASURES[kind];
}

function geometryFrom(frame: ExerciseFrame, kind: CopFeatureKind, input: Record<string, unknown>, where: string): { geometry: CopGeometry; grid: string[] } {
  const shape = geometryOfKind(kind);
  const at = own(input, 'at');
  const pathValue = own(input, 'path');
  const area = own(input, 'area');
  const given = [at, pathValue, area].filter((value) => value !== undefined).length;
  if (given !== 1) fail(`${where} gives exactly one of at (a point), path (a line) or area (a closed area).`);
  if (at !== undefined) {
    if (shape !== 'point') fail(`${where}: a ${kind} is drawn as ${shape === 'line-or-area' ? 'a line or an area' : `a ${shape}`}, so give ${shape === 'area' ? 'area' : 'path'}.`);
    const point = position(frame, at, `${where}.at`);
    return { geometry: { type: 'Point', coordinates: point.lonlat }, grid: [point.grid] };
  }
  if (pathValue !== undefined) {
    if (shape !== 'line' && shape !== 'line-or-area') fail(`${where}: a ${kind} is drawn as ${shape === 'point' ? 'a point, so give at' : 'an area, so give area'}.`);
    const line = positions(frame, pathValue, `${where}.path`, 2);
    return { geometry: { type: 'LineString', coordinates: line.lonlats }, grid: line.grid };
  }
  if (shape !== 'area' && shape !== 'line-or-area') fail(`${where}: a ${kind} is drawn as ${shape === 'point' ? 'a point, so give at' : 'a line, so give path'}.`);
  const ring = positions(frame, area, `${where}.area`, 3);
  const closed = [...ring.lonlats];
  const first = closed[0];
  const last = closed[closed.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) closed.push(first);
  return { geometry: { type: 'Polygon', coordinates: [closed] }, grid: ring.grid };
}

/** A symbol's code: given as `sidc`, or built from words as `symbol` ({ identity, set, entity, echelon, headquarters }); exactly one. */
function symbolCode(raw: Record<string, unknown>, where: string): string {
  const sidc = own(raw, 'sidc');
  const symbol = own(raw, 'symbol');
  if ((sidc === undefined) === (symbol === undefined)) return fail(`${where}: a symbol gives exactly one of sidc (20 digits) or symbol ({ identity, set, entity, echelon, headquarters }).`);
  if (sidc !== undefined) return typeof sidc === 'string' ? sidc : fail(`${where}.sidc is 20 digits.`);
  if (!isRecord(symbol)) return fail(`${where}.symbol is { identity, set, entity, echelon, headquarters }.`);
  const identity = own(symbol, 'identity');
  const set = own(symbol, 'set');
  const entity = own(symbol, 'entity');
  const echelon = own(symbol, 'echelon');
  if (!(STANDARD_IDENTITIES as readonly unknown[]).includes(identity)) fail(`${where}.symbol.identity is one of ${STANDARD_IDENTITIES.join(', ')}.`);
  if (typeof set !== 'string' || !Object.prototype.hasOwnProperty.call(SYMBOL_ENTITIES, set)) fail(`${where}.symbol.set is one of ${Object.keys(SYMBOL_ENTITIES).join(', ')}.`);
  if (typeof entity !== 'string' || SYMBOL_ENTITIES[set as SymbolSet][entity] === undefined) fail(`${where}.symbol.entity is one of the ${String(set)} entities: ${Object.entries(SYMBOL_ENTITIES[set as SymbolSet] ?? {}).map(([code, name]) => `${code} ${name}`).join('; ')}.`);
  if (echelon !== undefined && (set !== 'land-unit' || !(ECHELONS as readonly unknown[]).includes(echelon))) fail(`${where}.symbol.echelon is a land unit's echelon: ${ECHELONS.join(', ')}.`);
  return buildSidc({ identity: identity as StandardIdentity, set: set as SymbolSet, entity: entity as string, ...(echelon ? { echelon: echelon as Echelon } : {}), ...(own(symbol, 'headquarters') === true ? { headquarters: true } : {}) });
}

// ---- A feature from a member ----------------------------------------------------------------------------------------------------------------

/** What a member gives for one feature. Positions are grid references (or [longitude, latitude] inside the frame). */
export interface CopFeatureInput {
  readonly id: string;
  readonly kind: CopFeatureKind;
  readonly name: string;
  readonly sidc?: string;
  readonly symbol?: { readonly identity: StandardIdentity; readonly set: SymbolSet; readonly entity: string; readonly echelon?: Echelon; readonly headquarters?: boolean };
  readonly at?: PositionInput;
  readonly path?: readonly PositionInput[];
  readonly area?: readonly PositionInput[];
  readonly label?: string;
  readonly sources?: readonly string[];
  readonly ecoa?: string;
  readonly ecoaRole?: EcoaRole;
  readonly decision?: string;
  readonly pirs?: readonly string[];
  readonly nais?: readonly string[];
  readonly anticipated?: boolean;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly note?: string;
}

const INPUT_KEYS = new Set(['id', 'kind', 'name', 'sidc', 'symbol', 'at', 'path', 'area', 'label', 'sources', 'ecoa', 'ecoaRole', 'decision', 'pirs', 'nais', 'anticipated', 'validFrom', 'validTo', 'note']);

/**
 * Reads one feature a member gives for a layer, under that layer's rules, and returns the stored feature. `by` is the member and `now` the time it
 * enters the layer. Refuses with the rule it breaks.
 */
export function buildCopFeature(layer: ProductLayer, raw: unknown, frame: ExerciseFrame, by: string, now: string, where = 'feature'): CopParsed<CopFeature> {
  return wrap(() => {
    if (!isRecord(raw)) return fail(`${where} is an object.`);
    for (const key of Object.keys(raw)) if (!INPUT_KEYS.has(key)) fail(`${where}.${key} is not a feature field. Fields: ${[...INPUT_KEYS].join(', ')}.`);
    const id = own(raw, 'id');
    if (typeof id !== 'string' || !COP_FEATURE_ID.test(id)) fail(`${where}.id is lower case letters, digits and dashes, such as e-1-41 or pl-copper.`);
    const kind = own(raw, 'kind');
    if (typeof kind !== 'string' || !(COP_FEATURE_KINDS as readonly string[]).includes(kind)) fail(`${where}.kind is one of ${COP_FEATURE_KINDS.join(', ')}.`);
    const rules = LAYER_RULES[layer];
    if (!rules.kinds.includes(kind as CopFeatureKind)) fail(`${where}: a ${kind} does not go on the ${layer}. It holds ${rules.kinds.join(', ')}.`);
    const name = textOf(own(raw, 'name'), `${where}.name`, 80);
    const { geometry, grid } = geometryFrom(frame, kind as CopFeatureKind, raw, where);
    const anticipated = own(raw, 'anticipated');
    if (anticipated !== undefined && typeof anticipated !== 'boolean') fail(`${where}.anticipated is true or false.`);
    const isAnticipated = rules.anticipatedOnly || anticipated === true;
    if (rules.anticipatedOnly && anticipated === false) fail(`${where}: everything on the plans layer is planned, so it is drawn anticipated.`);
    let sidc: string | undefined;
    if (kind === 'symbol') {
      const code = symbolCode(raw, where);
      const parsed = parseSidc(code);
      if (!parsed.ok) fail(`${where}.sidc: ${parsed.message}`);
      const spec = (parsed as { value: SymbolSpec }).value;
      if (isAssessedIdentity(spec.identity) && !rules.assessed) fail(`${where}: a ${spec.identity} symbol is the J2's assessment and goes on the threat layer; this layer shows friendly forces.`);
      // Anticipated is one flag: the code's status digit follows the feature (and the plans layer), so the frame and the card always agree.
      sidc = `${(code as string).slice(0, 6)}${isAnticipated ? '1' : '0'}${(code as string).slice(7)}`;
    } else if (own(raw, 'sidc') !== undefined || own(raw, 'symbol') !== undefined) {
      fail(`${where}: only a symbol carries a sidc; a ${kind} is drawn as a graphic.`);
    }
    const label = own(raw, 'label') === undefined ? DEFAULT_INTEL_LABEL : own(raw, 'label');
    if (!isTemplateLabel(label)) fail(`${where}.label is one of the exercise labels: org/Public, org/Internal, nato/NATO Unclassified or ca-protected/Protected A.`);
    const ecoa = optionalText(raw, 'ecoa', where, 10);
    const ecoaRole = own(raw, 'ecoaRole');
    if (ecoa !== undefined) {
      if (!rules.ecoa) fail(`${where}: overlays per adversary course of action go on the threat layer only.`);
      if (!ECOA_ID.test(ecoa)) fail(`${where}.ecoa is ECOA-1, ECOA-2 and so on.`);
    }
    if (ecoaRole !== undefined) {
      if (ecoa === undefined) fail(`${where}.ecoaRole needs the ecoa it describes.`);
      if (!(ECOA_ROLES as readonly unknown[]).includes(ecoaRole)) fail(`${where}.ecoaRole is ${ECOA_ROLES.join(' or ')}.`);
    }
    const decision = optionalText(raw, 'decision', where);
    const pirs = idList(raw, 'pirs', where);
    const nais = idList(raw, 'nais', where);
    if (kind === 'decision-point') {
      if (!decision) fail(`${where}: a decision point names the decision it is for (decision).`);
      if (!pirs?.length && !nais?.length) fail(`${where}: a decision point names the PIR or NAI that tells the commander it is time to decide (pirs or nais).`);
    } else if (decision !== undefined) {
      fail(`${where}: only a decision point carries a decision.`);
    }
    const validFrom = timeOf(raw, 'validFrom', where);
    const validTo = timeOf(raw, 'validTo', where);
    if (validFrom && validTo && parseIsoMillis(validTo) <= parseIsoMillis(validFrom)) fail(`${where}.validTo comes after validFrom.`);
    const sources = idList(raw, 'sources', where);
    const note = optionalText(raw, 'note', where);
    const properties: CopFeatureProperties = {
      kind: kind as CopFeatureKind, name, ...(sidc ? { sidc } : {}), grid, label: label as string,
      ...(sources?.length ? { sources } : {}), ...(ecoa ? { ecoa } : {}), ...(ecoaRole ? { ecoaRole: ecoaRole as EcoaRole } : {}),
      ...(decision ? { decision } : {}), ...(pirs?.length ? { pirs } : {}), ...(nais?.length ? { nais } : {}),
      ...(isAnticipated ? { anticipated: true } : {}), ...(validFrom ? { validFrom } : {}), ...(validTo ? { validTo } : {}),
      recordedAt: now, by, ...(note ? { note } : {})
    };
    return { type: 'Feature', id: id as string, geometry, properties };
  });
}

// ---- Stored features and the layer body -----------------------------------------------------------------------------------------------------

/** The headings drop 1 gave a map layer's file (src/agent/staff/j2Products.ts LAYER_HEADINGS). */
export const LAYER_FEATURES_HEADING = 'Layer features (GeoJSON FeatureCollection in a fenced block, exercise coordinates only)';
export const LAYER_SOURCES_HEADING = 'Sources and grades';

const FENCE = /```geojson[ \t]*\r?\n([\s\S]*?)\r?\n```/;

function lonlatOf(value: unknown, frame: ExerciseFrame | undefined, where: string): Lonlat {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => typeof n === 'number' && Number.isFinite(n))) fail(`${where} is [longitude, latitude].`);
  const [longitude, latitude] = value as [number, number];
  if (frame && !insideFrame(frame, wgs84ToGrid(frame, { latitude, longitude }))) fail(`${where} lies outside the exercise frame.`);
  return [longitude, latitude];
}

function storedGeometry(value: unknown, kind: CopFeatureKind, frame: ExerciseFrame | undefined, where: string): CopGeometry {
  if (!isRecord(value)) return fail(`${where} is a GeoJSON geometry.`);
  const shape = geometryOfKind(kind);
  const coordinates = own(value, 'coordinates');
  const type = own(value, 'type');
  if (type === 'Point' && shape === 'point') return { type, coordinates: lonlatOf(coordinates, frame, `${where}.coordinates`) };
  if (type === 'LineString' && (shape === 'line' || shape === 'line-or-area')) {
    if (!Array.isArray(coordinates) || coordinates.length < 2 || coordinates.length > OBS_MAX_VERTICES) fail(`${where} needs 2 to ${OBS_MAX_VERTICES} positions.`);
    return { type, coordinates: (coordinates as unknown[]).map((item, index) => lonlatOf(item, frame, `${where}.coordinates[${index}]`)) };
  }
  if (type === 'Polygon' && (shape === 'area' || shape === 'line-or-area')) {
    if (!Array.isArray(coordinates) || coordinates.length !== 1 || !Array.isArray(coordinates[0]) || coordinates[0].length < 4 || coordinates[0].length > OBS_MAX_VERTICES + 1) fail(`${where} is one closed ring of 4 or more positions.`);
    return { type, coordinates: [((coordinates as unknown[][])[0]).map((item, index) => lonlatOf(item, frame, `${where}.coordinates[0][${index}]`))] };
  }
  return fail(`${where}: a ${kind} is not drawn as a ${String(type)}.`);
}

/** Reads a feature as stored in a layer file, under the layer's rules (so a file edited by hand cannot put something on a layer the tool would refuse). */
export function parseStoredFeature(layer: ProductLayer, raw: unknown, frame: ExerciseFrame | undefined, where = 'feature'): CopParsed<CopFeature> {
  return wrap(() => {
    if (!isRecord(raw) || own(raw, 'type') !== 'Feature') return fail(`${where} is a GeoJSON Feature.`);
    const id = own(raw, 'id');
    if (typeof id !== 'string' || !COP_FEATURE_ID.test(id)) fail(`${where}.id is lower case letters, digits and dashes.`);
    const props = own(raw, 'properties');
    if (!isRecord(props)) return fail(`${where}.properties is an object.`);
    const kind = own(props, 'kind');
    if (typeof kind !== 'string' || !(COP_FEATURE_KINDS as readonly string[]).includes(kind)) fail(`${where}.properties.kind is one of ${COP_FEATURE_KINDS.join(', ')}.`);
    const rules = LAYER_RULES[layer];
    if (!rules.kinds.includes(kind as CopFeatureKind)) fail(`${where} (${String(id)}): a ${kind} does not go on the ${layer}.`);
    const geometry = storedGeometry(own(raw, 'geometry'), kind as CopFeatureKind, frame, `${where}.geometry`);
    const name = textOf(own(props, 'name'), `${where}.properties.name`, 80);
    const label = own(props, 'label');
    if (!isTemplateLabel(label)) fail(`${where}.properties.label is an exercise label.`);
    const recordedAt = timeOf(props, 'recordedAt', `${where}.properties`) ?? fail(`${where}.properties.recordedAt is the time it entered the layer.`);
    const by = textOf(own(props, 'by'), `${where}.properties.by`, 64);
    const anticipated = own(props, 'anticipated') === true;
    if (rules.anticipatedOnly && !anticipated) fail(`${where} (${String(id)}): everything on the plans layer is anticipated.`);
    let sidc: string | undefined;
    if (kind === 'symbol') {
      const parsed = parseSidc(own(props, 'sidc'));
      if (!parsed.ok) fail(`${where}.properties.sidc: ${parsed.message}`);
      const spec = (parsed as { value: SymbolSpec }).value;
      if (isAssessedIdentity(spec.identity) && !rules.assessed) fail(`${where} (${String(id)}): a ${spec.identity} symbol goes on the threat layer only.`);
      if ((spec.anticipated === true) !== anticipated) fail(`${where} (${String(id)}): the symbol code's status digit and anticipated disagree.`);
      sidc = own(props, 'sidc') as string;
    }
    const ecoa = optionalText(props, 'ecoa', `${where}.properties`, 10);
    if (ecoa !== undefined && (!rules.ecoa || !ECOA_ID.test(ecoa))) fail(`${where} (${String(id)}): ECOA overlays are ECOA-n and go on the threat layer only.`);
    const ecoaRole = own(props, 'ecoaRole');
    if (ecoaRole !== undefined && (ecoa === undefined || !(ECOA_ROLES as readonly unknown[]).includes(ecoaRole))) fail(`${where}.properties.ecoaRole is MLCOA or MDCOA, with its ecoa.`);
    const decision = optionalText(props, 'decision', `${where}.properties`);
    const pirs = idList(props, 'pirs', `${where}.properties`);
    const nais = idList(props, 'nais', `${where}.properties`);
    if (kind === 'decision-point' && (!decision || (!pirs?.length && !nais?.length))) fail(`${where} (${String(id)}): a decision point names its decision and a PIR or NAI.`);
    const gridValue = own(props, 'grid');
    const grid = Array.isArray(gridValue) && gridValue.length <= OBS_MAX_VERTICES + 1 && gridValue.every((item) => typeof item === 'string' && item.length <= 20) ? (gridValue as string[]) : undefined;
    const sources = idList(props, 'sources', `${where}.properties`);
    const validFrom = timeOf(props, 'validFrom', `${where}.properties`);
    const validTo = timeOf(props, 'validTo', `${where}.properties`);
    const note = optionalText(props, 'note', `${where}.properties`);
    return {
      type: 'Feature', id: id as string, geometry,
      properties: {
        kind: kind as CopFeatureKind, name, ...(sidc ? { sidc } : {}), ...(grid ? { grid } : {}), label: label as string,
        ...(sources?.length ? { sources } : {}), ...(ecoa ? { ecoa } : {}), ...(ecoaRole ? { ecoaRole: ecoaRole as EcoaRole } : {}),
        ...(decision ? { decision } : {}), ...(pirs?.length ? { pirs } : {}), ...(nais?.length ? { nais } : {}), ...(anticipated ? { anticipated: true } : {}),
        ...(validFrom ? { validFrom } : {}), ...(validTo ? { validTo } : {}), recordedAt, by, ...(note ? { note } : {})
      }
    };
  });
}

/** A layer's features read from its product body: the features that parse, and a plain problem for each that does not (never dropped silently). */
export interface LayerRead { readonly features: readonly CopFeature[]; readonly problems: readonly string[]; readonly hasBlock: boolean }

export function readLayerBody(layer: ProductLayer, body: string, frame: ExerciseFrame | undefined): LayerRead {
  const match = FENCE.exec(body);
  if (!match) return { features: [], problems: [], hasBlock: false };
  let value: unknown;
  try { value = JSON.parse(match[1]); } catch { return { features: [], problems: ['The ```geojson block is not valid JSON.'], hasBlock: true }; }
  if (!isRecord(value) || value.type !== 'FeatureCollection' || !Array.isArray(value.features)) return { features: [], problems: ['The ```geojson block is not a FeatureCollection.'], hasBlock: true };
  const features: CopFeature[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  (value.features as unknown[]).slice(0, COP_MAX_FEATURES_PER_LAYER).forEach((raw, index) => {
    const parsed = parseStoredFeature(layer, raw, frame, `features[${index}]`);
    if (!parsed.ok) { problems.push(parsed.message); return; }
    if (seen.has(parsed.value.id)) { problems.push(`features[${index}]: id ${parsed.value.id} appears twice.`); return; }
    seen.add(parsed.value.id);
    features.push(parsed.value);
  });
  if (value.features.length > COP_MAX_FEATURES_PER_LAYER) problems.push(`The layer holds ${value.features.length} features; only the first ${COP_MAX_FEATURES_PER_LAYER} are read.`);
  return { features, problems, hasBlock: true };
}

/** The section of a layer body after the features block (the sources and grades), kept as the owner wrote it. */
function sourcesSection(body: string): string {
  const at = body.indexOf(`## ${LAYER_SOURCES_HEADING}`);
  return at >= 0 ? body.slice(at).trimEnd() : `## ${LAYER_SOURCES_HEADING}\n\n- See each feature's sources.`;
}

/** Writes a layer body: the features as one FeatureCollection in a ```geojson block, then the sources section kept from the previous body. */
export function renderLayerBody(features: readonly CopFeature[], previousBody = ''): string {
  const collection: CopFeatureCollection = { type: 'FeatureCollection', features: [...features].sort((a, b) => a.id.localeCompare(b.id)) };
  return [`## ${LAYER_FEATURES_HEADING}`, '', '```geojson', JSON.stringify(collection, null, 1), '```', '', sourcesSection(previousBody), ''].join('\n');
}

/** Adds or replaces features by id and removes the ids named. Returns the new list or why not. */
export function mergeFeatures(existing: readonly CopFeature[], added: readonly CopFeature[], remove: readonly string[] = []): CopParsed<CopFeature[]> {
  const ids = new Set(added.map((feature) => feature.id));
  if (ids.size !== added.length) return refuse('Two of the features given share an id.');
  for (const id of remove) {
    if (ids.has(id)) return refuse(`${id} is both added and removed.`);
    if (!existing.some((feature) => feature.id === id)) return refuse(`There is no feature ${id} on the layer to remove.`);
  }
  const kept = existing.filter((feature) => !ids.has(feature.id) && !remove.includes(feature.id));
  const next = [...kept, ...added];
  if (next.length > COP_MAX_FEATURES_PER_LAYER) return refuse(`A layer holds at most ${COP_MAX_FEATURES_PER_LAYER} features.`);
  return { ok: true, value: next };
}

/** A layer's label: the join of its features' labels (never lower than the highest), or the default for an empty layer. */
export function layerLabel(features: readonly CopFeature[]): string | undefined {
  return features.length ? joinTemplateLabels(features.map((feature) => feature.properties.label)) : DEFAULT_INTEL_LABEL;
}

/** One feature as a line of text for an agent: id, kind, name, symbol in words, where, label and the links. */
export function featureLine(feature: CopFeature): string {
  const p = feature.properties;
  const symbol = p.sidc ? (() => { const parsed = parseSidc(p.sidc); return parsed.ok ? ` [${describeSymbol(parsed.value)}]` : ''; })() : '';
  const links = [
    p.ecoa ? `${p.ecoa}${p.ecoaRole ? ` (${p.ecoaRole})` : ''}` : '', p.decision ? `decision: ${p.decision}` : '', p.pirs?.length ? `PIRs ${p.pirs.join(', ')}` : '',
    p.nais?.length ? `NAIs ${p.nais.join(', ')}` : '', p.sources?.length ? `sources ${p.sources.join(', ')}` : '',
    p.validFrom || p.validTo ? `valid ${p.validFrom ?? '...'} to ${p.validTo ?? '...'}` : '', p.anticipated ? 'anticipated' : ''
  ].filter(Boolean);
  return `- ${feature.id} ${p.kind} "${p.name}"${symbol} at ${(p.grid ?? []).join(' ') || feature.geometry.type} | ${p.label}${links.length ? ` | ${links.join(' | ')}` : ''} | by ${p.by} ${p.recordedAt}`;
}
