// Phase 33 plan 25 (D-17, D-52 to D-55; RESEARCH N3 and N5; Pitfalls N8.2 and N8.3): the backend's mirror of a bound browser model, and the binding
// service that runs the executed binding core (33-04) over it, from the engine bundle. The mirror checks each change's hash and asks for the whole
// text once on a mismatch; a request beaten by the person's typing is moved past it and sent again. The service binds products of an open shared
// project only, one tab per product per session, gives a model that is not the shared text the shared text, and detaches a closed connection.
// Fictional exercise data only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { RemoteBoundDocument, moveEdits } from '../extension/src/node/staff/remote-bound-document.ts';
import { applyBindingEdits, OTHER_TAB_TEXT, STAFF_BINDING_TEXT, type BindingEdit } from '../extension/src/common/staff-binding.ts';
import type { EngineDocumentChange } from '../extension/src/node/staff/staff-engine.ts';
import { productOutput } from '../../src/staff/replica/productFeed.ts';
import { FakeSourceModel, FakeTab, PRODUCT, SEED, engine, settle, until, withProduct, type Person } from './helpers/staff-binding-world.ts';

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const RESYNC = 'Resynchronized the shared product editor.';

/** A mirror over a browser text kept in the test: requests apply only at the browser's version, as the Monaco end does. */
function mirrorWorld(initial: string) {
  const browser = { text: initial, version: 1 };
  const requests: Array<{ request: number; edits: readonly BindingEdit[]; base: number }> = [];
  let asked = 0;
  let adopted = 0;
  const mirror = new RemoteBoundDocument(initial, 1, {
    applyEdits: (request, edits, base) => { requests.push({ request, edits, base }); },
    requestFullText: () => { asked += 1; },
  }, { onAdopted: () => { adopted += 1; } });
  const changes: EngineDocumentChange[] = [];
  mirror.onDidChange((change) => changes.push(change));
  return {
    mirror, browser, requests, changes, asked: () => asked, adopted: () => adopted,
    type(edits: BindingEdit[]) {
      browser.text = applyBindingEdits(browser.text, edits);
      browser.version += 1;
      mirror.browserChanged(edits, browser.version, sha(browser.text));
    },
    /** The browser answers the newest request: applied only at its own version. */
    answer() {
      const last = requests.at(-1);
      assert.ok(last);
      const ok = last.base === browser.version;
      if (ok) {
        browser.text = applyBindingEdits(browser.text, last.edits);
        browser.version += 1;
      }
      mirror.browserApplied(last.request, ok, browser.version, sha(browser.text));
    },
  };
}

test('a change whose hash matches reaches the core once, at the mirror\'s next version', () => {
  const world = mirrorWorld('Fuel');
  world.type([{ offset: 4, length: 0, text: ' and water' }]);
  assert.deepEqual(world.changes, [{ edits: [{ offset: 4, length: 0, text: ' and water' }], text: 'Fuel and water', version: 2 }]);
  assert.equal(world.mirror.version, 2);
  assert.equal(world.asked(), 0);
});

test('a hash mismatch asks for the whole text once and adopts it without a change; the core then resynchronizes', () => {
  const world = mirrorWorld('Fuel');
  world.mirror.browserChanged([{ offset: 0, length: 0, text: 'X' }], 2, sha('not this text'));
  world.mirror.browserChanged([{ offset: 0, length: 0, text: 'Y' }], 3, sha('nor this'));
  assert.equal(world.asked(), 1, 'asked once');
  assert.deepEqual(world.changes, []);
  world.mirror.browserText('YXFuel', 3);
  assert.equal(world.adopted(), 1);
  assert.equal(world.mirror.getText(), 'YXFuel');
  assert.equal(world.mirror.version, 1, 'adopting is not a change to the core');
});

test('a request beaten by typing is moved past it and sent again; the core hears the echo, then the typing moved past it, and both ends match', async () => {
  const world = mirrorWorld('Fuel for three days.');
  const applying = world.mirror.applyEdits([{ offset: 15, length: 4, text: 'four' }], 'Fuel for three four.', 1);
  world.type([{ offset: 0, length: 0, text: 'Water and ' }]);
  world.answer();
  assert.equal(world.requests.length, 2, 'sent again');
  assert.deepEqual(world.requests[1], { request: world.requests[0].request, edits: [{ offset: 25, length: 4, text: 'four' }], base: 2 });
  world.answer();
  assert.equal(await applying, true);
  assert.deepEqual(world.changes.map((change) => [change.text, change.version]), [['Fuel for three four.', 2], ['Water and Fuel for three four.', 3]]);
  assert.equal(world.mirror.getText(), world.browser.text);
  assert.equal(world.asked(), 0);
});

test('moving edits keeps the other side\'s insert at the same place before or after, and shrinks a delete around it', () => {
  assert.deepEqual(moveEdits([{ offset: 5, length: 0, text: 'a' }], [{ offset: 5, length: 0, text: 'bb' }], 'before'), [{ offset: 5, length: 0, text: 'a' }]);
  assert.deepEqual(moveEdits([{ offset: 5, length: 0, text: 'a' }], [{ offset: 5, length: 0, text: 'bb' }], 'after'), [{ offset: 7, length: 0, text: 'a' }]);
  assert.deepEqual(moveEdits([{ offset: 2, length: 6, text: '' }], [{ offset: 4, length: 2, text: '' }], 'before'), [{ offset: 2, length: 4, text: '' }]);
});

// ---- the service and the executed binding core --------------------------------------------------------------------------------------------------

/** Opens the product in a tab of `person`, and waits until it is bound. */
async function openBound(person: Person, tab: FakeTab = new FakeTab(person.service), text = ''): Promise<{ tab: FakeTab; model: FakeSourceModel; doc: string }> {
  const model = new FakeSourceModel(person.uri, text);
  tab.open(model);
  const entry = await until(() => tab.contribution.bindings().find((item) => item.model === model), (item) => item?.state === 'bound', () => `the bound product (${person.logs.join(' | ')})`);
  return { tab, model, doc: entry?.doc as string };
}

/** The product's text in the shared record, as the person's live engine holds it. */
async function sharedBody(person: Person, stream: string): Promise<string | undefined> {
  const shared = person.live.shared(person.device.project.projectId);
  const state = await shared?.project.state() as unknown as { fold: never } | undefined;
  return state === undefined ? undefined : productOutput(state.fold, stream, PRODUCT)?.text;
}

test('tracer: a change typed in one model reaches the backend binding and the shared record, and appears in the other person\'s model without echo', async () => {
  await withProduct(async ({ avery, blake, stream, carry }) => {
    const left = await openBound(avery);
    const right = await openBound(blake);
    const initial = left.model.textModel.getValue();
    assert.ok(initial.endsWith(SEED) && initial.length > SEED.length, 'the projected header and the text');
    assert.equal(right.model.textModel.getValue(), initial);
    const leftApplied = left.model.textModel.applied;
    left.model.textModel.type(initial.length, 0, ' Water for two.');
    await settle();
    await avery.service.flush(left.doc);
    assert.equal(await sharedBody(avery, stream), `${SEED} Water for two.`);
    assert.ok(avery.replicator.appended > 0, 'the replicator was told to push');
    await carry(avery, blake);
    blake.replicator.emit({ pulled: 1 });
    await until(() => right.model.textModel.getValue(), (text) => text === `${initial} Water for two.`, 'Blake\'s model');
    assert.equal(right.model.textModel.canUndo, false, 'another person\'s change adds nothing to the native undo stack');
    await settle();
    assert.equal(left.model.textModel.applied, leftApplied, 'nothing was applied back into the author\'s model');
    const blakeProject = blake.live.shared(blake.device.project.projectId)?.project as unknown as { findOwnAll(kind: string, predicate: () => boolean): Promise<unknown[]> };
    assert.deepEqual(await blakeProject.findOwnAll('doc.update', () => true), [], 'and nothing was echoed into a shared change');
  });
});

test('a model that is not a product is never touched, and the first open of a stale file is given the shared text with one resync line', async () => {
  await withProduct(async ({ avery }) => {
    const tab = new FakeTab(avery.service);
    const other = new FakeSourceModel(`${avery.uri.replace(/[^/]+$/, '')}notes.md`, 'My own notes.');
    tab.open(other);
    await until(() => tab.contribution.bindings().find((item) => item.model === other)?.state, (state) => state === 'none', 'the answer');
    assert.equal(other.textModel.applied, 0);
    assert.equal(other.textModel.getValue(), 'My own notes.');
    const { model } = await openBound(avery, tab, 'An old copy.');
    assert.notEqual(model.textModel.getValue(), 'An old copy.');
    assert.deepEqual(avery.logs.filter((line) => line === RESYNC), [RESYNC]);
  });
});

test('a forced hash mismatch makes the backend ask for the whole text once, and the binding core resynchronizes with one log line', async () => {
  await withProduct(async ({ avery }) => {
    const { tab, model } = await openBound(avery);
    const logged = avery.logs.length;
    let asked = 0;
    tab.events.onDidRequestFullText(() => { asked += 1; });
    const initial = model.textModel.getValue();
    // A change event lost on the way: the model now holds text the backend never heard of, and the next change's hash shows it.
    model.textModel.diverge(`${initial} lost`);
    model.textModel.type(model.textModel.getValue().length, 0, '!');
    await until(() => avery.logs.slice(logged).filter((line) => line === RESYNC).length, (count) => count === 1, () => `the resync line (${avery.logs.join(' | ')})`);
    await until(() => model.textModel.getValue(), (text) => text === initial, 'the shared text back');
    await settle();
    assert.equal(asked, 1);
    assert.deepEqual(avery.logs.slice(logged).filter((line) => line === RESYNC), [RESYNC]);
  });
});

test('an edit touching the header is reverted with the core\'s notice', async () => {
  await withProduct(async ({ avery }) => {
    const { tab, model } = await openBound(avery);
    const initial = model.textModel.getValue();
    model.textModel.type(0, 3, 'XYZ');
    await until(() => model.textModel.getValue(), (text) => text === initial, 'the header back');
    await settle();
    assert.deepEqual(tab.warnings, ['The header is kept by the project. Change it from the Staff Room.']);
  });
});

test('a disk change is offered as Take This Change as My Edit or Restore: take writes it as the person\'s edit, restore puts the shared text back', async () => {
  await withProduct(async ({ avery, stream }) => {
    for (const [choice, onDisk] of [[STAFF_BINDING_TEXT.take, 'Fuel for five days.'], [STAFF_BINDING_TEXT.restore, 'Fuel for six days.']] as const) {
      const { tab, model, doc } = await openBound(avery);
      const before = model.textModel.getValue();
      const header = before.slice(0, before.length - ((await sharedBody(avery, stream)) ?? '').length);
      tab.choice = choice;
      let saved: string | undefined;
      model.onSaved = async (text) => { saved = text; };
      model.reloadFromDisk(`${header}${onDisk}`);
      await until(() => tab.warnings.length, (count) => count === 1, 'the question');
      assert.deepEqual(tab.warnings, [STAFF_BINDING_TEXT.diskChanged]);
      await settle();
      await avery.service.flush(doc);
      if (choice === STAFF_BINDING_TEXT.take) {
        assert.equal(await sharedBody(avery, stream), 'Fuel for five days.', 'the change is the person\'s edit');
      } else {
        assert.equal(model.textModel.getValue(), before);
        assert.equal(await sharedBody(avery, stream), 'Fuel for five days.', 'the shared text is unchanged');
        assert.equal(saved, before, 'the file follows the shared text');
      }
      model.dispose();
      await settle();
    }
  });
});

test('a second tab of the session gets the product read-only with the other-tab sentence, and edits when the first lets go', async () => {
  await withProduct(async ({ avery }) => {
    const first = await openBound(avery);
    const tab = new FakeTab(avery.service);
    const model = new FakeSourceModel(avery.uri, first.model.textModel.getValue());
    const editor = tab.open(model);
    await until(() => editor.readOnly, (readOnly) => readOnly, 'read-only');
    assert.equal(editor.readOnlyMessage, OTHER_TAB_TEXT);
    assert.deepEqual(avery.service.boundProducts(), [`${avery.device.project.projectId}/${PRODUCT}`]);
    first.model.dispose();
    await until(() => tab.contribution.bindings().find((item) => item.model === model)?.state, (state) => state === 'bound', 'the second tab edits');
    assert.equal(editor.readOnly, false);
  });
});

test('a dropped connection detaches; when it comes back the model attaches again with the current text and one resync line', async () => {
  await withProduct(async ({ avery, blake, carry }) => {
    const left = await openBound(avery);
    const logged = avery.logs.length;
    const initial = left.model.textModel.getValue();
    left.tab.drop();
    await settle();
    assert.deepEqual(avery.service.boundProducts(), []);
    // Meanwhile Blake writes, and it reaches Avery's computer while the tab is away.
    const right = await openBound(blake);
    right.model.textModel.type(initial.length, 0, ' Water for two days.');
    await settle();
    await blake.service.flush(right.doc);
    await carry(blake, avery);
    left.tab.connect();
    await until(() => left.model.textModel.getValue(), (text) => text === `${initial} Water for two days.`, 'the current text');
    await until(() => left.tab.contribution.bindings()[0]?.state, (state) => state === 'bound', 'bound again');
    assert.deepEqual(avery.logs.slice(logged).filter((line) => line === RESYNC), [RESYNC]);
  });
});

test('saving a bound product flushes the binding first, so the projector then finds the file as projected', async () => {
  await withProduct(async ({ avery }) => {
    const { model } = await openBound(avery);
    const initial = model.textModel.getValue();
    model.onSaved = async (text) => { mkdirSync(path.dirname(avery.file), { recursive: true }); writeFileSync(avery.file, text); };
    model.textModel.type(initial.length, 0, ' Water for two.');
    await settle();
    await model.save();
    model.dispose();
    await settle();
    const input = await avery.live.projectionInput(avery.device.project.projectId);
    const result = await engine.projectLive(avery.device.at.root, input as never, { globalStorageDir: avery.device.at.global, project: avery.device.project.projectId });
    assert.deepEqual(result.left, [], 'no conflict listed');
  });
});
