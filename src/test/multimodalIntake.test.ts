import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MultimodalIntake, MultimodalIntakeError } from '../services/multimodalIntake';
import { PrivacyPreflight } from '../services/privacyPreflight';

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fixture-media')]);

test('stages a local image as opaque bounded metadata without raw media in the record', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-intake-'));
  await mkdir(path.join(root, 'assets'));
  await writeFile(path.join(root, 'assets', 'diagram.png'), png);
  const intake = new MultimodalIntake(root, { now: () => Date.parse('2026-01-01T00:00:00Z') });
  const result = await intake.stage({ sourcePath: 'assets/diagram.png', consent: true });
  assert.equal(result.accepted, true);
  assert.equal(result.record.modality, 'image');
  assert.equal(result.record.byteSize, png.length);
  assert.match(result.record.managedReference, /^multimodal:\/\/attachment-/);
  assert.equal(JSON.stringify(result.record).includes(png.toString('utf8')), false);
  assert.equal(intake.rawHandle(result.record.artifactId), undefined);
  assert.equal((await readFile(path.join(root, '.planning', '.near-ai', 'multimodal', `${result.record.artifactId}.bin`))).equals(png), true);
});

test('rejects traversal, absolute paths, symlink escapes, and missing files before staging', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-intake-paths-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'near-ai-intake-outside-'));
  await mkdir(path.join(root, 'assets'));
  await writeFile(path.join(root, 'assets', 'safe.png'), png);
  await writeFile(path.join(outside, 'escape.png'), png);
  await symlink(path.join(outside, 'escape.png'), path.join(root, 'assets', 'linked.png'));
  const intake = new MultimodalIntake(root, { privacy: new PrivacyPreflight() });
  for (const [sourcePath, code] of [['../escape.png', 'path-traversal'], ['/tmp/escape.png', 'absolute-path'], ['missing.png', 'missing-file'], ['assets/linked.png', 'symlink-escape']] as const) {
    await expectCode(intake.stage({ sourcePath, consent: true }), code);
  }
});

test('fails closed for oversized, forged, unsupported, and malformed structured inputs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-intake-invalid-'));
  await writeFile(path.join(root, 'fake.png'), Buffer.alloc(1025, 1));
  await writeFile(path.join(root, 'data.json'), Buffer.from('{"broken":'));
  await writeFile(path.join(root, 'payload.bin'), Buffer.from('opaque'));
  const intake = new MultimodalIntake(root, { maxBytesRead: 1024 });
  await expectCode(intake.stage({ sourcePath: 'fake.png', consent: true }), 'oversized');
  const normal = new MultimodalIntake(root);
  await expectCode(normal.stage({ sourcePath: 'fake.png', consent: true }), 'content-mismatch');
  await expectCode(normal.stage({ sourcePath: 'data.json', consent: true }), 'malformed-structured-data');
  await expectCode(normal.stage({ sourcePath: 'payload.bin', consent: true }), 'unsupported-modality');
});

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    assert.fail(`Expected multimodal rejection: ${code}`);
  } catch (error) {
    assert.equal(error instanceof MultimodalIntakeError, true);
    assert.equal((error as MultimodalIntakeError).code, code);
  }
}

test('validates image, video, audio, document, and structured data with detected content', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-intake-modalities-'));
  await writeFile(path.join(root, 'image.png'), png);
  await writeFile(path.join(root, 'video.mp4'), Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.from('isom')]));
  await writeFile(path.join(root, 'audio.mp3'), Buffer.from('ID3fixture'));
  await writeFile(path.join(root, 'document.pdf'), Buffer.from('%PDF-1.7 fixture'));
  await writeFile(path.join(root, 'table.csv'), Buffer.from('name,value\nalpha,1\n'));
  const intake = new MultimodalIntake(root);
  const results = await Promise.all(['image.png', 'video.mp4', 'audio.mp3', 'document.pdf', 'table.csv'].map((sourcePath) => intake.stage({ sourcePath, consent: true })));
  assert.deepEqual(results.map((result) => result.record.modality).sort(), ['audio', 'document', 'image', 'structured', 'video']);
  assert.equal(results.every((result) => result.record.privacy.localOnly && result.record.privacy.redaction === 'metadata-only'), true);
});

test('preserves consent and privacy preflight fail-closed behavior', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-intake-privacy-'));
  await mkdir(path.join(root, 'private'));
  await writeFile(path.join(root, 'private', 'notes.txt'), Buffer.from('private notes'));
  const intake = new MultimodalIntake(root, { privacy: new PrivacyPreflight() });
  await expectCode(intake.stage({ sourcePath: 'private/notes.txt', consent: true }), 'sensitive-source');
  await writeFile(path.join(root, 'notes.txt'), Buffer.from('notes'));
  await expectCode(intake.stage({ sourcePath: 'notes.txt', consent: false }), 'consent-required');
});
