// The product's one copy lint (FND-07, Phase 41 D-41 and D-64; GLOSSARY section 5). It reads every user copy source from the repository root and counts
// the hits of each rule per file. src/test/copy-lint-baseline.json holds today's counts, so the lint passes on the day it lands and fails on any new or
// increased count; each copy fix deletes or lowers baseline counts, and the closing plan of a phase sets NEAR_AI_BASELINE_TIGHT=1 so no stale count stays.
//
// Re-recording the baseline is one step: run this file once with NEAR_AI_WRITE_BASELINE=1 (it writes the baseline from the current scan and then fails on
// purpose, so it can never pass silently), review the diff of src/test/copy-lint-baseline.json, and run it again without the flag. A new hit is fixed in the
// copy with the glossary's user word, never by raising the baseline; re-record only to move a count with code that moved, or to drop counts a fix removed.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ALLOWED_CONTEXTS, BASELINE_PATH, CopyCounts, GLOSSARY_WORDS, MODEL_INSTRUCTIONS, REPO_ROOT, baselineText, compareWithBaseline, copySourceFiles, countHits,
  extractCopy, extractPackage, increaseMessage, readBaseline, scanRepository, writeBaselineAndFail
} from './helpers/copyLintScan';

const EM_DASH = String.fromCharCode(0x2014);

test('D-41: a planted em-dash in a command title and a setting description is counted under package.json', () => {
  const manifest = {
    contributes: {
      commands: [{ command: 'nearAi.example', title: `Open the example ${EM_DASH} quickly`, category: 'NEAR AI' }],
      configuration: { title: 'NEAR AI', properties: { 'nearAi.example': { type: 'boolean', description: `Turns the example on ${EM_DASH} or off.` } } }
    }
  };
  const texts = extractPackage(manifest);
  assert.deepEqual(countHits(texts, 'package.json'), { 'package.json': { 'em-dash': 2 } });
  // Without the planted dashes nothing is counted.
  const clean = JSON.parse(JSON.stringify(manifest).split(EM_DASH).join(',')) as unknown;
  assert.deepEqual(countHits(extractPackage(clean), 'package.json'), {});
});

test('D-41: the package source reads command, setting, view and view container text', () => {
  const manifest = {
    contributes: {
      commands: [{ command: 'a', title: 'T1', category: 'C1' }],
      configuration: [{ title: 'S0', properties: { a: { description: 'D1', markdownDescription: 'M1', enumDescriptions: ['E1', 'E2'], deprecationMessage: 'X1' } } }],
      views: { container: [{ id: 'v', name: 'V1' }] },
      viewsContainers: { activitybar: [{ id: 'c', title: 'VC1' }] }
    }
  };
  const texts = extractPackage(manifest).map((entry) => entry.text).sort();
  for (const expected of ['T1', 'C1', 'D1', 'M1', 'E1', 'E2', 'X1', 'V1', 'VC1']) assert.ok(texts.includes(expected), expected);
});

test('D-41: the ratchet fails on a new or increased count and passes on an equal or lower one', () => {
  const baseline: CopyCounts = { 'a.ts': { 'em-dash': 2 }, 'b.ts': { 'em-dash': 1 } };
  assert.deepEqual(compareWithBaseline({ 'a.ts': { 'em-dash': 2 }, 'b.ts': { 'em-dash': 1 } }, baseline), { increased: [], stale: [] });
  const lower = compareWithBaseline({ 'a.ts': { 'em-dash': 1 } }, baseline);
  assert.deepEqual(lower.increased, []);
  assert.deepEqual(lower.stale, ['a.ts  em-dash  2 -> 1', 'b.ts  em-dash  1 -> 0']);
  const higher = compareWithBaseline({ 'a.ts': { 'em-dash': 3 }, 'b.ts': { 'em-dash': 1 }, 'c.ts': { 'em-dash': 1 } }, baseline);
  assert.deepEqual(higher.increased, ['a.ts  em-dash  2 -> 3', 'c.ts  em-dash  0 -> 1']);
  assert.deepEqual(higher.stale, []);
  const message = increaseMessage(higher.increased);
  assert.match(message, /em-dash/);
  assert.match(message, /c\.ts/);
  assert.match(message, /a colon, a comma or two sentences/);
  assert.match(message, /total must not grow/);
});

test('D-41: the baseline text is sorted, two-space indented, ends in a newline and leaves zero counts out', () => {
  const text = baselineText({ 'z.ts': { 'em-dash': 1 }, 'a.ts': { 'em-dash': 0 }, 'm.ts': { 'em-dash': 3 } });
  assert.equal(text, '{\n  "m.ts": {\n    "em-dash": 3\n  },\n  "z.ts": {\n    "em-dash": 1\n  }\n}\n');
});

test('D-41: the write mode writes the baseline and then fails on purpose', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'near-ai-copy-lint-')), 'baseline.json');
  const counts: CopyCounts = { 'b.ts': { 'em-dash': 1 }, 'a.ts': { 'em-dash': 2 } };
  assert.throws(() => writeBaselineAndFail(file, counts), /baseline written; review the diff and run again without NEAR_AI_WRITE_BASELINE/);
  assert.equal(readFileSync(file, 'utf8'), baselineText(counts));
});

// ---- Every copy source (Task 2) ----

const SERVICE = 'src/services/example.ts';
const texts = (source: string, file = SERVICE): string[] => extractCopy(source, file).map((entry) => entry.text);
const one = (text: string, file = SERVICE, title = false): CopyCounts[string] => countHits([title ? { text, title } : { text }], file)[file] ?? {};

test('D-41 source: a show*Message call gives its message and its buttons', () => {
  const source = `import * as vscode from 'vscode';\nvoid vscode.window.showWarningMessage('Remove the example ${EM_DASH} for good?', { modal: true }, 'Remove ${EM_DASH} now');\n`;
  assert.deepEqual(texts(source), [`Remove the example ${EM_DASH} for good?`, `Remove ${EM_DASH} now`]);
  assert.deepEqual(countHits(extractCopy(source, SERVICE), SERVICE), { [SERVICE]: { 'em-dash': 2 } });
});

test('D-41 source: a quick pick call gives item labels, descriptions, details, its title and placeholder, and no ids', () => {
  const source = `import * as vscode from 'vscode';\nvoid vscode.window.showQuickPick([{ label: 'First', description: 'The first one', detail: 'More words', id: 'first-id' }], { title: 'Pick one', placeHolder: 'Type to filter', matchOnDescription: true });\n`;
  assert.deepEqual(texts(source), ['First', 'The first one', 'More words', 'Pick one', 'Type to filter']);
});

test('D-41 source: a webview panel gives its title, marked as a title, and not its view type', () => {
  const source = `import * as vscode from 'vscode';\nvscode.window.createWebviewPanel('nearAiExample', 'Example Room', vscode.ViewColumn.One, { enableScripts: true });\n`;
  assert.deepEqual(extractCopy(source, SERVICE), [{ text: 'Example Room', title: true }]);
});

test('D-41 source: exported text constants and *_REFUSALS and *_FAILURES records give their string values', () => {
  const suffixes = ['TEXT', 'TITLE', 'DETAIL', 'PROMPT', 'ACTION', 'LABEL', 'PLACEHOLDER', 'QUESTION', 'NOTICE'];
  const source = [
    ...suffixes.map((suffix) => `export const EXAMPLE_${suffix} = 'Words for ${suffix}';`),
    `export const EXAMPLE_REFUSALS = Object.freeze({ 'not-allowed': 'You cannot do that here.' });`,
    `export const EXAMPLE_FAILURES: Readonly<Record<string, string>> = Object.freeze({ broken: 'The file could not be read.' });`,
    `export const EXAMPLE_REFUSALS_NAMED_AHEAD = Object.freeze({ 'route.example': 'Nothing was sent.' });`,
    `export const EXAMPLE_REJECTIONS = { stale: 'This entry is out of date.' };`,
    `export const EXAMPLE_PROBLEMS = { gap: 'A line is missing.', kinds: ['hub-revoked', 'nearAi.example'] };`,
    `export const EXAMPLE_ID = 'Not copy at all';`,
    `const HIDDEN_TEXT = 'Not exported';`
  ].join('\n');
  assert.deepEqual(texts(source, 'src/domain/example.ts'), [
    ...suffixes.map((suffix) => `Words for ${suffix}`), 'You cannot do that here.', 'The file could not be read.', 'Nothing was sent.', 'This entry is out of date.',
    'A line is missing.'
  ]);
});

test('D-41 source: a model instruction listed in MODEL_INSTRUCTIONS is not copy, and each listed constant is exported where the table says', () => {
  const source = 'export const TEAM_BUILDER_PROMPT = `You design agent teams. Reply with one object.`;\n';
  assert.deepEqual(texts(source, 'src/agent/teamBuilder.ts'), []);
  assert.deepEqual(texts(source, 'src/agent/otherBuilder.ts'), ['You design agent teams. Reply with one object.']);
  for (const row of MODEL_INSTRUCTIONS) {
    const text = readFileSync(path.join(REPO_ROOT, row.file), 'utf8');
    assert.match(text, new RegExp(`export const ${row.name}\\b`), `${row.file} exports ${row.name}`);
    assert.ok(row.why.length > 10, `${row.name} has a reason`);
  }
});

test('D-41 source: host-built HTML in a services file gives the text between tags, with ${...} removed', () => {
  const source = 'const name = "x";\nexport const html = `<!doctype html><html><head><style>p { color: red; }</style></head><body><h1>Example page</h1><p class="hint">Some ${name} words</p><button type="button" title="Open the example">Open</button></body></html>`;\n';
  assert.deepEqual(texts(source), ['Example page', 'Some words', 'Open', 'Open the example']);
  // The same template outside src/services is not host-built HTML.
  assert.deepEqual(texts(source, 'src/domain/example.ts'), []);
});

test('D-41 source: a page script gives strings that hold words, and not identifiers or selectors', () => {
  const file = 'media/example/example.js';
  const source = [
    `const vscode = acquireVsCodeApi();`,
    `const id = 'nearAiMcp';`,
    `document.querySelector('#servers .row').addEventListener('click', () => vscode.postMessage({ type: 'save' }));`,
    `status.textContent = 'Saved the example';`,
    'label.textContent = `Ready`;',
    `row.innerHTML = '<span class="muted">No tools yet</span>';`,
    `const box = make('div', 'room-process room-squads');`
  ].join('\n');
  assert.deepEqual(texts(source, file), ['Saved the example', 'Ready', 'No tools yet']);
});

test('D-41 source: the real scan reads package.json, src outside src/test, and media outside media/vendor', () => {
  const files = copySourceFiles();
  for (const expected of ['package.json', 'src/services/mcpView.ts', 'src/services/onboarding.ts', 'media/mcp/mcp.js', 'media/cyber/cyber.html']) assert.ok(files.includes(expected), expected);
  assert.ok(!files.some((file) => file.startsWith('src/test/') || file.startsWith('media/vendor/')), 'no test or vendor file');
  assert.ok(!files.includes('src/domain/org/modes.ts') && !files.includes('src/domain/org/terms.ts'), 'the mode table is never scanned');
});

// ---- Rule 1: glossary words (Task 2) ----

test('D-41 rule 1: glossary words never on main screens are counted once each', () => {
  for (const word of ['TEE', 'tier', 'endpoint', 'attestation', 'policy bundle', 'issuer', 'replica', 'GSD', 'nearai-tee', 'Open-GSD', 'T0 lane', 'model passport']) {
    assert.deepEqual(one(`This mentions ${word} here.`), { glossary: 1 }, word);
  }
  for (const word of ['tee-only', 'GitHub', 'tiered', 'your organization\'s server']) assert.deepEqual(one(`This mentions ${word} here.`), {}, word);
});

test('D-41 rule 1: allowed contexts: GSD on the Tools page and attestation in the trust details pane are not counted', () => {
  assert.deepEqual(one('Run a GSD workflow', 'src/services/toolsPage.ts'), {});
  assert.deepEqual(one('Run a GSD workflow', 'media/tools/tools.js'), {});
  assert.deepEqual(one('The attestation report', 'src/services/trustDetails.ts'), {});
  // An allowed word in one file is not allowed in another, and a file's row allows only its own words.
  assert.deepEqual(one('The attestation report', 'src/services/toolsPage.ts'), { glossary: 1 });
  assert.deepEqual(one('Run a GSD workflow', 'src/services/trustDetails.ts'), { glossary: 1 });
});

test('D-64 rule 1: export-control words are counted outside the label module and the rules page', () => {
  const planted = ['CGP', 'ITAR', 'EAR', 'regime', 'regimes', 'exportControl', 'export-person', 'export-endpoint', 'designated official', 'empowered official'];
  for (const word of planted) assert.deepEqual(one(`Marked ${word} today.`), { glossary: 1 }, word);
  for (const word of ['YEAR', 'CLEAR', 'Controlled goods (Canada)']) assert.deepEqual(one(`Marked ${word} today.`), {}, word);
  for (const word of ['CGP', 'ITAR', 'EAR']) assert.deepEqual(one(`Marked ${word} today.`, 'src/domain/gate/labels.ts'), {}, word);
  for (const file of ['src/services/policyEditor.ts', 'media/policy/policy.js']) {
    for (const word of planted) assert.deepEqual(one(`Marked ${word} today.`, file), {}, `${file} ${word}`);
  }
  assert.deepEqual(one('Marked regime today.', 'src/domain/gate/labels.ts'), { glossary: 1 }, 'the label module allows only the three tokens');
});

test('D-41 rule 1: every allowed-context file exists and names only glossary words, each row with a reason', () => {
  const words = new Set(GLOSSARY_WORDS.map((entry) => entry.word));
  assert.ok(ALLOWED_CONTEXTS.length >= 6);
  for (const row of ALLOWED_CONTEXTS) {
    assert.ok(existsSync(path.join(REPO_ROOT, row.file)), `${row.file} exists`);
    assert.ok(row.why.length > 10, `${row.file} has a reason`);
    for (const word of row.words) assert.ok(words.has(word), `${row.file}: ${word} is a glossary word`);
  }
  assert.ok(ALLOWED_CONTEXTS.some((row) => row.file === 'src/domain/gate/labels.ts'), 'the label module row');
  assert.ok(readFileSync(path.join(REPO_ROOT, 'src/domain/gate/labels.ts'), 'utf8').includes('US export-controlled (EAR)'), 'the label module holds the shown words');
});

// ---- Rule 3: brand and title prefix (Task 2) ----

test('D-41 rule 3: a misspelt brand and a brand prefix on a title are counted', () => {
  for (const word of ['Near AI', 'NearAI', 'Near Ai', 'near ai', 'VSCode', 'Vscode', 'VS code', 'vscode']) assert.deepEqual(one(`Open ${word} now.`), { brand: 1 }, word);
  assert.deepEqual(one('NEAR AI: Something', SERVICE, true), { brand: 1 });
  assert.deepEqual(one('Near AI: Something', SERVICE, true), { brand: 1 }, 'the prefix counts once, not also as a misspelling');
  assert.deepEqual(one('near ai: Something', SERVICE, true), { brand: 1 });
  for (const word of ['NEAR AI', 'VS Code', 'near-ai-vscode', 'vscode.open', '@vscode/vsce', 'nearAi.baseUrl']) assert.deepEqual(one(`Open ${word} now.`), {}, word);
  assert.deepEqual(one('NEAR AI: Something'), {}, 'a prefix only counts on a title');
});

// ---- Rule 5: the provider's name before organization (Task 2) ----

test('D-41 rule 5: the provider\'s name before organization is counted in its three spellings', () => {
  const provider = ['NE', 'AR'].join('');
  for (const name of [provider, `${provider} AI`, `${provider} AI's`]) {
    assert.deepEqual(one(`Ask the ${name} ${'organ'}ization for access.`), { 'provider-organization': 1 }, name);
    assert.deepEqual(one(`Ask the ${name} ${'organ'}isation for access.`), { 'provider-organization': 1 }, `${name} (British spelling)`);
  }
  assert.deepEqual(one('Ask your organization for access.'), {});
  assert.deepEqual(one('NEAR AI is only the provider; your organization decides.'), {});
});

test('D-41: the repository passes against its baseline', () => {
  const counts = scanRepository();
  if (process.env.NEAR_AI_WRITE_BASELINE === '1') writeBaselineAndFail(BASELINE_PATH, counts);
  const { increased } = compareWithBaseline(counts, readBaseline());
  assert.deepEqual(increased, [], increaseMessage(increased));
});
