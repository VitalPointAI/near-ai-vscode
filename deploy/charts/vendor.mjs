#!/usr/bin/env node
// Vendors every upstream Helm chart the site stack installs (D-13, D-21): each one is a tarball under deploy/charts/vendored/ whose SHA-256 is
// the one in deploy/charts/charts.lock.json, taken from the `digest` of the chart repository's index.yaml. Renders and installs read only these
// tarballs; no chart repository is ever fetched at render or install time. Node built-ins only.
//
//   node deploy/charts/vendor.mjs          download each lock entry whose tarball is missing or differs, over https; a download whose SHA-256 is
//                                          not the lock's is refused and nothing is written
//   node deploy/charts/vendor.mjs --check  offline: hash every lock entry's tarball and refuse a mismatch, a missing tarball, or a tarball under
//                                          deploy/charts/vendored/ that no lock entry names
//
// Exits 1 with one plain line per problem. Bumping a chart: change its lock entry (version, url, sha256 from the repository index, file), run
// this script, and delete the old tarball.
//
// A carried chart patch (D-22, research Pattern 2): a lock entry may have `patch: { file, output, sha256 }`, a unified diff under
// deploy/charts/patches/ that this script applies to the verified upstream tarball with exact context (no fuzz; a patch that no longer
// applies is refused and nothing is written), repackaged deterministically (sorted names, owner 0:0, time 0, mode 0644, gzip level 9 with
// no name or time) as `output`, whose SHA-256 is `sha256`. Renders use `output`. --check verifies both SHA-256 values and re-applies the
// patch offline, comparing the uncompressed archive, so a changed patch file that was not re-vendored is refused.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { CHARTS_LOCK, readChartsLock } from '../bundle/lib/locks.mjs';

export const VENDORED_DIR = 'deploy/charts/vendored';
export const PATCHES_DIR = 'deploy/charts/patches';
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/**
 * The absolute path of a lock entry's `file`, or '' when it is not a plain relative .tgz path that stays inside deploy/charts/vendored/
 * (an absolute path, a `..` segment or a backslash is refused), so a lock entry can never make this script read or write outside that folder.
 */
export function vendoredPath(root, file) {
  if (typeof file !== 'string' || !file.startsWith(`${VENDORED_DIR}/`) || !file.endsWith('.tgz') || file.includes('\\')) return '';
  if (path.isAbsolute(file) || file.split('/').some((part) => part === '..' || part === '.' || part === '')) return '';
  const dir = path.resolve(root, VENDORED_DIR);
  const target = path.resolve(root, file);
  return path.dirname(target) === dir ? target : '';
}

/** The absolute path of a patch entry's diff, or '' when it is not a plain .patch file directly under deploy/charts/patches/. */
export function patchPath(root, file) {
  if (typeof file !== 'string' || !file.startsWith(`${PATCHES_DIR}/`) || !file.endsWith('.patch') || file.includes('\\')) return '';
  if (path.isAbsolute(file) || file.split('/').some((part) => part === '..' || part === '.' || part === '')) return '';
  const target = path.resolve(root, file);
  return path.dirname(target) === path.resolve(root, PATCHES_DIR) ? target : '';
}

const field = (header, start, length) => {
  const end = header.indexOf(0, start);
  return header.toString('utf8', start, end < 0 || end > start + length ? start + length : end);
};

/** The regular files of a ustar archive: [{ name, data }]. Refuses links, devices, pax and GNU long-name records and a bad header checksum. */
export function readTar(tar) {
  const files = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const stored = parseInt(field(header, 148, 8).trim(), 8);
    let sum = 0;
    for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 32 : header[index];
    if (sum !== stored) throw new Error(`the archive has a bad header checksum at byte ${offset}`);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = field(header, 345, 155);
    const name = prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100);
    const size = parseInt(field(header, 124, 12).trim() || '0', 8);
    if (type === '5') { offset += 512; continue; }
    if (type !== '0') throw new Error(`the archive entry ${name} has type ${type}; only regular files and folders are accepted`);
    if (!name || name.startsWith('/') || name.split('/').includes('..')) throw new Error(`the archive entry ${JSON.stringify(name)} is not a plain relative path`);
    files.push({ name, data: Buffer.from(tar.subarray(offset + 512, offset + 512 + size)) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** A deterministic ustar archive of the files: sorted by name, owner 0:0, time 0, mode 0644. */
export function writeTar(files) {
  const blocks = [];
  for (const { name, data } of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const header = Buffer.alloc(512);
    let base = name;
    let prefix = '';
    if (Buffer.byteLength(name) > 100) {
      const cut = name.lastIndexOf('/', 155);
      prefix = name.slice(0, cut);
      base = name.slice(cut + 1);
      if (cut < 0 || Buffer.byteLength(prefix) > 155 || Buffer.byteLength(base) > 100) throw new Error(`the archive entry name ${name} is too long for ustar`);
    }
    header.write(base, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.write('        ', 148, 8, 'ascii');
    header.write('0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    header.write(prefix, 345, 155, 'utf8');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/**
 * Applies a unified diff to the archive's files with exact context and line numbers (no fuzz, no offset); text before the first `--- `
 * line is a comment. Only changes existing files. Returns the new file list; throws naming the file and hunk that does not apply.
 */
export function applyPatch(files, diff) {
  const byName = new Map(files.map((file) => [file.name, file]));
  const lines = diff.split('\n');
  let index = lines.findIndex((line) => line.startsWith('--- '));
  if (index < 0) throw new Error('the patch has no --- line');
  const changed = new Map();
  while (index < lines.length && lines[index].startsWith('--- ')) {
    const target = /^\+\+\+ (?:b\/)?(\S+)/.exec(lines[index + 1] ?? '')?.[1];
    if (!target || !byName.has(target)) throw new Error(`the patch names ${target ?? '(no +++ line)'}, which is not in the chart`);
    const source = (changed.get(target) ?? byName.get(target).data).toString('utf8').split('\n');
    const output = [];
    let cursor = 0;
    index += 2;
    while (index < lines.length && lines[index].startsWith('@@ ')) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(lines[index]);
      if (!hunk) throw new Error(`${target}: a malformed hunk header ${lines[index]}`);
      const start = Number(hunk[1]) - (hunk[2] === '0' ? 0 : 1);
      if (start < cursor) throw new Error(`${target}: hunks out of order at ${lines[index]}`);
      output.push(...source.slice(cursor, start));
      cursor = start;
      index += 1;
      while (index < lines.length && /^[ +\-\\]/.test(lines[index]) && !lines[index].startsWith('--- ')) {
        const line = lines[index];
        index += 1;
        if (line[0] === '\\') continue;
        if (line[0] === '+') { output.push(line.slice(1)); continue; }
        if (source[cursor] !== line.slice(1)) throw new Error(`${target}: the hunk ${hunk[0]} does not apply at line ${cursor + 1}`);
        if (line[0] === ' ') output.push(source[cursor]);
        cursor += 1;
      }
    }
    output.push(...source.slice(cursor));
    changed.set(target, Buffer.from(output.join('\n')));
    while (index < lines.length && lines[index] === '') index += 1;
  }
  return files.map((file) => (changed.has(file.name) ? { name: file.name, data: changed.get(file.name) } : file));
}

/** The patched archive (uncompressed tar) of a lock entry with `patch`, from its hash-checked upstream tarball. Throws on any refusal. */
export function patchedTar(root, chart) {
  const diff = patchPath(root, chart.patch?.file);
  if (!diff) throw new Error(`${CHARTS_LOCK}: ${chart.name} patch.file must name a .patch file directly under ${PATCHES_DIR}/.`);
  if (!existsSync(diff)) throw new Error(`${chart.patch.file} is missing.`);
  const bytes = readFileSync(vendoredPath(root, chart.file));
  if (sha256(bytes) !== chart.sha256) throw new Error(`${chart.file} does not match the SHA-256 in ${CHARTS_LOCK}; refusing to patch it.`);
  return writeTar(applyPatch(readTar(gunzipSync(bytes)), readFileSync(diff, 'utf8')));
}

/** The deterministic .tgz of a tar: gzip level 9, no file name, time 0. */
export const gzipChart = (tar) => gzipSync(tar, { level: 9 });

/** Problems with a patched lock entry: its output's SHA-256, and the patch re-applied offline to the same archive content. */
function checkPatched(root, chart, named) {
  const output = vendoredPath(root, chart.patch?.output);
  if (!output || chart.patch.output === chart.file) return [`${CHARTS_LOCK}: ${chart.name} patch.output must name another .tgz file directly under ${VENDORED_DIR}/.`];
  named.add(chart.patch.output);
  if (!/^[0-9a-f]{64}$/.test(chart.patch.sha256 ?? '')) return [`${CHARTS_LOCK}: ${chart.name} patch has no 64-hex sha256.`];
  if (!existsSync(output)) return [`${chart.patch.output} is missing; run node deploy/charts/vendor.mjs.`];
  const bytes = readFileSync(output);
  if (sha256(bytes) !== chart.patch.sha256) return [`${chart.patch.output} does not match the patched SHA-256 in ${CHARTS_LOCK}; refusing it.`];
  try {
    if (!patchedTar(root, chart).equals(gunzipSync(bytes))) return [`${chart.patch.output} is not ${chart.patch.file} applied to ${chart.file}; run node deploy/charts/vendor.mjs and update the lock.`];
  } catch (error) {
    return [`${chart.name}: ${error.message}`];
  }
  return [];
}

/** Writes a patched entry's output when it is missing or differs; a patch that does not apply, or a result whose SHA-256 is not the lock's, writes nothing. */
function vendorPatched(root, chart) {
  const output = vendoredPath(root, chart.patch?.output);
  if (!output || chart.patch.output === chart.file) return [`${CHARTS_LOCK}: ${chart.name} patch.output must name another .tgz file directly under ${VENDORED_DIR}/; nothing written.`];
  let bytes;
  try {
    bytes = gzipChart(patchedTar(root, chart));
  } catch (error) {
    return [`${chart.name}: ${error.message} Nothing written.`];
  }
  const actual = sha256(bytes);
  if (actual !== chart.patch.sha256) return [`${chart.name}: the patched tarball has SHA-256 ${actual}, not ${chart.patch.sha256} from the lock; nothing written.`];
  if (existsSync(output) && sha256(readFileSync(output)) === actual) return [];
  const partial = `${output}.partial`;
  writeFileSync(partial, bytes);
  renameSync(partial, output);
  console.log(`${chart.patch.output}: patched with ${chart.patch.file} (${actual}).`);
  return [];
}

/** Problems with the vendored tarballs of the repository at `root` (empty when every one matches the lock). Reads no network. */
export function checkVendored(root) {
  const problems = [];
  const { charts } = readChartsLock(root);
  const named = new Set();
  for (const chart of charts) {
    if (!/^[0-9a-f]{64}$/.test(chart.sha256 ?? '')) problems.push(`${CHARTS_LOCK}: ${chart.name} has no 64-hex sha256.`);
    const file = vendoredPath(root, chart.file);
    if (!file) {
      problems.push(`${CHARTS_LOCK}: ${chart.name} must name a .tgz file directly under ${VENDORED_DIR}/.`);
      continue;
    }
    named.add(chart.file);
    if (!existsSync(file)) problems.push(`${chart.file} is missing; run node deploy/charts/vendor.mjs on a connected host.`);
    else if (sha256(readFileSync(file)) !== chart.sha256) problems.push(`${chart.file} does not match the SHA-256 in ${CHARTS_LOCK}; refusing it.`);
    if (chart.patch !== undefined) problems.push(...checkPatched(root, chart, named));
  }
  const dir = path.join(root, VENDORED_DIR);
  const present = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.tgz')).map((name) => `${VENDORED_DIR}/${name}`) : [];
  for (const file of present.sort()) if (!named.has(file)) problems.push(`${file} is not named by any entry in ${CHARTS_LOCK}; remove it or add its entry.`);
  return problems;
}

/** Downloads every lock entry whose tarball is missing or differs. Returns problem strings; a refused download leaves no file behind. */
export async function vendor(root) {
  const problems = [];
  for (const chart of readChartsLock(root).charts) {
    // The path is checked before anything is read, downloaded or written.
    const target = vendoredPath(root, chart.file);
    if (!target) { problems.push(`${CHARTS_LOCK}: ${chart.name} must name a .tgz file directly under ${VENDORED_DIR}/; nothing written.`); continue; }
    if (existsSync(target) && sha256(readFileSync(target)) === chart.sha256) {
      if (chart.patch !== undefined) problems.push(...vendorPatched(root, chart));
      continue;
    }
    if (!String(chart.url).startsWith('https://')) { problems.push(`${chart.name}: the url must be https.`); continue; }
    let body;
    try {
      const response = await fetch(chart.url, { redirect: 'follow' });
      if (!response.url.startsWith('https://')) throw new Error(`redirected to a non-https address ${response.url}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      body = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      problems.push(`${chart.name}: could not download ${chart.url}: ${error.message}`);
      continue;
    }
    const actual = sha256(body);
    if (actual !== chart.sha256) { problems.push(`${chart.name}: ${chart.url} has SHA-256 ${actual}, not ${chart.sha256} from the lock; nothing written.`); continue; }
    // Written beside the target and renamed, so a stopped run never leaves a partial tarball under the lock's name.
    mkdirSync(path.dirname(target), { recursive: true });
    const partial = `${target}.partial`;
    writeFileSync(partial, body);
    renameSync(partial, target);
    console.log(`${chart.file}: vendored (${chart.sha256}).`);
    if (chart.patch !== undefined) problems.push(...vendorPatched(root, chart));
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const problems = process.argv.includes('--check') ? checkVendored(root) : [...await vendor(root), ...checkVendored(root)];
  for (const problem of problems) console.error(problem);
  process.exit(problems.length ? 1 : 0);
}
