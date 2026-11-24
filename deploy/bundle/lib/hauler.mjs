// The hauler calls of the bundle pipeline (research Decision 5, spike S1): images are added by digest without --key and without --platform
// (hauler's own key check cannot read cosign v3 bundle signatures, and --platform drops them), so the OCI referrers that carry your
// organization's signatures travel with each image. Signatures are checked with cosign before the add and after the site copy instead.
// The binary comes from $HAULER or PATH; every call gets its own hauler folder, so nothing is read from or left in ~/.hauler.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256File } from './manifest.mjs';

/** The hauler binary to run: an explicit path, $HAULER, or `hauler` on PATH. A relative path is taken from the working directory. */
export const haulerBinary = (hauler) => {
  const binary = hauler || process.env.HAULER || 'hauler';
  return binary.includes('/') ? path.resolve(binary) : binary;
};

/** Runs hauler with a private hauler folder; throws with hauler's message on failure. */
export function runHauler(args, { hauler, env } = {}) {
  const binary = haulerBinary(hauler);
  const home = mkdtempSync(path.join(tmpdir(), 'sterling-hauler-'));
  try {
    const run = spawnSync(binary, ['--haulerdir', home, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024 });
    if (run.error?.code === 'ENOENT') throw new Error(`hauler was not found (${binary}); set HAULER to the hauler binary or put it on PATH.`);
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(`hauler ${args[0]} ${args[1] ?? ''} failed: ${(run.stderr || run.stdout).trim().split('\n').slice(-3).join(' ')}`);
    return run.stdout;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** The repository path an image has in a registry reference: "<host>/<path>@sha256:..." without host and digest. */
export function repositoryPath(reference) {
  const withoutDigest = reference.split('@')[0];
  const slash = withoutDigest.indexOf('/');
  return slash < 0 ? withoutDigest : withoutDigest.slice(slash + 1);
}

/**
 * What a hauler store archive holds, as bundle items: images as { kind: 'image', name: <repository path>, digest: <manifest digest> } and
 * every file as { kind: 'file', name: <file name>, digest: <sha256 of its content> }. Loads the archive into a temporary store (never a
 * registry) and extracts the files to hash them. Signatures, attestations and referrers are not items.
 */
export async function listStore(archive, { hauler } = {}) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'sterling-store-'));
  try {
    const store = path.join(scratch, 'store');
    runHauler(['store', 'load', '-f', archive, '-s', store], { hauler });
    const info = JSON.parse(runHauler(['store', 'info', '-s', store, '-o', 'json'], { hauler }));
    const items = [];
    for (const artifact of info.artifacts ?? []) {
      if (artifact.type === 'image') items.push({ kind: 'image', name: repositoryPath(artifact.reference), digest: artifact.digest });
      else if (artifact.type === 'file') {
        const out = path.join(scratch, 'files', String(items.length));
        runHauler(['store', 'extract', '-s', store, '-o', out, artifact.reference], { hauler });
        for (const name of readdirSync(out)) items.push({ kind: 'file', name, digest: await sha256File(path.join(out, name)) });
        rmSync(out, { recursive: true, force: true });
      }
    }
    return items;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
