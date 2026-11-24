// SovAI: Load Staff Exercise Scenario (design 10, section 8; WP-DEMO). Puts the starter scenario, or a scenario file of your own, into
// `.planning/staff/scenario/` for a staff team to read, with the J2 and J5 demo scripts beside it. The reading, checking and writing live in
// staffScenarioLoader.ts; this file only asks the questions.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SCENARIO_DIR } from '../domain/staff/scenario';
import { ARCHIVE_DIR, hasLoadedScenario, loadScenarioIntoProject, readScenarioFile, REAL_ENTITIES_FILE, STARTER_SCENARIO_FILE } from './staffScenarioLoader';

export const LOAD_STAFF_SCENARIO_COMMAND = 'nearAi.loadStaffScenario';
export const STARTER_PICK = 'Starter scenario: Exercise IRON LANTERN';
export const OWN_PICK = 'A scenario file of your own…';
export const REPLACE_ACTION = 'Replace';

export interface StaffScenarioDeps {
  /** Asks for a scenario file; the default is VS Code's open dialog. */
  readonly pickFile?: () => Promise<string | undefined>;
  /** Loads the checked text into the project; the default is loadScenarioIntoProject. Tests pass one that fails. */
  readonly load?: typeof loadScenarioIntoProject;
}

async function pickFolder(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showInformationMessage('Open a project folder first. The scenario is written into the project for the staff team to read.');
    return undefined;
  }
  if (folders.length === 1) return folders[0].uri.fsPath;
  const picked = await vscode.window.showQuickPick(folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, root: folder.uri.fsPath })), { title: 'Load exercise scenario: which project?' });
  return picked?.root;
}

async function defaultPickFile(): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Load scenario', filters: { 'Scenario (JSON)': ['json'] } });
  return picked?.[0]?.fsPath;
}

export async function loadStaffScenario(deps: StaffScenarioDeps = {}): Promise<void> {
  const root = await pickFolder();
  if (!root) return;
  const source = await vscode.window.showQuickPick([
    { label: STARTER_PICK, detail: 'Fictional and unclassified: a peninsula, a coast and a strait, two sides with an order of battle, a mission and graded reports.' },
    { label: OWN_PICK, detail: `A SovAI staff scenario (JSON). It must be marked fictional, unclassified exercise data; names on your real-entity list (${REAL_ENTITIES_FILE} or the guard settings) are refused.` }
  ], { title: 'Load exercise scenario', placeHolder: 'Which scenario?' });
  if (!source) return;

  let text: string;
  if (source.label === STARTER_PICK) {
    const read = await readScenarioFile(STARTER_SCENARIO_FILE);
    if (!read.ok) { void vscode.window.showErrorMessage(`The starter scenario could not be read: ${read.message}`); return; }
    text = read.text;
  } else {
    const file = await (deps.pickFile ?? defaultPickFile)();
    if (!file) return;
    const read = await readScenarioFile(file);
    if (!read.ok) { void vscode.window.showErrorMessage(`Scenario not loaded. ${read.message}`); return; }
    text = read.text;
  }

  if (await hasLoadedScenario(root)) {
    const answer = await vscode.window.showWarningMessage(
      'This project already has an exercise scenario. Replace it?',
      { modal: true, detail: `The current scenario and its demo scripts move to ${ARCHIVE_DIR}/ first. Nothing is deleted.` },
      REPLACE_ACTION
    );
    if (answer !== REPLACE_ACTION) return;
  }

  // A write that fails part way (a full disk, a folder the person cannot write) is a refusal the person sees, not an unhandled rejection; the loader
  // has already put any earlier scenario back.
  let result: Awaited<ReturnType<typeof loadScenarioIntoProject>>;
  try {
    result = await (deps.load ?? loadScenarioIntoProject)(root, text);
  } catch (error) {
    void vscode.window.showErrorMessage(`Scenario not loaded. ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!result.ok) { void vscode.window.showErrorMessage(`Scenario not loaded. ${result.message}`); return; }
  const notes = [
    `${result.scenario.title} loaded into ${SCENARIO_DIR}/.`,
    ...(result.archivedTo ? [`The earlier scenario is in ${result.archivedTo}/.`] : []),
    result.demoSkipped ?? `Demo scripts for the J2 and J5 are in .planning/staff/demo/ (${result.settingsFrom === 'project' ? 'for this project\'s profile and level' : 'for the default profile and level; set the staff profile and load again to change them'}).`
  ];
  void vscode.window.showInformationMessage(notes.join(' '));
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, SCENARIO_DIR, 'README.md')));
    await vscode.window.showTextDocument(document, { preview: false });
  } catch {
    // Opening the overview is a convenience; the scenario is loaded either way.
  }
}

export function registerStaffScenario(context: vscode.ExtensionContext, deps: StaffScenarioDeps = {}): void {
  context.subscriptions.push(vscode.commands.registerCommand(LOAD_STAFF_SCENARIO_COMMAND, () => loadStaffScenario(deps)));
}
