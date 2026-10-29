import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ActivitySessionSummary, emptyAgentCounts, emptySessionStats, hostAttribution } from '../domain/activity';
import type { SpendEntry } from '../services/spendLedger';
import { buildUsageReport, customRange, usageCsv, usageJson, usageOrganizations, UsageProject, usageRange } from '../services/usageReport';

const NOW = Date.UTC(2026, 9, 28, 15, 0, 0);
const HOUR = 3_600_000;

function withVscodeStub<T>(load: () => T): T {
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  nodeModule._load = (request, parent, isMain) => request === 'vscode' ? { workspace: { workspaceFolders: undefined, getConfiguration: () => ({ get: (_k: string, fallback: unknown) => fallback }) }, window: {}, commands: {}, Uri: { file: (p: string) => ({ fsPath: p }) } } : originalLoad(request, parent, isMain);
  try { return load(); } finally { nodeModule._load = originalLoad; }
}

const orgA = hostAttribution('project-alpha-0001', 'alpha', 'profile-company-a', 'Company A');
const orgB = hostAttribution('project-beta-0002', 'beta', 'profile-company-b', 'Company B');

function session(id: string, startedAt: number, attribution: typeof orgA, patch: Partial<ActivitySessionSummary> = {}): ActivitySessionSummary {
  return { version: 1, sessionId: `session-${id}-0000`, project: attribution.projectLabel, attribution, plans: [], agents: emptyAgentCounts(), models: ['z-ai/glm-5.3'], approvals: { required: 0, approved: 0, pending: 0 }, startedAt: new Date(startedAt).toISOString(), updatedAt: new Date(startedAt).toISOString(), outcome: 'completed', continuationAvailable: true, context: { userTurns: 0, assistantTurns: 0 }, events: [], runId: `run-${id}-abcdef`, conversationId: `conv-${id}-123456`, ...patch };
}

function entry(id: string, runId: string | undefined, at: number, patch: Partial<SpendEntry> = {}): SpendEntry {
  return { id, writer: 'w', at, path: '/v1/chat/completions', status: 'completed', model: 'z-ai/glm-5.3', estimateNanoUsd: 2_000_000, inputTokens: 100, outputTokens: 10, ...(runId ? { runId } : {}), ...patch };
}

const projects: UsageProject[] = [
  { root: '/work/alpha', label: 'alpha', sessions: [
    session('a1', NOW - 1 * HOUR, orgA, { title: 'Fix the login bug', stats: { ...emptySessionStats(), agents: 3, rateLimited: 2, retries: 3, models: { 'z-ai/glm-5.3': { agents: 3, turns: 4, retries: 3, rateLimited: 2, errors: 0, stopped: 0, inputTokens: 0, outputTokens: 0 } } }, runOutcome: 'completed' }),
    session('a2', NOW - 40 * 24 * HOUR, orgA, { title: 'Long ago' })
  ] },
  { root: '/work/beta', label: 'beta', sessions: [session('b1', NOW - 2 * HOUR, orgB, { title: '=cmd|calc deploy', runOutcome: 'failed' })] }
];
const entries = [
  entry('e1', 'run-a1-abcdef', NOW - HOUR, { requestId: 'r1', actualNanoUsd: 3_000_000 }),
  entry('e2', 'run-a1-abcdef', NOW - HOUR, { requestId: 'r2', model: 'qwen/qwen3' }),
  // The same NEAR request recorded twice (two windows) counts once.
  entry('e2b', 'run-a1-abcdef', NOW - HOUR, { requestId: 'r2', model: 'qwen/qwen3' }),
  entry('e3', 'run-b1-abcdef', NOW - 2 * HOUR, { requestId: 'r3', actualNanoUsd: 1_000_000 }),
  // Spend not tied to a run in these projects (another window, @nearAi in VS Code's chat).
  entry('e4', undefined, NOW - 3 * HOUR, { kind: 'participant' })
];

test('the usage report filters by organization, project, and dates, per run and per model', () => {
  const week = usageRange('week', NOW, 'utc');
  const all = buildUsageReport({ projects, entries, filter: week, now: NOW });
  assert.deepEqual(all.runs.map((run) => run.runId), ['run-a1-abcdef', 'run-b1-abcdef'], 'newest first; the 40-day-old run is outside');
  assert.equal(all.totals.requests, 5);
  assert.ok(Math.abs(all.totals.confirmedUsd - 0.004) < 1e-9);
  assert.ok(Math.abs(all.totals.pendingUsd - 0.004) < 1e-9, 'r2 once, plus the untagged estimate');
  const a1 = all.runs[0];
  assert.deepEqual([a1.organization, a1.project, a1.conversationId, a1.agents, a1.inputTokens, a1.outcome], ['Company A', 'alpha', 'conv-a1-123456', 3, 300, 'completed']);
  assert.ok(Math.abs(a1.confirmedUsd - 0.003) < 1e-9 && Math.abs(a1.pendingUsd - 0.002) < 1e-9);
  assert.match(a1.models, /z-ai\/glm-5\.3/);
  const glm = all.models.find((model) => model.model === 'z-ai/glm-5.3')!;
  assert.deepEqual([glm.runs, glm.requests, glm.rateLimited, glm.retries], [2, 3, 2, 3]);
  const onlyB = buildUsageReport({ projects, entries, filter: { ...week, organizationProfileId: 'profile-company-b' }, now: NOW });
  assert.deepEqual(onlyB.runs.map((run) => run.project), ['beta']);
  assert.equal(onlyB.totals.requests, 1, 'only the ledger entries of that organization\'s runs');
  const onlyAlpha = buildUsageReport({ projects, entries, filter: { ...week, projectRoot: '/work/alpha' }, now: NOW });
  assert.deepEqual([onlyAlpha.runs.length, onlyAlpha.totals.requests, onlyAlpha.filter.project], [1, 3, 'alpha']);
  const month = buildUsageReport({ projects, entries, filter: usageRange('month', NOW, 'utc'), now: NOW });
  assert.equal(month.runs.length, 2, '40 days ago is outside 30 days too');
  assert.equal(buildUsageReport({ projects, entries, filter: customRange('2026-09-10', '2026-09-20', 'utc')!, now: NOW }).runs.length, 1);
  assert.deepEqual(usageOrganizations(projects), [{ id: 'profile-company-a', label: 'Company A' }, { id: 'profile-company-b', label: 'Company B' }]);
  // NEAR's own figure, today, unfiltered.
  const today = buildUsageReport({ projects, entries, filter: usageRange('today', NOW, 'utc'), now: NOW, nearTodayUsd: 1.5 });
  assert.equal(today.totals.costText, '$1.50 (NEAR)');
  assert.equal(buildUsageReport({ projects, entries, filter: { ...usageRange('today', NOW, 'utc'), projectRoot: '/work/alpha' }, now: NOW, nearTodayUsd: 1.5 }).totals.nearUsd, undefined, 'not for one project');
});

test('date ranges: today, 7 and 30 days, and custom dates by the local or UTC day', () => {
  assert.equal(usageRange('today', NOW, 'utc').since, Date.UTC(2026, 9, 28));
  assert.equal(usageRange('week', NOW, 'utc').since, Date.UTC(2026, 9, 22));
  assert.equal(usageRange('month', NOW, 'utc').since, Date.UTC(2026, 8, 29));
  const local = new Date(NOW);
  assert.equal(usageRange('today', NOW, 'local').since, new Date(local.getFullYear(), local.getMonth(), local.getDate()).getTime());
  assert.deepEqual(customRange('2026-10-01', '2026-10-02', 'utc'), { since: Date.UTC(2026, 9, 1), until: Date.UTC(2026, 9, 3) });
  assert.equal(customRange('2026-10-02', '2026-10-01', 'utc'), undefined);
  assert.equal(customRange('2026-02-30', '2026-03-01', 'utc'), undefined);
  assert.equal(customRange('yesterday', '2026-03-01', 'utc'), undefined);
});

test('CSV and JSON exports carry no prompt content, redact titles, and defuse spreadsheet formulas', () => {
  const withSecret = projects.map((project) => ({ ...project, sessions: project.sessions.map((item) => item.sessionId === 'session-a1-0000' ? { ...item, title: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789AB now', events: [{ id: 'x', sessionId: item.sessionId, timestamp: '', kind: 'tool' as const, status: 'running' as const, summary: 'Write secret-notes.txt' }] } : item) }));
  const report = buildUsageReport({ projects: withSecret, entries, filter: usageRange('week', NOW, 'utc'), now: NOW });
  const csv = usageCsv(report);
  const json = usageJson(report);
  for (const text of [csv, json]) {
    assert.doesNotMatch(text, /ghp_abcdefghij|secret-notes|events/);
    assert.match(text, /run-a1-abcdef/);
  }
  const [header, ...rows] = csv.trim().split('\r\n');
  assert.equal(header.split(',')[0], 'kind');
  assert.ok(header.includes('confirmedUsd') && header.includes('pendingUsd') && header.includes('rateLimited'));
  assert.deepEqual(rows.map((row) => row.split(',')[0]), ['run', 'run', 'model', 'model', 'total']);
  assert.match(csv, /'=cmd\|calc/, 'a cell that starts with = is not a formula');
  const parsed = JSON.parse(json) as { runs: unknown[]; models: unknown[]; totals: { costText: string } };
  assert.equal(parsed.runs.length, 2);
  assert.match(parsed.totals.costText, /confirmed/);
});

test('the save dialog starts outside the workspace, and a target inside a git work tree is detected', async () => {
  const { defaultExportPath, gitWorkTreeOf } = withVscodeStub(() => require('../services/usageExport') as typeof import('../services/usageExport'));
  assert.equal(defaultExportPath('u.csv', '/home/me', (candidate) => candidate === '/home/me/Downloads'), path.join('/home/me', 'Downloads', 'u.csv'));
  assert.equal(defaultExportPath('u.csv', '/home/me', () => false), path.join('/home/me', 'u.csv'));
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-usage-git-'));
  await mkdir(path.join(root, 'repo', '.git'), { recursive: true });
  await mkdir(path.join(root, 'repo', 'docs'), { recursive: true });
  assert.equal(gitWorkTreeOf(path.join(root, 'repo', 'docs', 'usage.csv')), path.join(root, 'repo'));
  assert.equal(gitWorkTreeOf(path.join(root, 'elsewhere', 'usage.csv'), (candidate) => candidate.startsWith(root) && candidate.endsWith(`${path.sep}repo${path.sep}.git`)), undefined);
  const source = readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'usageExport.ts'), 'utf8');
  assert.match(source, /defaultUri: vscode\.Uri\.file\(suggested\)/);
  assert.match(source, /is inside a git work tree/);
});

test('the command is contributed and reachable from Agent Activity and the Tools directory', () => {
  const manifest = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string }> } };
  assert.equal(manifest.contributes.commands.find((command) => command.command === 'nearAi.exportAnalytics')?.title, 'Export Usage and Activity…');
  const tools = readFileSync(path.join(__dirname, '..', '..', 'media', 'tools', 'tools.js'), 'utf8');
  assert.match(tools, /\['Export usage and activity', 'nearAi\.exportAnalytics'\]/);
  const { PAGE_COMMANDS } = require('../services/toolsDirectory') as typeof import('../services/toolsDirectory');
  assert.ok((PAGE_COMMANDS as readonly string[]).includes('nearAi.exportAnalytics'));
  const { parseActivityViewMessage } = withVscodeStub(() => require('../services/activityView') as typeof import('../services/activityView'));
  assert.deepEqual(parseActivityViewMessage({ type: 'export-usage' }), { type: 'export-usage' });
  assert.match(readFileSync(path.join(__dirname, '..', '..', 'media', 'activity', 'activity.js'), 'utf8'), /type: 'export-usage'/);
});
