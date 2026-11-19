// Drop 2 integration: the simulation's traffic goes into the observation store and the staff event log, through the minimal ingest for the simulator's
// own formats, and track decay runs on a timer. The J2 workspace read model then shows the live simulated reports.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { parseObservation } from '../domain/staff/obs/observation';
import { SIM_FEED_IDS, SIM_FEEDS } from '../domain/staff/sim/feeds';
import { parseAisSentence, parseCotEvent, SimIngest } from '../domain/staff/sim/ingest';
import type { SimScheduler } from '../domain/staff/sim/player';
import { parseInjectScript } from '../domain/staff/sim/script';
import { buildSimTimeline } from '../domain/staff/sim/timeline';
import type { SimTimeline } from '../domain/staff/sim/timeline';
import { parseScenarioText } from '../domain/staff/scenario';
import type { Scenario } from '../domain/staff/scenario';
import { buildStaffRoomModel } from '../domain/staff/staffRoom';
import { ObservationStore } from '../staff/observationStore';
import { FEED_TICK_EVERY_MS, SimFeedRuntime } from '../staff/sim/feedRuntime';
import type { FeedTimers } from '../staff/sim/feedRuntime';
import { SimSession } from '../staff/sim/simSession';
import { loadStaffRoomInput } from '../staff/staffRoomData';
import { staffWorld } from './helpers/staffFixtures';

const RESOURCES = path.join(__dirname, '..', '..', 'resources', 'staff', 'scenarios');
const PERSON = { kind: 'person', name: 'A. Demo', role: 'Exercise control', deviceFingerprint: 'dev-0123456789abcdef' } as const;

function scenario(): Scenario {
  const parsed = parseScenarioText(readFileSync(path.join(RESOURCES, 'iron-lantern.json'), 'utf8'));
  assert.ok(parsed.ok);
  return parsed.value;
}
function timeline(): SimTimeline {
  const script = parseInjectScript(readFileSync(path.join(RESOURCES, 'iron-lantern.sim.jsonl'), 'utf8'), scenario());
  assert.ok(script.ok);
  return buildSimTimeline(scenario(), script.value);
}

/** One virtual clock for the player and the runtime's timers. */
class FakeClock implements SimScheduler, FeedTimers {
  time = 1_000_000;
  private timers: Array<{ id: number; due: number; every?: number; run: () => void }> = [];
  private nextId = 1;
  now(): number { return this.time; }
  setTimeout(run: () => void, ms: number): unknown { const id = this.nextId++; this.timers.push({ id, due: this.time + ms, run }); return id; }
  clearTimeout(handle: unknown): void { this.timers = this.timers.filter((timer) => timer.id !== handle); }
  setInterval(run: () => void, ms: number): unknown { const id = this.nextId++; this.timers.push({ id, due: this.time + ms, every: ms, run }); return id; }
  clearInterval(handle: unknown): void { this.clearTimeout(handle); }
  /** Advances the clock by `ms`, running every timer due on the way (intervals repeat). */
  async advance(ms: number, settle: () => Promise<void>): Promise<void> {
    const end = this.time + ms;
    for (let n = 0; n < 200_000; n += 1) {
      this.timers.sort((a, b) => a.due - b.due || a.id - b.id);
      const timer = this.timers[0];
      if (!timer || timer.due > end) break;
      this.time = Math.max(this.time, timer.due);
      if (timer.every) timer.due += timer.every; else this.timers.shift();
      timer.run();
      if (n % 50 === 0) await settle();
    }
    this.time = end;
    await settle();
  }
}

test('the ingest reads the simulator\'s own CoT, AIS and RSS into rows the observation contract accepts', () => {
  const line = timeline();
  const frame = scenario().region.frame!;
  const ingest = new SimIngest(frame);
  const seen = new Set<string>();
  let rows = 0;
  for (const message of line.messages) {
    for (const row of ingest.rows(message, message.at)) {
      const parsed = parseObservation(row);
      assert.ok(parsed.ok, `${message.stream} ${message.inject}: ${parsed.ok ? '' : JSON.stringify(parsed)}`);
      assert.equal(parsed.value.simulated, true);
      seen.add(parsed.value.feed);
      rows += 1;
    }
  }
  assert.deepEqual([...seen].sort(), [SIM_FEED_IDS['cot-intel'], SIM_FEED_IDS['cot-own'], SIM_FEED_IDS.ais, SIM_FEED_IDS.rss].sort(), 'partner reports stay out: that feed is off until a person adds it');
  assert.ok(rows > 100, String(rows));
  // The AIS decoder reads back the writer's fields; a vessel's name comes from its static message.
  const ais = line.messages.find((message) => message.stream === 'ais');
  assert.ok(ais && ais.stream === 'ais');
  const position = ais.sentences.map(parseAisSentence).find((value) => value && 'lat' in value);
  assert.ok(position && 'lat' in position && position.mmsi >= 199_000_001 && position.mmsi <= 199_000_999);
  assert.equal(parseAisSentence('!AIVDM,1,1,,A,15M67FC000G?ufbE`FepT@3n00Sa,0*00'), undefined, 'a bad checksum is not read');
  const cot = line.messages.find((message) => message.stream === 'cot-intel');
  assert.ok(cot && cot.stream === 'cot-intel');
  assert.ok(parseCotEvent(cot.xml)?.uid.startsWith('SIM-'));
});

test('a running simulation fills the store and the staff event log, decays tracks on a timer, pauses its feeds when stopped and resumes them next run; the J2 workspace shows the reports', async () => {
  const world = await staffWorld();
  const clock = new FakeClock();
  const store = new ObservationStore({ root: world.root, now: () => clock.now(), emit: (events) => world.host.emit(events) });
  const run = async () => {
    const session = new SimSession(timeline(), PERSON, clock);
    const runtime = new SimFeedRuntime(session, store, scenario().region.frame!, PERSON, clock);
    runtime.attach();
    assert.ok(session.player.setSpeed(4).ok);
    assert.ok(session.player.start().ok);
    return { session, runtime };
  };
  const first = await run();
  await clock.advance(60_000, () => first.runtime.settled());
  assert.ok(first.runtime.counts.appended > 0, JSON.stringify(first.runtime.counts));
  assert.equal(first.runtime.counts.refused, 0, JSON.stringify(first.runtime.counts.problems));
  assert.ok(first.runtime.counts.ticks >= Math.floor(60_000 / FEED_TICK_EVERY_MS) - 1, `ticks ${first.runtime.counts.ticks}`);
  const loaded = await store.load();
  assert.ok(loaded.ok);
  for (const feed of SIM_FEEDS.filter((entry) => entry.id !== SIM_FEED_IDS.partner)) assert.equal(loaded.value.registry.feeds[feed.id]?.state, 'live', feed.id);
  assert.equal(loaded.value.registry.feeds[SIM_FEED_IDS.partner], undefined, 'the partner feed is never registered by the simulation');
  // While the simulation runs the store keeps the exercise clock, so known times are on the exercise calendar.
  assert.ok(loaded.value.rows.every((row) => row.knownAt.startsWith('2027-05')), loaded.value.rows[0]?.knownAt);
  const feedEvents = await world.host.feedEvents();
  assert.ok(feedEvents.some((event) => event.type === 'feed.source.state' && event.to === 'live'), 'the source changes reach the staff event log');
  assert.ok(feedEvents.some((event) => event.type === 'feed.observations.appended'), 'and the appends');
  // The J2 workspace read model shows the live simulated reports.
  const input = await loadStaffRoomInput(world.host, world.root, clock.now(), undefined, { live: loaded.value.rows });
  const model = buildStaffRoomModel(input);
  assert.equal(model.j2.live.total, loaded.value.rows.length);
  assert.ok(model.j2.live.reports.length > 0 && model.j2.live.reports.every((report) => report.simulated));
  // Stop: the feeds pause in the store (a retired feed could never come back), and the store gets its own clock back.
  first.session.player.stop();
  await first.runtime.detach();
  const stopped = await store.load();
  assert.ok(stopped.ok);
  assert.equal(stopped.value.registry.feeds[SIM_FEED_IDS.ais]?.state, 'paused');
  assert.equal(store.time(), clock.now());
  // A second run resumes the same feeds.
  const second = await run();
  await clock.advance(5_000, () => second.runtime.settled());
  const again = await store.load();
  assert.ok(again.ok);
  assert.equal(again.value.registry.feeds[SIM_FEED_IDS.ais]?.state, 'live');
  assert.deepEqual(second.runtime.counts.problems, []);
  second.session.player.stop();
  await second.runtime.detach();
});
