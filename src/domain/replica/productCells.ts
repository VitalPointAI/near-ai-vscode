// Products in several cells (plan 32-08; D-15 to D-18, D-20, D-21, D-22 revised, D-67). Pure: no I/O, no clock, imports from src/domain only.
//
// The fold already keeps a product and its text per (stream, product), so nothing in the fold's mechanics changes. These are the rules that assume
// more than one place, kept in one file so the fold and the host (32-09) decide them with the same function: the host refuses before it writes what
// the fold would refuse.

// The refusal the versions family adds (D-18). Spread into VERSION_REFUSALS, so the fold and the host show the same sentence.
export const PRODUCT_CELL_REFUSALS = {
  'pin-above-cell': 'This version pins a product that is not in its own part of the project or in a part its label covers, so it is refused. A version may pin only products at its own label or below.'
} as const;
export type ProductCellRefusal = keyof typeof PRODUCT_CELL_REFUSALS;

// A product a pin may name: where it lives and the hashes of its accepted versions.
export interface PinCandidate {
  stream: string;
  product: string;
  hashes: ReadonlySet<string>;
}

// The cell order of ReplicaContext: may the citing stream cite the cited one (write up, never down).
export type CellOrder = (citingStream: string, citedStream: string) => boolean;

// The pin rule (D-18, D-67). Without a cell order nothing is checked, as in Phase 30 and 31. With one, each pin needs a candidate of that product name
// that holds the pinned hash and lives in the version's own stream or in a stream the own cell dominates. A pin nothing here can place counts as above:
// a machine below a cell cannot see the products in it, and every machine must decide the same way (D-23).
export function pinProblem(own: string, pins: ReadonlyArray<{ product: string; hash: string }>, candidates: Iterable<PinCandidate>, cellOrder?: CellOrder): ProductCellRefusal | undefined {
  if (cellOrder === undefined || pins.length === 0) return undefined;
  const list = [...candidates];
  for (const pin of pins) {
    const placed = list.some((candidate) =>
      candidate.product === pin.product && candidate.hashes.has(pin.hash) && (candidate.stream === own || cellOrder(own, candidate.stream) === true));
    if (!placed) return 'pin-above-cell';
  }
  return undefined;
}
