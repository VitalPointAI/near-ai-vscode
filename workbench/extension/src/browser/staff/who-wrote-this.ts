/**
 * Show Who Wrote This in a bound Sterling editor (Phase 33 D-18, D-56; the attribution half of superseded 33-19). The command toggles gutter marks
 * (linesDecorationsClassName) per author on the focused bound editor. The session backend labels the rows with the executed whoWroteThis.ts words
 * (the person, or "{agent job} agent, run {n}, on {person}'s computer"), from the signed client registrations, so text a session key wrote reads
 * as the person its certificate names (D-62).
 *
 * Colour is never the only carrier: each mark has the label as its gutter tooltip and its hover, and the command lists every author with their
 * share of the text. Labels are plain text everywhere: the hover escapes markdown and allows no HTML or icons, and the list escapes icon syntax,
 * so a person's label never renders as an icon (as the fixed extension path, CodeQL 75). The marks go when the text changes, when the command is
 * run again, or when another product is shown. The command is enabled only while a bound editor has focus.
 */
import { inject, injectable } from '@theia/core/shared/inversify';
import type { CommandContribution, CommandRegistry } from '@theia/core/lib/common/command.js';
import { MessageService } from '@theia/core/lib/common/message-service.js';
import { STAFF_BINDING_TEXT, StaffBindingServer, WHO_WROTE_THIS_COMMAND, type AttributionRow } from '../../common/staff-binding.js';
import { StaffBindingContribution, type BoundModel, type SourceEditor } from './binding-contribution.js';
import { CURSOR_SLOT_COUNT, escapeIcons, plainMarkdown, rangeAt, type Decoration } from './remote-cursors.js';

/** One author in the list the command shows. */
export interface PickerRow {
  readonly label: string;
  readonly description: string;
}

/** Shows the list of authors (the part file adapts Theia's QuickInputService). */
export interface WhoWroteThisPicker {
  show(title: string, rows: PickerRow[]): Promise<void>;
}
export const WhoWroteThisPicker = Symbol('WhoWroteThisPicker');

interface Showing {
  readonly entry: BoundModel;
  readonly ids: Map<SourceEditor, string[]>;
  readonly listener: { dispose(): void };
}

/** The marks of one author row. */
export function attributionDecorations(model: Parameters<typeof rangeAt>[0], rows: readonly AttributionRow[]): Decoration[] {
  return rows.flatMap((row, index) => {
    const look = row.unverified ? 'sterling-wwt-unverified' : `sterling-wwt-slot-${index % CURSOR_SLOT_COUNT}`;
    return row.ranges.map(({ offset, length }) => ({
      range: rangeAt(model, offset, offset + length),
      options: {
        description: 'sterling-who-wrote-this', linesDecorationsClassName: `sterling-wwt ${look}`, linesDecorationsTooltip: row.label,
        hoverMessage: plainMarkdown(row.label), stickiness: 1 as const,
      },
    }));
  });
}

@injectable()
export class StaffWhoWroteThis implements CommandContribution {
  @inject(StaffBindingServer) protected readonly server!: StaffBindingServer;
  @inject(StaffBindingContribution) protected readonly binding!: StaffBindingContribution;
  @inject(MessageService) protected readonly messages!: MessageService;
  @inject(WhoWroteThisPicker) protected readonly picker!: WhoWroteThisPicker;

  private showing: Showing | undefined;

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand({ id: WHO_WROTE_THIS_COMMAND, label: STAFF_BINDING_TEXT.whoWroteThis }, {
      isEnabled: () => this.isEnabled(),
      execute: () => this.toggle(),
    });
  }

  /** Only a bound editor with focus. */
  isEnabled(): boolean {
    return this.binding.focusedBound() !== undefined;
  }

  /** Shows the marks on the focused bound editor, or removes them when they are showing there. */
  async toggle(): Promise<void> {
    const entry = this.binding.focusedBound();
    const wasShowing = entry !== undefined && this.showing?.entry === entry;
    this.clear();
    if (entry?.doc === undefined || wasShowing) return;
    const answer = await this.server.attribution(entry.doc);
    if (answer.kind === 'none') {
      void this.messages.info(answer.message);
      return;
    }
    // Focus moved to another editor while the backend answered: nothing is drawn where the person no longer looks.
    if (this.binding.focusedBound() !== entry) return;
    const decorations = attributionDecorations(entry.model.textModel, answer.rows);
    const ids = new Map<SourceEditor, string[]>();
    for (const editor of entry.editors) if (editor.decorations !== undefined) ids.set(editor, editor.decorations.deltaDecorations([], decorations));
    const listener = entry.model.textModel.onDidChangeContent(() => this.clear());
    this.showing = { entry, ids, listener };
    await this.picker.show(STAFF_BINDING_TEXT.whoWroteThisTitle, answer.rows.map((row) => ({
      label: escapeIcons(row.label),
      description: STAFF_BINDING_TEXT.ofText(Number((row.share * 100).toFixed(1))),
    })));
  }

  /** Removes every mark. */
  clear(): void {
    const showing = this.showing;
    this.showing = undefined;
    if (showing === undefined) return;
    showing.listener.dispose();
    for (const [editor, ids] of showing.ids) editor.decorations?.deltaDecorations(ids, []);
  }
}
