import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

const root = new URL('../../../../', import.meta.url);
const content = new URL('docs-site/content/', root);
const output = new URL('../lib/frontend/', import.meta.url);
const repositoryPages = [
  ['README.md', 'Using Sterling', 'Features and settings', 'using/features.synced.md'],
  ['SECURITY.md', 'Security', 'Security policy', 'security/policy.synced.md'],
  ['CHANGELOG.md', 'Releases', 'Changelog', 'releases/changelog.synced.md'],
  ['CONTRIBUTING.md', 'Developing', 'Contributing', 'developing/contributing.synced.md'],
  ['docs/development-workflow.md', 'Developing', 'Development workflow', 'developing/development-workflow.synced.md'],
  ['docs/testing.md', 'Developing', 'Testing', 'developing/testing.synced.md']
];
const categories = {
  'using': 'Using Sterling',
  'security': 'Security',
  'architecture': 'Architecture',
  'releases': 'Releases'
};

async function page(source, category, title, route) {
  const raw = await readFile(new URL(source, root), 'utf8');
  const markdown = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    .replace(/!\[([^\]\n]*)\]\(/g, '[$1](');
  return {
    source,
    route,
    category,
    title: title ?? /^# (.+)$/m.exec(markdown)?.[1].trim() ?? source,
    markdown
  };
}

const pages = [];
for (const entry of (await readdir(content, { recursive: true })).sort()) {
  if (!entry.endsWith('.md') || entry.endsWith('.synced.md') || entry.startsWith('accreditation/')) continue;
  const category = categories[entry.split('/')[0]] ?? 'Overview';
  pages.push(await page(`docs-site/content/${entry}`, category, entry === 'index.md' ? 'Welcome' : undefined, entry));
}
for (const args of repositoryPages) pages.push(await page(...args));
const primaryDocs = new Set(repositoryPages.map(([source]) => source));
for (const entry of (await readdir(new URL('docs/', root))).sort()) {
  const source = `docs/${entry}`;
  if (!entry.endsWith('.md') || primaryDocs.has(source)) continue;
  pages.push(await page(source, 'Reference', undefined, `using/reference/${entry.slice(0, -3)}.synced.md`));
}
const categoryOrder = ['Overview', 'Using Sterling', 'Reference', 'Security', 'Architecture', 'Developing', 'Releases'];
pages.sort((left, right) => categoryOrder.indexOf(left.category) - categoryOrder.indexOf(right.category));
await mkdir(output, { recursive: true });
await writeFile(new URL('sterling-documentation.json', output), JSON.stringify(pages));
