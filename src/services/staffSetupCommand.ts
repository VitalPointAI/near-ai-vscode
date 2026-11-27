// SovAI: Set Up a Staff Team. Asks the section, the doctrine profile, the level, the nation, the planning type and what the template offers on top,
// shows the roster (who drafts and who decides), then writes the team, its skills, PROFILE.md, the staff settings and the section's guidance, and offers
// to load the starter exercise scenario. The planning and writing live in staffSetup.ts; this file only asks and confirms.
import { OPEN_STAFF_ROOM_COMMAND } from '../domain/staff/commands';
import type { StaffLevel, StaffProfileId } from '../domain/staff/doctrine';
import { STAFF_PRIVATE_MODELS_TEXT } from '../domain/staff/products';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { homeFolder, teamLibraryDir } from '../domain/teamStorage';
import { TeamLibrary } from '../agent/teams';
import { STAFF_TEMPLATES } from '../agent/staff/templates';
import type { StaffTemplateOptions } from '../agent/staff/templates';
import type { StaffTeamSection } from '../domain/staff/profiles';
import {
  applyStaffSetup, existingStaffSettings, requestedSection, levelChoices, nationChoices, planningTypeChoices, planStaffSetup, profileChoices, readStaffSetupInputs, readStudioStaffInputs, reviewStudioStaffSetup, settingsFrom,
  SET_UP_STAFF_TEAM_COMMAND, staffTeamTarget, studioSharedTeamMessage, templateQuestions, type Choice, type StaffSetupPlan, type StudioStaffSelection
} from './staffSetup';
import type { MementoLike } from './stateHome';
import type { TeamStudioLocale } from './teamStudioStaffSetup';
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
export function rosterItems(plan: StaffSetupPlan, french = false): vscode.QuickPickItem[] {
  const { roster } = plan;
  return [
    { label: french ? 'Une personne décide' : 'A person decides', kind: vscode.QuickPickItemKind.Separator },
    {
      label: `$(person) ${roster.humanLead ?? (french ? 'Chef de section' : 'The section lead')}`,
      description: french ? 'Personne désignée' : 'named person',
      detail: french ? 'Approuve, rejette et diffuse chaque produit avec les commandes d’état-major de SovAI. Ce pouvoir appartient à cette personne.' : 'Approves, rejects and releases every product with the SovAI: Staff commands. No member can.'
    },
    { label: french ? `Les agents rédigent (${roster.members.length} membres, modèles privés seulement)` : `Agents draft (${roster.members.length} members, private models only)`, kind: vscode.QuickPickItemKind.Separator },
    ...roster.members.map((member) => ({
      label: `$(hubot) ${member.name}`, description: member.role ?? '',
      detail: member.reportsTo ? (french ? `Relève de ${member.reportsTo}` : `Reports to ${member.reportsTo}`)
        : (french ? 'Dirige les travaux de la section et rassemble les résultats' : 'Leads the section\'s lanes and merges their work')
    }))
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

export interface StaffSetupFixture {
  readonly choices: readonly Choice<string>[];
  stage(root: string, choice: string, state: MementoLike | undefined): Promise<void>;
}

interface StaffSetupRegistration {
  readonly chat?: StaffSetupChat;
  readonly library?: TeamLibrary;
  /** Supplied only by the isolated host harness, never by a command argument or setting. */
  readonly fixture?: StaffSetupFixture;
}

interface StaffSetupWizard extends StaffSetupRegistration {
  readonly section?: StaffTeamSection | undefined;
  readonly studio?: StudioStaffSelection;
  readonly language?: () => TeamStudioLocale;
  readonly state?: MementoLike;
}

const frenchModelUse = 'Les modèles privés qu’offre actuellement NEAR AI proviennent de développeurs de la République populaire de Chine. Utilisez cette équipe uniquement avec du matériel fictif ou d’exercice jusqu’à ce que votre organisation approuve un modèle pour le travail opérationnel.';
const frenchChoices: Record<string, Omit<Choice<unknown>, 'value'>> = {
  'us-joint': { label: 'Forces interarmées des États-Unis' },
  'us-army': { label: 'Armée de terre des États-Unis' },
  'nato-ca': { label: 'OTAN/Canada' },
  strategic: { label: 'Stratégique' },
  operational: { label: 'Opérationnel' },
  tactical: { label: 'Tactique' },
  ca: { label: 'Canada (termes canadiens en cas de différence)' },
  nato: { label: 'OTAN (termes alliés)' },
  campaign: { label: 'Campagne', detail: 'Planification à long terme dirigée par le J5.' },
  contingency: { label: 'Contingence', detail: 'Planification d’une situation éventuelle dirigée par le J5.' },
  crisis: { label: 'Crise', detail: 'Planification urgente dirigée par le J3. Les étapes peuvent se chevaucher.' },
  brigade: { label: 'Brigade', detail: 'Sept membres, dont un responsable de la collecte et un analyste des cibles.' },
  battalion: { label: 'Bataillon', detail: 'Cinq membres.' },
  standard: { label: 'Standard', detail: 'Deux cellules chargées des modes d’action.' },
  mdo: { label: 'Multidomaine', detail: 'Un planificateur de la convergence remplace la cellule B.' },
  true: { label: 'Avec l’équipe rouge', detail: 'Dans l’AJP-5, l’équipe rouge relève d’une disposition nationale du Royaume-Uni, distincte de la doctrine de l’OTAN. Elle est activée par défaut. Le commandant peut la désactiver.' },
  false: { label: 'Sans l’équipe rouge' },
  cloud: { label: 'NEAR AI Cloud', detail: `Modèles privés dans l’environnement d’exécution de confiance de NEAR. Les agents de recherche peuvent utiliser les outils Web. ${frenchModelUse}` },
  local: { label: 'Exécution locale seulement', detail: 'Les modèles s’exécutent sur cet ordinateur. L’équipe ne dispose pas d’outils Web.' }
};

const frenchLevelNotes: Record<StaffProfileId, Partial<Record<StaffLevel, string>>> = {
  'us-joint': {
    strategic: 'JPP dans les quatre fonctions de planification. Produits du CCMD ou de l’état-major interarmées (05 T2).',
    operational: 'JPP au niveau de la JTF (05 T2).'
  },
  'us-army': {
    tactical: 'MDMP du corps d’armée au bataillon. Procédures de commandement des troupes aux échelons inférieurs (05 s2).'
  },
  'nato-ca': {
    strategic: 'AJP-5, édition B, avec la COPD comme procédure. Le réglage Canada applique les fonctions stratégiques canadiennes.',
    operational: 'AJP-5, édition B.',
    tactical: 'APP-28 pour la planification tactique des forces terrestres.'
  }
};

/** The "team is ready" message: it names the team and how to task it, with "Task it now" and "Open the Staff Room". */
export function readyMessage(teamName: string, slug: string, archived: boolean, project = 'this project', shortcuts = true): string {
  const followUp = shortcuts ? 'Task it now to put its command in the SovAI chat, or open the Staff Room.' : 'Open the project in its own window to use the team.';
  return `${teamName} is set up for ${project} as /team:${slug}. ${STAFF_PRIVATE_MODELS_TEXT} ${followUp}${archived ? ' The earlier file is in your teams archive.' : ''}`;
}

async function confirmStaffSetup(plan: StaffSetupPlan, project?: string, french = false): Promise<boolean> {
  const detail = french
    ? `Projet : ${project}. Enregistre ${plan.roster.fileName}.md dans vos équipes, PROFILE.md et les compétences sous .planning/staff/, les paramètres d’état-major dans project.json et les consignes de la section dans AGENTS.md.`
    : `${project ? `Project: ${project}. ` : ''}Writes ${plan.roster.fileName}.md to your teams, PROFILE.md and the skills under .planning/staff/, the staff settings in project.json and the section's guidance in AGENTS.md.`;
  const confirm = { label: `$(check) ${french ? 'Configurer l’équipe' : SET_UP_ACTION}`, detail };
  const answer = await vscode.window.showQuickPick([confirm, ...rosterItems(plan, french)], {
    title: french ? `${plan.roster.teamName} : vérifier la composition` : `${plan.roster.teamName}: check the roster`,
    placeHolder: french ? 'Les membres rédigent et recommandent. La personne désignée décide. Choisissez « Configurer l’équipe » pour enregistrer la configuration.'
      : 'Members draft and recommend; the named person decides. Choose "Set up the team" to write it.',
    ignoreFocusOut: true,
  });
  return answer === confirm;
}

export async function setUpStaffTeam(options: StaffSetupWizard = {}): Promise<string | undefined> {
  const { library = new TeamLibrary(teamLibraryDir(homeFolder())), section, chat, state, fixture, studio } = options;
  const root = studio?.root ?? await projectFolder();
  if (!root) return undefined;
  const french = () => Boolean(studio && options.language?.() === 'fr-CA');
  const title = 'Set up a staff team';
  const steps = 6;
  function pickStep<T>(
    english: string, translation: string, choices: Array<Choice<T>>, step: number,
    translateDetail?: (value: T) => string | undefined
  ): Promise<T | undefined> {
    if (!french()) return pick(title, english, choices, step, steps);
    const translated = choices.map(choice => {
      const copy = frenchChoices[String(choice.value)];
      const detail = translateDetail?.(choice.value) ?? copy?.detail;
      return { ...choice, label: copy?.label ?? choice.label, ...(detail ? { detail } : {}) };
    });
    return pick('Configurer une équipe d’état-major', translation, translated, step, steps);
  }

  const asked = section ? STAFF_TEMPLATES.find((candidate) => candidate.section === section) : undefined;
  if (studio && (!asked || !studio.isCurrent())) return undefined;
  const templateId = asked ? asked.id : await pick(title, 'Which staff section?', [
    ...STAFF_TEMPLATES.map((template) => ({ value: template.id, label: template.label, detail: template.description })),
    ...(fixture?.choices ?? []),
  ], 1, steps);
  const fixtureChoice = asked ? undefined : fixture?.choices.find(({ value }) => value === templateId);
  if (fixture && fixtureChoice) {
    await fixture.stage(root, fixtureChoice.value, state);
    return undefined;
  }
  const template = STAFF_TEMPLATES.find((candidate) => candidate.id === templateId);
  if (!template) return undefined;
  const problem = (error: unknown) => {
    void vscode.window.showErrorMessage(french()
      ? 'Impossible de configurer l’équipe d’état-major. Vérifiez le projet sélectionné et les équipes déjà enregistrées, puis examinez de nouveau la configuration.'
      : `The staff team was not set up. ${error instanceof Error ? error.message : String(error)}`);
  };
  let studioInputs: Awaited<ReturnType<typeof readStudioStaffInputs>> | undefined;
  try {
    if (studio) studioInputs = await readStudioStaffInputs(studio);
  } catch (error) {
    problem(error);
    return undefined;
  }
  const inputs = studioInputs ?? await readStaffSetupInputs(root);
  const existing = existingStaffSettings(inputs.projectJson);
  const profiles = profileChoices(template);
  const preferredProfile = studio && existing ? profiles.findIndex(({ value }) => value === existing.profile) : -1;
  if (preferredProfile > 0) profiles.unshift(...profiles.splice(preferredProfile, 1));
  const profile = await pickStep(
    'Which doctrine profile? Its terms, steps and annex letters follow it.',
    'Quel profil doctrinal utiliser? Il détermine les termes, les étapes et les lettres des annexes.',
    profiles, 2, candidate => `Niveaux : ${levelChoices(template, candidate).map(({ value }) => frenchChoices[value].label.toLowerCase()).join(', ')}.`
  );
  if (!profile) return undefined;
  const level = await pickStep(
    'Which level?', 'Quel niveau?', levelChoices(template, profile), 3, candidate => frenchLevelNotes[profile][candidate]
  );
  if (!level) return undefined;
  const nations = nationChoices(profile);
  const nation = nations.length ? await pickStep('Which nation\'s terms?', 'Quels termes nationaux utiliser?', nations, 4) : undefined;
  if (nations.length && !nation) return undefined;
  const planningType = await pickStep('Which kind of planning?', 'Quel type de planification?', planningTypeChoices(), 5);
  if (!planningType) return undefined;
  const settings = settingsFrom(existing, { profile, level, planningType, ...(nation ? { nation } : {}) });
  const questions = templateQuestions(template, settings);
  const echelon = questions.echelon ? await pickStep('Which echelon?', 'Quel échelon?', questions.echelon, 6) : undefined;
  if (questions.echelon && !echelon) return undefined;
  const variant = questions.variant ? await pickStep('Which plans section?', 'Quelle section des plans?', questions.variant, 6) : undefined;
  if (questions.variant && !variant) return undefined;
  const redTeam = questions.redTeam ? await pickStep('Include the independent red team?', 'Inclure l’équipe rouge indépendante?', questions.redTeam, 6) : undefined;
  if (questions.redTeam && redTeam === undefined) return undefined;
  const where = await pickStep('Where may the members\' models run?', 'Où les modèles des membres peuvent-ils s’exécuter?', localityChoices(), 6);
  if (!where) return undefined;
  const templateOptions: StaffTemplateOptions = { settings, locality: where, ...(echelon ? { echelon } : {}), ...(variant ? { variant } : {}), ...(redTeam === false ? { redTeam: false } : {}) };

  let plan: StaffSetupPlan;
  try { plan = planStaffSetup({ templateId: template.id, options: templateOptions, ...inputs }); } catch (error) { problem(error); return undefined; }

  let review: Awaited<ReturnType<typeof reviewStudioStaffSetup>> | undefined;
  try {
    if (studio && studioInputs) {
      review = await reviewStudioStaffSetup(studio, studioInputs, plan);
      const target = await staffTeamTarget(library, plan);
      if (target.exists) throw new Error(studioSharedTeamMessage(target.file));
      if (!studio.isCurrent()) return undefined;
    }
  } catch (error) {
    problem(error);
    return undefined;
  }
  if (!await confirmStaffSetup(plan, studio?.name, french())) return undefined;

  const target = await staffTeamTarget(library, plan);
  if (!studio && target.exists) {
    const replace = await vscode.window.showWarningMessage(`${plan.roster.fileName}.md is already in your teams. Replace it?`, { modal: true, detail: 'The current file moves to your teams archive first, where you can restore it. Nothing is deleted.' }, REPLACE_TEAM_ACTION);
    if (replace !== REPLACE_TEAM_ACTION) return undefined;
  }
  try {
    const result = await applyStaffSetup(root, library, plan, review ? { studioReview: review } : { replace: target.exists });
    const slug = path.basename(result.teamFile, '.md');
    const mayNavigate = () => !studio || studio.isPrimary();
    const shortcuts = mayNavigate();
    const translated = french();
    const taskNow = translated ? 'Confier une tâche maintenant' : TASK_NOW_ACTION;
    const staffRoom = translated ? 'Ouvrir la salle d’état-major' : OPEN_STAFF_ROOM_ACTION;
    const actions = chat ? [taskNow, staffRoom] : [staffRoom];
    const message = translated
      ? `${plan.roster.teamName} est configurée pour ${studio?.name}. Sa commande est /team:${slug}. ${frenchModelUse} ${shortcuts ? 'Confiez-lui une tâche dans la conversation SovAI ou ouvrez la salle d’état-major.' : 'Ouvrez le projet dans sa propre fenêtre pour utiliser l’équipe.'}`
      : readyMessage(plan.roster.teamName, slug, Boolean(result.archived), studio?.name, shortcuts);
    void Promise.resolve(vscode.window.showInformationMessage(message, ...(shortcuts ? actions : [])))
      .then((choice) => {
        if (!shortcuts || !mayNavigate()) return;
        if (choice === taskNow && chat) void chat.prefill(`/team:${slug}`);
        if (choice === staffRoom) void vscode.commands.executeCommand(OPEN_STAFF_ROOM_COMMAND);
      }, () => undefined);
    if (!studio) await offerStarterScenario(root);
    return result.teamFile;
  } catch (error) {
    problem(error);
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

export function registerStaffSetup(context: vscode.ExtensionContext, options: StaffSetupRegistration = {}): void {
  context.subscriptions.push(vscode.commands.registerCommand(SET_UP_STAFF_TEAM_COMMAND, (arg?: unknown) =>
    setUpStaffTeam({ ...options, section: requestedSection(arg), state: context.globalState })));
}
