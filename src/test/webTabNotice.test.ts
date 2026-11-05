// 61-34 (the owner's 0.6.4 re-test, item 7): code-server keeps saved keys in the browser's storage, and each tab of the editor writes its
// whole copy back, so two tabs in one browser profile can overwrite each other's saved keys. In a web UI the person is told once, with
// Got it; on the desktop nothing is shown. The README's code-server tips say the same.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { GOT_IT, offerWebTabNotice, WEB_TAB_NOTICE_KEY, WEB_TAB_NOTICE_TEXT, WebTabNoticeHost } from '../domain/webTabNotice';

/** src/domain/webTabNotice.ts, as one object so each test reads what it uses. */
function notice() {
  return { offerWebTabNotice, WEB_TAB_NOTICE_KEY, WEB_TAB_NOTICE_TEXT, GOT_IT };
}

function host(web: boolean, answer: () => PromiseLike<string | undefined> = async () => undefined) {
  const values = new Map<string, unknown>();
  const told: Array<{ text: string; items: string[] }> = [];
  const value: WebTabNoticeHost = {
    web,
    state: { get: (key) => values.get(key), update: async (key, next) => { if (next === undefined) values.delete(key); else values.set(key, next); } },
    tell: (text, ...items) => { told.push({ text, items }); return answer(); }
  };
  return { host: value, values, told };
}

const TEXT = "NEAR AI: keep one tab of this editor per browser profile. Two tabs in the same browser profile can overwrite each other's saved keys. If a key is lost, set the profile up again, or for a team ask your lead to invite you again.";

test('the web tab notice has its exact words, a Got it button and no em or en dash', () => {
  const module = notice();
  assert.equal(module.WEB_TAB_NOTICE_KEY, 'nearAi.webTabNotice');
  assert.equal(module.WEB_TAB_NOTICE_TEXT, TEXT);
  assert.equal(module.GOT_IT, 'Got it');
  assert.doesNotMatch(module.WEB_TAB_NOTICE_TEXT, /[–—]/);
  assert.doesNotMatch(module.WEB_TAB_NOTICE_TEXT, /NEAR organization/);
});

test('on the desktop nothing is shown and nothing is stored', async () => {
  const { offerWebTabNotice } = notice();
  const desktop = host(false);
  assert.equal(await offerWebTabNotice(desktop.host), 'not-web');
  assert.deepEqual(desktop.told, []);
  assert.equal(desktop.values.size, 0);
});

test('in a web UI the notice is shown once with Got it, remembered as soon as it is shown, and not shown at the next start', async () => {
  const { offerWebTabNotice, WEB_TAB_NOTICE_KEY } = notice();
  let answer: (value: string | undefined) => void = () => undefined;
  const web = host(true, () => new Promise<string | undefined>((resolve) => { answer = resolve; }));
  const first = offerWebTabNotice(web.host);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(web.told, [{ text: TEXT, items: ['Got it'] }]);
  assert.notEqual(web.values.get(WEB_TAB_NOTICE_KEY), undefined, 'remembered while the notice is still open, whether or not the person answers');
  answer(undefined);
  assert.equal(await first, 'shown');
  assert.equal(await offerWebTabNotice(web.host), 'already-shown', 'the next start shows nothing');
  assert.equal(web.told.length, 1, 'never a second time');
});

test('a notice that could not be shown is not remembered, so it is tried again at the next start', async () => {
  const { offerWebTabNotice } = notice();
  const thrown = host(true, () => { throw new Error('no window'); });
  await assert.rejects(() => offerWebTabNotice(thrown.host), /no window/);
  assert.equal(thrown.values.size, 0, 'nothing is remembered when showing threw');

  const rejected = host(true, () => Promise.reject(new Error('closed')));
  await assert.rejects(() => offerWebTabNotice(rejected.host), /closed/);
  assert.equal(rejected.values.size, 0, 'nothing is remembered when the notice failed');
  rejected.host.tell = async (text, ...items) => { rejected.told.push({ text, items }); return 'Got it'; };
  assert.equal(await offerWebTabNotice(rejected.host), 'shown', 'tried again at the next start');
});

test('activation offers the web tab notice next to the proxy tip, with the web UI kind, global state and an information message, ignoring a failure', () => {
  const root = path.resolve(__dirname, '..', '..');
  const extension = readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
  const activate = extension.slice(extension.indexOf('export function activate('));
  const call = activate.indexOf('offerWebTabNotice(');
  assert.notEqual(call, -1, 'activate offers the notice');
  const proxy = activate.indexOf('void suggestProxySupportOff(context);');
  assert.equal(proxy !== -1 && call > proxy && call < activate.indexOf('new NearAiPanelViewProvider('), true, 'right after the proxy tip');
  const statement = activate.slice(call, activate.indexOf(';\n', call));
  assert.match(statement, /web: vscode\.env\.uiKind === vscode\.UIKind\.Web/);
  assert.match(statement, /state: context\.globalState/);
  assert.match(statement, /vscode\.window\.showInformationMessage\(/);
  assert.match(statement, /\.catch\(\(\) => undefined\)$/, 'a failure is ignored');
  const source = readFileSync(path.join(root, 'src', 'domain', 'webTabNotice.ts'), 'utf8');
  assert.doesNotMatch(source, /from 'vscode'/, 'the notice module needs no VS Code at run time');
});

test('the README\'s code-server tips say to keep one tab per browser profile and what to do after a lost key', () => {
  const readme = readFileSync(path.resolve(__dirname, '..', '..', 'README.md'), 'utf8');
  const tip = readme.slice(readme.indexOf('- **Keep one code-server tab per browser profile'));
  assert.notEqual(readme.indexOf('- **Keep one code-server tab per browser profile'), -1, 'the tip is in the README');
  const bullet = tip.slice(0, tip.indexOf('\n- ', 2));
  assert.ok(readme.indexOf('## Troubleshooting') < readme.indexOf('- **Keep one code-server tab per browser profile'), 'under Troubleshooting');
  assert.match(bullet, /overwrite each other's (saved )?keys/);
  assert.match(bullet, /set the profile up again/);
  assert.match(bullet, /ask your lead to invite you again/);
  assert.doesNotMatch(bullet, /[–—]/);
});
