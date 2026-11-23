import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorBinding, HEADER_KEPT_TEXT, UNDO_OWN_TEXT } from '../staff/replica/editorBinding';
import { acceptedUpdates, productOutput } from '../staff/replica/productFeed';
import { ProductEditor } from '../staff/replica/productEditing';
import { FakeBoundDocument } from './helpers/fakeBoundDocument';
import { carryThroughFake, createLiveWorld } from './helpers/liveWorld';

const HEADER = '---\nproduct: bridge-status\n---\n\n';
const PRODUCT = 'bridge-status';
const ACTOR = { kind: 'person' } as const;

async function withEditors(run: (world: {
  documents: [FakeBoundDocument, FakeBoundDocument];
  bindings: [EditorBinding, EditorBinding];
  notices: string[];
  exchange(from: 0 | 1): Promise<void>;
  body(at: 0 | 1): Promise<string | undefined>;
  updates(at: 0 | 1): Promise<number>;
}) => Promise<void>, onLeftAppended?: () => void): Promise<void> {
  const world = await createLiveWorld({ people: [{ label: 'ana', name: 'Avery Lead' }, { label: 'ben', name: 'Blake Rivers' }] });
  const stream = world.lead.project.projectId;
  const targets = world.devices.map(({ project }) => ({ project, stream, product: PRODUCT, actor: ACTOR, header: () => HEADER }));
  const bindings: EditorBinding[] = [];
  try {
    const seed = await ProductEditor.open(world.lead.project, targets[0]);
    try {
      seed.insert(0, 'Alpha Bravo');
      assert.deepEqual(await seed.flush(), { appended: 1, queued: 0 });
    } finally {
      seed.close();
    }
    await carryThroughFake(world.devices[0], world.devices[1], stream);
    const documents: [FakeBoundDocument, FakeBoundDocument] = [new FakeBoundDocument(HEADER + 'Alpha Bravo'), new FakeBoundDocument(HEADER + 'Alpha Bravo')];
    const notices: string[] = [];
    bindings.push(await EditorBinding.open(documents[0], targets[0], { notice: (text) => notices.push(text), onAppended: onLeftAppended }));
    bindings.push(await EditorBinding.open(documents[1], targets[1]));
    await run({
      documents,
      bindings: [bindings[0], bindings[1]],
      notices,
      async exchange(from) {
        const to = from === 0 ? 1 : 0;
        await bindings[from].flush();
        await carryThroughFake(world.devices[from], world.devices[to], stream);
        await bindings[to].refresh();
      },
      async body(at) { return productOutput((await world.devices[at].project.state()).fold, stream, PRODUCT)?.text; },
      async updates(at) {
        const { project } = world.devices[at];
        const feed = await acceptedUpdates(project, stream, PRODUCT);
        return feed.updates.filter(({ writer }) => writer === project.deviceWriter).length;
      }
    });
  } finally {
    await Promise.all(bindings.map((binding) => binding.close()));
    await world.close();
  }
}

test('a local insert reaches the other document without an edit back into its author or an echoed shared update', async () => {
  await withEditors(async ({ documents: [a, b], bindings: [left, right], exchange, body, updates }) => {
    a.type({ offset: HEADER.length + 3, length: 0, text: '!' });
    await exchange(0);
    assert.equal(await body(0), 'Alp!ha Bravo');
    assert.equal(await body(1), 'Alp!ha Bravo');
    assert.equal(left.text(), 'Alp!ha Bravo');
    assert.equal(right.text(), 'Alp!ha Bravo');
    assert.equal(a.getText(), b.getText());
    assert.equal(a.applied, 0);
    assert.equal(b.applied, 1);
    assert.deepEqual(await right.flush(), { appended: 0, queued: 0 });
    assert.equal(await updates(1), 0);
  });
});

test('a multi-range editor transaction maps body offsets right to left and writes one update', async () => {
  await withEditors(async ({ documents: [a, b], exchange, body, updates }) => {
    a.type({ offset: HEADER.length, length: 5, text: 'A' }, { offset: HEADER.length + 6, length: 5, text: 'B' });
    await exchange(0);
    assert.equal(await updates(0), 2, 'seed plus one editor transaction');
    assert.equal(await body(1), 'A B');
    assert.equal(b.getText(), HEADER + 'A B');
  });
});

test('a typing burst is saved on the batch timer as one shared update', { timeout: 10000 }, async () => {
  let onSaved!: () => void;
  const saved = new Promise<void>((resolve) => { onSaved = resolve; });
  await withEditors(async ({ documents: [a, b], exchange, body, updates }) => {
    for (let count = 0; count < 40; count += 1) {
      a.type({ offset: a.getText().length, length: 0, text: '!' });
    }
    await saved;
    assert.equal(await updates(0), 2, 'the seed and the whole burst are two updates');
    assert.equal(await body(0), 'Alpha Bravo' + '!'.repeat(40));
    await exchange(0);
    assert.equal(b.getText(), a.getText());
    assert.equal(await updates(1), 0);
  }, onSaved);
});

test('a late notification of the applied remote edit stays ignored after local typing', async () => {
  await withEditors(async ({ documents: [a, b], bindings: [, right], exchange, body, updates }) => {
    b.deferAppliedEvents = true;
    a.type({ offset: HEADER.length + 11, length: 0, text: '!' });
    await exchange(0);
    b.type({ offset: HEADER.length + 12, length: 0, text: '?' });
    b.deliverAppliedEvents();
    await exchange(1);
    assert.equal(await updates(1), 1, 'B writes its own change once');
    assert.equal(await body(0), 'Alpha Bravo!?');
    assert.equal(right.text(), 'Alpha Bravo!?');
    assert.equal(a.getText(), b.getText());
  });
});

test('shared undo and redo preserve remote typing and each append one local update', async () => {
  await withEditors(async ({ documents: [a, b], bindings: [left], exchange, body, updates }) => {
    a.type({ offset: a.getText().length, length: 0, text: ' alpha' });
    await exchange(0);
    b.type({ offset: b.getText().length, length: 0, text: ' beta' });
    await exchange(1);

    assert.equal(await left.undo(), true);
    await exchange(0);
    assert.equal(a.getText(), HEADER + 'Alpha Bravo beta');
    assert.equal(a.getText(), b.getText());
    assert.equal(await body(1), 'Alpha Bravo beta');
    assert.equal(await updates(0), 3, 'seed, local edit and undo');
    assert.equal(await left.undo(), false, 'remote typing and the seed are outside the local history');

    assert.equal(await left.redo(), true);
    await exchange(0);
    assert.equal(a.getText(), HEADER + 'Alpha Bravo alpha beta');
    assert.equal(a.getText(), b.getText());
    assert.equal(await body(1), 'Alpha Bravo alpha beta');
    assert.equal(await updates(0), 4);
    assert.equal(await updates(1), 1, 'the peer never echoes the history updates');
  });
});

test('native undo and redo replace the editor result with this session’s own shared history', async () => {
  await withEditors(async ({ documents: [a, b], bindings: [left], exchange, notices, updates }) => {
    a.type({ offset: a.getText().length, length: 0, text: '!' });
    await exchange(0);
    b.type({ offset: b.getText().length, length: 0, text: '?' });
    await exchange(1);

    a.nativeHistory('undo', { offset: a.getText().length - 1, length: 1, text: '' });
    await exchange(0);
    assert.equal(a.getText(), HEADER + 'Alpha Bravo?');
    assert.equal(a.getText(), b.getText());
    assert.deepEqual(notices, [UNDO_OWN_TEXT]);

    a.nativeHistory('redo', { offset: a.getText().length - 1, length: 1, text: '' });
    await exchange(0);
    assert.equal(a.getText(), HEADER + 'Alpha Bravo!?');
    assert.equal(a.getText(), b.getText());
    assert.equal(await updates(0), 4, 'the native deltas were never appended');
    assert.equal(await updates(1), 1);
    assert.deepEqual(await left.flush(), { appended: 0, queued: 0 });
  });
});

test('an edit spanning the header and body is restored without a shared write and body editing can continue', async () => {
  await withEditors(async ({ documents: [a, b], bindings: [left], exchange, notices, updates }) => {
    a.type({ offset: HEADER.length - 2, length: 5, text: 'tampered' });
    assert.deepEqual(await left.flush(), { appended: 0, queued: 0 });
    assert.equal(a.getText(), HEADER + 'Alpha Bravo');
    assert.deepEqual(notices, [HEADER_KEPT_TEXT]);
    assert.equal(await updates(0), 1, 'only the seed was written');

    a.type({ offset: HEADER.length, length: 0, text: '• ' });
    await exchange(0);
    assert.equal(a.getText(), HEADER + '• Alpha Bravo');
    assert.equal(a.getText(), b.getText());
    assert.equal(await updates(0), 2);
  });
});
