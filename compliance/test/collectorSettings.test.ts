import { test } from 'node:test'; import assert from 'node:assert/strict'; import { settingsCollector } from '../src/collectors/settings.ts'; import type { CollectorContext } from '../src/collectors/types.ts';
import { redactObservation } from '../src/redact.ts';
const context = (docs = false, bypass = false): CollectorContext => ({ now: new Date('2026-11-21T00:00:00Z'), commit: 'a'.repeat(40), readFile: async () => '', fetchJson: async (url) => url.includes('/protection') ? { required_status_checks: { contexts: ['lint', 'test', 'e2e', 'release-content', 'audit', 'secret-scan', 'relay', 'hub', 'agent-review', ...(docs ? ['docs'] : [])] }, enforce_admins: { enabled: true }, required_pull_request_reviews: { required_approving_review_count: 1 } } : url.includes('/rulesets') ? [{ name: 'protect tags' }, { name: 'release tag rules' }] : url.includes('/environments') ? { environments: [{ name: 'marketplace', can_admins_bypass: bypass }, { name: 'agent-review-gates', can_admins_bypass: false }] } : { errors: [] } });
test('settings holds required checks while docs-required stays visibly failed', async () => { const rows = await settingsCollector.collect({ repository: 'acme/demo' }, context()); assert.equal(rows.find((row) => row.subject === 'required-checks')?.passed, true); assert.equal(rows.find((row) => row.subject === 'docs-required')?.passed, false); assert.equal(rows.find((row) => row.subject === 'review-required')?.passed, true); });
test('adding docs makes docs-required pass', async () => { const rows = await settingsCollector.collect({ repository: 'acme/demo' }, context(true)); assert.equal(rows.find((row) => row.subject === 'docs-required')?.passed, true); });
test('admin bypass makes marketplace environment fail', async () => { const rows = await settingsCollector.collect({ repository: 'acme/demo' }, context(false, true)); assert.equal(rows.find((row) => row.subject === 'environment-marketplace')?.passed, false); });
test('enforce admins false fails that setting', async () => { const rows = await settingsCollector.collect({ repository: 'acme/demo' }, { ...context(), fetchJson: async (url) => url.includes('/protection') ? { required_status_checks: { contexts: ['lint', 'test', 'e2e', 'release-content', 'audit', 'secret-scan', 'relay', 'hub', 'agent-review'] }, enforce_admins: { enabled: false }, required_pull_request_reviews: { required_approving_review_count: 1 } } : url.includes('/rulesets') ? [{ name: 'tag one' }, { name: 'tag two' }] : url.includes('/environments') ? { environments: [{ name: 'marketplace', can_admins_bypass: false }, { name: 'agent-review-gates', can_admins_bypass: false }] } : { errors: [] } }); assert.equal(rows.find((row) => row.subject === 'enforce-admins')?.passed, false); });
test('zero required approvals fails review-required', async () => { const rows = await settingsCollector.collect({ repository: 'acme/demo' }, { ...context(), fetchJson: async (url) => url.includes('/protection') ? { required_status_checks: { contexts: ['lint', 'test', 'e2e', 'release-content', 'audit', 'secret-scan', 'relay', 'hub', 'agent-review'] }, enforce_admins: { enabled: true }, required_pull_request_reviews: { required_approving_review_count: 0 } } : url.includes('/rulesets') ? [{ name: 'tag one' }, { name: 'tag two' }] : url.includes('/environments') ? { environments: [{ name: 'marketplace', can_admins_bypass: false }, { name: 'agent-review-gates', can_admins_bypass: false }] } : { errors: [] } }); assert.equal(rows.find((row) => row.subject === 'review-required')?.passed, false); });
test('a codeowners error fails codeowners-valid with only an error count', async () => { const rows = await settingsCollector.collect({ repository: 'acme/demo' }, { ...context(), fetchJson: async (url) => url.includes('/protection') ? { required_status_checks: { contexts: ['lint', 'test', 'e2e', 'release-content', 'audit', 'secret-scan', 'relay', 'hub', 'agent-review'] }, enforce_admins: { enabled: true }, required_pull_request_reviews: { required_approving_review_count: 1 } } : url.includes('/rulesets') ? [{ name: 'tag one' }, { name: 'tag two' }] : url.includes('/environments') ? { environments: [{ name: 'marketplace', can_admins_bypass: false }, { name: 'agent-review-gates', can_admins_bypass: false }] } : { errors: [{ path: '.github/CODEOWNERS', message: 'private text' }] } }); const row = rows.find((item) => item.subject === 'codeowners-valid'); assert.equal(row?.passed, false); assert.equal(row?.counts?.errors, 1); assert.ok(!JSON.stringify(row).includes('private text')); });
test('a 403 is an Administration read permission error', async () => { const denied: CollectorContext = { ...context(), fetchJson: async () => { throw Object.assign(new Error('denied'), { status: 403 }); } }; await assert.rejects(settingsCollector.collect({ repository: 'acme/demo' }, denied), (e: Error & { code?: string }) => e.code === 'permission' && e.message.includes('Administration read')); });

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
