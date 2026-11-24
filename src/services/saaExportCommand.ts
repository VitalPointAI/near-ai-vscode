import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { redactSecrets } from '../domain/redaction';
import { createExclusive } from './stateHome';
import { buildSaaPackage } from './saaPackage';
import { loadSaaMarketplaceApproval, loadSaaOfficialPrivacyForms, loadSaaReleaseEvidence, SAA_RELEASE_VERSION } from './saaReleaseEvidence';

export const GENERATE_SAA_PACKAGE_COMMAND = 'nearAi.generateSaaPackage';
/** The Sterling workbench's command that sends a ZIP saved on the workbench's side to the person's browser (sterling-compliance-module.ts). */
export const DOWNLOAD_SAA_PACKAGE_COMMAND = 'sterling.compliance.downloadPackage';
const DOWNLOAD_ZIP = 'Download ZIP';

async function generateSaaPackage(context: vscode.ExtensionContext): Promise<void> {
  const installed: unknown = context.extension.packageJSON.version;
  const versionInput = await vscode.window.showInputBox({
    title: 'Generate a Security Assessment and Authorization package',
    prompt: 'Choose the public release to assess. The export uses published evidence and blank forms.',
    value: typeof installed === 'string' && SAA_RELEASE_VERSION.test(installed) ? installed : '',
    placeHolder: '0.4.36',
    validateInput: (value) => SAA_RELEASE_VERSION.test(value.trim().replace(/^v/, '')) ? undefined : 'Enter a release version like 0.4.36.'
  });
  if (!versionInput) return;

  const version = versionInput.trim().replace(/^v/, '');
  const suggested = `near-ai-sa-and-a-v${version}.zip`;
  const target = await vscode.window.showSaveDialog({
    title: 'Save the SA&A package',
    defaultUri: vscode.Uri.file(join(homedir(), suggested)),
    filters: { 'ZIP archive': ['zip'] }
  });
  if (!target) return;
  // VS Code sends a browser-selected file to a remote extension host as vscode-local.
  const clientFile = target.scheme === 'vscode-local';
  if (target.scheme !== 'file' && !clientFile) {
    void vscode.window.showErrorMessage('Choose a local file for the SA&A package.');
    return;
  }
  const chosenPath = clientFile ? target.path : target.fsPath;
  const destination = clientFile || chosenPath.toLowerCase().endsWith('.zip') ? chosenPath : `${chosenPath}.zip`;

  const abort = new AbortController();
  try {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Generating the SA&A package',
      cancellable: true
    }, async (progress, token) => {
      const cancelled = token.onCancellationRequested(() => abort.abort());
      try {
        if (token.isCancellationRequested) abort.abort();
        progress.report({ message: 'Downloading and verifying the public release evidence and official forms' });
        const [release, privacyForms] = await Promise.all([
          loadSaaReleaseEvidence(version, abort.signal).then(async (evidence) => {
            progress.report({ message: 'Checking the published release’s publication approval' });
            return { evidence, approval: await loadSaaMarketplaceApproval(evidence, abort.signal) };
          }),
          loadSaaOfficialPrivacyForms(abort.signal)
        ]);
        abort.signal.throwIfAborted();
        progress.report({ message: 'Building the control matrix and administrative forms' });
        const archive = await buildSaaPackage(release.evidence, context.asAbsolutePath('resources/saa'), privacyForms, release.approval);
        abort.signal.throwIfAborted();
        if (clientFile) {
          // The picker creates the file and authorizes this handle. Write through its provider without changing the URI.
          await vscode.workspace.fs.writeFile(target, archive);
        } else {
          const result = await createExclusive(destination, archive);
          if (result === 'exists') throw new Error('A file already exists at that location. Choose a different name.');
        }
      } finally {
        cancelled.dispose();
      }
    });
  } catch (error) {
    if (!abort.signal.aborted) {
      const message = error instanceof Error ? redactSecrets(error.message) : 'Try again.';
      void vscode.window.showErrorMessage(`Could not generate the SA&A package. ${message}`);
    }
    abort.abort();
    return;
  }

  const saved = `Saved ${basename(destination)}. The assessment and approval forms are ready for your organization to complete.`;
  // In the browser workbench the ZIP is saved where the workbench runs, out of the person's reach, so it offers to send it to their browser.
  if (clientFile || !(await vscode.commands.getCommands(true)).includes(DOWNLOAD_SAA_PACKAGE_COMMAND)) {
    void vscode.window.showInformationMessage(saved);
    return;
  }
  if (await vscode.window.showInformationMessage(saved, DOWNLOAD_ZIP) !== DOWNLOAD_ZIP) return;
  try {
    await vscode.commands.executeCommand(DOWNLOAD_SAA_PACKAGE_COMMAND, vscode.Uri.file(destination).toString());
  } catch {
    void vscode.window.showErrorMessage('Could not download the SA&A package. The ZIP is still saved in the workbench.');
  }
}

export function registerSaaExport(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand(GENERATE_SAA_PACKAGE_COMMAND, () => generateSaaPackage(context)));
}
