// The logistics server (design 10, 6.2; research note 03, B5, B8 and B12; WP-LOG): the J4 team's local tools for the consumption calculator, LOGSTAT,
// notional movement and readiness. Every rule lives in src/domain/staff/logistics/; the files are src/staff/logisticsHost.ts's.
//
// It is a built-in local server, not a process: the tools run inside the extension and are named `mcp__logistics__<tool>`, so the J4 template's grants
// reach them by family exactly as they would a connected server's: `mcp__logistics__calc*` (calc_run, calc_read, calc_list, calc_factors),
// `mcp__logistics__logstat*` (logstat_submit, logstat_read, logstat_validate, logstat_consolidate), `mcp__logistics__movement*` (movement_table,
// movement_read, movement_route) and `mcp__logistics__readiness*` (readiness_import, readiness_read). Each declares its manifest next to it, naming the
// project files it reads and writes; none declares a network, MCP, shell, send or publish effect, and routing runs on a road graph in the project, so
// nothing here leaves the machine.
//
// The calculator takes no rate from an agent: a rate is a planning factor a named person entered, and the extension ships none. Every result shows its
// formula. Every record the server writes (a calculation, a checked movement table, a readiness import) is entered in the calculator ledger, signed with
// this device's key, so guard-scan can tell a record the calculator wrote from a file a member wrote by hand. No tool approves, decides or sets a priority.
import { readFile } from 'node:fs/promises';
import {
  computeConsumption, consolidateLogstat, consolidationMarkdown, describeRecord, FACTORS_EXAMPLE, FACTORS_FILE, formatNumber, importReadiness,
  LOGSTAT_RULES, LOGSTAT_VALIDATION_FILE, LOGSTAT_VALIDATION_PRODUCT, MAX_READINESS_BYTES, movementBoard, movementBoardMarkdown, parseBandSettings,
  readinessBoardMarkdown, recordHash, recordResultText, ROADS_FILE, shortestRoute, checkMovementTable, validateLogstat, validationLogMarkdown
} from '../domain/staff/logistics';
import type { CalcRecord, CalcResult, MovementRecord, ReadinessRecord, ValidationLogEntry } from '../domain/staff/logistics';
import { RESERVED_MEMBER_SLUGS } from '../domain/staff/ledger';
import { STAFF_SLUG } from '../domain/staff/parse';
import { staffProductPath } from '../domain/staff/writeLimits';
import { STAFF_TEMPLATE_LABELS } from '../domain/staff/doctrine';
import { mcpToolName } from '../mcp/tools';
import type { LogisticsHost } from '../staff/logisticsHost';
import type { StaffTeamInfo } from '../staff/staffHost';
import { declareManifest, fromArgument, INTERACTIVE_AND_UNATTENDED } from './tools';
import { fenceReadResults, fenceStaffText } from './staffFence';
import type { AgentTool, ToolContext } from './tools';
import { resolveInWorkspace, ToolError } from './workspace';
import { readWhole, snapshotOfBytes, writeIfUnchanged } from '../staff/staffFiles';
import * as path from 'node:path';

/** The server name a team file grants (`mcp:logistics`, or a family such as `mcp__logistics__calc*`). */
export const LOGISTICS_SERVER = 'logistics';

export function logisticsToolName(tool: string): string {
  return mcpToolName(LOGISTICS_SERVER, tool);
}

export interface LogisticsToolAccess {
  /** The host for the project, or undefined when the extension has not set one up (the tools then say so). */
  host(): LogisticsHost | undefined;
  readonly team: StaffTeamInfo;
  readonly run: string;
}

const CALC_WRITES = ['.planning/staff/calculator/**', '.planning/staff/ledger/calculator.jsonl'];
const CALC_READS = ['.planning/staff/calculator/**', '.planning/staff/ledger/calculator.jsonl'];
const LOGSTAT_READS = ['.planning/staff/logistics/logstat/**'];
const readEffect = (...paths: Array<string | ReturnType<typeof fromArgument>>) => ({ verb: 'read', paths });
const writeEffect = (...paths: string[]) => ({ verb: 'workspaceWrite', paths });
const manifest = (tool: string, effects: readonly unknown[]) => declareManifest({ tool: logisticsToolName(tool), effects, contexts: INTERACTIVE_AND_UNATTENDED });

const ID = { type: 'string', description: 'The record id products cite as calc:<id>: lower case letters, digits and dashes, at most 64 characters, such as fuel-phase-1.' };
const TITLE = { type: 'string', description: 'One line saying what is computed, such as "Class III (bulk) for phase 1".' };
const LABEL = { type: 'string', enum: [...STAFF_TEMPLATE_LABELS], description: 'The record\'s label. Default org/Internal. Exercise and fictional data only.' };

function asObject(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ToolError('Arguments must be a JSON object.');
  return raw;
}

function unwrap<T>(result: CalcResult<T>): T {
  if (!result.ok) throw new ToolError(result.message);
  return result.value;
}

function optionalId(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !STAFF_SLUG.test(value.trim())) throw new ToolError(`${key} is an id: lower case letters, digits and dashes.`);
  return value.trim();
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Builds the logistics tools for one run of one staff team. A record names the member whose call made it; the run's lead is not a member and only reads. */
export function logisticsTools(access: LogisticsToolAccess): AgentTool<any>[] {
  const hostOf = (): LogisticsHost => {
    const host = access.host();
    if (!host) throw new ToolError('The logistics server is not ready in this window. Reload the window and try again.');
    return host;
  };
  const memberOf = (context: ToolContext): string => {
    const member = context.agentLabel;
    if (member === undefined || !access.team.members.includes(member)) throw new ToolError('Only a member of this staff team can record logistics data. The run\'s lead coordinates; a member computes, enters and checks.');
    if (RESERVED_MEMBER_SLUGS.includes(member)) throw new ToolError(`${member} is a reserved name and cannot record logistics data.`);
    return member;
  };
  const verifiedOfKind = async <K extends CalcRecord['kind']>(kind: K): Promise<Array<Extract<CalcRecord, { kind: K }>>> => {
    const { records } = await hostOf().records();
    return [...records.values()].filter((record): record is Extract<CalcRecord, { kind: K }> => record.kind === kind);
  };

  // ---- The calculator --------------------------------------------------------------------------------------------------------------------------

  const calcRun: AgentTool<Record<string, unknown>> = {
    name: logisticsToolName('calc_run'),
    description: `[logistics] The consumption calculator. Give the force list as lines of { factor, count, item }: factor names a planning factor a person entered in ${FACTORS_FILE} (calc_factors lists them), count is from the force list, item says what was counted. Requirement = sum of (rate x count) per day x days; with onHand it also gives days of supply = on hand / daily requirement. You never give a rate: the calculator ships no factor tables and takes rates only from the person's file. The result shows the formula and is kept as a calculator record, entered in the calculator ledger; cite it as calc:<id> on the same line as each number it produced.`,
    parameters: {
      type: 'object',
      properties: {
        id: ID, title: TITLE,
        lines: { type: 'array', items: { type: 'object', properties: { factor: { type: 'string' }, count: { type: 'integer', minimum: 0 }, item: { type: 'string' } }, required: ['factor', 'count'], additionalProperties: false } },
        days: { type: 'number', description: 'The number of days the requirement covers.' },
        onHand: { type: 'number', description: 'What is on hand now, in the factors\' unit, for days of supply.' },
        label: LABEL
      },
      required: ['id', 'title', 'lines', 'days'],
      additionalProperties: false
    },
    capability: 'workspaceWrite',
    manifest: manifest('calc_run', [readEffect(FACTORS_FILE, ...CALC_READS), writeEffect(...CALC_WRITES)]),
    parse: asObject,
    title: (input) => `Calculate ${typeof input.id === 'string' ? input.id : 'a requirement'}`,
    async run(input, context) {
      const member = memberOf(context);
      const host = hostOf();
      const factors = await host.factors();
      if (!factors.ok) throw new ToolError(factors.missing ? `${factors.message} Ask the person to write it, for example:\n${FACTORS_EXAMPLE}` : factors.message);
      const written = unwrap(await host.writeRecord(member, access.run, (stamp) => computeConsumption(input as never, factors.factors, stamp)));
      return recordResultText(written.record, written.hash);
    }
  };

  const calcRead: AgentTool<{ id: string }> = {
    name: logisticsToolName('calc_read'),
    description: '[logistics] One calculator record with its formula and inputs, if the calculator ledger vouches for it. A file in the calculator folder the ledger does not vouch for is named as such: it cannot stand behind a number.',
    parameters: { type: 'object', properties: { id: ID }, required: ['id'], additionalProperties: false },
    capability: 'read',
    manifest: manifest('calc_read', [readEffect(...CALC_READS)]),
    concurrent: true,
    parse: (raw) => {
      const id = optionalId(asObject(raw), 'id');
      if (!id) throw new ToolError('id is the calculator record id.');
      return { id };
    },
    title: (input) => `Read calc:${input.id}`,
    async run(input) {
      const check = await hostOf().records();
      const record = check.records.get(input.id);
      if (record) return describeRecord(record);
      const problem = check.problems.get(input.id);
      if (problem) return `${problem}${check.ledgerProblem ? `\n${check.ledgerProblem}` : ''}`;
      return `calc:${input.id} names no calculator record in this project.`;
    }
  };

  const calcList: AgentTool<Record<string, never>> = {
    name: logisticsToolName('calc_list'),
    description: '[logistics] Every calculator record the calculator ledger vouches for (id, kind, what it computed, who and when), and every file in the calculator folder it does not.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    capability: 'read',
    manifest: manifest('calc_list', [readEffect(...CALC_READS)]),
    concurrent: true,
    parse: () => ({}),
    title: () => 'List calculator records',
    async run() {
      const check = await hostOf().records();
      const records = [...check.records.values()].sort((a, b) => a.at.localeCompare(b.at));
      const lines = [records.length ? `${plural(records.length, 'calculator record')}:` : 'No calculator record yet.'];
      for (const record of records) lines.push(`- calc:${record.id} (${record.kind}) ${record.title}; by ${record.computedBy} at ${record.at}`);
      if (check.problems.size) lines.push('', 'Files the calculator ledger does not vouch for (guard-scan holds any product that cites them):', ...[...check.problems.values()].map((problem) => `- ${problem}`));
      if (check.ledgerProblem) lines.push('', check.ledgerProblem);
      return lines.join('\n');
    }
  };

  const calcFactors: AgentTool<Record<string, never>> = {
    name: logisticsToolName('calc_factors'),
    description: `[logistics] The planning factors a person entered in ${FACTORS_FILE}: id, what it is for, the rate, its unit and what it is per, and who entered it. The calculator uses only these; when one you need is missing, ask the person to add it.`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    capability: 'read',
    manifest: manifest('calc_factors', [readEffect(FACTORS_FILE)]),
    concurrent: true,
    parse: () => ({}),
    title: () => 'Planning factors',
    async run() {
      const factors = await hostOf().factors();
      if (!factors.ok) return factors.missing ? `${factors.message} A person writes it, for example:\n${FACTORS_EXAMPLE}` : factors.message;
      if (!factors.factors.length) return `${FACTORS_FILE} has no factors yet. A person adds them; the calculator ships none.`;
      return [`${plural(factors.factors.length, 'planning factor')} entered by a person:`, ...factors.factors.map((factor) => `- ${factor.id}: ${factor.what}: ${formatNumber(factor.rate)} ${factor.unit} per ${factor.per} (entered by ${factor.enteredBy})${factor.note ? `; ${factor.note}` : ''}`)].join('\n');
    }
  };

  // ---- LOGSTAT ---------------------------------------------------------------------------------------------------------------------------------

  const logstatSubmit: AgentTool<{ report: unknown }> = {
    name: logisticsToolName('logstat_submit'),
    description: '[logistics] Enter one unit\'s LOGSTAT as received: { id, unit, reportedAt, lines: [{ commodity, uom, onHand, received, consumed, capacity, forecast, required?, daysOfSupply?, calc?, carriedFor? }] }. Enter the numbers exactly as the unit sent them, never corrected: the logstat-analyst validates the report and sends findings back. Stock carried for another unit goes on its own line with carriedFor. A report is never changed; a corrected one comes in under a new id.',
    parameters: { type: 'object', properties: { report: { type: 'object' } }, required: ['report'], additionalProperties: false },
    capability: 'workspaceWrite',
    manifest: manifest('logstat_submit', [readEffect(...LOGSTAT_READS), writeEffect('.planning/staff/logistics/logstat/reports/**')]),
    parse: (raw) => {
      const value = asObject(raw).report;
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ToolError('report is the LOGSTAT object.');
      return { report: value };
    },
    title: () => 'Enter a LOGSTAT',
    async run(input, context) {
      const member = memberOf(context);
      const report = unwrap(await hostOf().submitReport(member, input.report));
      return `Entered LOGSTAT ${report.id} from ${report.unit} (${report.lines.length} ${report.lines.length === 1 ? 'commodity' : 'commodities'}, reported ${report.reportedAt}). The logstat-analyst validates it before it is consolidated.`;
    }
  };

  const logstatRead: AgentTool<{ report?: string }> = {
    name: logisticsToolName('logstat_read'),
    description: '[logistics] The LOGSTATs entered, each with its latest validation; or one report in full (report: its id) with the rules checked now.',
    parameters: { type: 'object', properties: { report: { type: 'string' } }, additionalProperties: false },
    capability: 'read',
    manifest: manifest('logstat_read', [readEffect(...LOGSTAT_READS, ...CALC_READS)]),
    concurrent: true,
    parse: (raw) => { const report = optionalId(asObject(raw), 'report'); return report ? { report } : {}; },
    title: (input) => (input.report ? `LOGSTAT ${input.report}` : 'LOGSTATs'),
    async run(input) {
      const host = hostOf();
      const reports = await host.reports();
      if (input.report) {
        const report = reports.find((entry) => entry.id === input.report);
        if (!report) return `No LOGSTAT ${input.report} has been entered.`;
        const check = validateLogstat(report, reports, (await host.records()).records);
        return [JSON.stringify(report, null, 2), '', check.passed ? 'Passes every plausibility rule now.' : 'Fails now:', ...check.findings.map((finding) => `- rule ${finding.rule} (${finding.commodity}): ${finding.message}`)].join('\n');
      }
      if (!reports.length) return 'No LOGSTAT has been entered yet.';
      const log = await host.validationLog();
      const latest = new Map(log.map((entry) => [entry.report, entry] as const));
      return [`${plural(reports.length, 'LOGSTAT')}:`, ...[...reports].sort((a, b) => a.reportedAt.localeCompare(b.reportedAt)).map((report) => {
        const entry = latest.get(report.id);
        const status = !entry ? 'not validated yet' : entry.hash !== recordHash(JSON.stringify(report)) ? 'changed since it was validated' : entry.passed ? `passed (${entry.at})` : `findings open (rules ${[...new Set(entry.findings.map((finding) => finding.rule))].join(', ')})`;
        return `- ${report.id}: ${report.unit}, reported ${report.reportedAt}: ${status}`;
      })].join('\n');
    }
  };

  const logstatValidate: AgentTool<{ report?: string }> = {
    name: logisticsToolName('logstat_validate'),
    description: `[logistics] Validate a LOGSTAT (report: its id) or every one not yet validated, against the plausibility rules of the logstat-definitions skill: ${Object.entries(LOGSTAT_RULES).slice(0, 5).map(([rule, text]) => `${rule}. ${text}`).join(' ')} Each finding goes back to the sending unit with its rule; nothing is corrected. The tool writes the validation log (${LOGSTAT_VALIDATION_FILE}) and the LOGSTAT validation log product body, which you then propose.`,
    parameters: { type: 'object', properties: { report: { type: 'string' } }, additionalProperties: false },
    capability: 'workspaceWrite',
    manifest: manifest('logstat_validate', [readEffect(...LOGSTAT_READS, ...CALC_READS), writeEffect(LOGSTAT_VALIDATION_FILE, staffProductPath('j4', LOGSTAT_VALIDATION_PRODUCT))]),
    parse: (raw) => { const report = optionalId(asObject(raw), 'report'); return report ? { report } : {}; },
    title: (input) => (input.report ? `Validate LOGSTAT ${input.report}` : 'Validate LOGSTATs'),
    async run(input, context) {
      const member = memberOf(context);
      const host = hostOf();
      const reports = await host.reports();
      const log = await host.validationLog();
      const checked = new Set(log.map((entry) => `${entry.report}\u0000${entry.hash}`));
      const targets = input.report
        ? reports.filter((report) => report.id === input.report)
        : reports.filter((report) => !checked.has(`${report.id}\u0000${recordHash(JSON.stringify(report))}`));
      if (input.report && !targets.length) throw new ToolError(`No LOGSTAT ${input.report} has been entered.`);
      if (!targets.length) return 'Every LOGSTAT entered has been validated as it stands.';
      const { records } = await host.records();
      const at = new Date(host.clock()).toISOString();
      const entries: ValidationLogEntry[] = targets.map((report) => ({ ...validateLogstat(report, reports, records), hash: recordHash(JSON.stringify(report)), at, by: member }));
      await host.appendValidation(entries);
      let product = '';
      if (access.team.section === 'j4') product = await writeValidationProduct(context, validationLogMarkdown([...log, ...entries]));
      // The unit and commodity names and the findings quote what a unit wrote: they go back fenced, as every read tool's answer does (staffFence.ts).
      const lines: string[] = [];
      for (const entry of entries) {
        if (entry.passed) { lines.push(`${entry.report} (${entry.unit}): passes every rule${entry.against ? `, balanced against ${entry.against}` : ', with no earlier report to balance against'}.`); continue; }
        lines.push(`${entry.report} (${entry.unit}): ${plural(entry.findings.length, 'finding')}, sent back to ${entry.unit}; it stays out of the consolidation until a report that passes comes in.`);
        for (const finding of entry.findings) lines.push(`- rule ${finding.rule} (${finding.commodity}): ${finding.message}`);
      }
      const passed = entries.filter((entry) => entry.passed).length;
      const head = `Validated ${plural(entries.length, 'LOGSTAT')}: ${passed} passed, ${entries.length - passed} with findings.`;
      return [head, fenceStaffText(logisticsToolName('logstat_validate'), lines.join('\n')), ...(product ? ['', `The validation log product is at ${product}; propose it with the staff-products tool.`] : [])].join('\n');
    }
  };

  const logstatConsolidate: AgentTool<Record<string, never>> = {
    name: logisticsToolName('logstat_consolidate'),
    description: '[logistics] The consolidated LOGSTAT: each unit\'s latest report that passes every plausibility rule (checked again now), with its band and the numbers behind it, consumption against the calculator\'s forecast, and the units held out with their rules. Returns the table for the consolidated LOGSTAT product; it writes nothing.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    capability: 'read',
    manifest: manifest('logstat_consolidate', [readEffect(...LOGSTAT_READS, ...CALC_READS, '.planning/staff/skills/logstat-definitions.md')]),
    concurrent: true,
    parse: () => ({}),
    title: () => 'Consolidate LOGSTATs',
    async run() {
      const host = hostOf();
      const reports = await host.reports();
      if (!reports.length) return 'No LOGSTAT has been entered yet.';
      const { records } = await host.records();
      const bands = parseBandSettings((await host.definitionsText()) ?? '');
      return consolidationMarkdown(consolidateLogstat(reports, records, bands));
    }
  };

  // ---- Movement --------------------------------------------------------------------------------------------------------------------------------

  const movementTable: AgentTool<Record<string, unknown>> = {
    name: logisticsToolName('movement_table'),
    description: '[logistics] Check a notional movement table and keep it as a calculator record: serials of { serial, what, mode (road, rail, sea, air, inland waterway), from, to, load, loadUnit, lift: { asset, count, capacityEach }, distanceKm, speedKmh, handlingHours?, ready, required (the required delivery date) }. For each serial: lift against the load, and arrival = ready + handling + distance / speed against the required date, with the formula shown. Notional tables only: never a real deployment database. A revised table gets a new id and names the one it supersedes.',
    parameters: {
      type: 'object',
      properties: { id: ID, title: TITLE, serials: { type: 'array', items: { type: 'object' } }, supersedes: { type: 'string' }, label: LABEL },
      required: ['id', 'title', 'serials'],
      additionalProperties: false
    },
    capability: 'workspaceWrite',
    manifest: manifest('movement_table', [readEffect(...CALC_READS), writeEffect(...CALC_WRITES)]),
    parse: asObject,
    title: (input) => `Movement table ${typeof input.id === 'string' ? input.id : ''}`.trim(),
    async run(input, context) {
      const member = memberOf(context);
      const written = unwrap(await hostOf().writeRecord(member, access.run, (stamp) => checkMovementTable(input as never, stamp)));
      const table = written.record as MovementRecord;
      const short = table.serials.filter((serial) => !serial.liftFeasible || !serial.timeFeasible);
      return [recordResultText(table, written.hash), '', short.length ? `Not feasible: ${short.map((serial) => serial.serial).join(', ')}.` : 'Every serial is feasible on these notional figures.'].join('\n');
    }
  };

  const movementRead: AgentTool<Record<string, never>> = {
    name: logisticsToolName('movement_read'),
    description: '[logistics] The movement board: every serial of the newest notional movement tables, with lift, arrival against the required delivery date, and the calculator record behind it.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    capability: 'read',
    manifest: manifest('movement_read', [readEffect(...CALC_READS)]),
    concurrent: true,
    parse: () => ({}),
    title: () => 'Movement board',
    async run() {
      return movementBoardMarkdown(movementBoard(await verifiedOfKind('movement')));
    }
  };

  const movementRoute: AgentTool<{ from: string; to: string; avoid: string[] }> = {
    name: logisticsToolName('movement_route'),
    description: `[logistics] The shortest open road route between two nodes of the project's road graph (${ROADS_FILE}), avoiding any nodes you name, with each leg and the total distance. It runs on that file only; no route request leaves the machine.`,
    parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, avoid: { type: 'array', items: { type: 'string' } } }, required: ['from', 'to'], additionalProperties: false },
    capability: 'read',
    manifest: manifest('movement_route', [readEffect(ROADS_FILE)]),
    concurrent: true,
    parse: (raw) => {
      const value = asObject(raw);
      const from = optionalId(value, 'from');
      const to = optionalId(value, 'to');
      if (!from || !to) throw new ToolError('from and to are node ids in the road graph.');
      const avoid = value.avoid === undefined ? [] : value.avoid;
      if (!Array.isArray(avoid) || avoid.length > 100 || !avoid.every((item) => typeof item === 'string')) throw new ToolError('avoid is a list of node ids.');
      return { from, to, avoid: avoid as string[] };
    },
    title: (input) => `Route ${input.from} to ${input.to}`,
    async run(input) {
      const graph = unwrap(await hostOf().roads());
      const route = unwrap(shortestRoute(graph, input.from, input.to, input.avoid));
      return [
        `Route ${input.from} to ${input.to}: ${formatNumber(route.km)} km over ${plural(route.legs.length, 'leg')}${input.avoid.length ? `, avoiding ${input.avoid.join(', ')}` : ''}.`,
        ...route.legs.map((leg) => `- ${leg.from} to ${leg.to}: ${formatNumber(leg.km)} km${leg.name ? ` (${leg.name})` : ''}`),
        `distance = ${route.legs.map((leg) => formatNumber(leg.km)).join(' + ')} = ${formatNumber(route.km)} km, from ${ROADS_FILE}. Put it in the movement table's distanceKm, which keeps the working.`
      ].join('\n');
    }
  };

  // ---- Readiness -------------------------------------------------------------------------------------------------------------------------------

  const readinessImport: AgentTool<Record<string, unknown>> = {
    name: logisticsToolName('readiness_import'),
    description: '[logistics] Import readiness data from a CSV a person put in the project (path), with a header row naming unit, equipment, on_hand, ready and as_of. The import is kept as a calculator record with the file\'s name and hash, and readiness per equipment type = ready / on hand. A row with more ready than on hand refuses the whole import with the row named: ask the person who keeps the data to correct it.',
    parameters: { type: 'object', properties: { id: ID, title: TITLE, path: { type: 'string', description: 'The CSV file in the project.' }, label: LABEL }, required: ['id', 'title', 'path'], additionalProperties: false },
    capability: 'workspaceWrite',
    manifest: manifest('readiness_import', [readEffect(fromArgument('path'), ...CALC_READS), writeEffect(...CALC_WRITES)]),
    parse: (raw) => {
      const value = asObject(raw);
      if (typeof value.path !== 'string' || !value.path.trim()) throw new ToolError('path is the CSV file in the project.');
      return value;
    },
    title: (input) => `Import readiness from ${String(input.path)}`,
    async run(input, context) {
      const member = memberOf(context);
      const absolute = await resolveInWorkspace(context.root, input.path as string);
      const text = await readFile(absolute, 'utf8').catch(() => { throw new ToolError(`${String(input.path)} could not be read.`); });
      if (text.length > MAX_READINESS_BYTES) throw new ToolError(`${String(input.path)} is larger than 1 MB.`);
      const source = { file: path.relative(context.root, absolute).split(path.sep).join('/'), sha256: recordHash(text) };
      const written = unwrap(await hostOf().writeRecord(member, access.run, (stamp) => importReadiness(input as never, text, source, stamp)));
      const record = written.record as ReadinessRecord;
      return [recordResultText(record, written.hash), '', `${plural(record.lines.length, 'line')} imported from ${source.file}.`].join('\n');
    }
  };

  const readinessRead: AgentTool<{ staleHours?: number }> = {
    name: logisticsToolName('readiness_read'),
    description: '[logistics] The readiness board from the newest import: readiness per unit and equipment type, each figure with its time and marked stale when older than the reporting period (staleHours, default 24), and the calculator record to cite.',
    parameters: { type: 'object', properties: { staleHours: { type: 'number', minimum: 1, maximum: 8760 } }, additionalProperties: false },
    capability: 'read',
    manifest: manifest('readiness_read', [readEffect(...CALC_READS)]),
    concurrent: true,
    parse: (raw) => {
      const value = asObject(raw).staleHours;
      if (value === undefined) return {};
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 8760) throw new ToolError('staleHours is the reporting period in hours, 1 to 8760.');
      return { staleHours: value };
    },
    title: () => 'Readiness board',
    async run(input) {
      return readinessBoardMarkdown(await verifiedOfKind('readiness'), hostOf().clock(), input.staleHours);
    }
  };

  // Every read tool's answer is fenced whole (staffFence.ts): LOGSTATs, factors, records and readiness rows are text units, people and members wrote.
  return fenceReadResults([calcRun, calcRead, calcList, calcFactors, logstatSubmit, logstatRead, logstatValidate, logstatConsolidate, movementTable, movementRead, movementRoute, readinessImport, readinessRead]);
}

/** Writes the validation log product's body, keeping its staff header when it has one, so the analyst (who has no file tools) can propose it. */
async function writeValidationProduct(context: ToolContext, body: string): Promise<string> {
  const relative = staffProductPath('j4', LOGSTAT_VALIDATION_PRODUCT);
  const absolute = await resolveInWorkspace(context.root, relative);
  // Read whole with the shared reader and written only over the bytes read (staffFiles.ts): a member's write that lands in between stands.
  const read = await readWhole(absolute);
  if (read.kind === 'unreadable') throw new ToolError(`${relative} was not read: ${read.reason}. Nothing was written.`);
  const header = read.kind === 'text' ? (/^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(read.text)?.[0] ?? '') : '';
  await context.checkpoints.capture(absolute);
  if (!(await writeIfUnchanged(absolute, snapshotOfBytes(read.kind === 'text' ? read.bytes : undefined), `${header}${body}`))) {
    throw new ToolError(`${relative} changed while the validation log was being written, so it was not replaced. Run logstat_validate again.`);
  }
  return relative;
}

/** The logistics tool names, in order, for the Tools page and the tests. */
export const LOGISTICS_TOOL_NAMES: readonly string[] = logisticsTools({ host: () => undefined, team: { slug: 'directory', section: 'j4', members: [], sectionLead: '' }, run: 'directory' }).map((tool) => tool.name);
