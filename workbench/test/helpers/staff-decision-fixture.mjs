// Test-only use of the live backend. The socket serves fixed fixture operations and never returns product text or signing material.
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module';

if (process.argv[1] === '/app/bin/start.mjs') await startFixture();

async function startFixture() {
  const side = process.env.STAFF_DECISION_SIDE;
  if (side !== 'a' && side !== 'b') throw new Error('The decision fixture needs one of its two test sides.');
  const { StaffLiveEngine } = await import('/app/extension/lib/node/staff/staff-live-engine.js');
  const { VersionActs, memberAt } = createRequire(import.meta.url)('/app/engine/staff.cjs');
  const ROOT = '/home/sterling/workspace';
  const PRODUCT = 'intelligence-estimate';
  const ROLE = 'decision_for:commander';
  let engine;
  let isolated = false;
  const sockets = new Set();
  const observe = (live, root) => { if (path.resolve(root) === ROOT) engine = live; };
  const startRoot = StaffLiveEngine.prototype.startRoot;
  StaffLiveEngine.prototype.startRoot = function (root) {
    observe(this, root);
    return startRoot.call(this, root);
  };
  // The production build inlines the compiled class into the backend bundle. Observe the same method there without editing an image file.
  const capture = 'sterling.staff.fixture.capture';
  globalThis[Symbol.for(capture)] = observe;
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (url !== 'file:///app/lib/backend/main.js') return loaded;
      const source = loaded.source == null ? readFileSync(new URL(url), 'utf8') : Buffer.from(loaded.source).toString('utf8');
      const method = /\basync startRoot\(([$\w]+)\)\{(?=let\{engine:)/g;
      if ([...source.matchAll(method)].length !== 1) throw new Error('The built backend must contain one StaffLiveEngine.startRoot for the fixture.');
      return {
        ...loaded,
        source: source.replace(method, (start, root) => `${start}globalThis[Symbol.for(${JSON.stringify(capture)})](this,${root});`),
      };
    },
  });

  if (side === 'a') {
    const connect = tls.connect;
    tls.connect = function (...args) {
      const options = args[0];
      if (options?.host !== 'staff-hub' || Number(options.port) !== 8443) return connect.apply(this, args);
      if (isolated) {
        const socket = new tls.TLSSocket();
        queueMicrotask(() => socket.destroy(new Error('Fixture hub partition')));
        return socket;
      }
      const socket = connect.apply(this, args);
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      return socket;
    };
    syncBuiltinESMExports();
  }

  const requireFixture = (condition, stage) => {
    if (!condition) throw new FixtureFailure(stage);
  };
  const recordOf = (roster, member) => memberAt(roster.members, member, roster.positions.length - 1);
  const peopleOf = (roster) => {
    const lead = recordOf(roster, roster.anchor.lead.member);
    const peer = [...roster.members.members.keys()].map((member) => recordOf(roster, member)).find((entry) => entry?.name === 'Blake Rivers');
    return { a: lead, b: peer };
  };
  const productOf = (fold) => fold.families.versions?.find((item) => item.product === PRODUCT);
  const seatsOf = (product) => [product.roles.releaseGuard, product.roles.tradecraftReviewer].filter(Boolean);

  async function state(shared) {
    if (shared === undefined) return { ready: false, versions: [] };
    const { roster, fold } = await shared.project.state();
    const product = productOf(fold);
    if (product === undefined) return { ready: false, versions: [] };
    const people = peopleOf(roster);
    const ready = Object.values(people).every((member) => member?.roles.includes(ROLE)) &&
      seatsOf(product).every((seat) => people.a.agentSeats.includes(seat));
    const personOf = (act) => {
      const position = roster.positionOf.get(act.roster);
      const device = roster.members.devices.get(act.writer)?.find(({ from, until }) => from <= position && (until === undefined || position < until));
      if (device?.kind !== 'person' || act.actor.kind !== 'person' || device.member !== act.member) return null;
      return Object.keys(people).find((key) => people[key]?.member === device.member) ?? null;
    };
    return {
      ready,
      versions: product.versions.map(({ hash, number, state, decision }) => ({
        hash, number, state, status: decision.status, effective: decision.effective, contested: decision.contested,
        decisions: (product.records.find((version) => version.hash === hash)?.acts ?? [])
          .filter((act) => act.kind === 'version.decide').map((act) => ({
            hash: act.entry, person: personOf(act), outcome: act.data.outcome, seen: act.data.decisionsSeen,
          })).sort((a, b) => a.hash.localeCompare(b.hash)),
      })),
    };
  }

  async function command(name) {
    const row = engine?.projects().find((item) => path.resolve(item.root) === ROOT);
    const shared = row === undefined ? undefined : engine.shared(row.project);
    if (name === 'state') return state(shared);
    requireFixture(side === 'a' && engine !== undefined, 'live engine captured the workspace');
    requireFixture(shared !== undefined, 'lead project is open');
    if (name === 'isolate' || name === 'reconnect') {
      isolated = name === 'isolate';
      if (isolated) for (const socket of sockets) socket.destroy();
      return { ready: true, versions: [] };
    }
    const { project, deps } = shared;
    const { roster, fold } = await project.state();
    let product = productOf(fold);
    requireFixture(product !== undefined, 'fixture product is visible');
    if (name === 'roster') {
      const people = peopleOf(roster);
      for (const [key, member] of Object.entries(people)) {
        requireFixture(member !== undefined, 'fixture people are admitted');
        const roles = [...new Set([...member.roles.filter((role) => role !== 'staff_lead' && role !== 'deputy_lead'), ROLE])];
        const agentSeats = key === 'a' ? [...new Set([...member.agentSeats, ...seatsOf(product)])] : undefined;
        const written = await project.appendOwn('member.update', {
          member: member.member, roles, ...(agentSeats === undefined ? {} : { name: 'Avery Lead', agentSeats }),
        });
        requireFixture('ok' in written, 'person signed a roster change');
        requireFixture((await project.state()).roster.positionOf.has(written.hash), 'roster change folded');
      }
    } else {
      const number = { 'clear-1': 1, 'prepare-2': 2, 'propose-3': 3, 'prepare-4': 4 }[name];
      requireFixture(typeof number === 'number', 'fixed fixture operation');
      if (number > 1) {
        const proposed = await new VersionActs(project, { kind: 'person' }, { deps }).propose({ product: PRODUCT });
        requireFixture(proposed.ok, `v${number} proposal (${proposed.reason ?? 'written'})`);
        product = productOf((await project.state()).fold);
        requireFixture(product?.versions.some((version) => version.hash === proposed.version && version.number === number), 'the exact proposal folded');
      }
      const version = product.versions.find((version) => version.number === number);
      requireFixture(version !== undefined, 'the exact fixture version exists');
      if (name !== 'propose-3') {
        const verdict = async (member, gate, verdict) => {
          const acts = new VersionActs(project, { kind: 'agent', member, run: 'staff-fixture-review' });
          const outcome = await acts.verdict({ product: PRODUCT, hash: version.hash, gate, verdict, reasons: [] });
          requireFixture(outcome.ok, `v${number} ${gate} verdict (${outcome.reason ?? 'written'})`);
          requireFixture((await project.state()).fold.applied.includes(outcome.hash), 'the signed verdict folded');
        };
        if (product.roles.tradecraftReviewer !== undefined) await verdict(product.roles.tradecraftReviewer, 'tradecraft', 'SIGN-OFF');
        await verdict(product.roles.releaseGuard, 'guard', 'CLEARED');
      }
    }
    engine.localAppended(row.project);
    return state(shared);
  }

  let pending = Promise.resolve();
  const server = net.createServer((socket) => {
    socket.setTimeout(30_000, () => socket.destroy());
    socket.on('error', () => undefined);
    let input = '';
    socket.on('data', (bytes) => {
      input += bytes.toString('utf8');
      if (input.length > 64) { socket.destroy(); return; }
      if (!input.endsWith('\n')) return;
      socket.pause();
      pending = pending.then(async () => {
        try { socket.end(JSON.stringify(await command(input.trim()))); }
        catch (error) {
          socket.end(JSON.stringify({ error: error instanceof FixtureFailure ? error.message : 'decision fixture operation failed' }));
        }
      });
    });
  });
  server.listen('/run/staff-fixture/control.sock');
  server.unref();
}

class FixtureFailure extends Error {}
