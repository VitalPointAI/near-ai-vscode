// The IRON LANTERN inject script, the timeline and the player (WP-SIM; research note 11, 8): the script reads and refuses what it must, the timeline is
// the same every build, matches the J2 demo script (beats and the mid-demo report), stays inside the exercise frame and is marked SIM everywhere, and the
// player emits the same messages in the same order at every speed, with real time scaled exactly by the speed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { demoScript } from '../domain/staff/demoScripts';
import { insidePolygon } from '../domain/staff/guardScan';
import { feedPicture } from '../domain/staff/obs/events';
import type { FeedSourceStateEvent } from '../domain/staff/obs/events';
import { channelHandling, parseFeedDescriptor } from '../domain/staff/obs/feeds';
import { frameBox } from '../domain/staff/obs/frame';
import { parseObservation } from '../domain/staff/obs/observation';
import { defaultStaffSettings } from '../domain/staff/profiles';
import { parseScenarioText } from '../domain/staff/scenario';
import type { Scenario } from '../domain/staff/scenario';
import { SIM_FEED_IDS, SIM_FEEDS, simFeed, simLayers } from '../domain/staff/sim/feeds';
import { isSimMmsi, SIM_MARKING, SIM_TEXT_PREFIX } from '../domain/staff/sim/formats';
import { SIM_SCENARIO_SECONDS_PER_SECOND, SIM_SPEEDS, SimPlayer } from '../domain/staff/sim/player';
import type { SimPerson, SimScheduler } from '../domain/staff/sim/player';
import { formatScenarioTime, parseInjectScript, parseScenarioTime } from '../domain/staff/sim/script';
import type { InjectScript } from '../domain/staff/sim/script';
import { alongRoute, buildSimTimeline, timelineCounts } from '../domain/staff/sim/timeline';
import type { SimMessage, SimTimeline } from '../domain/staff/sim/timeline';
import { parseXml, child } from './simXml';

const DIR = path.join(__dirname, '..', '..', 'resources', 'staff', 'scenarios');
const SCENARIO_TEXT = readFileSync(path.join(DIR, 'iron-lantern.json'), 'utf8');
const SCRIPT_TEXT = readFileSync(path.join(DIR, 'iron-lantern.sim.jsonl'), 'utf8');
const PERSON: SimPerson = { kind: 'person', name: 'Test Presenter', role: 'Exercise control', deviceFingerprint: 'test-device' };

function scenario(): Scenario {
  const parsed = parseScenarioText(SCENARIO_TEXT);
  assert.ok(parsed.ok);
  return parsed.value;
}
function script(text = SCRIPT_TEXT): InjectScript {
  const parsed = parseInjectScript(text, scenario());
  assert.ok(parsed.ok, parsed.ok ? '' : `line ${parsed.line}: ${parsed.message}`);
  return parsed.value;
}
function timeline(): SimTimeline {
  return buildSimTimeline(scenario(), script());
}
function refused(edit: (lines: string[]) => string[], pattern: RegExp): void {
  const parsed = parseInjectScript(edit(SCRIPT_TEXT.split('\n')).join('\n'), scenario());
  assert.equal(parsed.ok, false, 'expected a refusal');
  if (!parsed.ok) assert.match(parsed.message, pattern);
}
const replaceLine = (find: string, change: (line: string) => string) => (lines: string[]) => lines.map((line) => (line.includes(find) ? change(line) : line));

/** A virtual clock: timers run in time order as the test advances it. */
class FakeClock implements SimScheduler {
  time = 1_000_000;
  private timers: Array<{ id: number; due: number; run: () => void }> = [];
  private nextId = 1;
  now(): number { return this.time; }
  setTimeout(run: () => void, ms: number): unknown { const id = this.nextId++; this.timers.push({ id, due: this.time + ms, run }); return id; }
  clearTimeout(handle: unknown): void { this.timers = this.timers.filter((timer) => timer.id !== handle); }
  /** Runs every timer in order until none is left; returns false if a step cap is hit. */
  runAll(cap = 100_000): void {
    for (let n = 0; n < cap; n += 1) {
      this.timers.sort((a, b) => a.due - b.due || a.id - b.id);
      const timer = this.timers.shift();
      if (!timer) return;
      this.time = Math.max(this.time, timer.due);
      timer.run();
    }
    throw new Error('timers did not settle');
  }
  pending(): number { return this.timers.length; }
}

/** Plays a timeline to the end at one speed, resuming after every hold; returns what was emitted and when (real ms from start). */
function play(line: SimTimeline, speed: number) {
  const clock = new FakeClock();
  const player = new SimPlayer(line, clock, PERSON);
  const start = clock.now();
  const emitted: Array<{ message: SimMessage; real: number }> = [];
  const events: FeedSourceStateEvent[] = [];
  player.onMessage((message) => emitted.push({ message, real: clock.now() - start }));
  player.onFeedEvent((event) => events.push(event));
  assert.ok(player.setSpeed(speed).ok);
  assert.ok(player.start().ok);
  let holds = 0;
  for (let guard = 0; guard < 20; guard += 1) {
    clock.runAll();
    const status = player.status();
    if (status.state === 'finished') break;
    assert.equal(status.state, 'paused');
    assert.equal(status.pausedFor, 'hold');
    holds += 1;
    assert.ok(player.resume().ok);
  }
  return { emitted, events, holds, player };
}

// ---- Scenario time and the script ---------------------------------------------------------------------------------------------------------

test('scenario times read and write in the scenario\'s own form', () => {
  assert.equal(parseScenarioTime('D-6 0540'), -6 * 1440 + 340);
  assert.equal(parseScenarioTime('D 1200'), 720);
  assert.equal(parseScenarioTime('D+2 0600'), 2 * 1440 + 360);
  assert.equal(parseScenarioTime('D-6 2460'), undefined);
  assert.equal(parseScenarioTime('day 4'), undefined);
  for (const text of ['D-6 0540', 'D 0000', 'D+3 2359', 'D-3 0400']) assert.equal(formatScenarioTime(parseScenarioTime(text)!), text);
});

test('the IRON LANTERN inject script reads against the scenario', () => {
  const value = script();
  assert.equal(value.exercise.name, 'IRON LANTERN');
  assert.equal(value.outlets.length, 3);
  assert.ok(value.injects.length > 30);
});

test('the script refuses unknown reports and subjects, places off the grid or outside the frame, real MMSIs, repeated ids and bad grades', () => {
  refused(replaceLine('"id":"OS-02"', (l) => l.replace('"report":"OS-02"', '"report":"OS-99"')), /not in the scenario/);
  refused(replaceLine('"id":"trk-recce"', (l) => l.replace('"subject":"f-recce"', '"subject":"f-nobody"')), /not in the scenario/);
  refused(replaceLine('"id":"PR-12"', (l) => l.replace('KQ 4933', 'XY 4933')), /not a grid reference/);
  // The starter frame holds every four-figure reference, so the frame check is shown on a smaller frame: Kell bridge at KQ 4933 lies outside 45 by 45.
  const base = scenario();
  const small: Scenario = { ...base, region: { ...base.region, frame: { ...base.region.frame!, extent: { eastings: 45, northings: 45 } } } };
  const outside = parseInjectScript(SCRIPT_TEXT, small);
  assert.ok(!outside.ok && /outside the exercise frame/.test(outside.message), outside.ok ? 'accepted' : outside.message);
  refused(replaceLine('"id":"ais-orla"', (l) => l.replace('199000001', '477553000')), /outside the fictional range/);
  refused(replaceLine('"id":"ais-guard-2"', (l) => l.replace('199000012', '199000011')), /used twice/);
  refused(replaceLine('"id":"PR-12"', (l) => l.replace('"id":"PR-12"', '"id":"PR-11"')), /used twice/);
  refused(replaceLine('"id":"MS-01"', (l) => l.replace('"credibility":3', '"credibility":"B3"')), /kept separate/);
  refused(replaceLine('"id":"MS-01"', (l) => l.replace('"discipline":"MASINT"', '"discipline":"OSINT"')), /discipline must be one of/);
  refused(replaceLine('"id":"CC-01"', (l) => l.replace('D-6 1000', 'D-9 1000')), /outside the script's window/);
  refused((lines) => lines.filter((l) => !l.includes('"kind":"exercise"')), /no exercise line/);
});

// ---- The timeline ------------------------------------------------------------------------------------------------------------------------

test('the timeline is the same, byte for byte, every time it is built', () => {
  assert.deepEqual(timeline(), timeline());
  const line = timeline();
  line.messages.forEach((message, index) => { assert.equal(message.seq, index); if (index > 0) assert.ok(message.at >= line.messages[index - 1].at); });
  const counts = timelineCounts(line);
  for (const stream of ['cot-own', 'cot-intel', 'ais', 'rss', 'partner', 'marker'] as const) assert.ok(counts[stream] > 0, stream);
});

test('the timeline matches the J2 demo script: one marker per beat in order, the mid-demo report, then the hold before the change-propagation beat', () => {
  const line = timeline();
  const j2 = demoScript('j2', defaultStaffSettings(), scenario());
  const markers = line.messages.filter((m): m is Extract<SimMessage, { stream: 'marker' }> => m.stream === 'marker');
  assert.deepEqual(markers.map((m) => m.beat), j2.beats.map((_, index) => index + 1));
  assert.deepEqual(markers.map((m) => m.title), j2.beats.map((beat) => beat.title));
  for (const marker of markers) assert.ok(!/\{[a-z]/i.test(marker.title), 'no raw demo token');
  const holds = markers.filter((m) => m.hold);
  assert.equal(holds.length, 1);
  assert.equal(holds[0].beat, j2.inject!.beforeBeat + 1, 'the hold opens the beat the inject comes before');
  const mcm = line.messages.filter((m) => m.inject === 'MCM-01');
  assert.equal(mcm.length, 2);
  for (const message of mcm) {
    assert.equal(message.stream, 'cot-intel');
    assert.ok(message.seq < holds[0].seq, 'the report lands before the hold');
    const remarks = child(child(parseXml((message as { xml: string }).xml), 'detail')!, 'remarks')!.text;
    assert.equal(remarks, `${SIM_TEXT_PREFIX} ${j2.inject!.text}`);
  }
  // The decisive moment of note 11, 8.1: the radar contact and the skipper's account, two origins, both before the mines are found.
  const mp05 = line.messages.find((m) => m.inject === 'MP-05')!;
  const fr01 = line.messages.find((m) => m.inject === 'FR-01')!;
  assert.ok(mp05.at < fr01.at && fr01.at < mcm[0].at);
  assert.equal(fr01.stream, 'partner');
});

test('every message is in a standard format, marked SIM, and placed inside the exercise frame', () => {
  const line = timeline();
  const s = scenario();
  const box = frameBox(s.region.frame!);
  const inside = (lat: number, lon: number) => assert.ok(insidePolygon([lon, lat], box), `${lat},${lon} is outside the frame`);
  const reportIds = new Set(s.reports.map((r) => r.id));
  for (const message of line.messages) {
    switch (message.stream) {
      case 'cot-own': case 'cot-intel': {
        const event = parseXml(message.xml);
        assert.equal(event.attrs.opex, 's-IRON LANTERN');
        assert.equal(child(child(event, 'detail')!, '__simulation')!.attrs.marking, SIM_MARKING);
        const point = child(event, 'point')!;
        inside(Number(point.attrs.lat), Number(point.attrs.lon));
        for (const link of child(event, 'detail')!.children.filter((c) => c.name === 'link')) {
          const [lat, lon] = link.attrs.point.split(',').map(Number);
          inside(lat, lon);
        }
        assert.ok(Date.parse(event.attrs.stale) > Date.parse(event.attrs.time));
        assert.equal(Date.parse(event.attrs.time), message.at);
        break;
      }
      case 'ais':
        assert.ok(isSimMmsi(Number(message.subject)));
        for (const sentence of message.sentences) assert.match(sentence, /^!AIVDM,\d,\d,\d?,[AB],[0-9:;<=>?@A-W`a-w]+,[0-5]\*[0-9A-F]{2}$/);
        break;
      case 'rss':
        assert.equal(new URL(message.item.link).hostname, 'exercise.invalid');
        break;
      case 'partner': {
        const report = message.report;
        assert.equal(report.marking, SIM_MARKING);
        assert.equal(report.simulated, true);
        assert.deepEqual(report.handling, ['local-only']);
        assert.ok(['HUMINT', 'SIGINT', 'MASINT', 'CI'].includes(report.discipline));
        if (report.location) inside(report.location.lat, report.location.lon);
        for (const bearing of report.bearings ?? []) inside(bearing.fromLat, bearing.fromLon);
        if (report.grade) { assert.match(report.grade.reliability, /^[A-F]$/); assert.equal(typeof report.grade.credibility, 'number'); }
        if (!reportIds.has(report.id)) assert.ok(['MS-01', 'CI-01'].includes(report.id), 'only the partner-only additions are not in the scenario');
        break;
      }
      case 'marker': break;
    }
  }
  const partner = line.messages.filter((m) => m.stream === 'partner').map((m) => (m as { report: { discipline: string } }).report.discipline);
  assert.deepEqual([...new Set(partner)].sort(), ['CI', 'HUMINT', 'MASINT', 'SIGINT']);
});

test('the simulated feeds are valid descriptors, simulated, and declare every channel the timeline uses', () => {
  for (const feed of SIM_FEEDS) {
    const parsed = parseFeedDescriptor(JSON.parse(JSON.stringify(feed)));
    assert.ok(parsed.ok, parsed.ok ? '' : `${feed.id}: ${parsed.message}`);
    assert.equal(feed.simulated, true);
    assert.equal(feed.licenceClass, 'simulated');
    assert.equal(feed.trainingRights, 'no');
    assert.ok(feed.transport === 'loopback' || feed.transport === 'partner');
  }
  for (const message of timeline().messages) {
    if (message.stream === 'marker') continue;
    const feed = simFeed(message.stream);
    assert.ok(feed.channels.some((channel) => channel.id === message.channel), `${feed.id} declares ${message.channel}`);
  }
  for (const channel of simFeed('partner').channels) assert.deepEqual(channelHandling(simFeed('partner'), channel), ['local-only']);
  assert.ok(simLayers().includes('cop-feed-friendly') && simLayers().includes('cop-feed-maritime') && simLayers().includes('cop-feed-intelligence'));
  assert.equal(SIM_FEED_IDS.partner, 'sim-partner');
});

test('a partner simulation row passes the observation contract only as simulated and local-only', () => {
  const base = {
    schema: 1, messageId: 'FR-01', feed: 'sim-partner', channel: 'humint', discipline: 'HUMINT', validAt: '2027-05-20T08:00:00.000Z',
    knownAt: '2027-05-20T08:00:00.000Z', geometry: { type: 'Point', coordinates: [-123.5, -49] }, error: { circularMetres: 707, verticalMetres: null }, how: 'reported',
    source: 'A fishing skipper', origin: 'The skipper', reliability: 'F', credibility: 6, deceptionNote: 'Ungraded.', label: 'org/Internal',
    extractor: { codec: 'partner-mcp', version: '1.0.0' }
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { observationId, segmentId } = require('../domain/staff/obs/observation') as typeof import('../domain/staff/obs/observation');
  const row = { ...base, obsId: observationId('sim-partner', 'humint', 'FR-01'), segment: segmentId('sim-partner', 'humint', base.knownAt) };
  assert.ok(parseObservation({ ...row, handling: ['local-only'], simulated: true }).ok);
  assert.equal(parseObservation({ ...row, handling: [], simulated: true }).ok, false);
});

test('alongRoute walks out and back on a loop and stops at the end otherwise', () => {
  const route = [{ eastingMetres: 0, northingMetres: 0 }, { eastingMetres: 1000, northingMetres: 0 }];
  assert.deepEqual(alongRoute(route, 500, true), { point: { eastingMetres: 500, northingMetres: 0 }, course: 90 });
  assert.deepEqual(alongRoute(route, 1500, true), { point: { eastingMetres: 500, northingMetres: 0 }, course: 270 });
  assert.deepEqual(alongRoute(route, 5000, false).point, { eastingMetres: 1000, northingMetres: 0 });
  assert.equal(alongRoute([route[0]], 100, true).course, 0);
});

// ---- The player ---------------------------------------------------------------------------------------------------------------------------

test('the player emits the same messages in the same order at every speed, and real time scales exactly with the speed', () => {
  const line = timeline();
  const runs = SIM_SPEEDS.map((speed) => ({ speed, ...play(line, speed) }));
  const reference = runs.find((run) => run.speed === 1)!;
  assert.equal(reference.emitted.length, line.messages.length);
  assert.deepEqual(reference.emitted.map((entry) => entry.message), line.messages);
  for (const run of runs) {
    assert.equal(run.holds, 1, 'one hold, at the mid-demo report');
    assert.deepEqual(run.emitted.map((entry) => entry.message), reference.emitted.map((entry) => entry.message), `${run.speed}x emits the same messages`);
    // Before the hold, each message leaves when the scenario clock reaches it: scenario elapsed / (rate x speed).
    const hold = run.emitted.findIndex((entry) => entry.message.stream === 'marker' && entry.message.hold);
    for (const entry of run.emitted.slice(0, hold + 1)) {
      const expected = (entry.message.at - line.start) / (SIM_SCENARIO_SECONDS_PER_SECOND * run.speed);
      assert.ok(Math.abs(entry.real - expected) < 1, `${run.speed}x: ${entry.message.inject} at ${entry.real} ms, expected ${expected}`);
    }
  }
  const total = (speed: number) => runs.find((run) => run.speed === speed)!.emitted.at(-1)!.real;
  assert.ok(Math.abs(total(0.5) - 8 * total(4)) < 2);
  // About a quarter hour at 1x, as the J2 demo runs.
  assert.ok(total(1) > 10 * 60_000 && total(1) < 20 * 60_000, String(total(1)));
});

test('pause, resume, step and speed change follow the state machine, and the scenario clock never jumps', () => {
  const line = timeline();
  const clock = new FakeClock();
  const player = new SimPlayer(line, clock, PERSON);
  const seen: SimMessage[] = [];
  player.onMessage((message) => seen.push(message));
  assert.equal(player.pause().ok, false, 'idle cannot pause');
  assert.equal(player.step().ok, false, 'idle cannot step');
  assert.equal(player.setSpeed(3).ok, false);
  assert.ok(player.start().ok);
  assert.equal(player.start().ok, false);
  clock.time += 60_000;
  const paused = player.pause();
  assert.ok(paused.ok);
  assert.equal(paused.status.pausedFor, 'person');
  const position = paused.status.position;
  assert.equal(position, line.start + 60_000 * SIM_SCENARIO_SECONDS_PER_SECOND);
  assert.equal(clock.pending(), 0, 'no timer while paused');
  clock.time += 3_600_000;
  assert.equal(player.status().position, position, 'paused time does not move the scenario clock');
  const before = seen.length;
  const next = line.messages[player.status().emitted];
  assert.ok(player.step().ok);
  const stepped = seen.slice(before);
  assert.ok(stepped.length >= 1 && stepped.every((m) => m.at === next.at), 'a step emits one group sharing one time');
  assert.equal(player.status().state, 'paused');
  assert.ok(player.setSpeed(4).ok);
  assert.ok(player.resume().ok);
  assert.equal(player.resume().ok, false);
  const resumedAt = player.status().position;
  clock.time += 1000;
  assert.equal(player.status().position, resumedAt + 1000 * SIM_SCENARIO_SECONDS_PER_SECOND * 4);
  assert.ok(player.setSpeed(0.5).ok);
  const mid = player.status().position;
  clock.time += 1000;
  assert.equal(player.status().position, mid + 1000 * SIM_SCENARIO_SECONDS_PER_SECOND * 0.5);
  assert.ok(player.stop().ok);
  assert.equal(player.stop().ok, false);
  assert.equal(player.resume().ok, false);
  assert.equal(player.setSpeed(1).ok, false);
});

test('every simulated source is badged SIM in the feed picture and goes live, paused and retired with the player', () => {
  const run = play(timeline(), 4);
  assert.ok(run.player.stop().ok);
  for (const event of run.events) {
    assert.equal(event.type, 'feed.source.state');
    assert.equal(event.simulated, true);
    assert.equal(event.run, null);
  }
  const picture = feedPicture(run.events);
  assert.deepEqual(picture.sources.map((source) => source.feed).sort(), SIM_FEEDS.map((feed) => feed.id).sort());
  for (const source of picture.sources) {
    assert.equal(source.simulated, true);
    assert.equal(source.state, 'retired');
  }
  const forOne = run.events.filter((event) => event.feed === 'sim-ais').map((event) => event.to);
  assert.deepEqual(forOne, ['approved', 'live', 'paused', 'live', 'retired']);
  const held = run.events.find((event) => event.to === 'paused');
  assert.equal(held?.reason, 'Held at a demo beat');
});
