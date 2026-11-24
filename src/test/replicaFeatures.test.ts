import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KNOWN_REPLICA_FEATURES, MAX_FEATURES, UPDATE_SENTENCE, coversRequired, isReplicaFeature, missingFeatures
} from '../domain/replica/features';

test('the known replica feature registry is sorted and frozen', () => {
  assert.deepEqual(KNOWN_REPLICA_FEATURES, ['cells@1', 'hub@1', 'replica@2', 'require@1']);
  assert.ok(Object.isFrozen(KNOWN_REPLICA_FEATURES));
  assert.equal(MAX_FEATURES, 16);
});

test('replica feature ids accept lowercase names and positive versions within the wire limits', () => {
  for (const id of ['positions@1', 'cells@1', 'a-b@999', `${'a'.repeat(32)}@1`]) {
    assert.ok(isReplicaFeature(id), id);
  }
});

test('replica feature ids reject malformed names, versions and non-text values', () => {
  for (const id of ['positions', 'positions@0', 'positions@01', 'positions@1000', 'Positions@1', '1abc@1',
    'part.name@1', `${'a'.repeat(33)}@1`, 'cells@1\n', 1, null]) {
    assert.equal(isReplicaFeature(id), false, String(id));
  }
});

test('missingFeatures reports ids outside the local registry', () => {
  assert.deepEqual(missingFeatures(['positions@1', 'require@1']), ['positions@1']);
});

test('missingFeatures returns a sorted set without changing the required list', () => {
  const required = ['z@1', 'require@1', 'a@1', 'z@1'];
  assert.deepEqual(missingFeatures(required), ['a@1', 'z@1']);
  assert.deepEqual(required, ['z@1', 'require@1', 'a@1', 'z@1']);
});

test('missingFeatures can check a supplied registry', () => {
  assert.deepEqual(missingFeatures(['positions@1', 'require@1'], [...KNOWN_REPLICA_FEATURES, 'positions@1']), []);
});

test('coversRequired accepts an empty requirement and all announced known requirements', () => {
  assert.equal(coversRequired([], []), true);
  assert.equal(coversRequired(KNOWN_REPLICA_FEATURES, ['require@1', 'cells@1']), true);
});

test('coversRequired refuses missing announcements and unknown required features', () => {
  assert.equal(coversRequired([], ['require@1']), false);
  assert.equal(coversRequired(['cells@1'], ['require@1', 'cells@1']), false);
  assert.equal(coversRequired(['positions@1', 'require@1'], ['positions@1', 'require@1']), false);
});

test('the update sentence names the extension and has no version number', () => {
  assert.equal(UPDATE_SENTENCE, 'This project needs a newer version of the extension. Update to keep working on it.');
  assert.doesNotMatch(UPDATE_SENTENCE, /[\d—]/);
});
