// Doctrine data for the military staff team templates (design 10, sections 2.1 to 2.3; WP-0). Pure data and its types: no I/O, no clock, no vscode.
//
// Every doctrine term the staff templates use lives in this one file: profile and process names, the publications they follow, which levels each profile
// offers, the step name for each crosswalk row, the COA tests, the annex letters and titles, and the J, G and S code style. A correction to a step name or
// an annex letter is a change to this file only; the code in profiles.ts reads these tables and never spells a doctrine term of its own.
//
// Sources are cited per table in the design's short form ("05 T1" is research note 05, table 1; "CFJP 5.0 art. 404" and "AJP-5 3.50" cite the
// publications). Where the design names no letter for a subject, the entry says so (`not-lettered`) rather than guessing one: the orders tool then asks
// a person for the letter instead of writing one from memory (design 10, 2.3).

/** The three doctrine profiles (owner decision 2026-11-18). There is no separate CAF OPP profile; CFJP 5.0 is a reference column only. */
export const STAFF_PROFILE_IDS = ['us-joint', 'us-army', 'nato-ca'] as const;
export type StaffProfileId = (typeof STAFF_PROFILE_IDS)[number];

/** The level setting (design 10, 2.1). */
export const STAFF_LEVELS = ['strategic', 'operational', 'tactical'] as const;
export type StaffLevel = (typeof STAFF_LEVELS)[number];

/** The nation setting, which applies only under the NATO/Canadian profile (design 10, 2.1). */
export const STAFF_NATIONS = ['ca', 'nato'] as const;
export type StaffNation = (typeof STAFF_NATIONS)[number];

/** The planning processes a profile and level select. */
export const STAFF_PROCESS_IDS = ['jpp', 'mdmp', 'ajp-5', 'app-28'] as const;
export type StaffProcessId = (typeof STAFF_PROCESS_IDS)[number];

/** The eight crosswalk rows, one per piece of work, in order (design 10, 2.2). Rows are the work; each process names its own step for each row. */
export const CROSSWALK_STEPS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export type CrosswalkStep = (typeof CROSSWALK_STEPS)[number];

export interface CrosswalkRow {
  readonly step: CrosswalkStep;
  /** The plain name of the work, the same under every profile. */
  readonly work: string;
  /** Whether a person, not an agent, does this step's work (row 6: the decision is a person's). */
  readonly human: boolean;
  readonly keyOutputs: readonly string[];
}

export const CROSSWALK: readonly CrosswalkRow[] = [
  { step: 1, work: 'Start', human: false, keyOutputs: ['Timeline', 'Warning order', 'Initial guidance', 'Planning group formed'] },
  { step: 2, work: 'Understand', human: false, keyOutputs: ['Facts and assumptions', 'Tasks', 'Limitations', 'COG analysis', 'CCIRs', 'Criteria', 'Restated mission', 'Intent and guidance'] },
  { step: 3, work: 'Build options', human: false, keyOutputs: ['COA statements and sketches', 'Adversary MLCOA and MDCOA'] },
  { step: 4, work: 'Test options', human: false, keyOutputs: ['Wargamed COAs', 'Sync matrix', 'Decision points', 'DST and DSM', 'Branches', 'Refined CCIRs'] },
  { step: 5, work: 'Compare', human: false, keyOutputs: ['Comparison matrix', 'Recommendation with risk'] },
  { step: 6, work: 'Decide', human: true, keyOutputs: ['Decision brief', 'The decision is a person\'s'] },
  { step: 7, work: 'Write the plan', human: false, keyOutputs: ['Plan or order with annexes', 'Transition brief'] },
  { step: 8, work: 'Keep it valid', human: false, keyOutputs: ['Updated plan', 'Branches and sequels', 'Assessment reports'] }
];

/** One process's name for one crosswalk row: a named step, or an explicit statement that the process has no such step. */
export type ProcessStep =
  | { readonly kind: 'step'; readonly name: string; readonly source: string }
  | { readonly kind: 'not-a-step'; readonly note: string; readonly source: string };

export interface StaffProcess {
  readonly id: StaffProcessId;
  readonly name: string;
  readonly publication: string;
  /** The intelligence preparation the process uses: JIPOE at joint levels, IPB with OAKOC at tactical level (design 10, 3.1). */
  readonly intelligencePreparation: string;
  /** The staff code prefixes at this process's levels, highest echelon first: J at joint levels; G (division, corps) and S (brigade, battalion) at tactical level. */
  readonly codePrefixes: readonly string[];
  /** What goes between the prefix and the number: `J-2` or `J2`. */
  readonly codeSeparator: string;
  readonly steps: Readonly<Record<CrosswalkStep, ProcessStep>>;
}

// Design 10, 2.2. Sources: JP 5-0 (July 2025) figures IV-2 and IV-3 and ch. IV para 3; 05 T1 and s1 to s4; 03 A7, A12; 02 T3 to T5; AJP-5 figure 3.1, 3.15, 3.45, 3.50.
export const STAFF_PROCESSES: Readonly<Record<StaffProcessId, StaffProcess>> = {
  jpp: {
    id: 'jpp',
    name: 'Joint planning process (JPP)',
    publication: 'JP 5-0, Joint Planning (1 July 2025)',
    intelligencePreparation: 'JIPOE',
    codePrefixes: ['J'],
    codeSeparator: '-',
    steps: {
      1: { kind: 'step', name: 'Planning initiation', source: 'JP 5-0 (2025) figures IV-2 and IV-3' },
      2: { kind: 'step', name: 'Mission analysis', source: 'JP 5-0 (2025) figures IV-2 and IV-3' },
      3: { kind: 'step', name: 'COA development', source: 'JP 5-0 (2025) figures IV-2 and IV-3' },
      4: { kind: 'step', name: 'COA analysis and wargaming', source: 'JP 5-0 (2025) figures IV-2 and IV-3' },
      5: { kind: 'step', name: 'COA comparison', source: 'JP 5-0 (2025) figures IV-2 and IV-3' },
      6: { kind: 'step', name: 'COA approval', source: 'JP 5-0 (2025) figures IV-2 and IV-3' },
      7: { kind: 'step', name: 'Plan or order development', source: 'JP 5-0 (2025) figures IV-2 and IV-3' },
      8: { kind: 'step', name: 'Plan evaluation', source: 'JP 5-0 (2025) ch. I and IV (plan evaluation function; IPRs; operation assessment in ch. VI and app. H)' }
    }
  },
  mdmp: {
    id: 'mdmp',
    name: 'Military decision-making process (MDMP)',
    publication: 'FM 5-0, Planning and Orders Production (2024)',
    intelligencePreparation: 'IPB',
    codePrefixes: ['G', 'S'],
    codeSeparator: '-',
    steps: {
      1: { kind: 'step', name: 'Receipt of mission', source: 'FM 5-0 (Nov 2024) ch. 5' },
      2: { kind: 'step', name: 'Mission analysis', source: 'FM 5-0 (Nov 2024) ch. 5' },
      3: { kind: 'step', name: 'COA development', source: 'FM 5-0 (Nov 2024) ch. 5' },
      4: { kind: 'step', name: 'COA analysis (war game)', source: 'FM 5-0 (Nov 2024) ch. 5' },
      5: { kind: 'step', name: 'COA comparison', source: 'FM 5-0 (Nov 2024) ch. 5' },
      6: { kind: 'step', name: 'COA approval', source: 'FM 5-0 (Nov 2024) ch. 5' },
      7: { kind: 'step', name: 'Orders production, dissemination and transition', source: 'FM 5-0 (Nov 2024) ch. 5' },
      8: { kind: 'step', name: 'Assessment', source: 'FM 5-0 ch. 8' }
    }
  },
  'ajp-5': {
    id: 'ajp-5',
    name: 'Operations planning process (AJP-5)',
    publication: 'AJP-5, Allied Joint Doctrine for the Planning of Operations, Edition B',
    intelligencePreparation: 'JIPOE', // AJP-2 (Edition B, 2016) term for joint intelligence preparation; JIPB is obsolete (CADN 16-01)
    codePrefixes: ['J'],
    codeSeparator: '',
    steps: {
      1: { kind: 'step', name: 'Planning initiation', source: 'AJP-5 3.15' },
      2: { kind: 'step', name: 'Mission analysis', source: 'AJP-5 3.18 to 3.43' },
      3: { kind: 'step', name: 'COA development', source: 'AJP-5 3.45, 3.50' },
      4: { kind: 'step', name: 'COA analysis', source: 'AJP-5 figure 3.1' },
      5: { kind: 'step', name: 'COA validation and comparison', source: 'AJP-5 figure 3.1' },
      6: { kind: 'step', name: 'Commander\'s COA decision', source: 'AJP-5 figure 3.1' },
      7: { kind: 'step', name: 'Plan development', source: 'AJP-5 Stage 4' },
      8: { kind: 'step', name: 'Operations assessment', source: 'AJP-3; COPD phases 5 and 6' }
    }
  },
  'app-28': {
    id: 'app-28',
    name: 'Tactical planning (APP-28)',
    publication: 'APP-28, Tactical Planning for Land Forces',
    intelligencePreparation: 'IPB',
    codePrefixes: ['G', 'S'],
    codeSeparator: '',
    steps: {
      1: { kind: 'step', name: 'Receipt of mission', source: 'APP-28 Edition A as summarised by a NATO centre-of-excellence handbook (05; 03 A8)' },
      2: { kind: 'step', name: 'Mission analysis', source: 'APP-28 Edition A as summarised by a NATO centre-of-excellence handbook (05; 03 A8)' },
      3: { kind: 'step', name: 'COA development', source: 'APP-28 Edition A as summarised by a NATO centre-of-excellence handbook (05; 03 A8)' },
      4: { kind: 'step', name: 'COA analysis', source: 'APP-28 Edition A as summarised by a NATO centre-of-excellence handbook (05; 03 A8)' },
      5: { kind: 'step', name: 'COA comparison', source: 'APP-28 Edition A as summarised by a NATO centre-of-excellence handbook (05; 03 A8)' },
      6: { kind: 'step', name: 'Commander\'s decision', source: 'APP-28 Edition A as summarised by a NATO centre-of-excellence handbook (05; 03 A8)' },
      7: { kind: 'step', name: 'Transition (orders)', source: 'APP-28 Edition A as summarised by a NATO centre-of-excellence handbook (05; 03 A8)' },
      8: { kind: 'not-a-step', note: 'APP-28 has no separate review step; assessment runs in execution.', source: 'APP-28 Edition A as summarised by a NATO centre-of-excellence handbook (05; 03 A8)' }
    }
  }
};

/** CFJP 5.0 (2008), the reference column of the crosswalk (owner decision: reference only, never a profile). Sources: CFJP 5.0 art. 304, 312, 315, 402 to 406. */
export const CFJP_5_0_REFERENCE: Readonly<Record<CrosswalkStep, string>> = {
  1: 'Stage 1 Initiation: commander\'s initial direction, warning order (art. 402)',
  2: 'Stage 2 Orientation: mission analysis, Commander\'s Planning Guidance and warning order; JIPB (art. 312, 403)',
  3: 'Stage 3 COA Development: staff analysis of factors; enemy COAs first; own COAs (art. 304, 404)',
  4: 'Inside Stage 3: COA validation and wargaming (art. 404.8 to 404.9)',
  5: 'Inside Stage 3: COA comparison with a decision matrix (art. 404.10)',
  6: 'Inside Stage 3: Decision Brief; the commander selects (art. 404.11 to 404.13)',
  7: 'Stage 4 Plan Development: CONOPS approved first; annexes and SUPLANs; plan approval (art. 405)',
  8: 'Stage 5 Plan Review: progress review and periodic review (art. 406, 315)'
};

/** CFJP 5.0 COA tests, reference only (art. 304). */
export const CFJP_5_0_COA_TESTS: readonly string[] = ['Suitability', 'Feasibility', 'Acceptability', 'Compliance', 'Exclusivity', 'Completeness'];

/** What a profile does at one level: the process it runs, or why it does not offer the level and which profile and level to use instead. */
export type LevelOffer =
  | { readonly offered: true; readonly process: StaffProcessId; readonly note: string }
  | { readonly offered: false; readonly reason: string; readonly instead?: { readonly profile: StaffProfileId; readonly level: StaffLevel } };

/** The subjects an order's annexes cover (design 10, 2.3). Each profile says how it carries each subject. */
export const ANNEX_SUBJECTS = [
  'task-organization', 'intelligence', 'operations', 'logistics', 'movements', 'personnel', 'public-affairs', 'fires', 'rules-of-engagement',
  'health-services', 'information', 'communication-strategy', 'communications', 'knowledge-management', 'environmental', 'engineer', 'legal',
  'assessment', 'reports', 'foreign-disclosure', 'host-nation-support', 'contracting-finance', 'interagency', 'civil-military-cooperation'
] as const;
export type AnnexSubject = (typeof ANNEX_SUBJECTS)[number];

/** Annex letters: one or two upper case letters (A to Z, then AA, EE, FF and the like). */
export const ANNEX_LETTER_PATTERN = /^[A-Z]{1,2}$/;

/**
 * How a profile carries one subject: its own lettered annex, an appendix to another annex, a part of another annex, or no letter in the profile's
 * sources (`not-lettered`), in which case the orders tool asks a person for the letter.
 */
export type AnnexPlacement =
  | { readonly kind: 'annex'; readonly letter: string; readonly title: string }
  | { readonly kind: 'appendix'; readonly toAnnex: string }
  | { readonly kind: 'within'; readonly annex: string }
  | { readonly kind: 'not-lettered'; readonly note: string };

/** The running estimate headings a J3 uses (design 10, 3.4). */
export const FUNCTION_SETS = {
  /** The seven joint functions (JP 1 Volume 1, 2023). */
  'joint-functions': ['Command and control', 'Information', 'Intelligence', 'Fires', 'Movement and maneuver', 'Protection', 'Sustainment'],
  /** The five Canadian operational functions (Land Operations, 2008; CADN 16-01, 2016). */
  'canadian-operational-functions': ['Command', 'Sense', 'Act', 'Shield', 'Sustain']
} as const;
export type FunctionSetId = keyof typeof FUNCTION_SETS;

/** The four US joint planning functions (JP 5-0, 2025, ch. I) and how plan evaluation ends. */
export const JOINT_PLANNING_FUNCTIONS: readonly string[] = ['Strategic guidance analysis', 'Concept development', 'Plan development', 'Plan evaluation'];
export const PLAN_EVALUATION_OUTCOMES: readonly string[] = ['Refine', 'Adapt', 'Terminate planning', 'Execute'];

/** The planning type setting (design 10, 2.1; JP 5-0, 2025, ch. IV). */
export const PLANNING_TYPES = ['campaign', 'contingency', 'crisis'] as const;
export type PlanningType = (typeof PLANNING_TYPES)[number];

export interface PlanningTypeRule {
  /** The section that coordinates staff planning: the J-5 for campaigns and contingencies, the J-3 in a crisis. */
  readonly leadSection: 'j5' | 'j3';
  /** The human role the planning group's `DECISION FOR` and hand-off lines name. */
  readonly leadRole: string;
  /** Whether JPP steps may run at the same time (crisis planning). */
  readonly concurrentSteps: boolean;
  readonly source: string;
}

export const PLANNING_TYPE_RULES: Readonly<Record<PlanningType, PlanningTypeRule>> = {
  campaign: { leadSection: 'j5', leadRole: 'J5 director', concurrentSteps: false, source: 'JP 5-0 (2025) ch. IV' },
  contingency: { leadSection: 'j5', leadRole: 'J5 director', concurrentSteps: false, source: 'JP 5-0 (2025) ch. IV' },
  crisis: { leadSection: 'j3', leadRole: 'J3 director', concurrentSteps: true, source: 'JP 5-0 (2025) ch. IV' }
};

/** Plans move from the planners to J-3 future operations at transition, whatever the planning type (JP 5-0, 2025; design 10, 3.1). */
export const PLAN_TRANSITION = { toSection: 'j3', toMember: 'future-ops-planner', note: 'Plans move to J-3 future operations at transition.' } as const;

/** The JP 3-14 (2023) space mission areas, the only space vocabulary the templates use. */
export const SPACE_MISSION_AREAS: readonly string[] = [
  'Space domain awareness', 'Offensive space operations', 'Defensive space operations', 'Positioning, navigation and timing', 'Intelligence, surveillance and reconnaissance',
  'Satellite communications', 'Environmental monitoring', 'Missile warning', 'Nuclear detonation detection', 'Spacecraft operations', 'Spacelift'
];

/** Space terms JP 3-14 (2023) removed. The vocabulary lint rejects them. */
export const RETIRED_SPACE_TERMS: readonly string[] = ['space control', 'space coordinating authority', 'space negation', 'counterspace'];

/** Canadian Army land terms used under NATO/Canadian at tactical level with the Canadian nation setting (design 10, 2.5; CADN 16-01; Land Operations, 2008). */
export const CANADIAN_LAND_TERMS = {
  informationActivities: 'Influence activities',
  logistics: 'Combat service support (CSS)',
  planningCentres: ['Plans centre (long-range and mid-range planning)', 'Operations centre (short-range planning, FRAGOs)'],
  belowStaffLevel: 'Battle procedure',
  intelligenceCycle: ['Direction', 'Collection', 'Processing', 'Dissemination']
} as const;

export interface DoctrineProfile {
  readonly id: StaffProfileId;
  readonly name: string;
  readonly levels: Readonly<Record<StaffLevel, LevelOffer>>;
  /** The COA validity tests the J5 lead applies (design 10, 2.2). */
  readonly coaTests: readonly string[];
  readonly coaTestsSource: string;
  readonly annexes: Readonly<Record<AnnexSubject, AnnexPlacement>>;
  readonly annexSource: string;
  /** Whether the nation setting applies (only under NATO/Canadian). */
  readonly usesNation: boolean;
  /** The J3 running estimate headings; under NATO/Canadian the Canadian nation setting uses the Canadian operational functions instead. */
  readonly runningEstimateFunctions: FunctionSetId;
  /** A nation setting that uses a different set of running estimate headings. */
  readonly nationFunctions?: Readonly<Partial<Record<StaffNation, FunctionSetId>>>;
  /** The term for information activities at joint level. */
  readonly informationTerm: string;
}

const NO_LETTER = (note: string): AnnexPlacement => ({ kind: 'not-lettered', note });
const NOT_IN_LIST = NO_LETTER('Not in the annex list this profile follows.');

export const DOCTRINE_PROFILES: Readonly<Record<StaffProfileId, DoctrineProfile>> = {
  'us-joint': {
    id: 'us-joint',
    name: 'US Joint',
    levels: {
      strategic: { offered: true, process: 'jpp', note: 'JPP inside the four planning functions; CCMD or Joint Staff products (05 T2).' },
      operational: { offered: true, process: 'jpp', note: 'JPP at JTF level (05 T2).' },
      tactical: { offered: false, reason: 'JPP is a joint process. At tactical level use the US Army profile (MDMP).', instead: { profile: 'us-army', level: 'tactical' } }
    },
    coaTests: ['Suitable', 'Feasible', 'Acceptable', 'Distinguishable', 'Complete'],
    coaTestsSource: 'JP 5-0 (July 2025) ch. IV, COA development (the SFA-DC test)',
    annexes: {
      'task-organization': { kind: 'annex', letter: 'A', title: 'Task Organization' }, // JP 5-0 (1 July 2025) annex list
      intelligence: { kind: 'annex', letter: 'B', title: 'Intelligence' }, // JP 5-0 (1 July 2025) annex list
      operations: { kind: 'annex', letter: 'C', title: 'Operations' }, // JP 5-0 (1 July 2025) annex list
      logistics: { kind: 'annex', letter: 'D', title: 'Logistics' }, // JP 5-0 (1 July 2025) annex list
      movements: NO_LETTER('No separate movements annex; movements are part of Annex D (Logistics).'), // JP 5-0 (1 July 2025) annex list
      personnel: { kind: 'annex', letter: 'E', title: 'Personnel' }, // JP 5-0 (1 July 2025) annex list
      'public-affairs': { kind: 'annex', letter: 'F', title: 'Public Affairs' }, // AY26 Campaign Planning Handbook OPORD format
      fires: { kind: 'appendix', toAnnex: 'C' }, // JP 5-0 (2020) app. A placement
      'rules-of-engagement': { kind: 'appendix', toAnnex: 'C' }, // JP 5-0 (2020) app. A placement
      'health-services': { kind: 'annex', letter: 'Q', title: 'Health Services' }, // AY26 Campaign Planning Handbook OPORD format
      information: { kind: 'within', annex: 'C' }, // JP 5-0 (2020) app. A placement
      'communication-strategy': { kind: 'annex', letter: 'Y', title: 'Commander\'s Communication Strategy' }, // AY26 Campaign Planning Handbook OPORD format
      communications: { kind: 'annex', letter: 'K', title: 'Command, Control, Communications, Computer, and Cybersecurity Systems' }, // JP 5-0 (1 July 2025) annex list
      'knowledge-management': { kind: 'annex', letter: 'I', title: 'Knowledge, Information, and Data Management' }, // JP 5-0 (1 July 2025) annex list
      environmental: { kind: 'annex', letter: 'L', title: 'Environmental Considerations' }, // AY26 Campaign Planning Handbook OPORD format
      engineer: NO_LETTER('No lettered engineer annex in the joint list.'), // AY26 Campaign Planning Handbook OPORD format
      legal: { kind: 'appendix', toAnnex: 'E' }, // JP 5-0 (2020) app. A placement
      assessment: { kind: 'annex', letter: 'N', title: 'Assessments' }, // JP 5-0 (1 July 2025) annex list
      reports: { kind: 'annex', letter: 'R', title: 'Reports' }, // JP 5-0 (1 July 2025) annex list
      // O and P follow the JP 5-0 (2020) order; the AY26 handbook has them the other way round (design 10, 2.3 and 2.9).
      'foreign-disclosure': { kind: 'annex', letter: 'O', title: 'Foreign Disclosure' }, // JP 5-0 (2020) app. A order
      'host-nation-support': { kind: 'annex', letter: 'P', title: 'Host-Nation Support' }, // JP 5-0 (2020) app. A order
      'contracting-finance': { kind: 'annex', letter: 'W', title: 'Operational Contract Support' }, // JP 5-0 (1 July 2025) annex list
      interagency: { kind: 'annex', letter: 'V', title: 'Interagency-Interorganizational Coordination' }, // JP 5-0 (1 July 2025) annex list
      'civil-military-cooperation': NOT_IN_LIST // AY26 Campaign Planning Handbook OPORD format
    },
    annexSource: 'JP 5-0 (July 2025) and the AY26 Campaign Planning Handbook OPORD format; O and P in the JP 5-0 (2020) order; fires, information, ROE and legal placements from JP 5-0 (2020)',
    usesNation: false,
    runningEstimateFunctions: 'joint-functions',
    informationTerm: 'Information'
  },
  'us-army': {
    id: 'us-army',
    name: 'US Army',
    levels: {
      strategic: { offered: false, reason: 'MDMP is a tactical process. At strategic level use the US Joint profile (JPP).', instead: { profile: 'us-joint', level: 'strategic' } },
      operational: { offered: false, reason: 'An Army operational-level headquarters in a joint fight uses JPP. Use the US Joint profile at operational level.', instead: { profile: 'us-joint', level: 'operational' } },
      tactical: { offered: true, process: 'mdmp', note: 'MDMP, corps to battalion; troop leading procedures below (05 s2).' }
    },
    coaTests: ['Feasible', 'Acceptable', 'Suitable', 'Distinguishable', 'Complete'],
    coaTestsSource: 'FM 5-0 (2024)',
    annexes: {
      'task-organization': { kind: 'annex', letter: 'A', title: 'Task Organization' }, // FM 5-0 (Nov 2024) app. E
      intelligence: { kind: 'annex', letter: 'B', title: 'Intelligence' }, // FM 5-0 (Nov 2024) app. E
      operations: { kind: 'annex', letter: 'C', title: 'Operations' }, // FM 5-0 (Nov 2024) app. E
      logistics: { kind: 'annex', letter: 'F', title: 'Sustainment' }, // FM 5-0 (Nov 2024) app. E
      movements: NO_LETTER('No separate movements annex; movements are part of Annex F (Sustainment).'), // FM 5-0 (Nov 2024) app. E
      personnel: NOT_IN_LIST, // FM 5-0 (Nov 2024) app. E
      'public-affairs': { kind: 'annex', letter: 'J', title: 'Public Affairs' }, // FM 5-0 (Nov 2024) app. E
      fires: { kind: 'annex', letter: 'D', title: 'Fires' }, // FM 5-0 (Nov 2024) app. E
      'rules-of-engagement': { kind: 'appendix', toAnnex: 'C' }, // FM 5-0 (Nov 2024) app. E
      'health-services': { kind: 'within', annex: 'F' }, // FM 5-0 (Nov 2024) app. E
      information: { kind: 'within', annex: 'C' }, // FM 5-0 (Nov 2024) app. E
      'communication-strategy': NOT_IN_LIST, // FM 5-0 (Nov 2024) app. E
      communications: { kind: 'annex', letter: 'H', title: 'Signal' }, // FM 5-0 (Nov 2024) app. E
      'knowledge-management': NOT_IN_LIST, // FM 5-0 (Nov 2024) app. E
      environmental: NOT_IN_LIST, // FM 5-0 (Nov 2024) app. E
      engineer: { kind: 'annex', letter: 'G', title: 'Engineer' }, // FM 5-0 (Nov 2024) app. E
      legal: { kind: 'within', annex: 'F' }, // FM 6-0 (2022) SJA tab in the sustainment annex
      assessment: { kind: 'annex', letter: 'M', title: 'Assessment' }, // FM 5-0 (Nov 2024) app. E
      reports: NOT_IN_LIST, // FM 5-0 (Nov 2024) app. E
      'foreign-disclosure': NOT_IN_LIST, // FM 5-0 (Nov 2024) app. E
      'host-nation-support': NOT_IN_LIST, // FM 5-0 (Nov 2024) app. E
      'contracting-finance': { kind: 'annex', letter: 'W', title: 'Operational Contract Support' }, // FM 5-0 (Nov 2024) app. E
      interagency: { kind: 'annex', letter: 'V', title: 'Interagency Coordination' }, // FM 5-0 (Nov 2024) app. E
      'civil-military-cooperation': NOT_IN_LIST // FM 5-0 (Nov 2024) app. E
    },
    annexSource: 'FM 5-0 (2024) Appendix E (05 s2); legal as the SJA tab in Annex F (note 06, FM 6-0)',
    usesNation: false,
    runningEstimateFunctions: 'joint-functions',
    informationTerm: 'Information'
  },
  'nato-ca': {
    id: 'nato-ca',
    name: 'NATO/Canadian',
    levels: {
      strategic: { offered: true, process: 'ajp-5', note: 'AJP-5 Edition B with the COPD as procedure; with the Canadian nation setting, Canadian strategic functions.' },
      operational: { offered: true, process: 'ajp-5', note: 'AJP-5 Edition B.' },
      tactical: { offered: true, process: 'app-28', note: 'APP-28 tactical planning for land forces.' }
    },
    coaTests: ['Feasibility', 'Acceptability', 'Completeness and compliance', 'Exclusivity', 'Suitability'],
    coaTestsSource: 'AJP-5 3.50',
    annexes: {
      'task-organization': { kind: 'annex', letter: 'B', title: 'Task Organization and Command Relationships' }, // CFJP 5.0 (2008) ch. 5 annex E app. 1, from the NATO planning guidelines
      intelligence: { kind: 'annex', letter: 'D', title: 'Intelligence' }, // CFJP 5.0 (2008) ch. 5 annex E app. 1, from the NATO planning guidelines
      operations: { kind: 'annex', letter: 'A', title: 'Conduct of Operations' }, // CFJP 5.0 (2008) ch. 5 annex E app. 1, from the NATO planning guidelines
      logistics: { kind: 'annex', letter: 'R', title: 'Logistics' }, // CFJP 5.0 (2008) ch. 5 annex E app. 1, from the NATO planning guidelines
      movements: { kind: 'annex', letter: 'S', title: 'Movements' }, // CFJP 5.0 (2008) ch. 5 annex E app. 1, from the NATO planning guidelines
      personnel: NOT_IN_LIST, // CFJP 5.0 (2008) ch. 5 annex E app. 1, from the NATO planning guidelines
      'public-affairs': { kind: 'annex', letter: 'X', title: 'Public Affairs' }, // CFJP 5.0 (2008) ch. 5 annex E app. 1, from the NATO planning guidelines
      fires: { kind: 'within', annex: 'A' }, // CFJP 5.0 (2008) ch. 5 annex E app. 1, from the NATO planning guidelines
      'rules-of-engagement': { kind: 'annex', letter: 'E', title: 'Rules of Engagement' }, // CFJP 5.0 (2008) ch. 5 annex E app. 1, from the NATO planning guidelines
      'health-services': { kind: 'annex', letter: 'K', title: 'Health Service Support' }, // CFJP 5.0 (2008) ch. 5 annex E app. 1, from the NATO planning guidelines
      information: { kind: 'annex', letter: 'O', title: 'Information Operations' }, // CFJP 5.0 (2008) ch. 5 annex E app. 1, from the NATO planning guidelines
      'communication-strategy': NOT_IN_LIST, // CFJP 5.0 (2008) ch. 5 annex E app. 1, from the NATO planning guidelines
      communications: { kind: 'annex', letter: 'Q', title: 'Communications and Information Systems' }, // CFJP 5.0 (2008) ch. 5 annex E app. 1, from the NATO planning guidelines
      'knowledge-management': NOT_IN_LIST, // CFJP 5.0 (2008) ch. 5 annex E app. 1, from the NATO planning guidelines
      environmental: NOT_IN_LIST, // CFJP 5.0 (2008) ch. 5 annex E app. 1, from the NATO planning guidelines
      engineer: { kind: 'annex', letter: 'EE', title: 'Engineer' }, // CFJP 5.0 (2008) ch. 5 annex E app. 1, from the NATO planning guidelines
      legal: { kind: 'annex', letter: 'AA', title: 'Legal' }, // CFJP 5.0 (2008) ch. 5 annex E app. 1, from the NATO planning guidelines
      assessment: { kind: 'within', annex: 'A' }, // CFJP 5.0 (2008) ch. 5 annex E app. 1, from the NATO planning guidelines
      reports: NOT_IN_LIST, // CFJP 5.0 (2008) ch. 5 annex E app. 1, from the NATO planning guidelines
      'foreign-disclosure': NOT_IN_LIST, // CFJP 5.0 (2008) ch. 5 annex E app. 1, from the NATO planning guidelines
      'host-nation-support': NOT_IN_LIST, // CFJP 5.0 (2008) ch. 5 annex E app. 1, from the NATO planning guidelines
      'contracting-finance': { kind: 'annex', letter: 'FF', title: 'Financial Support' }, // CFJP 5.0 (2008) ch. 5 annex E app. 1, from the NATO planning guidelines
      interagency: NO_LETTER('No separate interagency annex; civil-military cooperation is Annex W.'), // CFJP 5.0 (2008) ch. 5 annex E app. 1, from the NATO planning guidelines
      'civil-military-cooperation': { kind: 'annex', letter: 'W', title: 'Civil-Military Cooperation' } // CFJP 5.0 (2008) ch. 5 annex E app. 1, from the NATO planning guidelines
    },
    annexSource: 'CFJP 5.0 Chapter 5 Annex E Appendix 1, adapted from the NATO planning guidelines; AJP-5 points to the COPD for the list (AJP-5 footnote 50)',
    usesNation: true,
    runningEstimateFunctions: 'joint-functions',
    nationFunctions: { ca: 'canadian-operational-functions' },
    informationTerm: 'Information operations'
  }
};

/** The settings defaults (design 10, 2.1): US Joint at operational level; Canada as the nation; contingency planning; horizons of 24 and 96 hours (03 A3; 05 s1). */
// Horizons follow JP 3-33 (2018) ch. II (current operations to 24 hours, future operations to 96 hours); the setting is user-editable.
export const STAFF_DEFAULTS = {
  profile: 'us-joint',
  level: 'operational',
  nation: 'ca',
  planningType: 'contingency',
  horizons: { currentOpsHours: 24, futureOpsHours: 96 }
} as const satisfies { profile: StaffProfileId; level: StaffLevel; nation: StaffNation; planningType: PlanningType; horizons: { currentOpsHours: number; futureOpsHours: number } };

// The staff sections (design 10, sections 3 and 5.5). A section id is the code-neutral name a team file, a product header and an event carry; the code a
// person reads (J-2, G-2, S2) depends on the profile and level (profiles.ts), so a section id never changes when the profile does.
export const STAFF_SECTION_IDS = ['command', 'j1', 'j2', 'j3', 'j4', 'j5', 'j6', 'j7', 'j8', 'j9', 'special-staff'] as const;
export type StaffSectionId = (typeof STAFF_SECTION_IDS)[number];

export interface StaffSection {
  readonly id: StaffSectionId;
  /** The staff number (2 for intelligence); absent for the command group and the special staff, which have no J, G or S code. */
  readonly number?: number;
  readonly function: string;
}

export const STAFF_SECTIONS: Readonly<Record<StaffSectionId, StaffSection>> = {
  command: { id: 'command', function: 'Command group and chief of staff' },
  j1: { id: 'j1', number: 1, function: 'Personnel' },
  j2: { id: 'j2', number: 2, function: 'Intelligence' },
  j3: { id: 'j3', number: 3, function: 'Operations' },
  j4: { id: 'j4', number: 4, function: 'Logistics' },
  j5: { id: 'j5', number: 5, function: 'Plans' },
  j6: { id: 'j6', number: 6, function: 'Communications and CIS' },
  j7: { id: 'j7', number: 7, function: 'Training and lessons' },
  j8: { id: 'j8', number: 8, function: 'Resources and finance' },
  j9: { id: 'j9', number: 9, function: 'Civil-military cooperation' },
  'special-staff': { id: 'special-staff', function: 'Special staff' }
};

// ---- Intelligence terms (WP-INT; design 10, 3.2, 4.4 and 6.2; research note 02) --------------------------------------------------------------

/** Source reliability on the NATO Admiralty scale: a grade of the source, never of the information (AJP-2.1 Edition B; 02 T10, S24). */
export const SOURCE_RELIABILITY = {
  A: 'Completely reliable',
  B: 'Usually reliable',
  C: 'Fairly reliable',
  D: 'Not usually reliable',
  E: 'Unreliable',
  F: 'Reliability cannot be judged'
} as const;
export type SourceReliability = keyof typeof SOURCE_RELIABILITY;
export const SOURCE_RELIABILITY_GRADES = Object.keys(SOURCE_RELIABILITY) as readonly SourceReliability[];

/** Information credibility on the NATO Admiralty scale: a grade of the information, assessed separately from the source (AJP-2.1 Edition B; 02 T10, S24). */
export const INFORMATION_CREDIBILITY = {
  1: 'Completely credible',
  2: 'Probably true',
  3: 'Possibly true',
  4: 'Doubtful',
  5: 'Improbable',
  6: 'Truth cannot be judged'
} as const;
export type InformationCredibility = 1 | 2 | 3 | 4 | 5 | 6;
export const INFORMATION_CREDIBILITY_GRADES: readonly InformationCredibility[] = [1, 2, 3, 4, 5, 6];

/**
 * Credibility 1 means confirmed by other, independent reporting. The 2003 CF joint intelligence doctrine reads grade 1 as "confirmed by other sources"
 * (B-GJ-005-200/FP-000, 2003; 02 T10, S18); AJP-2.1 Edition B names it "completely credible" (S24). The workbench applies the stricter reading.
 */
export const CONFIRMED_CREDIBILITY: InformationCredibility = 1;

/**
 * Intelligence disciplines (JP 2-0, 2022, as summarised in 02, S4). HUMINT, SIGINT, MASINT and CI collection needs legal authority and partner systems,
 * so a template never collects them itself and a collection recommendation for them always needs a partner (02 Summary 8).
 */
export const INTELLIGENCE_DISCIPLINES = ['OSINT', 'GEOINT', 'HUMINT', 'SIGINT', 'MASINT', 'TECHINT', 'CI'] as const;
export type IntelligenceDiscipline = (typeof INTELLIGENCE_DISCIPLINES)[number];
export const PARTNER_ONLY_DISCIPLINES: readonly IntelligenceDiscipline[] = ['HUMINT', 'SIGINT', 'MASINT', 'CI'];

/** PIR register headings: every PIR names the decision point it supports and a latest time of value (design 10, 3.2; 02 T9, S15). */
export const PIR_REGISTER_HEADINGS: readonly string[] = ['Requirement', 'Decision point supported', 'Indicators', 'Latest time of value', 'Status'];

/** Collection plan headings and its rule: the J2 recommends, the J3 approves asset allocation (design 10, 3.2; 02 T10, S15). */
export const COLLECTION_PLAN_HEADINGS: readonly string[] = ['Requirement', 'Indicator', 'NAI', 'Recommended capability', 'Timing', 'Needs J3 approval or partner'];
export const COLLECTION_PLAN_RULE = 'The J2 recommends; the J3 approves the allocation of collection assets.';

/**
 * The two standard NATO intelligence reports the CAF also uses (02, S18): the INTSUM, a periodic summary with an assessment of future intent, and the
 * INTREP, a spontaneous report needing urgent attention, with deductions. Headings from design 10, 3.2 (watch-officer).
 */
export const INTEL_REPORTS = {
  intsum: { name: 'Intelligence summary (INTSUM)', headings: ['Period', 'Significant activity', 'Assessment of intent', 'Changes since last', 'Gaps'] },
  intrep: { name: 'Intelligence report (INTREP)', headings: ['Event', 'Deduction'] }
} as const;

/** The date-time group form `DDHHMMZ MON YY`, in UTC (ACP 121, Communication Instructions General; 02 T11 "DTG helpers"). */
export const DTG_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const;

/**
 * The template ceiling (design 10, 6): staff templates hold exercise and fictional data at org/Internal, NATO Unclassified or Protected A at most, whatever
 * the device allows, because labels are not accreditation. Labels are `scale/level` keys from the Phase 70 scale presets.
 */
export const STAFF_TEMPLATE_LABELS: readonly string[] = ['org/Public', 'org/Internal', 'nato/NATO Unclassified', 'ca-protected/Protected A'];
