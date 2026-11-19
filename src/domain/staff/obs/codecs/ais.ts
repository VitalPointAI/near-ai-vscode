// The one AIS codec (research note 11, 2.1 and 9.2 item 3; WP-IMP): NMEA 0183 `!xxVDM` and `!xxVDO` sentences, the NMEA checksum, multi-part
// reassembly, the six-bit payload and the message types the staff picture uses: 1, 2 and 3 (Class A position), 5 (Class A static and voyage data), 18
// (Class B position), 19 (Class B extended position, with the name) and 24 (Class B static data, parts A and B). Both the file importer and the
// simulator's own ingest read AIS here. Pure: no I/O, no clock, no vscode.
//
// Field layouts follow the public AIVDM/AIVDO protocol description (E. S. Raymond, gpsd, version 1.58, 2023; note 11 [F11]) after ITU-R M.1371, and
// were cross-checked against the field tables of pyais (MIT; note 11 [F12]), read, not run. No dependency: the JavaScript AIS decoders on npm are small
// single-maintainer packages, and the codec is a few hundred lines that the tests pin field by field.
//
// Hostile input is expected: a sentence with a bad or missing checksum, a payload character outside the armour, a fragment count over 9, a fragment
// that repeats or never arrives. Each is counted and skipped with its reason; nothing is guessed.

/** The NMEA checksum: the XOR of every character between the start character and `*`, as two upper-case hex digits. */
export function nmeaChecksum(body: string): string {
  let sum = 0;
  for (let index = 0; index < body.length; index += 1) sum ^= body.charCodeAt(index);
  return sum.toString(16).toUpperCase().padStart(2, '0');
}

/** Why a sentence or message was not read. */
export const AIS_PROBLEMS = {
  'not-ais': 'The line is not an AIS sentence (!xxVDM or !xxVDO).',
  checksum: 'The sentence\'s NMEA checksum is missing or wrong.',
  'bad-fields': 'The sentence\'s fields are not in the AIVDM form.',
  'bad-payload': 'The payload has a character outside the six-bit armour, or the fill bits are wrong.',
  'incomplete': 'A part of a multi-part message never arrived, or arrived twice before the message was complete.',
  'unsupported-type': 'The message type is not one the importer reads (1, 2, 3, 5, 18, 19 and 24).',
  'too-short': 'The message is shorter than its type needs.',
  'no-position': 'The position report says its position is not available.'
} as const;
export type AisProblem = keyof typeof AIS_PROBLEMS;

/** One checked sentence: its fragment place in its message, and its payload. */
export interface AisSentence {
  readonly talker: string;
  readonly fragments: number;
  readonly fragment: number;
  /** The sequential message id that ties the parts of one message together ('' for a single-part message). */
  readonly sequence: string;
  readonly channel: string;
  readonly payload: string;
  readonly fill: number;
  /** The receive time from an NMEA 4.10 tag block (`c:` unix seconds), when the line carries one. */
  readonly receivedAt?: number;
  /** The sentence as written, without any tag block. */
  readonly raw: string;
}

const SENTENCE = /^!([A-Z]{2})VD([MO]),(.*)\*([0-9A-Fa-f]{2})$/;

/** Reads one line: an optional tag block, then one sentence, checked. */
export function parseAisLine(line: string): { readonly ok: true; readonly sentence: AisSentence } | { readonly ok: false; readonly problem: AisProblem } {
  let text = line.trim();
  let receivedAt: number | undefined;
  if (text.startsWith('\\')) {
    const end = text.indexOf('\\', 1);
    if (end < 0) return { ok: false, problem: 'not-ais' };
    const tag = text.slice(1, end);
    const star = tag.lastIndexOf('*');
    if (star >= 0 && nmeaChecksum(tag.slice(0, star)) === tag.slice(star + 1).toUpperCase()) {
      const time = /(?:^|,)c:(\d{9,13})(?:,|\*|$)/.exec(tag.slice(0, star));
      if (time) { const value = Number(time[1]); receivedAt = time[1].length > 10 ? value : value * 1000; }
    }
    text = text.slice(end + 1);
  }
  if (!text.startsWith('!')) return { ok: false, problem: 'not-ais' };
  const match = SENTENCE.exec(text);
  if (!match) return { ok: false, problem: /^![A-Z]{2}VD[MO],/.test(text) ? 'checksum' : 'not-ais' };
  if (nmeaChecksum(text.slice(1, text.lastIndexOf('*'))) !== match[4].toUpperCase()) return { ok: false, problem: 'checksum' };
  const fields = match[3].split(',');
  if (fields.length !== 6) return { ok: false, problem: 'bad-fields' };
  const [count, number, sequence, channel, payload, fill] = fields;
  if (!/^[1-9]$/.test(count) || !/^[1-9]$/.test(number) || Number(number) > Number(count) || !/^[0-9]?$/.test(sequence) || !/^[A-Z12]?$/.test(channel)) return { ok: false, problem: 'bad-fields' };
  if (!/^[0-5]$/.test(fill) || payload.length === 0 || payload.length > 82) return { ok: false, problem: 'bad-payload' };
  if (!/^[0-9:;<=>?@A-W`a-w]+$/.test(payload)) return { ok: false, problem: 'bad-payload' };
  return {
    ok: true,
    sentence: {
      talker: `${match[1]}VD${match[2]}`, fragments: Number(count), fragment: Number(number), sequence, channel, payload, fill: Number(fill),
      ...(receivedAt !== undefined && Number.isFinite(receivedAt) ? { receivedAt } : {}), raw: text
    }
  };
}

/** A whole message: the payload bits and the sentences it came from, in fragment order. */
export interface AisMessage { readonly bits: readonly number[]; readonly sentences: readonly AisSentence[] }

/** The bits of the armoured payloads, fill bits removed from the last part. Undefined when the fill is longer than the payload. */
export function payloadBits(parts: readonly AisSentence[]): number[] | undefined {
  const bits: number[] = [];
  for (const part of parts) {
    for (const char of part.payload) {
      let value = char.charCodeAt(0) - 48;
      if (value > 40) value -= 8;
      for (let bit = 5; bit >= 0; bit -= 1) bits.push((value >> bit) & 1);
    }
  }
  const fill = parts[parts.length - 1]?.fill ?? 0;
  if (fill > bits.length) return undefined;
  bits.length -= fill;
  return bits;
}

/**
 * Puts multi-part messages back together. Parts may arrive in any order; a message is complete when every part from 1 to its count is there. A part
 * whose place is already filled starts the message again (the earlier, unfinished one is counted incomplete), and whatever is unfinished at the end of
 * the input is incomplete too. At most `maxPending` messages wait at once; past that the oldest is dropped as incomplete.
 */
export class AisAssembler {
  private readonly pending = new Map<string, { parts: Array<AisSentence | undefined>; order: number }>();
  private order = 0;
  incomplete = 0;

  constructor(private readonly maxPending = 1000) {}

  /** Adds a sentence; returns the message it completes, if any. */
  add(sentence: AisSentence): AisMessage | undefined {
    if (sentence.fragments === 1) return this.complete([sentence]);
    const key = `${sentence.talker}|${sentence.channel}|${sentence.sequence}|${sentence.fragments}`;
    let entry = this.pending.get(key);
    if (entry && entry.parts[sentence.fragment - 1] !== undefined) { this.incomplete += 1; this.pending.delete(key); entry = undefined; }
    if (!entry) {
      if (this.pending.size >= this.maxPending) {
        const oldest = [...this.pending.entries()].sort((a, b) => a[1].order - b[1].order)[0];
        this.pending.delete(oldest[0]);
        this.incomplete += 1;
      }
      entry = { parts: new Array<AisSentence | undefined>(sentence.fragments).fill(undefined), order: this.order++ };
      this.pending.set(key, entry);
    }
    entry.parts[sentence.fragment - 1] = sentence;
    if (entry.parts.some((part) => part === undefined)) return undefined;
    this.pending.delete(key);
    return this.complete(entry.parts as AisSentence[]);
  }

  private complete(parts: AisSentence[]): AisMessage | undefined {
    const bits = payloadBits(parts);
    return bits ? { bits, sentences: parts } : undefined;
  }

  /** Ends the input: every message still waiting for a part is incomplete. */
  finish(): void {
    this.incomplete += this.pending.size;
    this.pending.clear();
  }
}

// ---- Fields --------------------------------------------------------------------------------------------------------------------------------

function uint(bits: readonly number[], start: number, width: number): number {
  let value = 0;
  for (let index = start; index < start + width; index += 1) value = value * 2 + (bits[index] ?? 0);
  return value;
}

function int(bits: readonly number[], start: number, width: number): number {
  const value = uint(bits, start, width);
  return bits[start] ? value - 2 ** width : value;
}

const SIX_BIT_TEXT = '@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_ !"#$%&\'()*+,-./0123456789:;<=>?';

/** Six-bit text, with the `@` padding and trailing spaces removed. */
function sixBitText(bits: readonly number[], start: number, chars: number): string {
  let out = '';
  for (let index = 0; index < chars; index += 1) out += SIX_BIT_TEXT[uint(bits, start + index * 6, 6)];
  return out.replace(/@.*$/, '').trim();
}

/** A decoded position report (types 1, 2, 3, 18 and 19). Speed in knots, course and heading in degrees true; absent when not available. */
export interface AisPosition {
  readonly kind: 'position';
  readonly type: number;
  readonly mmsi: number;
  readonly lat: number;
  readonly lon: number;
  readonly speedKnots?: number;
  readonly courseDegrees?: number;
  readonly headingDegrees?: number;
  /** The position accuracy flag: true is better than 10 metres (DGPS), false is worse. */
  readonly highAccuracy: boolean;
  /** Type 19 carries the vessel's name. */
  readonly name?: string;
  readonly shipType?: number;
}

/** A decoded static message (type 5, or 24 part A or B). */
export interface AisStatic {
  readonly kind: 'static';
  readonly type: number;
  readonly mmsi: number;
  readonly name?: string;
  readonly callsign?: string;
  readonly shipType?: number;
  readonly destination?: string;
  readonly imo?: number;
}

export type AisDecoded = AisPosition | AisStatic;

const NO_LON = 181 * 600_000;
const NO_LAT = 91 * 600_000;

/** The minimum message length in bits by type, after the public layouts. Type 24 part A is 160 bits; receivers commonly send 168. */
const MIN_BITS: Readonly<Record<number, number>> = { 1: 168, 2: 168, 3: 168, 5: 420, 18: 168, 19: 312, 24: 160 };

function position(bits: readonly number[], type: number, at: { sog: number; acc: number; lon: number; lat: number; cog: number; hdg: number }): AisPosition | AisProblem {
  const rawLon = int(bits, at.lon, 28);
  const rawLat = int(bits, at.lat, 27);
  if (rawLon === NO_LON || rawLat === NO_LAT) return 'no-position';
  const lon = rawLon / 600_000;
  const lat = rawLat / 600_000;
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return 'no-position';
  const sog = uint(bits, at.sog, 10);
  const cog = uint(bits, at.cog, 12);
  const hdg = uint(bits, at.hdg, 9);
  return {
    kind: 'position', type, mmsi: uint(bits, 8, 30), lat, lon, highAccuracy: bits[at.acc] === 1,
    ...(sog !== 1023 ? { speedKnots: sog / 10 } : {}), ...(cog < 3600 ? { courseDegrees: cog / 10 } : {}), ...(hdg < 360 ? { headingDegrees: hdg } : {})
  };
}

/** Decodes one whole message, or says why not. */
export function decodeAis(message: AisMessage): AisDecoded | AisProblem {
  const bits = message.bits;
  if (bits.length < 38) return 'too-short';
  const type = uint(bits, 0, 6);
  const least = MIN_BITS[type];
  if (least === undefined) return 'unsupported-type';
  if (bits.length < least) return 'too-short';
  const mmsi = uint(bits, 8, 30);
  switch (type) {
    case 1: case 2: case 3:
      return position(bits, type, { sog: 50, acc: 60, lon: 61, lat: 89, cog: 116, hdg: 128 });
    case 18:
      return position(bits, type, { sog: 46, acc: 56, lon: 57, lat: 85, cog: 112, hdg: 124 });
    case 19: {
      const report = position(bits, type, { sog: 46, acc: 56, lon: 57, lat: 85, cog: 112, hdg: 124 });
      if (typeof report === 'string') return report;
      const name = sixBitText(bits, 143, 20);
      return { ...report, ...(name ? { name } : {}), shipType: uint(bits, 263, 8) };
    }
    case 5: {
      const name = sixBitText(bits, 112, 20);
      const callsign = sixBitText(bits, 70, 7);
      const destination = sixBitText(bits, 302, 20);
      const imo = uint(bits, 40, 30);
      return {
        kind: 'static', type, mmsi, ...(name ? { name } : {}), ...(callsign ? { callsign } : {}), shipType: uint(bits, 232, 8),
        ...(destination ? { destination } : {}), ...(imo ? { imo } : {})
      };
    }
    default: {
      // 24: part A (0) is the name; part B (1) the ship type and call sign.
      const part = uint(bits, 38, 2);
      if (part === 0) { const name = sixBitText(bits, 40, 20); return { kind: 'static', type, mmsi, ...(name ? { name } : {}) }; }
      if (part === 1 && bits.length >= 162) {
        const callsign = sixBitText(bits, 90, 7);
        return { kind: 'static', type, mmsi, shipType: uint(bits, 40, 8), ...(callsign ? { callsign } : {}) };
      }
      return 'too-short';
    }
  }
}

/** What reading a whole AIS log gives: the decoded messages in order, each with its sentences, and a count of every problem. */
export interface AisLogRead {
  readonly messages: ReadonlyArray<{ readonly decoded: AisDecoded; readonly sentences: readonly AisSentence[]; readonly line: number }>;
  readonly problems: Partial<Record<AisProblem, number>>;
}

/** Reads a log of sentences, one per line (blank lines and `#` notes skipped), with multi-part reassembly. */
export function readAisLog(text: string, maxMessages = 100_000): AisLogRead {
  const assembler = new AisAssembler();
  const messages: Array<{ decoded: AisDecoded; sentences: readonly AisSentence[]; line: number }> = [];
  const problems: Partial<Record<AisProblem, number>> = {};
  const count = (problem: AisProblem): void => { problems[problem] = (problems[problem] ?? 0) + 1; };
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length && messages.length < maxMessages; index += 1) {
    const line = lines[index].trim();
    if (line === '' || line.startsWith('#')) continue;
    const parsed = parseAisLine(line);
    if (!parsed.ok) { count(parsed.problem); continue; }
    const message = assembler.add(parsed.sentence);
    if (!message) {
      if (parsed.sentence.fragments === 1) count('bad-payload');
      continue;
    }
    const decoded = decodeAis(message);
    if (typeof decoded === 'string') { count(decoded); continue; }
    messages.push({ decoded, sentences: message.sentences, line: index + 1 });
  }
  assembler.finish();
  if (assembler.incomplete) problems.incomplete = (problems.incomplete ?? 0) + assembler.incomplete;
  return { messages, problems };
}
