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

test('an agent can still grade BELOW the ceiling, axis by axis, and a person\'s grade is kept as given', () => {
  const graph = mergeKnowledge(emptyKnowledge('t', at), {
    origin: 'research', at,
    nodes: [{ label: 'Rumour', grading: { reliability: 'E', credibility: 5 } }, { label: 'Mixed', grading: { reliability: 'A', credibility: 5 } }],
    edges: []
  });
  assert.deepEqual(graph.nodes[0]?.grading, { reliability: 'E', credibility: 5 });
  assert.deepEqual(graph.nodes[1]?.grading, { reliability: 'C', credibility: 5 });
  const person = mergeKnowledge(emptyKnowledge('t', at), { origin: 'interaction', at, nodes: [{ label: 'Registry', grading: { reliability: 'A' as const, credibility: 1 as const } }], edges: [] });
  assert.deepEqual(person.nodes[0]?.grading, { reliability: 'A' as const, credibility: 1 as const });
});

test('a graph written before the ceiling existed is brought under it, and a person\'s grade in it is left alone', () => {
  const old = {
    version: 1 as const, team: 't', updatedAt: at,
    nodes: [
      { id: 'a', label: 'A', kind: 'actor' as const, functions: [], origin: 'research' as const, firstSeen: at, lastSeen: at, mentions: 1, grading: { reliability: 'A' as const, credibility: 1 as const },
        facts: [{ text: 'f', origin: 'research' as const, grading: { reliability: 'A' as const, credibility: 1 as const } }], history: [{ text: 'h', origin: 'research' as const, grading: { reliability: 'A' as const, credibility: 1 as const }, refutedBy: 'x', refutedAt: at }] },
      { id: 'b', label: 'B', kind: 'actor' as const, functions: [], facts: [], origin: 'interaction' as const, firstSeen: at, lastSeen: at, mentions: 1, grading: { reliability: 'A' as const, credibility: 1 as const } }
    ],
    edges: [{ id: 'e', from: 'a', to: 'b', kind: 'related' as const, tension: null, origin: 'research' as const, grading: { reliability: 'A' as const, credibility: 1 as const }, lastSeen: at, mentions: 1 }]
  };
  const held = heldToCeiling(old);
  assert.deepEqual(held.nodes[0]?.grading, AGENT_CEILING);
  assert.deepEqual(held.nodes[0]?.facts[0]?.grading, AGENT_CEILING);
  assert.deepEqual(held.nodes[0]?.history?.[0]?.grading, AGENT_CEILING);
  assert.deepEqual(held.edges[0]?.grading, AGENT_CEILING);
  assert.deepEqual(held.nodes[1]?.grading, { reliability: 'A' as const, credibility: 1 as const }, 'a person\'s grade is not an agent\'s');
  assert.deepEqual(old.nodes[0]?.grading, { reliability: 'A' as const, credibility: 1 as const }, 'pure: the input is not changed');
  // And the merge applies it, so even an untouched old entry leaves at the ceiling.
  const merged = mergeKnowledge(old, { origin: 'research', at, nodes: [{ label: 'C' }], edges: [] });
  assert.deepEqual(merged.nodes.find((node) => node.id === 'a')?.grading, AGENT_CEILING);
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

test('an agent never changes or retires what a person recorded: lowering a person\'s A1 first and contradicting it second does nothing', () => {
  // The two-step attack: restate a person-verified fact at F6 (a grade may fall), then contradict it at C3, which would now be "at least as strong".
  const fact = 'The port handled 4.2 million TEU in 2025.';
  let graph = mergeKnowledge(emptyKnowledge('t', at), { origin: 'interaction', at, nodes: [{ label: 'Port', grading: { reliability: 'A' as const, credibility: 1 as const }, facts: [{ text: fact, source: 'audited annual report' }, { text: 'The port opens at 6.' }] }], edges: [{ from: 'Port', to: 'Port', kind: 'related' }] });
  graph = mergeKnowledge(graph, { origin: 'research', at, nodes: [{ label: 'Port', grading: { reliability: 'F', credibility: 6 }, facts: [{ text: fact, grading: { reliability: 'F', credibility: 6 } }] }], edges: [] });
  assert.deepEqual(graph.nodes[0]?.grading, { reliability: 'A' as const, credibility: 1 as const }, 'the actor\'s grade is untouched');
  assert.deepEqual(graph.nodes[0]?.facts[0]?.grading, { reliability: 'A' as const, credibility: 1 as const }, 'the fact\'s grade is untouched');
  graph = mergeKnowledge(graph, { origin: 'research', at, nodes: [{ label: 'Port', facts: [{ text: 'The port handled 3.1 million TEU in 2025.', source: 'a blog' }, { text: 'The port does not open at 6.', source: 'a forum' }] }], edges: [] });
  const port = graph.nodes[0]!;
  assert.match(JSON.stringify(port.facts.map((entry) => entry.text)), /4\.2 million/, 'the person\'s fact is still believed');
  assert.match(JSON.stringify(port.facts.map((entry) => entry.text)), /opens at 6/, 'an ungraded fact a person recorded cannot be retired by an agent either');
  assert.equal(port.history?.length ?? 0, 0);
  // An agent's relation grade to a person's relation is ignored the same way, and a person can still lower or retire anything.
  let edge = mergeKnowledge(emptyKnowledge('t', at), { origin: 'interaction', at, nodes: [{ label: 'P' }, { label: 'Q' }], edges: [{ from: 'P', to: 'Q', grading: { reliability: 'A' as const, credibility: 1 as const } }] });
  edge = mergeKnowledge(edge, { origin: 'research', at, nodes: [], edges: [{ from: 'P', to: 'Q', grading: { reliability: 'F', credibility: 6 } }] });
  assert.deepEqual(edge.edges[0]?.grading, { reliability: 'A' as const, credibility: 1 as const });
  const person = mergeKnowledge(graph, { origin: 'interaction', at, nodes: [{ label: 'Port', grading: { reliability: 'A' as const, credibility: 1 as const }, facts: [{ text: 'The port handled 3.9 million TEU in 2025.', source: 'harbour authority' }] }], edges: [] });
  assert.match(JSON.stringify((person.nodes[0]!.history ?? []).map((entry) => entry.text)), /4\.2 million/, 'a person\'s equal-strength correction retires it');
});

test('a grade can only fall as the graph is merged, so a later mention cannot launder a held grade back up', () => {
  let graph = mergeKnowledge(emptyKnowledge('t', at), { origin: 'research', at, nodes: [{ label: 'Evil Corp', grading: { reliability: 'A' as const, credibility: 1 as const } }], edges: [] });
  graph = mergeKnowledge(graph, { origin: 'interaction', at: '2026-11-08T11:00:00.000Z', nodes: [{ label: 'Evil Corp', grading: { reliability: 'A' as const, credibility: 1 as const } }], edges: [] });
  assert.deepEqual(graph.nodes[0]?.grading, AGENT_CEILING, 'the weaker of the two is kept');
  // A weaker claim lowers it, on each axis separately.
  graph = mergeKnowledge(graph, { origin: 'research', at, nodes: [{ label: 'Evil Corp', grading: { reliability: 'B', credibility: 5 } }], edges: [] });
  assert.deepEqual(graph.nodes[0]?.grading, { reliability: 'C', credibility: 5 });
  // An agent repeating a fact a person verified at A1 does not drag it to the ceiling: the ceiling limits what an agent stores, not what a person decided.
  let verified = mergeKnowledge(emptyKnowledge('t', at), { origin: 'interaction', at, nodes: [{ label: 'Registry', grading: { reliability: 'A' as const, credibility: 1 as const }, facts: [{ text: 'Opens at 9.' }] }], edges: [] });
  verified = mergeKnowledge(verified, { origin: 'research', at, nodes: [{ label: 'Registry', grading: { reliability: 'A' as const, credibility: 1 as const }, facts: [{ text: 'Opens at 9.', source: 'https://x.test' }] }], edges: [] });
  assert.deepEqual(verified.nodes[0]?.grading, { reliability: 'A' as const, credibility: 1 as const });
  assert.deepEqual(verified.nodes[0]?.facts[0]?.grading, { reliability: 'A' as const, credibility: 1 as const });
  assert.equal(verified.nodes[0]?.facts[0]?.source, 'https://x.test', 'the missing source is filled in');
  // Relations follow the same rule.
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

test('a contradiction retires only what it out-evidences: a capped page claim cannot push a verified fact out of current belief', () => {
  // A contradiction alone would let a claim from a hostile page retire an A1 a person verified. Retirement needs the incoming side to be at least as strong.
  const verified = { text: 'The port handled 4.2 million TEU in 2025.', origin: 'interaction' as const, source: 'audited annual report', grading: { reliability: 'A' as const, credibility: 1 as const } };
  let graph = mergeKnowledge(emptyKnowledge('t', at), { origin: 'interaction', at, nodes: [{ label: 'Port', grading: { reliability: 'A' as const, credibility: 1 as const }, facts: [verified] }], edges: [] });
  // An agent's contradiction is held to C3, so the A1 fact stays exactly where it is.
  graph = mergeKnowledge(graph, { origin: 'research', at, nodes: [{ label: 'Port', grading: { reliability: 'A' as const, credibility: 1 as const }, facts: [{ text: 'The port handled 3.1 million TEU in 2025.', source: 'https://rumours.example/port' }] }], edges: [] });
  const held = graph.nodes[0]!;
  assert.match(JSON.stringify(held.facts.map((fact) => fact.text)), /4\.2 million/, 'the verified fact is still current belief');
  assert.equal(held.history?.length ?? 0, 0, 'nothing was retired');
  assert.match(JSON.stringify(held.facts.map((fact) => fact.text)), /3\.1 million/, 'the capped claim still accumulates beside it');
  // An EQUAL-grade contradiction retires — proved from a fresh graph, because after the capped claim has accumulated the equal assertion would only strengthen
  // the claim it already matches, which is the already-believed branch, not a contradiction.
  let equal = mergeKnowledge(emptyKnowledge('t', at), { origin: 'interaction', at, nodes: [{ label: 'Port', grading: { reliability: 'A' as const, credibility: 1 as const }, facts: [{ text: 'The port handled 4.2 million TEU in 2025.', source: 'audited annual report' }] }], edges: [] });
  equal = mergeKnowledge(equal, { origin: 'interaction', at, nodes: [{ label: 'Port', grading: { reliability: 'A' as const, credibility: 1 as const }, facts: [{ text: 'The port handled 3.1 million TEU in 2025.', source: 'harbour authority notice' }] }], edges: [] });
  const retired = equal.nodes[0]!;
  assert.match(JSON.stringify((retired.history ?? []).map((fact) => fact.text)), /4\.2 million/, 'an evidence-backed contradiction of equal standing retires');
  assert.match(JSON.stringify(retired.facts.map((fact) => fact.text)), /3\.1 million/, 'and the equal-standing claim stands');
  // An UNGRADED contradiction never retires a graded fact, from a fresh graph for the same reason.
  let solo = mergeKnowledge(emptyKnowledge('t', at), { origin: 'interaction', at, nodes: [{ label: 'Port', grading: { reliability: 'A' as const, credibility: 1 as const }, facts: [{ text: 'The port handled 4.2 million TEU in 2025.', source: 'audited annual report' }] }], edges: [] });
  solo = mergeKnowledge(solo, { origin: 'research', at, nodes: [{ label: 'Port', facts: [{ text: 'The port handled 9.9 million TEU in 2025.' }] }], edges: [] });
  const ungraded = solo.nodes[0]!;
  assert.match(JSON.stringify(ungraded.facts.map((fact) => fact.text)), /4\.2 million/, 'the graded fact survives an ungraded contradiction');
  assert.equal(ungraded.history?.length ?? 0, 0, 'nothing was retired');
  // A LOW-GRADED contradiction never retires either: the comparison uses the full Admiralty scale, so a D claim cannot defeat an A1 fact.
  let weak = mergeKnowledge(emptyKnowledge('t', at), { origin: 'interaction', at, nodes: [{ label: 'Port', grading: { reliability: 'A' as const, credibility: 1 as const }, facts: [{ text: 'The port handled 4.2 million TEU in 2025.', source: 'audited annual report' }] }], edges: [] });
  weak = mergeKnowledge(weak, { origin: 'document', at, nodes: [{ label: 'Port', grading: { reliability: 'D' as const, credibility: 1 as const }, facts: [{ text: 'The port handled 2.2 million TEU in 2025.', source: 'a bar flyer' }] }], edges: [] });
  const weakHeld = weak.nodes[0]!;
  assert.match(JSON.stringify(weakHeld.facts.map((fact) => fact.text)), /4\.2 million/, 'the verified fact survives a D1 contradiction');
  assert.equal(weakHeld.history?.length ?? 0, 0, 'nothing was retired by the weak claim');
  assert.match(JSON.stringify(weakHeld.facts.map((fact) => fact.text)), /2\.2 million/, 'the weak claim still accumulates beside it');
});

test('a sourced re-assertion revives a refuted claim and retires what it now contradicts; an unsourced echo does not', () => {
  let graph = mergeKnowledge(emptyKnowledge('t', at), { origin: 'research', at, nodes: [{ label: 'Port', facts: [{ text: 'The port handled 4.2 million TEU in 2025.' }] }], edges: [] });
  graph = mergeKnowledge(graph, { origin: 'research', at, nodes: [{ label: 'Port', facts: [{ text: 'The port handled 3.1 million TEU in 2025.' }] }], edges: [] });
  // An unsourced echo does NOT revive: a team that read a retraction should not forget that it did.
  graph = mergeKnowledge(graph, { origin: 'research', at, nodes: [{ label: 'Port', facts: [{ text: 'The port handled 4.2 million TEU in 2025.' }] }], edges: [] });
  assert.equal(graph.nodes[0]!.facts.length, 1, 'the echo changed nothing');
  assert.match(graph.nodes[0]!.facts[0]!.text, /3\.1 million/);
  // A re-assertion that cites a source is new information: believed again, dated from now, at its own (held) grade.
  const later = '2026-11-09T00:00:00.000Z';
  graph = mergeKnowledge(graph, { origin: 'research', at: later, nodes: [{ label: 'Port', grading: { reliability: 'A' as const, credibility: 1 as const }, facts: [{ text: 'The port handled 4.2 million TEU in 2025.', source: 'harbour authority annual report' }] }], edges: [] });
  const revived = graph.nodes[0]!;
  assert.deepEqual(revived.facts.map((fact) => fact.text), ['The port handled 4.2 million TEU in 2025.'], 'the claim is current again, alone');
  assert.equal(revived.facts[0]!.since, later);
  assert.deepEqual(revived.facts[0]!.grading, AGENT_CEILING);
  assert.match(JSON.stringify((revived.history ?? []).map((fact) => fact.text)), /3\.1 million/, 'what it contradicts is retired');
  assert.match(JSON.stringify((revived.history ?? []).map((fact) => fact.refutedBy)), /harbour authority/, 'with the revival and its source as the reason');
  assert.equal((revived.history ?? []).some((fact) => fact.text.includes('4.2 million')), false, 'and it is not also left in history');
  // A revival weaker than what stands is believed again beside it, but retires nothing.
  let strong = mergeKnowledge(emptyKnowledge('t', at), { origin: 'research', at, nodes: [{ label: 'Port', facts: [{ text: 'The port handled 4.2 million TEU in 2025.' }] }], edges: [] });
  strong = mergeKnowledge(strong, { origin: 'interaction', at, nodes: [{ label: 'Port', grading: { reliability: 'A' as const, credibility: 1 as const }, facts: [{ text: 'The port handled 3.1 million TEU in 2025.', source: 'audited' }] }], edges: [] });
  strong = mergeKnowledge(strong, { origin: 'research', at, nodes: [{ label: 'Port', grading: { reliability: 'A' as const, credibility: 1 as const }, facts: [{ text: 'The port handled 4.2 million TEU in 2025.', source: 'a blog' }] }], edges: [] });
  assert.match(JSON.stringify(strong.nodes[0]!.facts.map((fact) => fact.text)), /3\.1 million/, 'the person-verified A1 stands against a C3 revival');
});
