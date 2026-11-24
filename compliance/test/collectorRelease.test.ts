import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseCollector } from '../src/collectors/release.ts';
import type { CollectorContext } from '../src/collectors/types.ts';

// The shapes GitHub returned for v0.4.36: an annotated tag (the ref names a tag object), and release assets that carry a digest but no content.
const tagObject = '55021f1c8b32c85c92425204644e0f2d02b054aa';
const commit = 'a'.repeat(40);
const vsixDigest = 'dcbc45c13e10596d901afb64d3b4e461e37f4b745b6775389f2f1ba8cef2a920';
const checksumDigest = 'a78181ab49a1efe5faec3c13ad71f040fc78da79962ca1aa10f844d6aca0b032';
const assets = (vsix = vsixDigest, checksum = checksumDigest) => [
  { name: 'near-ai-vscode-0.4.36.vsix', digest: `sha256:${vsix}` },
  { name: 'near-ai-vscode-0.4.36.vsix.sha256', digest: `sha256:${checksum}` }
];
const context = (status: string, release = assets(), ref: unknown = { sha: tagObject, type: 'tag' }): CollectorContext => ({
  now: new Date('2026-11-21T12:00:00Z'), commit, readFile: async () => '',
  fetchJson: async (url) => url.includes('/git/ref/') ? { object: ref }
    : url.includes(`/git/tags/${tagObject}`) ? { object: { sha: commit, type: 'commit' } }
    : url.includes(`/compare/${commit}...main`) ? { status }
    : url.includes('/releases/tags/') ? { assets: release }
    : Promise.reject(new Error(`unexpected ${url}`))
});
const collect = (ctx: CollectorContext) => releaseCollector.collect({ repository: 'acme/demo', tag: 'v0.4.36' }, ctx);

test('an annotated tag on main whose checksum file matches the VSIX passes', async () => {
  const [o] = await collect(context('behind'));
  assert.equal(o.passed, true);
  assert.deepEqual(o.counts, { assets: 2, onMain: 1, checksumMatches: 1, failures: 0 });
});
test('a lightweight tag naming the commit directly also works', async () => {
  const [o] = await collect(context('identical', assets(), { sha: commit, type: 'commit' }));
  assert.equal(o.passed, true);
});
test('a tag not on main fails', async () => {
  const [o] = await collect(context('ahead'));
  assert.equal(o.passed, false);
  assert.equal(o.counts?.onMain, 0);
});
test('a VSIX that does not match its checksum file fails', async () => {
  const [o] = await collect(context('identical', assets('c'.repeat(64))));
  assert.equal(o.passed, false);
  assert.equal(o.counts?.checksumMatches, 0);
});
test('a missing checksum file fails', async () => {
  const [o] = await collect(context('identical', assets().slice(0, 1)));
  assert.equal(o.passed, false);
});
test('a tag that names neither a commit nor a tag object is an error, not evidence', async () => {
  await assert.rejects(collect(context('identical', assets(), { sha: commit, type: 'tree' })), /does not name a commit/);
});
