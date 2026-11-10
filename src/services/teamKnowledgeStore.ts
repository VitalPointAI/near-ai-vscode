// Where a team's knowledge graph lives, and how the agent adds to it during a run (owner, 2026-11-08: "each team needs to learn over time and have its
// own shared context graph of knowledge to draw from. Any research it does or any information it's given by those it interacts with should be added to
// the graph").
//
// One file per team under the team library's own storage, beside the team files: <teams>/knowledge/<key>.json. Callers pass the team's SLUG, which is the
// team file's own name in the library and therefore unique there, so two library teams never share a map. Writes are whole-file and atomic, and a damaged
// file is set aside and reported rather than thrown away silently.
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { emptyKnowledge, heldToCeiling, mergeKnowledge, type KnowledgeAddition, type TeamKnowledge } from '../domain/teamKnowledge';

/**
 * The file name for a team key, and an injective one. A key that is already a plain lowercase slug (every team slug is) keeps its name, so every graph on
 * disk is found where 0.4.18 wrote it. Anything else becomes `<clean>~<hash of the original>`: `~` never occurs in a plain key, so a hashed name can never
 * equal a plain one, two different keys never share a file, and no key can leave `<dir>/knowledge` (`..`, `../x`).
 */
function fileKey(team: string): string {
  if (/^[a-z0-9-]+$/.test(team)) return team;
  const cleaned = team.replace(/[^a-z0-9-]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '').slice(0, 40);
  return `${cleaned || 'team'}~${createHash('sha256').update(team).digest('hex').slice(0, 12)}`;
}

/** Where a team's graph file is: `<dir>/knowledge/<key>.json` (see fileKey). */
export const knowledgeFile = (dir: string, team: string): string => path.join(dir, 'knowledge', `${fileKey(team)}.json`);

/**
 * The graph for a team, or an empty one when it has not learned anything yet. A file that cannot be read is reported, not replaced here. Every grade an
 * agent wrote is held to the ceiling as it is read, so a graph written before the ceiling existed is shown and used at the grade it is worth.
 */
export async function loadKnowledge(dir: string, team: string): Promise<{ knowledge: TeamKnowledge; problem?: string }> {
  const file = knowledgeFile(dir, team);
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch { return { knowledge: emptyKnowledge(team, new Date().toISOString()) }; }
  try {
    const parsed = JSON.parse(text) as TeamKnowledge;
    if (parsed.version !== 1 || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) throw new Error('unexpected shape');
    return { knowledge: heldToCeiling({ ...parsed, team }) };
  } catch (error) {
    return { knowledge: emptyKnowledge(team, new Date().toISOString()), problem: `The knowledge graph for ${team} could not be read (${(error as Error).message}).` };
  }
}

export async function saveKnowledge(dir: string, knowledge: TeamKnowledge): Promise<void> {
  const file = knowledgeFile(dir, knowledge.team);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const { problem: _problem, ...record } = knowledge;
  await writeFile(temporary, JSON.stringify(record, null, 2), 'utf8');
  await rename(temporary, file);
}

/**
 * One write at a time per team file. Every member of a team shares the graph and up to 8 run at once, so two Learn calls could read the same file, merge
 * separately, and the second write would silently lose the first addition. The queue is per file and lives in this process, which is where every write
 * comes from: one extension host.
 */
const writing = new Map<string, Promise<unknown>>();

async function serialised<T>(file: string, run: () => Promise<T>): Promise<T> {
  const previous = writing.get(file) ?? Promise.resolve();
  // The next write waits for this one even if it failed, so one failure cannot block the graph for the rest of the session.
  const next = previous.then(run, run);
  const tracked = next.catch(() => undefined);
  writing.set(file, tracked);
  try {
    return await next;
  } finally {
    // Only the last write clears the entry, so a queued write is never forgotten.
    if (writing.get(file) === tracked) writing.delete(file);
  }
}

/**
 * Adds what an agent learned.
 *
 * Two locks, because they stop two different losses:
 *   - `serialised` orders the writes inside ONE extension host, so parallel team members never interleave a read and a write.
 *   - the compare-and-retry below covers OTHER processes: the team library is shared by every VS Code window, each with its own host, so two windows could
 *     read the same file, merge separately, and the second write would drop the first addition. Each attempt re-reads and checks that the file is still
 *     exactly what was read; if another window wrote in between, it merges again over the newer file.
 *
 * A damaged file is copied aside to `<key>.damaged-<time>.json` before the rebuilt graph replaces it, and the problem says where the copy is, so nothing a team
 * learned is destroyed by a write over a file that could not be read.
 */
export async function addKnowledge(dir: string, team: string, addition: KnowledgeAddition): Promise<TeamKnowledge> {
  const file = knowledgeFile(dir, team);
  return serialised(file, async () => {
    let last: { merged: TeamKnowledge; problem?: string } | undefined;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const before = await readFile(file, 'utf8').catch(() => undefined);
      const { knowledge, problem } = await loadKnowledge(dir, team);
      const merged = mergeKnowledge(knowledge, addition);
      // Write only if the file is still what was read. A rename is atomic, so a reader never sees half a file; this compares CONTENT, which is what another
      // window would have changed.
      const now = await readFile(file, 'utf8').catch(() => undefined);
      if (now !== before) { last = { merged, problem }; continue; }
      const kept = problem && before !== undefined ? await setAside(file, problem) : problem;
      await saveKnowledge(dir, merged);
      return kept ? { ...merged, problem: kept } : merged;
    }
    // Another window kept writing through every attempt. Write anyway, merged over the latest read, so the caller's addition is in the file rather than
    // reported as learned and lost.
    const latest = await loadKnowledge(dir, team);
    const final = mergeKnowledge(latest.knowledge, addition);
    const kept = latest.problem ? await setAside(file, latest.problem) : last?.problem;
    await saveKnowledge(dir, final);
    return kept ? { ...final, problem: kept } : final;
  });
}

/** Copies a damaged graph file aside before it is replaced, and says where it went (or that it could not be kept). */
async function setAside(file: string, problem: string): Promise<string> {
  const copy = file.replace(/\.json$/, `.damaged-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  try {
    await copyFile(file, copy);
    return `${problem} The unreadable file was kept as ${path.basename(copy)} and a new graph was started.`;
  } catch (error) {
    return `${problem} The unreadable file could not be kept (${(error as Error).message}) and a new graph was started.`;
  }
}

/**
 * What a run is told about the graph, and how to add to it. Short on purpose: it is a hint about a tool, not a second system prompt. The Admiralty
 * grading is spelled out because agents will not guess it, and ungraded knowledge is worth less than graded knowledge.
 */
export const KNOWLEDGE_INSTRUCTIONS = `# This team's knowledge graph
You share a knowledge graph with the rest of your team, and it is what the team knows about the world so far. Read it before researching: if it already answers the question, say so and cite the node instead of searching again. Add to it as you learn, with Remember-style facts, so the team is more useful next time.

Add to it only what you verified. Grade each piece with the Admiralty scale: reliability A (completely reliable) to F (cannot be trusted) for the source, and credibility 1 (confirmed by other sources) to 6 (impossible) for the information. A document the team wrote, or a vendor's own marketing, is not an A. Anything you add is stored at C3 at most, because an agent's own word cannot be checked; grade lower when the evidence is weaker, and cite the source so a person can check it.

Extract actors (organisations, people, systems, documents, facts, places), what each does, and how they relate: the kind of relation, and its tension from -1 (hostile or contradictory) through 0 (neutral) to +1 (strongly supportive). State the basis for each relation. Leave the tension unset rather than guessing zero.`;
