#!/usr/bin/env node
// Records the digests our images were published under into deploy/bundle/images.lock.json (D-12), after verifying each one's signature
// with your organization's public key. The built images come from the deploy-images workflow's built-digests artifact
// ({ "sterling/<name>": "sha256:..." }); the workbench comes from the Release workflow (Phase 46) in its GHCR repository.
//
//   node deploy/bundle/record-digests.mjs --from <built-digests.json> --ci-registry <host/prefix> --public-key <cosign pub>
//   node deploy/bundle/record-digests.mjs --release sterling/sterling-workbench=ghcr.io/<owner>/<repo>@sha256:<digest> --public-key <cosign pub>
//        [--release-repository ghcr.io/<owner>/<repo>]
//
// A name the lock does not list is refused, and nothing is written unless every signature verifies. Node built-ins and the pinned cosign.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyImage } from './lib/cosign.mjs';
import { DIGEST, IMAGES_LOCK } from './lib/locks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const RELEASE_REPOSITORY = 'ghcr.io/vitalpointai/near-ai-vscode';
const GHCR_REF = /^ghcr\.io\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/;

/**
 * Verifies and records digests. `built` is { name: digest } (from built-digests.json) with `ciRegistry`; `releases` is [{ name, ref }].
 * `verify(ref)` returns { ok, reason } (cosign verify with the public key by default). Returns the lock as written.
 */
export function recordDigests({ root = ROOT, built = {}, ciRegistry, releases = [], publicKey, releaseRepository = RELEASE_REPOSITORY, verify, write = true }) {
  const check = verify ?? ((ref) => verifyImage(ref, publicKey));
  const file = path.join(root, IMAGES_LOCK);
  const lock = JSON.parse(readFileSync(file, 'utf8'));
  const plan = [];
  for (const [name, digest] of Object.entries(built)) {
    const entry = lock.built.find((item) => item.name === name);
    if (!entry) throw new Error(`${name} is not a built image in ${IMAGES_LOCK}; refusing it.`);
    if (!DIGEST.test(digest)) throw new Error(`${name}: ${digest} is not a sha256 digest.`);
    if (!ciRegistry) throw new Error('--ci-registry names where the deploy-images workflow published the built images.');
    plan.push({ entry, digest, ref: `${ciRegistry}/${name}@${digest}` });
  }
  for (const { name, ref } of releases) {
    const entry = lock.release.find((item) => item.name === name);
    if (!entry) throw new Error(`${name} is not a release image in ${IMAGES_LOCK}; refusing it.`);
    if (!GHCR_REF.test(ref) || ref.split('@')[0] !== releaseRepository) {
      throw new Error(`${ref} is not ${releaseRepository}@sha256:<digest>, the repository the Release workflow publishes.`);
    }
    plan.push({ entry, digest: ref.split('@')[1], ref });
  }
  const failed = plan.map(({ ref }) => ({ ref, result: check(ref) })).filter(({ result }) => !result.ok);
  if (failed.length) throw new Error(`the signature did not verify with your organization's key: ${failed.map(({ ref, result }) => `${ref} (${result.reason.trim()})`).join('; ')}`);
  for (const { entry, digest } of plan) entry.digest = digest;
  if (write) writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const option = (flag) => { const index = argv.indexOf(flag); return index < 0 ? undefined : argv[index + 1]; };
  const usage = 'usage: record-digests.mjs --from <built-digests.json> --ci-registry <host/prefix> --public-key <cosign pub>\n'
    + '       record-digests.mjs --release sterling/sterling-workbench=<ghcr ref>@sha256:<digest> --public-key <cosign pub> [--release-repository <repo>]';
  const publicKey = option('--public-key');
  const from = option('--from');
  const release = option('--release');
  if (argv.includes('--help') || !publicKey || (!from && !release)) { console.error(usage); process.exit(argv.includes('--help') ? 0 : 2); }
  try {
    const releases = release ? [{ name: release.split('=')[0], ref: release.slice(release.indexOf('=') + 1) }] : [];
    recordDigests({ built: from ? JSON.parse(readFileSync(from, 'utf8')) : {}, ciRegistry: option('--ci-registry'), releases, publicKey,
      releaseRepository: option('--release-repository') ?? RELEASE_REPOSITORY });
    console.log(`record-digests: verified and recorded in ${IMAGES_LOCK}.`);
  } catch (error) {
    console.error(`record-digests: ${error.message}`);
    process.exit(1);
  }
}
