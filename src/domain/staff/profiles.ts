// Doctrine profiles and levels (design 10, 2.1 to 2.3; WP-0): the staff settings in project.json, which combinations are valid, and the vocabulary a
// profile and level select. Pure: no I/O, no clock, no vscode. Every doctrine term comes from doctrine.ts; this file only reads those tables.
import {
  ANNEX_LETTER_PATTERN, ANNEX_SUBJECTS, CANADIAN_LAND_TERMS, CROSSWALK, CROSSWALK_STEPS, DOCTRINE_PROFILES, FUNCTION_SETS, PLAN_TRANSITION, PLANNING_TYPE_RULES,
  PLANNING_TYPES, RETIRED_SPACE_TERMS, STAFF_DEFAULTS, STAFF_LEVELS, STAFF_NATIONS, STAFF_PROCESSES, STAFF_PROFILE_IDS, STAFF_SECTIONS
} from './doctrine';
import type {
  AnnexPlacement, AnnexSubject, CrosswalkStep, DoctrineProfile, FunctionSetId, LevelOffer, PlanningType, PlanningTypeRule, StaffLevel, StaffNation,
  StaffProcess, StaffProfileId, StaffSectionId
} from './doctrine';
import { checkStaffKeys, childPath, isOneLine, isOneOf, isRecord, ok, ownValue, STAFF_SLUG, staffRefused } from './parse';
import type { StaffParsed } from './parse';

// These choices describe an organization. They do not select a planning process or authorize setup.
export const STAFF_ORGANIZATION_LEVELS = ['l4', 'l3', 'l2', 'l1', 'l0'] as const;
export type StaffOrganizationLevel = (typeof STAFF_ORGANIZATION_LEVELS)[number];
export const STAFF_ORGANIZATION_PROFILES = ['us-joint', 'us-army', 'nato', 'canada'] as const;
export type StaffOrganizationProfile = (typeof STAFF_ORGANIZATION_PROFILES)[number];

// Phase 102's profile/echelon crosswalk; unspecified charters keep their functional labels.
const organizationPrefixes: Record<StaffOrganizationProfile, Partial<Record<StaffOrganizationLevel, string>>> = {
  'us-joint': { l1: 'J-', l0: 'J-' },
  'us-army': { l4: 'S-', l3: 'S-', l2: 'G-' },
  nato: {},
  canada: { l4: 'S', l3: 'G', l2: 'G' }
};

export function staffOrganizationDesignation(profile: StaffOrganizationProfile, level: StaffOrganizationLevel, section: StaffSectionId): string | undefined {
  const prefix = organizationPrefixes[profile][level];
  const number = STAFF_SECTIONS[section].number;
  if (!prefix || number === undefined || (profile === 'us-joint' && number >= 7)) return undefined;
  return `${prefix}${number}`;
}

/** The planning horizons in hours (design 10, 2.1): current operations up to the first, future operations up to the second, future plans beyond. */
export interface StaffHorizons { readonly currentOpsHours: number; readonly futureOpsHours: number }

/** The `staff` object in `.planning/.near-ai/project.json` (design 10, 2.1). `nation` is present only under the NATO/Canadian profile. */
export interface StaffSettings {
  readonly profile: StaffProfileId;
  readonly level: StaffLevel;
  readonly nation?: StaffNation;
  /** Campaign, contingency or crisis (JP 5-0, 2025): crisis puts the J-3 in charge of staff planning. */
  readonly planningType: PlanningType;
  readonly horizons: StaffHorizons;
  /** Phase names the person chooses (03 A2); empty by default. */
  readonly phases: readonly string[];
  /**
   * The project's section teams: for each staff section set up here, the name of its team file in the person's team library (run as /team:<name>).
   * Written by Set Up a Staff Team; absent until one section is set up. The one record the chat, the /team menu and the Staff Room read.
   */
  readonly teams?: StaffTeamLinks;
}

/** The staff sections that have a team template, in the order the surfaces list them. */
export const STAFF_TEAM_SECTIONS = ['j2', 'j5', 'j3', 'j4'] as const;
export type StaffTeamSection = (typeof STAFF_TEAM_SECTIONS)[number];
/** Section to team name; each name is a team-library file name without `.md`. */
export type StaffTeamLinks = Readonly<Partial<Record<StaffTeamSection, string>>>;

export function isStaffTeamSection(value: unknown): value is StaffTeamSection {
  return isOneOf(STAFF_TEAM_SECTIONS, value);
}

/** The longest horizon accepted, in hours (ten years): strategic horizons run to months and years. */
export const MAX_HORIZON_HOURS = 24 * 366 * 10;
export const MAX_PHASES = 20;
export const MAX_PHASE_NAME = 60;

/** The settings a new staff project starts with. */
export function defaultStaffSettings(): StaffSettings {
  return {
    profile: STAFF_DEFAULTS.profile,
    level: STAFF_DEFAULTS.level,
    planningType: STAFF_DEFAULTS.planningType,
    horizons: { currentOpsHours: STAFF_DEFAULTS.horizons.currentOpsHours, futureOpsHours: STAFF_DEFAULTS.horizons.futureOpsHours },
    phases: []
  };
}

export function profileOf(id: StaffProfileId): DoctrineProfile {
  return DOCTRINE_PROFILES[id];
}

/** What a profile does at a level: the process it runs, or the reason it does not offer that level and what to use instead. */
export function levelOffer(profile: StaffProfileId, level: StaffLevel): LevelOffer {
  return DOCTRINE_PROFILES[profile].levels[level];
}

/** Every valid profile and level pair, in table order. */
export function offeredCombinations(): ReadonlyArray<{ readonly profile: StaffProfileId; readonly level: StaffLevel; readonly process: StaffProcess }> {
  const found: Array<{ profile: StaffProfileId; level: StaffLevel; process: StaffProcess }> = [];
  for (const profile of STAFF_PROFILE_IDS) {
    for (const level of STAFF_LEVELS) {
      const offer = levelOffer(profile, level);
      if (offer.offered) found.push({ profile, level, process: STAFF_PROCESSES[offer.process] });
    }
  }
  return found;
}

/**
 * Reads the `staff` object of project.json strictly: unknown fields, unknown profiles and levels, a level the profile does not offer, a nation under a
 * profile without one, and horizons out of order are each refused with the field named. Missing optional fields take the defaults.
 */
export function parseStaffSettings(value: unknown): StaffParsed<StaffSettings> {
  if (!isRecord(value)) return staffRefused('not-an-object', 'staff');
  const keys = checkStaffKeys(value, 'staff', [], ['profile', 'level', 'nation', 'planningType', 'horizons', 'phases', 'teams']);
  if (keys) return keys;
  const profile = ownValue(value, 'profile') ?? STAFF_DEFAULTS.profile;
  if (!isOneOf(STAFF_PROFILE_IDS, profile)) return staffRefused('unknown-value', 'staff.profile');
  const level = ownValue(value, 'level') ?? STAFF_DEFAULTS.level;
  if (!isOneOf(STAFF_LEVELS, level)) return staffRefused('unknown-value', 'staff.level');
  if (!levelOffer(profile, level).offered) return staffRefused('not-offered', 'staff.level');
  const rawNation = ownValue(value, 'nation');
  let nation: StaffNation | undefined;
  if (DOCTRINE_PROFILES[profile].usesNation) {
    const chosen = rawNation ?? STAFF_DEFAULTS.nation;
    if (!isOneOf(STAFF_NATIONS, chosen)) return staffRefused('unknown-value', 'staff.nation');
    nation = chosen;
  } else if (rawNation !== undefined) {
    return staffRefused('not-allowed-here', 'staff.nation');
  }
  const planningType = ownValue(value, 'planningType') ?? STAFF_DEFAULTS.planningType;
  if (!isOneOf(PLANNING_TYPES, planningType)) return staffRefused('unknown-value', 'staff.planningType');
  const horizons = parseHorizons(ownValue(value, 'horizons'));
  if (!horizons.ok) return horizons;
  const phases = parsePhases(ownValue(value, 'phases'));
  if (!phases.ok) return phases;
  const teams = parseTeamLinks(ownValue(value, 'teams'));
  if (!teams.ok) return teams;
  return ok({ profile, level, ...(nation ? { nation } : {}), planningType, horizons: horizons.value, phases: phases.value, ...(teams.value ? { teams: teams.value } : {}) });
}

/** `staff.teams`: only the four section keys, each its own, each a team name (a library file name: lower case letters, digits and dashes). */
function parseTeamLinks(value: unknown): StaffParsed<StaffTeamLinks | undefined> {
  if (value === undefined) return ok(undefined);
  if (!isRecord(value)) return staffRefused('not-an-object', 'staff.teams');
  const keys = checkStaffKeys(value, 'staff.teams', [], STAFF_TEAM_SECTIONS);
  if (keys) return keys;
  const links: Partial<Record<StaffTeamSection, string>> = {};
  for (const section of STAFF_TEAM_SECTIONS) {
    const name = ownValue(value, section);
    if (name === undefined) continue;
    if (typeof name !== 'string' || !STAFF_SLUG.test(name)) return staffRefused('wrong-type', childPath('staff.teams', section));
    links[section] = name;
  }
  return ok(Object.keys(links).length ? links : undefined);
}

function parseHorizons(value: unknown): StaffParsed<StaffHorizons> {
  if (value === undefined) return ok({ currentOpsHours: STAFF_DEFAULTS.horizons.currentOpsHours, futureOpsHours: STAFF_DEFAULTS.horizons.futureOpsHours });
  if (!isRecord(value)) return staffRefused('not-an-object', 'staff.horizons');
  const keys = checkStaffKeys(value, 'staff.horizons', ['currentOpsHours', 'futureOpsHours']);
  if (keys) return keys;
  const current = ownValue(value, 'currentOpsHours');
  const future = ownValue(value, 'futureOpsHours');
  for (const [key, hours] of [['currentOpsHours', current], ['futureOpsHours', future]] as const) {
    if (typeof hours !== 'number' || !Number.isSafeInteger(hours)) return staffRefused('wrong-type', childPath('staff.horizons', key));
    if (hours < 1 || hours > MAX_HORIZON_HOURS) return staffRefused('out-of-range', childPath('staff.horizons', key));
  }
  if ((current as number) >= (future as number)) return staffRefused('out-of-range', 'staff.horizons.futureOpsHours');
  return ok({ currentOpsHours: current as number, futureOpsHours: future as number });
}

function parsePhases(value: unknown): StaffParsed<readonly string[]> {
  if (value === undefined) return ok([]);
  if (!Array.isArray(value)) return staffRefused('wrong-type', 'staff.phases');
  if (value.length > MAX_PHASES) return staffRefused('out-of-range', 'staff.phases');
  const seen: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const phase: unknown = value[index];
    if (!isOneLine(phase, MAX_PHASE_NAME) || phase !== phase.trim()) return staffRefused('wrong-type', `staff.phases[${index}]`);
    if (seen.includes(phase)) return staffRefused('duplicate-entry', `staff.phases[${index}]`);
    seen.push(phase);
  }
  return ok(seen);
}

/** The settings as written to project.json: the same fields `parseStaffSettings` reads, so a round trip is exact. */
export function staffSettingsJson(settings: StaffSettings): Record<string, unknown> {
  return {
    profile: settings.profile,
    level: settings.level,
    ...(settings.nation ? { nation: settings.nation } : {}),
    planningType: settings.planningType,
    horizons: { currentOpsHours: settings.horizons.currentOpsHours, futureOpsHours: settings.horizons.futureOpsHours },
    phases: [...settings.phases],
    ...(settings.teams && STAFF_TEAM_SECTIONS.some((section) => settings.teams?.[section]) ? { teams: Object.fromEntries(STAFF_TEAM_SECTIONS.flatMap((section) => settings.teams?.[section] ? [[section, settings.teams[section]]] : [])) } : {})
  };
}

/** One step under the selected process: the crosswalk row and the process's own name for it (null when the process has no such step). */
export interface ResolvedStep {
  readonly step: CrosswalkStep;
  readonly work: string;
  readonly human: boolean;
  readonly name: string | null;
  readonly note?: string;
}

/** The annex placement for each subject under the profile. */
export interface ResolvedAnnex { readonly subject: AnnexSubject; readonly placement: AnnexPlacement }

/** Everything a member reads from PROFILE.md: the vocabulary the profile and level select (design 10, 2.1). */
export interface ResolvedProfile {
  readonly settings: StaffSettings;
  readonly profile: DoctrineProfile;
  readonly process: StaffProcess;
  readonly steps: readonly ResolvedStep[];
  readonly annexes: readonly ResolvedAnnex[];
  readonly coaTests: readonly string[];
  /** Who leads staff planning for the planning type, and the role the planning group's decisions and hand-offs name. */
  readonly planning: PlanningTypeRule & { readonly transition: typeof PLAN_TRANSITION };
  /** The J3 running estimate headings. */
  readonly functions: { readonly set: FunctionSetId; readonly names: readonly string[] };
  readonly informationTerm: string;
  /** Canadian Army land terms, under NATO/Canadian at tactical level with the Canadian nation setting only. */
  readonly landTerms?: typeof CANADIAN_LAND_TERMS;
}

/** The running estimate function set for the settings: the profile's, or the nation's where the profile names one. */
export function functionSetFor(settings: Pick<StaffSettings, 'profile' | 'nation'>): FunctionSetId {
  const profile = DOCTRINE_PROFILES[settings.profile];
  const byNation = settings.nation && profile.nationFunctions ? profile.nationFunctions[settings.nation] : undefined;
  return byNation ?? profile.runningEstimateFunctions;
}

/** The planning lead and transition for a planning type. */
export function planningRule(planningType: PlanningType): PlanningTypeRule & { readonly transition: typeof PLAN_TRANSITION } {
  return { ...PLANNING_TYPE_RULES[planningType], transition: PLAN_TRANSITION };
}

/**
 * The retired JP 3-14 space terms found in a text, in table order, matched as whole words in any case. A hyphen counts both as a space and as nothing,
 * so "space-control" and "counter-space" are found too. The vocabulary lint refuses a text with any.
 */
export function retiredSpaceTerms(text: string): string[] {
  const forms = [text.replace(/-/g, ' '), text.replace(/-/g, '')];
  return RETIRED_SPACE_TERMS.filter((term) => {
    const pattern = new RegExp(`(^|[^A-Za-z])${term.split(' ').join('\\s+')}($|[^A-Za-z])`, 'i');
    return forms.some((form) => pattern.test(form));
  });
}

/** The vocabulary for valid settings. Settings from parseStaffSettings are always valid; a hand-built pair the profile does not offer throws. */
export function resolveProfile(settings: StaffSettings): ResolvedProfile {
  const offer = levelOffer(settings.profile, settings.level);
  if (!offer.offered) throw new Error(offer.reason);
  const process = STAFF_PROCESSES[offer.process];
  const profile = DOCTRINE_PROFILES[settings.profile];
  const steps = CROSSWALK.map((row): ResolvedStep => {
    const entry = process.steps[row.step];
    return entry.kind === 'step'
      ? { step: row.step, work: row.work, human: row.human, name: entry.name }
      : { step: row.step, work: row.work, human: row.human, name: null, note: entry.note };
  });
  const set = functionSetFor(settings);
  const canadianLand = settings.profile === 'nato-ca' && settings.level === 'tactical' && settings.nation === 'ca';
  return {
    settings, profile, process, steps, annexes: ANNEX_SUBJECTS.map((subject) => ({ subject, placement: profile.annexes[subject] })), coaTests: profile.coaTests,
    planning: planningRule(settings.planningType),
    functions: { set, names: FUNCTION_SETS[set] },
    informationTerm: canadianLand ? CANADIAN_LAND_TERMS.informationActivities : profile.informationTerm,
    ...(canadianLand ? { landTerms: CANADIAN_LAND_TERMS } : {})
  };
}

/** The process's name for a crosswalk step, or null when the process has no such step. */
export function stepName(profile: StaffProfileId, level: StaffLevel, step: CrosswalkStep): string | null {
  const offer = levelOffer(profile, level);
  if (!offer.offered) return null;
  const entry = STAFF_PROCESSES[offer.process].steps[step];
  return entry.kind === 'step' ? entry.name : null;
}

/** The annex letter a profile gives a subject, or undefined when the subject is an appendix, a part of another annex, or not lettered. */
export function annexLetter(profile: StaffProfileId, subject: AnnexSubject): string | undefined {
  const placement = DOCTRINE_PROFILES[profile].annexes[subject];
  return placement.kind === 'annex' ? placement.letter : undefined;
}

/** The subject a profile files under a letter, or undefined when no subject has that letter. */
export function annexSubjectFor(profile: StaffProfileId, letter: string): AnnexSubject | undefined {
  return ANNEX_SUBJECTS.find((subject) => annexLetter(profile, subject) === letter);
}

/**
 * The staff code a person reads for a section under a profile and level: `J-2` (US Joint), `J2` (NATO/Canadian), `S-2` or `G-2` at tactical level.
 * `echelon` picks the higher (G) or lower (S) tactical prefix and is ignored where the process has one prefix. The command group and special staff have
 * no code and return undefined, as does a level the profile does not offer.
 */
export function sectionCode(profile: StaffProfileId, level: StaffLevel, section: StaffSectionId, echelon: 'higher' | 'lower' = 'higher'): string | undefined {
  const offer = levelOffer(profile, level);
  const number = STAFF_SECTIONS[section].number;
  if (!offer.offered || number === undefined) return undefined;
  const process = STAFF_PROCESSES[offer.process];
  const prefix = echelon === 'lower' ? process.codePrefixes[process.codePrefixes.length - 1] : process.codePrefixes[0];
  return `${prefix}${process.codeSeparator}${number}`;
}

/**
 * Integrity of the doctrine tables: every profile answers every level, every offered level names a known process, every refused level points to an
 * offered one, every process maps every crosswalk step, every annex subject has a placement, annex letters are well formed and unique per profile, and an
 * appendix or part points at a letter the profile actually uses. Returns the problems as sentences; an empty list means the tables are sound.
 */
export function doctrineProblems(): string[] {
  const problems: string[] = [];
  for (const id of STAFF_PROFILE_IDS) {
    const profile = DOCTRINE_PROFILES[id];
    if (profile.id !== id) problems.push(`Profile ${id} carries the id ${profile.id}.`);
    if (!profile.coaTests.length) problems.push(`Profile ${id} has no COA tests.`);
    if (!STAFF_LEVELS.some((level) => profile.levels[level].offered)) problems.push(`Profile ${id} offers no level.`);
    for (const level of STAFF_LEVELS) {
      const offer = profile.levels[level];
      if (offer === undefined) { problems.push(`Profile ${id} does not answer level ${level}.`); continue; }
      if (offer.offered && !Object.prototype.hasOwnProperty.call(STAFF_PROCESSES, offer.process)) problems.push(`Profile ${id} at ${level} names an unknown process.`);
      if (!offer.offered && offer.instead && !levelOffer(offer.instead.profile, offer.instead.level).offered) problems.push(`Profile ${id} at ${level} points to a level that is not offered.`);
    }
    const letters = new Map<string, AnnexSubject>();
    for (const subject of ANNEX_SUBJECTS) {
      const placement = profile.annexes[subject];
      if (placement === undefined) { problems.push(`Profile ${id} has no placement for ${subject}.`); continue; }
      if (placement.kind !== 'annex') continue;
      if (!ANNEX_LETTER_PATTERN.test(placement.letter)) problems.push(`Profile ${id} gives ${subject} the malformed letter ${placement.letter}.`);
      const earlier = letters.get(placement.letter);
      if (earlier) problems.push(`Profile ${id} gives letter ${placement.letter} to both ${earlier} and ${subject}.`);
      else letters.set(placement.letter, subject);
    }
    for (const subject of ANNEX_SUBJECTS) {
      const placement = profile.annexes[subject];
      const parent = placement?.kind === 'appendix' ? placement.toAnnex : placement?.kind === 'within' ? placement.annex : undefined;
      if (parent !== undefined && !letters.has(parent)) problems.push(`Profile ${id} places ${subject} under annex ${parent}, which it does not use.`);
    }
  }
  for (const process of Object.values(STAFF_PROCESSES)) {
    for (const step of CROSSWALK_STEPS) {
      const entry = process.steps[step];
      if (entry === undefined) problems.push(`Process ${process.id} does not map step ${step}.`);
      else if (entry.kind === 'step' && !entry.name.trim()) problems.push(`Process ${process.id} has an empty name for step ${step}.`);
    }
    if (!process.codePrefixes.length) problems.push(`Process ${process.id} has no staff code prefix.`);
  }
  if (CROSSWALK.map((row) => row.step).join(',') !== CROSSWALK_STEPS.join(',')) problems.push('The crosswalk rows are not the eight steps in order.');
  return problems;
}

/** One annex placement as plain words, for PROFILE.md and the orders tracker. */
export function describePlacement(placement: AnnexPlacement): string {
  switch (placement.kind) {
    case 'annex': return `Annex ${placement.letter} (${placement.title})`;
    case 'appendix': return `Appendix to Annex ${placement.toAnnex}`;
    case 'within': return `Part of Annex ${placement.annex}`;
    case 'not-lettered': return `No letter in the profile: ask a person for the letter. ${placement.note}`;
  }
}

/**
 * The text of `.planning/staff/PROFILE.md`, which every member reads first (design 10, 3.1): the profile, level and nation, the process and its step
 * names, the COA tests, the annex letters and the horizons. Generated from the tables, so the file and the code never disagree.
 */
export function renderProfileMarkdown(resolved: ResolvedProfile): string {
  const { settings, profile, process } = resolved;
  const lines = [
    '# Staff profile',
    '',
    'Use these terms only. This file is generated from the project settings; change the profile or level in the staff settings, not here.',
    '',
    `- Profile: ${profile.name} (${profile.id})`,
    `- Level: ${settings.level}`,
    ...(settings.nation ? [`- Nation: ${settings.nation}`] : []),
    `- Process: ${process.name}, from ${process.publication}`,
    `- Intelligence preparation: ${process.intelligencePreparation}`,
    `- Staff codes: ${process.codePrefixes.map((prefix) => `${prefix}${process.codeSeparator}2`).join(' or ')} for intelligence, and so on`,
    `- Horizons: current operations to ${settings.horizons.currentOpsHours} hours, future operations to ${settings.horizons.futureOpsHours} hours, future plans beyond`,
    ...(settings.phases.length ? [`- Phases: ${settings.phases.join(', ')}`] : []),
    `- Planning type: ${settings.planningType}. Staff planning is led by the ${resolved.planning.leadRole}; name that role in planning-group decisions and hand-offs.${resolved.planning.concurrentSteps ? ' Steps may run at the same time.' : ''}`,
    `- At transition: ${resolved.planning.transition.note}`,
    `- Running estimate headings: ${resolved.functions.names.join(', ')}`,
    `- Information activities: ${resolved.informationTerm}`,
    ...(resolved.landTerms ? [
      `- Logistics: ${resolved.landTerms.logistics}`,
      `- Planning centres: ${resolved.landTerms.planningCentres.join('; ')}`,
      `- Below staff level: ${resolved.landTerms.belowStaffLevel}`,
      `- Intelligence cycle: ${resolved.landTerms.intelligenceCycle.join(', ')}`
    ] : []),
    '',
    '## Steps',
    '',
    '| # | Work | Step name |',
    '|---|---|---|',
    ...resolved.steps.map((step) => `| ${step.step} | ${step.work}${step.human ? ' (a person decides)' : ''} | ${step.name ?? `Not a step. ${step.note ?? ''}`.trim()} |`),
    '',
    '## COA tests',
    '',
    resolved.coaTests.join(', '),
    '',
    '## Annexes',
    '',
    'Take every annex letter from this table; never write one from memory.',
    '',
    '| Subject | Annex |',
    '|---|---|',
    ...resolved.annexes.map((annex) => `| ${annex.subject} | ${describePlacement(annex.placement)} |`),
    '',
    `Annex source: ${profile.annexSource}.`,
    ''
  ];
  return lines.join('\n');
}
