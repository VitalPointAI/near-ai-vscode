// Label cells on the host (plan 32-09; 32-CONTEXT D-15 to D-20, D-23, D-67, D-68). Node only, never imports vscode; Node I/O through ReplicaProject.
//
// Every product of a shared project lives in the cell for its label (D-15); org/Public products too (D-16). The base cell carries the roster and
// project-level entries only, so granting the hub the base cell (D-40) exposes no product text. A cell is made on demand the first time a label is
// used, and its key goes to every person device whose member's declared clearance dominates the label at the cell.create roster, and to no hub.
//
// Making a cell, in the order a rekey uses (membership.ts writeRekeys), so a crash never leaves an epoch nobody can open:
//   key kept (with its founding grant's hash) --> founding grant stored (wrapped to this device only, label sealed) --> cell.create (cites the head)
//   --> one grant per other cleared person device, at the cell.create roster
// A run stopped before cell.create leaves a key and a grant nobody uses; the next run makes a new cell id, so a label never gets two cells. A run
// stopped after cell.create is finished by the next call, which gives the cleared devices that hold nothing of the cell their grants.
//
// Writes refused before anything is written (plain sentences, D-37): not-cleared-for-label (D-19), not-a-roster-writer and roster-split (as every
// roster change), base-cell-products (a product kept in the base cell, as a 0.4.35 preview project does, is never written to here, D-22 revised),
// label-change (a product keeps its label for its whole life, D-17), pin-above-cell (the fold's own rule, D-18, D-67) and product-unknown.
//
// The legacy cell (D-20) holds the whole single-machine product ledger and decision log. Its sealed label is the legacy form (a set of labels), its
// key goes only to a lead or deputy whose declared clearance dominates every label in it (membership.ts clearedFor), and the hub never gets it (D-64).
import { randomBytes } from 'node:crypto';
import { dominates } from '../../domain/gate/dominance';
import { SCALE_PRESETS, parseLabel } from '../../domain/gate/labels';
import type { Clearance, Label, ScaleTable } from '../../domain/gate/labels';
import { grantHash, newEpochKey, sealLabel } from '../../domain/replica/cellKeys';
import { earlierEpochGrants, wrapsFor } from '../../domain/replica/grantPages';
import { SEALED_OVERHEAD, sealBlob } from '../../domain/replica/entry';
import type { Actor } from '../../domain/replica/entry';
import { CELL_ACCESS_FEATURE } from '../../domain/replica/features';
import { kindFamily } from '../../domain/replica/kinds';
import { MAX_STATE_BYTES } from '../../domain/replica/kindSchemas/doc';
import {
  DEFAULT_PRODUCT_LABEL, PRODUCT_CELL_REFUSALS, labelFromHeaderText, labelFromText, labelText, legacyCellLabel, pinProblem, readLegacyCellLabel, sameLabel
} from '../../domain/replica/productCells';
import type { CellOrder, LegacyCellLabel, PinCandidate } from '../../domain/replica/productCells';
import type { RosterState } from '../../domain/replica/roster';
import { epochAt, epochsAt, granteesAt } from '../../domain/replica/rosterCells';
import { deviceAt, memberAt } from '../../domain/replica/rosterMembers';
import { replicaVersionHash } from '../../domain/replica/versions';
import type { Pin, ProductVersions } from '../../domain/replica/versions';
import type { ProductTextOutput } from '../../domain/replica/textFold';
import { canonicalBytes } from '../../domain/team/canonical';
import { MEMBERSHIP_REFUSALS, append, cellOrderHook, clearedDevices, clearedFor, gateOf, headOf, writerProblem } from './membership';
import type { CellInfo, Gate, SharedProjectHost } from './membership';
import { giveManagedSupplemental } from './managedSupplemental';
import { isProjectRefused } from './replicaProject';
import type { ReplicaProject } from './replicaProject';
import { SWITCH_FIRST_TEXT, formatFor, formatForDevice, wrapDeviceAt } from './wrapPlan';

/** The D-19 sentence, word for word, for a label a person is not declared cleared for. */
export function NOT_CLEARED_TEXT(label: string): string {
  return `You are not declared cleared for ${label}, so this computer cannot hold that part of the project. Ask the staff lead to declare a clearance that covers it, or keep this project on one machine.`;
}

// Plain sentences: what happened and what to do next. None names a key, a secret or a hash, and none uses a dash as punctuation.
export const LABEL_CELL_REFUSALS = {
  'not-cleared-for-label': NOT_CLEARED_TEXT('that label'),
  'base-cell-products': 'Products are kept in a part of the project for their label, never in the part every member and the hub can read, so nothing was written.',
  'label-change': 'A product keeps its label for its whole life in a shared project. To give it another label, make a new product with that label. Nothing was written.',
  'pin-above-cell': PRODUCT_CELL_REFUSALS['pin-above-cell'],
  'product-unknown': 'This computer does not hold a product of that name in any part of the project it can open, so nothing was written. Check the name, or ask the staff lead for access to the part that holds it.',
  'label-unknown': 'That label is not one of the labels this project knows, so nothing was written. Choose one of the labels shown.',
  'version-too-large': 'This version is larger than a version can be, so nothing was written. It stays a working text.',
  'not-a-roster-writer': MEMBERSHIP_REFUSALS['not-a-roster-writer'],
  'roster-split': MEMBERSHIP_REFUSALS['roster-split'],
  // 33.2 D-07: a cell whose label routes local-only or nowhere is never wrapped the older way.
  'switch-first': SWITCH_FIRST_TEXT,
  'no-post-quantum-keys': 'This computer has not published its post-quantum keys in this shared work yet, so it cannot make a new part of it. Open the shared work again on this computer, then try again.'
} as const;
export type LabelCellRefusal = keyof typeof LABEL_CELL_REFUSALS;

/** A refusal: reason names it; message is the plain sentence (a project or roster refusal keeps its own reason and sentence). */
export interface LabelCellRefused { ok: false; reason: string; message: string }
/**
 * A cell for a label: created is false when an existing one was reused; granted lists the devices given the cell by this call, waiting the cleared
 * devices that have no keys of the format the cell needs yet (33.2 D-05), given it once they publish them.
 */
export type EnsureCellResult = { ok: true; cell: string; created: boolean; granted: string[]; waiting?: string[] } | LabelCellRefused;
/** An entry written into a product's cell. */
export type ProductWriteResult = { ok: true; hash: string; stream: string } | LabelCellRefused;
/** A version proposed: version is its replica hash (what a pin names), deps the entries it cites. */
export type ProposeResult = { ok: true; hash: string; stream: string; version: string; deps: string[] } | LabelCellRefused;

/** A test seam only: stop (by throwing) after the key is kept, the founding grant is stored, or cell.create is written. */
export interface EnsureCellOptions { stopAfter?: 'key' | 'grant' | 'create' }

const refuse = (reason: LabelCellRefusal, message?: string): LabelCellRefused => ({ ok: false, reason, message: message ?? LABEL_CELL_REFUSALS[reason] });
const fromResult = (value: { reason?: string; message: string }): LabelCellRefused => ({ ok: false, reason: value.reason ?? 'change-not-applied', message: value.message });
const ORG_PUBLIC: Label = { scale: 'org', level: 'Public', compartments: [], releasability: [], handling: [] };

/** A label from a Phase 70 label value or from its scale/level text (the staff ledger form), or undefined when the scales do not know it. */
function readLabel(value: unknown, scales: ScaleTable): Label | undefined {
  if (typeof value === 'string') return labelFromText(value, scales);
  const parsed = parseLabel(value, scales);
  return parsed.ok ? parsed.value : undefined;
}

/** A plain copy of a label, the value sealed into a cell's grants. */
const plainLabel = (label: Label): Label => ({ scale: label.scale, level: label.level, compartments: [...label.compartments], releasability: [...label.releasability], handling: [...label.handling] });

/**
 * May this device's member hold a cell of the label (D-19, D-68)? Read at the head: a member with no declared clearance may hold only org/Public; one
 * with a declared clearance when it dominates the label by Phase 70 rules. A device the roster does not admit may hold nothing.
 */
function mayHold(shared: SharedProjectHost, roster: RosterState, label: Label, gate: Gate): boolean {
  const position = headOf(roster).position;
  const device = deviceAt(roster.members, shared.project.deviceWriter, position);
  const record = device === undefined ? undefined : memberAt(roster.members, device.member, position);
  if (record === undefined) return false;
  if (record.clearance === undefined) return sameLabel(label, ORG_PUBLIC);
  return clearedFor(record.clearance, { cell: '', base: false, label, known: true }, false, gate);
}

/** The cell this device holds whose sealed label is the label (never the base cell or the legacy cell), or undefined. */
export async function labelCellOf(shared: SharedProjectHost, label: unknown): Promise<string | undefined> {
  const scales = gateOf(shared).scales;
  const wanted = readLabel(label, scales);
  if (wanted === undefined) return undefined;
  for (const held of await shared.project.heldCells()) {
    if (held.base || held.label === undefined) continue;
    const parsed = parseLabel(held.label, scales);
    if (parsed.ok && sameLabel(parsed.value, wanted)) return held.cell;
  }
  return undefined;
}

/** The legacy cell this device holds whose sealed set is the set given (in any order), or undefined. */
async function legacyCellOf(shared: SharedProjectHost, labels: readonly Label[]): Promise<string | undefined> {
  const scales = gateOf(shared).scales;
  const wanted = canonicalBytes(legacyCellLabel(labels)).toString('utf8');
  for (const held of await shared.project.heldCells()) {
    if (held.base || held.label === undefined) continue;
    const read = readLegacyCellLabel(held.label, scales);
    if (read !== undefined && canonicalBytes(legacyCellLabel(read)).toString('utf8') === wanted) return held.cell;
  }
  return undefined;
}

/**
 * Gives the cleared person devices that hold nothing of the cell's current epoch every epoch of it, at the head (a run stopped after cell.create, or
 * a device admitted while it was being made). Only a roster writer with no split, holding every epoch key, does it; otherwise nothing is given.
 */
async function fillGrants(shared: SharedProjectHost, cell: string, info: CellInfo, gate: Gate): Promise<{ granted: string[]; waiting: string[] }> {
  const { project } = shared;
  const { roster } = await project.state();
  if (writerProblem(shared, roster) !== undefined) return { granted: [], waiting: [] };
  const head = headOf(roster);
  const holders = granteesAt(roster.cells, cell, head.position, () => true);
  if (holders === undefined) return { granted: [], waiting: [] };
  const epochs: GivenEpoch[] = [];
  for (const item of epochsAt(roster.cells, cell, head.position)) {
    const key = project.keys.epochKey(cell, item.epoch);
    if (key === undefined) return { granted: [], waiting: [] };
    epochs.push({ epoch: item.epoch, key, foundedAt: item.from });
  }
  return giveCell(shared, roster, cell, info, gate, head.position, head.hash, epochs, new Set(holders));
}

interface GivenEpoch { epoch: number; key: Buffer; foundedAt: number }

/**
 * One grant per epoch for each cleared person device at the position that is not this device and not in `skip`, at the roster given, each wrap in
 * the format formatFor gives that epoch (33.2 D-06, D-07). A device with no keys of that format is waiting; an epoch that may not be shared here yet
 * (switch-first) is given to nobody.
 */
async function giveCell(shared: SharedProjectHost, roster: RosterState, cell: string, info: CellInfo, gate: Gate, position: number, at: string, epochs: readonly GivenEpoch[], skip: ReadonlySet<string>): Promise<{ granted: string[]; waiting: string[] }> {
  const { project } = shared;
  const writers = clearedDevices(roster, info, position, gate).filter((writer) => writer !== project.deviceWriter && !skip.has(writer)
    && deviceAt(roster.members, writer, position)?.kind === 'person');
  if (roster.requiredFrom.has(CELL_ACCESS_FEATURE)) {
    return epochs.length === 1 ?
      giveManagedSupplemental(project, roster, info, writers, shared.routing, new Date(gate.context.now)) :
      { granted: [], waiting: writers };
  }
  const formats = epochs.map((item) => ({ ...item, format: formatFor(roster, info, item.foundedAt, shared.routing) }));
  if (formats.some((item) => item.format === 'switch-first')) return { granted: [], waiting: writers };
  const granted: string[] = [];
  const waiting: string[] = [];
  const grants = writers.flatMap((writer) => {
    const device = wrapDeviceAt(roster, writer, position);
    const given = earlierEpochGrants(project.signer, {
      cell, roster: at, writer, label: info.raw, ...(device.x25519 === undefined ? {} : { recipient: device.x25519 }), ...(device.kem === undefined ? {} : { kem: device.kem }),
      epochs: formats.map((item) => ({ epoch: item.epoch, key: item.key, format: formatForDevice(item.format as 1 | 2 | 'best', device) }))
    });
    (given.length === formats.length ? granted : waiting).push(writer);
    return given;
  });
  if (grants.length > 0) {
    const stored = await project.putGrants(grants);
    if (isProjectRefused(stored)) throw new Error(stored.message);
  }
  return { granted, waiting };
}

/**
 * Makes a cell whose sealed label is `raw`, in the writeRekeys order (the key with its grant hash, the founding grant wrapped to this device only, then
 * cell.create citing the head), then gives one grant to each other cleared person device at the cell.create roster. No hub device gets a wrap.
 */
async function createCell(shared: SharedProjectHost, roster: RosterState, info: Omit<CellInfo, 'cell'>, gate: Gate, options: EnsureCellOptions): Promise<EnsureCellResult> {
  const { project } = shared;
  const head = headOf(roster);
  const self = wrapDeviceAt(roster, project.deviceWriter, head.position);
  if (self.x25519 === undefined) return refuse('not-a-roster-writer');
  const format = formatFor(roster, info, undefined, shared.routing);
  if (format === 'switch-first') return refuse('switch-first');
  let cell = '';
  do cell = randomBytes(16).toString('hex'); while (roster.cells.cells.has(cell));
  const key = newEpochKey();
  const { wraps } = wrapsFor({ format: formatForDevice(format, self), cell, epoch: 1, epochKey: key, devices: [self] });
  if (wraps.length === 0) return refuse('no-post-quantum-keys');
  // Signed by the device the roster names: the person key in a hosted session (D-60), this device's key otherwise.
  const pages = await project.signGrantPages({ cell, epoch: 1, roster: head.hash, labelSealed: sealLabel(key, cell, 1, info.raw), wraps });
  const founding = pages[0];
  // The key and the founding grant are kept before the entry that commits to them (MJ-04): a crash before cell.create leaves them unused.
  await project.keys.addOwn(cell, 1, key, grantHash(founding));
  if (options.stopAfter === 'key') throw new Error('stopped after the key (test seam)');
  const stored = await project.putGrants(pages);
  if (isProjectRefused(stored)) return { ok: false, reason: stored.refused, message: stored.message };
  if (options.stopAfter === 'grant') throw new Error('stopped after the founding grant (test seam)');
  const written = await append(shared, 'cell.create', { cell, epoch: 1, grant: grantHash(founding) }, head.hash);
  if (!('hash' in written)) return fromResult(written);
  if (options.stopAfter === 'create') throw new Error('stopped after cell.create (test seam)');
  const position = written.roster.positionOf.get(written.hash) as number;
  const given = await giveCell(shared, written.roster, cell, { ...info, cell }, gate, position, written.hash, [{ epoch: 1, key, foundedAt: position }], new Set());
  return { ok: true, cell, created: true, ...given };
}

/**
 * The cell for a label, made on demand (D-15, D-19). A cell this device holds whose sealed label is the label is reused (and any cleared device that
 * holds nothing of it is given it). Otherwise, refused before anything is written: not-cleared-for-label with the D-19 sentence when this device's
 * member may not hold the label (D-68: with no declared clearance only org/Public), and not-a-roster-writer or roster-split as every roster change.
 * Then the cell is made: see createCell.
 */
export async function ensureLabelCell(shared: SharedProjectHost, label: unknown, options: EnsureCellOptions = {}): Promise<EnsureCellResult> {
  const gate = gateOf(shared);
  const wanted = readLabel(label, gate.scales);
  if (wanted === undefined) return refuse('label-unknown');
  const { roster } = await shared.project.state();
  if (!mayHold(shared, roster, wanted, gate)) return refuse('not-cleared-for-label', NOT_CLEARED_TEXT(labelText(wanted)));
  const raw = plainLabel(wanted);
  const existing = await labelCellOf(shared, wanted);
  if (existing !== undefined) {
    const given = await fillGrants(shared, existing, { cell: existing, base: false, label: wanted, raw, known: true }, gate);
    return { ok: true, cell: existing, created: false, ...given };
  }
  const problem = writerProblem(shared, roster);
  if (problem !== undefined) return fromResult(problem);
  return createCell(shared, roster, { base: false, label: wanted, raw, known: true }, gate, options);
}

/**
 * The lead-only legacy cell for a set of labels (D-20): its sealed label is the legacy form of the set, and its key goes only to a lead or deputy whose
 * declared clearance dominates every label in it. Reused when this device holds one for the same set. Refused before anything is written when any
 * label is one this device's member may not hold (so with no declared clearance only an all org/Public set, or an empty one), and as every roster
 * change.
 */
export async function ensureLegacyCell(shared: SharedProjectHost, labels: readonly unknown[], options: EnsureCellOptions = {}): Promise<EnsureCellResult> {
  const gate = gateOf(shared);
  const read: Label[] = [];
  for (const item of labels) {
    const label = readLabel(item, gate.scales);
    if (label === undefined) return refuse('label-unknown');
    read.push(label);
  }
  const { roster } = await shared.project.state();
  const above = read.find((label) => !mayHold(shared, roster, label, gate));
  if (above !== undefined) return refuse('not-cleared-for-label', NOT_CLEARED_TEXT(labelText(above)));
  const raw: LegacyCellLabel = legacyCellLabel(read);
  const existing = await legacyCellOf(shared, raw.labels);
  if (existing !== undefined) {
    const given = await fillGrants(shared, existing, { cell: existing, base: false, legacy: raw.labels, raw, known: true }, gate);
    return { ok: true, cell: existing, created: false, ...given };
  }
  const problem = writerProblem(shared, roster);
  if (problem !== undefined) return fromResult(problem);
  return createCell(shared, roster, { base: false, legacy: raw.labels, raw, known: true }, gate, options);
}

/** Where a product lives, from the fold's versions output (and its text output for a text with no product entry this device folded). */
function productIn(fold: { families: Record<string, unknown> }, base: string, product: string): { stream: string; base: boolean } | undefined {
  const streams = new Set<string>();
  for (const item of (fold.families.versions as ProductVersions[] | undefined) ?? []) if (item.product === product) streams.add(item.stream);
  for (const item of (fold.families.doc as ProductTextOutput[] | undefined) ?? []) if (item.product === product) streams.add(item.stream);
  const cells = [...streams].filter((stream) => stream !== base).sort();
  if (cells.length > 0) return { stream: cells[0], base: false };
  return streams.has(base) ? { stream: base, base: true } : undefined;
}

/** The cell a product lives in as this device folds it: { base: true } for a product kept in the base cell (a 0.4.35 preview project). */
export async function productCellOf(shared: SharedProjectHost, product: string): Promise<{ stream: string; base: boolean } | undefined> {
  const { fold } = await shared.project.state();
  return productIn(fold, shared.project.projectId, product);
}

/** The label of a held label cell, or undefined for the base cell, the legacy cell or a cell whose label does not open here. */
async function labelOfCell(shared: SharedProjectHost, cell: string): Promise<Label | undefined> {
  const held = (await shared.project.heldCells()).find((item) => item.cell === cell);
  if (held === undefined || held.base || held.label === undefined) return undefined;
  const parsed = parseLabel(held.label, gateOf(shared).scales);
  return parsed.ok ? parsed.value : undefined;
}

/**
 * Does a version header's label text name its cell's label (D-17, WR-01)? Read whole (scale, level, compartments and releasability), it must be on the
 * cell's scale and level, and each must dominate the other by the Phase 70 rule (gate/dominance.ts): a compartment or releasability the cell does not
 * carry, or one the header drops, is another label. A header that does not read as a label names none. Handling flags have no text and are not compared.
 */
function headerNamesCell(headerLabel: string, cellLabel: Label, gate: Gate): boolean {
  const header = labelFromHeaderText(headerLabel, gate.scales);
  if (header === undefined || header.scale !== cellLabel.scale || header.level !== cellLabel.level) return false;
  const asClearance = (label: Label): Clearance => ({ scale: label.scale, level: label.level, compartments: label.compartments, releasability: label.releasability });
  return dominates(asClearance(cellLabel), header, gate.context) && dominates(asClearance(header), cellLabel, gate.context);
}

/** The pin check the fold makes (D-18, D-67), with the cell order the project folds with, or the host's own when it folds with none. */
function pinCheck(shared: SharedProjectHost, roster: RosterState, fold: { families: Record<string, unknown> }, own: string, pins: readonly Pin[]): LabelCellRefused | undefined {
  if (pins.length === 0) return undefined;
  const candidates: PinCandidate[] = ((fold.families.versions as ProductVersions[] | undefined) ?? []).map((item) => ({ stream: item.stream, product: item.product, hashes: new Set(item.versions.map((version) => version.hash)) }));
  const context = shared.project.context().cellOrder;
  const order: CellOrder = context ?? cellOrderHook({ scales: gateOf(shared).scales, mappings: shared.mappings ?? [], now: () => shared.deps.now?.() ?? new Date() })(roster, shared.project.keys);
  return pinProblem(own, pins, candidates, order) === undefined ? undefined : refuse('pin-above-cell');
}

/** The version entries the pins name, by their replica hash, from the fold's versions output. */
function pinnedEntries(fold: { families: Record<string, unknown> }, pins: readonly Pin[]): string[] {
  const found: string[] = [];
  for (const pin of pins) {
    for (const item of (fold.families.versions as ProductVersions[] | undefined) ?? []) {
      if (item.product !== pin.product) continue;
      const version = item.versions.find((candidate) => candidate.hash === pin.hash);
      if (version !== undefined && !found.includes(version.entry)) found.push(version.entry);
    }
  }
  return found;
}

interface ProductTarget { stream: string; roster: RosterState; fold: { families: Record<string, unknown> } }

/**
 * Where a product entry goes, or why it is refused, before anything is written. product.create goes into the cell for its label (org/Internal when
 * none, D-17), made on demand; a name this device already folds in another cell is label-change. Every other kind goes into the product's own cell; a
 * product kept in the base cell is base-cell-products and a name no held cell has is product-unknown.
 */
async function targetOf(shared: SharedProjectHost, kind: string, product: unknown, label: unknown): Promise<ProductTarget | LabelCellRefused> {
  const family = kindFamily(kind);
  if (family !== 'versions' && family !== 'doc') throw new Error('appendProductEntry writes the entries of a product only.');
  if (typeof product !== 'string') return refuse('product-unknown');
  const base = shared.project.projectId;
  if (kind === 'product.create') {
    const gate = gateOf(shared);
    const wanted = readLabel(label ?? DEFAULT_PRODUCT_LABEL, gate.scales);
    if (wanted === undefined) return refuse('label-unknown');
    const { roster, fold } = await shared.project.state();
    if (!mayHold(shared, roster, wanted, gate)) return refuse('not-cleared-for-label', NOT_CLEARED_TEXT(labelText(wanted)));
    const found = productIn(fold, base, product);
    const existing = await labelCellOf(shared, wanted);
    if (found !== undefined && found.stream !== existing) return refuse('label-change');
    const cell = await ensureLabelCell(shared, wanted);
    if (!cell.ok) return cell;
    const after = await shared.project.state();
    return { stream: cell.cell, roster: after.roster, fold: after.fold };
  }
  const { roster, fold } = await shared.project.state();
  const found = productIn(fold, base, product);
  if (found === undefined) return refuse('product-unknown');
  if (found.base) return refuse('base-cell-products');
  return { stream: found.stream, roster, fold };
}

/**
 * Writes one entry of a product (the versions and doc families) into the product's cell (D-15 to D-18): product.create into the cell for its label
 * (options.label, org/Internal when none), every other kind into the product's own cell. Refused before writing: not-cleared-for-label,
 * not-a-roster-writer (a cell to make), base-cell-products, label-change, pin-above-cell (a version.propose whose pins the fold would refuse) and
 * product-unknown. A product a 0.4.35 preview project keeps in the base cell is never written to here (D-22 revised).
 */
export async function appendProductEntry(shared: SharedProjectHost, kind: string, data: unknown, options: { label?: unknown; deps?: readonly string[]; actor?: Actor } = {}): Promise<ProductWriteResult> {
  const product = typeof data === 'object' && data !== null ? (data as { product?: unknown }).product : undefined;
  const target = await targetOf(shared, kind, product, options.label);
  if ('ok' in target) return target;
  let deps = options.deps ?? [];
  if (kind === 'version.propose') {
    const pins = ((data as { pins?: unknown }).pins ?? []) as Pin[];
    const pinned = Array.isArray(pins) ? pins : [];
    const problem = pinCheck(shared, target.roster, target.fold, target.stream, pinned);
    if (problem !== undefined) return problem;
    deps = [...new Set([...deps, ...pinnedEntries(target.fold, pinned)])];
  }
  const written = await shared.project.appendOwn(kind, data, { stream: target.stream, ...(deps.length === 0 ? {} : { deps }), ...(options.actor === undefined ? {} : { actor: options.actor }) });
  if (isProjectRefused(written)) return { ok: false, reason: written.refused, message: written.message };
  return { ok: true, hash: written.hash, stream: target.stream };
}

export interface ProposeInput {
  product: string;
  text: string;
  /** The version's header as the staff ledger keeps it (kind, label, profile, level); its label is checked against the cell's. */
  header: Record<string, unknown>;
  pins: readonly Pin[];
  /** The Yjs snapshot of the product's document the text was read at, as bytes or base64url. */
  snapshot: Uint8Array | string;
  deps?: readonly string[];
  actor?: Actor;
}

/**
 * Proposes a version of a product in its cell (D-17, D-18): refused label-change when the header's label (read whole: scale, level, compartments and
 * releasability; org/Internal when none) is not the cell's (headerNamesCell), pin-above-cell when the fold would refuse a pin, and as
 * appendProductEntry. The text and header are sealed under the cell's current epoch key into a blob stored with version.propose, which cites the deps given
 * and each pinned version entry.
 */
export async function proposeVersion(shared: SharedProjectHost, input: ProposeInput): Promise<ProposeResult> {
  const target = await targetOf(shared, 'version.propose', input.product, undefined);
  if ('ok' in target) return target;
  const { project } = shared;
  const cellLabel = await labelOfCell(shared, target.stream);
  const headerLabel = typeof input.header.label === 'string' ? input.header.label : DEFAULT_PRODUCT_LABEL;
  if (cellLabel === undefined || !headerNamesCell(headerLabel, cellLabel, gateOf(shared))) return refuse('label-change');
  const pins = input.pins.map((pin) => ({ product: pin.product, hash: pin.hash }));
  const problem = pinCheck(shared, target.roster, target.fold, target.stream, pins);
  if (problem !== undefined) return problem;
  const head = headOf(target.roster);
  const epoch = epochAt(target.roster.cells, target.stream, head.position);
  const key = epoch === undefined ? undefined : project.keys.epochKey(target.stream, epoch);
  if (epoch === undefined || key === undefined) return { ok: false, reason: 'no-key', message: 'This computer does not hold the key for this part of the shared project, so nothing was written. Ask your staff lead to give this device access.' };
  const plain = canonicalBytes({ text: input.text, header: input.header });
  if (plain.length + SEALED_OVERHEAD > MAX_STATE_BYTES) return refuse('version-too-large');
  const blob = sealBlob(key, target.stream, epoch, plain);
  const deps = [...new Set([...(input.deps ?? []), ...pinnedEntries(target.fold, pins)])];
  const version = replicaVersionHash(input.text, pins);
  const snapshot = typeof input.snapshot === 'string' ? input.snapshot : Buffer.from(input.snapshot).toString('base64url');
  const written = await project.appendOwn('version.propose', { product: input.product, hash: version, textBlob: blob.hash, snapshot, pins }, {
    stream: target.stream, roster: head.hash, contentBlob: blob, ...(deps.length === 0 ? {} : { deps }), ...(input.actor === undefined ? {} : { actor: input.actor })
  });
  if (isProjectRefused(written)) return { ok: false, reason: written.refused, message: written.message };
  return { ok: true, hash: written.hash, stream: target.stream, version, deps };
}

/**
 * Each label cell this device holds, by cell id, with its label as people read it (labelText): never the base cell or the legacy cell. 32-10's
 * projection input uses it to name the label of each product's cell.
 */
export async function cellLabelTexts(project: ReplicaProject, scales: ScaleTable = SCALE_PRESETS): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  for (const held of await project.heldCells()) {
    if (held.base || held.label === undefined || readLegacyCellLabel(held.label, scales) !== undefined) continue;
    const parsed = parseLabel(held.label, scales);
    if (parsed.ok) texts.set(held.cell, labelText(parsed.value));
  }
  return texts;
}
