// The J4 section's products (design 10, 3.5 and 4.3; research note 03, B7 to B10; WP-J4): each product's kind, title, required headings, the step it is
// first drafted in, whether the profile and nation carry it, and its one owning member in each roster variant. Members write products at
// .planning/staff/products/j4/<product>.md with the header of src/domain/staff/products.ts; the logistics layer is GeoJSON written through the cop-map tool
// and the LOGSTAT validation log through the logistics server.
//
// Every number in a J4 product traces to a calculator record: the line that holds the number cites `calc:<id>`, the id of the record the consumption
// calculator kept under .planning/staff/calculator/ (design 10, 4.2; the convention guard-scan enforces). j4NumberTrace runs that check on a product body.
// Pure: no I/O, no clock, no vscode.
import { CORE_LOGISTICS_FUNCTIONS } from '../../domain/staff/doctrine';
import type { CrosswalkStep } from '../../domain/staff/doctrine';
import { guardScan } from '../../domain/staff/guardScan';
import type { GuardFinding } from '../../domain/staff/guardScan';
import type { ProductKind } from '../../domain/staff/products';
import { STAFF_FOLDER, staffGuardFolder, staffProductPath } from '../../domain/staff/writeLimits';
import type { J4Variant, J4Vocabulary } from './j4Vocabulary';

/** Where the consumption calculator keeps its records, one JSON file per record (`<id>.json`), the folder guard-scan reads (src/staff/staffHost.ts). */
export const CALCULATOR_FOLDER = `${STAFF_FOLDER}/calculator/`;
/** The heading every product with numbers carries: each calc:<id> the product cites, with what it computed. */
export const CALC_RECORDS_HEADING = 'Calculator records used';

export interface J4Product {
  readonly id: string;
  readonly kind: ProductKind;
  readonly title: (v: J4Vocabulary) => string;
  /** The headings the product must carry, in order (a Markdown heading, or a column of the product's table). Empty for a map layer. */
  readonly headings: (v: J4Vocabulary) => readonly string[];
  /** The crosswalk step it is first drafted in. */
  readonly step: CrosswalkStep;
  readonly owners: Readonly<Partial<Record<J4Variant, string>>>;
  /** Whether the profile and nation carry the product at all (the NATO/Canadian movements annex, the Canadian weekly reports). */
  readonly when?: (v: J4Vocabulary) => boolean;
  /** How it is written when not by Write: through a tool. */
  readonly through?: string;
}

const ALL = (member: string): Record<J4Variant, string> => ({ strategic: member, operational: member, tactical: member });
const CHIEF = { strategic: 'j4-director', operational: 'j4-director', tactical: 's4-lead' } as const;
/** The logistics plans officer's work, which the tactical roster folds into the section's integrator (design 10, 3.5 level variants). */
const PLANS = { strategic: 'log-plans-officer', operational: 'log-plans-officer', tactical: 's4-lead' } as const;
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const lowerFirst = (text: string) => (/^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text);

export const J4_PRODUCTS: readonly J4Product[] = [
  {
    id: 'logistics-overview', kind: 'report', step: 1, owners: PLANS,
    title: (v) => v.overview,
    headings: () => ['Force list and tasks', 'Infrastructure: ports, airfields, roads and rail', 'Host-nation and partner support', 'Stocks and lines of communication', 'Known constraints', 'Gaps and requests', CALC_RECORDS_HEADING]
  },
  {
    id: 'logistics-estimate', kind: 'estimate', step: 2, owners: PLANS,
    title: (v) => v.estimate,
    headings: (v) => ['Mission and the commander\'s priorities for support', `${capital(lowerFirst(v.function))} situation by function`, 'Constraints and critical shortfalls', 'Assumptions', 'Requirements by course of action and phase', 'Logistics information requirements', 'Conclusions', CALC_RECORDS_HEADING]
  },
  {
    id: 'logistics-running-estimate', kind: 'estimate', step: 2, owners: CHIEF,
    title: (v) => `${capital(lowerFirst(v.function))} running estimate`,
    headings: () => ['Situation', 'Facts and assumptions', 'Status by function', 'Supportability of each course of action', 'Shortfalls and sustainment risk', 'Recommendations and decisions for people', CALC_RECORDS_HEADING]
  },
  {
    id: 'coa-supportability', kind: 'register', step: 3, owners: PLANS,
    title: () => 'Supportability of each course of action',
    headings: () => ['Course of action', 'Function', 'Judgement', 'Where and when support runs out', 'Calculator record']
  },
  {
    id: 'logistics-wargame', kind: 'matrix', step: 4, owners: PLANS,
    title: () => 'Logistics war game: consumption per course of action and phase',
    headings: () => ['Course of action', 'Phase', 'Consumption by class of supply', 'Distribution timeline', 'Logistics decision point', 'Calculator record']
  },
  {
    id: 'logistics-decision-points', kind: 'register', step: 4, owners: PLANS,
    title: () => 'Logistics decision points',
    headings: () => ['Decision point', 'Indicator', 'Latest time to decide', 'Options and risk', 'Who decides', 'Calculator record']
  },
  {
    id: 'logistics-comparison', kind: 'register', step: 5, owners: CHIEF,
    title: () => 'Logistics criteria scores',
    headings: () => ['Criterion', 'Course of action', 'Score', 'Reason', 'Calculator record']
  },
  {
    id: 'sustainment-risk-brief', kind: 'brief', step: 6, owners: CHIEF,
    title: () => 'Sustainment risk brief',
    headings: () => ['Sustainment risk by course of action', 'Where each course of action would culminate for lack of support', 'Decisions for people', CALC_RECORDS_HEADING]
  },
  {
    id: 'concept-of-support', kind: 'plan', step: 7, owners: CHIEF,
    title: (v) => v.conceptOfSupport,
    headings: (v) => ['Purpose and priorities of support', 'Support by phase', 'Lines of communication and nodes', ...(v.linesOfSupport.length ? ['Lines of support'] : []), 'Support by function', 'Sustainment risk and mitigation', CALC_RECORDS_HEADING]
  },
  {
    id: 'logistics-annex', kind: 'annex', step: 7, owners: CHIEF,
    title: (v) => v.annex,
    headings: () => ['Situation', 'Mission', 'Concept of support', 'Tasks to subordinate and supporting units', 'Coordinating instructions', 'Appendices and their owners', CALC_RECORDS_HEADING]
  },
  {
    id: 'movements-annex', kind: 'annex', step: 7, owners: { strategic: 'mobility-planner', operational: 'mobility-planner', tactical: 'mobility-planner' },
    when: (v) => v.movementsAnnex !== undefined,
    title: (v) => v.movementsAnnex ?? '',
    headings: () => ['Situation', 'Movement concept', 'Movement control', 'Routes and priorities', 'Coordinating instructions', CALC_RECORDS_HEADING]
  },
  {
    id: 'logstat', kind: 'register', step: 8, owners: ALL('jloc-chief'),
    title: (v) => `${v.logstat.report}, consolidated`,
    headings: (v) => ['Reporting unit', 'Commodity', ...v.logstat.fields, `Forecast to ${v.logstat.forecastHours} hours`, 'Validation', 'Calculator record']
  },
  {
    id: 'weekly-logistics-report', kind: 'report', step: 8, owners: { strategic: 'jloc-chief', operational: 'jloc-chief' },
    when: (v) => v.canadianReports,
    title: (v) => v.reports.weekly,
    headings: () => ['Period', 'Logistics situation', 'Supply by class', 'Equipment status', 'Movements', 'Shortfalls and requests', CALC_RECORDS_HEADING]
  },
  {
    id: 'ammunition-report', kind: 'report', step: 8, owners: { strategic: 'jloc-chief', operational: 'jloc-chief' },
    when: (v) => v.canadianReports,
    title: (v) => `${v.reports.others[1]} and ${lowerFirst(v.reports.others[2])}`,
    headings: () => ['Period', 'Ammunition on hand by type', 'Ammunition expended by type', 'Forecast', CALC_RECORDS_HEADING]
  },
  {
    id: 'cop-logistics-layer', kind: 'map-layer', step: 8, owners: ALL('jloc-chief'), through: 'the cop-map tool',
    title: (v) => `COP logistics layer (${v.logstat.picture})`, headings: () => []
  },
  {
    id: 'logistics-sync-matrix', kind: 'matrix', step: 7, owners: ALL('jloc-chief'),
    title: () => 'Logistics synchronization matrix',
    headings: () => ['Time or phase', 'Function', 'Action', 'Node or route', 'Linked operations event']
  },
  {
    id: 'logistics-exceptions', kind: 'register', step: 8, owners: ALL('jloc-chief'),
    title: () => 'Logistics exceptions',
    headings: () => ['Exception', 'Matches a CCIR', 'Reported to', 'Time', 'Status', 'Calculator record']
  },
  {
    id: 'supply-estimate', kind: 'estimate', step: 2, owners: ALL('supply-planner'),
    title: () => 'Supply estimate',
    headings: () => ['Classes of supply', 'Requirement by class and phase', 'Days of supply', 'Forecast against reported consumption', CALC_RECORDS_HEADING]
  },
  {
    id: 'critical-items', kind: 'register', step: 2, owners: ALL('supply-planner'),
    title: () => 'Critical items',
    headings: () => ['Item', 'Class', 'Shortfall', 'When it bites', 'Recommended action', 'Calculator record']
  },
  {
    id: 'readiness-summary', kind: 'register', step: 2, owners: ALL('maintenance-planner'),
    title: () => 'Readiness summary',
    headings: () => ['Equipment type', 'Readiness', 'Recovery needs', 'Repair parts constraints', 'Source of the data', 'Calculator record']
  },
  {
    id: 'maintenance-concept', kind: 'plan', step: 7, owners: ALL('maintenance-planner'),
    title: () => 'Maintenance concept',
    headings: () => ['Recommended maintenance priorities', 'Recovery and evacuation', 'Repair parts flow', 'Reconstitution inputs', CALC_RECORDS_HEADING]
  },
  {
    id: 'deployment-distribution-concept', kind: 'plan', step: 2, owners: ALL('mobility-planner'),
    title: () => 'Deployment and distribution concept',
    headings: () => ['Deployment concept', 'Distribution network', 'Movement control', 'Routes and conflicts with operations', CALC_RECORDS_HEADING]
  },
  {
    id: 'movement-table-review', kind: 'register', step: 3, owners: ALL('mobility-planner'),
    title: () => 'Notional movement table review',
    headings: () => ['Serial', 'Lift', 'Port or node', 'Required delivery date', 'Feasible', 'Calculator record']
  },
  {
    id: 'reception-concept', kind: 'plan', step: 7, owners: { strategic: 'mobility-planner', operational: 'mobility-planner' },
    title: (v) => `${v.terms.reception} concept`,
    headings: () => ['Reception', 'Staging', 'Onward movement', 'Integration', CALC_RECORDS_HEADING]
  },
  {
    id: 'sustainment-engineering-concept', kind: 'plan', step: 2, owners: { strategic: 'engineer-planner', operational: 'engineer-planner', tactical: 'mobility-planner' },
    title: () => 'Engineering support to sustainment',
    headings: () => ['Lines of communication: work required', 'Infrastructure and base camps', 'Coordination with the operations engineer', 'Information requested from intelligence', CALC_RECORDS_HEADING]
  },
  {
    id: 'contract-support-requirements', kind: 'register', step: 2, owners: ALL('ocs-planner'),
    title: () => 'Contract support requirements',
    headings: () => ['Shortfall', 'Requirement', 'Why contracted or host-nation support', 'Review board', 'Risk', 'Calculator record']
  },
  {
    id: 'medical-concept-of-support', kind: 'plan', step: 2, owners: ALL('health-services-planner'),
    title: () => 'Medical concept of support',
    headings: () => ['Health service support by phase', 'Medical treatment facilities and their locations', 'Medical logistics', 'Force health protection', 'Notional rates entered by the user', CALC_RECORDS_HEADING]
  },
  {
    id: 'patient-movement-concept', kind: 'plan', step: 3, owners: ALL('health-services-planner'),
    title: () => 'Patient movement concept',
    headings: () => ['Evacuation chain', 'Means and times', 'Coordination with operations', CALC_RECORDS_HEADING]
  },
  {
    id: 'field-services-concept', kind: 'plan', step: 2, owners: { strategic: 'services-mortuary-planner', operational: 'services-mortuary-planner', tactical: 'supply-planner' },
    title: () => 'Field services concept',
    headings: () => ['Services provided', 'Where and when', 'Who provides them', CALC_RECORDS_HEADING]
  },
  {
    id: 'mortuary-affairs-concept', kind: 'plan', step: 2, owners: { strategic: 'services-mortuary-planner', operational: 'services-mortuary-planner', tactical: 'supply-planner' },
    title: () => 'Mortuary affairs concept',
    headings: () => ['Collection points', 'Evacuation flow', 'Personal effects procedures', 'Coordination', CALC_RECORDS_HEADING]
  },
  {
    id: 'logstat-validation-log', kind: 'register', step: 8, owners: ALL('logstat-analyst'), through: 'the logistics server\'s LOGSTAT validation tool',
    title: () => 'LOGSTAT validation log',
    headings: () => ['Report', 'Rule', 'Finding', 'Sent back to', 'Status']
  },
  {
    id: 'guard-report', kind: 'critique', step: 2, owners: ALL('release-guard'), through: 'the staff-products verdict tool',
    title: () => 'Release-guard report',
    headings: () => ['Product and version checked', 'Scan results', 'Markings and caveats', 'Compilation check', 'Decision wording', 'Reasons']
  }
];

/** Whether the vocabulary's profile, nation and roster carry the product. */
const carried = (product: J4Product, v: J4Vocabulary) => product.owners[v.variant] !== undefined && (product.when?.(v) ?? true);

export function j4Product(id: string): J4Product | undefined {
  return J4_PRODUCTS.find((product) => product.id === id);
}

/** The products a member owns for the vocabulary, in catalogue order. */
export function j4ProductsOwnedBy(member: string, v: J4Vocabulary): J4Product[] {
  return J4_PRODUCTS.filter((product) => carried(product, v) && product.owners[v.variant] === member);
}

/** The products the vocabulary's roster carries. */
export function j4VariantProducts(v: J4Vocabulary): J4Product[] {
  return J4_PRODUCTS.filter((product) => carried(product, v));
}

/** Where a product lives in the project (design 10, 3.1). The guard's reports sit under the section's guard/ folder, one per version. */
export function j4ProductPath(product: J4Product): string {
  if (product.id === 'guard-report') return `${staffGuardFolder('j4')}<product>-v<n>.md`;
  if (product.kind === 'map-layer') return `written through ${product.through}`;
  return staffProductPath('j4', product.id);
}

/** The core logistics function each functional planner covers (design 10, 3.5; 03 B2), in the doctrine's order. */
export const J4_FUNCTION_OWNERS: ReadonlyArray<{ readonly function: string; readonly member: string }> = [
  { function: CORE_LOGISTICS_FUNCTIONS[0], member: 'mobility-planner' },
  { function: CORE_LOGISTICS_FUNCTIONS[1], member: 'supply-planner' },
  { function: CORE_LOGISTICS_FUNCTIONS[2], member: 'maintenance-planner' },
  { function: CORE_LOGISTICS_FUNCTIONS[3], member: 'services-mortuary-planner' },
  { function: CORE_LOGISTICS_FUNCTIONS[4], member: 'ocs-planner' },
  { function: CORE_LOGISTICS_FUNCTIONS[5], member: 'health-services-planner' },
  { function: CORE_LOGISTICS_FUNCTIONS[6], member: 'engineer-planner' }
];

/** Where the tactical roster folds a function's member (design 10, 3.5: engineering into mobility, services into supply). */
export const J4_TACTICAL_FOLDS: Readonly<Record<string, string>> = { 'engineer-planner': 'mobility-planner', 'services-mortuary-planner': 'supply-planner' };

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The required headings a product's body lacks (an empty list when it has them all): a Markdown heading line or a table column counts. */
export function j4MissingHeadings(product: J4Product, v: J4Vocabulary, body: string): string[] {
  const lines = body.split(/\r?\n/);
  const headingLines = lines.filter((line) => /^#{1,6}\s/.test(line)).map((line) => line.replace(/^#{1,6}\s+/, '').trim().toLowerCase());
  const tableCells = lines.filter((line) => /^\s*\|.*\|\s*$/.test(line)).flatMap((line) => line.split('|').map((cell) => cell.trim().toLowerCase()));
  return product.headings(v).filter((heading) => {
    const wanted = heading.toLowerCase();
    const pattern = new RegExp(`^(?:\\d+(?:\\.\\d+)*\\.?\\s+)?${escape(wanted)}\\b`);
    return !headingLines.some((line) => pattern.test(line)) && !tableCells.includes(wanted);
  });
}

/**
 * The numbers in a J4 product body that do not trace to a calculator record: a quantity with no calc:<id> on its line, or a calc:<id> that names no
 * record in `records` (when the project has a calculator folder). The same rule guard-scan holds a J4 product for, so a member can run it before
 * proposing, and the release guard cannot clear what it finds.
 */
export function j4NumberTrace(body: string, records?: ReadonlySet<string>): GuardFinding[] {
  const result = guardScan({ body, section: 'j4', owner: 'log-plans-officer', config: { realEntities: [], ...(records ? { calculatorRecords: records } : {}) } });
  return result.findings.filter((finding) => finding.rule === 'number-without-calculation');
}
