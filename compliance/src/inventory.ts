// The component inventory: one source (compliance/resources.json, the compliance fit register) read with the exact pins the repository uses,
// for three outputs that must agree: the component catalogue pages of the documentation site (scripts/build-component-catalogue.mjs), the
// SSP inventory items of the assessor package (oscalSsp.ts) and its readable CSV (package.ts, carried into the SA&A export). Reads files only:
// no network, no clock, so the same commit always gives the same inventory.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { AREAS_FILE, CHART_LOCK, IMAGE_LOCK, REGISTER_FILE, TOOL_PINS, VENDORED_JSON, parseImage } from '../../scripts/resource-check.mjs';
import { toCsv } from '../../docs-site/src/compliance/lib.mjs';

export interface ArchitectureArea { readonly id: string; readonly title: string; readonly summary: string }

/** One register entry with its exact pins. `pins` lists each pinned version or digest once, with the files that pin it. */
export interface InventoryEntry {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly pins: readonly { readonly pin: string; readonly where: readonly string[] }[];
  readonly where: readonly string[];
  readonly component: string;
  readonly architectureArea: string;
  readonly scope: string;
  readonly purpose: string;
  readonly role: string;
  readonly roleNeedsReview: boolean;
  readonly licence: string;
  readonly controls: readonly string[];
  readonly crypto: string;
  readonly cveResponse: string;
  readonly airGap: string;
  readonly fit: string;
  readonly conditions: readonly string[];
  readonly reviewer: string;
  readonly reviewedAt: string;
}

export interface Inventory { readonly areas: readonly ArchitectureArea[]; readonly entries: readonly InventoryEntry[] }

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const texts = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

function readJson(root: string, file: string): unknown {
  const full = path.join(root, file);
  return existsSync(full) ? JSON.parse(readFileSync(full, 'utf8')) : undefined;
}
const readText = (root: string, file: string): string => {
  const full = path.join(root, file);
  return existsSync(full) ? readFileSync(full, 'utf8') : '';
};

/** Adds one pin, keeping the files that pin it; the same pin from several files is listed once. */
function addPin(pins: Map<string, string[]>, pin: string, where: string): void {
  if (!pin) return;
  const files = pins.get(pin) ?? [];
  if (!files.includes(where)) files.push(where);
  pins.set(pin, files);
}

/** The installed version of an npm package for one package.json: its lockfile's entry, or the range written in package.json when there is no lock. */
function npmVersion(root: string, packageFile: string, name: string): string {
  const dir = path.posix.dirname(packageFile);
  const lock = readJson(root, dir === '.' ? 'package-lock.json' : `${dir}/package-lock.json`);
  const locked = isRecord(lock) && isRecord(lock.packages) ? lock.packages[`node_modules/${name}`] : undefined;
  if (isRecord(locked) && text(locked.version)) return text(locked.version);
  const manifest = readJson(root, packageFile);
  if (!isRecord(manifest)) return '';
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = manifest[field];
    if (isRecord(deps) && text(deps[name])) return text(deps[name]);
  }
  return '';
}

/** The image references for `name` in one file: FROM lines of a Dockerfile or Containerfile, image: lines of a Compose file, or the image lock. */
function imagePins(root: string, file: string, name: string): string[] {
  const body = readText(root, file);
  let refs: string[];
  if (file === IMAGE_LOCK) {
    const lock = JSON.parse(body || '{}') as { images?: { ref?: unknown }[] };
    refs = (lock.images ?? []).map((image) => text(image.ref));
  } else if (/(?:Dockerfile|Containerfile)$/.test(file)) {
    refs = [...body.matchAll(/^\s*FROM\s+(?:--\S+\s+)*(\S+)/gim)].map((match) => match[1]);
  } else {
    refs = [...body.matchAll(/^\s*image:\s*['"]?([^\s'"#]+)/gm)].map((match) => match[1]);
  }
  return refs.filter((ref) => ref && parseImage(ref).name === name).map((ref) => ref.slice(name.length).replace(/^:/, ''));
}

/** The pinned commit of `action` in one workflow, with the release its comment names (`owner/repo@<sha> # vX.Y.Z`). */
function actionPins(root: string, file: string, action: string): string[] {
  const pins: string[] = [];
  for (const line of readText(root, file).split('\n')) {
    const match = /^\s*(?:-\s+)?uses:\s*['"]?([^\s'"#@]+)@([0-9a-f]{40})['"]?(?:\s+#\s*(\S+))?/.exec(line);
    if (match && match[1] === action) pins.push(match[3] ? `${match[3]} (${match[2]})` : match[2]);
  }
  return pins;
}

/** Every exact pin of one register entry, read from the files the register says use it. */
function pinsOf(root: string, entry: Json, name: string): InventoryEntry['pins'] {
  const pins = new Map<string, string[]>();
  const where = texts(entry.where);
  switch (entry.kind) {
    case 'npm':
      for (const file of where) addPin(pins, npmVersion(root, file, name), file);
      break;
    case 'vendored': {
      const vendored = readJson(root, VENDORED_JSON) as { packages?: { name?: unknown; version?: unknown }[] } | undefined;
      const listed = vendored?.packages?.find((pkg) => pkg.name === name);
      for (const file of where) addPin(pins, listed && file === VENDORED_JSON ? text(listed.version) : npmVersion(root, 'package.json', name), file);
      break;
    }
    case 'image':
      for (const file of where) for (const pin of imagePins(root, file, name)) addPin(pins, pin, file);
      break;
    case 'action':
      for (const file of where) for (const pin of actionPins(root, file, name)) addPin(pins, pin, file);
      break;
    case 'chart': {
      const chart = (readJson(root, CHART_LOCK) as { charts?: Json[] } | undefined)?.charts?.find((item) => item.name === name);
      if (chart) addPin(pins, `${text(chart.version)}${text(chart.sha256) ? ` (sha256:${text(chart.sha256)})` : ''}`, CHART_LOCK);
      break;
    }
    case 'tool': {
      const tool = (readJson(root, TOOL_PINS) as Json | undefined)?.[name];
      if (isRecord(tool)) addPin(pins, `${text(tool.version)}${text(tool.sha256) ? ` (sha256:${text(tool.sha256)})` : ''}`, TOOL_PINS);
      break;
    }
  }
  return [...pins].map(([pin, files]) => ({ pin, where: files.sort() }));
}

/** Loads the areas and every register entry with its pins, in register order. Throws when either file is missing or malformed. */
export function loadInventory(root: string): Inventory {
  const areasDoc = readJson(root, AREAS_FILE);
  const register = readJson(root, REGISTER_FILE);
  if (!isRecord(areasDoc) || !Array.isArray(areasDoc.areas)) throw new Error(`${AREAS_FILE} must hold an "areas" list`);
  if (!isRecord(register) || !Array.isArray(register.resources)) throw new Error(`${REGISTER_FILE} must hold a "resources" list`);
  const areas = areasDoc.areas.filter(isRecord).map((area) => ({ id: text(area.id), title: text(area.title), summary: text(area.summary) }));
  const entries = register.resources.filter(isRecord).map((entry): InventoryEntry => {
    const id = text(entry.id);
    const name = id.slice(id.indexOf(':') + 1);
    return {
      id, kind: text(entry.kind), name, pins: pinsOf(root, entry, name), where: texts(entry.where), component: text(entry.component),
      architectureArea: text(entry.architectureArea), scope: text(entry.scope), purpose: text(entry.purpose), role: text(entry.role),
      roleNeedsReview: entry.roleNeedsReview === true, licence: text(entry.licence), controls: texts(entry.controls), crypto: text(entry.crypto),
      cveResponse: text(entry.cveResponse), airGap: text(entry.airGap), fit: text(entry.fit), conditions: texts(entry.conditions),
      reviewer: text(entry.reviewer), reviewedAt: text(entry.reviewedAt)
    };
  });
  return { areas, entries };
}

/** One pin per line for a table cell: `pin (file, file)` when the entry is pinned in more than one place. */
export function pinText(entry: InventoryEntry, separator = '; '): string {
  if (entry.pins.length === 0) return 'not pinned in a lock or manifest';
  if (entry.pins.length === 1) return entry.pins[0].pin;
  return entry.pins.map(({ pin, where }) => `${pin} (${where.join(', ')})`).join(separator);
}

export const INVENTORY_CSV_COLUMNS = Object.freeze([
  'Resource', 'Kind', 'Architecture area', 'Architecture component', 'Pinned version or digest', 'What it provides', 'Why it is needed',
  'Role awaiting owner review', 'Scope', 'Used in', 'Licence', 'Cryptography', 'Air gap', 'Compliance fit', 'Conditions', 'Controls',
  'Security fixes', 'Reviewed by', 'Reviewed on'
]);

/** The inventory as a CSV (the formula-safe writer the package's other CSVs use), one row per register entry. */
export function inventoryCsv(inventory: Inventory): string {
  const titles = new Map(inventory.areas.map((area) => [area.id, area.title]));
  const rows = inventory.entries.map((entry) => {
    const values = [
      entry.id, entry.kind, titles.get(entry.architectureArea) ?? entry.architectureArea, entry.component, pinText(entry), entry.purpose, entry.role,
      entry.roleNeedsReview ? 'yes' : 'no', entry.scope, entry.where.join('; '), entry.licence, entry.crypto, entry.airGap, entry.fit,
      entry.conditions.join(' '), entry.controls.join(', '), entry.cveResponse, entry.reviewer, entry.reviewedAt
    ];
    return Object.fromEntries(INVENTORY_CSV_COLUMNS.map((column, index) => [column, values[index]]));
  });
  return `${toCsv(rows, [...INVENTORY_CSV_COLUMNS])}\r\n`;
}
