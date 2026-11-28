// The product's one copy lint (FND-07, Phase 41 D-41 and D-64; GLOSSARY section 5). It reads every user copy source from the repository root and counts
// the hits of each rule per file. src/test/copy-lint-baseline.json holds today's counts, so the lint passes on the day it lands and fails on any new or
// increased count; each copy fix deletes or lowers baseline counts, and the closing plan of a phase sets NEAR_AI_BASELINE_TIGHT=1 so no stale count stays.
//
// Re-recording the baseline is one step: run this file once with NEAR_AI_WRITE_BASELINE=1 (it writes the baseline from the current scan and then fails on
// purpose, so it can never pass silently), review the diff of src/test/copy-lint-baseline.json, and run it again without the flag. A new hit is fixed in the
// copy with the glossary's user word, never by raising the baseline; re-record only to move a count with code that moved, or to drop counts a fix removed.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MODES, ModeId, ModeRow } from '../domain/org/modes';
import {
  ALLOWED_CLAIM_CONTEXTS, ALLOWED_CONTEXTS, BASELINE_PATH, COMPLIANCE_CLAIMS, COPY_RULES, CopyCounts, DISTINCTIVE_MODE_WORDS, GLOSSARY_WORDS, MODEL_INSTRUCTIONS,
  REPO_ROOT, baselineText, checkTightness, compareWithBaseline, copySourceFiles, countHits, extractCopy, extractPackage, increaseMessage, modeWordsFromTable,
  documentationFiles, overclaimHits, productNameHits, readBaseline, scanRepository, writeBaselineAndFail
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
    `const box = make('div', 'room-process room-squads');`,
    'dot.className = `team-dot dot-${state}`;',
    'badge.title = `team-dot dot-${state}`;'
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

test('rule 1 (owner, 2026-11-24): the staff team\'s shared room is the Staff Room, never the Staff Center, and the Planning page says so', () => {
  const pageFile = 'workbench/extension/src/browser/sterling-work-areas-module.ts';
  for (const text of ['Open Staff Center', 'Open the staff centre']) assert.deepEqual(one(text, pageFile), { glossary: 1 }, text);
  assert.deepEqual(one('Open Staff Room', pageFile), {});
  const page = readFileSync(path.join(REPO_ROOT, pageFile), 'utf8');
  assert.match(page, /label: 'Open Staff Room', command: 'nearAi\.openStaffRoom'/);
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
  assert.deepEqual(one('NEAR AI: Something'), { 'product-name': 1 }, 'off a title a prefix is the old command prefix (rule 8), not a brand hit');
});

// ---- Rule 8: the product is Sterling Sovereign AI, short name SovAI; NEAR AI is only the provider (owner, 2026-11-24) ----

test('rule 8: the old product names and a NEAR AI: command prefix count, the provider and the new names do not', () => {
  assert.deepEqual(one('Thanks for using NEAR AI for VS Code.'), { 'product-name': 1 });
  assert.deepEqual(one('Update the NEAR AI extension, then open the file again.'), { 'product-name': 1 });
  assert.deepEqual(one('Open your policy with NEAR AI: Policy, then choose Edit my rules.'), { 'product-name': 1 });
  assert.deepEqual(one('Run "Near AI: Resume" first.'), { brand: 1, 'product-name': 1 }, 'a misspelt prefix is both');
  assert.deepEqual(one('NEAR AI: Policy', SERVICE, true), { brand: 1 }, 'a title prefix counts once, as the brand rule');
  assert.deepEqual(one('Policy, then NEAR AI: Set Label', SERVICE, true), { 'product-name': 1 }, 'a prefix later in a title is rule 8');
  for (const text of ['Open SovAI: Policy.', 'Sterling Sovereign AI keeps your rules.', 'Choose a model on NEAR AI Cloud.', 'NEAR AI private hardware',
    'Update SovAI to use them.']) assert.deepEqual(one(text), {}, text);
});

test('rule 8: README, SECURITY.md, CONTRIBUTING.md and the guides never use the old product names', () => {
  const files = documentationFiles();
  for (const file of ['README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'docs-site/docusaurus.config.js', 'docs/development-workflow.md']) assert.ok(files.includes(file), file);
  assert.ok(files.some((file) => file.startsWith('docs-site/content/')), 'the docs site guides');
  assert.ok(!files.includes('CHANGELOG.md'), 'history is not read');
  // The whole file at once, so a name wrapped over two lines still counts.
  const hits = files.flatMap((file) => {
    const count = productNameHits(readFileSync(path.join(REPO_ROOT, file), 'utf8'));
    return count > 0 ? [`${file}: ${String(count)}`] : [];
  });
  assert.deepEqual(hits, [], 'say "Sterling Sovereign AI" or "SovAI" for the product and "SovAI:" for its commands');
});

// ---- D-33: the Sterling workbench's sources and its edition names (Phase 46) ----

const WORKBENCH_PAGE = 'workbench/extension/src/browser/example-module.ts';

test('D-33 workbench: the real scan reads the workbench browser, common and backend sources, and no build output, test or declaration file', () => {
  const files = copySourceFiles();
  for (const expected of ['workbench/extension/src/browser/sterling-welcome-module.ts', 'workbench/extension/src/common/team-preview.ts',
    'workbench/extension/src/node/team-preview-reader.ts']) assert.ok(files.includes(expected), expected);
  const outside = files.filter((file) => file.startsWith('workbench/') && !/^workbench\/extension\/src\/(?:browser|common|node)\//.test(file));
  assert.deepEqual(outside, [], 'nothing under workbench/node_modules, workbench/lib or workbench/test');
  assert.ok(!files.some((file) => file.startsWith('workbench/') && (file.endsWith('.d.ts') || !file.endsWith('.ts'))), 'only .ts sources, never a .d.ts');
});

test('D-33 rule 3: the Sterling edition names count zero, while sovereign elsewhere and a misspelt NEAR AI still count', () => {
  const edition = one('Sterling Sovereign AI (Canadian Defence Edition)', WORKBENCH_PAGE);
  assert.deepEqual(edition, {});
  const command = one('SovAI: Open Team Studio Preview', WORKBENCH_PAGE, true);
  assert.equal(command.glossary, undefined, 'SovAI is the command category');
  assert.equal(command.brand, undefined, 'a SovAI prefix is not a brand prefix');
  assert.deepEqual(one('Your sovereign data stays here.', WORKBENCH_PAGE), { glossary: 1 }, 'sovereign outside the edition name is the glossary word');
  assert.deepEqual(one('Sovereign AI for your organization.', WORKBENCH_PAGE), { glossary: 1 }, 'only the whole edition name is a name');
  assert.deepEqual(one('Open Near AI now.', WORKBENCH_PAGE), { brand: 1 });
  // The Get Started heading breaks the edition name over two lines; it is still one name.
  const heading = "node.innerHTML = '<h1 id=\"sterling-title\">Sterling<br>Sovereign AI</h1>';";
  assert.deepEqual(texts(heading, WORKBENCH_PAGE), ['Sterling Sovereign AI']);
  assert.deepEqual(countHits(extractCopy(heading, WORKBENCH_PAGE), WORKBENCH_PAGE), {});
});

test('D-33 workbench: a workbench page gives its text arguments, and not class names, Symbol descriptions, command ids or CSS imports', () => {
  const source = [
    `import './team-preview.css';`,
    `export const TeamPreviewService = Symbol('TeamPreviewService');`,
    `const open = { id: 'sterling.getStarted', label: 'Get Started', command: 'sterling.getStarted' };`,
    `function element(tag, className, text) { return document.createElement(tag); }`,
    `header.append(element('h1', undefined, 'Get Started'), element('div', 'team-preview'), element('div', 'card wide', 'Ready'));`
  ].join('\n');
  assert.deepEqual(texts(source, WORKBENCH_PAGE), ['Get Started', 'Get Started', 'Ready']);
  // The class name argument is found from the helper's own parameters: a module whose helper takes (tag, text, className) keeps its text as copy.
  const other = [
    `function element(tag, text, className) { return document.createElement(tag); }`,
    `body.append(element('p', 'Published evidence for your review', 'card wide'));`
  ].join('\n');
  assert.deepEqual(texts(other, 'workbench/extension/src/common/example.ts'), ['Published evidence for your review']);
});

test('W3 workbench backend: what it sends to the browser is copy (text constants, result fields, refused() arguments), a start error is not', () => {
  const backend = 'workbench/extension/src/node/example.ts';
  const source = [
    `const UNAVAILABLE = { kind: 'missing', message: 'The shipped sample is unavailable.' };`,
    `const projects = [{ id: 'orchard', title: 'Orchard sample', fixture: 'orchard.md' }];`,
    `const LOCAL_TEXT = 'Signing is not available on this computer.';`,
    `function read(error) { return { kind: 'invalid', message: error instanceof Error ? error.message : 'The sample could not be read.' }; }`,
    `function sign() { return refused('Your signing key is not set up yet.', 'Ask your administrator.'); }`,
    `function start() { throw new Error('STERLING_MODEL_SERVERS must be a JSON array of addresses.'); }`,
    `console.error('The Sterling workbench cannot start.');`,
  ].join('\n');
  assert.deepEqual(texts(source, backend), ['The shipped sample is unavailable.', 'Orchard sample', 'Signing is not available on this computer.',
    'The sample could not be read.', 'Your signing key is not set up yet.', 'Ask your administrator.']);
  assert.deepEqual(countHits(extractCopy(`const missing = { message: 'This sample has no team file.' };`, backend), backend), { [backend]: { 'bare-team': 1 } });
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

// ---- Rule 2: mode words (Task 3) ----

test('D-41 rule 2: a mode word spelled in copy is counted', () => {
  for (const word of ['Report for duty', 'Work team admin', 'Tasking authority', 'Defence team member', 'Dual-hatted', 'Relief in place', 'Commander\'s decision']) {
    assert.deepEqual(one(`Choose ${word} below.`), { 'mode-word': 1 }, word);
  }
  // The table is where the words live: modes.ts and terms.ts are never scanned.
  for (const file of ['src/domain/org/modes.ts', 'src/domain/org/terms.ts']) assert.deepEqual(one('Report for duty', file), {}, file);
  // A single ordinary word that is a mode word is not counted.
  for (const word of ['Position', 'Member', 'Accept', 'Decline', 'Approved', 'Handover']) assert.deepEqual(one(`Choose ${word} below.`), {}, word);
});

test('D-41 rule 2 reads MODES: the mode word list is the multi-word words of MODES plus the distinctive single words', () => {
  const expected = new Set<string>(DISTINCTIVE_MODE_WORDS);
  for (const row of Object.values(MODES)) {
    for (const entry of Object.values(row.words)) for (const word of [entry.word, ...(entry.also ?? [])]) if (/\s/.test(word)) expected.add(word);
  }
  assert.deepEqual([...modeWordsFromTable()].sort(), [...expected].sort());
  assert.ok(expected.size > 30);
  // A word added to the table is linted without editing the lint.
  const added = { ...MODES, corporate: { ...MODES.corporate, words: { ...MODES.corporate.words, lead: { word: 'Crew chief of work' } } } } as Readonly<Record<ModeId, ModeRow>>;
  const words = modeWordsFromTable(added);
  assert.ok(words.includes('Crew chief of work'));
  assert.deepEqual(countHits([{ text: 'Ask the Crew chief of work.' }], SERVICE, { modeWords: words })[SERVICE]?.['mode-word'], 1);
  assert.equal(countHits([{ text: 'Ask the Crew chief of work.' }], SERVICE)[SERVICE]?.['mode-word'], undefined);
});

// ---- Rule 6: a bare team (Task 3) ----

test('owner 2026-11-20 rule 6: a bare team is counted', () => {
  for (const word of ['team', 'Teams', 'team\'s', 'Team Mode', 'Team Studio', 'team-lead']) assert.equal(one(`Open the ${word} page.`)['bare-team'], 1, word);
  for (const word of ['agent team', 'work team', 'Agent teams', 'Microsoft Teams', 'agent-team', 'Defence team', 'steam', 'teammate']) {
    assert.equal(one(`Open the ${word} page.`)['bare-team'], undefined, word);
  }
  assert.equal(one('A team and two agent teams and Teams.')['bare-team'], 2);
});

// ---- Rule 7: compliance claims about the product (Task 3) ----

test('D-64 rule 7: a compliance claim about the product is counted, the longest phrase once', () => {
  const claim = (text: string, file = SERVICE): number | undefined => one(text, file)['compliance-claim'];
  assert.equal(claim('NEAR AI is ITAR compliant'), 1);
  for (const phrase of ['ITAR certified', 'CGP compliant', 'CGP approved', 'export compliant', 'controlled goods approved', 'certified', 'accredited', 'compliant']) {
    assert.equal(claim(`This extension is ${phrase} for your work.`), 1, phrase);
  }
  assert.ok(COMPLIANCE_CLAIMS.length >= 9);
  // Honest uses: the claim's own sentence negates it before the phrase.
  for (const honest of ['This product is not certified for ITAR work', 'NEAR AI does not make a device accredited', 'It never claims to be compliant',
    'This extension isn\'t certified.', 'No part of it is accredited.', 'It cannot be export compliant on its own.', 'Use it without certified hardware.']) {
    assert.equal(claim(honest), undefined, honest);
  }
  // A negation in an earlier sentence does not cover a later claim.
  assert.equal(claim('This is not new. The extension is certified.'), 1);
});

test('D-64 rule 7: a phrase in a file listed in the claim contexts is not counted, and the table starts empty', () => {
  assert.deepEqual(ALLOWED_CLAIM_CONTEXTS, []);
  const contexts = [{ file: 'src/services/compliancePage.ts', phrases: ['certified'], why: 'a compliance page shows a status with its evidence' }];
  const counted = (file: string, text: string): number | undefined => countHits([{ text }], file, { claimContexts: contexts })[file]?.['compliance-claim'];
  assert.equal(counted('src/services/compliancePage.ts', 'Supplier certified on the date shown.'), undefined);
  assert.equal(counted('src/services/compliancePage.ts', 'The extension is compliant.'), 1, 'only the listed phrases');
  assert.equal(counted('src/services/other.ts', 'Supplier certified on the date shown.'), 1, 'only the listed file');
});

// ---- Rule 7: sovereignty overclaims (48.4 D-35; GLOSSARY section 5 rule 6) ----

const OVERCLAIMS = ['fully sovereign', '100% sovereign', '100% Canadian', 'sovereign by default', 'sovereignty certified', 'certified sovereign'];

test('48.4 D-35 overclaim in copy: each sovereignty overclaim counts once, in any case, in a command title, a message and a workbench common module', () => {
  const common = 'workbench/extension/src/common/example.ts';
  for (const phrase of OVERCLAIMS) {
    for (const variant of [phrase, phrase.toUpperCase(), phrase.replace(/^./, (first) => first.toUpperCase())]) {
      const manifest = { contributes: { commands: [{ command: 'nearAi.example', title: `SovAI: Show ${variant} status`, category: 'SovAI' }] } };
      assert.equal(countHits(extractPackage(manifest), 'package.json')['package.json']?.['compliance-claim'], 1, `title: ${variant}`);
      const message = `import * as vscode from 'vscode';\nvoid vscode.window.showInformationMessage('This workspace is ${variant} now.');\n`;
      assert.equal(countHits(extractCopy(message, SERVICE), SERVICE)[SERVICE]?.['compliance-claim'], 1, `message: ${variant}`);
      const module = `export const STATUS = 'This workspace is ${variant} now.';\n`;
      assert.equal(countHits(extractCopy(module, common), common)[common]?.['compliance-claim'], 1, `common module: ${variant}`);
    }
  }
  // The longest phrase wins: "certified sovereign" and "sovereignty certified" are one claim each, never also "certified".
  assert.equal(one('The product is certified sovereign.')['compliance-claim'], 1);
  assert.equal(one('The product is sovereignty certified.')['compliance-claim'], 1);
  // The product's name is a name, never a claim.
  assert.equal(one('Sterling Sovereign AI keeps your rules.')['compliance-claim'], undefined);
  for (const phrase of OVERCLAIMS) assert.ok(COMPLIANCE_CLAIMS.includes(phrase), phrase);
});

test('48.4 D-35 honest negation: a sentence that negates the overclaim before it is not counted', () => {
  for (const honest of ['SovAI is not fully sovereign today.', 'Nothing here is 100% Canadian.', 'It is never sovereign by default.']) {
    assert.equal(one(honest)['compliance-claim'], undefined, honest);
    assert.deepEqual(overclaimHits(honest), [], honest);
  }
  assert.deepEqual(overclaimHits('This is not new. SovAI is fully sovereign.'), ['fully sovereign'], 'a negation in an earlier sentence does not cover it');
  // overclaimHits reads only the six sovereignty phrases, never the general claims.
  assert.deepEqual(overclaimHits('The extension is certified and compliant.'), []);
});

test('48.4 D-35 overclaim in documentation: the guides and README files never overclaim, and a planted line is named with its file and phrase', () => {
  const scan = (root: string): string[] => documentationFiles(root).flatMap((file) =>
    overclaimHits(readFileSync(path.join(root, file), 'utf8')).map((phrase) => `${file}: ${phrase}`));
  // A fixture repository with one honest and one overclaiming page.
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-overclaim-'));
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  mkdirSync(path.join(root, 'docs-site', 'content', 'security'), { recursive: true });
  writeFileSync(path.join(root, 'README.md'), '# Sterling Sovereign AI\n\nSovAI is not fully sovereign, and the card says why.\n');
  writeFileSync(path.join(root, 'docs-site', 'content', 'security', 'planted.md'), '# Planted\n\nThis product is 100% Canadian\nand more.\n');
  assert.deepEqual(scan(root), ['docs-site/content/security/planted.md: 100% Canadian']);
  // The real repository: the whole file at once, like rule 8.
  assert.deepEqual(scan(REPO_ROOT), [], 'say what the sovereignty card shows, never "fully sovereign", "100% Canadian" or another overclaim');
});

// ---- Rule 1: "Sovereignty" only in the badge and card sources (48.4 D-35, D-04) ----

test('48.4 D-35 sovereignty word: Sovereignty is a glossary word outside its allowed contexts; SEAL and sovereignty score count everywhere', () => {
  const card = 'src/domain/sovereignty/words.ts';
  const contexts = [{ file: card, words: ['sovereignty'], why: 'the badge and card words (test row)' }];
  const counted = (text: string, file: string): number | undefined => countHits([{ text }], file, { allowedContexts: contexts })[file]?.glossary;
  for (const text of ['Sovereignty: Met', 'Open the sovereignty card.', 'SOVEREIGNTY']) {
    assert.equal(counted(text, SERVICE), 1, `${text} outside the card`);
    assert.equal(counted(text, card), undefined, `${text} in the card`);
  }
  for (const text of ['The SEAL level is 3.', 'Your sovereignty score is high.']) {
    assert.equal(counted(text, SERVICE), 1, `${text} outside the card`);
    assert.equal(counted(text, card), 1, `${text} in the card`);
  }
  // SEAL is case-sensitive: the ordinary word "seal" (a sealed vault) is not the glossary word.
  assert.equal(counted('The vault is sealed and the seal type is pkcs11.', SERVICE), undefined);
  // The edition's name is still a name, and "sovereign" alone is still its own glossary word.
  assert.equal(counted('Sterling Sovereign AI', SERVICE), undefined);
  assert.equal(counted('A sovereign region.', card), 1);
  for (const word of ['sovereignty', 'SEAL', 'sovereignty score']) assert.ok(GLOSSARY_WORDS.some((entry) => entry.word === word), word);
});

test('48.4 D-35 sovereignty sources: src/domain/sovereignty is read as user copy (every string literal) when it exists, and skipped when absent', () => {
  const file = 'src/domain/sovereignty/words.ts';
  const source = [
    `export const DIMENSIONS = { 'data-stored': 'Where your data is stored' };`,
    `const reason = 'Declared by your operator, not verified';`,
    `const slug = 'data-stored';`
  ].join('\n');
  assert.deepEqual(texts(source, file), ['Where your data is stored', 'Declared by your operator, not verified']);
  // The same source elsewhere in src/domain gives only exported text constants (none here).
  assert.deepEqual(texts(source, 'src/domain/example.ts'), []);
  // A fixture repository with the folder lists it; the real scan works whether or not it exists yet.
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-sovereignty-'));
  mkdirSync(path.join(root, 'src', 'domain', 'sovereignty'), { recursive: true });
  mkdirSync(path.join(root, 'media'), { recursive: true });
  for (const folder of ['workbench/extension/src/browser', 'workbench/extension/src/common', 'workbench/extension/src/node']) mkdirSync(path.join(root, folder), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), '{}');
  writeFileSync(path.join(root, file), source);
  assert.ok(copySourceFiles(root).includes(file));
  assert.equal(copySourceFiles().includes(file), existsSync(path.join(REPO_ROOT, file)));
});

// ---- The baseline (Task 1, final in Task 3) ----

test('D-41: the repository passes against its baseline', () => {
  const counts = scanRepository();
  if (process.env.NEAR_AI_WRITE_BASELINE === '1') writeBaselineAndFail(BASELINE_PATH, counts);
  const { increased } = compareWithBaseline(counts, readBaseline());
  assert.deepEqual(increased, [], increaseMessage(increased));
});

test('D-41: the baseline file is sorted, uses only the copy rules and holds no zero count', () => {
  const text = readFileSync(BASELINE_PATH, 'utf8');
  const baseline = readBaseline();
  assert.equal(text, baselineText(baseline), 'the file is exactly its sorted text');
  for (const [file, rules] of Object.entries(baseline)) {
    for (const [rule, count] of Object.entries(rules)) {
      assert.ok((COPY_RULES as readonly string[]).includes(rule), `${file}: ${rule} is a rule`);
      assert.ok(Number.isInteger(count) && (count ?? 0) > 0, `${file} ${rule}: ${String(count)}`);
    }
  }
  for (const rule of ['glossary', 'em-dash', 'bare-team', 'mode-word', 'compliance-claim']) {
    assert.ok(Object.values(baseline).some((rules) => (rules as Record<string, number>)[rule] !== undefined), `today's copy has ${rule} hits`);
  }
  // Paid off: the SovAI rename removed the last brand hits (the old "Near AI: First Project" title and "Near AI for VSCode" copy), which are the
  // old product names rule 8 now also counts. Both rules stay at zero, so re-recording the baseline can never let one back in.
  for (const rule of ['brand', 'product-name']) {
    const files = Object.entries(baseline).filter(([, rules]) => (rules as Record<string, number>)[rule] !== undefined).map(([file]) => file);
    assert.deepEqual(files, [], `${rule} is paid off and stays at zero: fix the copy, never record a count`);
  }
});

test('D-45 pattern: the tightness check fails on a stale count only when the baseline must be tight', () => {
  const stale = compareWithBaseline({ 'a.ts': { glossary: 1 } }, { 'a.ts': { glossary: 3 }, 'b.ts': { brand: 1 } }).stale;
  assert.deepEqual(stale, ['a.ts  glossary  3 -> 1', 'b.ts  brand  1 -> 0']);
  const notes: string[] = [];
  assert.throws(() => { checkTightness(stale, true, (note) => notes.push(note)); }, /a\.ts {2}glossary {2}3 -> 1[\s\S]*b\.ts {2}brand {2}1 -> 0/);
  checkTightness(stale, false, (note) => notes.push(note));
  assert.ok(notes.some((note) => note.includes('a.ts  glossary  3 -> 1')) && notes.some((note) => note.includes('b.ts  brand  1 -> 0')));
  checkTightness([], true, (note) => notes.push(note));
});

test('D-45 pattern: the baseline is tight (enforced at the close of a phase with NEAR_AI_BASELINE_TIGHT=1)', (t) => {
  const { stale } = compareWithBaseline(scanRepository(), readBaseline());
  checkTightness(stale, process.env.NEAR_AI_BASELINE_TIGHT === '1', (note) => { t.diagnostic(note); });
});

// Phase 33 D-69 (33-26): the native staff widgets draw the sentences of the live model (src/domain/staff, src/staff) and of the channel constants in
// workbench/extension/src/common, so a later check of those constants covers everything a person reads there. A widget file holds no sentence of its
// own: no string literal of two or more words that ends like a sentence.
test('D-69: the native staff widgets hold no sentence of their own, only the constants they render', () => {
  const dir = path.join(REPO_ROOT, 'workbench', 'extension', 'src', 'browser', 'staff');
  const sentences: string[] = [];
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.ts')).sort()) {
    const source = readFileSync(path.join(dir, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const match of source.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
      const literal = match[1] ?? match[2] ?? match[3] ?? '';
      if (/[A-Za-z]+\s+[A-Za-z]+/.test(literal) && /[.?!]$/.test(literal.trim())) sentences.push(`${name}: ${literal}`);
    }
  }
  assert.deepEqual(sentences, []);
});
