// The one prompts module of Team Mode: every input box, pick and message of the Team Mode commands goes through here to VS Code.
// Only under the extension-host tests (NEAR_AI_E2E exactly '1', the same gate as the board's page probe, IN-05) and only while a test script is
// set does a scripted step answer instead, and every prompt is recorded with what was shown (T-61-79). Production never sets the variable, so
// the script is never read. This module imports only vscode, so a solo activation can load it without pulling in any team module.
import * as vscode from 'vscode';

export interface PromptRecord {
  kind: 'input' | 'pick' | 'message';
  level?: 'info' | 'warn' | 'error';
  text: string;
  detail?: string;
  modal: boolean;
  choices: string[];
  /** The scripted answer; for a password input always the fixed text 'hidden'. */
  answer?: string;
  /** A modal, input or pick that no step answered, or whose scripted answer was refused. */
  unanswered?: boolean;
}

/** match: a substring of the title, prompt, placeholder, message text or of one offered choice. answer: input text, item label substring or button label. */
export interface PromptStep { match: string; answer: string | undefined }

export const promptTap: { script?: PromptStep[]; shown: PromptRecord[] } = { shown: [] };

type Level = 'info' | 'warn' | 'error';
const HIDDEN_ANSWER = 'hidden';

// The script, only under the extension-host tests.
function activeScript(): PromptStep[] | undefined {
  return process.env.NEAR_AI_E2E === '1' && Array.isArray(promptTap.script) ? promptTap.script : undefined;
}

// The first unused step whose match is in one of the texts; it is used up.
function takeStep(script: PromptStep[], texts: ReadonlyArray<string | undefined>): PromptStep | undefined {
  const index = script.findIndex((step) => step.match !== '' && texts.some((text) => text !== undefined && text.includes(step.match)));
  if (index < 0) return undefined;
  const [step] = script.splice(index, 1);
  return step;
}

function record(entry: PromptRecord): void {
  promptTap.shown.push(entry);
}

async function refused(options: vscode.InputBoxOptions, value: string): Promise<boolean> {
  if (options.validateInput === undefined) return false;
  const verdict = await options.validateInput(value);
  if (verdict === undefined || verdict === null) return false;
  return typeof verdict === 'string' ? verdict !== '' : true;
}

async function scriptedInput(script: PromptStep[], options: vscode.InputBoxOptions): Promise<string | undefined> {
  const text = options.prompt ?? options.placeHolder ?? options.title ?? '';
  const base: PromptRecord = { kind: 'input', text, ...(options.prompt !== undefined && options.placeHolder !== undefined ? { detail: options.placeHolder } : {}), modal: false, choices: [] };
  const step = takeStep(script, [options.title, options.prompt, options.placeHolder]);
  if (step === undefined) {
    record({ ...base, unanswered: true });
    return undefined;
  }
  if (step.answer === undefined) {
    record(base);
    return undefined;
  }
  const shownAnswer = options.password === true ? HIDDEN_ANSWER : step.answer;
  if (await refused(options, step.answer)) {
    record({ ...base, answer: shownAnswer, unanswered: true });
    return undefined;
  }
  record({ ...base, answer: shownAnswer });
  return step.answer;
}

function scriptedPick<T extends vscode.QuickPickItem>(script: PromptStep[], items: T[], options: vscode.QuickPickOptions): T | undefined {
  const choices = items.map((item) => item.label);
  const text = options.title ?? options.placeHolder ?? '';
  const base: PromptRecord = { kind: 'pick', text, ...(options.title !== undefined && options.placeHolder !== undefined ? { detail: options.placeHolder } : {}), modal: false, choices };
  const step = takeStep(script, [options.title, options.placeHolder, ...choices]);
  if (step === undefined) {
    record({ ...base, unanswered: true });
    return undefined;
  }
  if (step.answer === undefined) {
    record(base);
    return undefined;
  }
  const answer = step.answer;
  const chosen = items.find((item) => item.label.includes(answer));
  record({ ...base, answer, ...(chosen === undefined ? { unanswered: true } : {}) });
  return chosen;
}

function scriptedMessage(script: PromptStep[], level: Level, text: string, options: vscode.MessageOptions | undefined, actions: string[]): string | undefined {
  const modal = options?.modal === true;
  const base: PromptRecord = { kind: 'message', level, text, ...(options?.detail === undefined ? {} : { detail: options.detail }), modal, choices: [...actions] };
  const step = takeStep(script, [text, ...actions]);
  if (step === undefined) {
    // A plain message needs no answer; a modal waits for one, so a missing step is worth reporting.
    record(modal ? { ...base, unanswered: true } : base);
    return undefined;
  }
  if (step.answer === undefined) {
    record(base);
    return undefined;
  }
  const button = actions.includes(step.answer) ? step.answer : undefined;
  record({ ...base, answer: step.answer, ...(button === undefined ? { unanswered: true } : {}) });
  return button;
}

export const teamPrompts = {
  input(options: vscode.InputBoxOptions): Thenable<string | undefined> {
    const script = activeScript();
    if (script === undefined) return vscode.window.showInputBox(options);
    return scriptedInput(script, options);
  },
  pick<T extends vscode.QuickPickItem>(items: T[], options: vscode.QuickPickOptions): Thenable<T | undefined> {
    const script = activeScript();
    if (script === undefined) return vscode.window.showQuickPick(items, options);
    return Promise.resolve(scriptedPick(script, items, options));
  },
  message(level: Level, text: string, options: vscode.MessageOptions | undefined, ...actions: string[]): Thenable<string | undefined> {
    const script = activeScript();
    if (script !== undefined) return Promise.resolve(scriptedMessage(script, level, text, options, actions));
    // No options object is passed when there is none, exactly as the callers used to call VS Code.
    if (options === undefined) {
      return level === 'info' ? vscode.window.showInformationMessage(text, ...actions)
        : level === 'warn' ? vscode.window.showWarningMessage(text, ...actions)
          : vscode.window.showErrorMessage(text, ...actions);
    }
    return level === 'info' ? vscode.window.showInformationMessage(text, options, ...actions)
      : level === 'warn' ? vscode.window.showWarningMessage(text, options, ...actions)
        : vscode.window.showErrorMessage(text, options, ...actions);
  }
};
