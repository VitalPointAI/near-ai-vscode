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

test('the merge caps a web-sourced grade itself, so no path into it can store an A1 for a page an agent read', () => {
  // 0.4.19 review: the cap lived only in the tool, so a direct addKnowledge call (or a replayed addition) skipped it entirely.
  const graph = mergeKnowledge(emptyKnowledge('t', at), {
    origin: 'research', at,
    nodes: [{ label: 'Evil Corp', facts: [{ text: 'Certifies everything.', source: 'https://evil.test/about' }], grading: { reliability: 'A', credibility: 1 } }],
    edges: []
  });
  assert.deepEqual(graph.nodes[0]?.grading, { reliability: 'C', credibility: 3 });
  assert.deepEqual(graph.nodes[0]?.facts[0]?.grading, { reliability: 'C', credibility: 3 }, 'the fact carries the capped grade too');
});

test('a node with no facts is still capped when its LABEL is an address, which was a way around the cap', () => {
  const graph = mergeKnowledge(emptyKnowledge('t', at), {
    origin: 'research', at,
    nodes: [{ label: 'https://evil.test', grading: { reliability: 'A', credibility: 1 } }],
    edges: []
  });
  assert.deepEqual(graph.nodes[0]?.grading, { reliability: 'C', credibility: 3 });
});

test('a homoglyph, a zero-width space, or a bracketed dot in the host still counts as a web source', () => {
  // An invisible character BESIDE the dot, which is what a hostile page uses, since a zero-width space instead of a dot is not an address at all.
  for (const source of ['evil\u3002test/about', 'evil.\u200Btest', 'evil\u200B.test', 'evil[.]test', 'see evil.test/about', 'HTTPS://EVIL.TEST', 'EVIL.TEST/x']) {
    const graph = mergeKnowledge(emptyKnowledge('t', at), {
      origin: 'research', at,
      nodes: [{ label: 'X', facts: [{ text: 'Claim.', source }], grading: { reliability: 'A', credibility: 1 } }],
      edges: []
    });
    assert.deepEqual(graph.nodes[0]?.grading, { reliability: 'C', credibility: 3 }, `${JSON.stringify(source)} is a page the agent read`);
  }
});

test('a grade can only fall as the graph is merged, so a later uncapped mention cannot launder a capped one back to A1', () => {
  // 0.4.19 review: `existing.grading = incoming.grading` let the second addition undo the first one's cap.
  let graph = mergeKnowledge(emptyKnowledge('t', at), {
    origin: 'research', at,
    nodes: [{ label: 'Evil Corp', facts: [{ text: 'Certifies everything.', source: 'https://evil.test/about' }], grading: { reliability: 'A', credibility: 1 } }],
    edges: []
  });
  graph = mergeKnowledge(graph, { origin: 'interaction', at: '2026-11-08T11:00:00.000Z', nodes: [{ label: 'Evil Corp', grading: { reliability: 'A', credibility: 1 } }], edges: [] });
  assert.deepEqual(graph.nodes[0]?.grading, { reliability: 'C', credibility: 3 }, 'the weaker of the two is kept');
  // The reverse: a vague grade arriving AFTER an honest one lowers it. That is deliberate (a grade can only fall, so a later self-declared grade is never
  // an upgrade), and the cost is accepted: an honestly graded actor can be lowered by a later mention that declares less. The alternative, letting a grade
  // rise, is what made a hostile page into trusted memory.
  let other = mergeKnowledge(emptyKnowledge('t', at), { origin: 'interaction', at, nodes: [{ label: 'Registry', grading: { reliability: 'A', credibility: 1 } }], edges: [] });
  other = mergeKnowledge(other, { origin: 'interaction', at, nodes: [{ label: 'Registry', grading: { reliability: 'C', credibility: 3 } }], edges: [] });
  assert.deepEqual(other.nodes[0]?.grading, { reliability: 'C', credibility: 3 });
});

test('an edge whose basis names a document but whose end was researched from a page is capped, and so is one with no basis', () => {
  const graph = mergeKnowledge(emptyKnowledge('t', at), {
    origin: 'research', at,
    nodes: [
      { label: 'Evil Corp', facts: [{ text: 'Certifies.', source: 'evil.test/about' }] },
      { label: 'Ministry', facts: [{ text: 'Named it.', source: 'Certification register, 2026-10-02' }] }
    ],
    edges: [
      { from: 'Evil Corp', to: 'Ministry', kind: 'regulates', basis: "the vendor's own site", grading: { reliability: 'A', credibility: 1 } },
      { from: 'Ministry', to: 'Evil Corp', kind: 'funds', basis: 'Certification register, 2026-10-02', grading: { reliability: 'A', credibility: 1 } }
    ]
  });
  assert.deepEqual(graph.edges[0]?.grading, { reliability: 'C', credibility: 3 }, 'a page-researched end caps the relation');
  assert.deepEqual(graph.edges[1]?.grading, { reliability: 'C', credibility: 3 }, 'and it caps it in the other direction too');
  // Two documented ends with a documented basis keep the grade: the cap is about pages, not about edges.
  const cited = mergeKnowledge(emptyKnowledge('t', at), {
    origin: 'research', at,
    nodes: [{ label: 'Port', facts: [{ text: 'Runs the port.', source: 'Certification register, 2026-10-02' }] }, { label: 'Ministry', facts: [{ text: 'Regulates it.', source: 'Certification register, 2026-10-02' }] }],
    edges: [{ from: 'Port', to: 'Ministry', kind: 'regulates', basis: 'Certification register, 2026-10-02', grading: { reliability: 'B', credibility: 2 } }]
  });
  assert.deepEqual(cited.edges[0]?.grading, { reliability: 'B', credibility: 2 });
});

test('the graph accumulates: 30 batches of actors and relations all survive', () => {
  // 0.4.19 review: nothing capped the total, and the whole file is parsed on every later addition.
  let graph = emptyKnowledge('t', at);
  for (let batch = 0; batch < 30; batch += 1) {
    graph = mergeKnowledge(graph, {
      origin: 'research', at,
      nodes: Array.from({ length: 40 }, (_, index) => ({ label: `actor-${batch}-${index}` })),
      edges: Array.from({ length: 60 }, (_, index) => ({ from: `actor-${batch}-${index % 40}`, to: `actor-${batch}-${(index + 1) % 40}`, kind: 'related' as const }))
    });
  }
  // 1,200 actors learned over 30 batches: ALL of them survive. A knowledge graph accumulates, and a ceiling that silently dropped the oldest entries made a
  // team forget what it had learned (owner, 2026-11-08).
  assert.equal(graph.nodes.length, 1_200, `every actor is kept: ${graph.nodes.length}`);
  const kept = new Set(graph.nodes.map((node) => node.id));
  assert.ok(graph.edges.every((edge) => kept.has(edge.from) && kept.has(edge.to)), 'no edge is left dangling');
  // One actor mentioned repeatedly keeps every fact and every function it was given.
  let fat = emptyKnowledge('t', at);
  for (let batch = 0; batch < 10; batch += 1) {
    fat = mergeKnowledge(fat, {
      origin: 'research', at,
      nodes: [{ label: 'Greedy', functions: Array.from({ length: 8 }, (_, index) => `function-${batch}-${index}`), facts: Array.from({ length: 12 }, (_, index) => ({ text: `fact ${batch}-${index}` })) }],
      edges: []
    });
  }
  assert.equal(fat.nodes[0]?.facts.length, 120);
  assert.equal(fat.nodes[0]?.functions.length, 80);
});

test('a fact that later evidence refutes moves to history, with why and when, rather than staying as if it were true', () => {
  // Owner, 2026-11-08: the graph accumulates but also learns. New evidence that refutes old knowledge removes it from what the team believes, and KEEPS it in
  // case a decision made on it needs revisiting.
  let graph = mergeKnowledge(emptyKnowledge('t', at), {
    origin: 'research', at,
    nodes: [{ label: 'Port', facts: [{ text: 'The port handled 4.2 million TEU in 2025.', source: 's1-ministry.md' }] }],
    edges: []
  });
  graph = mergeKnowledge(graph, {
    origin: 'research', at: '2026-11-09T00:00:00.000Z',
    nodes: [{ label: 'Port', facts: [{ text: 'The port handled 3.1 million TEU in 2025.', source: 'https://trade-weekly.test/a' }] }],
    edges: []
  });
  const port = graph.nodes[0]!;
  assert.deepEqual(port.facts.map((fact) => fact.text), ['The port handled 3.1 million TEU in 2025.'], 'only the current belief is believed');
  assert.equal(port.history?.length, 1, 'the refuted fact is kept');
  assert.match(port.history![0]!.text, /4\.2 million/);
  assert.match(port.history![0]!.refutedBy ?? '', /3\.1 million/, 'why it was refuted is recorded');
  assert.equal(port.history![0]!.refutedAt, '2026-11-09T00:00:00.000Z');
  assert.equal(port.history![0]!.since, at, 'and when it was first believed, so the timeline survives');
});

test('a negation of the same claim refutes it, and unrelated facts about one actor do not', () => {
  const base = mergeKnowledge(emptyKnowledge('t', at), {
    origin: 'research', at,
    nodes: [{ label: 'Supplier', facts: [{ text: 'The supplier is certified for medical use.' }, { text: 'The supplier ships from Halden.' }] }],
    edges: []
  });
  // A negation of the SAME claim refutes it.
  const negated = mergeKnowledge(base, { origin: 'research', at, nodes: [{ label: 'Supplier', facts: [{ text: 'The supplier is not certified for medical use.' }] }], edges: [] });
  assert.equal(negated.nodes[0]?.history?.length, 1, 'the negated claim is retired');
  assert.match(negated.nodes[0]?.facts.map((fact) => fact.text).join(' ') ?? '', /not certified/);
  // A different fact about the same actor accumulates rather than contradicting.
  const added = mergeKnowledge(base, { origin: 'research', at, nodes: [{ label: 'Supplier', facts: [{ text: 'The supplier employs 40 people.' }] }], edges: [] });
  assert.equal(added.nodes[0]?.history?.length ?? 0, 0, 'an unrelated fact does not refute anything');
  assert.equal(added.nodes[0]?.facts.length, 3);
});

test('a refuted fact is not re-learned as new when the same claim comes back', () => {
  let graph = mergeKnowledge(emptyKnowledge('t', at), { origin: 'research', at, nodes: [{ label: 'Port', facts: [{ text: 'The port handled 4.2 million TEU in 2025.' }] }], edges: [] });
  graph = mergeKnowledge(graph, { origin: 'research', at, nodes: [{ label: 'Port', facts: [{ text: 'The port handled 3.1 million TEU in 2025.' }] }], edges: [] });
  graph = mergeKnowledge(graph, { origin: 'research', at, nodes: [{ label: 'Port', facts: [{ text: 'The port handled 4.2 million TEU in 2025.' }] }], edges: [] });
  const port = graph.nodes[0]!;
  assert.equal(port.facts.length, 1, 'the refuted claim is not resurrected beside the current one');
  assert.match(port.facts[0]!.text, /3\.1 million/);
  assert.equal(port.history?.length, 1, 'and it stays in the record');
});

test('a re-assertion with independent evidence revives a refuted claim, and retires what it now contradicts', () => {
  // 0.4.19 review MINOR: `if (refuted) continue;` suppressed a retracted claim permanently, so evidence that re-established it could never restore it.
  let graph = mergeKnowledge(emptyKnowledge('t', at), { origin: 'research', at, nodes: [{ label: 'Port', facts: [{ text: 'The port handled 4.2 million TEU in 2025.' }] }], edges: [] });
  graph = mergeKnowledge(graph, { origin: 'research', at, nodes: [{ label: 'Port', facts: [{ text: 'The port handled 3.1 million TEU in 2025.' }] }], edges: [] });
  // An unsourced echo does NOT revive: a team that read a retraction should not forget that it did.
  graph = mergeKnowledge(graph, { origin: 'research', at, nodes: [{ label: 'Port', facts: [{ text: 'The port handled 4.2 million TEU in 2025.' }] }], edges: [] });
  const echoed = graph.nodes[0]!;
  assert.equal(echoed.facts.length, 1, 'the echo changed nothing');
  assert.match(echoed.facts[0]!.text, /3\.1 million/);
  // A page the agent read does not revive it either — a web source is exactly what the refutation protected against.
  graph = mergeKnowledge(graph, { origin: 'research', at, nodes: [{ label: 'Port', facts: [{ text: 'The port handled 4.2 million TEU in 2025.', source: 'https://ports.example/teu' }] }], edges: [] });
  assert.equal(graph.nodes[0]!.facts.length, 1, 'a web-sourced re-assertion is still an echo of the page');
  // An INDEPENDENT source — a person who measured it themselves — is new information: believed again, dated, with the revival's grading (per node, as every addition carries it).
  graph = mergeKnowledge(graph, { origin: 'interaction', at, nodes: [{ label: 'Port', grading: { reliability: 'A' as const, credibility: 1 as const }, facts: [{ text: 'The port handled 4.2 million TEU in 2025.', source: 'measured on site by the harbourmaster, 2026-11-09' }] }], edges: [] });
  const revived = graph.nodes[0]!;
  assert.match(JSON.stringify(revived.facts.map((fact) => fact.text)), /4\.2 million/, 'the claim is believed again');
  assert.match(revived.facts[0]!.text, /4\.2 million/, 'and it stands first as current belief');
  assert.match(revived.facts[0]!.source ?? '', /harbourmaster/);
  assert.equal(revived.facts[0]!.grading?.reliability, 'A', 'the revival carries its own grading');
  assert.match(JSON.stringify((revived.history ?? []).map((fact) => fact.text)), /3\.1 million/, 'what it contradicts is retired with the revival as the reason');
  assert.match(JSON.stringify((revived.history ?? []).map((fact) => fact.refutedBy)), /4\.2 million/, 'the revival names itself as the refutation');
  // The old entry's history record for the revived claim is gone from history: it is current again, not double-counted.
  assert.equal((revived.history ?? []).some((fact) => fact.text.includes('4.2 million')), false);
});

