import type URI from '@theia/core/lib/common/uri.js';
import type { FileService, TextFileContent } from '@theia/filesystem/lib/browser/file-service.js';
import { inventorySizeLimit, parseInventorySnapshot } from '../common/sterling-resource-inventory.js';
import type { InventoryRecord, InventorySnapshot } from '../common/sterling-resource-inventory.js';

export type PresentedCatalogue = Pick<TextFileContent, 'etag' | 'value' | 'encoding'>;

export async function saveResourceCatalogue(
  files: Pick<FileService, 'resolve' | 'read' | 'write'>,
  file: URI,
  presented: PresentedCatalogue,
  localPath: () => Promise<boolean>,
  current: () => boolean,
  updated: InventoryRecord,
  record?: InventoryRecord
): Promise<InventorySnapshot> {
  const { etag } = presented;
  const conflict = 'The catalogue changed. Refresh it before applying your edit again.';
  const readOptions = { limits: { size: inventorySizeLimit } };
  const matchesPresented = (content: TextFileContent): boolean => content.etag === etag
    && content.size <= inventorySizeLimit && content.encoding === presented.encoding && content.value === presented.value;
  if (!await localPath() || !current()) throw new Error(conflict);
  const before = await files.resolve(file, { resolveMetadata: true });
  if (!current() || before.etag !== etag || !before.isFile || before.isSymbolicLink || before.size > inventorySizeLimit) {
    throw new Error(conflict);
  }
  const content = await files.read(file, readOptions);
  if (!current() || !matchesPresented(content)) throw new Error(conflict);
  const parsed = parseInventorySnapshot(content.value);
  if (!parsed?.catalogueOnly) throw new Error(conflict);

  const raw = JSON.parse(content.value) as InventorySnapshot;
  const index = record ? raw.resources.findIndex(entry => entry.id === record.id) : -1;
  if (record && index < 0) throw new Error(conflict);
  if (index < 0) raw.resources.push(updated);
  else raw.resources[index] = { ...raw.resources[index], ...updated };
  const output = JSON.stringify(raw, undefined, 2) + '\n';
  if (!parseInventorySnapshot(output) || new TextEncoder().encode(output).length > inventorySizeLimit) {
    throw new Error('The entry exceeds the catalogue limits. Shorten its fields or use a smaller snapshot.');
  }
  if (!await localPath() || !current()) throw new Error(conflict);
  const latest = await files.resolve(file, { resolveMetadata: true });
  if (!current() || latest.etag !== etag || latest.mtime !== before.mtime || latest.size !== before.size
      || !latest.isFile || latest.isSymbolicLink) throw new Error(conflict);
  // The ETag can stay the same after an equal-size edit. Compare the same decoded
  // text and encoding Theia gave the widget, then retain its guarded write.
  const finalContent = await files.read(file, readOptions);
  if (!current() || !matchesPresented(finalContent)) throw new Error(conflict);
  if (!await localPath() || !current()) throw new Error(conflict);
  await files.write(file, output, { etag, mtime: before.mtime });
  return parsed;
}
