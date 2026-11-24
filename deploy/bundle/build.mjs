#!/usr/bin/env node
// Build a signed offline bundle on the connected side (D-47, D-12). Every image goes by digest through a staging registry (a local Zot the
// operator runs), where it is signed with your organization's key: that signature is what admission trusts at the site (47-05). The images
// with their signatures and the file items go into one hauler store; manifest.json lists every item with its digest and the archive's
// SHA-256, and is signed with the same key. Spike S1 flags (lib/cosign.mjs, lib/hauler.mjs). One format serves the first install and every
// update: an update is simply a newer bundle.
//
// The whole bundle (no --images or --files):
//   - every third-party image of deploy/bundle/images.lock.json `images`;
//   - every `built` and `release` image by its recorded digest from --ci-registry (where deploy-images.yml and the workbench release publish,
//     for example ghcr.io/<owner>); a null digest is refused unless the name is given to --omit (recorded in manifest.json `omitted`), or,
//     for built images, --build-local builds every deploy/images/*/image.json with podman under the heavy-run lock instead (the lab, before
//     CI-published images exist);
//   - every vendored chart of deploy/charts/charts.lock.json, after the same hash check as vendor.mjs --check;
//   - the rke2 pin with its assets, and helm, cosign and hauler, downloaded from their pinned addresses and checked against the pinned SHA-256;
//   - deploy-tree.tar: deploy/ without deploy/test/, deploy/lab/ and deploy/charts/vendored/ (realm, policies, values, local charts, node
//     files and scripts).
//
//   node deploy/bundle/build.mjs --out <dir> --key <cosign key> --staging-registry <host:port> [--version <x.y.z>] [--ci-registry <host/prefix>]
//        [--omit <name,...>] [--build-local] [--images <name,...>] [--files <path,...>] [--public-key <cosign pub>] [--plain-http]
//
// COSIGN_PASSWORD (the key's password) is read from the environment by cosign. --plain-http is for a local staging Zot without TLS.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { checkVendored } from '../charts/vendor.mjs';
import { runCosign, signImage, verifyImage } from './lib/cosign.mjs';
import { runHauler } from './lib/hauler.mjs';
import { imageName, readChartsLock, readImagesLock, readToolPins, sitePath, splitRef } from './lib/locks.mjs';
import { ARCHIVE, MANIFEST, sha256File, writeManifest } from './lib/manifest.mjs';
import { signFile } from './signed-file.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** The tools the site needs from tool-pins.json: RKE2 for the nodes, and helm, cosign and hauler for the import host. */
export const SITE_TOOLS = Object.freeze(['rke2', 'helm', 'cosign', 'hauler']);
const PIN_HOSTS = new Set(['github.com', 'get.helm.sh']);
const HEAVY_LOCK = process.env.STERLING_HEAVY_LOCK || path.join(process.env.XDG_RUNTIME_DIR || tmpdir(), 'sterling-heavy-run.lock');

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
 * Every image of the whole bundle. Third-party images come by their lock ref; built and release images by `<ciRegistry>/<name>@<digest>`
 * (copied to `<staging>/<name>` because their site path is `sterling/<name>`). Refuses, before anything is fetched, every null digest that is
 * neither omitted nor (for built images) built locally. Returns { images, omitted, buildLocal (built entries to build) }.
 */
export function planImages(root, { ciRegistry, omit = [], buildLocal = false }) {
  const lock = readImagesLock(root);
  const images = lock.images.map((entry) => ({ name: sitePath(entry.ref), ref: entry.ref, digest: splitRef(entry.ref).digest }));
  const omitted = [];
  const toBuild = [];
  const refused = [];
  for (const [section, entries] of [['built', lock.built], ['release', lock.release]]) {
    for (const entry of entries) {
      if (omit.includes(entry.name)) { omitted.push(entry.name); continue; }
      if (section === 'built' && buildLocal) { toBuild.push(entry); continue; }
      if (!entry.digest) { refused.push(entry.name); continue; }
      if (!ciRegistry) throw new Error(`${entry.name} is published by digest; name the registry it is published in with --ci-registry <host/prefix>.`);
      images.push({ name: entry.name, ref: `${ciRegistry}/${entry.name}@${entry.digest}`, digest: entry.digest, rename: true });
    }
  }
  const unknown = omit.filter((name) => ![...lock.built, ...lock.release].some((entry) => entry.name === name));
  if (unknown.length) throw new Error(`--omit names ${unknown.join(', ')}, which ${unknown.length > 1 ? 'are' : 'is'} not a built or release image in deploy/bundle/images.lock.json.`);
  if (refused.length) {
    throw new Error(`${refused.join(', ')} ${refused.length > 1 ? 'have' : 'has'} no published digest in deploy/bundle/images.lock.json; publish ${refused.length > 1 ? 'them' : 'it'} first, `
      + 'name it in --omit to leave it out on purpose, or use --build-local for the images built here.');
  }
  return { images, omitted, toBuild };
}

/**
 * Every vendored chart as a file item, after the vendor.mjs --check hash check. A lock entry with `patch` carries its patched tarball
 * (`patch.output`, the one renders and installs use); `patch.file` is the diff, not a chart.
 */
export function planCharts(root) {
  const problems = checkVendored(root);
  if (problems.length) throw new Error(`the vendored charts do not match deploy/charts/charts.lock.json:\n  ${problems.join('\n  ')}`);
  return readChartsLock(root).charts.map((chart) => ({ kind: 'chart', path: path.join(root, chart.patch?.output ?? chart.file) }));
}

/** The pinned downloads of the site tools as [{ url, sha256, name }]: each tool's own address and its assets. */
export function planTools(root, tools = SITE_TOOLS) {
  const pins = readToolPins(root);
  return tools.flatMap((tool) => {
    const pin = pins[tool];
    if (!pin) throw new Error(`compliance/ci/tool-pins.json has no pin for ${tool}.`);
    return [{ url: pin.url, sha256: pin.sha256 }, ...(pin.assets ?? []).map((asset) => ({ url: asset.url, sha256: asset.sha256 }))]
      .map((download) => ({ ...download, name: decodeURIComponent(new URL(download.url).pathname.split('/').pop()) }));
  });
}

/** Downloads one pinned file over https from an allowed host; refuses it unless its SHA-256 is the pin's. */
async function fetchPinned({ url, sha256, name }, dir) {
  const address = new URL(url);
  if (address.protocol !== 'https:' || !PIN_HOSTS.has(address.hostname)) throw new Error(`${url}: a site tool is fetched over https from ${[...PIN_HOSTS].join(' or ')} only.`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.url.startsWith('https://')) throw new Error(`${url}: download failed (HTTP ${response.status}).`);
  // Streamed to a partial file while hashing (the RKE2 image archives are hundreds of megabytes); renamed only when the hash matches.
  const file = path.join(dir, name);
  const hash = createHash('sha256');
  const source = Readable.fromWeb(response.body);
  source.on('data', (chunk) => hash.update(chunk));
  await pipeline(source, createWriteStream(`${file}.partial`));
  const actual = hash.digest('hex');
  if (actual !== sha256) { rmSync(`${file}.partial`, { force: true }); throw new Error(`${name}: SHA-256 ${actual} is not the pinned ${sha256}; refusing it.`); }
  renameSync(`${file}.partial`, file);
  return file;
}

/** deploy-tree.tar: the deploy folder without its tests, the lab and the vendored tarballs (those travel as chart items), in a stable order. */
function deployTree(root, dir) {
  const file = path.join(dir, 'deploy-tree.tar');
  const run = spawnSync('tar', ['-cf', file, '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
    '--exclude=deploy/test', '--exclude=deploy/lab', '--exclude=deploy/charts/vendored', '-C', root, 'deploy'], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`tar of deploy/ failed: ${run.stderr || run.error?.message}`);
  return file;
}

/** Runs podman under the heavy-run lock (one heavy run at a time on the build host). */
function podman(args) {
  const run = spawnSync('flock', ['-w', '7200', HEAVY_LOCK, 'podman', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (run.error?.code === 'ENOENT') throw new Error('flock or podman was not found on PATH.');
  if (run.status !== 0) throw new Error(`podman ${args[0]} failed: ${(run.stderr || '').trim().split('\n').slice(-3).join(' ')}`);
  return run.stdout;
}

/**
 * Builds every built image with an image.json as deploy/images/README.md defines (source checkout at a full commit, pinned tools through
 * install-tool.sh, build arguments), pushes it to the staging registry and returns { name, ref, digest } for each.
 */
function buildLocal(root, entries, { staging, plainHttp, scratch }) {
  const built = [];
  for (const entry of entries) {
    const file = path.join(root, entry.image);
    if (!existsSync(file)) { console.error(`build-local: ${entry.name} has no ${entry.image} yet; left out of the bundle.`); continue; }
    const definition = JSON.parse(readFileSync(file, 'utf8'));
    // The context is copied so pinned tools can be placed in it without touching the checkout; the repository root (the hub) is used as is.
    const context = definition.context === '.' ? root : path.join(scratch, `context-${definition.name}`);
    if (context !== root) spawnSync('cp', ['-a', path.join(root, definition.context), context]);
    const args = ['build', '--pull=missing', '-f', path.join(root, definition.containerfile), '-t', `${staging}/${entry.name}:local`];
    if (definition.source) {
      if (!/^[0-9a-f]{40}$/.test(definition.source.ref)) throw new Error(`${entry.image}: source.ref must be a full 40-character commit SHA.`);
      const checkout = path.join(scratch, `source-${definition.name}`);
      for (const git of [['init', '-q', checkout], ['-C', checkout, 'fetch', '-q', '--depth', '1', `https://github.com/${definition.source.repository}.git`, definition.source.ref],
        ['-C', checkout, 'checkout', '-q', 'FETCH_HEAD']]) {
        const run = spawnSync('git', git, { encoding: 'utf8' });
        if (run.status !== 0) throw new Error(`the source checkout of ${definition.name} failed: ${run.stderr.trim()}`);
      }
      args.push('--build-context', `upstream=${checkout}`);
    }
    for (const tool of definition.tools ?? []) {
      const run = spawnSync('sh', [path.join(root, 'compliance/ci/install-tool.sh'), tool.pin, path.join(context, tool.dir)], { encoding: 'utf8' });
      if (run.status !== 0) throw new Error(`install-tool.sh ${tool.pin} failed: ${run.stderr}`);
    }
    for (const [name, value] of Object.entries(definition.buildArgs ?? {})) args.push('--build-arg', `${name}=${value}`);
    podman([...args, context]);
    const digestFile = path.join(scratch, `${definition.name}.digest`);
    podman(['push', ...(plainHttp ? ['--tls-verify=false'] : []), '--digestfile', digestFile, `${staging}/${entry.name}:local`]);
    const digest = readFileSync(digestFile, 'utf8').trim();
    built.push({ name: entry.name, ref: `${staging}/${entry.name}@${digest}`, digest, staged: true });
  }
  return built;
}

/**
 * Builds the bundle into `out`: stages and signs each image, adds images and files to a fresh store, saves store.tar.zst, writes and signs
 * manifest.json. `images` are { name, ref, digest, rename?, staged? }; `files` are paths or { kind, path }. Returns the manifest.
 */
export async function buildBundle({ out, key, staging, images, files, version = '0.0.0', omitted = [], plainHttp = false, publicKey, cosign, hauler }) {
  if (existsSync(out) && readdirSync(out).length) throw new Error(`${out} is not empty; a bundle is built into an empty folder.`);
  mkdirSync(out, { recursive: true });
  const scratch = mkdtempSync(path.join(tmpdir(), 'sterling-build-'));
  try {
    const fetchStore = path.join(scratch, 'fetch');
    const bundleStore = path.join(scratch, 'bundle');
    const http = plainHttp ? ['--plain-http'] : [];
    // Third-party images keep their path (hauler strips the source host); ours are renamed to sterling/<name> with cosign copy.
    const direct = images.filter((image) => !image.rename && !image.staged);
    for (const image of direct) runHauler(['store', 'add', 'image', image.ref, '-s', fetchStore], { hauler });
    if (direct.length) runHauler(['store', 'copy', '-s', fetchStore, ...http, `registry://${staging}`], { hauler });
    for (const image of images.filter((entry) => entry.rename)) {
      const copied = runCosign(['copy', ...(plainHttp ? ['--allow-http-registry'] : []), '-f', image.ref, `${staging}/${image.name}:bundle`], { cosign });
      if (!copied.ok) throw new Error(`cosign copy ${image.ref} failed: ${copied.stderr}`);
    }
    for (const image of images) {
      const staged = `${staging}/${image.name}@${image.digest}`;
      signImage(staged, key, { cosign, allowHttp: plainHttp });
      if (publicKey) {
        const verified = verifyImage(staged, publicKey, { cosign, allowHttp: plainHttp });
        if (!verified.ok) throw new Error(`${staged}: the signature just made does not verify (${verified.reason})`);
      }
      runHauler(['store', 'add', 'image', staged, '-s', bundleStore], { hauler });
    }
    const items = images.map((image) => ({ kind: 'image', name: image.name, ...(image.staged ? {} : { ref: image.ref }), digest: image.digest }));
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

/** The whole bundle from the locks (see the top of this file). */
export async function buildWholeBundle(root, { out, key, staging, version, ciRegistry, omit, buildLocal: local, plainHttp, publicKey }) {
  const { images, omitted, toBuild } = planImages(root, { ciRegistry, omit, buildLocal: local });
  const charts = planCharts(root);
  const downloads = planTools(root);
  const scratch = mkdtempSync(path.join(tmpdir(), 'sterling-build-files-'));
  try {
    const tools = [];
    for (const download of downloads) tools.push({ kind: 'tool', path: await fetchPinned(download, scratch) });
    const built = toBuild.length ? buildLocal(root, toBuild, { staging, plainHttp, scratch }) : [];
    const files = [...charts, ...tools, { kind: 'file', path: deployTree(root, scratch) }];
    return await buildBundle({ out, key, staging, images: [...images, ...built], files, version, omitted, plainHttp, publicKey });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const option = (flag) => { const index = argv.indexOf(flag); return index < 0 ? undefined : argv[index + 1]; };
  const list = (flag) => (option(flag) ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  const usage = [
    'usage: build.mjs --out <dir> --key <cosign key> --staging-registry <host:port> [--version <x.y.z>]',
    '                 [--ci-registry <host/prefix>] [--omit <name,...>] [--build-local]         the whole bundle from the locks',
    '                 [--images <name,...>] [--files <path,...>]                               or only these items',
    '                 [--public-key <cosign pub>] [--plain-http]                               (COSIGN_PASSWORD in the environment)'
  ].join('\n');
  if (argv.includes('--help')) { console.log(usage); process.exit(0); }
  const out = option('--out');
  const key = option('--key');
  const staging = option('--staging-registry');
  const version = option('--version') ?? '0.0.0';
  if (!out || !key || !staging || !/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version)) { console.error(usage); process.exit(2); }
  const common = { out, key, staging, version, plainHttp: argv.includes('--plain-http'), publicKey: option('--public-key') };
  try {
    const selected = argv.includes('--images') || argv.includes('--files');
    const manifest = selected
      ? await buildBundle({ ...common, images: selectImages(ROOT, list('--images')), files: list('--files') })
      : await buildWholeBundle(ROOT, { ...common, ciRegistry: option('--ci-registry'), omit: list('--omit'), buildLocal: argv.includes('--build-local') });
    console.log(`built: ${out} with ${manifest.items.length} items${manifest.omitted.length ? ` (omitted: ${manifest.omitted.join(', ')})` : ''}, archive ${manifest.archive.sha256}; ${MANIFEST} signed`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
