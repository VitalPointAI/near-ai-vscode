// Acceptance fixtures for the staff demo (design 10, 9.1 WP-DEMO; after the earlier prototype's validation fixtures, 00 s5). Pure: no I/O, no clock,
// no vscode.
//
// A fixture says what one product must contain under one profile and level: its header identity, its fixed headings (and table columns for a
// register), the profile's terms, and its citations (scenario reports with their grades, the higher order, the assumptions, the publication the
// process follows). `checkProduct` runs a fixture against a product file and lists every problem, so a demo run can show exactly what a product is
// missing. Every term comes from doctrine.ts or the resolved profile; the headings come from the design's product outlines (3.2, 3.3).
import {
  ADVERSARY_COA_TERMS, ICD_203_LIKELIHOOD_TERMS, INTELLIGENCE_REQUIREMENT_TERMS, STAFF_PROCESSES
} from './doctrine';
import type { CrosswalkStep, StaffLevel, StaffProfileId, StaffSectionId } from './doctrine';
import { parseProductFile, STAFF_MARKERS } from './products';
import type { ProductKind } from './products';
import { annexLetter, defaultStaffSettings, levelOffer, resolveProfile, retiredSpaceTerms, sectionCode, stepName } from './profiles';
import { gradeText, SCENARIO_MARKING_PATTERNS } from './scenario';
import type { ControlKind, Scenario } from './scenario';

/** One required term: the product passes when it contains any of the forms. */
export interface RequiredTerm { readonly label: string; readonly anyOf: readonly string[] }

/** What a product must cite. */
export interface CitationRule {
  /** The least number of distinct scenario reports cited as `ID (grade)` with the grade the scenario gives. */
  readonly reports: number;
  /** Whether the higher headquarters' order must be named. */
  readonly higherOrder: boolean;
  /** Whether every assumption in the scenario must be carried by its id. */
  readonly everyAssumption: boolean;
  /** The least number of control measures of a kind cited by name (for example two objectives or one NAI). */
  readonly controlMeasures?: { readonly kind?: ControlKind; readonly min: number };
  /** Any of these publication names. */
  readonly publication?: readonly string[];
}

export interface AcceptanceFixture {
  readonly section: StaffSectionId;
  /** The product slugs this fixture applies to (a COA statement applies to `coa-a` and `coa-b`). */
  readonly products: readonly string[];
  readonly kind: ProductKind;
  readonly profile: StaffProfileId;
  readonly level: StaffLevel;
  readonly title: string;
  /** Markdown headings that must be present, matched without case. */
  readonly headings: readonly string[];
  /** Table columns that must be present in one Markdown table header row (registers only). */
  readonly columns: readonly string[];
  readonly terms: readonly RequiredTerm[];
  /** Terms or patterns the product must not contain under this profile. */
  readonly forbidden: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }>;
  readonly citations: CitationRule;
}

/** The demo products with fixtures, J2 first and then J5 (design 10, 3.2 and 3.3), in the order a demo produces them. */
export const ACCEPTANCE_PRODUCTS = [
  { section: 'j2', id: 'intsum', products: ['intsum'], kind: 'report' },
  { section: 'j2', id: 'intelligence-estimate', products: ['intelligence-estimate'], kind: 'estimate' },
  { section: 'j2', id: 'pir-register', products: ['pir-register'], kind: 'register' },
  { section: 'j5', id: 'mission-analysis-brief', products: ['mission-analysis-brief'], kind: 'brief' },
  { section: 'j5', id: 'coa-statement', products: ['coa-a', 'coa-b'], kind: 'coa-statement' },
  { section: 'j5', id: 'coa-comparison', products: ['coa-comparison'], kind: 'matrix' }
] as const satisfies ReadonlyArray<{ section: StaffSectionId; id: string; products: readonly string[]; kind: ProductKind }>;
export type AcceptanceProductId = (typeof ACCEPTANCE_PRODUCTS)[number]['id'];

/** A decision written as made rather than marked `DECISION FOR: <role>` (design 10, 3.1 and 4.2). */
export const DECISION_AS_MADE = /\b(?:is|was|has been|have been|are|were)\s+(?:selected|approved|released)\b|\bwe\s+(?:select|approve|release)\b/i;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A whole-word, whole-phrase pattern for a term; spaces match any run of white space. */
function wordPattern(term: string, flags = ''): RegExp {
  return new RegExp(`(^|[^A-Za-z0-9-])${escapeRegExp(term).replace(/\s+/g, '\\s+')}($|[^A-Za-z0-9-])`, flags);
}

/** The short name of a publication, as products cite it: `JP 5-0`, `FM 5-0`, `AJP-5`, `APP-28`. */
export function publicationShortName(publication: string): string {
  return /^[A-Z]{2,4}[ -][0-9]+(?:[.-][0-9]+)*/.exec(publication.trim())?.[0] ?? publication.split(',')[0].trim();
}

function codesFor(profile: StaffProfileId, level: StaffLevel, section: StaffSectionId): string[] {
  const codes = [sectionCode(profile, level, section, 'higher'), sectionCode(profile, level, section, 'lower')].filter((code): code is string => code !== undefined);
  return [...new Set(codes)];
}

function stepTerm(profile: StaffProfileId, level: StaffLevel, step: CrosswalkStep): RequiredTerm[] {
  const name = stepName(profile, level, step);
  return name ? [{ label: `step ${step} name`, anyOf: [name] }] : [];
}

/**
 * The fixture for one demo product under one profile and level. Throws for a pair the profile does not offer, as resolveProfile does: fixtures exist
 * only for valid settings.
 */
export function acceptanceFixture(id: AcceptanceProductId, profile: StaffProfileId, level: StaffLevel): AcceptanceFixture {
  const offer = levelOffer(profile, level);
  if (!offer.offered) throw new Error(offer.reason);
  const resolved = resolveProfile({ ...defaultStaffSettings(), profile, level, ...(profile === 'nato-ca' ? { nation: 'ca' as const } : {}) });
  const process = STAFF_PROCESSES[offer.process];
  const entry = ACCEPTANCE_PRODUCTS.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`No acceptance fixture is defined for ${id}.`);
  const base = { section: entry.section, products: entry.products, kind: entry.kind, profile, level };
  const sectionTerm: RequiredTerm = { label: 'staff code', anyOf: codesFor(profile, level, entry.section) };
  const decisionMarker: RequiredTerm = { label: 'decision marker', anyOf: [STAFF_MARKERS.decisionFor] };
  const likelihood: RequiredTerm = { label: 'ICD 203 likelihood term', anyOf: ICD_203_LIKELIHOOD_TERMS.flatMap((term) => [term.term, term.alternative]) };
  const otherPreparation = [...new Set(Object.values(STAFF_PROCESSES).map((entry) => entry.intelligencePreparation))].filter((term) => term !== process.intelligencePreparation);
  const commonForbidden = [
    { label: 'decision written as made', pattern: DECISION_AS_MADE },
    ...SCENARIO_MARKING_PATTERNS.map((pattern) => ({ label: 'classification or caveat marking', pattern }))
  ];
  const j2Forbidden = [
    ...commonForbidden,
    ...otherPreparation.map((term) => ({ label: `${term} is not this profile's intelligence preparation (use ${process.intelligencePreparation})`, pattern: wordPattern(term) }))
  ];
  const processPublication = publicationShortName(process.publication);
  const coaPublication = publicationShortName(resolved.profile.coaTestsSource);
  const intelligenceAnnex = annexLetter(profile, 'intelligence');

  switch (entry.id) {
    case 'intsum':
      return {
        ...base, title: 'Intelligence summary (INTSUM)',
        headings: ['Period', 'Significant activity', 'Assessment of intent', 'Changes since last', 'Gaps'],
        columns: [],
        terms: [sectionTerm, likelihood],
        forbidden: j2Forbidden,
        citations: { reports: 2, higherOrder: false, everyAssumption: false }
      };
    case 'intelligence-estimate':
      return {
        ...base, title: 'Intelligence estimate',
        headings: ['Situation', 'Adversary capabilities', 'Adversary COAs in order of probability', 'Key judgements', 'Intelligence gaps', 'Conclusions'],
        columns: [],
        terms: [
          sectionTerm,
          { label: 'intelligence preparation', anyOf: [process.intelligencePreparation] },
          { label: 'most likely adversary COA', anyOf: [ADVERSARY_COA_TERMS.mostLikely] },
          { label: 'most dangerous adversary COA', anyOf: [ADVERSARY_COA_TERMS.mostDangerous] },
          likelihood,
          ...(intelligenceAnnex ? [{ label: 'intelligence annex letter', anyOf: [`Annex ${intelligenceAnnex}`] }] : []),
          decisionMarker
        ],
        forbidden: j2Forbidden,
        citations: { reports: 3, higherOrder: false, everyAssumption: false }
      };
    case 'pir-register':
      return {
        ...base, title: 'PIR and IR register',
        headings: [],
        columns: ['Requirement', 'Decision point supported', 'Indicators', INTELLIGENCE_REQUIREMENT_TERMS.ltiov, 'Status'],
        terms: [
          { label: 'priority intelligence requirement', anyOf: [INTELLIGENCE_REQUIREMENT_TERMS.pir] },
          { label: 'named area of interest', anyOf: [INTELLIGENCE_REQUIREMENT_TERMS.nai] },
          decisionMarker
        ],
        forbidden: j2Forbidden,
        citations: { reports: 1, higherOrder: false, everyAssumption: false, controlMeasures: { kind: 'nai', min: 1 } }
      };
    case 'mission-analysis-brief':
      return {
        ...base, title: 'Mission analysis brief',
        headings: [
          'Higher commander\'s intent', 'Specified, implied and essential tasks', 'Facts and assumptions', 'Limitations', 'Proposed restated mission',
          'Proposed commander\'s intent', 'Decisions for the commander'
        ],
        columns: [],
        terms: [sectionTerm, ...stepTerm(profile, level, 2), decisionMarker],
        forbidden: commonForbidden,
        citations: { reports: 0, higherOrder: true, everyAssumption: true, publication: [processPublication] }
      };
    case 'coa-statement':
      return {
        ...base, title: 'COA statement and sketch',
        headings: ['COA statement', 'Sketch', 'Task organization', 'Validity tests'],
        columns: [],
        terms: [...stepTerm(profile, level, 3), ...resolved.coaTests.map((test) => ({ label: `COA test: ${test}`, anyOf: [test] }))],
        forbidden: commonForbidden,
        citations: { reports: 0, higherOrder: false, everyAssumption: false, controlMeasures: { kind: 'objective', min: 1 }, publication: [coaPublication] }
      };
    case 'coa-comparison':
      return {
        ...base, title: 'COA comparison and recommendation',
        headings: ['Criteria', 'Comparison matrix', 'Recommendation with risk', 'Dissent', 'Decisions for the commander'],
        columns: [],
        terms: [sectionTerm, ...stepTerm(profile, level, 5), decisionMarker],
        forbidden: commonForbidden,
        citations: { reports: 0, higherOrder: false, everyAssumption: false, publication: [processPublication] }
      };
  }
}

/** Every fixture for one profile and level, in demo order. */
export function acceptanceFixtures(profile: StaffProfileId, level: StaffLevel): AcceptanceFixture[] {
  return ACCEPTANCE_PRODUCTS.map((entry) => acceptanceFixture(entry.id, profile, level));
}

export const ACCEPTANCE_PROBLEM_KINDS = ['header', 'heading', 'column', 'term', 'forbidden', 'citation', 'grade', 'independence'] as const;
export type AcceptanceProblemKind = (typeof ACCEPTANCE_PROBLEM_KINDS)[number];
export interface AcceptanceProblem { readonly kind: AcceptanceProblemKind; readonly detail: string }
export interface AcceptanceResult { readonly pass: boolean; readonly problems: readonly AcceptanceProblem[] }

function headingsOf(body: string): string[] {
  return body.split(/\r?\n/).map((line) => /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1]?.trim().toLowerCase()).filter((line): line is string => line !== undefined);
}

function tableHeaderRows(body: string): string[][] {
  const lines = body.split(/\r?\n/);
  const rows: string[][] = [];
  for (let index = 0; index + 1 < lines.length; index += 1) {
    if (/^\s*\|.*\|\s*$/.test(lines[index]) && /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(lines[index + 1])) {
      rows.push(lines[index].trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim().toLowerCase()));
    }
  }
  return rows;
}

/**
 * Runs a fixture against a product file: the header must parse and name a product, section, profile and level the fixture covers; then headings,
 * columns, terms, forbidden terms and citations. Report citations are checked against the scenario: a report must be cited as `ID (grade)` with the
 * grade the scenario gives, and a line that says two reports confirm each other must not rest on two reports with the same origin.
 */
export function checkProduct(text: string, fixture: AcceptanceFixture, scenario: Scenario): AcceptanceResult {
  const problems: AcceptanceProblem[] = [];
  const parsed = parseProductFile(text);
  let body = text;
  if (!parsed.ok) problems.push({ kind: 'header', detail: parsed.message });
  else {
    const header = parsed.value.header;
    body = parsed.value.body;
    if (!fixture.products.includes(header.product)) problems.push({ kind: 'header', detail: `The header names product ${header.product}; this check is for ${fixture.products.join(' or ')}.` });
    if (header.section !== fixture.section) problems.push({ kind: 'header', detail: `The header names section ${header.section}; expected ${fixture.section}.` });
    if (header.kind !== fixture.kind) problems.push({ kind: 'header', detail: `The header names kind ${header.kind}; expected ${fixture.kind}.` });
    if (header.profile !== fixture.profile || header.level !== fixture.level) {
      problems.push({ kind: 'header', detail: `The header was written under ${header.profile} at ${header.level}; this check is for ${fixture.profile} at ${fixture.level}.` });
    }
  }

  const headings = headingsOf(body);
  for (const heading of fixture.headings) if (!headings.includes(heading.toLowerCase())) problems.push({ kind: 'heading', detail: `Missing heading: ${heading}` });
  if (fixture.columns.length) {
    const rows = tableHeaderRows(body);
    const wanted = fixture.columns.map((column) => column.toLowerCase());
    if (!rows.some((row) => wanted.every((column) => row.includes(column)))) problems.push({ kind: 'column', detail: `No table has every column: ${fixture.columns.join(', ')}` });
  }
  for (const term of fixture.terms) {
    if (!term.anyOf.some((form) => wordPattern(form, /[a-z]/.test(form) ? 'i' : '').test(body))) {
      problems.push({ kind: 'term', detail: `Missing ${term.label}: ${term.anyOf.length === 1 ? term.anyOf[0] : `one of ${term.anyOf.slice(0, 6).join(', ')}${term.anyOf.length > 6 ? ', ...' : ''}`}` });
    }
  }
  for (const rule of fixture.forbidden) if (rule.pattern.test(body)) problems.push({ kind: 'forbidden', detail: `Not allowed: ${rule.label}` });
  const space = retiredSpaceTerms(body);
  if (space.length) problems.push({ kind: 'forbidden', detail: `Retired space terms: ${space.join(', ')}` });

  problems.push(...citationProblems(body, fixture.citations, scenario));
  return { pass: problems.length === 0, problems };
}

function citationProblems(body: string, rule: CitationRule, scenario: Scenario): AcceptanceProblem[] {
  const problems: AcceptanceProblem[] = [];
  const cited = new Set<string>();
  for (const report of scenario.reports) {
    const mention = new RegExp(`(^|[^A-Za-z0-9-])${escapeRegExp(report.id)}(?![A-Za-z0-9-])(\\s*\\(([^)]{1,20})\\))?`, 'g');
    for (const match of body.matchAll(mention)) {
      const given = match[3]?.trim();
      if (given === undefined) problems.push({ kind: 'citation', detail: `${report.id} is cited without its grade; write ${report.id} (${gradeText(report)}).` });
      else if (given !== gradeText(report)) problems.push({ kind: 'grade', detail: `${report.id} is cited as (${given}); the scenario grades it ${gradeText(report)}.` });
      else cited.add(report.id);
    }
  }
  if (cited.size < rule.reports) problems.push({ kind: 'citation', detail: `Cites ${cited.size} scenario report${cited.size === 1 ? '' : 's'} with grades; needs at least ${rule.reports}.` });

  // Two reports from one origin never count as independent confirmation (design 10, 4.4).
  for (const line of body.split(/\r?\n/)) {
    // A positive claim of confirmation only; a line that says a report does not confirm another is the point being made, not a fault.
    if (!/\b(confirmed by|corroborated by|confirms|corroborates|confirm each other|corroborate each other)\b/i.test(line) || /\b(not|no|never|cannot)\b/i.test(line)) continue;
    const onLine = scenario.reports.filter((report) => new RegExp(`(^|[^A-Za-z0-9-])${escapeRegExp(report.id)}(?![A-Za-z0-9-])`).test(line));
    for (let first = 0; first < onLine.length; first += 1) {
      for (let second = first + 1; second < onLine.length; second += 1) {
        if (onLine[first].origin === onLine[second].origin) {
          problems.push({ kind: 'independence', detail: `${onLine[first].id} and ${onLine[second].id} share one origin and cannot confirm each other.` });
        }
      }
    }
  }

  if (rule.higherOrder && !body.includes(scenario.mission.higher.order)) problems.push({ kind: 'citation', detail: `Does not name the higher order: ${scenario.mission.higher.order}` });
  if (rule.everyAssumption) {
    for (const assumption of scenario.mission.own.assumptions) {
      if (!new RegExp(`(^|[^A-Za-z0-9-])${escapeRegExp(assumption.id)}(?![A-Za-z0-9-])`).test(body)) problems.push({ kind: 'citation', detail: `Does not carry assumption ${assumption.id}.` });
    }
  }
  if (rule.controlMeasures) {
    const { kind, min } = rule.controlMeasures;
    const named = scenario.controlMeasures.filter((measure) => (kind === undefined || measure.kind === kind) && wordPattern(measure.name).test(body));
    if (named.length < min) problems.push({ kind: 'citation', detail: `Names ${named.length} ${kind ?? 'control measure'}${named.length === 1 ? '' : 's'} from the scenario; needs at least ${min}.` });
  }
  if (rule.publication && !rule.publication.some((name) => wordPattern(name).test(body))) problems.push({ kind: 'citation', detail: `Does not cite ${rule.publication.join(' or ')}.` });
  return problems;
}

/** The fixture as a checklist for a demo script or a presenter: what the product must contain, in plain words. */
export function fixtureChecklist(fixture: AcceptanceFixture): string[] {
  const lines = [
    ...(fixture.headings.length ? [`Headings: ${fixture.headings.join('; ')}`] : []),
    ...(fixture.columns.length ? [`Table columns: ${fixture.columns.join('; ')}`] : []),
    ...fixture.terms.map((term) => `Uses ${term.label}: ${term.anyOf.length > 4 ? `one of ${term.anyOf.slice(0, 4).join(', ')}, ...` : term.anyOf.join(' or ')}`)
  ];
  const rule = fixture.citations;
  if (rule.reports) lines.push(`Cites at least ${rule.reports} scenario report${rule.reports === 1 ? '' : 's'} as ID (grade)`);
  if (rule.higherOrder) lines.push('Names the higher order');
  if (rule.everyAssumption) lines.push('Carries every assumption by its id');
  if (rule.controlMeasures) lines.push(`Names at least ${rule.controlMeasures.min} ${rule.controlMeasures.kind ?? 'control measure'} from the scenario`);
  if (rule.publication) lines.push(`Cites ${rule.publication.join(' or ')}`);
  lines.push('Writes every decision as DECISION FOR, never as made');
  return lines;
}
