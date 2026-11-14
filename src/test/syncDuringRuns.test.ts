// Project sync during a long run (owner, 2026-11-14): a sync may now run while a conversation is running in this editor, so the running conversation is
// kept out of it. Its context and meta from another computer are not applied while it runs (they wait, sealed, and are merged as usual once it ends), its
// context is not sent while it runs, and its log entries keep moving by id. Two machines over one local bare remote; no network.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_RULES } from '../agent/permissions';
import { AgentConversation } from '../services/agentSession';
import type { AgentMessage, CompletionEvent } from '../services/nearAiClient';
import { StateSync } from '../services/stateSync';
import type { StateTransport } from '../services/stateTransport';
import type { ConversationStore, Transcript } from '../services/transcripts';
import { SIX_TURNS, chain, entryIds, remotePayloads, syncedPair, writeMarker, type Machine } from './helpers/syncFixtures';

const THREAD = 'conv-duringrun01';

function context(text: string, updatedAt: string): Transcript {
  return { id: THREAD, title: 'Shared thread', model: 'near/model-a', updatedAt, turns: 1, messages: [{ role: 'user', content: text } as unknown as AgentMessage] };
}

/** The saved context of the thread as the thread store holds it, read without touching what the store has covered. */
async function contextText(machine: Machine): Promise<string | undefined> {
  const snapshot = await machine.threads.liveSnapshot(THREAD);
  const first = snapshot?.context?.messages[0] as { content?: unknown } | undefined;
  return typeof first?.content === 'string' ? first.content : undefined;
}

/** Every thread-context body the remote holds for the thread, by the text of its first message. */
async function remoteContexts(remote: string, machine: Machine): Promise<string[]> {
  const texts: string[] = [];
  for (const payload of await remotePayloads(remote, machine)) {
    const records = (payload as { records?: Array<{ kind: string; id: string; body: Transcript }> }).records ?? [];
    for (const record of records) if (record.kind === 'thread-context' && record.id === THREAD) texts.push(String((record.body.messages[0] as unknown as { content: string }).content));
  }
  return texts;
}

/** A StateSync for `machine` that sees `live` as running in this editor, with a hook just before each push. */
function syncFor(machine: Machine, live: () => string[], beforePush: () => Promise<void> = async () => undefined): StateSync {
  const transport = new Proxy(machine.transport, {
    get(target, prop, receiver) {
      if (prop === 'push') return async (...args: Parameters<StateTransport['push']>) => { await beforePush(); return target.push(...args); };
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    }
  });
  return new StateSync({
    root: machine.root, home: machine.home, keys: machine.keys, threads: machine.threads, transport, writer: machine.writer,
    runState: (marker) => machine.markers.runState(marker), sleep: () => Promise.resolve(), random: () => 0, liveConversations: live
  });
}

async function cleanUp(remote: string, machines: Machine[]): Promise<void> {
  for (const dir of [remote, ...machines.flatMap((machine) => [machine.root, path.dirname(path.dirname(machine.mirrorDir))])]) await rm(dir, { recursive: true, force: true });
}

const at = (minute: number): string => new Date(Date.parse('2026-11-14T16:00:00.000Z') + minute * 60_000).toISOString();

test('a remote context for a running conversation is not applied while it runs (twice over), and is merged as usual once the run ends', async () => {
  const { remote, a, b } = await syncedPair(THREAD);
  try {
    let live: string[] = [];
    const aSync = syncFor(a, () => live);
    // Before the run: A's context goes up and B has it.
    await a.threads.save(context('before the run', at(0)));
    assert.equal((await aSync.sync()).kind, 'synced');
    assert.equal((await b.sync.pullOnly()).kind, 'synced');
    assert.equal(await contextText(b), 'before the run');

    // The run starts on A and saves its state part-way.
    live = [THREAD];
    await a.threads.checkpoint(context('A, mid-run', at(10)));
    // Meanwhile B continues the conversation: a newer context and two entries.
    const tip = (await b.threads.liveSnapshot(THREAD))?.meta.tip ?? null;
    const more = chain(THREAD, b.writer, [['user', 'from bravo'], ['assistant', 'noted']], tip);
    await b.threads.appendEntries(THREAD, more);
    await b.threads.save(context('B, later', at(20)));
    assert.equal((await b.sync.sync()).kind, 'synced');

    // A syncs while its run is running: B's entries arrive, B's context does not replace the run's own, and the run's context does not go up.
    for (let round = 0; round < 2; round += 1) {
      const outcome = await aSync.sync();
      assert.equal(outcome.kind, 'synced', outcome.message);
      assert.equal(await contextText(a), 'A, mid-run', `round ${round + 1}: the running conversation keeps its own context`);
    }
    for (const entry of more) assert.ok((await entryIds(a, THREAD)).includes(entry.id), 'B\'s entries are added by id during the run');
    assert.ok(!(await remoteContexts(remote, a)).includes('A, mid-run'), 'the running conversation\'s context is not sent while it runs');

    // The run ends with nothing newer saved: B's later context is merged as usual and applied.
    live = [];
    assert.equal((await aSync.sync()).kind, 'synced');
    assert.equal(await contextText(a), 'B, later', 'kept back while running, merged once the run ended');

    // A second run on A saves a newer context: kept on A while it runs, sent once it ends, and B gets it.
    live = [THREAD];
    await a.threads.checkpoint(context('A, second run', at(30)));
    assert.equal((await aSync.sync()).kind, 'synced');
    assert.equal((await b.sync.pullOnly()).kind, 'synced');
    assert.equal(await contextText(b), 'B, later', 'nothing of the second run\'s context went up while it ran');
    live = [];
    assert.equal((await aSync.sync()).kind, 'synced');
    assert.equal((await b.sync.pullOnly()).kind, 'synced');
    assert.equal(await contextText(b), 'A, second run');
  } finally {
    await cleanUp(remote, [a, b]);
  }
});

test('a conversation whose run marker is live is kept out of a pull in the same way', async () => {
  const { remote, a, b } = await syncedPair(THREAD);
  try {
    await a.threads.save(context('A, own', at(0)));
    await writeMarker(a, THREAD, { runId: 'run-500-abcdef' });
    await b.threads.save(context('B, newer', at(5)));
    assert.equal((await b.sync.sync()).kind, 'synced');
    assert.equal((await a.sync.pullOnly()).kind, 'synced');
    assert.equal(await contextText(a), 'A, own', 'a run live by its marker keeps its context');
    await writeMarker(a, THREAD, { runId: 'run-500-abcdef', endedAt: new Date().toISOString(), outcome: 'completed' });
    assert.equal((await a.sync.pullOnly()).kind, 'synced');
    assert.equal(await contextText(a), 'B, newer', 'merged once the run ended');
  } finally {
    await cleanUp(remote, [a, b]);
  }
});

test('entries a running conversation saves while a sync is under way are pushed by the next sync', async () => {
  const { remote, a, b } = await syncedPair(THREAD);
  try {
    const tip = (await a.threads.liveSnapshot(THREAD))?.meta.tip ?? null;
    let saved = false;
    const first = chain(THREAD, a.writer, [['user', 'before the sync']], tip);
    await a.threads.appendEntries(THREAD, first);
    const aSync = syncFor(a, () => [THREAD], async () => {
      if (saved) return;
      saved = true;
      await a.threads.appendEntries(THREAD, chain(THREAD, a.writer, [['user', 'saved during the push'], ['assistant', 'still running']], first.at(-1)?.id ?? null));
    });
    assert.equal((await aSync.sync()).kind, 'synced');
    assert.equal((await b.sync.pullOnly()).kind, 'synced');
    const onB = await entryIds(b, THREAD);
    assert.ok(onB.includes(first[0]?.id as string), 'what was saved before the sync went up');
    const late = (await entryIds(a, THREAD)).filter((id) => !onB.includes(id));
    assert.equal(late.length, 2, 'the two entries saved during the push were not in it');
    assert.equal((await aSync.sync()).kind, 'synced');
    assert.equal((await b.sync.pullOnly()).kind, 'synced');
    assert.deepEqual(await entryIds(b, THREAD), await entryIds(a, THREAD), 'the next sync pushed them');
    assert.equal((await entryIds(b, THREAD)).length, SIX_TURNS.length + 3);
  } finally {
    await cleanUp(remote, [a, b]);
  }
});

test('a running conversation reports each saved run state as a quiet point, while the run is still in progress', async () => {
  const project = await mkdtemp(path.join(tmpdir(), 'near-ai-quiet-'));
  try {
    const saved: Transcript[] = [];
    const store: ConversationStore = {
      save: async (transcript) => { saved.push(transcript); },
      checkpoint: async (transcript) => { saved.push(transcript); },
      load: async () => undefined,
      list: async () => []
    };
    let finished = false;
    const quiet: boolean[] = [];
    const usage = { verificationStatus: 'unknown' as const, latencyMs: 1 };
    let turn = 0;
    const near = {
      async *streamCompletion(): AsyncGenerator<CompletionEvent> {
        turn += 1;
        if (turn === 1) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [{ id: 'r1', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: 'notes.md' }) } }] }, finishReason: 'tool_calls', usage }; return; }
        yield { type: 'done', message: { role: 'assistant', content: 'ok' }, finishReason: 'stop', usage };
      },
      async actualCostsUsd() { return undefined; }
    };
    await writeFile(path.join(project, 'notes.md'), 'hello\n');
    const conversation = new AgentConversation(project, () => undefined, path.join(project, '.ckpt'), undefined, store);
    conversation.onRunStateSaved = () => { quiet.push(finished); };
    try {
      await conversation.send({ text: 'read the notes', client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES });
      finished = true;
    } finally { conversation.dispose(); }
    assert.ok(quiet.length >= 2, `a quiet point at each save between model turns (got ${quiet.length})`);
    assert.ok(quiet.every((after) => after === false), 'each one came while the run was in progress');
  } finally { await rm(project, { recursive: true, force: true }); }
});
