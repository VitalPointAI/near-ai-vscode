// The J2 section's products (design 10, 3.2 and 4.3; research note 02, table 9; WP-J2): each product's kind, title, required headings, whether it
// passes the tradecraft gate, and its one owning member in each roster variant. A product a variant does not carry has no owner there. Members write
// products at .planning/staff/products/j2/<product>.md with the header of src/domain/staff/products.ts. A map layer is a product file like any other,
// its features a GeoJSON FeatureCollection in a fenced block; the cop-map tool writes it for the layer's one writer (src/agent/copMap.ts).
import { staffGuardFolder, staffProductFolder, staffProductPath } from '../../domain/staff/writeLimits';
import type { ProductKind } from '../../domain/staff/products';
import type { J2Variant, J2Vocabulary } from './j2Vocabulary';

export interface J2Product {
  readonly id: string;
  readonly kind: ProductKind;
  readonly title: (v: J2Vocabulary) => string;
  /** The headings the product must carry, in order (a Markdown heading, or a column of the product's table). Empty for a map layer. */
  readonly headings: (v: J2Vocabulary) => readonly string[];
  /** Whether the product passes the tradecraft gate before the release-guard (design 10, 4.4). The gates' own reports do not. */
  readonly tradecraft: boolean;
  readonly owners: Readonly<Partial<Record<J2Variant, string>>>;
}

/** A map layer's headings: its features as a GeoJSON FeatureCollection in a ```geojson block, exercise coordinates only, then where each came from. */
const LAYER_HEADINGS = ['Layer features (GeoJSON FeatureCollection in a fenced block, exercise coordinates only)', 'Sources and grades'];

const ALL = (member: string): Record<J2Variant, string> => ({ strategic: member, operational: member, brigade: member, battalion: member });
const CHIEF = { strategic: 'j2-chief', operational: 'j2-chief', brigade: 's2-lead', battalion: 's2-lead' } as const;

export const J2_PRODUCTS: readonly J2Product[] = [
  {
    id: 'intelligence-estimate', kind: 'estimate', tradecraft: true, owners: CHIEF,
    title: () => 'Intelligence estimate',
    headings: (v) => ['Bottom line up front', 'Mission', 'Situation and operational environment', `${v.Actor} capabilities and vulnerabilities`, `${v.Actor} courses of action in order of probability`, 'Key judgements', 'Key assumptions', 'Intelligence gaps', 'Conclusions']
  },
  {
    id: 'j2-staff-estimate', kind: 'estimate', tradecraft: true, owners: CHIEF,
    title: (v) => v.staffEstimate.charAt(0).toUpperCase() + v.staffEstimate.slice(1),
    headings: () => ['Intelligence situation', 'Supportability of each friendly course of action', 'Intelligence risk by course of action', 'Limits on collection, processing, analysis and dissemination', 'Recommendation']
  },
  {
    id: 'intelligence-annex', kind: 'annex', tradecraft: true, owners: CHIEF,
    title: (v) => v.annex,
    headings: () => ['Situation', 'Mission', 'Concept of intelligence operations', 'Priority intelligence requirements', 'Tasks to subordinate and supporting units', 'Requests to higher and adjacent', 'Products and dissemination', 'Coordinating instructions']
  },
  {
    id: 'mission-analysis-input', kind: 'brief', tradecraft: true, owners: CHIEF,
    title: () => 'Intelligence input to the mission analysis brief',
    headings: (v) => ['Operational environment and its effects', `${v.Actor} evaluation and ${v.cog} analysis`, `${v.Actor} courses of action, most likely and most dangerous`, 'Proposed priority intelligence requirements', `Initial ${v.collectionPlan.toLowerCase()}`, 'Gaps and the assumptions that fill them']
  },
  {
    id: 'pir-register', kind: 'register', tradecraft: true,
    owners: { strategic: 'requirements-manager', operational: 'requirements-manager', brigade: 'collection-manager', battalion: 's2-lead' },
    title: () => 'PIR and IR register',
    headings: () => ['Requirement', 'Decision point supported', 'Indicators', 'Specific information requirements', 'Latest time of value', 'Status']
  },
  {
    id: 'collection-plan', kind: 'plan', tradecraft: true,
    owners: { strategic: 'collection-manager', operational: 'collection-manager', brigade: 'collection-manager', battalion: 's2-lead' },
    title: (v) => v.collectionPlan,
    headings: (v) => ['Requirement', 'Indicator', 'Named area of interest', 'Recommended capability', 'Timing', `Needs ${v.ops} approval or a partner`]
  },
  {
    id: 'source-register', kind: 'register', tradecraft: true,
    owners: { strategic: 'collection-manager', operational: 'osint-analyst', brigade: 'collection-manager', battalion: 'ipb-analyst' },
    title: () => 'Source register',
    headings: () => ['Source', 'Reference', 'Published', 'Accessed', 'Origin', 'Reliability', 'Credibility', 'Deception note']
  },
  {
    id: 'osint-report', kind: 'report', tradecraft: true, owners: { operational: 'osint-analyst' },
    title: () => 'OSINT report',
    headings: () => ['Requirement answered', 'Findings', 'Source grades', 'Signs of deception or manipulation', 'Gaps']
  },
  {
    id: 'oe-evaluation', kind: 'report', tradecraft: true,
    owners: { strategic: 'jipoe-analyst', operational: 'jipoe-analyst', brigade: 'ipb-analyst', battalion: 'ipb-analyst' },
    title: (v) => `${v.prep} steps 1 and 2 (operational environment and its effects)`,
    headings: (v) => ['Operational environment limits', v.tactical ? 'Terrain (OAKOC), weather and civil considerations' : 'Systems view', `Effects on ${v.actor} forces`, 'Effects on friendly forces', 'Gaps']
  },
  {
    id: 'terrain-weather', kind: 'report', tradecraft: true,
    owners: { strategic: 'jipoe-analyst', operational: 'geoint-analyst', brigade: 'ipb-analyst', battalion: 'ipb-analyst' },
    title: () => 'Terrain and weather effects',
    headings: (v) => [v.tactical ? 'Modified combined obstacle overlay' : 'Terrain effects', 'Weather effects matrix', 'Lines of communication and infrastructure', 'Imagery notes', 'Sources and grades']
  },
  {
    id: 'cop-terrain-layer', kind: 'map-layer', tradecraft: true,
    owners: { strategic: 'jipoe-analyst', operational: 'geoint-analyst', brigade: 'ipb-analyst', battalion: 'ipb-analyst' },
    title: () => 'COP terrain layer', headings: () => LAYER_HEADINGS
  },
  {
    id: 'adversary-evaluation', kind: 'report', tradecraft: true,
    owners: { strategic: 'threat-analyst', operational: 'threat-analyst', brigade: 'ipb-analyst', battalion: 'ipb-analyst' },
    title: (v) => `${v.prep} step 3 (${v.actor} evaluation)`,
    headings: (v) => ['Order of battle and composition', 'Capabilities and vulnerabilities', `${v.cog.charAt(0).toUpperCase()}${v.cog.slice(1)} analysis`, 'Doctrine and patterns of operation', `${v.Actor} sensing and targeting of friendly forces`, 'Gaps']
  },
  {
    id: 'adversary-coa-set', kind: 'adversary-coa-set', tradecraft: true,
    owners: { strategic: 'threat-analyst', operational: 'threat-analyst', brigade: 'ipb-analyst', battalion: 'ipb-analyst' },
    title: (v) => `${v.prep} step 4 (${v.actor} course of action set)`,
    headings: (v) => [`${v.Actor} courses of action in order of probability`, 'Most likely course of action', 'Most dangerous course of action', 'Situation templates', 'High-value target lists', 'Analysis of competing hypotheses', 'What would change the order']
  },
  {
    id: 'event-template', kind: 'matrix', tradecraft: true,
    owners: { strategic: 'threat-analyst', operational: 'threat-analyst', brigade: 'ipb-analyst', battalion: 'ipb-analyst' },
    title: () => 'Event template and event matrix',
    headings: () => ['Named area of interest', 'Indicator', 'Earliest time', 'Latest time', 'Course of action it confirms or denies']
  },
  {
    id: 'threat-assessment', kind: 'report', tradecraft: true, owners: { strategic: 'threat-analyst', operational: 'threat-analyst' },
    title: () => 'Threat assessment',
    headings: (v) => ['Threat actors', 'Capabilities', 'Intent', 'Most likely course of action', 'Most dangerous course of action', 'Threats to lines of communication, ports and bases', `${v.Actor} intelligence collection capability`]
  },
  {
    id: 'cop-threat-layer', kind: 'map-layer', tradecraft: true,
    owners: { strategic: 'threat-analyst', operational: 'threat-analyst', brigade: 'ipb-analyst', battalion: 'ipb-analyst' },
    title: () => 'COP threat layer', headings: () => LAYER_HEADINGS
  },
  {
    id: 'intsum', kind: 'report', tradecraft: true, owners: { operational: 'watch-officer', brigade: 'watch-officer', battalion: 'watch-officer' },
    title: () => 'INTSUM',
    headings: () => ['Period', 'Significant activity', 'Assessment of intent', 'Changes since the last INTSUM', 'Gaps']
  },
  {
    id: 'intrep', kind: 'report', tradecraft: true, owners: { operational: 'watch-officer', brigade: 'watch-officer', battalion: 'watch-officer' },
    title: () => 'INTREP',
    headings: () => ['Event', 'Indicator triggered', 'Source and grades', 'Deduction', 'Who needs to know']
  },
  {
    id: 'indicator-board', kind: 'register', tradecraft: true,
    owners: { strategic: 'warning-analyst', operational: 'watch-officer', brigade: 'watch-officer', battalion: 'watch-officer' },
    title: () => 'Indicator board',
    headings: () => ['Indicator', 'Named area of interest', 'Course of action it points to', 'Status', 'Last observed']
  },
  {
    id: 'warning-problems', kind: 'register', tradecraft: true, owners: { strategic: 'warning-analyst' },
    title: () => 'Warning problems',
    headings: () => ['Warning problem', 'Emerging or enduring', 'Indicators', 'Threshold', 'Current assessment', 'Change since last review']
  },
  {
    id: 'warning-notice', kind: 'report', tradecraft: true, owners: { strategic: 'warning-analyst' },
    title: () => 'Warning notice',
    headings: () => ['Warning', 'Likelihood and time frame', 'Indicators observed', 'What would change this assessment', 'Decision it bears on']
  },
  {
    id: 'target-intelligence', kind: 'report', tradecraft: true, owners: { operational: 'target-analyst', brigade: 'target-analyst' },
    title: () => 'Target intelligence',
    headings: (v) => ['Target system analysis', `High-value targets by ${v.actor} function`, 'Critical capabilities, requirements and vulnerabilities', 'High-payoff target intelligence', 'Battle damage assessment inputs']
  },
  {
    id: 'red-cell-log', kind: 'report', tradecraft: true,
    owners: { strategic: 'red-cell', operational: 'red-cell', brigade: 's2-lead', battalion: 's2-lead' },
    title: () => 'Red cell log',
    headings: (v) => ['Friendly course of action played', `${v.Actor} course of action played`, 'Action, reaction and counteraction', `Where the ${v.actor} gains an advantage`, `Reverse ${v.prep} of friendly forces`, 'Lessons for the event template']
  },
  {
    id: 'tradecraft-review', kind: 'critique', tradecraft: false, owners: ALL('tradecraft-reviewer'),
    title: () => 'Tradecraft review',
    headings: () => ['Product and version reviewed', 'Mechanical checks', 'Analytic standards', 'Tradecraft standards', 'Key assumptions check', 'Devil\'s advocacy', 'Required fixes']
  },
  {
    id: 'guard-report', kind: 'critique', tradecraft: false, owners: ALL('release-guard'),
    title: () => 'Release-guard report',
    headings: () => ['Product and version checked', 'Scan results', 'Markings and caveats', 'Compilation check', 'Releasability and tear line', 'Decision wording', 'Reasons']
  },
  {
    id: 'dissemination-plan', kind: 'plan', tradecraft: false, owners: ALL('release-guard'),
    title: () => 'Dissemination plan',
    headings: () => ['Product', 'Recipients', 'Releasability', 'Means', 'Timing', 'Feedback asked']
  }
];

export function j2Product(id: string): J2Product | undefined {
  return J2_PRODUCTS.find((product) => product.id === id);
}

/** The products a member owns in a variant, in catalogue order. */
export function productsOwnedBy(member: string, variant: J2Variant): J2Product[] {
  return J2_PRODUCTS.filter((product) => product.owners[variant] === member);
}

/** The products a variant carries. */
export function variantProducts(variant: J2Variant): J2Product[] {
  return J2_PRODUCTS.filter((product) => product.owners[variant] !== undefined);
}

/** Where a product lives in the project (design 10, 3.1). A gate report sits under the section's guard/ or tradecraft/ folder, one per version. */
export function productPath(product: J2Product): string {
  if (product.id === 'tradecraft-review') return `${staffProductFolder('j2')}tradecraft/<product>-v<n>.md`;
  if (product.id === 'guard-report') return `${staffGuardFolder('j2')}<product>-v<n>.md`;
  return staffProductPath('j2', product.id);
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The required headings a product's body lacks (an empty list when it has them all). A heading counts as present when a Markdown heading line names
 * it (`### Key judgements`, any level, any case) or a table header row has it as a column. The fixtures and the demo acceptance checks use this.
 */
export function missingHeadings(product: J2Product, v: J2Vocabulary, body: string): string[] {
  const lines = body.split(/\r?\n/);
  const headingLines = lines.filter((line) => /^#{1,6}\s/.test(line)).map((line) => line.replace(/^#{1,6}\s+/, '').trim().toLowerCase());
  const tableCells = lines.filter((line) => /^\s*\|.*\|\s*$/.test(line)).flatMap((line) => line.split('|').map((cell) => cell.trim().toLowerCase()));
  return product.headings(v).filter((heading) => {
    const wanted = heading.toLowerCase();
    const pattern = new RegExp(`^(?:\\d+(?:\\.\\d+)*\\.?\\s+)?${escape(wanted)}\\b`);
    return !headingLines.some((line) => pattern.test(line)) && !tableCells.includes(wanted);
  });
}
