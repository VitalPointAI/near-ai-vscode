#!/usr/bin/env node
// The COP map CSP spike (WP-COP; UX concept 12.3): runs the real map component (media/staff/copMap.js) with the vendored MapLibre and milsymbol in
// headless Chromium under the Staff Room's content security policy, with the page and its resources on two loopback origins as in a VS Code webview,
// and reports CSP violations, every request the page made, whether the globe and Mercator render, and frame times with N moving tracks.
//
//   npm run compile && node scripts/spike-cop-map-csp.mjs <path to chrome or chrome-headless-shell> [tracks=2000]
//   npm run compile && node scripts/spike-cop-map-csp.mjs <chrome> --room [screenshot.png] [--no-webgl]
//
// --room loads the Staff Room page itself, as src/services/staffRoomPanel.ts writes it (its HTML, policy and scripts, with a stand-in for the webview
// API), sends it the IRON LANTERN room model and COP picture, and reports violations, requests, which map runs and the line it shows, and whether any
// two name labels the SVG map placed overlap, measured with the browser's own text boxes. It can save a screenshot. --no-webgl starts the browser
// without WebGL, so the room must fall back to its SVG map and say why.
//
// Developer tool only: not run by npm test and not shipped. It listens on 127.0.0.1 only and resolves no other host.
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA = path.join(ROOT, 'media');
const require = createRequire(import.meta.url);
const { buildCopPicture, syntheticGeography } = require(path.join(ROOT, 'dist', 'domain', 'staff', 'cop', 'index.js'));
const { parseScenarioText } = require(path.join(ROOT, 'dist', 'domain', 'staff', 'scenario.js'));
const { copMapCsp } = require(path.join(ROOT, 'dist', 'staff', 'copMapWebview.js'));

const CHROME = process.argv[2];
const ROOM = process.argv[3] === '--room';
const NO_WEBGL = process.argv.includes('--no-webgl');
const SHOT = ROOM && process.argv[4] && process.argv[4] !== '--no-webgl' ? process.argv[4] : undefined;
const TRACKS = ROOM ? 0 : Number(process.argv[3] ?? 2000);
if (!CHROME || !existsSync(CHROME)) { console.error('Give the path to a Chrome or chrome-headless-shell binary.'); process.exit(2); }

const parsed = parseScenarioText(readFileSync(path.join(ROOT, 'resources', 'staff', 'scenarios', 'iron-lantern.json'), 'utf8'));
const scenario = parsed.value;
const frame = scenario.region.frame;
const picture = buildCopPicture({ marking: scenario.marking, frame, geography: syntheticGeography(scenario), scenario, layers: [] });

const types = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css' };
const listen = (handler) => new Promise((resolve) => { const server = http.createServer(handler); server.listen(0, '127.0.0.1', () => resolve(server)); });
const resources = await listen((request, response) => {
  const file = path.join(MEDIA, decodeURIComponent(new URL(request.url, 'http://x').pathname));
  if (!file.startsWith(MEDIA) || !existsSync(file)) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'access-control-allow-origin': '*' });
  response.end(readFileSync(file));
});
const R = `http://127.0.0.1:${resources.address().port}`;
const nonce = 'c3Bpa2Vub25jZTEyMzQ=';
const csp = copMapCsp(R, nonce);
const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${R}/vendor/maplibre-gl/maplibre-gl.css"><link rel="stylesheet" href="${R}/staff/copMap.css"></head>
<body><div id="map"></div><script nonce="${nonce}" src="${R}/staff/declutter.js"></script><script nonce="${nonce}" src="${R}/staff/copMap.js"></script><script nonce="${nonce}">
window.__out = { violations: [], steps: [] };
document.addEventListener('securitypolicyviolation', (e) => window.__out.violations.push(e.violatedDirective + ' ' + e.blockedURI));
(async () => {
  try {
    const box = document.getElementById('map'); box.style.width = '1000px'; box.style.height = '700px';
    const picture = ${JSON.stringify(picture)};
    const view = await window.nearCopMap.mount(box, { nonce: '${nonce}', renderer: 'auto', projection: 'globe', resources: { maplibre: '${R}/vendor/maplibre-gl/maplibre-gl.mjs', worker: '${R}/vendor/maplibre-gl/maplibre-gl-worker.mjs', milsymbol: '${R}/vendor/milsymbol/milsymbol.js' } });
    window.__out.renderer = view.renderer; window.__out.reason = view.reason;
    view.setPicture(picture);
    await new Promise((ok) => setTimeout(ok, 1500));
    window.__out.steps.push('globe drawn');
    const N = ${TRACKS};
    const b = picture.frame.bounds;
    const tracks = (tick) => Array.from({ length: N }, (_, i) => ({ type: 'Feature', id: 'cop-feed-maritime/t' + i, geometry: { type: 'Point', coordinates: [b[0] + ((i % 60) / 60) * (b[2] - b[0]) + tick * 0.0005, b[1] + (Math.floor(i / 60) / (N / 60)) * (b[3] - b[1])] }, properties: { layer: 'cop-feed-maritime', kind: 'track', name: 'T' + (i % 40), sidc: '10043000001401010000', track: 't' + i, label: 'org/Internal', card: [] } }));
    const layers = picture.layers.map((layer) => layer.id === 'cop-feed-maritime' ? Object.assign({}, layer, { visible: true, count: N }) : layer);
    const longTasks = []; try { new PerformanceObserver((l) => l.getEntries().forEach((e) => longTasks.push(e.duration))).observe({ entryTypes: ['longtask'] }); } catch {}
    const frames = []; let last = performance.now(); let running = true;
    const tick = (t) => { frames.push(t - last); last = t; if (running) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
    for (let i = 1; i <= 30; i += 1) { view.setPicture(Object.assign({}, picture, { layers, features: picture.features.concat(tracks(i)) })); await new Promise((ok) => setTimeout(ok, 100)); }
    running = false;
    frames.sort((a, c) => a - c);
    window.__out.perf = { tracks: N, frames: frames.length, p50: Math.round(frames[Math.floor(frames.length / 2)]), p95: Math.round(frames[Math.floor(frames.length * 0.95)]), longTasks: longTasks.length, longest: Math.round(Math.max(0, ...longTasks)), heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null };
    window.__out.mercator = view.setProjection('map');
    await new Promise((ok) => setTimeout(ok, 500));
    window.__out.steps.push('mercator drawn');
  } catch (e) { window.__out.error = String(e && e.stack || e); }
  window.__out.done = true;
})();
</script></body></html>`;
const roomPage = ROOM ? staffRoomPage() : undefined;
const page = await listen((request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(roomPage ? roomPage.html : html); });

/** The Staff Room page as the panel writes it, with the webview API stood in for by a nonced script, and the message its host would send. */
function staffRoomPage() {
  const Module = require('node:module');
  const uri = (value) => ({ path: value, toString: () => value });
  const vscode = { Uri: { joinPath: (base, ...parts) => uri(path.posix.normalize([base.path, ...parts].join('/'))) }, ViewColumn: { Active: -1 }, window: {}, workspace: {}, commands: {} };
  const load = Module._load;
  Module._load = (request, parent, isMain) => (request === 'vscode' ? vscode : load(request, parent, isMain));
  let panel;
  try { panel = require(path.join(ROOT, 'dist', 'services', 'staffRoomPanel.js')); } finally { Module._load = load; }
  const { buildStaffRoomModel } = require(path.join(ROOT, 'dist', 'domain', 'staff', 'staffRoom.js'));
  const { defaultStaffSettings } = require(path.join(ROOT, 'dist', 'domain', 'staff', 'profiles.js'));
  const webview = { cspSource: R, asWebviewUri: (value) => uri(R + value.path.replace(/^\/media/, '')) };
  let text = panel.staffRoomHtml(webview, uri('/media/staffRoom'));
  const pageNonce = /script-src 'nonce-([^']+)'/.exec(text)[1];
  const stand = `<script nonce="${pageNonce}">window.__out = { violations: [], posts: [] };
document.addEventListener('securitypolicyviolation', (e) => window.__out.violations.push(e.violatedDirective + ' ' + e.blockedURI));
window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__out.posts.push(m && m.type), getState: () => ({ workspace: 'j2', calm: true }), setState: () => undefined });</script>`;
  text = text.replace('<body>', '<body>' + stand);
  const at = (minute) => new Date(Date.UTC(2026, 10, 19, 11, minute)).toISOString();
  const coaBody = '## Most likely course of action\n\n41 CSTL BDE defends Port Calder from PL COPPER, holding Ashby Ford with 1-41 MECH at KQ 4532. We assess this is likely. We have moderate confidence.\n\n## Most dangerous course of action\n\n3-41 ARMD counter-attacks from KQ 4726 west to Ashby Ford KQ 4528 and on towards AA OAK. This is unlikely. We have low confidence.\n';
  const model = buildStaffRoomModel({
    now: Date.UTC(2026, 10, 19, 12, 0), settings: defaultStaffSettings(), registry: [], decisions: [], cop: { layers: [], eventTail: [] },
    events: [{ type: 'staff.step.entered', run: 'run-spike', at: at(0), section: 'j2', step: 3, stepName: 'COA development' }], scenario,
    j2: { sources: [], pirs: [], plan: [], enemyCoaBody: coaBody, enemyCoaProduct: 'adversary-coa-set' }
  });
  return { html: text, message: { type: 'staff-room', model, cues: [], picture, pictureNow: Date.UTC(2026, 10, 19, 12, 0) } };
}
const P = `http://127.0.0.1:${page.address().port}`;
const profile = mkdtempSync(path.join(os.tmpdir(), 'cop-spike-'));
const chrome = spawn(CHROME, ['--headless', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run', ...(NO_WEBGL ? ['--disable-webgl', '--disable-3d-apis'] : []), '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve) => { let buffer = ''; chrome.stderr.on('data', (data) => { buffer += data; const match = /DevTools listening on (ws:\S+)/.exec(buffer); if (match) resolve(match[1]); }); });
const browser = new WebSocket(wsUrl);
await new Promise((resolve) => browser.addEventListener('open', resolve));
let id = 0;
const waiting = new Map();
const requests = new Set();
browser.addEventListener('message', (message) => {
  const data = JSON.parse(message.data);
  if (data.id && waiting.has(data.id)) { waiting.get(data.id)(data); waiting.delete(data.id); }
  if (data.method === 'Network.requestWillBeSent') requests.add(data.params.request.url.replace(R, 'RESOURCES').replace(P, 'PAGE').replace(/blob:PAGE\/[0-9a-f-]+/, 'blob:PAGE/<uuid>'));
});
const send = (method, params = {}, sessionId) => new Promise((resolve) => { id += 1; waiting.set(id, resolve); browser.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Network.enable', {}, sessionId);
await send('Page.navigate', { url: P }, sessionId);
let out;
if (ROOM) {
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1400, deviceScaleFactor: 1, mobile: false }, sessionId);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await send('Runtime.evaluate', { expression: `window.postMessage(${JSON.stringify(roomPage.message)}, '*')` }, sessionId);
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const probe = `(() => {
    const box = document.querySelector('.mapbox');
    const note = document.querySelector('.mapnote');
    const labels = [...document.querySelectorAll('svg.map text[data-label="placed"], svg.map text[data-label="short"]')].filter((t) => t.getAttribute('visibility') !== 'hidden' && t.getBBox().width > 0).map((t) => { const r = t.getBoundingClientRect(); return { text: t.textContent, x: r.x, y: r.y, w: r.width, h: r.height }; });
    let overlaps = 0; const pairs = [];
    for (let i = 0; i < labels.length; i += 1) for (let j = i + 1; j < labels.length; j += 1) { const a = labels[i], b = labels[j]; if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) { overlaps += 1; pairs.push(a.text + ' / ' + b.text); } }
    return JSON.stringify(Object.assign(window.__out, { done: true, hasCop: box ? box.classList.contains('has-cop') : null, note: note && !note.hidden ? note.textContent : '', canvases: document.querySelectorAll('.copslot canvas').length, sizes: ['.copslot', '.cop-map', '.cop-map-canvas', '.copslot canvas'].map((q) => { const n = document.querySelector(q); if (!n) return q + ' none'; const r = n.getBoundingClientRect(); return q + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); }), svgLabels: labels.length, svgLabelOverlaps: overlaps, overlapping: pairs, pageWidth: document.documentElement.scrollWidth, viewport: innerWidth }));
  })()`;
  const evaluated = await send('Runtime.evaluate', { expression: probe, returnByValue: true }, sessionId);
  out = JSON.parse(evaluated.result.result.value);
  if (SHOT) {
    const rect = JSON.parse((await send('Runtime.evaluate', { expression: 'JSON.stringify(document.querySelector(".mapbox").getBoundingClientRect())', returnByValue: true }, sessionId)).result.result.value);
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 } }, sessionId);
    (await import('node:fs')).writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
  }
  // The narrowest panel the layout checks measure: nothing may reach past the right edge.
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const narrow = await send('Runtime.evaluate', { expression: 'JSON.stringify({ viewport: innerWidth, pageWidth: document.documentElement.scrollWidth, mapWidth: document.querySelector(".mapbox").getBoundingClientRect().width })', returnByValue: true }, sessionId);
  out.narrow = JSON.parse(narrow.result.result.value);
}
for (let i = 0; !ROOM && i < 240; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  const evaluated = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__out)', returnByValue: true }, sessionId);
  out = evaluated.result?.result?.value && JSON.parse(evaluated.result.result.value);
  if (out?.done) break;
}
console.log(JSON.stringify({ csp: csp.replaceAll(R, 'RESOURCES'), result: out, requests: [...requests] }, null, 1));
chrome.kill(); resources.close(); page.close(); browser.close();
rmSync(profile, { recursive: true, force: true });
process.exit(out?.done && !out.error && out.violations.length === 0 && (ROOM ? (NO_WEBGL ? out.hasCop === false && /^2D map: /.test(out.note) && out.svgLabelOverlaps === 0 : out.hasCop === true) : out.renderer === 'maplibre') ? 0 : 1);
