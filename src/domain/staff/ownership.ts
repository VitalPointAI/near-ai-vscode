// Shared products and their single writers (design 10, 4.3; WP-0). Pure: no I/O, no clock, no vscode.
//
// Every shared product has exactly one writer at any moment. The writer can depend on the run's phase (planning or execution: the synchronization matrix
// passes from the J5 to the J3 at transition) and on the mode (a full staff, or one section team on its own: the battle rhythm calendar is the chief of
// staff's in a full staff and the J3 JOC chief's in a standalone J3). A product with parts (the CCIR register) names one writer per part. Everyone else
// proposes entries in `.planning/staff/proposals/<product>/` and the writer merges.
import type { StaffSectionId } from './doctrine';
import type { ProductKind } from './products';

export type StaffPhase = 'planning' | 'execution';
export type StaffMode = 'full-staff' | 'standalone';
export const STAFF_PHASES: readonly StaffPhase[] = ['planning', 'execution'];
export const STAFF_MODES: readonly StaffMode[] = ['full-staff', 'standalone'];

/** A writer: a section and the member slug in that section's template. */
export interface StaffWriter { readonly section: StaffSectionId; readonly member: string }

/** One rule: this writer, in this phase and mode (`any` matches both). */
export interface OwnerRule { readonly phase: StaffPhase | 'any'; readonly mode: StaffMode | 'any'; readonly writer: StaffWriter }

export interface SharedProduct {
  readonly product: string;
  readonly kind: ProductKind;
  readonly owners: readonly OwnerRule[];
  /** Parts with a writer of their own; a write to a part goes to that part's writer, not the product's. */
  readonly parts?: Readonly<Record<string, StaffWriter>>;
  /** Who contributes by proposal (sections, or one member of a section). */
  readonly contributors: readonly StaffWriter[] | 'all';
  readonly note?: string;
}

const W = (section: StaffSectionId, member: string): StaffWriter => ({ section, member });
const ALWAYS = (writer: StaffWriter): OwnerRule[] => [{ phase: 'any', mode: 'any', writer }];
/** Contributors named by section only. */
const SECTION = (section: StaffSectionId): StaffWriter => ({ section, member: '*' });

export const SHARED_PRODUCTS: readonly SharedProduct[] = [
  { product: 'cop', kind: 'map-layer', owners: ALWAYS(W('j3', 'joc-chief')), contributors: [W('j2', 'threat-analyst'), W('j2', 'geoint-analyst'), W('j4', 'jloc-chief'), W('j5', 'lead-planner')], note: 'The published picture: the JOC chief merges the layers. The plans layer never merges into it.' },
  { product: 'cop-operations-layer', kind: 'map-layer', owners: ALWAYS(W('j3', 'joc-chief')), contributors: [SECTION('j3')] },
  { product: 'cop-threat-layer', kind: 'map-layer', owners: ALWAYS(W('j2', 'threat-analyst')), contributors: [W('j2', 'geoint-analyst'), W('j2', 'watch-officer')] },
  { product: 'cop-terrain-layer', kind: 'map-layer', owners: ALWAYS(W('j2', 'geoint-analyst')), contributors: [W('j2', 'jipoe-analyst')] },
  { product: 'cop-logistics-layer', kind: 'map-layer', owners: ALWAYS(W('j4', 'jloc-chief')), contributors: [SECTION('j4')] },
  { product: 'cop-plans-layer', kind: 'map-layer', owners: ALWAYS(W('j5', 'lead-planner')), contributors: [W('j5', 'coa-cell-a'), W('j5', 'coa-cell-b')] },
  {
    product: 'ccir-register', kind: 'register', owners: ALWAYS(W('j3', 'j3-director')),
    parts: { pir: W('j2', 'requirements-manager'), ffir: W('j3', 'j3-director') },
    contributors: [W('j4', 'j4-director')], note: 'The commander approves it through the release state machine.'
  },
  {
    product: 'sync-matrix', kind: 'matrix',
    owners: [{ phase: 'planning', mode: 'any', writer: W('j5', 'lead-planner') }, { phase: 'execution', mode: 'any', writer: W('j3', 'future-ops-planner') }],
    contributors: 'all', note: 'The plans-writer records it during planning. Transition is a recorded event.'
  },
  {
    product: 'dst-dsm', kind: 'matrix',
    owners: [{ phase: 'planning', mode: 'any', writer: W('j5', 'lead-planner') }, { phase: 'execution', mode: 'any', writer: W('j3', 'future-ops-planner') }],
    contributors: [W('j2', 'threat-analyst'), W('j4', 'log-plans-officer')], note: 'The DSM becomes the JOC trigger table.'
  },
  { product: 'rfi-tracker', kind: 'register', owners: ALWAYS(W('j3', 'liaison-coordinator')), parts: { intelligence: W('j2', 'requirements-manager') }, contributors: 'all' },
  {
    product: 'assessment-plan', kind: 'plan',
    owners: [{ phase: 'planning', mode: 'any', writer: W('j5', 'design-planner') }, { phase: 'execution', mode: 'any', writer: W('j3', 'assessment-analyst') }],
    contributors: [SECTION('j2')], note: 'Annex N (Assessments) under US Joint; the six operation assessment steps of JP 5-0 (2025) appendix H.'
  },
  { product: 'facts-assumptions-ledger', kind: 'register', owners: ALWAYS(W('j5', 'lead-planner')), contributors: 'all' },
  { product: 'annex-tracker', kind: 'register', owners: ALWAYS(W('j5', 'plans-writer')), contributors: 'all', note: 'Letters come from the profile.' },
  {
    product: 'battle-rhythm-calendar', kind: 'register',
    owners: [{ phase: 'any', mode: 'full-staff', writer: W('command', 'chief-of-staff') }, { phase: 'any', mode: 'standalone', writer: W('j3', 'joc-chief') }],
    contributors: [SECTION('j4'), SECTION('j2')]
  }
];

export function sharedProduct(product: string): SharedProduct | undefined {
  return SHARED_PRODUCTS.find((entry) => entry.product === product);
}

/**
 * The one writer of a shared product (or of one of its parts) in a phase and mode, or undefined for a product or part that is not shared. Throws when the
 * table names no writer or more than one for that phase and mode: the tests prove that never happens, and a broken table must never pick one silently.
 */
export function writerOf(product: string, context: { readonly phase: StaffPhase; readonly mode: StaffMode }, part?: string): StaffWriter | undefined {
  const entry = sharedProduct(product);
  if (!entry) return undefined;
  if (part !== undefined) return entry.parts && Object.prototype.hasOwnProperty.call(entry.parts, part) ? entry.parts[part] : undefined;
  const matches = entry.owners.filter((rule) => (rule.phase === 'any' || rule.phase === context.phase) && (rule.mode === 'any' || rule.mode === context.mode));
  if (matches.length !== 1) throw new Error(`Shared product ${product} has ${matches.length} writers in ${context.phase} (${context.mode}).`);
  return matches[0].writer;
}

/** Whether `writer` may write the product (or the part) directly. Anyone else proposes. */
export function mayWrite(product: string, writer: StaffWriter, context: { readonly phase: StaffPhase; readonly mode: StaffMode }, part?: string): boolean {
  const owner = writerOf(product, context, part);
  return owner !== undefined && owner.section === writer.section && owner.member === writer.member;
}

/** Where proposals for a shared product go. */
export function proposalFolder(product: string): string {
  return `.planning/staff/proposals/${product}/`;
}
