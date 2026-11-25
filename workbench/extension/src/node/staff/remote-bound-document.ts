/**
 * The backend's mirror of one bound browser model (Phase 33 D-53, RESEARCH N5, Pitfall N8.2): a BoundDocument the binding core (33-04) edits
 * unchanged. The browser sends each change as edits, its model version and the SHA-256 of its text; the mirror applies the edits to its copy and
 * checks the hash. On a mismatch it asks for the whole text once, adopts it, and lets the core resynchronize the model (its one log line).
 *
 * Versions. The core sees the mirror's own version, one step per change it was told of; the browser's model version is kept beside it and is
 * the version an apply request names. So adopting the browser's text, or a browser version that moved with no change to the shared text, never
 * looks like a change to the core.
 *
 * Other people's changes cross the channel, so the person may type while they travel. The browser applies them only at the exact version they
 * name (never at another), and answers false otherwise. The mirror then holds the person's changes that arrived meanwhile, moves the request past
 * them and asks again. Once it is applied, the core is told in its own order: first the request, as the echo it waits for, then the person's
 * changes moved past it, so it records them as this person's edits at the right places. A rare overlap the two moves do not agree on shows as a
 * hash mismatch, and the whole-text path repairs it.
 */
import { createHash } from 'node:crypto';
import type { BindingEdit, BindingReason } from '../../common/staff-binding.js';
import { applyBindingEdits } from '../../common/staff-binding.js';
import type { EngineBoundDocument, EngineDocumentChange } from './staff-engine.js';

/** How often a request is moved past the person's typing before the mirror gives up and lets the core decide. */
export const MAX_APPLY_ATTEMPTS = 5;

/** The browser end of one bound model, as the mirror talks to it. */
export interface MirrorChannel {
  applyEdits(request: number, edits: readonly BindingEdit[], baseVersion: number, lineEndings?: 'lf'): void;
  requestFullText(): void;
}

export interface MirrorHooks {
  /** The browser's whole text was adopted: the binding core should resynchronize the model now. */
  onAdopted?(): void;
  /** One short line; never text. */
  log?(line: string): void;
}

interface HeldChange {
  readonly edits: readonly BindingEdit[];
  readonly reason?: BindingReason;
}

interface Pending {
  readonly request: number;
  readonly edits: readonly BindingEdit[];
  readonly expectedText: string;
  readonly lineEndings?: 'lf';
  /** The request as last sent, moved past every change held before that send. */
  current: readonly BindingEdit[];
  /** The person's changes since the request was first sent, in order, against the mirror's text. */
  readonly held: HeldChange[];
  /** How many of `held` the last send already moved past. */
  movedPast: number;
  attempts: number;
  readonly resolve: (applied: boolean) => void;
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Where `position` lands after `edits` (all into the same text). A position inside a replaced range lands at its start. At an insertion at
 * exactly `position`, 'before' keeps it before the inserted text and 'after' moves it past.
 */
function mapPosition(position: number, edits: readonly BindingEdit[], side: 'before' | 'after'): number {
  let delta = 0;
  for (const edit of [...edits].sort((a, b) => a.offset - b.offset)) {
    const end = edit.offset + edit.length;
    if (position < edit.offset || (position === edit.offset && (edit.length > 0 || side === 'before'))) break;
    if (position < end) return edit.offset + delta;
    delta += edit.text.length - edit.length;
  }
  return position + delta;
}

/** `edits` moved past `over` (both into the same text): the same replacements, into the text after `over`. */
export function moveEdits(edits: readonly BindingEdit[], over: readonly BindingEdit[], side: 'before' | 'after'): BindingEdit[] {
  return edits.map((edit) => {
    const start = mapPosition(edit.offset, over, side);
    const end = edit.length === 0 ? start : Math.max(start, mapPosition(edit.offset + edit.length, over, 'before'));
    return { offset: start, length: end - start, text: edit.text };
  });
}

export class RemoteBoundDocument implements EngineBoundDocument {
  private readonly listeners = new Set<(change: EngineDocumentChange) => void>();
  private text: string;
  private ownVersion = 1;
  private browserVersion: number;
  private pending: Pending | undefined;
  private nextRequest = 1;
  private awaitingText = false;
  private closed = false;

  constructor(text: string, browserVersion: number, private readonly channel: MirrorChannel, private readonly hooks: MirrorHooks = {}) {
    this.text = text;
    this.browserVersion = browserVersion;
  }

  public get version(): number {
    return this.ownVersion;
  }

  public getText(): string {
    return this.text;
  }

  public onDidChange(listener: (change: EngineDocumentChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** The core's request: applied in the browser at the browser version this mirror stands for, never at another. */
  public applyEdits(edits: readonly BindingEdit[], expectedText: string, baseVersion: number, lineEndings?: 'lf'): Promise<boolean> {
    if (this.closed || this.awaitingText || this.pending !== undefined || baseVersion !== this.ownVersion) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const request = this.nextRequest++;
      this.pending = { request, edits, expectedText, ...(lineEndings === undefined ? {} : { lineEndings }), current: edits, held: [], movedPast: 0, attempts: 1, resolve };
      this.channel.applyEdits(request, edits, this.browserVersion, lineEndings);
    });
  }

  /** A change the person made in the browser. */
  public browserChanged(edits: readonly BindingEdit[], version: number, hash: string, reason?: BindingReason): void {
    if (this.closed || this.awaitingText) return;
    this.browserVersion = version;
    if (this.pending !== undefined) {
      this.pending.held.push({ edits, ...(reason === undefined ? {} : { reason }) });
      return;
    }
    const next = applyBindingEdits(this.text, edits);
    if (sha256(next) !== hash) {
      this.askForText();
      return;
    }
    this.emit(edits, next, reason);
  }

  /** The browser's answer to a request. */
  public browserApplied(request: number, ok: boolean, version: number, hash: string): void {
    const pending = this.pending;
    if (this.closed || pending === undefined || pending.request !== request) return;
    this.browserVersion = version;
    if (!ok) {
      if (pending.attempts >= MAX_APPLY_ATTEMPTS) {
        this.finish(false);
        return;
      }
      // Move the request past the changes that beat it, then ask again at the browser's version now.
      for (const change of pending.held.slice(pending.movedPast)) pending.current = moveEdits(pending.current, change.edits, 'before');
      pending.movedPast = pending.held.length;
      pending.attempts += 1;
      this.channel.applyEdits(request, pending.current, this.browserVersion, pending.lineEndings);
      return;
    }
    this.finish(true, hash);
  }

  /** The whole text, as asked: adopted without a change event, then the core resynchronizes. */
  public browserText(text: string, version: number): void {
    if (this.closed || !this.awaitingText) return;
    this.awaitingText = false;
    this.text = text;
    this.browserVersion = version;
    this.hooks.onAdopted?.();
  }

  /** The browser's version moved with no change to the text this mirror holds (a disk change put back). */
  public browserSynced(version: number, hash: string): void {
    if (this.closed || this.awaitingText) return;
    // While a request travels the mirror's text is still the text the browser put back, so the same check holds.
    if (sha256(this.text) !== hash) {
      this.askForText();
      return;
    }
    this.browserVersion = version;
  }

  public close(): void {
    this.closed = true;
    this.listeners.clear();
    const pending = this.pending;
    this.pending = undefined;
    pending?.resolve(false);
  }

  private finish(applied: boolean, hash?: string): void {
    const pending = this.pending as Pending;
    this.pending = undefined;
    if (!applied) {
      // The held changes are into the mirror's text, which the request never changed: the core takes them as they are, and decides.
      for (const change of pending.held) this.emit(change.edits, applyBindingEdits(this.text, change.edits), change.reason);
      pending.resolve(false);
      return;
    }
    // The request first, as the echo the core waits for, then each held change moved past it.
    this.emit(pending.edits, pending.expectedText);
    let request: readonly BindingEdit[] = pending.edits;
    for (const change of pending.held) {
      const moved = moveEdits(change.edits, request, 'after');
      request = moveEdits(request, change.edits, 'before');
      this.emit(moved, applyBindingEdits(this.text, moved), change.reason);
    }
    pending.resolve(true);
    if (hash !== undefined && sha256(this.text) !== hash) this.askForText();
  }

  private askForText(): void {
    if (this.awaitingText) return;
    this.awaitingText = true;
    this.hooks.log?.('staff: the shared editor asked its tab for the whole text');
    this.channel.requestFullText();
  }

  private emit(edits: readonly BindingEdit[], text: string, reason?: BindingReason): void {
    this.text = text;
    this.ownVersion += 1;
    const change: EngineDocumentChange = { edits, text, version: this.ownVersion, ...(reason === undefined ? {} : { reason }) };
    for (const listener of [...this.listeners]) listener(change);
  }
}
