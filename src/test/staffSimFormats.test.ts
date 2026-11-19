// The simulated feed formats (WP-SIM; research note 11, 2 and 8.2): every stream parses as its standard. AIS is read back by an independent decoder,
// first checked against a published reference sentence; CoT and RSS parse as strict XML with the schema's required parts; every message is marked SIM.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aisClassAPosition, aisClassAStaticVoyage, aisClassBPosition, aisClassBStatic, cotEventXml, cotType, isSimMmsi, nmeaChecksum, rssDocument, SIM_MARKING,
  SIM_MMSI_FIRST, SIM_TEXT_PREFIX, SIM_TITLE_PREFIX, SIM_UID_PREFIX, xmlEscape
} from '../domain/staff/sim/formats';
import { child, parseXml } from './simXml';

// ---- An independent AIS decoder (ITU-R M.1371 field layout) ----------------------------------------------------------------------------------

function checkSentence(sentence: string): { total: number; part: number; seq: string; channel: string; payload: string; fill: number } {
  const match = /^!AIVDM,(\d),(\d),(\d?),([AB]),([0-9:;<=>?@A-W`a-w]+),([0-5])\*([0-9A-F]{2})$/.exec(sentence);
  assert.ok(match, `not an AIVDM sentence: ${sentence}`);
  const body = sentence.slice(1, sentence.indexOf('*'));
  let sum = 0;
  for (const ch of body) sum ^= ch.charCodeAt(0);
  assert.equal(sum.toString(16).toUpperCase().padStart(2, '0'), match[7], `bad checksum on ${sentence}`);
  return { total: Number(match[1]), part: Number(match[2]), seq: match[3], channel: match[4], payload: match[5], fill: Number(match[6]) };
}

function bitsOf(sentences: readonly string[]): string {
  const parts = sentences.map(checkSentence);
  parts.forEach((part, index) => { assert.equal(part.part, index + 1); assert.equal(part.total, parts.length); if (index < parts.length - 1) assert.equal(part.fill, 0); });
  if (parts.length > 1) assert.ok(parts.every((part) => part.seq !== '' && part.seq === parts[0].seq), 'multi-part messages share a sequence id');
  let bits = '';
  for (const ch of parts.map((part) => part.payload).join('')) {
    let value = ch.charCodeAt(0) - 48;
    if (value > 40) value -= 8;
    bits += value.toString(2).padStart(6, '0');
  }
  return bits.slice(0, bits.length - parts[parts.length - 1].fill);
}

class Bits {
  at = 0;
  constructor(readonly bits: string) {}
  u(width: number): number { const v = parseInt(this.bits.slice(this.at, this.at + width), 2); this.at += width; return v; }
  i(width: number): number { const v = this.u(width); return v >= 2 ** (width - 1) ? v - 2 ** width : v; }
  t(chars: number): string {
    let out = '';
    for (let n = 0; n < chars; n += 1) { const v = this.u(6); out += String.fromCharCode(v < 32 ? v + 64 : v); }
    return out.replace(/@+$/, '').trimEnd();
  }
}

function decodePosition(sentences: readonly string[]) {
  const b = new Bits(bitsOf(sentences));
  const type = b.u(6);
  if (type >= 1 && type <= 3) {
    assert.equal(b.bits.length, 168);
    b.u(2); const mmsi = b.u(30); const status = b.u(4); const rot = b.i(8); const sog = b.u(10) / 10; b.u(1);
    const lon = b.i(28) / 600000; const lat = b.i(27) / 600000; const cog = b.u(12) / 10; const heading = b.u(9); const second = b.u(6);
    return { type, mmsi, status, rot, sog, lon, lat, cog, heading, second };
  }
  assert.equal(type, 18);
  assert.equal(b.bits.length, 168);
  b.u(2); const mmsi = b.u(30); b.u(8); const sog = b.u(10) / 10; b.u(1);
  const lon = b.i(28) / 600000; const lat = b.i(27) / 600000; const cog = b.u(12) / 10; const heading = b.u(9); const second = b.u(6);
  return { type, mmsi, status: -1, rot: 0, sog, lon, lat, cog, heading, second };
}

test('the AIS test decoder reads the published reference sentence', () => {
  // The worked example of the public AIVDM/AIVDO protocol decoding guide: a moored vessel, MMSI 477553000.
  const decoded = decodePosition(['!AIVDM,1,1,,B,177KQJ5000G?tO`K>RA1wUbN0TKH,0*5C']);
  assert.equal(decoded.type, 1);
  assert.equal(decoded.mmsi, 477553000);
  assert.equal(decoded.status, 5);
  assert.equal(decoded.sog, 0);
  // The guide prints six decimals; the raw value is in 1/10000 minute, so allow a few millionths of a degree.
  assert.ok(Math.abs(decoded.lon - -122.345832) < 3e-6, String(decoded.lon));
  assert.ok(Math.abs(decoded.lat - 47.582833) < 3e-6, String(decoded.lat));
  assert.equal(decoded.cog, 51);
  assert.equal(decoded.heading, 181);
  assert.equal(decoded.second, 15);
});

test('AIS Class A and Class B positions read back field for field', () => {
  const spec = { mmsi: SIM_MMSI_FIRST + 10, lat: -49.0123456, lon: -123.7654321, speedKnots: 12.3, courseDegrees: 271.4, headingDegrees: 271.4, second: 42, navStatus: 0 } as const;
  for (const [write, type] of [[aisClassAPosition, 1], [aisClassBPosition, 18]] as const) {
    const sentences = write(spec);
    assert.equal(sentences.length, 1);
    const decoded = decodePosition(sentences);
    assert.equal(decoded.type, type);
    assert.equal(decoded.mmsi, spec.mmsi);
    assert.equal(decoded.sog, 12.3);
    assert.ok(Math.abs(decoded.lat - spec.lat) < 1 / 600000);
    assert.ok(Math.abs(decoded.lon - spec.lon) < 1 / 600000);
    assert.equal(decoded.cog, 271.4);
    assert.equal(decoded.heading, 271);
    assert.equal(decoded.second, 42);
    if (type === 1) assert.equal(decoded.rot, -128, 'rate of turn: not available');
  }
});

test('AIS message 5 is two sentences of 424 bits and reads back', () => {
  const sentences = aisClassAStaticVoyage({
    mmsi: SIM_MMSI_FIRST, name: 'ORLA', callsign: 'SIMORLA', shipType: 70, dimensions: { bow: 150, stern: 40, port: 16, starboard: 16 }, imo: 0,
    destination: 'PORT CALDER', draughtMetres: 0, eta: { month: 0, day: 0, hour: 24, minute: 60 }, sequenceId: 3
  });
  assert.equal(sentences.length, 2);
  const b = new Bits(bitsOf(sentences));
  assert.equal(b.bits.length, 424);
  assert.equal(b.u(6), 5); b.u(2);
  assert.equal(b.u(30), SIM_MMSI_FIRST); b.u(2);
  assert.equal(b.u(30), 0);
  assert.equal(b.t(7), 'SIMORLA');
  assert.equal(b.t(20), 'ORLA');
  assert.equal(b.u(8), 70);
  assert.deepEqual([b.u(9), b.u(9), b.u(6), b.u(6)], [150, 40, 16, 16]);
  b.u(4);
  assert.deepEqual([b.u(4), b.u(5), b.u(5), b.u(6)], [0, 0, 24, 60]);
  b.u(8);
  assert.equal(b.t(20), 'PORT CALDER');
});

test('AIS message 24 parts A and B read back', () => {
  const sentences = aisClassBStatic({ mmsi: SIM_MMSI_FIRST + 20, name: 'SALTMERE 7', callsign: 'SIMFV07', shipType: 30, dimensions: { bow: 9, stern: 3, port: 2, starboard: 2 } });
  assert.equal(sentences.length, 2);
  const a = new Bits(bitsOf([sentences[0]]));
  assert.equal(a.bits.length, 168);
  assert.equal(a.u(6), 24); a.u(2); assert.equal(a.u(30), SIM_MMSI_FIRST + 20); assert.equal(a.u(2), 0); assert.equal(a.t(20), 'SALTMERE 7');
  const b = new Bits(bitsOf([sentences[1]]));
  assert.equal(b.bits.length, 168);
  assert.equal(b.u(6), 24); b.u(2); b.u(30); assert.equal(b.u(2), 1); assert.equal(b.u(8), 30); assert.equal(b.t(3), 'SIM'); b.u(4); b.u(20);
  assert.equal(b.t(7), 'SIMFV07');
});

test('AIS refuses an MMSI outside the fictional range, which no real ship station can hold', () => {
  assert.ok(isSimMmsi(SIM_MMSI_FIRST));
  assert.ok(!isSimMmsi(477553000));
  assert.ok(Math.floor(SIM_MMSI_FIRST / 1_000_000) < 201, 'the range sits below the lowest allocated maritime identification digits');
  assert.throws(() => aisClassAPosition({ mmsi: 477553000, lat: 0, lon: 0, speedKnots: 0, courseDegrees: 0, headingDegrees: 0, second: 0 }), /fictional range/);
  assert.equal(nmeaChecksum('AIVDM,1,1,,B,177KQJ5000G?tO`K>RA1wUbN0TKH,0'), '5C');
});

test('a CoT event is one line of strict XML with the schema\'s parts, marked as a simulation three ways', () => {
  const xml = cotEventXml({
    uid: 'IRON-LANTERN-x', type: 'a-.-G-U-C-I', identity: 'hostile', how: 'h-e', time: Date.UTC(2027, 4, 18, 5, 40), stale: Date.UTC(2027, 4, 18, 17, 40),
    lat: -49.03, lon: -123.46, ce: 707.1, le: null, callsign: 'RECCE <PATROL> & "co"', remarks: 'Fort\'s exit\nmined', course: 90, speed: 1.5,
    exercise: 'IRON LANTERN', scenario: 'iron-lantern', inject: 'PR-11'
  });
  assert.ok(!xml.includes('\n'));
  const event = parseXml(xml);
  assert.equal(event.name, 'event');
  assert.equal(event.attrs.version, '2.0');
  assert.equal(event.attrs.type, 'a-h-G-U-C-I');
  assert.ok(event.attrs.uid.startsWith(SIM_UID_PREFIX));
  assert.equal(event.attrs.opex, 's-IRON LANTERN');
  for (const key of ['time', 'start', 'stale']) assert.match(event.attrs[key], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const point = child(event, 'point')!;
  assert.deepEqual(Object.keys(point.attrs).sort(), ['ce', 'hae', 'lat', 'le', 'lon']);
  assert.equal(point.attrs.le, '9999999');
  const detail = child(event, 'detail')!;
  assert.equal(child(detail, 'contact')!.attrs.callsign, 'RECCE <PATROL> & "co"');
  assert.ok(child(detail, 'remarks')!.text.startsWith(SIM_TEXT_PREFIX));
  assert.equal(child(detail, '__simulation')!.attrs.marking, SIM_MARKING);
  assert.deepEqual(child(detail, 'track')!.attrs, { course: '90', speed: '1.5' });
  assert.throws(() => cotEventXml({ uid: 'x', type: 'a-f-G', how: 'm-g', time: 10, stale: 10, lat: 0, lon: 0, ce: 1, le: 1, callsign: 'x', remarks: 'x', exercise: 'x', scenario: 'x', inject: 'x' }), /stale/);
  assert.equal(cotType('a-.-S', 'unknown'), 'a-u-S');
  assert.equal(cotType('u-d-f'), 'u-d-f');
  assert.throws(() => cotType('a-.-G'), /standard identity/);
  assert.equal(xmlEscape('a\u0001b<'), 'ab&lt;');
});

test('an RSS document is strict RSS 2.0 XML, every title marked, every link on the reserved .invalid domain', () => {
  const doc = rssDocument({
    title: 'Calder Courier', description: 'Fictional local newspaper.', link: 'https://exercise.invalid/iron-lantern/calder-courier', built: Date.UTC(2027, 4, 19, 21, 30),
    items: [{ guid: 'iron-lantern:OS-03', title: 'Armour moved to Harrow Ridge & more', description: 'It adds <no> new detail.', published: Date.UTC(2027, 4, 19, 21, 30), link: 'https://exercise.invalid/iron-lantern/calder-courier/OS-03' }]
  });
  const rss = parseXml(doc);
  assert.equal(rss.name, 'rss');
  assert.equal(rss.attrs.version, '2.0');
  const channel = child(rss, 'channel')!;
  for (const part of ['title', 'link', 'description']) assert.ok(child(channel, part), `channel ${part}`);
  assert.ok(child(channel, 'title')!.text.startsWith(SIM_TITLE_PREFIX));
  const items = channel.children.filter((entry) => entry.name === 'item');
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(child(item, 'title')!.text, `${SIM_TITLE_PREFIX} Armour moved to Harrow Ridge & more`);
  assert.equal(child(item, 'guid')!.attrs.isPermaLink, 'false');
  assert.equal(Date.parse(child(item, 'pubDate')!.text), Date.UTC(2027, 4, 19, 21, 30));
  assert.match(child(item, 'pubDate')!.text, /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
  assert.equal(new URL(child(item, 'link')!.text).hostname, 'exercise.invalid');
  assert.equal(child(item, 'category')!.text, 'EXERCISE');
});
