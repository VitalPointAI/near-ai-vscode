// The panel-facing target resolution (CYBER-01): all five kinds resolve to a scope preview the client
// paints before anything is sent, and a mode that exceeds the scope arrives disabled WITH its reason —
// never hidden and never silently downgraded.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { resolveTarget, ScopeError } from '../domain/cyber';
import { modeAvailability, scopePreview } from '../services/cyberPanelPage';

/** No DNS leaves the machine: a literal host needs none, and a name is given a fixed address. */
const noDns = { lookup: async (hostname: string) => (hostname === 'example.test' ? ['203.0.113.10'] : Promise.reject(new Error(`unexpected lookup of ${hostname}`))) };

test('a URL target previews hosts, port and path before anything is sent', async () => {
  const scope = await resolveTarget({ kind: 'url', value: 'https://example.test/login' }, noDns);
  const preview = scopePreview('url', 'https://example.test/login', scope);
  assert.deepEqual(preview.hosts, ['example.test', '203.0.113.10']);
  assert.deepEqual(preview.ports, [443]);
  assert.deepEqual(preview.paths, ['/login']);
  assert.deepEqual(preview.exclusions, []);
  assert.equal(preview.modes.every((mode) => mode.enabled), true, 'a network target allows every mode');
});

test('a workspace target previews the folder and disables the offensive modes with a reason', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'near-ai-cyber-scope-'));
  const scope = await resolveTarget({ kind: 'workspace', value: folder }, noDns);
  const preview = scopePreview('workspace', folder, scope);
  assert.deepEqual(preview.hosts, []);
  assert.deepEqual(preview.paths, [folder]);
  assert.ok(preview.exclusions.includes('.git'));
  const defensive = preview.modes.find((mode) => mode.mode === 'defensive')!;
  const offensive = preview.modes.find((mode) => mode.mode === 'offensive')!;
  assert.equal(defensive.enabled, true, 'a static scan needs no host');
  assert.equal(offensive.enabled, false);
  assert.match(offensive.reason ?? '', /needs a network host/);
  assert.equal(preview.modes.find((mode) => mode.mode === 'full')!.enabled, false);
});

test('a CIDR target enumerates exactly its usable hosts and honours the budget', async () => {
  const scope = await resolveTarget({ kind: 'cidr', value: '10.0.0.0/30' }, noDns);
  assert.deepEqual(scope.hosts, ['10.0.0.1', '10.0.0.2']);
  const preview = scopePreview('cidr', '10.0.0.0/30', scope);
  assert.deepEqual(preview.modes.map((mode) => mode.enabled), [true, true, true]);

  await assert.rejects(resolveTarget({ kind: 'cidr', value: '10.0.0.0/8' }, { ...noDns, cidrBudget: 256 }), (error: Error) => error instanceof ScopeError && /more than the 256-host budget/.test(error.message));
});

test('a container target previews the name and notes that its address is resolved at run time', async () => {
  const scope = await resolveTarget({ kind: 'container', value: 'fixture-web' }, noDns);
  const preview = scopePreview('container', 'fixture-web', scope);
  assert.deepEqual(preview.hosts, ['fixture-web']);
  assert.match(preview.note ?? '', /resolved at run time/);
});

test('a git target is a local folder, and a remote URL is refused with a reason', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'near-ai-cyber-git-'));
  await mkdir(path.join(folder, '.git'), { recursive: true });
  const scope = await resolveTarget({ kind: 'git', value: folder }, noDns);
  assert.deepEqual(scope.paths, [folder]);
  assert.deepEqual(scope.exclusions, ['.git']);
  await assert.rejects(resolveTarget({ kind: 'git', value: 'https://github.com/x/y.git' }, noDns), /cloning arbitrary remotes/);
});

test('a disabled sandbox disables every mode that needs one, with the reason', () => {
  const scope = { hosts: ['example.test'], ports: [443], paths: ['/'], exclusions: [] };
  const modes = modeAvailability(scope, 'disabled');
  assert.equal(modes.find((mode) => mode.mode === 'defensive')!.enabled, true);
  const offensive = modes.find((mode) => mode.mode === 'offensive')!;
  assert.equal(offensive.enabled, false);
  assert.match(offensive.reason ?? '', /needs a sandbox/);
});

test('a public-sector target raises a red flag in the preview, never a block (D-15)', () => {
  const scope = { hosts: ['portal.example.gov'], ports: [443], paths: ['/'], exclusions: [] };
  const preview = scopePreview('url', 'https://portal.example.gov/', scope);
  assert.ok(preview.warning, 'a .gov target is flagged');
  assert.match(preview.warning!, /\.gov/);
  assert.equal(preview.modes.every((mode) => mode.enabled), true, 'the warning never disables a mode');

  const metadata = scopePreview('url', 'http://169.254.169.254/', { hosts: ['169.254.169.254'], ports: [80], paths: ['/'], exclusions: [] });
  assert.match(metadata.warning ?? '', /metadata/);
});
