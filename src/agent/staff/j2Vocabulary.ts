// The J2 intelligence template's words (design 10, 3.2; WP-J2): what the profile, level and echelon call the section, its estimate and annex, its
// process and its preparation steps. Every doctrine term comes from src/domain/staff/doctrine.ts through the resolved profile; this file only picks.
import { INTELLIGENCE_PREPARATION_STEPS, INTELLIGENCE_TERMS } from '../../domain/staff/doctrine';
import type { CrosswalkStep, IntelligenceProcess, StaffSectionId } from '../../domain/staff/doctrine';
import { describePlacement, resolveProfile, sectionCode } from '../../domain/staff/profiles';
import type { ResolvedProfile, StaffSettings } from '../../domain/staff/profiles';

/** The roster variants (design 10, 3.2 level variants): one per level, and two at tactical level. */
export const J2_VARIANTS = ['strategic', 'operational', 'brigade', 'battalion'] as const;
export type J2Variant = (typeof J2_VARIANTS)[number];

/** The tactical echelons a J2 team is written for. Brigade also serves a division (its codes are G); battalion is the smallest staff with an S2. */
export const TACTICAL_ECHELONS = ['brigade', 'battalion'] as const;
export type TacticalEchelon = (typeof TACTICAL_ECHELONS)[number];

/** The roster variant for the settings: the level, and at tactical level the echelon (brigade unless the person picks battalion). */
export function j2VariantFor(settings: Pick<StaffSettings, 'level'>, echelon: TacticalEchelon = 'brigade'): J2Variant {
  return settings.level === 'tactical' ? echelon : settings.level;
}

export interface J2Vocabulary {
  readonly settings: StaffSettings;
  readonly resolved: ResolvedProfile;
  readonly variant: J2Variant;
  readonly tactical: boolean;
  /** Canadian wording applies (NATO/Canadian profile with the Canadian nation setting). */
  readonly canadian: boolean;
  /** The staff codes a person reads: J-2, J2, G2, S-2 and so on. */
  readonly code: string;
  readonly ops: string;
  readonly plans: string;
  readonly logistics: string;
  /** Who leads staff planning and receives the section's planning products: the J5 (or the J3 in a crisis), or the operations officer's plans cell. */
  readonly planningLead: string;
  /** The person who leads the section (a role; the run records the name). */
  readonly humanLead: string;
  readonly prep: 'JIPOE' | 'IPB';
  readonly prepSteps: readonly [string, string, string, string];
  /** adversary or threat. */
  readonly actor: string;
  /** Adversary or Threat, for headings. */
  readonly Actor: string;
  readonly process: IntelligenceProcess;
  readonly requirements: string;
  readonly collectionPlan: string;
  /** The intelligence annex as the profile places it, for example "Annex B (Intelligence)". */
  readonly annex: string;
  readonly estimatePlacement?: string;
  /** The section's estimate of its own supportability: the J-2 staff estimate, or the intelligence running estimate at tactical level. */
  readonly staffEstimate: string;
  readonly credibilityOne: string;
  readonly belowStaffLevel?: string;
  /** centre or center of gravity, as the profile spells it. */
  readonly cog: string;
  /** The profile's own name for each crosswalk step, or the plain name of the work where the process has no such step. */
  readonly step: (step: CrosswalkStep) => string;
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The vocabulary for valid settings and a variant that matches their level. The echelon picks G or S codes at tactical level: the battalion and an
 * American or NATO brigade read S; a Canadian brigade reads G, since its intelligence staff is the G2 (Land Operations, 2008; design 10, 3.2).
 */
export function j2Vocabulary(settings: StaffSettings, variant: J2Variant = j2VariantFor(settings)): J2Vocabulary {
  if (j2VariantFor(settings, variant === 'battalion' ? 'battalion' : 'brigade') !== variant) throw new Error(`The ${variant} J2 roster is not written for the ${settings.level} level.`);
  const resolved = resolveProfile(settings);
  const tactical = settings.level === 'tactical';
  const canadian = settings.profile === 'nato-ca' && settings.nation === 'ca';
  const echelon = variant === 'brigade' && canadian ? 'higher' : 'lower';
  const code = (section: StaffSectionId) => sectionCode(settings.profile, settings.level, section, tactical ? echelon : 'higher') as string;
  const prep = resolved.process.intelligencePreparation as 'JIPOE' | 'IPB';
  const preparation = INTELLIGENCE_PREPARATION_STEPS[prep];
  const terms = INTELLIGENCE_TERMS[settings.profile];
  const placement = resolved.annexes.find((annex) => annex.subject === 'intelligence')!.placement;
  const ops = code('j3');
  const planningLead = tactical
    ? (variant === 'brigade' ? `${ops} plans cell` : ops)
    : code(resolved.planning.leadSection);
  return {
    settings, resolved, variant, tactical, canadian,
    code: code('j2'), ops, plans: code('j5'), logistics: code('j4'), planningLead,
    humanLead: tactical ? `${code('j2')} intelligence officer` : `${code('j2')} director`,
    prep, prepSteps: preparation.steps, actor: preparation.actor, Actor: capital(preparation.actor),
    process: terms.process,
    requirements: (settings.nation && terms.nationRequirementsManagement?.[settings.nation]) || terms.requirementsManagement,
    collectionPlan: terms.collectionPlan,
    annex: describePlacement(placement),
    ...(terms.estimatePlacement ? { estimatePlacement: terms.estimatePlacement } : {}),
    staffEstimate: tactical ? 'intelligence running estimate' : `${code('j2')} staff estimate`,
    credibilityOne: terms.credibilityOne,
    cog: settings.profile === 'nato-ca' ? 'centre of gravity' : 'center of gravity',
    ...(tactical && terms.belowStaffLevel ? { belowStaffLevel: terms.belowStaffLevel } : {}),
    step: (step) => {
      const entry = resolved.steps.find((candidate) => candidate.step === step)!;
      return entry.name ?? entry.work;
    }
  };
}

/** The process stages as one phrase, separated by semicolons since stage names hold "and": "direction; collection; processing; dissemination". */
export function processPhrase(process: IntelligenceProcess): string {
  const stages = process.stages.map((stage) => stage.charAt(0).toLowerCase() + stage.slice(1)).join('; ');
  return process.continuing ? `${stages}; with ${process.continuing.map((activity) => activity.toLowerCase()).join(' and ')} throughout` : stages;
}
