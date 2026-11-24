import { mkdir, readFile, writeFile } from 'node:fs/promises';

const root = new URL('../../../../', import.meta.url);
const output = new URL('../lib/frontend/', import.meta.url);

// The tools folder sits at .planning/spikes/theia-team-studio/tools both in a checkout and in the image (the Dockerfile's
// WORKDIR is that folder), so root is the repository root in both. Fail with a plain message if a layout change breaks that.
import { existsSync } from 'node:fs';
if (!existsSync(new URL('docs-site/content/index.md', root))) {
  throw new Error(`build-sterling-documentation: no docs-site/content under ${root.pathname}; run it from the spike folder of a checkout or the image build.`);
}

// Only bundle the guides already published by the documentation site.
// Keep this list aligned with the Dockerfile inputs and Docker context allowlist.
const guides = [
  ['docs-site/content/index.md', 'Overview', 'Welcome', 'index.md'],
  ['docs-site/content/using/getting-started.md', 'Using Sterling', 'Getting started', 'using/getting-started.md'],
  ['docs-site/content/using/roles/administration.md', 'Using Sterling', 'Administration and organization rules', 'using/roles/administration.md'],
  ['docs-site/content/using/roles/data-and-connections.md', 'Using Sterling', 'Data and connections', 'using/roles/data-and-connections.md'],
  ['docs-site/content/using/roles/software-projects.md', 'Using Sterling', 'Software projects', 'using/roles/software-projects.md'],
  ['docs-site/content/using/roles/staff-teams.md', 'Using Sterling', 'Staff teams', 'using/roles/staff-teams.md'],
  ['README.md', 'Using Sterling', 'Features and settings', 'using/features.synced.md'],
  ['docs-site/content/security/trust-model.md', 'Security', 'The trust model in plain words', 'security/trust-model.md'],
  ['SECURITY.md', 'Security', 'Security policy', 'security/policy.synced.md'],
  ['docs-site/content/architecture/overview.md', 'Architecture', 'Architecture overview', 'architecture/overview.md'],
  ['docs/development-workflow.md', 'Developing', 'Development workflow', 'developing/development-workflow.synced.md'],
  ['docs/testing.md', 'Developing', 'Testing rules', 'developing/testing.synced.md'],
  ['docs-site/content/releases/versions.md', 'Releases', 'Documentation versions', 'releases/versions.md'],
  ['CHANGELOG.md', 'Releases', 'Changelog', 'releases/changelog.synced.md'],
];

const pages = await Promise.all(guides.map(async ([source, category, title, route]) => {
  const input = await readFile(new URL(source, root), 'utf8');
  const markdown = input.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    .replace(/!\[([^\]\n]*)\]([([])/g, '[$1]$2');
  return { source, route, category, title, markdown };
}));
await mkdir(output, { recursive: true });
await writeFile(new URL('sterling-documentation.json', output), JSON.stringify(pages));
