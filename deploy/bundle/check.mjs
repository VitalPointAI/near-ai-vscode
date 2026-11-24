#!/usr/bin/env node
// Offline verification of a bundle at the site (D-48): nothing is loaded into a registry or a cluster unless all of this holds.
//   1. manifest.json carries a valid signature by your organization's public key (verifySignedFile, the one check for every signed file);
//   2. the manifest is format sterling-bundle/1, and no item carries the reserved unpublished digest;
//   3. the archive's SHA-256 equals the manifest's;
//   4. the archive, loaded into a temporary store (never the registry), holds exactly the manifest's items with the same digests.
// The public key comes from the install media, never from the bundle (T-47-18).
//
//   node deploy/bundle/check.mjs --bundle <dir> --public-key <cosign pub>
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listStore as haulerListStore } from './lib/hauler.mjs';
import { UNPUBLISHED_DIGEST } from './lib/locks.mjs';
import { MANIFEST, compareItems, readManifest, sha256File } from './lib/manifest.mjs';
import { verifySignedFile } from './signed-file.mjs';

const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/**
 * Checks a bundle folder. Returns { ok, problems, manifest }; ok only when every check passed. `listStore(archivePath)` lists the archive's
 * items (default: hauler into a temporary store); `cosign` names the cosign binary.
 */
export async function checkBundle({ dir, publicKey, cosign, hauler, listStore = (archive) => haulerListStore(archive, { hauler }) }) {
  const refuse = (problems, manifest = null) => ({ ok: false, problems, manifest });
  const manifestFile = path.join(dir, MANIFEST);
  const signature = verifySignedFile(manifestFile, publicKey, { cosign });
  if (!signature.ok) return refuse([`the manifest signature does not verify: ${signature.reason}`]);
  const { manifest, problems } = readManifest(manifestFile);
  if (problems.length) return refuse(problems, manifest);
  const unpublished = manifest.items.filter((item) => item.digest === UNPUBLISHED_DIGEST).map((item) => `${item.kind} ${item.name} carries the reserved unpublished digest; an unpublished image is never installed`);
  if (unpublished.length) return refuse(unpublished, manifest);
  if (!PLAIN_NAME.test(manifest.archive.file)) return refuse([`${MANIFEST}: archive.file must be a file name inside the bundle folder`], manifest);
  const archive = path.join(dir, manifest.archive.file);
  if (!existsSync(archive)) return refuse([`the archive ${manifest.archive.file} is missing`], manifest);
  const digest = await sha256File(archive);
  if (digest !== manifest.archive.sha256) return refuse([`the archive ${manifest.archive.file} has digest ${digest}, not ${manifest.archive.sha256} as the signed manifest says`], manifest);
  let stored;
  try { stored = await listStore(archive); } catch (error) { return refuse([`the archive could not be read: ${error.message}`], manifest); }
  const differences = compareItems(manifest.items, stored);
  if (differences.length) return refuse(differences, manifest);
  return { ok: true, problems: [], manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const option = (flag) => { const index = argv.indexOf(flag); return index < 0 ? undefined : argv[index + 1]; };
  const usage = 'usage: check.mjs --bundle <dir> --public-key <cosign pub>   (COSIGN and HAULER name the binaries, default PATH)';
  if (argv.includes('--help')) { console.log(usage); process.exit(0); }
  const dir = option('--bundle');
  const publicKey = option('--public-key');
  if (!dir || !publicKey) { console.error(usage); process.exit(2); }
  try {
    const result = await checkBundle({ dir, publicKey });
    if (!result.ok) {
      console.error(`refused: the bundle in ${dir} does not verify; nothing was loaded.`);
      for (const problem of result.problems) console.error(`  - ${problem}`);
      process.exit(1);
    }
    console.log(`verified: ${dir} (${result.manifest.version ?? 'no version'}): the manifest signature, the archive digest and ${result.manifest.items.length} item digests`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
