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
import { encodeSegment } from '../../extension/src/node/kv-path';
import { containerName, freePort, mustRun, removeOwn, run, runContainer, runPlaywright, suffix, testImage, waitHealthy, workbenchRoot } from '../helpers/docker';
import { startDevOpenBao, TEST_AUDIENCE, TEST_STEPUP_ACR, type DevOpenBao } from '../helpers/openbao-dev';

const HOOK = path.join(workbenchRoot, 'test', 'helpers', 'outbound-hook.mjs');
const FIXTURE = path.join(workbenchRoot, 'test', 'fixtures', 'secret-probe');
/** The fixture's fixed value, read from its source (the fixture needs the vscode module, so it cannot be loaded here). */
const PROBE_VALUE = /const PROBE_VALUE = '([^']+)';/.exec(readFileSync(path.join(FIXTURE, 'extension.js'), 'utf8'))![1];
const NETWORK = `sterling-workbench-test-${suffix}-net`;
const CA_IN_CONTAINER = '/run/sterling/openbao-ca.pem';
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
  bao = await startDevOpenBao({ network: NETWORK, tls: true });
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

/** A hosted workbench for person A on the test network, published on a free 127.0.0.1 port. */
async function startHosted(name: string): Promise<Started> {
  const port = await freePort();
  const started = await runContainer(name, ['-d', '--network', NETWORK, '-p', `127.0.0.1:${port}:3000`, ...hooked(), ...withFixture(),
    '-v', `${bao.caFile}:${CA_IN_CONTAINER}:ro`,
    '-e', `STERLING_OPENBAO_ADDR=${bao.tlsNetworkAddr}`, '-e', `STERLING_OPENBAO_CA_FILE=${CA_IN_CONTAINER}`,
    '-e', `THEIACLOUD_SESSION_USER=${PEOPLE.a.email}`, '-e', `STERLING_STEPUP_ACR=${TEST_STEPUP_ACR}`, '-e', 'STERLING_LISTEN_HOST=0.0.0.0',
    image]);
  assert.equal(started.code, 0, started.stderr);
  const url = `http://127.0.0.1:${port}`;
  await waitHealthy(name, url);
  return { name, url };
}

/** One request with the person's headers, as the proxy would forward on any page load, then waits for the backend to log the state. */
async function touch(workbench: Started, headers: Record<string, string>, state: RegExp): Promise<void> {
  await fetch(`${workbench.url}/`, { headers, signal: AbortSignal.timeout(10_000) }).then((response) => response.arrayBuffer());
  const deadline = Date.now() + 30_000;
  for (;;) {
    const lines = await run('docker', ['logs', containerName(workbench.name)]);
    if (state.test(lines.stdout + lines.stderr)) return;
    if (Date.now() > deadline) assert.fail(`the workbench did not log ${state} within 30 s\n${lines.stdout.slice(-3000)}\n${lines.stderr.slice(-3000)}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function spec(file: string, workbench: Started, env: NodeJS.ProcessEnv): Promise<void> {
  const result = await runPlaywright(file, { WORKBENCH_URL: workbench.url, PROBE_VALUE, WORKBENCH_STEPUP_ACR: TEST_STEPUP_ACR, ...env });
  assert.equal(result.code, 0, `Playwright ${file} (${env.SPEC_STEP}) failed:\n${result.stdout.slice(-6000)}\n${result.stderr.slice(-3000)}`);
  assert.match(result.stdout, /\b1 passed\b/);
}

/** Keeps the container's log and hook log for the final checks, then removes it (a new pod, not a restart). */
async function retire(workbench: Started): Promise<void> {
  const name = containerName(workbench.name);
  const output = await run('docker', ['logs', name]);
  logs.push({ name: workbench.name, text: `${output.stdout}\n${output.stderr}` });
  const file = path.join(scratch, `${workbench.name}.log`);
  const copied = await run('docker', ['cp', `${name}:/tmp/outbound.log`, file]);
  hookLines.push({ name: workbench.name, lines: copied.code === 0 ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [] });
  await mustRun('docker', ['rm', '-f', name]);
}

async function rootList(prefix: string): Promise<string[]> {
  const answer = await bao.api('GET', `kv/metadata/${prefix}?list=true`);
  return answer.status === 404 ? [] : (answer.json as { data: { keys: string[] } }).data.keys;
}

test('same person: the session is active with no status entry, and the step-up command goes to the same-origin sign-in link', async () => {
  const workbench = await startHosted('same');
  const person = signedIn('a');
  await touch(workbench, person.headers, /Sterling session identity: active/);
  await spec('session.spec.ts', workbench, { ...person.env, SPEC_STEP: 'active' });
  await retire(workbench);
});

test("restart: a secret saved through SecretStorage is at the person's own KV path, and a new container reads it back", async () => {
  const first = await startHosted('save');
  const person = signedIn('a');
  await touch(first, person.headers, /Sterling session identity: active/);
  await spec('secrets.spec.ts', first, { ...person.env, SPEC_STEP: 'save' });

  const entities = await rootList('users/');
  assert.equal(entities.length, 1, `exactly one person's folder under kv/metadata/users/: ${entities.join(', ')}`);
  const service = encodeSegment('127.0.0.1-sterling-test.secret-probe');
  assert.deepEqual(await rootList(`users/${entities[0]}`), [`${service}/`]);
  assert.deepEqual(await rootList(`users/${entities[0]}${service}`), [encodeSegment('probe')]);
  const stored = await bao.api('GET', `kv/data/users/${entities[0]}${service}/${encodeSegment('probe')}`);
  const password = (stored.json as { data: { data: { password: string } } }).data.data.password;
  assert.deepEqual(JSON.parse(password), { extensionId: 'sterling-test.secret-probe', content: PROBE_VALUE });
  await retire(first);

  const second = await startHosted('read');
  const again = signedIn('a');
  await touch(second, again.headers, /Sterling session identity: active/);
  await spec('secrets.spec.ts', second, { ...again.env, SPEC_STEP: 'read' });
  await retire(second);
});

test("other person: someone else's headers give Sign-in check failed with the reason, and the right person with Retry clears it", async () => {
  const workbench = await startHosted('other');
  await touch(workbench, signedIn('b').headers, /Sterling session identity: failed \(person-mismatch\)/);
  await spec('session.spec.ts', workbench, { ...signedIn('b').env, SPEC_STEP: 'mismatch' });
  await spec('session.spec.ts', workbench, { ...signedIn('a').env, SPEC_STEP: 'retry' });
  const output = await run('docker', ['logs', containerName(workbench.name)]);
  assert.match(output.stdout + output.stderr, /Sterling session identity: active/);
  await retire(workbench);
});

test('local mode in the image: Secrets are unavailable, and saving a secret fails visibly', async () => {
  const port = await freePort();
  const name = 'local';
  const started = await runContainer(name, ['-d', '-p', `127.0.0.1:${port}:3000`, ...hooked(), ...withFixture(),
    '-e', 'STERLING_LISTEN_HOST=0.0.0.0', '-e', 'STERLING_PREVIEW_NO_SIGN_IN=accept', image]);
  assert.equal(started.code, 0, started.stderr);
  const workbench = { name, url: `http://127.0.0.1:${port}` };
  await waitHealthy(name, workbench.url);
  await spec('secrets.spec.ts', workbench, { SPEC_STEP: 'unavailable' });
  const output = await run('docker', ['logs', containerName(name)]);
  assert.match(output.stdout + output.stderr, /Sterling secret store: unavailable/);
  assert.doesNotMatch(output.stdout + output.stderr, /in-memory credentials provider/);
  // A local backend calls out to nothing, so its hook log may be empty; one loopback call in the container shows the hook is loaded there.
  await mustRun('docker', ['exec', containerName(name), 'node', '-e', "require('http').get('http://127.0.0.1:3000/healthz', (r) => r.resume())"]);
  await retire(workbench);
});

test('nothing leaks and nothing calls out: no refused connection, and no JWT, OpenBao token or secret value in any workbench log', () => {
  assert.equal(logs.length, 5, `every workbench container's log was kept (${logs.map((entry) => entry.name).join(', ')})`);
  for (const { name, lines } of hookLines) {
    assert.ok(lines.some((line) => line.startsWith('allowed ')), `the hook was loaded in ${name}`);
    const refused = lines.filter((line) => line.startsWith('refused '));
    assert.deepEqual(refused, [], `refused connections in ${name}:\n${refused.join('\n')}`);
  }
  const hosted = hookLines.filter(({ name }) => name !== 'local');
  assert.ok(hosted.every(({ lines }) => lines.some((line) => line.includes(openBaoHost))), 'each hosted workbench reached OpenBao over its TLS listener');
  for (const { name, text } of logs) {
    for (const secret of secrets) assert.ok(!text.includes(secret), `${name}'s log holds no JWT, root token or secret value`);
    assert.doesNotMatch(text, /\b(?:s|hvs)\.[A-Za-z0-9]{20,}/, `${name}'s log holds no OpenBao token`);
  }
});
