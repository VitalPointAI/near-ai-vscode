import * as vscode from 'vscode';
import { applyResearchProfile } from '../gsd/researchProfile';
import { changedVerifiers, trustVerifiers } from '../gsd/verifierScaffold';

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
  // Review of PR 34: an edited scaffolded verifier asks before it runs unattended until a person trusts the new version here. Nothing is recorded
  // without the modal confirmation, and agents cannot reach this command.
  context.subscriptions.push(vscode.commands.registerCommand('nearAi.trustResearchVerifiers', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { void vscode.window.showInformationMessage('Open a project folder first.'); return; }
    const changed = await changedVerifiers(folder.uri.fsPath);
    if (!changed.length) { void vscode.window.showInformationMessage('Every research verifier matches its recorded version; there is nothing to trust.'); return; }
    const trust = 'Trust these versions';
    const choice = await vscode.window.showWarningMessage(`These research verifiers changed since they were scaffolded: ${changed.join(', ')}. Agents ask before running them until you trust the new versions. Review the changes first: a trusted verifier runs without asking.`, { modal: true }, trust);
    if (choice !== trust) return;
    const recorded = await trustVerifiers(folder.uri.fsPath, changed);
    void vscode.window.showInformationMessage(`Trusted ${recorded.length} research verifier${recorded.length === 1 ? '' : 's'}: ${recorded.join(', ')}.`);
  }));
}
