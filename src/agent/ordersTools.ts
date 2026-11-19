// The orders server (design 10, 2.3 and 6.2 `orders`; WP-ORD): the profile's annex list, the consistency check over an order's annexes, assembly of an
// order or plan from released staff products, and FRAGO drafts. The rules are src/domain/staff/orders.ts; the ledger and the release state machine are
// the staff-products host's (src/staff/staffHost.ts).
//
// It is a built-in local server, not a process: the tools run inside the extension and are named `mcp__orders__<tool>`, so a team file grants them as
// `mcp:orders` or `mcp__orders__*`, and the run gives them only to the members whose tools line grants them (staffGrantGate.ts). Nothing is fetched or
// sent. Assembly and the FRAGO tool write a draft product and register it with the host's propose, the owner's verb: the release guard checks that exact
// version, the section lead submits it, and only a person approves and releases it, with the NEAR AI: Staff commands. No tool here approves, releases,
// issues or sends anything.
import * as path from 'node:path';
import { ANNEX_SUBJECTS, DOCTRINE_PROFILES, FRAGMENTARY_ORDER, ORDER_KINDS, ORDER_PARAGRAPHS } from '../domain/staff/doctrine';
import type { StaffProfileId } from '../domain/staff/doctrine';
import { productHash, RESERVED_MEMBER_SLUGS } from '../domain/staff/ledger';
import type { LedgerReplay, ProductState } from '../domain/staff/ledger';
import { assembleOrder, blocking, checkAnnexes, compareLetters, filedUnder, fragoBody, isAnnexSubject, orderKind, profileAnnexes } from '../domain/staff/orders';
import type { AnnexEntry, AssemblyAnnex, OrderFinding, OrderProductFacts } from '../domain/staff/orders';
import { STAFF_SLUG } from '../domain/staff/parse';
import { splitProductFile } from '../domain/staff/products';
import { describePlacement } from '../domain/staff/profiles';
import { mcpToolName } from '../mcp/tools';
import { MAX_STAFF_FILE_BYTES, readWhole, snapshotOfBytes, writeIfUnchanged } from '../staff/staffFiles';
import { productPath, STAFF_HOST_PATHS } from '../staff/staffHost';
import type { StaffCaller, StaffHost, StaffTeamInfo } from '../staff/staffHost';
import { declareManifest, INTERACTIVE_AND_UNATTENDED } from './tools';
import type { AgentTool, ToolContext } from './tools';
import { resolveInWorkspace, ToolError } from './workspace';

/** The server name a team file grants (`mcp:orders`, or `mcp__orders__*`). */
export const ORDERS_SERVER = 'orders';

export const ordersToolName = (tool: string): string => mcpToolName(ORDERS_SERVER, tool);

export interface OrdersToolAccess {
  host(): StaffHost | undefined;
  readonly team: StaffTeamInfo;
  readonly run: string;
}

const READS = { verb: 'read', paths: [...STAFF_HOST_PATHS] };
const WRITES = { verb: 'workspaceWrite', paths: ['.planning/staff/**'] };
const manifest = (tool: string, write: boolean) => declareManifest({ tool: ordersToolName(tool), effects: write ? [READS, WRITES] : [READS], contexts: INTERACTIVE_AND_UNATTENDED });

const MAX_ANNEXES = ANNEX_SUBJECTS.length * 2;
const MAX_CHANGE = 20_000;
const FRAGO_KEYS = ['situation', 'mission', 'execution', 'support', 'command'] as const;

function asObject(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ToolError('Arguments must be a JSON object.');
  return raw;
}

function slug(raw: Record<string, unknown>, key: string, required = true): string | undefined {
  const value = raw[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !STAFF_SLUG.test(value.trim())) throw new ToolError(`${key} is a product name: lower case letters, digits and dashes, such as base-plan.`);
  return value.trim();
}

function line(raw: Record<string, unknown>, key: string, max = 200): string {
  const value = raw[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n]/.test(value)) throw new ToolError(`${key} is one line of text, at most ${max} characters.`);
  return value.trim();
}

function entries(raw: Record<string, unknown>, required: boolean): AnnexEntry[] | undefined {
  const value = raw.annexes;
  if (value === undefined && !required) return undefined;
  if (!Array.isArray(value) || value.length > MAX_ANNEXES) throw new ToolError(`annexes is a list of at most ${MAX_ANNEXES} entries such as { "subject": "logistics", "product": "logistics-annex" }.`);
  return value.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new ToolError(`annexes[${index}] is { subject, product?, letter?, owner? }.`);
    const entry = item as Record<string, unknown>;
    for (const key of Object.keys(entry)) if (!['subject', 'product', 'letter', 'owner'].includes(key)) throw new ToolError(`annexes[${index}] has no field "${key.slice(0, 30)}".`);
    const text = (key: string, max: number): string | undefined => {
      const field = entry[key];
      if (field === undefined) return undefined;
      if (typeof field !== 'string' || field.length > max || /[\r\n]/.test(field)) throw new ToolError(`annexes[${index}].${key} is one line of at most ${max} characters.`);
      return field.trim();
    };
    const subject = text('subject', 64);
    if (!subject) throw new ToolError(`annexes[${index}] needs a subject: one of ${ANNEX_SUBJECTS.join(', ')}.`);
    const product = text('product', 64);
    if (product !== undefined && !STAFF_SLUG.test(product)) throw new ToolError(`annexes[${index}].product is a product name: lower case letters, digits and dashes.`);
    const letter = text('letter', 4);
    const owner = text('owner', 64);
    return { subject, ...(product ? { product } : {}), ...(letter ? { letter } : {}), ...(owner ? { owner } : {}) };
  });
}

/** The newest version of a product a person approved, across its lines. */
function latestApproved(state: ProductState): number | undefined {
  const versions = [state, ...state.older].flatMap((line) => line.approvedVersions);
  return versions.length ? Math.max(...versions) : undefined;
}

/** What the check knows about every product in the ledger. */
export function productFacts(replay: LedgerReplay): Map<string, OrderProductFacts> {
  const facts = new Map<string, OrderProductFacts>();
  for (const [name, state] of replay.products) {
    const approved = latestApproved(state);
    facts.set(name, {
      state: state.record.state, version: state.record.version, owner: state.record.roles.owner, section: state.record.section, dependsOn: state.meta.dependsOn,
      ...(approved !== undefined ? { latestApproved: approved } : {}), ...(state.tampered ? { tampered: state.tampered } : {})
    });
  }
  return facts;
}

function findingsText(findings: readonly OrderFinding[]): string {
  return findings.map((finding, index) => `${index + 1}. [${finding.kind}] ${finding.message}`).join('\n');
}

/** Builds the orders tools for one run of one staff team. */
export function ordersTools(access: OrdersToolAccess): AgentTool<any>[] {
  const hostOf = (): StaffHost => {
    const host = access.host();
    if (!host) throw new ToolError('The staff products host is not ready in this window. Reload the window and try again.');
    return host;
  };
  const callerOf = (context: ToolContext): StaffCaller => ({ member: context.agentLabel, run: access.run, root: context.root, team: access.team });
  const memberOf = (context: ToolContext): string => {
    const member = context.agentLabel;
    if (member === undefined || !access.team.members.includes(member)) throw new ToolError('Only a member of this staff team can write an order. The run\'s lead coordinates; a member drafts.');
    if (RESERVED_MEMBER_SLUGS.includes(member)) throw new ToolError(`${member} is a reserved name and cannot write an order.`);
    return member;
  };
  const profileOf = async (): Promise<StaffProfileId> => (await hostOf().profileFor(access.team)).profile;
  const trustedReplay = async (): Promise<LedgerReplay> => {
    const replay = await hostOf().replay();
    if (replay.broken) throw new ToolError(`The product ledger cannot be trusted (${replay.broken.reason}), so no order can be built from it. Nothing was written.`);
    return replay;
  };

  /** The released text of a product: the file must hold exactly the version a person released. */
  const releasedBody = async (root: string, name: string, replay: LedgerReplay): Promise<{ body: string; version: number; owner: string }> => {
    const state = replay.products.get(name);
    if (!state) throw new ToolError(`${name} is not a staff product in the ledger.`);
    if (state.tampered) throw new ToolError(`${name} cannot be used: ${state.tampered}`);
    if (state.record.state !== 'released') throw new ToolError(`${name} version ${state.record.version} is ${state.record.state}, not released. An order is built only from products a person released.`);
    const relative = productPath(state.record.section, name);
    const read = await readWhole(path.join(root, relative));
    if (read.kind !== 'text') throw new ToolError(`${relative} ${read.kind === 'missing' ? 'is missing' : `cannot be read: ${read.reason}`}, so its released text cannot be used. Nothing was written.`);
    const parts = splitProductFile(read.text);
    const body = parts ? parts.body : read.text;
    if (productHash(body, state.meta.dependsOn) !== state.record.hash) throw new ToolError(`${relative} no longer holds the version a person released (${state.record.version}), so it cannot be used. Nothing was written.`);
    return { body, version: state.record.version, owner: state.record.roles.owner };
  };

  /** Writes a draft product's body over exactly the bytes read, keeping its staff header, then registers it with the owner's propose. */
  const writeDraft = async (context: ToolContext, member: string, name: string, body: string, kind: 'order' | 'plan', dependsOn: Array<{ product: string; version: number }>, replay: LedgerReplay): Promise<string> => {
    const existing = replay.products.get(name);
    if (existing && existing.record.section !== access.team.section) throw new ToolError(`${name} belongs to ${existing.record.section}, not to this team's section. Choose another product name.`);
    if (existing && existing.record.roles.owner !== member) throw new ToolError(`${name} is owned by ${existing.record.roles.owner}. Only its owner writes it; choose another product name.`);
    if (existing?.tampered) throw new ToolError(`${name} cannot be changed: ${existing.tampered}`);
    // A version a person is deciding on, or has approved and not yet released, is not written over: the decision and the release hold to its hash.
    if (existing && (existing.record.state === 'awaiting-decision' || existing.record.state === 'approved')) {
      throw new ToolError(`${name} version ${existing.record.version} is ${existing.record.state === 'approved' ? 'approved and waiting for a person to release it' : 'waiting on a person\'s decision'}, so it was not written over. Choose another product name, or ${existing.record.state === 'approved' ? 'wait for the release' : 'withdraw that version first'}.`);
    }
    if (Buffer.byteLength(body, 'utf8') > MAX_STAFF_FILE_BYTES - 64 * 1024) throw new ToolError('The assembled text is larger than a staff product may be (2 MB). Split the plan into products of their own. Nothing was written.');
    const relative = productPath(access.team.section, name);
    const absolute = await resolveInWorkspace(context.root, relative);
    const read = await readWhole(absolute);
    if (read.kind === 'unreadable') throw new ToolError(`${relative} was not read: ${read.reason}. Nothing was written.`);
    const header = read.kind === 'text' ? (/^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(read.text)?.[0] ?? '') : '';
    await context.checkpoints?.capture(absolute);
    if (!(await writeIfUnchanged(absolute, snapshotOfBytes(read.kind === 'text' ? read.bytes : undefined), `${header}${body}`))) {
      throw new ToolError(`${relative} changed while it was being written, so it was not replaced. Run the tool again.`);
    }
    const proposed = await hostOf().propose(callerOf(context), { product: name, kind, dependsOn });
    if (!proposed.ok) throw new ToolError(`${relative} was written, but it is not registered: ${proposed.message}`);
    return `${relative} written. ${proposed.text}`;
  };

  const annexList: AgentTool<Record<string, never>> = {
    name: ordersToolName('annexes'),
    description: '[orders] The annex list of the project\'s doctrine profile: for each subject, its letter and title, or the annex it is an appendix to or part of, or that the profile gives it no letter. Also the orders and plans the profile issues and the five paragraphs of its format. Take every annex letter from here (or PROFILE.md), never from memory.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    capability: 'read',
    manifest: manifest('annexes', false),
    concurrent: true,
    parse: (raw) => { asObject(raw); return {}; },
    title: () => 'Annex list',
    async run() {
      const profile = await profileOf();
      const entry = DOCTRINE_PROFILES[profile];
      const annexes = profileAnnexes(profile).sort((a, b) => {
        const la = filedUnder(a.placement); const lb = filedUnder(b.placement);
        return la === undefined ? 1 : lb === undefined ? -1 : compareLetters(la, lb) || (a.placement.kind === 'annex' ? -1 : 1);
      });
      return [
        `${entry.name} annexes (${entry.annexSource}):`,
        ...annexes.map((annex) => `- ${annex.subject}: ${describePlacement(annex.placement)}`),
        '',
        `Orders and plans: ${ORDER_KINDS[profile].map((kind) => `${kind.id} (${kind.abbreviation}, ${kind.name.toLowerCase()})`).join(', ')}. Fragmentary order: ${FRAGMENTARY_ORDER.abbreviation[profile]}, through orders_frago.`,
        `Paragraphs: ${ORDER_PARAGRAPHS[profile].map((paragraph, index) => `${index + 1}. ${paragraph}`).join('; ')}.`
      ].join('\n');
    }
  };

  const check: AgentTool<{ annexes?: AnnexEntry[] }> = {
    name: ordersToolName('check'),
    description: '[orders] The consistency check over an order\'s annexes, against the profile and the product ledger: a letter that is not the profile\'s, a subject the profile gives no letter, an annex with no owner or an owner the ledger disagrees with, a product the ledger does not know or that is not released, and a product built on a source a person has since approved a newer version of. Give annexes as [{ subject, product?, letter?, owner? }]; leave it out to check the annex tracker register. It changes nothing.',
    parameters: {
      type: 'object',
      properties: { annexes: { type: 'array', items: { type: 'object', properties: { subject: { type: 'string', enum: [...ANNEX_SUBJECTS] }, product: { type: 'string' }, letter: { type: 'string' }, owner: { type: 'string' } }, required: ['subject'], additionalProperties: false } } },
      additionalProperties: false
    },
    capability: 'read',
    manifest: manifest('check', false),
    concurrent: true,
    parse: (raw) => { const value = asObject(raw); const list = entries(value, false); return list ? { annexes: list } : {}; },
    title: () => 'Check the annexes',
    async run(input, context) {
      const host = hostOf();
      const replay = await trustedReplay();
      let list = input.annexes;
      let source = 'the annexes given';
      if (!list) {
        const read = await host.registerRead(callerOf(context), 'annex-tracker');
        if (!read.ok) throw new ToolError(read.message);
        const rows = (JSON.parse(read.text) as { rows: Array<Record<string, string>> }).rows;
        list = rows.map((row) => ({ subject: row.subject, ...(row.letter ? { letter: row.letter } : {}), ...(row.product ? { product: row.product } : {}), ...(row.owner ? { owner: row.owner } : {}) }));
        source = 'the annex tracker';
        if (!list.length) return 'The annex tracker has no rows yet, so there is nothing to check.';
      }
      const profile = await profileOf();
      const findings = checkAnnexes(profile, list, productFacts(replay));
      if (!findings.length) return `${list.length} annex${list.length === 1 ? '' : 'es'} from ${source} checked under ${DOCTRINE_PROFILES[profile].name}: no findings.`;
      return [`${findings.length} finding${findings.length === 1 ? '' : 's'} in ${source} under ${DOCTRINE_PROFILES[profile].name}:`, findingsText(findings)].join('\n');
    }
  };

  const assemble: AgentTool<{ product: string; kind: string; title: string; base?: string; annexes: AnnexEntry[] }> = {
    name: ordersToolName('assemble'),
    description: '[orders] Assemble an order or plan in the profile\'s format from released staff products: the base text (the CONOPS or base plan, released), then each annex under the letter the profile gives its subject, with its source version and owner. It runs the consistency check first and writes nothing while a finding blocks. The result is written as a draft product of yours and registered (propose): the release guard checks it, the section lead submits it, and only a person releases it.',
    parameters: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'The draft product to write, such as base-plan.' },
        kind: { type: 'string', description: 'The order or plan: an id from orders_annexes (opord, oplan, conops, ...).' },
        title: { type: 'string', description: 'One line, such as "Operation IRON LANTERN, phase 1".' },
        base: { type: 'string', description: 'The released product that holds the five paragraphs.' },
        annexes: { type: 'array', items: { type: 'object', properties: { subject: { type: 'string', enum: [...ANNEX_SUBJECTS] }, product: { type: 'string' }, letter: { type: 'string' }, owner: { type: 'string' } }, required: ['subject', 'product'], additionalProperties: false } }
      },
      required: ['product', 'kind', 'title', 'annexes'],
      additionalProperties: false
    },
    capability: 'workspaceWrite',
    manifest: manifest('assemble', true),
    parse: (raw) => {
      const value = asObject(raw);
      const list = entries(value, true)!;
      for (const [index, entry] of list.entries()) if (!entry.product) throw new ToolError(`annexes[${index}] needs the product that holds the annex.`);
      const base = slug(value, 'base', false);
      return { product: slug(value, 'product')!, kind: line(value, 'kind', 20), title: line(value, 'title'), ...(base ? { base } : {}), annexes: list };
    },
    title: (input) => `Assemble ${input.product}`,
    async run(input, context) {
      const member = memberOf(context);
      const profile = await profileOf();
      const kind = orderKind(profile, input.kind);
      if (!kind) throw new ToolError(`${input.kind.slice(0, 20)} is not an order or plan under ${DOCTRINE_PROFILES[profile].name}. Use one of ${ORDER_KINDS[profile].map((entry) => entry.id).join(', ')}.`);
      if (input.annexes.some((entry) => entry.product === input.product) || input.base === input.product) throw new ToolError(`${input.product} cannot be built from itself.`);
      const replay = await trustedReplay();
      const facts = productFacts(replay);
      const findings = checkAnnexes(profile, input.annexes, facts);
      if (input.base) findings.push(...checkAnnexes(profile, [{ subject: 'operations', product: input.base }], facts).filter((finding) => finding.kind !== 'parent-missing').map((finding) => ({ ...finding, subject: 'base', message: finding.message.replace(/^operations /, 'The base text ') })));
      const stops = blocking(findings);
      if (stops.length) throw new ToolError([`Nothing was written: ${stops.length} finding${stops.length === 1 ? '' : 's'} must be fixed first.`, findingsText(stops)].join('\n'));
      const base = input.base ? { product: input.base, ...(await releasedBody(context.root, input.base, replay)) } : undefined;
      const annexes: AssemblyAnnex[] = [];
      for (const entry of input.annexes) {
        if (!isAnnexSubject(entry.subject)) continue;
        const released = await releasedBody(context.root, entry.product!, replay);
        annexes.push({ subject: entry.subject, product: entry.product!, version: released.version, owner: released.owner, body: released.body });
      }
      const body = assembleOrder({ profile, kind, title: input.title, ...(base ? { base: { product: base.product, version: base.version, body: base.body } } : {}), annexes, findings });
      const dependsOn = [...(base ? [{ product: base.product, version: base.version }] : []), ...annexes.map((annex) => ({ product: annex.product, version: annex.version }))];
      const written = await writeDraft(context, member, input.product, body, kind.productKind, dependsOn, replay);
      const notes = findings.length ? `\nNoted in its open items:\n${findingsText(findings)}` : '';
      return `${kind.abbreviation} assembled from ${annexes.length} released annex${annexes.length === 1 ? '' : 'es'}${base ? ` and ${base.product}@${base.version}` : ''}. ${written}${notes}`;
    }
  };

  const frago: AgentTool<{ product: string; number: number; title: string; base: string; changes: Record<string, string> }> = {
    name: ordersToolName('frago'),
    description: `[orders] Draft a fragmentary order (${Object.values(FRAGMENTARY_ORDER.abbreviation).filter((value, index, all) => all.indexOf(value) === index).join(' or ')}) to a released order: the changes only, in the five-paragraph format (situation, mission, execution, support for paragraph 4, command for paragraph 5); a paragraph left out reads "No change." It is written as a draft product of yours and registered (propose). It is never sent, issued or executed: the release guard checks it, the section lead submits it, and only a person releases it.`,
    parameters: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'The draft product to write, such as frago-3.' },
        number: { type: 'integer', minimum: 1, maximum: 999 },
        title: { type: 'string' },
        base: { type: 'string', description: 'The released order or plan this changes.' },
        changes: { type: 'object', properties: Object.fromEntries(FRAGO_KEYS.map((key) => [key, { type: 'string' }])), additionalProperties: false }
      },
      required: ['product', 'number', 'title', 'base', 'changes'],
      additionalProperties: false
    },
    capability: 'workspaceWrite',
    manifest: manifest('frago', true),
    parse: (raw) => {
      const value = asObject(raw);
      const number = value.number;
      if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || number > 999) throw new ToolError('number is the FRAGO number, a whole number from 1 to 999.');
      const changes = value.changes;
      if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) throw new ToolError(`changes is { ${FRAGO_KEYS.join(', ')} }, each the change to that paragraph.`);
      const out: Record<string, string> = {};
      for (const [key, change] of Object.entries(changes as Record<string, unknown>)) {
        if (!(FRAGO_KEYS as readonly string[]).includes(key)) throw new ToolError(`changes has no paragraph "${key.slice(0, 30)}"; the paragraphs are ${FRAGO_KEYS.join(', ')}.`);
        if (typeof change !== 'string' || change.length > MAX_CHANGE) throw new ToolError(`changes.${key} is text of at most ${MAX_CHANGE} characters.`);
        if (change.trim()) out[key] = change;
      }
      if (!Object.keys(out).length) throw new ToolError('A FRAGO changes at least one paragraph.');
      return { product: slug(value, 'product')!, number, title: line(value, 'title'), base: slug(value, 'base')!, changes: out };
    },
    title: (input) => `Draft ${input.product}`,
    async run(input, context) {
      const member = memberOf(context);
      const profile = await profileOf();
      if (input.base === input.product) throw new ToolError(`${input.product} cannot change itself.`);
      const replay = await trustedReplay();
      const baseState = replay.products.get(input.base);
      if (baseState && baseState.meta.kind !== 'order' && baseState.meta.kind !== 'plan') throw new ToolError(`${input.base} is a ${baseState.meta.kind}, not an order or plan; a FRAGO changes an order.`);
      const released = await releasedBody(context.root, input.base, replay);
      const body = fragoBody({ profile, number: input.number, title: input.title, base: { product: input.base, version: released.version, kind: baseState!.meta.kind }, changes: FRAGO_KEYS.map((key) => input.changes[key]) });
      const written = await writeDraft(context, member, input.product, body, 'order', [{ product: input.base, version: released.version }], replay);
      return `${FRAGMENTARY_ORDER.abbreviation[profile]} ${input.number} drafted against ${input.base}@${released.version}. ${written} Only a person releases it.`;
    }
  };

  return [annexList, check, assemble, frago];
}

/** The orders tool names, in order, for the Tools page and the tests. */
export const ORDERS_TOOL_NAMES: readonly string[] = ordersTools({ host: () => undefined, team: { slug: 'directory', section: 'j5', members: [], sectionLead: '' }, run: 'directory' }).map((tool) => tool.name);
