// Plan 15, tasks 2 and 3: joining a synced project from a computer that already has chats of its own, a new recovery code, the key-file switch, turning
// off, the code never stored or logged, and (task 3) the commands' triggers, remote choice and status. Local bare repositories and fakes only.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readFile, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { redactSecrets } from '../domain/redaction';
import { onRunEnded, runEnded, runStarted, runsInFlight } from '../services/runEndHooks';
import { generateRecoveryCode } from '../domain/state/recoveryCode';
import { StateRefusedError } from '../domain/state/keys';
import { StateKeys } from '../services/stateKeys';
import { archiveThread } from '../services/threadArchive';
import {
  BLUR_IDLE_MS, COALESCE_MS, DEACTIVATE_PUSH_MS, PUSH_BATCH_MS, RETURN_PULL_AFTER_MS, SYNC_INTERVAL_DEFAULT, SyncScheduler, clampSyncInterval, enterCodeFlow, keepKeyFlow,
  afterRemoteFor, localHomeState, newCodeFlow, readSyncSettings, resolveRemote, tokenRunner, turnOffFlow, turnOnFlow, type SyncClock, type SyncRequest
} from '../services/syncFlows';
import type { SyncOutcome } from '../services/stateSync';
import type { GitRunner } from '../services/stateGit';
import { KEY_SENTINEL, bareRemote, computer, fakeUi, fixtureGit, folderWithoutRemote, setUpProfile, type Computer } from './helpers/flowFixtures';
import { hermeticRunner, scanRemote } from './helpers/gitFixtures';
import { syncPanelMessage } from '../services/syncPanel';
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


// ---- remote choice ------------------------------------------------------------------------------------------------------------------

test('the remote is the stored one, else origin, else the only one; several and no origin ask once and remember; none is none', async () => {
  const bareA = bareRemote({ withMain: false });
  const bareB = bareRemote({ withMain: false });
  const c = computer(bareA, 'alpha');
  const asked: string[][] = [];
  const ui = { pickRemote: async (names: string[]) => { asked.push(names); return 'upstream'; } };
  const env = { root: c.root, home: c.home, git: c.parts.git as GitRunner };

  assert.deepEqual(await resolveRemote(env, ui), { kind: 'remote', name: 'origin' }, 'origin is used and nothing is asked');
  assert.deepEqual(asked, []);
  assert.ok(!existsSync(c.home.dir), 'finding the remote writes nothing');

  fixtureGit(c.root, ['remote', 'add', 'upstream', bareB]);
  fixtureGit(c.root, ['remote', 'add', 'backup', bareB]);
  fixtureGit(c.root, ['remote', 'remove', 'origin']);
  assert.deepEqual(await resolveRemote(env, ui), { kind: 'remote', name: 'upstream' }, 'with several and no origin the person picks');
  assert.deepEqual(asked, [['backup', 'upstream']]);
  assert.equal((await readSyncSettings(c.home)).remote, 'upstream', 'the pick is remembered in the state home');
  assert.deepEqual(await resolveRemote(env, ui), { kind: 'remote', name: 'upstream' });
  assert.equal(asked.length, 1, 'and not asked again');

  fixtureGit(c.root, ['remote', 'remove', 'upstream']);
  fixtureGit(c.root, ['remote', 'add', 'other', bareB]);
  assert.deepEqual(await resolveRemote(env, ui), { kind: 'cancelled' }, 'the stored remote is gone, so it asks again, and an answer that is not a remote is no answer');
  assert.equal(asked.length, 2);

  fixtureGit(c.root, ['remote', 'remove', 'other']);
  assert.deepEqual(await resolveRemote(env, ui), { kind: 'remote', name: 'backup' }, 'a single remote is used');
  fixtureGit(c.root, ['remote', 'remove', 'backup']);
  assert.deepEqual(await resolveRemote(env, ui), { kind: 'none' });
  assert.deepEqual(await resolveRemote({ ...env, root: folderWithoutRemote() }, ui), { kind: 'none' }, 'a folder with no remote at all');
});

// ---- the interval setting -----------------------------------------------------------------------------------------------------------

test('clampSyncInterval reads the setting the way package.json declares it', () => {
  assert.equal(clampSyncInterval(-5), 0);
  assert.equal(clampSyncInterval(5000), 1440);
  assert.equal(clampSyncInterval('x'), 10);
  assert.equal(clampSyncInterval(2.7), 2);
  assert.equal(clampSyncInterval(0), 0);
  assert.equal(clampSyncInterval(Number.NaN), SYNC_INTERVAL_DEFAULT);
  assert.equal(clampSyncInterval(undefined), SYNC_INTERVAL_DEFAULT);
  const manifest = JSON.parse(require('node:fs').readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { contributes: { configuration: { properties: Record<string, Record<string, unknown>> }; commands: Array<{ command: string; title: string; category: string }> } };
  const setting = manifest.contributes.configuration.properties['nearAi.sync.intervalMinutes'] as Record<string, unknown>;
  assert.ok(setting, 'the setting is declared');
  assert.equal(setting.type, 'number');
  assert.equal(setting.default, SYNC_INTERVAL_DEFAULT);
  assert.equal(setting.minimum, 0);
  assert.equal(setting.maximum, 1440);
  assert.match(String(setting.description), /0 turns the background sync off/);
  const titles = new Map(manifest.contributes.commands.map((command) => [command.command, command]));
  const wanted: Array<[string, string]> = [
    ['nearAi.sync.turnOn', 'Turn On Project Sync'], ['nearAi.sync.now', 'Sync Project Now'], ['nearAi.sync.enterRecoveryCode', 'Enter Recovery Code'],
    ['nearAi.sync.newRecoveryCode', 'Show a New Recovery Code'], ['nearAi.sync.turnOff', 'Turn Off Project Sync'], ['nearAi.sync.onlineHome', 'Give This Project an Online Home']
  ];
  for (const [command, title] of wanted) {
    assert.equal(titles.get(command)?.title, title, command);
    assert.equal(titles.get(command)?.category, 'NEAR AI');
  }
  for (const text of [...titles.values()].filter((command) => command.command.startsWith('nearAi.sync.')).map((command) => command.title)) assert.ok(!/NEAR organization/.test(text));
});

// ---- the scheduler, on a fake clock ---------------------------------------------------------------------------------------------------

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class FakeClock implements SyncClock {
  public time = Date.parse('2026-11-13T10:00:00.000Z');
  private timers: Array<{ id: number; at: number; work: () => void }> = [];
  private next = 1;
  public now(): number { return this.time; }
  public setTimeout(work: () => void, ms: number): unknown { const id = this.next++; this.timers.push({ id, at: this.time + ms, work }); return id; }
  public clearTimeout(handle: unknown): void { this.timers = this.timers.filter((timer) => timer.id !== handle); }
  public get pendingTimers(): number { return this.timers.length; }
  /** Moves time forward, running every timer that falls due, in order, and letting what each starts finish. */
  public async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.time = Math.max(this.time, due.at);
      due.work();
      await settle();
    }
    this.time = target;
    await settle();
  }
}

const OK: SyncOutcome = { kind: 'synced', message: 'Your project is up to date everywhere it is shared.', pushed: true };
const OFFLINE: SyncOutcome = { kind: 'failed', message: 'Could not reach your git host.', failure: { kind: 'offline', message: 'Could not reach your git host.' } };
const SECONDS = 1000;
const MINUTES = 60_000;

function harness(options: { interval?: unknown } = {}) {
  const clock = new FakeClock();
  const calls: Array<SyncRequest & { at: number }> = [];
  let runs = 0;
  let interval: unknown = options.interval ?? 10;
  let outcome: (request: SyncRequest) => Promise<SyncOutcome> = async () => OK;
  const scheduler = new SyncScheduler({
    clock, runsInFlight: () => runs, intervalMinutes: () => interval,
    runSync: async (request) => { calls.push({ ...request, at: clock.now() }); return outcome(request); }
  });
  scheduler.setEnabled(true);
  return {
    clock, calls, scheduler,
    runs: (count: number) => { runs = count; },
    interval: (value: unknown) => { interval = value; },
    outcome: (fn: (request: SyncRequest) => Promise<SyncOutcome>) => { outcome = fn; },
    /** Calls so far, with their reasons and kinds, as short text. */
    log: () => calls.map((call) => `${call.mode}:${call.reason}${call.interactive ? ':click' : ''}`)
  };
}

test('sync is off until turned on: nothing is scheduled and the status says so', async () => {
  const clock = new FakeClock();
  let count = 0;
  const scheduler = new SyncScheduler({ clock, runsInFlight: () => 0, intervalMinutes: () => 10, runSync: async () => { count += 1; return OK; } });
  assert.deepEqual(scheduler.status(), { state: 'off' });
  scheduler.start();
  scheduler.runEnded();
  scheduler.windowFocus(false);
  assert.equal(await scheduler.syncNow(), undefined);
  await clock.advance(30 * MINUTES);
  assert.equal(count, 0);
  assert.equal(clock.pendingTimers, 0);
  assert.deepEqual(scheduler.status(), { state: 'off' });
});

test('a pull starts when the project opens, is not waited for, and the status says it is checking for updates', async () => {
  const h = harness();
  let finish: (outcome: SyncOutcome) => void = () => undefined;
  h.outcome(() => new Promise<SyncOutcome>((resolve) => { finish = resolve; }));
  const seen: string[] = [];
  h.scheduler.onStatus((status) => seen.push(`${status.state}${status.reason ? `:${status.reason}` : ''}`));
  const started = h.scheduler.start();
  assert.equal(started, undefined, 'start returns at once: activation never waits for the sync');
  assert.deepEqual(h.scheduler.status(), { state: 'syncing', reason: 'open' });
  assert.deepEqual(h.log(), ['pull:open'], 'a pull, not a push, and it asks for no sign-in');
  finish({ kind: 'synced', message: 'Your project is up to date everywhere it is shared.' });
  await settle();
  const done = h.scheduler.status();
  assert.equal(done.state, 'synced');
  assert.equal(done.at, new Date(h.clock.time).toISOString());
  assert.ok(seen.includes('syncing:open') && seen.at(-1) === 'synced');
});

test('a pull runs when the window comes back after five minutes away, and not after four', async () => {
  const four = harness({ interval: 0 });
  four.scheduler.windowFocus(false);
  await four.clock.advance(4 * MINUTES);
  four.scheduler.windowFocus(true);
  await four.clock.advance(MINUTES);
  assert.ok(!four.log().includes('pull:return'), 'four minutes away is not enough');
  assert.deepEqual(four.log(), ['sync:blur-idle'], 'only the full sync after a minute out of focus ran');

  const five = harness({ interval: 0 });
  five.scheduler.windowFocus(false);
  await five.clock.advance(RETURN_PULL_AFTER_MS);
  five.scheduler.windowFocus(true);
  await settle();
  assert.deepEqual(five.log(), ['sync:blur-idle', 'pull:return']);
  assert.equal(RETURN_PULL_AFTER_MS, 300_000);
});

test('a full sync follows a minute out of focus when nothing is running, and a run in flight stops it', async () => {
  const h = harness({ interval: 0 });
  h.scheduler.windowFocus(false);
  await h.clock.advance(BLUR_IDLE_MS + COALESCE_MS - SECONDS);
  assert.deepEqual(h.log(), [], 'not before the minute and the short wait that joins requests');
  await h.clock.advance(SECONDS);
  assert.deepEqual(h.log(), ['sync:blur-idle']);

  const busy = harness({ interval: 0 });
  busy.runs(1);
  busy.scheduler.windowFocus(false);
  await busy.clock.advance(10 * MINUTES);
  assert.deepEqual(busy.log(), [], 'nothing runs while a run is in flight');
  busy.scheduler.windowFocus(true);
});

test('the interval syncs while idle, is skipped during a run, can be turned off with 0, and follows the setting when it changes', async () => {
  const h = harness({ interval: 10 });
  await h.clock.advance(10 * MINUTES + COALESCE_MS - SECONDS);
  assert.deepEqual(h.log(), []);
  await h.clock.advance(SECONDS);
  assert.deepEqual(h.log(), ['sync:interval']);

  h.runs(1);
  await h.clock.advance(10 * MINUTES);
  assert.equal(h.calls.length, 1, 'the tick during a run did nothing');
  h.runs(0);
  await h.clock.advance(10 * MINUTES);
  assert.equal(h.calls.length, 2, 'it goes on once idle again');

  h.interval(0);
  h.scheduler.reschedule();
  const before = h.calls.length;
  await h.clock.advance(60 * MINUTES);
  assert.equal(h.calls.length, before, '0 turns the background sync off');

  h.interval(3);
  h.scheduler.reschedule();
  await h.clock.advance(3 * MINUTES + COALESCE_MS);
  assert.equal(h.calls.length, before + 1, 'a new interval takes effect from the change');
});

test('a run ending starts a full sync; asking during a run is kept and runs at its end; requests close together are one sync', async () => {
  const h = harness({ interval: 0 });
  h.runs(1);
  assert.equal((await h.scheduler.syncNow())?.kind, 'waiting', 'Sync Project Now during a run waits');
  await h.clock.advance(MINUTES);
  assert.deepEqual(h.log(), [], 'never while a run is in flight');
  h.runs(0);
  h.scheduler.runEnded();
  await h.clock.advance(COALESCE_MS);
  assert.deepEqual(h.log(), ['sync:manual'], 'what was asked during the run runs once, when the run ends, with no sign-in prompt');

  const burst = harness({ interval: 0 });
  burst.scheduler.runEnded();
  await burst.clock.advance(SECONDS);
  burst.scheduler.runEnded();
  await burst.clock.advance(SECONDS);
  burst.scheduler.runEnded();
  await burst.clock.advance(COALESCE_MS + SECONDS);
  assert.equal(burst.calls.length, 1, 'three requests within seconds make one sync');
});

test('automatic pushes are at least two minutes apart; Sync Project Now is not held back', async () => {
  const h = harness({ interval: 0 });
  h.scheduler.runEnded();
  await h.clock.advance(COALESCE_MS);
  assert.equal(h.calls.length, 1);
  const firstAt = h.calls[0]?.at as number;
  await h.clock.advance(SECONDS);
  h.scheduler.runEnded();
  await h.clock.advance(PUSH_BATCH_MS - 10 * SECONDS);
  assert.equal(h.calls.length, 1, 'a second push within two minutes of the first waits');
  await h.clock.advance(10 * SECONDS);
  assert.equal(h.calls.length, 2);
  assert.ok((h.calls[1]?.at as number) - firstAt >= PUSH_BATCH_MS);

  const click = await h.scheduler.syncNow();
  assert.equal(click?.kind, 'synced');
  assert.equal(h.calls.length, 3, 'the click went at once');
  assert.deepEqual(h.log().at(-1), 'sync:manual:click', 'and only a click may ask for a sign-in');
  for (const call of h.calls.slice(0, 2)) assert.equal(call.interactive, false, 'no automatic sync asks for a sign-in');
});

test('offline failures back off 1, 2, 4 ... up to 30 minutes and a success resets it', async () => {
  const h = harness({ interval: 0 });
  h.outcome(async () => OFFLINE);
  h.scheduler.runEnded();
  await h.clock.advance(COALESCE_MS);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.scheduler.status(), { state: 'attention', message: "Couldn't reach your git host, will retry." });
  const gaps: number[] = [];
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const last = h.calls.at(-1)?.at as number;
    for (let waited = 0; h.calls.length === attempt + 1 && waited < 40 * MINUTES; waited += SECONDS) await h.clock.advance(SECONDS);
    assert.equal(h.calls.length, attempt + 2, `retry ${attempt + 1} happened`);
    gaps.push(((h.calls[attempt + 1]?.at as number) - last) / SECONDS);
  }
  assert.deepEqual(gaps, [60, 120, 240, 480, 960, 1800, 1800]);
  h.outcome(async () => OK);
  await h.clock.advance(40 * MINUTES);
  assert.equal(h.scheduler.status().state, 'synced');
  const settled = h.calls.length;
  h.scheduler.runEnded();
  await h.clock.advance(PUSH_BATCH_MS);
  assert.equal(h.calls.length, settled + 1, 'after a success the next trigger runs without the backoff');
});

test('the editor closing tries one sync and gives up after three seconds, however long it hangs', async () => {
  const h = harness({ interval: 0 });
  h.outcome(() => new Promise<SyncOutcome>(() => undefined));
  let done = false;
  const closing = h.scheduler.flushOnClose().then(() => { done = true; });
  await settle();
  assert.deepEqual(h.log(), ['sync:close']);
  await h.clock.advance(DEACTIVATE_PUSH_MS - 1);
  assert.equal(done, false);
  await h.clock.advance(1);
  await closing;
  assert.equal(done, true);
  assert.equal(DEACTIVATE_PUSH_MS, 3000);

  const failing = harness({ interval: 0 });
  failing.outcome(async () => { throw new Error('boom https://alice:pw@host.example/x.git'); });
  await failing.scheduler.flushOnClose();
  const off = harness({ interval: 0 });
  off.scheduler.setEnabled(false);
  await off.scheduler.flushOnClose();
  assert.equal(off.calls.length, 0, 'with sync off nothing is tried');
  const running = harness({ interval: 0 });
  running.runs(1);
  await running.scheduler.flushOnClose();
  assert.equal(running.calls.length, 0, 'and not while a run is in flight');
});

test('the status says what happened in one plain sentence, never a URL with credentials or a secret, and a missing remote or a sign-in is its own state', async () => {
  const h = harness({ interval: 0 });
  h.outcome(async () => ({ kind: 'refused', message: 'The copy online could not be opened. Nothing was changed. https://alice:s3cr3t-pw@git.example.test/a.git' }));
  await h.scheduler.syncNow();
  const refused = h.scheduler.status();
  assert.equal(refused.state, 'attention');
  assert.ok(!/alice|s3cr3t/.test(refused.message ?? ''), 'no credentials in the status');
  assert.match(refused.message ?? '', /could not be opened/);

  h.outcome(async () => ({ kind: 'failed', message: 'Git asked for a sign-in this editor cannot show.', failure: { kind: 'auth', message: 'x' } }));
  await h.scheduler.syncNow();
  assert.deepEqual(h.scheduler.status(), { state: 'attention', message: 'Sync needs you to sign in. Choose Sync Project Now.' });

  h.outcome(async () => ({ kind: 'failed', message: 'This project has no online home yet.', failure: { kind: 'no-remote', message: 'This project has no online home yet.' } }));
  await h.scheduler.syncNow();
  assert.deepEqual(h.scheduler.status(), { state: 'no-home', message: 'This project has no online home yet.' });

  h.outcome(async () => ({ kind: 'synced', message: 'ok', pushed: false }));
  await h.scheduler.syncNow();
  assert.equal(h.scheduler.status().state, 'synced');
  h.scheduler.setEnabled(false);
  assert.deepEqual(h.scheduler.status(), { state: 'off' });
});

test('turning sync off cancels what was planned, and a syncing status is replaced by the outcome of a sync run outside the scheduler', async () => {
  const h = harness({ interval: 10 });
  h.scheduler.runEnded();
  h.scheduler.setEnabled(false);
  await h.clock.advance(30 * MINUTES);
  assert.equal(h.calls.length, 0);
  h.scheduler.setEnabled(true);
  assert.equal(h.scheduler.status().state, 'syncing');
  h.scheduler.recordOutcome({ kind: 'synced', message: 'ok', pushed: true });
  assert.equal(h.scheduler.status().state, 'synced');
});

// ---- the GitHub sign-in for syncs -------------------------------------------------------------------------------------------------------

test('tokenRunner signs git in for the mirror\'s calls only when a token exists, through the environment, and looks the token up only for those calls', async () => {
  const seen: Array<{ args: string[]; env: Record<string, string> | undefined }> = [];
  const base: GitRunner = async (args, options) => { seen.push({ args, env: options?.env }); return { code: 0, stdout: Buffer.alloc(0), stderr: '' }; };
  let lookups = 0;
  const signedIn = tokenRunner(base, async () => { lookups += 1; return 'gho_TOKEN-SENTINEL-77'; });
  await signedIn(['-C', '/project', 'remote']);
  assert.equal(lookups, 0, 'reading the project\'s remotes needs no token');
  await signedIn(['--git-dir', '/mirror', 'fetch', 'state']);
  assert.equal(lookups, 1);
  const last = seen.at(-1);
  assert.equal(last?.env?.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
  assert.ok(!last?.args.some((argument) => argument.includes('TOKEN-SENTINEL')), 'the token is in no argument');
  const silent = tokenRunner(base, async () => undefined);
  await silent(['--git-dir', '/mirror', 'push']);
  assert.equal(seen.at(-1)?.env, undefined, 'without a session nothing is added and nothing is asked');
});

// ---- runs in flight, and the rest of turning on after an online home -------------------------------------------------------------------

test('runStarted and runEnded keep the count of runs in flight per project, and a listener sees the project as idle when the last run ends', async () => {
  const root = path.join('/project', 'counted');
  assert.equal(runsInFlight(root), 0);
  runStarted(root);
  runStarted(root);
  runStarted(path.join('/project', 'other'));
  assert.equal(runsInFlight(root), 2);
  const seen: number[] = [];
  const listener = onRunEnded(() => { seen.push(runsInFlight(root)); });
  await runEnded({ root, conversationId: 'conv-count-one', runId: 'run-1', outcome: 'done' });
  await runEnded({ root, conversationId: 'conv-count-two', runId: 'run-2', outcome: 'done' });
  await runEnded({ root, conversationId: 'conv-count-two', runId: 'run-3', outcome: 'done' });
  listener.dispose();
  await runEnded({ root: path.join('/project', 'other'), conversationId: 'conv-count-one', runId: 'run-4', outcome: 'done' });
  assert.deepEqual(seen, [1, 0, 0], 'the count has already dropped when a listener hears of it, and never goes below zero');
  assert.equal(runsInFlight(root), 0);
});

test('afterRemoteFor finishes turning sync on for the online-home flow and says whether the first sync finished', async () => {
  const remote = bareRemote({ withMain: false });
  const c = computer(remote, 'alpha');
  await thread(c, 'conv-after-one', 'After one');
  const fake = fakeUi();
  const finished = await afterRemoteFor(c.env, fake.ui)({ name: 'origin', url: remote, git: c.parts.git as GitRunner });
  assert.equal(finished, true);
  assert.equal(fake.shown.length, 1);
  assert.equal(remoteTip(remote).length, 40);
  const other = bareRemote({ withMain: false });
  const declined = computer(other, 'bravo');
  const no = await afterRemoteFor(declined.env, fakeUi({ confirm: false }).ui)({ name: 'origin', url: other, git: declined.parts.git as GitRunner });
  assert.equal(no, false, 'a declined screen is not a finished turn-on');
});

// ---- plan 27-24: "No online home" from panel open, from a local check only (G-27-4b) -----------------------------------------------------

test('the home check is local: no repository or no remote is no-home, a remote is home, and it only lists remotes and writes nothing', async () => {
  const seen: string[][] = [];
  const spy: GitRunner = (args, options) => { seen.push(args); return hermeticRunner()(args, options); };

  const plainFolder = mkdtempSync(path.join(tmpdir(), 'near-ai-nogit-'));
  assert.equal(await localHomeState(plainFolder, spy), 'no-home', 'a folder that is not a repository has no online home');
  assert.deepEqual(readdirSync(plainFolder), [], 'nothing was written: no .git, no state home');

  const noRemote = folderWithoutRemote();
  const before = readdirSync(noRemote).sort();
  assert.equal(await localHomeState(noRemote, spy), 'no-home', 'a repository with no remote has no online home');
  assert.deepEqual(readdirSync(noRemote).sort(), before, 'and the folder is unchanged');

  const remote = bareRemote();
  fixtureGit(noRemote, ['remote', 'add', 'origin', remote]);
  assert.equal(await localHomeState(noRemote, spy), 'home', 'after a remote is added there is a home');

  for (const args of seen) {
    const verb = args.filter((arg) => !arg.startsWith('-') && !arg.startsWith('/'))[0];
    assert.equal(verb, 'remote', `only the local remote listing ran, not: ${args.join(' ')}`);
    assert.ok(!args.some((arg) => ['fetch', 'ls-remote', 'push', 'clone', 'pull'].includes(arg)));
  }
  assert.equal(seen.length, 3);
});

test('the home check says unknown, and changes nothing, when git is not installed', async () => {
  const missing: GitRunner = async () => { const { GitNotFoundError } = await import('../services/stateGit'); throw new GitNotFoundError(); };
  assert.equal(await localHomeState('/anywhere', missing), 'unknown');
  const timedOut: GitRunner = async () => ({ code: 124, stdout: Buffer.alloc(0), stderr: '' });
  assert.equal(await localHomeState('/anywhere', timedOut), 'unknown', 'a check that did not finish is not an answer');
});

test('with sync off, the control moves between off and no-home as a remote appears or goes, and says nothing when the answer is the same', () => {
  const scheduler = new SyncScheduler({ runsInFlight: () => 0, intervalMinutes: () => 10, runSync: async () => OK });
  const seen: string[] = [];
  scheduler.onStatus((status) => seen.push(status.state));
  scheduler.setHomeKnown(false);
  assert.deepEqual(scheduler.status(), { state: 'no-home', message: 'This project has no online home yet.' });
  scheduler.setHomeKnown(false);
  assert.deepEqual(seen, ['no-home'], 'the same answer publishes nothing new');
  scheduler.setHomeKnown(true);
  assert.deepEqual(scheduler.status(), { state: 'off' });
  scheduler.setHomeKnown(true);
  assert.deepEqual(seen, ['no-home', 'off']);
});

test('while sync is on, the home check never overrides the scheduler\'s state', async () => {
  const h = harness({ interval: 0 });
  await h.scheduler.syncNow();
  assert.equal(h.scheduler.status().state, 'synced');
  h.scheduler.setHomeKnown(false);
  h.scheduler.setHomeKnown(true);
  assert.equal(h.scheduler.status().state, 'synced');
  h.scheduler.setNoHome();
  h.scheduler.setHomeKnown(true);
  assert.equal(h.scheduler.status().state, 'no-home', 'with sync on, only the scheduler\'s own outcomes move the state');
});

test('the no-home status gives the control "No online home · Set up" with the set-up action and no invitation', () => {
  const scheduler = new SyncScheduler({ runsInFlight: () => 0, intervalMinutes: () => 10, runSync: async () => OK });
  scheduler.setHomeKnown(false);
  const message = syncPanelMessage(scheduler.status(), undefined, Date.UTC(2026, 0, 2, 12, 0));
  assert.equal(message.model.state, 'no-home');
  assert.equal(message.model.label, 'No online home · Set up');
  assert.equal(message.model.action, 'set-up-home');
  assert.equal(message.prompt, false);
});

test('the check runs at activation, after the online-home, turn-on and turn-off commands, and when the panel opens and its view reloads', () => {
  const src = path.join(__dirname, '..', '..', 'src', 'services');
  const commands = readFileSync(path.join(src, 'syncCommands.ts'), 'utf8');
  const chat = readFileSync(path.join(src, 'chat.ts'), 'utf8');
  assert.match(commands, /export (?:async )?function refreshSyncHome/);
  const activation = commands.slice(commands.indexOf('readSyncSettings(runtime.env.home)'));
  assert.match(activation, /refreshSyncHome/, 'at activation, after the sync setting is read');
  for (const name of ['nearAi.sync.turnOn', 'nearAi.sync.turnOff', 'nearAi.sync.onlineHome']) {
    const start = commands.indexOf(`'${name}'`);
    const ends = ['registerCommand', 'onDidChangeConfiguration'].map((marker) => commands.indexOf(marker, start + 10)).filter((at) => at > 0);
    const block = commands.slice(start, Math.min(...ends));
    assert.match(block, /refreshSyncHome/, `after ${name}`);
  }
  assert.match(chat, /chat-ready'\) \{[^\n]*refreshSyncHome/, 'on chat-ready');
  assert.match(chat, /refreshSyncHome\(/, 'and on panel set-up');
});
