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

async function checkSettingsDirectory(file: string, create: boolean): Promise<void> {
  const folder = path.dirname(file);
  for (const part of [path.dirname(folder), folder]) {
    if (create) await mkdir(part, { recursive: true, mode: 0o700 });
    if (!(await lstat(part)).isDirectory()) throw new Error(INVALID_ADDRESS_TEXT);
  }
  // Older genesis settings folders may have been created with the default permissions.
  if (create && process.platform !== 'win32') await chmod(folder, 0o700);
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/** Reads only the local address. The caller must still obtain the hub key and certificate pin from the roster. */
export async function readHubAddress(globalStorageDir: string, project: string, expect?: {
  readonly hub?: string;
  readonly log?: (message: string) => void;
}): Promise<HubAddressRecord | undefined> {
  try {
    const file = hubAddressFile(globalStorageDir, project);
    await checkSettingsDirectory(file, false);
    if (!(await lstat(file)).isFile()) throw new Error(INVALID_ADDRESS_TEXT);
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let json: string;
    try {
      if (!(await handle.stat()).isFile()) throw new Error(INVALID_ADDRESS_TEXT);
      const bytes = Buffer.alloc(HUB_ADDRESS_MAX_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > HUB_ADDRESS_MAX_BYTES) throw new Error(INVALID_ADDRESS_TEXT);
      json = bytes.subarray(0, length).toString('utf8');
    } finally {
      await handle.close();
    }
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
  const file = hubAddressFile(globalStorageDir, record.project);
  await checkSettingsDirectory(file, true);
  try {
    if (!(await lstat(file)).isFile()) throw new Error(INVALID_ADDRESS_TEXT);
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error;
  }
  // The store's internal writer uses a public-file mode. This local record needs mode 0600 from creation.
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
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
