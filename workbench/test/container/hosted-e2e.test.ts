// Phase 46, plan 08, task 1 (D-04, D-17 to D-19, D-21 to D-24, D-26, D-28, D-29, D-36, D-41; FND-T-03, FND-T-05 to FND-T-07): the end-to-end
// proof in a real browser against the built image and a real OpenBao. The dev OpenBao from the pinned openbao-test image runs on a test
// network with a TLS listener whose certificate a test CA signs; the workbench reaches it the way a site does, at https://openbao-<n>:8443
// with STERLING_OPENBAO_CA_FILE, so the production rule (https, or http only to loopback) is unchanged. The harness plays oauth2-proxy: every
// request carries the forwarded sign-in headers with a JWT signed by the test key OpenBao trusts, so no Keycloak and no proxy are needed.
//
//   same person      the session reaches active with no status entry; the step-up command goes to the same-origin /oauth2/start link
//   restart          a secret an extension saves through SecretStorage is at the person's own KV path, and a new container reads it back
//   other person     someone else's headers give "Sign-in check failed" with the reason; the right person and Retry make it go away
//   local mode       with no OpenBao the workbench says "Secrets are unavailable" and saving fails visibly
//   nothing leaks    the recording hook logs no refused connection, and no workbench log holds a JWT, an OpenBao token or the secret
//
// Hygiene as in test/helpers/docker.ts; the suite also removes the one network it makes.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { encodeSegment } from '../../extension/src/node/kv-path';
import { hostedStartupMilestones } from '../e2e/hosted-startup';
import { containerName, freePort, mustRun, removeOwn, run, runContainer, runPlaywright, suffix, testImage, waitHealthy, workbenchRoot } from '../helpers/docker';
import { startDevOpenBao, TEST_AUDIENCE, TEST_STEPUP_ACR, type DevOpenBao } from '../helpers/openbao-dev';

const HOOK = path.join(workbenchRoot, 'test', 'helpers', 'outbound-hook.mjs');
const FIXTURE = path.join(workbenchRoot, 'test', 'fixtures', 'secret-probe');
/** The fixture's fixed value, read from its source (the fixture needs the vscode module, so it cannot be loaded here). */
const PROBE_VALUE = /const PROBE_VALUE = '([^']+)';/.exec(readFileSync(path.join(FIXTURE, 'extension.js'), 'utf8'))![1];
const NETWORK = `sterling-workbench-test-${suffix}-net`;
const CA_IN_CONTAINER = '/run/sterling/openbao-ca.pem';
const EVIDENCE_TIMEOUT_MS = 5_000;
const PEOPLE = {
  a: { sub: 'kc-person-a', email: 'person.a@example.test' },
  b: { sub: 'kc-person-b', email: 'person.b@example.test' },
} as const;
type Person = keyof typeof PEOPLE;

const scratch = mkdtempSync(path.join(tmpdir(), 'sterling-hosted-e2e-'));
const secrets: string[] = [PROBE_VALUE];
const logs: Array<{ name: string; text: string }> = [];
const hookLines: Array<{ name: string; lines: string[] }> = [];
let image = '';
let networkMade = false;
let bao: DevOpenBao;
let openBaoHost = '';

before(async () => {
  image = await testImage();
  await mustRun('docker', ['network', 'create', NETWORK]);
  networkMade = true;
  try { bao = await startDevOpenBao({ network: NETWORK, tls: true }); }
  catch { assert.fail('hosted setup OpenBao did not start'); }
  secrets.push(bao.rootToken);
  // The host name alone: the hook checks a DNS lookup by host, without a port.
  openBaoHost = new URL(bao.tlsNetworkAddr!).hostname;
});

after(async () => {
  await bao?.stop();
  await removeOwn();
  if (networkMade) await run('docker', ['network', 'rm', NETWORK]);
  rmSync(scratch, { recursive: true, force: true });
});

function jwt(person: Person, claims: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const token = bao.signer.sign({ sub: PEOPLE[person].sub, aud: TEST_AUDIENCE, email: PEOPLE[person].email, iat: now, exp: now + 1800, ...claims });
  secrets.push(token);
  return token;
}

/** The three headers oauth2-proxy forwards, as the spec environment and as request headers. */
function signedIn(person: Person): { env: NodeJS.ProcessEnv; headers: Record<string, string> } {
  const token = jwt(person, { acr: TEST_STEPUP_ACR, auth_time: Math.floor(Date.now() / 1000) });
  return {
    env: { WORKBENCH_TOKEN: token, WORKBENCH_EMAIL: PEOPLE[person].email, WORKBENCH_USER: PEOPLE[person].sub },
    headers: { 'X-Forwarded-Access-Token': token, 'X-Auth-Request-Email': PEOPLE[person].email, 'X-Auth-Request-User': PEOPLE[person].sub },
  };
}

/** The hook, mounted read-only, allowing loopback and the OpenBao listener only (46-03's hook). */
const hooked = (): string[] => ['-v', `${HOOK}:/test-hook/outbound-hook.mjs:ro`, '-e', 'NODE_OPTIONS=--import=/test-hook/outbound-hook.mjs',
  '-e', 'NEAR_AI_TEST_OUTBOUND_LOG=/tmp/outbound.log', '-e', `NEAR_AI_TEST_OUTBOUND_ALLOW=127.0.0.1,::1,localhost,${openBaoHost}`];

const withFixture = (): string[] => ['-v', `${FIXTURE}:/plugins/secret-probe:ro`, '-e', 'THEIA_DEFAULT_PLUGINS=local-dir:///plugins'];

interface Started { readonly name: string; readonly url: string }

/** Register retirement as soon as Docker starts the fixture, including when HTTP readiness fails. */
async function withWorkbench(name: string, args: string[], journey: (workbench: Started) => Promise<void>): Promise<void> {
  const port = await freePort();
  const startedAt = performance.now();
  const started = await runContainer(name, ['-d', '-p', `127.0.0.1:${port}:3000`, ...hooked(), ...withFixture(), ...args, image])
    .catch(() => assert.fail(`${name} docker-start could not run`));
  assert.equal(started.code, 0, `${name} docker-start failed after ${Math.round(performance.now() - startedAt)}ms`);
  const workbench = { name, url: `http://127.0.0.1:${port}` };
  let failed = false;
  let stage = 'http-health';
  const healthFailure = (): string => `${name} http-health failed after ${Math.round(performance.now() - startedAt)}ms`;
  try {
    try { await waitHealthy(name, workbench.url, undefined, healthFailure); }
    catch { assert.fail(healthFailure()); }
    stage = 'browser-journey';
    await journey(workbench);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await retire(workbench, failed ? { stage, elapsedMs: Math.round(performance.now() - startedAt) } : undefined);
    } catch (error) {
      if (!failed) throw error;
      console.error(`${name} retirement unavailable after ${stage} failure`);
    }
  }
}

/** A hosted workbench for person A on the test network, published on a free 127.0.0.1 port. */
function withHosted(name: string, journey: (workbench: Started) => Promise<void>): Promise<void> {
  return withWorkbench(name, ['--network', NETWORK,
    '-v', `${bao.caFile}:${CA_IN_CONTAINER}:ro`,
    '-e', `STERLING_OPENBAO_ADDR=${bao.tlsNetworkAddr}`, '-e', `STERLING_OPENBAO_CA_FILE=${CA_IN_CONTAINER}`,
    '-e', `THEIACLOUD_SESSION_USER=${PEOPLE.a.email}`, '-e', `STERLING_STEPUP_ACR=${TEST_STEPUP_ACR}`, '-e', 'STERLING_LISTEN_HOST=0.0.0.0'
  ], journey);
}

/** One request with the person's headers, as the proxy would forward on any page load, then waits for the backend to log the state. */
async function touch(workbench: Started, headers: Record<string, string>, state: RegExp): Promise<void> {
  try { await fetch(`${workbench.url}/`, { headers, signal: AbortSignal.timeout(10_000) }).then((response) => response.arrayBuffer()); }
  catch { assert.fail(`${workbench.name} identity request failed`); }
  const deadline = Date.now() + 30_000;
  for (;;) {
    const lines = await run('docker', ['logs', containerName(workbench.name)], { signal: AbortSignal.timeout(EVIDENCE_TIMEOUT_MS) })
      .catch(() => assert.fail(`${workbench.name} identity evidence unavailable`));
    if (state.test(lines.stdout + lines.stderr)) return;
    if (Date.now() > deadline) assert.fail(`${workbench.name} did not reach the expected identity state within 30 s`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function spec(file: string, workbench: Started, env: NodeJS.ProcessEnv): Promise<void> {
  const started = performance.now();
  const label = `Playwright ${file} (${env.SPEC_STEP})`;
  const result = await runPlaywright(file, { WORKBENCH_URL: workbench.url, PROBE_VALUE, WORKBENCH_STEPUP_ACR: TEST_STEPUP_ACR, ...env })
    .catch(() => assert.fail(`${label} could not start`));
  if (result.code !== 0) {
    const location = /\b(hosted-startup\.ts):(\d{1,5}):(\d{1,4})\b/.exec(result.stdout)
      ?? /\b(session\.spec\.ts|secrets\.spec\.ts):(\d{1,5}):(\d{1,4})\b/.exec(result.stdout);
    const startup = hostedStartupMilestones(result.stdout);
    assert.fail(`${label} failed after ${Math.round(performance.now() - started)}ms (exit ${result.code})${location ? ` at ${location[1]}:${location[2]}:${location[3]}` : ''}${startup ? `\nStartup ${JSON.stringify(startup)}` : ''}`);
  }
  assert.ok(/\b1 passed\b/.test(result.stdout), `${label} did not report one pass`);
}

/** Keeps the container's log and hook log for the final checks, then removes it (a new pod, not a restart). */
async function retire(workbench: Started, failure?: { readonly stage: string; readonly elapsedMs: number }): Promise<void> {
  const name = containerName(workbench.name);
  const problems: string[] = [];
  const capture = async (operation: string, args: string[]) => {
    try {
      const result = await run('docker', args, { signal: AbortSignal.timeout(EVIDENCE_TIMEOUT_MS) });
      if (result.code === 0) return result;
      problems.push(`${operation} exit ${result.code}`);
    } catch (error) {
      problems.push(`${operation} ${error instanceof Error && error.name === 'AbortError' ? 'deadline' : 'unavailable'}`);
    }
    return undefined;
  };
  const file = path.join(scratch, `${workbench.name}.log`);
  const [output, copied, inspected] = await Promise.all([
    capture('logs', ['logs', name]),
    capture('copy hook log', ['cp', `${name}:/tmp/outbound.log`, file]),
    failure === undefined ? undefined : capture('inspect', ['inspect', '--format', '{{.State.Status}} {{.State.Running}} {{.State.OOMKilled}} {{.State.ExitCode}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', name])
  ]);
  const text = output === undefined ? undefined : `${output.stdout}\n${output.stderr}`;
  if (text !== undefined) logs.push({ name: workbench.name, text });
  if (copied !== undefined) {
    try { hookLines.push({ name: workbench.name, lines: readFileSync(file, 'utf8').split('\n').filter(Boolean) }); }
    catch { problems.push('read hook log unavailable'); }
  }
  await capture('remove', ['rm', '-f', name]);

  if (failure === undefined) {
    assert.equal(problems.length, 0, `${workbench.name} retirement failed: ${problems.join(', ')}`);
    return;
  }
  const state = /^(created|running|paused|restarting|removing|exited|dead) (true|false) (true|false) (\d{1,3}) (starting|healthy|unhealthy|none)$/.exec(inspected?.stdout.trim() ?? '');
  const store = /\bSterling secret store: (openbao|keyring|unavailable)\b/.exec(text ?? '')?.[1];
  const identity = /\bSterling session identity: (active|failed|waiting|stopped)\b/.exec(text ?? '')?.[1];
  console.error(`${workbench.name} startup evidence ${JSON.stringify({ ...failure,
    ...(state ? { status: state[1], running: state[2] === 'true', oomKilled: state[3] === 'true', exit: Number(state[4]), health: state[5] } : {}),
    store, identity, problems
  })}`);
}

async function readBao(operation: 'list' | 'read probe', requestPath: string) {
  try { return await bao.api('GET', requestPath); }
  catch { assert.fail(`save OpenBao ${operation} failed`); }
}

async function rootList(prefix: string): Promise<string[]> {
  const answer = await readBao('list', `kv/metadata/${prefix}?list=true`);
  if (answer.status === 404) return [];
  const keys = (answer.json as { data?: { keys?: unknown } } | undefined)?.data?.keys;
  assert.ok(Array.isArray(keys) && keys.every((key) => typeof key === 'string'), 'save OpenBao list response is unreadable');
  return keys;
}

test('same person: the session is active with no status entry, and the step-up command goes to the same-origin sign-in link', async () => {
  await withHosted('same', async (workbench) => {
    const person = signedIn('a');
    await touch(workbench, person.headers, /Sterling session identity: active/);
    await spec('session.spec.ts', workbench, { ...person.env, SPEC_STEP: 'active' });
  });
});

test("restart: a secret saved through SecretStorage is at the person's own KV path, and a new container reads it back", async () => {
  await withHosted('save', async (workbench) => {
    const person = signedIn('a');
    await touch(workbench, person.headers, /Sterling session identity: active/);
    await spec('secrets.spec.ts', workbench, { ...person.env, SPEC_STEP: 'save' });

    const entities = await rootList('users/');
    assert.equal(entities.length, 1, "exactly one person's folder under kv/metadata/users/");
    const service = encodeSegment('127.0.0.1-sterling-test.secret-probe');
    assert.ok(isDeepStrictEqual(await rootList(`users/${entities[0]}`), [`${service}/`]), 'the person has only the probe service');
    assert.ok(isDeepStrictEqual(await rootList(`users/${entities[0]}${service}`), [encodeSegment('probe')]), 'the service has only the probe entry');
    const stored = await readBao('read probe', `kv/data/users/${entities[0]}${service}/${encodeSegment('probe')}`);
    const password = (stored.json as { data?: { data?: { password?: unknown } } } | undefined)?.data?.data?.password;
    assert.ok(typeof password === 'string', 'save OpenBao probe response is unreadable');
    let envelope: unknown;
    try { envelope = JSON.parse(password); }
    catch { assert.fail('stored probe did not have a readable envelope'); }
    assert.ok(isDeepStrictEqual(envelope, { extensionId: 'sterling-test.secret-probe', content: PROBE_VALUE }), 'the probe envelope matches the fixture');
  });

  await withHosted('read', async (workbench) => {
    const again = signedIn('a');
    await touch(workbench, again.headers, /Sterling session identity: active/);
    await spec('secrets.spec.ts', workbench, { ...again.env, SPEC_STEP: 'read' });
  });
});

test("other person: someone else's headers give Sign-in check failed with the reason, and the right person with Retry clears it", async () => {
  await withHosted('other', async (workbench) => {
    await touch(workbench, signedIn('b').headers, /Sterling session identity: failed \(person-mismatch\)/);
    await spec('session.spec.ts', workbench, { ...signedIn('b').env, SPEC_STEP: 'mismatch' });
    await spec('session.spec.ts', workbench, { ...signedIn('a').env, SPEC_STEP: 'retry' });
    const output = await run('docker', ['logs', containerName(workbench.name)], { signal: AbortSignal.timeout(EVIDENCE_TIMEOUT_MS) })
      .catch(() => assert.fail('other identity evidence unavailable after Retry'));
    assert.ok(/Sterling session identity: active/.test(output.stdout + output.stderr), 'other reached the active identity state after Retry');
  });
});

test('local mode in the image: Secrets are unavailable, and saving a secret fails visibly', async () => {
  await withWorkbench('local', ['-e', 'STERLING_LISTEN_HOST=0.0.0.0', '-e', 'STERLING_PREVIEW_NO_SIGN_IN=accept'], async (workbench) => {
    const name = containerName(workbench.name);
    // A loopback call proves that the hook is loaded, even if the browser journey fails.
    const probe = await run('docker', ['exec', name, 'node', '-e', "require('http').get('http://127.0.0.1:3000/healthz', (r) => r.resume())"])
      .catch(() => assert.fail('local loopback probe could not run'));
    assert.equal(probe.code, 0, 'local loopback probe failed');
    await spec('secrets.spec.ts', workbench, { SPEC_STEP: 'unavailable' });
    const output = await run('docker', ['logs', name], { signal: AbortSignal.timeout(EVIDENCE_TIMEOUT_MS) })
      .catch(() => assert.fail('local secret store evidence unavailable'));
    assert.ok(/Sterling secret store: unavailable/.test(output.stdout + output.stderr), 'local reported an unavailable secret store');
    assert.ok(!/in-memory credentials provider/.test(output.stdout + output.stderr), 'local did not select an in-memory credentials provider');
  });
});

test('nothing leaks and nothing calls out: no refused connection, and no JWT, OpenBao token or secret value in any workbench log', () => {
  for (const { name, text } of logs) {
    for (const secret of secrets) assert.ok(!text.includes(secret), `${name}'s log holds no JWT, root token or secret value`);
    assert.ok(!/\b(?:s|hvs)\.[A-Za-z0-9]{20,}/.test(text), `${name}'s log holds no OpenBao token`);
  }
  for (const { name, lines } of hookLines) {
    const refused = lines.filter((line) => line.startsWith('refused ')).length;
    assert.equal(refused, 0, `refused connections in ${name}`);
  }
  assert.equal(logs.length, 5, `every workbench container's log was kept (${logs.map((entry) => entry.name).join(', ')})`);
  assert.equal(hookLines.length, 5, 'every workbench hook log was kept');
  for (const { name, lines } of hookLines) {
    assert.ok(lines.some((line) => line.startsWith('allowed ')), `the hook was loaded in ${name}`);
  }
  const hosted = hookLines.filter(({ name }) => name !== 'local');
  assert.ok(hosted.every(({ lines }) => lines.some((line) => line.includes(openBaoHost))), 'each hosted workbench reached OpenBao over its TLS listener');
});
