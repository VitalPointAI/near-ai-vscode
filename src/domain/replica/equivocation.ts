// Equivocation proofs (DESIGN 4.4, 4.5; D-12, D-32). Pure, hub-side: no Yjs, no fold, no clock.
//
// Equivocation is one device key signing two different headers at one (stream, writer, seq). The pair is a portable proof: anyone can check it with
// nothing but the two headers and the public key, because the writer id is the hash of that key. A proof never needs the roster to be checked, but
// the fold only acts on a proof whose key is the key the roster knows for that writer, so a stranger cannot quarantine a device by inventing a pair.
//
// Signing the same header twice gives the same bytes (entry.ts fixes signedAt), so a crash and retry is never a fork. Sealing the same body again
// gives a new body.hash, so it is a second signed header at the same seq and is a fork (D-32).
import { canonicalBytes, isStrictBase64url } from '../team/canonical';
import { entryHash, parseHeaderShape, sha256Hex, verifyHeader } from './entry';
import type { EntryHeader } from './entry';
import type { RosterView } from './rosterView';

// Two different signed headers at one (stream, writer, seq), and the key that signed both, so anyone can check the pair alone.
// branches is in memory only (D-01 (b), WR-03): the sorted entry hashes of every header this machine holds at the slot, a and b included, so a
// device.release may name any branch of a fork with three or more. It is a property that is not enumerable (see withBranches), so JSON, canonical
// bytes, proofHash and the wire form never see it, and a proof read from the wire has none.
export interface EquivocationProof { a: EntryHeader; b: EntryHeader; publicKey: string; branches?: readonly string[] }
// From fromSeq on, nothing of this writer in this stream is folded (and nothing in other streams that follows a forked entry).
export interface QuarantineRecord { writer: string; stream: string; fromSeq: number }

const PUBLIC_KEY_BYTES = 32;

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// The proof with its two headers sorted by entry hash, so the same fork gives the same proof on every machine.
export function canonicalProof(a: EntryHeader, b: EntryHeader, publicKey: string): EquivocationProof {
  return entryHash(a) <= entryHash(b) ? { a, b, publicKey } : { a: b, b: a, publicKey };
}

// The same proof with its in-memory list of branches: the given hashes, a and b, and any branches it already had, sorted without duplicates. The
// list is set as a property that is not enumerable, so a proof that carries it is byte for byte the same proof on the wire (P-31-08).
export function withBranches(proof: EquivocationProof, hashes: Iterable<string>): EquivocationProof {
  const all = new Set<string>([entryHash(proof.a), entryHash(proof.b), ...(proof.branches ?? []), ...hashes]);
  const result: EquivocationProof = { a: proof.a, b: proof.b, publicKey: proof.publicKey };
  Object.defineProperty(result, 'branches', { value: Object.freeze([...all].sort(compareText)), enumerable: false, writable: false, configurable: false });
  return result;
}

// The proof as a plain value with parsed headers, or undefined when the input is not shaped like a proof. Whether it proves anything is verifyProof's job.
export function parseProof(value: unknown): EquivocationProof | undefined {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== 3 || !keys.includes('a') || !keys.includes('b') || !keys.includes('publicKey')) return undefined;
    const a = parseHeaderShape(record.a);
    const b = parseHeaderShape(record.b);
    if (!a.ok || !b.ok || typeof record.publicKey !== 'string') return undefined;
    return { a: a.header, b: b.header, publicKey: record.publicKey };
  } catch {
    // A value that cannot be read as a plain proof is not a proof.
    return undefined;
  }
}

// Checks the pair alone: the key hashes to the writer of both headers, both signatures verify, the headers name one stream, writer and seq, and they
// differ. It never throws and takes any input, because a proof arrives inside an entry from outside.
export function verifyProof(proof: unknown): boolean {
  try {
    const read = parseProof(proof);
    if (read === undefined) return false;
    const { a, b, publicKey } = read;
    if (!isStrictBase64url(publicKey, PUBLIC_KEY_BYTES)) return false;
    if (sha256Hex(Buffer.from(publicKey, 'base64url')) !== a.writer) return false;
    if (a.writer !== b.writer || a.stream !== b.stream || a.seq !== b.seq) return false;
    if (entryHash(a) === entryHash(b)) return false;
    return verifyHeader(a, publicKey) && verifyHeader(b, publicKey);
  } catch {
    // Anything that cannot be checked is not a proof.
    return false;
  }
}

// The hash of a proof in its canonical order, so the same fork found twice, or carried twice, counts once.
export function proofHash(proof: EquivocationProof): string {
  const normal = canonicalProof(proof.a, proof.b, proof.publicKey);
  return sha256Hex(canonicalBytes({ a: normal.a, b: normal.b, publicKey: normal.publicKey }));
}

// A proof the fold may act on: it checks out alone, and its key is the key this roster knows for the named writer.
export function acceptableProof(proof: unknown, roster: RosterView): boolean {
  try {
    const read = parseProof(proof);
    if (read === undefined || !verifyProof(read)) return false;
    return roster.deviceKey(read.a.writer)?.publicKey === read.publicKey;
  } catch {
    // The roster view is injected; a failure of it is a refusal, not a crash of the fold.
    return false;
  }
}

// One proof per (stream, writer, seq) with two or more different entry hashes: the two lowest hashes, signed with the key the roster knows, with every
// hash at the slot as its in-memory branches. A device the roster does not know yet gives no proof here (its entries are held unknown-writer).
export function findEquivocations(verified: ReadonlyArray<{ hash: string; header: EntryHeader }>, roster: RosterView): EquivocationProof[] {
  const slots = new Map<string, Map<string, EntryHeader>>();
  for (const entry of verified) {
    const key = `${entry.header.stream}/${entry.header.writer}/${entry.header.seq}`;
    let slot = slots.get(key);
    if (slot === undefined) {
      slot = new Map();
      slots.set(key, slot);
    }
    slot.set(entry.hash, entry.header);
  }
  const proofs = new Map<string, EquivocationProof>();
  for (const slot of slots.values()) {
    if (slot.size < 2) continue;
    const [first, second] = [...slot.entries()].sort((x, y) => compareText(x[0], y[0])).slice(0, 2);
    const publicKey = roster.deviceKey(first[1].writer)?.publicKey;
    if (publicKey === undefined) continue;
    const proof = withBranches(canonicalProof(first[1], second[1], publicKey), slot.keys());
    proofs.set(proofHash(proof), proof);
  }
  return [...proofs.values()].sort((x, y) => compareText(proofHash(x), proofHash(y)));
}

// Has the roster resolved this fork with a device.release choice of one of its branches (D-20)? Any branch counts: a or b, or any hash in the
// proof's in-memory branches. A proof read from the wire has only a and b until the chain stage adds the branches this machine holds.
export function forkChosen(proof: EquivocationProof, roster: RosterView): string | undefined {
  const chosen = roster.chosenBranch(proof.a.writer, proof.a.stream, proof.a.seq);
  if (chosen === undefined) return undefined;
  return chosen === entryHash(proof.a) || chosen === entryHash(proof.b) || (proof.branches ?? []).includes(chosen) ? chosen : undefined;
}

// How one fork slot stands: chosen is the branch kept from that seq on, or undefined when nothing is kept there (an unresolved fork, or a later slot
// where no branch follows the kept one).
export interface ForkResolution { writer: string; stream: string; seq: number; resolved: boolean; chosen: string | undefined }
export interface ForkStanding { resolutions: ForkResolution[]; quarantined: QuarantineRecord[] }

// How the forks of every forked (writer, stream) stand (D-01 (b), D-20), taken in seq order. A fork slot is resolved when the roster chose one of its
// branches (forkChosen); after an earlier slot of the same log is resolved, only a choice of a branch that may follow the kept history counts. Once
// an earlier slot is resolved, a later slot is also resolved when at most one of its branches follows the branch kept before it: the others only
// continue histories the release already set aside, so one device.release resolves a fork whose branches each went on. A branch whose past cannot be traced through the headers given (held) and the proofs' own headers counts as possibly kept,
// so doubt keeps the quarantine. From the first slot that is not resolved on, the writer is quarantined in that stream, and later slots are not
// listed (everything from that seq on is excluded anyway). The result depends only on the proofs, the headers and the roster.
export function forkStanding(proofs: readonly EquivocationProof[], roster: RosterView, held: ReadonlyMap<string, EntryHeader> = new Map()): ForkStanding {
  const headers = new Map(held);
  const logs = new Map<string, Map<number, { first: EquivocationProof; branches: Set<string> }>>();
  for (const proof of proofs) {
    const log = `${proof.a.writer}/${proof.a.stream}`;
    let slots = logs.get(log);
    if (slots === undefined) {
      slots = new Map();
      logs.set(log, slots);
    }
    let slot = slots.get(proof.a.seq);
    if (slot === undefined) {
      slot = { first: proof, branches: new Set() };
      slots.set(proof.a.seq, slot);
    }
    for (const header of [proof.a, proof.b]) {
      headers.set(entryHash(header), header);
      slot.branches.add(entryHash(header));
    }
    for (const hash of proof.branches ?? []) slot.branches.add(hash);
  }

  const resolutions: ForkResolution[] = [];
  const quarantined: QuarantineRecord[] = [];
  for (const slots of logs.values()) {
    const seqs = [...slots.keys()].sort((x, y) => x - y);
    const survivors = new Map<number, string | undefined>();
    const memo = new Map<string, boolean | undefined>();
    // Does the entry with this hash, at this seq, lie on the history kept by every resolved slot before it? undefined: this machine cannot tell.
    const kept = (start: string, startSeq: number): boolean | undefined => {
      const path: string[] = [];
      let hash = start;
      let seq = startSeq;
      let answer: boolean | undefined;
      for (;;) {
        if (memo.has(hash)) {
          answer = memo.get(hash);
          break;
        }
        // Before the first fork of this log there is one history.
        if (seq < seqs[0]) {
          answer = true;
          break;
        }
        if (survivors.has(seq)) {
          if (hash === survivors.get(seq)) {
            answer = true;
            break;
          }
          if ((slots.get(seq) as { branches: Set<string> }).branches.has(hash)) {
            answer = false;
            break;
          }
        }
        const header = headers.get(hash);
        if (header === undefined) {
          answer = undefined;
          break;
        }
        path.push(hash);
        hash = header.prev;
        seq -= 1;
      }
      for (const step of path) memo.set(step, answer);
      return answer;
    };

    for (const seq of seqs) {
      const slot = slots.get(seq) as { first: EquivocationProof; branches: Set<string> };
      const { writer, stream } = slot.first.a;
      let chosen = forkChosen(withBranches(slot.first, slot.branches), roster);
      // After a release, a choice at a later slot counts only for a branch that may follow the kept history: choosing a set-aside branch there is no
      // way out of a new fork on the kept one.
      if (chosen !== undefined && survivors.size > 0) {
        const header = headers.get(chosen);
        if (header !== undefined && kept(header.prev, seq - 1) === false) chosen = undefined;
      }
      let resolved = chosen !== undefined;
      if (!resolved && survivors.size > 0) {
        const live = [...slot.branches].sort(compareText).filter((hash) => {
          const header = headers.get(hash);
          return header === undefined || kept(header.prev, seq - 1) !== false;
        });
        if (live.length <= 1) {
          resolved = true;
          chosen = live[0];
        }
      }
      resolutions.push({ writer, stream, seq, resolved, chosen: resolved ? chosen : undefined });
      if (!resolved) {
        quarantined.push({ writer, stream, fromSeq: seq });
        break;
      }
      survivors.set(seq, chosen);
    }
  }
  const byLog = (x: { writer: string; stream: string }, y: { writer: string; stream: string }): number => compareText(x.writer, y.writer) || compareText(x.stream, y.stream);
  return {
    resolutions: resolutions.sort((x, y) => byLog(x, y) || x.seq - y.seq),
    quarantined: quarantined.sort(byLog)
  };
}

// One record per forked (writer, stream): the lowest forked seq whose fork is not resolved (forkStanding). Sorted by writer, stream.
export function quarantineRecords(proofs: readonly EquivocationProof[], roster: RosterView, held?: ReadonlyMap<string, EntryHeader>): QuarantineRecord[] {
  return forkStanding(proofs, roster, held).quarantined;
}
