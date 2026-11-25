// Phase 48.2, plan 01 (D-01, D-11, D-18): the backend evidence service reads a release evidence folder, checks every file against its
// sterling-evidence/1 manifest, and re-judges the judgement with the one status engine (engine/compliance.cjs) against the current time.
// With no trust key configured the release is Not verified; one changed byte makes it Did not verify and nothing from it is shown.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createEvidenceService } from '../extension/src/node/sterling-evidence-service.ts';

// Bundled to workbench/dist/test/; scripts/build.mjs builds engine/compliance.cjs first.
const workbenchRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const engineFile = path.join(workbenchRoot, 'engine', 'compliance.cjs');
const engine = createRequire(engineFile)(engineFile) as {
  JUDGEMENT_FORMAT: string;
  EVIDENCE_FORMAT: string;
  judgementRow(input: unknown, presentation: unknown): unknown;
};

const COMMIT = 'a'.repeat(40);
const BUILT_AT = '2026-11-25T10:00:00.000Z';
const HOUR = 60 * 60 * 1000;
const at = (hours: number) => Date.parse(BUILT_AT) + hours * HOUR;

/** One row with one component whose single statement has one rule and its result. */
function row(control: string, label: string, title: string, window: 'head' | 'audit') {
  const statement = `${control}_smt`;
  const rule = { id: `release.${control}.check`, component: 'workbench', control, statement, kind: 'test', test: { file: `workbench/test/${control}.test.ts`, path: [], name: control } };
  const result = { rule: rule.id, passed: true, reason: 'met', collectedAt: BUILT_AT, commit: COMMIT, window };
  return engine.judgementRow(
    { level: 'unclassified', control, claim: true, responsibility: 'product', components: [{ control, component: 'workbench', level: 'unclassified', responsibility: 'product', statements: [{ id: statement, description: `The workbench supports ${label}.` }], rulesByStatement: { [statement]: [rule] }, results: { [rule.id]: result } }] },
    { label, family: control.split('-')[0], title });
}

/** A release evidence folder: the judgement inside bundle/, a small SBOM, and the manifest over both. */
function releaseFolder(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sterling-release-evidence-'));
  const judgement = {
    format: engine.JUDGEMENT_FORMAT, generatedAt: BUILT_AT, commit: COMMIT, head: COMMIT,
    levels: [{ id: 'unclassified', title: 'Unclassified', kind: 'level', profile: 'profiles/unclassified.json', claim: true, components: ['workbench'], overlays: [] }],
    rows: [row('cm-08', 'CM-8', 'System component inventory', 'head'), row('au-06', 'AU-6', 'Audit record review, analysis, and reporting', 'audit')],
  };
  const files: Record<string, string> = {
    'bundle/dashboard/judgement.json': `${JSON.stringify(judgement, null, 2)}\n`,
    'sbom/sterling-image.cdx.json': '{"bomFormat":"CycloneDX","specVersion":"1.6","components":[]}\n',
  };
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  const manifest = {
    format: engine.EVIDENCE_FORMAT, release: '0.5.0', commit: COMMIT, builtAt: BUILT_AT, subject: `sha256:${'c'.repeat(64)}`, bundle: 'included', package: 'none',
    files: Object.entries(files).map(([name, content]) => ({ path: name, sha256: createHash('sha256').update(content).digest('hex'), size: Buffer.byteLength(content) })),
  };
  writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

function service(evidenceDir: string, clock: { now: number }) {
  return createEvidenceService({ evidenceDir, appRoot: workbenchRoot, now: () => clock.now });
}

test('service: a release folder with no trust key configured is Not verified, its rows re-judged with the injected clock', async () => {
  const clock = { now: at(1) };
  const evidence = await service(releaseFolder(), clock).getEvidence();
  const release = evidence.release;
  assert.equal(release.verification, 'not-verified');
  assert.ok(release.verification === 'not-verified');
  assert.equal(release.reason, 'no-trust-key');
  assert.equal(release.version, '0.5.0');
  assert.equal(release.asOf, BUILT_AT);
  assert.equal(evidence.judgedAt, new Date(clock.now).toISOString());
  assert.deepEqual(release.rows.map((item) => [item.control, item.state, item.source, item.asOf, item.freshness]), [
    ['cm-08', 'met', 'release', BUILT_AT, 'current'],
    ['au-06', 'met', 'release', BUILT_AT, 'current'],
  ]);
  assert.deepEqual(release.levels, [{ id: 'unclassified', title: 'Unclassified', claim: true }]);
});

test('now: 25 hours after the audit result, that row reads Stale on the next call; the head-window row stays as it was', async () => {
  const clock = { now: at(1) };
  const reader = service(releaseFolder(), clock);
  const before = await reader.getEvidence();
  clock.now = at(25);
  const after = await reader.getEvidence();
  assert.ok(before.release.verification === 'not-verified' && after.release.verification === 'not-verified');
  const byControl = (rows: typeof after.release.rows) => Object.fromEntries(rows.map((item) => [item.control, item]));
  assert.equal(byControl(before.release.rows)['au-06']!.state, 'met');
  assert.equal(byControl(after.release.rows)['au-06']!.state, 'stale');
  assert.equal(byControl(after.release.rows)['au-06']!.freshness, 'out-of-date');
  assert.deepEqual(byControl(after.release.rows)['cm-08'], byControl(before.release.rows)['cm-08']);
});

test('changed byte: one changed byte gives Did not verify, naming the file, and no rows', async () => {
  const dir = releaseFolder();
  const file = path.join(dir, 'sbom/sterling-image.cdx.json');
  const bytes = readFileSync(file);
  bytes[2] = bytes[2]! ^ 1;
  writeFileSync(file, bytes);
  const evidence = await service(dir, { now: at(1) }).getEvidence();
  assert.deepEqual(evidence.release, { verification: 'did-not-verify', reason: 'hash', file: 'sbom/sterling-image.cdx.json' });
});

test('absent: no release evidence folder gives none', async () => {
  const evidence = await service(path.join(tmpdir(), `sterling-no-evidence-${process.pid}-${Date.now()}`), { now: at(1) }).getEvidence();
  assert.deepEqual(evidence.release, { verification: 'none' });
});
