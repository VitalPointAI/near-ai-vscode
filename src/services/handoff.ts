import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HandoffState } from '../domain/continuity';

export async function saveHandoff(projectRoot: string, state: Omit<HandoffState, 'version' | 'createdAt' | 'projectRoot'>): Promise<string> {
  const planningRoot = join(projectRoot, '.planning');
  await mkdir(planningRoot, { recursive: true });
  const handoffPath = join(planningRoot, 'HANDOFF.json');
  const handoff: HandoffState = {
    version: 1,
    createdAt: new Date().toISOString(),
    projectRoot,
    ...state
  };
  await writeFile(handoffPath, `${JSON.stringify(handoff, null, 2)}\n`, { encoding: 'utf8' });
  return handoffPath;
}
