import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const REPOSITORY = 'VitalPointAI/near-ai-vscode';
export const SAA_RELEASE_VERSION = /^(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})$/;
const DIGEST = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const ASSET_HOSTS = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const ARCHIVE_LIMIT = 32 * 1024 * 1024;
const UNPACKED_LIMIT = 96 * 1024 * 1024;
const METADATA_LIMIT = 1024 * 1024;
const MAX_ENTRIES = 2048;
const TAR_BLOCK_SIZE = 512;
const DASHBOARD_PATH = 'evidence/bundle/dashboard/dashboard.json';
const MANIFEST_PATH = 'evidence/bundle/manifest.json';
const PRIVACY_FORMS_URL = 'https://www.canada.ca/content/dam/tbs-sct/documents/forms/';
const PRIVACY_FORMS = [
  ['personal-information-bank-submission-form-en.docx', '3b6bc698249b5218f92da2847fd6bdccb848f5caf80591ecf21a82e9844f3510'],
  ['privacy-checklist-template-en.docx', '4dc010518e1a2f54c5dc3b9f0e5f1d8ed52317541ce91d5ed8fdedbac93a510c'],
  ['privacy-impact-assessment-template-en.docx', '6196f6b02534c6281c2ce1dd7061ac4dca5d266629dd61f3282a819248b87ec1'],
  ['privacy-impact-assessment-web-summary-template-en.docx', 'fc4d51cee0c334ddbf3548688aff1ed7769d6e5c9a2acb5e8024007e0bf3f34a'],
  ['privacy-protocol-template-en.docx', '84ee37a670b4b151b1e6ee7e7be996f51f2f4c13ad343304d31c63a09a187818']
] as const;

export interface SaaReleaseEvidence {
  readonly version: string;
  readonly commit: string;
  readonly sourceUrl: string;
  readonly fileName: string;
  readonly sha256: string;
  readonly archive: Buffer;
  readonly dashboard: unknown;
  readonly files: ReadonlyMap<string, Buffer>;
}

/** Retrieve the known blank Treasury Board forms directly from their issuing site. */
export async function loadSaaOfficialPrivacyForms(signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<ReadonlyMap<string, Buffer>> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
  bounded.throwIfAborted();
  const forms = await Promise.all(PRIVACY_FORMS.map(async ([name, digest]) => {
    const response = await fetcher(`${PRIVACY_FORMS_URL}${name}`, { redirect: 'error', credentials: 'omit', signal: bounded });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Treasury Board could not provide ${name} (HTTP ${response.status}).`);
    }
    const bytes = await readBounded(response, 256 * 1024, bounded);
    if (sha256(bytes) !== digest) throw new Error(`Treasury Board’s ${name} differs from the version this extension verifies.`);
    return [name, bytes] as const;
  }));
  return new Map(forms);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readBounded(response: Response, limit: number, signal: AbortSignal): Promise<Buffer> {
  const size = response.headers.get('content-length');
  if (size !== null && Number(size) > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('The release response exceeds the supported size.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('GitHub returned an empty release response.');
  const bytes = Buffer.allocUnsafe(limit);
  const cancel = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  let total = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > limit - total) throw new Error('The release response exceeds the supported size.');
      bytes.set(value, total);
      total += value.byteLength;
    }
    signal.throwIfAborted();
    return bytes.subarray(0, total);
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

async function downloadAsset(url: string, signal: AbortSignal, fetcher: typeof fetch): Promise<Response> {
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetcher(url, { redirect: 'manual', credentials: 'omit', signal });
    if (response.ok) return response;
    const target = response.headers.get('location');
    await response.body?.cancel().catch(() => undefined);
    if (![301, 302, 303, 307, 308].includes(response.status) || !target) {
      throw new Error(`GitHub could not download the assessor archive (HTTP ${response.status}).`);
    }
    const next = new URL(target, url);
    if (next.protocol !== 'https:' || next.username || next.password || next.port || !ASSET_HOSTS.has(next.hostname)) {
      throw new Error('The assessor archive redirected outside the official GitHub asset service.');
    }
    url = next.href;
  }
  throw new Error('GitHub returned too many assessor archive redirects.');
}

function tarText(field: Buffer): string {
  const terminator = field.indexOf(0);
  return field.toString('ascii', 0, terminator === -1 ? field.length : terminator);
}

function tarOctal(field: Buffer): number {
  const text = tarText(field).trim();
  if (!/^[0-7]+$/.test(text)) throw new Error('The assessor archive contains an invalid TAR header.');
  return Number.parseInt(text, 8);
}

function validateMemberPath(path: string): void {
  if (!path.split('/').every(segment => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(segment) && !segment.endsWith('.') &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
    throw new Error('The assessor archive contains an unsafe member path.');
  }
}

/** Read the published GNU TAR into memory. Only regular files and directories are accepted. */
function archiveFiles(archive: Buffer, version: string): Map<string, Buffer> {
  const bytes = gunzipSync(archive, { maxOutputLength: UNPACKED_LIMIT });
  const root = `compliance-package-v${version}`;
  const files = new Map<string, Buffer>();
  const entries = new Map<string, { path: string; directory: boolean }>();
  let offset = 0;
  while (offset + TAR_BLOCK_SIZE <= bytes.length) {
    const header = bytes.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every(byte => byte === 0)) break;
    if (entries.size >= MAX_ENTRIES) throw new Error('The assessor archive contains too many entries.');
    if (!header.subarray(257, 265).equals(Buffer.from('ustar  \0', 'ascii'))) {
      throw new Error('The assessor archive uses an unsupported TAR format.');
    }
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (tarOctal(header.subarray(148, 156)) !== checksum) throw new Error('The assessor archive has a damaged TAR header.');
    const type = header[156];
    const directory = type === 53; // TAR type '5'.
    if (!(directory || type === 48 || type === 0)) {
      throw new Error('The assessor archive contains a link or another unsupported TAR entry.');
    }
    const name = header.subarray(0, 100);
    if (name.some(byte => byte > 127)) throw new Error('The assessor archive contains an unsupported member name.');
    const text = tarText(name);
    if (name.subarray(text.length).some(byte => byte !== 0)) throw new Error('The assessor archive contains an ambiguous member name.');
    const path = directory ? text.replace(/\/$/, '') : text;
    validateMemberPath(path);
    if (!(directory && path === root) && !path.startsWith(`${root}/`)) {
      throw new Error('The assessor archive does not match the selected release.');
    }
    const key = path.toLowerCase();
    if (entries.has(key)) throw new Error('The assessor archive contains duplicate member paths.');
    const size = tarOctal(header.subarray(124, 136));
    const start = offset + TAR_BLOCK_SIZE;
    const next = start + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    if (next > bytes.length || (directory && size !== 0)) throw new Error('The assessor archive has invalid member sizes.');
    entries.set(key, { path, directory });
    if (!directory) files.set(path.slice(root.length + 1), bytes.subarray(start, start + size));
    offset = next;
  }
  if (bytes.length % TAR_BLOCK_SIZE !== 0 || bytes.length - offset < TAR_BLOCK_SIZE * 2 ||
      bytes.subarray(offset).some(byte => byte !== 0)) {
    throw new Error('The assessor archive is truncated or has unexpected trailing data.');
  }
  if (!entries.get(root)?.directory) throw new Error('The assessor archive is missing its release folder.');
  for (const { path } of entries.values()) {
    const parent = path.slice(0, path.lastIndexOf('/'));
    if (!parent || path === root) continue;
    const parentEntry = entries.get(parent.toLowerCase());
    if (!parentEntry?.directory || parentEntry.path !== parent) throw new Error('The assessor archive contains a conflicting member path.');
  }
  return files;
}

function verifyChecksums(files: ReadonlyMap<string, Buffer>): void {
  const ledger = files.get('SHA256SUMS');
  if (!ledger) throw new Error('The assessor archive is missing its file checksums.');
  const verified = new Set<string>();
  for (const line of ledger.toString('utf8').replace(/\n$/, '').split('\n')) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    const path = match?.[2];
    const file = path && files.get(path);
    if (!match || !path || !file || path === 'SHA256SUMS' || verified.has(path) || sha256(file) !== match[1]) {
      throw new Error('The assessor archive file checksums do not match its contents.');
    }
    verified.add(path);
  }
  if (verified.size !== files.size - 1) throw new Error('The assessor archive contains files without checksums.');
}

/** Download official, public product evidence for the exact release selected by the user. */
export async function loadSaaReleaseEvidence(version: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<SaaReleaseEvidence> {
  if (!SAA_RELEASE_VERSION.test(version)) throw new Error('Enter a release version such as 0.4.36.');
  signal.throwIfAborted();
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  const tag = `v${version}`;
  const sourceUrl = `https://github.com/${REPOSITORY}/releases/tag/${tag}`;
  const fileName = `compliance-package-${version}.tar.gz`;
  const assetUrl = `https://github.com/${REPOSITORY}/releases/download/${tag}/${fileName}`;
  const metadata = await fetcher(`https://api.github.com/repos/${REPOSITORY}/releases/tags/${tag}`, {
    headers: { Accept: 'application/vnd.github+json' }, redirect: 'error', credentials: 'omit', signal: boundedSignal
  });
  if (!metadata.ok) {
    await metadata.body?.cancel().catch(() => undefined);
    if (metadata.status === 404) throw new Error(`Release ${tag} is not available. Choose a published release.`);
    throw new Error(`GitHub could not read release ${tag} (HTTP ${metadata.status}).`);
  }
  const release = record(JSON.parse((await readBounded(metadata, METADATA_LIMIT, boundedSignal)).toString('utf8')));
  if (!release || release.tag_name !== tag || release.draft !== false || !Array.isArray(release.assets)) {
    throw new Error('GitHub returned unexpected release metadata.');
  }
  const assets = release.assets.map(record).filter(asset => asset?.name === fileName);
  if (assets.length === 0) throw new Error(`Release ${tag} does not provide an assessor archive. Choose a release that includes one.`);
  const asset = assets[0];
  const size = asset?.size;
  const digest = typeof asset?.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice(7) : '';
  if (assets.length !== 1 || asset?.browser_download_url !== assetUrl || !DIGEST.test(digest) ||
      typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > ARCHIVE_LIMIT) {
    throw new Error('GitHub did not provide verified download metadata for this assessor archive.');
  }
  const archive = await readBounded(await downloadAsset(assetUrl, boundedSignal, fetcher), size, boundedSignal);
  if (archive.length !== size || sha256(archive) !== digest) throw new Error('The downloaded assessor archive does not match its published checksum.');
  const files = archiveFiles(archive, version);
  verifyChecksums(files);
  const data = files.get(DASHBOARD_PATH);
  const manifestData = files.get(MANIFEST_PATH);
  if (!data || !manifestData) throw new Error('The assessor archive is missing its release evidence.');
  const dashboard: unknown = JSON.parse(data.toString('utf8'));
  const snapshot = record(dashboard);
  const manifest = record(JSON.parse(manifestData.toString('utf8')));
  const commit = snapshot?.commit;
  if (typeof commit !== 'string' || !COMMIT.test(commit) || snapshot?.schemaVersion !== 1 ||
      record(snapshot.source)?.ref !== commit || !Array.isArray(snapshot.rows) || !Array.isArray(snapshot.levels) ||
      manifest?.schemaVersion !== 1 || manifest.commit !== commit) {
    throw new Error('The release evidence does not identify one matching source commit.');
  }
  return { version, commit, sourceUrl, fileName, sha256: digest, archive, dashboard, files };
}
