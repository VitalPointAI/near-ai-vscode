import assert from 'node:assert/strict';
import test from 'node:test';
import {
  expectedFixtureGraphs, fixtureCitations, fixtureCorpus, fixtureReaders, fixtureVisibleCorpora,
  openFixtureCitation, projectFixtureGraph,
} from './fixtures/contextGraph/evidenceFixture';

for (const scope of ['alpha', 'both'] as const) {
  test(`the ${scope} reader sees the fixed graph with inaccessible evidence present or absent`, () => {
    const reader = fixtureReaders[scope];
    const mixed = projectFixtureGraph(fixtureCorpus, reader);
    const visibleOnly = projectFixtureGraph(fixtureVisibleCorpora[scope], reader);
    assert.deepEqual(mixed, visibleOnly);
    assert.deepEqual(mixed, expectedFixtureGraphs[scope]);
  });
}

test('denied and missing citations give the same response', () => {
  for (const scope of ['alpha', 'both'] as const) {
    const reader = fixtureReaders[scope];
    const denied = scope === 'alpha'
      ? [fixtureCitations.bravo, fixtureCitations.sourceDenied]
      : [fixtureCitations.sourceDenied];
    for (const citation of denied) {
      const missing = openFixtureCitation(fixtureVisibleCorpora[scope], reader, citation);
      assert.deepEqual(missing, { status: 'not-found' });
      assert.deepEqual(openFixtureCitation(fixtureCorpus, reader, citation), missing);
    }
  }
});

test('a citation opens the exact immutable version and span', () => {
  const open = (citation: typeof fixtureCitations.first) =>
    openFixtureCitation(fixtureCorpus, fixtureReaders.both, citation);
  const { first, second, bravo } = fixtureCitations;

  assert.deepEqual(open(first), { status: 'found', text: 'Lumen Co funds Project Fern.' });
  assert.deepEqual(open(second), { status: 'found', text: 'Lumen Co supports Project Fern.' });
  assert.deepEqual(open(bravo), { status: 'found', text: 'Lumen Holdings coordinates with Bay Office.' });

  for (const wrongCitation of [
    { ...first, version: 'v2' },
    { ...first, version: 'missing' },
    { ...first, start: -1 },
    { ...first, end: 100 },
    { ...first, text: 'Lumen Co owns Project Fern.' },
  ]) {
    assert.deepEqual(open(wrongCitation), { status: 'not-found' });
  }
});
