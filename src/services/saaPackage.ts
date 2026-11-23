import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { writeZip } from '../agent/zip';
import { SAA_RELEASE_RUN_URL, type SaaMarketplaceApproval, type SaaReleaseEvidence } from './saaReleaseEvidence';
import { buildSaaSponsorReport, type SaaSponsorReportInput } from './saaSponsorReport';

const STATES = ['met', 'partly-met', 'not-met', 'stale', 'your-organizations-responsibility', 'not-applicable'] as const;
type ProductState = typeof STATES[number];
type CsvRow = readonly (string | number | undefined)[];
type Table = { title: string; file: string; rows: readonly CsvRow[] };
type ArchiveEntry = [name: string, bytes: Buffer];

interface RuleResult {
  rule: string;
  passed: boolean;
  reason: string;
  collectedAt: string;
  commit?: string;
  runUrl?: string;
  window?: string;
}

interface Component {
  component: string;
  responsibility: string;
  state: ProductState;
  statement?: string;
  reasonText?: string;
  inheritedFrom?: string;
  evidence: RuleResult[];
}

interface Control {
  level: string;
  control: string;
  label: string;
  title: string;
  reason: string;
  reasonText?: string;
  state: ProductState;
  gap?: string;
  textFile?: string;
  components: Component[];
}

interface Gap {
  id: string;
  title: string;
  ownerRole: string;
  state: string;
  controls: string[];
  remediation: string;
  phase?: string;
}

interface Profile {
  id: string;
  title: string;
  kind: string;
  claim: boolean;
}

interface Dashboard {
  generatedAt: string;
  levels: Profile[];
  rows: Control[];
  gaps: Gap[];
  matrix: Responsibility[];
}

interface Responsibility {
  component: string;
  control: string;
  youDo: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const optionalText = (value: unknown): boolean => value === undefined || typeof value === 'string';
const isState = (value: unknown): value is ProductState => STATES.some((state) => state === value);

function isRuleResult(value: unknown): value is RuleResult {
  return isObject(value) && isText(value.rule) && typeof value.passed === 'boolean' &&
    isText(value.reason) && isText(value.collectedAt) && Number.isFinite(Date.parse(value.collectedAt)) &&
    optionalText(value.commit) && optionalText(value.runUrl) && optionalText(value.window);
}

function isComponent(value: unknown): value is Component {
  return isObject(value) && isText(value.component) && isText(value.responsibility) && isState(value.state) &&
    optionalText(value.statement) && optionalText(value.reasonText) && optionalText(value.inheritedFrom) &&
    Array.isArray(value.evidence) && value.evidence.every(isRuleResult);
}

function isControl(value: unknown): value is Control {
  return isObject(value) && isText(value.level) && isText(value.control) && isText(value.label) &&
    isText(value.title) && isText(value.reason) && optionalText(value.reasonText) && isState(value.state) && optionalText(value.gap) &&
    optionalText(value.textFile) && Array.isArray(value.components) && value.components.every(isComponent);
}

function isResponsibility(value: unknown): value is Responsibility {
  return isObject(value) && isText(value.component) && isText(value.control) && typeof value.youDo === 'string';
}

function isGap(value: unknown): value is Gap {
  return isObject(value) && isText(value.id) && isText(value.title) && isText(value.ownerRole) &&
    isText(value.state) && isText(value.remediation) && optionalText(value.phase) &&
    Array.isArray(value.controls) && value.controls.every(isText);
}

function isProfile(value: unknown): value is Profile {
  return isObject(value) && isText(value.id) && isText(value.title) &&
    (value.kind === 'level' || value.kind === 'overlay') && typeof value.claim === 'boolean';
}

function parseDashboard(value: unknown, commit: string): Dashboard {
  if (!isObject(value) || value.schemaVersion !== 1 || value.commit !== commit ||
      !isText(value.generatedAt) || !Number.isFinite(Date.parse(value.generatedAt)) ||
      !Array.isArray(value.levels) || !value.levels.length || !value.levels.every(isProfile) ||
      !Array.isArray(value.rows) || !value.rows.length || !value.rows.every(isControl) ||
      !Array.isArray(value.gaps) || !value.gaps.every(isGap) ||
      (value.matrix !== undefined && (!Array.isArray(value.matrix) || !value.matrix.every(isResponsibility)))) {
    throw new Error('The release dashboard has missing or malformed control evidence.');
  }
  const levels = new Set(value.levels.map((level) => level.id));
  const controls = new Set(value.rows.map((row) => JSON.stringify([row.level, row.control])));
  const gaps = new Set(value.gaps.map((gap) => gap.id));
  if (levels.size !== value.levels.length || controls.size !== value.rows.length ||
      gaps.size !== value.gaps.length ||
      value.rows.some((row) => !levels.has(row.level) || (row.gap && !gaps.has(row.gap)))) {
    throw new Error('The release dashboard references unknown or duplicate controls, profiles or gaps.');
  }
  return { generatedAt: value.generatedAt, levels: value.levels, rows: value.rows, gaps: value.gaps, matrix: value.matrix ?? [] };
}

/** Use plain ZIP member names safe to open on the supported platforms. */
function safePath(name: string): boolean {
  return name.length <= 240 && name.split('/').every((part) =>
    /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(part) && !part.endsWith('.') &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

async function readForms(root: string): Promise<ArchiveEntry[]> {
  if (!(await lstat(root)).isDirectory()) throw new Error('The bundled SA&A forms directory is missing.');
  const entries: ArchiveEntry[] = [];
  const maxBytes = 8 * 1024 * 1024;
  let remaining = maxBytes;
  async function walk(directory: string, prefix: string): Promise<void> {
    const contents = await readdir(directory, { withFileTypes: true });
    for (const entry of contents.sort((left, right) => left.name.localeCompare(right.name))) {
      const name = prefix + entry.name;
      if (/^official\/[^/]+\.docx$/.test(name)) continue;
      if (!safePath(name)) throw new Error(`Unexpected file name in the bundled SA&A forms: ${name}.`);
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(file, `${name}/`);
        continue;
      }
      if (!entry.isFile()) throw new Error(`The bundled SA&A form ${name} must be a regular file.`);
      const stats = await lstat(file);
      if (!stats.isFile() || stats.size > remaining || entries.length >= 128) {
        throw new Error('The bundled SA&A forms are too large or contain an unexpected file.');
      }
      const bytes = await readFile(file);
      if (bytes.length !== stats.size) throw new Error('A bundled SA&A form changed while it was being read.');
      remaining -= bytes.length;
      entries.push([`forms/${name}`, bytes]);
    }
  }
  await walk(root, '');
  if (!entries.some(([name]) => /^forms\/editable\/.+\.docx$/.test(name))) {
    throw new Error('The bundled editable SA&A forms are missing.');
  }
  return entries;
}

const dashboardFile = 'release-package/evidence/bundle/dashboard/dashboard.json';
const installerSbomFile = 'evidence/bundle/vsix-sbom.cdx.json';

// Mirror the published snapshot's Phase 44 windows when labeling individual rule results.
const day = 24 * 60 * 60 * 1000;
const evidenceWindows: Readonly<Record<string, number>> = {
  audit: day, settings: 7 * day, harness: 30 * day, document: 365 * day, attestation: 365 * day
};

function ruleOutcome(result: RuleResult, snapshot: number, commit: string): string {
  if (['missing-result', 'test-not-run', 'test-missing-file', 'test-missing-name'].includes(result.reason)) return 'Missing';
  if (result.reason === 'test-skipped') return 'Skipped';
  if (result.reason === 'test-todo') return 'Pending test';
  if (!result.passed || result.reason !== 'met') return 'Failed';
  if (result.window === 'head') return result.commit === commit ? 'Passed' : 'Stale';
  const window = result.window && Object.hasOwn(evidenceWindows, result.window) ? evidenceWindows[result.window] : undefined;
  if (window === undefined) return 'Freshness unverified';
  const age = snapshot - Date.parse(result.collectedAt);
  return age >= -5 * 60 * 1000 && age <= window ? 'Passed' : 'Stale';
}

function sponsorResponse(control: Control, profile: Profile, duties: readonly string[], passingEvidence: boolean, gaps: readonly Gap[]) {
  if (!profile.claim) return {
    draft: 'We propose retaining this control as a reference pending separate scope approval.',
    followUp: 'Confirm the separately scoped reference with the sponsor before assessment.'
  };
  if (control.state === 'not-applicable') return {
    draft: 'We propose reviewing the release exclusion against the deployment boundary before adopting it.',
    followUp: 'Record the tailoring rationale, reviewer and approval reference.'
  };
  const inherited = [...new Set(control.components.map((component) => component.inheritedFrom).filter(isText))];
  const responsibility = duties.length ? ` Published sponsor actions: ${duties.join(' ')}` : '';
  if (control.state === 'your-organizations-responsibility') return {
    draft: (inherited.length
      ? `We will confirm whether ${inherited.join(', ')} supplies this control for the proposed deployment.`
      : 'We will identify the organization responsible for this control and document its deployment implementation.') + responsibility,
    followUp: gaps.length
      ? `Review related gaps ${gaps.map(({ id }) => id).join(', ')}. Verify the deployment or inherited evidence with the accountable owner.`
      : 'No deployment evidence path assigned. Record the accountable owner, assessment action, and required evidence or approved tailoring decision.'
  };
  if (control.state === 'met' && passingEvidence) return {
    draft: 'We propose the cited release evidence for assessor review against the approved deployment boundary and configuration.' + responsibility,
    followUp: 'Confirm applicability and evidence freshness, then test the deployment and record the result.'
  };
  return {
    draft: 'We will confirm the applicable objective and resolve the product or evidence gap before proposing closure.' + responsibility,
    followUp: gaps.length
      ? `Review related gaps ${gaps.map(({ id }) => id).join(', ')}. Verify the applicable implementation and record closure evidence.`
      : 'No closure path assigned. In Phase 44.1, record the accountable role, milestone, and required evidence or approved tailoring decision.'
  };
}

function traceabilityTables(dashboard: Dashboard, release: SaaReleaseEvidence): { tables: Table[]; profiles: SaaSponsorReportInput['profiles'] } {
  const coverage: CsvRow[] = [['Profile ID', 'Profile name', 'Product rows', ...STATES, 'Deployment assessment', 'Unassigned product gaps', 'Unassigned deployment evidence paths']];
  const controls: CsvRow[] = [[
    'Profile ID', 'Profile kind', 'OSCAL control ID', 'Control label', 'Control title', 'Product state', 'Product reason',
    'Product snapshot (UTC)', 'Product commit', 'Mapped components and responsibilities', 'Product rule IDs', 'Related published gap IDs',
    'Related gap owner roles', 'Next assessment action', 'Official source in package', 'Deployment applicability',
    'Tailoring decision and rationale', 'Deployment owner', 'Assessment method', 'Deployment evidence ID', 'Assessor result',
    'Assessor and date', 'Closure or approval reference', 'Published reason detail', 'Evidence at release snapshot', 'Draft sponsor response'
  ]];
  const components: CsvRow[] = [[
    'Profile ID', 'OSCAL control ID', 'Component', 'Product responsibility', 'Product statement', 'Product component state',
    'Evidence rule ID', 'Product rule result', 'Result reason', 'Collected (UTC)', 'Evidence commit', 'Original run URL',
    'Validity window', 'Evidence source in package', 'Published component reason detail', 'Inherited provider'
  ]];
  const actions: CsvRow[] = [[
    'Product gap ID', 'Title', 'Published state', 'OSCAL control IDs', 'Product owner role', 'Published remediation',
    'Published phase', 'Deployment applicability', 'Assigned owner', 'Priority', 'Target date', 'Compensating measure',
    'Closure evidence', 'Assessor disposition', 'Profile ID'
  ]];
  const index: CsvRow[] = [
    ['Evidence ID', 'Artifact', 'Source or path in evidence folder', 'Product commit', 'Use and limitations'],
    ['EV-REL-01', 'Published GitHub release', release.sourceUrl, release.commit, 'Version and release asset provenance.'],
    ['EV-REL-02', 'Original assessor archive', release.fileName, release.commit, 'Published archive and its SHA-256.'],
    ['EV-REL-03', 'Release dashboard', dashboardFile, release.commit, 'Source of the product traceability rows.'],
    ['EV-REL-04', 'Original package checksums', 'release-package/SHA256SUMS', release.commit, 'Integrity of the extracted release files.'],
    ['EV-REL-05', 'OSCAL models', 'release-package/oscal/', release.commit, 'Release models for tailoring and assessment.'],
    ['EV-REL-06', 'Readable release records', 'release-package/readable/', release.commit, 'Release security plans and responsibilities.']
  ];
  if (release.files.has(installerSbomFile)) {
    index.push(['EV-REL-07', 'CI installer software inventory', `release-package/${installerSbomFile}`, release.commit,
      'Software shipped in the installer built for this commit. Confirm the deployed configuration separately.']);
  }
  index.push(['EV-DEP-___', 'Deployment evidence reference', '', '', 'Record permitted IDs and repository links after assessment.']);
  const snapshot = Date.parse(dashboard.generatedAt);
  const profiles: SaaSponsorReportInput['profiles'][number][] = [];
  for (const profile of dashboard.levels) {
    const rows = dashboard.rows.filter((row) => row.level === profile.id);
    const counts = new Map<ProductState, number>();
    let unassigned = 0;
    let unassignedDeployment = 0;
    const drafts: SaaSponsorReportInput['profiles'][number]['rows'][number][] = [];
    for (const row of rows) {
      counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
      const results = row.components.flatMap((component) => component.evidence);
      const rules = new Set(results.map((result) => result.rule));
      const resultCounts = new Map<string, number>();
      for (const result of results) {
        const outcome = ruleOutcome(result, snapshot, release.commit);
        resultCounts.set(outcome, (resultCounts.get(outcome) ?? 0) + 1);
      }
      const evidenceStatus = resultCounts.size
        ? [...resultCounts].map(([outcome, count]) => `${count} ${outcome.toLowerCase()}`).join(', ')
        : 'No release rule results';
      const related = dashboard.gaps.filter((gap) => gap.id === row.gap || gap.controls.includes(row.control));
      const owners = [...new Set(related.map(({ ownerRole }) => ownerRole))].join(', ');
      const duties = [...new Set(dashboard.matrix.filter((item) => item.control === row.control &&
        row.components.some((component) => component.component === item.component)).map(({ youDo }) => youDo).filter(Boolean))];
      const passingEvidence = resultCounts.size === 1 && resultCounts.has('Passed');
      const response = sponsorResponse(row, profile, duties, passingEvidence, related);
      const reasonText = row.reason === 'inherited'
        ? row.components.find((component) => component.responsibility === 'inherited' && component.reasonText)?.reasonText ??
          'Confirm the inherited provider with the deployment owner.'
        : row.reasonText;
      drafts.push({ label: row.label, title: row.title, publishedState: row.state, evidenceStatus,
        publishedReason: reasonText, sponsorDraft: response.draft, followUp: response.followUp });
      if (profile.claim && !related.length) {
        if (row.state === 'your-organizations-responsibility') {
          unassignedDeployment++;
          actions.push([`TRIAGE-${profile.id}-${row.control}`, 'Deployment or inherited evidence review', 'Unassigned deployment', row.control,
            '', response.followUp, '', '', '', '', '', '', '', '', profile.id]);
        } else if (['not-met', 'partly-met', 'stale'].includes(row.state) || (row.state === 'met' && !passingEvidence)) {
          unassigned++;
          actions.push([`TRIAGE-${profile.id}-${row.control}`, 'Control implementation or evidence review', 'Unassigned', row.control,
            '', response.followUp, '', '', '', '', '', '', '', '', profile.id]);
        }
      }
      const textFile = row.textFile ? `evidence/bundle/dashboard/${row.textFile}` : '';
      const official = textFile && safePath(textFile) && release.files.has(textFile) ? `release-package/${textFile}` : '';
      controls.push([
        profile.id, profile.kind, row.control, row.label, row.title, row.state, row.reason, dashboard.generatedAt, release.commit,
        row.components.map(({ component, responsibility }) => `${component} (${responsibility})`).join('; '), [...rules].join('; '),
        related.map(({ id }) => id).join(', '), owners, response.followUp, official,
        '', '', '', '', '', profile.claim ? 'Not assessed' : 'Reference only', '', '', reasonText, evidenceStatus, response.draft
      ]);
      for (const component of row.components) {
        const base = [profile.id, row.control, component.component, component.responsibility, component.statement, component.state];
        if (component.evidence.length === 0) {
          components.push([...base, '', '', '', '', '', '', '', dashboardFile, component.reasonText, component.inheritedFrom]);
        }
        for (const item of component.evidence) {
          const outcome = ruleOutcome(item, snapshot, release.commit);
          const recorded = outcome !== 'Missing';
          components.push([...base, item.rule, outcome, item.reason, recorded ? item.collectedAt : '',
            recorded ? item.commit : '', recorded ? item.runUrl : '', item.window, dashboardFile, component.reasonText, component.inheritedFrom]);
        }
      }
    }
    coverage.push([profile.id, profile.title, rows.length, ...STATES.map((state) => counts.get(state) ?? 0),
      profile.claim ? 'Not assessed' : 'Reference only', profile.claim ? unassigned : '', profile.claim ? unassignedDeployment : '']);
    profiles.push({ id: profile.id, title: profile.title, referenceOnly: !profile.claim, rows: drafts });
  }
  for (const gap of dashboard.gaps) {
    actions.push([gap.id, gap.title, gap.state, gap.controls.join('; '), gap.ownerRole, gap.remediation, gap.phase,
      '', '', '', '', '', '', '', '']);
  }
  const tables: Table[] = [
    { title: 'Coverage', file: 'coverage-summary.csv', rows: coverage },
    { title: 'Control traceability', file: 'control-traceability.csv', rows: controls },
    { title: 'Component evidence', file: 'component-evidence.csv', rows: components },
    { title: 'Evidence index', file: 'evidence-index.csv', rows: index },
    { title: 'Product gaps', file: 'gap-and-action-register.csv', rows: actions }
  ];
  return { tables, profiles };
}

function csvCell(value: CsvRow[number]): string {
  const text = String(value ?? '');
  // Quotes protect record boundaries. A leading apostrophe also keeps formula-like text inert.
  const prefix = typeof value === 'string' && /^(?:[\t\r\n]|[\s\uFEFF]*[=+\-@])/.test(text) ? "'" : '';
  return `"${prefix}${text.replaceAll('"', '""')}"`;
}

const xml = (value: string): string => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const spreadsheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const officeRelationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageRelationships = 'http://schemas.openxmlformats.org/package/2006/relationships';

function columnName(index: number): string {
  const suffix = String.fromCharCode(65 + index % 26);
  return index < 26 ? suffix : columnName(Math.floor(index / 26) - 1) + suffix;
}

function worksheet(rows: readonly CsvRow[]): string {
  const data = rows.map((row, offset) => {
    const number = offset + 1;
    const cells = row.map((value, index) => {
      const coordinate = `${columnName(index)}${number}`;
      if (typeof value === 'number') return `<c r="${coordinate}"><v>${value}</v></c>`;
      if (!value) return '';
      return `<c r="${coordinate}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
    }).join('');
    return `<row r="${number}">${cells}</row>`;
  }).join('');
  const lastColumn = rows[0].length - 1;
  return `<worksheet xmlns="${spreadsheet}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="${lastColumn + 1}" width="26" customWidth="1"/></cols><sheetData>${data}</sheetData><autoFilter ref="A1:${columnName(lastColumn)}${rows.length}"/></worksheet>`;
}

function workbook(tables: Table[]): Buffer {
  const sheets = tables.map((table, index) => ({ table, id: index + 1 }));
  const entries: ArchiveEntry[] = [];
  const add = (name: string, value: string) => entries.push([name, Buffer.from(value)]);
  const types = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
  add('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${types}.sheet.main+xml"/>${sheets.map(({ id }) => `<Override PartName="/xl/worksheets/sheet${id}.xml" ContentType="${types}.worksheet+xml"/>`).join('')}</Types>`);
  add('_rels/.rels', `<Relationships xmlns="${packageRelationships}"><Relationship Id="rId1" Type="${officeRelationships}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  add('xl/workbook.xml', `<workbook xmlns="${spreadsheet}" xmlns:r="${officeRelationships}"><bookViews><workbookView/></bookViews><sheets>${sheets.map(({ id, table }) => `<sheet name="${xml(table.title)}" sheetId="${id}" r:id="rId${id}"/>`).join('')}</sheets></workbook>`);
  add('xl/_rels/workbook.xml.rels', `<Relationships xmlns="${packageRelationships}">${sheets.map(({ id }) => `<Relationship Id="rId${id}" Type="${officeRelationships}/worksheet" Target="worksheets/sheet${id}.xml"/>`).join('')}</Relationships>`);
  for (const { id, table } of sheets) add(`xl/worksheets/sheet${id}.xml`, worksheet(table.rows));
  return writeZip(entries);
}

/** Combine a verified public release with blank forms. All generated content stays in this archive. */
export async function buildSaaPackage(
  evidence: SaaReleaseEvidence, formsDir: string, privacyForms: ReadonlyMap<string, Buffer>, marketplaceApproval?: SaaMarketplaceApproval
): Promise<Buffer> {
  const dashboard = parseDashboard(evidence.dashboard, evidence.commit);
  const { tables, profiles } = traceabilityTables(dashboard, evidence);
  const entries: ArchiveEntry[] = await readForms(formsDir);
  const append = (name: string, value: string) => entries.push([name, Buffer.from(value)]);
  const addSource = (name: string, value: Buffer) => {
    if (!safePath(name)) throw new Error('The release package contains an unsafe file name.');
    entries.push([name, value]);
  };
  const approval = marketplaceApproval?.tag === `v${evidence.version}` && marketplaceApproval.commit === evidence.commit &&
    marketplaceApproval.runUrl.startsWith(SAA_RELEASE_RUN_URL) && /^[1-9]\d*$/.test(marketplaceApproval.runUrl.slice(SAA_RELEASE_RUN_URL.length))
    ? marketplaceApproval : undefined;
  if (approval) {
    append('evidence/marketplace-approval.json', `${JSON.stringify({
      schemaVersion: 1, kind: 'marketplace-publish-approval', tag: approval.tag, commit: approval.commit,
      runUrl: approval.runUrl, runAttempt: 1, publishCompletedAt: approval.publishCompletedAt, checkedAt: approval.checkedAt
    }, null, 2)}\n`);
  }
  for (const [name, bytes] of privacyForms) addSource(`forms/official/${name}`, bytes);
  const sponsorReport = 'SA-and-A-sponsor-draft.docx';
  entries.push([sponsorReport, buildSaaSponsorReport({
    version: evidence.version, commit: evidence.commit, generatedAt: dashboard.generatedAt, sourceUrl: evidence.sourceUrl, profiles
  })]);
  append('README.md', `# Security Assessment and Authorization package

Draft for departmental review

- Product release: v${evidence.version}
- Evidence commit: ${evidence.commit}
- Product evidence snapshot (UTC): ${dashboard.generatedAt}
- Published source: ${evidence.sourceUrl}

Start with the [consolidated sponsor draft](${sponsorReport}), which includes a submission cover, report sections and proposed control responses for editing. The [forms index](forms/README.md) lists the supporting categorization, tailoring, system and assessment plans, remediation, authorization and risk worksheets, and the official blank Treasury Board forms.

Open the [control and evidence workbook](evidence/SA-and-A-control-and-evidence-workbook.xlsx) for the release's ${dashboard.rows.length} profile and overlay rows. The [evidence notes](evidence/README.md) describe how to read the product snapshot and trace it to the original assessor archive.

These documents are drafts. The sponsor supplies the deployment, departmental templates, evidence location and approval route. The assessor records deployment findings, and the authorizing official makes and signs the decision. Use the approved departmental repository for sensitive material.
`);
  append('evidence/README.md', `# Product evidence and deployment assessment

This export uses the product evidence published for NEAR AI for VS Code v${evidence.version} at ${evidence.commit}. The source archive was checked against its GitHub release asset SHA-256 and the release package's internal checksums.

The actual deployment and its control conclusions remain open. Published product states describe the dated release snapshot. Per-rule results distinguish pass, failure, missing evidence, stale evidence, skipped tests and tests still to do. Recheck evidence freshness and applicability before use. Profiles marked reference only require separate scope and direction.

- The [workbook](SA-and-A-control-and-evidence-workbook.xlsx) and CSVs contain editable traceability, component evidence, the evidence index and product gaps.
- The coverage tab counts missing product and deployment evidence paths. The product gaps tab labels these actions Unassigned or Unassigned deployment. Phase 44.1 records a role, milestone, and closure evidence or approved tailoring decision for each applicable row.
- The [published assessor archive](${evidence.fileName}) and its [SHA-256](${evidence.fileName}.sha256) accompany the unchanged [extracted release records](release-package/).
- ${approval
    ? `The [Marketplace approval receipt](marketplace-approval.json) records the [release workflow run](${approval.runUrl}) and its approval from the sole reviewer configured when this export checked GitHub. It supplements the published product findings and confers no deployment authorization.`
    : 'Marketplace approval evidence is pending verification. This export includes the published product findings.'}
- Evidence references for the deployment should identify the assessed component, build and configuration, assessment objective, method, collection date, approved location and reviewer.
`);
  addSource(`evidence/${evidence.fileName}`, evidence.archive);
  append(`evidence/${evidence.fileName}.sha256`, `${evidence.sha256}  ${evidence.fileName}\n`);
  for (const [name, bytes] of evidence.files) addSource(`evidence/release-package/${name}`, bytes);
  for (const { file, rows } of tables) {
    append(`evidence/${file}`, `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`);
  }
  entries.push(['evidence/SA-and-A-control-and-evidence-workbook.xlsx', workbook(tables)]);
  entries.sort(([left], [right]) => left.localeCompare(right));
  const manifest = entries.map(([name, bytes]) => `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`).join('');
  append('SHA256SUMS', manifest);
  return writeZip(entries);
}
