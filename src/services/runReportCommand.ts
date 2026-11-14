import * as vscode from 'vscode';
import { ActivityStore } from './activityStore';
import { formatRunReport, runPerformanceReport } from './runReport';
import { projectSpendSection } from './spendMirror';

/** PERF-07: "NEAR AI: Show Run Performance Report" opens the workspace's run breakdown as a Markdown document (nothing is written to the project). */
export function registerRunReport(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('nearAi.showRunReport', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { void vscode.window.showInformationMessage('Open a project folder to see its run performance report.'); return; }
    const sessions = await new ActivityStore(folder.uri.fsPath).list().catch(() => []);
    if (!sessions.length) { void vscode.window.showInformationMessage('This project has no agent runs recorded yet.'); return; }
    const spend = await projectSpendSection(folder.uri.fsPath);
    const report = formatRunReport(runPerformanceReport({ sessions }, folder.name));
    const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: spend ? `${report.trimEnd()}\n\n${spend}\n` : report });
    await vscode.window.showTextDocument(document, { preview: false });
  }));
}
