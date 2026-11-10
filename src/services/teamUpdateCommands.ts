import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { describePlan, type MemberDecision, type UpdateDecisions } from '../agent/teamUpdate';
import { TeamLibrary } from '../agent/teams';
import { runInProgress, whenIdle } from './runActivity';
import { TeamUpdater, UpdateNotices, type TeamUpdatePreview } from './teamUpdates';

// "NEAR AI: Update Team…" and the one-time "Team update available" notice. Nothing is written
// without a preview and a confirmation, never while a run is in progress, and every update can be
// undone from its backup.

export const UPDATE_TEAM_COMMAND = 'nearAi.updateTeam';
export const UPDATE_NOTICE_SETTING = 'teams.updateNotifications';

async function teamFiles(library: TeamLibrary): Promise<string[]> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const project = root ? TeamLibrary.projectTeamFile(root) : undefined;
  const global = (await readdir(library.directory).catch(() => [])).filter((name) => name.endsWith('.md')).map((name) => path.join(library.directory, name));
  const files = project ? [project, ...global] : global;
  const exists = await Promise.all(files.map((file) => vscode.workspace.fs.stat(vscode.Uri.file(file)).then(() => true, () => false)));
  return files.filter((_, index) => exists[index]);
}

async function showDiff(title: string, left: string, right: string): Promise<void> {
  const [a, b] = await Promise.all([vscode.workspace.openTextDocument({ content: left, language: 'markdown' }), vscode.workspace.openTextDocument({ content: right, language: 'markdown' })]);
  await vscode.commands.executeCommand('vscode.diff', a.uri, b.uri, title, { preview: true });
}

/** Asks, member by member, what to do with the members the user changed, which new members to add, and about changed guidance. */
async function decide(preview: TeamUpdatePreview): Promise<(UpdateDecisions & { guidance?: 'take' | 'keep' }) | undefined> {
  const members: Record<string, MemberDecision> = {};
  for (const member of preview.plan.members.filter((entry) => entry.action === 'choice')) {
    for (;;) {
      const pick = await vscode.window.showQuickPick([
        { label: '$(diff) Show the differences', id: 'diff' as const },
        { label: 'Take the new definition', description: 'replaces your version', id: 'take' as const },
        { label: 'Keep mine and add only the new lines', description: 'privacy, new tools, and new Output and Done-when sections', id: 'merge' as const },
        { label: 'Keep mine', description: 'unchanged', id: 'keep' as const }
      ], { title: `Update "${preview.name}": you changed ${member.name}`, placeHolder: member.reason, ignoreFocusOut: true });
      if (!pick) return undefined;
      if (pick.id === 'diff') { await showDiff(`${member.name}: yours ↔ new`, member.current ?? '', member.proposed ?? ''); continue; }
      members[member.name] = pick.id;
      break;
    }
  }
  const offered = preview.plan.members.filter((entry) => entry.action === 'new');
  let add: string[] = [];
  if (offered.length) {
    const picks = await vscode.window.showQuickPick(offered.map((entry) => ({ label: entry.name, description: 'new in the built-in team', picked: true })), { title: `Update "${preview.name}": add new members?`, canPickMany: true, ignoreFocusOut: true });
    if (!picks) return undefined;
    add = picks.map((pick) => pick.label);
  }
  let guidance: 'take' | 'keep' | undefined;
  if (preview.guidance?.action === 'choice') {
    for (;;) {
      const pick = await vscode.window.showQuickPick([{ label: '$(diff) Show the differences', id: 'diff' as const }, { label: 'Take the new guidance', id: 'take' as const }, { label: 'Keep my guidance', id: 'keep' as const }], { title: 'You changed the project-type guidance in AGENTS.md', ignoreFocusOut: true });
      if (!pick) return undefined;
      if (pick.id === 'diff') { await showDiff('AGENTS.md guidance: yours ↔ new', preview.guidance.current ?? '', preview.guidance.proposed ?? ''); continue; }
      guidance = pick.id;
      break;
    }
  }
  return { members, add, ...(guidance ? { guidance } : {}) };
}

export async function updateTeam(library: TeamLibrary, requested?: string): Promise<void> {
  if (runInProgress()) {
    void vscode.window.showInformationMessage('A team run is in progress. Update Team will be offered when it ends.');
    whenIdle(() => { void vscode.window.showInformationMessage('The run has ended. Update your team now?', 'Update Team…').then((choice) => { if (choice) void updateTeam(library, requested); }); });
    return;
  }
  const updater = new TeamUpdater(library);
  let file = requested;
  if (!file) {
    const previews = (await Promise.all((await teamFiles(library)).map((candidate) => updater.preview(candidate).catch(() => undefined)))).filter((preview): preview is TeamUpdatePreview => Boolean(preview));
    if (!previews.length) { void vscode.window.showInformationMessage('No team here was made from a built-in project type, so there is nothing to update.'); return; }
    const pick = await vscode.window.showQuickPick(previews.map((preview) => ({ label: preview.name, description: `${preview.plan.template.label} template ${preview.plan.template.fromVersion ? `v${preview.plan.template.fromVersion}` : '(no version recorded)'} → v${preview.plan.template.toVersion}${preview.plan.upToDate ? ' · up to date' : ''}`, detail: preview.file, file: preview.file })), { title: 'Update which team?' });
    if (!pick) return;
    file = pick.file;
  }
  const preview = await updater.preview(file);
  if (!preview) { void vscode.window.showInformationMessage(`${path.basename(file)} was not made from a built-in project type, so there is nothing to update.`); return; }
  const decisions = await decide(preview);
  if (!decisions) return;
  const counts = (action: string) => preview.plan.members.filter((member) => member.action === action).length;
  const guidanceLine = preview.guidance ? `\nAGENTS.md guidance: ${preview.guidance.action === 'auto' ? 'updated (unchanged since generated)' : preview.guidance.action === 'choice' ? (decisions.guidance === 'take' ? 'replaced, as you chose' : 'kept, as you chose') : 'already current'}.` : '';
  const confirm = await vscode.window.showInformationMessage(
    `Update "${preview.name}" to the ${preview.plan.template.label} template v${preview.plan.template.toVersion}?`,
    { modal: true, detail: `${describePlan(preview.plan)}\n\n${counts('auto')} replaced automatically, ${counts('choice')} by your choice, ${decisions.add?.length ?? 0} added; your own and removed members are kept.${guidanceLine}\n\nThe current file is backed up to the team's history first, so you can undo.` },
    'Update'
  );
  if (confirm !== 'Update') return;
  if (runInProgress()) { void vscode.window.showWarningMessage('A run started; the team was not changed. Try again when it ends.'); return; }
  try {
    const applied = await updater.apply(preview, decisions);
    const action = await vscode.window.showInformationMessage(`Updated "${preview.name}" to v${preview.plan.template.toVersion}. The previous version is in the team history.`, 'Undo', 'Open team file');
    if (action === 'Undo') { await updater.undo(applied); void vscode.window.showInformationMessage(`Restored "${preview.name}" as it was before the update.`); }
    if (action === 'Open team file') await vscode.window.showTextDocument(vscode.Uri.file(applied.file));
  } catch (error) {
    void vscode.window.showErrorMessage(`The team was not updated: ${(error as Error).message}`);
  }
}

/** One notice for the first out-of-date team that has not been told about this version and did not ask to be left alone. */
export async function offerTeamUpdates(library: TeamLibrary, notices: UpdateNotices): Promise<void> {
  if (!vscode.workspace.getConfiguration('nearAi').get<boolean>(UPDATE_NOTICE_SETTING, true)) return;
  if (runInProgress()) { whenIdle(() => { void offerTeamUpdates(library, notices); }); return; }
  const updater = new TeamUpdater(library);
  for (const file of await teamFiles(library)) {
    const preview = await updater.outdated(file);
    if (!preview || !notices.shouldOffer(file, preview.plan.template.toVersion)) continue;
    await notices.offered(file, preview.plan.template.toVersion);
    const from = preview.plan.template.fromVersion ? `v${preview.plan.template.fromVersion}` : 'an earlier version';
    void vscode.window.showInformationMessage(`Team update available for "${preview.name}" (${preview.plan.template.id} template ${from} → v${preview.plan.template.toVersion}).`, 'Review', 'Later', "Don't ask for this team").then(async (choice) => {
      if (choice === 'Review') await updateTeam(library, file);
      if (choice === "Don't ask for this team") await notices.dontAsk(file);
    });
    return;
  }
}

export function registerTeamUpdates(context: vscode.ExtensionContext, library: TeamLibrary): void {
  const notices = new UpdateNotices(context.globalState);
  context.subscriptions.push(vscode.commands.registerCommand(UPDATE_TEAM_COMMAND, (file?: unknown) => updateTeam(library, typeof file === 'string' ? file : undefined)));
  // Checked once when the extension starts, after the window settles; a run in progress defers it until the run ends.
  const timer = setTimeout(() => { void offerTeamUpdates(library, notices).catch(() => undefined); }, 5_000);
  context.subscriptions.push({ dispose: () => clearTimeout(timer) });
}
