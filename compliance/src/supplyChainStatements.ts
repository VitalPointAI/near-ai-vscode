// The generated supply-chain statements (44.1-09, D-14, D-15, D-17, D-18). The supply-chain controls describe the same release and import path
// for every component, so their statements are generated from the component inventory (compliance/resources.json read through inventory.ts,
// never changed here) instead of being written by hand. A statement is written only when the inventory lists resources of that component and
// evidence backs it for that component: a CI test over the whole register for what the register itself proves (each listed resource is
// reviewed and pinned), the offline bundle import's refusal tests for components with an item the bundle carries, or a collector subject of the
// component's own. It names the component's own items with their pins and says only what its rule proves. Hand-written statements and the pairs
// 44.1-HANDOFFS.md reserves for other plans are never touched. Pure: the command reads the files and writes the result.
import { createHash } from 'node:crypto';
import { CHART_LOCK, IMAGE_LOCK, TOOL_PINS } from '../../scripts/resource-check.mjs';
import { mapLevels } from './applicability.ts';
import { cellClass, type CoverageSources } from './coverage.ts';
import type { Inventory, InventoryEntry } from './inventory.ts';
import { NS, type EvidenceRule } from './model.ts';

/** The supply-chain controls of D-15, in the order statements are written. */
export const SUPPLY_CHAIN_CONTROLS = Object.freeze([
  'cm-02', 'cm-02.02', 'cm-02.03', 'cm-08', 'cm-08.01', 'cm-08.04', 'cm-08.06', 'ra-05', 'ra-05.02', 'sa-05', 'sa-22', 'si-02', 'si-02.02', 'si-07',
  'si-07.01', 'sr-03', 'sr-11'
] as const);
/** Every generated statement id ends with this; the generator owns those statements and nothing else. */
export const STATEMENT_SUFFIX = '_smt.inventory';
/** The rule file of the generated statements; the generator writes the whole file. */
export const RULE_FILE = 'compliance/evidence-rules/supply-chain.json';
const SOURCE_CATALOG = 'catalogs/itsp-10-033/catalog.json';

/** Pairs another plan writes by hand (44.1-HANDOFFS.md, "Reserved pairs", restricted to the controls above). Update with the ledger. */
export interface ReservedPairs { readonly plan: string; readonly components: readonly string[]; readonly controls: readonly string[] }
export const RESERVED: readonly ReservedPairs[] = Object.freeze([
  { plan: '48-07', components: ['workbench'], controls: ['cm-02'] },
  { plan: '48-07', components: ['release-pipeline'], controls: ['cm-02', 'cm-08', 'si-07', 'sr-03', 'sr-11'] },
  { plan: '48-08', components: ['keycloak'], controls: ['si-02'] },
  { plan: '48-08', components: ['theia-cloud'], controls: ['sr-03', 'sr-11', 'si-07', 'cm-02'] },
  { plan: '48-08', components: ['image-registry'], controls: ['si-07', 'ra-05', 'cm-08'] },
  { plan: '48.1-18', components: ['offline-bundle'], controls: ['sr-11'] },
  { plan: '44.1-02', components: ['release-pipeline', 'extension'], controls: ['cm-02', 'si-02'] },
  { plan: '74.1-16', components: ['model-endpoints'], controls: ['cm-08', 'sr-03'] },
  { plan: '74.3-14', components: ['model-endpoints'], controls: ['cm-08', 'si-07', 'sr-03'] },
  { plan: '48.2-15', components: ['workbench', 'release-pipeline'], controls: ['cm-02', 'cm-08', 'ra-05', 'ra-05.02', 'si-07', 'si-07.01'] }
]);

/**
 * Which components one piece of evidence backs: `inventory`, every component with resources in the register (a test over the whole register
 * checks each of them); `bundle`, every component with a resource the offline bundle carries; or one component, through a collector subject
 * of its own.
 */
export type EvidenceScope = 'inventory' | 'bundle' | { readonly component: string };
export interface SupplyChainEvidence {
  readonly control: string;
  readonly scope: EvidenceScope;
  readonly rule: Pick<EvidenceRule, 'kind' | 'test' | 'observation'>;
  /** A few words for the requirement's description: what this evidence says about the component. */
  readonly summary: string;
  /** The statement, given the component's title and its items (each with its pin). */
  readonly description: (title: string, items: string) => string;
  /** What your organization does (the statement's remarks). */
  readonly remarks: string;
}

const REGISTER_TEST = { file: 'scripts/test/resource-check.test.mjs', path: [], name: 'the repository itself passes the check, against the real catalogues and components' };
const CHECK = 'The compliance fit check over the whole repository, run as a CI test,';

/** The evidence of the generated statements. The first entry for a control whose scope covers a component backs its statement. */
export const EVIDENCE: readonly SupplyChainEvidence[] = Object.freeze([
  {
    control: 'cm-08', scope: 'inventory', rule: { kind: 'test', test: REGISTER_TEST }, summary: 'the component inventory lists its third-party resources',
    description: (title, items) => `The component inventory (compliance/resources.json) lists these third-party resources for ${title}, each with the pin the repository uses: ${items}. ${CHECK} fails when a resource the repository uses has no reviewed entry, or an entry lists a file that no longer uses it.`,
    remarks: 'Your organization keeps the inventory of what it installs at its site, with its owners, and reconciles it with this list.'
  },
  {
    control: 'sr-03', scope: 'inventory', rule: { kind: 'test', test: REGISTER_TEST }, summary: 'its third-party resources are reviewed and pinned before use',
    description: (title, items) => `These third-party resources of ${title} each have a reviewed register entry with their licence, compliance fit and conditions, and are pinned as the component inventory lists them: ${items}. ${CHECK} fails when one of them has no reviewed entry, is marked as not fitting, or is an image without a sha256 digest or an action without a full commit SHA.`,
    remarks: 'Your organization selects and accepts its suppliers and runs its own supply-chain risk management plan.'
  },
  {
    control: 'si-07', scope: 'bundle', rule: { kind: 'test', test: { file: 'deploy/test/bundle-verify.test.mjs', path: [], name: 'a store item that is missing, extra or has another digest is refused' } },
    summary: 'the offline bundle import refuses a changed item',
    description: (title, items) => `Before anything is copied to the site, the offline bundle import checks every item against the manifest your organization signed and refuses the bundle when an item is missing, extra or has another digest. For ${title} that covers ${items}. A CI test of the import proves the refusal.`,
    remarks: 'Your organization builds and signs each bundle it approves with its own key, and imports only that bundle at its site.'
  },
  {
    control: 'sr-11', scope: 'bundle', rule: { kind: 'test', test: { file: 'deploy/test/bundle-verify.test.mjs', path: [], name: 'a manifest signed with a different key is refused' } },
    summary: 'the offline bundle import accepts only what your organization signed',
    description: (title, items) => `The offline bundle import accepts a bundle only when its manifest verifies with your organization's public key and refuses a bundle signed with any other key, so these items of ${title} reach the site only as your organization signed them: ${items}. A CI test of the import proves the refusal.`,
    remarks: 'Your organization keeps the signing key, signs only the releases it approves, and keeps its own record of each bundle it imports.'
  }
]);

export interface ComponentFile { readonly file: string; readonly text: string }

export interface SupplyChainSources {
  readonly inventory: Inventory;
  /** The tools of compliance/ci/tool-pins.json the offline bundle carries (deploy/bundle/build.mjs SITE_TOOLS). */
  readonly bundleTools: readonly string[];
  readonly componentFiles: readonly ComponentFile[];
  /** True when the applicability map gives the component a part in the control at some level it is assessed at (mapApplicable). */
  readonly applicable: (component: string, control: string) => boolean;
  readonly evidence?: readonly SupplyChainEvidence[];
  readonly reserved?: readonly ReservedPairs[];
}

export interface GeneratedStatement { readonly component: string; readonly control: string; readonly statement: string; readonly rule: string; readonly items: number }
export interface SkippedPair { readonly component: string; readonly control: string; readonly reason: string }
export interface SupplyChainOutput {
  /** Every component file in input order, with its generated part rewritten; a file with nothing to change keeps its text. */
  readonly files: readonly ComponentFile[];
  readonly rules: readonly EvidenceRule[];
  readonly rulesText: string;
  readonly generated: readonly GeneratedStatement[];
  readonly skipped: readonly SkippedPair[];
}

/** A fixed UUID (version 5 form) for one generated part, so the same inputs always give the same bytes. */
function uuidFor(name: string): string {
  const hex = createHash('sha256').update(`near-ai-vscode/supply-chain-statements/${name}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const KIND_WORDS: Readonly<Record<string, string>> = Object.freeze({ npm: 'npm package', vendored: 'vendored library', image: 'image', action: 'action', chart: 'chart', tool: 'tool' });

/** The pins of an entry, restricted to the files given when there are any; several pins each name the files that pin them, as inventory.ts pinText does. */
function pinWords(entry: InventoryEntry, from?: readonly string[]): string {
  const pins = from ? entry.pins.filter((pin) => pin.where.some((file) => from.includes(file))) : entry.pins;
  if (pins.length === 0) return 'not pinned in a lock or manifest';
  return pins.length === 1 ? pins[0].pin : pins.map(({ pin, where }) => `${pin} (${where.join(', ')})`).join(', ');
}

function itemWords(entry: InventoryEntry, from?: readonly string[]): string {
  return `${KIND_WORDS[entry.kind] ?? entry.kind} ${entry.name} ${pinWords(entry, from)}${entry.scope === 'runtime' ? '' : ` (${entry.scope} only)`}`;
}

/** The files the offline bundle carries an entry from: the image lock, the chart lock, or the tool pins for a tool the bundle downloads. */
function bundleFiles(entry: InventoryEntry, bundleTools: readonly string[]): string[] {
  const files = entry.pins.flatMap((pin) => pin.where).filter((file) => file === IMAGE_LOCK || file === CHART_LOCK || (file === TOOL_PINS && entry.kind === 'tool' && bundleTools.includes(entry.name)));
  return [...new Set(files)];
}

/** The items one piece of evidence covers for a component, as text; empty when it covers none. */
function itemsFor(evidence: SupplyChainEvidence, component: string, entries: readonly InventoryEntry[], bundleTools: readonly string[]): string[] {
  if (evidence.scope === 'bundle') return entries.flatMap((entry) => { const files = bundleFiles(entry, bundleTools); return files.length ? [itemWords(entry, files)] : []; });
  if (typeof evidence.scope === 'object' && evidence.scope.component !== component) return [];
  // A test-only resource is not part of the system the component is.
  return entries.filter((entry) => entry.scope !== 'test').map((entry) => itemWords(entry));
}

const list = (items: readonly string[]): string => items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

type Json = Record<string, any>;
const componentId = (component: Json): string => (component.props ?? []).find((prop: Json) => prop.ns === NS && prop.name === 'component-id')?.value ?? '';

/** Generates the supply-chain statements and their rules for every component file. */
export function generate(sources: SupplyChainSources): SupplyChainOutput {
  const evidence = sources.evidence ?? EVIDENCE;
  const reserved = sources.reserved ?? RESERVED;
  const rules: EvidenceRule[] = [];
  const generated: GeneratedStatement[] = [];
  const skipped: SkippedPair[] = [];
  const files = sources.componentFiles.map((file): ComponentFile => {
    const doc = JSON.parse(file.text) as Json;
    let changed = false;
    for (const component of doc['component-definition']?.components ?? []) {
      const id = componentId(component);
      const own = uuidFor(`${id}/control-implementation`);
      const before: Json[] = component['control-implementations'] ?? [];
      const kept = before.filter((implementation) => implementation.uuid !== own);
      const handWritten = new Set(kept.flatMap((implementation) => (implementation['implemented-requirements'] ?? []).map((requirement: Json) => requirement['control-id'])));
      const entries = sources.inventory.entries.filter((entry) => entry.component === id);
      const requirements: Json[] = [];
      for (const control of SUPPLY_CHAIN_CONTROLS) {
        const skip = (reason: string) => { skipped.push({ component: id, control, reason }); };
        if (entries.length === 0) { skip('no entry in the component inventory'); continue; }
        if (!sources.applicable(id, control)) { skip('not applicable on the applicability map'); continue; }
        const holder = reserved.find((pairs) => pairs.components.includes(id) && pairs.controls.includes(control));
        if (holder) { skip(`reserved for ${holder.plan}`); continue; }
        if (handWritten.has(control)) { skip('a hand-written statement covers it'); continue; }
        const backed = evidence.filter((entry) => entry.control === control).map((entry) => ({ entry, items: itemsFor(entry, id, entries, sources.bundleTools) })).find((candidate) => candidate.items.length > 0);
        if (!backed) { skip(entries.every((entry) => entry.scope === 'test') ? 'only test resources in the component inventory' : 'no evidence for this component'); continue; }
        const statement = `${control}${STATEMENT_SUFFIX}`;
        const ruleId = `${id}.${control}.inventory`;
        requirements.push({
          uuid: uuidFor(`${id}/${control}`), 'control-id': control, description: `Generated from the component inventory: ${backed.entry.summary}.`,
          props: [{ name: 'responsibility', ns: NS, value: 'shared' }],
          statements: [{ uuid: uuidFor(`${id}/${control}/statement`), 'statement-id': statement, description: backed.entry.description(component.title, list(backed.items)), remarks: backed.entry.remarks }]
        });
        rules.push({ id: ruleId, component: id, control, statement, ...backed.entry.rule } as EvidenceRule);
        generated.push({ component: id, control, statement, rule: ruleId, items: backed.items.length });
      }
      const after = requirements.length === 0 ? kept : [...kept, {
        uuid: own, source: SOURCE_CATALOG,
        description: 'Supply-chain statements generated from the component inventory. Do not edit by hand: run node compliance/src/cli.ts supply-chain-statements --write.',
        'implemented-requirements': requirements
      }];
      if (JSON.stringify(after) === JSON.stringify(before)) continue;
      changed = true;
      if (after.length === 0) delete component['control-implementations'];
      else component['control-implementations'] = after;
    }
    if (!changed) return file;
    const oneLine = !file.text.trimEnd().includes('\n');
    return { file: file.file, text: `${oneLine ? JSON.stringify(doc) : JSON.stringify(doc, null, 2)}\n` };
  });
  return { files, rules, rulesText: `${JSON.stringify({ rules })}\n`, generated, skipped };
}

/** The differences between the generator's output and the files as they are, one line per file. An absent rule file is undefined. */
export function driftProblems(output: SupplyChainOutput, current: readonly ComponentFile[], rulesText: string | undefined): string[] {
  const problems = output.files.filter((file, index) => file.text !== current[index]?.text)
    .map((file) => `${file.file}: the generated supply-chain statements differ from what the generator gives; run node compliance/src/cli.ts supply-chain-statements --write`);
  if (rulesText !== output.rulesText) problems.push(`${RULE_FILE}: the rules of the generated statements differ from what the generator gives; run node compliance/src/cli.ts supply-chain-statements --write`);
  return problems;
}

/** The applicability test of the generator: the map gives the component a part in the control at some level that assesses both, statements aside. */
export function mapApplicable(sources: CoverageSources): (component: string, control: string) => boolean {
  const silent: CoverageSources = { ...sources, components: [] };
  const levels = mapLevels(sources.levels);
  return (component, control) => levels.some((level) => level.components.includes(component) && level.controls.includes(control) && cellClass(silent, level.id, control, component) === 'applicableWithoutStatement');
}
