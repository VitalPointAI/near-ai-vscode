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
export const STAFF_WARGAME_TOOL = 'mcp__staff-products__wargame';
export const STAFF_STEP_TOOL = 'mcp__staff-products__step';
/** The one tradecraft rule set (ICD 203), for the tradecraft gate: src/domain/staff/tradecraftLint.ts. */
export const STAFF_LINT_TOOL = 'mcp__staff-products__lint';

/** The other built-in or design servers, granted by pattern: every tool of each. */
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
