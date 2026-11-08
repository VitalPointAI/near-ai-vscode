// The network drawing (owner, 2026-11-08). The layout is pure and tested elsewhere; this checks the things a person would notice: nodes are inside the
// frame, the same graph always draws the same way, the strongest relation is the most obvious line, and selecting a node touches exactly its own relations.
import assert from 'node:assert/strict';
import test from 'node:test';
import { highlight, highlightOrder, layoutNetwork } from '../domain/networkLayout';
import { emptyKnowledge, mergeKnowledge, type TeamKnowledge } from '../domain/teamKnowledge';

const at = '2026-11-08T10:00:00.000Z';
function graph(): TeamKnowledge {
  return mergeKnowledge(emptyKnowledge('scouts', at), {
    origin: 'research', at,
    nodes: [{ label: 'Port' }, { label: 'Ministry' }, { label: 'Supplier' }, { label: 'Certifier' }, { label: 'Lonely' }],
    edges: [
      { from: 'Ministry', to: 'Port', kind: 'regulates', tension: -0.9 },
      { from: 'Supplier', to: 'Port', kind: 'supplies', tension: 0.6 },
      { from: 'Certifier', to: 'Port', kind: 'certifies', tension: 0.2 },
      { from: 'Supplier', to: 'Certifier', kind: 'depends-on' }
    ]
  });
}

test('every node is placed inside the frame, and the most connected actor is nearest the centre', () => {
  const layout = layoutNetwork(graph());
  for (const node of layout.nodes) {
    assert.ok(node.x >= 0 && node.x <= layout.width, `${node.label} is inside the width`);
    assert.ok(node.y >= 0 && node.y <= layout.height, `${node.label} is inside the height`);
  }
  const port = layout.nodes.find((node) => node.label === 'Port')!;
  const lonely = layout.nodes.find((node) => node.label === 'Lonely')!;
  const distance = (node: { x: number; y: number }) => Math.hypot(node.x - layout.width / 2, node.y - layout.height / 2);
  assert.ok(distance(port) < distance(lonely), 'the actor everything touches sits closer to the middle than one nothing touches');
  assert.ok(port.radius > lonely.radius, 'and it is drawn bigger');
});

test('the same graph always draws the same way, so a screenshot means something', () => {
  const first = layoutNetwork(graph());
  const second = layoutNetwork(graph());
  assert.deepEqual(first.nodes.map((node) => [node.id, node.x, node.y]), second.nodes.map((node) => [node.id, node.x, node.y]));
});

test('the strongest relation is the thickest line, and an unmeasured one is neither thick nor counted as weak', () => {
  const layout = layoutNetwork(graph());
  const strongest = layout.edges.find((edge) => edge.tension === -0.9)!;
  const weakest = layout.edges.find((edge) => edge.tension === 0.2)!;
  const unmeasured = layout.edges.find((edge) => edge.tension === null)!;
  assert.ok(strongest.width > weakest.width, 'a strong relation is wider than a weak one');
  assert.equal(unmeasured.width, 1, 'an unmeasured relation is drawn thin');
  assert.equal(unmeasured.neutral, true);
  assert.equal(strongest.positive, false, 'a hostile relation is not positive');
  assert.equal(weakest.positive, true);
});

test('selecting a node touches its own relations and nothing else, and the spread starts with the strongest', () => {
  const layout = layoutNetwork(graph());
  const port = layout.nodes.find((node) => node.label === 'Port')!;
  const touched = highlight(layout, port.id)!;
  assert.equal(touched.nodes.size, 4, 'the port and the three actors it relates to');
  assert.equal(touched.edges.size, 3, 'and the three relations between them');
  const supplierCertifier = layout.edges.find((edge) => edge.kind === 'depends-on')!;
  assert.equal(touched.edges.has(supplierCertifier.id), false, 'a relation between two neighbours is not part of the selection');
  const order = highlightOrder(layout, port.id);
  assert.equal(order.length, 3);
  assert.deepEqual(order.map((entry) => entry.delayMs), [0, 60, 120], 'the animation spreads one relation at a time');
  assert.equal(order[0]?.edgeId, layout.edges.find((edge) => edge.tension === -0.9)!.id, 'the strongest relation is drawn first');
  // Nothing selected is no highlight at all, rather than an empty dimming.
  assert.equal(highlight(layout, null), undefined);
});

test('an empty graph lays out to nothing rather than dividing by zero', () => {
  const layout = layoutNetwork(emptyKnowledge('empty', at));
  assert.deepEqual(layout.nodes, []);
  assert.deepEqual(layout.edges, []);
  assert.equal(layout.rings, 0);
});
