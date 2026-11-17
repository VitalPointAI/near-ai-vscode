import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseFrontmatter } from '../gsd/library';
import { parseTeam, renderTeam, TeamLibrary } from '../agent/teams';
import { draftFromMarkdown, teamMarkdown } from '../agent/teamMarkdown';
import { iconReference, withIconReference } from '../agent/teamIcon';
import { teamRating, withTeamRating } from '../agent/teamFrontMatter';
import type { ActivitySessionSummary } from '../domain/activity';
import { attachTeamStudio, parseStudioMessage, type TeamStudioDeps } from '../services/teamStudioPage';
import type { DirectoryInput } from '../services/toolsDirectory';
import { DEFAULT_RULES } from '../agent/permissions';
import { buildDashboard, folderIdentity, legacyRoleTestKey, migrateRoleTests, parseRatings, parseRoleTests, projectIdentity, roleTestSummary, runTeamSlug, teamHealth, teamKey, teamRunStats, withRating, withRoleTest, type DashboardTeam } from '../domain/teamDashboard';
import { symlink } from 'node:fs/promises';
import { listLibrary } from '../services/teamStudioPage';

// Team Studio's main page is a dashboard of the person's teams (owner, 2026-11-17: "a dashboard of existing teams and their statuses, model setups, stats
// about them, rating"). Every figure comes from what the extension already keeps: the project's activity history (one entry per run, with its outcome,
// its time and its cost from the spend ledger), the team files, the local team check, and the last role test. Nothing is guessed: a figure with no
// record says so.

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function session(id: string, title: string | undefined, extra: Partial<ActivitySessionSummary> = {}): ActivitySessionSummary {
  return {
    version: 1, sessionId: `session-${id}-0000`, project: 'p', plans: [], agents: { total: 0, running: 0, completed: 0, failed: 0, cancelled: 0 } as never, models: [], approvals: { required: 0, approved: 0, pending: 0 },
    startedAt: ago(DAY), updatedAt: ago(DAY), outcome: 'completed', continuationAvailable: false, context: { userTurns: 1, assistantTurns: 1 }, events: [],
    runId: `run-${id}-000000`, ...(title ? { title } : {}), ...extra
  };
}

// ---------- which runs are a team's ----------

test('a run belongs to a team by the /team:<name> it was started with; the project team is /team:project (or its file name, team)', () => {
  assert.equal(runTeamSlug(session('a', '/team:web Build the landing page')), 'web');
  assert.equal(runTeamSlug(session('b', '/team:project')), 'project');
  assert.equal(runTeamSlug(session('c', '/team:team fix it')), 'team');
  assert.equal(runTeamSlug(session('d', 'Fix the cart')), undefined);
  assert.equal(runTeamSlug(session('e', undefined)), undefined);
  assert.equal(runTeamSlug(session('f', '/team:Web')), undefined, 'only a real slug');
  assert.equal(runTeamSlug(session('g', 'please /team:web')), undefined, 'only at the start');
});

// ---------- stats from the history ----------

test('stats: runs, last run, success rate (completed against failed or cancelled), average time, and spend in total and per run', () => {
  const runs = [
    session('a', '/team:web one', { startedAt: ago(2 * HOUR), endedAt: ago(2 * HOUR - 60_000), runOutcome: 'completed', run: { wallMs: 90_000, modelMs: 0, toolMs: 0, approvalWaitMs: 0, idleMs: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0.2, actualCostUsd: 0.25 }),
    session('b', '/team:web two', { startedAt: ago(3 * DAY), endedAt: ago(3 * DAY - 30_000), runOutcome: 'failed', estimatedCostUsd: 0.1 }),
    session('c', '/team:web three', { startedAt: ago(10 * DAY), endedAt: ago(10 * DAY - 60_000), runOutcome: 'cancelled' }),
    session('d', '/team:web four', { startedAt: ago(20 * DAY), endedAt: ago(20 * DAY - 10_000), runOutcome: 'stuck' }),
    // Still going: counted as a run, left out of the success rate and the average time.
    session('e', '/team:web five', { startedAt: ago(60_000), outcome: 'running' })
  ];
  const stats = teamRunStats(runs, NOW);
  assert.equal(stats.runs, 5);
  assert.equal(stats.lastRunAt, ago(60_000));
  assert.deepEqual([stats.completed, stats.failed, stats.cancelled, stats.ended], [1, 2, 1, 4], 'stuck counts as failed');
  assert.equal(stats.successRate, 0.25);
  // The run's own split when it has one (90 s), else its start to its end (30 s, 60 s, 10 s).
  assert.equal(stats.averageMs, (90_000 + 30_000 + 60_000 + 10_000) / 4);
  // NEAR's own figure where the run has one, else the ledger's estimate; a run with neither is not counted as $0.
  assert.equal(stats.costedRuns, 2);
  assert.ok(Math.abs(stats.spendUsd! - 0.35) < 1e-9);
  assert.ok(Math.abs(stats.perRunUsd! - 0.175) < 1e-9);
  assert.equal(stats.runsThisWeek, 3, 'the last seven days');
  assert.ok(Math.abs(stats.spendThisWeekUsd! - 0.35) < 1e-9);
});

test('stats with no runs say none yet: nothing is invented', () => {
  const stats = teamRunStats([], NOW);
  assert.deepEqual(stats, { runs: 0, running: 0, completed: 0, failed: 0, cancelled: 0, ended: 0, timedRuns: 0, costedRuns: 0, runsThisWeek: 0 });
  // Runs whose spend was never recorded: no spend figure at all, not $0.
  const unpriced = teamRunStats([session('a', '/team:web x', { runOutcome: 'completed', endedAt: ago(DAY - 1000) })], NOW);
  assert.equal(unpriced.spendUsd, undefined);
  assert.equal(unpriced.perRunUsd, undefined);
  assert.equal(unpriced.costedRuns, 0);
  assert.equal(unpriced.successRate, 1);
});

// ---------- health: the local check and the last role test ----------

test('health: the local check and the last role test, each shown with its own score; with no role test only the check counts', () => {
  const clean = teamHealth({ block: 0, warning: 0, advice: 0 });
  assert.equal(clean.score, 100);
  assert.deepEqual(clean.parts.map((part) => [part.id, part.score]), [['check', 100], ['role-tests', undefined]]);
  assert.match(clean.parts[0]!.detail, /No problems found/);
  assert.match(clean.parts[1]!.detail, /Not tested yet.*Optimise all teams/);
  const warned = teamHealth({ block: 0, warning: 2, advice: 1 }, { at: ago(DAY), members: 3, tested: 2, score: 60 });
  assert.deepEqual(warned.parts.map((part) => part.score), [65, 60]);
  assert.equal(warned.score, 63, 'the average of the parts, rounded');
  assert.match(warned.parts[0]!.detail, /2 problems.*1 suggestion/);
  assert.match(warned.parts[1]!.detail, /2 of 3 members passed.*60%/);
  // Something that looks like a key: the check scores nothing.
  assert.equal(teamHealth({ block: 1, warning: 0, advice: 0 }).parts[0]!.score, 0);
  assert.match(teamHealth({ block: 1, warning: 0, advice: 0 }).parts[0]!.detail, /looks like a key/);
  // A file that does not read as a team cannot be checked: no score at all.
  const broken = teamHealth(undefined, undefined, 'The team needs a name');
  assert.equal(broken.score, undefined);
  assert.match(broken.parts[0]!.detail, /needs fixing/);
});

test('role tests: a summary of the scores only (no model names, no task text), kept per team file under a hash, at most 200', () => {
  const summary = roleTestSummary([
    { member: 'lead', role: 'planner', results: [{ model: 'a/x', score: 8, outOf: 10, seconds: 3, failed: false, misses: ['secret words'] }, { model: 'b/y', score: 10, outOf: 10, seconds: 9, failed: false, misses: [] }], written: true },
    { member: 'dev', role: 'implementer', results: [{ model: 'a/x', score: 9, outOf: 10, seconds: 3, failed: true, misses: [] }], written: true }
  ], 3, ago(HOUR));
  assert.deepEqual(summary, { at: ago(HOUR), members: 3, tested: 1, score: 33 }, 'the best of each member, a failed run is 0, an untested member is 0');
  assert.doesNotMatch(JSON.stringify(summary), /a\/x|secret|planner/);
  let records = {};
  for (let index = 0; index < 205; index += 1) records = withRoleTest(records, `user:k${index}`, { ...summary, at: new Date(NOW + index).toISOString() });
  assert.equal(Object.keys(records).length, 200);
  assert.equal('user:k0' in records, false, 'the oldest go first');
  // Whatever is read back is checked: anything else is dropped, a key that names no team included.
  assert.deepEqual(parseRoleTests({ 'user:good': summary, 'user:bad': { at: 'x', members: -1 }, 'user:worse': 'nope', 'user:big': { ...summary, score: 400 }, '../x': summary }), { 'user:good': summary });
  assert.deepEqual(parseRoleTests(undefined), {});
  assert.deepEqual(parseRoleTests([summary]), {});
});

test('a role test summary is clamped to 0..100, so a grader that scores past its total never drops the record', () => {
  const over = roleTestSummary([{ results: [{ score: 14, outOf: 10, failed: false }] }, { results: [{ score: -3, outOf: 10, failed: false }] }], 2, ago(HOUR));
  assert.deepEqual(over, { at: ago(HOUR), members: 2, tested: 2, score: 50 }, 'a member past its total counts as 100%, one below 0 as 0%');
  const many = roleTestSummary(Array.from({ length: 150 }, () => ({ results: [{ score: 1, outOf: 1, failed: false }] })), 150, ago(HOUR));
  assert.deepEqual([many.members, many.tested, many.score], [100, 100, 100]);
  for (const record of [over, many]) assert.deepEqual(parseRoleTests({ 'user:web': record }), { 'user:web': record }, 'read back whole');
});

test('a team is kept by a stable identity: a library team by its name in My teams, the project team by its project\'s folder, never by the path to its file', async () => {
  assert.equal(teamKey({ kind: 'user', slug: 'web' }), 'user:web');
  assert.equal(teamKey({ kind: 'project', slug: 'team' }, '0123456789abcdef'), 'project:0123456789abcdef');
  assert.equal(teamKey({ kind: 'project', slug: 'team' }), undefined, 'no project identity, nothing to key by');
  // The project's identity is its folder's real path: a symlink to it, or a trailing separator, is the same project; another folder is not.
  const base = await mkdtemp(path.join(tmpdir(), 'near-ai-identity-'));
  const real = path.join(base, 'project');
  await mkdir(real);
  await symlink(real, path.join(base, 'link'));
  const id = await projectIdentity(real);
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(await projectIdentity(path.join(base, 'link')), id);
  assert.equal(await projectIdentity(`${real}${path.sep}`), id);
  await mkdir(path.join(base, 'other'));
  assert.notEqual(await projectIdentity(path.join(base, 'other')), id);
  // A folder that cannot be resolved still has an identity (its absolute path).
  assert.match(await projectIdentity(path.join(base, 'gone')), /^[0-9a-f]{16}$/);
  // On Windows the same folder can be spelled with different case: it is folded, as file comparisons there are.
  assert.equal(folderIdentity('C:\\Work\\Repo', 'win32'), folderIdentity('c:\\work\\repo', 'win32'));
  assert.notEqual(folderIdentity('/Work/Repo', 'linux'), folderIdentity('/work/repo', 'linux'));
});

test('role tests kept under the old path keys move once to the stable keys; a newer record is never overwritten', () => {
  const old = { at: ago(2 * DAY), members: 1, tested: 1, score: 40 };
  const newer = { at: ago(DAY), members: 1, tested: 1, score: 90 };
  const legacy = { [legacyRoleTestKey('/lib/web.md')]: old, [legacyRoleTestKey('/lib/api.md')]: old, [legacyRoleTestKey('/lib/gone.md')]: old };
  const moved = migrateRoleTests({ ...legacy, 'user:api': newer }, [{ from: legacyRoleTestKey('/lib/web.md'), to: 'user:web' }, { from: legacyRoleTestKey('/lib/api.md'), to: 'user:api' }]);
  assert.equal(moved.changed, true);
  assert.deepEqual(moved.records['user:web'], old);
  assert.deepEqual(moved.records['user:api'], newer, 'the newer record stays');
  assert.equal(legacyRoleTestKey('/lib/web.md') in moved.records, false);
  assert.equal(legacyRoleTestKey('/lib/api.md') in moved.records, false);
  assert.ok(legacyRoleTestKey('/lib/gone.md') in moved.records, 'a record for a team not listed now is left alone');
  const again = migrateRoleTests(moved.records, [{ from: legacyRoleTestKey('/lib/web.md'), to: 'user:web' }]);
  assert.equal(again.changed, false, 'once');
});

test('ratings are kept by team identity on this computer, checked when read back, 0 meaning cleared, at most 500', () => {
  let records = {};
  records = withRating(records, 'user:web', 4, ago(HOUR));
  records = withRating(records, 'project:0123456789abcdef', 0, ago(HOUR));
  assert.deepEqual(parseRatings(records), { 'user:web': { rating: 4, at: ago(HOUR) }, 'project:0123456789abcdef': { rating: 0, at: ago(HOUR) } });
  assert.deepEqual(parseRatings({ 'user:a': { rating: 6, at: ago(1) }, 'user:b': { rating: 2.5, at: ago(1) }, 'user:c': 3, '../d': { rating: 3, at: ago(1) }, 'user:e': { rating: 3, at: 'x' } }), {});
  assert.deepEqual(parseRatings('nope'), {});
  for (let index = 0; index < 505; index += 1) records = withRating(records, `user:t${index}`, 3, new Date(NOW + index).toISOString());
  assert.equal(Object.keys(records).length, 500);
  assert.throws(() => withRating({}, 'user:web', 7, ago(1)), /0 to 5/);
});

// ---------- status and the summary row ----------

const team = (overrides: Partial<DashboardTeam> & Pick<DashboardTeam, 'id'>): DashboardTeam => ({ kind: 'user', slug: overrides.id.replace(/^user:/, ''), key: overrides.id, file: `/lib/${overrides.id.replace(/^user:/, '')}.md`, members: [{ name: 'dev', available: true }], check: { block: 0, warning: 0, advice: 0 }, ...overrides });

test('status: running now, needs attention (with the reason), ready, or never run', () => {
  const sessions = [session('a', '/team:web x', { runOutcome: 'completed', endedAt: ago(DAY - 1000) }), session('b', '/team:team y', { runOutcome: 'failed', endedAt: ago(DAY - 1000), estimatedCostUsd: 0.5 })];
  const dashboard = buildDashboard({
    now: NOW, history: true, sessions, roleTests: {},
    running: [{ runId: 'run-live-000000', slug: 'live' }],
    teams: [
      team({ id: 'project', kind: 'project', slug: 'team', file: '/p/.planning/.near-ai/team.md' }),
      team({ id: 'user:web' }),
      team({ id: 'user:live' }),
      team({ id: 'user:new' }),
      team({ id: 'user:imported', imported: true }),
      team({ id: 'user:derived', imported: true, derived: true }),
      team({ id: 'user:checked', check: { block: 0, warning: 2, advice: 0 } }),
      team({ id: 'user:keyed', check: { block: 1, warning: 0, advice: 0 } }),
      team({ id: 'user:gone', members: [{ name: 'dev', available: false, model: 'vendor/old' }, { name: 'qa', available: true }] }),
      team({ id: 'user:broken', error: 'The team needs a name in its frontmatter (name: My team).', members: [], check: undefined })
    ]
  });
  const status = (id: string) => dashboard.cards[id]!.status;
  assert.equal(status('project'), 'ready', 'the project team\'s runs are /team:team (its file name) or /team:project');
  assert.equal(status('user:web'), 'ready');
  assert.equal(status('user:live'), 'running');
  assert.equal(status('user:new'), 'never-run');
  for (const id of ['user:imported', 'user:derived', 'user:checked', 'user:keyed', 'user:gone', 'user:broken']) assert.equal(status(id), 'attention', id);
  const reason = (id: string) => dashboard.cards[id]!.attention.join(' ');
  assert.match(reason('user:imported'), /Imported and not approved yet/);
  assert.match(reason('user:derived'), /Made from an imported team you have not approved/);
  assert.match(reason('user:checked'), /local check found 2 problems/);
  assert.match(reason('user:keyed'), /looks like a key/);
  assert.match(reason('user:gone'), /dev's model vendor\/old is not available with your key/);
  assert.match(reason('user:broken'), /team file needs fixing: The team needs a name/);
  assert.equal(dashboard.cards['user:new']!.stats.runs, 0);
  assert.equal(dashboard.cards['project']!.stats.failed, 1);
  // The summary row.
  assert.deepEqual(dashboard.summary, { teams: 10, running: 1, runsThisWeek: 2, spendThisWeekUsd: 0.5, attention: 6 });
  assert.equal(dashboard.history, true);
  assert.equal(dashboard.now, NOW);
});

test('a running team still lists what needs attention; a team is matched to a run by its file first, then its name', () => {
  const dashboard = buildDashboard({
    now: NOW, history: true, sessions: [], roleTests: {},
    running: [{ runId: 'run-a-000000', slug: 'team', file: '/p/.planning/.near-ai/team.md' }, { runId: 'run-b-000000', slug: 'web' }],
    teams: [team({ id: 'project', kind: 'project', slug: 'team', file: '/p/.planning/.near-ai/team.md', imported: false }), team({ id: 'user:team', slug: 'team', file: '/lib/team.md' }), team({ id: 'user:web', check: { block: 0, warning: 1, advice: 0 } })]
  });
  assert.equal(dashboard.cards['project']!.status, 'running');
  assert.equal(dashboard.cards['project']!.runId, 'run-a-000000');
  assert.equal(dashboard.cards['user:team']!.status, 'never-run', 'a library team called "team" is not the project team that is running');
  assert.equal(dashboard.cards['user:web']!.status, 'running', 'a run whose file is not known is matched by its name');
  assert.match(dashboard.cards['user:web']!.attention.join(' '), /local check found 1 problem\b/);
  assert.equal(dashboard.summary.running, 2);
  assert.equal(dashboard.summary.attention, 1);
});

test('no project folder open: there is no run history, and the dashboard says so rather than showing zeros as fact', () => {
  const dashboard = buildDashboard({ now: NOW, history: false, sessions: [], roleTests: {}, running: [], teams: [team({ id: 'user:web' })] });
  assert.equal(dashboard.history, false);
  assert.equal(dashboard.cards['user:web']!.status, 'never-run');
  assert.equal(dashboard.summary.spendThisWeekUsd, undefined);
});

test('the health on a card uses the role test recorded for that team\'s identity', () => {
  const record = { at: ago(DAY), members: 1, tested: 1, score: 90 };
  const dashboard = buildDashboard({ now: NOW, history: true, sessions: [], roleTests: { 'user:web': record }, running: [], teams: [team({ id: 'user:web' }), team({ id: 'user:other' })] });
  assert.equal(dashboard.cards['user:web']!.health.score, 95);
  assert.equal(dashboard.cards['user:other']!.health.score, 100);
  assert.equal(dashboard.cards['user:other']!.health.parts[1]!.score, undefined);
});

// ---------- the person's own rating, a line in the team's front matter ----------

const TEAM = renderTeam('Web team', 'Builds pages', [{ name: 'dev', instructions: 'Build it.' }]);

test('the rating line: one line, after a one-line description, replaced, removed, every other byte kept; the team reads the same', () => {
  const rated = withTeamRating(TEAM, 4);
  assert.match(rated, /^---\nname: Web team\ndescription: Builds pages\nrating: 4\n---\n/);
  assert.equal(teamRating(rated), 4);
  assert.equal(withTeamRating(rated, 4), rated, 'unchanged when it already says so');
  assert.deepEqual(rated.split('\n').filter((line) => line.startsWith('rating:')), ['rating: 4']);
  assert.equal(withTeamRating(withTeamRating(rated, 2), undefined), TEAM);
  assert.equal(teamRating(TEAM), undefined);
  // A hand edit with two lines: the first is the rating, and any write leaves one.
  const two = rated.replace('rating: 4\n', 'rating: 4\nrating: 1\n');
  assert.equal(teamRating(two), 4);
  assert.deepEqual(withTeamRating(two, 5).split('\n').filter((line) => line.startsWith('rating:')), ['rating: 5']);
  // Anything that is not a whole number from 1 to 5 is no rating.
  for (const value of ['0', '6', '3.5', 'five', '"3"', '']) assert.equal(teamRating(TEAM.replace('description: Builds pages\n', `description: Builds pages\nrating: ${value}\n`)), value === '"3"' ? 3 : undefined, value);
  for (const bad of [0, 6, 2.5, Number.NaN]) assert.throws(() => withTeamRating(TEAM, bad), /1 to 5/);
  // With an icon line too: each keeps its own line.
  const both = withTeamRating(withIconReference(TEAM, 'web-team.icon.png'), 3);
  assert.equal(iconReference(both), 'web-team.icon.png');
  assert.equal(teamRating(both), 3);
  assert.equal(withIconReference(withTeamRating(both, undefined), undefined), TEAM);
  // CRLF files stay CRLF.
  const crlf = TEAM.replace(/\n/g, '\r\n');
  assert.equal(withTeamRating(crlf, 4), rated.replace(/\n/g, '\r\n'));
  // A file with no front matter is not a team: it is left as it is.
  assert.equal(withTeamRating('no front matter', 3), 'no front matter');
});

test('the rating line goes after a one-line description, never inside a block or quoted value, and the team and the studio read the same', () => {
  const body = '\n## dev\n\nBuild it.\n';
  const cases: Array<[string, string]> = [
    ['one line', '---\nname: Web team\ndescription: Builds pages\nowner: me\n---\n'],
    ['a literal block', '---\nname: Web team\ndescription: |\n  Builds pages\n  and tests them\nowner: me\n---\n'],
    ['a folded block', '---\nname: Web team\ndescription: >-\n  Builds pages\n  and tests them\n---\n'],
    ['a quoted value over two lines', '---\nname: Web team\ndescription: "Builds pages\n  and tests them"\nowner: me\n---\n'],
    ['a plain value over two lines', '---\nname: Web team\ndescription: Builds pages\n  and tests them\n---\n'],
    ['no description', '---\nname: Web team\nowner: me\n---\n']
  ];
  for (const [what, head] of cases) {
    const text = `${head}${body}`;
    const after = withTeamRating(text, 5);
    assert.equal(teamRating(after), 5, what);
    const { rating, ...rest } = parseFrontmatter(after).data;
    assert.equal(rating, '5', what);
    assert.deepEqual(rest, parseFrontmatter(text).data, `${what}: every other key reads the same`);
    assert.deepEqual(parseTeam(after, '/t/web-team.md'), parseTeam(text, '/t/web-team.md'), what);
    const lines = after.split('\n');
    const at = lines.indexOf('rating: 5');
    assert.ok(at > 0, what);
    assert.doesNotMatch(lines[at + 1] ?? '', /^\s+\S/, `${what}: no indented value line follows the rating line`);
    assert.equal(withTeamRating(after, undefined), text, `${what}: removing it gives back the file`);
    // The studio's own save keeps the line, as it keeps every key it does not show.
    assert.equal(teamRating(teamMarkdown(draftFromMarkdown(after, '/t/web-team.md'), after)), 5, `${what}: kept by a studio save`);
  }
});

// ---------- the host: the dashboard in every listing, the rating, Watch it live, live updates ----------


function directoryInput(): DirectoryInput {
  return {
    gsd: { version: '1.40.0', skills: [], agents: [] }, teams: [], policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, webSearch: false, securityConsented: true, mcp: [],
    models: [{ id: 'z-ai/glm-5.3', privacyBoundary: 'tee', contextLength: 200_000 }, { id: 'deepseek/flash', privacyBoundary: 'cloud', forwardedTo: 'openrouter.ai' }],
    settings: { mainModel: 'z-ai/glm-5.3', tiers: { deep: 'z-ai/glm-5.3', standard: 'deepseek/flash', fast: 'z-ai/glm-5.3' }, roleModels: {}, visionModel: 'z-ai/glm-5.3', transcriptionModel: 'x', imageModel: 'y', safetyModel: 'z-ai/glm-5.3' }
  };
}

async function host(options: { sessions?: ActivitySessionSummary[]; running?: Array<{ runId: string; slug?: string; file?: string }>; roleTests?: unknown; ratings?: unknown; noRoot?: boolean } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'near-ai-dashboard-'));
  const root = path.join(base, 'project');
  await mkdir(root, { recursive: true });
  const library = new TeamLibrary(path.join(base, 'global'));
  const posted: Array<Record<string, any>> = [];
  let receive: ((message: unknown) => unknown) | undefined;
  let runsChanged: (() => void) | undefined;
  const state = { sessions: options.sessions ?? [], running: options.running ?? [], historyReads: 0, watched: [] as Array<string | undefined>, ratings: options.ratings as unknown, ratingWrites: 0, roleTests: options.roleTests as unknown, roleTestWrites: 0 };
  const deps: TeamStudioDeps = {
    library, root: () => (options.noRoot ? undefined : root), gather: async () => directoryInput(), knowledgeBase: async () => false,
    sidebar: { prefill: async () => undefined }, openFile: async () => undefined, openSetting: async () => undefined, confirm: async () => true, ask: async () => undefined,
    pickImportSource: async () => undefined, applyProjectType: async () => undefined, drafts: { get: () => undefined, set: async () => undefined }, watch: () => ({ dispose() {} }),
    history: async () => { state.historyReads += 1; return state.sessions; },
    runningTeams: () => state.running,
    onDidChangeRuns: (listener) => { runsChanged = listener; return { dispose() { runsChanged = undefined; } }; },
    watchLive: async (runId?: string) => { state.watched.push(runId); },
    roleTests: { get: () => state.roleTests, set: async (value) => { state.roleTestWrites += 1; state.roleTests = value; } },
    ratings: { get: () => state.ratings, set: async (value) => { state.ratingWrites += 1; state.ratings = value; } }
  };
  attachTeamStudio({ webview: { postMessage: async (message) => { posted.push(message as Record<string, any>); return true; }, onDidReceiveMessage: (listener) => { receive = listener; return { dispose() {} }; } }, onDidDispose: () => ({ dispose() {} }) }, deps);
  const send = async (message: unknown) => { await receive!(message); };
  const latest = (type: string) => [...posted].reverse().find((message) => message.type === type)!;
  return { base, root, library, posted, send, latest, state, deps, runsChanged: () => runsChanged?.() };
}

test('host: the listing carries the dashboard, computed from the history, the running teams and the team files, and never a file path', async () => {
  const h = await host({ sessions: [session('a', '/team:web-team Build it', { runOutcome: 'completed', startedAt: new Date(Date.now() - HOUR).toISOString(), endedAt: new Date(Date.now() - HOUR + 60_000).toISOString(), estimatedCostUsd: 0.4 })] });
  const web = await h.library.create('Web team', withTeamRating(TEAM, 4));
  await mkdir(path.dirname(TeamLibrary.projectTeamFile(h.root)), { recursive: true });
  await writeFile(TeamLibrary.projectTeamFile(h.root), renderTeam('Project team', 'For this repo', [{ name: 'dev', instructions: 'Build it. Report what changed.' }]));
  await h.send({ type: 'ready' });
  const state = h.latest('state');
  const card = state.dashboard.cards['user:web-team'];
  assert.equal(card.status, 'ready');
  assert.equal(card.stats.runs, 1);
  assert.ok(Math.abs(card.stats.spendUsd - 0.4) < 1e-9);
  assert.equal(state.dashboard.cards['project'].status, 'never-run');
  assert.equal(state.dashboard.summary.teams, 2);
  assert.equal(state.dashboard.history, true);
  const listed = state.library.teams.find((entry: any) => entry.id === 'user:web-team');
  assert.equal(listed.rating, 4, 'a rating line from an earlier build is read once into the store');
  assert.equal((h.state.ratings as Record<string, { rating: number }>)['user:web-team']!.rating, 4);
  assert.equal(teamRating(await readFile(web, 'utf8')), 4, 'and nothing is removed from the file');
  // No message the page is sent holds a path on this computer (owner rule: the page never receives file paths).
  for (const message of h.posted) assert.doesNotMatch(JSON.stringify(message), new RegExp(h.base.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')), message.type);
  assert.equal(listed.file, undefined);
  assert.ok(web);
});

test('host: Rate keeps the rating on this computer by the team\'s identity, never in the team file; anything else is refused', async () => {
  const h = await host();
  const file = await h.library.create('Web team', TEAM);
  await h.send({ type: 'ready' });
  const versions = (await h.library.versions(file)).length;
  await h.send({ type: 'rate', id: 'user:web-team', rating: 5 });
  assert.equal(await readFile(file, 'utf8'), TEAM, 'the team file is not touched');
  assert.equal((await h.library.versions(file)).length, versions, 'and no version is made');
  assert.equal((h.state.ratings as Record<string, { rating: number }>)['user:web-team']!.rating, 5);
  assert.equal(h.latest('library').library.teams[0].rating, 5);
  assert.deepEqual([h.latest('rated').id, h.latest('rated').rating], ['user:web-team', 5]);
  assert.match(h.latest('rated').text, /Rated Web team 5 out of 5/);
  assert.equal('base' in h.latest('rated'), false, 'nothing for an open editor to catch up on');
  await h.send({ type: 'rate', id: 'user:web-team', rating: 0 });
  assert.equal((h.state.ratings as Record<string, { rating: number }>)['user:web-team']!.rating, 0, 'cleared, and kept as cleared');
  assert.equal('rating' in h.latest('library').library.teams[0], false);
  assert.match(h.latest('rated').text, /Cleared/);
  assert.equal(await readFile(file, 'utf8'), TEAM);
  // Strict parsing: an id the page was given, and a whole number from 0 (clear) to 5.
  for (const bad of [{ type: 'rate', id: 'user:web-team', rating: 6 }, { type: 'rate', id: 'user:web-team', rating: 2.5 }, { type: 'rate', id: 'user:web-team', rating: '3' }, { type: 'rate', id: '../x', rating: 3 }, { type: 'rate', id: 'archived:web-team', rating: 3 }, { type: 'rate', id: 'user:web-team', rating: 3, extra: 1 }]) assert.equal(parseStudioMessage(bad), undefined, JSON.stringify(bad));
  assert.deepEqual(parseStudioMessage({ type: 'rate', id: 'project', rating: 0 }), { type: 'rate', id: 'project', rating: 0 });
  // A team that is not listed changes nothing.
  const count = h.posted.length;
  await h.send({ type: 'rate', id: 'user:nope', rating: 3 });
  assert.match(h.posted.slice(count).map((message) => message.text).join(' '), /no longer in your teams/);
});

test('host: rating the project team never changes its file in the project, so a code push can never carry it; a line from an earlier build is read once and left in place', async () => {
  const h = await host();
  const projectFile = TeamLibrary.projectTeamFile(h.root);
  await mkdir(path.dirname(projectFile), { recursive: true });
  const legacy = withTeamRating(renderTeam('Project team', 'For this repo', [{ name: 'dev', role: 'implementer', instructions: 'Build it. Report what changed.' }]), 2);
  await writeFile(projectFile, legacy);
  await h.send({ type: 'ready' });
  const key = `project:${await projectIdentity(h.root)}`;
  assert.equal(h.latest('state').library.teams.find((entry: any) => entry.id === 'project').rating, 2, 'read once from the old line');
  assert.equal((h.state.ratings as Record<string, { rating: number }>)[key]!.rating, 2);
  const versions = (await h.library.versions(projectFile)).length;
  for (const rating of [5, 0, 3]) await h.send({ type: 'rate', id: 'project', rating });
  assert.equal(await readFile(projectFile, 'utf8'), legacy, 'byte for byte, the old line included');
  assert.equal((await h.library.versions(projectFile)).length, versions);
  assert.equal((h.state.ratings as Record<string, { rating: number }>)[key]!.rating, 3);
  // Cleared stays cleared: the old line is not read again.
  await h.send({ type: 'rate', id: 'project', rating: 0 });
  await h.send({ type: 'refresh' });
  assert.equal('rating' in h.latest('state').library.teams.find((entry: any) => entry.id === 'project'), false);
  // The project is known by its folder's real path: opened through a link, it is the same project and keeps its rating.
  await h.send({ type: 'rate', id: 'project', rating: 4 });
  const link = path.join(h.base, 'link');
  await symlink(h.root, link);
  const other = await host({ ratings: h.state.ratings });
  (other.deps as { root: () => string }).root = () => link;
  await other.send({ type: 'ready' });
  assert.equal(other.latest('state').library.teams.find((entry: any) => entry.id === 'project').rating, 4);
});

test('host: rating the team open in the editor leaves its file and the editor\'s version as they were', async () => {
  const h = await host();
  await h.library.create('Web team', TEAM);
  await h.send({ type: 'ready' });
  await h.send({ type: 'open', id: 'user:web-team' });
  const opened = h.latest('team');
  await h.send({ type: 'rate', id: 'user:web-team', rating: 3 });
  await h.send({ type: 'save', id: 'user:web-team', base: opened.base, draft: { ...opened.draft, description: 'Builds and tests pages' } });
  assert.equal(h.posted.filter((message) => message.type === 'external-change').length, 0, 'the save was not taken for an outside edit');
  const saved = await readFile(path.join(h.library.directory, 'web-team.md'), 'utf8');
  assert.match(saved, /description: Builds and tests pages/);
  assert.equal(teamRating(saved), undefined, 'no rating in the file');
});

test('host: the run history is read once per listing and again only when a run starts or ends, the folder changes or Refresh is asked; the local check runs again only for a changed file', async () => {
  const h = await host({ running: [{ runId: 'run-web-123456', slug: 'web-team' }] });
  await h.library.create('Web team', TEAM);
  await h.send({ type: 'ready' });
  assert.equal(h.state.historyReads, 1);
  // Messages that list the teams or the dashboard again use the history already read.
  await h.send({ type: 'rate', id: 'user:web-team', rating: 4 });
  await h.send({ type: 'rate', id: 'user:web-team', rating: 2 });
  await h.send({ type: 'watch-live', id: 'user:web-team' });
  await h.send({ type: 'archive', id: 'user:nope' });
  assert.equal(h.state.historyReads, 1);
  assert.deepEqual(h.state.watched, ['run-web-123456'], 'Watch it live finds the run in the listing it holds');
  // A run starting or ending, and Refresh, read it again.
  h.runsChanged();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(h.state.historyReads, 2);
  await h.send({ type: 'refresh' });
  assert.equal(h.state.historyReads, 3);
  // The local check: one run per file content, reused while the file is unchanged.
  const cache = new Map();
  const first = await listLibrary(h.library, h.root, directoryInput(), { checks: cache });
  const second = await listLibrary(h.library, h.root, directoryInput(), { checks: cache });
  assert.equal(cache.size, 1);
  assert.equal(second.teams[0]!.check, first.teams[0]!.check, 'the same result, not checked again');
  await writeFile(path.join(h.library.directory, 'web-team.md'), TEAM.replace('Build it.', 'Build it. Report what changed.'));
  const third = await listLibrary(h.library, h.root, directoryInput(), { checks: cache });
  assert.notEqual(third.teams[0]!.check, first.teams[0]!.check, 'a changed file is checked again');
});

test('host: Watch it live opens Team Live on that team\'s run; a run starting or ending lists the dashboard again from the history', async () => {
  const h = await host({ running: [{ runId: 'run-web-123456', slug: 'web-team' }] });
  await h.library.create('Web team', TEAM);
  await h.send({ type: 'ready' });
  assert.equal(h.latest('state').dashboard.cards['user:web-team'].status, 'running');
  await h.send({ type: 'watch-live', id: 'user:web-team' });
  assert.deepEqual(h.state.watched, ['run-web-123456']);
  await h.send({ type: 'watch-live' });
  assert.deepEqual(h.state.watched, ['run-web-123456', undefined], 'without a team: the newest run, as before');
  assert.deepEqual(parseStudioMessage({ type: 'watch-live', id: 'user:web-team' }), { type: 'watch-live', id: 'user:web-team' });
  assert.equal(parseStudioMessage({ type: 'watch-live', id: '/etc' }), undefined);
  // The run ends: the activity notification (not a timer) lists the dashboard again.
  const reads = h.state.historyReads;
  h.state.running = [];
  h.state.sessions = [session('w', '/team:web-team go', { runOutcome: 'completed', startedAt: new Date(Date.now() - 60_000).toISOString(), endedAt: new Date().toISOString() })];
  h.runsChanged();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const dashboard = h.latest('dashboard').dashboard;
  assert.equal(dashboard.cards['user:web-team'].status, 'ready');
  assert.equal(dashboard.cards['user:web-team'].stats.runs, 1);
  assert.equal(h.state.historyReads, reads + 1);
  // Nothing changes on its own: no reads without a notification.
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(h.state.historyReads, reads + 1);
});

test('host: the role test recorded for a team counts in its health; a broken record, or one for another file, is ignored', async () => {
  const h = await host({ roleTests: 'not a record' });
  const file = await h.library.create('Web team', TEAM);
  await h.send({ type: 'ready' });
  assert.equal(h.latest('state').dashboard.cards['user:web-team'].health.parts[1].score, undefined);
  const record = { at: new Date().toISOString(), members: 1, tested: 1, score: 80 };
  h.state.roleTests = { 'user:elsewhere': record };
  await h.send({ type: 'refresh' });
  assert.equal(h.latest('state').dashboard.cards['user:web-team'].health.parts[1].score, undefined, 'a record for another team is not this team\'s');
  // A record kept under the old path key (an earlier build) moves to the team's identity once, and counts.
  h.state.roleTests = { [legacyRoleTestKey(file)]: record };
  await h.send({ type: 'refresh' });
  assert.deepEqual(h.state.roleTests, { 'user:web-team': record });
  assert.equal(h.state.roleTestWrites, 1);
  await h.send({ type: 'refresh' });
  assert.equal(h.state.roleTestWrites, 1, 'once');
  const health = h.latest('state').dashboard.cards['user:web-team'].health;
  assert.equal(health.parts[1].score, 80, 'from the moved record');
  assert.equal(health.parts[0].score, 95, 'the local check: one suggestion (dev has no role)');
  assert.equal(health.score, 88, 'the average of 95 and 80, rounded');
});

test('host: with no project folder open there is no run history, and the dashboard says so', async () => {
  const h = await host({ noRoot: true });
  await h.library.create('Web team', TEAM);
  await h.send({ type: 'ready' });
  assert.equal(h.latest('state').dashboard.history, false);
  assert.equal(h.state.historyReads, 0, 'no history is read without a project');
});

test('host: Share and Import leave out the person\'s own rating, so it is never sent with a team or taken from someone else', async () => {
  const h = await host();
  const file = await h.library.create('Web team', withTeamRating(TEAM, 5));
  const target = path.join(h.base, 'web-team.near-team.json');
  h.deps.pickShareTarget = async () => target;
  h.deps.choose = async (_message, ...actions) => actions[0];
  await h.send({ type: 'ready' });
  await h.send({ type: 'share', id: 'user:web-team' });
  const shared = JSON.parse(await readFile(target, 'utf8'));
  assert.doesNotMatch(JSON.stringify(shared), /rating: 5/);
  assert.equal(teamRating(await readFile(file, 'utf8')), 5, 'the team itself keeps it');
  const source = path.join(h.base, 'incoming.md');
  await writeFile(source, withTeamRating(renderTeam('Incoming team', 'From elsewhere', [{ name: 'dev', instructions: 'Build it.' }]), 5));
  h.deps.pickImportSource = async () => source;
  await h.send({ type: 'import' });
  assert.equal(teamRating(await readFile(path.join(h.library.directory, 'incoming-team.md'), 'utf8')), undefined);
});

test('host: the dashboard\'s sort and filter are kept for the person, so the tab opens as it was left even after it was closed', async () => {
  const h = await host();
  const kept: { value?: unknown } = {};
  h.deps.view = { get: () => kept.value, set: async (value) => { kept.value = value; } };
  await h.library.create('Web team', TEAM);
  await h.send({ type: 'ready' });
  assert.equal('view' in h.latest('state'), false, 'nothing kept yet');
  await h.send({ type: 'view', sort: 'rating', attention: true });
  assert.deepEqual(kept.value, { sort: 'rating', attention: true });
  await h.send({ type: 'refresh' });
  assert.deepEqual(h.latest('state').view, { sort: 'rating', attention: true });
  // Strictly validated, and anything odd that was kept is not sent.
  for (const bad of [{ type: 'view', sort: 'loudest', attention: true }, { type: 'view', sort: 'name', attention: 'yes' }, { type: 'view', sort: 'name' }, { type: 'view', sort: 'name', attention: false, more: 1 }]) assert.equal(parseStudioMessage(bad), undefined, JSON.stringify(bad));
  kept.value = { sort: 'loudest', attention: 1 };
  await h.send({ type: 'refresh' });
  assert.equal('view' in h.latest('state'), false);
});

test('host: Optimise all teams from the dashboard lists the dashboard again for the new role tests, and ends without a stray error', async () => {
  const h = await host();
  await h.library.create('Web team', TEAM);
  const record = { at: new Date().toISOString(), members: 1, tested: 1, score: 75 };
  h.deps.optimiseCandidates = async () => ['fast'];
  h.deps.optimiseTeam = async (_members, team) => { h.state.roleTests = { 'user:web-team': record }; return { applied: 1, text: `${team}: set 1 model.` }; };
  h.deps.choose = async (_message, ...actions) => actions[0];
  await h.send({ type: 'ready' });
  const before = h.posted.length;
  await h.send({ type: 'optimise-all' });
  const after = h.posted.slice(before);
  assert.equal(after.filter((message) => message.type === 'error').length, 0, JSON.stringify(after.filter((message) => message.type === 'error')));
  assert.equal(h.latest('library').dashboard.cards['user:web-team'].health.parts[1].score, 75);
  // With a team open, the page is not sent that team again under a made-up id (the panel tells an open editor about new models with external-change).
  await h.send({ type: 'open', id: 'user:web-team' });
  const count = h.posted.length;
  await h.send({ type: 'optimise-all' });
  const later = h.posted.slice(count);
  assert.deepEqual(later.filter((message) => message.type === 'team' || message.type === 'error'), []);
  assert.ok(later.some((message) => message.type === 'library'));
});
