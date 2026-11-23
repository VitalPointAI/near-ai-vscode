// The binding uses the origin filtering pattern from y-codemirror.next and the
// right-to-left transaction pattern from y-monaco. Their editor adapters are separate.
// https://github.com/yjs/y-codemirror.next/blob/main/src/y-sync.js
// https://github.com/yjs/y-monaco/blob/master/src/y-monaco.js
import type { BoundTextEdit, TextOp } from '../../domain/replica/doc';
import { ProductEditor } from './productEditing';
import type { EditorHooks, EditorProject, EditTarget } from './productEditing';

export type DocumentEdit = BoundTextEdit;

export interface BoundDocumentChange {
  readonly edits: readonly DocumentEdit[];
  /** The text and version after this event, captured together even if delivery is deferred. */
  readonly text: string;
  readonly version: number;
  readonly reason?: 'undo' | 'redo';
}

export interface BoundDocument {
  readonly version: number;
  getText(): string;
  /** Apply against baseVersion only. Set the editor EOL when requested and emit one event with the new text. */
  applyEdits(edits: readonly DocumentEdit[], expectedText: string, baseVersion: number, lineEndings?: 'lf'): Promise<boolean>;
  onDidChange(listener: (change: BoundDocumentChange) => void): () => void;
}

export interface BoundProduct extends EditTarget {
  readonly project: EditorProject;
  header(): string;
}

export interface BindingHooks extends EditorHooks {
  notice?(text: string): void;
  log?(line: string): void;
}

export const HEADER_KEPT_TEXT = 'The header is kept by the project. Change it from the Staff Room.';
export const UNDO_OWN_TEXT = 'Undo in a shared product removes only your own changes.';
export const RESYNC_LOG_LINE = 'Resynchronized the shared product editor.';
const MISMATCH_TEXT = 'The editor no longer matches the shared product. Close the product and open it again.';
const HEADER_NOTICE_INTERVAL_MS = 500;
const BATCH_MS = 500;
const RESYNC_WINDOW_MS = 60_000;
const MAX_RESYNCS = 5;

class ResyncStopped extends Error {}

const lf = (text: string): string => text.replaceAll('\r\n', '\n');

/** Translate offsets only when queued input and the shared body still differ in line endings. */
function offsetInBody(offset: number, raw: string, body: string): number {
  if (raw === body) return offset;
  let remaining = lf(raw.slice(0, offset)).length;
  let index = 0;
  while (index < body.length && remaining > 0) {
    index += body.startsWith('\r\n', index) ? 2 : 1;
    remaining -= 1;
  }
  return index;
}

/** Consecutive delete and insert operations form one replacement against the old document. */
function editsOf(operations: readonly TextOp[], start: number): DocumentEdit[] {
  const edits: DocumentEdit[] = [];
  let offset = start;
  let replacement: DocumentEdit | undefined;
  for (const operation of operations) {
    if ('retain' in operation) {
      replacement = undefined;
      offset += operation.retain;
      continue;
    }
    if (!replacement) {
      replacement = { offset, length: 0, text: '' };
      edits.push(replacement);
    }
    if ('insert' in operation) {
      replacement.text += operation.insert;
    } else {
      replacement.length += operation.delete;
      offset += operation.delete;
    }
  }
  return edits;
}

interface ExpectedEdit {
  readonly text: string;
  readonly baseVersion: number;
  version?: number;
}

export class EditorBinding {
  private readonly expected: ExpectedEdit[] = [];
  private readonly resyncs: number[] = [];
  private readonly disconnect: () => void;
  private header: string;
  // Captured input may still contain CRLF until the last queued edit is rendered.
  private rawBody: string | undefined;
  private version: number;
  private pending: Promise<void> = Promise.resolve();
  private failure: Error | undefined;
  private closing: Promise<void> | undefined;
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private lastHeaderNotice = -Infinity;
  private headerRepairPending = false;
  private showedUndoNotice = false;

  private constructor(private readonly document: BoundDocument, private readonly product: BoundProduct, private readonly editor: ProductEditor,
    private readonly hooks: BindingHooks) {
    this.header = lf(product.header());
    this.version = document.version;
    const actual = document.getText();
    const canonical = this.header + editor.text();
    if (actual !== canonical && lf(actual) !== canonical) throw new Error(MISMATCH_TEXT);
    this.disconnect = document.onDidChange((change) => {
      if (this.failure) return;
      const index = change.reason === undefined ? this.expected.findIndex((item) => item.text === change.text &&
        (item.version === undefined ? change.version > item.baseVersion : change.version === item.version)) : -1;
      const echo = index < 0 ? undefined : this.expected.splice(index, 1)[0];
      if (echo) {
        echo.version = change.version;
        return;
      }
      void this.enqueue(() => this.applyLocalChange(change)).catch(() => undefined);
    });
  }

  public static async open(document: BoundDocument, product: BoundProduct, hooks: BindingHooks = {}): Promise<EditorBinding> {
    const editor = await ProductEditor.open(product.project, product, hooks);
    let binding: EditorBinding | undefined;
    try {
      if (editor.refusal) throw new Error(editor.refusal.message);
      binding = new EditorBinding(document, product, editor, hooks);
      await binding.normalizeOpenDocument();
      return binding;
    } catch (error) {
      if (binding) await binding.close();
      else editor.close();
      throw error;
    }
  }

  public text(): string { return this.editor.text(); }

  /** Convert a document offset in the body to a product-scoped position. */
  public relativeAt(offset: number): string | undefined {
    if (!Number.isSafeInteger(offset) || !this.positionsReady()) return undefined;
    return this.editor.relativeAt(offset - this.header.length);
  }

  /** Resolve a product position to an offset in the currently rendered document. */
  public indexOf(relative: unknown): number | undefined {
    if (!this.positionsReady()) return undefined;
    const index = this.editor.indexOf(relative);
    return index === undefined ? undefined : this.header.length + index;
  }

  private positionsReady(): boolean {
    return this.failure === undefined && this.closing === undefined && this.rawBody === undefined && this.document.version === this.version;
  }

  public undo(): Promise<boolean> { return this.enqueue(() => this.applyHistory('undo')); }

  public redo(): Promise<boolean> { return this.enqueue(() => this.applyHistory('redo')); }

  /** Writes captured local transactions through the roster-bound editor. */
  public flush(): Promise<{ appended: number; queued: number }> {
    return this.enqueue(() => {
      this.cancelBatchTimer();
      return this.editor.flushBatch();
    }, true);
  }

  /** Reads accepted updates this editor has yet to apply, including those placed earlier by a refold. */
  public async refresh(): Promise<void> {
    const waitingAt = await this.enqueue(() => this.refreshNow());
    if (waitingAt !== undefined) {
      // A local change delivered during the read can run before this retry.
      await this.enqueue(async () => {
        if (this.version !== waitingAt) await this.refreshNow();
      });
    }
  }

  private async refreshNow(): Promise<number | undefined> {
    const feed = await this.editor.unappliedUpdates();
    if (this.document.version !== this.version) return this.version;
    const body = this.editor.text();
    const header = lf(this.product.header());
    if (this.document.getText() !== this.header + body) {
      await this.resync(header + body);
      this.header = header;
    } else if (header !== this.header) {
      await this.applyRemoteEdits([{ offset: 0, length: this.header.length, text: header }], header + body);
      this.header = header;
    }
    for (const update of feed.updates) {
      if (this.document.version !== this.version) return this.version;
      const before = this.header + this.editor.text();
      let edits: DocumentEdit[] = [];
      const remove = this.editor.onRemoteChange((operations) => { edits = editsOf(operations, this.header.length); });
      try {
        this.editor.applyRemote([update]);
      } finally {
        remove();
      }
      if (this.editor.refusal) throw new Error(this.editor.refusal.message);
      const after = this.header + this.editor.text();
      if (after !== before) await this.applyRemoteEdits(edits, after);
    }
    return undefined;
  }

  private async normalizeOpenDocument(): Promise<void> {
    const actual = this.document.getText();
    const canonical = this.header + this.editor.text();
    if (actual !== canonical) {
      await this.enqueue(() => this.applyRemoteEdits([{ offset: 0, length: actual.length, text: canonical }], canonical, 'lf'));
    }
  }

  /** Call flush before closing to save queued updates. */
  public close(): Promise<void> {
    if (!this.closing) {
      this.cancelBatchTimer();
      this.disconnect();
      this.closing = this.pending.then(() => this.editor.close());
    }
    return this.closing;
  }

  private cancelBatchTimer(): void {
    clearTimeout(this.batchTimer);
    this.batchTimer = undefined;
  }

  private scheduleBatch(): void {
    if (this.batchTimer !== undefined || this.closing || this.editor.queued === 0) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined;
      void this.flush().catch(() => undefined);
    }, BATCH_MS);
  }

  private enqueue<T>(task: () => T | Promise<T>, persistCaptured = false): Promise<T> {
    if (this.closing) return Promise.reject(new Error(MISMATCH_TEXT));
    const result = this.pending.then(() => {
      if (this.failure && !(persistCaptured && this.failure instanceof ResyncStopped)) throw this.failure;
      return task();
    });
    this.pending = result.then(() => undefined, (error: unknown) => {
      this.failure ??= error instanceof Error ? error : new Error(MISMATCH_TEXT);
    });
    return result;
  }

  private async applyLocalChange(change: BoundDocumentChange): Promise<void> {
    if (change.version <= this.version) throw new Error(MISMATCH_TEXT);
    if (change.reason !== undefined && !this.headerRepairPending) {
      await this.applyHistory(change.reason, change);
      if (!this.showedUndoNotice) {
        this.showedUndoNotice = true;
        this.hooks.notice?.(UNDO_OWN_TEXT);
      }
      return;
    }
    if (this.headerRepairPending || change.edits.some(({ offset }) => offset < this.header.length)) {
      // A later event in the same burst is based on the edited header. Wait for the latest version to restore it once.
      this.headerRepairPending = this.document.version !== change.version;
      if (this.headerRepairPending) {
        this.version = change.version;
        return;
      }
      this.checkDocument(change.text, change.version);
      await this.restoreCanonicalText(change.text, change.version);
      const now = Date.now();
      if (now - this.lastHeaderNotice >= HEADER_NOTICE_INTERVAL_MS) {
        this.lastHeaderNotice = now;
        this.hooks.notice?.(HEADER_KEPT_TEXT);
      }
      return;
    }
    const body = this.editor.text();
    const raw = this.rawBody ?? body;
    let rawNext = raw;
    let next = body;
    let end = raw.length;
    const edits = [...change.edits].sort((a, b) => b.offset - a.offset).map(({ offset, length, text }) => {
      const index = offset - this.header.length;
      if (!Number.isSafeInteger(index) || !Number.isSafeInteger(length) || index < 0 || length < 0 || index + length > end) {
        throw new Error(MISMATCH_TEXT);
      }
      rawNext = rawNext.slice(0, index) + text + rawNext.slice(index + length);
      end = index;
      const startInBody = offsetInBody(index, raw, body);
      const endInBody = offsetInBody(index + length, raw, body);
      const normalized = lf(text);
      next = next.slice(0, startInBody) + normalized + next.slice(endInBody);
      return { offset: startInBody, length: endInBody - startInBody, text: normalized };
    });
    if (this.header + rawNext !== change.text || (rawNext !== next && lf(rawNext) !== lf(next))) throw new Error(MISMATCH_TEXT);
    this.editor.edit(edits);
    this.version = change.version;
    this.rawBody = rawNext === next ? undefined : rawNext;
    if (this.rawBody !== undefined && this.document.version === this.version) {
      await this.restoreCanonicalText(change.text, change.version);
    }
    this.scheduleBatch();
  }

  private checkDocument(text: string, version: number): void {
    if (this.document.version !== version || this.document.getText() !== text) {
      throw new Error(MISMATCH_TEXT);
    }
  }

  private async applyHistory(direction: 'undo' | 'redo', native?: BoundDocumentChange): Promise<boolean> {
    const before = native?.text ?? this.header + this.editor.text();
    const version = native?.version ?? this.version;
    this.checkDocument(before, version);
    // Native editor history may include a programmatic remote edit. Discard its delta and publish only the local Yjs history transaction.
    const changed = this.editor[direction]();
    await this.restoreCanonicalText(before, version);
    if (changed) this.scheduleBatch();
    return changed;
  }

  private async restoreCanonicalText(current: string, version: number): Promise<void> {
    this.version = version;
    this.rawBody = undefined;
    const canonical = this.header + this.editor.text();
    if (current === canonical) return;
    const offset = current.startsWith(this.header) ? this.header.length : 0;
    await this.applyRemoteEdits([{ offset, length: current.length - offset, text: canonical.slice(offset) }], canonical);
  }

  private async applyRemoteEdits(edits: readonly DocumentEdit[], text: string, lineEndings?: 'lf'): Promise<void> {
    const version = this.version;
    if (edits.length > 0 && await this.tryApplyEdits(edits, text, lineEndings)) return;
    // A dropped write is safe to repair only while no concurrent user edit has advanced the version.
    if (this.document.version !== version) this.stopResync();
    await this.resync(text, lineEndings);
  }

  private async resync(text: string, lineEndings?: 'lf'): Promise<void> {
    const actual = this.document.getText();
    if (actual === text) return;
    const now = performance.now();
    while (this.resyncs.length > 0 && this.resyncs[0] <= now - RESYNC_WINDOW_MS) this.resyncs.shift();
    if (this.resyncs.length >= MAX_RESYNCS) this.stopResync();
    this.resyncs.push(now);
    const offset = actual.startsWith(this.header) && text.startsWith(this.header) ? this.header.length : 0;
    const applied = await this.tryApplyEdits([{ offset, length: actual.length - offset, text: text.slice(offset) }], text, lineEndings);
    if (!applied) this.stopResync();
    this.hooks.log?.(RESYNC_LOG_LINE);
  }

  private stopResync(): never {
    this.hooks.notice?.(MISMATCH_TEXT);
    throw new ResyncStopped(MISMATCH_TEXT);
  }

  private async tryApplyEdits(edits: readonly DocumentEdit[], text: string, lineEndings?: 'lf'): Promise<boolean> {
    const expected: ExpectedEdit = { text, baseVersion: this.version };
    this.expected.push(expected);
    const applied = await this.document.applyEdits(edits, text, this.version, lineEndings);
    // An event may arrive before or after the apply promise. If it has not
    // arrived yet, capture the version it should report for this exact text.
    if (expected.version === undefined && this.document.getText() === text) expected.version = this.document.version;
    if (!applied || expected.version === undefined || expected.version <= expected.baseVersion) {
      const index = this.expected.indexOf(expected);
      if (index >= 0) this.expected.splice(index, 1);
      return false;
    }
    this.version = expected.version;
    return true;
  }
}
