// What the Staff Room reads from a staff project (WP-ROOM): the product ledger and staff events through the staff host, and the files under
// .planning/staff/ the J2 workspace draws: the scenario, the intel workbench registers, the shared PIR register, the DST and DSM, the adversary COA set and
// the standing watches. Node I/O only, read-only: nothing here writes a file or records an event. No vscode, so the tests drive it directly.
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
import { parseWatch } from '../domain/staff/obs/watches';
import type { StandingWatch } from '../domain/staff/obs/watches';
import { splitProductFile } from '../domain/staff/products';
import { defaultStaffSettings, parseStaffSettings } from '../domain/staff/profiles';
import type { StaffSettings } from '../domain/staff/profiles';
import { parseRegisterBody, registerSchema } from '../domain/staff/registers';
import type { RegisterRow } from '../domain/staff/registers';
import { parseScenarioText, SCENARIO_DIR } from '../domain/staff/scenario';
import type { Scenario } from '../domain/staff/scenario';
import type { StaffRoomInput } from '../domain/staff/staffRoom';
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

/** The standing watches file, each watch read strictly; a watch that does not read is named, never half-drawn. */
export async function standingWatchesOf(root: string): Promise<{ watches: StandingWatch[]; problems: string[] }> {
  const read = await readSmall(path.join(root, STANDING_WATCHES_FILE));
  if (read.problem) return { watches: [], problems: [read.problem] };
  if (read.text === undefined) return { watches: [], problems: [] };
  let value: unknown;
  try { value = JSON.parse(read.text); } catch { return { watches: [], problems: ['The standing watches file is not JSON.'] }; }
  const entries = value && typeof value === 'object' && !Array.isArray(value) ? (value as { register?: unknown; entries?: unknown }) : undefined;
  if (!entries || entries.register !== 'standing-watches' || !Array.isArray(entries.entries)) return { watches: [], problems: ['The standing watches file is not a standing-watches register.'] };
  const watches: StandingWatch[] = [];
  const problems: string[] = [];
  entries.entries.slice(0, 200).forEach((entry, index) => {
    const parsed = parseWatch(entry, `entries[${index}]`);
    if (parsed.ok) watches.push(parsed.value);
    else problems.push(`Standing watch ${index + 1} was not read: ${parsed.message}`);
  });
  return { watches, problems };
}

/** Everything the Staff Room model is built from, read now. */
export async function loadStaffRoomInput(host: StaffHost | undefined, root: string, now: number, run?: string): Promise<StaffRoomInput> {
  const [snapshot, events, feedEvents, settings, scenario, watches] = await Promise.all([
    host ? host.snapshot() : Promise.resolve(undefined),
    host ? host.events() : Promise.resolve([] as StaffEvent[]),
    feedEventsOf(root),
    staffSettingsOf(root),
    scenarioOf(root),
    standingWatchesOf(root)
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
  const [pirRows, dsm] = await Promise.all([rowsOf('pir-register', 'j2'), rowsOf('dst-dsm', 'j5')]);
  let enemyCoaBody: string | undefined;
  let enemyCoaProduct: string | undefined;
  for (const product of ENEMY_COA_PRODUCTS) {
    const read = await productBody(root, staffProductPath(sectionOf(product, 'j2'), product));
    if (read.text !== undefined && /most (likely|dangerous)|\bML ?COA\b|\bMD ?COA\b/i.test(read.text)) { enemyCoaBody = read.text; enemyCoaProduct = product; break; }
  }
  return {
    now, settings, registry, decisions: snapshot?.decisions ?? [], cop: snapshot?.cop ?? { layers: [], eventTail: [] },
    ...(snapshot?.ledgerProblem ? { ledgerProblem: snapshot.ledgerProblem } : {}),
    events, feedEvents, ...(run ? { run } : {}),
    ...(scenario.scenario ? { scenario: scenario.scenario } : {}), ...(scenario.problem ? { scenarioProblem: scenario.problem } : {}),
    j2: {
      ...registers, ...(pirRows ? { pirRows } : {}), ...(dsm ? { dsm } : {}), ...(enemyCoaBody ? { enemyCoaBody } : {}), ...(enemyCoaProduct ? { enemyCoaProduct } : {}),
      watches: watches.watches, problems
    }
  };
}
