// Where a person's reusable teams live (owner, 2026-11-06): "when I make a change to my agent teams in team studio, do they persist if I uninstall the
// extension or subsequently install the extension in another vscode instance?"
//
// Before this, they did not. A team was written under the extension's global storage, and uninstalling the extension (or installing it in another VS Code,
// or on another computer) leaves that folder behind or starts a new one empty. Teams are a person's work, not a cache, so they now live in a folder of
// their own under the home directory, which an uninstall never touches and which a person can copy, back up or keep in their own git repository.
//
// One-time move: teams already saved under the old extension storage are copied to the new folder on first use (copied, never moved, so a failed copy
// leaves the old ones in place).
import * as os from 'node:os';
import * as path from 'node:path';

/** An absolute folder to use instead of the default (tests and unusual setups). */
export const TEAMS_HOME_ENV = 'NEAR_AI_TEAMS_DIR';
export const TEAMS_FOLDER_NAME = '.near-ai-teams';

/**
 * The parent folder a person's teams are kept in. `NEAR_AI_TEAMS_DIR` wins when it holds an absolute path, so tests and a person with an unusual home
 * folder can place it deliberately; otherwise it is `<home>/.near-ai-teams`. TeamLibrary appends `teams` to this, so teams end up in
 * `<home>/.near-ai-teams/teams`.
 */
export function teamsDirectory(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const chosen = env[TEAMS_HOME_ENV]?.trim();
  if (chosen !== undefined && chosen !== '' && path.isAbsolute(chosen)) return chosen;
  return path.join(home, TEAMS_FOLDER_NAME);
}

/** The folder the extension used before teams moved (its global storage), where an upgrade may still find teams. */
export function legacyTeamsDirectory(globalStorageDir: string): string {
  return path.join(globalStorageDir, 'teams');
}

/** Whether two paths name the same folder, so a trailing slash or a relative segment does not make one folder look like two. */
export function sameFolder(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/** The folder a person's teams are kept in, as TeamLibrary wants it, given their home folder and the extension's global storage. */
export function teamLibraryDir(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return teamsDirectory(home, env);
}

/** The person's home folder, from the environment (VS Code sets HOME on Linux and macOS, USERPROFILE on Windows). */
export function homeFolder(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME ?? env.USERPROFILE ?? os.homedir();
}
