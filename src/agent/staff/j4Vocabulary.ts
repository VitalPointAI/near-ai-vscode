// The J4 logistics template's words (design 10, 3.5; research note 03 part B; WP-J4): what the profile, level and nation call the section, its estimate,
// its annexes, its current-operations centre and its reports. Every doctrine term comes from src/domain/staff/doctrine.ts through the resolved profile;
// this file only picks. Pure: no I/O, no clock, no vscode.
import { CANADIAN_J4_REPORTS, CANADIAN_LINES_OF_SUPPORT, LOGISTICS_TERMS, LOGSTAT_TERMS, SUPPLY_CLASSES } from '../../domain/staff/doctrine';
import type { AnnexSubject, CrosswalkStep, LogisticsTerms, StaffSectionId, SupplyClass } from '../../domain/staff/doctrine';
import { describePlacement, resolveProfile, sectionCode } from '../../domain/staff/profiles';
import type { ResolvedProfile, StaffSettings } from '../../domain/staff/profiles';

/** The roster variants (design 10, 3.5 level variants): one per level. */
export const J4_VARIANTS = ['strategic', 'operational', 'tactical'] as const;
export type J4Variant = (typeof J4_VARIANTS)[number];

export interface J4Vocabulary {
  readonly settings: StaffSettings;
  readonly resolved: ResolvedProfile;
  readonly variant: J4Variant;
  readonly tactical: boolean;
  /** Canadian wording applies (NATO/Canadian profile with the Canadian nation setting). */
  readonly canadian: boolean;
  /** The staff codes a person reads: J-4, J4, G4, S-4 and so on. */
  readonly code: string;
  readonly ops: string;
  readonly intel: string;
  readonly plans: string;
  /** Who leads staff planning and receives the section's planning products: the J5 (or the J3 in a crisis), or the operations officer's plans cell. */
  readonly planningLead: string;
  /** The person who leads the section (a role; the run records the name). */
  readonly humanLead: string;
  /** The integrator member: j4-director, or s4-lead at tactical level. */
  readonly chief: 'j4-director' | 's4-lead';
  readonly terms: LogisticsTerms;
  /** What the section's function is called: logistics, sustainment, or combat service support in Canadian land terms. */
  readonly function: string;
  /** The section's estimate: the logistics estimate, the joint (or strategic) logistics estimate, or the sustainment running estimate. */
  readonly estimate: string;
  readonly overview: string;
  readonly conceptOfSupport: string;
  /** The logistics current-operations centre at this level, in running-text case. */
  readonly currentOps: string;
  /** The logistics annex as the profile places it, for example "Annex D (Logistics)". */
  readonly annex: string;
  /** A separate movements annex where the profile has one (NATO/Canadian Annex S). */
  readonly movementsAnnex?: string;
  readonly placement: (subject: AnnexSubject) => string;
  readonly supplyClasses: readonly SupplyClass[];
  /** The Canadian lines of support this level provides (Canadian nation setting only). */
  readonly linesOfSupport: ReadonlyArray<{ readonly line: string; readonly meaning: string }>;
  /** The CJOC J4 weekly reports (Canadian nation setting, strategic and operational level). */
  readonly canadianReports: boolean;
  /** theatre or theater, centre or center, as the profile spells them. */
  readonly theatre: string;
  readonly logstat: typeof LOGSTAT_TERMS;
  readonly reports: typeof CANADIAN_J4_REPORTS;
  /** The profile's own name for each crosswalk step, or the plain name of the work where the process has no such step. */
  readonly step: (step: CrosswalkStep) => string;
}

/** A term with its first letter in lower case, unless it starts with an abbreviation (JTF, CCMD). */
const lowerFirst = (text: string): string => (/^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text);

/** The roster variant for the settings: the level. */
export function j4VariantFor(settings: Pick<StaffSettings, 'level'>): J4Variant {
  return settings.level;
}

/**
 * The vocabulary for valid settings. At tactical level the codes follow the J2's brigade rule: a Canadian brigade reads G (Land Operations, 2008), an
 * American or NATO brigade reads S (design 10, 3.2), so the J4 and the J2 of the same headquarters carry the same letter.
 */
export function j4Vocabulary(settings: StaffSettings): J4Vocabulary {
  const resolved = resolveProfile(settings);
  const variant = j4VariantFor(settings);
  const tactical = variant === 'tactical';
  const canadian = settings.profile === 'nato-ca' && settings.nation === 'ca';
  const echelon = tactical && !canadian ? 'lower' : 'higher';
  const code = (section: StaffSectionId) => sectionCode(settings.profile, settings.level, section, echelon) as string;
  const terms = LOGISTICS_TERMS[settings.profile];
  const placementOf = (subject: AnnexSubject) => resolved.annexes.find((annex) => annex.subject === subject)!.placement;
  const movements = placementOf('movements');
  const ops = code('j3');
  const planningLead = tactical ? `${ops} plans cell` : code(resolved.planning.leadSection);
  const lines = canadian ? CANADIAN_LINES_OF_SUPPORT.filter((line) => line.level === variant).map(({ line, meaning }) => ({ line, meaning })) : [];
  return {
    settings, resolved, variant, tactical, canadian,
    code: code('j4'), ops, intel: code('j2'), plans: code('j5'), planningLead,
    humanLead: tactical ? `${code('j4')} logistics officer` : `${code('j4')} director`,
    chief: tactical ? 's4-lead' : 'j4-director',
    terms,
    function: resolved.landTerms?.logistics ?? terms.function,
    estimate: variant === 'strategic' ? terms.strategicEstimate : terms.estimate,
    // At tactical level the overview covers the area of operations, not a theatre (03 B11: daily LOGSTAT, resupply, 72-hour forecast).
    overview: tactical ? 'Logistics overview of the area of operations' : terms.overview,
    conceptOfSupport: terms.conceptOfSupport,
    currentOps: lowerFirst(terms.currentOps[variant]),
    annex: describePlacement(placementOf('logistics')),
    ...(movements.kind === 'annex' ? { movementsAnnex: describePlacement(movements) } : {}),
    placement: (subject) => describePlacement(placementOf(subject)),
    supplyClasses: SUPPLY_CLASSES[settings.profile],
    linesOfSupport: lines,
    canadianReports: canadian && !tactical,
    theatre: settings.profile === 'nato-ca' ? 'theatre' : 'theater',
    logstat: LOGSTAT_TERMS,
    reports: CANADIAN_J4_REPORTS,
    step: (step) => {
      const entry = resolved.steps.find((candidate) => candidate.step === step)!;
      return entry.name ?? entry.work;
    }
  };
}
