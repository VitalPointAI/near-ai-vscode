// Share Team Setup (G-61-3, D-03 and D-20 as amended 2026-11-03): the experience around projectHome's share. The person is asked once, in the
// same flow, and only the team setup is shared (planShare, then shareTeamSetup with the plan they agreed to). Every result is a fixed plain
// sentence from SHARE_TEXT; the technical reason, already redacted by projectHome, goes to the NEAR AI Team channel. Used by the Share Team
// Setup command and Enable's Share with my team, and next by Invite and Link. Loaded only by dynamic import, inside a handler.
import * as vscode from 'vscode';
import type { TeamFile } from '../../domain/team/types';
import type { OnlineHome, SharePlan } from '../../team/projectHome';
import type { GitRunner } from '../../team/runGit';
import { LOCAL_ONLY_DETAIL, LOCAL_ONLY_TEXT, NOT_SHAREABLE_DETAIL, NOT_SHAREABLE_TEXT, SHOW_DETAILS_ACTION, TRY_AGAIN_ACTION } from './teamCommands';
import { teamPrompts } from './teamPrompts';

export type ShareReason = 'command' | 'enable' | 'invite' | 'link';
export type ShareOutcome = 'shared' | 'already' | 'declined' | 'not-reachable' | 'failed';
export interface ShareDeps { output: { appendLine(line: string): void; show?(preserveFocus?: boolean): void }; announce(level: 'info' | 'warn' | 'error', message: string): void }

// Every sentence and button label of the share experience. Plain words only; the technical reason goes to the NEAR AI Team channel.
export const SHARE_TEXT = Object.freeze({
  question: 'Share your team setup so teammates can join?',
  inviteQuestion: 'Before you invite anyone, your team setup must be online so the invite can find the team. Share it now?',
  linkQuestion: 'Share your team setup so teammates see the organization link?',
  onlySetup: 'Only the team setup is shared. Nothing else in your project changes.',
  firstUpload: 'This puts your project online for the first time, with the team setup in it.',
  share: 'Share',
  shareAndContinue: 'Share and continue',
  checking: 'Checking your team setup online',
  progress: 'Sharing your team setup',
  shared: 'Your team setup is online. Teammates can now join.',
  already: 'Your team setup is already online, so teammates can join.',
  declined: 'Nothing was shared.',
  rejected: 'The online home of your project did not accept the team setup. It may only accept changes through a review. Choose Show details for more.',
  offline: 'Your team setup could not be shared because the online home of your project could not be reached. Check your internet connection, then choose Try again. Nothing was lost.',
  changed: 'Your team setup could not be shared because the project changed online at the same moment. Choose Try again.',
  recordMissing: 'Your team setup could not be shared because the team record is not online yet. Choose Show details for more.',
  notHere: 'Your team setup could not be shared from this computer. Choose Show details for more.'
} as const);

export interface ShareFlowInput { projectRoot: string; teamFile: TeamFile; branch: string; reason: ShareReason; git?: GitRunner }

type Consent = 'none' | 'setup' | 'first-upload';

function question(reason: ShareReason): string {
  if (reason === 'invite') return SHARE_TEXT.inviteQuestion;
  return reason === 'link' ? SHARE_TEXT.linkQuestion : SHARE_TEXT.question;
}

// Opens the NEAR AI Team channel when the person chose Show details.
async function offerDetails(deps: ShareDeps, level: 'warn' | 'error', message: string): Promise<void> {
  if (await teamPrompts.message(level, message, undefined, SHOW_DETAILS_ACTION) === SHOW_DETAILS_ACTION) deps.output.show?.(true);
}

// True when the person chose Try again.
async function offerRetry(deps: ShareDeps, message: string): Promise<boolean> {
  const choice = await teamPrompts.message('error', message, undefined, TRY_AGAIN_ACTION, SHOW_DETAILS_ACTION);
  if (choice === SHOW_DETAILS_ACTION) deps.output.show?.(true);
  return choice === TRY_AGAIN_ACTION;
}

// Teammates cannot reach the online home: the same plain words as Enable's warning, with what to do.
async function notReachable(deps: ShareDeps, home: OnlineHome | undefined): Promise<void> {
  const local = home === undefined || home.kind !== 'not-shareable';
  const choice = await teamPrompts.message('warn', local ? LOCAL_ONLY_TEXT : NOT_SHAREABLE_TEXT, { modal: true, detail: local ? LOCAL_ONLY_DETAIL : NOT_SHAREABLE_DETAIL }, SHOW_DETAILS_ACTION);
  if (choice === SHOW_DETAILS_ACTION) deps.output.show?.(true);
}

// The one confirmation. A first upload sends the whole project for the first time, so the question says so.
async function confirm(reason: ShareReason, firstUpload: boolean): Promise<boolean> {
  const button = reason === 'invite' ? SHARE_TEXT.shareAndContinue : SHARE_TEXT.share;
  const detail = firstUpload ? `${SHARE_TEXT.firstUpload} ${SHARE_TEXT.onlySetup}` : SHARE_TEXT.onlySetup;
  return await teamPrompts.message('info', question(reason), { modal: true, detail }, button) === button;
}

function needsConsent(plan: SharePlan, consent: Consent): boolean {
  if (plan.kind === 'first-upload') return consent !== 'first-upload';
  return consent === 'none';
}

/**
 * Makes sure the team setup is on the integration branch of the online home. Nothing is shared without the person's confirmation in this
 * flow; a later plan that would upload the whole project for the first time is asked again. Try again re-plans once per click.
 */
export async function ensureTeamSetupShared(deps: ShareDeps, input: ShareFlowInput): Promise<ShareOutcome> {
  const { planShare, shareTeamSetup } = await import('../../team/projectHome');
  const shareInput = { projectRoot: input.projectRoot, teamFile: input.teamFile, branch: input.branch, ...(input.git === undefined ? {} : { git: input.git }) };
  const speaks = input.reason === 'command' || input.reason === 'enable';
  let consent: Consent = 'none';
  for (;;) {
    const plan = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: SHARE_TEXT.checking }, () => planShare(shareInput));
    if (plan.kind === 'already') {
      deps.output.appendLine(`The team setup is already on ${input.branch} at ${input.teamFile.coordination.remote}.`);
      if (speaks) deps.announce('info', SHARE_TEXT.already);
      return 'already';
    }
    if (plan.kind === 'blocked') {
      deps.output.appendLine(`Share Team Setup stopped before sharing (${plan.reason}): ${plan.detail}`);
      if (plan.reason === 'not-reachable-by-teammates') {
        await notReachable(deps, plan.home);
        return 'not-reachable';
      }
      if (plan.reason === 'offline') {
        if (await offerRetry(deps, SHARE_TEXT.offline)) continue;
        return 'failed';
      }
      await offerDetails(deps, 'error', plan.reason === 'record-missing' ? SHARE_TEXT.recordMissing : SHARE_TEXT.notHere);
      return 'failed';
    }
    if (needsConsent(plan, consent)) {
      if (!(await confirm(input.reason, plan.kind === 'first-upload'))) {
        deps.output.appendLine('Share Team Setup was declined, so nothing was pushed.');
        deps.announce('info', SHARE_TEXT.declined);
        return 'declined';
      }
      consent = plan.kind === 'first-upload' ? 'first-upload' : 'setup';
    }
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: SHARE_TEXT.progress }, () => shareTeamSetup({ ...shareInput, plan }));
    if (result.ok) {
      deps.output.appendLine(`Shared the team setup to ${input.branch} at ${input.teamFile.coordination.remote} (${result.how}).`);
      deps.announce('info', SHARE_TEXT.shared);
      return 'shared';
    }
    deps.output.appendLine(`Sharing the team setup to ${input.branch} did not finish (${result.code}): ${result.detail}`);
    switch (result.code) {
      case 'not-reachable-by-teammates':
        await notReachable(deps, undefined);
        return 'not-reachable';
      case 'offline':
        if (await offerRetry(deps, SHARE_TEXT.offline)) continue;
        return 'failed';
      case 'changed':
        if (await offerRetry(deps, SHARE_TEXT.changed)) continue;
        return 'failed';
      case 'rejected':
        await offerDetails(deps, 'error', SHARE_TEXT.rejected);
        return 'failed';
      case 'record-missing':
        await offerDetails(deps, 'error', SHARE_TEXT.recordMissing);
        return 'failed';
      case 'no-local-branch':
        await offerDetails(deps, 'error', SHARE_TEXT.notHere);
        return 'failed';
    }
  }
}
