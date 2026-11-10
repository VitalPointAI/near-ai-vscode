import * as vscode from 'vscode';
import { applyResearchProfile } from '../gsd/researchProfile';

/** PERF-06: registers the research profile's command on its own, beside the profile, independent of the run report. */
export function registerResearchVerifiers(context: vscode.ExtensionContext): void {
  // PERF-06: "NEAR AI: Set Up Research Verifiers" applies the research GSD profile to an existing project and scaffolds its verifier scripts.
  context.subscriptions.push(vscode.commands.registerCommand('nearAi.setupResearchVerifiers', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { void vscode.window.showInformationMessage('Open a project folder first.'); return; }
    const result = await applyResearchProfile(folder.uri.fsPath);
    const files = result.scaffolded.length ? `Added ${result.scaffolded.join(', ')}.` : 'The verifier scripts were already there and were left unchanged.';
    void vscode.window.showInformationMessage(`Research profile applied: AGENTS.md has the profile${result.granularitySet ? ', phases are planned coarse' : ''}. ${files} Run node scripts/verify/verify-all.mjs to check the report.`);
  }));
}
