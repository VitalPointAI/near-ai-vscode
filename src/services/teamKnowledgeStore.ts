// Where a team's knowledge graph lives, and how the agent adds to it during a run (owner, 2026-11-08: "each team needs to learn over time and have its
// own shared context graph of knowledge to draw from. Any research it does or any information it's given by those it interacts with should be added to
// the graph").
//
// One file per team under the team library's own storage, beside the team files: <teams>/knowledge/<slug>.json. A team is its file, so its knowledge
// travels with it and two teams never share a map. Writes are whole-file and atomic, and a damaged file is reported rather than thrown away silently.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { emptyKnowledge, mergeKnowledge, type KnowledgeAddition, type TeamKnowledge } from '../domain/teamKnowledge';

/** A team name as a file name that is INJECTIVE: hash anything that is not already a plain lowercase slug, under a separator a plain name cannot contain (see knowledgeFile). */
function teamSlug(team: string): string {
  const cleaned = team.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
  // A non-empty name that is EXACTLY its own plain lowercase slug keeps the plain file name, so every graph already on disk under a plain name is still found
  // with no migration. Such a name is built only from [a-z0-9-], which is why the hash form below can never collide with it (0.4.19 review).
  if (team && cleaned === team) return team;
  // Sanitising is lossy — `acme co`, `acme-co`, `ACME` and `acme` would all clean to `acme` — so everything else takes `<clean>~<hash of the ORIGINAL>`.
  // The `~` never occurs in a plain name and occurs exactly once here, so no two names can reach one file, and the empty name is hashed too rather than
  // falling back to the shared `team.json` (0.4.19 review). Twelve hex like a node id, for margin over the reviewer's 8.
  return `${cleaned || 'team'}~${createHash('sha256').update(team).digest('hex').slice(0, 12)}`;
}

/** The file name a team had BEFORE teamSlug became injective, mirroring the old expression EXACTLY: the old code wrote `knowledge/.json` for a name like `..`. */
const legacyKnowledgeFile = (dir: string, team: string): string => path.join(dir, 'knowledge', `${team.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}.json`);

/** One file, read and parsed. A file that cannot be read is reported, not replaced. The parsed `team` field is returned AS READ: it is the file's own claim
  * about who it belongs to, and the migration gate in loadKnowledge must check that claim rather than the name of whoever is asking — stamping it here would
  * make every file name its reader, and the identity check would compare a name against itself (0.4.19 review). */
async function readKnowledgeFile(file: string, team: string): Promise<{ knowledge?: TeamKnowledge; problem?: string }> {
  const text = await readFile(file, 'utf8').catch(() => undefined);
  if (text === undefined) return {};
  try {
    const parsed = JSON.parse(text) as TeamKnowledge;
    if (parsed.version !== 1 || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) throw new Error('unexpected shape');
    return { knowledge: parsed };
  } catch (error) {
    // The graph is a record of what the team learned, so a damaged one is reported but must not stop the team working.
    return { problem: `The knowledge graph for ${team} could not be read (${(error as Error).message}). It will be rebuilt as the team works.` };
  }
}

/** What a caller always gets: the graph read from disk stamped with the team that asked, or an empty one when nothing readable is there. */
const presented = (read: { knowledge?: TeamKnowledge; problem?: string }, team: string): { knowledge: TeamKnowledge; problem?: string } => ({
  knowledge: read.knowledge ? { ...read.knowledge, team } : emptyKnowledge(team, new Date().toISOString()),
  ...(read.problem ? { problem: read.problem } : {})
});

/**
 * The graph for a team, or an empty one when it has not learned anything yet.
 *
 * The file name changed when teamSlug became injective, so this falls back to the OLD name: without that, every existing team whose name is not already a
 * plain lowercase slug (`My Team` was `my-team.json`) would lose its memory on upgrade, because the new path would simply not exist (0.4.19 review). The
 * legacy graph is read and written back under the new name, so the migration happens once and the old file is left as a backup.
 */
/** The whole graph as one addition, so a raced migration can merge a legacy file into a graph another window has just created (see loadKnowledge). Each fact
  * keeps its own source and grade and the node keeps its functions and grade; per-fact timestamps and mention counts are rebuildable metadata that the merge
  * re-dates on purpose, since the merge itself is the moment of arrival for a raced window's copy. Edge endpoints resolve through a label map built once
  * rather than a find per edge (sixth 0.4.19 review, MINOR — quadratic on a large graph). Provenance reads as `seed`, the honest mark for knowledge that
  * arrived by migration rather than by a run. */
const additionOf = (graph: TeamKnowledge): KnowledgeAddition => {
  const labelOf = new Map(graph.nodes.map((node) => [node.id, node.label]));
  return {
    origin: 'seed',
    at: new Date().toISOString(),
    nodes: graph.nodes.map((node) => ({
      label: node.label,
      ...(node.kind !== 'actor' ? { kind: node.kind } : {}),
      functions: node.functions,
      facts: node.facts.map((fact) => ({ text: fact.text, ...(fact.source ? { source: fact.source } : {}) })),
      ...(node.grading ? { grading: node.grading } : {})
    })),
    edges: graph.edges.map((edge) => ({ from: labelOf.get(edge.from) ?? edge.from, to: labelOf.get(edge.to) ?? edge.to, kind: edge.kind, ...(edge.tension !== null ? { tension: edge.tension } : {}), ...(edge.basis ? { basis: edge.basis } : {}), ...(edge.grading ? { grading: edge.grading } : {}) }))
  };
};

/** A merge cannot carry the refutation HISTORY (an addition is claims, not a record), so the raced migration re-attaches each legacy node's history to the
  * merged node by label: what the team un-believed, and why, is exactly what a merge must not lose (fourth 0.4.19 review, MINOR). */
const withLegacyHistory = (merged: TeamKnowledge, legacy: TeamKnowledge): TeamKnowledge => {
  const byLabel = new Map(merged.nodes.map((node) => [node.label.trim().toLowerCase(), node]));
  for (const old of legacy.nodes) {
    if (!old.history?.length) continue;
    const kept = byLabel.get(old.label.trim().toLowerCase());
    if (!kept) continue;
    const known = new Set([...kept.facts, ...(kept.history ?? [])].map((fact) => fact.text.trim().toLowerCase()));
    kept.history = [...(kept.history ?? []), ...old.history.filter((fact) => !known.has(fact.text.trim().toLowerCase()))];
  }
  return merged;
};

export async function loadKnowledge(dir: string, team: string): Promise<{ knowledge: TeamKnowledge; problem?: string }> {
  const file = knowledgeFile(dir, team);
  const legacy = legacyKnowledgeFile(dir, team);
  const current = presented(await readKnowledgeFile(file, team), team);
  // 0.4.19 review: the gate was "the new graph has nodes", which made a legitimately EMPTIED new graph re-import the old file's nodes on every load. The
  // gate is now whether the new file exists at all: migration happens once, when it does not.
  if (existsSync(file) || file === legacy) return current;
  const older = await readKnowledgeFile(legacy, team);
  const legacyGraph = older.knowledge;
  let mergedProblem: string | undefined = undefined;
  // Identity check before adopting (0.4.19 review): the legacy file of a NON-plain name is also the LIVE file of a plain team (`acme co` once sanitised to
  // `acme-co.json`, which is team `acme-co`'s graph), and its parsed `team` names `acme-co`, not the team asking. Only a file that names THIS team migrates;
  // anything else stays exactly where it is, so one team never reads or copies another's graph.
  if (legacyGraph?.team !== team || !legacyGraph.nodes.length) return current;
  // A legacy file that parsed damaged carries its problem forward (eighth 0.4.19 review, MINOR): the caller is adopting whatever readable parts survived,
  // and it must be told the record it came from was not whole — the previous code reported this and the identity-gate rewrite dropped it.
  const legacyProblem = older.problem;
  // Migration races like any other writer (0.4.19 review MAJOR): between the existsSync above and a save below, a concurrent addKnowledge — here or in
  // another window — can create the new file, and a blind rename would clobber its addition. The compare-and-retry below is the same guard addKnowledge
  // uses across windows, and it deliberately does NOT enter the per-file write queue: addKnowledge already holds that queue while it calls this function,
  // so re-entering it here would deadlock. If the file appeared, the legacy graph MERGES into what is there instead of replacing it.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const before = await readFile(file, 'utf8').catch(() => undefined);
    if (before === undefined) {
      // The read came back empty, so the file does not exist YET — but a concurrent window may create it between now and the write (fifth 0.4.19 review,
      // MINOR). Exclusive-create closes that window: EEXIST means someone else won the race and the retry loop takes the merge branch. Every OTHER failure
      // (EACCES, ENOSPC) is not a race, and retrying it would just fail again (sixth 0.4.19 review, MINOR), so it surfaces as the read's problem and the
      // caller is told the legacy graph is NOT in place.
      try {
        await writeFile(file, JSON.stringify(legacyGraph, null, 2), { flag: 'wx' });
        return { knowledge: legacyGraph, ...(legacyProblem ? { problem: legacyProblem } : {}) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        return { knowledge: legacyGraph, problem: `The knowledge graph for ${team} could not be moved to its new file name (${(error as Error).message}). The old file is untouched and will be tried again.` };
      }
    }
    const newer = presented(await readKnowledgeFile(file, team), team);
    const merged = withLegacyHistory(mergeKnowledge(newer.knowledge, additionOf(legacyGraph)), legacyGraph);
    const now = await readFile(file, 'utf8').catch(() => undefined);
    if (now !== before) continue;
    // A failed write is REPORTED, not swallowed (sixth 0.4.19 review, MINOR): returning the merged graph after a failed save would claim persistence the
    // file does not hold. The problem rides the returned read, exactly as a damaged file's does.
    await saveKnowledge(dir, merged).catch((error: Error) => {
      mergedProblem = `The knowledge graph for ${team} could not be written (${error.message}). The addition may be lost when this window closes.`;
    });
    // Return the MERGED graph (second 0.4.19 review, MAJOR): the caller asked for this team's knowledge now, and after the merge that is the concurrent
    // window's graph plus the legacy one — returning the pre-merge snapshot would hide nodes another window already learned.
    return { knowledge: merged, ...(mergedProblem || legacyProblem ? { problem: mergedProblem ?? legacyProblem } : {}) };
  }
  // The retry budget ran out without a confirmed write: re-read whatever IS on disk now (sixth 0.4.19 review, MINOR) rather than presenting a legacy snapshot
  // that may hold less than another window has already learned. The legacy file's damage report, if any, rides along.
  const after = presented(await readKnowledgeFile(file, team), team);
  return legacyProblem ? { ...after, problem: after.problem ?? legacyProblem } : after;
}

export async function saveKnowledge(dir: string, knowledge: TeamKnowledge): Promise<void> {
  const file = knowledgeFile(dir, knowledge.team);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(knowledge, null, 2), 'utf8');
  await rename(temporary, file);
}

/**
 * One write at a time per team file. Every member of a team shares the graph and up to 8 run at once, so two Learn calls could read the same file, merge
 * separately, and the second write would silently lose the first addition (0.4.19 review). The queue is per file and lives in this process, which is where
 * every write comes from: one extension host.
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
 * Two locks, because they stop two different losses (0.4.19 review):
 *   - `serialised` orders the writes inside ONE extension host, so parallel team members never interleave a read and a write.
 *   - the compare-and-retry below covers OTHER processes: the team library is in globalStorage, so a second VS Code window has its own host and its own Map,
 *     and the two would otherwise read the same file, merge separately, and the second write would drop the first addition. Each attempt re-reads and checks
 *     that the file is still exactly what was read; if another window wrote in between, it merges again over the newer file.
 *
 * A damaged file is REPORTED once, on the graph the merge returns, rather than being overwritten in silence: the merge starts from an empty graph and writes
 * over the broken file, so without this the corruption was lost while the comment claimed it was surfaced.
 */
export async function addKnowledge(dir: string, team: string, addition: KnowledgeAddition): Promise<TeamKnowledge> {
  const file = knowledgeFile(dir, team);
  return serialised(file, async () => {
    let last: TeamKnowledge | undefined;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const before = await readFile(file, 'utf8').catch(() => undefined);
      const { knowledge, problem } = await loadKnowledge(dir, team);
      const merged = mergeKnowledge(knowledge, addition);
      // Write only if the file is still what was read. A rename is atomic, so a reader never sees half a file; this compares CONTENT, which is what another
      // window would have changed.
      const now = await readFile(file, 'utf8').catch(() => undefined);
      if (now !== before) { last = merged; continue; }
      await saveKnowledge(dir, merged);
      return problem ? { ...merged, problem } : merged;
    }
    // 0.4.19 review: this returned a merged graph that was never written, so Learn reported success for an addition that was lost. After the retries a last
    // write is attempted without the compare, so the caller's addition IS in the file even if another window is still busy.
    const final = last ?? mergeKnowledge((await loadKnowledge(dir, team)).knowledge, addition);
    await saveKnowledge(dir, final);
    return final;
  });
}

/**
 * Where a team's graph file is: `<dir>/knowledge/<slug>.json`, where slug is plain for a name that is already a lowercase slug and `<clean>~<hash>`
 * for everything else. Plain names use only `[a-z0-9-]` and hashed names carry the `~` no plain name can hold, so the mapping is injective: `acme co`,
 * `acme-co`, `ACME`, `..`, `../escape`, an accented name, the empty name, and the reviewer's adversarial team named after its own hash all land on
 * separate files, while a name cannot escape `<dir>/knowledge` (0.4.19 review). Before hashing, sanitising alone let two teams share one file and one
 * could read and write the other's graph.
 */
export const knowledgeFile = (dir: string, team: string): string => path.join(dir, 'knowledge', `${teamSlug(team)}.json`);

/**
 * What a run is told about the graph, and how to add to it. Short on purpose: it is a hint about a tool, not a second system prompt. The Admiralty
 * grading is spelled out because agents will not guess it, and ungraded knowledge is worth less than graded knowledge.
 */
export const KNOWLEDGE_INSTRUCTIONS = `# This team's knowledge graph
You share a knowledge graph with the rest of your team, and it is what the team knows about the world so far. Read it before researching: if it already answers the question, say so and cite the node instead of searching again. Add to it as you learn, with Remember-style facts, so the team is more useful next time.

Add to it only what you verified. Grade each piece with the Admiralty scale: reliability A (completely reliable) to F (cannot be trusted) for the source, and credibility 1 (confirmed by other sources) to 6 (impossible) for the information. A document the team wrote, or a vendor's own marketing, is not an A.

Extract actors (organisations, people, systems, documents, facts, places), what each does, and how they relate: the kind of relation, and its tension from -1 (hostile or contradictory) through 0 (neutral) to +1 (strongly supportive). State the basis for each relation. Leave the tension unset rather than guessing zero.`;
