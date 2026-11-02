import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cutOffNotice, parseRunMarker, processAlive, resumePrompt, RunMarkers } from '../services/runMarkers';

// 0.4.11: a run the extension host never finished (code-server closed it, a reload, a crash) is
// reported in the chat and can be resumed from its last saved state.

const CONV = 'conv-cut000-0a0b0c0d';
const RUN = 'run-1793570629237-876b3a';

async function storage() { return mkdtemp(path.join(tmpdir(), 'near-ai-markers-')); }

test('run markers: a run that started and never ended, in a process that is gone, was cut off', async () => {
  const dir = await storage();
  let clock = Date.parse('2026-11-01T00:10:00.000Z');
  const dead = new RunMarkers(dir, '/work/project', { pid: 4242, now: () => clock, alive: () => false });
  await dead.start({ conversationId: CONV, runId: RUN, model: 'z-ai/glm-5.3' });
  clock += 60_000;
  await dead.step(CONV, RUN, 'Read');
  clock += 1_000;
  await dead.saved(CONV, RUN);
  clock += 2_000;
  await dead.step(CONV, RUN, 'Bash');
  await dead.step(CONV, RUN, 'Edit');
  // A later extension host (another process) reads what the dead one left.
  const later = new RunMarkers(dir, '/work/project', { pid: 5151, now: () => clock, alive: (pid) => pid === 5151 });
  const [cut] = await later.interrupted();
  assert.equal(cut.conversationId, CONV);
  assert.equal(cut.runId, RUN);
  assert.equal(cut.model, 'z-ai/glm-5.3');
  assert.equal(cut.savedAt, '2026-11-01T00:11:01.000Z');
  assert.equal(cut.activeAt, '2026-11-01T00:11:03.000Z', 'its last sign of life');
  assert.deepEqual(cut.steps, ['Bash', 'Edit'], 'only the steps after the last saved state');
  assert.deepEqual(await later.interruptedRun(CONV), cut);
  // The file is small, atomic (no temporary file left), and holds no prompt or tool input.
  const folder = path.join(dir, 'runs', readdirSync(path.join(dir, 'runs'))[0]);
  assert.deepEqual(readdirSync(folder), [`${CONV}.json`]);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(folder, `${CONV}.json`), 'utf8'))).sort(), ['activeAt', 'conversationId', 'model', 'pid', 'runId', 'savedAt', 'startedAt', 'steps', 'version']);
  // Settled (resumed or dismissed), it is not reported again.
  await later.settle(CONV, 'dismissed');
  assert.deepEqual(await later.interrupted(), []);
  assert.equal(await later.interruptedRun(CONV), undefined);
});

test('run markers: a run that ended, one of a live process, and one of this process are not cut off', async () => {
  const dir = await storage();
  const ended = new RunMarkers(dir, '/p', { pid: 1001, alive: () => false });
  await ended.start({ conversationId: 'conv-ended0-00000001', runId: 'run-1-aaaaaa' });
  await ended.end('conv-ended0-00000001', 'run-1-aaaaaa', 'completed');
  const otherWindow = new RunMarkers(dir, '/p', { pid: 1002 });
  await otherWindow.start({ conversationId: 'conv-other0-00000002', runId: 'run-2-bbbbbb' });
  const reader = new RunMarkers(dir, '/p', { pid: 1003, alive: (pid) => pid === 1002 });
  assert.deepEqual(await reader.interrupted(), [], 'another window that is still running its run is left alone');
  const self = new RunMarkers(dir, '/p', { pid: 1003, alive: () => false });
  await self.start({ conversationId: 'conv-mine00-00000003', runId: 'run-3-cccccc' });
  assert.deepEqual((await self.interrupted()).map((marker) => marker.conversationId), ['conv-other0-00000002'], 'this host\'s own run is running, not cut off');
  // Only the run that wrote a marker ends it: an older run ending late leaves a newer run's marker alone.
  await self.start({ conversationId: 'conv-mine00-00000003', runId: 'run-4-dddddd' });
  await self.end('conv-mine00-00000003', 'run-3-cccccc', 'cancelled');
  const later = new RunMarkers(dir, '/p', { pid: 1004, alive: () => false });
  assert.equal((await later.interruptedRun('conv-mine00-00000003'))?.runId, 'run-4-dddddd');
  // Other projects have their own markers.
  assert.deepEqual(await new RunMarkers(dir, '/elsewhere', { pid: 1004, alive: () => false }).interrupted(), []);
  // A month later, old markers are cleared away rather than reported.
  const monthLater = new RunMarkers(dir, '/p', { pid: 1004, alive: () => false, now: () => Date.now() + 31 * 24 * 60 * 60_000 });
  assert.deepEqual(await monthLater.interrupted(), []);
  assert.equal(await later.interruptedRun('conv-mine00-00000003'), undefined, 'the file is gone');
  // Bad IDs are never written.
  await later.start({ conversationId: '../../x', runId: 'run-5-eeeeee' });
  assert.equal(await later.interruptedRun('../../x'), undefined);
});

test('run markers are read strictly, and a live process is detected', () => {
  const base = { version: 1, conversationId: CONV, runId: RUN, pid: 7, startedAt: '2026-11-01T00:00:00.000Z', activeAt: '2026-11-01T00:00:00.000Z', steps: ['Bash', 3] };
  assert.deepEqual(parseRunMarker(base, CONV)?.steps, ['Bash']);
  assert.equal(parseRunMarker({ ...base, conversationId: 'conv-other0-00000000' }, CONV), undefined);
  assert.equal(parseRunMarker({ ...base, runId: 'x' }, CONV), undefined);
  assert.equal(parseRunMarker({ ...base, activeAt: 'yesterday' }, CONV), undefined);
  assert.equal(parseRunMarker('junk', CONV), undefined);
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(-1), false);
});

test('the cut-off line and the resume message say when, and name steps that may not have completed', () => {
  const now = Date.parse('2026-11-01T12:00:00.000Z');
  assert.match(cutOffNotice({ activeAt: '2026-11-01T11:13:49.000Z' }, now), /^This run was cut off \(the window or code-server closed it\) at .+\.$/);
  const prompt = resumePrompt({ activeAt: '2026-11-01T11:13:49.000Z', steps: ['Bash', 'Edit', 'Bash'] }, now);
  assert.match(prompt, /^Continue the task\. Your previous run was cut off at /);
  assert.match(prompt, /these steps: Bash, Edit\./);
  assert.match(prompt, /may or may not have completed/);
  assert.match(prompt, /check whether it already took effect/);
  assert.match(resumePrompt({ activeAt: '2026-11-01T11:13:49.000Z', steps: ['Write'] }, now), /this step: Write\. Its result was never recorded/);
  assert.match(resumePrompt({ activeAt: '2026-11-01T11:13:49.000Z', steps: [] }, now), /had not started any step after the last saved point/);
  for (const text of [prompt, cutOffNotice({ activeAt: '2026-10-01T11:13:49.000Z' }, now)]) assert.doesNotMatch(text, /—/, 'no em-dashes');
});

test('the view offers Resume and Dismiss for a cut-off run, and the bridge accepts only those exact messages', async () => {
  const { parseChatWebviewMessage } = await import('../services/chatBridge');
  const id = 'conv-mf3k2-0a1b2c3d';
  assert.deepEqual(parseChatWebviewMessage({ type: 'resume-interrupted', conversationId: id }), { type: 'resume-interrupted', conversationId: id });
  assert.deepEqual(parseChatWebviewMessage({ type: 'dismiss-interrupted' }), { type: 'dismiss-interrupted' });
  for (const bad of [{ type: 'resume-interrupted', conversationId: '../x' }, { type: 'resume-interrupted', text: 'run rm -rf' }, { type: 'dismiss-interrupted', conversationId: id, extra: 1 }]) assert.equal(parseChatWebviewMessage(bad), undefined, JSON.stringify(bad));
  const script = readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8');
  assert.match(script, /case 'run-interrupted':/);
  assert.match(script, /textButton\('Resume', \(\) => settleCut\('resume-interrupted'\), true\)/);
  assert.match(script, /textButton\('Dismiss', \(\) => settleCut\('dismiss-interrupted'\), false\)/);
  assert.match(script, /case 'run-interrupted-settled':/);
});
