// The staff tools a staff team's members use (design 10, 4.1, 4.2, 4.4 and 6.2; WP-SHARED): the built-in `staff-products` server, `guard-scan`, and the
// tradecraft lint. They are named as MCP tools (mcp__<server>__<tool>) so a team file grants them the way the design writes it, `mcp:staff-products`
// (or `mcp__staff-products__<verb>` one by one) and `mcp:guard-scan`, and a member gets only what its `tools:` line names. The tradecraft lint is
// `mcp__staff-products__lint`, because the SIGN-OFF verdict runs the same check; the intel-workbench server is a separate package's. They run in this process: nothing is sent anywhere.
//
// The verbs are exactly the agent verbs of the release state machine (propose, verdict, submit, withdraw, status, list) plus the registers, the wargame
// ledger and the step mark. There is no approve, reject, release or supersede tool, and there never is one: those are a person's, through the VS Code
// commands, and the state machine refuses them from any agent in any case. A test walks these tools to prove it.
import { AGENT_PRODUCT_VERBS } from '../domain/staff/release';
import type { StaffGate } from '../domain/staff/release';
import { STAFF_SLUG } from '../domain/staff/parse';
import type { DecisionOption } from '../domain/staff/events';
import type { ProductDependency } from '../domain/staff/products';
import type { StaffCaller, StaffHost, StaffResult, StaffTeamInfo } from '../staff/staffHost';
import { STAFF_HOST_PATHS, staffSectionOf } from '../staff/staffHost';
import type { TeamDefinition } from './teams';
import { declareManifest, INTERACTIVE_AND_UNATTENDED } from './tools';
import type { AgentTool, ToolContext } from './tools';
import { ToolError } from './workspace';

export const STAFF_PRODUCTS_SERVER = 'staff-products';
export const GUARD_SCAN_SERVER = 'guard-scan';

/** The staff-products tools: the agent verbs of the state machine, then the registers, the wargame and the step mark. */
export const STAFF_PRODUCT_TOOL_VERBS = [...AGENT_PRODUCT_VERBS, 'register', 'register_read', 'wargame', 'step', 'lint'] as const;

export const staffToolName = (server: string, verb: string): string => `mcp__${server}__${verb}`;

/**
 * The staff tools a write-limited member (a staff team's red team, release guard or J3 watch officer, src/domain/staff/writeLimits.ts) keeps when its
 * tools line lists them. They write only through the host, which records the ledger, the header and the gate report, never a product body: propose is
 * refused for any product outside the member's write limit, register writes no register outside it (proposing rows and reporting a CCIR trigger stay
 * open), and verdict only records a gate member's verdict.
 */
export const WRITE_LIMITED_STAFF_TOOLS: ReadonlySet<string> = new Set([
  ...(['propose', 'verdict', 'status', 'list', 'lint', 'register', 'register_read'] as const).map((verb) => staffToolName(STAFF_PRODUCTS_SERVER, verb)),
  staffToolName(GUARD_SCAN_SERVER, 'scan')
]);

/** Words no staff tool may be named after: the decisions only a person takes. */
export const HUMAN_ONLY_WORDS: readonly string[] = ['approve', 'reject', 'release', 'supersede', 'decide', 'sign'];

/**
 * The staff team as the tools see it, from its team file: the section from its `staff:` block, its members, and its section lead (the member that
 * reports to no other member, the section's integrator). Undefined for a team without a `staff:` block.
 */
export function staffTeamInfo(team: Pick<TeamDefinition, 'slug' | 'members' | 'staff'>): StaffTeamInfo | undefined {
  if (!team.staff || !team.members.length) return undefined;
  const names = team.members.map((member) => member.name);
  const top = team.members.filter((member) => !member.reportsTo || !names.includes(member.reportsTo));
  const lead = top.find((member) => member.name !== 'release-guard' && member.name !== 'tradecraft-reviewer') ?? top[0] ?? team.members[0];
  return { slug: team.slug, section: team.staff.section, members: names, sectionLead: lead.name, ...(team.staff.profile ? { profile: team.staff.profile } : {}), ...(team.staff.level ? { level: team.staff.level } : {}) };
}

export interface StaffToolAccess {
  /** The host for the project, or undefined when the extension has not set one up (the tools then say so). */
  host(): StaffHost | undefined;
  readonly team: StaffTeamInfo;
  readonly run: string;
}

/**
 * The files the staff tools touch: they read everything the host reads (the staff folder, the project's staff settings and the guard settings), and
 * write only inside the staff folder.
 */
const READS = { verb: 'read', paths: [...STAFF_HOST_PATHS] };
const WRITES = { verb: 'workspaceWrite', paths: ['.planning/staff/**'] };
const readManifest = (tool: string) => declareManifest({ tool, effects: [READS], contexts: INTERACTIVE_AND_UNATTENDED });
const writeManifest = (tool: string) => declareManifest({ tool, effects: [READS, WRITES], contexts: INTERACTIVE_AND_UNATTENDED });

function text(raw: Record<string, unknown>, key: string, max = 500): string {
  const value = raw[key];
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) throw new ToolError(`${key} is required, as text of at most ${max} characters.`);
  return value.trim();
}

function optionalText(raw: Record<string, unknown>, key: string, max = 500): string | undefined {
  return raw[key] === undefined ? undefined : text(raw, key, max);
}

function product(raw: Record<string, unknown>): string {
  const value = text(raw, 'product', 64);
  if (!STAFF_SLUG.test(value)) throw new ToolError('product is a product name: lower case letters, digits and dashes, such as intelligence-estimate.');
  return value;
}

function lines(raw: Record<string, unknown>, key: string): string[] {
  const value = raw[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20 || !value.every((item) => typeof item === 'string' && item.length <= 500)) throw new ToolError(`${key} is a list of at most 20 lines of text.`);
  return value.map((item: string) => item.trim()).filter(Boolean);
}

function dependencies(raw: Record<string, unknown>): ProductDependency[] | undefined {
  const value = raw.dependsOn;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50) throw new ToolError('dependsOn is a list such as ["jipoe-steps-1-2@2"].');
  return value.map((item) => {
    const match = typeof item === 'string' ? /^([a-z0-9][a-z0-9-]{0,63})@([1-9][0-9]{0,5})$/.exec(item.trim()) : null;
    if (!match) throw new ToolError(`dependsOn entries are product@version, such as adversary-coas@4 (not ${String(item).slice(0, 60)}).`);
    return { product: match[1], version: Number(match[2]) };
  });
}

function result(outcome: StaffResult): string {
  if (!outcome.ok) throw new ToolError(outcome.message);
  return outcome.text;
}

/**
 * Builds the staff tools for one run of one staff team. The member making a call is the sub-agent's label (its member slug in the team file); the run's
 * lead agent has none, so it can read and mark steps but never act on a product.
 */
export function staffTools(access: StaffToolAccess): AgentTool<any>[] {
  const callerOf = (context: ToolContext): StaffCaller => ({ member: context.agentLabel, run: access.run, root: context.root, team: access.team });
  const hostOf = (): StaffHost => {
    const host = access.host();
    if (!host) throw new ToolError('The staff products host is not ready in this window. Reload the window and try again.');
    return host;
  };
  const name = (verb: string) => staffToolName(STAFF_PRODUCTS_SERVER, verb);
  const PRODUCT = { type: 'string', description: 'The product name, as in .planning/staff/products/<section>/<product>.md (for example intelligence-estimate).' };

  const propose: AgentTool<{ product: string; kind?: string; label?: string; dependsOn?: ProductDependency[] }> = {
    name: name('propose'),
    description: '[staff-products] Record the product you own as a new version, after you wrote it at .planning/staff/products/<section>/<product>.md. The first propose makes you its owner. Give kind on the first one (estimate, adversary-coa-set, coa-statement, register, matrix, map-layer, annex, order, report, brief, critique, plan), the label (default org/Internal) and what it depends on (product@version). The tool writes the staff header; you write only the body. Any later change to the file makes a new version and voids earlier gate verdicts.',
    parameters: { type: 'object', properties: { product: PRODUCT, kind: { type: 'string' }, label: { type: 'string' }, dependsOn: { type: 'array', items: { type: 'string' } } }, required: ['product'], additionalProperties: false },
    capability: 'workspaceWrite',
    manifest: writeManifest(name('propose')),
    parse: (raw) => {
      const depends = dependencies(raw);
      const kind = optionalText(raw, 'kind', 40);
      const label = optionalText(raw, 'label', 80);
      return { product: product(raw), ...(kind ? { kind } : {}), ...(label ? { label } : {}), ...(depends ? { dependsOn: depends } : {}) };
    },
    title: (input) => `Propose ${input.product}`,
    run: async (input, context) => result(await hostOf().propose(callerOf(context), input))
  };

  const verdict: AgentTool<{ product: string; gate: StaffGate; verdict: string; hash: string; reasons: string[] }> = {
    name: name('verdict'),
    description: '[staff-products] Give your gate verdict on the exact version you checked. The release-guard gives gate "guard" with CLEARED or HOLD; the tradecraft reviewer gives gate "tradecraft" with SIGN-OFF or NOT READY. hash is the version hash from status or guard-scan. HOLD and NOT READY need numbered reasons. CLEARED is refused while guard-scan holds the version, and for J2 until tradecraft signed it off; SIGN-OFF is refused while the tradecraft lint has findings. The tool writes your report beside the product.',
    parameters: {
      type: 'object',
      properties: { product: PRODUCT, gate: { type: 'string', enum: ['guard', 'tradecraft'] }, verdict: { type: 'string', enum: ['CLEARED', 'HOLD', 'SIGN-OFF', 'NOT READY'] }, hash: { type: 'string' }, reasons: { type: 'array', items: { type: 'string' } } },
      required: ['product', 'gate', 'verdict', 'hash'], additionalProperties: false
    },
    capability: 'workspaceWrite',
    manifest: writeManifest(name('verdict')),
    parse: (raw) => {
      const gate = raw.gate === 'guard' || raw.gate === 'tradecraft' ? raw.gate : undefined;
      if (!gate) throw new ToolError('gate is guard or tradecraft.');
      const hash = text(raw, 'hash', 64).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new ToolError('hash is the 64-character version hash that status or guard-scan gave.');
      return { product: product(raw), gate, verdict: text(raw, 'verdict', 20), hash, reasons: lines(raw, 'reasons') };
    },
    title: (input) => `${input.verdict} on ${input.product}`,
    run: async (input, context) => result(await hostOf().verdict(callerOf(context), input))
  };

  const submit: AgentTool<{ product: string; decisionFor: string; options: DecisionOption[]; dissent: string[]; deadline?: string }> = {
    name: name('submit'),
    description: '[staff-products] Put a guard-checked product in front of the person who decides: name their role (decisionFor, for example commander), the options with the risk of each, any dissent (kept beside the options, unedited) and the deadline if there is one. Only the owner or the section lead submits. A person then decides; no member ever approves.',
    parameters: {
      type: 'object',
      properties: {
        product: PRODUCT, decisionFor: { type: 'string' },
        options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, risk: { type: 'string' } }, required: ['label', 'risk'], additionalProperties: false } },
        dissent: { type: 'array', items: { type: 'string' } }, deadline: { type: 'string', description: 'ISO time, for example 2026-11-18T14:00:00.000Z.' }
      },
      required: ['product', 'decisionFor'], additionalProperties: false
    },
    capability: 'workspaceWrite',
    manifest: writeManifest(name('submit')),
    parse: (raw) => {
      const options = raw.options === undefined ? [] : raw.options;
      if (!Array.isArray(options) || options.length > 10) throw new ToolError('options is a list of at most 10 { label, risk } items.');
      const parsed = options.map((option) => {
        if (!option || typeof option !== 'object') throw new ToolError('Each option is { label, risk }.');
        const record = option as Record<string, unknown>;
        return { label: text(record, 'label', 200), risk: text(record, 'risk', 500) };
      });
      const deadline = optionalText(raw, 'deadline', 40);
      return { product: product(raw), decisionFor: text(raw, 'decisionFor', 80), options: parsed, dissent: lines(raw, 'dissent'), ...(deadline ? { deadline } : {}) };
    },
    title: (input) => `Submit ${input.product} for the ${input.decisionFor}`,
    run: async (input, context) => result(await hostOf().submit(callerOf(context), input))
  };

  const withdraw: AgentTool<{ product: string; reason: string }> = {
    name: name('withdraw'),
    description: '[staff-products] Withdraw a product you own that no person has decided on yet, with the reason.',
    parameters: { type: 'object', properties: { product: PRODUCT, reason: { type: 'string' } }, required: ['product', 'reason'], additionalProperties: false },
    capability: 'workspaceWrite',
    manifest: writeManifest(name('withdraw')),
    parse: (raw) => ({ product: product(raw), reason: text(raw, 'reason') }),
    title: (input) => `Withdraw ${input.product}`,
    run: async (input, context) => result(await hostOf().withdraw(callerOf(context), input))
  };

  const status: AgentTool<{ product: string }> = {
    name: name('status'),
    description: '[staff-products] One product\'s state, version and version hash, gate verdicts, who it waits on, what it depends on (and whether a source changed), and its recent steps. A change to the file since its last version is reported, and recorded by the next write.',
    parameters: { type: 'object', properties: { product: PRODUCT }, required: ['product'], additionalProperties: false },
    capability: 'read',
    manifest: readManifest(name('status')),
    concurrent: true,
    parse: (raw) => ({ product: product(raw) }),
    title: (input) => `Status of ${input.product}`,
    run: async (input, context) => result(await hostOf().status(callerOf(context), input.product))
  };

  const list: AgentTool<{ all: boolean }> = {
    name: name('list'),
    description: '[staff-products] The products of this team\'s section (or of every section with all: true), newest change first, with their state.',
    parameters: { type: 'object', properties: { all: { type: 'boolean' } }, additionalProperties: false },
    capability: 'read',
    manifest: readManifest(name('list')),
    concurrent: true,
    parse: (raw) => ({ all: raw.all === true }),
    title: () => 'List staff products',
    run: async (input, context) => result(await hostOf().list(callerOf(context), input))
  };

  const register: AgentTool<{ action: 'write' | 'propose' | 'trigger'; register: string; rows: unknown[]; remove: string[]; part?: string; note?: string; ccir?: string; report?: string; label?: string }> = {
    name: name('register'),
    description: '[staff-products] Changes the structured registers: ccir-register, rfi-tracker, facts-assumptions-ledger, annex-tracker, sync-matrix, dst-dsm, targeting-workbook, event-log. action write (the register\'s writer, or a part\'s writer with part, such as pir on the ccir-register) adds or replaces rows by id and removes ids; propose leaves rows for the writer to merge; trigger reports that a CCIR fired (ccir, report). Rows are checked against the register\'s columns. Read a register with mcp__staff-products__register_read. The PIR register is kept by the intel workbench, not here.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['write', 'propose', 'trigger'] }, register: { type: 'string' }, rows: { type: 'array', items: { type: 'object' } },
        remove: { type: 'array', items: { type: 'string' } }, part: { type: 'string' }, note: { type: 'string' }, ccir: { type: 'string' }, report: { type: 'string' }, label: { type: 'string' }
      },
      required: ['action'], additionalProperties: false
    },
    capability: 'workspaceWrite',
    manifest: writeManifest(name('register')),
    parse: (raw) => {
      const action = raw.action;
      if (action === 'read') throw new ToolError('Read a register with mcp__staff-products__register_read; this tool only changes registers.');
      if (action !== 'write' && action !== 'propose' && action !== 'trigger') throw new ToolError('action is write, propose or trigger.');
      const rows = raw.rows === undefined ? [] : raw.rows;
      if (!Array.isArray(rows) || rows.length > 500) throw new ToolError('rows is a list of at most 500 rows.');
      const part = optionalText(raw, 'part', 40);
      const note = optionalText(raw, 'note');
      const ccir = optionalText(raw, 'ccir', 40);
      const report = optionalText(raw, 'report');
      const label = optionalText(raw, 'label', 80);
      return { action, register: action === 'trigger' ? 'ccir-register' : text(raw, 'register', 64), rows, remove: lines(raw, 'remove'), ...(part ? { part } : {}), ...(note ? { note } : {}), ...(ccir ? { ccir } : {}), ...(report ? { report } : {}), ...(label ? { label } : {}) };
    },
    title: (input) => `${input.action} ${input.register}`,
    run: async (input, context) => {
      const host = hostOf();
      const caller = callerOf(context);
      switch (input.action) {
        case 'write': return result(await host.registerWrite(caller, { register: input.register, rows: input.rows, remove: input.remove, ...(input.part ? { part: input.part } : {}), ...(input.label ? { label: input.label } : {}) }));
        case 'propose': return result(await host.registerPropose(caller, { register: input.register, rows: input.rows, ...(input.note ? { note: input.note } : {}) }));
        default:
          if (!input.ccir || !input.report) throw new ToolError('trigger needs ccir (the CCIR id) and report (what was seen).');
          return result(await host.ccirTrigger(caller, { ccir: input.ccir, report: input.report }));
      }
    }
  };

  const registerRead: AgentTool<{ register: string }> = {
    name: name('register_read'),
    description: '[staff-products] Reads a structured register\'s rows: ccir-register, rfi-tracker, facts-assumptions-ledger, annex-tracker, sync-matrix, dst-dsm, targeting-workbook, event-log; and pir-register, which returns the intel workbench\'s PIR register (its one source) with every decision checked against the signed log. Reads only.',
    parameters: { type: 'object', properties: { register: { type: 'string' } }, required: ['register'], additionalProperties: false },
    capability: 'read',
    manifest: readManifest(name('register_read')),
    concurrent: true,
    parse: (raw) => ({ register: text(raw, 'register', 64) }),
    title: (input) => `Read ${input.register}`,
    run: async (input, context) => result(await hostOf().registerRead(callerOf(context), input.register))
  };

  const wargame: AgentTool<{ action: 'record' | 'derive' | 'read'; phase?: unknown }> = {
    name: name('wargame'),
    description: '[staff-products] The wargame ledger. action record writes one phase of a turn, in order ACTION (friendly), REACTION (adversary), COUNTERACTION (friendly), for one COA against one adversary COA: phase is { coa, enemyCoa, turn, phase, hHourOffsetMinutes, moves: [{ unit, path: [[x, y]], sidc? }], results, decisionPoints: [{ id, description, decisionMaker, indicator?, nai?, pir?, recommendedAction? }], sync: [{ row, entry, section? }], branches }. action derive builds the sync matrix, DST and DSM rows and the branch list from the record (written to those registers when you are their writer). action read returns the record.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['record', 'derive', 'read'] }, phase: { type: 'object' } }, required: ['action'], additionalProperties: false },
    capability: 'workspaceWrite',
    manifest: writeManifest(name('wargame')),
    parse: (raw) => {
      const action = raw.action;
      if (action !== 'record' && action !== 'derive' && action !== 'read') throw new ToolError('action is record, derive or read.');
      if (action === 'record' && (typeof raw.phase !== 'object' || raw.phase === null)) throw new ToolError('record needs phase.');
      return { action, ...(raw.phase !== undefined ? { phase: raw.phase } : {}) };
    },
    title: (input) => `Wargame: ${input.action}`,
    run: async (input, context) => {
      const host = hostOf();
      if (input.action === 'record') return result(await host.wargameRecord(callerOf(context), input.phase));
      if (input.action === 'derive') return result(await host.wargameDerive(callerOf(context)));
      const entries = await host.wargameEntries();
      return entries.length ? JSON.stringify(entries, null, 2) : 'No wargame phases recorded yet.';
    }
  };

  const step: AgentTool<{ step: number; section?: string }> = {
    name: name('step'),
    description: '[staff-products] Mark that the section (this team\'s, or another one named) entered a crosswalk step, 1 to 8 (1 start, 2 understand, 3 build options, 4 test, 5 compare, 6 decide, 7 write the plan, 8 keep it valid). The profile\'s own step name is recorded with it for the process rail.',
    parameters: { type: 'object', properties: { step: { type: 'integer', minimum: 1, maximum: 8 }, section: { type: 'string' } }, required: ['step'], additionalProperties: false },
    capability: 'workspaceWrite',
    manifest: writeManifest(name('step')),
    parse: (raw) => {
      if (!Number.isInteger(raw.step) || (raw.step as number) < 1 || (raw.step as number) > 8) throw new ToolError('step is a whole number from 1 to 8.');
      const section = optionalText(raw, 'section', 20);
      if (section !== undefined && !staffSectionOf(section)) throw new ToolError('section is a staff section id such as j2.');
      return { step: raw.step as number, ...(section ? { section } : {}) };
    },
    title: (input) => `Step ${input.step}`,
    run: async (input, context) => result(await hostOf().enterStep(callerOf(context), { step: input.step, ...(input.section ? { section: staffSectionOf(input.section)! } : {}) }))
  };

  const scan: AgentTool<{ product: string }> = {
    name: staffToolName(GUARD_SCAN_SERVER, 'scan'),
    description: '[guard-scan] The release-guard\'s deterministic checks on a product as it is now: classification and caveat markings of every shipped scale, the label against the template ceiling, coordinates against the exercise box, the real-entity list, publications with no public copy, decisions written as made, personal data, secrets, J4 numbers without a calculator record, and support review marks. Gives each finding as HOLD or CHECK, and the version hash it scanned.',
    parameters: { type: 'object', properties: { product: PRODUCT }, required: ['product'], additionalProperties: false },
    capability: 'read',
    manifest: readManifest(staffToolName(GUARD_SCAN_SERVER, 'scan')),
    concurrent: true,
    parse: (raw) => ({ product: product(raw) }),
    title: (input) => `guard-scan ${input.product}`,
    run: async (input, context) => result(await hostOf().scanText(callerOf(context), input.product))
  };

  const lint: AgentTool<{ product: string }> = {
    name: name('lint'),
    description: '[staff-products] The J2 tradecraft lint (ICD 203) on a product as it is now: likelihood terms from the ICD 203 table only, never likelihood and confidence in one sentence, every key judgement marked, every fact sourced as [src:<id>], sources graded A to F and 1 to 6 separately with origin and dates, no two same-origin reports counted as confirmation, every PIR with a decision point and latest time of value, every HVT in an adversary COA, MLCOA and MDCOA named. Gives the version hash it checked.',
    parameters: { type: 'object', properties: { product: PRODUCT }, required: ['product'], additionalProperties: false },
    capability: 'read',
    manifest: readManifest(name('lint')),
    concurrent: true,
    parse: (raw) => ({ product: product(raw) }),
    title: (input) => `Tradecraft lint ${input.product}`,
    run: async (input, context) => result(await hostOf().lintText(callerOf(context), input.product))
  };

  return [propose, verdict, submit, withdraw, status, list, register, registerRead, wargame, step, lint, scan];
}
