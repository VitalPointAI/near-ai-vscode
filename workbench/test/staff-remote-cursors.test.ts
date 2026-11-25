// Phase 33 plan 29 (D-18, D-56; RESEARCH N2, N6; T-33-N3, T-33-N19): other people's cursors in a bound product. A selection in one person's tab
// becomes Yjs relative positions in their session backend and goes out as sealed presence through the replicator (at most 10 a second, nothing
// stored). The other person's backend opens it, turns the positions into offsets in their own copy of the text, and their tab draws Monaco
// decorations: one of 8 fixed colour classes, a caret, and the name and position word as plain text in the hover and an injected label. Names
// never reach a class name or a style. Fictional exercise data only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CURSOR_SLOT_COUNT, cursorLabel, plainMarkdown, RemoteCursors, type Decoration } from '../extension/src/browser/staff/remote-cursors.ts';
import type { RemoteCursor } from '../extension/src/common/staff-binding.ts';
import { FakeTimers } from '../../src/test/helpers/liveWorld.ts';
import {
  FakeDecorations, FakeSourceModel, FakeTab, FakeTextModel, SEED, relayPresence, settle, until, withProduct, type FakeEditor, type Person,
} from './helpers/staff-binding-world.ts';

/** Opens the product in a new tab of `person` and waits until it is bound. */
async function openBound(person: Person): Promise<{ tab: FakeTab; model: FakeSourceModel; editor: FakeEditor; doc: string }> {
  const tab = new FakeTab(person.service);
  const model = new FakeSourceModel(person.uri, '');
  const editor = tab.open(model);
  const entry = await until(() => tab.contribution.bindings().find((item) => item.model === model), (item) => item?.state === 'bound', () => `the bound product (${person.logs.join(' | ')})`);
  return { tab, model, editor, doc: entry?.doc as string };
}

/** Waits until `from`'s backend sent presence in the product's key group (its cursor), then relays everything it sent to `to`. */
async function cursorSent(from: Person, to: Person, stream: string): Promise<number> {
  await until(() => from.replicator.posts.some((post) => post.cell === stream && post.sealed !== undefined), (sent) => sent, 'presence in the product');
  return relayPresence(from, to);
}

const carets = (editor: FakeEditor): Decoration[] => editor.decorations.all().filter((item) => item.options.description === 'sterling-remote-cursor');
const selections = (editor: FakeEditor): Decoration[] => editor.decorations.all().filter((item) => item.options.description === 'sterling-remote-selection');
const unescape = (value: string): string => value.replace(/\\([!-/:-@[-`{-~])/g, '$1');
const SLOT_CLASS = /^sterling-cursor-slot-[0-7]$/;

/** Every class name a decoration carries, split. */
function classesOf(decoration: Decoration): string[] {
  const { className, beforeContentClassName, afterContentClassName, linesDecorationsClassName, after } = decoration.options;
  return [className, beforeContentClassName, afterContentClassName, linesDecorationsClassName, after?.inlineClassName].flatMap((value) => (value ?? '').split(' ')).filter((name) => name !== '');
}

test('tracer: Blake\'s selection in his editor shows in Avery\'s editor over the same text, with his name and position word', async () => {
  const timers = new FakeTimers();
  await withProduct(async ({ avery, blake, stream }) => {
    const left = await openBound(avery);
    const right = await openBound(blake);
    const text = right.model.textModel.getValue();
    const at = text.indexOf('three');
    assert.ok(at > 0 && text.endsWith(SEED));
    right.editor.select(at, at + 'three'.length);
    await settle();
    assert.ok(await cursorSent(blake, avery, stream) > 0, 'Blake\'s backend sent presence through the replicator');
    const [caret] = await until(() => carets(left.editor), (list) => list.length === 1, () => `Blake's caret in Avery's editor (${avery.logs.join(' | ')})`);
    const [selected] = selections(left.editor);
    assert.ok(selected !== undefined, 'the selection is drawn');
    const model = left.model.textModel;
    assert.deepEqual(selected.range, { ...rangeOf(model, at, at + 5) });
    assert.deepEqual(caret.range, rangeOf(model, at + 5, at + 5));
    assert.equal(unescape(caret.options.hoverMessage?.value ?? ''), 'Blake Rivers, j4-planner');
    assert.equal(caret.options.after?.content, 'Blake Rivers, j4-planner');
    assert.ok(classesOf(caret).includes('sterling-cursor-caret'));
    assert.equal(classesOf(caret).filter((name) => SLOT_CLASS.test(name)).length > 0, true, 'a colour slot class');
    assert.deepEqual(carets(right.editor), [], 'a person never sees their own cursor as someone else\'s');
  }, { timers });
});

test('a selection still goes out when each part of the tab holds its own wrapper of the editor (found by the two-browser run)', async () => {
  const timers = new FakeTimers();
  await withProduct(async ({ avery, blake, stream }) => {
    const left = await openBound(avery);
    const tab = new FakeTab(blake.service);
    const model = new FakeSourceModel(blake.uri, '');
    const right = tab.open(model, { wrapperEach: true });
    await until(() => tab.contribution.bindings().find((item) => item.model === model)?.state, (state) => state === 'bound', 'Blake\'s bound product');
    const at = model.textModel.getValue().indexOf('three');
    right.select(at, at);
    await settle();
    await cursorSent(blake, avery, stream);
    await until(() => carets(left.editor).length, (count) => count === 1, 'Blake\'s caret in Avery\'s editor');
  }, { timers });
});

test('the hover is plain text that renders no link, HTML or icon, and the label is the name as given', () => {
  const name = '"><style>body{display:none}</style><img src=x onerror=alert(1)> [x](javascript:alert(1)) $(zap) **Robin**';
  const markdown = plainMarkdown(name);
  assert.equal(unescape(markdown.value), name, 'every character of the name is kept');
  assert.equal(markdown.isTrusted, false);
  assert.equal(markdown.supportHtml, false);
  assert.equal(markdown.supportThemeIcons, false);
  assert.doesNotMatch(markdown.value, /(^|[^\\])[<>[\]()$*`]/, 'no markdown, HTML or icon syntax is left unescaped');
  assert.equal(cursorLabel({ name, position: 'j2 analyst' }), `${name}, j2 analyst`);
});

test('a name with CSS or HTML characters is in the hover and the label verbatim, and in no class name or style', () => {
  const name = 'Robin"}.monaco-editor{display:none} <b>';
  const target = new FakeDecorations();
  const cursors = new RemoteCursors(new FakeTextModel('Fuel for three days.'), target);
  cursors.show([{ member: 'mbr-robin', name, anchor: 0, head: 4 }]);
  const all = target.all();
  assert.equal(all.length, 2);
  for (const decoration of all) {
    for (const className of classesOf(decoration)) assert.match(className, /^sterling-cursor-[a-z0-9-]+$/, 'only fixed class names');
    assert.equal(unescape(decoration.options.hoverMessage?.value ?? ''), name);
  }
  assert.equal(all.find((item) => item.options.after !== undefined)?.options.after?.content, name);
  assert.equal(typeof (globalThis as { document?: unknown }).document, 'undefined', 'no page here: a style element could not have been made');
});

test('50 selection changes in one second send at most 10 cursor messages, and the last position is the one others see', async () => {
  const timers = new FakeTimers();
  await withProduct(async ({ avery, blake, stream }) => {
    const left = await openBound(avery);
    const right = await openBound(blake);
    await settle();
    const base = right.model.textModel.getValue().length - SEED.length;
    // Warm the product's presence keys before measuring the burst.
    right.editor.select(base, base);
    await until(() => blake.replicator.posts.some((post) => post.cell === stream && post.sealed !== undefined), (sent) => sent, 'the first cursor message');
    await timers.advance(1000);
    blake.replicator.posts.length = 0;
    for (let index = 0; index < 50; index += 1) {
      right.editor.select(base + (index % SEED.length), base + (index % SEED.length));
      if (index < 49) await timers.advance(20);
    }
    // Measure the half-open first second. The send at 1000 ms belongs to the next window.
    await timers.advance(19);
    const sent = blake.replicator.posts.filter((post) => post.cell === stream && post.sealed !== undefined).length;
    assert.ok(sent > 0 && sent <= 10, `cursor messages in one second: ${sent}`);
    await timers.advance(200);
    relayPresence(blake, avery);
    const last = base + (49 % SEED.length);
    await until(() => carets(left.editor)[0]?.range, (range) => JSON.stringify(range) === JSON.stringify(rangeOf(left.model.textModel, last, last)), 'the last position');
  }, { timers });
});

test('a cursor with no heartbeat for 30 seconds is removed', async () => {
  const timers = new FakeTimers();
  await withProduct(async ({ avery, blake, stream }) => {
    const left = await openBound(avery);
    const right = await openBound(blake);
    right.editor.select(right.model.textModel.getValue().length - 3, right.model.textModel.getValue().length - 3);
    await settle();
    await cursorSent(blake, avery, stream);
    await until(() => carets(left.editor).length, (count) => count === 1, 'Blake\'s caret');
    // Blake's heartbeats are lost from here on: Avery's own heartbeat checks the time to live.
    await timers.advance(35_000);
    blake.replicator.posts.length = 0;
    await until(() => left.editor.decorations.all().length, (count) => count === 0, 'every decoration of Blake removed');
  }, { timers });
});

test('a leave frame removes the person\'s cursor at once', async () => {
  const timers = new FakeTimers();
  await withProduct(async ({ avery, blake, stream }) => {
    const left = await openBound(avery);
    const right = await openBound(blake);
    right.editor.select(right.model.textModel.getValue().length - 3, right.model.textModel.getValue().length);
    await settle();
    await cursorSent(blake, avery, stream);
    await until(() => left.editor.decorations.all().length, (count) => count === 2, 'Blake\'s caret and selection');
    blake.replicator.posts.length = 0;
    await blake.live.stop();
    assert.ok(blake.replicator.posts.some((post) => post.leave === true), 'Blake\'s session left');
    relayPresence(blake, avery);
    await until(() => left.editor.decorations.all().length, (count) => count === 0, 'Blake\'s decorations removed');
  }, { timers });
});

test('after a remote insert before Blake\'s cursor, his decoration in Avery\'s editor moves with the text', async () => {
  const timers = new FakeTimers();
  await withProduct(async ({ avery, blake, carry, stream }) => {
    const left = await openBound(avery);
    const right = await openBound(blake);
    const text = right.model.textModel.getValue();
    const at = text.indexOf('three');
    right.editor.select(at, at);
    await settle();
    await cursorSent(blake, avery, stream);
    await until(() => carets(left.editor)[0]?.range, (range) => JSON.stringify(range) === JSON.stringify(rangeOf(left.model.textModel, at, at)), 'Blake\'s caret');
    // Blake types before his own cursor; no selection event goes out, so the backend's relative position alone moves it.
    const body = text.length - SEED.length;
    right.model.textModel.type(body, 0, 'Water. ');
    await settle();
    await blake.service.flush(right.doc);
    await carry(blake, avery);
    avery.replicator.emit({ pulled: 1 });
    await until(() => left.model.textModel.getValue(), (value) => value.includes('Water. Fuel'), 'Blake\'s text in Avery\'s model');
    const moved = at + 'Water. '.length;
    await until(() => carets(left.editor)[0]?.range, (range) => JSON.stringify(range) === JSON.stringify(rangeOf(left.model.textModel, moved, moved)), 'the caret moved with the text');
  }, { timers });
});

test('at most 8 colour classes are used, whatever the number of people', () => {
  const target = new FakeDecorations();
  const cursors = new RemoteCursors(new FakeTextModel('Fuel for three days and water for two.'), target);
  const many: RemoteCursor[] = Array.from({ length: 40 }, (_, index) => ({ member: `mbr-person-${index}`, name: `Person ${index}`, anchor: index % 30, head: index % 30 }));
  cursors.show(many);
  const slots = new Set(target.all().flatMap((decoration) => classesOf(decoration).filter((name) => SLOT_CLASS.test(name))));
  assert.equal(CURSOR_SLOT_COUNT, 8);
  assert.ok(slots.size > 1 && slots.size <= 8, `slots used: ${slots.size}`);
  cursors.show([]);
  assert.equal(target.all().length, 0, 'an empty list removes every decoration');
});

function rangeOf(model: FakeTextModel, start: number, end: number) {
  const from = model.getPositionAt(start);
  const to = model.getPositionAt(end);
  return { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column };
}
