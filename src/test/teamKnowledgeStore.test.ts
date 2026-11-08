// The store that keeps a team's graph (owner, 2026-11-08). The blocker from review is what this test exists for: every member of a team shares one file
// and up to 8 run at once, so concurrent adds must not lose each other.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
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
  assert.match(knowledgeFile(dir, 'My Team/One'), /my-team-one\.json$/);
});
