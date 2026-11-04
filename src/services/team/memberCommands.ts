// The membership commands (TEAM-02, TEAM-03): Invite to Team, Join Team, Manage Team Members, Link Your Organization and Sign Out of NEAR AI for This Team.
// Each is a thin adapter: it asks plain questions, calls the vscode-free flows in src/team, and says what happened and what to do next. Nothing here
// logs, stores or shows a code, key, token or repository address: the invite bundle appears once in a modal and on the clipboard when the lead
// chooses Copy invite, and pasted bundles and keys go through password inputs.
// Solo activation stays one fs.stat, so this module imports only vscode, Node built-ins, types and the prompts module (which imports only vscode);
// every team module is loaded with a dynamic import inside a handler (the teamCommands.ts header rule). Every input, pick and message goes through
// teamPrompts, so the extension-host test can answer them (61-20).
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Role, TeamFile } from '../../domain/team/types';
import type { CleanupChecklist, CleanupItem, CleanupStep } from '../../team/cleanupChecklist';
import type { CatchUpReason } from '../../team/joinCatchUp';
import type { NearOrgClient } from '../../team/nearOrg';
import type { NearSession } from '../../team/nearSession';
import type { FetchLike, SessionTokens } from '../reportingSignIn';
import { teamPrompts } from './teamPrompts';
import type { TeamSession } from './teamSession';

export const INVITE_COMMAND = 'nearAi.team.invite';
// Kept separate from the copies in teamSession.ts so a solo project never loads the session module; teamManifest.test.ts pins them equal.
export const JOIN_COMMAND = 'nearAi.team.join';
export const MANAGE_MEMBERS_COMMAND = 'nearAi.team.manageMembers';
export const LINK_NEAR_COMMAND = 'nearAi.team.linkNearOrganization';
export const SIGN_OUT_NEAR_COMMAND = 'nearAi.team.signOutNear';

// Plain-language pass: people share and get the project; the extension runs git. Git words stay in the output channel.
const SHOW_DETAILS_ACTION = 'Show details';
// G-61-3: a link the lead chose not to share yet stays on this computer; they are told teammates will not see it and where to share it.
export const LINK_NOT_SHARED_TEXT = 'The link is saved on this computer only. Teammates will not see it until you share your team setup. Choose Share in the Team section of your NEAR AI sidebar.';
const LINK_SAVE_UNFINISHED_TEXT = 'The link is saved in this project, but saving it for the team did not finish. Choose Show details for the one step that is left.';
const INVITE_ADDRESS_TEXT = 'No invite was made, because the address your project is kept at online cannot be given to teammates as it is.';
const INVITE_ADDRESS_DETAIL = 'Keep the project online at an address your teammates can use, for example on GitHub, with no password or token in it, then invite again. Choose Show details for why.';
// G-61-5 (owner, 2026-11-03): the invite is shown once, in a modal that says how to hand it over and what the invitee does. Closing it without
// copying asks once more, because the invite is not shown again. Plain words only; the invite itself is only ever in that modal's detail.
export const INVITE_TEXT = Object.freeze({
  copy: 'Copy invite',
  close: 'Close',
  howToSend: 'Send it to them in a private message, such as a direct chat or an email. It works once. To join, they open the project in VS Code, open the NEAR AI sidebar, choose Join a team and paste the invite. If they do not have the project yet, Join a team offers to download it.',
  closeWithoutCopying: 'Close without copying? The invite is not shown again.'
} as const);
const inviteReadyText = (name: string): string => `Invite ready for ${name}`;
const inviteCopiedText = (name: string): string => `Invite for ${name} copied. Send it to them in a private message.`;
const inviteNotCopiedText = (name: string): string => `The invite for ${name} was not copied. You can issue it again from Members in the Team section of your NEAR AI sidebar.`;
// G-61-3: an invite is only made once the team setup is online, so the invite can find the team.
export const INVITE_NEEDS_SHARE_TEXT = 'No invite was made, because your team setup must be online before anyone can join with an invite. Nothing was changed.';
// G-61-6 (owner, 2026-11-03): wherever linking is offered, one plain line says what the organization is, then Link now or Not now.
export const LINK_EXPLANATION = 'Your organization is the account that pays for your team\'s AI, so each person can get a spending limit.';
export const LINK_NOW_CHOICE = 'Link now';
export const NOT_NOW_CHOICE = 'Not now, everyone uses their own key';
const CLONE_ACTION = 'Get the project';
// G-61-4: what Join says about the copy that is open. Plain words only; the technical reason goes to the NEAR AI Team channel.
const FRESH_COPY_TEXT = 'To join now, get a fresh copy of the project. This copy stays as it is.';
export const JOIN_TEXT = Object.freeze({
  title: 'Joining',
  updateStep: 'Getting the latest version of the project',
  updated: 'Your copy of the project was brought up to date.',
  localChanges: `Your copy of the project has changes that are not online yet, so it was not brought up to date and nothing in it was changed. ${FRESH_COPY_TEXT}`,
  otherVersion: `Your copy of the project is set to a different version than the one your team shares, so it was not brought up to date and nothing in it was changed. ${FRESH_COPY_TEXT}`,
  notShared: 'Your team\'s setup is not online yet, so you cannot join from this copy. Ask the person who invited you to choose Share in the Team section of their NEAR AI sidebar, then paste the invite again.',
  offline: 'Your copy of the project could not be brought up to date, because the online home of the project could not be reached. Check your internet connection, then choose Try again. Nothing was changed.',
  cloneNeeded: 'This invite is for a project that is not open here. Choose Get the project to download it, open it, then choose Join a team in the NEAR AI sidebar and paste the invite again.',
  freshCopy: 'Get a fresh copy',
  tryAgain: 'Try again'
} as const);
const SIGN_IN_ACTION = 'Sign in';
const WITHOUT_NEAR_ACTION = 'Invite without signing in';
const REPLACE_LINK_ACTION = 'Replace link';
const RESET_ACTION = 'Remove unfinished keys';
const CONTINUE_WITHOUT_NEAR_ACTION = 'Continue without signing in';
const REMOVE_ACTION = 'Remove';
const CANCEL_INVITATION_ACTION = 'Cancel invitation';
// The first row of Manage Team Members for the owner and leads; it runs the invite.
const INVITE_ROW = 'Invite someone';
// UI review issue 1: what each long flow is doing, in plain words. The steps come from the vscode-free flows as codes.
const INVITE_STEP_TEXT: Record<'log' | 'near', string> = { log: 'Saving the invitation to the team record', near: 'Sending the invitation to your organization' };
const JOIN_STEP_TEXT: Record<'check' | 'keys' | 'log' | 'near' | 'key', string> = {
  check: 'Reading the team record and checking your invitation', keys: 'Making the keys for this computer', log: 'Saving your join to the team record',
  near: 'Accepting the invitation to your organization', key: 'Adding your API key'
};
const DELIVERY_STEP_TEXT: Record<'confirm' | 'read-old' | 'create' | 'seal' | 'log' | 'retire', string> = {
  confirm: 'Saving the confirmation to the team record', 'read-old': 'Reading the limit and spend of the old key', create: 'Creating the key with its spend cap',
  seal: 'Sealing the key to their computer', log: 'Saving the key delivery to the team record', retire: 'Setting the old key limit to 0 and revoking it'
};
const REMOVE_STEP_TEXT: Record<'cap' | 'log' | 'revoke' | 'organization' | 'cancel-near', string> = {
  cap: 'Setting the AI key limit to 0', log: 'Saving the removal to the team record', revoke: 'Revoking the AI key',
  organization: 'Removing them from your organization', 'cancel-near': 'Cancelling the invitation to your organization'
};
const READ_ONLY_TEXT = 'Only the owner or a lead can change the team. You can see everyone here, but not change anything.';
const STEP_TEXT: Record<CleanupStep, string> = {
  'send-invitation': 'Send the invitation to your organization', 'cancel-invitation': 'Cancel the invitation to your organization', 'deliver-key': 'Send the team key',
  'rotate-key': 'Replace the team key', 'zero-limit': 'Set the key limit to 0', 'revoke-key': 'Revoke the key',
  'remove-org-member': 'Remove from your organization', 'repo-access': 'Remove their access to the project on GitHub (or wherever the project is hosted)'
};
const MEMBER_ACTIONS = ['confirm', 'deliver-key', 'rotate-key', 'remove'] as const;
type MemberAction = (typeof MEMBER_ACTIONS)[number];
const TEAM_FILE_PARTS = ['.planning', '.near-ai', 'team.json'];
const NANO_PER_CENT = 10_000_000;
const MAX_EMAIL_LENGTH = 254;
const USD_PATTERN = /^(\d{1,10})(?:\.(\d{1,2}))?$/;

// "5", "5.5" and "5.25" become integer nano-USD. The digits are joined as text and read once, so no decimal is ever multiplied as a float.
// More than two decimals, negatives, exponents, signs and anything else are refused, as is an amount too large to keep exactly.
export function parseUsdToNanoUsd(text: string): number | undefined {
  const match = USD_PATTERN.exec(text.trim());
  if (match === null) return undefined;
  const cents = `${match[1] as string}${(match[2] ?? '').padEnd(2, '0')}`;
  const nano = Number(`${cents}${'0'.repeat(7)}`);
  return Number.isSafeInteger(nano) ? nano : undefined;
}

// Integer nano-USD as dollars and cents, by BigInt division so nothing is rounded. A part of a cent is shown in full.
export function formatNanoUsd(nanoUsd: number): string {
  const total = BigInt(Math.max(0, Math.trunc(nanoUsd)));
  const whole = total / 1_000_000_000n;
  const rest = total % 1_000_000_000n;
  const cents = rest / BigInt(NANO_PER_CENT);
  const sub = rest % BigInt(NANO_PER_CENT);
  const decimals = sub === 0n ? cents.toString().padStart(2, '0') : rest.toString().padStart(9, '0').replace(/0+$/, '');
  return `$${whole.toString()}.${decimals}`;
}

type Level = 'info' | 'warn' | 'error';

export interface MemberCommandDeps {
  context: vscode.ExtensionContext;
  output: { appendLine(line: string): void; show?(preserveFocus?: boolean): void };
  // Shows a message and keeps it in the NEAR AI Team channel.
  report(level: Level, message: string): void;
  // Shows a message only. A project without a team uses this, so it never creates the channel.
  announce(level: Level, message: string): void;
  soloText: string;
  firstFolder(): string | undefined;
  session(): TeamSession | undefined;
  startSession(projectRoot: string): Promise<'solo' | 'team' | 'error'>;
  restartSession(projectRoot: string): Promise<void>;
  // G-61-8: Invite someone in a project with no team sets the team up first (the Enable flow in invite mode: the same connect, online-home and
  // existing-team checks, the team name and your name filled in, no closing message). True when the team's session runs afterwards.
  startTeam(): Promise<boolean>;
  nearBaseUrl?: string;
  fetch?: FetchLike;
  // Tests replace the browser sign-in.
  signIn?: (teamId: string) => Promise<SessionTokens | undefined>;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function teamFileExists(projectRoot: string): Promise<boolean> {
  try {
    await fs.stat(path.join(projectRoot, ...TEAM_FILE_PARTS));
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function validEmail(email: string): boolean {
  // eslint-disable-next-line no-control-regex
  return email.length <= MAX_EMAIL_LENGTH && email.includes('@') && !/[\u0000-\u001F\u007F\s]/.test(email);
}

export function registerMemberCommands(deps: MemberCommandDeps): vscode.Disposable[] {
  // ---- small helpers ---------------------------------------------------------------------------------------------------------------

  // Remote, log and NEAR text can carry a URL with a credential; this is the team code's own redaction, loaded only when something is shown.
  async function safe(text: string): Promise<string> {
    return (await import('./teamStatusBar')).safeReason(text);
  }

  // A member name or label from the log or NEAR is untrusted display text.
  async function display(text: string): Promise<string> {
    return (await import('./teamStatusBar')).displayText(text);
  }

  async function describe(error: unknown): Promise<string> {
    return safe(error instanceof Error ? error.message : String(error));
  }

  async function ask(options: vscode.InputBoxOptions): Promise<string | undefined> {
    const answer = await teamPrompts.input({ ignoreFocusOut: true, ...options });
    return answer === undefined ? undefined : answer.trim();
  }

  async function pick<T extends vscode.QuickPickItem>(items: T[], options: { title: string; placeHolder: string }): Promise<T | undefined> {
    return teamPrompts.pick(items, { ignoreFocusOut: true, ...options });
  }

  // A long flow in a progress notification with plain step messages (UI review issue 1). `cancellable` is only set where the flow can stop
  // safely between steps; the flow decides where that is.
  function withSteps<T>(title: string, cancellable: boolean, task: (step: (message: string) => void, token: vscode.CancellationToken) => Promise<T>): Promise<T> {
    return Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable }, (progress, token) =>
      task((message) => { progress.report({ message }); }, token)));
  }

  function guarded(title: string, handler: (...args: unknown[]) => Promise<void>): (...args: unknown[]) => Promise<void> {
    return async (...args: unknown[]): Promise<void> => {
      try {
        await handler(...args);
      } catch (error) {
        deps.report('error', `${title} did not finish: ${await describe(error)}`);
      }
    };
  }

  // The session of a project that has a team, started if it is not running yet. A project without a team is told how to turn Team Mode on.
  async function requireTeam(): Promise<{ projectRoot: string; session: TeamSession } | undefined> {
    const projectRoot = deps.firstFolder();
    if (projectRoot === undefined || !(await teamFileExists(projectRoot))) {
      deps.announce('info', deps.soloText);
      return undefined;
    }
    if (deps.session() === undefined) {
      const state = await deps.startSession(projectRoot);
      if (state === 'solo') deps.announce('info', deps.soloText);
    }
    const session = deps.session();
    if (session === undefined) return undefined;
    if (session.isRemoved()) {
      deps.report('info', 'You were removed from this team on this computer, so this command is not available here.');
      return undefined;
    }
    return { projectRoot, session };
  }

  async function baseUrl(): Promise<string> {
    return deps.nearBaseUrl ?? (await import('../../domain/config')).DEFAULT_BASE_URL;
  }

  // The owner and leads manage people and the NEAR link; everyone else is told who can.
  async function requireManager(session: TeamSession, what: string): Promise<boolean> {
    const { decideTeamAction } = await import('../../domain/team/permissions');
    const myId = session.memberId();
    if (myId === undefined) {
      deps.report('info', `This computer is not a member of the team yet, so it cannot ${what}. Run "NEAR AI: Join Team" with the invite your lead sent you.`);
      return false;
    }
    if (!decideTeamAction(session.state(), myId, { kind: 'member.invite' }).allowed) {
      const role = session.state().members.get(myId)?.role ?? 'member';
      deps.report('info', `Only the owner or a lead can ${what}. Your role in this team is ${role}.`);
      return false;
    }
    return true;
  }

  // ---- NEAR sign-in (D-01, D-02) -------------------------------------------------------------------------------------------------------

  // One NEAR session per team for the life of this window (WR-04): a rotated refresh token that SecretStorage refused to save lives only in
  // that object, so a later command must reuse it rather than read the burned token from storage again.
  const nearSessions = new Map<string, NearSession>();
  const storeFailure = (message: string): void => { deps.report('warn', message); };

  async function nearSessionFor(teamId: string): Promise<NearSession> {
    const existing = nearSessions.get(teamId);
    if (existing !== undefined) return existing;
    const { NearSession } = await import('../../team/nearSession');
    const made = new NearSession({ teamId, secrets: deps.context.secrets, baseUrl: await baseUrl(), onStoreFailure: storeFailure, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) });
    nearSessions.set(teamId, made);
    return made;
  }

  async function orgClientFor(auth: NearSession): Promise<NearOrgClient> {
    const { NearOrgClient } = await import('../../team/nearOrg');
    return new NearOrgClient({ baseUrl: await baseUrl(), auth, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) });
  }

  // The kept NEAR session of this team, or undefined when the lead is not signed in for it.
  async function keptSession(teamId: string): Promise<{ session: NearSession; org: NearOrgClient; label: string } | undefined> {
    const session = await nearSessionFor(teamId);
    const signedIn = await session.signedIn();
    return signedIn === undefined ? undefined : { session, org: await orgClientFor(session), label: signedIn.label };
  }

  async function browserTokens(): Promise<SessionTokens | undefined> {
    const choice = await pick<vscode.QuickPickItem & { provider: 'github' | 'google' }>([
      { label: 'Sign in with GitHub', description: 'Opens NEAR AI Cloud in your browser', provider: 'github' },
      { label: 'Sign in with Google', description: 'For a NEAR AI Cloud account that signs in with Google', provider: 'google' }
    ], { title: 'Sign in to NEAR AI', placeHolder: 'NEAR AI keeps this sign-in for this team until you run "NEAR AI: Sign Out of NEAR AI for This Team"' });
    if (choice === undefined) return undefined;
    const { browserSignIn, TEAM_SIGN_IN_COPY } = await import('../nearSignIn');
    const address = await baseUrl();
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Waiting for the NEAR AI sign-in in your browser', cancellable: true },
      (_progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => { abort.abort(); });
        return browserSignIn(address, choice.provider, abort.signal, TEAM_SIGN_IN_COPY);
      }
    );
  }

  function getTokens(teamId: string): Promise<SessionTokens | undefined> {
    return deps.signIn !== undefined ? deps.signIn(teamId) : browserTokens();
  }

  async function describeNear(error: unknown, tokens?: SessionTokens): Promise<string> {
    const { scrubNearText } = await import('../../team/nearOrg');
    const text = error instanceof Error ? error.message : String(error);
    return safe(scrubNearText(text, tokens === undefined ? [] : [tokens.accessToken, tokens.refreshToken]));
  }

  // Signs the lead in and keeps the session for this team, labelled with the NEAR account. Says why when it does not work.
  async function signInAndKeep(teamId: string): Promise<{ session: NearSession; org: NearOrgClient; label: string } | undefined> {
    let tokens: SessionTokens | undefined;
    try {
      tokens = await getTokens(teamId);
    } catch (error) {
      const { SignInError } = await import('../reportingSignIn');
      if (error instanceof SignInError && error.code === 'cancelled') deps.announce('info', 'The NEAR AI sign-in was cancelled. Nothing was changed.');
      else deps.report('error', `The NEAR AI sign-in did not finish: ${await describeNear(error)}`);
      return undefined;
    }
    if (tokens === undefined) {
      deps.announce('info', 'You were not signed in to NEAR AI. Nothing was changed.');
      return undefined;
    }
    try {
      const { NearOrgClient } = await import('../../team/nearOrg');
      const { saveNearSession } = await import('../../team/nearSession');
      const options = { baseUrl: await baseUrl(), ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) };
      const bearer = { accessToken: async (): Promise<string> => (tokens as SessionTokens).accessToken, refreshAfterUnauthorized: async (): Promise<undefined> => undefined };
      const me = await new NearOrgClient({ ...options, auth: bearer }).currentUser();
      const session = await saveNearSession(deps.context.secrets, teamId, tokens, me.username, { ...options, onStoreFailure: storeFailure });
      nearSessions.set(teamId, session);
      return { session, org: await orgClientFor(session), label: me.username };
    } catch (error) {
      deps.report('error', `The NEAR AI sign-in did not finish: ${await describeNear(error, tokens)}`);
      return undefined;
    }
  }

  // ---- messages ------------------------------------------------------------------------------------------------------------------------

  // Plain words with Show details, which opens the NEAR AI Team channel where the technical reason was written just before.
  async function showDetailsOffer(level: Level, message: string): Promise<void> {
    try {
      if (await teamPrompts.message(level, message, undefined, SHOW_DETAILS_ACTION) === SHOW_DETAILS_ACTION) deps.output.show?.(true);
    } catch (error) {
      deps.output.appendLine(`A Team Mode message could not be shown: ${await describe(error)}`);
    }
  }

  // ---- Link Your Organization (D-03) -----------------------------------------------------------------------------------------------------

  // G-61-3: the team setup this computer now has, link included, is shared with the share flow's one confirmation (reason link), so a link is
  // never left only on the lead's computer. Declining keeps the link here and says how to share it later; on anything else the share flow has
  // already said why in plain words. The share flow is the only way a membership command puts anything online.
  async function shareLink(projectRoot: string): Promise<void> {
    const session = deps.session();
    const teamFile = await (await import('../../team/teamFile')).readTeamFile(projectRoot);
    if (session === undefined || teamFile === undefined) return;
    const branch = session.state().team.policy.integrationBranch;
    const { ensureTeamSetupShared } = await import('./shareFlow');
    const outcome = await ensureTeamSetupShared({ output: deps.output, announce: deps.announce }, { projectRoot, teamFile, branch, reason: 'link' });
    if (outcome === 'shared' || outcome === 'already') return;
    deps.output.appendLine(`The organization link is committed on this computer but not on ${branch} online (${outcome}).`);
    if (outcome === 'declined') deps.report('info', LINK_NOT_SHARED_TEXT);
  }

  // Returns true when the team ends up linked to the chosen organization (also when it already was), false when nothing was linked.
  // `share` false is the Invite flow: it asks its own single share confirmation right after, so the link flow asks none (61-20). Everywhere else
  // a new link is shared through the share flow with one confirmation (61-23).
  async function linkFlow(projectRoot: string, share: boolean): Promise<boolean> {
    const { readTeamFile } = await import('../../team/teamFile');
    const { linkChoices, linkNearOrganization } = await import('../../team/nearLink');
    const teamFile = await readTeamFile(projectRoot);
    if (teamFile === undefined) {
      deps.announce('info', deps.soloText);
      return false;
    }
    const teamName = await display(teamFile.name);
    const kept = await keptSession(teamFile.teamId) ?? await signInAndKeep(teamFile.teamId);
    if (kept === undefined) return false;

    let choices: Awaited<ReturnType<typeof linkChoices>>;
    let stopped = false;
    try {
      // Reading the lists changes nothing, so it can be stopped: a stop is honoured once the lists come back.
      choices = await withSteps('Reading your organizations', true, async (step, token) => {
        step('Listing the organizations and workspaces you can link');
        const read = await linkChoices(kept.org);
        stopped = token.isCancellationRequested;
        return read;
      });
    } catch (error) {
      deps.report('error', `Your organizations could not be read: ${await describeNear(error)}`);
      return false;
    }
    if (stopped) {
      deps.report('info', 'You stopped reading your organizations. The link was not changed.');
      return false;
    }
    if (choices.length === 0) {
      deps.report('info', 'You are not an owner or admin of any organization on NEAR AI, so there is nothing to link. Ask an owner to make you an admin, then run "NEAR AI: Link Your Organization" again.');
      return false;
    }
    const organizations = await Promise.all(choices.map(async (choice) => ({ label: await display(choice.organization.name), description: choice.organization.role, choice })));
    const organization = await pick(organizations, { title: 'Link Your Organization', placeHolder: `Pick the organization that pays for ${teamName}` });
    if (organization === undefined) return false;
    if (organization.choice.workspaces.length === 0) {
      deps.report('info', `${organization.label} has no workspaces yet. Create one in your organization's settings on the NEAR AI website, then run "NEAR AI: Link Your Organization" again.`);
      return false;
    }
    const workspaces = await Promise.all(organization.choice.workspaces.map(async (workspace) => ({ label: await display(workspace.name), workspace })));
    const workspace = await pick(workspaces, { title: 'Link Your Organization', placeHolder: `Pick the workspace for ${teamName}'s member keys` });
    if (workspace === undefined) return false;

    const near = { organizationId: organization.choice.organization.id, workspaceId: workspace.workspace.id };
    const link = { projectRoot, globalStorageDir: deps.context.globalStorageUri.fsPath, teamId: teamFile.teamId, near };
    const saveLink = (replace: boolean): ReturnType<typeof linkNearOrganization> => withSteps(`Linking ${teamName} to ${organization.label}`, false, async (step) => {
      step('Saving the link in this project');
      return linkNearOrganization(replace ? { ...link, replace: true } : link);
    });
    let result = await saveLink(false);
    if (!result.ok && result.code === 'different-link') {
      const confirmed = await teamPrompts.message(
        'warn', `${teamName} is already linked to a different organization or workspace. Replace the link only if your whole team agrees.`,
        { modal: true }, REPLACE_LINK_ACTION
      );
      if (confirmed !== REPLACE_LINK_ACTION) {
        deps.report('info', 'The link was not changed.');
        return false;
      }
      result = await saveLink(true);
    }
    if (!result.ok) {
      // A link that was written but not committed is still on disk, so the session is replaced to read it. The git step that is left goes to the
      // channel; the person gets plain words with Show details (plain-language pass).
      if (result.code === 'commit-failed') {
        await deps.restartSession(projectRoot);
        deps.output.appendLine(await safe(result.message));
        await showDetailsOffer('warn', LINK_SAVE_UNFINISHED_TEXT);
      } else {
        deps.report('error', await safe(result.message));
      }
      return false;
    }
    if (result.status === 'unchanged') {
      deps.report('info', `${teamName} is already linked to ${organization.label}. Nothing was changed.`);
      return true;
    }
    await deps.restartSession(projectRoot);
    deps.output.appendLine(result.branch === undefined ? 'team.json is committed.' : `team.json is committed on ${result.branch}. Sharing pushes it.`);
    deps.report('info', `Linked ${teamName} to ${organization.label}.`);
    if (share) await shareLink(projectRoot);
    return true;
  }

  // The explanation before linking: 'link' goes on into the sign-in, 'not-now' and undefined (the pick was closed) change nothing.
  async function askToLink(title: string): Promise<'link' | 'not-now' | undefined> {
    const choice = await pick([
      { label: LINK_NOW_CHOICE, description: 'Sign in to NEAR AI and pick your organization' },
      { label: NOT_NOW_CHOICE, description: 'Spending is not capped until your organization is linked' }
    ], { title, placeHolder: LINK_EXPLANATION });
    if (choice === undefined) return undefined;
    return choice.label === LINK_NOW_CHOICE ? 'link' : 'not-now';
  }

  async function linkCommand(): Promise<void> {
    const found = await requireTeam();
    if (found === undefined) return;
    if (!await requireManager(found.session, 'link your organization')) return;
    // A team without a link is told what linking is for first; a linked team goes straight to the pickers (same link, or replace it).
    const { readTeamFile } = await import('../../team/teamFile');
    if ((await readTeamFile(found.projectRoot))?.near === undefined) {
      const choice = await askToLink('Link Your Organization');
      if (choice === undefined) return;
      if (choice === 'not-now') {
        deps.report('info', `Nothing was changed. ${(await import('../../team/join')).NO_ORG_NOTICE}`);
        return;
      }
    }
    await linkFlow(found.projectRoot, true);
  }

  // ---- Sign Out of NEAR AI for This Team (D-01) -------------------------------------------------------------------------------------------

  async function signOutCommand(): Promise<void> {
    const projectRoot = deps.firstFolder();
    if (projectRoot === undefined || !(await teamFileExists(projectRoot))) {
      deps.announce('info', deps.soloText);
      return;
    }
    const { readTeamFile } = await import('../../team/teamFile');
    const teamFile = await readTeamFile(projectRoot);
    if (teamFile === undefined) {
      deps.announce('info', deps.soloText);
      return;
    }
    const teamName = await display(teamFile.name);
    const session = await nearSessionFor(teamFile.teamId);
    if (await session.signedIn() === undefined) {
      deps.report('info', `You are not signed in to NEAR AI for ${teamName}. There is nothing to sign out of.`);
      return;
    }
    const { serverConfirmed } = await session.signOut();
    deps.report('info', serverConfirmed
      ? `Signed out of NEAR AI for ${teamName}.`
      : `Signed out of NEAR AI for ${teamName} on this computer. NEAR AI could not be reached to end the sign-in there; it expires on its own.`);
  }

  // ---- Invite to Team ----------------------------------------------------------------------------------------------------------------

  // The lead's NEAR client for a lead invitation: the kept session, or a sign-in the lead is asked for first. 'cancelled' stops the invite.
  async function orgForLeadInvite(teamId: string, name: string): Promise<NearOrgClient | undefined | 'cancelled'> {
    const kept = await keptSession(teamId);
    if (kept !== undefined) return kept.org;
    const choice = await teamPrompts.message(
      'info', `${name} will also be invited to your organization, which needs your NEAR AI sign-in. Sign in now, or invite without signing in and finish that step later from "NEAR AI: Manage Team Members".`,
      { modal: true }, SIGN_IN_ACTION, WITHOUT_NEAR_ACTION
    );
    if (choice === undefined) return 'cancelled';
    if (choice === WITHOUT_NEAR_ACTION) return undefined;
    const signedIn = await signInAndKeep(teamId);
    return signedIn === undefined ? 'cancelled' : signedIn.org;
  }

  // The four lifetimes of D-08, seven days first so Enter picks the recommended one. Returns seconds.
  async function askLifetime(): Promise<number | undefined> {
    const { INVITE_TTL_CHOICES, DEFAULT_INVITE_TTL_SECONDS } = await import('../../domain/team/invite');
    const lifetimes = [...INVITE_TTL_CHOICES].sort((left, right) => (left === DEFAULT_INVITE_TTL_SECONDS ? -1 : right === DEFAULT_INVITE_TTL_SECONDS ? 1 : left - right))
      .map((ttlSeconds) => ({ label: ttlSeconds === 86_400 ? '24 hours' : `${ttlSeconds / 86_400} days`, ...(ttlSeconds === DEFAULT_INVITE_TTL_SECONDS ? { description: 'Recommended' } : {}), ttlSeconds }));
    return (await pick(lifetimes, { title: 'Invite to Team', placeHolder: 'How long the invite works before it expires' }))?.ttlSeconds;
  }

  // D-05, G-61-5: the bundle is shown once, in a modal whose detail is the invite, a blank line and how to send it, with Copy invite. Closing it
  // asks once more (Copy invite or Close), without showing the invite again. It is written to the clipboard only when the lead chooses Copy invite,
  // and never logged or stored. Invite and Re-issue both use this.
  async function presentBundle(shownName: string, bundle: string): Promise<void> {
    let choice = await teamPrompts.message('info', inviteReadyText(shownName), { modal: true, detail: `${bundle}\n\n${INVITE_TEXT.howToSend}` }, INVITE_TEXT.copy);
    if (choice !== INVITE_TEXT.copy) {
      choice = await teamPrompts.message('warn', INVITE_TEXT.closeWithoutCopying, { modal: true }, INVITE_TEXT.copy, INVITE_TEXT.close);
    }
    if (choice === INVITE_TEXT.copy) {
      await vscode.env.clipboard.writeText(bundle);
      deps.announce('info', inviteCopiedText(shownName));
    } else {
      deps.announce('info', inviteNotCopiedText(shownName));
    }
  }

  // G-61-2, G-61-3: an invite is only usable when the team setup is online on the team's main version, so it is shared first, with the one
  // confirmation of the share flow ('Share and continue'). Returns true when the setup is online (shared now or already). On anything else the
  // share flow has already said why in plain words; a declined share is followed by one sentence that no invite was made.
  async function inviteNeedsShared(projectRoot: string, session: TeamSession, teamFile: TeamFile): Promise<boolean> {
    const { ensureTeamSetupShared } = await import('./shareFlow');
    const outcome = await ensureTeamSetupShared({ output: deps.output, announce: deps.announce }, {
      projectRoot, teamFile, branch: session.state().team.policy.integrationBranch, reason: 'invite'
    });
    if (outcome === 'shared' || outcome === 'already') return true;
    deps.output.appendLine(`No invite was made because the team setup is not on ${session.state().team.policy.integrationBranch} online (${outcome}).`);
    if (outcome === 'declined') deps.report('info', INVITE_NEEDS_SHARE_TEXT);
    return false;
  }

  async function invite(): Promise<void> {
    // A project with no team yet: inviting sets the team up on the way and then carries straight on into the invite (G-61-8).
    const root = deps.firstFolder();
    if (root !== undefined && !(await teamFileExists(root))) {
      if (!(await deps.startTeam())) return;
    }
    const found = await requireTeam();
    if (found === undefined) return;
    const { projectRoot } = found;
    let session = found.session;
    const { validateName } = await import('../../domain/team/validate');
    const { readTeamFile } = await import('../../team/teamFile');
    if (!await requireManager(session, 'invite people')) return;

    let teamFile: TeamFile | undefined = await readTeamFile(projectRoot);
    if (teamFile === undefined) {
      deps.report('error', 'This project has no team file any more, so no invite was made. Nothing was changed.');
      return;
    }
    // A project teammates cannot reach (kept only on this computer, or at an address that cannot be given out) is known without going online,
    // so it is said before anything is asked, even the organization choice. The share flow shows its modal and shares nothing.
    const { checkOnlineHome } = await import('../../team/projectHome');
    if ((await checkOnlineHome(projectRoot, teamFile.coordination.remote)).kind !== 'shareable') {
      await inviteNeedsShared(projectRoot, session, teamFile);
      return;
    }

    // D-03, G-61-6: a team with no organization link is offered the link first, once per invite, with the one-line explanation, and Not now is
    // said out loud. linkFlow itself does not ask again and offers no share of its own: the share below covers the link too.
    if (teamFile.near === undefined) {
      const choice = await askToLink('Invite to Team');
      if (choice === undefined) return;
      if (choice === 'link') {
        if (!await linkFlow(projectRoot, false)) {
          deps.report('info', 'Your organization was not linked, so no invite was made. Nothing was changed.');
          return;
        }
        session = deps.session() ?? session;
        teamFile = await readTeamFile(projectRoot) ?? teamFile;
      } else {
        deps.report('info', (await import('../../team/join')).NO_ORG_NOTICE);
      }
    }

    // The team setup this computer has, link included, must be online before the first question (G-61-3).
    if (!await inviteNeedsShared(projectRoot, session, teamFile)) return;

    const name = await ask({
      title: 'Invite to Team', prompt: 'Name of the person you are inviting.', placeHolder: 'Their name',
      validateInput: (value) => (validateName(value.trim(), 'name') === undefined ? undefined : 'Enter a name of 1 to 80 characters on one line.')
    });
    if (name === undefined) return;
    const email = await ask({
      title: 'Invite to Team', prompt: 'Their email address. The team record keeps only a scrambled code (a salted hash) of it.', placeHolder: 'name@example.com',
      validateInput: (value) => (validEmail(value.trim()) ? undefined : 'Enter a full email address such as name@example.com.')
    });
    if (email === undefined) return;
    const roleChoice = await pick<vscode.QuickPickItem & { role: Exclude<Role, 'owner'> }>([
      { label: 'Developer', description: 'Builds and claims work', role: 'developer' },
      { label: 'Reviewer', description: 'Reviews work', role: 'reviewer' },
      { label: 'Observer', description: 'Can read the team but not change it', role: 'observer' },
      { label: 'Lead', description: 'Can also invite, confirm and remove people', role: 'lead' }
    ], { title: 'Invite to Team', placeHolder: `Role for ${await display(name)}` });
    if (roleChoice === undefined) return;
    const amount = await ask({
      title: 'Invite to Team', prompt: 'Allocation in US dollars. For example 5 or 12.50.', value: '0',
      validateInput: (value) => (parseUsdToNanoUsd(value) === undefined ? 'Enter dollars and cents, for example 5 or 12.50.' : undefined)
    });
    if (amount === undefined) return;
    const allocationNanoUsd = parseUsdToNanoUsd(amount);
    if (allocationNanoUsd === undefined) {
      deps.report('error', 'That amount is not dollars and cents, so no invite was made. Enter a number such as 5 or 12.50.');
      return;
    }
    const lifetime = await askLifetime();
    if (lifetime === undefined) return;

    let org: NearOrgClient | undefined;
    const shownName = await display(name);
    if (teamFile.near !== undefined && roleChoice.role === 'lead') {
      const chosen = await orgForLeadInvite(teamFile.teamId, shownName);
      if (chosen === 'cancelled') {
        deps.report('info', 'No invite was made. Nothing was changed.');
        return;
      }
      org = chosen;
    }

    const { inviteMember } = await import('../../team/invite');
    const log = session.currentLog();
    const linkedFile = teamFile;
    const result = await withSteps(`Inviting ${shownName}`, false, (step) => inviteMember({
      projectRoot, globalStorageDir: deps.context.globalStorageUri.fsPath, teamFile: linkedFile, log,
      name, email, role: roleChoice.role, allocationNanoUsd, ttlSeconds: lifetime, ...(org === undefined ? {} : { org }),
      onStep: (code) => { step(INVITE_STEP_TEXT[code]); }
    }));
    if (!result.ok) {
      if (result.code === 'remote-url') {
        // The address changed between the check above and the invite. The reason names the address and git; it is kept in the channel and the
        // lead reads what to do in a modal.
        deps.output.appendLine(await safe(result.message));
        if (await teamPrompts.message('error', INVITE_ADDRESS_TEXT, { modal: true, detail: INVITE_ADDRESS_DETAIL }, SHOW_DETAILS_ACTION) === SHOW_DETAILS_ACTION) deps.output.show?.(true);
      } else {
        deps.report('error', await safe(result.message));
      }
      return;
    }
    await presentBundle(shownName, result.bundle);
    if (result.nearInvitation === 'sent') deps.report('info', `${shownName} was also invited to your organization as an admin. They accept it when they join.`);
    else if (result.nearInvitation === 'already-member') deps.report('info', `${shownName} is already in your organization.`);
    if (result.notice !== undefined) deps.report('info', await safe(result.notice));
    session.nudge();
  }

  // ---- Join Team (D-07, D-22, D-26) ------------------------------------------------------------------------------------------------------

  const article = (role: string): string => (role === 'observer' ? 'an observer' : `a ${role}`);

  // The open copy is this team's project but was not brought up to date, so nothing in it changed. The person reads one sentence with the way
  // forward; the technical reason goes to the channel only (T-61-87). The invite's address is used only for the download the person chooses
  // (T-61-86). Returns true when the person chose Try again.
  async function notReady(prepared: { reason: CatchUpReason; repoUrl: string; detail?: string }): Promise<boolean> {
    deps.output.appendLine(`Bringing the project up to date did not finish (${prepared.reason})${prepared.detail === undefined ? '.' : `: ${await safe(prepared.detail)}`}`);
    switch (prepared.reason) {
      case 'local-changes':
      case 'unshared-work':
      case 'other-version': {
        const text = prepared.reason === 'other-version' ? JOIN_TEXT.otherVersion : JOIN_TEXT.localChanges;
        if (await teamPrompts.message('warn', text, undefined, JOIN_TEXT.freshCopy) === JOIN_TEXT.freshCopy) {
          await vscode.commands.executeCommand('git.clone', prepared.repoUrl);
        }
        return false;
      }
      case 'not-shared':
        await teamPrompts.message('warn', JOIN_TEXT.notShared, undefined);
        return false;
      case 'offline':
        return await teamPrompts.message('warn', JOIN_TEXT.offline, undefined, JOIN_TEXT.tryAgain) === JOIN_TEXT.tryAgain;
    }
  }

  async function join(): Promise<void> {
    const projectRoot = deps.firstFolder();
    const pasted = await ask({
      title: 'Join Team', prompt: 'Paste the invite your lead sent you. It works once.', password: true, placeHolder: 'Paste the invite here',
      validateInput: (value) => (value.trim() === '' || value.trim().startsWith('near-ai-invite-v1.') ? undefined : 'This does not look like an invite. Paste the whole invite exactly as it was sent.')
    });
    if (pasted === undefined || pasted === '') return;
    const { prepareJoin, joinTeam } = await import('../../team/join');
    // G-61-4: a copy of the same project that is behind is brought up to date here, under one progress that says so. The pasted text is held
    // only in this call: Try again prepares again with it, and nothing is kept once the command ends (D-26).
    type Preparation = Awaited<ReturnType<typeof prepareJoin>>;
    let prepared: Preparation;
    for (;;) {
      prepared = await withSteps(JOIN_TEXT.title, false, (step) => prepareJoin({
        projectRoot, bundleText: pasted, onStep: (code) => { if (code === 'update') step(JOIN_TEXT.updateStep); }
      }));
      if (prepared.kind !== 'not-ready') break;
      if (!await notReady(prepared)) return;
    }
    if (prepared.kind === 'refused') {
      deps.report('error', await safe(prepared.message));
      return;
    }
    if (prepared.kind === 'clone-needed') {
      // A different project, or none is open. Nothing is kept: after the download the person opens it, chooses Join a team and pastes again.
      const choice = await teamPrompts.message('info', JOIN_TEXT.cloneNeeded, undefined, CLONE_ACTION);
      if (choice === CLONE_ACTION) await vscode.commands.executeCommand('git.clone', prepared.repoUrl);
      return;
    }
    if (prepared.updated === true) deps.report('info', JOIN_TEXT.updated);
    if (projectRoot === undefined) return;
    const { teamFile, bundle, near } = prepared;
    const teamName = await display(teamFile.name);
    let suggested = '';
    try {
      suggested = (await (await import('../../team/enable')).enableDefaults(projectRoot)).ownerName;
    } catch (error) {
      deps.output.appendLine(`The name from your git settings could not be read: ${await describe(error)}`);
    }
    const displayName = await ask({
      title: 'Join Team', prompt: 'Your name as teammates will see it', value: suggested,
      validateInput: (value) => (value.trim() === '' ? 'Enter a value to continue.' : undefined)
    });
    if (displayName === undefined) return;

    const nearBaseUrl = await baseUrl();
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Joining ${teamName}` }, (progress) => joinTeam({
      onStep: (code) => { progress.report({ message: JOIN_STEP_TEXT[code] }); },
      projectRoot, globalStorageDir: deps.context.globalStorageUri.fsPath, teamFile, bundle, ...(near === undefined ? {} : { near }),
      secrets: deps.context.secrets, displayName, nearBaseUrl, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      // Only a lead invited to a NEAR-linked team reaches the sign-in (D-22); only a team without NEAR reaches the key box (D-21).
      signIn: () => getTokens(teamFile.teamId),
      askInvitationLink: () => ask({
        title: 'Join Team', password: true, placeHolder: 'The link from the invitation email',
        prompt: 'NEAR AI found no invitation for the NEAR AI account you used. Paste the link from the email inviting you to the organization, or leave this empty to skip it.'
      }),
      pasteOwnKey: () => ask({
        title: 'Join Team', password: true, placeHolder: 'Your NEAR AI API key',
        prompt: 'This team has no organization linked, so your lead cannot send you a team key. Paste your own NEAR AI API key to start working, or leave this empty to add one later from the NEAR AI settings.'
      })
    }));

    if (!result.ok) {
      if (result.code === 'already-has-key') await offerReset(projectRoot, teamFile, result.message);
      else {
        if (result.detail !== undefined) deps.output.appendLine(`Join details: ${await safe(result.detail)}`);
        deps.report(result.code === 'offline' ? 'warn' : 'error', await safe(result.message));
      }
      return;
    }
    await deps.restartSession(projectRoot);
    let said = `You joined ${teamName} as ${article(result.role)}.`;
    if (result.pendingRole !== undefined) {
      said += result.key === 'awaiting-lead' ? ' Your lead confirms you and sends your team key.' : ` Your lead confirms you as ${article(result.pendingRole)}.`;
    } else if (result.key === 'awaiting-lead') {
      said += ' Your lead sends your team key.';
    } else if (result.key === 'installed') {
      said += ' Your team key is installed for this project.';
    }
    deps.report('info', said);
    if (result.nearInvitation === 'accepted') deps.report('info', 'You joined your organization, the account that pays for your team\'s AI.');
    else if (result.nearInvitation === 'already-member') deps.report('info', 'You are already in your organization.');
    for (const notice of result.notices) deps.report('info', await safe(notice));
  }

  // The unfinished-join reset (61-09): the old keys are removed only when the team list, freshly read, does not show this computer.
  async function offerReset(projectRoot: string, teamFile: TeamFile, message: string): Promise<void> {
    const session = deps.session();
    const read = session === undefined ? false : await session.sync();
    if (session === undefined || !read) {
      deps.report('warn', await safe(message));
      return;
    }
    if (session.memberId() !== undefined) {
      deps.report('info', 'This computer is already on the team, so there is nothing to join. If you need a new invite, ask your lead.');
      return;
    }
    const choice = await teamPrompts.message(
      'warn', 'An earlier Join on this computer did not finish, and the team list does not show this computer. Remove the unfinished keys, then ask your lead to re-issue your invitation?',
      { modal: true }, RESET_ACTION
    );
    if (choice !== RESET_ACTION) {
      deps.report('info', 'Nothing was changed.');
      return;
    }
    const { forgetDeviceIdentity } = await import('../../team/identity');
    await forgetDeviceIdentity(deps.context.secrets, teamFile.teamId);
    await deps.restartSession(projectRoot);
    deps.report('info', 'The unfinished keys were removed from this computer. Ask your lead to re-issue your invitation from "NEAR AI: Manage Team Members", then run "NEAR AI: Join Team" again with the new invite.');
  }

  // ---- Manage Team Members (D-11, D-16, D-17, D-18, D-25, D-27) ---------------------------------------------------------------------

  interface ManageContext { projectRoot: string; session: TeamSession; teamFile: TeamFile; checklist: CleanupChecklist; canManage: boolean }

  // The NEAR client an action needs. A linked team that is not signed in is asked to sign in first; `canContinue` also offers to carry on without
  // NEAR, leaving the NEAR step on the cleanup list. undefined means the person backed out.
  async function orgForAction(teamFile: TeamFile, text: string, canContinue: boolean): Promise<{ org?: NearOrgClient } | undefined> {
    if (teamFile.near === undefined) return {};
    const kept = await keptSession(teamFile.teamId);
    if (kept !== undefined) return { org: kept.org };
    const choice = await teamPrompts.message('info', text, { modal: true }, SIGN_IN_ACTION, ...(canContinue ? [CONTINUE_WITHOUT_NEAR_ACTION] : []));
    if (choice === undefined) return undefined;
    if (choice === CONTINUE_WITHOUT_NEAR_ACTION) return {};
    const signedIn = await signInAndKeep(teamFile.teamId);
    return signedIn === undefined ? undefined : { org: signedIn.org };
  }

  function allocationOf(ctx: ManageContext, memberId: string): string {
    return formatNanoUsd(ctx.session.state().members.get(memberId)?.allocationNanoUsd ?? 0);
  }

  async function stillToDo(name: string, items: CleanupItem[]): Promise<void> {
    const { repoAccessText } = await import('../../team/cleanupChecklist');
    const ordered = [...items.filter((item) => item.step !== 'repo-access'), ...items.filter((item) => item.step === 'repo-access')];
    if (ordered.length === 0) return;
    deps.output.appendLine(`Still to do for ${name}:`);
    for (const item of ordered) {
      deps.output.appendLine(item.step === 'repo-access'
        ? `- ${repoAccessText(name)}`
        : `- ${STEP_TEXT[item.step]} (${item.status}${item.lastError === undefined ? '' : `: ${await safe(item.lastError)}`})`);
    }
  }

  async function runMemberAction(ctx: ManageContext, memberId: string, action: MemberAction): Promise<void> {
    const { teamFile, checklist } = ctx;
    const member = ctx.session.state().members.get(memberId);
    if (member === undefined) {
      deps.report('info', 'That person is not in this team any more. Nothing was changed.');
      return;
    }
    const name = await display(member.name);
    const team = await display(teamFile.name);
    const log = ctx.session.currentLog();
    const keys = await import('../../team/keyDelivery');
    switch (action) {
      case 'confirm': {
        const chosen = await orgForAction(teamFile, `Confirming ${name} also sends their AI key, which needs your NEAR AI sign-in. Sign in now, or confirm now and send the key later from this list.`, true);
        if (chosen === undefined) return;
        const result = await withSteps(`Confirming ${name}`, false, (step) => keys.confirmMember({
          log, teamFile, memberId, checklist, ...(chosen.org === undefined ? {} : { org: chosen.org }), onStep: (code) => { step(DELIVERY_STEP_TEXT[code]); }
        }));
        if (!result.ok) {
          deps.report(result.code === 'not-pending' ? 'info' : 'error', await safe(result.message));
          return;
        }
        deps.output.appendLine(await safe(result.message));
        const role = ctx.session.state().members.get(memberId)?.role ?? member.role;
        const is = `${name} is now ${article(role)}.`;
        if (teamFile.near === undefined) deps.announce('info', `${is} ${(await import('../../team/join')).NO_ORG_NOTICE}`);
        else if (result.key === 'delivered') deps.announce('info', `${is} Their team key has a spend cap of ${allocationOf(ctx, memberId)} set by you.`);
        else deps.announce('warn', `${is} ${await safe(result.message)} Use Send key in "NEAR AI: Manage Team Members" when you are ready.`);
        return;
      }
      case 'deliver-key':
      case 'rotate-key': {
        const { signInToSendKeyText } = keys;
        const chosen = await orgForAction(teamFile, `${signInToSendKeyText(name)} This step uses your NEAR AI sign-in.`, false);
        if (chosen?.org === undefined) {
          deps.announce('info', signInToSendKeyText(name));
          return;
        }
        const org = chosen.org;
        // Not cancellable: a key that was made must be delivered or zeroed and revoked, and an old key must be zeroed before it is revoked.
        const result = await withSteps(action === 'deliver-key' ? `Sending ${name}'s team key` : `Replacing ${name}'s team key`, false, (step) => {
          const input = { log, teamFile, memberId, org, checklist, onStep: (code: keyof typeof DELIVERY_STEP_TEXT): void => { step(DELIVERY_STEP_TEXT[code]); } };
          return action === 'deliver-key' ? keys.deliverMemberKey(input) : keys.rotateMemberKey(input);
        });
        if (!result.ok) {
          deps.report('warn', await safe(result.message));
          return;
        }
        const cap = allocationOf(ctx, memberId);
        deps.report('info', action === 'deliver-key'
          ? `Sent ${name}'s team key. It has a spend cap of ${cap} set by you.`
          : `Replaced ${name}'s team key. The new key's spend cap is what was left of the old one, set by you.`);
        if (result.notice !== undefined) deps.report('info', await safe(result.notice));
        return;
      }
      case 'remove': {
        const detail = teamFile.near === undefined
          ? `${name} loses access to the team record. Afterwards, remove their access to the project on GitHub (or wherever the project is hosted) yourself.`
          : `${name}'s AI key is set to a limit of 0 first, then the team record removes them, then the key is revoked. Afterwards, remove their access to the project on GitHub (or wherever the project is hosted) yourself.`;
        const confirmed = await teamPrompts.message('warn', `Remove ${name} from ${team}?`, { modal: true, detail }, REMOVE_ACTION);
        if (confirmed !== REMOVE_ACTION) return;
        const chosen = await orgForAction(teamFile, `Removing ${name} also ends their AI key, which needs your NEAR AI sign-in. Sign in now, or remove them now and finish those steps later from this list.`, true);
        if (chosen === undefined) return;
        await finishRemoval(ctx, memberId, name, chosen.org, `Removing ${name} from ${team}`);
        return;
      }
    }
  }

  // Removing a joined member and cancelling an invitation are the same flow; the result is shown as written (it carries the warning and the manual step).
  async function finishRemoval(ctx: ManageContext, memberId: string, name: string, org: NearOrgClient | undefined, title: string): Promise<void> {
    const { removeMember } = await import('../../team/remove');
    // Cancellable: the flow stops only before anything changes, or after the log removal once every key left to revoke is capped at 0.
    const result = await withSteps(title, true, (step, token) => removeMember({
      log: ctx.session.currentLog(), teamFile: ctx.teamFile, memberId, checklist: ctx.checklist, ...(org === undefined ? {} : { org }),
      onStep: (code) => { step(REMOVE_STEP_TEXT[code]); }, stopRequested: () => token.isCancellationRequested
    }));
    if (!result.ok) {
      deps.report(result.code === 'stopped' ? 'info' : 'error', await safe(result.message));
      return;
    }
    deps.report(result.keyStillSpends ? 'warn' : 'info', await safe(result.message));
    await stillToDo(name, result.checklist);
    ctx.session.nudge();
  }

  async function cancelInvitation(ctx: ManageContext, memberId: string): Promise<void> {
    const member = ctx.session.state().members.get(memberId);
    if (member === undefined) return;
    const name = await display(member.name);
    // Only a lead's invitation went to NEAR, so only that cancel needs the sign-in.
    const needsNear = (member.pendingRole ?? member.role) === 'lead';
    // UI review issue 2: cancelling cannot be undone, so it is confirmed first, like Remove.
    const detail = `The invite code stops working at once and cannot be used again. To bring ${name} in later, invite them again.${needsNear && ctx.teamFile.near !== undefined ? ' Their invitation to your organization is cancelled too.' : ''}`;
    const confirmed = await teamPrompts.message('warn', `Cancel the invitation for ${name}?`, { modal: true, detail }, CANCEL_INVITATION_ACTION);
    if (confirmed !== CANCEL_INVITATION_ACTION) {
      deps.announce('info', `The invitation for ${name} was not changed.`);
      return;
    }
    const chosen = needsNear ? await orgForAction(ctx.teamFile, `Cancelling ${name}'s invitation also cancels their invitation to your organization, which needs your NEAR AI sign-in. Sign in now, or cancel now and finish that step later from this list.`, true) : {};
    if (chosen === undefined) return;
    await finishRemoval(ctx, memberId, name, chosen.org, `Cancelling the invitation for ${name}`);
  }

  async function reissue(ctx: ManageContext, memberId: string): Promise<void> {
    const member = ctx.session.state().members.get(memberId);
    if (member === undefined) return;
    const name = await display(member.name);
    const { readInviteDirectory, reissueInvite } = await import('../../team/invite');
    const entry = (await readInviteDirectory(ctx.session.storageDir())).find((candidate) => candidate.memberId === memberId);
    if (entry === undefined) {
      deps.report('info', `The email address for ${name}'s invitation is only known on the computer that sent the invitation, so it cannot be issued again from here. Cancel it and invite them again.`);
      return;
    }
    const ttlSeconds = await askLifetime();
    if (ttlSeconds === undefined) return;
    let org: NearOrgClient | undefined;
    if (ctx.teamFile.near !== undefined && (member.pendingRole ?? member.role) === 'lead') {
      const chosen = await orgForLeadInvite(ctx.teamFile.teamId, name);
      if (chosen === 'cancelled') return;
      org = chosen;
    }
    const result = await withSteps(`Issuing a new invitation for ${name}`, false, (step) => reissueInvite({
      projectRoot: ctx.projectRoot, globalStorageDir: deps.context.globalStorageUri.fsPath, teamFile: ctx.teamFile, log: ctx.session.currentLog(),
      oldMemberId: memberId, email: entry.email, ttlSeconds, ...(org === undefined ? {} : { org }), onStep: (code) => { step(INVITE_STEP_TEXT[code]); }
    }));
    if (!result.ok) {
      deps.report('error', await safe(result.message));
      return;
    }
    await presentBundle(name, result.bundle);
    if (result.notice !== undefined) deps.report('info', await safe(result.notice));
    ctx.session.nudge();
  }

  async function retryItem(ctx: ManageContext, item: CleanupItem): Promise<void> {
    const name = await display(item.memberName);
    const what = `${STEP_TEXT[item.step]} for ${name}`;
    if (item.step === 'deliver-key' || item.step === 'rotate-key') {
      await runMemberAction(ctx, item.memberId, item.step === 'deliver-key' ? 'deliver-key' : 'rotate-key');
      return;
    }
    if (item.step === 'send-invitation') {
      // CR-02: the log is checked before any sign-in or NEAR call; an invitation for someone removed, joined or re-invited is closed instead.
      const { retryNearInvitation } = await import('../../team/invite');
      const org = async (): Promise<NearOrgClient | undefined> => (await orgForAction(ctx.teamFile, `${what} needs your NEAR AI sign-in.`, false))?.org;
      const outcome = await withSteps(`Retrying: ${what}`, false, (step) => {
        step('Checking the team record, then sending the invitation to your organization');
        return retryNearInvitation({ item, teamFile: ctx.teamFile, log: ctx.session.currentLog(), checklist: ctx.checklist, org });
      });
      switch (outcome.outcome) {
        case 'sent':
          deps.report('info', `${name} was invited to your organization as an admin. They accept it when they join.`);
          return;
        case 'already-member':
          deps.report('info', `${name} is already in your organization.`);
          return;
        case 'closed':
          deps.report('info', `No invitation to your organization was sent to ${name}, and the item was closed. ${await safe(outcome.reason)}`);
          return;
        case 'failed':
          deps.report('warn', `The invitation to your organization for ${name} was not sent: ${await safe(outcome.reason)}`);
          return;
        case 'not-linked':
          deps.report('info', await safe(outcome.reason));
          return;
        case 'unknown-email':
          deps.report('info', `The email address for ${name} is only known on the computer that sent the invitation. Send the invitation to your organization from that computer, or from your organization's settings on the NEAR AI website.`);
          return;
        case 'needs-sign-in':
          deps.report('info', `${what} needs your NEAR AI sign-in. Nothing was changed.`);
          return;
      }
    }
    const chosen = await orgForAction(ctx.teamFile, `${what} needs your NEAR AI sign-in.`, false);
    if (chosen === undefined) return;
    const { retryCleanupItem } = await import('../../team/remove');
    const nearOrg = chosen.org;
    const updated = await withSteps(`Retrying: ${what}`, false, (step) => {
      step(`${STEP_TEXT[item.step]} with NEAR AI`);
      return retryCleanupItem({ item, teamFile: ctx.teamFile, log: ctx.session.currentLog(), checklist: ctx.checklist, ...(nearOrg === undefined ? {} : { org: nearOrg }) });
    });
    if (updated.status === 'done') deps.report('info', `Done: ${what}.`);
    else deps.report('warn', `${what} is not finished yet: ${await safe(updated.lastError ?? 'try again in a moment')}`);
  }

  type Row = vscode.QuickPickItem & {
    row: { kind: 'invite' } | { kind: 'near' } | { kind: 'member'; id: string; attention: string | undefined } | { kind: 'invitation'; id: string; status: string } | { kind: 'cleanup'; item: CleanupItem };
  };

  async function buildRows(ctx: ManageContext): Promise<Row[]> {
    const { invitationStatus, memberAttention } = await import('../../domain/team/invite');
    const state = ctx.session.state();
    const linked = ctx.teamFile.near !== undefined;
    const rows: Row[] = [];
    // The owner and leads invite more people from here, so inviting stays a button once the sidebar section is quiet (G-61-8).
    if (ctx.canManage) rows.push({ label: INVITE_ROW, row: { kind: 'invite' } });
    const kept = linked ? await keptSession(ctx.teamFile.teamId) : undefined;
    if (!linked) rows.push({ label: (await import('../../team/join')).NO_ORG_NOTICE, row: { kind: 'near' } });
    else rows.push({ label: kept === undefined ? 'NEAR AI sign-in: not signed in' : `NEAR AI sign-in: ${await display(kept.label)}`, row: { kind: 'near' } });

    const attention = new Map(memberAttention(state, linked).map((item) => [item.memberId, item.kind]));
    const suffix: Record<string, string> = { confirm: ', waiting for confirmation', 'deliver-key': ', key pending', 'rotate-key': ', key needs rotation' };
    for (const member of state.members.values()) {
      if (member.status === 'invited' || member.removedEvent !== undefined) continue;
      const kind = attention.get(member.id);
      rows.push({
        label: `${await display(member.name)}, ${member.pendingRole ?? member.role}${kind === undefined ? '' : suffix[kind] ?? ''}`,
        ...(member.allocationNanoUsd === undefined ? {} : { description: `Allocation ${formatNanoUsd(member.allocationNanoUsd)}` }),
        row: { kind: 'member', id: member.id, attention: kind }
      });
    }
    const now = Math.floor(Date.now() / 1000);
    for (const member of state.members.values()) {
      const status = invitationStatus(member, now);
      if (status === undefined) continue;
      rows.push({ label: `Invitation for ${await display(member.name)}, ${member.pendingRole ?? member.role}, ${status}`, row: { kind: 'invitation', id: member.id, status } });
    }
    let items: CleanupItem[] = [];
    try {
      items = (await ctx.checklist.list()).filter((item) => item.status !== 'done');
    } catch (error) {
      deps.report('warn', `The list of steps still to finish could not be read: ${await describe(error)}`);
    }
    const { repoAccessText } = await import('../../team/cleanupChecklist');
    for (const item of items) {
      const name = await display(item.memberName);
      rows.push(item.step === 'repo-access'
        ? { label: `Project access for ${name}`, detail: repoAccessText(name), row: { kind: 'cleanup', item } }
        : { label: `Still to finish: ${STEP_TEXT[item.step]} for ${name}`, description: `${item.status}${item.lastError === undefined ? '' : `: ${await safe(item.lastError)}`}`, row: { kind: 'cleanup', item } });
    }
    return rows;
  }

  async function actOnRow(ctx: ManageContext, picked: Row): Promise<void> {
    const { decideTeamAction } = await import('../../domain/team/permissions');
    const myId = ctx.session.memberId() as string;
    const state = ctx.session.state();
    const allowed = (action: Parameters<typeof decideTeamAction>[2]): boolean => decideTeamAction(state, myId, action).allowed;
    const row = picked.row;
    if (row.kind === 'invite') {
      await invite();
      return;
    }
    type Choice = vscode.QuickPickItem & { run(): Promise<void> };
    const choices: Choice[] = [];
    const add = (label: string, description: string, run: () => Promise<void>): void => { choices.push({ label, description, run }); };

    if (row.kind === 'near') {
      if (ctx.teamFile.near === undefined) {
        await linkFlow(ctx.projectRoot, true);
      } else {
        const kept = await keptSession(ctx.teamFile.teamId);
        if (kept === undefined) {
          const signedIn = await signInAndKeep(ctx.teamFile.teamId);
          if (signedIn !== undefined) deps.report('info', `Signed in to NEAR AI as ${await display(signedIn.label)}.`);
        } else {
          deps.announce('info', `You are signed in to NEAR AI as ${await display(kept.label)}. Run "NEAR AI: Sign Out of NEAR AI for This Team" to sign out.`);
        }
      }
      return;
    }
    if (row.kind === 'member') {
      const member = state.members.get(row.id);
      if (member === undefined) return;
      if (row.attention === 'confirm' && allowed({ kind: 'member.change-role', targetId: row.id, role: member.pendingRole ?? member.role })) add('Confirm', `Make them ${article(member.pendingRole ?? member.role)}`, () => runMemberAction(ctx, row.id, 'confirm'));
      if (row.attention === 'deliver-key' && allowed({ kind: 'member.key-deliver', targetId: row.id })) add('Send key', 'Create their team key and send it to their computer', () => runMemberAction(ctx, row.id, 'deliver-key'));
      if (row.attention === 'rotate-key' && allowed({ kind: 'member.key-deliver', targetId: row.id })) add('Rotate key', 'Replace their team key for their current devices', () => runMemberAction(ctx, row.id, 'rotate-key'));
      if (row.id !== myId && allowed({ kind: 'member.remove', targetId: row.id })) add('Remove', 'Take them off the team', () => runMemberAction(ctx, row.id, 'remove'));
    } else if (row.kind === 'invitation') {
      if (row.status === 'pending' || row.status === 'expired') {
        if (allowed({ kind: 'member.remove', targetId: row.id })) add(CANCEL_INVITATION_ACTION, 'Stop this invitation so its code no longer works', () => cancelInvitation(ctx, row.id));
        if (allowed({ kind: 'member.invite' })) add('Re-issue', 'Replace it with a new invite', () => reissue(ctx, row.id));
      }
    } else if (row.item.step === 'repo-access') {
      const item = row.item;
      add('Mark done', 'You removed their access to the project where it is hosted', async () => {
        const { repoAccessText } = await import('../../team/cleanupChecklist');
        await ctx.checklist.update(item.id, { status: 'done' });
        deps.report('info', `Marked done: ${repoAccessText(await display(item.memberName))}`);
      });
    } else {
      const item = row.item;
      add('Retry', 'Try this step again', () => retryItem(ctx, item));
    }

    if (choices.length === 0) {
      deps.announce('info', row.kind === 'invitation' ? `This invitation is ${row.status}, so there is nothing to do with it.` : 'There is nothing to do for this item right now.');
      return;
    }
    const chosen = await pick(choices, { title: 'Manage Team Members', placeHolder: picked.label });
    if (chosen !== undefined) await chosen.run();
  }

  async function manage(argument?: unknown): Promise<void> {
    const found = await requireTeam();
    if (found === undefined) return;
    const { projectRoot, session } = found;
    const { readTeamFile } = await import('../../team/teamFile');
    const { CleanupChecklist } = await import('../../team/cleanupChecklist');
    const { decideTeamAction } = await import('../../domain/team/permissions');
    const teamFile = await readTeamFile(projectRoot);
    if (teamFile === undefined) {
      deps.announce('info', deps.soloText);
      return;
    }
    const myId = session.memberId();
    const canManage = myId !== undefined && decideTeamAction(session.state(), myId, { kind: 'member.invite' }).allowed;
    const ctx: ManageContext = { projectRoot, session, teamFile, checklist: new CleanupChecklist(session.storageDir()), canManage };

    // The notification buttons of 61-12 pass {memberId, action}; anything else opens the list.
    const request = typeof argument === 'object' && argument !== null ? argument as { memberId?: unknown; action?: unknown } : undefined;
    if (request !== undefined && typeof request.memberId === 'string' && (MEMBER_ACTIONS as readonly unknown[]).includes(request.action)) {
      if (!canManage) {
        await requireManager(session, 'change the team');
        return;
      }
      await runMemberAction(ctx, request.memberId, request.action as MemberAction);
      session.nudge();
      return;
    }

    const rows = await buildRows(ctx);
    const picked = await pick(rows, { title: `Manage Team Members${canManage ? '' : ' (read only)'}`, placeHolder: 'Everyone on the team, invitations and organization steps still to finish' });
    if (picked === undefined) return;
    if (!canManage) {
      deps.announce('info', READ_ONLY_TEXT);
      return;
    }
    await actOnRow(ctx, picked);
    session.nudge();
  }

  return [
    vscode.commands.registerCommand(INVITE_COMMAND, guarded('Invite to Team', invite)),
    vscode.commands.registerCommand(JOIN_COMMAND, guarded('Join Team', join)),
    vscode.commands.registerCommand(MANAGE_MEMBERS_COMMAND, guarded('Manage Team Members', manage)),
    vscode.commands.registerCommand(LINK_NEAR_COMMAND, guarded('Link Your Organization', linkCommand)),
    vscode.commands.registerCommand(SIGN_OUT_NEAR_COMMAND, guarded('Sign Out of NEAR AI for This Team', signOutCommand))
  ];
}
