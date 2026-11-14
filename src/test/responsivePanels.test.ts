import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import * as vm from 'node:vm';
import { comparisonPageHtml } from '../services/modelComparisonPage';
import { teamStudioHtml } from '../services/teamStudioPage';
import { toolsPageHtml } from '../services/toolsDirectory';

// Every page fits a narrow panel: it wraps, stacks, or hides less important table columns rather
// than scrolling sideways. The extension-host tests measure the real pages at 170 to 600 pixels;
// these check the rules that make that happen.

const MEDIA = path.join(__dirname, '..', '..', 'media');
const css = (file: string) => readFileSync(path.join(MEDIA, file), 'utf8');
const RAW_HEX = /#[0-9a-f]{3,8}\b(?![^{]*var\()/i;

test('the shared stylesheet stops sideways page scroll and defines the responsive table helpers', () => {
  const base = css('shared/base.css');
  assert.match(base, /html, body \{ overflow-x: clip; \}/, 'clip, not hidden, so sticky headers keep working');
  assert.match(base, /@media \(max-width: 900px\) \{\s*\.col-tertiary \{ display: none !important; \}\s*\.when-medium \{ display: block; \}/);
  assert.match(base, /@media \(max-width: 600px\) \{\s*\.col-secondary \{ display: none !important; \}\s*\.when-narrow \{ display: block; \}/);
  assert.match(base, /@media \(max-width: 420px\) \{[\s\S]*table\.stack-narrow[\s\S]*content: attr\(data-label\)/);
  assert.match(base, /@media \(max-width: 600px\) \{[\s\S]*table\.stack-medium[\s\S]*content: attr\(data-label\)/);
  assert.match(base, /\.table-wrap \{ position: relative;/, 'hidden headers stay inside their table box');
  assert.match(base, /\.hint, \.error \{ overflow-wrap: anywhere; \}/);
  // Whatever the font or name length, table text wraps so a table shrinks to its box; numbers stay whole.
  assert.match(base, /\.table-wrap > table \{ width: 100%; \}/);
  assert.match(base, /\.table-wrap th, \.table-wrap td \{ min-width: 0; white-space: normal; overflow-wrap: anywhere; \}/);
  assert.match(base, /\.table-wrap td\.num \{ white-space: nowrap; \}/);
  assert.doesNotMatch(base, RAW_HEX, 'colours come from the theme');
});

test('grids never ask for more width than the panel has', () => {
  // No table cell insists on a fixed minimum width (names wrap instead).
  assert.doesNotMatch(css('activity/activity.css'), /(#history|#now|#models) td[^{]*\{[^}]*min-width: \d/);
  assert.doesNotMatch(css('compare/compare.css'), /\.(model-cell|wrap|misses)[^{]*\{[^}]*min-width: \d/);
  for (const file of ['activity/activity.css', 'compare/compare.css', 'teams/teams.css', 'onboarding/onboarding.css', 'tools/tools.css', 'mcp/mcp.css']) {
    const sheet = css(file);
    assert.doesNotMatch(sheet, /minmax\(\d+px/, `${file}: a grid column minimum is guarded with min(…, 100%)`);
    assert.doesNotMatch(sheet, /\.table-wrap \{ overflow-x: auto; margin/, `${file}: the shared .table-wrap is used`);
  }
  for (const file of ['activity/activity.css', 'compare/compare.css', 'mcp/mcp.css', 'tools/tools.css', 'teams/teams.css']) {
    assert.doesNotMatch(css(file), /#[0-9a-f]{3,6}\s*;(?![^{]*var\()/i, `${file}: hex only as a theme-variable fallback`);
  }
});

test('each page has narrow-width rules', () => {
  const chat = css('chat/chat.css');
  assert.match(chat, /#transcript \{[^}]*overflow-x: hidden;/);
  assert.match(chat, /\n\.composer \.bar \{ display: flex; flex-wrap: wrap;/, 'the bar wraps at every width, outside any media query (G-27-4a)');
  assert.match(chat, /@media \(max-width: 220px\) \{[\s\S]*\.conversation-tab \{ max-width: 100px; \}/);
  assert.match(chat, /#commands \[role="option"\] strong \{ flex: 0 1 auto; min-width: 0;/, 'a long command name shortens instead of widening the menu');
  assert.match(chat, /\.questions \.option \{ display: grid; grid-template-columns: auto minmax\(0, 1fr\);/);
  assert.match(chat, /\.code-block pre \{[^}]*overflow-x: auto;/, 'code keeps its own sideways scroll');
  assert.match(css('activity/activity.css'), /\.controls \{ display: flex; flex-wrap: wrap;/);
  assert.match(css('activity/activity.css'), /\.segmented \{ display: inline-flex; flex-wrap: wrap;/);
  assert.match(css('compare/compare.css'), /fieldset \{ min-width: 0;/);
  assert.match(css('compare/compare.css'), /@media \(max-width: 1300px\) \{\s*\.col-tertiary \{ display: none !important; \}\s*\.when-medium \{ display: block; \}/, 'the 14-column leaderboard drops its least important columns below 1300px');
  assert.match(css('compare/compare.css'), /\.role select \{ width: 100%; min-width: 0; max-width: 100%; \}/, 'the role picker takes the cell width, not its longest role name');
  assert.match(css('compare/compare.css'), /\.role \{ display: flex; flex-direction: column;/, 'Apply sits under the role picker');
  assert.match(css('mcp/mcp.css'), /@media \(max-width: 420px\)/);
  assert.match(css('mcp/mcp.css'), /\.server-head \{ display: flex; flex-wrap: wrap;/);
  assert.match(css('teams/teams.css'), /#crumbs \{ display: flex; flex-wrap: wrap;/);
  assert.match(css('teams/teams.css'), /\.tool-line \{ display: grid; grid-template-columns: auto minmax\(0, 1fr\) auto;/);
  assert.match(css('tools/tools.css'), /\.search \{ display: flex; flex-wrap: wrap;/);
  assert.match(css('onboarding/onboarding.css'), /@media \(max-width: 480px\)/);
});

test('pages link the shared stylesheet before their own, and load the layout probe only when asked', () => {
  for (const html of [
    toolsPageHtml({ cspSource: 'vscode-resource:', nonce: 'n', script: 'tools.js', style: 'tools.css', base: 'base.css' }),
    comparisonPageHtml({ cspSource: 'vscode-resource:', nonce: 'n', script: 'compare.js', style: 'compare.css', base: 'base.css' }),
    teamStudioHtml({ cspSource: 'vscode-resource:', nonce: 'n', script: 'teams.js', style: 'teams.css', network: 'network.css', base: 'base.css' })
  ]) {
    assert.match(html, /<link rel="stylesheet" href="base\.css"><link rel="stylesheet" href="(tools|compare|teams)\.css">/);
    assert.doesNotMatch(html, /layout-probe/);
  }
  const probed = toolsPageHtml({ cspSource: 'vscode-resource:', nonce: 'n', script: 'tools.js', style: 'tools.css', base: 'base.css', probe: 'layout-probe.js' });
  assert.match(probed, /<script nonce="n" src="layout-probe\.js"><\/script><script nonce="n" src="tools\.js">/);
  // The probe never ships: it is left out of the package, and only the extension-host tests load it.
  assert.match(readFileSync(path.join(__dirname, '..', '..', '.vscodeignore'), 'utf8'), /^media\/shared\/layout-probe\.js$/m);
  for (const host of ['panelView', 'activityView', 'mcpView', 'toolsPage', 'modelComparisonPanel', 'teamStudioPanel', 'onboarding']) {
    const source = readFileSync(path.join(__dirname, '..', '..', 'src', 'services', `${host}.ts`), 'utf8');
    assert.match(source, /registerLayoutProbe\('/, `${host} can be measured by the extension-host tests`);
    assert.match(source, /sharedMedia\(|'shared'/, `${host} may load media/shared`);
  }
  const probe = readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'layoutProbe.ts'), 'utf8');
  assert.match(probe, /return process\.env\.NEAR_AI_E2E === '1';/);
});

test('the welcome page has its stylesheet in a file and no inline styles', () => {
  const source = readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'onboarding.ts'), 'utf8');
  assert.doesNotMatch(source, /unsafe-inline|<style/);
  assert.match(source, /style-src \$\{webview\.cspSource\}/);
  assert.match(css('onboarding/onboarding.css'), /repeat\(auto-fit, minmax\(min\(160px, 100%\), 1fr\)\)/);
});

test('Agent Activity marks its less important columns and labels each cell', () => {
  const view = readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'activityView.ts'), 'utf8');
  for (const id of ['now', 'tools', 'models', 'history']) assert.match(view, new RegExp(`<table id="${id}" class="stack-narrow[" ]`));
  assert.match(view, /<table id="now" class="stack-narrow stack-medium"/, 'agents running now become cards below 600px: their controls need the room');
  for (const column of ['Elapsed', 'Turns', 'Tool calls', 'Retries', 'Stopped', 'Tokens in', 'Tokens out', 'Agents', 'Duration']) {
    assert.match(view, new RegExp(`<th scope="col" class="num col-secondary">${column}</th>`), column);
  }
  const script = readFileSync(path.join(MEDIA, 'activity', 'activity.js'), 'utf8');
  assert.match(script, /cell\.dataset\.label = head\.querySelector\('\.sr-only'\) \? '' : head\.textContent\.trim\(\);/);
  assert.match(script, /if \(head\.classList\.contains\('col-secondary'\)\) cell\.classList\.add\('col-secondary'\);/);
  // The hidden values stay on screen (and in what a screen reader reads) under each row's name.
  assert.equal((script.match(/el\('p', 'when-narrow'\)/g) ?? []).length, 3);
});

// ---- Compare Models' script in a small DOM ----

class Node {
  children: Node[] = [];
  parent?: Node;
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  hidden = false; id = ''; className = ''; type = ''; value = ''; title = ''; checked = false; disabled = false; scope = ''; tabIndex = 0; label = ''; placeholder = '';
  private text = '';
  constructor(public tagName: string) {}
  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean);
    return { add: (name: string) => { if (!list().includes(name)) this.className = [...list(), name].join(' '); }, contains: (name: string) => list().includes(name) };
  }
  get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
  append(...nodes: Node[]) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes: Node[]) { this.children = []; this.text = ''; this.append(...nodes); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name); }
  private listeners = new Map<string, Array<(event: unknown) => void>>();
  addEventListener(type: string, listener: (event: unknown) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  /** A real click, so a control's effect is tested instead of the words around it. */
  click() { for (const listener of this.listeners.get('click') ?? []) listener({ preventDefault: () => undefined, target: this }); }
  fire(type: string, event: unknown = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  all(): Node[] { return this.children.flatMap((child) => [child, ...child.all()]); }
  querySelectorAll(selector: string): Node[] {
    const [outer, inner] = selector.split(' ');
    return this.all().filter((node) => node.tagName === outer).flatMap((node) => node.all().filter((child) => child.tagName === inner));
  }
}

async function runCompare() {
  const body = new Node('body');
  for (const id of ['board', 'trend', 'recommended', 'retest', 'setup', 'history', 'results-section', 'results', 'results-actions', 'progress', 'notice', 'problem', 'refresh']) { const node = new Node('div'); node.id = id; body.append(node); }
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const document = { getElementById: (id: string) => body.all().find((node) => node.id === id) ?? null, createElement: (tag: string) => new Node(tag), createElementNS: (_namespace: string, tag: string) => new Node(tag), createTextNode: (text: string) => { const node = new Node('#text'); node.textContent = text; return node; } };
  function Option(text: string, value: string) { const node = new Node('option'); node.textContent = text; node.value = value; return node; }
  const context = vm.createContext({ document, Option, window: { addEventListener: (_type: string, listener: (event: { data: unknown }) => void) => listeners.push(listener) }, acquireVsCodeApi: () => ({ postMessage: () => undefined }), setTimeout: () => 0, clearTimeout: () => undefined, Date, Math, JSON, Set, Object, String, Number, Boolean });
  vm.runInContext(await readFile(path.join(MEDIA, 'compare', 'compare.js'), 'utf8'), context, { timeout: 1000 });
  return { body, dispatch: (data: unknown) => listeners.forEach((listener) => listener({ data })) };
}

test('Compare Models hides less important columns on narrow panels and shows their values under the model', async () => {
  const page = await runCompare();
  const entry = {
    rank: 1, model: 'deepseek/flash', privacy: 'tee', privacyText: 'TEE', holds: [], inCatalog: true, stale: [], missingTasks: [], score: 8.1, runs: 4, tasks: ['a'],
    byKind: { coding: { score: 8.4, tasks: 1, runs: 1 } }, passRate: 0.75, passes: 3, medianSeconds: 41, tokPerSec: 55, costPerRunUsd: 0.0123, costUsd: 0.05, failures: 0, stalls: 0, lastTested: new Date().toISOString()
  };
  page.dispatch({ type: 'state', state: { leaderboard: [entry], catalog: [], roles: [], taskSets: [], history: [], selected: [] } });
  const table = page.body.all().find((node) => node.tagName === 'table')!;
  assert.ok(table.classList.contains('stack-narrow'));
  const heads = table.querySelectorAll('thead th');
  const importance = (name: string) => heads.filter((head) => head.classList.contains(name)).map((head) => head.textContent);
  assert.deepEqual(importance('col-tertiary'), ['Coding', 'Research', 'Planning', 'Execution', 'Tokens/s', 'Last tested']);
  assert.deepEqual(importance('col-secondary'), ['Passed', 'Median time', 'Cost per task', 'Reliability']);
  const row = table.querySelectorAll('tbody tr')[0];
  assert.deepEqual(row.children.map((cell) => cell.dataset.label), heads.map((head) => head.textContent), 'every cell carries its column name for the card layout');
  assert.deepEqual(row.children.filter((cell) => cell.classList.contains('col-secondary') || cell.classList.contains('col-tertiary')).length, 10);
  const lines = row.children[1].all().filter((node) => node.classList.contains('when-medium') || node.classList.contains('when-narrow')).map((node) => node.textContent);
  assert.deepEqual(lines, ['Coding 8.4 · 55 tokens/s · tested just now', 'Passed 75% · median 41 s · $0.01 per task · no failures']);
});

test('Past comparisons keep the run mode visible when the Tasks column is hidden', async () => {
  const page = await runCompare();
  const entry = { id: 'h1', startedAt: new Date().toISOString(), models: ['deepseek/flash'], taskSet: 'full', mode: 'reuse', ran: 2, reused: 1, costUsd: 0.02, status: 'completed' };
  page.dispatch({ type: 'state', state: { leaderboard: [], catalog: [], roles: [], taskSets: [], history: [entry], selected: [] } });
  const lines = page.body.all().filter((node) => node.classList.contains('when-narrow')).map((node) => node.textContent);
  assert.ok(lines.some((line) => line.includes('Full set, reused saved')), `hidden Tasks value shows the mode: ${JSON.stringify(lines)}`);
});

test('the MCP approval explanation is tied to its menu, and Tools badges wrap instead of cutting text off', () => {
  const script = readFileSync(path.join(MEDIA, 'mcp', 'mcp.js'), 'utf8');
  assert.match(script, /if \(describe\) select\.setAttribute\('aria-describedby', hint\.id\);/);
  assert.match(script, /approvalBox\.append\(approval, approvalHint\(approval, true\)\)/, 'the server row menu is described by its hint');
  assert.match(script, /approvalField\.append\(approvalHint\(approval, false\)\)/, 'the form hint sits inside its label, so it is not read twice');
  const badge = /\.badge \{[^}]*\}/.exec(css('tools/tools.css'))![0];
  assert.match(badge, /white-space: normal;/);
  assert.doesNotMatch(badge, /text-overflow: ellipsis|overflow: hidden/);
});

test('chat reply tables keep their natural width instead of filling the reply', () => {
  assert.match(css('chat/chat.css'), /\.turn \.table-wrap > table \{ width: auto; \}/);
});

// The two presets that make "re-run as new models are released" one click (owner, 2026-11-07). The banner names what is worth testing; these buttons
// tick it in the list, and the estimate runs on exactly what was ticked.
test('Compare Models selects the new and stale models with one click, and only ones it can actually run', async () => {
  const page = await runCompare();
  const entry = (id: string, blocked?: string) => ({ id, privacy: 'tee', privacyText: 'TEE', holds: [], inputPerMillion: 1, outputPerMillion: 2, ...(blocked ? { blocked } : {}) });
  page.dispatch({
    type: 'state',
    state: {
      leaderboard: [], catalog: [entry('tee/fresh'), entry('tee/stale'), entry('tee/new'), entry('tee/new-blocked', 'TEE-only mode is on')], roles: [], taskSets: [], history: [], selected: [],
      retest: { models: [{ model: 'tee/stale', why: ['Last tested 40 days ago'] }], newModels: ['tee/new', 'tee/new-blocked'] }
    }
  });
  const buttons = () => page.body.all().filter((node) => node.tagName === 'button').map((node) => node.textContent);
  // 2 new models are named, one of which this key cannot run, so its count is still 2: the banner tells the truth about the catalog, the selection skips it.
  assert.ok(buttons().some((text) => text.includes('New models (2)')), `the new-models preset is offered: ${JSON.stringify(buttons())}`);
  assert.ok(buttons().some((text) => text.includes('Worth testing again (1)')));

  const newPreset = page.body.all().find((node) => node.tagName === 'button' && node.textContent.includes('New models'))!;
  newPreset.click();
  // The page sets the type as a property, so the stub sees it there.
  const boxes = () => page.body.all().filter((node) => node.tagName === 'input' && node.type === 'checkbox');
  const ticked = () => boxes().filter((node) => node.checked).map((node) => node.value).sort();
  assert.deepEqual(ticked(), ['tee/new'], 'a model this key cannot run is not selected');

  const stalePreset = page.body.all().find((node) => node.tagName === 'button' && node.textContent.includes('Worth testing again'))!;
  stalePreset.click();
  assert.deepEqual(ticked(), ['tee/new', 'tee/stale'], 'the stale model is added to what was already chosen');
});

// The performance trend (owner, 2026-11-07): score percent over time, a line per task type, drawn on when it appears, and readable with motion off.
test('the trend chart draws a line per task type and animates it in, with less-motion respected', async () => {
  const page = await runCompare();
  const points = (percents: number[]) => percents.map((percent, index) => ({ date: `2026-11-0${index + 1}`, percent, runs: 2 }));
  page.dispatch({
    type: 'state',
    state: {
      leaderboard: [], catalog: [], roles: [], taskSets: [], history: [], selected: [],
      trend: { overall: points([50, 62, 80]), byKind: [{ kind: 'coding', points: points([40, 55, 90]) }, { kind: 'research', points: points([60, 60, 61]) }] },
      retest: { models: [], newModels: [] }, recommended: { tiers: [], roles: [] }
    }
  });
  const root = page.body.all().find((node) => node.id === 'trend')!;
  assert.equal(root.hidden, false);
  const paths = root.all().filter((node) => node.tagName === 'path');
  assert.equal(paths.length, 3, 'one line for every task and one per task type that has results');
  assert.ok(paths.every((path) => /^M[\d.]+ [\d.]+( L[\d.]+ [\d.]+)+$/.test(path.getAttribute('d') ?? '')), 'each line is a real path through its points');
  // A key names every line, so a coloured line is never unnamed.
  const key = root.all().filter((node) => node.classList.contains('trend-key')).map((node) => node.textContent).join(' ');
  assert.match(key, /All tasks: 80%/);
  assert.match(key, /coding: 90%/);
  assert.doesNotMatch(key, /planning/, 'a type with no results is not in the key');
  const css = readFileSync(path.join(MEDIA, 'compare', 'compare.css'), 'utf8');
  assert.match(css, /#trend \.trend-line \{[^}]*animation: trend-draw/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*#trend \.trend-line \{ animation: none/);
});

// The recommendation card (owner, 2026-11-08). It was never rendered by a test, so a missing helper here would only have shown up in a live window.
test('Compare Models shows the recommended setup, marks an abliterated model, and offers one button to apply it', async () => {
  const page = await runCompare();
  page.dispatch({
    type: 'state',
    state: {
      leaderboard: [], catalog: [], roles: [], taskSets: [], history: [], selected: [], retest: { models: [], newModels: [] }, trend: { overall: [], byKind: [] },
      recommended: {
        tiers: [
          { tier: 'deep', model: 'vendor/best', current: 'vendor/old', why: 'the most accurate on these tasks (9.0/10)', score: 9, changes: true, abliterated: false },
          { tier: 'fast', model: 'vendor/quick', current: 'vendor/quick', why: 'within 0.5 of the best', score: 8.6, changes: false, abliterated: false },
          { tier: 'cyber', model: 'vendor/model-abliterated', why: 'does not refuse the work', score: 8.1, changes: true, abliterated: true, note: 'These tasks do not test refusal.' }
        ],
        roles: [{ role: 'gsd-planner', setting: 'agent.roleModels', model: 'vendor/planner', current: 'vendor/old', kind: 'planning', score: 9.2, changes: true, abliterated: false, why: 'best at planning work (9.2/10)' }]
      }
    }
  });
  const root = page.body.all().find((node) => node.id === 'trend' || node.id === 'recommended');
  assert.ok(root, 'the recommendation area is in the page');
  const area = page.body.all().find((node) => node.id === 'recommended')!;
  assert.equal(area.hidden, false, 'it is shown when there are recommendations');
  const text = area.textContent;
  assert.match(text, /vendor\/best/, 'the chosen model is named');
  assert.match(text, /9\.2\/10/, 'the reason quotes its score');
  assert.match(text, /gsd-planner/, 'a role is named, not just a tier');
  assert.match(text, /already set/, 'a tier that needs no change says so');
  assert.match(text, /abliterated/, 'a model that does not refuse is marked');
  // One button applies everything that differs. Three recommendations change here, but the cyber row is skipped by the host (a scan picks its own model), so
  // the count must say 2, not 3 (0.4.19 review).
  const apply = area.all().find((node) => node.tagName === 'button' && /Apply all 2 changes/.test(node.textContent));
  assert.ok(apply, `the apply button counts the changes: ${JSON.stringify(area.all().filter((n) => n.tagName === 'button').map((n) => n.textContent))}`);
});
