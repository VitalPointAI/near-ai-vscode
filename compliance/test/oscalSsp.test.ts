import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadInventory } from '../src/inventory.ts';
import { buildSsp, TO_BE_COMPLETED } from '../src/oscalSsp.ts';
import { validateOscal } from '../src/validate.ts';

const input: Parameters<typeof buildSsp>[0] = {
  level: { id: 'protected-b', title: 'Protected B', profile: 'profiles/protected-b.json', components: ['extension'] },
  rows: [{ level: 'protected-b', control: 'ac-01', state: 'met', reasonText: 'Evidence shows current results.', components: [{ component: 'extension', responsibility: 'product', state: 'met', statement: 'The product checks access.' }] }],
  components: [{ id: 'extension', implemented: [{ control: 'ac-01', responsibility: 'product', statements: [{ id: 'ac-01_smt.a', description: 'The product checks access.', yourOrganizationDoes: 'Approves access.' }] }] }]
};

test('buildSsp emits an OSCAL 1.2.1 system security plan', () => {
  const document = buildSsp(input);
  assert.deepEqual(validateOscal(document, 'system-security-plan', { ours: true }), { ok: true, errors: [] });
});

test('buildSsp imports the level profile', () => {
  const document: any = buildSsp(input);
  assert.equal(document['system-security-plan']['import-profile'].href, 'profiles/protected-b.json');
});

test('buildSsp keeps the product statement and organization placeholder separate', () => {
  const document: any = buildSsp(input);
  const byComponent = document['system-security-plan']['control-implementation']['implemented-requirements'][0]['by-components'][0];
  assert.equal(byComponent['description'], 'The product checks access.');
  assert.match(byComponent.remarks, new RegExp(TO_BE_COMPLETED));
  assert.equal(byComponent.export.responsibilities[0]['provided-uuid'], byComponent.export.provided[0].uuid);
});

test('buildSsp records dashboard state as evidence remarks', () => {
  const document: any = buildSsp(input);
  assert.match(document['system-security-plan']['control-implementation']['implemented-requirements'][0].remarks, /Met/);
});

test('controls without product components remain incomplete at the authorization boundary', () => {
  const document: any = buildSsp({ ...input, rows: [{ ...input.rows[0], state: 'not-met', components: [] }] });
  const ssp = document['system-security-plan'];
  const boundary = ssp['system-implementation'].components.find((component: { type: string }) => component.type === 'this-system');
  const implementation = ssp['control-implementation']['implemented-requirements'][0]['by-components'][0];
  assert.equal(implementation['component-uuid'], boundary.uuid);
  assert.equal(implementation['implementation-status'].state, 'planned');
  assert.equal(implementation.description, TO_BE_COMPLETED);
  assert.equal(implementation.export, undefined);
  assert.deepEqual(validateOscal(document, 'system-security-plan', { ours: true }), { ok: true, errors: [] });
});

test('every level SSP carrying the register inventory validates against OSCAL, with each item tied to a component and a party', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const { entries } = loadInventory(root);
  const { levels } = JSON.parse(readFileSync(new URL('../levels.json', import.meta.url), 'utf8')) as { levels: { id: string; title: string; profile: string; components: string[] }[] };
  let items = 0;
  for (const level of levels) {
    const document: any = buildSsp({ ...input, level, rows: [{ ...input.rows[0], level: level.id }], inventory: entries });
    assert.deepEqual(validateOscal(document, 'system-security-plan', { ours: true }), { ok: true, errors: [] }, level.id);
    const ssp = document['system-security-plan'];
    const components = new Set(ssp['system-implementation'].components.map((component: { uuid: string }) => component.uuid));
    const parties = new Set((ssp.metadata.parties ?? []).map((party: { uuid: string }) => party.uuid));
    const roles = new Set((ssp.metadata.roles ?? []).map((role: { id: string }) => role.id));
    for (const item of ssp['system-implementation']['inventory-items'] ?? []) {
      items += 1;
      assert.ok(components.has(item['implemented-components'][0]['component-uuid']), item.uuid);
      for (const party of item['responsible-parties']) {
        assert.ok(roles.has(party['role-id']), party['role-id']);
        assert.ok(party['party-uuids'].every((uuid: string) => parties.has(uuid)), item.uuid);
      }
    }
  }
  assert.ok(items >= entries.length, 'every register entry appears in at least one level');
});
