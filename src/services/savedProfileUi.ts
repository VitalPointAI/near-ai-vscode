import * as vscode from 'vscode';
import type { SavedProfileUi } from './profileIndex';

// The prompts of Use a saved profile (G-61-9): the pick of a profile set up in another project, the key check's progress and the closing message.
export function savedProfileUi(): SavedProfileUi {
  return {
    pick: (items, options) => Promise.resolve(vscode.window.showQuickPick(items, { ...options, matchOnDescription: true, ignoreFocusOut: true })),
    progress: (title, task) => Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task)),
    info: (message, ...actions) => Promise.resolve(vscode.window.showInformationMessage(message, ...actions)),
    error: (message, ...actions) => Promise.resolve(vscode.window.showErrorMessage(message, ...actions))
  };
}
