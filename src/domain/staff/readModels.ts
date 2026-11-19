// The read models the Staff Room and Team Live draw (design 10, 4.5; UX concept 4.1; WP-SHARED), built from the product ledger and the staff events.
// Pure: no I/O, no clock, no vscode. The page never decides state: it lays these out, and a page rebuilt after a reload gets the same picture from the
// same ledger and event log.
import type { CrosswalkStep, StaffSectionId } from './doctrine';
import type {
  CopLayerModel, CopModel, CopUpdatedEvent, DecisionQueueEntry, LaneStatus, ProductRegistryEntry, SharedRegisterModel, StaffEvent, StepBoardLane,
  StepBoardModel, StepBoardSection
} from './events';
import { changedSources, displayState, TAMPER_REASONS } from './ledger';
import type { DisplayState, HistoryItem, LedgerReplay, ProductState, TamperReason } from './ledger';
import { REGISTER_SCHEMAS } from './registers';

/** One row of the product ledger view: the WP-0 registry entry, plus the words a person reads and why a product reads as tampered or held. */
export interface ProductView extends ProductRegistryEntry {
  readonly display: DisplayState;
  readonly hash: string;
  readonly tampered?: string;
  readonly heldReasons?: readonly string[];
  readonly approvedBy?: { readonly name: string; readonly role: string; readonly deviceFingerprint: string };
  readonly history: readonly HistoryItem[];
  /** The newer approved versions of what it depends on. */
  readonly changedSources: ReadonlyArray<{ readonly product: string; readonly version: number }>;
}

/** What the host found on disk for one product: a disagreement with the ledger, if any. */
export interface FileCheck { readonly disagreement?: TamperReason }

/** The product registry, newest change first. `files` holds what the host found when it compared each product file with the ledger. */
export function productRegistry(replay: LedgerReplay, files: ReadonlyMap<string, FileCheck> = new Map()): ProductView[] {
  const views: ProductView[] = [];
  for (const state of replay.products.values()) views.push(productView(state, replay.products, files.get(state.record.product)));
  const last = (view: ProductView): number => view.history[view.history.length - 1]?.seq ?? -1;
  return views.sort((a, b) => last(b) - last(a));
}

export function productView(state: ProductState, all: ReadonlyMap<string, ProductState>, file?: FileCheck): ProductView {
  const record = state.record;
  const tampered = state.tampered ?? (file?.disagreement ? TAMPER_REASONS[file.disagreement] : undefined);
  const changed = changedSources(state, all);
  const gate = (mark: ProductState['guard']): { verdict: string; version: number } | undefined => (mark ? { verdict: mark.verdict, version: mark.version } : undefined);
  const guard = gate(state.guard);
  const tradecraft = gate(state.tradecraft);
  return {
    product: record.product, kind: state.meta.kind, section: record.section, owner: record.roles.owner, version: record.version, state: record.state,
    label: state.meta.label, ...(record.decisionFor !== undefined ? { decisionFor: record.decisionFor } : {}),
    dependsOn: state.meta.dependsOn.map((entry) => ({ product: entry.product, version: entry.version })),
    ...(guard ? { guard } : {}), ...(tradecraft ? { tradecraft } : {}),
    sourceChanged: changed.length > 0,
    display: displayState(record.state, { held: record.held !== undefined, tampered: tampered !== undefined }),
    hash: record.hash,
    ...(tampered !== undefined ? { tampered } : {}),
    ...(record.held ? { heldReasons: record.held.reasons } : {}),
    ...(record.approval ? { approvedBy: { name: record.approval.by.name, role: record.approval.by.role, deviceFingerprint: record.approval.by.deviceFingerprint } } : {}),
    history: state.history,
    changedSources: changed
  };
}

/** The decisions waiting on a person, oldest request first. A tampered product is never offered for a decision. */
export function decisionQueue(replay: LedgerReplay, files: ReadonlyMap<string, FileCheck> = new Map()): DecisionQueueEntry[] {
  const out: DecisionQueueEntry[] = [];
  for (const state of replay.products.values()) {
    const record = state.record;
    if (record.state !== 'awaiting-decision' || state.tampered !== undefined || files.get(record.product)?.disagreement !== undefined) continue;
    const request = state.request;
    out.push({
      product: record.product, version: record.version, decisionFor: record.decisionFor ?? 'commander',
      options: request?.options ?? [], dissent: request?.dissent ?? [], requestedAt: request?.requestedAt ?? '',
      ...(request?.deadline ? { deadline: request.deadline } : {})
    });
  }
  return out.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

/** The shared registers that exist, with their writer, version, state and row count (`rows` from the host, which reads the register bodies). */
export function sharedRegisters(replay: LedgerReplay, rows: ReadonlyMap<string, number>): SharedRegisterModel[] {
  const out: SharedRegisterModel[] = [];
  for (const name of Object.keys(REGISTER_SCHEMAS)) {
    const state = replay.products.get(name);
    if (!state) continue;
    out.push({ product: name, writer: { section: state.record.section, member: state.record.roles.owner }, version: state.record.version, state: state.record.state, rows: rows.get(name) ?? 0 });
  }
  return out;
}

/** The latest crosswalk step each section entered in a run. */
export function currentSteps(events: readonly StaffEvent[], run: string): Partial<Record<StaffSectionId, CrosswalkStep>> {
  const steps: Partial<Record<StaffSectionId, CrosswalkStep>> = {};
  for (const event of events) if (event.type === 'staff.step.entered' && event.run === run) steps[event.section] = event.step;
  return steps;
}

/**
 * The step board of one run: per section, the step it is on, its lanes (a member is `waiting` while it said it waits on someone and has not finished),
 * the merge status, and the gate status from the products of that section.
 */
export function stepBoard(events: readonly StaffEvent[], run: string, registry: readonly ProductView[]): StepBoardModel {
  const sections = new Map<StaffSectionId, { step: CrosswalkStep; lanes: Map<string, StepBoardLane>; merge: StepBoardSection['merge'] }>();
  const sectionOf = (section: StaffSectionId): { step: CrosswalkStep; lanes: Map<string, StepBoardLane>; merge: StepBoardSection['merge'] } => {
    let entry = sections.get(section);
    if (!entry) { entry = { step: 1, lanes: new Map(), merge: 'none' }; sections.set(section, entry); }
    return entry;
  };
  for (const event of events) {
    if (event.run !== run) continue;
    switch (event.type) {
      case 'staff.step.entered': sectionOf(event.section).step = event.step; break;
      case 'staff.lane.started': sectionOf(event.section).lanes.set(event.member, { member: event.member, status: 'running', ...(event.product ? { product: event.product } : {}) }); break;
      case 'staff.lane.finished': {
        const status: LaneStatus = event.outcome;
        sectionOf(event.section).lanes.set(event.member, { member: event.member, status, ...(event.product ? { product: event.product } : {}) });
        break;
      }
      case 'staff.waiting': {
        const lanes = sectionOf(event.section).lanes;
        const lane = lanes.get(event.member);
        if (!lane || lane.status === 'running') lanes.set(event.member, { member: event.member, status: 'waiting', ...(lane?.product ? { product: lane.product } : {}) });
        break;
      }
      case 'staff.merge.started': sectionOf(event.section).merge = 'merging'; break;
      case 'staff.merge.conflict': sectionOf(event.section).merge = 'conflict'; break;
      case 'staff.merge.resolved': sectionOf(event.section).merge = 'merged'; break;
      default: break;
    }
  }
  const gateOf = (section: StaffSectionId): StepBoardSection['gate'] => {
    const own = registry.filter((view) => view.section === section);
    if (own.some((view) => view.state === 'awaiting-decision')) return 'awaiting-decision';
    if (own.some((view) => view.display === 'draft (held)' || view.display === 'draft (tampered)')) return 'held';
    if (own.some((view) => view.state === 'guard-checked')) return 'cleared';
    return 'none';
  };
  return {
    run,
    sections: [...sections.entries()].map(([section, entry]) => ({ section, step: entry.step, lanes: [...entry.lanes.values()], merge: entry.merge, gate: gateOf(section) }))
  };
}

/** The COP: each layer with its owner, last update and feature count, and the tail of the update log. */
export function copModel(events: readonly StaffEvent[], tail = 20): CopModel {
  const layers = new Map<string, CopLayerModel>();
  const updates: CopUpdatedEvent[] = [];
  for (const event of events) {
    if (event.type !== 'staff.cop.updated') continue;
    layers.set(event.layer, { layer: event.layer, owner: event.owner, updatedAt: event.at, featureCount: event.featureCount });
    updates.push(event);
  }
  return { layers: [...layers.values()], eventTail: updates.slice(-tail) };
}
