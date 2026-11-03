// The New item and Edit item form (Phase 62 plan 13): media/board/form.js run with board.js, menu.js and detail.js in node:vm against the fake DOM. The
// model and detail messages come from the real board model over a signed in-memory log, so the page and the host contract cannot drift. Assertions compare
// strings, ids and booleans, never whole DOM nodes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { buildBoardModel, buildCardDetail } from '../domain/team/board';
import type { BoardModel } from '../domain/team/board';
import { CHORE_ID, boardWorld, seedStandardBoard } from './helpers/teamBoardWorld';
import type { BoardWorld } from './helpers/teamBoardWorld';
import { createBoardHarness } from './helpers/fakeDom';
import type { BoardHarness, FakeNode } from './helpers/fakeDom';

const NOW = Date.parse('2026-03-05T12:00:00.000Z');
const FORM_JS = readFileSync(path.resolve(__dirname, '../../media/board/form.js'), 'utf8');
const NEW_ID = `item:${'0'.repeat(22)}9X2M`;

type Viewer = 'owner' | 'dev' | 'observer';

const modelOf = (world: BoardWorld, viewer: Viewer): BoardModel =>
  buildBoardModel(world.state, { nowMs: NOW, status: { kind: 'live', text: 'Live' }, canWrite: viewer !== 'observer', viewerId: world[viewer].memberId });

async function standard(): Promise<BoardWorld> {
  const world = await boardWorld();
  seedStandardBoard(world);
  return world;
}

function start(options: { width?: number; state?: unknown } = {}): BoardHarness {
  const h = createBoardHarness({ width: options.width ?? 800, ...(options.state === undefined ? {} : { state: options.state }) });
  h.load(['board.js', 'menu.js', 'detail.js', 'form.js']);
  return h;
}

async function drawn(viewer: Viewer = 'dev', width = 800): Promise<{ h: BoardHarness; world: BoardWorld }> {
  const world = await standard();
  const h = start({ width });
  h.deliver({ type: 'state', model: modelOf(world, viewer) });
  return { h, world };
}

const api = (h: BoardHarness): Record<string, any> => h.window.NearAiBoard;
const text = (n: FakeNode | null | undefined): string => n?.textContent ?? '';
const form = (h: BoardHarness): FakeNode | null => h.$('#item-form');
const input = (h: BoardHarness, name: string): FakeNode => {
  const found = h.$(`#item-${name}`);
  assert.ok(found, `field ${name} exists`);
  return found;
};
const newItemButton = (h: BoardHarness): FakeNode => {
  const found = h.$$('button').find((b) => text(b) === 'New item');
  assert.ok(found, 'the New item button is drawn');
  return found;
};
const buttonNamed = (h: BoardHarness, label: string): FakeNode | undefined => h.$$('#item-form button').find((b) => text(b) === label);
const posts = (h: BoardHarness, type: string): Array<Record<string, any>> => h.posts.filter((p) => p.type === type);
// The live region is cleared and set again after 100 ms so repeats are read, so time moves on before it is read.
const said = (h: BoardHarness): string => { h.advance(150); return h.live(); };
const errorOf = (h: BoardHarness, name: string): string => text(h.$(`#item-${name}-error`));

function fill(h: BoardHarness, values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) h.setValue(input(h, name), value, name === 'type' ? 'change' : 'input');
}

const setTitle = (h: BoardHarness, value: string): void => { h.setValue(input(h, 'title'), value, 'input'); };

function openNew(h: BoardHarness): void {
  const button = newItemButton(h);
  button.focus();
  h.click(button);
  assert.ok(form(h), 'the form is open');
}

// The host adds the item and the page gets saved, then the next state.
function hostSaves(h: BoardHarness, world: BoardWorld, id: string, title: string): void {
  world.accept(world.dev, 'item.created', { id, kind: 'chore', title, scope: ['src/a/**'], requirements: [], mustHaves: [], estimate: { tokens: 1000 } });
  h.deliver({ type: 'saved', itemId: id });
  h.deliver({ type: 'state', model: modelOf(world, 'dev') });
}

// ---- the form opens with the UI-SPEC fields --------------------------------------------------------------------------------------------------

test('New item opens form#item-form in the drawer with every field, the hints and the buttons, and focus on Type', async () => {
  const { h } = await drawn();
  assert.equal(form(h), null, 'no form before it is asked for');
  openNew(h);
  const f = form(h)!;
  assert.equal(f.parentNode, h.$('#detail'), 'the form lives in the shared drawer');
  assert.equal(h.$('#detail')!.hidden, false);
  assert.equal(text(f.querySelector('h2')), 'New item');
  assert.deepEqual(Array.from(f.querySelectorAll('label')).map((l) => text(l)), ['Type', 'Title', 'Description (optional)', 'Parts of the project this covers (optional)', 'Estimate in tokens (optional)']);
  assert.deepEqual(Array.from(f.querySelectorAll('label')).map((l) => l.getAttribute('for')), ['item-type', 'item-title', 'item-description', 'item-files', 'item-estimate']);
  const type = input(h, 'type');
  assert.equal(type.localName, 'select');
  assert.deepEqual(Array.from(type.querySelectorAll('option')).map((o) => text(o)), ['Bug', 'Chore', 'Experiment']);
  assert.equal(type.value, 'chore', 'Chore is the default');
  assert.equal(h.focused(), type, 'focus starts on Type');
  const estimate = input(h, 'estimate');
  assert.equal(estimate.getAttribute('type'), 'number');
  assert.equal(estimate.getAttribute('min'), '1000');
  assert.equal(estimate.getAttribute('step'), '1000');
  const hints = Array.from(f.querySelectorAll('.hint')).map((n) => text(n));
  assert.deepEqual(hints, ['Add a folder or file name on each line, for example "settings". Leave empty if you are not sure.', 'A rough size is fine. Typical plans are 50,000 to 100,000.']);
  // J-02: the Backlog rule is its own note in normal text, not a faint hint.
  const rule = f.querySelector('.readiness')!;
  assert.equal(text(rule), 'This item stays in Backlog until you say which parts of the project it covers and roughly how big it is.');
  assert.equal(rule.getAttribute('role'), 'note');
  assert.equal(rule.className, 'readiness');
  assert.deepEqual(Array.from(f.querySelectorAll('button')).map((b) => text(b)), ['Choose folders...', 'Add item', 'Close form']);
  assert.equal(buttonNamed(h, 'Add item')!.getAttribute('type'), 'submit');
});

test('J-01: Choose folders... asks the host for the picker and adds the folders it returns as lines, once each, with plain announcements', async () => {
  const { h } = await drawn();
  openNew(h);
  const files = input(h, 'files');
  h.setValue(files, 'settings');
  h.click(buttonNamed(h, 'Choose folders...')!);
  assert.deepEqual(posts(h, 'choose-folders'), [{ type: 'choose-folders' }]);
  h.deliver({ type: 'folders-chosen', paths: ['src/settings', 'docs', '../outside', 'settings'] });
  assert.equal(files.value, 'settings\nsrc/settings\ndocs', 'new folders are added under what was typed, a path outside the project and a repeat are not');
  assert.equal(said(h), 'Added 2 parts of the project.');
  assert.equal(h.focused(), files);
  assert.equal(errorOf(h, 'files'), '');
  h.deliver({ type: 'folders-chosen', paths: ['docs'] });
  assert.equal(files.value, 'settings\nsrc/settings\ndocs');
  assert.equal(said(h), 'Those parts of the project are already listed.');
  h.deliver({ type: 'folders-chosen', paths: [] });
  assert.equal(said(h), 'No folders were chosen inside this project.');
  assert.equal(files.value, 'settings\nsrc/settings\ndocs');
});

// ---- validation -----------------------------------------------------------------------------------------------------------------------------

test('submitting an empty title marks Title invalid and linked, moves focus to it, and says one field needs attention', async () => {
  const { h } = await drawn();
  openNew(h);
  h.click(buttonNamed(h, 'Add item')!);
  const title = input(h, 'title');
  assert.equal(title.getAttribute('aria-invalid'), 'true');
  assert.equal(title.getAttribute('aria-describedby'), 'item-title-error');
  assert.equal(errorOf(h, 'title'), 'Enter a title.');
  assert.equal(h.focused(), title);
  assert.equal(said(h), '1 field needs attention.');
  assert.equal(posts(h, 'new-item').length, 0, 'nothing is sent');
  // Typing a good title clears the message as the person types.
  h.setValue(title, 'Tidy up');
  assert.equal(title.getAttribute('aria-invalid'), null);
  assert.equal(errorOf(h, 'title'), '');
});

test('each rule has its own message, on blur and on submit, and several problems are counted', async () => {
  const { h } = await drawn();
  openNew(h);
  const title = input(h, 'title');
  title.focus();
  h.setValue(title, 't'.repeat(201));
  title.blur();
  assert.equal(errorOf(h, 'title'), 'The title must be 200 characters or fewer.');
  h.setValue(title, 'Fine');
  assert.equal(errorOf(h, 'title'), '');

  const files = input(h, 'files');
  for (const bad of ['../x', 'src/../x', '/etc/passwd', 'src\\services']) {
    h.setValue(files, `src/ok/**\n${bad}`);
    files.focus();
    files.blur();
    assert.equal(errorOf(h, 'files'), 'One of these lines is not a folder or file name in this project. Remove it and try again.', bad);
    assert.equal(files.getAttribute('aria-describedby'), 'item-files-error item-files-hint', 'the hint stays described too');
  }
  files.focus();
  h.setValue(files, '  src/a/**  \n\n docs/*.md ');
  files.blur();
  assert.equal(errorOf(h, 'files'), '', 'blank lines and spaces are fine');
  assert.equal(files.getAttribute('aria-invalid'), null);
  files.focus();
  h.setValue(files, Array.from({ length: 65 }, (_, i) => `src/d${i}`).join('\n'));
  files.blur();
  assert.equal(errorOf(h, 'files'), 'List 64 parts of the project or fewer.', 'more than 64 lines is refused with its own sentence');

  const estimate = input(h, 'estimate');
  for (const bad of ['12.5', '0', '-5', '1e3', 'abc']) {
    estimate.focus();
    h.setValue(estimate, bad);
    estimate.blur();
    assert.equal(errorOf(h, 'estimate'), 'Enter a whole number of tokens, 1 or more.', bad);
  }
  estimate.focus();
  h.setValue(estimate, '48000');
  estimate.blur();
  assert.equal(errorOf(h, 'estimate'), '');

  // Two problems at once: focus goes to the first one in page order and both are counted.
  h.setValue(title, '');
  h.setValue(estimate, '0');
  h.setValue(files, 'src/a/**');
  h.click(buttonNamed(h, 'Add item')!);
  assert.equal(h.focused(), title);
  assert.equal(said(h), '2 fields need attention.');
  assert.equal(posts(h, 'new-item').length, 0);
});

test('the description counter appears under 200 characters left and counts down', async () => {
  const { h } = await drawn();
  openNew(h);
  const counter = h.$('#item-description-counter')!;
  const description = input(h, 'description');
  assert.equal(counter.hidden, true);
  h.setValue(description, 'x'.repeat(1700));
  assert.equal(counter.hidden, true, '300 left is not shown yet');
  h.setValue(description, 'x'.repeat(1850));
  assert.equal(counter.hidden, false);
  assert.equal(text(counter), '150 characters left.');
  h.setValue(description, 'x'.repeat(2000));
  assert.equal(text(counter), '0 characters left.');
  assert.equal(description.getAttribute('maxlength'), '2000');
});

// ---- submit ---------------------------------------------------------------------------------------------------------------------------------

test('a valid submit sends exactly one new-item with trimmed lines and a number, leaves an empty description out, and shows Adding...', async () => {
  const { h } = await drawn();
  openNew(h);
  fill(h, { type: 'bug', title: '  Crash on save  ', files: ' src/a/** \n\n docs/*.md \n', estimate: '48000' });
  h.click(buttonNamed(h, 'Add item')!);
  assert.deepEqual(posts(h, 'new-item'), [{ type: 'new-item', draft: { kind: 'bug', title: 'Crash on save', scope: ['src/a/**', 'docs/*.md'], estimate: 48000 } }]);
  const submit = h.$('#item-form button[type="submit"]')!;
  assert.equal(text(submit), 'Adding...');
  assert.equal(submit.getAttribute('aria-busy'), 'true');
  h.click(submit);
  assert.equal(posts(h, 'new-item').length, 1, 'a second click while busy sends nothing');
});

test('a draft with only a title sends no description, no estimate and no files', async () => {
  const { h } = await drawn();
  openNew(h);
  fill(h, { title: 'Look into caching', description: '   ', type: 'spike' });
  h.click(buttonNamed(h, 'Add item')!);
  assert.deepEqual(posts(h, 'new-item'), [{ type: 'new-item', draft: { kind: 'spike', title: 'Look into caching', scope: [] } }]);
});

test('saved closes the form, announces the new item, and focuses its card once the next state shows it', async () => {
  const { h, world } = await drawn();
  openNew(h);
  fill(h, { title: 'Fix login' });
  h.click(buttonNamed(h, 'Add item')!);
  h.deliver({ type: 'saved', itemId: NEW_ID });
  assert.equal(form(h), null, 'the form is closed');
  assert.equal(h.$('#detail')!.hidden, true, 'the drawer is back to how it was');
  assert.equal(said(h), 'Added chore 9X2M: Fix login.');
  assert.equal(h.$(`.card[data-id="${NEW_ID}"]`), null, 'the card is not there yet');
  world.accept(world.dev, 'item.created', { id: NEW_ID, kind: 'chore', title: 'Fix login', scope: [], requirements: [], mustHaves: [] });
  h.deliver({ type: 'state', model: modelOf(world, 'dev') });
  const card = h.$(`.card[data-id="${NEW_ID}"]`);
  assert.ok(card, 'the card appeared');
  assert.equal(h.focused(), card!.querySelector('.card-main') ?? card, 'focus is on the new card');
});

test('with the Blocked filter on, the new card is not shown, so focus goes to the New item button', async () => {
  const { h, world } = await drawn();
  api(h).setFilter('blocked', true);
  openNew(h);
  fill(h, { title: 'Tidy settings page' });
  h.click(buttonNamed(h, 'Add item')!);
  // The state with the new card arrives first this time, as it does when the poll beats the reply.
  world.accept(world.dev, 'item.created', { id: NEW_ID, kind: 'chore', title: 'Tidy settings page', scope: [], requirements: [], mustHaves: [] });
  h.deliver({ type: 'state', model: modelOf(world, 'dev') });
  h.deliver({ type: 'saved', itemId: NEW_ID });
  assert.equal(said(h), 'Added chore 9X2M: Tidy settings page.');
  assert.equal(h.$(`.card[data-id="${NEW_ID}"]`), null, 'the filter hides it');
  assert.equal(h.focused(), newItemButton(h));
});

test('a card that never arrives still ends on the New item button', async () => {
  const { h } = await drawn();
  openNew(h);
  fill(h, { title: 'Slow one' });
  h.click(buttonNamed(h, 'Add item')!);
  h.deliver({ type: 'saved', itemId: NEW_ID });
  h.advance(3500);
  assert.equal(h.focused(), newItemButton(h));
});

test('a refusal shows the host reason in an alert inside the form and keeps every field and the busy button free again', async () => {
  const { h } = await drawn();
  openNew(h);
  fill(h, { type: 'bug', title: 'Crash', description: 'It crashes.', files: 'src/a/**', estimate: '5000' });
  h.click(buttonNamed(h, 'Add item')!);
  const reason = 'Only the owner, leads and developers can add items. Nothing was saved.';
  h.deliver({ type: 'refused', itemId: '', reason });
  const alert = h.$('#item-form [role="alert"]')!;
  assert.equal(text(alert), reason);
  assert.equal(alert.hidden, false);
  assert.equal(said(h), reason);
  assert.deepEqual([input(h, 'type').value, input(h, 'title').value, input(h, 'description').value, input(h, 'files').value, input(h, 'estimate').value], ['bug', 'Crash', 'It crashes.', 'src/a/**', '5000']);
  const submit = h.$('#item-form button[type="submit"]')!;
  assert.equal(text(submit), 'Add item');
  assert.equal(submit.getAttribute('aria-busy'), null);
  h.click(submit);
  assert.equal(posts(h, 'new-item').length, 2, 'it can be tried again');
  assert.equal(alert.hidden, true, 'the old reason is cleared on a new try');
  // A refusal about some other card is none of the form's business.
  h.deliver({ type: 'refused', itemId: 'plan:90-01', reason: 'Not yours.' });
  assert.equal(alert.hidden, true);
});

// ---- closing --------------------------------------------------------------------------------------------------------------------------------

test('Close form on an unchanged form closes at once and returns to the New item button', async () => {
  const { h } = await drawn();
  openNew(h);
  h.click(buttonNamed(h, 'Close form')!);
  assert.equal(form(h), null);
  assert.equal(h.focused(), newItemButton(h));
  assert.equal(h.$('#detail')!.hidden, true);
});

test('Close form on a changed form asks Discard this item? with focus on Keep editing; Keep editing goes back, Discard changes closes', async () => {
  const { h } = await drawn();
  openNew(h);
  fill(h, { title: 'Half done' });
  h.click(buttonNamed(h, 'Close form')!);
  const f = form(h)!;
  assert.ok(f, 'the form is still open');
  assert.match(text(f), /Discard this item\?/);
  assert.deepEqual(Array.from(f.querySelectorAll('button')).map((b) => text(b)).filter((t) => t === 'Discard changes' || t === 'Keep editing').sort(), ['Discard changes', 'Keep editing']);
  assert.equal(h.focused(), buttonNamed(h, 'Keep editing'));
  h.click(buttonNamed(h, 'Keep editing')!);
  assert.ok(form(h), 'still open');
  assert.equal(input(h, 'title').value, 'Half done');
  assert.equal(h.focused(), input(h, 'title'));
  h.click(buttonNamed(h, 'Close form')!);
  h.click(buttonNamed(h, 'Discard changes')!);
  assert.equal(form(h), null);
  assert.equal(h.focused(), newItemButton(h));
  assert.equal((h.state as Record<string, unknown>)['draft'], undefined, 'the draft is gone');
});

test('Escape behaves like Close form, with the same discard rule', async () => {
  const { h } = await drawn();
  openNew(h);
  h.press(input(h, 'title'), 'Escape');
  assert.equal(form(h), null, 'unchanged: closed');
  openNew(h);
  fill(h, { description: 'Something' });
  h.press(input(h, 'description'), 'Escape');
  assert.ok(form(h), 'changed: asks first');
  assert.equal(h.focused(), buttonNamed(h, 'Keep editing'));
  h.press(buttonNamed(h, 'Keep editing')!, 'Escape');
  assert.ok(form(h), 'Escape on the question keeps the form open');
});

// ---- the draft ------------------------------------------------------------------------------------------------------------------------------

test('the draft is kept with setState on every change, and a reloaded page reopens the form with the same values', async () => {
  const { h, world } = await drawn();
  openNew(h);
  fill(h, { type: 'spike', title: 'Look into it', description: 'Line one\nLine two', files: 'src/a/**', estimate: '2000' });
  const kept = h.state as Record<string, any>;
  assert.deepEqual(kept['draft'], { mode: 'new', values: { type: 'spike', title: 'Look into it', description: 'Line one\nLine two', files: 'src/a/**', estimate: '2000' } });
  assert.equal(kept['groupBy'], 'member', 'the board keeps its own state beside the draft');

  const again = start({ state: h.state });
  assert.equal(form(again), null, 'nothing opens before the first state');
  again.deliver({ type: 'state', model: modelOf(world, 'dev') });
  assert.ok(form(again), 'the form is back');
  assert.deepEqual(['type', 'title', 'description', 'files', 'estimate'].map((n) => input(again, n).value), ['spike', 'Look into it', 'Line one\nLine two', 'src/a/**', '2000']);
  assert.equal(text(form(again)!.querySelector('h2')), 'New item');
  // The board keeps working beside it: a filter change keeps the draft.
  api(again).setFilter('mine', true);
  assert.equal((again.state as Record<string, any>)['draft'].values.title, 'Look into it');
  // And sending it clears the draft once the host says saved.
  again.click(buttonNamed(again, 'Add item')!);
  assert.equal(posts(again, 'new-item').length, 1);
  again.deliver({ type: 'saved', itemId: NEW_ID });
  assert.equal((again.state as Record<string, any>)['draft'], undefined);
});

test('T-62-46: a field that looks like a key or password is never stored in the draft, the other fields are, and the host still gets what was typed', async () => {
  const { h } = await drawn();
  openNew(h);
  const key = `sk-${'q'.repeat(24)}`;
  fill(h, { type: 'bug', title: 'Login fails', description: `Use the key ${key} to reproduce`, files: 'src/a/**', estimate: '2000' });
  const stored = JSON.stringify(h.state);
  assert.equal(stored.includes(key), false, 'the key is not in the stored state');
  assert.deepEqual((h.state as Record<string, any>)['draft'], { mode: 'new', values: { type: 'bug', title: 'Login fails', description: '', files: 'src/a/**', estimate: '2000' } });
  for (const secret of ['Bearer abcdefghijk', 'api_key=hunter2hunter2', `ghp_${'A1b2'.repeat(9)}`, '-----BEGIN PRIVATE KEY-----']) {
    setTitle(h, secret);
    assert.equal(JSON.stringify(h.state).includes(secret), false, `${secret.slice(0, 12)} is not stored`);
  }
  setTitle(h, 'Login fails');
  h.click(buttonNamed(h, 'Add item')!);
  assert.equal(posts(h, 'new-item')[0]?.draft.description, `Use the key ${key} to reproduce`, 'what is sent is what was typed; the host refuses it');
});

test('IN-08: an edit form is never stored, so a teammate\'s card text does not outlive the page, and an older stored edit draft is dropped', async () => {
  const { h, world } = await drawn();
  openEditFromDetail(h, world);
  setTitle(h, 'Edited title');
  assert.equal((h.state as Record<string, any>)['draft'], undefined, 'no draft for an edit');
  assert.equal(JSON.stringify(h.state).includes('Edited title'), false);

  const old = start({ state: { groupBy: 'member', draft: { mode: 'edit', id: CHORE_ID, values: { type: 'chore', title: 'Their card', description: 'Their words', files: '', estimate: '' } } } });
  old.deliver({ type: 'state', model: modelOf(world, 'dev') });
  assert.equal(form(old), null, 'the edit is not reopened');
  assert.equal(posts(old, 'detail').length, 0, 'and its detail is not asked for');
  assert.equal(JSON.stringify(old.state).includes('Their words'), false, 'the stored edit text is gone');
});

// ---- edit -----------------------------------------------------------------------------------------------------------------------------------

function openEditFromDetail(h: BoardHarness, world: BoardWorld): void {
  const main = h.$(`.card[data-id="${CHORE_ID}"] .card-main`)!;
  main.focus();
  h.press(main, 'Enter');
  const detail = buildCardDetail(world.state, CHORE_ID, { viewerId: world.dev.memberId, nowMs: NOW, history: [] })!;
  h.deliver({ type: 'detail', ...detail });
  const edit = h.$$('#detail button').find((b) => text(b) === 'Edit')!;
  assert.ok(edit, 'Edit is offered for the developer\'s own chore');
  edit.focus();
  h.click(edit);
  h.deliver({ type: 'detail', ...detail });
}

test('Edit asks the host for the detail, pre-fills the form, shows the type as text, and sends only what changed under Save changes', async () => {
  const { h, world } = await drawn();
  openEditFromDetail(h, world);
  assert.equal(posts(h, 'detail').length, 2, 'the drawer asked once and the form asked once');
  const f = form(h)!;
  assert.ok(f, 'the edit form is open');
  assert.equal(text(f.querySelector('h2')), 'Edit item');
  assert.equal(h.$('select#item-type'), null, 'the type is not a choice any more');
  assert.equal(text(h.$('#item-type')), 'Chore');
  assert.equal(input(h, 'title').value, 'Tidy settings page');
  assert.equal(h.focused(), input(h, 'title'));
  assert.deepEqual(Array.from(f.querySelectorAll('button')).map((b) => text(b)), ['Choose folders...', 'Save changes', 'Close form']);

  fill(h, { title: 'Tidy the settings page', estimate: '52000' });
  h.click(buttonNamed(h, 'Save changes')!);
  assert.deepEqual(posts(h, 'edit-item'), [{ type: 'edit-item', itemId: CHORE_ID, changes: { title: 'Tidy the settings page', estimate: 52000 } }]);
  assert.equal(text(h.$('#item-form button[type="submit"]')), 'Saving...');
  h.deliver({ type: 'refused', itemId: CHORE_ID, reason: 'You can edit only the items you added. Nothing was saved.' });
  assert.equal(text(h.$('#item-form [role="alert"]')), 'You can edit only the items you added. Nothing was saved.');
  fill(h, { files: 'src/a/**\ndocs/*.md' });
  h.click(buttonNamed(h, 'Save changes')!);
  assert.deepEqual(posts(h, 'edit-item')[1], { type: 'edit-item', itemId: CHORE_ID, changes: { title: 'Tidy the settings page', scope: ['src/a/**', 'docs/*.md'], estimate: 52000 } });
  h.deliver({ type: 'saved', itemId: CHORE_ID });
  assert.equal(form(h), null);
  assert.equal(said(h), 'Saved changes to chore 7F3K: Tidy the settings page.');
});

test('closing an unchanged edit form with Escape returns to the detail and leaves it open', async () => {
  const { h, world } = await drawn();
  openEditFromDetail(h, world);
  const edit = h.$$('#detail button').find((b) => text(b) === 'Edit');
  h.press(input(h, 'title'), 'Escape');
  assert.equal(form(h), null);
  assert.equal(h.$('#detail')!.hidden, false, 'the detail stays open: Escape closed only the form');
  assert.equal(text(h.$('#detail h2')), 'Tidy settings page');
  assert.equal(h.focused(), edit, 'focus returns to the Edit button');
  // A second Escape now closes the detail.
  h.press(h.$('#detail h2')!, 'Escape');
  assert.equal(h.$('#detail')!.hidden, true);
});

test('an edit with nothing changed says so and sends nothing; an item that is not editable opens no form', async () => {
  const { h, world } = await drawn();
  openEditFromDetail(h, world);
  h.click(buttonNamed(h, 'Save changes')!);
  assert.equal(posts(h, 'edit-item').length, 0);
  assert.equal(said(h), 'No changes to save.');
  assert.equal(form(h), null);

  api(h).openForm('plan:90-01');
  h.deliver({ type: 'detail', ...buildCardDetail(world.state, 'plan:90-01', { viewerId: world.dev.memberId, nowMs: NOW, history: [] })! });
  assert.equal(form(h), null, 'imported items are never editable here');
  assert.equal(said(h), 'This item cannot be edited.');
});

test('an estimate cannot be emptied once it is set, and an open edit form closes when its card leaves the board', async () => {
  const world = await standard();
  world.accept(world.dev, 'item.estimated', { id: CHORE_ID, estimate: { tokens: 9000 } });
  const h = start();
  h.deliver({ type: 'state', model: modelOf(world, 'dev') });
  api(h).openForm(CHORE_ID);
  h.deliver({ type: 'detail', ...buildCardDetail(world.state, CHORE_ID, { viewerId: world.dev.memberId, nowMs: NOW, history: [] })! });
  assert.equal(input(h, 'estimate').value, '9000');
  fill(h, { estimate: '' });
  h.click(buttonNamed(h, 'Save changes')!);
  assert.equal(errorOf(h, 'estimate'), 'Enter a whole number of tokens, 1 or more.');
  assert.equal(posts(h, 'edit-item').length, 0);
  const without = modelOf(world, 'dev');
  without.cards = without.cards.filter((c) => c.id !== CHORE_ID);
  h.deliver({ type: 'state', model: without });
  assert.equal(form(h), null, 'the form went with the card');
  assert.equal(said(h), 'That item is no longer on the board.');
});

// ---- the page: kanban and list --------------------------------------------------------------------------------------------------------------

test('in the list layout the form drills in over the page and Close form brings the list back', async () => {
  const { h } = await drawn('dev', 400);
  assert.equal(api(h).layout(), 'list');
  openNew(h);
  assert.equal(h.$('#detail')!.hidden, false);
  assert.equal(form(h)!.parentNode, h.$('#detail'));
  h.click(buttonNamed(h, 'Close form')!);
  assert.equal(h.$('#detail')!.hidden, true);
  assert.equal(h.focused(), newItemButton(h));
});

// ---- the file -------------------------------------------------------------------------------------------------------------------------------

test('form.js registers through the client API, writes text only, never says Cancel and holds no em-dash or en-dash in any string', () => {
  assert.match(FORM_JS, /NearAiBoard\.registerForm/);
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(FORM_JS), false);
  assert.equal(/[\u2013\u2014]/.test(FORM_JS), false, 'no dash characters anywhere in the file');
  const literals = FORM_JS.match(/'(?:[^'\\\n]|\\.)*'/g) ?? [];
  assert.ok(literals.length > 40, 'the scan saw the strings');
  assert.equal(literals.some((l) => /cancel/i.test(l)), false, 'no string says Cancel');
  assert.match(FORM_JS, /Discard this item\?/);
  assert.equal(/acquireVsCodeApi/.test(FORM_JS.replace(/\/\/.*$/gm, '')), false, 'the page may acquire the VS Code API only once, so the form borrows it from board.js');
});
