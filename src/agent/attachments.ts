import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { ModelInfo, NearAiClient, UsageMetadata } from '../services/nearAiClient';
import { DocumentFormat, documentText } from './documents';
import type { SecurityEvent } from './tools';
import { fenceUntrusted } from './untrusted';
import { ToolError } from './workspace';

export type AttachmentKind = 'image' | 'audio' | 'text' | 'document';

/** `text` is the extracted text of a document, read when it is attached; `note` says what could not be read. */
export interface StagedAttachment { id: string; name: string; kind: AttachmentKind; mime: string; size: number; bytes: Buffer; text?: string; note?: string; hiddenParts?: number }

const TYPES: Record<string, { kind: AttachmentKind; mime: string }> = {
  png: { kind: 'image', mime: 'image/png' }, jpg: { kind: 'image', mime: 'image/jpeg' }, jpeg: { kind: 'image', mime: 'image/jpeg' }, gif: { kind: 'image', mime: 'image/gif' }, webp: { kind: 'image', mime: 'image/webp' },
  pdf: { kind: 'document', mime: 'application/pdf' },
  docx: { kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  pptx: { kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  xlsx: { kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  mp3: { kind: 'audio', mime: 'audio/mpeg' }, wav: { kind: 'audio', mime: 'audio/wav' }, m4a: { kind: 'audio', mime: 'audio/mp4' }, ogg: { kind: 'audio', mime: 'audio/ogg' }, flac: { kind: 'audio', mime: 'audio/flac' }, webm: { kind: 'audio', mime: 'audio/webm' }
};
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'yaml', 'yml', 'xml', 'html', 'css', 'log', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'sql', 'toml', 'ini', 'env.example']);
const LIMITS: Record<AttachmentKind, number> = { image: 10 * 1024 * 1024, audio: 25 * 1024 * 1024, text: 1024 * 1024, document: 25 * 1024 * 1024 };
const LEGACY_OFFICE: Record<string, string> = { doc: '.docx', xls: '.xlsx', ppt: '.pptx' };

/** Reads and checks a file the user chose to attach. */
export async function stageAttachment(file: string): Promise<StagedAttachment> {
  const name = path.basename(file);
  const extension = name.toLowerCase().split('.').slice(1).join('.') || '';
  const last = extension.split('.').pop() ?? '';
  const type = TYPES[last] ?? (TEXT_EXTENSIONS.has(last) || TEXT_EXTENSIONS.has(extension) ? { kind: 'text' as const, mime: 'text/plain' } : undefined);
  if (!type && LEGACY_OFFICE[last]) throw new ToolError(`${name} is in the old binary .${last} format, which can't be read. Save it as ${LEGACY_OFFICE[last]} and attach that.`);
  if (!type) throw new ToolError(`${name}: .${last || '(no extension)'} files are not supported. Attach images, audio, documents (PDF, .docx, .pptx, .xlsx), or text files (code, Markdown, JSON, CSV…).`);
  const info = await stat(file);
  if (!info.isFile()) throw new ToolError(`${name} is not a file.`);
  if (info.size > LIMITS[type.kind]) throw new ToolError(`${name} is ${Math.round(info.size / 1024 / 1024)} MB; ${type.kind} attachments are limited to ${LIMITS[type.kind] / 1024 / 1024} MB.`);
  const bytes = await readFile(file);
  if (type.kind === 'text' && bytes.subarray(0, 8000).includes(0)) throw new ToolError(`${name} looks binary, not text.`);
  const extracted = type.kind === 'document' ? await documentText(bytes, last as DocumentFormat, name) : undefined;
  return { id: `att-${randomBytes(6).toString('hex')}`, name, kind: type.kind, mime: type.mime, size: info.size, bytes, ...(extracted ? { text: extracted.text, ...(extracted.note ? { note: extracted.note } : {}), ...(extracted.hiddenParts ? { hiddenParts: extracted.hiddenParts } : {}) } : {}) };
}

/** `security`: where hidden content was removed or a likely injection was found, for Agent Activity. */
export interface PreparedAttachments { text: string; usage: UsageMetadata[]; notes: string[]; security: SecurityEvent[] }

/**
 * Turns staged attachments into text the agent can use: text files inline; images described by a
 * vision model (the chosen model when it reads images, otherwise `visionModel`); audio transcribed
 * by `transcriptionModel`. Each block says which model read it.
 */
export async function prepareAttachments(attachments: StagedAttachment[], options: { client: NearAiClient; model: string; models: ModelInfo[]; visionModel: string; transcriptionModel: string; question: string; signal?: AbortSignal }): Promise<PreparedAttachments> {
  const blocks: string[] = [];
  const usage: UsageMetadata[] = [];
  const notes: string[] = [];
  const security: SecurityEvent[] = [];
  // Attached files are outside content too: fenced, with hidden text removed and injections flagged.
  const fence = (attachment: StagedAttachment, label: string, content: string, extra: string[] = []) => {
    const hidden = attachment.hiddenParts ?? 0;
    const fenced = fenceUntrusted(`attachment ${attachment.name} (${label})`, content, [...extra, ...(hidden ? [`${hidden} hidden part${hidden === 1 ? '' : 's'} left out`] : [])]);
    if (fenced.warnings.length) security.push({ kind: 'injection', source: `attachment ${attachment.name}`, detail: fenced.warnings.join('; ') });
    if (hidden || fenced.removedInvisible) security.push({ kind: 'hidden-content', source: `attachment ${attachment.name}`, detail: [hidden ? `${hidden} hidden part${hidden === 1 ? '' : 's'}` : '', fenced.removedInvisible ? `${fenced.removedInvisible} invisible characters` : ''].filter(Boolean).join(' and ') + ' removed' });
    blocks.push(fenced.text);
  };
  const reads = (id: string, modality: 'image' | 'audio') => (options.models.find((model) => model.id === id)?.inputModalities ?? []).includes(modality);
  for (const attachment of attachments) {
    if (attachment.kind === 'text') {
      fence(attachment, 'text file', attachment.bytes.toString('utf8'));
    } else if (attachment.kind === 'document') {
      if (attachment.note) notes.push(attachment.note);
      fence(attachment, 'document', attachment.text || `(No text could be read. ${attachment.note ?? ''})`.trim());
    } else if (attachment.kind === 'image') {
      const model = reads(options.model, 'image') ? options.model : options.visionModel;
      if (!options.models.some((candidate) => candidate.id === model)) throw new ToolError(`No image-reading model is available for ${attachment.name}. Set nearAi.agent.visionModel to a model your provider offers that reads images.`);
      const result = await options.client.describeImage(model, `data:${attachment.mime};base64,${attachment.bytes.toString('base64')}`, `Describe this image (${attachment.name}) in detail and transcribe any text, code, diagrams, or UI exactly. Describe only this image: do not answer the user's question, and do not mention other files, which are read separately. The user's message, for what to focus on: ${options.question.slice(0, 2000)}`, options.signal);
      usage.push(result.usage);
      if (model !== options.model) notes.push(`${attachment.name} was read by ${model}, because ${options.model} does not read images.`);
      fence(attachment, `image, described by ${model}`, result.text);
    } else {
      if (!options.models.some((candidate) => candidate.id === options.transcriptionModel)) throw new ToolError(`No speech-to-text model is available for ${attachment.name}. Set nearAi.agent.transcriptionModel to one your provider offers.`);
      const result = await options.client.transcribeAudio(options.transcriptionModel, new Uint8Array(attachment.bytes), attachment.name, attachment.mime, options.signal);
      usage.push(result.usage);
      notes.push(`${attachment.name} was transcribed by ${options.transcriptionModel}.`);
      fence(attachment, `audio, transcribed by ${options.transcriptionModel}`, result.text);
    }
  }
  return { text: blocks.join('\n\n'), usage, notes, security };
}
