import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorBinding } from '../staff/replica/editorBinding';
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
  exchange(from: 0 | 1): Promise<void>;
  body(at: 0 | 1): Promise<string | undefined>;
  updates(at: 0 | 1): Promise<number>;
}) => Promise<void>): Promise<void> {
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
    bindings.push(await EditorBinding.open(documents[0], targets[0]));
    bindings.push(await EditorBinding.open(documents[1], targets[1]));
    await run({
      documents,
      bindings: [bindings[0], bindings[1]],
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
