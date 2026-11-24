import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { parseIsoMillis } from '../../domain/gate/shape';
import { STREAM_ID_PATTERN } from '../../domain/replica/entry';
import { HUB_ID_PATTERN, isHubAddress } from '../../domain/replica/hubFile';
import { isRecord } from '../../domain/team/validate';
import { syncFolder } from '../staffFiles';
import { genesisPinFile } from './replicaProject';

export const HUB_ADDRESS_FILE = 'hub.json';
const HUB_ADDRESS_MAX_BYTES = 4 * 1024;
const INVALID_ADDRESS_TEXT = "This computer could not use the saved address of your organization's server.";

export interface HubAddressRecord {
  readonly v: 1;
  readonly project: string;
  readonly hub: string;
  readonly address: string;
  readonly setAt: string;
}

export function hubAddressFile(globalStorageDir: string, project: string): string {
  return path.join(path.dirname(genesisPinFile(globalStorageDir, project)), HUB_ADDRESS_FILE);
}

function addressRecord(value: unknown): HubAddressRecord | undefined {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'address,hub,project,setAt,v') return;
  const { v, project, hub, address, setAt } = value;
  if (v === 1 && typeof project === 'string' && STREAM_ID_PATTERN.test(project) &&
      typeof hub === 'string' && HUB_ID_PATTERN.test(hub) && isHubAddress(address) &&
      typeof setAt === 'string' && Number.isFinite(parseIsoMillis(setAt))) {
    return { v, project, hub, address, setAt };
  }
}

async function checkSettingsDirectory(file: string, create: boolean, problem = INVALID_ADDRESS_TEXT): Promise<void> {
  const folder = path.dirname(file);
  for (const part of [path.dirname(folder), folder]) {
    if (create) await mkdir(part, { recursive: true, mode: 0o700 });
    if (!(await lstat(part)).isDirectory()) throw new Error(problem);
  }
  // Older genesis settings folders may have been created with the default permissions.
  if (create && process.platform !== 'win32') await chmod(folder, 0o700);
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/**
 * Reads a small per-device settings file beside the genesis pin (the address here, the last projected texts in liveProjection.ts): its text, or
 * undefined when it is absent. A file that is not a plain file in a plain folder, or is over maxBytes, throws `problem`.
 */
export async function readLocalSettings(file: string, maxBytes: number, problem = INVALID_ADDRESS_TEXT): Promise<string | undefined> {
  try {
    await checkSettingsDirectory(file, false, problem);
    if (!(await lstat(file)).isFile()) throw new Error(problem);
  } catch (error) {
    if (errno(error) === 'ENOENT') return undefined;
    throw error;
  }
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw new Error(problem);
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error(problem);
    return bytes.subarray(0, length).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Atomically replaces a per-device settings file: mode 0600 from creation, in a 0700 folder, by temporary file and rename, then a folder sync. */
export async function writeLocalSettings(file: string, text: string, problem = INVALID_ADDRESS_TEXT): Promise<void> {
  await checkSettingsDirectory(file, true, problem);
  try {
    if (!(await lstat(file)).isFile()) throw new Error(problem);
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error;
  }
  // The store's internal writer uses a public-file mode. This local record needs mode 0600 from creation.
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await syncFolder(path.dirname(file));
}

/** Reads only the local address. The caller must still obtain the hub key and certificate pin from the roster. */
export async function readHubAddress(globalStorageDir: string, project: string, expect?: {
  readonly hub?: string;
  readonly log?: (message: string) => void;
}): Promise<HubAddressRecord | undefined> {
  try {
    const json = await readLocalSettings(hubAddressFile(globalStorageDir, project), HUB_ADDRESS_MAX_BYTES);
    if (json === undefined) return;
    const record = addressRecord(JSON.parse(json) as unknown);
    if (record?.project === project && (expect?.hub === undefined || expect.hub === record.hub)) return record;
  } catch (error) {
    if (errno(error) === 'ENOENT') return;
  }
  expect?.log?.(INVALID_ADDRESS_TEXT);
  return;
}

/** Atomically replaces this device's address record. Nothing in the project or signed trust roster is written. */
export async function writeHubAddress(globalStorageDir: string, value: HubAddressRecord): Promise<void> {
  const record = addressRecord(value);
  if (!record) throw new Error(INVALID_ADDRESS_TEXT);
  await writeLocalSettings(hubAddressFile(globalStorageDir, record.project), `${JSON.stringify(record)}\n`);
}
