#!/usr/bin/env node
// Dependency-free secret scan, run by CI as the `secret-scan` job.
//
//   node scripts/secret-scan.mjs                 scan every tracked file at HEAD
//   node scripts/secret-scan.mjs --range A..B    also scan every line added by commits in A..B
//
// The range matters because a PR's individual commits stay public on GitHub even after a squash
// merge, so a key added in one commit and removed in the next has still leaked.
//
// Known test fixtures with fake keys are listed in .github/secret-scan-allow.txt (a path, the
// rules its fake keys match, and a reason); any other rule is still reported in that file. A single line can opt out with the marker "secret-scan: allow". Both
// show up in review, so neither can hide a real key quietly: marked lines that match a rule are
// listed (masked) in the output, and in a range scan a marked line that was added and removed
// again before the end of the range fails, since the final diff reviewers read no longer shows
// it. Matches are printed masked.
import { readFileSync, existsSync } from 'node:fs';
import { git, parseArgs } from './lib/gh.mjs';
import { ALLOW_MARKER, isAllowed, isSecretFileName, maskLine, matchRules, parseAllowlist, scanLine } from './lib/workflow.mjs';

const ALLOWLIST = '.github/secret-scan-allow.txt';
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const { options } = parseArgs(process.argv.slice(2), { string: ['range'] });
const allow = parseAllowlist(existsSync(ALLOWLIST) ? readFileSync(ALLOWLIST, 'utf8') : '');
const findings = [];
const allowed = [];

function looksBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

// 1. Tracked files at HEAD.
const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
for (const file of files) {
  if (isSecretFileName(file) && !isAllowed(allow, file, 'secret-file-name')) findings.push({ where: file, rule: 'secret-file-name', text: '(file name)' });
  if (!existsSync(file)) continue;
  const buffer = readFileSync(file);
  if (buffer.length > MAX_FILE_BYTES || looksBinary(buffer)) continue;
  buffer.toString('utf8').split(/\r?\n/).forEach((line, index) => {
    for (const rule of scanLine(line)) if (!isAllowed(allow, file, rule)) findings.push({ where: `${file}:${index + 1}`, rule, text: maskLine(line.trim()) });
    if (line.includes(ALLOW_MARKER)) for (const rule of matchRules(line)) allowed.push({ where: `${file}:${index + 1}`, rule, text: maskLine(line.trim()) });
  });
}

// 2. Lines added by each commit in the range (catches keys added and later removed). Each commit
// is compared with each of its parents (so lines added in a merge commit count), with rename
// detection off (a renamed or copied file counts as added), file names read NUL-separated (so
// spaces and other characters are safe), and each file's diff read on its own, after its first
// hunk header, so no added line can be mistaken for a file header.
let commitCount = 0;
if (options.range) {
  const [from, to = from] = options.range.split('..');
  const revisions = /^0+$/.test(from) || from === '' ? [to] : [options.range];
  // The lines of each file at the end of the range, to tell whether a marked line survived.
  const finalLines = new Map();
  const linesAtEnd = (file) => {
    if (!finalLines.has(file)) {
      let text = '';
      try { text = git(['show', `${to}:${file}`]); } catch { text = ''; }
      finalLines.set(file, new Set(text.split(/\r?\n/)));
    }
    return finalLines.get(file);
  };
  const commits = git(['rev-list', '--reverse', ...revisions, '--']).split('\n').filter(Boolean);
  const emptyTree = git(['hash-object', '-t', 'tree', '--stdin'], { input: '' }).trim();
  const seen = new Set();
  for (const commit of commits) {
    commitCount += 1;
    const parents = git(['rev-list', '--parents', '-n', '1', commit]).trim().split(' ').slice(1);
    for (const parent of parents.length > 0 ? parents : [emptyTree]) {
      const changed = git(['diff-tree', '-r', '-z', '--no-commit-id', '--no-renames', '--name-only', '--diff-filter=ACMRT', parent, commit]).split('\0').filter(Boolean);
      for (const file of changed) {
        const where = `${commit.slice(0, 7)} ${file}`;
        const report = (finding) => {
          const key = `${finding.where}\0${finding.rule}\0${finding.text}`;
          if (!seen.has(key)) { seen.add(key); findings.push(finding); }
        };
        if (isSecretFileName(file) && !isAllowed(allow, file, 'secret-file-name')) report({ where, rule: 'secret-file-name', text: '(file name)' });
        const diff = git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=0', parent, commit, '--', `:(literal)${file}`]);
        let inHunk = false;
        for (const line of diff.split('\n')) {
          if (line.startsWith('@@')) { inHunk = true; continue; }
          if (!inHunk || !line.startsWith('+')) continue;
          const added = line.slice(1);
          for (const rule of scanLine(added)) if (!isAllowed(allow, file, rule)) report({ where, rule, text: maskLine(added.trim()) });
          if (added.includes(ALLOW_MARKER) && matchRules(added).length > 0 && !linesAtEnd(file).has(added)) {
            report({ where, rule: 'allowed-line-removed', text: maskLine(added.trim()) });
          }
        }
      }
    }
  }
}

const scope = `${files.length} tracked files${options.range ? ` and ${commitCount} commit(s) in ${options.range}` : ''}`;
if (allowed.length > 0) {
  console.log(`Lines marked "${ALLOW_MARKER}" that match a rule (check each holds a fake value):`);
  for (const line of allowed) console.log(`  ${line.where}  [${line.rule}]  ${line.text}`);
}
if (findings.length === 0) {
  console.log(`Secret scan clean: ${scope}. Allowlisted fixtures: ${allow.size}.`);
} else {
  console.error(`Secret scan found ${findings.length} possible secret(s) in ${scope}:`);
  for (const finding of findings) console.error(`  ${finding.where}  [${finding.rule}]  ${finding.text}`);
  console.error('\nIf a real key was committed: revoke it now (removing it from git does not make it safe), then remove it.');
  console.error(`If it is a fake test value: add "<path> <rule>" to ${ALLOWLIST} with a reason, or mark the line "secret-scan: allow".`);
  process.exit(1);
}
