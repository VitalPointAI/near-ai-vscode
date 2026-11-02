// Placeholder so the first failing tests compile; replaced by the real command handlers in the next commit.
import type * as vscode from 'vscode';

export const INVITE_COMMAND = 'nearAi.team.invite';
export const JOIN_COMMAND = 'nearAi.team.join';
export const MANAGE_MEMBERS_COMMAND = 'nearAi.team.manageMembers';
export const LINK_NEAR_COMMAND = 'nearAi.team.linkNearOrganization';
export const SIGN_OUT_NEAR_COMMAND = 'nearAi.team.signOutNear';

export function parseUsdToNanoUsd(_text: string): number | undefined {
  return undefined;
}

export interface MemberCommandDeps { context: vscode.ExtensionContext }

export function registerMemberCommands(_deps: MemberCommandDeps): vscode.Disposable[] {
  return [];
}
