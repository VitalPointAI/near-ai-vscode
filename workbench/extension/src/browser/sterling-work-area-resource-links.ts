import { BinaryBuffer } from '@theia/core/lib/common/buffer.js';
import type { URI } from '@theia/core/lib/common/uri.js';
import type { FileService } from '@theia/filesystem/lib/browser/file-service.js';
import { FilePermission, FileType, etag } from '@theia/filesystem/lib/common/files.js';
import type { FileSystemProvider, Stat } from '@theia/filesystem/lib/common/files.js';

const metadataLimit = 32 * 1024;
const resourceLimit = 50;
const workAreaFolder = /^work-area-[a-f0-9]{16}$/;
const resourceIdentifier = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const workAreaKinds = new Set(['capability-development', 'projects', 'training', 'operations', 'resources']);
const pendingWrites = new Map<string, Promise<void>>();

interface ResourceRef {
  sourceId: string;
  resourceId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isResourceRef(value: unknown): value is ResourceRef {
  return isRecord(value) && Object.keys(value).length === 2
    && typeof value.sourceId === 'string' && resourceIdentifier.test(value.sourceId)
    && typeof value.resourceId === 'string' && resourceIdentifier.test(value.resourceId);
}

function isLocal(uri: URI): boolean {
  return uri.scheme === 'file' && !uri.authority && !uri.query && !uri.fragment
    && uri.path.isAbsolute && uri.normalizePath().isEqual(uri) && !uri.path.toString().includes('\0');
}

function refKey(ref: ResourceRef): string {
  return `${ref.sourceId}/${ref.resourceId}`;
}

async function checkedStat(provider: FileSystemProvider, directories: URI[], metadata: URI): Promise<Stat> {
  for (const directory of directories) {
    if ((await provider.stat(directory)).type !== FileType.Directory) {
      throw new Error('The work area path must use regular local directories.');
    }
  }

  const info = await provider.stat(metadata);
  if (info.type !== FileType.File || (info.permissions ?? 0) & FilePermission.Readonly
    || !Number.isFinite(info.size) || info.size < 0 || info.size > metadataLimit
    || !Number.isFinite(info.mtime) || !Number.isFinite(info.ctime)) {
    throw new Error('Work area details must be a writable local JSON file no larger than 32 KB.');
  }
  return info;
}

function sameFile(left: Stat, right: Stat): boolean {
  return left.mtime === right.mtime && left.ctime === right.ctime && left.size === right.size;
}

async function writeLink(files: FileService, target: URI, metadata: URI, ref: ResourceRef): Promise<void> {
  const provider = await files.activateProvider('file');
  const directories = [...target.allLocations.reverse(), target.resolve('.planning'), metadata.parent];
  const before = await checkedStat(provider, directories, metadata);
  const readOptions = { length: metadataLimit + 1, limits: { size: metadataLimit } };
  const original = await files.readFile(metadata, readOptions);
  if (original.value.byteLength > metadataLimit || original.etag !== etag(before)) {
    throw new Error('Work area details changed. Reopen the work area and try again.');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const text = decoder.decode(original.value.buffer);
  const data: unknown = JSON.parse(text);
  if (!isRecord(data) || data.version !== 1 || typeof data.kind !== 'string' || !workAreaKinds.has(data.kind)
    || typeof data.title !== 'string' || !data.title.trim() || data.title.length > 100) {
    throw new Error('Work area details are invalid.');
  }
  const refs = Object.hasOwn(data, 'resourceRefs') ? data.resourceRefs : [];
  if (!Array.isArray(refs) || refs.length > resourceLimit || !refs.every(isResourceRef)) {
    throw new Error('Work area resource references are invalid.');
  }
  const keys = new Set(refs.map(refKey));
  if (keys.size !== refs.length) throw new Error('Work area resource references contain a duplicate.');
  if (keys.has(refKey(ref))) return;
  if (refs.length === resourceLimit) throw new Error('This work area already contains 50 resource links.');

  const output = BinaryBuffer.fromString(`${JSON.stringify({ ...data, resourceRefs: [...refs, ref] }, null, 2)}\n`);
  if (output.byteLength > metadataLimit) throw new Error('The work area details would exceed 32 KB.');

  // FileService's ETag guard can miss equal-length edits. Check the actual bytes
  // as well and recheck the path before handing off the guarded write.
  if (!sameFile(before, await checkedStat(provider, directories, metadata))) {
    throw new Error('Work area details changed. Reopen the work area and try again.');
  }
  const current = await files.readFile(metadata, readOptions);
  if (current.value.byteLength !== original.value.byteLength || current.etag !== original.etag
    || !current.value.buffer.every((byte, index) => byte === original.value.buffer[index])
    || !sameFile(before, await checkedStat(provider, directories, metadata))) {
    throw new Error('Work area details changed. Reopen the work area and try again.');
  }
  await files.writeFile(metadata, output, { mtime: original.mtime, etag: original.etag });
}

/** Link an authorized inventory selection in the caller's current trusted open workspace. */
export async function linkWorkAreaResource(files: FileService, scope: URI, target: URI, ref: ResourceRef): Promise<void> {
  if (!isLocal(scope) || !isLocal(target)
    || (!target.isEqual(scope) && !(target.parent.isEqual(scope) && workAreaFolder.test(target.path.base)))) {
    throw new Error('That work area is outside the open workspace.');
  }
  if (!isResourceRef(ref)) throw new Error('The selected resource reference is invalid.');

  const metadata = target.resolve('.planning/.near-ai/work-area.json');
  const key = metadata.toString();
  const pointer = { sourceId: ref.sourceId, resourceId: ref.resourceId };
  const prior = pendingWrites.get(key) ?? Promise.resolve();
  const pending = prior.catch(() => {}).then(() => writeLink(files, target, metadata, pointer));
  pendingWrites.set(key, pending);
  try {
    await pending;
  } finally {
    if (pendingWrites.get(key) === pending) pendingWrites.delete(key);
  }
}
