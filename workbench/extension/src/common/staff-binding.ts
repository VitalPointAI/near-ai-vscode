/**
 * The document channel of the editor binding (Phase 33 D-52 to D-55; RESEARCH N3 to N5). A product of an open shared project, opened in a Theia
 * editor, is bound: the executed binding core (33-04) runs in the backend over a mirror of the browser's model, and the two talk over this channel.
 *
 *   attach     the tab asks whether a model is a product; the answer binds it, sets it read-only (another tab edits it), or gives the text to start from
 *   changed    each local change of the model: its edits, the model's version and the SHA-256 of its text (never the whole text)
 *   apply      the backend asks the tab to apply other people's changes at a version; the tab answers applied, true only at that exact version
 *   fullText   asked once when the backend's mirror no longer matches the hash; the binding core then resynchronizes the model
 *   undo, redo the binding's own history, so only this person's changes are undone (D-54)
 *
 * Methods of the client whose names start with `on` are notifications (Theia's RPC sends them without waiting). A client is told its id first
 * (onHello), and passes it back with attach, so the backend knows which tab a document belongs to; a new id means the connection came back. Nothing
 * here imports Theia, so the backend, the browser and the tests share it.
 */

export const STAFF_BINDING_PATH = '/services/sterling-staff-binding';
export const StaffBindingServer = Symbol('StaffBindingServer');

/** One replacement: `length` characters at `offset` become `text`. Offsets are into the text before the change. */
export interface BindingEdit {
  readonly offset: number;
  readonly length: number;
  readonly text: string;
}

export type BindingReason = 'undo' | 'redo';

/** The answer to attach. */
export type AttachAnswer =
  /** Not a product of an open shared project: the model is left alone. */
  | { readonly kind: 'not-shared' }
  /** Bound: `doc` names this binding on the channel. */
  | { readonly kind: 'bound'; readonly doc: string }
  /** Another tab of this session edits the product: the model is read-only until onReadOnly(doc, false), then attaches again. */
  | { readonly kind: 'read-only'; readonly doc: string; readonly message: string }
  /** The model's text is not the shared text: the tab puts `text` in the model (no undo stop) and attaches again. */
  | { readonly kind: 'reset'; readonly text: string };

/** What each connected tab answers (notifications only). */
export interface StaffBindingClient {
  /** This tab's id on the channel; a second hello means the connection came back, so the tab attaches its models again. */
  onHello(client: string): void;
  /** Apply other people's changes at `baseVersion` only, then answer applied. */
  onApplyEdits(doc: string, request: number, edits: readonly BindingEdit[], baseVersion: number, lineEndings?: 'lf'): void;
  /** Send the model's whole text once (the mirror no longer matches). */
  onRequestFullText(doc: string): void;
  /** Read-only with a sentence, or editable again (the tab then attaches again). */
  onReadOnly(doc: string, readOnly: boolean, message?: string): void;
  /** A sentence for the person (the header is kept, the editor stopped matching). */
  onNotice(doc: string, text: string): void;
}

export interface StaffBindingServer {
  attach(client: string, uri: string, text: string, version: number): Promise<AttachAnswer>;
  changed(doc: string, edits: readonly BindingEdit[], version: number, hash: string, reason?: BindingReason): Promise<void>;
  applied(doc: string, request: number, ok: boolean, version: number, hash: string): Promise<void>;
  fullText(doc: string, text: string, version: number): Promise<void>;
  /** The model's version moved without a change to the shared text (a disk change put back): the mirror follows if the hash matches. */
  synced(doc: string, version: number, hash: string): Promise<void>;
  undo(doc: string): Promise<boolean>;
  redo(doc: string): Promise<boolean>;
  /** Writes the captured changes before a save (D-17). */
  flush(doc: string): Promise<void>;
  detach(doc: string): Promise<void>;
}

/** The context key set while a bound editor has focus. */
export const BOUND_EDITOR_CONTEXT = 'sterlingStaffBoundEditor';

export const OTHER_TAB_TEXT = 'This product is open for editing in another tab of your session.';

export const STAFF_BINDING_TEXT = {
  otherTab: OTHER_TAB_TEXT,
  diskChanged: 'This product changed on disk outside the shared editor. Keep the change as your edit, or put the shared text back?',
  take: 'Take This Change as My Edit',
  restore: 'Restore',
  unsent: 'Changes you made while the connection to your session was lost were not shared. Keep them as your edit, or put the shared text back?',
} as const;

/** The SHA-256 of a text as lowercase hex, the same in the browser and the backend (Web Crypto). */
export async function textHash(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Applies edits whose offsets are all into `text` (right to left). */
export function applyBindingEdits(text: string, edits: readonly BindingEdit[]): string {
  let out = text;
  for (const { offset, length, text: insert } of [...edits].sort((a, b) => b.offset - a.offset)) out = out.slice(0, offset) + insert + out.slice(offset + length);
  return out;
}

/** The one replacement that turns `before` into `after`, between their common start and common end (so a header both share is never touched). */
export function diffEdit(before: string, after: string): BindingEdit {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end += 1;
  return { offset: start, length: before.length - start - end, text: after.slice(start, after.length - end) };
}
