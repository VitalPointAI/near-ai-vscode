import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { decidePermission, DEFAULT_RULES, RunGrants } from '../agent/permissions';
import { checkDraft, draftFromMarkdown, lineDiff, teamMarkdown, type TeamDraft } from '../agent/teamMarkdown';
import { DEFAULT_TOOLS, parseTeam, renderTeam, TeamLibrary } from '../agent/teams';
import type { ActionCapability, ActionPolicyMode } from '../domain/policy';
import { attachTeamStudio, buildStudioContext, KEPT_WIZARD_TEXT, parseStudioMessage, reviewDraft, teamStudioHtml, type KeptWork, type SavedWizard, type StudioContext, type TeamStudioDeps } from '../services/teamStudioPage';
import type { DirectoryInput } from '../services/toolsDirectory';

// Team Studio: a visual builder and manager for the Markdown team files, which stay the source of truth.

const SCRIPT = path.join(__dirname, '..', '..', 'media', 'teams', 'teams.js');
const MODES: ActionPolicyMode[] = ['approve-risky', 'mostly-autonomous', 'auto', 'fully-autonomous'];

function input(overrides: Partial<DirectoryInput> = {}): DirectoryInput {
  return {
    gsd: { version: '1.40.0', skills: [], agents: [
      { name: 'gsd-planner', description: 'Creates executable phase plans. Long details follow.', tools: ['Read', 'Write', 'Bash'], model: 'opus' },
      { name: 'gsd-executor', description: 'Executes plans with atomic commits.', tools: [] }
    ] },
    teams: [],
    policy: { mode: 'approve-risky', emergencyStop: false },
    rules: DEFAULT_RULES,
    webSearch: false,
    securityConsented: true,
    mcp: [],
    models: [
      { id: 'z-ai/glm-5.3', privacyBoundary: 'tee', contextLength: 200_000, inputPricePerMillion: 1.8, outputPricePerMillion: 5.75 },
      { id: 'deepseek/flash', privacyBoundary: 'cloud', forwardedTo: 'openrouter.ai', inputPricePerMillion: 0.3, outputPricePerMillion: 1.2 },
      { id: 'local/qwen', privacyBoundary: 'local' }
    ],
    settings: { mainModel: 'z-ai/glm-5.3', tiers: { deep: 'z-ai/glm-5.3', standard: 'deepseek/flash', fast: 'local/qwen' }, roleModels: {}, visionModel: 'z-ai/glm-5.3', transcriptionModel: 'x', imageModel: 'y', safetyModel: 'local/qwen' },
    ...overrides
  };
}
const context = (overrides: Partial<DirectoryInput> = {}, knowledgeBase = false): StudioContext => buildStudioContext(input(overrides), { hasProject: true, knowledgeBase });

const draft = (overrides: Partial<TeamDraft> = {}): TeamDraft => ({
  name: 'Web team', description: 'Builds pages',
  members: [
    { name: 'lead', role: 'planner', model: 'deep', tools: ['Read', 'Grep'], instructions: 'Plan the work.\n\nKeep steps small.' },
    { name: 'dev', role: '', model: '', tools: null, instructions: 'Build it.' }
  ],
  ...overrides
});

// ---------- the Markdown round trip ----------

test('a new team is exactly what renderTeam writes, and it parses back to the same team', () => {
  const value = draft();
  const markdown = teamMarkdown(value);
  assert.equal(markdown, renderTeam('Web team', 'Builds pages', [
    { name: 'lead', role: 'planner', model: 'deep', tools: ['Read', 'Grep'], instructions: 'Plan the work.\n\nKeep steps small.' },
    { name: 'dev', instructions: 'Build it.' }
  ]));
  const checked = checkDraft(value);
  assert.deepEqual(checked.errors, []);
  assert.equal(checked.markdown, markdown);
  const team = parseTeam(markdown, '/t/web.md');
  assert.deepEqual(team.members.map((member) => [member.name, member.role, member.model, member.tools]), [['lead', 'planner', 'deep', ['Read', 'Grep']], ['dev', undefined, undefined, DEFAULT_TOOLS]]);
  // And back to a draft: the member without a tools line keeps "default set".
  assert.deepEqual(draftFromMarkdown(markdown, '/t/web.md'), value);
});

const HANDWRITTEN = [
  '---',
  '# owner notes stay',
  'name: "Web team"',
  'owner: design-systems',
  'tags:',
  '  - frontend',
  '  - a11y',
  'description: Builds pages',
  'x-custom: { keep: this }',
  '---',
  '',
  'Free text above the members: the studio cannot show it, so it must survive.',
  '',
  '<!-- a hand-written comment -->',
  '',
  '## Lead Dev',
  'role: planner',
  'model: deep',
  'tools: Read,Grep',
  '',
  'Plan the work.',
  '',
  '### Notes',
  '- keep steps small',
  '',
  '## qa',
  'role: tester',
  '',
  'Test it.',
  ''
].join('\n');

test('saving over a hand-written file keeps what the studio cannot represent, byte for byte', () => {
  const loaded = draftFromMarkdown(HANDWRITTEN, '/t/web.md');
  assert.deepEqual(loaded.members.map((member) => [member.name, member.tools]), [['lead-dev', ['Read', 'Grep']], ['qa', null]]);
  // Unchanged: the exact same bytes.
  assert.equal(teamMarkdown(loaded, HANDWRITTEN), HANDWRITTEN);
  // Change the description and the qa member; rename nothing else.
  const edited: TeamDraft = { ...loaded, description: 'Builds and tests pages', members: [loaded.members[0], { ...loaded.members[1], instructions: 'Test it end to end.', model: 'fast' }] };
  const saved = teamMarkdown(edited, HANDWRITTEN);
  for (const line of ['# owner notes stay', 'name: "Web team"', 'owner: design-systems', 'tags:\n  - frontend\n  - a11y', 'x-custom: { keep: this }', 'description: Builds and tests pages']) assert.ok(saved.includes(line), `keeps ${line}`);
  const preamble = HANDWRITTEN.slice(HANDWRITTEN.indexOf('\n---\n') + 5, HANDWRITTEN.indexOf('## Lead Dev'));
  assert.ok(saved.includes(preamble), 'the text above the members is unchanged');
  const leadSection = HANDWRITTEN.slice(HANDWRITTEN.indexOf('## Lead Dev'), HANDWRITTEN.indexOf('## qa'));
  assert.ok(saved.includes(leadSection), 'an unchanged member keeps its exact text, heading and all');
  assert.match(saved, /## qa\nrole: tester\nmodel: fast\n\nTest it end to end\.\n$/);
  assert.equal(saved.replace('description: Builds and tests pages', 'description: Builds pages').replace(/## qa[\s\S]*$/, ''), HANDWRITTEN.replace(/## qa[\s\S]*$/, ''));
  assert.deepEqual(checkDraft(edited, HANDWRITTEN).errors, []);
  const team = parseTeam(saved, '/t/web.md');
  assert.equal(team.description, 'Builds and tests pages');
  assert.equal(team.members[1].model, 'fast');
  // Renaming the team rewrites only its name line (the quoting is dropped only because the value changed).
  assert.match(teamMarkdown({ ...loaded, name: 'Site team' }, HANDWRITTEN), /^---\n# owner notes stay\nname: Site team\nowner: design-systems\n/);
  // Reordering keeps both sections intact.
  const reordered = teamMarkdown({ ...loaded, members: [loaded.members[1], loaded.members[0]] }, HANDWRITTEN);
  assert.deepEqual(parseTeam(reordered, '/t/web.md').members.map((member) => member.name), ['qa', 'lead-dev']);
  assert.ok(reordered.includes(leadSection.trimEnd()));
  // CRLF files stay CRLF where untouched.
  const crlf = HANDWRITTEN.replace(/\n/g, '\r\n');
  assert.equal(teamMarkdown(draftFromMarkdown(crlf, '/t/web.md'), crlf), crlf);
});

test('validation: names, members, instructions, tools, and the round trip', () => {
  const messages = (value: TeamDraft) => checkDraft(value).errors.map((issue) => issue.message).join('\n');
  assert.match(messages(draft({ name: ' ' })), /Give the team a name/);
  assert.match(messages(draft({ members: [] })), /at least one member/);
  assert.match(messages(draft({ members: [draft().members[0], { ...draft().members[1], name: 'lead' }] })), /Two members are named lead/);
  assert.match(messages(draft({ members: [{ ...draft().members[0], name: 'Lead Dev' }] })), /lowercase letters/);
  assert.match(messages(draft({ members: [{ ...draft().members[0], instructions: '  ' }] })), /write what this member does/);
  assert.match(messages(draft({ members: [{ ...draft().members[0], instructions: 'Do it.\n## sneaky\nmore' }] })), /would start a new member/);
  assert.match(messages(draft({ members: [{ ...draft().members[0], tools: [] }] })), /choose at least one tool/);
  assert.match(messages(draft({ description: 'two\nlines' })), /one line/);
  assert.match(messages(draft({ members: [{ ...draft().members[0], instructions: 'model: deep\nthen the rest' }] })), /would not read back as this team/);
  assert.equal(checkDraft(draft({ members: Array.from({ length: 13 }, (_, index) => ({ ...draft().members[1], name: `m${index}` })) })).errors.some((issue) => /at most 12/.test(issue.message)), true);
});

test('a simple line diff', () => {
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nc\nd'), [{ op: 'same', text: 'a' }, { op: 'del', text: 'b' }, { op: 'same', text: 'c' }, { op: 'add', text: 'd' }]);
  assert.deepEqual(lineDiff('x', 'x'), [{ op: 'same', text: 'x' }]);
});

// ---------- models, privacy, and tools ----------

test('models resolve like a run does; forwarded models warn, and a knowledge-base project refuses them', () => {
  const value = draft({ members: [
    { name: 'deep-one', role: '', model: 'deep', tools: null, instructions: 'x' },
    { name: 'std', role: '', model: 'standard', tools: null, instructions: 'x' },
    { name: 'pinned', role: '', model: 'deepseek/flash', tools: null, instructions: 'x' },
    { name: 'gone', role: '', model: 'vendor/missing', tools: null, instructions: 'x' },
    { name: 'odd', role: '', model: 'gpt', tools: ['Read', 'Teleport'], instructions: 'x' }
  ] });
  const review = reviewDraft(value, undefined, input(), context());
  assert.deepEqual(review.members.map((member) => [member.tier, member.model, member.privacy]), [['deep', 'z-ai/glm-5.3', 'tee'], ['standard', 'deepseek/flash', 'forwarded'], ['model', 'deepseek/flash', 'forwarded'], ['model', 'vendor/missing', 'unknown'], ['inherit', 'z-ai/glm-5.3', 'tee']]);
  assert.match(review.members[1].privacyText, /openrouter\.ai/);
  const warnings = review.warnings.map((issue) => `${issue.member}:${issue.message}`).join('\n');
  assert.match(warnings, /1:std: deepseek\/flash is forwarded outside NEAR's TEE/);
  assert.match(warnings, /2:pinned: deepseek\/flash is forwarded/);
  assert.match(warnings, /4:odd: "gpt" is not a tier/);
  assert.match(warnings, /4:odd: Teleport is not a built-in tool/);
  assert.deepEqual(review.errors.map((issue) => [issue.member, issue.field]), [[3, 'model']]);
  assert.match(review.errors[0].message, /vendor\/missing is not in your key's model list/);
  // A knowledge-base project: forwarded models are errors.
  const kb = reviewDraft(value, undefined, input(), context({}, true));
  assert.deepEqual(kb.errors.filter((issue) => /knowledge base/.test(issue.message)).map((issue) => issue.member), [1, 2]);
  assert.ok(kb.warnings.some((issue) => issue.member === 3 && /knowledge base/.test(issue.message)), 'unknown privacy warns');
  // No catalog (no profile yet): nothing claimed about availability.
  const offline = reviewDraft(value, undefined, input({ models: undefined }), context({ models: undefined }));
  assert.ok(offline.members.every((member) => member.available === undefined));
  assert.deepEqual(offline.errors, []);
});

test('each tool\'s runs/asks badge follows decidePermission in every approval mode', () => {
  const capabilityOf: Record<string, ActionCapability> = { read: 'read', plan: 'plan', edit: 'workspaceWrite', shell: 'shell', network: 'network', generate: 'mediaGeneration', git: 'gitMutation', publish: 'mediaPublication' };
  for (const mode of MODES) {
    for (const stopped of [false, true]) {
      const policy = { mode, emergencyStop: stopped };
      const studio = buildStudioContext(input({ policy, webSearch: true }), { hasProject: true, knowledgeBase: false });
      assert.equal(studio.policy.mode, mode);
      for (const tool of studio.tools) {
        if (tool.status === 'off') continue;
        const capability = capabilityOf[tool.capability];
        const decided = decidePermission(capability, undefined, policy, DEFAULT_RULES, new RunGrants());
        const expected = decided.decision === 'deny' ? 'stopped' : decided.decision === 'allow' ? 'runs' : capability === 'shell' && mode === 'auto' ? 'auto-checked' : 'asks';
        assert.equal(tool.status, expected, `${tool.name} under ${mode}${stopped ? ' (stopped)' : ''}`);
      }
    }
  }
});

test('roles come from team roles and the installed Open-GSD agents; starting points include every kind', () => {
  const studio = context();
  const planner = studio.roles.find((role) => role.id === 'gsd-planner')!;
  assert.equal(planner.source, 'gsd');
  assert.equal(planner.description, 'Creates executable phase plans.');
  assert.deepEqual(planner.tools, ['Read', 'Write', 'Bash']);
  assert.equal(planner.model, 'deep');
  assert.match(planner.suggestion, /Open-GSD gsd-planner agent/);
  assert.ok(studio.roles.some((role) => role.id === 'reviewer' && role.source === 'team' && /Do not edit/.test(role.suggestion)));
  assert.deepEqual([...new Set(studio.startingPoints.map((point) => point.group))], ['recommend', 'project-type', 'gsd', 'empty']);
  for (const id of ['gsd:research', 'gsd:build-test', 'gsd:review', 'gsd:writing', 'gsd:analysis', 'type:software', 'empty']) assert.ok(studio.startingPoints.some((point) => point.id === id), id);
  assert.deepEqual(studio.defaultTools, DEFAULT_TOOLS);
});

// ---------- strict messages ----------

test('every page message is strictly validated', () => {
  const good: unknown[] = [
    { type: 'ready' }, { type: 'refresh' }, { type: 'import' }, { type: 'discard-draft' },
    ...['open', 'duplicate', 'export', 'archive', 'restore', 'use-in-chat', 'open-markdown', 'versions'].map((type) => ({ type, id: 'user:web' })),
    { type: 'open', id: 'project' }, { type: 'restore', id: 'archived:web-2' },
    { type: 'version-view', id: 'user:web', ref: '2026-10-29T14-03-12-345Z.md' }, { type: 'version-restore', id: 'project', ref: '2026-10-29T14-03-12-345Z.md' },
    { type: 'review', seq: 3, draft: draft() }, { type: 'review', seq: 4, draft: draft(), id: 'user:web' },
    { type: 'save', draft: draft(), id: 'user:web', base: 'a'.repeat(64) },
    { type: 'create', draft: draft(), target: 'user' }, { type: 'create', draft: draft(), target: 'project', projectType: { id: 'software', goal: 'Ship it' } },
    { type: 'save-draft', draft: draft(), step: 2, target: 'user', startingPoint: 'gsd:build-test' },
    { type: 'starting-point', id: 'recommend', goal: 'Ship', locality: 'cloud', workShape: 'feature', riskLevel: 'high' }, { type: 'starting-point', id: 'type:research', goal: '', locality: 'local' },
    { type: 'open-setting', key: 'nearAi.agent.deepModel' }
  ];
  for (const message of good) assert.ok(parseStudioMessage(message), JSON.stringify(message));
  const bad: unknown[] = [
    null, [], 'ready', { type: 'ready', extra: 1 }, { type: 'nope' },
    { type: 'open', id: '../../etc/passwd' }, { type: 'open', id: 'user:Web' }, { type: 'open', id: '/abs/web.md' }, { type: 'open' },
    { type: 'archive', id: 'user:web', file: '/x' }, { type: 'use-in-chat', id: 'user:web', text: '/team:web rm -rf ' },
    { type: 'version-view', id: 'user:web', ref: '../../secret.md' }, { type: 'version-view', id: 'user:web', ref: 'a.txt' },
    { type: 'review', seq: 1.5, draft: draft() }, { type: 'review', seq: 1, draft: { ...draft(), extra: true } },
    { type: 'review', seq: 1, draft: { ...draft(), members: [{ ...draft().members[0], prompt: 'x' }] } },
    { type: 'review', seq: 1, draft: { ...draft(), members: [{ ...draft().members[0], tools: ['Read; rm'] }] } },
    { type: 'review', seq: 1, draft: { ...draft(), members: Array.from({ length: 13 }, () => draft().members[1]) } },
    { type: 'review', seq: 1, draft: { ...draft(), name: 'x'.repeat(121) } },
    { type: 'save', draft: draft(), id: 'user:web' }, { type: 'save', draft: draft(), id: 'user:web', base: 'short' }, { type: 'save', draft: draft(), id: 'archived:web', base: 'a'.repeat(64) },
    { type: 'create', draft: draft(), target: 'global' }, { type: 'create', draft: draft(), target: 'project', projectType: { id: 'hacking', goal: '' } },
    { type: 'save-draft', draft: draft(), step: 9, target: 'user' },
    { type: 'starting-point', id: 'gsd:unknown', goal: '', locality: 'cloud' }, { type: 'starting-point', id: 'recommend', goal: '', locality: 'mars' }, { type: 'starting-point', id: 'recommend', goal: '', locality: 'cloud', riskLevel: 'extreme' },
    { type: 'open-setting', key: 'editor.fontSize' }, { type: 'open-setting', key: 'nearAi.agent.denyCommands' },
    { type: 'run-command', command: 'nearAi.emergencyStop' }, { type: 'delete', id: 'user:web' }
  ];
  for (const message of bad) assert.equal(parseStudioMessage(message), undefined, JSON.stringify(message));
});

test('the page HTML is one nonce script and one stylesheet under a strict CSP', () => {
  const html = teamStudioHtml({ cspSource: 'vscode-webview://test', nonce: 'n0nce', script: 'teams.js', style: 'teams.css' });
  assert.match(html, /default-src 'none'; style-src vscode-webview:\/\/test; script-src 'nonce-n0nce';/);
  assert.equal([...html.matchAll(/<script\b/g)].length, 1);
  assert.doesNotMatch(html, /<style|\son[a-z]+=|unsafe-inline|https?:\/\//);
  assert.match(html, /aria-live="polite"/);
});

// ---------- the host controller, on a real TeamLibrary ----------

interface Harness { posted: Array<Record<string, any>>; send(message: unknown): Promise<void>; deps: TeamStudioDeps; storage: string; root: string; library: TeamLibrary; prefills: string[]; opened: string[]; applied: string[]; drafts: { value?: SavedWizard }; watch(file: string): void; confirmAnswer: { value: boolean }; askAnswer: { value: string | undefined }; exportTarget: { value?: string }; settle(): Promise<void>; chooseAnswer: { value?: string }; asked: Array<{ message: string; actions: string[] }>; kept: { value?: KeptWork }; close(): void }

async function harness(): Promise<Harness> {
  const base = await mkdtemp(path.join(tmpdir(), 'near-ai-studio-'));
  const storage = path.join(base, 'global');
  const root = path.join(base, 'project');
  await mkdir(root, { recursive: true });
  const library = new TeamLibrary(storage);
  const posted: Array<Record<string, any>> = [];
  let receive: ((message: unknown) => unknown) | undefined;
  let watcher: ((file: string) => void) | undefined;
  const prefills: string[] = []; const opened: string[] = []; const applied: string[] = [];
  const drafts: { value?: SavedWizard } = {};
  const confirmAnswer = { value: true }; const askAnswer: { value: string | undefined } = { value: 'Web copy' }; const exportTarget: { value?: string } = {};
  const chooseAnswer: { value?: string } = {}; const asked: Array<{ message: string; actions: string[] }> = []; const kept: { value?: KeptWork } = {};
  let disposed: (() => void) | undefined;
  const deps: TeamStudioDeps = {
    library, root,
    gather: async () => input(),
    knowledgeBase: async () => existsSync(path.join(root, '.near-kb')),
    sidebar: { prefill: async (text) => { prefills.push(text); } },
    openFile: async (file) => { opened.push(file); },
    openSetting: async () => undefined,
    confirm: async () => confirmAnswer.value,
    ask: async () => askAnswer.value,
    pickExportTarget: async () => exportTarget.value,
    pickImportSource: async () => undefined,
    applyProjectType: async (_root, type, goal) => { applied.push(`${type.id}:${goal}`); },
    drafts: { get: () => drafts.value, set: async (value) => { drafts.value = value; } },
    choose: async (message, ...actions) => { asked.push({ message, actions }); return chooseAnswer.value; },
    kept: { get: () => kept.value, set: async (value) => { kept.value = value; } },
    watch: (listener) => { watcher = listener; return { dispose() {} }; }
  };
  attachTeamStudio({ webview: { postMessage: async (message) => { posted.push(message as Record<string, any>); return true; }, onDidReceiveMessage: (listener) => { receive = listener; return { dispose() {} }; } }, onDidDispose: (listener) => { disposed = listener; return { dispose() {} }; } }, deps);
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
  return { posted, send: async (message) => { await receive!(message); }, deps, storage, root, library, prefills, opened, applied, drafts, watch: (file) => watcher!(file), confirmAnswer, askAnswer, exportTarget, settle, chooseAnswer, asked, kept, close: () => disposed!() };
}
const last = (h: Harness, type: string) => [...h.posted].reverse().find((message) => message.type === type)!;

test('host: the library lists the project team, user teams, and archived teams', async () => {
  const h = await harness();
  await mkdir(path.dirname(TeamLibrary.projectTeamFile(h.root)), { recursive: true });
  await writeFile(TeamLibrary.projectTeamFile(h.root), renderTeam('Project team', 'For this repo', [{ name: 'dev', model: 'standard', instructions: 'Build.' }]));
  const web = await h.library.create('Web', teamMarkdown(draft()));
  const old = await h.library.create('Old', teamMarkdown(draft({ name: 'Old' })));
  await h.library.archive(old);
  await writeFile(path.join(h.library.directory, 'broken.md'), '---\ndescription: no name\n---\n');
  await h.send({ type: 'ready' });
  const state = last(h, 'state');
  assert.deepEqual(state.library.teams.map((team: any) => [team.id, team.kind, team.name, team.members.length, Boolean(team.error)]), [['project', 'project', 'Project team', 1, false], ['user:broken', 'user', 'broken', 0, true], ['user:web', 'user', 'Web team', 2, false]]);
  const webTeam = state.library.teams.find((team: any) => team.id === 'user:web');
  assert.equal(webTeam.command, '/team:web ');
  assert.equal(webTeam.file, web);
  assert.ok(webTeam.savedAt);
  assert.deepEqual(webTeam.members.map((member: any) => [member.name, member.role, member.model, member.privacy]), [['lead', 'planner', 'z-ai/glm-5.3', 'tee'], ['dev', undefined, 'z-ai/glm-5.3', 'tee']]);
  assert.equal(state.library.teams[0].members[0].privacy, 'forwarded', 'the standard tier is a forwarded model here');
  assert.deepEqual(state.library.archived.map((entry: any) => [entry.id, entry.name]), [['archived:old', 'Old']]);
  assert.equal(state.context.hasProject, true);
  // "Use in chat" puts the team's command in the sidebar composer; broken or unknown teams do nothing.
  await h.send({ type: 'use-in-chat', id: 'user:web' });
  await h.send({ type: 'use-in-chat', id: 'project' });
  await h.send({ type: 'use-in-chat', id: 'user:broken' });
  await h.send({ type: 'use-in-chat', id: 'user:nope' });
  assert.deepEqual(h.prefills, ['/team:web ', '/team:project ']);
  await h.send({ type: 'open-markdown', id: 'user:broken' });
  assert.deepEqual(h.opened, [path.join(h.library.directory, 'broken.md')]);
});

test('host: the wizard saves exactly the rendered Markdown, as a user team or the project team', async () => {
  const h = await harness();
  await h.send({ type: 'ready' });
  await h.send({ type: 'review', seq: 1, draft: draft() });
  const review = last(h, 'review');
  assert.equal(review.seq, 1);
  assert.equal(review.markdown, teamMarkdown(draft()));
  assert.deepEqual(review.errors, []);
  await h.send({ type: 'create', draft: draft(), target: 'user' });
  const file = path.join(h.library.directory, 'web-team.md');
  assert.equal(await readFile(file, 'utf8'), teamMarkdown(draft()));
  assert.equal((await h.library.versions(file)).length, 1);
  const opened = last(h, 'team');
  assert.equal(opened.id, 'user:web-team');
  assert.deepEqual(opened.draft, draft());
  assert.match(opened.notice, /\/team:web-team/);
  // Invalid drafts are not written.
  const before = h.posted.length;
  await h.send({ type: 'create', draft: draft({ name: 'Bad', members: [] }), target: 'user' });
  assert.equal(h.posted.slice(before).some((message) => message.type === 'save-failed'), true);
  assert.equal(existsSync(path.join(h.library.directory, 'bad.md')), false);
  // The project team, from a project type: also writes the project guidance.
  await h.send({ type: 'starting-point', id: 'type:software', goal: 'Ship billing', locality: 'local' });
  const start = last(h, 'starting-point');
  assert.equal(start.projectType, 'software');
  assert.ok(start.draft.members.some((member: any) => member.name === 'red-team'));
  assert.ok(start.draft.members.every((member: any) => !(member.tools ?? []).includes('WebSearch')), 'local-only drops web tools');
  const projectDraft = { ...start.draft, name: 'Project team' };
  await h.send({ type: 'create', draft: projectDraft, target: 'project', projectType: { id: 'software', goal: 'Ship billing' } });
  const projectFile = TeamLibrary.projectTeamFile(h.root);
  assert.equal(await readFile(projectFile, 'utf8'), teamMarkdown(projectDraft));
  assert.deepEqual(h.applied, ['software:Ship billing']);
  // Replacing it asks first; "no" leaves it alone.
  h.confirmAnswer.value = false;
  await h.send({ type: 'create', draft: draft({ name: 'Other' }), target: 'project' });
  assert.equal(await readFile(projectFile, 'utf8'), teamMarkdown(projectDraft));
  // Other starting points.
  await h.send({ type: 'starting-point', id: 'recommend', goal: 'Add billing', locality: 'cloud', workShape: 'feature', riskLevel: 'high' });
  assert.deepEqual(last(h, 'starting-point').draft.members.map((member: any) => member.name), ['planner', 'implementer', 'security', 'tester', 'reviewer']);
  await h.send({ type: 'starting-point', id: 'gsd:build-test', goal: 'Refactor', locality: 'cloud' });
  const gsd = last(h, 'starting-point').draft;
  assert.deepEqual(gsd.members.map((member: any) => [member.name, member.role]), [['planner', 'gsd-planner'], ['executor', 'gsd-executor'], ['verifier', 'gsd-verifier']]);
  assert.match(gsd.members[0].instructions, /Creates executable phase plans\./);
  assert.deepEqual(checkDraft({ ...gsd, name: 'Build' }).errors, []);
  await h.send({ type: 'starting-point', id: 'empty', goal: '', locality: 'cloud' });
  assert.deepEqual(last(h, 'starting-point').draft.members, []);
  // Drafts can be saved at any step and come back with the state.
  await h.send({ type: 'save-draft', draft: draft({ name: 'Half done', members: [] }), step: 1, target: 'user', startingPoint: 'empty' });
  assert.equal(h.drafts.value?.draft.name, 'Half done');
  await h.send({ type: 'refresh' });
  assert.equal(last(h, 'state').savedDraft.step, 1);
  await h.send({ type: 'discard-draft' });
  assert.equal(h.drafts.value, undefined);
});

test('host: editing keeps unknown content, versions every save, and restores versions', async () => {
  const h = await harness();
  const file = await h.library.create('Web', HANDWRITTEN);
  await h.send({ type: 'ready' });
  await h.send({ type: 'open', id: 'user:web' });
  const opened = last(h, 'team');
  assert.equal(opened.versions.length, 1);
  assert.equal(opened.file, 'My teams/web.md');
  const edited = { ...opened.draft, members: [opened.draft.members[0], { ...opened.draft.members[1], instructions: 'Test it end to end.' }] };
  await h.send({ type: 'review', seq: 7, draft: edited, id: 'user:web' });
  assert.equal(last(h, 'review').markdown, teamMarkdown(edited, HANDWRITTEN), 'the preview is what Save writes, merged into the file');
  await new Promise((resolve) => setTimeout(resolve, 5));
  await h.send({ type: 'save', draft: edited, id: 'user:web', base: opened.base });
  const saved = await readFile(file, 'utf8');
  assert.equal(saved, teamMarkdown(edited, HANDWRITTEN));
  assert.ok(saved.includes('x-custom: { keep: this }') && saved.includes('Free text above the members'));
  const after = last(h, 'team');
  assert.match(after.notice, /version 2/);
  assert.equal(after.versions.length, 2);
  // History: view the first version's changes, then restore it.
  const first = after.versions[1].ref;
  await h.send({ type: 'version-view', id: 'user:web', ref: first });
  const version = last(h, 'version');
  assert.equal(version.text, HANDWRITTEN);
  assert.deepEqual(version.diff.filter((line: any) => line.op !== 'same').map((line: any) => `${line.op}:${line.text}`), ['del:Test it.', 'add:Test it end to end.']);
  await h.send({ type: 'version-view', id: 'user:web', ref: 'not-a-version.md' });
  assert.equal(last(h, 'version'), version, 'only listed versions');
  await new Promise((resolve) => setTimeout(resolve, 5));
  await h.send({ type: 'version-restore', id: 'user:web', ref: first });
  assert.equal(await readFile(file, 'utf8'), HANDWRITTEN);
  assert.equal(last(h, 'team').versions.length, 3);
  // Save with a stale base: the file changed underneath, so the page is asked to reload or keep its changes.
  const stale = last(h, 'team').base;
  await writeFile(file, HANDWRITTEN.replace('Test it.', 'Test it in the browser.'));
  await h.send({ type: 'save', draft: edited, id: 'user:web', base: stale });
  const conflict = last(h, 'external-change');
  assert.equal(conflict.reason, 'conflict');
  assert.equal(conflict.draft.members[1].instructions, 'Test it in the browser.');
  assert.equal(await readFile(file, 'utf8'), HANDWRITTEN.replace('Test it.', 'Test it in the browser.'), 'nothing was overwritten');
  // "Keep mine" saves against the new base, still merging into the newer file.
  await h.send({ type: 'save', draft: edited, id: 'user:web', base: conflict.base });
  assert.match(await readFile(file, 'utf8'), /Test it end to end\./);
});

test('host: an edit to the open file outside the studio refreshes it', async () => {
  const h = await harness();
  const file = await h.library.create('Web', teamMarkdown(draft()));
  await h.send({ type: 'ready' });
  await h.send({ type: 'open', id: 'user:web' });
  const count = h.posted.filter((message) => message.type === 'external-change').length;
  // The studio's own write (same text) is not an external change.
  h.watch(file);
  await h.settle();
  assert.equal(h.posted.filter((message) => message.type === 'external-change').length, count);
  await writeFile(file, teamMarkdown(draft({ description: 'Changed in the editor' })));
  h.watch(file);
  await h.settle();
  const change = last(h, 'external-change');
  assert.equal(change.reason, 'edited');
  assert.equal(change.draft.description, 'Changed in the editor');
  // A broken edit is reported, not loaded.
  await writeFile(file, '---\nname: x\n---\nno members');
  h.watch(file);
  await h.settle();
  assert.match(last(h, 'notice').text, /can't be read yet/);
  // Library refreshes after file events.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(h.posted.some((message) => message.type === 'library'));
});

test('host: duplicate, export, archive (never delete), and restore go through TeamLibrary', async () => {
  const h = await harness();
  const file = await h.library.create('Web', teamMarkdown(draft()));
  await mkdir(path.dirname(TeamLibrary.projectTeamFile(h.root)), { recursive: true });
  await writeFile(TeamLibrary.projectTeamFile(h.root), teamMarkdown(draft({ name: 'Project team' })));
  await h.send({ type: 'ready' });
  await h.send({ type: 'duplicate', id: 'user:web' });
  assert.equal(parseTeam(await readFile(path.join(h.library.directory, 'web-copy.md'), 'utf8'), 'x.md').name, 'Web copy');
  assert.equal(last(h, 'notice').focus, 'user:web-copy');
  h.exportTarget.value = path.join(h.root, 'exported.md');
  await h.send({ type: 'export', id: 'user:web' });
  assert.equal(await readFile(h.exportTarget.value, 'utf8'), await readFile(file, 'utf8'));
  // The project team cannot be archived from the studio (it would leave the project).
  await h.send({ type: 'archive', id: 'project' });
  assert.ok(existsSync(TeamLibrary.projectTeamFile(h.root)));
  await h.send({ type: 'archive', id: 'user:web' });
  assert.equal(existsSync(file), false);
  assert.deepEqual(last(h, 'library').library.archived.map((entry: any) => entry.id), ['archived:web']);
  // Archiving a second team of the same name keeps both archived copies.
  await h.library.create('Web', teamMarkdown(draft({ description: 'second' })));
  await h.send({ type: 'refresh' });
  await h.send({ type: 'archive', id: 'user:web' });
  assert.deepEqual((await h.library.archived()).map((entry) => path.basename(entry)).sort(), ['web-2.md', 'web.md']);
  await h.send({ type: 'restore', id: 'archived:web' });
  assert.ok(existsSync(file));
  assert.equal(parseTeam(await readFile(file, 'utf8'), file).description, 'Builds pages');
  assert.deepEqual(last(h, 'library').library.archived.map((entry: any) => entry.id), ['archived:web-2']);
  // Restoring over an existing team is refused with a message, not overwritten.
  await h.library.archive(await h.library.create('Dup', teamMarkdown(draft({ name: 'Dup' }))));
  await h.library.create('Dup', teamMarkdown(draft({ name: 'Dup', description: 'new one' })));
  await h.send({ type: 'refresh' });
  await h.send({ type: 'restore', id: 'archived:dup' });
  assert.match(last(h, 'error').text, /already exists/);
  assert.equal(parseTeam(await readFile(path.join(h.library.directory, 'dup.md'), 'utf8'), 'x').description, 'new one');
});

test('a project team\'s history belongs to its project', async () => {
  const library = new TeamLibrary(await mkdtemp(path.join(tmpdir(), 'near-ai-teams-')));
  const one = TeamLibrary.projectTeamFile(await mkdtemp(path.join(tmpdir(), 'p1-')));
  const two = TeamLibrary.projectTeamFile(await mkdtemp(path.join(tmpdir(), 'p2-')));
  for (const file of [one, two]) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, teamMarkdown(draft())); await library.snapshot(file); }
  assert.equal((await library.versions(one)).length, 1);
  assert.equal((await library.versions(two)).length, 1);
});

// ---------- leaving with unsaved changes (the user decides) ----------

const wizardState = (overrides: Partial<SavedWizard> = {}): SavedWizard => ({ draft: draft({ name: 'Half built' }), step: 2, target: 'user', startingPoint: 'empty', ...overrides });

test('host: Cancel in the builder with changes asks Discard changes / Save draft; Discard leaves without saving', async () => {
  const h = await harness();
  await h.send({ type: 'ready' });
  h.chooseAnswer.value = 'Discard changes';
  await h.send({ type: 'leave-wizard', wizard: wizardState() });
  assert.deepEqual(h.asked.map((question) => question.actions), [['Discard changes', 'Save draft']]);
  assert.match(h.asked[0].message, /You have an unsaved team "Half built"\. Discard it, or save it as a draft to finish later\?/);
  assert.deepEqual(last(h, 'left'), { type: 'left', choice: 'discard' });
  assert.equal(h.drafts.value, undefined, 'nothing saved');
  assert.deepEqual(await h.library.list(h.root), [], 'no team written');
  // Dismissing the question (Esc, or Cancel in the modal) keeps the builder open.
  h.chooseAnswer.value = undefined;
  await h.send({ type: 'leave-wizard', wizard: wizardState() });
  assert.deepEqual(last(h, 'left'), { type: 'left', choice: 'stay' });
  assert.equal(h.drafts.value, undefined);
});

test('host: Save draft keeps the builder\'s draft, and the library offers to resume it', async () => {
  const h = await harness();
  await h.send({ type: 'ready' });
  h.chooseAnswer.value = 'Save draft';
  await h.send({ type: 'leave-wizard', wizard: wizardState() });
  assert.deepEqual(h.drafts.value, wizardState());
  const left = last(h, 'left');
  assert.equal(left.choice, 'save-draft');
  assert.deepEqual(left.savedDraft, wizardState());
  assert.match(left.notice, /Draft saved/);
  await h.send({ type: 'refresh' });
  assert.deepEqual(last(h, 'state').savedDraft, wizardState());
});

test('host: leaving the editor with changes asks Discard changes / Save; Save writes the file first', async () => {
  const h = await harness();
  const file = await h.library.create('Web team', teamMarkdown(draft()));
  await h.send({ type: 'ready' });
  await h.send({ type: 'open', id: 'user:web-team' });
  const base = last(h, 'team').base;
  const edited = draft({ description: 'Builds and ships pages' });
  // Discard: the file is untouched.
  h.chooseAnswer.value = 'Discard changes';
  await h.send({ type: 'leave-editor', edit: { id: 'user:web-team', draft: edited, base } });
  assert.deepEqual(h.asked.at(-1)!.actions, ['Discard changes', 'Save']);
  assert.match(h.asked.at(-1)!.message, /You have unsaved changes to "Web team"\. Discard them, or save them before leaving\?/);
  assert.deepEqual(last(h, 'left'), { type: 'left', choice: 'discard' });
  assert.equal(await readFile(file, 'utf8'), teamMarkdown(draft()));
  // Save: written and versioned, then back to the library.
  await h.send({ type: 'open', id: 'user:web-team' });
  h.chooseAnswer.value = 'Save';
  await h.send({ type: 'leave-editor', edit: { id: 'user:web-team', draft: edited, base } });
  assert.equal(await readFile(file, 'utf8'), teamMarkdown(edited));
  const saved = last(h, 'left');
  assert.equal(saved.choice, 'saved');
  assert.match(saved.notice, /Saved "Web team" as version/);
  // A draft that cannot be saved keeps the editor open, with the reason.
  await h.send({ type: 'open', id: 'user:web-team' });
  const before = h.posted.length;
  await h.send({ type: 'leave-editor', edit: { id: 'user:web-team', draft: draft({ members: [] }), base: last(h, 'team').base } });
  assert.ok(h.posted.slice(before).some((message) => message.type === 'save-failed'));
  assert.deepEqual(last(h, 'left'), { type: 'left', choice: 'stay' });
  assert.equal(await readFile(file, 'utf8'), teamMarkdown(edited));
});

test('host: closing the panel keeps unsaved work, and the next open says so', async () => {
  // The builder: kept as its resumable draft.
  const h = await harness();
  await h.send({ type: 'ready' });
  await h.send({ type: 'unsaved', wizard: wizardState() });
  h.close();
  await h.settle();
  assert.deepEqual(h.drafts.value, wizardState());
  assert.deepEqual(h.kept.value, { kind: 'wizard', name: 'Half built' });
  const reopened = await harness();
  reopened.drafts.value = h.drafts.value;
  reopened.kept.value = h.kept.value;
  await reopened.send({ type: 'ready' });
  const state = last(reopened, 'state');
  assert.deepEqual(state.kept, { kind: 'wizard', text: KEPT_WIZARD_TEXT });
  assert.equal(KEPT_WIZARD_TEXT, 'Your unsaved team was kept as a draft. Resume it below, or discard it.');
  assert.deepEqual(state.savedDraft, wizardState());
  assert.equal(reopened.kept.value, undefined, 'said once; the resumable draft stays');
  await reopened.send({ type: 'refresh' });
  assert.equal(last(reopened, 'state').kept, undefined);

  // The editor: its changes are kept until reopened or discarded.
  const e = await harness();
  await e.library.create('Web team', teamMarkdown(draft()));
  await e.send({ type: 'ready' });
  await e.send({ type: 'open', id: 'user:web-team' });
  const edit = { id: 'user:web-team', draft: draft({ description: 'Unsaved description' }), base: last(e, 'team').base };
  await e.send({ type: 'unsaved', edit });
  e.close();
  await e.settle();
  assert.deepEqual(e.kept.value, { kind: 'editor', name: 'Web team', ...edit });
  await e.send({ type: 'refresh' });
  const keptState = last(e, 'state').kept;
  assert.deepEqual([keptState.kind, keptState.id, keptState.text], ['editor', 'user:web-team', 'Your unsaved changes to "Web team" were kept as a draft.']);
  assert.deepEqual(keptState.draft, edit.draft);
  await e.send({ type: 'discard-kept' });
  assert.equal(e.kept.value, undefined);

  // Nothing unsaved: nothing kept.
  const n = await harness();
  await n.send({ type: 'ready' });
  await n.send({ type: 'unsaved', wizard: wizardState() });
  await n.send({ type: 'unsaved' });
  n.close();
  await n.settle();
  assert.equal(n.drafts.value, undefined);
  assert.equal(n.kept.value, undefined);
});

// ---------- the page script in a small DOM ----------

class FakeNode {
  children: FakeNode[] = [];
  parent?: FakeNode;
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  listeners = new Map<string, Array<(event: unknown) => void>>();
  hidden = false; id = ''; className = ''; type = ''; value = ''; title = ''; checked = false; disabled = false; open = false; selected = false; name = '';
  private text = '';
  constructor(public tagName: string, private readonly doc: FakeDoc) {}
  get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
  append(...nodes: Array<FakeNode | string>) { for (const node of nodes) { const child = typeof node === 'string' ? this.doc.createTextNode(node) : node; child.parent = this; this.children.push(child); } }
  replaceChildren() { this.children = []; this.text = ''; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); if (name === 'class') this.className = value; }
  getAttribute(name: string) { return this.attributes.get(name); }
  addEventListener(type: string, listener: (event: unknown) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  fire(type: string, event: unknown = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  click() { if (!this.disabled) this.fire('click'); }
  focus() { this.doc.activeElement = this; }
  all(): FakeNode[] { return this.children.flatMap((child) => [child, ...child.all()]); }
}
class FakeDoc {
  body = new FakeNode('body', this);
  activeElement: FakeNode | null = null;
  constructor() { for (const id of ['title', 'crumbs', 'announce', 'banner', 'main']) { const node = new FakeNode('div', this); node.id = id; this.body.append(node); } }
  getElementById(id: string) { return this.body.all().find((node) => node.id === id) ?? null; }
  createElement(tag: string) { return new FakeNode(tag, this); }
  createElementNS(_ns: string, tag: string) { return new FakeNode(tag, this); }
  createTextNode(text: string) { const node = new FakeNode('#text', this); node.textContent = text; return node; }
}

async function runPage() {
  const doc = new FakeDoc();
  const posts: Array<Record<string, any>> = [];
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const sandbox = vm.createContext({ document: doc, window: { addEventListener: (_type: string, listener: (event: { data: unknown }) => void) => listeners.push(listener) }, acquireVsCodeApi: () => ({ postMessage: (message: Record<string, any>) => posts.push(JSON.parse(JSON.stringify(message))) }), setTimeout, clearTimeout, JSON, Map, Set, Date, String, Boolean, Object, isNaN, Math });
  vm.runInContext(await readFile(SCRIPT, 'utf8'), sandbox, { timeout: 1000 });
  const byLabel = (label: string) => doc.body.all().find((node) => node.tagName === 'button' && (node.getAttribute('aria-label') === label || (!node.getAttribute('aria-label') && node.textContent === label)));
  return { doc, posts, dispatch: (data: unknown) => listeners.forEach((listener) => listener({ data })), byLabel, text: () => doc.getElementById('main')!.textContent, wait: () => new Promise((resolve) => setTimeout(resolve, 200)) };
}

test('page: the library shows cards with actions, an empty state, and "Use in chat" posts the team id', async () => {
  const page = await runPage();
  assert.deepEqual(page.posts, [{ type: 'ready' }]);
  page.dispatch({ type: 'state', context: context(), library: { teams: [], archived: [] } });
  assert.match(page.text(), /Create your first team/);
  assert.ok(page.byLabel('Create your first team'));
  const library = { teams: [
    { id: 'project', kind: 'project', name: 'Project team', description: 'For this repo', command: '/team:project ', file: '/p/team.md', savedAt: '2026-10-29T10:00:00.000Z', members: [{ name: 'dev', role: 'implementer', tier: 'standard', model: 'deepseek/flash', privacy: 'forwarded', privacyText: 'Forwarded' }] },
    { id: 'user:web', kind: 'user', name: 'Web team', description: 'Builds pages', command: '/team:web ', file: '/s/web.md', members: [{ name: 'lead', role: 'planner', tier: 'deep', model: 'z-ai/glm-5.3', privacy: 'tee', privacyText: 'TEE' }, { name: 'dev', tier: 'inherit', model: 'z-ai/glm-5.3', privacy: 'tee', privacyText: 'TEE' }] }
  ], archived: [{ id: 'archived:old', name: 'Old team', file: '/s/.archived/old.md' }] };
  page.dispatch({ type: 'library', library });
  const text = page.text();
  assert.match(text, /Project team.*This project.*For this repo.*dev · implementer.*Forwarded/);
  assert.match(text, /Web team.*My team.*lead · planner.*TEE×2.*2 members.*\/team:web/);
  assert.match(text, /Archived teams \(1\).*Old team/);
  page.byLabel('Use Web team in chat')!.click();
  assert.deepEqual(page.posts.at(-1), { type: 'use-in-chat', id: 'user:web' });
  for (const [label, type] of [['Open Web team', 'open'], ['Duplicate Web team', 'duplicate'], ['Export Web team', 'export'], ['Archive Web team', 'archive'], ['Restore Old team', 'restore']] as const) {
    page.byLabel(label)!.click();
    assert.equal(page.posts.at(-1)!.type, type, label);
  }
  assert.equal(page.byLabel('Archive Project team'), undefined, 'the project team has no Archive');
  // Every message the page sends passes the host's strict parser.
  for (const message of page.posts) assert.ok(parseStudioMessage(message), JSON.stringify(message));
});

test('page: the wizard walks five steps, asks the host to check the draft, and saves', async () => {
  const page = await runPage();
  page.dispatch({ type: 'state', context: context(), library: { teams: [], archived: [] } });
  page.byLabel('Create your first team')!.click();
  assert.match(page.text(), /1\. Purpose.*2\. Members.*5\. Instructions & review/);
  const name = page.doc.getElementById('f-name')!;
  name.value = 'Build crew'; name.fire('input');
  const desc = page.doc.getElementById('f-desc')!;
  desc.value = 'Ships\nfeatures'; desc.fire('input');
  assert.equal(desc.value, 'Ships features', 'one line');
  // Pick an Open-GSD starting point and go next: the page asks the host for its members.
  const radio = page.doc.body.all().find((node) => node.tagName === 'input' && node.value === 'gsd:build-test')!;
  radio.checked = true; radio.fire('change');
  page.byLabel('Next: Members')!.click();
  assert.deepEqual(page.posts.at(-1), { type: 'starting-point', id: 'gsd:build-test', goal: 'Ships features', locality: 'cloud' });
  page.dispatch({ type: 'starting-point', id: 'gsd:build-test', draft: { name: '', description: '', members: [{ name: 'planner', role: 'gsd-planner', model: 'deep', tools: ['Read'], instructions: 'Plan.' }] } });
  assert.match(page.text(), /Member 1/);
  assert.equal(page.doc.getElementById('m-name-0')!.value, 'planner');
  // Add a member, choose a role: its suggested instructions, tier, and tools fill in.
  page.byLabel('Add member')!.click();
  const role = page.doc.getElementById('m-role-1')!;
  role.value = 'reviewer'; role.fire('change');
  assert.match(page.doc.getElementById('m-resp-1')!.value, /Do not edit files/);
  page.byLabel('Move member-2 (reviewer) up')!.click();
  assert.equal(page.doc.getElementById('m-name-0')!.value, 'member-2');
  await page.wait();
  const review = page.posts.filter((message) => message.type === 'review').at(-1)!;
  assert.deepEqual(review.draft.members.map((member: any) => [member.name, member.role, member.model]), [['member-2', 'reviewer', 'standard'], ['planner', 'gsd-planner', 'deep']]);
  assert.equal(review.id, undefined);
  // Step 3: models, with what each resolves to.
  page.byLabel('Next: Models')!.click();
  page.dispatch({ type: 'review', seq: review.seq, markdown: '---\nname: Build crew\n---\n', errors: [], warnings: [{ member: 0, field: 'model', message: 'member-2: deepseek/flash is forwarded outside NEAR\'s TEE.' }], members: [{ tier: 'standard', model: 'deepseek/flash', privacy: 'forwarded', privacyText: 'Forwarded' }, { tier: 'deep', model: 'z-ai/glm-5.3', privacy: 'tee', privacyText: 'TEE' }] });
  assert.match(page.text(), /deepseek\/flash Forwarded standard tier · \$0\.30 in \/ \$1\.20 out per 1M/);
  assert.match(page.text(), /forwarded outside NEAR's TEE/);
  // Step 4: tools, with run/ask badges under the current mode.
  page.byLabel('Next: Tools & permissions')!.click();
  assert.match(page.text(), /Approval mode: .*Read.*Runs.*Edit.*Asks first/);
  page.byLabel('Give member-2 read-only tools')!.click();
  assert.match(page.text(), /runs without asking — Read, Glob, Grep/);
  // Step 5: instructions, checks, and the Markdown preview.
  page.byLabel('Next: Instructions & review')!.click();
  await page.wait();
  const finalReview = page.posts.filter((message) => message.type === 'review').at(-1)!;
  page.dispatch({ type: 'review', seq: finalReview.seq, markdown: '---\nname: Build crew\ndescription: Ships features\n---\n\n## member-2\n', errors: [], warnings: [], members: [] });
  assert.match(page.doc.getElementById('preview')!.textContent, /name: Build crew/);
  assert.match(page.doc.getElementById('checks')!.textContent, /Everything checks out/);
  page.byLabel('Save draft')!.click();
  assert.equal(page.posts.at(-1)!.type, 'save-draft');
  assert.equal(page.posts.at(-1)!.step, 4);
  page.byLabel('Save team')!.click();
  const create = page.posts.at(-1)!;
  assert.equal(create.type, 'create');
  assert.equal(create.target, 'user');
  assert.equal(create.draft.name, 'Build crew');
  assert.deepEqual(create.draft.members[0].tools, ['Read', 'Glob', 'Grep', 'TodoWrite', 'Recall', 'Remember']);
  // Errors from the host block Save and are announced.
  page.dispatch({ type: 'review', seq: finalReview.seq, markdown: '', errors: [{ message: 'Two members are named x.' }], warnings: [], members: [] });
  assert.equal(page.doc.getElementById('save')!.disabled, true);
  assert.equal(page.doc.getElementById('checks')!.getAttribute('aria-live'), 'polite');
  for (const message of page.posts) assert.ok(parseStudioMessage(message), JSON.stringify(message));
});

test('page: the editor tracks unsaved changes, saves with its base, and handles outside edits', async () => {
  const page = await runPage();
  page.dispatch({ type: 'state', context: context(), library: { teams: [], archived: [] } });
  const base = 'b'.repeat(64);
  page.dispatch({ type: 'team', id: 'user:web', kind: 'user', file: 'My teams/web.md', command: '/team:web ', draft: draft(), base, versions: [{ ref: '2026-10-29T10-00-00-000Z.md', label: '2026-10-29 10:00:00 UTC' }] });
  assert.match(page.text(), /Web team.*My teams\/web\.md.*Saved/);
  assert.match(page.text(), /Purpose.*Members.*Models.*Tools.*Instructions.*Markdown & checks.*History/);
  assert.equal(page.doc.getElementById('save')!.disabled, true, 'nothing to save yet');
  const name = page.doc.getElementById('f-name')!;
  name.value = 'Site team'; name.fire('input');
  assert.match(page.doc.getElementById('dirty')!.textContent, /Unsaved changes/);
  page.doc.getElementById('save')!.click();
  assert.deepEqual(page.posts.at(-1), { type: 'save', draft: { ...draft(), name: 'Site team' }, id: 'user:web', base });
  // Keyboard: arrow keys move between tabs.
  page.doc.getElementById('tab-0')!.fire('keydown', { key: 'ArrowLeft', preventDefault() {} });
  assert.deepEqual(page.posts.at(-1), { type: 'versions', id: 'user:web' });
  assert.match(page.text(), /2026-10-29 10:00:00 UTC/);
  page.byLabel('View the version from 2026-10-29 10:00:00 UTC')!.click();
  assert.deepEqual(page.posts.at(-1), { type: 'version-view', id: 'user:web', ref: '2026-10-29T10-00-00-000Z.md' });
  page.dispatch({ type: 'version', id: 'user:web', ref: '2026-10-29T10-00-00-000Z.md', label: '2026-10-29 10:00:00 UTC', diff: [{ op: 'same', text: 'a' }, { op: 'del', text: 'old' }, { op: 'add', text: 'new' }] });
  assert.match(page.text(), /2 changed lines[\s\S]*- old\n\+ new/);
  // An outside edit while there are unsaved changes: reload or keep mine.
  const newer = 'c'.repeat(64);
  page.dispatch({ type: 'external-change', id: 'user:web', reason: 'edited', base: newer, draft: draft({ description: 'From the editor' }), versions: [] });
  const banner = page.doc.getElementById('banner')!;
  assert.equal(banner.hidden, false);
  assert.match(banner.textContent, /changed outside the studio while you have unsaved changes/);
  page.byLabel('Keep mine')!.click();
  page.doc.getElementById('tab-0')!.click();
  page.doc.getElementById('save')!.click();
  assert.equal(page.posts.at(-1)!.base, newer, 'keep mine saves against the newer file');
  assert.equal(page.posts.at(-1)!.draft.name, 'Site team');
  // Without unsaved changes an outside edit simply reloads.
  page.dispatch({ type: 'team', id: 'user:web', kind: 'user', file: 'My teams/web.md', command: '/team:web ', draft: draft(), base, versions: [] });
  page.dispatch({ type: 'external-change', id: 'user:web', reason: 'edited', base: newer, draft: draft({ description: 'From the editor' }), versions: [] });
  assert.equal(page.doc.getElementById('f-desc')!.value, 'From the editor');
  page.byLabel('Use in chat')!.click();
  assert.deepEqual(page.posts.at(-1), { type: 'use-in-chat', id: 'user:web' });
  page.byLabel('Open as Markdown')!.click();
  assert.deepEqual(page.posts.at(-1), { type: 'open-markdown', id: 'user:web' });
  for (const message of page.posts) assert.ok(parseStudioMessage(message), JSON.stringify(message));
});

test('page: Cancel and "All teams" leave at once when nothing changed, and ask the host when something did', async () => {
  const page = await runPage();
  page.dispatch({ type: 'state', context: context(), library: { teams: [], archived: [] } });
  // Nothing changed: no prompt.
  page.byLabel('Create your first team')!.click();
  page.byLabel('Cancel')!.click();
  assert.match(page.text(), /Create your first team/);
  assert.equal(page.posts.some((message) => message.type === 'leave-wizard'), false);
  page.byLabel('Create your first team')!.click();
  page.byLabel('Back to all teams')!.click();
  assert.match(page.text(), /Create your first team/);
  assert.equal(page.posts.some((message) => message.type === 'leave-wizard'), false);
  // A change: the page asks the host and stays until it answers.
  page.byLabel('Create your first team')!.click();
  const name = page.doc.getElementById('f-name')!;
  name.value = 'Half built'; name.fire('input');
  assert.deepEqual(page.posts.at(-1), { type: 'unsaved', wizard: { draft: { name: 'Half built', description: '', members: [] }, step: 0, target: 'user', startingPoint: 'recommend' } }, 'the host always knows what is unsaved');
  page.byLabel('Cancel')!.click();
  assert.deepEqual(page.posts.at(-1), { type: 'leave-wizard', wizard: { draft: { name: 'Half built', description: '', members: [] }, step: 0, target: 'user', startingPoint: 'recommend' } });
  assert.match(page.text(), /1\. Purpose/, 'still in the builder');
  page.dispatch({ type: 'left', choice: 'stay' });
  assert.match(page.text(), /1\. Purpose/);
  page.byLabel('Back to all teams')!.click();
  assert.equal(page.posts.at(-1)!.type, 'leave-wizard');
  page.dispatch({ type: 'left', choice: 'discard' });
  assert.match(page.text(), /Create your first team/);
  assert.deepEqual(page.posts.at(-1), { type: 'unsaved' }, 'nothing unsaved any more');
  // Save draft: back to the library, with the draft to resume.
  page.byLabel('Create your first team')!.click();
  page.doc.getElementById('f-name')!.value = 'Kept'; page.doc.getElementById('f-name')!.fire('input');
  page.byLabel('Cancel')!.click();
  const saved = { draft: { name: 'Kept', description: '', members: [] }, step: 0, target: 'user', startingPoint: 'recommend' };
  page.dispatch({ type: 'left', choice: 'save-draft', savedDraft: saved, notice: 'Draft saved. Pick it up again from Team Studio at any time.' });
  assert.match(page.text(), /You have an unfinished team "Kept" \(step 1 of 5\)/);
  assert.match(page.doc.getElementById('banner')!.textContent, /Draft saved/);
  // Resuming and cancelling without a change does not ask.
  page.byLabel('Resume')!.click();
  const count = page.posts.length;
  page.byLabel('Cancel')!.click();
  assert.equal(page.posts.slice(count).some((message) => message.type === 'leave-wizard'), false);
  // The footer's Save draft counts as saved: Cancel right after it does not ask.
  page.byLabel('Resume')!.click();
  page.doc.getElementById('f-name')!.value = 'Kept again'; page.doc.getElementById('f-name')!.fire('input');
  page.byLabel('Save draft')!.click();
  assert.equal(page.posts.at(-1)!.type, 'save-draft');
  page.byLabel('Cancel')!.click();
  assert.notEqual(page.posts.at(-1)!.type, 'leave-wizard');
  for (const message of page.posts) assert.ok(parseStudioMessage(message), JSON.stringify(message));
});

test('page: leaving the editor with changes asks the host (Discard changes / Save) instead of an in-page banner', async () => {
  const page = await runPage();
  page.dispatch({ type: 'state', context: context(), library: { teams: [], archived: [] } });
  const base = 'b'.repeat(64);
  const open = () => page.dispatch({ type: 'team', id: 'user:web', kind: 'user', file: 'My teams/web.md', command: '/team:web ', draft: draft(), base, versions: [] });
  open();
  page.byLabel('Back to all teams')!.click();
  assert.match(page.text(), /Create your first team/, 'unchanged: leaves at once');
  assert.equal(page.posts.some((message) => message.type === 'leave-editor'), false);
  open();
  const desc = page.doc.getElementById('f-desc')!;
  desc.value = 'Changed'; desc.fire('input');
  assert.deepEqual(page.posts.at(-1), { type: 'unsaved', edit: { id: 'user:web', draft: { ...draft(), description: 'Changed' }, base } });
  page.byLabel('Back to all teams')!.click();
  assert.deepEqual(page.posts.at(-1), { type: 'leave-editor', edit: { id: 'user:web', draft: { ...draft(), description: 'Changed' }, base } });
  assert.doesNotMatch(page.doc.getElementById('banner')!.hidden ? '' : page.doc.getElementById('banner')!.textContent, /unsaved/i, 'no in-page banner: the host asks with a modal');
  assert.match(page.text(), /Unsaved changes/);
  page.dispatch({ type: 'left', choice: 'stay' });
  assert.match(page.text(), /Unsaved changes/);
  page.byLabel('Back to all teams')!.click();
  page.dispatch({ type: 'left', choice: 'saved', notice: 'Saved "Web team" as version 2026-10-29.' });
  assert.match(page.text(), /Create your first team/);
  assert.match(page.doc.getElementById('banner')!.textContent, /Saved "Web team"/);
  for (const message of page.posts) assert.ok(parseStudioMessage(message), JSON.stringify(message));
});

test('page: changes kept when the studio closed can be reopened (as unsaved changes) or discarded', async () => {
  const page = await runPage();
  const library = { teams: [{ id: 'user:web', kind: 'user', name: 'Web team', description: '', command: '/team:web ', file: '/s/web.md', members: [] }], archived: [] };
  const base = 'b'.repeat(64);
  const kept = { kind: 'editor', id: 'user:web', name: 'Web team', draft: { ...draft(), description: 'Kept edit' }, base, text: 'Your unsaved changes to "Web team" were kept as a draft.' };
  page.dispatch({ type: 'state', context: context(), library, kept });
  assert.match(page.doc.getElementById('banner')!.textContent, /Your unsaved changes to "Web team" were kept as a draft\./);
  page.byLabel('Reopen with my changes')!.click();
  assert.deepEqual(page.posts.at(-1), { type: 'open', id: 'user:web' });
  page.dispatch({ type: 'team', id: 'user:web', kind: 'user', file: 'My teams/web.md', command: '/team:web ', draft: draft(), base, versions: [] });
  assert.equal(page.doc.getElementById('f-desc')!.value, 'Kept edit');
  assert.match(page.text(), /Unsaved changes/);
  assert.ok(page.posts.some((message) => message.type === 'discard-kept'), 'used up');
  // The wizard's notice, when its draft was kept.
  const other = await runPage();
  other.dispatch({ type: 'state', context: context(), library: { teams: [], archived: [] }, savedDraft: { draft: { name: 'Half', description: '', members: [] }, step: 1, target: 'user' }, kept: { kind: 'wizard', text: KEPT_WIZARD_TEXT } });
  assert.match(other.doc.getElementById('banner')!.textContent, /Your unsaved team was kept as a draft/);
  assert.match(other.text(), /You have an unfinished team "Half"/);
  // Discard them.
  const third = await runPage();
  third.dispatch({ type: 'state', context: context(), library, kept });
  third.byLabel('Discard them')!.click();
  assert.deepEqual(third.posts.at(-1), { type: 'discard-kept' });
  for (const message of [...page.posts, ...other.posts, ...third.posts]) assert.ok(parseStudioMessage(message), JSON.stringify(message));
});

// ---------- the real panel, with VS Code stubbed and no network ----------

test('host path: Manage Teams opens one Team Studio tab; Set Up Project Team starts the guided builder', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-studio-host-'));
  const storage = path.join(root, '.global');
  await mkdir(path.join(storage, 'teams'), { recursive: true });
  await writeFile(path.join(storage, 'teams', 'web.md'), teamMarkdown(draft()));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (request: string | URL | Request) => { throw new Error(`Team Studio must not call the network: ${String(request)}`); }) as typeof fetch;
  const posted: Array<Record<string, any>> = [];
  const commands = new Map<string, () => unknown>();
  const watchers: string[] = [];
  let receive: ((message: unknown) => Promise<void>) | undefined;
  let created = 0;
  let revealed = 0;
  const panel = {
    webview: { html: '', cspSource: 'vscode-webview://test', asWebviewUri: (uri: { fsPath: string }) => ({ toString: () => uri.fsPath }), postMessage: async (message: Record<string, any>) => { posted.push(message); return true; }, onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => { receive = handler; return { dispose() {} }; } },
    onDidDispose: () => ({ dispose() {} }), reveal: () => { revealed += 1; }, iconPath: undefined as unknown
  };
  const disposable = { dispose() {} };
  const vscodeStub = {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: root }, name: 'demo' }], name: 'demo',
      getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback, inspect: () => undefined }),
      onDidChangeConfiguration: () => disposable, onDidSaveTextDocument: () => disposable,
      createFileSystemWatcher: (pattern: { base: string; pattern: string }) => { watchers.push(`${pattern.base}|${pattern.pattern}`); return { onDidChange: () => disposable, onDidCreate: () => disposable, onDidDelete: () => disposable, dispose() {} }; }
    },
    window: { createWebviewPanel: () => { created += 1; return panel; }, createStatusBarItem: () => ({ show() {}, hide() {} }), showInformationMessage: () => undefined, showWarningMessage: () => undefined },
    commands: { executeCommand: async () => undefined, registerCommand: (id: string, handler: () => unknown) => { commands.set(id, handler); return disposable; } },
    RelativePattern: class { constructor(public base: { fsPath: string } | string, public pattern: string) { this.base = typeof base === 'string' ? base : base.fsPath; } },
    ThemeColor: class {}, StatusBarAlignment: { Left: 1, Right: 2 }, ViewColumn: { Active: -1, Beside: -2 },
    Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) }), file: (fsPath: string) => ({ fsPath }) }
  };
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  nodeModule._load = (request, parent, isMain) => request === 'vscode' ? vscodeStub : originalLoad(request, parent, isMain);
  try {
    const { openTeamStudio } = require('../services/teamStudioPanel') as typeof import('../services/teamStudioPanel');
    const { registerWorkspaceCommands } = require('../services/workspaceCommands') as typeof import('../services/workspaceCommands');
    const { initEmergencyStop } = require('../services/emergencyStop') as typeof import('../services/emergencyStop');
    const { AuthService } = require('../services/auth') as typeof import('../services/auth');
    const secrets = { values: new Map<string, string>(), get(key: string) { return Promise.resolve(this.values.get(key)); }, store(key: string, value: string) { this.values.set(key, value); return Promise.resolve(); }, delete(key: string) { this.values.delete(key); return Promise.resolve(); } };
    const memento = () => { const values = new Map<string, unknown>(); return { get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, value); }, keys: () => [...values.keys()] }; };
    const context = { subscriptions: [] as unknown[], globalStorageUri: { fsPath: storage }, extensionUri: { fsPath: root }, secrets, globalState: memento(), workspaceState: memento() };
    initEmergencyStop(context as never);
    const auth = new AuthService(secrets);
    registerWorkspaceCommands(context as never, (options) => openTeamStudio(context as never, auth, { prefill: async () => undefined }, options));
    await commands.get('nearAi.manageTeams')!();
    assert.equal(created, 1);
    assert.match(panel.webview.html, /<title>NEAR AI Team Studio<\/title>/);
    assert.match(panel.webview.html, /media\/teams\/teams\.js/);
    assert.ok(watchers.some((entry) => entry.endsWith(`teams|{*.md,.archived/*.md}`)), 'watches the team library');
    assert.ok(watchers.some((entry) => entry.endsWith(`.near-ai|team.md`)), 'watches the project team file');
    await receive!({ type: 'ready' });
    const state = posted.find((message) => message.type === 'state')!;
    assert.deepEqual(state.library.teams.map((team: any) => team.id), ['user:web']);
    assert.ok(state.context.tools.some((tool: any) => tool.name === 'Bash' && tool.status === 'asks'));
    await commands.get('nearAi.setupProjectTeam')!();
    assert.equal(created, 1, 'the same tab');
    assert.equal(revealed, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(posted.at(-1), { type: 'start-wizard', target: 'project' });
  } finally {
    nodeModule._load = originalLoad;
    globalThis.fetch = originalFetch;
  }
});

test('host path: the questions are VS Code modals, and closing the tab with an unsaved team keeps it for next time', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-studio-close-'));
  const storage = path.join(root, '.global');
  await mkdir(path.join(storage, 'teams'), { recursive: true });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (request: string | URL | Request) => { throw new Error(`Team Studio must not call the network: ${String(request)}`); }) as typeof fetch;
  const disposable = { dispose() {} };
  const warnings: unknown[][] = [];
  let answer: string | undefined = 'Discard changes';
  const panels: Array<{ posted: Array<Record<string, any>>; receive?: (message: unknown) => Promise<void>; close(): void }> = [];
  const makePanel = () => {
    const closers: Array<() => void> = [];
    const entry: { posted: Array<Record<string, any>>; receive?: (message: unknown) => Promise<void>; close(): void } = { posted: [], close: () => closers.forEach((close) => close()) };
    panels.push(entry);
    return {
      webview: { html: '', cspSource: 'vscode-webview://test', asWebviewUri: (uri: { fsPath: string }) => ({ toString: () => uri.fsPath }), postMessage: async (message: Record<string, any>) => { entry.posted.push(message); return true; }, onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => { entry.receive = handler; return disposable; } },
      onDidDispose: (handler: () => void) => { closers.push(handler); return disposable; }, reveal: () => undefined, iconPath: undefined as unknown
    };
  };
  const vscodeStub = {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: root }, name: 'demo' }], name: 'demo',
      getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback, inspect: () => undefined }),
      onDidChangeConfiguration: () => disposable, onDidSaveTextDocument: () => disposable,
      createFileSystemWatcher: () => ({ onDidChange: () => disposable, onDidCreate: () => disposable, onDidDelete: () => disposable, dispose() {} })
    },
    window: { createWebviewPanel: () => makePanel(), createStatusBarItem: () => ({ show() {}, hide() {} }), showInformationMessage: () => undefined, showWarningMessage: async (...args: unknown[]) => { warnings.push(args); return answer; } },
    commands: { executeCommand: async () => undefined, registerCommand: () => disposable },
    RelativePattern: class { constructor(public base: unknown, public pattern: string) {} },
    ThemeColor: class {}, StatusBarAlignment: { Left: 1, Right: 2 }, ViewColumn: { Active: -1, Beside: -2 },
    Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) }), file: (fsPath: string) => ({ fsPath }) }
  };
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  nodeModule._load = (request, parent, isMain) => request === 'vscode' ? vscodeStub : originalLoad(request, parent, isMain);
  try {
    // A fresh panel module: the earlier host-path test leaves its tab open in the shared one.
    delete require.cache[require.resolve('../services/teamStudioPanel')];
    const { openTeamStudio } = require('../services/teamStudioPanel') as typeof import('../services/teamStudioPanel');
    const { initEmergencyStop } = require('../services/emergencyStop') as typeof import('../services/emergencyStop');
    const { AuthService } = require('../services/auth') as typeof import('../services/auth');
    const secrets = { values: new Map<string, string>(), get(key: string) { return Promise.resolve(this.values.get(key)); }, store(key: string, value: string) { this.values.set(key, value); return Promise.resolve(); }, delete(key: string) { this.values.delete(key); return Promise.resolve(); } };
    const memento = () => { const values = new Map<string, unknown>(); return { get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, value); }, keys: () => [...values.keys()] }; };
    const context = { subscriptions: [] as unknown[], globalStorageUri: { fsPath: storage }, extensionUri: { fsPath: root }, secrets, globalState: memento(), workspaceState: memento() };
    initEmergencyStop(context as never);
    const auth = new AuthService(secrets);
    const open = () => openTeamStudio(context as never, auth, { prefill: async () => undefined });
    open();
    const first = panels[0];
    await first.receive!({ type: 'ready' });
    // Cancel with changes: a modal with exactly these two choices (and VS Code's own Cancel).
    await first.receive!({ type: 'leave-wizard', wizard: { draft: draft({ name: 'Half built', members: [] }), step: 1, target: 'user' } });
    assert.deepEqual(warnings[0].slice(1), [{ modal: true }, 'Discard changes', 'Save draft']);
    assert.deepEqual(first.posted.at(-1), { type: 'left', choice: 'discard' });
    answer = undefined;
    await first.receive!({ type: 'leave-editor', edit: { id: 'user:web', draft: draft(), base: 'a'.repeat(64) } });
    assert.deepEqual(warnings[1].slice(1), [{ modal: true }, 'Discard changes', 'Save']);
    assert.deepEqual(first.posted.at(-1), { type: 'left', choice: 'stay' });
    // Closing the tab with an unsaved team: kept, without asking (VS Code cannot hold a panel open).
    await first.receive!({ type: 'unsaved', wizard: { draft: draft({ name: 'Half built', members: [] }), step: 1, target: 'user' } });
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(warnings.length, 2, 'no question on close');
    assert.equal((context.globalState.get('nearAi.teamStudio.draft') as SavedWizard).draft.name, 'Half built');
    open();
    const second = panels[1];
    await second.receive!({ type: 'ready' });
    const state = second.posted.find((message) => message.type === 'state')!;
    assert.equal(state.savedDraft.draft.name, 'Half built');
    assert.deepEqual(state.kept, { kind: 'wizard', text: 'Your unsaved team was kept as a draft. Resume it below, or discard it.' });
    second.close();
  } finally {
    nodeModule._load = originalLoad;
    globalThis.fetch = originalFetch;
  }
});
