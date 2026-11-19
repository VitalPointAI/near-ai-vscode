// Shared fixtures for the staff-products tests (WP-SHARED): a device signer, a host over a temporary project, two staff teams, and a way to call the
// staff tools exactly as a run does (the tool's own parse, then run, with the member as the sub-agent's label). No file of this folder is a test suite.
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { staffTools } from '../../agent/staffTools';
import type { AgentTool, ToolContext } from '../../agent/tools';
import { fingerprintOf } from '../../domain/team/canonical';
import type { KeyStatusLookup } from '../../domain/team/keyStatus';
import type { PayloadSigner } from '../../domain/team/signedPayload';
import type { SecretStorageLike } from '../../services/auth';
import type { PersonActor } from '../../domain/staff/release';
import { productPath, StaffHost } from '../../staff/staffHost';
import type { StaffTeamInfo } from '../../staff/staffHost';
import type { StaffSectionId } from '../../domain/staff/doctrine';

export function testSigner(): PayloadSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  return { fingerprint: fingerprintOf(raw), publicKey: raw.toString('base64url'), sign: (bytes: Buffer): string => edSign(null, bytes, privateKey).toString('base64url') };
}

export function trusting(...signers: PayloadSigner[]): KeyStatusLookup {
  return (key) => (signers.some((signer) => signer.fingerprint === key.fingerprint) ? { state: 'active' } : { state: 'unknown' });
}

export const J2_TEAM: StaffTeamInfo = {
  slug: 'j2-intelligence', section: 'j2', sectionLead: 'j2-chief',
  members: ['j2-chief', 'requirements-manager', 'threat-analyst', 'watch-officer', 'tradecraft-reviewer', 'release-guard']
};
export const J5_TEAM: StaffTeamInfo = {
  slug: 'j5-plans', section: 'j5', sectionLead: 'j5-chief',
  members: ['j5-chief', 'lead-planner', 'plans-writer', 'design-planner', 'red-team', 'release-guard']
};
export const J4_TEAM: StaffTeamInfo = { slug: 'j4-logistics', section: 'j4', sectionLead: 'j4-director', members: ['j4-director', 'jloc-chief', 'release-guard'] };
export const J3_TEAM: StaffTeamInfo = { slug: 'j3-operations', section: 'j3', sectionLead: 'j3-director', members: ['j3-director', 'liaison-coordinator', 'joc-chief', 'release-guard'] };

export interface StaffWorld {
  readonly root: string;
  readonly signer: PayloadSigner;
  host: StaffHost;
  readonly headStore?: SecretStorageLike;
  clock: { now: number };
  /** A new host over the same folder, as after a window reload. */
  reload(): StaffHost;
  person(name?: string, role?: string): PersonActor;
}

/** An in-memory stand-in for VS Code's SecretStorage, where the host keeps its signed ledger head. */
export function memorySecrets(): SecretStorageLike & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, get: async (key) => values.get(key), store: async (key, value) => { values.set(key, value); }, delete: async (key) => { values.delete(key); } };
}

export async function staffWorld(options: { trust?: (signer: PayloadSigner) => KeyStatusLookup; headStore?: SecretStorageLike | null } = {}): Promise<StaffWorld> {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-staff-'));
  const signer = testSigner();
  const clock = { now: Date.parse('2026-11-18T12:00:00.000Z') };
  // Every world keeps its ledger head outside the project, as the extension does; null runs a host with no head store.
  const headStore = options.headStore === null ? undefined : options.headStore ?? memorySecrets();
  const make = (): StaffHost => new StaffHost({ root, signer: async () => signer, keyStatus: async () => (options.trust ?? ((value) => trusting(value)))(signer), ...(headStore ? { headStore } : {}), now: () => { clock.now += 1000; return clock.now; } });
  const world: StaffWorld = {
    root, signer, clock, host: make(), headStore,
    reload: () => { world.host = make(); return world.host; },
    person: (name = 'A. Demo', role = 'Commander') => ({ kind: 'person', name, role, deviceFingerprint: signer.fingerprint })
  };
  return world;
}

export async function writeBody(root: string, section: StaffSectionId, product: string, body: string): Promise<string> {
  const file = path.join(root, productPath(section, product));
  await mkdir(path.dirname(file), { recursive: true });
  let header = '';
  try {
    const text = await readFile(file, 'utf8');
    const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
    if (match) header = match[0];
  } catch { /* a new file */ }
  await writeFile(file, `${header}${body}`, 'utf8');
  return file;
}

export async function readProductFile(root: string, section: StaffSectionId, product: string): Promise<string> {
  return readFile(path.join(root, productPath(section, product)), 'utf8');
}

/** Calls a staff tool as a run does: parse, then run, as `member` (undefined: the run's lead). Returns the text, or the refusal message. */
export async function callTool(world: StaffWorld, team: StaffTeamInfo, name: string, args: Record<string, unknown>, member?: string): Promise<{ ok: boolean; text: string }> {
  const tools: AgentTool<any>[] = staffTools({ host: () => world.host, team, run: 'run-1' });
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`No tool ${name}`);
  const context = { root: world.root, signal: new AbortController().signal, ...(member ? { agentLabel: member } : {}) } as unknown as ToolContext;
  try {
    const input = tool.parse(args);
    return { ok: true, text: await tool.run(input, context) };
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) };
  }
}

export const HASH = /hash ([0-9a-f]{64})/;

export function hashIn(text: string): string {
  const match = HASH.exec(text);
  if (!match) throw new Error(`No hash in: ${text}`);
  return match[1];
}

export const CLEAN_BODY = '# Concept of operations\n\nThe force moves in two phases.\n\nDECISION FOR: commander. Option A or option B, with their risk.\n';
