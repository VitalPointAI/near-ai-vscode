// Closing the last conversation in the Sterling workbench (port of Codex b42b5fb1). The chat lives in the workbench's right-hand drawer, whose rail
// button opens and closes it; closing the only conversation tab hides the drawer and keeps the conversation, so the next open shows it again. Any
// other host has no such command, and the tab closes as before.
import * as vscode from 'vscode';

/** The workbench's command that slides the chat drawer shut (workbench/extension/src/browser/sterling-welcome-module.ts); it returns true once hidden. */
export const CLOSE_CHAT_DRAWER_COMMAND = 'sterling.chat.closeDrawer';

/** True when `id` is the only open conversation and the workbench hid its drawer; then the conversation stays open. False everywhere else. */
export async function hideDrawerForLastConversation(openIds: readonly string[], id: string): Promise<boolean> {
  if (openIds.length !== 1 || openIds[0] !== id) return false;
  try {
    return await vscode.commands.executeCommand<boolean>(CLOSE_CHAT_DRAWER_COMMAND) === true;
  } catch {
    return false;
  }
}
