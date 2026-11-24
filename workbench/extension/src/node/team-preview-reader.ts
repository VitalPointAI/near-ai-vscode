import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TeamPreviewProject, TeamPreviewResult, TeamPreviewService, TeamPreviewTeam } from '../common/team-preview.js';

const projects: readonly (TeamPreviewProject & { readonly fixture?: string })[] = [
  { id: 'orchard', title: 'Orchard sample', fixture: 'orchard.md' },
  { id: 'lighthouse', title: 'Lighthouse sample', fixture: 'lighthouse.md' },
  { id: 'empty', title: 'Sample without an agent team' },
  { id: 'invalid', title: 'Sample with an invalid agent team', fixture: 'invalid.md' }
];

const UNAVAILABLE: TeamPreviewResult = { kind: 'missing', message: 'The shipped agent team sample is unavailable.' };

type ParseTeam = (text: string, file: string) => TeamPreviewTeam;

/**
 * The app root from this code's own location, never the working folder (D-12). The backend is bundled by `theia build` (esbuild, ES
 * modules) into lib/backend/main.js, where `import.meta.url` is the bundle's own URL at run time, so the app root is two folders up.
 */
export function defaultAppRoot(): string {
  return fileURLToPath(new URL('../..', import.meta.url));
}

/**
 * The Team preview service over the shipped samples. The fixtures are `<appRoot>/extension/fixtures`, the engine is the parser bundle
 * `<appRoot>/engine/teams.cjs` (tools/build-engine.mjs), the same parseTeam the extension calls, so an invalid sample returns the
 * parser's own message as plain data (D-16). The engine is loaded on first use, so a missing bundle is "unavailable", never a crash at
 * backend start.
 */
export function createTeamPreviewReader(options: { readonly appRoot?: string } = {}): TeamPreviewService {
  const appRoot = options.appRoot ?? defaultAppRoot();
  const fixtureDirectory = resolve(appRoot, 'extension', 'fixtures');
  const engineFile = resolve(appRoot, 'engine', 'teams.cjs');
  let parseTeam: ParseTeam | undefined;

  const loadParser = (): ParseTeam | undefined => {
    if (!parseTeam) {
      try {
        parseTeam = (createRequire(engineFile)(engineFile) as { parseTeam: ParseTeam }).parseTeam;
      } catch {
        return undefined;
      }
    }
    return parseTeam;
  };

  async function readProject(id: string): Promise<TeamPreviewResult> {
    const project = projects.find(candidate => candidate.id === id);
    if (!project?.fixture) {
      return { kind: 'missing', message: 'This sample has no agent team file.' };
    }

    let content: string;
    try {
      // Only a file inside the fixture folder counts: compare with the folder's own realpath, so a linked parent is fine and a fixture
      // that is a link to somewhere else is not.
      const file = join(fixtureDirectory, project.fixture);
      if (await realpath(file) !== join(await realpath(fixtureDirectory), project.fixture)) {
        return UNAVAILABLE;
      }
      content = await readFile(file, 'utf8');
    } catch {
      return UNAVAILABLE;
    }

    const parse = loadParser();
    if (!parse) return UNAVAILABLE;
    try {
      const { name, description, members } = parse(content, project.fixture);
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
        message: error instanceof Error ? error.message : 'The agent team sample could not be parsed.'
      };
    }
  }

  return {
    async listProjects() {
      return projects.map(({ id, title }) => ({ id, title }));
    },
    readProject
  };
}
