import { existsSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ActivityStore } from './activityStore';
import { shownSpendAccount } from './spendAccount';
import { nanoToUsd } from './spendLedger';
import { readDayBoundary } from './spendTracking';
import { buildUsageReport, customRange, usageCsv, usageJson, usageOrganizations, UsageProject, usageRange, UsageRange } from './usageReport';

// NEAR AI: Export Usage and Activity. Filters by organization, project, and dates, and saves a
// CSV or JSON of runs and models (no prompt content) where the user chooses, by default outside
// every workspace, with a warning before saving into a git work tree.

/** The git work tree containing `file` (its root), or undefined. */
export function gitWorkTreeOf(file: string, exists: (candidate: string) => boolean = existsSync): string | undefined {
  let directory = path.dirname(path.resolve(file));
  for (;;) {
    if (exists(path.join(directory, '.git'))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** Where the save dialog starts: Downloads (or home), never a workspace folder. */
export function defaultExportPath(fileName: string, home = os.homedir(), isDirectory: (candidate: string) => boolean = (candidate) => { try { return statSync(candidate).isDirectory(); } catch { return false; } }): string {
  const downloads = path.join(home, 'Downloads');
  return path.join(isDirectory(downloads) ? downloads : home, fileName);
}

/** Projects of this window with activity history. */
async function workspaceProjects(): Promise<UsageProject[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const projects = await Promise.all(folders.map(async (folder) => ({ root: folder.uri.fsPath, label: folder.name, sessions: await new ActivityStore(folder.uri.fsPath).list().catch(() => []) })));
  return projects.filter((project) => project.sessions.length > 0);
}

export async function exportUsageAndActivity(): Promise<void> {
  const projects = await workspaceProjects();
  const account = shownSpendAccount();
  if (!projects.length && !account) { void vscode.window.showInformationMessage('No NEAR AI usage or activity is recorded on this computer for this workspace yet.'); return; }
  const organizations = usageOrganizations(projects);
  const organization = await vscode.window.showQuickPick([
    { label: 'All organizations', description: 'Everything this computer recorded', id: undefined as string | undefined },
    ...organizations.map((entry) => ({ label: entry.label, description: entry.id, id: entry.id as string | undefined }))
  ], { title: 'Export usage and activity (1/4): organization', placeHolder: 'Which organization profile?' });
  if (!organization) return;
  const project = await vscode.window.showQuickPick([
    { label: 'All projects', description: projects.length ? `${projects.length} with activity in this window, and spend not tied to one` : 'Spend recorded for this API key', root: undefined as string | undefined },
    ...projects.map((entry) => ({ label: entry.label, description: `${entry.sessions.length} run${entry.sessions.length === 1 ? '' : 's'} recorded`, root: entry.root as string | undefined }))
  ], { title: 'Export usage and activity (2/4): project' });
  if (!project) return;
  const rangeChoice = await vscode.window.showQuickPick([
    { label: 'Today', range: 'today' as UsageRange | 'custom' },
    { label: 'Last 7 days', range: 'week' as UsageRange | 'custom' },
    { label: 'Last 30 days', range: 'month' as UsageRange | 'custom' },
    { label: 'Custom dates…', range: 'custom' as UsageRange | 'custom' }
  ], { title: 'Export usage and activity (3/4): dates', placeHolder: `Days follow nearAi.spend.dayBoundary (${readDayBoundary()})` });
  if (!rangeChoice) return;
  const boundary = readDayBoundary();
  let range: { since: number; until: number } | undefined;
  if (rangeChoice.range === 'custom') {
    const date = /^\d{4}-\d{2}-\d{2}$/;
    const from = await vscode.window.showInputBox({ title: 'From (inclusive)', placeHolder: 'YYYY-MM-DD', validateInput: (value) => date.test(value.trim()) ? undefined : 'A date like 2026-10-01.' });
    if (!from) return;
    const to = await vscode.window.showInputBox({ title: 'To (inclusive)', placeHolder: 'YYYY-MM-DD', value: new Date().toISOString().slice(0, 10), validateInput: (value) => customRange(from, value, boundary) ? undefined : 'A date like 2026-10-28, on or after the start.' });
    if (!to) return;
    range = customRange(from, to, boundary);
  } else range = usageRange(rangeChoice.range, Date.now(), boundary);
  if (!range) return;
  const format = await vscode.window.showQuickPick([{ label: 'CSV', description: 'One row per run and per model, for spreadsheets', id: 'csv' as const }, { label: 'JSON', id: 'json' as const }], { title: 'Export usage and activity (4/4): format' });
  if (!format) return;
  await account?.ledger.refresh().catch(() => undefined);
  const near = rangeChoice.range === 'today' ? account?.usage.today() : undefined;
  const report = buildUsageReport({
    projects, entries: account?.ledger.list({ since: range.since, until: range.until }) ?? [],
    filter: { since: range.since, until: range.until, ...(organization.id ? { organizationProfileId: organization.id } : {}), ...(project.root ? { projectRoot: project.root } : {}) },
    organizationLabel: organization.id ? organization.label : 'All organizations (this computer)', projectLabel: project.label,
    ...(near ? { nearTodayUsd: nanoToUsd(near.nanoUsd) } : {})
  });
  const stamp = new Date().toISOString().slice(0, 10);
  let suggested = defaultExportPath(`near-ai-usage-${stamp}.${format.id}`);
  for (;;) {
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(suggested), filters: format.id === 'csv' ? { CSV: ['csv'] } : { JSON: ['json'] }, title: 'Save usage and activity' });
    if (!target) return;
    const repository = gitWorkTreeOf(target.fsPath);
    if (repository) {
      const choice = await vscode.window.showWarningMessage(`${target.fsPath} is inside a git work tree (${repository}). The export names your projects, models, runs, and costs; saved there it could be committed. Save it there anyway?`, { modal: true }, 'Save here', 'Choose another place');
      if (choice === 'Choose another place') { suggested = defaultExportPath(path.basename(target.fsPath)); continue; }
      if (choice !== 'Save here') return;
    }
    await writeFile(target.fsPath, format.id === 'csv' ? usageCsv(report) : usageJson(report), 'utf8');
    void vscode.window.showInformationMessage(`Exported ${report.runs.length} run${report.runs.length === 1 ? '' : 's'} and ${report.models.length} model${report.models.length === 1 ? '' : 's'} (${report.totals.costText}) to ${target.fsPath}.`);
    return;
  }
}

export function registerUsageExport(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('nearAi.exportAnalytics', () => exportUsageAndActivity()));
}
