// The J5 plans team template (design 10, 3.3; research note 05; WP-J5): the second staff demo team. Pure: no I/O, no clock, no vscode.
//
// One template, rendered for the project's staff settings: the doctrine profile and level pick the process, the step names, the COA tests, the design
// approach, the staff codes and the annex letters (all from src/domain/staff); the planning type picks the human who leads staff planning (the J5
// director, or the J3 director in a crisis, JP 5-0 2025); the variant swaps COA cell B for a convergence planner under US Army multidomain operations.
// Every variant has at most 12 members, each with its own products, and a release guard. Members recommend; named people decide.
//
// Two members are held to their files by the extension, not only by their instructions: the red team writes only its critique and the release guard only
// its verdicts (src/domain/staff/writeLimits.ts). No member has a persona name or a rank.
import {
  ADVERSARY_COA_ORDER, BRANCH_AND_SEQUEL, COA_TEST_MEANINGS, COG_TERMS, DESIGN_APPROACHES, END_STATE_TERMS, J5_PROFILE_GATES, MDO_TERMS,
  OPERATIONAL_DESIGN_METHOD, RED_TEAM_NOTES, SPACE_MISSION_AREAS, TIME_RULE, WARGAME_TURN
} from '../../domain/staff/doctrine';
import type { AnnexSubject, CrosswalkStep, StaffLevel, StaffProfileId } from '../../domain/staff/doctrine';
import type { ProductKind } from '../../domain/staff/products';
import { STAFF_MARKERS, staffPreambleText } from '../../domain/staff/products';
import { defaultStaffSettings, describePlacement, resolveProfile, sectionCode } from '../../domain/staff/profiles';
import type { ResolvedProfile, StaffSettings } from '../../domain/staff/profiles';
import type { StaffTeamBlock } from '../../domain/staff/teamBlock';
import { RED_TEAM_PRODUCT, STAFF_FOLDER, staffGuardFolder, staffProductPath } from '../../domain/staff/writeLimits';
import { renderTeam } from '../teams';
import { GATE_VERBS, GUARD_SCAN, LEAD_VERBS, OWNER_VERBS, STAFF_REGISTER_TOOL, STAFF_STEP_TOOL, STAFF_WARGAME_TOOL, staffProductTools } from './grants';

export type J5Variant = 'standard' | 'mdo';
export const J5_VARIANTS: readonly J5Variant[] = ['standard', 'mdo'];

export interface J5TemplateOptions {
  /** The project's staff settings (parseStaffSettings or defaultStaffSettings). */
  readonly settings: StaffSettings;
  /** `mdo` replaces COA cell B with a convergence planner. Offered only under the profiles MDO_TERMS lists (US Army). */
  readonly variant?: J5Variant;
  /** The red team, on by default. It may be switched off only where the profile marks it optional (NATO/Canadian, owner decision Q11). */
  readonly redTeam?: boolean;
  /** A local-only project has no web access through NEAR: its members carry no web tools (as projectTypeTeam does). */
  readonly locality?: 'cloud' | 'local';
}

export type ModelTier = 'deep' | 'standard' | 'fast';

/** One product the J5 drafts: exactly one owning member, the step it is first produced in, and its kind (which picks the Staff Room renderer). */
export interface J5Product { readonly product: string; readonly kind: ProductKind; readonly owner: string; readonly step: CrosswalkStep }

export interface J5Member {
  readonly name: string;
  readonly role: string;
  readonly model: ModelTier;
  readonly tools: readonly string[];
  readonly reportsTo?: string;
  readonly instructions: string;
}

/** One lane: a member and what it does in the step. */
export interface J5Lane { readonly member: string; readonly does: string }

/**
 * One crosswalk step of the lead's workflow. `parallel` lanes start in the same turn; `sequence` lanes run one after another (the wargame, where turn
 * order matters); `alongside` lanes run beside the merge (the red team's review). The merge is done by one integrator, after the lanes it needs.
 */
export interface J5WorkflowStep {
  readonly step: CrosswalkStep;
  readonly name: string;
  readonly parallel: readonly J5Lane[];
  readonly sequence: readonly J5Lane[];
  readonly alongside: readonly J5Lane[];
  readonly merge?: J5Lane;
  /** The products the merge reads: the outputs of the lanes it brings together. */
  readonly mergeReads: readonly string[];
  readonly gate: string;
  /** Whether the gate is a person's decision (agents stop there). */
  readonly humanGate: boolean;
}

export interface J5Template {
  readonly name: string;
  readonly description: string;
  readonly block: StaffTeamBlock;
  readonly members: readonly J5Member[];
  readonly products: readonly J5Product[];
  readonly workflow: readonly J5WorkflowStep[];
  readonly resolved: ResolvedProfile;
  readonly variant: J5Variant;
  readonly redTeam: boolean;
  /** The human role that leads staff planning: the J5 director, or the J3 director in a crisis; the G-5 or S-3 at tactical level. */
  readonly planningLead: string;
}

/** The skills every J5 member may read, under `.planning/staff/skills/` (design 10, 6.2). */
export const J5_SKILLS = ['planning-templates', 'wargame-ledger', 'cog-analysis', 'assessment-framework'] as const;
export type J5Skill = (typeof J5_SKILLS)[number];
export const skillPath = (skill: J5Skill): string => `${STAFF_FOLDER}/skills/${skill}.md`;

const READ = ['Read', 'Glob', 'Grep', 'TodoWrite', 'Recall', 'Remember'];
const WRITE = ['Write', 'Edit'];
const WEB = ['WebSearch', 'WebFetch', 'CheckCitations'];
const DOCS = ['CreateDocument', 'CreatePdf', 'CreatePresentation', 'RenderSvg'];
// The built-in staff servers, by role (grants.ts, the same scheme as the J2): owners register their products and propose rows to the shared registers;
// the lead-planner, the section's integrator, also submits and withdraws, marks the step and runs the wargame ledger with the plans-writer, who records
// it; the release guard runs guard-scan and records verdicts. The red team may register only its critique (the host refuses any other product for it).
const OWNER = [...staffProductTools(OWNER_VERBS), STAFF_REGISTER_TOOL];
const LEAD = [...staffProductTools(LEAD_VERBS), STAFF_REGISTER_TOOL, STAFF_STEP_TOOL, STAFF_WARGAME_TOOL];
const RECORDER = [...OWNER, STAFF_WARGAME_TOOL];
const RED_TEAM_TOOLS = staffProductTools(OWNER_VERBS);
const GATE = [...staffProductTools(GATE_VERBS), GUARD_SCAN];

/** Why options were refused: a variant or red-team setting the profile does not offer. */
export class J5TemplateError extends Error {}

const path = (product: string): string => staffProductPath('j5', product);
/** The Owns line: product slugs become their files; anything with a slash or a space is written as it is. */
const owns = (...products: string[]): string => `Owns: ${products.map((product) => (/[/ ]/.test(product) ? product : path(product))).join(', ')}.`;
const list = (items: readonly string[]): string => items.join(', ');
const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);
/** The adversary COAs in the order they are played: "the most likely adversary COA (MLCOA) and then the most dangerous adversary COA (MDCOA)". */
const adversaryOrder = (): string => ADVERSARY_COA_ORDER.map((coa) => `the ${lowerFirst(coa)}`).join(' and then ');
/** The plans layer of the COP, which the lead-planner owns: COA sketches only. */
const PLANS_LAYER = 'the COP plans layer (cop-plans-layer: COA sketches only, never merged into the current picture)';

interface Context {
  readonly resolved: ResolvedProfile;
  readonly profile: StaffProfileId;
  readonly level: StaffLevel;
  readonly variant: J5Variant;
  readonly redTeam: boolean;
  readonly web: boolean;
  readonly planningLead: string;
  readonly crisis: boolean;
  /** The staff codes a person reads: the J5 (or G-5) and the J3 (or S-3). */
  readonly plansCode: string;
  readonly opsCode: string;
  readonly intelCode: string;
  readonly logCode: string;
  readonly stepNames: Readonly<Record<CrosswalkStep, string>>;
}

function stepLabel(resolved: ResolvedProfile, step: CrosswalkStep): string {
  const entry = resolved.steps.find((candidate) => candidate.step === step)!;
  return entry.name ?? `${entry.work} (${entry.note ?? 'not a step in this process'})`;
}

function contextFor(options: J5TemplateOptions): Context {
  const { settings } = options;
  const resolved = resolveProfile(settings);
  const variant = options.variant ?? 'standard';
  if (variant === 'mdo' && !(MDO_TERMS.profiles as readonly string[]).includes(settings.profile)) {
    throw new J5TemplateError(`The multidomain operations variant is a US Army option; the ${resolved.profile.name} profile does not offer it.`);
  }
  const redTeam = options.redTeam ?? true;
  if (!redTeam && !RED_TEAM_NOTES[settings.profile].optional) {
    throw new J5TemplateError(`The red team cannot be switched off under the ${resolved.profile.name} profile.`);
  }
  const tactical = settings.level === 'tactical';
  const code = (section: 'j2' | 'j3' | 'j4' | 'j5', echelon: 'higher' | 'lower' = 'higher') => sectionCode(settings.profile, settings.level, section, echelon) as string;
  const crisis = settings.planningType === 'crisis';
  // At tactical level the plans cell is the G-5's at division and the S-3's at brigade, never an "S-5" (FM 5-0 1-76); in a crisis the operations officer leads.
  const planningLead = tactical
    ? (crisis ? `${code('j3')} or ${code('j3', 'lower')} (operations officer)` : `${code('j5')} (division) or ${code('j3', 'lower')} (brigade)`)
    : resolved.planning.leadRole;
  const stepNames = Object.fromEntries(resolved.steps.map((step) => [step.step, stepLabel(resolved, step.step)])) as Record<CrosswalkStep, string>;
  return {
    resolved, profile: settings.profile, level: settings.level, variant, redTeam, web: (options.locality ?? 'cloud') !== 'local', planningLead, crisis,
    plansCode: code('j5'), opsCode: tactical ? code('j3', 'lower') : code('j3'), intelCode: tactical ? code('j2', 'lower') : code('j2'),
    logCode: tactical ? code('j4', 'lower') : code('j4'), stepNames
  };
}

/** Where the profile files a subject, in plain words (an annex letter, an appendix, a part of another annex, or ask a person). */
const annex = (ctx: Context, subject: AnnexSubject): string => describePlacement(ctx.resolved.annexes.find((entry) => entry.subject === subject)!.placement);

function testsText(ctx: Context): string {
  return `${ctx.resolved.coaTests.map((test) => `${test}: ${lowerFirst(COA_TEST_MEANINGS[test]).replace(/\.$/, '')}`).join('; ')}.`;
}

const preamble = (): string => staffPreambleText();
const decisionFor = (role: string): string => `\`${STAFF_MARKERS.decisionFor} ${role}\``;

// ---- Members -----------------------------------------------------------------------------------------------------------------------------------------

function leadPlanner(ctx: Context): J5Member {
  const tactical = ctx.level === 'tactical';
  const design = DESIGN_APPROACHES[ctx.resolved.process.id];
  const gates = J5_PROFILE_GATES[ctx.profile];
  const steps = ([1, 2, 3, 4, 5, 6, 7] as const).map((step) => `${step}. ${ctx.stepNames[step]}`).join('; ');
  const cellB = ctx.variant === 'mdo' ? 'convergence-planner' : 'coa-cell-b';
  const ownList = [
    'planning-timeline', 'warning-order', 'facts-assumptions-ledger', ...(tactical ? ['guidance-analysis', 'limitations-list'] : []), 'restated-mission', 'proposed-intent',
    'mission-analysis-brief', 'coa-themes', 'coa-validity', 'sync-matrix', 'dst-dsm', PLANS_LAYER, 'comparison-matrix', 'coa-decision-brief', 'sequel-list',
    'conops', 'transition-brief'
  ];
  const text = [
    preamble(),
    `Job: you are the chief of plans. You lead the planning group, run the ${ctx.resolved.process.name} for the ${ctx.resolved.profile.name} profile at ${ctx.level} level, control the wargame and integrate every member's work into the step's outputs. The steps, in the names PROFILE.md gives them: ${steps}. Staff planning is led by the ${ctx.planningLead}: name that role in every planning-group decision and hand-off.${ctx.crisis ? ' This is crisis planning: steps may run at the same time. Start the next step\'s lanes as soon as their inputs exist, and say which inputs are still drafts.' : ''}`,
    tactical
      ? `At this level you also do the guidance analysis: read the higher order, list the specified, implied and essential tasks, and the constraints and restraints with legal-support. Build the timeline back from the time the order is due and apply the ${lowerFirst(TIME_RULE)}: the plans cell keeps at most a third of the time and leaves two thirds to subordinates. Issue warning orders early and often.${ctx.resolved.landTerms ? ` Short-range planning and FRAGOs belong to the operations centre; units below staff level plan by ${lowerFirst(ctx.resolved.landTerms.belowStaffLevel)}, so give them warning orders they can start from.` : ''}`
      : 'Build the planning timeline back from the time the plan is due, with a suspense for every product, and issue a warning order at the start and whenever the work changes direction.',
    `Design comes first. At step 1 have the design-planner start the design work, ${design.name} (${design.when}), and integrate its problem statement and draft operational approach into mission analysis.`,
    'Each step: start every lane that does not need another lane\'s output in the same turn, as the workflow in .planning/staff/skills/planning-templates.md shows. Each member writes only its own files. You merge their products into the step\'s outputs, settle conflicts by asking the owners (never by rewriting their products), and check the whole before the gate.',
    `Mission analysis: integrate the members' estimates into the facts and assumptions ledger (every assumption with its owner, how it will be confirmed, and the event that would invalidate it), the specified, implied and essential tasks, the limitations, the COA evaluation criteria from the design-planner, CCIR proposals, a proposed restated mission and a proposed commander's intent. Run the red team's review beside your integration and show its findings in the mission analysis brief.`,
    `COA development: before the cells start, write coa-themes, giving coa-cell-a and ${cellB} each a distinct theme inside the commander's guidance (a different main effort, approach, axis, domain emphasis or phasing). Start both COA owners and the red-cell-seat in the same turn. When both COAs are in, you alone integrate them: apply every test in this order and record pass, fail or risk with the reason in coa-validity: ${testsText(ctx)} If two COAs are not distinguishable, reshape them or send one back with a new theme; never pass two versions of one plan. A third COA comes from the design-planner only when the commander asks for one. Then the gate: ${lowerFirst(gates.afterCoaDevelopment)}`,
    `Wargame: you are the controller. Wargame one COA at a time against the same adversary COAs, ${adversaryOrder()}, so the results compare. Every turn is ${list(WARGAME_TURN)}: the owning COA member and the future operations seat play the friendly side, the red-cell-seat plays the adversary to win, sustainment and legal note issues, and the plans-writer records every turn. From the record you draft the sync matrix, the DST and DSM and the decision points. The branch list is the ${ctx.level === 'strategic' ? 'component' : 'future operations'} seat's; the sequel list (later operations or phases) is yours. Ask the red team for its bias check after each COA's wargame.`,
    'Comparison: score each COA against the evaluation criteria and weights the commander approved, with the rationale for every score, and recommend one COA with its main risk and the mitigation. Place the red team\'s dissent beside your recommendation, unedited.',
    `Decision: write the decision brief content and ${decisionFor('commander')} with the options, your recommendation and the risk; the plans-writer builds the deck. The commander decides; agents never select.`,
    `Plan: write the CONOPS first${gates.beforeFullPlan ? `. ${gates.beforeFullPlan}` : ''}. Then the annex owners write in their own files and the plans-writer assembles; you make one integration pass for consistency of intent, tasks, timings and risk. Transition: with the future operations seat, prepare the transition brief. ${ctx.resolved.planning.transition.note}`,
    owns(...ownList),
    'Boundary: "Your output is a recommendation with risk, not a selected COA."',
    `Hands back: the step's outputs above, the open WAITING ON items, and the list of ${decisionFor('<role>')} items for the people who decide (restated mission, intent, CCIRs, COAs to analyse, COA, plan).`
  ].join('\n\n');
  return { name: 'lead-planner', role: ctx.resolved.landTerms
      ? `Chief of plans: ${lowerFirst(ctx.resolved.landTerms.planningCentres[0])}; wargame controller`
      : tactical ? `Chief of plans: plans cell under the ${ctx.opsCode} at brigade or the ${ctx.plansCode} at division; wargame controller` : `Chief of plans: planning group lead and wargame controller (${ctx.plansCode})`, model: 'deep', tools: [...READ, ...WRITE, ...DOCS, ...LEAD], instructions: text };
}

function policyPlanner(ctx: Context): J5Member {
  const strategic = ctx.level === 'strategic';
  const products = ['guidance-analysis', 'limitations-list', 'interagency-inputs', ...(strategic ? ['strategic-estimate', 'ipr-material'] : [])];
  const text = [
    preamble(),
    `Job: analyse the direction and policy that bound this plan. Read the higher directive and the policy texts in the scenario; list what they require (objectives, tasks, timings) and what they forbid or impose: the constraints (what must be done) and restraints (what must not be done), drafted with legal-support. Turn the political and diplomatic context into planning factors: partners, host nation, other government departments and the information environment.${strategic ? ' At this level you also write the strategic estimate and the material for in-progress reviews with the civilian leadership, and you shape the COAs as options for national decision makers.' : ''}`,
    `Interagency: draft the interagency inputs (${annex(ctx, 'interagency')}) and the questions other departments must answer, and send them to the plans-writer's annex tracker by proposal.`,
    ctx.web
      ? 'Use WebSearch and WebFetch only for public doctrine and public policy texts, and never put a detail of the scenario in a query: a query shows what you are interested in. Cite each text by title, issuer and date.'
      : 'This project has no web access: work from the texts in the project, and cite each by title, issuer and date.',
    owns(...products),
    'Boundary: "Your output is analysis of direction and policy, not operational design and not COAs."',
    `Hands back: the guidance analysis with every requirement traced to its source paragraph, the limitations list, the interagency inputs${strategic ? ', the strategic estimate and the review material' : ''}, and any ${decisionFor('<role>')} item a policy question raises.`
  ].join('\n\n');
  return { name: 'policy-planner', role: 'Strategy and policy planner: higher direction, limitations, interagency', model: 'deep', tools: [...READ, ...(ctx.web ? WEB : []), ...WRITE, ...OWNER], reportsTo: 'lead-planner', instructions: text };
}

function designPlanner(ctx: Context): J5Member {
  const process = ctx.resolved.process.id;
  const design = DESIGN_APPROACHES[process];
  const cog = COG_TERMS[ctx.profile];
  const endState = END_STATE_TERMS[ctx.profile];
  const method = process === 'jpp'
    ? `Follow the eight steps of the method: ${OPERATIONAL_DESIGN_METHOD.map((step, index) => `${index + 1}. ${step}`).join('; ')}.`
    : process === 'mdmp'
      ? 'Run the Army design methodology only when the commander finds the problem ill-structured; otherwise frame the problem briefly and go straight to the COG analysis and the evaluation criteria.'
      : process === 'app-28'
        ? 'This process has no formal operational design step: frame the problem only when the commander asks for it, and otherwise give the COG analysis and the evaluation criteria.'
        : 'Operations design sits inside mission analysis: frame the environment and the problem, then build the operational approach with the planning group.';
  const text = [
    preamble(),
    `Job: ${design.name} (${design.when}; ${design.source}). ${method} Read .planning/staff/skills/cog-analysis.md first.`,
    `Analyse the ${cog.cog.toLowerCase()} of the adversary and of our force: ${cog.capabilities.toLowerCase()}, ${cog.requirements.toLowerCase()} and ${cog.vulnerabilities.toLowerCase()}, each traced to evidence from the red-cell-seat or the scenario. Build the operational approach: lines of operation and lines of effort, decisive points, ${endState.usesMilitaryEndState ? `the ${endState.term} and the objectives that lead to it` : `the ${endState.term}`}, and the transitions between phases. Draw the approach as an SVG with RenderSvg.`,
    `Then turn the design into the COA evaluation criteria (each with a definition, a measure and a proposed weight for the commander to approve) and the assessment plan, built as .planning/staff/skills/assessment-framework.md shows, filed as ${annex(ctx, 'assessment')}. The assessment plan transitions to the ${ctx.opsCode} assessment cell at transition; until then it is yours.`,
    'A third COA (coa-c) is yours to draft only when the commander asks for one, in a theme the lead-planner gives.',
    owns('problem-statement', 'cog-analysis', 'operational-approach', 'coa-evaluation-criteria', 'assessment-plan', 'coa-c'),
    'Boundary: "Your output is the design and the measures, not COAs."',
    'Hands back: the problem statement, the COG analysis, the operational approach and its graphic, the evaluation criteria and the assessment plan, each with the assumptions it rests on listed for the lead-planner\'s ledger.'
  ].join('\n\n');
  return { name: 'design-planner', role: `${design.name} and assessment framework`, model: 'deep', tools: [...READ, ...WRITE, 'RenderSvg', ...OWNER], reportsTo: 'lead-planner', instructions: text };
}

function coaCellA(ctx: Context): J5Member {
  const text = [
    preamble(),
    'Job: build COA A in the theme the lead-planner wrote for you in coa-themes. Until it is written, write WAITING ON j5: COA themes and prepare only the inputs. Default lens for theme A: the direct approach. Concentrate the main effort against the adversary\'s centre of strength or along the most direct line to the objective, accept risk in the other areas, and aim for the earliest decisive action.',
    'Build it from the restated mission, the commander\'s intent and guidance, the adversary COAs from the red-cell-seat and the operational approach. Write the COA statement so it answers who, what, when, where, why and how: the main effort and the supporting efforts, the phases and the conditions that end each phase, the initial task organization, the deployment concept, the sustainment concept in outline and the main risks. Draw the sketch as an SVG with RenderSvg and propose its features to the lead-planner\'s plans layer.',
    `Keep COA A independent: draft it before you read COA B. Then say in one paragraph how A differs from B. Test A yourself against the profile's tests (${list(ctx.resolved.coaTests)}) and record pass, fail or risk with the reason; ask the future operations seat and the sustainment seat for their feasibility checks by proposal.`,
    'In the wargame you play the friendly side of COA A with the future operations seat.',
    owns('coa-a', path('coa-a').replace(/\.md$/, '-sketch.svg')),
    'Boundary: "Your output is one distinct COA; you do not compare COAs."',
    'Hands back: the COA A statement and sketch, its self-test, the paragraph on how it differs, and the questions it leaves open for the lead-planner.'
  ].join('\n\n');
  return { name: 'coa-cell-a', role: 'COA development cell A', model: 'standard', tools: [...READ, ...WRITE, 'RenderSvg', ...OWNER], reportsTo: 'lead-planner', instructions: text };
}

function coaCellB(ctx: Context): J5Member {
  const text = [
    preamble(),
    'Job: develop a second, separate course of action, COA B, under the theme assigned to cell B in coa-themes; while none is assigned, write WAITING ON j5: COA themes and only gather material. Default lens for theme B is indirect: go after the adversary\'s critical vulnerabilities rather than its strength, on another axis, in another domain or with another phasing than A, shape the conditions first, and preserve combat power for the decisive moment.',
    'Inputs: commander\'s guidance and intent, restated mission, operational approach, adversary COA set. The finished statement covers the who, what, when, where, why and how of B: efforts and their purpose, phasing with its transitions, the starting task organization, how forces deploy, an outline of sustainment, and the chief risks. Produce its sketch as an SVG (RenderSvg) and send the features to the plans layer through a proposal.',
    `Independence matters: finish your draft of B before opening coa-a, then record in one paragraph what separates B from A. Score B on each profile test (${list(ctx.resolved.coaTests)}) as pass, fail or risk with a reason, and request feasibility checks from the future operations and sustainment seats by proposal.`,
    'During the wargame cell B plays our side when COA B is on the table.',
    owns('coa-b', path('coa-b').replace(/\.md$/, '-sketch.svg')),
    'Boundary: "Your output is one distinct COA; you do not compare COAs."',
    'Return: COA B statement, sketch, self-test result, the paragraph separating it from A, and open questions for the lead-planner.'
  ].join('\n\n');
  return { name: 'coa-cell-b', role: 'COA development cell B', model: 'standard', tools: [...READ, ...WRITE, 'RenderSvg', ...OWNER], reportsTo: 'lead-planner', instructions: text };
}

function convergencePlanner(ctx: Context): J5Member {
  const text = [
    preamble(),
    `Job: under ${MDO_TERMS.concept.toLowerCase()} you replace the second COA cell. ${MDO_TERMS.convergence} Build COA B around convergence in the theme coa-themes gives you (WAITING ON j5: COA themes until it does): which echelon converges which capabilities, across the domains (${list(MDO_TERMS.domains)}) and dimensions (${list(MDO_TERMS.dimensions)}), against which decisive points, and when. Use the tenets (${list(MDO_TERMS.tenets)}) to test it.`,
    'For both COAs, write the convergence matrix: one row per domain, the windows of opportunity each convergence opens with their start and end, the capability and the echelon that provides it, and the lead time of every request to a supporting command. Propose those rows to the lead-planner\'s sync matrix; never write it yourself.',
    `Space requests use the JP 3-14 (2023) mission areas and no other space terms: ${list(SPACE_MISSION_AREAS)}. Terms that edition retired are refused by the vocabulary check. Where a capability's details are unknown or not public, say so plainly and never guess them.`,
    `Draft COA B before reading COA A, then say how they differ. Self-test COA B against the profile's tests (${list(ctx.resolved.coaTests)}). In the wargame you play the friendly side of COA B.`,
    owns('coa-b', path('coa-b').replace(/\.md$/, '-sketch.svg'), 'convergence-matrix'),
    'Boundary: "Your output is one distinct COA and the convergence rows; you do not compare COAs."',
    'Hands back: the COA B statement and sketch, its self-test, the convergence matrix with its windows of opportunity and lead times, and the open questions.'
  ].join('\n\n');
  return { name: 'convergence-planner', role: 'Convergence planner: multidomain COA and windows of opportunity', model: 'standard', tools: [...READ, ...WRITE, 'RenderSvg', ...OWNER], reportsTo: 'lead-planner', instructions: text };
}

function redCellSeat(ctx: Context): J5Member {
  const text = [
    preamble(),
    `Job: you are the ${ctx.intelCode} seat in the planning group and play the adversary. From the scenario and the ${ctx.resolved.process.intelligencePreparation} products, write the adversary COAs before any friendly COA is built: at least ${ADVERSARY_COA_ORDER.map((coa) => `the ${lowerFirst(coa)}`).join(' and ')}, each with a situation template described in words, a COA statement, the adversary's objective and the capabilities it relies on. Give the design-planner the adversary's capabilities and vulnerabilities as evidence for the COG analysis.`,
    'In the wargame you play the adversary commander to win: for every friendly action, choose the strongest realistic reaction the adversary\'s doctrine, capabilities and the terrain allow, and say why. Log each reaction and what it taught us about the event template and the intelligence requirements.',
    'Fictional scenario only: never a real unit, person or place outside the exercise. When the J2 section team is present, its red cell takes this seat and you hand over your log.',
    owns('adversary-coas', 'red-cell-log'),
    'Boundary: "Your output is the adversary\'s view, not a critique of our plan (that is the red team\'s)."',
    `Hands back: the adversary COA set with the most likely and most dangerous named, the red cell log, and proposed intelligence requirements for the ${ctx.intelCode}.`
  ].join('\n\n');
  return { name: 'red-cell-seat', role: `${ctx.intelCode} red cell seat: adversary COAs and the adversary in the wargame`, model: 'standard', tools: [...READ, ...WRITE, ...OWNER], reportsTo: 'lead-planner', instructions: text };
}

function redTeamMember(ctx: Context): J5Member {
  const note = RED_TEAM_NOTES[ctx.profile];
  const text = [
    preamble(),
    `Job: you are the independent red team. ${note.note} You challenge the planners; you do not plan. You report to the human chief of staff, not to the lead-planner, and nobody in the planning group edits or softens your findings: your dissent goes into the decision brief unedited.`,
    'When: at the end of mission analysis (beside the lead-planner\'s integration), after each COA\'s wargame, and on the draft plan before the guard.',
    'How: run a key assumptions check on the facts and assumptions ledger (is each assumption necessary, supported, and given an invalidation trigger?); look for bias toward a favourite COA, mirror imaging of the adversary, anchoring on the first idea and analogies that do not fit; check that every COA test was applied honestly and that the red cell played to win; write a short premortem (the plan has failed: why?); and offer at least one alternative explanation for each key judgement.',
    owns(RED_TEAM_PRODUCT),
    'That is the only file you may write. The extension refuses every other write, plan files included, so report what should change instead of changing it.',
    'Boundary: "Your output is critique; you never fix the plan."',
    'Hands back: numbered findings, each with its severity (critical, high, medium, low), the evidence, the product and version it concerns, and what would change your view; and a one-paragraph dissent for the decision brief when you disagree with the recommendation.'
  ].join('\n\n');
  return { name: 'red-team', role: 'Independent red team (reports to the human chief of staff)', model: 'deep', tools: [...READ, 'Write', ...RED_TEAM_TOOLS], instructions: text };
}

function operationsSeat(ctx: Context): J5Member {
  const strategic = ctx.level === 'strategic';
  const name = strategic ? 'component-seat' : 'future-ops-seat';
  const who = strategic ? 'component and supporting command seat' : ctx.level === 'tactical' ? `${ctx.opsCode} operations seat` : `${ctx.opsCode} future operations seat`;
  const text = [
    preamble(),
    strategic
      ? 'Job: you speak for the components and the supporting commands. In mission analysis, give the forces and capabilities they can make available and when, and the supporting plans they must write. In the wargame you play the components\' moves for the friendly side.'
      : `Job: you are the ${who}. In mission analysis, write the force availability statement: each unit or capability that is assigned or can be requested, its readiness, when it can arrive, and what holding it for this plan takes away from current operations. In the wargame you play the friendly side's manoeuvre with the COA owner, and you watch the horizons in PROFILE.md: what falls inside the future operations horizon is yours to turn into branches.`,
    `${BRANCH_AND_SEQUEL.branch} You own the branch list. For each branch write the decision point, the indicator that warns of it and the intelligence requirement behind that indicator, the trigger, the branch itself in one paragraph, the forces it needs, and the decision maker. Ask the red-cell-seat and the sustainment seat to check each branch by proposal before you mark it ready. ${BRANCH_AND_SEQUEL.sequel} Those belong to the lead-planner; send any you find to it.`,
    `With the lead-planner, prepare the transition: a checklist of what the ${ctx.opsCode} must receive (the plan, the DST and DSM, the sync matrix, the branch list, the assessment plan), the conditions that must hold before the plan is handed over, and the open risks. When the J3 section team is present, its future operations planner takes this seat.`,
    owns('force-availability', 'branch-list', 'transition-checklist'),
    'Boundary: "Your output is branches; sequels belong to the lead-planner."',
    'Hands back: the force availability statement, the branch list with triggers and decision makers, and the transition checklist.'
  ].join('\n\n');
  return { name, role: who.charAt(0).toUpperCase() + who.slice(1), model: 'standard', tools: [...READ, ...WRITE, ...OWNER], reportsTo: 'lead-planner', instructions: text };
}

function sustainmentSeat(ctx: Context): J5Member {
  const text = [
    preamble(),
    `Job: you are the ${ctx.logCode} seat. In mission analysis, give the logistics estimate inputs: the sustainment situation, the lines of communication and their protection, ports, airfields and host nation support (${annex(ctx, 'host-nation-support')}), the critical items and shortfalls (propose the ones that matter as CCIRs), and where operational reach runs out. For each COA, judge sustainment feasibility (supportable, supportable with a stated risk and when it bites, or not supportable) and send it to the COA owner and the lead-planner, naming the phase where the COA would culminate for lack of support.`,
    'Consumption per COA and phase comes only from factors the user enters (rates, force list, days), multiplied out with the formula shown beside every number. Never invent a rate, and never use a government factor table. A number without its formula and inputs is not ready.',
    `In the wargame, note each turn's sustainment effects and the logistics decision points. In plan development, draft the sustainment inputs for ${annex(ctx, 'logistics')}; the ${ctx.logCode} section writes the annex itself when it is present.`,
    owns('logistics-estimate-inputs', 'coa-sustainment-feasibility', 'sustainment-annex-inputs'),
    `Boundary: "Your output is feasibility evidence, not the concept of support (that is the ${ctx.logCode}'s)."`,
    'Hands back: the logistics estimate inputs, the feasibility judgement per COA with its formulas, the logistics decision points, and the annex inputs.'
  ].join('\n\n');
  return { name: 'sustainment-seat', role: `${ctx.logCode} sustainment seat: logistics inputs and feasibility`, model: 'standard', tools: [...READ, ...WRITE, ...OWNER], reportsTo: 'lead-planner', instructions: text };
}

function legalSupport(ctx: Context): J5Member {
  const text = [
    preamble(),
    'Job: assist the human legal adviser. Draft the legal considerations for the limitations (with the policy work), for each COA and for the plan, and list the questions the legal adviser must answer. Cover the legal basis and mandate given in the scenario, the status of forces and host nation arrangements, the law of armed conflict (distinction, proportionality, precautions, the treatment of detained persons and of civilians), protected sites, and environmental limits.',
    'Rules of engagement: for each COA, list the measures it would need that the current rules may not allow, each as a request with the situation, the measure, why it is needed and the risk of not having it. In the wargame, note each turn that raises a legal issue as a question for the legal adviser, never as a ruling.',
    `Rules of engagement are filed as ${annex(ctx, 'rules-of-engagement')}; legal input as ${annex(ctx, 'legal')}.`,
    `Every product you write carries the line ${STAFF_MARKERS.legalReview}, and no product of yours says that anything is lawful, cleared or approved.`,
    owns('legal-considerations'),
    'Boundary: "Your output is a draft for a qualified legal adviser to review; it is never legal advice and never clears anything."',
    'Hands back: the legal considerations draft per COA and for the plan, and the numbered questions for the legal adviser.'
  ].join('\n\n');
  return { name: 'legal-support', role: 'Legal support: drafts for the human legal adviser', model: 'standard', tools: [...READ, ...WRITE, ...OWNER], reportsTo: 'lead-planner', instructions: text };
}

function firesSeat(ctx: Context): J5Member {
  const text = [
    preamble(),
    `Job: you are the fires seat in the plans cell. In mission analysis, state the fires capabilities available to the force, their ranges, their ammunition limits and the time each needs to respond, so the COA owners plan with real limits. For each COA, draft the concept of fires: the purpose of fires in each phase, the priority of fires by phase, the effects wanted on notional target categories (lethal and non-lethal), and the coordination measures the scheme needs. File the fires inputs as ${annex(ctx, 'fires')}.`,
    'Work with others by proposal: with the red-cell-seat on which adversary capabilities matter most in each phase; with the sustainment seat on the ammunition each COA consumes; with the design-planner on how the effects of fires will be measured. In the wargame, say for each turn what fires the friendly side needs, what they could achieve and what they cost, and propose the fires row of the sync matrix to the lead-planner.',
    `Targets stay notional, as categories inside the exercise box. The no-strike and restricted lists come from a person; check every concept against them and against the protection of civilians. Every fires product carries ${decisionFor('commander or delegate')} and ${STAFF_MARKERS.legalReview}.`,
    owns('concept-of-fires', 'fires-inputs'),
    'Boundary: "Your output is a concept and inputs; you never nominate or approve a real target."',
    'Hands back: the concept of fires per COA and the fires inputs for the order.'
  ].join('\n\n');
  return { name: 'fires-seat', role: 'Fires seat: concept of fires per COA', model: 'standard', tools: [...READ, ...WRITE, ...OWNER], reportsTo: 'lead-planner', instructions: text };
}

function plansWriter(ctx: Context): J5Member {
  const process = ctx.resolved.process.id;
  const format = process === 'jpp'
    ? 'the joint plan at the level the higher directive asks for (commander\'s estimate, base plan, concept plan or operation plan)'
    : process === 'ajp-5' ? 'the CONOPS first and then the OPLAN with its annexes' : 'the five-paragraph order (situation, mission, execution, sustainment, command and signal)';
  const strategic = ctx.level === 'strategic';
  const text = [
    preamble(),
    'Job: you are the recorder and the writer. In the wargame, record every turn in the wargame record as .planning/staff/skills/wargame-ledger.md shows: action, reaction, counteraction, result, decision points and the time of each, keeping what happened apart from what was judged. The lead-planner drafts the sync matrix, DST and DSM from your record, so record nothing you did not see.',
    `In plan development, assemble ${format} from the CONOPS and the annexes, in the format .planning/staff/skills/planning-templates.md gives. Keep the annex tracker: each annex with its letter taken from PROFILE.md (never from memory), its owner, its status and its version. Check consistency across the plan: the same names, times, task organization and decision points everywhere, and every cross-reference resolving.`,
    `Build the brief decks from the lead-planner's content: the mission analysis brief and the COA decision brief${strategic ? ', and the in-progress review decks' : ''}. Make each deck with CreatePresentation and the plan with CreateDocument, regenerating them whenever their source changes. The red team's dissent goes into the decision brief word for word.`,
    owns('wargame-record', 'annex-tracker', 'base-plan', 'brief-decks'),
    'Boundary: "Your output is the assembled document; annex content belongs to its owners."',
    'Hands back: the wargame record, the annex tracker, the assembled plan or order with its open-items list, and the decks.'
  ].join('\n\n');
  return { name: 'plans-writer', role: 'Plans writer: orders production, wargame recorder, annex tracker', model: 'standard', tools: [...READ, ...WRITE, ...DOCS, ...RECORDER], reportsTo: 'lead-planner', instructions: text };
}

function releaseGuard(_ctx: Context): J5Member {
  const text = [
    preamble(),
    'Job: you are the blocking release gate. Before any J5 product goes to a person for a decision, check its current version. Run guard-scan on it first, then judge what rules cannot. Record the verdict with mcp__staff-products__verdict on the exact version you checked; the tool writes your report beside the product.',
    `Hold the product if it contains: a classification or caveat marking of any scale (TOP SECRET, SECRET, CONFIDENTIAL used as a marking, NATO RESTRICTED and above, PROTECTED B or C, CUI, EYES ONLY, REL TO and the like); coordinates outside the exercise box; a name on the project's real-entity list; text from a publication that is not public; a decision written as made ("selected", "approved", "the commander will") instead of marked ${decisionFor('<role>')}; a legal product without ${STAFF_MARKERS.legalReview}; a consumption number with no formula; or personal data.`,
    'Check compilation: whether items that are each releasable reveal more together. A suspected compilation is a HOLD with the question for a person with authority. Check that the red team\'s dissent reached the decision brief unedited.',
    owns(`the verdict files under ${staffGuardFolder('j5')} (one per product version, named <product>-v<version>.md)`),
    'Those are the only files you may write. The extension refuses every other write, the product you judge included.',
    'Boundary: "Your output is a verdict and reasons; you never release and you never fix."',
    'Hands back: a verdict file that ends with exactly CLEARED or HOLD, with the numbered reasons and the product version it applies to.'
  ].join('\n\n');
  return { name: 'release-guard', role: 'Release guard: blocking check before any decision', model: 'standard', tools: [...READ, 'Write', ...GATE], reportsTo: 'lead-planner', instructions: text };
}

// ---- Products and workflow ---------------------------------------------------------------------------------------------------------------------------

function productsFor(members: readonly J5Member[], strategic: boolean): J5Product[] {
  const has = (name: string) => members.some((member) => member.name === name);
  const cellB = has('convergence-planner') ? 'convergence-planner' : 'coa-cell-b';
  const ops = has('component-seat') ? 'component-seat' : 'future-ops-seat';
  const policy = has('policy-planner') ? 'policy-planner' : 'lead-planner';
  const rows: Array<[string, ProductKind, string, CrosswalkStep]> = [
    ['planning-timeline', 'plan', 'lead-planner', 1], ['warning-order', 'order', 'lead-planner', 1], ['guidance-analysis', 'estimate', policy, 1],
    ['limitations-list', 'register', policy, 2], ['interagency-inputs', 'annex', 'policy-planner', 7], ['strategic-estimate', 'estimate', 'policy-planner', 2],
    ['ipr-material', 'brief', 'policy-planner', 8],
    ['problem-statement', 'report', 'design-planner', 1], ['cog-analysis', 'estimate', 'design-planner', 2], ['operational-approach', 'plan', 'design-planner', 2],
    ['coa-evaluation-criteria', 'register', 'design-planner', 2], ['assessment-plan', 'plan', 'design-planner', 2], ['coa-c', 'coa-statement', 'design-planner', 3],
    ['facts-assumptions-ledger', 'register', 'lead-planner', 2], ['restated-mission', 'report', 'lead-planner', 2], ['proposed-intent', 'report', 'lead-planner', 2],
    ['mission-analysis-brief', 'brief', 'lead-planner', 2], ['coa-themes', 'plan', 'lead-planner', 3], ['coa-validity', 'register', 'lead-planner', 3],
    ['coa-a', 'coa-statement', 'coa-cell-a', 3], ['coa-b', 'coa-statement', cellB, 3], ['convergence-matrix', 'matrix', 'convergence-planner', 3],
    ['adversary-coas', 'adversary-coa-set', 'red-cell-seat', 2], ['red-cell-log', 'report', 'red-cell-seat', 4], [RED_TEAM_PRODUCT, 'critique', 'red-team', 2],
    ['force-availability', 'estimate', ops, 2], ['branch-list', 'register', ops, 4], ['transition-checklist', 'register', ops, 8],
    ['logistics-estimate-inputs', 'estimate', 'sustainment-seat', 2], ['coa-sustainment-feasibility', 'register', 'sustainment-seat', 3],
    ['sustainment-annex-inputs', 'annex', 'sustainment-seat', 7], ['legal-considerations', 'report', 'legal-support', 2],
    ['concept-of-fires', 'plan', 'fires-seat', 3], ['fires-inputs', 'annex', 'fires-seat', 7],
    ['sync-matrix', 'matrix', 'lead-planner', 4], ['dst-dsm', 'matrix', 'lead-planner', 4], ['cop-plans-layer', 'map-layer', 'lead-planner', 3],
    ['wargame-record', 'register', 'plans-writer', 4], ['comparison-matrix', 'matrix', 'lead-planner', 5], ['coa-decision-brief', 'brief', 'lead-planner', 6],
    ['brief-decks', 'brief', 'plans-writer', 2], ['sequel-list', 'register', 'lead-planner', 4], ['conops', 'plan', 'lead-planner', 7],
    ['annex-tracker', 'register', 'plans-writer', 7], ['base-plan', 'plan', 'plans-writer', 7], ['transition-brief', 'brief', 'lead-planner', 8]
  ];
  const strategicOnly = ['strategic-estimate', 'ipr-material'];
  return rows.filter(([product, , owner]) => has(owner) && (strategic || !strategicOnly.includes(product))).map(([product, kind, owner, step]) => ({ product, kind, owner, step }));
}

function workflowFor(ctx: Context, members: readonly J5Member[]): J5WorkflowStep[] {
  const has = (name: string) => members.some((member) => member.name === name);
  const cellB = has('convergence-planner') ? 'convergence-planner' : 'coa-cell-b';
  const ops = has('component-seat') ? 'component-seat' : 'future-ops-seat';
  const lane = (member: string, does: string): J5Lane[] => (has(member) ? [{ member, does }] : []);
  const redTeam: J5Lane[] = lane('red-team', 'Reviews the work independently; its findings go to the human chief of staff and the decision brief unedited.');
  const gates = J5_PROFILE_GATES[ctx.profile];
  const name = (step: CrosswalkStep) => ctx.stepNames[step];
  return [
    {
      step: 1, name: name(1),
      parallel: [...lane('lead-planner', 'Planning timeline and warning order.'), ...lane('policy-planner', 'Guidance analysis of the higher directive.'),
        ...lane('design-planner', `${DESIGN_APPROACHES[ctx.resolved.process.id].name}: initial framing and problem statement.`),
        ...lane('red-cell-seat', `Starts the ${ctx.resolved.process.intelligencePreparation} inputs and the adversary picture.`)],
      sequence: [], alongside: [], merge: { member: 'lead-planner', does: 'Merges the start products into the first warning order.' },
      mergeReads: ['planning-timeline', 'guidance-analysis', 'problem-statement'].filter((product) => has('policy-planner') || product !== 'guidance-analysis'),
      gate: 'The commander\'s initial planning guidance.', humanGate: true
    },
    {
      step: 2, name: name(2),
      parallel: [...lane('design-planner', 'COG analysis, operational approach, evaluation criteria and the assessment plan draft.'),
        ...lane('policy-planner', 'Limitations with legal-support; interagency factors.'), ...lane('legal-support', 'Legal considerations for the limitations.'),
        ...lane('red-cell-seat', 'Adversary COAs, most likely and most dangerous.'), ...lane(ops, 'Force availability.'),
        ...lane('sustainment-seat', 'Logistics estimate inputs.'), ...lane('fires-seat', 'Fires capabilities and limits.')],
      sequence: [], alongside: redTeam,
      merge: { member: 'lead-planner', does: 'Integrates facts and assumptions, tasks, limitations, criteria, CCIR proposals, a proposed restated mission and intent, and the mission analysis brief.' },
      mergeReads: ['cog-analysis', 'operational-approach', 'coa-evaluation-criteria', 'adversary-coas', 'force-availability', 'logistics-estimate-inputs', 'legal-considerations']
        .filter((product) => product !== 'force-availability' || has(ops)),
      gate: 'Release guard, then the mission analysis brief: the commander approves the restated mission and issues intent and planning guidance.', humanGate: true
    },
    {
      step: 3, name: name(3),
      parallel: [...lane('coa-cell-a', 'Builds COA A in its assigned theme.'), ...lane(cellB, 'Builds COA B in its assigned theme.'),
        ...lane('red-cell-seat', 'Refines the adversary COAs against the emerging friendly COAs.'), ...lane(ops, 'Force checks on each COA as it is drawn.'),
        ...lane('sustainment-seat', 'Sustainment feasibility of each COA.'), ...lane('fires-seat', 'Concept of fires per COA.')],
      sequence: [], alongside: [],
      merge: { member: 'lead-planner', does: `Applies the COA tests (${list(ctx.resolved.coaTests)}) to every COA, checks they are distinguishable, and reshapes or returns any that are not. One integrator, not parallel.` },
      mergeReads: ['coa-a', 'coa-b', 'adversary-coas', 'coa-sustainment-feasibility'],
      gate: gates.afterCoaDevelopment, humanGate: true
    },
    {
      step: 4, name: name(4), parallel: [],
      sequence: [...lane('lead-planner', `Controls the wargame: one COA at a time against ${adversaryOrder()}, each turn ${list(WARGAME_TURN)}.`),
        ...lane('red-cell-seat', 'Plays the adversary to win.'), ...lane('coa-cell-a', 'Plays the friendly side of COA A.'), ...lane(cellB, 'Plays the friendly side of COA B.'),
        ...lane(ops, 'Friendly manoeuvre and branches.'), ...lane('sustainment-seat', 'Sustainment effects and logistics decision points.'),
        ...lane('legal-support', 'Legal questions raised by each turn.'), ...lane('plans-writer', 'Records every turn in the wargame record.')],
      alongside: redTeam.map((entry) => ({ ...entry, does: 'Bias check after each COA\'s wargame.' })),
      merge: { member: 'lead-planner', does: 'Drafts the sync matrix, DST and DSM from the wargame record; the sequel list.' },
      mergeReads: ['wargame-record', 'branch-list'].filter((product) => product !== 'branch-list' || has(ops)), gate: 'None (an optional COA analysis brief).', humanGate: false
    },
    {
      step: 5, name: name(5),
      parallel: [...lane('sustainment-seat', 'Scores sustainment criteria.'), ...lane(ops, 'Scores risk and tempo criteria.'), ...lane('red-cell-seat', 'Scores adversary risk.'),
        ...lane('design-planner', 'Scores criteria tied to the objectives.'), ...lane('legal-support', 'Notes legal risk per COA.')],
      sequence: [], alongside: [], merge: { member: 'lead-planner', does: 'Comparison matrix and recommendation with risk; red team dissent placed beside it unedited.' },
      mergeReads: ['coa-evaluation-criteria', 'wargame-record'], gate: 'None.', humanGate: false
    },
    {
      step: 6, name: name(6),
      parallel: [...lane('lead-planner', 'Decision brief content and recommendation.'), ...lane('plans-writer', 'Builds the decision brief deck.')],
      sequence: [], alongside: redTeam.map((entry) => ({ ...entry, does: 'Dissent paragraph for the decision brief.' })), mergeReads: [],
      gate: 'The commander decides. Agents never select.', humanGate: true
    },
    {
      step: 7, name: name(7),
      parallel: [...lane('lead-planner', 'Writes the CONOPS first.'), ...lane('plans-writer', 'Assembles the base plan or order and keeps the annex tracker.'),
        ...lane('sustainment-seat', 'Sustainment annex inputs.'), ...lane('policy-planner', 'Interagency inputs.'), ...lane('legal-support', 'Legal considerations for the plan.'),
        ...lane('design-planner', 'Assessment plan in final form.'), ...lane(ops, 'Branches in final form.'), ...lane('fires-seat', 'Fires inputs.')],
      sequence: [], alongside: redTeam.map((entry) => ({ ...entry, does: 'Reviews the draft plan before the guard.' })),
      merge: { member: 'lead-planner', does: 'One integration pass for intent, tasks, timings and risk; the plans-writer checks consistency.' },
      mergeReads: ['conops', 'base-plan', 'annex-tracker', 'assessment-plan'],
      gate: `Release guard; the commander signs.${gates.beforeFullPlan ? ` ${gates.beforeFullPlan}` : ''}`, humanGate: true
    },
    {
      step: 8, name: name(8),
      parallel: [...lane('lead-planner', 'Transition brief.'), ...lane(ops, 'Transition checklist.'), ...lane('design-planner', `Hands the assessment plan to the ${ctx.opsCode} assessment cell.`)],
      sequence: [], alongside: [], merge: { member: 'lead-planner', does: ctx.resolved.planning.transition.note },
      mergeReads: ['transition-brief', 'transition-checklist'].filter((product) => product !== 'transition-checklist' || has(ops)),
      gate: `The ${ctx.opsCode} accepts the plan.`, humanGate: true
    }
  ];
}

// ---- The template ------------------------------------------------------------------------------------------------------------------------------------

/** The J5 template for the options. Throws J5TemplateError for a variant or red-team setting the profile does not offer. */
export function j5Template(options: J5TemplateOptions): J5Template {
  const ctx = contextFor(options);
  const tactical = ctx.level === 'tactical';
  const members: J5Member[] = [
    leadPlanner(ctx),
    ...(tactical ? [] : [policyPlanner(ctx)]),
    designPlanner(ctx),
    coaCellA(ctx),
    ctx.variant === 'mdo' ? convergencePlanner(ctx) : coaCellB(ctx),
    redCellSeat(ctx),
    ...(ctx.redTeam ? [redTeamMember(ctx)] : []),
    operationsSeat(ctx),
    ...(tactical ? [firesSeat(ctx)] : []),
    sustainmentSeat(ctx),
    legalSupport(ctx),
    plansWriter(ctx),
    releaseGuard(ctx)
  ];
  const products = productsFor(members, ctx.level === 'strategic');
  const workflow = workflowFor(ctx, members);
  const where = `${ctx.resolved.profile.name}, ${ctx.level}${ctx.resolved.settings.nation ? `, ${ctx.resolved.settings.nation}` : ''}${ctx.variant === 'mdo' ? ', multidomain' : ''}${ctx.crisis ? ', crisis' : ''}`;
  const name = tactical ? `Plans cell (${where})` : `${ctx.plansCode} plans (${where})`;
  const description = `${tactical ? 'Plans cell' : `${ctx.plansCode} plans section`}: members draft their own products in parallel lanes, the lead-planner integrates each step, two COA owners build distinct COAs at once, the red team critiques independently, and a named person makes every decision.`;
  const block: StaffTeamBlock = {
    section: 'j5', profile: ctx.profile, level: ctx.level, glyph: 'compass', humanLead: ctx.planningLead,
    steps: { 1: 'primary', 2: 'primary', 3: 'primary', 4: 'primary', 5: 'primary', 6: 'supporting', 7: 'primary', 8: 'supporting' },
    products: products.map((product) => product.product), layers: ['cop-plans-layer']
  };
  return { name, description, block, members, products, workflow, resolved: ctx.resolved, variant: ctx.variant, redTeam: ctx.redTeam, planningLead: ctx.planningLead };
}

/** The team file for the options: private, with the `staff:` block, one section per member. */
export function renderJ5Team(options: J5TemplateOptions): string {
  const template = j5Template(options);
  return renderTeam(template.name, template.description, template.members.map((member) => ({
    name: member.name, role: member.role, model: member.model, tools: [...member.tools], ...(member.reportsTo ? { reportsTo: member.reportsTo } : {}), instructions: member.instructions
  })), { private: true, staff: template.block });
}

/** The lead's workflow as a Markdown table, for the project guidance and the planning-templates skill. */
export function renderJ5Workflow(template: J5Template): string {
  const lanes = (entries: readonly J5Lane[], joiner: string) => entries.map((entry) => `${entry.member}: ${entry.does}`).join(joiner);
  const rows = template.workflow.map((step) => {
    const work = [
      step.parallel.length ? `In parallel: ${lanes(step.parallel, ' / ')}` : '',
      step.sequence.length ? `At the table, one COA at a time, turn by turn: ${lanes(step.sequence, ' / ')}` : '',
      step.alongside.length ? `Alongside: ${lanes(step.alongside, ' / ')}` : ''
    ].filter(Boolean).join('<br>');
    return `| ${step.step} ${step.name} | ${work} | ${step.merge ? `${step.merge.member}: ${step.merge.does}` : 'None'} | ${step.humanGate ? '**A person decides.** ' : ''}${step.gate} |`;
  });
  return ['| Step | Lanes | Merge (one integrator) | Gate |', '|---|---|---|---|', ...rows].join('\n');
}

/** The J5 block of the project guidance (AGENTS.md): who leads, the rules every run follows, and the workflow per step. */
export function j5Guidance(options: J5TemplateOptions): string {
  const template = j5Template(options);
  const { resolved } = template;
  return [
    `## Staff team: ${template.name}`,
    '',
    `Profile ${resolved.profile.name} at ${resolved.settings.level} level, running the ${resolved.process.name} (${resolved.process.publication}). Staff planning is led by the ${template.planningLead}. Every member reads .planning/staff/PROFILE.md first and the skills in .planning/staff/skills/.`,
    '',
    '- **Separate areas, then merge.** Start every lane that does not need another lane\'s output in the same turn. Each member writes only its own products under .planning/staff/products/j5/ and proposes changes to anyone else\'s in .planning/staff/proposals/. The lead-planner merges each step and settles conflicts with the owners.',
    `- **Two COAs at once, one integrator.** The lead-planner gives each COA owner a distinct theme first; both build at once; then the lead-planner alone applies the COA tests (${list(resolved.coaTests)}) and reshapes any COAs that are not distinct.`,
    `- **The wargame is played in order.** One COA at a time, against ${adversaryOrder()}, each turn ${list(WARGAME_TURN)}; the plans-writer records it and the matrices come from the record.`,
    `- **The red team is independent.** ${RED_TEAM_NOTES[resolved.settings.profile].note} It reports to the human chief of staff, and the extension lets it write only its critique. Its dissent reaches the decision brief unedited.${template.redTeam ? '' : ' It is switched off in this project.'}`,
    '- **People decide.** Agents mark decisions `DECISION FOR: <role>` and never write that anything is selected, approved or released. The release guard checks every product before it goes to a person, and writes only its verdicts.',
    ...(resolved.planning.concurrentSteps ? ['- **Crisis planning.** Steps may run at the same time; say which inputs are still drafts.'] : []),
    '',
    renderJ5Workflow(template),
    ''
  ].join('\n');
}

/** Every option set the template offers: each offered profile and level (and nation), each planning type, the MDO variant where offered, and the NATO/Canadian red-team switch. */
export function j5OptionSets(): J5TemplateOptions[] {
  const sets: J5TemplateOptions[] = [];
  const combos: Array<Pick<StaffSettings, 'profile' | 'level' | 'nation'>> = [
    { profile: 'us-joint', level: 'strategic' }, { profile: 'us-joint', level: 'operational' }, { profile: 'us-army', level: 'tactical' },
    ...(['strategic', 'operational', 'tactical'] as const).flatMap((level) => (['ca', 'nato'] as const).map((nation) => ({ profile: 'nato-ca' as const, level, nation })))
  ];
  for (const combo of combos) {
    for (const planningType of ['campaign', 'contingency', 'crisis'] as const) {
      const settings: StaffSettings = { ...defaultStaffSettings(), ...combo, planningType };
      for (const variant of J5_VARIANTS) {
        if (variant === 'mdo' && !(MDO_TERMS.profiles as readonly string[]).includes(combo.profile)) continue;
        sets.push({ settings, variant });
        if (RED_TEAM_NOTES[combo.profile].optional) sets.push({ settings, variant, redTeam: false });
      }
    }
  }
  return sets;
}
