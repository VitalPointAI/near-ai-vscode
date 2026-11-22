import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { profileAlters, selectedIds } from '../src/profiles.ts';

const fixture = () => { const dir = mkdtempSync(path.join(tmpdir(), 'near-ai-profile-')); writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ catalog: { controls: [{ id: 'ac-01' }, { id: 'ac-02' }, { id: 'ia-01' }] } })); writeFileSync(path.join(dir, 'child.json'), JSON.stringify({ profile: { imports: [{ href: 'catalog.json', 'include-all': {} }] } })); writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ profile: { imports: [{ href: 'child.json', 'include-controls': [{ 'with-ids': ['ac-01', 'ac-02'] }], 'exclude-controls': [{ 'with-ids': ['ac-02'] }] }], modify: { 'set-parameters': [{ 'param-id': 'ac-01_prm_1', value: 'organization-wide' }] } } })); return dir; };
test('include-all selects each catalog control', () => { const dir = fixture(); assert.deepEqual(selectedIds(path.join(dir, 'child.json')), ['ac-01', 'ac-02', 'ia-01']); });
test('include and exclude selectors compose over imported profiles', () => { const dir = fixture(); assert.deepEqual(selectedIds(path.join(dir, 'profile.json')), ['ac-01']); });
test('missing profile import names the missing file', () => { const dir = fixture(); writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ profile: { imports: [{ href: 'gone.json', 'include-all': {} }] } })); assert.throws(() => selectedIds(path.join(dir, 'bad.json')), /gone\.json/); });
test('profileAlters returns organization-wide parameter choices', () => { const dir = fixture(); assert.deepEqual(profileAlters(path.join(dir, 'profile.json')), [{ 'param-id': 'ac-01_prm_1', value: 'organization-wide' }]); });
test('profile imports do not leak unselected parent controls', () => { const dir = fixture(); assert.equal(selectedIds(path.join(dir, 'profile.json')).includes('ac-02'), false); });
