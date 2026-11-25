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

/** FILE marked private: the frontmatter line, and a privacy line on every member that did not have one (0.4.27, so an older build keeps them private). */
const MARKED = FILE.replace('description: Works on client files\n', 'description: Works on client files\nprivacy: private\n').replace('tools: Read, Write\n\nRead the files.', 'tools: Read, Write\nprivacy: private\n\nRead the files.');

test('marking a team private writes privacy: private on every member too, so a build that reads only member lines keeps every member private', async () => {
  const marked = teamMarkdown({ ...draftFromMarkdown(FILE, 'clients.md'), private: true }, FILE);
  assert.equal(marked, MARKED);
  // An older build ignores the frontmatter line: with it gone, every member is still private.
  const older = parseTeam(marked.replace(/^privacy: private\n/m, ''), 'clients.md');
  assert.equal(older.private, undefined);
  assert.deepEqual(older.members.map((member) => member.privacy), ['private', 'private']);
  // A privacy: any line on a member is replaced in place, keeping the rest of its section.
  const anyMember = FILE.replace('tools: Read, Write\n\nRead the files.', 'tools: Read, Write\nprivacy: any\n\nRead the files.');
  assert.equal(teamMarkdown({ ...draftFromMarkdown(anyMember, 'clients.md'), private: true }, anyMember), MARKED);
  // A new private team, and a duplicate of one, have the line on every member.
  const fresh = teamMarkdown({ name: 'New', description: 'd', private: true, members: [{ name: 'a', role: '', model: '', tools: null, instructions: 'Do it. Report it.' }] });
  assert.deepEqual(parseTeam(fresh.replace(/^privacy: private\n/m, ''), 'new.md').members.map((member) => member.privacy), ['private']);
  const library = new TeamLibrary(await mkdtemp(path.join(tmpdir(), 'near-ai-privacy-')));
  const file = await library.create('Clients', FILE.replace('owner: ops', 'privacy: private'));
  const copy = await readFile(await library.duplicate(file, 'Clients copy'), 'utf8');
  assert.deepEqual(parseTeam(copy.replace(/^privacy: private\n/m, ''), 'copy.md').members.map((member) => member.privacy), ['private', 'private']);
});

test('privacy: private in the frontmatter marks the team private; any, tee and local read as they do for a member; anything else says what to fix', () => {
  assert.equal(parseTeam(FILE, 'clients.md').private, undefined);
  assert.equal(parseTeam(FILE.replace('owner: ops', 'owner: ops\nprivacy: private'), 'clients.md').private, true);
  assert.equal(parseTeam(FILE.replace('owner: ops', 'owner: ops\nprivacy: tee'), 'clients.md').private, true);
  assert.equal(parseTeam(FILE.replace('owner: ops', 'owner: ops\nprivacy: any'), 'clients.md').private, undefined);
  assert.throws(() => parseTeam(FILE.replace('owner: ops', 'owner: ops\nprivacy: secret'), 'clients.md'), /The agent team has "privacy: secret"; use privacy: private \(private models only: verified private hardware or this computer\)/);
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
  assert.equal(marked, MARKED, 'the frontmatter line, and privacy: private on the member that lacked it; nothing else changes');
  assert.deepEqual(checkDraft({ ...draft, private: true }, FILE).errors, []);
  assert.equal(draftFromMarkdown(marked, 'clients.md').private, true);
  // Turning it off removes the frontmatter line and leaves the member lines (the person removes those one by one); privacy: any is left alone.
  assert.equal(teamMarkdown({ ...draftFromMarkdown(marked, 'clients.md'), private: undefined }, marked), MARKED.replace('description: Works on client files\nprivacy: private\n', 'description: Works on client files\n'));
  const any = FILE.replace('owner: ops', 'owner: ops\nprivacy: any');
  assert.equal(teamMarkdown(draftFromMarkdown(any, 'clients.md'), any), any);
  // A file that already says tee is private: its frontmatter line is kept as written, and saving gives each member its own privacy line (0.4.27).
  const tee = FILE.replace('owner: ops', 'owner: ops\nprivacy: tee');
  assert.equal(teamMarkdown(draftFromMarkdown(tee, 'clients.md'), tee), tee.replace('tools: Read, Write\n\nRead the files.', 'tools: Read, Write\nprivacy: private\n\nRead the files.'));
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

// NEAR's model list reports its attestation (0.4.27: a TEE model whose attestation is not reported does not count as private).
const TEE: ModelInfo = { id: 'z-ai/glm-5.3', privacyBoundary: 'tee', attestationSupported: true };
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

test('a TEE model whose attestation is reported failed or unverified, or not reported at all, is not private for drafting or review', () => {
  const attested = route({ kind: 'near', attestation: true });
  const choose = (model: ModelInfo) => chooseTeamModel('private', { models: [model], preferred: [model.id], routeFor: attested, privacyMode: 'standard' });
  for (const [label, model] of [
    ['failed', { ...TEE, attestationSupported: true, attestationStatus: 'failed' }],
    ['unverified', { ...TEE, attestationSupported: true, verificationStatus: 'unverified' as const }],
    ['not attested', { ...TEE, attestationStatus: 'not_attested' }]
  ] as Array<[string, ModelInfo]>) {
    const refused = choose(model);
    assert.equal(refused.ok, false, label);
    assert.match(refused.ok ? '' : refused.reason, /z-ai\/glm-5\.3: its attestation is reported as failed or unverified/, label);
  }
  // Unknown: NEAR said nothing about the model's attestation, so it does not count as private (fail closed).
  const unknown = choose({ id: 'z-ai/glm-5.3', privacyBoundary: 'tee' });
  assert.match(unknown.ok ? '' : unknown.reason, /z-ai\/glm-5\.3: NEAR has not reported that its attestation is supported or verified/);
  // Reported by NEAR's model list (attestationSupported), or verified: private.
  assert.equal(choose({ ...TEE, attestationSupported: true }).ok, true);
  assert.equal(choose({ id: 'z-ai/glm-5.3', privacyBoundary: 'tee', verificationStatus: 'verified' }).ok, true);
  // Any model may still be used for a team with nothing private, but it is not reported as private.
  const any = chooseTeamModel('any', { models: [{ ...TEE, attestationStatus: 'failed' }], preferred: [], routeFor: attested, privacyMode: 'standard' });
  assert.deepEqual(any.ok && [any.model, any.private], ['z-ai/glm-5.3', false]);
});

// PR #69 review: unticking Private team removed any privacy line that was not any/default/cloud, including a hand-written tee or local one.
test('a hand-written privacy: tee or privacy: local line is never removed by the studio; only the line the checkbox writes is', () => {
  for (const value of ['tee', 'local', 'TEE']) {
    const file = FILE.replace('owner: ops', `owner: ops\nprivacy: ${value}`);
    const draft = draftFromMarkdown(file, 'clients.md');
    const unticked = teamMarkdown({ ...draft, private: undefined }, file);
    assert.match(unticked, new RegExp(`^privacy: ${value}$`, 'm'), value);
    assert.equal(parseTeam(unticked, 'clients.md').private, true, value);
    assert.deepEqual(checkDraft({ ...draft, private: undefined }, file).errors, [], value);
  }
  const written = FILE.replace('owner: ops', 'owner: ops\nprivacy: private');
  assert.doesNotMatch(teamMarkdown({ ...draftFromMarkdown(written, 'clients.md'), private: undefined }, written), /\nowner: ops\nprivacy: private\n/, 'the checkbox\'s own line is removed');
});

// PR #69 review: the existing line was found case-sensitively while the checkbox's own line was matched case-insensitively, so `Privacy: private`
// could gain a second privacy key.
test('a capitalised Privacy line is the same key: ticking never adds a second one, and unticking removes the checkbox value', () => {
  const keys = (text: string) => (text.match(/^privacy:/gim) ?? []).length;
  for (const line of ['Privacy: private', 'PRIVACY: Private', 'Privacy: any']) {
    const text = FILE.replace('owner: ops', `owner: ops\n${line}`);
    const draft = draftFromMarkdown(text, 'clients.md');
    const ticked = teamMarkdown({ ...draft, private: true }, text);
    assert.equal(keys(ticked.slice(0, ticked.indexOf('\n---', 4))), 1, `${line}: one privacy key in the frontmatter`);
    assert.equal(parseTeam(ticked, 'clients.md').private, true, line);
    assert.deepEqual(checkDraft({ ...draft, private: true }, text).errors, [], line);
    const unticked = teamMarkdown({ ...draftFromMarkdown(ticked, 'clients.md'), private: undefined }, ticked);
    assert.equal(keys(unticked.slice(0, unticked.indexOf('\n---', 4))), 0, `${line}: unticking removes it`);
  }
});

// 0.4.28 (PR #69 review): a member's privacy line with a note after it (`privacy: private  # client data`) was not found, so marking the team private
// added a second privacy line under it. The line is now read the same way by the run and by Team Studio: a one-word value with an optional `# note`.
test('a member privacy line with a note after it counts, and marking the team private never doubles it', () => {
  const keys = (text: string) => (text.match(/^privacy:/gim) ?? []).length;
  const withLine = (line: string) => FILE.replace('tools: Read, Write\n\nRead the files.', `tools: Read, Write\n${line}\n\nRead the files.`);
  const section = (text: string) => text.slice(text.indexOf('## analyst'), text.indexOf('## writer'));
  // Already private with a note: the run reads it as private, and the line is kept as written.
  const noted = withLine('privacy: private  # client data');
  assert.equal(parseTeam(noted, 'clients.md').members[0].privacy, 'private');
  assert.equal(parseTeam(noted, 'clients.md').members[0].instructions, 'Read the files. Write the summary to the file the task names.');
  const keptTicked = teamMarkdown({ ...draftFromMarkdown(noted, 'clients.md'), private: true }, noted);
  assert.equal(keys(section(keptTicked)), 1);
  assert.match(section(keptTicked), /^privacy: private {2}# client data$/m);
  // Any, with a note: replaced in place by privacy: private.
  const any = withLine('Privacy: any # for now');
  assert.equal(parseTeam(any, 'clients.md').members[0].privacy, undefined);
  const anyTicked = teamMarkdown({ ...draftFromMarkdown(any, 'clients.md'), private: true }, any);
  assert.equal(keys(section(anyTicked)), 1);
  assert.match(section(anyTicked), /^tools: Read, Write\nprivacy: private\n\nRead the files\./m);
  // A sentence that starts with "Privacy:" stays instructions, for the run and for the studio: it is never taken for the setting or replaced.
  const sentence = withLine('Privacy: handle client data carefully.');
  assert.match(parseTeam(sentence, 'clients.md').members[0].instructions, /^Privacy: handle client data carefully\./);
  const sentenceTicked = teamMarkdown({ ...draftFromMarkdown(sentence, 'clients.md'), private: true }, sentence);
  assert.match(section(sentenceTicked), /^tools: Read, Write\nprivacy: private\nPrivacy: handle client data carefully\.\n\nRead the files\./m);
  assert.match(parseTeam(sentenceTicked, 'clients.md').members[0].instructions, /^Privacy: handle client data carefully\./);
});
