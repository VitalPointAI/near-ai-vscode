// The board layout probe (Phase 62 plan 16): media/board/layout-probe.js is test-only page code that measures the real board for overflow, overlap
// and unreadable cards (G-62-2, G-62-4, G-62-7). check() is pure, so every rule is proven here on hand-made measurements; the fake DOM has no
// layout, so the page tests only prove the gating and the message shape. The file never ships: .vscodeignore drops it and the release check fails
// if it is in the package.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { buildBoardModel } from '../domain/team/board';
import { createBoardHarness } from './helpers/fakeDom';
import type { BoardHarness } from './helpers/fakeDom';
import { boardWorld, seedStandardBoard } from './helpers/teamBoardWorld';

const ROOT = path.resolve(__dirname, '..', '..');
const PROBE = readFileSync(path.join(ROOT, 'media', 'board', 'layout-probe.js'), 'utf8');
const NOW = Date.parse('2026-03-05T12:00:00.000Z');

function page(e2e: boolean): BoardHarness {
  const h = createBoardHarness({ width: 1000 });
  if (e2e) h.document.body.setAttribute('data-e2e', '1');
  h.load(['board.js', 'layout-probe.js']);
  return h;
}

// check() runs inside the page's realm; its answers are copied to plain values before any assertion compares them.
const probeHarness = page(true);
const check = (data: unknown): string[] => [...(probeHarness.window.NearAiBoardLayout.check(data) as string[])].map(String);

type Box = { left: number; top: number; right: number; bottom: number };
const box = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right, bottom });
const sized = (b: Box) => ({ ...b, width: b.right - b.left, height: b.bottom - b.top });
const FG = 'rgb(204, 204, 204)';
const CARD_BG = 'rgb(37, 37, 38)';
const SOLID = 'rgb(30, 30, 30)';
const CLEAR = 'rgba(0, 0, 0, 0)';

function card(id: string, label: string, column: string, b: Box) {
  return {
    id, label, column, lane: 'unassigned', ...sized(b), draggable: true, rendered: true, inFoldedCell: false, fontSize: 13, overflowX: 0, overflowY: 0,
    color: FG, background: CARD_BG, title: { width: b.right - b.left - 24, height: 20, fontSize: 13 }, main: { align: 'left', color: FG, background: CLEAR },
    words: [{ text: 'Alpha', lines: 1, width: 36 }, { text: 'slice', lines: 1, width: 30 }]
  };
}

// A clean kanban at 1000 by 700: a toolbar above the board region, three column headers (Done folded), one lane with three cells and three cards.
function clean() {
  return {
    width: 1000, height: 700, layout: 'kanban', theme: 'dark',
    page: { scrollWidth: 1000, clientWidth: 1000, scrollY: 0 },
    outside: [] as Array<{ what: string; right: number }>,
    toolbar: { ...sized(box(0, 0, 1000, 100)), background: SOLID, position: 'sticky' },
    region: { ...sized(box(16, 100, 984, 700)), scrollTop: 0, scrollLeft: 0 },
    headRow: { ...box(16, 112, 592, 160), background: SOLID, position: 'sticky' },
    heads: [
      { column: 'backlog', label: 'Backlog', ...box(16, 112, 272, 160), folded: false, contentRight: 268, contentBottom: 156 },
      { column: 'ready', label: 'Ready', ...box(284, 112, 540, 160), folded: false, contentRight: 536, contentBottom: 156 },
      { column: 'done', label: 'Done', ...box(552, 112, 592, 160), folded: true, contentRight: 590, contentBottom: 156 }
    ],
    lanes: [
      { lane: 'unassigned', label: 'Unassigned', ...box(16, 170, 592, 500), collapsed: false, parts: [{ what: 'header', ...box(16, 170, 592, 196) }, { what: 'grid', ...box(16, 208, 592, 400) }] }
    ],
    cells: [
      { lane: 'unassigned', laneLabel: 'Unassigned', column: 'backlog', columnLabel: 'Backlog', ...sized(box(16, 208, 272, 400)), folded: false, rendered: true },
      { lane: 'unassigned', laneLabel: 'Unassigned', column: 'ready', columnLabel: 'Ready', ...sized(box(284, 208, 540, 300)), folded: false, rendered: true },
      { lane: 'unassigned', laneLabel: 'Unassigned', column: 'done', columnLabel: 'Done', ...sized(box(552, 208, 592, 232)), folded: true, rendered: true }
    ],
    cards: [
      card('plan:90-01', 'plan 90-01', 'backlog', box(16, 208, 272, 280)),
      card('plan:90-02', 'plan 90-02', 'backlog', box(16, 292, 272, 364)),
      card('chore:1', 'C-1', 'ready', box(284, 208, 540, 280))
    ],
    focused: undefined as undefined | ({ id: string; label: string } & Box),
    openWork: 3
  };
}
type Data = ReturnType<typeof clean>;

function cleanList(): Data {
  const data = clean();
  data.layout = 'list';
  data.width = 400;
  data.page = { scrollWidth: 400, clientWidth: 400, scrollY: 0 };
  data.toolbar = { ...sized(box(0, 0, 400, 140)), background: SOLID, position: 'sticky' };
  data.region = { ...sized(box(12, 140, 388, 700)), scrollTop: 0, scrollLeft: 0 };
  data.heads = [];
  data.lanes = [];
  data.cells = [];
  data.cards = [card('plan:90-01', 'plan 90-01', 'backlog', box(20, 200, 380, 260)), card('chore:1', 'C-1', 'ready', box(20, 320, 380, 380))];
  return data;
}

/** Breaks one rule on a clean board and expects exactly one problem, matching the rule's sentence. */
function expectOne(mutate: (data: Data) => void, pattern: RegExp, start: () => Data = clean): string {
  const data = start();
  mutate(data);
  const problems = check(data);
  assert.equal(problems.length, 1, `exactly one problem, got: ${problems.join(' | ') || 'none'}`);
  assert.match(problems[0], pattern);
  assert.ok(!/[–—]/.test(problems[0]), 'no dash characters in a problem');
  return problems[0];
}

/** Breaks a rule that cannot break alone (two headers cannot overlap while both cells line up and stay apart) and expects exactly one problem
 * matching this rule's sentence among the rest. */
function expectAmong(mutate: (data: Data) => void, pattern: RegExp): string {
  const data = clean();
  mutate(data);
  const problems = check(data);
  const hits = problems.filter((problem) => pattern.test(problem));
  assert.equal(hits.length, 1, `exactly one problem matching ${pattern}, got: ${problems.join(' | ') || 'none'}`);
  return hits[0];
}

test('a clean kanban and a clean list layout have no problems', () => {
  assert.deepEqual(check(clean()), []);
  assert.deepEqual(check(cleanList()), []);
});

test('page rules: sideways scroll in the list layout, sideways scroll outside the board region in the kanban', () => {
  expectOne((d) => { d.page.scrollWidth = 460; }, /page scrolls sideways by 60 px in the list layout/, cleanList);
  const text = expectOne((d) => { d.page.scrollWidth = 1100; d.outside.push({ what: 'div.filters', right: 1100 }); }, /page scrolls sideways by 100 px outside the board region/);
  assert.match(text, /div\.filters/);
});

test('toolbar rules: not opaque, covering a card or the board region, taller than 40 percent of the page', () => {
  expectOne((d) => { d.toolbar.background = CLEAR; }, /toolbar background is not opaque/);
  expectOne((d) => { d.toolbar.background = 'transparent'; }, /toolbar background is not opaque/);
  expectOne((d) => { d.toolbar.background = 'rgba(30, 30, 30, 0.6)'; }, /toolbar background is not opaque/);
  expectOne((d) => { d.toolbar.background = 'rgb(30 30 30 / 0.5)'; }, /toolbar background is not opaque/);
  // The toolbar stays put while the board scrolls under it: the region and the first card are now behind it.
  const covered = expectOne((d) => { d.toolbar.bottom = 220; d.toolbar.height = 220; }, /toolbar covers 120 px of the board region/);
  assert.match(covered, /plan 90-01/);
  assert.match(covered, /C-1/);
  expectOne((d) => { d.toolbar.height = 300; }, /toolbar is 300 px tall, more than 40 percent of the 700 px page/);
});

test('column header rules: content spilling out of a header, two headers overlapping', () => {
  expectOne((d) => { d.heads[0].contentRight = 300; }, /Column header Backlog spills 28 px past its box/);
  expectAmong((d) => { d.heads[1].left = 260; }, /Column headers Backlog and Ready overlap by 12 px/);
});

test('lane and cell rules: lanes overlapping, a lane part spilling, a cell off its header, a cell outside its lane, cells overlapping', () => {
  expectOne((d) => {
    d.lanes.push({ lane: 'dana', label: 'Dana', ...box(16, 480, 592, 600), collapsed: true, parts: [{ what: 'header', ...box(16, 480, 592, 506) }] });
  }, /Lanes Unassigned and Dana overlap by 20 px/);
  expectOne((d) => { d.lanes[0].parts[1].bottom = 620; }, /Lane Unassigned's grid spills 120 px below its lane/);
  expectOne((d) => { d.cells[1].left = 290; d.cards[2].left = 290; }, /Cell Unassigned \/ Ready does not line up under its column header \(6 px off\)/);
  expectOne((d) => { d.cells[0].bottom = 620; d.cells[0].height = 412; }, /Cell Unassigned \/ Backlog spills 120 px below its lane/);
  expectAmong((d) => { d.cells[2].left = 530; }, /Cells Unassigned \/ Ready and Unassigned \/ Done overlap by 10 px/);
});

test('card rules: a card outside its cell, two cards overlapping, content overflowing a card', () => {
  expectOne((d) => { d.cards[1].bottom = 420; d.cards[1].height = 128; }, /Card plan 90-02 spills 20 px out of its cell/);
  expectOne((d) => { d.cards[1].top = 270; d.cards[1].bottom = 342; }, /Cards plan 90-01 and plan 90-02 overlap/);
  expectOne((d) => { d.cards[2].overflowX = 40; }, /Card C-1's content is 40 px wider than the card/);
  expectOne((d) => { d.cards[2].overflowY = 18; }, /Card C-1's content is 18 px taller than the card/);
});

test('scroll and focus rules: the header row after a vertical scroll, a focused card under the headers, no work on the first screen', () => {
  const scrolled = (d: Data): void => {
    d.region.scrollTop = 200;
    d.headRow = { ...d.headRow, top: 100, bottom: 148 };
    d.cards = [];
  };
  assert.deepEqual(check((() => { const d = clean(); scrolled(d); return d; })()), [], 'a sticky opaque header row at the region top is clean');
  expectOne((d) => { scrolled(d); d.headRow.top = -88; d.headRow.bottom = -40; }, /column header row is not at the top of the board region after a scroll/);
  expectOne((d) => { scrolled(d); d.headRow.background = CLEAR; }, /column header row is not opaque/);
  expectOne((d) => { d.focused = { id: 'chore:1', label: 'C-1', ...box(284, 140, 540, 212) }; }, /focused card C-1 is hidden under the column headers/);
  expectOne((d) => { d.focused = { id: 'chore:1', label: 'C-1', ...box(284, 660, 540, 732) }; }, /focused card C-1 is not fully visible/);
  expectOne((d) => { d.cards.forEach((c, i) => { c.top = 720 + i * 80; c.bottom = c.top + 72; }); d.cells.forEach((c) => { c.top = 208; c.bottom = 1000; }); d.lanes[0].bottom = 1000; d.lanes[0].parts[1].bottom = 1000; }, /No card is fully visible on the first screen, but 3 Backlog or Ready cards exist/);
  const none = clean();
  none.cards = [];
  none.openWork = 0;
  assert.deepEqual(check(none), [], 'an empty board with no open work is not a problem');
});

test('readability rules: a card in a folded column, no size or a zero font size, a word split across lines, a card button that looks like a button', () => {
  expectOne((d) => { d.cards.push({ ...card('done:1', 'D-1', 'done', box(552, 208, 592, 230)), inFoldedCell: true }); }, /Card D-1 is drawn inside the folded column Done/);
  expectOne((d) => { d.cards[2].width = 0; d.cards[2].right = d.cards[2].left; }, /Card C-1 has no size/);
  expectOne((d) => { d.cards[2].title.height = 0; }, /Card C-1's title has no size/);
  expectOne((d) => { d.cards[2].fontSize = 0; }, /Card C-1 has a zero font size/);
  expectOne((d) => { d.cards[2].title.fontSize = 0; }, /Card C-1's title has a zero font size/);
  expectOne((d) => { d.cards[2].words[0] = { text: 'Alpha', lines: 2, width: 36 }; }, /Card C-1 splits the word "Alpha" across two lines although it fits on one/);
  assert.deepEqual(check((() => { const d = clean(); d.cards[2].words[0] = { text: 'Supercalifragilistic', lines: 2, width: 400 }; return d; })()), [], 'a word wider than the title may break');
  expectOne((d) => { d.cards[2].main.align = 'center'; }, /Card C-1's main button is centred/);
  expectOne((d) => { d.cards[2].main.color = 'rgb(255, 255, 255)'; }, /Card C-1's main button is painted with button colours/);
  expectOne((d) => { d.cards[2].main.background = 'rgb(14, 99, 156)'; }, /Card C-1's main button is painted with button colours/);
  assert.deepEqual(check((() => { const d = clean(); d.cards[2].main.background = CARD_BG; return d; })()), [], 'the card\'s own background is fine');
});

test('the page answers e2e-layout with exactly one e2e-layout-report carrying the documented keys, only when the host marked it for the tests', async () => {
  const world = await boardWorld();
  seedStandardBoard(world);
  const model = buildBoardModel(world.state, { nowMs: NOW, status: { kind: 'live', text: 'Live' }, canWrite: true, viewerId: world.owner.memberId });

  const h = page(true);
  const layout = h.window.NearAiBoardLayout;
  assert.equal(typeof layout?.collect, 'function');
  assert.equal(typeof layout?.check, 'function');
  assert.equal(typeof layout?.measure, 'function');
  h.deliver({ type: 'state', model });
  const before = h.posts.length;
  h.deliver({ type: 'e2e-layout', id: 4, action: 'measure' });
  h.advance(100);
  await new Promise((resolve) => setImmediate(resolve));
  h.advance(100);
  await new Promise((resolve) => setImmediate(resolve));
  const answers = h.posts.slice(before).filter((p) => p.type === 'e2e-layout-report');
  assert.equal(answers.length, 1, 'exactly one answer');
  assert.equal(answers[0].id, 4);
  const report = answers[0].report as Record<string, unknown>;
  assert.deepEqual(Object.keys(report).filter((k) => k !== 'focused').sort(),
    ['cards', 'cells', 'heads', 'height', 'lanes', 'layout', 'problems', 'region', 'theme', 'toolbar', 'visibleCards', 'width'].sort());
  assert.ok(Array.isArray(report.problems));
  assert.equal(report.layout, 'kanban');
  assert.deepEqual(Object.keys(report.toolbar as object).sort(), ['background', 'height', 'position']);
  assert.deepEqual(Object.keys(report.region as object).sort(), ['height', 'left', 'scrollLeft', 'scrollTop', 'top', 'width']);
  const cards = report.cards as Array<Record<string, unknown>>;
  assert.ok(cards.length >= 3, 'the drawn cards are listed so the drag test can aim');
  assert.deepEqual(Object.keys(cards[0]).sort(), ['column', 'draggable', 'height', 'id', 'lane', 'left', 'top', 'width']);
  assert.ok(cards.some((c) => c.id === 'plan:90-01' && c.column === 'ready' && c.lane === 'unassigned'));
  const cells = report.cells as Array<Record<string, unknown>>;
  assert.ok(cells.length > 0);
  assert.deepEqual(Object.keys(cells[0]).sort(), ['column', 'height', 'lane', 'left', 'top', 'width']);
  assert.deepEqual(Object.keys((report.heads as object[])[0]).sort(), ['column', 'folded', 'left', 'right']);
  assert.deepEqual(Object.keys((report.lanes as object[])[0]).sort(), ['bottom', 'collapsed', 'lane', 'top']);

  // A second question gets its own single answer, and a focus request names the focused card.
  const mark = h.posts.length;
  h.deliver({ type: 'e2e-layout', id: 5, action: 'focus', itemId: 'plan:90-01' });
  h.advance(100);
  await new Promise((resolve) => setImmediate(resolve));
  const second = h.posts.slice(mark).filter((p) => p.type === 'e2e-layout-report');
  assert.equal(second.length, 1);
  assert.equal(second[0].id, 5);
  assert.equal((second[0].report.focused as Record<string, unknown>).id, 'plan:90-01');

  const plain = page(false);
  assert.equal(plain.window.NearAiBoardLayout, undefined, 'no probe without data-e2e');
  plain.deliver({ type: 'state', model });
  const mark2 = plain.posts.length;
  plain.deliver({ type: 'e2e-layout', id: 6, action: 'measure' });
  plain.advance(100);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(plain.posts.slice(mark2).filter((p) => p.type === 'e2e-layout-report').length, 0, 'no answer without data-e2e');
});

test('the probe keeps the page rules: one strict IIFE, no markup sink, eval, network, colour literal, dash or second VS Code API', () => {
  const sinks = [/\.innerHTML\b/, /\.outerHTML\b/, /\binsertAdjacentHTML\b/, /\bdocument\.write\b/, /\bsrcdoc\b/, /\beval\s*\(/, /\bnew\s+Function\b/, /\bFunction\s*\(/, /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bEventSource\b/, /\bsendBeacon\b/, /\bimportScripts\b/, /\bacquireVsCodeApi\b/];
  for (const sink of sinks) assert.ok(!sink.test(PROBE), `layout-probe.js uses ${sink}`);
  assert.ok(!/[–—]/.test(PROBE), 'no en or em dash');
  const code = PROBE.replace(/\/\/.*$/gm, '');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(code), 'no hex colour');
  assert.ok(!/\b(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\s*\(/i.test(code), 'no colour function');
  const misuse = /(?:querySelectorAll\([^()]*\)|\.children|\.childNodes)\s*\.\s*(?:map|filter|find|findIndex|indexOf|some|every|reduce|includes|slice|concat|flatMap)\s*\(/;
  assert.equal(misuse.test(PROBE), false, 'no Array method on a NodeList');
  const lines = PROBE.split('\n').filter((line) => !/^\s*(\/\/.*)?$/.test(line));
  assert.match(lines[0] ?? '', /^\(function \(\) \{$/);
  assert.equal(lines[1]?.trim(), "'use strict';");
  assert.match(lines[lines.length - 1] ?? '', /^\}\)?\(\)\)?;$/);
});

test('the probe never ships: .vscodeignore drops it and the release check fails when it is in the package', () => {
  const ignore = readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8').split('\n').map((line) => line.trim());
  assert.ok(ignore.includes('media/board/layout-probe.js'), '.vscodeignore lists media/board/layout-probe.js');
  const release = readFileSync(path.join(ROOT, 'scripts', 'verify-release-content.mjs'), 'utf8');
  const block = /const forbiddenPatterns = \[([\s\S]*?)\n\];/.exec(release);
  assert.ok(block, 'the release check has a forbidden list');
  const patterns = block[1].split('\n').map((line) => /^\s*\/(.+)\/([a-z]*),?\s*$/.exec(line)).filter((m): m is RegExpExecArray => m !== null).map((m) => new RegExp(m[1], m[2]));
  const forbidden = (entry: string): boolean => patterns.some((pattern) => pattern.test(entry));
  assert.equal(forbidden('extension/media/board/layout-probe.js'), true, 'the packaged probe fails the release check');
  assert.equal(forbidden('extension/media/board/board.js'), false, 'the board itself still ships');
  assert.equal(forbidden('extension/media/board/drag.js'), false);
});
