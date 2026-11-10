import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_RULES } from '../agent/permissions';
import { checkDraft, draftFromMarkdown, teamMarkdown } from '../agent/teamMarkdown';
import { parseTeam, renderTeam, teamAgents } from '../agent/teams';
import { privateModelFor, tierOf } from '../gsd/library';
import { isNearCloudEndpoint } from '../domain/config';
import { privateRouteFor } from '../services/providerCache';
import { AgentConversation, GsdContext, routeAllows, type PrivateRoute } from '../services/agentSession';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';

// A team member marked `privacy: private` runs only on a model in a NEAR TEE or on this machine:
// the most capable private model for its tier, and never a forwarded one, even when that is all
// there is.

const TIERS = { deep: 'cloud/frontier', standard: 'tee/glm', fast: 'tee/flash' };
const CATALOG = [
  { id: 'cloud/frontier', privacyBoundary: 'cloud', outputPricePerMillion: 30 },
  { id: 'tee/glm', privacyBoundary: 'tee', outputPricePerMillion: 2 },
  { id: 'tee/flash', privacyBoundary: 'tee', outputPricePerMillion: 0.5 },
  { id: 'tee/kimi', privacyBoundary: 'tee', outputPricePerMillion: 3 },
  { id: 'local/llama', privacyBoundary: 'local' },
  { id: 'tee/embed-large', privacyBoundary: 'tee', outputPricePerMillion: 50 }
];

test('a private member resolves to a TEE or local model for its tier, never a forwarded one', () => {
  assert.equal(tierOf('deep'), 'deep');
  assert.equal(tierOf('opus'), 'deep');
  assert.equal(tierOf('fast'), 'fast');
  assert.equal(tierOf('z-ai/glm-5.3'), undefined);
  assert.equal(privateModelFor('tee/kimi', 'deep', TIERS, CATALOG), 'tee/kimi', 'a private wanted model is kept');
  assert.equal(privateModelFor('cloud/frontier', 'deep', TIERS, CATALOG), 'tee/glm', 'deep falls to the next configured tier that is private');
  assert.equal(privateModelFor('cloud/frontier', 'fast', TIERS, CATALOG), 'tee/flash');
  const noPrivateTiers = { deep: 'cloud/frontier', standard: 'cloud/frontier', fast: 'cloud/frontier' };
  assert.equal(privateModelFor('cloud/frontier', 'deep', noPrivateTiers, CATALOG), 'tee/kimi', 'then the most capable private chat model (an embedding model is not one)');
  assert.equal(privateModelFor('cloud/frontier', 'deep', noPrivateTiers, CATALOG.filter((model) => model.privacyBoundary !== 'tee')), 'local/llama', 'a local model counts as private');
  assert.equal(privateModelFor('cloud/frontier', 'deep', noPrivateTiers, CATALOG.filter((model) => model.privacyBoundary === 'cloud')), undefined, 'no private model: no answer, never the forwarded one');
  assert.equal(privateModelFor('unknown/model', 'deep', noPrivateTiers, [{ id: 'unknown/model' }]), undefined, 'a model of unknown privacy is not private');
});

test('the privacy line parses, renders, survives the studio round trip, and reaches the sub-agent definition', () => {
  const text = renderTeam('Research', 'Reports', [
    { name: 'editor', role: 'reviewer', model: 'deep', privacy: 'private', tools: ['Read'], instructions: 'Edit.' },
    { name: 'writer', role: 'implementer', instructions: 'Write.' }
  ]);
  assert.match(text, /## editor\nrole: reviewer\nmodel: deep\ntools: Read\nprivacy: private\n/, 'privacy is the last metadata line');
  const team = parseTeam(text, '/tmp/research.md');
  assert.equal(team.members[0].privacy, 'private');
  assert.equal(team.members[1].privacy, undefined);
  assert.equal(teamAgents(team)[0].privacy, 'private');
  assert.equal(teamAgents(team)[1].privacy, undefined);
  assert.equal(parseTeam(text.replace('privacy: private', 'privacy: tee'), 'x.md').members[0].privacy, 'private');
  const handEdited = text.replace('tools: Read\nprivacy: private\n', 'privacy: private\ntools: Read\n');
  assert.notEqual(handEdited, text);
  assert.deepEqual([parseTeam(handEdited, 'x.md').members[0].privacy, parseTeam(handEdited, 'x.md').members[0].tools], ['private', ['Read']], 'privacy is read in any metadata position');
  assert.equal(parseTeam(text.replace('privacy: private', 'privacy: any'), 'x.md').members[0].privacy, undefined, 'privacy: any opts out');
  assert.throws(() => parseTeam(text.replace('privacy: private', 'privacy: secret'), 'x.md'), /Member editor has "privacy: secret"; use privacy: private/);
  const draft = draftFromMarkdown(text, '/tmp/research.md');
  assert.equal(draft.members[0].privacy, 'private');
  assert.equal(teamMarkdown(draft, text), text, 'an unchanged draft saves byte for byte');
  assert.deepEqual(checkDraft(draft, text).errors, []);
  const changed = { ...draft, members: draft.members.map((member, index) => (index === 0 ? { ...member, instructions: 'Edit carefully.' } : member)) };
  assert.match(teamMarkdown(changed, text), /## editor\nrole: reviewer\nmodel: deep\ntools: Read\nprivacy: private\n\nEdit carefully\./, 'an edited member keeps its privacy line');
  const deck = { ...draft, members: draft.members.map((member, index) => (index === 1 ? { ...member, tools: ['Read', 'CreatePresentation'] } : member)) };
  assert.deepEqual(checkDraft(deck, text).errors, [], 'a member given CreatePresentation reads back with the document tools added, and that is not a mismatch');
});

test('a run puts a private member on a private model, and refuses it clearly when there is none', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-private-'));
  const home = await mkdtemp(path.join(tmpdir(), 'near-ai-private-gsd-'));
  await mkdir(path.join(home, 'gsd-core'), { recursive: true });
  const teamFile = path.join(root, '.planning', '.near-ai', 'team.md');
  const member = (name: string, privacy?: 'private') => ({ name, description: name, tools: ['Read'], body: `You are ${name}.`, file: teamFile, model: 'deep', ...(privacy ? { privacy } : {}) });
  const gsd: GsdContext = { home, skills: [], shellEnv: {}, agents: [member('editor', 'private'), member('writer')] };
  const call = (id: string, type: string): ToolCall => ({ id, type: 'function', function: { name: 'Agent', arguments: JSON.stringify({ subagent_type: type, prompt: 'go' }) } });
  const modelsUsed = new Map<string, string>();
  const toolResults: string[] = [];
  const near = {
    async *streamCompletion(model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const usage = { verificationStatus: 'unknown' as const, latencyMs: 1 };
      const who = /^You are ([\w-]+)\./.exec(String(messages[0].content))?.[1];
      if (who) { modelsUsed.set(who, model); yield { type: 'done', message: { role: 'assistant', content: 'done' }, finishReason: 'stop', usage }; return; }
      if (!messages.some((message) => message.role === 'tool')) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('a1', 'editor'), call('a2', 'writer')] }, finishReason: 'tool_calls', usage }; return; }
      toolResults.push(...messages.filter((message) => message.role === 'tool').map((message) => String(message.content)));
      yield { type: 'done', message: { role: 'assistant', content: 'all done' }, finishReason: 'stop', usage };
    },
    async actualCostsUsd() { return undefined; }
  };
  const send = async (catalog: typeof CATALOG, route: PrivateRoute | undefined = { kind: 'near', attestation: true }, model = 'cloud/frontier') => {
    modelsUsed.clear();
    toolResults.length = 0;
    const conversation = new AgentConversation(root, () => undefined, path.join(root, '.ckpt'));
    try {
      await conversation.send({ text: 'go', client: near as never, model, privacy: 'Not private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, gsd, tiers: TIERS, availableModels: catalog.map((entry) => entry.id), modelCatalog: catalog, ...(route ? { route } : {}) });
    } finally {
      conversation.dispose();
    }
    return Object.fromEntries(modelsUsed);
  };
  assert.deepEqual(await send(CATALOG), { editor: 'tee/glm', writer: 'cloud/frontier' }, 'the private editor moves to the private standard-tier model; the writer keeps the deep tier');
  const forwardedOnly = CATALOG.filter((model) => model.privacyBoundary === 'cloud');
  assert.deepEqual(await send(forwardedOnly), { writer: 'cloud/frontier' }, 'the private editor never runs on a forwarded model');
  assert.ok(toolResults.some((result) => /editor must run on a private model \(its team file says privacy: private\), and none of the models this run may use runs in a NEAR TEE or on this machine\. Choose a NEAR TEE model for the deep tier \(setting nearAi\.agent\.deepModel\)/.test(result)), toolResults.join('\n'));
});

test('a private member only runs on a model that is private on the run\'s own route, and fails closed otherwise', async () => {
  // The rule itself.
  const near = { kind: 'near' as const, attestation: true };
  const local = { kind: 'local' as const, attestation: false };
  assert.equal(routeAllows(near, { privacyBoundary: 'tee' }), true);
  assert.equal(routeAllows(near, { privacyBoundary: 'local' }), false, 'a local catalog entry is never sent to the NEAR client');
  assert.equal(routeAllows(near, { privacyBoundary: 'cloud' }), false);
  assert.equal(routeAllows({ kind: 'near', attestation: false }, { privacyBoundary: 'tee' }), false, 'no TEE without checkable attestation');
  assert.equal(routeAllows(local, { privacyBoundary: 'local' }), true);
  assert.equal(routeAllows(local, { privacyBoundary: 'tee' }), false, 'a TEE entry is never sent to a local runtime');
  assert.equal(routeAllows(undefined, { privacyBoundary: 'tee' }), false, 'no route, no private model');
  assert.equal(routeAllows(near, undefined), false);

  // Through a real run.
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-route-'));
  const home = await mkdtemp(path.join(tmpdir(), 'near-ai-route-gsd-'));
  await mkdir(path.join(home, 'gsd-core'), { recursive: true });
  const teamFile = path.join(root, '.planning', '.near-ai', 'team.md');
  const gsd: GsdContext = { home, skills: [], shellEnv: {}, agents: [{ name: 'editor', description: 'editor', tools: ['Read'], body: 'You are editor.', file: teamFile, model: 'deep', privacy: 'private' }] };
  const used: string[] = [];
  const results: string[] = [];
  const client = {
    async *streamCompletion(model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const usage = { verificationStatus: 'unknown' as const, latencyMs: 1 };
      if (String(messages[0].content).startsWith('You are editor.')) { used.push(model); yield { type: 'done', message: { role: 'assistant', content: 'done' }, finishReason: 'stop', usage }; return; }
      if (!messages.some((message) => message.role === 'tool')) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [{ id: 'a1', type: 'function', function: { name: 'Agent', arguments: JSON.stringify({ subagent_type: 'editor', prompt: 'go' }) } }] }, finishReason: 'tool_calls', usage }; return; }
      results.push(...messages.filter((message) => message.role === 'tool').map((message) => String(message.content)));
      yield { type: 'done', message: { role: 'assistant', content: 'all done' }, finishReason: 'stop', usage };
    },
    async actualCostsUsd() { return undefined; }
  };
  const run = async (catalog: Array<{ id: string; privacyBoundary: string; outputPricePerMillion?: number }>, route: PrivateRoute | undefined, model: string) => {
    used.length = 0; results.length = 0;
    const conversation = new AgentConversation(root, () => undefined, path.join(root, '.ckpt'));
    try {
      await conversation.send({ text: 'go', client: client as never, model, privacy: 'x', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, gsd, tiers: { deep: 'tee/kimi', standard: 'tee/glm', fast: 'tee/glm' }, availableModels: catalog.map((entry) => entry.id), modelCatalog: catalog, ...(route ? { route } : {}) });
    } finally { conversation.dispose(); }
    return { used: [...used], results: results.join('\n') };
  };
  // Mismatch 1: a local entry in a NEAR run (even the "most capable" one) is never used; the TEE model is.
  const mixed = [{ id: 'local/big', privacyBoundary: 'local', outputPricePerMillion: 99 }, { id: 'tee/kimi', privacyBoundary: 'tee', outputPricePerMillion: 3 }, { id: 'cloud/x', privacyBoundary: 'cloud' }];
  assert.deepEqual((await run(mixed, near, 'cloud/x')).used, ['tee/kimi']);
  const onlyLocal = await run([{ id: 'local/big', privacyBoundary: 'local' }, { id: 'cloud/x', privacyBoundary: 'cloud' }], near, 'cloud/x');
  assert.deepEqual(onlyLocal.used, [], 'a NEAR run with only a local private entry refuses');
  assert.match(onlyLocal.results, /editor must run on a private model[\s\S]*none of the models this run may use runs in a NEAR TEE/);
  // Mismatch 2: a TEE entry in a local run is never used, even when the deep tier names it; the local model is.
  assert.deepEqual((await run(mixed, local, 'local/big')).used, ['local/big']);
  const onlyTee = await run([{ id: 'tee/kimi', privacyBoundary: 'tee' }], local, 'tee/kimi');
  assert.deepEqual(onlyTee.used, [], 'a local run never sends a private member to a TEE entry');
  assert.match(onlyTee.results, /This run uses your local runtime/);
  // No attestation (another endpoint claiming TEE), or no route at all: refused.
  const unattested = await run(mixed, { kind: 'near', attestation: false }, 'cloud/x');
  assert.deepEqual(unattested.used, []);
  assert.match(unattested.results, /not NEAR AI Cloud, so a TEE model's attestation cannot be checked/);
  const unknown = await run(mixed, undefined, 'cloud/x');
  assert.deepEqual(unknown.used, []);
  assert.match(unknown.results, /did not say which route it uses/);
});

test('the run\'s route counts as attested NEAR for every spelling of NEAR\'s own endpoint, and for nothing else', () => {
  const near = (baseUrl: string) => privateRouteFor({ provider: 'near-ai', baseUrl }, false);
  for (const baseUrl of ['', '   ', 'https://cloud-api.near.ai/v1', 'https://cloud-api.near.ai/v1/', 'https://cloud-api.near.ai', 'https://cloud-api.near.ai/', 'https://CLOUD-API.near.ai:443/v1//']) {
    assert.deepEqual(near(baseUrl), { kind: 'near', attestation: true }, JSON.stringify(baseUrl));
  }
  for (const baseUrl of ['https://proxy.example.com/v1', 'http://cloud-api.near.ai/v1', 'https://cloud-api.near.ai.evil.example/v1', 'https://cloud-api.near.ai:8443/v1', 'https://cloud-api.near.ai/other', 'https://user:pass@cloud-api.near.ai/v1', 'not a url']) {
    assert.deepEqual(near(baseUrl), { kind: 'near', attestation: false }, `${baseUrl} is not attested`);
  }
  assert.deepEqual(privateRouteFor({ provider: 'local', baseUrl: 'http://localhost:11434/v1' }, false), { kind: 'local', attestation: false }, 'a local runtime is not NEAR');
  assert.deepEqual(privateRouteFor({ provider: 'hybrid', baseUrl: '' }, true), { kind: 'local', attestation: false }, 'a hybrid run on its local model is local');
  assert.deepEqual(privateRouteFor({ provider: 'hybrid', baseUrl: '' }, false), { kind: 'near', attestation: true });
  assert.equal(isNearCloudEndpoint(undefined), true);
});
