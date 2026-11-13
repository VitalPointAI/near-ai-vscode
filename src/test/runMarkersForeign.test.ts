import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test, { mock } from 'node:test';
import { autoResumeChoice, FOREIGN_LIVE_MS, HEARTBEAT_MS, ownEditorMarkers, parseRunMarker, RunMarkers } from '../services/runMarkers';
import { editorWriter, stateHomeFor, writerEditor } from '../services/stateHome';
import { tempProject } from './helpers/stateFixtures';

// Phase 27, plan 04 (SYNC-01, SYNC-07): two editors share one project's run markers. The pid of another editor means nothing in this
// pid namespace, so a writer id and a heartbeat decide whether a run is live, and nothing resumes by itself because of another editor's marker.

const CONV = 'conv-live00-0a0b0c0d';
const RUN = 'run-1793570629237-876b3a';
const MINUTE = 60_000;

function pair(runs: string, clock: { now: number }, options: { aliveB?: (pid: number) => boolean } = {}) {
  const a = new RunMarkers('', '/p', { dir: runs, writer: 'edaaaaaa.inst0001', pid: 111, now: () => clock.now, alive: () => true });
  const b = new RunMarkers('', '/p', { dir: runs, writer: 'edbbbbbb.inst0001', pid: 222, now: () => clock.now, alive: options.aliveB ?? (() => true) });
  return { a, b };
}

test('tracer: a live run in editor A is running elsewhere in editor B, never cut off, never auto-resumed', async () => {
  const root = await tempProject();
  try {
    const runs = stateHomeFor(root).paths.runs;
    const clock = { now: Date.parse('2026-11-12T10:00:00.000Z') };
    const { a, b } = pair(runs, clock, { aliveB: () => false });
    await a.start({ conversationId: CONV, runId: RUN, model: 'z-ai/glm-5.3' });
    clock.now += 2 * MINUTE;
    const marker = (await b.markerOf(CONV))!;
    assert.equal(b.runState(marker), 'running-elsewhere', "2 minutes in: B's pid check says gone, but a pid of another editor is not trusted");
    assert.deepEqual(await b.interrupted(), []);
    assert.equal(await b.liveElsewhere(CONV), true);
    assert.equal(await b.liveElsewhere(CONV, RUN), true);
    assert.equal(await b.liveElsewhere(CONV, 'run-2-bbbbbb'), false, 'a different run is not the live one');
    clock.now += 2 * MINUTE;
    assert.equal(b.runState((await b.markerOf(CONV))!), 'cut-off', 'after 4 minutes of silence it is cut off');
    assert.equal(await b.liveElsewhere(CONV), false);
    assert.equal(a.runState((await a.markerOf(CONV))!), 'running-here', 'the writer itself is running here');
    // The writer is stored in the file, and nothing else about editors or hosts.
    const raw = JSON.parse(await readFile(path.join(runs, `${CONV}.json`), 'utf8')) as Record<string, unknown>;
    assert.equal(raw.version, 2);
    assert.equal(raw.writer, 'edaaaaaa.inst0001');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a heartbeat keeps the run running elsewhere however long it lasts', async () => {
  const root = await tempProject();
  try {
    const runs = stateHomeFor(root).paths.runs;
    const clock = { now: Date.parse('2026-11-12T10:00:00.000Z') };
    const { a, b } = pair(runs, clock);
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      await a.start({ conversationId: CONV, runId: RUN });
      for (let minute = 0; minute < 10; minute += 1) {
        for (let beat = 0; beat < 2; beat += 1) { clock.now += HEARTBEAT_MS; mock.timers.tick(HEARTBEAT_MS); await a.idle(); }
      }
      assert.equal(b.runState((await b.markerOf(CONV))!), 'running-elsewhere', 'ten minutes in, still live because it kept saying so');
      assert.equal((await b.markerOf(CONV))!.activeAt, new Date(clock.now).toISOString());
      await a.end(CONV, RUN, 'completed');
      const written = (await b.markerOf(CONV))!;
      clock.now += 5 * MINUTE;
      mock.timers.tick(HEARTBEAT_MS * 4);
      await a.idle();
      assert.deepEqual(await b.markerOf(CONV), written, 'after end() no heartbeat writes again');
      assert.equal(b.runState(written), 'finished');
    } finally { mock.timers.reset(); }
    assert.ok(HEARTBEAT_MS === 30_000 && FOREIGN_LIVE_MS === 180_000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the same editor after a reload: a gone pid is cut off at once, a live one is left alone', async () => {
  const root = await tempProject();
  try {
    const runs = stateHomeFor(root).paths.runs;
    const clock = { now: Date.parse('2026-11-12T10:00:00.000Z') };
    const before = new RunMarkers('', '/p', { dir: runs, writer: 'edaaaaaa.inst0000', pid: 100, now: () => clock.now });
    await before.start({ conversationId: CONV, runId: RUN });
    clock.now += 5_000;
    const after = new RunMarkers('', '/p', { dir: runs, writer: 'edaaaaaa.inst0001', pid: 111, now: () => clock.now, alive: () => false });
    assert.equal(after.runState((await after.markerOf(CONV))!), 'cut-off', 'PERF-05: this editor reloaded, its old host is gone');
    assert.deepEqual((await after.interrupted()).map((marker) => marker.conversationId), [CONV]);
    const sibling = new RunMarkers('', '/p', { dir: runs, writer: 'edaaaaaa.inst0001', pid: 111, now: () => clock.now, alive: () => true });
    assert.equal(sibling.runState((await sibling.markerOf(CONV))!), 'running-elsewhere', 'another window of this editor is still running it');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('SYNC-07: only this editor\'s cut-off markers can resume by themselves; another editor\'s keeps its Resume button', async () => {
  const root = await tempProject();
  try {
    const runs = stateHomeFor(root).paths.runs;
    const clock = { now: Date.parse('2026-11-12T10:00:00.000Z') };
    const mine = new RunMarkers('', '/p', { dir: runs, writer: 'edaaaaaa.inst0000', pid: 100, now: () => clock.now });
    const theirs = new RunMarkers('', '/p', { dir: runs, writer: 'edbbbbbb.inst0000', pid: 200, now: () => clock.now });
    await mine.start({ conversationId: 'conv-mine00-00000001', runId: 'run-1-aaaaaa' });
    await theirs.start({ conversationId: 'conv-theirs-00000002', runId: 'run-2-bbbbbb' });
    clock.now += 10 * MINUTE;
    const reader = new RunMarkers('', '/p', { dir: runs, writer: 'edaaaaaa.inst0001', pid: 111, now: () => clock.now, alive: () => false });
    const cut = await reader.interrupted();
    assert.deepEqual(cut.map((marker) => marker.conversationId).sort(), ['conv-mine00-00000001', 'conv-theirs-00000002'], 'both are cut off and both reopen with a Resume button');
    const own = ownEditorMarkers(cut, 'edaaaaaa.inst0001');
    assert.deepEqual(own.map((marker) => marker.conversationId), ['conv-mine00-00000001']);
    const chosen = autoResumeChoice(own, { enabled: true, emergencyStopped: false, now: clock.now });
    assert.deepEqual(chosen.map((marker) => marker.conversationId), ['conv-mine00-00000001'], 'this editor\'s own reload still resumes as in 0.4.19');
    assert.equal(chosen.some((marker) => marker.writer?.startsWith('edbbbbbb')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a version 1 marker (no writer) still parses and counts as another editor\'s: cut off only after 3 minutes without activity', async () => {
  const root = await tempProject();
  try {
    const runs = stateHomeFor(root).paths.runs;
    const clock = { now: Date.parse('2026-11-12T10:00:00.000Z') };
    const v1 = { version: 1, conversationId: CONV, runId: RUN, pid: 7, startedAt: new Date(clock.now).toISOString(), activeAt: new Date(clock.now).toISOString(), steps: ['Bash'] };
    assert.equal(parseRunMarker(v1, CONV)?.writer, undefined);
    await mkdir(runs, { recursive: true });
    await writeFile(path.join(runs, `${CONV}.json`), JSON.stringify(v1));
    const reader = new RunMarkers('', '/p', { dir: runs, writer: 'edaaaaaa.inst0001', pid: 111, now: () => clock.now, alive: () => false });
    clock.now += 2 * MINUTE;
    assert.equal(reader.runState((await reader.markerOf(CONV))!), 'running-elsewhere');
    clock.now += 2 * MINUTE;
    assert.equal(reader.runState((await reader.markerOf(CONV))!), 'cut-off');
    assert.deepEqual(ownEditorMarkers(await reader.interrupted(), 'edaaaaaa.inst0001'), [], 'a marker without a writer never auto-resumes');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('markers are written without colliding temporary names, and a bad writer is refused on read', async () => {
  const root = await tempProject();
  try {
    const runs = stateHomeFor(root).paths.runs;
    const a = new RunMarkers('', '/p', { dir: runs, writer: 'edaaaaaa.inst0001', pid: 111 });
    const b = new RunMarkers('', '/p', { dir: runs, writer: 'edbbbbbb.inst0001', pid: 111 });
    await Promise.all([a.start({ conversationId: CONV, runId: RUN }), b.start({ conversationId: 'conv-other0-00000002', runId: 'run-2-bbbbbb' })]);
    assert.deepEqual((await readdir(runs)).sort(), [CONV + '.json', 'conv-other0-00000002.json']);
    const good = { version: 2, conversationId: CONV, runId: RUN, pid: 1, writer: 'edaaaaaa.inst0001', startedAt: '2026-11-12T10:00:00.000Z', activeAt: '2026-11-12T10:00:00.000Z', steps: [] };
    assert.equal(parseRunMarker(good, CONV)?.writer, 'edaaaaaa.inst0001');
    for (const writer of [undefined, '', 'nodot', '../x.y', 'AAAAAA.bbbbbb', 'a.b']) assert.equal(parseRunMarker({ ...good, writer }, CONV), undefined, String(writer));
    assert.equal(writerEditor('edaaaaaa.inst0001'), 'edaaaaaa');
    assert.equal(writerEditor(undefined), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('editorWriter keeps one editor id in globalState and a new instance id per host', () => {
  const store = new Map<string, unknown>();
  const memento = { get: <T>(key: string) => store.get(key) as T | undefined, update: async (key: string, value: unknown) => { store.set(key, value); } };
  const first = editorWriter(memento);
  const second = editorWriter(memento);
  assert.equal(first, second);
  assert.match(first, /^[a-z0-9]{12}\.[a-z0-9]{12}$/);
  assert.equal(store.get('nearAi.state.editorId'), writerEditor(first));
  const otherEditor = editorWriter({ get: () => undefined, update: async () => undefined });
  assert.notEqual(writerEditor(otherEditor), writerEditor(first));
  assert.match(editorWriter(), /^[a-z0-9]{12}\.[a-z0-9]{12}$/);
});
