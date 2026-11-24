#!/usr/bin/env node
// Import a bundle at the site (D-47, D-48): check first, then copy. The same script and the same bundle format serve the first install and
// every update; an update is simply a newer bundle.
//   1. checkBundle (check.mjs): manifest signature, archive digest, every item digest. Any problem stops here with exit 1; nothing has
//      touched the registry or the install folder.
//   2. Only then: the images with their signatures go into the site registry (hauler store copy), the file items into the install folder.
//   3. Every imported image digest is verified again in the site registry with the same public key, so a signature lost on the way fails
//      the import now instead of every pod at admission (Pitfall 16).
//
//   node deploy/bundle/import.mjs --bundle <dir> --public-key <cosign pub> --registry <host:port> --out <install dir>
//        [--registry-auth <file>] [--registry-kind zot|harbor] [--registry-ca <pem>] [--plain-http]
//
// --registry-auth names a JSON file { "username": ..., "password": ... } for the registry's import account (never an argument).
// --registry-kind harbor creates each Harbor project (the first path segment of every image's site path) through the Harbor API before the
// copy (Pitfall 17); zot (the default) needs nothing. --registry-ca is the site CA that issued the registry's certificate. --plain-http is
// for a lab registry without TLS only.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBundle } from './check.mjs';
import { verifyImage } from './lib/cosign.mjs';
import { runHauler } from './lib/hauler.mjs';

/** Reads the registry account file; returns { username, password } or null. */
function readAuth(file) {
  if (!file) return null;
  const auth = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof auth.username !== 'string' || typeof auth.password !== 'string') throw new Error(`${file}: needs "username" and "password".`);
  return auth;
}

/** The Harbor projects the images need: the first path segment of each image name. */
export const harborProjects = (images) => [...new Set(images.map((item) => item.name.split('/')[0]))].sort();

/** Creates each Harbor project that does not exist yet (POST /api/v2.0/projects; 409 means it exists). */
async function createHarborProjects(registry, auth, projects, { plainHttp }) {
  if (!auth) throw new Error('--registry-kind harbor needs --registry-auth (an account allowed to create projects).');
  const authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
  for (const project of projects) {
    const response = await fetch(`${plainHttp ? 'http' : 'https'}://${registry}/api/v2.0/projects`, {
      method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ project_name: project, public: true })
    });
    if (response.status !== 201 && response.status !== 409) throw new Error(`Harbor refused to create project ${project}: HTTP ${response.status}`);
  }
}

/**
 * Imports a checked bundle. `load` is the copy step (images and files), injectable so the refusal tests can prove it never runs on a bad
 * bundle; the default copies with hauler. Returns { ok, problems }.
 */
export async function importBundle({ dir, publicKey, registry, out, auth = null, registryKind = 'zot', registryCa, plainHttp = false, cosign, hauler, check = checkBundle, load }) {
  const checked = await check({ dir, publicKey, cosign, hauler });
  if (!checked.ok) return { ok: false, problems: checked.problems };
  const { manifest } = checked;
  const images = manifest.items.filter((item) => item.kind === 'image');
  const env = registryCa ? { SSL_CERT_FILE: registryCa } : {};
  const copy = load ?? (async () => {
    if (registryKind === 'harbor') await createHarborProjects(registry, auth, harborProjects(images), { plainHttp });
    const scratch = mkdtempSync(path.join(tmpdir(), 'sterling-import-'));
    try {
      const store = path.join(scratch, 'store');
      const docker = path.join(scratch, 'docker');
      mkdirSync(docker);
      runHauler(['store', 'load', '-f', path.join(dir, manifest.archive.file), '-s', store], { hauler, env });
      if (auth) {
        writeFileSync(path.join(docker, 'config.json'), JSON.stringify({ auths: { [registry]: { auth: Buffer.from(`${auth.username}:${auth.password}`).toString('base64') } } }), { mode: 0o600 });
      }
      runHauler(['store', 'copy', '-s', store, ...(plainHttp ? ['--plain-http'] : []), `registry://${registry}`], { hauler, env: { ...env, DOCKER_CONFIG: docker } });
      if (manifest.items.some((item) => item.kind !== 'image')) {
        mkdirSync(out, { recursive: true });
        for (const item of manifest.items.filter((entry) => entry.kind !== 'image')) {
          runHauler(['store', 'extract', '-s', store, '-o', out, `hauler/${item.name}:latest`], { hauler, env });
        }
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
  await copy({ manifest, registry, out });
  const missing = [];
  for (const image of images) {
    const result = verifyImage(`${registry}/${image.name}@${image.digest}`, publicKey, { cosign, allowHttp: plainHttp, env });
    if (!result.ok) missing.push(`${image.name}@${image.digest}: no valid signature in ${registry} after the copy (${result.reason.split('\n').at(-1)})`);
  }
  return missing.length ? { ok: false, problems: missing } : { ok: true, problems: [], manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const option = (flag) => { const index = argv.indexOf(flag); return index < 0 ? undefined : argv[index + 1]; };
  const usage = 'usage: import.mjs --bundle <dir> --public-key <cosign pub> --registry <host:port> --out <install dir> [--registry-auth <file>]\n'
    + '                  [--registry-kind zot|harbor] [--registry-ca <pem>] [--plain-http]   (COSIGN and HAULER name the binaries, default PATH)';
  if (argv.includes('--help')) { console.log(usage); process.exit(0); }
  const dir = option('--bundle');
  const publicKey = option('--public-key');
  const registry = option('--registry');
  const out = option('--out');
  const registryKind = option('--registry-kind') ?? 'zot';
  if (!dir || !publicKey || !registry || !out || !['zot', 'harbor'].includes(registryKind)) { console.error(usage); process.exit(2); }
  try {
    const result = await importBundle({ dir, publicKey, registry, out, registryKind, auth: readAuth(option('--registry-auth')), registryCa: option('--registry-ca'), plainHttp: argv.includes('--plain-http') });
    if (!result.ok) {
      console.error(`refused: ${dir} was not imported.`);
      for (const problem of result.problems) console.error(`  - ${problem}`);
      process.exit(1);
    }
    console.log(`imported: ${result.manifest.items.length} items into ${registry} and ${out}; every image signature verified in the registry`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
