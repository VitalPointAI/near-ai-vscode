import * as vscode from 'vscode';
import { ActivityStore } from './activityStore';
import { formatRunReport, runPerformanceReport } from './runReport';
import { applyResearchProfile } from '../gsd/researchProfile';

/** PERF-07: "NEAR AI: Show Run Performance Report" opens the workspace's run breakdown as a Markdown document (nothing is written to the project). */
export function registerRunReport(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('nearAi.showRunReport', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { void vscode.window.showInformationMessage('Open a project folder to see its run performance report.'); return; }
    const sessions = await new ActivityStore(folder.uri.fsPath).list().catch(() => []);
    if (!sessions.length) { void vscode.window.showInformationMessage('This project has no agent runs recorded yet.'); return; }
    const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: formatRunReport(runPerformanceReport({ sessions }, folder.name)) });
    await vscode.window.showTextDocument(document, { preview: false });
  }));
  // PERF-06: "NEAR AI: Set Up Research Verifiers" applies the research GSD profile to an existing project and scaffolds its verifier scripts.
  context.subscriptions.push(vscode.commands.registerCommand('nearAi.setupResearchVerifiers', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { void vscode.window.showInformationMessage('Open a project folder first.'); return; }
    const result = await applyResearchProfile(folder.uri.fsPath);
    const files = result.scaffolded.length ? `Added ${result.scaffolded.join(', ')}.` : 'The verifier scripts were already there and were left unchanged.';
    void vscode.window.showInformationMessage(`Research profile applied: AGENTS.md has the profile${result.granularitySet ? ', phases are planned coarse' : ''}. ${files} Run node scripts/verify/verify-all.mjs to check the report.`);
  }));
}
