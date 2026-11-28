// Phase 33 plan 29 (D-18, D-56, D-62): Show Who Wrote This in a bound Sterling editor. The session backend labels each author's ranges with the
// executed whoWroteThis.ts words, from the signed client registrations; the tab draws gutter marks in fixed colour classes, a hover and a gutter
// tooltip naming the person (or the agent run and the person whose computer ran it), and a list of authors with their share of the text, so colour
// is never the only carrier. A person's label is plain text everywhere: never markdown, HTML or an icon. Fictional exercise data only.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { StaffBindingService } from '../extension/src/node/staff/binding-service.ts';
import type { AttributionAnswer } from '../extension/src/common/staff-binding.ts';
import type { Decoration } from '../extension/src/browser/staff/remote-cursors.ts';
import { staffProductPath } from '../../src/domain/staff/writeLimits.ts';
import { productOutput } from '../../src/staff/replica/productFeed.ts';
import { createLiveWorld } from '../../src/test/helpers/liveWorld.ts';
import {
  FakeSourceModel, FakeTab, PRODUCT, SEED, createProduct, engine, settle, until, withProduct, type FakeEditor,
} from './helpers/staff-binding-world.ts';

/** Opens the product in a new tab over `service` and waits until it is bound; the editor has focus. */
async function openBound(service: StaffBindingService, uri: string): Promise<{ tab: FakeTab; model: FakeSourceModel; editor: FakeEditor; doc: string }> {
  const tab = new FakeTab(service);
  const model = new FakeSourceModel(uri, '');
  const editor = tab.open(model);
  editor.focused = true;
  const entry = await until(() => tab.contribution.bindings().find((item) => item.model === model), (item) => item?.state === 'bound', 'the bound product');
  return { tab, model, editor, doc: entry?.doc as string };
}

const marks = (editor: FakeEditor): Decoration[] => editor.decorations.all().filter((item) => item.options.description === 'sterling-who-wrote-this');
const unescape = (value: string): string => value.replace(/\\([!-/:-@[-`{-~])/g, '$1');

test('tracer: two people\'s text gets gutter marks per author, each naming the person in its hover and tooltip, and a list with each share', async () => {
  await withProduct(async ({ avery, blake, carry }) => {
    const left = await openBound(avery.service, avery.uri);
    const right = await openBound(blake.service, blake.uri);
    const initial = left.model.textModel.getValue();
    left.model.textModel.type(initial.length, 0, ' Water for two.');
    await settle();
    await avery.service.flush(left.doc);
    await carry(avery, blake);
    blake.replicator.emit({ pulled: 1 });
    await until(() => right.model.textModel.getValue(), (text) => text.endsWith('Water for two.'), 'Avery\'s text at Blake');
    right.model.textModel.type(right.model.textModel.getValue().length, 0, ' Fuel trucks at dawn.');
    await settle();
    await blake.service.flush(right.doc);
    await carry(blake, avery);
    avery.replicator.emit({ pulled: 2 });
    await until(() => left.model.textModel.getValue(), (text) => text.endsWith('at dawn.'), 'Blake\'s text at Avery');
    await settle();

    assert.equal(left.tab.whoWroteThis.isEnabled(), true);
    await left.tab.whoWroteThis.toggle();
    const shown = marks(left.editor);
    const labels = new Set(shown.map((item) => item.options.linesDecorationsTooltip));
    assert.deepEqual([...labels].sort(), ['Avery Lead', 'Blake Rivers']);
    for (const item of shown) {
      assert.match(item.options.linesDecorationsClassName ?? '', /^sterling-wwt sterling-wwt-slot-[0-7]$/);
      assert.equal(unescape(item.options.hoverMessage?.value ?? ''), item.options.linesDecorationsTooltip);
    }
    const text = left.model.textModel.getValue();
    const blakeMark = shown.find((item) => item.options.linesDecorationsTooltip === 'Blake Rivers');
    const start = left.model.textModel.getPositionAt(text.indexOf(' Fuel trucks'));
    assert.deepEqual([blakeMark?.range.startLineNumber, blakeMark?.range.startColumn], [start.lineNumber, start.column], 'Blake\'s mark starts at his text');
    const [list] = left.tab.picked;
    assert.equal(list?.title, 'Who Wrote This');
    assert.deepEqual(list?.rows.map((row) => row.label).sort(), ['Avery Lead', 'Blake Rivers']);
    for (const row of list?.rows ?? []) assert.match(row.description, /^\d+(\.\d)?% of text$/);
  });
});

test('toggled off, every mark is removed; an editor that is not bound has the command off', async () => {
  await withProduct(async ({ avery }) => {
    const left = await openBound(avery.service, avery.uri);
    await left.tab.whoWroteThis.toggle();
    assert.ok(marks(left.editor).length > 0);
    await left.tab.whoWroteThis.toggle();
    assert.deepEqual(left.editor.decorations.all(), []);
    left.editor.focused = false;
    const notes = new FakeSourceModel(`${avery.uri.replace(/[^/]+$/, '')}notes.md`, 'My own notes.');
    const other = left.tab.open(notes);
    other.focused = true;
    await until(() => left.tab.contribution.bindings().find((item) => item.model === notes)?.state, (state) => state === 'none', 'the answer');
    assert.equal(left.tab.whoWroteThis.isEnabled(), false);
    await left.tab.whoWroteThis.toggle();
    assert.deepEqual(other.decorations.all(), []);
  });
});

test('an agent\'s text is labelled with the agent job, the run and the person\'s computer, and a label never renders as markdown, HTML or an icon', async () => {
  await withProduct(async ({ avery }) => {
    const agent = 'logistics planner agent, run 7, on Avery Lead\'s computer';
    const odd = 'Robin $(zap) <b>[x](javascript:alert(1))</b>';
    const rows: AttributionAnswer = { kind: 'rows', rows: [
      { label: agent, share: 0.75, unverified: false, ranges: [{ offset: 0, length: 3 }] },
      { label: odd, share: 0.25, unverified: false, ranges: [{ offset: 3, length: 2 }] },
    ] };
    const service = Object.assign(Object.create(avery.service) as StaffBindingService, { attribution: async () => rows });
    const left = await openBound(service, avery.uri);
    await left.tab.whoWroteThis.toggle();
    const shown = marks(left.editor);
    assert.deepEqual(shown.map((item) => item.options.linesDecorationsTooltip), [agent, odd]);
    for (const item of shown) {
      assert.equal(unescape(item.options.hoverMessage?.value ?? ''), item.options.linesDecorationsTooltip);
      assert.equal(item.options.hoverMessage?.supportHtml, false);
      assert.equal(item.options.hoverMessage?.supportThemeIcons, false);
      assert.equal(item.options.hoverMessage?.isTrusted, false);
    }
    const [list] = left.tab.picked;
    assert.deepEqual(list?.rows.map((row) => row.label), [agent, 'Robin \\$(zap) <b>[x](javascript:alert(1))</b>'], 'icon syntax escaped in the list');
    assert.deepEqual(list?.rows.map((row) => row.description), ['75% of text', '25% of text']);
  });
});

test('text written through a session key is attributed to the person its certificate names', async () => {
  const world = await createLiveWorld({ people: [{ label: 'avery', name: 'Avery Lead' }] });
  try {
    await createProduct(world.devices[0]);
    const hosted = await world.hostedStyle(world.devices[0]);
    const projectId = hosted.project.projectId;
    const live = {
      projects: () => [{ project: projectId, root: hosted.at.root, state: 'live', sentence: '' }],
      project: () => hosted.project as never,
      projectionInput: () => engine.projectionInputOf(hosted.project as never, hosted.host.deps as never),
      setBound: () => undefined,
      localAppended: () => undefined,
      onStatus: () => ({ dispose: () => undefined }),
    };
    const service = new StaffBindingService({ live: () => live as never, engine });
    const uri = pathToFileURL(path.join(hosted.at.root, ...staffProductPath('j4', PRODUCT).split('/'))).toString();
    const left = await openBound(service, uri);
    left.model.textModel.type(left.model.textModel.getValue().length, 0, ' Water for two.');
    await settle();
    await service.flush(left.doc);
    const { fold } = await hosted.project.state();
    const stream = (fold.families.versions as Array<{ stream: string; product: string }>).find((item) => item.product === PRODUCT)?.stream as string;
    const output = productOutput(fold, stream, PRODUCT);
    assert.ok(output?.registrations.some((registration) => registration.writer === hosted.session?.writer), 'the session key registered the text it wrote');
    await left.tab.whoWroteThis.toggle();
    const labels = marks(left.editor).map((item) => item.options.linesDecorationsTooltip);
    assert.ok(labels.length >= 2, 'the first text and the session\'s text are marked');
    assert.deepEqual([...new Set(labels)], ['Avery Lead'], 'both read as the person');
    assert.ok(left.model.textModel.getValue().endsWith(`${SEED} Water for two.`));
  } finally {
    await world.close();
  }
});
