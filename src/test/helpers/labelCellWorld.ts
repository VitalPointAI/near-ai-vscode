// A small world of installs for label cell tests (plan 32-09; 32-10 to 32-13 import it): each install has its own project folder, extension storage
// and secret storage; the lead makes a shared project and declares a clearance for itself; people are brought in by invitation, join request, admission
// with the six words confirmed, and welcome file; and syncTo carries between two installs what a transport would, by hand. Fictional data only.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after } from 'node:test';
import type { Label } from '../../domain/gate/labels';
import { readGrant } from '../../domain/replica/cellKeys';
import { openBlob, openBody } from '../../domain/replica/entry';
import type { SealedBlob, SealedEntry } from '../../domain/replica/entry';
import { REPLICA_DIR } from '../../domain/staff/multiUser';
import type { SecretStorageLike } from '../../services/auth';
import { admitJoinRequest, cellOrderHook, inviteToProject, joinFromInvite, openWelcome, updateMember } from '../../staff/replica/membership';
import type { MembershipResult, SharedProjectHost } from '../../staff/replica/membership';
import { ReplicaProject, isProjectRefused } from '../../staff/replica/replicaProject';
import type { ProjectRefused, ReplicaProjectDeps } from '../../staff/replica/replicaProject';
import { parseSealed } from '../../staff/replica/store';

export class MemorySecrets implements SecretStorageLike {
  public readonly values = new Map<string, string>();
  public get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
  public store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  public delete(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
}

export const WORLD_NOW = new Date('2026-11-20T10:00:00.000Z');

/** A label of the organization scale, as a cell seals it. */
export function orgLabel(level: 'Public' | 'Internal' | 'Confidential' | 'Restricted'): Label {
  return { scale: 'org', level, compartments: [], releasability: [], handling: [] };
}

/** A declared clearance of the organization scale, as an invitation names it. */
export function orgClearance(level: 'Public' | 'Internal' | 'Confidential' | 'Restricted'): { scale: string; level: string; compartments: string[]; releasability: string[] } {
  return { scale: 'org', level, compartments: [], releasability: [] };
}

export interface Install { root: string; global: string; secrets: MemorySecrets; deps: ReplicaProjectDeps; clock: { now: Date } }

/** One install, with the cell order the staff host uses, so the fold checks pins and citations across cells. */
export function install(label: string): Install {
  const base = mkdtempSync(path.join(tmpdir(), `near-ai-label-cells-${label}-`));
  const secrets = new MemorySecrets();
  const clock = { now: WORLD_NOW };
  const global = path.join(base, 'global');
  const now = (): Date => clock.now;
  return { root: path.join(base, 'project'), global, secrets, clock, deps: { secrets, globalStorageDir: global, now, cellOrder: cellOrderHook({ now }) } };
}

const opened: ReplicaProject[] = [];
after(async () => {
  for (const project of opened) await project.close();
});

export function project(value: ReplicaProject | ProjectRefused | undefined): ReplicaProject {
  assert.ok(value instanceof ReplicaProject, `the project opens (${isProjectRefused(value) ? value.refused : String(value)})`);
  opened.push(value);
  return value;
}

export function ok<T extends MembershipResult>(result: T, what: string): T {
  assert.equal(result.ok, true, `${what}: ${result.reason ?? ''} ${result.message}`);
  return result;
}

function fileOf(result: MembershipResult): { name: string; text: string } {
  assert.ok(result.file !== undefined, 'the result carries a file');
  return result.file;
}

/** One person on one install: the shared project as their computer has it. */
export interface Seat { at: Install; p: ReplicaProject; host: SharedProjectHost; member: string; writer: string; results: MembershipResult[] }

export const hostOf = (p: ReplicaProject, at: Install): SharedProjectHost => ({ project: p, deps: at.deps });

export const LEAD_MEMBER = 'mbr-lead';

/**
 * The lead: a shared project made with createSharedProject, then the lead's own member record given a declared clearance (org/Confidential unless
 * another is named; null leaves it undeclared) and the roles named (section_lead:j4 so the lead may propose versions of j4 products).
 */
export async function leadWith(options: { clearance?: unknown; roles?: string[]; label?: string } = {}): Promise<Seat> {
  const at = install(options.label ?? 'lead');
  const p = project(await ReplicaProject.createSharedProject(at.root, at.deps, { name: 'Exercise Northwind', profile: 'j4', level: 'official', labelMapHash: 'c'.repeat(64), lead: { member: LEAD_MEMBER } }));
  const host = hostOf(p, at);
  const clearance = options.clearance === undefined ? orgClearance('Confidential') : options.clearance;
  const roles = options.roles ?? ['member', 'section_lead:j4'];
  const change: { member: string; roles: string[]; clearance?: unknown } = { member: LEAD_MEMBER, roles };
  if (clearance !== null) change.clearance = clearance;
  ok(await updateMember(host, change), 'the lead declares a clearance');
  return { at, p, host, member: LEAD_MEMBER, writer: p.deviceWriter, results: [] };
}

/** The whole flow for one person: the lead invites, the person answers, the lead admits with the words confirmed, the person opens the welcome. */
export async function bringIn(lead: Seat, label: string, name: string, clearance: unknown): Promise<Seat> {
  const at = install(label);
  const invited = ok(await inviteToProject(lead.host, { name, seat: 'j4-planner', clearance }), 'invite');
  const joined = ok(await joinFromInvite(at.root, at.deps, fileOf(invited).text, { name }), 'join');
  const admitted = ok(await admitJoinRequest(lead.host, fileOf(joined).text, { codeMatched: true }), 'admit');
  const welcomed = ok(await openWelcome(at.root, at.deps, fileOf(admitted).text), 'welcome');
  const p = project(welcomed.project);
  return { at, p, host: hostOf(p, at), member: admitted.member as string, writer: p.deviceWriter, results: [invited, joined, admitted, welcomed] };
}

const storeDir = (at: Install): string => path.join(at.root, ...REPLICA_DIR.split('/'));

/** Every signed grant in an install's store, read from disk, with the cell it is for. */
export function grantsOn(at: Install): Array<{ cell: string; signed: unknown }> {
  const dir = path.join(storeDir(at), 'grants');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((cell) => readdirSync(path.join(dir, cell)).filter((name) => name.endsWith('.json')).sort()
    .map((name) => ({ cell, signed: JSON.parse(readFileSync(path.join(dir, cell, name), 'utf8')) as unknown })));
}

/** Every sealed entry of one stream in an install's store, read from its line files. */
export function streamEntries(at: Install, stream: string): SealedEntry[] {
  const dir = path.join(storeDir(at), 'streams', stream);
  if (!existsSync(dir)) return [];
  const found: SealedEntry[] = [];
  for (const name of readdirSync(dir).filter((item) => item.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      const entry = parseSealed(JSON.parse(line) as unknown);
      if (entry !== undefined) found.push(entry);
    }
  }
  return found;
}

/** A blob in an install's store, read from disk. */
function blobOn(at: Install, hash: string): SealedBlob | undefined {
  const file = path.join(storeDir(at), 'blobs', hash);
  return existsSync(file) ? { hash, bytes: readFileSync(file).toString('base64url') } : undefined;
}

const HASH = /^[0-9a-f]{64}$/;

/** The blobs the entries name (a body moved to a blob, a version's text, a compaction's state), opened with `from`'s keys to find them. */
function blobsOf(from: Seat, entries: readonly SealedEntry[]): SealedBlob[] {
  const found = new Map<string, SealedBlob>();
  const take = (hash: unknown): SealedBlob | undefined => {
    if (typeof hash !== 'string' || !HASH.test(hash)) return undefined;
    const blob = blobOn(from.at, hash);
    if (blob !== undefined) found.set(hash, blob);
    return blob;
  };
  for (const entry of entries) {
    const { stream, epoch } = entry.header;
    const key = from.p.keys.epochKey(stream, epoch);
    if (key === undefined) continue;
    const plain = openBody(key, entry.header, Buffer.from(entry.body, 'base64url'));
    if (plain === undefined) continue;
    const body = JSON.parse(plain.toString('utf8')) as { blob?: unknown; data?: unknown };
    let data = body.data;
    const moved = take(body.blob);
    if (moved !== undefined) {
      const opened = openBlob(key, stream, epoch, moved);
      data = opened === undefined ? undefined : JSON.parse(opened.toString('utf8')) as unknown;
    }
    if (typeof data === 'object' && data !== null) {
      const record = data as Record<string, unknown>;
      take(record.textBlob);
      take(record.stateBlob);
    }
  }
  return [...found.values()];
}

/**
 * What a transport would carry from one install to another, done by hand: the roster entries `from` holds, the grants on its disk for the base cell
 * and for the named streams (a member below a cell never receives its grants, D-23), and the entries and blobs of the named streams.
 */
export async function syncTo(from: Seat, to: Seat, streams: readonly string[] = []): Promise<void> {
  const welcome = await from.p.welcomeFor(to.p.deviceWriter, []);
  const rostered = await to.p.ingestForeign([welcome.genesis, ...welcome.roster], welcome.blobs);
  assert.ok(!isProjectRefused(rostered), 'the roster entries are taken');
  const wanted = new Set([from.p.projectId, ...streams]);
  const grants = grantsOn(from.at).filter((item) => {
    const read = readGrant(item.signed);
    return read.ok && wanted.has(read.grant.cell);
  }).map((item) => item.signed);
  const stored = await to.p.putGrants(grants);
  assert.ok(!isProjectRefused(stored), 'the grants are taken');
  for (const stream of streams) {
    const entries = streamEntries(from.at, stream);
    const result = await to.p.ingestForeign(entries, blobsOf(from, entries));
    assert.ok(!isProjectRefused(result), 'the stream entries are taken');
  }
}
