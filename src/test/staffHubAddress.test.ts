import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { genesisPinFile } from '../staff/replica/replicaProject';
import { HUB_ADDRESS_FILE, hubAddressFile, readHubAddress, writeHubAddress, type HubAddressRecord } from '../staff/replica/hubAddress';

const first: HubAddressRecord = {
  v: 1, project: 'a'.repeat(32), hub: 'hub-0123456789abcdef', address: 'hub.example.org:8443',
  setAt: '2026-11-20T00:00:00.000Z'
};

async function storage(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-hub-address-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('writes a complete private record next to the local genesis pin', async (t) => {
  const root = await storage(t);
  const target = hubAddressFile(root, first.project);
  assert.equal(target, path.join(path.dirname(genesisPinFile(root, first.project)), HUB_ADDRESS_FILE));
  await writeHubAddress(root, first);
  assert.deepEqual(await readHubAddress(root, first.project), first);
  const raw = JSON.parse(await readFile(target, 'utf8')) as object;
  assert.deepEqual(Object.keys(raw).sort(), ['address', 'hub', 'project', 'setAt', 'v']);
  assert.deepEqual(await readdir(path.dirname(target)), [HUB_ADDRESS_FILE]);
  if (process.platform !== 'win32') {
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(target))).mode & 0o777, 0o700);
  }
});

test('each project and each device storage root has a separate address', async (t) => {
  const root = await storage(t);
  const second = { ...first, project: 'b'.repeat(32), address: 'second.example.org:8443' };
  await writeHubAddress(root, first);
  await writeHubAddress(root, second);
  assert.deepEqual(await readHubAddress(root, first.project), first);
  assert.deepEqual(await readHubAddress(root, second.project), second);
  assert.equal(await readHubAddress(path.join(root, 'other-device'), first.project), undefined);
});

test('moving the server preserves the genesis pin and enforces the caller’s roster hub', async (t) => {
  const root = await storage(t);
  await writeHubAddress(root, first);
  const pin = genesisPinFile(root, first.project);
  await writeFile(pin, 'original roster pin');
  const moved = { ...first, address: '[2001:db8::1]:443' };
  await writeHubAddress(root, moved);
  assert.deepEqual(await readHubAddress(root, first.project, { hub: first.hub }), moved);
  assert.equal(await readHubAddress(root, first.project, { hub: 'hub-fedcba9876543210' }), undefined);
  assert.equal(await readFile(pin, 'utf8'), 'original roster pin');
});

test('bad records return undefined and report one generic diagnostic', async (t) => {
  const root = await storage(t);
  const file = hubAddressFile(root, first.project);
  await mkdir(path.dirname(file), { recursive: true });
  for (const data of [
    '{broken', JSON.stringify({ ...first, project: 'b'.repeat(32) }), JSON.stringify({ ...first, address: 'https://example.org' }),
    JSON.stringify({ ...first, token: 'private content' }), JSON.stringify({ ...first, setAt: '2026-02-30T00:00:00.000Z' }),
    'a'.repeat(8192),
  ]) {
    await writeFile(file, data);
    const messages: string[] = [];
    assert.equal(await readHubAddress(root, first.project, { log: (message) => messages.push(message) }), undefined);
    assert.equal(messages.length, 1);
    assert.doesNotMatch(messages[0], /private content/);
  }
});

test('invalid address changes leave the existing setting as stored', async (t) => {
  const root = await storage(t);
  await writeHubAddress(root, first);
  await assert.rejects(writeHubAddress(root, { ...first, address: 'hub.example.org:65536' }));
  await assert.rejects(writeHubAddress(root, { ...first, project: '../outside' }));
  const withSecret = { ...first, enrolmentSecret: 'private content' };
  await assert.rejects(writeHubAddress(root, withSecret));
  assert.deepEqual(await readHubAddress(root, first.project), first);
});

test('links in the project settings path are refused', async (t) => {
  const root = await storage(t);
  const file = hubAddressFile(root, first.project);
  const outside = path.join(root, 'different-folder');
  await mkdir(outside);
  await mkdir(path.dirname(path.dirname(file)));
  await writeFile(path.join(outside, HUB_ADDRESS_FILE), JSON.stringify(first));
  await symlink(outside, path.dirname(file), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await readHubAddress(root, first.project), undefined);
  await assert.rejects(writeHubAddress(root, { ...first, address: 'new.example.org:443' }));
  assert.deepEqual(JSON.parse(await readFile(path.join(outside, HUB_ADDRESS_FILE), 'utf8')), first);
});
