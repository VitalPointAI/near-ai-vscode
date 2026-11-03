// Share Team Setup on real git (G-61-3, D-03 and D-20 as amended 2026-11-03): one plain confirmation, exactly the team setup is shared, and
// every result is said in plain words with the technical reason only in the NEAR AI Team channel. Prompts reach the vscode stub through the
// prompts module, as in the product.
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import type { TeamFile } from '../domain/team/types';
import { enableTeamMode } from '../team/enable';
import { TEAM_FILE_REL, readTeamFile } from '../team/teamFile';
import { MemorySecrets, createTeamFixture, gitIn } from './helpers/teamHarness';
import type { TeamFixture } from './helpers/teamHarness';
import { createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const shareModule = require('../services/team/shareFlow') as typeof import('../services/team/shareFlow');
const commandsModule = require('../services/team/teamCommands') as typeof import('../services/team/teamCommands');
test.after(() => { uninstall(); });
const { SHARE_TEXT, ensureTeamSetupShared } = shareModule;
const { LOCAL_ONLY_TEXT, SHOW_DETAILS_ACTION, TRY_AGAIN_ACTION } = commandsModule;

const PUBLIC_URL = 'https://example.invalid/team.git';
const EM_DASH = '—';

interface Shared {
  fixture: TeamFixture;
  root: string;
  teamFile: TeamFile;
  lines: string[];
  announced: Array<[string, string]>;
  share(reason: 'command' | 'enable' | 'invite' | 'link', choices?: Array<string | undefined>): Promise<string>;
}

function resetStub(): void {
  stub.notifications.length = 0;
  stub.notificationActions.length = 0;
  stub.notificationOptions.length = 0;
  stub.messageAnswers.length = 0;
  stub.progress.length = 0;
  stub.setMessageResponder(undefined);
}

// A team turned on by the lead on clone a. With `home: 'public'` (the default) origin is an address teammates could use, mapped back to the
// bare remote; `home: 'local'` keeps the fixture's folder path.
async function withEnabledTeam(run: (s: Shared) => Promise<void>, options: { home?: 'public' | 'local' } = {}): Promise<void> {
  resetStub();
  const fixture = await createTeamFixture({ clones: ['a'], initialised: true });
  const root = fixture.clones['a'] as string;
  try {
    if (options.home !== 'local') {
      gitIn(root, ['config', `url.${fixture.remote}.insteadOf`, PUBLIC_URL]);
      gitIn(root, ['remote', 'set-url', 'origin', PUBLIC_URL]);
    }
    const enabled = await enableTeamMode({
      projectRoot: root, globalStorageDir: fixture.storageDir('a'), secrets: new MemorySecrets(), teamName: 'Share team', ownerName: 'Lead Owner'
    });
    assert.equal(enabled.ok, true, enabled.ok ? '' : enabled.message);
    const teamFile = await readTeamFile(root);
    assert.ok(teamFile !== undefined);
    const lines: string[] = [];
    const announced: Array<[string, string]> = [];
    const deps = { output: { appendLine: (line: string): void => { lines.push(line); }, show: (): void => undefined }, announce: (level: 'info' | 'warn' | 'error', message: string): void => { announced.push([level, message]); } };
    await run({
      fixture, root, teamFile, lines, announced,
      async share(reason, choices = []) {
        stub.messageAnswers.push(...choices);
        return ensureTeamSetupShared(deps, { projectRoot: root, teamFile, branch: 'main', reason });
      }
    });
  } finally {
    await fixture.cleanup();
  }
}

const remoteTeamJson = (fixture: TeamFixture): string => gitIn(fixture.remote, ['show', `refs/heads/main:${TEAM_FILE_REL}`]);
const remoteMain = (fixture: TeamFixture): string => gitIn(fixture.remote, ['rev-parse', 'refs/heads/main']);
const modals = (): string[] => stub.notifications.filter((_entry, index) => stub.notificationOptions[index]?.modal === true).map((entry) => entry.message);
// Everything the person could read: messages, their details and buttons, progress titles and what was announced.
function shownText(s: Shared): string {
  return JSON.stringify({ notifications: stub.notifications, options: stub.notificationOptions, actions: stub.notificationActions, progress: stub.progress, announced: s.announced });
}

test('tracer: Share Team Setup asks once, then the online main holds exactly this computer\'s team.json and the person reads that it is online', async () => {
  await withEnabledTeam(async (s) => {
    const before = remoteMain(s.fixture);
    const outcome = await s.share('command', [SHARE_TEXT.share]);
    assert.equal(outcome, 'shared');
    assert.deepEqual(modals(), [SHARE_TEXT.question], 'one confirmation');
    assert.equal(SHARE_TEXT.question, 'Share your team setup so teammates can join?');
    assert.equal(SHARE_TEXT.share, 'Share');
    assert.deepEqual(stub.notificationActions[0], [SHARE_TEXT.share]);
    assert.equal(stub.notificationOptions[0]?.detail, SHARE_TEXT.onlySetup);
    assert.equal(SHARE_TEXT.onlySetup, 'Only the team setup is shared. Nothing else in your project changes.');
    assert.equal(remoteTeamJson(s.fixture), readFileSync(path.join(s.root, TEAM_FILE_REL), 'utf8').trimEnd(), 'the online main has this computer\'s team.json');
    assert.notEqual(remoteMain(s.fixture), before);
    assert.deepEqual(gitIn(s.fixture.remote, ['diff', '--name-only', before, 'refs/heads/main']).split('\n'), [TEAM_FILE_REL], 'only the team setup changed online');
    assert.deepEqual(s.announced, [['info', SHARE_TEXT.shared]]);
    assert.equal(SHARE_TEXT.shared, 'Your team setup is online. Teammates can now join.');
    assert.ok(stub.progress.some((entry) => entry.title === SHARE_TEXT.progress), 'the share ran under a plain progress title');
  });
});

test('declining the confirmation shares nothing, leaves the online home unchanged and says so', async () => {
  await withEnabledTeam(async (s) => {
    const before = remoteMain(s.fixture);
    const outcome = await s.share('command', [undefined]);
    assert.equal(outcome, 'declined');
    assert.equal(remoteMain(s.fixture), before, 'nothing was pushed');
    assert.deepEqual(s.announced, [['info', SHARE_TEXT.declined]]);
    assert.equal(SHARE_TEXT.declined, 'Nothing was shared.');
  });
});

test('before an invite the button reads Share and continue and the question says the setup must be online so the invite can find the team', async () => {
  await withEnabledTeam(async (s) => {
    const outcome = await s.share('invite', [SHARE_TEXT.shareAndContinue]);
    assert.equal(outcome, 'shared');
    assert.equal(SHARE_TEXT.shareAndContinue, 'Share and continue');
    assert.deepEqual(modals(), [SHARE_TEXT.inviteQuestion]);
    assert.ok(SHARE_TEXT.inviteQuestion.includes('before you invite') || SHARE_TEXT.inviteQuestion.includes('Before you invite'));
    assert.ok(SHARE_TEXT.inviteQuestion.includes('find the team'));
    assert.deepEqual(stub.notificationActions[0], [SHARE_TEXT.shareAndContinue]);
  });
});

test('a first upload (no main online yet) says the project goes online for the first time, and only the agreed upload sends it', async () => {
  await withEnabledTeam(async (s) => {
    gitIn(s.fixture.remote, ['update-ref', '-d', 'refs/heads/main']);
    const outcome = await s.share('command', [SHARE_TEXT.share]);
    assert.equal(outcome, 'shared');
    assert.ok((stub.notificationOptions[0]?.detail ?? '').includes(SHARE_TEXT.firstUpload), 'the confirmation says so');
    assert.equal(SHARE_TEXT.firstUpload, 'This puts your project online for the first time, with the team setup in it.');
    assert.equal(remoteMain(s.fixture), gitIn(s.root, ['rev-parse', 'refs/heads/main']));
  });
});

test('already online: no question; the command says so and an invite just continues in silence', async () => {
  await withEnabledTeam(async (s) => {
    assert.equal(await s.share('command', [SHARE_TEXT.share]), 'shared');
    resetStub();
    s.announced.length = 0;
    assert.equal(await s.share('command'), 'already');
    assert.deepEqual(modals(), [], 'no question');
    assert.deepEqual(s.announced, [['info', SHARE_TEXT.already]]);
    assert.equal(SHARE_TEXT.already, 'Your team setup is already online, so teammates can join.');
    s.announced.length = 0;
    assert.equal(await s.share('invite'), 'already');
    assert.deepEqual(s.announced, [], 'nothing is said before an invite');
    assert.deepEqual(modals(), []);
  });
});

test('when teammates cannot reach the project the person reads Enable\'s plain words with what to do, and nothing is pushed', async () => {
  await withEnabledTeam(async (s) => {
    const before = remoteMain(s.fixture);
    const outcome = await s.share('command', [undefined]);
    assert.equal(outcome, 'not-reachable');
    assert.deepEqual(modals(), [LOCAL_ONLY_TEXT]);
    assert.ok((stub.notificationOptions[0]?.detail ?? '').includes('for example on GitHub'));
    assert.equal(remoteMain(s.fixture), before);
    assert.ok(s.lines.some((line) => line.includes('folder on this computer')), 'the technical reason is in the channel');
  }, { home: 'local' });
});

test('an online home that refuses the push (pre-receive hook) is explained in plain words with Show details; the channel keeps the redacted reason', async () => {
  await withEnabledTeam(async (s) => {
    const hook = path.join(s.fixture.remote, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "protected branch: main only takes reviewed changes, token https://bot:hooksecret@example.invalid/x" >&2\nexit 1\n', 'utf8');
    chmodSync(hook, 0o755);
    const before = remoteMain(s.fixture);
    const outcome = await s.share('command', [SHARE_TEXT.share, undefined]);
    assert.equal(outcome, 'failed');
    assert.equal(remoteMain(s.fixture), before);
    const index = stub.notifications.findIndex((entry) => entry.message === SHARE_TEXT.rejected);
    assert.ok(index >= 0, stub.notifications.map((entry) => entry.message).join(' | '));
    assert.equal(stub.notifications[index]?.level, 'error');
    assert.deepEqual(stub.notificationActions[index], [SHOW_DETAILS_ACTION]);
    assert.ok(SHARE_TEXT.rejected.includes('did not accept the team setup'));
    assert.ok(SHARE_TEXT.rejected.includes('through a review'));
    assert.ok(s.lines.some((line) => line.includes('protected branch')), 'the reason is in the channel');
    assert.equal(s.lines.join('\n').includes('hooksecret'), false, 'redacted');
    assert.equal(shownText(s).includes('protected branch'), false, 'the person never reads the technical reason');
  });
});

test('offline: plain words with Try again and Show details; each Try again tries once more', async () => {
  await withEnabledTeam(async (s) => {
    // The address now leads nowhere, as when the internet is down.
    gitIn(s.root, ['config', '--unset-all', `url.${s.fixture.remote}.insteadOf`]);
    gitIn(s.root, ['config', `url.${path.join(s.fixture.root, 'unreachable.git')}.insteadOf`, PUBLIC_URL]);
    const outcome = await s.share('command', [TRY_AGAIN_ACTION, undefined]);
    assert.equal(outcome, 'failed');
    const offline = stub.notifications.filter((entry) => entry.message === SHARE_TEXT.offline);
    assert.equal(offline.length, 2, 'Try again tried exactly once more');
    const index = stub.notifications.findIndex((entry) => entry.message === SHARE_TEXT.offline);
    assert.deepEqual(stub.notificationActions[index], [TRY_AGAIN_ACTION, SHOW_DETAILS_ACTION]);
    assert.deepEqual(modals(), [], 'no confirmation was asked while nothing could be shared');
    assert.equal(s.lines.join('\n').includes('unreachable.git'), false, 'the address is not in the channel');
  });
});

test('every sentence and button of the share experience is plain: no developer words and no em-dash', () => {
  const developerWords = /\b(branch|commit|push|pushed|remote|repository|repo|merge|rebase|git|team\.json)\b/i;
  for (const [key, value] of Object.entries(SHARE_TEXT)) {
    assert.equal(developerWords.test(value), false, `${key}: ${value}`);
    assert.equal(value.includes(EM_DASH), false, key);
  }
});
