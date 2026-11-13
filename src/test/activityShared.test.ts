import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import type { ActivitySessionSummary } from '../domain/activity';
import { ActivityStore, closeInterruptedRuns, mergeSessions } from '../services/activityStore';
import { RunMarkers } from '../services/runMarkers';
import { stateHomeFor } from '../services/stateHome';
import { tempProject } from './helpers/stateFixtures';

// Phase 27, plan 04 (Pitfall 6): activity.json is written by every editor on the project. Each write reads the file, merges by session id and
// writes atomically, so neither editor's sessions are lost, and opening a second editor never closes the first editor's live run in the history.

const RUN = 'run-1793570629237-876b3a';
const CONV = 'conv-live00-0a0b0c0d';
const MINUTE = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

test('two stores on one project, interleaved: the file ends with both sessions and every event of each', async () => {
  const root = await tempProject();
  try {
    let tick = Date.parse('2026-11-12T10:00:00.000Z');
    const clock = () => iso((tick += 1_000));
    const desktop = new ActivityStore(root, { clock });
    const browser = new ActivityStore(root, { clock });
    await desktop.start({ sessionId: 'session-desktop-0001', project: 'demo', summary: 'Agent conversation turn started.' });
    await browser.start({ sessionId: 'session-browser-0001', project: 'demo', summary: 'Agent conversation turn started.' });
    for (let step = 0; step < 4; step += 1) {
      await desktop.append('session-desktop-0001', { status: 'running', kind: 'tool', summary: `Desktop step ${step}.` });
      await browser.append('session-browser-0001', { status: 'running', kind: 'tool', summary: `Browser step ${step}.` });
    }
    await Promise.all([
      desktop.append('session-desktop-0001', { status: 'completed', kind: 'message', summary: 'Assistant response completed.' }),
      browser.append('session-browser-0001', { status: 'completed', kind: 'message', summary: 'Assistant response completed.' })
    ]);
    await Promise.all([desktop.flush(), browser.flush()]);
    const read = new ActivityStore(root);
    const sessions = await read.list();
    assert.deepEqual(sessions.map((session) => session.sessionId).sort(), ['session-browser-0001', 'session-desktop-0001']);
    for (const [id, label] of [['session-desktop-0001', 'Desktop'], ['session-browser-0001', 'Browser']] as const) {
      const session = (await read.get(id))!;
      assert.equal(session.events.filter((event) => event.summary === `${label} step 0.` || event.summary === `${label} step 3.`).length, 2);
      assert.equal(session.events.length, 1 + 4 + 1, `${label}: the start, four steps and the end, none lost`);
      assert.equal(session.outcome, 'completed');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

function session(id: string, startedAt: number, updatedAt: number, events: number, extra: Partial<ActivitySessionSummary> = {}): ActivitySessionSummary {
  return { version: 1, sessionId: id, project: 'demo', attribution: {} as never, plans: [], agents: {} as never, models: [], approvals: { required: 0, approved: 0, pending: 0 }, startedAt: iso(startedAt), updatedAt: iso(updatedAt), outcome: 'running', continuationAvailable: true, context: { userTurns: 0, assistantTurns: 0 }, events: Array.from({ length: events }, (_, index) => ({ id: `${id}-${index}` }) as never), ...extra };
}

test('mergeSessions: the newer updatedAt wins, a tie goes to the copy with more events then to memory, and the union of ids never shrinks', () => {
  const t = Date.parse('2026-11-12T10:00:00.000Z');
  const disk = [session('session-aaaaaaaa', t, t + 5_000, 2, { title: 'disk' }), session('session-bbbbbbbb', t + 1, t + 2_000, 1, { title: 'disk' }), session('session-cccccccc', t + 2, t + 1_000, 3, { title: 'disk' }), session('session-dddddddd', t + 3, t + 1_000, 1, { title: 'disk' }), session('session-onlydisk', t + 4, t, 0)];
  const memory = [session('session-aaaaaaaa', t, t + 1_000, 9, { title: 'memory' }), session('session-bbbbbbbb', t + 1, t + 9_000, 9, { title: 'memory' }), session('session-cccccccc', t + 2, t + 1_000, 1, { title: 'memory' }), session('session-dddddddd', t + 3, t + 1_000, 1, { title: 'memory' }), session('session-onlymemo', t + 5, t, 0)];
  const merged = mergeSessions(disk, memory);
  const byId = new Map(merged.map((item) => [item.sessionId, item]));
  assert.equal(byId.get('session-aaaaaaaa')?.title, 'disk', 'the disk copy was updated later, so it replaces the older memory copy');
  assert.equal(byId.get('session-bbbbbbbb')?.title, 'memory', 'the memory copy was updated later');
  assert.equal(byId.get('session-cccccccc')?.title, 'disk', 'a tie: the copy with more events');
  assert.equal(byId.get('session-dddddddd')?.title, 'memory', 'a tie in events too: the memory copy');
  assert.deepEqual([...byId.keys()].sort(), ['session-aaaaaaaa', 'session-bbbbbbbb', 'session-cccccccc', 'session-dddddddd', 'session-onlydisk', 'session-onlymemo'], 'union of ids');
  assert.deepEqual(merged.map((item) => item.sessionId), ['session-onlymemo', 'session-onlydisk', 'session-dddddddd', 'session-cccccccc', 'session-bbbbbbbb', 'session-aaaaaaaa'], 'newest started first');
  const split = { wall: 1 } as never;
  assert.equal(mergeSessions([session('session-eeeeeeee', t, t + 9, 1)], [session('session-eeeeeeee', t, t + 1, 1, { run: split })])[0].run, split, 'a run split written once is kept by whichever copy has it');
});

test('closeInterrupted: a session another editor keeps alive stays running, the others are closed as today', async () => {
  const root = await tempProject();
  try {
    let now = Date.parse('2026-11-12T10:00:00.000Z');
    const store = new ActivityStore(root, { clock: () => iso(now) });
    const live = await store.start({ sessionId: 'session-live-00001', project: 'demo', runId: RUN, conversationId: CONV, summary: 'Agent conversation turn started.' });
    const dead = await store.start({ sessionId: 'session-dead-00001', project: 'demo', runId: 'run-1793570629999-aaaaaa', conversationId: 'conv-dead00-0a0b0c0d', summary: 'Agent conversation turn started.' });
    now += 10 * MINUTE;
    const closed = await store.closeInterrupted(undefined, (candidate) => candidate.sessionId === live.sessionId);
    assert.equal(closed, 1);
    assert.equal((await store.get(live.sessionId))?.outcome, 'running');
    assert.equal((await store.get(dead.sessionId))?.outcome, 'cancelled');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('closeInterrupted: a running session with no run link is left alone for 3 minutes, then closed', async () => {
  const root = await tempProject();
  try {
    let now = Date.parse('2026-11-12T10:00:00.000Z');
    const store = new ActivityStore(root, { clock: () => iso(now) });
    await store.start({ sessionId: 'session-nolink-0001', project: 'demo', summary: 'Chat view session started.' });
    now += 2 * MINUTE;
    assert.equal(await store.closeInterrupted(undefined, () => false), 0, 'updated 2 minutes ago: it may be another editor\'s');
    assert.equal((await store.get('session-nolink-0001'))?.outcome, 'running');
    now += 2 * MINUTE;
    assert.equal(await store.closeInterrupted(undefined, () => false), 1, '4 minutes of silence: closed as today');
    assert.equal((await store.get('session-nolink-0001'))?.outcome, 'cancelled');
    // Without a predicate nothing changes: a fresh unlinked session is closed at once, as before this plan.
    await store.start({ sessionId: 'session-nolink-0002', project: 'demo', summary: 'Chat view session started.' });
    assert.equal(await store.closeInterrupted(), 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('closeInterruptedRuns(root, writer): a fresh marker from another editor keeps its session open; a silent one does not', async () => {
  const root = await tempProject();
  const quiet = await tempProject();
  try {
    const writeSession = async (project: string, conversationId: string, runId: string, minutesSilent: number) => {
      const marker = new RunMarkers('', project, { dir: stateHomeFor(project).paths.runs, writer: 'edbbbbbb.inst0001', pid: 4242, now: () => Date.now() - minutesSilent * MINUTE });
      await marker.start({ conversationId, runId });
      marker.dispose();
      const store = new ActivityStore(project);
      await store.start({ sessionId: `session-${conversationId.slice(5, 11)}-0001`, project: 'demo', runId, conversationId, summary: 'Agent conversation turn started.' });
      return store;
    };
    const busy = await writeSession(root, CONV, RUN, 0);
    assert.equal(await closeInterruptedRuns(root, 'edaaaaaa.inst0001'), 0, 'the other editor is still running it');
    assert.equal((await busy.get(`session-${CONV.slice(5, 11)}-0001`))?.outcome, 'running');
    await writeSession(quiet, CONV, RUN, 10);
    assert.equal(await closeInterruptedRuns(quiet, 'edaaaaaa.inst0001'), 1, 'ten minutes without a heartbeat: cut off, so closed');
    assert.equal((await new ActivityStore(quiet).get(`session-${CONV.slice(5, 11)}-0001`))?.outcome, 'cancelled');
    // The still-open session in the first project is re-read from the file, not from the store that wrote it.
    assert.equal((await new ActivityStore(root).get(`session-${CONV.slice(5, 11)}-0001`))?.outcome, 'running');
  } finally { await rm(root, { recursive: true, force: true }); await rm(quiet, { recursive: true, force: true }); }
});
