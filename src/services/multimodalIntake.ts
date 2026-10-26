import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PrivacyPreflight } from './privacyPreflight';
import { attachmentPreview, cloneMultimodal, type AttachmentRecord, type AttachmentPreview, type ModalityValidationProfile, type MultimodalModality, type RawContentHandle, MULTIMODAL_VERSION } from '../domain/multimodal';
import type { PrivacyAuditRecord } from '../domain/privacy';

export const MULTIMODAL_PROFILES: Record<MultimodalModality, ModalityValidationProfile> = {
  image: { modality: 'image', mimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'], extensions: ['.png', '.jpg', '.jpeg', '.gif', '.webp'], maxBytes: 10 * 1024 * 1024 },
  video: { modality: 'video', mimeTypes: ['video/mp4', 'video/webm', 'video/quicktime'], extensions: ['.mp4', '.webm', '.mov'], maxBytes: 100 * 1024 * 1024 },
  audio: { modality: 'audio', mimeTypes: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/mp4'], extensions: ['.mp3', '.wav', '.ogg', '.flac', '.m4a'], maxBytes: 25 * 1024 * 1024 },
  document: { modality: 'document', mimeTypes: ['application/pdf', 'text/plain', 'text/markdown', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], extensions: ['.pdf', '.txt', '.md', '.docx'], maxBytes: 20 * 1024 * 1024 },
  structured: { modality: 'structured', mimeTypes: ['application/json', 'text/csv'], extensions: ['.json', '.csv'], maxBytes: 10 * 1024 * 1024 }
};

export interface IntakeInput {
  sourcePath: string;
  modality?: MultimodalModality;
  sourceKind?: 'workspace-file' | 'user-selected-file';
  consent?: boolean;
}

export interface MultimodalIntakeOptions {
  privacy?: PrivacyPreflight;
  now?: () => number;
  maxAttachments?: number;
  maxBytesRead?: number;
}

export class MultimodalIntakeError extends Error {
  public constructor(public readonly code: AttachmentRejectionCode, message: string) {
    super(message);
    this.name = 'MultimodalIntakeError';
  }
}

export type AttachmentRejectionCode =
  | 'invalid-reference' | 'path-traversal' | 'absolute-path' | 'workspace-containment' | 'symlink-escape'
  | 'missing-file' | 'not-a-file' | 'oversized' | 'empty-file' | 'unsupported-modality' | 'unsupported-mime'
  | 'content-mismatch' | 'malformed-structured-data' | 'unsupported-codec' | 'sensitive-source' | 'privacy-blocked'
  | 'consent-required' | 'capacity-exceeded';

export interface IntakeResult {
  accepted: true;
  record: AttachmentRecord;
  preview: AttachmentPreview;
  privacyAudit?: PrivacyAuditRecord;
}

const extensionModality: Record<string, MultimodalModality> = Object.values(MULTIMODAL_PROFILES).reduce((map, profile) => {
  for (const extension of profile.extensions) map[extension] = profile.modality;
  return map;
}, {} as Record<string, MultimodalModality>);

export class MultimodalIntake {
  private readonly now: () => number;
  private readonly privacy?: PrivacyPreflight;
  private readonly maxAttachments: number;
  private readonly maxBytesRead: number;
  private readonly records = new Map<string, AttachmentRecord>();
  private readonly handles = new Map<string, RawContentHandle>();

  public constructor(private readonly workspaceRoot: string, options: MultimodalIntakeOptions = {}) {
    this.now = options.now ?? Date.now;
    this.privacy = options.privacy;
    this.maxAttachments = Math.max(1, Math.min(32, options.maxAttachments ?? 16));
    this.maxBytesRead = Math.max(1024, Math.min(100 * 1024 * 1024, options.maxBytesRead ?? 100 * 1024 * 1024));
  }

  public async stage(input: IntakeInput): Promise<IntakeResult> {
    if (this.records.size >= this.maxAttachments) throw new MultimodalIntakeError('capacity-exceeded', 'Attachment capacity is full. Remove an attachment before adding another.');
    const sourceKind = input.sourceKind ?? 'workspace-file';
    const root = await fs.realpath(this.workspaceRoot).catch(() => undefined);
    if (!root || !input.sourcePath || input.sourcePath.includes('\0')) throw new MultimodalIntakeError('invalid-reference', 'The attachment reference is invalid.');
    if (path.isAbsolute(input.sourcePath)) throw new MultimodalIntakeError('absolute-path', 'Attachments must use a bounded workspace-relative reference.');
    const normalized = input.sourcePath.replaceAll('\\', '/');
    if (normalized.split('/').includes('..') || normalized.startsWith('~')) throw new MultimodalIntakeError('path-traversal', 'The attachment reference escapes the workspace.');
    const candidate = path.resolve(root, normalized);
    if (await containsSymlink(root, candidate)) throw new MultimodalIntakeError('symlink-escape', 'Symlinked attachment paths are not accepted.');
    const resolved = await fs.realpath(candidate).catch(() => undefined);
    if (!resolved && !(await fs.lstat(candidate).catch(() => undefined))) throw new MultimodalIntakeError('missing-file', 'The attachment no longer exists.');
    if (!resolved || (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))) throw new MultimodalIntakeError('workspace-containment', 'The attachment is outside the workspace.');
    const stats = await fs.stat(resolved).catch(() => undefined);
    if (!stats) throw new MultimodalIntakeError('missing-file', 'The attachment no longer exists.');
    if (!stats.isFile()) throw new MultimodalIntakeError('not-a-file', 'Only regular files can be attached.');
    if (stats.size <= 0) throw new MultimodalIntakeError('empty-file', 'Empty attachments are unavailable.');
    const extension = path.extname(resolved).toLowerCase();
    const inferred = extensionModality[extension];
    const modality = input.modality ?? inferred;
    if (!modality || !MULTIMODAL_PROFILES[modality]) throw new MultimodalIntakeError('unsupported-modality', 'The attachment modality is unavailable.');
    const profile = MULTIMODAL_PROFILES[modality];
    if (!profile.extensions.includes(extension)) throw new MultimodalIntakeError('unsupported-mime', 'The declared modality does not match the file extension.');
    if (stats.size > profile.maxBytes || stats.size > this.maxBytesRead) throw new MultimodalIntakeError('oversized', `The ${modality} attachment exceeds its bounded size limit.`);
    const bytes = await fs.readFile(resolved);
    const detectedMime = detectMime(bytes, extension, modality);
    if (!detectedMime || !profile.mimeTypes.includes(detectedMime)) throw new MultimodalIntakeError(detectedMime === undefined ? 'content-mismatch' : 'unsupported-mime', 'The detected content does not match a supported attachment type.');
    if (modality === 'structured' && !validStructured(bytes, extension)) throw new MultimodalIntakeError('malformed-structured-data', 'Structured data must be valid, bounded, and non-executable.');
    if (modality === 'document' && (extension === '.txt' || extension === '.md') && !validText(bytes)) throw new MultimodalIntakeError('content-mismatch', 'The document is not valid text.');
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const sourcePath = path.relative(root, resolved).replaceAll(path.sep, '/');
    const privacyResult = this.privacy?.preflight({ provider: 'local-intake', providerBoundary: 'local', paths: [sourcePath], context: `attachment modality ${modality}` });
    if (privacyResult?.decision.outcome === 'block') {
      const code = privacyResult.decision.classifications.includes('scopeExpansion') ? 'privacy-blocked' : 'sensitive-source';
      throw new MultimodalIntakeError(code, 'Privacy preflight blocked this attachment.');
    }
    if (input.consent === false) throw new MultimodalIntakeError('consent-required', 'Attachment consent was not granted.');
    const artifactId = `attachment-${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const managedPath = path.join(root, '.planning', '.near-ai', 'multimodal', `${artifactId}.bin`);
    await fs.mkdir(path.dirname(managedPath), { recursive: true });
    await fs.copyFile(resolved, managedPath);
    const selectedAt = new Date(this.now()).toISOString();
    const record: AttachmentRecord = {
      version: MULTIMODAL_VERSION,
      artifactId,
      label: safeLabel(path.basename(resolved)),
      modality,
      declaredMime: profile.mimeTypes[0],
      detectedMime,
      byteSize: stats.size,
      contentHash,
      sourcePath,
      managedReference: `multimodal://${artifactId}`,
      provenance: { sourceKind, sourceReference: sourcePath, workspaceRootFingerprint: createHash('sha256').update(root).digest('hex').slice(0, 32), contained: true, selectedAt, sourceHash: contentHash },
      privacy: { classification: privacyResult?.decision.classifications[0] ?? 'public', sovereigntyMode: privacyResult?.decision.sovereigntyMode ?? 'standard', localOnly: true, consent: input.consent === true ? 'granted' : 'not-required', redaction: 'metadata-only', providerBoundary: 'local' },
      lifecycle: 'staged',
      createdAt: selectedAt
    };
    this.records.set(artifactId, record);
    this.handles.set(artifactId, { artifactId, managedPath, contentHash, authorized: false });
    return { accepted: true, record: cloneMultimodal(record), preview: attachmentPreview(record), privacyAudit: privacyResult?.audit };
  }

  public get(artifactId: string): AttachmentRecord | undefined {
    const record = this.records.get(artifactId);
    return record ? cloneMultimodal(record) : undefined;
  }

  public list(): AttachmentPreview[] { return [...this.records.values()].map(attachmentPreview); }

  public cancel(artifactId: string): AttachmentPreview {
    const record = this.records.get(artifactId);
    if (!record) throw new MultimodalIntakeError('invalid-reference', 'Unknown attachment.');
    record.lifecycle = 'cancelled';
    this.handles.delete(artifactId);
    return attachmentPreview(record);
  }

  /** Raw bytes become available only after an orchestrator records an exact operation authorization. */
  public authorizeRawContent(artifactId: string, contentHash: string): RawContentHandle | undefined {
    const record = this.records.get(artifactId);
    const handle = this.handles.get(artifactId);
    if (!record || !handle || record.contentHash !== contentHash || handle.contentHash !== contentHash || record.lifecycle !== 'staged') return undefined;
    const authorized = { ...handle, authorized: true };
    this.handles.set(artifactId, authorized);
    return { ...authorized };
  }

  public rawHandle(artifactId: string): RawContentHandle | undefined {
    const handle = this.handles.get(artifactId);
    return handle?.authorized ? { ...handle } : undefined;
  }

  public async verify(artifactId: string): Promise<boolean> {
    const record = this.records.get(artifactId);
    const handle = this.handles.get(artifactId);
    if (!record || !handle || record.lifecycle !== 'staged') return false;
    const bytes = await fs.readFile(handle.managedPath).catch(() => undefined);
    return Boolean(bytes && createHash('sha256').update(bytes).digest('hex') === record.contentHash && handle.contentHash === record.contentHash);
  }
}

async function containsSymlink(root: string, resolved: string): Promise<boolean> {
  const relative = path.relative(root, resolved);
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(() => undefined);
    if (stat?.isSymbolicLink()) return true;
  }
  return false;
}

function detectMime(bytes: Buffer, extension: string, modality: MultimodalModality): string | undefined {
  if (modality === 'image') {
    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
    if (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
    if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  }
  if (modality === 'video') {
    if (bytes.subarray(4, 8).toString('ascii') === 'ftyp') return extension === '.mov' ? 'video/quicktime' : 'video/mp4';
    if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
  }
  if (modality === 'audio') {
    if (bytes.subarray(0, 3).toString('ascii') === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
    if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE') return 'audio/wav';
    if (bytes.subarray(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
    if (bytes.subarray(0, 4).toString('ascii') === 'fLaC') return 'audio/flac';
    if (bytes.subarray(4, 8).toString('ascii') === 'ftyp') return 'audio/mp4';
  }
  if (modality === 'document') {
    if (extension === '.pdf' && bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
    if ((extension === '.txt' || extension === '.md') && validText(bytes)) return extension === '.md' ? 'text/markdown' : 'text/plain';
    if (extension === '.docx' && bytes.subarray(0, 4).toString('ascii') === 'PK\x03\x04') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (modality === 'structured') {
    if (extension === '.json' && validText(bytes)) return 'application/json';
    if (extension === '.csv' && validText(bytes)) return 'text/csv';
  }
  return undefined;
}

function validText(bytes: Buffer): boolean { return !bytes.includes(0) && new TextDecoder('utf-8', { fatal: true }).decode(bytes).length <= 10 * 1024 * 1024; }
function validStructured(bytes: Buffer, extension: string): boolean {
  if (!validText(bytes)) return false;
  const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '');
  if (extension === '.json') {
    try { const value: unknown = JSON.parse(text); return boundedJson(value, 0); } catch { return false; }
  }
  const rows = text.split(/\r?\n/);
  return rows.length <= 10_000 && rows.every((row) => row.length <= 50_000 && !/[\u0000]/.test(row));
}
function boundedJson(value: unknown, depth: number): boolean {
  if (depth > 12 || value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return depth <= 12;
  if (Array.isArray(value)) return value.length <= 10_000 && value.every((item) => boundedJson(item, depth + 1));
  if (typeof value === 'object') { const entries = Object.entries(value); return entries.length <= 1_000 && entries.every(([key, item]) => key.length <= 200 && boundedJson(item, depth + 1)); }
  return false;
}
function safeLabel(value: string): string { return value.replace(/[\r\n\t]/g, ' ').replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120) || 'attachment'; }
