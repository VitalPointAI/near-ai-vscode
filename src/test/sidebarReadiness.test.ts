// The sidebar's one profile-readiness rule (media/chat/readiness.js, G-61-7): which welcome state the profile-status value gives, whether the
// profile works, and the page tracker that writes the state on body data-profile and tells the Team section. PR #7's Connect NEAR AI panel
// (media/chat/setup.js, 0.4.14) uses the same rule; the parity check below turns on by itself when main is merged into Team Mode.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { createBoardHarness } from './helpers/fakeDom';
import type { BoardHarness } from './helpers/fakeDom';

const ROOT = path.resolve(__dirname, '..', '..');

interface ReadinessModule {
  welcomeState(value: unknown): string;
  isReady(value: unknown): boolean;
  track(win: unknown, doc: unknown): void;
  current(): string | undefined;
  onChange(listener: (state: string) => void): () => void;
}

const readiness = (): ReadinessModule => require(path.join(ROOT, 'media', 'chat', 'readiness.js')) as ReadinessModule;

type Status = 'pending' | 'valid' | 'stale' | 'invalid' | undefined;

function profile(id: string, status: Status): Record<string, unknown> {
  const out: Record<string, unknown> = { profileId: id, displayName: `Profile ${id}`, organization: 'Org', provider: 'near-ai', baseUrl: 'https://example.invalid', authMode: 'apiKey' };
  if (status !== undefined) out.validation = { status };
  return out;
}

function value(profiles: Array<Record<string, unknown>>, activeProfileId?: string): Record<string, unknown> {
  return { projectScope: 'project', activeProfileId, configured: activeProfileId !== undefined, profiles };
}

/** The table of profile-status values and the state each gives. PR #7's setup.js must agree on every row. */
const RULE_TABLE: ReadonlyArray<{ name: string; value: unknown; state: string }> = [
  { name: 'no folder open (PR #7 value)', value: { noWorkspace: true, profiles: [] }, state: 'no-folder' },
  { name: 'no folder open, even with a profile listed', value: { noWorkspace: true, ...value([profile('a', 'valid')], 'a') }, state: 'no-folder' },
  { name: 'no saved profile', value: value([]), state: 'connect' },
  { name: 'no folder open (the value this branch sends)', value: { projectScope: 'No workspace', activeProfileId: undefined, configured: false, profiles: [] }, state: 'connect' },
  { name: 'the active profile works', value: value([profile('a', 'valid')], 'a'), state: 'ready' },
  { name: 'the active profile works, others do not', value: value([profile('a', 'valid'), profile('b', 'invalid')], 'a'), state: 'ready' },
  { name: 'the active profile is waiting for its check', value: value([profile('a', 'pending')], 'a'), state: 'choose' },
  { name: 'the active profile needs its key checked again', value: value([profile('a', 'stale')], 'a'), state: 'choose' },
  { name: 'the active profile was refused', value: value([profile('a', 'invalid')], 'a'), state: 'choose' },
  { name: 'the active profile has no check at all', value: value([profile('a', undefined)], 'a'), state: 'choose' },
  { name: 'working profiles, none chosen for this project', value: value([profile('a', 'valid'), profile('b', 'valid')]), state: 'select' },
  { name: 'the chosen profile is gone and the others work', value: value([profile('a', 'valid')], 'gone'), state: 'select' },
  { name: 'profiles, none chosen, one not working', value: value([profile('a', 'valid'), profile('b', 'pending')]), state: 'choose' },
  { name: 'a missing value', value: undefined, state: 'connect' },
  { name: 'a null value', value: null, state: 'connect' },
  { name: 'a value that is text', value: 'ready', state: 'connect' },
  { name: 'an empty object', value: {}, state: 'connect' },
  { name: 'profiles that are not a list', value: { profiles: 'a', activeProfileId: 'a' }, state: 'connect' },
  { name: 'empty entries in the list', value: { profiles: [null, undefined], activeProfileId: 'a' }, state: 'connect' }
];

test('welcomeState gives no-folder, connect, choose, select or ready from the profile-status value, row by row', () => {
  const { welcomeState } = readiness();
  for (const row of RULE_TABLE) assert.equal(welcomeState(row.value), row.state, row.name);
});

test('isReady is true only when the state is ready, and a missing or malformed value is never ready', () => {
  const { isReady, welcomeState } = readiness();
  for (const row of RULE_TABLE) assert.equal(isReady(row.value), row.state === 'ready', row.name);
  for (const bad of [undefined, null, 0, 'ready', [], {}, { profiles: [{ validation: { status: 'valid' } }], activeProfileId: 'a' }]) {
    assert.equal(isReady(bad), false, JSON.stringify(bad) ?? 'undefined');
    assert.notEqual(welcomeState(bad), 'ready');
  }
});

// ---- the page tracker ------------------------------------------------------------------------------------------------------------------------

const READY = value([profile('a', 'valid')], 'a');

function page(): BoardHarness {
  const h = createBoardHarness({ scripts: 'chat' });
  h.load(['readiness.js']);
  return h;
}

test('in the page the module is window.nearReadiness, and nothing is known before the first profile-status', () => {
  const h = page();
  const api = h.window.nearReadiness as ReadinessModule | undefined;
  assert.ok(api !== undefined, 'window.nearReadiness is installed');
  assert.equal(typeof api.welcomeState, 'function');
  assert.equal(api.current(), undefined);
  assert.equal(h.document.body.getAttribute('data-profile'), null);
});

test('every profile-status message sets body data-profile to the state and tells each listener once; a removed listener hears nothing', () => {
  const h = page();
  const api = h.window.nearReadiness as ReadinessModule;
  const heard: string[] = [];
  const other: string[] = [];
  api.onChange((state) => { heard.push(state); });
  const stop = api.onChange((state) => { other.push(state); });
  h.deliver({ type: 'profile-status', value: value([]) });
  assert.equal(h.document.body.getAttribute('data-profile'), 'connect');
  assert.equal(api.current(), 'connect');
  h.deliver({ type: 'profile-status', value: READY });
  assert.equal(h.document.body.getAttribute('data-profile'), 'ready');
  stop();
  h.deliver({ type: 'profile-status', value: value([profile('a', 'stale')], 'a') });
  assert.equal(h.document.body.getAttribute('data-profile'), 'choose');
  h.deliver({ type: 'something-else', value: READY });
  assert.equal(api.current(), 'choose', 'other messages change nothing');
  assert.deepEqual(heard, ['connect', 'ready', 'choose']);
  assert.deepEqual(other, ['connect', 'ready']);
});

test('the tracker keeps only the state name: no page state is stored and no profile name reaches the page', () => {
  const h = page();
  h.deliver({ type: 'profile-status', value: READY });
  assert.equal(h.state, undefined, 'nothing stored with setState');
  const attributes = JSON.stringify(h.document.body.getAttribute('data-profile'));
  assert.ok(!attributes.includes('Profile a'));
});

// ---- the planning-file links, the page files and the PR #7 parity seam (Task 2) -------------------------------------------------------------

const chatCss = (): string => readFileSync(path.join(ROOT, 'media', 'chat', 'chat.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const readinessJs = (): string => readFileSync(path.join(ROOT, 'media', 'chat', 'readiness.js'), 'utf8');

test('the planning-file links are hidden by CSS until body data-profile is ready', () => {
  const rules = [...chatCss().matchAll(/([^{}]+)\{([^}]*)\}/g)].map((match) => ({ selector: match[1].trim().replace(/\s+/g, ' '), body: match[2].trim() }));
  const gate = rules.filter((rule) => rule.selector.includes('data-profile'));
  assert.deepEqual(gate, [{ selector: 'body:not([data-profile="ready"]) #project-links', body: 'display: none;' }], 'exactly one rule, for the links only');
});

test('body data-profile is absent before the first profile-status, connect or choose while the profile does not work, and ready once it does', () => {
  const h = page();
  const links = h.document.createElement('nav');
  links.id = 'project-links';
  h.document.body.append(links);
  const shown = (): boolean => h.document.body.getAttribute('data-profile') === 'ready';
  assert.equal(h.document.body.getAttribute('data-profile'), null);
  assert.equal(shown(), false, 'the links are hidden before anything is known');
  h.deliver({ type: 'profile-status', value: value([]) });
  assert.equal(h.document.body.getAttribute('data-profile'), 'connect');
  h.deliver({ type: 'profile-status', value: value([profile('a', 'invalid')], 'a') });
  assert.equal(h.document.body.getAttribute('data-profile'), 'choose');
  assert.equal(shown(), false);
  h.deliver({ type: 'profile-status', value: READY });
  assert.equal(shown(), true, 'the links can show once the profile works');
});

test('readiness.js is on the release content list', () => {
  const release = readFileSync(path.join(ROOT, 'scripts', 'verify-release-content.mjs'), 'utf8');
  assert.ok(release.includes("'extension/media/chat/readiness.js'"));
});

test('readiness.js builds no markup, evaluates no code, reaches no network and never stores page state', () => {
  const sinks = [/\.innerHTML\b/, /\.outerHTML\b/, /\binsertAdjacentHTML\b/, /\bdocument\.write\b/, /\bsrcdoc\b/, /\beval\s*\(/, /\bnew\s+Function\b/, /\bFunction\s*\(/, /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bEventSource\b/, /\bsendBeacon\b/, /\bimportScripts\b/, /\bsetState\b/, /\bacquireVsCodeApi\b/, /\blocalStorage\b/, /\bsessionStorage\b/];
  const source = readinessJs();
  for (const sink of sinks) assert.ok(!sink.test(source), `readiness.js uses ${sink}`);
});

test('readiness.js has no en or em dash and no colour literal, and is one strict-mode IIFE', () => {
  const source = readinessJs();
  assert.ok(!/[–—]/.test(source), 'no dash character');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(source), 'no hex colour');
  assert.ok(!/\b(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\s*\(/i.test(source), 'no colour function');
  const code = source.split('\n').filter((line) => !/^\s*(\/\/.*)?$/.test(line));
  assert.match(code[0] ?? '', /^\(function \(root\) \{$/);
  assert.equal(code[1]?.trim(), "'use strict';");
  assert.equal(code[code.length - 1], "})(typeof window === 'undefined' ? globalThis : window);");
});

const SETUP_JS = path.join(ROOT, 'media', 'chat', 'setup.js');
const PARITY_SKIP = existsSync(SETUP_JS) ? false : 'media/chat/setup.js arrives with 0.4.14 (PR #7); this parity check turns on when main is merged into Team Mode';

test('PR #7 parity: setup.js welcomeState gives the same state as readiness.js on every case', { skip: PARITY_SKIP }, () => {
  const setup = require(SETUP_JS) as { welcomeState(value: unknown): string };
  const { welcomeState } = readiness();
  const cases = [...RULE_TABLE.map((row) => row.value), { noWorkspace: true }];
  for (const entry of cases) assert.equal(setup.welcomeState(entry), welcomeState(entry), JSON.stringify(entry) ?? 'undefined');
});
