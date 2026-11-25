// Only accepted updates reach an editor, in order, and a change that failed to send is never lost (Phase 33 33-01 Task 3, D-11, F6, T-33-01,
// T-33-04). Two people's computers carry entries through the fake transport; the feed must leave out an update the fold holds (its client id is
// not registered yet) and one it refused (clock-overlap), hand out the held one exactly once after its registration arrives, honour its cursor, and
// the editing core must keep a failed append and everything after it queued in order, take a fresh client id each session, never reuse one the
// fold registered, and stop on a client-collision with its sentence. Fictional people and data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { clientIdOf } from '../domain/replica/clientIds';
import { createLocalDoc, docText, localInsert, applyRemote, inspectUpdate } from '../domain/replica/doc';
import type { Actor } from '../domain/replica/entry';
import { deviceAt } from '../domain/replica/rosterMembers';
import { updateMember } from '../staff/replica/membership';
import { acceptedUpdates, productOutput } from '../staff/replica/productFeed';
import { PRODUCT_EDIT_REFUSALS, ProductEditError, ProductEditor } from '../staff/replica/productEditing';
import type { EditorProject } from '../staff/replica/productEditing';
import type { ProjectRefused } from '../staff/replica/replicaProject';
import { LIVE_LEAD_MEMBER, carryThroughFake, createLiveWorld } from './helpers/liveWorld';
import type { LiveDevice } from './helpers/liveWorld';

const PRODUCT = 'enemy-situation';
const PERSON: Actor = { kind: 'person' };
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

async function slotOf(device: LiveDevice): Promise<number> {
  const { roster } = await device.project.state();
  const slot = deviceAt(roster.members, device.project.deviceWriter, roster.positions.length - 1)?.slot;
  assert.ok(slot !== undefined, 'the device has a slot');
  return slot;
}

async function hashOf(result: Awaited<ReturnType<LiveDevice['project']['appendOwn']>>): Promise<string> {
  assert.ok('ok' in result, `the append is stored (${'refused' in result ? result.refused : ''})`);
  return result.hash;
}

async function withWorld(names: number, run: (devices: LiveDevice[]) => Promise<void>): Promise<void> {
  const people = [{ label: 'ana', name: 'Avery Lead' }, { label: 'ben', name: 'Blake Rivers' }].slice(0, names);
  const world = await createLiveWorld({ people });
  try {
    await run(world.devices);
  } finally {
    await world.close();
  }
}

test('the feed leaves out a held update and a clock-overlap refusal, and hands out the held one exactly once, in fold order, once its registration arrives', async () => {
  await withWorld(2, async ([a, b]) => {
    const stream = a.project.projectId;
    const slot = await slotOf(b);
    const x = clientIdOf(slot, 0);
    const y = clientIdOf(slot, 1);
    const first = localInsert(createLocalDoc(x), 0, 'Bridge intact.');
    const overlap = localInsert(createLocalDoc(x), 0, 'Forged text.');
    const later = localInsert(createLocalDoc(y), 0, 'Second line. ');
    // B registers X and writes under it, then an update claiming X's clocks again, then registers Y and writes under it.
    await hashOf(await b.project.appendOwn('doc.client', { product: PRODUCT, clientId: x, actor: PERSON }, { stream, actor: PERSON }));
    const accepted = await hashOf(await b.project.appendOwn('doc.update', { product: PRODUCT, update: b64(first) }, { stream }));
    const refused = await hashOf(await b.project.appendOwn('doc.update', { product: PRODUCT, update: b64(overlap) }, { stream }));
    const registration = await hashOf(await b.project.appendOwn('doc.client', { product: PRODUCT, clientId: y, actor: PERSON }, { stream, actor: PERSON }));
    const held = await hashOf(await b.project.appendOwn('doc.update', { product: PRODUCT, update: b64(later) }, { stream }));

    // The update under Y reaches A before Y's registration does.
    await carryThroughFake(b, a, stream, new Set([registration]));
    const before = await a.project.state();
    assert.ok(before.fold.refused.some((item) => item.hash === refused && item.reason === 'clock-overlap'), 'the overlapping update is refused');
    assert.equal(before.fold.applied.includes(held), false, 'the update under Y waits for its registration');
    const early = await acceptedUpdates(a.project, stream, PRODUCT);
    assert.deepEqual(early.updates.map((item) => item.hash), [accepted], 'neither the refused nor the waiting update reaches an editor');
    assert.deepEqual(Buffer.from(early.updates[0]?.bytes ?? []), Buffer.from(first));
    assert.equal(early.updates[0]?.writer, b.project.deviceWriter);
    assert.equal(early.last, accepted);

    await carryThroughFake(b, a, stream);
    const after = await a.project.state();
    assert.deepEqual(productOutput(after.fold, stream, PRODUCT)?.accepted, [accepted, held]);
    const feed = await acceptedUpdates(a.project, stream, PRODUCT);
    assert.deepEqual(feed.updates.map((item) => item.hash), [accepted, held], 'the waiting update exactly once, after the first; the refused one never');
    assert.equal(feed.last, held);
    assert.deepEqual((await acceptedUpdates(a.project, stream, PRODUCT, early.last)).updates.map((item) => item.hash), [held], 'from the cursor, only the new one');
    const rebuilt = createLocalDoc(clientIdOf(4000, 0));
    for (const item of feed.updates) assert.equal(applyRemote(rebuilt, item.bytes), true);
    assert.equal(docText(rebuilt), productOutput(after.fold, stream, PRODUCT)?.text);
    assert.equal(docText(rebuilt).includes('Forged'), false);
  });
});

test('an update held for its registration in the fold itself (typed before registering) never reaches an editor', async () => {
  await withWorld(1, async ([a]) => {
    const stream = a.project.projectId;
    const id = clientIdOf(await slotOf(a), 0);
    const orphan = await hashOf(await a.project.appendOwn('doc.update', { product: PRODUCT, update: b64(localInsert(createLocalDoc(id), 0, 'Typed too early.')) }, { stream }));
    await hashOf(await a.project.appendOwn('doc.client', { product: PRODUCT, clientId: id, actor: PERSON }, { stream, actor: PERSON }));
    const { fold } = await a.project.state();
    assert.ok(fold.held.some((item) => item.hash === orphan && item.reason === 'unregistered-client'), 'held: the registration sorts after it');
    assert.deepEqual(await acceptedUpdates(a.project, stream, PRODUCT), { updates: [] });
  });
});

test('the cursor: after a hash gives only what follows it, the newest gives nothing, an unknown one gives everything with last set', async () => {
  await withWorld(1, async ([a]) => {
    const stream = a.project.projectId;
    const editor = await ProductEditor.open(a.project, { stream, product: PRODUCT, actor: PERSON });
    editor.insert(0, 'One.');
    editor.insert(4, ' Two.');
    editor.insert(9, ' Three.');
    assert.deepEqual(await editor.flush(), { appended: 3, queued: 0 });
    const all = await acceptedUpdates(a.project, stream, PRODUCT);
    assert.equal(all.updates.length, 3);
    const [h1, h2, h3] = all.updates.map((item) => item.hash);
    assert.equal(all.last, h3);
    assert.deepEqual((await acceptedUpdates(a.project, stream, PRODUCT, h1)).updates.map((item) => item.hash), [h2, h3]);
    assert.deepEqual(await acceptedUpdates(a.project, stream, PRODUCT, h3), { updates: [], last: h3 });
    const afterRefold = await acceptedUpdates(a.project, stream, PRODUCT, new Set([h2, h3]));
    assert.deepEqual(afterRefold.updates.map((item) => item.hash), [h1], 'a newly accepted update may sort before an already applied update');
    const unknown = await acceptedUpdates(a.project, stream, PRODUCT, '0'.repeat(64));
    assert.deepEqual(unknown.updates.map((item) => item.hash), [h1, h2, h3]);
    assert.equal(unknown.last, h3);
    const rebuilt = createLocalDoc(clientIdOf(4000, 0));
    for (const item of all.updates) assert.equal(applyRemote(rebuilt, item.bytes), true);
    assert.equal(docText(rebuilt), 'One. Two. Three.');
    assert.deepEqual(await acceptedUpdates(a.project, stream, 'other-product'), { updates: [] });
    editor.close();
  });
});

/** The project with appendOwn refusing the chosen doc.update appends (counted from 1), as a full disk or a refusing store would. */
function refusingOnce(project: LiveDevice['project'], refuse: ReadonlySet<number>): EditorProject {
  let updates = 0;
  const refusal: ProjectRefused = { refused: 'store-refused', message: 'The store refused this write in the test.' };
  return {
    projectId: project.projectId,
    deviceWriter: project.deviceWriter,
    state: () => project.state(),
    context: () => project.context(),
    heads: () => project.heads(),
    entriesAfter: (stream, writer, seq) => project.entriesAfter(stream, writer, seq),
    appendOwn: async (kind, data, options) => {
      if (kind === 'doc.update') {
        updates += 1;
        if (refuse.has(updates)) return refusal;
      }
      return project.appendOwn(kind, data, options);
    }
  };
}

test('a failed append keeps that update and every later one queued, in order; the next flush writes them all and the fold sees no gap', async () => {
  await withWorld(1, async ([a]) => {
    const stream = a.project.projectId;
    const editor = await ProductEditor.open(refusingOnce(a.project, new Set([1])), { stream, product: PRODUCT, actor: PERSON });
    editor.insert(0, 'Alpha');
    editor.insert(5, ' Bravo');
    assert.equal(editor.queued, 2);
    assert.deepEqual(await editor.flush(), { appended: 0, queued: 2 }, 'the store refused the first update: both stay queued');
    assert.equal((await a.project.findOwnAll('doc.update', () => true)).length, 0);
    assert.deepEqual(await editor.flush(), { appended: 2, queued: 0 });
    const output = productOutput((await a.project.state()).fold, stream, PRODUCT);
    assert.equal(output?.text, 'Alpha Bravo');
    assert.equal(output?.incomplete, false, 'no clock gap');
    assert.equal(output?.accepted.length, 2);
    assert.equal((await a.project.findOwnAll('doc.client', () => true)).length, 1, 'the registration is written once');
    editor.close();
  });
});

test('a refusal in the middle keeps the order: the first update is written, the second and third wait and follow it on the next flush', async () => {
  await withWorld(1, async ([a]) => {
    const stream = a.project.projectId;
    const editor = await ProductEditor.open(refusingOnce(a.project, new Set([2])), { stream, product: PRODUCT, actor: PERSON });
    editor.insert(0, 'Hold');
    editor.insert(4, ' the');
    editor.insert(8, ' line.');
    assert.deepEqual(await editor.flush(), { appended: 1, queued: 2 });
    assert.deepEqual(await editor.flush(), { appended: 2, queued: 0 });
    const output = productOutput((await a.project.state()).fold, stream, PRODUCT);
    assert.equal(output?.text, 'Hold the line.');
    assert.equal(output?.incomplete, false);
    editor.close();
  });
});

test('a refused batch stays ahead of new edits on retry without leaving a clock gap', async () => {
  await withWorld(1, async ([a]) => {
    const stream = a.project.projectId;
    const editor = await ProductEditor.open(refusingOnce(a.project, new Set([1, 3])), { stream, product: PRODUCT, actor: PERSON });
    try {
      editor.insert(0, 'Alpha');
      editor.insert(5, ' Bravo');
      assert.deepEqual(await editor.flushBatch(), { appended: 0, queued: 1 });
      editor.insert(11, ' Charlie');
      editor.insert(19, ' Delta');

      assert.deepEqual(await editor.flushBatch(), { appended: 1, queued: 1 });
      const persisted = async () => productOutput((await a.project.state()).fold, stream, PRODUCT);
      assert.equal((await persisted())?.text, 'Alpha Bravo');

      assert.deepEqual(await editor.flushBatch(), { appended: 1, queued: 0 });
      const output = await persisted();
      assert.equal(output?.text, 'Alpha Bravo Charlie Delta');
      assert.equal(output?.accepted.length, 2);
      assert.equal(output?.incomplete, false);
      assert.equal((await a.project.findOwnAll('doc.client', () => true)).length, 1);
    } finally {
      editor.close();
    }
  });
});

test('a refused paste record keeps its clocks ahead of later captured text', async () => {
  await withWorld(1, async ([a]) => {
    const stream = a.project.projectId;
    const editor = await ProductEditor.open(refusingOnce(a.project, new Set([2])), { stream, product: PRODUCT, actor: PERSON });
    try {
      const paste = 'p'.repeat(300 * 1024);
      editor.insert(0, paste);
      assert.deepEqual(await editor.flushBatch(), { appended: 1, queued: 1 });
      const early = productOutput((await a.project.state()).fold, stream, PRODUCT);
      assert.ok(early && early.text.length > 0 && early.text.length < paste.length);
      editor.insert(paste.length, ' tail');

      assert.deepEqual(await editor.flushBatch(), { appended: 2, queued: 0 });
      const output = productOutput((await a.project.state()).fold, stream, PRODUCT);
      assert.equal(output?.text === paste + ' tail', true);
      assert.equal(output?.incomplete, false);
      const { updates } = await acceptedUpdates(a.project, stream, PRODUCT);
      let clock = 0;
      for (const { bytes } of updates) {
        const decoded = inspectUpdate(bytes);
        assert.ok(!('error' in decoded));
        assert.deepEqual(decoded.clients.map(({ client, start }) => ({ client, start })), [{ client: editor.clientId, start: clock }]);
        clock = decoded.clients[0].end;
      }
      assert.equal(clock, (paste + ' tail').length);
    } finally {
      editor.close();
    }
  });
});

test('client ids: two sessions on one device take two ids, and a session never takes an id the fold has registered', async () => {
  await withWorld(1, async ([a]) => {
    const stream = a.project.projectId;
    const slot = await slotOf(a);
    // An earlier session registered the slot's first id and wrote nothing after it.
    await hashOf(await a.project.appendOwn('doc.client', { product: PRODUCT, clientId: clientIdOf(slot, 0), actor: PERSON }, { stream, actor: PERSON }));
    const one = await ProductEditor.open(a.project, { stream, product: PRODUCT, actor: PERSON });
    const two = await ProductEditor.open(a.project, { stream, product: PRODUCT, actor: PERSON });
    assert.equal(one.clientId, clientIdOf(slot, 1), 'the registered id is skipped');
    assert.equal(two.clientId, clientIdOf(slot, 2), 'two open sessions never share an id');
    one.insert(0, 'First session.');
    two.insert(0, 'Second session. ');
    assert.deepEqual(await one.flush(), { appended: 1, queued: 0 });
    assert.deepEqual(await two.flush(), { appended: 1, queued: 0 });
    one.close();
    two.close();
    const three = await ProductEditor.open(a.project, { stream, product: PRODUCT, actor: PERSON });
    assert.equal(three.clientId, clientIdOf(slot, 3), 'closed sessions\' ids stay used once registered');
    assert.equal(three.text().length, 'First session.'.length + 'Second session. '.length, 'the new session holds both');
    assert.equal((await a.project.state()).fold.refused.length, 0, 'nothing refused');
    three.close();
  });
});

test('a client-collision stops the session with its sentence: the change stays queued, nothing more is written, and later edits are refused', async () => {
  await withWorld(1, async ([a]) => {
    const stream = a.project.projectId;
    const agent: Actor = { kind: 'agent', member: 'j4-analyst', run: 'run-7' };
    const roles = ['member', 'section_lead:j4'];
    const updated = await updateMember(a.host, { member: LIVE_LEAD_MEMBER, roles, agentSeats: ['j4-analyst'] });
    assert.equal(updated.ok, true, updated.message);
    const editor = await ProductEditor.open(a.project, { stream, product: PRODUCT, actor: PERSON });
    // An agent run on this device registers the same id first, under another actor.
    await hashOf(await a.project.appendOwn('doc.client', { product: PRODUCT, clientId: editor.clientId, actor: agent }, { stream, actor: agent }));
    editor.insert(0, 'Enemy forces hold the bridge.');
    assert.deepEqual(await editor.flush(), { appended: 0, queued: 1 });
    assert.deepEqual(editor.refusal, { refusal: 'client-collision', message: PRODUCT_EDIT_REFUSALS['client-collision'] });
    assert.equal(PRODUCT_EDIT_REFUSALS['client-collision'], 'This product could not take your change on this computer. Close it and open it again.');
    assert.equal((await a.project.findOwnAll('doc.update', () => true)).length, 0, 'no update under a collided id');
    const { fold } = await a.project.state();
    assert.ok(fold.refused.some((item) => item.reason === 'client-collision'), 'the fold refused the second registration');
    assert.throws(() => editor.insert(0, 'More.'), (error: unknown) => error instanceof ProductEditError && error.refusal === 'client-collision' && error.message === PRODUCT_EDIT_REFUSALS['client-collision']);
    assert.deepEqual(await editor.flush(), { appended: 0, queued: 1 });
    editor.close();
    const again = await ProductEditor.open(a.project, { stream, product: PRODUCT, actor: PERSON });
    assert.notEqual(again.clientId, editor.clientId, 'opening again takes another id');
    again.close();
  });
});

test('the refusal sentences are plain words: no client id, fold or entry, no em-dash, and no bare team', () => {
  for (const [id, sentence] of Object.entries(PRODUCT_EDIT_REFUSALS)) {
    assert.doesNotMatch(sentence, /client id|\bfold\b|\bentry\b|\bentries\b|—|\bteam\b|\bhub\b/i, id);
    assert.match(sentence, /^[A-Z].*\.$/, id);
  }
});
