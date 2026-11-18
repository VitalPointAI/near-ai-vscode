// The intel-workbench (design 10, 6.2; WP-INT): the J2 team's local tools for the source register, the PIR register, the collection plan, INTSUM and
// INTREP drafting and the compilation-risk check. Every rule lives in src/domain/staff/intel.ts; this file only reads and writes the register files.
//
// It is a built-in local server, not a process: the tools run inside the extension, are named `mcp__intel-workbench__<tool>` so a staff team member's
// `mcp:intel-workbench` grant reaches them exactly as it would a connected server's, and each declares its manifest next to it (Phase 70 gate). Every
// manifest names only the project files the tool reads or writes, so the gate's label check sees each file the call touches. No tool declares a network,
// MCP, shell, send or publish effect: nothing here leaves the machine. No tool approves, rejects or releases anything: a PIR is approved only by a named
// person through `decidePir`, which no tool calls.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  buildCollectionEntry, buildPirEntry, buildSourceEntry, changePir, claimsOf, compilationItems, compilationRisk, COMPILATION_NONE_TEXT, corroboration,
  DEFAULT_INTEL_LABEL, draftIntrep, draftIntsum, formatDtg, gradeText, INTEL_RULES, isTemplateLabel, parseRegisterText, readTime, registerFindings,
  registerPath, renderCollectionPlan, renderPirRegister, renderRegister
} from '../domain/staff/intel';
import type { IntelFinding, IntelRegisterName, IntelRegisters, IntelResult, PirEntry, RegisterTypes, SourceEntry } from '../domain/staff/intel';
import { STAFF_TEMPLATE_LABELS } from '../domain/staff/doctrine';
import { defaultStaffSettings, parseStaffSettings } from '../domain/staff/profiles';
import type { StaffSettings } from '../domain/staff/profiles';
import { mcpToolName } from '../mcp/tools';
import { declareManifest, INTERACTIVE_AND_UNATTENDED, protectedWrite } from './tools';
import type { AgentTool, ToolContext } from './tools';
import { displayPath, resolveInWorkspace, ToolError } from './workspace';

/** The server name a team file grants (`mcp:intel-workbench`). */
export const INTEL_WORKBENCH_SERVER = 'intel-workbench';
/** The project settings file whose `staff` object gives the profile and level a draft is written under. */
export const STAFF_SETTINGS_PATH = '.planning/.near-ai/project.json';

const SOURCES = registerPath('source-register');
const PIRS = registerPath('pir-register');
const PLAN = registerPath('collection-plan');

export function intelToolName(tool: string): string {
  return mcpToolName(INTEL_WORKBENCH_SERVER, tool);
}

/** One writer at a time per register file inside this extension host, so two members' calls in one run never lose each other's entry. */
const fileLocks = new Map<string, Promise<unknown>>();
async function withFileLock<T>(absolute: string, work: () => Promise<T>): Promise<T> {
  const before = fileLocks.get(absolute) ?? Promise.resolve();
  const run = before.then(work, work);
  const settled = run.then(() => undefined, () => undefined);
  fileLocks.set(absolute, settled);
  try {
    return await run;
  } finally {
    if (fileLocks.get(absolute) === settled) fileLocks.delete(absolute);
  }
}

async function readText(absolute: string): Promise<string | undefined> {
  try {
    return await readFile(absolute, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function unwrap<T>(result: IntelResult<T>): T {
  if (!result.ok) throw new ToolError(result.message);
  return result.value;
}

async function loadRegister<N extends IntelRegisterName>(context: ToolContext, name: N): Promise<RegisterTypes[N][]> {
  const absolute = await resolveInWorkspace(context.root, registerPath(name));
  return unwrap(parseRegisterText(name, await readText(absolute)));
}

async function loadAll(context: ToolContext): Promise<IntelRegisters> {
  const [sources, pirs, plan] = await Promise.all([loadRegister(context, 'source-register'), loadRegister(context, 'pir-register'), loadRegister(context, 'collection-plan')]);
  return { sources, pirs, plan };
}

/** Reads, changes and writes one register under its lock, through a temporary file and a rename, with a checkpoint so the run can be undone. */
async function updateRegister<N extends IntelRegisterName, R>(context: ToolContext, name: N, change: (entries: RegisterTypes[N][]) => Promise<{ entries: RegisterTypes[N][]; result: R }>): Promise<R> {
  const absolute = await resolveInWorkspace(context.root, registerPath(name));
  return withFileLock(absolute, async () => {
    const entries = unwrap(parseRegisterText(name, await readText(absolute)));
    const next = await change(entries);
    await context.checkpoints.capture(absolute);
    await mkdir(path.dirname(absolute), { recursive: true });
    const temporary = `${absolute}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, renderRegister(name, next.entries), 'utf8');
    await rename(temporary, absolute);
    return next.result;
  });
}

async function staffSettings(context: ToolContext): Promise<StaffSettings> {
  const absolute = await resolveInWorkspace(context.root, STAFF_SETTINGS_PATH);
  const text = await readText(absolute);
  if (text === undefined) return defaultStaffSettings();
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ToolError(`${STAFF_SETTINGS_PATH} is not valid JSON, so the profile and level cannot be read.`); }
  const staff = value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'staff') ? (value as Record<string, unknown>).staff : undefined;
  if (staff === undefined) return defaultStaffSettings();
  const parsed = parseStaffSettings(staff);
  if (!parsed.ok) throw new ToolError(`The staff settings in ${STAFF_SETTINGS_PATH} are not valid: ${parsed.message}`);
  return parsed.value;
}

function who(context: ToolContext): string {
  return (context.agentLabel ?? 'lead').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 80) || 'lead';
}

function findingLines(findings: readonly IntelFinding[]): string[] {
  return findings.map((finding) => `- [${finding.severity}] ${finding.rule} (${finding.subject}): ${finding.message}`);
}

function sourceSummary(entry: SourceEntry): string {
  return `${entry.id} ${gradeText(entry)} ${entry.discipline} | ${entry.title} | source: ${entry.source} | origin: ${entry.origin} | reported ${formatDtg(Date.parse(entry.reportedAt))} | claims: ${entry.claims.join(', ') || 'none'} | deception: ${entry.deceptionNote} | ${entry.label}`;
}

const readEffect = (...paths: string[]) => ({ verb: 'read', paths });
const writeEffect = (...paths: string[]) => ({ verb: 'workspaceWrite', paths });
const stringArray = { type: 'array', items: { type: 'string' } } as const;
const LABEL_PARAMETER = { type: 'string', description: `The label of the entry: ${STAFF_TEMPLATE_LABELS.join(', ')}. Default ${DEFAULT_INTEL_LABEL}. Exercise and fictional data only.` };

/** The arguments as given, after checking they are an object: every rule is checked by the domain functions, which name the rule they refuse under. */
function asObject(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ToolError('Arguments must be a JSON object.');
  return raw;
}

export interface IntelWorkbenchOptions {
  /** The clock, for latest-time-of-value checks and drafts. Tests pass a fixed one. */
  readonly now?: () => number;
}

/** The workbench's tools, in the order the J2 works: sources, PIRs, collection, reports, checks. */
export function intelWorkbenchTools(options: IntelWorkbenchOptions = {}): AgentTool<any>[] {
  const now = options.now ?? (() => Date.now());

  const sourceAdd: AgentTool<Record<string, unknown>> = {
    name: intelToolName('source_add'),
    description: 'Add one item to the J2 source register (products/j2/source-register.json). Grade the source\'s reliability (A to F) and the information\'s credibility (1 to 6) separately, as two fields: never one combined grade such as "B2". Record the origin, where the information first came from, separately from the source that gave it to you: two items with one origin are one piece of evidence and never corroborate each other. Credibility 1 means confirmed by another item from a different origin. List the claims the item reports on as short slugs so reports on one claim can be compared. Exercise and fictional data only.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'One line: what the item says.' },
        source: { type: 'string', description: 'Who gave it to you: an outlet, a sensor, a report series. Reliability grades this.' },
        origin: { type: 'string', description: 'Where the information first came from (the agency or witness behind the outlet). Not the outlet, unless it is the origin.' },
        discipline: { type: 'string', enum: ['OSINT', 'GEOINT', 'HUMINT', 'SIGINT', 'MASINT', 'TECHINT', 'CI'] },
        url: { type: 'string' },
        reportedAt: { type: 'string', description: 'When the source reported it: ISO time in UTC, a date, or a DTG such as 181402Z NOV 26.' },
        accessedAt: { type: 'string', description: 'When you took it in, in the same forms.' },
        reliability: { type: 'string', enum: ['A', 'B', 'C', 'D', 'E', 'F'], description: 'Of the source.' },
        credibility: { type: 'number', enum: [1, 2, 3, 4, 5, 6], description: 'Of the information, judged on its own.' },
        claims: { ...stringArray, description: 'Short slugs for the claims it reports, such as bridge-closed-ashby.' },
        deceptionNote: { type: 'string', description: 'What deception or bias could explain the item, or "none seen".' },
        label: LABEL_PARAMETER
      },
      required: ['title', 'source', 'origin', 'discipline', 'reportedAt', 'accessedAt', 'reliability', 'credibility', 'deceptionNote'],
      additionalProperties: false
    },
    capability: 'workspaceWrite',
    manifest: declareManifest({ tool: intelToolName('source_add'), effects: [readEffect(SOURCES), writeEffect(SOURCES)], contexts: INTERACTIVE_AND_UNATTENDED }),
    parse: asObject,
    title: (input) => `Source register: add ${typeof input.title === 'string' ? input.title.slice(0, 60) : 'an item'}`,
    sensitive: (_input, context) => protectedWrite(SOURCES, context),
    async run(input, context) {
      const added = await updateRegister(context, 'source-register', async (entries) => {
        const entry = unwrap(buildSourceEntry(input as never, entries, who(context)));
        return { entries: [...entries, entry], result: { entry, entries: [...entries, entry] } };
      });
      const lines = [`Added ${added.entry.id} (${gradeText(added.entry)}) to ${SOURCES}.`];
      for (const claim of added.entry.claims) {
        const found = corroboration(added.entries, claim);
        lines.push(`- ${claim}: ${found.reports.length} report${found.reports.length === 1 ? '' : 's'} from ${found.independent} independent origin${found.independent === 1 ? '' : 's'}${found.corroborated ? ' (corroborated)' : ' (not corroborated)'}.`);
      }
      const confirm = registerFindings({ sources: added.entries, pirs: [], plan: [] }, now()).filter((finding) => finding.subject === added.entry.id || added.entry.claims.includes(finding.subject));
      return [...lines, ...findingLines(confirm)].join('\n');
    }
  };

  const sourceList: AgentTool<Record<string, unknown>> = {
    name: intelToolName('source_list'),
    description: 'List the J2 source register, or the items on one claim. Each item shows its two grades, discipline, source, origin and deception note.',
    parameters: { type: 'object', properties: { claim: { type: 'string', description: 'Only items that report this claim.' } }, additionalProperties: false },
    capability: 'read',
    manifest: declareManifest({ tool: intelToolName('source_list'), effects: [readEffect(SOURCES)], contexts: INTERACTIVE_AND_UNATTENDED }),
    parse: asObject,
    title: () => 'Source register',
    async run(input, context) {
      const sources = await loadRegister(context, 'source-register');
      const claim = typeof input.claim === 'string' && input.claim.trim() ? input.claim.trim() : undefined;
      const shown = claim ? sources.filter((entry) => entry.claims.includes(claim)) : sources;
      if (!shown.length) return claim ? `No item reports "${claim}".` : 'The source register is empty.';
      return [`${shown.length} item${shown.length === 1 ? '' : 's'}:`, ...shown.map(sourceSummary)].join('\n');
    }
  };

  const independence: AgentTool<Record<string, unknown>> = {
    name: intelToolName('independence_check'),
    description: 'How many independent origins stand behind a claim, or behind every claim in the source register. Reports that share an origin count once: two reports from one origin are not corroboration.',
    parameters: { type: 'object', properties: { claim: { type: 'string' } }, additionalProperties: false },
    capability: 'read',
    manifest: declareManifest({ tool: intelToolName('independence_check'), effects: [readEffect(SOURCES)], contexts: INTERACTIVE_AND_UNATTENDED }),
    parse: asObject,
    title: (input) => `Independence: ${typeof input.claim === 'string' ? input.claim : 'every claim'}`,
    async run(input, context) {
      const sources = await loadRegister(context, 'source-register');
      const claims = typeof input.claim === 'string' && input.claim.trim() ? [input.claim.trim()] : claimsOf(sources);
      if (!claims.length) return 'The source register has no claims yet.';
      return claims.map((claim) => {
        const found = corroboration(sources, claim);
        if (!found.reports.length) return `- ${claim}: no reports.`;
        return `- ${claim}: ${found.reports.length} report${found.reports.length === 1 ? '' : 's'} (${found.reports.join(', ')}) from ${found.independent} independent origin${found.independent === 1 ? '' : 's'} (${found.origins.join('; ')}). ${found.corroborated ? 'Corroborated.' : 'Not corroborated.'}${found.repeated ? ' Some reports repeat one origin and count once.' : ''}`;
      }).join('\n');
    }
  };

  const pirAdd: AgentTool<Record<string, unknown>> = {
    name: intelToolName('pir_add'),
    description: 'Add a PIR candidate to the J2 PIR register (products/j2/pir-register.json). Every PIR names the decision point it supports and the latest time its answer is of value; break it into indicators. A new PIR is a candidate: you recommend it, and only a named person approves it.',
    parameters: {
      type: 'object',
      properties: {
        requirement: { type: 'string', description: 'The question, one line.' },
        decisionPoint: { type: 'string', description: 'The decision point it supports, as the DST names it, such as "DP 2: commit the reserve".' },
        ltiov: { type: 'string', description: 'Latest time of value: ISO time in UTC, a date, or a DTG.' },
        indicators: { ...stringArray, description: 'Observable indicators that would answer it.' },
        requestedBy: { type: 'string', description: 'The section or member that asked for it, such as j3 or red-team. Default j2.' },
        label: LABEL_PARAMETER
      },
      required: ['requirement', 'decisionPoint', 'ltiov'],
      additionalProperties: false
    },
    capability: 'workspaceWrite',
    manifest: declareManifest({ tool: intelToolName('pir_add'), effects: [readEffect(PIRS), writeEffect(PIRS)], contexts: INTERACTIVE_AND_UNATTENDED }),
    parse: asObject,
    title: (input) => `PIR register: add ${typeof input.requirement === 'string' ? input.requirement.slice(0, 60) : 'a PIR'}`,
    sensitive: (_input, context) => protectedWrite(PIRS, context),
    async run(input, context) {
      const entry = await updateRegister(context, 'pir-register', async (entries) => {
        const built = unwrap(buildPirEntry(input as never, entries, who(context)));
        return { entries: [...entries, built], result: built };
      });
      return `Added ${entry.id} as a candidate, supporting ${entry.decisionPoint}, latest time of value ${formatDtg(Date.parse(entry.ltiov))}, indicators ${entry.indicators.map((indicator) => indicator.id).join(', ') || 'none yet'}. Mark it DECISION FOR: commander when it goes for decision.`;
    }
  };

  const pirUpdate: AgentTool<Record<string, unknown>> = {
    name: intelToolName('pir_update'),
    description: 'Change one PIR: reword it, add indicators, or move its status (candidate, awaiting-decision, answered with the items that answered it, closed). You cannot approve or reject a PIR: a named person does that. A PIR the commander decided on keeps its wording; propose a change instead.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'PIR-n.' },
        status: { type: 'string', enum: ['candidate', 'awaiting-decision', 'answered', 'closed'] },
        requirement: { type: 'string' },
        decisionPoint: { type: 'string' },
        ltiov: { type: 'string' },
        addIndicators: stringArray,
        answeredBy: { ...stringArray, description: 'SRC-n items that answered it, when the status is answered.' }
      },
      required: ['id'],
      additionalProperties: false
    },
    capability: 'workspaceWrite',
    manifest: declareManifest({ tool: intelToolName('pir_update'), effects: [readEffect(PIRS, SOURCES), writeEffect(PIRS)], contexts: INTERACTIVE_AND_UNATTENDED }),
    parse: asObject,
    title: (input) => `PIR register: update ${typeof input.id === 'string' ? input.id : ''}`,
    sensitive: (_input, context) => protectedWrite(PIRS, context),
    async run(input, context) {
      const sources = await loadRegister(context, 'source-register');
      const entry = await updateRegister(context, 'pir-register', async (entries) => {
        const next = unwrap(changePir(entries, input, sources));
        return { entries: next, result: next.find((candidate) => candidate.id === input.id) as PirEntry };
      });
      return `${entry.id} is ${entry.status}; supports ${entry.decisionPoint}; latest time of value ${formatDtg(Date.parse(entry.ltiov))}; indicators ${entry.indicators.map((indicator) => `${indicator.id} ${indicator.text}`).join('; ') || 'none'}.`;
    }
  };

  const pirList: AgentTool<Record<string, unknown>> = {
    name: intelToolName('pir_list'),
    description: 'The J2 PIR register as a table (requirement, decision point supported, indicators, latest time of value, status), with its findings.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    capability: 'read',
    manifest: declareManifest({ tool: intelToolName('pir_list'), effects: [readEffect(PIRS, PLAN)], contexts: INTERACTIVE_AND_UNATTENDED }),
    parse: asObject,
    title: () => 'PIR register',
    async run(_input, context) {
      const [pirs, plan] = await Promise.all([loadRegister(context, 'pir-register'), loadRegister(context, 'collection-plan')]);
      if (!pirs.length) return 'The PIR register is empty.';
      const findings = registerFindings({ sources: [], pirs, plan }, now()).filter((finding) => finding.rule.startsWith('pir-') || finding.rule === 'ltiov-passed');
      return [renderPirRegister(pirs), ...(findings.length ? ['', 'Findings:', ...findingLines(findings)] : [])].join('\n');
    }
  };

  const collectionRecommend: AgentTool<Record<string, unknown>> = {
    name: intelToolName('collection_recommend'),
    description: 'Add a recommendation to the J2 collection plan (products/j2/collection-plan.json): which capability could answer one indicator of one PIR, at which NAI, and when. It is a recommendation only: the J3 approves the allocation of collection assets, and you never task an asset. HUMINT, SIGINT, MASINT and CI always need a partner. Collection must end by the PIR\'s latest time of value.',
    parameters: {
      type: 'object',
      properties: {
        pir: { type: 'string', description: 'PIR-n.' },
        indicator: { type: 'string', description: 'IND-n, one of that PIR\'s indicators.' },
        nai: { type: 'string', description: 'The named area of interest, such as "NAI 3".' },
        capability: { type: 'string', description: 'The capability you recommend, such as "UAS imagery sweep". Not an order.' },
        discipline: { type: 'string', enum: ['OSINT', 'GEOINT', 'HUMINT', 'SIGINT', 'MASINT', 'TECHINT', 'CI'] },
        from: { type: 'string', description: 'Start: ISO time in UTC, a date, or a DTG.' },
        to: { type: 'string', description: 'End, no later than the PIR\'s latest time of value.' },
        needs: { type: 'string', enum: ['j3-approval', 'partner'], description: 'Default j3-approval; partner for partner-only disciplines.' },
        note: { type: 'string' },
        label: LABEL_PARAMETER
      },
      required: ['pir', 'indicator', 'nai', 'capability', 'discipline', 'from', 'to'],
      additionalProperties: false
    },
    capability: 'workspaceWrite',
    manifest: declareManifest({ tool: intelToolName('collection_recommend'), effects: [readEffect(PLAN, PIRS), writeEffect(PLAN)], contexts: INTERACTIVE_AND_UNATTENDED }),
    parse: asObject,
    title: (input) => `Collection plan: recommend for ${typeof input.pir === 'string' ? input.pir : 'a PIR'}`,
    sensitive: (_input, context) => protectedWrite(PLAN, context),
    async run(input, context) {
      const pirs = await loadRegister(context, 'pir-register');
      const entry = await updateRegister(context, 'collection-plan', async (entries) => {
        const built = unwrap(buildCollectionEntry(input as never, entries, pirs, who(context)));
        return { entries: [...entries, built], result: built };
      });
      return `Recommended ${entry.id}: ${entry.capability} (${entry.discipline}) at ${entry.nai} for ${entry.indicator} of ${entry.pir}, ${formatDtg(Date.parse(entry.timing.from))} to ${formatDtg(Date.parse(entry.timing.to))}. ${entry.needs === 'partner' ? 'Needs a partner.' : 'Needs J3 approval of the asset allocation.'} The J2 recommends; the J3 tasks.`;
    }
  };

  const collectionPlan: AgentTool<Record<string, unknown>> = {
    name: intelToolName('collection_plan'),
    description: 'The J2 collection plan as the table the J3 reads (requirement, indicator, NAI, recommended capability, timing, needs J3 approval or partner), with its findings.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    capability: 'read',
    manifest: declareManifest({ tool: intelToolName('collection_plan'), effects: [readEffect(PLAN, PIRS)], contexts: INTERACTIVE_AND_UNATTENDED }),
    parse: asObject,
    title: () => 'Collection plan',
    async run(_input, context) {
      const [pirs, plan] = await Promise.all([loadRegister(context, 'pir-register'), loadRegister(context, 'collection-plan')]);
      if (!plan.length) return 'The collection plan is empty.';
      const findings = registerFindings({ sources: [], pirs, plan }, now()).filter((finding) => ['single-discipline', 'pir-not-approved', 'collection-after-ltiov', 'collection-orphan'].includes(finding.rule));
      return [renderCollectionPlan(plan, pirs), ...(findings.length ? ['', 'Findings:', ...findingLines(findings)] : [])].join('\n');
    }
  };

  const draftParameters = (extra: Record<string, unknown>, required: string[]) => ({ type: 'object', properties: { ...extra, label: { ...LABEL_PARAMETER, description: `The label of the report. ${LABEL_PARAMETER.description}` } }, required, additionalProperties: false });
  const draftLabel = (raw: unknown): string => {
    if (raw === undefined) return DEFAULT_INTEL_LABEL;
    if (!isTemplateLabel(raw)) throw new ToolError(INTEL_RULES['label-ceiling']);
    return raw;
  };

  const intsumDraft: AgentTool<Record<string, unknown>> = {
    name: intelToolName('intsum_draft'),
    description: 'Draft an INTSUM skeleton for a period: the product header, the five headings, significant activity filled from the source register with each item\'s grades and independent origins, and gaps from the open PIRs. The assessment of intent and the changes since last are yours to write. It returns the text; write it to products/j2/ with Write.',
    parameters: draftParameters({ from: { type: 'string', description: 'Period start: ISO time in UTC, a date, or a DTG.' }, to: { type: 'string', description: 'Period end.' } }, ['from', 'to']),
    capability: 'read',
    manifest: declareManifest({ tool: intelToolName('intsum_draft'), effects: [readEffect(SOURCES, PIRS, STAFF_SETTINGS_PATH)], contexts: INTERACTIVE_AND_UNATTENDED }),
    parse: asObject,
    title: () => 'Draft INTSUM',
    async run(input, context) {
      const from = readTime(input.from);
      const to = readTime(input.to);
      if (Number.isNaN(from) || Number.isNaN(to)) throw new ToolError('Give from and to as ISO times in UTC, dates or DTGs.');
      const [sources, pirs, settings] = await Promise.all([loadRegister(context, 'source-register'), loadRegister(context, 'pir-register'), staffSettings(context)]);
      return unwrap(draftIntsum({ registers: { sources, pirs, plan: [] }, settings, label: draftLabel(input.label), owner: 'watch-officer' }, { from, to }, now()));
    }
  };

  const intrepDraft: AgentTool<Record<string, unknown>> = {
    name: intelToolName('intrep_draft'),
    description: 'Draft an INTREP skeleton for an event: what happened, which indicators it fires and the PIR and decision point each serves, the items it rests on with their grades and how many independent origins they come from, and a marked place for your deduction. It returns the text; write it to products/j2/ with Write.',
    parameters: draftParameters({
      event: { type: 'string', description: 'What happened, one line.' },
      at: { type: 'string', description: 'When: ISO time in UTC, a date, or a DTG. Default now.' },
      sources: { ...stringArray, description: 'SRC-n items it rests on.' },
      indicators: { ...stringArray, description: 'IND-n indicators it fires.' }
    }, ['event', 'sources']),
    capability: 'read',
    manifest: declareManifest({ tool: intelToolName('intrep_draft'), effects: [readEffect(SOURCES, PIRS, STAFF_SETTINGS_PATH)], contexts: INTERACTIVE_AND_UNATTENDED }),
    parse: asObject,
    title: () => 'Draft INTREP',
    async run(input, context) {
      const at = input.at === undefined ? now() : readTime(input.at);
      if (Number.isNaN(at)) throw new ToolError('Give at as an ISO time in UTC, a date or a DTG.');
      const [sources, pirs, settings] = await Promise.all([loadRegister(context, 'source-register'), loadRegister(context, 'pir-register'), staffSettings(context)]);
      return unwrap(draftIntrep({ registers: { sources, pirs, plan: [] }, settings, label: draftLabel(input.label), owner: 'watch-officer' }, { text: input.event, at, sources: input.sources, indicators: input.indicators }));
    }
  };

  const compilationCheck: AgentTool<{ path: string }> = {
    name: intelToolName('compilation_check'),
    description: 'Check one product for compilation risk: whether its lines, together with the source register it draws on, tie units to locations or capabilities, or pile up unit, location and capability detail. It never clears a product. When it finds a pattern it gives the question a person with authority must answer, and the release-guard writes HOLD with that question.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'The product file, such as products/j2/intsum-181200z-nov-26.md.' } }, required: ['path'], additionalProperties: false },
    capability: 'read',
    manifest: declareManifest({ tool: intelToolName('compilation_check'), effects: [{ verb: 'read', paths: [{ from: 'input', field: 'path', as: 'path' }, SOURCES] }], contexts: INTERACTIVE_AND_UNATTENDED }),
    parse: (raw) => {
      const value = asObject(raw);
      if (typeof value.path !== 'string' || !value.path.trim()) throw new ToolError('Give the product file as "path".');
      return { path: value.path.trim() };
    },
    title: (input) => `Compilation check: ${input.path}`,
    async run(input, context) {
      const absolute = await resolveInWorkspace(context.root, input.path);
      const text = await readText(absolute);
      if (text === undefined) throw new ToolError(`${input.path} does not exist.`);
      context.readFiles.add(absolute);
      const sources = await loadRegister(context, 'source-register');
      const result = compilationRisk(compilationItems(text, sources));
      const counts = `Detail found: ${result.counts.unit} unit, ${result.counts.location} location, ${result.counts.capability} capability, ${result.counts.timing} timing.`;
      if (result.risk === 'none') return `${displayPath(context.root, absolute)}: ${COMPILATION_NONE_TEXT}\n${counts}`;
      return [`${displayPath(context.root, absolute)}: possible compilation. A person decides.`, ...result.reasons.map((reason) => `- ${reason}`), counts, '', `Question for a person with authority: ${result.question}`].join('\n');
    }
  };

  const check: AgentTool<Record<string, unknown>> = {
    name: intelToolName('check'),
    description: 'Run every workbench rule over the three J2 registers: credibility 1 without independent confirmation, reports that repeat one origin, one source given two reliability grades, PIRs past their latest time of value or without indicators, approved PIRs with no collection, single-discipline collection, and collection past a latest time of value. Most severe first.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    capability: 'read',
    manifest: declareManifest({ tool: intelToolName('check'), effects: [readEffect(SOURCES, PIRS, PLAN)], contexts: INTERACTIVE_AND_UNATTENDED }),
    parse: asObject,
    title: () => 'Check the J2 registers',
    async run(_input, context) {
      const registers = await loadAll(context);
      const findings = registerFindings(registers, now());
      const sizes = `${registers.sources.length} source item${registers.sources.length === 1 ? '' : 's'}, ${registers.pirs.length} PIR${registers.pirs.length === 1 ? '' : 's'}, ${registers.plan.length} collection recommendation${registers.plan.length === 1 ? '' : 's'}.`;
      return findings.length ? [sizes, `${findings.length} finding${findings.length === 1 ? '' : 's'}:`, ...findingLines(findings)].join('\n') : `${sizes} No findings.`;
    }
  };

  return [sourceAdd, sourceList, independence, pirAdd, pirUpdate, pirList, collectionRecommend, collectionPlan, intsumDraft, intrepDraft, compilationCheck, check];
}

/** The names of the workbench's tools, for the tests and the team templates. */
export const INTEL_WORKBENCH_TOOL_NAMES: readonly string[] = intelWorkbenchTools().map((tool) => tool.name);

