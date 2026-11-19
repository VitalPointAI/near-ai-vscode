// The built-in staff servers, as the Tools page and the Team Studio tool picker list them (design 10, 6.2): staff-products, guard-scan, the
// intel-workbench and the logistics server. They run inside the extension and are given only to a staff team's run (a team file with a `staff:`
// block); a member reaches them through its `tools:` line, by the whole server (`mcp:<id>`) or one tool at a time (`mcp__<id>__<tool>`). The tool
// objects here are the very ones a run is given, built without a project, so the lists cannot drift from what a run gets. None of them approves,
// rejects, releases or supersedes: those are a person's decisions, made with the NEAR AI: Staff commands.
import { INTEL_WORKBENCH_SERVER, intelWorkbenchTools } from './intelWorkbench';
import { LOGISTICS_SERVER, logisticsTools } from './logisticsTools';
import { GUARD_SCAN_SERVER, STAFF_PRODUCTS_SERVER, staffTools } from './staffTools';

export interface BuiltInStaffServer {
  readonly id: string;
  /** What a team file's `tools:` line names to grant every tool of the server. */
  readonly grant: string;
  readonly name: string;
  readonly description: string;
  readonly tools: ReturnType<typeof staffTools>;
}

/** The grant for a whole built-in server, as a team file writes it. */
export const staffServerGrant = (id: string): string => `mcp:${id}`;

/** The built-in staff servers with their tools, in the order the pages list them. */
export function builtInStaffServers(): BuiltInStaffServer[] {
  const products = staffTools({ host: () => undefined, team: { slug: 'tools-directory', section: 'j2', members: [], sectionLead: '' }, run: 'tools-directory' });
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
    {
      id: INTEL_WORKBENCH_SERVER, grant: staffServerGrant(INTEL_WORKBENCH_SERVER), name: 'Intel workbench (built in)', tools: intelWorkbenchTools(),
      description: 'The J2 registers: the source register with reliability and credibility graded apart, the PIR register, collection recommendations, INTSUM and INTREP drafts, and the compilation check. It recommends; a person decides.'
    },
    {
      id: LOGISTICS_SERVER, grant: staffServerGrant(LOGISTICS_SERVER), name: 'Logistics (built in)',
      tools: logisticsTools({ host: () => undefined, team: { slug: 'tools-directory', section: 'j4', members: [], sectionLead: '' }, run: 'tools-directory' }),
      description: 'The J4 tools: the consumption calculator (planning factors a person entered, the formula on every result, each result a signed calculator record), LOGSTAT entry, validation and consolidation, notional movement tables and local routing, and readiness import. It ships no planning factor tables and decides nothing.'
    }
  ];
}
