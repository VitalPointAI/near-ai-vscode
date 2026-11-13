// "Put this project's code online" (D-14, G-27-6b): the person's own code is pushed to the project's online home whenever they choose, not only at the end of
// the setup. It is the same checked step the setup offers (pushProjectCode: every file listed, secret names and contents blocked, the history scan, NEAR AI's
// own records held back, the person's click on the summary, their own git identity, never forced), run against the project's saved remote. After a pushed
// result the default branch is looked at (plan 27-20), never before. Nothing but the person's current branch is pushed. The GitHub token, when there is one,
// is held in memory and reaches git only through the child environment. No vscode here: the command lives in onlineHomeVscode.ts.
import { redactSecrets } from '../domain/redaction';
import type { Visibility } from '../domain/state/onlineHome';
import { GitHubApiError, getRepo } from './githubApi';
import type { FetchLike } from './githubApi';
import { pushProjectCode, runPersonGit } from './codePushCheck';
import type { CodePushStatus, CodePushUi } from './codePushCheck';
import { defaultBranchAfterPush, readProgress, withGitHubAuth } from './onlineHome';
import type { GhCli, GitHubAuth } from './onlineHome';
import { gitText, redactGitMessage, runStateGit } from './stateGit';
import type { GitRunner } from './stateGit';
import { stateHomeFor } from './stateHome';
import type { ProjectStateHome } from './stateHome';
import { resolveRemote } from './syncFlows';

export const NO_ONLINE_HOME = 'This project has no online home yet, so there is nowhere to put its code. Run "NEAR AI: Give This Project an Online Home" first.';
const NOT_CHOSEN = 'Your code was not pushed because no online repository was chosen.';

export interface CodePushLaterInput {
  root: string;
  home?: ProjectStateHome;
  /** The code-push dialogs. The question "push at all?" is not asked: running the command is the person's choice. */
  ui: CodePushUi;
  auth: GitHubAuth;
  gh?: GhCli;
  /** The person's own runner (their hooks and git settings apply). Defaults to a plain git runner. */
  personGit?: GitRunner;
  /** The runner for reading the project's remotes. Defaults to the sync runner. */
  git?: GitRunner;
  fetchFn?: FetchLike;
  /** Several remotes and no origin: which one to use. */
  pickRemote?: (names: string[]) => Promise<string | undefined>;
}

export type CodePushLaterStatus = CodePushStatus | 'no-home' | 'cancelled';
export interface CodePushLaterResult { status: CodePushLaterStatus; message: string }

function clean(text: string): string {
  return redactSecrets(redactGitMessage(text));
}

/** The GitHub account and name in an address of the form https://github.com/<owner>/<name>(.git), or undefined for any other address. */
function githubAddress(url: string): { owner: string; name: string } | undefined {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(url);
  return match ? { owner: match[1] as string, name: match[2] as string } : undefined;
}

/**
 * Puts the person's code online through the checked step. The remote is the stored sync remote, origin, the only one, or the person's pick. Whether a
 * GitHub token is used follows the way the project's online home was set up: a pasted address never involves one, so nothing is sent to GitHub's API and the
 * person's own credentials do the push.
 */
export async function pushCodeLaterFlow(input: CodePushLaterInput): Promise<CodePushLaterResult> {
  const { root, ui } = input;
  const tell = (text: string): void => ui.message(clean(text));
  const finish = (status: CodePushLaterStatus, message: string): CodePushLaterResult => { tell(message); return { status, message: clean(message) }; };
  const base = input.git ?? runStateGit;
  const home = input.home ?? stateHomeFor(root);

  const found = await resolveRemote({ root, home, git: base }, { pickRemote: input.pickRemote ?? (() => Promise.resolve(undefined)) });
  if (found.kind === 'none') return finish('no-home', NO_ONLINE_HOME);
  if (found.kind === 'cancelled') return finish('cancelled', NOT_CHOSEN);
  const remote = found.name;

  // The repository: what the setup saved when its address is this remote's, otherwise what the address itself says.
  const addressRead = await base(['-C', root, 'config', '--get', `remote.${remote}.url`]);
  const address = addressRead.code === 0 ? gitText(addressRead) : '';
  const saved = await readProgress(home);
  const known = saved?.repo !== undefined && saved.repo.url === address ? saved : undefined;
  const parsed = known?.repo ?? githubAddress(address);
  const owner = parsed?.owner ?? '';
  const name = parsed?.name ?? '';
  const gitHubRepo = owner !== '' && name !== '' && githubAddress(address) !== undefined;

  // A token only for a GitHub address that was not set up by pasting it. This is the person's click, so a sign-in may be asked.
  let token: string | undefined;
  if (gitHubRepo && known?.method !== 'url') {
    if (known?.method === 'gh' || !(await input.auth.available())) {
      if (input.gh !== undefined && await input.gh.available()) token = await input.gh.token();
    } else {
      token = await input.auth.token();
    }
  }

  let visibility: Visibility | 'unknown' = known?.repo?.visibility ?? 'unknown';
  if (visibility === 'unknown' && token !== undefined && gitHubRepo) {
    try { visibility = (await getRepo(token, owner, name, input.fetchFn))?.visibility ?? 'unknown'; } catch (error) {
      if (!(error instanceof GitHubApiError)) throw error;
    }
  }

  const personGit = input.personGit ?? runPersonGit;
  const codeGit = token === undefined ? personGit : withGitHubAuth(personGit, token);
  const pushed = await pushProjectCode(root, remote, codeGit, { ui, visibility });
  let message = pushed.message;
  // The default branch is looked at only after the person's own code reached the repository, never before and never for any other outcome.
  if (pushed.status === 'pushed') {
    const sentence = await defaultBranchAfterPush({ root, remote, git: codeGit, token, owner, name, fetchFn: input.fetchFn });
    if (sentence !== undefined) message = `${message} ${sentence}`;
  }
  return finish(pushed.status, message);
}
