import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveDocumentationLink } from '../extension/src/common/documentation-links.ts';

const home = { route: 'index.md', source: 'docs-site/content/index.md' };
const overview = { route: 'architecture/overview.md', source: 'docs-site/content/architecture/overview.mdx' };
const components = { route: 'architecture/components/index.md', source: 'docs-site/content/architecture/components/index.md' };
const relay = { route: 'architecture/components/sync-and-relay.md', source: 'docs-site/content/architecture/components/sync-and-relay.md' };
const workflow = { route: 'developing/development-workflow.synced.md', source: 'docs/development-workflow.md' };
const contributing = { route: 'developing/contributing.synced.md', source: 'CONTRIBUTING.md' };
const pages = [home, overview, components, relay, workflow, contributing];
const github = 'https://github.com/VitalPointAI/near-ai-vscode';

test('bundled links resolve by documentation route or repository source and preserve their anchors', () => {
  for (const href of [
    './components/sync-and-relay.md#hub',
    './components/sync-and-relay#hub',
    '/architecture/components/sync-and-relay.mdx#hub',
    '/docs-site/content/architecture/components/sync-and-relay.md#hub',
  ]) {
    assert.deepEqual(resolveDocumentationLink(href, overview, pages), { kind: 'page', page: relay, hash: '#hub' }, href);
  }
  for (const href of ['./components/', './components/index.mdx', './components']) {
    assert.deepEqual(resolveDocumentationLink(href, overview, pages), { kind: 'page', page: components, hash: '' }, href);
  }
  assert.deepEqual(resolveDocumentationLink('/architecture/overview.mdx', home, pages), { kind: 'page', page: overview, hash: '' });
  assert.deepEqual(resolveDocumentationLink('#paths-through-the-system', overview, pages),
    { kind: 'page', page: overview, hash: '#paths-through-the-system' });
  assert.deepEqual(resolveDocumentationLink('/', overview, pages), { kind: 'page', page: home, hash: '' });
  assert.deepEqual(resolveDocumentationLink('../CONTRIBUTING.md', workflow, pages),
    { kind: 'page', page: contributing, hash: '' });
  assert.deepEqual(resolveDocumentationLink('/developing/development-workflow#checks', home, pages),
    { kind: 'page', page: workflow, hash: '#checks' });
});

test('current same-repository document URLs use the bundled copy, while provenance links keep their destination', () => {
  for (const href of [
    `${github}/blob/main/docs/development-workflow.md#checks`,
    `${github}/raw/main/docs/development-workflow.md#checks`,
    'https://raw.githubusercontent.com/VitalPointAI/near-ai-vscode/main/docs/development-workflow.md#checks',
  ]) {
    assert.deepEqual(resolveDocumentationLink(href, overview, pages), { kind: 'page', page: workflow, hash: '#checks' }, href);
  }
  for (const href of [
    `${github}/pull/226`,
    `${github}/issues/29`,
    `${github}/blob/v0.4.41/docs/development-workflow.md#checks`,
    `${github}/blob/main/docs/development-workflow.md#L3-L5`,
    `${github}/blob/main/src/extension.ts`,
    'https://example.com/doc',
    'mailto:review@example.com',
  ]) {
    assert.deepEqual(resolveDocumentationLink(href, overview, pages), { kind: 'external', href }, href);
  }
});

test('unavailable internal links do not fabricate GitHub destinations and only exact packaged images can open', () => {
  assert.equal(resolveDocumentationLink('./design/unbundled.synced.md#detail', overview, pages), undefined);
  assert.equal(resolveDocumentationLink('javascript:alert(1)', overview, pages), undefined);
  assert.equal(resolveDocumentationLink('./bad%ZZ.md', overview, pages), undefined);
  assert.equal(resolveDocumentationLink('/sterling-documentation/other.webp', overview, pages), undefined);
  const image = 'sterling-documentation/1234567890abcdef.webp';
  assert.deepEqual(resolveDocumentationLink(image, overview, pages), { kind: 'asset', href: image });
});

test('the published gap register opens the built-in Compliance view', () => {
  const road = { route: 'security/road-to-production.md', source: 'docs-site/content/security/road-to-production.md' };
  assert.deepEqual(resolveDocumentationLink('../accreditation/gaps.mdx', road, pages), { kind: 'compliance' });
  assert.equal(resolveDocumentationLink('/accreditation/unknown.mdx', road, pages), undefined);
});

test('an ambiguous normalized route requires an exact page or source match', () => {
  const second = { route: 'architecture/components.mdx', source: 'other/components.mdx' };
  assert.equal(resolveDocumentationLink('./components', overview, [...pages, second]), undefined);
  assert.deepEqual(resolveDocumentationLink('./components/index.md', overview, [...pages, second]),
    { kind: 'page', page: components, hash: '' });
});
