// Plan 15, tasks 2 and 3: joining a synced project from a computer that already has chats of its own, a new recovery code, the key-file switch, turning
// off, the code never stored or logged, and (task 3) the commands' triggers, remote choice and status. Local bare repositories and fakes only.
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { readFile, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { redactSecrets } from '../domain/redaction';
import { generateRecoveryCode } from '../domain/state/recoveryCode';
import { StateRefusedError } from '../domain/state/keys';
import { StateKeys } from '../services/stateKeys';
import { archiveThread } from '../services/threadArchive';
import { enterCodeFlow, keepKeyFlow, newCodeFlow, readSyncSettings, turnOffFlow, turnOnFlow } from '../services/syncFlows';
import { KEY_SENTINEL, bareRemote, computer, fakeUi, fixtureGit, setUpProfile, type Computer } from './helpers/flowFixtures';
import { scanRemote } from './helpers/gitFixtures';
import { SIX_TURNS, chain, treeHash } from './helpers/syncFixtures';
import { MemorySecrets } from './helpers/stateFixtures';

async function thread(c: Computer, id: string, title: string): Promise<string[]> {
  await c.threads.create({ id, title, model: 'near/model-a', origin: 'panel' });
  const entries = chain(id, c.parts.writer, SIX_TURNS);
  await c.threads.appendEntries(id, entries);
  return entries.map((entry) => entry.id).sort();
}

async function ids(c: Computer, id: string): Promise<string[]> {
  return (await c.threads.entries(id)).map((entry) => entry.id).sort();
}

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await files(full)); else out.push(full);
  }
  return out;
}

function remoteTip(remote: string): string {
  return fixtureGit(remote, ['rev-parse', 'refs/heads/near-ai/state']).trim();
}

/** Records everything the console prints while `work` runs. */
async function spied<T>(work: () => Promise<T>): Promise<{ value: T; printed: string[] }> {
  const printed: string[] = [];
  const names = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const saved = names.map((name) => console[name]);
  for (const name of names) console[name] = (...args: unknown[]): void => { printed.push(args.map((item) => (item instanceof Error ? `${item.message}\n${item.stack ?? ''}` : String(item))).join(' ')); };
  try {
    return { value: await work(), printed };
  } finally {
    names.forEach((name, index) => { console[name] = saved[index] as never; });
  }
}

function hasCode(text: string, code: string): boolean {
  return text.includes(code) || text.includes(code.replace(/-/g, ''));
}

// ---- joining ------------------------------------------------------------------------------------------------------------------------

test('join: a computer with chats of its own adds them to the synced project: all of its threads and the online ones are listed and readable, and nothing is lost', async () => {
  const remote = bareRemote({ withMain: false });
  const a = computer(remote, 'alpha');
  const onlineIds = await thread(a, 'conv-online-1', 'Online one');
  const turnOn = fakeUi();
  assert.equal((await turnOnFlow({ env: a.env, ui: turnOn.ui })).status, 'on');

  const b = computer(remote, 'bravo');
  const own = {
    'conv-local-1': await thread(b, 'conv-local-1', 'Local one'),
    'conv-local-2': await thread(b, 'conv-local-2', 'Local two'),
    'conv-local-3': await thread(b, 'conv-local-3', 'Local three')
  };
  assert.equal(await archiveThread(b.threads, 'conv-local-3'), true, 'one of them is archived');
  const ownStateId = (await b.home.readMeta())?.stateId;

  const enter = fakeUi({ code: turnOn.shown[0] });
  const result = await enterCodeFlow({ env: b.env, ui: enter.ui });
  assert.equal(result.status, 'restored');
  assert.equal(enter.confirms.length, 1, 'joining is asked about once');
  assert.notEqual((await b.home.readMeta())?.stateId, ownStateId);
  assert.equal((await b.home.readMeta())?.stateId, (await a.home.readMeta())?.stateId, 'this computer took the project\'s id');

  const listed = (await b.threads.index()).map((item) => item.id).sort();
  assert.deepEqual(listed, ['conv-local-1', 'conv-local-2', 'conv-local-3', 'conv-online-1']);
  for (const [id, expected] of Object.entries(own)) assert.deepEqual(await ids(b, id), expected, `${id} is whole`);
  assert.deepEqual(await ids(b, 'conv-online-1'), onlineIds);
  assert.deepEqual((await readdir(path.dirname(b.home.dir))).filter((name) => name.startsWith('state.')), [], 'the folder kept from before is removed after the sync worked');

  // Its chats went up, so a third computer sees all four.
  const c = computer(remote, 'charlie');
  assert.equal((await enterCodeFlow({ env: c.env, ui: fakeUi({ code: turnOn.shown[0] }).ui })).status, 'restored');
  assert.deepEqual((await c.threads.index()).map((item) => item.id).sort(), listed);
  assert.deepEqual(await ids(c, 'conv-local-2'), own['conv-local-2']);
});

test('join: a failure at either rename, or a cut-off run, leaves the original folder intact and a rerun completes', async () => {
  const remote = bareRemote({ withMain: false });
  const a = computer(remote, 'alpha');
  await thread(a, 'conv-online-1', 'Online one');
  const turnOn = fakeUi();
  assert.equal((await turnOnFlow({ env: a.env, ui: turnOn.ui })).status, 'on');

  const b = computer(remote, 'bravo');
  const own = await thread(b, 'conv-local-1', 'Local one');
  const before = treeHash(b.home.dir);
  const parent = path.dirname(b.home.dir);
  const code = turnOn.shown[0] as string;

  for (const point of ['built', 'between-renames'] as const) {
    const crashed = await enterCodeFlow({ env: b.env, ui: fakeUi({ code }).ui, adopt: { hook: (at) => { if (at === point) throw new Error('simulated failure'); } } });
    assert.equal(crashed.status, 'failed', point);
    assert.equal(treeHash(b.home.dir), before, `${point}: the original folder is byte-identical`);
    assert.deepEqual((await readdir(parent)).filter((name) => name.startsWith('state.')), [], `${point}: no half-built folder is left`);
    assert.deepEqual(await ids(b, 'conv-local-1'), own);
  }

  // A run that was cut off after the first rename: no state folder, the original beside it.
  await rename(b.home.dir, path.join(parent, 'state.previous-cut'));
  const done = await enterCodeFlow({ env: b.env, ui: fakeUi({ code }).ui });
  assert.equal(done.status, 'restored');
  assert.deepEqual(await ids(b, 'conv-local-1'), own, 'the cut-off original was put back and joined');
  assert.ok((await b.threads.index()).some((item) => item.id === 'conv-online-1'));
});

test('join: chats that are locked on this computer are not touched, and declining the question changes nothing', async () => {
  const remote = bareRemote({ withMain: false });
  const a = computer(remote, 'alpha');
  await thread(a, 'conv-online-1', 'Online one');
  const turnOn = fakeUi();
  assert.equal((await turnOnFlow({ env: a.env, ui: turnOn.ui })).status, 'on');
  const b = computer(remote, 'bravo');
  await thread(b, 'conv-local-1', 'Local one');
  const before = treeHash(b.home.dir);
  const declined = await enterCodeFlow({ env: b.env, ui: fakeUi({ code: turnOn.shown[0], confirm: false }).ui });
  assert.equal(declined.status, 'cancelled');
  assert.equal(treeHash(b.home.dir), before);
  // An editor with no key for this project cannot read its chats, so it does not guess.
  const locked = computer(remote, 'locked', { root: b.root, keepKeyInProject: () => false });
  const refused = await enterCodeFlow({ env: locked.env, ui: fakeUi({ code: turnOn.shown[0] }).ui });
  assert.equal(refused.status, 'refused');
  assert.equal(treeHash(b.home.dir), before);
});

// ---- a new code ---------------------------------------------------------------------------------------------------------------------

test('newCodeFlow: the new code opens a fresh computer and the old one is refused; an older computer syncing later does not undo it; the message says earlier copies still open with the old code', async () => {
  const remote = bareRemote({ withMain: false });
  const a = computer(remote, 'alpha');
  await setUpProfile(a);
  await thread(a, 'conv-online-1', 'Online one');
  const first = fakeUi();
  assert.equal((await turnOnFlow({ env: a.env, ui: first.ui })).status, 'on');
  const oldCode = first.shown[0] as string;
  const b = computer(remote, 'bravo');
  assert.equal((await enterCodeFlow({ env: b.env, ui: fakeUi({ code: oldCode }).ui })).status, 'restored');

  const rotate = fakeUi();
  const rotated = await newCodeFlow({ env: a.env, ui: rotate.ui });
  assert.equal(rotated.status, 'done');
  assert.equal(rotate.shown.length, 1);
  const newCode = rotate.shown[0] as string;
  assert.notEqual(newCode, oldCode);
  assert.match(rotate.messages.join('\n'), /copies already on your git host can still be opened with the old code/i);

  const c = computer(remote, 'charlie');
  const wrong = await enterCodeFlow({ env: c.env, ui: fakeUi({ code: oldCode }).ui });
  assert.equal(wrong.status, 'refused', 'the old code is refused for the new manifest');
  assert.equal(wrong.message, new StateRefusedError('wrong-code-or-damaged').message);
  assert.ok(!existsSync(path.join(c.root, '.near-ai')));
  assert.equal((await enterCodeFlow({ env: c.env, ui: fakeUi({ code: newCode }).ui })).status, 'restored');
  assert.deepEqual((await c.threads.index()).map((item) => item.id), ['conv-online-1']);

  // B still holds the old code's wrap; its next push keeps the new one on the remote.
  await thread(b, 'conv-bravo-1', 'From bravo');
  assert.equal((await b.env.makeSync({ remote: 'origin' }).sync()).kind, 'synced');
  const d = computer(remote, 'delta');
  assert.equal((await enterCodeFlow({ env: d.env, ui: fakeUi({ code: newCode }).ui })).status, 'restored', 'the new code still opens it after the older computer pushed');
  assert.equal((await enterCodeFlow({ env: computer(remote, 'echo').env, ui: fakeUi({ code: oldCode }).ui })).status, 'refused');
});

// ---- the key file -------------------------------------------------------------------------------------------------------------------

test('keepKeyFlow(false) with no recovery code shows one once, asks, removes keys/local.key, and a fresh editor is locked until the code is entered; (true) writes the file again at mode 0600', async () => {
  const remote = bareRemote({ withMain: false });
  const a = computer(remote, 'alpha');
  await setUpProfile(a);
  const own = await thread(a, 'conv-key-one', 'Key one');
  assert.ok(existsSync(a.home.paths.localKey));

  const declined = await keepKeyFlow({ env: a.env, ui: fakeUi({ confirm: false }).ui }, false);
  assert.equal(declined.status, 'cancelled');
  assert.ok(existsSync(a.home.paths.localKey), 'declining leaves the key file');
  assert.ok(!existsSync(a.home.paths.recoveryWrap), 'and makes no code');

  const off = fakeUi();
  assert.equal((await keepKeyFlow({ env: a.env, ui: off.ui }, false)).status, 'done');
  assert.equal(off.shown.length, 1, 'a recovery code was shown once, because none existed');
  assert.equal(off.confirms.length, 1);
  assert.ok(!existsSync(a.home.paths.localKey), 'the key file is gone');
  assert.ok(existsSync(a.home.paths.recoveryWrap), 'the code can open the project');
  assert.deepEqual(await ids(a, 'conv-key-one'), own, 'this editor still opens its chats (its own secret storage holds the key)');

  const fresh = new StateKeys(a.home, new MemorySecrets(), () => false);
  assert.equal(await fresh.dataKey(), undefined, 'a fresh editor is locked');
  const editor = computer(remote, 'second', { root: a.root, keepKeyInProject: () => false });
  assert.deepEqual((await editor.threads.index()).map((item) => ({ id: item.id, locked: item.locked })), [{ id: 'conv-key-one', locked: true }]);
  const wrongCode = await enterCodeFlow({ env: editor.env, ui: fakeUi({ code: generateRecoveryCode().code }).ui });
  assert.equal(wrongCode.status, 'refused');
  const opened = await enterCodeFlow({ env: editor.env, ui: fakeUi({ code: off.shown[0] }).ui });
  assert.equal(opened.status, 'unlocked');
  assert.deepEqual(await ids(editor, 'conv-key-one'), own, 'the code opened the chats on the fresh editor');

  const on = await keepKeyFlow({ env: a.env, ui: fakeUi().ui }, true);
  assert.equal(on.status, 'done');
  assert.ok(existsSync(a.home.paths.localKey), 'the key file is written again from the unlocked key');
  assert.equal(statSync(a.home.paths.localKey).mode & 0o777, 0o600);
  const again = new StateKeys(a.home, new MemorySecrets(), () => true);
  assert.ok(await again.dataKey(), 'and a fresh editor opens the project with no code');
});

test('keepKeyFlow(false) when a recovery code exists shows no new code', async () => {
  const remote = bareRemote({ withMain: false });
  const a = computer(remote, 'alpha');
  await thread(a, 'conv-key-two', 'Key two');
  assert.equal((await turnOnFlow({ env: a.env, ui: fakeUi().ui })).status, 'on');
  const off = fakeUi();
  assert.equal((await keepKeyFlow({ env: a.env, ui: off.ui }, false)).status, 'done');
  assert.equal(off.shown.length, 0);
  assert.ok(!existsSync(a.home.paths.localKey));
});

// ---- turning off --------------------------------------------------------------------------------------------------------------------

test('turnOffFlow stops syncing and leaves the remote branch and this computer\'s state as they are', async () => {
  const remote = bareRemote({ withMain: false });
  const a = computer(remote, 'alpha');
  const own = await thread(a, 'conv-off-one', 'Off one');
  assert.equal((await turnOnFlow({ env: a.env, ui: fakeUi().ui })).status, 'on');
  assert.equal((await readSyncSettings(a.home)).enabled, true);
  const tip = remoteTip(remote);
  const seen: boolean[] = [];
  const env = { ...a.env, onEnabled: (on: boolean) => { seen.push(on); } };
  const off = fakeUi();
  assert.equal((await turnOffFlow({ env, ui: off.ui })).status, 'done');
  assert.deepEqual(seen, [false]);
  assert.equal((await readSyncSettings(a.home)).enabled, false);
  assert.equal(remoteTip(remote), tip, 'nothing was pushed or removed');
  assert.deepEqual(await ids(a, 'conv-off-one'), own);
  assert.match(off.messages.join('\n'), /sync is off/i);
});

// ---- the code is never stored or logged ---------------------------------------------------------------------------------------------

test('across every flow no console line, message, file under a state home, or secret holds the recovery code, with or without hyphens', async () => {
  const remote = bareRemote({ withMain: false });
  const a = computer(remote, 'alpha');
  await setUpProfile(a);
  await thread(a, 'conv-leak-1', 'Leak one');
  const b = computer(remote, 'bravo');
  const keyOff = computer(remote, 'keyoff');
  await thread(keyOff, 'conv-leak-2', 'Leak two');
  const typedWrong = generateRecoveryCode().code;

  const shown: string[] = [];
  const messages: string[] = [];
  const capture = (fake: ReturnType<typeof fakeUi>): ReturnType<typeof fakeUi> => { shown.push(...fake.shown); messages.push(...fake.messages); return fake; };
  const run = await spied(async () => {
    const first = fakeUi();
    await turnOnFlow({ env: a.env, ui: first.ui }); capture(first);
    const typed = fakeUi({ code: first.shown[0] });
    await enterCodeFlow({ env: b.env, ui: typed.ui }); capture(typed);
    const wrong = fakeUi({ code: typedWrong });
    await enterCodeFlow({ env: computer(remote, 'wrong').env, ui: wrong.ui }); capture(wrong);
    const rotate = fakeUi();
    await newCodeFlow({ env: a.env, ui: rotate.ui }); capture(rotate);
    const off = fakeUi();
    await keepKeyFlow({ env: keyOff.env, ui: off.ui }, false); capture(off);
    const out = fakeUi();
    await turnOffFlow({ env: a.env, ui: out.ui }); capture(out);
  });
  const codes = [...new Set(shown)];
  assert.equal(codes.length >= 3, true, 'three different codes were made');
  const everything = [...run.printed, ...messages];
  for (const code of [...codes, typedWrong]) {
    for (const line of everything) assert.ok(!hasCode(line, code), `a line holds a code: ${line.slice(0, 80)}`);
    for (const machine of [a, b, keyOff]) {
      for (const file of await files(machine.home.dir)) assert.ok(!hasCode((await readFile(file)).toString('latin1'), code), `${file} holds a code`);
      for (const value of machine.secrets.values.values()) assert.ok(!hasCode(value, code));
    }
    assert.deepEqual(scanRemote(remote, [code, code.replace(/-/g, '')]).hits, []);
  }
  assert.ok(!(await readFile(a.store.filePath, 'utf8')).includes(KEY_SENTINEL));
});

test('redactSecrets removes anything shaped like a recovery code and leaves ordinary prose alone', () => {
  assert.equal(redactSecrets('code ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789 here'), 'code [REDACTED] here');
  const real = generateRecoveryCode().code;
  assert.equal(redactSecrets(`the code was ${real}.`), 'the code was [REDACTED].');
  assert.equal(redactSecrets(`typed ${real.toLowerCase()} by hand`), 'typed [REDACTED] by hand');
  const plain = real.replace(/-/g, '');
  assert.equal(plain.length, 52);
  assert.equal(redactSecrets(`run ${plain} now`), 'run [REDACTED] now');
  for (const prose of ['a well-known, state-of-the-art, long-lived, hyphen-rich phrase', 'Update encrypted project state', 'sha 0123456789abcdef0123456789abcdef01234567 is a commit', 'ABCD-EFGH-JKMN is only three groups', 'The MAX-RETRY-LIMIT is 5']) {
    assert.equal(redactSecrets(prose), prose);
  }
});
