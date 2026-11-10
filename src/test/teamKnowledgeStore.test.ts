// The store that keeps a team's graph (owner, 2026-11-08). The blocker from review is what this test exists for: every member of a team shares one file
// and up to 8 run at once, so concurrent adds must not lose each other.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { addKnowledge, knowledgeFile, loadKnowledge, saveKnowledge } from '../services/teamKnowledgeStore';
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

test('a failed write does not block the next one, and a damaged file is reported and kept aside rather than thrown away', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-know-'));
  await addKnowledge(dir, 'scouts', addition('alpha'));
  // A damaged file: reported, and the team carries on with an empty graph rather than crashing.
  const file = knowledgeFile(dir, 'scouts');
  await writeFile(file, '{ not json', 'utf8');
  const damaged = await loadKnowledge(dir, 'scouts');
  assert.match(damaged.problem ?? '', /could not be read/);
  assert.deepEqual(damaged.knowledge.nodes, []);
  // A write still works afterwards, and the unreadable file is copied aside first, so what it held can still be recovered by hand.
  const rebuilt = await addKnowledge(dir, 'scouts', addition('bravo'));
  assert.match(rebuilt.problem ?? '', /kept as scouts\.damaged-.+\.json/);
  const { knowledge } = await loadKnowledge(dir, 'scouts');
  assert.deepEqual(knowledge.nodes.map((node) => node.label), ['bravo']);
  const kept = (await readdir(path.dirname(file))).filter((name) => name.startsWith('scouts.damaged-'));
  assert.equal(kept.length, 1);
  assert.equal(await readFile(path.join(path.dirname(file), kept[0]!), 'utf8'), '{ not json');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).problem, undefined, 'the problem is reported, never written into the file');
});

test('the graph file is named from the team, safe for a file system, and written atomically', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-know-'));
  await mkdir(path.dirname(knowledgeFile(dir, 'My Team/One')), { recursive: true });
  await saveKnowledge(dir, { ...emptyKnowledge('My Team/One', at), nodes: [] });
  const written = await readFile(knowledgeFile(dir, 'My Team/One'), 'utf8');
  assert.match(written, /"version": 1/);
  // A plain name keeps its plain slug; anything sanitised lands under the ~-separator no plain name can hold.
  assert.match(knowledgeFile(dir, 'My Team/One'), /my-team-one~[0-9a-f]{12}\.json$/);
});

test('two keys that would sanitise to the same file get their own, so one team cannot read or write another\'s graph', async () => {
  // Callers pass a team's slug, which is already plain; the file name is injective anyway, so a key that is not plain can never land on another's file.
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
  // Case-only names too: `ACME` and `acme` would clean to the same lowercased slug.
  await addKnowledge(dir, 'ACME', addition('Upper'));
  await addKnowledge(dir, 'acme', addition('Lower'));
  assert.deepEqual((await loadKnowledge(dir, 'ACME')).knowledge.nodes.map((node) => node.label), ['Upper']);
  assert.deepEqual((await loadKnowledge(dir, 'acme')).knowledge.nodes.map((node) => node.label), ['Lower']);
});


test('a team named to imitate a hashed file still cannot share it, and no name maps to team.json', () => {
  // Plain names are [a-z0-9-] only and hashed names carry `~`, which no plain name contains, so the two spaces are disjoint.
  const dir = path.join(tmpdir(), 'near-ai-know-adv-');
  const impersonator = `acme-co-${createHash('sha256').update('acme co').digest('hex').slice(0, 12)}`;
  assert.notEqual(knowledgeFile(dir, impersonator), knowledgeFile(dir, 'acme co'), 'the impersonating plain name does not reach the hashed file');
  assert.match(knowledgeFile(dir, impersonator), /knowledge[/\\]acme-co-[0-9a-f]{12}\.json$/, 'it is a plain name, so it keeps a plain file');
  assert.match(knowledgeFile(dir, 'acme co'), /~/, 'the sanitised name is the hashed one');
  // The empty name does not fall back to a shared `team.json`.
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

test('a 0.4.18 graph is found where it was written, with no migration, and an agent\'s old A1 is read back at the ceiling', async () => {
  // 0.4.18 keyed the file by the team slug and stamped the slug as its team; that is still the key, so nothing moves on upgrade.
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-know-0418-'));
  const file = path.join(dir, 'knowledge', 'near-ai-scouts.json');
  await mkdir(path.dirname(file), { recursive: true });
  const old = {
    version: 1, team: 'near-ai-scouts', updatedAt: at,
    nodes: [{ id: 'n1', label: 'Halden Ports', kind: 'organisation', functions: [], origin: 'research', firstSeen: at, lastSeen: at, mentions: 1, grading: { reliability: 'A', credibility: 1 },
      facts: [{ text: 'Handled 4.2 million TEU', origin: 'research', source: 'https://evil.test', grading: { reliability: 'A', credibility: 1 } }] }],
    edges: []
  };
  await writeFile(file, JSON.stringify(old), 'utf8');
  assert.equal(knowledgeFile(dir, 'near-ai-scouts'), file);
  const { knowledge, problem } = await loadKnowledge(dir, 'near-ai-scouts');
  assert.equal(problem, undefined);
  assert.equal(knowledge.nodes[0]?.label, 'Halden Ports');
  assert.deepEqual(knowledge.nodes[0]?.grading, { reliability: 'C', credibility: 3 });
  assert.deepEqual(knowledge.nodes[0]?.facts[0]?.grading, { reliability: 'C', credibility: 3 });
});
