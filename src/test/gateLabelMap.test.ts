// Label map v1 (CLAS-01, D-25): the format, the key rule, the resolution order, raise-only unverified maps, the edits a writer needs and the label-map
// purpose on the one signer. Keys are generated at run time; no key material or token literal is written here.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import test from 'node:test';
import { fingerprintOf } from '../domain/team/canonical';
import type { KeyStatusLookup } from '../domain/team/keyStatus';
import { PayloadError, signPayload, verifyPayload } from '../domain/team/signedPayload';
import type { PayloadSigner } from '../domain/team/signedPayload';
import { LABEL_MAP_VERSION, MAX_LABEL_MAP_BYTES, labelMapKey, missingLabelPaths, moveLabelEntry, parseLabelMap, resolveLabel, setLabelEntry, setProjectLabel } from '../domain/gate/labelMap';
import type { LabelMapPayload } from '../domain/gate/labelMap';
import { SCALE_PRESETS } from '../domain/gate/labels';
import type { Label } from '../domain/gate/labels';
import { MAX_PAYLOAD_BYTES } from '../domain/team/signedPayload';

function label(level: string, extra: Partial<Label> = {}): Label {
  return { scale: 'org', level, compartments: [], releasability: [], handling: [], ...extra };
}

const DEFAULT = label('Public');
const scales = SCALE_PRESETS;

function mapOf(entries: Record<string, Label>, project?: Label): LabelMapPayload {
  const payload = { labelMapVersion: 1, vocabulary: 1, entries };
  const parsed = parseLabelMap(project === undefined ? payload : { ...payload, project }, scales);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) throw new Error('unreachable');
  return parsed.value;
}

function makeSigner(): PayloadSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  return { fingerprint: fingerprintOf(raw), publicKey: raw.toString('base64url'), sign: (bytes: Buffer): string => edSign(null, bytes, privateKey).toString('base64url') };
}

const activeFor = (signer: PayloadSigner): KeyStatusLookup => (key) => (key.fingerprint === signer.fingerprint ? { state: 'active' } : { state: 'unknown' });

const full = mapOf({ 'src/': label('Confidential'), 'src/a.ts': label('Restricted') }, label('Internal'));

test('tracer: resolution takes the file, then the nearest folder, then the project, then the bundle default', () => {
  const sources = { verified: full, bundleDefault: DEFAULT, scales };
  const file = resolveLabel('src/a.ts', sources);
  assert.deepEqual([file.mark, file.origin, file.raisedByUnverified], [[label('Restricted')], 'file', false]);
  const folder = resolveLabel('src/b.ts', sources);
  assert.deepEqual([folder.mark, folder.origin], [[label('Confidential')], 'folder']);
  const project = resolveLabel('docs/x.md', sources);
  assert.deepEqual([project.mark, project.origin], [[label('Internal')], 'project']);
  const none = mapOf({ 'src/': label('Confidential') });
  const fallback = resolveLabel('docs/x.md', { verified: none, bundleDefault: DEFAULT, scales });
  assert.deepEqual([fallback.mark, fallback.origin], [[DEFAULT], 'default']);
  assert.deepEqual(resolveLabel('docs/x.md', { bundleDefault: DEFAULT, scales }).origin, 'default');
});

test('the nearest ancestor wins, and a deeper entry beats a shallower one even when it is lower', () => {
  const map = mapOf({ 'src/': label('Restricted'), 'src/open/': label('Public') });
  assert.equal(resolveLabel('src/open/deep/x.ts', { verified: map, bundleDefault: DEFAULT, scales }).mark[0]?.level, 'Public');
  assert.equal(resolveLabel('src/other/x.ts', { verified: map, bundleDefault: DEFAULT, scales }).mark[0]?.level, 'Restricted');
  // A folder is resolved by its own entry first.
  const folder = resolveLabel('src/open/', { verified: map, bundleDefault: DEFAULT, scales });
  assert.deepEqual([folder.mark[0]?.level, folder.origin], ['Public', 'folder']);
  assert.equal(resolveLabel('src/', { verified: map, bundleDefault: DEFAULT, scales }).mark[0]?.level, 'Restricted');
});

test('path boundaries: src2/x.ts does not inherit from src/, and a file named like a folder is not the folder (edge CLAS-01 adjacency)', () => {
  const map = mapOf({ 'src/': label('Confidential'), 'src/a.ts': label('Restricted') });
  const sources = { verified: map, bundleDefault: DEFAULT, scales };
  assert.equal(resolveLabel('src/a.ts', sources).mark[0]?.level, 'Restricted');
  assert.equal(resolveLabel('src/b.ts', sources).mark[0]?.level, 'Confidential');
  assert.deepEqual([resolveLabel('src2/x.ts', sources).mark[0]?.level, resolveLabel('src2/x.ts', sources).origin], ['Public', 'default']);
  assert.equal(resolveLabel('src', sources).origin, 'default');
  assert.equal(resolveLabel('./src//b.ts', sources).mark[0]?.level, 'Confidential');
});

test('an empty map resolves every path to the bundle default, and empty lists are valid labels (edge CLAS-01 empty)', () => {
  const empty = mapOf({});
  for (const path of ['a.ts', 'src/b/c.ts', 'docs/']) {
    const resolved = resolveLabel(path, { verified: empty, bundleDefault: DEFAULT, scales });
    assert.deepEqual([resolved.mark, resolved.origin, resolved.raisedByUnverified], [[DEFAULT], 'default', false]);
  }
  const bare = parseLabelMap({ labelMapVersion: 1, vocabulary: 1, entries: { 'a.ts': { scale: 'org', level: 'Public', compartments: [], releasability: [], handling: [] } } }, scales);
  assert.equal(bare.ok, true);
  assert.equal(LABEL_MAP_VERSION, 1);
});

test('an unverified map only raises: it never lowers a label, and says when it raised one (D-25, T-70-12)', () => {
  const verified = mapOf({ 'src/a.ts': label('Restricted') }, label('Internal'));
  const unverified = mapOf({ 'src/a.ts': label('Public'), 'docs/x.md': label('Confidential') });
  const sources = { verified, unverified, bundleDefault: DEFAULT, scales };
  const lowered = resolveLabel('src/a.ts', sources);
  assert.deepEqual([lowered.mark, lowered.raisedByUnverified], [[label('Restricted')], false]);
  const raised = resolveLabel('docs/x.md', sources);
  assert.deepEqual([raised.mark, raised.origin, raised.raisedByUnverified], [[label('Confidential')], 'project', true]);
  // With no verified map at all, an unverified one still raises above the default and cannot lower it.
  const alone = resolveLabel('docs/x.md', { unverified, bundleDefault: DEFAULT, scales });
  assert.deepEqual([alone.mark, alone.origin, alone.raisedByUnverified], [[label('Confidential')], 'default', true]);
  assert.equal(resolveLabel('src/a.ts', { unverified: mapOf({ 'src/a.ts': label('Public') }), bundleDefault: label('Internal'), scales }).mark[0]?.level, 'Internal');
  // The unverified map's own project entry and compartments can raise too, and equal labels are not a raise.
  const withCompartment = mapOf({ 'src/a.ts': label('Restricted', { compartments: ['PROJ-X'] }) });
  const joined = resolveLabel('src/a.ts', { verified, unverified: withCompartment, bundleDefault: DEFAULT, scales });
  assert.deepEqual([joined.mark[0]?.compartments, joined.raisedByUnverified], [['PROJ-X'], true]);
  assert.equal(resolveLabel('src/a.ts', { verified, unverified: verified, bundleDefault: DEFAULT, scales }).raisedByUnverified, false);
});

test('an unverified label on another scale is kept beside the verified one, never replacing it', () => {
  const verified = mapOf({ 'a.ts': label('Internal') });
  const unverified = mapOf({ 'a.ts': { scale: 'nato', level: 'NATO Restricted', compartments: [], releasability: [], handling: [] } });
  const resolved = resolveLabel('a.ts', { verified, unverified, bundleDefault: DEFAULT, scales });
  assert.equal(resolved.raisedByUnverified, true);
  assert.deepEqual(resolved.mark.map((entry) => `${entry.scale}/${entry.level}`).sort(), ['nato/NATO Restricted', 'org/Internal']);
});

test('keys are normalised paths: folders end in /, and .. a leading /, a backslash and over 512 characters are refused (CLAS-01, D-25)', () => {
  assert.deepEqual(labelMapKey('src/a.ts', false), { ok: true, value: 'src/a.ts' });
  assert.deepEqual(labelMapKey('./src//lib', true), { ok: true, value: 'src/lib/' });
  assert.deepEqual(labelMapKey('src/lib/', true), { ok: true, value: 'src/lib/' });
  for (const bad of ['', '/', '/etc/x', '../x', 'src/../../x', 'a/../b', 'a\\b', 'C:/x', 'a\u0000b', '.', './']) assert.equal(labelMapKey(bad, false).ok, false, JSON.stringify(bad));
  assert.equal(labelMapKey('a'.repeat(512), false).ok, true);
  assert.equal(labelMapKey('a'.repeat(513), false).ok, false);
  assert.equal(labelMapKey('a'.repeat(511), true).ok, true);
  assert.equal(labelMapKey('a'.repeat(512), true).ok, false);
  const entry = { scale: 'org', level: 'Public', compartments: [], releasability: [], handling: [] };
  for (const key of ['../x', '/abs', 'a//b', './a', 'a/./b', `${'a'.repeat(513)}`, 'a\\b', '']) {
    assert.equal(parseLabelMap({ labelMapVersion: 1, vocabulary: 1, entries: { [key]: entry } }, scales).ok, false, JSON.stringify(key));
  }
  // A path named like a prototype member is an entry like any other.
  const proto = parseLabelMap(JSON.parse('{"labelMapVersion":1,"vocabulary":1,"entries":{"__proto__":{"scale":"org","level":"Restricted","compartments":[],"releasability":[],"handling":[]}}}'), scales);
  assert.equal(proto.ok, true);
  if (proto.ok) {
    assert.equal(resolveLabel('__proto__', { verified: proto.value, bundleDefault: DEFAULT, scales }).mark[0]?.level, 'Restricted');
    assert.equal(resolveLabel('constructor', { verified: proto.value, bundleDefault: DEFAULT, scales }).origin, 'default');
  }
});

test('parseLabelMap refuses an unknown field, a wrong version, a missing field and a label that does not parse', () => {
  const ok = { labelMapVersion: 1, vocabulary: 1, entries: {} };
  assert.equal(parseLabelMap(ok, scales).ok, true);
  const reason = (value: unknown): string => { const parsed = parseLabelMap(value, scales); return parsed.ok ? 'ok' : parsed.reason; };
  assert.equal(reason({ ...ok, extra: 1 }), 'unknown-field');
  assert.equal(reason({ labelMapVersion: 1, entries: {} }), 'missing-field');
  assert.equal(reason({ labelMapVersion: 2, vocabulary: 1, entries: {} }), 'unknown-version');
  assert.equal(reason({ labelMapVersion: 1, vocabulary: 2, entries: {} }), 'unknown-version');
  assert.equal(reason({ labelMapVersion: '1', vocabulary: 1, entries: {} }), 'wrong-type');
  assert.equal(reason({ ...ok, entries: [] }), 'wrong-type');
  assert.equal(reason({ ...ok, entries: { 'a.ts': { scale: 'org', level: 'Secret' } } }), 'missing-field');
  assert.equal(reason({ ...ok, entries: { 'a.ts': { scale: 'org', level: 'Secret', compartments: [], releasability: [], handling: [] } } }), 'not-allowed-here');
  assert.equal(reason({ ...ok, project: { scale: 'org', level: 'Public', compartments: [], releasability: [], handling: [], extra: 1 } }), 'unknown-field');
  assert.equal(reason('text'), 'wrong-type');
  assert.equal(reason(null), 'wrong-type');
  assert.equal(reason({ ...ok, entries: { 'a.ts': { scale: 'org', level: 'Public', compartments: [], releasability: [], handling: ['relax'] } } }), 'not-allowed-here');
});

test('edits return new maps: set, remove, move a file, move a folder with its subtree, and list the paths that are gone', () => {
  const before = mapOf({ 'src/': label('Confidential'), 'src/a.ts': label('Restricted'), 'src/deep/b.ts': label('Internal'), 'srcx/c.ts': label('Restricted') }, label('Internal'));
  const set = setLabelEntry(before, 'docs/', label('Public'));
  assert.equal(Object.keys(before.entries).includes('docs/'), false);
  assert.equal(set.entries['docs/']?.level, 'Public');
  assert.equal(set.project?.level, 'Internal');
  assert.equal(setLabelEntry(set, 'docs/', undefined).entries['docs/'], undefined);
  assert.equal(setLabelEntry(before, 'src/a.ts', label('Public')).entries['src/a.ts']?.level, 'Public');
  assert.equal(setProjectLabel(before, undefined).project, undefined);
  assert.equal(setProjectLabel(before, label('Restricted')).project?.level, 'Restricted');
  assert.throws(() => setLabelEntry(before, '../x', label('Public')), /cannot be used/);

  const file = moveLabelEntry(before, 'src/a.ts', 'lib/a.ts');
  assert.deepEqual(Object.keys(file.entries).sort(), ['lib/a.ts', 'src/', 'src/deep/b.ts', 'srcx/c.ts']);
  const folder = moveLabelEntry(before, 'src/', 'lib/');
  assert.deepEqual(Object.keys(folder.entries).sort(), ['lib/', 'lib/a.ts', 'lib/deep/b.ts', 'srcx/c.ts']);
  assert.equal(folder.entries['lib/deep/b.ts']?.level, 'Internal');
  assert.equal(folder.project?.level, 'Internal');
  assert.equal(Object.keys(before.entries).length, 4);
  assert.throws(() => moveLabelEntry(before, 'src/', 'lib'), /cannot move/);
  // A moved entry replaces what the destination held, as the renamed file did.
  const clash = moveLabelEntry(before, 'src/a.ts', 'srcx/c.ts');
  assert.equal(clash.entries['srcx/c.ts']?.level, 'Restricted');
  assert.equal(Object.keys(clash.entries).length, 3);

  const present = new Set(['src/', 'src/a.ts']);
  assert.deepEqual(missingLabelPaths(before, (key) => present.has(key)), ['src/deep/b.ts', 'srcx/c.ts']);
  assert.deepEqual(missingLabelPaths(mapOf({}), () => false), []);
});

test('the label-map purpose signs and verifies through the one signer, and a signature made for it is not a policy bundle', () => {
  const signer = makeSigner();
  const envelope = signPayload(signer, 'label-map', full);
  assert.equal(envelope.purpose, 'label-map');
  const verdict = verifyPayload<LabelMapPayload>(envelope, { purpose: 'label-map', status: activeFor(signer) });
  assert.equal(verdict.ok, true);
  if (verdict.ok) {
    const parsed = parseLabelMap(verdict.payload, scales);
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.deepEqual(parsed.value, full);
  }
  const wrong = verifyPayload(envelope, { purpose: 'policy-bundle', status: activeFor(signer) });
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.equal(wrong.reason, 'wrong-purpose');
  const reverse = verifyPayload(signPayload(signer, 'policy-bundle', full), { purpose: 'label-map', status: activeFor(signer) });
  assert.equal(reverse.ok, false);
  if (!reverse.ok) assert.equal(reverse.reason, 'wrong-purpose');
});

test('a path key that looks like a secret makes signPayload throw a PayloadError that a writer must catch and name (Pitfall 9)', () => {
  const signer = makeSigner();
  // Built at run time so no token-shaped literal sits in this file.
  const secretLike = `keys/${'sk'}-${'x'.repeat(24)}.txt`;
  const map = mapOf({ [secretLike]: label('Restricted') });
  assert.throws(() => signPayload(signer, 'label-map', map), (error: unknown) => error instanceof PayloadError && !error.message.includes(secretLike));
});

test('the size a writer refuses above leaves room under the signed payload limit', () => {
  assert.equal(MAX_LABEL_MAP_BYTES, 200 * 1024);
  assert.ok(MAX_LABEL_MAP_BYTES < MAX_PAYLOAD_BYTES);
});
