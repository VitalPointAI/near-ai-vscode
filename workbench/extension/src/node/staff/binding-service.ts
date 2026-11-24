/**
 * The editor binding service (Phase 33 D-52 to D-55, D-17; RESEARCH N3, N5, Pitfall N8.3): one per session backend, at STAFF_BINDING_PATH. A tab
 * attaches each model it opens; a model that is a product of an open shared project is bound, and the executed binding core (EditorBinding, 33-04)
 * runs here over a RemoteBoundDocument, unchanged. Everything else is never touched (MUS-06).
 *
 *   one binding per product per session: the first tab to attach edits; another tab's model is read-only with OTHER_TAB_TEXT, and becomes the
 *     editing tab when the first detaches (its tab attaches again)
 *   a model whose text is not the shared text is given the shared text first (reset), with the core's resync line
 *   other people's changes: each status row of a project refreshes its bindings, which apply what the fold accepted
 *   the projector leaves bound products to their binding (StaffLiveEngine.setBound); a save flushes the binding first, so the saved file is the
 *     text the projector would write, never a conflict
 *   a closed connection detaches every document of that tab
 *
 * No log line holds text, a key, a token or a name. Nothing here imports Theia's browser code.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { interfaces } from '@theia/core/shared/inversify';
import type { RpcProxy } from '@theia/core/lib/common/messaging/index.js';
import {
  OTHER_TAB_TEXT, STAFF_BINDING_PATH, StaffBindingServer, type AttachAnswer, type BindingEdit, type BindingReason, type StaffBindingClient,
} from '../../common/staff-binding.js';
import { bindBackendService } from '../backend-service.js';
import { RemoteBoundDocument } from './remote-bound-document.js';
import type { EngineEditorBinding, EngineProject, StaffEngine } from './staff-engine.js';
import type { StaffLiveEngine } from './staff-live-engine.js';

/** What the binding reads of the session's live engine. */
export type BindingLiveSource = Pick<StaffLiveEngine, 'projects' | 'project' | 'projectionInput' | 'setBound' | 'localAppended' | 'onStatus'>;

export interface StaffBindingServiceOptions {
  /** The session's live engine once it has started. */
  readonly live: () => BindingLiveSource | undefined;
  /** The engine bundle's binding names. */
  readonly engine: Pick<StaffEngine, 'EditorBinding' | 'RESYNC_LOG_LINE' | 'projectProductStates' | 'projectProductFile' | 'staffProductPath'>;
  readonly log?: (line: string) => void;
}

/** A product of an open shared project, as a bound model names it. */
interface FoundProduct {
  readonly projectId: string;
  readonly project: EngineProject;
  readonly stream: string;
  readonly product: string;
  readonly header: string;
  readonly body: string;
}

interface Attachment {
  readonly doc: string;
  readonly client: string;
  readonly key: string;
  readonly projectId: string;
  readonly product: string;
  mirror?: RemoteBoundDocument;
  binding?: EngineEditorBinding;
  header?: string;
}

interface ProductSlot {
  editing?: Attachment;
  readonly waiting: Attachment[];
}

const lf = (text: string): string => text.replaceAll('\r\n', '\n');

export class StaffBindingService implements StaffBindingServer {
  private readonly clients = new Map<string, StaffBindingClient>();
  private readonly docs = new Map<string, Attachment>();
  private readonly slots = new Map<string, ProductSlot>();
  private readonly watched = new WeakSet<object>();
  private nextClient = 1;
  private nextDoc = 1;

  constructor(private readonly options: StaffBindingServiceOptions) {}

  /** A connecting tab: told its id, and its documents detached when its connection closes. */
  public addClient(client: RpcProxy<StaffBindingClient> | (StaffBindingClient & { onDidCloseConnection?: RpcProxy<StaffBindingClient>['onDidCloseConnection'] })): string {
    const id = `tab-${this.nextClient++}`;
    this.clients.set(id, client);
    client.onDidCloseConnection?.(() => { void this.dropClient(id); });
    client.onHello(id);
    return id;
  }

  public async attach(client: string, uri: string, text: string, version: number): Promise<AttachAnswer> {
    const tab = this.clients.get(client);
    const live = this.options.live();
    if (tab === undefined || live === undefined) return { kind: 'not-shared' };
    this.watch(live);
    const found = await this.find(live, uri);
    if (found === undefined) return { kind: 'not-shared' };
    const key = `${found.projectId}/${found.product}`;
    const slot = this.slots.get(key) ?? { waiting: [] };
    this.slots.set(key, slot);
    const attachment: Attachment = { doc: `doc-${this.nextDoc++}`, client, key, projectId: found.projectId, product: found.product };
    if (slot.editing !== undefined) {
      slot.waiting.push(attachment);
      this.docs.set(attachment.doc, attachment);
      return { kind: 'read-only', doc: attachment.doc, message: OTHER_TAB_TEXT };
    }
    const canonical = found.header + found.body;
    if (text !== canonical && lf(text) !== canonical) {
      this.log(this.options.engine.RESYNC_LOG_LINE);
      return { kind: 'reset', text: canonical };
    }
    slot.editing = attachment;
    this.docs.set(attachment.doc, attachment);
    attachment.header = found.header;
    const mirror = new RemoteBoundDocument(text, version, {
      applyEdits: (request, edits, baseVersion, lineEndings) => tab.onApplyEdits(attachment.doc, request, edits, baseVersion, lineEndings),
      requestFullText: () => tab.onRequestFullText(attachment.doc),
    }, { onAdopted: () => { void attachment.binding?.refresh().catch(() => undefined); }, log: (line) => this.log(line) });
    attachment.mirror = mirror;
    try {
      attachment.binding = await this.options.engine.EditorBinding.open(mirror, {
        project: found.project as never, stream: found.stream, product: found.product, actor: { kind: 'person' }, header: () => attachment.header ?? found.header,
      }, {
        notice: (sentence) => tab.onNotice(attachment.doc, sentence),
        log: (line) => this.log(line),
        onAppended: () => this.options.live()?.localAppended(found.projectId),
      });
    } catch (error) {
      this.log(`staff: a product could not be bound (${error instanceof Error ? error.name : 'error'})`);
      await this.release(attachment);
      return { kind: 'not-shared' };
    }
    this.updateBound(live, found.projectId);
    return { kind: 'bound', doc: attachment.doc };
  }

  public async changed(doc: string, edits: readonly BindingEdit[], version: number, hash: string, reason?: BindingReason): Promise<void> {
    this.docs.get(doc)?.mirror?.browserChanged(edits, version, hash, reason);
  }

  public async applied(doc: string, request: number, ok: boolean, version: number, hash: string): Promise<void> {
    this.docs.get(doc)?.mirror?.browserApplied(request, ok, version, hash);
  }

  public async fullText(doc: string, text: string, version: number): Promise<void> {
    this.docs.get(doc)?.mirror?.browserText(text, version);
  }

  public async synced(doc: string, version: number, hash: string): Promise<void> {
    this.docs.get(doc)?.mirror?.browserSynced(version, hash);
  }

  public async undo(doc: string): Promise<boolean> {
    return (await this.docs.get(doc)?.binding?.undo().catch(() => false)) ?? false;
  }

  public async redo(doc: string): Promise<boolean> {
    return (await this.docs.get(doc)?.binding?.redo().catch(() => false)) ?? false;
  }

  public async flush(doc: string): Promise<void> {
    await this.docs.get(doc)?.binding?.flush().catch(() => undefined);
  }

  public async detach(doc: string): Promise<void> {
    const attachment = this.docs.get(doc);
    if (attachment !== undefined) await this.release(attachment);
  }

  /** The bound products of every project, for the tests and the status of the session. */
  public boundProducts(): string[] {
    return [...this.slots.entries()].filter(([, slot]) => slot.editing !== undefined).map(([key]) => key).sort();
  }

  /** Every binding of the project takes what the fold accepted (after an exchange), with its header as the fold has it now. */
  public async refresh(projectId: string): Promise<void> {
    const live = this.options.live();
    const bound = [...this.slots.values()].flatMap((slot) => slot.editing?.projectId === projectId && slot.editing.binding !== undefined ? [slot.editing] : []);
    if (live === undefined || bound.length === 0) return;
    const headers = await this.headers(live, projectId);
    for (const attachment of bound) {
      const header = headers.get(attachment.product);
      if (header !== undefined) attachment.header = header;
      await attachment.binding?.refresh().catch(() => undefined);
    }
  }

  private watch(live: BindingLiveSource): void {
    if (this.watched.has(live)) return;
    this.watched.add(live);
    live.onStatus((row) => { void this.refresh(row.project); });
  }

  private async release(attachment: Attachment): Promise<void> {
    if (!this.docs.delete(attachment.doc)) return;
    const slot = this.slots.get(attachment.key);
    if (slot !== undefined) {
      const index = slot.waiting.indexOf(attachment);
      if (index >= 0) slot.waiting.splice(index, 1);
    }
    if (slot?.editing === attachment) {
      slot.editing = undefined;
      try {
        await attachment.binding?.flush();
      } catch {
        this.log('staff: a bound product\'s last changes were not written at detach');
      }
      await attachment.binding?.close().catch(() => undefined);
      attachment.mirror?.close();
      const live = this.options.live();
      if (live !== undefined) this.updateBound(live, attachment.projectId);
      // The next tab edits: it is told, and attaches again.
      const next = slot.waiting.shift();
      if (next !== undefined) {
        this.docs.delete(next.doc);
        this.clients.get(next.client)?.onReadOnly(next.doc, false);
      }
    }
    if (slot !== undefined && slot.editing === undefined && slot.waiting.length === 0) this.slots.delete(attachment.key);
  }

  private async dropClient(client: string): Promise<void> {
    this.clients.delete(client);
    for (const attachment of [...this.docs.values()]) if (attachment.client === client) await this.release(attachment);
  }

  private updateBound(live: BindingLiveSource, projectId: string): void {
    const products = [...this.slots.values()].flatMap((slot) => slot.editing?.projectId === projectId ? [slot.editing.product] : []);
    live.setBound(projectId, products);
  }

  /** The product file at `uri`, when it is a product of an open shared project. */
  private async find(live: BindingLiveSource, uri: string): Promise<FoundProduct | undefined> {
    if (!uri.startsWith('file:')) return undefined;
    let file: string;
    try {
      file = fileURLToPath(uri);
    } catch {
      return undefined;
    }
    const { engine } = this.options;
    for (const row of live.projects()) {
      const relative = path.relative(row.root, file);
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) continue;
      const wanted = relative.split(path.sep).join('/');
      const project = live.project(row.project);
      const input = await live.projectionInput(row.project) as { fold: { families: Record<string, unknown> } } | undefined;
      if (project === undefined || input === undefined) continue;
      for (const [product, state] of engine.projectProductStates(input as never)) {
        if (engine.staffProductPath(state.record.section as never, product) !== wanted) continue;
        const texts = (input.fold.families.doc as Array<{ stream: string; product: string; text: string; problem?: string; incomplete?: boolean }> | undefined) ?? [];
        const versions = (input.fold.families.versions as Array<{ stream: string; product: string }> | undefined) ?? [];
        const stream = versions.find((item) => item.product === product)?.stream;
        if (stream === undefined) return undefined;
        const output = texts.find((item) => item.stream === stream && item.product === product);
        // A text this computer cannot read whole is not bound: the editor shows the file as it is.
        if (output !== undefined && (output.problem !== undefined || output.incomplete === true)) return undefined;
        return { projectId: row.project, project, stream, product, header: engine.projectProductFile(state as never, ''), body: output?.text ?? '' };
      }
    }
    return undefined;
  }

  private async headers(live: BindingLiveSource, projectId: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    try {
      const input = await live.projectionInput(projectId);
      if (input === undefined) return out;
      for (const [product, state] of this.options.engine.projectProductStates(input as never)) out.set(product, this.options.engine.projectProductFile(state as never, ''));
    } catch {
      this.log('staff: the headers of bound products were not read after an exchange');
    }
    return out;
  }

  private log(line: string): void {
    this.options.log?.(line);
  }
}

/** Binds the binding service and its RPC path, with every tab as a client. */
export function bindStaffBindingService(bind: interfaces.Bind, options: (context: interfaces.Context) => StaffBindingServiceOptions): void {
  bindBackendService<StaffBindingService, StaffBindingClient>(bind, StaffBindingServer, STAFF_BINDING_PATH, (context) => new StaffBindingService(options(context)),
    (service, client) => { service.addClient(client); });
}
