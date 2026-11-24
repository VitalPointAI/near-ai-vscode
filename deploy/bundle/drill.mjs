#!/usr/bin/env node
// The recovery plan and the restore drill (D-73; CP-2, CP-9, CP-10). deploy/runbooks/recovery-plan.md says when and how to use it.
//
//   node deploy/bundle/drill.mjs plan --site <site file> --site-dir <per-release site folder>
//        the recovery order, each group's backups with their longest gap (read from the rendered releases and the substituted RKE2 config,
//        never from values text), the RTO and RPO settings, and every schedule that cannot meet the RPO (exit 1)
//   node deploy/bundle/drill.mjs verify --site <file> --site-dir <dir> --components <postgres,registry-input,escrow,opensearch,volume>
//        --confirm <siteName> --out <dir> [--operator <name>] [--bundle <retained bundle> --public-key <pem>] [--escrow-record <file>]
//        [--opensearch-auth-file <file>] [--volume <namespace/pvc>] [--lab]
//        restores into scratch copies only (pods labelled sterling-drill=scratch, renamed indices, new volumes), never live data, and
//        removes every scratch object even when a step fails; writes one sterling-restore-test/1 record
//   node deploy/bundle/drill.mjs record --check <file>
//   node deploy/bundle/drill.mjs record --add-step <file> --group <id> --component <name> --kind manual --backup-taken <iso|none>
//        --started <iso> --finished <iso> --result <pass|fail> --check <text> [--notes <text>]
//
// The lab-only destructive steps (etcd-reset, openbao-restore) are never run by the drill: with --lab, verify prints their runbook steps
// and asks for record --add-step; without --lab they are refused. Credentials come from files and travel on stdin (curl --config), never
// on a command line. kubectl from KUBECTL or PATH. Node built-ins only.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBundle } from './check.mjs';
import { checkEscrow } from './escrow.mjs';
import { configMapData } from './install.mjs';
import { readImagesLock, resolveImage } from './lib/locks.mjs';
import { MANIFEST } from './lib/manifest.mjs';
import { GROUP_IDS, RECORD_FORMAT, RECOVERY_GROUPS, computeRecord, computeStep, cronIntervalMinutes, scheduleProblems, validateRecord } from './lib/recovery.mjs';
import { isEnabled, listReleases, loadSite, renderRelease, splitDocs, substituteSite } from './lib/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const COMPONENTS = Object.freeze(['postgres', 'registry-input', 'escrow', 'opensearch', 'volume']);
export const LAB_ONLY = Object.freeze({
  'etcd-reset': 'deploy/runbooks/backup-and-restore.md (etcd): rke2 server --cluster-reset --cluster-reset-restore-path=<snapshot> with the escrowed token',
  'openbao-restore': 'deploy/runbooks/backup-and-restore.md (OpenBao Raft snapshots): bao operator raft snapshot restore, with the HSM or the Shamir shares',
});
/** The recovery group each verify component proves. */
const COMPONENT_GROUP = { 'registry-input': 'platform', escrow: 'platform', postgres: 'identity', opensearch: 'audit', volume: 'sessions' };
const VOLUME_GROUP = { 'sterling-identity': 'identity', 'sterling-hubs': 'hubs', 'theia-cloud': 'sessions' };

const defaultRun = (command, args, { input } = {}) => spawnSync(command, args, { encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 });
const kubectl = () => process.env.KUBECTL || 'kubectl';
const must = (result, what) => {
  if (result.error) throw new Error(`${what} could not run (${result.error.message}).`);
  if (result.status !== 0) throw new Error(`${what} failed: ${String(result.stderr || result.stdout || '').trim().split('\n').slice(-2).join(' ')}`);
  return result.stdout ?? '';
};
const nowIso = () => new Date().toISOString();

// ---- plan -------------------------------------------------------------------------------------------------------------------------------

const docNamed = (yaml, kind, name) => splitDocs(yaml).find((doc) => new RegExp(`^kind:\\s*${kind}\\s*$`, 'm').test(doc) && new RegExp(`^\\s+name:\\s*${name}\\s*$`, 'm').test(doc));
const yamlScalar = (doc, key) => /"([^"]+)"|'([^']+)'|(\S.*)/.exec(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm').exec(doc ?? '')?.[1] ?? '')?.slice(1).find(Boolean)?.trim();

/** Each backup's schedule from the rendered site: { backup: { source, cron, gap } | null }, or 'n/a' when the backup does not apply. */
export function readSchedules({ root = ROOT, site, siteDir, render = (release) => renderRelease(root, release, { site, siteDir }) }) {
  const enabled = new Set(listReleases(root).filter((release) => isEnabled(release, site)).map((release) => release.name));
  const schedule = (source, cron) => (cron ? { source, cron, gap: cronIntervalMinutes(cron) } : null);
  const config = substituteSite(readFileSync(path.join(root, 'deploy/rke2/config.yaml'), 'utf8'), site, 'deploy/rke2/config.yaml');
  const schedules = { etcd: schedule('deploy/rke2/config.yaml etcd-snapshot-schedule-cron', yamlScalar(config, 'etcd-snapshot-schedule-cron')) };
  schedules['openbao-raft'] = schedule('CronJob openbao-raft-snapshot', yamlScalar(docNamed(render('openbao'), 'CronJob', 'openbao-raft-snapshot'), 'schedule'));
  schedules['postgres-dump'] = schedule('CronJob sterling-postgres-dump', yamlScalar(docNamed(render('sterling-postgres'), 'CronJob', 'sterling-postgres-dump'), 'schedule'));
  schedules.longhorn = enabled.has('sterling-storage')
    ? schedule('RecurringJob sterling-daily-backup', yamlScalar(docNamed(render('sterling-storage'), 'RecurringJob', 'sterling-daily-backup'), 'cron')) : 'n/a';
  const policy = docNamed(render('opensearch'), 'ConfigMap', 'opensearch-snapshot-policy');
  let cron = null;
  if (policy) {
    try { cron = JSON.parse(Object.values(configMapData(policy))[0])?.creation?.schedule?.cron?.expression ?? null; } catch { cron = null; }
  }
  schedules['opensearch-snapshot'] = schedule('ConfigMap opensearch-snapshot-policy', cron);
  return schedules;
}

/** The plan: printed lines and problems. */
export function planRecovery({ root = ROOT, site, siteDir, render }) {
  const schedules = readSchedules({ root, site, siteDir, render });
  const recovery = { rtoMinutes: site.recovery?.rtoMinutes, rpoMinutes: site.recovery?.rpoMinutes };
  const set = (value) => (Number.isFinite(value) ? `${value} minutes` : 'not set (owner item)');
  const lines = [`RTO ${set(recovery.rtoMinutes)}, RPO ${set(recovery.rpoMinutes)} (site-wide, recovery in the site file)`];
  for (const group of RECOVERY_GROUPS) {
    const backups = group.backups.map((backup) => {
      const value = schedules[backup];
      return value === 'n/a' ? `${backup}: your site's own storage backups (not Longhorn)` : value ? `${backup}: ${value.source} "${value.cron}", longest gap ${value.gap} minutes` : `${backup}: no schedule found`;
    });
    lines.push(`${group.stage.padEnd(7)} ${group.id.padEnd(15)} ${group.label}${backups.length ? `\n${' '.repeat(24)}${backups.join(`\n${' '.repeat(24)}`)}` : ''}`);
  }
  const applicable = Object.fromEntries(Object.entries(schedules).filter(([, value]) => value !== 'n/a'));
  return { lines, problems: scheduleProblems(RECOVERY_GROUPS, applicable, recovery), schedules };
}

// ---- verify drivers ---------------------------------------------------------------------------------------------------------------------

/** A scratch pod manifest: restricted, no service account token, labelled sterling-drill=scratch, image from the site registry by digest. */
function scratchPod({ name, namespace, image, volumes, mounts, runAsUser }) {
  return {
    apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace, labels: { 'sterling-drill': 'scratch' } },
    spec: {
      restartPolicy: 'Never', automountServiceAccountToken: false,
      securityContext: { runAsNonRoot: true, ...(runAsUser ? { runAsUser, runAsGroup: runAsUser, fsGroup: runAsUser } : {}), seccompProfile: { type: 'RuntimeDefault' } },
      containers: [{ name: 'drill', image, imagePullPolicy: 'IfNotPresent', command: ['sleep', '3600'],
        securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } }, volumeMounts: mounts }],
      volumes,
    },
  };
}
const apply = (run, manifest, what) => must(run(kubectl(), ['apply', '-f', '-'], { input: JSON.stringify(manifest) }), `kubectl apply ${what}`);
const execIn = (run, namespace, pod, script, what) => must(run(kubectl(), ['exec', '-n', namespace, pod, '--', 'sh', '-c', script]), what);
const getJson = (run, args, what) => JSON.parse(must(run(kubectl(), [...args, '-o', 'json']), `kubectl ${what}`));
/** The time a dump named keycloak-YYYYMMDDTHHMMSSZ.dump was taken. */
export const dumpTime = (name) => {
  const match = /keycloak-(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z\.dump$/.exec(name);
  return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z` : null;
};

/** postgres: the newest Keycloak dump restored into a scratch Postgres with no network listener, then checked. */
export function postgresDriver({ run, site, root = ROOT, runId, log }) {
  const namespace = 'sterling-identity';
  const name = `drill-postgres-${runId}`;
  const cronJob = getJson(run, ['get', 'cronjob', 'sterling-postgres-dump', '-n', namespace], 'get cronjob sterling-postgres-dump');
  for (const job of cronJob.status?.active ?? []) {
    log(`drill: waiting for the running dump ${job.name} to finish`);
    must(run(kubectl(), ['wait', '-n', namespace, '--for=condition=complete', '--timeout=1800s', `job/${job.name}`]), `wait for ${job.name}`);
  }
  const image = resolveImage(readImagesLock(root), 'sterling/postgres', site.registry).ref;
  try {
    log(`drill: starting scratch pod ${namespace}/${name}`);
    apply(run, scratchPod({ name, namespace, image, runAsUser: 26,
      volumes: [{ name: 'dumps', persistentVolumeClaim: { claimName: 'sterling-postgres-dumps', readOnly: true } }, { name: 'scratch', emptyDir: {} }],
      mounts: [{ name: 'dumps', mountPath: '/dumps', readOnly: true }, { name: 'scratch', mountPath: '/scratch' }] }), `pod ${name}`);
    must(run(kubectl(), ['wait', '-n', namespace, '--for=condition=Ready', '--timeout=300s', `pod/${name}`]), `wait for pod ${name}`);
    const dump = execIn(run, namespace, name, 'ls -1t /dumps/keycloak-*.dump | head -n 1', 'find the newest dump').trim();
    if (!dump) throw new Error('no keycloak-*.dump was found on sterling-postgres-dumps.');
    log(`drill: restoring ${path.basename(dump)} into the scratch database (Unix socket only)`);
    execIn(run, namespace, name, 'initdb -D /scratch/data -U postgres --auth=trust >/dev/null && mkdir -p /scratch/run '
      + '&& pg_ctl -D /scratch/data -o "-c listen_addresses= -k /scratch/run" -w start >/dev/null && createdb -h /scratch/run -U postgres keycloak', 'initdb in the scratch pod');
    execIn(run, namespace, name, `pg_restore -h /scratch/run -U postgres --no-owner --no-privileges -d keycloak '${dump.replace(/'/g, '')}'`, 'pg_restore');
    const counts = execIn(run, namespace, name, 'psql -h /scratch/run -U postgres -d keycloak -At -F, -c "select (select count(*) from realm where name = \'sterling\'), (select count(*) from user_entity)"', 'psql').trim();
    const [realms, users] = counts.split(',').map(Number);
    const pass = realms === 1 && users >= 1;
    return { result: pass ? 'pass' : 'fail', backupTakenAt: dumpTime(dump), check: `realm sterling rows ${realms} (need 1), user_entity rows ${users} (need 1 or more) in ${path.basename(dump)}` };
  } finally {
    run(kubectl(), ['delete', 'pod', '-n', namespace, name, '--ignore-not-found', '--wait=false']);
  }
}

/** registry-input: the retained bundle passes checkBundle with your organization's key. */
export async function registryInputDriver({ bundle, publicKey, check = checkBundle }) {
  if (!bundle || !publicKey) throw new Error('registry-input needs --bundle <retained bundle> and --public-key <your organization\'s key>.');
  const result = await check({ dir: bundle, publicKey });
  const manifest = existsSync(path.join(bundle, MANIFEST)) ? JSON.parse(readFileSync(path.join(bundle, MANIFEST), 'utf8')) : {};
  return { result: result.ok ? 'pass' : 'fail', backupTakenAt: manifest.created ?? null,
    check: result.ok ? `bundle ${manifest.version} checked: signature, archive digest and every item digest` : `bundle refused: ${result.problems.join('; ')}` };
}

/** escrow: the escrowed longhorn-crypto record is current. */
export function escrowDriver({ record, run, check = checkEscrow }) {
  if (!record) throw new Error('escrow needs --escrow-record <escrow-record.json>.');
  const result = check({ record, run });
  const created = JSON.parse(readFileSync(record, 'utf8')).createdAt ?? null;
  return { result: result.ok ? 'pass' : 'fail', backupTakenAt: created, check: result.ok ? 'escrow current: every longhorn-crypto key matches its digest' : result.problems.join('; ') };
}

const curlQuote = (text) => `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;

/** opensearch: the newest snapshot's audit indices restored beside the live data under drill-<run id>-, counted, and deleted. */
export function openSearchDriver({ run, authFile, runId, log }) {
  if (!authFile) throw new Error('opensearch needs --opensearch-auth-file <file with { "username", "password" }>.');
  const auth = JSON.parse(readFileSync(authFile, 'utf8'));
  const namespace = 'sterling-logging';
  const pod = getJson(run, ['get', 'pods', '-n', namespace, '-l', 'app.kubernetes.io/name=opensearch'], 'get opensearch pods').items?.[0]?.metadata?.name;
  if (!pod) throw new Error('no OpenSearch pod in sterling-logging.');
  const call = (method, apiPath, body) => JSON.parse(must(run(kubectl(), ['exec', '-i', '-n', namespace, pod, '--', 'curl', '--config', '-'], {
    input: [`url = ${curlQuote(`https://localhost:9200/${apiPath}`)}`, `request = ${curlQuote(method)}`, `user = ${curlQuote(`${auth.username}:${auth.password}`)}`,
      `cacert = ${curlQuote('/usr/share/opensearch/config/certs/ca.crt')}`, `header = ${curlQuote('Content-Type: application/json')}`,
      ...(body ? [`data-binary = ${curlQuote(JSON.stringify(body))}`] : []), 'fail-with-body', 'silent', 'show-error'].join('\n'),
  }), `OpenSearch ${method} ${apiPath}`) || 'null');
  const prefix = `drill-${runId}-`;
  try {
    const snapshots = (call('GET', '_snapshot/sterling-snapshots/_all')?.snapshots ?? []).filter((snapshot) => snapshot.state === 'SUCCESS')
      .sort((a, b) => a.end_time_in_millis - b.end_time_in_millis);
    const newest = snapshots.at(-1);
    if (!newest) throw new Error('repository sterling-snapshots holds no successful snapshot.');
    log(`drill: restoring audit-* from ${newest.snapshot} as ${prefix}*`);
    call('POST', `_snapshot/sterling-snapshots/${newest.snapshot}/_restore?wait_for_completion=true`,
      { indices: 'audit-*', rename_pattern: '(.+)', rename_replacement: `${prefix}$1`, include_global_state: false });
    const count = call('GET', `${prefix}*/_count`)?.count ?? 0;
    return { result: count > 0 ? 'pass' : 'fail', backupTakenAt: new Date(newest.end_time_in_millis).toISOString(),
      check: `${count} documents in the restored copies of audit-* from ${newest.snapshot} (need more than 0)` };
  } finally {
    // Wildcard deletes may be refused (action.destructive_requires_name), so every drill index is deleted by name.
    let indices = [];
    try { indices = (call('GET', `_cat/indices/${prefix}*?format=json`) ?? []).map((index) => index.index); } catch { indices = []; }
    for (const index of indices.filter((name) => name.startsWith(prefix))) run(kubectl(), ['exec', '-i', '-n', namespace, pod, '--', 'curl', '--config', '-'], {
      input: [`url = ${curlQuote(`https://localhost:9200/${index}`)}`, 'request = "DELETE"', `user = ${curlQuote(`${auth.username}:${auth.password}`)}`,
        `cacert = ${curlQuote('/usr/share/opensearch/config/certs/ca.crt')}`, 'silent'].join('\n'),
    });
  }
}

/** volume: the newest Longhorn backup of one volume restored into a new volume through a temporary class with the site class's parameters. */
export function volumeDriver({ run, site, root = ROOT, volume, runId, log }) {
  if (!/^[a-z0-9-]+\/[a-z0-9.-]+$/.test(volume ?? '')) throw new Error('volume needs --volume <namespace/pvc>.');
  const [namespace, claim] = volume.split('/');
  const pvc = getJson(run, ['get', 'pvc', '-n', namespace, claim], `get pvc ${volume}`);
  const backups = (getJson(run, ['get', 'backups.longhorn.io', '-n', 'longhorn-system'], 'get Longhorn backups').items ?? [])
    .filter((backup) => backup.status?.volumeName === pvc.spec.volumeName && backup.status?.state === 'Completed')
    .sort((a, b) => Date.parse(a.status.backupCreatedAt) - Date.parse(b.status.backupCreatedAt));
  const newest = backups.at(-1);
  if (!newest) throw new Error(`volume ${pvc.spec.volumeName} (${volume}) has no completed Longhorn backup.`);
  const siteClass = getJson(run, ['get', 'storageclass', site.storageClass], `get storageclass ${site.storageClass}`);
  const name = `drill-${runId}`;
  const image = resolveImage(readImagesLock(root), 'sterling/postgres', site.registry).ref;
  try {
    log(`drill: restoring backup ${newest.metadata.name} of ${volume} into a new volume`);
    apply(run, { apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', metadata: { name, labels: { 'sterling-drill': 'scratch' } }, provisioner: siteClass.provisioner,
      reclaimPolicy: 'Delete', volumeBindingMode: 'Immediate', parameters: { ...siteClass.parameters, fromBackup: newest.status.url } }, `storageclass ${name}`);
    apply(run, { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name, namespace, labels: { 'sterling-drill': 'scratch' } },
      spec: { storageClassName: name, accessModes: ['ReadWriteOnce'], resources: { requests: { storage: pvc.spec.resources.requests.storage } } } }, `pvc ${name}`);
    apply(run, scratchPod({ name, namespace, image, runAsUser: 26, volumes: [{ name: 'restored', persistentVolumeClaim: { claimName: name, readOnly: true } }],
      mounts: [{ name: 'restored', mountPath: '/restored', readOnly: true }] }), `pod ${name}`);
    must(run(kubectl(), ['wait', '-n', namespace, '--for=condition=Ready', '--timeout=900s', `pod/${name}`]), `wait for pod ${name}`);
    const files = Number(execIn(run, namespace, name, 'find /restored -type f | wc -l', 'count files').trim());
    return { result: files > 0 ? 'pass' : 'fail', backupTakenAt: newest.status.backupCreatedAt,
      check: `${files} files in the restore of ${newest.metadata.name}, opened with the cluster's longhorn-crypto key (need more than 0)` };
  } finally {
    run(kubectl(), ['delete', 'pod', '-n', namespace, name, '--ignore-not-found', '--wait=false']);
    run(kubectl(), ['delete', 'pvc', '-n', namespace, name, '--ignore-not-found', '--wait=false']);
    run(kubectl(), ['delete', 'storageclass', name, '--ignore-not-found']);
  }
}

/**
 * verify: refuses before any runner call unless `confirm` is the site's name and every component is known (lab-only steps only with `lab`).
 * Runs each driver, records not-run components with their reason, and returns the sterling-restore-test/1 record.
 */
export async function verifyDrill({ root = ROOT, site, components, confirm, lab = false, run = defaultRun, log = console.log, options = {}, drivers = {}, operator = 'unnamed' }) {
  if (!confirm || confirm !== site.siteName) throw new Error(`verify touches site ${site.siteName}; name it with --confirm ${site.siteName}.`);
  const unknown = components.filter((component) => !COMPONENTS.includes(component) && !(component in LAB_ONLY));
  if (unknown.length) throw new Error(`unknown component${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}; choose from ${[...COMPONENTS, ...Object.keys(LAB_ONLY)].join(', ')}.`);
  const labOnly = components.filter((component) => component in LAB_ONLY);
  if (labOnly.length && !lab) throw new Error(`${labOnly.join(' and ')} ${labOnly.length > 1 ? 'are' : 'is'} lab-only and destructive; the drill never runs ${labOnly.length > 1 ? 'them' : 'it'} at a site.`);
  for (const component of labOnly) log(`drill: ${component} is not run by the drill. Follow ${LAB_ONLY[component]}, then record it with drill.mjs record --add-step.`);
  const runId = options.runId ?? randomBytes(4).toString('hex');
  const opensearchOn = listReleases(root).some((release) => release.name === 'opensearch' && isEnabled(release, site));
  const all = {
    postgres: () => postgresDriver({ run, site, root, runId, log }),
    'registry-input': () => registryInputDriver({ bundle: options.bundle, publicKey: options.publicKey }),
    escrow: () => escrowDriver({ record: options.escrowRecord, run }),
    opensearch: () => openSearchDriver({ run, authFile: options.opensearchAuthFile, runId, log }),
    volume: () => volumeDriver({ run, site, root, volume: options.volume, runId, log }),
    ...drivers,
  };
  const startedAt = nowIso();
  const steps = [];
  for (const component of components.filter((name) => COMPONENTS.includes(name))) {
    const group = component === 'volume' ? VOLUME_GROUP[String(options.volume).split('/')[0]] ?? 'sessions' : COMPONENT_GROUP[component];
    const stepStart = nowIso();
    let outcome;
    if (component === 'opensearch' && !opensearchOn) outcome = { result: 'not-run', backupTakenAt: null, check: 'not run: the opensearch release is not enabled at this site' };
    else if (component === 'volume' && site.storageProvider !== 'longhorn') outcome = { result: 'not-run', backupTakenAt: null, check: `not run: storageProvider is ${site.storageProvider}, not longhorn` };
    else {
      try { outcome = await all[component](); } catch (error) { outcome = { result: 'fail', backupTakenAt: null, check: `failed: ${error.message}` }; }
    }
    steps.push(computeStep({ group, component, kind: 'verify', backupTakenAt: outcome.backupTakenAt ?? null, startedAt: stepStart, finishedAt: nowIso(),
      result: outcome.result, check: outcome.check }, site.recovery?.rpoMinutes));
    log(`drill: ${component}: ${outcome.result} (${outcome.check})`);
  }
  steps.sort((a, b) => GROUP_IDS.indexOf(a.group) - GROUP_IDS.indexOf(b.group));
  return computeRecord({ format: RECORD_FORMAT, site: site.siteName, bundleVersion: options.bundleVersion ?? null, scenario: 'verify', startedAt, finishedAt: nowIso(),
    operator, steps, findings: steps.filter((step) => step.result === 'fail').map((step) => `${step.component}: ${step.check}`), correctiveActions: [],
    rtoTargetMinutes: site.recovery?.rtoMinutes ?? null, notes: '' });
}

/** Appends a manual step to a record after validating the result. */
export function addStep(record, step, rpoTargetMinutes) {
  const next = computeRecord({ ...record, steps: [...record.steps, computeStep({ ...step, kind: step.kind ?? 'manual' }, rpoTargetMinutes)] });
  const problems = validateRecord(next);
  if (problems.length) throw new Error(`the step is not valid: ${problems.join('; ')}`);
  return next;
}

// ---- CLI ------------------------------------------------------------------------------------------------------------------------------

const USAGE = `usage: node deploy/bundle/drill.mjs <plan|verify|record> [flags]   (deploy/runbooks/recovery-plan.md)
  plan    --site <file> --site-dir <dir>
  verify  --site <file> --site-dir <dir> --components <${COMPONENTS.join(',')}> --confirm <siteName> --out <dir> [--operator <name>]
          [--bundle <dir> --public-key <pem>] [--escrow-record <file>] [--opensearch-auth-file <file>] [--volume <namespace/pvc>] [--lab]
  record  --check <file>
  record  --add-step <file> --group <id> --component <name> --kind manual --backup-taken <iso|none> --started <iso> --finished <iso>
          --result <pass|fail> --check <text> [--notes <text>]`;

export async function main(argv, { run = defaultRun, log = console.log, error = console.error, render } = {}) {
  const [command, ...rest] = argv;
  const option = (flag) => { const index = rest.indexOf(flag); return index < 0 ? undefined : rest[index + 1]; };
  if (!['plan', 'verify', 'record'].includes(command)) { log(USAGE); return command === '--help' ? 0 : 2; }
  try {
    if (command === 'record') {
      const adding = rest.includes('--add-step');
      const file = adding ? option('--add-step') : option('--check');
      if (!file) throw new Error(`record needs --check <file> or --add-step <file>.\n${USAGE}`);
      const record = JSON.parse(readFileSync(file, 'utf8'));
      if (!adding) {
        const problems = validateRecord(record);
        for (const problem of problems) error(`record: ${problem}`);
        if (!problems.length) log(`record: ${file} is a valid ${RECORD_FORMAT} record.`);
        return problems.length ? 1 : 0;
      }
      const taken = option('--backup-taken');
      const target = record.steps.find((step) => Number.isFinite(step.rpoTargetMinutes))?.rpoTargetMinutes ?? null;
      const next = addStep(record, { group: option('--group'), component: option('--component'), kind: option('--kind') ?? 'manual',
        backupTakenAt: !taken || taken === 'none' ? null : taken, startedAt: option('--started'), finishedAt: option('--finished'),
        result: option('--result'), check: option('--check'), ...(option('--notes') ? { notes: option('--notes') } : {}) }, target);
      writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
      log(`record: step added to ${file}.`);
      return 0;
    }
    const site = loadSite(option('--site'));
    const siteDir = option('--site-dir');
    if (!siteDir) throw new Error(`${command} needs --site-dir.\n${USAGE}`);
    if (command === 'plan') {
      const { lines, problems } = planRecovery({ site, siteDir, render });
      for (const line of lines) log(line);
      for (const problem of problems) error(`plan: ${problem}`);
      return problems.length ? 1 : 0;
    }
    const out = option('--out');
    if (!out) throw new Error(`verify needs --out <dir>.\n${USAGE}`);
    const record = await verifyDrill({ site, confirm: option('--confirm'), lab: rest.includes('--lab'), run, log, operator: option('--operator') ?? 'unnamed',
      components: String(option('--components') ?? '').split(',').map((item) => item.trim()).filter(Boolean),
      options: { bundle: option('--bundle'), publicKey: option('--public-key'), escrowRecord: option('--escrow-record'),
        opensearchAuthFile: option('--opensearch-auth-file'), volume: option('--volume') } });
    mkdirSync(out, { recursive: true });
    const file = path.join(out, `restore-test-${site.siteName}-${record.startedAt.replace(/[:.]/g, '')}.json`);
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    log(`drill: record ${file}`);
    return record.steps.some((step) => step.result === 'fail') ? 1 : 0;
  } catch (problem) {
    error(`drill: ${problem.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
