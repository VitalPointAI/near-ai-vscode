// The J2 intelligence staff team template (design 10, 3.2; WP-J2): the team file for a profile, level and echelon, its `staff:` block, the project
// guidance (an AGENTS.md block of its own, beside the project type's), the two skills, and PROFILE.md. Pure: it returns text and leaves writing the
// files to the caller, so the Staff setup decides where the team lives.
//
// The section's words change with the profile and level (JIPOE or IPB, Annex B or D, J-2 or S2), so the template renders from the settings rather
// than shipping fixed text. Members never decide: a named person approves PIRs, collection allocation and every product's release.
import { CLEARANCE_SELF_ASSERTED_TEXT, LABELS_NOT_ACCREDITATION_TEXT } from '../../domain/gate/labels';
import { CROSSWALK_STEPS, STAFF_LEVELS, STAFF_NATIONS, STAFF_PROFILE_IDS, PLANNING_TYPES } from '../../domain/staff/doctrine';
import type { CrosswalkStep } from '../../domain/staff/doctrine';
import type { StepRole } from '../../domain/staff/events';
import { STAFF_MARKERS, STAFF_PRIVATE_MODELS_TEXT } from '../../domain/staff/products';
import { defaultStaffSettings, levelOffer, renderProfileMarkdown } from '../../domain/staff/profiles';
import type { StaffSettings } from '../../domain/staff/profiles';
import type { StaffTeamBlock } from '../../domain/staff/teamBlock';
import { renderTeam } from '../teams';
import { withStaffGuidance } from './guidance';
import { J2_ROSTERS, J2_WEB_TOOLS } from './j2Members';
import { variantProducts } from './j2Products';
import { j2SkillFiles } from './j2Skills';
import type { StaffSkillFile } from './j2Skills';
import { j2VariantFor, j2Vocabulary, processPhrase, stepsPhrase, TACTICAL_ECHELONS } from './j2Vocabulary';
import type { J2Variant, J2Vocabulary, TacticalEchelon } from './j2Vocabulary';

export const J2_TEMPLATE_ID = 'j2-intelligence';
/** The most members a team may have (parseTeam). The operational roster uses all of them. */
export const MAX_TEAM_MEMBERS = 12;

export interface J2RenderOptions {
  /** At tactical level, the echelon the roster is for (brigade unless the person picks battalion). Ignored at other levels. */
  readonly echelon?: TacticalEchelon;
  /** A local-only project's team has no web tools, as every project type's team does. */
  readonly locality?: 'cloud' | 'local' | 'hybrid';
}

/** The crosswalk steps the J2 takes part in, and where it leads its own line of work (UX concept 11, item 1). Step 6 is a person's decision. */
const J2_STEPS: Readonly<Partial<Record<CrosswalkStep, StepRole>>> = { 1: 'supporting', 2: 'primary', 3: 'primary', 4: 'supporting', 5: 'supporting', 7: 'supporting', 8: 'primary' };

/** The team file's `staff:` block for the vocabulary. */
export function j2StaffBlock(v: J2Vocabulary): StaffTeamBlock {
  return {
    section: 'j2', profile: v.settings.profile, level: v.settings.level, glyph: 'eye', humanLead: v.humanLead, steps: J2_STEPS,
    products: variantProducts(v.variant).filter((product) => product.kind !== 'map-layer').map((product) => product.id),
    layers: variantProducts(v.variant).filter((product) => product.kind === 'map-layer').map((product) => product.id)
  };
}

export function j2TeamName(v: J2Vocabulary): string {
  return `${v.code} Intelligence (${v.variant})`;
}

export function j2TeamDescription(v: J2Vocabulary): string {
  const chief = v.tactical ? 's2-lead' : 'j2-chief';
  return `${v.code} intelligence section, ${v.variant} roster, ${v.resolved.profile.name} profile (${v.prep}). Members work in parallel on their own products; the ${chief} merges them into the estimate and annex. Every product passes the tradecraft-reviewer, then the release-guard; a named person approves.`;
}

/** The J2 team file for the settings: private, with the `staff:` block, every member's instructions in the profile's words. */
export function renderJ2Team(settings: StaffSettings, options: J2RenderOptions = {}): string {
  const v = j2Vocabulary(settings, j2VariantFor(settings, options.echelon));
  const local = options.locality === 'local';
  const members = J2_ROSTERS[v.variant].map((spec) => {
    const reportsTo = spec.reportsTo?.(v.variant);
    const tools = local ? spec.tools.filter((tool) => !J2_WEB_TOOLS.includes(tool)) : [...spec.tools];
    return { name: spec.name, role: spec.role(v), model: spec.model, ...(reportsTo ? { reportsTo } : {}), tools, instructions: spec.instructions(v) };
  });
  return renderTeam(j2TeamName(v), j2TeamDescription(v), members, { private: true, staff: j2StaffBlock(v) });
}

interface WorkflowRow { readonly step: CrosswalkStep; readonly lanes: string; readonly merge: string; readonly gate: string }

/** The lead's workflow per step (design 10, 3.2), per roster: the parallel lanes (started in one turn, separated by ‖), the merge, and the gate. */
function workflow(v: J2Vocabulary): WorkflowRow[] {
  const gates = 'tradecraft-reviewer, then release-guard';
  const pir = `PIRs as \`${STAFF_MARKERS.decisionFor} commander\``;
  // In a crisis the J3 leads planning, and at battalion the S3 does both: name it once.
  const both = v.planningLead === v.ops ? v.ops : `${v.planningLead} and the ${v.ops}`;
  const human: WorkflowRow = { step: 6, lanes: 'None: a person decides', merge: 'None', gate: 'The decision is recorded' };
  switch (v.variant) {
    case 'operational': return [
      { step: 1, lanes: 'j2-chief: direction and time plan ‖ watch-officer: current situation baseline ‖ osint-analyst: first sweep ‖ threat-analyst: existing threat models', merge: 'j2-chief: initial RFIs', gate: 'None; RFIs out' },
      { step: 2, lanes: `jipoe-analyst ‖ geoint-analyst (${v.environmentSteps}) ‖ threat-analyst (step ${v.evaluateStep}, then step ${v.coaStep} once ${stepsPhrase(1, v.evaluateStep)} are ready) ‖ requirements-manager: gaps to PIR candidates, then collection-manager`, merge: `j2-chief: mission analysis input and ${v.staffEstimate} draft`, gate: `${gates}; to the ${v.planningLead}; ${pir}` },
      { step: 3, lanes: 'threat-analyst: final course of action set ‖ target-analyst: high-value target analysis ‖ red-cell: prepares the adversary play ‖ geoint-analyst: mobility for friendly courses of action', merge: 'j2-chief', gate: `${gates}; to the ${both}` },
      { step: 4, lanes: 'red-cell: plays the adversary in the war game ‖ threat-analyst: refines the event template ‖ requirements-manager: PIRs from decision points ‖ target-analyst: high-payoff target intelligence', merge: `j2-chief with the ${v.ops}: decision support template inputs`, gate: `${gates}; to the ${both}` },
      { step: 5, lanes: `j2-chief: ${v.staffEstimate} per course of action ‖ tradecraft-reviewer: alternatives and assumptions check`, merge: 'j2-chief', gate: `To the ${v.planningLead}` },
      human,
      { step: 7, lanes: 'j2-chief: annex and estimate ‖ collection-manager: final plan ‖ release-guard: dissemination plan ‖ watch-officer: execution indicator board', merge: 'j2-chief', gate: `${gates}; the annex to the plan writer` },
      { step: 8, lanes: 'watch-officer: INTSUM cycle ‖ requirements-manager: PIR review ‖ threat-analyst: course of action updates', merge: 'j2-chief', gate: 'Evaluation and feedback' }
    ];
    case 'strategic': return [
      { step: 1, lanes: 'j2-chief: direction and time plan ‖ warning-analyst: warning problems baseline ‖ threat-analyst: existing threat models ‖ collection-manager: national and partner holdings', merge: 'j2-chief: initial RFIs', gate: 'None; RFIs out' },
      { step: 2, lanes: `jipoe-analyst: ${v.environmentSteps}, with terrain, climate and infrastructure ‖ threat-analyst (step ${v.evaluateStep}, then step ${v.coaStep}) ‖ requirements-manager: gaps to PIR candidates, then collection-manager`, merge: `j2-chief: mission analysis input and ${v.staffEstimate} draft`, gate: `${gates}; to the ${v.planningLead}; ${pir}` },
      { step: 3, lanes: 'threat-analyst: final course of action set ‖ red-cell: prepares the adversary play', merge: 'j2-chief', gate: `${gates}; to the ${v.planningLead}` },
      { step: 4, lanes: 'red-cell: plays the adversary in the war game ‖ threat-analyst: refines the event template ‖ requirements-manager: PIRs from decision points', merge: `j2-chief with the ${v.ops}: decision support template inputs`, gate: `${gates}; to the ${both}` },
      { step: 5, lanes: `j2-chief: ${v.staffEstimate} per course of action ‖ tradecraft-reviewer: alternatives and assumptions check`, merge: 'j2-chief', gate: `To the ${v.planningLead}` },
      human,
      { step: 7, lanes: 'j2-chief: annex and estimate ‖ collection-manager: national and partner requests ‖ release-guard: dissemination plan ‖ warning-analyst: indicators for the plan', merge: 'j2-chief', gate: `${gates}; the annex to the plan writer` },
      { step: 8, lanes: 'warning-analyst: warning problems review ‖ requirements-manager: PIR review ‖ threat-analyst: course of action updates', merge: 'j2-chief', gate: 'Evaluation and feedback' }
    ];
    case 'brigade': return [
      { step: 1, lanes: 's2-lead: direction and time plan ‖ watch-officer: current situation baseline ‖ ipb-analyst: step 1 and existing threat models', merge: 's2-lead: initial RFIs', gate: 'None; RFIs out' },
      { step: 2, lanes: `ipb-analyst: all ${v.prepCount} steps ‖ collection-manager: PIR candidates, then the plan ‖ target-analyst: high-value target analysis from the threat models`, merge: `s2-lead: mission analysis input and ${v.staffEstimate}`, gate: `${gates}; to the ${v.planningLead}; ${pir}` },
      { step: 3, lanes: 'ipb-analyst: final threat courses of action ‖ target-analyst: high-value targets ‖ s2-lead: prepares the threat commander\'s play', merge: 's2-lead', gate: `${gates}; to the ${v.planningLead}` },
      { step: 4, lanes: 's2-lead: plays the threat commander in the war game ‖ ipb-analyst: refines the event template ‖ collection-manager: PIRs from decision points ‖ target-analyst: high-payoff target list inputs', merge: `s2-lead with the ${v.ops}: decision support template inputs`, gate: `${gates}; to the ${v.planningLead}` },
      { step: 5, lanes: `s2-lead: ${v.staffEstimate} per course of action ‖ tradecraft-reviewer: alternatives and assumptions check`, merge: 's2-lead', gate: `To the ${v.planningLead}` },
      human,
      { step: 7, lanes: 's2-lead: annex ‖ collection-manager: final plan ‖ release-guard: dissemination plan ‖ watch-officer: indicator board', merge: 's2-lead', gate: `${gates}; the annex into the order` },
      { step: 8, lanes: 'watch-officer: INTSUM cycle ‖ collection-manager: PIR review ‖ ipb-analyst: course of action updates', merge: 's2-lead', gate: 'Evaluation and feedback' }
    ];
    case 'battalion': return [
      { step: 1, lanes: 's2-lead: direction and time plan ‖ watch-officer: current situation baseline ‖ ipb-analyst: step 1 and existing threat models', merge: 's2-lead: initial RFIs', gate: 'None; RFIs out' },
      { step: 2, lanes: `ipb-analyst: all ${v.prepCount} steps ‖ s2-lead: PIR candidates and the ${v.collectionPlan.toLowerCase()} with the ${v.ops}`, merge: `s2-lead: mission analysis input and ${v.staffEstimate}`, gate: `${gates}; to the ${v.planningLead}; ${pir}` },
      { step: 3, lanes: 'ipb-analyst: final threat courses of action ‖ s2-lead: prepares the threat commander\'s play', merge: 's2-lead', gate: `${gates}; to the ${v.planningLead}` },
      { step: 4, lanes: 's2-lead: plays the threat commander in the war game ‖ ipb-analyst: refines the event template', merge: `s2-lead with the ${v.ops}: decision support template inputs`, gate: `${gates}; to the ${v.planningLead}` },
      { step: 5, lanes: `s2-lead: ${v.staffEstimate} per course of action ‖ tradecraft-reviewer: alternatives and assumptions check`, merge: 's2-lead', gate: `To the ${v.planningLead}` },
      human,
      { step: 7, lanes: `s2-lead: annex ‖ ipb-analyst: finished products for ${v.belowStaffLevel?.toLowerCase() ?? 'subordinate units'} ‖ release-guard: dissemination plan ‖ watch-officer: indicator board`, merge: 's2-lead', gate: `${gates}; the annex into the order` },
      { step: 8, lanes: 'watch-officer: INTSUM cycle ‖ s2-lead: PIR review ‖ ipb-analyst: course of action updates', merge: 's2-lead', gate: 'Evaluation and feedback' }
    ];
  }
}

/** The J2 section's project guidance: the text between its own markers in AGENTS.md, read by the lead and every member. */
export function j2Guidance(settings: StaffSettings, options: Pick<J2RenderOptions, 'echelon'> = {}): string {
  const v = j2Vocabulary(settings, j2VariantFor(settings, options.echelon));
  const chief = v.tactical ? 's2-lead' : 'j2-chief';
  const rows = workflow(v);
  return [
    `## Staff section: ${v.code} intelligence (${v.variant})`,
    '',
    `Profile: ${v.resolved.profile.name}, ${v.settings.level} level${v.settings.nation ? `, nation ${v.settings.nation}` : ''}. Process: ${v.resolved.process.name}. Intelligence: the ${v.process.name.toLowerCase()} (${processPhrase(v.process).toLowerCase()}), with ${v.prep} as the main product line. Requirements: ${v.requirements}. The intelligence annex is ${v.annex}. Every member reads .planning/staff/PROFILE.md first and uses its terms only.`,
    '',
    '### Rules for every run',
    '',
    '- **Exercise data only.** These templates are unclassified, and so is everything the team writes: fictional scenarios, fictional forces, notional numbers. Real operational plans belong on accredited systems. A member that sees classified material, a real unit identifier or current-operations content stops and reports it.',
    `- **Labels are not accreditation.** ${LABELS_NOT_ACCREDITATION_TEXT}`,
    `- **Clearances are self-declared.** ${CLEARANCE_SELF_ASSERTED_TEXT}`,
    `- **Private models only.** The team is marked private: every member runs on a NEAR TEE or local model, and a run stops rather than send the work to a forwarded model. ${STAFF_PRIVATE_MODELS_TEXT}`,
    `- **People decide.** Members recommend and mark each decision \`${STAFF_MARKERS.decisionFor} <role>\` with options and risk. The commander approves PIRs; the ${v.ops} approves the allocation of collection assets; a named person approves and releases every product in the Staff Room. No member writes "approved", "selected" or "released" about its own work, tasks collection, nominates a target or decides on operations.`,
    `- **One writer per product.** Each product has one owning member. Others propose changes in .planning/staff/proposals/<product>/ and the owner merges them. A member waiting on another section writes \`${STAFF_MARKERS.waitingOn} <section>: <what>\` and carries on with what does not depend on it.`,
    `- **Gates, in this order.** The tradecraft-reviewer's SIGN-OFF, then the release-guard's CLEARED, both on the product's exact version, then a person's decision. An edit voids both verdicts. Members register versions with mcp__staff-products__propose, the gates record verdicts with mcp__staff-products__verdict, and the ${chief} submits with mcp__staff-products__submit; approval is not a tool.`,
    '- **Standards.** Every judgement follows .planning/staff/skills/icd203-standards.md and every source .planning/staff/skills/source-grading.md.',
    '- **No collection on persons in your own country, no real targeting, no personal data.** Target intelligence covers notional systems only and never recommends an engagement.',
    `- **Red cell, not red team.** The ${v.tactical ? 's2-lead plays the threat commander' : 'red cell plays the adversary'} in the war game. The red team, which critiques the plan independently, sits outside this section.`,
    '',
    `### Workflow (the lead starts each step's lanes in one turn; the ${chief} merges)`,
    '',
    '| Step | Lanes, run in parallel | Merge | Gate and handoff |',
    '|---|---|---|---|',
    ...rows.map((row) => `| ${row.step} ${v.step(row.step)} | ${row.lanes} | ${row.merge} | ${row.gate} |`),
    '',
    `Doctrine allows the overlap: ${v.prep} is continuous, and threat evaluation starts from existing threat models before step 1 is finished.${v.resolved.planning.concurrentSteps ? ' This is crisis planning, so steps may also run at the same time.' : ''}`,
    '',
    '### Handoffs',
    '',
    `- To the ${v.planningLead}: the ${v.prep} products, the ${v.actor} courses of action (most likely and most dangerous), the ${v.cog} analysis, the intelligence estimate, the ${v.staffEstimate}, the annex, and the ${v.actor} play in the war game. Back: friendly courses of action and decision points.`,
    `- ${v.planningLead === v.ops ? `Also to the ${v.ops}, for operations` : `To the ${v.ops}`}: current intelligence and warnings, high-value target analysis, event template and decision support template inputs, the ${v.collectionPlan.toLowerCase()} for allocation approval, battle damage assessment inputs, and the ${v.actor}'s intelligence collection capability. Back: the approved allocation, operational reports and friendly force information requirements.`,
    `- To the ${v.logistics}: terrain, weather and infrastructure effects on lines of communication, and threats to lines of communication, ports and bases. Back: logistics information requirements, which enter the PIR and IR register like any other.`,
    ''
  ].join('\n');
}

/** AGENTS.md with the J2 guidance between its own markers, replacing an earlier copy; everything else in the file is kept as it was. */
export function withJ2Guidance(existing: string, settings: StaffSettings, options: Pick<J2RenderOptions, 'echelon'> = {}): string {
  return withStaffGuidance(existing, J2_TEMPLATE_ID, j2Guidance(settings, options));
}

export interface J2TemplateOutput {
  readonly variant: J2Variant;
  /** The team file text. */
  readonly team: string;
  /** The guidance block's inner text (see withJ2Guidance). */
  readonly guidance: string;
  /** PROFILE.md and the two skills, each at its project path. */
  readonly files: readonly StaffSkillFile[];
}

/** Everything the J2 template writes for the settings. */
export function j2Template(settings: StaffSettings, options: J2RenderOptions = {}): J2TemplateOutput {
  const variant = j2VariantFor(settings, options.echelon);
  const v = j2Vocabulary(settings, variant);
  return {
    variant,
    team: renderJ2Team(settings, options),
    guidance: j2Guidance(settings, options),
    files: [{ name: 'profile', path: '.planning/staff/PROFILE.md', content: renderProfileMarkdown(v.resolved) }, ...j2SkillFiles(settings.profile)]
  };
}

/** One valid rendering's settings: every profile, offered level, nation, planning type and echelon the template can be written for. */
export interface J2Rendering { readonly key: string; readonly settings: StaffSettings; readonly echelon?: TacticalEchelon }

export function j2Renderings(): J2Rendering[] {
  const found: J2Rendering[] = [];
  for (const profile of STAFF_PROFILE_IDS) {
    for (const level of STAFF_LEVELS) {
      if (!levelOffer(profile, level).offered) continue;
      const nations = profile === 'nato-ca' ? [...STAFF_NATIONS] : [undefined];
      for (const nation of nations) {
        for (const planningType of PLANNING_TYPES) {
          const settings: StaffSettings = { ...defaultStaffSettings(), profile, level, planningType, ...(nation ? { nation } : {}) };
          const echelons = level === 'tactical' ? [...TACTICAL_ECHELONS] : [undefined];
          for (const echelon of echelons) found.push({ key: [profile, level, nation, planningType, echelon].filter(Boolean).join('/'), settings, ...(echelon ? { echelon } : {}) });
        }
      }
    }
  }
  return found;
}

/** Every crosswalk step a roster's workflow covers (all eight, step 6 a person's). Exported for the tests. */
export function j2WorkflowSteps(settings: StaffSettings, echelon?: TacticalEchelon): CrosswalkStep[] {
  return workflow(j2Vocabulary(settings, j2VariantFor(settings, echelon))).map((row) => row.step).filter((step) => (CROSSWALK_STEPS as readonly number[]).includes(step));
}
