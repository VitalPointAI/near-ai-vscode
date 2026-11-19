// Notional movement tables and local routing (design 10, 3.5 and 6.2; research note 03, B4, B8 and B12 item 4; WP-LOG). Pure: no I/O, no clock, no
// vscode.
//
// The mobility planner reviews a notional movement table for feasibility: is there lift for each serial's load, and does it arrive by its required
// delivery date. A real deployment database lives in government systems and is never built or imported here (03 B4), so a table that names one is
// refused. Each checked table is kept as a calculator record (kind `movement`), entered in the calculator ledger like any other, so the movement table
// review cites it as calc:<id>. A table is never changed: a revised table is a new record that names the one it supersedes, and the movement board shows
// the newest of each line.
//
// Routing runs on a road graph a person or the mobility planner keeps in the project (.planning/staff/logistics/roads.json): nodes, and edges with their
// length in kilometres. It is a shortest-path search on that file and nothing else, so no route request ever leaves the machine. The design's routing
// engines (OSRM or GraphHopper on an OpenStreetMap extract) stay a later step behind a downloaded extract; this needs no new dependency.
import { checkStaffKeys, isOneLine, isRecord, ownValue, STAFF_SLUG } from '../parse';
import { CALC_RECORD_VERSION, checkRecordHead, formatNumber } from './calculator';
import type { CalcResult, MovementRecord, MovementSerial, RecordStamp } from './calculator';

export const ROADS_FILE = '.planning/staff/logistics/roads.json';
export const MOVEMENT_MODES = ['road', 'rail', 'sea', 'air', 'inland waterway'] as const;

const MAX_SERIALS = 200;
const MAX_NODES = 5000;
const MAX_EDGES = 20_000;
const HOUR = 3_600_000;

const fail = <T>(message: string): CalcResult<T> => ({ ok: false, message });

/** Words that name a real deployment database or its records; a notional table never carries them (03 B4, B12 item 4). */
const REAL_DEPLOYMENT_DATA = /\b(?:TPFDD|TPFDL|JOPES|ULNs?|unit line numbers?)\b/i;

export interface MovementTableInput {
  readonly id: string;
  readonly title: string;
  readonly label?: string;
  readonly supersedes?: string;
  readonly serials: readonly unknown[];
}

const positive = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max;
const nonNegative = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Checks a notional movement table and builds its record: for each serial, lift = assets x capacity each against the load; arrival = ready to move +
 * handling hours + distance / speed, against the required delivery date. Every input is the planner's, and the formula shows each one.
 */
export function checkMovementTable(input: MovementTableInput, stamp: RecordStamp): CalcResult<MovementRecord> {
  const head = checkRecordHead(input);
  if (!head.ok) return head;
  if (input.supersedes !== undefined && (typeof input.supersedes !== 'string' || !STAFF_SLUG.test(input.supersedes) || input.supersedes === head.value.id)) return fail('supersedes is the id of the earlier table this one revises.');
  if (!Array.isArray(input.serials) || input.serials.length === 0 || input.serials.length > MAX_SERIALS) return fail(`serials is a list of 1 to ${MAX_SERIALS} serials.`);
  if (REAL_DEPLOYMENT_DATA.test(JSON.stringify(input))) return fail('This server reviews notional movement tables only. It never builds or imports a real deployment database or its line numbers; that work belongs on government systems. Describe the movement in plain notional terms.');
  const serials: MovementSerial[] = [];
  const formula: string[] = [
    'lift: assets x capacity each, against the load; arrival = ready to move + handling hours + distance / speed, against the required delivery date. Every figure is notional and the planner\'s.'
  ];
  for (const [index, raw] of input.serials.entries()) {
    const where = `Serial ${index + 1}`;
    if (!isRecord(raw)) return fail(`${where} is an object.`);
    const keys = checkStaffKeys(raw, '', ['serial', 'what', 'mode', 'from', 'to', 'load', 'loadUnit', 'lift', 'distanceKm', 'speedKmh', 'ready', 'required'], ['handlingHours']);
    if (keys) return fail(`${where} has serial, what, mode, from, to, load, loadUnit, lift { asset, count, capacityEach }, distanceKm, speedKmh, ready, required and an optional handlingHours (${keys.message}).`);
    for (const key of ['serial', 'what', 'from', 'to', 'loadUnit'] as const) if (!isOneLine(ownValue(raw, key), 120)) return fail(`${where}: ${key} is one line.`);
    const serial = (ownValue(raw, 'serial') as string).trim();
    if (serials.some((entry) => entry.serial === serial)) return fail(`${where}: serial ${serial} is used twice.`);
    const mode = ownValue(raw, 'mode');
    if (!(MOVEMENT_MODES as readonly unknown[]).includes(mode)) return fail(`${where}: mode is one of ${MOVEMENT_MODES.join(', ')}.`);
    const lift = ownValue(raw, 'lift');
    if (!isRecord(lift) || checkStaffKeys(lift, '', ['asset', 'count', 'capacityEach']) || !isOneLine(ownValue(lift, 'asset'), 80)
      || !Number.isInteger(ownValue(lift, 'count')) || !nonNegative(ownValue(lift, 'count'), 100_000) || !positive(ownValue(lift, 'capacityEach'), 1e9)) {
      return fail(`${where}: lift is { asset, count, capacityEach }: the lift asset, a whole number of them, and what each carries in the load's unit.`);
    }
    const load = ownValue(raw, 'load');
    const distance = ownValue(raw, 'distanceKm');
    const speed = ownValue(raw, 'speedKmh');
    const handling = ownValue(raw, 'handlingHours') ?? 0;
    if (!nonNegative(load, 1e12)) return fail(`${where}: load is a number of 0 or more.`);
    if (!nonNegative(distance, 40_000)) return fail(`${where}: distanceKm is the distance in kilometres, 0 to 40,000.`);
    if (!positive(speed, 2000)) return fail(`${where}: speedKmh is the planning speed in kilometres per hour, above 0.`);
    if (!nonNegative(handling, 24 * 365)) return fail(`${where}: handlingHours is the hours to load and unload, 0 or more.`);
    const readyAt = Date.parse(String(ownValue(raw, 'ready')));
    const requiredAt = Date.parse(String(ownValue(raw, 'required')));
    if (typeof ownValue(raw, 'ready') !== 'string' || !Number.isFinite(readyAt)) return fail(`${where}: ready is when the load is ready to move, an ISO time.`);
    if (typeof ownValue(raw, 'required') !== 'string' || !Number.isFinite(requiredAt)) return fail(`${where}: required is the required delivery date, an ISO time.`);
    const count = ownValue(lift, 'count') as number;
    const capacityEach = ownValue(lift, 'capacityEach') as number;
    const loadUnit = (ownValue(raw, 'loadUnit') as string).trim();
    const capacity = count * capacityEach;
    const transitHours = (distance as number) / (speed as number);
    const arrivesAt = readyAt + (handling as number) * HOUR + transitHours * HOUR;
    const slackHours = (requiredAt - arrivesAt) / HOUR;
    const entry: MovementSerial = {
      serial, what: (ownValue(raw, 'what') as string).trim(), mode: mode as string, from: (ownValue(raw, 'from') as string).trim(), to: (ownValue(raw, 'to') as string).trim(),
      load: load as number, loadUnit, lift: { asset: (ownValue(lift, 'asset') as string).trim(), count, capacityEach },
      distanceKm: distance as number, speedKmh: speed as number, handlingHours: handling as number,
      ready: isoOf(readyAt), required: isoOf(requiredAt), arrives: isoOf(arrivesAt),
      liftFeasible: (load as number) <= capacity, timeFeasible: slackHours >= 0, slackHours
    };
    serials.push(entry);
    formula.push(
      `serial ${serial}: lift = ${formatNumber(count)} ${entry.lift.asset} x ${formatNumber(capacityEach)} each = ${formatNumber(capacity)} against a load of ${formatNumber(entry.load)} (in ${loadUnit}): ${entry.liftFeasible ? 'enough lift' : `short by ${formatNumber(entry.load - capacity)}`}`,
      `serial ${serial}: arrival = ${entry.ready} + ${formatNumber(entry.handlingHours)} h handling + ${formatNumber(entry.distanceKm)} km / ${formatNumber(entry.speedKmh)} km/h (${formatNumber(transitHours)} h) = ${entry.arrives}, against ${entry.required}: ${entry.timeFeasible ? `${formatNumber(slackHours)} h to spare` : `${formatNumber(-slackHours)} h late`}`
    );
  }
  return {
    ok: true,
    value: {
      v: CALC_RECORD_VERSION, id: head.value.id, kind: 'movement', title: head.value.title, label: head.value.label, ...stamp, formula,
      notional: true, ...(input.supersedes ? { supersedes: input.supersedes } : {}), serials
    }
  };
}

export interface MovementBoardRow {
  readonly table: string;
  readonly serial: MovementSerial;
  readonly feasible: boolean;
}

/** The movement board: the newest table of each line (a table another one supersedes is left out), every serial with its feasibility. */
export function movementBoard(tables: readonly MovementRecord[]): { rows: MovementBoardRow[]; superseded: string[] } {
  const superseded = new Set(tables.flatMap((table) => (table.supersedes ? [table.supersedes] : [])));
  const rows: MovementBoardRow[] = [];
  for (const table of [...tables].sort((a, b) => a.at.localeCompare(b.at))) {
    if (superseded.has(table.id)) continue;
    for (const serial of table.serials) rows.push({ table: table.id, serial, feasible: serial.liftFeasible && serial.timeFeasible });
  }
  return { rows, superseded: [...superseded].filter((id) => tables.some((table) => table.id === id)).sort() };
}

const cell = (text: string): string => text.replace(/\|/g, '/').replace(/\s+/g, ' ');

export function movementBoardMarkdown(board: { rows: MovementBoardRow[]; superseded: string[] }): string {
  if (!board.rows.length) return 'No notional movement table has been checked yet.';
  const lines = ['| Serial | What | Mode | From | To | Lift | Arrives | Required delivery date | Feasible | Calculator record |', '|---|---|---|---|---|---|---|---|---|---|'];
  for (const row of board.rows) {
    const s = row.serial;
    const why = row.feasible ? 'yes' : [s.liftFeasible ? '' : 'lift short', s.timeFeasible ? '' : `${formatNumber(-s.slackHours)} h late`].filter(Boolean).join(', ');
    lines.push(`| ${[s.serial, s.what, s.mode, s.from, s.to, `${s.lift.count} x ${s.lift.asset}`, s.arrives, s.required, row.feasible ? 'yes' : `no: ${why}`, `calc:${row.table}`].map(cell).join(' | ')} |`);
  }
  if (board.superseded.length) lines.push('', `Superseded tables, not shown: ${board.superseded.join(', ')}.`);
  return lines.join('\n');
}

// ---- Local routing -----------------------------------------------------------------------------------------------------------------------------

export interface RoadGraph {
  readonly nodes: ReadonlyArray<{ readonly id: string; readonly name?: string }>;
  readonly edges: ReadonlyArray<{ readonly from: string; readonly to: string; readonly km: number; readonly oneWay?: boolean; readonly closed?: boolean; readonly name?: string }>;
}

/** Reads the road graph strictly: known nodes on every edge, lengths in kilometres. */
export function parseRoadGraph(text: string): CalcResult<RoadGraph> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return fail(`${ROADS_FILE} is not valid JSON.`); }
  if (!isRecord(value) || checkStaffKeys(value, '', ['nodes', 'edges'])) return fail(`${ROADS_FILE} has two lists, nodes and edges.`);
  const nodes = ownValue(value, 'nodes');
  const edges = ownValue(value, 'edges');
  if (!Array.isArray(nodes) || nodes.length > MAX_NODES || !Array.isArray(edges) || edges.length > MAX_EDGES) return fail(`${ROADS_FILE}: at most ${MAX_NODES} nodes and ${MAX_EDGES} edges.`);
  const ids = new Set<string>();
  const outNodes: Array<{ id: string; name?: string }> = [];
  for (const node of nodes) {
    if (!isRecord(node) || checkStaffKeys(node, '', ['id'], ['name']) || typeof ownValue(node, 'id') !== 'string' || !STAFF_SLUG.test(ownValue(node, 'id') as string)) return fail(`Each node in ${ROADS_FILE} is { id, name? } with a slug id.`);
    const name = ownValue(node, 'name');
    if (name !== undefined && !isOneLine(name, 120)) return fail(`Node ${String(ownValue(node, 'id'))}: name is one line.`);
    ids.add(ownValue(node, 'id') as string);
    outNodes.push({ id: ownValue(node, 'id') as string, ...(typeof name === 'string' ? { name } : {}) });
  }
  const outEdges: Array<{ from: string; to: string; km: number; oneWay?: boolean; closed?: boolean; name?: string }> = [];
  for (const [index, edge] of edges.entries()) {
    if (!isRecord(edge) || checkStaffKeys(edge, '', ['from', 'to', 'km'], ['oneWay', 'closed', 'name'])) return fail(`Edge ${index + 1} in ${ROADS_FILE} is { from, to, km, oneWay?, closed?, name? }.`);
    const from = ownValue(edge, 'from');
    const to = ownValue(edge, 'to');
    if (typeof from !== 'string' || typeof to !== 'string' || !ids.has(from) || !ids.has(to)) return fail(`Edge ${index + 1}: from and to name nodes in the file.`);
    if (!positive(ownValue(edge, 'km'), 40_000)) return fail(`Edge ${index + 1}: km is the length in kilometres, above 0.`);
    for (const key of ['oneWay', 'closed'] as const) if (ownValue(edge, key) !== undefined && typeof ownValue(edge, key) !== 'boolean') return fail(`Edge ${index + 1}: ${key} is true or false.`);
    const name = ownValue(edge, 'name');
    if (name !== undefined && !isOneLine(name, 120)) return fail(`Edge ${index + 1}: name is one line.`);
    outEdges.push({ from, to, km: ownValue(edge, 'km') as number, ...(ownValue(edge, 'oneWay') === true ? { oneWay: true } : {}), ...(ownValue(edge, 'closed') === true ? { closed: true } : {}), ...(typeof name === 'string' ? { name } : {}) });
  }
  return { ok: true, value: { nodes: outNodes, edges: outEdges } };
}

export interface Route { readonly nodes: readonly string[]; readonly km: number; readonly legs: ReadonlyArray<{ from: string; to: string; km: number; name?: string }> }

/** The shortest open route from one node to another, avoiding the nodes named: Dijkstra's search on the graph, nothing else. */
export function shortestRoute(graph: RoadGraph, from: string, to: string, avoid: readonly string[] = []): CalcResult<Route> {
  const known = new Set(graph.nodes.map((node) => node.id));
  for (const id of [from, to]) if (!known.has(id)) return fail(`${id} is not a node in ${ROADS_FILE}.`);
  const blocked = new Set(avoid.filter((id) => id !== from && id !== to));
  const next = new Map<string, Array<{ to: string; km: number; name?: string }>>();
  const link = (a: string, b: string, km: number, name?: string): void => { next.set(a, [...(next.get(a) ?? []), { to: b, km, ...(name ? { name } : {}) }]); };
  for (const edge of graph.edges) {
    if (edge.closed || blocked.has(edge.from) || blocked.has(edge.to)) continue;
    link(edge.from, edge.to, edge.km, edge.name);
    if (!edge.oneWay) link(edge.to, edge.from, edge.km, edge.name);
  }
  const distance = new Map<string, number>([[from, 0]]);
  const via = new Map<string, { from: string; km: number; name?: string }>();
  const open = new Set<string>([from]);
  const done = new Set<string>();
  while (open.size) {
    let current: string | undefined;
    for (const id of open) if (current === undefined || distance.get(id)! < distance.get(current)!) current = id;
    open.delete(current!);
    if (current === to) break;
    done.add(current!);
    for (const step of next.get(current!) ?? []) {
      if (done.has(step.to)) continue;
      const total = distance.get(current!)! + step.km;
      if (total < (distance.get(step.to) ?? Infinity)) { distance.set(step.to, total); via.set(step.to, { from: current!, km: step.km, ...(step.name ? { name: step.name } : {}) }); open.add(step.to); }
    }
  }
  if (!distance.has(to)) return fail(`No open route from ${from} to ${to} in ${ROADS_FILE}${blocked.size ? `, avoiding ${[...blocked].join(', ')}` : ''}.`);
  const legs: Array<{ from: string; to: string; km: number; name?: string }> = [];
  for (let at = to; at !== from;) { const leg = via.get(at)!; legs.unshift({ from: leg.from, to: at, km: leg.km, ...(leg.name ? { name: leg.name } : {}) }); at = leg.from; }
  return { ok: true, value: { nodes: [from, ...legs.map((leg) => leg.to)], km: distance.get(to)!, legs } };
}
