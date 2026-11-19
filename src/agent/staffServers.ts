// The built-in staff servers, listed once (design 10, 6.2): staff-products, guard-scan, the intel-workbench, observations (research note 11, section
// 5), cop-map and logistics. The Tools page, the Team Studio tool picker and a staff team's run all read this one list. The servers run inside the
// extension and are given only to a staff team's run (a team file with a `staff:` block); a member reaches them through its `tools:` line, by the
// whole server (`mcp:<id>`), a family pattern or one tool at a time (`mcp__<id>__<tool>`). staff-products and guard-scan are gated by role inside the
// staff tools; every other server is gated on grants (staffGrantGate.ts), so the run's lead and an ungranted member cannot call it. The tool objects
// the pages show are built by the same factories as a run's, without a project, so the lists cannot drift from what a run gets. None of them approves,
// rejects, releases or supersedes: those are a person's decisions, made with the NEAR AI: Staff commands.
import type { ObservationStore } from '../staff/observationStore';
import type { StaffHost, StaffTeamInfo } from '../staff/staffHost';
import { COP_MAP_SERVER, copMapTools } from './copMap';
import { INTEL_WORKBENCH_SERVER, intelWorkbenchTools } from './intelWorkbench';
import { LOGISTICS_SERVER, logisticsTools } from './logisticsTools';
import { OBSERVATIONS_SERVER, observationsTools } from './observationsTools';
import { watchTools } from './watchTools';
import { watchHostFor } from '../staff/watchHost';
import { grantedToMembers } from './staffGrantGate';
import type { GrantedTeam } from './staffGrantGate';
import { GUARD_SCAN_SERVER, STAFF_PRODUCTS_SERVER, staffTools } from './staffTools';
import type { AgentTool } from './tools';

export interface BuiltInStaffServer {
  readonly id: string;
  /** What a team file's `tools:` line names to grant every tool of the server. */
  readonly grant: string;
  readonly name: string;
  readonly description: string;
  readonly tools: ReturnType<typeof staffTools>;
}

/** What a staff run's servers need from the project: its staff host and observation store (undefined while not set up), the team and the run. */
export interface StaffServerAccess {
  host(): StaffHost | undefined;
  store(): ObservationStore | undefined;
  readonly team: StaffTeamInfo;
  readonly run: string;
}

/** The grant for a whole built-in server, as a team file writes it. */
export const staffServerGrant = (id: string): string => `mcp:${id}`;

interface GatedStaffServer {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Who to ask instead, at the end of a refusal. */
  readonly hint?: string;
  readonly build: (access: StaffServerAccess) => AgentTool<any>[];
}

/** The built-in servers beyond staff-products and guard-scan, in the order the pages list them and a run is given them. */
const GATED_STAFF_SERVERS: readonly GatedStaffServer[] = [
  {
    id: INTEL_WORKBENCH_SERVER, name: 'Intel workbench (built in)', hint: 'Ask the member that owns the register.',
    description: 'The J2 registers: the source register with reliability and credibility graded apart, the PIR register, collection recommendations, INTSUM and INTREP drafts, and the compilation check. It recommends; a person decides.',
    build: () => intelWorkbenchTools()
  },
  {
    id: OBSERVATIONS_SERVER, name: 'Observations (built in)',
    description: 'The project\'s feed observations, read only and clamped to your clearances: slices by area, time, grade, discipline and unit, tracks with their decay, what changed since a time, corroboration by independent origin, timelines, feed status, and the picture as known at any time. Every answer says when a limit cut it. The J2 watch members also propose standing watches and draft for their matches; a named person arms them, and nothing is released by a watch.',
    build: (access) => [
      ...observationsTools({ store: () => access.store() }),
      ...watchTools({ watches: () => { const host = access.host(); return host ? watchHostFor(host.root) : undefined; }, team: access.team, run: access.run })
    ]
  },
  {
    id: COP_MAP_SERVER, name: 'COP map (built in)',
    description: 'The common operational picture: read the layers, put military symbols, control measures, overlays per adversary course of action and decision points on the layer you write, and propose features for the others. Each product layer has one writer; feed layers are views nobody writes. Nothing is fetched from the network.',
    build: (access) => copMapTools({ host: () => access.host(), team: access.team, run: access.run })
  },
  {
    id: LOGISTICS_SERVER, name: 'Logistics (built in)',
    description: 'The J4 tools: the consumption calculator (planning factors a person entered, the formula on every result, each result a signed calculator record), LOGSTAT entry, validation and consolidation, notional movement tables and local routing, and readiness import. It ships no planning factor tables and decides nothing.',
    build: (access) => logisticsTools({ host: () => access.host()?.logistics(), team: access.team, run: access.run })
  }
];

/** The ids of the grant-gated servers, in run order. */
export const GATED_STAFF_SERVER_IDS: readonly string[] = GATED_STAFF_SERVERS.map((server) => server.id);

const NO_PROJECT = (section: StaffTeamInfo['section']): StaffServerAccess => ({
  host: () => undefined, store: () => undefined, team: { slug: 'tools-directory', section, members: [], sectionLead: '' }, run: 'tools-directory'
});

/** The built-in staff servers with their tools, in the order the pages list them. */
export function builtInStaffServers(): BuiltInStaffServer[] {
  const products = staffTools({ host: () => undefined, team: NO_PROJECT('j2').team, run: 'tools-directory' });
  const of = (server: string) => products.filter((tool) => tool.name.startsWith(`mcp__${server}__`));
  return [
    {
      id: STAFF_PRODUCTS_SERVER, grant: staffServerGrant(STAFF_PRODUCTS_SERVER), name: 'Staff products (built in)', tools: of(STAFF_PRODUCTS_SERVER),
      description: 'A staff team\'s products and registers: propose a version, give a gate verdict, submit for a person\'s decision, the registers, the wargame ledger, the planning step and the tradecraft lint. A person approves, rejects and releases with the NEAR AI: Staff commands; no tool can.'
    },
    {
      id: GUARD_SCAN_SERVER, grant: staffServerGrant(GUARD_SCAN_SERVER), name: 'Guard scan (built in)', tools: of(GUARD_SCAN_SERVER),
      description: 'The release guard\'s deterministic checks on a staff product: markings, the label ceiling, coordinates outside the exercise box, the real-entity list, decisions written as made, personal data, secrets, and J4 numbers with no calculator record the calculator ledger vouches for.'
    },
    ...GATED_STAFF_SERVERS.map((server) => ({
      id: server.id, grant: staffServerGrant(server.id), name: server.name, description: server.description,
      tools: server.build(NO_PROJECT(server.id === LOGISTICS_SERVER ? 'j4' : 'j2'))
    }))
  ];
}

/**
 * The grant-gated servers' tools for one staff team's run: for each server, only the tools some member is granted, each refusing the run's lead and any
 * member whose own tools line does not grant it. A team with no grant for a server gets none of its tools.
 */
export function staffServerToolsForRun(team: GrantedTeam, access: StaffServerAccess): AgentTool<any>[] {
  return GATED_STAFF_SERVERS.flatMap((server) => grantedToMembers(team, server.id, server.build(access), server.hint));
}
