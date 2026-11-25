// Phase 33 plan 30 (D-65, P9): the two-person world for the native acceptance test. One dev OpenBao with a person key for each of two people
// (46-08's startDevOpenBao and createPersonKeys), one hub container from the hub image with a test TLS pair and its own signing and encryption
// keys, and two workbench containers from the built image, each signed in as its own person with its own workspace folder. The hub and OpenBao sit
// only on an internal Docker network, which has no route out; each workbench joins it beside the bridge network its 127.0.0.1 port is published on
// (Docker publishes no port from an internal network), and the outbound hook records every connection a workbench makes, allowing only loopback,
// OpenBao and the hub. Memory: workbench 3g each, OpenBao 512m, hub 512m.
//
// Person A's workspace starts with a staff project made by today's single-machine host (the products ledger and one proposed product), so A shares
// existing work, as a person would; person B's starts empty. Hygiene as in docker.ts: every object carries the suite's suffix, and stop() removes
// exactly what this world made. Fictional people and exercise data only.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StaffHost } from '../../../src/staff/staffHost.ts';
import { callTool, J5_TEAM, memorySecrets, testSigner, trusting, writeBody, type StaffWorld as LegacyWorld } from '../../../src/test/helpers/staffFixtures.ts';
import { containerName, mustRun, run, runContainer, suffix, waitHealthy, workbenchRoot } from './docker';
import { startDevOpenBao, TEST_AUDIENCE, TEST_STEPUP_ACR, type DevOpenBao } from './openbao-dev';
import { makeTestCertificate, type TestCertificate } from './tls-cert';

export const STAFF_PEOPLE = {
  a: { sub: 'kc-avery-lead', email: 'avery.lead@example.test', name: 'Avery Lead' },
  b: { sub: 'kc-blake-rivers', email: 'blake.rivers@example.test', name: 'Blake Rivers' },
} as const;
export type StaffPersonKey = keyof typeof STAFF_PEOPLE;

/** The product A's staff work starts with, and its text. */
export const SEED_PRODUCT = { section: 'j5', product: 'intelligence-estimate', label: 'org/Internal' } as const;
export const SEED_BODY = '# Intelligence estimate\n\nThe enemy holds the river crossings.\n\nDECISION FOR: commander. Option A or option B, with their risk.\n';
/** A product only A is cleared for (org/Confidential), whose text carries a marker no other browser may ever receive (D-35). */
export const SECRET_PRODUCT = { section: 'j5', product: 'source-assessment', label: 'org/Confidential' } as const;
export const SECRET_MARKER = 'NORTHWIND-ONLY-AVERY-7Q2X9';
const SECRET_BODY = `# Source assessment\n\nThe source on the far bank is ${SECRET_MARKER}.\n\nDECISION FOR: commander. Option A or option B, with their risk.\n`;

const HOOK = path.join(workbenchRoot, 'test', 'helpers', 'outbound-hook.mjs');
const CA_IN_CONTAINER = '/run/sterling/openbao-ca.pem';
const HUB_ALIAS = 'staff-hub';
const HUB_SECRET_FILES = ['hub_tls_cert', 'hub_tls_key', 'hub_signing_key', 'hub_encryption_key'] as const;
/** The digest-pinned Node image the hub builds on (hub/Dockerfile's build stage), used only to give the hub's secret files to its user. */
const CHOWN_IMAGE = 'docker.io/library/node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc';

export interface SignedIn {
  /** For Playwright: the token, email and user the spec sends as headers. */
  readonly env: Record<string, string>;
  /** The three headers oauth2-proxy forwards. */
  readonly headers: Record<string, string>;
}

export interface WorldPerson {
  readonly key: StaffPersonKey;
  readonly name: string;
  readonly email: string;
  readonly entityId: string;
  /** The workbench, published on 127.0.0.1. */
  readonly url: string;
  /** The suite's short container name (containerName gives the full one). */
  readonly container: string;
  /** The host folder mounted as /home/sterling/workspace. */
  readonly workspace: string;
  /** Fresh sign-in headers; authAgeSeconds makes the sign-in that much older (the step-up window, D-60). */
  signedIn(options?: { authAgeSeconds?: number; stepUp?: boolean }): SignedIn;
}

export interface StaffWorld {
  readonly bao: DevOpenBao;
  readonly a: WorldPerson;
  readonly b: WorldPerson;
  /** The hub file your organization's server's operator gives the lead. */
  readonly hubFile: string;
  /** Everything secret the world handed out (tokens, keys, JWTs): none may reach a browser message or a log. */
  readonly secrets: string[];
  /** Stops your organization's server (both sessions go offline) and starts it again with its state. */
  stopHub(): Promise<void>;
  startHub(): Promise<void>;
  /** The logs and the outbound hook lines of a workbench, for the leak and egress checks. */
  logsOf(person: WorldPerson): Promise<{ log: string; hook: string[] }>;
  stop(): Promise<void>;
}

/** Where the world's folders go: STAFF_WORLD_DIR when set (kept for a person to look at with STAFF_WORLD_KEEP), the temporary folder otherwise. */
function worldDir(): string {
  const chosen = process.env.STAFF_WORLD_DIR?.trim();
  if (!chosen) return tmpdir();
  mkdirSync(chosen, { recursive: true });
  return chosen;
}

/** The first free port from `from` on 127.0.0.1 (the coordinator's range for this plan starts at 18900). */
async function portFrom(from: number, taken: Set<number>): Promise<number> {
  for (let port = from; port < from + 200; port += 1) {
    if (taken.has(port)) continue;
    const free = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) {
      taken.add(port);
      return port;
    }
  }
  throw new Error(`no free port on 127.0.0.1 from ${from}`);
}

/** A staff project on this computer only, as today's single-machine host writes it: the products ledger and one proposed product. */
export async function seedStaffWork(root: string): Promise<void> {
  const signer = testSigner();
  const clock = { now: Date.parse('2026-11-25T09:00:00.000Z') };
  const headStore = memorySecrets();
  const make = (): StaffHost => new StaffHost({ root, signer: async () => signer, keyStatus: async () => trusting(signer), headStore, now: () => { clock.now += 1000; return clock.now; } });
  const world: LegacyWorld = {
    root, signer, clock, host: make(), headStore,
    reload: () => { world.host = make(); return world.host; },
    person: (name = 'Avery Lead', role = 'commander') => ({ kind: 'person', name, role, deviceFingerprint: signer.fingerprint }),
  };
  for (const [seed, body] of [[SEED_PRODUCT, SEED_BODY], [SECRET_PRODUCT, SECRET_BODY]] as const) {
    await writeBody(root, seed.section, seed.product, body);
    const proposed = await callTool(world, J5_TEAM, 'mcp__staff-products__propose', { product: seed.product, kind: 'estimate', label: seed.label }, 'lead-planner');
    assert.ok(proposed.ok, `the seed product ${seed.product} was not proposed: ${proposed.text}`);
  }
}

export async function startStaffWorld(options: { image: string; hubImage: string; portsFrom?: number }): Promise<StaffWorld> {
  const secrets: string[] = [];
  const made: { networks: string[]; dirs: string[]; certs: TestCertificate[]; bao?: DevOpenBao } = { networks: [], dirs: [], certs: [] };
  const bridge = `sterling-workbench-test-${suffix}-staff`;
  const internal = `sterling-workbench-test-${suffix}-staff-internal`;
  const ports = new Set<number>();
  const stop = async (): Promise<void> => {
    for (const name of ['staff-a', 'staff-b', 'staff-hub']) await run('docker', ['rm', '-f', containerName(name)]);
    await made.bao?.stop();
    for (const network of made.networks) await run('docker', ['network', 'rm', network]);
    for (const cert of made.certs) cert.cleanup();
    for (const dir of made.dirs) rmSync(dir, { recursive: true, force: true });
  };
  try {
    await mustRun('docker', ['network', 'create', bridge]);
    made.networks.push(bridge);
    await mustRun('docker', ['network', 'create', '--internal', internal]);
    made.networks.push(internal);

    // OpenBao, only on the internal network (setup goes through its published 127.0.0.1 port).
    const bao = await startDevOpenBao({ network: internal, tls: true });
    made.bao = bao;
    secrets.push(bao.rootToken);
    const openBaoHost = new URL(bao.tlsNetworkAddr as string).hostname;

    const jwt = (key: StaffPersonKey, claims: Record<string, unknown> = {}): string => {
      const now = Math.floor(Date.now() / 1000);
      const token = bao.signer.sign({ sub: STAFF_PEOPLE[key].sub, aud: TEST_AUDIENCE, email: STAFF_PEOPLE[key].email, iat: now, exp: now + 3600, ...claims });
      secrets.push(token);
      return token;
    };
    // The first sign-in makes the person's entity; their person key and key-encryption key are made for it, as Phase 47's setup does.
    const entityOf = async (key: StaffPersonKey): Promise<string> => {
      const login = await bao.api('POST', 'auth/jwt/login', { role: 'sterling-workbench', jwt: jwt(key) });
      assert.equal(login.status, 200, `the first sign-in of ${key}: ${JSON.stringify(login.json)}`);
      const auth = (login.json as { auth: { entity_id: string; client_token: string } }).auth;
      secrets.push(auth.client_token);
      await bao.createPersonKeys(auth.entity_id);
      return auth.entity_id;
    };

    // Your organization's server: a TLS pair for its network name, its two keys, the files owned by its user, then one hub file for the lead.
    const hubCert = makeTestCertificate({ dnsNames: [HUB_ALIAS] });
    made.certs.push(hubCert);
    const hubSecrets = mkdtempSync(path.join(worldDir(), 'sterling-staff-hub-secrets-'));
    made.dirs.push(hubSecrets);
    const generated = async (kind: 'signing' | 'encryption'): Promise<string> =>
      (await mustRun('docker', ['run', '--rm', '--network', 'none', '--memory', '128m', options.hubImage, '/app/bin.mjs', '--generate-key', kind])).stdout.trim().split('\n').pop() as string;
    const signing = await generated('signing');
    const encryption = await generated('encryption');
    secrets.push(signing, encryption, ...hubCert.keyPem.split('\n').filter((line) => line.length >= 16 && !line.startsWith('-----')));
    const contents: Record<(typeof HUB_SECRET_FILES)[number], string> = {
      hub_tls_cert: hubCert.certPem, hub_tls_key: hubCert.keyPem, hub_signing_key: `${signing}\n`, hub_encryption_key: `${encryption}\n`,
    };
    for (const name of HUB_SECRET_FILES) writeFileSync(path.join(hubSecrets, name), contents[name], { mode: 0o400 });
    await mustRun('docker', ['run', '--rm', '--network', 'none', '--memory', '128m', '--user', '0:0', '--entrypoint', 'chown', '-v', `${hubSecrets}:/secrets`,
      CHOWN_IMAGE, '65532:65532', ...HUB_SECRET_FILES.map((name) => `/secrets/${name}`)]);
    const hubMounts = HUB_SECRET_FILES.flatMap((name) => ['-v', `${path.join(hubSecrets, name)}:/run/secrets/${name}:ro`]);
    const hubEnv = ['-e', `HUB_PUBLIC_ADDRESS=${HUB_ALIAS}:8443`];
    const hubStarted = await runContainer('staff-hub', ['-d', '--memory=512m', '--pids-limit', '256', '--network', internal, '--network-alias', HUB_ALIAS, ...hubMounts, ...hubEnv, options.hubImage]);
    assert.equal(hubStarted.code, 0, hubStarted.stderr);
    // The hub file is printed by the running hub, as its operator does (relay/README.md): the enrolment it carries is the running hub's own.
    const hubDeadline = Date.now() + 60_000;
    while (!/hub\.listening/.test((await run('docker', ['logs', containerName('staff-hub')])).stdout)) {
      if (Date.now() > hubDeadline) assert.fail('your organization\'s server did not start listening within 60 s');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const hubFile = (await mustRun('docker', ['exec', containerName('staff-hub'), '/nodejs/bin/node', '/app/bin.mjs', '--hub-file', '7'])).stdout.trim();
    assert.ok(hubFile.length > 0, 'the hub printed a hub file');

    const hooked = (): string[] => ['-v', `${HOOK}:/test-hook/outbound-hook.mjs:ro`, '-e', 'NODE_OPTIONS=--import=/test-hook/outbound-hook.mjs',
      '-e', 'NEAR_AI_TEST_OUTBOUND_LOG=/tmp/outbound.log', '-e', `NEAR_AI_TEST_OUTBOUND_ALLOW=127.0.0.1,::1,localhost,${openBaoHost},${HUB_ALIAS}`];
    const uid = process.getuid?.() ?? 10001;

    const person = async (key: StaffPersonKey): Promise<WorldPerson> => {
      const entityId = await entityOf(key);
      const workspace = mkdtempSync(path.join(worldDir(), `sterling-staff-${key}-`));
      made.dirs.push(workspace);
      chmodSync(workspace, 0o775);
      if (key === 'a') await seedStaffWork(workspace);
      else mkdirSync(workspace, { recursive: true });
      const port = await portFrom(options.portsFrom ?? 18900, ports);
      const name = `staff-${key}`;
      // The image is arbitrary-UID friendly (group 0 owns the home): the workbench runs as this computer's user so the mounted folder is its own.
      const started = await runContainer(name, ['-d', '--memory=3g', '--user', `${uid}:0`, '--network', bridge, '-p', `127.0.0.1:${port}:3000`, ...hooked(),
        '-v', `${workspace}:/home/sterling/workspace`, '-v', `${bao.caFile}:${CA_IN_CONTAINER}:ro`,
        '-e', `STERLING_OPENBAO_ADDR=${bao.tlsNetworkAddr}`, '-e', `STERLING_OPENBAO_CA_FILE=${CA_IN_CONTAINER}`,
        '-e', `THEIACLOUD_SESSION_USER=${STAFF_PEOPLE[key].email}`, '-e', `STERLING_STEPUP_ACR=${TEST_STEPUP_ACR}`, '-e', 'STERLING_LISTEN_HOST=0.0.0.0',
        options.image]);
      assert.equal(started.code, 0, started.stderr);
      await mustRun('docker', ['network', 'connect', internal, containerName(name)]);
      const url = `http://127.0.0.1:${port}`;
      await waitHealthy(name, url, 180_000);
      const signedIn = ({ authAgeSeconds = 0, stepUp = true }: { authAgeSeconds?: number; stepUp?: boolean } = {}): SignedIn => {
        const token = jwt(key, stepUp ? { acr: TEST_STEPUP_ACR, auth_time: Math.floor(Date.now() / 1000) - authAgeSeconds } : {});
        const { email, sub } = STAFF_PEOPLE[key];
        return {
          env: { TOKEN: token, EMAIL: email, USER: sub },
          headers: { 'X-Forwarded-Access-Token': token, 'X-Auth-Request-Email': email, 'X-Auth-Request-User': sub },
        };
      };
      // The proxy forwards the sign-in on the first page load; the session reaches active before the browser opens.
      await fetch(`${url}/`, { headers: signedIn().headers, signal: AbortSignal.timeout(15_000) }).then((response) => response.arrayBuffer());
      const deadline = Date.now() + 60_000;
      for (;;) {
        const logs = await run('docker', ['logs', containerName(name)]);
        if (/Sterling session identity: active/.test(logs.stdout + logs.stderr)) break;
        if (Date.now() > deadline) assert.fail(`${key}'s session did not reach active\n${logs.stdout.slice(-3000)}\n${logs.stderr.slice(-3000)}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return { key, name: STAFF_PEOPLE[key].name, email: STAFF_PEOPLE[key].email, entityId, url, container: name, workspace, signedIn };
    };

    const a = await person('a');
    const b = await person('b');
    return {
      bao, a, b, hubFile, secrets,
      stopHub: async () => { await mustRun('docker', ['stop', '-t', '5', containerName('staff-hub')]); },
      startHub: async () => { await mustRun('docker', ['start', containerName('staff-hub')]); },
      logsOf: async (target) => {
        const output = await run('docker', ['logs', containerName(target.container)]);
        const hook = await run('docker', ['exec', containerName(target.container), 'cat', '/tmp/outbound.log']);
        return { log: `${output.stdout}\n${output.stderr}`, hook: hook.code === 0 ? hook.stdout.split('\n').filter(Boolean) : [] };
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
