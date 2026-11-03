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
  assert.match(chat, /@media \(max-width: 260px\) \{[\s\S]*\.composer \.bar \{ flex-wrap: wrap;/);
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
    teamStudioHtml({ cspSource: 'vscode-resource:', nonce: 'n', script: 'teams.js', style: 'teams.css', base: 'base.css' })
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
  addEventListener() { /* not needed */ }
  all(): Node[] { return this.children.flatMap((child) => [child, ...child.all()]); }
  querySelectorAll(selector: string): Node[] {
    const [outer, inner] = selector.split(' ');
    return this.all().filter((node) => node.tagName === outer).flatMap((node) => node.all().filter((child) => child.tagName === inner));
  }
}

async function runCompare() {
  const body = new Node('body');
  for (const id of ['board', 'setup', 'history', 'results-section', 'results', 'results-actions', 'progress', 'notice', 'problem', 'refresh']) { const node = new Node('div'); node.id = id; body.append(node); }
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const document = { getElementById: (id: string) => body.all().find((node) => node.id === id) ?? null, createElement: (tag: string) => new Node(tag), createTextNode: (text: string) => { const node = new Node('#text'); node.textContent = text; return node; } };
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
