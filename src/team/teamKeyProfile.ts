// Stub for the RED commit: the interface exists, the behaviour does not yet.
import type { SecretStorageLike } from '../services/auth';
import type { FetchLike } from '../services/reportingSignIn';

export function teamProfileId(_teamId: string): string { throw new Error('not implemented'); }
export type TeamKeyInstallResult = { ok: true; profileId: string; capped: boolean } | { ok: false; code: 'invalid' | 'wrong-organization' | 'wrong-workspace' | 'unavailable'; message: string };
export interface InstallTeamKeyInput { projectRoot: string; globalStorageDir: string; teamId: string; teamName: string; secrets: SecretStorageLike; apiKey: Buffer; baseUrl: string; expect?: { organizationId: string; workspaceId: string }; keyId?: string; fetch?: FetchLike; sleep?: (ms: number) => Promise<void>; attempts?: number }
export async function installTeamKey(_input: InstallTeamKeyInput): Promise<TeamKeyInstallResult> { throw new Error('not implemented'); }
export async function readInstalledKey(_globalStorageDir: string, _teamId: string): Promise<{ keyId?: string; previousProfileId?: string } | undefined> { throw new Error('not implemented'); }
export async function removeTeamKey(_input: { projectRoot: string; globalStorageDir: string; teamId: string; secrets: SecretStorageLike }): Promise<{ restoredProfileId?: string }> { throw new Error('not implemented'); }
