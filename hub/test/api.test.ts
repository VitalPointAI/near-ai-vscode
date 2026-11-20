import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readGrant } from '@ext/domain/replica/cellKeys';
import { entryHash } from '@ext/domain/replica/entry';
import type { EntryHeader } from '@ext/domain/replica/entry';
import { buildSessionAnswer, certPinOf, readHubFile } from '@ext/domain/replica/hubFile';
import { canonicalize } from '@ext/domain/team/canonical';
import { hubIdentityOf, issueHubFile } from '../src/enrol';
import { generateKeyFile, readEncryptionKey, readSigningKey } from '../src/keys';
import { LIMITS } from '../src/limits';
import { HubConnection } from './helpers/hubClient';
import type { HubResponse } from './helpers/hubClient';
import { withHub } from './helpers/hubHarness';
import type { Hub, OpenedSession } from './helpers/hubHarness';
import { launchHub, startHubProcess, within } from './helpers/hubProcess';
import { HUB_ADDRESS, createHubWorld } from './helpers/hubWorld';
import type { HubWorld, WorldDevice, Written } from './helpers/hubWorld';
import { makeTlsFixture } from './helpers/tlsFixture';

// Phase 32, plan 20 (D-34 to D-36, D-39, D-41, D-44, D-69): the hub's HTTP protocol, first half. A lead enrols a project over HTTPS, opens a session
// bound to its own TLS connection, appends, catches up, and moves blobs; every limit and access rule is checked through the real routes on a real
// TLS server. All names and data are fictional.

const note = (world: HubWorld, device: WorldDevice, extra: { stream?: string; text?: string } = {}): Written =>
  world.write(device, { kind: 'note.add', data: { text: extra.text ?? 'Fictional note' }, ...(extra.stream === undefined ? {} : { stream: extra.stream }) });

test('tracer: the lead enrols over HTTPS, opens a session bound to its connection, appends one entry and reads it back', () =>
  withHub({}, async (hub) => {
    const world = createHubWorld();
    world.admitHub(hub.identity);

    const enrolled = await hub.enrolProject(world);
    assert.ok(enrolled !== undefined);
    assert.equal(enrolled.status, 201, enrolled.text);
    assert.deepEqual(enrolled.json(), { project: world.project, rosterHead: world.head, hub: hub.identity.hub });

    // The client refuses a hub whose certificate pin is not the one it expects.
    await assert.rejects(HubConnection.open(hub.port, '0'.repeat(64)), /pin/);

    const session = await hub.openSession(world.lead, world.project);
    assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(session.project, world.project);

    const written = note(world, world.lead);
    const appended = await session.connection.post(`/v1/projects/${world.project}/append`, { entries: [written.entry] }, session.token);
    assert.equal(appended.status, 200, appended.text);
    assert.deepEqual(appended.json(), { project: world.project, accepted: [written.hash], refused: [], rosterHead: world.head });

    const heads = await session.connection.get(`/v1/projects/${world.project}/heads`, session.token);
    assert.equal(heads.status, 200, heads.text);
    const headBody = heads.json<{ project: string; rosterHead: string; streams: Array<{ stream: string; heads: Array<{ writer: string; seq: number; hash: string }> }>; grants: string[] }>();
    assert.equal(headBody.project, world.project);
    assert.equal(headBody.rosterHead, world.head);
    const base = headBody.streams.find((item) => item.stream === world.project);
    assert.ok(base !== undefined);
    assert.deepEqual(base.heads.find((item) => item.writer === world.lead.writer), { writer: world.lead.writer, seq: written.seq, hash: written.hash });

    const from = written.seq;
    const read = await session.connection.get(`/v1/projects/${world.project}/entries?stream=${world.project}&writer=${world.lead.writer}&from=${from}`, session.token);
    assert.equal(read.status, 200, read.text);
    const page = read.json<{ project: string; stream: string; writer: string; entries: unknown[]; more: boolean; head: unknown }>();
    assert.equal(page.project, world.project);
    assert.equal(page.stream, world.project);
    assert.equal(page.writer, world.lead.writer);
    assert.deepEqual(page.entries, [written.entry]);
    assert.equal(page.more, false);
    assert.deepEqual(page.head, { seq: written.seq, hash: written.hash });

    // The hook for 32-21 ran after COMMIT with the accepted entry.
    assert.deepEqual(hub.accepted, [{ project: world.project, accepted: [written.hash], rosterChanged: false }]);
  }));
