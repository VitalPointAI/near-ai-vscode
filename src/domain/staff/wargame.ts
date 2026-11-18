// The wargame ledger (design 10, 4.6; UX concept 5.7 and 12.5; WP-SHARED). Pure: no I/O, no clock, no vscode.
//
// A wargame is recorded one phase at a time: in each turn the friendly ACTION, the adversary REACTION (the J2 red cell playing to win), then the friendly
// COUNTERACTION, for one friendly COA against one adversary COA. The ledger refuses a phase out of that order or a move by the wrong side, so the record
// is always a well-formed game. The synchronization matrix rows, the DST and DSM entries and the branch list are derived from it directly, so nothing is
// retyped (design 10, 4.6, "wargame ledger to products"), and each phase is also sent as a `staff.wargame.turn` event for the wargame view and replay.
import type { WargameMove, WargamePhase, WargameSide, WargameTurnEvent } from './events';
import { isOneLine, isRecord, ownValue, STAFF_SLUG } from './parse';
import type { RegisterRow } from './registers';

export const WARGAME_PHASES: readonly WargamePhase[] = ['action', 'reaction', 'counteraction'];
/** Who moves in each phase. */
export const PHASE_SIDE: Readonly<Record<WargamePhase, WargameSide>> = { action: 'friendly', reaction: 'adversary', counteraction: 'friendly' };

export interface WargameDecisionPoint {
  readonly id: string;
  readonly description: string;
  readonly decisionMaker: string;
  readonly indicator?: string;
  readonly nai?: string;
  readonly pir?: string;
  readonly recommendedAction?: string;
}

/** A synchronization matrix entry the phase produced, by row. */
export interface WargameSyncEntry { readonly row: string; readonly entry: string; readonly section?: string }

export interface WargameEntry {
  readonly coa: string;
  readonly enemyCoa: string;
  readonly turn: number;
  readonly phase: WargamePhase;
  readonly hHourOffsetMinutes: number;
  readonly moves: readonly WargameMove[];
  readonly results: readonly string[];
  readonly decisionPoints: readonly WargameDecisionPoint[];
  readonly sync: readonly WargameSyncEntry[];
  /** Branches the phase showed a need for. */
  readonly branches: readonly string[];
  /** The member who recorded it, and when. */
  readonly recordedBy: string;
  readonly at: string;
}

const MAX_ITEMS = 40;
const MAX_TEXT = 300;
const MAX_TURNS = 200;
const COORD_LIMIT = 1e7;
const DP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const SIDC = /^[0-9A-Za-z*-]{10,30}$/;

export type WargameCheck<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

function texts(value: unknown, what: string): WargameCheck<string[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value) || value.length > MAX_ITEMS || !value.every((item) => isOneLine(item, MAX_TEXT))) return { ok: false, message: `${what} must be a list of at most ${MAX_ITEMS} lines of text.` };
  return { ok: true, value: value.map((item: string) => item.trim()) };
}

/** Reads the phase a member wants to record (everything except who and when), strictly. */
export function parseWargamePhase(raw: unknown): WargameCheck<Omit<WargameEntry, 'recordedBy' | 'at'>> {
  if (!isRecord(raw)) return { ok: false, message: 'The phase must be a set of named fields.' };
  const allowed = ['coa', 'enemyCoa', 'turn', 'phase', 'hHourOffsetMinutes', 'moves', 'results', 'decisionPoints', 'sync', 'branches'];
  const unknown = Object.keys(raw).find((key) => !allowed.includes(key));
  if (unknown) return { ok: false, message: `"${unknown.slice(0, 40)}" is not a wargame field. The fields are ${allowed.join(', ')}.` };
  const coa = ownValue(raw, 'coa');
  const enemyCoa = ownValue(raw, 'enemyCoa');
  if (typeof coa !== 'string' || !STAFF_SLUG.test(coa) || typeof enemyCoa !== 'string' || !STAFF_SLUG.test(enemyCoa)) return { ok: false, message: 'coa and enemyCoa are product slugs such as coa-1 and enemy-mlcoa.' };
  const turn = ownValue(raw, 'turn');
  if (!Number.isSafeInteger(turn) || (turn as number) < 1 || (turn as number) > MAX_TURNS) return { ok: false, message: `turn is a whole number from 1 to ${MAX_TURNS}.` };
  const phase = ownValue(raw, 'phase');
  if (!WARGAME_PHASES.includes(phase as WargamePhase)) return { ok: false, message: 'phase is action, reaction or counteraction.' };
  const offset = ownValue(raw, 'hHourOffsetMinutes');
  if (!Number.isSafeInteger(offset) || Math.abs(offset as number) > 60 * 24 * 365) return { ok: false, message: 'hHourOffsetMinutes is a whole number of minutes from H-hour (negative before it).' };
  const side = PHASE_SIDE[phase as WargamePhase];
  const movesRaw = ownValue(raw, 'moves') ?? [];
  if (!Array.isArray(movesRaw) || movesRaw.length > MAX_ITEMS) return { ok: false, message: `moves is a list of at most ${MAX_ITEMS} moves.` };
  const moves: WargameMove[] = [];
  for (const move of movesRaw) {
    if (!isRecord(move)) return { ok: false, message: 'Each move is a set of named fields: unit, side, path and optionally sidc.' };
    const unit = ownValue(move, 'unit');
    const moveSide = ownValue(move, 'side') ?? side;
    const path = ownValue(move, 'path') ?? [];
    const sidc = ownValue(move, 'sidc');
    if (!isOneLine(unit, 80)) return { ok: false, message: 'Each move names its unit in one line.' };
    if (moveSide !== side) return { ok: false, message: `In the ${String(phase)} phase only the ${side} side moves (${String(unit).slice(0, 40)} is ${String(moveSide)}).` };
    if (!Array.isArray(path) || path.length > 200 || !path.every((point) => Array.isArray(point) && point.length === 2 && point.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < COORD_LIMIT))) {
      return { ok: false, message: 'A move\'s path is a list of [x, y] points.' };
    }
    if (sidc !== undefined && (typeof sidc !== 'string' || !SIDC.test(sidc))) return { ok: false, message: 'sidc is a symbol identification code of 10 to 30 letters and digits.' };
    moves.push({ unit: unit.trim(), side, path: path.map((point: number[]) => [point[0], point[1]] as const), ...(sidc ? { sidc } : {}) });
  }
  const results = texts(ownValue(raw, 'results'), 'results');
  if (!results.ok) return results;
  const branches = texts(ownValue(raw, 'branches'), 'branches');
  if (!branches.ok) return branches;
  const pointsRaw = ownValue(raw, 'decisionPoints') ?? [];
  if (!Array.isArray(pointsRaw) || pointsRaw.length > MAX_ITEMS) return { ok: false, message: 'decisionPoints is a list.' };
  const decisionPoints: WargameDecisionPoint[] = [];
  for (const point of pointsRaw) {
    if (!isRecord(point)) return { ok: false, message: 'Each decision point is a set of named fields.' };
    const id = ownValue(point, 'id');
    if (typeof id !== 'string' || !DP_ID.test(id) || !isOneLine(ownValue(point, 'description'), MAX_TEXT) || !isOneLine(ownValue(point, 'decisionMaker'), 80)) {
      return { ok: false, message: 'Each decision point needs an id, a description and the decision maker (a role, never a member: members do not decide).' };
    }
    const optional = (key: string): Record<string, string> => (isOneLine(ownValue(point, key), MAX_TEXT) ? { [key]: (ownValue(point, key) as string).trim() } : {});
    decisionPoints.push({ id, description: (ownValue(point, 'description') as string).trim(), decisionMaker: (ownValue(point, 'decisionMaker') as string).trim(), ...optional('indicator'), ...optional('nai'), ...optional('pir'), ...optional('recommendedAction') });
  }
  const syncRaw = ownValue(raw, 'sync') ?? [];
  if (!Array.isArray(syncRaw) || syncRaw.length > MAX_ITEMS) return { ok: false, message: 'sync is a list of { row, entry } items.' };
  const sync: WargameSyncEntry[] = [];
  for (const item of syncRaw) {
    if (!isRecord(item) || !isOneLine(ownValue(item, 'row'), 40) || !isOneLine(ownValue(item, 'entry'), MAX_TEXT)) return { ok: false, message: 'Each sync item names its row and its entry.' };
    sync.push({ row: (ownValue(item, 'row') as string).trim(), entry: (ownValue(item, 'entry') as string).trim(), ...(isOneLine(ownValue(item, 'section'), 20) ? { section: ownValue(item, 'section') as string } : {}) });
  }
  return { ok: true, value: { coa, enemyCoa, turn: turn as number, phase: phase as WargamePhase, hHourOffsetMinutes: offset as number, moves, results: results.value, decisionPoints, sync, branches: branches.value } };
}

/** The phase that must come next in one game (one COA against one adversary COA), given the phases recorded so far. */
export function nextPhase(entries: readonly WargameEntry[], coa: string, enemyCoa: string): { readonly turn: number; readonly phase: WargamePhase } {
  const game = entries.filter((entry) => entry.coa === coa && entry.enemyCoa === enemyCoa);
  const last = game[game.length - 1];
  if (!last) return { turn: 1, phase: 'action' };
  const index = WARGAME_PHASES.indexOf(last.phase);
  return index === WARGAME_PHASES.length - 1 ? { turn: last.turn + 1, phase: 'action' } : { turn: last.turn, phase: WARGAME_PHASES[index + 1] };
}

/** Whether a phase may be recorded now: the next one in order for its game. */
export function checkOrder(entries: readonly WargameEntry[], phase: Pick<WargameEntry, 'coa' | 'enemyCoa' | 'turn' | 'phase'>): string | undefined {
  const next = nextPhase(entries, phase.coa, phase.enemyCoa);
  if (next.turn === phase.turn && next.phase === phase.phase) return undefined;
  return `The next phase of ${phase.coa} against ${phase.enemyCoa} is turn ${next.turn} ${next.phase.toUpperCase()}, not turn ${phase.turn} ${phase.phase.toUpperCase()}.`;
}

export function wargameTurnEvent(entry: WargameEntry, run: string): WargameTurnEvent {
  return {
    type: 'staff.wargame.turn', run, at: entry.at, coa: entry.coa, enemyCoa: entry.enemyCoa, turn: entry.turn, phase: entry.phase,
    hHourOffsetMinutes: entry.hHourOffsetMinutes, moves: entry.moves, results: entry.results, decisionPoints: entry.decisionPoints.map((point) => point.id)
  };
}

const SYNC_ROWS = ['enemy', 'collection', 'manoeuvre', 'fires', 'sustainment', 'information', 'protection', 'decision-points'];

export interface WargameProducts {
  /** Rows for the `sync-matrix` register. */
  readonly sync: RegisterRow[];
  /** Rows for the `dst-dsm` register. */
  readonly dsm: RegisterRow[];
  /** The branches the game showed, once each, in the order they appeared. */
  readonly branches: string[];
}

/**
 * The synchronization matrix, the DST and DSM and the branch list, derived from the recorded games. Moves give enemy and manoeuvre rows, the phase's own
 * sync items give theirs, and each decision point gives a decision-points row and one DSM row (its latest description wins when a later phase repeats it).
 */
export function deriveFromWargame(entries: readonly WargameEntry[]): WargameProducts {
  const sync: RegisterRow[] = [];
  const dsm = new Map<string, RegisterRow>();
  const branches: string[] = [];
  for (const entry of entries) {
    const key = `${entry.coa}-t${entry.turn}-${entry.phase.slice(0, 1)}`;
    let n = 0;
    const add = (row: string, text: string, section?: string): void => {
      if (!SYNC_ROWS.includes(row)) return;
      n += 1;
      sync.push({ id: `${key}-${n}`.slice(0, 40), row, hHourOffsetMinutes: entry.hHourOffsetMinutes, entry: text.slice(0, 500), coa: entry.coa, ...(section ? { section } : {}) });
    };
    for (const move of entry.moves) add(move.side === 'adversary' ? 'enemy' : 'manoeuvre', `${move.unit} moves (${entry.phase}, turn ${entry.turn}, against ${entry.enemyCoa})`);
    for (const item of entry.sync) add(item.row, item.entry, item.section);
    for (const point of entry.decisionPoints) {
      add('decision-points', `${point.id}: ${point.description}`);
      dsm.set(point.id, {
        id: point.id, description: point.description, decisionMaker: point.decisionMaker, coa: entry.coa,
        ...(point.indicator ? { indicator: point.indicator } : {}), ...(point.nai ? { nai: point.nai } : {}), ...(point.pir ? { pir: point.pir } : {}),
        ...(point.recommendedAction ? { recommendedAction: point.recommendedAction } : {})
      });
    }
    for (const branch of entry.branches) if (!branches.includes(branch)) branches.push(branch);
  }
  return { sync, dsm: [...dsm.values()], branches };
}
