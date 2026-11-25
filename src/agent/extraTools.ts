import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { projectScopeId } from '../domain/contextGraph';
import type { ContextGraphNodeDto, MemoryScope } from '../domain/contextGraph';
import type { ContextGraphMemory } from '../services/contextGraphMemory';
import { modelList, resolveModelId } from '../gsd/library';
import type { ModelInfo, NearAiClient } from '../services/nearAiClient';
import { DEFAULT_BASE_URL } from '../domain/config';
import { parseHostPattern } from '../domain/gate/vocabulary';
import { declareManifest, fromArgument, INTERACTIVE_AND_UNATTENDED, INTERACTIVE_ONLY } from './tools';
import type { AgentTool } from './tools';
import { deleteDraft, DRAFT_ID, DRAFTS_DIR, moveDraft, newDraftId, readDraft, writeDraft } from './imageDrafts';
import { displayPath, resolveInWorkspace, ToolError } from './workspace';

/** A generated image waiting for the person's review (nearAi.agent.imageReview "ask"). */
export interface ImageDraft {
  id: string;
  /** The draft's file, in the project's drafts folder. */
  file: string;
  /** Where the image goes once accepted, as the agent named it (workspace-relative). */
  path: string;
  model: string;
  prompt: string;
  /** Which attempt this is at that path in this conversation, from 1. */
  attempt: number;
  bytes: number;
  /** The draft this one edits, when the model edited it rather than making a new image. */
  editOf?: string;
  /** A line for the card when edit_of could not be honoured as an edit. */
  note?: string;
  /** The sub-agent that made it (its label), and the activity id of the agent that made it. */
  agent?: string;
  agentId?: string;
}

/**
 * What the person decided on a draft; `cancelled` when the run or the agent was stopped before they did, or (0.4.24) with `timedOut` when nobody
 * answered within the approval timeout (Full auto or a background sub-agent only). `released` (0.4.24, PR #55 review): in the other modes the review
 * parked the run and nobody reviewed it for the whole day-long park limit, so the run was released; that is not a timeout, and the agent is told so.
 */
export type ImageReviewDecision = { decision: 'accept' } | { decision: 'changes'; feedback: string } | { decision: 'discard' } | { decision: 'cancelled'; timedOut?: number } | { decision: 'released' };

export interface ImageDraftEntry { path: string; reviewing?: boolean }

/** Shows drafts to the person and waits for their decision. One per conversation, so attempt numbers and edit_of carry across its runs. */
export interface ImageReviewer {
  /** The project root: drafts are kept there, also for a sub-agent working in its own worktree. */
  root: string;
  /** Drafts made in this conversation and still on disk, by id, with the path they were made for and whether a card for it is open. */
  drafts: Map<string, ImageDraftEntry>;
  /** Attempts so far at each target path (absolute), in this conversation. */
  attempts: Map<string, number>;
  review(draft: ImageDraft, signal: AbortSignal): Promise<ImageReviewDecision>;
}

type ImageInput = { prompt: string; path: string; size?: string; model: string; editOf?: string };

/**
 * Image generation through NEAR's `/images/generations`. Offered only when the provider lists a
 * model that outputs images, so the agent never claims a capability that is not there.
 *
 * `model` is the configured image model (nearAi.agent.imageModel), used when the call names none. `models` are the other models on this
 * key that output images; a call may name one of them (its ID, or the part after the last "/" when that is unique). Any other value is
 * refused with the list, so an image is never made by a model the agent did not ask for. The approval text, the result and the spend
 * record (the client tags the request with the model it is sent to) all name the model actually used.
 *
 * 0.4.23: with a `reviewer` (nearAi.agent.imageReview "ask", the default), the image is saved as a draft in the project's drafts folder, never at
 * `path`, and the call waits for the person: Accept moves the draft to `path` (through a checkpoint, so Revert removes it), Request changes returns
 * their words with the draft's id for `edit_of`, Discard deletes the draft. Without one ("off"), the image is written straight to `path` as before.
 * The description tells the agent not to score images itself or to regenerate without feedback: in a real run an agent made the same image 11 times
 * over hours, measuring each one with its own scripts, while the person could not see or steer any of it.
 */
/** The default NEAR AI endpoint's host, used when a client does not say its own (the Tools page builds the tool with a stand-in client). */
const DEFAULT_IMAGE_HOST = new URL(DEFAULT_BASE_URL).hostname;

/** The host the client sends to as a manifest names it. A host the manifest format cannot hold (a bracketed IPv6 address) is a loopback address in practice, so it is `localhost`. */
function imageHost(client: NearAiClient): string {
  const host = client.baseHost;
  if (host === undefined) return DEFAULT_IMAGE_HOST;
  return parseHostPattern(host, 'host', 'request').ok ? host : 'localhost';
}

export function imageTool(client: NearAiClient, model: ModelInfo, models: readonly ModelInfo[] = [], reviewer?: ImageReviewer): AgentTool<ImageInput> {
  const offered = [model, ...models.filter((candidate) => candidate.id !== model.id && (candidate.outputModalities ?? []).includes('image'))];
  const byId = new Map(offered.map((candidate) => [candidate.id, candidate]));
  const ids = offered.map((candidate) => candidate.id);
  const priced = (candidate: ModelInfo) => candidate.imagePricePerUnit !== undefined ? ` (about $${candidate.imagePricePerUnit} per image)` : '';
  const reviewed = reviewer
    ? ' The user reviews every image you make: it is saved as a draft and shown to them, and the image reaches path only if they accept it. Generate once, then wait: this call returns their decision. Do not measure, score or check the image yourself, and do not generate it again unless the user asked for changes; then call again with edit_of set to the draft id, the same path, and a prompt that applies their changes.'
    : '';
  const editOfParameter = reviewer ? { edit_of: { type: 'string', description: 'The id of a draft the user asked you to change (from an earlier GenerateImage result, e.g. img-0123456789ab). The model edits that image when it can, otherwise it makes a new one from your prompt.' } } : {};
  return {
    name: 'GenerateImage',
    description: `Generate an image and save it as a PNG in the workspace. Use for icons, illustrations, mockups, and placeholder art the user asked for. Uses ${model.id}${priced(model)} unless you pass model.${offered.length > 1 ? ` Image models on this key: ${modelList(offered.map((candidate) => `${candidate.id}${priced(candidate)}`), 12)}.` : ''}${reviewed}`,
    parameters: { type: 'object', properties: { prompt: { type: 'string', description: 'What the image should show.' }, path: { type: 'string', description: 'Workspace path for the PNG, e.g. assets/hero.png.' }, size: { type: 'string', description: 'e.g. 1024x1024' }, model: { type: 'string', description: `Optional image model: one of ${modelList(ids, 12)}. Defaults to ${model.id}.` }, ...editOfParameter }, required: ['prompt', 'path'], additionalProperties: false },
    capability: 'mediaGeneration',
    // The image is saved at `path` (a draft first when the person reviews it) and made by a model on the client's host. The model is chosen per call,
    // so no `infer` effect names it here: the shorthand stays `mediaGeneration` (a named exception).
    manifest: declareManifest({ tool: 'GenerateImage', effects: [{ verb: 'workspaceWrite', paths: [fromArgument('path')] }, { verb: 'network', hosts: [imageHost(client)] }], hosts: [imageHost(client)], contexts: INTERACTIVE_ONLY }),
    parse: (raw) => {
      if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) throw new ToolError('Missing required parameter "prompt".');
      if (typeof raw.path !== 'string' || !/\.png$/i.test(raw.path)) throw new ToolError('path must end in .png.');
      if (raw.size !== undefined && (typeof raw.size !== 'string' || !/^\d{2,4}x\d{2,4}$/.test(raw.size))) throw new ToolError('size must look like 1024x1024.');
      if (raw.model !== undefined && typeof raw.model !== 'string') throw new ToolError('model must be a string.');
      const asked = typeof raw.model === 'string' ? raw.model.trim() : '';
      const chosen = asked ? resolveModelId(asked, ids) : model.id;
      if (!chosen) throw new ToolError(`"${asked.slice(0, 120)}" is not an image model on this key. Image models: ${modelList(ids)}. Leave model out to use ${model.id}.`);
      let editOf: string | undefined;
      if (reviewer && raw.edit_of !== undefined && raw.edit_of !== '') {
        if (typeof raw.edit_of !== 'string' || !DRAFT_ID.test(raw.edit_of.trim())) throw new ToolError('edit_of must be a draft id from an earlier GenerateImage result, like img-0123456789ab.');
        editOf = raw.edit_of.trim();
      }
      return { prompt: raw.prompt.slice(0, 4000), path: raw.path, ...(raw.size ? { size: raw.size as string } : {}), model: chosen, ...(editOf ? { editOf } : {}) };
    },
    title: (input) => `Generate image ${input.path}`,
    async preview(input) {
      const used = byId.get(input.model) ?? model;
      const where = reviewer ? `show it to you to review before it is saved to ${input.path}` : `save it to ${input.path}`;
      return { kind: 'note', text: `${input.editOf ? `Edit draft ${input.editOf}` : 'Generate 1 image'} with ${used.id}${used.imagePricePerUnit !== undefined ? ` (about $${used.imagePricePerUnit})` : ''} and ${where}.\nPrompt: ${input.prompt}` };
    },
    async run(input, context) {
      const used = byId.get(input.model) ?? model;
      const absolute = await resolveInWorkspace(context.root, input.path);
      if (!reviewer) {
        const result = await client.generateImage(used.id, input.prompt, { count: 1, ...(input.size ? { size: input.size } : {}) }, context.signal);
        if (!result.bytes) throw new ToolError(result.remoteUrlPresent ? 'The provider returned a link instead of image data; nothing was saved.' : 'The provider returned no image.');
        await context.checkpoints.capture(absolute);
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, result.bytes);
        return `Saved ${displayPath(context.root, absolute)} (${Math.round(result.bytes.length / 1024)} KB) from ${used.id}.`;
      }
      const shown = displayPath(context.root, absolute);
      let source: Uint8Array | undefined;
      if (input.editOf) {
        // PR #55 review: a draft that no longer exists cannot be edited, so the agent is told to make the image fresh, without edit_of.
        const fresh = `Call GenerateImage again without edit_of, path: "${input.path}", and a prompt that describes the whole image with the user's changes; it makes a new image.`;
        if (!reviewer.drafts.has(input.editOf)) throw new ToolError(`${input.editOf} is not a draft kept in this conversation (an accepted draft has moved to its path, and a discarded one is gone), so it cannot be edited. ${fresh}`);
        source = await readDraft(reviewer.root, input.editOf);
        // 0.4.25: a zero-byte draft file has no image to edit, so it counts as gone (bytes?.length, not the Buffer's presence).
        if (!source?.length) { reviewer.drafts.delete(input.editOf); throw new ToolError(`Draft ${input.editOf} is no longer in ${DRAFTS_DIR}, so it cannot be edited. ${fresh}`); }
      }
      const made = await makeImage(client, used, input, source, context.signal);
      const bytes = made.result.bytes;
      if (!bytes) throw new ToolError(made.result.remoteUrlPresent ? 'The provider returned a link instead of image data; nothing was saved.' : 'The provider returned no image.');
      const attempt = (reviewer.attempts.get(absolute) ?? 0) + 1;
      reviewer.attempts.set(absolute, attempt);
      const id = newDraftId();
      const file = await writeDraft(reviewer.root, id, bytes);
      reviewer.drafts.set(id, { path: shown, reviewing: true });
      // The drafts this one replaces (the one it edits, and any earlier one for the same path kept after "Request changes" or a stop) go now that
      // the new one exists, rather than waiting for the 7-day sweep (agent review of PR 51). A failed attempt throws above and leaves them be; a
      // draft whose card is still open (another agent's attempt at the same path) is not touched.
      for (const [old, entry] of [...reviewer.drafts]) {
        if (old === id || entry.reviewing || (old !== input.editOf && entry.path !== shown)) continue;
        await deleteDraft(reviewer.root, old).catch(() => undefined);
        reviewer.drafts.delete(old);
      }
      const kb = Math.round(bytes.length / 1024);
      const how = made.note ? ` ${made.note}` : '';
      // `reviewing` stays set until the decision is fully applied (second review of PR 51): cleared before Accept's awaits, a parallel attempt at the
      // same path could delete the draft just accepted, and moving it then failed.
      try {
        const decision = await reviewer.review({
          id, file, path: shown, model: used.id, prompt: input.prompt, attempt, bytes: bytes.length,
          ...(made.edited && input.editOf ? { editOf: input.editOf } : {}), ...(made.note ? { note: made.note } : {}),
          ...(context.agentLabel ? { agent: context.agentLabel } : {}), ...(context.agentId ? { agentId: context.agentId } : {})
        }, context.signal);
        switch (decision.decision) {
          case 'accept':
            await context.checkpoints.capture(absolute);
            await mkdir(path.dirname(absolute), { recursive: true });
            await moveDraft(reviewer.root, id, absolute);
            reviewer.drafts.delete(id);
            return `Accepted by the user and saved to ${shown} (${kb} KB, ${used.id}).${how}`;
          case 'changes':
            // PR #55 review: the draft's file may have gone while the card waited (removed by hand, or a clean-up); then edit_of would name a missing file.
            if (!(await readDraft(reviewer.root, id))?.length) {
              reviewer.drafts.delete(id);
              return `The user asked for changes to the image for ${shown} (attempt ${attempt}): ${decision.feedback}\nDraft ${id} is gone from ${DRAFTS_DIR}, so it cannot be edited. Call GenerateImage again without edit_of, path: "${input.path}", and a prompt that describes the whole image with these changes. Nothing was saved to ${shown}.${how}`;
            }
            return `The user asked for changes to draft ${id} (attempt ${attempt} at ${shown}): ${decision.feedback}\nDraft ${id} is kept; call GenerateImage again with edit_of: "${id}", path: "${input.path}", and a prompt that applies these changes. Nothing was saved to ${shown}.${how}`;
          case 'discard':
            await deleteDraft(reviewer.root, id);
            reviewer.drafts.delete(id);
            return `The user discarded draft ${id}; nothing was saved to ${shown}. Do not generate this image again unless the user asks for it.`;
          case 'released':
            // 0.4.24 (PR #55 review): released after the day-long park outside Full auto, worded like a released question (QUESTION_RELEASED), never as a timeout.
            return `Nobody reviewed the image for a day, so the run was released. Draft ${id} is kept in ${DRAFTS_DIR}/ and nothing was saved to ${shown}. Carry on without it and tell the user it is waiting in ${DRAFTS_DIR}/; ask them again if it still matters, and do not generate it again unless they ask.`;
          default:
            // 0.4.24: a review nobody answered in time ends like a stop, but the agent is told why, so it carries on without the image rather than making it again.
            if (decision.timedOut !== undefined) return `The user did not review the image within ${decision.timedOut} minute${decision.timedOut === 1 ? '' : 's'}, so the review timed out. Draft ${id} is kept in ${DRAFTS_DIR}/ and nothing was saved to ${shown}. Carry on without it and tell the user it is waiting in ${DRAFTS_DIR}/; do not generate it again unless they ask.`;
            return `Stopped before the user reviewed the image. Draft ${id} is kept in ${DRAFTS_DIR}/ and nothing was saved to ${shown}.`;
        }
      } finally {
        const kept = reviewer.drafts.get(id);
        if (kept) kept.reviewing = false;
      }
    }
  };
}

/**
 * Whether an error from /images/edits says the model or the endpoint cannot edit images, rather than that the request failed. Only a model that lists no
 * operations is asked this (one that lists image-edit never falls back). 0.4.24 (second review of PR 51): a 404 counts only when its text says so too,
 * because a 404 is also a genuine failure (an unknown model or draft), and treating every one as "cannot edit" silently paid for a second image.
 */
export function editUnsupported(error: unknown): boolean {
  const failure = (error ?? {}) as { status?: unknown; errorType?: unknown; errorCode?: unknown; message?: unknown };
  const status = typeof failure.status === 'number' ? failure.status : 0;
  if ([405, 410, 501].includes(status)) return true;
  const words = `${String(failure.errorType ?? '')} ${String(failure.errorCode ?? '')} ${String(failure.message ?? '')}`;
  return [400, 404, 415, 422].includes(status) && /not[\s_-]*(?:supported|implemented)|unsupported|does not support|cannot edit/i.test(words);
}

/**
 * Makes the image: an edit of `source` when there is one and the model may edit (it lists image-edit, or lists no operations at all and the edit
 * endpoint is tried), otherwise a new image from the prompt. An edit the provider clearly does not support falls back to a new image, with a note.
 */
async function makeImage(client: NearAiClient, used: ModelInfo, input: ImageInput, source: Uint8Array | undefined, signal: AbortSignal): Promise<{ result: Awaited<ReturnType<NearAiClient['generateImage']>>; edited: boolean; note?: string }> {
  const options = input.size ? { size: input.size } : {};
  const operations = used.providerOperations ?? [];
  const listed = operations.includes('image-edit');
  let note: string | undefined;
  if (source && (listed || operations.length === 0)) {
    try {
      return { result: await client.editImage(used.id, input.prompt, source, options, signal), edited: true };
    } catch (error) {
      if (signal.aborted || listed || !editUnsupported(error)) throw error;
      note = `${used.id} cannot edit images, so this is a new image made from the prompt.`;
    }
  } else if (source) {
    note = `${used.id} does not edit images, so this is a new image made from the prompt.`;
  }
  return { result: await client.generateImage(used.id, input.prompt, { count: 1, ...options }, signal), edited: false, ...(note ? { note } : {}) };
}

/**
 * Remember and Recall: durable facts in the project's context-graph memory (or an agent's private
 * namespace), with provenance. Secret-looking or unsafe content is refused by the memory service.
 */
export function memoryTools(memory: ContextGraphMemory, scopes: { project: MemoryScope; agent?: MemoryScope }, actorId: string, runId: string): AgentTool<any>[] {
  const remember: AgentTool<{ label: string; fact: string; scope: 'project' | 'agent'; confidence?: number }> = {
    name: 'Remember',
    description: 'Save a durable fact about this project for future conversations: a decision, convention, constraint, or hard-won finding. Not for secrets, raw file contents, or temporary state. Use scope "agent" for notes only your role needs.',
    parameters: { type: 'object', properties: { label: { type: 'string', description: 'A short title.' }, fact: { type: 'string', description: 'The fact, in one or two sentences.' }, scope: { type: 'string', enum: ['project', 'agent'] }, confidence: { type: 'number', description: '0 to 1.' } }, required: ['label', 'fact'], additionalProperties: false },
    capability: 'plan',
    // A fact saved in the project's memory is a project-level change to what future agents are told, so it declares the project scope of `skill.write`.
    manifest: declareManifest({ tool: 'Remember', effects: [{ verb: 'skill.write', scope: 'project' }], contexts: INTERACTIVE_AND_UNATTENDED }),
    parse: (raw) => {
      if (typeof raw.label !== 'string' || !raw.label.trim() || typeof raw.fact !== 'string' || !raw.fact.trim()) throw new ToolError('label and fact are required.');
      const scope = raw.scope === 'agent' ? 'agent' : 'project';
      if (scope === 'agent' && !scopes.agent) throw new ToolError('Only sub-agents have a private memory; use scope "project".');
      const confidence = typeof raw.confidence === 'number' ? Math.min(1, Math.max(0, raw.confidence)) : undefined;
      return { label: raw.label.slice(0, 120), fact: raw.fact.slice(0, 600), scope, ...(confidence !== undefined ? { confidence } : {}) };
    },
    title: (input) => `Remember: ${input.label}`,
    async run(input) {
      const scope = input.scope === 'agent' ? scopes.agent! : scopes.project;
      const now = new Date().toISOString();
      const node = await memory.addFact({ scope, label: input.label, summary: input.fact, confidence: input.confidence, authoringActorId: actorId, provenance: { kind: 'agent', sourceId: runId, sourceHash: createHash('sha256').update(input.fact).digest('hex'), capturedAt: now, evidenceClass: 'observation', actorId } });
      return `Remembered "${node.label}" in ${scope.kind} memory.`;
    }
  };
  const recall: AgentTool<{ query: string }> = {
    name: 'Recall',
    description: 'Search this project\'s memory (and your private memory, if you have one) for facts saved in earlier conversations.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    capability: 'read',
    // The project's memory is not a project path (PathPattern is project-relative), so recalling a fact declares `plan`, a named shorthand exception.
    manifest: declareManifest({ tool: 'Recall', effects: [{ verb: 'plan' }], contexts: INTERACTIVE_AND_UNATTENDED }),
    parse: (raw) => {
      if (typeof raw.query !== 'string' || !raw.query.trim()) throw new ToolError('query is required.');
      return { query: raw.query.slice(0, 200) };
    },
    title: (input) => `Recall "${input.query}"`,
    async run(input, context) {
      const found = [];
      for (const scope of [scopes.project, ...(scopes.agent ? [scopes.agent] : [])]) found.push(...(await matchingFacts(memory, scope, input.query, context.signal)).map((node) => ({ scope: scope.kind, node })));
      if (!found.length) return 'Nothing in memory matches.';
      return found.slice(0, 20).map(({ scope, node }) => `- [${scope}] ${node.label}: ${node.summary}${node.confidence !== undefined ? ` (confidence ${node.confidence})` : ''}`).join('\n');
    }
  };
  return [remember, recall];
}

/** The project's memory scope, shared by the chat and the memory command so both see the same facts. */
export function projectMemoryScope(root: string): MemoryScope {
  return { kind: 'project', id: projectScopeId(root) };
}

/** Facts in a scope that contain at least one word of the query, best matches first. */
export async function matchingFacts(memory: ContextGraphMemory, scope: MemoryScope, query: string, signal?: AbortSignal): Promise<ContextGraphNodeDto[]> {
  const words = keywords(query);
  return (await memory.search(scope, query, { localOnly: true, signal })).map((node) => ({ node, score: matchCount(node, words) })).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).map((entry) => entry.node);
}

/** A bounded set of project facts to start each run with (by keyword relevance to the request). */
export async function memoryPreamble(memory: ContextGraphMemory, scope: MemoryScope, request: string): Promise<string | undefined> {
  const words = keywords(request).filter((word) => word.length > 3).slice(0, 8);
  const seen = new Map<string, { label: string; summary: string }>();
  for (const word of words) for (const node of await memory.search(scope, word, { localOnly: true }).catch(() => [])) if (seen.size < 10 && matchCount(node, [word])) seen.set(node.nodeId, { label: node.label, summary: node.summary });
  if (!seen.size) return undefined;
  return `Facts saved in this project's memory that may be relevant (verify before relying on them):\n${[...seen.values()].map((fact) => `- ${fact.label}: ${fact.summary}`).join('\n')}`;
}

// The memory service ranks every node (non-matches get a small baseline), so the runner keeps only
// facts that actually contain a query word; otherwise every run would carry the whole memory.
function keywords(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [])];
}

function matchCount(node: { label: string; summary: string }, words: string[]): number {
  const haystack = `${node.label} ${node.summary}`.toLowerCase();
  return words.filter((word) => haystack.includes(word)).length;
}
