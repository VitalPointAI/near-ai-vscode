// A dev-mode OpenBao for the container suite (46-02; 46-03 and 46-08 reuse it on their own networks, 46-07 adds keys with createPersonKeys).
// The image reference is read from the openbao-test FROM line of workbench/Dockerfile, so the tests run the pinned image the fit check sees
// (D-29). It starts in dev mode (in memory, unsealed) with a random root token and 512 MiB, mounts kv (version 2) and transit, enables jwt auth
// with the public key of a test signer (no Keycloak), and writes the policies and the two roles Phase 47 applies (deploy/openbao): the
// sterling-workbench role (KV, data keys, token self paths) and the sterling-workbench-stepup role, which alone also holds
// sterling-workbench-sign (46-07). These are test fixtures that mirror the contract; Phase 47 owns the real ones. stop() removes only
// this helper's own container.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { addressOnNetwork, containerName, freePort, run, runContainer, workbenchRoot } from './docker';
import { makeTestSigner, type TestSigner } from './test-jwt';
import { makeTestCertificate, type TestCertificate } from './tls-cert';

/** The audience the test role is bound to; test JWTs carry it as aud. */
export const TEST_AUDIENCE = 'sterling-workbench-test';

/** The Phase 47 contract paths (46-CONTEXT interface table), templated on the entity id. */
export const STERLING_POLICY = `
path "kv/data/users/{{identity.entity.id}}/*" { capabilities = ["create", "read", "update", "delete", "list"] }
path "kv/metadata/users/{{identity.entity.id}}/*" { capabilities = ["create", "read", "update", "delete", "list"] }
path "transit/datakey/wrapped/kek-{{identity.entity.id}}" { capabilities = ["update"] }
path "transit/decrypt/kek-{{identity.entity.id}}" { capabilities = ["update"] }
path "transit/keys/person-{{identity.entity.id}}" { capabilities = ["read"] }
path "auth/token/renew-self" { capabilities = ["update"] }
path "auth/token/revoke-self" { capabilities = ["update"] }
path "auth/token/lookup-self" { capabilities = ["read"] }
`;

/** The acr the test step-up role is bound to; a test JWT carrying it stands for a fresh passkey or security key sign-in. */
export const TEST_STEPUP_ACR = 'urn:sterling:test:acr:phishing-resistant';

/**
 * The signing policy, as Phase 47 writes it (deploy/openbao/policies/sterling-workbench-sign.hcl): signing with the person's own key and
 * nothing else. Only the step-up role carries it, beside sterling-workbench, so the ordinary session token above cannot sign.
 */
export const STERLING_SIGN_POLICY = `
path "transit/sign/person-{{identity.entity.id}}" { capabilities = ["update"] }
`;

export interface DevOpenBao {
  /** The fixture setup address from the host. */
  readonly addr: string;
  /** The address from another container on the given network, for example http://openbao-1:8200. */
  readonly networkAddr: string | undefined;
  /**
   * With `tls`: the https address from another container on the given network, for example https://openbao-1:8443, whose certificate
   * the test CA in caFile signs. This is how a workbench on the network reaches OpenBao the way a site does (https with
   * STERLING_OPENBAO_CA_FILE); plain http to a non-loopback address stays refused (46-02 planning choice 2).
   */
  readonly tlsNetworkAddr: string | undefined;
  /** With `tls`: the test CA (PEM) on the host, to mount read-only as the workbench's STERLING_OPENBAO_CA_FILE. */
  readonly caFile: string | undefined;
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

/** The port of the extra TLS listener. The dev listener on 8200 serves fixture setup from the host. */
const TLS_PORT = 8443;

type DevOpenBaoOptions = { tokenTtl?: string; tokenMaxTtl?: string; tls?: boolean } &
  ({ network?: string; networkOnly?: false } | { network: string; networkOnly: true });

export async function startDevOpenBao(options: DevOpenBaoOptions = {}): Promise<DevOpenBao> {
  const rootToken = `root-${randomBytes(12).toString('hex')}`;
  const short = `bao-${++count}`;
  const name = containerName(short);
  const alias = `openbao-${count}`;
  const port = options.networkOnly ? undefined : await freePort();
  const networkArgs = options.networkOnly
    ? ['--network', options.network, '--network-alias', alias]
    : ['-p', `127.0.0.1:${port}:8200`];
  assert.ok(!options.tls || options.network, 'a TLS listener is for a workbench on a network, so tls needs network');
  // With tls, a test CA signs a certificate for the network alias; the folder is mounted read-only and the listener added with -config.
  let certificate: TestCertificate | undefined;
  const tlsArgs: string[] = [];
  const configArgs: string[] = [];
  if (options.tls) {
    certificate = makeTestCertificate({ dnsNames: [alias] });
    writeFileSync(path.join(certificate.dir, 'listener.hcl'),
      `listener "tcp" {\n  address = "0.0.0.0:${TLS_PORT}"\n  tls_cert_file = "/sterling-tls/server.pem"\n  tls_key_file = "/sterling-tls/server.key"\n}\n`);
    // OpenBao runs as its own user in the container; the test key is readable only inside this test's own temporary folder.
    chmodSync(certificate.dir, 0o755);
    for (const file of ['ca.pem', 'server.pem', 'server.key', 'listener.hcl']) chmodSync(path.join(certificate.dir, file), 0o644);
    tlsArgs.push('-v', `${certificate.dir}:/sterling-tls:ro`);
    configArgs.push('-config=/sterling-tls/listener.hcl');
  }
  const started = await runContainer(short, ['-d', '--memory=512m', ...networkArgs, ...tlsArgs,
    '-e', `BAO_DEV_ROOT_TOKEN_ID=${rootToken}`, '-e', 'BAO_DEV_LISTEN_ADDRESS=0.0.0.0:8200', '-e', 'SKIP_SETCAP=true',
    openBaoTestImage(), 'server', '-dev', ...configArgs]);
  if (started.code !== 0) certificate?.cleanup();
  assert.equal(started.code, 0, `the dev OpenBao did not start: ${started.stderr.slice(-2000)}`);
  if (options.network && !options.networkOnly) {
    const joined = await run('docker', ['network', 'connect', '--alias', alias, options.network, name]);
    assert.equal(joined.code, 0, `the dev OpenBao could not join ${options.network}: ${joined.stderr}`);
  }

  const addr = options.networkOnly ? `http://${await addressOnNetwork(name, options.network)}:8200` : `http://127.0.0.1:${port}`;
  const api = async (method: string, apiPath: string, body?: unknown, token = rootToken): Promise<{ status: number; json: unknown }> => {
    const response = await fetch(`${addr}/v1/${apiPath}`, {
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
    const health = await fetch(`${addr}/v1/sys/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.status, () => 0);
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
    token_no_default_policy: true,
    token_policies: ['sterling-workbench'],
    token_ttl: options.tokenTtl ?? '1h',
    token_max_ttl: options.tokenMaxTtl ?? '24h',
  });
  // The step-up role as Phase 47 applies it (deploy/openbao/apply.mjs): the step-up acr bound, a token that cannot outlive the window,
  // and both policies; OpenBao refuses to sign once that token has expired, so each signature logs in again.
  await must('POST', 'sys/policies/acl/sterling-workbench-sign', { policy: STERLING_SIGN_POLICY });
  await must('POST', 'auth/jwt/role/sterling-workbench-stepup', {
    role_type: 'jwt',
    bound_audiences: [TEST_AUDIENCE],
    bound_claims: { acr: TEST_STEPUP_ACR },
    bound_claims_type: 'string',
    user_claim: 'sub',
    token_no_default_policy: true,
    token_policies: ['sterling-workbench', 'sterling-workbench-sign'],
    token_ttl: 300,
    token_max_ttl: 300,
    token_explicit_max_ttl: 300,
    token_period: 0,
  });

  return {
    addr,
    networkAddr: options.network ? `http://${alias}:8200` : undefined,
    tlsNetworkAddr: options.tls ? `https://${alias}:${TLS_PORT}` : undefined,
    caFile: certificate?.caFile,
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
      certificate?.cleanup();
    },
  };
}
