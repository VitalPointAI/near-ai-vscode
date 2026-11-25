import { randomBytes } from 'node:crypto';
import { constants, lstatSync, realpathSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GateRuntime } from '../domain/gate/decide';
import type { ModelRow } from '../domain/gate/modelRow';
import { groupedRows } from '../domain/gate/modelRow';
import { RESEARCH_TEXT, RESEARCH_USE, fillText, laneAttachmentAllowed, projectFolderOf, withCopyOutHeader } from '../domain/gate/researchLane';
import type { AgentMessage } from '../domain/provider/messages';
import type { ModelEndpoint } from '../domain/provider/endpoint';
import { defaultSessionRoute, sessionRouteFrom, withSessionRoute } from '../gate/sessionMark';
import type { SessionRoute } from '../gate/sessionMark';
import { providerErrorMessage } from './chatBridge';
import { openPanel } from './webview/openPanel';

// The research workspace (74.1 D-17, MPRV-06, 74.1-UI-SPEC S1): the one place adversary models are used on purpose. Its own module, not a mode of the
// chat. Its folder is in the extension's global storage, never in a project; this module reads no project and offers no tool. Every request runs in a
// session route whose use is the research lane (research only), so its records say lane t0. Attachments come only from its own folder: a file from
// elsewhere is copied in first, and a file in an open project is refused (Q2). Text copied out starts with the research workspace line. Every page
// message is untrusted and checked field by field; the page only renders and posts.

export const RESEARCH_WORKSPACE_VIEW_TYPE = 'nearAi.researchWorkspace';
export const RESEARCH_WORKSPACE_COMMAND = 'nearAi.models.openResearchWorkspace';

/** One model the workspace offers, with its row words (modelRow, the same helper as the picker). */
export interface ResearchModelOption {
  readonly id: string;
  readonly row: ModelRow;
}

export interface ResearchWorkspaceDeps {
  readonly context: { readonly extensionUri: vscode.Uri };
  /** The workspace's own folder, in the extension's global storage. */
  readonly folder: string;
  /** Every catalogue model (research-only ones included); throws when the list cannot be loaded. */
  models(): Promise<readonly ResearchModelOption[]>;
  endpointFor(model: string): Promise<ModelEndpoint | undefined>;
  /** The gate runtime requests are decided and recorded with; none: the default route. */
  runtime(): Promise<GateRuntime | undefined>;
  /** The open project folders, only to refuse their files (Q2). */
  projectFolders(): readonly string[];
  /** Opens the guide's AI services option, when this build has it. */
  addService?: () => void;
}

interface Turn { readonly role: 'user' | 'assistant'; readonly text: string; readonly model?: string; readonly notice?: boolean }
interface Chat { id: string; model?: string; turns: Turn[]; files: string[] }

const MAX_TEXT = 100_000;
const MAX_FILE_BYTES = 2_000_000;
const MAX_FILES = 8;

let deps: ResearchWorkspaceDeps | undefined;
let panel: vscode.WebviewPanel | undefined;
let chat: Chat | undefined;
let options: readonly ResearchModelOption[] = [];
let running: AbortController | undefined;

const chatsDir = (base: string) => path.join(base, 'chats');
const filesDir = (base: string) => path.join(base, 'files');
const newChat = (): Chat => ({ id: `${String(Date.now()).padStart(15, '0')}-${randomBytes(4).toString('hex')}`, turns: [], files: [] });

async function post(message: Record<string, unknown>): Promise<void> {
  await panel?.webview.postMessage(message);
}

async function save(): Promise<void> {
  if (deps === undefined || chat === undefined || chat.turns.length === 0) return;
  const dir = chatsDir(deps.folder);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${chat.id}.json`);
  await writeFile(`${file}.tmp`, `${JSON.stringify({ v: 1, ...chat })}\n`, 'utf8');
  await rename(`${file}.tmp`, file);
}

/** The newest research chat in the workspace's folder, or a new one. A file that cannot be read is skipped. */
async function restore(base: string): Promise<Chat> {
  const names = await readdir(chatsDir(base)).catch(() => [] as string[]);
  for (const name of names.filter((entry) => /^[0-9]{15}-[0-9a-f]{8}\.json$/.test(entry)).sort().reverse()) {
    try {
      const value = JSON.parse(await readFile(path.join(chatsDir(base), name), 'utf8')) as Partial<Chat> & { v?: number };
      if (value.v !== 1 || !Array.isArray(value.turns) || !Array.isArray(value.files)) continue;
      const turns = value.turns.filter((turn): turn is Turn => (turn?.role === 'user' || turn?.role === 'assistant') && typeof turn.text === 'string');
      return { id: name.slice(0, -5), ...(typeof value.model === 'string' ? { model: value.model } : {}), turns, files: value.files.filter((file): file is string => typeof file === 'string') };
    } catch { /* the next newest */ }
  }
  return newChat();
}

function words(): Record<string, string> {
  return { ...RESEARCH_TEXT };
}

async function postTranscript(): Promise<void> {
  if (chat === undefined) return;
  const factsOf = (model: string | undefined) => options.find((option) => option.id === model)?.row.facts ?? '';
  await post({
    type: 'transcript',
    ...(chat.model === undefined ? {} : { model: chat.model, facts: factsOf(chat.model) }),
    turns: chat.turns.map((turn, index) => ({ index, role: turn.role, text: turn.text, notice: turn.notice === true, ...(turn.model === undefined ? {} : { model: turn.model, trust: factsOf(turn.model) }) })),
    files: chat.files.map((file) => path.basename(file))
  });
}

async function loadModels(): Promise<void> {
  if (deps === undefined) return;
  await post({ type: 'models-loading' });
  try {
    options = await deps.models();
  } catch (error) {
    options = [];
    await post({ type: 'models-error', text: fillText(RESEARCH_TEXT.modelsError, { reason: providerErrorMessage(error).replace(/\.$/, '') }) });
    return;
  }
  if (options.length === 0) { await post({ type: 'no-models', addService: deps.addService !== undefined }); return; }
  const groups = groupedRows(options).map((group) => ({ label: group.label, options: group.rows.map((option) => ({ id: option.id, text: option.row.text, title: option.row.title })) }));
  await post({ type: 'models', groups, ...(chat?.model === undefined ? {} : { selected: chat.model }) });
  await postTranscript();
}

/** A notice turn: shown in the transcript and announced, never sent to a model. */
async function notice(text: string, error = false): Promise<void> {
  await post({ type: 'notice', text, error });
}

class AttachmentReadError extends Error {}

/** Read only the same regular file whose location passed the attachment check. */
async function readAttachment(file: string, allowed: (resolved: string) => boolean): Promise<Buffer> {
  const resolved = realpathSync(file);
  const refusal = () => new AttachmentReadError('the file changed or is outside the permitted location');
  if (!allowed(resolved)) throw refusal();
  const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) throw new AttachmentReadError('the attachment is not a regular file');
    if (opened.size > MAX_FILE_BYTES) throw new AttachmentReadError('the file is larger than 2 MB');
    const verifyLocation = () => {
      if (realpathSync(file) !== resolved || !allowed(resolved)) throw refusal();
      const current = lstatSync(resolved, { bigint: true });
      if (!current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino
        || current.size !== opened.size || current.mtimeNs !== opened.mtimeNs || current.ctimeNs !== opened.ctimeNs) throw refusal();
    };
    verifyLocation();
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    verifyLocation();
    if (offset !== Number(opened.size)) throw refusal();
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

/** Adds a file: refused when it is in an open project (Q2); attached as it is inside the workspace's folder; copied in first from anywhere else. */
async function addFile(file: string): Promise<void> {
  if (deps === undefined || chat === undefined) return;
  const workspace = deps;
  const currentChat = chat;
  const name = path.basename(file);
  const inProject = (value: string): boolean => projectFolderOf(value, workspace.projectFolders(), realpathSync) !== undefined;
  if (inProject(file)) {
    await notice(`${RESEARCH_TEXT.laneNotice} ${fillText(RESEARCH_TEXT.projectFileRefused, { file: name })}`);
    return;
  }
  const folder = filesDir(workspace.folder);
  if (currentChat.files.length >= MAX_FILES) return;
  if (laneAttachmentAllowed(file, folder, realpathSync)) {
    const resolved = realpathSync(file);
    if (!currentChat.files.includes(resolved)) currentChat.files.push(resolved);
    await postTranscript();
    return;
  }
  try {
    const bytes = await readAttachment(file, (resolved) => !inProject(file) && !inProject(resolved));
    await mkdir(folder, { recursive: true });
    const resolvedFolder = realpathSync(folder);
    if (resolvedFolder !== filesDir(realpathSync(workspace.folder)) || inProject(resolvedFolder)) {
      throw new Error('the workspace attachment folder is unavailable');
    }
    const target = path.join(resolvedFolder, `${randomBytes(4).toString('hex')}-${name}`);
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    if (chat !== currentChat || deps !== workspace || currentChat.files.length >= MAX_FILES) return;
    currentChat.files.push(target);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await notice(fillText(RESEARCH_TEXT.fileCopyFailed, { file: name, reason: reason.replace(/\.$/, '') }), true);
    return;
  }
  await postTranscript();
  await post({ type: 'status', text: fillText(RESEARCH_TEXT.copiedIn, { file: name }) });
}

/** A `/` command or an `@` file reference would reach a project or a tool: the lane notice, and nothing else. */
const reachesOut = (text: string): boolean => /^\s*\//.test(text) || /(^|\s)@[^\s@]+/.test(text);

/** The user message as the model receives it: the text, then each attached file of the workspace's folder (text only). */
async function userMessage(text: string, files: readonly string[], workspace: ResearchWorkspaceDeps): Promise<string> {
  const parts = [text];
  for (const file of files) {
    const bytes = await readAttachment(file, (resolved) => {
      const projects = workspace.projectFolders();
      return laneAttachmentAllowed(resolved, filesDir(workspace.folder), realpathSync)
        && projectFolderOf(file, projects, realpathSync) === undefined
        && projectFolderOf(resolved, projects, realpathSync) === undefined;
    });
    const body = bytes.toString('utf8').slice(0, MAX_TEXT);
    parts.push(`Attached file ${path.basename(file).replace(/^[0-9a-f]{8}-/, '')}:\n\n${body}`);
  }
  return parts.join('\n\n');
}

function laneRoute(runtime: GateRuntime | undefined): SessionRoute {
  if (runtime !== undefined) return sessionRouteFrom(runtime, { use: RESEARCH_USE });
  const fallback = defaultSessionRoute();
  return { ...fallback, useOf: () => RESEARCH_USE };
}

async function send(text: string): Promise<void> {
  if (deps === undefined || chat === undefined || running !== undefined) return;
  const model = chat.model;
  if (model === undefined || text.trim() === '') return;
  if (reachesOut(text)) { await notice(RESEARCH_TEXT.laneNotice); await post({ type: 'returned', text }); return; }
  const workspace = deps;
  const currentChat = chat;
  const endpoint = await workspace.endpointFor(model);
  if (chat !== currentChat || deps !== workspace || running !== undefined) return;
  if (endpoint === undefined) { await notice(RESEARCH_TEXT.noModels, true); await post({ type: 'returned', text }); return; }
  const files = [...currentChat.files];
  let content: string;
  try {
    content = await userMessage(text.slice(0, MAX_TEXT), files, workspace);
  } catch (error) {
    if (chat !== currentChat || deps !== workspace || running !== undefined) return;
    const reason = error instanceof AttachmentReadError ? error.message : 'the file could not be read';
    await notice(`The attachment could not be sent because ${reason}. Add the file again and try sending.`, true);
    await post({ type: 'returned', text });
    return;
  }
  if (chat !== currentChat || deps !== workspace || running !== undefined) return;
  const history: AgentMessage[] = chat.turns.filter((turn) => turn.notice !== true).map((turn) => ({ role: turn.role, content: turn.text }));
  const messages: AgentMessage[] = [...history, { role: 'user', content }];
  chat.turns.push({ role: 'user', text: content });
  chat.files = [];
  await postTranscript();
  const abort = new AbortController();
  running = abort;
  await post({ type: 'waiting', text: fillText(RESEARCH_TEXT.waiting, { model }) });
  let answer = '';
  try {
    const runtime = await deps.runtime();
    // No tools, ever (LANE_TOOLS is empty), and no project text: only this chat's own turns and its own files.
    await withSessionRoute(laneRoute(runtime), async () => {
      for await (const event of endpoint.streamCompletion(model, messages, [], abort.signal)) {
        if (event.type === 'text') { answer += event.text; await post({ type: 'delta', text: answer }); }
      }
    });
    chat.turns.push({ role: 'assistant', text: answer, model });
  } catch (error) {
    // The message did not go, or the answer failed: it goes back to the composer, and the sentence is shown (a gate refusal is its 74.1-04 sentence).
    chat.turns.pop();
    chat.files = files;
    await notice(providerErrorMessage(error), true);
    await post({ type: 'returned', text });
  } finally {
    running = undefined;
    await save().catch(() => undefined);
    await postTranscript();
    await post({ type: 'idle' });
  }
}

/** The n-th fenced code block of `text`, or undefined. */
function codeBlock(text: string, index: number): string | undefined {
  const blocks = [...text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((match) => (match[1] ?? '').replace(/\n$/, ''));
  return blocks[index];
}

async function copy(turnIndex: number, block: number | undefined): Promise<void> {
  const turn = chat?.turns[turnIndex];
  if (turn === undefined || turn.role !== 'assistant' || turn.model === undefined) return;
  const text = block === undefined ? turn.text : codeBlock(turn.text, block);
  if (text === undefined) return;
  await vscode.env.clipboard.writeText(withCopyOutHeader(turn.model, text));
  await post({ type: 'status', text: RESEARCH_TEXT.copied });
}

const isIndex = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

async function receive(message: unknown): Promise<void> {
  if (deps === undefined || chat === undefined || typeof message !== 'object' || message === null || Array.isArray(message)) return;
  const fields = message as Readonly<Record<string, unknown>>;
  switch (fields['type']) {
    case 'ready': await post({ type: 'words', words: words() }); await loadModels(); break;
    case 'reload-models': await loadModels(); break;
    case 'choose-model': {
      const id = fields['model'];
      if (typeof id !== 'string' || !options.some((option) => option.id === id)) break;
      chat.model = id;
      await postTranscript();
      break;
    }
    case 'send': if (typeof fields['text'] === 'string') await send(fields['text']); break;
    case 'stop': running?.abort(); break;
    case 'add-file': {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: true, canSelectFolders: false, openLabel: RESEARCH_TEXT.addFile });
      for (const uri of picked ?? []) await addFile(uri.fsPath);
      break;
    }
    case 'drop-file': {
      // A dropped file arrives as a file URI; anything else names no file.
      const uri = fields['uri'];
      if (typeof uri !== 'string' || !uri.startsWith('file:')) { await notice(RESEARCH_TEXT.laneNotice); break; }
      await addFile(vscode.Uri.parse(uri, true).fsPath);
      break;
    }
    case 'remove-file': {
      const index = fields['index'];
      if (isIndex(index) && index < chat.files.length) { chat.files.splice(index, 1); await postTranscript(); }
      break;
    }
    case 'reach-out': await notice(RESEARCH_TEXT.laneNotice); break;
    case 'copy': {
      const turn = fields['turn'];
      const block = fields['block'];
      if (isIndex(turn) && (block === undefined || isIndex(block))) await copy(turn, block);
      break;
    }
    case 'new-chat': {
      if (running !== undefined) break;
      await save().catch(() => undefined);
      const model = chat.model;
      chat = { ...newChat(), ...(model === undefined ? {} : { model }) };
      await postTranscript();
      break;
    }
    case 'add-service': deps.addService?.(); break;
    default: break;
  }
}

/** Opens the research workspace, or reveals it when it is open (one per window). */
export async function openResearchWorkspace(given: ResearchWorkspaceDeps): Promise<vscode.WebviewPanel> {
  deps = given;
  if (panel !== undefined) { panel.reveal(); return panel; }
  await mkdir(given.folder, { recursive: true });
  chat = await restore(given.folder);
  const view = openPanel(given.context, {
    viewType: RESEARCH_WORKSPACE_VIEW_TYPE, title: RESEARCH_TEXT.panelTitle, folder: 'research', script: 'research.js', style: 'research.css', probe: 'research', retain: true, shared: ['chat/markdown.js'],
    body: '<main id="page" class="page"></main><p id="status" class="status" role="status" aria-live="polite"></p>'
  });
  panel = view;
  view.onDidDispose(() => {
    running?.abort();
    void save().catch(() => undefined);
    panel = undefined;
  });
  view.webview.onDidReceiveMessage(async (message: unknown) => {
    try {
      await receive(message);
    } catch (error) {
      await notice(providerErrorMessage(error), true);
    }
  });
  return view;
}

/** The test seam: closes the panel and forgets the module's state. */
export function resetResearchWorkspaceForTests(): void {
  panel?.dispose();
  panel = undefined;
  chat = undefined;
  deps = undefined;
  options = [];
  running = undefined;
}
