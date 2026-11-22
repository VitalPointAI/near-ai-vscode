import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { boundedInt, boundedText, definePage, exactKeys, listenTo, postTo } from '../services/webview/protocol';
import { scanPage } from './helpers/a11yScan';

const SPEC = {
  viewType: 'test-page', title: 'Kit page', folder: 'test', script: 'page.js',
  style: 'page.css', body: '<main></main>', probe: 'test-page'
};
const NONCE = Buffer.alloc(16, 1).toString('base64');

function harness() {
  const listeners = new Set<(message: unknown) => unknown>();
  const webview = {
    html: '',
    cspSource: 'vscode-resource:',
    asWebviewUri: (value: string) => value,
    onDidReceiveMessage(listener: (message: unknown) => unknown) {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    }
  };
  let count = 0;
  const vscode = {
    Uri: { joinPath: (base: string, ...parts: string[]) => [base, ...parts].join('/') },
    ViewColumn: { Active: -1 },
    window: { createWebviewPanel: () => { count += 1; return { webview }; } }
  };
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  nodeModule._load = (request, parent, isMain) => {
    if (request === 'vscode') return vscode;
    if (request === 'node:crypto') return { randomBytes: () => Buffer.alloc(16, 1) };
    return originalLoad(request, parent, isMain);
  };
  try {
    for (const name of ['../services/webview/openPanel', '../services/layoutProbe']) delete require.cache[require.resolve(name)];
    const { openPanel } = require('../services/webview/openPanel') as typeof import('../services/webview/openPanel');
    return {
      open(spec: Parameters<typeof openPanel>[1] = SPEC) {
        const originalE2e = process.env.NEAR_AI_E2E;
        process.env.NEAR_AI_E2E = '1';
        try {
          return openPanel({ extensionUri: '/extension' as never }, spec);
        } finally {
          if (originalE2e === undefined) delete process.env.NEAR_AI_E2E;
          else process.env.NEAR_AI_E2E = originalE2e;
        }
      },
      panelsMade: () => count,
      send: (message: unknown) => Promise.all([...listeners].map(listener => listener(message)))
    };
  } finally {
    nodeModule._load = originalLoad;
  }
}

test('D-26: extra scripts run after the probe and main script under one unchanged CSP', () => {
  const kit = harness();
  const csp = (html: string) => html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/g);
  const without = csp(kit.open().webview.html);
  const html = kit.open({ ...SPEC, scripts: ['screens.js'] }).webview.html;
  assert.equal(without?.length, 1);
  assert.match(without[0], new RegExp(`script-src 'nonce-${NONCE}';`));
  assert.deepEqual(csp(html), without);
  assert.deepEqual([...html.matchAll(/<script nonce="([^"]+)" src="([^"]+)"><\/script>/g)].map(match => match.slice(1)), [
    [NONCE, '/extension/media/shared/layout-probe.js'],
    [NONCE, '/extension/media/test/page.js'],
    [NONCE, '/extension/media/test/screens.js']
  ]);
});

test('no extra scripts preserves the original panel HTML', () => {
  const kit = harness();
  assert.equal(kit.open().webview.html, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src vscode-resource:; script-src 'nonce-${NONCE}';">
<link rel="stylesheet" href="/extension/media/shared/base.css"><link rel="stylesheet" href="/extension/media/test/page.css"><title>Kit page</title></head><body>
<main></main>
<script nonce="${NONCE}" src="/extension/media/shared/layout-probe.js"></script>
<script nonce="${NONCE}" src="/extension/media/test/page.js"></script></body></html>`);
});

test('invalid extra script names are refused before creating the panel', () => {
  const kit = harness();
  for (const name of ['../screens.js', 'nested/screens.js', 'screens.js?x', 'screens.js\n', 'screens.css', 'x'.repeat(65) + '.js']) {
    assert.throws(() => kit.open({ ...SPEC, scripts: [name] }), /script/i);
  }
  assert.equal(kit.panelsMade(), 0);
});

test('typed protocol delivers valid messages, counts drops and disposes the listener', async () => {
  const kit = harness();
  const panel = kit.open({ ...SPEC, scripts: ['screens.js'] });
  const page = definePage((value: unknown) => {
    if (!exactKeys(value, ['type', 'optionId'])) return undefined;
    if (value.type !== 'choose') return undefined;
    const optionId = boundedText(value.optionId, 80);
    return optionId === undefined ? undefined : { type: 'choose' as const, optionId };
  });
  const received: unknown[] = [];
  const subscription = listenTo(panel.webview, page, (message: unknown) => { received.push(message); });
  const valid = { type: 'choose', optionId: 'x' };
  await kit.send(valid);
  for (const message of [{ type: 'choose', optionId: 5 }, { ...valid, extra: 1 }, null, 'x'.repeat(10_240),
    { ...valid, optionId: 'x'.repeat(10_240) }, { ...valid, type: 'other' }]) {
    await kit.send(message);
  }
  assert.deepEqual(received, [valid]);
  assert.equal(subscription.dropped(), 6);
  subscription.dispose();
  await kit.send(valid);
  assert.deepEqual(received, [valid]);
});

test('protocol bounds accept plain own keys, bounded text and safe integers', () => {
  assert.equal(exactKeys({ id: 'x', count: 1 }, ['id'], ['count']), true);
  assert.equal(exactKeys(Object.create({ id: 'x' }), ['id']), false);
  assert.equal(exactKeys({ id: 'x', [Symbol()]: 1 }, ['id']), false);
  assert.equal(boundedText('café', 4), 'café');
  assert.equal(boundedText('a\nb', 4), undefined);
  assert.equal(boundedText('a\u0085b', 4), undefined);
  assert.equal(boundedInt(1, 1, 2), 1);
  for (const value of [0, 1.5, 3, NaN, Infinity, '1']) assert.equal(boundedInt(value, 1, 2), undefined);
});

test('parse and handler failures leave the listener able to process the next message', async () => {
  const kit = harness();
  const page = definePage((value) => {
    if (value === 'parse fails') throw new Error('parse failed');
    return String(value);
  });
  const received: string[] = [];
  const subscription = listenTo(kit.open().webview, page, async (value) => {
    if (value === 'handle fails') throw new Error('handling failed');
    received.push(value);
  });
  await kit.send('parse fails');
  await kit.send('handle fails');
  await kit.send('valid');
  assert.equal(subscription.dropped(), 1);
  assert.deepEqual(received, ['valid']);
});

test('posting sends the typed message and handles a rejected post', async () => {
  const sent: unknown[] = [];
  const message = { type: 'screen' } as const;
  postTo({ postMessage: async (value) => {
    sent.push(value);
    throw new Error('webview closed');
  } }, message);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(sent, [message]);
});

const cleanPage = {
  title: 'Choose a model',
  html: '<h1 id="heading" tabindex="-1">Choose a model</h1><p aria-live="polite"></p>'
    + '<fieldset><legend>Models</legend><label><input type="radio" name="choice">Local</label>'
    + '<label><input type="radio" name="choice" aria-disabled="true" aria-describedby="reason-x">'
    + 'Not for this work <span id="reason-x">This model cannot run here.</span></label></fieldset>',
  script: "const heading = document.getElementById('heading'); heading.textContent = 'Choose a model'; heading.focus();",
  css: '@media (prefers-reduced-motion: no-preference) { label { transition: opacity 100ms; } }',
  baseCss: ':focus-visible { outline: 2px solid var(--vscode-focusBorder); }'
};

function rulesFor(overrides: Partial<typeof cleanPage> = {}): string[] {
  return scanPage({ ...cleanPage, ...overrides }).map(finding => finding.rule);
}

test('the accessibility scan accepts a clean page', () => {
  assert.deepEqual(rulesFor(), []);
});

test('the accessibility scan counts a polite region created once by the script', () => {
  const html = cleanPage.html.replace('<p aria-live="polite"></p>', '');
  const script = cleanPage.script + " const live = document.createElement('p'); live.setAttribute('aria-live', 'polite'); document.body.append(live);";
  assert.deepEqual(rulesFor({ html, script }), []);
  assert.deepEqual(rulesFor({ script }), ['one-live-region']);
});

const violations: readonly [string, string, Partial<typeof cleanPage>][] = [
  ['radio outside its fieldset', 'radio-fieldset', { html: cleanPage.html + '<input type="radio">' }],
  ['fieldset without a legend', 'radio-fieldset', { html: cleanPage.html.replace('<legend>Models</legend>', '') }],
  ['disabled option without a description', 'disabled-reason', { html: cleanPage.html.replace(' aria-describedby="reason-x"', '') }],
  ['disabled option with a missing description target', 'disabled-reason', { html: cleanPage.html.replace('id="reason-x"', 'id="other"') }],
  ['disabled option with an empty description', 'disabled-reason', { html: cleanPage.html.replace('This model cannot run here.', '') }],
  ['two polite regions', 'one-live-region', { html: cleanPage.html + '<p aria-live="polite"></p>' }],
  ['no polite region', 'one-live-region', { html: cleanPage.html.replace(' aria-live="polite"', '') }],
  ['heading without tabindex', 'focus-heading', { html: cleanPage.html.replace(' tabindex="-1"', '') }],
  ['script without a focus call', 'focus-heading', { script: cleanPage.script.replace('heading.focus();', '') }],
  ['animation without a motion preference', 'reduced-motion', { css: 'label { animation: fade 1s; }' }],
  ['raw hex colour', 'raw-colour', { css: 'label { color: #123abc; }' }],
  ['innerHTML assignment', 'no-inner-html', { script: cleanPage.script + ' heading.innerHTML = label;' }],
  ['outerHTML assignment', 'no-inner-html', { script: cleanPage.script + " heading['outerHTML'] += label;" }],
  ['insertAdjacentHTML call', 'no-inner-html', { script: cleanPage.script + " heading.insertAdjacentHTML('beforeend', label);" }],
  ['branded title', 'branded-title', { title: 'Near AI: Choose a model' }],
  ['ruled-out choice without the words', 'ruled-out-words', { html: cleanPage.html.replace('Not for this work', '') }],
  ['ruled-out choice with native disabled', 'disabled-reason', { html: cleanPage.html.replace('aria-disabled="true"', 'aria-disabled="true" disabled') }]
];

for (const [name, rule, overrides] of violations) {
  test('the accessibility scan flags ' + name, () => {
    assert.deepEqual(rulesFor(overrides), [rule]);
  });
}

test('base.css keeps visually hidden text and gives focus a theme ring and footer clearance', () => {
  const baseCss = readFileSync(path.join(__dirname, '../../media/shared/base.css'), 'utf8');
  const hidden = baseCss.match(/\.visually-hidden\s*\{([^}]*)\}/)?.[1] ?? '';
  for (const declaration of [
    'position: absolute', 'width: 1px', 'height: 1px', 'overflow: hidden',
    'clip: rect(0 0 0 0)', 'white-space: nowrap'
  ]) assert.ok(hidden.includes(declaration), '.visually-hidden keeps ' + declaration);
  assert.match(baseCss, /--near-focus-ring:\s*var\(--vscode-focusBorder\)/);
  assert.match(baseCss, /:focus-visible\s*\{[^}]*outline:\s*(?:[2-9]|\d{2,})px\s+solid\s+var\(--near-focus-ring\)/);
  assert.match(baseCss, /\bhtml\s*\{[^}]*scroll-padding-bottom:\s*4rem\b/);
  assert.doesNotMatch(baseCss, /#[0-9a-f]{3,8}\b(?![^{]*var\()/i);
});
