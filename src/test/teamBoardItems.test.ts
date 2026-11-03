// Board-created items (Phase 62 plan 13, D-14): a developer adds a chore through the page protocol and the real host, the item reaches the remote as one
// signed item.created that already carries the estimate, and every teammate sees it with its creator. Real clones and real git throughout.
import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { importPlans } from '../team/importPlans';
import { DEFAULT_COORDINATION_REF } from '../team/gitTransport';
import { openLog, remoteEventCount, rootOf, storageOf } from './helpers/teamFlowRig';
import type { Participant, Rig } from './helpers/teamFlowRig';
import { LiveTimers, until, withLiveTeam } from './helpers/teamLiveRig';
import { scanGitObjects } from './helpers/teamCanary';
import { gitIn } from './helpers/teamHarness';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';
import type { RecordedWebview, RecordedWebviewPanel } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const sessionModule = require('../services/team/teamSession') as typeof import('../services/team/teamSession');
const barModule = require('../services/team/teamStatusBar') as typeof import('../services/team/teamStatusBar');
const boardModule = require('../services/team/boardView') as typeof import('../services/team/boardView');
test.after(() => { uninstall(); });

const { TeamSession, projectAuditSink } = sessionModule;
const { createTeamStatusBar } = barModule;
const { registerTeamBoard } = boardModule;
type Session = Awaited<ReturnType<typeof TeamSession.start>>;

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');
const ITEM_ID = /^item:[0-9A-HJKMNP-TV-Z]{26}$/;

interface Started { session: Session; lines: string[]; timers: LiveTimers }

async function startSession(rig: Rig, who: 'owner' | Participant): Promise<Started> {
  const v = stub.vscode as {
    window: {
      showInformationMessage(message: string, ...actions: string[]): PromiseLike<string | undefined>;
      showWarningMessage(message: string, ...actions: string[]): PromiseLike<string | undefined>;
    };
  };
  const person = who === 'owner' ? undefined : who;
  const timers = new LiveTimers();
  const lines: string[] = [];
  const root = rootOf(rig, person === undefined ? 'a' : person.clone);
  assert.ok(rig.teamFile !== undefined);
  const session = await TeamSession.start({
    projectRoot: root, globalStorageDir: person === undefined ? rig.owner.globalStorageDir : person.globalStorageDir, teamFile: rig.teamFile,
    secrets: person === undefined ? rig.owner.secrets : person.secrets,
    output: { appendLine: (line) => { lines.push(line); }, show: () => undefined },
    statusBar: createTeamStatusBar(), audit: projectAuditSink(root),
    notify: { info: (message, ...actions) => v.window.showInformationMessage(message, ...actions), warn: (message, ...actions) => v.window.showWarningMessage(message, ...actions) },
    pollSeconds: () => 15, focused: () => true, timers, nearBaseUrl: rig.fake.baseUrl, autoImport: false
  });
  await until(() => timers.live.length === 1, 'the first poll to be armed');
  return { session, lines, timers };
}

function resetStub(): void {
  stub.webviewPanels.length = 0;
  stub.viewProviders.length = 0;
  stub.notifications.length = 0;
  stub.inputAnswers.length = 0;
  stub.inputRequests.length = 0;
  stub.messageAnswers.length = 0;
  stub.setMessageResponder(undefined);
  stub.commands.clear();
}

interface BoardCtx { rig: Rig; started: Started; panel: RecordedWebviewPanel; ui: LiveTimers; board: ReturnType<typeof registerTeamBoard> }

// One computer's board, after its page said ready. `close` stops the board and the session.
async function openBoardFor(rig: Rig, who: 'owner' | 'dev' | 'lead', session?: (real: Session) => Session): Promise<BoardCtx & { close(): void }> {
  const started = await startSession(rig, who === 'owner' ? 'owner' : who === 'dev' ? rig.dev : rig.lead);
  const ui = new LiveTimers();
  const context = createFakeContext(path.join(EXTENSION_ROOT, 'does-not-exist'), {});
  const shown = session === undefined ? started.session : session(started.session);
  const board = registerTeamBoard(context as never, { session: () => shown, output: { appendLine: (line) => { started.lines.push(line); }, show: () => undefined }, timers: ui });
  board.openPanel();
  const panel = stub.webviewPanels[stub.webviewPanels.length - 1];
  assert.ok(panel !== undefined, 'a panel was created');
  await panel.receive({ type: 'ready' });
  return { rig, started, panel, ui, board, close: () => { board.controller.dispose(); started.session.dispose(); } };
}

// A freshly opened board of one computer. `before` runs on the rig before the session starts (a role change, say).
async function withBoard(
  who: 'owner' | 'dev' | 'lead', run: (ctx: BoardCtx) => Promise<void>, options: { before?: (rig: Rig) => Promise<void>; planning?: boolean; session?: (real: Session) => Session } = {}
): Promise<void> {
  resetStub();
  await withLiveTeam(async (rig) => {
    if (options.before !== undefined) await options.before(rig);
    const open = await openBoardFor(rig, who, options.session);
    try {
      await run(open);
    } finally {
      open.close();
    }
  }, { planning: options.planning === true });
}

const lastOf = (record: RecordedWebview, type: string): Record<string, unknown> | undefined =>
  [...record.posted].reverse().find((message): message is Record<string, unknown> => (message as { type?: string }).type === type);

const eventFiles = (rig: Rig): string[] => gitIn(rig.fixture.remote, ['ls-tree', '-r', '--name-only', DEFAULT_COORDINATION_REF]).split('\n').filter((line) => line.startsWith('events/'));

interface RemoteEvent { type: string; author: string; body: Record<string, unknown> }
const eventAt = (rig: Rig, file: string): RemoteEvent => JSON.parse(gitIn(rig.fixture.remote, ['show', `${DEFAULT_COORDINATION_REF}:${file}`])) as RemoteEvent;
const newEvents = (rig: Rig, before: string[]): RemoteEvent[] => eventFiles(rig).filter((file) => !before.includes(file)).sort().map((file) => eventAt(rig, file));

const DRAFT = { kind: 'chore', title: 'Tidy settings page', description: 'Group the team settings.', scope: ['src/services/settings/**'], estimate: 48000 };

test('IN-01: a title, description and file line typed with bidi or zero-width characters are written without them', async () => {
  await withBoard('dev', async ({ rig, panel }) => {
    const before = eventFiles(rig);
    await panel.receive({ type: 'new-item', draft: { kind: 'bug', title: 'Fix \u202Egnp.exe\u202C upload\u200B', description: 'Steps\u2066 one\u2069\ntwo\u200F', scope: ['src/\u200Bapp/**'] } });
    const body = (newEvents(rig, before)[0] as RemoteEvent).body;
    assert.equal(body['title'], 'Fix gnp.exe upload');
    assert.equal(body['description'], 'Steps one\ntwo');
    assert.deepEqual(body['scope'], ['src/app/**']);
  });
});

test('tracer: a developer adds a chore through the page and the host, the remote gains one item.created with the estimate, and the owner sees the developer as its creator', async () => {
  await withBoard('dev', async ({ rig, started, panel, ui }) => {
    const before = eventFiles(rig);
    await panel.receive({ type: 'new-item', draft: DRAFT });

    const written = newEvents(rig, before);
    assert.equal(written.length, 1, 'one event, one commit');
    const event = written[0] as RemoteEvent;
    assert.equal(event.type, 'item.created');
    assert.equal(event.author, rig.dev.memberId);
    const id = event.body['id'];
    assert.equal(typeof id === 'string' && ITEM_ID.test(id), true, 'a board item id');
    assert.deepEqual(event.body, {
      id, kind: 'chore', title: 'Tidy settings page', description: 'Group the team settings.', scope: ['src/services/settings/**'],
      requirements: [], mustHaves: [], estimate: { tokens: 48000 }
    });

    assert.deepEqual(lastOf(panel, 'saved'), { type: 'saved', itemId: id });
    assert.equal(lastOf(panel, 'refused'), undefined);
    // The state that follows shows the card, ready (it has files and an estimate), and mine.
    const savedAt = panel.posted.findIndex((message) => (message as { type?: string }).type === 'saved');
    const after = panel.posted.slice(savedAt).find((message) => (message as { type?: string }).type === 'state') as { model: { cards: Array<{ id: string; column: string; mine: boolean }> } } | undefined;
    const card = after?.model.cards.find((candidate) => candidate.id === id);
    assert.equal(card?.column, 'ready');
    assert.equal(card?.mine, true);
    assert.equal(started.session.state().items.get(id as string)?.createdBy, rig.dev.memberId);
    assert.equal(ui.live.length <= 1, true);

    const owner = await openLog(rig, 'owner');
    const item = owner.log.state().items.get(id as string);
    assert.equal(item?.origin, 'board');
    assert.equal(item?.createdBy, rig.dev.memberId);
    assert.equal(item?.title, 'Tidy settings page');
  });
});

test('an item with only a title is written without a description or an estimate and waits in the backlog', async () => {
  await withBoard('dev', async ({ rig, panel }) => {
    const before = eventFiles(rig);
    await panel.receive({ type: 'new-item', draft: { kind: 'bug', title: '  Crash on save  ', description: '', scope: [' ', 'src/a/**  '] } });
    const written = newEvents(rig, before);
    assert.equal(written.length, 1);
    const body = (written[0] as RemoteEvent).body;
    assert.deepEqual(body, { id: body['id'], kind: 'bug', title: 'Crash on save', scope: ['src/a/**'], requirements: [], mustHaves: [] });
  });
});

// ---- editing, permissions and refusals ---------------------------------------------------------------------------------------------------------

const refusedReason = (panel: RecordedWebview): string | undefined => (lastOf(panel, 'refused') as { reason?: string } | undefined)?.reason;
// UI-SPEC: plain language, no em-dashes or en-dashes in anything the board says.
const plain = (text: string | undefined): string => {
  assert.equal(typeof text, 'string');
  assert.equal(/[\u2013\u2014]/.test(text as string), false, 'no em-dash or en-dash');
  return text as string;
};
const commitCount = (rig: Rig): number => Number(gitIn(rig.fixture.remote, ['rev-list', '--count', DEFAULT_COORDINATION_REF]));

const ADD_DENIED = 'Only the owner, leads and developers can add items. Nothing was saved.';
const EDIT_OWN = 'You can edit only the items you added. Nothing was saved.';
const IMPORTED = 'Items from the project plans change only when the plans change. Nothing was saved.';
const SECRET = 'This text looks like a password or key, so it was not saved. Remove it and try again.';
const SCOPE_TEXT = 'One of these lines is not a folder or file name in this project. Remove it and try again. Nothing was saved.';
const ESTIMATE_TEXT = 'Enter a whole number of tokens, 1 or more. Nothing was saved.';

async function addAs(ctx: BoardCtx, draft: Record<string, unknown> = DRAFT): Promise<string> {
  await ctx.panel.receive({ type: 'new-item', draft });
  const saved = lastOf(ctx.panel, 'saved');
  assert.equal(typeof saved?.['itemId'], 'string', 'the item was saved');
  return saved?.['itemId'] as string;
}

test('a developer edits their own chore: one commit holds item.updated for the text and item.estimated for the size, and the owner sees both', async () => {
  await withBoard('dev', async (ctx) => {
    const id = await addAs(ctx, { kind: 'chore', title: 'Tidy settings page', scope: [] });
    const before = eventFiles(ctx.rig);
    const commits = commitCount(ctx.rig);
    await ctx.panel.receive({ type: 'edit-item', itemId: id, changes: { title: 'Tidy the settings page', scope: ['src/services/settings/**', 'media/settings/*.css'], estimate: 52000 } });

    assert.deepEqual(lastOf(ctx.panel, 'saved'), { type: 'saved', itemId: id });
    assert.equal(commitCount(ctx.rig), commits + 1, 'one commit for both intents');
    const written = newEvents(ctx.rig, before);
    assert.deepEqual(written.map((event) => event.type), ['item.updated', 'item.estimated']);
    assert.deepEqual(written[0]?.body, { id, changes: { title: 'Tidy the settings page', scope: ['src/services/settings/**', 'media/settings/*.css'] } });
    assert.deepEqual(written[1]?.body, { id, estimate: { tokens: 52000 } });

    const owner = await openLog(ctx.rig, 'owner');
    const item = owner.log.state().items.get(id);
    assert.equal(item?.title, 'Tidy the settings page');
    assert.deepEqual(item?.scope, ['src/services/settings/**', 'media/settings/*.css']);
    assert.deepEqual(item?.estimate, { tokens: 52000 });
  });
});

test('an estimate alone writes only item.estimated, and a text change alone writes only item.updated', async () => {
  await withBoard('dev', async (ctx) => {
    const id = await addAs(ctx);
    let before = eventFiles(ctx.rig);
    await ctx.panel.receive({ type: 'edit-item', itemId: id, changes: { estimate: 60000 } });
    assert.deepEqual(newEvents(ctx.rig, before).map((event) => event.type), ['item.estimated']);
    before = eventFiles(ctx.rig);
    await ctx.panel.receive({ type: 'edit-item', itemId: id, changes: { description: 'Group the team settings by topic.' } });
    const written = newEvents(ctx.rig, before);
    assert.deepEqual(written.map((event) => event.type), ['item.updated']);
    assert.deepEqual(written[0]?.body, { id, changes: { description: 'Group the team settings by topic.' } });
  });
});

test('a developer cannot edit another member\'s chore, the owner can edit the developer\'s, and nothing is appended on a refusal', async () => {
  resetStub();
  await withLiveTeam(async (rig) => {
    const dev = await openBoardFor(rig, 'dev');
    let id: string;
    try {
      id = await addAs(dev);
    } finally {
      dev.close();
    }
    // A chore the owner made: the developer did not add it.
    const owner = await openBoardFor(rig, 'owner');
    let ownersId: string;
    try {
      ownersId = await addAs(owner, { kind: 'bug', title: 'Owner bug', scope: ['src/a/**'] });
      const before = eventFiles(rig);
      await owner.panel.receive({ type: 'edit-item', itemId: id, changes: { title: 'Owner renamed it' } });
      assert.deepEqual(lastOf(owner.panel, 'saved'), { type: 'saved', itemId: id }, 'the owner may edit any board item');
      assert.deepEqual(newEvents(rig, before).map((event) => event.type), ['item.updated']);
    } finally {
      owner.close();
    }

    const again = await openBoardFor(rig, 'dev');
    try {
      const before = remoteEventCount(rig);
      await again.panel.receive({ type: 'edit-item', itemId: ownersId, changes: { title: 'Dana renamed it' } });
      assert.equal(plain(refusedReason(again.panel)), EDIT_OWN);
      assert.deepEqual(lastOf(again.panel, 'refused'), { type: 'refused', itemId: ownersId, reason: EDIT_OWN });
      await again.panel.receive({ type: 'edit-item', itemId: ownersId, changes: { estimate: 1000 } });
      assert.equal(refusedReason(again.panel), EDIT_OWN);
      assert.equal(remoteEventCount(rig), before, 'nothing was appended');
      // Their own item that the owner renamed is still theirs and unclaimed, so they may edit it.
      await again.panel.receive({ type: 'edit-item', itemId: id, changes: { title: 'Dana renamed her own' } });
      assert.deepEqual(lastOf(again.panel, 'saved'), { type: 'saved', itemId: id });
    } finally {
      again.close();
    }
  }, { planning: false });
});

test('an imported plan is never editable on the board, whoever asks', async () => {
  resetStub();
  await withLiveTeam(async (rig) => {
    const owner = await openLog(rig, 'owner');
    const imported = await importPlans({ log: owner.log, source: { projectRoot: rootOf(rig, 'a'), remote: 'origin', branch: 'main' }, storageDir: storageOf(rig, 'owner'), mode: 'command' });
    assert.equal(imported.ok, true);
    for (const who of ['owner', 'dev'] as const) {
      const ctx = await openBoardFor(rig, who);
      try {
        const before = remoteEventCount(rig);
        await ctx.panel.receive({ type: 'edit-item', itemId: 'plan:90-02', changes: { title: 'Renamed' } });
        assert.equal(plain(refusedReason(ctx.panel)), IMPORTED, who);
        await ctx.panel.receive({ type: 'edit-item', itemId: 'plan:90-02', changes: { estimate: 5000 } });
        assert.equal(refusedReason(ctx.panel), IMPORTED, who);
        assert.equal(remoteEventCount(rig), before);
      } finally {
        ctx.close();
      }
    }
  });
});

test('an observer cannot add an item and a window that cannot write says why; neither writes anything', async () => {
  const demote = async (rig: Rig): Promise<void> => {
    const owner = await openLog(rig, 'owner');
    const result = await owner.log.append(() => [{ type: 'member.role-changed', body: { memberId: rig.dev.memberId as string, role: 'observer' } }]);
    assert.equal(result.ok, true);
  };
  await withBoard('dev', async (ctx) => {
    const before = remoteEventCount(ctx.rig);
    await ctx.panel.receive({ type: 'new-item', draft: DRAFT });
    assert.equal(plain(refusedReason(ctx.panel)), ADD_DENIED);
    assert.equal(lastOf(ctx.panel, 'saved'), undefined);
    assert.equal(remoteEventCount(ctx.rig), before);
  }, { before: demote });

  const noWrite = (real: Session): Session => Object.create(real, { canWrite: { value: (): boolean => false } }) as Session;
  await withBoard('dev', async (ctx) => {
    const before = remoteEventCount(ctx.rig);
    await ctx.panel.receive({ type: 'new-item', draft: DRAFT });
    const reason = plain(refusedReason(ctx.panel));
    assert.equal(reason.length > 0, true);
    assert.equal(lastOf(ctx.panel, 'saved'), undefined);
    await ctx.panel.receive({ type: 'edit-item', itemId: 'item:01HZX3Q7VY8M2K4N6P9R0S1T2W', changes: { title: 'x' } });
    assert.equal(refusedReason(ctx.panel), reason);
    assert.equal(remoteEventCount(ctx.rig), before);
  }, { session: noWrite });
});

test('text that looks like a key is refused in the title, the description and a file line, and no trace of it reaches the remote', async () => {
  const key = `sk-${randomBytes(12).toString('hex')}`;
  assert.equal(key.length, 27);
  await withBoard('dev', async (ctx) => {
    const id = await addAs(ctx);
    const before = remoteEventCount(ctx.rig);
    const drafts: Array<Record<string, unknown>> = [
      { kind: 'chore', title: `Use ${key} here`, scope: [] }, { kind: 'chore', title: 'Fine', description: `Token ${key}`, scope: [] }, { kind: 'chore', title: 'Fine', scope: [`src/${key}/**`] }
    ];
    for (const draft of drafts) {
      await ctx.panel.receive({ type: 'new-item', draft });
      assert.equal(plain(refusedReason(ctx.panel)), SECRET);
    }
    for (const changes of [{ title: `Use ${key}` }, { description: `Token ${key}` }, { scope: [`src/${key}`] }]) {
      await ctx.panel.receive({ type: 'edit-item', itemId: id, changes });
      assert.equal(refusedReason(ctx.panel), SECRET);
    }
    assert.equal(remoteEventCount(ctx.rig), before, 'nothing was appended');
    assert.deepEqual(await scanGitObjects(ctx.rig.fixture.remote, [{ label: 'key', value: key }, { label: 'control', value: 'Tidy settings page' }]), ['control'], 'the remote holds a saved title (the scan can see text) and no trace of the key');
    assert.equal(ctx.started.lines.some((line) => line.includes(key)), false, 'the output channel never carries the text');
  });
});

test('malformed files and sizes are refused with the form\'s own sentences and write nothing', async () => {
  await withBoard('dev', async (ctx) => {
    const id = await addAs(ctx);
    const before = remoteEventCount(ctx.rig);
    for (const line of ['/etc/passwd', 'src\\services', '../x', 'src/../x', 'a'.repeat(1) + '\u0007']) {
      await ctx.panel.receive({ type: 'new-item', draft: { kind: 'chore', title: 'Fine', scope: [line] } });
      assert.equal(plain(refusedReason(ctx.panel)), SCOPE_TEXT, line);
      await ctx.panel.receive({ type: 'edit-item', itemId: id, changes: { scope: [line] } });
      assert.equal(refusedReason(ctx.panel), SCOPE_TEXT, line);
    }
    for (const estimate of [0, 1.5, -1000, 1e12 + 1]) {
      await ctx.panel.receive({ type: 'new-item', draft: { kind: 'chore', title: 'Fine', scope: [], estimate } });
      assert.equal(plain(refusedReason(ctx.panel)), ESTIMATE_TEXT, String(estimate));
      assert.deepEqual(lastOf(ctx.panel, 'refused'), { type: 'refused', itemId: '', reason: ESTIMATE_TEXT });
      await ctx.panel.receive({ type: 'edit-item', itemId: id, changes: { estimate } });
      assert.deepEqual(lastOf(ctx.panel, 'refused'), { type: 'refused', itemId: id, reason: ESTIMATE_TEXT });
    }
    await ctx.panel.receive({ type: 'new-item', draft: { kind: 'chore', title: '   ', scope: [] } });
    assert.equal(plain(refusedReason(ctx.panel)), 'Enter a title. Nothing was saved.');
    assert.equal(remoteEventCount(ctx.rig), before, 'nothing was appended');
  });
});

test('a title typed with line breaks is stored as one line, and a description keeps its line feeds', async () => {
  await withBoard('dev', async (ctx) => {
    const before = eventFiles(ctx.rig);
    await ctx.panel.receive({ type: 'new-item', draft: { kind: 'spike', title: 'Look into\n  caching', description: 'One\r\nTwo', scope: [] } });
    const body = (newEvents(ctx.rig, before)[0] as RemoteEvent).body;
    assert.equal(body['title'], 'Look into caching');
    assert.equal(body['description'], 'One\nTwo');
    assert.equal(body['kind'], 'spike');
  });
});

test('a hostile edit is judged on the log, not on the page: an item that is not on the board is refused in plain words', async () => {
  await withBoard('dev', async (ctx) => {
    const before = remoteEventCount(ctx.rig);
    await ctx.panel.receive({ type: 'edit-item', itemId: 'item:01HZX3Q7VY8M2K4N6P9R0S1T2W', changes: { title: 'x' } });
    assert.equal(plain(refusedReason(ctx.panel)), 'This item is no longer on the board. Nothing was saved.');
    assert.equal(remoteEventCount(ctx.rig), before);
  });
});
