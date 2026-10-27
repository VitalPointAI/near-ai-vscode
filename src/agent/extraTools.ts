import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { ContextGraphNodeDto, MemoryScope } from '../domain/contextGraph';
import type { ContextGraphMemory } from '../services/contextGraphMemory';
import type { ModelInfo, NearAiClient } from '../services/nearAiClient';
import type { AgentTool } from './tools';
import { displayPath, resolveInWorkspace, ToolError } from './workspace';

/**
 * Image generation through NEAR's `/images/generations`. Offered only when the provider lists a
 * model that outputs images, so the agent never claims a capability that is not there.
 */
export function imageTool(client: NearAiClient, model: ModelInfo): AgentTool<{ prompt: string; path: string; size?: string }> {
  const price = model.imagePricePerUnit;
  return {
    name: 'GenerateImage',
    description: `Generate an image with ${model.id} and save it as a PNG in the workspace. Use for icons, illustrations, mockups, and placeholder art the user asked for.${price !== undefined ? ` Costs about $${price} per image.` : ''}`,
    parameters: { type: 'object', properties: { prompt: { type: 'string', description: 'What the image should show.' }, path: { type: 'string', description: 'Workspace path for the PNG, e.g. assets/hero.png.' }, size: { type: 'string', description: 'e.g. 1024x1024' } }, required: ['prompt', 'path'], additionalProperties: false },
    capability: 'mediaGeneration',
    parse: (raw) => {
      if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) throw new ToolError('Missing required parameter "prompt".');
      if (typeof raw.path !== 'string' || !/\.png$/i.test(raw.path)) throw new ToolError('path must end in .png.');
      if (raw.size !== undefined && (typeof raw.size !== 'string' || !/^\d{2,4}x\d{2,4}$/.test(raw.size))) throw new ToolError('size must look like 1024x1024.');
      return { prompt: raw.prompt.slice(0, 4000), path: raw.path, ...(raw.size ? { size: raw.size as string } : {}) };
    },
    title: (input) => `Generate image ${input.path}`,
    async preview(input) {
      return { kind: 'note', text: `Generate 1 image with ${model.id}${price !== undefined ? ` (about $${price})` : ''} and save it to ${input.path}.\nPrompt: ${input.prompt}` };
    },
    async run(input, context) {
      const absolute = await resolveInWorkspace(context.root, input.path);
      const result = await client.generateImage(model.id, input.prompt, { count: 1, ...(input.size ? { size: input.size } : {}) }, context.signal);
      if (!result.bytes) throw new ToolError(result.remoteUrlPresent ? 'The provider returned a link instead of image data; nothing was saved.' : 'The provider returned no image.');
      await context.checkpoints.capture(absolute);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, result.bytes);
      return `Saved ${displayPath(context.root, absolute)} (${Math.round(result.bytes.length / 1024)} KB) from ${model.id}.`;
    }
  };
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
  return { kind: 'project', id: `project-${createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 32)}` };
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
