// Renders Marketplace screenshots from the real sidebar (dist/services/panelView.js + media/chat)
// inside a VS Code-style frame. Requires `npm run compile` and a Chromium binary:
//   CHROME_PATH=/path/to/chrome npm run generate:screenshots
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chrome = process.env.CHROME_PATH;
if (!chrome) {
  console.error('Set CHROME_PATH to a Chromium or Chrome binary.');
  process.exit(1);
}
const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = (request, parent, isMain) => request === 'vscode'
  ? { Uri: { joinPath: (base, ...parts) => ({ path: join(base.path, ...parts), toString() { return pathToFileURL(this.path).href; } }) } }
  : originalLoad(request, parent, isMain);
const { sidebarHtml } = require(join(root, 'dist/services/panelView.js'));
Module._load = originalLoad;

// VS Code Dark Modern theme tokens used by media/chat/chat.css.
const THEME = {
  'font-family': '"Segoe UI", Ubuntu, "Droid Sans", sans-serif', 'font-size': '13px',
  'editor-font-family': '"DejaVu Sans Mono", Menlo, monospace', 'editor-font-size': '12px',
  foreground: '#cccccc', descriptionForeground: '#9d9d9d', 'sideBar-background': '#181818', 'editor-background': '#1f1f1f',
  'input-background': '#313131', 'input-border': '#3c3c3c', 'input-foreground': '#cccccc', 'input-placeholderForeground': '#989898',
  focusBorder: '#0078d4', 'button-background': '#0078d4', 'button-foreground': '#ffffff', 'button-hoverBackground': '#026ec1',
  'button-secondaryBackground': '#313131', 'button-secondaryForeground': '#cccccc', 'panel-border': '#2b2b2b',
  'textLink-foreground': '#4daafc', 'textCodeBlock-background': '#2b2b2b', 'toolbar-hoverBackground': '#5a5d5e50',
  'icon-foreground': '#cccccc', 'list-hoverBackground': '#2a2d2e', 'quickInput-background': '#222222',
  'quickInputList-focusBackground': '#04395e', 'quickInputList-focusForeground': '#ffffff', 'widget-shadow': '#0000005c',
  'progressBar-background': '#0078d4', 'testing-iconPassed': '#73c991', errorForeground: '#f85149',
  'editorGroupHeader-tabsBackground': '#181818', 'dropdown-background': '#313131', 'dropdown-foreground': '#cccccc'
};
const themeCss = `:root{${Object.entries(THEME).map(([key, value]) => `--vscode-${key}:${value}`).join(';')}}`;

// Each scenario replays real host messages into the sidebar script.
const SCENARIOS = {
  chat: `
    send('Add a timeout to the provider request so it never hangs.');
    host({type:'assistant-start',model:'deepseek-ai/DeepSeek-V3'});
    host({type:'assistant-delta',text:'Wrap the request in an **AbortController** and clear the timer once headers arrive, so long streams are never cut off:\\n\\n\`\`\`ts\\nconst abort = new AbortController();\\nconst timer = setTimeout(() => abort.abort(), 60_000);\\nconst res = await fetch(url, { signal: abort.signal });\\nclearTimeout(timer);\\n\`\`\`\\n\\n- Retry \`408\`, \`429\`, and \`5xx\` with backoff\\n- Surface a clear error instead of spinning forever'});
    host({type:'assistant-done',usage:{inputTokens:1840,outputTokens:212,actualCostUsd:0.00073,verificationStatus:'verified'}});`,
  workflow: `
    command('plan-phase');
    host({type:'command-progress',sessionId:'session-demo00001',command:'plan-phase',state:'started'});
    host({type:'command-progress',sessionId:'session-demo00001',command:'plan-phase',state:'output',text:'Reading ROADMAP.md and REQUIREMENTS.md…'});
    host({type:'command-progress',sessionId:'session-demo00001',command:'plan-phase',state:'running',action:'researching phase 7 · 3 agents'});
    host({type:'structured-prompt',prompt:{sessionId:'session-demo00001',promptId:'scope',question:'Phase 7 touches billing. How should risky changes be handled?',choices:[{id:'approve',label:'Ask me before each write'},{id:'batch',label:'Batch for review'}],freeForm:{enabled:true,placeholder:'Or describe your own rule…'},state:'open',plans:[]}});`,
  commands: `
    input.addEventListener('blur', (event) => event.stopImmediatePropagation(), true);
    input.focus(); input.value = '/'; input.dispatchEvent(new Event('input'));`
};

const EDITOR_CODE = [
  ['k', 'export async function '], ['f', 'requestWithTimeout'], ['p', '(url: '], ['t', 'string'], ['p', ') {'], null,
  ['p', '  '], ['k', 'const '], ['v', 'abort'], ['p', ' = '], ['k', 'new '], ['t', 'AbortController'], ['p', '();'], null,
  ['p', '  '], ['k', 'const '], ['v', 'timer'], ['p', ' = '], ['f', 'setTimeout'], ['p', '(() => abort.'], ['f', 'abort'], ['p', '(), '], ['n', '60_000'], ['p', ');'], null,
  ['p', '  '], ['k', 'try '], ['p', '{'], null,
  ['p', '    '], ['k', 'return await '], ['f', 'fetch'], ['p', '(url, { signal: abort.signal });'], null,
  ['p', '  } '], ['k', 'finally '], ['p', '{'], null,
  ['p', '    '], ['f', 'clearTimeout'], ['p', '(timer);'], null,
  ['p', '  }'], null, ['p', '}'], null
];
const COLORS = { k: '#569cd6', f: '#dcdcaa', p: '#cccccc', t: '#4ec9b0', v: '#9cdcfe', n: '#b5cea8' };
function editorLines() {
  const lines = [[]];
  for (const token of EDITOR_CODE) token ? lines.at(-1).push(token) : lines.push([]);
  return lines.filter((line) => line.length).map((line, index) => `<div class="line"><span class="ln">${index + 1}</span>${line.map(([kind, text]) => `<span style="color:${COLORS[kind]}">${text.replace(/</g, '&lt;')}</span>`).join('')}</div>`).join('');
}

const ICON = (d) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="#cccccc"><path d="${d}"/></svg>`;
const TITLE_ICONS = [
  'M14 7v1H8v6H7V8H1V7h6V1h1v6z',
  'M13.5 2.5A6.5 6.5 0 1 0 15 8h-1a5.5 5.5 0 1 1-1.6-3.9L11 5.5h4v-4l-1.5 1zM7.5 4h1v4l2.6 1.6-.5.8L7.5 8.6z',
  'M14.8 3.6 12.4 6l-2.1-.4L10 3.5l2.4-2.4a4 4 0 0 0-5 5.1L1.6 12a1.4 1.4 0 0 0 2 2l5.8-5.8a4 4 0 0 0 5.4-4.6z',
  'M9.1 1h-2.2l-.3 1.8-.9.4-1.5-1-1.5 1.5 1 1.5-.4.9L1.5 6.9v2.2l1.8.3.4.9-1 1.5 1.5 1.5 1.5-1 .9.4.3 1.8h2.2l.3-1.8.9-.4 1.5 1 1.5-1.5-1-1.5.4-.9 1.8-.3V6.9l-1.8-.3-.4-.9 1-1.5-1.5-1.5-1.5 1-.9-.4zM8 10.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z'
];

function frame(sidebarFile) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}body{margin:0;width:1280px;height:800px;display:flex;flex-direction:column;background:#1f1f1f;font:13px ${THEME['font-family']};color:#cccccc;overflow:hidden}
  .titlebar{height:35px;flex:none;display:flex;align-items:center;justify-content:center;background:#181818;border-bottom:1px solid #2b2b2b;color:#9d9d9d;font-size:12px}
  .main{flex:1;display:flex;min-height:0}
  .activity{width:48px;background:#181818;border-right:1px solid #2b2b2b;display:flex;flex-direction:column;align-items:center;gap:18px;padding-top:12px}
  .activity i{width:22px;height:22px;border:2px solid #6e6e6e;border-radius:4px;display:block}
  .explorer{width:220px;background:#181818;border-right:1px solid #2b2b2b;padding:10px 0;font-size:13px}
  .explorer h4{margin:0 0 8px 20px;font-size:11px;font-weight:600;color:#9d9d9d;letter-spacing:.04em}
  .explorer div{padding:2px 0 2px 28px;color:#cccccc}.explorer div.on{background:#37373d}
  .editor{flex:1;display:flex;flex-direction:column;min-width:0}
  .tabs{height:35px;background:#181818;display:flex;border-bottom:1px solid #2b2b2b}.tab{padding:9px 16px;background:#1f1f1f;border-top:1px solid #0078d4;color:#ffffff}
  .code{padding:10px 0;font:13px/20px ${THEME['editor-font-family']}}.line{white-space:pre}.ln{display:inline-block;width:56px;padding-right:20px;text-align:right;color:#6e7681}
  .side{width:420px;flex:none;display:flex;flex-direction:column;background:#181818;border-left:1px solid #2b2b2b}
  .side header{height:35px;flex:none;display:flex;align-items:center;padding:0 8px 0 20px;font-size:11px;font-weight:600;letter-spacing:.04em;color:#cccccc}
  .side header span{flex:1}.side header svg{margin-left:8px;opacity:.9}
  iframe{flex:1;border:0;width:100%}
  .status{height:22px;flex:none;background:#181818;border-top:1px solid #2b2b2b;display:flex;align-items:center;gap:16px;padding:0 10px;font-size:12px;color:#9d9d9d}
  </style></head><body>
  <div class="titlebar">billing-service — Visual Studio Code</div>
  <div class="main">
    <nav class="activity"><i></i><i></i><i></i><i></i></nav>
    <aside class="explorer"><h4>EXPLORER</h4><div>.planning</div><div>src</div><div class="on">&nbsp;&nbsp;client.ts</div><div>&nbsp;&nbsp;invoices.ts</div><div>tests</div><div>package.json</div></aside>
    <section class="editor"><div class="tabs"><div class="tab">client.ts</div></div><div class="code">${editorLines()}</div></section>
    <aside class="side"><header><span>NEAR AI: CHAT</span>${TITLE_ICONS.map(ICON).join('')}</header><iframe src="${pathToFileURL(sidebarFile).href}"></iframe></aside>
  </div>
  <div class="status"><span>⎇ main</span></div>
  </body></html>`;
}

function sidebar(script) {
  let html = sidebarHtml({ cspSource: 'file:', asWebviewUri: (uri) => uri }, { path: join(root, 'media', 'chat') });
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace(/ nonce="[^"]*"/g, '');
  const harness = `<style>${themeCss}</style><script>
  window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => ({}), setState() {} });
  const host = (message) => window.postMessage(message, '*');
  window.addEventListener('load', () => {
    const input = document.getElementById('input');
    const send = (text) => { input.value = text; input.dispatchEvent(new Event('input')); document.getElementById('send').click(); };
    const command = (name) => { input.value = '/' + name; input.dispatchEvent(new Event('input')); document.getElementById('send').click(); };
    host({ type: 'models', models: [{ id: 'deepseek-ai/DeepSeek-V3', label: 'deepseek-ai/DeepSeek-V3 · $0.27/$1.1 per 1M' }] });
    host({ type: 'status', value: '72% · Phase 7/9 · Plan 2/4 · running · Agents 3 · Est. $0.4100' });
    setTimeout(() => { ${script} }, 30);
  });
  </script>`;
  return html.replace('<head>', `<head>${harness}`);
}

const work = mkdtempSync(join(tmpdir(), 'near-ai-shots-'));
const out = join(root, 'docs', 'marketplace');
mkdirSync(out, { recursive: true });
for (const [name, script] of Object.entries(SCENARIOS)) {
  const sidebarFile = join(work, `${name}-sidebar.html`);
  const frameFile = join(work, `${name}.html`);
  writeFileSync(sidebarFile, sidebar(script));
  writeFileSync(frameFile, frame(sidebarFile));
  execFileSync(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--allow-file-access-from-files', '--hide-scrollbars',
    '--force-device-scale-factor=2', '--window-size=1280,800', '--virtual-time-budget=3000',
    `--screenshot=${join(out, `near-ai-${name}.png`)}`, pathToFileURL(frameFile).href], { stdio: 'ignore' });
  console.log(`docs/marketplace/near-ai-${name}.png`);
}
