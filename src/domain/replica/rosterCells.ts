// Cells, their epochs and the grants that carry each epoch key (DESIGN 8.2; D-21, D-22, D-44, D-45). Hub-side and pure: no clock, no I/O. The roster
// driver (roster.ts) routes the cell kinds and the genesis cells here, and hands every grant it has read and placed on the roster line to addGrant.
//
// A cell's stream id is its cell id; the base cell's id is the project id, which is also the roster stream (31-RESEARCH.md A1). Epochs start at 1
// (A3). Each epoch is founded by a roster entry (the genesis cells, cell.create or cell.rekey) that commits to its founding grant by hash (D-44).
// Records carry the position they start at, so every query answers at a position.
//
// cell.create founds epoch 1 of a new cell and cell.rekey the next epoch of an existing one; each must name its epoch and commit to its founding grant
// by hash (the wire allows both to be absent so Phase 30 data stays valid, the fold does not). Who may write them is the driver's check (a roster
// writer at the roster the entry cites). The grants themselves arrive outside the streams and are placed by addGrant after the line is folded.
//
// The signed grant is the authority for who is on a cell (31-RESEARCH.md): clearance dominance needs a clock and a scale table, so the fold never
// recomputes it. The host decides who is cleared when it writes a grant (cellKeys.planRekey).
import type { CellGrant } from './cellKeys';
import type { VerifiedEntry } from './verify';

export const CELL_REFUSALS = {
  'cell-exists': 'This cell is already in the roster.',
  'cell-unknown': 'This cell is not in the roster, so it cannot be given a new key.',
  'grant-missing': 'This roster entry starts a new cell key without naming its epoch and the grant that carries the key, so it is refused.',
  'epoch-not-next': 'The epoch is not the next one for this cell, so it is refused.',
  'grant-mismatch': 'This grant is not the one the roster committed to for this cell and epoch.',
  'grant-signer': 'This grant was not signed by a device of the staff lead at the roster it names.',
  'grant-recipient': 'This grant gives the key to a device that was not admitted at the roster it names.',
  'grant-epoch-unknown': 'This grant is for a cell or epoch the roster did not have at the roster it names.'
} as const;
export type CellRefusal = keyof typeof CELL_REFUSALS;
export type CellApplyOutcome = { status: 'applied' } | { status: 'refused'; reason: CellRefusal | 'roster-kind-pending' };

export interface EpochRecord {
  epoch: number;
  // sha256 of the founding grant the roster entry committed to.
  grant: string;
  // The roster the founding entry cites: the founding grant names this roster.
  roster: string;
  // The position of the founding entry: the epoch is the cell's current one from here.
  from: number;
}
// founding: the grant the epoch's founding entry committed to. Without it this machine does not know who holds the epoch.
export interface GrantRecord { hash: string; epoch: number; writers: readonly string[]; grant: CellGrant; from: number; founding: boolean }
export interface CellRecord { cell: string; from: number; epochs: EpochRecord[]; grants: GrantRecord[] }
export interface CellsState { project: string; cells: Map<string, CellRecord> }

// position is the position the founding entry takes; roster is the roster hash it cites.
export interface CellApplyContext { position: number; roster: string }

export function createCellsState(project: string): CellsState {
  return { project, cells: new Map() };
}

const refused = (reason: CellRefusal | 'roster-kind-pending'): CellApplyOutcome => ({ status: 'refused', reason });

// ---- queries ----

// The cell's current epoch at the position, or undefined when the cell does not exist there.
export function epochAt(state: CellsState, cell: string, position: number): number | undefined {
  const record = state.cells.get(cell);
  if (record === undefined || record.from > position) return undefined;
  let current: number | undefined;
  for (const epoch of record.epochs) if (epoch.from <= position) current = epoch.epoch;
  return current;
}

// The devices holding a wrap for the cell's current epoch at the position, sorted. admitted (the members module's answer at the same position) drops
// a device that is not admitted there, so a device removed or revoked after its grant is never listed. Undefined when this machine does not know
// the cell at the position: the cell does not exist there, or the founding grant of its current epoch is not on this machine (a member below the
// cell never receives it, D-22), so a device that holds only the roster learns that a cell id exists and nothing about who holds it.
export function granteesAt(state: CellsState, cell: string, position: number, admitted: (writer: string) => boolean): readonly string[] | undefined {
  const epoch = epochAt(state, cell, position);
  const record = state.cells.get(cell);
  if (epoch === undefined || record === undefined) return undefined;
  const current = record.grants.filter((grant) => grant.epoch === epoch && grant.from <= position);
  if (!current.some((grant) => grant.founding)) return undefined;
  const writers = new Set<string>();
  for (const grant of current) for (const writer of grant.writers) if (admitted(writer)) writers.add(writer);
  return [...writers].sort();
}

// Every epoch of the cell founded at or before the position, oldest first, with the founding grant hash. Empty when the cell does not exist there.
// The host reads it to give a device admitted later the earlier epochs it is cleared for (D-45).
export function epochsAt(state: CellsState, cell: string, position: number): ReadonlyArray<{ epoch: number; grant: string; from: number }> {
  const record = state.cells.get(cell);
  if (record === undefined || record.from > position) return [];
  return record.epochs.filter((epoch) => epoch.from <= position).map((epoch) => ({ epoch: epoch.epoch, grant: epoch.grant, from: epoch.from }));
}

// The cell a stream belongs to: a cell's stream id is its cell id.
export function cellOfStream(state: CellsState, stream: string): string | undefined {
  return state.cells.has(stream) ? stream : undefined;
}

// The founding grant hash the roster committed to for the cell and epoch.
export function committedGrant(state: CellsState, cell: string, epoch: number): string | undefined {
  return state.cells.get(cell)?.epochs.find((record) => record.epoch === epoch)?.grant;
}

// ---- apply rules ----

// The genesis founds epoch 1 of each cell it names (D-07, D-44). Validates every cell first and changes the state only when all apply.
export function applyGenesisCells(state: CellsState, cells: ReadonlyArray<{ cell: string; epoch: number; grant: string }>, ctx: CellApplyContext): CellApplyOutcome {
  for (const item of cells) {
    if (state.cells.has(item.cell)) return refused('cell-exists');
    if (item.epoch !== 1) return refused('epoch-not-next');
  }
  for (const item of cells) {
    state.cells.set(item.cell, { cell: item.cell, from: ctx.position, epochs: [{ epoch: 1, grant: item.grant, roster: ctx.roster, from: ctx.position }], grants: [] });
  }
  return { status: 'applied' };
}

interface CellEntryData { cell: string; epoch?: number; grant?: string; reason?: string }

// cell.create founds epoch 1 of a cell the roster does not have; cell.rekey founds the epoch after the cell's current one (D-21, D-23, D-44). Both
// must name the epoch and commit to the founding grant by hash. The entry is validated before anything changes, so a refusal changes nothing.
export function applyCellEntry(state: CellsState, entry: VerifiedEntry, ctx: CellApplyContext): CellApplyOutcome {
  const kind = entry.body.kind;
  const data = entry.data as CellEntryData;
  if (kind === 'cell.create') {
    if (state.cells.has(data.cell)) return refused('cell-exists');
    if (data.epoch !== 1) return refused('epoch-not-next');
    if (data.grant === undefined) return refused('grant-missing');
    state.cells.set(data.cell, { cell: data.cell, from: ctx.position, epochs: [{ epoch: 1, grant: data.grant, roster: ctx.roster, from: ctx.position }], grants: [] });
    return { status: 'applied' };
  }
  if (kind === 'cell.rekey') {
    const record = state.cells.get(data.cell);
    const current = epochAt(state, data.cell, ctx.position - 1);
    if (record === undefined || current === undefined) return refused('cell-unknown');
    if (data.epoch !== current + 1) return refused('epoch-not-next');
    if (data.grant === undefined) return refused('grant-missing');
    record.epochs.push({ epoch: data.epoch, grant: data.grant, roster: ctx.roster, from: ctx.position });
    return { status: 'applied' };
  }
  // The driver routes only the cell kinds here.
  return refused('roster-kind-pending');
}

// What the driver knows about a grant it hands over: the grant read and verified by readGrant, its hash, the position of the roster it names, whether
// its signer was a roster writer there, and which devices were admitted there.
export interface GrantPlacement {
  grant: CellGrant;
  hash: string;
  position: number;
  signerIsRosterWriter: boolean;
  admitted(writer: string): boolean;
}

// Places one grant (D-44, D-45). A founding grant is the one whose hash an epoch's founding entry committed to; it must name the roster that entry
// cites and counts from the founding position. Any other grant for an existing epoch counts from the position of the roster it names. In both, the
// signer must be a roster writer at that roster and every wrap must name a device admitted there. A grant at the founding roster whose hash is not
// the commitment is refused grant-mismatch: the founding grant is the only grant at that roster.
export function addGrant(state: CellsState, placement: GrantPlacement): CellApplyOutcome {
  const { grant, hash, position } = placement;
  const record = state.cells.get(grant.cell);
  const epoch = record?.epochs.find((candidate) => candidate.epoch === grant.epoch);
  if (record === undefined || epoch === undefined) return refused('grant-epoch-unknown');
  if (record.grants.some((known) => known.hash === hash)) return { status: 'applied' };
  const founding = epoch.grant === hash;
  if (founding && grant.roster !== epoch.roster) return refused('grant-mismatch');
  if (!founding && grant.roster === epoch.roster) return refused('grant-mismatch');
  if (!founding && position < epoch.from) return refused('grant-epoch-unknown');
  if (!placement.signerIsRosterWriter) return refused('grant-signer');
  if (!grant.wraps.every((wrap) => placement.admitted(wrap.writer))) return refused('grant-recipient');
  record.grants.push({ hash, epoch: grant.epoch, writers: grant.wraps.map((wrap) => wrap.writer), grant, from: founding ? epoch.from : position, founding });
  return { status: 'applied' };
}
