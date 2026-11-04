import * as vscode from 'vscode';
import type { SavedProfileUi } from './profileIndex';
import { teamPrompts } from './team/teamPrompts';

// The prompts of Use a saved profile (G-61-9): the pick of a profile set up in another project, the key check's progress and the closing message.
// Join Team runs Use a saved profile right after joining a team without an organization (61-30), so its pick and messages go through the same
// prompts module as the join (61-31). That module only reaches VS Code: outside the extension-host tests these are VS Code's own pick and messages,
// with the same options as before, and teamPrompts imports nothing but vscode, so a solo activation loads no team module through here.
export function savedProfileUi(): SavedProfileUi {
  return {
    pick: (items, options) => Promise.resolve(teamPrompts.pick(items, { ...options, matchOnDescription: true, ignoreFocusOut: true })),
    progress: (title, task) => Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task)),
    info: (message, ...actions) => Promise.resolve(teamPrompts.message('info', message, undefined, ...actions)),
    error: (message, ...actions) => Promise.resolve(teamPrompts.message('error', message, undefined, ...actions))
  };
}
