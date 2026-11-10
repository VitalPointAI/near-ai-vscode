// Where a team's knowledge graph lives, and how the agent adds to it during a run (owner, 2026-11-08: "each team needs to learn over time and have its
// own shared context graph of knowledge to draw from. Any research it does or any information it's given by those it interacts with should be added to
// the graph").
//
// One file per team under the team library's own storage, beside the team files: <teams>/knowledge/<slug>.json. A team is its file, so its knowledge
// travels with it and two teams never share a map. Writes are whole-file and atomic, and a damaged file is reported rather than thrown away silently.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
    // A file whose team field is missing or not a string is DAMAGED, not foreign (thirteenth 0.4.19 review, MINOR): ownership unknown is a read problem with
    // a recovery path, not a refusal — reporting it lets the migration or rebuild proceed instead of stranding the graph forever.
    if (typeof parsed.team !== 'string' || !parsed.team) throw new Error('the graph does not name its team');
    return { knowledge: parsed };
  } catch (error) {
    // The graph is a record of what the team learned, so a damaged one is reported but must not stop the team working.
    return { problem: `The knowledge graph for ${team} could not be read (${(error as Error).message}). It will be rebuilt as the team works.` };
  }
}

/** Thrown when a team's graph file names a DIFFERENT team: the caller must not read it as its own and must never write over it (twelfth 0.4.19 review). */
export class ForeignGraphError extends Error {
  constructor(readonly file: string, readonly owner: string, readonly requester: string) {
    super(`The knowledge file ${path.basename(file)} belongs to ${owner}, not ${requester}; nothing was read for ${requester} and nothing was written over it.`);
  }
}

/** What a caller always gets: the graph read from disk stamped with the team that asked, or an empty one when nothing readable is there. */
const presented = (read: { knowledge?: TeamKnowledge; problem?: string }, team: string): { knowledge: TeamKnowledge; problem?: string } => ({
  knowledge: read.knowledge ? { ...read.knowledge, team } : emptyKnowledge(team, new Date().toISOString()),
  ...(read.problem ? { problem: read.problem } : {})
});

/** Whether the file at `path` exists and names a DIFFERENT team: the one state a write must never touch. */
const foreignOwner = async (file: string, team: string): Promise<string | undefined> => {
  const text = await readFile(file, 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as TeamKnowledge;
    return parsed.version === 1 && typeof parsed.team === 'string' && parsed.team !== team ? parsed.team : undefined;
  } catch {
    return undefined; // unreadable: ownership unknown, handled by the damage path, not this one
  }
};

/**
 * The graph for a team, or an empty one when it has not learned anything yet.
 *
 * The file name changed when teamSlug became injective, so this falls back to the OLD name: without that, every existing team whose name is not already a
 * plain lowercase slug (`My Team` was `my-team.json`) would lose its memory on upgrade, because the new path would simply not exist (0.4.19 review). The
 * legacy graph is read and written back under the new name, so the migration happens once and the old file is left as a backup.
 */
/** The whole graph as one addition, so a raced migration can merge a legacy file into a graph another window has just created (see loadKnowledge). Each fact
  * keeps its own source AND its own grade (tenth 0.4.19 review, MAJOR): the merge stamps a node's grade onto its unsourced facts, so dropping the fact-level
  * grade let a legacy fact already capped to C3 come back at the actor's A1 — a grade rising through migration, the invariant this file exists to hold. Edge
  * endpoints resolve through a label map built once rather than a find per edge (sixth 0.4.19 review, MINOR — quadratic on a large graph). Provenance reads as
  * `seed`, the honest mark for knowledge that arrived by migration rather than by a run. */
const additionOf = (graph: TeamKnowledge): KnowledgeAddition => {
  const labelOf = new Map(graph.nodes.map((node) => [node.id, node.label]));
  return {
    origin: 'seed',
    at: new Date().toISOString(),
    nodes: graph.nodes.map((node) => ({
      label: node.label,
      ...(node.kind !== 'actor' ? { kind: node.kind } : {}),
      functions: node.functions,
      facts: node.facts.map((fact) => ({ text: fact.text, ...(fact.grading ? { grading: fact.grading } : {}), ...(fact.since ? { since: fact.since } : {}), ...(fact.source ? { source: fact.source } : {}) })),
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

export async function loadKnowledge(dir: string, team: string, slug?: string): Promise<{ knowledge: TeamKnowledge; problem?: string }> {
  // The slug is accepted but no longer PROVES ownership (sixteenth 0.4.19 review, BLOCKER): 0.4.18 stamped files with the slug, but the legacy file of a
  // non-plain name is ALSO the live file of the plain team that slug still names, so treating a slug claim as proof copies one team's graph into another.
  // Ownership is judged on the RAW name alone; a slug-only claim is a SUPERSEDED graph the loader leaves exactly where it is and reports as retired.
  const file = knowledgeFile(dir, team);
  const legacy = legacyKnowledgeFile(dir, team);
  const read = await readKnowledgeFile(file, team);
  // The identity gate is not only a migration concern (tenth 0.4.19 review, MINOR): a PLAIN team's file was written by whichever colliding name touched it
  // last under the old lossy slug, so a file that names someone else is not this team's record and is not served to it — the caller gets an empty graph and
  // the file is left for its real owner. An unreadable file reports and rebuilds, as before. The claim names THIS team or it does not; no second identity
  // softens that (sixteenth 0.4.19 review, BLOCKER).
  const owns = read.knowledge === undefined || read.knowledge.team === team;
  const current = presented(owns ? read : {}, team);
  if (!owns) {
    // Not served the file, and never written over it either: addKnowledge refuses through the same gate (twelfth 0.4.19 review, BLOCKER). The refusal is
    // NOT a thrown error (sixteenth 0.4.19 review, MAJOR): unchanged consumers (Team Studio's knowledge view) call the loader without a catch and a throw
    // failed the page hard, so the caller gets a problem-carrying empty graph it can show — and the WRITE side still refuses loudly.
    return { ...current, problem: `The knowledge file ${path.basename(file)} belongs to ${read.knowledge!.team}, not ${team}; nothing was read for ${team} and nothing was written over it.` };
  }
  // 0.4.19 review: the gate was "the new graph has nodes", which made a legitimately EMPTIED new graph re-import the old file's nodes on every load. The
  // gate is now "the new file exists AND READS" (twelfth 0.4.19 review, MINOR) — a damaged new file would otherwise block adoption forever — and the READ
  // RESULT is what decides, not a second stat (fourteenth 0.4.19 review, MINOR): existsSync followed by a separate read raced a concurrent create between
  // them, and the wx path then reported "could not be moved" after a write that had succeeded.
  if ((read.knowledge !== undefined) || file === legacy) return current;
  const older = await readKnowledgeFile(legacy, team);
  const legacyGraph = older.knowledge;
  let mergedProblem: string | undefined = undefined;
  // Identity check before adopting (0.4.19 review): the legacy file of a NON-plain name is also the LIVE file of a plain team (`acme co` once sanitised to
  // `acme-co.json`, which is team `acme-co`'s graph). Only a file naming THIS TEAM BY ITS RAW NAME is adopted — never a slug claim (sixteenth 0.4.19 review,
  // BLOCKER): the slug is exactly what 0.4.18 stamped AND exactly who the plain team is, so accepting it migrated one team's graph into the other's, the
  // leak the twelfth review closed and the fifteenth round reopened. A slug-only or foreign claim is set aside as "no legacy graph" rather than thrown
  // (fifteenth 0.4.19 review, MAJOR): the throw made every later Learn die before its write, and the colliding team could never create its own file. The
  // slug-stamped superseded graph is RETAINED untouched, the honest upgrade cost: nobody's memory is copied across teams, and the slug-mismatched teams keep
  // reading theirs (the raw-name slug of a plain slug IS its name; only a non-plain name loses its file, per its problem note).
  if (legacyGraph !== undefined && legacyGraph.team !== team) {
    // Treating a foreign LEGACY file as "no legacy graph" rather than throwing (fifteenth 0.4.19 review, MAJOR): the throw made every later Learn of the
    // hashed name merge into an empty graph and save over the plain team's record, and the colliding team could then never create its own file. The write
    // below is already gated on this team's OWN distinct path (knowledgeFile), so the plain team's file is safe either way — proceeding is the honest read.
    // The SUPERSUDED note (sixteenth 0.4.19 review, BLOCKER, "say so"): a slug-stamped file IS this team's 0.4.18 record — not adopted because the slug is
    // also another team's identity, and the person has to know the knowledge is still there, one file rename away, rather than silently gone.
    const superseded = slug !== undefined && slug !== team && legacyGraph.team === slug;
    return { ...current, ...(superseded ? { problem: `The knowledge graph for ${team} was written under its older slug name (${slug}), which now belongs to another team's file name, so it was left in place rather than copied. Nothing was lost: the file still holds the team's knowledge as of 0.4.18.` } : {}) };
  }
  if (!legacyGraph?.nodes.length) return current;
  // A legacy file that parsed damaged carries its problem forward (eighth 0.4.19 review, MINOR): the caller is adopting whatever readable parts survived,
  // and it must be told the record it came from was not whole — the previous code reported this and the identity-gate rewrite dropped it.
  let legacyProblem = older.problem;
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
        await writeFile(file, JSON.stringify({ ...legacyGraph, team }, null, 2), { flag: 'wx' });
        // Exclusive-create succeeded, so the legacy record now lives under the new name, stamped with the RAW name (sixteenth 0.4.19 review, MAJOR): the
        // unstamped return wrote the old claim back, and any later load without a slug refused the file the migration itself had just written. The old
        // file is LEFT WHERE IT IS — never renamed, never deleted: the legacy path can be another LIVE team's file (`acme-co.json` is plain team
        // `acme-co`'s graph even while it is hashed `acme co`'s legacy path), and no inference this code can make tells those apart — so retiring the
        // file by either name strands its other reader. The re-import on every load is bounded (the merge dedupes) and the durable original costs nothing.
        return { knowledge: { ...legacyGraph, team }, ...(legacyProblem ? { problem: legacyProblem } : {}) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        return { knowledge: { ...legacyGraph, team }, problem: `The knowledge graph for ${team} could not be moved to its new file name (${(error as Error).message}). The old file is untouched and will be tried again.` };
      }
    }
    const newerRead = await readKnowledgeFile(file, team);
    // A DAMAGED new file is reported, not silently replaced (eleventh 0.4.19 review, MINOR): the merge below rebuilds over it, and the caller must know the
    // graph it is shown was reconstructed, not read. The damage report rides the returned read (thirteenth 0.4.19 review, MINOR).
    const newer = presented(newerRead, team);
    const merged = withLegacyHistory(mergeKnowledge(newer.knowledge, additionOf(legacyGraph)), legacyGraph);
    const now = await readFile(file, 'utf8').catch(() => undefined);
    if (now !== before) continue;
    // The compare-and-retry protects the READ, and the temp-then-rename narrows the WRITE window (twelfth 0.4.19 review, MINOR): a rename can still land on a
    // file another window changed in the microseconds between the guard read and the rename — POSIX offers no atomic compare-and-rename — so the comment no
    // longer claims the window is closed, only narrowed to the rename syscall itself. A clobber there is bounded to one merge cycle and both graphs survive
    // in the retry loop's re-read; the honest alternative was a lock file protocol across processes, which is a larger change than a review round.
    const temporary = `${file}.${process.pid}.mig.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ ...merged, team }, null, 2), 'utf8');
      // Re-read immediately before the rename; a change in between restarts the attempt. (The window between this read and the rename is narrowed to the
      // syscall itself — see the comment above.)
      const guard = await readFile(file, 'utf8').catch(() => undefined);
      if (guard !== now) continue;
      try {
        await rename(temporary, file);
        // The migration is DONE once this lands: the new file holds the merged graph, and the legacy file is LEFT WHERE IT IS — never renamed, never deleted
        // (fifteenth 0.4.19 review). With the slug identity accepted, the legacy path can be another live team's file, and retiring it by either name
        // strands that team on its next load — deleting on an inference re-runs the twelfth-review clobber on a file that may never have been ours. The
        // re-import on each load is bounded (the merge dedupes; once a live NEW file exists this whole branch is skipped) and the original is retained.
      } catch (error) {
        mergedProblem = `The knowledge graph for ${team} could not be written (${(error as Error).message}). The addition may be lost when this window closes.`;
      }
    } catch (error) {
      mergedProblem = `The knowledge graph for ${team} could not be written (${(error as Error).message}). The addition may be lost when this window closes.`;
    } finally {
      // The temp file never outlives the attempt, whichever path it took (tenth 0.4.19 review, MINOR): a leftover *.mig.tmp is one more file a person has
      // to wonder about, and the next attempt writes a fresh one anyway.
      await rm(temporary, { force: true });
    }
    // Return the MERGED graph (second 0.4.19 review, MAJOR): the caller asked for this team's knowledge now, and after the merge that is the concurrent
    // window's graph plus the legacy one — returning the pre-merge snapshot would hide nodes another window already learned. The graph is stamped with the
    // REQUESTING team (ninth 0.4.19 review, MINOR): a mismatched claim inside the merged file would fail the identity gate on every later load.
    return { knowledge: { ...merged, team }, ...(mergedProblem || legacyProblem || newer.problem ? { problem: mergedProblem ?? newer.problem ?? legacyProblem } : {}) };
  }
  // The retry budget ran out without a confirmed write: re-read whatever IS on disk now (sixth 0.4.19 review, MINOR) rather than presenting a legacy snapshot
  // that may hold less than another window has already learned. The legacy file's damage report, if any, rides along. The SAME ownership gate runs here as at
  // the top of the function (fifteenth 0.4.19 review, MINOR): the file can have been re-pointed at another team by a concurrent writer while the budget was
  // burning, and a fallback read bypassing the gate would serve that team's record stamped with THIS caller's name — refused the same non-throwing way.
  const reRead = await readKnowledgeFile(file, team);
  const stillOwns = reRead.knowledge === undefined || reRead.knowledge.team === team;
  const after = presented(stillOwns ? reRead : {}, team);
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
export async function addKnowledge(dir: string, team: string, addition: KnowledgeAddition, slug?: string): Promise<TeamKnowledge> {
  const file = knowledgeFile(dir, team);
  return serialised(file, async () => {
    // The ownership gate FIRST (twelfth 0.4.19 review, BLOCKER): an existing file naming another team is never read as ours and never overwritten — the
    // throw stops the merge before any write, and a Learn into a mis-stamped file fails loudly instead of destroying it. The claim names THIS team or the
    // write refuses; no slug identity softens it (sixteenth 0.4.19 review, BLOCKER). The loader returns the same refusal as a problem-carrying empty graph
    // instead of a throw (sixteenth 0.4.19 review, MAJOR), so readers without a catch survive; a WRITER refusing loudly is deliberate — silent no-op writes
    // are how records got destroyed before the gate existed.
    const owner = await foreignOwner(file, team);
    if (owner !== undefined && owner !== team) throw new ForeignGraphError(file, owner, team);
    let last: TeamKnowledge | undefined;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const before = await readFile(file, 'utf8').catch(() => undefined);
      const { knowledge, problem } = await loadKnowledge(dir, team, slug);
      const merged = mergeKnowledge(knowledge, addition);
      // Write only if the file is still what was read. A rename is atomic, so a reader never sees half a file; this compares CONTENT, which is what another
      // window would have changed.
      const now = await readFile(file, 'utf8').catch(() => undefined);
      if (now !== before) { last = merged; continue; }
      await saveKnowledge(dir, merged);
      return problem ? { ...merged, problem } : merged;
    }
    // 0.4.19 review: this returned a merged graph that was never written, so Learn reported success for an addition that was lost. After the retries a last
    // write is attempted without the compare, so the caller's addition IS in the file even if another window is still busy. The slug rides along so a
    // first-ever write still reads the legacy fallback the same way the loop's loads did (sixteenth 0.4.19 review).
    const final = last ?? mergeKnowledge((await loadKnowledge(dir, team, slug)).knowledge, addition);
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
