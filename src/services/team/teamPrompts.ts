// The one prompts module of Team Mode. Imports only vscode.
import * as vscode from 'vscode';

export interface PromptRecord { kind: 'input' | 'pick' | 'message'; level?: 'info' | 'warn' | 'error'; text: string; detail?: string; modal: boolean; choices: string[]; answer?: string; unanswered?: boolean }
export interface PromptStep { match: string; answer: string | undefined }

export const promptTap: { script?: PromptStep[]; shown: PromptRecord[] } = { shown: [] };

export const teamPrompts = {
  input(options: vscode.InputBoxOptions): Thenable<string | undefined> {
    return vscode.window.showInputBox(options);
  },
  pick<T extends vscode.QuickPickItem>(items: T[], options: vscode.QuickPickOptions): Thenable<T | undefined> {
    return vscode.window.showQuickPick(items, options);
  },
  message(level: 'info' | 'warn' | 'error', text: string, options: vscode.MessageOptions | undefined, ...actions: string[]): Thenable<string | undefined> {
    const show = level === 'info' ? vscode.window.showInformationMessage : level === 'warn' ? vscode.window.showWarningMessage : vscode.window.showErrorMessage;
    return options === undefined ? show(text, ...actions) : show(text, options, ...actions);
  }
};
