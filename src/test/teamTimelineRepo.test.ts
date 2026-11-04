// The board timeline on this repository's own roadmap at HEAD (62.1-CONTEXT D-03: "tested on this repository's roadmap"). The planning files are
// read from the commit with git ls-tree and git cat-file, imported the way Import plans does, and laid out. Every assertion is structural, never
// an exact count, so the test follows the repository as plans and SUMMARYs are added.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import test from 'node:test';
import { buildBoardModel } from '../domain/team/board';
import { buildGsdGraph } from '../domain/team/gsdImport';
import { buildTimeline } from '../domain/team/timeline';
import type { BoardTimeline } from '../domain/team/timeline';
import { graphToItems } from '../team/importPlans';
import { boardWorld } from './helpers/teamBoardWorld';

const REPO_ROOT = path.join(__dirname, '..', '..');
const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const MILESTONE = 'milestone:v0.6.0';

function git(args: string[]): string {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

test('this repository\'s roadmap at HEAD: every v0.6.0 card is one dot, each after what it waits for, phases after the phases they depend on, no loop, the same twice', async () => {
  const listed = git(['ls-tree', '-r', '-z', '--full-tree', '--name-only', 'HEAD', '--', '.planning']).split('\0').filter((name) => name !== '');
  const files = new Map<string, string>();
  for (const name of ['.planning/ROADMAP.md', '.planning/STATE.md', ...listed.filter((entry) => entry.endsWith('-PLAN.md'))]) files.set(name, git(['cat-file', 'blob', `HEAD:${name}`]));
  const graph = buildGsdGraph({ paths: listed, files });
  if ('error' in graph) assert.fail(`the roadmap at HEAD did not parse: ${graph.error}`);
  // The milestone's source must be a commit id (the event body refuses a ref name), so HEAD is resolved first.
  const { bodies } = graphToItems(graph, { sourceCommit: git(['rev-parse', 'HEAD']).trim() });
  assert.ok(bodies.some((body) => body.id === MILESTONE), 'the import holds the milestone');
  const world = await boardWorld();
  for (const body of bodies) world.accept(world.lead, 'item.imported', body);

  const options = { nowMs: NOW, status: { kind: 'live' as const, text: 'Live' }, viewerId: world.lead.memberId, canWrite: true };
  const model = buildBoardModel(world.state, options);
  const timeline = buildTimeline(world.state, model, { viewerId: world.lead.memberId });
  const again: BoardTimeline = buildTimeline(world.state, buildBoardModel(world.state, options), { viewerId: world.lead.memberId });
  assert.deepEqual(again, timeline, 'two builds give the same timeline');

  const band = timeline.milestones.find((entry) => entry.id === MILESTONE);
  assert.ok(band !== undefined, 'v0.6.0 is a timeline milestone');
  assert.equal(band.active, true);
  assert.ok(timeline.milestones.every((entry) => !entry.cycle), 'the roadmap holds no loop');
  assert.ok(timeline.dots.every((dot) => !dot.inCycle));

  const cards = model.cards.filter((card) => card.milestoneId === MILESTONE).map((card) => card.id).sort();
  const dots = timeline.dots.filter((dot) => dot.milestoneId === MILESTONE);
  assert.ok(cards.length > 0);
  assert.deepEqual(dots.map((dot) => dot.cardId).sort(), cards, 'every card of v0.6.0 is exactly one dot there');
  assert.equal(new Set(timeline.dots.map((dot) => dot.cardId)).size, timeline.dots.length, 'no card is drawn twice');
  assert.equal(band.cardCount, cards.length);

  const step = new Map(dots.map((dot) => [dot.cardId, dot.step]));
  const stepOf = (id: string): number => {
    const found = step.get(id);
    assert.ok(found !== undefined, `${id} is a dot of v0.6.0`);
    return found;
  };
  const inside = timeline.edges.filter((edge) => step.has(edge.from) && step.has(edge.to));
  assert.ok(inside.length > 0, 'the roadmap has dependencies between plans');
  for (const edge of inside) assert.ok(stepOf(edge.to) > stepOf(edge.from), `${edge.to} comes after ${edge.from}`);

  // Phases the roadmap says depend on other phases: each of their cards comes after every card of those phases.
  const cardsOf = (phaseId: string): string[] => dots.filter((dot) => dot.phaseId === phaseId).map((dot) => dot.cardId);
  const phases = [...world.state.items.values()].filter((item) => item.kind === 'phase' && item.parentId === MILESTONE);
  for (const [phaseId, needs] of [['phase:61', 'phase:60'], ['phase:62', 'phase:60'], ['phase:62.1', 'phase:62']] as const) {
    assert.ok(world.state.items.get(phaseId)?.dependsOn.includes(needs), `the roadmap says ${phaseId} depends on ${needs}`);
  }
  let checked = 0;
  for (const phase of phases) {
    for (const needed of phase.dependsOn) {
      const before = cardsOf(needed);
      if (before.length === 0) continue;
      const last = Math.max(...before.map(stepOf));
      for (const id of cardsOf(phase.id)) assert.ok(stepOf(id) > last, `${id} comes after every card of ${needed}`);
      checked += 1;
    }
  }
  assert.ok(checked >= 3, `phase dependencies were checked (${checked})`);

  const inserted = cardsOf('phase:62.1').filter((id) => id.startsWith('plan:'));
  assert.ok(inserted.length > 0, 'Phase 62.1 has plans at HEAD');
  for (const id of inserted) {
    assert.ok(stepOf(id) > stepOf('plan:62-27'), `${id} comes after 62-27`);
    assert.ok(stepOf(id) > stepOf('plan:61-31'), `${id} comes after 61-31`);
  }
});
