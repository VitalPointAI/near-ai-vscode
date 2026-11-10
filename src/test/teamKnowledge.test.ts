// A team's knowledge graph (owner, 2026-11-08): actors, the relations between them, their signed strength, and the Admiralty grading of the evidence.
// The merge is the part that matters: agents add to the graph repeatedly, so adding the same thing twice must not duplicate it, and a later vague mention
// must never erase a measured relation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_CEILING, clampTension, emptyKnowledge, gradingCoverage, heldToCeiling, mergeKnowledge, neighbours, nodeId, strongestEdges } from '../domain/teamKnowledge';

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

test('nothing an agent writes is stored above C3, whatever it cites: the merge holds actors, facts and relations to the ceiling', () => {
  // An agent that read a hostile page can be steered into any grade and any source text, including one that does not look like a page. No test of the
  // source can tell those apart, so the ceiling does not look at the source at all.
  for (const source of [undefined, 'https://evil.test/about', 'evil\u3002test', '\u0435vil.test/about', 'the official registry, 2026', 'annual-report.pdf']) {
    const graph = mergeKnowledge(emptyKnowledge('t', at), {
      origin: 'research', at,
      nodes: [{ label: 'Evil Corp', facts: [{ text: 'Certifies everything.', ...(source ? { source } : {}) }], grading: { reliability: 'A' as const, credibility: 1 as const } }, { label: 'Ministry', grading: { reliability: 'A' as const, credibility: 1 as const } }],
      edges: [{ from: 'Evil Corp', to: 'Ministry', kind: 'regulates', basis: 'the registry', grading: { reliability: 'A' as const, credibility: 1 as const } }]
    });
    assert.deepEqual(graph.nodes[0]?.grading, AGENT_CEILING, `actor, source ${JSON.stringify(source)}`);
    assert.deepEqual(graph.nodes[0]?.facts[0]?.grading, AGENT_CEILING, `fact, source ${JSON.stringify(source)}`);
    assert.deepEqual(graph.nodes[1]?.grading, AGENT_CEILING, 'an actor with no facts at all');
    assert.deepEqual(graph.edges[0]?.grading, AGENT_CEILING, 'a relation with a named basis');
  }
  // A fact's own grade is held too, not only the actor's.
  const own = mergeKnowledge(emptyKnowledge('t', at), { origin: 'document', at, nodes: [{ label: 'X', facts: [{ text: 'Claim.', grading: { reliability: 'A' as const, credibility: 1 as const } }] }], edges: [] });
  assert.deepEqual(own.nodes[0]?.facts[0]?.grading, AGENT_CEILING);
});

test('an agent can still grade BELOW the ceiling, axis by axis, and the ceiling holds whatever the origin label says', () => {
  const graph = mergeKnowledge(emptyKnowledge('t', at), {
    origin: 'research', at,
    nodes: [{ label: 'Rumour', grading: { reliability: 'E', credibility: 5 } }, { label: 'Mixed', grading: { reliability: 'A', credibility: 5 } }],
    edges: []
  });
  assert.deepEqual(graph.nodes[0]?.grading, { reliability: 'E', credibility: 5 });
  assert.deepEqual(graph.nodes[1]?.grading, { reliability: 'C', credibility: 5 });
  // 0.4.18 labelled every agent addition `interaction`, so the label proves nothing about who said it.
  for (const origin of ['interaction', 'document', 'seed'] as const) {
    const labelled = mergeKnowledge(emptyKnowledge('t', at), { origin, at, nodes: [{ label: 'Registry', grading: { reliability: 'A' as const, credibility: 1 as const } }], edges: [] });
    assert.deepEqual(labelled.nodes[0]?.grading, AGENT_CEILING, origin);
  }
});
test('a 0.4.18 graph is brought under the ceiling, including entries 0.4.18 labelled interaction', () => {
  const old = {
    version: 1 as const, team: 't', updatedAt: at,
    nodes: [
      { id: 'a', label: 'A', kind: 'actor' as const, functions: [], origin: 'research' as const, firstSeen: at, lastSeen: at, mentions: 1, grading: { reliability: 'A' as const, credibility: 1 as const },
        facts: [{ text: 'f', origin: 'research' as const, grading: { reliability: 'A' as const, credibility: 1 as const } }], history: [{ text: 'h', origin: 'research' as const, grading: { reliability: 'A' as const, credibility: 1 as const }, refutedBy: 'x', refutedAt: at }] },
      { id: 'b', label: 'B', kind: 'actor' as const, functions: [], facts: [], origin: 'interaction' as const, firstSeen: at, lastSeen: at, mentions: 1, grading: { reliability: 'A' as const, credibility: 1 as const } }
    ],
    edges: [{ id: 'e', from: 'a', to: 'b', kind: 'related' as const, tension: null, origin: 'interaction' as const, grading: { reliability: 'A' as const, credibility: 1 as const }, lastSeen: at, mentions: 1 }]
  };
  const held = heldToCeiling(old);
  assert.deepEqual(held.nodes[0]?.grading, AGENT_CEILING);
  assert.deepEqual(held.nodes[0]?.facts[0]?.grading, AGENT_CEILING);
  assert.deepEqual(held.nodes[0]?.history?.[0]?.grading, AGENT_CEILING);
  assert.deepEqual(held.nodes[1]?.grading, AGENT_CEILING, 'an `interaction` label written by 0.4.18\'s agent is held too');
  assert.deepEqual(held.edges[0]?.grading, AGENT_CEILING);
  assert.deepEqual(old.nodes[0]?.grading, { reliability: 'A' as const, credibility: 1 as const }, 'pure: the input is not changed');
  const merged = mergeKnowledge(old, { origin: 'research', at, nodes: [{ label: 'C' }], edges: [] });
  assert.deepEqual(merged.nodes.find((node) => node.id === 'b')?.grading, AGENT_CEILING);
});
test('a genuinely new figure about one actor is retired, not accumulated — the number-rule trade, pinned', () => {
  // `isContradicted` reads two figures in otherwise-matching sentences as a correction, so the newer one retires the older. This is the deliberate trade
  // (see the note beside isContradicted), pinned so a change to the rule cannot flip it unnoticed.
  let graph = mergeKnowledge(emptyKnowledge('t', at), {
    origin: 'research', at,
    nodes: [{ label: 'Port', facts: [{ text: 'The port handled 4.2 million TEU in 2025.' }] }],
    edges: []
  });
  graph = mergeKnowledge(graph, {
    origin: 'research', at: '2026-11-10T01:00:00.000Z',
    nodes: [{ label: 'Port', facts: [{ text: 'The port handled 5.1 million TEU in 2026.' }] }],
    edges: []
  });
  assert.deepEqual(graph.nodes[0]?.facts.map((fact) => fact.text), ['The port handled 5.1 million TEU in 2026.'], 'only the newer figure stays in current belief');
  assert.equal(graph.nodes[0]?.history?.length, 1, 'the earlier figure is retired with its history entry, not destroyed');
  assert.match(graph.nodes[0]?.history?.[0]?.refutedBy ?? '', /5\.1 million/, 'the retirement names what out-evidenced it');
});

test('a grade can only fall as the graph is merged, so a later mention cannot launder a held grade back up', () => {
  let graph = mergeKnowledge(emptyKnowledge('t', at), { origin: 'research', at, nodes: [{ label: 'Evil Corp', grading: { reliability: 'D', credibility: 4 } }], edges: [] });
  graph = mergeKnowledge(graph, { origin: 'interaction', at, nodes: [{ label: 'Evil Corp', grading: { reliability: 'A' as const, credibility: 1 as const } }], edges: [] });
  assert.deepEqual(graph.nodes[0]?.grading, { reliability: 'D', credibility: 4 }, 'the weaker of the two is kept');
  graph = mergeKnowledge(graph, { origin: 'research', at, nodes: [{ label: 'Evil Corp', grading: { reliability: 'B', credibility: 5 } }], edges: [] });
  assert.deepEqual(graph.nodes[0]?.grading, { reliability: 'D', credibility: 5 }, 'each axis falls separately');
  let fact = mergeKnowledge(emptyKnowledge('t', at), { origin: 'research', at, nodes: [{ label: 'R', facts: [{ text: 'Opens at 9.', grading: { reliability: 'C', credibility: 4 } }] }], edges: [] });
  fact = mergeKnowledge(fact, { origin: 'research', at, nodes: [{ label: 'R', grading: { reliability: 'A' as const, credibility: 1 as const }, facts: [{ text: 'Opens at 9.', source: 'https://x.test' }] }], edges: [] });
  assert.deepEqual(fact.nodes[0]?.facts[0]?.grading, { reliability: 'C', credibility: 4 });
  assert.equal(fact.nodes[0]?.facts[0]?.source, 'https://x.test', 'the missing source is filled in');
  let edge = mergeKnowledge(emptyKnowledge('t', at), { origin: 'research', at, nodes: [{ label: 'P' }, { label: 'Q' }], edges: [{ from: 'P', to: 'Q', grading: { reliability: 'D', credibility: 4 } }] });
  edge = mergeKnowledge(edge, { origin: 'interaction', at, nodes: [], edges: [{ from: 'P', to: 'Q', grading: { reliability: 'A' as const, credibility: 1 as const } }] });
  assert.deepEqual(edge.edges[0]?.grading, { reliability: 'D', credibility: 4 });
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

test('a contradiction retires only what it out-evidences: a weaker or ungraded claim cannot push a stronger fact out of current belief', () => {
  // Everything is at most C3, so the strongest belief there is stands at C3, and only another C3 can retire it.
  const base = () => mergeKnowledge(emptyKnowledge('t', at), { origin: 'research', at, nodes: [{ label: 'Port', facts: [{ text: 'The port handled 4.2 million TEU in 2025.', source: 'audited annual report', grading: { reliability: 'B', credibility: 2 } }] }], edges: [] });
  assert.deepEqual(base().nodes[0]!.facts[0]!.grading, AGENT_CEILING, 'B2 is above the ceiling, so it is stored at C3');
  const after = (grading: { reliability: 'A' | 'B' | 'C' | 'D' | 'E' | 'F'; credibility: 1 | 2 | 3 | 4 | 5 | 6 } | undefined) =>
    mergeKnowledge(base(), { origin: 'research', at, nodes: [{ label: 'Port', ...(grading ? { grading } : {}), facts: [{ text: 'The port handled 3.1 million TEU in 2025.', source: 'harbour notice' }] }], edges: [] }).nodes[0]!;
  for (const weaker of [undefined, { reliability: 'C' as const, credibility: 4 as const }, { reliability: 'D' as const, credibility: 1 as const }]) {
    const port = after(weaker);
    assert.match(JSON.stringify(port.facts.map((fact) => fact.text)), /4\.2 million/, `${JSON.stringify(weaker)} does not retire C3`);
    assert.match(JSON.stringify(port.facts.map((fact) => fact.text)), /3\.1 million/, 'it accumulates beside it');
    assert.equal(port.history?.length ?? 0, 0);
  }
  // An equal claim retires it, including an A1 claim, which is held to C3 on the way in.
  for (const equal of [AGENT_CEILING, { reliability: 'A' as const, credibility: 1 as const }]) {
    const port = after(equal);
    assert.match(JSON.stringify((port.history ?? []).map((fact) => fact.text)), /4\.2 million/);
    assert.deepEqual(port.facts.map((fact) => fact.text), ['The port handled 3.1 million TEU in 2025.']);
  }
});
test('a sourced re-assertion revives a refuted claim and retires what it now contradicts; an unsourced echo does not', () => {
  let graph = mergeKnowledge(emptyKnowledge('t', at), { origin: 'research', at, nodes: [{ label: 'Port', facts: [{ text: 'The port handled 4.2 million TEU in 2025.' }] }], edges: [] });
  graph = mergeKnowledge(graph, { origin: 'research', at, nodes: [{ label: 'Port', facts: [{ text: 'The port handled 3.1 million TEU in 2025.' }] }], edges: [] });
  graph = mergeKnowledge(graph, { origin: 'research', at, nodes: [{ label: 'Port', facts: [{ text: 'The port handled 4.2 million TEU in 2025.' }] }], edges: [] });
  assert.equal(graph.nodes[0]!.facts.length, 1, 'the echo changed nothing');
  assert.match(graph.nodes[0]!.facts[0]!.text, /3\.1 million/);
  const later = '2026-11-09T00:00:00.000Z';
  graph = mergeKnowledge(graph, { origin: 'research', at: later, nodes: [{ label: 'Port', grading: { reliability: 'A' as const, credibility: 1 as const }, facts: [{ text: 'The port handled 4.2 million TEU in 2025.', source: 'harbour authority annual report' }] }], edges: [] });
  const revived = graph.nodes[0]!;
  assert.deepEqual(revived.facts.map((fact) => fact.text), ['The port handled 4.2 million TEU in 2025.'], 'the claim is current again, alone');
  assert.equal(revived.facts[0]!.since, later);
  assert.deepEqual(revived.facts[0]!.grading, AGENT_CEILING);
  assert.match(JSON.stringify((revived.history ?? []).map((fact) => fact.text)), /3\.1 million/, 'what it contradicts is retired');
  assert.match(JSON.stringify((revived.history ?? []).map((fact) => fact.refutedBy)), /harbour authority/);
  assert.equal((revived.history ?? []).some((fact) => fact.text.includes('4.2 million')), false, 'and it is not also left in history');
  // A revival weaker than what stands is believed again beside it, but retires nothing.
  let strong = mergeKnowledge(emptyKnowledge('t', at), { origin: 'research', at, nodes: [{ label: 'Port', facts: [{ text: 'The port handled 4.2 million TEU in 2025.' }] }], edges: [] });
  strong = mergeKnowledge(strong, { origin: 'research', at, nodes: [{ label: 'Port', facts: [{ text: 'The port handled 3.1 million TEU in 2025.', source: 'audited', grading: { reliability: 'B', credibility: 2 } }] }], edges: [] });
  strong = mergeKnowledge(strong, { origin: 'research', at, nodes: [{ label: 'Port', grading: { reliability: 'C', credibility: 4 }, facts: [{ text: 'The port handled 4.2 million TEU in 2025.', source: 'a blog' }] }], edges: [] });
  assert.match(JSON.stringify(strong.nodes[0]!.facts.map((fact) => fact.text)), /3\.1 million/, 'the B2 stands against a C4 revival');
});
