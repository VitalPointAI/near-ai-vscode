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
  INSTITUTIONAL_COMMAND_GROUP_NAME, INSTITUTIONAL_COMMAND_GROUP_PROFILE, INSTITUTIONAL_COMMAND_GROUP_TEAM,
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
    return [
      { label: 'A person decides', kind: vscode.QuickPickItemKind.Separator },
      { label: `$(person) ${roster.humanLead}`, description: 'human lead', detail: 'Reviews the draft and decides through the authorized process.' },
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
  const detail = 'institutional' in plan
    ? `Stages the ${INSTITUTIONAL_COMMAND_GROUP_PROFILE} definition and decision brief skill in this editor profile.`
    : `Writes ${plan.roster.fileName}.md to your teams, PROFILE.md and the skills under .planning/staff/, the staff settings in project.json and the section's guidance in AGENTS.md.`;
  const confirm = { label: `$(check) ${SET_UP_ACTION}`, detail };
  const answer = await vscode.window.showQuickPick([confirm, ...rosterItems(plan)], {
    title: `${plan.roster.teamName}: check the roster`,
    placeHolder: 'Members draft and recommend; the named person decides. Choose "Set up the team" to write it.',
    ignoreFocusOut: true,
  });
  return answer === confirm;
}

async function stageInstitutionalStaffSetup(root: string, state: MementoLike | undefined): Promise<void> {
  try {
    const plan = await planInstitutionalStaffSetup(root);
    if (!await confirmStaffSetup(plan)) return;
    await persistInstitutionalStaffSetup(plan, state, () => Boolean(
      vscode.workspace.workspaceFolders?.some((folder) => folder.uri.fsPath === root)
    ));
    void vscode.window.showInformationMessage('Staged for this project. The draft member requires the approved local test fixture before it can run.');
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
    { value: INSTITUTIONAL_COMMAND_GROUP_TEAM, label: INSTITUTIONAL_COMMAND_GROUP_NAME, detail: `${INSTITUTIONAL_COMMAND_GROUP_PROFILE}. Local draft setup for a test fixture.` },
  ], 1, steps);
  if (templateId === INSTITUTIONAL_COMMAND_GROUP_TEAM) {
    await stageInstitutionalStaffSetup(root, state);
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
