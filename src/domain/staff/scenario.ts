// Exercise scenarios for the staff templates (design 10, section 8; WP-DEMO): the scenario file format, its strict reader, and the Markdown files a
// staff run reads. Pure: no I/O, no clock, no vscode.
//
// One reader serves both the starter scenario the extension ships (Exercise IRON LANTERN, written in-house and wholly fictional) and a scenario a
// person brings from their own exercise. A scenario is unclassified exercise data only: the reader refuses anything that is not marked fictional,
// any classification or caveat marking, any name on your organization's real-entity list, and coordinates outside the exercise area. It does not
// replace the release-guard's scan of products (design 10, 4.2); it keeps the inputs those products are built from clean.
import { INFORMATION_CREDIBILITY, SOURCE_RELIABILITY } from './doctrine';
import { FRAME_AXES, FRAME_FAILURES, FRAME_KINDS, frameProblem, gridReferencesIn, insideFrame } from './obs/frame';
import type { ExerciseFrame } from './obs/frame';
import { checkStaffKeys, childPath, isOneOf, isRecord, ownValue, STAFF_PARSE_FAILURES } from './parse';
import type { Fields } from './parse';

export const SCENARIO_FORMAT = 'near-ai-staff-scenario';
/**
 * The versions this reader reads (D-22: a new version sits beside the old one). Version 2 adds the optional exercise frame (`region.frame`, note 11,
 * section 6.5); a version 1 file reads exactly as before and may not carry a frame. SCENARIO_VERSION is the newest.
 */
export const SCENARIO_VERSIONS = [1, 2] as const;
export type ScenarioVersion = (typeof SCENARIO_VERSIONS)[number];
export const SCENARIO_VERSION: ScenarioVersion = 2;

/** The largest scenario file read, in bytes of text. A scenario is a few dozen kilobytes; anything far larger is not one. */
export const SCENARIO_MAX_FILE = 512 * 1024;
export const SCENARIO_MAX_LIST = 200;
export const SCENARIO_MAX_LINE = 200;
export const SCENARIO_MAX_TEXT = 4000;

/** The closed list of reasons a scenario is refused: the staff parse reasons plus the ones only a scenario can fail. */
export const SCENARIO_FAILURES = {
  ...STAFF_PARSE_FAILURES,
  'not-json': 'The file is not valid JSON.',
  'too-large': 'The file is larger than a scenario may be.',
  'wrong-format': 'The file is not a NEAR AI staff scenario in a version this extension reads.',
  'not-fictional': 'A scenario must be marked fictional, unclassified exercise data.',
  marking: 'The text carries a classification or caveat marking. Only unclassified exercise data may be loaded.',
  'real-entity': 'The text names an entry on your organization\'s real-entity list.',
  coordinates: 'The text carries coordinates outside the exercise area.',
  'dangling-reference': 'A field names an id the scenario does not define.',
  'too-many': 'A list has more entries than a scenario may hold.',
  frame: 'The exercise frame is not usable.',
  'outside-frame': 'A grid reference lies outside the exercise frame.'
} as const;
export type ScenarioFailure = keyof typeof SCENARIO_FAILURES;

export interface ScenarioRefusal { readonly ok: false; readonly reason: ScenarioFailure; readonly path: string; readonly message: string }
export type ScenarioParsed<T> = { readonly ok: true; readonly value: T } | ScenarioRefusal;

export const PARTY_SIDES = ['friendly', 'host-nation', 'adversary', 'neutral', 'unknown'] as const;
export type PartySide = (typeof PARTY_SIDES)[number];

export const FEATURE_KINDS = [
  'sea', 'strait', 'coast', 'beach', 'island', 'high-ground', 'river', 'crossing', 'route', 'town', 'port', 'airfield', 'forest', 'marsh', 'other'
] as const;
export type FeatureKind = (typeof FEATURE_KINDS)[number];

/** Civil considerations in the ASCOPE order (areas, structures, capabilities, organizations, people, events; 02 s3.2). */
export const CIVIL_KINDS = ['area', 'structure', 'capability', 'organization', 'people', 'event'] as const;
export type CivilKind = (typeof CIVIL_KINDS)[number];

export const CONTROL_KINDS = ['phase-line', 'objective', 'assembly-area', 'nai', 'boundary', 'landing-area', 'route'] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];

export const REPORT_KINDS = ['patrol', 'imagery', 'open-source', 'liaison', 'signals', 'maritime', 'human', 'technical', 'other'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const SOURCE_ORIGINS = ['in-house', 'downloaded'] as const;
export type SourceOrigin = (typeof SOURCE_ORIGINS)[number];

export type ScenarioGrid =
  | { readonly kind: 'fictional'; readonly name: string }
  | { readonly kind: 'geographic'; readonly south: number; readonly west: number; readonly north: number; readonly east: number };

export interface ScenarioFeature { readonly id: string; readonly kind: FeatureKind; readonly name: string; readonly location: string; readonly description: string }
export interface CivilConsideration { readonly id: string; readonly kind: CivilKind; readonly name: string; readonly description: string }
export interface ScenarioParty { readonly id: string; readonly name: string; readonly side: PartySide; readonly description: string }
export interface ScenarioForce {
  readonly id: string;
  readonly party: string;
  readonly designation: string;
  readonly kind: string;
  readonly echelon?: string;
  readonly parent?: string;
  readonly location: string;
  readonly strength?: string;
  readonly capabilities: readonly string[];
  readonly notes?: string;
  /** The reports this entry rests on; an entry with none is own-force data or higher's order of battle. */
  readonly reportedBy: readonly string[];
}
export interface ControlMeasure { readonly id: string; readonly kind: ControlKind; readonly name: string; readonly location: string; readonly description: string }
export interface ScenarioAssumption { readonly id: string; readonly text: string }
export interface TimelineEntry { readonly id: string; readonly when: string; readonly event: string }
export interface ScenarioMission {
  readonly higher: {
    readonly headquarters: string;
    readonly order: string;
    readonly mission: string;
    readonly intent: { readonly purpose: string; readonly keyTasks: readonly string[]; readonly endState: string };
  };
  readonly own: {
    readonly headquarters: string;
    readonly tasks: readonly string[];
    readonly constraints: readonly string[];
    readonly restraints: readonly string[];
    readonly assumptions: readonly ScenarioAssumption[];
    readonly timeline: readonly TimelineEntry[];
  };
}
export interface SourceGrade { readonly reliability: string; readonly credibility: string }
export interface ScenarioReport {
  readonly id: string;
  readonly kind: ReportKind;
  readonly title: string;
  readonly received: string;
  /** Who reported it: a fictional source description, never a real person. */
  readonly source: string;
  /** Where the information first came from. Two reports with the same origin never count as independent confirmation (design 10, 4.4). */
  readonly origin: string;
  /** Absent when the report is ungraded. */
  readonly grade?: SourceGrade;
  readonly text: string;
  readonly deception?: string;
  readonly about: readonly string[];
}
export interface SourceRegisterEntry {
  readonly id: string;
  readonly title: string;
  readonly origin: SourceOrigin;
  readonly address?: string;
  readonly accessed?: string;
  readonly distribution: string;
  readonly licence?: string;
}
export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly marking: string;
  readonly summary: string;
  readonly region: {
    readonly name: string;
    readonly description: string;
    readonly grid: ScenarioGrid;
    /** Where the fictional grid sits on the globe for the map and feed replays (version 2 only). */
    readonly frame?: ExerciseFrame;
    readonly features: readonly ScenarioFeature[];
    readonly weather: { readonly summary: string; readonly effects: readonly string[] };
    readonly civil: readonly CivilConsideration[];
  };
  readonly parties: readonly ScenarioParty[];
  readonly forces: readonly ScenarioForce[];
  readonly controlMeasures: readonly ControlMeasure[];
  readonly mission: ScenarioMission;
  readonly reports: readonly ScenarioReport[];
  readonly sourceRegister: readonly SourceRegisterEntry[];
}

export interface ScenarioOptions {
  /** Your organization's real-entity list (real units, people, bases): any of these in the scenario is refused, matched as whole words in any case. */
  readonly realEntities?: readonly string[];
}

/** Every scenario id: letters, digits and dashes, starting with a letter or digit, at most 32 characters. Ids are unique across the whole scenario. */
export const SCENARIO_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/;

/**
 * Classification and caveat markings refused in any scenario text, matched in capitals as whole words (design 10, 4.2). "UNCLASSIFIED" is not matched,
 * and neither is ordinary lower-case prose.
 */
export const SCENARIO_MARKING_PATTERNS: readonly RegExp[] = [
  /\bTOP SECRET\b/, /(^|[^A-Z])SECRET\b/, /\bCONFIDENTIAL\b/, /\bRESTRICTED\b/, /\bCOSMIC\b/, /\bPROTECTED [ABC]\b/, /\bCUI\b/, /\bFOUO\b/,
  /\bNOFORN\b/, /\bORCON\b/, /\bEYES ONLY\b/, /\bREL TO\b/
];

/** The marking every scenario carries: unclassified, and exercise data. */
export const SCENARIO_MARKING_REQUIRED: readonly string[] = ['UNCLASSIFIED', 'EXERCISE'];

/** Decimal latitude and longitude pairs, and degree-minute forms, in free text. */
const DECIMAL_PAIR = /(-?\d{1,2}\.\d{2,})\s*[,;/ ]\s*(-?\d{1,3}\.\d{2,})/g;
const DEGREE_FORM = /\d{1,3}\s*°\s*\d{1,2}\s*['′]/;

function scenarioRefused(reason: ScenarioFailure, path: string): ScenarioRefusal {
  const where = path.replace(/[^A-Za-z0-9_.[\]-]/g, '?').slice(0, 120);
  return { ok: false, reason, path: where, message: where === '' ? SCENARIO_FAILURES[reason] : `${SCENARIO_FAILURES[reason]} (at ${where})` };
}

/** Thrown inside the walk and caught at the top, so every nested reader can stop the read with one refusal. */
class Refused extends Error {
  constructor(readonly refusal: ScenarioRefusal) { super(refusal.message); }
}
function refuse(reason: ScenarioFailure, path: string): never {
  throw new Refused(scenarioRefused(reason, path));
}

interface Walk {
  readonly realEntities: readonly RegExp[];
  readonly grid?: ScenarioGrid;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Checks one string for markings, real entities and coordinates outside the exercise area. */
function screen(text: string, path: string, walk: Walk): void {
  if (SCENARIO_MARKING_PATTERNS.some((pattern) => pattern.test(text))) refuse('marking', path);
  if (walk.realEntities.some((pattern) => pattern.test(text))) refuse('real-entity', path);
  const grid = walk.grid;
  if (!grid || grid.kind === 'fictional') {
    DECIMAL_PAIR.lastIndex = 0;
    if (DECIMAL_PAIR.test(text) || DEGREE_FORM.test(text)) refuse('coordinates', path);
    return;
  }
  if (DEGREE_FORM.test(text)) refuse('coordinates', path);
  for (const match of text.matchAll(DECIMAL_PAIR)) {
    const lat = Number(match[1]);
    const lon = Number(match[2]);
    if (lat < grid.south || lat > grid.north || lon < grid.west || lon > grid.east) refuse('coordinates', path);
  }
}

function record(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Fields {
  if (!isRecord(value)) refuse('not-an-object', path);
  const keys = checkStaffKeys(value, path, required, optional);
  if (keys) throw new Refused(keys);
  return value;
}

function line(value: unknown, path: string, walk: Walk, max = SCENARIO_MAX_LINE): string {
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || value.trim() === '' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) refuse('wrong-type', path);
  screen(value, path, walk);
  return value;
}

function prose(value: unknown, path: string, walk: Walk): string {
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || value.trim() === '' || value.length > SCENARIO_MAX_TEXT || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) refuse('wrong-type', path);
  screen(value, path, walk);
  return value;
}

function list<T>(value: unknown, path: string, read: (item: unknown, path: string) => T, allowEmpty = true): T[] {
  if (!Array.isArray(value)) refuse('wrong-type', path);
  if (value.length > SCENARIO_MAX_LIST) refuse('too-many', path);
  if (!allowEmpty && value.length === 0) refuse('missing-field', path);
  return value.map((item, index) => read(item, `${path}[${index}]`));
}

function choice<T extends string>(choices: readonly T[], value: unknown, path: string): T {
  if (!isOneOf(choices, value)) refuse('unknown-value', path);
  return value;
}

function id(value: unknown, path: string, seen: Set<string>): string {
  if (typeof value !== 'string' || !SCENARIO_ID.test(value)) refuse('wrong-type', path);
  if (SCENARIO_MARKING_PATTERNS.some((pattern) => pattern.test(value))) refuse('marking', path);
  if (seen.has(value)) refuse('duplicate-entry', path);
  seen.add(value);
  return value;
}

function optional<T>(fields: Fields, key: string, read: (value: unknown) => T): T | undefined {
  const value = ownValue(fields, key);
  return value === undefined ? undefined : read(value);
}

function readGrid(value: unknown, path: string): ScenarioGrid {
  const fields = record(value, path, ['kind'], ['name', 'south', 'west', 'north', 'east']);
  const kind = choice(['fictional', 'geographic'] as const, ownValue(fields, 'kind'), childPath(path, 'kind'));
  if (kind === 'fictional') {
    const extra = ['south', 'west', 'north', 'east'].find((key) => ownValue(fields, key) !== undefined);
    if (extra) refuse('not-allowed-here', childPath(path, extra));
    const name = ownValue(fields, 'name');
    if (typeof name !== 'string' || !/^[A-Za-z0-9 -]{1,40}$/.test(name)) refuse('wrong-type', childPath(path, 'name'));
    return { kind, name };
  }
  if (ownValue(fields, 'name') !== undefined) refuse('not-allowed-here', childPath(path, 'name'));
  const number = (key: string, limit: number): number => {
    const raw = ownValue(fields, key);
    if (typeof raw !== 'number' || !Number.isFinite(raw)) refuse('wrong-type', childPath(path, key));
    if (Math.abs(raw) > limit) refuse('out-of-range', childPath(path, key));
    return raw;
  };
  const box = { south: number('south', 90), west: number('west', 180), north: number('north', 90), east: number('east', 180) };
  if (box.south >= box.north) refuse('out-of-range', childPath(path, 'north'));
  if (box.west >= box.east) refuse('out-of-range', childPath(path, 'east'));
  return { kind, ...box };
}

/**
 * Reads a scenario strictly: the format and version, every field checked, unknown and missing fields refused, ids unique across the scenario, every
 * reference resolved, every text screened for markings, real entities and stray coordinates. The first problem found is the refusal.
 */
export function parseScenario(value: unknown, options: ScenarioOptions = {}): ScenarioParsed<Scenario> {
  try {
    return { ok: true, value: readScenario(value, options) };
  } catch (error) {
    if (error instanceof Refused) return error.refusal;
    throw error;
  }
}

/** Reads a scenario from file text: size first, then JSON, then the strict read. */
export function parseScenarioText(text: string, options: ScenarioOptions = {}): ScenarioParsed<Scenario> {
  if (text.length > SCENARIO_MAX_FILE) return scenarioRefused('too-large', '');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return scenarioRefused('not-json', '');
  }
  return parseScenario(value, options);
}

function readScenario(value: unknown, options: ScenarioOptions): Scenario {
  if (!isRecord(value)) refuse('not-an-object', 'scenario');
  const version = ownValue(value, 'version');
  if (ownValue(value, 'format') !== SCENARIO_FORMAT || !(SCENARIO_VERSIONS as readonly unknown[]).includes(version)) refuse('wrong-format', 'format');
  if (ownValue(value, 'fictional') !== true) refuse('not-fictional', 'fictional');
  const top = record(value, '', [
    'format', 'version', 'id', 'title', 'marking', 'fictional', 'summary', 'region', 'parties', 'forces', 'controlMeasures', 'mission', 'reports'
  ], ['sourceRegister']);
  const realEntities = (options.realEntities ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(entry).split(/\s+/).join('\\s+')}($|[^A-Za-z0-9])`, 'i'));

  const regionFields = record(ownValue(top, 'region'), 'region', ['name', 'description', 'grid', 'features', 'weather', 'civil'], version === 2 ? ['frame'] : []);
  const grid = readGrid(ownValue(regionFields, 'grid'), 'region.grid');
  const frame = optional(regionFields, 'frame', (raw) => readFrame(raw, 'region.frame', grid));
  const walk: Walk = { realEntities, grid };
  const seen = new Set<string>();

  const marking = line(ownValue(top, 'marking'), 'marking', walk);
  if (!SCENARIO_MARKING_REQUIRED.every((word) => marking.includes(word))) refuse('not-fictional', 'marking');

  const features = list(ownValue(regionFields, 'features'), 'region.features', (item, path): ScenarioFeature => {
    const fields = record(item, path, ['id', 'kind', 'name', 'location', 'description']);
    return {
      id: id(ownValue(fields, 'id'), childPath(path, 'id'), seen),
      kind: choice(FEATURE_KINDS, ownValue(fields, 'kind'), childPath(path, 'kind')),
      name: line(ownValue(fields, 'name'), childPath(path, 'name'), walk),
      location: line(ownValue(fields, 'location'), childPath(path, 'location'), walk),
      description: prose(ownValue(fields, 'description'), childPath(path, 'description'), walk)
    };
  }, false);
  const weatherFields = record(ownValue(regionFields, 'weather'), 'region.weather', ['summary', 'effects']);
  const civil = list(ownValue(regionFields, 'civil'), 'region.civil', (item, path): CivilConsideration => {
    const fields = record(item, path, ['id', 'kind', 'name', 'description']);
    return {
      id: id(ownValue(fields, 'id'), childPath(path, 'id'), seen),
      kind: choice(CIVIL_KINDS, ownValue(fields, 'kind'), childPath(path, 'kind')),
      name: line(ownValue(fields, 'name'), childPath(path, 'name'), walk),
      description: prose(ownValue(fields, 'description'), childPath(path, 'description'), walk)
    };
  });
  const region = {
    name: line(ownValue(regionFields, 'name'), 'region.name', walk),
    description: prose(ownValue(regionFields, 'description'), 'region.description', walk),
    grid,
    ...(frame ? { frame } : {}),
    features,
    weather: {
      summary: prose(ownValue(weatherFields, 'summary'), 'region.weather.summary', walk),
      effects: list(ownValue(weatherFields, 'effects'), 'region.weather.effects', (item, path) => line(item, path, walk, SCENARIO_MAX_TEXT))
    },
    civil
  };

  const parties = list(ownValue(top, 'parties'), 'parties', (item, path): ScenarioParty => {
    const fields = record(item, path, ['id', 'name', 'side', 'description']);
    return {
      id: id(ownValue(fields, 'id'), childPath(path, 'id'), seen),
      name: line(ownValue(fields, 'name'), childPath(path, 'name'), walk),
      side: choice(PARTY_SIDES, ownValue(fields, 'side'), childPath(path, 'side')),
      description: prose(ownValue(fields, 'description'), childPath(path, 'description'), walk)
    };
  }, false);
  for (const side of ['friendly', 'adversary'] as const) if (!parties.some((party) => party.side === side)) refuse('missing-field', `parties.${side}`);

  const forces = list(ownValue(top, 'forces'), 'forces', (item, path): ScenarioForce => {
    const fields = record(item, path, ['id', 'party', 'designation', 'kind', 'location'], ['echelon', 'parent', 'strength', 'capabilities', 'notes', 'reportedBy']);
    const ref = (key: string): string => {
      const raw = ownValue(fields, key);
      if (typeof raw !== 'string' || !SCENARIO_ID.test(raw)) refuse('wrong-type', childPath(path, key));
      return raw;
    };
    const echelon = optional(fields, 'echelon', (raw) => line(raw, childPath(path, 'echelon'), walk, 40));
    const parent = optional(fields, 'parent', () => ref('parent'));
    const strength = optional(fields, 'strength', (raw) => line(raw, childPath(path, 'strength'), walk));
    const notes = optional(fields, 'notes', (raw) => prose(raw, childPath(path, 'notes'), walk));
    return {
      id: id(ownValue(fields, 'id'), childPath(path, 'id'), seen),
      party: ref('party'),
      designation: line(ownValue(fields, 'designation'), childPath(path, 'designation'), walk, 60),
      kind: line(ownValue(fields, 'kind'), childPath(path, 'kind'), walk),
      ...(echelon !== undefined ? { echelon } : {}),
      ...(parent !== undefined ? { parent } : {}),
      location: line(ownValue(fields, 'location'), childPath(path, 'location'), walk),
      ...(strength !== undefined ? { strength } : {}),
      capabilities: optional(fields, 'capabilities', (raw) => list(raw, childPath(path, 'capabilities'), (entry, at) => line(entry, at, walk, SCENARIO_MAX_TEXT))) ?? [],
      ...(notes !== undefined ? { notes } : {}),
      reportedBy: optional(fields, 'reportedBy', (raw) => list(raw, childPath(path, 'reportedBy'), (entry, at) => {
        if (typeof entry !== 'string' || !SCENARIO_ID.test(entry)) refuse('wrong-type', at);
        return entry;
      })) ?? []
    };
  }, false);

  const controlMeasures = list(ownValue(top, 'controlMeasures'), 'controlMeasures', (item, path): ControlMeasure => {
    const fields = record(item, path, ['id', 'kind', 'name', 'location', 'description']);
    return {
      id: id(ownValue(fields, 'id'), childPath(path, 'id'), seen),
      kind: choice(CONTROL_KINDS, ownValue(fields, 'kind'), childPath(path, 'kind')),
      name: line(ownValue(fields, 'name'), childPath(path, 'name'), walk),
      location: line(ownValue(fields, 'location'), childPath(path, 'location'), walk),
      description: prose(ownValue(fields, 'description'), childPath(path, 'description'), walk)
    };
  });

  const mission = readMission(ownValue(top, 'mission'), walk, seen);

  const reports = list(ownValue(top, 'reports'), 'reports', (item, path): ScenarioReport => {
    const fields = record(item, path, ['id', 'kind', 'title', 'received', 'source', 'origin', 'text'], ['grade', 'deception', 'about']);
    const grade = optional(fields, 'grade', (raw): SourceGrade => {
      const at = childPath(path, 'grade');
      const gradeFields = record(raw, at, ['reliability', 'credibility']);
      const reliability = ownValue(gradeFields, 'reliability');
      const credibility = ownValue(gradeFields, 'credibility');
      if (typeof reliability !== 'string' || !Object.prototype.hasOwnProperty.call(SOURCE_RELIABILITY, reliability)) refuse('unknown-value', childPath(at, 'reliability'));
      if (typeof credibility !== 'string' || !Object.prototype.hasOwnProperty.call(INFORMATION_CREDIBILITY, credibility)) refuse('unknown-value', childPath(at, 'credibility'));
      return { reliability, credibility };
    });
    const deception = optional(fields, 'deception', (raw) => prose(raw, childPath(path, 'deception'), walk));
    return {
      id: id(ownValue(fields, 'id'), childPath(path, 'id'), seen),
      kind: choice(REPORT_KINDS, ownValue(fields, 'kind'), childPath(path, 'kind')),
      title: line(ownValue(fields, 'title'), childPath(path, 'title'), walk),
      received: line(ownValue(fields, 'received'), childPath(path, 'received'), walk, 40),
      source: line(ownValue(fields, 'source'), childPath(path, 'source'), walk),
      origin: line(ownValue(fields, 'origin'), childPath(path, 'origin'), walk),
      ...(grade ? { grade } : {}),
      text: prose(ownValue(fields, 'text'), childPath(path, 'text'), walk),
      ...(deception !== undefined ? { deception } : {}),
      about: optional(fields, 'about', (raw) => list(raw, childPath(path, 'about'), (entry, at) => {
        if (typeof entry !== 'string' || !SCENARIO_ID.test(entry)) refuse('wrong-type', at);
        return entry;
      })) ?? []
    };
  }, false);

  const sourceRegister = optional(top, 'sourceRegister', (raw) => list(raw, 'sourceRegister', (item, path): SourceRegisterEntry => {
    const fields = record(item, path, ['id', 'title', 'origin', 'distribution'], ['address', 'accessed', 'licence']);
    const origin = choice(SOURCE_ORIGINS, ownValue(fields, 'origin'), childPath(path, 'origin'));
    const address = optional(fields, 'address', (value) => {
      const text = line(value, childPath(path, 'address'), walk, 400);
      if (!/^https:\/\/[^\s]+$/.test(text)) refuse('wrong-type', childPath(path, 'address'));
      return text;
    });
    const accessed = optional(fields, 'accessed', (value) => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) refuse('wrong-type', childPath(path, 'accessed'));
      return value;
    });
    // Design 10, 8 item 4: a downloaded volume records its address, the date it was read and its distribution wording.
    if (origin === 'downloaded' && address === undefined) refuse('missing-field', childPath(path, 'address'));
    if (origin === 'downloaded' && accessed === undefined) refuse('missing-field', childPath(path, 'accessed'));
    const licence = optional(fields, 'licence', (value) => line(value, childPath(path, 'licence'), walk));
    return {
      id: id(ownValue(fields, 'id'), childPath(path, 'id'), seen),
      title: line(ownValue(fields, 'title'), childPath(path, 'title'), walk),
      origin,
      ...(address !== undefined ? { address } : {}),
      ...(accessed !== undefined ? { accessed } : {}),
      distribution: line(ownValue(fields, 'distribution'), childPath(path, 'distribution'), walk, 400),
      ...(licence !== undefined ? { licence } : {})
    };
  })) ?? [];

  // References resolve only once every id is known: parties, parents, reports and the things reports are about.
  const partyIds = new Set(parties.map((party) => party.id));
  const forceIds = new Set(forces.map((force) => force.id));
  const reportIds = new Set(reports.map((report) => report.id));
  forces.forEach((force, index) => {
    if (!partyIds.has(force.party)) refuse('dangling-reference', `forces[${index}].party`);
    if (force.parent !== undefined && !forceIds.has(force.parent)) refuse('dangling-reference', `forces[${index}].parent`);
    if (force.parent === force.id) refuse('not-allowed-here', `forces[${index}].parent`);
    force.reportedBy.forEach((entry, at) => { if (!reportIds.has(entry)) refuse('dangling-reference', `forces[${index}].reportedBy[${at}]`); });
  });
  forces.forEach((force, index) => {
    const chain = new Set<string>([force.id]);
    for (let parent = force.parent; parent !== undefined; parent = forces.find((entry) => entry.id === parent)?.parent) {
      if (chain.has(parent)) refuse('not-allowed-here', `forces[${index}].parent`);
      chain.add(parent);
    }
  });
  reports.forEach((report, index) => report.about.forEach((entry, at) => {
    if (!seen.has(entry) || entry === report.id) refuse('dangling-reference', `reports[${index}].about[${at}]`);
  }));
  if (frame) {
    // Every grid reference a place or unit is given at must fall inside the frame, so every replayed position lands on the frame's ocean.
    const located: Array<{ readonly location: string; readonly path: string }> = [
      ...features.map((entry, index) => ({ location: entry.location, path: `region.features[${index}].location` })),
      ...forces.map((entry, index) => ({ location: entry.location, path: `forces[${index}].location` })),
      ...controlMeasures.map((entry, index) => ({ location: entry.location, path: `controlMeasures[${index}].location` }))
    ];
    for (const entry of located) {
      if (gridReferencesIn(entry.location, frame.grid, frame.squareMetres).some((reference) => !insideFrame(frame, reference))) refuse('outside-frame', entry.path);
    }
  }

  return {
    id: id(ownValue(top, 'id'), 'id', seen),
    title: line(ownValue(top, 'title'), 'title', walk),
    marking,
    summary: prose(ownValue(top, 'summary'), 'summary', walk),
    region, parties, forces, controlMeasures, mission, reports, sourceRegister
  };
}

function readFrame(value: unknown, path: string, grid: ScenarioGrid): ExerciseFrame {
  if (grid.kind !== 'fictional') refuse('not-allowed-here', path);
  const fields = record(value, path, ['kind', 'grid', 'squareMetres', 'origin', 'extent', 'axis']);
  const origin = record(ownValue(fields, 'origin'), childPath(path, 'origin'), ['latitude', 'longitude']);
  const extent = record(ownValue(fields, 'extent'), childPath(path, 'extent'), ['eastings', 'northings']);
  const number = (raw: unknown, at: string): number => {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) refuse('wrong-type', at);
    return raw;
  };
  const gridName = ownValue(fields, 'grid');
  if (typeof gridName !== 'string') refuse('wrong-type', childPath(path, 'grid'));
  const frame: ExerciseFrame = {
    kind: choice(FRAME_KINDS, ownValue(fields, 'kind'), childPath(path, 'kind')),
    grid: gridName,
    squareMetres: number(ownValue(fields, 'squareMetres'), childPath(path, 'squareMetres')),
    origin: { latitude: number(ownValue(origin, 'latitude'), childPath(path, 'origin.latitude')), longitude: number(ownValue(origin, 'longitude'), childPath(path, 'origin.longitude')) },
    extent: { eastings: number(ownValue(extent, 'eastings'), childPath(path, 'extent.eastings')), northings: number(ownValue(extent, 'northings'), childPath(path, 'extent.northings')) },
    axis: choice(FRAME_AXES, ownValue(fields, 'axis'), childPath(path, 'axis'))
  };
  const problem = frameProblem(frame, grid.name);
  if (problem) throw new Refused({ ...scenarioRefused('frame', path), message: `${SCENARIO_FAILURES.frame} ${FRAME_FAILURES[problem]} (at ${path})` });
  return frame;
}

function readMission(value: unknown, walk: Walk, seen: Set<string>): ScenarioMission {
  const fields = record(value, 'mission', ['higher', 'own']);
  const higher = record(ownValue(fields, 'higher'), 'mission.higher', ['headquarters', 'order', 'mission', 'intent']);
  const intent = record(ownValue(higher, 'intent'), 'mission.higher.intent', ['purpose', 'keyTasks', 'endState']);
  const own = record(ownValue(fields, 'own'), 'mission.own', ['headquarters', 'tasks', 'constraints', 'restraints', 'assumptions', 'timeline']);
  const lines = (raw: unknown, path: string, allowEmpty = true): string[] => list(raw, path, (item, at) => line(item, at, walk, SCENARIO_MAX_TEXT), allowEmpty);
  return {
    higher: {
      headquarters: line(ownValue(higher, 'headquarters'), 'mission.higher.headquarters', walk),
      order: line(ownValue(higher, 'order'), 'mission.higher.order', walk),
      mission: prose(ownValue(higher, 'mission'), 'mission.higher.mission', walk),
      intent: {
        purpose: prose(ownValue(intent, 'purpose'), 'mission.higher.intent.purpose', walk),
        keyTasks: lines(ownValue(intent, 'keyTasks'), 'mission.higher.intent.keyTasks', false),
        endState: prose(ownValue(intent, 'endState'), 'mission.higher.intent.endState', walk)
      }
    },
    own: {
      headquarters: line(ownValue(own, 'headquarters'), 'mission.own.headquarters', walk),
      tasks: lines(ownValue(own, 'tasks'), 'mission.own.tasks', false),
      constraints: lines(ownValue(own, 'constraints'), 'mission.own.constraints'),
      restraints: lines(ownValue(own, 'restraints'), 'mission.own.restraints'),
      assumptions: list(ownValue(own, 'assumptions'), 'mission.own.assumptions', (item, path): ScenarioAssumption => {
        const entry = record(item, path, ['id', 'text']);
        return { id: id(ownValue(entry, 'id'), childPath(path, 'id'), seen), text: line(ownValue(entry, 'text'), childPath(path, 'text'), walk, SCENARIO_MAX_TEXT) };
      }),
      timeline: list(ownValue(own, 'timeline'), 'mission.own.timeline', (item, path): TimelineEntry => {
        const entry = record(item, path, ['id', 'when', 'event']);
        return {
          id: id(ownValue(entry, 'id'), childPath(path, 'id'), seen),
          when: line(ownValue(entry, 'when'), childPath(path, 'when'), walk, 40),
          event: line(ownValue(entry, 'event'), childPath(path, 'event'), walk, SCENARIO_MAX_TEXT)
        };
      })
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The files a staff run reads.

/** Where a loaded scenario lives in a project. Members read it; nobody edits it during a run. */
export const SCENARIO_DIR = '.planning/staff/scenario';

/** A report's grade as products cite it: `B2`, or `ungraded`. */
export function reportGradeText(report: Pick<ScenarioReport, 'grade'>): string {
  return report.grade ? `${report.grade.reliability}${report.grade.credibility}` : 'ungraded';
}

/** A report as a product cites it: `PR-11 (B2)` or `FR-01 (ungraded)`. */
export function citationText(report: Pick<ScenarioReport, 'id' | 'grade'>): string {
  return `${report.id} (${reportGradeText(report)})`;
}

function cell(text: string): string {
  return text.replace(/\|/g, '/').replace(/\s*\n\s*/g, ' ');
}

function table(headings: readonly string[], rows: ReadonlyArray<readonly string[]>): string[] {
  return [`| ${headings.join(' | ')} |`, `|${headings.map(() => '---').join('|')}|`, ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`)];
}

/**
 * The Markdown files for a loaded scenario, relative to the project root, plus the scenario itself as `scenario.json`. Every file opens with the
 * scenario's marking, so a file read on its own still says it is fictional exercise data.
 */
export function scenarioFiles(scenario: Scenario): Array<{ readonly path: string; readonly content: string }> {
  const banner = [`> ${scenario.marking}`, '>', '> Fictional exercise data. Nothing in this folder describes a real place, unit, person or operation.', ''];
  const forcesOf = (side: PartySide): ScenarioForce[] => scenario.forces.filter((force) => scenario.parties.find((party) => party.id === force.party)?.side === side);
  const designation = (forceId: string | undefined): string => (forceId ? scenario.forces.find((force) => force.id === forceId)?.designation ?? forceId : '');
  const reportCitations = (ids: readonly string[]): string => ids.map((entry) => {
    const report = scenario.reports.find((candidate) => candidate.id === entry);
    return report ? citationText(report) : entry;
  }).join(', ');
  const forceTable = (forces: readonly ScenarioForce[]): string[] => table(
    ['Id', 'Designation', 'Type', 'Echelon', 'Parent', 'Location', 'Strength', 'Reported by'],
    forces.map((force) => [force.id, force.designation, force.kind, force.echelon ?? '', designation(force.parent), force.location, force.strength ?? '', reportCitations(force.reportedBy)])
  );
  const forceNotes = (forces: readonly ScenarioForce[]): string[] => forces.flatMap((force) => (force.capabilities.length || force.notes)
    ? [`- **${force.designation}** (${force.id}): ${[...force.capabilities, ...(force.notes ? [force.notes] : [])].join('; ')}`]
    : []);
  const { higher, own } = scenario.mission;

  const readme = [
    `# ${scenario.title}`, '', ...banner,
    scenario.summary, '',
    '## Files', '',
    '- `region.md`: terrain, coast and sea, weather, civil considerations, control measures',
    '- `forces.md`: parties and the order of battle, friendly, adversary and others',
    '- `mission.md`: the higher order, the higher commander\'s intent, your tasks, constraints, assumptions and timeline',
    '- `reports.md`: the report log, with each source grade (reliability A to F, credibility 1 to 6) or `ungraded`',
    '- `sources.md`: where the scenario came from',
    '- `scenario.json`: the scenario as loaded, for tools',
    '',
    'Cite a report by its id and grade, for example `' + (scenario.reports[0] ? citationText(scenario.reports[0]) : 'PR-11 (B2)') + '`. Two reports with the same origin are not independent confirmation.',
    ''
  ];

  const region = [
    `# ${scenario.region.name}`, '', ...banner,
    scenario.region.description, '',
    `Grid: ${scenario.region.grid.kind === 'fictional' ? `fictional grid ${scenario.region.grid.name}; no real coordinates` : `exercise box ${scenario.region.grid.south} to ${scenario.region.grid.north} latitude, ${scenario.region.grid.west} to ${scenario.region.grid.east} longitude`}.`, '',
    ...(scenario.region.frame
      ? [`Map frame: for the map and feed replays the ${scenario.region.frame.grid} grid is placed over empty ocean, far from any land, with northings growing northward. Nothing real is near it.`, '']
      : []),
    '## Terrain, coast and sea', '',
    ...table(['Id', 'Feature', 'Kind', 'Location', 'Description'], scenario.region.features.map((feature) => [feature.id, feature.name, feature.kind, feature.location, feature.description])), '',
    '## Weather', '',
    scenario.region.weather.summary, '',
    ...scenario.region.weather.effects.map((effect) => `- ${effect}`), '',
    '## Civil considerations', '',
    ...(scenario.region.civil.length
      ? table(['Id', 'ASCOPE', 'Name', 'Description'], scenario.region.civil.map((entry) => [entry.id, entry.kind, entry.name, entry.description]))
      : ['None given.']), '',
    '## Control measures', '',
    ...(scenario.controlMeasures.length
      ? table(['Id', 'Kind', 'Name', 'Location', 'Description'], scenario.controlMeasures.map((entry) => [entry.id, entry.kind, entry.name, entry.location, entry.description]))
      : ['None given.']), ''
  ];

  const forces = [
    '# Parties and order of battle', '', ...banner,
    '## Parties', '',
    ...table(['Id', 'Name', 'Side', 'Description'], scenario.parties.map((party) => [party.id, party.name, party.side, party.description])), '',
    ...PARTY_SIDES.flatMap((side) => {
      const entries = forcesOf(side);
      if (!entries.length) return [];
      const title = side === 'friendly' ? 'Friendly forces' : side === 'adversary' ? 'Adversary forces (as reported)' : side === 'host-nation' ? 'Host-nation forces' : side === 'neutral' ? 'Neutral' : 'Unidentified';
      return [`## ${title}`, '', ...forceTable(entries), '', ...forceNotes(entries), ''];
    })
  ];

  const mission = [
    '# Mission', '', ...banner,
    `## Higher: ${higher.headquarters}`, '',
    `Order: ${higher.order}`, '',
    `**Mission.** ${higher.mission}`, '',
    '**Higher commander\'s intent.**', '',
    `- Purpose: ${higher.intent.purpose}`,
    `- Key tasks: ${higher.intent.keyTasks.join('; ')}`,
    `- End state: ${higher.intent.endState}`, '',
    `## Your headquarters: ${own.headquarters}`, '',
    '### Tasks given by higher', '', ...own.tasks.map((task) => `- ${task}`), '',
    '### Constraints (must do)', '', ...(own.constraints.length ? own.constraints.map((entry) => `- ${entry}`) : ['None given.']), '',
    '### Restraints (must not do)', '', ...(own.restraints.length ? own.restraints.map((entry) => `- ${entry}`) : ['None given.']), '',
    '### Assumptions from higher', '', ...(own.assumptions.length ? own.assumptions.map((entry) => `- ${entry.id}: ${entry.text}`) : ['None given.']), '',
    '### Timeline', '', ...(own.timeline.length ? table(['Id', 'When', 'Event'], own.timeline.map((entry) => [entry.id, entry.when, entry.event])) : ['None given.']), ''
  ];

  const reports = [
    '# Report log', '', ...banner,
    'Reliability (A to F) and credibility (1 to 6) are graded separately. `ungraded` means nobody has graded the report yet; grade it before you rely on it.', '',
    ...table(['Id', 'Received', 'Kind', 'Title', 'Grade', 'Origin'], scenario.reports.map((report) => [report.id, report.received, report.kind, report.title, reportGradeText(report), report.origin])), '',
    ...scenario.reports.flatMap((report) => [
      `## ${citationText(report)}: ${report.title}`, '',
      `- Received: ${report.received}`,
      `- Source: ${report.source}`,
      `- Origin: ${report.origin}`,
      `- Grade: ${report.grade ? `${report.grade.reliability} (${SOURCE_RELIABILITY[report.grade.reliability as keyof typeof SOURCE_RELIABILITY]}), ${report.grade.credibility} (${INFORMATION_CREDIBILITY[Number(report.grade.credibility) as keyof typeof INFORMATION_CREDIBILITY]})` : 'ungraded'}`,
      ...(report.about.length ? [`- About: ${report.about.join(', ')}`] : []),
      ...(report.deception ? [`- Deception note: ${report.deception}`] : []),
      '', report.text, ''
    ])
  ];

  const sources = [
    '# Source register', '', ...banner,
    ...(scenario.sourceRegister.length
      ? table(['Id', 'Title', 'Origin', 'Address', 'Accessed', 'Distribution', 'Licence'], scenario.sourceRegister.map((entry) => [
        entry.id, entry.title, entry.origin, entry.address ?? '', entry.accessed ?? '', entry.distribution, entry.licence ?? ''
      ]))
      : ['No sources recorded.']), ''
  ];

  return [
    { path: `${SCENARIO_DIR}/README.md`, content: readme.join('\n') },
    { path: `${SCENARIO_DIR}/region.md`, content: region.join('\n') },
    { path: `${SCENARIO_DIR}/forces.md`, content: forces.join('\n') },
    { path: `${SCENARIO_DIR}/mission.md`, content: mission.join('\n') },
    { path: `${SCENARIO_DIR}/reports.md`, content: reports.join('\n') },
    { path: `${SCENARIO_DIR}/sources.md`, content: sources.join('\n') },
    { path: `${SCENARIO_DIR}/scenario.json`, content: `${JSON.stringify(scenarioJson(scenario), null, 2)}\n` }
  ];
}

/** The scenario as file JSON, in the format `parseScenario` reads back to the same scenario. */
export function scenarioJson(scenario: Scenario): Record<string, unknown> {
  // A scenario without a frame is written as version 1, so a file read from version 1 round trips to version 1.
  return { format: SCENARIO_FORMAT, version: scenario.region.frame ? 2 : 1, fictional: true, ...JSON.parse(JSON.stringify(scenario)) as Record<string, unknown> };
}
