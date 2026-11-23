import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorBinding, HEADER_KEPT_TEXT, RESYNC_LOG_LINE, UNDO_OWN_TEXT } from '../staff/replica/editorBinding';
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
  logs: string[];
  setHeader(value: string): void;
  exchange(from: 0 | 1, beforeRefresh?: () => void): Promise<void>;
  body(at: 0 | 1): Promise<string | undefined>;
  updates(at: 0 | 1): Promise<number>;
}) => Promise<void>, options: { onLeftAppended?: () => void; crlf?: boolean; seedBody?: string } = {}): Promise<void> {
  const world = await createLiveWorld({ people: [{ label: 'ana', name: 'Avery Lead' }, { label: 'ben', name: 'Blake Rivers' }] });
  const stream = world.lead.project.projectId;
  let header = HEADER;
  const targets = world.devices.map(({ project }) => ({ project, stream, product: PRODUCT, actor: ACTOR, header: () => header }));
  const bindings: EditorBinding[] = [];
  const seedBody = options.seedBody ?? 'Alpha Bravo';
  try {
    const seed = await ProductEditor.open(world.lead.project, targets[0]);
    try {
      seed.insert(0, seedBody);
      assert.deepEqual(await seed.flush(), { appended: 1, queued: 0 });
    } finally {
      seed.close();
    }
    await carryThroughFake(world.devices[0], world.devices[1], stream);
    const canonical = HEADER + seedBody;
    const initial = options.crlf ? canonical.replaceAll('\n', '\r\n') : canonical;
    const documents: [FakeBoundDocument, FakeBoundDocument] = [new FakeBoundDocument(initial), new FakeBoundDocument(initial)];
    const notices: string[] = [];
    const logs: string[] = [];
    const hooks = { notice: (text: string) => notices.push(text), log: (line: string) => logs.push(line) };
    bindings.push(await EditorBinding.open(documents[0], targets[0], { ...hooks, onAppended: options.onLeftAppended }));
    bindings.push(await EditorBinding.open(documents[1], targets[1], hooks));
    await run({
      documents,
      bindings: [bindings[0], bindings[1]],
      notices,
      logs,
      setHeader(value) { header = value; },
      async exchange(from, beforeRefresh) {
        const to = from === 0 ? 1 : 0;
        await bindings[from].flush();
        await carryThroughFake(world.devices[from], world.devices[to], stream);
        beforeRefresh?.();
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
  }, { onLeftAppended: onSaved });
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

test('opening and pasting normalize CRLF while edits queued after a paste keep their offsets', async () => {
  await withEditors(async ({ documents: [a, b], exchange, body, updates }) => {
    assert.equal(a.getText(), HEADER + 'Alpha Bravo\nAfter');
    assert.equal(b.getText(), HEADER + 'Alpha Bravo\nAfter');

    a.type({ offset: HEADER.length + 6, length: 0, text: 'one\r\ntwo\r\n' });
    const index = a.getText().indexOf('Bravo');
    a.type({ offset: index, length: 5, text: 'Three' });
    await exchange(0);

    const expected = 'Alpha one\ntwo\nThree\nAfter';
    assert.equal(await body(1), expected);
    assert.equal(a.getText(), HEADER + expected);
    assert.equal(b.getText(), a.getText());
    assert.equal(await updates(0), 2);
    assert.equal(await updates(1), 0);
  }, { crlf: true, seedBody: 'Alpha Bravo\nAfter' });
});

test('a new generated header replaces only the header while body edits are pending', async () => {
  await withEditors(async ({ documents: [a, b], bindings: [left, right], exchange, setHeader, notices, updates }) => {
    a.deferAppliedEvents = true;
    const newHeader = HEADER.replace('bridge-status', 'bridge-situation-status');
    setHeader(newHeader);
    const refreshed = left.refresh();
    await Promise.resolve();
    a.type({ offset: HEADER.length + 6, length: 5, text: 'Charlie' });
    await refreshed;
    assert.deepEqual(a.lastAppliedEdits, [{ offset: 0, length: HEADER.length, text: newHeader }]);
    assert.equal(a.getText(), newHeader + 'Alpha Charlie');

    a.type({ offset: newHeader.length + 5, length: 0, text: '!' });
    a.deliverAppliedEvents();
    await right.refresh();
    await exchange(0);

    assert.equal(a.getText(), newHeader + 'Alpha! Charlie');
    assert.equal(b.getText(), a.getText());
    assert.deepEqual(notices, []);
    assert.equal(await updates(0), 2);
    assert.equal(await updates(1), 0);
  });
});

test('one dropped remote edit is repaired once without discarding a queued local edit or echoing', async () => {
  await withEditors(async ({ documents: [a, b], bindings: [, right], exchange, updates, logs }) => {
    b.dropNextApply = true;
    a.type({ offset: a.getText().length, length: 0, text: ' Remote' });
    await exchange(0, () => b.type({ offset: HEADER.length, length: 0, text: 'Pending ' }));

    const expected = HEADER + 'Pending Alpha Bravo Remote';
    assert.equal(b.getText(), expected);
    assert.equal(b.applied, 1);
    assert.deepEqual(b.lastAppliedEdits, [{ offset: HEADER.length, length: 'Pending Alpha Bravo'.length, text: 'Pending Alpha Bravo Remote' }]);
    assert.deepEqual(logs, [RESYNC_LOG_LINE]);
    assert.doesNotMatch(logs[0], /[\r\n]|Pending|Alpha|Bravo|Remote|bridge-status/);
    await right.refresh();
    await exchange(1);
    assert.equal(a.getText(), expected);
    assert.equal(await updates(1), 1);
    assert.deepEqual(logs, [RESYNC_LOG_LINE]);
  });
});

test('a sixth mismatch within a minute stops the binding but allows captured edits to flush', async () => {
  await withEditors(async ({ documents: [a, b], bindings: [, right], exchange, body, logs, notices }) => {
    for (let i = 0; i < 5; i += 1) {
      b.dropNextApply = true;
      a.type({ offset: a.getText().length, length: 0, text: '!' });
      await exchange(0);
      assert.equal(b.getText(), a.getText());
    }
    const stopped = /The editor no longer matches the shared product/;
    b.dropNextApply = true;
    a.type({ offset: a.getText().length, length: 0, text: '?' });
    await assert.rejects(exchange(0, () => b.type({ offset: HEADER.length, length: 0, text: 'Pending ' })), stopped);
    assert.deepEqual(logs, Array(5).fill(RESYNC_LOG_LINE));
    assert.equal(b.applied, 5);
    assert.match(notices[0], stopped);
    assert.equal(notices.length, 1);

    b.type({ offset: HEADER.length, length: 0, text: 'Ignored ' });
    await assert.rejects(right.refresh(), stopped);
    assert.equal((await right.flush()).queued, 0);
    assert.equal(await body(1), 'Pending Alpha Bravo!!!!!?');
  });
});

test('a newer local document survives a conflicting remote write', async (t) => {
  await withEditors(async ({ documents: [a, b], exchange, updates, logs }) => {
    const apply = b.applyEdits.bind(b);
    t.mock.method(b, 'applyEdits', (...args: Parameters<typeof apply>) => {
      b.type({ offset: HEADER.length, length: 0, text: 'Newer ' });
      return apply(...args);
    }, { times: 1 });

    a.type({ offset: a.getText().length, length: 0, text: ' Remote' });
    await assert.rejects(exchange(0), /The editor no longer matches the shared product/);
    assert.equal(b.getText(), HEADER + 'Newer Alpha Bravo');
    assert.equal(b.applied, 0);
    assert.equal(await updates(1), 0);
    assert.deepEqual(logs, []);
  });
});
