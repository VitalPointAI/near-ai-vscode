import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { editUnsupported, imageTool, ImageDraft, ImageReviewDecision, ImageReviewer } from '../agent/extraTools';
import { cleanOldDrafts, DRAFT_MAX_AGE_MS, draftFile, draftsFolder } from '../agent/imageDrafts';
import { DEFAULT_RULES } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { AgentConversation, GsdContext } from '../services/agentSession';
import { parseChatWebviewMessage } from '../services/chatBridge';
import { ConversationLog, loggable, promptIdOf } from '../services/conversations';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';
import { chatPage, StubNode } from './helpers/chatPage';

// 0.4.23 (owner): the person sees each image the agent makes, can ask for changes, and only an accepted image reaches its path. In a real run an
// agent made the same image 11 times over hours, scoring each with its own scripts and writing every attempt into the report's image folder.

const usage = { verificationStatus: 'unknown' as const, latencyMs: 1 };
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const FLUX = { id: 'black-forest-labs/FLUX.2-klein-4B', imagePricePerUnit: 0.012, outputModalities: ['image'] };

/** A reviewer whose decisions the test gives, one per draft, in order; it records every draft it was shown. */
function scriptedReviewer(root: string, decisions: ImageReviewDecision[]): ImageReviewer & { shown: ImageDraft[] } {
  const shown: ImageDraft[] = [];
  return { root, drafts: new Map(), attempts: new Map(), shown, async review(draft) { shown.push(draft); return decisions.shift() ?? { decision: 'cancelled' }; } };
}

function imageClient(options: { editError?: Error } = {}) {
  const calls: Array<{ kind: 'generate' | 'edit'; model: string; prompt: string; source?: number[] }> = [];
  let next = 10;
  return {
    calls,
    async generateImage(model: string, prompt: string) { calls.push({ kind: 'generate' as const, model, prompt }); next += 1; return { bytes: new Uint8Array([next, next, next]), remoteUrlPresent: false }; },
    async editImage(model: string, prompt: string, image: Uint8Array) {
      calls.push({ kind: 'edit' as const, model, prompt, source: [...image] });
      if (options.editError) throw options.editError;
      next += 1;
      return { bytes: new Uint8Array([next, next]), remoteUrlPresent: false };
    }
  };
}

async function withContext<T>(root: string, work: (context: Parameters<ReturnType<typeof imageTool>['run']>[1], checkpoints: RunCheckpoints) => Promise<T>): Promise<T> {
  const checkpoints = new RunCheckpoints('img-review');
  const shell = new ShellSession(root);
  try { return await work({ root, signal: new AbortController().signal, checkpoints, shell, readFiles: new Set() }, checkpoints); } finally { shell.dispose(); }
}

test('in ask mode the image goes to the drafts folder, never to path, and Accept moves it there through a checkpoint', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-image-review-'));
  const client = imageClient();
  const reviewer = scriptedReviewer(root, [{ decision: 'accept' }]);
  const tool = imageTool(client as never, FLUX as never, [], reviewer);
  assert.match(tool.description, /The user reviews every image you make/);
  assert.match(tool.description, /Do not measure, score or check the image yourself, and do not generate it again unless the user asked for changes/);
  assert.ok((tool.parameters as { properties: Record<string, unknown> }).properties.edit_of, 'edit_of is offered in ask mode');
  const input = tool.parse({ prompt: 'a lighthouse at dusk', path: 'report/img/hero.png' });
  const preview = await tool.preview!(input, {} as never);
  assert.match(preview.kind === 'note' ? preview.text : '', /show it to you to review before it is saved to report\/img\/hero\.png/);
  await withContext(root, async (context, checkpoints) => {
    // The reviewer sees the draft while nothing is at the path yet.
    const original = reviewer.review.bind(reviewer);
    reviewer.review = async (draft, signal) => {
      assert.equal(existsSync(path.join(root, 'report', 'img', 'hero.png')), false, 'nothing is written to path before the person accepts');
      assert.equal(draft.file, draftFile(root, draft.id));
      assert.deepEqual([...await readFile(draft.file)], [11, 11, 11]);
      assert.equal(await readFile(path.join(root, '.near-ai', 'drafts', '.gitignore'), 'utf8'), '*\n', 'the drafts folder keeps itself out of git');
      return original(draft, signal);
    };
    const result = await tool.run(input, context);
    assert.equal(result, `Accepted by the user and saved to report/img/hero.png (0 KB, ${FLUX.id}).`);
    assert.deepEqual([...await readFile(path.join(root, 'report', 'img', 'hero.png'))], [11, 11, 11]);
    assert.deepEqual(await readdir(draftsFolder(root)), [], 'the draft was moved, not copied');
    assert.deepEqual(reviewer.shown.map((draft) => [draft.path, draft.model, draft.prompt, draft.attempt]), [['report/img/hero.png', FLUX.id, 'a lighthouse at dusk', 1]]);
    await checkpoints.revert();
    assert.equal(existsSync(path.join(root, 'report', 'img', 'hero.png')), false, 'Revert removes the accepted image');
  });
});

test('Request changes returns the person\'s words with the draft id and keeps the draft; Discard deletes it; attempts count per path', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-image-changes-'));
  const client = imageClient();
  const reviewer = scriptedReviewer(root, [{ decision: 'changes', feedback: 'Make the sky orange.' }, { decision: 'discard' }, { decision: 'changes', feedback: 'Smaller.' }]);
  const tool = imageTool(client as never, FLUX as never, [], reviewer);
  await withContext(root, async (context) => {
    const first = await tool.run(tool.parse({ prompt: 'a lighthouse', path: 'hero.png' }), context);
    const id = reviewer.shown[0].id;
    assert.match(first, new RegExp(`^The user asked for changes to draft ${id} \\(attempt 1 at hero\\.png\\): Make the sky orange\\.\\nDraft ${id} is kept; call GenerateImage again with edit_of: "${id}", path: "hero\\.png"`));
    assert.ok(existsSync(draftFile(root, id)), 'the draft stays for the next attempt');
    assert.equal(existsSync(path.join(root, 'hero.png')), false);
    const second = await tool.run(tool.parse({ prompt: 'a lighthouse, orange sky', path: 'hero.png' }), context);
    const discarded = reviewer.shown[1].id;
    assert.match(second, new RegExp(`^The user discarded draft ${discarded}; nothing was saved to hero\\.png\\.`));
    assert.equal(existsSync(draftFile(root, discarded)), false, 'a discarded draft is deleted');
    assert.equal(reviewer.drafts.has(discarded), false);
    await tool.run(tool.parse({ prompt: 'an icon', path: 'icon.png' }), context);
    assert.deepEqual(reviewer.shown.map((draft) => [draft.path, draft.attempt]), [['hero.png', 1], ['hero.png', 2], ['icon.png', 1]], 'attempt numbers increase per target path');
  });
});

test('edit_of edits the draft when the model lists image-edit, and makes a new image when it does not', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-image-edit-'));
  const editing = { ...FLUX, providerOperations: ['image-generation', 'image-edit'] };
  const client = imageClient();
  const reviewer = scriptedReviewer(root, [{ decision: 'changes', feedback: 'warmer' }, { decision: 'accept' }]);
  const tool = imageTool(client as never, editing as never, [], reviewer);
  await withContext(root, async (context) => {
    await tool.run(tool.parse({ prompt: 'a lighthouse', path: 'hero.png' }), context);
    const id = reviewer.shown[0].id;
    const preview = await tool.preview!(tool.parse({ prompt: 'warmer', path: 'hero.png', edit_of: id }), {} as never);
    assert.match(preview.kind === 'note' ? preview.text : '', new RegExp(`^Edit draft ${id} with`));
    const result = await tool.run(tool.parse({ prompt: 'the lighthouse, warmer light', path: 'hero.png', edit_of: id }), context);
    assert.deepEqual(client.calls.map((entry) => entry.kind), ['generate', 'edit']);
    assert.deepEqual(client.calls[1].source, [11, 11, 11], 'the previous draft is the source of the edit');
    assert.equal(reviewer.shown[1].editOf, id);
    assert.equal(reviewer.shown[1].attempt, 2);
    assert.match(result, /^Accepted by the user and saved to hero\.png/);
    assert.deepEqual([...await readFile(path.join(root, 'hero.png'))], [12, 12], 'the edited image is what was saved');
  });
  // A model that lists its operations without image-edit is not sent to the edit endpoint.
  const plain = imageClient();
  const reviewer2 = scriptedReviewer(root, [{ decision: 'changes', feedback: 'again' }, { decision: 'discard' }]);
  const generateOnly = imageTool(plain as never, { ...FLUX, providerOperations: ['image-generation'] } as never, [], reviewer2);
  await withContext(root, async (context) => {
    await generateOnly.run(generateOnly.parse({ prompt: 'x', path: 'a.png' }), context);
    await generateOnly.run(generateOnly.parse({ prompt: 'y', path: 'a.png', edit_of: reviewer2.shown[0].id }), context);
    assert.deepEqual(plain.calls.map((entry) => entry.kind), ['generate', 'generate']);
    assert.match(reviewer2.shown[1].note ?? '', /does not edit images, so this is a new image made from the prompt/);
    assert.equal(reviewer2.shown[1].editOf, undefined);
  });
});

test('edit_of on a model with no listed operations tries the edit endpoint and falls back on a clear unsupported error only', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-image-fallback-'));
  const unsupported = Object.assign(new Error('NEAR AI request failed with HTTP 404 for flux: image edits are not supported for this model.'), { status: 404 });
  const client = imageClient({ editError: unsupported });
  const reviewer = scriptedReviewer(root, [{ decision: 'changes', feedback: 'brighter' }, { decision: 'accept' }]);
  const tool = imageTool(client as never, FLUX as never, [], reviewer);
  await withContext(root, async (context) => {
    await tool.run(tool.parse({ prompt: 'a lighthouse', path: 'hero.png' }), context);
    const result = await tool.run(tool.parse({ prompt: 'brighter', path: 'hero.png', edit_of: reviewer.shown[0].id }), context);
    assert.deepEqual(client.calls.map((entry) => entry.kind), ['generate', 'edit', 'generate']);
    assert.match(reviewer.shown[1].note ?? '', /cannot edit images, so this is a new image made from the prompt/);
    assert.match(result, /cannot edit images/);
  });
  // Any other failure is the call's failure, not a reason to pay for a different image.
  const failing = imageClient({ editError: Object.assign(new Error('NEAR AI request failed with HTTP 500.'), { status: 500 }) });
  const reviewer2 = scriptedReviewer(root, [{ decision: 'changes', feedback: 'again' }]);
  const tool2 = imageTool(failing as never, FLUX as never, [], reviewer2);
  await withContext(root, async (context) => {
    await tool2.run(tool2.parse({ prompt: 'x', path: 'b.png' }), context);
    await assert.rejects(tool2.run(tool2.parse({ prompt: 'y', path: 'b.png', edit_of: reviewer2.shown[0].id }), context), /HTTP 500/);
    assert.deepEqual(failing.calls.map((entry) => entry.kind), ['generate', 'edit']);
  });
  assert.equal(editUnsupported(Object.assign(new Error('Model does not support image edits'), { status: 400 })), true);
  assert.equal(editUnsupported(Object.assign(new Error('prompt too long'), { status: 400 })), false);
  assert.equal(editUnsupported(Object.assign(new Error('x'), { status: 501 })), true);
  // Second review of PR 51: a bare 404 is a genuine failure (an unknown model, say), not a reason to pay for a different image; only one whose text says
  // editing is unsupported falls back.
  assert.equal(editUnsupported(Object.assign(new Error('NEAR AI request failed with HTTP 404 for flux.'), { status: 404 })), false);
  assert.equal(editUnsupported(Object.assign(new Error('NEAR AI request failed with HTTP 404: model not found.'), { status: 404 })), false);
  assert.equal(editUnsupported(Object.assign(new Error('NEAR AI request failed with HTTP 404.'), { status: 404, errorCode: 'not_implemented' })), true);
  const missing = imageClient({ editError: Object.assign(new Error('NEAR AI request failed with HTTP 404 for flux: model not found.'), { status: 404 }) });
  const reviewer3 = scriptedReviewer(root, [{ decision: 'changes', feedback: 'again' }]);
  const tool3 = imageTool(missing as never, FLUX as never, [], reviewer3);
  await withContext(root, async (context) => {
    await tool3.run(tool3.parse({ prompt: 'x', path: 'd.png' }), context);
    await assert.rejects(tool3.run(tool3.parse({ prompt: 'y', path: 'd.png', edit_of: reviewer3.shown[0].id }), context), /HTTP 404/);
    assert.deepEqual(missing.calls.map((entry) => entry.kind), ['generate', 'edit'], 'no second image is paid for after a plain 404');
  });
  // A draft that is not this conversation's is refused before anything is paid for.
  await withContext(root, async (context) => {
    await assert.rejects(tool.run(tool.parse({ prompt: 'z', path: 'c.png', edit_of: 'img-000000000000' }), context), /not a draft kept in this conversation/);
  });
  assert.throws(() => tool.parse({ prompt: 'z', path: 'c.png', edit_of: '../../etc/passwd' }), /edit_of must be a draft id/);
});

// Agent review of PR 51: a draft kept after "Request changes" waited for the 7-day sweep even once a new attempt replaced it.
test('a new attempt that succeeds deletes the drafts it replaces; a failed one keeps them; another path\'s draft and an open card are left alone', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-image-supersede-'));
  const editing = { ...FLUX, providerOperations: ['image-generation', 'image-edit'] };
  const failing = Object.assign(new Error('NEAR AI request failed with HTTP 500.'), { status: 500 });
  let failEdit = false;
  const client = imageClient();
  const flaky = { ...client, async editImage(...args: Parameters<typeof client.editImage>) { if (failEdit) throw failing; return client.editImage(...args); } };
  const reviewer = scriptedReviewer(root, [
    { decision: 'changes', feedback: 'warmer' }, { decision: 'changes', feedback: 'keep' }, { decision: 'changes', feedback: 'warmer still' }, { decision: 'changes', feedback: 'again' }, { decision: 'accept' }
  ]);
  const tool = imageTool(flaky as never, editing as never, [], reviewer);
  await withContext(root, async (context) => {
    await tool.run(tool.parse({ prompt: 'a lighthouse', path: 'hero.png' }), context);
    const first = reviewer.shown[0].id;
    await tool.run(tool.parse({ prompt: 'an icon', path: 'icon.png' }), context);
    const icon = reviewer.shown[1].id;
    // A failed edit keeps the draft it would have replaced.
    failEdit = true;
    await assert.rejects(tool.run(tool.parse({ prompt: 'warmer', path: 'hero.png', edit_of: first }), context), /HTTP 500/);
    assert.ok(existsSync(draftFile(root, first)), 'the draft stays when the edit fails');
    assert.ok(reviewer.drafts.has(first));
    // A successful edit deletes it.
    failEdit = false;
    await tool.run(tool.parse({ prompt: 'warmer', path: 'hero.png', edit_of: first }), context);
    const second = reviewer.shown[2].id;
    assert.equal(existsSync(draftFile(root, first)), false, 'the edited draft is deleted once the edit exists');
    assert.equal(reviewer.drafts.has(first), false);
    assert.ok(existsSync(draftFile(root, second)), 'the new draft, kept after Request changes, stays');
    assert.ok(existsSync(draftFile(root, icon)), 'a draft for another path is left alone');
    // A new attempt at the same path without edit_of replaces it too.
    await tool.run(tool.parse({ prompt: 'a lighthouse at dusk', path: 'hero.png' }), context);
    const third = reviewer.shown[3].id;
    assert.equal(existsSync(draftFile(root, second)), false, 'a new attempt at the same path deletes the kept draft');
    assert.ok(existsSync(draftFile(root, third)));
    // Accepting the next edit moves it to its path and leaves no draft of hero.png behind.
    await tool.run(tool.parse({ prompt: 'dusk, warmer', path: 'hero.png', edit_of: third }), context);
    assert.deepEqual([...reviewer.drafts.keys()], [icon]);
    assert.ok(existsSync(path.join(root, 'hero.png')));
  });
  // A draft whose card is still open (another agent's attempt at the same path) is not deleted under it.
  const root2 = await mkdtemp(path.join(tmpdir(), 'near-ai-image-supersede-open-'));
  let release: (decision: ImageReviewDecision) => void = () => undefined;
  const shown: ImageDraft[] = [];
  const parallel: ImageReviewer = { root: root2, drafts: new Map(), attempts: new Map(), review: (draft) => { shown.push(draft); return shown.length === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({ decision: 'changes', feedback: 'x' }); } };
  const tool2 = imageTool(imageClient() as never, FLUX as never, [], parallel);
  await withContext(root2, async (context) => {
    const waiting = tool2.run(tool2.parse({ prompt: 'a', path: 'hero.png' }), context);
    await until(() => shown[0]);
    await tool2.run(tool2.parse({ prompt: 'b', path: 'hero.png' }), context);
    assert.ok(existsSync(draftFile(root2, shown[0].id)), 'the draft under review is kept');
    release({ decision: 'accept' });
    assert.match(await waiting, /^Accepted by the user and saved to hero\.png/);
  });
});

test('with image review off the image is written straight to path, as before', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-image-off-'));
  const client = imageClient();
  const tool = imageTool(client as never, FLUX as never);
  assert.doesNotMatch(tool.description, /reviews every image/);
  assert.equal((tool.parameters as { properties: Record<string, unknown> }).properties.edit_of, undefined);
  await withContext(root, async (context) => {
    assert.match(await tool.run(tool.parse({ prompt: 'x', path: 'out/a.png' }), context), /^Saved out\/a\.png/);
  });
  assert.deepEqual([...await readFile(path.join(root, 'out', 'a.png'))], [11, 11, 11]);
  assert.equal(existsSync(path.join(root, '.near-ai')), false, 'no drafts folder is made');
});

test('cleaning removes only drafts older than seven days, and only files named like a draft', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-image-clean-'));
  const folder = draftsFolder(root);
  await mkdir(path.join(folder, 'img-aaaaaaaaaaaa.png-dir'), { recursive: true });
  const now = Date.now();
  const old = new Date(now - DRAFT_MAX_AGE_MS - 60_000);
  for (const name of ['img-aaaaaaaaaaaa.png', 'img-bbbbbbbbbbbb.png', 'notes.txt', 'img-cccccccccccc.jpg']) await writeFile(path.join(folder, name), 'x');
  for (const name of ['img-aaaaaaaaaaaa.png', 'notes.txt', 'img-cccccccccccc.jpg']) await utimes(path.join(folder, name), old, old);
  assert.equal(await cleanOldDrafts(root, DRAFT_MAX_AGE_MS, now), 1);
  assert.deepEqual((await readdir(folder)).sort(), ['img-aaaaaaaaaaaa.png-dir', 'img-bbbbbbbbbbbb.png', 'img-cccccccccccc.jpg', 'notes.txt']);
  assert.equal(await cleanOldDrafts(await mkdtemp(path.join(tmpdir(), 'near-ai-image-clean-none-'))), 0, 'no drafts folder is not an error');
});

async function until<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out');
}

/** A conversation whose model asks for one image (or has `subAgent` make it), then answers with what the tool returned. */
function imageConversation(root: string, options: { subAgent?: boolean; imageReview?: 'ask' | 'off' } = {}) {
  const results: string[] = [];
  const near = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const sub = String(messages[0]?.content ?? '').startsWith('You are the designer.');
      const last = messages.at(-1);
      if (last?.role === 'tool') {
        results.push(String(last.content));
        yield { type: 'done', message: { role: 'assistant', content: sub ? 'designer done' : 'done' }, finishReason: 'stop', usage };
        return;
      }
      const tool = options.subAgent && !sub ? call('a1', 'Agent', { subagent_type: 'gsd-designer', prompt: 'Make the hero image.', description: 'hero image' }) : call(sub ? 's1' : 'g1', 'GenerateImage', { prompt: 'a lighthouse', path: 'assets/hero.png' });
      yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [tool] }, finishReason: 'tool_calls', usage };
    },
    async generateImage() { return { bytes: new Uint8Array([5, 6, 7]), remoteUrlPresent: false }; },
    async actualCostsUsd() { return undefined; }
  };
  const posted: Array<Record<string, unknown>> = [];
  const counts: number[] = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'));
  conversation.onWaitingChange = (count) => counts.push(count);
  return { conversation, posted, counts, results, near };
}

const turnRequest = (near: unknown, extra: Record<string, unknown> = {}) => ({
  text: 'make a hero image', client: near as never, model: 'm', privacy: 'Private',
  // Full auto: nothing asks for approval, and the image still waits for the person (as AskUserQuestion does in this mode).
  policy: { mode: 'fully-autonomous' as const, emergencyStop: false }, rules: DEFAULT_RULES, imageModel: FLUX as never, ...extra
});

test('a run waits on the image review card like a question, even in full auto, and Accept saves the image and carries on', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-image-run-'));
  const { conversation, posted, counts, results, near } = imageConversation(root);
  try {
    const running = conversation.send(turnRequest(near));
    const card = await until(() => posted.find((message) => message.type === 'image-review-request'));
    assert.match(String(card.id), /^img-[a-f0-9]{12}$/);
    assert.equal(card.path, 'assets/hero.png');
    assert.equal(card.model, FLUX.id);
    assert.equal(card.prompt, 'a lighthouse');
    assert.equal(card.attempt, 1);
    assert.equal(card.image, `data:image/png;base64,${Buffer.from([5, 6, 7]).toString('base64')}`);
    assert.equal(card.agent, undefined, 'the main agent\'s card names no sub-agent');
    assert.deepEqual(counts, [1], 'counted as waiting for the person, like an approval or a question');
    assert.deepEqual(conversation.waitingPrompts(), [{ ...card, replay: true }], 'a reloaded view gets the card again');
    assert.equal(existsSync(path.join(root, 'assets', 'hero.png')), false);
    assert.equal(conversation.imageDraftFile(String(card.id)), draftFile(root, String(card.id)), 'Open full size finds the draft');
    assert.equal(conversation.imageDraftFile('img-000000000000'), undefined, 'and nothing else');
    assert.equal(conversation.answerImageReview(String(card.id), { decision: 'accept' }), true);
    await running;
    assert.deepEqual(results, [`Accepted by the user and saved to assets/hero.png (0 KB, ${FLUX.id}).`]);
    assert.deepEqual([...await readFile(path.join(root, 'assets', 'hero.png'))], [5, 6, 7]);
    assert.deepEqual(counts, [1, 0]);
    assert.deepEqual((posted.find((message) => message.type === 'run-changes')?.files as string[]), ['assets/hero.png'], 'the accepted image is in the run\'s changes, so Revert removes it');
    assert.equal(conversation.answerImageReview(String(card.id), { decision: 'discard' }), false, 'a second answer finds nothing');
  } finally {
    conversation.dispose();
  }
});

test('stopping the run while an image waits keeps the draft, closes the card, and the progress line says it waits for the review', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-image-stop-'));
  const { conversation, posted, counts, near } = imageConversation(root);
  // Progress lines come quickly here, so the one shown while the run waits can be read.
  conversation.progressTiming = { firstMs: 30, everyMs: 30, checkMs: 10 };
  try {
    const running = conversation.send(turnRequest(near));
    const card = await until(() => posted.find((message) => message.type === 'image-review-request'));
    const progress = await until(() => posted.find((message) => message.type === 'progress'));
    assert.match(String(progress.text), /^Still working \([^)]*\): waiting for your review of an image/, 'the run says it waits for the person, not that it is thinking');
    conversation.stop();
    await running;
    assert.deepEqual(posted.filter((message) => message.type === 'prompt-closed'), [{ type: 'prompt-closed', id: card.id, outcome: 'cancelled' }]);
    assert.deepEqual(counts, [1, 0]);
    assert.ok(existsSync(draftFile(root, String(card.id))), 'the draft is kept');
    assert.equal(existsSync(path.join(root, 'assets', 'hero.png')), false);
  } finally {
    conversation.dispose();
  }
});

test('with nearAi.agent.imageReview off, a run writes the image straight to its path and shows no card', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-image-run-off-'));
  const { conversation, posted, results, near } = imageConversation(root);
  try {
    await conversation.send(turnRequest(near, { imageReview: 'off' }));
    assert.equal(posted.some((message) => message.type === 'image-review-request'), false);
    assert.match(results[0], /^Saved assets\/hero\.png/);
    assert.deepEqual([...await readFile(path.join(root, 'assets', 'hero.png'))], [5, 6, 7]);
  } finally {
    conversation.dispose();
  }
});

test('an image a sub-agent makes shows its card in the main chat, labelled with the agent, and its answer reaches the sub-agent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-image-sub-'));
  const home = await mkdtemp(path.join(tmpdir(), 'near-ai-image-sub-gsd-'));
  await mkdir(path.join(home, 'gsd-core'), { recursive: true });
  const gsd: GsdContext = { home, skills: [], agents: [{ name: 'gsd-designer', description: 'Designs', tools: ['GenerateImage'], body: 'You are the designer.', file: path.join(home, 'agents', 'gsd-designer.md') }], shellEnv: {} };
  const { conversation, posted, results, near } = imageConversation(root, { subAgent: true });
  try {
    const running = conversation.send(turnRequest(near, { gsd }));
    const card = await until(() => posted.find((message) => message.type === 'image-review-request'));
    assert.equal(card.agent, 'gsd-designer', 'the card says which agent made the image');
    assert.equal(conversation.answerImageReview(String(card.id), { decision: 'changes', feedback: 'Use a night sky.' }), true);
    await running;
    assert.match(results[0], new RegExp(`^The user asked for changes to draft ${String(card.id)} \\(attempt 1 at assets/hero\\.png\\): Use a night sky\\.`), 'the sub-agent got the person\'s words');
    assert.ok(existsSync(draftFile(root, String(card.id))), 'the draft is kept for edit_of');
  } finally {
    conversation.dispose();
  }
});

test('the view\'s replies are parsed strictly, and the log keeps an image review without its image', () => {
  assert.deepEqual(parseChatWebviewMessage({ type: 'image-review-reply', id: 'img-0123456789ab', decision: 'accept', conversationId: 'conv-abcdef12' }), { type: 'image-review-reply', id: 'img-0123456789ab', decision: 'accept', conversationId: 'conv-abcdef12' });
  assert.deepEqual(parseChatWebviewMessage({ type: 'image-review-reply', id: 'img-0123456789ab', decision: 'changes', feedback: '  warmer  ' }), { type: 'image-review-reply', id: 'img-0123456789ab', decision: 'changes', feedback: 'warmer' });
  assert.equal(parseChatWebviewMessage({ type: 'image-review-reply', id: 'img-0123456789ab', decision: 'changes' }), undefined, 'changes need words');
  assert.equal(parseChatWebviewMessage({ type: 'image-review-reply', id: 'img-0123456789ab', decision: 'accept', feedback: 'x' }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'image-review-reply', id: '../x', decision: 'accept' }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'image-review-reply', id: 'img-0123456789ab', decision: 'publish' }), undefined);
  assert.deepEqual(parseChatWebviewMessage({ type: 'image-review-open', id: 'img-0123456789ab' }), { type: 'image-review-open', id: 'img-0123456789ab' });
  assert.equal(parseChatWebviewMessage({ type: 'image-review-open', id: 'img-0123456789ab', path: '/etc/passwd' }), undefined);
  const card = { type: 'image-review-request', id: 'img-0123456789ab', path: 'hero.png', attempt: 2, image: 'data:image/png;base64,AAAA' };
  assert.equal(promptIdOf(card), 'img-0123456789ab');
  const log = new ConversationLog();
  log.add(loggable(card));
  assert.deepEqual(log.replay(new Map([['img-0123456789ab', card]]), new Map()), [{ ...card, replay: true }], 'a waiting card is replayed whole, with its image');
  assert.deepEqual(log.replay(new Map(), new Map([['img-0123456789ab', { outcome: 'accepted' }]])), [{ type: 'prompt-record', kind: 'image', title: 'Image for hero.png (attempt 2)', outcome: 'accepted', replay: true }]);
});

test('the pinned card and the transcript line word an image review', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pending = require(path.join(__dirname, '..', '..', 'media', 'chat', 'pending.js')) as { headerText(item: unknown, position: number, size: number): string; waitingText(item: unknown): string; outcomeText(item: unknown, outcome: string, detail?: unknown): string };
  const item = { id: 'img-0123456789ab', kind: 'image', agent: 'gsd-designer', title: 'Image for hero.png' };
  assert.equal(pending.headerText(item, 1, 1), 'gsd-designer made an image for you to review');
  assert.equal(pending.waitingText(item), 'Waiting for your review: Image for hero.png');
  assert.equal(pending.outcomeText(item, 'accepted'), 'Accepted and saved: Image for hero.png');
  assert.equal(pending.outcomeText(item, 'changes-requested', 'warmer'), 'Changes requested for Image for hero.png: warmer');
  assert.equal(pending.outcomeText(item, 'discarded'), 'Discarded: Image for hero.png');
  assert.equal(pending.outcomeText(item, 'cancelled'), 'Not reviewed, the run stopped (the draft is kept): Image for hero.png');
  // The card is built by the chat script, which loads the image as a data URL only (the view's CSP allows data: images and nothing remote).
  const script = require('node:fs').readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8') as string;
  assert.match(script, /case 'image-review-request': onImageReview\(m\)/);
  assert.match(script, /m\.image\.startsWith\('data:image\/png;base64,'\)/);
});

// Agent review of PR 51: each review added an abort listener to the run's signal that stayed after it was answered, piling up over a long run.
test('answered image reviews and questions leave no abort listener on the run\'s signal; a stop still cancels one that waits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-image-listeners-'));
  const posted: Array<Record<string, unknown>> = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'));
  const controller = new AbortController();
  const signal = controller.signal;
  let live = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((...args: Parameters<typeof add>) => { if (args[0] === 'abort') live += 1; add(...args); }) as typeof signal.addEventListener;
  signal.removeEventListener = ((...args: Parameters<typeof remove>) => { if (args[0] === 'abort') live -= 1; remove(...args); }) as typeof signal.removeEventListener;
  const internals = conversation as unknown as { askImageReview(draft: ImageDraft, signal: AbortSignal): Promise<ImageReviewDecision>; askQuestions(questions: unknown[], signal: AbortSignal): Promise<string[]> };
  try {
    await mkdir(draftsFolder(root), { recursive: true });
    for (let round = 0; round < 20; round += 1) {
      const id = `img-${String(round).padStart(12, '0')}`;
      await writeFile(draftFile(root, id), Buffer.from([1, 2, 3]));
      const waiting = internals.askImageReview({ id, file: draftFile(root, id), path: 'assets/a.png', model: 'm', prompt: 'p', attempt: round + 1, bytes: 3 }, signal);
      await until(() => posted.find((message) => message.type === 'image-review-request' && message.id === id));
      assert.equal(conversation.answerImageReview(id, round % 2 ? { decision: 'discard' } : { decision: 'changes', feedback: 'brighter' }), true);
      assert.deepEqual(await waiting, round % 2 ? { decision: 'discard' } : { decision: 'changes', feedback: 'brighter' });
    }
    assert.equal(live, 0, 'every answered review removed its listener');
    assert.deepEqual(conversation.waitingPrompts(), [], 'no card is left waiting');
    const asked = internals.askQuestions([{ question: 'Which?', options: ['a', 'b'] }], signal);
    const card = await until(() => posted.find((message) => message.type === 'questions-request'));
    conversation.answerQuestions(String(card.id), ['a']);
    assert.deepEqual(await asked, ['a']);
    assert.equal(live, 0, 'an answered question removed its listener too');
    // A review still waiting when the run stops is cancelled, its card closed as cancelled, and its listener gone.
    const id = 'img-999999999999';
    await writeFile(draftFile(root, id), Buffer.from([1]));
    const waiting = internals.askImageReview({ id, file: draftFile(root, id), path: 'assets/a.png', model: 'm', prompt: 'p', attempt: 1, bytes: 1 }, signal);
    await until(() => posted.find((message) => message.type === 'image-review-request' && message.id === id));
    controller.abort();
    assert.deepEqual(await waiting, { decision: 'cancelled' });
    assert.deepEqual(posted.at(-1), { type: 'prompt-closed', id, outcome: 'cancelled' });
    assert.equal(conversation.answerImageReview(id, { decision: 'accept' }), false, 'a later answer finds nothing');
    assert.equal(live, 0);
  } finally {
    conversation.dispose();
  }
});

// 0.4.24 (second review of PR 51): a question or an image review had no limit, unlike approvals, so in Full auto or an unattended background sub-agent a
// run could wait for the rest of the session. Both now wait up to the approval timeout and then settle as timed out.
test('a question and an image review nobody answers close as timed out after the approval timeout, keep the draft, and leave no listener', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-image-timeout-'));
  const posted: Array<Record<string, unknown>> = [];
  const counts: number[] = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'));
  conversation.onWaitingChange = (count) => counts.push(count);
  conversation.approvalTimeoutMs = 40;
  const controller = new AbortController();
  const signal = controller.signal;
  let live = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((...args: Parameters<typeof add>) => { if (args[0] === 'abort') live += 1; add(...args); }) as typeof signal.addEventListener;
  signal.removeEventListener = ((...args: Parameters<typeof remove>) => { if (args[0] === 'abort') live -= 1; remove(...args); }) as typeof signal.removeEventListener;
  const internals = conversation as unknown as { askImageReview(draft: ImageDraft, signal: AbortSignal): Promise<ImageReviewDecision>; askQuestions(questions: unknown[], signal: AbortSignal): Promise<string[]> };
  try {
    const answers = await internals.askQuestions([{ question: 'Which?', options: ['a', 'b'] }, { question: 'And?', options: ['c', 'd'] }], signal);
    assert.deepEqual(answers, ['(no answer, timed out)', '(no answer, timed out)'], 'each question is answered as timed out');
    const card = posted.find((message) => message.type === 'questions-request');
    assert.ok(card);
    assert.deepEqual(posted.at(-1), { type: 'prompt-closed', id: card.id, outcome: 'timed-out', minutes: 1 }, 'the card closes as timed out');
    conversation.answerQuestions(String(card.id), ['a']);
    assert.deepEqual(conversation.waitingPrompts(), [], 'a late answer finds nothing waiting');
    await mkdir(draftsFolder(root), { recursive: true });
    const id = 'img-0a0a0a0a0a0a';
    await writeFile(draftFile(root, id), Buffer.from([1, 2, 3]));
    const decision = await internals.askImageReview({ id, file: draftFile(root, id), path: 'assets/a.png', model: 'm', prompt: 'p', attempt: 1, bytes: 3 }, signal);
    assert.deepEqual(decision, { decision: 'cancelled', timedOut: 1 });
    assert.deepEqual(posted.at(-1), { type: 'prompt-closed', id, outcome: 'timed-out', minutes: 1 });
    assert.ok(existsSync(draftFile(root, id)), 'the draft is kept');
    assert.equal(conversation.answerImageReview(id, { decision: 'accept' }), false, 'a late answer finds nothing');
    assert.equal(live, 0, 'no abort listener is left on the run\'s signal');
    assert.deepEqual(counts, [1, 0, 1, 0], 'the badge clears each time');
    // 0 waits indefinitely, as it does for approvals.
    conversation.approvalTimeoutMs = 0;
    const waiting = internals.askQuestions([{ question: 'Still there?', options: ['yes', 'no'] }], signal);
    const second = await until(() => posted.find((message) => message.type === 'questions-request' && message.id !== card.id));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(conversation.waitingPrompts().length, 1, 'still waiting with no limit');
    conversation.answerQuestions(String(second.id), ['yes']);
    assert.deepEqual(await waiting, ['yes']);
    assert.equal(live, 0);
  } finally {
    conversation.dispose();
  }
});

test('the image tool tells the agent a timed-out review kept the draft, and the transcript words both timeouts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-image-timeout-tool-'));
  const reviewer = scriptedReviewer(root, [{ decision: 'cancelled', timedOut: 15 }]);
  const tool = imageTool(imageClient() as never, FLUX as never, [], reviewer);
  await withContext(root, async (context) => {
    const result = await tool.run(tool.parse({ prompt: 'a lighthouse', path: 'hero.png' }), context);
    assert.match(result, /did not review the image within 15 minutes, so the review timed out\. Draft img-[0-9a-f]{12} is kept/);
    assert.match(result, /do not generate it again unless they ask/);
    assert.ok(existsSync(draftFile(root, reviewer.shown[0].id)));
    assert.equal(existsSync(path.join(root, 'hero.png')), false);
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pending = require(path.join(__dirname, '..', '..', 'media', 'chat', 'pending.js')) as { outcomeText(item: unknown, outcome: string, detail?: unknown): string };
  assert.equal(pending.outcomeText({ kind: 'image', title: 'Image for hero.png' }, 'timed-out', 15), 'Timed out, not reviewed within 15 min (the draft is kept): Image for hero.png');
  assert.equal(pending.outcomeText({ kind: 'questions', title: 'Which phase?' }, 'timed-out', 1), 'Timed out, no answer within 1 min, the agent carried on: Which phase?');
  const script = require('node:fs').readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8') as string;
  assert.match(script, /m\.outcome === 'timed-out' && typeof m\.minutes === 'number' \? m\.minutes : undefined/, 'the view passes the minutes on');
});

// Second review of PR 51: `reviewing` was cleared as soon as the decision came back, before Accept's awaits, so a parallel attempt at the same path could
// delete the draft just accepted, and moving it then failed with ENOENT.
test('a parallel attempt at the same path does not delete a draft whose Accept is still being applied', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-image-accept-race-'));
  const shown: ImageDraft[] = [];
  let accept: (decision: ImageReviewDecision) => void = () => undefined;
  const reviewer: ImageReviewer = { root, drafts: new Map(), attempts: new Map(), review: (draft) => { shown.push(draft); return shown.length === 1 ? new Promise((resolve) => { accept = resolve; }) : Promise.resolve({ decision: 'changes', feedback: 'x' }); } };
  const tool = imageTool(imageClient() as never, FLUX as never, [], reviewer);
  await withContext(root, async (context, checkpoints) => {
    // Accept's first await (the checkpoint) is held open until the second attempt has run its clean-up of earlier drafts.
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let capturing: () => void = () => undefined;
    const captured = new Promise<void>((resolve) => { capturing = resolve; });
    const capture = checkpoints.capture.bind(checkpoints);
    checkpoints.capture = async (file: string) => { capturing(); await gate; return capture(file); };
    const first = tool.run(tool.parse({ prompt: 'a', path: 'hero.png' }), context);
    await until(() => shown[0]);
    accept({ decision: 'accept' });
    await captured;
    const second = await tool.run(tool.parse({ prompt: 'b', path: 'hero.png' }), context);
    assert.match(second, /asked for changes/);
    assert.ok(existsSync(draftFile(root, shown[0].id)), 'the draft being accepted is still there');
    open();
    assert.match(await first, /^Accepted by the user and saved to hero\.png/);
    assert.ok(existsSync(path.join(root, 'hero.png')), 'the accepted image reached its path');
    assert.equal(reviewer.drafts.has(shown[0].id), false);
    assert.ok(reviewer.drafts.has(shown[1].id), 'the newer draft, kept after Request changes, stays');
    assert.equal(reviewer.drafts.get(shown[1].id)?.reviewing, false, 'and is no longer marked as under review');
  });
});

// Second review of PR 51: a draft whose file had gone was shown as "too large to show here", which sent the person looking for an image that is not there.
test('a draft whose file is gone says so on its card, offers no Accept, and a too large one still says too large', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-image-gone-'));
  const posted: Array<Record<string, unknown>> = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'));
  const internals = conversation as unknown as { askImageReview(draft: ImageDraft, signal: AbortSignal): Promise<ImageReviewDecision> };
  const controller = new AbortController();
  try {
    const id = 'img-0b0b0b0b0b0b';
    const waiting = internals.askImageReview({ id, file: draftFile(root, id), path: 'assets/a.png', model: 'm', prompt: 'p', attempt: 1, bytes: 3 }, controller.signal);
    const card = await until(() => posted.find((message) => message.type === 'image-review-request' && message.id === id));
    assert.equal(card.missing, true, 'the card is told the draft is gone');
    assert.equal(card.tooLarge, undefined, 'not that it is too large');
    assert.equal(card.image, undefined);
    controller.abort();
    await waiting;
  } finally {
    conversation.dispose();
  }
  const page = chatPage();
  const cards = () => [...page.nodes.values()].flatMap((node) => node.all((child) => child.className === 'question image-review'));
  const texts = (node: StubNode) => node.all(() => true).map((child) => child.textContent);
  page.send({ type: 'image-review-request', id: 'img-0c0c0c0c0c0c', path: 'assets/a.png', model: 'm', prompt: 'p', attempt: 1, sizeKb: 1, missing: true });
  const gone = cards()[0];
  assert.ok(gone, 'the card is shown');
  assert.ok(texts(gone).some((text) => /^This draft is gone: its file is no longer in the drafts folder/.test(text)), texts(gone).join(' | '));
  assert.equal(texts(gone).some((text) => /too large/.test(text)), false);
  const buttons = (node: StubNode) => new Map(node.all((child) => child.tagName === 'button').map((button) => [button.textContent, button]));
  assert.equal(buttons(gone).get('Accept')?.disabled, true, 'there is nothing to accept');
  assert.equal(buttons(gone).get('Open full size')?.disabled, true, 'or to open');
  assert.equal(buttons(gone).get('Discard')?.disabled, false);
  // Only the card on show is in the page, so the too-large one is shown on a page of its own.
  const other = chatPage();
  other.send({ type: 'image-review-request', id: 'img-0d0d0d0d0d0d', path: 'assets/b.png', model: 'm', prompt: 'p', attempt: 1, sizeKb: 9000, tooLarge: true });
  const large = [...other.nodes.values()].flatMap((node) => node.all((child) => child.className === 'question image-review'))[0];
  assert.ok(large);
  assert.ok(texts(large).some((text) => /too large to show here/.test(text)));
  assert.equal(buttons(large).get('Accept')?.disabled, false);
});
