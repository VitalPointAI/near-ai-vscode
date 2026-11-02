// Shared pieces for the live board tests (Phase 62 plan 07): timers that fire by hand on a fake monotonic clock, the fixture roadmap pushed to the
// integration branch, and a team of an owner, a confirmed lead and a confirmed developer on three real clones. It never imports vscode, so a test
// file installs its stub and requires the session module itself.
// The file has no .test suffix on purpose so the test glob does not run it as a suite.
import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import * as path from 'node:path';
import type { SchedulerTimers } from '../../team/syncScheduler';
import { closeRig, confirm, createRig, enable, invite, join, publishProject, rootOf } from './teamFlowRig';
import type { Rig } from './teamFlowRig';
import { gitIn } from './teamHarness';

export const FIXTURE_PLANNING = path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'gsd-import', 'planning');

interface Request { id: number; ms: number; due: number; callback: () => void; cleared: boolean; fired: boolean }

// The clock moves only when a test fires a timer or sets it, so a test decides when a poll happens and how much time has passed.
export class LiveTimers implements SchedulerTimers {
  public readonly requests: Request[] = [];
  public clock = 0;
  public now(): number { return this.clock; }
  public set(callback: () => void, ms: number): unknown {
    const request: Request = { id: this.requests.length, ms, due: this.clock + ms, callback, cleared: false, fired: false };
    this.requests.push(request);
    return request;
  }
  public clear(handle: unknown): void { (handle as Request).cleared = true; }
  public get live(): Request[] { return this.requests.filter((request) => !request.cleared && !request.fired); }
  public delays(): number[] { return this.requests.map((request) => request.ms); }
  /** Fires the newest waiting timer and moves the clock to when it was due. */
  public fire(): void {
    const request = this.live[this.live.length - 1];
    assert.ok(request !== undefined, 'a timer is waiting');
    request.fired = true;
    this.clock = Math.max(this.clock, request.due);
    request.callback();
  }
}

export const turn = (): Promise<void> => new Promise<void>((resolve) => { setImmediate(resolve); });

export async function until(check: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) assert.fail(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => { setTimeout(resolve, 15); });
  }
}

export function commitAndPush(dir: string, message: string): string {
  gitIn(dir, ['add', '-A']);
  gitIn(dir, ['commit', '-q', '-m', message]);
  gitIn(dir, ['push', '-q', 'origin', 'main']);
  return gitIn(dir, ['rev-parse', 'HEAD']);
}

/** Copies the committed fixture tree into the clone as .planning, commits it on main and pushes. */
export function pushFixturePlanning(dir: string): string {
  cpSync(FIXTURE_PLANNING, path.join(dir, '.planning'), { recursive: true });
  return commitAndPush(dir, 'planning files');
}

/** An owner on clone a, a confirmed developer on clone b and a confirmed lead on clone c, linked false (no NEAR organization). */
export async function withLiveTeam(run: (rig: Rig) => Promise<void>, options: { planning?: boolean } = {}): Promise<void> {
  const rig = await createRig({ linked: false });
  try {
    await enable(rig);
    await publishProject(rig);
    await invite(rig, rig.dev);
    await invite(rig, rig.lead);
    await join(rig, rig.dev);
    await join(rig, rig.lead);
    await confirm(rig, rig.lead);
    await confirm(rig, rig.dev);
    if (options.planning !== false) pushFixturePlanning(rootOf(rig, 'a'));
    await run(rig);
  } finally {
    await closeRig(rig);
  }
}
