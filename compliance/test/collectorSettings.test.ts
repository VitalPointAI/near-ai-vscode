import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingsCollector } from '../src/collectors/settings.ts';
import type { CollectorContext } from '../src/collectors/types.ts';
import { redactObservation } from '../src/redact.ts';

const now = new Date('2026-11-21T00:00:00Z');
const sha = 'a'.repeat(40);
const flag = (enabled: boolean) => ({ enabled });

function protection(docs = true) {
  const checks = ['lint', 'test', 'e2e', 'release-content', 'audit', 'secret-scan', 'relay', 'hub', ...(docs ? ['docs'] : [])]
    .map((context) => ({ context, app_id: 15368 }));
  return {
    required_status_checks: { strict: true, checks: [...checks, { context: 'agent-review', app_id: -1 }] },
    enforce_admins: flag(true), required_linear_history: flag(true), allow_force_pushes: flag(false),
    allow_deletions: flag(false), required_conversation_resolution: flag(true),
    required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true }
  };
}

function environment(name: string) {
  return {
    name, can_admins_bypass: false,
    protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { id: 123, login: 'private-operator' } }] }],
    deployment_branch_policy: { protected_branches: name === 'agent-review-gates', custom_branch_policies: name === 'marketplace' }
  };
}

const context = (docs = true): CollectorContext => ({
  now, commit: sha, readFile: async () => '',
  fetchJson: async (input) => {
    const { pathname } = new URL(input);
    if (pathname.endsWith('/protection')) return protection(docs);
    if (pathname.endsWith('/deployment-branch-policies')) return { branch_policies: [{ type: 'tag', name: 'v*.*.*' }] };
    if (pathname.includes('/environments/')) return environment(pathname.split('/').at(-1)!);
    return { errors: [] };
  }
});

const collect = (ctx = context()) => settingsCollector.collect({ repository: 'acme/demo' }, ctx);

function replaceResponse(pathSuffix: string, reply: unknown, ctx = context()): CollectorContext {
  return { ...ctx, fetchJson: async (url, init) => new URL(url).pathname.endsWith(pathSuffix) ? reply : ctx.fetchJson!(url, init) };
}

test('main protection requires the documented flags and CI app sources, docs among them', async () => {
  const rows = await collect();
  assert.equal(rows.find((row) => row.subject === 'required-checks')?.passed, true);
  assert.equal(rows.find((row) => row.subject === 'main-change-protection')?.passed, true);
  assert.equal(rows.find((row) => row.subject === 'docs-required')?.passed, true);
  assert.equal(rows.find((row) => row.subject === 'review-required')?.passed, true);
  const withoutDocs = await collect(context(false));
  assert.equal(withoutDocs.find((row) => row.subject === 'docs-required')?.passed, false);
  assert.equal(withoutDocs.find((row) => row.subject === 'required-checks')?.passed, false);
});

test('names without the right check app, non-strict checks and duplicate checks cannot pass', async () => {
  for (const tweak of ['list-only', 'wrong-app', 'non-strict', 'duplicate']) {
    const config = protection(true);
    const ok = config.required_status_checks;
    if (tweak === 'wrong-app') ok.checks[0].app_id = 23;
    if (tweak === 'non-strict') ok.strict = false;
    if (tweak === 'duplicate') ok.checks.push({ ...ok.checks[0] });
    const rows = await collect(replaceResponse('/protection', tweak === 'list-only' ? {
      ...config, required_status_checks: { strict: true, contexts: ok.checks.map(({ context }) => context) }
    } : config));
    assert.equal(rows.find((row) => row.subject === 'required-checks')?.passed, false, tweak);
    assert.equal(rows.find((row) => row.subject === 'main-change-protection')?.passed, false, tweak);
  }
  const config = protection(true);
  config.required_status_checks.checks.find((row) => row.context === 'docs')!.app_id = 23;
  const rows = await collect(replaceResponse('/protection', config));
  assert.equal(rows.find((row) => row.subject === 'docs-required')?.passed, false);
});

test('main protection rejects allowed force pushes or deletion, missing flags and reviews that survive new pushes', async () => {
  const valid = protection();
  for (const change of [
    { enforce_admins: flag(false) }, { required_linear_history: undefined },
    { allow_force_pushes: flag(true) }, { allow_deletions: flag(true) }, { required_conversation_resolution: flag(false) },
    { required_pull_request_reviews: { required_approving_review_count: 0, dismiss_stale_reviews: true } },
    { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: false } }
  ]) {
    const rows = await collect(replaceResponse('/protection', { ...valid, ...change }));
    assert.equal(rows.find((row) => row.subject === 'main-change-protection')?.passed, false, JSON.stringify(change));
  }
  assert.equal((await collect(replaceResponse('/protection', null))).find((row) => row.subject === 'main-change-protection')?.passed, false);
});

test('environment configuration checks required reviewers, explicit bypass restriction and allowed refs', async () => {
  const rows = await collect();
  assert.equal(rows.find((row) => row.subject === 'environment-marketplace')?.passed, true);
  assert.equal(rows.find((row) => row.subject === 'environment-agent-review-gates')?.passed, true);
  assert.ok(!JSON.stringify(rows).includes('private-operator'));
  const valid = environment('marketplace');
  for (const change of [{ can_admins_bypass: true }, { can_admins_bypass: undefined },
    { protection_rules: [] }, { deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } }]) {
    const rows = await collect(replaceResponse('/environments/marketplace', { ...valid, ...change }));
    assert.equal(rows.find((row) => row.subject === 'environment-marketplace')?.passed, false);
  }
  const wrongRef = await collect(replaceResponse('/deployment-branch-policies', { branch_policies: [{ type: 'branch', name: 'v*.*.*' }] }));
  assert.equal(wrongRef.find((row) => row.subject === 'environment-marketplace')?.passed, false);
  assert.deepEqual(rows.find((row) => row.subject === 'tag-ruleset')?.counts, { unverified: 1 });
  assert.equal(rows.find((row) => row.subject === 'tag-ruleset')?.passed, false);
});

test('a codeowners error fails codeowners-valid with only an error count', async () => {
  const rows = await collect(replaceResponse('/codeowners/errors', { errors: [{ path: '.github/CODEOWNERS', message: 'private text' }] }));
  const row = rows.find((item) => item.subject === 'codeowners-valid');
  assert.equal(row?.passed, false);
  assert.equal(row?.counts?.errors, 1);
  assert.ok(!JSON.stringify(row).includes('private text'));
});

test('a 403 is an Administration read permission error', async () => {
  const denied: CollectorContext = { ...context(), fetchJson: async () => { throw Object.assign(new Error('denied'), { status: 403 }); } };
  await assert.rejects(collect(denied), (e: Error & { code?: string }) => e.code === 'permission' && e.message.includes('Administration read'));
});

const file = { path: 'CODEOWNERS', mode: '100644', type: 'blob', sha: 'c'.repeat(40), size: 100 };
const dotGithub = { path: '.github', mode: '040000', type: 'tree', sha: 'b'.repeat(40) };
const tree = (entries: unknown[]) => ({ truncated: false, tree: entries });

function codeownersContext(read: (url: URL) => unknown): CollectorContext {
  const base = context();
  return { ...base, fetchJson: async (url, init) => {
    const endpoint = new URL(url);
    if (endpoint.pathname.endsWith('/codeowners/errors') || endpoint.pathname.includes('/git/trees/')) return read(endpoint);
    return base.fetchJson!(url, init);
  } };
}

test('codeowners-valid checks syntax and a normal file at the assessed commit, without publishing file metadata', async () => {
  const checked: string[] = [];
  const fixture = codeownersContext((url) => {
    checked.push(url.pathname + url.search);
    if (url.pathname.endsWith('/errors')) return { errors: [] };
    return url.pathname.endsWith(dotGithub.sha) ? tree([file]) : tree([dotGithub]);
  });
  const rows = await settingsCollector.collect({ repository: 'acme/demo' }, fixture);
  assert.deepEqual(checked, [
    `/repos/acme/demo/codeowners/errors?ref=${fixture.commit}`,
    `/repos/acme/demo/git/trees/${fixture.commit}`,
    `/repos/acme/demo/git/trees/${dotGithub.sha}`
  ]);
  const observation = rows.find((row) => row.subject === 'codeowners-valid');
  assert.ok(observation);
  assert.deepEqual(redactObservation(observation), { collector: 'settings', subject: 'codeowners-valid',
    passed: true, collectedAt: fixture.now.toISOString(), commit: fixture.commit, counts: { errors: 0 } });
});

test('missing or malformed CODEOWNERS responses cannot pass or hide other settings evidence', async () => {
  for (const response of [null, {}, { errors: 'none' }, { errors: null }]) {
    const rows = await settingsCollector.collect({ repository: 'acme/demo' }, codeownersContext(() => response));
    assert.deepEqual(rows.find((row) => row.subject === 'codeowners-valid')?.counts, { unverified: 1 });
    assert.equal(rows.find((row) => row.subject === 'codeowners-valid')?.passed, false);
    assert.equal(rows.find((row) => row.subject === 'required-checks')?.passed, true);
  }
  const denied = codeownersContext(() => { throw Object.assign(new Error('denied'), { status: 403 }); });
  const rows = await settingsCollector.collect({ repository: 'acme/demo' }, denied);
  assert.equal(rows.find((row) => row.subject === 'codeowners-valid')?.passed, false);
  assert.equal(rows.find((row) => row.subject === 'required-checks')?.passed, true);
});

test('CODEOWNERS search uses GitHub location precedence and refuses missing, invalid or incomplete file evidence', async () => {
  const docs = { ...dotGithub, path: 'docs', sha: 'd'.repeat(40) };
  for (const [root, nested, expected, counts] of [
    [tree([]), tree([]), false, { missing: 1 }],
    [{ truncated: true, tree: [file] }, tree([]), false, { unverified: 1 }],
    [tree([dotGithub, file]), tree([{ ...file, mode: '120000' }]), false, { invalid: 1 }],
    [tree([{ ...file, size: 3_000_000 }]), tree([]), false, { invalid: 1 }],
    [tree([dotGithub, file, docs]), tree([]), true, { errors: 0 }],
    [tree([docs]), tree([file]), true, { errors: 0 }]
  ] as const) {
    const fixture = codeownersContext((url) => url.pathname.endsWith('/errors') ? { errors: [] } :
      url.pathname.endsWith(dotGithub.sha) || url.pathname.endsWith(docs.sha) ? nested : root);
    const rows = await settingsCollector.collect({ repository: 'acme/demo' }, fixture);
    const observation = rows.find((row) => row.subject === 'codeowners-valid');
    assert.equal(observation?.passed, expected);
    assert.deepEqual(observation?.counts, counts);
  }
});
