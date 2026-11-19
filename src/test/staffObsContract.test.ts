// The drop 2 feed contract (research note 11; WP-OBS0): the observation row and its integrity, feed and channel descriptors with their licence and
// label defaults, the source lifecycle, tracks and decay, COP feed layer ownership, slices clamped to the reader, standing watches that only draft,
// the feed events and the agent tool list.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { STAFF_EVENT_TYPES } from '../domain/staff/events';
import { SHARED_PRODUCTS } from '../domain/staff/ownership';
import type { PersonActor } from '../domain/staff/release';
import {
  ALL_STAFF_EVENT_TYPES, buildTrack, catalogueSource, channelHandling, channelLabel, checkWatchOutput, cutNote, decayState, echelonOf, enabledByDefault,
  FEED_CATALOGUE, FEED_CLASS_POLICIES, FEED_EVENT_TYPES, FEED_LAYERS, FEED_SOURCE_EVENTS, FEED_SOURCE_STATES, FEED_SOURCE_TRANSITIONS, feedDecay,
  feedLayerSettingsOwner, feedPicture, feedSourceTransition, gridToWgs84, isDuplicateMatch, alertMode, joinTemplateLabels, layersFor, LICENCE_CLASS_RULES,
  LICENCE_CLASSES, mayChangeFeedLayerSettings, mayEnable, mayWriteFeedLayerFeatures, OBS_FAILURES, OBS_TOOL_MANIFEST, OBS_TOOL_NAMES, OBS_TOOLS,
  OBSERVATION_FIELDS, OBSERVATION_V06_COLUMNS, observationId, observationLine, parseFeedDescriptor, parseObservation, parseSegmentLines,
  parseSliceQuery, parseWatch, segmentId, sliceObservations, toV06Row, TRACK_EVENTS, TRACK_STATES, trackTransition, WATCH_FORBIDDEN_ACTIONS,
  WATCH_OUTPUTS, watchTransition
} from '../domain/staff';
import type {
  ExerciseFrame, FeedDescriptor, FeedEvent, Observation, ObsFailure, ObsParsed, SliceContext, SliceQuery, StandingWatch, WatchContext
} from '../domain/staff';

// ---- Fixtures -------------------------------------------------------------------------------------------------------------------------------

const PERSON: PersonActor = { kind: 'person', name: 'A. Demo', role: 'J2 watch officer', deviceFingerprint: 'dev-0123456789abcdef' };
const AGENT = { kind: 'agent', member: 'watch-officer' } as const;
const SYSTEM = { kind: 'system' } as const;

const FRAME: ExerciseFrame = {
  kind: 'empty-ocean', grid: 'KQ', squareMetres: 1000, origin: { latitude: -49.326327, longitude: -124.077038 }, extent: { eastings: 100, northings: 100 },
  axis: 'northings-increase-north'
};
const at = (e: number, n: number): [number, number] => {
  const point = gridToWgs84(FRAME, { eastingMetres: e * 1000 + 500, northingMetres: n * 1000 + 500 });
  return [point.longitude, point.latitude];
};

let messageCounter = 0;
/** A valid row; `over` replaces fields, and the id and segment follow the feed, channel, message and known time unless `over` sets them. */
function row(over: Record<string, unknown> = {}): Record<string, any> {
  messageCounter += 1;
  const feed = (over.feed as string) ?? 'iron-cot';
  const channel = (over.channel as string) ?? 'recce-net';
  const messageId = (over.messageId as string) ?? `msg-${messageCounter}`;
  const knownAt = (over.knownAt as string) ?? '2026-11-18T05:45:00.000Z';
  return {
    schema: 1, obsId: observationId(feed, channel, messageId), messageId, segment: segmentId(feed, channel, knownAt), feed, channel, discipline: 'GEOINT',
    validAt: '2026-11-18T05:40:00.000Z', knownAt, geometry: { type: 'Point', coordinates: at(45, 32) }, error: { circularMetres: 707.1, verticalMetres: null },
    how: 'reported', subjectRef: 'RECCE-1', source: 'RECCE squadron foot patrol', origin: 'Direct observation by the RECCE patrol', reliability: 'B', credibility: 2,
    deceptionNote: 'none seen', label: 'org/Internal', handling: [], extractor: { codec: 'cot', version: '1.0.0' }, simulated: true, about: ['e-1-41'],
    ...over
  };
}
function obs(over: Record<string, unknown> = {}): Observation {
  const parsed = parseObservation(row(over));
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  return parsed.value;
}
function refused<T>(parsed: ObsParsed<T>, reason: ObsFailure, pathText?: string): void {
  assert.equal(parsed.ok, false, 'expected a refusal');
  if (parsed.ok) return;
  assert.equal(parsed.reason, reason, parsed.message);
  if (pathText !== undefined) assert.equal(parsed.path, pathText);
  assert.ok(parsed.message.startsWith(OBS_FAILURES[reason]));
}

function feed(over: Record<string, unknown> = {}): Record<string, any> {
  return {
    id: 'iron-cot', title: 'IRON LANTERN CoT replay', category: 'intelligence', feedClass: 'events', format: 'cot', transport: 'loopback', licenceClass: 'simulated',
    trainingRights: 'no', simulated: true, channels: [{ id: 'recce-net', title: 'RECCE net', discipline: 'GEOINT' }], ...over
  };
}
function descriptor(over: Record<string, unknown> = {}): FeedDescriptor {
  const parsed = parseFeedDescriptor(feed(over));
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  return parsed.value;
}

// ---- The observation row ------------------------------------------------------------------------------------------------------------------

test('an observation row parses, writes one canonical line, reads back the same, and maps every field to a v0.6.0 column', () => {
  const value = obs({ validUntil: '2026-11-18T06:00:00.000Z', trackId: 'cot:RECCE-1', claimedIdentity: 'hostile', observedType: 'a-h-G-U-C', attributes: { speedMetresPerSecond: 3, excerpt: 'Digging in.' } });
  const line = observationLine(value);
  const back = parseSegmentLines(`${line}\n\n${line}\n`);
  assert.ok(back.ok);
  if (back.ok) assert.deepEqual(back.value, [value, value]);
  assert.equal(observationLine(JSON.parse(line) as Observation), line, 'one row always writes the same bytes');
  for (const key of OBSERVATION_FIELDS) assert.ok(OBSERVATION_V06_COLUMNS[key], key);
  const v06 = toV06Row(value);
  assert.equal(v06['observation.label_id'], 'org/Internal');
  assert.equal(v06['observation.obs_id'], value.obsId);
  assert.equal(Object.keys(v06).length, Object.keys(JSON.parse(line)).length);
});

test('integrity: the id is the hash of feed, channel and message, so re-delivery is one row, and the segment is feed, channel and hour', () => {
  assert.equal(observationId('ais', 'north', 'm1'), observationId('ais', 'north', 'm1'));
  assert.notEqual(observationId('ais', 'north', 'm1'), observationId('ais', 'south', 'm1'));
  assert.match(observationId('ais', 'north', 'm1'), /^obs-[0-9a-f]{64}$/);
  assert.equal(segmentId('ais', 'north', '2026-11-18T14:59:59.999Z'), 'ais/north/2026-11-18T14');
  refused(parseObservation(row({ obsId: observationId('other', 'recce-net', 'x') })), 'integrity', 'obsId');
  refused(parseObservation(row({ segment: 'iron-cot/recce-net/2026-11-18T06' })), 'integrity', 'segment');
  const original = obs();
  refused(parseObservation(row({ messageId: original.messageId, supersedes: original.obsId })), 'self-supersede', 'supersedes');
});

test('the row refuses combined grades, labels above the ceiling, bad times, bad geometry and unknown fields', () => {
  refused(parseObservation(row({ reliability: 'B2' })), 'grades-separate', 'reliability');
  refused(parseObservation(row({ credibility: 'B2' })), 'grades-separate', 'credibility');
  refused(parseObservation({ ...row(), grade: 'B2' }), 'grades-separate', 'grade');
  refused(parseObservation(row({ reliability: 'b' })), 'unknown-value', 'reliability');
  refused(parseObservation(row({ credibility: '2' })), 'unknown-value', 'credibility');
  refused(parseObservation(row({ label: 'org/Confidential' })), 'label-ceiling', 'label');
  refused(parseObservation(row({ label: 'nato/NATO Secret' })), 'label-ceiling', 'label');
  refused(parseObservation(row({ validAt: '2026-11-18T05:40:00Z' })), 'bad-time', 'validAt');
  refused(parseObservation(row({ validUntil: '2026-11-18T05:00:00.000Z' })), 'time-order', 'validUntil');
  refused(parseObservation(row({ geometry: { type: 'Point', coordinates: [0, 91] } })), 'bad-geometry');
  refused(parseObservation(row({ geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] } })), 'bad-geometry');
  refused(parseObservation(row({ geometry: { type: 'LineString', coordinates: [[0, 0]] } })), 'bad-geometry');
  refused(parseObservation(row({ error: { circularMetres: -1, verticalMetres: null } })), 'out-of-range');
  refused(parseObservation(row({ assessedIdentity: 'hostile' })), 'unknown-field', 'assessedIdentity');
  refused(parseObservation(JSON.parse(`{"__proto__": {"x": 1}, ${JSON.stringify(row()).slice(1)}`)), 'unknown-field');
  refused(parseObservation(row({ claimedIdentity: 'enemy' })), 'unknown-value', 'claimedIdentity');
  refused(parseObservation(row({ extractor: { codec: 'cot', version: 'latest' } })), 'wrong-type', 'extractor.version');
  const bad = parseSegmentLines(`${observationLine(obs())}\nnot json\n`);
  refused(bad, 'wrong-type', 'line[2]');
  const polygon = obs({ geometry: { type: 'Polygon', coordinates: [[at(45, 30), at(47, 30), at(47, 32), at(45, 30)]] } });
  assert.equal(polygon.geometry.type, 'Polygon');
});

test('partner-only disciplines enter only as simulations routed local-only', () => {
  refused(parseObservation(row({ discipline: 'HUMINT', simulated: false, handling: ['local-only'] })), 'partner-simulation-only', 'discipline');
  refused(parseObservation(row({ discipline: 'SIGINT', simulated: true, handling: [] })), 'local-only', 'handling');
  assert.ok(parseObservation(row({ discipline: 'SIGINT', simulated: true, handling: ['local-only'] })).ok);
  assert.ok(parseObservation(row({ discipline: null, simulated: false })).ok, 'an own-force position has no discipline');
});

test('derived labels join to the highest input, and labels on different scales do not join', () => {
  assert.equal(joinTemplateLabels(['org/Public', 'org/Internal', 'org/Public']), 'org/Internal');
  assert.equal(joinTemplateLabels(['org/Public', 'nato/NATO Unclassified']), undefined);
  assert.equal(joinTemplateLabels([]), undefined);
});

// ---- Feeds, licences and defaults -------------------------------------------------------------------------------------------------------

test('label defaults: every licence class has a default inside the template ceiling, and a channel inherits the feed label', () => {
  assert.equal(LICENCE_CLASS_RULES.open.defaultLabel, 'org/Public');
  assert.equal(LICENCE_CLASS_RULES['organization-own'].defaultLabel, 'org/Internal');
  assert.equal(LICENCE_CLASS_RULES['restricted-terms'].defaultLabel, 'org/Internal');
  assert.equal(LICENCE_CLASS_RULES['partner-only'].defaultLabel, 'org/Internal');
  const simulated = descriptor();
  assert.equal(channelLabel(simulated, simulated.channels[0]), 'org/Internal');
  const open = descriptor({ licenceClass: 'open', simulated: false, transport: 'file-import', trainingRights: 'unknown', catalogue: 'natural-earth', category: 'environment', feedClass: 'static', format: 'geopackage', channels: [{ id: 'coast', title: 'Coastline', discipline: null }] });
  assert.equal(channelLabel(open, open.channels[0]), 'org/Public');
  const raised = descriptor({ label: 'org/Internal', channels: [{ id: 'a', title: 'A', discipline: 'OSINT', label: 'nato/NATO Unclassified' }] });
  assert.equal(channelLabel(raised, raised.channels[0]), 'nato/NATO Unclassified');
  assert.equal(simulated.channels[0].reliability, 'F', 'a channel nobody graded is F, cannot be judged');
  assert.equal(simulated.channels[0].credibility, 6, 'a new observation starts at 6, cannot be judged');
  refused(parseFeedDescriptor(feed({ label: 'org/Confidential' })), 'label-ceiling', 'label');
  refused(parseFeedDescriptor(feed({ licenceClass: 'restricted-terms', simulated: false, transport: 'file-import', label: 'org/Public' })), 'label-too-low', 'label');
  refused(parseFeedDescriptor(feed({ label: 'org/Internal', channels: [{ id: 'a', title: 'A', discipline: 'OSINT', label: 'org/Public' }] })), 'label-too-low', 'channels[0].label');
  refused(parseFeedDescriptor(feed({ channels: [{ id: 'a', title: 'A', discipline: 'OSINT', reliability: 'B', credibility: 'B2' }] })), 'grades-separate', 'channels[0].credibility');
});

test('licence defaults: ACLED and social media are restricted, off by default, never for training, and on only with a licence record', () => {
  for (const id of ['acled', 'social-media']) {
    const source = catalogueSource(id);
    assert.equal(source?.licenceClass, 'restricted-terms', id);
    const restricted = descriptor({ id, catalogue: id, licenceClass: 'restricted-terms', simulated: false, transport: 'outside', format: id === 'acled' ? 'geojson' : 'rss', channels: [{ id: 'all', title: 'All', discipline: 'OSINT' }] });
    assert.equal(enabledByDefault(restricted), false, `${id} is off by default`);
    assert.deepEqual(mayEnable(restricted, PERSON), { ok: false, reason: 'licence-restricted' });
    assert.deepEqual(mayEnable({ ...restricted, licenceRecord: 'Licence 2026-14 covers knowledge-base use' }, PERSON), { ok: true });
    refused(parseFeedDescriptor(feed({ catalogue: id, licenceClass: 'open', simulated: false, transport: 'outside', trainingRights: 'unknown' })), 'licence-restricted', 'licenceClass');
    refused(parseFeedDescriptor(feed({ catalogue: id, licenceClass: 'restricted-terms', simulated: false, transport: 'outside', trainingRights: 'unknown' })), 'licence-restricted', 'trainingRights');
  }
  for (const entry of FEED_CATALOGUE) assert.ok(entry.evidence.startsWith('note 11 ['), entry.id);
  assert.equal(LICENCE_CLASS_RULES['restricted-terms'].trainingAllowed, false);
  assert.equal(LICENCE_CLASS_RULES['partner-only'].trainingAllowed, false);
  refused(parseFeedDescriptor(feed({ catalogue: 'no-such-source' })), 'unknown-value', 'catalogue');
});

test('on by default: simulated and local open feeds are on; outside connections, partner feeds and restricted sources are off; a member cannot turn one on', () => {
  assert.equal(enabledByDefault(descriptor()), true, 'a simulated loopback feed');
  const openImport = descriptor({ licenceClass: 'open', simulated: false, transport: 'file-import', trainingRights: 'unknown', catalogue: 'gdelt', format: 'gdelt-events' });
  assert.equal(enabledByDefault(openImport), true, 'an open file import');
  assert.equal(enabledByDefault({ ...openImport, transport: 'outside' }), false, 'a live outside connection reveals the area of interest');
  const partner = descriptor({ licenceClass: 'partner-only', simulated: false, transport: 'partner', channels: [{ id: 'imagery', title: 'Partner imagery', discipline: 'GEOINT' }] });
  assert.equal(enabledByDefault(partner), false);
  assert.deepEqual(mayEnable(partner, PERSON), { ok: false, reason: 'partner-simulation-only' });
  assert.deepEqual(mayEnable(descriptor(), AGENT), { ok: false, reason: 'not-a-person' });
  refused(parseFeedDescriptor(feed({ licenceClass: 'partner-only', simulated: false, transport: 'outside' })), 'local-only', 'transport');
  refused(parseFeedDescriptor(feed({ licenceClass: 'organization-own', simulated: false, channels: [{ id: 'hum', title: 'Walk-ins', discipline: 'HUMINT' }] })), 'partner-simulation-only', 'channels[0].discipline');
  refused(parseFeedDescriptor(feed({ licenceClass: 'simulated', simulated: false })), 'unknown-value', 'simulated');
  const humint = descriptor({ channels: [{ id: 'fr', title: 'Partner HUMINT simulation', discipline: 'HUMINT' }] });
  assert.deepEqual(channelHandling(humint, humint.channels[0]), ['local-only']);
  assert.deepEqual(channelHandling(descriptor(), descriptor().channels[0]), []);
});

test('feed classes set decay and load policy; a descriptor may set its own decay, never with lost before stale', () => {
  assert.deepEqual(feedDecay(descriptor({ feedClass: 'positions' })), FEED_CLASS_POLICIES.positions.decay);
  assert.equal(feedDecay(descriptor({ feedClass: 'static' })), null);
  assert.deepEqual(feedDecay(descriptor({ decay: { staleAfterSeconds: 30, lostAfterSeconds: 300 } })), { staleAfterSeconds: 30, lostAfterSeconds: 300 });
  refused(parseFeedDescriptor(feed({ decay: { staleAfterSeconds: 300, lostAfterSeconds: 30 } })), 'time-order', 'decay.lostAfterSeconds');
  refused(parseFeedDescriptor(feed({ channels: [{ id: 'a', title: 'A', discipline: null }, { id: 'a', title: 'B', discipline: null }] })), 'duplicate-entry', 'channels[1].id');
  refused(parseFeedDescriptor(feed({ channels: [] })), 'missing-field', 'channels');
  assert.equal(FEED_CLASS_POLICIES.reports.never, 'Drop a report.');
  assert.ok(LICENCE_CLASSES.every((entry) => LICENCE_CLASS_RULES[entry]));
});

test('the source lifecycle: live-only streams go straight to live, history backfills first, only a person approves or retires', () => {
  const ok = (result: ReturnType<typeof feedSourceTransition>) => (result.ok ? result.to : result.reason);
  assert.equal(ok(feedSourceTransition('proposed', 'approve', PERSON, false)), 'approved');
  assert.equal(ok(feedSourceTransition('proposed', 'approve', SYSTEM, false)), 'not-a-person');
  assert.equal(ok(feedSourceTransition('approved', 'start-live', SYSTEM, false)), 'live');
  assert.equal(ok(feedSourceTransition('approved', 'start-live', SYSTEM, true)), 'bad-transition');
  assert.equal(ok(feedSourceTransition('approved', 'start-backfill', SYSTEM, true)), 'backfilling');
  assert.equal(ok(feedSourceTransition('approved', 'start-backfill', SYSTEM, false)), 'bad-transition');
  assert.equal(ok(feedSourceTransition('live', 'degrade', SYSTEM, false)), 'degraded');
  assert.equal(ok(feedSourceTransition('degraded', 'recover', SYSTEM, false)), 'live');
  assert.equal(ok(feedSourceTransition('live', 'retire', SYSTEM, false)), 'not-a-person');
  for (const from of FEED_SOURCE_STATES) {
    for (const event of FEED_SOURCE_EVENTS) {
      const listed = FEED_SOURCE_TRANSITIONS.find((entry) => entry.from === from && entry.event === event);
      const result = feedSourceTransition(from, event, PERSON, event === 'start-backfill');
      if (!listed) assert.deepEqual(result, { ok: false, reason: 'bad-transition' }, `${from} ${event}`);
      else assert.ok(result.ok, `${from} ${event}`);
    }
  }
  assert.ok(!FEED_SOURCE_TRANSITIONS.some((entry) => entry.from === 'retired'), 'retired is the end');
});

// ---- Tracks and decay ------------------------------------------------------------------------------------------------------------------

test('track transitions: live, stale, lost, closed; closed is the end and only an observation brings a track back', () => {
  assert.equal(trackTransition('live', 'interval-passed'), 'stale');
  assert.equal(trackTransition('stale', 'ttl-passed'), 'lost');
  assert.equal(trackTransition('lost', 'observation'), 'live');
  assert.equal(trackTransition('stale', 'observation'), 'live');
  for (const event of TRACK_EVENTS) assert.equal(trackTransition('closed', event), undefined, `closed ${event}`);
  assert.equal(trackTransition('live', 'ttl-passed'), undefined);
  assert.equal(trackTransition('lost', 'interval-passed'), undefined);
  for (const state of TRACK_STATES.filter((entry) => entry !== 'closed')) assert.equal(trackTransition(state, 'close'), 'closed');
});

test('decay runs on the clock passed in, honours the row\'s own stale time, and leaves static data live', () => {
  const decay = { staleAfterSeconds: 120, lostAfterSeconds: 900 };
  const seen = Date.parse('2026-11-18T05:40:00.000Z');
  const last = { validAt: '2026-11-18T05:40:00.000Z' };
  assert.equal(decayState(last, seen + 119_000, decay), 'live');
  assert.equal(decayState(last, seen + 120_000, decay), 'stale');
  assert.equal(decayState(last, seen + 899_000, decay), 'stale');
  assert.equal(decayState(last, seen + 900_000, decay), 'lost');
  assert.equal(decayState({ ...last, validUntil: '2026-11-18T05:41:00.000Z' }, seen + 61_000, decay), 'stale', 'CoT stale comes first');
  assert.equal(decayState(last, seen + 10 ** 9, null), 'live');
});

test('a track is computed for the reader: rows above the reader are invisible, corrections replace, the label joins, gaps show', () => {
  const decay = { staleAfterSeconds: 120, lostAfterSeconds: 900 };
  const first = obs({ trackId: 'cot:U-1', validAt: '2026-11-18T03:10:00.000Z', label: 'org/Public' });
  const second = obs({ trackId: 'cot:U-1', validAt: '2026-11-18T03:30:00.000Z', label: 'org/Public' });
  const secret = obs({ trackId: 'cot:U-1', validAt: '2026-11-18T03:35:00.000Z', label: 'org/Internal' });
  const corrected = obs({ trackId: 'cot:U-1', validAt: '2026-11-18T03:30:00.000Z', label: 'org/Public', supersedes: second.obsId });
  const rows = [first, second, secret, corrected];
  const now = Date.parse('2026-11-18T03:31:00.000Z');
  const publicReader = (label: string) => label === 'org/Public';
  const view = buildTrack('cot:U-1', rows, publicReader, now, decay)!;
  assert.deepEqual(view.observations, [first.obsId, corrected.obsId]);
  assert.equal(view.label, 'org/Public');
  assert.equal(view.state, 'live');
  assert.equal(view.gaps.length, 1, 'twenty minutes without a row is a gap past the lost TTL');
  const fullReader = buildTrack('cot:U-1', rows, () => true, now, decay)!;
  assert.equal(fullReader.last.obsId, secret.obsId);
  assert.equal(fullReader.label, 'org/Internal');
  assert.deepEqual(buildTrack('cot:U-1', rows.filter((entry) => entry.label === 'org/Public'), publicReader, now, decay), view, 'the same as a store without the higher row');
  assert.equal(buildTrack('cot:U-1', rows, () => false, now, decay), undefined);
  assert.equal(buildTrack('cot:U-1', rows, publicReader, now, decay, true)!.state, 'closed');
});

// ---- COP feed layers ---------------------------------------------------------------------------------------------------------------------

test('feed layers are views with one settings owner each, kept apart from the product layers', () => {
  assert.equal(FEED_LAYERS.length, 8);
  for (const layer of FEED_LAYERS) {
    assert.ok(layer.layer.startsWith('cop-feed-'), layer.layer);
    assert.equal(mayWriteFeedLayerFeatures(layer.layer), false, `${layer.layer} features are never written by hand`);
    assert.ok(!SHARED_PRODUCTS.some((product) => product.product === layer.layer));
    assert.equal(mayChangeFeedLayerSettings(layer.layer, { section: layer.settingsOwner.section, member: layer.settingsOwner.member }), true);
    for (const contributor of layer.contributors) assert.equal(mayChangeFeedLayerSettings(layer.layer, contributor), false, `${contributor.member} proposes to ${layer.layer}`);
  }
  assert.deepEqual(FEED_LAYERS.find((layer) => layer.layer === 'cop-feed-friendly')!.settingsOwner, { section: 'j3', member: 'joc-chief' });
  assert.equal(FEED_LAYERS.find((layer) => layer.layer === 'cop-feed-intelligence')!.settingsOwner.member, 'watch-officer');
  assert.equal(mayChangeFeedLayerSettings('cop-feed-intelligence', { section: 'j2', member: 'threat-analyst' }), false);
  assert.equal(mayChangeFeedLayerSettings('cop-threat-layer', { section: 'j2', member: 'threat-analyst' }), false, 'a product layer is not a feed layer');
  // Folds: a roster without the named member gives the job to the next one it has.
  assert.deepEqual(feedLayerSettingsOwner('cop-feed-maritime', { section: 'j3', members: ['j3-director', 'joc-chief'] }), { section: 'j3', member: 'joc-chief' });
  assert.deepEqual(feedLayerSettingsOwner('cop-feed-intelligence', { section: 'j2', members: ['j2-chief', 'warning-analyst'] }), { section: 'j2', member: 'warning-analyst' });
  assert.deepEqual(feedLayerSettingsOwner('cop-feed-imagery', { section: 'j2', members: ['s2-lead', 'ipb-analyst', 'watch-officer'] }), { section: 'j2', member: 's2-lead' });
  assert.equal(mayChangeFeedLayerSettings('cop-feed-weather', { section: 'j2', member: 'ipb-analyst' }, ['s2-lead', 'ipb-analyst']), true);
  assert.equal(feedLayerSettingsOwner('cop-feed-nothing'), undefined);
  assert.deepEqual(layersFor('own-force', 'ais-nmea'), ['cop-feed-maritime']);
  assert.ok(layersFor('intelligence', 'rss').includes('cop-feed-osint'));
});

// ---- Slices -------------------------------------------------------------------------------------------------------------------------------

test('a slice parses strictly and never widens: no label or clearance, separate grades, windows in order', () => {
  const parsed = parseSliceQuery({ area: { kind: 'grid-radius', reference: 'KQ 4636', radiusMetres: 5000 }, time: { validFrom: '2026-11-18T00:00:00.000Z', knownBy: '2026-11-18T06:00:00.000Z' }, grade: { minReliability: 'B', maxCredibility: 3, corroboratedOnly: true }, disciplines: ['OSINT', 'GEOINT'], units: { ids: ['e-41'], subordinates: true }, echelons: { atLeast: 'battalion' }, identities: ['hostile'], limit: 50 });
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  for (const key of ['label', 'labels', 'clearance', 'clearances', 'mark']) refused(parseSliceQuery({ [key]: 'org/Confidential' }), 'label-widening', key);
  refused(parseSliceQuery({ grade: { minReliability: 'B2' } }), 'grades-separate', 'grade.minReliability');
  refused(parseSliceQuery({ grade: { grade: 'B2' } }), 'grades-separate', 'grade.grade');
  refused(parseSliceQuery({ time: { validFrom: '2026-11-18T06:00:00.000Z', validTo: '2026-11-18T05:00:00.000Z' } }), 'time-order', 'time.validTo');
  refused(parseSliceQuery({ echelons: { atLeast: 'brigade', atMost: 'company' } }), 'out-of-range', 'echelons.atMost');
  refused(parseSliceQuery({ echelons: { atLeast: 'squadron' } }), 'unknown-value', 'echelons.atLeast');
  refused(parseSliceQuery({ area: { kind: 'box', west: 1, south: 1, east: 0, north: 2 } }), 'out-of-range', 'area');
  refused(parseSliceQuery({ area: { kind: 'box', west: 0, south: 0, east: 1, north: 1, id: 'x' } }), 'unknown-field', 'area.id');
  refused(parseSliceQuery({ limit: 501 }), 'out-of-range', 'limit');
  refused(parseSliceQuery({ everything: true }), 'unknown-field', 'everything');
  assert.equal(echelonOf('Battery'), 'company');
  assert.equal(echelonOf('brigade'), 'brigade');
  assert.equal(echelonOf('squadron'), undefined, 'squadron means a battalion or a company, so the scenario must say which');
});

function sliceContext(over: Partial<SliceContext> = {}): SliceContext {
  const parents: Record<string, string> = { 'e-1-41': 'e-41', 'e-2-41': 'e-41', 'e-3-41': 'e-41', 'e-41-arty': 'e-41' };
  const echelons: Record<string, 'brigade' | 'battalion' | 'company'> = { 'e-41': 'brigade', 'e-1-41': 'battalion', 'e-2-41': 'battalion', 'e-3-41': 'company' };
  return {
    visible: (label) => label === 'org/Public' || label === 'org/Internal', frame: FRAME,
    controlMeasure: (id) => (id === 'nai-3' ? { kind: 'polygon', points: [at(45, 36), at(49, 36), at(49, 43), at(45, 43)] } : id === 'route-iron' ? { kind: 'line', points: [at(43, 15), at(45, 28), at(46, 36)] } : undefined),
    parentOf: (id) => parents[id], echelonOf: (id) => echelons[id], ...over
  };
}
function slice(rows: readonly Observation[], query: SliceQuery, context = sliceContext()): string[] {
  const result = sliceObservations(rows, query, context);
  assert.ok(result.ok, result.ok ? '' : result.message);
  return result.ok ? result.value.rows.map((entry) => entry.messageId) : [];
}

test('slices by area, time, grade, discipline, unit, echelon and assessed identity', () => {
  const rows = [
    obs({ messageId: 'harbour', geometry: { type: 'Point', coordinates: at(47, 38) }, discipline: 'GEOINT', about: ['e-2-41'], reliability: 'C', credibility: 3, origin: 'Radar' }),
    obs({ messageId: 'ford', geometry: { type: 'Point', coordinates: at(45, 28) }, discipline: 'OSINT', about: ['e-1-41'], validAt: '2026-11-17T22:00:00.000Z', origin: 'Video' }),
    obs({ messageId: 'ridge', geometry: { type: 'Point', coordinates: at(47, 26) }, discipline: 'OSINT', about: ['e-3-41'], reliability: 'C', credibility: 3, origin: 'Video' }),
    obs({ messageId: 'saltmere', geometry: { type: 'Point', coordinates: at(43, 15) }, discipline: null, about: ['f-anvil'], reliability: 'A', credibility: 1, origin: 'Own report' })
  ];
  assert.deepEqual(slice(rows, { area: { kind: 'control-measure', id: 'nai-3' } }), ['harbour']);
  assert.deepEqual(slice(rows, { area: { kind: 'grid-radius', reference: 'KQ 4528', radiusMetres: 1500 } }), ['ford']);
  assert.deepEqual(slice(rows, { area: { kind: 'control-measure', id: 'route-iron', withinMetres: 1000 } }).sort(), ['ford', 'saltmere']);
  assert.deepEqual(slice(rows, { time: { validFrom: '2026-11-18T00:00:00.000Z' } }).sort(), ['harbour', 'ridge', 'saltmere']);
  assert.deepEqual(slice(rows, { grade: { minReliability: 'B' } }).sort(), ['ford', 'saltmere']);
  assert.deepEqual(slice(rows, { grade: { maxCredibility: 2 } }).sort(), ['ford', 'saltmere']);
  assert.deepEqual(slice(rows, { disciplines: ['OSINT'] }).sort(), ['ford', 'ridge']);
  assert.deepEqual(slice(rows, { units: { ids: ['e-41'], subordinates: false } }), []);
  assert.deepEqual(slice(rows, { units: { ids: ['e-41'], subordinates: true } }).sort(), ['ford', 'harbour', 'ridge']);
  assert.deepEqual(slice(rows, { echelons: { atLeast: 'battalion' } }).sort(), ['ford', 'harbour']);
  assert.deepEqual(slice(rows, { identities: ['pending'] }).length, 4, 'nothing assessed is pending, whatever the feed claimed');
  assert.deepEqual(slice(rows, { identities: ['hostile'] }, sliceContext({ assessedIdentity: (entry) => (entry.about?.[0]?.startsWith('e-') ? 'hostile' : 'friend') })).sort(), ['ford', 'harbour', 'ridge']);
  const unknown = sliceObservations(rows, { area: { kind: 'control-measure', id: 'nai-9' } }, sliceContext());
  refused(unknown, 'unknown-value', 'area.id');
});

test('corroboration counts origins, not reports: two items from one origin never corroborate each other', () => {
  const rows = [
    obs({ messageId: 'os-02', about: ['e-3-41'], origin: 'One video posted by a resident' }),
    obs({ messageId: 'os-03', about: ['e-3-41'], origin: 'One video posted by a resident.' }),
    obs({ messageId: 'mp-05', trackId: 'cot:U-1', about: ['u-1'], origin: 'Radar and night camera' }),
    obs({ messageId: 'fr-01', about: ['u-1'], origin: 'The skipper\'s own sighting', discipline: 'HUMINT', handling: ['local-only'] })
  ];
  assert.deepEqual(slice(rows, { grade: { corroboratedOnly: true } }).sort(), ['fr-01', 'mp-05']);
});

test('as known at T: rows learned later are gone, and a correction hides the original only once it is known', () => {
  const original = obs({ messageId: 'first', knownAt: '2026-11-18T04:00:00.000Z' });
  const correction = obs({ messageId: 'fix', knownAt: '2026-11-18T05:00:00.000Z', supersedes: original.obsId });
  const late = obs({ messageId: 'late', knownAt: '2026-11-18T07:00:00.000Z' });
  const rows = [original, correction, late];
  assert.deepEqual(slice(rows, { time: { knownBy: '2026-11-18T04:30:00.000Z' } }), ['first']);
  assert.deepEqual(slice(rows, { time: { knownBy: '2026-11-18T06:00:00.000Z' } }), ['fix']);
  assert.deepEqual(slice(rows, {}).sort(), ['fix', 'late']);
  assert.deepEqual(slice(rows, { time: { knownBy: '2026-11-18T06:00:00.000Z' } }), slice([original, correction], {}), 'equals a store built only from rows known by T');
});

test('a slice is clamped to the reader: the same answer as a store that never held what the reader cannot see, and it says when it was cut', () => {
  const rows = Array.from({ length: 12 }, (_, index) => obs({ messageId: `m${index}`, label: index % 3 === 0 ? 'org/Internal' : 'org/Public', validAt: `2026-11-18T05:${String(10 + index).padStart(2, '0')}:00.000Z` }));
  const publicOnly: SliceContext = sliceContext({ visible: (label) => label === 'org/Public' });
  const withHidden = sliceObservations(rows, { limit: 5 }, publicOnly);
  const without = sliceObservations(rows.filter((entry) => entry.label === 'org/Public'), { limit: 5 }, publicOnly);
  assert.deepEqual(withHidden, without);
  assert.ok(withHidden.ok);
  if (withHidden.ok) {
    assert.equal(withHidden.value.total, 8);
    assert.equal(withHidden.value.cut, true);
    assert.equal(withHidden.value.note, cutNote(5, 8));
    assert.ok(withHidden.value.rows.every((entry) => entry.label === 'org/Public'));
    assert.equal(withHidden.value.rows[withHidden.value.rows.length - 1].messageId, 'm11', 'newest last');
  }
});

// ---- Standing watches ----------------------------------------------------------------------------------------------------------------------

function watchValue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'WATCH-1', title: 'Small craft at night in NAI 3', pir: 'PIR-2', indicator: 'IND-3',
    condition: { area: { kind: 'control-measure', id: 'nai-3' }, grade: { minReliability: 'C' } }, ltiov: '2026-11-21T00:00:00.000Z',
    alert: { name: 'A. Demo', role: 'J2 watch officer' }, outputs: ['draft-intrep', 'draft-ecoa-revision', 'mark-source-changed', 'alert-person'],
    runMode: 'attended', state: 'proposed', missedWhilePaused: 0, label: 'org/Internal', ...over
  };
}
function watch(over: Record<string, unknown> = {}): StandingWatch {
  const parsed = parseWatch(watchValue(over));
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  return parsed.value;
}
const ATTENDED: WatchContext = { at: Date.parse('2026-11-18T06:00:00.000Z'), attendedRun: true };
const UNATTENDED: WatchContext = { ...ATTENDED, attendedRun: false };
function step(current: StandingWatch, event: Parameters<typeof watchTransition>[1], actor: Parameters<typeof watchTransition>[2], context = ATTENDED): StandingWatch {
  const result = watchTransition(current, event, actor, context);
  assert.ok(result.ok, result.ok ? '' : `${event}: ${result.message}`);
  return result.ok ? result.value.watch : current;
}

test('a watch drafts only, alerts a named person, and runs only attended', () => {
  for (const action of WATCH_FORBIDDEN_ACTIONS) {
    assert.equal(checkWatchOutput(action), 'drafts-only', action);
    refused(parseWatch(watchValue({ outputs: ['alert-person', action] })), 'drafts-only', 'outputs[1]');
  }
  for (const output of WATCH_OUTPUTS) assert.equal(checkWatchOutput(output), undefined);
  refused(parseWatch(watchValue({ outputs: ['draft-intrep'] })), 'missing-field', 'outputs');
  refused(parseWatch(watchValue({ runMode: 'unattended' })), 'attended-only', 'runMode');
  refused(parseWatch(watchValue({ alert: { member: 'watch-officer' } })), 'not-a-person', 'alert');
  refused(parseWatch(watchValue({ condition: { label: 'org/Confidential' } })), 'label-widening', 'condition.label');
  refused(parseWatch(watchValue({ label: 'org/Restricted' })), 'label-ceiling', 'label');
  refused(parseWatch(watchValue({ state: 'paused' })), 'missing-field', 'pausedReason');
});

test('watch transitions: a person arms, the runtime matches, a member drafts, a person acknowledges; nothing waits forever', () => {
  const proposed = watch();
  refused(watchTransition(proposed, 'arm', AGENT, ATTENDED), 'not-a-person', 'actor');
  refused(watchTransition(proposed, 'arm', { ...PERSON, name: ' ' }, ATTENDED), 'not-a-person', 'actor');
  const armed = step(proposed, 'arm', PERSON);
  assert.equal(armed.state, 'armed');
  refused(watchTransition(armed, 'match', SYSTEM, UNATTENDED), 'attended-only', 'run');
  refused(watchTransition(armed, 'match', AGENT, ATTENDED), 'bad-transition', 'actor');
  const matched = step(armed, 'match', SYSTEM);
  refused(watchTransition(matched, 'draft', PERSON, ATTENDED), 'bad-transition', 'actor');
  const drafting = step(matched, 'draft', AGENT);
  const review = step(drafting, 'drafts-ready', AGENT);
  assert.equal(review.state, 'awaiting-review');
  refused(watchTransition(review, 'acknowledge', AGENT, ATTENDED), 'not-a-person', 'actor');
  refused(watchTransition(review, 'match', SYSTEM, ATTENDED), 'bad-transition', 'event');
  assert.equal(step(review, 'acknowledge', PERSON).state, 'armed');
  assert.equal(step(review, 'disarm', PERSON).state, 'disarmed');
  refused(watchTransition(proposed, 'disarm', PERSON, ATTENDED), 'bad-transition', 'event');
  assert.equal(step(proposed, 'reject', PERSON).state, 'rejected');
});

test('without an attended run a watch pauses, counts what it missed, and resumes with the count until a person acknowledges', () => {
  const pausedAtArm = step(watch(), 'arm', PERSON, UNATTENDED);
  assert.equal(pausedAtArm.state, 'paused');
  assert.equal(pausedAtArm.pausedReason, 'no-attended-run');
  refused(watchTransition(pausedAtArm, 'resume', SYSTEM, UNATTENDED), 'attended-only', 'run');
  const once = step(pausedAtArm, 'match', SYSTEM);
  const twice = step(once, 'match', SYSTEM);
  assert.equal(twice.state, 'paused');
  assert.equal(twice.missedWhilePaused, 2, 'matches while paused are queued, never dropped');
  const resumed = step(twice, 'resume', SYSTEM);
  assert.equal(resumed.state, 'armed');
  assert.equal(resumed.missedWhilePaused, 2);
  assert.equal(resumed.pausedReason, undefined);
  const degraded = watchTransition(resumed, 'pause', SYSTEM, { ...ATTENDED, pauseReason: 'source-degraded' });
  assert.ok(degraded.ok && degraded.value.watch.pausedReason === 'source-degraded');
  const acknowledged = step(step(step(step(resumed, 'match', SYSTEM), 'draft', AGENT), 'drafts-ready', SYSTEM), 'acknowledge', PERSON);
  assert.equal(acknowledged.missedWhilePaused, 0);
});

test('past the latest time of value a watch expires and cannot match; before it, it cannot expire', () => {
  const armed = step(watch(), 'arm', PERSON);
  const late: WatchContext = { at: Date.parse('2026-11-21T00:00:01.000Z'), attendedRun: true };
  refused(watchTransition(armed, 'match', SYSTEM, late), 'ltiov-passed', 'ltiov');
  refused(watchTransition(watch(), 'arm', PERSON, late), 'ltiov-passed', 'ltiov');
  refused(watchTransition(armed, 'expire', SYSTEM, ATTENDED), 'bad-transition', 'ltiov');
  assert.equal(step(armed, 'expire', SYSTEM, late).state, 'expired');
  const paused = step(watch(), 'arm', PERSON, UNATTENDED);
  assert.equal(step(paused, 'expire', SYSTEM, late).state, 'expired', 'a paused watch does not wait forever');
  refused(watchTransition(step(armed, 'expire', SYSTEM, late), 'resume', SYSTEM, late), 'bad-transition', 'event');
});

test('alert fatigue: one match per subject in the window, and a digest past the hourly cap', () => {
  const t = Date.parse('2026-11-18T06:00:00.000Z');
  assert.equal(isDuplicateMatch([{ at: t, subject: 'u-1' }], 'u-1', t + 29 * 60_000), true);
  assert.equal(isDuplicateMatch([{ at: t, subject: 'u-1' }], 'u-1', t + 30 * 60_000), false);
  assert.equal(isDuplicateMatch([{ at: t, subject: 'u-1' }], 'e-41', t + 60_000), false);
  assert.equal(alertMode([t, t + 1, t + 2], t + 3), 'alert');
  assert.equal(alertMode([t, t + 1, t + 2, t + 3], t + 4), 'digest');
  assert.equal(alertMode([t, t + 1, t + 2, t + 3], t + 3_600_001), 'alert');
});

// ---- Events, read models and tools -------------------------------------------------------------------------------------------------------

test('feed and watch event names are registered once, apart from the staff events, under their own prefixes', () => {
  assert.equal(new Set(ALL_STAFF_EVENT_TYPES).size, ALL_STAFF_EVENT_TYPES.length);
  for (const name of FEED_EVENT_TYPES) {
    assert.ok(!(STAFF_EVENT_TYPES as readonly string[]).includes(name), name);
    assert.match(name, /^(feed\.|staff\.watch\.)/);
  }
  for (const name of ['staff.watch.matched', 'staff.watch.paused', 'feed.source.state', 'feed.gap']) assert.ok((FEED_EVENT_TYPES as readonly string[]).includes(name), `${name} is named in note 11`);
});

test('the feed picture: sources with state and gaps, feed layers with the SIM badge and track counts, never writable, and the watch board', () => {
  const run = 'run-1';
  const events: FeedEvent[] = [
    { type: 'feed.source.state', run, at: '2026-11-18T05:00:00.000Z', feed: 'iron-cot', from: 'approved', to: 'live', simulated: true },
    { type: 'feed.observations.appended', run, at: '2026-11-18T05:01:00.000Z', feed: 'iron-cot', channel: 'recce-net', segment: 'iron-cot/recce-net/2026-11-18T05', appended: 3, duplicates: 1, layers: ['cop-feed-intelligence'], knownFrom: '2026-11-18T05:00:00.000Z', knownTo: '2026-11-18T05:01:00.000Z', simulated: true },
    { type: 'feed.gap', run, at: '2026-11-18T05:02:00.000Z', feed: 'iron-cot', channel: 'recce-net', from: '2026-11-18T05:01:00.000Z', to: '2026-11-18T05:02:00.000Z', reason: 'gap' },
    { type: 'feed.source.state', run, at: '2026-11-18T05:02:00.000Z', feed: 'iron-cot', from: 'live', to: 'degraded', reason: 'gap', simulated: true },
    { type: 'feed.track.state', run, at: '2026-11-18T05:03:00.000Z', trackId: 'cot:U-1', layer: 'cop-feed-maritime', from: null, to: 'live' },
    { type: 'feed.track.state', run, at: '2026-11-18T05:05:00.000Z', trackId: 'cot:U-1', layer: 'cop-feed-maritime', from: 'live', to: 'stale' },
    { type: 'staff.watch.state', run, at: '2026-11-18T05:06:00.000Z', watch: 'WATCH-1', from: 'proposed', to: 'armed', actor: 'A. Demo' },
    { type: 'staff.watch.paused', run, at: '2026-11-18T05:07:00.000Z', watch: 'WATCH-1', reason: 'no-attended-run', missed: 2 },
    { type: 'staff.watch.state', run, at: '2026-11-18T05:08:00.000Z', watch: 'WATCH-1', from: 'paused', to: 'armed', actor: 'system' },
    { type: 'staff.watch.matched', run, at: '2026-11-18T05:09:00.000Z', watch: 'WATCH-1', pir: 'PIR-2', indicator: 'IND-3', observations: ['obs-1'], area: 'nai-3' }
  ];
  const picture = feedPicture(events);
  assert.deepEqual(picture.sources, [{ feed: 'iron-cot', state: 'degraded', since: '2026-11-18T05:02:00.000Z', simulated: true, rows: 3, gaps: 1, reason: 'gap', lastKnownAt: '2026-11-18T05:01:00.000Z' }]);
  const intelligence = picture.layers.find((layer) => layer.layer === 'cop-feed-intelligence')!;
  assert.equal(intelligence.simulated, true);
  assert.equal(intelligence.writable, false);
  assert.ok(picture.layers.every((layer) => layer.writable === false));
  assert.deepEqual(picture.layers.find((layer) => layer.layer === 'cop-feed-maritime')!.tracks, { live: 0, stale: 1, lost: 0, closed: 0 });
  assert.deepEqual(picture.watches, [{ watch: 'WATCH-1', state: 'armed', since: '2026-11-18T05:08:00.000Z', missed: 2, lastMatch: '2026-11-18T05:09:00.000Z' }]);
  assert.equal(picture.gaps.length, 1);
  assert.deepEqual(feedPicture(events), picture, 'the same log gives the same picture');
});

test('the observations tools: the names note 11 lists, local with no hosts, and only proposals change anything', () => {
  assert.deepEqual(OBS_TOOLS.map((tool) => tool.name), [...OBS_TOOL_NAMES]);
  assert.deepEqual(OBS_TOOL_MANIFEST, { runsOn: 'local', hosts: [] });
  assert.deepEqual(OBS_TOOLS.filter((tool) => tool.proposes).map((tool) => tool.name), ['watch.propose', 'cop.layer.propose']);
});

test('the contract is pure: no vscode, no file system, no network in src/domain/staff/obs', () => {
  const folder = path.join(__dirname, '..', '..', 'src', 'domain', 'staff', 'obs');
  // The codecs (WP-IMP) are in a subfolder and are held to the same rules.
  for (const file of readdirSync(folder, { recursive: true }).map(String).filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(path.join(folder, file), 'utf8');
    assert.ok(!/from 'vscode'|require\('vscode'\)/.test(source), `${file} imports vscode`);
    assert.ok(!/from 'node:(fs|net|http|https|dgram|child_process)'/.test(source), `${file} does I/O`);
    assert.ok(!source.includes(String.fromCharCode(0x2014)), `${file} has an em-dash`);
    assert.ok(!/provisional|preview/i.test(source), `${file} says provisional or preview`);
  }
});
