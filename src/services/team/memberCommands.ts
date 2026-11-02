// The membership commands (TEAM-02, TEAM-03): Invite to Team, Join Team, Manage Team Members, Link Team to NEAR Organization and Sign Out of NEAR (Team).
// Each is a thin adapter: it asks plain questions, calls the vscode-free flows in src/team, and says what happened and what to do next. Nothing here
// logs, stores or shows a code, key, token or repository address: the invite bundle appears once in a modal and on the clipboard when the lead
// chooses Copy, and pasted bundles and keys go through password inputs.
// Solo activation stays one fs.stat, so this module imports only vscode, Node built-ins and types; every team module is loaded with a dynamic import
// inside a handler (the teamCommands.ts header rule).
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Role, TeamFile } from '../../domain/team/types';
import type { FetchLike, SessionTokens } from '../reportingSignIn';
import type { TeamSession } from './teamSession';

export const INVITE_COMMAND = 'nearAi.team.invite';
// Kept separate from the copies in teamSession.ts so a solo project never loads the session module; teamManifest.test.ts pins them equal.
export const JOIN_COMMAND = 'nearAi.team.join';
export const MANAGE_MEMBERS_COMMAND = 'nearAi.team.manageMembers';
export const LINK_NEAR_COMMAND = 'nearAi.team.linkNearOrganization';
export const SIGN_OUT_NEAR_COMMAND = 'nearAi.team.signOutNear';

const COPY_ACTION = 'Copy';
const PUSH_ACTION = 'Push';
const LINK_CHOICE = 'Link a NEAR organization';
const SKIP_CHOICE = 'Skip';
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
  output: { appendLine(line: string): void };
  // Shows a message and keeps it in the NEAR AI Team channel.
  report(level: Level, message: string): void;
  // Shows a message only. A project without a team uses this, so it never creates the channel.
  announce(level: Level, message: string): void;
  soloText: string;
  firstFolder(): string | undefined;
  session(): TeamSession | undefined;
  startSession(projectRoot: string): Promise<'solo' | 'team' | 'error'>;
  restartSession(projectRoot: string): Promise<void>;
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
    const answer = await vscode.window.showInputBox({ ignoreFocusOut: true, ...options });
    return answer === undefined ? undefined : answer.trim();
  }

  async function pick<T extends vscode.QuickPickItem>(items: T[], options: { title: string; placeHolder: string }): Promise<T | undefined> {
    return vscode.window.showQuickPick(items, { ignoreFocusOut: true, ...options });
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

  async function currentBranch(projectRoot: string): Promise<string | undefined> {
    const { gitText, runGit } = await import('../../team/runGit');
    const result = await runGit(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: projectRoot, timeoutMs: 30_000 });
    const branch = result.code === 0 ? gitText(result) : '';
    return branch === '' ? undefined : branch;
  }

  async function pushBranch(projectRoot: string, remote: string, branch: string | undefined): Promise<void> {
    const target = branch ?? await currentBranch(projectRoot);
    if (target === undefined) {
      deps.report('error', 'There is no current branch to push. Check out your project branch and push it with git.');
      return;
    }
    const { pushCodeBranch } = await import('../../team/enable');
    const pushed = await pushCodeBranch(projectRoot, remote, target);
    if (pushed.ok) deps.report('info', `Pushed ${target} to ${remote}.`);
    else deps.report('error', await safe(pushed.message));
  }

  // Shows a message with Push without waiting for the answer, so the flow that follows is not held up by a notification nobody clicks.
  function offerPush(message: string, projectRoot: string, remote: string, branch?: string): void {
    deps.output.appendLine(message);
    Promise.resolve(vscode.window.showWarningMessage(message, PUSH_ACTION))
      .then((choice) => (choice === PUSH_ACTION ? pushBranch(projectRoot, remote, branch) : undefined))
      .catch((error: unknown) => { deps.output.appendLine(`The push could not run: ${error instanceof Error ? error.message : String(error)}`); });
  }

  // ---- linking a NEAR organization (Task 2 fills this in) ---------------------------------------------------------------------------

  async function linkFlow(_projectRoot: string, _session: TeamSession): Promise<boolean> {
    return false;
  }

  // ---- Invite to Team ----------------------------------------------------------------------------------------------------------------

  async function invite(): Promise<void> {
    const found = await requireTeam();
    if (found === undefined) return;
    const { projectRoot } = found;
    let session = found.session;
    const { decideTeamAction } = await import('../../domain/team/permissions');
    const { validateName } = await import('../../domain/team/validate');
    const { readTeamFile } = await import('../../team/teamFile');

    const myId = session.memberId();
    if (myId === undefined) {
      deps.report('info', 'This computer is not a member of the team yet, so it cannot invite anyone. Run "NEAR AI: Join Team" with the invite your lead sent you.');
      return;
    }
    if (!decideTeamAction(session.state(), myId, { kind: 'member.invite' }).allowed) {
      const role = session.state().members.get(myId)?.role ?? 'member';
      deps.report('info', `Only the owner or a lead can invite people. Your role in this team is ${role}.`);
      return;
    }

    const name = await ask({
      title: 'Invite to Team', prompt: 'Name of the person you are inviting.', placeHolder: 'Their name',
      validateInput: (value) => (validateName(value.trim(), 'name') === undefined ? undefined : 'Enter a name of 1 to 80 characters on one line.')
    });
    if (name === undefined) return;
    const email = await ask({
      title: 'Invite to Team', prompt: 'Their email address. The team log stores only a salted hash of it.', placeHolder: 'name@example.com',
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
    const { INVITE_TTL_CHOICES, DEFAULT_INVITE_TTL_SECONDS } = await import('../../domain/team/invite');
    const lifetimes = [...INVITE_TTL_CHOICES].sort((left, right) => (left === DEFAULT_INVITE_TTL_SECONDS ? -1 : right === DEFAULT_INVITE_TTL_SECONDS ? 1 : left - right))
      .map((ttlSeconds) => ({ label: ttlSeconds === 86_400 ? '24 hours' : `${ttlSeconds / 86_400} days`, description: ttlSeconds === DEFAULT_INVITE_TTL_SECONDS ? 'Recommended' : '', ttlSeconds }));
    const lifetime = await pick(lifetimes, { title: 'Invite to Team', placeHolder: 'How long the invite works before it expires' });
    if (lifetime === undefined) return;

    // D-03: a team with no NEAR organization is offered the link once per invite, and Skip is said out loud.
    let teamFile: TeamFile | undefined = await readTeamFile(projectRoot);
    if (teamFile === undefined) {
      deps.report('error', 'This project has no team file any more, so no invite was made. Nothing was changed.');
      return;
    }
    if (teamFile.near === undefined) {
      const choice = await pick([
        { label: LINK_CHOICE, description: 'Sign in to NEAR and pick the organization that pays for the team' },
        { label: SKIP_CHOICE, description: 'Invite without one' }
      ], { title: 'Invite to Team', placeHolder: 'This team has no NEAR organization linked yet' });
      if (choice === undefined) return;
      if (choice.label === LINK_CHOICE) {
        if (!await linkFlow(projectRoot, session)) {
          deps.report('info', 'The NEAR organization was not linked, so no invite was made. Nothing was changed.');
          return;
        }
        session = deps.session() ?? session;
        teamFile = await readTeamFile(projectRoot) ?? teamFile;
      } else {
        deps.report('info', (await import('../../team/join')).NO_ORG_NOTICE);
      }
    }

    const result = await (await import('../../team/invite')).inviteMember({
      projectRoot, globalStorageDir: deps.context.globalStorageUri.fsPath, teamFile, log: session.currentLog(),
      name, email, role: roleChoice.role, allocationNanoUsd, ttlSeconds: lifetime.ttlSeconds
    });
    if (!result.ok) {
      deps.report('error', await safe(result.message));
      return;
    }
    const shownName = await display(name);
    const copied = await vscode.window.showInformationMessage(
      `Invite ready for ${shownName}. Send them this invite; it works once and is not shown again.`,
      { modal: true, detail: result.bundle }, COPY_ACTION
    );
    if (copied === COPY_ACTION) {
      await vscode.env.clipboard.writeText(result.bundle);
      deps.announce('info', `Invite for ${shownName} copied. Send it to them in a private message.`);
    } else {
      deps.announce('info', `The invite for ${shownName} was not copied. You can issue it again from "NEAR AI: Manage Team Members".`);
    }
    if (result.notice !== undefined) deps.report('info', await safe(result.notice));
    session.nudge();
  }

  // ---- the other commands (Tasks 2 and 3) ----------------------------------------------------------------------------------------------

  async function join(): Promise<void> {
    deps.announce('info', deps.soloText);
  }

  async function placeholder(): Promise<void> {
    await requireTeam();
  }

  return [
    vscode.commands.registerCommand(INVITE_COMMAND, guarded('Invite to Team', invite)),
    vscode.commands.registerCommand(JOIN_COMMAND, guarded('Join Team', join)),
    vscode.commands.registerCommand(MANAGE_MEMBERS_COMMAND, guarded('Manage Team Members', placeholder)),
    vscode.commands.registerCommand(LINK_NEAR_COMMAND, guarded('Link Team to NEAR Organization', placeholder)),
    vscode.commands.registerCommand(SIGN_OUT_NEAR_COMMAND, guarded('Sign Out of NEAR (Team)', placeholder))
  ];
}
