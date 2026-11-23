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

const MISMATCH_TEXT = 'The editor no longer matches the shared product. Close the product and open it again.';

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

  private constructor(private readonly document: BoundDocument, private readonly product: BoundProduct, private readonly editor: ProductEditor) {
    this.header = product.header();
    this.version = document.version;
    if (document.getText() !== this.header + editor.text()) throw new Error(MISMATCH_TEXT);
    this.disconnect = document.onDidChange((change) => {
      const index = this.expected.findIndex((item) => item.text === change.text &&
        (item.version === undefined ? change.version > item.baseVersion : change.version === item.version));
      const echo = index < 0 ? undefined : this.expected.splice(index, 1)[0];
      if (echo) {
        echo.version = change.version;
        return;
      }
      void this.enqueue(() => this.applyLocalChange(change)).catch(() => undefined);
    });
  }

  public static async open(document: BoundDocument, product: BoundProduct, hooks?: EditorHooks): Promise<EditorBinding> {
    const editor = await ProductEditor.open(product.project, product, hooks);
    try {
      if (editor.refusal) throw new Error(editor.refusal.message);
      return new EditorBinding(document, product, editor);
    } catch (error) {
      editor.close();
      throw error;
    }
  }

  public text(): string { return this.editor.text(); }

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

  private applyLocalChange(change: BoundDocumentChange): void {
    if (change.version <= this.version || change.reason !== undefined || this.product.header() !== this.header) throw new Error(MISMATCH_TEXT);
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
