// Phase 33 plan 25 (D-53, D-55, RESEARCH N2 and N3, Pitfall N8.2): the browser end of a bound product. Local changes leave as edits, the model's
// version and the SHA-256 of its text, in order; other people's changes apply only at the version they name, with no undo stop and no echo; a
// reload from disk is held for the person's choice. The model is a stand-in with Monaco's ITextModel members (Monaco's own model does not load under
// the Node test runner). Fictional exercise data only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { MonacoBoundDocument, type BindingChannel } from '../extension/src/browser/staff/monaco-bound-document.ts';
import type { BindingEdit } from '../extension/src/common/staff-binding.ts';
import { FakeTextModel, settle } from './helpers/staff-binding-world.ts';

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

type Sent = [string, ...unknown[]];

function channel(): { channel: BindingChannel; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    channel: {
      changed: async (doc, edits, version, hash, reason) => { sent.push(['changed', doc, edits, version, hash, ...(reason === undefined ? [] : [reason])]); },
      applied: async (doc, request, ok, version, hash) => { sent.push(['applied', doc, request, ok, version, hash]); },
      fullText: async (doc, text, version) => { sent.push(['fullText', doc, text, version]); },
      synced: async (doc, version, hash) => { sent.push(['synced', doc, version, hash]); },
    },
  };
}

test('a typed insert leaves as one change with its edits, the model version and the SHA-256 of the text', async () => {
  const model = new FakeTextModel('Fuel for three days.');
  const { channel: wire, sent } = channel();
  const bound = new MonacoBoundDocument({ doc: 'doc-1', model, channel: wire });
  model.type(4, 0, ' and water');
  await bound.settled();
  assert.deepEqual(sent, [['changed', 'doc-1', [{ offset: 4, length: 0, text: ' and water' }], 2, sha('Fuel and water for three days.')]]);
});

test('another person\'s change applies at the version it names, adds no undo stop and is never echoed back', async () => {
  const model = new FakeTextModel('Fuel for three days.');
  const { channel: wire, sent } = channel();
  const bound = new MonacoBoundDocument({ doc: 'doc-1', model, channel: wire });
  const edits: BindingEdit[] = [{ offset: 15, length: 4, text: 'four days' }];
  assert.equal(bound.applyRemote(7, edits, 1), true);
  await bound.settled();
  assert.equal(model.getValue(), 'Fuel for three four days.');
  assert.deepEqual(sent, [['applied', 'doc-1', 7, true, 2, sha('Fuel for three four days.')]], 'one answer, and no change sent back');
  assert.equal(model.canUndo, false, 'nothing on the native undo stack');
  assert.equal(model.undo(), false, 'the model\'s own undo does nothing afterwards');
});

test('at any other version the request is refused and the model is unchanged', async () => {
  const model = new FakeTextModel('Fuel for three days.');
  const { channel: wire, sent } = channel();
  const bound = new MonacoBoundDocument({ doc: 'doc-1', model, channel: wire });
  model.type(0, 0, 'A ');
  assert.equal(bound.applyRemote(3, [{ offset: 0, length: 4, text: 'Water' }], 1), false);
  await bound.settled();
  assert.equal(model.getValue(), 'A Fuel for three days.');
  assert.deepEqual(sent.map((item) => item.slice(0, 4)), [['changed', 'doc-1', [{ offset: 0, length: 0, text: 'A ' }], 2], ['applied', 'doc-1', 3, false]]);
  assert.equal(sent[1][4], 2, 'the answer names the model\'s version now');
});

test('a native undo is sent with its reason, and the whole text goes once when asked', async () => {
  const model = new FakeTextModel('Fuel');
  const { channel: wire, sent } = channel();
  const bound = new MonacoBoundDocument({ doc: 'doc-1', model, channel: wire });
  model.type(4, 0, '!');
  model.undo();
  bound.sendFullText();
  await bound.settled();
  assert.deepEqual(sent.map((item) => [item[0], item.at(-1)]), [['changed', sha('Fuel!')], ['changed', 'undo'], ['fullText', 3]]);
  assert.equal(sent[2][2], 'Fuel');
});

test('a reload from disk is held and the model read-only; Take sends it as the person\'s change, Restore puts the shared text back', async () => {
  for (const choice of ['take', 'restore'] as const) {
    const model = new FakeTextModel('Fuel for three days.');
    const { channel: wire, sent } = channel();
    let diskSync = false;
    const readOnly: boolean[] = [];
    let asked = 0;
    const bound = new MonacoBoundDocument({ doc: 'doc-1', model, channel: wire, isDiskSync: () => diskSync, onDiskChange: () => { asked += 1; }, setReadOnly: (value) => readOnly.push(value) });
    diskSync = true;
    model.applyEdits([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 21 }, text: 'Fuel for five days.' }]);
    diskSync = false;
    await bound.settled();
    assert.equal(sent.length, 0, 'nothing leaves before the person chooses');
    assert.equal(asked, 1);
    assert.equal(bound.diskChangeHeld, true);
    // A request from the backend waits for the choice.
    assert.equal(bound.applyRemote(4, [{ offset: 0, length: 0, text: '> ' }], 1), false);
    if (choice === 'take') bound.takeDiskChange();
    else bound.restoreDiskChange();
    await bound.settled();
    assert.deepEqual(readOnly, [true, false]);
    if (choice === 'take') {
      assert.deepEqual(sent.map((item) => item[0]), ['changed', 'applied']);
      assert.equal(sent[0][4], sha('Fuel for five days.'));
      assert.deepEqual(sent[1].slice(2, 4), [4, false], 'the waiting request is refused at the new version, so the backend moves it');
    } else {
      assert.equal(model.getValue(), 'Fuel for three days.', 'the shared text is back');
      assert.deepEqual(sent.map((item) => item[0]), ['synced', 'applied']);
      assert.equal(sent[0][3], sha('Fuel for three days.'));
      assert.deepEqual(sent[1].slice(2, 4), [4, false]);
    }
  }
});

test('changes the backend never confirmed are known, and can be held for the person\'s choice after a reconnect', async () => {
  const model = new FakeTextModel('Fuel');
  let fail = true;
  const bound = new MonacoBoundDocument({
    doc: 'doc-1', model,
    channel: { changed: async () => { if (fail) throw new Error('closed'); }, applied: async () => undefined, fullText: async () => undefined, synced: async () => undefined },
  });
  model.type(4, 0, ' and water');
  await bound.settled();
  await settle();
  assert.equal(bound.hasUnconfirmedChanges, true);
  fail = false;
  const again = new MonacoBoundDocument({ doc: 'doc-2', model, channel: channel().channel });
  model.applyEdits([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 15 }, text: 'Fuel' }]);
  again.holdChange('Fuel and water');
  assert.equal(again.diskChangeHeld, true);
  assert.equal(model.getValue(), 'Fuel and water');
});
