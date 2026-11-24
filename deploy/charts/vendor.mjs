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
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHARTS_LOCK, readChartsLock } from '../bundle/lib/locks.mjs';

export const VENDORED_DIR = 'deploy/charts/vendored';
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
    if (existsSync(target) && sha256(readFileSync(target)) === chart.sha256) continue;
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
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const problems = process.argv.includes('--check') ? checkVendored(root) : [...await vendor(root), ...checkVendored(root)];
  for (const problem of problems) console.error(problem);
  process.exit(problems.length ? 1 : 0);
}
