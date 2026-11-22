import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compareResolved, run } from '../src/commands/resolve-check.ts';

const profile = (ids: string[]) => ({ profile: { imports: [{ href: '../catalog.json', 'include-controls': [{ 'with-ids': ids }] }] } });
const catalog = (ids: string[]) => ({ catalog: { groups: [{ controls: ids.map((id) => ({ id })) }] } });

test('resolve-check reports identifiers present only in the resolved catalogue', () => {
  assert.deepEqual(compareResolved(['ac-01'], ['ac-01', 'ac-02']), { missing: [], extra: ['ac-02'] });
});

test('resolve-check reports no differences for equal identifier sets and exits zero', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'resolve-check-'));
  try {
    const profiles = path.join(root, 'profiles'); const resolved = path.join(root, 'resolved'); mkdirSync(profiles); mkdirSync(resolved);
    writeFileSync(path.join(root, 'catalog.json'), JSON.stringify(catalog(['ac-01'])));
    writeFileSync(path.join(profiles, 'level.json'), JSON.stringify(profile(['ac-01'])));
    writeFileSync(path.join(resolved, 'level.json'), JSON.stringify(catalog(['ac-01'])));
    let output = '';
    assert.equal(await run(['--profiles', profiles, '--resolved', resolved], { write: (text) => { output += text; } }), 0);
    assert.match(output, /level: no differences/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('resolve-check ignores OSCAL group and part identifiers', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'resolve-check-'));
  try {
    const profiles = path.join(root, 'profiles'); const resolved = path.join(root, 'resolved'); mkdirSync(profiles); mkdirSync(resolved);
    writeFileSync(path.join(root, 'catalog.json'), JSON.stringify(catalog(['ac-01'])));
    writeFileSync(path.join(profiles, 'level.json'), JSON.stringify(profile(['ac-01'])));
    writeFileSync(path.join(resolved, 'level.json'), JSON.stringify({ catalog: { groups: [{ id: 'access-control', controls: [{ id: 'ac-01', parts: [{ id: 'statement' }] }] }] } }));
    let output = '';
    assert.equal(await run(['--profiles', profiles, '--resolved', resolved], { write: (text) => { output += text; } }), 0);
    assert.match(output, /level: no differences/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
