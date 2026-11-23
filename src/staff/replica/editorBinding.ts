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
  /** Apply against baseVersion only. An applied edit emits one change event with the new text. */
  applyEdits(edits: readonly DocumentEdit[], expectedText: string, baseVersion: number): Promise<boolean>;
  onDidChange(listener: (change: BoundDocumentChange) => void): () => void;
}

export interface BoundProduct extends EditTarget {
  readonly project: EditorProject;
  header(): string;
}

export interface BindingHooks extends EditorHooks {
  notice?(text: string): void;
}

export const HEADER_KEPT_TEXT = 'The header is kept by the project. Change it from the Staff Room.';
export const UNDO_OWN_TEXT = 'Undo in a shared product removes only your own changes.';
const MISMATCH_TEXT = 'The editor no longer matches the shared product. Close the product and open it again.';
const HEADER_NOTICE_INTERVAL_MS = 500;

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
  private readonly disconnect: () => void;
  private readonly header: string;
  private version: number;
  private pending: Promise<void> = Promise.resolve();
  private failure: Error | undefined;
  private closing: Promise<void> | undefined;
  private lastHeaderNotice = -Infinity;
  private showedUndoNotice = false;

  private constructor(private readonly document: BoundDocument, private readonly product: BoundProduct, private readonly editor: ProductEditor,
    private readonly hooks: BindingHooks) {
    this.header = product.header();
    this.version = document.version;
    if (document.getText() !== this.header + editor.text()) throw new Error(MISMATCH_TEXT);
    this.disconnect = document.onDidChange((change) => {
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
    try {
      if (editor.refusal) throw new Error(editor.refusal.message);
      return new EditorBinding(document, product, editor, hooks);
    } catch (error) {
      editor.close();
      throw error;
    }
  }

  public text(): string { return this.editor.text(); }

  public undo(): Promise<boolean> { return this.enqueue(() => this.applyHistory('undo')); }

  public redo(): Promise<boolean> { return this.enqueue(() => this.applyHistory('redo')); }

  /** Writes captured local transactions through the roster-bound editor. */
  public flush(): Promise<{ appended: number; queued: number }> {
    return this.enqueue(() => this.editor.flush());
  }

  /** Reads accepted updates this editor has yet to apply, including those placed earlier by a refold. */
  public refresh(): Promise<void> {
    return this.enqueue(async () => {
      const feed = await this.editor.unappliedUpdates();
      for (const update of feed.updates) {
        // A local notification queued during a read is processed before a later refresh.
        if (this.document.version !== this.version) return;
        const before = this.header + this.editor.text();
        if (this.product.header() !== this.header || this.document.getText() !== before) throw new Error(MISMATCH_TEXT);
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
    });
  }

  /** Call flush before closing to save queued updates. */
  public close(): Promise<void> {
    if (!this.closing) {
      this.disconnect();
      this.closing = this.pending.then(() => this.editor.close());
    }
    return this.closing;
  }

  private enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error(MISMATCH_TEXT));
    const result = this.pending.then(() => {
      if (this.failure) throw this.failure;
      return task();
    });
    this.pending = result.then(() => undefined, (error: unknown) => {
      this.failure = error instanceof Error ? error : new Error(MISMATCH_TEXT);
    });
    return result;
  }

  private async applyLocalChange(change: BoundDocumentChange): Promise<void> {
    if (change.version <= this.version || this.product.header() !== this.header) throw new Error(MISMATCH_TEXT);
    if (change.reason !== undefined) {
      await this.applyHistory(change.reason, change);
      if (!this.showedUndoNotice) {
        this.showedUndoNotice = true;
        this.hooks.notice?.(UNDO_OWN_TEXT);
      }
      return;
    }
    if (change.edits.some(({ offset }) => offset < this.header.length)) {
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
    let next = body;
    let end = body.length;
    const edits = [...change.edits].sort((a, b) => b.offset - a.offset).map(({ offset, length, text }) => {
      const index = offset - this.header.length;
      if (!Number.isSafeInteger(index) || !Number.isSafeInteger(length) || index < 0 || length < 0 || index + length > end) {
        throw new Error(MISMATCH_TEXT);
      }
      next = next.slice(0, index) + text + next.slice(index + length);
      end = index;
      return { offset: index, length, text };
    });
    if (this.header + next !== change.text) throw new Error(MISMATCH_TEXT);
    this.editor.edit(edits);
    this.version = change.version;
  }

  private checkDocument(text: string, version: number): void {
    if (this.product.header() !== this.header || this.document.version !== version || this.document.getText() !== text) {
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
    return changed;
  }

  private async restoreCanonicalText(current: string, version: number): Promise<void> {
    this.version = version;
    const canonical = this.header + this.editor.text();
    if (current === canonical) return;
    const offset = current.startsWith(this.header) ? this.header.length : 0;
    await this.applyRemoteEdits([{ offset, length: current.length - offset, text: canonical.slice(offset) }], canonical);
  }

  private async applyRemoteEdits(edits: readonly DocumentEdit[], text: string): Promise<void> {
    if (edits.length === 0) throw new Error(MISMATCH_TEXT);
    const expected: ExpectedEdit = { text, baseVersion: this.version };
    this.expected.push(expected);
    const applied = await this.document.applyEdits(edits, text, this.version);
    if (!applied) throw new Error(MISMATCH_TEXT);
    // An event may arrive before or after the apply promise. If it has not
    // arrived yet, capture the version it should report for this exact text.
    if (expected.version === undefined && this.document.getText() === text) expected.version = this.document.version;
    if (expected.version === undefined || expected.version <= expected.baseVersion) throw new Error(MISMATCH_TEXT);
    this.version = expected.version;
  }
}
