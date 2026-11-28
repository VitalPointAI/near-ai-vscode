/**
 * The editor binding in the browser (Phase 33 D-53 to D-55, D-17; RESEARCH N3, N4, Pitfall N8.3). Every Monaco model a Theia editor opens is
 * offered to the backend once; only a product of an open shared project is bound, and every other model is never touched (MUS-06).
 *
 *   undo, redo   in a bound product they run the binding's own history, so only this person's changes are undone (D-54). Theia 1.77 sends
 *                Ctrl+Z, Ctrl+Y, the Edit menu and the command palette to core.undo and core.redo; their handler calls the UndoRedoHandler
 *                service, whose Monaco handler undoes the model natively (Monaco's own `undo` command is not registered in Theia). So a
 *                handler for core.undo and core.redo, enabled only while a bound editor has focus, and an UndoRedoHandler ranked above
 *                Monaco's route both to the binding. Outside bound products neither is enabled and Theia's own undo runs, as before.
 *   read-only    another tab of this session edits the product: this tab's model is read-only with OTHER_TAB_TEXT until it is told otherwise
 *   disk change  Theia reloaded the file: held, and offered as Take This Change as My Edit or Restore (D-55)
 *   save         flushes the binding first, so the saved file is the shared text (D-17)
 *   reconnect    a new client id means the connection came back: every model attaches again; changes the backend never confirmed are
 *                offered with the same two choices, never silently dropped
 *
 * The context key sterlingStaffBoundEditor is true only while a bound editor has focus. Nothing here imports Monaco or the editor package: the part
 * file gives this class the editors through StaffEditorSource, so the routing runs under the unit tests too. Sentences come from staff-binding.ts.
 */
import { inject, injectable } from '@theia/core/shared/inversify';
import { CommandRegistry, type CommandContribution } from '@theia/core/lib/common/command.js';
import { Emitter, type Event } from '@theia/core/lib/common/event.js';
import { MessageService } from '@theia/core/lib/common/message-service.js';
import { CommonCommands } from '@theia/core/lib/browser/common-commands.js';
import { ContextKeyService, type ContextKey } from '@theia/core/lib/browser/context-key-service.js';
import type { UndoRedoHandler } from '@theia/core/lib/browser/undo-redo-handler.js';
import {
  BOUND_EDITOR_CONTEXT, STAFF_BINDING_TEXT, StaffBindingServer, type AttachAnswer, type BindingEdit, type StaffBindingClient,
} from '../../common/staff-binding.js';
import { MonacoBoundDocument, type BoundTextModel } from './monaco-bound-document.js';

interface Disposable { dispose(): void }

/** A Theia text model (MonacoEditorModel), as the binding uses it. */
export interface SourceModel {
  readonly uri: string;
  readonly textModel: BoundTextModel;
  /** True while Theia reloads the model from the file on disk. */
  isDiskSync(): boolean;
  onWillSave(listener: () => Promise<void>): Disposable;
  save(): Promise<void>;
  onDispose(listener: () => void): Disposable;
}

/** One editor showing a model. */
export interface SourceEditor {
  readonly model: SourceModel;
  isFocused(): boolean;
  setReadOnly(readOnly: boolean, message?: string): void;
  onFocusChanged(listener: (focused: boolean) => void): Disposable;
  onDispose(listener: () => void): Disposable;
}

/** The editors of this tab (the part file adapts Theia's EditorManager). */
export interface StaffEditorSource {
  all(): SourceEditor[];
  onCreated(listener: (editor: SourceEditor) => void): Disposable;
}
export const StaffEditorSource = Symbol('StaffEditorSource');

/** This tab's binding client: the backend's notifications as events. */
@injectable()
export class StaffBindingEvents implements StaffBindingClient {
  private readonly hello = new Emitter<string>();
  private readonly apply = new Emitter<{ doc: string; request: number; edits: readonly BindingEdit[]; baseVersion: number; lineEndings?: 'lf' }>();
  private readonly fullText = new Emitter<string>();
  private readonly readOnly = new Emitter<{ doc: string; readOnly: boolean; message?: string }>();
  private readonly notice = new Emitter<{ doc: string; text: string }>();
  readonly onDidHello: Event<string> = this.hello.event;
  readonly onDidApply = this.apply.event;
  readonly onDidRequestFullText: Event<string> = this.fullText.event;
  readonly onDidReadOnly = this.readOnly.event;
  readonly onDidNotice = this.notice.event;
  /** The latest id the backend gave this tab. */
  client: string | undefined;

  onHello(client: string): void { this.client = client; this.hello.fire(client); }
  onApplyEdits(doc: string, request: number, edits: readonly BindingEdit[], baseVersion: number, lineEndings?: 'lf'): void {
    this.apply.fire({ doc, request, edits, baseVersion, ...(lineEndings === undefined ? {} : { lineEndings }) });
  }
  onRequestFullText(doc: string): void { this.fullText.fire(doc); }
  onReadOnly(doc: string, readOnly: boolean, message?: string): void { this.readOnly.fire({ doc, readOnly, ...(message === undefined ? {} : { message }) }); }
  onNotice(doc: string, text: string): void { this.notice.fire({ doc, text }); }
}

/** One model of this tab and where it stands with the backend. */
export interface BoundModel {
  readonly model: SourceModel;
  readonly editors: Set<SourceEditor>;
  state: 'attaching' | 'none' | 'bound' | 'read-only';
  doc?: string;
  bound?: MonacoBoundDocument;
}

@injectable()
export class StaffBindingContribution implements CommandContribution {
  @inject(StaffBindingServer) protected readonly server!: StaffBindingServer;
  @inject(StaffBindingEvents) protected readonly events!: StaffBindingEvents;
  @inject(StaffEditorSource) protected readonly editors!: StaffEditorSource;
  @inject(MessageService) protected readonly messages!: MessageService;
  @inject(ContextKeyService) protected readonly contextKeys!: ContextKeyService;

  private readonly models = new Map<SourceModel, BoundModel>();
  private readonly docs = new Map<string, BoundModel>();
  /** Requests for a document that arrived before its attach answer did (the backend may refresh a binding at once): replayed when it binds. */
  private readonly early = new Map<string, Array<(bound: MonacoBoundDocument) => void>>();
  private contextKey: ContextKey<boolean> | undefined;
  private started = false;

  /** Starts watching this tab's editors (FrontendApplicationContribution.onStart). */
  onStart(): void {
    if (this.started) return;
    this.started = true;
    this.contextKey = this.contextKeys.createKey<boolean>(BOUND_EDITOR_CONTEXT, false);
    this.events.onDidHello((client) => this.hello(client));
    this.events.onDidApply(({ doc, request, edits, baseVersion, lineEndings }) => this.toBound(doc, (bound) => { bound.applyRemote(request, edits, baseVersion, lineEndings); }));
    this.events.onDidRequestFullText((doc) => this.toBound(doc, (bound) => bound.sendFullText()));
    this.events.onDidReadOnly(({ doc, readOnly, message }) => this.readOnly(doc, readOnly, message));
    this.events.onDidNotice(({ text }) => { void this.messages.warn(text); });
    this.editors.onCreated((editor) => this.track(editor));
    for (const editor of this.editors.all()) this.track(editor);
  }

  registerCommands(registry: CommandRegistry): void {
    // Registered after Theia's own: the most recently registered enabled handler runs.
    registry.registerHandler(CommonCommands.UNDO.id, { isEnabled: () => this.focusedBound() !== undefined, execute: () => this.history('undo') });
    registry.registerHandler(CommonCommands.REDO.id, { isEnabled: () => this.focusedBound() !== undefined, execute: () => this.history('redo') });
  }

  /** The bound model whose editor has focus, if any. */
  focusedBound(): BoundModel | undefined {
    for (const entry of this.models.values()) {
      if (entry.state === 'bound' && [...entry.editors].some((editor) => editor.isFocused())) return entry;
    }
    return undefined;
  }

  /** Runs the binding's undo or redo for the focused bound product. */
  async history(direction: 'undo' | 'redo', entry: BoundModel | undefined = this.focusedBound()): Promise<boolean> {
    if (entry?.doc === undefined || entry.state !== 'bound') return false;
    await entry.bound?.settled();
    return direction === 'undo' ? this.server.undo(entry.doc) : this.server.redo(entry.doc);
  }

  /** The model of every editor this tab tracks, for the tests. */
  bindings(): BoundModel[] {
    return [...this.models.values()];
  }

  track(editor: SourceEditor): void {
    let entry = this.models.get(editor.model);
    const fresh = entry === undefined;
    if (entry === undefined) {
      entry = { model: editor.model, editors: new Set(), state: 'attaching' };
      this.models.set(editor.model, entry);
      const tracked = entry;
      editor.model.onWillSave(async () => {
        if (tracked.state !== 'bound' || tracked.doc === undefined) return;
        await tracked.bound?.settled();
        await this.server.flush(tracked.doc);
      });
      editor.model.onDispose(() => { void this.release(tracked); });
    }
    entry.editors.add(editor);
    const tracked = entry;
    editor.onFocusChanged(() => this.updateContext());
    editor.onDispose(() => { tracked.editors.delete(editor); this.updateContext(); });
    if (entry.state === 'read-only') editor.setReadOnly(true, STAFF_BINDING_TEXT.otherTab);
    if (fresh) void this.attach(entry);
  }

  private async attach(entry: BoundModel, unconfirmed?: string): Promise<void> {
    const client = this.events.client;
    if (client === undefined) return; // attached when the backend says hello
    entry.state = 'attaching';
    let answer: AttachAnswer;
    for (let tries = 0; ; tries += 1) {
      const { textModel } = entry.model;
      try {
        answer = await this.server.attach(client, entry.model.uri, textModel.getValue(), textModel.getVersionId());
      } catch {
        entry.state = 'none';
        return;
      }
      if (answer.kind !== 'reset' || tries >= 2) break;
      // Not the shared text: the shared text goes in without an undo stop, then the model attaches again.
      const current = textModel.getValue();
      const end = textModel.getPositionAt(current.length);
      textModel.applyEdits([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: end.lineNumber, endColumn: end.column }, text: answer.text }]);
    }
    if (answer.kind === 'not-shared' || answer.kind === 'reset') {
      entry.state = 'none';
      return;
    }
    entry.doc = answer.doc;
    this.docs.set(answer.doc, entry);
    if (answer.kind === 'read-only') {
      entry.state = 'read-only';
      for (const editor of entry.editors) editor.setReadOnly(true, answer.message);
      return;
    }
    entry.state = 'bound';
    entry.bound = new MonacoBoundDocument({
      doc: answer.doc, model: entry.model.textModel, channel: this.server,
      isDiskSync: () => entry.model.isDiskSync(),
      onDiskChange: () => { void this.askAboutChange(entry, STAFF_BINDING_TEXT.diskChanged); },
      setReadOnly: (readOnly) => { for (const editor of entry.editors) editor.setReadOnly(readOnly); },
    });
    for (const editor of entry.editors) editor.setReadOnly(false);
    this.updateContext();
    const bound = entry.bound;
    for (const run of this.early.get(answer.doc) ?? []) run(bound);
    this.early.delete(answer.doc);
    if (unconfirmed !== undefined && unconfirmed !== entry.model.textModel.getValue()) {
      entry.bound.holdChange(unconfirmed);
      void this.askAboutChange(entry, STAFF_BINDING_TEXT.unsent);
    }
  }

  private toBound(doc: string, run: (bound: MonacoBoundDocument) => void): void {
    const bound = this.docs.get(doc)?.bound;
    if (bound !== undefined) {
      run(bound);
      return;
    }
    if (this.docs.has(doc)) return;
    const waiting = this.early.get(doc) ?? [];
    waiting.push(run);
    this.early.set(doc, waiting);
  }

  private async askAboutChange(entry: BoundModel, sentence: string): Promise<void> {
    const choice = await this.messages.warn(sentence, STAFF_BINDING_TEXT.take, STAFF_BINDING_TEXT.restore);
    const bound = entry.bound;
    if (bound === undefined || !bound.diskChangeHeld) return;
    if (choice === STAFF_BINDING_TEXT.take) {
      bound.takeDiskChange();
      return;
    }
    // Restore, and a message closed without a choice: the shared text goes back, and the file follows it.
    bound.restoreDiskChange();
    await bound.settled();
    await entry.model.save().catch(() => undefined);
  }

  private readOnly(doc: string, readOnly: boolean, message?: string): void {
    const entry = this.docs.get(doc);
    if (entry === undefined) return;
    if (readOnly) {
      for (const editor of entry.editors) editor.setReadOnly(true, message);
      return;
    }
    // The other tab let go: this one edits now, so it attaches again.
    this.docs.delete(doc);
    entry.doc = undefined;
    for (const editor of entry.editors) editor.setReadOnly(false);
    void this.attach(entry);
  }

  private hello(client: string): void {
    void client;
    // The first hello attaches what is already open; a later one means the connection came back.
    for (const entry of this.models.values()) {
      if (entry.state === 'none') continue;
      const unconfirmed = entry.bound?.hasUnconfirmedChanges === true ? entry.model.textModel.getValue() : undefined;
      entry.bound?.dispose();
      entry.bound = undefined;
      if (entry.doc !== undefined) this.docs.delete(entry.doc);
      entry.doc = undefined;
      void this.attach(entry, unconfirmed);
    }
    this.updateContext();
  }

  private async release(entry: BoundModel): Promise<void> {
    this.models.delete(entry.model);
    entry.bound?.dispose();
    const doc = entry.doc;
    entry.doc = undefined;
    entry.state = 'none';
    if (doc === undefined) return;
    this.docs.delete(doc);
    await this.server.detach(doc).catch(() => undefined);
    this.updateContext();
  }

  private updateContext(): void {
    this.contextKey?.set(this.focusedBound() !== undefined);
  }
}

/** Ranked above Monaco's own handlers (10000), so any caller of Theia's UndoRedoHandlerService undoes a bound product through its binding. */
@injectable()
export class StaffBoundUndoRedoHandler implements UndoRedoHandler<BoundModel> {
  readonly priority = 20000;
  @inject(StaffBindingContribution) protected readonly binding!: StaffBindingContribution;

  select(): BoundModel | undefined {
    return this.binding.focusedBound();
  }

  undo(item: BoundModel): void {
    void this.binding.history('undo', item);
  }

  redo(item: BoundModel): void {
    void this.binding.history('redo', item);
  }
}
