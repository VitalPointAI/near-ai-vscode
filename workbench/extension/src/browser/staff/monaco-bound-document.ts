/**
 * The browser end of a bound product (Phase 33 D-53, RESEARCH N2, N3, Pitfall N8.2): it wraps the Monaco text model of MonacoEditorModel and talks
 * to the backend's mirror over the binding channel.
 *
 *   local change   forwarded as its edits, the model's version and the SHA-256 of its text; isUndoing or isRedoing set the reason
 *   remote change  applied with ITextModel.applyEdits (no undo stop) only when the model's version is the one the request names, never echoed;
 *                  at any other version the answer is false and the model is unchanged
 *   whole text     sent once when the backend asks for it
 *   disk change    Theia's reload of the file from disk is not the person's typing: it is held, the model is read-only, and the person chooses to
 *                  take it as their edit or to restore the shared text (D-55)
 *
 * Every message leaves in the order the model changed, so the backend sees a version only after the change that made it. Nothing here imports
 * Monaco or Theia: the model is typed by the members it uses, so a test drives it with a model of the same shape.
 */
import { diffEdit, textHash, type BindingEdit, type BindingReason, type StaffBindingServer } from '../../common/staff-binding.js';

/** A Monaco range (1-based lines and columns). */
export interface ModelRange {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

/** Monaco's content change event, as far as the binding reads it. */
export interface ModelContentChange {
  readonly changes: ReadonlyArray<{ readonly rangeOffset: number; readonly rangeLength: number; readonly text: string }>;
  readonly versionId: number;
  readonly isUndoing: boolean;
  readonly isRedoing: boolean;
}

/** The members of Monaco's ITextModel the binding uses. */
export interface BoundTextModel {
  getVersionId(): number;
  getValue(): string;
  getPositionAt(offset: number): { readonly lineNumber: number; readonly column: number };
  /** Edits without an undo stop (Monaco: "Edit the model without adding the edits to the undo stack"). */
  applyEdits(operations: Array<{ range: ModelRange; text: string }>): unknown;
  /** Monaco's EndOfLineSequence: 0 is LF. */
  setEOL(eol: 0): void;
  onDidChangeContent(listener: (event: ModelContentChange) => void): { dispose(): void };
}

export type BindingChannel = Pick<StaffBindingServer, 'changed' | 'applied' | 'fullText' | 'synced'>;

export interface MonacoBoundDocumentOptions {
  readonly doc: string;
  readonly model: BoundTextModel;
  readonly channel: BindingChannel;
  /** True while Theia reloads the model from the file on disk (MonacoEditorModel.doSync). */
  readonly isDiskSync?: () => boolean;
  /** A disk change is held: the person chooses take or restore. */
  readonly onDiskChange?: () => void;
  readonly setReadOnly?: (readOnly: boolean) => void;
}

interface HeldDiskChange {
  readonly edits: BindingEdit[];
  readonly version: number;
  readonly text: string;
  /** The text before the reload, which restore puts back. */
  readonly before: string;
}

interface QueuedRequest {
  readonly request: number;
  readonly edits: readonly BindingEdit[];
  readonly baseVersion: number;
  readonly lineEndings?: 'lf';
}

export class MonacoBoundDocument {
  private readonly subscription: { dispose(): void };
  private outbox: Promise<void> = Promise.resolve();
  private applyingRemote = false;
  private lastText: string;
  private disk: HeldDiskChange | undefined;
  private readonly queued: QueuedRequest[] = [];
  private disposed = false;
  /** Local changes sent whose delivery the backend has not confirmed, and whether one failed. */
  private unconfirmed = 0;
  private lost = false;

  constructor(private readonly options: MonacoBoundDocumentOptions) {
    this.lastText = options.model.getValue();
    this.subscription = options.model.onDidChangeContent((event) => this.contentChanged(event));
  }

  public get doc(): string {
    return this.options.doc;
  }

  public get version(): number {
    return this.options.model.getVersionId();
  }

  /** True while a disk change waits for the person's choice. */
  public get diskChangeHeld(): boolean {
    return this.disk !== undefined;
  }

  /** Other people's changes, at `baseVersion` only. Answers applied in order with the local changes. */
  public applyRemote(request: number, edits: readonly BindingEdit[], baseVersion: number, lineEndings?: 'lf'): boolean {
    if (this.disposed) return false;
    if (this.disk !== undefined) {
      // Answered when the person has chosen, at the version the model has then.
      this.queued.push({ request, edits, baseVersion, ...(lineEndings === undefined ? {} : { lineEndings }) });
      return false;
    }
    const { model } = this.options;
    if (model.getVersionId() !== baseVersion) {
      this.send(model.getValue(), (hash) => this.options.channel.applied(this.doc, request, false, model.getVersionId(), hash));
      return false;
    }
    this.applyingRemote = true;
    try {
      if (lineEndings === 'lf') model.setEOL(0);
      if (edits.length > 0) model.applyEdits([...edits].sort((a, b) => b.offset - a.offset).map((edit) => this.operation(edit)));
    } finally {
      this.applyingRemote = false;
    }
    const text = model.getValue();
    this.lastText = text;
    const version = model.getVersionId();
    this.send(text, (hash) => this.options.channel.applied(this.doc, request, true, version, hash));
    return true;
  }

  /** Sends the model's whole text, as the backend asked. */
  public sendFullText(): void {
    const { model } = this.options;
    const text = model.getValue();
    const version = model.getVersionId();
    this.lastText = text;
    this.queue(async () => { await this.options.channel.fullText(this.doc, text, version); });
  }

  /** Take This Change as My Edit: the held disk change goes to the binding as this person's change. */
  public takeDiskChange(): void {
    const disk = this.disk;
    if (disk === undefined) return;
    this.disk = undefined;
    this.options.setReadOnly?.(false);
    this.sendChange(disk.text, disk.edits, disk.version);
    this.answerQueued();
  }

  /** Restore: the shared text goes back into the model (no undo stop), and the backend hears the model's new version. */
  public restoreDiskChange(): void {
    const disk = this.disk;
    if (disk === undefined) return;
    this.disk = undefined;
    const { model } = this.options;
    const current = model.getValue();
    this.applyingRemote = true;
    try {
      model.applyEdits([this.operation(diffEdit(current, disk.before))]);
    } finally {
      this.applyingRemote = false;
    }
    this.lastText = model.getValue();
    const version = model.getVersionId();
    this.options.setReadOnly?.(false);
    this.send(this.lastText, (hash) => this.options.channel.synced(this.doc, version, hash));
    this.answerQueued();
  }

  /** True when a local change may never have reached the backend (its call is still open, or failed): a reconnect offers it again. */
  public get hasUnconfirmedChanges(): boolean {
    return this.lost || this.unconfirmed > 0;
  }

  /**
   * Puts `text` in the model as a held change against the shared text the model has now (no undo stop, nothing sent): the person chooses take or
   * restore, as for a disk change. Used after a reconnect for changes the backend never confirmed.
   */
  public holdChange(text: string): void {
    const { model } = this.options;
    const before = model.getValue();
    if (text === before) return;
    this.applyingRemote = true;
    try {
      model.applyEdits([this.operation(diffEdit(before, text))]);
    } finally {
      this.applyingRemote = false;
    }
    this.lastText = model.getValue();
    this.disk = { edits: [diffEdit(before, text)], version: model.getVersionId(), text: this.lastText, before };
    this.options.setReadOnly?.(true);
  }

  /** Waits until every message so far has left. */
  public settled(): Promise<void> {
    return this.outbox;
  }

  public dispose(): void {
    this.disposed = true;
    this.subscription.dispose();
  }

  private contentChanged(event: ModelContentChange): void {
    if (this.disposed || this.applyingRemote) return;
    const edits = event.changes.map(({ rangeOffset, rangeLength, text }) => ({ offset: rangeOffset, length: rangeLength, text }));
    const text = this.options.model.getValue();
    const before = this.lastText;
    this.lastText = text;
    if (this.disk !== undefined || this.options.isDiskSync?.() === true) {
      // A reload from disk is held as one change against the text before it; a second one on top joins it as one replacement.
      this.disk = this.disk === undefined
        ? { edits, version: event.versionId, text, before }
        : { edits: [diffEdit(this.disk.before, text)], version: event.versionId, text, before: this.disk.before };
      this.options.setReadOnly?.(true);
      this.options.onDiskChange?.();
      return;
    }
    const reason: BindingReason | undefined = event.isUndoing ? 'undo' : event.isRedoing ? 'redo' : undefined;
    const version = event.versionId;
    this.sendChange(text, edits, version, reason);
  }

  private answerQueued(): void {
    for (const queued of this.queued.splice(0)) this.applyRemote(queued.request, queued.edits, queued.baseVersion, queued.lineEndings);
  }

  private operation(edit: BindingEdit): { range: ModelRange; text: string } {
    const start = this.options.model.getPositionAt(edit.offset);
    const end = this.options.model.getPositionAt(edit.offset + edit.length);
    return { range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column }, text: edit.text };
  }

  private sendChange(text: string, edits: readonly BindingEdit[], version: number, reason?: BindingReason): void {
    this.unconfirmed += 1;
    this.send(text, (hash) => this.options.channel.changed(this.doc, edits, version, hash, reason).then(
      () => { this.unconfirmed -= 1; },
      () => { this.unconfirmed -= 1; this.lost = true; },
    ));
  }

  private send(text: string, message: (hash: string) => Promise<unknown>): void {
    // The hashes are made in order; each message leaves as soon as its hash is ready (Theia's channel keeps the order it was given).
    this.queue(async () => { void message(await textHash(text)).catch(() => undefined); });
  }

  /** Each message leaves after the one before it; a failed one does not stop the next. */
  private queue(run: () => Promise<void>): void {
    this.outbox = this.outbox.then(run).catch(() => undefined);
  }
}
