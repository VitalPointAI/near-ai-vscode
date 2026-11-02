// SEC-01 for the whole membership lifecycle (Phase 61 plan 14, success criterion 4): after enable, link, invite, join, confirm, key delivery,
// removal and cleanup, no key, token, invite code, device or seal private key, remote password or plain email address is in any place that is written
// down. Every secret is made at run time (nothing secret-shaped is committed). Each place is asserted on its own so a failure names it, and controls
// show the scanners do see a planted value and see the values where they are meant to be (SecretStorage, invites.json, the clone's git config).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import type { TeamFile } from '../domain/team/types';
import { deviceKeySecretName, sealKeySecretName } from '../team/identity';
import { INVITE_FILE } from '../team/invite';
import { parseInviteCode } from '../team/inviteCode';
import { nearSessionSecretName } from '../team/nearSession';
import { TEAM_FILE_REL } from '../team/teamFile';
import {
  DEV_EMAIL, LEAD_EMAIL, OWNER_EMAIL, closeRig, codeOf, confirm, createRig, enable, givePersonalProfile, installKey, invite, join, link, openLog, ownRemoval,
  publishProject, remove, rootOf, storageOf, teamIdOf
} from './helpers/teamFlowRig';
import type { Participant, Rig } from './helpers/teamFlowRig';
import { deviceKeyForms, inviteCodeForms, makeCanaries, scanFiles, scanGitObjects } from './helpers/teamCanary';
import type { Needle } from './helpers/teamCanary';
import { MemorySecrets } from './helpers/teamHarness';
import { createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const sessionModule = require('../services/team/teamSession') as typeof import('../services/team/teamSession');
const barModule = require('../services/team/teamStatusBar') as typeof import('../services/team/teamStatusBar');
test.after(() => { uninstall(); });
const { TeamSession, projectAuditSink } = sessionModule;
const { createTeamStatusBar } = barModule;

async function filesUnder(target: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const found: string[] = [];
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(child));
    else if (entry.isFile()) found.push(child);
  }
  return found;
}

async function mirrorsUnder(storage: string): Promise<string[]> {
  const found: string[] = [];
  for (const file of await filesUnder(storage)) if (path.basename(file) === 'HEAD' && path.basename(path.dirname(file)).endsWith('.git')) found.push(path.dirname(file));
  return found;
}

const labelsIn = (text: string, needles: Needle[]): string[] => needles.filter((needle) => text.includes(needle.value)).map((needle) => needle.label);

function secretOf(secrets: MemorySecrets, name: string): string {
  const value = secrets.values.get(name);
  assert.ok(value !== undefined, `${name} is in SecretStorage`);
  return value as string;
}

// The refresh token a NEAR session keeps in SecretStorage right now (it rotates, so the value at the end differs from the one signed in with).
function keptRefreshToken(secrets: MemorySecrets, teamId: string): string {
  const stored = JSON.parse(secretOf(secrets, nearSessionSecretName(teamId))) as { refreshToken: string };
  return stored.refreshToken;
}

type Session = Awaited<ReturnType<typeof TeamSession.start>>;

test('SEC-01: after invite, join, confirm, key delivery, removal and cleanup no secret, code, private key or plain email is written anywhere', async () => {
  const canaries = makeCanaries();
  const leadCanaries = makeCanaries();
  const rig = await createRig({
    linked: true,
    keySecretPrefix: canaries.apiKey,
    remoteUrl: `https://canaryuser:${canaries.urlPassword}@example.invalid/team.git`,
    ownerTokens: { accessToken: canaries.accessToken, refreshToken: canaries.refreshToken },
    leadTokens: { accessToken: leadCanaries.accessToken, refreshToken: leadCanaries.refreshToken }
  });
  stub.notifications.length = 0;
  stub.notificationActions.length = 0;
  stub.statusBarItems.length = 0;
  stub.configUpdates.length = 0;
  stub.outputChannels.length = 0;
  const sessions: Session[] = [];
  const sessionLines: string[] = [];
  try {
    await enable(rig);
    await link(rig);
    await publishProject(rig);
    const teamId = teamIdOf(rig);
    await givePersonalProfile(rig, rig.dev);

    // Each invitation's code in every text it could be written as, taken from the bundle before the person joins.
    const codeForms: string[] = [];
    for (const person of [rig.dev, rig.lead]) {
      const issued = await invite(rig, person);
      const text = codeOf(issued.bundle);
      const bytes = parseInviteCode(text);
      assert.ok(bytes !== undefined, 'the bundle holds a readable code');
      codeForms.push(...inviteCodeForms(text, Buffer.from(bytes as Buffer)));
      (bytes as Buffer).fill(0);
    }
    assert.ok(new Set(codeForms).size >= 10, 'two codes in at least five renderings each');

    await join(rig, rig.dev);
    await join(rig, rig.lead);
    await confirm(rig, rig.lead);
    await confirm(rig, rig.dev);
    await installKey(rig, rig.dev);
    await installKey(rig, rig.lead);
    const owner = await openLog(rig, 'owner');
    const devKeyId = owner.log.state().members.get(rig.dev.memberId as string)?.nearApiKeyId as string;
    const leadKeyId = owner.log.state().members.get(rig.lead.memberId as string)?.nearApiKeyId as string;
    const devKey = rig.fake.key(devKeyId)?.secret as string;
    const leadKey = rig.fake.key(leadKeyId)?.secret as string;
    assert.ok(devKey.startsWith(canaries.apiKey) && leadKey.startsWith(canaries.apiKey), 'every key the fake made carries the run-time canary prefix');
    // Control: the developer's key really is in SecretStorage at this point, so an empty scan elsewhere means something.
    assert.ok([...rig.dev.secrets.values.values()].some((value) => value.includes(devKey)), 'the installed key is held by SecretStorage');

    // Every private key in its stored form and each way it could be re-encoded, taken now because cleanup deletes the developer's.
    const privateKeys: Needle[] = [];
    for (const [who, secrets] of [['owner', rig.owner.secrets], ['developer', rig.dev.secrets], ['lead', rig.lead.secrets]] as const) {
      const names = who === 'owner' ? [deviceKeySecretName(teamId)] : [deviceKeySecretName(teamId), sealKeySecretName(teamId)];
      for (const name of names) {
        privateKeys.push(...deviceKeyForms(secretOf(secrets, name)).map((value, index) => ({ label: `${who} ${name.split('.')[2]} private key form ${index}`, value })));
      }
    }

    await remove(rig, rig.lead, rig.dev);
    await ownRemoval(rig, rig.dev);

    // The windows a person would have open: the output channel, notifications and status bar are part of what is shown.
    for (const who of ['owner', rig.lead, rig.dev] as const) {
      const person: Participant | undefined = who === 'owner' ? undefined : who;
      const clone = person === undefined ? 'a' : person.clone;
      const v = stub.vscode as {
        window: {
          showInformationMessage(message: string, ...actions: string[]): PromiseLike<string | undefined>;
          showWarningMessage(message: string, ...actions: string[]): PromiseLike<string | undefined>;
        };
      };
      sessions.push(await TeamSession.start({
        projectRoot: rootOf(rig, clone), globalStorageDir: person === undefined ? rig.owner.globalStorageDir : person.globalStorageDir,
        teamFile: rig.teamFile as TeamFile, secrets: person === undefined ? rig.owner.secrets : person.secrets,
        output: { appendLine: (line) => { sessionLines.push(line); }, show: () => undefined }, statusBar: createTeamStatusBar(),
        audit: projectAuditSink(rootOf(rig, clone)),
        notify: { info: (message, ...actions) => v.window.showInformationMessage(message, ...actions), warn: (message, ...actions) => v.window.showWarningMessage(message, ...actions) },
        pollSeconds: () => 3600, focused: () => true, nearBaseUrl: rig.fake.baseUrl, runCommand: async () => undefined
      }));
    }

    // ---- the needles ------------------------------------------------------------------------------------------------------------------
    const tokens: Needle[] = [
      { label: 'owner refresh token (signed in)', value: canaries.refreshToken }, { label: 'owner access token', value: canaries.accessToken },
      { label: 'lead refresh token (signed in)', value: leadCanaries.refreshToken }, { label: 'lead access token', value: leadCanaries.accessToken },
      { label: 'lead refresh token (rotated)', value: keptRefreshToken(rig.lead.secrets, teamId) }, { label: 'owner refresh token (kept)', value: keptRefreshToken(rig.owner.secrets, teamId) }
    ];
    const everySecret: Needle[] = [
      ...canaries.labelled(), ...leadCanaries.labelled().map((needle) => ({ label: `lead ${needle.label}`, value: needle.value })),
      { label: 'developer key', value: devKey }, { label: 'lead key', value: leadKey }, { label: 'remote user', value: 'canaryuser' },
      ...tokens, ...codeForms.map((value, index) => ({ label: `invite code form ${index}`, value })), ...privateKeys
    ];
    // A value that is the same text under two labels (the signed-in refresh token that was never rotated) is looked for once.
    const secretsNeedles = [...new Map(everySecret.map((needle) => [needle.value, needle])).values()];
    const emails: Needle[] = [{ label: 'developer email', value: DEV_EMAIL }, { label: 'lead email', value: LEAD_EMAIL }, { label: 'owner email', value: OWNER_EMAIL }];
    const needles = [...secretsNeedles, ...emails];
    assert.equal(rig.dev.secrets.values.has(deviceKeySecretName(teamId)), false);
    assert.equal(rig.dev.secrets.values.has(sealKeySecretName(teamId)), false);

    // ---- controls ---------------------------------------------------------------------------------------------------------------------
    assert.ok(secretOf(rig.owner.secrets, nearSessionSecretName(teamId)).includes(canaries.refreshToken), 'the signed-in refresh token is in SecretStorage');
    const control = await scanGitObjects(path.join(rootOf(rig, 'a'), '.git'), needles);
    assert.ok(control.includes('remote password') && control.includes('remote user'), 'the owner clone\'s git config holds the canary URL by construction');
    const inviteList = await fs.readFile(path.join(storageOf(rig, 'owner'), INVITE_FILE), 'utf8');
    assert.ok(labelsIn(inviteList, needles).sort().join() === ['developer email', 'lead email'].join(), 'invites.json holds the two emails and nothing else secret');
    const planted = path.join(rig.fixture.storageDir('b'), 'planted-control.txt');
    await fs.writeFile(planted, `before ${canaries.apiKey} after`, 'utf8');
    try {
      assert.deepEqual((await scanFiles([rig.fixture.storageDir('b')], secretsNeedles)).map((hit) => hit.split(': ')[1]), ['access key'], 'a planted canary is found in a storage folder');
    } finally {
      await fs.rm(planted, { force: true });
    }
    const outputText = [...rig.output, ...sessionLines].join('\n');
    assert.ok(outputText.includes('Dana Developer') && sessionLines.length > 0, 'the text under scan is not empty');

    // ---- the places, each asserted on its own ---------------------------------------------------------------------------------------------
    assert.deepEqual(await scanGitObjects(rig.fixture.remote, needles), [], 'bare remote: every coordination blob, object and config');
    for (const name of ['a', 'b', 'c']) {
      const mirrors = await mirrorsUnder(rig.fixture.storageDir(name));
      assert.ok(mirrors.length >= 1, `storage ${name} has a coordination mirror`);
      for (const mirror of mirrors) assert.deepEqual(await scanGitObjects(mirror, needles), [], `mirror of clone ${name}`);
      assert.deepEqual(await scanGitObjects(path.join(rootOf(rig, name as 'a'), '.git'), needles, { includeConfig: false }), [], `project repository objects of clone ${name}`);
      assert.deepEqual(await scanFiles([path.join(rootOf(rig, name as 'a'), TEAM_FILE_REL)], needles), [], `team.json of clone ${name}`);
      assert.deepEqual(await scanFiles([path.join(rootOf(rig, name as 'a'), '.planning')], needles), [], `.planning of clone ${name} (audit store, profiles, transcripts)`);
      // invites.json is the one file that may hold an email, so its emails are not looked for there; everything else is scanned for all of it.
      const storageFiles = await filesUnder(rig.fixture.storageDir(name));
      const others = storageFiles.filter((file) => path.basename(file) !== INVITE_FILE);
      assert.deepEqual(await scanFiles(others, needles), [], `extension storage of clone ${name}`);
      assert.deepEqual(await scanFiles(storageFiles.filter((file) => path.basename(file) === INVITE_FILE), secretsNeedles), [], `${INVITE_FILE} of clone ${name} holds no secret`);
    }
    assert.deepEqual(labelsIn(outputText, needles), [], 'text the flows and the NEAR AI Team output channel produced');
    assert.deepEqual(labelsIn(JSON.stringify(stub.notifications), needles), [], 'notifications');
    assert.deepEqual(labelsIn(JSON.stringify(stub.statusBarItems.map((item) => [item.text, item.tooltip])), needles), [], 'status bar');
    assert.deepEqual(stub.configUpdates, [], 'VS Code settings were never written by the extension');
    assert.deepEqual(stub.outputChannels.flatMap((channel) => labelsIn(channel.lines.join('\n'), needles)), [], 'the output channel as the stub recorded it');
    assert.deepEqual(labelsIn(execFileSync('git', ['log', '--all', '--format=%an%n%ae%n%s%n%b'], { cwd: rootOf(rig, 'a'), encoding: 'utf8' }), needles), [], 'commit messages and authors of the owner clone');
  } finally {
    for (const session of sessions) session.dispose();
    await closeRig(rig);
  }
});
