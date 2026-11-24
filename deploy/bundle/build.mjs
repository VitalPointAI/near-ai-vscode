#!/usr/bin/env node
// Build a signed offline bundle on the connected side (D-47, D-12). Every image goes by digest through a staging registry (a local Zot the
// operator runs), where it is signed with your organization's key: that signature is what admission trusts at the site (47-05). The images
// with their signatures and the file items go into one hauler store; manifest.json lists every item with its digest and the archive's
// SHA-256, and is signed with the same key. Spike S1 flags (lib/cosign.mjs, lib/hauler.mjs).
//
//   node deploy/bundle/build.mjs --out <dir> --key <cosign key> --staging-registry <host:port> [--images <name,...>] [--files <path,...>]
//        [--version <x.y.z>] [--plain-http]
//
// --images names entries of deploy/bundle/images.lock.json `images` by image name (the ref without tag and digest); --files names files to
// carry as they are. COSIGN_PASSWORD (the key's password) is read from the environment by cosign. --plain-http is for a local staging Zot
// without TLS.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signImage, verifyImage } from './lib/cosign.mjs';
import { runHauler } from './lib/hauler.mjs';
import { imageName, readImagesLock, sitePath, splitRef } from './lib/locks.mjs';
import { ARCHIVE, MANIFEST, sha256File, writeManifest } from './lib/manifest.mjs';
import { signFile } from './signed-file.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The selected third-party images as { name (site path), ref, digest }. Refuses a name that is not in the lock. */
export function selectImages(root, names) {
  const lock = readImagesLock(root);
  return names.map((name) => {
    const entry = lock.images.find((image) => imageName(image) === name);
    if (!entry) throw new Error(`${name} is not an image in deploy/bundle/images.lock.json.`);
    return { name: sitePath(entry.ref), ref: entry.ref, digest: splitRef(entry.ref).digest };
  });
}

/**
 * Builds the bundle into `out`: stages and signs each image, adds images and files to a fresh store, saves store.tar.zst, writes and signs
 * manifest.json. `images` are { name, ref, digest }; `files` are paths. Returns the manifest.
 */
export async function buildBundle({ out, key, staging, images, files, version = '0.0.0', omitted = [], plainHttp = false, publicKey, cosign, hauler }) {
  if (existsSync(out) && readdirSync(out).length) throw new Error(`${out} is not empty; a bundle is built into an empty folder.`);
  mkdirSync(out, { recursive: true });
  const scratch = mkdtempSync(path.join(tmpdir(), 'sterling-build-'));
  try {
    const fetchStore = path.join(scratch, 'fetch');
    const bundleStore = path.join(scratch, 'bundle');
    const http = plainHttp ? ['--plain-http'] : [];
    for (const image of images) runHauler(['store', 'add', 'image', image.ref, '-s', fetchStore], { hauler });
    if (images.length) runHauler(['store', 'copy', '-s', fetchStore, ...http, `registry://${staging}`], { hauler });
    for (const image of images) {
      const staged = `${staging}/${image.name}@${image.digest}`;
      signImage(staged, key, { cosign, allowHttp: plainHttp });
      if (publicKey) {
        const verified = verifyImage(staged, publicKey, { cosign, allowHttp: plainHttp });
        if (!verified.ok) throw new Error(`${staged}: the signature just made does not verify (${verified.reason})`);
      }
      runHauler(['store', 'add', 'image', staged, '-s', bundleStore], { hauler });
    }
    const items = images.map((image) => ({ kind: 'image', name: image.name, ref: image.ref, digest: image.digest }));
    for (const file of files) {
      const kind = file.kind ?? 'file';
      const filePath = file.path ?? file;
      runHauler(['store', 'add', 'file', filePath, '-s', bundleStore], { hauler });
      items.push({ kind, name: path.basename(filePath), digest: await sha256File(filePath) });
    }
    const names = items.map((item) => `${item.kind === 'image' ? 'image' : 'file'}:${item.name}`);
    const duplicate = names.find((name, index) => names.indexOf(name) !== index);
    if (duplicate) throw new Error(`two bundle items are both named ${duplicate.split(':')[1]}; file items must have distinct file names.`);
    runHauler(['store', 'save', '-s', bundleStore, '-f', path.join(out, ARCHIVE)], { hauler });
    const manifest = { version, created: new Date().toISOString(), archive: { file: ARCHIVE, sha256: await sha256File(path.join(out, ARCHIVE)) }, items, omitted };
    writeManifest(path.join(out, MANIFEST), manifest);
    signFile(path.join(out, MANIFEST), key, { cosign });
    return manifest;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const option = (flag) => { const index = argv.indexOf(flag); return index < 0 ? undefined : argv[index + 1]; };
  const list = (flag) => (option(flag) ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  const usage = 'usage: build.mjs --out <dir> --key <cosign key> --staging-registry <host:port> [--images <name,...>] [--files <path,...>]\n'
    + '                 [--version <x.y.z>] [--public-key <cosign pub>] [--plain-http]   (COSIGN_PASSWORD in the environment)';
  if (argv.includes('--help')) { console.log(usage); process.exit(0); }
  const out = option('--out');
  const key = option('--key');
  const staging = option('--staging-registry');
  if (!out || !key || !staging) { console.error(usage); process.exit(2); }
  try {
    const manifest = await buildBundle({ out, key, staging, images: selectImages(ROOT, list('--images')), files: list('--files'), version: option('--version'),
      plainHttp: argv.includes('--plain-http'), publicKey: option('--public-key') });
    console.log(`built: ${out} with ${manifest.items.length} items, archive ${manifest.archive.sha256}; ${MANIFEST} signed`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
