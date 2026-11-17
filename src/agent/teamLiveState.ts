// What the Team Live view shows for a run (0.4.28): one card per member of the team (and the lead), one card per helper that is not a member, each in
// a state a person can read, the lines between them, and the hand-offs that happened since the page last looked. Pure: no DOM, no I/O.
//
// The states are the host's truth, built from the activity feed every time; the page only adds two short animation states of its own (a task travelling
// down a line, a report travelling up), which therefore can never get stuck. See docs in the research note (.planning/research/team-live-view-research.md,
// section 5) for the machine this implements.
import type { AgentStats, WaitingKind } from '../services/agentActivity';
import { buildTeamGraph, MemberCard, MemberNode, toolCapability } from './teamGraph';
import { tidyTree } from './teamLiveLayout';
import type { TeamDefinition } from './teams';

/**
 * A card's state. `bench`: a member not asked to do anything in this run. `interrupted`: VS Code reloaded while it ran, so it is not running now
 * (never shown as working). The rest follow the agent's own status and phase.
 */
export type LiveState = 'bench' | 'queued' | 'working' | 'waiting-agents' | 'needs-you' | 'paused' | 'retrying' | 'done' | 'failed' | 'stopped' | 'interrupted';

const TERMINAL: ReadonlySet<LiveState> = new Set(['done', 'failed', 'stopped', 'interrupted']);
const ACTIVE: ReadonlySet<LiveState> = new Set(['working', 'waiting-agents', 'needs-you', 'paused', 'retrying']);
export const isTerminal = (state: LiveState) => TERMINAL.has(state);
export const isActive = (state: LiveState) => ACTIVE.has(state);

/** A card standing for several agents shows the one that matters most: the person first, then trouble, then work, then the finished ones. */
const PRIORITY: LiveState[] = ['needs-you', 'failed', 'working', 'waiting-agents', 'retrying', 'paused', 'queued', 'stopped', 'done', 'interrupted', 'bench'];

/** What the view needs from one agent's statistics (AgentStats, or the same rebuilt from the project's history after a reload). */
export type LiveAgentStat = Pick<AgentStats, 'agentId' | 'agent' | 'runId' | 'model' | 'status' | 'phase' | 'startedAt' | 'turns' | 'toolCalls' | 'costUsd'> &
  Partial<Pick<AgentStats, 'parentId' | 'endedAt' | 'boundary' | 'tool' | 'task' | 'member' | 'background' | 'team' | 'waitingKind' | 'coolUntil' | 'coolReason' | 'reportsDelivered' | 'approvals' | 'phaseSince'>> &
  { interrupted?: boolean };

/**
 * One agent's state. A run whose lead has ended has no agent still working: one the feed still shows as running or queued (its end was not recorded, or
 * the run stopped before it got a slot) is shown as stopped, and one from history that never ended (VS Code reloaded) as interrupted.
 */
export function agentState(stat: LiveAgentStat, runEnded = false): LiveState {
  if (stat.interrupted) return 'interrupted';
  switch (stat.status) {
    case 'completed': return 'done';
    case 'failed': return 'failed';
    case 'cancelled': case 'stuck': case 'max-turns': return 'stopped';
    default: break;
  }
  if (runEnded) return 'stopped';
  switch (stat.phase) {
    case 'queued': return 'queued';
    case 'waiting-you': return 'needs-you';
    case 'waiting-agents': return 'waiting-agents';
    case 'paused': return 'paused';
    case 'cooling-down': return 'retrying';
    default: return 'working';
  }
}

/** The state of a card standing for several agents (a member run three times): needs you wins, then failed, working, ... (see PRIORITY). */
export function combinedState(states: LiveState[]): LiveState {
  if (!states.length) return 'bench';
  return PRIORITY.find((state) => states.includes(state)) ?? 'bench';
}

/** A line from a card to the one it hangs under: faint before anything happened, armed while queued, lit while working, drawn once done. */
export type EdgeState = 'faint' | 'armed' | 'lit' | 'drawn';
export function edgeState(child: LiveState): EdgeState {
  if (child === 'bench') return 'faint';
  if (child === 'queued') return 'armed';
  return isActive(child) ? 'lit' : 'drawn';
}

/** The words for each state; with the icon, the page never says a state by colour alone. */
export const STATE_WORD: Record<LiveState, string> = {
  bench: 'Not asked yet', queued: 'Queued', working: 'Working', 'waiting-agents': 'Waiting for helpers', 'needs-you': 'Needs you', paused: 'Paused',
  retrying: 'Retrying', done: 'Done', failed: 'Failed', stopped: 'Stopped', interrupted: 'Interrupted'
};

const WAITING_WORD: Record<WaitingKind, string> = { approval: 'an approval', question: 'an answer to a question', image: 'an image to review' };

/** The capability icon for a tool name (the page draws one small icon per key). */
export type ToolIcon = 'read' | 'change' | 'run' | 'web' | 'plan' | 'memory' | 'media' | 'documents' | 'connected' | 'other';
const ICONS: Record<string, ToolIcon> = { 'Read files': 'read', 'Change files': 'change', 'Run commands': 'run', 'Use the web': 'web', 'Plan and coordinate': 'plan', 'Keep and use memory': 'memory', 'Make media': 'media', 'Deliver documents': 'documents', 'Use connected tools': 'connected' };
export function toolIcon(tool: string | undefined): ToolIcon | undefined {
  if (!tool) return undefined;
  const capability = toolCapability(tool);
  return capability ? ICONS[capability] ?? 'other' : 'other';
}

export type Privacy = 'TEE' | 'Local' | 'Cloud';
const PRIVACY: Record<string, Privacy> = { tee: 'TEE', local: 'Local', cloud: 'Cloud' };

export interface LiveInstance {
  agentId: string;
  state: LiveState;
  task?: string;
  /** The card of the agent that started it. */
  from: string;
  startedAt: number;
  endedAt?: number;
  /** Whether it handed back a report: finished, failed, or stopped short (turn limit, no progress), not stopped by a person. */
  reports: boolean;
}

export interface LiveNode {
  /** `lead`, `m:<member>` or `g:<key>`. */
  id: string;
  kind: 'lead' | 'member' | 'guest';
  name: string;
  role?: string;
  /** The card it hangs under: the lead, the member it reports to, or (for a helper) the card of the agent that started it. */
  parent?: string;
  /** The card that started its newest instance, when that is not `parent` (the lead asked a member that reports to someone else). */
  via?: string;
  state: LiveState;
  word: string;
  /** One line of what it is doing, never a tool's input. */
  activity?: string;
  tool?: string;
  icon?: ToolIcon;
  task?: string;
  model?: string;
  privacy?: Privacy;
  background?: boolean;
  /** How many agents the card stands for, and how they stand ("3 tasks: 2 done, 1 working"). */
  count: number;
  tally?: string;
  /** The agent the card's controls and excerpt act on: its working (or newest) instance. */
  agentId?: string;
  since?: number;
  endedAt?: number;
  turns: number;
  toolCalls: number;
  costUsd: number;
  approvalsAsked: number;
  approvalsDeclined: number;
  waitingKind?: WaitingKind;
  coolUntil?: number;
  /** The lead: background reports it has read, and reports finished but not read yet. */
  reportsIn?: number;
  reportsWaiting?: number;
  /** Members: the card Team Studio shows. */
  card?: MemberCard;
  instances: LiveInstance[];
}

export interface LiveEdge { from: string; to: string; kind: 'org' | 'live'; state: EdgeState }

export interface TeamLiveView {
  runId: string;
  title: string;
  team?: { name: string; description: string };
  /** The run as a whole: running, or how it ended. */
  state: LiveState;
  nodes: LiveNode[];
  edges: LiveEdge[];
  /** The tree of the lead and members: slots and rows (see teamLiveLayout). Helpers are in `guests`, in the order they appeared. */
  tree: { places: Array<{ id: string; x: number; depth: number }>; width: number; rows: number };
  /** Every card in reading order (the narrow list and the keyboard), with its depth. Helpers follow the card that started them. */
  order: Array<{ id: string; depth: number }>;
  guests: string[];
  summary: string;
}

const MAX_INSTANCES = 10;

/** The view of one run, from its agents' statistics and the team it started with. */
export function buildTeamLive(input: { runId: string; stats: LiveAgentStat[]; team?: TeamDefinition; title?: string }): TeamLiveView {
  const stats = input.stats.filter((stat) => stat.runId === input.runId).sort((a, b) => a.startedAt - b.startedAt || a.agentId.localeCompare(b.agentId));
  const mainId = `main-${input.runId}`;
  const main = stats.find((stat) => stat.agentId === mainId);
  const runEnded = Boolean(main && main.status !== 'running');
  const graph = input.team ? buildTeamGraph(input.team) : undefined;
  const members = graph ? [...graph.byName.keys()] : [];
  // The members in drawing order, each with the card it reports to.
  const memberParent = new Map<string, string>();
  if (graph) {
    const walk = (node: MemberNode, parent: string) => { memberParent.set(node.name, parent); for (const child of node.children) walk(child, `m:${node.name}`); };
    for (const root of graph.roots) walk(root, 'lead');
  }
  // Which card each agent is on. A helper's card depends on its starter's card, which is found by following the starter, whatever order the agents
  // came in (two can start in the same millisecond); an unknown or looping starter means the lead.
  const byId = new Map(stats.map((stat) => [stat.agentId, stat]));
  const nodeOf = new Map<string, string>([[mainId, 'lead']]);
  const cardOf = (agentId: string | undefined, seen: Set<string> = new Set()): string => {
    if (!agentId) return 'lead';
    const known = nodeOf.get(agentId);
    if (known) return known;
    const stat = byId.get(agentId);
    if (!stat || seen.has(agentId)) return 'lead';
    seen.add(agentId);
    const id = members.includes(stat.agent) ? `m:${stat.agent}` : stat.agent === 'general-purpose' ? `g:${stat.agentId}` : `g:${cardOf(stat.parentId, seen)}>${stat.agent}`;
    nodeOf.set(agentId, id);
    return id;
  };
  const groups = new Map<string, { kind: 'member' | 'guest'; name: string; parent: string; stats: LiveAgentStat[] }>();
  for (const name of members) groups.set(`m:${name}`, { kind: 'member', name, parent: memberParent.get(name) ?? 'lead', stats: [] });
  const guestOrder: string[] = [];
  for (const stat of stats) {
    if (stat.agentId === mainId) continue;
    const id = cardOf(stat.agentId);
    // Helpers of one kind started by one card share a card with a count; general-purpose ones say nothing by their name, so each keeps its own.
    if (!groups.has(id)) { groups.set(id, { kind: 'guest', name: stat.agent === 'general-purpose' ? stat.task ?? 'helper' : stat.agent, parent: cardOf(stat.parentId), stats: [] }); guestOrder.push(id); }
    groups.get(id)!.stats.push(stat);
  }
  const spawnerOf = (stat: LiveAgentStat) => cardOf(stat.parentId);
  const reportsBack = (stat: LiveAgentStat, state: LiveState) => state === 'done' || state === 'failed' || (state === 'stopped' && (stat.status === 'stuck' || stat.status === 'max-turns'));
  const nodes: LiveNode[] = [];
  const leadState = main ? agentState(main) : 'interrupted';
  const lead: LiveNode = {
    // A /team run's lead is the team's lead; a workflow that only works with a team (its members on hand) is led by the workflow itself.
    id: 'lead', kind: 'lead', name: graph && (!main || main.agent.startsWith('team:')) ? graph.team.name : main?.agent ?? input.title ?? 'Lead', ...(graph && (!main || main.agent.startsWith('team:')) ? { role: 'Lead' } : {}),
    ...describe(main ? [main] : [], (stat) => agentState(stat)),
    count: main ? 1 : 0, instances: main ? [instance(main, leadState, 'lead', false)] : []
  };
  if (main) {
    lead.reportsIn = main.reportsDelivered ?? 0;
    const finishedForLead = stats.filter((stat) => stat.parentId === mainId && stat.background && reportsBack(stat, agentState(stat, runEnded))).length;
    lead.reportsWaiting = Math.max(0, finishedForLead - lead.reportsIn);
    if (main.status === 'running' && main.phase === 'waiting-agents') {
      const helpers = stats.filter((stat) => stat.parentId === mainId && !isTerminal(agentState(stat, runEnded))).length;
      if (helpers) lead.activity = `Waiting for ${helpers} helper${helpers === 1 ? '' : 's'}`;
    }
  }
  nodes.push(lead);
  for (const [id, group] of groups) {
    const states = group.stats.map((stat) => agentState(stat, runEnded));
    const node: LiveNode = {
      id, kind: group.kind, name: group.name, parent: group.parent,
      ...describe(group.stats, (stat) => agentState(stat, runEnded)),
      count: group.stats.length,
      instances: group.stats.slice(-MAX_INSTANCES).map((stat) => instance(stat, agentState(stat, runEnded), spawnerOf(stat), reportsBack(stat, agentState(stat, runEnded))))
    };
    if (group.kind === 'member') {
      const card = graph!.byName.get(group.name)!.card;
      node.card = card;
      if (card.role) node.role = card.role;
    }
    if (group.stats.length > 1) node.tally = tally(states);
    const newest = group.stats.at(-1);
    const via = newest ? spawnerOf(newest) : undefined;
    if (via && via !== group.parent && via !== id) node.via = via;
    if (!group.stats.length) { node.state = 'bench'; node.word = STATE_WORD.bench; }
    // A member's own helpers waiting: say how many.
    if (node.state === 'waiting-agents' && node.agentId) {
      const helpers = stats.filter((stat) => stat.parentId === node.agentId && !isTerminal(agentState(stat, runEnded))).length;
      if (helpers) node.activity = `Waiting for ${helpers} helper${helpers === 1 ? '' : 's'}`;
    }
    nodes.push(node);
  }
  const edges: LiveEdge[] = [];
  for (const node of nodes) {
    if (!node.parent) continue;
    edges.push({ from: node.parent, to: node.id, kind: node.kind === 'member' ? 'org' : 'live', state: edgeState(node.state) });
    if (node.via) edges.push({ from: node.via, to: node.id, kind: 'live', state: edgeState(node.state) });
  }
  const tree = tidyTree([{ id: 'lead' }, ...nodes.filter((node) => node.kind === 'member').map((node) => ({ id: node.id, parent: node.parent }))]);
  // Reading order: the tree, each card followed by its members, then by the helpers it started (theirs after them), so a new helper never comes between
  // a card and the members under it.
  const order: Array<{ id: string; depth: number }> = [];
  const placed = new Set<string>();
  const memberChildren = (parent: string) => tree.order.filter((entry) => nodes.find((candidate) => candidate.id === entry.id)?.parent === parent && entry.id !== 'lead');
  const visit = (id: string, depth: number) => {
    if (placed.has(id)) return;
    placed.add(id);
    order.push({ id, depth });
    for (const child of memberChildren(id)) visit(child.id, depth + 1);
    addGuests(id, depth + 1);
  };
  const addGuests = (parent: string, depth: number) => {
    for (const guest of guestOrder) {
      const node = nodes.find((candidate) => candidate.id === guest)!;
      if (node.parent !== parent || placed.has(guest)) continue;
      placed.add(guest);
      order.push({ id: guest, depth });
      addGuests(guest, depth + 1);
    }
  };
  for (const entry of tree.order) if (entry.depth === 0) visit(entry.id, 0);
  for (const entry of tree.order) visit(entry.id, entry.depth);
  for (const guest of guestOrder) if (!placed.has(guest)) { placed.add(guest); order.push({ id: guest, depth: 1 }); addGuests(guest, 2); }
  const runState = main ? leadState : 'interrupted';
  return {
    runId: input.runId,
    title: input.title ?? (graph ? graph.team.name : main?.agent ?? 'Run'),
    ...(graph ? { team: { name: graph.team.name, description: graph.team.description } } : {}),
    state: runState, nodes, edges,
    tree: { places: tree.places, width: tree.width, rows: tree.rows }, order, guests: guestOrder,
    summary: summaryOf(graph ? `Team ${graph.team.name}` : input.title ?? 'This run', nodes.filter((node) => node.kind !== 'lead'), runState)
  };
}

function instance(stat: LiveAgentStat, state: LiveState, from: string, reports: boolean): LiveInstance {
  return { agentId: stat.agentId, state, ...(stat.task ? { task: stat.task } : {}), from, startedAt: stat.startedAt, ...(stat.endedAt ? { endedAt: stat.endedAt } : {}), reports };
}

/** The fields a card takes from the agents it stands for: the one in the most important state speaks for it; counters add up. */
function describe(stats: LiveAgentStat[], stateOf: (stat: LiveAgentStat) => LiveState): Omit<LiveNode, 'id' | 'kind' | 'name' | 'count' | 'instances'> {
  const states = stats.map(stateOf);
  const state = combinedState(states);
  const lead = stats.length ? [...stats].reverse()[states.slice().reverse().indexOf(state)] : undefined;
  const sum = (pick: (stat: LiveAgentStat) => number) => stats.reduce((total, stat) => total + pick(stat), 0);
  const base = {
    state, word: lead ? wordFor(lead, state) : STATE_WORD.bench,
    turns: sum((stat) => stat.turns), toolCalls: sum((stat) => stat.toolCalls), costUsd: sum((stat) => stat.costUsd),
    approvalsAsked: sum((stat) => stat.approvals?.asked ?? 0), approvalsDeclined: sum((stat) => stat.approvals?.declined ?? 0)
  };
  if (!lead) return base;
  const privacy = lead.boundary ? PRIVACY[lead.boundary] : undefined;
  const icon = state === 'working' ? toolIcon(lead.tool) : undefined;
  return {
    ...base,
    agentId: lead.agentId, since: lead.startedAt, ...(lead.endedAt ? { endedAt: lead.endedAt } : {}), model: lead.model, ...(privacy ? { privacy } : {}),
    ...(lead.task ? { task: lead.task } : {}), ...(lead.background ? { background: true } : {}),
    ...(state === 'working' && lead.tool ? { tool: lead.tool } : {}), ...(icon ? { icon } : {}),
    ...(state === 'needs-you' && lead.waitingKind ? { waitingKind: lead.waitingKind } : {}),
    ...(state === 'retrying' && lead.coolUntil ? { coolUntil: lead.coolUntil } : {}),
    activity: activityOf(lead, state)
  };
}

function wordFor(stat: LiveAgentStat, state: LiveState): string {
  if (state === 'needs-you' && stat.waitingKind) return `Needs you: ${WAITING_WORD[stat.waitingKind]}`;
  if (state === 'stopped') return stat.status === 'stuck' ? 'Stopped: not making progress' : stat.status === 'max-turns' ? 'Stopped: reached its turn limit' : 'Stopped';
  if (state === 'interrupted') return 'Interrupted: VS Code reloaded';
  if (state === 'retrying' && stat.coolReason === 'rate-limited') return 'Retrying (rate limited)';
  return STATE_WORD[state];
}

/** Phase words plus the bare tool name: never a tool's title, which can carry its input. */
function activityOf(stat: LiveAgentStat, state: LiveState): string {
  if (state === 'queued') return 'Waiting for a free slot';
  if (state === 'needs-you') return 'Answer in chat';
  if (state === 'paused') return 'Paused';
  if (state === 'waiting-agents') return 'Waiting for its helpers';
  if (state === 'retrying') return stat.coolReason === 'rate-limited' ? 'NEAR is busy; trying again' : 'Trying again';
  if (state === 'done') return `${stat.toolCalls} tool call${stat.toolCalls === 1 ? '' : 's'}`;
  if (state === 'failed') return 'Did not finish';
  if (state === 'stopped' || state === 'interrupted') return 'Not running';
  if (stat.phase === 'tool') return stat.tool ? `Running ${stat.tool}` : 'Running a tool';
  if (stat.phase === 'generating') return 'Writing';
  if (stat.phase === 'starting') return 'Starting';
  return 'Thinking';
}

function tally(states: LiveState[]): string {
  const counts = new Map<string, number>();
  for (const state of states) { const word = STATE_WORD[state].toLowerCase(); counts.set(word, (counts.get(word) ?? 0) + 1); }
  return `${states.length} tasks: ${[...counts].map(([word, count]) => `${count} ${word}`).join(', ')}`;
}

function summaryOf(name: string, nodes: LiveNode[], runState: LiveState): string {
  const counts = new Map<LiveState, number>();
  for (const node of nodes) for (const item of node.instances) counts.set(item.state, (counts.get(item.state) ?? 0) + 1);
  const parts = (['needs-you', 'working', 'waiting-agents', 'queued', 'paused', 'retrying', 'done', 'failed', 'stopped', 'interrupted'] as LiveState[]).filter((state) => counts.get(state)).map((state) => `${counts.get(state)} ${STATE_WORD[state].toLowerCase()}`);
  const run = isTerminal(runState) ? ` The run is ${runState === 'done' ? 'finished' : STATE_WORD[runState].toLowerCase()}.` : '';
  return `${name}: ${parts.length ? parts.join(', ') : 'nobody asked yet'}.${run}`;
}

/** Something that happened between two views: a task handed down, a report handed back, or a change worth saying aloud. */
export type LiveEvent =
  | { kind: 'delegate'; from: string; to: string; agentId: string; task?: string }
  | { kind: 'report'; from: string; to: string; agentId: string; ok: boolean }
  | { kind: 'run-ended' }
  | { kind: 'announce'; text: string };

/**
 * What happened between the view the page shows and the new one. With no earlier view (the page just opened, or reopened) nothing happened: the page
 * draws every card in its current state with no catch-up animation. An agent seen for the first time already finished gets its hand-off and its report;
 * a cancelled one hands back nothing. Announcements are for discrete changes only, never for activity lines.
 */
export function teamLiveEvents(previous: TeamLiveView | undefined, next: TeamLiveView): LiveEvent[] {
  if (!previous || previous.runId !== next.runId) return [];
  const before = new Map<string, LiveInstance>();
  for (const node of previous.nodes) for (const item of node.instances) before.set(item.agentId, item);
  const events: LiveEvent[] = [];
  const nameOf = new Map(next.nodes.map((node) => [node.id, node.name]));
  for (const node of next.nodes) {
    if (node.kind === 'lead') continue;
    for (const item of node.instances) {
      const was = before.get(item.agentId);
      const name = node.name;
      const started = item.state !== 'queued';
      if ((!was || was.state === 'queued') && started) {
        events.push({ kind: 'delegate', from: item.from, to: node.id, agentId: item.agentId, ...(item.task ? { task: item.task } : {}) });
        if (!isTerminal(item.state)) events.push({ kind: 'announce', text: `${nameOf.get(item.from) ?? 'The lead'} handed ${name} ${item.task ? `a task: ${item.task}` : 'a task'}.` });
      } else if (!was && item.state === 'queued') events.push({ kind: 'announce', text: `${name} is waiting for a free slot${item.task ? ` to ${item.task}` : ''}.` });
      if (isTerminal(item.state) && (!was || !isTerminal(was.state))) {
        if (item.reports) events.push({ kind: 'report', from: node.id, to: item.from, agentId: item.agentId, ok: item.state === 'done' });
        events.push({ kind: 'announce', text: `${name} ${item.state === 'done' ? 'is done' : item.state === 'failed' ? 'failed' : 'stopped'}.` });
      }
      if (item.state === 'needs-you' && was?.state !== 'needs-you') events.push({ kind: 'announce', text: `${name} needs you: answer in chat.` });
    }
  }
  const leadBefore = previous.nodes.find((node) => node.id === 'lead');
  const leadNow = next.nodes.find((node) => node.id === 'lead');
  if (leadNow?.state === 'needs-you' && leadBefore?.state !== 'needs-you') events.push({ kind: 'announce', text: 'The lead needs you: answer in chat.' });
  if (isTerminal(next.state) && !isTerminal(previous.state)) {
    events.push({ kind: 'run-ended' });
    events.push({ kind: 'announce', text: next.state === 'done' ? 'The run is finished.' : `The run ${next.state === 'failed' ? 'failed' : 'stopped'}.` });
  }
  return events;
}
