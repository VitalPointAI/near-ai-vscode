import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PROJECT_TYPES, projectType, projectTypeTeam, templateVersion, withProjectGuidance } from '../agent/projectTypes';
import { definitionHash, guidanceFingerprint, memberFingerprint } from '../agent/teamFingerprints';
import { splitTeam } from '../agent/teamMarkdown';
import { TEMPLATE_HISTORY } from '../agent/teamTemplateHistory';
import { applyTeamUpdate, describePlan, detectTemplate, planGuidanceUpdate, planTeamUpdate, stampTeam } from '../agent/teamUpdate';
import { parseTeam, renderTeam, TeamLibrary } from '../agent/teams';
import { RED_TEAM_POLICY } from '../agent/projectTypes';
import { beginRun, runInProgress, whenIdle } from '../services/runActivity';
import { AgentRun } from '../agent/loop';
import { RunCheckpoints } from '../agent/checkpoints';
import { DEFAULT_RULES } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import type { AgentMessage, CompletionEvent } from '../services/nearAiClient';
import { PartialUpdateError, RunStartedError, TeamChangedError, TeamUpdater, UpdateNotices } from '../services/teamUpdates';

// Update Team: a team made from a built-in project type is brought up to date member by member,
// replacing only what the user never changed, and asking about everything else.

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'teams');
const research = projectType('research')!;
const stamped = (goal = 'Assess the market') => stampTeam(projectTypeTeam(research, goal, 'cloud'), research);

test('a project type cannot change without a new template version', () => {
  for (const type of PROJECT_TYPES) {
    const history = TEMPLATE_HISTORY[type.id];
    assert.ok(history?.length, `${type.id} has a template history`);
    const current = definitionHash({ members: type.members, guidance: type.guidance, policy: RED_TEAM_POLICY });
    assert.equal(history[history.length - 1].definition, current, `${type.id}'s team or guidance changed: run "npm run compile && node scripts/template-history.mjs" to record template v${history[history.length - 1].version + 1}`);
    assert.deepEqual(history.map((version) => version.version), history.map((_, index) => index + 1), `${type.id} versions count up from 1`);
    // The latest snapshot's fingerprints are today's generated team, for both cloud and local projects.
    for (const locality of ['cloud', 'local'] as const) {
      for (const section of splitTeam(projectTypeTeam(type, 'any goal', locality)).sections) assert.ok(history[history.length - 1].members[section.name]?.includes(memberFingerprint({ ...section, tools: section.tools ?? null })), `${type.id}/${section.name} (${locality})`);
    }
  }
  assert.ok(templateVersion('research') >= 2, 'research has changed since it was first released');
});

test('a team made from a project type is stamped with its template, version, and each member\'s base', () => {
  const text = stamped();
  const ref = detectTemplate(text)!;
  assert.deepEqual({ id: ref.id, stamped: ref.stamped, from: ref.fromVersion, to: ref.toVersion }, { id: 'research', stamped: true, from: templateVersion('research'), to: templateVersion('research') });
  assert.deepEqual(Object.keys(ref.base!), research.members.map((member) => member.name));
  assert.equal(parseTeam(text, 'x.md').members.length, research.members.length, 'the stamp does not disturb parsing');
  const plan = planTeamUpdate(text)!;
  assert.equal(plan.upToDate, true);
  assert.ok(plan.members.every((member) => member.action === 'same'));
  assert.equal(stampTeam(text, research), text, 'stamping again changes nothing');
  const local = stampTeam(projectTypeTeam(research, 'g', 'local'), research);
  assert.equal(planTeamUpdate(local)!.local, true);
  assert.ok(planTeamUpdate(local)!.members.every((member) => member.action === 'same'), 'a local project\'s team is compared with the local variant');
});

test('an unstamped team is recognised by its member names, and a user\'s unrelated team is not', () => {
  const ref = detectTemplate(renderTeam('Mine', 'x', ['investigator', 'source-verifier', 'analyst', 'notes'].map((name) => ({ name, instructions: 'Work.' }))));
  assert.equal(ref?.id, 'research');
  assert.equal(ref?.stamped, false);
  assert.equal(ref?.fromVersion, undefined, 'the base version is unknown');
  assert.equal(detectTemplate(renderTeam('Mine', 'x', ['alpha', 'beta', 'writer'].map((name) => ({ name, instructions: 'Work.' })))), undefined);
});

test('the real ResearchX team: every member matches a released version, so all update without a question, and its guidance does too', async () => {
  const text = await readFile(path.join(FIXTURES, 'wearable-research-team.md'), 'utf8');
  const plan = planTeamUpdate(text)!;
  assert.equal(plan.template.id, 'research');
  assert.equal(plan.template.stamped, false);
  assert.deepEqual(plan.members.map((member) => [member.name, member.action]), [['investigator', 'auto'], ['source-verifier', 'auto'], ['analyst', 'auto'], ['writer', 'auto'], ['editor', 'auto'], ['red-team', 'auto']]);
  assert.match(describePlan(plan), /^Research and analysis template: no recorded version \(inferred from member names\) → v\d+\n- investigator: updates automatically\./);
  const updated = applyTeamUpdate(text, plan);
  const team = parseTeam(updated, 'team.md');
  assert.equal(team.name, 'ResearchX', 'the name and description are the user\'s');
  assert.equal(team.description, 'Researching any topic given.');
  const editor = team.members.find((member) => member.name === 'editor')!;
  assert.equal(editor.model, 'deep');
  assert.equal(editor.privacy, 'private');
  assert.match(editor.instructions, /EDITORIAL-REVIEW\.md[\s\S]*\n\nProject goal: Researching any topic given\.$/, 'the project goal is kept');
  // Round trip: parsing and planning again finds it current, and applying again changes nothing.
  const again = planTeamUpdate(updated)!;
  assert.equal(again.upToDate, true);
  assert.equal(applyTeamUpdate(updated, again), updated);
  const agents = await readFile(path.join(FIXTURES, 'wearable-research-AGENTS.md'), 'utf8');
  assert.equal(planGuidanceUpdate(agents, 'research').action, 'auto', 'the generated guidance is recognised as unchanged');
});

test('a member the user edited is never overwritten without a choice; "add new lines only" keeps theirs and adds what is new', () => {
  const base = stampTeam(projectTypeTeam(research, 'Assess the market', 'cloud'), research);
  // The stamp says what was generated; the user then rewrote the editor.
  const mine = '## editor\nrole: reviewer\nmodel: standard\ntools: Read, CheckCitations\n\nOUR HOUSE STYLE: plain English.\n\nProject goal: Assess the market\n';
  const text = base.replace(/## editor\n[\s\S]*?(?=\n## |$)/, mine);
  const plan = planTeamUpdate(text)!;
  const editor = plan.members.find((member) => member.name === 'editor')!;
  assert.equal(editor.action, 'choice');
  assert.ok(editor.diff?.some((line) => line.op === 'del' && /OUR HOUSE STYLE/.test(line.text)), 'the diff shows what the user would lose');
  assert.ok(plan.members.filter((member) => member.name !== 'editor').every((member) => member.action === 'same'));
  // No decision means theirs is kept, byte for byte.
  assert.match(applyTeamUpdate(text, plan), /## editor\nrole: reviewer\nmodel: standard\ntools: Read, CheckCitations\n\nOUR HOUSE STYLE: plain English\./);
  const merged = parseTeam(applyTeamUpdate(text, plan, { members: { editor: 'merge' } }), 'x.md').members.find((member) => member.name === 'editor')!;
  assert.equal(merged.model, 'standard', 'their model is kept');
  assert.equal(merged.privacy, 'private', 'the new privacy line is added');
  assert.deepEqual(merged.tools.slice(0, 2), ['Read', 'CheckCitations'], 'their tools come first');
  for (const tool of ['Write', 'Edit', 'CreateDocument']) assert.ok(merged.tools.includes(tool), `new tool ${tool} added`);
  assert.match(merged.instructions, /^OUR HOUSE STYLE: plain English\.\n\nOutput: \.planning\/EDITORIAL-REVIEW\.md[\s\S]*\n\nDone when: [\s\S]*\n\nProject goal: Assess the market$/, 'their text, then only the new Output and Done-when sections, then the goal');
  const taken = parseTeam(applyTeamUpdate(text, plan, { members: { editor: 'take' } }), 'x.md').members.find((member) => member.name === 'editor')!;
  assert.equal(taken.model, 'deep');
  assert.doesNotMatch(taken.instructions, /OUR HOUSE STYLE/);
});

test('members the user added are kept, removed built-ins are flagged and kept, and new built-ins are offered', () => {
  const text = stamped().replace('## editor\n', '## fact-desk\nrole: reviewer\n\nOur own checker.\n\n## old-helper\nrole: helper\n\nRetired.\n\n## editor\n').replace(/## analyst[\s\S]*?(?=\n## )/, '');
  // Pretend this file predates the stamp, so the deleted analyst is offered back rather than taken as a deliberate removal.
  const unstamped = text.replace(/\ntemplate:[\s\S]*?(?=\n---)/, '');
  const plan = planTeamUpdate(unstamped)!;
  const action = (name: string) => plan.members.find((member) => member.name === name)?.action;
  assert.equal(action('fact-desk'), 'custom');
  assert.equal(action('old-helper'), 'custom');
  assert.equal(action('analyst'), 'new');
  const added = parseTeam(applyTeamUpdate(unstamped, plan, { add: ['analyst'] }), 'x.md');
  assert.ok(added.members.some((member) => member.name === 'fact-desk' && member.instructions === 'Our own checker.'), 'the user\'s member is untouched');
  assert.deepEqual(added.members.map((member) => member.name).slice(0, 3), ['investigator', 'source-verifier', 'analyst'], 'a new member goes where the built-in team has it');
  assert.equal(parseTeam(applyTeamUpdate(unstamped, plan), 'x.md').members.some((member) => member.name === 'analyst'), false, 'not added unless chosen');
  // With the stamp, a member the user deleted is not offered back.
  assert.equal(planTeamUpdate(text)!.members.some((member) => member.name === 'analyst'), false);
  // A member that used to be built in but no longer is: flagged, not deleted.
  const history = TEMPLATE_HISTORY.research;
  const fake = { ...history[0], members: { ...history[0].members, 'old-helper': ['0000000000000000'] } };
  history.unshift(fake);
  try {
    assert.equal(planTeamUpdate(unstamped)!.members.find((member) => member.name === 'old-helper')?.action, 'removed');
    assert.match(applyTeamUpdate(unstamped, planTeamUpdate(unstamped)!), /## old-helper\nrole: helper\n\nRetired\./);
  } finally {
    history.shift();
  }
});

test('the guidance is updated only when the extension generated it, and an edited copy needs a choice', () => {
  const current = withProjectGuidance('# Rules\n\nUse tabs.\n', research, 'Assess');
  assert.equal(planGuidanceUpdate(current, 'research').action, 'same');
  const old = current.replace(/- \*\*Workflow:\*\*[^\n]*\n/, '');
  assert.equal(planGuidanceUpdate(old, 'research').action, 'choice', 'an unknown version counts as edited');
  const base = guidanceFingerprint(old.slice(old.indexOf('## Project type'), old.indexOf('\n<!-- near-ai:project-type:end')));
  const plan = planGuidanceUpdate(old, 'research', base);
  assert.equal(plan.action, 'auto', 'the recorded base says it was generated');
  assert.equal(planGuidanceUpdate('# Mine\n', 'research').action, 'none');
});

test('applying backs up first, the backup restores with undo, and both work for project and global teams', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'near-ai-team-update-'));
  const library = new TeamLibrary(path.join(base, 'global'));
  const root = path.join(base, 'project');
  const projectFile = TeamLibrary.projectTeamFile(root);
  await mkdir(path.dirname(projectFile), { recursive: true });
  const original = await readFile(path.join(FIXTURES, 'wearable-research-team.md'), 'utf8');
  const agents = await readFile(path.join(FIXTURES, 'wearable-research-AGENTS.md'), 'utf8');
  await writeFile(projectFile, original);
  await writeFile(path.join(root, 'AGENTS.md'), agents);
  await writeFile(path.join(root, '.planning', '.near-ai', 'project.json'), JSON.stringify({ type: 'research', goal: 'Researching any topic given.' }));
  const updater = new TeamUpdater(library);
  const preview = (await updater.outdated(projectFile))!;
  assert.ok(preview, 'the old team is out of date');
  assert.equal(preview.guidance?.action, 'auto');
  const applied = await updater.apply(preview, {});
  assert.equal(await readFile(applied.backup, 'utf8'), original, 'the backup is the file as it was');
  assert.equal((await library.versions(projectFile)).length >= 1, true, 'the backup is in the team history');
  assert.match(await readFile(projectFile, 'utf8'), /\ntemplate: research\ntemplateVersion: \d+\n/);
  assert.match(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), /\*\*Workflow:\*\*/);
  const config = JSON.parse(await readFile(path.join(root, '.planning', '.near-ai', 'project.json'), 'utf8'));
  assert.equal(config.templateVersion, templateVersion('research'));
  assert.equal(await updater.outdated(projectFile), undefined, 'now current');
  await updater.undo(applied);
  assert.equal(await readFile(projectFile, 'utf8'), original, 'undo restores the team');
  assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), agents, 'and the guidance');
  // A global team.
  const globalFile = await library.create('ResearchX', original);
  const globalPreview = (await updater.outdated(globalFile))!;
  assert.equal(globalPreview.guidance, undefined, 'a global team has no AGENTS.md');
  const globalApplied = await updater.apply(globalPreview, {});
  assert.equal(await readFile(globalApplied.backup, 'utf8'), original);
  await updater.undo(globalApplied);
  assert.equal(await readFile(globalFile, 'utf8'), original);
});

test('the update notice fires once per version, and "Don\'t ask" sticks', async () => {
  const values = new Map<string, unknown>();
  const store = { get: <T>(key: string) => values.get(key) as T | undefined, update: async (key: string, value: unknown) => { values.set(key, value); } };
  const notices = new UpdateNotices(store);
  assert.equal(notices.shouldOffer('/p/team.md', 3), true);
  await notices.offered('/p/team.md', 3);
  assert.equal(notices.shouldOffer('/p/team.md', 3), false, 'once per version');
  assert.equal(new UpdateNotices(store).shouldOffer('/p/team.md', 3), false, 'remembered across sessions');
  assert.equal(notices.shouldOffer('/p/team.md', 4), true, 'a newer version is offered again');
  assert.equal(notices.shouldOffer('/p/other.md', 3), true, 'per team');
  await notices.dontAsk('/p/team.md');
  assert.equal(notices.shouldOffer('/p/team.md', 9), false, 'Don\'t ask holds for later versions too');
});

test('an update waits while a run is in progress and is offered when it ends', () => {
  const calls: string[] = [];
  const end = beginRun();
  assert.equal(runInProgress(), true);
  whenIdle(() => calls.push('offered'));
  assert.equal(calls.length, 0, 'not during the run');
  end();
  end();
  assert.equal(runInProgress(), false);
  assert.deepEqual(calls, ['offered'], 'once, after it ends');
  whenIdle(() => calls.push('now'));
  assert.deepEqual(calls, ['offered', 'now']);
});

test('a run outside the chat (a bare agent loop, as sub-agents and benchmarks use) also holds Update Team off until it ends', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-run-activity-'));
  const seen: boolean[] = [];
  const offered: string[] = [];
  const client = {
    async *streamCompletion(_model: string, _messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      seen.push(runInProgress());
      whenIdle(() => offered.push('after the run'));
      yield { type: 'done', message: { role: 'assistant', content: 'done' }, finishReason: 'stop', usage: { verificationStatus: 'unknown', latencyMs: 1 } };
    },
    async actualCostsUsd() { return undefined; }
  };
  const shell = new ShellSession(root);
  try {
    assert.equal(runInProgress(), false);
    const run = new AgentRun({ client: client as never, model: 'm', tools: [], context: { root, checkpoints: new RunCheckpoints('activity'), shell, readFiles: new Set() }, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, requestApproval: async () => ({ decision: 'allow' }) as never, emit: () => undefined });
    const result = await run.run([{ role: 'user', content: 'hi' }], new AbortController().signal);
    assert.equal(result.outcome, 'completed');
    assert.deepEqual(seen, [true], 'in progress while the model works');
    assert.deepEqual(offered, ['after the run'], 'the offer waits for the end');
    assert.equal(runInProgress(), false, 'and the count returns to zero');
    // A loop that fails still ends its count.
    const failing = new AgentRun({ client: { async *streamCompletion() { throw new Error('boom'); }, async actualCostsUsd() { return undefined; } } as never, model: 'm', tools: [], context: { root, checkpoints: new RunCheckpoints('activity2'), shell, readFiles: new Set() }, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, requestApproval: async () => ({ decision: 'allow' }) as never, emit: () => undefined });
    await failing.run([{ role: 'user', content: 'hi' }], new AbortController().signal).catch(() => undefined);
    assert.equal(runInProgress(), false);
  } finally {
    shell.dispose();
  }
});

test('a member the user kept or merged is not asked about again until the built-in definition changes', () => {
  const base = stampTeam(projectTypeTeam(research, 'Assess the market', 'cloud'), research);
  const mine = '## editor\nrole: reviewer\nmodel: standard\ntools: Read, CheckCitations\n\nOUR HOUSE STYLE: plain English.\n\nProject goal: Assess the market\n';
  const text = base.replace(/## editor\n[\s\S]*?(?=\n## |$)/, mine);
  for (const decision of ['keep', 'merge'] as const) {
    const first = applyTeamUpdate(text, planTeamUpdate(text)!, { members: { editor: decision } });
    const recorded = String(detectTemplate(first)!.base!.editor);
    assert.match(recorded, /^kept:[0-9a-f]{16}:[0-9a-f]{16}$/, `${decision}: the stamp records the user's own fingerprint and the built-in it was kept against`);
    const again = planTeamUpdate(first)!;
    assert.equal(again.members.find((member) => member.name === 'editor')!.action, 'kept', `${decision}: not asked again`);
    assert.equal(again.upToDate, true);
    assert.equal(applyTeamUpdate(first, again), first, `${decision}: a second update changes nothing`);
    // The user edits their own version further: still theirs, still not asked.
    const edited = first.replace('OUR HOUSE STYLE: plain English.', 'OUR HOUSE STYLE: plain English, short sentences.');
    assert.equal(planTeamUpdate(edited)!.members.find((member) => member.name === 'editor')!.action, 'kept');
    // When the built-in editor changes, they are asked again.
    const editor = research.members.find((member) => member.name === 'editor')!;
    const original = editor.instructions;
    editor.instructions = `${original}\n\nDone when: also checked twice.`;
    try {
      const changed = planTeamUpdate(first)!.members.find((member) => member.name === 'editor')!;
      assert.equal(changed.action, 'choice', `${decision}: asked again after the built-in changed`);
      assert.match(changed.reason, /built-in definition has changed since/);
    } finally {
      editor.instructions = original;
    }
  }
  // Taking the new definition records the built-in fingerprint, so later updates replace it automatically.
  const taken = applyTeamUpdate(text, planTeamUpdate(text)!, { members: { editor: 'take' } });
  assert.match(String(detectTemplate(taken)!.base!.editor), /^[0-9a-f]{16}$/);
  assert.equal(planTeamUpdate(taken)!.members.find((member) => member.name === 'editor')!.action, 'same');
});

/** A project with the real ResearchX team, its generated AGENTS.md, and project.json. */
async function project() {
  const base = await mkdtemp(path.join(tmpdir(), 'near-ai-team-tx-'));
  const library = new TeamLibrary(path.join(base, 'global'));
  const root = path.join(base, 'project');
  const file = TeamLibrary.projectTeamFile(root);
  await mkdir(path.dirname(file), { recursive: true });
  const team = await readFile(path.join(FIXTURES, 'wearable-research-team.md'), 'utf8');
  const agents = await readFile(path.join(FIXTURES, 'wearable-research-AGENTS.md'), 'utf8');
  const config = `${JSON.stringify({ type: 'research', goal: 'Researching any topic given.' }, null, 2)}\n`;
  await writeFile(file, team);
  await writeFile(path.join(root, 'AGENTS.md'), agents);
  await writeFile(path.join(root, '.planning', '.near-ai', 'project.json'), config);
  const read = async () => ({ team: await readFile(file, 'utf8'), agents: await readFile(path.join(root, 'AGENTS.md'), 'utf8'), config: await readFile(path.join(root, '.planning', '.near-ai', 'project.json'), 'utf8') });
  return { library, root, file, original: { team, agents, config }, read };
}

test('an update is all or nothing: a failed write puts back what was written, and a failed rollback says exactly what changed and can be undone', async () => {
  const { library, file, original, read } = await project();
  // AGENTS.md cannot be written: the team file, already written, is put back.
  const failingAgents = new TeamUpdater(library, async (target, content) => { if (target.endsWith('AGENTS.md')) throw new Error('disk full'); await writeFile(target, content, 'utf8'); });
  const preview = (await failingAgents.preview(file))!;
  await assert.rejects(() => failingAgents.apply(preview, {}), /^Error: Nothing was changed: writing AGENTS\.md failed \(disk full\), and what had been written was put back\.$/);
  assert.deepEqual(await read(), original, 'every file is as it was');
  // And putting the team file back fails too: the error names it, and Undo restores everything from the backups.
  let teamWrites = 0;
  const failingBoth = new TeamUpdater(library, async (target, content) => {
    if (target.endsWith('AGENTS.md')) throw new Error('disk full');
    if (target === file && (teamWrites += 1) > 1) throw new Error('read-only');
    await writeFile(target, content, 'utf8');
  });
  const error = await failingBoth.apply((await failingBoth.preview(file))!, {}).then(() => undefined, (caught: unknown) => caught);
  assert.ok(error instanceof PartialUpdateError, String(error));
  assert.deepEqual(error.changed, ['team.md']);
  assert.match(error.message, /team\.md could not be put back, so it has the update and the rest do not\. Undo restores the backups\./);
  assert.notEqual((await read()).team, original.team, 'the team file really did change');
  await new TeamUpdater(library).undo(error.applied);
  assert.deepEqual(await read(), original, 'Undo restores every file');
});

test('an edit made while the confirmation was open is never overwritten: the update is planned again and shown again', async () => {
  const { library, file, read } = await project();
  const updater = new TeamUpdater(library);
  const confirmed = (await updater.preview(file))!;
  assert.equal(confirmed.plan.members.find((member) => member.name === 'editor')!.action, 'auto');
  // The user edits the editor while the dialog is open.
  const edited = (await read()).team.replace('Report required changes; do not rewrite the report yourself.', 'Report required changes; also check the house style.');
  await writeFile(file, edited);
  const error = await updater.apply(confirmed, {}).then(() => undefined, (caught: unknown) => caught);
  assert.ok(error instanceof TeamChangedError, String(error));
  assert.match(error.message, /^team\.md changed while you were reviewing the update, so nothing was written\.$/);
  assert.equal((await read()).team, edited, 'the edit is kept');
  assert.equal(error.preview!.plan.members.find((member) => member.name === 'editor')!.action, 'choice', 'the new plan asks about the edited member');
  // A change the plan does not depend on (the description) is not a reason to stop, and is kept.
  const fresh = (await updater.preview(file))!;
  await writeFile(file, edited.replace('description: Researching any topic given.', 'description: Wearables research.'));
  await updater.apply(fresh, { members: { editor: 'keep' } });
  assert.match((await read()).team, /description: Wearables research\./);
  assert.match((await read()).team, /also check the house style/);
});

test('Undo restores project.json too, so the restored guidance is recognised as generated, not as an edit', async () => {
  const { library, file, root, read } = await project();
  const configFile = path.join(root, '.planning', '.near-ai', 'project.json');
  // A project set up by an earlier version: its project.json records the guidance it wrote.
  const agents = (await read()).agents;
  const inner = agents.slice(agents.indexOf('## Project type'), agents.indexOf('\n<!-- near-ai:project-type:end'));
  const before = `${JSON.stringify({ type: 'research', goal: 'Researching any topic given.', templateVersion: 1, guidanceBase: guidanceFingerprint(inner) }, null, 2)}\n`;
  await writeFile(configFile, before);
  const original = await read();
  const updater = new TeamUpdater(library);
  const applied = await updater.apply((await updater.preview(file))!, {});
  const updatedConfig = JSON.parse((await read()).config);
  assert.equal(updatedConfig.templateVersion, templateVersion('research'));
  assert.notEqual(updatedConfig.guidanceBase, JSON.parse(before).guidanceBase);
  assert.equal(path.extname(applied.configBackup!), '.json');
  await updater.undo(applied);
  assert.deepEqual(await read(), original, 'team, guidance, and project.json are all as they were');
  assert.equal((await updater.preview(file))!.guidance!.action, 'auto', 'the restored guidance is again the generated one, so a later update replaces it without asking');
});

test('a run that starts while the update is being written stops it, and what was written is put back', async () => {
  const { library, file, original, read } = await project();
  let endRun: (() => void) | undefined;
  // The run starts right after the first file (the team) is written.
  const updater = new TeamUpdater(library, async (target, content) => { await writeFile(target, content, 'utf8'); if (!endRun) endRun = beginRun(); });
  try {
    const error = await updater.apply((await updater.preview(file))!, {}).then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof RunStartedError, String(error));
    assert.equal(error.message, 'A run started, so the team was not changed. Update it when the run ends.');
    assert.deepEqual(await read(), original, 'the team file written before the run started is put back');
  } finally {
    endRun?.();
  }
  // A run already in progress when apply starts: nothing is written at all.
  const end = beginRun();
  try {
    const writes: string[] = [];
    const quiet = new TeamUpdater(library, async (target, content) => { writes.push(target); await writeFile(target, content, 'utf8'); });
    await assert.rejects(async () => quiet.apply((await quiet.preview(file))!, {}), RunStartedError);
    assert.deepEqual(writes, []);
  } finally {
    end();
  }
});

test('"add only the new parts" keeps the user\'s own Output and Done-when sections instead of adding a second one', () => {
  const base = stampTeam(projectTypeTeam(research, 'g', 'cloud'), research);
  const mine = '## editor\nrole: reviewer\nmodel: standard\ntools: Read\n\nOur house style.\n\nOutput: our own review file.\n\nProject goal: g\n';
  const merged = parseTeam(applyTeamUpdate(base.replace(/## editor\n[\s\S]*?(?=\n## |$)/, mine), planTeamUpdate(base.replace(/## editor\n[\s\S]*?(?=\n## |$)/, mine))!, { members: { editor: 'merge' } }), 'x.md').members.find((member) => member.name === 'editor')!;
  assert.equal((merged.instructions.match(/^Output:/gm) ?? []).length, 1, 'one Output section, theirs');
  assert.match(merged.instructions, /Output: our own review file\./);
  assert.equal((merged.instructions.match(/^Done when:/gm) ?? []).length, 1, 'the missing Done-when section is added');
  const both = mine.replace('Output: our own review file.', 'Output: our own review file.\n\ndone when: we say so.');
  const text = base.replace(/## editor\n[\s\S]*?(?=\n## |$)/, both);
  const result = parseTeam(applyTeamUpdate(text, planTeamUpdate(text)!, { members: { editor: 'merge' } }), 'x.md').members.find((member) => member.name === 'editor')!;
  assert.equal((result.instructions.match(/^(Output|Done when):/gim) ?? []).length, 2, 'nothing added when they have both, whatever the case');
});
