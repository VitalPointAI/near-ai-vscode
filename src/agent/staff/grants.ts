// The tool grants every staff section template gives its members (design 10, 4.1 and 6.2), so J2, J5 and the sections that follow grant the built-in
// staff servers the same way. Members get only the verbs their job needs, by role: owners register their own products, the section's integrator also
// submits and withdraws, and the two gates record verdicts. No member can be granted approve, reject, release or supersede: no such tool exists, and
// the contract offers agents no such verb. Pure: no I/O, no clock, no vscode.
import { AGENT_PRODUCT_VERBS } from '../../domain/staff/release';
import type { AgentProductVerb } from '../../domain/staff/release';

/** The staff-products verbs as MCP tool names (the server is `staff-products`, built into the extension; src/agent/staffTools.ts). */
export function staffProductTools(verbs: readonly AgentProductVerb[]): string[] {
  return verbs.filter((verb) => (AGENT_PRODUCT_VERBS as readonly string[]).includes(verb)).map((verb) => `mcp__staff-products__${verb}`);
}

export const OWNER_VERBS: readonly AgentProductVerb[] = ['propose', 'status', 'list'];
export const LEAD_VERBS: readonly AgentProductVerb[] = ['propose', 'submit', 'withdraw', 'status', 'list'];
export const GATE_VERBS: readonly AgentProductVerb[] = ['verdict', 'status', 'list'];

/** The staff-products tools that are not product-state verbs: the shared registers, the wargame ledger, the step rail and the tradecraft lint. */
export const STAFF_REGISTER_TOOL = 'mcp__staff-products__register';
/** Reading a register is its own tool, a read, so a read never asks for a write approval. */
export const STAFF_REGISTER_READ_TOOL = 'mcp__staff-products__register_read';
/** Both register tools, granted together to every member that works with the registers. */
export const STAFF_REGISTER_TOOLS: readonly string[] = [STAFF_REGISTER_TOOL, STAFF_REGISTER_READ_TOOL];
export const STAFF_WARGAME_TOOL = 'mcp__staff-products__wargame';
export const STAFF_STEP_TOOL = 'mcp__staff-products__step';
/** The one tradecraft rule set (ICD 203), for the tradecraft gate: src/domain/staff/tradecraftLint.ts. */
export const STAFF_LINT_TOOL = 'mcp__staff-products__lint';

/** The other built-in servers, granted by pattern: every tool of each. Only servers that exist are granted (a test holds every grant to a server). */
export const INTEL_WORKBENCH = 'mcp__intel-workbench__*';
export const COP_MAP = 'mcp__cop-map__*';
export const GUARD_SCAN = 'mcp__guard-scan__*';

/**
 * The logistics server (design 10, 6.2; built by WP-LOG), granted by tool family so each J4 member gets only what its job needs. WP-LOG names its tools
 * with these prefixes: `calc_` (the consumption calculator: user-entered factors times the force list times days, the formula shown on every result,
 * each result kept as a record at .planning/staff/calculator/<id>.json and cited in a product as calc:<id>), `logstat_` (submit, validate, consolidate,
 * diff against the forecast), `movement_` (notional movement tables, lift feasibility, local routing) and `readiness_` (readiness import). It ships no
 * government factor tables.
 */
export const LOGISTICS_SERVER = 'logistics';
export const LOGISTICS_CALCULATOR = 'mcp__logistics__calc*';
export const LOGISTICS_LOGSTAT = 'mcp__logistics__logstat*';
export const LOGISTICS_LOGSTAT_READ = 'mcp__logistics__logstat_read';
export const LOGISTICS_LOGSTAT_VALIDATE = 'mcp__logistics__logstat_validate';
export const LOGISTICS_MOVEMENT = 'mcp__logistics__movement*';
export const LOGISTICS_MOVEMENT_READ = 'mcp__logistics__movement_read';
export const LOGISTICS_READINESS = 'mcp__logistics__readiness*';
/** The observations server's read tools (research note 11, section 5): slices, tracks, changes, corroboration, timelines and feed status. */
export const OBSERVATIONS = 'mcp__observations__obs_*';
/**
 * The observations server's standing watch tools (research note 11, 4.5; WP-WATCH): propose a watch, list them, draft for a match and report the drafts
 * ready. Arming, pausing, resuming, acknowledging and retiring are a named person's commands, never a tool.
 */
export const OBSERVATIONS_WATCH = 'mcp__observations__watch_*';

/**
 * The members that read the feeds, by section (research note 11, 1 and 6.1): the J2's integrator and the analysts who build the threat picture, warning
 * and collection from observations; the J3's integrator, current operations and the liaison that owns the maritime and air pictures. Gates, the red cell,
 * the targeting analyst and the requirements manager work from products, not from raw observations, and are not granted it.
 */
export const OBSERVATIONS_GRANTEES: Readonly<Record<'j2' | 'j3', readonly string[]>> = {
  j2: ['j2-chief', 's2-lead', 'collection-manager', 'jipoe-analyst', 'geoint-analyst', 'osint-analyst', 'threat-analyst', 'watch-officer', 'warning-analyst', 'ipb-analyst'],
  j3: ['j3-director', 's3-lead', 'joc-chief', 'current-ops-chief', 'watch-officer', 'airspace-maritime-liaison']
};

/**
 * The members that work standing watches (research note 11, 4.5; design 10, 3.2): the watch officer, who watches the indicators and writes the INTREP
 * when one fires; the warning analyst, who does that at strategic level in place of a watch; and the owner of the adversary courses of action (the threat
 * analyst, or the IPB analyst in a brigade or battalion S2), who drafts the revised assessment a match bears on. J2 only: the watches serve PIRs.
 */
export const OBSERVATIONS_WATCH_GRANTEES: readonly string[] = ['watch-officer', 'warning-analyst', 'threat-analyst', 'ipb-analyst'];
