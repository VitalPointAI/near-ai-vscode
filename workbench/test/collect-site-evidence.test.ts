// 48.2-09 (D-08, D-20, D-21): one run of the site collector, against fakes of OpenBao, Prometheus and the Kubernetes API. It reads in-cluster
// sources only, keeps each fact group's own time (a failed source keeps its previous group and time), has OpenBao Transit sign the live feed
// at the key version the trust document lists last, writes only ConfigMap sterling-site-evidence-live, and never shows the OpenBao token.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { run } from '../bin/collect-site-evidence.mjs';
import { makeTrustDocument, verifySiteEvidence } from '../../compliance/src/siteEvidence.ts';
import { scanLine } from '../../scripts/lib/workflow.mjs';

// Bundled to workbench/dist/test/; scripts/build.mjs builds engine/compliance.cjs first.
const workbenchRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const engineFile = path.join(workbenchRoot, 'engine', 'compliance.cjs');
const engine = createRequire(engineFile)(engineFile);

const NOW = Date.parse('2026-11-25T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const NAMESPACE = 'theia-cloud';
const OPENBAO = 'https://openbao.sterling-openbao.svc:8200';
const PROMETHEUS = 'http://prometheus-server.sterling-monitoring.svc';
const API = 'https://10.43.0.1:443';
const TOKEN = 'hvs.CAESIJ-the-openbao-token-must-never-show';
const SA_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.kubernetes-service-account-token';
const JWT = 'eyJhbGciOiJSUzI1NiJ9.projected-openbao-audience-token';
const ENV = {
  STERLING_SITE_ID: 'site-a', STERLING_OPENBAO_ADDR: OPENBAO, STERLING_OPENBAO_CA_FILE: '/etc/ssl/site-ca/ca.crt', STERLING_PROMETHEUS_ADDR: PROMETHEUS,
  STERLING_EVIDENCE_NAMESPACE: NAMESPACE, KUBERNETES_SERVICE_HOST: '10.43.0.1', KUBERNETES_SERVICE_PORT: '443',
};
const FILES: Record<string, string> = {
  '/etc/ssl/site-ca/ca.crt': 'SITE CA', '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt': 'CLUSTER CA',
  '/var/run/secrets/kubernetes.io/serviceaccount/token': SA_TOKEN, '/var/run/secrets/sterling/openbao-token': JWT,
};

const transit = { 1: generateKeyPairSync('ed25519'), 2: generateKeyPairSync('ed25519') } as const;
const rawKey = (key: KeyObject) => (key.export({ type: 'spki', format: 'der' }) as Buffer).subarray(12).toString('base64url');
const siteKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

function trustDocument(versions: (1 | 2)[]) {
  return makeTrustDocument({
    site: 'site-a', issuedAt: iso(NOW - 3_600_000), notBefore: iso(NOW - 86_400_000), notAfter: iso(NOW + 300 * 86_400_000), now: new Date(NOW),
    collectorKeys: versions.map((version) => ({ version, publicKey: rawKey(transit[version].publicKey) })), operatorKeys: [],
  });
}

interface Call { readonly method: string; readonly url: string; readonly headers: Record<string, string>; readonly body: unknown }
type Answer = { status: number; json?: unknown };

/** The cluster's sources as fakes: every request is recorded and answered from the routes the test may override. */
function cluster(options: { versions?: (1 | 2)[]; trust?: unknown | null; live?: unknown; overrides?: Record<string, (call: Call) => Answer> } = {}) {
  const calls: Call[] = [];
  const trustDoc = options.trust === undefined ? trustDocument(options.versions ?? [1]) : options.trust;
  let live = options.live;
  const routes: Record<string, (call: Call) => Answer> = {
    [`GET ${OPENBAO}/v1/sys/seal-status`]: () => ({ status: 200, json: { type: 'pkcs11', sealed: false, initialized: true, version: '2.7.3' } }),
    [`POST ${OPENBAO}/v1/auth/kubernetes/login`]: (call) => (call.body as { jwt?: string; role?: string })?.jwt === JWT && (call.body as { role?: string }).role === 'site-evidence'
      ? { status: 200, json: { auth: { client_token: TOKEN, lease_duration: 300 } } } : { status: 403, json: { errors: ['permission denied'] } },
    [`POST ${OPENBAO}/v1/transit/sign/site-evidence`]: (call) => {
      if (call.headers['x-vault-token'] !== TOKEN) return { status: 403, json: { errors: ['permission denied'] } };
      const body = call.body as { input: string; key_version?: number };
      const version = (body.key_version ?? 2) as 1 | 2;
      return { status: 200, json: { data: { signature: `vault:v${version}:${sign(null, Buffer.from(body.input, 'base64'), transit[version].privateKey).toString('base64')}`, key_version: version } } };
    },
    [`POST ${OPENBAO}/v1/auth/token/revoke-self`]: () => ({ status: 204 }),
    [`GET ${PROMETHEUS}/api/v1/rules`]: () => ({ status: 200, json: { status: 'success', data: { groups: [
      { name: 'openbao', rules: [{ name: 'OpenBaoSealed', health: 'ok', lastEvaluation: iso(NOW - 30_000) }, { name: 'OpenBaoAuditDeviceFailing', health: 'ok', lastEvaluation: iso(NOW - 30_000) }] },
      { name: 'audit-shipping', rules: [{ name: 'FluentBitOutputFailing', health: 'ok', lastEvaluation: iso(NOW - 20 * 60_000) }] },
    ] } } }),
    [`GET ${PROMETHEUS}/api/v1/alerts`]: () => ({ status: 200, json: { status: 'success', data: { alerts: [
      { labels: { alertname: 'Watchdog', instance: 'node-1.example' }, state: 'firing' }, { labels: { alertname: 'OpenBaoSealed' }, state: 'pending' },
    ] } } }),
    [`GET ${API}/apis/policies.kyverno.io/v1/imagevalidatingpolicies`]: () => ({ status: 200, json: { items: [
      { metadata: { name: 'site-images-signed' }, spec: { validationActions: ['Deny'], failurePolicy: 'Fail' } }, { metadata: { name: 'audit-only' }, spec: { validationActions: ['Audit'] } },
    ] } }),
    [`GET ${API}/apis/kyverno.io/v1/clusterpolicies`]: () => ({ status: 404, json: {} }),
    [`GET ${API}/apis/wgpolicyk8s.io/v1alpha2/policyreports`]: () => ({ status: 200, json: { items: [
      { metadata: { name: 'r1', namespace: 'theia-cloud' }, results: [{ policy: 'site-images-signed', result: 'pass' }, { policy: 'site-images-signed', result: 'fail' }, { policy: 'other', result: 'fail' }] },
    ] } }),
    [`GET ${API}/apis/wgpolicyk8s.io/v1alpha2/clusterpolicyreports`]: () => ({ status: 200, json: { items: [] } }),
    [`GET ${API}/api/v1/nodes`]: () => ({ status: 200, json: { items: [{ metadata: { name: 'node-1' } }, { metadata: { name: 'node-2' } }, { metadata: { name: 'node-3' } }] } }),
    [`GET ${API}/api/v1/namespaces/${NAMESPACE}/configmaps/sterling-evidence-trust`]: () => trustDoc === null ? { status: 404, json: {} }
      : { status: 200, json: { data: { 'trust.json': JSON.stringify(trustDoc), 'organization.pub': siteKey.publicKey.export({ type: 'spki', format: 'pem' }).toString() } } },
    [`GET ${API}/api/v1/namespaces/${NAMESPACE}/configmaps/sterling-site-evidence-live`]: () => ({ status: 200, json: { data: live === undefined ? {} : { 'live.json': JSON.stringify(live) } } }),
    [`PATCH ${API}/api/v1/namespaces/${NAMESPACE}/configmaps/sterling-site-evidence-live`]: (call) => {
      live = JSON.parse(((call.body as { data: Record<string, string> }).data)['live.json']!);
      return { status: 200, json: {} };
    },
    ...options.overrides,
  };
  const request = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
    const call: Call = { method: init.method ?? 'GET', url, headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])), body: init.body };
    calls.push(call);
    const route = routes[`${call.method} ${url.split('?')[0]}`];
    const answer = route ? route(call) : { status: 404, json: {} };
    if (answer.status >= 500) throw new Error(`${call.method} ${new URL(url).pathname} did not answer`);
    return { status: answer.status, json: answer.json };
  };
  return { calls, request, live: () => live as { payload: { keyVersion: number; groups: Record<string, Record<string, unknown>> }; signedAt: string } | undefined };
}

async function collect(fake: ReturnType<typeof cluster>, env: Record<string, string> = ENV, now = NOW) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run({
    env, request: fake.request, now: () => now, engine,
    readFile: async (file: string) => { if (!(file in FILES)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return FILES[file]!; },
    stdout: (line: string) => { out.push(line); return true; }, stderr: (line: string) => { err.push(line); return true; },
  });
  return { code, out, err };
}

/** The trust ConfigMap as a session would read it: the document's bytes and your site key's signature over them. */
function sessionTrust(document: unknown) {
  const bytes = Buffer.from(JSON.stringify(document));
  const bundle = { mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json', verificationMaterial: { publicKey: { hint: 'x' } },
    messageSignature: { messageDigest: { algorithm: 'SHA2_256', digest: createHash('sha256').update(bytes).digest('base64') }, signature: sign('sha256', bytes, siteKey.privateKey).toString('base64') } };
  return { document: bytes, bundle };
}

test('one run: OpenBao\'s seal status becomes a Transit-signed live feed in sterling-site-evidence-live that a session verifies', async () => {
  const fake = cluster();
  const result = await collect(fake);
  assert.equal(result.code, 0, result.err.join('\n'));
  const written = fake.live();
  assert.ok(written);
  assert.deepEqual(written.payload.groups.openbao, { collectedAt: iso(NOW), sealed: false, type: 'pkcs11' });
  assert.equal(written.signedAt, iso(NOW));
  const writes = fake.calls.filter(({ method }) => method !== 'GET' && method !== 'POST');
  assert.deepEqual(writes.map(({ method, url }) => `${method} ${url}`), [`PATCH ${API}/api/v1/namespaces/${NAMESPACE}/configmaps/sterling-site-evidence-live`]);
  assert.equal(writes[0]!.headers.authorization, `Bearer ${SA_TOKEN}`, 'the ConfigMap is written with the service account\'s own token');
  const verified = verifySiteEvidence({ files: { trust: sessionTrust(trustDocument([1])), live: written }, organizationKey: siteKey.publicKey.export({ type: 'spki', format: 'pem' }).toString(), now: new Date(NOW + 60_000) });
  assert.deepEqual(verified.sources.find(({ file }) => file === 'live'), { file: 'live', verification: 'verified', signedAt: iso(NOW), keyVersion: 1 });
  assert.ok(verified.observations.some(({ subject }) => subject === 'openbao-sealed'));
});

test('token: the OpenBao token never appears in output, the ConfigMap or an error, and it is revoked before the run ends', async () => {
  const fake = cluster();
  const result = await collect(fake);
  const shown = [...result.out, ...result.err, JSON.stringify(fake.live())].join('\n');
  assert.equal(shown.includes(TOKEN), false);
  assert.equal(shown.includes(JWT), false);
  assert.equal(shown.includes(SA_TOKEN), false);
  const revoke = fake.calls.findIndex(({ url }) => url.endsWith('/v1/auth/token/revoke-self'));
  assert.ok(revoke >= 0, 'the token is revoked');
  assert.equal(fake.calls[revoke]!.headers['x-vault-token'], TOKEN);
  assert.ok(fake.calls.slice(revoke + 1).every(({ headers }) => headers['x-vault-token'] === undefined), 'no OpenBao call after the revocation');
  // A refused sign still revokes, and the error names no token.
  const refused = cluster({ overrides: { [`POST ${OPENBAO}/v1/transit/sign/site-evidence`]: () => ({ status: 403, json: { errors: [`denied for ${TOKEN}`] } }) } });
  const failed = await collect(refused);
  assert.equal(failed.code, 1);
  assert.equal(failed.err.length, 1);
  assert.equal(failed.err.join('').includes(TOKEN), false);
  assert.ok(refused.calls.some(({ url }) => url.endsWith('/v1/auth/token/revoke-self')));
  assert.equal(refused.live(), undefined, 'nothing written');
});

test('key version: the newest version the trust document lists is passed as key_version and recorded; no trust document writes nothing', async () => {
  const both = cluster({ versions: [1, 2] });
  assert.equal((await collect(both)).code, 0);
  assert.equal((both.calls.find(({ url }) => url.endsWith('/v1/transit/sign/site-evidence'))!.body as { key_version: number }).key_version, 2);
  assert.equal(both.live()!.payload.keyVersion, 2);
  const one = cluster({ versions: [1] });
  assert.equal((await collect(one)).code, 0);
  assert.equal((one.calls.find(({ url }) => url.endsWith('/v1/transit/sign/site-evidence'))!.body as { key_version: number }).key_version, 1, 'OpenBao has version 2, the trust document lists only 1');
  assert.equal(one.live()!.payload.keyVersion, 1);
  const none = cluster({ trust: null });
  const result = await collect(none);
  assert.equal(result.code, 1);
  assert.equal(result.err.length, 1);
  assert.match(result.err[0]!, /trust document/);
  assert.equal(none.live(), undefined);
  assert.ok(!none.calls.some(({ url }) => url.includes('/transit/')), 'nothing is signed');
});

test('groups: Prometheus, Kyverno and the nodes give their groups with the run\'s time, exactly the allow-list\'s facts', async () => {
  const fake = cluster();
  assert.equal((await collect(fake)).code, 0);
  const groups = fake.live()!.payload.groups;
  assert.deepEqual(groups.prometheus, { collectedAt: iso(NOW), ruleGroups: 2, unhealthyRuleGroups: 0, staleRules: 1, firingAlerts: ['Watchdog'] });
  assert.deepEqual(groups.admission, { collectedAt: iso(NOW), enforcingImagePolicies: 1, refusedImageResults: 1 });
  assert.deepEqual(groups.nodes, { collectedAt: iso(NOW), count: 3 });
  assert.deepEqual(Object.keys(groups).sort(), ['admission', 'nodes', 'openbao', 'prometheus']);
});

test('failed source: a silent Prometheus keeps its previous group and time; with nothing answering every group is kept as it was', async () => {
  const first = cluster();
  await collect(first);
  const previous = first.live();
  const later = NOW + 15 * 60_000;
  const silent = cluster({ live: previous, overrides: { [`GET ${PROMETHEUS}/api/v1/rules`]: () => ({ status: 503 }), [`GET ${PROMETHEUS}/api/v1/alerts`]: () => ({ status: 503 }) } });
  const result = await collect(silent, ENV, later);
  assert.equal(result.code, 0);
  assert.equal(result.err.length, 1);
  assert.match(result.err[0]!, /prometheus/);
  const groups = silent.live()!.payload.groups;
  assert.deepEqual(groups.prometheus, previous!.payload.groups.prometheus, 'kept, with its original collectedAt');
  assert.equal(groups.prometheus!.collectedAt, iso(NOW));
  assert.equal(groups.nodes!.collectedAt, iso(later));
  const down = (key: string) => [key, () => ({ status: 503 })] as const;
  const nothing = cluster({ live: previous, overrides: Object.fromEntries([
    down(`GET ${OPENBAO}/v1/sys/seal-status`), down(`GET ${PROMETHEUS}/api/v1/rules`), down(`GET ${PROMETHEUS}/api/v1/alerts`), down(`GET ${API}/apis/policies.kyverno.io/v1/imagevalidatingpolicies`),
    down(`GET ${API}/apis/kyverno.io/v1/clusterpolicies`), down(`GET ${API}/apis/wgpolicyk8s.io/v1alpha2/policyreports`), down(`GET ${API}/apis/wgpolicyk8s.io/v1alpha2/clusterpolicyreports`), down(`GET ${API}/api/v1/nodes`),
  ]) });
  const kept = await collect(nothing, ENV, later);
  assert.equal(kept.code, 0, kept.err.join('\n'));
  assert.deepEqual(nothing.live()!.payload.groups, previous!.payload.groups);
  assert.equal(nothing.live()!.signedAt, iso(later), 'a newly signed feed, every group with its own old time');
});

test('addresses: a Prometheus or OpenBao address outside the cluster stops the run before any request', async () => {
  for (const env of [{ ...ENV, STERLING_PROMETHEUS_ADDR: 'https://prometheus.example.com' }, { ...ENV, STERLING_OPENBAO_ADDR: 'https://openbao.example.com:8200' },
    { ...ENV, STERLING_OPENBAO_ADDR: 'https://openbao.svc.example.com' }, { ...ENV, KUBERNETES_SERVICE_HOST: 'api.example.com' }]) {
    const fake = cluster();
    const result = await collect(fake, env);
    assert.equal(result.code, 1);
    assert.equal(result.err.length, 1);
    assert.deepEqual(fake.calls, [], 'no request');
  }
  const local = cluster();
  assert.equal((await collect(local, { ...ENV, STERLING_PROMETHEUS_ADDR: 'http://prometheus-server.sterling-monitoring.svc.cluster.local:9090' })).code, 0);
});

test('no secrets: the written feed holds no token, key, user name or log line', async () => {
  const fake = cluster();
  await collect(fake);
  const text = JSON.stringify(fake.live(), null, 2);
  for (const line of text.split('\n')) assert.deepEqual(scanLine(line), [], line);
  for (const word of ['node-1.example', 'instance', 'Bearer', 'PRIVATE KEY', '@']) assert.equal(text.includes(word), false, word);
});
