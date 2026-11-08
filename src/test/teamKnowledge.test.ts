// A team's knowledge graph (owner, 2026-11-08): actors, the relations between them, their signed strength, and the Admiralty grading of the evidence.
// The merge is the part that matters: agents add to the graph repeatedly, so adding the same thing twice must not duplicate it, and a later vague mention
// must never erase a measured relation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { clampTension, emptyKnowledge, gradingCoverage, mergeKnowledge, neighbours, nodeId, strongestEdges } from '../domain/teamKnowledge';

const at = '2026-11-08T10:00:00.000Z';

test('an actor mentioned twice is one node, with its facts merged and not repeated', () => {
  let graph = emptyKnowledge('scouts', at);
  graph = mergeKnowledge(graph, {
    origin: 'research', at,
    nodes: [{ label: 'Halden Ports', kind: 'organisation', functions: ['issues certification'], facts: [{ text: 'Runs the port.', source: 'https://ports.example/a' }], grading: { reliability: 'A', credibility: 1 } }],
    edges: []
  });
  graph = mergeKnowledge(graph, {
    origin: 'interaction', at: '2026-11-08T11:00:00.000Z',
    nodes: [{ label: 'halden ports', functions: ['funds expansion'], facts: [{ text: 'Runs the port.' }, { text: 'Won a grant in 2026.' }] }],
    edges: []
  });
  assert.equal(graph.nodes.length, 1, 'the same actor, whichever way it is written');
  const node = graph.nodes[0]!;
  assert.deepEqual(node.functions, ['issues certification', 'funds expansion']);
  assert.equal(node.facts.length, 2, 'the repeated fact is not stored twice');
  assert.equal(node.facts[0]?.source, 'https://ports.example/a', 'the first fact keeps its source');
  assert.equal(node.mentions, 2);
  assert.equal(node.firstSeen, at);
  assert.equal(node.lastSeen, '2026-11-08T11:00:00.000Z');
  assert.equal(node.origin, 'research', 'where it came from first is kept, so a researched actor is not relabelled as hearsay');
});

test('a relation keeps its measured strength when a later mention does not measure it, and an unmeasured one is not zero', () => {
  let graph = mergeKnowledge(emptyKnowledge('scouts', at), {
    origin: 'research', at,
    nodes: [{ label: 'Port' }, { label: 'Ministry' }],
    edges: [{ from: 'Port', to: 'Ministry', kind: 'regulates', tension: -0.8, basis: 'fined twice in 2025' }]
  });
  graph = mergeKnowledge(graph, { origin: 'interaction', at: '2026-11-09T00:00:00.000Z', nodes: [{ label: 'Port' }, { label: 'Ministry' }], edges: [{ from: 'Port', to: 'Ministry', kind: 'regulates' }] });
  const edge = graph.edges[0]!;
  assert.equal(edge.tension, -0.8, 'the measured strength survives a vague mention');
  assert.equal(edge.basis, 'fined twice in 2025');
  assert.equal(edge.mentions, 2);
  // A relation nobody has measured is null, which is not the same as neutral.
  const unmeasured = mergeKnowledge(emptyKnowledge('t', at), { origin: 'research', at, nodes: [{ label: 'A' }, { label: 'B' }], edges: [{ from: 'A', to: 'B' }] });
  assert.equal(unmeasured.edges[0]?.tension, null);
  assert.equal(clampTension(2), 1, 'a strength out of range is clamped, not rejected');
  assert.equal(clampTension(-3), -1);
  assert.equal(clampTension(undefined), null);
});

test('an edge whose ends are not in the graph is dropped rather than left dangling', () => {
  const graph = mergeKnowledge(emptyKnowledge('t', at), { origin: 'research', at, nodes: [{ label: 'A' }], edges: [{ from: 'A', to: 'Ghost', kind: 'supplies' }] });
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.edges.length, 0);
});

test('a node\'s relations are found in both directions, which is what the detail card and the highlight need', () => {
  const graph = mergeKnowledge(emptyKnowledge('t', at), {
    origin: 'research', at,
    nodes: [{ label: 'Port' }, { label: 'Ministry' }, { label: 'Supplier' }],
    edges: [{ from: 'Ministry', to: 'Port', kind: 'regulates', tension: -0.5 }, { from: 'Supplier', to: 'Port', kind: 'supplies', tension: 0.7 }]
  });
  const port = graph.nodes.find((node) => node.label === 'Port')!;
  const relations = neighbours(graph, port.id);
  assert.equal(relations.length, 2);
  assert.deepEqual(relations.map((entry) => entry.direction).sort(), ['in', 'in']);
  const supplier = graph.nodes.find((node) => node.label === 'Supplier')!;
  assert.equal(neighbours(graph, supplier.id)[0]?.direction, 'out');
});

test('the strongest relations come first by absolute strength, so a hostile link is as visible as a warm one', () => {
  const graph = mergeKnowledge(emptyKnowledge('t', at), {
    origin: 'research', at,
    nodes: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }],
    edges: [
      { from: 'A', to: 'B', kind: 'partners', tension: 0.2 },
      { from: 'C', to: 'D', kind: 'competes', tension: -0.9 },
      { from: 'A', to: 'C', kind: 'related' }
    ]
  });
  const strong = strongestEdges(graph);
  assert.deepEqual(strong.map((entry) => entry.edge.tension), [-0.9, 0.2], 'unmeasured relations are not in the ranking');
});

test('the grading coverage says how much of the graph is worth trusting', () => {
  const graph = mergeKnowledge(emptyKnowledge('t', at), {
    origin: 'research', at,
    nodes: [{ label: 'Graded', grading: { reliability: 'B', credibility: 2 } }, { label: 'Ungraded' }],
    edges: [{ from: 'Graded', to: 'Ungraded', kind: 'related', grading: { reliability: 'C', credibility: 3 } }]
  });
  assert.deepEqual(gradingCoverage(graph), { nodes: 2, edges: 1, gradedNodes: 1, gradedEdges: 1 });
});

test('two different labels do not collide, and a label differing only in case or spacing is the same node', () => {
  assert.equal(nodeId('Halden Ports'), nodeId('  halden   ports '));
  assert.notEqual(nodeId('Halden Ports'), nodeId('Halden Port'));
});
