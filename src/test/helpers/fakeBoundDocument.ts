import type { BoundDocument, BoundDocumentChange, DocumentEdit } from '../../staff/replica/editorBinding';

export class FakeBoundDocument implements BoundDocument {
  private readonly listeners = new Set<(change: BoundDocumentChange) => void>();
  private readonly heldEvents: BoundDocumentChange[] = [];
  private revision = 1;
  public applied = 0;
  public lastAppliedEdits: readonly DocumentEdit[] = [];
  public deferAppliedEvents = false;
  public dropNextApply = false;

  public constructor(private text: string) {}

  public get version(): number { return this.revision; }
  public getText(): string { return this.text; }

  public onDidChange(listener: (change: BoundDocumentChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  public type(...edits: DocumentEdit[]): void {
    this.changed(edits, false);
  }

  public nativeHistory(reason: 'undo' | 'redo', ...edits: DocumentEdit[]): void {
    this.changed(edits, false, reason);
  }

  public async applyEdits(edits: readonly DocumentEdit[], expectedText: string, baseVersion: number): Promise<boolean> {
    if (this.version !== baseVersion) return false;
    if (this.dropNextApply) {
      this.dropNextApply = false;
      return false;
    }
    this.applied += 1;
    this.lastAppliedEdits = edits;
    this.changed(edits, this.deferAppliedEvents);
    return this.text === expectedText;
  }

  public deliverAppliedEvents(newestFirst = false): number {
    const events = this.heldEvents.splice(0);
    if (newestFirst) events.reverse();
    for (const event of events) this.emit(event);
    return events.length;
  }

  private changed(edits: readonly DocumentEdit[], defer: boolean, reason?: 'undo' | 'redo'): void {
    for (const { offset, length, text } of [...edits].sort((a, b) => b.offset - a.offset)) {
      this.text = this.text.slice(0, offset) + text + this.text.slice(offset + length);
    }
    this.revision += 1;
    const event = { edits, version: this.revision, text: this.text, reason };
    if (defer) this.heldEvents.push(event);
    else this.emit(event);
  }

  private emit(event: BoundDocumentChange): void {
    for (const listener of this.listeners) listener(event);
  }
}
