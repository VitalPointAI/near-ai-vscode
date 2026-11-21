#!/usr/bin/env node
// Brings the repository's own Markdown into the documentation site at build time.
//
// One source of truth: README.md, SECURITY.md, CHANGELOG.md, CONTRIBUTING.md, docs/**/*.md, the
// design documents under .planning/ and docs-site/README.md stay where they are and are edited only
// there. This script copies each one into docs-site/content as `<name>.synced.md` (git-ignored, and
// replaced on every run), adds the front matter the site needs and a line saying where to edit it,
// and rewrites its relative links:
//   - a link to another rendered file points at that page (anchors kept, so the build checks them);
//   - an image is copied into docs-site/static/synced/ and served from the site itself;
//   - a link to any other file or folder in the repository points at it on GitHub;
//   - a link to a repository file that does not exist fails the sync, so a broken link fails the
//     build instead of shipping.
// Only files tracked by git are rendered, so local drafts and untracked files never appear.
//
// Usage: node scripts/sync-docs.mjs [--ref <git ref for GitHub links>]   (default: main)

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(siteDir, '..');
const contentDir = join(siteDir, 'content');
const staticSyncedDir = join(siteDir, 'static', 'synced');

const refIndex = process.argv.indexOf('--ref');
const gitRef = (refIndex > 0 && process.argv[refIndex + 1]) || process.env.DOCS_GIT_REF || 'main';
if (!/^[A-Za-z0-9._/-]+$/.test(gitRef)) {
  console.error(`Not a usable git ref for links: ${gitRef}`);
  process.exit(2);
}

const rootManifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const repoUrl = String(rootManifest.repository?.url ?? rootManifest.repository ?? '')
  .replace(/^git\+/, '')
  .replace(/\.git$/, '');
if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(repoUrl)) {
  console.error(`The root package.json repository URL is not a GitHub URL: ${repoUrl}`);
  process.exit(2);
}

const IMAGE = /\.(png|jpe?g|gif|svg|webp|avif)$/i;

/** Repository files tracked by git (posix paths). Falls back to the folder tree outside a git checkout. */
function trackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return out.split('\0').filter(Boolean);
  } catch {
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.cache')) continue;
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path);
        else files.push(path);
      }
    };
    walk('');
    return files;
  }
}

const tracked = trackedFiles();
const trackedSet = new Set(tracked);
const trackedDirs = new Set();
for (const file of tracked) {
  let dir = posix.dirname(file);
  while (dir && dir !== '.') {
    trackedDirs.add(dir);
    dir = posix.dirname(dir);
  }
}

/** Where each repository Markdown file is rendered (path under content/, without the .synced.md suffix). */
function targetFor(source) {
  const fixed = {
    'README.md': 'using/features',
    'SECURITY.md': 'security/policy',
    'CHANGELOG.md': 'releases/changelog',
    'CONTRIBUTING.md': 'developing/contributing',
    'docs/development-workflow.md': 'developing/development-workflow',
    'docs/testing.md': 'developing/testing',
    'docs-site/README.md': 'developing/docs-site',
    'docs/staff-env-packs.md': 'using/reference/staff-env-packs'
  };
  if (fixed[source]) return fixed[source];
  if (source.startsWith('docs/security/')) return `security/documents/${source.slice('docs/security/'.length, -3)}`;
  if (source.startsWith('docs/decisions/')) return `architecture/decisions/${source.slice('docs/decisions/'.length, -3)}`;
  if (source.startsWith('docs/') && !source.startsWith('docs/references/')) return `using/reference/${source.slice('docs/'.length, -3)}`;
  if (source.startsWith('.planning/research/')) return `architecture/design/${source.slice('.planning/research/'.length, -3)}`;
  if (source.startsWith('.planning/codebase/')) return `architecture/codebase/${source.slice('.planning/codebase/'.length, -3)}`;
  return null;
}

const sources = tracked.filter((file) => file.endsWith('.md') && targetFor(file) !== null);
const targets = new Map(sources.map((source) => [source, `${targetFor(source)}.synced.md`]));

const labels = {
  'README.md': 'Features and settings',
  'SECURITY.md': 'Security policy',
  'CHANGELOG.md': 'Changelog',
  'CONTRIBUTING.md': 'Contributing',
  'docs/development-workflow.md': 'Development workflow',
  'docs/testing.md': 'Testing rules',
  'docs-site/README.md': 'This documentation site',
  'docs/security/incident-response.md': 'Incident response plan',
  'docs/security/threat-model.md': 'Threat model',
  'docs/security/data-flow.md': 'Data flows',
  'docs/security/crypto-inventory.md': 'Cryptography inventory',
  'docs/security/controlled-goods-and-itar.md': 'Controlled goods and ITAR'
};

const problems = [];

function githubUrl(path, isDir) {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `${repoUrl}/${isDir ? 'tree' : 'blob'}/${gitRef}/${encoded}`;
}

/** Rewrites one link target found in `source`, rendered at content/`target`. */
function rewrite(url, source, target, line) {
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) return url;
  const match = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(trimmed);
  let pathPart;
  try {
    pathPart = decodeURIComponent(match[1]);
  } catch {
    problems.push(`${source}:${line}: link is not a valid URL: ${url}`);
    return url;
  }
  const hash = match[3] ?? '';
  const resolved = pathPart.startsWith('/')
    ? posix.normalize(pathPart.slice(1))
    : posix.normalize(posix.join(posix.dirname(source), pathPart));
  const repoPath = resolved.replace(/\/$/, '');
  if (repoPath.startsWith('..')) {
    problems.push(`${source}:${line}: link leaves the repository: ${url}`);
    return url;
  }
  if (targets.has(repoPath)) {
    let rel = posix.relative(posix.dirname(target), targets.get(repoPath));
    if (!rel.startsWith('.')) rel = `./${rel}`;
    return `${rel}${hash}`;
  }
  if (trackedSet.has(repoPath) && IMAGE.test(repoPath)) {
    const dest = join(staticSyncedDir, repoPath);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(repoRoot, repoPath), dest);
    return `/synced/${repoPath}`;
  }
  if (trackedSet.has(repoPath)) return githubUrl(repoPath, false) + hash;
  if (repoPath === '' || repoPath === '.' || trackedDirs.has(repoPath)) return githubUrl(repoPath === '.' ? '' : repoPath, true);
  problems.push(`${source}:${line}: links to ${url}, which is not a file or folder in the repository`);
  return url;
}

/**
 * Applies `fn` to prose with inline code spans masked out, so a link whose text holds code is still
 * found and a link-like string inside code is left alone. `fn` gets the masked text.
 */
function outsideCode(text, fn) {
  const spans = [];
  const masked = text.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, (span) => `\u0000${spans.push(span) - 1}\u0000`);
  return fn(masked).replace(/\u0000(\d+)\u0000/g, (all, index) => spans[Number(index)]);
}

/** Rewrites the links in one block of prose (several lines, no fenced code). */
function rewriteProse(text, source, target, firstLine) {
  const lineOf = (offset) => firstLine + text.slice(0, offset).split('\n').length - 1;
  return outsideCode(text, (prose) =>
    prose
      // [text](url) and ![alt](url), with an optional "title"; the text may run over several lines
      .replace(/(!?\[[^\]]*\]\()(<[^>\n]*>|[^)\s]+)((?:\s+"[^"]*")?\))/g, (all, open, url, close, offset) => {
        const bare = url.startsWith('<') ? url.slice(1, -1) : url;
        return `${open}${rewrite(bare, source, target, lineOf(offset))}${close}`;
      })
      // [id]: url reference definitions
      .replace(/^(\s{0,3}\[[^\]\n]+\]:[ \t]*)(\S+)/gm, (all, open, url, offset) => `${open}${rewrite(url, source, target, lineOf(offset))}`)
      // href="..." and src="..." in raw HTML
      .replace(/\b(href|src)=(["'])([^"'\n]+)\2/g, (all, attr, quote, url, offset) => `${attr}=${quote}${rewrite(url, source, target, lineOf(offset))}${quote}`)
  );
}

function convert(source, target, text) {
  let body = text.replace(/\r\n/g, '\n');
  // Front matter in a source file is metadata for other tools; the site writes its own.
  if (body.startsWith('---\n')) {
    const end = body.indexOf('\n---\n', 4);
    if (end > 0) body = body.slice(end + 5);
  }
  const lines = body.split('\n');
  const out = [];
  let prose = [];
  let proseStart = 1;
  const flush = () => {
    if (prose.length > 0) out.push(rewriteProse(prose.join('\n'), source, target, proseStart));
    prose = [];
  };
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (fence) {
      out.push(lines[i]);
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) {
      flush();
      fence = fenceMatch[1];
      out.push(lines[i]);
      continue;
    }
    if (prose.length === 0) proseStart = i + 1;
    prose.push(lines[i]);
  }
  flush();
  body = out.join('\n');

  const h1 = /^# (.+)$/m.exec(body);
  const title = h1 ? h1[1].replace(/`/g, '').trim() : posix.basename(source, '.md');
  const label = labels[source] ?? title;
  const slug = `/${target.replace(/\.synced\.md$/, '')}`.toLowerCase();
  const note = `> This page is rendered from [\`${source}\`](${githubUrl(source, false)}) in the repository. Edit it there: this copy is replaced at every build.`;
  if (h1) body = body.replace(h1[0], `${h1[0]}\n\n${note}`);
  else body = `# ${title}\n\n${note}\n\n${body}`;

  const yaml = (value) => JSON.stringify(value);
  const front = [
    '---',
    `sidebar_label: ${yaml(label)}`,
    `slug: ${yaml(slug)}`,
    `custom_edit_url: null`,
    `source_file: ${yaml(source)}`,
    '---',
    ''
  ].join('\n');
  return front + body;
}

/** Removes the previous run's output: only *.synced.md, generated _category_.json files and static/synced. */
function clean(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      clean(path);
      if (readdirSync(path).length === 0) rmdirSync(path);
    } else if (entry.name.endsWith('.synced.md')) {
      rmSync(path);
    } else if (entry.name === '_category_.json' && readFileSync(path, "utf8").includes("\"generatedBySync\": true")) {
      rmSync(path);
    }
  }
}

clean(contentDir);
rmSync(staticSyncedDir, { recursive: true, force: true });

const categoryRoots = ['architecture/design', 'architecture/codebase', 'architecture/decisions', 'using/reference'];
const writtenDirs = new Set();
for (const [source, target] of targets) {
  const dest = join(contentDir, target);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, convert(source, target, readFileSync(join(repoRoot, source), 'utf8')));
  let dir = posix.dirname(target);
  while (categoryRoots.some((root) => dir.startsWith(`${root}/`))) {
    writtenDirs.add(dir);
    dir = posix.dirname(dir);
  }
}

// Folders below a category root become sidebar categories named after the folder.
for (const dir of writtenDirs) {
  const file = join(contentDir, dir, '_category_.json');
  if (existsSync(file)) continue;
  const name = posix.basename(dir).replace(/[-_]+/g, ' ');
  const label = name.charAt(0).toUpperCase() + name.slice(1);
  writeFileSync(file, `${JSON.stringify({ label, collapsed: true, customProps: { generatedBySync: true } }, null, 2)}\n`);
}

if (problems.length > 0) {
  console.error(`The docs sync found ${problems.length} broken link(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
const sizes = [...targets.values()].reduce((sum, target) => sum + statSync(join(contentDir, target)).size, 0);
console.log(`Synced ${targets.size} repository documents (${Math.round(sizes / 1024)} KiB) into ${relative(repoRoot, contentDir)}, links pointing at ${gitRef}.`);
