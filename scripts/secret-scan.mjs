#!/usr/bin/env node
// Dependency-free secret scan, run by CI as the `secret-scan` job.
//
//   node scripts/secret-scan.mjs                 scan every tracked file at HEAD
//   node scripts/secret-scan.mjs --range A..B    also scan every line added by commits in A..B
//   node scripts/secret-scan.mjs --dir <folder>  scan every file in a folder that is not tracked (an evidence bundle or a release package
//                                                before it leaves CI) instead of the tracked files; cannot be combined with --range
//   add --json to any of them                    print one JSON line of counts only on stdout: mode (tracked, range or dir), files, commits,
//                                                findings, rules (rule id to count), allowlisted, marked and clean; where each finding is
//                                                goes to stderr without its text. The exit code is the same: 0 clean, 1 findings.
//
// The range matters because a PR's individual commits stay public on GitHub even after a squash
// merge, so a key added in one commit and removed in the next has still leaked.
//
// Known test fixtures with fake keys are listed in .github/secret-scan-allow.txt (a path, the
// rules its fake keys match, and a reason); any other rule is still reported in that file. A
// single line can opt out with the marker "secret-scan: allow". Both show up in review, so
// neither can hide a real key quietly: marked lines that match a rule are listed (masked) in the
// output, and in a range scan a line let through by the marker or the allowlist that was added
// and removed again before the end of the range fails, since the final diff reviewers read no
// longer shows it. The range scan also reads commit messages, and diffs every file as text.
// Matches are printed masked.
//
// A folder scan (Phase 44, D-24) reads every entry with lstat and never follows a link: a symlink, or anything else that is not a regular file
// or a folder, is a finding (rule symlink or not-regular-file), since a bundle must hold regular files only. A file above 16 MiB is a finding
// (too-large) instead of being skipped, binary files are skipped as in the tracked scan, and the allowlist does not apply (it names tracked
// fixture paths).
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import path from 'node:path';
import { fail, git, parseArgs } from './lib/gh.mjs';
import { ALLOW_MARKER, isAllowed, isSecretFileName, maskLine, matchRules, parseAllowlist, scanLine } from './lib/workflow.mjs';

const ALLOWLIST = '.github/secret-scan-allow.txt';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** In a folder scan a larger file is a finding, not skipped: nothing in an evidence bundle should be near this size. */
const MAX_DIR_FILE_BYTES = 16 * 1024 * 1024;

const { options } = parseArgs(process.argv.slice(2), { string: ['range', 'dir'], boolean: ['json'] });
if (options.range !== undefined && (options.range.includes('...') || options.range.split('..').length !== 2)) {
  fail(`--range must be <from>..<to> (two dots), got "${options.range}"`);
}
if (options.dir !== undefined && options.range !== undefined) fail('--dir scans a folder that is not tracked and cannot be combined with --range');
const dirMode = options.dir !== undefined;
const allow = dirMode ? new Map() : parseAllowlist(existsSync(ALLOWLIST) ? readFileSync(ALLOWLIST, 'utf8') : '');
const findings = [];
const allowed = [];

function looksBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

/** The findings and marked lines of one text file, as the tracked scan reports them. */
function scanText(where, buffer, isAllowedRule) {
  buffer.toString('utf8').split(/\r?\n/).forEach((line, index) => {
    for (const rule of scanLine(line)) if (!isAllowedRule(rule)) findings.push({ where: `${where}:${index + 1}`, rule, text: maskLine(line.trim()) });
    if (line.includes(ALLOW_MARKER)) for (const rule of matchRules(line)) allowed.push({ where: `${where}:${index + 1}`, rule, text: maskLine(line.trim()) });
  });
}

/** Reads a regular file without following a link (O_NOFOLLOW where the platform has it), or returns why it was not read. */
function readRegular(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    return { problem: error.code === 'ELOOP' ? 'symlink' : 'not-regular-file' };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { problem: 'not-regular-file' };
    if (stat.size > MAX_DIR_FILE_BYTES) return { problem: 'too-large', size: stat.size };
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < stat.size) {
      const n = readSync(fd, buffer, read, stat.size - read, read);
      if (n === 0) break;
      read += n;
    }
    return { buffer: buffer.subarray(0, read) };
  } finally {
    closeSync(fd);
  }
}

/** Every entry under `root` (forward-slash paths relative to it, sorted), walked with lstat so no link is followed. */
function walk(root) {
  const entries = [];
  const visit = (relative) => {
    for (const name of readdirSync(path.join(root, relative)).sort()) {
      const rel = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(path.join(root, rel));
      if (stat.isDirectory()) visit(rel);
      else entries.push({ rel, stat });
    }
  };
  visit('');
  return entries;
}

let files = [];
if (dirMode) {
  // 1b. Every file in a folder that is not tracked.
  const root = path.resolve(options.dir);
  let rootStat;
  try { rootStat = lstatSync(root); } catch { fail(`--dir: no folder at ${options.dir}`); }
  if (rootStat.isSymbolicLink()) fail(`--dir must name a folder, not a symlink: ${options.dir}`);
  if (!rootStat.isDirectory()) fail(`--dir must name a folder: ${options.dir}`);
  for (const { rel, stat } of walk(root)) {
    if (stat.isSymbolicLink()) { findings.push({ where: rel, rule: 'symlink', text: '(symlink, not followed)' }); continue; }
    if (!stat.isFile()) { findings.push({ where: rel, rule: 'not-regular-file', text: '(not a regular file)' }); continue; }
    files.push(rel);
    if (isSecretFileName(rel)) findings.push({ where: rel, rule: 'secret-file-name', text: '(file name)' });
    const { buffer, problem, size } = readRegular(path.join(root, rel));
    if (problem === 'too-large') { findings.push({ where: rel, rule: 'too-large', text: `(${size} bytes, above ${MAX_DIR_FILE_BYTES})` }); continue; }
    if (problem) { findings.push({ where: rel, rule: problem, text: '(not read)' }); continue; }
    if (looksBinary(buffer)) continue;
    scanText(rel, buffer, () => false);
  }
}

// 1. Tracked files at HEAD.
if (!dirMode) files = git(['ls-files', '-z']).split('\0').filter(Boolean);
for (const file of dirMode ? [] : files) {
  if (isSecretFileName(file) && !isAllowed(allow, file, 'secret-file-name')) findings.push({ where: file, rule: 'secret-file-name', text: '(file name)' });
  // Only regular files: a tracked symlink (possibly to a directory) or a submodule has no text
  // of its own to scan here.
  if (!existsSync(file) || !lstatSync(file).isFile()) continue;
  const buffer = readFileSync(file);
  if (buffer.length > MAX_FILE_BYTES || looksBinary(buffer)) continue;
  scanText(file, buffer, (rule) => isAllowed(allow, file, rule));
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
    // Commit messages are public too.
    for (const line of git(['log', '-1', '--format=%B', commit]).split(/\r?\n/)) {
      for (const rule of scanLine(line)) {
        const finding = { where: `${commit.slice(0, 7)} (commit message)`, rule, text: maskLine(line.trim()) };
        const key = `${finding.where}\0${finding.rule}\0${finding.text}`;
        if (!seen.has(key)) { seen.add(key); findings.push(finding); }
      }
    }
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
        // --text: a .gitattributes entry (-diff, binary) or a NUL byte would otherwise turn the
        // diff into "Binary files differ" and hide the added lines.
        const diff = git(['diff', '--text', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=0', parent, commit, '--', `:(literal)${file}`]);
        let inHunk = false;
        for (const line of diff.split('\n')) {
          if (line.startsWith('@@')) { inHunk = true; continue; }
          if (!inHunk || !line.startsWith('+')) continue;
          // The final file is split on CR?LF, so drop a CR here too, or a kept line looks removed.
          const added = line.slice(1).replace(/\r$/, '');
          const rules = matchRules(added);
          const marked = added.includes(ALLOW_MARKER);
          const suppressed = marked ? rules : rules.filter((rule) => isAllowed(allow, file, rule));
          for (const rule of rules.filter((r) => !suppressed.includes(r))) report({ where, rule, text: maskLine(added.trim()) });
          // A match let through by the marker or the allowlist is fine only if the line is still
          // there at the end of the range, where reviewers can see it.
          if (suppressed.length > 0 && !linesAtEnd(file).has(added)) {
            report({ where, rule: 'allowed-line-removed', text: maskLine(added.trim()) });
          }
        }
      }
    }
  }
}

if (options.json) {
  const rules = {};
  for (const finding of findings) rules[finding.rule] = (rules[finding.rule] ?? 0) + 1;
  console.log(JSON.stringify({
    mode: dirMode ? 'dir' : options.range ? 'range' : 'tracked',
    files: files.length,
    commits: commitCount,
    findings: findings.length,
    rules,
    allowlisted: allow.size,
    marked: allowed.length,
    clean: findings.length === 0
  }));
  // Where each finding is, without its text, so the log shows what to look at and nothing of the value.
  for (const finding of findings) console.error(`  ${finding.where}  [${finding.rule}]`);
  process.exit(findings.length === 0 ? 0 : 1);
}

const scope = dirMode
  ? `${files.length} files in ${options.dir}`
  : `${files.length} tracked files${options.range ? ` and ${commitCount} commit(s) in ${options.range}` : ''}`;
if (allowed.length > 0) {
  console.log(`Lines marked "${ALLOW_MARKER}" that match a rule (check each holds a fake value):`);
  for (const line of allowed) console.log(`  ${line.where}  [${line.rule}]  ${line.text}`);
}
if (findings.length === 0) {
  console.log(dirMode ? `Secret scan clean: ${scope}. The allowlist does not apply to a folder.` : `Secret scan clean: ${scope}. Allowlisted fixtures: ${allow.size}.`);
} else {
  console.error(`Secret scan found ${findings.length} possible secret(s) in ${scope}:`);
  for (const finding of findings) console.error(`  ${finding.where}  [${finding.rule}]  ${finding.text}`);
  console.error('\nIf a real key was committed: revoke it now (removing it from git does not make it safe), then remove it.');
  console.error(`If it is a fake test value: add "<path> <rule>" to ${ALLOWLIST} with a reason, or mark the line "secret-scan: allow".`);
  process.exit(1);
}
