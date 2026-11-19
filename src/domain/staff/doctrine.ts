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

// ---- Analytic standards and restricted publications (design 10, 4.2, 4.4 and 7; WP-SHARED) -----------------------------------------------------------

/**
 * The ICD 203 expressions of likelihood, lowest first: the term, the alternative ICD 203 allows, other word forms of the same two (adverbs), and the range
 * of probability in percent (ICD 203, Analytic Standards, 2 January 2015, amended 2022, section D.6.b.(2)(a); 02 T10). A judgement uses one of these words,
 * never another estimative word. NATO/Canadian products use the same table (design 10, 4.4). The one copy of the table: the tradecraft lint, the J2
 * skills and the demo acceptance fixtures all read it.
 */
export const ICD203_LIKELIHOOD: ReadonlyArray<{ readonly term: string; readonly alternative: string; readonly forms: readonly string[]; readonly range: readonly [number, number] }> = [
  { term: 'almost no chance', alternative: 'remote', forms: [], range: [1, 5] },
  { term: 'very unlikely', alternative: 'highly improbable', forms: [], range: [5, 20] },
  { term: 'unlikely', alternative: 'improbable', forms: ['improbably'], range: [20, 45] },
  { term: 'roughly even chance', alternative: 'roughly even odds', forms: [], range: [45, 55] },
  { term: 'likely', alternative: 'probable', forms: ['probably'], range: [55, 80] },
  { term: 'very likely', alternative: 'highly probable', forms: [], range: [80, 95] },
  { term: 'almost certain', alternative: 'nearly certain', forms: ['almost certainly'], range: [95, 99] }
];

/**
 * Confidence levels for a judgement, said in a sentence of its own, never with a likelihood term (ICD 203, 2015, tradecraft standard 2 and section
 * D.6.b.(2)(a); the three levels are ATP 2-33.4, 2020, usage; 02 T10). Written in a product as "<level> confidence".
 */
export const ICD203_CONFIDENCE_LEVELS: readonly string[] = ['high', 'moderate', 'low'];

/**
 * Estimative words outside the ICD 203 table, which a key judgement must not use because a reader cannot tell what probability they mean (ICD 203, section
 * D.6.b.(2)(a), "analytic products should use the terms in the table"; 02 T10). The list is the common offenders, not every word in English.
 */
export const NON_STANDARD_ESTIMATIVE_WORDS: readonly string[] = [
  'possible', 'possibly', 'maybe', 'perhaps', 'conceivable', 'conceivably', 'might', 'could well', 'chances are', 'in all likelihood', 'doubtful', 'presumably', 'plausibly'
];

/**
 * Publications with no public copy, cited by title and edition only (design 10, 2.4 and 7 item 7; 02 T1; 03 A1, B1, B6). A product that names one is checked
 * by the release-guard for text taken from it beyond a citation. APP-28 and the COPD are not here: the NATO/Canadian profile names them as its process.
 */
export const RESTRICTED_PUBLICATION_TITLES: readonly string[] = ['JP 2-0', 'JP 3-04', 'JP 4-0', 'CJCSM 3130.03', 'JIPOE Joint Guide', 'CFJP 2-0', 'CFJP 4-0'];

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

/**
 * Information credibility on the NATO Admiralty scale: a grade of the information, assessed separately from the source (AJP-2.1 Edition B; 02 T10, S24).
 * The words for grade 1 differ between the grade tables (the older Canadian text and US field manuals read "confirmed by other sources"): a product
 * uses its profile's words, IntelligenceTerms.credibilityOne.
 */
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

/**
 * Unit echelons, lowest first, as the echelon amplifiers of the public symbology standards order them (MIL-STD-2525D, 2014, and APP-6(D), 2017, table of
 * echelon amplifiers: team or crew; squad; section; platoon or detachment; company, battery or troop; battalion or squadron; regiment or group; brigade;
 * division; corps; army; army group or front; region or theatre). A slice by echelon ("battalion and above") compares positions in this list (note 11,
 * section 5). The second name of a pair reads as the first through ECHELON_ALIASES; "squadron" is left out on purpose, because a US cavalry squadron is a
 * battalion and a Commonwealth armour squadron is a company, so a scenario names the echelon it means.
 */
export const ECHELONS = ['team', 'squad', 'section', 'platoon', 'company', 'battalion', 'regiment', 'brigade', 'division', 'corps', 'army', 'army-group', 'theatre'] as const;
export type Echelon = (typeof ECHELONS)[number];
export const ECHELON_ALIASES: Readonly<Record<string, Echelon>> = {
  crew: 'team', detachment: 'platoon', battery: 'company', troop: 'company', group: 'regiment', front: 'army-group', region: 'theatre', theater: 'theatre'
};

/**
 * Standard identities (affiliations) of the public symbology standards (MIL-STD-2525D, 2014, and APP-6(D), 2017: pending, unknown, assumed friend,
 * friend, neutral, suspect, hostile; joker and faker are the exercise identities), as Cursor on Target spells them in its type string (`p`, `u`, `a`,
 * `f`, `n`, `s`, `h`, `j`, `k`; note 11 [F1][F58]). A feed's identity is a claim; the J2's assessment is a separate field (note 11, 6.2).
 */
export const STANDARD_IDENTITIES = ['pending', 'unknown', 'assumed-friend', 'friend', 'neutral', 'suspect', 'hostile', 'joker', 'faker'] as const;
export type StandardIdentity = (typeof STANDARD_IDENTITIES)[number];

/** The two adversary COAs every J2 estimate names (JP 2-0 JIPOE step 4; ATP 2-01.3 IPB step 4; design 10, 3.2 and 4.4). */
export const ADVERSARY_COA_TERMS = { mostLikely: 'MLCOA', mostDangerous: 'MDCOA' } as const;

/** Intelligence requirement terms (JP 2-0; design 10, 3.2): priority intelligence requirement, named area of interest, latest time of value. */
export const INTELLIGENCE_REQUIREMENT_TERMS = { pir: 'PIR', nai: 'NAI', ltiov: 'Latest time of value' } as const;

/** PIR register headings: every PIR names the decision point it supports and a latest time of value (design 10, 3.2; 02 T9, S15). */
export const PIR_REGISTER_HEADINGS: readonly string[] = ['Requirement', 'Decision point supported', 'Indicators', INTELLIGENCE_REQUIREMENT_TERMS.ltiov, 'Status'];

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

// ---- Intelligence terms (design 10, 3.2, 4.4 and 6.2 skills; research note 02, tables 2, 6 and 10; WP-J2) ----------------------------------------
// The J2 template and its two skills (icd203-standards, source-grading) read these tables, with the likelihood table and the two grading scales above;
// no other file spells an intelligence process stage, a preparation step, a likelihood term or a grade.

/** The four steps of intelligence preparation, by the name the process uses (design 10, 3.1: JIPOE at joint levels, IPB with OAKOC at tactical level). */
export interface PreparationSteps {
  /** The four steps, in order. */
  readonly steps: readonly [string, string, string, string];
  /** What the steps call the other side: the adversary at joint levels, the threat at tactical level. */
  readonly actor: string;
  readonly source: string;
}

export const INTELLIGENCE_PREPARATION_STEPS: Readonly<Record<'JIPOE' | 'IPB', PreparationSteps>> = {
  // JP 2-0 (2022) is CAC-only and JIPOE is now a joint guide; the public reference edition of the method is JP 2-01.3 (21 May 2014) (02 s1 item 3, T1).
  // AJP-2 (Edition A, 2016) uses the same four steps for NATO JIPOE as far as the public text shows (02 T6); AJP-2's current edition is in design 2.9.
  JIPOE: {
    steps: ['Define the operational environment', 'Describe the impact of the operational environment', 'Evaluate the adversary and other relevant actors', 'Determine adversary and other relevant actor courses of action'],
    actor: 'adversary',
    source: 'JP 2-01.3 (2014), public reference edition of the JIPOE method; JP 2-0 (2022) by title'
  },
  // ATP 2-01.3 (2019 with Change 1, 2021) ch. 1 (02 s1 item 4). The Canadian Army uses the same IPB steps at land tactical level (Land Operations, 2008).
  IPB: {
    steps: ['Define the operational environment', 'Describe environmental effects on operations', 'Evaluate the threat', 'Determine threat courses of action'],
    actor: 'threat',
    source: 'ATP 2-01.3 (2019 with Change 1)'
  }
};

/** The intelligence process a profile names (design 10, 3.2: US Joint uses the six categories, NATO/Canadian the four-stage cycle). */
export interface IntelligenceProcess {
  readonly name: string;
  readonly stages: readonly string[];
  /** Activities that run through every stage (US Army only). */
  readonly continuing?: readonly string[];
  readonly source: string;
}

/** Intelligence terms that change with the profile (research note 02, tables 2, 6 and 10; design 10, 3.2 and 4.4). */
export interface IntelligenceTerms {
  readonly process: IntelligenceProcess;
  /** How requirements and collection are managed under the profile. */
  readonly requirementsManagement: string;
  /** A nation setting that names requirements management differently. */
  readonly nationRequirementsManagement?: Readonly<Partial<Record<StaffNation, string>>>;
  /** What the collection plan is called. */
  readonly collectionPlan: string;
  /** Where the intelligence estimate sits in the plan, where the profile's sources say. */
  readonly estimatePlacement?: string;
  /** The words for credibility grade 1 (the grade tables differ on it: design 10, 4.4). */
  readonly credibilityOne: string;
  /** What units below staff level plan with at tactical level, where the profile offers that level. */
  readonly belowStaffLevel?: string;
  readonly source: string;
}

export const INTELLIGENCE_TERMS: Readonly<Record<StaffProfileId, IntelligenceTerms>> = {
  'us-joint': {
    // The six categories of JP 2-0 (2013), the public reference edition; JP 2-0 (26 May 2022) is the current text and is CAC-only (02 s1 items 1 and 2).
    process: {
      name: 'Joint intelligence process',
      stages: ['Planning and direction', 'Collection', 'Processing and exploitation', 'Analysis and production', 'Dissemination and integration', 'Evaluation and feedback'],
      source: 'JP 2-0 (2022) by title; categories from JP 2-0 (2013), public reference edition'
    },
    // JP 2-01 (5 July 2017), public reference edition: collection requirements management and collection operations management (02 T6).
    requirementsManagement: 'Collection requirements management and collection operations management (CRM and COM)',
    collectionPlan: 'Collection plan',
    // JP 5-0 (1 July 2025): the J-2 intelligence estimate is appendix 11 to annex B (design 10, 3.2, profile differences).
    estimatePlacement: 'Appendix 11 to Annex B (Intelligence)',
    // FM 2-22.3 (2006) app. B and ATP 2-22.9 use "confirmed by other sources" for grade 1; US practice follows them (best judgement; 02 T10).
    credibilityOne: 'Confirmed by other sources',
    source: 'JP 2-0 (2013, 2022); JP 2-01 (2017); JP 5-0 (2025)'
  },
  'us-army': {
    // ADP 2-0 (31 July 2019) ch. 4: four steps and two continuing activities. FM 2-0 (Oct 2023) was seen only second-hand (design 10, 2.4); best judgement.
    process: {
      name: 'Intelligence process',
      stages: ['Plan and direct', 'Collect and process', 'Produce', 'Disseminate'],
      continuing: ['Analyze', 'Assess'],
      source: 'ADP 2-0 (2019) ch. 4; FM 2-0 (2023) by title'
    },
    // FM 3-55 (2013): information collection, and its information collection plan; the brigade collection manager writes it (design 10, 3.2 tactical).
    requirementsManagement: 'Information collection: requirements management and collection management',
    collectionPlan: 'Information collection plan',
    credibilityOne: 'Confirmed by other sources', // FM 2-22.3 (2006) app. B (best judgement; 02 T10)
    belowStaffLevel: 'Troop leading procedures', // FM 5-0 (2024); ATP 2-01.3 (2019) ch. 2 (02 T4)
    source: 'ADP 2-0 (2019); FM 3-55 (2013); FM 5-0 (2024)'
  },
  'nato-ca': {
    // AJP-2 (Edition A, 2016) and the 2003 CF intelligence doctrine: a four-stage cycle (02 s1 item 2, T2). The same four stages as CANADIAN_LAND_TERMS.
    process: {
      name: 'Intelligence cycle',
      stages: [...CANADIAN_LAND_TERMS.intelligenceCycle],
      source: 'AJP-2 (Edition A, 2016); CFJP 2-0 (2003), superseded but the latest public text'
    },
    // AJP-2.1 (Edition B, ratification draft): IRM and CM, formerly CCIRM (02 T6). Canadian plans still name CCIRM (CFJP 5.0 ch. 5 annex E, Annex D).
    requirementsManagement: 'Intelligence requirements management and collection management (IRM and CM, formerly CCIRM)',
    nationRequirementsManagement: { ca: 'CCIRM (collection coordination and intelligence requirements management; NATO now says IRM and CM)' },
    collectionPlan: 'Collection plan',
    // AJP-2.1 (Edition B) grade 1 is "completely credible"; the 2003 CF text reads "confirmed by other sources" (design 10, 4.4; 02 T10).
    credibilityOne: 'Completely credible',
    belowStaffLevel: CANADIAN_LAND_TERMS.belowStaffLevel, // Land Operations (2008): battle procedure for commanders without a staff
    source: 'AJP-2 (2016); AJP-2.1 (Edition B draft); CFJP 5.0 (2008); Land Operations (2008)'
  }
};

/** The five analytic standards (ICD 203, 2015, section D.6.a). */
export const ICD203_ANALYTIC_STANDARDS: readonly string[] = [
  'Objective', 'Independent of political consideration', 'Timely', 'Based on all available sources of intelligence information', 'Implements and exhibits the analytic tradecraft standards'
];

/** The nine analytic tradecraft standards (ICD 203, 2015, section D.6.b). */
export const ICD203_TRADECRAFT_STANDARDS: readonly string[] = [
  'Properly describes quality and credibility of underlying sources, data, and methodologies',
  'Properly expresses and explains uncertainties associated with major analytic judgments',
  'Properly distinguishes between underlying intelligence information and analysts\' assumptions and judgments',
  'Incorporates analysis of alternatives',
  'Demonstrates customer relevance and addresses implications',
  'Uses clear and logical argumentation',
  'Explains change to or consistency of analytic judgments',
  'Makes accurate judgments and assessments',
  'Incorporates effective visual information where appropriate'
];

/** The aspects of terrain at tactical level, OAKOC (ATP 2-01.3, 2019, ch. 4; design 10, 3.1). */
export const TERRAIN_ASPECTS: readonly string[] = ['Observation and fields of fire', 'Avenues of approach', 'Key terrain', 'Obstacles', 'Cover and concealment'];

/** The operational variables, PMESII (JP 2-01.3, 2014, ch. II; JP 5-0, 2025, systems view). */
export const OPERATIONAL_VARIABLES: readonly string[] = ['Political', 'Military', 'Economic', 'Social', 'Information', 'Infrastructure'];

/** The civil considerations, ASCOPE (ATP 2-01.3, 2019, ch. 3; JP 3-57 uses the same six). */
export const CIVIL_CONSIDERATIONS: readonly string[] = ['Areas', 'Structures', 'Capabilities', 'Organizations', 'People', 'Events'];

// ---- J5 planning terms (design 10, 2.6 and 3.3; research note 05; WP-J5) ----
// The J5 plans template, its skills and its tests read these tables; none of them spells a planning term of its own.

/** The eight steps of the operational design method. Design runs before the JPP and alongside mission analysis. */
// JP 5-0 (1 July 2025) ch. III, as recorded in design 10, 2.6 (the 2020 edition had five steps).
export const OPERATIONAL_DESIGN_METHOD: readonly string[] = [
  'Understand the strategic direction and guidance', 'Understand the operational environment', 'Define the problem', 'Identify assumptions',
  'Develop operational approaches', 'Identify decisions and decision points', 'Refine the operational approach', 'Prepare planning guidance'
];

/** The elements of operational design in their groups. Not every element applies to every plan. */
// JP 5-0 (1 July 2025) ch. III; AY26 Campaign Planning Handbook ch. 3 (design 10, 2.6 and 2.8 item 10).
export const OPERATIONAL_DESIGN_ELEMENTS: ReadonlyArray<{ readonly group: string; readonly elements: readonly string[] }> = [
  { group: 'Overarching', elements: ['Objective', 'Transitions', 'Center of gravity', 'Effects', 'Culmination'] },
  { group: 'Organizing the operation', elements: ['Lines of operation', 'Lines of effort', 'Decisive points', 'Direct and indirect approach', 'Operational reach'] },
  { group: 'Time', elements: ['Arranging operations', 'Anticipation'] },
  { group: 'Forces and functions', elements: ['Forces and functions'] },
  { group: 'Balancing', elements: ['Balancing'] }
];

/** The Army design methodology's activities, used at tactical level under US Army when the problem is ill-structured. */
// FM 5-0 (Nov 2024) 1-54 to 1-56 and ch. 4 introduction (05 s2).
export const ARMY_DESIGN_METHODOLOGY_ACTIVITIES: readonly string[] = [
  'Frame the operational environment', 'Frame the problem', 'Develop an operational approach', 'Transition to detailed planning', 'Reframe when the situation changes'
];

/** How each process does design: its name, when it runs, and its source. */
export const DESIGN_APPROACHES: Readonly<Record<StaffProcessId, { readonly name: string; readonly when: string; readonly source: string }>> = {
  jpp: { name: 'Operational design', when: 'before the JPP starts and alongside mission analysis', source: 'JP 5-0 (1 July 2025) ch. III' },
  mdmp: { name: 'Army design methodology (ADM)', when: 'before or alongside mission analysis when the problem is ill-structured; the commander may start the MDMP without it when time is short', source: 'FM 5-0 (Nov 2024) 1-54 to 1-56, ch. 4' },
  'ajp-5': { name: 'Operations design', when: 'inside mission analysis', source: 'AJP-5 Edition B 3.19' },
  // APP-28 has no formal operational design step (05 s3 and s4, from a NATO centre-of-excellence handbook).
  'app-28': { name: 'Problem framing (no formal operational design step)', when: 'only when the commander asks for it on an ill-structured problem', source: 'APP-28 Edition A as summarised in 05 (S7, S15)' }
};

/** The centre of gravity analysis terms, spelled as each profile spells them. */
// JP 5-0 (2020) IV-23 to IV-25 and JP 5-0 (1 July 2025) ch. III (US); AJP-5 Edition B annex B (NATO spelling) (05 T4).
export const COG_TERMS: Readonly<Record<StaffProfileId, { readonly cog: string; readonly capabilities: string; readonly requirements: string; readonly vulnerabilities: string }>> = {
  'us-joint': { cog: 'Center of gravity', capabilities: 'Critical capabilities', requirements: 'Critical requirements', vulnerabilities: 'Critical vulnerabilities' },
  'us-army': { cog: 'Center of gravity', capabilities: 'Critical capabilities', requirements: 'Critical requirements', vulnerabilities: 'Critical vulnerabilities' },
  'nato-ca': { cog: 'Centre of gravity', capabilities: 'Critical capabilities', requirements: 'Critical requirements', vulnerabilities: 'Critical vulnerabilities' }
};

/** What design aims at, per profile. JP 5-0 (2025) no longer uses "military end state"; US Army and NATO/Canadian still do. */
// JP 5-0 (1 July 2025) ch. III; FM 5-0 (Nov 2024); AJP-5 Edition B; design 10, 2.6 and 2.8 item 4.
export const END_STATE_TERMS: Readonly<Record<StaffProfileId, { readonly term: string; readonly usesMilitaryEndState: boolean }>> = {
  'us-joint': { term: 'objectives and the conditions that achieve them', usesMilitaryEndState: false },
  'us-army': { term: 'military end state', usesMilitaryEndState: true },
  'nato-ca': { term: 'military end state', usesMilitaryEndState: true }
};

/** What each COA test asks, in plain words. Every test a profile lists has an entry (the J5 tests hold this). */
// US tests: JP 5-0 (1 July 2025) ch. IV and FM 5-0 (Nov 2024) ch. 5 COA screening criteria. NATO tests: AJP-5 Edition B 3.50, paraphrased.
export const COA_TEST_MEANINGS: Readonly<Record<string, string>> = {
  Suitable: 'It accomplishes the mission within the commander\'s intent and planning guidance.',
  Feasible: 'It can be done with the forces, resources and time available, in the operational environment as it is.',
  Acceptable: 'The expected result is worth the cost in forces, resources, time and risk, and it stays inside the limitations.',
  Distinguishable: 'It differs clearly from every other COA in main effort, scheme, task organization, timing or use of forces.',
  Complete: 'It answers who, what, when, where, why and how, and covers the operation to its end, including sustainment and risk.',
  Feasibility: 'It can be done with the forces, resources and time available.',
  Acceptability: 'The expected result is worth its cost and risk, and it stays inside the limitations.',
  'Completeness and compliance': 'It answers who, what, when, where, why and how, and it complies with the commander\'s planning guidance.',
  Exclusivity: 'It differs clearly from every other COA.',
  Suitability: 'It accomplishes the mission and achieves the commander\'s intent.'
};

/** The wargame turn and the order adversary COAs are played in. */
// FM 5-0 (Nov 2024) 5-133 to 5-165 (action, reaction, counteraction); AJP-5 Edition B 3.58 (most likely, then most dangerous).
export const WARGAME_TURN: readonly string[] = ['Action', 'Reaction', 'Counteraction'];
export const ADVERSARY_COA_ORDER: readonly string[] = [`Most likely adversary COA (${ADVERSARY_COA_TERMS.mostLikely})`, `Most dangerous adversary COA (${ADVERSARY_COA_TERMS.mostDangerous})`];

/** Branches and sequels, kept apart: branches belong to future operations, sequels to the planners. */
// JP 5-0 (2020) IV-39; JP 3-33 (2018) IX-1 (05 T7).
export const BRANCH_AND_SEQUEL = {
  branch: 'A branch is a contingency option inside the current operation, with the trigger that starts it.',
  sequel: 'A sequel is a later operation or phase that follows from a possible outcome of the current one.'
} as const;

/** Measures of performance and effectiveness, kept in separate tables. */
// JP 5-0 (2020) K-19; JP 5-0 (1 July 2025) app. H; AY26 Campaign Planning Handbook (design 10, 2.8 item 10).
export const ASSESSMENT_TERMS = {
  moe: 'Measure of effectiveness (MOE): are we doing the right things, creating the effects and changing the conditions we need?',
  mop: 'Measure of performance (MOP): are we doing things right, completing the tasks we were given?',
  indicator: 'Indicator: a specific, observable and collectable item of information that shows progress toward an MOE or MOP.'
} as const;

/** The joint plan levels (level 3T when a TPFDD is needed). */
// JP 5-0 (1 July 2025) ch. I (design 10, 2.8 item 5).
export const JOINT_PLAN_LEVELS: readonly string[] = [
  'Level 1: commander\'s estimate', 'Level 2: base plan', 'Level 3: concept plan (CONPLAN); 3T when a TPFDD is needed', 'Level 4: operation plan (OPLAN)'
];

/** Time allocation at tactical level: the planners use at most a third of the time and leave two thirds to subordinates. */
// FM 5-0 (Nov 2024) 1-118, 5-21 to 5-22 (05 s2).
export const TIME_RULE = 'One-third, two-thirds rule';

/** Who leads planning at tactical level: never "S-5" unless the person sets it. */
// FM 5-0 (Nov 2024) 1-76 (05 T7); Land Operations (2008) plans centre (design 10, 2.5).
export const TACTICAL_PLANS_CELL = {
  division: 'plans cell led by the G-5',
  brigade: 'plans cell led by the operations officer (S-3)',
  battalion: 'no dedicated plans cell; planning and operations are combined'
} as const;

/** Multidomain operations, the US Army operational concept. It changes what a COA must show, not the planning steps. */
// FM 3-0 (March 2025) 1-9, 3-7, 3-13 to 3-14; FM 5-0 (Nov 2024) introduction (05 s2).
export const MDO_TERMS = {
  concept: 'Multidomain operations',
  tenets: ['Agility', 'Convergence', 'Endurance', 'Depth'],
  domains: ['Air', 'Land', 'Maritime', 'Space', 'Cyberspace'],
  dimensions: ['Physical', 'Informational', 'Human'],
  convergence: 'Convergence synchronizes joint and Army capabilities against combinations of decisive points across domains to create windows of opportunity.',
  profiles: ['us-army']
} as const satisfies { readonly profiles: readonly StaffProfileId[] } & Record<string, unknown>;

/** Profile-specific gates in the J5 workflow, beyond the commander's COA decision. */
// AJP-5 Edition B 3.51 and Stage 4; CFJP 5.0 art. 405 (design 10, 3.3 workflow table).
export const J5_PROFILE_GATES: Readonly<Record<StaffProfileId, { readonly afterCoaDevelopment: string; readonly beforeFullPlan?: string }>> = {
  'us-joint': { afterCoaDevelopment: 'The commander gives guidance on which COAs to analyse.' },
  'us-army': { afterCoaDevelopment: 'The commander gives guidance on which COAs to analyse.' },
  'nato-ca': {
    afterCoaDevelopment: 'The commander gives guidance for the refinement of the tentative COAs (AJP-5 3.51).',
    beforeFullPlan: 'The CONOPS is approved by the higher commander before the full plan is written (AJP-5 Stage 4; CFJP 5.0 art. 405).'
  }
};

/** The red team under each profile. Under NATO/Canadian it is a UK national element, optional, on by default (owner decision Q11). */
// JP 5-0 (1 July 2025) app. G (red team separate from the J-2 red cell); FM 5-0 (Nov 2024); AJP-5 Edition B UK 2.15.
export const RED_TEAM_NOTES: Readonly<Record<StaffProfileId, { readonly note: string; readonly optional: boolean }>> = {
  'us-joint': { note: 'The red team is an independent group, separate from the J-2 red cell, that challenges the planners\' assumptions and logic.', optional: false },
  'us-army': { note: 'The red team is an independent group, separate from the S-2 or G-2 red cell, that challenges the planners\' assumptions and logic.', optional: false },
  'nato-ca': { note: 'Red teaming is a UK national element in AJP-5, not NATO doctrine. It is on by default; the commander may switch it off.', optional: true }
};

// ---- Operations terms (design 10, 3.4; research note 03, part A; WP-J3) -----------------------------------------------------------------------------
// The J3 template and its two skills (running-estimate, execution-loop) read these tables. The running estimate headings are FUNCTION_SETS above, the
// space vocabulary SPACE_MISSION_AREAS, and the horizon lengths come from the staff settings (STAFF_DEFAULTS), never from here.

/**
 * The three venues of planning in execution, by time horizon: what each covers and which body usually owns it. The codes (J-3, J35, G-5) come from the
 * profile; these words are code-neutral.
 */
// JP 5-0 (1 July 2025) ch. IV, planning in execution (03 A3, quoting the 2020 text, which the 2025 edition keeps); JP 3-33 (2018) for the future
// operations cell under the J-3 (J35 in many headquarters, design 10, 3.1).
export const PLANNING_HORIZONS = {
  currentOperations: { name: 'Current operations', covers: 'immediate and near-term issues of the operation under way', owner: 'the operations centre' },
  futureOperations: { name: 'Future operations', covers: 'branches to the current operation', owner: 'the future operations cell of the operations section' },
  futurePlans: { name: 'Future plans', covers: 'the next phase of the operation and sequels', owner: 'the plans section' }
} as const;

/** The current operations body at each level. */
// 03 A13 (JP 3-33, 2018; FM 6-0, May 2022, integrating cells); ATP 6-0.5 (2017) for the battle captain and battle NCO duties (03 A7); Land Operations
// (2008) for the Canadian operations centre (design 10, 2.5).
export const CURRENT_OPERATIONS_BODIES = {
  strategic: 'Command centre or joint operations centre (JOC)',
  operational: 'Joint operations centre (JOC)',
  tactical: 'Tactical operations centre (TOC) or main command post, with the current operations integration cell',
  tacticalDuties: 'the battle captain\'s and battle NCO\'s duties'
} as const;

/** The competition continuum: the J3 at strategic level runs day-to-day campaigning across it, not only crisis response. */
// JP 1 Volume 1, Joint Warfighting (27 August 2023); JP 3-0 (18 June 2022) summary of changes (design 10, 2.8 item 8; 03 A2).
export const COMPETITION_CONTINUUM: readonly string[] = ['Cooperation', 'Competition below armed conflict', 'Armed conflict'];

/** The US Army information activities the information planner synchronizes. */
// ADP 3-13, Information (27 November 2023) (03 A5). JP 3-04 (2022) is not public and is not used.
export const INFORMATION_ACTIVITIES: readonly string[] = ['Enable', 'Protect', 'Inform', 'Influence', 'Attack'];

/** The Canadian Army influence activities, which replace the information operations umbrella in land planning. */
// CADN 16-01, Land Operations Doctrine: an updated summary (27 May 2016) (design 10, 2.5).
export const INFLUENCE_ACTIVITIES: readonly string[] = ['Psychological operations (PSYOPS)', 'Key leader engagement', 'Civil support', 'Posture, profile and presence', 'Media relations'];

/**
 * The six phases of the joint targeting cycle, which may run at the same time and serve deliberate and dynamic targeting. Phase 4 is the commander's
 * decision; working groups prepare and boards decide.
 */
// JP 3-60, Joint Targeting (28 September 2018), released through the DoD FOIA reading room (03 A5). Phase 6: the 2013 edition said "combat assessment";
// the 2018 renaming could not be read in a primary copy (03 gap 3), so the plain name "Assessment" is used, by best judgement.
export const JOINT_TARGETING_CYCLE: readonly string[] = [
  'End state and commander\'s objectives', 'Target development and prioritization', 'Capabilities analysis', 'Commander\'s decision and force assignment',
  'Mission planning and force execution', 'Assessment'
];

/** What every running estimate holds, and the rule that it always carries recommendations for anticipated decisions. */
// FM 5-0, Planning and Orders Production (November 2024), running estimates (03 A6; 03 A14 item 8).
export const RUNNING_ESTIMATE = {
  parts: ['Facts', 'Assumptions', 'Friendly force status', 'Enemy activities and capabilities', 'Civil considerations', 'Conclusions and recommendations, with risk'],
  rule: 'A running estimate always includes recommendations for anticipated decisions; one without them is sent back.'
} as const;

/** The fragmentary order: what it is, and the abbreviation each profile uses. */
// FM 5-0 (November 2024) definition (03 A6); JP 5-0 (1 July 2025) joint orders list, FRAGORD (design 10, 2.8 item 5); NATO and Canadian usage FRAGO
// (CFJP 5.0, 2008, art. 406 writes "Frag O"; Land Operations, 2008), by best judgement where AJP-5 gives no abbreviation.
export const FRAGMENTARY_ORDER = {
  definition: 'An abbreviated order that changes or modifies an order, or executes a branch or sequel; it gives the changes only, in the five-paragraph format.',
  abbreviation: { 'us-joint': 'FRAGORD', 'us-army': 'FRAGORD', 'nato-ca': 'FRAGO' }
} as const satisfies { readonly abbreviation: Readonly<Record<StaffProfileId, string>> } & Record<string, unknown>;

/** The space products the space command owns; the J3 cyber and space planner feeds them and never writes them. */
// JP 3-14, Joint Space Operations (23 August 2023) ch. III (design 10, 3.4, cyber-space-planner).
export const SPACE_COMMAND_PRODUCTS: readonly string[] = ['Space operations directive', 'Master space plan', 'Combined space tasking order (weekly)'];
// ---- Logistics terms (design 10, 2.5 and 3.5; research note 03 part B; WP-J4) -----------------------------------------------------------------

/**
 * The core logistics functions support planning covers, one J4 member each (design 10, 3.5; 03 Summary 3 and B2). Support planning runs at the same time
 * as force planning, from the first step, not after the COA decision (03 B3).
 */
// JP 5-0 (2020) ch. IV support planning, as read for note 03 (03 B2); JP 4-0 (20 July 2023) by title, whose core logistic capabilities use the same areas
// (03 B1; design 10, 2.9). The seven names are unchanged in the JP 5-0 (1 July 2025) the owner supplied (design 10, 2.8: only listed changes apply).
export const CORE_LOGISTICS_FUNCTIONS: readonly string[] = [
  'Deployment and distribution', 'Supply', 'Maintenance', 'Logistic services', 'Operational contract support', 'Joint health services', 'Engineering'
];
/** Support planning runs alongside force planning from step 1 (03 B3, B12 item 6). */
// JP 5-0 (2020) ch. IV: support planning "is conducted concurrently with force planning" (03 B3).
export const SUPPORT_PLANNING_RULE = 'Support planning runs at the same time as force planning, from the first planning step.';

/** The four elements of sustainment, the US Army's frame for the sustainment warfighting function (03 B5). */
// ADP 4-0, Sustainment (July 2019) ch. 1; the 2019 edition made financial management a separate element (03 B5).
export const SUSTAINMENT_ELEMENTS: readonly string[] = ['Logistics', 'Financial management', 'Personnel services', 'Health service support'];

/** The Canadian lines of support, by the level that usually provides them (design 10, 2.5; 03 B6, B11). */
// CFJP 4-0, Support (2016) by title, as quoted by secondary sources (03 B6 [S49][S50]); level mapping 03 B11. Best judgement until CFJP 4-0 is read (design 10, 2.9).
export const CANADIAN_LINES_OF_SUPPORT: ReadonlyArray<{ readonly line: string; readonly meaning: string; readonly level: StaffLevel }> = [
  { line: 'First line', meaning: 'Support organic to the ship, unit or squadron', level: 'tactical' },
  { line: 'Second line', meaning: 'Support organic or allocated to a formation', level: 'tactical' },
  { line: 'Third line', meaning: 'Support to a force in a theatre or along strategic lines of communication (the JTF Support Component)', level: 'operational' },
  { line: 'Fourth line', meaning: 'Strategic resources: national depots, contractors and industry', level: 'strategic' }
];

/** One class of supply: its numeral and what it holds. */
export interface SupplyClass { readonly class: string; readonly holds: string }

/**
 * The classes of supply each profile uses. US Joint and US Army use the ten US classes; NATO and Canada use the five NATO classes. Members forecast by
 * these classes only, and never with a factor table from a government source (03 B5, B12 items 1 and 2).
 */
// US: JP 4-09 (public reference edition) and ATP 4-42 series, the ten classes as US practice lists them (03 B2 [S46]; best judgement).
// NATO/Canadian: AAP-06, NATO Glossary of Terms and Definitions, "class of supply" (five classes); Canada follows NATO terms first (design 10, 2.5).
export const SUPPLY_CLASSES: Readonly<Record<StaffProfileId, readonly SupplyClass[]>> = {
  'us-joint': [
    { class: 'I', holds: 'Subsistence and water' }, { class: 'II', holds: 'Clothing, individual equipment, tools and administrative supplies' },
    { class: 'III', holds: 'Petroleum, oils and lubricants' }, { class: 'IV', holds: 'Construction and barrier materiel' }, { class: 'V', holds: 'Ammunition' },
    { class: 'VI', holds: 'Personal demand items' }, { class: 'VII', holds: 'Major end items' }, { class: 'VIII', holds: 'Medical materiel' },
    { class: 'IX', holds: 'Repair parts' }, { class: 'X', holds: 'Materiel to support nonmilitary programs' }
  ],
  'us-army': [
    { class: 'I', holds: 'Subsistence and water' }, { class: 'II', holds: 'Clothing, individual equipment, tools and administrative supplies' },
    { class: 'III', holds: 'Petroleum, oils and lubricants' }, { class: 'IV', holds: 'Construction and barrier materiel' }, { class: 'V', holds: 'Ammunition' },
    { class: 'VI', holds: 'Personal demand items' }, { class: 'VII', holds: 'Major end items' }, { class: 'VIII', holds: 'Medical materiel' },
    { class: 'IX', holds: 'Repair parts' }, { class: 'X', holds: 'Materiel to support nonmilitary programs' }
  ],
  'nato-ca': [
    { class: 'I', holds: 'Subsistence (food and forage) consumed at a broadly uniform rate' },
    { class: 'II', holds: 'Items with an established table of allowances: clothing, weapons, tools, spare parts and vehicles' },
    { class: 'III', holds: 'Petroleum, oils and lubricants for all purposes' },
    { class: 'IV', holds: 'Items without an established table of allowances, such as fortification and construction materiel' },
    { class: 'V', holds: 'Ammunition, explosives and chemical agents of all types' }
  ]
};

/** The logistics status report and the words in it (03 B5, B12 item 7). */
// "The Trouble with LOGSTATs" (11 Feb 2025) and the battalion-to-brigade LOGSTAT flow (03 B5 [S45][S46]); FM 4-0 calls a LOGSTAT data that needs analysis.
export const LOGSTAT_TERMS = {
  report: 'LOGSTAT',
  /** How far ahead a LOGSTAT projects needs (03 B5 [S46]). */
  forecastHours: 72,
  /** The words a LOGSTAT uses, each defined per commodity and echelon in the project's logstat-definitions skill. */
  fields: ['On hand', 'Received', 'Consumed', 'Capacity', 'Required', 'Days of supply'],
  /** The logistics common operational picture the JLOC keeps (03 B5, B8). */
  picture: 'LOGCOP'
} as const;

/** One profile's logistics words: what the section and its estimate are called, and its current-operations centre per level. */
export interface LogisticsTerms {
  /** The function the J4, G4 or S4 serves: logistics (joint), sustainment (US Army). */
  readonly function: string;
  readonly estimate: string;
  /** The logistics estimate at strategic level, one of the joint strategic estimates (03 B3). */
  readonly strategicEstimate: string;
  /** The overview that starts the estimate in step 1 (03 B3): "theater" in US spelling, "theatre" in NATO and Canadian. */
  readonly overview: string;
  readonly conceptOfSupport: string;
  /** Reception of forces in the theatre and their move forward (JRSOI, RSOI or RSOM). */
  readonly reception: string;
  /** The logistics current-operations centre at each level. Always qualified: a JTF J4 JLOC is not the DLA one (03 B4, B12 item 3). */
  readonly currentOps: Readonly<Record<StaffLevel, string>>;
  readonly source: string;
}

// JP 5-0 (2020) ch. IV and app. A (theater logistics overview, logistics estimate, Annex D); JP 4-0 (2023) ch. V JLOC by title (03 B3, B4); FM 5-0 (Nov 2024)
// running estimates and Annex F (03 B3); ADP 4-0 (2019) (03 B5); AJP-4 by title, CFJP 4-0 (2016) by title and the JTF Support Component (03 B6). Best
// judgement where a level has no named centre: the plain description, never an invented branch name (03 A8 gap, B12 item 3).
export const LOGISTICS_TERMS: Readonly<Record<StaffProfileId, LogisticsTerms>> = {
  'us-joint': {
    function: 'Logistics',
    estimate: 'Logistics estimate',
    strategicEstimate: 'Joint logistics estimate',
    overview: 'Theater logistics overview',
    conceptOfSupport: 'Concept of support',
    reception: 'Joint reception, staging, onward movement and integration (JRSOI)', // JP 3-35 (2018) (03 B1, B2)
    currentOps: { strategic: 'CCMD J4 joint logistics operations center (CCMD J4 JLOC)', operational: 'JTF J4 joint logistics operations center (JTF J4 JLOC)', tactical: 'Not offered at tactical level' },
    source: 'JP 5-0 (2020, 2025); JP 4-0 (2023) by title'
  },
  'us-army': {
    function: 'Sustainment',
    estimate: 'Sustainment estimate',
    strategicEstimate: 'Not offered at strategic level',
    overview: 'Sustainment overview',
    conceptOfSupport: 'Concept of support',
    reception: 'Reception, staging, onward movement and integration (RSOI)', // ATP 3-35 (2015) Army deployment doctrine (best judgement)
    currentOps: { strategic: 'Not offered at strategic level', operational: 'Not offered at operational level', tactical: 'Sustainment cell current operations, with the supporting unit\'s support operations officer' },
    source: 'FM 5-0 (2024); ADP 4-0 (2019)'
  },
  'nato-ca': {
    function: 'Logistics',
    estimate: 'Logistics estimate',
    strategicEstimate: 'Strategic logistics estimate',
    overview: 'Theatre logistics overview',
    conceptOfSupport: 'Concept of logistic support',
    reception: 'Reception, staging and onward movement (RSOM)', // AJP-3.13, Deployment and Redeployment of Forces, by title (best judgement)
    currentOps: { strategic: 'Strategic J4 logistics operations centre', operational: 'JTF J4 joint logistics operations centre (JTF J4 JLOC)', tactical: 'Combat service support (CSS) current operations cell' },
    source: 'AJP-4 and AJP-5 by title; CFJP 4-0 (2016) by title (03 B6)'
  }
};

/** The reports a deployed Canadian operation sends to the CJOC J4 desk, alongside the LOGSTAT (design 10, 2.5; 03 B6, B12 item 9). */
// DND evaluation of CAF operational support (2021) as summarised in 03 B6 [S52]: a weekly logistics report plus equipment, ammunition status and
// ammunition expenditure reports to the CJOC Joint Support (J4) desk. Report names are plain descriptions until CFJP 4-0 is read (design 10, 2.9).
export const CANADIAN_J4_REPORTS = {
  weekly: 'Weekly logistics report',
  others: ['Equipment status report', 'Ammunition status report', 'Ammunition expenditure report'],
  to: 'the CJOC J4 desk',
  cadence: 'weekly'
} as const;
