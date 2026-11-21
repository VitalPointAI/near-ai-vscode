// The product editing core (Phase 33, D-11, DESIGN 5.2, Pitfall 2): one editing session of one product on this device, with no editor API. It
// holds a local Yjs document under a client id of this device's roster slot, seeded from the updates the fold accepted (productFeed.ts), turns each
// insert and remove into the exact update bytes it produced, and writes them to the shared record on flush: one doc.client registering the client id
// for the session, then one doc.update per captured update, in order, through ReplicaProject.appendOwn. The store writes first and the live
// replicator pushes after (the onAppended hook); a failed append keeps that update and every later one queued, in order, for the next flush, so a
// change is never lost and the fold never sees a clock gap.
//
// Client ids (Pitfall 2): every session takes a fresh id, the lowest of this device's slot that the fold has not registered for the product and no
// other session of this process holds, so a crash between writing an update and recording it can never make two sessions reuse clocks. The fold's
// verdict on the registration is read before the first update is written: a client-collision (the id registered first under another actor, such as
// an agent run on this device) or any other refusal stops the session with its PRODUCT_EDIT_REFUSALS sentence, the change kept queued. The editor
// binding (33-04) drives this class; batching of a typing burst and chunking of a large paste are its part, not this file's.
import { deviceAt } from '../../domain/replica/rosterMembers';
import { applyRemote, createLocalDoc, docText, localDelete, localInsert } from '../../domain/replica/doc';
import type { CrdtDoc } from '../../domain/replica/doc';
import { nextClientId } from '../../domain/replica/clientIds';
import type { Actor } from '../../domain/replica/entry';
import { acceptedUpdates, productOutput } from './productFeed';
import type { AcceptedUpdate, FeedProject } from './productFeed';
import type { ReplicaProject } from './replicaProject';

/** Why an editing session cannot go on, each with one sentence in the person's words (no "client id", "fold" or "entry" on main screens). */
export const PRODUCT_EDIT_REFUSALS = {
  'client-collision': 'This product could not take your change on this computer. Close it and open it again.',
  'registration-refused': 'This product could not take your change on this computer. Close it and open it again.',
  'not-a-device': 'This computer is not one of the shared project\'s computers, so it cannot change this product.',
  'no-room': 'This product has been opened for editing too many times on this computer, so it cannot be opened again here.',
  closed: 'This editing session is closed. Open the product again to change it.',
  'remote-unreadable': 'A change from someone else could not be read here. Close the product and open it again.'
} as const;
export type ProductEditRefusal = keyof typeof PRODUCT_EDIT_REFUSALS;

export class ProductEditError extends Error {
  public constructor(public readonly refusal: ProductEditRefusal) {
    super(PRODUCT_EDIT_REFUSALS[refusal]);
    this.name = 'ProductEditError';
  }
}

/** The product a session edits, and who is typing (a person, or an agent on a person's machine). */
export interface EditTarget { stream: string; product: string; actor: Actor }
export interface EditorHooks {
  /** Called after a flush appended at least one update, so the live replicator pushes it. */
  onAppended?: () => void;
}
/** The part of the project an editing session uses. */
export type EditorProject = FeedProject & Pick<ReplicaProject, 'appendOwn' | 'deviceWriter' | 'projectId'>;

/** Client ids held by the open sessions of this process, per project, device, stream and product. */
const HELD = new Map<string, Set<number>>();
const heldKey = (project: EditorProject, target: EditTarget): string => `${project.projectId}/${project.deviceWriter}/${target.stream}/${target.product}`;

export class ProductEditor {
  private readonly queue: Uint8Array[] = [];
  private registered = false;
  private closedNow = false;
  private stoppedBy: ProductEditRefusal | undefined;
  private running: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly project: EditorProject,
    private readonly target: EditTarget,
    private readonly hooks: EditorHooks,
    private readonly doc: CrdtDoc,
    public readonly clientId: number,
    private cursor: string | undefined
  ) {}

  /**
   * Opens a session: this device's slot from the roster at head, the lowest free client id of it, and a local document holding the accepted text.
   * Throws ProductEditError not-a-device or no-room.
   */
  public static async open(project: EditorProject, target: EditTarget, hooks: EditorHooks = {}): Promise<ProductEditor> {
    const { roster, fold } = await project.state();
    const slot = deviceAt(roster.members, project.deviceWriter, roster.positions.length - 1)?.slot;
    if (slot === undefined) throw new ProductEditError('not-a-device');
    const key = heldKey(project, target);
    const held = HELD.get(key) ?? new Set<number>();
    const used = new Set<number>(held);
    for (const registration of productOutput(fold, target.stream, target.product)?.registrations ?? []) used.add(registration.clientId);
    const clientId = nextClientId(slot, used);
    if (clientId === undefined) throw new ProductEditError('no-room');
    held.add(clientId);
    HELD.set(key, held);
    const doc = createLocalDoc(clientId);
    const feed = await acceptedUpdates(project, target.stream, target.product);
    const editor = new ProductEditor(project, target, hooks, doc, clientId, feed.last);
    editor.applyRemote(feed.updates);
    return editor;
  }

  /** The text of the local document. */
  public text(): string {
    return docText(this.doc);
  }

  /** The hash of the newest accepted update this session has applied, as a cursor for acceptedUpdates. */
  public get applied(): string | undefined {
    return this.cursor;
  }

  /** Captured updates not yet in the store. */
  public get queued(): number {
    return this.queue.length;
  }

  /** Why the session stopped, when it did. */
  public get refusal(): { refusal: ProductEditRefusal; message: string } | undefined {
    return this.stoppedBy === undefined ? undefined : { refusal: this.stoppedBy, message: PRODUCT_EDIT_REFUSALS[this.stoppedBy] };
  }

  public insert(index: number, text: string): void {
    this.usable();
    this.capture(localInsert(this.doc, index, text));
  }

  public remove(index: number, length: number): void {
    this.usable();
    this.capture(localDelete(this.doc, index, length));
  }

  /** Applies accepted updates from the feed (this device's own included: Yjs takes a known update as a no-op). */
  public applyRemote(updates: readonly AcceptedUpdate[]): void {
    for (const update of updates) {
      if (!applyRemote(this.doc, update.bytes)) {
        this.stoppedBy = 'remote-unreadable';
        return;
      }
      this.cursor = update.hash;
    }
  }

  /**
   * Writes the registration (once per session) and every queued update, in order, to the store. Stops at the first append the store refuses: that
   * update and the ones after it stay queued for the next flush. Flushes run one after another.
   */
  public flush(): Promise<{ appended: number; queued: number }> {
    const run = this.running.then(() => this.flushNow());
    this.running = run.catch(() => undefined);
    return run;
  }

  /** Ends the session. Updates still queued are not written; the caller flushes first. */
  public close(): void {
    if (this.closedNow) return;
    this.closedNow = true;
    const key = heldKey(this.project, this.target);
    HELD.get(key)?.delete(this.clientId);
    if (HELD.get(key)?.size === 0) HELD.delete(key);
    this.doc.destroy();
  }

  private usable(): void {
    if (this.closedNow) throw new ProductEditError('closed');
    if (this.stoppedBy !== undefined) throw new ProductEditError(this.stoppedBy);
  }

  private capture(update: Uint8Array): void {
    if (update.length > 0) this.queue.push(update);
  }

  /** Why the fold refused this session's registration, or undefined when it took it. */
  private async registrationVerdict(hash: string): Promise<ProductEditRefusal | undefined> {
    const { fold } = await this.project.state();
    const refused = fold.refused.find((item) => item.hash === hash) ?? fold.rejected.find((item) => item.hash === hash);
    if (refused === undefined) return undefined;
    return refused.reason === 'client-collision' ? 'client-collision' : 'registration-refused';
  }

  private async flushNow(): Promise<{ appended: number; queued: number }> {
    let appended = 0;
    if (this.queue.length === 0 || this.stoppedBy !== undefined || this.closedNow) return { appended, queued: this.queue.length };
    const { stream, product, actor } = this.target;
    if (!this.registered) {
      const registration = await this.project.appendOwn('doc.client', { product, clientId: this.clientId, actor }, { stream, actor });
      if (!('ok' in registration)) return { appended, queued: this.queue.length };
      // The registration is checked by the fold before any update uses it: an update under an id this session does not own would be refused,
      // or, worse, read as another actor's text.
      const verdict = await this.registrationVerdict(registration.hash);
      if (verdict !== undefined) {
        this.stoppedBy = verdict;
        return { appended, queued: this.queue.length };
      }
      this.registered = true;
    }
    while (this.queue.length > 0) {
      const update = this.queue[0] as Uint8Array;
      const written = await this.project.appendOwn('doc.update', { product, update: Buffer.from(update).toString('base64url') }, { stream, actor });
      if (!('ok' in written)) break;
      this.queue.shift();
      appended += 1;
    }
    if (appended > 0) this.hooks.onAppended?.();
    return { appended, queued: this.queue.length };
  }
}
