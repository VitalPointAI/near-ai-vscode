import type URI from '@theia/core/lib/common/uri.js';
import type { FileService } from '@theia/filesystem/lib/browser/file-service.js';
import { FileType, type FileSystemProvider } from '@theia/filesystem/lib/common/files.js';
import { parseWorkArea, type WorkAreaKind, type WorkAreaRecord } from '../common/sterling-work-areas.js';

const generatedFolder = /^work-area-[0-9a-f]{16}$/u;
const maxFolders = 64;
const maxBytes = 32 * 1024;
const batchSize = 8;

export interface LocalWorkArea extends WorkAreaRecord {
  readonly uri: URI;
}

async function readWorkArea(files: FileService, provider: FileSystemProvider, folder: URI): Promise<LocalWorkArea | undefined> {
  try {
    const planning = folder.resolve('.planning');
    const privateDir = planning.resolve('.near-ai');
    for (const dir of [folder, planning, privateDir]) {
      if ((await provider.stat(dir)).type !== FileType.Directory) return undefined;
    }
    const metadata = privateDir.resolve('work-area.json');
    const stat = await provider.stat(metadata);
    if (stat.type !== FileType.File || stat.size > maxBytes) return undefined;
    const content = await files.readFile(metadata, { length: maxBytes + 1, limits: { size: maxBytes } });
    const observed = await provider.stat(metadata);
    if (observed.type !== FileType.File || observed.size !== stat.size || observed.mtime !== stat.mtime ||
      content.value.byteLength > maxBytes) return undefined;
    const record = parseWorkArea(content.value.toString());
    return record && { ...record, uri: folder };
  } catch {
    return undefined;
  }
}

export async function listWorkAreas(files: FileService, root: URI, kind: WorkAreaKind, isCurrent: () => boolean): Promise<{
  entries: LocalWorkArea[];
  limited: boolean;
}> {
  const entries: LocalWorkArea[] = [];
  if (!isCurrent() || root.scheme !== 'file' || root.authority) return { entries, limited: false };
  const provider = await files.activateProvider('file');
  if (!isCurrent() || (await provider.stat(root)).type !== FileType.Directory) return { entries, limited: false };
  const candidates = (await provider.readdir(root))
    .filter(([name, type]) => type === FileType.Directory && generatedFolder.test(name))
    .map(([name]) => name)
    .sort();
  const paths = [root, ...candidates.slice(0, maxFolders).map(name => root.resolve(name))];
  for (let i = 0; i < paths.length && isCurrent(); i += batchSize) {
    const read = await Promise.all(paths.slice(i, i + batchSize).map(folder => readWorkArea(files, provider, folder)));
    for (const entry of read) if (entry?.kind === kind) entries.push(entry);
  }
  entries.sort((a, b) => a.title.localeCompare(b.title));
  return { entries, limited: candidates.length > maxFolders };
}

export async function verifyWorkArea(files: FileService, root: URI, area: LocalWorkArea): Promise<boolean> {
  if (root.scheme !== 'file' || root.authority) return false;
  const name = area.uri.path.base;
  if (!area.uri.isEqual(root) && (!generatedFolder.test(name) || !area.uri.isEqual(root.resolve(name)))) return false;
  const provider = await files.activateProvider('file');
  if ((await provider.stat(root)).type !== FileType.Directory) return false;
  const current = await readWorkArea(files, provider, area.uri);
  return current?.kind === area.kind && current.title === area.title;
}
