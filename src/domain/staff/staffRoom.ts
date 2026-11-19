// The Staff Room (UX concept 4.1, 5 and 12; owner direction 2026-11-18; WP-ROOM): the one picture of a staff run the page draws, built from the drop 1
// read models (step board, product registry, decision queue, COP), the staff events, the scenario and the J2's registers and products. Pure: no I/O, no
// clock (the time is passed in), no vscode. The page lays this out and animates it; it never decides state, and it never receives anything it could
// approve, release or decide with. A person's decision goes back as a message naming the product and the version hash they saw, and the host runs the
// person-only staff command for it, which asks who they are, shows a modal confirmation and signs (src/services/staffCommands.ts).
import { PERSON_DECISION_COMMANDS, STAFF_COMMANDS } from './commands';
import { CROSSWALK, INFORMATION_CREDIBILITY, SOURCE_RELIABILITY, STAFF_SECTIONS } from './doctrine';
import type { CrosswalkStep, StaffLevel, StaffProfileId, StaffSectionId } from './doctrine';
import type { CopModel, DecisionQueueEntry, StaffEvent, StepBoardModel } from './events';
import { formatDtg, independentlyConfirmed, registerFindings } from './intel';
import type { CollectionEntry, PirEntry, SourceEntry } from './intel';
import type { FeedEvent, WatchBoardEntry } from './obs/events';
import { feedPicture } from './obs/events';
import type { StandingWatch } from './obs/watches';
import type { Observation } from './obs/observation';
import { formatGridReference, wgs84ToGrid } from './obs/frame';
import { STAFF_SLUG } from './parse';
import { levelOffer, resolveProfile, sectionCode } from './profiles';
import type { StaffSettings } from './profiles';
import type { ProductView } from './readModels';
import { currentSteps, stepBoard } from './readModels';
import type { RegisterRow } from './registers';
import type { Scenario } from './scenario';
import { buildStaffMap } from './staffRoomMap';
import type { StaffMapModel, EnemyCoa } from './staffRoomMap';
import { staffProductPath } from './writeLimits';

export const STAFF_ROOM_MESSAGE = 'staff-room';
export const STAFF_ROOM_VERSION = 1;

/** The workspaces of the one Staff Room: the war room for the full staff, then each section's own. */
export const STAFF_ROOM_WORKSPACES = ['war-room', 'j2', 'j5', 'j3', 'j4'] as const;
export type StaffRoomWorkspace = (typeof STAFF_ROOM_WORKSPACES)[number];

/** What each section workspace will hold when it arrives in drop 2, named on its own tab now (owner direction 2026-11-18). */
export const WORKSPACES_COMING: Readonly<Record<'j5' | 'j3' | 'j4', { readonly title: string; readonly lines: readonly string[] }>> = {
  j5: {
    title: 'J5 plans workspace',
    lines: ['COA cells side by side, each with its sketch on its own copy of the map', 'The profile\'s validity tests on every COA, with the reason for any risk',
      'J3 and J4 supportability arriving as each sketch is drawn', 'The distinctness check that flags two COAs drifting together', 'The comparison against the commander\'s approved criteria, with the dissent unedited']
  },
  j3: {
    title: 'J3 operations workspace',
    lines: ['The wargame on the shared map: action, reaction and counteraction, with the red cell playing to win', 'The synchronization matrix filling under one time cursor',
      'Decision points as gold stars, each tied to its PIR, becoming the DST and DSM', 'The current operations picture and the CCIR watch', 'Orders and annexes assembling in parallel, letters from the profile']
  },
  j4: {
    title: 'J4 logistics workspace',
    lines: ['Supportability of each COA, with every number from a calculator that shows its formula', 'Days of supply and fuel over time, with the culmination warning',
      'Lines of communication and the logistics layer on the shared map', 'Logistics decision points straight into the commander\'s decision support', 'The sustainment row of the synchronization matrix']
  }
};

/** Display caps: the page receives display data only, and never more of it than it can show. */
const CAP = { text: 600, short: 160, ledger: 80, history: 10, activity: 40, cues: 6, list: 200 } as const;
const clip = (text: unknown, max: number = CAP.text): string => {
  const value = typeof text === 'string' ? text : text === undefined || text === null ? '' : String(text);
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

// ---- The page's model ----------------------------------------------------------------------------------------------------------------------------

export type StepStatus = 'done' | 'now' | 'waiting' | 'next' | 'todo';
export interface RailStep {
  readonly step: number;
  readonly name: string;
  readonly work: string;
  readonly status: StepStatus;
  readonly statusText: string;
  readonly progress: number;
  readonly human: boolean;
  readonly sections: ReadonlyArray<{ readonly id: StaffSectionId; readonly code: string; readonly working: boolean }>;
}

export type MemberState = 'idle' | 'working' | 'waiting' | 'needs' | 'done' | 'failed' | 'stopped';
export interface SquadMember { readonly id: string; readonly abbr: string; readonly state: MemberState; readonly stateText: string; readonly task: string }
export interface Squad {
  readonly section: StaffSectionId;
  readonly code: string;
  readonly name: string;
  readonly lead: string;
  readonly person?: string;
  readonly tag: string;
  readonly step?: number;
  readonly active: boolean;
  readonly members: readonly SquadMember[];
  readonly summary: string;
  readonly workspace: StaffRoomWorkspace;
}

export interface LedgerRow {
  readonly product: string;
  readonly title: string;
  readonly section: StaffSectionId;
  readonly code: string;
  readonly kind: string;
  readonly version: number;
  readonly display: string;
  readonly pill: string;
  readonly owner: string;
  readonly at: string;
  readonly hash: string;
  readonly label: string;
  readonly path: string;
  readonly gates: ReadonlyArray<{ readonly gate: string; readonly verdict: string; readonly version: number }>;
  readonly approvedBy?: string;
  readonly decisionFor?: string;
  readonly dependsOn: readonly string[];
  readonly changedSources: readonly string[];
  readonly tampered?: string;
  readonly held?: readonly string[];
  readonly history: ReadonlyArray<{ readonly at: string; readonly version: number; readonly from: string; readonly to: string; readonly by: string; readonly person: boolean }>;
}

export interface DecisionCard {
  readonly product: string;
  readonly title: string;
  readonly version: number;
  readonly hash: string;
  readonly section: StaffSectionId;
  readonly code: string;
  /** `decide`: approve or reject a product awaiting decision. `release`: release an approved product. */
  readonly kind: 'decide' | 'release';
  readonly decisionFor: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly risk: string }>;
  readonly dissent: readonly string[];
  readonly requestedAt: string;
  readonly deadline?: string;
  readonly overdue: boolean;
  readonly gates: string;
}

export interface ActivityLine { readonly at: string; readonly section: string; readonly kind: 'task' | 'prod' | 'human' | 'gate' | 'info'; readonly text: string }

/** A hand-off to animate: a named thing moving between two places on the page. The page draws it, or a still link under Calm. */
export interface HandoffCue { readonly kind: 'task' | 'prod' | 'human'; readonly from: string; readonly to: string; readonly label: string; readonly workspace: StaffRoomWorkspace }

export interface J2Workspace {
  readonly ecoas: ReadonlyArray<EnemyCoa & { readonly product?: string; readonly state?: string; readonly version?: number }>;
  readonly enemy: ReadonlyArray<{ readonly id: string; readonly designation: string; readonly kind: string; readonly affiliation: string; readonly grid: string; readonly grade: string; readonly gradeWords: string; readonly reports: string; readonly onMap: boolean }>;
  readonly sources: ReadonlyArray<{ readonly id: string; readonly title: string; readonly source: string; readonly discipline: string; readonly grade: string; readonly gradeWords: string; readonly origin: string; readonly reported: string; readonly confirmed: boolean; readonly deception: string }>;
  readonly reports: ReadonlyArray<{ readonly id: string; readonly title: string; readonly kind: string; readonly received: string; readonly grade: string; readonly gradeWords: string; readonly about: string }>;
  readonly pirs: ReadonlyArray<{
    readonly id: string; readonly requirement: string; readonly decisionPoint: string; readonly dp?: { readonly id: string; readonly decision: string; readonly maker: string };
    readonly ltiov: string; readonly ltiovPassed: boolean; readonly status: string; readonly indicators: ReadonlyArray<{ readonly id: string; readonly text: string }>;
    readonly nais: readonly string[]; readonly requestedBy: string; readonly decidedBy?: string
  }>;
  readonly collection: ReadonlyArray<{ readonly id: string; readonly pir: string; readonly indicator: string; readonly nai: string; readonly capability: string; readonly discipline: string; readonly from: string; readonly to: string; readonly needs: string; readonly note: string }>;
  readonly watches: ReadonlyArray<{ readonly id: string; readonly title: string; readonly pir: string; readonly indicator: string; readonly ltiov: string; readonly state: string; readonly stateText: string; readonly alert: string; readonly missed: number; readonly lastMatch?: string }>;
  readonly findings: ReadonlyArray<{ readonly severity: string; readonly subject: string; readonly message: string }>;
  /**
   * Live feed reports from the observation store, newest first, already clamped to the person's clearance by the host: what a running simulation (or any
   * feed) delivers. `simulated` rows carry the SIM badge. `total` counts every visible row, `shown` how many are listed.
   */
  readonly live: { readonly total: number; readonly reports: ReadonlyArray<{ readonly id: string; readonly feed: string; readonly channel: string; readonly simulated: boolean; readonly known: string; readonly what: string; readonly where: string; readonly grade: string; readonly gradeWords: string }> };
  readonly problems: readonly string[];
}

export interface StaffRoomModel {
  readonly v: typeof STAFF_ROOM_VERSION;
  readonly now: number;
  readonly operation: { readonly title: string; readonly region: string; readonly marking: string; readonly hq: string; readonly scenario: boolean };
  readonly profile: { readonly id: StaffProfileId; readonly name: string; readonly process: string; readonly level: StaffLevel };
  readonly clock: { readonly at: string; readonly dtg: string; readonly next?: { readonly label: string; readonly at: string; readonly dtg: string } };
  readonly runs: ReadonlyArray<{ readonly id: string; readonly lastAt: string }>;
  readonly run?: string;
  readonly rail: readonly RailStep[];
  readonly squads: readonly Squad[];
  readonly ledger: readonly LedgerRow[];
  readonly decisions: readonly DecisionCard[];
  readonly map: StaffMapModel;
  readonly j2: J2Workspace;
  readonly activity: readonly ActivityLine[];
  readonly coming: typeof WORKSPACES_COMING;
  readonly ledgerProblem?: string;
  readonly eventLogProblem?: string;
}

// ---- Inputs ------------------------------------------------------------------------------------------------------------------------------------------

export interface J2Input {
  readonly sources: readonly SourceEntry[];
  readonly pirs: readonly PirEntry[];
  readonly plan: readonly CollectionEntry[];
  /** Rows of the DST and DSM, to name the decision each PIR supports. */
  readonly dsm?: readonly RegisterRow[];
  /** The J2's adversary COA set (or threat assessment) body, and which product it is. */
  readonly enemyCoaBody?: string;
  readonly enemyCoaProduct?: string;
  readonly watches?: readonly StandingWatch[];
  /** The observation store's rows the person's clearance covers (the host reads them through the store's reader view). */
  readonly live?: readonly Observation[];
  readonly problems?: readonly string[];
}

export interface StaffRoomInput {
  readonly now: number;
  readonly settings: StaffSettings;
  readonly registry: readonly ProductView[];
  readonly decisions: readonly DecisionQueueEntry[];
  readonly cop: CopModel;
  readonly ledgerProblem?: string;
  readonly eventLogProblem?: string;
  readonly events: readonly StaffEvent[];
  readonly feedEvents?: readonly FeedEvent[];
  readonly run?: string;
  readonly scenario?: Scenario;
  readonly scenarioProblem?: string;
  readonly j2: J2Input;
}

// ---- Small helpers -----------------------------------------------------------------------------------------------------------------------------------

const SQUAD_SECTIONS: readonly StaffSectionId[] = ['command', 'j2', 'j5', 'j3', 'j4'];

function workspaceOf(section: string): StaffRoomWorkspace {
  return section === 'j2' || section === 'j5' || section === 'j3' || section === 'j4' ? section : 'war-room';
}

/** The section's code under the profile ("J-2", "S2"); the command group reads as the chief of staff cell. */
export function codeOf(settings: Pick<StaffSettings, 'profile' | 'level'>, section: StaffSectionId): string {
  if (section === 'command') return 'COS';
  const code = sectionCode(settings.profile, settings.level, section);
  return code ?? (STAFF_SECTIONS[section].number !== undefined ? `J${STAFF_SECTIONS[section].number}` : 'Special staff');
}

function sectionName(settings: Pick<StaffSettings, 'profile' | 'level'>, section: StaffSectionId): string {
  if (section === 'command') return 'Chief of staff cell';
  return `${codeOf(settings, section)} ${STAFF_SECTIONS[section].function}`;
}

export function abbreviation(member: string): string {
  const words = member.split('-').filter(Boolean);
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase();
  return member.slice(0, 2).toUpperCase();
}

const titleOf = (product: string): string => {
  const text = product.replace(/-/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

const PILL: Readonly<Record<string, string>> = {
  draft: 'draft', 'draft (held)': 'held', 'draft (tampered)': 'tampered', 'guard-checked': 'checked', 'awaiting decision': 'awaiting', approved: 'approved',
  rejected: 'rejected', released: 'released', superseded: 'superseded', withdrawn: 'withdrawn'
};

function gradeWords(reliability: string, credibility: string | number): string {
  const r = (SOURCE_RELIABILITY as Record<string, string>)[reliability] ?? reliability;
  const c = (INFORMATION_CREDIBILITY as Record<string, string>)[String(credibility)] ?? String(credibility);
  return `Source ${r.toLowerCase()}; information ${c.toLowerCase()}.`;
}

const actorWords = (actor: { kind: string; name?: string; role?: string; member?: string }): string => (actor.kind === 'person' ? `${actor.name ?? 'A person'} (${actor.role ?? 'person'})` : actor.member ?? 'an agent');

/**
 * Whether a person's decision in the event log is backed by a signed ledger entry: the same product, version, person and outcome in the product's
 * replayed history. The event log is not signed, so the room shows a decision only when the ledger holds it.
 */
export function decisionBacked(event: Extract<StaffEvent, { type: 'staff.decision.recorded' }>, registry: readonly ProductView[]): boolean {
  const view = registry.find((candidate) => candidate.product === event.product);
  return Boolean(view?.history.some((item) => item.actor.kind === 'person' && item.version === event.version && item.to === event.decision
    && item.actor.name === event.person.name && item.actor.role === event.person.role));
}

// ---- Runs, rail and squads -----------------------------------------------------------------------------------------------------------------------------

/** The runs the event log knows, newest activity first. A person's decisions carry no run of their own and are left out. */
export function knownRuns(events: readonly StaffEvent[]): Array<{ id: string; lastAt: string }> {
  const last = new Map<string, string>();
  for (const event of events) if (event.run && event.run !== 'person') last.set(event.run, event.at > (last.get(event.run) ?? '') ? event.at : last.get(event.run)!);
  return [...last.entries()].map(([id, lastAt]) => ({ id, lastAt })).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

function settingsFor(settings: StaffSettings): StaffSettings {
  const offer = levelOffer(settings.profile, settings.level);
  if (offer.offered) return settings;
  if (offer.instead) return { ...settings, profile: offer.instead.profile, level: offer.instead.level };
  return { ...settings, level: 'operational' };
}

function buildRail(settings: StaffSettings, board: StepBoardModel | undefined, steps: Partial<Record<StaffSectionId, CrosswalkStep>>): RailStep[] {
  const resolved = resolveProfile(settings);
  const entries = Object.entries(steps) as Array<[StaffSectionId, CrosswalkStep]>;
  const highest = entries.reduce((max, [, step]) => Math.max(max, step), 0);
  return resolved.steps.filter((row) => row.step <= 7 || entries.some(([, step]) => step === 8)).map((row): RailStep => {
    const on = entries.filter(([, step]) => step === row.step).map(([section]) => section);
    const lanes = (board?.sections ?? []).filter((entry) => on.includes(entry.section)).flatMap((entry) => entry.lanes);
    const waiting = (board?.sections ?? []).some((entry) => on.includes(entry.section) && entry.gate === 'awaiting-decision') || (row.human && on.length > 0);
    let status: StepStatus = 'todo';
    if (on.length) status = waiting ? 'waiting' : 'now';
    else if (row.step < highest) status = 'done';
    else if (row.step === highest + 1) status = 'next';
    const doneLanes = lanes.filter((lane) => lane.status === 'done').length;
    const progress = status === 'done' ? 1 : on.length ? (lanes.length ? Math.max(0.06, doneLanes / lanes.length) : 0.06) : 0;
    const statusText = status === 'done' ? 'Done' : status === 'waiting' ? 'Waiting for a named person' : status === 'now' ? 'Working now' : status === 'next' ? 'Next' : 'Not started';
    return {
      step: row.step, name: clip(row.name ?? row.work, 80), work: row.work, status, statusText, progress: Number(progress.toFixed(3)), human: row.human,
      sections: on.map((section) => ({ id: section, code: codeOf(settings, section), working: (board?.sections ?? []).some((entry) => entry.section === section && entry.lanes.some((lane) => lane.status === 'running')) }))
    };
  });
}

function buildSquads(settings: StaffSettings, events: readonly StaffEvent[], run: string | undefined, board: StepBoardModel | undefined, registry: readonly ProductView[]): Squad[] {
  const sections = [...SQUAD_SECTIONS];
  for (const entry of board?.sections ?? []) if (!sections.includes(entry.section)) sections.push(entry.section);
  // Who waits on a person, and on whom the others wait, from the run's waiting events.
  const waitingOn = new Map<string, { on: string; what: string }>();
  const nested = new Map<string, string>();
  const people = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'staff.waiting' && event.run === run) waitingOn.set(`${event.section}/${event.member}`, { on: event.waitingOn, what: event.what });
    if (event.type === 'staff.lane.started' && event.run === run) waitingOn.delete(`${event.section}/${event.member}`);
    if (event.type === 'staff.team.nested' && (event.parentRun === run || event.childRun === run || event.run === run)) {
      const section = sections.find((candidate) => new RegExp(`(^|-)${candidate}(-|$)`).test(event.team));
      if (section) nested.set(section, event.state);
    }
  }
  // The named person shown on a section comes from the signed ledger (who approved its products), never from the event log, which anyone can append to.
  const latest = [...registry].filter((view) => view.approvedBy).sort((a, b) => (a.history[a.history.length - 1]?.seq ?? 0) - (b.history[b.history.length - 1]?.seq ?? 0));
  for (const view of latest) people.set(view.section, `${view.approvedBy!.name} (${view.approvedBy!.role})`);
  return sections.map((section): Squad => {
    const entry = board?.sections.find((candidate) => candidate.section === section);
    const members: SquadMember[] = (entry?.lanes ?? []).slice(0, 24).map((lane) => {
      const wait = waitingOn.get(`${section}/${lane.member}`);
      let state: MemberState;
      if (lane.status === 'running') state = 'working';
      else if (lane.status === 'waiting') state = wait?.on === 'human' ? 'needs' : 'waiting';
      else if (lane.status === 'done') state = 'done';
      else if (lane.status === 'failed') state = 'failed';
      else state = 'stopped';
      const product = lane.product ? titleOf(lane.product) : undefined;
      const task = state === 'working' ? (product ? `Drafting ${product}` : 'Working')
        : state === 'needs' ? `Needs a person: ${wait?.what ?? 'a decision'}`
          : state === 'waiting' ? `Waiting on ${wait ? (wait.on === 'human' ? 'a person' : codeOf(settings, wait.on as StaffSectionId)) : 'another member'}${wait ? `: ${wait.what}` : ''}`
            : state === 'done' ? (product ? `Delivered ${product}` : 'Finished') : state === 'failed' ? 'Stopped with an error' : 'Stopped';
      const stateText = { idle: 'not tasked', working: 'working', waiting: 'waiting', needs: 'needs a person', done: 'done', failed: 'failed', stopped: 'stopped' }[state];
      return { id: clip(lane.member, 60), abbr: abbreviation(lane.member), state, stateText, task: clip(task, CAP.short) };
    });
    const working = members.filter((member) => member.state === 'working');
    const tag = nested.get(section) ?? (working.length ? 'running' : members.some((member) => member.state === 'needs' || member.state === 'waiting') ? 'waiting'
      : entry?.merge === 'merging' ? 'merging' : entry?.merge === 'conflict' ? 'conflict' : members.length && members.every((member) => member.state === 'done') ? 'done' : 'ready');
    const lead = section === 'command' ? 'The commander and chief of staff' : `The ${codeOf(settings, section)}`;
    const summary = members.length
      ? `${working.length} working${working[0] ? ` · ${working[0].id} > ${working[0].task}` : ''}`
      : 'No agents tasked in this run yet';
    return {
      section, code: codeOf(settings, section), name: sectionName(settings, section), lead, ...(people.get(section) ? { person: people.get(section) } : {}), tag,
      ...(entry ? { step: entry.step } : {}), active: working.length > 0, members, summary: clip(summary, CAP.short), workspace: workspaceOf(section)
    };
  });
}

// ---- Ledger and decisions ------------------------------------------------------------------------------------------------------------------------------

function buildLedger(settings: StaffSettings, registry: readonly ProductView[]): LedgerRow[] {
  return registry.slice(0, CAP.ledger).map((view): LedgerRow => {
    const last = view.history[view.history.length - 1];
    const gates = [
      ...(view.tradecraft ? [{ gate: 'Tradecraft', verdict: view.tradecraft.verdict, version: view.tradecraft.version }] : []),
      ...(view.guard ? [{ gate: 'Release-guard', verdict: view.guard.verdict, version: view.guard.version }] : [])
    ];
    return {
      product: view.product, title: titleOf(view.product), section: view.section, code: codeOf(settings, view.section), kind: view.kind, version: view.version,
      display: view.display, pill: PILL[view.display] ?? 'draft', owner: clip(view.owner, 60), at: last?.at ?? '', hash: view.hash, label: clip(view.label, 60),
      path: staffProductPath(view.section, view.product), gates,
      ...(view.approvedBy ? { approvedBy: clip(`${view.approvedBy.name} (${view.approvedBy.role})`, CAP.short) } : {}),
      ...(view.decisionFor ? { decisionFor: clip(view.decisionFor, 80) } : {}),
      dependsOn: view.dependsOn.map((entry) => `${entry.product} v${entry.version}`),
      changedSources: view.changedSources.map((entry) => `${entry.product} has approved version ${entry.version}`),
      ...(view.tampered ? { tampered: clip(view.tampered) } : {}),
      ...(view.heldReasons?.length ? { held: view.heldReasons.slice(0, 10).map((reason) => clip(reason, 300)) } : {}),
      history: view.history.slice(-CAP.history).reverse().map((item) => ({
        at: item.at, version: item.version, from: item.from ?? 'new', to: item.to, by: clip(actorWords(item.actor), CAP.short), person: item.actor.kind === 'person'
      }))
    };
  });
}

function buildDecisions(settings: StaffSettings, now: number, queue: readonly DecisionQueueEntry[], registry: readonly ProductView[]): DecisionCard[] {
  const byProduct = new Map(registry.map((view) => [view.product, view]));
  const gatesText = (view: ProductView | undefined): string => {
    if (!view) return '';
    const parts = [view.tradecraft ? `tradecraft ${view.tradecraft.verdict}` : '', view.guard ? `release-guard ${view.guard.verdict}` : ''].filter(Boolean);
    return parts.length ? `Passed ${parts.join(', then ')} on version ${view.version}.` : '';
  };
  const cards: DecisionCard[] = [];
  for (const entry of queue) {
    const view = byProduct.get(entry.product);
    if (!view || view.tampered) continue;
    cards.push({
      product: entry.product, title: titleOf(entry.product), version: entry.version, hash: view.hash, section: view.section, code: codeOf(settings, view.section), kind: 'decide',
      decisionFor: clip(entry.decisionFor, 80), options: entry.options.slice(0, 10).map((option) => ({ label: clip(option.label, 200), risk: clip(option.risk, 500) })),
      dissent: entry.dissent.slice(0, 20).map((line) => clip(line, 500)), requestedAt: entry.requestedAt, ...(entry.deadline ? { deadline: entry.deadline } : {}),
      overdue: entry.deadline !== undefined && Date.parse(entry.deadline) < now, gates: gatesText(view)
    });
  }
  for (const view of registry) {
    if (view.state !== 'approved' || view.tampered) continue;
    cards.push({
      product: view.product, title: titleOf(view.product), version: view.version, hash: view.hash, section: view.section, code: codeOf(settings, view.section), kind: 'release',
      decisionFor: clip(view.decisionFor ?? view.approvedBy?.role ?? 'approver', 80), options: [], dissent: [], requestedAt: view.history[view.history.length - 1]?.at ?? '',
      overdue: false, gates: view.approvedBy ? `Approved by ${clip(`${view.approvedBy.name} (${view.approvedBy.role})`, CAP.short)}. Not released yet.` : 'Approved. Not released yet.'
    });
  }
  return cards;
}

// ---- Activity and hand-offs ---------------------------------------------------------------------------------------------------------------------------

/** One staff event in words for the war room's activity line, or undefined for events with nothing to say there. */
export function activityLine(settings: StaffSettings, event: StaffEvent): ActivityLine | undefined {
  const code = (section: StaffSectionId) => codeOf(settings, section);
  switch (event.type) {
    case 'staff.step.entered': return { at: event.at, section: code(event.section), kind: 'info', text: `${code(event.section)} entered step ${event.step}${event.stepName ? `, ${event.stepName}` : ''}.` };
    case 'staff.lane.started': return { at: event.at, section: code(event.section), kind: 'task', text: `${event.member} started${event.product ? ` on ${titleOf(event.product)}` : ''}.` };
    case 'staff.lane.finished': return { at: event.at, section: code(event.section), kind: event.outcome === 'done' ? 'prod' : 'info', text: `${event.member} ${event.outcome === 'done' ? 'finished' : event.outcome === 'failed' ? 'failed' : 'was stopped'}${event.product ? `: ${titleOf(event.product)}` : ''}.` };
    case 'staff.product.state': return { at: event.at, section: code(event.section), kind: event.actor.kind === 'person' ? 'human' : event.to === 'guard-checked' ? 'gate' : 'prod', text: `${titleOf(event.product)} v${event.version}: ${event.from ?? 'new'} to ${event.to}, by ${actorWords(event.actor)}.` };
    case 'staff.gate.verdict': return { at: event.at, section: '', kind: 'gate', text: `${event.gate === 'tradecraft' ? 'Tradecraft' : 'Release-guard'} ${event.verdict} on ${titleOf(event.product)} v${event.version}.` };
    case 'staff.decision.requested': return { at: event.at, section: '', kind: 'human', text: `${titleOf(event.product)} v${event.version} waits for the ${event.role}. Agents stop here.` };
    case 'staff.decision.recorded': return { at: event.at, section: '', kind: 'human', text: `${event.person.name} (${event.person.role}) ${event.decision} ${titleOf(event.product)} v${event.version}, signed.` };
    case 'staff.waiting': return { at: event.at, section: code(event.section), kind: event.waitingOn === 'human' ? 'human' : 'info', text: `${event.member} waits on ${event.waitingOn === 'human' ? 'a person' : code(event.waitingOn)}: ${event.what}` };
    case 'staff.cop.updated': return { at: event.at, section: code(event.owner.section), kind: 'prod', text: `${event.owner.member} updated the ${event.layer.replace(/^cop-|-layer$/g, '')} layer: ${event.summary}` };
    case 'staff.merge.conflict': return { at: event.at, section: code(event.section), kind: 'info', text: `${code(event.section)} has a merge conflict in ${event.files.length} file${event.files.length === 1 ? '' : 's'}.` };
    case 'staff.merge.resolved': return { at: event.at, section: code(event.section), kind: 'prod', text: `${code(event.section)} merged.` };
    case 'staff.rfi.opened': return { at: event.at, section: code(event.from), kind: 'task', text: `RFI ${event.rfi} from ${code(event.from)} to ${event.to === 'higher' ? 'higher' : code(event.to)}.` };
    case 'staff.rfi.overdue': return { at: event.at, section: code(event.from), kind: 'info', text: `RFI ${event.rfi} is past its suspense.` };
    case 'staff.ccir.triggered': return { at: event.at, section: '', kind: 'human', text: `CCIR ${event.ccir} reported as triggered: ${event.report}` };
    case 'staff.wargame.turn': return { at: event.at, section: '', kind: 'info', text: `Wargame ${event.coa} against ${event.enemyCoa}, turn ${event.turn} ${event.phase}.` };
    default: return undefined;
  }
}

/** The hand-offs new events stand for (UX concept 4.1): tasking out in violet, products back in green, a person's decision in gold. */
export function handoffsFor(settings: StaffSettings, events: readonly StaffEvent[], registry: readonly ProductView[]): HandoffCue[] {
  const sectionOf = (product: string): StaffSectionId | undefined => registry.find((view) => view.product === product)?.section;
  const cues: HandoffCue[] = [];
  for (const event of events) {
    switch (event.type) {
      case 'staff.lane.started':
        cues.push({ kind: 'task', from: 'section:command', to: `member:${event.section}:${event.member}`, label: clip(event.product ? titleOf(event.product) : `Task for ${event.member}`, 40), workspace: workspaceOf(event.section) });
        break;
      case 'staff.product.state':
        if (event.actor.kind === 'agent' && (event.to === 'guard-checked' || (event.to === 'draft' && event.from === null))) cues.push({ kind: 'prod', from: `section:${event.section}`, to: `ledger:${event.product}`, label: clip(`${titleOf(event.product)} v${event.version}`, 40), workspace: workspaceOf(event.section) });
        if (event.to === 'awaiting-decision') cues.push({ kind: 'task', from: `section:${event.section}`, to: 'decisions', label: clip(`${titleOf(event.product)}: needs a person`, 40), workspace: workspaceOf(event.section) });
        break;
      case 'staff.decision.recorded': {
        if (!decisionBacked(event, registry)) break;
        const section = sectionOf(event.product) ?? 'command';
        cues.push({ kind: 'human', from: 'decisions', to: `section:${section}`, label: clip(`${event.decision[0].toUpperCase()}${event.decision.slice(1)}: ${titleOf(event.product)}`, 40), workspace: workspaceOf(section) });
        break;
      }
      case 'staff.cop.updated':
        cues.push({ kind: 'prod', from: `section:${event.owner.section}`, to: 'map', label: clip(event.layer.replace(/^cop-|-layer$/g, ''), 40), workspace: workspaceOf(event.owner.section) });
        break;
      case 'staff.waiting':
        if (event.waitingOn !== 'human') cues.push({ kind: 'task', from: `member:${event.section}:${event.member}`, to: `section:${event.waitingOn}`, label: clip(event.what, 40), workspace: workspaceOf(event.section) });
        break;
      default: break;
    }
  }
  void settings;
  return cues.slice(-CAP.cues);
}

// ---- The J2 workspace ------------------------------------------------------------------------------------------------------------------------------------

const WATCH_STATE_TEXT: Readonly<Record<string, string>> = {
  proposed: 'Proposed: a person arms it', armed: 'Armed', paused: 'Paused', matched: 'Matched', drafting: 'Drafting', 'awaiting-review': 'Drafts ready for a person',
  expired: 'Expired', disarmed: 'Disarmed by a person', rejected: 'Rejected by a person'
};
const PAUSE_TEXT: Readonly<Record<string, string>> = { 'no-attended-run': 'no person has the staff run open', 'source-degraded': 'its source is degraded', person: 'a person paused it' };

function dpKey(text: string): string {
  const match = /\bDP[\s-]*(\d+)/i.exec(text);
  return match ? `DP ${match[1]}` : text.trim().toLowerCase();
}

function buildJ2(input: StaffRoomInput, map: StaffMapModel): J2Workspace {
  const now = input.now;
  const j2 = input.j2;
  const coaProduct = j2.enemyCoaProduct ? input.registry.find((view) => view.product === j2.enemyCoaProduct) : undefined;
  const ecoas = map.ecoas.map((coa) => ({ ...coa, ...(coaProduct ? { product: coaProduct.product, state: coaProduct.display, version: coaProduct.version } : {}) }));
  const scenario = input.scenario;
  const onMap = new Map(map.units.map((unit) => [unit.id, unit]));
  const enemy = (scenario?.forces ?? [])
    .filter((force) => { const side = scenario?.parties.find((party) => party.id === force.party)?.side; return side === 'adversary' || side === 'unknown'; })
    .slice(0, CAP.list)
    .map((force) => {
      const unit = onMap.get(force.id);
      const grades = force.reportedBy.map((id) => scenario?.reports.find((report) => report.id === id)).filter(Boolean).map((report) => report!.grade).filter((grade): grade is NonNullable<typeof grade> => Boolean(grade));
      const best = [...grades].sort((a, b) => a.reliability.localeCompare(b.reliability) || a.credibility.localeCompare(b.credibility))[0];
      const side = scenario?.parties.find((party) => party.id === force.party)?.side;
      return {
        id: force.id, designation: clip(force.designation, 80), kind: clip(force.kind, 120), affiliation: side === 'unknown' ? 'Unknown' : 'Hostile',
        grid: unit?.grid ?? 'Not on the map', grade: best ? `${best.reliability}${best.credibility}` : 'Ungraded', gradeWords: best ? gradeWords(best.reliability, best.credibility) : 'No graded report yet.',
        reports: clip(force.reportedBy.join(', ') || 'none', 120), onMap: Boolean(unit)
      };
    });
  const sources = j2.sources.slice(0, CAP.list).map((entry) => ({
    id: entry.id, title: clip(entry.title, 200), source: clip(entry.source, 160), discipline: entry.discipline, grade: `${entry.reliability}${entry.credibility}`,
    gradeWords: gradeWords(entry.reliability, entry.credibility), origin: clip(entry.origin, 160), reported: entry.reportedAt, confirmed: independentlyConfirmed(j2.sources, entry),
    deception: clip(entry.deceptionNote, 300)
  }));
  const reports = (scenario?.reports ?? []).slice(0, CAP.list).map((report) => ({
    id: report.id, title: clip(report.title, 200), kind: report.kind, received: clip(report.received, 40), grade: report.grade ? `${report.grade.reliability}${report.grade.credibility}` : 'Ungraded',
    gradeWords: report.grade ? gradeWords(report.grade.reliability, report.grade.credibility) : 'Not graded.', about: clip(report.about.join(', '), 160)
  }));
  const dsm = new Map((j2.dsm ?? []).map((row) => [dpKey(String(row.id)), row]));
  const naisFor = (pir: string) => [...new Set(j2.plan.filter((entry) => entry.pir === pir).map((entry) => clip(entry.nai, 80)))];
  const pirs: Array<J2Workspace['pirs'][number]> = j2.pirs.slice(0, CAP.list).map((entry) => {
    const row = dsm.get(dpKey(entry.decisionPoint));
    return {
      id: entry.id, requirement: clip(entry.requirement, 400), decisionPoint: clip(entry.decisionPoint, 160),
      ...(row ? { dp: { id: clip(row.id, 40), decision: clip(row.description, 200), maker: clip(row.decisionMaker, 80) } } : {}),
      ltiov: entry.ltiov, ltiovPassed: Date.parse(entry.ltiov) < now, status: entry.status, indicators: entry.indicators.slice(0, 20).map((indicator) => ({ id: indicator.id, text: clip(indicator.text, 300) })),
      nais: naisFor(entry.id), requestedBy: clip(entry.requestedBy, 60), ...(entry.decision ? { decidedBy: clip(`${entry.decision.decision} by ${entry.decision.by.name} (${entry.decision.by.role})`, CAP.short) } : {})
    };
  });
  const indicatorText = (pir: string, id: string) => j2.pirs.find((entry) => entry.id === pir)?.indicators.find((indicator) => indicator.id === id)?.text ?? id;
  const collection = j2.plan.slice(0, CAP.list).map((entry) => ({
    id: entry.id, pir: entry.pir, indicator: clip(indicatorText(entry.pir, entry.indicator), 200), nai: clip(entry.nai, 80), capability: clip(entry.capability, 160), discipline: entry.discipline,
    from: entry.timing.from, to: entry.timing.to, needs: entry.needs === 'partner' ? 'Needs a partner' : 'Needs J3 approval', note: clip(entry.note ?? '', 300)
  }));
  const board = new Map<string, WatchBoardEntry>(feedPicture(input.feedEvents ?? []).watches.map((entry) => [entry.watch, entry]));
  const watches: Array<J2Workspace['watches'][number]> = (j2.watches ?? []).slice(0, CAP.list).map((watch) => {
    const live = board.get(watch.id);
    const state = live?.state ?? watch.state;
    const reason = live?.pausedReason ?? watch.pausedReason;
    return {
      id: watch.id, title: clip(watch.title, 200), pir: watch.pir, indicator: watch.indicator, ltiov: watch.ltiov, state,
      stateText: `${WATCH_STATE_TEXT[state] ?? state}${state === 'paused' && reason ? `: ${PAUSE_TEXT[reason] ?? reason}` : ''}`,
      alert: clip(`${watch.alert.name} (${watch.alert.role})`, CAP.short), missed: live?.missed ?? watch.missedWhilePaused, ...(live?.lastMatch ? { lastMatch: live.lastMatch } : {})
    };
  });
  for (const [id, live] of board) {
    if (watches.some((watch) => watch.id === id)) continue;
    watches.push({ id: clip(id, 40), title: 'A standing watch with no definition in this project', pir: '', indicator: '', ltiov: '', state: live.state, stateText: WATCH_STATE_TEXT[live.state] ?? live.state, alert: '', missed: live.missed, ...(live.lastMatch ? { lastMatch: live.lastMatch } : {}) });
  }
  const findings = registerFindings({ sources: j2.sources, pirs: j2.pirs, plan: j2.plan }, now).slice(0, 12).map((finding) => ({ severity: finding.severity, subject: clip(finding.subject, 80), message: clip(finding.message, 300) }));
  const frame = scenario?.region.frame;
  const whereOf = (row: Observation): string => {
    const point = row.geometry.type === 'Point' ? row.geometry.coordinates : row.geometry.type === 'LineString' ? row.geometry.coordinates[0] : row.geometry.coordinates[0]?.[0];
    if (!point) return 'No position';
    if (frame) { try { return formatGridReference(frame, wgs84ToGrid(frame, { latitude: point[1], longitude: point[0] }), 6); } catch { /* outside the frame: fall through */ } }
    return `${point[1].toFixed(4)}, ${point[0].toFixed(4)}`;
  };
  const visible = [...(j2.live ?? [])].sort((a, b) => b.knownAt.localeCompare(a.knownAt) || a.obsId.localeCompare(b.obsId));
  const live = {
    total: visible.length,
    reports: visible.slice(0, CAP.list).map((row) => ({
      id: row.obsId.slice(0, 16), feed: clip(row.feed, 60), channel: clip(row.channel, 60), simulated: row.simulated, known: row.knownAt,
      what: clip([row.attributes?.name, row.attributes?.excerpt ?? row.subjectRef].filter(Boolean).join(': ') || row.feed, 300), where: whereOf(row),
      grade: `${row.reliability}${row.credibility}`, gradeWords: gradeWords(row.reliability, String(row.credibility))
    }))
  };
  return { ecoas, enemy, sources, reports, pirs, collection, watches, findings, live, problems: (j2.problems ?? []).slice(0, 10).map((problem) => clip(problem, 300)) };
}

// ---- The whole model ---------------------------------------------------------------------------------------------------------------------------------------

/** The run the page shows: the one asked for while it is known, else the one with the newest activity. */
export function pickStaffRun(events: readonly StaffEvent[], wanted: string | undefined): string | undefined {
  const runs = knownRuns(events);
  return runs.find((run) => run.id === wanted)?.id ?? runs[0]?.id;
}

export function buildStaffRoomModel(input: StaffRoomInput): StaffRoomModel {
  const settings = settingsFor(input.settings);
  const resolved = resolveProfile(settings);
  const runs = knownRuns(input.events);
  const run = pickStaffRun(input.events, input.run);
  const board = run ? stepBoard(input.events, run, input.registry) : undefined;
  const steps = run ? currentSteps(input.events, run) : {};
  const map = buildStaffMap({ ...(input.scenario ? { scenario: input.scenario } : {}), ...(input.scenarioProblem ? { scenarioProblem: input.scenarioProblem } : {}), ...(input.j2.enemyCoaBody ? { enemyCoaBody: input.j2.enemyCoaBody } : {}), cop: input.cop });
  const decisions = buildDecisions(settings, input.now, input.decisions, input.registry);
  // One clock: the next decision deadline, else the next latest time of value of a PIR.
  const deadlines = decisions.filter((card) => card.deadline && Date.parse(card.deadline) >= input.now).sort((a, b) => a.deadline!.localeCompare(b.deadline!));
  const ltiovs = input.j2.pirs.filter((pir) => Date.parse(pir.ltiov) >= input.now).sort((a, b) => a.ltiov.localeCompare(b.ltiov));
  const next = deadlines[0]
    ? { label: `${deadlines[0].title} decision due, for the ${deadlines[0].decisionFor}`, at: deadlines[0].deadline!, dtg: formatDtg(Date.parse(deadlines[0].deadline!)) }
    : ltiovs[0] ? { label: `${ltiovs[0].id} latest time of value`, at: ltiovs[0].ltiov, dtg: formatDtg(Date.parse(ltiovs[0].ltiov)) } : undefined;
  const scenario = input.scenario;
  const activity = input.events.slice(-200).map((event) => (event.type === 'staff.decision.recorded' && !decisionBacked(event, input.registry)
    ? { at: event.at, section: '', kind: 'info' as const, text: `The event log names a decision on ${titleOf(event.product)} v${event.version} that the signed ledger does not hold. It is not counted.` }
    : activityLine(settings, event))).filter((line): line is ActivityLine => Boolean(line)).slice(-CAP.activity).reverse()
    .map((line) => ({ ...line, text: clip(line.text, 300) }));
  return {
    v: STAFF_ROOM_VERSION, now: input.now,
    operation: {
      title: clip(scenario?.title ?? 'Staff Room', 120), region: clip(scenario?.region.name ?? 'No exercise scenario loaded', 160), marking: clip(scenario?.marking ?? 'UNCLASSIFIED // EXERCISE // FICTIONAL DATA', 80),
      hq: clip(scenario?.mission.own.headquarters ?? '', 120), scenario: Boolean(scenario)
    },
    profile: { id: settings.profile, name: resolved.profile.name, process: resolved.process.name, level: settings.level },
    clock: { at: new Date(input.now).toISOString(), dtg: formatDtg(input.now), ...(next ? { next } : {}) },
    runs: runs.slice(0, 20), ...(run ? { run } : {}),
    rail: buildRail(settings, board, steps),
    squads: buildSquads(settings, input.events, run, board, input.registry),
    ledger: buildLedger(settings, input.registry),
    decisions,
    map,
    j2: buildJ2(input, map),
    activity,
    coming: WORKSPACES_COMING,
    ...(input.ledgerProblem ? { ledgerProblem: clip(input.ledgerProblem) } : {}),
    ...(input.eventLogProblem ? { eventLogProblem: clip(input.eventLogProblem) } : {})
  };
}

// ---- Messages from the page ------------------------------------------------------------------------------------------------------------------------------

/** What the page may ask for; anything else is ignored. No message can approve, release or decide: `decide` only asks for the person's command. */
export type StaffRoomMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'decide'; readonly action: 'approve' | 'reject' | 'release'; readonly product: string; readonly hash: string }
  | { readonly type: 'open-product'; readonly product: string }
  | { readonly type: 'select-run'; readonly run: string }
  | { readonly type: 'open'; readonly target: 'team-live' | 'load-scenario' | 'set-up-staff' | 'show-products' };

const HASH = /^[a-f0-9]{64}$/;
const RUN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/;
const OPEN_TARGETS = ['team-live', 'load-scenario', 'set-up-staff', 'show-products'] as const;

function exact(message: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(message).every((key) => keys.includes(key));
}

/** Validates a message from the page: its type, its exact keys, and the form of every value. */
export function parseStaffRoomMessage(value: unknown): StaffRoomMessage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case 'ready': return exact(message, ['type']) ? { type: 'ready' } : undefined;
    case 'decide': {
      if (!exact(message, ['type', 'action', 'product', 'hash'])) return undefined;
      const { action, product, hash } = message;
      if (action !== 'approve' && action !== 'reject' && action !== 'release') return undefined;
      if (typeof product !== 'string' || !STAFF_SLUG.test(product) || product.length > 120 || typeof hash !== 'string' || !HASH.test(hash)) return undefined;
      return { type: 'decide', action, product, hash };
    }
    case 'open-product': return exact(message, ['type', 'product']) && typeof message.product === 'string' && STAFF_SLUG.test(message.product) && message.product.length <= 120 ? { type: 'open-product', product: message.product } : undefined;
    case 'select-run': return exact(message, ['type', 'run']) && typeof message.run === 'string' && RUN.test(message.run) ? { type: 'select-run', run: message.run } : undefined;
    case 'open': return exact(message, ['type', 'target']) && (OPEN_TARGETS as readonly unknown[]).includes(message.target) ? { type: 'open', target: message.target as (typeof OPEN_TARGETS)[number] } : undefined;
    default: return undefined;
  }
}

export type DecisionCommand = { readonly ok: true; readonly command: string; readonly args: { readonly product: string; readonly hash: string } } | { readonly ok: false; readonly message: string };

/**
 * The person-only command a decision button stands for, or why it cannot run. A product the page names must be on the decision list the host last sent,
 * at the version hash the person saw, and the action must fit it (approve or reject a product awaiting a decision, release an approved one). The command
 * itself still asks who the person is, shows a modal confirmation, checks the hash again, and signs.
 */
export function decisionCommand(message: Extract<StaffRoomMessage, { type: 'decide' }>, decisions: readonly DecisionCard[]): DecisionCommand {
  const card = decisions.find((candidate) => candidate.product === message.product);
  if (!card) return { ok: false, message: `${message.product} is not waiting for a person's decision now.` };
  if (card.hash !== message.hash) return { ok: false, message: `${message.product} changed since the Staff Room showed it. Look at version ${card.version} first.` };
  const fits = message.action === 'release' ? card.kind === 'release' : card.kind === 'decide';
  if (!fits) return { ok: false, message: `${message.product} cannot be ${message.action === 'release' ? 'released' : message.action === 'approve' ? 'approved' : 'rejected'} from its current state.` };
  const command = message.action === 'approve' ? STAFF_COMMANDS.approve : message.action === 'reject' ? STAFF_COMMANDS.reject : STAFF_COMMANDS.release;
  if (!PERSON_DECISION_COMMANDS.includes(command)) return { ok: false, message: 'That is not a person\'s decision command.' };
  return { ok: true, command, args: { product: message.product, hash: message.hash } };
}

/** Every crosswalk row's plain name, for tests and the page's help. */
export const CROSSWALK_WORK: readonly string[] = CROSSWALK.map((row) => row.work);
