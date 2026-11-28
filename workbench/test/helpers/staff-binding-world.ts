// Phase 33 plan 25: what the binding tests share. A text model with the members of Monaco's ITextModel the binding uses (Monaco's own model does
// not load under the Node test runner: its modules import CSS), the browser contribution wired to the backend service in one process, and a shared
// project of two people from the live world with one product. Fictional exercise data only.
import 'reflect-metadata';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { Container } from '@theia/core/shared/inversify';
import { MessageService } from '@theia/core/lib/common/message-service.js';
import { ContextKeyService } from '@theia/core/lib/browser/context-key-service.js';
import { loadStaffEngine, type EngineLiveStatus, type EngineReplicator, type StaffEngine } from '../../extension/src/node/staff/staff-engine.ts';
import { StaffLiveEngine } from '../../extension/src/node/staff/staff-live-engine.ts';
import { StaffBindingService } from '../../extension/src/node/staff/binding-service.ts';
import { diffEdit, StaffBindingServer, type StaffBindingClient } from '../../extension/src/common/staff-binding.ts';
import {
  StaffBindingContribution, StaffBindingEvents, StaffEditorSource, type SourceEditor, type SourceModel,
} from '../../extension/src/browser/staff/binding-contribution.ts';
import type { BoundTextModel, ModelContentChange, ModelRange } from '../../extension/src/browser/staff/monaco-bound-document.ts';
import { REPLICA_DIR } from '../../../src/domain/staff/multiUser.ts';
import { staffProductPath } from '../../../src/domain/staff/writeLimits.ts';
import { clientIdOf } from '../../../src/domain/replica/clientIds.ts';
import { createLocalDoc, docText, localInsert, snapshotOf } from '../../../src/domain/replica/doc.ts';
import { appendProductEntry, proposeVersion } from '../../../src/staff/replica/labelCells.ts';
import { carryThroughFake, createLiveWorld, type LiveDevice, type LiveWorld } from '../../../src/test/helpers/liveWorld.ts';
import { fileURLToPath } from 'node:url';

// The tests that use this helper are bundled into dist/test/, so the workbench is two folders up from the running file.
const workbenchRoot = fileURLToPath(new URL('../..', import.meta.url));
export const engine = loadStaffEngine<StaffEngine>(workbenchRoot);
export const PRODUCT = 'logistics-estimate';
const LABEL = 'org/Internal';
/** The product's text at its first version: a product file exists only for a product with a version. */
export const SEED = 'Fuel for three days.';
const ROLES = { owner: 'j4-planner', sectionLead: 'j4-lead', releaseGuard: 'j4-guard' };

// ---- a text model with Monaco's members ----------------------------------------------------------------------------------------------------------

interface Op { readonly offset: number; readonly length: number; readonly text: string }

/** Monaco's ITextModel as far as the binding uses it, with an undo stack that only pushEditOperations (typing) adds to, as in Monaco. */
export class FakeTextModel implements BoundTextModel {
  private text: string;
  private versionId = 1;
  private readonly listeners = new Set<(event: ModelContentChange) => void>();
  private readonly undoStack: Array<{ before: string; after: string }> = [];
  private readonly redoStack: Array<{ before: string; after: string }> = [];
  public eol: 'lf' | 'crlf' = 'lf';
  public applied = 0;

  constructor(text: string) {
    this.text = text;
  }

  getVersionId(): number { return this.versionId; }
  getValue(): string { return this.text; }

  getPositionAt(offset: number): { lineNumber: number; column: number } {
    const before = this.text.slice(0, offset);
    const lines = before.split('\n');
    return { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 };
  }

  private offsetAt(line: number, column: number): number {
    const lines = this.text.split('\n');
    let offset = 0;
    for (let index = 0; index < line - 1; index += 1) offset += lines[index].length + 1;
    return offset + column - 1;
  }

  /** No undo stop, as Monaco's applyEdits. */
  applyEdits(operations: Array<{ range: ModelRange; text: string }>): void {
    this.applied += 1;
    this.change(operations.map(({ range, text }) => {
      const offset = this.offsetAt(range.startLineNumber, range.startColumn);
      return { offset, length: this.offsetAt(range.endLineNumber, range.endColumn) - offset, text };
    }), {});
  }

  setEOL(): void { this.eol = 'lf'; }

  onDidChangeContent(listener: (event: ModelContentChange) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  /** The person types: an undo stop, as Monaco's pushEditOperations. */
  type(offset: number, length: number, text: string): void {
    const before = this.text;
    this.change([{ offset, length, text }], {});
    this.undoStack.push({ before, after: this.text });
    this.redoStack.length = 0;
  }

  /** Monaco's native undo: false when the stack is empty. */
  undo(): boolean {
    const step = this.undoStack.pop();
    if (step === undefined) return false;
    this.change([{ offset: 0, length: this.text.length, text: step.before }], { isUndoing: true });
    this.redoStack.push(step);
    return true;
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }

  /** The text changes and no event says so: a change event lost on the way, which only the hash can show. */
  diverge(text: string): void {
    this.text = text;
    this.versionId += 1;
  }

  private change(ops: readonly Op[], flags: { isUndoing?: boolean }): void {
    const sorted = [...ops].sort((a, b) => b.offset - a.offset);
    for (const { offset, length, text } of sorted) this.text = this.text.slice(0, offset) + text + this.text.slice(offset + length);
    this.versionId += 1;
    const event: ModelContentChange = {
      changes: sorted.map(({ offset, length, text }) => ({ rangeOffset: offset, rangeLength: length, text })),
      versionId: this.versionId, isUndoing: flags.isUndoing === true, isRedoing: false,
    };
    for (const listener of [...this.listeners]) listener(event);
  }
}

// ---- a tab: the contribution with fake editors ----------------------------------------------------------------------------------------------------

export interface FakeEditor extends SourceEditor {
  focused: boolean;
  readOnly: boolean;
  readOnlyMessage?: string;
}

export class FakeSourceModel implements SourceModel {
  public diskSync = false;
  public saves = 0;
  public readonly textModel: FakeTextModel;
  private readonly willSave: Array<() => Promise<void>> = [];
  private readonly disposeListeners: Array<() => void> = [];
  public onSaved?: (text: string) => Promise<void>;

  constructor(public readonly uri: string, text: string) {
    this.textModel = new FakeTextModel(text);
  }

  isDiskSync(): boolean { return this.diskSync; }
  onWillSave(listener: () => Promise<void>): { dispose(): void } { this.willSave.push(listener); return { dispose: () => undefined }; }
  onDispose(listener: () => void): { dispose(): void } { this.disposeListeners.push(listener); return { dispose: () => undefined }; }

  async save(): Promise<void> {
    for (const listener of this.willSave) await listener();
    this.saves += 1;
    await this.onSaved?.(this.textModel.getValue());
  }

  /** Theia reloads the file from disk (MonacoEditorModel.doSync); Monaco's updateModel applies the smallest edit between the two texts. */
  reloadFromDisk(text: string): void {
    const edit = diffEdit(this.textModel.getValue(), text);
    const start = this.textModel.getPositionAt(edit.offset);
    const end = this.textModel.getPositionAt(edit.offset + edit.length);
    this.diskSync = true;
    try {
      this.textModel.applyEdits([{ range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column }, text: edit.text }]);
    } finally {
      this.diskSync = false;
    }
  }

  dispose(): void { for (const listener of this.disposeListeners) listener(); }
}

export function fakeEditor(model: SourceModel): FakeEditor {
  const editor: FakeEditor = {
    model, focused: false, readOnly: false,
    isFocused: () => editor.focused,
    setReadOnly: (readOnly, message) => { editor.readOnly = readOnly; editor.readOnlyMessage = readOnly ? message : undefined; },
    onFocusChanged: () => ({ dispose: () => undefined }),
    onDispose: () => ({ dispose: () => undefined }),
  };
  return editor;
}

/** One browser tab: the real contribution, its client, and editors the test opens. Its messages answer with `choice`. */
export class FakeTab {
  public readonly contribution: StaffBindingContribution;
  public readonly events: StaffBindingEvents;
  public readonly warnings: string[] = [];
  public choice: string | undefined;
  private readonly created: Array<(editor: SourceEditor) => void> = [];
  private closeConnection: (() => void) | undefined;

  constructor(private readonly service: StaffBindingService) {
    const container = new Container();
    container.bind(StaffBindingServer).toConstantValue(service);
    container.bind(StaffBindingEvents).toSelf().inSingletonScope();
    container.bind(StaffEditorSource).toConstantValue({ all: () => [], onCreated: (listener: (editor: SourceEditor) => void) => { this.created.push(listener); return { dispose: () => undefined }; } });
    container.bind(MessageService).toConstantValue({ warn: async (text: string) => { this.warnings.push(text); return this.choice; } } as unknown as MessageService);
    container.bind(ContextKeyService).toConstantValue({ createKey: () => ({ set: () => undefined, get: () => false, reset: () => undefined }) } as unknown as ContextKeyService);
    container.bind(StaffBindingContribution).toSelf().inSingletonScope();
    this.contribution = container.get(StaffBindingContribution);
    this.events = container.get(StaffBindingEvents);
    this.contribution.onStart();
    this.connect();
  }

  /** The connection to the backend: the service says hello with a new id. */
  connect(): void {
    const events = this.events;
    const client: StaffBindingClient & { onDidCloseConnection(listener: () => void): { dispose(): void } } = {
      onHello: (id) => events.onHello(id),
      onApplyEdits: (doc, request, edits, baseVersion, lineEndings) => events.onApplyEdits(doc, request, edits, baseVersion, lineEndings),
      onRequestFullText: (doc) => events.onRequestFullText(doc),
      onReadOnly: (doc, readOnly, message) => events.onReadOnly(doc, readOnly, message),
      onNotice: (doc, text) => events.onNotice(doc, text),
      onDidCloseConnection: (listener) => { this.closeConnection = listener; return { dispose: () => undefined }; },
    };
    this.service.addClient(client as never);
  }

  /** The connection drops: the backend detaches this tab's documents. */
  drop(): void { this.closeConnection?.(); }

  open(model: SourceModel): FakeEditor {
    const editor = fakeEditor(model);
    for (const listener of this.created) listener(editor);
    return editor;
  }
}

// ---- a shared project of two with one product, and the live engine of each --------------------------------------------------------------------------

export class FakeReplicator implements EngineReplicator {
  public status: EngineLiveStatus = { state: 'live', since: 0, findings: [], pulled: 0, pushed: 0 };
  public appended = 0;
  private readonly listeners: Array<(status: EngineLiveStatus) => void> = [];
  onStatus(listener: (status: EngineLiveStatus) => void) { this.listeners.push(listener); return { dispose: () => undefined }; }
  async start() { /* nothing */ }
  async stop() { /* nothing */ }
  syncNow() { /* nothing */ }
  localAppended() { this.appended += 1; }
  emit(change: Partial<EngineLiveStatus>) { this.status = { ...this.status, ...change }; for (const listener of this.listeners) listener(this.status); }
}

export interface Person {
  readonly device: LiveDevice;
  readonly live: StaffLiveEngine;
  readonly service: StaffBindingService;
  readonly replicator: FakeReplicator;
  readonly logs: string[];
  readonly uri: string;
  readonly file: string;
}

export async function personOf(device: LiveDevice): Promise<Person> {
  let replicator: FakeReplicator | undefined;
  const logs: string[] = [];
  const live = new StaffLiveEngine({
    engine: { ...engine, LiveReplicator: function Made() { replicator = new FakeReplicator(); return replicator; } as never, projectLive: async () => ({ written: [], left: [] }) } as StaffEngine,
    roots: async () => [device.at.root], globalStorageDir: device.at.global, secrets: device.at.secrets, log: (line) => logs.push(line),
  });
  await live.start();
  const service = new StaffBindingService({ live: () => live, engine, log: (line) => logs.push(line) });
  const file = path.join(device.at.root, ...staffProductPath('j4', PRODUCT).split('/'));
  return { device, live, service, replicator: replicator as FakeReplicator, logs, uri: pathToFileURL(file).toString(), file };
}

export interface ProductWorld {
  readonly world: LiveWorld;
  readonly avery: Person;
  readonly blake: Person;
  /** The product's key group, where its text lives. */
  readonly stream: string;
  /** Carries one person's changes to the other, roster and key group both, as an exchange would. */
  carry(from: Person, to: Person): Promise<void>;
}

/**
 * A world of two people sharing one product with a first version (its file is where the projection puts it); `run` gets each person's live engine
 * and binding service. The product is labelled org/Internal, which both are cleared for.
 */
export async function withProduct(run: (people: ProductWorld) => Promise<void>): Promise<void> {
  const world = await createLiveWorld({ people: [{ label: 'avery', name: 'Avery Lead' }, { label: 'blake', name: 'Blake Rivers' }] });
  const people: Person[] = [];
  try {
    const [averyDevice, blakeDevice] = world.devices;
    const created = await appendProductEntry(averyDevice.host, 'product.create', { product: PRODUCT, section: 'j4', roles: ROLES, title: 'Logistics estimate' }, { label: LABEL });
    if (!created.ok) throw new Error(created.message);
    const { roster } = await averyDevice.project.state();
    const clientId = clientIdOf(roster.members.devices.get(averyDevice.project.deviceWriter)?.[0]?.slot ?? 1, 0);
    const client = await appendProductEntry(averyDevice.host, 'doc.client', { product: PRODUCT, clientId, actor: { kind: 'person' } });
    if (!client.ok) throw new Error(client.message);
    const doc = createLocalDoc(clientId);
    const update = await appendProductEntry(averyDevice.host, 'doc.update', { product: PRODUCT, update: Buffer.from(localInsert(doc, 0, SEED)).toString('base64url') });
    if (!update.ok) throw new Error(update.message);
    const proposed = await proposeVersion(averyDevice.host, { product: PRODUCT, text: docText(doc), header: { kind: 'estimate', label: LABEL, profile: 'j4', level: 'official' }, pins: [], snapshot: snapshotOf(doc) });
    if (!proposed.ok) throw new Error(proposed.message);
    // Each person's live engine holds its own open copy of the project, as in a session: changes go from one engine's copy to the other's.
    const engineSide = (person: Person): LiveDevice => {
      const shared = person.live.shared(person.device.project.projectId);
      if (shared === undefined) throw new Error('the live engine has the shared project open');
      return { ...person.device, project: shared.project as unknown as LiveDevice['project'] };
    };
    const carry = async (from: Person, to: Person): Promise<void> => {
      await carryThroughFake(engineSide(from), engineSide(to), from.device.project.projectId);
      // The key group's grants travel beside the entries (labelCellWorld.syncTo does the same): without them its text does not open.
      const grants = path.join(from.device.at.root, ...REPLICA_DIR.split('/'), 'grants', created.stream);
      const signed = existsSync(grants) ? readdirSync(grants).filter((name) => name.endsWith('.json')).sort().map((name) => JSON.parse(readFileSync(path.join(grants, name), 'utf8')) as unknown) : [];
      const target = engineSide(to).project as unknown as { putGrants(grants: readonly unknown[]): Promise<unknown> };
      await target.putGrants(signed);
      await carryThroughFake(engineSide(from), engineSide(to), created.stream);
    };
    const avery = await personOf(averyDevice);
    people.push(avery);
    const blake = await personOf(blakeDevice);
    people.push(blake);
    await carry(avery, blake);
    await run({ world, avery, blake, stream: created.stream, carry });
  } finally {
    for (const person of people) await person.live.stop();
    await world.close();
  }
}

/** Lets every pending promise and message run. */
export async function settle(rounds = 30): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

export async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, what: string | (() => string), ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${typeof what === 'string' ? what : what()}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
