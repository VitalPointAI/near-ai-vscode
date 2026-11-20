// Cells, their epochs and the grants that carry each epoch key (DESIGN 8.2; D-21, D-22, D-44, D-45). Hub-side and pure: no clock, no I/O. The roster
// driver (roster.ts) routes the cell kinds and the genesis cells here, and hands every grant it has read and placed on the roster line to addGrant.
//
// A cell's stream id is its cell id; the base cell's id is the project id, which is also the roster stream (31-RESEARCH.md A1). Epochs start at 1
// (A3). Each epoch is founded by a roster entry (the genesis cells, cell.create or cell.rekey) that commits to its founding grant by hash (D-44).
// Records carry the position they start at, so every query answers at a position.
//
// Owner of the apply rules: 31-12 (this file's first version) applies the genesis cells and checks grants; cell.create and cell.rekey are refused
// roster-kind-pending until 31-15 adds their rules. A pending kind is refused, never applied.
import type { CellGrant } from './cellKeys';
import type { VerifiedEntry } from './verify';

export const CELL_REFUSALS = {
  'cell-exists': 'This cell is already in the roster.',
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
export interface GrantRecord { hash: string; epoch: number; writers: readonly string[]; grant: CellGrant; from: number }
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

// The devices holding a wrap for the cell's current epoch at the position, sorted. admitted, when given, drops a device that is not admitted there.
// Undefined when the cell does not exist at the position.
export function granteesAt(state: CellsState, cell: string, position: number, admitted?: (writer: string) => boolean): readonly string[] | undefined {
  const epoch = epochAt(state, cell, position);
  const record = state.cells.get(cell);
  if (epoch === undefined || record === undefined) return undefined;
  const writers = new Set<string>();
  for (const grant of record.grants) {
    if (grant.epoch !== epoch || grant.from > position) continue;
    for (const writer of grant.writers) if (admitted === undefined || admitted(writer)) writers.add(writer);
  }
  return [...writers].sort();
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

// cell.create and cell.rekey: 31-15 adds their rules.
export function applyCellEntry(_state: CellsState, _entry: VerifiedEntry, _ctx: CellApplyContext): CellApplyOutcome {
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
  record.grants.push({ hash, epoch: grant.epoch, writers: grant.wraps.map((wrap) => wrap.writer), grant, from: founding ? epoch.from : position });
  return { status: 'applied' };
}
