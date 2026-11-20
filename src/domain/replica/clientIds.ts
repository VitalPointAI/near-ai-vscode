// Yjs client ids bound to their writer (D-41, refining D-03). Pure and hub-side: it imports nothing, so the hub compiles it without Yjs.
//
// Every device gets a roster slot from 1 to 4095 that is never reused. Its client ids are slot * 2^20 + counter, with counter from 0 to 2^20 - 1, so
// two devices never share an id and the owner of an id is read from the id itself. The smallest id is 2^20, so 0 (the fold document's own id) is
// never a device's. The arithmetic is multiplication and integer division only: JavaScript shift operators are signed above 2^31, and slot 2048 and
// higher would turn negative.

export const CLIENT_COUNTER_BITS = 20;
// 2^20, written as a number so no shift operator is involved.
export const CLIENT_COUNTER_SPAN = 1048576;
export const MAX_SLOT = 4095;
// The largest id a slot can produce: 4095 * 2^20 + 2^20 - 1 = 4294967295, the largest unsigned 32-bit integer Yjs accepts.
const MAX_ID = MAX_SLOT * CLIENT_COUNTER_SPAN + CLIENT_COUNTER_SPAN - 1;

export function isSlot(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_SLOT;
}

const isCounter = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < CLIENT_COUNTER_SPAN;

// The client id for a slot and counter. Throws on a value out of range; it is for this device's own editor, never for values read from an entry.
export function clientIdOf(slot: number, counter: number): number {
  if (!isSlot(slot)) throw new Error(`clientIdOf: slot must be a whole number from 1 to ${MAX_SLOT}, got ${String(slot)}`);
  if (!isCounter(counter)) throw new Error(`clientIdOf: counter must be a whole number from 0 to ${CLIENT_COUNTER_SPAN - 1}, got ${String(counter)}`);
  return slot * CLIENT_COUNTER_SPAN + counter;
}

// The slot a client id belongs to, or 0 when the id is in no slot (below 2^20, above the largest id, or not a whole number). Never throws, so a
// reducer may call it on any value an entry carries.
export function slotOfClientId(clientId: number): number {
  if (typeof clientId !== 'number' || !Number.isSafeInteger(clientId) || clientId < CLIENT_COUNTER_SPAN || clientId > MAX_ID) return 0;
  return Math.floor(clientId / CLIENT_COUNTER_SPAN);
}

// The lowest client id of the slot that is not in `used`, or undefined when every counter of the slot is used. Throws on a slot out of range.
// The lowest free counter is at most the number of the slot's ids in `used`, so the walk stops after used.size + 1 counters, never 2^20.
export function nextClientId(slot: number, used: ReadonlySet<number>): number | undefined {
  const base = clientIdOf(slot, 0);
  const last = Math.min(CLIENT_COUNTER_SPAN - 1, used.size);
  for (let counter = 0; counter <= last; counter += 1) {
    if (!used.has(base + counter)) return base + counter;
  }
  return undefined;
}

// Hands out client ids for many registrations without walking the slot each time: it keeps the ids seen as used and, per slot, the lowest counter
// that may still be free. Ids are never given back, so that counter only moves up and each registration costs amortised constant time. The ids it
// gives are exactly those nextClientId would give for the same used set.
export class ClientIdAllocator {
  private readonly used = new Set<number>();
  private readonly lowest = new Map<number, number>();

  public constructor(used: Iterable<number> = []) {
    for (const id of used) this.used.add(id);
  }

  /** Records an id as used (one this device registered, or one read from the log). */
  public markUsed(clientId: number): void {
    this.used.add(clientId);
  }

  /** The lowest unused id of the slot, or undefined when the slot is full. Throws on a slot out of range. */
  public next(slot: number): number | undefined {
    const base = clientIdOf(slot, 0);
    let counter = this.lowest.get(slot) ?? 0;
    while (counter < CLIENT_COUNTER_SPAN && this.used.has(base + counter)) counter += 1;
    this.lowest.set(slot, counter);
    return counter < CLIENT_COUNTER_SPAN ? base + counter : undefined;
  }

  /** next(slot), recorded as used. */
  public take(slot: number): number | undefined {
    const id = this.next(slot);
    if (id !== undefined) this.used.add(id);
    return id;
  }
}
