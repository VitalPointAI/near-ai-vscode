// The bundle manifest (D-47): format sterling-bundle/1. A bundle is a folder holding store.tar.zst (the hauler store archive), manifest.json
// and manifest.json.sigstore.json (its cosign signature). manifest.json: { format, version, created, archive: { file, sha256 }, items: [{ kind:
// image|chart|file|tool, name, ref?, digest: "sha256:<64 hex>" }], omitted: [names of release images deliberately left out] }. Node built-ins only.
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { DIGEST } from './locks.mjs';

export const FORMAT = 'sterling-bundle/1';
export const MANIFEST = 'manifest.json';
export const ARCHIVE = 'store.tar.zst';
export const KINDS = Object.freeze(['image', 'chart', 'file', 'tool']);

/** The SHA-256 of a file as "sha256:<hex>", read as a stream (bundle archives are gigabytes). */
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(`sha256:${hash.digest('hex')}`));
  });
}

/** Writes manifest.json; the caller signs it afterwards. */
export function writeManifest(file, manifest) {
  writeFileSync(file, `${JSON.stringify({ format: FORMAT, ...manifest }, null, 2)}\n`);
}

/** Reads manifest.json with JSON.parse only and refuses a malformed one. Returns { manifest, problems }. */
export function readManifest(file) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { return { manifest: null, problems: [`${MANIFEST} is not valid JSON (${error.message})`] }; }
  const problems = [];
  if (manifest?.format !== FORMAT) problems.push(`${MANIFEST}: format is ${JSON.stringify(manifest?.format)}, not ${FORMAT}`);
  if (!manifest?.archive || typeof manifest.archive.file !== 'string' || !DIGEST.test(manifest.archive.sha256 ?? '')) problems.push(`${MANIFEST}: archive needs a file and a sha256:<64 hex> digest`);
  if (!Array.isArray(manifest?.items) || manifest.items.length === 0) problems.push(`${MANIFEST}: items must be a non-empty list`);
  for (const item of Array.isArray(manifest?.items) ? manifest.items : []) {
    if (!KINDS.includes(item?.kind) || typeof item.name !== 'string' || !item.name || !DIGEST.test(item.digest ?? '')) {
      problems.push(`${MANIFEST}: item ${JSON.stringify(item?.name ?? item)} needs a kind (${KINDS.join(', ')}), a name and a sha256:<64 hex> digest`);
    }
  }
  return { manifest, problems };
}

// A store knows images and files only: charts and tools travel as files under their own file names.
const key = (item) => `${item.kind === 'image' ? 'image' : 'file'}:${item.name}`;

/** Plain problem strings comparing the manifest's items with what the store holds: missing, extra, or a different digest. */
export function compareItems(manifestItems, storeItems) {
  const want = new Map(manifestItems.map((item) => [key(item), item]));
  const have = new Map(storeItems.map((item) => [key(item), item]));
  const problems = [];
  for (const [id, item] of want) {
    const found = have.get(id);
    if (!found) problems.push(`${item.kind} ${item.name} is in the manifest but not in the store`);
    else if (found.digest !== item.digest) problems.push(`${item.kind} ${item.name} has digest ${found.digest} in the store, not ${item.digest} as the manifest says`);
  }
  for (const [id, item] of have) if (!want.has(id)) problems.push(`${item.kind} ${item.name} is in the store but not in the manifest`);
  return problems;
}
