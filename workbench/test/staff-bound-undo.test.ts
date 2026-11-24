// Phase 33 plan 25 (D-54, RESEARCH N4): undo and redo in a bound product run the binding's own history, by every path Theia 1.77 has. Ctrl+Z,
// Ctrl+Y, the Edit menu and the command palette all run core.undo and core.redo; Theia's handler for them calls the UndoRedoHandler service, whose
// Monaco handler undoes the model natively. Both the command handler and an UndoRedoHandler ranked above Monaco's route a bound editor to the
// binding, so native undo never runs on it; outside bound products Theia's own undo runs as before. Undo removes only this person's changes.
// Fictional exercise data only.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Container } from '@theia/core/shared/inversify';
import { CommandRegistry } from '@theia/core/lib/common/command.js';
import { CommonCommands } from '@theia/core/lib/browser/common-commands.js';
import { UndoRedoHandlerService, type UndoRedoHandler } from '@theia/core/lib/browser/undo-redo-handler.js';
import { StaffBoundUndoRedoHandler, StaffBindingContribution } from '../extension/src/browser/staff/binding-contribution.ts';
import { FakeSourceModel, FakeTab, settle, until, withProduct, type FakeEditor, type Person } from './helpers/staff-binding-world.ts';

/** Theia's own wiring of core.undo and core.redo, with a Monaco-like handler that undoes the focused editor natively and counts it. */
function theiaUndo(binding: StaffBindingContribution, focused: () => FakeEditor | undefined) {
  const native = { undo: 0, redo: 0 };
  const monaco: UndoRedoHandler<FakeEditor> = {
    priority: 10000,
    select: () => focused(),
    undo: (editor) => { native.undo += 1; (editor.model as FakeSourceModel).textModel.undo(); },
    redo: () => { native.redo += 1; },
  };
  const container = new Container();
  const staff = new StaffBoundUndoRedoHandler();
  Object.assign(staff, { binding });
  const service = new UndoRedoHandlerService();
  Object.assign(service, { provider: { getContributions: () => [monaco, staff] } });
  (service as unknown as { init(): void }).init();
  const registry = new CommandRegistry({ getContributions: () => [] } as never);
  // Theia's CommonFrontendContribution: core.undo and core.redo call the UndoRedoHandler service.
  registry.registerCommand(CommonCommands.UNDO, { execute: () => service.undo() });
  registry.registerCommand(CommonCommands.REDO, { execute: () => service.redo() });
  binding.registerCommands(registry);
  void container;
  return { registry, service, native };
}

async function boundEditor(person: Person): Promise<{ tab: FakeTab; editor: FakeEditor; model: FakeSourceModel }> {
  const tab = new FakeTab(person.service);
  const model = new FakeSourceModel(person.uri, '');
  const editor = tab.open(model);
  await until(() => tab.contribution.bindings()[0]?.state, (state) => state === 'bound', 'bound');
  return { tab, editor, model };
}

test('with a bound editor focused, core.undo and core.redo run the binding and never Theia\'s handler', async () => {
  await withProduct(async ({ avery }) => {
    const { tab, editor, model } = await boundEditor(avery);
    const initial = model.textModel.getValue();
    editor.focused = true;
    const { registry, native } = theiaUndo(tab.contribution, () => editor);
    model.textModel.type(initial.length, 0, ' Water');
    await settle();
    await registry.executeCommand(CommonCommands.UNDO.id);
    await until(() => model.textModel.getValue(), (text) => text === initial, 'undone');
    await registry.executeCommand(CommonCommands.REDO.id);
    await until(() => model.textModel.getValue(), (text) => text === `${initial} Water`, 'redone');
    assert.deepEqual(native, { undo: 0, redo: 0 });
  });
});

test('the keyboard path through Theia\'s UndoRedoHandler service also reaches the binding, and native undo never runs on a bound model', async () => {
  await withProduct(async ({ avery }) => {
    const { tab, editor, model } = await boundEditor(avery);
    const initial = model.textModel.getValue();
    editor.focused = true;
    const { service, native } = theiaUndo(tab.contribution, () => editor);
    model.textModel.type(initial.length, 0, ' Water');
    await settle();
    // Ctrl+Z reaches core.undo; when another core.undo handler ran first, the service is what it calls.
    service.undo();
    await until(() => model.textModel.getValue(), (text) => text === initial, 'undone');
    assert.equal(native.undo, 0);
    assert.equal(tab.contribution.focusedBound()?.state, 'bound', 'the context key\'s condition holds while the bound editor has focus');
    editor.focused = false;
    assert.equal(tab.contribution.focusedBound(), undefined);
  });
});

test('with an editor that is not bound focused, Theia\'s own undo runs as before', async () => {
  await withProduct(async ({ avery }) => {
    const tab = new FakeTab(avery.service);
    const model = new FakeSourceModel(`${avery.uri.replace(/[^/]+$/, '')}notes.md`, 'Notes');
    const editor = tab.open(model);
    await until(() => tab.contribution.bindings()[0]?.state, (state) => state === 'none', 'not bound');
    editor.focused = true;
    const { registry, native } = theiaUndo(tab.contribution, () => editor);
    model.textModel.type(5, 0, '!');
    await registry.executeCommand(CommonCommands.UNDO.id);
    assert.equal(native.undo, 1);
    assert.equal(model.textModel.getValue(), 'Notes');
  });
});

test('after my change A, another person\'s change B and my change C, two undos remove C then A and leave B', async () => {
  await withProduct(async ({ avery, blake, carry }) => {
    const mine = await boundEditor(avery);
    const theirs = await boundEditor(blake);
    const header = mine.model.textModel.getValue();
    mine.editor.focused = true;
    const { registry } = theiaUndo(mine.tab.contribution, () => mine.editor);
    const doc = mine.tab.contribution.bindings()[0].doc as string;
    // `header` is the whole first text here: every change below goes after it.
    mine.model.textModel.type(header.length, 0, ' Alpha');
    await settle();
    await avery.service.flush(doc);
    await carry(avery, blake);
    blake.replicator.emit({ pulled: 1 });
    await until(() => theirs.model.textModel.getValue(), (text) => text === `${header} Alpha`, 'Blake has A');
    theirs.model.textModel.type(header.length + 6, 0, ' Bravo');
    await settle();
    await blake.service.flush(theirs.tab.contribution.bindings()[0].doc as string);
    await carry(blake, avery);
    avery.replicator.emit({ pulled: 1 });
    await until(() => mine.model.textModel.getValue(), (text) => text === `${header} Alpha Bravo`, 'Avery has B');
    // The binding's history joins local changes less than 500 ms apart into one step (doc.ts captureTimeout), as a person's typing burst.
    await new Promise((resolve) => setTimeout(resolve, 600));
    mine.model.textModel.type(mine.model.textModel.getValue().length, 0, ' Charlie');
    await settle();
    await registry.executeCommand(CommonCommands.UNDO.id);
    await until(() => mine.model.textModel.getValue(), (text) => text === `${header} Alpha Bravo`, 'C undone');
    await registry.executeCommand(CommonCommands.UNDO.id);
    await until(() => mine.model.textModel.getValue(), (text) => text === `${header} Bravo`, 'A undone, B kept');
  });
});
