// Pure: no I/O.
export const DNS_TYPES = Object.freeze({ PTR: 12, SRV: 33, TXT: 16, A: 1, AAAA: 28 });
export const DNS_CAPS = Object.freeze({
  maxPacketBytes: 9000,
  maxRecordsPerSection: 64,
  maxLabel: 63,
  maxName: 255,
  maxPointerJumps: 16,
  maxTxtStrings: 16,
});
export const DNS_REFUSALS = Object.freeze([
  'too-long', 'truncated', 'bad-pointer', 'pointer-loop', 'label-too-long',
  'name-too-long', 'too-many-records', 'bad-rdata',
] as const);
export type DnsRefusal = (typeof DNS_REFUSALS)[number];
type DnsCaps = { readonly [Key in keyof typeof DNS_CAPS]: number };
type DnsType = keyof typeof DNS_TYPES;

export interface DnsQuestion {
  readonly name: string;
  readonly type: DnsType | number;
  readonly unicastResponse: boolean;
}

interface RecordHeader { readonly name: string; readonly ttl: number }
export type DnsRecord = RecordHeader & (
  | { readonly kind: 'ptr'; readonly target: string }
  | { readonly kind: 'srv'; readonly target: string; readonly port: number; readonly priority: number; readonly weight: number }
  | { readonly kind: 'txt'; readonly strings: readonly string[] }
  | { readonly kind: 'a'; readonly address: string }
  | { readonly kind: 'aaaa'; readonly address: string }
);

export interface DnsMessage {
  readonly id: number;
  readonly flags: number;
  readonly questions: readonly DnsQuestion[];
  readonly answers: readonly DnsRecord[];
  readonly additionals: readonly DnsRecord[];
}

const HEADER_BYTES = 12;
const IN_CLASS = 1;
const UNICAST_BIT = 0x8000;
const CLASS_MASK = 0x7fff;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const TYPE_NAMES = new Map<number, DnsType>(
  (Object.keys(DNS_TYPES) as DnsType[]).map(type => [DNS_TYPES[type], type]),
);

function writeUint16(out: number[], value: number): void {
  out.push(value >>> 8, value & 0xff);
}

function readUint16(bytes: Uint8Array, at: number): number {
  return bytes[at] * 256 + bytes[at + 1];
}

export function encodeQuery(input: { id: number; questions: readonly DnsQuestion[] }): Uint8Array {
  if (!Number.isInteger(input.id) || input.id < 0 || input.id > 0xffff) throw new RangeError('Invalid DNS id');
  if (input.questions.length > DNS_CAPS.maxRecordsPerSection) throw new RangeError('Too many DNS questions');
  const out: number[] = [];
  writeUint16(out, input.id);
  writeUint16(out, 0);
  writeUint16(out, input.questions.length);
  out.push(0, 0, 0, 0, 0, 0);

  for (const question of input.questions) {
    const nameStart = out.length;
    const hostname = question.name.replace(/\.$/, '');
    for (const label of hostname ? hostname.split('.') : []) {
      const bytes = encoder.encode(label);
      if (!bytes.length || bytes.length > DNS_CAPS.maxLabel) throw new RangeError('Invalid DNS label length');
      out.push(bytes.length, ...bytes);
    }
    out.push(0);
    if (out.length - nameStart > DNS_CAPS.maxName) throw new RangeError('DNS name is too long');
    const type = typeof question.type === 'number' ? question.type : DNS_TYPES[question.type];
    if (!Number.isInteger(type) || type < 0 || type > 0xffff) throw new RangeError('Invalid DNS type');
    writeUint16(out, type);
    writeUint16(out, IN_CLASS | (question.unicastResponse ? UNICAST_BIT : 0));
  }
  if (out.length > DNS_CAPS.maxPacketBytes) throw new RangeError('DNS packet is too long');
  return Uint8Array.from(out);
}

type ReadName = { name: string; next: number } | DnsRefusal;

function readName(bytes: Uint8Array, start: number, end: number, caps: DnsCaps): ReadName {
  const labels: string[] = [];
  const visited = new Set<number>();
  let at = start;
  let jumps = 0;
  let next: number | undefined;
  let length = 1; // The root label counts towards the expanded wire length.
  while (at < end) {
    if (visited.has(at)) return 'pointer-loop';
    visited.add(at);
    const size = bytes[at];
    if (size === 0) return length <= caps.maxName ? { name: labels.join('.'), next: next ?? at + 1 } : 'name-too-long';
    if ((size & 0xc0) === 0xc0) {
      if (at + 1 >= end) return 'truncated';
      const target = readUint16(bytes, at) & 0x3fff;
      if (visited.has(target)) return 'pointer-loop';
      if (target < HEADER_BYTES || target >= at) return 'bad-pointer';
      if (++jumps > caps.maxPointerJumps) return 'bad-pointer';
      next ??= at + 2;
      at = target;
      end = bytes.length;
      continue;
    }
    if (size > caps.maxLabel) return 'label-too-long';
    if (at + 1 + size > end) return 'truncated';
    length += 1 + size;
    if (length > caps.maxName) return 'name-too-long';
    // A dot inside a DNS-SD instance label is data, not a label boundary.
    const label = decoder.decode(bytes.subarray(at + 1, at + 1 + size));
    labels.push(label.replace(/[.\\]/g, '\\$&'));
    at += 1 + size;
  }
  return 'truncated';
}

type ReadRecord = { record?: DnsRecord; next: number } | DnsRefusal;

function ipv6Address(bytes: Uint8Array, start: number): string {
  const groups: string[] = [];
  let zeroStart = 0;
  let zeroLength = 0;
  let bestStart = 0;
  let bestLength = 1;
  for (let index = 0; index < 8; index++) {
    const word = readUint16(bytes, start + index * 2);
    groups.push(word.toString(16));
    if (word !== 0) {
      zeroStart = index + 1;
      zeroLength = 0;
    } else if (++zeroLength > bestLength) {
      bestStart = zeroStart;
      bestLength = zeroLength;
    }
  }
  if (bestLength === 1) return groups.join(':');
  return `${groups.slice(0, bestStart).join(':')}::${groups.slice(bestStart + bestLength).join(':')}`;
}

function readRecord(bytes: Uint8Array, at: number, caps: DnsCaps): ReadRecord {
  const owner = readName(bytes, at, bytes.length, caps);
  if (typeof owner === 'string') return owner;
  at = owner.next;
  if (at + 10 > bytes.length) return 'truncated';
  const type = readUint16(bytes, at);
  const rrClass = readUint16(bytes, at + 2) & CLASS_MASK;
  const ttl = readUint16(bytes, at + 4) * 65536 + readUint16(bytes, at + 6);
  const size = readUint16(bytes, at + 8);
  const data = at + 10;
  const next = data + size;
  if (next > bytes.length) return 'bad-rdata';
  if (rrClass !== IN_CLASS) return { next };
  const header = { name: owner.name, ttl };

  switch (type) {
    case DNS_TYPES.PTR:
    case DNS_TYPES.SRV: {
      const isSrv = type === DNS_TYPES.SRV;
      if (size < (isSrv ? 7 : 1)) return 'bad-rdata';
      const target = readName(bytes, data + (isSrv ? 6 : 0), next, caps);
      if (typeof target === 'string') return target === 'truncated' ? 'bad-rdata' : target;
      if (target.next !== next) return 'bad-rdata';
      const record: DnsRecord = isSrv ? {
        ...header, kind: 'srv', target: target.name,
        priority: readUint16(bytes, data), weight: readUint16(bytes, data + 2), port: readUint16(bytes, data + 4),
      } : { ...header, kind: 'ptr', target: target.name };
      return { record, next };
    }
    case DNS_TYPES.A:
      if (size !== 4) return 'bad-rdata';
      return { record: { ...header, kind: 'a', address: bytes.subarray(data, next).join('.') }, next };
    case DNS_TYPES.AAAA:
      if (size !== 16) return 'bad-rdata';
      return { record: { ...header, kind: 'aaaa', address: ipv6Address(bytes, data) }, next };
    case DNS_TYPES.TXT: {
      const strings: string[] = [];
      let cursor = data;
      while (cursor < next) {
        const length = bytes[cursor++];
        if (cursor + length > next || strings.length >= caps.maxTxtStrings) return 'bad-rdata';
        const text = String.fromCharCode(...bytes.subarray(cursor, cursor + length));
        strings.push(text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ''));
        cursor += length;
      }
      return { record: { ...header, kind: 'txt', strings }, next };
    }
    default:
      return { next };
  }
}

type DecodeResult = { ok: true; message: DnsMessage } | { ok: false; reason: DnsRefusal };

export function decodeMessage(bytes: Uint8Array, overrides?: Partial<DnsCaps>): DecodeResult {
  const caps = overrides ? {
    maxPacketBytes: limit('maxPacketBytes', overrides),
    maxRecordsPerSection: limit('maxRecordsPerSection', overrides),
    maxLabel: limit('maxLabel', overrides),
    maxName: limit('maxName', overrides),
    maxPointerJumps: limit('maxPointerJumps', overrides),
    maxTxtStrings: limit('maxTxtStrings', overrides),
  } : DNS_CAPS;
  if (bytes.length > caps.maxPacketBytes) return { ok: false, reason: 'too-long' };
  if (bytes.length < HEADER_BYTES) return { ok: false, reason: 'truncated' };
  const counts = [4, 6, 8, 10].map(offset => readUint16(bytes, offset));
  if (counts.some(count => count > caps.maxRecordsPerSection)) return { ok: false, reason: 'too-many-records' };
  const [questionCount, answerCount, authorityCount, additionalCount] = counts;
  const questions: DnsQuestion[] = [];
  let at = HEADER_BYTES;
  for (let index = 0; index < questionCount; index++) {
    const name = readName(bytes, at, bytes.length, caps);
    if (typeof name === 'string') return { ok: false, reason: name };
    at = name.next;
    if (at + 4 > bytes.length) return { ok: false, reason: 'truncated' };
    const type = readUint16(bytes, at);
    questions.push({ name: name.name, type: TYPE_NAMES.get(type) ?? type, unicastResponse: (readUint16(bytes, at + 2) & UNICAST_BIT) !== 0 });
    at += 4;
  }

  const answers: DnsRecord[] = [];
  const additionals: DnsRecord[] = [];
  for (const [count, records] of [[answerCount, answers], [authorityCount, undefined], [additionalCount, additionals]] as const) {
    for (let index = 0; index < count; index++) {
      const result = readRecord(bytes, at, caps);
      if (typeof result === 'string') return { ok: false, reason: result };
      if (result.record) records?.push(result.record);
      at = result.next;
    }
  }
  return { ok: true, message: { id: readUint16(bytes, 0), flags: readUint16(bytes, 2), questions, answers, additionals } };
}

function limit(key: keyof DnsCaps, overrides: Partial<DnsCaps>): number {
  const value = overrides[key];
  return value !== undefined && Number.isInteger(value) && value >= 0
    ? Math.min(value, DNS_CAPS[key]) : DNS_CAPS[key];
}
