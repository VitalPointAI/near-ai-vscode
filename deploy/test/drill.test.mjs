// The recovery plan and the restore drill (47-27, D-73): the record and its validator, the cron interval, the confirm and lab refusals, and
// every driver's command sequence with a fake kubectl, including that scratch objects are removed when a step fails. No cluster.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { addStep, escrowDriver, main, openSearchDriver, planRecovery, postgresDriver, registryInputDriver, verifyDrill, volumeDriver } from '../bundle/drill.mjs';
import { RECORD_FORMAT, computeRecord, computeStep, cronIntervalMinutes, validateRecord } from '../bundle/lib/recovery.mjs';
import { loadSite } from '../bundle/lib/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CI = { ...loadSite(path.join(ROOT, 'deploy/test/fixtures/site.ci.yaml')), recovery: { rtoMinutes: 480, rpoMinutes: 1440 } };
const temp = (prefix) => mkdtempSync(path.join(tmpdir(), prefix));
const quiet = () => {};

/** A fake runner: `answer(args, input)` returns stdout (string or object) or throws to fail the call; every call is recorded. */
function fake(answer) {
  const calls = [];
  const run = (command, args, options = {}) => {
    calls.push({ command, args, input: options.input });
    try {
      const out = answer(args, options.input) ?? '';
      return { status: 0, stdout: typeof out === 'string' ? out : JSON.stringify(out), stderr: '' };
    } catch (error) {
      return { status: 1, stdout: '', stderr: error.message };
    }
  };
  return { run, calls };
}
const argv = (calls) => calls.map((call) => call.args.join(' '));

const step = (overrides = {}) => computeStep({ group: 'identity', component: 'postgres', kind: 'verify', backupTakenAt: '2026-11-24T00:30:00Z',
  startedAt: '2026-11-24T10:00:00Z', finishedAt: '2026-11-24T10:12:00Z', result: 'pass', check: 'realm sterling present', ...overrides }, 1440);
const record = (steps = [step()]) => computeRecord({ format: RECORD_FORMAT, site: 'ci', bundleVersion: '1.0.0', scenario: 'verify', startedAt: '2026-11-24T10:00:00Z',
  finishedAt: '2026-11-24T10:30:00Z', operator: 'operator.one', steps, findings: [], correctiveActions: [], rtoTargetMinutes: 480, notes: '' });

test('validateRecord accepts a complete record and refuses each inconsistency', () => {
  assert.deepEqual(validateRecord(record()), []);
  assert.equal(record().steps[0].achievedRpoMinutes, 570);
  assert.equal(record().steps[0].achievedRtoMinutes, 12);
  assert.equal(record().steps[0].met, true);
  const broken = (change) => validateRecord(record([{ ...step(), ...change }])).join('\n');
  assert.match(broken({ group: 'database' }), /group "database" is not a recovery group/);
  assert.match(broken({ finishedAt: '2026-11-24T09:00:00Z', achievedRtoMinutes: -60 }), /finishes before it starts/);
  assert.match(broken({ achievedRpoMinutes: 10 }), /achievedRpoMinutes is 10, but the times and targets give 570/);
  assert.match(broken({ met: false }), /met is false, but the times and targets give true/);
  assert.match(broken({ result: 'maybe' }), /result must be one of pass, fail, not-run/);
  const late = step({ backupTakenAt: '2026-11-22T00:00:00Z' });
  assert.equal(late.met, false, 'a backup older than the RPO does not meet it');
});

test('cronIntervalMinutes finds the longest gap and refuses what it cannot read', () => {
  assert.equal(cronIntervalMinutes('0 */6 * * *'), 360);
  assert.equal(cronIntervalMinutes('30 1 * * *'), 1440);
  assert.equal(cronIntervalMinutes('*/15 * * * *'), 15);
  assert.equal(cronIntervalMinutes('0 5 * * 1-5'), 3 * 1440, 'Friday to Monday');
  assert.throws(() => cronIntervalMinutes('@daily'), /not a five-field expression/);
  assert.throws(() => cronIntervalMinutes('0 25 * * *'), /out of range/);
});

test('plan reports a schedule that cannot meet the RPO, naming both numbers', () => {
  const render = () => '';
  const { problems } = planRecovery({ site: { ...CI, recovery: { rtoMinutes: 480, rpoMinutes: 60 } }, siteDir: 'unused', render });
  assert.ok(problems.includes('etcd: deploy/rke2/config.yaml etcd-snapshot-schedule-cron "0 */6 * * *" leaves up to 360 minutes between backups, more than the RPO of 60 minutes.'));
  const unset = planRecovery({ site: { ...CI, recovery: undefined }, siteDir: 'unused', render });
  assert.deepEqual(unset.problems, [], 'no target, no problem');
  assert.match(unset.lines[0], /RTO not set \(owner item\), RPO not set \(owner item\)/);
});

test('verify refuses without --confirm, or with another site name, before any runner call', async () => {
  const { run, calls } = fake(() => { throw new Error('no call expected'); });
  await assert.rejects(verifyDrill({ site: CI, components: ['postgres'], run, log: quiet }), /name it with --confirm ci/);
  await assert.rejects(verifyDrill({ site: CI, components: ['postgres'], confirm: 'hq', run, log: quiet }), /name it with --confirm ci/);
  assert.equal(calls.length, 0);
});

/** The kubectl answers of a site with a dump, a scratch pod and the given psql counts. */
const postgresAnswers = ({ counts = '1,42', failRestore = false, active = [] } = {}) => (args) => {
  const text = args.join(' ');
  if (text.startsWith('get cronjob sterling-postgres-dump')) return { status: { active } };
  if (text.startsWith('exec') && text.includes('ls -1t /dumps')) return '/dumps/keycloak-20261124T003000Z.dump\n';
  if (text.startsWith('exec') && text.includes('pg_restore') && failRestore) throw new Error('pg_restore: error: could not read archive');
  if (text.startsWith('exec') && text.includes('psql')) return `${counts}\n`;
  return '';
};

test('the postgres driver restores the newest dump into a scratch pod with no listener, checks it, and removes the pod', () => {
  const { run, calls } = fake(postgresAnswers({ active: [{ name: 'sterling-postgres-dump-1' }] }));
  const outcome = postgresDriver({ run, site: CI, runId: 'r1', log: quiet });
  assert.deepEqual(outcome, { result: 'pass', backupTakenAt: '2026-11-24T00:30:00Z', check: 'realm sterling rows 1 (need 1), user_entity rows 42 (need 1 or more) in keycloak-20261124T003000Z.dump' });
  const lines = argv(calls);
  assert.ok(lines[1].startsWith('wait -n sterling-identity --for=condition=complete --timeout=1800s job/sterling-postgres-dump-1'), 'waits for a running dump');
  const pod = JSON.parse(calls.find((call) => call.args.join(' ') === 'apply -f -').input);
  assert.equal(pod.metadata.labels['sterling-drill'], 'scratch');
  assert.match(pod.spec.containers[0].image, /^registry\.site\.example\/sterling\/postgres@sha256:[0-9a-f]{64}$/);
  assert.equal(pod.spec.securityContext.runAsUser, 26);
  assert.deepEqual(pod.spec.volumes[0], { name: 'dumps', persistentVolumeClaim: { claimName: 'sterling-postgres-dumps', readOnly: true } });
  assert.ok(lines.some((line) => line.includes("listen_addresses= -k /scratch/run")), 'Unix socket only');
  assert.ok(lines.some((line) => line.includes("pg_restore -h /scratch/run -U postgres --no-owner --no-privileges -d keycloak '/dumps/keycloak-20261124T003000Z.dump'")));
  assert.equal(lines.at(-1), 'delete pod -n sterling-identity drill-postgres-r1 --ignore-not-found --wait=false');
  assert.equal(postgresDriver({ run: fake(postgresAnswers({ counts: '0,0' })).run, site: CI, runId: 'r2', log: quiet }).result, 'fail');
  const failing = fake(postgresAnswers({ failRestore: true }));
  assert.throws(() => postgresDriver({ run: failing.run, site: CI, runId: 'r3', log: quiet }), /pg_restore failed/);
  assert.equal(argv(failing.calls).at(-1), 'delete pod -n sterling-identity drill-postgres-r3 --ignore-not-found --wait=false', 'removed even when a step fails');
});

test('the registry-input driver passes only when checkBundle accepts the retained bundle, with its created time as the backup time', async () => {
  const bundle = temp('retained-');
  writeFileSync(path.join(bundle, 'manifest.json'), JSON.stringify({ version: '1.2.0', created: '2026-11-20T08:00:00.000Z' }));
  const good = await registryInputDriver({ bundle, publicKey: 'org.pub', check: async () => ({ ok: true, problems: [] }) });
  assert.deepEqual([good.result, good.backupTakenAt], ['pass', '2026-11-20T08:00:00.000Z']);
  const bad = await registryInputDriver({ bundle, publicKey: 'org.pub', check: async () => ({ ok: false, problems: ['the manifest signature does not verify'] }) });
  assert.deepEqual([bad.result, bad.check], ['fail', 'bundle refused: the manifest signature does not verify']);
  await assert.rejects(registryInputDriver({ bundle }), /needs --bundle <retained bundle> and --public-key/);
});

test('the escrow driver passes only when checkEscrow reports the escrow current', () => {
  const file = path.join(temp('escrow-'), 'escrow-record.json');
  writeFileSync(file, JSON.stringify({ createdAt: '2026-11-01T00:00:00Z' }));
  assert.deepEqual(escrowDriver({ record: file, check: () => ({ ok: true, problems: [] }) }).result, 'pass');
  const stale = escrowDriver({ record: file, check: () => ({ ok: false, problems: ['CRYPTO_KEY_VALUE changed since the escrow'] }) });
  assert.deepEqual([stale.result, stale.check, stale.backupTakenAt], ['fail', 'CRYPTO_KEY_VALUE changed since the escrow', '2026-11-01T00:00:00Z']);
});

test('verify writes one record with a step per driver in recovery order and the site targets copied in', async () => {
  const drivers = {
    postgres: () => ({ result: 'pass', backupTakenAt: new Date(Date.now() - 3_600_000).toISOString(), check: 'ok' }),
    escrow: () => ({ result: 'pass', backupTakenAt: '2026-11-01T00:00:00Z', check: 'escrow current' }),
  };
  const result = await verifyDrill({ site: CI, components: ['postgres', 'escrow'], confirm: 'ci', run: fake(() => '').run, log: quiet, drivers, operator: 'operator.one' });
  assert.deepEqual(validateRecord(result), []);
  assert.deepEqual(result.steps.map((item) => `${item.group}/${item.component}`), ['platform/escrow', 'identity/postgres']);
  assert.ok(result.steps.every((item) => item.rpoTargetMinutes === 1440));
  assert.equal(result.rtoTargetMinutes, 480);
  assert.equal(result.steps[1].met, true);
  assert.equal(result.steps[0].met, false, 'an escrow older than the RPO is recorded as not met');
});

test('record --add-step appends a validated manual step, and record --check exits 1 on an invalid record', async () => {
  const file = path.join(temp('record-'), 'record.json');
  writeFileSync(file, JSON.stringify(record()));
  const add = ['record', '--add-step', file, '--group', 'platform', '--component', 'etcd', '--kind', 'manual', '--backup-taken', '2026-11-24T06:00:00Z',
    '--started', '2026-11-24T10:15:00Z', '--finished', '2026-11-24T10:40:00Z', '--result', 'pass', '--check', 'cluster-reset from the 06:00 snapshot; nodes Ready'];
  assert.equal(await main(add, { log: quiet, error: quiet }), 0);
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(written.steps.at(-1).achievedRpoMinutes, 255);
  assert.equal(await main(['record', '--check', file], { log: quiet, error: quiet }), 0);
  writeFileSync(file, JSON.stringify({ ...written, steps: [{ ...written.steps[0], group: 'unknown' }] }));
  assert.equal(await main(['record', '--check', file], { log: quiet, error: quiet }), 1);
  assert.throws(() => addStep(record(), { group: 'nowhere', component: 'x', backupTakenAt: null, startedAt: '2026-11-24T10:00:00Z', finishedAt: '2026-11-24T10:01:00Z', result: 'pass', check: 'x' }, 1440),
    /is not a recovery group/);
});

const AUTH = { username: 'drill-reader', password: 'opensearch-drill-password-not-real' };

/** OpenSearch through curl --config on stdin: answers by the url line of the config. */
const openSearchAnswers = ({ count = 120, failRestore = false } = {}) => (args, input) => {
  const text = args.join(' ');
  if (text.startsWith('get pods')) return { items: [{ metadata: { name: 'opensearch-cluster-master-0' } }] };
  const url = /url = "([^"]+)"/.exec(input ?? '')?.[1] ?? '';
  if (url.endsWith('_snapshot/sterling-snapshots/_all')) return { snapshots: [{ snapshot: 'old', state: 'SUCCESS', end_time_in_millis: 1 }, { snapshot: 'new', state: 'SUCCESS', end_time_in_millis: Date.parse('2026-11-24T03:00:00Z') }, { snapshot: 'partial', state: 'PARTIAL', end_time_in_millis: 9e12 }] };
  if (url.includes('/_restore') && failRestore) throw new Error('snapshot restore failed');
  if (url.includes('/_restore')) return { accepted: true };
  if (url.endsWith('_count')) return { count };
  if (url.includes('_cat/indices/')) return [{ index: 'drill-r1-audit-2026.11.24' }];
  return {};
};

test('the opensearch driver restores audit-* renamed beside the live data, counts it, and deletes the copies, the credential on stdin only', () => {
  const authFile = path.join(temp('auth-'), 'auth.json');
  writeFileSync(authFile, JSON.stringify(AUTH));
  const { run, calls } = fake(openSearchAnswers());
  const outcome = openSearchDriver({ run, authFile, runId: 'r1', log: quiet });
  assert.deepEqual([outcome.result, outcome.backupTakenAt], ['pass', '2026-11-24T03:00:00.000Z']);
  assert.ok(!argv(calls).join('\n').includes(AUTH.password), 'never in an argv');
  assert.ok(calls.filter((call) => call.input).every((call) => call.input.includes(`user = "${AUTH.username}:${AUTH.password}"`)));
  const restore = calls.find((call) => call.input?.includes('/_restore'));
  assert.match(restore.input, /sterling-snapshots\/new\/_restore/);
  assert.match(restore.input, /\\"rename_replacement\\":\\"drill-r1-\$1\\",\\"include_global_state\\":false/);
  assert.match(calls.at(-1).input, /url = "https:\/\/localhost:9200\/drill-r1-audit-2026\.11\.24"\nrequest = "DELETE"/);
  assert.equal(openSearchDriver({ run: fake(openSearchAnswers({ count: 0 })).run, authFile, runId: 'r1', log: quiet }).result, 'fail');
  const failing = fake(openSearchAnswers({ failRestore: true }));
  assert.throws(() => openSearchDriver({ run: failing.run, authFile, runId: 'r1', log: quiet }), /failed/);
  assert.match(failing.calls.at(-1).input, /request = "DELETE"/, 'the copies are deleted even when the restore fails');
});

/** Longhorn: a PVC, two backups of its volume, the site class, and a file count. */
const volumeAnswers = ({ files = '17', failWait = false } = {}) => (args) => {
  const text = args.join(' ');
  if (text.startsWith('get pvc')) return { spec: { volumeName: 'pvc-1234', resources: { requests: { storage: '10Gi' } } } };
  if (text.startsWith('get backups.longhorn.io')) return { items: [
    { metadata: { name: 'backup-old' }, status: { volumeName: 'pvc-1234', state: 'Completed', backupCreatedAt: '2026-11-22T02:00:00Z', url: 's3://old' } },
    { metadata: { name: 'backup-new' }, status: { volumeName: 'pvc-1234', state: 'Completed', backupCreatedAt: '2026-11-24T02:00:00Z', url: 's3://new' } },
    { metadata: { name: 'backup-other' }, status: { volumeName: 'pvc-9999', state: 'Completed', backupCreatedAt: '2026-11-24T05:00:00Z', url: 's3://other' } }] };
  if (text.startsWith('get storageclass')) return { provisioner: 'driver.longhorn.io', parameters: { encrypted: 'true', 'csi.storage.k8s.io/node-stage-secret-name': 'longhorn-crypto', numberOfReplicas: '3' } };
  if (text.startsWith('wait') && failWait) throw new Error('timed out waiting for the condition');
  if (text.startsWith('exec')) return `${files}\n`;
  return '';
};

test('the volume driver restores the newest backup through a temporary class with the site class parameters, and removes all three objects', () => {
  const { run, calls } = fake(volumeAnswers());
  const outcome = volumeDriver({ run, site: CI, volume: 'theia-cloud/ws-ada', runId: 'r1', log: quiet });
  assert.deepEqual([outcome.result, outcome.backupTakenAt], ['pass', '2026-11-24T02:00:00Z']);
  const applied = calls.filter((call) => call.args.join(' ') === 'apply -f -').map((call) => JSON.parse(call.input));
  assert.deepEqual(applied.map((object) => object.kind), ['StorageClass', 'PersistentVolumeClaim', 'Pod']);
  assert.deepEqual(applied[0].parameters, { encrypted: 'true', 'csi.storage.k8s.io/node-stage-secret-name': 'longhorn-crypto', numberOfReplicas: '3', fromBackup: 's3://new' });
  assert.equal(applied[2].spec.volumes[0].persistentVolumeClaim.readOnly, true);
  assert.ok(applied.every((object) => object.metadata.labels['sterling-drill'] === 'scratch'));
  const deletes = ['delete pod -n theia-cloud drill-r1 --ignore-not-found --wait=false', 'delete pvc -n theia-cloud drill-r1 --ignore-not-found --wait=false',
    'delete storageclass drill-r1 --ignore-not-found'];
  assert.deepEqual(argv(calls).slice(-3), deletes);
  const failing = fake(volumeAnswers({ failWait: true }));
  assert.throws(() => volumeDriver({ run: failing.run, site: CI, volume: 'theia-cloud/ws-ada', runId: 'r1', log: quiet }), /timed out/);
  assert.deepEqual(argv(failing.calls).slice(-3), deletes, 'removed even when the restore never becomes ready');
  assert.equal(volumeDriver({ run: fake(volumeAnswers({ files: '0' })).run, site: CI, volume: 'theia-cloud/ws-ada', runId: 'r1', log: quiet }).result, 'fail');
});

test('components the site does not run are recorded as not-run with the reason, not as failures', async () => {
  const result = await verifyDrill({ site: { ...CI, storageProvider: 'ceph', storageEncryptionAtRest: 'array' }, components: ['volume'], confirm: 'ci',
    run: fake(() => { throw new Error('no call expected'); }).run, log: quiet });
  assert.deepEqual([result.steps[0].result, result.steps[0].check], ['not-run', 'not run: storageProvider is ceph, not longhorn']);
  assert.deepEqual(validateRecord(result), []);
});

test('the lab-only steps are refused outside the lab and never run inside it', async () => {
  const { run, calls } = fake(() => '');
  await assert.rejects(verifyDrill({ site: CI, components: ['etcd-reset'], confirm: 'ci', run, log: quiet }), /lab-only and destructive/);
  const lines = [];
  const result = await verifyDrill({ site: CI, components: ['etcd-reset', 'openbao-restore'], confirm: 'ci', lab: true, run, log: (line) => lines.push(line) });
  assert.equal(calls.length, 0, 'nothing is run');
  assert.deepEqual(result.steps, []);
  assert.match(lines.join('\n'), /etcd-reset is not run by the drill\. Follow .*cluster-reset.*record --add-step/);
  assert.match(lines.join('\n'), /openbao-restore is not run by the drill/);
});
