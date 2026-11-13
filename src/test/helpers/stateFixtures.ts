// Shared by the state tests: a temporary project folder, a SecretStorage stand-in and real git, so ignore rules are proven with git itself.
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function tempProject(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'near-ai-state-'));
}

/** One editor's SecretStorage. Two instances stand for two editors (or a browser and a desktop) that share nothing but the project folder. */
export class MemorySecrets {
  public readonly values = new Map<string, string>();
  public get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
  public store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  public delete(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1'
};

export function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8' });
}

export function gitInit(dir: string): void {
  git(dir, ['init', '-q']);
}

/** `git status --porcelain`, so an empty string means nothing is staged, modified or untracked. */
export function gitStatus(dir: string): string {
  return git(dir, ['status', '--porcelain']);
}
