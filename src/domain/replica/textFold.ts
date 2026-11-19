// The text reducer for the doc family (D-18, D-19). Not hub-side: it holds Yjs documents through doc.ts.
//
// Text is keyed by (stream, product) and exists as soon as a registered client writes. Versions need product.create (plan 30-08).
// The ownership rule: an update may only insert structs under a client id registered to the entry's own writer. A deletion may touch anyone's text.
// Later plans add to these types and never rename them: 30-06, 30-08 and 30-10 rely on TextState, ProductText, registrations and accepted.
import { canonicalize } from '../team/canonical';
import type { Actor } from './entry';
import { applyUpdate, cloneDoc, createFoldDoc, docText, stateVectorOf, textHashOf, updateClients } from './doc';
import type { CrdtDoc } from './doc';
import type { FamilyReducer, ReduceOutcome } from './reducers';

export interface Registration { clientId: number; writer: string; member: string; actor: Actor; entry: string }
export interface AcceptedUpdate { hash: string; writer: string; actor: Actor; update: Uint8Array }
export interface ProductText {
  stream: string;
  product: string;
  doc: CrdtDoc;
  registrations: Map<number, Registration>;
  accepted: AcceptedUpdate[];
}
export interface TextState { products: Map<string, ProductText> }

export interface ProductTextOutput {
  stream: string;
  product: string;
  text: string;
  textHash: string;
  stateVector: Array<[number, number]>;
  registrations: Registration[];
  accepted: string[];
}

export const TEXT_REFUSALS = {
  'client-collision': 'Another device already registered this client id for this product, so this device must pick a different one.',
  'actor-mismatch': 'The registration names a different actor than the entry that carries it.',
  'malformed-update': 'The text update cannot be read.',
  'foreign-client': 'The update inserts text under a client id registered to another device, so it is refused as forged attribution.',
  'unsupported-kind': 'This kind of text entry is not applied by this version.'
} as const;
export const TEXT_HOLDS = {
  'unregistered-client': 'The update uses a client id that has no registration yet. It waits until the registration arrives.'
} as const;

const productKey = (stream: string, product: string): string => `${stream}/${product}`;

function productText(state: TextState, stream: string, product: string): ProductText {
  const key = productKey(stream, product);
  let found = state.products.get(key);
  if (found === undefined) {
    found = { stream, product, doc: createFoldDoc(), registrations: new Map(), accepted: [] };
    state.products.set(key, found);
  }
  return found;
}

function refused(reason: keyof typeof TEXT_REFUSALS): ReduceOutcome {
  return { status: 'refused', reason };
}

export const textReducer: FamilyReducer<TextState, ProductTextOutput[]> = {
  family: 'doc',
  init: () => ({ products: new Map() }),
  apply(state, entry): ReduceOutcome {
    const data = entry.data as { product: string; clientId?: number; actor?: Actor; update?: string };
    if (entry.body.kind === 'doc.client') {
      if (canonicalize(data.actor) !== canonicalize(entry.body.actor)) return refused('actor-mismatch');
      const product = productText(state, entry.header.stream, data.product);
      const clientId = data.clientId as number;
      const existing = product.registrations.get(clientId);
      if (existing !== undefined) return existing.writer === entry.header.writer ? { status: 'applied' } : refused('client-collision');
      product.registrations.set(clientId, { clientId, writer: entry.header.writer, member: entry.member, actor: entry.body.actor, entry: entry.hash });
      return { status: 'applied' };
    }
    if (entry.body.kind === 'doc.update') {
      const bytes = Buffer.from(data.update as string, 'base64url');
      const clients = updateClients(bytes);
      if (clients === undefined) return refused('malformed-update');
      // Look first, create later: a held or refused entry must leave no trace in the state.
      const known = state.products.get(productKey(entry.header.stream, data.product));
      const owners = clients.map((client) => known?.registrations.get(client));
      if (owners.some((owner) => owner !== undefined && owner.writer !== entry.header.writer)) return refused('foreign-client');
      if (owners.some((owner) => owner === undefined)) return { status: 'held', reason: 'unregistered-client' };
      const product = known ?? productText(state, entry.header.stream, data.product);
      if (!applyUpdate(product.doc, bytes)) return refused('malformed-update');
      product.accepted.push({ hash: entry.hash, writer: entry.header.writer, actor: entry.body.actor, update: bytes });
      return { status: 'applied' };
    }
    return refused('unsupported-kind');
  },
  finish(state) {
    return [...state.products.values()]
      .sort((a, b) => (a.stream === b.stream ? (a.product < b.product ? -1 : a.product > b.product ? 1 : 0) : a.stream < b.stream ? -1 : 1))
      .map((product) => {
        const text = docText(product.doc);
        return {
          stream: product.stream,
          product: product.product,
          text,
          textHash: textHashOf(text),
          stateVector: stateVectorOf(product.doc),
          registrations: [...product.registrations.values()].sort((a, b) => a.clientId - b.clientId),
          accepted: product.accepted.map((update) => update.hash)
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
    const copy: TextState = { products: new Map() };
    for (const [key, product] of state.products) {
      copy.products.set(key, {
        stream: product.stream,
        product: product.product,
        doc: cloneDoc(product.doc),
        registrations: new Map(product.registrations),
        accepted: [...product.accepted]
      });
    }
    return copy;
  }
};
