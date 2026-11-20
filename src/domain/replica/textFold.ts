// The text reducer for the doc family (D-18, D-19). Not hub-side: it holds Yjs documents through doc.ts.
//
// Text is keyed by (stream, product) and exists as soon as a registered client writes. Versions need product.create (plan 30-08).
// The ownership rule: an update may only insert structs under a client id registered to the entry's own writer. A deletion may touch anyone's text.
// Later plans add to these types and never rename them: 30-06, 30-08 and 30-10 rely on TextState, ProductText, registrations and accepted.
import { createHash } from 'node:crypto';
import { canonicalize } from '../team/canonical';
import { attributeText } from './attribution';
import type { AttributionProof, AuthorSpan } from './attribution';
import { blobBytesHash, openBlob } from './entry';
import type { Actor, Dep } from './entry';
import { applyUpdate, attributionRuns, buildFromCompaction, cloneDoc, createFoldDoc, docText, inspectUpdate, pendingState, stateVectorOf, textHashOf } from './doc';
import type { CrdtDoc, InspectError } from './doc';
import type { FamilyReducer, FoldView, ReduceOutcome } from './reducers';
import type { VerifiedEntry } from './verify';

export interface Registration { clientId: number; writer: string; member: string; actor: Actor; entry: string }
export interface AcceptedUpdate { hash: string; writer: string; actor: Actor; update: Uint8Array }
// Which entry deleted which clock range (D-19). The first entry in fold order to delete a range is the one recorded.
export interface DeletionRecord { entry: string; client: number; clock: number; length: number }
// A compaction the fold accepted. verified: the covered entries were all in the set and the state matched the accepted ones among them (D-37,
// WR-04); otherwise it stands in for them.
export interface CompactionRecord { entry: string; verified: boolean }
export interface ProductText {
  stream: string;
  product: string;
  // The fold document, created on the first accepted update (WR-08): a product that only has registrations holds no Yjs document.
  doc: CrdtDoc | undefined;
  registrations: Map<number, Registration>;
  accepted: AcceptedUpdate[];
  // Added by plan 30-06; the fields above keep their 30-02 names.
  // The next clock expected for each client, from the updates accepted so far (the clock rule).
  nextClock: Map<number, number>;
  // Where an accepted update started above the next expected clock, so something before it is missing.
  gaps: Array<{ client: number; clock: number }>;
  deletions: DeletionRecord[];
  deletionKeys: Set<string>;
  compactions: CompactionRecord[];
  // Full states of compactions accepted without all their covered updates, in fold order, with the writer of each. The newest one fills in text the
  // log does not hold, and speaks for that writer only (CR-01): text no accepted update backs is never attributed to anyone else.
  provisional: Array<{ update: Uint8Array; writer: string }>;
  // Added by plan 31-04 (WR-05, WR-08). How many client ids each writer registered for this product.
  registrationCounts: Map<string, number>;
  // For each writer, how many updates the product had accepted when that writer's last compaction of it was accepted (the compaction window).
  lastCompaction: Map<string, number>;
  // The state vector and text hash of the accepted updates a compaction was last checked against, and which updates those were (key). Holds only
  // immutable values, so a clone of the state may share it.
  scratch: { key: string; stateVector: Array<[number, number]>; textHash: string } | undefined;
  // How many times that scratch was computed rather than reused. Read by tests only; no output or digest carries it.
  scratchBuilds: number;
}
// productsPerStream: how many products each stream holds (WR-08).
export interface TextState { products: Map<string, ProductText>; productsPerStream: Map<string, number> }

export interface ProductTextOutput {
  stream: string;
  product: string;
  text: string;
  textHash: string;
  stateVector: Array<[number, number]>;
  registrations: Registration[];
  accepted: string[];
  // Every character's author, from the signed registrations only (D-20). Text that only an unverified compaction holds is flagged unverified and is
  // attributed to the compaction's writer at most.
  attribution: AuthorSpan[];
  deletions: DeletionRecord[];
  // True while the text lacks something: an update that starts above the next expected clock, or structs the document cannot place yet.
  incomplete: boolean;
  compactions: CompactionRecord[];
}

export const TEXT_REFUSALS = {
  'client-collision': 'Another device already registered this client id for this product, so this device must pick a different one.',
  'foreign-client-id': 'The client id is not in the range the roster gives this device, so this device may not register it.',
  'agent-seat-not-allowed': 'The registration names an agent seat that the roster does not let this device\'s member run.',
  'actor-mismatch': 'The registration names a different actor than the entry that carries it.',
  'malformed-update': 'The text update cannot be read.',
  'foreign-client': 'The update inserts text under a client id registered to another device, so it is refused as forged attribution.',
  'forbidden-content': 'The update carries something other than plain text, such as an embed, a format, a map or a nested type, or an unreadable gap, so it is refused.',
  'clock-overlap': 'The update claims text positions that an earlier update from the same device already used, so it is refused.',
  'too-large': 'The update is larger than the allowed size, or one part of it claims too many text positions.',
  'compact-mismatch': 'The compaction does not match the updates it says it covers, or does not match itself, so it is refused.',
  'compact-unregistered-client': 'The compaction holds text under a client id that no device has registered, so it is refused.',
  'too-many': 'This device has registered too many client ids for this product, or compacted it again before enough new text arrived.',
  'too-many-products': 'This stream already holds the largest allowed number of text products, so no new one can start.',
  'unsupported-kind': 'This kind of text entry is not applied by this version.'
} as const;
export const TEXT_HOLDS = {
  'unregistered-client': 'The update uses a client id that has no registration yet. It waits until the registration arrives.',
  'missing-key': 'This machine does not have the key for the compaction yet.',
  'missing-blob': 'The full state of the compaction has not arrived yet.'
} as const;

// Limits on what one writer can make the text reducer hold or build (D-02, WR-05, WR-08). No honest scenario comes near them.
// The accepted updates a product must gain between two compactions of it by one writer.
export const COMPACTION_WINDOW = 50;
// Client ids one writer may register for one product; a fresh id per editor session needs room.
export const MAX_REGISTRATIONS_PER_WRITER_PRODUCT = 4096;
// Text products one stream may hold.
export const MAX_PRODUCTS_PER_STREAM = 1024;

const productKey = (stream: string, product: string): string => `${stream}/${product}`;

// The product's text state, created on first use; undefined when the stream already holds MAX_PRODUCTS_PER_STREAM products.
function productText(state: TextState, stream: string, product: string): ProductText | undefined {
  const key = productKey(stream, product);
  const found = state.products.get(key);
  if (found !== undefined) return found;
  const count = state.productsPerStream.get(stream) ?? 0;
  if (count >= MAX_PRODUCTS_PER_STREAM) return undefined;
  const created: ProductText = {
    stream,
    product,
    doc: undefined,
    registrations: new Map(),
    accepted: [],
    nextClock: new Map(),
    gaps: [],
    deletions: [],
    deletionKeys: new Set(),
    compactions: [],
    provisional: [],
    registrationCounts: new Map(),
    lastCompaction: new Map(),
    scratch: undefined,
    scratchBuilds: 0
  };
  state.products.set(key, created);
  state.productsPerStream.set(stream, count + 1);
  return created;
}

// An empty document, read only: what a product without a fold document shows.
let emptyDoc: CrdtDoc | undefined;
function empty(): CrdtDoc {
  if (emptyDoc === undefined) emptyDoc = createFoldDoc();
  return emptyDoc;
}

function refused(reason: keyof typeof TEXT_REFUSALS): ReduceOutcome {
  return { status: 'refused', reason };
}

function held(reason: keyof typeof TEXT_HOLDS): ReduceOutcome {
  return { status: 'held', reason };
}

// The refusal for an update or state the inspection could not accept.
function inspectionRefusal(error: InspectError): ReduceOutcome {
  return refused(error === 'malformed' ? 'malformed-update' : error);
}

interface UpdateData { product: string; clientId?: number; actor?: Actor; update?: string }
interface CompactData { product: string; covers: Dep[]; stateVector: Array<[number, number]>; textHash: string; stateBlob: string }

// When the roster names the owner of each client id (D-03, D-41), an id belongs to the writer whose roster slot it derives from, and only that writer
// may register it: two writers can never race for one id. Without that answer (the Phase 30 static roster) the claim earlier in the total order wins,
// and the registry is fold output rebuilt on every fold, so a refold that changes the order can change the winner. Inside the writer's own range the
// earlier-claim rule stays: one client id means one author, so a second claim by the same device under another actor is refused.
function applyClient(state: TextState, entry: VerifiedEntry, data: UpdateData, view: FoldView): ReduceOutcome {
  if (canonicalize(data.actor) !== canonicalize(entry.body.actor)) return refused('actor-mismatch');
  const roster = view.ctx.roster;
  // An agent's text is attributed to its seat only when the device's member may run that seat at the cited roster (WR-02, D-12). Default deny: a
  // view that cannot answer allows no agent registration.
  const actor = entry.body.actor;
  if (actor.kind === 'agent' && roster.canRunAgent?.(entry.member, actor.member, entry.body.roster) !== true) return refused('agent-seat-not-allowed');
  if (roster.clientIdOwner !== undefined && roster.clientIdOwner(data.clientId as number, entry.body.roster) !== entry.header.writer) return refused('foreign-client-id');
  const product = productText(state, entry.header.stream, data.product);
  if (product === undefined) return refused('too-many-products');
  const clientId = data.clientId as number;
  const existing = product.registrations.get(clientId);
  if (existing !== undefined) {
    const same = existing.writer === entry.header.writer && canonicalize(existing.actor) === canonicalize(entry.body.actor);
    return same ? { status: 'applied' } : refused('client-collision');
  }
  const count = product.registrationCounts.get(entry.header.writer) ?? 0;
  if (count >= MAX_REGISTRATIONS_PER_WRITER_PRODUCT) return refused('too-many');
  product.registrationCounts.set(entry.header.writer, count + 1);
  product.registrations.set(clientId, { clientId, writer: entry.header.writer, member: entry.member, actor: entry.body.actor, entry: entry.hash });
  return { status: 'applied' };
}

// The document rebuilt from the accepted updates, used when applying one left it in an unknown state.
function rebuilt(accepted: readonly AcceptedUpdate[]): CrdtDoc {
  const doc = createFoldDoc();
  for (const item of accepted) applyUpdate(doc, item.update);
  return doc;
}

function applyUpdateEntry(state: TextState, entry: VerifiedEntry, data: UpdateData): ReduceOutcome {
  const bytes = Buffer.from(data.update as string, 'base64url');
  const inspection = inspectUpdate(bytes);
  if ('error' in inspection) return inspectionRefusal(inspection.error);
  if (inspection.structs.some((struct) => !struct.parentOk)) return refused('forbidden-content');
  // Look first, create later: a held or refused entry must leave no trace in the state.
  const known = state.products.get(productKey(entry.header.stream, data.product));
  const owners = inspection.clients.map((span) => known?.registrations.get(span.client));
  if (owners.some((owner) => owner !== undefined && owner.writer !== entry.header.writer)) return refused('foreign-client');
  if (owners.some((owner) => owner === undefined)) return held('unregistered-client');
  // The clock rule (D-35). A client's first struct here must start at the next clock expected from the writer's earlier updates: below it is an
  // overlap, which would make the text depend on the order updates were applied in, and above it is a gap, which may be a lost batch.
  const gaps: Array<{ client: number; clock: number }> = [];
  for (const span of inspection.clients) {
    const expected = known?.nextClock.get(span.client) ?? 0;
    if (span.start < expected) return refused('clock-overlap');
    if (span.start > expected) gaps.push({ client: span.client, clock: span.start });
  }
  // An update that inserts nothing (deletions only) can name a product nobody registered, so it may be the one that creates it.
  const product = known ?? productText(state, entry.header.stream, data.product);
  if (product === undefined) return refused('too-many-products');
  if (product.doc === undefined) product.doc = createFoldDoc();
  if (!applyUpdate(product.doc, bytes)) {
    // Inspection accepted it, so this should not happen; if Yjs fails halfway the document is rebuilt from what was accepted before.
    product.doc = product.accepted.length === 0 ? undefined : rebuilt(product.accepted);
    return refused('malformed-update');
  }
  product.accepted.push({ hash: entry.hash, writer: entry.header.writer, actor: entry.body.actor, update: bytes });
  for (const span of inspection.clients) product.nextClock.set(span.client, span.end);
  product.gaps.push(...gaps);
  for (const range of inspection.deletes) {
    const key = `${range.client}:${range.clock}:${range.length}`;
    if (product.deletionKeys.has(key)) continue;
    product.deletionKeys.add(key);
    product.deletions.push({ entry: entry.hash, client: range.client, clock: range.clock, length: range.length });
  }
  return { status: 'applied' };
}

const sameVector = (a: ReadonlyArray<readonly [number, number]>, b: ReadonlyArray<readonly [number, number]>): boolean => canonicalize(a) === canonicalize(b);

// A compaction is a verified cache, never a source of truth (D-21, D-37). With the covered updates in the set it is checked against the accepted
// ones among them and changes nothing. Without them it may stand in for them, but only for clients some device registered, and it is marked unverified.
// The state vector and text hash of some of a product's accepted updates, memoised by which updates they are (WR-05), so compactions at the same
// point in the log share one build. When they are all the accepted updates, the fold document already is their document and nothing is rebuilt.
// The memo is a cache: a compaction refused after it was filled leaves nothing any output or digest reads.
function acceptedScratch(product: ProductText | undefined, usable: readonly AcceptedUpdate[]): { stateVector: Array<[number, number]>; textHash: string } {
  if (product === undefined) return { stateVector: stateVectorOf(empty()), textHash: textHashOf('') };
  const all = usable.length === product.accepted.length;
  let key = `all/${usable.length}`;
  if (!all) {
    const digest = createHash('sha256');
    for (const item of usable) digest.update(item.hash);
    key = `some/${product.accepted.length}/${digest.digest('hex')}`;
  }
  if (product.scratch?.key === key) return product.scratch;
  const doc = all ? product.doc ?? empty() : rebuilt(usable);
  product.scratch = { key, stateVector: stateVectorOf(doc), textHash: textHashOf(docText(doc)) };
  product.scratchBuilds += 1;
  return product.scratch;
}

function applyCompaction(state: TextState, entry: VerifiedEntry, data: CompactData, view: FoldView): ReduceOutcome {
  const { stream, epoch, writer } = entry.header;
  const known = state.products.get(productKey(stream, data.product));
  // The compaction window (WR-05): a writer compacts a product again only after COMPACTION_WINDOW more accepted updates. Checked before any work.
  const last = known?.lastCompaction.get(writer);
  if (last !== undefined && (known?.accepted.length ?? 0) - last < COMPACTION_WINDOW) return refused('too-many');
  const key = view.ctx.keys(stream, epoch);
  if (key === undefined) return held('missing-key');
  const blob = view.ctx.blobs(data.stateBlob);
  if (blob === undefined || blobBytesHash(blob) !== data.stateBlob) return held('missing-blob');
  const plain = openBlob(key, stream, epoch, blob);
  if (plain === undefined) return refused('malformed-update');
  const inspection = inspectUpdate(plain);
  if ('error' in inspection) return inspectionRefusal(inspection.error);
  if (inspection.structs.some((struct) => !struct.parentOk)) return refused('forbidden-content');
  const stored = buildFromCompaction(plain, []);
  if (stored === undefined) return refused('malformed-update');
  const storedVector = stateVectorOf(stored);
  const storedHash = textHashOf(docText(stored));
  for (const cover of data.covers) {
    const target = view.entry(cover.hash);
    if (target !== undefined && (target.header.writer !== cover.writer || target.header.seq !== cover.seq)) return refused('compact-mismatch');
  }

  if (data.covers.every((cover) => view.graph.has(cover.hash))) {
    const included = new Set<string>();
    for (const hash of view.graph.closure(data.covers.map((cover) => cover.hash))) {
      const target = view.entry(hash);
      if (target !== undefined && target.body.kind === 'doc.update' && target.header.stream === stream && (target.data as UpdateData).product === data.product) included.add(hash);
    }
    // The check is against the covered updates the fold accepted (WR-04). A covered update the fold refused or holds adds nothing to the text, so
    // it is left out of the scratch document; a compaction that adds its text, or leaves out an accepted one, differs from the scratch below.
    const usable = (known?.accepted ?? []).filter((item) => included.has(item.hash));
    const { stateVector: vector, textHash: hash } = acceptedScratch(known, usable);
    if (!sameVector(vector, data.stateVector) || hash !== data.textHash || !sameVector(vector, storedVector) || hash !== storedHash) return refused('compact-mismatch');
    const product = known ?? productText(state, stream, data.product);
    if (product === undefined) return refused('too-many-products');
    product.compactions.push({ entry: entry.hash, verified: true });
    product.lastCompaction.set(writer, product.accepted.length);
    return { status: 'applied' };
  }

  // Provisional load: the blob must agree with itself and every struct in it must belong to a client some device registered. The text it adds beyond
  // the accepted updates is shown as unverified, and only ever under this writer's own name (CR-01), because a signed compaction can vouch for
  // its own writer and for nobody else.
  if (!sameVector(storedVector, data.stateVector) || storedHash !== data.textHash) return refused('compact-mismatch');
  if (inspection.structs.some((struct) => known?.registrations.has(struct.client) !== true)) return refused('compact-unregistered-client');
  const product = known ?? productText(state, stream, data.product);
  if (product === undefined) return refused('too-many-products');
  product.compactions.push({ entry: entry.hash, verified: false });
  product.provisional.push({ update: plain, writer });
  product.lastCompaction.set(writer, product.accepted.length);
  return { status: 'applied' };
}

// The document a product's output is read from: the fold document, with the newest unverified compaction merged in. Updates the log holds come
// first, so where a compaction and the log disagree about a position the log wins.
function outputDoc(product: ProductText): CrdtDoc {
  const newest = product.provisional[product.provisional.length - 1];
  if (newest === undefined) return product.doc ?? empty();
  const merged = product.doc === undefined ? createFoldDoc() : cloneDoc(product.doc);
  applyUpdate(merged, newest.update);
  return merged;
}

// Who may be named as the author of text that only an unverified compaction holds (CR-01): the compaction's writer, for client ids registered to
// it, and nobody else. The proof is how far the accepted updates reach for each client; everything above that is the compaction's word alone.
function attributionProof(product: ProductText): AttributionProof | undefined {
  const newest = product.provisional[product.provisional.length - 1];
  if (newest === undefined) return undefined;
  return { proven: new Map(stateVectorOf(product.doc ?? empty())), claimant: newest.writer };
}

export const textReducer: FamilyReducer<TextState, ProductTextOutput[]> = {
  family: 'doc',
  init: () => ({ products: new Map(), productsPerStream: new Map() }),
  apply(state, entry, view): ReduceOutcome {
    const data = entry.data as UpdateData;
    if (entry.body.kind === 'doc.client') return applyClient(state, entry, data, view);
    if (entry.body.kind === 'doc.update') return applyUpdateEntry(state, entry, data);
    if (entry.body.kind === 'doc.compact') return applyCompaction(state, entry, entry.data as CompactData, view);
    return refused('unsupported-kind');
  },
  // A compaction branches on whether the entries it covers are held at all (the log checks it, or it stands in for them), and a cover may sort after
  // the compaction or arrive long after it (CR-02), so a later arrival of any cover can change the outcome.
  lateDependencies(entry) {
    if (entry.body.kind !== 'doc.compact') return [];
    const covers = (entry.data as CompactData).covers;
    return Array.isArray(covers) ? covers.map((cover) => cover.hash) : [];
  },
  finish(state) {
    return [...state.products.values()]
      .sort((a, b) => (a.stream === b.stream ? (a.product < b.product ? -1 : a.product > b.product ? 1 : 0) : a.stream < b.stream ? -1 : 1))
      .map((product) => {
        const doc = outputDoc(product);
        const text = docText(doc);
        const stateVector = stateVectorOf(doc);
        const reached = new Map(stateVector);
        return {
          stream: product.stream,
          product: product.product,
          text,
          textHash: textHashOf(text),
          stateVector,
          registrations: [...product.registrations.values()].sort((a, b) => a.clientId - b.clientId),
          accepted: product.accepted.map((update) => update.hash),
          attribution: attributeText(attributionRuns(doc), product.registrations, attributionProof(product)),
          deletions: [...product.deletions],
          incomplete: pendingState(doc) || product.gaps.some((gap) => (reached.get(gap.client) ?? 0) < gap.clock),
          compactions: [...product.compactions]
        };
      });
  },
  canonical(output, stream) {
    return output
      .filter((product) => product.stream === stream)
      .sort((a, b) => (a.product < b.product ? -1 : a.product > b.product ? 1 : 0))
      .map((product) => ({
        product: product.product,
        stateVector: product.stateVector,
        textHash: product.textHash,
        registrations: product.registrations.map((registration): [number, string, string] => [registration.clientId, registration.writer, registration.entry])
      }));
  },
  clone(state) {
    const copy: TextState = { products: new Map(), productsPerStream: new Map(state.productsPerStream) };
    for (const [key, product] of state.products) {
      copy.products.set(key, {
        stream: product.stream,
        product: product.product,
        doc: product.doc === undefined ? undefined : cloneDoc(product.doc),
        registrations: new Map(product.registrations),
        accepted: [...product.accepted],
        nextClock: new Map(product.nextClock),
        gaps: [...product.gaps],
        deletions: [...product.deletions],
        deletionKeys: new Set(product.deletionKeys),
        compactions: [...product.compactions],
        provisional: [...product.provisional],
        registrationCounts: new Map(product.registrationCounts),
        lastCompaction: new Map(product.lastCompaction),
        scratch: product.scratch,
        scratchBuilds: product.scratchBuilds
      });
    }
    return copy;
  }
};
