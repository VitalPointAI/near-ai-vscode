// The site-export command (48-02, D-13, D-16, VER-06): facts come only from the collected source folder through strict readers, a token-shaped
// value that would reach the payload stops the command, and the export is signed with a key file or by an external signer through the exact
// signing input. collect.sh only reads. Keys are generated when the tests run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPrivateKey, sign as edSign } from 'node:crypto';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize, signingInput, verifyEnvelope } from '../src/signed.ts';
import { SITE_EXPORT_PURPOSE, deploymentCollector } from '../src/collectors/deployment.ts';
import { SOURCE_FILES, readAuditPolicy, readImages, readKeycloakClients, readKeycloakServerInfo, readSiteFacts } from '../src/siteExport.ts';
import { run } from '../src/commands/site-export.ts';
import { DEPLOYMENT_FIXTURES, compliantFacts, fileContext, freshKey, signersText, tempDir } from './fixtures/collectors/deployment/helpers.ts';

const SITE = path.join(DEPLOYMENT_FIXTURES, 'site');
const COLLECT_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'site-export', 'collect.sh');
const COMMIT = 'c'.repeat(40);

/** A copy of the complete fixture folder that a test may change. */
function siteCopy(): string {
  const dir = path.join(tempDir(), 'sources');
  cpSync(SITE, dir, { recursive: true });
  return dir;
}

/** Runs the command and returns its exit code and what it wrote to stderr. */
async function exportCommand(args: readonly string[]): Promise<{ code: number; stderr: string }> {
  let stderr = '';
  const code = await run(args, { stderr: (text) => { stderr += text; } });
  return { code, stderr };
}

function keyFile(pem: string): string {
  const file = path.join(tempDir(), 'operator.pem');
  writeFileSync(file, pem, { mode: 0o600 });
  return file;
}

test('the readers turn the complete fixture folder into exactly the compliant facts', () => {
  assert.deepEqual(readSiteFacts(SITE), compliantFacts());
});

test('an export the command signs with a key file passes the collector with all sixteen checks', async () => {
  const key = freshKey();
  const out = path.join(tempDir(), 'export.json');
  assert.deepEqual(await exportCommand(['--sources', SITE, '--site', 'fixture-site', '--key', keyFile(key.privateKeyPem), '--out', out]), { code: 0, stderr: '' });
  const signers = path.join(tempDir(), 'site-signers.json');
  writeFileSync(signers, signersText(key));
  const rows = await deploymentCollector.collect({ file: out, signersFile: signers }, fileContext(new Date(), COMMIT));
  assert.equal(rows.length, 16);
  assert.deepEqual(rows.filter((row) => !row.passed), []);
});

test('a missing, oversized or unparseable source file stops the command, names the file and writes no export', async () => {
  const key = freshKey();
  const cases: readonly (readonly [string, (dir: string) => void])[] = [
    ['openbao-audit.json', (dir) => rmSync(path.join(dir, 'openbao-audit.json'))],
    ['counts.json', (dir) => writeFileSync(path.join(dir, 'counts.json'), ' '.repeat(SOURCE_FILES['counts.json'] + 1))],
    ['images.json', (dir) => writeFileSync(path.join(dir, 'images.json'), '{ "images": [')],
    ['kubernetes-audit-policy.yaml', (dir) => writeFileSync(path.join(dir, 'kubernetes-audit-policy.yaml'), 'rules: [\n')]
  ];
  for (const [file, breakIt] of cases) {
    const dir = siteCopy();
    breakIt(dir);
    const out = path.join(tempDir(), 'export.json');
    const result = await exportCommand(['--sources', dir, '--site', 'fixture-site', '--key', keyFile(key.privateKeyPem), '--out', out]);
    assert.equal(result.code, 1, file);
    assert.match(result.stderr, new RegExp(file.replace('.', '\\.')), file);
    assert.equal(existsSync(out), false, file);
  }
});

test('a token-shaped value that would reach the payload makes the command refuse', async () => {
  const dir = siteCopy();
  const info = JSON.parse(readFileSync(path.join(dir, 'keycloak-serverinfo.json'), 'utf8'));
  // Built at run time so the repository's own secret scan never sees a token-shaped literal.
  info.systemInfo.version = `26.8.2-${['sk', 'ant', 'api03'].join('-')}-${'A'.repeat(24)}`;
  writeFileSync(path.join(dir, 'keycloak-serverinfo.json'), JSON.stringify(info));
  const out = path.join(tempDir(), 'export.json');
  const result = await exportCommand(['--sources', dir, '--site', 'fixture-site', '--key', keyFile(freshKey().privateKeyPem), '--out', out]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /secret rule anthropic-key/);
  assert.doesNotMatch(result.stderr, /AAAAAAAA/, 'the refusal never repeats the value');
  assert.equal(existsSync(out), false);
});

test('the realm name, emails, client ids and client secrets never reach the payload', async () => {
  const key = freshKey();
  const out = path.join(tempDir(), 'export.json');
  assert.equal((await exportCommand(['--sources', SITE, '--site', 'fixture-site', '--key', keyFile(key.privateKeyPem), '--out', out])).code, 0);
  const text = readFileSync(out, 'utf8');
  const clients = JSON.parse(readFileSync(path.join(SITE, 'keycloak-clients.json'), 'utf8')) as { clientId: string; secret?: string }[];
  for (const value of ['fixture-sterling-site', 'operator@fixture-site.example', 'fixture-openbao-cluster', 'fixture-server-1', 'session-person-one', ...clients.flatMap((client) => [client.clientId, client.secret ?? client.clientId])]) {
    assert.equal(text.includes(value), false, value);
  }
});

test('--emit-signing-input writes exactly the bytes signingInput returns, and --attach-signature over them gives an export that verifies', async () => {
  const key = freshKey();
  const publicKey = path.join(tempDir(), 'operator.pub');
  writeFileSync(publicKey, `${key.publicKey}\n`);
  const unsignedFile = path.join(tempDir(), 'unsigned.json');
  const inputFile = path.join(tempDir(), 'signing-input.bin');
  assert.equal((await exportCommand(['--sources', SITE, '--site', 'fixture-site', '--public-key', publicKey, '--emit-signing-input', inputFile, '--out', unsignedFile])).code, 0);
  const unsigned = JSON.parse(readFileSync(unsignedFile, 'utf8'));
  assert.equal('sig' in unsigned, false);
  const bytes = readFileSync(inputFile);
  assert.deepEqual(bytes, signingInput(SITE_EXPORT_PURPOSE, unsigned));
  const signatureFile = path.join(tempDir(), 'signature.bin');
  writeFileSync(signatureFile, edSign(null, bytes, createPrivateKey(key.privateKeyPem)));
  const out = path.join(tempDir(), 'export.json');
  assert.equal((await exportCommand(['--unsigned', unsignedFile, '--attach-signature', signatureFile, '--out', out])).code, 0);
  const verdict = verifyEnvelope(JSON.parse(readFileSync(out, 'utf8')), { purpose: SITE_EXPORT_PURPOSE, keys: [key], now: new Date() });
  assert.equal(verdict.ok, true);
  assert.equal(canonicalize((verdict as any).payload), canonicalize(unsigned.payload));
});

test('a signature over other bytes is refused before anything is written', async () => {
  const key = freshKey();
  const publicKey = path.join(tempDir(), 'operator.pub');
  writeFileSync(publicKey, key.publicKey);
  const unsignedFile = path.join(tempDir(), 'unsigned.json');
  assert.equal((await exportCommand(['--sources', SITE, '--site', 'fixture-site', '--public-key', publicKey, '--emit-signing-input', path.join(tempDir(), 'input.bin'), '--out', unsignedFile])).code, 0);
  const signatureFile = path.join(tempDir(), 'signature.txt');
  writeFileSync(signatureFile, edSign(null, Buffer.from('other bytes'), createPrivateKey(key.privateKeyPem)).toString('base64url'));
  const out = path.join(tempDir(), 'export.json');
  const result = await exportCommand(['--unsigned', unsignedFile, '--attach-signature', signatureFile, '--out', out]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /signature does not match/);
  assert.equal(existsSync(out), false);
});

test('the readers fail closed on the formats that matter: shadowed audit rules, digest mismatches, Red Hat builds and load-test clients', () => {
  const policy = readFileSync(path.join(SITE, 'kubernetes-audit-policy.yaml'));
  assert.deepEqual([readAuditPolicy(policy).sessionsAudited, readAuditPolicy(policy).workspacesAudited], [true, true]);
  const shadowed = Buffer.from(policy.toString('utf8').replace('rules:\n', 'rules:\n  - level: None\n    resources:\n      - group: "theia.cloud"\n        resources: ["workspaces"]\n'));
  assert.deepEqual([readAuditPolicy(shadowed).sessionsAudited, readAuditPolicy(shadowed).workspacesAudited], [true, false]);
  const partly = Buffer.from(policy.toString('utf8').replace('rules:\n', 'rules:\n  - level: None\n    verbs: ["delete"]\n    resources:\n      - group: "theia.cloud"\n        resources: ["sessions"]\n'));
  assert.equal(readAuditPolicy(partly).sessionsAudited, false, 'a conditional None rule may drop some session records');
  const images = JSON.parse(readFileSync(path.join(SITE, 'images.json'), 'utf8'));
  images.images[0].signature[0].critical.image['docker-manifest-digest'] = `sha256:${'3'.repeat(64)}`;
  images.images[1].provenance = null;
  assert.deepEqual(readImages(images), { locked: 2, signatureVerified: 1, sbomVerified: 2, provenanceVerified: 1 });
  const info = JSON.parse(readFileSync(path.join(SITE, 'keycloak-serverinfo.json'), 'utf8'));
  info.systemInfo.version = '26.4.2.redhat-00001';
  info.cryptoInfo.cryptoProvider = 'FIPS1402Provider';
  assert.deepEqual(readKeycloakServerInfo(info), { distribution: 'redhat', version: '26.4.2.redhat-00001', fipsMode: 'non-strict' });
  assert.equal(readKeycloakClients([{ clientId: 'loadtest-runner' }, { clientId: 'sterling-sessions' }]).loadTestClients, 1);
});

test('collect.sh is valid POSIX sh and uses no command verb that changes a site', () => {
  const syntax = spawnSync('sh', ['-n', COLLECT_SCRIPT], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  const text = readFileSync(COLLECT_SCRIPT, 'utf8');
  for (const verb of ['apply', 'create', 'delete', 'patch', 'write', 'put']) assert.doesNotMatch(text, new RegExp(`\\b${verb}\\b`), verb);
  for (const tool of ['kubectl get', 'kcadm.sh', 'bao status', 'bao read', 'cosign verify', 'cosign verify-attestation', '/proc/sys/crypto/fips_enabled', 'crypto.getFips()']) assert.ok(text.includes(tool), tool);
});
