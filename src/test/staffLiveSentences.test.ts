// The words of the live connection (Phase 33, 33-09 Task 3; D-14, D-22, D-27, D-32, D-67, D-69): one word, one sentence, one action and an
// accessible name per state, every witness finding in your organization's words, and the copy rules checked through the copy-lint scanner itself.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { UPDATE_SENTENCE } from '../domain/replica/features';
import { HUB_FINDINGS } from '../domain/replica/hubWitness';
import { SYNC_STATES } from '../domain/replica/syncMachine';
import type { SyncState } from '../domain/replica/syncMachine';
import { MODE_IDS } from '../domain/org/modes';
import { term } from '../domain/org/terms';
import {
  FINDING_TEXT, QUARANTINE_TEXT, RESTORING_TEXT, SYNC_ACTIONS, SYNC_WORDS, findingSentence, refusalSentence, syncAccessibleName, syncAction, syncSentence
} from '../domain/staff/liveSentences';
import type { SentenceStatus } from '../domain/staff/liveSentences';
import { REPO_ROOT, countHits, extractCopy } from './helpers/copyLintScan';

const status = (state: SyncState, extra: Partial<SentenceStatus> = {}): SentenceStatus => ({ state, findings: [], ...extra });
const FILE = 'src/domain/staff/liveSentences.ts';

test('every one of the nine states has its word, a sentence, one action and an accessible name; a new state without words fails here', () => {
  assert.equal(SYNC_STATES.length, 9);
  for (const state of SYNC_STATES) {
    assert.equal(typeof SYNC_WORDS[state], 'string', state);
    assert.ok(syncSentence(status(state)).length > 10, state);
    assert.ok((SYNC_ACTIONS as readonly string[]).includes(syncAction(status(state))), state);
    assert.ok(syncAccessibleName(status(state)).includes(SYNC_WORDS[state]), state);
  }
});

test('the state words are the ones DESIGN 19 and the plan name', () => {
  assert.deepEqual({ ...SYNC_WORDS }, {
    'single-machine': 'This computer only', connecting: 'Connecting', authenticating: 'Connecting', 'catching-up': 'Catching up', live: 'Synced',
    offline: 'Offline', refused: 'Not accepted', attention: 'Needs attention', 'needs-update': 'Needs an update'
  });
});

test('offline names the last synced time, or says it has not synced yet', () => {
  assert.match(syncSentence(status('offline', { lastSyncedAt: Date.parse('2026-11-24T14:02:00.000Z') })), /Last synced at 14:02\./);
  assert.match(syncSentence(status('offline')), /Not synced yet\./);
  assert.match(syncSentence(status('offline')), /^You are offline\. Your changes are kept here/);
});

test('restoring shows RESTORING_TEXT exactly, as an offline detail and never attention', () => {
  assert.equal(RESTORING_TEXT, 'Your organization\'s server is being restored. Your changes are kept here.');
  assert.equal(syncSentence(status('offline', { reason: 'restoring' })), RESTORING_TEXT);
  assert.equal(syncAction(status('offline', { reason: 'restoring' })), 'sync-now');
});

test('catching up names the number of changes left', () => {
  assert.match(syncSentence(status('catching-up'), { remaining: 37 }), /37 changes to go/);
  assert.match(syncSentence(status('catching-up'), { remaining: 1 }), /1 change to go/);
});

test('needs-update is the Sterling update sentence and offers the update action', () => {
  assert.equal(syncSentence(status('needs-update')), UPDATE_SENTENCE);
  assert.equal(syncSentence(status('needs-update')), 'This shared work needs a newer version of Sterling. Ask your administrator to update it.');
  assert.equal(syncAction(status('needs-update')), 'update-extension');
});

test('refused names the reason and the person to ask with the lead word of the mode', () => {
  for (const mode of MODE_IDS) {
    const lead = term('lead', mode).toLowerCase();
    assert.ok(syncSentence(status('refused', { reason: 'revoked' }), { mode }).includes(lead), mode);
    assert.ok(refusalSentence('something-new', mode).includes(lead), mode);
  }
  assert.match(refusalSentence('not-admitted'), /does not know this computer/);
});

test('quarantine is D-14\'s sentence with the lead word from term()', () => {
  assert.match(QUARANTINE_TEXT, /\{lead\}/);
  assert.equal(refusalSentence('quarantined', 'military'), `One of your computers signed two different histories. Your new work is held until the ${term('lead', 'military').toLowerCase()} looks at it.`);
  assert.equal(syncSentence(status('refused', { reason: 'quarantined' }), { mode: 'military' }), refusalSentence('quarantined', 'military'));
});

test('attention gives the finding\'s sentence; Re-admit is offered only to a lead device and only for rolled-back and forked-view', () => {
  const forked = status('attention', { reason: 'forked-view', findings: ['forked-view'] });
  assert.equal(syncSentence(forked), FINDING_TEXT['forked-view']);
  assert.equal(syncAction(forked, { isLeadDevice: true }), 'readmit');
  assert.equal(syncAction(forked, { isLeadDevice: false }), 'show-details');
  assert.equal(syncAction(status('attention', { findings: ['rolled-back'] }), { isLeadDevice: true }), 'readmit');
  assert.equal(syncAction(status('attention', { findings: ['injected'] }), { isLeadDevice: true }), 'show-details');
});

test('every witness finding has user words: your organization\'s server, never the internal words, never a hash', () => {
  assert.deepEqual(Object.keys(FINDING_TEXT).sort(), Object.keys(HUB_FINDINGS).sort());
  for (const id of Object.keys(HUB_FINDINGS)) {
    const text = findingSentence(id, 3);
    assert.match(text, /^Your organization's server /, id);
    assert.doesNotMatch(text, /\bhubs?\b|\bentr(y|ies)\b|[0-9a-f]{12}|\bproject\b/i, id);
  }
  assert.equal(findingSentence('withheld', 1), 'Your organization\'s server has not delivered 1 change that other people\'s work refers to.');
  assert.equal(findingSentence('delayed'), 'Your organization\'s server has not confirmed your changes for some minutes.');
  assert.match(findingSentence('not-a-finding'), /could not check/);
});

test('no sentence in this file calls shared work a project (D-69) or uses a dash as punctuation', () => {
  const texts = [...Object.values(SYNC_WORDS), ...Object.values(FINDING_TEXT), RESTORING_TEXT, QUARANTINE_TEXT, ...SYNC_STATES.map((state) => syncSentence(status(state), { mode: 'military' })), refusalSentence('revoked', 'military')];
  for (const text of texts) {
    assert.doesNotMatch(text, /\bproject\b/i, text);
    assert.doesNotMatch(text, /—|–/, text);
  }
});

test('the copy-lint scanner finds no rule hit in liveSentences.ts, and no line outside a comment says hub', () => {
  const source = readFileSync(path.join(REPO_ROOT, FILE), 'utf8');
  const counts = countHits(extractCopy(source, FILE), FILE);
  assert.deepEqual(counts, {}, JSON.stringify(counts));
  const code = source.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  assert.doesNotMatch(code, /\bhub\b/i);
});
