// Staff products (design 10, 4.1; UX concept 11 and 12.5; WP-0): product kinds and the renderers they declare, the header at the top of every product
// file, and the fixed markers members write. Pure: no I/O, no clock, no vscode.
//
// A product is a Markdown file at `.planning/staff/products/<section>/<product>.md` that opens with a `---` header block. The header carries the product's identity,
// owner, the profile and level it was written under, its version and release state, its label, the human role it waits on, what it depends on, and the
// gate verdicts on the current version. The header is a projection of the decision log: WP-SHARED compares the two, and a header that claims a state
// the log does not hold reads as tampered. This file only parses and writes the header, strictly.
import { parseIsoMillis } from '../gate/shape';
import { STAFF_LEVELS, STAFF_PROFILE_IDS, STAFF_SECTION_IDS } from './doctrine';
import type { StaffLevel, StaffProfileId, StaffSectionId } from './doctrine';
import {
  isOneLine, isOneOf, ok, parseFlowList, parseFlowMap, parseKeyLine, STAFF_SLUG, staffRefused
} from './parse';
import type { StaffParsed } from './parse';
import { levelOffer } from './profiles';
import { GUARD_VERDICTS, RELEASE_STATES, TRADECRAFT_VERDICTS } from './release';
import type { GuardVerdict, ReleaseState, TradecraftVerdict } from './release';

/** The renderers the Staff Room ships. Every kind renders as a card; some add one more view (UX concept 11, item 2). */
export const PRODUCT_RENDERERS = ['card', 'document', 'table', 'matrix-rows', 'map-layer'] as const;
export type ProductRenderer = (typeof PRODUCT_RENDERERS)[number];

/** Product kinds. A kind picks the renderer; a section only emits data (UX concept 11, item 2; 12.5). */
export const PRODUCT_KINDS = [
  'estimate', 'adversary-coa-set', 'coa-statement', 'register', 'matrix', 'map-layer', 'annex', 'order', 'report', 'brief', 'critique', 'plan'
] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

export const PRODUCT_KIND_RENDERERS: Readonly<Record<ProductKind, readonly ProductRenderer[]>> = {
  estimate: ['card', 'document'],
  'adversary-coa-set': ['card', 'map-layer'],
  'coa-statement': ['card', 'map-layer', 'document'],
  register: ['card', 'table'],
  matrix: ['card', 'matrix-rows'],
  'map-layer': ['card', 'map-layer'],
  annex: ['card', 'document'],
  order: ['card', 'document'],
  report: ['card', 'document'],
  brief: ['card', 'document'],
  critique: ['card', 'document'],
  plan: ['card', 'document']
};

/** A gate verdict on one version, as the header records it: the verdict, when, and the report file the gate wrote. */
export interface HeaderVerdict<V extends string> { readonly verdict: V; readonly at: string; readonly report: string }

export interface ProductDependency { readonly product: string; readonly version: number }

export interface ProductHeader {
  readonly product: string;
  readonly kind: ProductKind;
  readonly section: StaffSectionId;
  /** The owning member's slug: the product's only writer. */
  readonly owner: string;
  /** The profile and level the product was written under, so an approved product is never silently renamed when the settings change. */
  readonly profile: StaffProfileId;
  readonly level: StaffLevel;
  readonly version: number;
  readonly state: ReleaseState;
  /** The label from the Phase 70 label map, as `scale/level` (for example `org/Internal`). */
  readonly label: string;
  /** The human role the product waits on; the named person is recorded on approval. */
  readonly decisionFor?: string;
  readonly dependsOn: readonly ProductDependency[];
  readonly guard?: HeaderVerdict<GuardVerdict>;
  readonly tradecraft?: HeaderVerdict<TradecraftVerdict>;
}

/** The header keys in the order they are written. */
export const PRODUCT_HEADER_KEYS = ['product', 'kind', 'section', 'owner', 'profile', 'level', 'version', 'state', 'label', 'decision_for', 'depends_on', 'guard', 'tradecraft'] as const;
const REQUIRED_HEADER_KEYS = ['product', 'kind', 'section', 'owner', 'profile', 'level', 'version', 'state', 'label'] as const;

/** States past the guard: the header must carry a CLEARED guard verdict. */
const CLEARED_STATES: readonly ReleaseState[] = ['guard-checked', 'awaiting-decision', 'approved', 'rejected', 'released', 'superseded'];
/** States that wait on, or follow, a person's decision: the header must name the role. */
const DECISION_STATES: readonly ReleaseState[] = ['awaiting-decision', 'approved', 'rejected', 'released', 'superseded'];

export const LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}\/[A-Za-z0-9][A-Za-z0-9 ]{0,39}$/;
/** A report path: relative, forward slashes, plain characters, no `.` or `..` segment. */
const REPORT_PATH = /^(?!\/)(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9._/-]{1,200}$/;
const DEPENDENCY = /^([a-z0-9][a-z0-9-]{0,63})@([1-9][0-9]{0,5})$/;
export const MAX_VERSION = 999_999;

/** The `---` header block at the top of a product file, and the body after it; undefined when the file does not open with one. */
export function splitProductFile(text: string): { header: string; body: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  return match ? { header: match[1], body: text.slice(match[0].length) } : undefined;
}

/** Reads a product file's header strictly: every field checked, unknown and repeated fields refused, and the state consistent with the verdicts. */
export function parseProductFile(text: string): StaffParsed<{ header: ProductHeader; body: string }> {
  const parts = splitProductFile(text);
  if (!parts) return staffRefused('missing-field', 'header');
  const header = parseProductHeader(parts.header);
  return header.ok ? ok({ header: header.value, body: parts.body }) : header;
}

/** Reads the inside of a product header block (without the `---` lines). */
export function parseProductHeader(block: string): StaffParsed<ProductHeader> {
  const raw = new Map<string, string>();
  const lines = block.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const pair = parseKeyLine(line);
    if (!pair) return staffRefused('bad-syntax', `header.line${index + 1}`);
    if (!(PRODUCT_HEADER_KEYS as readonly string[]).includes(pair.key)) return staffRefused('unknown-field', pair.key);
    if (raw.has(pair.key)) return staffRefused('duplicate-field', pair.key);
    raw.set(pair.key, pair.value);
  }
  for (const key of REQUIRED_HEADER_KEYS) if (!raw.get(key)) return staffRefused('missing-field', key);
  const get = (key: string): string => raw.get(key) as string;

  const product = get('product');
  if (!STAFF_SLUG.test(product)) return staffRefused('wrong-type', 'product');
  const kind = get('kind');
  if (!isOneOf(PRODUCT_KINDS, kind)) return staffRefused('unknown-value', 'kind');
  const section = get('section');
  if (!isOneOf(STAFF_SECTION_IDS, section)) return staffRefused('unknown-value', 'section');
  const owner = get('owner');
  if (!STAFF_SLUG.test(owner)) return staffRefused('wrong-type', 'owner');
  const profile = get('profile');
  if (!isOneOf(STAFF_PROFILE_IDS, profile)) return staffRefused('unknown-value', 'profile');
  const level = get('level');
  if (!isOneOf(STAFF_LEVELS, level)) return staffRefused('unknown-value', 'level');
  if (!levelOffer(profile, level).offered) return staffRefused('not-offered', 'level');
  const versionText = get('version');
  if (!/^[1-9][0-9]{0,5}$/.test(versionText)) return staffRefused('wrong-type', 'version');
  const version = Number(versionText);
  const state = get('state');
  if (!isOneOf(RELEASE_STATES, state)) return staffRefused('unknown-value', 'state');
  const label = get('label');
  if (!LABEL_PATTERN.test(label)) return staffRefused('wrong-type', 'label');

  let decisionFor: string | undefined;
  if (raw.has('decision_for')) {
    const value = get('decision_for');
    if (!isOneLine(value, 80)) return staffRefused('wrong-type', 'decision_for');
    decisionFor = value;
  }
  const dependsOn: ProductDependency[] = [];
  if (raw.has('depends_on')) {
    const list = parseFlowList(get('depends_on'));
    if (!list) return staffRefused('wrong-type', 'depends_on');
    for (let index = 0; index < list.length; index += 1) {
      const match = DEPENDENCY.exec(list[index]);
      if (!match) return staffRefused('wrong-type', `depends_on[${index}]`);
      if (match[1] === product) return staffRefused('not-allowed-here', `depends_on[${index}]`);
      if (dependsOn.some((entry) => entry.product === match[1])) return staffRefused('duplicate-entry', `depends_on[${index}]`);
      dependsOn.push({ product: match[1], version: Number(match[2]) });
    }
  }
  const guard = raw.has('guard') ? parseVerdict(get('guard'), 'guard', GUARD_VERDICTS) : undefined;
  if (guard && !guard.ok) return guard;
  const tradecraft = raw.has('tradecraft') ? parseVerdict(get('tradecraft'), 'tradecraft', TRADECRAFT_VERDICTS) : undefined;
  if (tradecraft && !tradecraft.ok) return tradecraft;

  if (CLEARED_STATES.includes(state) && guard?.value.verdict !== 'CLEARED') return staffRefused('missing-field', 'guard');
  if (DECISION_STATES.includes(state) && decisionFor === undefined) return staffRefused('missing-field', 'decision_for');

  return ok({
    product, kind, section, owner, profile, level, version, state, label,
    ...(decisionFor !== undefined ? { decisionFor } : {}),
    dependsOn,
    ...(guard ? { guard: guard.value } : {}),
    ...(tradecraft ? { tradecraft: tradecraft.value } : {})
  });
}

function parseVerdict<V extends string>(text: string, key: string, verdicts: readonly V[]): StaffParsed<HeaderVerdict<V>> {
  const pairs = parseFlowMap(text);
  if (!pairs) return staffRefused('wrong-type', key);
  const fields = new Map<string, string>();
  for (const [name, value] of pairs) {
    if (name !== 'verdict' && name !== 'at' && name !== 'report') return staffRefused('unknown-field', `${key}.${name}`);
    if (fields.has(name)) return staffRefused('duplicate-field', `${key}.${name}`);
    fields.set(name, value);
  }
  for (const name of ['verdict', 'at', 'report']) if (!fields.has(name)) return staffRefused('missing-field', `${key}.${name}`);
  const verdict = fields.get('verdict') as string;
  if (!isOneOf(verdicts, verdict)) return staffRefused('unknown-value', `${key}.verdict`);
  const at = fields.get('at') as string;
  if (Number.isNaN(parseIsoMillis(at))) return staffRefused('wrong-type', `${key}.at`);
  const report = fields.get('report') as string;
  if (!REPORT_PATH.test(report)) return staffRefused('wrong-type', `${key}.report`);
  return ok({ verdict, at, report });
}

/** The header block, `---` lines included, in the fixed key order. `parseProductHeader` reads it back to the same header. */
export function renderProductHeader(header: ProductHeader): string {
  const verdict = (value: HeaderVerdict<string>): string => `{ verdict: ${value.verdict}, at: ${value.at}, report: ${value.report} }`;
  return [
    '---',
    `product: ${header.product}`,
    `kind: ${header.kind}`,
    `section: ${header.section}`,
    `owner: ${header.owner}`,
    `profile: ${header.profile}`,
    `level: ${header.level}`,
    `version: ${header.version}`,
    `state: ${header.state}`,
    `label: ${header.label}`,
    ...(header.decisionFor !== undefined ? [`decision_for: ${header.decisionFor}`] : []),
    `depends_on: [${header.dependsOn.map((entry) => `${entry.product}@${entry.version}`).join(', ')}]`,
    ...(header.guard ? [`guard: ${verdict(header.guard)}`] : []),
    ...(header.tradecraft ? [`tradecraft: ${verdict(header.tradecraft)}`] : []),
    '---',
    ''
  ].join('\n');
}

/** The marker words members write, matched exactly by the guard and the read models (design 10, 3.1, 4.2, 7). */
export const STAFF_MARKERS = {
  decisionFor: 'DECISION FOR:',
  waitingOn: 'WAITING ON',
  legalReview: 'LEGAL REVIEW REQUIRED',
  surgeonReview: 'SURGEON REVIEW REQUIRED'
} as const;

/**
 * Coherence review S5 (owner decision Q3): staff teams are marked private, and every private model NEAR AI offers today comes from developers in the
 * People's Republic of China, which provenance rules forbid for operational work. Said where a staff team is set up (the setup's model step and its last
 * message), in the team file's "Private models only" rule, once in each chat that runs a staff team, and in README and SECURITY.md. It changes no routing.
 */
export const STAFF_PRIVATE_MODELS_TEXT =
  "The private models NEAR AI offers today come from developers in the People's Republic of China. Use this team only on fictional or exercise material until your organization approves a model for operational work.";

/**
 * The four lines every staff member's instructions open with (design 10, 3.1). Kept short, and the same for every section, so a template only adds
 * what is its own.
 */
export const STAFF_MEMBER_PREAMBLE: readonly string[] = [
  'Read .planning/staff/PROFILE.md first (profile, level, nation, vocabulary, annex letters, horizons). Use its terms only.',
  'Exercise and fictional data only. Never load or write classified material, real unit identifiers or current-operations content. Stop and report if you see any.',
  `You recommend; a named human decides. Mark every decision you identify as \`${STAFF_MARKERS.decisionFor} <role of the human>\` with options and risk. Never write "approved", "selected" or "released" about your own work.`,
  `Your area is the files listed under "Owns". Propose changes to anyone else's product as an entry in .planning/staff/proposals/, never by editing it. If you are waiting on another section, write \`${STAFF_MARKERS.waitingOn} <section>: <what>\` and carry on with what does not depend on it.`
];

/** The preamble as the numbered block that opens a member's instructions. */
export function staffPreambleText(): string {
  return STAFF_MEMBER_PREAMBLE.map((line, index) => `${index + 1}. ${line}`).join('\n');
}
