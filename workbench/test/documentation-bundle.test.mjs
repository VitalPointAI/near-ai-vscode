import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempDisposableSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import { resolveDocumentationLink } from '../extension/src/common/documentation-links.ts';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const repositoryRoot = existsSync(join(sourceRoot, 'workbench/Dockerfile'))
  ? sourceRoot
  : fileURLToPath(new URL('../../../', import.meta.url));
const { unescapeAll } = new MarkdownIt().utils;

function articleHeadingIds(html) {
  return new Set([...html.matchAll(/<h[1-6]\b[^>]*\sid="([^"]+)"/g)].map(([, id]) => id));
}

test('the Workbench image bundles its linked guides and original architecture blueprints offline', context => {
  const scratch = mkdtempDisposableSync(join(tmpdir(), 'sterling-doc-bundle-'));
  context.after(() => scratch.remove());
  const root = scratch.path;
  const dockerfile = readFileSync(join(repositoryRoot, 'workbench/Dockerfile'), 'utf8');
  const allowlist = new Set(readFileSync(join(repositoryRoot, 'workbench/Dockerfile.dockerignore'), 'utf8').split(/\r?\n/));
  const inputs = [...dockerfile.matchAll(/^COPY ([^\n]+) \/repo\/[^\n]*$/gm)]
    .flatMap(([, operands]) => operands.split(' '))
    .filter(source => source === 'LICENSE' || (/\.(mdx?|png|webp)$/.test(source) && !source.startsWith('--')));
  for (const source of [...inputs, 'workbench/tools/build-sterling-documentation.mjs', 'workbench/tools/documentation-render.mjs']) {
    if (inputs.includes(source)) assert.ok(allowlist.has('!' + source), source + ' must enter the Workbench Docker context');
    mkdirSync(dirname(join(root, source)), { recursive: true });
    copyFileSync(join(repositoryRoot, source), join(root, source));
  }
  symlinkSync(join(repositoryRoot, 'workbench/node_modules'), join(root, 'workbench/node_modules'), 'dir');
  execFileSync(process.execPath, [join(root, 'workbench/tools/build-sterling-documentation.mjs')]);
  const output = join(root, 'workbench/lib/frontend');
  const pages = JSON.parse(readFileSync(join(output, 'sterling-documentation.json'), 'utf8'));
  const pagesByRoute = new Map(pages.map(page => [page.route, page]));
  assert.equal(pagesByRoute.size, pages.length, 'each bundled route is unique');
  for (const route of [
    'using/deployment-hardware.md',
    'using/reference/hosting/capacity.synced.md',
    'using/reference/relay.synced.md',
    'using/reference/site-install.synced.md',
    'security/road-to-production.md',
    'security/documents/incident-response.synced.md',
    'architecture/roadmap.synced.md',
    'architecture/codebase/ARCHITECTURE.synced.md',
    'architecture/codebase/INTEGRATIONS.synced.md',
    'architecture/codebase/STRUCTURE.synced.md',
    'developing/docs-site.synced.md',
  ]) assert.match(pagesByRoute.get(route)?.html ?? '', /<h[1-6]\b/, `rendered offline guide: ${route}`);
  const features = pagesByRoute.get('using/features.synced.md');
  const licence = resolveDocumentationLink('LICENSE', features, pages);
  assert.equal(licence?.kind, 'page');
  assert.match(licence.page.html, /Permission is hereby granted/);
  const headingIds = new Map(pages.map(page => [page, articleHeadingIds(page.html)]));
  for (const page of pages) {
    for (const [, href] of page.html.matchAll(/<a href="([^"]+)"/g)) {
      const link = resolveDocumentationLink(unescapeAll(href), page, pages);
      if (!/^[a-z][a-z\d+.-]*:|^\/\//i.test(href)) {
        assert.ok(link && link.kind !== 'external', `${page.route} has an offline destination for ${href}`);
      }
      if (!link) continue;
      if (link.kind === 'asset') assert.ok(existsSync(join(output, link.href)), `copied asset: ${link.href}`);
      if (link.kind === 'page' && link.hash) {
        assert.ok(headingIds.get(link.page)?.has(decodeURIComponent(link.hash.slice(1))),
          `${page.route} links to a section in ${link.page.route}: ${href}`);
      }
    }
  }
  const overview = pagesByRoute.get('architecture/overview.md');
  const imageSources = [...overview.html.matchAll(/<img src="(sterling-documentation\/[a-f\d]{16}\.webp)"/g)].map(([, asset]) => asset);
  assert.equal(imageSources.length, 2);
  for (const [index, name] of ['sovai-physical-layout.webp', 'sovai-data-flows.webp'].entries()) {
    assert.deepEqual(readFileSync(join(output, imageSources[index])), readFileSync(join(repositoryRoot, 'docs-site/static/img', name)));
  }
});
