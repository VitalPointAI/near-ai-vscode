#!/usr/bin/env node
// Takes the documentation snapshot for a release: run it on the release branch, after the version
// bump, so the snapshot matches what the release tag will hold.
//
// It refuses unless the root package.json already says <x.y.z>, and refuses a version that already
// has a snapshot. It syncs the repository's documents with their GitHub links pointing at the
// release tag v<x.y.z>, runs `docusaurus docs:version <x.y.z>` (which writes versioned_docs/,
// versioned_sidebars/ and versions.json), then syncs again with links back on main for the current
// pages. Commit the three outputs with the release.
//
// Usage: node scripts/snapshot-version.mjs <x.y.z>

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2] ?? '';

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Usage: node scripts/snapshot-version.mjs <x.y.z>');
  process.exit(2);
}
const rootVersion = JSON.parse(readFileSync(join(siteDir, '..', 'package.json'), 'utf8')).version;
if (rootVersion !== version) {
  console.error(`The root package.json says ${rootVersion}, not ${version}. Bump the version first (scripts/prepare-release.mjs bump ${version}).`);
  process.exit(3);
}
const versionsFile = join(siteDir, 'versions.json');
const versions = existsSync(versionsFile) ? JSON.parse(readFileSync(versionsFile, 'utf8')) : [];
if (versions.includes(version)) {
  console.error(`The documentation for ${version} already has a snapshot (versions.json).`);
  process.exit(4);
}

const run = (command, args, env = {}) =>
  execFileSync(command, args, { cwd: siteDir, stdio: 'inherit', env: { ...process.env, NO_UPDATE_NOTIFIER: '1', ...env } });

run(process.execPath, ['scripts/sync-docs.mjs', '--ref', `v${version}`]);
run(process.execPath, [join(siteDir, 'node_modules', '@docusaurus', 'core', 'bin', 'docusaurus.mjs'), 'docs:version', version]);
run(process.execPath, ['scripts/sync-docs.mjs']);
console.log(`Snapshot for ${version} written: commit docs-site/versions.json, docs-site/versioned_docs/ and docs-site/versioned_sidebars/ with the release.`);
