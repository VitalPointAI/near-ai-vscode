import * as path from 'node:path';
import type { LiveStatus } from '../staff/replica/liveReplicator';

function snapshot(status: LiveStatus | undefined): LiveStatus | undefined {
  return status === undefined ? undefined : { ...status, findings: [...status.findings] };
}

function sameStatus(left: LiveStatus | undefined, right: LiveStatus | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.state === right.state && left.since === right.since && left.reason === right.reason &&
    left.pulled === right.pulled && left.pushed === right.pushed &&
    left.lastSyncedAt === right.lastSyncedAt && left.retryAt === right.retryAt &&
    left.findings.length === right.findings.length && left.findings.every((finding, index) => finding === right.findings[index]);
}

/** A workspace's published connection state, empty until a live service has published it. */
export class StaffSyncStatus {
  private current: LiveStatus | undefined;
  private readonly listeners = new Set<() => void>();

  public get status(): LiveStatus | undefined {
    return snapshot(this.current);
  }

  public setStatus(status: LiveStatus | undefined): void {
    if (sameStatus(this.current, status)) return;
    this.current = snapshot(status);
    for (const listener of [...this.listeners]) listener();
  }

  public onChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }
}

const statuses = new Map<string, StaffSyncStatus>();

export function syncStatusFor(root: string): StaffSyncStatus {
  const key = path.resolve(root);
  let status = statuses.get(key);
  if (status === undefined) {
    status = new StaffSyncStatus();
    statuses.set(key, status);
  }
  return status;
}
