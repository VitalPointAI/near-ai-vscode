// WP-IMP: the feed file importers (research note 11, 9.2 item 3 and 9.3; risks in section 10). Fixtures per format (test/fixtures/feeds, fictional,
// inside the IRON LANTERN frame), hostile inputs, the CoT type to symbol table, the parser process and its time limit, the import feed's lifecycle, the
// geofence and the label clamp, idempotent re-import, and the person-run command.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { STAFF_TEMPLATE_LABELS } from '../domain/staff/doctrine';
import { AisAssembler, decodeAis, nmeaChecksum, parseAisLine, readAisLog } from '../domain/staff/obs/codecs/ais';
import { COT_SIDC_TABLE, cotIdentity, cotPositionMethod, cotSidc, cotSymbol } from '../domain/staff/obs/codecs/cot';
import { readXml } from '../domain/staff/obs/codecs/xml';
import { feedTrackSidc } from '../domain/staff/cop/picture';
import { parseSidc } from '../domain/staff/cop/symbols';
import { parseFeedDescriptor } from '../domain/staff/obs/feeds';
import {
  clampImportLabel, detectFormat, frameArea, importFeed, importFeedSteps, importSummaryText, IMPORT_FORMATS, parseFeedText, planImport, RSS_AREA_ERROR_METRES
} from '../domain/staff/obs/importers';
import type { ImportFormat, ImportPlan, ParsedFeed } from '../domain/staff/obs/importers';
import { parseObservation } from '../domain/staff/obs/observation';
import { FEED_SOURCE_STATES } from '../domain/staff/obs/feeds';
import { parseScenarioText, SCENARIO_DIR } from '../domain/staff/scenario';
import type { ExerciseFrame } from '../domain/staff/obs/frame';
import { aisClassAPosition, aisClassAStaticVoyage, aisClassBPosition } from '../domain/staff/sim/formats';
import { commitImport, prepareImport } from '../staff/feedImport/feedImport';
import { parseFeedFile } from '../staff/feedImport/runner';
import { ObservationStore } from '../staff/observationStore';
import type { PersonActor } from '../domain/staff/release';
import { createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'feeds');
const SCENARIO = path.join(__dirname, '..', '..', 'resources', 'staff', 'scenarios', 'iron-lantern.json');
const PERSON: PersonActor = { kind: 'person', name: 'A. Watch', role: 'J2 watch officer', deviceFingerprint: 'this-window' };
const NOW = Date.parse('2027-05-19T08:00:00.000Z');

async function frame(): Promise<ExerciseFrame> {
  const parsed = parseScenarioText(await readFile(SCENARIO, 'utf8'));
  assert.ok(parsed.ok && parsed.value.region.frame);
  return parsed.value.region.frame;
}

async function fixture(name: string): Promise<string> {
  return readFile(path.join(FIXTURES, name), 'utf8');
}

async function plan(name: string, label = 'org/Internal'): Promise<ImportPlan> {
  const parsed = parseFeedText(await fixture(name));
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  const place = frameArea(await frame());
  return planImport(parsed, { fileName: name, importedAt: NOW, label, area: place.area, centre: place.centre });
}

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-import-'));
  await mkdir(path.join(root, SCENARIO_DIR), { recursive: true });
  await writeFile(path.join(root, SCENARIO_DIR, 'scenario.json'), await readFile(SCENARIO, 'utf8'));
  return root;
}

// ---- The XML reader -----------------------------------------------------------------------------------------------------------------------------

test('the XML reader refuses a document type, entity expansion (billion laughs) and any entity it does not define', () => {
  const laughs = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">'
    + '<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]><rss version="2.0"><channel><item><title>&lol3;</title></item></channel></rss>';
  const read = readXml(laughs);
  assert.ok(!read.ok && read.reason === 'doctype');
  const external = '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><kml><Document>&xxe;</Document></kml>';
  assert.ok(!readXml(external).ok);
  const lowerCase = '<!doctype kml><kml/>';
  assert.equal((readXml(lowerCase) as { reason: string }).reason, 'doctype');
  const undeclared = '<kml><name>&lol;</name></kml>';
  assert.equal((readXml(undeclared) as { reason: string }).reason, 'entity');
  assert.equal((readXml('<kml a="&#0;"/>') as { reason: string }).reason, 'entity', 'a character reference XML forbids');
  assert.equal((readXml('<kml><!ENTITY x "y"></kml>') as { reason: string }).reason, 'doctype');
  // Through the whole importer: a refusal of the file, never a partial read.
  const parsed = parseFeedText(laughs);
  assert.ok(!parsed.ok && /DOCTYPE/.test(parsed.message));
});

test('the XML reader caps depth, element count, attribute count and size, and reads only well-formed XML', () => {
  const deep = `<kml>${'<Folder>'.repeat(200)}${'</Folder>'.repeat(200)}</kml>`;
  assert.equal((readXml(deep) as { reason: string }).reason, 'too-deep');
  const many = `<rss>${'<i/>'.repeat(50)}</rss>`;
  assert.equal((readXml(many, { limits: { maxElements: 20 } }) as { reason: string }).reason, 'too-many');
  const attrs = `<event ${Array.from({ length: 70 }, (_, index) => `a${index}="1"`).join(' ')}/>`;
  assert.equal((readXml(attrs) as { reason: string }).reason, 'too-many');
  assert.equal((readXml('<kml>x</kml>', { limits: { maxBytes: 5 } }) as { reason: string }).reason, 'too-large');
  for (const bad of ['<kml><a></b></kml>', '<kml a="1" a="2"/>', '<kml>', '<kml/><kml/>', 'text<kml/>', '<kml a=1/>']) {
    assert.equal(readXml(bad).ok, false, bad);
  }
  const good = readXml('<?xml version="1.0"?><!-- note --><a x="&lt;&amp;&#x41;&#66;"><b><![CDATA[<raw> & text]]></b></a>');
  assert.ok(good.ok);
  assert.equal(good.root.attrs.x, '<&AB');
  assert.equal(good.root.children[0].text, '<raw> & text');
  const fragments = readXml('<?xml version="1.0"?><event uid="1"/>\n<?xml version="1.0"?><event uid="2"/>', { fragments: true });
  assert.ok(fragments.ok && fragments.root.children.length === 2);
});

// ---- Formats ---------------------------------------------------------------------------------------------------------------------------------

test('format detection reads the content, not the file name', async () => {
  const expected: Record<string, ImportFormat> = {
    'iron-lantern.geojson': 'geojson', 'iron-lantern.kml': 'kml', 'iron-lantern.cot.xml': 'cot', 'iron-lantern.rss': 'rss', 'iron-lantern.atom': 'atom', 'iron-lantern.nmea': 'ais'
  };
  for (const [name, format] of Object.entries(expected)) assert.equal(detectFormat(await fixture(name)), format, name);
  assert.equal(detectFormat('hello'), undefined);
  assert.equal(detectFormat('<html><body/></html>'), undefined);
  const unknown = parseFeedText('<html/>');
  assert.ok(!unknown.ok && /not in a format/.test(unknown.message));
});

test('GeoJSON: points, lines, polygons and multi-part features become rows; malformed coordinates are skipped; outside the frame is held', async () => {
  const result = await plan('iron-lantern.geojson');
  assert.equal(result.format, 'geojson');
  assert.deepEqual(result.rows.map((row) => row.geometry.type).sort(), ['LineString', 'Point', 'Point', 'Point', 'Polygon']);
  assert.equal(result.held['outside-frame'], 1);
  assert.equal(result.problems['bad-geometry'], 3, 'latitude 200, an open ring, and coordinates written as strings');
  assert.equal(result.problems['no-geometry'], 1);
  const named = result.rows.find((row) => row.attributes?.name === 'EXERCISE: dug-in position');
  assert.ok(named);
  assert.equal(named.validAt, '2027-05-19T06:10:00.000Z');
  assert.equal(result.rows.find((row) => row.geometry.type === 'LineString')!.validAt, new Date(NOW).toISOString(), 'no time in the file: valid when imported');
  for (const row of result.rows) {
    assert.ok(parseObservation(row).ok);
    assert.equal(row.simulated, false, 'an imported row is never marked simulated');
    assert.equal(row.knownAt, new Date(NOW).toISOString());
    assert.match(row.source, /^File iron-lantern\.geojson, imported 2027-05-19T08:00:00\.000Z$/);
    assert.deepEqual(row.extractor, { codec: 'import-geojson', version: '1.0.0' });
    assert.equal(row.feed, 'import-geojson');
  }
  assert.ok(!parseFeedText('{ not json').ok || (parseFeedText('{ not json') as Extract<ParsedFeed, { ok: true }>).problems['not-geojson'] === 1);
});

test('KML: placemarks at any depth, time stamps and spans, polygons with holes and multi-geometry parts', async () => {
  const result = await plan('iron-lantern.kml');
  assert.deepEqual(result.rows.map((row) => row.geometry.type).sort(), ['LineString', 'Point', 'Point', 'Point', 'Polygon']);
  assert.equal(result.held['outside-frame'], 1);
  assert.equal(result.problems['bad-geometry'], 1);
  const post = result.rows.find((row) => row.attributes?.name === 'EXERCISE: observation post')!;
  assert.equal(post.validAt, '2027-05-19T05:00:00.000Z');
  assert.equal(post.attributes?.excerpt, 'Fictional observation for the importer tests.', 'HTML in a description is plain text');
  assert.deepEqual(post.geometry.coordinates, [-123.45, -48.97]);
  const route = result.rows.find((row) => row.geometry.type === 'LineString')!;
  assert.equal(route.validUntil, '2027-05-19T07:30:00.000Z');
  const area = result.rows.find((row) => row.geometry.type === 'Polygon')!;
  assert.equal(area.geometry.type === 'Polygon' && area.geometry.coordinates.length, 2, 'outer ring and one hole');
});

test('CoT: events, points and the common detail elements; how, errors, height and identity; footprints as polygons', async () => {
  const result = await plan('iron-lantern.cot.xml');
  assert.equal(result.rows.length, 3);
  assert.equal(result.held['outside-frame'], 1);
  assert.equal(result.problems['missing-fields'], 1, 'an event without a point');
  const hostile = result.rows.find((row) => row.subjectRef === 'EX-HOSTILE-1')!;
  assert.equal(hostile.messageId, 'EX-HOSTILE-1@2027-05-19T06:00:00.000Z');
  assert.equal(hostile.claimedIdentity, 'hostile');
  assert.equal(hostile.observedType, 'a-h-G-U-C-I');
  assert.equal(hostile.how, 'estimated');
  assert.deepEqual(hostile.error, { circularMetres: 250, verticalMetres: null });
  assert.equal(hostile.validUntil, '2027-05-19T07:00:00.000Z');
  assert.equal(hostile.attributes?.name, 'SPOT 7');
  assert.equal(hostile.attributes?.excerpt, 'EXERCISE. Fictional dug-in infantry & two vehicles.');
  assert.equal(hostile.trackId, 'cot:EX-HOSTILE-1');
  const boat = result.rows.find((row) => row.subjectRef === 'EX-PATROL-BOAT')!;
  assert.equal(boat.how, 'gps');
  assert.deepEqual(boat.geometry.coordinates, [-123.3, -48.9, 12.5]);
  assert.deepEqual(boat.error, { circularMetres: 10, verticalMetres: 15 });
  assert.equal(boat.attributes?.courseDegrees, 90);
  assert.equal(boat.attributes?.speedMetresPerSecond, 6.2);
  const footprint = result.rows.find((row) => row.subjectRef === 'EX-FOOTPRINT-1')!;
  assert.equal(footprint.geometry.type, 'Polygon', 'an open shape of four corners is closed into a footprint');
  assert.equal(footprint.trackId, undefined, 'a footprint is not a track');
  assert.equal(cotPositionMethod('m-f'), 'derived');
  assert.equal(cotPositionMethod('h-g-i-g-o'), 'reported');
  assert.equal(cotIdentity('a-n-A'), 'neutral');
  assert.equal(cotIdentity('b-m-p'), undefined);
});

test('RSS 2.0 and Atom: items and entries, GeoRSS positions, and items with no place spread across the frame', async () => {
  const rss = await plan('iron-lantern.rss');
  assert.equal(rss.rows.length, 2);
  const placed = rss.rows.find((row) => row.messageId === 'rss:calder-courier-1')!;
  assert.deepEqual(placed.geometry.coordinates, [-123.42, -48.92]);
  assert.equal(placed.validAt, '2027-05-19T05:30:00.000Z');
  assert.equal(placed.discipline, 'OSINT');
  assert.equal(placed.attributes?.excerpt, 'EXERCISE SIM. Fictional: the harbour master closed the quay.');
  const unplaced = rss.rows.find((row) => row.messageId === 'rss:calder-courier-2')!;
  assert.equal(unplaced.error.circularMetres, RSS_AREA_ERROR_METRES);
  const atom = await plan('iron-lantern.atom');
  assert.deepEqual(atom.rows.map((row) => row.messageId).sort(), ['atom:urn:exercise:peninsula-digest:1', 'atom:urn:exercise:peninsula-digest:2']);
  assert.equal(atom.rows.find((row) => row.messageId.endsWith(':2'))!.attributes?.excerpt, 'EXERCISE SIM. Fictional power cut.');
});

// ---- AIS ---------------------------------------------------------------------------------------------------------------------------------------

test('AIS: types 1, 5, 18, 19 and 24, multi-part reassembly out of order, names applied, bad checksums and missing parts counted', async () => {
  const result = await plan('iron-lantern.nmea');
  const bySubject = new Map(result.rows.map((row) => [row.subjectRef, row]));
  assert.deepEqual([...bySubject.keys()].sort(), ['199000101', '199000202', '199000303', '199000606']);
  const classA = bySubject.get('199000101')!;
  assert.equal(classA.attributes?.name, 'MERIDIAN STAR', 'the name from a two-part type 5 sent out of order');
  assert.deepEqual(classA.geometry.coordinates, [-123.55, -48.95]);
  assert.equal(classA.attributes?.speedMetresPerSecond, 6.33);
  assert.equal(classA.attributes?.courseDegrees, 45);
  assert.equal(classA.attributes?.headingDegrees, 44);
  assert.equal(classA.trackId, 'mmsi:199000101');
  assert.equal(classA.origin, 'Vessel transponders (self-reported)');
  assert.equal(bySubject.get('199000202')!.attributes?.name, 'GULL SPRAY', 'the name from type 24 part A');
  const extended = bySubject.get('199000303')!;
  assert.equal(extended.attributes?.name, 'KESTREL WREN', 'type 19 carries its own name');
  assert.deepEqual(extended.geometry.coordinates, [-123.4, -48.9]);
  assert.equal(bySubject.get('199000606')!.validAt, new Date(1_810_000_000 * 1000).toISOString(), 'the receive time from the tag block (c:, unix seconds)');
  assert.equal(result.problems.checksum, 1);
  assert.equal(result.problems.incomplete, 1);
});

test('AIS: the codec reads back what the writer writes, and refuses what it must', () => {
  const [sentence] = aisClassBPosition({ mmsi: 199000777, lat: -49.123456, lon: -123.654321, speedKnots: 7.5, courseDegrees: 359.9, headingDegrees: 1, second: 59 });
  const line = parseAisLine(sentence);
  assert.ok(line.ok);
  const decoded = decodeAis(new AisAssembler().add(line.sentence)!);
  assert.ok(typeof decoded === 'object' && decoded.kind === 'position');
  assert.equal(decoded.type, 18);
  assert.equal(decoded.mmsi, 199000777);
  assert.ok(Math.abs(decoded.lat + 49.123456) < 1e-5 && Math.abs(decoded.lon + 123.654321) < 1e-5);
  assert.equal(decoded.speedKnots, 7.5);
  assert.equal(decoded.courseDegrees, 359.9);
  // A wrong checksum, a missing one, a payload outside the armour, a fragment number past its count.
  const body = sentence.slice(1, sentence.indexOf('*'));
  assert.deepEqual(parseAisLine(`!${body}*00`.replace('*00', nmeaChecksum(body) === '00' ? '*01' : '*00')), { ok: false, problem: 'checksum' });
  assert.deepEqual(parseAisLine(`!${body}`), { ok: false, problem: 'checksum' });
  const badArmour = body.replace(/,([^,]+),(\d)$/, ',1234X|,$2');
  assert.deepEqual(parseAisLine(`!${badArmour}*${nmeaChecksum(badArmour)}`), { ok: false, problem: 'bad-payload' });
  const badPart = 'AIVDM,2,3,1,A,15M67FC000G?ufbE`FepT@3n00Sa,0';
  assert.deepEqual(parseAisLine(`!${badPart}*${nmeaChecksum(badPart)}`), { ok: false, problem: 'bad-fields' });
  assert.deepEqual(parseAisLine('$GPGGA,123519,4807.038,N'), { ok: false, problem: 'not-ais' });
});

test('AIS: multi-part messages complete in any order; a repeated part restarts the message; parts that never arrive are incomplete', () => {
  const parts = aisClassAStaticVoyage({ mmsi: 199000888, name: 'NIGHT HERON', callsign: 'XSIM8', shipType: 70, dimensions: { bow: 50, stern: 10, port: 5, starboard: 5 }, imo: 0, destination: 'PORT CALDER', draughtMetres: 5, eta: { month: 5, day: 19, hour: 6, minute: 0 }, sequenceId: 4 });
  assert.equal(parts.length, 2);
  for (const order of [[0, 1], [1, 0]]) {
    const log = readAisLog(order.map((index) => parts[index]).join('\n'));
    assert.equal(log.messages.length, 1, `order ${order.join(',')}`);
    const decoded = log.messages[0].decoded;
    assert.ok(decoded.kind === 'static' && decoded.name === 'NIGHT HERON' && decoded.destination === 'PORT CALDER' && decoded.callsign === 'XSIM8');
  }
  // Part 1 twice before part 2: the first message is abandoned, the second completes.
  const repeated = readAisLog([parts[0], parts[0], parts[1]].join('\n'));
  assert.equal(repeated.messages.length, 1);
  assert.equal(repeated.problems.incomplete, 1);
  const missing = readAisLog([parts[1]].join('\n'));
  assert.equal(missing.messages.length, 0);
  assert.equal(missing.problems.incomplete, 1);
  // Positions keep their order and every bad line is counted, none stops the read.
  const position = aisClassAPosition({ mmsi: 199000889, lat: -49, lon: -123.5, speedKnots: 1, courseDegrees: 1, headingDegrees: 1, second: 1 })[0];
  const mixed = readAisLog(['garbage', position, '!AIVDM,1,1,,A,zzz,0*00', position].join('\n'));
  assert.equal(mixed.messages.length, 2);
  assert.equal(mixed.problems['not-ais'], 1);
  assert.equal(mixed.problems.checksum, 1);
});

// ---- CoT type to symbol --------------------------------------------------------------------------------------------------------------------

test('the CoT type to symbol table: every row makes a code the COP draws, the identity letter follows the table, the longest prefix wins', () => {
  const seen = new Set<string>();
  for (const row of COT_SIDC_TABLE) {
    assert.ok(!seen.has(row.cot), `${row.cot} is listed once`);
    seen.add(row.cot);
    for (const identity of ['friend', 'hostile', 'unknown', 'neutral'] as const) {
      const code = cotSidc(`a-x-${row.cot}`, identity);
      assert.ok(code, row.cot);
      const parsed = parseSidc(code);
      assert.ok(parsed.ok, `${row.cot}: ${parsed.ok ? '' : parsed.message}`);
      assert.equal(parsed.value.identity, identity);
      assert.equal(parsed.value.set, row.set);
      assert.equal(parsed.value.entity, row.entity);
    }
  }
  assert.deepEqual(cotSymbol('a-h-G-U-C-I-M'), { set: 'land-unit', entity: '121102' }, 'mechanized infantry, not just infantry');
  assert.deepEqual(cotSymbol('a-h-G-U-C-I-d'), { set: 'land-unit', entity: '121100' }, 'an unknown suffix falls back to the longest known prefix');
  assert.deepEqual(cotSymbol('a-f-S-C-P'), { set: 'sea-surface', entity: '120500' });
  assert.deepEqual(cotSymbol('a-f-A-M-F-Q'), { set: 'air', entity: '110300' });
  assert.equal(cotSymbol('a-h-G-E-V'), undefined, 'a type the table does not hold has no symbol rather than a guessed one');
  assert.equal(cotSymbol('b-m-p-s-p-i'), undefined, 'not an atom');
  assert.equal(cotSidc('a-h-G-U-C-I', 'hostile'), '10061000001211000000');
  // On the COP a feed's affiliation is a claim: friend only on the friendly positions layer, unknown everywhere else.
  assert.equal(feedTrackSidc({ observedType: 'a-h-G-U-C-I', claimedIdentity: 'hostile' }, 'cop-feed-intelligence'), cotSidc('a-h-G-U-C-I', 'unknown'));
  assert.equal(feedTrackSidc({ observedType: 'a-f-S-C-P', claimedIdentity: 'friend' }, 'cop-feed-friendly'), cotSidc('a-f-S-C-P', 'friend'));
  assert.equal(feedTrackSidc({ observedType: 'a-f-S-C-P', claimedIdentity: 'friend' }, 'cop-feed-maritime'), cotSidc('a-f-S-C-P', 'unknown'));
  assert.equal(feedTrackSidc({ observedType: '10031000001211000000' }, 'cop-feed-friendly'), '10031000001211000000');
  assert.equal(feedTrackSidc({}, 'cop-feed-friendly'), undefined);
});

// ---- Planning: geofence, label, descriptors ------------------------------------------------------------------------------------------------

test('the import feeds are valid descriptors: file import, your organization\'s own data, never simulated, never trained on', () => {
  for (const format of IMPORT_FORMATS) {
    const feed = importFeed(format);
    const parsed = parseFeedDescriptor(feed);
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
    assert.deepEqual(parsed.value, feed);
    assert.equal(feed.transport, 'file-import');
    assert.equal(feed.simulated, false);
    assert.equal(feed.trainingRights, 'unknown');
  }
});

test('with no exercise frame every row is held, and nothing outside the frame is ever planned', async () => {
  const parsed = parseFeedText(await fixture('iron-lantern.geojson'));
  assert.ok(parsed.ok);
  const none = planImport(parsed, { fileName: 'x.geojson', importedAt: NOW, label: 'org/Internal' });
  assert.equal(none.rows.length, 0);
  assert.equal(none.held['no-frame'], 6);
  assert.match(importSummaryText(none), /no exercise frame/);
  const rss = parseFeedText(await fixture('iron-lantern.rss'));
  assert.ok(rss.ok);
  assert.equal(planImport(rss, { fileName: 'x.rss', importedAt: NOW, label: 'org/Internal' }).held['no-frame'], 2, 'an item with no place cannot be placed without a frame either');
});

test('the label clamp: raised to the feed\'s label, kept when higher or on another scale, refused above the template ceiling', async () => {
  const feed = importFeed('kml');
  assert.deepEqual(clampImportLabel('org/Public', feed), { ok: true, label: 'org/Internal', raised: true });
  assert.deepEqual(clampImportLabel('org/Internal', feed), { ok: true, label: 'org/Internal', raised: false });
  assert.deepEqual(clampImportLabel('ca-protected/Protected A', feed), { ok: true, label: 'ca-protected/Protected A', raised: false });
  for (const above of ['org/Confidential', 'ca-protected/Protected B', 'nato/NATO Secret', '']) assert.equal(clampImportLabel(above, feed).ok, false, above);
  for (const label of STAFF_TEMPLATE_LABELS) assert.equal(clampImportLabel(label, feed).ok, true, label);
  const result = await plan('iron-lantern.kml', 'nato/NATO Unclassified');
  assert.ok(result.rows.every((row) => row.label === 'nato/NATO Unclassified'));
});

test('the summary a person sees names the count, format, label, time span, what is held and what was skipped', async () => {
  const text = importSummaryText(await plan('iron-lantern.cot.xml'));
  assert.match(text, /^3 observations from iron-lantern\.cot\.xml \(Cursor on Target \(CoT\) XML\), labelled org\/Internal\./);
  assert.match(text, /Seen from 2027-05-19T06:00:00\.000Z to 2027-05-19T06:20:00\.000Z\./);
  assert.match(text, /not as simulated/);
  assert.match(text, /Held, not imported: 1 item\. Its position is outside the exercise frame/);
  assert.match(text, /Skipped: 1 item\. A CoT event lacks its uid, type, time or point\./);
});

test('every state of the import feed has its steps, and a retired feed takes nothing', () => {
  for (const state of [undefined, ...FEED_SOURCE_STATES]) {
    const steps = importFeedSteps(state);
    if (state === 'retired') { assert.equal(steps.ok, false); continue; }
    assert.ok(steps.ok, String(state));
    assert.equal(steps.register, state === undefined);
    assert.equal(steps.before.includes('approve'), state === undefined || state === 'proposed', 'only a feed that is not yet approved is approved, by the person importing');
  }
});

// ---- The parser process ----------------------------------------------------------------------------------------------------------------------

test('the parser runs in its own process: every fixture reads there as it reads in place', async () => {
  for (const name of ['iron-lantern.geojson', 'iron-lantern.kml', 'iron-lantern.cot.xml', 'iron-lantern.rss', 'iron-lantern.atom', 'iron-lantern.nmea']) {
    const there = await parseFeedFile(path.join(FIXTURES, name));
    assert.deepEqual(there, parseFeedText(await fixture(name)), name);
  }
});

test('the parser process refuses hostile files: billion laughs, a file over the size cap (before any process starts), text that is not UTF-8', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-hostile-'));
  const laughs = path.join(dir, 'laughs.kml');
  const levels = Array.from({ length: 10 }, (_, index) => `<!ENTITY l${index + 1} "${`&l${index};`.repeat(10)}">`).join('');
  await writeFile(laughs, `<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY l0 "ha">${levels}]><kml><Document><name>&l10;</name></Document></kml>`);
  const read = await parseFeedFile(laughs);
  assert.ok(!read.ok && /DOCTYPE/.test(read.message));
  const big = path.join(dir, 'big.geojson');
  await writeFile(big, `{"type":"FeatureCollection","features":[${'1,'.repeat(3000)}1]}`);
  const tooBig = await parseFeedFile(big, { limits: { maxBytes: 1000, workerFile: path.join(dir, 'never-started.js') } });
  assert.ok(!tooBig.ok && /larger than/.test(tooBig.message), 'refused by size before the (missing) parser would have started');
  const latin = path.join(dir, 'latin.rss');
  await writeFile(latin, Buffer.from([0x3c, 0x72, 0x73, 0x73, 0x3e, 0xe9, 0x3c, 0x2f, 0x72, 0x73, 0x73, 0x3e]));
  const notUtf8 = await parseFeedFile(latin);
  assert.ok(!notUtf8.ok && /UTF-8/.test(notUtf8.message));
  const deep = path.join(dir, 'deep.geojson');
  await writeFile(deep, `${'['.repeat(200_000)}${']'.repeat(200_000)}`);
  const deepRead = await parseFeedFile(deep);
  assert.ok(deepRead.ok ? deepRead.problems['not-geojson'] === 1 : true, 'deeply nested JSON is refused, never a crash of the host');
});

test('the parser process is killed when it runs past its time limit, and one that runs out of memory is a refusal', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-slow-'));
  const pidFile = path.join(dir, 'pid');
  const hang = path.join(dir, 'hang.js');
  await writeFile(hang, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('message', () => { for (;;) {} });`);
  const input = path.join(dir, 'input.geojson');
  await writeFile(input, '{"type":"FeatureCollection","features":[]}');
  const started = Date.now();
  const result = await parseFeedFile(input, { limits: { timeoutMs: 500, workerFile: hang } });
  assert.ok(!result.ok && /took longer than 1 second,/.test(result.message), result.ok ? '' : result.message);
  assert.ok(Date.now() - started < 10_000);
  const pid = Number(await readFile(pidFile, 'utf8'));
  let alive = true;
  for (let tries = 0; tries < 50 && alive; tries += 1) {
    try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 50)); } catch { alive = false; }
  }
  assert.equal(alive, false, 'the parser process is gone');
  const hog = path.join(dir, 'hog.js');
  await writeFile(hog, 'process.on(\'message\', () => { const keep = []; for (;;) keep.push(new Array(1e6).fill(1)); });');
  const oom = await parseFeedFile(input, { limits: { timeoutMs: 20_000, maxHeapMb: 32, workerFile: hog } });
  assert.ok(!oom.ok && /stopped before it finished/.test(oom.message), oom.ok ? '' : oom.message);
});

// ---- Into the store ----------------------------------------------------------------------------------------------------------------------------

test('an import goes through the store: a new feed is approved by the person, backfilled and caught up; the same file twice adds nothing', async () => {
  const root = await project();
  let now = NOW;
  const store = new ObservationStore({ root, now: () => now });
  const prepared = await prepareImport({ root, file: path.join(FIXTURES, 'iron-lantern.cot.xml'), label: 'org/Public', now });
  assert.ok(prepared.ok);
  assert.equal(prepared.labelRaised, true);
  assert.equal(prepared.plan.label, 'org/Internal');
  const first = await commitImport(store, prepared.plan, PERSON);
  assert.ok(first.ok, first.message);
  assert.equal(first.appended, 3);
  const loaded = await store.load();
  assert.ok(loaded.ok);
  assert.equal(loaded.value.registry.feeds['import-cot'].state, 'live');
  assert.equal(loaded.value.rows.length, 3);
  assert.ok(loaded.value.rows.every((row) => !row.simulated && row.source.includes('iron-lantern.cot.xml')));
  now += 2 * 3600 * 1000;
  const again = await prepareImport({ root, file: path.join(FIXTURES, 'iron-lantern.cot.xml'), label: 'org/Internal', now });
  assert.ok(again.ok);
  const second = await commitImport(store, again.plan, PERSON);
  assert.equal(second.appended, 0);
  assert.equal(second.duplicates, 3);
  const after = await store.load();
  assert.ok(after.ok && after.value.rows.length === 3, 'the same file twice adds nothing');
});

test('a paused import feed resyncs and catches up; a retired one refuses the import and writes nothing', async () => {
  const root = await project();
  const store = new ObservationStore({ root, now: () => NOW });
  const prepared = await prepareImport({ root, file: path.join(FIXTURES, 'iron-lantern.nmea'), label: 'org/Internal', now: NOW });
  assert.ok(prepared.ok);
  assert.ok((await commitImport(store, prepared.plan, PERSON)).ok);
  assert.ok((await store.transitionFeed('import-ais', 'pause', { kind: 'system' })).ok);
  const kml = await prepareImport({ root, file: path.join(FIXTURES, 'iron-lantern.kml'), label: 'org/Internal', now: NOW });
  assert.ok(kml.ok);
  assert.ok((await commitImport(store, kml.plan, PERSON)).ok);
  // Re-importing the AIS log into the paused feed: resync, nothing new, back to live.
  const resumed = await commitImport(store, prepared.plan, PERSON);
  assert.equal(resumed.appended, 0);
  let loaded = await store.load();
  assert.ok(loaded.ok && loaded.value.registry.feeds['import-ais'].state === 'live');
  assert.ok((await store.transitionFeed('import-kml', 'retire', PERSON)).ok);
  const refused = await commitImport(store, kml.plan, PERSON);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /retired/);
  loaded = await store.load();
  assert.ok(loaded.ok && loaded.value.registry.feeds['import-kml'].state === 'retired');
});

test('an agent cannot approve the import feed: the approval step needs a named person', async () => {
  const root = await project();
  const store = new ObservationStore({ root, now: () => NOW });
  const prepared = await prepareImport({ root, file: path.join(FIXTURES, 'iron-lantern.rss'), label: 'org/Internal', now: NOW });
  assert.ok(prepared.ok);
  const result = await commitImport(store, prepared.plan, { kind: 'person', name: '', role: '', deviceFingerprint: '' });
  assert.equal(result.ok, false);
  assert.equal(result.appended, 0);
});

// ---- The person-run command ----------------------------------------------------------------------------------------------------------------

test('Staff: Import Feed File... picks a file, shows what will be imported, and writes only when the person confirms', async () => {
  const stub = createVscodeStub();
  const uninstall = installVscodeStub(stub);
  try {
    const stores = require('../staff/observationStore') as typeof import('../staff/observationStore');
    const command = require('../services/staffImportCommand') as typeof import('../services/staffImportCommand');
    const manifest = JSON.parse(await readFile(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string }> } };
    assert.equal(manifest.contributes.commands.find((entry) => entry.command === command.STAFF_IMPORT_FEED_COMMAND)?.title, 'Staff: Import Feed File...');
    const root = await project();
    stub.setWorkspaceFolders([root]);
    stores.configureObservationStores({ now: () => NOW });
    const state = new Map<string, unknown>();
    const context = { subscriptions: [] as Array<{ dispose(): unknown }>, globalState: { get: <T>(key: string) => state.get(key) as T, update: async (key: string, value: unknown) => { state.set(key, value); } } };
    command.registerStaffImport(context);
    const run = stub.commands.get(command.STAFF_IMPORT_FEED_COMMAND)!;
    const file = path.join(FIXTURES, 'iron-lantern.geojson');

    // Dismissed at the modal: nothing is written.
    stub.openDialogAnswers.push([file]);
    stub.quickPickAnswers.push('org/Internal');
    stub.inputAnswers.push('A. Watch', 'J2 watch officer');
    stub.messageAnswers.push(undefined);
    await run();
    const modal = stub.messageOptions.find((options) => options.modal === true);
    assert.ok(modal && /5 observations from iron-lantern\.geojson \(GeoJSON\), labelled org\/Internal/.test(modal.detail ?? ''), modal?.detail);
    assert.match(modal.detail ?? '', /Nothing is written until you choose Import/);
    let loaded = await stores.observationStoreFor(root)!.load();
    assert.ok(loaded.ok && loaded.value.rows.length === 0);

    // Confirmed: written, under the person who confirmed.
    stub.openDialogAnswers.push([file]);
    stub.quickPickAnswers.push('org/Internal');
    stub.inputAnswers.push('A. Watch', 'J2 watch officer');
    stub.messageAnswers.push('Import');
    await run();
    loaded = await stores.observationStoreFor(root)!.load();
    assert.ok(loaded.ok && loaded.value.rows.length === 5);
    assert.equal(loaded.value.registry.feeds['import-geojson'].state, 'live');
    assert.ok(stub.notifications.some((entry) => /5 observations imported from iron-lantern\.geojson/.test(entry.message)));

    // A dismissed file picker does nothing at all.
    const before = stub.quickPickRequests.length;
    await run();
    assert.equal(stub.quickPickRequests.length, before);
    stores.configureObservationStores(undefined);
  } finally {
    uninstall();
  }
});
