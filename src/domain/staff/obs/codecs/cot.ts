// The one Cursor on Target codec (research note 11, 2.1 and 9.2 item 3; WP-IMP): the CoT event (MITRE CoT base schema, event version 2.0; note 11 [F1]),
// its point, and the common detail elements producers write: contact (callsign), track (course and speed), remarks, link (shape points), __group (team
// and role), precisionlocation (where the position came from) and uid (the device). Both the file importer and the simulator's own ingest read CoT
// here. Pure: no I/O, no clock, no vscode. XML is read by the strict reader beside it (xml.ts): no document type, no entities, capped sizes.
//
// The CoT type to symbol table is here and nowhere else (COT_SIDC_TABLE): a CoT atom type's dimension and function become a MIL-STD-2525D / APP-6(D)
// symbol set and entity from the COP's own entity table (cop/symbols.ts), and the identity letter is read with COT_IDENTITY_CODES (doctrine.ts). A type
// the table does not hold gets no symbol rather than a guessed one.
import { COT_IDENTITY_CODES, STANDARD_IDENTITIES } from '../../doctrine';
import type { StandardIdentity, SymbolSet } from '../../doctrine';
import { buildSidc } from '../../cop/symbols';
import type { PositionMethod } from '../observation';
import { attr, child, childrenNamed, childText, localName } from './xml';
import type { XmlElement } from './xml';

/** CoT writes this for a height or an error it does not know. */
export const COT_UNKNOWN = 9_999_999;

export interface CotEvent {
  readonly uid: string;
  readonly type: string;
  readonly how: string;
  readonly time: string;
  readonly start?: string;
  readonly stale?: string;
  readonly lat: number;
  readonly lon: number;
  /** Height above the WGS 84 ellipsoid in metres, or null when unknown. */
  readonly hae: number | null;
  readonly ce: number | null;
  readonly le: number | null;
  readonly callsign?: string;
  readonly remarks?: string;
  readonly course?: number;
  readonly speed?: number;
  readonly group?: { readonly name?: string; readonly role?: string };
  readonly geopointSource?: string;
  readonly device?: string;
  /** The CoT `opex` attribute: `s` is a simulation, `e` an exercise, `o` an operation. */
  readonly opex?: string;
  /** Shape corners from `link point="lat,lon"` elements, as [lat, lon]. */
  readonly shape: ReadonlyArray<readonly [number, number]>;
}

const number = (value: string | undefined): number => (value === undefined || value.trim() === '' ? NaN : Number(value));
const known = (value: number): number | null => (Number.isFinite(value) && value !== COT_UNKNOWN ? value : null);

/** One CoT `event` element, or the reason it is not a usable event. */
export function cotEventFrom(event: XmlElement): CotEvent | 'not-an-event' | 'missing-fields' | 'bad-point' {
  if (localName(event.name) !== 'event') return 'not-an-event';
  const uid = attr(event, 'uid');
  const type = attr(event, 'type');
  const how = attr(event, 'how') ?? 'h-g-i-g-o';
  const time = attr(event, 'time');
  const point = child(event, 'point');
  if (!uid || !type || !time || !point) return 'missing-fields';
  const lat = number(attr(point, 'lat'));
  const lon = number(attr(point, 'lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return 'bad-point';
  const hae = known(number(attr(point, 'hae')));
  const detail = child(event, 'detail');
  const contact = detail ? child(detail, 'contact') : undefined;
  const track = detail ? child(detail, 'track') : undefined;
  const group = detail ? child(detail, '__group') : undefined;
  const precision = detail ? child(detail, 'precisionlocation') : undefined;
  const device = detail ? child(detail, 'uid') : undefined;
  const remarks = detail ? childText(detail, 'remarks') : undefined;
  const shape: Array<readonly [number, number]> = [];
  for (const link of detail ? childrenNamed(detail, 'link') : []) {
    const value = attr(link, 'point');
    const match = value ? /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(value) : null;
    if (match) shape.push([Number(match[1]), Number(match[2])]);
  }
  const course = number(track ? attr(track, 'course') : undefined);
  const speed = number(track ? attr(track, 'speed') : undefined);
  const callsign = contact ? attr(contact, 'callsign') : undefined;
  const groupName = group ? attr(group, 'name') : undefined;
  const groupRole = group ? attr(group, 'role') : undefined;
  const start = attr(event, 'start');
  const stale = attr(event, 'stale');
  const opex = attr(event, 'opex');
  const geopointSource = precision ? attr(precision, 'geopointsrc') : undefined;
  const droid = device ? attr(device, 'Droid') : undefined;
  return {
    uid, type, how, time, lat, lon, hae: hae !== null && Math.abs(hae) <= 100_000 ? hae : null,
    ce: known(number(attr(point, 'ce'))), le: known(number(attr(point, 'le'))), shape,
    ...(start ? { start } : {}), ...(stale ? { stale } : {}), ...(opex ? { opex } : {}),
    ...(callsign ? { callsign } : {}), ...(remarks !== undefined ? { remarks } : {}),
    ...(Number.isFinite(course) && course >= 0 && course <= 360 ? { course } : {}), ...(Number.isFinite(speed) && speed >= 0 && speed <= 2000 ? { speed } : {}),
    ...(groupName || groupRole ? { group: { ...(groupName ? { name: groupName } : {}), ...(groupRole ? { role: groupRole } : {}) } } : {}),
    ...(geopointSource ? { geopointSource } : {}), ...(droid ? { device: droid } : {})
  };
}

/** The standard identity a CoT atom type claims (`a-h-G` is hostile), or undefined for a non-atom. A claim, never the J2's assessment. */
export function cotIdentity(type: string): StandardIdentity | undefined {
  const parts = type.split('-');
  if (parts[0] !== 'a' || parts.length < 2) return undefined;
  return STANDARD_IDENTITIES.find((identity) => COT_IDENTITY_CODES[identity] === parts[1]);
}

/**
 * How the position was produced, from the CoT `how` (MITRE CoT base schema): `m-g` machine GPS, other `m-` machine values (fused, derived, radio)
 * derived, `h-e` a person's estimate, and everything else (`h-g-i-g-o` entered, `h-t` transcribed) reported.
 */
export function cotPositionMethod(how: string): PositionMethod {
  if (how === 'm-g' || how.startsWith('m-g-')) return 'gps';
  if (how.startsWith('m-')) return 'derived';
  if (how === 'h-e' || how.startsWith('h-e-')) return 'estimated';
  return 'reported';
}

/**
 * CoT atom type to symbol: the part of the type after the identity letter (battle dimension and function, MIL-STD-2525B function codes as CoT writes
 * them; the public CoT type list, note 11 [F58]) to the 2525D / APP-6(D) symbol set and entity the COP draws (cop/symbols.ts SYMBOL_ENTITIES). The
 * longest matching prefix wins. One table, read by the importer and the COP; a new row is one line with its CoT function and its standard entity.
 */
export const COT_SIDC_TABLE: ReadonlyArray<{ readonly cot: string; readonly set: SymbolSet; readonly entity: string }> = [
  { cot: 'A-M', set: 'air', entity: '110000' },
  { cot: 'A-M-F', set: 'air', entity: '110100' },
  { cot: 'A-M-F-Q', set: 'air', entity: '110300' },
  { cot: 'A-M-H', set: 'air', entity: '110200' },
  { cot: 'G-U-C-A', set: 'land-unit', entity: '120500' },
  { cot: 'G-U-C-E', set: 'land-unit', entity: '140700' },
  { cot: 'G-U-C-F', set: 'land-unit', entity: '130300' },
  { cot: 'G-U-C-I', set: 'land-unit', entity: '121100' },
  { cot: 'G-U-C-I-M', set: 'land-unit', entity: '121102' },
  { cot: 'G-U-C-I-Z', set: 'land-unit', entity: '121104' },
  { cot: 'G-U-C-R', set: 'land-unit', entity: '121300' },
  { cot: 'G-U-S', set: 'land-unit', entity: '160000' },
  { cot: 'G-U-U-M', set: 'land-unit', entity: '151000' },
  { cot: 'S', set: 'sea-surface', entity: '000000' },
  { cot: 'S-C-A', set: 'sea-surface', entity: '120300' },
  { cot: 'S-C-L', set: 'sea-surface', entity: '120200' },
  { cot: 'S-C-M', set: 'sea-surface', entity: '120400' },
  { cot: 'S-C-P', set: 'sea-surface', entity: '120500' },
  { cot: 'S-X-M', set: 'sea-surface', entity: '140100' },
  { cot: 'S-X-M-C', set: 'sea-surface', entity: '140101' },
  { cot: 'U-S', set: 'sea-subsurface', entity: '110000' }
];

/** The table row a CoT atom type matches (longest prefix of its dimension and function), or undefined. */
export function cotSymbol(type: string): { readonly set: SymbolSet; readonly entity: string } | undefined {
  const parts = type.split('-');
  if (parts[0] !== 'a' || parts.length < 3) return undefined;
  const rest = parts.slice(2);
  for (let length = rest.length; length > 0; length -= 1) {
    const key = rest.slice(0, length).join('-');
    const row = COT_SIDC_TABLE.find((entry) => entry.cot === key);
    if (row) return { set: row.set, entity: row.entity };
  }
  return undefined;
}

/**
 * The 20-digit symbol code for a CoT atom type, drawn with the identity given. The caller decides the identity: on the COP a feed's claimed affiliation
 * is a claim, so only own-force positions are drawn as friends (cop/picture.ts). Undefined for a type the table does not hold.
 */
export function cotSidc(type: string, identity: StandardIdentity): string | undefined {
  const symbol = cotSymbol(type);
  return symbol ? buildSidc({ identity, set: symbol.set, entity: symbol.entity }) : undefined;
}

/** Whether a string reads as a CoT type (`a-f-G-U-C`, `b-m-p-s-p-i`, `u-d-f`). */
export function isCotType(value: string): boolean {
  return /^[a-z](?:-[A-Za-z0-9.]{1,8}){1,12}$/.test(value);
}
