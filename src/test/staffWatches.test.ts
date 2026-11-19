// Standing watches (research note 11, 4.5; WP-WATCH): every transition of the watch state machine and every forbidden one, the signed arm decision, no
// evaluation without an attended run, matching against the observation store, de-duplication, the alert rate limit and digest, a paused watch that
// queues its matches and delivers them on resume, the latest time of value, the drafts a match leads to (through the release state machine, never
// released by an agent), the member run that ends mid-draft, a concurrent edit refused, and the grants. Every project is under the temporary folder.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { OBSERVATIONS, OBSERVATIONS_WATCH, OBSERVATIONS_WATCH_GRANTEES } from '../agent/staff/grants';
import { STAFF_TEMPLATES } from '../agent/staff/templates';
import { grantsStaffTool, memberGranted } from '../agent/staffGrantGate';
import { staffServerToolsForRun } from '../agent/staffServers';
import { parseTeam } from '../agent/teams';
import type { AgentTool, ToolContext } from '../agent/tools';
import { WATCH_TOOL_NAMES, watchTools } from '../agent/watchTools';
import {
  applyWatchEvent, evaluateWatch, gridCentre, gridToWgs84, observationId, parseGridReference, parseWatch, parseWatchRegisterText, renderWatchRegister, segmentId,
  trustWatch, WATCH_EVENTS, WATCH_STATES, WATCH_TRANSITIONS, watchDraftNotice, watchTransition, watchWording
} from '../domain/staff';
import type { ExerciseFrame, FeedEvent, StandingWatch, WatchActor, WatchEvent, WatchState } from '../domain/staff';
import type { PersonDecisionEntry } from '../domain/staff/personDecisions';
import type { PersonActor } from '../domain/staff/release';
import { grantsMcpTool } from '../mcp/tools';
import { ObservationStore } from '../staff/observationStore';
import { buildStaffRoomModel } from '../domain/staff/staffRoom';
import { loadStaffRoomInput } from '../staff/staffRoomData';
import { productPath } from '../staff/staffHost';
import { setCasProbe } from '../staff/staffFiles';
import { attend, isAttended, resetAttendance } from '../staff/watchAttendance';
import { STANDING_WATCHES_FILE, WATCH_CHANGED_TEXT, WatchHost } from '../staff/watchHost';
import type { WatchNotice } from '../staff/watchHost';
import { J2_TEAM, staffWorld } from './helpers/staffFixtures';
import type { StaffWorld } from './helpers/staffFixtures';

const SCENARIO = path.join(__dirname, '..', '..', 'resources', 'staff', 'scenarios', 'iron-lantern.json');
const FRAME: ExerciseFrame = JSON.parse(readFileSync(SCENARIO, 'utf8')).region.frame;
const T0 = Date.parse('2026-11-18T12:00:00.000Z');
const LTIOV = '2026-11-21T06:00:00.000Z';
const iso = (ms: number): string => new Date(ms).toISOString();

function kq(reference: string): [number, number] {
  const ref = parseGridReference(reference, FRAME.grid, FRAME.squareMetres)!;
  const point = gridToWgs84(FRAME, gridCentre(ref));
  return [point.longitude, point.latitude];
}

const AIS = {
  id: 'ais-sim', title: 'Simulated AIS', category: 'intelligence', feedClass: 'positions', format: 'ais-nmea', transport: 'loopback', licenceClass: 'simulated',
  trainingRights: 'no', simulated: true, channels: [{ id: 'receiver-north', title: 'North receiver', discipline: null, reliability: 'C', credibility: 3 }]
};

let counter = 0;
function row(knownAt: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  counter += 1;
  const messageId = `w-${counter}`;
  const known = iso(knownAt);
  const { position, track, ...rest } = over as { position?: [number, number]; track?: string };
  return {
    schema: 1, obsId: observationId('ais-sim', 'receiver-north', messageId), messageId, segment: segmentId('ais-sim', 'receiver-north', known), feed: 'ais-sim', channel: 'receiver-north',
    discipline: null, validAt: known, knownAt: known, geometry: { type: 'Point', coordinates: position ?? kq('KQ 4636') }, error: { circularMetres: 50, verticalMetres: null },
    how: 'gps', subjectRef: track ?? '316000001', source: 'North AIS receiver', origin: `Transponder ${track ?? '316000001'}`, reliability: 'C', credibility: 3, deceptionNote: 'none seen',
    label: 'org/Internal', handling: [], extractor: { codec: 'ais', version: '1.0.0' }, simulated: true, trackId: `mmsi:${track ?? '316000001'}`, ...rest
  };
}

const PERSON: PersonActor = { kind: 'person', name: 'A. Demo', role: 'J2 watch officer', deviceFingerprint: 'dev-0123456789abcdef' };
const AGENT = { kind: 'agent', member: 'watch-officer' } as const;
const SYSTEM = { kind: 'system' } as const;

function watchValue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'WATCH-1', title: 'Small craft at the harbour', pir: 'PIR-1', indicator: 'IND-1', condition: { area: { kind: 'control-measure', id: 'obj-falcon' } }, ltiov: LTIOV,
    alert: { name: 'K. Sample', role: 'J2' }, outputs: ['draft-intrep', 'draft-ecoa-revision', 'mark-source-changed', 'alert-person'], runMode: 'attended', state: 'proposed',
    missedWhilePaused: 0, label: 'org/Internal', ...over
  };
}
function watch(over: Record<string, unknown> = {}): StandingWatch {
  const parsed = parseWatch(watchValue(over));
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  return parsed.value;
}

// ---- The state machine ----------------------------------------------------------------------------------------------------------------------

test('every watch transition and every forbidden one: the table is the only way a watch moves, and each actor only takes its own steps', () => {
  const actors: Record<string, WatchActor> = { person: PERSON, agent: AGENT, system: SYSTEM };
  const early = { at: T0, attendedRun: true };
  const late = { at: Date.parse(LTIOV) + 1, attendedRun: true };
  const allows = (who: string, kind: string): boolean => (
    who === kind || (who === 'agent-or-system' && (kind === 'agent' || kind === 'system')) || (who === 'person-or-system' && (kind === 'person' || kind === 'system'))
  );
  let allowed = 0; let refusedCount = 0;
  for (const state of WATCH_STATES) {
    const current = watch({ state, ...(state === 'paused' ? { pausedReason: 'source-degraded' } : {}) });
    for (const event of WATCH_EVENTS) {
      for (const [kind, actor] of Object.entries(actors)) {
        const rule = WATCH_TRANSITIONS.find((entry) => entry.event === event && entry.from.includes(state));
        const result = watchTransition(current, event, actor, event === 'expire' ? late : early);
        const expected = Boolean(rule && allows(rule.who, kind));
        assert.equal(result.ok, expected, `${state} --${event}--> by ${kind}`);
        if (result.ok) {
          allowed += 1;
          assert.equal(result.value.to, rule!.to === 'armed' && event === 'arm' ? 'armed' : rule!.to, `${state} ${event}`);
        } else refusedCount += 1;
      }
    }
  }
  assert.ok(allowed >= 14 && refusedCount > 200, `${allowed} allowed, ${refusedCount} refused`);
  // The ended states go nowhere.
  for (const state of ['expired', 'disarmed', 'rejected'] as const) {
    for (const event of WATCH_EVENTS) for (const actor of Object.values(actors)) assert.equal(watchTransition(watch({ state }), event, actor, late).ok, false, `${state} ${event}`);
  }
});

test('the runtime resumes only its own pauses; a person\'s pause waits for a person, and a person may retire a watch stuck on a match', () => {
  const byPerson = watch({ state: 'paused', pausedReason: 'person' });
  const refusal = watchTransition(byPerson, 'resume', SYSTEM, { at: T0, attendedRun: true });
  assert.ok(!refusal.ok && refusal.reason === 'not-a-person');
  assert.equal(watchTransition(byPerson, 'resume', PERSON, { at: T0, attendedRun: true }).ok, true);
  for (const state of ['matched', 'drafting'] as const) assert.equal(watchTransition(watch({ state }), 'disarm', PERSON, { at: T0, attendedRun: true }).ok, true, state);
  const abandoned = watchTransition(watch({ state: 'drafting' }), 'abandon', SYSTEM, { at: T0, attendedRun: false });
  assert.ok(abandoned.ok && abandoned.value.to === 'matched', 'a drafting run that ended hands the match back');
  assert.equal(watchTransition(watch({ state: 'drafting' }), 'abandon', PERSON, { at: T0, attendedRun: true }).ok, false);
});

test('a step records its events: the state change, and the pause with its reason and the count', () => {
  const armed = watch({ state: 'armed' });
  const paused = applyWatchEvent(armed, 'pause', PERSON, { at: T0, attendedRun: true, run: 'run-1' });
  assert.ok(paused.ok);
  assert.deepEqual(paused.events.map((event) => event.type), ['staff.watch.state', 'staff.watch.paused']);
  assert.equal((paused.events[0] as { actor: string }).actor, 'person:A. Demo (J2 watch officer)');
  const counted = applyWatchEvent(paused.watch, 'match', SYSTEM, { at: T0, attendedRun: true, run: 'run-1' });
  assert.ok(counted.ok && counted.watch.missedWhilePaused === 1);
  assert.deepEqual(counted.events.map((event) => event.type), ['staff.watch.paused'], 'a match while paused is counted in the log, not a state change');
});

// ---- Trust ---------------------------------------------------------------------------------------------------------------------------------

function decision(entry: StandingWatch, kind: 'approved' | 'rejected', wording = watchWording(entry)): PersonDecisionEntry {
  return { v: 1, seq: 0, prev: '0'.repeat(64), at: iso(T0), subject: { kind: 'watch', id: entry.id }, decision: kind, wording, reasons: kind === 'rejected' ? ['done'] : [], person: PERSON };
}

test('the file alone arms nothing: armed needs a signed arm decision over the exact watch; a retired watch reads retired whatever the file says', () => {
  const armed = watch({ state: 'armed' });
  assert.equal(trustWatch(armed, undefined).watch.state, 'proposed');
  assert.equal(trustWatch(armed, decision(armed, 'approved')).watch.state, 'armed');
  const widened = watch({ state: 'armed', condition: {} });
  assert.equal(trustWatch(widened, decision(armed, 'approved')).watch.state, 'proposed', 'a condition changed after arming is not armed');
  assert.equal(trustWatch(watch({ state: 'matched' }), decision(armed, 'rejected')).watch.state, 'disarmed');
  assert.equal(trustWatch(watch({ state: 'proposed' }), decision(armed, 'rejected')).watch.state, 'rejected');
  // An unarmed watch evaluates nothing, even attended.
  const proposed = trustWatch(armed, undefined).watch;
  const evaluation = evaluateWatch({ watch: proposed, rows: [], context: {}, now: T0, run: null, attended: true, degradedFeeds: new Set() });
  assert.equal(evaluation.changed, false);
});

test('the register reads strictly and round-trips; one damaged watch refuses the whole file', () => {
  const entries = [watch(), watch({ id: 'WATCH-2', state: 'armed', cursor: iso(T0), queued: ['obs-' + 'a'.repeat(64)], recent: [{ subject: 'mmsi:1', at: iso(T0) }] })];
  const text = renderWatchRegister(entries);
  const back = parseWatchRegisterText(text);
  assert.ok(back.ok);
  assert.deepEqual(back.entries, entries);
  const damaged = text.replace('"WATCH-2"', '"WATCH-x"');
  assert.equal(parseWatchRegisterText(damaged).ok, false);
  assert.equal(parseWatchRegisterText(text.replace('"WATCH-2"', '"WATCH-1"')).ok, false, 'two watches with one id');
});

// ---- The host over a project ------------------------------------------------------------------------------------------------------------

interface Project {
  world: StaffWorld;
  store: ObservationStore;
  host: WatchHost;
  presence: { attended: boolean };
  notices: WatchNotice[];
}

async function project(): Promise<Project> {
  const world = await staffWorld();
  world.clock.now = T0;
  mkdirSync(path.join(world.root, '.planning', 'staff', 'scenario'), { recursive: true });
  copyFileSync(SCENARIO, path.join(world.root, '.planning', 'staff', 'scenario', 'scenario.json'));
  const store = new ObservationStore({ root: world.root, now: () => world.clock.now, emit: async (events) => { await world.host.emit(events); } });
  assert.ok((await store.registerFeed(AIS)).ok);
  assert.ok((await store.transitionFeed('ais-sim', 'approve', world.person())).ok);
  assert.ok((await store.transitionFeed('ais-sim', 'start-live', SYSTEM)).ok);
  const presence = { attended: true };
  const notices: WatchNotice[] = [];
  const host = new WatchHost({ root: world.root, host: () => world.host, store: () => store, now: () => world.clock.now, attended: () => presence.attended, notify: (notice) => notices.push(notice) });
  return { world, store, host, presence, notices };
}

const K_SAMPLE = (p: Project): PersonActor => p.world.person('K. Sample', 'J2');

async function watchEvents(p: Project): Promise<FeedEvent[]> {
  return (await p.world.host.feedEvents()).filter((event) => event.type.startsWith('staff.watch.'));
}

async function one(p: Project, id = 'WATCH-1'): Promise<StandingWatch> {
  const read = await p.host.read();
  assert.ok(read.ok, read.ok ? '' : read.message);
  return read.watches.find((entry) => entry.id === id)!;
}

async function created(p: Project, over: Record<string, unknown> = {}): Promise<StandingWatch> {
  const result = await p.host.create(K_SAMPLE(p), { title: 'Small craft at the harbour', pir: 'PIR-1', indicator: 'IND-1', condition: { area: { kind: 'control-measure', id: 'obj-falcon' } }, ltiov: LTIOV, outputs: ['draft-intrep', 'draft-ecoa-revision', 'mark-source-changed', 'alert-person'], ...over });
  assert.ok(result.ok, result.ok ? '' : result.message);
  const watches = await p.host.read();
  assert.ok(watches.ok);
  return watches.watches[watches.watches.length - 1];
}

async function advance(p: Project, minutes: number): Promise<number> {
  p.world.clock.now += minutes * 60_000;
  return p.world.clock.now;
}

test('a person creates and arms a watch, signed; a person on another key, or a member writing the file, arms nothing', async () => {
  const p = await project();
  const armed = await created(p);
  assert.equal(armed.state, 'armed');
  assert.equal(armed.proposedBy, 'person:K. Sample (J2)');
  assert.ok(armed.cursor, 'armed from now: it looks at observations known from here on');
  const decisions = await p.world.host.watchDecisions();
  assert.equal(decisions.get('WATCH-1')?.decision, 'approved');
  assert.deepEqual((await watchEvents(p)).map((event) => [event.type, (event as { to?: string }).to]), [['staff.watch.state', 'proposed'], ['staff.watch.state', 'armed']]);
  const stranger: PersonActor = { ...K_SAMPLE(p), deviceFingerprint: 'someone-else' };
  const refused = await p.host.arm(stranger, 'WATCH-1');
  assert.ok(!refused.ok && /named person/.test(refused.message));
  // A member writes a second watch into the file as armed: it reads proposed and matches nothing.
  const file = path.join(p.world.root, STANDING_WATCHES_FILE);
  const forged = parseWatch(watchValue({ id: 'WATCH-2', state: 'armed', cursor: iso(T0 - 60_000) }));
  assert.ok(forged.ok);
  const current = parseWatchRegisterText(readFileSync(file, 'utf8'));
  assert.ok(current.ok);
  writeFileSync(file, renderWatchRegister([...current.entries, forged.value]));
  assert.equal((await one(p, 'WATCH-2')).state, 'proposed');
  await advance(p, 1);
  await p.store.append({ rows: [row(p.world.clock.now)] });
  await p.host.evaluate();
  assert.equal((await one(p, 'WATCH-2')).state, 'proposed', 'a forged armed watch never matches');
  assert.equal((await one(p)).state, 'matched', 'the signed one does');
});

test('no watch is evaluated without an attended run: nothing runs in the background', async () => {
  const p = await project();
  await created(p);
  p.presence.attended = false;
  await advance(p, 1);
  await p.store.append({ rows: [row(p.world.clock.now)] });
  const before = readFileSync(path.join(p.world.root, STANDING_WATCHES_FILE), 'utf8');
  const result = await p.host.evaluate();
  assert.ok(result.ok && /No person attends/.test(result.text));
  assert.equal(readFileSync(path.join(p.world.root, STANDING_WATCHES_FILE), 'utf8'), before, 'not a byte changed');
  assert.equal(p.notices.length, 0);
  // The pure rule says the same.
  const evaluation = evaluateWatch({ watch: await one(p), rows: [], context: {}, now: p.world.clock.now, run: null, attended: false, degradedFeeds: new Set() });
  assert.equal(evaluation.changed, false);
  // And a member cannot draft without one.
  const tools = toolMap(p);
  await assert.rejects(call(tools, 'watch.draft', { watch: 'WATCH-1', kind: 'intrep' }, p), /attends the project/);
});

test('the attendance registry: a run or the Staff Room holds it, and it ends when the last holder goes', () => {
  resetAttendance();
  const root = path.join(path.sep, 'tmp', 'attendance-project');
  const release = attend(root, { kind: 'run', id: 'run-1' });
  const room = attend(root, { kind: 'staff-room', id: 'panel' });
  assert.equal(isAttended(root), true);
  release();
  assert.equal(isAttended(root), true);
  room();
  room();
  assert.equal(isAttended(root), false);
  resetAttendance();
});

test('matching: new observations in the area raise one match, de-duplicated per track; outside the area nothing; an alert to the named person', async () => {
  const p = await project();
  await created(p);
  await advance(p, 1);
  const now = p.world.clock.now;
  await p.store.append({ rows: [row(now), row(now, { messageId: 'dup' }), row(now, { track: '316000002' }), row(now, { track: '316000003', position: kq('KQ 4318') })] });
  await p.host.evaluate();
  const matched = await one(p);
  assert.equal(matched.state, 'matched');
  assert.equal(matched.match?.observations.length, 2, 'two tracks in the area; the repeat of one track and the craft outside are not matches');
  const events = await watchEvents(p);
  assert.ok(events.some((event) => event.type === 'staff.watch.matched'));
  const alert = events.find((event) => event.type === 'staff.watch.alert') as { mode: string; person: { name: string } };
  assert.equal(alert.mode, 'alert');
  assert.equal(alert.person.name, 'K. Sample');
  assert.equal(p.notices.length, 1);
  assert.match(p.notices[0].text, /For K. Sample \(J2\): WATCH-1 matched 2 observations/);
  // While it works on the match, new matches wait in the queue.
  await advance(p, 1);
  await p.store.append({ rows: [row(p.world.clock.now, { track: '316000009' })] });
  await p.host.evaluate();
  assert.equal((await one(p)).queued?.length, 1);
});

test('de-duplication: one match per track within the window; the same track after the window is a new match', async () => {
  const p = await project();
  await advance(p, 1);
  const now = p.world.clock.now;
  await p.store.append({ rows: [row(now, { track: 'A1' }), row(now, { track: 'A1' }), row(now, { track: 'B1' })] });
  const rowsNow = async () => { const loaded = await p.store.load(); assert.ok(loaded.ok); return loaded.value.rows; };
  const armed = watch({ state: 'armed', condition: {}, cursor: iso(T0) });
  const first = evaluateWatch({ watch: armed, rows: await rowsNow(), context: {}, now, run: null, attended: true, degradedFeeds: new Set() });
  assert.equal(first.raised?.observations.length, 2);
  const rearmed: StandingWatch = { ...first.watch, state: 'armed', match: undefined };
  await p.store.append({ rows: [row(now + 10 * 60_000, { track: 'A1' })] });
  const inside = evaluateWatch({ watch: rearmed, rows: await rowsNow(), context: {}, now: now + 10 * 60_000, run: null, attended: true, degradedFeeds: new Set() });
  assert.equal(inside.raised, undefined, 'the same track inside the window is not raised again');
  assert.equal(inside.watch.state, 'armed');
  await p.store.append({ rows: [row(now + 31 * 60_000, { track: 'A1' })] });
  const after = evaluateWatch({ watch: inside.watch, rows: await rowsNow(), context: {}, now: now + 31 * 60_000, run: null, attended: true, degradedFeeds: new Set() });
  assert.equal(after.raised?.observations.length, 1, 'past the window it is a new match');
});

test('a paused watch queues its matches, never drops them, and delivers them when a person resumes it', async () => {
  const p = await project();
  await created(p);
  const paused = await p.host.pause(K_SAMPLE(p), 'WATCH-1');
  assert.ok(paused.ok, paused.ok ? '' : paused.message);
  await advance(p, 1);
  await p.store.append({ rows: [row(p.world.clock.now), row(p.world.clock.now, { track: '316000002' })] });
  await p.host.evaluate();
  const waiting = await one(p);
  assert.equal(waiting.state, 'paused');
  assert.equal(waiting.missedWhilePaused, 2);
  assert.equal(waiting.queued?.length, 2);
  assert.equal(p.notices.length, 0, 'a paused watch alerts nobody');
  // The runtime does not resume a person's pause.
  await p.host.evaluate();
  assert.equal((await one(p)).state, 'paused');
  const resumed = await p.host.resume(K_SAMPLE(p), 'WATCH-1');
  assert.ok(resumed.ok && /Missed while paused: 2 matches/.test(resumed.text), resumed.ok ? resumed.text : resumed.message);
  const delivered = await one(p);
  assert.equal(delivered.state, 'matched');
  assert.deepEqual(delivered.match?.observations.length, 2);
  assert.equal(delivered.match?.missed, 2);
  assert.equal(delivered.queued, undefined);
  assert.match(p.notices[0].text, /missed while paused: 2 matches/);
});

test('when nobody attends, armed watches pause; when a person is back, what came in meanwhile is delivered with the count', async () => {
  const p = await project();
  await created(p);
  p.presence.attended = false;
  await p.host.attendanceChanged({ attended: false, holder: { kind: 'staff-room', id: 'panel' }, change: 'end' });
  const paused = await one(p);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.pausedReason, 'no-attended-run');
  await advance(p, 5);
  await p.store.append({ rows: [row(p.world.clock.now)] });
  await advance(p, 5);
  p.presence.attended = true;
  await p.host.attendanceChanged({ attended: true, holder: { kind: 'staff-room', id: 'panel' }, change: 'start' });
  const back = await one(p);
  assert.equal(back.state, 'matched');
  assert.equal(back.match?.missed, 1);
  const events = await watchEvents(p);
  const resume = events.find((event) => event.type === 'staff.watch.state' && (event as { from: string }).from === 'paused') as { reason?: string } | undefined;
  assert.match(resume?.reason ?? '', /Missed while paused: 1 match/);
});

test('a degraded source pauses the watch with the reason and its recovery resumes it, delivering what it matched meanwhile', async () => {
  const p = await project();
  await created(p, { condition: { area: { kind: 'control-measure', id: 'obj-falcon' }, feeds: ['ais-sim'] } });
  assert.ok((await p.store.transitionFeed('ais-sim', 'degrade', SYSTEM, { reason: 'gap' })).ok);
  await p.host.evaluate();
  const paused = await one(p);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.pausedReason, 'source-degraded');
  assert.ok((await p.store.transitionFeed('ais-sim', 'recover', SYSTEM)).ok);
  await advance(p, 1);
  await p.store.append({ rows: [row(p.world.clock.now)] });
  await p.host.evaluate();
  assert.equal((await one(p)).state, 'matched');
});

test('past the latest time of value an armed, a paused and a proposed watch expire, with the reason', async () => {
  const p = await project();
  await created(p);
  await created(p, { title: 'Second' });
  assert.ok((await p.host.pause(K_SAMPLE(p), 'WATCH-2')).ok);
  const proposed = await p.host.propose({ member: 'watch-officer', run: 'run-1', root: p.world.root, team: J2_TEAM }, { title: 'Third', pir: 'PIR-1', indicator: 'IND-1', condition: {}, ltiov: LTIOV, alert: { name: 'K. Sample', role: 'J2' } });
  assert.ok(proposed.ok);
  p.world.clock.now = Date.parse(LTIOV) + 60_000;
  await p.host.evaluate();
  for (const id of ['WATCH-1', 'WATCH-2', 'WATCH-3']) {
    const ended = await one(p, id);
    assert.equal(ended.state, 'expired', id);
    assert.match(ended.reason ?? '', /latest time of value passed/);
  }
  const armAfter = await p.host.arm(K_SAMPLE(p), 'WATCH-3');
  assert.equal(armAfter.ok, false, 'an expired watch cannot be armed');
});

test('alert fatigue: four alerts an hour to one person, then a digest; the next alert carries the digest', async () => {
  const p = await project();
  for (let index = 0; index < 5; index += 1) await created(p, { title: `Watch ${index + 1}` });
  await advance(p, 1);
  await p.store.append({ rows: [row(p.world.clock.now)] });
  await p.host.evaluate();
  const alerts = (await watchEvents(p)).filter((event) => event.type === 'staff.watch.alert') as Array<{ mode: string }>;
  assert.deepEqual(alerts.map((event) => event.mode), ['alert', 'alert', 'alert', 'alert', 'digest']);
  assert.equal(p.notices.length, 4, 'the digest entry is not shown on its own');
  // An hour later the next alert goes out, with the digest.
  for (let index = 1; index <= 5; index += 1) assert.ok((await p.host.retire(K_SAMPLE(p), `WATCH-${index}`, ['test over'])).ok);
  await advance(p, 61);
  await created(p, { title: 'Watch 6' });
  await advance(p, 1);
  await p.store.append({ rows: [row(p.world.clock.now, { track: '316000077' })] });
  await p.host.evaluate();
  assert.equal(p.notices.length, 5);
  assert.match(p.notices[4].text, /Also in your digest: 1 match on WATCH-5/);
});

// ---- Drafts and the members' tools ---------------------------------------------------------------------------------------------------------

function toolMap(p: Project, run = 'run-1'): Map<string, AgentTool<any>> {
  return new Map(watchTools({ watches: () => p.host, team: J2_TEAM, run }).map((tool) => [tool.name, tool]));
}

async function call(tools: Map<string, AgentTool<any>>, tool: string, args: Record<string, unknown>, p: Project, member = 'watch-officer'): Promise<string> {
  const found = tools.get(`mcp__observations__${tool.replace('.', '_')}`);
  if (!found) throw new Error(`No tool ${tool}`);
  const context = { root: p.world.root, signal: new AbortController().signal, agentLabel: member, canReadLabel: () => true } as unknown as ToolContext;
  return found.run(found.parse(args), context);
}

test('a match leads to an INTREP draft for the named person through the release state machine; nothing is released by an agent', async () => {
  const p = await project();
  await created(p);
  await advance(p, 1);
  await p.store.append({ rows: [row(p.world.clock.now)] });
  await p.host.evaluate();
  const tools = toolMap(p);
  const drafted = await call(tools, 'watch.draft', { watch: 'WATCH-1', kind: 'intrep' }, p);
  assert.match(drafted, /written as a draft for K. Sample \(J2\)/);
  const working = await one(p);
  assert.equal(working.state, 'drafting');
  assert.equal(working.drafting?.member, 'watch-officer');
  const product = working.drafts![0].product;
  const text = await readFile(path.join(p.world.root, productPath('j2', product)), 'utf8');
  assert.ok(text.includes(watchDraftNotice({ name: 'K. Sample', role: 'J2' })), 'the draft says plainly whose draft it is');
  for (const heading of ['Event', 'Indicator triggered', 'Source and grades', 'Deduction', 'Who needs to know']) assert.match(text, new RegExp(`## ${heading}`));
  assert.doesNotMatch(text, /North AIS receiver|Transponder/, 'no free text from the feed is copied into a product');
  const ledger = await p.world.host.productState(product);
  assert.equal(ledger?.state, 'draft');
  assert.equal(ledger?.owner, 'watch-officer');
  // The ECOA revision note for the COA owner, as a draft too.
  const note = await call(tools, 'watch.draft', { watch: 'WATCH-1', kind: 'ecoa-revision' }, p);
  assert.match(note, /ICD 203/);
  assert.ok(note.includes(watchDraftNotice({ name: 'K. Sample', role: 'J2' })));
  // Another member cannot take over the draft.
  await assert.rejects(call(tools, 'watch.drafted', { watch: 'WATCH-1' }, p, 'threat-analyst'), /being drafted by watch-officer/);
  const ready = await call(tools, 'watch.drafted', { watch: 'WATCH-1' }, p);
  assert.match(ready, /awaiting review by K. Sample/);
  assert.equal((await one(p)).state, 'awaiting-review');
  assert.equal((await p.world.host.productState(product))?.state, 'draft', 'still a draft: only a person approves or releases');
  // No watch tool can release, approve, arm or decide anything.
  for (const name of WATCH_TOOL_NAMES) assert.doesNotMatch(name, /approve|release|reject|arm|decide|ack|resume|pause|retire|disarm/);
  // The named person acknowledges: armed again; the draft keeps its own release path.
  const acknowledged = await p.host.acknowledge(K_SAMPLE(p), 'WATCH-1');
  assert.ok(acknowledged.ok);
  assert.equal((await one(p)).state, 'armed');
  assert.equal((await p.world.host.productState(product))?.state, 'draft');
});

test('the J2 workspace read model: each watch\'s state, queue and drafts from the register, the alerts and digest per person, and unsigned watches flagged', async () => {
  const p = await project();
  await created(p);
  await advance(p, 1);
  await p.store.append({ rows: [row(p.world.clock.now)] });
  await p.host.evaluate();
  await call(toolMap(p), 'watch.draft', { watch: 'WATCH-1', kind: 'intrep' }, p);
  await call(toolMap(p), 'watch.drafted', { watch: 'WATCH-1' }, p);
  // A member writes a second watch into the file as armed, by hand.
  const file = path.join(p.world.root, STANDING_WATCHES_FILE);
  const current = parseWatchRegisterText(readFileSync(file, 'utf8'));
  assert.ok(current.ok);
  writeFileSync(file, renderWatchRegister([...current.entries, watch({ id: 'WATCH-2', state: 'armed' })]));
  const model = buildStaffRoomModel(await loadStaffRoomInput(p.world.host, p.world.root, p.world.clock.now));
  const [first, second] = model.j2.watches;
  assert.equal(first.state, 'awaiting-review');
  assert.equal(first.drafts?.length, 1);
  assert.equal(first.unsigned, undefined);
  assert.equal(second.unsigned, true, 'a watch nobody signed is flagged: it runs nothing');
  assert.deepEqual(model.j2.watchAlerts?.map((entry) => [entry.person, entry.alertsLastHour, entry.digest]), [['K. Sample (J2)', 2, 0]]);
});

test('an unsigned watch the file calls armed, matched, drafting or awaiting review shows as proposed, whatever the live board says', async () => {
  const p = await project();
  await created(p);
  await advance(p, 1);
  await p.store.append({ rows: [row(p.world.clock.now)] });
  await p.host.evaluate();
  const file = path.join(p.world.root, STANDING_WATCHES_FILE);
  const current = parseWatchRegisterText(readFileSync(file, 'utf8'));
  assert.ok(current.ok);
  // WATCH-1 is signed and armed (the live board saw it match). A member writes three more by hand, in the busy states, with no signed arm decision.
  const forged = (['matched', 'drafting', 'awaiting-review'] as const).map((state, index) => watch({
    id: `WATCH-${index + 2}`, state, match: { at: new Date(p.world.clock.now).toISOString(), observations: [`obs-${'a'.repeat(64)}`], missed: 0 },
    ...(state === 'drafting' ? { drafting: { run: 'run-x', member: 'watch-officer' } } : {})
  }));
  // The file also claims the signed WATCH-1 is something else: a changed watch reads as proposed too, and the live board does not bring it back.
  const changed = { ...current.entries[0], title: 'Changed by hand after arming' };
  writeFileSync(file, renderWatchRegister([changed, ...forged]));
  const model = buildStaffRoomModel(await loadStaffRoomInput(p.world.host, p.world.root, p.world.clock.now));
  assert.deepEqual(model.j2.watches.map((entry) => [entry.id, entry.state, entry.unsigned]), [
    ['WATCH-1', 'proposed', true], ['WATCH-2', 'proposed', true], ['WATCH-3', 'proposed', true], ['WATCH-4', 'proposed', true]
  ]);
  for (const entry of model.j2.watches) assert.equal(entry.drafts, undefined);
  // Without a staff host nothing can prove an arm: the same file reads every one as proposed.
  const hostless = buildStaffRoomModel(await loadStaffRoomInput(undefined, p.world.root, p.world.clock.now));
  assert.ok(hostless.j2.watches.length >= 4 && hostless.j2.watches.every((entry) => entry.state === 'proposed'), JSON.stringify(hostless.j2.watches.map((entry) => entry.state)));
});

test('drafts are checked: a product without the draft line, or not in the ledger, is refused; the outputs bound what a watch may draft', async () => {
  const p = await project();
  await created(p, { outputs: ['draft-intrep', 'alert-person'] });
  await advance(p, 1);
  await p.store.append({ rows: [row(p.world.clock.now)] });
  await p.host.evaluate();
  const tools = toolMap(p);
  await assert.rejects(call(tools, 'watch.draft', { watch: 'WATCH-1', kind: 'ecoa-revision' }, p), /does not draft an adversary COA revision/);
  await assert.rejects(call(tools, 'watch.drafted', { watch: 'WATCH-1' }, p), /is matched; only a watch being drafted/);
  await call(tools, 'watch.draft', { watch: 'WATCH-1', kind: 'intrep' }, p);
  await assert.rejects(call(tools, 'watch.drafted', { watch: 'WATCH-1', products: ['threat-assessment'] }, p), /not in the product ledger/);
  // The member takes the draft line out: refused.
  const product = (await one(p)).drafts![0].product;
  const file = path.join(p.world.root, productPath('j2', product));
  writeFileSync(file, readFileSync(file, 'utf8').replace(/DRAFT for .*\n/, ''));
  await assert.rejects(call(tools, 'watch.drafted', { watch: 'WATCH-1' }, p), /does not say plainly that it is a draft/);
});

test('a member run that ends mid-draft hands the match back, so it never waits forever', async () => {
  const p = await project();
  await created(p);
  await advance(p, 1);
  await p.store.append({ rows: [row(p.world.clock.now)] });
  await p.host.evaluate();
  await call(toolMap(p, 'run-7'), 'watch.draft', { watch: 'WATCH-1', kind: 'intrep' }, p);
  assert.equal((await one(p)).state, 'drafting');
  await p.host.attendanceChanged({ attended: true, holder: { kind: 'run', id: 'run-7' }, change: 'end' });
  const back = await one(p);
  assert.equal(back.state, 'matched');
  assert.equal(back.drafting, undefined);
  assert.match(back.reason ?? '', /ended without reporting drafts/);
});

test('members propose; only a person arms. A proposal names a person to alert, never a member, and may never release or task', async () => {
  const p = await project();
  const tools = toolMap(p);
  const proposed = await call(tools, 'watch.propose', { title: 'Mine laying in the channel', pir: 'PIR-1', indicator: 'IND-1', condition: {}, ltiov: LTIOV, alert: { name: 'K. Sample', role: 'J2' } }, p);
  assert.match(proposed, /WATCH-1 is proposed/);
  assert.equal((await one(p)).state, 'proposed');
  assert.equal((await one(p)).proposedBy, 'member:watch-officer');
  await assert.rejects(call(tools, 'watch.propose', { title: 'x', pir: 'PIR-1', indicator: 'IND-1', condition: {}, ltiov: LTIOV, alert: { name: 'K. Sample', role: 'J2' }, outputs: ['alert-person', 'release'] }, p), /only drafts/);
  await assert.rejects(call(tools, 'watch.propose', { title: 'x', pir: 'PIR-1', indicator: 'IND-1', condition: { label: 'org/Public' }, ltiov: LTIOV, alert: { name: 'K. Sample', role: 'J2' } }, p), /never widens/);
  await assert.rejects(call(tools, 'watch.propose', { title: 'x', pir: 'PIR-1', indicator: 'IND-1', condition: {}, ltiov: LTIOV, alert: { name: 'K. Sample', role: 'J2' } }, p, 'not-a-member'), /Only a member/);
  // The list is fenced as untrusted text.
  const list = await call(tools, 'watch.list', {}, p);
  assert.match(list, /untrusted/i);
  assert.match(list, /WATCH-1 proposed/);
  const armed = await p.host.arm(K_SAMPLE(p), 'WATCH-1');
  assert.ok(armed.ok, armed.ok ? '' : armed.message);
  assert.equal((await one(p)).state, 'armed');
  const rejectedLater = await p.host.retire(K_SAMPLE(p), 'WATCH-1', ['no longer needed']);
  assert.ok(rejectedLater.ok);
  assert.equal((await one(p)).state, 'disarmed');
  assert.equal((await p.world.host.watchDecisions()).get('WATCH-1')?.decision, 'rejected');
});

test('a concurrent edit is refused: a write landing between the host\'s read and its write keeps the member\'s bytes', async () => {
  const p = await project();
  await created(p);
  const file = path.join(p.world.root, STANDING_WATCHES_FILE);
  const theirs = `${readFileSync(file, 'utf8')}\n`;
  setCasProbe((point, target) => { if (point === 'before-rename' && target === file) writeFileSync(file, theirs); });
  try {
    const result = await p.host.pause(K_SAMPLE(p), 'WATCH-1');
    assert.ok(!result.ok);
    assert.equal(result.message, WATCH_CHANGED_TEXT);
  } finally {
    setCasProbe(undefined);
  }
  assert.equal(readFileSync(file, 'utf8'), theirs);
  assert.equal((await one(p)).state, 'armed');
});

test('a register that cannot be read whole refuses every change, never read as empty', async () => {
  const p = await project();
  await created(p);
  const file = path.join(p.world.root, STANDING_WATCHES_FILE);
  writeFileSync(file, readFileSync(file, 'utf8').replace('"label":"org/Internal"', '"label":"org/Secret"'));
  const result = await p.host.pause(K_SAMPLE(p), 'WATCH-1');
  assert.ok(!result.ok && /does not read/.test(result.message));
  const proposed = await p.host.propose({ member: 'watch-officer', run: 'run-1', root: p.world.root, team: J2_TEAM }, { title: 'x', pir: 'PIR-1', indicator: 'IND-1', condition: {}, ltiov: LTIOV, alert: { name: 'K. Sample', role: 'J2' } });
  assert.equal(proposed.ok, false, 'a damaged register is never written over');
});

// ---- Grants and manifests ------------------------------------------------------------------------------------------------------------------

test('the watch tools go only to the members the design names, for interactive runs only; the observations read grant does not reach them', () => {
  const tools = watchTools({ watches: () => undefined, team: J2_TEAM, run: 'run-1' });
  assert.deepEqual(tools.map((tool) => tool.name), [...WATCH_TOOL_NAMES]);
  for (const tool of tools) {
    assert.deepEqual([...tool.manifest.contexts], ['interactive'], `${tool.name}: attended runs only`);
    assert.deepEqual(tool.manifest.hosts, []);
    assert.equal(grantsMcpTool([OBSERVATIONS], tool.name), false, `${tool.name} is not a read grant`);
    assert.equal(grantsMcpTool([OBSERVATIONS_WATCH], tool.name), true);
  }
  for (const template of STAFF_TEMPLATES) {
    let seen = 0;
    for (const rendering of template.renderings().filter((_, index) => index % 5 === 0)) {
      for (const member of parseTeam(rendering.team, '/p/t.md').members) {
        const granted = member.tools.some((entry) => WATCH_TOOL_NAMES.some((name) => grantsMcpTool([entry], name)));
        const expected = template.section === 'j2' && OBSERVATIONS_WATCH_GRANTEES.includes(member.name);
        assert.equal(granted, expected, `${rendering.key}/${member.name}`);
        if (granted) seen += 1;
      }
    }
    if (template.section === 'j2') assert.ok(seen > 0);
  }
});

test('a whole-server observations grant written by hand does not grant the file-writing watch tools: only their own grant does', async () => {
  const handWritten = ['mcp:observations', 'mcp__observations__*', 'mcp__observations__w*', 'mcp__*'];
  for (const name of WATCH_TOOL_NAMES) {
    for (const entry of handWritten) assert.equal(grantsStaffTool([entry], name), false, `${entry} must not grant ${name}`);
    assert.equal(grantsStaffTool([OBSERVATIONS_WATCH], name), true);
    assert.equal(grantsStaffTool([name], name), true, 'the tool by its own name');
  }
  // The read tools still come with the whole server.
  assert.equal(grantsStaffTool(['mcp:observations'], 'mcp__observations__obs_changes'), true);
  // In a run: a member whose tools line says mcp:observations gets the reads but is refused every watch tool; the watch tools are not even offered.
  const team = { members: [{ name: 'osint-analyst', tools: ['mcp:observations'] }, { name: 'watch-officer', tools: [OBSERVATIONS_WATCH] }] };
  const onlyWhole = { members: [team.members[0]] };
  const access = { host: () => undefined, store: () => undefined, team: J2_TEAM, run: 'run-1' };
  const offered = staffServerToolsForRun(onlyWhole, access).map((tool) => tool.name);
  assert.ok(offered.some((name) => name.startsWith('mcp__observations__obs_')));
  assert.ok(!offered.some((name) => WATCH_TOOL_NAMES.includes(name)), 'no member is granted the watch tools, so the run has none');
  const both = staffServerToolsForRun(team, access);
  const watchTool = both.find((tool) => WATCH_TOOL_NAMES.includes(tool.name))!;
  const refusal = await watchTool.forbidden!({} as never, { agentLabel: 'osint-analyst' } as ToolContext);
  assert.match(String(refusal), /mcp__observations__watch_\*/);
  assert.equal(memberGranted(team, 'osint-analyst', watchTool.name), false);
  assert.equal(memberGranted(team, 'watch-officer', watchTool.name), true);
});

test('the contract names every watch event the runtime records', () => {
  const states = new Set<WatchState>(WATCH_STATES);
  for (const rule of WATCH_TRANSITIONS) { assert.ok(states.has(rule.to)); for (const from of rule.from) assert.ok(states.has(from)); }
  const events = new Set<WatchEvent>(WATCH_EVENTS);
  for (const rule of WATCH_TRANSITIONS) assert.ok(events.has(rule.event));
});
