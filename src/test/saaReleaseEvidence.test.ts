import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { loadSaaMarketplaceApproval, loadSaaReleaseEvidence } from '../services/saaReleaseEvidence';

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
const runPath = '/actions/runs/42';
const runsPath = '/actions/workflows/release.yml/runs';
const jobsPath = `${runPath}/attempts/1/jobs`;
const approvalsPath = `${runPath}/approvals`;
const environmentPath = '/environments/marketplace';
const publishCompletedAt = '2024-01-02T00:00:00Z';
const releaseRun = {
  id: 42, path: '.github/workflows/release.yml', head_branch: tag, head_sha: commit, event: 'push',
  status: 'completed', conclusion: 'success', run_attempt: 1, created_at: '2024-01-01T00:00:00Z',
  repository: { id: 7, full_name: repository }, head_repository: { id: 7, full_name: repository },
  html_url: 'https://example.org/untrusted-run-link'
};
const publishJob = { name: 'publish', run_id: 42, head_sha: commit, status: 'completed', conclusion: 'success', completed_at: publishCompletedAt };
const marketplace = { id: 711, name: 'marketplace' };
const user = { id: 874, login: 'configured-reviewer-secret' };
const reviewer = { type: 'User', reviewer: user };
const environment = { ...marketplace, can_admins_bypass: false, protection_rules: [{ type: 'required_reviewers', reviewers: [reviewer] }] };
const decision = { state: 'approved', environments: [marketplace], user, comment: 'approval-comment-secret' };

function marketplaceResponses(overrides: Readonly<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const responses: Readonly<Record<string, unknown>> = {
    [runsPath]: { total_count: 1, workflow_runs: [releaseRun] },
    [runPath]: releaseRun,
    [jobsPath]: { total_count: 1, jobs: [publishJob] },
    [approvalsPath]: [decision], [environmentPath]: environment, ...overrides
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.github.com');
    assert.ok(url.pathname.startsWith(`/repos/${repository}/`));
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal instanceof AbortSignal);
    const path = url.pathname.slice(`/repos/${repository}`.length);
    calls.push(path);
    if (path === runsPath) assert.deepEqual(Object.fromEntries(url.searchParams), { event: 'push', head_sha: commit, per_page: '10' });
    if (path === jobsPath) assert.equal(url.searchParams.get('per_page'), '10');
    assert.ok(path in responses);
    const value = responses[path];
    return value instanceof Response ? value : Response.json(value);
  };
  return { calls, fetcher };
}

function tarEntry(name: string, bytes: Buffer, directory = false, type = directory ? 53 : 48): Buffer[] {
  // GNU tar writes a path over 100 bytes as a '././@LongLink' entry (type 'L') holding the name, then the entry with the name truncated.
  if (name.length > 100 && type !== 76) return [...tarEntry('././@LongLink', Buffer.from(`${name}\0`, 'ascii'), false, 76), ...tarEntry(name.slice(0, 100), bytes, directory)];
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'ascii');
  header.write(bytes.length.toString(8).padStart(11, '0'), 124, 'ascii');
  header.fill(32, 148, 156);
  header[156] = type;
  header.write('ustar  \0', 257, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return [header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)];
}

const longPath = `evidence/bundle/dashboard/text/${'controlled-goods-regulations-'.repeat(3)}long/cgp.json`;

function fixture(options: { manifestCommit?: string; corruptLedger?: boolean; longName?: boolean } = {}): Buffer {
  const root = `compliance-package-${tag}/`;
  const snapshot = Buffer.from(JSON.stringify({ schemaVersion: 1, commit, rows: [], levels: [], source: { ref: commit } }));
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, commit: options.manifestCommit ?? commit }));
  const long = Buffer.from('{}');
  const checksums = Buffer.from(`${options.corruptLedger ? 'b'.repeat(64) : hash(snapshot)}  ${dashboardPath}\n${hash(manifest)}  ${manifestPath}\n` +
    (options.longName ? `${hash(long)}  ${longPath}\n` : ''));
  const directories = ['', 'evidence/', 'evidence/bundle/', 'evidence/bundle/dashboard/'].flatMap(path => tarEntry(root + path, Buffer.alloc(0), true));
  return gzipSync(Buffer.concat([
    ...directories,
    ...tarEntry(root + dashboardPath, snapshot),
    ...tarEntry(root + manifestPath, manifest),
    ...(options.longName ? [
      ...tarEntry(root + 'evidence/bundle/dashboard/text/', Buffer.alloc(0), true),
      ...tarEntry(root + longPath.slice(0, longPath.lastIndexOf('/') + 1), Buffer.alloc(0), true),
      ...tarEntry(root + longPath, long)
    ] : []),
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

test('reads member paths over 100 bytes from GNU long-name entries', async () => {
  assert.ok(`compliance-package-${tag}/${longPath}`.length > 100);
  const archive = fixture({ longName: true });
  const result = await loadSaaReleaseEvidence(version, new AbortController().signal, mockGithub(archive).fetcher);
  assert.deepEqual(result.files.get(longPath), Buffer.from('{}'));
});

test('rejects a long-name entry that is not followed by a member', async () => {
  const root = `compliance-package-${tag}/`;
  const archive = gzipSync(Buffer.concat([...tarEntry('././@LongLink', Buffer.from(`${root}${longPath}\0`), false, 76), Buffer.alloc(1024)]));
  await assert.rejects(loadSaaReleaseEvidence(version, new AbortController().signal, mockGithub(archive).fetcher), /truncated or has unexpected trailing data/);
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

test('returns only the minimal Marketplace approval tied to the exact release build', async () => {
  const { calls, fetcher } = marketplaceResponses();
  const received = await loadSaaMarketplaceApproval({ version, commit }, new AbortController().signal, fetcher);
  assert.deepEqual(calls, [runsPath, jobsPath, environmentPath, approvalsPath, runPath]);
  assert.ok(received);
  assert.deepEqual(received, { tag, commit, runUrl: `https://github.com/${repository}/actions/runs/42`, publishCompletedAt, checkedAt: received.checkedAt });
  assert.ok(Date.parse(received.checkedAt) >= Date.parse(publishCompletedAt));
  assert.doesNotMatch(JSON.stringify(received), /approval-comment-secret|configured-reviewer-secret|untrusted-run-link/);
});

test('untrusted or ambiguous release jobs, environment settings and decisions leave the receipt unavailable', async () => {
  for (const overrides of [
    { [runsPath]: { total_count: 2, workflow_runs: [releaseRun] } },
    { [runsPath]: { total_count: 2, workflow_runs: [releaseRun, { ...releaseRun, id: 43, run_attempt: 2 }] } },
    ...[
      { ...releaseRun, head_branch: 'v0.4.35' },
      { ...releaseRun, head_sha: 'b'.repeat(40) },
      { ...releaseRun, head_repository: { id: 9, full_name: 'fork/demo' } },
      { ...releaseRun, path: '.github/workflows/other.yml' },
      { ...releaseRun, event: 'workflow_dispatch' },
      { ...releaseRun, run_attempt: 2 }
    ].map((run) => ({ [runsPath]: { total_count: 1, workflow_runs: [run] } })),
    { [jobsPath]: { total_count: 2, jobs: [publishJob, publishJob] } },
    { [jobsPath]: { total_count: 1, jobs: [{ ...publishJob, head_sha: 'b'.repeat(40) }] } },
    { [jobsPath]: { total_count: 1, jobs: [{ ...publishJob, conclusion: 'failure' }] } },
    { [jobsPath]: { total_count: 1, jobs: [{ ...publishJob, completed_at: 'invalid' }] } },
    { [environmentPath]: { ...environment, can_admins_bypass: true } },
    { [environmentPath]: { ...environment, can_admins_bypass: undefined } },
    ...[[reviewer, reviewer], [{ ...reviewer, type: 'Team' }]].map((reviewers) => ({
      [environmentPath]: { ...environment, protection_rules: [{ type: 'required_reviewers', reviewers }] }
    })),
    { [approvalsPath]: [decision, decision] },
    { [approvalsPath]: [{ ...decision, user: { id: 99 } }] },
    { [approvalsPath]: [{ ...decision, environments: [{ ...marketplace, id: 99 }] }] },
    { [approvalsPath]: [{ ...decision, state: 'rejected' }] },
    { [runPath]: { ...releaseRun, run_attempt: 2 } }
  ]) {
    assert.equal(await loadSaaMarketplaceApproval({ version, commit }, new AbortController().signal, marketplaceResponses(overrides).fetcher), undefined);
  }
});

test('missing, rate-limited and malformed optional responses remain unavailable and cancellation is preserved', async () => {
  for (const response of [new Response(null, { status: 404 }), new Response('private rate limit data', { status: 429 }), new Response('malformed')]) {
    const { fetcher } = marketplaceResponses({ [runsPath]: response });
    assert.equal(await loadSaaMarketplaceApproval({ version, commit }, new AbortController().signal, fetcher), undefined);
  }
  const controller = new AbortController();
  const reason = new Error('Export canceled');
  const during: typeof fetch = async () => {
    controller.abort(reason);
    return Response.json({ total_count: 0, workflow_runs: [] });
  };
  await assert.rejects(loadSaaMarketplaceApproval({ version, commit }, controller.signal, during), reason);
});
