import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CyberMode, Engagement, EngagementRun, ResolvedScope, SandboxTier, Target } from '../domain/cyber';
import { isoTimestamp } from '../domain/cyber';
import { redactSecrets } from '../domain/redaction';

// D-06: engagements and their runs live in the extension's globalStorage, keyed by workspace. The
// store is append-only by design (CYBER-02): once a run has started, the engagement's target, scope,
// modes, and acceptance are frozen, and nothing in the API can rewrite or delete them.

const STORE_VERSION = 1 as const;
const ENGAGEMENT_ID = /^eng-[a-z0-9-]{6,80}$/;
const RUN_ID = /^run-[a-z0-9-]{4,80}$/;
const MAX_READ = 2_000;

/** The fields a run start freezes; a later change to any of them is refused by name. */
const FROZEN_FIELDS = ['target', 'resolvedScope', 'allowedModes', 'authorizationStatement', 'exclusions', 'acceptedDisclaimer', 'region'] as const;

export class EngagementFrozenError extends Error {
  public readonly field: string;
  public constructor(field: string, engagementId: string) {
    super(`Engagement ${engagementId} is frozen: a run has started, so its ${field} cannot change.`);
    this.name = 'EngagementFrozenError';
    this.field = field;
  }
}

export class EngagementNotFoundError extends Error {
  public constructor(engagementId: string) {
    super(`Engagement ${engagementId} was not found in this workspace.`);
    this.name = 'EngagementNotFoundError';
  }
}

export interface CyberEngagementStoreOptions {
  clock?: () => string;
  /** Most engagements `list` returns; the newest are kept. */
  maxEngagements?: number;
}

interface StoredEngagement extends Engagement { version: typeof STORE_VERSION }

export class CyberEngagementStore {
  private readonly clock: () => string;
  private readonly maxEngagements: number;
  private writeQueue: Promise<void> = Promise.resolve();

  /** `directory` is `path.join(globalStorageUri.fsPath, 'cyber', workspaceKey)`; the extension host API stays outside. */
  public constructor(private readonly directory: string, options: CyberEngagementStoreOptions = {}) {
    this.clock = options.clock ?? (() => isoTimestamp());
    this.maxEngagements = Math.max(1, Math.min(5_000, options.maxEngagements ?? 500));
  }

  public get root(): string { return this.directory; }
  public engagementPath(engagementId: string): string { return path.join(this.directory, 'engagements', `${engagementId}.json`); }
  public runPath(engagementId: string, runId: string): string { return path.join(this.directory, 'engagements', engagementId, 'runs', `${runId}.json`); }

  public async create(engagement: Engagement): Promise<Engagement> {
    if (!ENGAGEMENT_ID.test(engagement.id)) throw new Error('An engagement id must look like eng-<uuid>.');
    const stored = normalizeEngagement(engagement, this.clock());
    if (await this.readEngagement(stored.id)) throw new Error(`Engagement ${stored.id} already exists.`);
    await this.write(this.engagementPath(stored.id), stored);
    return clone(stored);
  }

  public async get(engagementId: string): Promise<Engagement | undefined> {
    if (!ENGAGEMENT_ID.test(engagementId)) return undefined;
    const stored = await this.readEngagement(engagementId);
    return stored ? clone(stored) : undefined;
  }

  /** Newest first. */
  public async list(): Promise<Engagement[]> {
    const directory = path.join(this.directory, 'engagements');
    const names = await fs.readdir(directory).catch(() => [] as string[]);
    const engagements: Engagement[] = [];
    for (const name of names.filter((entry) => entry.endsWith('.json')).slice(0, MAX_READ)) {
      const stored = await this.readEngagement(name.slice(0, -'.json'.length));
      if (stored) engagements.push(clone(stored));
    }
    return engagements.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, this.maxEngagements);
  }

  public async runs(engagementId: string): Promise<EngagementRun[]> {
    const directory = path.join(this.directory, 'engagements', engagementId, 'runs');
    const names = await fs.readdir(directory).catch(() => [] as string[]);
    const runs: EngagementRun[] = [];
    for (const name of names.filter((entry) => entry.endsWith('.json')).slice(0, MAX_READ)) {
      const run = await this.readJson<EngagementRun>(path.join(directory, name));
      if (run && RUN_ID.test(run.id ?? '')) runs.push(clone(run));
    }
    return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  /**
   * The only mutation after creation. The first run freezes the engagement; every run names its
   * engagement, and its ledger path sits inside the engagement's own directory.
   */
  public appendRun(engagementId: string, run: EngagementRun): Promise<EngagementRun> {
    if (!RUN_ID.test(run.id)) throw new Error('A run id must look like run-<id>.');
    if (run.engagementId !== engagementId) throw new Error(`Run ${run.id} names engagement ${run.engagementId}, not ${engagementId}.`);
    return this.appendRunRecord(engagementId, run);
  }

  private async appendRunRecord(engagementId: string, run: EngagementRun): Promise<EngagementRun> {
    const stored = await this.readEngagement(engagementId);
    if (!stored) throw new EngagementNotFoundError(engagementId);
    if (await this.readJson<EngagementRun>(this.runPath(engagementId, run.id))) throw new Error(`Run ${run.id} already exists in engagement ${engagementId}.`);
    const record: EngagementRun = { ...clone(run), ledgerPath: run.ledgerPath || path.join('engagements', engagementId, 'runs', run.id, 'ledger.jsonl') };
    if (!stored.frozen) {
      stored.frozen = true;
      await this.write(this.engagementPath(engagementId), stored);
    }
    await this.write(this.runPath(engagementId, run.id), record);
    return clone(record);
  }

  /** Refuses a change to any frozen field once a run has started (CYBER-02). */
  public async assertMutable(engagementId: string, changes: Partial<Pick<Engagement, (typeof FROZEN_FIELDS)[number]>>): Promise<void> {
    const stored = await this.readEngagement(engagementId);
    if (!stored) throw new EngagementNotFoundError(engagementId);
    if (!stored.frozen) return;
    for (const field of FROZEN_FIELDS) {
      if (changes[field] === undefined) continue;
      if (JSON.stringify(changes[field]) !== JSON.stringify(stored[field])) throw new EngagementFrozenError(field, engagementId);
    }
  }

  private async readEngagement(engagementId: string): Promise<StoredEngagement | undefined> {
    if (!ENGAGEMENT_ID.test(engagementId)) return undefined;
    const value = await this.readJson<StoredEngagement>(this.engagementPath(engagementId));
    if (!value || value.version !== STORE_VERSION || !ENGAGEMENT_ID.test(value.id ?? '')) return undefined;
    return value;
  }

  private async readJson<T>(file: string): Promise<T | undefined> {
    try {
      const text = await fs.readFile(file, 'utf8');
      return text.trim() ? JSON.parse(text) as T : undefined;
    } catch { return undefined; }
  }

  private async write(file: string, value: unknown): Promise<void> {
    const payload = `${JSON.stringify(value, null, 2)}\n`;
    const temporary = `${file}.tmp-${process.pid}`;
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(temporary, payload, 'utf8');
      await fs.rename(temporary, file);
    });
    await this.writeQueue;
  }
}

function scope(resolved: Partial<ResolvedScope> = {}): ResolvedScope {
  return { hosts: resolved.hosts ?? [], ports: resolved.ports ?? [], paths: resolved.paths ?? [], exclusions: resolved.exclusions ?? [], ...(resolved.note ? { note: resolved.note } : {}) };
}

function target(kind: Target['kind'], value: string): Target {
  return { kind, value: redactSecrets(value).slice(0, 2_000) };
}

function modes(values: unknown): CyberMode[] {
  const allowed: CyberMode[] = ['passive', 'active', 'intrusive'];
  return Array.isArray(values) ? allowed.filter((mode) => values.includes(mode)) : [];
}

function sandboxTier(value: unknown): SandboxTier {
  return value === 'container' || value === 'tempFolder' ? value : 'disabled';
}

function normalizeEngagement(engagement: Engagement, now: string): StoredEngagement {
  const accepted = engagement.acceptedDisclaimer;
  if (!accepted || !accepted.acceptor || !accepted.acceptedAt) throw new Error('An engagement needs an accepted disclaimer.');
  return {
    version: STORE_VERSION,
    id: engagement.id,
    workspace: engagement.workspace,
    target: target(engagement.target.kind, engagement.target.value),
    resolvedScope: scope(engagement.resolvedScope),
    region: accepted.region,
    authorizationStatement: redactSecrets(engagement.authorizationStatement).slice(0, 4_000),
    allowedModes: modes(engagement.allowedModes),
    ...(engagement.window ? { window: { start: engagement.window.start, end: engagement.window.end } } : {}),
    ...(engagement.rateLimit ? { rateLimit: { opsPerMinute: Math.max(1, Math.floor(engagement.rateLimit.opsPerMinute)) } } : {}),
    exclusions: [...new Set((engagement.exclusions ?? []).map((entry) => redactSecrets(entry).slice(0, 500)))],
    sandbox: { tier: sandboxTier(engagement.sandbox?.tier), ...(engagement.sandbox?.reason ? { reason: redactSecrets(engagement.sandbox.reason).slice(0, 500) } : {}) },
    acceptedDisclaimer: {
      acceptor: accepted.acceptor.slice(0, 200),
      osUser: accepted.osUser.slice(0, 200),
      machine: accepted.machine.slice(0, 200),
      extensionVersion: accepted.extensionVersion.slice(0, 40),
      textVersion: accepted.textVersion.slice(0, 40),
      region: accepted.region.slice(0, 40),
      acceptedAt: accepted.acceptedAt.slice(0, 40)
    },
    createdAt: engagement.createdAt || now,
    frozen: engagement.frozen === true
  };
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
