// A test-only VS Code extension for the workbench end-to-end test (46-08): one secret saved and read through context.secrets, which
// Theia routes through CredentialsService to the rebound KeyStoreService. It is mounted read-only at run time and never enters the image.
const vscode = require('vscode');

/** The fixed value the test looks for in OpenBao, in the page and (never) in the logs. */
const PROBE_VALUE = 'secret-probe-value-7c41e9';

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('secretProbe.save', async () => {
      try {
        await context.secrets.store('probe', PROBE_VALUE);
        void vscode.window.showInformationMessage('Saved');
      } catch (error) {
        void vscode.window.showErrorMessage(`Not saved: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
    vscode.commands.registerCommand('secretProbe.read', async () => {
      try {
        const value = await context.secrets.get('probe');
        void vscode.window.showInformationMessage(`Read: ${value ?? 'none'}`);
      } catch (error) {
        void vscode.window.showErrorMessage(`Not read: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
