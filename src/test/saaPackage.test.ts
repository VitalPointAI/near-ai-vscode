import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { readZip } from '../agent/zip';
import { buildSaaPackage } from '../services/saaPackage';
import { loadSaaOfficialPrivacyForms, type SaaReleaseEvidence } from '../services/saaReleaseEvidence';

const commit = 'a'.repeat(40);
const date = '2026-11-22T18:00:00.000Z';
const dashboardPath = 'evidence/bundle/dashboard/dashboard.json';
const textPath = 'evidence/bundle/dashboard/text/itsp-10-033/au.json';
const workbookPath = 'evidence/SA-and-A-control-and-evidence-workbook.xlsx';
const formsDir = path.join(__dirname, '../../resources/saa');
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const dashboard = {
  schemaVersion: 1,
  commit,
  generatedAt: date,
  levels: [
    { id: 'protected-a', title: 'Protected A', kind: 'level', claim: true },
    { id: 'classified', title: 'Classified', kind: 'level', claim: false }
  ],
  rows: [
    {
      level: 'protected-a', control: 'au-2', label: 'AU-2', title: 'Audit Events',
      state: 'met', reason: 'Product rule passed', reasonText: 'Published audit evidence is available.', textFile: 'text/itsp-10-033/au.json',
      components: [{
        component: 'Extension', responsibility: 'supplier', state: 'met', statement: ' \t=2+2',
        reasonText: 'Observed & verified',
        evidence: [{
          rule: 'audit-events', passed: true, reason: 'met', collectedAt: date,
          commit, runUrl: 'https://github.com/VitalPointAI/near-ai-vscode/actions/runs/12', window: 'head'
        }]
      }]
    },
    {
      level: 'classified', control: 'ac-2', label: 'AC-2', title: 'Account Management',
      state: 'not-met', reason: 'No product evidence', gap: 'CG-1', components: []
    }
  ],
  gaps: [{
    id: 'CG-1', title: 'Account evidence', ownerRole: 'Security team', state: 'open', controls: ['ac-2'],
    remediation: 'Document evidence', phase: '44'
  }, {
    id: 'CG-2', title: 'Account review', ownerRole: 'Operating team', state: 'planned', controls: ['ac-2'],
    remediation: 'Review operating evidence'
  }],
  matrix: [{ component: 'Extension', control: 'au-2', youDo: 'Choose which audit events to retain.' }]
};

function release(): SaaReleaseEvidence {
  const archive = Buffer.from('original assessor archive');
  const dashboardBytes = Buffer.from(JSON.stringify(dashboard));
  const sourceText = Buffer.from('official audit control text');
  const ledger = Buffer.from(`${digest(dashboardBytes)}  ${dashboardPath}\n${digest(sourceText)}  ${textPath}\n`);
  return {
    version: '0.4.36', commit, sourceUrl: 'https://github.com/VitalPointAI/near-ai-vscode/releases/tag/v0.4.36',
    fileName: 'compliance-package-0.4.36.tar.gz', sha256: digest(archive), archive, dashboard,
    files: new Map([[dashboardPath, dashboardBytes], [textPath, sourceText], ['SHA256SUMS', ledger]])
  };
}

test('exports the original release, editable forms and traceability with deployment conclusions left open', async () => {
  const original = release();
  const sbomFile = 'evidence/bundle/vsix-sbom.cdx.json';
  const evidence = { ...original, files: new Map(original.files).set(sbomFile, Buffer.from('installer inventory')) };
  const privacyForms = await loadSaaOfficialPrivacyForms(new AbortController().signal, async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://www.canada.ca');
    const bytes = await readFile(path.join(formsDir, 'official', path.basename(url.pathname)));
    return new Response(new Uint8Array(bytes));
  });
  assert.equal(privacyForms.size, 5);
  const result = readZip(await buildSaaPackage(evidence, formsDir, privacyForms), 'SA&A package');
  for (const [name, bytes] of privacyForms) assert.deepEqual(result.get(`forms/official/${name}`)?.(), bytes);
  assert.deepEqual(result.get(`evidence/${evidence.fileName}`)?.(), evidence.archive);
  assert.equal(result.get(`evidence/${evidence.fileName}.sha256`)?.().toString(), `${evidence.sha256}  ${evidence.fileName}\n`);
  for (const [name, bytes] of evidence.files) {
    assert.deepEqual(result.get(`evidence/release-package/${name}`)?.(), bytes);
  }
  assert.ok(result.has('forms/editable/01-01-submission-cover-and-routing.docx'));
  assert.ok([...result.keys()].some((name) => name.startsWith('forms/official/') && name.endsWith('.pdf')));
  assert.match(result.get('README.md')?.().toString() ?? '', /v0\.4\.36/);
  assert.match(result.get('evidence/README.md')!().toString(), /Marketplace approval evidence is pending verification/);
  assert.equal(result.has('evidence/marketplace-approval.json'), false);
  assert.match(result.get('evidence/evidence-index.csv')!().toString(), /EV-REL-07","CI installer software inventory","release-package\/evidence\/bundle\/vsix-sbom\.cdx\.json/);
  assert.match(result.get('evidence/coverage-summary.csv')?.().toString() ?? '', /"protected-a","Protected A","1","1"/);
  const traceability = result.get('evidence/control-traceability.csv')?.().toString() ?? '';
  assert.match(traceability, /"Product rule passed".*"release-package\/evidence\/bundle\/dashboard\/text\/itsp-10-033\/au\.json".*"Not assessed"/);
  assert.match(traceability, /"No product evidence".*"CG-1, CG-2","Security team, Operating team".*"Reference only"/);
  assert.match(traceability, /Published audit evidence is available.*1 passed.*Choose which audit events to retain/);
  const component = result.get('evidence/component-evidence.csv')?.().toString() ?? '';
  assert.match(component, /"' \t=2\+2".*"audit-events","Passed","met".*"Observed & verified"/);
  assert.match(result.get('evidence/gap-and-action-register.csv')?.().toString() ?? '',
    /"CG-1","Account evidence","open","ac-2","Security team","Document evidence","44"/);

  const workbook = readZip(result.get(workbookPath)!(), 'traceability workbook');
  const worksheet = workbook.get('xl/worksheets/sheet3.xml')?.().toString() ?? '';
  assert.match(worksheet, /t="inlineStr"><is><t xml:space="preserve"> \t=2\+2<\/t>/);
  assert.match(worksheet, /Observed &amp; verified/);
  assert.doesNotMatch(worksheet, /<f[ >]/);
  const sponsor = readZip(result.get('SA-and-A-sponsor-draft.docx')!(), 'sponsor draft');
  const document = sponsor.get('word/document.xml')!().toString();
  assert.match(document, /TOC /);
  assert.match(document, /<w:pageBreakBefore/);
  assert.match(document, /Choose which audit events to retain/);
  assert.match(document, /AC-2/);
  assert.match(document, /separate scope approval/);
  assert.equal(result.get('SHA256SUMS')?.().toString().split('\n').filter(Boolean).length, result.size - 1);
  for (const [name, bytes] of result) {
    if (name === 'SHA256SUMS') continue;
    assert.ok(result.get('SHA256SUMS')?.().toString().includes(`${digest(bytes())}  ${name}\n`), name);
  }
});

test('a verified receipt is supplemental, checksummed and tied to the selected release', async () => {
  const evidence = release();
  const approval = {
    tag: 'v0.4.36', commit, runUrl: 'https://github.com/VitalPointAI/near-ai-vscode/actions/runs/42',
    publishCompletedAt: '2026-11-20T18:00:00Z', checkedAt: date
  };
  const without = readZip(await buildSaaPackage(evidence, formsDir, new Map()), 'original evidence');
  const withReceipt = readZip(await buildSaaPackage(evidence, formsDir, new Map(), approval), 'supplemented evidence');
  const receiptPath = 'evidence/marketplace-approval.json';
  const receipt = withReceipt.get(receiptPath)!();
  assert.deepEqual(JSON.parse(receipt.toString()), {
    schemaVersion: 1, kind: 'marketplace-publish-approval', ...approval, runAttempt: 1
  });
  assert.ok(withReceipt.get('SHA256SUMS')!().toString().includes(`${digest(receipt)}  ${receiptPath}\n`));
  const notes = withReceipt.get('evidence/README.md')!().toString();
  assert.match(notes, /\[Marketplace approval receipt\]\(marketplace-approval\.json\)/);
  assert.ok(notes.includes(approval.runUrl));
  assert.match(notes, /confers no deployment authorization/);
  assert.deepEqual(withReceipt.get(`evidence/release-package/${dashboardPath}`)?.(), without.get(`evidence/release-package/${dashboardPath}`)?.());
  for (const name of ['evidence/control-traceability.csv', 'evidence/component-evidence.csv', 'evidence/gap-and-action-register.csv']) {
    assert.deepEqual(withReceipt.get(name)?.(), without.get(name)?.(), name);
  }
  for (const untrusted of [{ ...approval, commit: 'b'.repeat(40) }, { ...approval, runUrl: `${approval.runUrl}?redirect=https://example.org` }]) {
    const unverified = readZip(await buildSaaPackage(evidence, formsDir, new Map(), untrusted), 'unverified Marketplace receipt');
    assert.equal(unverified.has(receiptPath), false);
    assert.match(unverified.get('evidence/README.md')!().toString(), /pending verification/);
  }
});

test('distinguishes missing, stale and failed evidence and counts unresolved in-scope controls with no closure path', async () => {
  const evidence = release();
  const base = dashboard.rows[0];
  const [component] = base.components;
  assert.ok(component);
  const [rule] = component.evidence;
  const data = { ...dashboard, rows: [{ ...base, state: 'stale', components: [{ ...component, evidence: [
    { ...rule, rule: 'missing', passed: false, reason: 'missing-result' },
    { ...rule, rule: 'not-run', passed: false, reason: 'test-not-run' },
    { ...rule, rule: 'skipped', passed: false, reason: 'test-skipped' },
    { ...rule, rule: 'todo', passed: false, reason: 'test-todo' },
    { ...rule, rule: 'stale', commit: 'b'.repeat(40) },
    { ...rule, rule: 'expired', collectedAt: '2026-11-20T18:00:00.000Z', window: 'audit' },
    { ...rule, rule: 'failed', passed: false, reason: 'test-failed' }
  ] }] }, dashboard.rows[1]] };
  const result = readZip(await buildSaaPackage({ ...evidence, dashboard: data }, formsDir, new Map()), 'SA&A package');
  const rules = result.get('evidence/component-evidence.csv')!().toString();
  assert.match(rules, /"missing","Missing","missing-result","","","","head"/);
  assert.match(rules, /"not-run","Missing","test-not-run","","","","head"/);
  assert.match(rules, /"skipped","Skipped","test-skipped"/);
  assert.match(rules, /"todo","Pending test","test-todo"/);
  assert.match(rules, /"stale","Stale","met"/);
  assert.match(rules, /"expired","Stale","met"/);
  assert.match(rules, /"failed","Failed","test-failed"/);
  const triage = result.get('evidence/gap-and-action-register.csv')!().toString();
  assert.match(triage, /"TRIAGE-protected-a-au-2","Control implementation or evidence review","Unassigned","au-2","","No closure path assigned\. In Phase 44\.1,[^\n]+?decision\.","",/);
  const coverage = result.get('evidence/coverage-summary.csv')!().toString();
  assert.match(coverage, /"Deployment assessment","Unassigned product gaps"/);
  assert.match(coverage, /"protected-a",[^\n]+,"Not assessed","1","0"/);
  assert.match(coverage, /"classified",[^\n]+,"Reference only","",""/);
  assert.doesNotMatch(triage, /TRIAGE-classified/);
});

test('flags deployment evidence without a path and preserves linked and reference controls', async () => {
  const evidence = release();
  const ownership = 'your-organizations-responsibility';
  const inherited = {
    level: 'protected-a', control: 'ca-1', label: 'CA-1', title: 'Assessment policy',
    state: ownership, reason: 'inherited',
    components: [{ component: 'Deployment', responsibility: 'inherited', state: ownership,
      inheritedFrom: 'Shared service', evidence: [] }]
  };
  const linked = { ...inherited, control: 'ca-2', label: 'CA-2', gap: 'CG-3' };
  const reference = { ...inherited, level: 'classified' };
  const action = { id: 'CG-3', title: 'Deployment review', ownerRole: 'Assessment lead', state: 'planned',
    controls: ['ca-2'], remediation: 'Verify assigned assessor', phase: '44.1' };
  const overlay = { id: 'other-profile', title: 'Other profile', kind: 'overlay', claim: true };
  const other = { ...linked, level: overlay.id };
  const data = { ...dashboard, levels: [...dashboard.levels, overlay],
    rows: [dashboard.rows[0], inherited, linked, reference, other], gaps: [{ ...action, profiles: ['protected-a'] }] };
  const result = readZip(await buildSaaPackage({ ...evidence, dashboard: data }, formsDir, new Map()), 'SA&A package');
  const coverage = result.get('evidence/coverage-summary.csv')!().toString();
  assert.match(coverage, /"Unassigned product gaps","Unassigned deployment evidence paths"/);
  assert.match(coverage, /"protected-a",[^\n]+,"Not assessed","0","1"/);
  assert.match(coverage, /"classified",[^\n]+,"Reference only","",""/);
  const actions = result.get('evidence/gap-and-action-register.csv')!().toString();
  assert.match(actions, /"TRIAGE-protected-a-ca-1","Deployment or inherited evidence review","Unassigned deployment"/);
  assert.doesNotMatch(actions, /TRIAGE-(?:classified|protected-a-ca-2)/);
  assert.match(actions, /"TRIAGE-other-profile-ca-2","Deployment or inherited evidence review","Unassigned deployment"/);
  const traceability = result.get('evidence/control-traceability.csv')!().toString();
  assert.match(traceability, /"ca-1",[^\n]+No deployment evidence path assigned/);
  assert.match(traceability, /"ca-2",[^\n]+Review related gaps CG-3/);
});

test('reports missing, inconsistent or malformed package inputs before producing a draft', async () => {
  const evidence = release();
  const noPrivacyForms = new Map<string, Buffer>();
  await assert.rejects(buildSaaPackage({ ...evidence, dashboard: { ...dashboard, commit: 'b'.repeat(40) } }, formsDir, noPrivacyForms),
    /missing or malformed control evidence/);
  const rows = [...dashboard.rows, { ...dashboard.rows[0], level: 'unknown-profile' }];
  await assert.rejects(buildSaaPackage({ ...evidence, dashboard: { ...dashboard, rows } }, formsDir, noPrivacyForms),
    /references unknown or duplicate controls, profiles or gaps/);
  await assert.rejects(buildSaaPackage(evidence, path.join(formsDir, 'official'), noPrivacyForms), /bundled editable SA&A forms are missing/);
});

test('rejects a changed Treasury Board form before including it in an export', async () => {
  await assert.rejects(loadSaaOfficialPrivacyForms(new AbortController().signal, async () => new Response('changed')),
    /differs from the version this extension verifies/);
});
