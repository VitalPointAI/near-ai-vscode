import assert from 'node:assert/strict';
import test from 'node:test';
import { openBoundText } from '../domain/replica/doc';
import type { TextOp } from '../domain/replica/doc';
import { MAX_UPDATE_BYTES } from '../domain/replica/kindSchemas/doc';
import { EditorBinding, HEADER_KEPT_TEXT, RESYNC_LOG_LINE, UNDO_OWN_TEXT } from '../staff/replica/editorBinding';
import { acceptedUpdates, productOutput } from '../staff/replica/productFeed';
import { ProductEditor } from '../staff/replica/productEditing';
import { FakeBoundDocument } from './helpers/fakeBoundDocument';
import { carryThroughFake, createLiveWorld } from './helpers/liveWorld';
import { rng } from './helpers/replicaWorld';

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
  updateSizes(at: 0 | 1): Promise<number[]>;
  otherProductPosition(): Promise<string | undefined>;
}) => Promise<void>, options: { onLeftAppended?: () => void; crlf?: boolean; seedBody?: string } = {}): Promise<void> {
  const world = await createLiveWorld({ people: [{ label: 'ana', name: 'Avery Lead' }, { label: 'ben', name: 'Blake Rivers' }] });
  const stream = world.lead.project.projectId;
  let header = HEADER;
  const targets = world.devices.map(({ project }) => ({ project, stream, product: PRODUCT, actor: ACTOR, header: () => header }));
  const bindings: EditorBinding[] = [];
  const ownUpdates = async (at: 0 | 1) => {
    const { project } = world.devices[at];
    const feed = await acceptedUpdates(project, stream, PRODUCT);
    return feed.updates.filter(({ writer }) => writer === project.deviceWriter);
  };
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
      async updates(at) { return (await ownUpdates(at)).length; },
      async updateSizes(at) { return (await ownUpdates(at)).map(({ bytes }) => bytes.length); },
      async otherProductPosition() {
        const other = await ProductEditor.open(targets[0].project, { ...targets[0], product: 'other-product' });
        try {
          return other.relativeAt(0);
        } finally {
          other.close();
        }
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
    a.type({ offset: 0, length: 1, text: 'x' });
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

test('a large Unicode replacement reaches the peer and remains one local undo and redo', async () => {
  await withEditors(async ({ documents: [a, b], bindings: [left], exchange, body, updates, updateSizes }) => {
    const pasted = 'x' + '🌎'.repeat(75 * 1024);
    b.type({ offset: HEADER.length, length: 0, text: 'Remote ' });
    await exchange(1);
    a.type({ offset: HEADER.length + 'Remote Alpha '.length, length: 5, text: pasted });
    await exchange(0);

    const shared = 'Remote Alpha ' + pasted;
    assert.ok(await updates(0) > 2, 'the seed plus multiple records');
    assert.equal((await body(1)) === shared, true, 'the shared paste stays intact');
    assert.equal(b.getText() === HEADER + shared, true, 'the peer renders the whole paste');

    assert.equal(await left.undo(), true);
    assert.equal(await left.undo(), false);
    await exchange(0);
    assert.equal(await body(1), 'Remote Alpha Bravo');

    assert.equal(await left.redo(), true);
    assert.equal(await left.redo(), false);
    await exchange(0);
    assert.equal((await body(1)) === shared, true, 'redo persists the whole paste');
    assert.equal(a.getText() === b.getText(), true, 'the devices converge after redo');
    assert.ok((await updateSizes(0)).every((size) => size <= MAX_UPDATE_BYTES));
    assert.equal(await updates(1), 1, 'the peer never echoes paste or history');
  });
});

test('capture boundaries separate local undo items and report history changes through the plain-data handle', () => {
  const left = openBoundText(101);
  const right = openBoundText(202);
  try {
    const changes: Array<{ source: 'remote' | 'undo'; operations: readonly TextOp[] }> = [];
    left.onChange((operations, source) => changes.push({ source, operations }));
    right.onLocalUpdate((bytes) => assert.equal(left.applyRemote(bytes), true));

    left.insert(0, 'a');
    left.stopCapturing();
    left.insert(1, 'b');
    right.insert(0, 'R');
    assert.equal(left.undo(), true);
    assert.equal(left.text().replace('R', ''), 'a');
    assert.equal(left.redo(), true);
    assert.equal(left.text().replace('R', ''), 'ab');
    assert.deepEqual(changes.map(({ source }) => source), ['remote', 'undo', 'undo']);
    assert.ok(changes.every(({ operations }) => operations.length > 0));
  } finally {
    right.destroy();
    left.destroy();
  }
});

test('relative positions follow edits across replicas and reject unrelated or malformed positions', async () => {
  await withEditors(async ({ documents: [a, b], bindings: [left, right], exchange, otherProductPosition }) => {
    const anchor = left.relativeAt(HEADER.length + 6);
    const end = left.relativeAt(a.getText().length);
    assert.ok(anchor && end);
    assert.equal(right.indexOf(anchor), HEADER.length + 6);
    assert.equal(right.indexOf(end), b.getText().length);

    b.type({ offset: HEADER.length, length: 0, text: 'Hi ' });
    assert.equal(right.indexOf(anchor), undefined, 'editor offsets are stale until the local change is applied');
    await exchange(1);
    assert.equal(left.indexOf(anchor), HEADER.length + 9);
    assert.equal(right.indexOf(anchor), HEADER.length + 9);
    assert.equal(right.indexOf(end), b.getText().length);

    b.type({ offset: HEADER.length + 9, length: 1, text: '' });
    await exchange(1);
    assert.equal(left.indexOf(anchor), HEADER.length + 9, 'the deleted anchor collapses to its boundary');
    assert.equal(right.indexOf(anchor), left.indexOf(anchor));

    a.type({ offset: HEADER.length, length: 0, text: 'New' });
    await left.flush();
    const unseen = left.relativeAt(HEADER.length);
    assert.ok(unseen);
    assert.equal(right.indexOf(unseen), undefined, 'the peer has yet to receive the referenced item');
    await exchange(0);
    assert.equal(right.indexOf(unseen), HEADER.length);

    const other = await otherProductPosition();
    assert.ok(other);
    assert.equal(right.indexOf(other), undefined);
    const encoded = Buffer.from(anchor, 'base64url');
    for (const bad of [
      null, '', anchor + '=', Buffer.alloc(128).toString('base64url'),
      encoded.subarray(0, -1).toString('base64url'),
      Buffer.concat([encoded, Uint8Array.of(0)]).toString('base64url')
    ]) {
      assert.equal(right.indexOf(bad), undefined);
    }
    assert.equal(left.relativeAt(HEADER.length - 1), undefined);
    assert.equal(left.relativeAt(a.getText().length + 1), undefined);
    assert.equal(left.relativeAt(Number.NaN), undefined);
  });
});

test('fuzz: seeded concurrent editing preserves convergence and local history', { timeout: 120_000 }, async (t) => {
  for (const seed of [3304, 43117]) {
    await t.test(`seed ${seed}`, async (trial) => {
      trial.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
      const random = rng(seed);
      const ownerToken = [/[a-z]/, /[A-Z]/];
      let round = 0;
      try {
        await withEditors(async ({ documents, bindings, exchange, body, logs }) => {
          for (const document of documents) document.deferAppliedEvents = true;
          let repairs = 0;
          let reordered = 0;
          let historyChanges = 0;
          const send = async (side: 0 | 1): Promise<void> => {
            await exchange(side);
            if (random.chance(0.5)) documents[side === 0 ? 1 : 0].deliverAppliedEvents();
          };
          const verifyConvergence = async (first: 0 | 1): Promise<void> => {
            await send(first);
            await send(first === 0 ? 1 : 0);
            for (const document of documents) {
              if (document.deliverAppliedEvents(true) > 1) reordered += 1;
            }
            assert.equal(documents[0].getText(), documents[1].getText());
            for (const side of [0, 1] as const) {
              assert.equal(documents[side].getText(), HEADER + bindings[side].text());
              assert.equal(await body(side), bindings[side].text());
            }
          };

          for (round = 1; round <= 100; round += 1) {
            const side = random.chance(0.5) ? 0 : 1;
            const other = side === 0 ? 1 : 0;
            const document = documents[side];
            const oldBody = document.getText().slice(HEADER.length);
            const operation = random.int(6);
            trial.mock.timers.tick(random.int(150));
            if (operation < 3) {
              const token = String.fromCharCode((side === 0 ? 97 : 65) + random.int(26));
              document.type({ offset: HEADER.length + random.int(oldBody.length + 1), length: 0, text: token });
            } else if (operation === 3) {
              const candidates = [...oldBody].flatMap((character, index) => ownerToken[side].test(character) ? [index] : []);
              if (candidates.length > 0) document.type({ offset: HEADER.length + random.pick(candidates), length: 1, text: '' });
            } else {
              const peerText = (text: string): string => [...text].filter((character) => ownerToken[other].test(character)).join('');
              if (await bindings[side][operation === 4 ? 'undo' : 'redo']()) historyChanges += 1;
              assert.equal(peerText(document.getText().slice(HEADER.length)), peerText(oldBody));
            }

            if (random.chance(0.3)) await send(side);
            if (round === 37 || round === 83) {
              documents[other].dropNextApply = true;
              document.type({ offset: document.getText().length, length: 0, text: '!' });
              await send(side);
              repairs += 1;
              assert.deepEqual(logs, Array(repairs).fill(RESYNC_LOG_LINE));
            }
            if (round % 20 === 0) await verifyConvergence(side);
          }
          assert.ok(reordered > 0, 'some remote notifications arrived newest first');
          assert.ok(historyChanges > 0, 'local history actually changed during the schedule');
        }, { seedBody: '0123456789' });
      } catch (error) {
        throw new Error(`seed ${seed}, round ${round}`, { cause: error });
      }
    });
  }
});
