import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { matchingFacts, projectMemoryScope } from '../agent/extraTools';
import { applyProjectType, PROJECT_TYPES, projectTypeTeam } from '../agent/projectTypes';
import { parseTeam, TeamLibrary } from '../agent/teams';
import type { MemoryScope } from '../domain/contextGraph';
import { ContextGraphMemory } from './contextGraphMemory';
import { MemoryApprovalRegistry } from './memoryApproval';

// Native VS Code flows for teams and memory: quick picks, input boxes, and the editor itself.

export function registerWorkspaceCommands(context: vscode.ExtensionContext, runTeam: (slug: string) => Promise<void>): void {
  const library = new TeamLibrary(context.globalStorageUri.fsPath);
  context.subscriptions.push(
    vscode.commands.registerCommand('nearAi.manageTeams', () => manageTeams(library, runTeam)),
    vscode.commands.registerCommand('nearAi.setupProjectTeam', () => setupProjectTeam(library)),
    vscode.commands.registerCommand('nearAi.manageMemory', () => manageMemory()),
    // Saving a team file checks it and records a version.
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      const file = document.uri.fsPath;
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const isLibrary = path.dirname(file) === library.directory;
      const isProject = root !== undefined && file === TeamLibrary.projectTeamFile(root);
      if (!file.endsWith('.md') || (!isLibrary && !isProject)) return;
      try {
        const team = parseTeam(document.getText(), file);
        const version = await library.snapshot(file);
        void vscode.window.setStatusBarMessage(`Team "${team.name}" saved as version ${version} (${team.members.length} members).`, 5000);
      } catch (error) {
        void vscode.window.showErrorMessage(`This team file can't be used yet: ${(error as Error).message}`);
      }
    })
  );
}

async function manageTeams(library: TeamLibrary, runTeam: (slug: string) => Promise<void>): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const teams = await library.list(root);
  const archived = await library.archived();
  const picked = await vscode.window.showQuickPick([
    { label: '$(add) New team…', action: 'new' as const },
    { label: '$(cloud-download) Import a team file…', action: 'import' as const },
    ...(archived.length ? [{ label: `$(archive) Restore an archived team (${archived.length})…`, action: 'restore' as const }] : []),
    ...teams.map((entry) => ({ label: `${entry.project ? '$(folder) ' : '$(organization) '}${entry.team?.name ?? path.basename(entry.file, '.md')}`, description: entry.error ? `needs fixing: ${entry.error}` : `${entry.team!.members.length} members${entry.project ? ' · this project' : ''}`, detail: entry.team?.description, action: 'team' as const, entry }))
  ], { title: 'NEAR AI teams', placeHolder: 'Pick a team or create one' });
  if (!picked) return;
  if (picked.action === 'new') {
    const name = await vscode.window.showInputBox({ title: 'New team', prompt: 'Team name', validateInput: (value) => value.trim() ? undefined : 'Enter a name.' });
    if (name) await open(await library.create(name.trim()));
    return;
  }
  if (picked.action === 'import') {
    const [file] = await vscode.window.showOpenDialog({ filters: { 'Team file': ['md'] }, title: 'Import a NEAR AI team file' }) ?? [];
    if (!file) return;
    try { await open(await library.import(file.fsPath)); } catch (error) { void vscode.window.showErrorMessage(`That file isn't a usable team: ${(error as Error).message}`); }
    return;
  }
  if (picked.action === 'restore') {
    const choice = await vscode.window.showQuickPick(archived.map((file) => ({ label: path.basename(file, '.md'), file })), { title: 'Restore a team' });
    if (choice) { try { await open(await library.restore(choice.file)); } catch (error) { void vscode.window.showErrorMessage((error as Error).message); } }
    return;
  }
  const entry = picked.entry!;
  const name = entry.team?.name ?? path.basename(entry.file, '.md');
  const action = await vscode.window.showQuickPick([
    ...(entry.team ? [{ label: '$(play) Run with a task…', id: 'run' }] : []),
    { label: '$(edit) Edit', id: 'edit' },
    ...(entry.project ? [] : [{ label: '$(copy) Duplicate…', id: 'duplicate' }, { label: '$(history) Versions…', id: 'versions' }, { label: '$(export) Export…', id: 'export' }, { label: '$(archive) Archive', id: 'archive' }, { label: '$(trash) Delete…', id: 'delete' }])
  ], { title: name });
  if (!action) return;
  if (action.id === 'run' && entry.team) await runTeam(entry.project ? 'project' : entry.team.slug);
  else if (action.id === 'edit') await open(entry.file);
  else if (action.id === 'duplicate') {
    const copy = await vscode.window.showInputBox({ title: 'Duplicate team', prompt: 'Name for the copy', value: `${name} copy` });
    if (copy) await open(await library.duplicate(entry.file, copy.trim()));
  } else if (action.id === 'versions') {
    const versions = await library.versions(entry.file);
    const version = await vscode.window.showQuickPick(versions.map((file) => ({ label: path.basename(file, '.md').replace(/T(\d\d)-(\d\d)-(\d\d)-\d+Z$/, ' $1:$2:$3'), file })), { title: `${name}: versions (newest first)`, placeHolder: 'Open a version to compare or copy from it' });
    if (version) await open(version.file);
  } else if (action.id === 'export') {
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(root ?? '', `${path.basename(entry.file)}`)), filters: { 'Team file': ['md'] } });
    if (target) await vscode.workspace.fs.copy(vscode.Uri.file(entry.file), target, { overwrite: true });
  } else if (action.id === 'archive') {
    await library.archive(entry.file);
    void vscode.window.showInformationMessage(`Archived "${name}". Restore it from NEAR AI: Manage Teams.`);
  } else if (action.id === 'delete') {
    const confirm = await vscode.window.showWarningMessage(`Delete "${name}" and its version history? This can't be undone.`, { modal: true }, 'Delete');
    if (confirm === 'Delete') await library.delete(entry.file);
  }
}

/** ONB-04: a few questions, then a recommended team the user reviews and edits before using it. */
async function setupProjectTeam(library: TeamLibrary): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) { void vscode.window.showWarningMessage('Open a project folder first.'); return; }
  const type = await vscode.window.showQuickPick(PROJECT_TYPES.map((entry) => ({ label: entry.label, description: entry.description, detail: `Team: ${entry.members.map((member) => member.name).join(', ')}`, entry })), { title: 'Set up project (1/3): what kind of project is this?', placeHolder: 'Every type follows the same plan, execute, verify, audit, and release cycle', ignoreFocusOut: true });
  if (!type) return;
  const goal = await vscode.window.showInputBox({ title: 'Set up project (2/3)', prompt: 'What should the team help you achieve?', ignoreFocusOut: true, validateInput: (value) => value.trim() ? undefined : 'Describe the goal.' });
  if (!goal) return;
  const locality = await pick('Set up project (3/3)', 'Where may models run?', [['cloud', 'NEAR AI Cloud'], ['local', 'Local runtime only'], ['hybrid', 'Both']]);
  if (!locality) return;
  const file = TeamLibrary.projectTeamFile(root);
  await mkdir(path.dirname(file), { recursive: true });
  if (existsSync(file)) {
    const replace = await vscode.window.showWarningMessage('This project already has a team. Replace it? Its earlier versions stay in the team history.', { modal: true }, 'Replace');
    if (replace !== 'Replace') return;
  }
  await writeFile(file, projectTypeTeam(type.entry, goal.trim().slice(0, 400), locality as 'cloud' | 'local' | 'hybrid'), 'utf8');
  await library.snapshot(file);
  await applyProjectType(root, type.entry, goal.trim().slice(0, 400));
  await open(file);
  void vscode.window.showInformationMessage(`Set up a ${type.entry.label.toLowerCase()} project: the team is open to edit, and AGENTS.md now tells every agent how this kind of work goes through plan, execute, verify, audit, and release. Run the team with /team:project <task>, or a GSD workflow such as /gsd-new-project.`);
}

async function pick(title: string, placeHolder: string, options: Array<[string, string]>): Promise<string | undefined> {
  return (await vscode.window.showQuickPick(options.map(([id, label]) => ({ label, id })), { title, placeHolder, ignoreFocusOut: true }))?.id;
}

/** MEM-04: inspect, search, correct, retract, export, and reset project memory; changes go through the memory approval flow. */
async function manageMemory(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) { void vscode.window.showWarningMessage('Open a project folder first.'); return; }
  const memory = new ContextGraphMemory(root);
  const approvals = new MemoryApprovalRegistry();
  const scope = projectMemoryScope(root);
  const query = await vscode.window.showInputBox({ title: 'Project memory', prompt: 'Search facts (leave empty to list everything)', ignoreFocusOut: true });
  if (query === undefined) return;
  const graph = await memory.inspect(scope, { localOnly: true }).catch(() => undefined);
  const facts = query.trim() ? await matchingFacts(memory, scope, query.trim()).catch(() => []) : (graph?.nodes ?? []);
  const active = facts.filter((node) => node.state === 'active');
  const choice = await vscode.window.showQuickPick([
    ...active.map((node) => ({ label: node.label, description: `confidence ${node.confidence}${node.conflict?.status === 'conflicted' ? ' · conflicts with another fact' : ''}`, detail: node.summary, node })),
    ...(graph ? [{ label: '$(export) Export project memory…', action: 'export' as const }, { label: '$(trash) Reset project memory…', action: 'reset' as const }] : [])
  ], { title: `Project memory: ${active.length} fact${active.length === 1 ? '' : 's'}`, placeHolder: active.length ? 'Pick a fact to correct or retract' : 'No facts yet. The agent saves facts with its Remember tool.', matchOnDetail: true });
  if (!choice || !graph) return;
  const approve = (operation: 'correct' | 'retract' | 'reset' | 'export', nodeIds: string[], summary?: string) => {
    const descriptor = { operation, scope, expectedGraphVersion: graph.graphVersion, nodeIds, sourceNodeIds: [], ...(summary ? { summary } : {}), localOnly: true, providerBoundary: 'local' as const, sessionId: 'session-memory-command', projectId: scope.id };
    return approvals.consume(approvals.create(descriptor).approvalFingerprint, descriptor);
  };
  try {
    if ('action' in choice && choice.action === 'export') {
      const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(root, 'near-ai-memory.json')), filters: { JSON: ['json'] } });
      if (target) await writeFile(target.fsPath, await memory.export(scope, { expectedGraphVersion: graph.graphVersion, approval: approve('export', []) }), 'utf8');
    } else if ('action' in choice && choice.action === 'reset') {
      if ((await vscode.window.showWarningMessage('Delete every fact in this project\'s memory?', { modal: true }, 'Reset')) === 'Reset') await memory.reset(scope, graph.graphVersion, approve('reset', []));
    } else if ('node' in choice && choice.node) {
      const node = choice.node;
      const action = await vscode.window.showQuickPick([{ label: '$(edit) Correct…', id: 'correct' }, { label: '$(close) Retract', id: 'retract' }], { title: node.label });
      if (action?.id === 'retract') await memory.retract(scope, node.nodeId, graph.graphVersion, approve('retract', [node.nodeId]));
      if (action?.id === 'correct') {
        const summary = await vscode.window.showInputBox({ title: `Correct: ${node.label}`, value: node.summary, ignoreFocusOut: true });
        if (summary && summary.trim() !== node.summary) {
          const now = new Date().toISOString();
          await memory.correct({ scope, nodeId: node.nodeId, expectedGraphVersion: graph.graphVersion, summary: summary.trim(), authoringActorId: 'user', provenance: { kind: 'user', sourceId: 'memory-command', sourceHash: createHash('sha256').update(summary).digest('hex'), capturedAt: now, evidenceClass: 'user-assertion', actorId: 'user' } }, approve('correct', [node.nodeId], summary.trim()));
        }
      }
    }
  } catch (error) {
    void vscode.window.showErrorMessage(`Memory change failed: ${(error as Error).message}`);
  }
}

async function open(file: string): Promise<void> {
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
}
