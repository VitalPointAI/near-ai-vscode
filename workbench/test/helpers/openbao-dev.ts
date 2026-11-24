// A dev-mode OpenBao for the container suite (46-02; 46-03 and 46-08 reuse it on their own networks, 46-07 adds keys with createPersonKeys).
// The image reference is read from the openbao-test FROM line of workbench/Dockerfile, so the tests run the pinned image the fit check sees
// (D-29). It starts in dev mode (in memory, unsealed) with a random root token and 512 MiB, mounts kv (version 2) and transit, enables jwt auth
// with the public key of a test signer (no Keycloak), and writes the policies and the two roles the Phase 47 contract names: the ordinary
// sterling-workbench role (KV, data keys, token self paths) and the step-up role that alone may sign (46-07). These policies are test
// fixtures that mirror the contract; Phase 47 owns the real ones. stop() removes only this helper's own container.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { containerName, freePort, run, runContainer, workbenchRoot } from './docker';
import { makeTestSigner, type TestSigner } from './test-jwt';

/** The audience the test role is bound to; test JWTs carry it as aud. */
export const TEST_AUDIENCE = 'sterling-workbench-test';

/** The Phase 47 contract paths (46-CONTEXT interface table), templated on the entity id. */
export const STERLING_POLICY = `
path "kv/data/users/{{identity.entity.id}}/*" { capabilities = ["create", "read", "update", "delete", "list"] }
path "kv/metadata/users/{{identity.entity.id}}/*" { capabilities = ["create", "read", "update", "delete", "list"] }
path "transit/datakey/wrapped/kek-{{identity.entity.id}}" { capabilities = ["update"] }
path "transit/decrypt/kek-{{identity.entity.id}}" { capabilities = ["update"] }
path "auth/token/renew-self" { capabilities = ["update"] }
path "auth/token/revoke-self" { capabilities = ["update"] }
path "auth/token/lookup-self" { capabilities = ["read"] }
`;

/** The acr the test step-up role is bound to; a test JWT carrying it stands for a fresh passkey or security key sign-in. */
export const TEST_STEPUP_ACR = 'urn:sterling:test:acr:phishing-resistant';

/**
 * The step-up role's policy (46-07, mirroring the Phase 47 contract in 47-07): signing only, and only with a token from the role whose bound
 * claims require the step-up acr. The ordinary sterling-workbench token above cannot sign.
 */
export const STERLING_STEPUP_POLICY = `
path "transit/sign/person-{{identity.entity.id}}" { capabilities = ["update"] }
path "auth/token/revoke-self" { capabilities = ["update"] }
path "auth/token/lookup-self" { capabilities = ["read"] }
`;

export interface DevOpenBao {
  /** The address from the host: http to 127.0.0.1 (the loopback rule). */
  readonly addr: string;
  /** The address from another container on the given network, for example http://openbao-1:8200. */
  readonly networkAddr: string | undefined;
  readonly rootToken: string;
  /** Signs JWTs that the jwt auth accepts (aud TEST_AUDIENCE). */
  readonly signer: TestSigner;
  readonly name: string;
  /** Creates the person's non-exportable keys, person-<id> (ed25519) and kek-<id> (aes256-gcm96), with the root token. */
  createPersonKeys(entityId: string): Promise<void>;
  /** A root-token call, for test setup and checks. */
  api(method: string, apiPath: string, body?: unknown, token?: string): Promise<{ status: number; json: unknown }>;
  stop(): Promise<void>;
}

/** The pinned image reference from the openbao-test stage of workbench/Dockerfile. */
export function openBaoTestImage(): string {
  const dockerfile = readFileSync(path.join(workbenchRoot, 'Dockerfile'), 'utf8');
  const match = /^FROM (\S+@sha256:[0-9a-f]{64}) AS openbao-test$/m.exec(dockerfile);
  assert.ok(match, 'workbench/Dockerfile has a digest-pinned openbao-test stage');
  return match[1];
}

let count = 0;

export async function startDevOpenBao(options: { tokenTtl?: string; tokenMaxTtl?: string; network?: string } = {}): Promise<DevOpenBao> {
  const rootToken = `root-${randomBytes(12).toString('hex')}`;
  const short = `bao-${++count}`;
  const name = containerName(short);
  const alias = `openbao-${count}`;
  const port = await freePort();
  const started = await runContainer(short, ['-d', '--memory=512m', '-p', `127.0.0.1:${port}:8200`,
    '-e', `BAO_DEV_ROOT_TOKEN_ID=${rootToken}`, '-e', 'BAO_DEV_LISTEN_ADDRESS=0.0.0.0:8200', '-e', 'SKIP_SETCAP=true',
    openBaoTestImage(), 'server', '-dev']);
  assert.equal(started.code, 0, `the dev OpenBao did not start: ${started.stderr.slice(-2000)}`);
  // On a given network (an --internal one, for example) the workbench reaches it by alias; setup and checks still use the published port.
  if (options.network) {
    const joined = await run('docker', ['network', 'connect', '--alias', alias, options.network, name]);
    assert.equal(joined.code, 0, `the dev OpenBao could not join ${options.network}: ${joined.stderr}`);
  }

  const api = async (method: string, apiPath: string, body?: unknown, token = rootToken): Promise<{ status: number; json: unknown }> => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/${apiPath}`, {
      method,
      headers: { 'X-Vault-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) as unknown : undefined };
  };

  const deadline = Date.now() + 60_000;
  for (;;) {
    const health = await fetch(`http://127.0.0.1:${port}/v1/sys/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.status, () => 0);
    if (health === 200) break;
    if (Date.now() > deadline) {
      const logs = await run('docker', ['logs', name]);
      assert.fail(`the dev OpenBao did not become healthy within 60 s\n${logs.stdout.slice(-2000)}\n${logs.stderr.slice(-2000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const must = async (method: string, apiPath: string, body?: unknown): Promise<void> => {
    const answer = await api(method, apiPath, body);
    assert.ok(answer.status >= 200 && answer.status < 300, `dev OpenBao setup ${method} ${apiPath} answered ${answer.status}: ${JSON.stringify(answer.json)}`);
  };
  const signer = makeTestSigner();
  await must('POST', 'sys/mounts/kv', { type: 'kv', options: { version: '2' } });
  await must('POST', 'sys/mounts/transit', { type: 'transit' });
  await must('POST', 'sys/auth/jwt', { type: 'jwt' });
  await must('POST', 'auth/jwt/config', { jwt_validation_pubkeys: [signer.publicKeyPem], jwt_supported_algs: ['ES256'] });
  await must('POST', 'sys/policies/acl/sterling-workbench', { policy: STERLING_POLICY });
  await must('POST', 'auth/jwt/role/sterling-workbench', {
    role_type: 'jwt',
    bound_audiences: [TEST_AUDIENCE],
    user_claim: 'sub',
    token_policies: ['sterling-workbench'],
    token_ttl: options.tokenTtl ?? '1h',
    token_max_ttl: options.tokenMaxTtl ?? '24h',
  });
  await must('POST', 'sys/policies/acl/sterling-workbench-stepup', { policy: STERLING_STEPUP_POLICY });
  await must('POST', 'auth/jwt/role/sterling-workbench-stepup', {
    role_type: 'jwt',
    bound_audiences: [TEST_AUDIENCE],
    bound_claims: { acr: TEST_STEPUP_ACR },
    user_claim: 'sub',
    token_policies: ['sterling-workbench-stepup'],
    token_ttl: '5m',
    token_max_ttl: '5m',
  });

  return {
    addr: `http://127.0.0.1:${port}`,
    networkAddr: options.network ? `http://${alias}:8200` : undefined,
    rootToken,
    signer,
    name,
    async createPersonKeys(entityId) {
      await must('POST', `transit/keys/person-${entityId}`, { type: 'ed25519', exportable: false });
      await must('POST', `transit/keys/kek-${entityId}`, { type: 'aes256-gcm96', exportable: false });
    },
    api,
    async stop() {
      await run('docker', ['rm', '-f', name]);
    },
  };
}
