import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { canonicalize } from '../../compliance/src/signed.ts';

const fixture = new URL('../profiles/activity-v1.json', import.meta.url);
const implementation = new URL('../src/profile.ts', import.meta.url).href;

async function profileTools() {
  try {
    return await import(implementation);
  } catch (error) {
    assert.fail(`Activity profile loader did not load: ${String(error)}`);
  }
}

function withChecksum(input: Record<string, unknown>) {
  const { sha256: _oldChecksum, ...payload } = input;
  const sha256 = `sha256:${createHash('sha256').update(canonicalize(payload)).digest('hex')}`;
  return { ...payload, sha256 };
}

test('the committed activity profile has the v1 activity sequence and canonical checksum', async () => {
  const { loadProfile } = await profileTools();
  const profile = loadProfile(fixture);
  assert.equal(profile.version, '1');
  assert.deepEqual(profile.steps.map(({ kind }: { kind: string }) => kind), ['open-files', 'edit', 'terminal', 'idle']);
  assert.equal(profile.steps[0].files.length, 3);
  assert.match(profile.sha256, /^sha256:[a-f0-9]{64}$/);
});

test('formatting and object key order do not change the profile checksum', async () => {
  const { parseProfile } = await profileTools();
  const source = JSON.parse(readFileSync(fixture, 'utf8'));
  const reordered = Object.fromEntries(Object.entries(source).reverse());
  assert.equal(parseProfile(JSON.stringify(reordered, null, 4)).sha256, source.sha256);
});

test('a changed activity retaining its recorded checksum is refused', async () => {
  const { parseProfile } = await profileTools();
  const source = JSON.parse(readFileSync(fixture, 'utf8'));
  source.steps[1].text = 'Changed fixture text';
  assert.throws(() => parseProfile(JSON.stringify(source)), /checksum/);
});

test('fresh checksums cannot validate changes outside the activity profile schema', async () => {
  const { parseProfile } = await profileTools();
  const cases = [
    { patch: { idleShareBasisPoints: 10_001 }, reason: /idle share/ },
    { patch: { version: '2' }, reason: /version/ },
    { patch: { locators: ['get-started', 'command-palette', 'editor', 'other'] }, reason: /locators/ },
    { patch: { unexpected: true }, reason: /fields/ },
  ];
  const source = JSON.parse(readFileSync(fixture, 'utf8'));
  for (const { patch, reason } of cases) {
    assert.throws(() => parseProfile(JSON.stringify(withChecksum({ ...source, ...patch }))), reason);
  }
  source.steps[3].durationMs = 0;
  assert.throws(() => parseProfile(JSON.stringify(withChecksum(source))), /idle duration/);
});
