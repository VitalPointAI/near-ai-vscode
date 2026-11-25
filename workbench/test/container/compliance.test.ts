// The Compliance view's one focused browser check (48.2-16): each case starts the image with its own evidence mounts and runs that case of
// test/e2e/compliance.spec.ts in a real browser. The fixture folders are made here: a release evidence folder (sterling-evidence/1) whose
// judgement comes from the one status engine, signed with the pinned cosign ($COSIGN, the S1 flags of deploy/bundle/lib/cosign.mjs) and
// throwaway keys, the site trust document and a live feed (Ed25519, as the collector signs it), and the README's published projection.
// Run it with `npm run test:container`; it is not part of `npm test`. Hygiene: test/helpers/docker.ts. Screenshots: COMPLIANCE_SHOTS.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { cosignBinary, signBlob } from '../../../deploy/bundle/lib/cosign.mjs';
import { freePort, removeOwn, runContainer, runPlaywright, testImage, waitHealthy, workbenchRoot } from '../helpers/docker';

const engineFile = path.join(workbenchRoot, 'engine', 'compliance.cjs');
const engine = createRequire(engineFile)(engineFile) as { JUDGEMENT_FORMAT: string; EVIDENCE_FORMAT: string; judgementRow(input: unknown, presentation: unknown): unknown };

const HOUR = 60 * 60 * 1000;
const VERSION = '0.5.0';
const COMMIT = 'a'.repeat(40);
const now = Date.now();
const BUILT_AT = new Date(now - HOUR).toISOString();
const ROOT = mkdtempSync(path.join(tmpdir(), 'sterling-compliance-browser-'));
const KEYS = path.join(ROOT, 'keys');

/** Makes a folder and everything in it readable by the container's user (10001): mkdtemp and cosign write private files. */
function readable(dir: string): string {
  chmodSync(dir, 0o755);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) readable(path.join(dir, entry.name));
    else chmodSync(path.join(dir, entry.name), 0o644);
  }
  return dir;
}
const folder = (name: string): string => { const dir = path.join(ROOT, name); mkdirSync(dir, { recursive: true }); return dir; };

// ---- The release evidence folder ----

type Rule = { id: string; kind: 'test' | 'observation'; collector?: string; subject?: string; window: string; passed?: boolean };
/** One judged row from the engine: one component, one statement, its rules and their results as the release recorded them. */
function row(level: string, control: string, label: string, title: string, rules: Rule[]) {
  const statement = `${control}_smt`;
  const ruleObjects = rules.map((rule) => ({ id: rule.id, component: 'workbench', control, statement, kind: rule.kind,
    ...(rule.kind === 'test' ? { test: { file: `workbench/test/${control}.test.ts`, path: [], name: control } } : { observation: { collector: rule.collector, subject: rule.subject } }) }));
  const results = Object.fromEntries(rules.map((rule) => [rule.id, { rule: rule.id, passed: rule.passed ?? true, reason: rule.passed === false ? (rule.kind === 'test' ? 'test-failed' : 'observation-failed') : 'met', collectedAt: BUILT_AT,
    ...(rule.kind === 'test' ? { commit: COMMIT } : {}), window: rule.window }]));
  return engine.judgementRow(
    { level, control, claim: true, responsibility: 'product', components: [{ control, component: 'workbench', level, responsibility: 'product',
      statements: [{ id: statement, description: `The workbench supports ${label}.` }], rulesByStatement: { [statement]: ruleObjects }, results }] },
    { label, family: control.split('-')[0], title });
}
const testRule = (control: string, window = 'head', passed = true): Rule => ({ id: `release.${control}.check`, kind: 'test', window, passed });

/** A release evidence folder: the judgement over two levels, a small SBOM, and the manifest over both. */
function releaseFolder(name: string): string {
  const dir = folder(name);
  const judgement = {
    format: engine.JUDGEMENT_FORMAT, generatedAt: BUILT_AT, commit: COMMIT, head: COMMIT,
    levels: [
      { id: 'unclassified', title: 'Unclassified', kind: 'level', profile: 'profiles/unclassified.json', claim: true, components: ['workbench'], overlays: [] },
      { id: 'protected-b', title: 'Protected B', kind: 'level', profile: 'profiles/protected-b.json', claim: true, components: ['workbench'], overlays: [] },
    ],
    rows: [
      row('unclassified', 'ac-02', 'AC-2', 'Account management', [testRule('ac-02')]),
      row('unclassified', 'cm-08', 'CM-8', 'System component inventory', [testRule('cm-08')]),
      row('unclassified', 'au-06', 'AU-6', 'Audit record review, analysis, and reporting', [testRule('au-06', 'audit')]),
      // Proven by your site's live facts; the release carries the supplier's reference site results until your site's arrive.
      row('unclassified', 'au-05', 'AU-5', 'Response to audit logging process failures', [
        { id: 'site.au-05.openbao', kind: 'observation', collector: 'site-live', subject: 'openbao-sealed', window: 'live' },
        { id: 'site.au-05.nodes', kind: 'observation', collector: 'site-live', subject: 'nodes', window: 'live' },
      ]),
      row('unclassified', 'si-02', 'SI-2', 'Flaw remediation', [testRule('si-02', 'head', false)]),
      row('protected-b', 'ia-02', 'IA-2', 'Identification and authentication', [testRule('ia-02')]),
      row('protected-b', 'sc-08', 'SC-8', 'Transmission confidentiality and integrity', [testRule('sc-08')]),
    ],
  };
  const files: Record<string, string> = {
    'bundle/dashboard/judgement.json': `${JSON.stringify(judgement, null, 2)}\n`,
    'sbom/sterling-image.cdx.json': '{"bomFormat":"CycloneDX","specVersion":"1.6","components":[]}\n',
  };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
  const manifest = {
    format: engine.EVIDENCE_FORMAT, release: VERSION, commit: COMMIT, builtAt: BUILT_AT, subject: `sha256:${'c'.repeat(64)}`, bundle: 'included', package: 'none',
    files: Object.entries(files).map(([file, content]) => ({ path: file, sha256: createHash('sha256').update(content).digest('hex'), size: Buffer.byteLength(content) })),
  };
  writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

// ---- Keys and signatures: a cosign key pair (ECDSA P-256) for the supplier ----

function cosignKeyPair(prefix: string): void {
  const run = spawnSync(cosignBinary(), ['generate-key-pair', '--output-key-prefix', prefix], { cwd: KEYS, encoding: 'utf8' });
  assert.ok(!run.error, `cosign was not found (${cosignBinary()}); set COSIGN to the pinned cosign (sh compliance/ci/install-tool.sh cosign compliance/out/tools).`);
  assert.equal(run.status, 0, run.stderr);
}
const publicKey = (prefix: string): string => readFileSync(path.join(KEYS, `${prefix}.pub`), 'utf8');
/** Signs `file` with the prefix's key; the Sigstore bundle goes to `bundleFile`. */
const signWith = (prefix: string, file: string, bundleFile: string): void => { signBlob(file, path.join(KEYS, `${prefix}.key`), { bundleFile }); };

let image = '';
const shots = process.env.COMPLIANCE_SHOTS?.trim();

before(async () => {
  image = await testImage();
  process.env.COSIGN_PASSWORD ??= 'compliance-browser-check';
  mkdirSync(KEYS, { recursive: true });
  cosignKeyPair('supplier');
  if (shots) mkdirSync(shots, { recursive: true });
});

after(async () => {
  await removeOwn();
});

const EVIDENCE = '/opt/sterling/evidence';
const TRUST = '/etc/sterling/evidence';
const bind = (source: string, target: string): string[] => ['--mount', `type=bind,source=${source},target=${target},readonly`];

/** Starts the image for one case with its mounts and environment, then runs that case of the spec. */
async function runCase(name: string, testName: string, mounts: string[], env: string[] = [], specEnv: NodeJS.ProcessEnv = {}): Promise<void> {
  const port = await freePort();
  for (let index = 1; index < mounts.length; index += 2) readable(/source=([^,]+),/.exec(mounts[index]!)![1]!);
  const started = await runContainer(name, ['-d', '-p', `127.0.0.1:${port}:3000`, '-e', 'STERLING_LISTEN_HOST=0.0.0.0', '-e', 'STERLING_PREVIEW_NO_SIGN_IN=accept',
    ...env, ...mounts, image]);
  assert.equal(started.code, 0, started.stderr);
  const url = `http://127.0.0.1:${port}`;
  await waitHealthy(name, url);
  const result = await runPlaywright('compliance.spec.ts', { WORKBENCH_URL: url, ...(shots ? { COMPLIANCE_SHOTS: shots } : {}), ...specEnv }, ['--grep', `${testName}$`]);
  assert.equal(result.code, 0, `Playwright failed:\n${result.stdout.slice(-4000)}\n${result.stderr.slice(-4000)}`);
  assert.match(result.stdout, /\b1 passed\b/, `the "${testName}" case ran`);
}

test('Restricted, release only: a verified release folder and no site evidence, answered in Restricted Mode', async () => {
  const release = releaseFolder('release-only');
  const trust = folder('release-only-trust');
  writeFileSync(path.join(trust, 'supplier.pub'), publicKey('supplier'));
  signWith('supplier', path.join(release, 'manifest.json'), path.join(trust, `release-${VERSION}.sigstore.json`));
  await runCase('compliance-release-only', 'Restricted, release only', [...bind(release, EVIDENCE), ...bind(trust, TRUST)]);
});
