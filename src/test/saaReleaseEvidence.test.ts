import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { loadSaaReleaseEvidence } from '../services/saaReleaseEvidence';

const version = '0.4.36';
const commit = 'a'.repeat(40);
const tag = `v${version}`;
const fileName = `compliance-package-${version}.tar.gz`;
const repository = 'VitalPointAI/near-ai-vscode';
const metadataUrl = `https://api.github.com/repos/${repository}/releases/tags/${tag}`;
const assetUrl = `https://github.com/${repository}/releases/download/${tag}/${fileName}`;
const cdnUrl = 'https://release-assets.githubusercontent.com/release/test';
const dashboardPath = 'evidence/bundle/dashboard/dashboard.json';
const manifestPath = 'evidence/bundle/manifest.json';
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');

function tarEntry(name: string, bytes: Buffer, directory = false): Buffer[] {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'ascii');
  header.write(bytes.length.toString(8).padStart(11, '0'), 124, 'ascii');
  header.fill(32, 148, 156);
  header[156] = directory ? 53 : 48;
  header.write('ustar  \0', 257, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return [header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)];
}

function fixture(options: { manifestCommit?: string; corruptLedger?: boolean } = {}): Buffer {
  const root = `compliance-package-${tag}/`;
  const snapshot = Buffer.from(JSON.stringify({ schemaVersion: 1, commit, rows: [], levels: [], source: { ref: commit } }));
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, commit: options.manifestCommit ?? commit }));
  const checksums = Buffer.from(`${options.corruptLedger ? 'b'.repeat(64) : hash(snapshot)}  ${dashboardPath}\n${hash(manifest)}  ${manifestPath}\n`);
  const directories = ['', 'evidence/', 'evidence/bundle/', 'evidence/bundle/dashboard/'].flatMap(path => tarEntry(root + path, Buffer.alloc(0), true));
  return gzipSync(Buffer.concat([
    ...directories,
    ...tarEntry(root + dashboardPath, snapshot),
    ...tarEntry(root + manifestPath, manifest),
    ...tarEntry(root + 'SHA256SUMS', checksums),
    Buffer.alloc(1024)
  ]));
}

function asset(archive: Buffer) {
  return { name: fileName, browser_download_url: assetUrl, size: archive.length, digest: `sha256:${hash(archive)}` };
}

function mockGithub(archive: Buffer, options: { received?: Buffer; assets?: unknown[]; redirect?: string } = {}) {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    assert.equal(init?.credentials, 'omit');
    assert.ok(init?.signal instanceof AbortSignal);
    if (url === metadataUrl) {
      assert.equal(init?.redirect, 'error');
      return Response.json({ tag_name: tag, draft: false, assets: options.assets ?? [asset(archive)] });
    }
    if (url === assetUrl) {
      assert.equal(init?.redirect, 'manual');
      return new Response(null, { status: 302, headers: { location: options.redirect ?? cdnUrl } });
    }
    assert.equal(url, cdnUrl);
    return new Response(new Uint8Array(options.received ?? archive));
  };
  return { fetcher, calls };
}

test('loads the selected release archive and validates the digest and its file ledger', async () => {
  const archive = fixture();
  const { fetcher, calls } = mockGithub(archive);
  const result = await loadSaaReleaseEvidence(version, new AbortController().signal, fetcher);
  assert.deepEqual(calls, [metadataUrl, assetUrl, cdnUrl]);
  assert.equal(result.version, version);
  assert.equal(result.commit, commit);
  assert.equal(result.sha256, hash(archive));
  assert.equal(result.fileName, fileName);
  assert.equal(result.sourceUrl, `https://github.com/${repository}/releases/tag/${tag}`);
  assert.deepEqual(result.archive, archive);
  assert.deepEqual([...result.files.keys()], [dashboardPath, manifestPath, 'SHA256SUMS']);
});

test('rejects missing and ambiguous release assets before download', async () => {
  const archive = fixture();
  for (const [assets, message] of [
    [[], /does not provide an assessor archive/],
    [[asset(archive), asset(archive)], /verified download metadata/]
  ] as const) {
    const { fetcher, calls } = mockGithub(archive, { assets: [...assets] });
    await assert.rejects(loadSaaReleaseEvidence(version, new AbortController().signal, fetcher), message);
    assert.deepEqual(calls, [metadataUrl]);
  }
});

test('rejects a redirect outside the approved GitHub release asset hosts', async () => {
  const { fetcher, calls } = mockGithub(fixture(), { redirect: 'https://example.org/file' });
  await assert.rejects(loadSaaReleaseEvidence(version, new AbortController().signal, fetcher), /redirected outside/);
  assert.deepEqual(calls, [metadataUrl, assetUrl]);
});

test('rejects an asset with a different digest, a bad internal ledger, or conflicting commits', async () => {
  const archive = fixture();
  const changed = Buffer.from(archive);
  changed[changed.length - 1] ^= 1;
  for (const [mock, message] of [
    [mockGithub(archive, { received: changed }), /published checksum/],
    [mockGithub(fixture({ corruptLedger: true })), /file checksums/],
    [mockGithub(fixture({ manifestCommit: 'c'.repeat(40) })), /matching source commit/]
  ] as const) {
    await assert.rejects(loadSaaReleaseEvidence(version, new AbortController().signal, mock.fetcher), message);
  }
});

test('honors cancellation before contacting GitHub and during the download', async () => {
  const controller = new AbortController();
  const reason = new Error('Export canceled');
  const archive = fixture();
  const canceled = mockGithub(archive);
  controller.abort(reason);
  await assert.rejects(loadSaaReleaseEvidence(version, controller.signal, canceled.fetcher), reason);
  assert.deepEqual(canceled.calls, []);

  const during = new AbortController();
  const mock = mockGithub(archive);
  let streamCanceled = false;
  const fetcher: typeof fetch = async (input, init) => {
    const response = await mock.fetcher(input, init);
    if (String(input) === cdnUrl) {
      return new Response(new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new Uint8Array(archive.subarray(0, 1)));
          setImmediate(() => during.abort(reason));
        },
        cancel() {
          streamCanceled = true;
        }
      }));
    }
    return response;
  };
  await assert.rejects(loadSaaReleaseEvidence(version, during.signal, fetcher), reason);
  assert.deepEqual(mock.calls, [metadataUrl, assetUrl, cdnUrl]);
  assert.equal(streamCanceled, true);
});
