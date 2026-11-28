import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import test, { before } from 'node:test';
import { createDataMapHandler, recordSyntheticObservation } from './dataPlatformHost';
import type { CatalogueRecord, CatalogueScope, DataMapHostDependencies, SyntheticRecordDependencies } from './dataPlatformHost';
import type { DataMapItem, DataMapSnapshot } from './dataMapFixture';
import { SCALE_PRESETS } from '../../domain/gate/labels';
import type { Label } from '../../domain/gate/labels';
import { canonicalBytes } from '../../domain/team/canonical';
import { registerDataMapPanel } from './dataMapPanelFixture';

const fixtureId = process.env.SOVAI_PHASE88_FIXTURE_ID;
const approvedImage = '5c92c1b5d080d19aa506f56da850c6b57d4e06e5be4a4d07a6469f18aa494434';
const fixtureLabel = { scale: 'fixture', level: 'restricted', compartments: ['fictional'], handling: ['local'], releasability: [] };
const label = JSON.stringify(fixtureLabel);
const transition = JSON.stringify({ payload: {
  operation: 'record', tenant: 'fixture-tenant', mission: 'fixture-mission', policyRevision: 'fixture-policy-v1', sourceId: 'fixture-source',
  itemId: 'fixture-item', sourceVersion: 'v1', name: 'Made-up folder item', label: fixtureLabel,
}, sig: 'opaque-fixture-signature' });
const key = randomBytes(32).toString('hex');
const sqlText = (value: string): string => `'${value.replaceAll("'", "''")}'`;

function query(sql: string): string[] {
  assert.match(fixtureId ?? '', /^[0-9a-f]{64}$/, 'The Phase 88 SQL tracer requires the verified disposable PostgreSQL fixture.');
  const result = spawnSync('podman', ['exec', '-i', fixtureId!, 'env', '-i', 'PATH=/usr/pgsql-18/bin:/usr/bin:/bin',
    'psql', '-X', '-qAt', '--no-password', '--host=/fixture/socket', '--port=5432', '--username=fixture_admin',
    '--dbname=fixture_catalogue', '--set=ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8', timeout: 10_000 });
  if (result.error) throw result.error;
  // PostgreSQL may echo input values in a diagnostic. Emit only fixed fixture outcomes.
  const primary = /^ERROR:[ \t]+(.+)$/m.exec(result.stderr ?? '')?.[1];
  let reason = 'The synthetic catalogue query failed.';
  if (primary === 'Invalid observation or signed fact binding' || primary === 'Observation has no verified write scope') {
    reason = primary;
  } else if (primary === 'permission denied' || primary?.startsWith('permission denied ')) {
    reason = 'permission denied';
  }
  assert.equal(result.status, 0, reason);
  return (result.stdout ?? '').trim().split('\n');
}

function checkFixture(): void {
  assert.match(fixtureId ?? '', /^[0-9a-f]{64}$/, 'The Phase 88 SQL tracer requires the verified disposable PostgreSQL fixture.');
  const result = spawnSync('podman', ['container', 'inspect', fixtureId!], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, 'Could not inspect the disposable fixture.');
  const [container] = JSON.parse(result.stdout);
  assert.equal(container.Id, fixtureId);
  assert.equal(container.Image.replace(/^sha256:/, ''), approvedImage);
  assert.equal(container.State.Running, true);
  assert.equal(container.HostConfig.NetworkMode, 'none');
  assert.deepEqual(Object.keys(container.HostConfig.PortBindings ?? {}), []);
  assert(!(container.Mounts ?? []).some((mount: { Type: string }) => mount.Type === 'bind' || mount.Type === 'volume'));
}

interface FixtureClaims {
  tenant?: string;
  subject?: string;
  audience?: string;
  mission?: string;
  sourceId?: string;
  policyRevision?: string;
  labelJson?: string;
  signedFactJson?: string;
  ttl?: number;
  expiresAt?: number;
}

function issue(purpose: 'read' | 'record', options: FixtureClaims = {}): string {
  const { tenant = 'fixture-tenant', subject = 'fixture-person', audience = 'phase88-catalogue', mission = 'fixture-mission',
    sourceId = 'fixture-source', policyRevision = 'fixture-policy-v1', ttl = 30, expiresAt, labelJson = label,
    signedFactJson = transition } = options;
  const expiry = expiresAt ?? `(floor(extract(epoch from clock_timestamp())) + ${ttl})::bigint`;
  // The fixture broker commits the actual signed envelope before switching to the app role.
  const commitment = purpose === 'record'
    ? `, encode(phase88_crypto.digest(convert_to(${sqlText(signedFactJson)}::jsonb::text, 'UTF8'), 'sha256'), 'hex')`
    : '';
  return `
SELECT concat_ws(E'\\n', 'phase88-clearance-v1', ${sqlText(tenant)}, ${sqlText(subject)}, ${sqlText(audience)}, ${sqlText(purpose)},
  ${sqlText(policyRevision)}, ${expiry}::text,
  ${sqlText(mission)}, ${sqlText(sourceId)}, pg_backend_pid()::text, pg_current_xact_id()::text, ${sqlText(labelJson)}${commitment}) AS claims \\gset
SELECT encode(phase88_crypto.hmac(convert_to(:'claims', 'UTF8'), decode('${key}', 'hex'), 'sha256'), 'hex') AS mac \\gset
SET LOCAL ROLE phase88_app;
`;
}

const readCatalogue: DataMapHostDependencies['readCatalogue'] = async (scope) => {
  const [result] = query(`BEGIN;
${issue('read', { ...scope, labelJson: JSON.stringify(scope.label) })}
SELECT phase88.install_clearance(:'claims', decode(:'mac', 'hex')) AS installed \\gset
\\if :installed
SELECT coalesce(jsonb_agg(jsonb_build_object('itemId', item_id, 'sourceId', source_id, 'name', name, 'label', label)), '[]')
FROM phase88.catalogue;
\\else
SELECT '[]';
\\endif
COMMIT;`);
  return JSON.parse(result) as DataMapItem[];
};

const recordCatalogue: SyntheticRecordDependencies['recordCatalogue'] = async (scope, observation) => {
  const signedFactJson = JSON.stringify(observation.signedFact);
  const [result] = query(`BEGIN;
${issue('record', { ...scope, labelJson: JSON.stringify(scope.label), signedFactJson })}
SELECT phase88.install_clearance(:'claims', decode(:'mac', 'hex')) AS installed \\gset
\\if :installed
SELECT phase88.record_observation(${sqlText(observation.itemId)}, ${sqlText(observation.sourceVersion)}, ${sqlText(observation.name)},
  ${sqlText(JSON.stringify(observation.label))}::jsonb, ${sqlText(signedFactJson)}::jsonb);
\\else
SELECT 'scope-refused';
\\endif
COMMIT;`);
  assert.ok(result === 'recorded' || result === 'duplicate', 'The disposable database refused the fixture write scope.');
  return result;
};

const install = "SELECT phase88.install_clearance(:'claims', decode(:'mac', 'hex'));";
const record = `SELECT phase88.record_observation('fixture-item', 'v1', 'Made-up folder item', ${sqlText(label)}::jsonb, ${sqlText(transition)}::jsonb);`;
const counts = `SELECT (SELECT count(*) FROM phase88.catalogue), (SELECT count(*) FROM phase88.checkpoint),
  (SELECT count(*) FROM phase88.signed_fact), (SELECT count(*) FROM phase88.receipt), (SELECT count(*) FROM phase88.outbox);`;

before(() => {
  checkFixture();
  const migration = readFileSync(resolve('src/test/integration/fixtures/phase-88/001-governed-catalog.sql'), 'utf8');
  query(migration);
  query(`INSERT INTO phase88_private.verifier_key (key) VALUES (decode('${key}', 'hex'));`);
});

test('synthetic catalogue commits atomically and reads only under a transaction-bound authorized scope', () => {
  assert.deepEqual(query(`BEGIN; ${issue('record')} ${install} ${record} ROLLBACK; ${counts}`), ['t', 'recorded', '0|0|0|0|0']);
  assert.deepEqual(query(`BEGIN; ${issue('record')} ${install} ${record} COMMIT;
BEGIN; ${issue('record')} ${install} ${record} COMMIT; ${counts}`), ['t', 'recorded', 't', 'duplicate', '1|1|1|1|1']);
  for (const substitution of [{ sig: 'changed-signature' }, { unapprovedEnvelopeField: true }]) {
    const changed = sqlText(JSON.stringify({ ...JSON.parse(transition), ...substitution }));
    const changedRecord = `SELECT phase88.record_observation('fixture-item', 'v1', 'Made-up folder item', ${sqlText(label)}::jsonb, ${changed}::jsonb);`;
    assert.throws(() => query(`BEGIN; ${issue('record')} ${install} ${changedRecord} ROLLBACK;`), /Invalid observation or signed fact binding/);
  }
  assert.deepEqual(query(`SET ROLE phase88_app;
SELECT set_config('phase88.tenant', 'fixture-tenant', false);
SELECT count(*) FROM phase88.catalogue;`), ['fixture-tenant', '0']);

  assert.deepEqual(query(`BEGIN; ${issue('read')} ${install}
SELECT item_id, name, label->'handling', label->'compartments', source_id FROM phase88.catalogue;
${install}
COMMIT;
BEGIN; SELECT pg_current_xact_id() IS NOT NULL; SET LOCAL ROLE phase88_app; ${install} SELECT count(*) FROM phase88.catalogue; COMMIT;`),
  ['t', 'fixture-item|Made-up folder item|["local"]|["fictional"]|fixture-source', 'f', 't', 'f', '0']);

  for (const [scope, expected] of [
    [{ ttl: -1 }, ['f', '0']],
    [{ audience: 'untrusted-audience' }, ['f', '0']],
    [{ mission: 'an-unrelated-mission' }, ['t', '0']],
    [{ tenant: 'an-unrelated-tenant' }, ['t', '0']],
    [{ sourceId: 'an-unrelated-source' }, ['t', '0']],
    [{ policyRevision: 'an-unrelated-policy' }, ['t', '0']],
    [{ labelJson: JSON.stringify({ ...fixtureLabel, compartments: [] }) }, ['t', '0']],
  ] as const) {
    assert.deepEqual(query(`BEGIN; ${issue('read', scope)} ${install} SELECT count(*) FROM phase88.catalogue; ROLLBACK;`), expected);
  }

  assert.deepEqual(query(`BEGIN; ${issue('read')}
SELECT phase88.install_clearance(:'claims', decode(repeat('00', 32), 'hex')); SELECT count(*) FROM phase88.catalogue; ROLLBACK;`), ['f', '0']);
  assert.throws(() => query(`BEGIN; ${issue('read')} ${install} ${record}`), /no verified write scope/);
  assert.throws(() => query('SET ROLE phase88_app; SELECT key FROM phase88_private.verifier_key;'), /permission denied/);
  assert.throws(() => query('SET ROLE phase88_app; SELECT tenant FROM phase88_private.clearance;'), /permission denied/);
  assert.throws(() => query('SET ROLE phase88_app; TRUNCATE phase88.catalogue;'), /permission denied/);
});

test('a signed synthetic observation reaches the Data Map only through the verified HTTP and PostgreSQL scope', { timeout: 30_000 }, async (t) => {
  const ingestDefault: Label = { scale: 'org', level: 'Internal', compartments: ['ONE'], releasability: ['CAN'], handling: ['local-only'] };
  const sourceLabel: Label = { scale: 'org', level: 'Confidential', compartments: ['TWO'], releasability: ['CAN', 'GBR'], handling: ['no-agent-tools'] };
  const itemLabel: Label = { ...sourceLabel, compartments: ['ONE', 'TWO'], releasability: ['CAN'], handling: ['local-only', 'no-agent-tools'] };
  const scope: CatalogueScope = {
    tenant: 'tracer-tenant', subject: 'made-up-reader', mission: 'tracer-mission', sourceId: 'metadata-only-root',
    policyRevision: 'tracer-policy-v1', expiresAt: Math.floor(Date.now() / 1000) + 45, label: itemLabel,
  };
  const fixtureCredential = randomBytes(32).toString('base64url');
  const server = createServer(createDataMapHandler({
    verifyRequest: async (request) => request.headers.authorization === `Bearer ${fixtureCredential}` ? scope : undefined,
    readCatalogue,
  }));
  const listen = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((done) => { server.close(() => done()); }));
  await listen;
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const snapshot = async (mission: string, authenticated = true): Promise<DataMapSnapshot> => {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/data-map?mission=${encodeURIComponent(mission)}`, {
      headers: authenticated ? { authorization: `Bearer ${fixtureCredential}` } : {},
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return await response.json() as DataMapSnapshot;
  };
  const empty = await snapshot(scope.mission);
  assert.deepEqual(empty, { items: [] });

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const factBytes = (payload: unknown): Buffer => Buffer.concat([Buffer.from('phase88-fixture-label-fact-v1\n'), canonicalBytes(payload)]);
  const metadata = {
    key: 'example-file', sourceVersion: 'v1', name: '<Fictional & item>', sourceMark: 'C',
    get body(): never { throw new Error('A metadata observation must never open the file body.'); },
  };
  const intake: SyntheticRecordDependencies = {
    policy: { revision: scope.policyRevision, scales: SCALE_PRESETS, ingestDefault, sourceMarks: { C: sourceLabel } },
    observeMetadata: async () => metadata,
    signTransition: async (payload) => sign(null, factBytes(payload), privateKey).toString('base64url'),
    recordCatalogue,
  };
  assert.equal(await recordSyntheticObservation(scope, { ...intake, policy: undefined }), 'refused');
  const unknownMark = { ...intake, observeMetadata: async () => ({
    key: metadata.key, sourceVersion: metadata.sourceVersion, name: metadata.name, sourceMark: 'unknown',
  }) };
  assert.equal(await recordSyntheticObservation(scope, unknownMark), 'refused');
  const unmarked: SyntheticRecordDependencies = {
    ...intake,
    observeMetadata: async () => ({ key: metadata.key, sourceVersion: metadata.sourceVersion, name: metadata.name, sourceMark: null }),
    recordCatalogue: async (_verified, record) => {
      assert.deepEqual(record.label, ingestDefault);
      return 'recorded';
    },
  };
  assert.equal(await recordSyntheticObservation({ ...scope, label: ingestDefault }, unmarked), 'recorded');
  assert.deepEqual(await snapshot(scope.mission), empty);
  assert.equal(await recordSyntheticObservation(scope, intake), 'recorded');
  assert.equal(await recordSyntheticObservation(scope, intake), 'duplicate');

  const received = await snapshot(scope.mission);
  assert.equal(received.items.length, 1);
  const [{ itemId }] = received.items;
  assert.deepEqual(received, { items: [{ itemId, sourceId: scope.sourceId, name: metadata.name, label: itemLabel }] });
  assert.deepEqual(await snapshot(scope.mission, false), empty);
  assert.deepEqual(await snapshot('unrelated-mission'), empty);

  const facts = query(`SELECT fact FROM phase88.signed_fact WHERE tenant = ${sqlText(scope.tenant)}`);
  assert.equal(facts.length, 1);
  const signedFact = JSON.parse(facts[0]) as CatalogueRecord['signedFact'];
  assert.equal(signedFact.payload.policyRevision, scope.policyRevision);
  assert.equal(signedFact.payload.itemId, itemId);
  assert.deepEqual(signedFact.payload.label, itemLabel);
  assert.ok(verify(null, factBytes(signedFact.payload), publicKey, Buffer.from(signedFact.sig, 'base64url')));

  const webview = { html: '' };
  const open = registerDataMapPanel({
    register(command, run) {
      assert.equal(command, 'nearAi.openDataMap');
      return run;
    },
    createPanel: () => ({ webview, onDidDispose: () => undefined }),
    read: () => snapshot(scope.mission),
  });
  await open();
  assert.match(webview.html, /&lt;Fictional &amp; item&gt;/);
  assert.match(webview.html, /Confidential/);
  assert.ok(!webview.html.includes(fixtureCredential));
});
