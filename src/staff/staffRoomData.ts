// What the Staff Room reads from a staff project (WP-ROOM): the product ledger and staff events through the staff host, and the files under
// .planning/staff/ the workspaces draw: for the J2 the scenario, the intel workbench registers, the shared PIR register, the DST and DSM, the adversary COA
// set and the standing watches; for the J5, J3 and J4 their product tables, registers, the wargame ledger and the logistics records. Node I/O only, read-only: nothing here writes a file or records an event. No vscode, so the tests drive it directly.
//
// A file that is missing is simply not drawn. A file that is there but cannot be read (damaged, too large, refused by the scenario reader) is named in
// the J2 workspace's problems, so a person sees why something is absent rather than an empty panel.
import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { StaffEvent } from '../domain/staff/events';
import { INTEL_REGISTER_NAMES, parseRegisterText, registerPath } from '../domain/staff/intel';
import type { CollectionEntry, PirEntry, SourceEntry } from '../domain/staff/intel';
import { FEED_EVENT_TYPES } from '../domain/staff/obs/events';
import type { FeedEvent } from '../domain/staff/obs/events';
import type { Observation } from '../domain/staff/obs/observation';
import { parseWatch } from '../domain/staff/obs/watches';
import { trustWatch } from '../domain/staff/obs/watchRun';
import type { PersonDecisionEntry } from '../domain/staff/personDecisions';
import type { StandingWatch } from '../domain/staff/obs/watches';
import { splitProductFile } from '../domain/staff/products';
import { defaultStaffSettings, parseStaffSettings } from '../domain/staff/profiles';
import type { StaffSettings } from '../domain/staff/profiles';
import { parseRegisterBody, registerSchema } from '../domain/staff/registers';
import type { RegisterRow } from '../domain/staff/registers';
import { parseScenarioText, SCENARIO_DIR } from '../domain/staff/scenario';
import type { Scenario } from '../domain/staff/scenario';
import type { StaffRoomInput } from '../domain/staff/staffRoom';
import type { WorkspacesInput } from '../domain/staff/staffRoomWorkspaces';
import type { StaffSectionId } from '../domain/staff/doctrine';
import { parseBandSettings } from '../domain/staff/logistics';
import { productFacts } from '../domain/staff/orders';
import type { ProductView } from '../domain/staff/readModels';
import { staffProductPath } from '../domain/staff/writeLimits';
import { readRealEntities } from './realEntities';
import { EVENTS_FILE, LEDGER_DIR } from './staffHost';
import type { StaffHost } from './staffHost';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FEED_EVENTS = 20_000;
export const SCENARIO_FILE = `${SCENARIO_DIR}/scenario.json`;
export const PROJECT_SETTINGS_FILE = '.planning/.near-ai/project.json';
/** The J2's standing watches (research note 11, 4.5), one register file beside the intel workbench's, in the same shape: register, format version, entries. */
export const STANDING_WATCHES_FILE = '.planning/staff/products/j2/standing-watches.json';
/** The J2 products the MLCOA and MDCOA overlays are read from, first found first. */
export const ENEMY_COA_PRODUCTS = ['adversary-coa-set', 'threat-assessment', 'intelligence-estimate'] as const;

type Read = { readonly text?: string; readonly problem?: string };

async function readSmall(file: string): Promise<Read> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return {};
    if (info.size > MAX_BYTES) return { problem: `${path.basename(file)} is larger than 2 MB, so it was not read.` };
    return { text: await readFile(file, 'utf8') };
  } catch { return {}; }
}

/** A product file's body, without its staff header. */
async function productBody(root: string, relative: string): Promise<Read> {
  const read = await readSmall(path.join(root, relative));
  if (read.text === undefined) return read;
  const parts = splitProductFile(read.text);
  return { text: parts ? parts.body : read.text };
}

/** The project's staff settings, or the defaults when it has none that read cleanly. */
export async function staffSettingsOf(root: string): Promise<StaffSettings> {
  const read = await readSmall(path.join(root, PROJECT_SETTINGS_FILE));
  if (read.text !== undefined) {
    try {
      const value = JSON.parse(read.text) as { staff?: unknown };
      if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'staff')) {
        const parsed = parseStaffSettings(value.staff);
        if (parsed.ok) return parsed.value;
      }
    } catch { /* an unreadable project file falls back to the defaults */ }
  }
  return defaultStaffSettings();
}

/** The feed and watch events in the staff event log (WP-OBS0 names them; the staff host reads design 10's events only). */
export async function feedEventsOf(root: string): Promise<FeedEvent[]> {
  const read = await readSmall(path.join(root, LEDGER_DIR, EVENTS_FILE));
  if (read.text === undefined) return [];
  const out: FeedEvent[] = [];
  for (const line of read.text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as FeedEvent;
      if (value && typeof value === 'object' && (FEED_EVENT_TYPES as readonly string[]).includes(value.type)) out.push(value);
    } catch { /* a damaged line is skipped */ }
  }
  return out.slice(-MAX_FEED_EVENTS);
}

/** The exercise scenario loaded in the project, checked by the same reader that loaded it (markings, real entities, the frame). */
export async function scenarioOf(root: string): Promise<{ scenario?: Scenario; problem?: string }> {
  const read = await readSmall(path.join(root, SCENARIO_FILE));
  if (read.problem) return { problem: read.problem };
  if (read.text === undefined) return {};
  const parsed = parseScenarioText(read.text, { realEntities: await readRealEntities(root) });
  return parsed.ok ? { scenario: parsed.value } : { problem: `The scenario in ${SCENARIO_DIR}/ could not be read: ${parsed.message}` };
}

/**
 * The standing watches file, each watch read strictly; a watch that does not read is named, never half-drawn. With the signed decisions (WP-WATCH), a watch
 * the file calls armed that no signed arm decision proves is named in `unsigned` (it runs nothing until a person arms it), and a retired one is shown
 * retired whatever the file says.
 */
export async function standingWatchesOf(root: string, decisions?: ReadonlyMap<string, PersonDecisionEntry>): Promise<{ watches: StandingWatch[]; problems: string[]; unsigned: string[] }> {
  const read = await readSmall(path.join(root, STANDING_WATCHES_FILE));
  if (read.problem) return { watches: [], problems: [read.problem], unsigned: [] };
  if (read.text === undefined) return { watches: [], problems: [], unsigned: [] };
  let value: unknown;
  try { value = JSON.parse(read.text); } catch { return { watches: [], problems: ['The standing watches file is not JSON.'], unsigned: [] }; }
  const entries = value && typeof value === 'object' && !Array.isArray(value) ? (value as { register?: unknown; entries?: unknown }) : undefined;
  if (!entries || entries.register !== 'standing-watches' || !Array.isArray(entries.entries)) return { watches: [], problems: ['The standing watches file is not a standing-watches register.'], unsigned: [] };
  const watches: StandingWatch[] = [];
  const problems: string[] = [];
  entries.entries.slice(0, 200).forEach((entry, index) => {
    const parsed = parseWatch(entry, `entries[${index}]`);
    if (parsed.ok) watches.push(parsed.value);
    else problems.push(`Standing watch ${index + 1} was not read: ${parsed.message}`);
  });
  // Read through the signed decisions: a retired watch shows as retired whatever the file says; one the file calls armed with no signed arm decision is
  // flagged on its card (it runs nothing until a person arms it).
  const unsigned: string[] = [];
  const shown = watches.map((watch) => {
    if (!decisions) return watch;
    const trusted = trustWatch(watch, decisions.get(watch.id));
    if (!trusted.problem) return watch;
    if (trusted.watch.state === 'proposed') { unsigned.push(watch.id); return watch; }
    return trusted.watch;
  });
  return { watches: shown, problems, unsigned };
}

/** The product bodies the J5, J3 and J4 workspaces read their tables from, with the section each lives in when the ledger does not say. */
export const WORKSPACE_BODIES: ReadonlyArray<readonly [string, StaffSectionId]> = [
  ['coa-themes', 'j5'], ['coa-validity', 'j5'], ['comparison-matrix', 'j5'], ['coa-decision-brief', 'j5'], ['coa-supportability', 'j4']
];
/** The registers the workspaces draw, each with the section its file lives in when the ledger does not say (the battle rhythm is the J3's standalone). */
const WORKSPACE_REGISTERS = [
  ['syncMatrix', 'sync-matrix', 'j5'], ['eventLog', 'event-log', 'j3'], ['ccir', 'ccir-register', 'j3'], ['rfi', 'rfi-tracker', 'j3'],
  ['battleRhythm', 'battle-rhythm-calendar', 'j3'], ['annexTracker', 'annex-tracker', 'j5']
] as const;

/**
 * What the J5, J3 and J4 workspaces are built from: product tables, registers, the wargame ledger, the orders check's facts and the logistics records.
 * A register or ledger that is there but cannot be read is named in the problems, never drawn as empty.
 */
export async function workspacesInputOf(host: StaffHost | undefined, root: string, registry: readonly ProductView[]): Promise<WorkspacesInput> {
  const problems: string[] = [];
  const sectionOf = (product: string, fallback: StaffSectionId) => registry.find((view) => view.product === product)?.section ?? fallback;
  const bodies: Record<string, string> = {};
  for (const [product, section] of WORKSPACE_BODIES) {
    const read = await productBody(root, staffProductPath(sectionOf(product, section), product));
    if (read.problem) problems.push(read.problem);
    if (read.text !== undefined) bodies[product] = read.text;
  }
  const registers: Partial<Record<(typeof WORKSPACE_REGISTERS)[number][0], RegisterRow[]>> = {};
  for (const [key, register, section] of WORKSPACE_REGISTERS) {
    const read = await productBody(root, staffProductPath(sectionOf(register, section), register));
    if (read.problem) { problems.push(read.problem); continue; }
    if (read.text === undefined) continue;
    const rows = parseRegisterBody(registerSchema(register)!, read.text);
    if (rows) registers[key] = rows;
    else problems.push(`The ${registerSchema(register)!.title.toLowerCase()} could not be read: its rows do not fit the register, so it is not shown.`);
  }
  let wargame: WorkspacesInput['wargame'];
  let facts: WorkspacesInput['facts'];
  let logistics: WorkspacesInput['logistics'];
  if (host) {
    try { wargame = { entries: await host.wargameEntries() }; } catch (error) { wargame = { unreadable: error instanceof Error ? error.message : String(error) }; }
    // The annex tracker is held to the ledger by the orders tool's own check, so the facts come from the same replay it uses.
    if (registers.annexTracker?.length) {
      try { facts = productFacts(await host.replay()); } catch (error) { problems.push(`The annex tracker could not be checked against the ledger: ${error instanceof Error ? error.message : String(error)}`); }
    }
    try {
      const logisticsHost = host.logistics();
      const [check, reports, definitions] = await Promise.all([logisticsHost.records(), logisticsHost.reports(), logisticsHost.definitionsText()]);
      logistics = {
        records: [...check.records.values()], recordProblems: [...check.problems.values()], ...(check.ledgerProblem ? { ledgerProblem: check.ledgerProblem } : {}),
        reports, bands: definitions ? parseBandSettings(definitions) : []
      };
    } catch (error) { problems.push(`The logistics records could not be read: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { bodies, registers, ...(wargame ? { wargame } : {}), ...(facts ? { facts } : {}), ...(logistics ? { logistics } : {}), problems };
}

/** Everything the Staff Room model is built from, read now. */
export async function loadStaffRoomInput(host: StaffHost | undefined, root: string, now: number, run?: string, options: { readonly live?: readonly Observation[] } = {}): Promise<StaffRoomInput> {
  const [snapshot, events, feedEvents, settings, scenario, watches] = await Promise.all([
    host ? host.snapshot() : Promise.resolve(undefined),
    host ? host.events() : Promise.resolve([] as StaffEvent[]),
    feedEventsOf(root),
    staffSettingsOf(root),
    scenarioOf(root),
    host ? host.watchDecisions().then((decisions) => standingWatchesOf(root, decisions)) : standingWatchesOf(root)
  ]);
  const problems: string[] = [...(scenario.problem ? [scenario.problem] : []), ...watches.problems];
  const registers: { sources: SourceEntry[]; pirs: PirEntry[]; plan: CollectionEntry[] } = { sources: [], pirs: [], plan: [] };
  for (const name of INTEL_REGISTER_NAMES) {
    const read = await readSmall(path.join(root, registerPath(name)));
    if (read.problem) { problems.push(read.problem); continue; }
    const parsed = parseRegisterText(name, read.text);
    if (!parsed.ok) { problems.push(parsed.message); continue; }
    if (name === 'source-register') registers.sources = parsed.value as SourceEntry[];
    else if (name === 'pir-register') registers.pirs = parsed.value as PirEntry[];
    else registers.plan = parsed.value as CollectionEntry[];
  }
  const registry = snapshot?.registry ?? [];
  const sectionOf = (product: string, fallback: Parameters<typeof staffProductPath>[0]) => registry.find((view) => view.product === product)?.section ?? fallback;
  const rowsOf = async (register: string, fallback: Parameters<typeof staffProductPath>[0]): Promise<RegisterRow[] | undefined> => {
    const read = await productBody(root, staffProductPath(sectionOf(register, fallback), register));
    return read.text === undefined ? undefined : parseRegisterBody(registerSchema(register)!, read.text);
  };
  // The PIRs come from the workbench's JSON register above, their one source; the DSM from its register product.
  const dsm = await rowsOf('dst-dsm', 'j5');
  let enemyCoaBody: string | undefined;
  let enemyCoaProduct: string | undefined;
  for (const product of ENEMY_COA_PRODUCTS) {
    const read = await productBody(root, staffProductPath(sectionOf(product, 'j2'), product));
    if (read.text !== undefined && /most (likely|dangerous)|\bML ?COA\b|\bMD ?COA\b/i.test(read.text)) { enemyCoaBody = read.text; enemyCoaProduct = product; break; }
  }
  const workspaces = await workspacesInputOf(host, root, registry);
  return {
    now, settings, registry, decisions: snapshot?.decisions ?? [], workspaces, cop: snapshot?.cop ?? { layers: [], eventTail: [] },
    ...(snapshot?.ledgerProblem ? { ledgerProblem: snapshot.ledgerProblem } : {}),
    ...(snapshot?.eventLogProblem ? { eventLogProblem: snapshot.eventLogProblem } : {}),
    events, feedEvents, ...(run ? { run } : {}),
    ...(scenario.scenario ? { scenario: scenario.scenario } : {}), ...(scenario.problem ? { scenarioProblem: scenario.problem } : {}),
    j2: {
      ...registers, ...(dsm ? { dsm } : {}), ...(enemyCoaBody ? { enemyCoaBody } : {}), ...(enemyCoaProduct ? { enemyCoaProduct } : {}),
      watches: watches.watches, ...(watches.unsigned.length ? { unsignedWatches: watches.unsigned } : {}), ...(options.live ? { live: options.live } : {}), problems
    }
  };
}
