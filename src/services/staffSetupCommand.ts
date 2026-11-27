// SovAI: Set Up a Staff Team. Asks the section, the doctrine profile, the level, the nation, the planning type and what the template offers on top,
// shows the roster (who drafts and who decides), then writes the team, its skills, PROFILE.md, the staff settings and the section's guidance, and offers
// to load the starter exercise scenario. The planning and writing live in staffSetup.ts; this file only asks and confirms.
import { OPEN_STAFF_ROOM_COMMAND } from '../domain/staff/commands';
import { STAFF_PRIVATE_MODELS_TEXT } from '../domain/staff/products';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { homeFolder, teamLibraryDir } from '../domain/teamStorage';
import { TeamLibrary } from '../agent/teams';
import {
  INSTITUTIONAL_COMMAND_GROUP_PROFILE, INSTITUTIONAL_COMMAND_GROUP_TEAM, INSTITUTIONAL_J2_CATALOGUE_TEAM, INSTITUTIONAL_J3_ACTION_REGISTER_TEAM, INSTITUTIONAL_J4_INVENTORY_TEAM, INSTITUTIONAL_J5_EVIDENCE_TEAM, INSTITUTIONAL_J6_BUSINESS_SERVICES_TEAM, INSTITUTIONAL_J7_LESSONS_TEAM, INSTITUTIONAL_J8_BUDGET_TEAM, INSTITUTIONAL_J9_REMIT_TEAM,
  institutionalRole, isInstitutionalRole, type InstitutionalRoleId,
} from '../agent/staff/institutionalCommand';
import { STAFF_TEMPLATES } from '../agent/staff/templates';
import type { StaffTemplateOptions } from '../agent/staff/templates';
import type { StaffTeamSection } from '../domain/staff/profiles';
import {
  applyStaffSetup, existingStaffSettings, requestedSection, levelChoices, nationChoices, planningTypeChoices, persistInstitutionalStaffSetup, planInstitutionalStaffSetup, planStaffSetup, profileChoices, readStaffSetupInputs, settingsFrom,
  SET_UP_STAFF_TEAM_COMMAND, staffTeamTarget, templateQuestions, type Choice, type InstitutionalStaffSetupPlan, type StaffSetupPlan
} from './staffSetup';
import type { MementoLike } from './stateHome';
import { hasLoadedScenario, loadScenarioIntoProject, readScenarioFile, STARTER_SCENARIO_FILE } from './staffScenarioLoader';

export const LOAD_STARTER_ACTION = 'Load IRON LANTERN';
export const SET_UP_ACTION = 'Set up the team';
export const REPLACE_TEAM_ACTION = 'Replace';

const catalogueStewardDecision = 'The fictional domain steward decides what the metadata means and which fields people can see.';

const businessServicesOwnerDecision = 'The fictional service portfolio owner approves service entries.';

const planningOwnerDecision = 'The fictional plan owner decides whether to carry unresolved assumptions.';

const remitLiaisonResponsibility = 'The fictional liaison lead verifies each organization’s remit. A legal reviewer handles unclear jurisdiction.';

const inventoryCustodianDecision = 'The fictional property custodian decides how to resolve count differences and custody questions.';

const budgetHumanDecisions = 'The fictional finance reporting officer validates the draft. The fictional comptroller decides on release.';

const institutionalChoices = ([INSTITUTIONAL_COMMAND_GROUP_TEAM, INSTITUTIONAL_J3_ACTION_REGISTER_TEAM, INSTITUTIONAL_J7_LESSONS_TEAM, INSTITUTIONAL_J2_CATALOGUE_TEAM, INSTITUTIONAL_J6_BUSINESS_SERVICES_TEAM, INSTITUTIONAL_J5_EVIDENCE_TEAM, INSTITUTIONAL_J9_REMIT_TEAM, INSTITUTIONAL_J4_INVENTORY_TEAM, INSTITUTIONAL_J8_BUDGET_TEAM] as const).map((value) => ({
  value,
  label: institutionalRole(value).label,
  detail: value === INSTITUTIONAL_J3_ACTION_REGISTER_TEAM
    ? `${INSTITUTIONAL_COMMAND_GROUP_PROFILE}. Fictional office-hours action register draft for a local test fixture.`
    : value === INSTITUTIONAL_J7_LESSONS_TEAM ? `${INSTITUTIONAL_COMMAND_GROUP_PROFILE}. Fictional office-hours observation draft for a local test fixture.`
    : value === INSTITUTIONAL_J2_CATALOGUE_TEAM ? `${INSTITUTIONAL_COMMAND_GROUP_PROFILE}. Fictional office records catalogue draft for a local test fixture. ${catalogueStewardDecision}`
    : value === INSTITUTIONAL_J6_BUSINESS_SERVICES_TEAM ? `${INSTITUTIONAL_COMMAND_GROUP_PROFILE}. Fictional business-service catalogue for a local test fixture. ${businessServicesOwnerDecision}`
    : value === INSTITUTIONAL_J5_EVIDENCE_TEAM ? `${INSTITUTIONAL_COMMAND_GROUP_PROFILE}. Fictional evidence and assumptions register for a local test fixture. ${planningOwnerDecision}`
    : value === INSTITUTIONAL_J9_REMIT_TEAM ? `${INSTITUTIONAL_COMMAND_GROUP_PROFILE}. Fictional library remit comparison for a local test fixture. ${remitLiaisonResponsibility}`
    : value === INSTITUTIONAL_J4_INVENTORY_TEAM ? `${INSTITUTIONAL_COMMAND_GROUP_PROFILE}. Fictional office inventory reconciliation for a local test fixture. ${inventoryCustodianDecision}`
    : value === INSTITUTIONAL_J8_BUDGET_TEAM ? `${INSTITUTIONAL_COMMAND_GROUP_PROFILE}. Fictional office budget evidence reconciliation for a local test fixture. ${budgetHumanDecisions}`
    : `${INSTITUTIONAL_COMMAND_GROUP_PROFILE}. Local draft setup for a test fixture.`,
}));

async function pick<T>(title: string, placeHolder: string, choices: Array<Choice<T>>, step: number, steps: number): Promise<T | undefined> {
  if (choices.length === 1) return choices[0].value;
  const picked = await vscode.window.showQuickPick(choices.map((choice) => ({ label: choice.label, ...(choice.detail ? { detail: choice.detail } : {}), value: choice.value })), { title: `${title} (${step}/${steps})`, placeHolder, ignoreFocusOut: true });
  return picked?.value;
}

async function projectFolder(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) { void vscode.window.showInformationMessage('Open a project folder first. A staff team writes its settings, skills and guidance into the project.'); return undefined; }
  if (folders.length === 1) return folders[0].uri.fsPath;
  const picked = await vscode.window.showQuickPick(folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, root: folder.uri.fsPath })), { title: 'Set up a staff team: which project?' });
  return picked?.root;
}

/** The roster as the person checks it: the named person who decides first, then each member who drafts, with whom it reports to. */
export function rosterItems(plan: StaffSetupPlan | InstitutionalStaffSetupPlan): vscode.QuickPickItem[] {
  const { roster } = plan;
  if ('institutional' in plan) {
    const isActionRegister = plan.institutional.binding.team === INSTITUTIONAL_J3_ACTION_REGISTER_TEAM;
    const isLessons = plan.institutional.binding.team === INSTITUTIONAL_J7_LESSONS_TEAM;
    const isCatalogue = plan.institutional.binding.team === INSTITUTIONAL_J2_CATALOGUE_TEAM;
    const isBusinessServices = plan.institutional.binding.team === INSTITUTIONAL_J6_BUSINESS_SERVICES_TEAM;
    const isPlanningEvidence = plan.institutional.binding.team === INSTITUTIONAL_J5_EVIDENCE_TEAM;
    const isLibraryRemits = plan.institutional.binding.team === INSTITUTIONAL_J9_REMIT_TEAM;
    const isInventory = plan.institutional.binding.team === INSTITUTIONAL_J4_INVENTORY_TEAM;
    const isBudget = plan.institutional.binding.team === INSTITUTIONAL_J8_BUDGET_TEAM;
    const humanDetail = isBudget ? 'Validates the budget evidence draft.'
      : isInventory ? inventoryCustodianDecision
      : isLibraryRemits ? remitLiaisonResponsibility
      : isPlanningEvidence ? `Reviews evidence, estimates and open items. ${planningOwnerDecision}`
      : isBusinessServices ? `Reviews the business-service catalogue draft. ${businessServicesOwnerDecision}`
      : isCatalogue ? `Reviews the catalogue draft. ${catalogueStewardDecision}`
      : isLessons ? 'Reviews the observation draft. The observer or lessons lead confirms facts and decides any merge or access changes.'
      : isActionRegister
      ? 'Reviews the action register draft. The fictional chair owns the decision, and the assigned person acknowledges any action.'
      : 'Reviews the draft and decides through the authorized process.';
    return [
      { label: isActionRegister || isLessons || isCatalogue || isBusinessServices || isPlanningEvidence || isLibraryRemits || isInventory || isBudget ? 'Human review' : 'A person decides', kind: vscode.QuickPickItemKind.Separator },
      { label: `$(person) ${roster.humanLead}`, description: 'human lead', detail: humanDetail },
      ...(isBudget ? [{ label: '$(person) Fictional comptroller', description: 'independent human reviewer', detail: 'Decides on release through separate human review.' }] : []),
      { label: 'Agent drafts', kind: vscode.QuickPickItemKind.Separator },
      ...roster.members.map((member) => ({ label: `$(hubot) ${member.name}`, description: member.role, detail: 'Requires an approved local test fixture.' })),
    ];
  }
  return [
    { label: 'A person decides', kind: vscode.QuickPickItemKind.Separator },
    { label: `$(person) ${roster.humanLead ?? 'The section lead'}`, description: 'named person', detail: 'Approves, rejects and releases every product with the SovAI: Staff commands. No member can.' },
    { label: `Agents draft (${roster.members.length} members, private models only)`, kind: vscode.QuickPickItemKind.Separator },
    ...roster.members.map((member) => ({ label: `$(hubot) ${member.name}`, description: member.role ?? '', detail: member.reportsTo ? `Reports to ${member.reportsTo}` : 'Leads the section\'s lanes and merges their work' }))
  ];
}

/**
 * The setup's "where may the members' models run" step. The cloud choice says where its private models come from (coherence review S5): the team stays
 * private and nothing about routing changes.
 */
export function localityChoices(): Array<Choice<'cloud' | 'local'>> {
  return [
    { value: 'cloud', label: 'NEAR AI Cloud', detail: `Private models in NEAR's TEE; members that research may use the web tools. ${STAFF_PRIVATE_MODELS_TEXT}` },
    { value: 'local', label: 'Local runtime only', detail: 'Models on this machine; the team is made without web tools.' }
  ];
}

/** Where "Task it now" puts the team's command: the sidebar chat's composer (focused, nothing sent). */
export interface StaffSetupChat { prefill(text: string): Promise<void> }

/** The "team is ready" message: it names the team and how to task it, with "Task it now" and "Open the Staff Room". */
export function readyMessage(teamName: string, slug: string, archived: boolean): string {
  return `${teamName} is set up for this project as /team:${slug}. ${STAFF_PRIVATE_MODELS_TEXT} Task it now to put its command in the SovAI chat, or open the Staff Room.${archived ? ' The earlier file is in your teams archive.' : ''}`;
}

async function confirmStaffSetup(plan: StaffSetupPlan | InstitutionalStaffSetupPlan): Promise<boolean> {
  const isActionRegister = 'institutional' in plan && plan.institutional.binding.team === INSTITUTIONAL_J3_ACTION_REGISTER_TEAM;
  const isLessons = 'institutional' in plan && plan.institutional.binding.team === INSTITUTIONAL_J7_LESSONS_TEAM;
  const isCatalogue = 'institutional' in plan && plan.institutional.binding.team === INSTITUTIONAL_J2_CATALOGUE_TEAM;
  const isBusinessServices = 'institutional' in plan && plan.institutional.binding.team === INSTITUTIONAL_J6_BUSINESS_SERVICES_TEAM;
  const isPlanningEvidence = 'institutional' in plan && plan.institutional.binding.team === INSTITUTIONAL_J5_EVIDENCE_TEAM;
  const isLibraryRemits = 'institutional' in plan && plan.institutional.binding.team === INSTITUTIONAL_J9_REMIT_TEAM;
  const isInventory = 'institutional' in plan && plan.institutional.binding.team === INSTITUTIONAL_J4_INVENTORY_TEAM;
  const isBudget = 'institutional' in plan && plan.institutional.binding.team === INSTITUTIONAL_J8_BUDGET_TEAM;
  const skill = isBudget ? 'office budget evidence reconciliation draft' : isInventory ? 'office inventory reconciliation draft' : isLibraryRemits ? 'library service remit comparison draft' : isPlanningEvidence ? 'evidence and assumptions register draft' : isBusinessServices ? 'business-service catalogue draft' : isCatalogue ? 'office records catalogue draft' : isLessons ? 'office-hours observation draft' : isActionRegister ? 'office-hours action register draft' : 'decision brief';
  const detail = 'institutional' in plan
    ? `Stages the ${INSTITUTIONAL_COMMAND_GROUP_PROFILE} definition and ${skill} skill in this editor profile.`
    : `Writes ${plan.roster.fileName}.md to your teams, PROFILE.md and the skills under .planning/staff/, the staff settings in project.json and the section's guidance in AGENTS.md.`;
  const confirm = { label: `$(check) ${SET_UP_ACTION}`, detail };
  const answer = await vscode.window.showQuickPick([confirm, ...rosterItems(plan)], {
    title: `${plan.roster.teamName}: check the roster`,
    placeHolder: isBudget ? `The member drafts the office budget evidence reconciliation. ${budgetHumanDecisions} Choose "Set up the team" to stage this role.`
      : isInventory ? `The member drafts the office inventory reconciliation. ${inventoryCustodianDecision} Choose "Set up the team" to stage this role.`
      : isLibraryRemits ? `The member drafts the remit comparison. ${remitLiaisonResponsibility} Choose "Set up the team" to stage this role.`
      : isPlanningEvidence ? `The member drafts the evidence and assumptions register. ${planningOwnerDecision} Choose "Set up the team" to stage this role.`
      : isBusinessServices ? `The member drafts the business-service catalogue. ${businessServicesOwnerDecision} Choose "Set up the team" to stage this role.`
      : isCatalogue ? `The member drafts the catalogue. ${catalogueStewardDecision} Choose "Set up the team" to stage this role.`
      : isLessons ? 'The member drafts for human review. Choose "Set up the team" to stage the local test role.'
      : isActionRegister
      ? 'The member drafts for review. The fictional chair owns the decision. Choose "Set up the team" to stage this role.'
      : 'Members draft and recommend; the named person decides. Choose "Set up the team" to write it.',
    ignoreFocusOut: true,
  });
  return answer === confirm;
}

async function stageInstitutionalStaffSetup(root: string, team: InstitutionalRoleId, state: MementoLike | undefined): Promise<void> {
  try {
    const plan = await planInstitutionalStaffSetup({ root, team });
    if (!await confirmStaffSetup(plan)) return;
    const projectStillSelected = () => vscode.workspace.workspaceFolders?.some((folder) => folder.uri.fsPath === root) === true;
    await persistInstitutionalStaffSetup(plan, state, projectStillSelected);
    const status = projectStillSelected() ? 'Staged for this project.' : `Staged for the confirmed project "${plan.institutional.root}".`;
    const readiness = team === INSTITUTIONAL_J3_ACTION_REGISTER_TEAM
      ? 'The office-hours action register draft requires the approved local test fixture before the member can run.'
      : team === INSTITUTIONAL_J7_LESSONS_TEAM ? 'The office-hours observation draft requires the approved local test fixture before the member can run.'
      : team === INSTITUTIONAL_J2_CATALOGUE_TEAM ? 'The office records catalogue draft requires the approved local test fixture before the member can run.'
      : team === INSTITUTIONAL_J6_BUSINESS_SERVICES_TEAM ? 'The business-service catalogue draft requires the approved local test fixture before the member can run.'
      : team === INSTITUTIONAL_J5_EVIDENCE_TEAM ? 'The evidence and assumptions register draft requires the approved local test fixture before the member can run.'
      : team === INSTITUTIONAL_J9_REMIT_TEAM ? 'The library service remit comparison draft requires the approved local test fixture before the member can run.'
      : team === INSTITUTIONAL_J4_INVENTORY_TEAM ? 'The office inventory reconciliation draft requires the approved local test fixture before the member can run.'
      : team === INSTITUTIONAL_J8_BUDGET_TEAM ? 'The office budget evidence reconciliation draft requires the approved local test fixture before the member can run.'
      : 'The draft member requires the approved local test fixture before it can run.';
    void vscode.window.showInformationMessage(`${status} ${readiness}`);
  } catch (error) {
    void vscode.window.showErrorMessage(`Institutional setup is on hold. ${(error as Error).message}`);
  }
}

export async function setUpStaffTeam(
  library = new TeamLibrary(teamLibraryDir(homeFolder())),
  section?: StaffTeamSection,
  chat?: StaffSetupChat,
  state?: MementoLike
): Promise<string | undefined> {
  const root = await projectFolder();
  if (!root) return undefined;
  const title = 'Set up a staff team';
  const steps = 6;

  const asked = section ? STAFF_TEMPLATES.find((candidate) => candidate.section === section) : undefined;
  const templateId = asked ? asked.id : await pick(title, 'Which staff section?', [
    ...STAFF_TEMPLATES.map((template) => ({ value: template.id, label: template.label, detail: template.description })),
    ...institutionalChoices,
  ], 1, steps);
  if (templateId !== undefined && isInstitutionalRole(templateId)) {
    await stageInstitutionalStaffSetup(root, templateId, state);
    return undefined;
  }
  const template = STAFF_TEMPLATES.find((candidate) => candidate.id === templateId);
  if (!template) return undefined;
  const inputs = await readStaffSetupInputs(root);
  const existing = existingStaffSettings(inputs.projectJson);
  const profile = await pick(title, 'Which doctrine profile? Its terms, steps and annex letters follow it.', profileChoices(template), 2, steps);
  if (!profile) return undefined;
  const level = await pick(title, 'Which level?', levelChoices(template, profile), 3, steps);
  if (!level) return undefined;
  const nations = nationChoices(profile);
  const nation = nations.length ? await pick(title, 'Which nation\'s terms?', nations, 4, steps) : undefined;
  if (nations.length && !nation) return undefined;
  const planningType = await pick(title, 'Which kind of planning?', planningTypeChoices(), 5, steps);
  if (!planningType) return undefined;
  const settings = settingsFrom(existing, { profile, level, planningType, ...(nation ? { nation } : {}) });
  const questions = templateQuestions(template, settings);
  const echelon = questions.echelon ? await pick(title, 'Which echelon?', questions.echelon, 6, steps) : undefined;
  if (questions.echelon && !echelon) return undefined;
  const variant = questions.variant ? await pick(title, 'Which plans section?', questions.variant, 6, steps) : undefined;
  if (questions.variant && !variant) return undefined;
  const redTeam = questions.redTeam ? await pick(title, 'Include the independent red team?', questions.redTeam, 6, steps) : undefined;
  if (questions.redTeam && redTeam === undefined) return undefined;
  const where = await pick(title, 'Where may the members\' models run?', localityChoices(), 6, steps);
  if (!where) return undefined;
  const options: StaffTemplateOptions = { settings, locality: where, ...(echelon ? { echelon } : {}), ...(variant ? { variant } : {}), ...(redTeam === false ? { redTeam: false } : {}) };

  let plan: StaffSetupPlan;
  try { plan = planStaffSetup({ templateId: template.id, options, ...inputs }); } catch (error) { void vscode.window.showErrorMessage(`The staff team was not set up. ${(error as Error).message}`); return undefined; }

  if (!await confirmStaffSetup(plan)) return undefined;

  const target = await staffTeamTarget(library, plan);
  if (target.exists) {
    const replace = await vscode.window.showWarningMessage(`${plan.roster.fileName}.md is already in your teams. Replace it?`, { modal: true, detail: 'The current file moves to your teams archive first, where you can restore it. Nothing is deleted.' }, REPLACE_TEAM_ACTION);
    if (replace !== REPLACE_TEAM_ACTION) return undefined;
  }
  try {
    const result = await applyStaffSetup(root, library, plan, { replace: target.exists });
    const slug = path.basename(result.teamFile, '.md');
    const actions = chat ? [TASK_NOW_ACTION, OPEN_STAFF_ROOM_ACTION] : [OPEN_STAFF_ROOM_ACTION];
    void Promise.resolve(vscode.window.showInformationMessage(readyMessage(plan.roster.teamName, slug, Boolean(result.archived)), ...actions))
      .then((choice) => {
        if (choice === TASK_NOW_ACTION && chat) void chat.prefill(`/team:${slug}`);
        if (choice === OPEN_STAFF_ROOM_ACTION) void vscode.commands.executeCommand(OPEN_STAFF_ROOM_COMMAND);
      }, () => undefined);
    await offerStarterScenario(root);
    return result.teamFile;
  } catch (error) {
    void vscode.window.showErrorMessage(`The staff team was not set up. ${(error as Error).message}`);
    return undefined;
  }
}

/** Offers the IRON LANTERN starter scenario when the project has none yet; an existing scenario is left alone (the Load command replaces it). */
async function offerStarterScenario(root: string): Promise<void> {
  if (await hasLoadedScenario(root)) return;
  const choice = await vscode.window.showInformationMessage('Load the starter exercise scenario, IRON LANTERN, for the team to work on? It is fictional and unclassified.', LOAD_STARTER_ACTION, 'Not now');
  if (choice !== LOAD_STARTER_ACTION) return;
  const read = await readScenarioFile(STARTER_SCENARIO_FILE);
  if (!read.ok) { void vscode.window.showErrorMessage(`The starter scenario could not be read: ${read.message}`); return; }
  const loaded = await loadScenarioIntoProject(root, read.text);
  if (!loaded.ok) { void vscode.window.showErrorMessage(`Scenario not loaded. ${loaded.message}`); return; }
  void vscode.window.showInformationMessage(`${loaded.scenario.title} loaded into .planning/staff/scenario/, with demo scripts in .planning/staff/demo/.`);
}

/** The action on the "team is ready" message that opens the Staff Room. */
export const OPEN_STAFF_ROOM_ACTION = 'Open the Staff Room';
/** The action on the "team is ready" message that puts `/team:<name> ` in the chat's message box. */
export const TASK_NOW_ACTION = 'Task it now';

export function registerStaffSetup(context: vscode.ExtensionContext, chat?: StaffSetupChat, library?: TeamLibrary): void {
  context.subscriptions.push(vscode.commands.registerCommand(SET_UP_STAFF_TEAM_COMMAND, (arg?: unknown) => setUpStaffTeam(library, requestedSection(arg), chat, context.globalState)));
}
