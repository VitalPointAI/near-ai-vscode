// 48.2-10 (D-05, D-09, D-12, D-18, D-25, D-26): the Compliance view's pure presentation helpers, held to the approved 48.2-UI-SPEC. The
// browser shows what these give; it never computes a state, a freshness or a verification. The DOM itself is checked on the built image by
// 48.2-16.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  ageWords, attentionCounts, cellFacts, COMPLIANCE_TEXT, componentLines, displayCounts, filterCells, formatTime, nextViewState, notices, projectionCard,
  releaseCard, siteCard, viewCells,
  type EvidenceComponent, type EvidenceRow, type EvidenceSnapshot, type ViewContext, type ViewFilters
} from '../extension/src/common/compliance-evidence.ts';

const NOW = Date.parse('2026-11-25T14:00:00.000Z');
const LIVE: ViewContext = { now: NOW, pause: 'live', timeZone: 'UTC' };
const BUILT = '2026-11-25T10:00:00.000Z';
const DEFAULT_FILTERS: ViewFilters = { level: '', state: '', freshness: '', source: 'layered', query: '' };

function component(overrides: Partial<EvidenceComponent> = {}): EvidenceComponent {
  return {
    component: 'workbench', responsibility: 'product', state: 'met', reasonText: 'Evidence shows every statement.',
    evidence: [{ rule: 'site.au-05.openbao', passed: true, collectedAt: '2026-11-25T13:00:00.000Z', window: 'live', freshness: 'ageing', source: 'site' }], ...overrides,
  };
}
function cell(overrides: Partial<EvidenceRow> = {}): EvidenceRow {
  return {
    level: 'unclassified', control: 'au-05', label: 'AU-5', title: 'Response to audit logging process failures', state: 'met', displayState: 'met', reasonText: 'Met.',
    components: [component()], source: 'release', sources: ['site'], asOf: '2026-11-25T13:00:00.000Z', freshness: 'ageing', verification: 'verified', ...overrides,
  };
}
function snapshot(overrides: Partial<EvidenceSnapshot> = {}, rows: EvidenceRow[] = [cell()]): EvidenceSnapshot {
  return {
    revision: 3, judgedAt: iso(NOW), setting: 'site',
    release: { verification: 'verified', anchor: 'organization', version: '0.5.0', commit: 'a'.repeat(40), asOf: BUILT, checkedAt: '2026-11-25T13:59:00.000Z', bundle: 'included', package: 'included',
      scan: { builtAt: '2026-11-20T06:00:00.000Z', freshness: 'current' }, levels: [{ id: 'unclassified', title: 'Unclassified', claim: true }], rows },
    site: { verification: 'verified', site: 'site-a', lastUpdate: '2026-11-25T13:55:00.000Z', lastCollected: '2026-11-25T13:50:00.000Z', items: { current: 4, ageing: 1, outOfDate: 0 },
      files: [{ file: 'trust', verification: 'verified', signedAt: BUILT }, { file: 'live', verification: 'verified', signedAt: '2026-11-25T13:55:00.000Z', keyVersion: 1 }],
      policy: { source: 'site', clamped: [] }, notes: [] },
    ...overrides,
  };
}
const iso = (ms: number) => new Date(ms).toISOString();

test('cell words: source, as-of, freshness and verification in the UI-SPEC words and codicons, read together in the accessible label', () => {
  assert.equal(formatTime('2026-11-25T13:00:00.000Z', 'UTC'), '25 Nov 2026 13:00 UTC');
  assert.equal(ageWords('2026-11-25T13:58:00.000Z', NOW), '2 minutes ago');
  assert.equal(ageWords('2026-11-23T13:00:00.000Z', NOW), '2 days ago');
  assert.equal(ageWords('2026-11-25T14:03:00.000Z', NOW), 'just now');
  const facts = cellFacts(cell(), LIVE);
  assert.deepEqual(facts.source, { icon: 'server', words: 'Your site' });
  assert.deepEqual(facts.asOf, { icon: undefined, words: 'as of 25 Nov 2026 13:00 UTC', datetime: '2026-11-25T13:00:00.000Z' });
  assert.deepEqual(facts.freshness, { value: 'ageing', icon: 'clock', words: 'Ageing' });
  assert.deepEqual(facts.verification, { value: 'verified', icon: 'verified-filled', words: 'Verified' });
  assert.deepEqual(facts.count, { icon: 'checklist', words: '1 evidence item' });
  assert.equal(facts.label, 'AU-5 · Response to audit logging process failures. Met. Source: Your site. As of 25 Nov 2026 13:00 UTC. Freshness: Ageing. Verified. 1 evidence item.');
  assert.equal(cellFacts(cell({ sources: ['release', 'site'] }), LIVE).source.words, 'Release and your site');
  assert.deepEqual(cellFacts(cell({ sources: ['reference-site'] }), LIVE).source, { icon: 'references', words: 'Supplier reference site' });
  const empty = cellFacts(cell({ sources: [], asOf: undefined, freshness: 'none', components: [component({ evidence: [] })] }), LIVE);
  assert.deepEqual([empty.source.words, empty.asOf, empty.freshness.words, empty.count], ['Release', undefined, 'No evidence', undefined]);
  assert.equal(cellFacts(cell({ freshness: 'unknown' }), { ...LIVE, clock: true }).freshness.words, 'Unknown (this computer’s clock is earlier than the release build)');
});

test('never passing: a Met cell that is Not verified shows Not verified, is never counted as Met, and Did not verify gives no cells', () => {
  const unverified = cell({ verification: 'not-verified', displayState: 'not-verified' });
  const facts = cellFacts(unverified, LIVE);
  assert.deepEqual(facts.verification, { value: 'not-verified', icon: 'unverified', words: 'Not verified' });
  assert.match(facts.label, /^AU-5 · Response to audit logging process failures\. Not verified\./);
  const counts = displayCounts([unverified, cell()]);
  assert.equal(counts.met, 1);
  assert.equal(counts['not-verified'], 1);
  const failed = snapshot({ release: { verification: 'did-not-verify', reason: 'hash', file: 'sbom/sterling-image-sbom.cdx.json' } });
  assert.deepEqual(viewCells(failed, 'layered'), []);
  assert.equal(releaseCard(failed, LIVE).facts.length, 0, 'no facts from content that failed');
});

test('revision: a new view model keeps the filters, the page count and the open detail while the cell still exists', () => {
  const state = { filters: { ...DEFAULT_FILTERS, state: 'met', query: 'au' }, openKey: 'unclassified/au-05', shown: 48 };
  const kept = nextViewState(state, snapshot({ revision: 4 }));
  assert.deepEqual(kept, state);
  const gone = nextViewState(state, snapshot({ revision: 5 }, [cell({ control: 'au-06', label: 'AU-6' })]));
  assert.deepEqual(gone, { ...state, openKey: undefined });
});

test('cards: the release card and the site card give their facts in the UI-SPEC words', () => {
  const release = releaseCard(snapshot(), LIVE);
  assert.equal(release.title, 'Release evidence');
  assert.deepEqual(release.badge, { verification: 'verified', icon: 'verified-filled', words: 'Verified' });
  assert.deepEqual(release.facts.map(({ dt, dd }) => [dt, dd]), [
    ['Release', 'Sterling Sovereign AI 0.5.0'], ['Built', '25 Nov 2026 10:00 UTC'], ['Verified with', 'your organization’s site key'], ['Checked', '25 Nov 2026 13:59 UTC'],
    ['Vulnerability scan', 'database built 20 Nov 2026 06:00 UTC (5 days ago) · Current'], ['Software list (SBOM)', 'included'],
  ]);
  const supplier = snapshot({ setting: 'single-computer' });
  if (supplier.release.verification === 'verified') (supplier.release as { anchor: string }).anchor = 'supplier';
  assert.equal(releaseCard(supplier, LIVE).facts.find(({ dt }) => dt === 'Verified with')?.dd, 'the release key you configured');
  const site = siteCard(snapshot(), LIVE);
  assert.equal(site.title, 'Your site’s evidence');
  assert.deepEqual(site.facts.map(({ dt, dd }) => [dt, dd]), [
    ['Site', 'site-a'], ['Last update', '25 Nov 2026 13:55 UTC (5 minutes ago)'], ['Items', '4 current · 1 ageing · 0 out of date'], ['Freshness settings', 'your site’s'],
  ]);
  const none = siteCard(snapshot({ site: { verification: 'none', files: [], notes: [], policy: { source: 'release-defaults', reason: 'no-site-policy', clamped: [] } } }), LIVE);
  assert.equal(none.badge, undefined);
  assert.deepEqual(none.messages, [COMPLIANCE_TEXT.siteNoneSite]);
});

test('release only: with no site layer, the release-only line, at a site or on a single computer, whatever the workspace trust', () => {
  const noSite = { verification: 'none' as const, files: [], notes: [], policy: { source: 'release-defaults' as const, reason: 'no-site-policy' as const, clamped: [] } };
  for (const setting of ['site', 'single-computer'] as const) {
    const card = releaseCard(snapshot({ setting, site: noSite }), LIVE);
    assert.equal(card.onlyLine, 'This is the release’s own evidence. Nothing here shows how your site runs it.');
  }
  assert.equal(releaseCard(snapshot(), LIVE).onlyLine, undefined, 'not when your site\'s evidence is there');
  assert.deepEqual(siteCard(snapshot({ setting: 'single-computer', site: noSite }), LIVE).messages, [COMPLIANCE_TEXT.siteNoneSingle]);
});

test('no control evidence: a release folder with bundle: none shows its SBOM and scan and says it carries no control evidence', () => {
  const bare = snapshot({ release: { verification: 'verified', anchor: 'supplier', version: '0.5.1', commit: 'b'.repeat(40), asOf: BUILT, checkedAt: BUILT, bundle: 'none', package: 'none',
    scan: { builtAt: '2026-11-20T06:00:00.000Z', freshness: 'current' }, levels: [], rows: [] } });
  const card = releaseCard(bare, LIVE);
  assert.ok(card.facts.some(({ dt }) => dt === 'Software list (SBOM)'));
  assert.ok(card.facts.some(({ dt }) => dt === 'Vulnerability scan'));
  assert.deepEqual(card.facts.find(({ dt }) => dt === 'Compliance package'), { dt: 'Compliance package', dd: 'not in this release' });
  assert.ok(card.messages.includes('This release carries no control evidence, so no control state can be judged. Its software list (SBOM) and vulnerability scan are shown.'));
});

test('messages: every reason code has one plain sentence; Did not verify names its cause, shows no rows and shares one notice for one cause', () => {
  const dnv = (reason: string, file = 'manifest.json') => releaseCard(snapshot({ release: { verification: 'did-not-verify', reason: reason as never, file } }), LIVE).messages;
  assert.deepEqual(dnv('hash', 'sbom/sterling-image-sbom.cdx.json'), ['sbom/sterling-image-sbom.cdx.json has changed since the evidence was signed.', 'Nothing from this source is shown.']);
  assert.equal(dnv('anchor-mismatch', 'organization.pub')[0], 'The site key in this session’s evidence settings is not your organization’s site key, the one your site checks every image against. Ask your organization’s administrator.');
  const notVerified = (reason: string, setting: 'site' | 'single-computer' = 'site') => releaseCard(snapshot({ setting, release: {
    verification: 'not-verified', reason: reason as never, version: '0.5.0', commit: 'a'.repeat(40), asOf: BUILT, checkedAt: BUILT, bundle: 'included', package: 'included', levels: [], rows: [] } }), LIVE);
  assert.match(notVerified('anchor-unconfirmed').messages[0]!, /^Not verified: this session cannot confirm that the key in its evidence settings is your organization’s site key/);
  assert.equal(notVerified('no-trust-key', 'single-computer').messages[0], 'Not verified: no release key is set up on this computer, so no state here is counted as met.');
  assert.ok(notVerified('no-trust-key', 'single-computer').command, 'the single computer gets the command block');
  assert.equal(notVerified('no-trust-key', 'site').command, undefined, 'a site gets no command');
  assert.equal(notVerified('no-signature').messages[0], 'Not verified: there is no signature for release 0.5.0 in the evidence folder, so no state here is counted as met.');
  const keyVersion = siteCard(snapshot({ site: { verification: 'verified', site: 'site-a', files: [{ file: 'trust', verification: 'verified', signedAt: BUILT }, { file: 'live', verification: 'not-verified', reason: 'key-version-not-listed', keyVersion: 3 }], policy: { source: 'site', clamped: [] }, notes: [] } }), LIVE);
  assert.deepEqual(keyVersion.badge?.words, 'Not verified');
  assert.ok(keyVersion.messages.some((line) => line.startsWith('Live facts not verified: they are signed with collector key version 3')));
  const future = siteCard(snapshot({ site: { verification: 'verified', site: 'site-a', files: [{ file: 'trust', verification: 'verified', signedAt: BUILT }, { file: 'live', verification: 'did-not-verify', reason: 'future-dated' }], policy: { source: 'site', clamped: [] }, notes: [] } }), LIVE);
  assert.ok(future.messages.some((line) => /more than 5 minutes ahead of this computer’s clock/.test(line)));
  const clock = releaseCard(snapshot({ release: { ...(snapshot().release as object), clock: 'clock-behind-build' } as never }), LIVE);
  assert.ok(clock.messages.includes('Freshness is Unknown: this computer’s clock is earlier than the release build (25 Nov 2026 10:00 UTC).'));
  // One cause, two sources: one shared notice. Two causes: two notices.
  const shared = notices(snapshot({ release: { verification: 'did-not-verify', reason: 'anchor-mismatch', file: 'organization.pub' }, site: { verification: 'did-not-verify', reason: 'anchor-mismatch', files: [], notes: [], policy: { source: 'release-defaults', reason: 'no-site-policy', clamped: [] } } }), LIVE);
  assert.equal(shared.filter(({ tone }) => tone === 'error').length, 1);
  assert.match(shared[0]!.text, /^The release evidence and your site’s evidence did not verify: the site key in this session’s evidence settings/);
  assert.match(shared[0]!.text, /Nothing from them is shown\.$/);
  const two = notices(snapshot({ release: { verification: 'did-not-verify', reason: 'hash', file: 'scan/grype.json' }, site: { verification: 'did-not-verify', reason: 'trust-signature', files: [], notes: [], policy: { source: 'release-defaults', reason: 'no-site-policy', clamped: [] } } }), LIVE);
  assert.equal(two.filter(({ tone }) => tone === 'error').length, 2);
  assert.ok(notices(snapshot({ release: { ...(snapshot().release as object), clock: 'clock-behind-build' } as never }), LIVE).some(({ text }) => text.startsWith('This computer’s clock is earlier than the release build')));
});

test('attention: Needs attention counts Out of date and Not verified beside Not met, Partly met and Stale', () => {
  const cells = [cell({ state: 'not-met', displayState: 'not-met' }), cell({ state: 'partly-met', displayState: 'partly-met' }), cell({ state: 'stale', displayState: 'stale', freshness: 'out-of-date' }),
    cell({ verification: 'not-verified', displayState: 'not-verified' }), cell({ freshness: 'out-of-date' })];
  assert.deepEqual(attentionCounts(cells, LIVE), { 'not-met': 1, 'partly-met': 1, stale: 1, 'out-of-date': 2, 'not-verified': 1 });
  assert.deepEqual(Object.keys(COMPLIANCE_TEXT.attention), ['not-met', 'partly-met', 'stale', 'out-of-date', 'not-verified']);
  assert.deepEqual(Object.values(COMPLIANCE_TEXT.attention), ['Not met', 'Partly met', 'Stale evidence', 'Out of date', 'Not verified']);
});

test('applicability: Not applicable to this component shows the engine\'s reason and stands in for the four facts; others keep theirs', () => {
  const excluded = component({ state: 'not-applicable', reasonText: 'Not applicable to this component: it holds no audit records.', evidence: [], applicability: { class: 'not-applicable', reasonText: 'Not applicable to this component: it holds no audit records.' }, facts: 'not-applicable' });
  assert.deepEqual(componentLines(excluded), { applicability: 'Applicability: Not applicable to this component', reason: 'Not applicable to this component: it holds no audit records.', factsNone: 'Source, as-of time, freshness and verification do not apply: this component has no part in this control.', showFacts: false });
  assert.deepEqual(componentLines(component({ applicability: { class: 'implements', reasonText: '' } })).applicability, 'Applicability: Carries out this control');
  assert.deepEqual(componentLines(component({ applicability: { class: 'supports', reasonText: '' } })).applicability, 'Applicability: Supports this control');
  const unreviewed = componentLines(component({ state: 'not-met', applicability: { class: 'not-applicable', reasonText: 'unreviewed' } }));
  assert.equal(unreviewed.reason, 'Marked as having no part in this control, but your organization has not signed off this level’s applicability map yet, so it counts as not met.');
  assert.equal(unreviewed.showFacts, true);
  assert.deepEqual(componentLines(component()), { showFacts: true });
  const row = cell({ components: [component(), excluded] });
  assert.equal(cellFacts(row, LIVE).count?.words, '1 evidence item', 'an excluded component adds nothing to the count');
  assert.equal(cellFacts(cell({ state: 'your-organizations-responsibility', displayState: 'your-organizations-responsibility', reason: 'no-component-applies', sources: [], asOf: undefined, freshness: 'none', components: [] }), LIVE).noComponentApplies,
    'No component in this level has a part in this control, so it is your organization’s responsibility.');
});

test('paused: a lost or held connection makes every freshness Unknown with its reason, hides Out of date and keeps display states', () => {
  for (const [pause, words] of [['lost', 'Unknown (live updates paused)'], ['held', 'Unknown (live updates paused by you)']] as const) {
    const context: ViewContext = { ...LIVE, pause };
    const facts = cellFacts(cell({ freshness: 'current' }), context);
    assert.deepEqual(facts.freshness, { value: 'unknown', icon: 'question', words });
    assert.equal(attentionCounts([cell({ freshness: 'out-of-date' })], context)['out-of-date'], undefined, 'Out of date is hidden while paused');
    assert.equal(displayCounts([cell()]).met, 1, 'display states stay as last judged');
    assert.equal(siteCard(snapshot(), context).facts.find(({ dt }) => dt === 'Items')?.dd, words);
    assert.ok(releaseCard(snapshot(), context).facts.find(({ dt }) => dt === 'Vulnerability scan')?.dd.endsWith(words));
    assert.equal(filterCells([cell({ freshness: 'current' })], { ...DEFAULT_FILTERS, freshness: 'out-of-date' }, context).length, 1, 'the Freshness filter is not applied while paused');
  }
  assert.equal(filterCells([cell({ freshness: 'current' })], { ...DEFAULT_FILTERS, freshness: 'out-of-date' }, LIVE).length, 0);
  assert.ok(notices(snapshot(), { ...LIVE, pause: 'lost' }).some(({ text }) => text.startsWith('Live updates paused: the view lost its connection')));
  assert.ok(!notices(snapshot(), { ...LIVE, pause: 'held' }).some(({ text }) => text.startsWith('Live updates paused')), 'no notice when the person paused');
});

test('header, sources and words: the authorization sentence stays, the projection is its own Not verified source, and no capacity figure is shown', () => {
  assert.equal(COMPLIANCE_TEXT.lead, 'Live evidence for Sterling Sovereign AI, judged against the time now. Authorization is your organization’s decision.');
  const projected = snapshot({ projection: { verification: 'not-verified', reason: 'host-checked-not-signed', source: 'local bundle', commit: 'c'.repeat(40), fetchedAt: BUILT, generatedAt: BUILT, levels: [],
    rows: [cell({ source: 'projection', sources: ['projection'], verification: 'not-verified', displayState: 'not-verified' })] } });
  const card = projectionCard(projected, LIVE);
  assert.deepEqual([card?.title, card?.badge?.words, card?.facts.map(({ dd }) => dd)], ['Published projection', 'Not verified', ['your copy of the published dashboard', 'cccccccccccc', '25 Nov 2026 10:00 UTC']]);
  assert.deepEqual(viewCells(projected, 'projection').map(({ source }) => source), ['projection']);
  assert.deepEqual(viewCells(projected, 'layered').map(({ source }) => source), ['release'], 'projection rows never mix with the release rows');
  assert.equal(filterCells(viewCells(projected, 'layered'), { ...DEFAULT_FILTERS, source: 'release' }, LIVE).length, 0, 'From the release narrows to cells with a release result');
  const words = JSON.stringify(COMPLIANCE_TEXT).toLowerCase();
  for (const banned of ['sessions', 'users', 'concurrent', 'nodes', 'per second', 'capacity', '—']) assert.equal(words.includes(banned), false, banned);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const module = readFileSync(path.join(here, '..', '..', 'extension', 'src', 'browser', 'sterling-compliance-module.ts'), 'utf8');
  assert.ok(module.includes('waitForEvidence'), 'the view runs on the long poll');
  assert.ok(!module.includes("'compliance/dashboard.json'"), 'the browser no longer fetches the projection itself');
});
