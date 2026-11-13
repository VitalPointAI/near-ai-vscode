// "NEAR AI: Put This Project's Code Online" (D-14, G-27-6b): the checked code push for a project that already has an online home, run after the person
// declined it once. Fake GitHub, fake sign-in and local bare remotes only: nothing contacts GitHub, creates a repository or uses a real token.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pushCodeLaterFlow } from '../services/codePushLater';
import type { CodePushLaterInput } from '../services/codePushLater';
import { STATE_REF } from '../services/stateTransport';
import { fixtureGit } from './helpers/gitFixtures';
import {
  DEFAULT_STATE_BRANCH, FAKE_TOKEN, FakeCodeOffer, allFiles, assertNoDangerousPush, assertOnlyOurRefs, codeRun, currentBranch, fakeAuth, fakeGh, patches, projectFolder, remoteRefs, spyGit
} from './helpers/onlineHomeFakes';
import type { CodeRun } from './helpers/onlineHomeFakes';

const DEFAULT_SENTENCE = /is now the repository's default branch/;

/** The later push on a project the setup already ran on: the same fake GitHub, runner and local remote, a fresh set of dialogs. */
function later(run: CodeRun, offer: FakeCodeOffer, extra: Partial<CodePushLaterInput> = {}): Promise<Awaited<ReturnType<typeof pushCodeLaterFlow>>> {
  return pushCodeLaterFlow({ root: run.dir, ui: offer, auth: fakeAuth(), personGit: run.spy.git, git: run.spy.git, fetchFn: run.github.fetchFn, ...extra });
}

const offerYes = (run: CodeRun): FakeCodeOffer => new FakeCodeOffer(run.events, { offer: true, push: true });

test('tracer: after the code offer was declined, the command blocks a planted .env with nothing pushed, then pushes through the same checks once it is gone', async () => {
  const run = await codeRun('later-tracer', { defaultBranch: DEFAULT_STATE_BRANCH, offer: false });
  assert.equal(run.result.status, 'done');
  assert.equal(patches(run).length, 0);
  assertOnlyOurRefs(run.bare, run.dir, false);

  writeFileSync(path.join(run.dir, '.env'), 'API_KEY=sk_live_FAKEFAKEFAKEFAKE12345\n');
  await mkdir(path.join(run.dir, '.planning', '.near-ai'), { recursive: true });
  writeFileSync(path.join(run.dir, '.planning', '.near-ai', 'activity.json'), '{"runs":[]}\n');
  writeFileSync(path.join(run.dir, '.planning', '.near-ai', 'team.md'), '# Team\n');
  const pushesBefore = run.spy.calls.filter((args) => args.includes('push')).length;

  const blockedOffer = offerYes(run);
  const blocked = await later(run, blockedOffer);
  assert.equal(blocked.status, 'blocked');
  assert.ok(blockedOffer.messages.some((message) => message.includes('.env') && /look like secrets/.test(message)), blockedOffer.messages.join('|'));
  assert.equal(blockedOffer.summaries.length, 0, 'no summary was shown for a blocked push');
  assert.equal(run.spy.calls.filter((args) => args.includes('push')).length, pushesBefore, 'nothing was pushed');
  assert.equal(patches(run).length, 0);
  assertOnlyOurRefs(run.bare, run.dir, false);

  unlinkSync(path.join(run.dir, '.env'));
  const pushedOffer = offerYes(run);
  const pushed = await later(run, pushedOffer);
  assert.equal(pushed.status, 'pushed', pushed.message);
  const branch = currentBranch(run.dir);
  assert.equal(pushedOffer.summaries.length, 1);
  assert.ok(pushedOffer.summaries[0]?.files.includes('app.ts'));
  assert.ok(pushedOffer.summaries[0]?.files.includes('.planning/.near-ai/team.md'));
  assert.ok(pushedOffer.summaries[0]?.notes.some((note) => /stay on this computer/.test(note) && note.includes('activity.json')), JSON.stringify(pushedOffer.summaries[0]?.notes));
  const tree = fixtureGit(run.bare, ['ls-tree', '-r', '--name-only', `refs/heads/${branch}`]).trim().split('\n');
  assert.ok(tree.includes('app.ts'));
  assert.equal(tree.some((file) => file.startsWith('.planning/.near-ai/') && !['.planning/.near-ai/team.md', '.planning/.near-ai/project.json', '.planning/.near-ai/verifiers.json'].includes(file)), false, tree.join(','));
  assert.equal(tree.includes('.env'), false);
  assertOnlyOurRefs(run.bare, run.dir, true);
  assertNoDangerousPush(run.spy.calls);
  // The default moves exactly once, after the push of the person's branch.
  assert.equal(patches(run).length, 1);
  assert.equal(patches(run)[0]?.body, JSON.stringify({ default_branch: branch }));
  const pushAt = run.events.findIndex((event) => event.startsWith('git:') && event.includes(`refs/heads/${branch}:refs/heads/${branch}`));
  const patchAt = run.events.findIndex((event) => event.startsWith('api:PATCH'));
  assert.ok(pushAt >= 0 && patchAt > pushAt, run.events.join(' | '));
  assert.equal(run.github.defaultBranch, branch);
  assert.match(pushed.message, DEFAULT_SENTENCE);
});

test('the summary the person clicks on carries the saved repository\'s visibility: the public line for a public repository, none for a private one', async () => {
  for (const visibility of ['public', 'private'] as const) {
    const run = await codeRun(`later-${visibility}`, { defaultBranch: DEFAULT_STATE_BRANCH, offer: false, visibility });
    const offer = offerYes(run);
    const result = await later(run, offer);
    assert.equal(result.status, 'pushed', result.message);
    assert.equal(offer.summaries[0]?.visibility, visibility);
    assert.equal(offer.summaries[0]?.notes.includes('Everyone will be able to see these files.'), visibility === 'public');
  }
});

test('the default branch moves only away from near-ai/state, only after a pushed result: a default the person chose, a declined summary and a blocked push send no PATCH', async () => {
  const own = await codeRun('later-own-default', { defaultBranch: 'develop', offer: false });
  const ownResult = await later(own, offerYes(own));
  assert.equal(ownResult.status, 'pushed');
  assert.equal(patches(own).length, 0);
  assert.equal(own.github.defaultBranch, 'develop');
  assert.doesNotMatch(ownResult.message, /default branch/);
  assertOnlyOurRefs(own.bare, own.dir, true);

  const declined = await codeRun('later-declined', { defaultBranch: DEFAULT_STATE_BRANCH, offer: false });
  const declinedResult = await later(declined, new FakeCodeOffer(declined.events, { offer: true, push: false }));
  assert.equal(declinedResult.status, 'declined');
  assert.equal(patches(declined).length, 0);
  assert.equal(declined.github.defaultBranch, DEFAULT_STATE_BRANCH);
  assertOnlyOurRefs(declined.bare, declined.dir, false);

  const blocked = await codeRun('later-blocked', { defaultBranch: DEFAULT_STATE_BRANCH, offer: false, files: { 'app.ts': 'export {};\n', '.env': 'API_KEY=sk_live_FAKEFAKEFAKEFAKE12345\n' } });
  assert.equal((await later(blocked, offerYes(blocked))).status, 'blocked');
  assert.equal(patches(blocked).length, 0);
  assertOnlyOurRefs(blocked.bare, blocked.dir, false);
});

test('a project with no remote is told in one sentence how to get an online home: no git push and no request', async () => {
  const dir = await projectFolder('later-none');
  fixtureGit(dir, ['init', '-q']);
  writeFileSync(path.join(dir, 'app.ts'), 'export {};\n');
  const spy = spyGit();
  const offer = new FakeCodeOffer([], { offer: true });
  const requests: string[] = [];
  const auth = fakeAuth();
  const result = await pushCodeLaterFlow({ root: dir, ui: offer, auth, personGit: spy.git, git: spy.git, fetchFn: (url) => { requests.push(url); return Promise.reject(new TypeError('no network in this test')); } });
  assert.equal(result.status, 'no-home');
  assert.match(result.message, /^This project has no online home yet/);
  assert.match(result.message, /Give This Project an Online Home/);
  assert.deepEqual(offer.messages, [result.message]);
  assert.equal(spy.calls.some((args) => args.includes('push')), false);
  assert.deepEqual(requests, []);
  assert.equal(auth.tokenCalls, 0);
  assert.equal(offer.summaries.length, 0);

  // Several remotes and no origin: without the person's pick nothing is pushed either.
  fixtureGit(dir, ['remote', 'add', 'one', 'https://example.com/a/one.git']);
  fixtureGit(dir, ['remote', 'add', 'two', 'https://example.com/a/two.git']);
  const unsure = await pushCodeLaterFlow({ root: dir, ui: offer, auth, personGit: spy.git, git: spy.git, pickRemote: () => Promise.resolve(undefined) });
  assert.equal(unsure.status, 'cancelled');
  assert.equal(spy.calls.some((args) => args.includes('push')), false);
});

test('on a pasted address the push uses the person\'s own credentials, no request reaches GitHub, and the settings sentence follows the remote\'s own default', async () => {
  for (const shown of ['state', 'person'] as const) {
    const run = await codeRun(`later-paste-${shown}`, { route: 'url', offer: false, remoteHeadAfterSync: shown });
    const auth = fakeAuth();
    const offer = offerYes(run);
    const calls = run.github.calls.length;
    const result = await later(run, offer, { auth, gh: fakeGh() });
    assert.equal(result.status, 'pushed', result.message);
    const branch = currentBranch(run.dir);
    assert.equal(run.github.calls.length, calls, 'no request reached GitHub');
    assert.equal(auth.tokenCalls, 0, 'no sign-in was asked for');
    const pushes = run.spy.calls.map((args, index) => ({ args, env: run.spy.envs[index] })).filter((entry) => entry.args.includes('push'));
    assert.ok(pushes.length >= 1 && pushes.every((entry) => entry.env?.GIT_CONFIG_VALUE_0 === undefined), 'the person\'s own runner, unwrapped');
    assert.equal(result.message.includes(`make ${branch} the default branch`) && result.message.includes('settings'), shown === 'state', result.message);
    assertOnlyOurRefs(run.bare, run.dir, true);
    assertNoDangerousPush(run.spy.calls);
  }
});

test('on the gh route the gh token is used, without asking for a sign-in, and it reaches the API only in the Authorization header', async () => {
  const run = await codeRun('later-gh', { route: 'gh', defaultBranch: DEFAULT_STATE_BRANCH, offer: false });
  const auth = fakeAuth(FAKE_TOKEN, false);
  const result = await later(run, offerYes(run), { auth, gh: fakeGh() });
  assert.equal(result.status, 'pushed', result.message);
  assert.equal(auth.tokenCalls, 0);
  assert.equal(patches(run).length, 1);
  assert.equal(patches(run)[0]?.headers.Authorization, `Bearer ${FAKE_TOKEN}`);
  assert.equal(run.github.defaultBranch, currentBranch(run.dir));
  assert.ok(run.github.calls.every((call) => !call.url.includes(FAKE_TOKEN) && !(call.body ?? '').includes(FAKE_TOKEN)));
  assertOnlyOurRefs(run.bare, run.dir, true);
  assertNoDangerousPush(run.spy.calls);
});

test('a refused push leaves the remote as it was, and no default is touched', async () => {
  const hook = `#!/bin/sh\nwhile read old new ref; do\n  [ "$ref" = "${STATE_REF}" ] || { echo "branch not accepted" >&2; exit 1; }\ndone\n`;
  const run = await codeRun('later-refused', { defaultBranch: DEFAULT_STATE_BRANCH, offer: false, hook });
  const result = await later(run, offerYes(run));
  assert.equal(result.status, 'failed');
  assert.equal(patches(run).length, 0);
  assert.deepEqual(remoteRefs(run.bare), [STATE_REF]);
});

test('the token appears in no git argument, file, message or console line of the later push, and git gets it only through its environment', async () => {
  const secrets = [FAKE_TOKEN, Buffer.from(`x-access-token:${FAKE_TOKEN}`).toString('base64')];
  const logged: string[] = [];
  const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const originals = consoleMethods.map((method) => console[method]);
  for (const method of consoleMethods) console[method] = (...parts: unknown[]) => { logged.push(parts.map(String).join(' ')); };
  let run: CodeRun | undefined;
  let offer: FakeCodeOffer | undefined;
  let result: Awaited<ReturnType<typeof pushCodeLaterFlow>> | undefined;
  let before = 0;
  try {
    run = await codeRun('later-hygiene', { defaultBranch: DEFAULT_STATE_BRANCH, offer: false });
    before = run.spy.calls.length;
    offer = offerYes(run);
    result = await later(run, offer);
  } finally {
    consoleMethods.forEach((method, index) => { console[method] = originals[index] as never; });
  }
  assert.ok(run && offer && result);
  assert.equal(result.status, 'pushed', result.message);
  assert.equal(patches(run).length, 1);
  for (const secret of secrets) {
    assert.equal(run.spy.calls.some((args) => args.some((arg) => arg.includes(secret))), false, 'no git argument holds the token');
    assert.equal([...run.ui.messages, ...offer.messages, result.message, JSON.stringify(result)].some((text) => text.includes(secret)), false);
    assert.equal(run.github.calls.some((call) => call.url.includes(secret) || (call.body ?? '').includes(secret)), false);
    assert.equal(logged.some((line) => line.includes(secret)), false);
    for (const file of allFiles(run.dir)) assert.equal(readFileSync(file).includes(Buffer.from(secret)), false, `${file} holds the token`);
  }
  assert.equal(logged.length, 0, 'the flow prints nothing');
  const carrying = run.spy.envs.slice(before).filter((env) => env.GIT_CONFIG_VALUE_0 !== undefined);
  assert.ok(carrying.length >= 1, 'the token reached git');
  for (const env of carrying) {
    assert.equal(env.GIT_CONFIG_COUNT, '1');
    assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
    assert.equal(env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${secrets[1]}`);
  }
});

test('the command is declared once in the manifest, registered once from the extension, and its id and title match', () => {
  const root = path.join(__dirname, '..', '..');
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string; category: string }> } };
  const declared = manifest.contributes.commands.filter((command) => command.command === 'nearAi.sync.pushCode');
  assert.deepEqual(declared, [{ command: 'nearAi.sync.pushCode', title: 'Put This Project\'s Code Online', category: 'NEAR AI' }]);
  const extensionSource = path.join(root, 'src', 'extension.ts');
  const hostSource = path.join(root, 'src', 'services', 'onlineHomeVscode.ts');
  if (existsSync(extensionSource) && existsSync(hostSource)) {
    assert.equal((readFileSync(extensionSource, 'utf8').match(/registerCodePushCommand\(context\)/g) ?? []).length, 1);
    assert.equal((readFileSync(hostSource, 'utf8').match(/registerCommand\('nearAi\.sync\.pushCode'/g) ?? []).length, 1);
  }
});
