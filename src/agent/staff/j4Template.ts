// The J4 logistics staff team template (design 10, 3.5; research note 03 part B; WP-J4): the team file for a profile, level and nation, its `staff:`
// block, the project guidance (an AGENTS.md block of its own, beside the project type's and any other section's), the logstat-definitions skill, and
// PROFILE.md. Pure: it returns text and leaves writing the files to the caller, so the Staff setup decides where the team lives.
//
// The section's words change with the profile, level and nation (Annex D, F or R with S; logistics, sustainment or combat service support; LOGSTAT, and
// the CJOC weekly reports under the Canadian nation setting), so the template renders from the settings rather than shipping fixed text. Support planning
// starts at step 1, alongside force planning. Every number traces to a calculator record. Members never decide: a named person does.
import { CLEARANCE_SELF_ASSERTED_TEXT, LABELS_NOT_ACCREDITATION_TEXT } from '../../domain/gate/labels';
import { CROSSWALK_STEPS, PLANNING_TYPES, STAFF_LEVELS, STAFF_NATIONS, STAFF_PROFILE_IDS, SUPPORT_PLANNING_RULE } from '../../domain/staff/doctrine';
import type { CrosswalkStep } from '../../domain/staff/doctrine';
import type { StepRole } from '../../domain/staff/events';
import { STAFF_MARKERS } from '../../domain/staff/products';
import { defaultStaffSettings, levelOffer, renderProfileMarkdown } from '../../domain/staff/profiles';
import type { StaffSettings } from '../../domain/staff/profiles';
import type { StaffTeamBlock } from '../../domain/staff/teamBlock';
import { renderTeam } from '../teams';
import { withStaffGuidance } from './guidance';
import { J4_ROSTERS } from './j4Members';
import { CALC_RECORDS_HEADING, j4VariantProducts } from './j4Products';
import { j4SkillFiles } from './j4Skills';
import type { J4SkillFile } from './j4Skills';
import { j4Vocabulary } from './j4Vocabulary';
import type { J4Variant, J4Vocabulary } from './j4Vocabulary';

export const J4_TEMPLATE_ID = 'j4-logistics';

/** A term with its first letter in lower case, unless it starts with an abbreviation (CCMD, JTF). */
const lowerFirst = (text: string): string => (/^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text);

export interface J4RenderOptions {
  /** A local-only project's team: the J4 members carry no web tools in any project, so the team is the same; kept for the shared template options. */
  readonly locality?: 'cloud' | 'local' | 'hybrid';
}

/**
 * The crosswalk steps the J4 takes part in, and where it leads its own line of work. It starts at step 1 because support planning runs alongside force
 * planning (03 B3); step 6 is a person's decision.
 */
export const J4_STEPS: Readonly<Partial<Record<CrosswalkStep, StepRole>>> = { 1: 'supporting', 2: 'primary', 3: 'supporting', 4: 'supporting', 5: 'supporting', 7: 'primary', 8: 'primary' };

/** The team file's `staff:` block for the vocabulary. */
export function j4StaffBlock(v: J4Vocabulary): StaffTeamBlock {
  const products = j4VariantProducts(v);
  return {
    section: 'j4', profile: v.settings.profile, level: v.settings.level, glyph: 'package', humanLead: v.humanLead, steps: J4_STEPS,
    products: products.filter((product) => product.kind !== 'map-layer').map((product) => product.id),
    layers: products.filter((product) => product.kind === 'map-layer').map((product) => product.id)
  };
}

export function j4TeamName(v: J4Vocabulary): string {
  return `${v.code} ${v.function} (${v.variant})`;
}

export function j4TeamDescription(v: J4Vocabulary): string {
  return `${v.code} ${lowerFirst(v.function)} section, ${v.variant} roster, ${v.resolved.profile.name} profile. Support planning starts at step 1, alongside force planning; one member per logistics function works in parallel on its own products and the ${v.chief} merges them into the estimate, the concept of support and ${v.annex}. Every number traces to a calculator record; the release-guard checks every product; a named person decides.`;
}

/** The J4 team file for the settings: private, with the `staff:` block, every member's instructions in the profile's words. */
export function renderJ4Team(settings: StaffSettings, _options: J4RenderOptions = {}): string {
  const v = j4Vocabulary(settings);
  const members = J4_ROSTERS[v.variant].map((spec) => {
    const reportsTo = spec.reportsTo?.(v);
    return { name: spec.name, role: spec.role(v), model: spec.model, ...(reportsTo ? { reportsTo } : {}), tools: [...spec.tools], instructions: spec.instructions(v) };
  });
  return renderTeam(j4TeamName(v), j4TeamDescription(v), members, { private: true, staff: j4StaffBlock(v) });
}

export interface J4WorkflowRow { readonly step: CrosswalkStep; readonly lanes: readonly string[]; readonly merge: string; readonly gate: string; readonly human: boolean }

/** The functional planners on the roster, in the order of the core logistics functions. */
function functionalPlanners(variant: J4Variant): string[] {
  const order = ['mobility-planner', 'supply-planner', 'maintenance-planner', 'services-mortuary-planner', 'ocs-planner', 'health-services-planner', 'engineer-planner'];
  const names = J4_ROSTERS[variant].map((member) => member.name);
  return order.filter((name) => names.includes(name));
}

/** The lead's workflow per step (design 10, 3.5; 03 B10): the parallel lanes (started in one turn), the merge, and the gate. */
export function j4Workflow(v: J4Vocabulary): J4WorkflowRow[] {
  const chief = v.chief;
  const plans = v.tactical ? chief : 'log-plans-officer';
  const planners = functionalPlanners(v.variant);
  const guard = 'release-guard';
  const toPlanning = `to the ${v.planningLead}`;
  return [
    {
      step: 1, human: false,
      lanes: [`${plans}: ${v.overview.toLowerCase()} from the force list`, `jloc-chief: notional stock baseline and ${v.logstat.report} definitions`, 'mobility-planner: infrastructure scan of ports, airfields and routes'],
      merge: `${chief}: the first ${lowerFirst(v.function)} running estimate, started the same turn as force planning`, gate: `None; requests out to the ${v.intel}`
    },
    {
      step: 2, human: false,
      lanes: planners.map((name) => `${name}: assesses its function from the shared task list and force list`),
      merge: v.tactical ? `${chief}: the ${v.estimate.toLowerCase()}, constraints and critical shortfalls` : `log-plans-officer, then ${chief}: the ${v.estimate.toLowerCase()}, constraints and critical shortfalls`,
      gate: `${guard}; ${toPlanning} and the ${v.ops}; logistics CCIRs proposed to the register's owner`
    },
    {
      step: 3, human: false,
      lanes: [...planners.map((name) => `${name}: supportability of each course of action for its function`), `${plans}: calculator runs per course of action`],
      merge: `${plans}: the supportability register`, gate: `${guard}; ${toPlanning}`
    },
    {
      step: 4, human: false,
      lanes: [`${plans}: consumption per course of action and phase`, 'mobility-planner: distribution timeline', 'jloc-chief: logistics triggers for the decision support matrix'],
      merge: `${plans}: the logistics war game and decision points`, gate: `${guard}; decision points proposed to the decision support matrix owner`
    },
    {
      step: 5, human: false,
      lanes: [`${chief}: scores the logistics criteria`, ...(v.tactical ? [] : ['log-plans-officer: checks each score against its calculator records'])],
      merge: `${chief}`, gate: `${guard}; ${toPlanning}`
    },
    { step: 6, human: true, lanes: [`${chief}: sustainment risk brief`], merge: 'None', gate: 'The decision is recorded' },
    {
      step: 7, human: false,
      lanes: [`${chief}: ${v.conceptOfSupport.toLowerCase()}`, ...planners.map((name) => `${name}: its functional appendix`), 'jloc-chief: logistics synchronization matrix',
        ...(v.movementsAnnex ? [`mobility-planner: ${v.movementsAnnex}`] : []), ...(v.canadian && !v.tactical ? [`${chief}: support plan (SUPLAN) inputs`] : [])],
      merge: `${chief}: ${v.annex}`, gate: `${guard}; the annex to the plan writer`
    },
    {
      step: 8, human: false,
      lanes: [`jloc-chief: ${v.logstat.report} loop and ${v.logstat.picture}`, 'logstat-analyst: validates every report as it arrives', ...(v.canadianReports ? [`jloc-chief: ${v.reports.weekly.toLowerCase()} and ammunition reports to ${v.reports.to}`] : []), 'functional planners: called for branches'],
      merge: 'jloc-chief', gate: 'Exceptions that match a CCIR to the operations centre at once'
    }
  ];
}

/** The J4 section's project guidance: the text between its own markers in AGENTS.md, read by the lead and every member. */
export function j4Guidance(settings: StaffSettings): string {
  const v = j4Vocabulary(settings);
  const rows = j4Workflow(v);
  return [
    `## Staff section: ${v.code} ${lowerFirst(v.function)} (${v.variant})`,
    '',
    `Profile: ${v.resolved.profile.name}, ${v.settings.level} level${v.settings.nation ? `, nation ${v.settings.nation}` : ''}. Process: ${v.resolved.process.name}. The logistics annex is ${v.annex}${v.movementsAnnex ? `, with movements in ${v.movementsAnnex}` : ''}. The current-operations centre is the ${v.currentOps}. Every member reads .planning/staff/PROFILE.md first and uses its terms only.`,
    '',
    '### Rules for every run',
    '',
    `- **Support planning starts at step 1.** ${SUPPORT_PLANNING_RULE} The lead starts the ${v.code} lanes in the same turn as the ${v.planningLead}'s, never after the decision.`,
    `- **Every number traces to a calculator record.** Numbers come from the consumption calculator on the logistics server, from factors a person entered; the record's calc:<id> sits on the same line as the number and every product lists its records under "${CALC_RECORDS_HEADING}". guard-scan holds any product with a number and no record, and the release guard cannot clear it. No member invents a rate or uses a government planning factor table. The definitions are in .planning/staff/skills/logstat-definitions.md.`,
    '- **Exercise data only.** These templates are unclassified, and so is everything the team writes: fictional scenarios, notional units and notional numbers. No real stock levels, unit holdings or contract values. Real operational plans belong on accredited systems.',
    `- **Labels are not accreditation.** ${LABELS_NOT_ACCREDITATION_TEXT}`,
    `- **Clearances are self-declared.** ${CLEARANCE_SELF_ASSERTED_TEXT}`,
    '- **Private models only.** The team is marked private: every member runs on a NEAR TEE or local model, and a run stops rather than send the work to a forwarded model.',
    `- **People decide.** Members recommend and mark each decision \`${STAFF_MARKERS.decisionFor} <role>\` with options and risk. The commander sets priorities of support; a review board and a contracting officer decide contracts; the surgeon decides medical matters; a named person approves and releases every product in the Staff Room. No member commits resources, signs a contract, sets a priority, or writes "approved", "selected" or "released" about its own work.`,
    `- **One writer per product.** Each product has one owning member; others propose changes in .planning/staff/proposals/<product>/ and the owner merges them. The jloc-chief is the one writer of the COP logistics layer. A member waiting on another section writes \`${STAFF_MARKERS.waitingOn} <section>: <what>\` and carries on.`,
    `- **Health products** carry \`${STAFF_MARKERS.surgeonReview}\`: they assist a qualified surgeon and are never medical advice. Mortuary affairs products hold no personal data.`,
    `- **No TPFDD.** The mobility-planner reviews notional movement tables only; real deployment data lives in government systems.`,
    '',
    `### Workflow (the lead starts each step's lanes in one turn, separated by ‖; the named member merges)`,
    '',
    '| Step | Lanes, run in parallel | Merge | Gate and handoff |',
    '|---|---|---|---|',
    ...rows.map((row) => `| ${row.step} ${v.step(row.step)} | ${row.lanes.join(' ‖ ')} | ${row.merge} | ${row.human ? '**A person decides.** ' : ''}${row.gate} |`),
    '',
    '### Handoffs',
    '',
    `- To the ${v.ops}: sustainment feasibility per course of action and branch, logistics decision points for the decision support matrix, ${v.logstat.report} exceptions, and Class V and Class III demand signals. Back: priorities of support and the operations the section supports.`,
    `- To the ${v.planningLead}: feasibility of plans and sequels, and long-lead items. Back: the courses of action and the decision points.`,
    `- From the ${v.intel}: threats to lines of communication, ports and stocks, and infrastructure information. Back: logistics information requirements.`,
    ''
  ].join('\n');
}

/** AGENTS.md with the J4 guidance between its own markers, replacing an earlier copy; everything else in the file is kept as it was. */
export function withJ4Guidance(existing: string, settings: StaffSettings): string {
  return withStaffGuidance(existing, J4_TEMPLATE_ID, j4Guidance(settings));
}

export interface J4TemplateOutput {
  readonly variant: J4Variant;
  readonly team: string;
  readonly guidance: string;
  /** PROFILE.md and the logstat-definitions skill, each at its project path. */
  readonly files: ReadonlyArray<{ readonly name: string; readonly path: string; readonly content: string }>;
}

/** Everything the J4 template writes for the settings. */
export function j4Template(settings: StaffSettings, options: J4RenderOptions = {}): J4TemplateOutput {
  const v = j4Vocabulary(settings);
  const skills: J4SkillFile[] = j4SkillFiles(v);
  return {
    variant: v.variant,
    team: renderJ4Team(settings, options),
    guidance: j4Guidance(settings),
    files: [{ name: 'profile', path: '.planning/staff/PROFILE.md', content: renderProfileMarkdown(v.resolved) }, ...skills]
  };
}

/** One valid rendering's settings: every profile, offered level, nation and planning type the template can be written for. */
export interface J4Rendering { readonly key: string; readonly settings: StaffSettings }

export function j4Renderings(): J4Rendering[] {
  const found: J4Rendering[] = [];
  for (const profile of STAFF_PROFILE_IDS) {
    for (const level of STAFF_LEVELS) {
      if (!levelOffer(profile, level).offered) continue;
      const nations = profile === 'nato-ca' ? [...STAFF_NATIONS] : [undefined];
      for (const nation of nations) {
        for (const planningType of PLANNING_TYPES) {
          const settings: StaffSettings = { ...defaultStaffSettings(), profile, level, planningType, ...(nation ? { nation } : {}) };
          found.push({ key: [profile, level, nation, planningType].filter(Boolean).join('/'), settings });
        }
      }
    }
  }
  return found;
}

/** Every crosswalk step the workflow covers (all eight, step 6 a person's). Exported for the tests. */
export function j4WorkflowSteps(settings: StaffSettings): CrosswalkStep[] {
  return j4Workflow(j4Vocabulary(settings)).map((row) => row.step).filter((step) => (CROSSWALK_STEPS as readonly number[]).includes(step));
}
