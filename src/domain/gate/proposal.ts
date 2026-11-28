// A proposed policy change as a list of changed keys, each with one plain sentence (FND-09, Phase 41 D-44). Pure: no I/O, no clock, no vscode, no package.
// Every flow that would change the rules hands the editor a next document; proposalOf compares it with the rules in force and says, per key, what changes
// and whether the rules get wider or stricter. A key whose direction is not known counts as widening, so a change is never applied as harmless by default.
// policySections gives the rules page its eight read-only sections in plain words, and proposalPayload is the one stable shape of a proposal exported to
// your organization's contacts (signed by signPayload under `policy-proposal`).
// Imported values are used only inside functions, never at module load.
import type { AuthorizationBody } from './authorizations';
import type { EndpointClass, PolicyEndpoint } from './endpoints';
import { POLICY_SECTIONS } from './features';
import type { PolicySectionName } from './features';
import { labelKeyShown, scaleShown } from './labelAlgebra';
import type { ScaleTable } from './labels';
import type { PolicyDocument, PolicyLayerName } from './policyDocument';
import { canonicalize } from '../team/canonical';
import { PayloadError } from '../team/signedPayload';
import type { SignedPayload } from '../team/signedPayload';

export type ProposalDirection = 'narrows' | 'widens' | 'neutral';

/**
 * Says whether a change of one key makes the rules stricter, wider or neither; undefined when it cannot tell. 41-14 builds it from 41-02's narrowingOf,
 * joining section and key into its path.
 */
export type DirectionOf = (section: string, key: string, before: unknown, after: unknown) => ProposalDirection | undefined;

/** The judge that knows nothing: every change counts as widening. */
export const UNKNOWN_WIDENS: DirectionOf = () => undefined;

export interface ProposalChange {
  /** The document section the key belongs to (`labels`, `endpoints`, ...). */
  readonly section: string;
  /** The key inside the section: dotted for objects, `[id]` for a list item with an id. */
  readonly key: string;
  /** Absent when the key is new. */
  readonly before?: unknown;
  /** Absent when the key is removed. */
  readonly after?: unknown;
  readonly direction: ProposalDirection;
  /** One plain sentence about what the change does. */
  readonly effect: string;
}

type Fields = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(value: Fields, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  try {
    return canonicalize(a) === canonicalize(b);
  } catch {
    // A value the canonical form cannot write (a fraction, for one) is compared as plain JSON, which never counts two different values as equal.
    return JSON.stringify(a) === JSON.stringify(b);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Plain words (GLOSSARY sections 1 and 3)

/** The order the sections are compared and shown in: POLICY_SECTIONS without `reserved`, which is validated and ignored. */
function diffSections(): readonly PolicySectionName[] {
  return POLICY_SECTIONS.filter((section) => section !== 'reserved');
}

/** A document section's title in a sentence. */
const SECTION_TITLES: Readonly<Record<PolicySectionName, string>> = Object.freeze({
  labels: 'Labels and where they may go',
  endpoints: 'Where AI runs',
  authorizations: 'Authorizations',
  models: 'Models',
  agents: 'Agents and tools',
  residency: 'Where AI runs',
  people: 'People and organization',
  onboarding: 'Setup and discovery',
  limits: 'Limits',
  reserved: 'Stored values',
  exportControl: 'Export-controlled work',
  credentials: 'Who may issue credentials',
  agreements: 'Agreements with other organizations',
  classification: 'How labels are proposed',
  labelInterop: 'How labels are written for allies'
});

const REGION_WORDS: Readonly<Record<string, string>> = Object.freeze({ CA: 'Canada', EU: 'the European Union', US: 'the United States' });

/** The "Runs on" words of an AI service by its class. */
function runsOn(endpointClass: EndpointClass | string, region: string): string {
  switch (endpointClass) {
    case 'local': return 'this computer';
    case 'org-plain':
    case 'org-tee': return "your organization's server";
    case 'nearai-tee': return 'NEAR AI private hardware';
    case 'vendor-tee':
    case 'vendor-region': return REGION_WORDS[region] === undefined ? 'an outside AI service' : `an outside AI service in ${REGION_WORDS[region]}`;
    default: return 'an outside AI service';
  }
}

/** Where content at a routing level may go, as the rules page shows it. */
const TIER_PLACES: Readonly<Record<string, string>> = Object.freeze({
  'any-cloud': 'Any AI service',
  'attested-cloud': 'NEAR AI private hardware or this computer',
  'local-only': 'This computer only',
  deny: 'Never sent to an AI service'
});

const COMPARTMENT_WORDS: Readonly<Record<string, string>> = Object.freeze({ CGP: 'Controlled goods (Canada)', EAR: 'US export-controlled (EAR)', ITAR: 'ITAR' });

const KIND_WORDS: Readonly<Record<string, string>> = Object.freeze({
  'protected-b': 'Protected B in a hosted AI service',
  't1-risk': 'An outside model for chat you review',
  'accredited-device': 'Classified work on an approved computer',
  'residency-exception': 'Work leaving the country it must stay in',
  declassify: 'Lowering a label',
  'export-person': 'A person allowed to see export-controlled work',
  'export-endpoint': 'An AI service allowed for export-controlled work'
});

const CONTEXT_WORDS: Readonly<Record<string, string>> = Object.freeze({
  interactive: 'while you work', unattended: 'while you are away', relay: 'for other people', routine: 'on a schedule'
});

const MODE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  'approve-risky': 'Ask before edits', 'mostly-autonomous': 'Edits auto', auto: 'Auto', 'fully-autonomous': 'Full auto'
});

const TOPIC_WORDS: Readonly<Record<string, string>> = Object.freeze({
  security: 'Security', privacy: 'Privacy', 'contract-security': 'Contract security', it: 'IT', 'export-control': 'Export control'
});

const WORK_WORDS: Readonly<Record<string, string>> = Object.freeze({
  software: 'Software', staff: 'Staff work', analysis: 'Analysis', 'capital-projects': 'Capital projects', writing: 'Writing'
});

function labelsShown(keys: readonly unknown[], scales: ScaleTable): string {
  return keys.filter((key): key is string => typeof key === 'string').map((key) => labelKeyShown(key, scales)).join(' and ');
}

function regionsShown(value: unknown): string {
  return (Array.isArray(value) ? value : []).map((region) => REGION_WORDS[String(region)] ?? String(region)).join(' or ');
}

function dateShown(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 10) : '';
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The diff

/** The id a list item is keyed by: its own string `id`, or for a signed envelope its payload's `id`. */
function itemId(item: unknown): string | undefined {
  if (!isRecord(item)) return undefined;
  const id = own(item, 'id');
  if (typeof id === 'string') return id;
  const payload = own(item, 'payload');
  if (isRecord(payload) && typeof own(item, 'sig') === 'string') {
    const inner = own(payload, 'id');
    if (typeof inner === 'string') return inner;
  }
  return undefined;
}

/** A list's items by id, or undefined when an item has no id or two share one (the list is then one value). */
function keyedItems(list: readonly unknown[]): Map<string, unknown> | undefined {
  const out = new Map<string, unknown>();
  for (const item of list) {
    const id = itemId(item);
    if (id === undefined || out.has(id)) return undefined;
    out.set(id, item);
  }
  return out;
}

interface RawChange { key: string; before: unknown; after: unknown }

function walk(key: string, before: unknown, after: unknown, out: RawChange[]): void {
  if (same(before, after)) return;
  if (isRecord(before) && isRecord(after) && itemId(before) === undefined && itemId(after) === undefined) {
    for (const child of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      walk(key === '' ? child : `${key}.${child}`, own(before, child), own(after, child), out);
    }
    return;
  }
  const beforeList = Array.isArray(before) ? before : before === undefined ? [] : undefined;
  const afterList = Array.isArray(after) ? after : after === undefined ? [] : undefined;
  if (beforeList !== undefined && afterList !== undefined && (Array.isArray(before) || Array.isArray(after))) {
    const was = keyedItems(beforeList);
    const now = keyedItems(afterList);
    if (was !== undefined && now !== undefined && (was.size > 0 || now.size > 0)) {
      for (const id of [...new Set([...was.keys(), ...now.keys()])].sort()) {
        const item = `${key}[${id}]`;
        const a = was.get(id);
        const b = now.get(id);
        if (!same(a, b)) out.push({ key: item, before: a, after: b });
      }
      return;
    }
  }
  out.push({ key, before, after });
}

/** The changes inside one section; an absent section reads as empty, and its own `v` is not a rule. */
function sectionChanges(base: unknown, next: unknown): RawChange[] {
  const out: RawChange[] = [];
  if (Array.isArray(base) || Array.isArray(next)) {
    walk('', base ?? [], next ?? [], out);
    return out;
  }
  const before = isRecord(base) ? base : {};
  const after = isRecord(next) ? next : {};
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (key === 'v') continue;
    walk(key, own(before, key), own(after, key), out);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Effects

const DIRECTION_SENTENCES: Readonly<Record<ProposalDirection, string>> = Object.freeze({
  widens: ' This makes the rules wider.', narrows: ' This makes the rules stricter.', neutral: ''
});

function routingEffect(level: string, after: unknown, direction: ProposalDirection, scales: ScaleTable): string {
  const shown = labelKeyShown(level, scales);
  if (after === 'any-cloud') return `${shown} work could go to a server that is not verified.`;
  if (after === 'attested-cloud') {
    return direction === 'narrows'
      ? `${shown} work will only go to NEAR AI private hardware or this computer.`
      : `${shown} work could go to NEAR AI private hardware (checked each time it is used).`;
  }
  if (after === 'local-only') return direction === 'widens' ? `${shown} work could go to this computer.` : `${shown} work will only go to this computer.`;
  if (after === 'deny') return `${shown} work will not go to any AI service.`;
  return `${shown}: where this work may go changes.${DIRECTION_SENTENCES[direction]}`;
}

function endpointEffect(before: unknown, after: unknown, direction: ProposalDirection, scales: ScaleTable): string | undefined {
  const entry = (isRecord(after) ? after : isRecord(before) ? before : undefined) as Partial<PolicyEndpoint> | undefined;
  if (entry === undefined || typeof entry.host !== 'string') return undefined;
  const where = runsOn(String(entry.class), String(entry.region));
  if (after === undefined) return `Nothing will go to ${entry.host} any more.`;
  if (before === undefined) {
    const labels = labelsShown(Array.isArray(entry.maxLabel) ? entry.maxLabel : [], scales);
    return labels === '' ? `${entry.host} (${where}) is listed, but no work may go to it yet.` : `${labels} work could go to ${entry.host} (${where}).`;
  }
  return `What may go to ${entry.host} (${where}) changes.${DIRECTION_SENTENCES[direction]}`;
}

function authorizationEffect(before: unknown, after: unknown, direction: ProposalDirection): string {
  const envelope = (isRecord(after) ? after : before) as Partial<SignedPayload<Partial<AuthorizationBody>>> | undefined;
  const body = isRecord(envelope?.payload) ? envelope.payload : {};
  const name = isRecord(body.namedPerson) && typeof body.namedPerson.name === 'string' ? body.namedPerson.name : 'a named person';
  const until = dateShown(body.expiresAt);
  const span = until === '' ? `allowed by ${name}` : `allowed by ${name} until ${until}`;
  if (before === undefined) return `A new exception, ${span}.`;
  if (after === undefined) return `The exception ${span} ends.`;
  return `The exception ${span} changes.${DIRECTION_SENTENCES[direction]}`;
}

function residencyEffect(key: string, after: unknown, direction: ProposalDirection, scales: ScaleTable): string {
  const regions = regionsShown(after);
  if (key === 'required') return after === undefined ? 'Work no longer has to stay in one country.' : `All work must stay in ${regions}.`;
  if (key.startsWith('byLevel.')) {
    const shown = labelKeyShown(key.slice('byLevel.'.length), scales);
    return after === undefined ? `${shown} work no longer has to stay in one country.` : `${shown} work must stay in ${regions}.`;
  }
  return `Where AI runs: ${key} changes.${DIRECTION_SENTENCES[direction]}`;
}

/** The models keys in plain words: the schema's own names (tiers, passports) never reach a person (D-42, GLOSSARY). */
const MODELS_KEY_WORDS: Readonly<Record<string, string>> = Object.freeze({
  mode: 'whether model checks only record or also refuse',
  unknownMaxTier: 'what a model with no record may do',
  tierByLevel: 'which models may handle work at each label',
  tierByProject: 'which models may handle each kind of project',
  passports: 'the models your organization approved',
  defaults: 'the model chosen first for each job',
  localCatalogue: 'the models this computer may download',
  order: 'the order models are tried in'
});

function modelsEffect(key: string, direction: ProposalDirection, scales: ScaleTable): string {
  if (key.startsWith('tierByLevel.')) return `${labelKeyShown(key.slice('tierByLevel.'.length), scales)} work: which models may handle it changes.${DIRECTION_SENTENCES[direction]}`;
  if (key.startsWith('tierByProject.')) return `Projects marked ${key.slice('tierByProject.'.length)}: which models may handle them changes.${DIRECTION_SENTENCES[direction]}`;
  const head = key.split(/[.[]/)[0] ?? '';
  const words = Object.prototype.hasOwnProperty.call(MODELS_KEY_WORDS, head) ? MODELS_KEY_WORDS[head] : 'how models are chosen';
  return `Models: ${String(words)} changes.${DIRECTION_SENTENCES[direction]}`;
}

function effectOf(section: PolicySectionName, change: RawChange, direction: ProposalDirection, scales: ScaleTable): string {
  const { key, before, after } = change;
  if (section === 'labels' && key.startsWith('routing.levels.')) return routingEffect(key.slice('routing.levels.'.length), after, direction, scales);
  if (section === 'endpoints' && key.startsWith('[')) {
    const sentence = endpointEffect(before, after, direction, scales);
    if (sentence !== undefined) return sentence;
  }
  if (section === 'authorizations' && key.startsWith('[')) return authorizationEffect(before, after, direction);
  if (section === 'residency') return residencyEffect(key, after, direction, scales);
  if (section === 'models') return modelsEffect(key, direction, scales);
  if (section === 'agents' && key === 'requireAccreditedDevice') {
    return after === true ? 'Classified work will need a computer your organization approved.' : 'Classified work will no longer need a computer your organization approved.';
  }
  return `${SECTION_TITLES[section]}: ${key} changes.${DIRECTION_SENTENCES[direction]}`;
}

/**
 * Every changed key from `base` to `next`, with one plain sentence each, frozen and sorted by section (the editor's order) then key. Only the sections are
 * compared: the envelope (issuedAt, expiresAt, issuer, layer, parent, requires, minClient) and `reserved` are not proposals. Plain objects recurse with
 * dotted keys; a list whose items all carry an id (or a signed envelope's payload id) is keyed `[id]`; any other list is one value. A judge's undefined
 * counts as widening. Labels are shown with `scales`, the base document's by default.
 */
export function proposalOf(base: PolicyDocument, next: PolicyDocument, directionOf: DirectionOf = UNKNOWN_WIDENS, scales?: ScaleTable): readonly ProposalChange[] {
  const shownScales = scales ?? base.labels.scales;
  const out: ProposalChange[] = [];
  const baseFields = base as unknown as Fields;
  const nextFields = next as unknown as Fields;
  for (const section of diffSections()) {
    const raw = sectionChanges(own(baseFields, section), own(nextFields, section));
    raw.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const change of raw) {
      const direction = directionOf(section, change.key, change.before, change.after) ?? 'widens';
      out.push(Object.freeze({
        section,
        key: change.key,
        ...(change.before === undefined ? {} : { before: change.before }),
        ...(change.after === undefined ? {} : { after: change.after }),
        direction,
        effect: effectOf(section, change, direction, shownScales)
      }));
    }
  }
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The rules page's sections

/** The eight sections of the rules page, in order (POLICY-SCHEMA section 7). */
export const POLICY_SECTION_IDS = Object.freeze(['labels', 'where-ai-runs', 'models', 'authorizations', 'agents', 'people', 'setup', 'limits'] as const);
export type PolicySectionId = (typeof POLICY_SECTION_IDS)[number];

export interface PolicySectionRow {
  readonly name: string;
  readonly value: string;
}

export interface PolicySectionView {
  readonly id: PolicySectionId;
  readonly title: string;
  readonly rows: readonly PolicySectionRow[];
}

const PAGE_TITLES: Readonly<Record<PolicySectionId, string>> = Object.freeze({
  labels: 'Labels and where they may go',
  'where-ai-runs': 'Where AI runs',
  models: 'Models',
  authorizations: 'Authorizations',
  agents: 'Agents and tools',
  people: 'People and organization',
  setup: 'Setup and discovery',
  limits: 'Limits'
});

const row = (name: string, value: string): PolicySectionRow => Object.freeze({ name, value });

function labelRows(doc: PolicyDocument, scales: ScaleTable): PolicySectionRow[] {
  const rows: PolicySectionRow[] = [];
  const levels = doc.labels.routing.levels;
  for (const scale of Object.keys(scales)) {
    for (const level of scales[scale]?.levels ?? []) {
      const tier = levels[`${scale}/${level}`];
      if (tier !== undefined) rows.push(row(labelKeyShown(`${scale}/${level}`, scales), TIER_PLACES[tier] ?? tier));
    }
  }
  for (const token of Object.keys(doc.labels.routing.compartments).sort()) {
    const tier = doc.labels.routing.compartments[token];
    if (tier !== undefined) rows.push(row(`Marked ${COMPARTMENT_WORDS[token] ?? token}`, TIER_PLACES[tier] ?? tier));
  }
  rows.push(row('Projects with no label', labelKeyShown(doc.labels.defaultLabel, scales)));
  if (doc.exportControl !== undefined) {
    rows.push(row('Export-controlled work', `Rules set for ${doc.exportControl.regimes.map((regime) => COMPARTMENT_WORDS[regime] ?? regime).join(', ')}`));
  }
  if (doc.classification !== undefined) rows.push(...classificationRows(doc.classification, scales));
  return rows;
}

/** Show Policy's words for the classification section (70.1 D-16): counts and levels only, never a rule's description or a code word. */
export const CLASSIFICATION_ROWS_TEXT = Object.freeze({
  rules: 'How labels are proposed',
  systemHigh: 'Highest label this system may hold',
  systemHighNone: 'Not set',
  assistant: "The assistant's proposals",
  trial: 'Trial: it only suggests',
  trialExcept: 'Trial: it only suggests, except at {levels}',
  applied: 'Applied where your organization has set a threshold'
});

function counted(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

function classificationRows(section: NonNullable<PolicyDocument['classification']>, scales: ScaleTable): PolicySectionRow[] {
  const words = CLASSIFICATION_ROWS_TEXT;
  const parts = [
    counted(section.guideRules.length, "rule from your organization's guide", "rules from your organization's guide"),
    counted(section.compilationRules.length, 'combination rule', 'combination rules'),
    counted(section.markings.length, 'marking', 'markings'),
    counted(section.codeWords?.entries.length ?? 0, 'code word', 'code words')
  ];
  const high = section.systemHigh === undefined ? words.systemHighNone : section.systemHigh.map((label) => labelKeyShown(label, scales)).join(', ');
  const mode = section.shadow.defaultMode === 'enforce' ? words.applied
    : section.shadow.levels.length === 0 ? words.trial : words.trialExcept.replace('{levels}', section.shadow.levels.map((key) => labelKeyShown(key, scales)).join(', '));
  return [row(words.rules, parts.join(', ')), row(words.systemHigh, high), row(words.assistant, mode)];
}

function whereRows(doc: PolicyDocument, scales: ScaleTable): PolicySectionRow[] {
  const rows: PolicySectionRow[] = [];
  for (const endpoint of doc.endpoints ?? []) {
    const labels = labelsShown(endpoint.maxLabel, scales);
    rows.push(row(endpoint.host, `${runsOn(endpoint.class, endpoint.region)}, up to ${labels === '' ? 'no label yet' : labels}`));
  }
  if (rows.length === 0) rows.push(row('AI services named in these rules', 'None'));
  if (doc.residency?.required !== undefined) rows.push(row('All work must stay in', regionsShown(doc.residency.required)));
  for (const key of Object.keys(doc.residency?.byLevel ?? {}).sort()) {
    rows.push(row(labelKeyShown(key, scales), `Must stay in ${regionsShown(doc.residency?.byLevel?.[key])}`));
  }
  return rows;
}

function authorizationRows(doc: PolicyDocument): PolicySectionRow[] {
  const rows = (doc.authorizations ?? []).map((envelope) => {
    const body = envelope.payload;
    const withdrawn = body.revokedBy === undefined ? '' : ' (withdrawn)';
    return row(`Allowed by ${body.namedPerson.name}`, `${KIND_WORDS[body.kind] ?? 'An exception'} until ${dateShown(body.expiresAt)}${withdrawn}`);
  });
  return rows.length === 0 ? [row('Exceptions', 'None')] : rows;
}

function agentRows(doc: PolicyDocument): PolicySectionRow[] {
  const rows: PolicySectionRow[] = [];
  for (const context of Object.keys(doc.agents.maxMode)) {
    const mode = (doc.agents.maxMode as Readonly<Record<string, string>>)[context] ?? '';
    rows.push(row(`Most an agent may do ${CONTEXT_WORDS[context] ?? context}`, MODE_WORDS[mode] ?? mode));
  }
  const tools = doc.agents.mcp.unattended;
  rows.push(row('Tools allowed while you are away', tools.length === 0 ? 'None' : tools.join(', ')));
  rows.push(row('Classified work needs an approved computer', doc.agents.requireAccreditedDevice ? 'Yes' : 'No'));
  return rows;
}

function peopleRows(doc: PolicyDocument, scales: ScaleTable): PolicySectionRow[] {
  const rows: PolicySectionRow[] = [];
  const clearances = doc.people?.clearances ?? [];
  if (clearances.length > 0) rows.push(row('Cleared up to', clearances.map((clearance) => labelKeyShown(clearance, scales)).join(', ')));
  const signers = doc.people?.signers ?? [];
  if (signers.length > 0) rows.push(row('People who can allow exceptions', signers.map((signer) => `${signer.name} (${signer.role})`).join(', ')));
  return rows.length === 0 ? [row('People named in these rules', 'None')] : rows;
}

function setupRows(doc: PolicyDocument, scales: ScaleTable): PolicySectionRow[] {
  const onboarding = doc.onboarding;
  if (onboarding === undefined) return [row('Who to ask', 'No one named yet')];
  const rows = onboarding.contacts.map((contact) => row(TOPIC_WORDS[contact.topic] ?? contact.topic, `${contact.name} (${contact.how})`));
  if (rows.length === 0) rows.push(row('Who to ask', 'No one named yet'));
  rows.push(row('Kinds of work offered', onboarding.kindsOfWork.map((kind) => WORK_WORDS[kind] ?? kind).join(', ') || 'None'));
  if (onboarding.locked.canada === true) rows.push(row('Answers set for everyone', 'Must stay in Canada'));
  if (onboarding.defaultScale !== undefined) rows.push(row('Labels offered first', scaleShown(onboarding.defaultScale, scales)));
  const discovery = onboarding.discovery;
  rows.push(row('Finding servers on your network', discovery === undefined || discovery.networks.length === 0
    ? 'Off'
    : `${String(discovery.networks.length)} network${discovery.networks.length === 1 ? '' : 's'} listed`));
  return rows;
}

/** Nano-USD as dollars and cents, by whole-number arithmetic. */
function dollars(nanoUsd: number): string {
  const cents = Math.floor(nanoUsd / 10_000_000);
  return `$${String(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, '0')}`;
}

function limitRows(doc: PolicyDocument): PolicySectionRow[] {
  const spend = doc.limits?.spend;
  const rows: PolicySectionRow[] = [];
  if (spend?.dailyNanoUsd !== undefined) rows.push(row('Daily spend per person', dollars(spend.dailyNanoUsd)));
  if (spend?.vaultHoursPerDay !== undefined) rows.push(row('Hours per day a vault may run', String(spend.vaultHoursPerDay)));
  if (spend?.hubDailyNanoUsd !== undefined) rows.push(row("Daily spend for your organization's server", dollars(spend.hubDailyNanoUsd)));
  return rows.length === 0 ? [row('Spending', 'No limits set')] : rows;
}

/** The rules page's eight sections, read only, in plain words. `reserved` is not shown. */
export function policySections(doc: PolicyDocument, scales: ScaleTable = doc.labels.scales): readonly PolicySectionView[] {
  const rows: Record<PolicySectionId, PolicySectionRow[]> = {
    labels: labelRows(doc, scales),
    'where-ai-runs': whereRows(doc, scales),
    models: [row('Approved models', 'None listed yet')],
    authorizations: authorizationRows(doc),
    agents: agentRows(doc),
    people: peopleRows(doc, scales),
    setup: setupRows(doc, scales),
    limits: limitRows(doc)
  };
  return Object.freeze(POLICY_SECTION_IDS.map((id) => Object.freeze({ id, title: PAGE_TITLES[id], rows: Object.freeze(rows[id]) })));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The exported proposal (D-44): read by your organization's tooling later, so its shape is stable

/** The file an exported proposal is saved as. */
export const PROPOSAL_FILE_EXTENSION = '.near-policy-proposal';

export interface ProposalTarget {
  readonly layer: Extract<PolicyLayerName, 'organization' | 'personal'>;
  /** bundleHash of the rules the proposal was drafted against. */
  readonly hash: string;
  /** The fingerprint of the key that signs those rules. */
  readonly issuer: string;
}

export interface ProposalPayloadChange {
  readonly section: string;
  readonly key: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly direction: ProposalDirection;
}

export interface ProposalPayload {
  readonly v: 1;
  readonly target: ProposalTarget;
  readonly from: string;
  readonly reason?: string;
  readonly changes: readonly ProposalPayloadChange[];
}

export interface ProposalPayloadInput {
  readonly target: ProposalTarget;
  readonly from: string;
  readonly reason?: string;
  readonly changes: readonly ProposalChange[];
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** The first number in `value` that is not a whole, non-negative safe number (D-08), as a path; undefined when there is none. */
function badNumber(value: unknown, path: string): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0) ? undefined : path;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = badNumber(value[index], `${path}[${String(index)}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (isRecord(value)) {
    for (const key of Object.keys(value)) {
      const found = badNumber(value[key], `${path}.${key}`);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function sectionRank(section: string): number {
  const index = (POLICY_SECTIONS as readonly string[]).indexOf(section);
  return index < 0 ? POLICY_SECTIONS.length : index;
}

/**
 * The body of a proposal exported for your organization: `{ v: 1, target, from, reason?, changes }`, each change `{ section, key, before?, after?,
 * direction }` sorted by section then key, absent values left out (never null). The sentence is not part of it: your organization's tooling words the
 * change itself. The signature and the public key travel in the envelope's own `sig` and `publicKey`, never in the body. Throws a PayloadError for a
 * number that is not a whole, non-negative safe number, or a target hash that is not one.
 */
export function proposalPayload(input: ProposalPayloadInput): ProposalPayload {
  if (!HASH_PATTERN.test(input.target.hash)) throw new PayloadError('Nothing was signed: the rules this proposal was made from have no valid hash.');
  const changes = input.changes.map((change): ProposalPayloadChange => ({
    section: change.section,
    key: change.key,
    ...(change.before === undefined ? {} : { before: change.before }),
    ...(change.after === undefined ? {} : { after: change.after }),
    direction: change.direction
  }));
  changes.sort((a, b) => sectionRank(a.section) - sectionRank(b.section) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const payload: ProposalPayload = {
    v: 1,
    target: { layer: input.target.layer, hash: input.target.hash, issuer: input.target.issuer },
    from: input.from,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    changes
  };
  const bad = badNumber(payload, '$');
  if (bad !== undefined) throw new PayloadError(`Nothing was signed: the proposal has a number that is not a whole number of zero or more at ${bad}.`);
  return payload;
}
