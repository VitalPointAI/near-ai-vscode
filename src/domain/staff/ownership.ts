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

/**
 * A writer: a section and the member slug in that section's full roster. A smaller roster folds members together (a strategic J2 has no geoint-analyst, a
 * brigade S2 has an ipb-analyst for the whole of IPB): `folds` names, in order, the members that hold the job in a roster without `member`, so each
 * roster the templates render has exactly one writer (writerIn).
 */
export interface StaffWriter { readonly section: StaffSectionId; readonly member: string; readonly folds?: readonly string[] }

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

const W = (section: StaffSectionId, member: string, folds?: readonly string[]): StaffWriter => ({ section, member, ...(folds ? { folds } : {}) });
const ALWAYS = (writer: StaffWriter): OwnerRule[] => [{ phase: 'any', mode: 'any', writer }];
/** Contributors named by section only. */
const SECTION = (section: StaffSectionId): StaffWriter => ({ section, member: '*' });

/** Who keeps the PIRs where a roster has no requirements-manager: the brigade's collection-manager, then the battalion's s2-lead. */
const J2_REQUIREMENTS_FOLDS = ['collection-manager', 's2-lead'];
/** The J3 at tactical level: the s3-lead integrates and the current-ops-chief runs the command post (design 10, 3.4 level variants). */
const J3_DIRECTOR = (): StaffWriter => W('j3', 'j3-director', ['s3-lead']);
const J3_CURRENT_OPS = (): StaffWriter => W('j3', 'joc-chief', ['current-ops-chief']);

export const SHARED_PRODUCTS: readonly SharedProduct[] = [
  { product: 'cop', kind: 'map-layer', owners: ALWAYS(J3_CURRENT_OPS()), contributors: [W('j2', 'threat-analyst'), W('j2', 'geoint-analyst'), W('j4', 'jloc-chief'), W('j5', 'lead-planner')], note: 'The published picture: the JOC chief merges the layers. The plans layer never merges into it.' },
  { product: 'cop-operations-layer', kind: 'map-layer', owners: ALWAYS(J3_CURRENT_OPS()), contributors: [SECTION('j3')] },
  { product: 'cop-threat-layer', kind: 'map-layer', owners: ALWAYS(W('j2', 'threat-analyst', ['ipb-analyst'])), contributors: [W('j2', 'geoint-analyst'), W('j2', 'watch-officer')] },
  { product: 'cop-terrain-layer', kind: 'map-layer', owners: ALWAYS(W('j2', 'geoint-analyst', ['jipoe-analyst', 'ipb-analyst'])), contributors: [W('j2', 'jipoe-analyst')] },
  { product: 'cop-logistics-layer', kind: 'map-layer', owners: ALWAYS(W('j4', 'jloc-chief')), contributors: [SECTION('j4')] },
  { product: 'cop-plans-layer', kind: 'map-layer', owners: ALWAYS(W('j5', 'lead-planner')), contributors: [W('j5', 'coa-cell-a'), W('j5', 'coa-cell-b')] },
  {
    product: 'ccir-register', kind: 'register', owners: ALWAYS(J3_DIRECTOR()),
    parts: { pir: W('j2', 'requirements-manager', J2_REQUIREMENTS_FOLDS), ffir: J3_DIRECTOR() },
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
  { product: 'rfi-tracker', kind: 'register', owners: ALWAYS(W('j3', 'liaison-coordinator')), parts: { intelligence: W('j2', 'requirements-manager', J2_REQUIREMENTS_FOLDS) }, contributors: 'all' },
  {
    product: 'assessment-plan', kind: 'plan',
    owners: [{ phase: 'planning', mode: 'any', writer: W('j5', 'design-planner') }, { phase: 'execution', mode: 'any', writer: W('j3', 'assessment-analyst') }],
    contributors: [SECTION('j2')], note: 'Annex N (Assessments) under US Joint; the six operation assessment steps of JP 5-0 (2025) appendix H.'
  },
  { product: 'facts-assumptions-ledger', kind: 'register', owners: ALWAYS(W('j5', 'lead-planner')), contributors: 'all' },
  { product: 'annex-tracker', kind: 'register', owners: ALWAYS(W('j5', 'plans-writer')), contributors: 'all', note: 'Letters come from the profile.' },
  {
    product: 'battle-rhythm-calendar', kind: 'register',
    owners: [{ phase: 'any', mode: 'full-staff', writer: W('command', 'chief-of-staff') }, { phase: 'any', mode: 'standalone', writer: J3_CURRENT_OPS() }],
    contributors: [SECTION('j4'), SECTION('j2')]
  },
  {
    product: 'event-log', kind: 'register', owners: ALWAYS(J3_CURRENT_OPS()), contributors: [SECTION('j3'), W('j2', 'watch-officer'), W('j4', 'jloc-chief')],
    note: 'The operations centre\'s log: watch officers propose entries (they have no Write); the JOC chief merges them.'
  }
];

/**
 * The product whose approval by a person moves the staff from planning to execution: the transition brief, accepted by the human J3 (design 10, 3.4
 * step 7; JP 5-0, 2025: transition between future plans, future operations and current operations is made through a transition brief). The phase is
 * read from the decision log, so it is a recorded, signed act and never an agent's.
 */
export const TRANSITION_PRODUCT = 'transition-brief';

/** The phase a project is in: execution once a person has approved any version of the transition brief, planning until then. */
export function phaseFrom(transition: { readonly approvedVersions: readonly number[] } | undefined): StaffPhase {
  return transition && transition.approvedVersions.length > 0 ? 'execution' : 'planning';
}

/**
 * Whether a shared product changes writer at transition: its table names one writer for planning and another for execution (the synchronization matrix,
 * the DST and DSM, the assessment plan pass from the J5 to the J3). Checked in either mode, so a full staff and a standalone section team agree.
 */
export function handsOverAtTransition(product: string): boolean {
  const entry = sharedProduct(product);
  if (!entry) return false;
  return STAFF_MODES.some((mode) => {
    const planning = tableWriter(entry, { phase: 'planning', mode });
    const execution = tableWriter(entry, { phase: 'execution', mode });
    return planning !== undefined && execution !== undefined && (planning.section !== execution.section || planning.member !== execution.member);
  });
}

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
  const writer = tableWriter(entry, context, part);
  return writer && { section: writer.section, member: writer.member };
}

/** The table's writer with its folds. */
function tableWriter(entry: SharedProduct, context: { readonly phase: StaffPhase; readonly mode: StaffMode }, part?: string): StaffWriter | undefined {
  if (part !== undefined) return entry.parts && Object.prototype.hasOwnProperty.call(entry.parts, part) ? entry.parts[part] : undefined;
  const matches = entry.owners.filter((rule) => (rule.phase === 'any' || rule.phase === context.phase) && (rule.mode === 'any' || rule.mode === context.mode));
  if (matches.length !== 1) throw new Error(`Shared product ${entry.product} has ${matches.length} writers in ${context.phase} (${context.mode}).`);
  return matches[0].writer;
}

/**
 * The writer resolved for one section team's roster: the named member when the roster has it, else the first of its folds the roster has. For a writer in
 * another section, or a roster with none of them, the table's member is returned unchanged (the writer is not in this team).
 */
export function resolveWriter(writer: StaffWriter, section: StaffSectionId, roster: readonly string[] | undefined): StaffWriter {
  if (!roster || writer.section !== section || roster.includes(writer.member)) return { section: writer.section, member: writer.member };
  const fold = writer.folds?.find((member) => roster.includes(member));
  return { section: writer.section, member: fold ?? writer.member };
}

/** writerOf, resolved for a section team's roster (its members' slugs). */
export function writerIn(product: string, context: { readonly phase: StaffPhase; readonly mode: StaffMode }, team: { readonly section: StaffSectionId; readonly members: readonly string[] }, part?: string): StaffWriter | undefined {
  const entry = sharedProduct(product);
  const writer = entry && tableWriter(entry, context, part);
  return writer && resolveWriter(writer, team.section, team.members);
}

/**
 * Whether `writer` may write the product (or the part) directly. Anyone else proposes. With the writer's roster, a member that holds a folded job (the
 * brigade ipb-analyst for the threat layer) is the writer.
 */
export function mayWrite(product: string, writer: StaffWriter, context: { readonly phase: StaffPhase; readonly mode: StaffMode }, part?: string, roster?: readonly string[]): boolean {
  const entry = sharedProduct(product);
  const table = entry && tableWriter(entry, context, part);
  if (table === undefined) return false;
  const owner = resolveWriter(table, writer.section, roster);
  return owner.section === writer.section && owner.member === writer.member;
}

/** Where proposals for a shared product go. */
export function proposalFolder(product: string): string {
  return `.planning/staff/proposals/${product}/`;
}
