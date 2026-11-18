// The J5 skills (design 10, 6.2; research note 05, section 5): planning templates, the wargame ledger, centre of gravity analysis and the assessment
// framework. Each is a Markdown file the members read from `.planning/staff/skills/`, written for the project's profile and level so every term,
// step name and annex letter in it is the profile's. The person can read and edit them. Pure: no I/O, no clock, no vscode.
import {
  ADVERSARY_COA_ORDER, ARMY_DESIGN_METHODOLOGY_ACTIVITIES, ASSESSMENT_TERMS, BRANCH_AND_SEQUEL, COA_TEST_MEANINGS, COG_TERMS, DESIGN_APPROACHES,
  END_STATE_TERMS, JOINT_PLAN_LEVELS, MDO_TERMS, OPERATIONAL_DESIGN_ELEMENTS, OPERATIONAL_DESIGN_METHOD, TACTICAL_PLANS_CELL, TIME_RULE, WARGAME_TURN
} from '../../domain/staff/doctrine';
import type { AnnexSubject } from '../../domain/staff/doctrine';
import { describePlacement, renderProfileMarkdown } from '../../domain/staff/profiles';
import { j5Template, renderJ5Team, renderJ5Workflow, skillPath, J5_SKILLS } from './j5Plans';
import type { J5Skill, J5Template, J5TemplateOptions } from './j5Plans';

/** Where the profile files a subject, in plain words. */
function placement(template: J5Template, subject: AnnexSubject): string {
  return describePlacement(template.resolved.annexes.find((entry) => entry.subject === subject)!.placement);
}

const header = (title: string, template: J5Template): string[] => [
  `# ${title}`,
  '',
  `For ${template.name}. Generated from the staff settings; terms, step names and annex letters follow .planning/staff/PROFILE.md. Exercise and fictional data only.`,
  ''
];

function orderFormat(template: J5Template): string[] {
  const process = template.resolved.process.id;
  if (process === 'jpp') {
    return [
      'Joint plans come at one of four levels of detail; the higher directive says which:',
      '',
      ...JOINT_PLAN_LEVELS.map((level) => `- ${level}`),
      '',
      'Base plan paragraphs: 1 Situation; 2 Mission; 3 Execution (commander\'s intent, concept of operations, tasks, coordinating instructions); 4 Administration and logistics; 5 Command and control. Annexes as in the table below.'
    ];
  }
  if (process === 'ajp-5') {
    return [
      'The CONOPS comes first and is approved by the higher commander; the OPLAN follows with its annexes. The detailed formats are in the COPD, which is not public: use the headings below and the annex letters in the table.',
      '',
      'CONOPS headings: Situation; Mission; Commander\'s intent; Concept of operations (by phase, with decisive points and transitions); Main and supporting efforts; Sustainment concept; Command and control; Risk.'
    ];
  }
  return [
    'Orders use the five-paragraph format: 1 Situation; 2 Mission; 3 Execution (commander\'s intent, concept of operations, scheme of manoeuvre, tasks to subordinate units, coordinating instructions); 4 Sustainment; 5 Command and signal.',
    ...(process === 'mdmp' ? ['', `Plans cells: ${TACTICAL_PLANS_CELL.division} at division; ${TACTICAL_PLANS_CELL.brigade} at brigade; ${TACTICAL_PLANS_CELL.battalion} at battalion.`] : [])
  ];
}

function planningTemplates(template: J5Template): string {
  const { resolved } = template;
  const tactical = resolved.settings.level === 'tactical';
  const steps = resolved.steps.map((step) => `| ${step.step} | ${step.work}${step.human ? ' (a person decides)' : ''} | ${step.name ?? `Not a step. ${step.note ?? ''}`.trim()} |`);
  const annexRows = resolved.annexes.map((entry) => `| ${entry.subject} | ${describePlacement(entry.placement)} | | |`);
  return [
    ...header('Planning templates', template),
    'Every product is a file under .planning/staff/products/j5/ that opens with the product header (product, kind, section, owner, profile, level, version, state, label, decision_for, depends_on). Write `DECISION FOR: <role>` for every decision a person must make; never write that one is made.',
    '',
    '## The steps',
    '',
    '| # | Work | Step name |',
    '|---|---|---|',
    ...steps,
    '',
    '## The lead\'s workflow',
    '',
    renderJ5Workflow(template),
    '',
    '## Planning timeline',
    '',
    `Work back from the time the ${tactical ? 'order' : 'plan'} is due. One row per product: product, owner, step, suspense (date-time group), depends on, status.${tactical ? ` Apply the ${TIME_RULE.toLowerCase()}: keep at most a third of the time for the plans cell.` : ''}`,
    '',
    '## Warning order',
    '',
    'Situation (what is known); Mission (as far as known); Execution (intent if known, concept in outline, early tasks, timings); Sustainment (early moves and stock to prepare); Command and signal. Send one early and another whenever the planning changes direction.',
    '',
    '## Facts and assumptions ledger',
    '',
    '| # | Statement | Fact or assumption | Source or basis | Owner | How it will be confirmed | Event that would invalidate it | Status (valid, invalid, confirmed) | Products that depend on it |',
    '|---|---|---|---|---|---|---|---|---|',
    '',
    'An assumption is kept only if it is necessary for planning to continue and is likely true. When one changes status, every product in its last column is marked and its owner told.',
    '',
    '## Mission analysis brief',
    '',
    'Purpose and agenda; higher direction and intent; the operational environment and the adversary (from the red cell seat); the problem statement and the operational approach; facts and assumptions; specified, implied and essential tasks; limitations (constraints and restraints); force availability; COG analysis; risk; proposed CCIRs; COA evaluation criteria with proposed weights; proposed restated mission; proposed commander\'s intent; the red team\'s findings; the decisions requested, each as `DECISION FOR: commander`.',
    '',
    '## COA themes',
    '',
    '| COA | Owner | Theme in one sentence | What must differ from the other COA (main effort, axis, domain, phasing, task organization) |',
    '|---|---|---|---|',
    '',
    '## COA statement and sketch',
    '',
    'Statement: who, what, when, where, why and how, with the main effort, supporting efforts, phases and the conditions that end each phase, initial task organization, deployment concept, sustainment outline and main risks. Sketch: an SVG of the same, on the COP plans layer only. Self-test against the COA tests below. A closing paragraph says how this COA differs from the other one.',
    '',
    '## COA validity record',
    '',
    `| COA | ${resolved.coaTests.join(' | ')} | Distinct from |`,
    `|---|${resolved.coaTests.map(() => '---').join('|')}|---|`,
    '',
    'Each cell is pass, fail or risk, with the reason. What each test asks:',
    '',
    ...resolved.coaTests.map((test) => `- ${test}: ${COA_TEST_MEANINGS[test]}`),
    '',
    '## Comparison matrix',
    '',
    '| Criterion | Definition | Weight (approved by the commander) | COA A score and rationale | COA B score and rationale |',
    '|---|---|---|---|---|',
    '',
    'Totals recompute from the scores and weights. The recommendation names its main risk and the mitigation. The red team\'s dissent sits beside it, unedited.',
    '',
    '## COA decision brief',
    '',
    'The mission as approved; the adversary COAs; each COA sketch and statement; the wargame results; the comparison; the recommendation with risk; the red team\'s dissent, unedited; the legal questions still open; `DECISION FOR: commander` with the options (approve COA A, approve COA B, or return with guidance).',
    '',
    '## The plan or order',
    '',
    ...orderFormat(template),
    '',
    '## Annex tracker',
    '',
    'Take every letter from this table, never from memory.',
    '',
    '| Subject | Placement | Owner | Status and version |',
    '|---|---|---|---|',
    ...annexRows,
    '',
    '## Transition brief',
    '',
    `What the plan is and why; the decisions taken and by whom; the DST and DSM; the sync matrix; the branch list; the assessment plan; open risks and assumptions. ${resolved.planning.transition.note}`,
    ''
  ].join('\n');
}

function wargameLedger(template: J5Template): string {
  return [
    ...header('Wargame ledger', template),
    'The wargame record is the single source for the sync matrix, the DST and DSM, the branch list and the decision points. The plans-writer records; the lead-planner controls; nobody retypes the results afterwards.',
    '',
    '## Setup',
    '',
    `- COAs are wargamed one at a time, each against ${ADVERSARY_COA_ORDER.map((coa) => `the ${coa.charAt(0).toLowerCase()}${coa.slice(1)}`).join(' and then ')}, so the results compare.`,
    '- At the table: the lead-planner controls; the red cell seat plays the adversary to win; the owning COA member and the operations seat play the friendly side; sustainment, fires (where present) and legal note effects and issues; the plans-writer records; the red team watches and reviews after each COA.',
    '- Before turn 1, record the COA and adversary COA versions, the start time (H-hour), the time per turn and the critical events or phases to be gamed.',
    '',
    '## One turn',
    '',
    `Each turn has three phases in this order: ${WARGAME_TURN.join(', ')}. Record one row per phase.`,
    '',
    '| Turn | Phase | Time (H+ hours) | Side | Unit or capability | What it does | Result (fact) | Judgement (the controller\'s, marked as such) | Decision point | Notes for branches |',
    '|---|---|---|---|---|---|---|---|---|---|',
    '',
    'Keep what happened apart from what was judged: a result is what the rules and the agreed capabilities give; a judgement is the controller\'s, and says so. Record nothing you did not see.',
    '',
    'Each phase is also one line of JSON in the record\'s data block, the same fields the Staff Room\'s wargame event carries, so the views and the replay need no parsing of the table:',
    '',
    '```json',
    '{"coa":"coa-a","enemyCoa":"mlcoa","turn":1,"phase":"action","hHourOffsetMinutes":0,"moves":[{"unit":"fictional unit","side":"friendly","path":[[0,0],[1,1]]}],"results":["..."],"decisionPoints":["DP1"]}',
    '```',
    '',
    '## Decision points',
    '',
    'Every decision point gets: a number, what must be decided, the indicator that shows it is coming, the information requirement behind that indicator, where it is watched, the latest time the decision is still useful, the options, and the decision maker (a role). These rows become the DST and DSM.',
    '',
    '## After each COA',
    '',
    `- Export: the sync matrix rows (time across, functions down: adversary, collection, manoeuvre, fires, sustainment, information, decision points${template.variant === 'mdo' ? `, and one row per domain (${MDO_TERMS.domains.join(', ')}) with the windows of opportunity` : ''}).`,
    '- Export: DST and DSM rows (decision point, indicator, information requirement, where it is watched, recommended action, decision maker).',
    `- Branches found go to the operations seat's branch list. ${BRANCH_AND_SEQUEL.branch}`,
    `- Sequels found go to the lead-planner's sequel list. ${BRANCH_AND_SEQUEL.sequel}`,
    '- The red team\'s bias check follows; its findings are recorded beside the COA\'s results, unedited.',
    '- Results feed the comparison. A wargame alone does not validate or invalidate a COA.',
    ''
  ].join('\n');
}

function cogAnalysis(template: J5Template): string {
  const profile = template.resolved.settings.profile;
  const terms = COG_TERMS[profile];
  const process = template.resolved.process.id;
  const design = DESIGN_APPROACHES[process];
  const endState = END_STATE_TERMS[profile];
  const method = process === 'jpp'
    ? ['## The design method', '', ...OPERATIONAL_DESIGN_METHOD.map((step, index) => `${index + 1}. ${step}`), '', 'Elements of operational design, by group (not every element applies to every plan):', '', ...OPERATIONAL_DESIGN_ELEMENTS.map((group) => `- ${group.group}: ${group.elements.join(', ')}`)]
    : process === 'mdmp'
      ? ['## The design method', '', 'When the problem is ill-structured:', '', ...ARMY_DESIGN_METHODOLOGY_ACTIVITIES.map((activity, index) => `${index + 1}. ${activity}`)]
      : ['## The design method', '', `${design.name}: ${design.when} (${design.source}).`];
  return [
    ...header(`${terms.cog} analysis`, template),
    `${design.name} runs ${design.when}. The analysis below feeds the operational approach, the decisive points and the COA themes. Do it for the adversary and for our own force.`,
    '',
    '## Worksheet',
    '',
    `| Step | Question | Adversary | Friendly |`,
    '|---|---|---|---|',
    `| 1 | What does the side want to achieve (its objective${endState.usesMilitaryEndState ? ` and its ${endState.term}` : ''})? | | |`,
    `| 2 | ${terms.cog}: the source of power or strength that lets the side achieve it | | |`,
    `| 3 | ${terms.capabilities}: what the ${terms.cog.toLowerCase()} does that matters (verbs) | | |`,
    `| 4 | ${terms.requirements}: what each capability needs to work (nouns: conditions, resources, means) | | |`,
    `| 5 | ${terms.vulnerabilities}: requirements that are deficient or open to attack, and that would cause a decisive effect | | |`,
    '| 6 | Decisive points and effects: where and how to act on the vulnerabilities (adversary) or protect them (friendly) | | |',
    '',
    'Rules:',
    '',
    `- Trace every entry to evidence: the red cell seat's adversary products, the scenario, or a stated assumption in the ledger.`,
    `- A ${terms.cog.toLowerCase()} is tested, not named: if it were removed or neutralized, would the side lose the ability to achieve its objective? If not, it is not the ${terms.cog.toLowerCase()}.`,
    '- Capabilities are things the source does; requirements are things it needs. Keep them apart.',
    '- Protect our own critical vulnerabilities in every COA; the red team will look for the ones we missed.',
    '',
    ...method,
    '',
    '## Lines of operation and effort',
    '',
    'Draw the operational approach as an SVG: lines of operation (physical, through decisive points) and lines of effort (by purpose, where the physical line does not fit), each ending in an objective and the conditions that achieve it, with the transitions between phases marked.',
    ''
  ].join('\n');
}

function assessmentFramework(template: J5Template): string {
  return [
    ...header('Assessment framework', template),
    `The design-planner builds the assessment plan from the design during planning; it is filed as ${placement(template, 'assessment')} and passes to the operations section's assessment cell at transition. Assessment starts in planning, not after the order is issued.`,
    '',
    '## Terms',
    '',
    `- ${ASSESSMENT_TERMS.moe}`,
    `- ${ASSESSMENT_TERMS.mop}`,
    `- ${ASSESSMENT_TERMS.indicator}`,
    '',
    '## Effects and MOEs',
    '',
    '| Objective | Condition or effect wanted | MOE | Indicator | Baseline | Threshold that shows success | Collection owner | How often |',
    '|---|---|---|---|---|---|---|---|',
    '',
    '## Tasks and MOPs',
    '',
    '| Task | Assigned to | MOP | Standard | Data source | How often |',
    '|---|---|---|---|---|---|',
    '',
    'Rules:',
    '',
    '- MOEs and MOPs stay in separate tables: doing the tasks well (MOP) does not prove the effect (MOE).',
    '- Every indicator is observable and collectable by a named owner; indicators the intelligence section collects become requirements proposed to it.',
    '- Keep data apart from judgement: the numbers in one column, the assessment of what they mean in another, with its confidence.',
    '- Each MOE ties to an objective in the operational approach; an MOE with no objective is dropped, and an objective with no MOE is a gap.',
    '- The COA evaluation criteria and the assessment plan come from the same design, so they do not contradict each other.',
    '',
    '## Assessment plan outline',
    '',
    'Purpose; the objectives and conditions; the MOE and MOP tables; the data collection plan (who collects what, when); the assessment cycle and the meeting that reviews it; how recommendations reach the decision maker; what would make the plan change (refine, adapt, or start new planning).',
    ''
  ].join('\n');
}

/** The text of one skill for the options. */
export function j5SkillText(skill: J5Skill, options: J5TemplateOptions): string {
  const template = j5Template(options);
  switch (skill) {
    case 'planning-templates': return planningTemplates(template);
    case 'wargame-ledger': return wargameLedger(template);
    case 'cog-analysis': return cogAnalysis(template);
    case 'assessment-framework': return assessmentFramework(template);
  }
}

/** A file the template writes, relative to the project folder. */
export interface TemplateFile { readonly path: string; readonly text: string }

/**
 * Everything the J5 template puts in a project: the team file, PROFILE.md, and the four skills. The project guidance (j5Guidance) goes between the
 * project-type markers of AGENTS.md, as every project type's does.
 */
export function j5TemplateFiles(options: J5TemplateOptions): TemplateFile[] {
  const template = j5Template(options);
  return [
    { path: '.planning/.near-ai/team.md', text: renderJ5Team(options) },
    { path: '.planning/staff/PROFILE.md', text: renderProfileMarkdown(template.resolved) },
    ...J5_SKILLS.map((skill) => ({ path: skillPath(skill), text: j5SkillText(skill, options) }))
  ];
}
