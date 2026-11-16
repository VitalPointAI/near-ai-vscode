import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { DEFAULT_RULES } from '../agent/permissions';
import { checkDraft, draftFromMarkdown, teamMarkdown, type TeamDraft } from '../agent/teamMarkdown';
import { parseTeam, renderTeam, TeamLibrary, teamAgents, teamIsPrivate } from '../agent/teams';
import type { PrivateRoute } from '../services/agentSession';
import type { ModelInfo } from '../services/nearAiClient';
import { chooseTeamModel } from '../services/teamStudioAi';
import { buildStudioContext, parseDraft, parseStudioMessage, reviewDraft } from '../services/teamStudioPage';
import type { DirectoryInput } from '../services/toolsDirectory';

// 0.4.27 (owner, 2026-11-16): a team can be marked private. A private team (marked, or every member private) runs each member only on a private model,
// and Team Studio sends it only to a private model: a NEAR TEE model on an attested route, or a local model.

const FILE = `---
name: Clients
description: Works on client files
owner: ops
---

<!-- kept as written -->
## analyst
role: analyst
tools: Read, Write

Read the files. Write the summary to the file the task names.

## writer
role: writer
privacy: private

Write the brief from the summary. Report where it is.
`;

test('privacy: private in the frontmatter marks the team private; any, tee and local read as they do for a member; anything else says what to fix', () => {
  assert.equal(parseTeam(FILE, 'clients.md').private, undefined);
  assert.equal(parseTeam(FILE.replace('owner: ops', 'owner: ops\nprivacy: private'), 'clients.md').private, true);
  assert.equal(parseTeam(FILE.replace('owner: ops', 'owner: ops\nprivacy: tee'), 'clients.md').private, true);
  assert.equal(parseTeam(FILE.replace('owner: ops', 'owner: ops\nprivacy: any'), 'clients.md').private, undefined);
  assert.throws(() => parseTeam(FILE.replace('owner: ops', 'owner: ops\nprivacy: secret'), 'clients.md'), /The team has "privacy: secret" in its frontmatter; use privacy: private/);
  const rendered = renderTeam('Clients', 'Works', [{ name: 'a', instructions: 'Do it. Report it.' }], { private: true });
  assert.match(rendered, /^---\nname: Clients\ndescription: Works\nprivacy: private\n---\n/);
  assert.equal(parseTeam(rendered, 'clients.md').private, true);
});

test('a team counts as private when marked, or when every member is private', () => {
  const team = parseTeam(FILE, 'clients.md');
  assert.equal(teamIsPrivate(team), false, 'one private member does not make the team private');
  assert.equal(teamIsPrivate({ members: team.members.map((member) => ({ ...member, privacy: 'private' as const })) }), true);
  assert.equal(teamIsPrivate({ private: true, members: team.members }), true);
  assert.equal(teamIsPrivate({ members: [] }), false);
});

test('a run of a private team keeps every member on a private model', () => {
  const plain = teamAgents(parseTeam(FILE, 'clients.md'));
  assert.deepEqual(plain.map((agent) => agent.privacy), [undefined, 'private']);
  const marked = teamAgents(parseTeam(FILE.replace('owner: ops', 'owner: ops\nprivacy: private'), 'clients.md'));
  assert.deepEqual(marked.map((agent) => agent.privacy), ['private', 'private']);
});

test('the studio reads, toggles and saves the marking, keeping everything else byte for byte', () => {
  const draft = draftFromMarkdown(FILE, 'clients.md');
  assert.equal(draft.private, undefined);
  const marked = teamMarkdown({ ...draft, private: true }, FILE);
  assert.equal(marked, FILE.replace('description: Works on client files\n', 'description: Works on client files\nprivacy: private\n'), 'one line added after the description');
  assert.deepEqual(checkDraft({ ...draft, private: true }, FILE).errors, []);
  assert.equal(draftFromMarkdown(marked, 'clients.md').private, true);
  // Turning it off removes the line; a privacy: any line the person wrote is left alone.
  assert.equal(teamMarkdown(draft, marked), FILE);
  const any = FILE.replace('owner: ops', 'owner: ops\nprivacy: any');
  assert.equal(teamMarkdown(draftFromMarkdown(any, 'clients.md'), any), any);
  // A file that already says tee is private, so saving it unchanged rewrites nothing.
  const tee = FILE.replace('owner: ops', 'owner: ops\nprivacy: tee');
  assert.equal(teamMarkdown(draftFromMarkdown(tee, 'clients.md'), tee), tee);
  // A new team is exactly what renderTeam writes.
  assert.equal(teamMarkdown({ ...draft, private: true }), renderTeam('Clients', 'Works on client files', [
    { name: 'analyst', role: 'analyst', tools: ['Read', 'Write'], instructions: 'Read the files. Write the summary to the file the task names.' },
    { name: 'writer', role: 'writer', privacy: 'private', instructions: 'Write the brief from the summary. Report where it is.' }
  ], { private: true }));
});

test('page messages carry the marking as true or not at all', () => {
  const draft: TeamDraft = { name: 'T', description: '', members: [{ name: 'a', role: '', model: '', tools: null, instructions: 'x' }] };
  assert.equal(parseDraft({ ...draft, private: true })?.private, true);
  assert.equal(parseDraft(draft)?.private, undefined);
  assert.equal(parseDraft({ ...draft, private: false }), undefined);
  assert.equal(parseDraft({ ...draft, private: 'yes' }), undefined);
  assert.deepEqual(parseStudioMessage({ type: 'draft-team', idea: 'A team', private: true }), { type: 'draft-team', idea: 'A team', private: true });
  assert.equal(parseStudioMessage({ type: 'draft-team', idea: 'A team', private: 'yes' }), undefined);
  assert.equal(parseStudioMessage({ type: 'draft-team', idea: 'A team', model: 'deepseek/flash' }), undefined, 'exact keys');
});

test('duplicating a private team keeps it private', async () => {
  const library = new TeamLibrary(await mkdtemp(path.join(tmpdir(), 'near-ai-privacy-')));
  const file = await library.create('Clients', FILE.replace('owner: ops', 'privacy: private'));
  const copy = await library.duplicate(file, 'Clients copy');
  assert.equal(parseTeam(await readFile(copy, 'utf8'), copy).private, true);
});

test('the studio warns when a private team or member names a model that is not private', () => {
  const input: DirectoryInput = {
    gsd: { version: '1', skills: [], agents: [] }, teams: [], policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, webSearch: false, securityConsented: true, mcp: [],
    models: [{ id: 'z-ai/glm-5.3', privacyBoundary: 'tee' }, { id: 'deepseek/flash', privacyBoundary: 'cloud', forwardedTo: 'openrouter.ai' }],
    settings: { mainModel: 'z-ai/glm-5.3', tiers: { deep: 'z-ai/glm-5.3', standard: 'deepseek/flash', fast: 'z-ai/glm-5.3' }, roleModels: {}, visionModel: 'x', transcriptionModel: 'x', imageModel: 'y', safetyModel: 'x' }
  };
  const context = buildStudioContext(input, { hasProject: true, knowledgeBase: false });
  const draft: TeamDraft = { name: 'T', description: '', members: [{ name: 'a', role: 'writer', model: 'standard', tools: null, instructions: 'Write it. Report it.' }, { name: 'b', role: 'analyst', model: 'deep', tools: null, instructions: 'Analyse it. Report it.' }] };
  const quiet = reviewDraft(draft, undefined, input, context).warnings.filter((issue) => /a run uses a private model/.test(issue.message));
  assert.deepEqual(quiet, []);
  const marked = reviewDraft({ ...draft, private: true }, undefined, input, context).warnings.filter((issue) => /a run uses a private model/.test(issue.message));
  assert.deepEqual(marked.map((issue) => [issue.member, issue.message]), [[0, 'a: the team is private, so a run uses a private model instead of deepseek/flash (forwarded outside NEAR\'s TEE), and stops if there is none.']]);
  const member = reviewDraft({ ...draft, members: [{ ...draft.members[0], privacy: 'private' }, draft.members[1]] }, undefined, input, context).warnings.filter((issue) => /a run uses a private model/.test(issue.message));
  assert.match(member[0].message, /^a: it is private, so a run uses a private model instead of deepseek\/flash/);
});

// ---------- which model a private team may be sent to ----------

const TEE: ModelInfo = { id: 'z-ai/glm-5.3', privacyBoundary: 'tee' };
const FORWARDED: ModelInfo = { id: 'deepseek/flash', privacyBoundary: 'cloud', forwardedTo: 'openrouter.ai' };
const LOCAL: ModelInfo = { id: 'local/qwen', privacyBoundary: 'local' };
const route = (near: PrivateRoute) => (model: ModelInfo): PrivateRoute => (model.privacyBoundary === 'local' ? { kind: 'local', attestation: false } : near);

test('a private call refuses forwarded models and TEE models whose attestation cannot be checked, and takes a local or attested TEE model', () => {
  const attested = route({ kind: 'near', attestation: true });
  const unattested = route({ kind: 'near', attestation: false });
  // The forwarded deep tier is passed over for the TEE model.
  const tee = chooseTeamModel('private', { models: [FORWARDED, TEE], preferred: [FORWARDED.id], routeFor: attested, privacyMode: 'standard' });
  assert.deepEqual(tee, { ok: true, model: TEE.id, info: TEE, private: true });
  // Only forwarded models: refused, with the reason.
  const forwarded = chooseTeamModel('private', { models: [FORWARDED], preferred: [], routeFor: attested, privacyMode: 'standard' });
  assert.match(forwarded.ok ? '' : forwarded.reason, /needs a private model \(one that runs in NEAR's TEE or on this machine\), and none is available/);
  // A TEE model on another endpoint: its attestation cannot be checked, so it is not private.
  const other = chooseTeamModel('private', { models: [TEE, FORWARDED], preferred: [TEE.id], routeFor: unattested, privacyMode: 'standard' });
  assert.match(other.ok ? '' : other.reason, /endpoint is not NEAR AI Cloud, so a TEE model's attestation cannot be checked/);
  // A local model is private on the local route.
  const local = chooseTeamModel('private', { models: [TEE, LOCAL], preferred: [TEE.id], routeFor: unattested, privacyMode: 'standard' });
  assert.equal(local.ok && local.model, LOCAL.id);
  // A model that says it is local but would go through NEAR's client is not private.
  const misrouted = chooseTeamModel('private', { models: [LOCAL], preferred: [], routeFor: () => ({ kind: 'near', attestation: true }), privacyMode: 'standard' });
  assert.equal(misrouted.ok, false);
  // Any model: the first preferred one, marked as private or not.
  const any = chooseTeamModel('any', { models: [FORWARDED, TEE], preferred: [FORWARDED.id], routeFor: attested, privacyMode: 'standard' });
  assert.deepEqual(any, { ok: true, model: FORWARDED.id, info: FORWARDED, private: false });
});
