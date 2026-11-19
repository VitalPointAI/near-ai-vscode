// The format writers for the simulated feeds (research note 11, 8.2; WP-SIM): every byte the simulator puts on a loopback stream is written here and
// nowhere else, in the real public formats, so the importers (WP-IMP) read simulated traffic exactly as they read real traffic. Pure: no I/O, no clock,
// no vscode.
//
// Message shapes (each is also documented on its writer below):
//
// 1. Cursor on Target (CoT) event, XML, one event per line on the CoT TCP stream (MITRE CoT base schema, event version 2.0; note 11 [F1][F58]):
//      <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
//      <event version="2.0" uid="SIM-IRON-LANTERN-f-recce" type="a-f-G-U-C-R" how="m-g" time="..." start="..." stale="..." opex="s-IRON LANTERN">
//        <point lat="-49.1" lon="-123.6" hae="0" ce="10" le="9999999"/>
//        <detail>
//          <contact callsign="RECCE"/>
//          <track course="90.0" speed="4.1"/>                      (moving tracks only; course in degrees true, speed in metres a second)
//          <remarks>EXERCISE SIM. ...</remarks>
//          <link point="lat,lon"/> ...                              (drawn shapes only: an imagery footprint, type u-d-f)
//          <__simulation marking="EXERCISE // SIM // FICTIONAL DATA" scenario="iron-lantern" inject="PR-11"/>
//        </detail>
//      </event>
//    The exercise mark is carried three ways: the schema's own `opex` attribute (`s` is simulation), the `__simulation` detail element, and remarks
//    that start with "EXERCISE SIM.". An unknown error is 9999999, as the schema writes it.
//
// 2. AIS, NMEA 0183 `!AIVDM` sentences, one per line ending CR LF on the AIS TCP stream (ITU-R M.1371; note 11 [F11][F12]): message types 1 (Class A
//    position), 5 (Class A static and voyage data, two sentences), 18 (Class B position) and 24 (Class B static data, parts A and B). Six-bit armoured
//    payload, fill bits, and the NMEA checksum. AIS has no free-text field to mark, so every MMSI is from the fictional range below and the feed itself is
//    a simulated source: every observation from it is marked simulated by its descriptor.
//
// 3. RSS 2.0, one document per fictional outlet, served over loopback HTTP: channel title, link, description, language and lastBuildDate; items with
//    title (always starting "EXERCISE SIM:"), link, guid (isPermaLink="false"), pubDate (RFC 822), category EXERCISE and description. Links point at the
//    reserved `.invalid` domain (RFC 2606), so nothing can follow them off the machine.
//
// 4. Partner report, JSON, the result of the mock partner server's MCP tool (`structuredContent.reports[]`, and the same JSON as text content):
//      { id, discipline, title, scenarioTime, reportedAt, source, origin, grade?: { reliability, credibility }, text, deception?, about[],
//        location?: { lat, lon, ceMetres }, bearings?: [{ fromLat, fromLon, bearingDegrees, station }], marking, simulated: true,
//        handling: ['local-only'], label, partner }
import { COT_IDENTITY_CODES } from '../doctrine';
import type { InformationCredibility, IntelligenceDiscipline, SourceReliability, StandardIdentity } from '../doctrine';

/** The marking every simulated message carries, in whatever field its format has for it. */
export const SIM_MARKING = 'EXERCISE // SIM // FICTIONAL DATA';
/** The badge the feed picture and the COP show on every simulated source and layer, and the statement that goes with it (note 11, 8.3). */
export const SIM_BADGE = 'SIM';
export const SIM_STATEMENT = 'Simulated exercise feed: every report, unit, vessel and place in it is fictional.';
/** What every simulated free-text field starts with. */
export const SIM_TEXT_PREFIX = 'EXERCISE SIM.';
export const SIM_TITLE_PREFIX = 'EXERCISE SIM:';
/** The CoT `uid` prefix of every simulated event. */
export const SIM_UID_PREFIX = 'SIM-';
/** The codec version the writers produce; bumped when any shape changes. */
export const SIM_FORMAT_VERSION = '1.0.0';

// ---- XML ----------------------------------------------------------------------------------------------------------------------------------

/** Escapes text for an XML attribute or element. Control characters other than tab and newline are dropped: XML 1.0 forbids them. */
export function xmlEscape(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** `YYYY-MM-DDTHH:MM:SS.sssZ`, the one time form CoT and the gate both use. */
export function isoTime(millis: number): string {
  return new Date(millis).toISOString();
}

// ---- Cursor on Target --------------------------------------------------------------------------------------------------------------------

/** CoT `how` values the simulator writes (MITRE CoT base schema): machine GPS, human estimated, human transcribed. */
export const COT_HOW = { gps: 'm-g', estimated: 'h-e', transcribed: 'h-t' } as const;
export type CotHow = (typeof COT_HOW)[keyof typeof COT_HOW];
/** CoT writes this for an error it does not know. */
export const COT_UNKNOWN_ERROR = 9_999_999;

export interface CotEventSpec {
  /** Stable per tracked thing, so updates replace each other (CoT `uid`). The writer adds SIM_UID_PREFIX. */
  readonly uid: string;
  /**
   * The CoT type. For an atom (`a-`), the second element must be a standard identity letter and is written from `identity`: pass the type with any
   * letter there, or with `.` (`a-.-G-U-C`).
   */
  readonly type: string;
  readonly identity?: StandardIdentity;
  readonly how: CotHow;
  readonly time: number;
  readonly stale: number;
  readonly lat: number;
  readonly lon: number;
  readonly hae?: number;
  readonly ce: number | null;
  readonly le: number | null;
  readonly callsign: string;
  readonly remarks: string;
  /** Degrees true and metres a second, for moving tracks. */
  readonly course?: number;
  readonly speed?: number;
  /** The vertices of a drawn shape (an imagery footprint), as [lat, lon]. */
  readonly shape?: ReadonlyArray<readonly [number, number]>;
  readonly exercise: string;
  readonly scenario: string;
  readonly inject: string;
}

/** The CoT type with its identity letter set from the standard identity (a table, never inferred; doctrine.ts). */
export function cotType(type: string, identity?: StandardIdentity): string {
  const parts = type.split('-');
  if (parts[0] !== 'a' || parts.length < 3) return type;
  if (identity === undefined) {
    if (!Object.values(COT_IDENTITY_CODES).includes(parts[1])) throw new Error(`CoT type ${type} needs a standard identity`);
    return type;
  }
  parts[1] = COT_IDENTITY_CODES[identity];
  return parts.join('-');
}

function fixed(value: number, places: number): string {
  return Number(value.toFixed(places)).toString();
}

/** One CoT event as XML on a single line (no line breaks inside it), so a stream of events is one event per line. */
export function cotEventXml(spec: CotEventSpec): string {
  if (!(spec.stale > spec.time)) throw new Error('A CoT event must go stale after its time.');
  const error = (value: number | null): string => (value === null ? String(COT_UNKNOWN_ERROR) : fixed(value, 1));
  const remarks = spec.remarks.startsWith(SIM_TEXT_PREFIX) ? spec.remarks : `${SIM_TEXT_PREFIX} ${spec.remarks}`;
  const detail = [
    `<contact callsign="${xmlEscape(spec.callsign)}"/>`,
    spec.course !== undefined && spec.speed !== undefined ? `<track course="${fixed(spec.course, 1)}" speed="${fixed(spec.speed, 2)}"/>` : '',
    `<remarks>${xmlEscape(remarks.replace(/[\r\n]+/g, ' '))}</remarks>`,
    ...(spec.shape ?? []).map(([lat, lon]) => `<link point="${fixed(lat, 7)},${fixed(lon, 7)}"/>`),
    `<__simulation marking="${xmlEscape(SIM_MARKING)}" scenario="${xmlEscape(spec.scenario)}" inject="${xmlEscape(spec.inject)}"/>`
  ].join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<event version="2.0" uid="${xmlEscape(`${SIM_UID_PREFIX}${spec.uid}`)}" type="${xmlEscape(cotType(spec.type, spec.identity))}" how="${spec.how}"`
    + ` time="${isoTime(spec.time)}" start="${isoTime(spec.time)}" stale="${isoTime(spec.stale)}" opex="${xmlEscape(`s-${spec.exercise}`)}">`
    + `<point lat="${fixed(spec.lat, 7)}" lon="${fixed(spec.lon, 7)}" hae="${fixed(spec.hae ?? 0, 1)}" ce="${error(spec.ce)}" le="${error(spec.le)}"/>`
    + `<detail>${detail}</detail></event>`;
}

// ---- AIS (NMEA 0183 !AIVDM) --------------------------------------------------------------------------------------------------------------

/**
 * The fictional MMSI range. Real ship stations are MIDxxxxxx with a maritime identification digit (MID) from 201 to 775 (ITU-R M.585); 199 is below the
 * lowest MID ITU allocates, so no real ship can hold one of these (note 11, 8.3).
 */
export const SIM_MMSI_FIRST = 199_000_001;
export const SIM_MMSI_LAST = 199_000_999;
export function isSimMmsi(mmsi: number): boolean {
  return Number.isSafeInteger(mmsi) && mmsi >= SIM_MMSI_FIRST && mmsi <= SIM_MMSI_LAST;
}

/** AIS navigational status (ITU-R M.1371, message 1). */
export const AIS_NAV_STATUS = { underWayUsingEngine: 0, atAnchor: 1, moored: 5, engagedInFishing: 7 } as const;
/** AIS ship and cargo types the simulator uses (ITU-R M.1371, table 53). */
export const AIS_SHIP_TYPES = { fishing: 30, lawEnforcement: 55, cargo: 70 } as const;

/** The longest payload in one sentence, in six-bit characters; longer messages are split into numbered parts, as receivers write them. */
export const AIS_MAX_PAYLOAD_CHARS = 60;

class BitWriter {
  private readonly bits: number[] = [];
  uint(value: number, width: number): this {
    if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** width) throw new Error(`AIS field ${value} does not fit in ${width} bits`);
    for (let bit = width - 1; bit >= 0; bit -= 1) this.bits.push(Math.floor(value / 2 ** bit) % 2);
    return this;
  }
  int(value: number, width: number): this {
    const limit = 2 ** (width - 1);
    if (!Number.isSafeInteger(value) || value < -limit || value >= limit) throw new Error(`AIS field ${value} does not fit in ${width} signed bits`);
    return this.uint(value < 0 ? value + 2 ** width : value, width);
  }
  /** AIS six-bit text: `@` (0) to `_` (31), then space (32) to `?` (63). Lower case is upper-cased; anything else becomes a space. Padded with `@`. */
  text(value: string, chars: number): this {
    const upper = value.toUpperCase();
    for (let index = 0; index < chars; index += 1) {
      const code = index < upper.length ? upper.charCodeAt(index) : 64;
      const six = code >= 64 && code <= 95 ? code - 64 : code >= 32 && code <= 63 ? code : 32;
      this.uint(six, 6);
    }
    return this;
  }
  get length(): number { return this.bits.length; }
  /** The six-bit armoured payload and the number of fill bits added to make whole characters. */
  armour(): { payload: string; fill: number } {
    const fill = (6 - (this.bits.length % 6)) % 6;
    const bits = [...this.bits, ...new Array<number>(fill).fill(0)];
    let payload = '';
    for (let index = 0; index < bits.length; index += 6) {
      let value = 0;
      for (let bit = 0; bit < 6; bit += 1) value = value * 2 + bits[index + bit];
      const code = value + 48;
      payload += String.fromCharCode(code > 87 ? code + 8 : code);
    }
    return { payload, fill };
  }
}

/** The NMEA checksum: the XOR of every character between `!` and `*`, as two upper-case hex digits. */
export function nmeaChecksum(body: string): string {
  let sum = 0;
  for (let index = 0; index < body.length; index += 1) sum ^= body.charCodeAt(index);
  return sum.toString(16).toUpperCase().padStart(2, '0');
}

/**
 * The `!AIVDM` sentences for one message. A message over AIS_MAX_PAYLOAD_CHARS is split into parts that share a sequential message id (0 to 9); fill bits
 * are on the last part only.
 */
function aivdmSentences(bits: BitWriter, channel: 'A' | 'B', sequenceId: number): string[] {
  const { payload, fill } = bits.armour();
  const parts: string[] = [];
  for (let index = 0; index < payload.length; index += AIS_MAX_PAYLOAD_CHARS) parts.push(payload.slice(index, index + AIS_MAX_PAYLOAD_CHARS));
  return parts.map((part, index) => {
    const last = index === parts.length - 1;
    const body = `AIVDM,${parts.length},${index + 1},${parts.length > 1 ? String(sequenceId % 10) : ''},${channel},${part},${last ? fill : 0}`;
    return `!${body}*${nmeaChecksum(body)}`;
  });
}

/** Longitude and latitude in 1/10000 of a minute, as AIS carries them. */
function aisAngle(degrees: number): number {
  return Math.round(degrees * 600_000);
}

export interface AisPositionSpec {
  readonly mmsi: number;
  readonly lat: number;
  readonly lon: number;
  /** Knots over ground, course and heading in degrees true; the UTC second of the report. */
  readonly speedKnots: number;
  readonly courseDegrees: number;
  readonly headingDegrees: number;
  readonly second: number;
  readonly navStatus?: number;
  readonly channel?: 'A' | 'B';
}

function checkMmsi(mmsi: number): void {
  if (!isSimMmsi(mmsi)) throw new Error(`MMSI ${mmsi} is outside the fictional range ${SIM_MMSI_FIRST} to ${SIM_MMSI_LAST}.`);
}

const sog = (knots: number): number => Math.min(1022, Math.max(0, Math.round(knots * 10)));
const cog = (degrees: number): number => Math.round((((degrees % 360) + 360) % 360) * 10) % 3600;
const hdg = (degrees: number): number => Math.round(((degrees % 360) + 360) % 360) % 360;

/**
 * Message 1, the Class A scheduled position report (168 bits): type, repeat, MMSI, navigational status, rate of turn (not available), speed, accuracy,
 * longitude, latitude, course, heading, second, manoeuvre, spare, RAIM and an SOTDMA radio state (sync UTC direct, slot timeout 0, slot offset 0).
 */
export function aisClassAPosition(spec: AisPositionSpec): string[] {
  checkMmsi(spec.mmsi);
  const bits = new BitWriter()
    .uint(1, 6).uint(0, 2).uint(spec.mmsi, 30).uint(spec.navStatus ?? AIS_NAV_STATUS.underWayUsingEngine, 4).int(-128, 8)
    .uint(sog(spec.speedKnots), 10).uint(1, 1).int(aisAngle(spec.lon), 28).int(aisAngle(spec.lat), 27)
    .uint(cog(spec.courseDegrees), 12).uint(hdg(spec.headingDegrees), 9).uint(spec.second % 60, 6).uint(0, 2).uint(0, 3).uint(0, 1).uint(0, 19);
  return aivdmSentences(bits, spec.channel ?? 'A', 0);
}

/**
 * Message 18, the Class B position report (168 bits): type, repeat, MMSI, reserved, speed, accuracy, longitude, latitude, course, heading, second,
 * regional reserved, then the flags (CS unit, no display, no DSC, whole band, accepts message 22, autonomous mode, no RAIM) and an SOTDMA radio state.
 */
export function aisClassBPosition(spec: AisPositionSpec): string[] {
  checkMmsi(spec.mmsi);
  const bits = new BitWriter()
    .uint(18, 6).uint(0, 2).uint(spec.mmsi, 30).uint(0, 8).uint(sog(spec.speedKnots), 10).uint(0, 1)
    .int(aisAngle(spec.lon), 28).int(aisAngle(spec.lat), 27).uint(cog(spec.courseDegrees), 12).uint(hdg(spec.headingDegrees), 9).uint(spec.second % 60, 6)
    .uint(0, 2).uint(1, 1).uint(0, 1).uint(0, 1).uint(1, 1).uint(1, 1).uint(0, 1).uint(0, 1).uint(0, 20);
  return aivdmSentences(bits, spec.channel ?? 'B', 0);
}

export interface AisStaticSpec {
  readonly mmsi: number;
  readonly name: string;
  readonly callsign: string;
  readonly shipType: number;
  /** Metres from the reference point to bow, stern, port and starboard. */
  readonly dimensions: { readonly bow: number; readonly stern: number; readonly port: number; readonly starboard: number };
  readonly channel?: 'A' | 'B';
  readonly sequenceId?: number;
}

export interface AisVoyageSpec extends AisStaticSpec {
  /** 0 when the vessel has no IMO number. */
  readonly imo: number;
  readonly destination: string;
  readonly draughtMetres: number;
  readonly eta: { readonly month: number; readonly day: number; readonly hour: number; readonly minute: number };
}

/**
 * Message 5, Class A static and voyage data (424 bits, two sentences): type, repeat, MMSI, AIS version, IMO number, call sign (7 characters), name
 * (20), ship type, dimensions, position fix type (GPS), ETA, draught, destination (20), DTE ready, spare.
 */
export function aisClassAStaticVoyage(spec: AisVoyageSpec): string[] {
  checkMmsi(spec.mmsi);
  const { bow, stern, port, starboard } = spec.dimensions;
  const bits = new BitWriter()
    .uint(5, 6).uint(0, 2).uint(spec.mmsi, 30).uint(0, 2).uint(spec.imo, 30).text(spec.callsign, 7).text(spec.name, 20).uint(spec.shipType, 8)
    .uint(bow, 9).uint(stern, 9).uint(port, 6).uint(starboard, 6).uint(1, 4)
    .uint(spec.eta.month, 4).uint(spec.eta.day, 5).uint(spec.eta.hour, 5).uint(spec.eta.minute, 6)
    .uint(Math.min(255, Math.round(spec.draughtMetres * 10)), 8).text(spec.destination, 20).uint(0, 1).uint(0, 1);
  return aivdmSentences(bits, spec.channel ?? 'A', spec.sequenceId ?? 0);
}

/**
 * Message 24, Class B static data, in its two parts. Part A (168 bits): type, repeat, MMSI, part 0, name (20 characters), spare. Part B (168 bits):
 * type, repeat, MMSI, part 1, ship type, vendor id (3 characters), unit model, serial, call sign (7), dimensions, spare.
 */
export function aisClassBStatic(spec: AisStaticSpec): string[] {
  checkMmsi(spec.mmsi);
  const partA = new BitWriter().uint(24, 6).uint(0, 2).uint(spec.mmsi, 30).uint(0, 2).text(spec.name, 20).uint(0, 8);
  const { bow, stern, port, starboard } = spec.dimensions;
  const partB = new BitWriter().uint(24, 6).uint(0, 2).uint(spec.mmsi, 30).uint(1, 2).uint(spec.shipType, 8).text('SIM', 3).uint(0, 4).uint(0, 20)
    .text(spec.callsign, 7).uint(bow, 9).uint(stern, 9).uint(port, 6).uint(starboard, 6).uint(0, 6);
  return [...aivdmSentences(partA, spec.channel ?? 'B', 0), ...aivdmSentences(partB, spec.channel ?? 'B', 0)];
}

// ---- RSS 2.0 ----------------------------------------------------------------------------------------------------------------------------

/** Where simulated items link: the reserved `.invalid` domain (RFC 2606), so a link can never leave the machine. */
export const SIM_LINK_BASE = 'https://exercise.invalid';

export interface RssItemSpec {
  readonly guid: string;
  readonly title: string;
  readonly description: string;
  readonly published: number;
  readonly link: string;
}

export interface RssChannelSpec {
  readonly title: string;
  readonly description: string;
  readonly link: string;
  readonly built: number;
  readonly items: readonly RssItemSpec[];
}

/** RFC 822 date-time as RSS 2.0 writes it (`Wed, 19 May 2027 03:10:00 GMT`). */
export function rfc822(millis: number): string {
  return new Date(millis).toUTCString();
}

/** One RSS 2.0 document. Items are written in the order given (newest first is the convention); every title starts with SIM_TITLE_PREFIX. */
export function rssDocument(spec: RssChannelSpec): string {
  const title = (value: string): string => (value.startsWith(SIM_TITLE_PREFIX) ? value : `${SIM_TITLE_PREFIX} ${value}`);
  const items = spec.items.map((item) => [
    '    <item>',
    `      <title>${xmlEscape(title(item.title))}</title>`,
    `      <link>${xmlEscape(item.link)}</link>`,
    `      <guid isPermaLink="false">${xmlEscape(item.guid)}</guid>`,
    `      <pubDate>${rfc822(item.published)}</pubDate>`,
    '      <category>EXERCISE</category>',
    `      <description>${xmlEscape(`${SIM_TEXT_PREFIX} ${item.description}`)}</description>`,
    '    </item>'
  ].join('\n'));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    '  <channel>',
    `    <title>${xmlEscape(title(spec.title))}</title>`,
    `    <link>${xmlEscape(spec.link)}</link>`,
    `    <description>${xmlEscape(`${SIM_STATEMENT} ${spec.description}`)}</description>`,
    '    <language>en</language>',
    `    <lastBuildDate>${rfc822(spec.built)}</lastBuildDate>`,
    '    <category>EXERCISE</category>',
    ...items,
    '  </channel>',
    '</rss>',
    ''
  ].join('\n');
}

// ---- Partner reports (mock partner MCP server) --------------------------------------------------------------------------------------------

/** The disciplines only a partner holds; the simulator stands in for them with fictional reports (doctrine.ts PARTNER_ONLY_DISCIPLINES). */
export interface PartnerReport {
  readonly id: string;
  readonly discipline: IntelligenceDiscipline;
  readonly title: string;
  /** The scenario's own time form (`D-4 0800`) and the same instant on the exercise calendar. */
  readonly scenarioTime: string;
  readonly reportedAt: string;
  readonly source: string;
  readonly origin: string;
  /** Absent when the report is ungraded; the two grades are always separate. */
  readonly grade?: { readonly reliability: SourceReliability; readonly credibility: InformationCredibility };
  readonly text: string;
  readonly deception?: string;
  readonly about: readonly string[];
  readonly location?: { readonly lat: number; readonly lon: number; readonly ceMetres: number };
  readonly bearings?: ReadonlyArray<{ readonly station: string; readonly fromLat: number; readonly fromLon: number; readonly bearingDegrees: number }>;
  readonly marking: typeof SIM_MARKING;
  readonly simulated: true;
  readonly handling: readonly ['local-only'];
  readonly label: string;
  readonly partner: string;
}

/** The MCP tool result for a list of partner reports: structured content plus the same JSON as text, for clients that read only text. */
export function partnerToolResult(reports: readonly PartnerReport[], note: string): { content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown>; isError: false } {
  const structured = { marking: SIM_MARKING, simulated: true, handling: ['local-only'], note: `${SIM_STATEMENT} ${note}`, reports };
  return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured, isError: false };
}
