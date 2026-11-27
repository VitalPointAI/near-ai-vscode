import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ASSET_DIR, createDocumentationRenderer } from './documentation-render.mjs';

// The tools folder sits at workbench/tools both in a checkout and in the image build, so root is the repository root in both.
// It reads the repository docs from there and writes only inside workbench/ (lib/frontend/). Fail with a plain message if a layout change breaks that.
const root = new URL('../../', import.meta.url);
const output = new URL('../lib/frontend/', import.meta.url);
if (!existsSync(new URL('docs-site/content/index.md', root))) {
  throw new Error(`build-sterling-documentation: no docs-site/content under ${root.pathname}; run it from workbench/ in a checkout or the image build.`);
}

// Only bundle the guides already published by the documentation site.
// Keep this list, and the images the guides show (docs/marketplace/), aligned with the Dockerfile inputs and Docker context allowlist.
const guides = [
  ['docs-site/content/index.md', 'Overview', 'Welcome', 'index.md'],
  ['docs-site/content/using/getting-started.md', 'Using Sterling', 'Getting started', 'using/getting-started.md'],
  ['docs-site/content/using/roles/administration.md', 'Using Sterling', 'Administration and organization rules', 'using/roles/administration.md'],
  ['docs-site/content/using/roles/data-and-connections.md', 'Using Sterling', 'Data and connections', 'using/roles/data-and-connections.md'],
  ['docs-site/content/using/roles/software-projects.md', 'Using Sterling', 'Software projects', 'using/roles/software-projects.md'],
  ['docs-site/content/using/roles/staff-teams.md', 'Using Sterling', 'Staff teams', 'using/roles/staff-teams.md'],
  ['README.md', 'Using Sterling', 'Features and settings', 'using/features.synced.md'],
  ['docs/staff-env-packs.md', 'Reference', 'Environment packs: terrain and weather for the COP map', 'using/reference/staff-env-packs.synced.md'],
  ['docs-site/content/security/trust-model.md', 'Security', 'The trust model in plain words', 'security/trust-model.md'],
  ['SECURITY.md', 'Security', 'Security policy', 'security/policy.synced.md'],
  ['docs-site/content/architecture/overview.mdx', 'Architecture', 'Architecture overview', 'architecture/overview.md'],
  ['CONTRIBUTING.md', 'Developing', 'Contributing', 'developing/contributing.synced.md'],
  ['docs/development-workflow.md', 'Developing', 'Development workflow', 'developing/development-workflow.synced.md'],
  ['docs/testing.md', 'Developing', 'Testing rules', 'developing/testing.synced.md'],
  ['docs-site/content/releases/versions.md', 'Releases', 'Documentation versions', 'releases/versions.md'],
  ['CHANGELOG.md', 'Releases', 'Changelog', 'releases/changelog.synced.md'],
];

// Each page is HTML made here (documentation-render.mjs): no Markdown, MDX or diagram source reaches the browser.
const renderer = createDocumentationRenderer({ root: fileURLToPath(root) });
const pages = await Promise.all(guides.map(async ([source, category, title, route]) => {
  const { html, text } = renderer.render(source, await readFile(new URL(source, root), 'utf8'), title);
  return { source, route, category, title, html, text };
}));
await rm(new URL(`${ASSET_DIR}/`, output), { recursive: true, force: true });
await mkdir(new URL(`${ASSET_DIR}/`, output), { recursive: true });
for (const [name, file] of renderer.assets) await copyFile(file, new URL(`${ASSET_DIR}/${name}`, output));
await writeFile(new URL('sterling-documentation.json', output), JSON.stringify(pages));
