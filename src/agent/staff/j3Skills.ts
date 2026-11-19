// The J3 skills (design 10, 6.2; research note 03, A3 to A6 and A14): the running estimate and the execution loop. Each is a Markdown file the members
// read from `.planning/staff/skills/`, written for the project's profile and level so every term, code, horizon and annex letter in it is the profile's.
// The person can read and edit them. Pure: no I/O, no clock, no vscode.
import { COMPETITION_CONTINUUM, FRAGMENTARY_ORDER, JOINT_TARGETING_CYCLE, PLANNING_HORIZONS, RUNNING_ESTIMATE } from '../../domain/staff/doctrine';
import { TRANSITION_PRODUCT } from '../../domain/staff/ownership';
import { STAFF_MARKERS } from '../../domain/staff/products';
import { renderProfileMarkdown, sectionCode } from '../../domain/staff/profiles';
import { COMMANDER_REVIEW_MARK, REGISTER_SCHEMAS } from '../../domain/staff/registers';
import { j3SkillPath, j3Template, renderJ3Team, renderJ3Workflow, J3_SKILLS } from './j3Operations';
import type { J3Skill, J3Template, J3TemplateOptions } from './j3Operations';

const header = (title: string, template: J3Template): string[] => [
  `# ${title}`,
  '',
  `For ${template.name}. Generated from the staff settings; terms, codes, horizons and annex letters follow .planning/staff/PROFILE.md. Exercise and fictional data only.`,
  ''
];

const columns = (register: string): string => REGISTER_SCHEMAS[register].columns.map((column) => `${column.title}${column.required ? '' : ' (optional)'}`).join('; ');

function runningEstimate(template: J3Template): string {
  const { resolved } = template;
  const director = template.members[0].name;
  return [
    ...header('Running estimate', template),
    `Every member keeps its part of the section's running estimate and proposes it to the ${director} in .planning/staff/proposals/j3-running-estimate/; the ${director} merges the parts into one estimate and updates it every battle rhythm cycle. ${RUNNING_ESTIMATE.rule}`,
    '',
    '## Headings',
    '',
    `One section per function, in this order: ${resolved.functions.names.join(', ')}. Each section holds:`,
    '',
    ...RUNNING_ESTIMATE.parts.map((part) => `- ${part}`),
    '',
    'Facts carry their source. Assumptions carry the event that would invalidate them. Recommendations name the decision they serve and its decision point, with the risk of each option.',
    ...(resolved.settings.level === 'strategic' ? ['', `At strategic level the estimate covers campaigning across the competition continuum: ${COMPETITION_CONTINUUM.join(', ')}.`] : []),
    '',
    '## CCIR register',
    '',
    `The ${director} proposes the whole register with the staff-products register tool; the intelligence section's requirements manager writes the PIR part and logistics entries come by proposal. Columns: ${columns('ccir-register')}. Every CCIR names the decision point it supports; the commander decides on the register, \`${STAFF_MARKERS.decisionFor} commander\`.`,
    ''
  ].join('\n');
}

function executionLoop(template: J3Template): string {
  const { resolved } = template;
  const { currentOpsHours, futureOpsHours } = resolved.settings.horizons;
  const frago = FRAGMENTARY_ORDER.abbreviation[resolved.settings.profile];
  const plans = sectionCode(resolved.settings.profile, resolved.settings.level, 'j5') ?? 'J5';
  const currentOps = template.members[1].name;
  return [
    ...header('Execution loop', template),
    '## Horizons',
    '',
    '| Venue | Covers | Owner | Horizon |',
    '|---|---|---|---|',
    `| ${PLANNING_HORIZONS.currentOperations.name} | ${PLANNING_HORIZONS.currentOperations.covers} | ${PLANNING_HORIZONS.currentOperations.owner} (${currentOps}) | to ${currentOpsHours} hours |`,
    `| ${PLANNING_HORIZONS.futureOperations.name} | ${PLANNING_HORIZONS.futureOperations.covers} | ${PLANNING_HORIZONS.futureOperations.owner} (future-ops-planner) | to ${futureOpsHours} hours |`,
    `| ${PLANNING_HORIZONS.futurePlans.name} | ${PLANNING_HORIZONS.futurePlans.covers} | ${PLANNING_HORIZONS.futurePlans.owner} (${plans}) | beyond |`,
    '',
    `Transition: a plan moves between the venues only through a transition brief (the ${TRANSITION_PRODUCT} product). A person accepts it; that recorded decision puts the project in execution, and from then on the future-ops-planner writes the synchronization matrix and the DST and DSM and the assessment-analyst the assessment plan.`,
    '',
    '## The loop',
    '',
    `1. The watch-officer logs each report as an event-log proposal (${columns('event-log')}) and reports a CCIR match with the register tool's trigger action.`,
    `2. The ${currentOps} merges the entries, checks them against the CCIR register and the DSM, and escalates a match at once with the decision point and the person who decides.`,
    `3. The future-ops-planner reads the DSM row (${columns('dst-dsm')}), writes the branch, asks the intelligence and logistics sections for their checks by proposal, and drafts the ${frago}.`,
    `4. The release-guard checks the ${frago}'s exact version; the section's integrator submits it to the person who decides; only that person releases it.`,
    '5. The assessment-analyst runs the assessment cycle; the integrator updates the running estimate.',
    '',
    `A ${frago}: ${FRAGMENTARY_ORDER.definition} Paragraphs: 1 Situation; 2 Mission; 3 Execution; 4 Sustainment; 5 Command and signal, each "no change" where nothing changes.`,
    '',
    '## Battle rhythm (defaults: edit them for your headquarters)',
    '',
    '| Event | Type | Chair or owner | Output | Who decides |',
    '|---|---|---|---|---|',
    `| Shift change brief | Centre | ${currentOps} | Watch handover | Nobody: a handover |`,
    '| Commander\'s update brief | Board | Commander | Commander\'s guidance | The commander |',
    `| Operations synchronization meeting | Working group | future-ops-planner | Synchronized tasks, ${frago} drafts | The ${template.humanLead} releases |`,
    '| Targeting working group | Working group | fires-effects-coordinator | Recommendations to the board | Nobody: it prepares |',
    '| Targeting board | Board | Commander or a delegate | Target list and priorities | The commander or delegate |',
    '| Information working group | Working group | Information planner | Recommendations | Nobody: it prepares |',
    '| Assessment working group, then board | Working group, then board | assessment-analyst, then commander | Assessment, recommended changes | The commander |',
    '| Logistics synchronization | Working group | Logistics section | Sustainment synchronization | The logistics director |',
    '',
    '## Targeting',
    '',
    `The joint targeting cycle: ${JOINT_TARGETING_CYCLE.map((phase, index) => `${index + 1}. ${phase}`).join('; ')}. Targets are notional system and function entries in the exercise box only. Every targeting workbook row carries ${STAFF_MARKERS.legalReview} and ${COMMANDER_REVIEW_MARK}; every board package carries \`${STAFF_MARKERS.decisionFor} commander or delegate\` and ${STAFF_MARKERS.legalReview}.`,
    '',
    '## Workflow per step',
    '',
    renderJ3Workflow(template),
    ''
  ].join('\n');
}

/** One skill's text for the options. */
export function j3SkillText(skill: J3Skill, options: J3TemplateOptions): string {
  const template = j3Template(options);
  switch (skill) {
    case 'running-estimate': return runningEstimate(template);
    case 'execution-loop': return executionLoop(template);
  }
}

export interface J3TemplateFile { readonly path: string; readonly text: string }

/** Everything the J3 template writes for the options: the team, PROFILE.md and the two skills, each at its project path. */
export function j3TemplateFiles(options: J3TemplateOptions): J3TemplateFile[] {
  return [
    { path: '.planning/.near-ai/team.md', text: renderJ3Team(options) },
    { path: '.planning/staff/PROFILE.md', text: renderProfileMarkdown(j3Template(options).resolved) },
    ...J3_SKILLS.map((skill) => ({ path: j3SkillPath(skill), text: j3SkillText(skill, options) }))
  ];
}
