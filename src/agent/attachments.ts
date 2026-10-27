import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { ModelInfo, NearAiClient, UsageMetadata } from '../services/nearAiClient';
import { ToolError } from './workspace';

export type AttachmentKind = 'image' | 'audio' | 'text';

export interface StagedAttachment { id: string; name: string; kind: AttachmentKind; mime: string; size: number; bytes: Buffer }

const TYPES: Record<string, { kind: AttachmentKind; mime: string }> = {
  png: { kind: 'image', mime: 'image/png' }, jpg: { kind: 'image', mime: 'image/jpeg' }, jpeg: { kind: 'image', mime: 'image/jpeg' }, gif: { kind: 'image', mime: 'image/gif' }, webp: { kind: 'image', mime: 'image/webp' },
  mp3: { kind: 'audio', mime: 'audio/mpeg' }, wav: { kind: 'audio', mime: 'audio/wav' }, m4a: { kind: 'audio', mime: 'audio/mp4' }, ogg: { kind: 'audio', mime: 'audio/ogg' }, flac: { kind: 'audio', mime: 'audio/flac' }, webm: { kind: 'audio', mime: 'audio/webm' }
};
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'yaml', 'yml', 'xml', 'html', 'css', 'log', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'sql', 'toml', 'ini', 'env.example']);
const LIMITS: Record<AttachmentKind, number> = { image: 10 * 1024 * 1024, audio: 25 * 1024 * 1024, text: 1024 * 1024 };

/** Reads and checks a file the user chose to attach. */
export async function stageAttachment(file: string): Promise<StagedAttachment> {
  const name = path.basename(file);
  const extension = name.toLowerCase().split('.').slice(1).join('.') || '';
  const last = extension.split('.').pop() ?? '';
  const type = TYPES[last] ?? (TEXT_EXTENSIONS.has(last) || TEXT_EXTENSIONS.has(extension) ? { kind: 'text' as const, mime: 'text/plain' } : undefined);
  if (!type) throw new ToolError(`${name}: .${last || '(no extension)'} files are not supported yet. Attach images, audio, or text files (code, Markdown, JSON, CSV…); for PDFs or Office documents, paste or export the text.`);
  const info = await stat(file);
  if (!info.isFile()) throw new ToolError(`${name} is not a file.`);
  if (info.size > LIMITS[type.kind]) throw new ToolError(`${name} is ${Math.round(info.size / 1024 / 1024)} MB; ${type.kind} attachments are limited to ${LIMITS[type.kind] / 1024 / 1024} MB.`);
  const bytes = await readFile(file);
  if (type.kind === 'text' && bytes.subarray(0, 8000).includes(0)) throw new ToolError(`${name} looks binary, not text.`);
  return { id: `att-${randomBytes(6).toString('hex')}`, name, kind: type.kind, mime: type.mime, size: info.size, bytes };
}

export interface PreparedAttachments { text: string; usage: UsageMetadata[]; notes: string[] }

/**
 * Turns staged attachments into text the agent can use: text files inline; images described by a
 * vision model (the chosen model when it reads images, otherwise `visionModel`); audio transcribed
 * by `transcriptionModel`. Each block says which model read it.
 */
export async function prepareAttachments(attachments: StagedAttachment[], options: { client: NearAiClient; model: string; models: ModelInfo[]; visionModel: string; transcriptionModel: string; question: string; signal?: AbortSignal }): Promise<PreparedAttachments> {
  const blocks: string[] = [];
  const usage: UsageMetadata[] = [];
  const notes: string[] = [];
  const reads = (id: string, modality: 'image' | 'audio') => (options.models.find((model) => model.id === id)?.inputModalities ?? []).includes(modality);
  for (const attachment of attachments) {
    if (attachment.kind === 'text') {
      blocks.push(`<attachment name="${attachment.name}" kind="text">\n${attachment.bytes.toString('utf8')}\n</attachment>`);
    } else if (attachment.kind === 'image') {
      const model = reads(options.model, 'image') ? options.model : options.visionModel;
      if (!options.models.some((candidate) => candidate.id === model)) throw new ToolError(`No image-reading model is available for ${attachment.name}. Set nearAi.agent.visionModel to a model your provider offers that reads images.`);
      const result = await options.client.describeImage(model, `data:${attachment.mime};base64,${attachment.bytes.toString('base64')}`, `The user attached this image (${attachment.name}) with the message below. Describe everything relevant to it in detail, and transcribe any text, code, diagrams, or UI exactly.\n\nUser message: ${options.question.slice(0, 2000)}`, options.signal);
      usage.push(result.usage);
      if (model !== options.model) notes.push(`${attachment.name} was read by ${model}, because ${options.model} does not read images.`);
      blocks.push(`<attachment name="${attachment.name}" kind="image" read-by="${model}">\n${result.text}\n</attachment>`);
    } else {
      if (!options.models.some((candidate) => candidate.id === options.transcriptionModel)) throw new ToolError(`No speech-to-text model is available for ${attachment.name}. Set nearAi.agent.transcriptionModel to one your provider offers.`);
      const result = await options.client.transcribeAudio(options.transcriptionModel, new Uint8Array(attachment.bytes), attachment.name, attachment.mime, options.signal);
      usage.push(result.usage);
      notes.push(`${attachment.name} was transcribed by ${options.transcriptionModel}.`);
      blocks.push(`<attachment name="${attachment.name}" kind="audio" transcribed-by="${options.transcriptionModel}">\n${result.text}\n</attachment>`);
    }
  }
  return { text: blocks.join('\n\n'), usage, notes };
}
