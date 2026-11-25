// Phase 71, plan 12, task 3 (D-15, D-21, D-22): what the native Issue credential card shows. The widget renders this model; the model is tested here
// without a browser. States read in words with an icon, never by colour alone; a revocation offers no way back; the "Credentials to revoke" section
// exists only while a request is open; a refusal returns to the filled-in form with its sentence. Flat file name, so the runner runs it (H-71-01).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CARD_TEXT, nextStep, requestsSection, rowFor, typeOptions, type IssueStep } from '../extension/src/common/issue-credential-card.ts';
import { ISSUER_TEXT, type IssuedCredentialView, type RevocationRequestView } from '../extension/src/common/issuer-service.ts';

// Built into dist/test/, so the workbench folder is two levels up from this file.
const workbenchRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const source = (file: string): string => readFileSync(path.join(workbenchRoot, file), 'utf8');

const view = (state: IssuedCredentialView['state'], hash = 'a'.repeat(64)): IssuedCredentialView => ({
  hash, type: 'ClearanceCredential', label: 'clearance', personName: 'Alex', validUntil: '2027-04-01T00:00:00Z', state,
  reviews: { revoke: 'You are about to revoke Alex\'s clearance. A revocation can never be undone.', suspend: 'You are about to suspend Alex\'s clearance.', lift: 'You are about to lift it.' },
});

test('each state reads in words with its own icon, and allows only its actions: a revocation offers none', () => {
  const active = rowFor(view('active'));
  assert.deepEqual([active.state, active.icon, active.actions.map((entry) => entry.label)], ['Active', 'pass', [CARD_TEXT.revoke, CARD_TEXT.suspend]]);
  assert.equal(active.actions[0]?.review, 'You are about to revoke Alex\'s clearance. A revocation can never be undone.', 'Revoke has its own review sentence');
  assert.equal(active.actions[1]?.review, 'You are about to suspend Alex\'s clearance.');
  assert.deepEqual(rowFor(view('suspended')).actions.map((entry) => entry.action), ['revoke', 'lift']);
  assert.deepEqual(rowFor(view('revoked')).actions, []);
  assert.deepEqual(rowFor(view('unknown')).actions, [], 'nothing is offered while the status cannot be read');
  assert.equal(new Set(['active', 'suspended', 'revoked', 'unknown'].map((state) => rowFor(view(state as IssuedCredentialView['state'])).icon)).size, 4);
});

test('the Credentials to revoke section disappears when no request is open, and lists only this officer\'s credentials still to end', () => {
  assert.equal(requestsSection([]), undefined);
  const requests: RevocationRequestView[] = [
    { id: 'guest-kc-alex-guest-ended', current: true, personName: 'Alex', reason: 'guest-ended', reasonText: 'guest access ended early', seenAt: '2026-11-24T10:00:00Z',
      credentials: [view('active', 'b'.repeat(64)), view('revoked', 'c'.repeat(64))],
      computers: [{ slot: 2, device: `dev-${'f'.repeat(32)}`, claimedAt: '2026-11-25T08:00:00Z', state: 'active', review: 'You are about to revoke Alex\'s computer binding. A revocation can never be undone.' },
        { slot: 3, device: `dev-${'0'.repeat(32)}`, claimedAt: '2026-11-25T08:00:00Z', state: 'revoked', review: 'x' }] },
    { id: 'keycloak-kc-sam-removed', current: true, personName: 'Sam', reason: 'removed', reasonText: 'removed', seenAt: '2026-11-24T11:00:00Z', credentials: [], computers: [] },
    { id: 'keycloak-kc-zed-removed', current: false, message: ISSUER_TEXT.newerRequest },
  ];
  const sections = requestsSection(requests);
  assert.ok(sections);
  assert.deepEqual(sections.map((section) => [section.heading, section.detail, section.rows.map((row) => row.hash)]), [
    ['Alex', 'guest access ended early', ['b'.repeat(64), 'computer-2']], ['Sam', 'removed', []], [ISSUER_TEXT.newerRequest, '', []],
  ]);
  assert.deepEqual(sections[0]?.rows[0]?.actions.map((entry) => entry.label), [CARD_TEXT.revoke, CARD_TEXT.suspend]);
  assert.equal(sections[1]?.empty, CARD_TEXT.noneOfYours);
  // A computer (D-25) offers Revoke only, with its own sentence; a revoked one is gone from the list.
  assert.deepEqual(sections[0]?.rows[1]?.actions.map((entry) => [entry.action, entry.label]), [['revoke-computer', CARD_TEXT.revokeComputer]]);
  assert.match(sections[0]?.rows[1]?.title ?? '', /^computer ffffffff \(bound 2026-11-25\)$/);
});

test('the issue steps: form, review with the sentence, signing, done; a refusal returns to the form with its sentence and step-up', () => {
  let step: IssueStep = { step: 'form' };
  const sentence = 'You are about to issue: Secret clearance on the Canadian classified scale to Alex, until 31 March.';
  assert.deepEqual(nextStep(step, { kind: 'confirm' }), step, 'nothing is confirmed without a review');
  step = nextStep(step, { kind: 'reviewed', sentence });
  assert.deepEqual(step, { step: 'review', sentence });
  step = nextStep(step, { kind: 'confirm' });
  assert.deepEqual(step, { step: 'signing', sentence });
  assert.deepEqual(nextStep(step, { kind: 'refused', reason: ISSUER_TEXT.stepUp, fix: ISSUER_TEXT.confirm }), { step: 'form', message: `${ISSUER_TEXT.stepUp} ${ISSUER_TEXT.confirm}.` });
  assert.deepEqual(nextStep(step, { kind: 'issued', sentence: ISSUER_TEXT.issuedFile, fileName: 'credential-0a1b2c3d.near-vc' }), { step: 'done', sentence: ISSUER_TEXT.issuedFile, fileName: 'credential-0a1b2c3d.near-vc' });
  assert.deepEqual(nextStep({ step: 'review', sentence }, { kind: 'back' }), { step: 'form' });
});

test('the type picker names each type with its ceiling, and the card keeps key and engine code out of the browser', () => {
  assert.deepEqual(typeOptions([{ type: 'ClearanceCredential', label: 'clearance', ceiling: 'Secret on the Canadian classified scale', roleValidUntil: '2027-06-01T00:00:00Z', fields: [] },
    { type: 'NationalityCredential', label: 'nationality', roleValidUntil: '2027-06-01T00:00:00Z', fields: [] }]),
  [{ value: 'ClearanceCredential', label: 'clearance (up to Secret on the Canadian classified scale)' }, { value: 'NationalityCredential', label: 'nationality' }]);
  for (const file of ['extension/src/browser/credentials/issue-credential-widget.ts', 'extension/src/browser/credentials/credentials-frontend-module.ts']) {
    const imports = source(file).split('\n').filter((line) => line.startsWith('import'));
    assert.deepEqual(imports.filter((line) => /key-service|staff-engine|node:crypto|\/node\/|engine\//.test(line)), [], file);
  }
  const css = source('extension/src/browser/issue-credential.css');
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgb\(/, 'theme variables only');
});
