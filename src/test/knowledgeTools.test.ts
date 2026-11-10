// The Learn and TeamKnowledge tools (owner, 2026-11-08). The grading rules are what agents get wrong, so they are checked here rather than trusted: a bad
// Admiralty grade is refused, an out-of-range tension is kept and clamped, and a relation whose ends are missing is dropped by the merge.
import assert from 'node:assert/strict';
import test from 'node:test';
import { knowledgeTools } from '../agent/knowledgeTools';
import { emptyKnowledge, mergeKnowledge, type KnowledgeAddition, type TeamKnowledge } from '../domain/teamKnowledge';

function tools(start = emptyKnowledge('scouts', '2026-11-08T10:00:00.000Z'), origin: 'research' | 'interaction' = 'research') {
  let graph = start;
  const added: KnowledgeAddition[] = [];
  const [lookup, learn] = knowledgeTools({
    read: async () => graph,
    add: async (addition) => { added.push(addition); graph = mergeKnowledge(graph, addition); return graph; }
  }, origin);
  return { lookup: lookup!, learn: learn!, added, graph: () => graph };
}

const honest = {
  nodes: [
    { label: 'Halden Ports', kind: 'organisation', functions: ['issues certifications'], facts: [{ text: 'Certifies marine equipment.', source: 'Certification register, 2026-10-02' }, { text: 'Certifies marine equipment.' }], grading: { reliability: 'A', credibility: 1 } },
    { label: 'Ministry of Trade', kind: 'organisation' }
  ],
  edges: [{ from: 'Ministry of Trade', to: 'Halden Ports', kind: 'regulates', tension: -0.7, basis: 'fined twice', grading: { reliability: 'B', credibility: 2 } }]
};

test('Learn stores actors, their functions, and each fact once, with the grade of the evidence', async () => {
  const kit = tools();
  const input = kit.learn.parse(honest as never);
  assert.equal(input.origin, 'research', 'a run writes as research');
  await kit.learn.run(input, {} as never);
  const graph = kit.graph();
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.nodes[0]?.functions[0], 'issues certifications');
  assert.equal(graph.nodes[0]?.facts.length, 1, 'the repeated fact is stored once');
  assert.deepEqual(graph.nodes[0]?.grading, { reliability: 'C', credibility: 3 }, 'the agent claimed A1; it is stored at the ceiling');
  assert.equal(graph.edges[0]?.tension, -0.7);
});

test('an Admiralty grade that is not on the scale is refused, rather than stored as nonsense', () => {
  const kit = tools();
  assert.throws(() => kit.learn.parse({ nodes: [{ label: 'X', grading: { reliability: 'Z', credibility: 1 } }] } as never), /A to F/);
  assert.throws(() => kit.learn.parse({ nodes: [{ label: 'X', grading: { reliability: 'A', credibility: 9 } }] } as never), /1 to 6/);
  // A grade that is absent is fine: ungraded knowledge is allowed, and shown as ungraded.
  assert.equal(kit.learn.parse({ nodes: [{ label: 'X' }] } as never).nodes[0]?.grading, undefined);
});

test('a tension out of range is kept and clamped, and no tension stays unmeasured rather than becoming neutral', async () => {
  const kit = tools();
  const input = kit.learn.parse({ nodes: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], edges: [{ from: 'A', to: 'B', tension: 4 }, { from: 'A', to: 'C' }] } as never);
  await kit.learn.run(input, {} as never);
  const graph = kit.graph();
  assert.equal(graph.edges.find((edge) => edge.to === graph.nodes.find((node) => node.label === 'B')?.id)?.tension, 1);
  assert.equal(graph.edges.find((edge) => edge.to === graph.nodes.find((node) => node.label === 'C')?.id)?.tension, null);
});

test('a relation to an actor that is not in the graph is dropped, so the drawing never has a dangling line', async () => {
  const kit = tools();
  const input = kit.learn.parse({ nodes: [{ label: 'A' }], edges: [{ from: 'A', to: 'Ghost', kind: 'supplies' }] } as never);
  await kit.learn.run(input, {} as never);
  assert.equal(kit.graph().edges.length, 0);
});

test('an empty graph says so, and a full lookup names the actor, its grade, its facts and both directions of each relation', async () => {
  const empty = tools();
  assert.match(await empty.lookup.run({}, {} as never), /no knowledge yet/i);
  const kit = tools();
  await kit.learn.run(kit.learn.parse(honest as never), {} as never);
  const text = await kit.lookup.run({ node: 'halden ports' } as never, {} as never);
  assert.match(text, /Halden Ports \(organisation\)/);
  assert.match(text, /C3/);
  assert.match(text, /Certifies marine equipment/);
  assert.match(text, /Certification register, 2026-10-02/);
  assert.match(text, /<- regulates Ministry of Trade \(tension -0\.7, fined twice\)/, 'the incoming relation is shown with its direction and strength');
  // The list form names the strongest relation, so an agent sees what matters without asking for each actor.
  const list = await kit.lookup.run({} as never, {} as never);
  assert.match(list, /Strong relation: Ministry of Trade regulates Halden Ports \(-0\.7\)/);
});

test('a lookup for an actor that is not there says so instead of returning nothing', async () => {
  const kit = tools();
  await kit.learn.run(kit.learn.parse(honest as never), {} as never);
  assert.match(await kit.lookup.run({ node: 'Nobody' } as never, {} as never), /No actor called "Nobody"/);
});

test('a second Learn of the same actor adds to it rather than replacing it, so the graph builds up across runs', async () => {
  const kit = tools();
  await kit.learn.run(kit.learn.parse(honest as never), {} as never);
  await kit.learn.run(kit.learn.parse({ nodes: [{ label: 'Halden Ports', functions: ['funds expansion'], facts: [{ text: 'Won a grant.' }] }] } as never), {} as never);
  const node = kit.graph().nodes.find((candidate) => candidate.label === 'Halden Ports') as TeamKnowledge['nodes'][number];
  assert.deepEqual(node.functions, ['issues certifications', 'funds expansion']);
  assert.equal(node.facts.length, 2);
  assert.equal(node.mentions, 2);
});

test('reading the graph is free and writing it asks, because what it writes outlives the run', () => {
  // 0.4.19 review: Learn writes the team's own file outside the workspace, so it must not be treated as a non-mutating tool.
  const kit = tools();
  assert.equal(kit.lookup.capability, 'read');
  // `sharedWrite`, not `workspaceWrite`: it writes outside the workspace, so an edit grant must not cover it, and the permission layer always asks.
  assert.equal(kit.learn.capability, 'sharedWrite');
});

test('a damaged graph is reported on the merge that overwrites it, rather than replaced in silence', async () => {
  const { mkdtemp, readFile, writeFile, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const { addKnowledge, knowledgeFile } = await import('../services/teamKnowledgeStore');
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-know-damaged-'));
  await mkdir(path.dirname(knowledgeFile(dir, 'scouts')), { recursive: true });
  await writeFile(knowledgeFile(dir, 'scouts'), '{ not json', 'utf8');
  const merged = await addKnowledge(dir, 'scouts', { origin: 'research', at: '2026-11-08T10:00:00.000Z', nodes: [{ label: 'alpha' }], edges: [] });
  assert.match(String(merged.problem ?? ''), /could not be read/, 'the corruption is surfaced on the graph that replaces it');
  assert.deepEqual(merged.nodes.map((node) => node.label), ['alpha']);
  // And the file is now valid.
  assert.match(await readFile(knowledgeFile(dir, 'scouts'), 'utf8'), /"version": 1/);
});

test('Learn holds every grade an agent gives to C3, whatever it cites, so a hostile page cannot become trusted memory', () => {
  // A source that names a document is no proof: an agent steered by a page can write any source text it likes. So the ceiling ignores the source.
  const kit = tools();
  const A1 = { reliability: 'A', credibility: 1 };
  for (const source of ['https://evil.test/about', 'Certification register, 2026-10-02', { url: 'https://evil.test' }, undefined]) {
    const input = kit.learn.parse({
      nodes: [{ label: 'Evil Corp', grading: A1, facts: [{ text: 'It certifies everything.', ...(source ? { source } : {}) }] }, { label: 'Ministry', grading: A1 }],
      edges: [{ from: 'Evil Corp', to: 'Ministry', kind: 'regulates', basis: 'the registry', grading: A1 }]
    } as never);
    assert.deepEqual(input.nodes[0]?.grading, { reliability: 'C', credibility: 3 }, `source ${JSON.stringify(source)}`);
    assert.deepEqual(input.nodes[1]?.grading, { reliability: 'C', credibility: 3 });
    assert.deepEqual(input.edges[0]?.grading, { reliability: 'C', credibility: 3 });
  }
  // A source that is not a string is flattened, not dropped, so the citation survives.
  const flattened = kit.learn.parse({ nodes: [{ label: 'X', facts: [{ text: 'Y.', source: { url: 'https://evil.test' } }] }] } as never);
  assert.match(flattened.nodes[0]?.facts[0]?.source ?? '', /evil\.test/);
  // Below the ceiling the agent's grade stands.
  const weak = kit.learn.parse({ nodes: [{ label: 'Rumour', grading: { reliability: 'E', credibility: 5 } }] } as never);
  assert.deepEqual(weak.nodes[0]?.grading, { reliability: 'E', credibility: 5 });
  // A path where a person is the witness keeps the grade as given.
  const person = tools(undefined, 'interaction').learn.parse({ nodes: [{ label: 'Registry', grading: A1 }] } as never);
  assert.deepEqual(person.nodes[0]?.grading, { reliability: 'A', credibility: 1 });
});

test('a damaged graph read by the agent says so, rather than looking like a team that never learned anything', async () => {
  const kit = tools({ ...emptyKnowledge('scouts', '2026-11-08T10:00:00.000Z'), problem: 'The knowledge graph for scouts could not be read (unexpected shape).' });
  assert.match(await kit.lookup.run({}, {} as never), /could not be read.*starts again/);
});

test('Learn carries at most 40 actors and 60 relations, so one call cannot flood the graph', () => {
  const kit = tools();
  const input = kit.learn.parse({
    nodes: Array.from({ length: 100 }, (_, index) => ({ label: `actor-${index}` })),
    edges: Array.from({ length: 200 }, (_, index) => ({ from: `actor-${index % 100}`, to: `actor-${(index + 1) % 100}` }))
  } as never);
  assert.equal(input.nodes.length, 40);
  assert.equal(input.edges.length, 60);
});
