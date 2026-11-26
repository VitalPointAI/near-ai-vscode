// Phase 33 plan 30 (D-24, D-35, D-60, D-65; criteria 1 to 3): two people in two real browsers, each in their own Sterling workbench, sharing one
// staff project through your organization's server. The container suite (test/container/staff-live-e2e.test.ts) starts the world and runs this file
// once; the tests are serial and build on each other, as two people's afternoon would:
//
//   tracer       A shares the staff work, connects the server and invites B; B opens the invitation file and sends the join request; A compares
//                the six words and admits; B opens the welcome; A types "Intelligence estimate" and B's editor shows it within 3 seconds
//   cursors      B's selection shows in A's editor with B's name in the hover and the label
//   own undo     A types, B types, A presses Ctrl+Z: A's text goes and B's stays, in both browsers
//   status       both status bars read Synced; with the server stopped both read Offline and the Staff Room shows the offline banner; started
//                again, both read Synced
//   invitation   an invitation with a sign-in older than the step-up window asks for confirmation and completes after a fresh sign-in (D-60).
//   blocking     decision step-up, competing offline decisions and settlement, and a dialog that became stale (D-24, D-60).
//   blocking     nothing secret on the wire: no recorded WebSocket frame or HTTP body in either browser holds a key, a token, a signature or the
//                text of a part the viewer is not cleared for (a marker planted in a product only A may read; D-35)
//
// Every browser request carries the sign-in headers oauth2-proxy would forward, fetched from the suite's token desk, so a sign-in can be made fresh
// or old at the moment a step needs it. Fictional people and exercise data only.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

const A_URL = process.env.STAFF_A_URL ?? '';
const B_URL = process.env.STAFF_B_URL ?? '';
const DESK = process.env.STAFF_TOKEN_DESK ?? '';
const HUB_FILE = process.env.STAFF_HUB_FILE ?? '';
const PRODUCT_PATH = process.env.STAFF_PRODUCT_PATH ?? '';
const SECRET_PATH = process.env.STAFF_SECRET_PATH ?? '';
const MARKER = process.env.STAFF_MARKER ?? '';
const DOWNLOADS = process.env.STAFF_DOWNLOADS ?? '';
const SECRETS: string[] = JSON.parse(process.env.STAFF_SECRETS ?? '[]') as string[];
/** The longest a co-edit may take to reach the other browser (criterion 1). */
const CO_EDIT_MS = 3000;

test.describe.configure({ mode: 'serial' });

interface Side {
  readonly who: 'a' | 'b';
  readonly context: BrowserContext;
  readonly page: Page;
  /** Every WebSocket frame and HTTP body this browser saw, both ways. */
  readonly wire: string[];
}

let a: Side;
let b: Side;

async function signIn(who: 'a' | 'b', age = 0): Promise<Record<string, string>> {
  const response = await fetch(`${DESK}/token?person=${who}&age=${age}`);
  expect(response.ok, 'the fixture issued a sign-in').toBe(true);
  const headers = await response.json() as Record<string, string>;
  const token = headers['X-Forwarded-Access-Token'];
  expect(typeof token === 'string' && token.length > 0, 'the fixture issued an access token').toBe(true);
  SECRETS.push(token);
  return headers;
}

async function desk(action: 'hub-stop' | 'hub-start'): Promise<void> {
  const response = await fetch(`${DESK}/${action}`, { method: 'POST' });
  expect(response.status).toBe(204);
}

interface DecisionState {
  hash: string;
  number: number;
  state: string;
  status: string;
  effective: string[];
  contested: string[];
  decisions: Array<{ hash: string; person: 'a' | 'b' | null; outcome: string; seen: string[] }>;
}
interface FixtureState { ready: boolean; versions: DecisionState[] }

async function fixture(side: Side, command: string): Promise<FixtureState> {
  const response = await fetch(`${DESK}/decision/${side.who}/${command}`, { method: 'POST', signal: AbortSignal.timeout(30_000) });
  const value = await response.json().catch(() => ({})) as FixtureState & { error?: string };
  expect(response.status, `the ${side.who} fixture answered ${command}: ${value.error ?? ''}`).toBe(200);
  return value;
}

async function version(side: Side, number: number, state: string, count: number, status?: string): Promise<DecisionState> {
  const read = async () => (await fixture(side, 'state')).versions.find((entry) => entry.number === number);
  await expect.poll(async () => {
    const entry = await read();
    return entry === undefined ? undefined : [entry.state, entry.decisions.length, ...(status === undefined ? [] : [entry.status])];
  }, { timeout: 60_000, message: `${side.who} folds v${number} with ${count} decisions` }).toEqual([
    state, count, ...(status === undefined ? [] : [status]),
  ]);
  return (await read()) as DecisionState;
}

async function staffRoom(side: Side): Promise<Locator> {
  const room = side.page.locator('.sterling-staff-room');
  if (!await room.isVisible()) await runCommand(side.page, 'Staff Room');
  await expect(room).toBeVisible();
  return room;
}

async function submitVersion(number: number): Promise<void> {
  const room = await staffRoom(a);
  await room.getByLabel(new RegExp(`^Decision role for v${number} of `)).selectOption('commander');
  await room.getByRole('button', { name: new RegExp(`^Submit v${number} of `) }).click();
  for (const side of [a, b]) await version(side, number, 'awaiting-decision', 0);
}

async function openDecision(side: Side, number: number): Promise<Locator> {
  const room = await staffRoom(side);
  await room.getByRole('button', { name: new RegExp(`^Decide v${number} of `) }).click();
  const dialog = room.getByRole('dialog', { name: new RegExp(`^v${number} of `) });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function decide(dialog: Locator, outcome: 'Approve' | 'Reject', reasons: string): Promise<void> {
  await dialog.getByLabel('Your reasons').fill(reasons);
  await dialog.getByRole('button', { name: outcome, exact: true }).click();
}

async function editForVersion(number: number): Promise<void> {
  const marker = `Planning revision ${number} adds more transport.`;
  await typeAtEnd(a, await openProduct(a), `\n${marker}`);
  const peer = await openProduct(b);
  await expect.poll(() => editorText(peer), { timeout: 30_000 }).toContain(marker);
}

async function forwardSignIn(side: Side, age = 0): Promise<void> {
  await side.context.setExtraHTTPHeaders(await signIn(side.who, age));
  // A same-origin HTTP request updates the forwarded sign-in kept by this backend without losing its open workspace.
  await side.page.evaluate(async () => { await fetch('/', { cache: 'no-store' }); });
}

/** Records what crosses the wire in this browser: WebSocket frames both ways, request bodies and text response bodies. */
function record(context: BrowserContext, page: Page, wire: string[]): void {
  page.on('websocket', (socket) => {
    socket.on('framesent', (frame) => { wire.push(String(frame.payload)); });
    socket.on('framereceived', (frame) => { wire.push(String(frame.payload)); });
  });
  context.on('request', (request) => { const body = request.postData(); if (body) wire.push(body); });
  context.on('response', (response) => {
    const type = response.headers()['content-type'] ?? '';
    if (!/json|text|javascript/.test(type)) return;
    void response.text().then((text) => { wire.push(text); }, () => undefined);
  });
}

async function openSide(browser: Browser, who: 'a' | 'b', url: string): Promise<Side> {
  const context = await browser.newContext({ baseURL: url, extraHTTPHeaders: await signIn(who), acceptDownloads: true, viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const wire: string[] = [];
  record(context, page, wire);
  await page.goto('/');
  await expect(page.locator('.lm-TabBar-tab', { hasText: 'Get Started' }).first()).toBeVisible({ timeout: 120_000 });
  const trust = page.getByRole('button', { name: 'Yes, I trust the authors' });
  await trust.waitFor({ timeout: 15_000 }).then(() => trust.click(), () => undefined);
  return { who, context, page, wire };
}

/** The Planning work-area page, where Share with people is. */
async function sharePage(side: Side): Promise<Locator> {
  const { page } = side;
  const section = page.locator('section.sterling-share');
  if (!(await section.isVisible())) {
    await page.locator('.lm-TabBar-tab', { hasText: 'Get Started' }).first().click();
    await page.locator('button.sterling-destination[data-work-area="operations"]').first().click();
  }
  await expect(section).toBeVisible({ timeout: 60_000 });
  return section;
}

/** Clicks a Share with people button whose action opens a file chooser, and gives it the file. */
async function chooseFile(side: Side, button: Locator, name: string, text: string): Promise<void> {
  const file = path.join(DOWNLOADS, side.who, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  const [chooser] = await Promise.all([side.page.waitForEvent('filechooser'), button.click()]);
  await chooser.setFiles(file);
}

/** Clicks a button whose action makes a file the browser downloads, and returns the file's text. */
async function download(side: Side, button: Locator): Promise<{ name: string; text: string }> {
  const [saved] = await Promise.all([side.page.waitForEvent('download'), button.click()]);
  const file = path.join(DOWNLOADS, side.who, saved.suggestedFilename());
  await saved.saveAs(file);
  const { readFileSync } = await import('node:fs');
  return { name: saved.suggestedFilename(), text: readFileSync(file, 'utf8') };
}

async function runCommand(page: Page, label: string): Promise<void> {
  await page.keyboard.press('F1');
  const input = page.locator('.quick-input-widget input');
  await expect(input).toBeVisible();
  await input.fill(`>${label}`);
  await page.locator('.quick-input-list .monaco-list-row', { hasText: label }).first().click();
}

/** Opens a product in this browser's editor (quick open by file name) and gives back the visible Monaco editor. */
async function openProduct(side: Side, file = PRODUCT_PATH): Promise<Locator> {
  const { page } = side;
  const name = path.basename(file);
  const tab = page.locator('.lm-TabBar-tab', { hasText: name });
  if (await tab.count() > 0) {
    await tab.first().click();
  } else {
    // A joiner's file appears once the shared work's first exchange has brought it: quick open is asked again until it lists the file.
    const deadline = Date.now() + 180_000;
    for (;;) {
      await page.keyboard.press('Control+P');
      const input = page.locator('.quick-input-widget input');
      await expect(input).toBeVisible();
      await input.fill(name);
      const row = page.locator('.quick-input-list .monaco-list-row', { hasText: name }).first();
      if (await row.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
        await row.click();
        break;
      }
      await page.keyboard.press('Escape');
      if (Date.now() > deadline) throw new Error(`${side.who}'s workspace never listed ${file}`);
    }
  }
  const editor = page.locator('.theia-editor:visible .monaco-editor').first();
  await expect(editor).toBeVisible({ timeout: 30_000 });
  return editor;
}

/** The text of the open editor, line by line, as Monaco renders it. */
async function editorText(editor: Locator): Promise<string> {
  return (await editor.locator('.view-lines').innerText()).replace(/ /g, ' ');
}

/** Puts the caret at the end of the editor's text and types. */
async function typeAtEnd(side: Side, editor: Locator, text: string): Promise<void> {
  await editor.locator('.view-lines').click();
  await side.page.keyboard.press('Control+End');
  await side.page.keyboard.type(text, { delay: 20 });
}

const statusEntry = (side: Side): Locator => side.page.locator('#status-bar-sterling\\.staffSync');

test.beforeAll(async ({ browser }) => {
  a = await openSide(browser, 'a', A_URL);
  b = await openSide(browser, 'b', B_URL);
});

test.afterAll(async () => {
  await a?.context.close();
  await b?.context.close();
});

test('tracer: A shares and invites, B joins through the page, A admits, and a word A types appears in B\'s editor within 3 seconds', async () => {
  test.setTimeout(600_000);
  // A shares the staff work, declaring Confidential (A's staff work holds a Confidential product B is never cleared for).
  let share = await sharePage(a);
  await share.locator('article', { hasText: 'Share this work' }).locator('select').selectOption('Confidential');
  await share.getByRole('button', { name: 'Share this work' }).click();
  await expect(share.getByRole('heading', { name: 'People' })).toBeVisible({ timeout: 120_000 });
  // Your organization's server, from the operator's hub file.
  await chooseFile(a, share.getByRole('button', { name: 'Connect your organization\'s server' }), 'hub.json', HUB_FILE);
  await expect(share.getByText(/This computer reaches it at/)).toBeVisible({ timeout: 120_000 });
  // The invitation.
  const invite = share.locator('article', { hasText: 'Invite a person' });
  await invite.getByLabel('Name').fill('Blake Rivers');
  await invite.getByLabel('Position').fill('j2-analyst');
  await invite.getByLabel('Clearance you declare for them').selectOption('Internal');
  const invitation = await download(a, invite.getByRole('button', { name: 'Invite a person' }));
  expect(invitation.name).toMatch(/\.near-staff-invite$/);

  // B opens the invitation through the page and sends the join request.
  const joinSide = await sharePage(b);
  await chooseFile(b, joinSide.getByRole('button', { name: 'Open an invitation' }), invitation.name, invitation.text);
  await joinSide.getByLabel('Your name, as the lead knows you').fill('Blake Rivers');
  await joinSide.getByRole('button', { name: 'Send my join request' }).click();
  const joinStatus = joinSide.locator('.sterling-share-status');
  await expect(joinStatus).toContainText('Six words:', { timeout: 120_000 });
  const theirWords = (await joinStatus.textContent() ?? '').match(/Six words: ((?:\S+ ?){6})/)?.[1]?.trim();
  expect(theirWords?.split(' ')).toHaveLength(6);

  // A compares the six words and admits; the welcome file goes back to B.
  share = await sharePage(a);
  await share.getByRole('button', { name: 'Check join requests' }).click();
  const request = share.locator('.sterling-share-request', { hasText: 'Blake Rivers' });
  await expect(request.locator('.sterling-share-words')).toContainText(theirWords as string, { timeout: 60_000 });
  await request.getByLabel('The six words match').check();
  const welcome = await download(a, request.getByRole('button', { name: 'Admit' }));
  expect(welcome.name).toMatch(/\.near-staff-welcome$/);
  await chooseFile(b, joinSide.getByRole('button', { name: 'Open a welcome file' }), welcome.name, welcome.text);
  await expect(joinSide.getByRole('heading', { name: 'People' })).toBeVisible({ timeout: 120_000 });

  // Both open the product; A types; B sees it.
  const left = await openProduct(a);
  const right = await openProduct(b);
  await expect.poll(() => editorText(right), { timeout: 60_000 }).toContain('The enemy holds the river crossings.');
  await typeAtEnd(a, left, '\nIntelligence estimate');
  const typed = Date.now();
  await expect.poll(() => editorText(right), { timeout: CO_EDIT_MS, intervals: [100] }).toContain('Intelligence estimate');
  expect(Date.now() - typed).toBeLessThanOrEqual(CO_EDIT_MS);
});

test('cursors: B\'s cursor shows in A\'s editor with B\'s name', async () => {
  const left = await openProduct(a);
  const right = await openProduct(b);
  // The previous test typed in A's editor, which can leave completion open over the hover target.
  await a.page.keyboard.press('Escape');
  // B selects a word of the shared text (a double click); A sees the selection, the caret and the label, and the hover names B.
  await right.locator('.view-line', { hasText: 'The enemy holds the river crossings.' }).first()
    .dblclick({ position: { x: 40, y: 5 }, timeout: 15_000 });
  await expect(left.locator('.sterling-cursor-caret')).toHaveCount(1, { timeout: 15_000 });
  await expect(left.locator('.sterling-cursor-label').first()).toContainText('Blake Rivers');
  // Monaco paints the selection on a backdrop. Its hover handler listens to the text at the same coordinates.
  const selection = left.locator('.sterling-cursor-selection').first();
  await expect(selection).toBeVisible({ timeout: 15_000 });
  const bounds = await selection.boundingBox({ timeout: 15_000 });
  if (bounds === null) throw new Error('Blake’s selection has no visible bounds');
  await a.page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect(a.page.locator('.monaco-hover').first()).toContainText('Blake Rivers', { timeout: 15_000 });
});

test('own undo: A types, B types, A presses Ctrl+Z; A\'s text goes and B\'s stays, in both browsers', async () => {
  const left = await openProduct(a);
  const right = await openProduct(b);
  await typeAtEnd(a, left, '\nFrom A: bridges held.');
  await expect.poll(() => editorText(right), { timeout: 15_000 }).toContain('From A: bridges held.');
  await typeAtEnd(b, right, '\nFrom B: fuel at dawn.');
  await expect.poll(() => editorText(left), { timeout: 15_000 }).toContain('From B: fuel at dawn.');
  await left.locator('.view-lines').click();
  await a.page.keyboard.press('Control+Z');
  for (const editor of [left, right]) {
    await expect.poll(() => editorText(editor), { timeout: 15_000 }).not.toContain('From A: bridges held.');
    expect(await editorText(editor)).toContain('From B: fuel at dawn.');
  }
});

test('status: both read Synced; the server stopped turns both Offline with the banner; started again, both read Synced', async () => {
  test.setTimeout(300_000);
  for (const side of [a, b]) await expect(statusEntry(side)).toContainText('Synced', { timeout: 60_000 });
  await desk('hub-stop');
  for (const side of [a, b]) await expect(statusEntry(side)).toContainText('Offline', { timeout: 120_000 });
  await runCommand(a.page, 'Staff Room');
  await expect(a.page.locator('.sterling-staff-room-banner')).toContainText('You are offline.', { timeout: 30_000 });
  await desk('hub-start');
  for (const side of [a, b]) await expect(statusEntry(side)).toContainText('Synced', { timeout: 180_000 });
});

test('invitation step-up: an old sign-in asks for the passkey or security key, and a fresh one creates the invitation', async () => {
  test.setTimeout(300_000);
  // A sign-in older than the step-up window: the next page load carries it.
  await a.context.setExtraHTTPHeaders(await signIn('a', 3600));
  await a.page.reload();
  await expect(a.page.locator('.lm-TabBar-tab', { hasText: 'Get Started' }).first()).toBeVisible({ timeout: 120_000 });
  let share = await sharePage(a);
  let invite = share.locator('article', { hasText: 'Invite a person' });
  await invite.getByLabel('Name').fill('Casey Moss');
  await invite.getByLabel('Position').fill('j4-planner');
  await invite.getByRole('button', { name: 'Invite a person' }).click();
  await expect(share.locator('.sterling-share-status')).toContainText('Confirm with your passkey or security key', { timeout: 60_000 });
  // The passkey confirmation: a fresh sign-in, then the same change again.
  await a.context.setExtraHTTPHeaders(await signIn('a'));
  await a.page.reload();
  await expect(a.page.locator('.lm-TabBar-tab', { hasText: 'Get Started' }).first()).toBeVisible({ timeout: 120_000 });
  share = await sharePage(a);
  invite = share.locator('article', { hasText: 'Invite a person' });
  await invite.getByLabel('Name').fill('Casey Moss');
  await invite.getByLabel('Position').fill('j4-planner');
  const made = await download(a, invite.getByRole('button', { name: 'Invite a person' }));
  expect(made.name).toMatch(/\.near-staff-invite$/);
});

test('blocking: contested decisions', async () => {
  test.setTimeout(360_000);
  await Promise.all([forwardSignIn(a), forwardSignIn(b)]);
  await fixture(a, 'roster');
  for (const side of [a, b]) await expect.poll(async () => (await fixture(side, 'state')).ready, { timeout: 60_000 }).toBe(true);
  await fixture(a, 'clear-1');
  await submitVersion(1);
  try {
    await fixture(a, 'isolate');
    await expect(statusEntry(a)).toContainText('Offline', { timeout: 90_000 });
    await expect(statusEntry(b)).toContainText('Synced');
    await decide(await openDecision(a, 1), 'Approve', 'The bridges are secured.');
    await decide(await openDecision(b, 1), 'Reject', 'The transport reserve is missing.');
    const left = await version(a, 1, 'approved', 1);
    const right = await version(b, 1, 'rejected', 1);
    expect(left.hash).toBe(right.hash);
    expect(left.decisions[0]).toMatchObject({ person: 'a', outcome: 'approve', seen: [] });
    expect(right.decisions[0]).toMatchObject({ person: 'b', outcome: 'reject', seen: [] });
  } finally {
    await fixture(a, 'reconnect');
  }
  for (const side of [a, b]) await expect(statusEntry(side)).toContainText('Synced', { timeout: 120_000 });
  const card = (side: Side) => side.page.locator('.sterling-staff-room-card-contested');
  for (const side of [a, b]) {
    await staffRoom(side);
    await expect(card(side)).toContainText('Avery');
    await expect(card(side)).toContainText('Blake Rivers');
    await expect(card(side)).toContainText('The bridges are secured.');
    await expect(card(side)).toContainText('The transport reserve is missing.');
  }
  const contested = await version(a, 1, 'awaiting-decision', 2, 'contested');
  expect(contested.contested).toHaveLength(2);
  expect(contested.contested.toSorted()).toEqual(contested.decisions.map((item) => item.hash).toSorted());
  await forwardSignIn(a);
  await card(a).getByRole('button', { name: /^Approve v1/ }).click();
  await decide((await staffRoom(a)).getByRole('dialog'), 'Approve', 'The transport reserve is now assigned.');
  const settled = await version(a, 1, 'approved', 3, 'effective');
  const final = settled.decisions.find((item) => settled.effective.includes(item.hash));
  expect(final?.person).toBe('a');
  expect(final?.seen.toSorted()).toEqual(contested.contested.toSorted());
  expect(await version(b, 1, 'approved', 3, 'effective')).toEqual(settled);
  for (const side of [a, b]) await expect(card(side)).toHaveCount(0);
  console.info(`decision evidence: contested v1 ${settled.hash} settled two person decisions ${final?.seen.join(', ')}`);
});

test('blocking: changed while deciding', async () => {
  test.setTimeout(300_000);
  await forwardSignIn(a);
  await editForVersion(2);
  await fixture(a, 'prepare-2');
  await submitVersion(2);
  await openDecision(b, 2);
  await editForVersion(3);
  await fixture(a, 'propose-3');
  const newest = await version(a, 3, 'draft', 0);
  await decide(await openDecision(a, 2), 'Approve', 'The alternate route is ready.');
  const approved = await version(b, 2, 'approved', 1, 'effective');
  expect(approved.decisions[0]).toMatchObject({ person: 'a', outcome: 'approve' });
  const stale = (await staffRoom(b)).getByRole('dialog', { name: /^v2 of / });
  await decide(stale, 'Reject', 'The route could be unavailable.');
  await expect(b.page.getByText('Someone else decided this version while you were deciding. Look again.', { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await expect(stale).toHaveCount(0);
  for (const side of [a, b]) {
    expect(await version(side, 2, 'approved', 1, 'effective')).toEqual(approved);
    expect(await version(side, 3, 'draft', 0)).toEqual(newest);
  }
  console.info(`decision evidence: stale v2 ${approved.hash} added zero decisions and v3 ${newest.hash} remained draft`);
});

test('blocking: decision step-up', async () => {
  test.setTimeout(300_000);
  await forwardSignIn(a);
  await editForVersion(4);
  await fixture(a, 'prepare-4');
  await submitVersion(4);
  await forwardSignIn(a, 3600);
  await decide(await openDecision(a, 4), 'Approve', 'The full plan is ready.');
  const confirm = a.page.getByRole('button', { name: 'Confirm with your passkey or security key', exact: true }).filter({ visible: true }).first();
  await expect(confirm).toBeVisible();
  const awaiting = await version(a, 4, 'awaiting-decision', 0);
  expect(await version(b, 4, 'awaiting-decision', 0)).toEqual(awaiting);
  const current = new URL(a.page.url());
  // Finish the identity provider's landing request before changing Chromium's forwarded headers for the return.
  await a.context.route((url) => url.pathname === '/oauth2/start',
    (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: 'Fixture passkey confirmation' }), { times: 1 });
  await Promise.all([
    a.page.waitForURL((url) => url.pathname === '/oauth2/start', { waitUntil: 'load', timeout: 30_000 }),
    confirm.click({ timeout: 15_000 }),
  ]);
  const confirmation = new URL(a.page.url());
  const originalPath = current.pathname + current.search;
  expect(confirmation.origin).toBe(current.origin);
  expect(confirmation.searchParams.get('max_age')).toBe('0');
  expect(confirmation.searchParams.get('acr_values')).toBe(process.env.STAFF_STEPUP_ACR);
  expect(confirmation.searchParams.get('rd')).toBe(originalPath);

  await a.context.setExtraHTTPHeaders(await signIn('a'));
  await a.page.goto(new URL(originalPath, current.origin).href);
  const returned = new URL(a.page.url());
  expect(returned.origin).toBe(current.origin);
  expect(returned.pathname + returned.search).toBe(originalPath);
  await expect(statusEntry(a)).toContainText('Synced', { timeout: 120_000 });
  const retained = (await staffRoom(a)).getByRole('dialog', { name: /^v4 of / });
  await expect(retained).toBeVisible();
  await decide(retained, 'Approve', 'The full plan is ready.');
  const saved = await version(a, 4, 'approved', 1, 'effective');
  expect(saved.hash).toBe(awaiting.hash);
  expect(saved.decisions[0]).toMatchObject({ person: 'a', outcome: 'approve', seen: [] });
  expect(await version(b, 4, 'approved', 1, 'effective')).toEqual(saved);
  console.info(`decision evidence: step-up v4 ${saved.hash} saved one person decision after zero on refusal`);
});

test('blocking: nothing secret on the wire: no key, token or signature in either browser, and B never receives the text of A\'s Confidential product', async () => {
  // A, who is cleared, opens the Confidential product; B looks for it and finds nothing.
  const secret = await openProduct(a, SECRET_PATH);
  await expect.poll(() => editorText(secret), { timeout: 30_000 }).toContain(MARKER);
  await b.page.keyboard.press('Control+P');
  await b.page.locator('.quick-input-widget input').fill(path.basename(SECRET_PATH));
  await b.page.waitForTimeout(3000);
  await expect(b.page.locator('.quick-input-list .monaco-list-row', { hasText: path.basename(SECRET_PATH) })).toHaveCount(0);
  await b.page.keyboard.press('Escape');
  // Give in-flight responses a moment to finish recording.
  await a.page.waitForTimeout(2000);
  expect(MARKER.length).toBeGreaterThan(8);
  expect(a.wire.some((item) => item.includes(MARKER)), 'A, who is cleared, did read the planted product').toBe(true);
  expect(b.wire.some((item) => item.includes(MARKER)), 'B never receives the Confidential product\'s text').toBe(false);
  for (const side of [a, b]) {
    for (const secret of SECRETS) {
      expect(side.wire.some((item) => item.includes(secret)), `${side.who}'s browser never receives a key, a token or a signature`).toBe(false);
    }
  }
});
