#!/usr/bin/env node
// The COP map CSP spike (WP-COP; UX concept 12.3): runs the real map component (media/staff/copMap.js) with the vendored MapLibre and milsymbol in
// headless Chromium under the Staff Room's content security policy, with the page and its resources on two loopback origins as in a VS Code webview,
// and reports CSP violations, every request the page made, whether the globe and Mercator render, and frame times with N moving tracks.
//
//   npm run compile && node scripts/spike-cop-map-csp.mjs <path to chrome or chrome-headless-shell> [tracks=2000]
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
const TRACKS = Number(process.argv[3] ?? 2000);
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
<body><div id="map"></div><script nonce="${nonce}" src="${R}/staff/copMap.js"></script><script nonce="${nonce}">
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
const page = await listen((request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(html); });
const P = `http://127.0.0.1:${page.address().port}`;
const profile = mkdtempSync(path.join(os.tmpdir(), 'cop-spike-'));
const chrome = spawn(CHROME, ['--headless', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
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
for (let i = 0; i < 240; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  const evaluated = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__out)', returnByValue: true }, sessionId);
  out = evaluated.result?.result?.value && JSON.parse(evaluated.result.result.value);
  if (out?.done) break;
}
console.log(JSON.stringify({ csp: csp.replaceAll(R, 'RESOURCES'), result: out, requests: [...requests] }, null, 1));
chrome.kill(); resources.close(); page.close(); browser.close();
rmSync(profile, { recursive: true, force: true });
process.exit(out?.done && !out.error && out.violations.length === 0 && out.renderer === 'maplibre' ? 0 : 1);
