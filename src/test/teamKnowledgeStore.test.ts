// The store that keeps a team's graph (owner, 2026-11-08). The blocker from review is what this test exists for: every member of a team shares one file
// and up to 8 run at once, so concurrent adds must not lose each other.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { addKnowledge, ForeignGraphError, knowledgeFile, loadKnowledge, saveKnowledge } from '../services/teamKnowledgeStore';
import { emptyKnowledge } from '../domain/teamKnowledge';

const at = '2026-11-08T10:00:00.000Z';
const addition = (label: string) => ({ origin: 'research' as const, at, nodes: [{ label }], edges: [] });

test('a team that has learned nothing reads as an empty graph, and a saved graph reads back', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-know-'));
  const empty = await loadKnowledge(dir, 'scouts');
  assert.deepEqual(empty.knowledge.nodes, []);
  assert.equal(empty.problem, undefined);
  const graph = await addKnowledge(dir, 'scouts', addition('Halden Ports'));
  assert.equal(graph.nodes.length, 1);
  const again = await loadKnowledge(dir, 'scouts');
  assert.equal(again.knowledge.nodes[0]?.label, 'Halden Ports');
});

test('two teams keep separate graphs, even with the same actor in both', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-know-'));
  await addKnowledge(dir, 'scouts', addition('Halden Ports'));
  const other = await loadKnowledge(dir, 'builders');
  assert.equal(other.knowledge.nodes.length, 0, 'one team does not see another team\'s knowledge');
});

test('eight members learning at the same moment all land, so no addition is silently lost', async () => {
  // The review's blocker: read-merge-write of the whole file with no lock, under parallel agents.
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-know-'));
  const labels = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
  await Promise.all(labels.map((label) => addKnowledge(dir, 'scouts', addition(label))));
  const { knowledge } = await loadKnowledge(dir, 'scouts');
  assert.deepEqual(knowledge.nodes.map((node) => node.label).sort(), [...labels].sort(), 'every concurrent addition is in the file');
});

test('a failed write does not block the next one, and a damaged file is reported rather than thrown away', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-know-'));
  await addKnowledge(dir, 'scouts', addition('alpha'));
  // A damaged file: reported, and the team carries on with an empty graph rather than crashing.
  const file = knowledgeFile(dir, 'scouts');
  await writeFile(file, '{ not json', 'utf8');
  const damaged = await loadKnowledge(dir, 'scouts');
  assert.match(damaged.problem ?? '', /could not be read/);
  assert.deepEqual(damaged.knowledge.nodes, []);
  // And a write still works afterwards.
  await addKnowledge(dir, 'scouts', addition('bravo'));
  const { knowledge } = await loadKnowledge(dir, 'scouts');
  assert.deepEqual(knowledge.nodes.map((node) => node.label), ['bravo']);
});

test('the graph file is named from the team, safe for a file system, and written atomically', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-know-'));
  await mkdir(path.dirname(knowledgeFile(dir, 'My Team/One')), { recursive: true });
  await saveKnowledge(dir, { ...emptyKnowledge('My Team/One', at), nodes: [] });
  const written = await readFile(knowledgeFile(dir, 'My Team/One'), 'utf8');
  assert.match(written, /"version": 1/);
  // A plain name keeps its plain slug; anything sanitised lands under the ~-separator no plain name can hold (0.4.19 review).
  assert.match(knowledgeFile(dir, 'My Team/One'), /my-team-one~[0-9a-f]{12}\.json$/);
});

test('two team names that sanitised to the same file now get their own, so one team cannot read or write another\'s graph', async () => {
  // 0.4.19 review: `team.replace(/[^a-z0-9-]+/gi,'-')` is lossy, so several DIFFERENT teams shared one graph file.
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-know-slug-'));
  const pairs: Array<[string, string]> = [
    ['acme co', 'acme-co'],
    ['Acme Co', 'acme_co'],
    ['..', '--'],
    ['../escape', 'escape'],
    ['café', 'cafe']
  ];
  for (const [one, two] of pairs) {
    assert.notEqual(knowledgeFile(dir, one), knowledgeFile(dir, two), `${JSON.stringify(one)} and ${JSON.stringify(two)} must not share a file`);
  }
  // And the file still stays inside <dir>/knowledge, so a name cannot escape the folder.
  const root = path.resolve(dir, 'knowledge');
  for (const team of ['..', '../escape', '../../etc/passwd', '..%2f..%2fx', 'a/../../b']) {
    assert.equal(path.dirname(path.resolve(knowledgeFile(dir, team))), root, `${JSON.stringify(team)} stays in the knowledge folder`);
  }
  // Prove it end to end: knowledge added by one is invisible to the other.
  await addKnowledge(dir, 'acme co', addition('Alpha'));
  await addKnowledge(dir, 'acme-co', addition('Bravo'));
  assert.deepEqual((await loadKnowledge(dir, 'acme co')).knowledge.nodes.map((node) => node.label), ['Alpha']);
  assert.deepEqual((await loadKnowledge(dir, 'acme-co')).knowledge.nodes.map((node) => node.label), ['Bravo']);
  // Case-only collisions too (ninth 0.4.19 review, MINOR): `ACME` and `acme` cleaned to the same lowercased slug before hashing, and the store-level gate —
  // not just the file names — has to keep their graphs apart. This is the remaining collision path after migration.
  await addKnowledge(dir, 'ACME', addition('Upper'));
  await addKnowledge(dir, 'acme', addition('Lower'));
  assert.deepEqual((await loadKnowledge(dir, 'ACME')).knowledge.nodes.map((node) => node.label), ['Upper']);
  assert.deepEqual((await loadKnowledge(dir, 'acme')).knowledge.nodes.map((node) => node.label), ['Lower']);
});

test('the migration reads nobody\'s graph but the team it belongs to', async () => {
  // 0.4.19 review BLOCKER: the legacy fallback read the OLD sanitised file for any non-plain name — which is the LIVE file of the plain team it used to
  // collide with — and copied that team's graph across. The fifteenth round reintroduced that leak by accepting the SLUG claim as proof (the slug is also
  // the plain team's identity); the sixteenth review named it a BLOCKER again, so migration is gated on the RAW NAME ONLY.
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-know-leak-'));
  await addKnowledge(dir, 'acme-co', addition('Bravo')); // the plain team's live graph, sitting at the legacy name of `acme co`
  // The slug identity matches (acme co's slug IS acme-co), and the graph is still NOT adopted: a slug stamp is not ownership.
  const notCopied = await loadKnowledge(dir, 'acme co', 'acme-co');
  assert.deepEqual(notCopied.knowledge.nodes, [], 'the plain team\'s graph is not copied into the hashed team\'s load');
  assert.deepEqual(notCopied.knowledge.team, 'acme co');
  assert.match(await readFile(knowledgeFile(dir, 'acme-co'), 'utf8'), /Bravo/, 'the plain team\'s file stays byte-for-byte in place');
  // A raw-name-stamped legacy file IS adopted: the file says this team's own name, which no other team can claim.
  const legacy = path.join(dir, 'knowledge', 'my-team.json');
  await mkdir(path.dirname(legacy), { recursive: true });
  await writeFile(legacy, JSON.stringify({ version: 1, team: 'My Team', nodes: [{ id: 'n1', label: 'Halden Ports', kind: 'actor', functions: [], facts: [], origin: 'research', firstSeen: at, lastSeen: at, mentions: 1 }], edges: [], updatedAt: at }), 'utf8');
  const own = await loadKnowledge(dir, 'My Team', 'my-team');
  assert.equal(own.knowledge.nodes.length, 1, 'a file stamped with the raw display name is adopted');
  assert.match(await readFile(knowledgeFile(dir, 'My Team'), 'utf8'), /Halden Ports/);
  // A foreign-claimed legacy file is set aside on READ (never adopted, never described as this team's retired knowledge) — and the loud refusal lives at the
  // WRITE gate, which looks at the caller's OWN current file: staging a stranger's claim THERE is what a Learn must refuse.
  const foreignDir = await mkdtemp(path.join(tmpdir(), 'near-ai-know-foreign-claim-'));
  const foreignFile = path.join(foreignDir, 'knowledge', 'my-team.json');
  await mkdir(path.dirname(foreignFile), { recursive: true });
  await writeFile(foreignFile, JSON.stringify({ version: 1, team: 'someone-else', nodes: [{ id: 'n2', label: 'Not Mine', kind: 'actor', functions: [], facts: [], origin: 'research', firstSeen: at, lastSeen: at, mentions: 1 }], edges: [], updatedAt: at }), 'utf8');
  const refused = await loadKnowledge(foreignDir, 'My Team', 'my-team');
  assert.deepEqual(refused.knowledge.nodes, [], 'a legacy file naming another team reads as no legacy graph');
  assert.deepEqual(refused.problem, undefined, 'a foreign claim is not described as this team\'s retired knowledge');
  assert.match(await readFile(foreignFile, 'utf8'), /Not Mine/, 'the foreign file is untouched by the read');
  const ownCurrent = knowledgeFile(foreignDir, 'My Team');
  await mkdir(path.dirname(ownCurrent), { recursive: true });
  await writeFile(ownCurrent, JSON.stringify({ version: 1, team: 'someone-else', nodes: [], edges: [], updatedAt: at }), 'utf8');
  await assert.rejects(() => addKnowledge(foreignDir, 'My Team', addition('Alpha'), 'my-team'), ForeignGraphError, 'the WRITE gate refuses a current file naming another team');
  assert.match(await readFile(ownCurrent, 'utf8'), /someone-else/, 'the refused current file is byte-for-byte untouched');
});

test('a slug-stamped 0.4.18 graph is retained, reported, and never copied — the honest upgrade cost', async () => {
  // The shipped version stamped files with the slug (`agentSession.ts` passed slugify(...)), so `My Team`'s 0.4.18 file says `my-team`. The sixteenth review's
  // BLOCKER says adopting it is a leak when the slug is another team's identity, and prescribes: gate on the raw name, leave the old file, SAY SO. This test
  // locks the "say so": the load reports the superseded graph instead of silently dropping the team's memory.
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-know-superseded-'));
  const legacy = path.join(dir, 'knowledge', 'my-team.json');
  await mkdir(path.dirname(legacy), { recursive: true });
  const older = { version: 1, team: 'my-team', nodes: [{ id: 'n1', label: 'Halden Ports', kind: 'actor', functions: [], facts: [], origin: 'research', firstSeen: at, lastSeen: at, mentions: 1 }], edges: [], updatedAt: at };
  await writeFile(legacy, JSON.stringify(older), 'utf8');
  const loaded = await loadKnowledge(dir, 'My Team', 'my-team');
  assert.deepEqual(loaded.knowledge.nodes, [], 'the slug-stamped graph is not adopted');
  assert.match(loaded.problem ?? '', /my-team/, 'the load SAYS the superseded graph exists, where it is, and why it was not copied');
  assert.match(await readFile(legacy, 'utf8'), /Halden Ports/, 'the superseded file is retained untouched, so the knowledge is recoverable');
  // And a Learn still lands in the team's own (hashed) file after the refusal — the upgrade does not stop the team working.
  const merged = await addKnowledge(dir, 'My Team', addition('Alpha'), 'my-team');
  assert.deepEqual(merged.nodes.map((node) => node.label), ['Alpha']);
  assert.match(await readFile(knowledgeFile(dir, 'My Team'), 'utf8'), /"team": "My Team"/, 'the new file is stamped with the raw name');
  assert.deepEqual(await loadKnowledge(dir, 'My Team', 'my-team').then((r) => r.knowledge.nodes.map((n) => n.label)), ['Alpha'], 'the new graph reads without re-importing the superseded one');
});

test('a foreign legacy file does not stop a team from learning into its own file', async () => {
  // Fifteenth 0.4.19 review, MAJOR: throwing made every later Learn die before its write, and the colliding team could never create its own file. Here the
  // legacy stamp claims another team entirely: the loader migrates nothing, `acme co` learns into its OWN hashed file, and the plain team's file — left
  // where it was — keeps its Bravo graph untouched.
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-know-foreign-legacy-'));
  await addKnowledge(dir, 'acme-co', addition('Bravo')); // the plain team's live graph, sitting at knowledge/acme-co.json
  const plain = knowledgeFile(dir, 'acme-co');
  const bytes = await readFile(plain, 'utf8');
  // A foreign-claimed legacy file: the plain stamp cannot belong to hashed `acme co`, so the loader migrates nothing, and the Learn lands in `acme co`'s
  // own hashed file next to it.
  await writeFile(plain, bytes.replace('"team": "acme-co"', '"team": "stranger"'), 'utf8');
  await assert.doesNotReject(() => addKnowledge(dir, 'acme co', addition('Alpha')), 'the colliding team can still learn into its own file');
  assert.deepEqual((await loadKnowledge(dir, 'acme co', 'acme-co')).knowledge.nodes.map((node) => node.label).sort(), ['Alpha'], 'the Learn went to the hashed file, not the plain team\'s');
  // The plain team's file is restored and byte-for-byte intact: its owner reads its own graph, and nothing of `acme co`'s leaked in.
  await writeFile(plain, bytes, 'utf8');
  assert.deepEqual((await loadKnowledge(dir, 'acme-co')).knowledge.nodes.map((node) => node.label), ['Bravo'], 'the plain team still reads only its own graph');
  assert.equal(await readFile(plain, 'utf8'), bytes, 'nothing was destroyed');
});

test('the legacy file survives migration in place, untouched', async () => {
  // Fifteenth 0.4.19 review: with the slug identity accepted, the legacy path can be another LIVE team's file (`acme-co.json` is plain team `acme-co`'s
  // graph while it is also hashed `acme co`'s legacy path), and no inference tells those apart — so migration adopts WITHOUT retiring: no rename, no rm.
  // (The twelfth-review worry about a retained legacy file making a plain team's path foreign forever is answered differently now: the gate accepts the
  // slug stamp, so the plain team still owns its file — it is no longer refused.)
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-know-backup-'));
  const legacy = path.join(dir, 'knowledge', 'my-team.json');
  await mkdir(path.dirname(legacy), { recursive: true });
  const older = { version: 1, team: 'My Team', nodes: [{ id: 'n1', label: 'Halden Ports', kind: 'actor', functions: [], facts: [], origin: 'research', firstSeen: at, lastSeen: at, mentions: 1 }], edges: [], updatedAt: at };
  await writeFile(legacy, JSON.stringify(older), 'utf8');
  await loadKnowledge(dir, 'My Team', 'my-team');
  assert.match(await readFile(knowledgeFile(dir, 'My Team'), 'utf8'), /Halden Ports/, 'the graph lives under the new name');
  assert.equal(await readFile(legacy, 'utf8'), JSON.stringify(older), 'the original file is byte-for-byte untouched, still there for its other reader');
});

test('a team named to imitate a hashed file still cannot share it, and no name maps to team.json', () => {
  // 0.4.19 review MAJOR: hashing only when the clean differs let a team literally named `acme-co-<hash of "acme co">` keep a plain slug that collided with
  // `acme co`'s hashed file. Plain names are [a-z0-9-] only and hashed names carry `~`, which no plain name contains — and `~` cannot appear IN the hash
  // either, so plain and hashed spaces are disjoint.
  const dir = path.join(tmpdir(), 'near-ai-know-adv-');
  const impersonator = `acme-co-${createHash('sha256').update('acme co').digest('hex').slice(0, 12)}`;
  assert.notEqual(knowledgeFile(dir, impersonator), knowledgeFile(dir, 'acme co'), 'the impersonating plain name does not reach the hashed file');
  assert.match(knowledgeFile(dir, impersonator), /knowledge[/\\]acme-co-[0-9a-f]{12}\.json$/, 'it is a plain name, so it keeps a plain file');
  assert.match(knowledgeFile(dir, 'acme co'), /~/, 'the sanitised name is the hashed one');
  // The empty name no longer falls back to the shared `team.json` (0.4.19 review MINOR).
  assert.notEqual(knowledgeFile(dir, ''), knowledgeFile(dir, 'team'));
  assert.match(knowledgeFile(dir, ''), /~[0-9a-f]{12}\.json$/, 'the empty name is hashed like any other');
});

test('a plain team name keeps its existing file, so a graph already on disk is still found', () => {
  const dir = path.join(tmpdir(), 'near-ai-know-plain-');
  assert.match(knowledgeFile(dir, 'scouts'), /knowledge[/\\]scouts\.json$/);
  // A name every caller already slugifies stays the plain slug; a lossy one is disambiguated, never silently shared.
  assert.match(knowledgeFile(dir, 'my-team'), /my-team\.json$/);
  assert.match(knowledgeFile(dir, 'My Team/One'), /my-team-one~[0-9a-f]{12}\.json$/);
});

test('a large graph is read, not refused: a knowledge graph accumulates', async () => {
  // With no graph ceiling there is no byte ceiling either: refusing a big file would reset a team's memory to empty, which is worse than a slow read.
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-know-big-'));
  const file = knowledgeFile(dir, 'scouts');
  await mkdir(path.dirname(file), { recursive: true });
  const nodes = Array.from({ length: 5_000 }, (_, index) => ({ id: `n${index}`, label: `actor ${index}`, kind: 'actor', functions: [], facts: [], origin: 'research', firstSeen: at, lastSeen: at, mentions: 1 }));
  await writeFile(file, JSON.stringify({ version: 1, team: 'scouts', nodes, edges: [], updatedAt: at }), 'utf8');
  const loaded = await loadKnowledge(dir, 'scouts');
  assert.equal(loaded.problem, undefined, 'a big graph is not a problem');
  assert.equal(loaded.knowledge.nodes.length, 5_000, 'and nothing is dropped');
});

test("a graph written under the old file name is found and moved, so an upgrade does not lose a team's memory", async () => {
  // The review's blocker: the injective slug renamed every file whose team name was not already a plain lowercase slug, so `My Team` looked for a file that
  // did not exist and the team silently started with nothing.
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-know-legacy-'));
  const legacy = path.join(dir, 'knowledge', 'my-team.json');
  await mkdir(path.dirname(legacy), { recursive: true });
  const older = { version: 1, team: 'My Team', nodes: [{ id: 'n1', label: 'Halden Ports', kind: 'actor', functions: [], facts: [], origin: 'research', firstSeen: at, lastSeen: at, mentions: 1 }], edges: [], updatedAt: at };
  await writeFile(legacy, JSON.stringify(older), 'utf8');
  const loaded = await loadKnowledge(dir, 'My Team');
  assert.equal(loaded.knowledge.nodes.length, 1, 'the existing graph is read from the old name');
  assert.equal(loaded.knowledge.nodes[0]?.label, 'Halden Ports');
  assert.notEqual(knowledgeFile(dir, 'My Team'), legacy);
  assert.match(await readFile(knowledgeFile(dir, 'My Team'), 'utf8'), /Halden Ports/);
});

test("the migration runs through addKnowledge too, where the write queue is already held, and does not deadlock", async () => {
  // Fourth 0.4.19 review, MINOR: the deadlock-avoidance claim — addKnowledge holds the per-file queue and loadKnowledge must not re-enter it — was stated
  // in a comment and never executed. This is the path a run actually takes on first Learn after upgrade.
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-know-legacy-add-'));
  const legacy = path.join(dir, 'knowledge', 'my-team.json');
  await mkdir(path.dirname(legacy), { recursive: true });
  await writeFile(legacy, JSON.stringify({ version: 1, team: 'My Team', nodes: [{ id: 'n1', label: 'Halden Ports', kind: 'actor', functions: [], facts: [], origin: 'research', firstSeen: at, lastSeen: at, mentions: 1 }], edges: [], updatedAt: at }), 'utf8');
  const merged = await Promise.race([
    addKnowledge(dir, 'My Team', addition('Alpha')),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('deadlocked: migration re-entered the write queue')), 5_000))
  ]);
  assert.deepEqual(merged.nodes.map((node) => node.label).sort(), ['Alpha', 'Halden Ports'], 'the legacy graph and the new addition both landed');
  assert.match(await readFile(knowledgeFile(dir, 'My Team'), 'utf8'), /Halden Ports/);
});

test('a write from another window is merged, not overwritten', async () => {
  // The review's finding: the in-process lock cannot see a second VS Code window, which has its own extension host and its own Map. Simulated here by writing
  // the file from "outside" between this process's read and its write, which is exactly what the other window does.
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-know-cross-'));
  await addKnowledge(dir, 'scouts', addition('alpha'));
  const file = knowledgeFile(dir, 'scouts');
  const before = JSON.parse(await readFile(file, 'utf8'));
  // Another window adds "bravo" and writes the whole file.
  const other = { ...before, nodes: [...before.nodes, { id: 'x', label: 'bravo', kind: 'actor', functions: [], facts: [], origin: 'research', firstSeen: at, lastSeen: at, mentions: 1 }] };
  await writeFile(file, JSON.stringify(other), 'utf8');
  // This window now adds "charlie"; its read already happened, so without the retry it would write a graph holding only alpha and charlie.
  await addKnowledge(dir, 'scouts', addition('charlie'));
  const { knowledge } = await loadKnowledge(dir, 'scouts');
  const labels = knowledge.nodes.map((node) => node.label).sort();
  assert.deepEqual(labels, ['alpha', 'bravo', 'charlie'], `the other window's addition survives: ${JSON.stringify(labels)}`);
});

test('addKnowledge refuses to write over a file that names another team, so the record survives for its owner', async () => {
  // Twelfth 0.4.19 review, BLOCKER: the "belongs to another team" branch returned an empty graph and a problem, and the NEXT addKnowledge merged into that
  // empty graph and SAVED — destroying the plain team's record before its own load could migrate it. The refusal is enforced at the write; on the READ side
  // the same file reads as a problem-carrying empty graph instead of a throw (sixteenth 0.4.19 review, MAJOR — unchanged consumers like Team Studio's
  // knowledge view call the loader without a catch), and the plain team's file is byte-for-byte what it was either way.
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-know-foreign-'));
  await addKnowledge(dir, 'acme-co', addition('Bravo'));
  const plain = knowledgeFile(dir, 'acme-co');
  const bytes = await readFile(plain, 'utf8');
  // The caller IS plain team `acme-co`, and the file on its own path names someone else: the gate refuses anything that is not this caller's raw name.
  await writeFile(plain, bytes.replace('"team": "acme-co"', '"team": "someone-else"'), 'utf8');
  const readBack = await loadKnowledge(dir, 'acme-co', 'acme-co');
  assert.deepEqual(readBack.knowledge.nodes, [], 'the loader does not serve a foreign CURRENT file');
  assert.match(readBack.problem ?? '', /belongs to someone-else/, 'and says why it read nothing');
  await assert.rejects(() => addKnowledge(dir, 'acme-co', addition('Alpha'), 'acme-co'), ForeignGraphError, 'a Learn into a foreign file throws instead of overwriting');
  assert.equal(await readFile(plain, 'utf8'), bytes.replace('"team": "acme-co"', '"team": "someone-else"'), 'the refused file is byte-for-byte unchanged');
});
