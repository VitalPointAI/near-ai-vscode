// Restore mode (Phase 33 D-32, D-45; 33-RESEARCH F9, A6). A hub restored from a backup by the operator's procedure lost every entry and checkpoint
// after the backup, but members' computers still hold them. Started on a state directory that holds the marker file `restore-mode` (written by the
// restore procedure in relay/README.md), the hub first takes back what it had already accepted before:
//  - an append is accepted only when every entry in it sits at a place a checkpoint this hub kept or was handed back covers (the WR-02 rule of
//    checks.ts), or is an entry the hub already holds; any other append gets the retryable `restoring` answer (503 with Retry-After), so new work
//    never lands on top of a history the hub has not got back yet;
//  - the mode ends by itself once every admitted person device of every project (not a hub, not revoked) has made one checkpoint ask since the
//    start, because each ask hands back the newer checkpoints that device holds; or when the operator removes the marker, which the hub notices at
//    most LIMITS.restoreRetrySeconds later, or at the next start. On ending the hub removes the marker itself and logs hub.restore-ended.
// Without the marker nothing changes. Log lines carry an event name and a reason word only: never a secret, a token, a pin or a project's text.
import { lstatSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { EntryHeader } from '@ext/domain/replica/entry';
import { deviceAt } from '@ext/domain/replica/rosterMembers';
import { LIMITS } from './limits';
import type { RosterCache } from './append/rosterCache';
import type { HubStore } from './store/hubStore';

/** The marker file in the state directory that starts the hub in restore mode. */
export const RESTORE_MARKER = 'restore-mode';
export const RESTORE_LOG_EVENTS = ['hub.restore-started', 'hub.restore-ended'] as const;
export type RestoreLogEvent = (typeof RESTORE_LOG_EVENTS)[number];
/** Why restore mode ended: every person device asked, or the operator removed the marker. */
export type RestoreEndReason = 'members-synced' | 'marker-removed';
export type RestoreLog = (level: 'info' | 'warn', event: RestoreLogEvent, fields: Record<string, string | number>) => void;

export interface RestoreDeps {
  store: HubStore;
  cache: RosterCache;
  /** Milliseconds. */
  now: () => number;
  log?: RestoreLog;
}

/** True when the marker is a regular file (never a link) in the state directory. */
function markerPresent(file: string): boolean {
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
}

export class RestoreMode {
  private on: boolean;
  private lastCheck: number;
  /** The person devices that asked for a checkpoint since the start, per project. */
  private readonly asked = new Map<string, Set<string>>();

  private constructor(
    private readonly file: string,
    private readonly deps: RestoreDeps,
    on: boolean,
  ) {
    this.on = on;
    this.lastCheck = deps.now();
  }

  /** Reads the marker once at start. In restore mode, logs hub.restore-started. */
  static fromStateDir(dir: string, deps: RestoreDeps): RestoreMode {
    const file = path.join(dir, RESTORE_MARKER);
    const on = markerPresent(file);
    const mode = new RestoreMode(file, deps, on);
    if (on) deps.log?.('warn', 'hub.restore-started', { retryAfterSeconds: LIMITS.restoreRetrySeconds });
    return mode;
  }

  /** Whether the hub is in restore mode now. The marker is looked at again at most every LIMITS.restoreRetrySeconds; once gone, the mode ends. */
  active(): boolean {
    if (!this.on) return false;
    const now = this.deps.now();
    if (now - this.lastCheck >= LIMITS.restoreRetrySeconds * 1000) {
      this.lastCheck = now;
      if (!markerPresent(this.file)) this.end('marker-removed');
    }
    return this.on;
  }

  /** An entry the hub may take in restore mode: already held, or at a place a kept or handed-back checkpoint of this hub covers. */
  allows(project: string, header: EntryHeader, hash: string): boolean {
    if (this.deps.store.entryByHash(project, hash) !== undefined) return true;
    const covered = this.deps.store.coveredHead(project, header.stream, header.writer);
    return covered !== undefined && (header.seq < covered.seq || (header.seq === covered.seq && hash === covered.hash));
  }

  /** A device asked for a checkpoint (and handed back what it holds). Ends the mode once every admitted person device of every project has. */
  async noteAsk(project: string, device: string): Promise<void> {
    if (!this.on) return;
    const devices = this.asked.get(project) ?? new Set<string>();
    devices.add(device);
    this.asked.set(project, devices);
    for (const id of this.deps.store.projectIds()) {
      const roster = await this.deps.cache.get(id);
      const done = this.asked.get(id) ?? new Set<string>();
      for (const [writer] of roster.state.members.devices) {
        const record = deviceAt(roster.state.members, writer, roster.headPosition);
        if (record !== undefined && record.kind === 'person' && !done.has(writer)) return;
      }
    }
    this.end('members-synced');
  }

  /** Leaves restore mode: the marker is removed (only that one file) and hub.restore-ended is logged once. */
  end(reason: RestoreEndReason): void {
    if (!this.on) return;
    this.on = false;
    rmSync(this.file, { force: true });
    this.deps.log?.('info', 'hub.restore-ended', { reason });
  }
}
