import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { MODE_IDS, MODES } from '../domain/org/modes';
import { modeName, term } from '../domain/org/terms';
import { modeRowOf, SET_BY_PROJECT_TEXT, suggestMode } from '../domain/setup/modes';
import type { GuideModePolicy } from '../domain/setup/policy';
import { REPO_ROOT } from './helpers/copyLintScan';

const policy: GuideModePolicy = { mode: 'public-service', allowedModes: MODE_IDS, projectMayChoose: true, fixed: false };

for (const [kind, mode] of [['staff', 'military'], ['capital-projects', 'capital'], ['software', 'corporate']] as const) {
  test(`D-28: ${kind} suggests ${mode} when choice is allowed`, () => {
    assert.deepEqual(suggestMode({ kind, policy, setByOrganization: true }), {
      mode, source: 'suggested', changeable: true, choices: MODE_IDS
    });
  });
}

test('D-28: use the policy default when there is no allowed suggestion', () => {
  const defaults = { mode: policy.mode, source: 'policy-default', changeable: true, choices: policy.allowedModes };
  assert.deepEqual(suggestMode({ kind: 'writing', policy, setByOrganization: false }), defaults);
  const limited = { ...policy, allowedModes: ['public-service', 'corporate'] as const };
  assert.deepEqual(suggestMode({ kind: 'staff', policy: limited, setByOrganization: true }), { ...defaults, choices: limited.allowedModes });
});

test('D-28: only an externally issued organization policy gets the organization source', () => {
  const fixed = { ...policy, projectMayChoose: false, fixed: true };
  const policyEditor = readFileSync(join(REPO_ROOT, 'src/services/policyEditor.ts'), 'utf8');
  const policyEditorText = policyEditor.match(/export const SET_BY_ORGANIZATION_TEXT = '([^']+)';/)?.[1];
  assert.ok(policyEditorText);
  const external = suggestMode({ kind: 'staff', policy: fixed, setByOrganization: true });
  assert.deepEqual(external, { mode: policy.mode, source: 'set-by-organization', changeable: false, choices: [policy.mode] });
  assert.equal(modeRowOf(external).source, policyEditorText);
  const local = suggestMode({ kind: 'staff', policy: fixed, setByOrganization: false });
  assert.deepEqual(local, { ...external, source: 'policy-default' });
  assert.equal(modeRowOf(local).source, '');
});

test('D-28: an invitation carries its project mode', () => {
  const suggestion = suggestMode({ kind: 'staff', policy, setByOrganization: true, fixedByProject: 'capital' });
  assert.deepEqual(suggestion, { mode: 'capital', source: 'set-by-project', changeable: false, choices: ['capital'] });
  assert.equal(modeRowOf(suggestion).source, SET_BY_PROJECT_TEXT);
});

test('ORG-01 to ORG-03 on screen (data level, D-40)', () => {
  for (const mode of MODE_IDS) {
    const row = modeRowOf({ mode, source: 'policy-default', changeable: false, choices: [mode] });
    assert.deepEqual(row, { name: modeName(mode), join: term('join', mode), source: '' });
  }
  const source = readFileSync(join(REPO_ROOT, 'src/domain/setup/modes.ts'), 'utf8');
  for (const mode of MODE_IDS) {
    for (const { word } of Object.values(MODES[mode].words)) {
      for (const quote of ["'", '"', '`']) assert.ok(!source.includes(`${quote}${word}${quote}`), word);
    }
  }
});
