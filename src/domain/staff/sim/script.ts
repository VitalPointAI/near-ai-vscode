// The inject script (research note 11, 8.2; WP-SIM): a JSONL file beside the scenario that says which stream carries which scenario item, when, and
// where on the fictional grid. Report text, grades and origins are read from the scenario itself, so the script never repeats them; the few injects the
// scenario does not hold (the partner-only MASINT and CI reports, fictional news items, and the J2 demo's mid-demo report) carry their own text here.
// Pure: no I/O, no clock, no vscode.
//
// One JSON object a line. Blank lines and lines starting `//` are skipped. Kinds:
//   exercise  { kind, name, dDay }                          the exercise name for CoT `opex` and the calendar date of D-day 0000 (UTC)
//   window    { kind, from, to }                             the scenario times the timeline runs between
//   outlet    { kind, id, title, description }               a fictional RSS outlet (an RSS channel of the feed)
//   partner   { kind, id, title }                            the fictional partner the mock MCP server stands in for
//   track     { kind, id, stream: cot, subject?, report?, identity, type, callsign, channel, from, to, everyMinutes, route[], speedKph?, loop? }
//   vessel    { kind, id, stream: ais, subject?, class: A|B, mmsi, name, callsign, shipType, navStatus?, from, to, everyMinutes, route[], speedKnots?,
//               destination?, dimensions }
//   spot      { kind, id, stream: cot, report?, demoInject?, at?, identity, type, callsign, channel, places[], staleMinutes? }
//   footprint { kind, id, stream: cot, report, at?, channel, corners[] }
//   item      { kind, id, stream: rss, report? | (at, title, text), outlet }
//   partner-report { kind, id, discipline, report? | (at, title, text, source, origin, grade?, about[], deception?), place?, bearings? }
//   marker    { kind, id, at, beat, hold? }                  a J2 demo beat starts here; `hold` pauses the simulation after it
import { PARTNER_ONLY_DISCIPLINES, SOURCE_RELIABILITY_GRADES, STANDARD_IDENTITIES } from '../doctrine';
import type { InformationCredibility, IntelligenceDiscipline, SourceReliability, StandardIdentity } from '../doctrine';
import { gridReferencesIn, insideFrame, parseGridReference } from '../obs/frame';
import type { ExerciseFrame, GridReference } from '../obs/frame';
import type { Scenario } from '../scenario';
import { AIS_NAV_STATUS, AIS_SHIP_TYPES, isSimMmsi } from './formats';

export const SIM_STREAMS = ['cot-own', 'cot-intel', 'ais', 'rss', 'partner'] as const;
export type SimStream = (typeof SIM_STREAMS)[number];

export const SCRIPT_MAX_LINES = 500;
export const SCRIPT_MAX_TEXT = 2000;

export interface ScriptExercise { readonly name: string; readonly dDay: string }
export interface ScriptOutlet { readonly id: string; readonly title: string; readonly description: string }
export interface ScriptPartner { readonly id: string; readonly title: string }

interface InjectBase { readonly id: string; readonly line: number }
export interface TrackInject extends InjectBase {
  readonly kind: 'track'; readonly stream: 'cot-own' | 'cot-intel'; readonly channel: string; readonly subject?: string; readonly report?: string;
  readonly identity: StandardIdentity; readonly type: string; readonly callsign: string; readonly from: number; readonly to: number;
  readonly everyMinutes: number; readonly route: readonly GridReference[]; readonly speedKph: number; readonly loop: boolean
}
export interface VesselInject extends InjectBase {
  readonly kind: 'vessel'; readonly subject?: string; readonly vesselClass: 'A' | 'B'; readonly mmsi: number; readonly name: string; readonly callsign: string;
  readonly shipType: keyof typeof AIS_SHIP_TYPES; readonly navStatus: keyof typeof AIS_NAV_STATUS; readonly from: number; readonly to: number;
  readonly everyMinutes: number; readonly route: readonly GridReference[]; readonly speedKnots: number; readonly destination: string;
  readonly dimensions: { readonly bow: number; readonly stern: number; readonly port: number; readonly starboard: number }
}
export interface SpotInject extends InjectBase {
  readonly kind: 'spot'; readonly stream: 'cot-own' | 'cot-intel'; readonly channel: string; readonly report?: string; readonly demoInject: boolean;
  readonly at: number; readonly identity: StandardIdentity; readonly type: string; readonly callsign: string; readonly places: readonly GridReference[];
  readonly staleMinutes: number
}
export interface FootprintInject extends InjectBase {
  readonly kind: 'footprint'; readonly channel: string; readonly report: string; readonly at: number; readonly corners: readonly GridReference[]
}
export interface ItemInject extends InjectBase {
  readonly kind: 'item'; readonly outlet: string; readonly report?: string; readonly at: number; readonly title: string; readonly text: string
}
export interface PartnerReportInject extends InjectBase {
  readonly kind: 'partner-report'; readonly discipline: IntelligenceDiscipline; readonly report?: string; readonly at: number; readonly title: string;
  readonly text: string; readonly source: string; readonly origin: string;
  readonly grade?: { readonly reliability: SourceReliability; readonly credibility: InformationCredibility };
  readonly about: readonly string[]; readonly deception?: string; readonly place?: GridReference;
  readonly bearings: ReadonlyArray<{ readonly station: string; readonly from: GridReference; readonly toward: GridReference }>
}
export interface MarkerInject extends InjectBase { readonly kind: 'marker'; readonly at: number; readonly beat: number; readonly hold: boolean }

export type Inject = TrackInject | VesselInject | SpotInject | FootprintInject | ItemInject | PartnerReportInject | MarkerInject;

export interface InjectScript {
  readonly exercise: ScriptExercise;
  /** Minutes from D-day 0000. */
  readonly window: { readonly from: number; readonly to: number };
  readonly outlets: readonly ScriptOutlet[];
  readonly partner: ScriptPartner;
  readonly injects: readonly Inject[];
}

export type ScriptParsed = { readonly ok: true; readonly value: InjectScript } | { readonly ok: false; readonly line: number; readonly message: string };

class ScriptError extends Error {
  constructor(readonly line: number, message: string) { super(message); }
}

// ---- Scenario time ------------------------------------------------------------------------------------------------------------------------

const SCENARIO_TIME = /^D(?:([+-])(\d{1,2}))? ([01]\d|2[0-3])([0-5]\d)$/;

/** Minutes from D-day 0000 for a scenario time (`D-6 0540`, `D 1200`, `D+2 0600`), or undefined. */
export function parseScenarioTime(text: string): number | undefined {
  const match = SCENARIO_TIME.exec(text);
  if (!match) return undefined;
  const days = match[1] === undefined ? 0 : Number(match[2]) * (match[1] === '-' ? -1 : 1);
  return days * 1440 + Number(match[3]) * 60 + Number(match[4]);
}

/** The scenario time for minutes from D-day 0000 (`D-6 0540`). */
export function formatScenarioTime(minutes: number): string {
  const whole = Math.floor(minutes);
  const day = Math.floor(whole / 1440);
  const inDay = whole - day * 1440;
  const hhmm = `${String(Math.floor(inDay / 60)).padStart(2, '0')}${String(inDay % 60).padStart(2, '0')}`;
  return `D${day === 0 ? '' : day > 0 ? `+${day}` : String(day)} ${hhmm}`;
}

// ---- Reading -------------------------------------------------------------------------------------------------------------------------------

type Raw = Readonly<Record<string, unknown>>;
const ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,47}$/;
const CHANNEL = /^[a-z0-9][a-z0-9-]{0,47}$/;
const COT_TYPE = /^[a-z](?:-[A-Za-z.]){1,9}$/;
const D_DAY = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/;

/**
 * Reads an inject script and checks it against the scenario: every report and subject it names is in the scenario, every place is a grid reference on
 * the scenario's grid inside its exercise frame, every MMSI is in the fictional range and used once, partner-only disciplines arrive only on the partner
 * stream, and the first problem is the refusal, with its line number.
 */
export function parseInjectScript(text: string, scenario: Scenario): ScriptParsed {
  try {
    return { ok: true, value: readScript(text, scenario) };
  } catch (error) {
    if (error instanceof ScriptError) return { ok: false, line: error.line, message: error.message };
    throw error;
  }
}

function readScript(text: string, scenario: Scenario): InjectScript {
  const frame = scenario.region.frame;
  if (!frame) throw new ScriptError(0, 'The scenario has no exercise frame, so its places cannot be put on the globe.');
  const reportIds = new Set(scenario.reports.map((report) => report.id));
  const subjectIds = new Set([...scenario.forces.map((force) => force.id), ...scenario.controlMeasures.map((m) => m.id), ...scenario.region.features.map((f) => f.id), ...scenario.region.civil.map((c) => c.id)]);
  let exercise: ScriptExercise | undefined;
  let window: { from: number; to: number } | undefined;
  let partner: ScriptPartner | undefined;
  const outlets: ScriptOutlet[] = [];
  const injects: Inject[] = [];
  const ids = new Set<string>();
  const mmsis = new Set<number>();
  const lines = text.split('\n');
  if (lines.length > SCRIPT_MAX_LINES) throw new ScriptError(SCRIPT_MAX_LINES, `An inject script has at most ${SCRIPT_MAX_LINES} lines.`);

  lines.forEach((source, index) => {
    const line = index + 1;
    const trimmed = source.trim();
    if (trimmed === '' || trimmed.startsWith('//')) return;
    let value: unknown;
    try { value = JSON.parse(trimmed); } catch { throw new ScriptError(line, 'Not a JSON object.'); }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ScriptError(line, 'Not a JSON object.');
    const raw = value as Raw;
    const r = new Reader(raw, line, frame, scenario.region.grid.kind === 'fictional' ? scenario.region.grid.name : '');
    const kind = r.str('kind', 40);
    if (kind === 'exercise') {
      const dDay = r.str('dDay', 40);
      if (!D_DAY.test(dDay) || Number.isNaN(Date.parse(dDay))) throw new ScriptError(line, 'dDay must be a UTC midnight, YYYY-MM-DDT00:00:00.000Z.');
      exercise = { name: r.str('name', 40), dDay };
      return;
    }
    if (kind === 'window') {
      window = { from: r.time('from'), to: r.time('to') };
      if (window.to <= window.from) throw new ScriptError(line, 'The window must end after it starts.');
      return;
    }
    if (kind === 'outlet') { outlets.push({ id: r.channel('id'), title: r.str('title', 120), description: r.str('description', 300) }); return; }
    if (kind === 'partner') { partner = { id: r.channel('id'), title: r.str('title', 120) }; return; }

    const id = r.id('id');
    if (ids.has(id)) throw new ScriptError(line, `Inject id ${id} is used twice.`);
    ids.add(id);
    const report = r.optional('report', () => {
      const ref = r.str('report', 48);
      if (!reportIds.has(ref)) throw new ScriptError(line, `Report ${ref} is not in the scenario.`);
      return ref;
    });
    const subject = r.optional('subject', () => {
      const ref = r.str('subject', 48);
      if (!subjectIds.has(ref)) throw new ScriptError(line, `Subject ${ref} is not in the scenario.`);
      return ref;
    });
    const reportOf = report === undefined ? undefined : scenario.reports.find((entry) => entry.id === report);
    const at = (): number => {
      if (raw.at !== undefined) return r.time('at');
      if (reportOf) {
        const received = parseScenarioTime(reportOf.received);
        if (received === undefined) throw new ScriptError(line, `Report ${reportOf.id} has no scenario time.`);
        return received;
      }
      throw new ScriptError(line, 'An inject needs `at` or a `report`.');
    };
    switch (kind) {
      case 'track': {
        const from = r.time('from'); const to = r.time('to');
        if (to <= from) throw new ScriptError(line, 'A track must end after it starts.');
        injects.push({
          kind, id, line, stream: r.cotStream(), channel: r.channel('channel'), ...(subject ? { subject } : {}), ...(report ? { report } : {}),
          identity: r.identity(), type: r.cotType(), callsign: r.str('callsign', 40), from, to, everyMinutes: r.int('everyMinutes', 1, 720),
          route: r.places('route', 1, 50), speedKph: r.optional('speedKph', () => r.num('speedKph', 0, 200)) ?? 0, loop: r.optional('loop', () => r.bool('loop')) ?? false
        });
        return;
      }
      case 'vessel': {
        const from = r.time('from'); const to = r.time('to');
        if (to <= from) throw new ScriptError(line, 'A vessel track must end after it starts.');
        const mmsi = r.int('mmsi', 0, 999_999_999);
        if (!isSimMmsi(mmsi)) throw new ScriptError(line, `MMSI ${mmsi} is outside the fictional range.`);
        if (mmsis.has(mmsi)) throw new ScriptError(line, `MMSI ${mmsi} is used twice.`);
        mmsis.add(mmsi);
        const vesselClass = r.choice('class', ['A', 'B'] as const);
        const dims = r.object('dimensions');
        const dim = (key: string, max: number): number => {
          const v = dims[key];
          if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > max) throw new ScriptError(line, `dimensions.${key} must be a whole number from 0 to ${max}.`);
          return v;
        };
        injects.push({
          kind, id, line, ...(subject ? { subject } : {}), vesselClass, mmsi, name: r.aisText('name', 20), callsign: r.aisText('callsign', 7),
          shipType: r.choice('shipType', Object.keys(AIS_SHIP_TYPES) as Array<keyof typeof AIS_SHIP_TYPES>),
          navStatus: r.optional('navStatus', () => r.choice('navStatus', Object.keys(AIS_NAV_STATUS) as Array<keyof typeof AIS_NAV_STATUS>)) ?? 'underWayUsingEngine',
          from, to, everyMinutes: r.int('everyMinutes', 1, 720), route: r.places('route', 1, 50),
          speedKnots: r.optional('speedKnots', () => r.num('speedKnots', 0, 60)) ?? 0,
          destination: r.optional('destination', () => r.aisText('destination', 20)) ?? '',
          dimensions: { bow: dim('bow', 511), stern: dim('stern', 511), port: dim('port', 63), starboard: dim('starboard', 63) }
        });
        return;
      }
      case 'spot': {
        const demoInject = r.optional('demoInject', () => r.bool('demoInject')) ?? false;
        if (demoInject && raw.at === undefined) throw new ScriptError(line, 'A demo inject needs its own `at`.');
        injects.push({
          kind, id, line, stream: r.cotStream(), channel: r.channel('channel'), ...(report ? { report } : {}), demoInject, at: at(), identity: r.identity(),
          type: r.cotType(), callsign: r.str('callsign', 40), places: r.places('places', 1, 20), staleMinutes: r.optional('staleMinutes', () => r.int('staleMinutes', 1, 10_080)) ?? 360
        });
        return;
      }
      case 'footprint': {
        if (!report) throw new ScriptError(line, 'A footprint names the imagery report it covers.');
        injects.push({ kind, id, line, channel: r.channel('channel'), report, at: at(), corners: r.places('corners', 3, 20) });
        return;
      }
      case 'item': {
        const outlet = r.channel('outlet');
        if (!outlets.some((entry) => entry.id === outlet)) throw new ScriptError(line, `Outlet ${outlet} is not declared above.`);
        injects.push({
          kind, id, line, outlet, ...(report ? { report } : {}), at: at(),
          title: reportOf && raw.title === undefined ? reportOf.title : r.str('title', 200),
          text: reportOf && raw.text === undefined ? reportOf.text : r.str('text', SCRIPT_MAX_TEXT)
        });
        return;
      }
      case 'partner-report': {
        const discipline = r.choice('discipline', PARTNER_ONLY_DISCIPLINES);
        const own = (key: string, max: number): string => r.str(key, max);
        const gradeRaw = reportOf ? reportOf.grade : raw.grade === undefined ? undefined : r.object('grade');
        let grade: PartnerReportInject['grade'];
        if (gradeRaw) {
          const reliability = (gradeRaw as Raw).reliability;
          const credibility = Number((gradeRaw as Raw).credibility);
          if (typeof reliability !== 'string' || !(SOURCE_RELIABILITY_GRADES as readonly string[]).includes(reliability) || !Number.isInteger(credibility) || credibility < 1 || credibility > 6) {
            throw new ScriptError(line, 'A grade is a reliability letter A to F and a credibility number 1 to 6, kept separate.');
          }
          grade = { reliability: reliability as SourceReliability, credibility: credibility as InformationCredibility };
        }
        const place = r.optional('place', () => r.places('place', 1, 1)[0]);
        const bearings = r.optional('bearings', () => r.list('bearings', 20).map((entry, n) => {
          const b = new Reader(entry as Raw, line, frame, r.gridName, `bearings[${n}].`);
          return { station: b.str('station', 40), from: b.places('from', 1, 1)[0], toward: b.places('toward', 1, 1)[0] };
        })) ?? [];
        const about = reportOf ? reportOf.about : r.list('about', 20).map((item) => {
          if (typeof item !== 'string' || !subjectIds.has(item)) throw new ScriptError(line, `about: ${String(item)} is not in the scenario.`);
          return item;
        });
        const deception = reportOf ? reportOf.deception : r.optional('deception', () => own('deception', 500));
        injects.push({
          kind, id, line, discipline, ...(report ? { report } : {}), at: at(),
          title: reportOf ? reportOf.title : own('title', 200), text: reportOf ? reportOf.text : own('text', SCRIPT_MAX_TEXT),
          source: reportOf ? reportOf.source : own('source', 300), origin: reportOf ? reportOf.origin : own('origin', 300),
          ...(grade ? { grade } : {}), about, ...(deception ? { deception } : {}), ...(place ? { place } : {}), bearings
        });
        return;
      }
      case 'marker':
        injects.push({ kind, id, line, at: r.time('at'), beat: r.int('beat', 1, 20), hold: r.optional('hold', () => r.bool('hold')) ?? false });
        return;
      default:
        throw new ScriptError(line, `Unknown kind ${kind}.`);
    }
  });
  if (!exercise) throw new ScriptError(0, 'The script has no exercise line.');
  if (!window) throw new ScriptError(0, 'The script has no window line.');
  if (!partner) throw new ScriptError(0, 'The script has no partner line.');
  for (const inject of injects) {
    const times = inject.kind === 'track' || inject.kind === 'vessel' ? [inject.from, inject.to] : [inject.at];
    if (times.some((t) => t < window!.from || t > window!.to)) throw new ScriptError(inject.line, `${inject.id} falls outside the script's window.`);
  }
  return { exercise, window, outlets, partner, injects };
}

class Reader {
  constructor(private readonly raw: Raw, private readonly line: number, private readonly frame: ExerciseFrame, readonly gridName: string, private readonly prefix = '') {}
  private get(key: string): unknown {
    if (!Object.prototype.hasOwnProperty.call(this.raw, key)) throw new ScriptError(this.line, `${this.prefix}${key} is missing.`);
    return this.raw[key];
  }
  optional<T>(key: string, read: () => T): T | undefined {
    return Object.prototype.hasOwnProperty.call(this.raw, key) ? read() : undefined;
  }
  str(key: string, max: number): string {
    const v = this.get(key);
    // eslint-disable-next-line no-control-regex
    if (typeof v !== 'string' || v.trim() === '' || v.length > max || /[\u0000-\u001f\u007f]/.test(v)) throw new ScriptError(this.line, `${this.prefix}${key} must be text of at most ${max} characters.`);
    return v;
  }
  id(key: string): string {
    const v = this.str(key, 48);
    if (!ID.test(v)) throw new ScriptError(this.line, `${this.prefix}${key} must be letters, digits and dashes.`);
    return v;
  }
  channel(key: string): string {
    const v = this.str(key, 48);
    if (!CHANNEL.test(v)) throw new ScriptError(this.line, `${this.prefix}${key} must be lower-case letters, digits and dashes.`);
    return v;
  }
  aisText(key: string, max: number): string {
    const v = this.str(key, max);
    if (!/^[A-Z0-9 .,'/-]+$/.test(v)) throw new ScriptError(this.line, `${this.prefix}${key} must be AIS text: capitals, digits and a few marks.`);
    return v;
  }
  num(key: string, min: number, max: number): number {
    const v = this.get(key);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new ScriptError(this.line, `${this.prefix}${key} must be a number from ${min} to ${max}.`);
    return v;
  }
  int(key: string, min: number, max: number): number {
    const v = this.num(key, min, max);
    if (!Number.isSafeInteger(v)) throw new ScriptError(this.line, `${this.prefix}${key} must be a whole number.`);
    return v;
  }
  bool(key: string): boolean {
    const v = this.get(key);
    if (typeof v !== 'boolean') throw new ScriptError(this.line, `${this.prefix}${key} must be true or false.`);
    return v;
  }
  choice<T extends string>(key: string, choices: readonly T[]): T {
    const v = this.get(key);
    if (typeof v !== 'string' || !(choices as readonly string[]).includes(v)) throw new ScriptError(this.line, `${this.prefix}${key} must be one of ${choices.join(', ')}.`);
    return v as T;
  }
  object(key: string): Raw {
    const v = this.get(key);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new ScriptError(this.line, `${this.prefix}${key} must be an object.`);
    return v as Raw;
  }
  list(key: string, max: number): unknown[] {
    const v = this.get(key);
    if (!Array.isArray(v) || v.length > max) throw new ScriptError(this.line, `${this.prefix}${key} must be a list of at most ${max}.`);
    return v;
  }
  time(key: string): number {
    const v = this.str(key, 20);
    const minutes = parseScenarioTime(v);
    if (minutes === undefined) throw new ScriptError(this.line, `${this.prefix}${key} must be a scenario time such as D-5 0310.`);
    return minutes;
  }
  identity(): StandardIdentity { return this.choice('identity', STANDARD_IDENTITIES); }
  cotType(): string {
    const v = this.str('type', 40);
    if (!COT_TYPE.test(v)) throw new ScriptError(this.line, `${this.prefix}type must be a CoT type such as a-.-G-U-C.`);
    return v;
  }
  cotStream(): 'cot-own' | 'cot-intel' { return this.choice('stream', ['cot-own', 'cot-intel'] as const); }
  /** Grid references on the scenario's grid, each inside the exercise frame. */
  places(key: string, least: number, most: number): GridReference[] {
    const v = this.get(key);
    const items = Array.isArray(v) ? v : [v];
    if (items.length < least || items.length > most) throw new ScriptError(this.line, `${this.prefix}${key} must hold ${least} to ${most} grid references.`);
    return items.map((item) => {
      const reference = typeof item === 'string' ? parseGridReference(item, this.gridName, this.frame.squareMetres) : undefined;
      if (!reference || gridReferencesIn(String(item), this.gridName, this.frame.squareMetres).length !== 1) throw new ScriptError(this.line, `${this.prefix}${key}: ${String(item)} is not a grid reference on ${this.gridName}.`);
      const far = { eastingMetres: reference.eastingMetres + reference.precisionMetres, northingMetres: reference.northingMetres + reference.precisionMetres };
      if (!insideFrame(this.frame, reference) || !insideFrame(this.frame, far)) throw new ScriptError(this.line, `${this.prefix}${key}: ${String(item)} is outside the exercise frame.`);
      return reference;
    });
  }
}
