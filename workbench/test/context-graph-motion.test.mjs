import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import {
  expectedFixtureGraphs, fixtureCitations, fixtureCorpus, fixtureReaders,
  fixtureVisibleCorpora, openFixtureCitation, projectFixtureGraph,
} from '../../dist/test/fixtures/contextGraph/evidenceFixture.js';

const origin = 'https://context-graph.fixture.invalid';
const fixtures = new URL('./fixtures/context-graph/', import.meta.url);
const files = {
  '/': ['explorer.html', 'text/html; charset=utf-8'],
  '/explorer.css': ['explorer.css', 'text/css; charset=utf-8'],
  '/explorer.mjs': ['explorer.mjs', 'text/javascript; charset=utf-8'],
};
const schedule = [
  [0, ['registry:v1']],
  [20, ['registry:v1', 'review:v1']],
  [80, ['registry:v1', 'review:v1', 'registry:v2']],
];
const wide = { width: 1200, height: 820 };
const narrow = { width: 500, height: 820 };
const proof = process.env.SOVAI_GRAPH_FIXTURE_EVIDENCE;
const introSources = fixtureVisibleCorpora.alpha.slice(0, 1).map(source => ({
  ...source, mentions: source.mentions.filter(mention => mention.entityId === 'lumen'), relations: [],
}));
const snap = (graph, revision = 1, generation = 1) => ({ kind: 'snapshot', generation, revision, graph });
const delta = (graph, revision, generation = 1) => ({ kind: 'delta', generation, revision, graph });
const scope = (graph, generation) => ({ kind: 'scope', generation, revision: 1, graph });
const citationReference = ({ sourceId, version, start, end }) => [sourceId, version, start, end].join(':');
const deniedReference = 'fixture-ref-0e26cd4857ec';
const references = new Map(Object.values(fixtureCitations).map(citation =>
  [citation === fixtureCitations.sourceDenied ? deniedReference : citationReference(citation), citation]));

let browser;
let resources;
before(async () => {
  browser = await chromium.launch({ args: ['--disable-background-networking', '--disable-component-update'] });
  // An absent implementation is an intentional first-run failure. The browser must launch before that check.
  resources = new Map(await Promise.all(Object.entries(files).map(async ([path, [file, contentType]]) =>
    [path, { contentType, body: await readFile(new URL(file, fixtures)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    }) }])));
});
after(async () => { await browser?.close(); });

async function harness(t, { viewport = wide, media = {}, controlled = true, reader = 'alpha', corpus = fixtureCorpus } = {}) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', ...media });
  t.after(() => context.close());
  const page = await context.newPage();
  const blocked = [];
  const requestLog = [];
  let nextSource;
  await page.exposeFunction('fixtureOpenSource', async reference => {
    const citation = references.get(reference);
    const result = citation ? openFixtureCitation(corpus, fixtureReaders[reader], citation) : { status: 'not-found' };
    requestLog.push({ reference, result });
    if (nextSource) {
      const waiting = nextSource;
      nextSource = undefined;
      waiting.received.resolve();
      await waiting.response.promise;
    }
    return result;
  });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const asset = url.origin === origin && resources.get(url.pathname);
    if (asset) {
      await route.fulfill({ status: asset.body.length ? 200 : 404, ...asset, headers: {
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      } });
    } else {
      blocked.push(url.origin);
      await route.abort('blockedbyclient');
    }
  });
  const response = await page.goto(origin);
  assert.equal(response.status(), 200, 'fixture document is served by the approved browser route');
  await page.waitForFunction(() => typeof globalThis.graphFixture?.accept === 'function', null, { timeout: 4_000 });
  if (controlled) await page.evaluate(() => globalThis.graphFixture.advance(0));
  const cdp = await context.newCDPSession(page);
  return {
    page, blocked, requestLog, setReader: next => { reader = next; },
    deferSource() {
      const received = Promise.withResolvers();
      const response = Promise.withResolvers();
      nextSource = { received, response };
      return { received: received.promise, release: response.resolve };
    },
    send: message => page.evaluate(value => globalThis.graphFixture.accept(value), message),
    advance: value => page.evaluate(time => globalThis.graphFixture.advance(time), value),
    view: () => page.evaluate(() => globalThis.graphFixture.inspect()),
    async ax() {
      const { nodes } = await cdp.send('Accessibility.getFullAXTree');
      return nodes.filter(node => !node.ignored).map(({ role, name, description, value, properties }) => ({
        role: role?.value, name: name?.value, description: description?.value, value: value?.value,
        properties: properties?.map(prop => [prop.name, prop.value.value]).filter(([, item]) => item !== undefined),
      }));
    },
  };
}

function graphFor(corpus, reader, keys) {
  return projectFixtureGraph(
    corpus.filter(source => keys.includes(`${source.sourceId}:${source.version}`)), fixtureReaders[reader]);
}

async function replay(h, corpus, reader) {
  const payloads = [];
  const initial = snap(projectFixtureGraph(introSources, fixtureReaders[reader]));
  await h.send(initial);
  payloads.push(initial);
  let current = initial.graph;
  for (const [time, keys] of schedule) {
    await h.advance(time);
    const next = graphFor(corpus, reader, [...keys, 'withheld:v1']);
    if (JSON.stringify(current) === JSON.stringify(next)) continue;
    const message = delta(next, payloads.length + 1);
    await h.send(message);
    payloads.push(message);
    current = next;
  }
  return payloads;
}

const round = value => Math.round(value * 1000) / 1000;
const coords = (view, id) => view.nodes.find(node => node.id === id).at;
const edge = (view, key) => view.edges.find(item => item.id === key);
const countCue = (view, key) => view.frames.filter(frame => frame.cues.includes(key)).length;

async function clickNode(h, view, id) {
  const canvas = await h.page.getByRole('group', { name: 'Pan graph' }).boundingBox();
  const [x, y] = coords(view, id);
  await h.page.mouse.click(canvas.x + canvas.width / 2 + view.camera.x + x * view.camera.scale,
    canvas.y + canvas.height / 2 + view.camera.y + y * view.camera.scale);
}

async function openProof(h, label, citation) {
  const panel = h.page.getByRole('complementary', { name: 'Evidence inspector' });
  const item = panel.getByRole('button', { name: label });
  await item.click();
  await panel.getByText(citation.text, { exact: true }).waitFor();
  assert.deepEqual(h.requestLog.at(-1), {
    reference: citationReference(citation), result: { status: 'found', text: citation.text },
  });
}

test('Chromium draws admitted arrivals and a coalesced update while the reader explores', async t => {
  const h = await harness(t);
  const payloads = await replay(h, fixtureCorpus, 'alpha');
  const baseline = await h.view();
  await h.advance(160);
  const entering = await h.view();
  assert.equal(entering.nodes.length, 3);
  assert.equal(entering.active.includes('fern'), true);
  assert.deepEqual(coords(entering, 'lumen'), coords(baseline, 'lumen'));
  assert.equal(edge(entering, 'lumen→fern').fraction, 0);

  await h.advance(250);
  const midway = await h.view();
  assert.notDeepEqual(coords(midway, 'fern'), coords(entering, 'fern'));
  assert.ok(edge(midway, 'lumen→fern').fraction > 0 && edge(midway, 'lumen→fern').fraction < 1);
  await h.page.getByRole('searchbox', { name: 'Search entities' }).focus();
  const drag = await h.page.getByRole('group', { name: 'Pan graph' }).boundingBox();
  await h.page.mouse.move(drag.x + 25, drag.y + 24);
  await h.page.mouse.down();
  await h.page.mouse.move(drag.x + 125, drag.y + 70, { steps: 4 });
  await h.page.mouse.up();
  assert.notDeepEqual((await h.view()).camera, baseline.camera);
  await h.page.getByRole('button', { name: 'Zoom in' }).click();
  await h.page.getByRole('searchbox', { name: 'Search entities' }).fill('Project');
  assert.deepEqual((await h.view()).nodes.map(node => node.id), ['fern', 'lumen']);
  await h.page.getByRole('searchbox', { name: 'Search entities' }).fill('');
  await clickNode(h, await h.view(), 'lumen');
  await openProof(h, 'Open source registry v1 0–28', fixtureCitations.first);
  await h.page.getByRole('button', { name: 'List', exact: true }).click();
  const relation = h.page.getByRole('button', { name: 'Lumen Co to Project Fern', exact: true });
  await relation.focus();
  await relation.press('Enter');
  await openProof(h, 'Open source registry v2 0–31', fixtureCitations.second);
  await relation.focus();
  await h.advance(700);
  const settled = await h.view();
  assert.notDeepEqual(coords(settled, 'fern'), coords(midway, 'fern'));
  assert.deepEqual(coords(settled, 'lumen'), coords(baseline, 'lumen'));
  assert.equal(edge(settled, 'lumen→fern').fraction, 1);
  assert.equal(settled.active.length, 0);
  assert.equal(countCue(settled, 'fern'), 1);
  assert.equal(countCue(settled, 'lumen→fern'), 1);
  assert.equal(settled.announcements.filter(text => text === 'Graph updated').length, 1);
  assert.equal(await relation.evaluate(element => element === document.activeElement), true);
  assert.equal(settled.selected, 'lumen→fern');
  assert.deepEqual(payloads.at(-1).graph, expectedFixtureGraphs.alpha);
  assert.deepEqual(h.blocked, []);

  const both = await harness(t, { reader: 'both' });
  const broader = await replay(both, fixtureCorpus, 'both');
  await both.advance(160);
  assert.ok((await both.view()).active.includes('moss'), 'an isolated admitted item appears only for the second reader');
  await both.advance(700);
  assert.deepEqual(broader.at(-1).graph, expectedFixtureGraphs.both);
  await both.page.getByRole('button', { name: 'List', exact: true }).click();
  await both.page.getByRole('button', { name: 'Lumen Co to Bay Office', exact: true }).click();
  await openProof(both, 'Open source review v1 0–43', fixtureCitations.bravo);

  await both.send(scope(expectedFixtureGraphs.alpha, 2));
  await both.page.getByRole('button', { name: 'Lumen Co', exact: true }).click();
  await openProof(both, 'Open source registry v1 0–28', fixtureCitations.first);
  const focused = both.page.getByRole('button', { name: 'Open source registry v1 0–28' });
  await focused.focus();
  await both.send(delta(expectedFixtureGraphs.both, 2, 2));
  await both.advance(860);
  assert.equal(await focused.evaluate(element => element === document.activeElement), true,
    'a still-admitted, focused source stays focused while new evidence is shown');
  const panel = both.page.getByRole('complementary', { name: 'Evidence inspector' });
  assert.equal(await panel.getByText(fixtureCitations.first.text, { exact: true }).count(), 1);
  assert.equal(await panel.getByRole('heading', { name: 'Lumen Co · Lumen Holdings' }).count(), 1);
});

test('reduced motion, pause and keyboard share the same settled graph and exact evidence', async t => {
  for (const example of [
    { media: { colorScheme: 'dark' }, viewport: wide, toggle: 'button' },
    { media: { colorScheme: 'light' }, viewport: narrow, toggle: 'live-reduced' },
    { media: { forcedColors: 'active', reducedMotion: 'reduce' }, viewport: narrow, toggle: 'initial-reduced' },
  ]) {
    const h = await harness(t, example);
    await replay(h, fixtureCorpus, 'alpha');
    await h.advance(180);
    const before = await h.view();
    if (example.toggle === 'initial-reduced') {
      assert.deepEqual(before.active, []);
    } else {
      assert.ok(before.active.length > 0);
      if (example.toggle === 'button') await h.page.getByRole('button', { name: 'Pause motion' }).click();
      else await h.page.emulateMedia({ reducedMotion: 'reduce' });
    }
    await h.advance(200);
    const frozen = await h.view();
    assert.deepEqual(frozen.active, []);
    assert.deepEqual(frozen.nodes.map(node => node.id), ['bay', 'fern', 'lumen']);
    assert.equal(edge(frozen, 'lumen→fern').fraction, 1);
    assert.equal(await h.page.getByText('Updated', { exact: true }).count(), 1);
    if (example.toggle === 'button') await h.page.getByRole('button', { name: 'Resume motion' }).click();
    else await h.page.emulateMedia({ reducedMotion: 'no-preference' });
    await h.advance(700);
    assert.deepEqual((await h.view()).nodes, frozen.nodes);
    const list = h.page.getByRole('button', { name: 'List', exact: true });
    await list.focus();
    await list.press('Enter');
    const relation = h.page.getByRole('button', { name: 'Lumen Co to Project Fern', exact: true });
    await relation.focus();
    assert.equal(await relation.evaluate(el => {
      const style = getComputedStyle(el);
      return style.outlineStyle === 'solid' && parseFloat(style.outlineWidth) >= 2;
    }), true);
    await relation.press('Enter');
    await openProof(h, 'Open source registry v2 0–31', fixtureCitations.second);
    await h.page.getByRole('button', { name: 'Close inspector' }).press('Enter');
    assert.equal(await relation.evaluate(el => el === document.activeElement), true);

    const graph = h.page.getByRole('button', { name: 'Graph', exact: true });
    const canvas = h.page.getByRole('group', { name: 'Pan graph' });
    const close = h.page.getByRole('button', { name: 'Close inspector' });
    await relation.press('Enter');
    await graph.press('Enter');
    await close.press('Enter');
    assert.equal(await canvas.evaluate(el => el === document.activeElement), true, 'List to Graph restores focus to the visible canvas');

    await clickNode(h, await h.view(), 'lumen');
    await list.press('Enter');
    await close.press('Enter');
    const entity = h.page.getByRole('button', { name: 'Lumen Co', exact: true });
    assert.equal(await entity.evaluate(el => el === document.activeElement), true, 'Graph to List restores focus to the selected row');
    assert.equal(await h.page.evaluate(() => document.documentElement.scrollWidth === innerWidth), true);
  }
});

test('hidden and absent corpora are indistinguishable to the lower-clearance browser', async t => {
  for (const reducedMotion of ['no-preference', 'reduce']) {
    const states = [];
    for (const corpus of [fixtureCorpus, fixtureVisibleCorpora.alpha]) {
      const h = await harness(t, { media: { reducedMotion }, corpus });
      const payloads = await replay(h, corpus, 'alpha');
      await h.advance(200);
      const entering = await h.view();
      await h.advance(700);
      const settled = await h.view();
      await h.page.getByRole('button', { name: 'List', exact: true }).click();
      await h.page.getByRole('button', { name: 'Lumen Co to Project Fern', exact: true }).click();
      await openProof(h, 'Open source registry v2 0–31', fixtureCitations.second);
      assert.deepEqual(openFixtureCitation(corpus, fixtureReaders.alpha, fixtureCitations.sourceDenied), { status: 'not-found' });
      const denied = await h.page.evaluate(ref => globalThis.fixtureOpenSource(ref), deniedReference);
      assert.deepEqual(denied, { status: 'not-found' });
      assert.deepEqual(h.requestLog.at(-1), { reference: deniedReference, result: { status: 'not-found' } });
      assert.doesNotMatch(await h.page.locator('body').textContent(), /Lumen Hidden|Loft Unit|withheld/);
      assert.equal(await h.page.getByRole('button', { name: /Open source withheld/ }).count(), 0);
      states.push({ entering, settled, payloads, denied, ax: await h.ax(), requests: h.requestLog,
        text: await h.page.locator('body').innerText(), network: h.blocked });
    }
    assert.deepEqual(states[0], states[1]);
    assert.equal(states[0].settled.nodes.length, 3);
    assert.equal(states[0].settled.edges.length, 1);
  }
});

test('scope replacement removes evidence and layout anchors, and rejects old or wrong-generation input', async t => {
  const h = await harness(t, { reader: 'both' });
  await replay(h, fixtureCorpus, 'both');
  await h.advance(210);
  await h.page.getByRole('button', { name: 'List', exact: true }).click();
  await h.page.getByRole('button', { name: 'Lumen Co to Bay Office', exact: true }).click();
  await openProof(h, 'Open source review v1 0–43', fixtureCitations.bravo);
  assert.ok((await h.view()).active.includes('moss'));
  const pending = h.deferSource();
  await h.page.getByRole('button', { name: 'Open source review v1 0–43' }).click();
  await pending.received;
  assert.equal(h.requestLog.at(-1).result.status, 'found');
  // Previously admitted rows must be scrubbed even while the List is hidden.
  const graphButton = h.page.getByRole('button', { name: 'Graph', exact: true });
  await graphButton.press('Enter');
  const rawList = h.page.locator('#list-surface');
  const notices = h.page.locator('#search-notices');
  const priorNotice = ['A previously eligible related source exists'];
  assert.match(await rawList.textContent(), /Lumen Holdings|Project Moss/);
  await h.page.evaluate(value => globalThis.graphFixture.searchNotices(value, 1), priorNotice);
  assert.equal(await notices.textContent(), priorNotice[0]);
  h.setReader('alpha');
  await h.send(scope(expectedFixtureGraphs.alpha, 2));
  pending.release();
  await h.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const cleared = await h.view();
  assert.deepEqual(cleared.active, []);
  assert.equal(cleared.selected, null);
  assert.doesNotMatch(await rawList.textContent(), /Lumen Holdings|Moss|Lumen Co to Bay Office/);
  assert.equal(await notices.textContent(), '');
  assert.doesNotMatch(await h.page.locator('body').innerText(), /Lumen Holdings|Moss|review v1/);
  assert.doesNotMatch(JSON.stringify(await h.ax()), /Lumen Holdings|Moss|review v1/);
  await h.send(delta(expectedFixtureGraphs.both, 99, 1));
  await h.send(snap(expectedFixtureGraphs.both, 99, 1));
  await h.send(delta(expectedFixtureGraphs.both, 99, 3));
  await h.send(snap(expectedFixtureGraphs.both, 99, 3));
  await h.send(snap(expectedFixtureGraphs.both, 1, 2));
  await h.send(delta(expectedFixtureGraphs.both, 1, 2));
  assert.equal(await h.page.evaluate(value => globalThis.graphFixture.searchNotices(value, 1), priorNotice), false);
  assert.equal(await notices.textContent(), '');
  assert.deepEqual(await h.view(), cleared);

  const fresh = await harness(t);
  await fresh.send(snap(expectedFixtureGraphs.alpha));
  assert.deepEqual((await fresh.view()).nodes, cleared.nodes);
  assert.deepEqual((await fresh.view()).edges, cleared.edges);

  // The approved existence notice belongs to search. It is intentionally absent
  // from both the fixture projection and the browser bridge cadence.
  const approvedNotice = { kind: 'existence-only', label: 'A related source exists' };
  const search = records => ({
    notices: records.filter(record => record.kind === 'existence-only').map(record => record.label),
    graph: expectedFixtureGraphs.alpha,
  });
  const withNotice = search([approvedNotice]);
  assert.deepEqual(withNotice.notices, ['A related source exists']);
  assert.deepEqual(withNotice.graph, search([]).graph);
  assert.equal(await h.page.evaluate(value => globalThis.graphFixture.searchNotices(value, 2), withNotice.notices), true);
  assert.equal(await notices.innerText(), 'A related source exists');
  assert.deepEqual(await h.view(), cleared);
  await h.page.getByRole('button', { name: 'List', exact: true }).press('Enter');
  assert.doesNotMatch(await rawList.textContent(), /Lumen Holdings|Moss|Lumen Co to Bay Office|A related source exists/);
  assert.match(await rawList.textContent(), /Project Fern/);
});

function volumeGraph() {
  const entities = Array.from({ length: 200 }, (_, index) => ({ id: `entity-${index}`, names: [`Fictional entity ${index}`] }));
  const edges = entities.flatMap((entity, index) => [1, 9].map(offset => ({
    from: entity.id, to: entities[(index + offset) % entities.length].id, evidence: [fixtureCitations.second],
  })));
  return { entities, edges, counts: { entities: entities.length, edges: edges.length } };
}

async function measureResponse(page, action, expected, cues) {
  await page.evaluate(({ expected, cues }) => {
    const current = () => globalThis.graphFixture.inspect();
    const byId = id => document.getElementById(id);
    const results = {
      pan: view => view.camera.x === expected.x,
      zoom: view => view.camera.scale > expected.scale,
      narrow: view => view.nodes.length === expected.count && byId('search').value === expected.query,
      restore: view => view.nodes.length === 200 && view.edges.length === 400 && byId('search').value === '',
      list: () => !byId('list-surface').hidden && byId('graph-surface').hidden && byId('entities').children.length === 200,
      select: view => view.selected === expected.relation &&
        byId('details').querySelector('h3')?.textContent === expected.title,
      source: () => byId('details').querySelector('blockquote')?.textContent === expected.text,
    };
    const matches = results[expected.phase];
    if (matches(current())) throw new Error(`The ${expected.phase} response was already present before input`);
    globalThis.fixtureSample = new Promise((resolve, reject) => {
      const handle = event => {
        const entry = performance.now();
        let matched;
        const check = at => {
          const view = current();
          if (!cues.every(cue => view.active.includes(cue))) {
            reject(new Error(`The authorized burst finished before painting ${expected.phase}`));
            return;
          }
          if (matches(view)) {
            // A later refresh gives the already-observed result an opportunity
            // to paint. Wait through co-timed refresh callbacks from headless input.
            if (matched !== undefined && at - matched >= 4) {
              resolve({ phase: expected.phase, latency: performance.now() - entry,
                interval: at - matched, input: event.type, active: cues.length });
              return;
            }
            matched ??= at;
          } else {
            matched = undefined;
          }
          requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      };
      document.addEventListener(expected.event, handle, { capture: true, once: true });
    });
  }, { expected, cues });
  await action();
  return page.evaluate(() => globalThis.fixtureSample);
}

test('representative graph stays within the interaction-to-paint budget at 200 nodes and 400 edges', async t => {
  const h = await harness(t, { controlled: false });
  const graph = volumeGraph();
  await h.send(snap(graph));
  assert.equal((await h.view()).nodes.length, 200);
  assert.equal((await h.view()).edges.length, 400);
  const page = h.page;
  if (proof) {
    h.setReader('both');
    await h.send(scope(expectedFixtureGraphs.both, 2));
    await clickNode(h, await h.view(), 'lumen');
    await openProof(h, 'Open source review v1 0–43', fixtureCitations.bravo);
    await page.screenshot({ path: join(proof, 'graph.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: join(proof, 'graph-dark.png') });
    await page.emulateMedia({ colorScheme: 'light' });
    h.setReader('alpha');
    await h.send(scope(graph, 3));
  }
  const canvas = page.getByRole('group', { name: 'Pan graph' });
  const search = page.getByRole('searchbox', { name: 'Search entities' });
  const graphButton = page.getByRole('button', { name: 'Graph', exact: true });
  const narrowQuery = 'Fictional entity 1';
  const matches = new Set(graph.entities.filter(item => item.names[0].includes(narrowQuery)).map(item => item.id));
  const visibleLinks = graph.edges.filter(item => matches.has(item.from) || matches.has(item.to));
  const narrowedCount = new Set(visibleLinks.flatMap(item => [item.from, item.to])).size;
  const updateIndexes = graph.edges.flatMap((item, index) => visibleLinks.includes(item) ? [index] : []);
  const edges = [...graph.edges];
  const samples = [];
  const displayInterval = await page.evaluate(async () => {
    const samples = [];
    let previous;
    for (let index = 0; index < 10; index += 1) {
      const at = await new Promise(resolve => requestAnimationFrame(resolve));
      if (previous !== undefined) samples.push(at - previous);
      previous = at;
    }
    return samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  });
  let revision = 1;
  let nextEdge = 0;
  for (let trial = 0; trial < 5; trial += 1) {
    await graphButton.click();
    const relation = `entity-${trial}→entity-${trial + 1}`;
    const title = `Fictional entity ${trial} to Fictional entity ${trial + 1}`;
    const generation = proof ? 3 : 1;
    const actions = [
      ['pan', 'keydown', () => canvas.press('ArrowRight')],
      ['zoom', 'click', () => page.getByRole('button', { name: 'Zoom in' }).click()],
      ['narrow', 'input', () => search.fill(narrowQuery)],
      ['restore', 'input', () => search.fill('')],
      ['list', 'click', () => page.getByRole('button', { name: 'List', exact: true }).click()],
      ['select', 'click', () => page.getByRole('button', { name: title, exact: true }).click()],
      ['source', 'click', () => page.getByRole('button', { name: 'Open source registry v2 0–31' }).click()],
    ];
    for (const [phase, event, action] of actions) {
      // Start every action inside a fresh coalesced burst. Add two authorized
      // assertions and retain all earlier additions so no reset can fake activity.
      const cues = [];
      for (let addition = 0; addition < 2; addition += 1) {
        const index = updateIndexes[nextEdge++];
        const before = edges[index];
        edges[index] = { ...before, evidence: [...before.evidence, fixtureCitations.first] };
        cues.push(`${before.from}→${before.to}`);
        assert.equal(await h.send(delta({ ...graph, edges }, ++revision, generation)), true);
      }
      await page.waitForFunction(keys => keys.every(key => globalThis.graphFixture.inspect().active.includes(key)),
        cues, { timeout: 2_000 });
      const { camera } = await h.view();
      const expected = { phase, event, x: camera.x + 26, scale: camera.scale, count: narrowedCount, query: narrowQuery,
        relation, title, text: fixtureCitations.second.text };
      samples.push(await measureResponse(page, action, expected, cues));
    }
  }
  const latencies = samples.map(sample => sample.latency).sort((a, b) => a - b);
  const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1];
  if (proof) await writeFile(join(proof, 'paint.json'), JSON.stringify({
    browser: browser.version(), viewport: wide, node: process.version, platform: platform(), kernel: release(),
    cpu: cpus()[0].model, displayInterval: round(displayInterval), p95: round(p95), samples,
  }, null, 2));
  assert.ok(displayInterval >= 14 && displayInterval <= 20, `expected a 60Hz fixture, median interval=${displayInterval}ms`);
  assert.ok(p95 <= 50, `input-to-next-painted-response p95 was ${round(p95)}ms`);
  assert.deepEqual(h.blocked, []);
});
