// Bringing an existing copy of the team's project up to date before a join (G-61-4). The invitee may already have the project open from
// before Team Mode was turned on; findSameProjectRemote decides whether the open copy is the invite's project by comparing the addresses of
// the remotes configured in this copy with the invite's address, and catchUpCopy fetches and fast-forwards the current branch only when no
// work can be lost. The invite bundle is hostile text (WR-03): its address only picks among remotes this copy already has, and git is only
// ever told a remote name. This module never imports vscode and holds no people-facing words: only codes and redacted technical details.
import type { GitRunner } from './runGit';

export type CatchUpReason = 'local-changes' | 'unshared-work' | 'other-version' | 'not-shared' | 'offline';

export type CatchUpResult = { ok: true; updated: boolean; branch: string } | { ok: false; reason: CatchUpReason; detail?: string };

export function projectAddressKey(_url: string): string | undefined {
  throw new Error('not implemented');
}

export async function findSameProjectRemote(_projectRoot: string, _bundleRepo: string, _git?: GitRunner): Promise<string | undefined> {
  throw new Error('not implemented');
}

export async function catchUpCopy(_input: { projectRoot: string; remote: string; teamId: string; git?: GitRunner }): Promise<CatchUpResult> {
  throw new Error('not implemented');
}
