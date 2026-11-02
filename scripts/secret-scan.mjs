#!/usr/bin/env node
// Dependency-free secret scan, run by CI as the `secret-scan` job.
//
//   node scripts/secret-scan.mjs                 scan every tracked file at HEAD
//   node scripts/secret-scan.mjs --range A..B    also scan every line added by commits in A..B
//
// The range matters because a PR's individual commits stay public on GitHub even after a squash
// merge, so a key added in one commit and removed in the next has still leaked.
//
// Known test fixtures with fake keys are listed in .github/secret-scan-allow.txt (one path per
// line, with a reason). A single line can opt out with the marker "secret-scan: allow". Both
// show up in review, so neither can hide a real key quietly. Matches are printed masked.
import { readFileSync, existsSync } from 'node:fs';
import { git, parseArgs } from './lib/gh.mjs';
import { isSecretFileName, maskLine, parseAllowlist, scanLine } from './lib/workflow.mjs';

const ALLOWLIST = '.github/secret-scan-allow.txt';
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const { options } = parseArgs(process.argv.slice(2), { string: ['range'] });
const allow = parseAllowlist(existsSync(ALLOWLIST) ? readFileSync(ALLOWLIST, 'utf8') : '');
const findings = [];

function looksBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

// 1. Tracked files at HEAD.
const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
for (const file of files) {
  if (isSecretFileName(file) && !allow.has(file)) findings.push({ where: file, rule: 'secret-file-name', text: '(file name)' });
  if (allow.has(file) || !existsSync(file)) continue;
  const buffer = readFileSync(file);
  if (buffer.length > MAX_FILE_BYTES || looksBinary(buffer)) continue;
  buffer.toString('utf8').split(/\r?\n/).forEach((line, index) => {
    for (const rule of scanLine(line)) findings.push({ where: `${file}:${index + 1}`, rule, text: maskLine(line.trim()) });
  });
}

// 2. Lines added by each commit in the range (catches keys added and later removed).
let commitCount = 0;
if (options.range) {
  const [from] = options.range.split('..');
  const range = /^0+$/.test(from) || from === '' ? options.range.split('..')[1] : options.range;
  const log = git(['log', '-p', '--no-color', '--unified=0', '--diff-filter=AM', '--format=@@commit %H', range]);
  let commit = '';
  let file = '';
  for (const line of log.split('\n')) {
    if (line.startsWith('@@commit ')) { commit = line.slice(9, 16); commitCount += 1; continue; }
    if (line.startsWith('+++ ')) {
      file = line.replace(/^\+\+\+ (b\/)?/, '');
      if (file !== '/dev/null' && isSecretFileName(file) && !allow.has(file)) findings.push({ where: `${commit} ${file}`, rule: 'secret-file-name', text: '(file name)' });
      continue;
    }
    if (!line.startsWith('+') || allow.has(file)) continue;
    for (const rule of scanLine(line.slice(1))) findings.push({ where: `${commit} ${file}`, rule, text: maskLine(line.slice(1).trim()) });
  }
}

const scope = `${files.length} tracked files${options.range ? ` and ${commitCount} commit(s) in ${options.range}` : ''}`;
if (findings.length === 0) {
  console.log(`Secret scan clean: ${scope}. Allowlisted fixtures: ${allow.size}.`);
} else {
  console.error(`Secret scan found ${findings.length} possible secret(s) in ${scope}:`);
  for (const finding of findings) console.error(`  ${finding.where}  [${finding.rule}]  ${finding.text}`);
  console.error('\nIf a real key was committed: revoke it now (removing it from git does not make it safe), then remove it.');
  console.error(`If it is a fake test value: add the file to ${ALLOWLIST} with a reason, or mark the line "secret-scan: allow".`);
  process.exit(1);
}
