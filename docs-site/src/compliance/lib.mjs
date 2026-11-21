// Browser-safe dashboard readers. This module deliberately has no imports so the site and Node tests share it.
export const DASHBOARD_PATH = '/compliance/dashboard.json';
export const TEXT_BASE = '/compliance/text/';
export const REFRESH_PATH = '/compliance/refresh.json';
export const OVERLAY_ENDPOINT = '/_overlay/index.json';
export const BUNDLE_ARTIFACT = 'compliance-bundle';
export const PACKAGE_ASSET_PREFIX = 'compliance-package-';
export const STATE_WORDS = Object.freeze({
  met: 'Met', 'partly-met': 'Partly met', 'not-met': 'Not met', stale: 'Stale', 'not-applicable': 'Not applicable',
  'your-organizations-responsibility': "Your organization's responsibility"
});
const STATES = new Set(Object.keys(STATE_WORDS));

export function parseDashboard(text, contentType = '') {
  if (!text || !text.trim()) return { ok: false, reason: 'missing' };
  if (/text\/html/i.test(contentType)) return { ok: false, reason: 'html-fallback' };
  let dashboard;
  try { dashboard = JSON.parse(text); } catch { return { ok: false, reason: 'not-json' }; }
  if (!dashboard || dashboard.schemaVersion !== 1 || !Array.isArray(dashboard.levels) || !Array.isArray(dashboard.rows)) return { ok: false, reason: 'bad-shape' };
  return { ok: true, dashboard };
}

export function filterRows(rows, filters = {}) {
  return rows.filter((row) => Object.entries(filters).every(([key, value]) => !value || (key === 'component' ? row.components?.some((item) => item.component === value) : key === 'responsibility' ? row.components?.some((item) => item.responsibility === value) : row[key] === value)));
}

/** @returns {{ met:number, 'partly-met':number, 'not-met':number, stale:number, 'not-applicable':number, 'your-organizations-responsibility':number, notMetTotal:number, metTotal:number }} */
export function levelCounts(dashboard, levelId) {
  const counts = Object.fromEntries(Object.keys(STATE_WORDS).map((state) => [state, 0]));
  for (const row of dashboard.rows ?? []) if (row.level === levelId && STATES.has(row.state)) counts[row.state]++;
  return { ...counts, notMetTotal: counts['not-met'] + counts.stale, metTotal: counts.met };
}

export function isOld(generatedAt, now = new Date(), hours = 24) {
  const at = Date.parse(generatedAt);
  return !Number.isFinite(at) || now.getTime() - at > hours * 60 * 60 * 1000;
}

export function gapsByLevelsBlocked(gaps) {
  return [...gaps].sort((a, b) => b.levelsBlocked - a.levelsBlocked || a.id.localeCompare(b.id));
}

export function toCsv(rows, columns) {
  const cell = (value) => { const text = String(value ?? ''); return `"${/^[=+\-@\t\r]/.test(text) ? "'" : ''}${text.replaceAll('"', '""')}"`; };
  return [columns, ...rows.map((row) => columns.map((column) => row[column]))].map((line) => line.map(cell).join(',')).join('\r\n');
}

const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function safe(value) { if (Array.isArray(value)) return value.every(safe); if (value && typeof value === 'object') return Object.keys(value).every((key) => !PROTOTYPE_KEYS.has(key) && safe(value[key])); return true; }
const OVERLAY_KEYS = new Set(['kind', 'v', 'organization', 'answers', 'evidence', 'decisions']);
export function parseOverlayIndex(json) {
  if (!json || !safe(json)) return { ok: false, reason: 'unsafe-key' };
  const files = Array.isArray(json.files) ? json.files : Array.isArray(json) ? json : null;
  if (!files || files.length > 64 || files.some((file) => !file || typeof file.path !== 'string' || file.bytes > 1024 * 1024 || !safe(file) || Object.keys(file).some((key) => !['path', 'bytes', 'overlay'].includes(key)) || (file.overlay && (Object.keys(file.overlay).some((key) => !OVERLAY_KEYS.has(key)) || Object.keys(file.overlay).some((key) => /state/i.test(key)))))) return { ok: false, reason: 'bad-overlay-index' };
  return { ok: true, files };
}

export function mergeOverlay(dashboard, overlayFiles, now = new Date()) {
  const copy = structuredClone(dashboard);
  for (const file of overlayFiles ?? []) {
    const overlay = file.overlay ?? file;
    for (const answer of overlay.answers ?? []) for (const matrix of copy.matrix ?? []) if (matrix.control === answer.control && matrix.component === answer.component) matrix.youDo = answer.text;
    for (const row of copy.rows ?? []) for (const component of row.components ?? []) {
      if (component.responsibility !== 'your-organization') continue;
      const evidence = (overlay.evidence ?? []).find((item) => item.control === row.control && (!item.component || item.component === component.component));
      const decision = (overlay.decisions ?? []).find((item) => item.control === row.control);
      if (!evidence) continue;
      const tooOld = Date.parse(evidence.collectedAt) + (evidence.windowDays ?? 0) * 86400000 < now.getTime();
      const officialNeeded = component.requiresOfficialSignature;
      if (officialNeeded && decision?.selfSigned) { component.state = row.state = 'not-met'; component.reason = row.reason = 'self-signed'; }
      else if (tooOld) component.state = row.state = 'stale';
      else if (evidence.passed) component.state = row.state = 'met';
      else component.state = row.state = 'not-met';
    }
  }
  return copy;
}
