import { AuthMode } from '../domain/config';
import { ProjectCredentialScope, isProjectCredentialScope } from '../domain/auth';

export const API_KEY_SECRET = 'nearAi.apiKey';
export const REFRESH_TOKEN_SECRET = 'nearAi.refreshToken';
export const SCOPED_SECRET_VERSION = 2 as const;

export interface SecretStorageLike {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): Thenable<void> | Promise<void>;
  delete(key: string): Thenable<void> | Promise<void>;
}

export type AuthStatus = 'not-configured' | 'configured' | 'pending-near-sign-in';

export interface AuthSnapshot {
  mode: AuthMode;
  status: AuthStatus;
}

export class AuthService {
  public constructor(private readonly secrets: SecretStorageLike) {}

  public async getSnapshot(mode: AuthMode): Promise<AuthSnapshot> {
    if (mode === 'nearAccount') {
      const refreshToken = await this.secrets.get(REFRESH_TOKEN_SECRET);
      return { mode, status: refreshToken ? 'configured' : 'pending-near-sign-in' };
    }
    const apiKey = await this.secrets.get(API_KEY_SECRET);
    return { mode, status: apiKey ? 'configured' : 'not-configured' };
  }

  public async saveApiKey(apiKey: string): Promise<void> {
    const normalized = apiKey.trim();
    if (!normalized) throw new Error('An API key is required.');
    await this.secrets.store(API_KEY_SECRET, normalized);
  }

  public async getApiKey(): Promise<string | undefined> {
    return this.secrets.get(API_KEY_SECRET);
  }

  public async removeApiKey(): Promise<void> {
    await this.secrets.delete(API_KEY_SECRET);
  }

  public async saveScopedApiKey(scope: ProjectCredentialScope, apiKey: string): Promise<void> {
    this.assertScope(scope);
    const normalized = apiKey.trim();
    if (!normalized) throw new Error('An API key is required.');
    await this.secrets.store(scopedSecret(scope, 'api-key'), normalized);
  }

  public async getScopedApiKey(scope: ProjectCredentialScope): Promise<string | undefined> {
    this.assertScope(scope);
    return this.secrets.get(scopedSecret(scope, 'api-key'));
  }

  public async removeScopedApiKey(scope: ProjectCredentialScope): Promise<void> {
    this.assertScope(scope);
    await this.secrets.delete(scopedSecret(scope, 'api-key'));
  }

  public async saveScopedRefreshToken(scope: ProjectCredentialScope, refreshToken: string): Promise<void> {
    this.assertScope(scope);
    const normalized = refreshToken.trim();
    if (!normalized) throw new Error('A refresh token is required.');
    await this.secrets.store(scopedSecret(scope, 'refresh-token'), normalized);
  }

  public async getScopedRefreshToken(scope: ProjectCredentialScope): Promise<string | undefined> {
    this.assertScope(scope);
    return this.secrets.get(scopedSecret(scope, 'refresh-token'));
  }

  public async removeScopedRefreshToken(scope: ProjectCredentialScope): Promise<void> {
    this.assertScope(scope);
    await this.secrets.delete(scopedSecret(scope, 'refresh-token'));
  }

  public async removeScopedCredentials(scope: ProjectCredentialScope): Promise<void> {
    await this.removeScopedApiKey(scope);
    await this.removeScopedRefreshToken(scope);
  }

  /**
   * Legacy credentials are readable only by an explicit migration action. The
   * normal provider path never calls this method.
   */
  public async importLegacyCredentials(scope: ProjectCredentialScope, confirmed: boolean): Promise<{ apiKeyImported: boolean; refreshTokenImported: boolean }> {
    this.assertScope(scope);
    if (!confirmed) throw new Error('Explicit confirmation is required to import legacy credentials.');
    const apiKey = await this.secrets.get(API_KEY_SECRET);
    const refreshToken = await this.secrets.get(REFRESH_TOKEN_SECRET);
    if (apiKey) await this.saveScopedApiKey(scope, apiKey);
    if (refreshToken) await this.saveScopedRefreshToken(scope, refreshToken);
    return { apiKeyImported: Boolean(apiKey), refreshTokenImported: Boolean(refreshToken) };
  }

  private assertScope(scope: ProjectCredentialScope): void {
    if (!isProjectCredentialScope(scope)) throw new Error('A valid project and stable profile scope is required.');
  }
}

export function scopedSecret(scope: ProjectCredentialScope, kind: 'api-key' | 'refresh-token'): string {
  if (!isProjectCredentialScope(scope)) throw new Error('A valid project and stable profile scope is required.');
  return `nearAi.v${SCOPED_SECRET_VERSION}.${scope.projectId}.${scope.profileId}.${kind}`;
}
