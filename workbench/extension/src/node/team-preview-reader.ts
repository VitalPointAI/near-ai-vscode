import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TeamPreviewProject, TeamPreviewResult, TeamPreviewService, TeamPreviewTeam } from '../common/team-preview.js';

const projects: readonly (TeamPreviewProject & { readonly fixture?: string })[] = [
  { id: 'orchard', title: 'Orchard sample', fixture: 'orchard.md' },
  { id: 'lighthouse', title: 'Lighthouse sample', fixture: 'lighthouse.md' },
  { id: 'empty', title: 'Sample without a team' },
  { id: 'invalid', title: 'Sample with an invalid team', fixture: 'invalid.md' }
];

// The app root from this code's own location (lib/backend/main.js once bundled), never the working folder (D-12).
const appRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixtureDirectory = resolve(appRoot, 'extension', 'fixtures');
const parserFile = resolve(appRoot, 'engine', 'teams.cjs');
const { parseTeam } = createRequire(parserFile)(parserFile) as { parseTeam(text: string, file: string): TeamPreviewTeam };

async function readProject(id: string): Promise<TeamPreviewResult> {
  const project = projects.find(candidate => candidate.id === id);
  if (!project?.fixture) {
    return { kind: 'missing', message: 'This sample has no team file.' };
  }

  const file = resolve(fixtureDirectory, project.fixture);
  let content: string;
  try {
    // Ignore a link that would make a packaged fixture resolve to another location.
    if (await realpath(file) !== file) {
      return { kind: 'missing', message: 'The shipped team sample is unavailable.' };
    }
    content = await readFile(file, 'utf8');
  } catch {
    return { kind: 'missing', message: 'The shipped team sample is unavailable.' };
  }

  try {
    const { name, description, members } = parseTeam(content, project.fixture);
    return {
      kind: 'ready',
      team: {
        name,
        description,
        members: members.map(({ name, role, reportsTo, instructions }) => ({ name, role, reportsTo, instructions }))
      }
    };
  } catch (error) {
    return {
      kind: 'invalid',
      message: error instanceof Error ? error.message : 'The team sample could not be parsed.'
    };
  }
}

export const teamPreviewReader: TeamPreviewService = {
  async listProjects() {
    return projects.map(({ id, title }) => ({ id, title }));
  },
  readProject
};
