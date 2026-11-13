// The separate offer to put the person's own code on their new online repository (D-14, SYNC-09). Before anything goes up it lists every file that
// would be pushed and blocks likely secrets (secret file names, and content that looks like a key). Skeleton: behaviour is added test-first.
import type { Visibility } from '../domain/state/onlineHome';
import type { GitRunner } from './stateGit';

export interface CodePushBlock { file: string; reason: string; tracked?: boolean }
export interface CodePushPlan { files: string[]; blocked: CodePushBlock[] }
export interface CodePushSummary { branch: string; remote: string; visibility: Visibility | 'unknown'; files: string[]; notes: string[] }

export interface CodePushUi {
  message(text: string): void;
  confirmPush(summary: CodePushSummary): Promise<boolean>;
  confirmIgnore(files: string[]): Promise<boolean>;
  askIdentity(): Promise<{ name: string; email: string } | undefined>;
}

export type CodePushStatus = 'pushed' | 'declined' | 'blocked' | 'failed' | 'nothing';
export interface CodePushResult { status: CodePushStatus; message: string }
export interface CodePushOptions { ui: CodePushUi; visibility: Visibility | 'unknown' }

export function isSecretFileName(file: string): boolean {
  void file;
  throw new Error('not implemented');
}

export function planCodePush(root: string, git: GitRunner): Promise<CodePushPlan> {
  void root; void git;
  return Promise.reject(new Error('not implemented'));
}

export function pushProjectCode(root: string, remote: string, git: GitRunner, options: CodePushOptions): Promise<CodePushResult> {
  void root; void remote; void git; void options;
  return Promise.reject(new Error('not implemented'));
}
