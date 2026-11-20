// Twin histories for the projection tests (plan 31-11, D-28): the same product history written once through today's single-machine staff host (signed
// ledger lines, product files and events, exactly as a run and a person make them) and once as replica entries in one world. The projection of the fold
// of the replica side must equal what today's host made. No file of this folder is a test suite.
//
// One person, "A. Demo", works on one device. On the legacy side that device signs the ledger and the person's decisions; on the replica side the same
// key is the writer, so the device fingerprint today's ledger records and the one the projection derives from the roster are the same. The agents the
// legacy tools name (lead-planner, j2-chief, release-guard, tradecraft-reviewer) are seats that person's device may run. The person's role on the
// legacy side is the decision role the version waits on, which is the role the fold presents a deciding person with (versions.ts personForTransition).
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { canonicalBytes } from '../../domain/team/canonical';
import { clientIdOf } from '../../domain/replica/clientIds';
import { docText, snapshotOf } from '../../domain/replica/doc';
import { sealBlob } from '../../domain/replica/entry';
import type { Actor, SealedEntry } from '../../domain/replica/entry';
import type { ReplicaContext } from '../../domain/replica/rosterView';
import { replicaVersionHash } from '../../domain/replica/versions';
import type { Pin } from '../../domain/replica/versions';
import type { StaffSectionId } from '../../domain/staff/doctrine';
import type { DecisionOption, StaffEvent } from '../../domain/staff/events';
import type { LedgerEntry, LedgerReplay } from '../../domain/staff/ledger';
import type { ProductDependency } from '../../domain/staff/products';
import type { PersonActor } from '../../domain/staff/release';
import { LEDGER_DIR, LEDGER_FILE, StaffHost } from '../../staff/staffHost';
import type { StaffTeamInfo } from '../../staff/staffHost';
import { createWorld, fixedSigner } from './replicaWorld';
import type { Editor, World, Written } from './replicaWorld';
import { callTool, CLEAN_BODY, hashIn, J2_TEAM, J5_TEAM, memorySecrets, readProductFile, trusting, writeBody } from './staffFixtures';
import type { StaffWorld } from './staffFixtures';

export const TWIN_DEVICE = 'demo-laptop';
export const TWIN_MEMBER = 'mbr-demo';
export const TWIN_PERSON_NAME = 'A. Demo';
export const DECISION_ROLE = 'commander';
export const TWIN_RUN = 'run-1';

export const CONOPS = 'concept-of-operations';
export const ANNEX = 'annex-b';
export const ESTIMATE = 'intelligence-estimate';
export const ESTIMATE_BODY = '# Intelligence estimate\n\n## Key judgements\n\n- We assess the adversary will likely defend the river line.\n\nMLCOA: defend. MDCOA: counter-attack.\n';
export const SECOND_BODY = `${CLEAN_BODY}\nVersion two.\n`;
export const OPTIONS: readonly DecisionOption[] = [{ label: 'COA 1', risk: 'Moderate risk to the flank' }, { label: 'COA 2', risk: 'Slower, but the flank is covered' }];
export const DISSENT: readonly string[] = ['The red team holds COA 2 is safer.'];

/** One release state per scenario, plus a revised line (rejected, then a new version on the same line) and a dependency pin. */
export const TWIN_SCENARIOS = [
  'proposed', 'guard-checked', 'tradecraft-checked', 'awaiting-decision', 'approved', 'released', 'rejected', 'revised', 'withdrawn', 'withdrawn-after-approval', 'superseded', 'pinned'
] as const;
export type TwinScenario = (typeof TWIN_SCENARIOS)[number];

type Step =
  | { readonly do: 'propose'; readonly product: string; readonly body: string; readonly dependsOn?: readonly ProductDependency[] }
  | { readonly do: 'verdict'; readonly product: string; readonly gate: 'guard' | 'tradecraft'; readonly verdict: string; readonly reasons?: readonly string[] }
  | { readonly do: 'submit'; readonly product: string }
  | { readonly do: 'approve'; readonly product: string; readonly release?: boolean }
  | { readonly do: 'release'; readonly product: string }
  | { readonly do: 'reject'; readonly product: string; readonly reasons: readonly string[] }
  | { readonly do: 'withdraw'; readonly product: string; readonly by: 'owner' | 'person'; readonly reason: string };

const toAwaiting = (product = CONOPS, body = CLEAN_BODY): Step[] => [
  { do: 'propose', product, body },
  { do: 'verdict', product, gate: 'guard', verdict: 'CLEARED' },
  { do: 'submit', product }
];

export const SCENARIO_STEPS: Readonly<Record<TwinScenario, readonly Step[]>> = {
  proposed: [{ do: 'propose', product: CONOPS, body: CLEAN_BODY }],
  'guard-checked': [
    { do: 'propose', product: CONOPS, body: CLEAN_BODY },
    { do: 'verdict', product: CONOPS, gate: 'guard', verdict: 'HOLD', reasons: ['Compilation risk across the annexes.'] },
    { do: 'verdict', product: CONOPS, gate: 'guard', verdict: 'CLEARED' }
  ],
  'tradecraft-checked': [
    { do: 'propose', product: ESTIMATE, body: ESTIMATE_BODY },
    { do: 'verdict', product: ESTIMATE, gate: 'tradecraft', verdict: 'SIGN-OFF' },
    { do: 'verdict', product: ESTIMATE, gate: 'guard', verdict: 'CLEARED' }
  ],
  'awaiting-decision': toAwaiting(),
  approved: [...toAwaiting(), { do: 'approve', product: CONOPS }],
  released: [...toAwaiting(), { do: 'approve', product: CONOPS }, { do: 'release', product: CONOPS }],
  rejected: [...toAwaiting(), { do: 'reject', product: CONOPS, reasons: ['The flank is not covered.'] }],
  revised: [...toAwaiting(), { do: 'reject', product: CONOPS, reasons: ['The flank is not covered.'] }, { do: 'propose', product: CONOPS, body: SECOND_BODY }],
  withdrawn: [
    { do: 'propose', product: CONOPS, body: CLEAN_BODY },
    { do: 'verdict', product: CONOPS, gate: 'guard', verdict: 'CLEARED' },
    { do: 'withdraw', product: CONOPS, by: 'owner', reason: 'Overtaken by the new tasking.' }
  ],
  'withdrawn-after-approval': [...toAwaiting(), { do: 'approve', product: CONOPS }, { do: 'withdraw', product: CONOPS, by: 'person', reason: 'The commander changed the mission.' }],
  superseded: [
    ...toAwaiting(), { do: 'approve', product: CONOPS, release: true },
    ...toAwaiting(CONOPS, SECOND_BODY), { do: 'approve', product: CONOPS, release: true }
  ],
  pinned: [
    ...toAwaiting(), { do: 'approve', product: CONOPS },
    { do: 'propose', product: ANNEX, body: '# Annex B\n\nThe force moves in two phases, as the concept of operations sets out.\n', dependsOn: [{ product: CONOPS, version: 1 }] }
  ]
};

const PRODUCTS: Readonly<Record<string, { team: StaffTeamInfo; section: StaffSectionId; owner: string; kind: string }>> = {
  [CONOPS]: { team: J5_TEAM, section: 'j5', owner: 'lead-planner', kind: 'plan' },
  [ANNEX]: { team: J5_TEAM, section: 'j5', owner: 'lead-planner', kind: 'annex' },
  [ESTIMATE]: { team: J2_TEAM, section: 'j2', owner: 'j2-chief', kind: 'estimate' }
};

const GATE_SEAT = { guard: 'release-guard', tradecraft: 'tradecraft-reviewer' } as const;

export interface TwinHistory {
  readonly scenario: TwinScenario;
  /** The signed ledger lines today's host wrote, parsed, oldest first. */
  readonly legacyLines: unknown[];
  readonly legacyReplay: LedgerReplay;
  /** Each product file as today's host left it, by product. */
  readonly legacyFiles: Map<string, string>;
  /** The product events today's host sent (state, gate verdict, decision requested and recorded), in order. */
  readonly legacyEvents: StaffEvent[];
  readonly replicaEntries: SealedEntry[];
  readonly ctx: ReplicaContext;
  /** The text of every proposed version, by its replica version hash: what a caller that opened the blobs passes the projection. */
  readonly texts: Map<string, string>;
  /** The replica version hash of each product's versions, by product, version 1 first. */
  readonly versionHashes: Map<string, string[]>;
  readonly world: World;
}

/** The person as today's host records a decision: the name, the decision role, and this device's key. */
export function twinPerson(): PersonActor {
  return { kind: 'person', name: TWIN_PERSON_NAME, role: DECISION_ROLE, deviceFingerprint: fixedSigner(TWIN_DEVICE).signer.fingerprint };
}

async function legacyWorld(): Promise<StaffWorld> {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-staff-twin-'));
  const signer = fixedSigner(TWIN_DEVICE).signer;
  const clock = { now: Date.parse('2026-11-18T12:00:00.000Z') };
  const headStore = memorySecrets();
  const make = (): StaffHost => new StaffHost({ root, signer: async () => signer, keyStatus: async () => trusting(signer), headStore, now: () => { clock.now += 1000; return clock.now; } });
  const world: StaffWorld = {
    root, signer, clock, host: make(), headStore,
    reload: () => { world.host = make(); return world.host; },
    person: () => twinPerson()
  };
  return world;
}

function replicaWorld(): World {
  return createWorld({
    members: [{
      member: TWIN_MEMBER,
      name: TWIN_PERSON_NAME,
      roles: ['member', 'staff_lead', 'section_lead:j5', 'answers_for:j5', 'section_lead:j2', 'answers_for:j2', `decision_for:${DECISION_ROLE}`],
      devices: [TWIN_DEVICE],
      agentSeats: ['lead-planner', 'j5-chief', 'j2-chief', 'release-guard', 'tradecraft-reviewer'],
      slots: [1]
    }]
  });
}

async function ledgerLines(root: string): Promise<unknown[]> {
  try {
    return (await readFile(path.join(root, LEDGER_DIR, LEDGER_FILE), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown);
  } catch {
    return [];
  }
}

const payloadOf = (envelope: unknown): LedgerEntry => (envelope as { payload: LedgerEntry }).payload;

const PRODUCT_EVENTS: readonly string[] = ['staff.product.state', 'staff.gate.verdict', 'staff.decision.requested', 'staff.decision.recorded'];

/** The history of the scenario, written both ways. */
export async function twinHistory(scenario: TwinScenario): Promise<TwinHistory> {
  const legacy = await legacyWorld();
  const legacyEvents: StaffEvent[] = [];
  legacy.host.onEvent((event) => { if (PRODUCT_EVENTS.includes(event.type)) legacyEvents.push(event); });
  const world = replicaWorld();
  const agent = (member: string): Actor => ({ kind: 'agent', member, run: TWIN_RUN });
  const person: Actor = { kind: 'person' };
  const texts = new Map<string, string>();
  const versionHashes = new Map<string, string[]>();
  const editors = new Map<string, Editor>();
  const approvals = new Map<string, Written>();
  const releases = new Map<string, Written>();
  let last: Written | undefined;
  let clientCounter = 0;
  const write = (kind: string, data: Record<string, unknown>, actor: Actor, at: string): Written => {
    last = world.write(TWIN_DEVICE, { kind, data, actor, at, deps: last === undefined ? [] : [last] });
    return last;
  };
  const current = (product: string): string => {
    const hashes = versionHashes.get(product) ?? [];
    return hashes[hashes.length - 1];
  };
  const pinsOf = (dependsOn: readonly ProductDependency[]): Pin[] => dependsOn.map((dependency) => ({ product: dependency.product, hash: (versionHashes.get(dependency.product) ?? [])[dependency.version - 1] }));
  const blobOf = (text: string, header: Record<string, unknown>): string => {
    const blob = sealBlob(world.keyFor(world.stream, 0), world.stream, 0, canonicalBytes({ text, header }));
    world.blobs.set(blob.hash, blob);
    return blob.hash;
  };
  const setText = (product: string, body: string, at: string): Editor => {
    let editor = editors.get(product);
    if (editor === undefined) {
      editor = world.editor(TWIN_DEVICE, product, clientIdOf(1, clientCounter));
      clientCounter += 1;
      editors.set(product, editor);
      last = editor.register({ at, deps: last === undefined ? [] : [last] });
    }
    const now = docText(editor.doc);
    if (body.startsWith(now)) {
      last = editor.insert(now.length, body.slice(now.length), { at, deps: [last as Written] });
    } else {
      last = editor.remove(0, now.length, { at, deps: [last as Written] });
      last = editor.insert(0, body, { at, deps: [last] });
    }
    return editor;
  };

  for (const step of SCENARIO_STEPS[scenario]) {
    const spec = PRODUCTS[step.product];
    const before = (await ledgerLines(legacy.root)).length;
    // ---- today's host -----------------------------------------------------------------------------------------------------------------------
    let result: { ok: boolean; text: string };
    const legacyHash = async (): Promise<string> => (await legacy.host.replay()).products.get(step.product)?.record.hash ?? '';
    switch (step.do) {
      case 'propose': {
        await writeBody(legacy.root, spec.section, step.product, step.body);
        const args: Record<string, unknown> = { product: step.product, kind: spec.kind, ...(step.dependsOn ? { dependsOn: step.dependsOn.map((item) => `${item.product}@${item.version}`) } : {}) };
        result = await callTool(legacy, spec.team, 'mcp__staff-products__propose', args, spec.owner);
        if (result.ok) hashIn(result.text);
        break;
      }
      case 'verdict':
        result = await callTool(legacy, spec.team, 'mcp__staff-products__verdict', { product: step.product, gate: step.gate, verdict: step.verdict, hash: await legacyHash(), ...(step.reasons ? { reasons: step.reasons } : {}) }, GATE_SEAT[step.gate]);
        break;
      case 'submit':
        result = await callTool(legacy, spec.team, 'mcp__staff-products__submit', { product: step.product, decisionFor: DECISION_ROLE, options: OPTIONS, dissent: DISSENT }, spec.owner);
        break;
      case 'withdraw':
        result = step.by === 'owner'
          ? await callTool(legacy, spec.team, 'mcp__staff-products__withdraw', { product: step.product, reason: step.reason }, spec.owner)
          : await legacy.host.decide(twinPerson(), { product: step.product, action: 'withdraw', reasons: [step.reason] }).then((value) => ({ ok: value.ok, text: value.ok ? value.text : value.message }));
        break;
      default: {
        const hash = await legacyHash();
        const input = step.do === 'reject'
          ? { product: step.product, action: 'reject' as const, reasons: step.reasons }
          : { product: step.product, action: step.do, hash, ...(step.do === 'approve' && step.release ? { releaseOnApproval: true } : {}) };
        const decided = await legacy.host.decide(twinPerson(), input);
        result = { ok: decided.ok, text: decided.ok ? decided.text : decided.message };
      }
    }
    if (!result.ok) throw new Error(`${scenario}: today's host refused ${step.do} on ${step.product}: ${result.text}`);
    const written = (await ledgerLines(legacy.root)).slice(before).map(payloadOf);
    if (written.length === 0) throw new Error(`${scenario}: ${step.do} on ${step.product} wrote no ledger line`);
    const at = written[0].at;

    // ---- the same step as replica entries ---------------------------------------------------------------------------------------------------
    switch (step.do) {
      case 'propose': {
        const line = written[0];
        if (!versionHashes.has(step.product)) {
          write('product.create', { product: step.product, section: spec.section, roles: { ...line.roles }, title: step.product }, person, at);
          versionHashes.set(step.product, []);
        }
        const editor = setText(step.product, step.body, at);
        const pins = pinsOf(step.dependsOn ?? []);
        const hash = replicaVersionHash(step.body, pins);
        const meta = line.meta!;
        write('version.propose', {
          product: step.product, hash, textBlob: blobOf(step.body, { kind: meta.kind, label: meta.label, profile: meta.profile, level: meta.level }),
          snapshot: Buffer.from(snapshotOf(editor.doc)).toString('base64url'), pins
        }, agent(spec.owner), at);
        versionHashes.get(step.product)!.push(hash);
        texts.set(hash, step.body);
        break;
      }
      case 'verdict':
        write('version.verdict', { product: step.product, hash: current(step.product), gate: step.gate, verdict: step.verdict, reasons: [...(step.reasons ?? [])] }, agent(GATE_SEAT[step.gate]), at);
        break;
      case 'submit':
        write('version.submit', { product: step.product, hash: current(step.product), decisionFor: DECISION_ROLE }, agent(spec.owner), at);
        break;
      case 'reject':
        write('version.decide', { product: step.product, hash: current(step.product), outcome: 'reject', reasons: [...step.reasons], decisionsSeen: [] }, person, at);
        break;
      case 'withdraw': {
        const seen = approvals.get(current(step.product));
        write('version.withdraw', { product: step.product, hash: current(step.product), reason: step.reason, decisionsSeen: seen ? [seen.hash] : [] }, step.by === 'owner' ? agent(spec.owner) : person, at);
        break;
      }
      case 'approve':
      case 'release': {
        const hash = current(step.product);
        if (step.do === 'approve') approvals.set(hash, write('version.decide', { product: step.product, hash, outcome: 'approve', reasons: [], decisionsSeen: [] }, person, at));
        if (step.do === 'release' || step.release === true) {
          releases.set(hash, write('version.release', { product: step.product, hash, decisionsSeen: [(approvals.get(hash) as Written).hash] }, person, at));
        }
        // A release supersedes the older released version, as today's host does in the same step (one ledger line each).
        for (const line of written.filter((entry) => entry.event.type === 'supersede')) {
          const older = (versionHashes.get(step.product) ?? [])[(line.line as number) - 1];
          write('version.supersede', { product: step.product, hash: older, byHash: hash }, person, line.at);
        }
        break;
      }
    }
  }

  const legacyFiles = new Map<string, string>();
  for (const product of versionHashes.keys()) legacyFiles.set(product, await readProductFile(legacy.root, PRODUCTS[product].section, product));
  return {
    scenario,
    legacyLines: await ledgerLines(legacy.root),
    legacyReplay: await legacy.host.replay(),
    legacyFiles,
    legacyEvents,
    replicaEntries: [...world.entries],
    ctx: world.ctx(),
    texts,
    versionHashes,
    world
  };
}
