// Phase 74.1-03 Task 2 (D-13): the editor-side callers say what kind of use their requests are. The routes each caller builds are tested through the
// helper in its own file, loaded under the vscode stand-in. No network, no model, no key.
import assert from 'node:assert/strict';
import test from 'node:test';
import { withSessionRoute } from '../gate/sessionMark';
import type { SessionRoute } from '../gate/sessionMark';
import { routeFactsFor } from '../services/privateRoute';
import { testGateHost, testGateRuntime } from './helpers/gatedRuns';
import { FIXED_NOW } from './helpers/policyFixtures';
import { createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
// Loaded after the stub: these modules import vscode.
const chat = require('../services/chat') as typeof import('../services/chat');
const participant = require('../services/chatParticipant') as typeof import('../services/chatParticipant');
const studio = require('../services/teamStudioPanel') as typeof import('../services/teamStudioPanel');
test.after(() => { uninstall(); });

const NEAR = 'https://cloud-api.near.ai/v1';
const INPUT = {
  clientRoute: 'near' as const, host: NEAR, info: { id: 'openai/gpt-oss-120b', privacyBoundary: 'tee' as const }, attestation: 'unproven' as const,
  fact: { state: 'unknown' as const, host: NEAR }, now: FIXED_NOW, localModelAvailable: false, sessionless: false
};
const useIn = (route: SessionRoute): string | undefined => withSessionRoute(route, () => routeFactsFor(INPUT).use);

test('D-13: the chat participant\'s request is chat you review', () => {
  assert.equal(useIn(participant.participantRoute(testGateRuntime({ context: 'interactive' }))), 'T1');
});

test('D-13: Team Studio AI\'s text and image requests write the team\'s files, so they are agent work', () => {
  const route = studio.teamStudioRoute(testGateRuntime({ context: 'interactive' }));
  assert.equal(useIn(route), 'T2');
  assert.equal(route.useOf?.().writesFiles, true);
});

test('D-13: an attachment read for a chat takes the chat run\'s use (agent work), with the chat\'s attestation', async () => {
  const attestation = { failed: false };
  const route = await chat.attachmentRoute({ root: '/example/projects/northern-example', conversationId: 'conversation-1', gateHost: testGateHost(), attestation });
  assert.equal(useIn(route), 'T2');
  assert.equal(route.useOf?.().inherited, 'T2');
  assert.equal(route.attestation, attestation);
});

test('D-13: without a gate host every caller is decided with the default route, which says nothing about its use', async () => {
  for (const route of [participant.participantRoute(undefined), studio.teamStudioRoute(undefined), await chat.attachmentRoute({ root: '/example/projects/a', conversationId: 'c' })]) {
    assert.equal(route.useOf, undefined);
    assert.equal(withSessionRoute(route, () => routeFactsFor(INPUT).use), 'T1');
  }
});
