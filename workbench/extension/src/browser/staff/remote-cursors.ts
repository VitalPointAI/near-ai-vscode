/**
 * Other people's cursors in a bound product (Phase 33 D-18, D-56; RESEARCH N2, N6; T-33-N3). The session backend turns each person's presence (Yjs
 * relative positions) into offsets in this tab's text and sends them with onPresence; this draws them with Monaco's deltaDecorations on the editor:
 *
 *   colour     one of CURSOR_SLOT_COUNT fixed classes (staff-cursors.css, theme tokens), picked from the member id, never from the name
 *   caret      beforeContentClassName at the head, as y-monaco draws it
 *   selection  className over the selected text
 *   name       the name and position word as plain text: the hover (markdown with every punctuation character escaped, no HTML, no icons, not
 *              trusted) and a label after the caret (Monaco injected text, which Monaco renders as text). A name never goes into a class or a style.
 *
 * Theia 1.77's Monaco (@theia/monaco-editor-core 1.108) has injected text (IModelDecorationOptions.after), so the label is kept (RESEARCH N6).
 * This tab's own selection goes to the backend as offsets; the backend sends it on at most 10 times a second and stores nothing. The Staff Room's
 * people list is the accessible text of who is here. Nothing here imports Monaco: the part file adapts the editor.
 */
import { inject, injectable } from '@theia/core/shared/inversify';
import { StaffBindingServer, type RemoteCursor } from '../../common/staff-binding.js';
import { StaffBindingContribution, StaffBindingEvents, StaffEditorSource, type SourceEditor } from './binding-contribution.js';
import type { ModelRange } from './monaco-bound-document.js';

export const CURSOR_SLOT_COUNT = 8;

/** Monaco's IMarkdownString, as plain text. */
export interface PlainMarkdown {
  readonly value: string;
  readonly isTrusted: false;
  readonly supportHtml: false;
  readonly supportThemeIcons: false;
}

/** The members of Monaco's IModelDecorationOptions these decorations use. */
export interface DecorationOptions {
  readonly description: string;
  readonly className?: string;
  readonly beforeContentClassName?: string;
  readonly afterContentClassName?: string;
  readonly linesDecorationsClassName?: string;
  readonly linesDecorationsTooltip?: string;
  readonly hoverMessage?: PlainMarkdown;
  readonly after?: { readonly content: string; readonly inlineClassName: string };
  readonly showIfCollapsed?: boolean;
  /** Monaco's TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges (1). */
  readonly stickiness?: 1;
}

export interface Decoration {
  readonly range: ModelRange;
  readonly options: DecorationOptions;
}

/** Monaco's ICodeEditor.deltaDecorations. */
export interface DecorationTarget {
  deltaDecorations(oldIds: string[], next: Decoration[]): string[];
}

/** The model's offsets as positions (ITextModel.getPositionAt). */
export interface PositionModel {
  getPositionAt(offset: number): { lineNumber: number; column: number };
}

/** A colour slot from the member id (FNV-1a), the same for a person in every tab. */
export function cursorSlot(member: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < member.length; index += 1) {
    hash ^= member.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % CURSOR_SLOT_COUNT;
}

/** A text as markdown that renders exactly that text: every ASCII punctuation character escaped (CommonMark), no HTML, no icons, not trusted. */
export function plainMarkdown(text: string): PlainMarkdown {
  const value = text.replace(/\r?\n/g, ' ').replace(/[!-/:-@[-`{-~]/g, (character) => `\\${character}`);
  return { value, isTrusted: false, supportHtml: false, supportThemeIcons: false };
}

/** A label for a Theia or Monaco list, where `$(name)` would draw an icon: the icon syntax is escaped (as VS Code's escapeIcons). */
export function escapeIcons(text: string): string {
  return text.replaceAll('$(', '\\$(');
}

/** The name and position word of a cursor, as the hover and the label show it. */
export function cursorLabel(cursor: Pick<RemoteCursor, 'name' | 'position'>): string {
  return cursor.position === undefined || cursor.position === '' ? cursor.name : `${cursor.name}, ${cursor.position}`;
}

/** A model range between two offsets. */
export function rangeAt(model: PositionModel, start: number, end: number): ModelRange {
  const from = model.getPositionAt(Math.min(start, end));
  const to = model.getPositionAt(Math.max(start, end));
  return { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column };
}

/** The cursors of other people in one editor. */
export class RemoteCursors {
  private ids: string[] = [];

  constructor(private readonly model: PositionModel, private readonly target: DecorationTarget) {}

  /** Shows exactly these cursors; an empty list removes every one. */
  show(cursors: readonly RemoteCursor[]): void {
    const next: Decoration[] = [];
    for (const cursor of cursors) {
      const slot = `sterling-cursor-slot-${cursorSlot(cursor.member)}`;
      const label = cursorLabel(cursor);
      const hoverMessage = plainMarkdown(label);
      if (cursor.anchor !== cursor.head) {
        next.push({
          range: rangeAt(this.model, cursor.anchor, cursor.head),
          options: { description: 'sterling-remote-selection', className: `sterling-cursor-selection ${slot}`, hoverMessage, stickiness: 1 },
        });
      }
      next.push({
        range: rangeAt(this.model, cursor.head, cursor.head),
        options: {
          description: 'sterling-remote-cursor', beforeContentClassName: `sterling-cursor-caret ${slot}`, hoverMessage, showIfCollapsed: true, stickiness: 1,
          after: { content: label, inlineClassName: `sterling-cursor-label ${slot}` },
        },
      });
    }
    this.ids = this.target.deltaDecorations(this.ids, next);
  }

  clear(): void {
    this.show([]);
  }
}

/**
 * The cursors of every bound editor of this tab, and this tab's selections to the backend. Started with the binding (FrontendApplicationContribution
 * in the part file).
 */
@injectable()
export class StaffRemoteCursors {
  @inject(StaffBindingServer) protected readonly server!: StaffBindingServer;
  @inject(StaffBindingEvents) protected readonly events!: StaffBindingEvents;
  @inject(StaffEditorSource) protected readonly editors!: StaffEditorSource;
  @inject(StaffBindingContribution) protected readonly binding!: StaffBindingContribution;

  private readonly drawn = new WeakMap<SourceEditor, RemoteCursors>();
  private readonly latest = new Map<string, readonly RemoteCursor[]>();
  private started = false;

  onStart(): void {
    if (this.started) return;
    this.started = true;
    this.events.onDidPresence(({ doc, cursors }) => this.draw(doc, cursors));
    this.editors.onCreated((editor) => this.track(editor));
    for (const editor of this.editors.all()) this.track(editor);
  }

  private track(editor: SourceEditor): void {
    editor.onSelection?.((anchor, head) => {
      const entry = this.binding.bindings().find((item) => item.state === 'bound' && item.doc !== undefined && item.editors.has(editor));
      if (entry?.doc !== undefined) void this.server.selection(entry.doc, anchor, head).catch(() => undefined);
    });
    // An editor opened on a model that already has cursors shows them.
    const entry = this.binding.bindings().find((item) => item.editors.has(editor));
    const cursors = entry?.doc === undefined ? undefined : this.latest.get(entry.doc);
    if (cursors !== undefined) this.cursorsOf(editor)?.show(cursors);
  }

  private draw(doc: string, cursors: readonly RemoteCursor[]): void {
    if (cursors.length === 0) this.latest.delete(doc);
    else this.latest.set(doc, cursors);
    const entry = this.binding.bindings().find((item) => item.doc === doc);
    for (const editor of entry?.editors ?? []) this.cursorsOf(editor)?.show(cursors);
  }

  private cursorsOf(editor: SourceEditor): RemoteCursors | undefined {
    if (editor.decorations === undefined) return undefined;
    let cursors = this.drawn.get(editor);
    if (cursors === undefined) {
      cursors = new RemoteCursors(editor.model.textModel, editor.decorations);
      this.drawn.set(editor, cursors);
    }
    return cursors;
  }
}
