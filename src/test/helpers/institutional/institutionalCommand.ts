import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  admittedInstitutionalBusinessServices, admittedInstitutionalCatalogue, admittedInstitutionalFindings, admittedInstitutionalLibraryRemits, admittedInstitutionalObservation, admittedInstitutionalPlanningEvidence, institutionalBriefDigest, institutionalBriefDirectory, institutionalBriefMaxBytes, institutionalObservationDirectory,
  institutionalCatalogueUnavailable, institutionalObservationInput, institutionalSourceHash, isInstitutionalCatalogueRecordId,
  prepareInstitutionalActionRegister, prepareInstitutionalBusinessServices, prepareInstitutionalCatalogue, prepareInstitutionalBrief, prepareInstitutionalFindings, prepareInstitutionalLibraryRemits, prepareInstitutionalObservation, prepareInstitutionalPlanningRegister,
  validateInstitutionalBriefSource, verifyInstitutionalActionAcceptance, type InstitutionalActionAuthority, type InstitutionalBriefSource,
  type InstitutionalDraftReview, type InstitutionalDraftScope, type InstitutionalObservationEvidence, type InstitutionalObservationReview, type PreparedInstitutionalDraft,
} from './institutionalBrief';
import { admittedInstitutionalAccessibility, prepareInstitutionalAccessibility } from './institutionalAccessibilityReview';
import { admittedInstitutionalBudget, admittedInstitutionalInventory, prepareInstitutionalBudget, prepareInstitutionalInventory } from './institutionalReconciliation';
import {
  admittedInstitutionalServiceMonitoring, prepareInstitutionalServiceMonitoring, readInstitutionalServiceMonitoring,
} from './institutionalServiceMonitoring';
import { canonicalBytes } from '../../../domain/team/canonical';
import { parseTeam, renderTeam, teamAgents, type TeamDefinition } from '../../../agent/teams';
import { declareManifest, fromArgument, INTERACTIVE_ONLY, type AgentTool, type ToolContext } from '../../../agent/tools';
import { ToolError } from '../../../agent/workspace';

export const INSTITUTIONAL_COMMAND_GROUP_TEAM = 'institutional-command-group-v1';
export const INSTITUTIONAL_COMMAND_GROUP_NAME = 'Institutional Command Group';
export const INSTITUTIONAL_COMMAND_GROUP_PROFILE = 'Canadian brigade (L3)';
export const INSTITUTIONAL_COMMAND_GROUP_LEAD = 'Command Group lead';
export const INSTITUTIONAL_COMMAND_GROUP_MEMBER = 'command-brief-drafter';
export const INSTITUTIONAL_J3_ACTION_REGISTER_TEAM = 'institutional-j3-action-register-v1';
export const INSTITUTIONAL_J7_LESSONS_TEAM = 'institutional-j7-lessons-v1';
export const INSTITUTIONAL_J2_CATALOGUE_TEAM = 'institutional-j2-records-catalogue-v1';
export const INSTITUTIONAL_J6_BUSINESS_SERVICES_TEAM = 'institutional-j6-business-services-v1';
export const INSTITUTIONAL_J5_EVIDENCE_TEAM = 'institutional-j5-evidence-assumptions-v1';
export const INSTITUTIONAL_J9_REMIT_TEAM = 'institutional-j9-library-remits-v1';
export const INSTITUTIONAL_J4_INVENTORY_TEAM = 'institutional-j4-inventory-counts-v1';
export const INSTITUTIONAL_J8_BUDGET_TEAM = 'institutional-j8-budget-evidence-v1';
export const INSTITUTIONAL_J1_MONITORING_TEAM = 'institutional-j1-service-monitoring-v1';
export const INSTITUTIONAL_ACCESSIBILITY_TEAM = 'institutional-ss-accessibility-v1';
export type InstitutionalRoleId = typeof INSTITUTIONAL_ACCESSIBILITY_TEAM | typeof INSTITUTIONAL_J1_MONITORING_TEAM | typeof INSTITUTIONAL_J8_BUDGET_TEAM | typeof INSTITUTIONAL_J4_INVENTORY_TEAM | typeof INSTITUTIONAL_J9_REMIT_TEAM | typeof INSTITUTIONAL_J5_EVIDENCE_TEAM | typeof INSTITUTIONAL_J6_BUSINESS_SERVICES_TEAM | typeof INSTITUTIONAL_J2_CATALOGUE_TEAM | typeof INSTITUTIONAL_COMMAND_GROUP_TEAM | typeof INSTITUTIONAL_J3_ACTION_REGISTER_TEAM | typeof INSTITUTIONAL_J7_LESSONS_TEAM;

const description = 'Prepare a local institutional decision brief for human review.';
const instructions = 'Prepare a CG-07 decision brief using only evidence admitted for this project. Separate sourced facts, assumptions and alternatives. Preserve attributed disagreement. Leave the decision with the Command Group lead.';

export const institutionalCommandGroupDefinition = renderTeam(INSTITUTIONAL_COMMAND_GROUP_NAME, description, [{
  name: INSTITUTIONAL_COMMAND_GROUP_MEMBER,
  role: 'Decision brief drafter',
  instructions,
}], { private: true });

export const institutionalCommandGroupSkill = [
  '# Decision brief (CG-07)',
  '',
  instructions,
  '',
  'State the decision requested, options, dependencies, uncertainties and dissent. Cite each factual claim to its exact source version and text span.',
  '',
  'Present the completed draft for human review. The brief does not approve a decision, change an official record or authorize release.',
  '',
].join('\n');

const actionRegisterName = 'Institutional G3 Action Register';
const actionRegisterInstructions = 'Draft the fictional J3-07 office-hours action register from the admitted extracts and accepted chair decision. Preserve uncertain assignments and dates for the chair. Leave acknowledgment and any handoff with the responsible human.';
const actionRegisterMember = 'action-register-drafter';
const lessonsName = 'Institutional G7 Lessons';
const lessonsMember = 'lessons-drafter';
const saveFindings = 'SaveInstitutionalAfterActionDraft';
const findingsInstructions = 'Draft fictional J7-10 office-hours findings for independent human validation. Show direct, corroborating and conflicting evidence, alternate explanations, uncertainty and missing implementation proof. Leave validation and release to the designated people.';
const lessonsInstructions = 'Draft a fictional J7-09 office-hours observation from admitted local evidence. Distinguish direct observation, reports, judgment and hypothesis. Retain uncertainty, citations, corrections and dissent for human review.';
const catalogueName = 'Institutional G2 Records Catalogue';
const catalogueInstructions = 'Draft a fictional J2-IS01 office records catalogue from authorized metadata. Leave meaning and field visibility with the human domain steward.';
const businessServicesName = 'Institutional G6 Business Services';
const businessServicesInstructions = 'Draft a fictional J6-IT01 business-service catalogue from authorized office documentation. Keep gaps open for the human service portfolio owner.';
const planningName = 'Institutional G5 Evidence and Assumptions';
const planningInstructions = 'Draft a fictional J5-03 office migration evidence register from attested entries. Keep estimates and assumptions distinct from facts and leave all decisions with the human plan owner.';
const libraryRemitsName = 'Institutional G9 Library Service Remits';
const libraryRemitsInstructions = 'Draft a fictional J9-CL02 public-library remit comparison from the admitted organization-level evidence. Keep distinct mandates and unresolved overlap for the human liaison lead and legal reviewer.';
const inventoryName = 'Institutional G4 Inventory Counts';
const inventoryInstructions = 'Draft a fictional J4-02 office inventory reconciliation from independently attested count and register evidence. Keep unresolved cases open for the human property custodian.';
const budgetName = 'Institutional G8 Budget Evidence';
const budgetInstructions = 'Draft a fictional J8-02 office budget evidence reconciliation from independently attested status and control evidence. Leave discrepancies open for the finance reporting officer and release for the comptroller.';
const monitoringName = 'Institutional G1 Service Monitoring';
const monitoringInstructions = 'Draft a fictional J1-05 office help aggregate from admitted summary evidence. Leave validation to the human HR services supervisor and source correction to the feed custodian.';
const accessibilityName = 'Institutional Special Staff Accessibility Review';
const accessibilityInstructions = 'Draft a fictional SS-18 help-sheet accessibility review from the admitted fixture observations. Keep observations, issues and evidence gaps distinct for the human accessibility adviser and product owner.';
const institutionalRoles = {
  [INSTITUTIONAL_COMMAND_GROUP_TEAM]: {
    label: INSTITUTIONAL_COMMAND_GROUP_NAME, member: INSTITUTIONAL_COMMAND_GROUP_MEMBER, lead: INSTITUTIONAL_COMMAND_GROUP_LEAD,
    definition: institutionalCommandGroupDefinition, skill: institutionalCommandGroupSkill, keySegment: 'commandGroup',
    read: 'ReadInstitutionalBriefEvidence', save: 'SaveInstitutionalBriefDraft',
  },
  [INSTITUTIONAL_J3_ACTION_REGISTER_TEAM]: {
    label: actionRegisterName, member: actionRegisterMember, lead: 'Fictional staff-coordination lead',
    definition: renderTeam(actionRegisterName, 'Prepare a local office-hours action register for human review.', [{
      name: actionRegisterMember, role: 'Action register drafter', instructions: actionRegisterInstructions,
    }], { private: true }),
    skill: ['# Office-hours action register (J3-07)', '', actionRegisterInstructions, '',
      'Cite exact admitted extracts. Deduplicate identical decision and action IDs. Leave unsupported owners and dates unresolved.', ''].join('\n'),
    keySegment: 'j3ActionRegister', read: 'ReadInstitutionalActionEvidence', save: 'SaveInstitutionalActionRegisterDraft',
  },
  [INSTITUTIONAL_J7_LESSONS_TEAM]: {
    label: lessonsName, member: lessonsMember, lead: 'Fictional lessons lead',
    definition: renderTeam(lessonsName, 'Prepare and cite local observations from a fictional office-hours trial.', [{
      name: lessonsMember, role: 'Lessons drafter', instructions: lessonsInstructions,
    }], { private: true }),
    skill: ['# Office-hours observations and lessons (J7-09 and J7-10)', '', lessonsInstructions,
      'Keep observation and findings in draft. The observer or lessons lead confirms facts, merge and access decisions. Independent human reviewers own findings validation.', ''].join('\n'),
    keySegment: 'j7Lessons', read: 'ReadInstitutionalLessonsEvidence', save: 'SaveInstitutionalObservationDraft',
  },
  [INSTITUTIONAL_J2_CATALOGUE_TEAM]: {
    label: catalogueName, member: 'records-catalogue-drafter', lead: 'Fictional domain steward',
    definition: renderTeam(catalogueName, 'Prepare local metadata for a fictional office records catalogue.', [{
      name: 'records-catalogue-drafter', role: 'Records catalogue drafter', instructions: catalogueInstructions,
    }], { private: true }),
    skill: ['# Fictional office records catalogue (J2-IS01)', '', catalogueInstructions,
      'Use the confirmed custodian references. Keep scope uncertainty separate from documented metadata availability.', ''].join('\n'),
    keySegment: 'j2RecordsCatalogue', read: 'ReadInstitutionalRecordMetadata', save: 'SaveInstitutionalRecordsCatalogueDraft',
  },
  [INSTITUTIONAL_J6_BUSINESS_SERVICES_TEAM]: {
    label: businessServicesName, member: 'business-services-drafter', lead: 'Fictional service portfolio owner',
    definition: renderTeam(businessServicesName, 'Prepare a local draft catalogue of fictional office services.', [{
      name: 'business-services-drafter', role: 'Business-service catalogue drafter', instructions: businessServicesInstructions,
    }], { private: true }),
    skill: ['# Fictional business-service catalogue (J6-IT01)', '', businessServicesInstructions,
      'Keep owner, freshness and duplicate exceptions open. Describe the authorized local support route and documented administrative dependencies.', ''].join('\n'),
    keySegment: 'j6BusinessServices', read: 'ReadInstitutionalBusinessService', save: 'SaveInstitutionalBusinessServicesDraft',
  },
  [INSTITUTIONAL_J5_EVIDENCE_TEAM]: {
    label: planningName, member: 'planning-evidence-drafter', lead: 'Fictional plan owner',
    definition: renderTeam(planningName, 'Prepare a local evidence and assumptions register for a fictional office document migration.', [{
      name: 'planning-evidence-drafter', role: 'Evidence and assumptions register drafter', instructions: planningInstructions,
    }], { private: true }),
    skill: ['# Office migration evidence and assumptions (J5-03)', '', planningInstructions,
      'Keep unknown quantities unresolved. Record admitted assumption reviewers and dates for the plan owner.', ''].join('\n'),
    keySegment: 'j5EvidenceAssumptions', read: 'ReadInstitutionalPlanningEvidence', save: 'SaveInstitutionalPlanningRegisterDraft',
  },
  [INSTITUTIONAL_J9_REMIT_TEAM]: {
    label: libraryRemitsName, member: 'library-remit-drafter', lead: 'Fictional liaison lead',
    definition: renderTeam(libraryRemitsName, 'Prepare a local comparison of the fictional library organizations and their service scopes.', [{
      name: 'library-remit-drafter', role: 'Library service remit drafter', instructions: libraryRemitsInstructions,
    }], { private: true }),
    skill: ['# Fictional library service remits (J9-CL02)', '', libraryRemitsInstructions,
      'Use the exact approved comparison scope and leave each organization and its consent evidence distinct.', ''].join('\n'),
    keySegment: 'j9LibraryRemits', read: 'ReadInstitutionalLibraryRemit', save: 'SaveInstitutionalLibraryRemitDraft',
  },
  [INSTITUTIONAL_J4_INVENTORY_TEAM]: {
    label: inventoryName, member: 'inventory-count-drafter', lead: 'Fictional property custodian',
    definition: renderTeam(inventoryName, 'Prepare a local count reconciliation for fictional office furniture and supplies.', [{
      name: 'inventory-count-drafter', role: 'Office inventory reconciliation drafter', instructions: inventoryInstructions,
    }], { private: true }),
    skill: ['# Fictional office inventory reconciliation (J4-02)', '', inventoryInstructions,
      'Compare the same item using independently attested quantities at the same cutoff and in the same unit. Preserve unknown custody and condition.', ''].join('\n'),
    keySegment: 'j4InventoryCounts', read: 'ReadInstitutionalInventoryCount', save: 'SaveInstitutionalInventoryDraft',
  },
  [INSTITUTIONAL_J8_BUDGET_TEAM]: {
    label: budgetName, member: 'budget-evidence-drafter', lead: 'Fictional finance reporting officer',
    definition: renderTeam(budgetName, 'Prepare a local comparison of fictional office budget evidence for the reporting period.', [{
      name: 'budget-evidence-drafter', role: 'Office budget evidence reconciliation drafter', instructions: budgetInstructions,
    }], { private: true }),
    skill: ['# Fictional office budget evidence reconciliation (J8-02)', '', budgetInstructions,
      'Compare verified values within the same category, approved period and fictional accounting unit. Keep unresolved differences open.', ''].join('\n'),
    keySegment: 'j8BudgetEvidence', read: 'ReadInstitutionalBudgetEvidence', save: 'SaveInstitutionalBudgetEvidenceDraft',
  },
  [INSTITUTIONAL_J1_MONITORING_TEAM]: {
    label: monitoringName, member: 'service-monitoring-drafter', lead: 'Fictional HR services supervisor',
    definition: renderTeam(monitoringName, 'Prepare a local draft of the approved fictional office-help aggregate.', [{
      name: 'service-monitoring-drafter', role: 'Office help aggregate drafter', instructions: monitoringInstructions,
    }], { private: true }),
    skill: ['# Fictional office help aggregate (J1-05)', '', monitoringInstructions,
      'Use only the admitted reporting basis. Leave unknown values unresolved for human review.', ''].join('\n'),
    keySegment: 'j1ServiceMonitoring', read: 'ReadInstitutionalServiceAggregate', save: 'SaveInstitutionalServiceMonitoringDraft',
  },
  [INSTITUTIONAL_ACCESSIBILITY_TEAM]: {
    label: accessibilityName, member: 'accessibility-review-drafter', lead: 'Fictional accessibility adviser',
    definition: renderTeam(accessibilityName, 'Prepare local accessibility observations for a fictional help sheet.', [{
      name: 'accessibility-review-drafter', role: 'Help-sheet accessibility review drafter', instructions: accessibilityInstructions,
    }], { private: true }),
    skill: ['# Fictional help-sheet accessibility review (SS-18)', '', accessibilityInstructions,
      'Use the approved fixture checklist and leave advice and remediation decisions pending with their human owners.', ''].join('\n'),
    keySegment: 'specialAccessibilityReview', read: 'ReadInstitutionalAccessibilityEvidence', save: 'SaveInstitutionalAccessibilityReviewDraft',
  },
} as const;

export function isInstitutionalRole(team: string): team is InstitutionalRoleId {
  return Object.hasOwn(institutionalRoles, team);
}

export function institutionalRole(team: InstitutionalRoleId) {
  return institutionalRoles[team];
}

export function institutionalDigest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface InstitutionalRoleBinding<T extends InstitutionalRoleId = InstitutionalRoleId> {
  readonly version: 1;
  readonly echelon: 'L3';
  readonly rootDigest: string;
  readonly directoryDigest: string;
  readonly team: T;
  readonly teamDigest: string;
  readonly skillDigest: string;
}

export type InstitutionalCommandGroupBinding = InstitutionalRoleBinding<typeof INSTITUTIONAL_COMMAND_GROUP_TEAM>;

export function institutionalRoleBinding<T extends InstitutionalRoleId>(canonicalRoot: string, directoryDigest: string, team: T): InstitutionalRoleBinding<T> {
  const role = institutionalRole(team);
  return {
    version: 1,
    echelon: 'L3',
    rootDigest: institutionalDigest(canonicalRoot),
    directoryDigest,
    team,
    teamDigest: institutionalDigest(role.definition),
    skillDigest: institutionalDigest(role.skill),
  };
}

export function institutionalCommandGroupBinding(canonicalRoot: string, directoryDigest: string): InstitutionalCommandGroupBinding {
  return institutionalRoleBinding(canonicalRoot, directoryDigest, INSTITUTIONAL_COMMAND_GROUP_TEAM);
}

/** Checks the exact setup-owned binding. Matching metadata is not run authority. */
export function readInstitutionalRoleBinding<T extends InstitutionalRoleBinding>(value: unknown, expected: T): T | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const fields = Object.keys(expected) as Array<keyof InstitutionalRoleBinding>;
  if (Object.keys(record).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field) || record[field] !== expected[field])) return undefined;
  return expected;
}

export function readInstitutionalCommandGroupBinding(value: unknown, expected: InstitutionalCommandGroupBinding): InstitutionalCommandGroupBinding | undefined {
  return readInstitutionalRoleBinding(value, expected);
}

/** This host port is supplied only by the private synthetic acceptance fixture. */
export interface InstitutionalCommandFixture {
  readonly root: string;
  readonly runId: string;
  readonly model: string;
  readonly policyHash: string;
  readonly currentActionSettings: () => unknown;
  readonly readStaged: () => unknown;
  readonly currentSources: () => readonly InstitutionalBriefSource[];
  readonly withStableParents: <T>(operation: () => Promise<T>) => Promise<T>;
}

interface InstitutionalAccessibilityFixture extends InstitutionalCommandFixture {
  readonly currentAccessibilityReview: () => unknown;
}

interface InstitutionalServiceMonitoringFixture extends InstitutionalCommandFixture {
  readonly currentServiceMonitoring: () => unknown;
}

interface InstitutionalBudgetFixture extends InstitutionalCommandFixture {
  readonly currentBudget: () => unknown;
}

interface InstitutionalInventoryFixture extends InstitutionalCommandFixture {
  readonly currentInventory: () => unknown;
}

interface InstitutionalLibraryRemitsFixture extends InstitutionalCommandFixture {
  readonly currentLibraryRemits: () => unknown;
  readonly currentLibraryRemitTime: () => unknown;
}

interface InstitutionalPlanningFixture extends InstitutionalCommandFixture {
  readonly currentPlanningEvidence: () => unknown;
}

interface InstitutionalBusinessServicesFixture extends InstitutionalCommandFixture {
  readonly currentBusinessServices: () => unknown;
}

interface InstitutionalCatalogueFixture extends InstitutionalCommandFixture {
  readonly currentCatalogue: () => unknown;
}

interface InstitutionalActionRegisterFixture extends InstitutionalCommandFixture {
  readonly actionAuthority: InstitutionalActionAuthority & { readonly predecessorTeam: TeamDefinition };
}

interface InstitutionalObservationFixture extends InstitutionalCommandFixture {
  readonly currentObservation: () => unknown;
}

interface InstitutionalFindingsFixture extends InstitutionalCommandFixture {
  readonly findingsAuthority: {
    readonly predecessorTeam: TeamDefinition;
    readonly readObservation: () => Promise<InstitutionalObservationReview>;
    readonly current: () => unknown;
  };
}

const fixtureSelections = new WeakMap<TeamDefinition, { readonly fixture: InstitutionalCommandFixture; readonly scope: InstitutionalDraftScope }>();
const stale = 'The institutional command fixture no longer matches the staged project, source or run.';

async function captureInstitutionalBinding(root: string, team: InstitutionalRoleId): Promise<InstitutionalRoleBinding> {
  if (path.resolve(root) !== root || await realpath(root) !== root) throw new ToolError(stale);
  const info = await lstat(root, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new ToolError(stale);
  return institutionalRoleBinding(root, institutionalDigest(`${info.dev}:${info.ino}:${info.birthtimeNs}`), team);
}

export async function selectSyntheticInstitutionalCommandGroup(fixture: InstitutionalCommandFixture): Promise<TeamDefinition> {
  return selectSyntheticInstitutionalRole(fixture, INSTITUTIONAL_COMMAND_GROUP_TEAM);
}

export async function selectSyntheticInstitutionalJ3ActionRegister(fixture: InstitutionalActionRegisterFixture): Promise<TeamDefinition> {
  return selectSyntheticInstitutionalRole(fixture, INSTITUTIONAL_J3_ACTION_REGISTER_TEAM, { authority: fixture.actionAuthority });
}

export async function selectSyntheticInstitutionalJ7Observation(fixture: InstitutionalObservationFixture): Promise<TeamDefinition> {
  return selectSyntheticInstitutionalRole(fixture, INSTITUTIONAL_J7_LESSONS_TEAM, { currentObservation: fixture.currentObservation });
}

export async function selectSyntheticInstitutionalJ7Findings(fixture: InstitutionalFindingsFixture): Promise<TeamDefinition> {
  return selectSyntheticInstitutionalRole(fixture, INSTITUTIONAL_J7_LESSONS_TEAM, { findingsAuthority: fixture.findingsAuthority });
}

export async function selectSyntheticInstitutionalJ2Catalogue(fixture: InstitutionalCatalogueFixture): Promise<TeamDefinition> {
  return selectSyntheticInstitutionalRole(fixture, INSTITUTIONAL_J2_CATALOGUE_TEAM, { currentCatalogue: fixture.currentCatalogue });
}

export async function selectSyntheticInstitutionalJ6BusinessServices(fixture: InstitutionalBusinessServicesFixture): Promise<TeamDefinition> {
  return selectSyntheticInstitutionalRole(fixture, INSTITUTIONAL_J6_BUSINESS_SERVICES_TEAM, { currentBusinessServices: fixture.currentBusinessServices });
}

export async function selectSyntheticInstitutionalJ5Evidence(fixture: InstitutionalPlanningFixture): Promise<TeamDefinition> {
  return selectSyntheticInstitutionalRole(fixture, INSTITUTIONAL_J5_EVIDENCE_TEAM, { currentPlanningEvidence: fixture.currentPlanningEvidence });
}

export async function selectSyntheticInstitutionalJ9Remits(fixture: InstitutionalLibraryRemitsFixture): Promise<TeamDefinition> {
  return selectSyntheticInstitutionalRole(fixture, INSTITUTIONAL_J9_REMIT_TEAM, {
    currentLibraryRemits: fixture.currentLibraryRemits, currentLibraryRemitTime: fixture.currentLibraryRemitTime,
  });
}

export async function selectSyntheticInstitutionalJ4Inventory(fixture: InstitutionalInventoryFixture): Promise<TeamDefinition> {
  return selectSyntheticInstitutionalRole(fixture, INSTITUTIONAL_J4_INVENTORY_TEAM, { currentInventory: fixture.currentInventory });
}

export async function selectSyntheticInstitutionalJ8Budget(fixture: InstitutionalBudgetFixture): Promise<TeamDefinition> {
  return selectSyntheticInstitutionalRole(fixture, INSTITUTIONAL_J8_BUDGET_TEAM, { currentBudget: fixture.currentBudget });
}

export async function selectSyntheticInstitutionalJ1Monitoring(fixture: InstitutionalServiceMonitoringFixture): Promise<TeamDefinition> {
  return selectSyntheticInstitutionalRole(fixture, INSTITUTIONAL_J1_MONITORING_TEAM, { currentServiceMonitoring: fixture.currentServiceMonitoring });
}

export async function selectSyntheticInstitutionalAccessibility(fixture: InstitutionalAccessibilityFixture): Promise<TeamDefinition> {
  return selectSyntheticInstitutionalRole(fixture, INSTITUTIONAL_ACCESSIBILITY_TEAM, { currentAccessibilityReview: fixture.currentAccessibilityReview });
}

async function selectSyntheticInstitutionalRole(fixture: InstitutionalCommandFixture, teamId: InstitutionalRoleId, {
  authority, currentObservation, findingsAuthority, currentCatalogue, currentBusinessServices, currentPlanningEvidence, currentLibraryRemits, currentLibraryRemitTime, currentInventory, currentBudget, currentServiceMonitoring, currentAccessibilityReview,
}: { authority?: InstitutionalActionRegisterFixture['actionAuthority']; currentObservation?: () => unknown;
  findingsAuthority?: InstitutionalFindingsFixture['findingsAuthority']; currentCatalogue?: () => unknown; currentBusinessServices?: () => unknown; currentPlanningEvidence?: () => unknown;
  currentLibraryRemits?: () => unknown; currentLibraryRemitTime?: () => unknown; currentInventory?: () => unknown; currentBudget?: () => unknown; currentServiceMonitoring?: () => unknown; currentAccessibilityReview?: () => unknown } = {}): Promise<TeamDefinition> {
  const exact = await captureInstitutionalBinding(fixture.root, teamId);
  if (!readInstitutionalRoleBinding(fixture.readStaged(), exact) || typeof fixture.withStableParents !== 'function' ||
      typeof fixture.currentSources !== 'function' || typeof fixture.currentActionSettings !== 'function' || !fixture.runId || !fixture.model ||
      !/^[a-f0-9]{64}$/.test(fixture.policyHash) || (teamId === INSTITUTIONAL_J3_ACTION_REGISTER_TEAM && !authority) ||
      (teamId === INSTITUTIONAL_ACCESSIBILITY_TEAM && typeof currentAccessibilityReview !== 'function') ||
      (teamId === INSTITUTIONAL_J1_MONITORING_TEAM && typeof currentServiceMonitoring !== 'function') ||
      (teamId === INSTITUTIONAL_J8_BUDGET_TEAM && typeof currentBudget !== 'function') ||
      (teamId === INSTITUTIONAL_J4_INVENTORY_TEAM && typeof currentInventory !== 'function') ||
      (teamId === INSTITUTIONAL_J9_REMIT_TEAM && (typeof currentLibraryRemits !== 'function' || typeof currentLibraryRemitTime !== 'function')) ||
      (teamId === INSTITUTIONAL_J5_EVIDENCE_TEAM && typeof currentPlanningEvidence !== 'function') ||
      (teamId === INSTITUTIONAL_J6_BUSINESS_SERVICES_TEAM && typeof currentBusinessServices !== 'function') ||
      (teamId === INSTITUTIONAL_J2_CATALOGUE_TEAM && typeof currentCatalogue !== 'function') ||
      (teamId === INSTITUTIONAL_J7_LESSONS_TEAM && typeof currentObservation !== 'function' && !findingsAuthority)) throw new ToolError(stale);
  const role = institutionalRole(teamId);
  const team = parseTeam(role.definition, `${teamId}.md`);
  for (const member of team.members) {
    // Keep the staged definition bytes stable. Only the selected fixture supplies the explicit tool list.
    member.tools = [role.read, findingsAuthority ? saveFindings : role.save];
    if (findingsAuthority) member.instructions = findingsInstructions;
    Object.freeze(member.tools);
    Object.freeze(member);
  }
  Object.freeze(team.members);
  Object.freeze(team);
  const binding = Object.freeze({ project: exact.rootDigest, directory: exact.directoryDigest, team: exact.team, teamVersion: exact.teamDigest, skillVersion: exact.skillDigest });
  const provider = Object.freeze({ ...fixture });
  const currentSources = () => {
    try { return admitted(provider.currentSources(), binding.project); }
    catch (error) {
      if (currentServiceMonitoring) return [];
      throw error;
    }
  };
  const stagedIsCurrent = () => Boolean(readInstitutionalRoleBinding(provider.readStaged(), exact));
  const catalogue = currentCatalogue && (() => {
    try { return admittedInstitutionalCatalogue(currentCatalogue(), binding, currentSources()); }
    catch { throw new ToolError(institutionalCatalogueUnavailable); }
  });
  const businessServices = currentBusinessServices && (() => {
    try { return admittedInstitutionalBusinessServices(currentBusinessServices(), binding, currentSources()); }
    catch { throw new ToolError(institutionalCatalogueUnavailable); }
  });
  const planningEvidence = currentPlanningEvidence && (() => {
    try { return admittedInstitutionalPlanningEvidence(currentPlanningEvidence(), binding, currentSources()); }
    catch { throw new ToolError(institutionalCatalogueUnavailable); }
  });
  const libraryRemits = currentLibraryRemits && currentLibraryRemitTime && (() => {
    try { return admittedInstitutionalLibraryRemits(currentLibraryRemits(), currentLibraryRemitTime(), binding, currentSources()); }
    catch { throw new ToolError(institutionalCatalogueUnavailable); }
  });
  const inventory = currentInventory && (() => {
    try { return admittedInstitutionalInventory(currentInventory(), binding, currentSources()); }
    catch { throw new ToolError(institutionalCatalogueUnavailable); }
  });
  const budget = currentBudget && (() => {
    try { return admittedInstitutionalBudget(currentBudget(), binding, currentSources()); }
    catch { throw new ToolError(institutionalCatalogueUnavailable); }
  });
  const serviceMonitoring = currentServiceMonitoring && (() => {
    try { return admittedInstitutionalServiceMonitoring(currentServiceMonitoring(), binding, currentSources()); }
    catch { return { state: 'unavailable', records: [] } as const; }
  });
  const accessibility = currentAccessibilityReview && (() => {
    try { return admittedInstitutionalAccessibility(currentAccessibilityReview(), binding, currentSources()); }
    catch { throw new ToolError(institutionalCatalogueUnavailable); }
  });
  accessibility?.();
  serviceMonitoring?.();
  budget?.();
  inventory?.();
  libraryRemits?.();
  planningEvidence?.();
  catalogue?.();
  businessServices?.();
  let actionRegister: InstitutionalDraftScope['actionRegister'];
  if (authority) {
    const evidence = Object.freeze({ ...authority, chair: Object.freeze({ ...authority.chair }) });
    const previousScope = fixtureSelections.get(evidence.predecessorTeam)?.scope;
    const command = institutionalCommandGroupBinding(fixture.root, exact.directoryDigest);
    if (!previousScope || previousScope.root !== fixture.root || previousScope.binding.directory !== exact.directoryDigest ||
        previousScope.binding.team !== command.team || !await previousScope.bindingIsCurrent()) throw new ToolError(stale);
    const previousSources = sourceHashes(previousScope.currentSources());
    const predecessorFacts = () => {
      try { return previousScope.stagedIsCurrent() && sameSources(previousSources, previousScope.currentSources()); }
      catch { return false; }
    };
    const previous = structuredClone(await evidence.readPredecessor());
    if (previous.kind !== 'brief' || previous.team !== command.team || previous.teamVersion !== command.teamDigest ||
        previous.skillVersion !== command.skillDigest || !predecessorFacts() ||
        previous.sources.some(({ id, hash }) => previousSources.get(id) !== hash)) throw new ToolError(stale);
    const previousDigest = institutionalBriefDigest(canonicalBytes(previous));
    actionRegister = Object.freeze({
      current: () => verifyInstitutionalActionAcceptance(evidence, previous, binding, currentSources()),
      predecessorFacts,
      predecessorAtEffect: (version) => version === previous.version && predecessorFacts() && Boolean(readExactDraftLeaf(fixture.root, institutionalBriefDirectory, version)),
      predecessorCurrent: async () => {
        try {
          if (!predecessorFacts()) return false;
          const reopened = await evidence.readPredecessor();
          return predecessorFacts() && institutionalBriefDigest(canonicalBytes(reopened)) === previousDigest;
        } catch { return false; }
      },
    });
    actionRegister.current();
  }
  let observation: InstitutionalDraftScope['observation'];
  if (currentObservation) {
    const current = () => admittedInstitutionalObservation(currentObservation(), binding, currentSources());
    observation = Object.freeze({
      current,
      correctionAtEffect: (correction: InstitutionalObservationEvidence['correction']) => {
        try {
          const active = current();
          return institutionalBriefDigest(canonicalBytes(active.correction)) === institutionalBriefDigest(canonicalBytes(correction)) &&
            (!correction || Boolean(reconstructObservationPredecessor(fixture.root, binding, currentSources(), active, correction.version)));
        } catch { return false; }
      },
    });
    current();
  }
  let findings: InstitutionalDraftScope['findings'];
  if (findingsAuthority) {
    const evidence = Object.freeze({ ...findingsAuthority });
    const priorScope = fixtureSelections.get(evidence.predecessorTeam)?.scope;
    const priorObservation = priorScope?.observation;
    if (!priorScope || !priorObservation || priorScope.root !== fixture.root ||
        priorScope.binding.directory !== binding.directory || priorScope.binding.team !== binding.team ||
        !await priorScope.bindingIsCurrent()) throw new ToolError(stale);
    const priorSources = sourceHashes(priorScope.currentSources());
    const priorApprovalDigest = institutionalBriefDigest(canonicalBytes(priorObservation.current()));
    const prior = structuredClone(await evidence.readObservation());
    const reviewDigest = institutionalBriefDigest(canonicalBytes(prior));
    const predecessorFacts = () => {
      try {
        return priorScope.stagedIsCurrent() && sameSources(priorSources, priorScope.currentSources()) &&
          institutionalBriefDigest(canonicalBytes(priorObservation.current())) === priorApprovalDigest;
      } catch { return false; }
    };
    if (prior.kind !== 'observation' || prior.team !== binding.team || prior.teamVersion !== binding.teamVersion ||
        prior.skillVersion !== binding.skillVersion || !predecessorFacts() ||
        prior.sources.some(({ id, hash }) => priorSources.get(id) !== hash)) throw new ToolError(stale);
    const priorBody = await priorScope.withStableParents(async () => predecessorFacts() &&
      priorObservation.correctionAtEffect(prior.correction) &&
      reconstructObservationPredecessor(priorScope.root, priorScope.binding, priorScope.currentSources(), priorObservation.current(), prior.version));
    if (!priorBody) throw new ToolError(stale);
    findings = Object.freeze({
      current: () => admittedInstitutionalFindings(evidence.current(), prior, priorBody, binding, currentSources()),
      predecessorCurrent: async () => {
        try {
          if (!predecessorFacts()) return false;
          const reopened = await evidence.readObservation();
          return predecessorFacts() && institutionalBriefDigest(canonicalBytes(reopened)) === reviewDigest;
        } catch { return false; }
      },
      predecessorAtEffect: (version: string) => {
        try {
          return version === prior.version && predecessorFacts() &&
            priorObservation.correctionAtEffect(prior.correction) &&
            Boolean(reconstructObservationPredecessor(priorScope.root, priorScope.binding, priorScope.currentSources(), priorObservation.current(), version));
        } catch { return false; }
      },
    });
    findings.current();
  }
  fixtureSelections.set(team, { fixture: provider, scope: Object.freeze({
    root: fixture.root, binding, withStableParents: fixture.withStableParents, currentSources, stagedIsCurrent,
    ...(actionRegister ? { actionRegister } : {}), ...(observation ? { observation } : {}), ...(findings ? { findings } : {}), ...(catalogue ? { catalogue } : {}), ...(businessServices ? { businessServices } : {}), ...(planningEvidence ? { planningEvidence } : {}), ...(libraryRemits ? { libraryRemits } : {}), ...(inventory ? { inventory } : {}), ...(budget ? { budget } : {}), ...(serviceMonitoring ? { serviceMonitoring } : {}), ...(accessibility ? { accessibility } : {}),
    bindingIsCurrent: async () => {
      const sampled = await captureInstitutionalBinding(provider.root, teamId);
      return sampled.directoryDigest === exact.directoryDigest && stagedIsCurrent();
    },
  }) });
  return team;
}

export function selectedInstitutionalScope(team: TeamDefinition): InstitutionalDraftScope | undefined {
  return fixtureSelections.get(team)?.scope;
}

export function selectedTeamAgents(team: TeamDefinition | undefined): ReturnType<typeof teamAgents> {
  if (!team || (isInstitutionalRole(team.slug) && !fixtureSelections.has(team))) return [];
  return teamAgents(team);
}

function admitted(current: readonly InstitutionalBriefSource[], project: string): readonly InstitutionalBriefSource[] {
  if (!Array.isArray(current) || current.length < 1 || current.length > 12 || current.some((source) => !validateInstitutionalBriefSource(source, project)) ||
      new Set(current.map((source) => source.id)).size !== current.length) throw new ToolError(stale);
  return current;
}

/** Read the bounded predecessor leaf synchronously under the fixture interlock. */
function readExactDraftLeaf(root: string, directory: string, version: string): Buffer | undefined {
  if (!/^[a-f0-9]{64}$/.test(version)) return undefined;
  const file = path.join(root, directory, `${version}.json`);
  try {
    if (realpathSync(file) !== file) return undefined;
    const before = lstatSync(file, { bigint: true });
    if (!before.isFile() || before.size > institutionalBriefMaxBytes) return undefined;
    const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return undefined;
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = readSync(descriptor, bytes, count, bytes.length - count, count);
        if (read === 0) break;
        count += read;
      }
      const after = lstatSync(file, { bigint: true });
      const payload = bytes.subarray(0, count);
      if (after.isFile() && after.dev === before.dev && after.ino === before.ino && after.size === before.size &&
          after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs && BigInt(count) === before.size &&
          institutionalBriefDigest(payload) === version) return payload;
      return undefined;
    } finally { closeSync(descriptor); }
  } catch { return undefined; }
}

function reconstructObservationPredecessor(
  root: string, binding: InstitutionalDraftScope['binding'], sources: readonly InstitutionalBriefSource[],
  approval: InstitutionalObservationEvidence, version: string,
): object | undefined {
  const bytes = readExactDraftLeaf(root, institutionalObservationDirectory, version);
  if (!bytes) return undefined;
  const stored: unknown = JSON.parse(bytes.toString('utf8'));
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return undefined;
  const { body, productId, correction } = stored as Record<string, unknown>;
  if (!body || typeof body !== 'object' || Array.isArray(body) || productId !== approval.productId) return undefined;
  const prior = admittedInstitutionalObservation({ ...approval, correction }, binding, sources);
  const expected = prepareInstitutionalObservation(institutionalObservationInput(body, productId), binding, sources, prior);
  return expected.review.version === version && bytes.equals(Buffer.from(expected.text)) ? body : undefined;
}

function sourceHashes(sources: readonly InstitutionalBriefSource[]): ReadonlyMap<string, string> {
  return new Map(sources.map((source) => [source.id, institutionalSourceHash(source)]));
}

function sameSources(expected: ReadonlyMap<string, string>, current: readonly InstitutionalBriefSource[]): boolean {
  return expected.size === current.length && current.every((source) => expected.get(source.id) === institutionalSourceHash(source));
}

const exactSchema = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const line = { type: 'string' };
const offset = { type: 'integer', minimum: 0 };
const entries = (items: Record<string, unknown>) => ({ type: 'array', items });
const citationSchema = entries(exactSchema({ sourceId: line, revision: line, start: offset, end: offset, quote: line }));
const briefSchema = exactSchema({
  productId: line, decisionRequested: line, facts: entries(exactSchema({ text: line, evidence: citationSchema })),
  alternatives: entries(line), assumptions: entries(line),
  dissent: entries(exactSchema({ attribution: line, text: line, evidence: citationSchema })), dependencies: entries(line),
});

const actionRegisterSchema = exactSchema({
  productId: line, rows: entries(exactSchema({
    decisionId: line, actionId: line, text: line, owner: { type: ['string', 'null'] }, dueDate: { type: ['string', 'null'] },
    acceptanceCriteria: line, dependencies: entries(exactSchema({ id: line, crossProgramme: { type: 'boolean' } })),
    exceptions: entries(line), acknowledgments: entries(exactSchema({ owner: line, date: line, evidence: citationSchema })),
    evidence: citationSchema,
  })),
});

const observationSchema = exactSchema({
  productId: line, time: line, timeKind: { ...line, enum: ['observed', 'reported'] },
  statements: entries(exactSchema({
    kind: { ...line, enum: ['observed', 'reported', 'judgment', 'hypothesis'] }, personId: line, text: line,
    confidence: { ...line, enum: ['low', 'medium', 'high'] }, evidence: citationSchema,
  })),
  relatedObservations: entries(line),
  potentialDuplicates: entries(exactSchema({ observationId: line, reason: line, evidence: citationSchema })),
  dissent: entries(exactSchema({ attribution: line, text: line, evidence: citationSchema })),
});

const catalogueReadSchema = exactSchema({ recordId: { ...line, pattern: '^item-[a-f0-9]{8}$' } });
const catalogueSaveSchema = exactSchema({ productId: line, recordIds: { ...entries({ ...line, pattern: '^item-[a-f0-9]{8}$' }), minItems: 1, maxItems: 12 } });
const findingsSchema = exactSchema({
  productId: line,
  candidates: entries(exactSchema({
    text: line, direct: citationSchema, corroborating: citationSchema, conflicting: citationSchema,
    alternateExplanations: entries(line), uncertainty: line, recommendation: line, implementationEvidence: line, independentCheck: line,
  })),
  dissent: entries(exactSchema({ attribution: line, text: line, evidence: citationSchema })),
  limitations: entries(exactSchema({ gap: line, resolve: line })),
});

export async function institutionalChildTools(
  team: TeamDefinition | undefined, selection: { root: string; runId: string; label: string; model: string; local: boolean; onTeam: boolean; detached: boolean },
  store: {
    verify: (scope: InstitutionalDraftScope, draft: PreparedInstitutionalDraft) => Promise<void>;
    commit: (scope: InstitutionalDraftScope, draft: PreparedInstitutionalDraft, verifyBeforeInstall: () => boolean) => Promise<InstitutionalDraftReview>;
  },
): Promise<[AgentTool<string>, AgentTool<PreparedInstitutionalDraft>] | undefined> {
  if (!team || !isInstitutionalRole(team.slug)) return undefined;
  const role = institutionalRole(team.slug);
  const selected = fixtureSelections.get(team);
  if (!selected || !selection.local || !selection.onTeam || selection.detached || selection.label !== role.member ||
      selected.scope.root !== selection.root || selected.fixture.runId !== selection.runId || selected.fixture.model !== selection.model) throw new ToolError(stale);
  const { scope, fixture: { policyHash, currentActionSettings } } = selected;
  if (!await scope.bindingIsCurrent() || (scope.actionRegister && !await scope.actionRegister.predecessorCurrent()) ||
      (scope.findings && !await scope.findings.predecessorCurrent())) throw new ToolError(stale);
  const approvedCatalogue = scope.catalogue?.();
  const approvedBusinessServices = scope.businessServices?.();
  const approvedPlanningEvidence = scope.planningEvidence?.();
  const approvedLibraryRemits = scope.libraryRemits?.();
  const approvedInventory = scope.inventory?.();
  const approvedBudget = scope.budget?.();
  const approvedServiceMonitoring = scope.serviceMonitoring?.();
  const approvedAccessibility = scope.accessibility?.();
  const approvedMetadata = approvedCatalogue ?? approvedBusinessServices ?? approvedPlanningEvidence ?? approvedLibraryRemits ??
    approvedInventory ?? approvedBudget ?? approvedServiceMonitoring ?? approvedAccessibility;
  const currentMetadata = scope.catalogue ?? scope.businessServices ?? scope.planningEvidence ?? scope.libraryRemits ??
    scope.inventory ?? scope.budget ?? scope.serviceMonitoring ?? scope.accessibility;
  const metadataDigest = approvedMetadata && institutionalBriefDigest(canonicalBytes(approvedMetadata));
  const accepted = scope.actionRegister?.current();
  const approvedObservation = scope.observation?.current();
  const observationDigest = approvedObservation && institutionalBriefDigest(canonicalBytes(approvedObservation));
  const approvedFindings = scope.findings?.current();
  const findingsDigest = approvedFindings && institutionalBriefDigest(canonicalBytes(approvedFindings));
  const readEvidence = role.read;
  const saveDraft = approvedFindings ? saveFindings : role.save;
  const sources = structuredClone(scope.currentSources());
  const approvedExtracts = approvedFindings && [
    ...approvedFindings.directEvidence, ...approvedFindings.conflictingEvidence, ...approvedFindings.correctionEvidence,
    ...approvedFindings.objective.evidence, ...approvedFindings.corroboratingEvidence,
  ];
  const quoteSources = approvedExtracts ? sources.map((source) => ({
    ...source,
    spans: source.spans.filter(({ start, end }) =>
      approvedExtracts.some((entry) => entry.sourceId === source.id && entry.start === start && entry.end === end)),
    dissentAttribution: approvedFindings?.dissentEvidence.some(({ sourceId }) => sourceId === source.id) ? source.dissentAttribution : undefined,
  })).filter(({ spans }) => spans.length > 0) : sources;
  const capturedSources = sourceHashes(sources);
  const currentFacts = (context: ToolContext) => {
    try {
      return sameSources(capturedSources, scope.currentSources()) && scope.stagedIsCurrent() && !context.signal.aborted &&
        (!currentMetadata || institutionalBriefDigest(canonicalBytes(currentMetadata())) === metadataDigest) &&
        (!scope.actionRegister || (scope.actionRegister.predecessorFacts() &&
          scope.actionRegister.current().predecessor.envelopeDigest === accepted?.predecessor.envelopeDigest)) &&
        (!scope.observation || institutionalBriefDigest(canonicalBytes(scope.observation.current())) === observationDigest) &&
        (!scope.findings || institutionalBriefDigest(canonicalBytes(scope.findings.current())) === findingsDigest);
    } catch { return false; }
  };
  const fresh = async (context: ToolContext) => Boolean(context.agentId && context.agentLabel === selection.label &&
    context.root === scope.root && !context.signal.aborted && await scope.bindingIsCurrent() && currentFacts(context));
  const project = (raw: Record<string, unknown>) => {
    let catalogueDraft: PreparedInstitutionalDraft | undefined;
    try {
      if (approvedCatalogue) catalogueDraft = prepareInstitutionalCatalogue(raw, scope.binding, sources, approvedCatalogue);
      if (approvedBusinessServices) catalogueDraft = prepareInstitutionalBusinessServices(raw, scope.binding, sources, approvedBusinessServices);
      if (approvedPlanningEvidence) catalogueDraft = prepareInstitutionalPlanningRegister(raw, scope.binding, sources, approvedPlanningEvidence);
      if (approvedLibraryRemits) catalogueDraft = prepareInstitutionalLibraryRemits(raw, scope.binding, sources, approvedLibraryRemits);
      if (approvedInventory) catalogueDraft = prepareInstitutionalInventory(raw, scope.binding, sources, approvedInventory);
      if (approvedBudget) catalogueDraft = prepareInstitutionalBudget(raw, scope.binding, sources, approvedBudget);
      if (approvedServiceMonitoring) catalogueDraft = prepareInstitutionalServiceMonitoring(raw, scope.binding, sources, approvedServiceMonitoring);
      if (approvedAccessibility) catalogueDraft = prepareInstitutionalAccessibility(raw, scope.binding, sources, approvedAccessibility);
    } catch { throw new ToolError(institutionalCatalogueUnavailable); }
    const draft = catalogueDraft ?? (approvedFindings ? prepareInstitutionalFindings(raw, scope.binding, sources, approvedFindings)
      : approvedObservation ? prepareInstitutionalObservation(raw, scope.binding, sources, approvedObservation)
      : accepted ? prepareInstitutionalActionRegister(raw, scope.binding, sources, accepted)
      : prepareInstitutionalBrief(raw, scope.binding, sources));
    draft.review.sources.forEach(Object.freeze);
    Object.freeze(draft.review.sources);
    if (draft.review.kind === 'accessibility-review') {
      Object.freeze(draft.review.sheet.evidence);
      Object.freeze(draft.review.sheet);
      Object.freeze(draft.review.adviser);
      Object.freeze(draft.review.productOwner);
    }
    if (draft.review.kind === 'service-monitoring') {
      Object.freeze(draft.review.supervisor);
      Object.freeze(draft.review.feedCustodian);
    }
    if (draft.review.kind === 'budget-evidence') {
      Object.freeze(draft.review.reportingOfficer);
      Object.freeze(draft.review.comptroller);
    }
    if (draft.review.kind === 'inventory-counts') Object.freeze(draft.review.propertyCustodian);
    if (draft.review.kind === 'library-service-remits') Object.freeze(draft.review.liaisonLead);
    if (draft.review.kind === 'planning-evidence') Object.freeze(draft.review.planOwner);
    if (draft.review.kind === 'business-services') Object.freeze(draft.review.portfolioOwner);
    if (draft.review.kind === 'records-catalogue') Object.freeze(draft.review.steward);
    if (draft.review.kind === 'action-register') Object.freeze(draft.review.predecessor);
    if (draft.review.kind === 'observation' && draft.review.correction) {
      draft.review.correction.evidence.forEach(Object.freeze);
      Object.freeze(draft.review.correction.evidence);
      Object.freeze(draft.review.correction);
    }
    if (draft.review.kind === 'findings') {
      draft.review.observation.sources.forEach(Object.freeze);
      Object.freeze(draft.review.observation.sources);
      Object.freeze(draft.review.observation);
      draft.review.objective.evidence.forEach(Object.freeze);
      Object.freeze(draft.review.objective.evidence);
      Object.freeze(draft.review.objective);
      Object.freeze(draft.review.reasoningReview);
      Object.freeze(draft.review.requiredApproval);
    }
    Object.freeze(draft.review);
    return Object.freeze(draft);
  };
  const read: AgentTool<string> = {
    name: readEvidence, description: approvedAccessibility ? 'Read one authorized fictional help-sheet observation by opaque ID.'
      : approvedServiceMonitoring ? 'Read the approved fictional office help aggregate by opaque ID.'
      : approvedBudget ? 'Read authorized fictional office budget evidence by opaque ID.'
      : approvedInventory ? 'Read one authorized fictional office count and register entry by opaque ID.'
      : approvedLibraryRemits ? 'Read one authorized fictional library service remit by opaque ID.'
      : approvedPlanningEvidence ? 'Read one authorized fictional office migration evidence entry by opaque ID.'
      : approvedBusinessServices ? 'Read authorized fictional office-service documentation by opaque ID.'
      : approvedCatalogue ? 'Read the authorized metadata for one fictional office record by opaque ID.'
      : 'Read the admitted text spans of one fictional evidence source by ID.',
    parameters: approvedMetadata ? catalogueReadSchema : exactSchema({ sourceId: { ...line, enum: quoteSources.map((source) => source.id) } }), capability: 'read',
    // The admitted extracts are in memory and have no workspace path.
    manifest: declareManifest({ tool: readEvidence, effects: [{ verb: 'plan' }], contexts: INTERACTIVE_ONLY }),
    fixtureGate: () => ({ policyHash, currentActionSettings, effect: { verb: 'plan' } }),
    parse(raw) {
      if (approvedMetadata) {
        if (Object.keys(raw).length !== 1 || !isInstitutionalCatalogueRecordId(raw.recordId)) throw new ToolError(institutionalCatalogueUnavailable);
        return raw.recordId;
      }
      if (Object.keys(raw).length !== 1 || typeof raw.sourceId !== 'string' || !quoteSources.some((source) => source.id === raw.sourceId)) throw new ToolError('This evidence is unavailable.');
      return raw.sourceId;
    },
    title: () => approvedAccessibility ? 'Read approved help-sheet observation' : approvedServiceMonitoring ? 'Read approved office help aggregate' : approvedBudget ? 'Read approved office budget evidence' : approvedInventory ? 'Read approved office inventory evidence' : approvedLibraryRemits ? 'Read approved library service remit' : approvedPlanningEvidence ? 'Read approved planning evidence' : approvedBusinessServices ? 'Read approved office-service documentation'
      : approvedCatalogue ? 'Read approved record metadata' : 'Read admitted brief evidence',
    async forbidden(_id, context) { return approvedMetadata || await fresh(context) ? undefined : stale; },
    async run(id, context) {
      if (approvedMetadata) {
        try {
          if (!await fresh(context)) throw new ToolError(institutionalCatalogueUnavailable);
          return await scope.withStableParents(async () => {
            if (!currentFacts(context) || !context.verifyFixtureGate?.(id)) throw new ToolError(institutionalCatalogueUnavailable);
            const record = approvedServiceMonitoring
              ? readInstitutionalServiceMonitoring(approvedServiceMonitoring, id)
              : approvedMetadata.records.find((entry) => entry.id === id);
            if (!record) throw new ToolError(institutionalCatalogueUnavailable);
            return JSON.stringify(record);
          });
        } catch { throw new ToolError(institutionalCatalogueUnavailable); }
      }
      if (!await fresh(context)) throw new ToolError(stale);
      const quote = () => {
        if (!context.verifyFixtureGate?.(id) ||
            (accepted && (!currentFacts(context) || !scope.actionRegister?.predecessorAtEffect(accepted.predecessor.version))) ||
            (approvedObservation && (!currentFacts(context) || !scope.observation?.correctionAtEffect(approvedObservation.correction))) ||
            (approvedFindings && (!currentFacts(context) || !scope.findings?.predecessorAtEffect(approvedFindings.observation.version)))) throw new ToolError(stale);
        const source = quoteSources.find((candidate) => candidate.id === id)!;
        return JSON.stringify({ id, revision: source.revision, date: source.date, label: source.label,
          ...(source.dissentAttribution ? { dissentAttribution: source.dissentAttribution } : {}),
          spans: source.spans.map(({ start, end }) => ({ start, end, quote: source.text.slice(start, end) })),
        });
      };
      return accepted || approvedObservation || approvedFindings ? scope.withStableParents(async () => quote()) : quote();
    },
  };
  const save: AgentTool<PreparedInstitutionalDraft> = {
    name: saveDraft, description: approvedAccessibility ? 'Save the fictional help-sheet accessibility review for its human adviser and product owner.'
      : approvedServiceMonitoring ? 'Save the approved fictional office help aggregate for human validation.'
      : approvedBudget ? 'Save fictional office budget evidence for the human finance reporting officer.'
      : approvedInventory ? 'Save a fictional office inventory comparison for the human property custodian.'
      : approvedLibraryRemits ? 'Save a fictional library service remit comparison for the human liaison lead.'
      : approvedPlanningEvidence ? 'Save an evidence and assumptions register draft for the human plan owner.'
      : approvedBusinessServices ? 'Save a fictional office-service catalogue for the human service portfolio owner.'
      : approvedCatalogue ? 'Save authorized fictional records metadata for the human domain steward.'
      : approvedFindings ? 'Save cited fictional office-hours candidate findings for independent human validation.'
      : approvedObservation ? 'Save one cited fictional office-hours observation for human review.'
      : accepted ? 'Save one cited fictional office-hours action register for human review.' : 'Save one cited CG-07 decision brief as a local draft for human review.',
    parameters: approvedMetadata ? catalogueSaveSchema : approvedFindings ? findingsSchema : approvedObservation ? observationSchema : accepted ? actionRegisterSchema : briefSchema, capability: 'workspaceWrite',
    manifest: declareManifest({ tool: saveDraft, effects: [{ verb: 'workspaceWrite', paths: [fromArgument('draftPath')] }], contexts: INTERACTIVE_ONLY }),
    fixtureGate: (draft) => ({ policyHash, currentActionSettings, effect: { verb: 'workspaceWrite', path: draft.path } }),
    parse: project,
    title: () => approvedAccessibility ? 'Save local help-sheet accessibility draft' : approvedServiceMonitoring ? 'Save local office help aggregate draft' : approvedBudget ? 'Save local office budget evidence draft' : approvedInventory ? 'Save local office inventory reconciliation draft' : approvedLibraryRemits ? 'Save local library remit comparison draft' : approvedPlanningEvidence ? 'Save local evidence register draft' : approvedBusinessServices ? 'Save local business-service catalogue draft'
      : approvedCatalogue ? 'Save local records catalogue draft' : approvedFindings ? 'Save local candidate findings draft' : approvedObservation ? 'Save local observation draft' : accepted ? 'Save local action register draft' : 'Save local decision brief draft',
    async forbidden(draft, context) {
      const unavailable = approvedMetadata ? institutionalCatalogueUnavailable : stale;
      if (!await fresh(context)) return unavailable;
      return store.verify(scope, draft).then(() => undefined, () => unavailable);
    },
    async run(draft, context) {
      const unavailable = approvedMetadata ? institutionalCatalogueUnavailable : stale;
      if (!await fresh(context) || !context.verifyFixtureGate?.(draft, draft.path)) throw new ToolError(unavailable);
      const stillCurrent = () => currentFacts(context) && Boolean(context.verifyFixtureGate?.(draft, draft.path));
      const review = await store.commit(scope, draft, stillCurrent).catch((error: unknown) => {
        if (approvedMetadata) throw new ToolError(unavailable);
        throw error;
      });
      if (approvedMetadata && !stillCurrent()) throw new ToolError(unavailable);
      return JSON.stringify({ state: 'draft', review });
    },
  };
  return [read, save];
}
